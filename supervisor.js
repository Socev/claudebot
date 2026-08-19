#!/usr/bin/env node
/*
 * supervisor.js — draait de Node-app als kind vanaf het persistente volume,
 * en zet hem pod-lokaal terug als een nieuwe release niet gezond opstart.
 *
 * WAAROM DIT BESTAAT, EN WAAROM NIET GEWOON EEN MEEBEWEGENDE IMAGE-TAG.
 * De voor de hand liggende oplossing voor hands-free uitrollen is een image-tag
 * die meebeweegt plus `imagePullPolicy: Always`. Die is bij de review verworpen,
 * om één reden die zwaarder weegt dan het gemak: dan bepaalt niet de uitrol maar
 * de eerstvolgende ONVRIJWILLIGE herstart welke code gaat draaien. Een OOM-kill,
 * node-druk of een Olares-update trekt dan een versie binnen die op deze pod nog
 * nooit heeft gedraaid — op een moment dat niemand kijkt. En terugzetten kan de
 * pod niet zelf: hij heeft geen enkel recht op de cluster-API (gemeten 19-8-2026:
 * HTTP 403 op alles, ook op de Olares-CRD).
 *
 * Daarom: de IMAGE staat vast, alleen de CODE beweegt, op /opt/data. Wat de pod
 * niet via het cluster kan, kan hij wel op zijn eigen volume: een symlink terug
 * zetten. Dat is precies wat hier gebeurt.
 *
 * INDELING op /opt/data/app
 *   releases/<sha>/   de code van één release
 *   current -> releases/<sha>    de actieve release
 *   vorige  -> releases/<sha>    waar we naar terugvallen
 *
 * WAT DE SUPERVISOR DOET
 *   1. Is `current` leeg of weg (vers volume), dan vult hij hem uit de kopie die
 *      in het image zit. Zo start een verse pod altijd, ook zonder uitrol.
 *   2. Start het kind en doet een BOOT-ZELFCONTROLE op de eigen /health.
 *   3. Zakt die controle, dan flipt hij `current` terug naar `vorige` en start
 *      opnieuw — zonder cluster, zonder netwerk, zonder David.
 *   4. Sterft het kind later alsnog, dan herstart hij met oplopende wachttijd.
 *      Blijft het kind in een crashlus, dan volgt alsnog één terugflip.
 *   5. SIGTERM/SIGINT gaan door naar het kind, zodat een K8s-stop schoon verloopt.
 *
 * TWEE GRENZEN, BEWUST
 *   - Er wordt HOOGSTENS ÉÉN KEER teruggeflipt per supervisor-leven. Een tweede
 *     terugflip zou heen en weer gaan tussen twee versies die allebei stuk zijn
 *     (bijvoorbeeld doordat er een env-variabele ontbreekt, wat geen van beide
 *     releases oplost). Dan is doorproberen met oplopende wachttijd eerlijker: de
 *     storing blijft zichtbaar in plaats van weggepoetst.
 *   - De supervisor stopt nooit uit zichzelf. Zolang hij leeft, leeft de pod, en
 *     is /health het eerlijke antwoord op de vraag of het werkt.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const APP_ROOT = process.env.APP_ROOT || '/opt/data/app';
const RELEASES = path.join(APP_ROOT, 'releases');
const CURRENT = path.join(APP_ROOT, 'current');
const VORIGE = path.join(APP_ROOT, 'vorige');
const BOOTSTRAP = process.env.APP_BOOTSTRAP || '/app/release-bootstrap';
const IMAGE_SHA = process.env.IMAGE_SHA || 'onbekend';
const POORT = parseInt(process.env.PORT || '8080', 10);
const HOOFDSCRIPT = process.env.APP_ENTRY || 'server.js';

const BIN = process.env.BIN_DIR || '/opt/data/bin';
const LOGBESTAND = path.join(BIN, 'supervisor.log');
const APILOG = path.join(BIN, 'api.log');

const BOOT_TIJDSLIMIET_MS = parseInt(process.env.BOOT_TIMEOUT_MS || '25000', 10);
const BOOT_POLL_MS = 1000;
const CRASH_VENSTER_MS = 60000;   // "snel achter elkaar" = binnen deze tijd
const CRASH_GRENS = 3;            // zoveel snelle crashes = release verdacht
const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];
const STOP_GENADE_MS = 15000;

let kind = null;
let stoppen = false;
let terugflipGedaan = false;
let crashTijden = [];
let herstartTeller = 0;

// Per regel toevoegen, nooit via een stream: na een logrotatie blijft een open
// stream naar de oude inode schrijven en verdwijnt het log geruisloos.
function log(regel) {
  const s = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' supervisor: ' + regel + '\n';
  try { fs.mkdirSync(BIN, { recursive: true }); fs.appendFileSync(LOGBESTAND, s); } catch (e) {}
  process.stdout.write(s);
}

// ── symlinks ────────────────────────────────────────────────────────────────
// Eerst een tijdelijke link maken en die er overheen hernoemen: `rename` is
// atomair, dus er is geen moment waarop `current` even niet bestaat. Zonder dat
// zou een herstart precies in dat gaatje de pod stuk maken.
function zetSymlink(pad, doelRelatief) {
  const tmp = pad + '.nieuw-' + process.pid;
  try { fs.unlinkSync(tmp); } catch (e) {}
  fs.symlinkSync(doelRelatief, tmp);
  fs.renameSync(tmp, pad);
}

function doelVan(pad) {
  try { return fs.readlinkSync(pad); } catch (e) { return null; }
}

function releaseMap() {
  try { return fs.realpathSync(CURRENT); } catch (e) { return null; }
}

function huidigeSha() {
  const m = releaseMap();
  return m ? path.basename(m) : 'onbekend';
}

function bruikbaar(map) {
  try { return fs.statSync(path.join(map, HOOFDSCRIPT)).isFile(); } catch (e) { return false; }
}

// ── bootstrap uit het image ─────────────────────────────────────────────────
function kopieerMap(van, naar) {
  fs.mkdirSync(naar, { recursive: true });
  for (const naam of fs.readdirSync(van)) {
    const s = path.join(van, naam);
    const d = path.join(naar, naam);
    const st = fs.lstatSync(s);
    if (st.isDirectory()) kopieerMap(s, d);
    else if (st.isFile()) { fs.copyFileSync(s, d); fs.chmodSync(d, st.mode & 0o777); }
  }
}

/*
 * Node zoekt pakketten door vanaf het bestand omhoog te lopen naar node_modules.
 * Een release onder /opt/data/app/releases/<sha>/ zou dus nooit bij /app/node_modules
 * uitkomen. Eén symlink op appniveau lost dat voor alle releases tegelijk op.
 *
 * server.js zelf heeft geen enkel extern pakket nodig - gemeten, alleen
 * standaardbibliotheek - maar telegram-reader.js en koppel-telegram.js wel (GramJS).
 * Zonder deze link zou een uitgerolde versie daarvan stukgaan op een `require` die
 * in het image gewoon werkt, en dat is precies het soort verschil dat je pas merkt
 * als je het nodig hebt.
 */
