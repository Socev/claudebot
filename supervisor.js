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
 * DRIE GRENZEN, BEWUST
 *   - Er wordt HOOGSTENS ÉÉN KEER teruggeflipt zolang er sindsdien niets gezond
 *     heeft gedraaid. Een tweede terugflip zou heen en weer gaan tussen twee versies
 *     die allebei stuk zijn (bijvoorbeeld doordat er een env-variabele ontbreekt,
 *     wat geen van beide releases oplost). Dan is doorproberen met oplopende
 *     wachttijd eerlijker: de storing blijft zichtbaar in plaats van weggepoetst.
 *     wv3420 (actieplan 19-11 B60, Fable-review uitrol H3): draait daarna hetzelfde
 *     kind TERUGFLIP_HERSTEL_MS (10 min) gezond, dan komt het budget terug. Vóór
 *     deze wijziging bleef het vangnet na één (valse) terugflip weg tot de volgende
 *     podherstart (15-11: ± 15 uitrols zonder vangnet). Heen en weer kan niet: na
 *     een terugflip wijzen current en vorige naar dezelfde release, pas een nieuwe
 *     uitrol zet een andere `vorige`.
 *   - Er draait NOOIT een tweede kind naast een levend kind (wv3420, B60). Op 18-11
 *     stierf een kind in State D (schijfhapering) pas seconden na SIGKILL; zijn late
 *     exit wiste de verwijzing naar zijn opvolger en de supervisor startte er nóg
 *     een: ± 3,5 u liep een tweede server.js zonder poort maar met alle klokjes mee.
 *     Nu telt alleen de exit van het HUIDIGE kind, en een nieuw kind start pas als
 *     elk eerder kind aantoonbaar weg is (exit-gebeurtenis binnen). server.js stopt
 *     zelf als zijn poort bezet is (EADDRINUSE), voor het geval er toch iets op zit.
 *   - De supervisor stopt nooit uit zichzelf. Zolang hij leeft, leeft de pod, en
 *     is /health het eerlijke antwoord op de vraag of het werkt.
 */
'use strict';
// Uid-scheiding (wv699, 21-10-2026): wat de pod-gebruiker maakt is privé; in de vault telt de standaard-ACL (zie run.sh).
process.umask(0o077);
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
// wv3420: zoveel ms hetzelfde kind gezond = terugflipbudget en backoff terug (standaard 10 min)
const TERUGFLIP_HERSTEL_MS = parseInt(process.env.TERUGFLIP_HERSTEL_MS || '600000', 10);

let kind = null;
let stoppen = false;
let terugflipGedaan = false;
let crashTijden = [];
let herstartTeller = 0;
// Review-fix 5-9-2026 (B1/B2): één wachtende herstart-timer, en onthouden HOE het
// laatste kind stopte. Een SIGTERM komt van uitrol.sh of van onszelf en is een
// gewenste herstart, geen crash - die telt niet mee in de crashlus en mag nooit
// een gezonde release terugflippen.
let herstartTimer = null;
let laatsteExit = null;   // { code, signaal } van het laatst gestopte kind
// wv3420 (B60): elk kind dat nog geen exit-gebeurtenis gaf, ook een oud kind dat al SIGKILL kreeg maar in State D
// hangt. Een nieuw kind start pas als deze set leeg is (startAlsVrij); de exit van een kind dat niet meer `kind` is,
// raakt `kind` niet en telt niet als crash.
const levend = new Set();
let startBezig = false;
let budgetTimer = null;

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
  levend.add(k);

  k.on('exit', function (code, signaal) {
    levend.delete(k);
    // wv3420 (B60): alleen het HUIDIGE kind. De late exit van een vervangen of al opgegeven kind mag de verwijzing naar
    // zijn opvolger niet wissen en geen herstart of crashtelling geven (18-11: daardoor een tweede server.js).
    if (k !== kind) {
      if (!stoppen) log('eerder kind (pid ' + k.pid + ') nu pas gestopt (code ' + code + ', signaal ' + signaal + ') - geen herstart, telt niet als crash');
      return;
    }
    kind = null;
    laatsteExit = { code: code, signaal: signaal };
    if (stoppen) return;
    log('kind gestopt (code ' + code + ', signaal ' + signaal + ')');
    if (k.vervangen) return;   // terugflip: bewaakOpkomst start zelf de opvolger, zodra dit kind weg is
    // SIGTERM stuurt alleen uitrol.sh (of wijzelf, en dan is `stoppen` al waar):
    // een gewenste herstart. Een nette exit 0 idem - server.js stopt nooit uit
    // zichzelf met 0. Niet tellen als crash, niet uitstellen.
    if (signaal === 'SIGTERM' || code === 0) { herstartNa(500); return; }
    verwerkCrash();
  });
  return k;
}