function zorgVoorModules() {
  const link = path.join(APP_ROOT, 'node_modules');
  const bron = '/app/node_modules';
  try {
    if (!fs.existsSync(bron)) return;
    if (fs.existsSync(link)) return;
    fs.symlinkSync(bron, link);
    log('node_modules gekoppeld: ' + link + ' -> ' + bron);
  } catch (e) { log('kon node_modules niet koppelen: ' + e.message); }
}

function bootstrapIndienNodig() {
  const map = releaseMap();
  if (map && bruikbaar(map)) return false;

  if (!fs.existsSync(path.join(BOOTSTRAP, HOOFDSCRIPT))) {
    log('FATAAL: geen bruikbare release op ' + CURRENT + ' en geen bootstrapkopie in ' + BOOTSTRAP);
    return false;
  }
  const doel = path.join(RELEASES, IMAGE_SHA);
  log('geen bruikbare release gevonden - bootstrappen uit het image naar releases/' + IMAGE_SHA);
  fs.mkdirSync(RELEASES, { recursive: true });
  if (!bruikbaar(doel)) kopieerMap(BOOTSTRAP, doel);
  zetSymlink(CURRENT, path.join('releases', IMAGE_SHA));
  if (!doelVan(VORIGE)) zetSymlink(VORIGE, path.join('releases', IMAGE_SHA));
  return true;
}

// ── het kind ────────────────────────────────────────────────────────────────
function startKind() {
  const map = releaseMap();
  if (!map || !bruikbaar(map)) { log('FOUT: ' + CURRENT + ' wijst niet naar een bruikbare release'); return null; }

  let uit;
  try { fs.mkdirSync(BIN, { recursive: true }); uit = fs.openSync(APILOG, 'a'); }
  catch (e) { uit = 'inherit'; }

  const omgeving = Object.assign({}, process.env, {
    RELEASE_SHA: path.basename(map),
    RELEASE_DIR: map,
    IMAGE_SHA: IMAGE_SHA
  });

  const k = spawn(process.execPath, [path.join(map, HOOFDSCRIPT)], {
    cwd: map, env: omgeving,
    stdio: ['ignore', uit === 'inherit' ? 'inherit' : uit, uit === 'inherit' ? 'inherit' : uit]
  });
  log('kind gestart (pid ' + k.pid + ') vanaf release ' + path.basename(map));

  k.on('exit', function (code, signaal) {
    kind = null;
    if (stoppen) return;
    log('kind gestopt (code ' + code + ', signaal ' + signaal + ')');
    verwerkCrash();
  });
  return k;
}

function stopKind(signaal) {
  if (kind && kind.pid) { try { kind.kill(signaal); } catch (e) {} }
}