// De enige plek die een kind na een stop opnieuw start. Eén timer tegelijk, en
// nooit een tweede kind naast een levend kind (review-fix B2: twee kinderen op
// dezelfde poort = EADDRINUSE-crashlus met een onbewaakt gezond kind).
function herstartNa(ms) {
  if (herstartTimer) clearTimeout(herstartTimer);
  herstartTimer = setTimeout(function () {
    herstartTimer = null;
    if (stoppen || kind) return;
    // Fouten hier mogen de supervisor nooit omleggen: hij is het laatste wat nog leeft.
    startAlsVrij('herstart').then(function (k) {
      if (!k) return;
      return bewaakOpkomst('zelfcontrole na herstart mislukt', k);
    }).catch(function (e) { log('zelfcontrole na herstart faalde: ' + (e && e.message ? e.message : 'onbekend')); });
  }, ms);
}

// wv3420 (B60): leeft er nog een eerder kind (SIGKILL gegeven, maar de exit kwam nog niet binnen: State D), dan eerst
// wachten tot het weg is. Zonder plafond: een tweede server.js naast een levende is erger dan even geen server (de oude
// houdt de poort toch vast). Geeft false als de supervisor intussen stopt.
async function wachtTotOudWeg(waarom) {
  if (!levend.size) return true;
  const pids = function () { return Array.from(levend).map(function (k) { return k.pid; }).join(' '); };
  log('nieuw kind wacht (' + waarom + '): eerder kind leeft nog (pid ' + pids() + ') - SIGKILL en wachten tot het weg is, nooit twee tegelijk');
  const begin = Date.now();
  let gemeld = begin;
  while (levend.size) {
    if (stoppen) return false;
    levend.forEach(function (k) { try { k.kill('SIGKILL'); } catch (e) {} });
    await wacht(500);
    if (Date.now() - gemeld >= 60000) { gemeld = Date.now(); log('eerder kind leeft nog na ' + Math.round((gemeld - begin) / 1000) + ' s (pid ' + pids() + ') - blijft wachten'); }
  }
  log('eerder kind is weg na ' + Math.round((Date.now() - begin) / 1000) + ' s - nieuw kind mag starten');
  return true;
}

// De enige plek die na de opstart een nieuw kind start (herstart én terugflip). Eén start tegelijk.
async function startAlsVrij(waarom) {
  if (startBezig) return null;
  startBezig = true;
  try {
    if (!(await wachtTotOudWeg(waarom))) return null;
    if (stoppen || kind) return null;
    kind = startKind();
    return kind;
  } finally { startBezig = false; }
}

function stopKind(signaal) {
  levend.forEach(function (k) { if (k.pid) { try { k.kill(signaal); } catch (e) {} } });
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

async function bootZelfcontrole(k) {
  const grens = Date.now() + BOOT_TIJDSLIMIET_MS;
  while (Date.now() < grens) {
    if (!kind) { log('boot-zelfcontrole: kind is al gestopt'); return false; }
    if (k && kind !== k) { log('boot-zelfcontrole: kind is inmiddels vervangen - bewaking gaat over op het nieuwe kind'); return false; }
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

/*
 * Kijk of een net gestart kind gezond opkomt, en flip anders terug.
 *
 * DIT IS BEWUST ÉÉN FUNCTIE, gebruikt door zowel de opstart van de supervisor als
 * de herstartlus. Een tweede implementatie zou op termijn uiteenlopen met de eerste,
 * en dan heb je twee vangnetten die allebei half werken.
 *
 * HET GAT DAT DIT DICHT (gemeten 22-8-2026). `bootZelfcontrole` draaide alleen in
 * `main()`, dus alleen bij het starten van de SUPERVISOR. Een uitrol doodt echter
 * alleen het KIND: `uitrol.sh` zet `current` om en stuurt SIGTERM. De herstartlus
 * bracht het kind dan weer omhoog zónder enige gezondheidscontrole - precies op de
 * route waar een verse, ongeteste release draait. `uitrol.sh` leunt in zijn eigen
 * commentaar op dat vangnet ("de supervisor controleert nu zelf of hij gezond
 * opkomt"), en dat klopte op die route dus niet.
 *
 * WAAROM DIT MEER VANGT DAN DE CRASHLUS. `verwerkCrash` telt kinderen die STERVEN.
 * Een release die opkomt en blijft draaien maar nooit een gezonde `/health` geeft -
 * hangend bij het opstarten, kapotte configuratie - crasht niet, dus die teller
 * komt nooit aan zijn grens. Juist dat geval blijft anders stil kapot staan.
 */
async function bewaakOpkomst(reden, k) {
  const gezond = await bootZelfcontrole(k);
  if (gezond) { planBudgetTerug(k); return true; }
  // Review-fix B1: alleen een kind dat LEEFT maar niet gezond wordt is ziek.
  // Is het kind weg omdat wij stoppen, omdat uitrol.sh het net een SIGTERM gaf,
  // of omdat het al door een ander kind is vervangen, dan is dat geen oordeel
  // over de release - en een terugflip zou een gezonde release wegdraaien én de
  // enige terugflip verbruiken.
  if (stoppen) { log('geen terugflip (' + reden + '): supervisor is aan het stoppen'); return false; }
  if (!kind && laatsteExit && (laatsteExit.signaal === 'SIGTERM' || laatsteExit.code === 0)) {
    log('geen terugflip (' + reden + '): kind is bewust gestopt (SIGTERM/exit 0), niet ziek'); return false;
  }
  if (k && kind !== k) { log('geen terugflip (' + reden + '): dit kind is al vervangen'); return false; }
  if (!terugflip(reden)) return false;
  if (herstartTimer) { clearTimeout(herstartTimer); herstartTimer = null; }

  log('kind stoppen en opnieuw starten vanaf de teruggezette release');
  // wv3420 (B60): niet meer `stoppen` als vlag (dat blokkeerde ook een echte SIGTERM van K8s in dit venster), en
  // pas een nieuw kind als het oude aantoonbaar weg is (startAlsVrij), ook als SIGKILL pas na minuten werkt.
  const oud = kind;
  if (oud) { oud.vervangen = true; try { oud.kill('SIGTERM'); } catch (e) {} }
  for (let i = 0; i < 30 && levend.size; i++) await wacht(100);
  if (stoppen) return false;
  const nieuw = await startAlsVrij('terugflip');
  if (!nieuw) return false;
  const opnieuw = await bootZelfcontrole(nieuw);
  if (stoppen) return false;
  log(opnieuw ? 'teruggezette release is gezond'
              : 'ook de teruggezette release komt niet gezond op - dit vraagt David');
  if (opnieuw) planBudgetTerug(nieuw);
  return opnieuw;
}

// wv3420 (B60, Fable-review uitrol H3): draait hetzelfde kind TERUGFLIP_HERSTEL_MS na een geslaagde opkomst nog en geeft
// /health ok, dan krijgt de supervisor zijn terugflip terug en begint de backoff weer klein. Niet gezond op dat moment:
// over een minuut opnieuw kijken, zolang het hetzelfde kind is. Een nieuw kind plant opnieuw (bij zijn eigen opkomst).
function planBudgetTerug(k) {
  if (budgetTimer) clearTimeout(budgetTimer);
  budgetTimer = null;
  if (!terugflipGedaan && herstartTeller === 0 && !crashTijden.length) return;
  const kijk = function (na) {
    budgetTimer = setTimeout(function () {
      budgetTimer = null;
      if (stoppen || kind !== k) return;
      health().then(function (j) {
        if (stoppen || kind !== k) return;
        if (!j) { kijk(60000); return; }
        if (terugflipGedaan) log('terugflipbudget terug: hetzelfde kind (pid ' + k.pid + ', release ' + huidigeSha() + ') draait ' +
          Math.round(TERUGFLIP_HERSTEL_MS / 60000 * 10) / 10 + ' min gezond - een volgende kapotte release wordt weer teruggeflipt');
        terugflipGedaan = false; herstartTeller = 0; crashTijden = [];
      });
    }, na);
  };
  kijk(TERUGFLIP_HERSTEL_MS);
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
  herstartNa(ms);
}


// ── Databankdiensten (wv3180) ───────────────────────────────────────────────
// PostgREST (127.0.0.1:3001) en de sleutelluik db-luik.js (0.0.0.0:8091) naast de app. Postgres zelf start db-wacht.sh (root → pg)
// vanuit entrypoint.sh. Beide diensten starten alleen als hun binaire/bestanden en sleutels er zijn (anders: niets, geen fout);
// sterven ze, dan herstart met oplopende wachttijd. Minimale omgeving: geen pod-sleutels erin. Los van het kind: een crash van een
// dienst raakt de app niet, en een app-herstart (code-uitrol) laat de databank staan.
// wv3398 (actieplan B82; incident 19-11 16:03): alleen de echte supervisor (/app/supervisor.js, gestart door run.sh) start de ECHTE
// diensten. Een kopie in een toets (test/supervisor-*.sh, bewaker-*.sh, stop-voor-start.sh ...) startte anders een echte PostgREST met
// /app/db/postgrest.conf: die nam de socket /run/pgrst/pgrst.sock van de productie-PostgREST over en liet bij het einde van de toets een
// dode socket achter (19-11 15:04-15:25 UTC: elke databankaanroep 502), of bleef als wees met een eigen verbindingspool draaien.
// Een kopie start een dienst alleen als de toets het binaire bestand zelf vervangt (nu: DB_TUNNEL_BIN, nep-ssh).
const SUPERVISOR_ECHT = (function () { try { return fs.realpathSync(__filename) === '/app/supervisor.js'; } catch (e) { return false; } })();
const DB_NEVEN = [
  { naam: 'postgrest', bin: '/usr/local/bin/postgrest', args: ['/app/db/postgrest.conf'], nodig: ['/usr/local/bin/postgrest', '/app/db/postgrest.conf', '/opt/data/.pg/jwt.key'] },
  { naam: 'db-luik', bin: process.execPath, args: ['/app/db/db-luik.js'], nodig: ['/app/db/db-luik.js', '/opt/data/.pg/jwt.key', '/opt/data/.pg/luik-sleutels.json'] },
  // wv3187: tunnel voor de warme reserve op de R230 (ontwerp § 5). De R230 luistert op zijn eigen 127.0.0.1:55432 en komt hier binnen
  // op 127.0.0.1:5432 (pg_hba: alleen `replication reserve`, scram). Alleen als het reservewachtwoord er is; uit met /opt/data/pg-reserve-uit.
  // ExitOnForwardFailure: hangt de oude poort nog aan de R230-kant, dan stopt ssh en volgt de backoff. ServerAlive: dode verbinding
  // na ± 45 s weg. Ontbreekt iets bij de start, dan elke 5 min opnieuw kijken (opnieuwMs).
  { naam: 'db-tunnel', bin: process.env.DB_TUNNEL_BIN || '/usr/bin/ssh', nep: !!process.env.DB_TUNNEL_BIN, uit: process.env.DB_TUNNEL_UIT || '/opt/data/pg-reserve-uit',
    opnieuwMs: Number(process.env.DB_TUNNEL_OPNIEUW_MS) || 300000,
    args: ['-F', '/opt/data/.ssh/config', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3', '-R', '127.0.0.1:55432:127.0.0.1:5432', 'r230'],
    nodig: process.env.DB_TUNNEL_NODIG ? process.env.DB_TUNNEL_NODIG.split(':') : ['/usr/bin/ssh', '/opt/data/.ssh/config', '/opt/data/.pg/reserve.wachtwoord'] },
];
// wv3187: stand van de diensten voor /health.db (pid, sinds, herstarts, laatste stop); geen sleutels, geen argumenten
const DB_NEVEN_STAND = path.join(BIN, 'db-diensten.json');
function nevenStandSchrijf() {
  const uit = {};
  Object.keys(nevenStaat).forEach(function (n) {
    const st = nevenStaat[n];
    uit[n] = { pid: st.kind ? st.kind.pid : null, sinds: st.kind && st.gestart ? new Date(st.gestart).toISOString() : null,
      herstarts: st.herstarts || 0, laatste_stop: st.laatsteStop || null, reden_uit: st.redenUit || null };
  });
  try { fs.writeFileSync(DB_NEVEN_STAND + '.tmp', JSON.stringify(uit), { mode: 0o600 }); fs.renameSync(DB_NEVEN_STAND + '.tmp', DB_NEVEN_STAND); } catch (e) {}
}
const DB_NEVEN_WACHT = [2000, 5000, 10000, 30000, 60000];
const DB_NEVEN_LOG = path.join(BIN, 'db-diensten.log');
const nevenStaat = {};
function startNeven(d) {
  if (stoppen) return;
  if (process.env.DB_DIENSTEN_UIT === '1' || fs.existsSync('/opt/data/pg-uit')) return;
  if (!SUPERVISOR_ECHT && !d.nep) {   // wv3398: een proefkopie raakt de echte databankdiensten niet
    log(d.naam + ': niet gestart (proefkopie van supervisor.js, geen echte databankdienst)');
    nevenStaat[d.naam] = { kind: null, n: 0, redenUit: 'proefkopie' };
    nevenStandSchrijf();
    return;
  }
  const uitgezet = d.uit && fs.existsSync(d.uit);
  if (uitgezet || !d.nodig.every(function (f) { try { fs.accessSync(f, fs.constants.R_OK); return true; } catch (e) { return false; } })) {
    const reden = uitgezet ? 'uitgezet (' + d.uit + ')' : 'bestanden of sleutels ontbreken';
    const vorig = nevenStaat[d.naam];
    if (!vorig || vorig.redenUit !== reden) log(d.naam + ': niet gestart (' + reden + ')');
    nevenStaat[d.naam] = Object.assign(vorig || { n: 0 }, { kind: null, redenUit: reden });
    nevenStandSchrijf();
    if (d.opnieuwMs) setTimeout(function () { startNeven(d); }, d.opnieuwMs).unref();
    return;
  }
  const st = nevenStaat[d.naam] || (nevenStaat[d.naam] = { kind: null, n: 0 });
  st.redenUit = null;
  let uit = 'ignore';
  try { uit = fs.openSync(DB_NEVEN_LOG, 'a', 0o600); } catch (e) { uit = 'ignore'; }
  const k = spawn(d.bin, d.args, { stdio: ['ignore', uit, uit], env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME || '/opt/data', TZ: 'UTC' } });
  if (typeof uit === 'number') { try { fs.closeSync(uit); } catch (e) {} }
  st.kind = k; st.gestart = Date.now();
  log(d.naam + ' gestart (pid ' + k.pid + ')');
  nevenStandSchrijf();
  k.on('error', function (e) { log(d.naam + ': start faalde (' + (e && e.code || 'fout') + ')'); });
  k.on('exit', function (code, sig) {
    st.kind = null;
    if (stoppen) return;
    st.herstarts = (st.herstarts || 0) + 1; st.laatsteStop = { tijd: new Date().toISOString(), uitkomst: String(sig || code) };
    nevenStandSchrijf();
    if (Date.now() - st.gestart > 300000) st.n = 0;
    const w = DB_NEVEN_WACHT[Math.min(st.n, DB_NEVEN_WACHT.length - 1)]; st.n++;
    log(d.naam + ' stopte (' + (sig || code) + ') - herstart over ' + w + ' ms');
    setTimeout(function () { startNeven(d); }, w);
  });
}
// Codex ZOU 1: de uit-schakelaar (d.uit) ook tijdens het draaien bekijken; gezet → het proces stoppen (de exit-afhandeling start hem
// niet opnieuw zolang de schakelaar er staat en kijkt elke opnieuwMs). Eens per minuut.
setInterval(function () {
  if (stoppen) return;
  DB_NEVEN.forEach(function (d) {
    const st = nevenStaat[d.naam];
    if (d.uit && st && st.kind && fs.existsSync(d.uit)) {
      log(d.naam + ': uitgezet (' + d.uit + ') - stoppen'); st.redenUit = 'uitgezet (' + d.uit + ')'; try { st.kind.kill('SIGTERM'); } catch (e) {}
    }
  });
}, Number(process.env.DB_NEVEN_TIK_MS) || 60000).unref();
function stopNeven() {
  Object.keys(nevenStaat).forEach(function (n) { const k = nevenStaat[n] && nevenStaat[n].kind; if (k) { try { k.kill('SIGTERM'); } catch (e) {} } });
}

// ── stoppen ─────────────────────────────────────────────────────────────────
function afsluiten(signaal) {
  if (stoppen) return;
  stoppen = true;
  log('signaal ' + signaal + ' ontvangen - doorgeven aan het kind');
  stopKind(signaal);   // wv3420: alle levende kinderen, ook een eerder kind dat nog in State D hangt
  stopNeven();   // wv3180
  const grens = Date.now() + STOP_GENADE_MS;
  const tik = setInterval(function () {
    if (!levend.size) { clearInterval(tik); log('kind is gestopt - supervisor stopt'); process.exit(0); }
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
  DB_NEVEN.forEach(startNeven);   // wv3180: PostgREST + db-luik (los van het kind)

  kind = startKind();
  if (!kind) {
    log('FATAAL: kon geen kind starten. Supervisor blijft leven zodat /health onbereikbaar is ' +
        'en dat ook zichtbaar wordt, in plaats van dat de pod stil verdwijnt.');
    return;
  }

  await bewaakOpkomst('boot-zelfcontrole mislukt', kind);
  log('draait nu release ' + huidigeSha());
})();