// ── gezondheid ──────────────────────────────────────────────────────────────
function health() {
  return new Promise(function (resolve) {
    const req = http.get({ host: '127.0.0.1', port: POORT, path: '/health', timeout: 4000 }, function (res) {
      let s = '';
      res.on('data', function (d) { s += d; });
      res.on('end', function () {
        try { const j = JSON.parse(s); resolve(j && j.ok === true ? j : null); } catch (e) { resolve(null); }
      });
    });
    req.on('error', function () { resolve(null); });
    req.on('timeout', function () { req.destroy(); resolve(null); });
  });
}

const wacht = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootZelfcontrole() {
  const grens = Date.now() + BOOT_TIJDSLIMIET_MS;
  while (Date.now() < grens) {
    if (!kind) { log('boot-zelfcontrole: kind is al gestopt'); return false; }
    const j = await health();
    if (j) { log('boot-zelfcontrole geslaagd - /health meldt ok, versie ' + (j.versie || '?')); return true; }
    await wacht(BOOT_POLL_MS);
  }
  log('boot-zelfcontrole MISLUKT: geen ok van /health binnen ' + Math.round(BOOT_TIJDSLIMIET_MS / 1000) + ' s');
  return false;
}

// ── terugflippen ────────────────────────────────────────────────────────────
function terugflip(reden) {
  if (terugflipGedaan) {
    log('GEEN tweede terugflip (' + reden + '). Beide versies falen kennelijk om dezelfde reden - ' +
        'blijven proberen met oplopende wachttijd, zodat de storing zichtbaar blijft.');
    return false;
  }
  const naar = doelVan(VORIGE);
  const nu = doelVan(CURRENT);
  if (!naar) { log('GEEN terugflip mogelijk (' + reden + '): er is geen vorige release'); return false; }
  if (naar === nu) { log('GEEN terugflip nodig (' + reden + '): vorige is dezelfde release als current'); return false; }
  if (!bruikbaar(path.resolve(APP_ROOT, naar))) { log('GEEN terugflip (' + reden + '): vorige release is onbruikbaar'); return false; }

  log('TERUGFLIP (' + reden + '): current ' + nu + ' -> ' + naar);
  zetSymlink(CURRENT, naar);
  terugflipGedaan = true;
  crashTijden = [];
  herstartTeller = 0;
  return true;
}

function verwerkCrash() {
  const nu = Date.now();
  crashTijden = crashTijden.filter((t) => nu - t < CRASH_VENSTER_MS);
  crashTijden.push(nu);
  if (crashTijden.length >= CRASH_GRENS) {
    log(crashTijden.length + ' crashes binnen ' + Math.round(CRASH_VENSTER_MS / 1000) + ' s');
    terugflip('crashlus');
  }
  const ms = BACKOFF_MS[Math.min(herstartTeller, BACKOFF_MS.length - 1)];
  herstartTeller++;
  log('herstart over ' + ms + ' ms');
  setTimeout(function () { if (!stoppen) kind = startKind(); }, ms);
}

// ── stoppen ─────────────────────────────────────────────────────────────────
function afsluiten(signaal) {
  if (stoppen) return;
  stoppen = true;
  log('signaal ' + signaal + ' ontvangen - doorgeven aan het kind');
  stopKind(signaal);
  const grens = Date.now() + STOP_GENADE_MS;
  const tik = setInterval(function () {
    if (!kind) { clearInterval(tik); log('kind is gestopt - supervisor stopt'); process.exit(0); }
    if (Date.now() > grens) {
      clearInterval(tik);
      log('kind stopt niet binnen ' + Math.round(STOP_GENADE_MS / 1000) + ' s - SIGKILL');
      stopKind('SIGKILL');
      setTimeout(() => process.exit(0), 500);
    }
  }, 250);
}
process.on('SIGTERM', () => afsluiten('SIGTERM'));
process.on('SIGINT', () => afsluiten('SIGINT'));

// ── hoofdlus ────────────────────────────────────────────────────────────────
(async function () {
  log('start - APP_ROOT=' + APP_ROOT + ', image-SHA=' + IMAGE_SHA + ', poort=' + POORT);
  fs.mkdirSync(RELEASES, { recursive: true });
  zorgVoorModules();
  bootstrapIndienNodig();

  kind = startKind();
  if (!kind) {
    log('FATAAL: kon geen kind starten. Supervisor blijft leven zodat /health onbereikbaar is ' +
        'en dat ook zichtbaar wordt, in plaats van dat de pod stil verdwijnt.');
    return;
  }

  const gezond = await bootZelfcontrole();
  if (!gezond) {
    if (terugflip('boot-zelfcontrole mislukt')) {
      log('kind stoppen en opnieuw starten vanaf de teruggezette release');
      stoppen = true; stopKind('SIGTERM');
      await wacht(3000);
      stopKind('SIGKILL');
      await wacht(500);
      stoppen = false;
      kind = startKind();
      const opnieuw = await bootZelfcontrole();
      log(opnieuw ? 'teruggezette release is gezond' : 'ook de teruggezette release komt niet gezond op - dit vraagt David');
    }
  }
  log('draait nu release ' + huidigeSha());
})();
