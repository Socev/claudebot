#!/usr/bin/env node
/*
 * schijfdruk.js — lichte schijfdrukmeting buiten server.js (wv3124, 15-11-2026, machinekamer, eigen initiatief).
 *
 * WAAROM. 15-11 08:30-09:14Z stond /proc/pressure/io full rond 75 %, server.js hing in State D (wchan folio_wait_bit_common,
 * jbd2_log_wait_commit) en geen podproces deed noemenswaardig IO: de bron zit op de Olares-host en was achteraf niet te
 * achterhalen. Zelfde patroon 7-11 en 13-11 rond 03:00-03:50 lokaal. Deze meter legt voortaan tijdstip, duur en schijf vast.
 *
 * HOE. Eén los proces per pod (net als bewaker.js door server.js gestart, detached, nooit met het pad van server.js in de
 * argumenten: uitrol.sh zoekt kinderen met pgrep op server\.js). Het overleeft een herstart van server.js; bij een andere
 * release neemt de nieuwe het slot over (pidbestand met sha).
 *   meten     elke minuut /proc/pressure/io (some/full avg10/avg60/avg300), /proc/loadavg en per blokapparaat uit
 *             /proc/diskstats de delta van gelezen/geschreven sectoren en io_ticks (ms bezet) + in-flight. Alleen hele schijven
 *             en dm-*, geen partities of loop. Lezingen asynchroon met een korte time-out: een lezing die vastzit geeft een
 *             record met 'fout', en zolang er een lezing openstaat start er geen nieuwe (geen opeenstapeling van threads).
 *   bewaren   ringbuffer van bestanden ring-JJJJMMDD-UU.jsonl (UTC, blokken van 6 u, de nieuwste 8 = 42-48 u) onder
 *             /opt/data/scripts-staat/schijfdruk/. Schrijven asynchroon met time-out; hangt de schijf, dan wordt er in het
 *             geheugen gebufferd (hooguit 360 records) en is er hooguit één schrijfpoging tegelijk. De laatste 24 u staan ook
 *             in het geheugen en worden na een herstart uit de bestanden teruggelezen.
 *   tonen     unix-socket meter.sock in dezelfde map, antwoord uit het geheugen (dus ook als de schijf hangt):
 *             GET /samenvatting (laatste minuut, piek 24 u met tijdstip) en GET /recent?min=15. server.js toont de samenvatting
 *             op /health.schijfdruk; bewaker.js zet bij een ingreep de laatste 15 minuten in zijn momentopname.
 *   melden    stilte is de default: geen bericht aan David. Wel één box-rij als full avg60 langer dan 10 min boven 50 % blijft
 *             (hooguit 1x per 24 u, alarm.json), met tijdvak en zwaarste apparaat.
 * Uitzetten: touch /opt/data/schijfdruk-uit (gelezen bij de start van het proces) of SCHIJFDRUK=0 in de omgeving van server.js.
 * Toets: test/schijfdruk.sh (nep-/proc, eigen paden; raakt de pod niet).
 */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

function start(o) {
  const k = spawn(process.execPath, [__filename], {
    detached: true, stdio: 'ignore', cwd: '/', env: Object.assign({}, o && o.env || process.env, o && o.sha ? { SCHIJFDRUK_SHA: o.sha } : {})
  });
  k.on('error', function () {});
  k.unref();
  return k.pid;
}
if (require.main !== module) { module.exports = { start: start }; return; }

function getal(naam, standaard) {
  const v = parseInt(process.env[naam] || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : standaard;
}
const DIR = process.env.SCHIJFDRUK_DIR || '/opt/data/scripts-staat/schijfdruk';
const PROC = process.env.SCHIJFDRUK_PROC || '/proc';
const SOCK = process.env.SCHIJFDRUK_SOCK || path.join(DIR, 'meter.sock');
const LOCK = path.join(DIR, 'meter.pid');
const ALARM_BESTAND = path.join(DIR, 'alarm.json');
const UIT = process.env.SCHIJFDRUK_UIT || '/opt/data/schijfdruk-uit';
const VAULT = process.env.VAULT_DIR || '/opt/data/AI_SecondBrain';
const BOX = process.env.SCHIJFDRUK_BOX || path.join(VAULT, '00_Systeem', 'Meldingen', 'machinekamer.md');
const SHA = process.env.SCHIJFDRUK_SHA || path.basename(__dirname);
const C = {
  tik: getal('SCHIJFDRUK_TIK_MS', 60000),
  fs: getal('SCHIJFDRUK_FS_MS', 8000),            // grens voor één bestandshandeling
  proc: getal('SCHIJFDRUK_PROC_MS', 3000),        // grens voor één /proc-lezing
  blokUren: getal('SCHIJFDRUK_BLOK_UREN', 6),
  bewaar: getal('SCHIJFDRUK_BEWAAR', 8),          // aantal ringbestanden
  geheugen: getal('SCHIJFDRUK_GEHEUGEN', 1440),   // records in het geheugen (24 u bij 1 per minuut)
  uitstaand: getal('SCHIJFDRUK_UITSTAAND', 360),  // records die op schrijven wachten, bij een hangende schijf
  alarmPct: getal('SCHIJFDRUK_ALARM_PCT', 50),
  alarmMs: getal('SCHIJFDRUK_ALARM_MS', 10 * 60000),
  alarmPauze: getal('SCHIJFDRUK_ALARM_PAUZE_MS', 24 * 3600000),
  vensterMs: getal('SCHIJFDRUK_VENSTER_MS', 24 * 3600000)
};

const mono = () => Number(process.hrtime.bigint() / 1000000n);
const wacht = (ms) => new Promise((r) => setTimeout(r, ms));
// fsOpen telt bestandshandelingen die nog echt lopen, ook als hun time-out al verstreek: een time-out beëindigt alleen het
// wachten, de thread in de libuv-pool blijft bezet tot de kernel antwoordt (Codex-review wv3124 MOET 1). Boven MAXOPEN start
// er geen nieuw werk meer, zodat de pool (4 threads) nooit helemaal dichtloopt en de meter blijft meten en antwoorden.
let fsOpen = 0;
const MAXOPEN = getal('SCHIJFDRUK_MAXOPEN', 2);
function metGrens(p, ms, standaard) {
  let t;
  fsOpen++;
  const klaar = () => { fsOpen--; };
  const q = Promise.resolve(p);
  q.then(klaar, klaar);
  return Promise.race([q.catch(() => standaard), new Promise((r) => { t = setTimeout(() => r(standaard), ms); })])
    .finally(() => clearTimeout(t));
}
const lees = (p, ms) => metGrens(fsp.readFile(p, 'utf8'), ms || C.fs, null);
function amsterdam(d) { return (d || new Date()).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
const hhmm = (ms) => amsterdam(new Date(ms)).slice(11, 16);
const rond = (x, n) => Number.isFinite(x) ? Math.round(x * (n || 100)) / (n || 100) : null;

// ── het slot: één meter per pod ─────────────────────────────────────────────────────────────────────────────────────
async function starttijd(pid) {
  const s = await lees('/proc/' + pid + '/stat', 2000);
  if (!s) return null;
  const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
  return f[19] || null;   // veld 22 (starttime), na pid en comm
}
async function leeft(pid, start) {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  const nu = await starttijd(pid);
  return nu !== null && (start == null || String(nu) === String(start));
}
async function neemSlot() {
  if (!(await metGrens(fsp.mkdir(DIR, { recursive: true }).then(() => true), C.fs, false))) return false;
  const eigen = JSON.stringify({ pid: process.pid, start: await starttijd(process.pid), sha: SHA });
  for (let poging = 0; poging < 3; poging++) {
    const gelukt = await metGrens(fsp.writeFile(LOCK, eigen, { flag: 'wx' }).then(() => true, (e) => (e.code === 'EEXIST' ? 'bezet' : false)), C.fs, false);
    if (gelukt === true) return true;
    if (gelukt === false) return false;
    const h = await lees(LOCK);
    let o = null; try { o = JSON.parse(h); } catch (e) {}
    if (o && o.pid && await leeft(o.pid, o.start)) {
      if (o.sha === SHA) return false;                       // dezelfde release draait al
      try { process.kill(o.pid, 'SIGTERM'); } catch (e) {}   // andere release: die neemt hij over
      for (let i = 0; i < 30 && await leeft(o.pid, o.start); i++) await wacht(200);
      if (await leeft(o.pid, o.start)) { try { process.kill(o.pid, 'SIGKILL'); } catch (e) {} await wacht(300); }
    }
    await metGrens(fsp.unlink(LOCK).then(() => true), C.fs, false);
  }
  return false;
}
async function slotIsVan_mij() {
  const h = await lees(LOCK, 3000);
  if (h === null) return null;   // niet te lezen: geen oordeel
  try { return JSON.parse(h).pid === process.pid; } catch (e) { return false; }
}

// ── lezen van /proc ─────────────────────────────────────────────────────────────────────────────────────────────────
function leesDruk(t) {
  const uit = {};
  for (const soort of ['some', 'full']) {
    const m = new RegExp('^' + soort + ' avg10=([\\d.]+) avg60=([\\d.]+) avg300=([\\d.]+)', 'm').exec(t || '');
    if (m) uit[soort] = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
  }
  return uit;
}
const SCHIJF = /^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|mmcblk\d+|dm-\d+|md\d+)$/;
function leesSchijven(t) {
  const uit = {};
  for (const regel of String(t || '').split('\n')) {
    const f = regel.trim().split(/\s+/);
    if (f.length < 14 || !SCHIJF.test(f[2])) continue;
    const g = f.slice(3).map(Number);   // g[0] reads, g[2] sectoren gelezen, g[4] writes, g[6] sectoren geschreven, g[8] in flight, g[9] io_ticks
    if (g.some((x) => !Number.isFinite(x))) continue;
    uit[f[2]] = { rs: g[2], ws: g[6], tick: g[9], infl: g[8] };
  }
  return uit;
}
let vorige = null;   // { ms, schijven }
let sampleBezig = false;

async function monster() {
  const wand = Date.now(), m = mono();
  const druk = await lees(PROC + '/pressure/io', C.proc), la = await lees(PROC + '/loadavg', C.proc), ds = await lees(PROC + '/diskstats', C.proc);   // na elkaar: nooit meer dan één pool-thread voor de meting
  const r = { t: new Date(wand).toISOString() };
  const fouten = [];
  const d = druk === null ? null : leesDruk(druk);
  if (!d || !d.some || !d.full) fouten.push('pressure'); else r.io = [d.some[0], d.some[1], d.full[0], d.full[1], d.some[2], d.full[2]];
  if (la === null) fouten.push('loadavg'); else { const f = la.split(' ').map(parseFloat); if (f.length >= 3 && f.every(Number.isFinite)) r.la = f.slice(0, 3); else fouten.push('loadavg'); }
  const s = ds === null ? null : leesSchijven(ds);
  if (!s) fouten.push('diskstats');
  else {
    r.d = {};
    if (vorige) {
      r.dt = rond((m - vorige.ms) / 1000, 10);
      for (const n of Object.keys(s)) {
        const v = vorige.schijven[n]; if (!v) continue;
        const dr = s[n].rs - v.rs, dw = s[n].ws - v.ws, dtk = s[n].tick - v.tick;
        if (dr < 0 || dw < 0 || dtk < 0) continue;   // teller teruggezet: geen delta
        if (dr || dw || dtk || s[n].infl) r.d[n] = [dr, dw, dtk, s[n].infl];
      }
    }
    vorige = { ms: m, schijven: s };
  }
  if (fouten.length) r.fout = fouten.join(',');
  r.ms = wand;
  return r;
}

// ── geheugen, bestanden ─────────────────────────────────────────────────────────────────────────────────────────────
const buf = [];          // laatste 24 u, oud → nieuw
let uitstaand = [];      // nog niet op schijf
let inVlucht = null;     // { sinds, n } zolang een schrijfpoging niet is afgerond
let laatsteSchrijfOk = null, schrijfFout = null;
let huidigBestand = null;
const sinds = Date.now();

function bestandVoor(ms) {
  const d = new Date(ms), blok = Math.floor(d.getUTCHours() / C.blokUren) * C.blokUren;
  return 'ring-' + d.toISOString().slice(0, 10).replace(/-/g, '') + '-' + String(blok).padStart(2, '0') + '.jsonl';
}
function regel(r) { const c = Object.assign({}, r); delete c.ms; return JSON.stringify(c) + '\n'; }
function schrijf() {
  if (inVlucht || !uitstaand.length) return;
  const lijst = uitstaand; uitstaand = [];
  const groepen = new Map();
  for (const r of lijst) { const n = bestandVoor(r.ms); if (!groepen.has(n)) groepen.set(n, []); groepen.get(n).push(r); }
  inVlucht = { sinds: mono(), n: lijst.length };
  const klaar = new Set();
  (async function () {
    for (const [naam, rs] of groepen) {
      await fsp.appendFile(path.join(DIR, naam), rs.map(regel).join(''));
      klaar.add(naam);
      if (naam !== huidigBestand) { huidigBestand = naam; ruimOp(); }
    }
  })().then(function () { laatsteSchrijfOk = Date.now(); schrijfFout = null; }, function (e) {
    schrijfFout = (e && e.code) || String(e && e.message || e).slice(0, 80);
    const terug = []; for (const [naam, rs] of groepen) if (!klaar.has(naam)) terug.push(...rs);
    uitstaand = terug.concat(uitstaand).slice(-C.uitstaand);
  }).finally(function () { inVlucht = null; });
}
async function ruimOp() {
  const namen = await metGrens(fsp.readdir(DIR), C.fs, null);
  if (!namen) return;
  const ring = namen.filter((n) => /^ring-\d{8}-\d{2}\.jsonl$/.test(n)).sort();
  for (const n of ring.slice(0, Math.max(0, ring.length - C.bewaar))) await metGrens(fsp.unlink(path.join(DIR, n)).then(() => true), C.fs, false);
}
async function geschiedenis() {
  const namen = await metGrens(fsp.readdir(DIR), C.fs, null);
  if (!namen) return 'map niet te lezen';
  const ring = namen.filter((n) => /^ring-\d{8}-\d{2}\.jsonl$/.test(n)).sort().slice(-Math.ceil(C.vensterMs / 3600000 / C.blokUren) - 1);
  const grens = Date.now() - C.vensterMs;
  let n = 0;
  for (const naam of ring) {
    const t = await lees(path.join(DIR, naam));
    if (t === null) return 'bestand ' + naam + ' niet binnen ' + Math.round(C.fs / 1000) + ' s te lezen';
    for (const r of t.split('\n')) {
      if (!r) continue;
      let o; try { o = JSON.parse(r); } catch (e) { continue; }
      const ms = Date.parse(o && o.t); if (!Number.isFinite(ms) || ms < grens) continue;
      o.ms = ms; buf.push(o); n++;
    }
  }
  huidigBestand = ring.length ? ring[ring.length - 1] : null;
  buf.sort((a, b) => a.ms - b.ms);
  return null;
}

// ── samenvatting (uit het geheugen) ─────────────────────────────────────────────────────────────────────────────────
function zwaarste(r) {
  if (!r || !r.d || !r.dt) return null;
  let top = null;
  for (const n of Object.keys(r.d)) { const b = r.d[n][2] / (r.dt * 1000) * 100; if (!top || b > top.bezet_pct) top = { naam: n, bezet_pct: rond(b, 10), gelezen_mb: rond(r.d[n][0] * 512 / 1048576, 10), geschreven_mb: rond(r.d[n][1] * 512 / 1048576, 10), in_flight: r.d[n][3] }; }
  return top;
}
function samenvatting() {
  const l = buf.length ? buf[buf.length - 1] : null;
  const grens = Date.now() - C.vensterMs;
  let p60 = null, p10 = null;
  for (const r of buf) {
    if (r.ms < grens || !r.io) continue;
    if (!p60 || r.io[3] > p60.io[3]) p60 = r;
    if (!p10 || r.io[2] > p10.io[2]) p10 = r;
  }
  return {
    ok: true, versie: SHA, pid: process.pid, sinds_iso: new Date(sinds).toISOString(), records_geheugen: buf.length,
    laatste: l ? { tijd: l.t, leeftijd_s: Math.round((Date.now() - l.ms) / 1000), some_avg10: l.io && l.io[0], some_avg60: l.io && l.io[1], full_avg10: l.io && l.io[2], full_avg60: l.io && l.io[3],
      load1: l.la ? l.la[0] : null, zwaarste_apparaat: zwaarste(l), fout: l.fout || null } : null,
    piek_24u: { full_avg60: p60 ? { waarde: p60.io[3], tijd: p60.t } : null, full_avg10: p10 ? { waarde: p10.io[2], tijd: p10.t } : null },
    schrijven: { uitstaand: uitstaand.length + (inVlucht ? inVlucht.n : 0), hangt_s: inVlucht ? Math.round((mono() - inVlucht.sinds) / 1000) : 0,
      laatste_ok_iso: laatsteSchrijfOk ? new Date(laatsteSchrijfOk).toISOString() : null, fout: schrijfFout },
    geschiedenis_fout: geschiedenisFout, ring_map: DIR
  };
}
let geschiedenisFout = null;

function luister() {
  const srv = http.createServer(function (q, res) {
    let u; try { u = new URL(q.url, 'http://x'); } catch (e) { res.writeHead(400); res.end(); return; }
    let j;
    if (u.pathname === '/samenvatting') j = samenvatting();
    else if (u.pathname === '/recent') {
      const min = Math.max(1, Math.min(1440, parseInt(u.searchParams.get('min') || '15', 10) || 15));
      const grens = Date.now() - min * 60000;
      j = { ok: true, min: min, records: buf.filter((r) => r.ms >= grens).map((r) => { const c = Object.assign({}, r); delete c.ms; return c; }), samenvatting: samenvatting() };
    } else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(j));
  });
  srv.on('error', function () {});
  fsp.unlink(SOCK).catch(() => {}).then(() => { try { srv.listen(SOCK); } catch (e) {} });
}

// ── de alarmrij ─────────────────────────────────────────────────────────────────────────────────────────────────────
let alarmSinds = null, alarmGemeld = false, laatsteAlarm = 0;
async function schrijfAtomair(p, inhoud) {
  const tmp = path.join(path.dirname(p), '.' + path.basename(p) + '.schijfdruk-' + crypto.randomBytes(4).toString('hex') + '.tmp');
  return metGrens(fsp.writeFile(tmp, inhoud).then(() => fsp.rename(tmp, p)).then(() => true), C.fs, false);
}
// De box-rij gaat via vault-veilig.wijzig (symlinkveilig, mapgrendel met flock, opnieuw lezen als het bestand intussen veranderde; Codex
// MOET 2) in een kind-proces met time-out: een schijf die hangt, hangt het kind en niet deze meter.
const BOX_KIND = "const vv = require(process.argv[1]);" +
  "const ok = vv.wijzig(process.argv[2], function (t) {" +
  " const m = /\\n## \\[[a-z]{2,10}\\] \\d{4}-\\d{2}-\\d{2}/.exec(t); if (!m) return null;" +
  " return t.slice(0, m.index) + JSON.parse(process.argv[3]) + t.slice(m.index); }, { grendel: 5 });" +
  "process.exit(ok ? 0 : 3);";
function boxRijVeilig(rij) {
  const vv = path.join(__dirname, 'vault-veilig.js');
  if (!fs.existsSync(vv)) return Promise.resolve(false);
  return new Promise(function (resolve) {
    let k, klaar = false;
    const einde = (v) => { if (!klaar) { klaar = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => { try { k.kill('SIGKILL'); } catch (e) {} einde(false); }, 30000);
    try { k = spawn(process.execPath, ['-e', BOX_KIND, vv, BOX, JSON.stringify(rij)], { stdio: 'ignore', cwd: '/' }); }
    catch (e) { einde(false); return; }
    k.on('error', () => einde(false));
    k.on('exit', (code) => einde(code === 0));
  });
}
async function alarmRij(vanaf) {
  const nu = Date.now();
  const venster = buf.filter((r) => r.ms >= vanaf);
  const som = {};
  for (const r of venster) if (r.d && r.dt) for (const n of Object.keys(r.d)) { const s = som[n] || (som[n] = { tick: 0, ms: 0, rs: 0, ws: 0 }); s.tick += r.d[n][2]; s.ms += r.dt * 1000; s.rs += r.d[n][0]; s.ws += r.d[n][1]; }
  let top = null;
  for (const n of Object.keys(som)) { const b = som[n].ms ? som[n].tick / som[n].ms * 100 : 0; if (!top || b > top.b) top = { n: n, b: b, mb_r: som[n].rs * 512 / 1048576, mb_w: som[n].ws * 512 / 1048576 }; }
  const piek = venster.reduce((m, r) => (r.io && r.io[3] > m ? r.io[3] : m), 0);
  const l = buf[buf.length - 1];
  const velden = [
    ['status', 'open — alleen vastgelegd; geen actie nodig tenzij het terugkomt of de server er last van heeft'],
    ['van', 'schijfdruk.js (wv3124, release ' + SHA + ')'],
    ['gemeten', 'full avg60 van /proc/pressure/io boven ' + C.alarmPct + ' % sinds ' + hhmm(vanaf) + ' (nu ' + hhmm(nu) + ', ' + Math.round((nu - vanaf) / 60000) + ' min, piek ' + piek + ' %, laatste minuut full avg10 ' + (l && l.io ? l.io[2] : '?') + ' %)' +
      (top ? '; zwaarste apparaat in dit tijdvak ' + top.n + ' (' + rond(top.b, 10) + ' % bezet, ' + rond(top.mb_r, 10) + ' MB gelezen, ' + rond(top.mb_w, 10) + ' MB geschreven)' : '; geen apparaat met IO-delta (druk komt van buiten de pod of de diskstats ontbreken)')],
    ['verloop', 'ring ' + DIR + '/ring-*.jsonl (per minuut, 42-48 u) en /health.schijfdruk; bij een ingreep van de bewaker staan de laatste 15 min in bin/bewaker-bewijs-*.json'],
    ['voorstel', 'vergelijk het tijdvak met Immich/Takeout-import, back-ups en de nachtketen; bij een herhaling op hetzelfde uur de bron op de Olares-host zoeken']];
  const rij = '\n## [direct] ' + amsterdam().slice(0, 16) + ' — Schijfdruk hoog: full avg60 > ' + C.alarmPct + ' % al ' + Math.round((nu - vanaf) / 60000) + ' min' + (top ? ' (' + top.n + ')' : '') + ' #schijfdruk-hoog\n' +
    velden.map((v) => '- ' + v[0] + ': ' + String(v[1]).replace(/[\r\n]+/g, ' ').slice(0, 1500)).join('\n') + '\n';
  return boxRijVeilig(rij);
}
async function alarmControle(r) {
  const hoog = r.io && r.io[3] > C.alarmPct;
  if (!hoog) { alarmSinds = null; alarmGemeld = false; return; }
  if (!alarmSinds) alarmSinds = r.ms;
  if (alarmGemeld || r.ms - alarmSinds < C.alarmMs) return;
  alarmGemeld = true;   // één poging per aaneengesloten periode
  if (r.ms - laatsteAlarm < C.alarmPauze) return;
  if (await alarmRij(alarmSinds)) {
    laatsteAlarm = r.ms;
    await schrijfAtomair(ALARM_BESTAND, JSON.stringify({ laatste_iso: new Date(r.ms).toISOString(), vanaf_iso: new Date(alarmSinds).toISOString() }) + '\n');
  }
}

// ── de lus ──────────────────────────────────────────────────────────────────────────────────────────────────────────
async function tik() {
  if (sampleBezig) return;   // de vorige meting is nog niet terug (elke lezing heeft een eigen time-out)
  sampleBezig = true;
  try {
    let r;
    if (fsOpen > MAXOPEN) {   // handelingen die vastzitten bezetten de pool: een nieuwe lezing zou erachter blijven hangen
      const wand = Date.now();
      r = { t: new Date(wand).toISOString(), fout: 'lezingen hangen (' + fsOpen + ' bestandshandelingen open)', ms: wand };
      vorige = null;   // de volgende delta zou over het gat lopen
    } else r = await monster();
    buf.push(r); while (buf.length > C.geheugen) buf.shift();
    uitstaand.push(r); if (uitstaand.length > C.uitstaand) uitstaand = uitstaand.slice(-C.uitstaand);
    schrijf();
    if (fsOpen <= MAXOPEN) {
      await alarmControle(r).catch(() => {});
      if (await slotIsVan_mij() === false) process.exit(0);   // elke tik: een verliezer van een gelijktijdige start stopt hier
    }
  } catch (e) {} finally { sampleBezig = false; }
}
function stop() {
  Promise.race([fsp.readFile(LOCK, 'utf8').then((h) => { if (JSON.parse(h).pid === process.pid) return fsp.unlink(LOCK); }), wacht(1500)])
    .catch(() => {}).finally(() => { try { fs.unlinkSync(SOCK); } catch (e) {} process.exit(0); });
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.on('uncaughtException', function () {});
process.on('unhandledRejection', function () {});

(async function () {
  if (fs.existsSync(UIT)) process.exit(0);
  if (!(await neemSlot())) process.exit(0);
  await wacht(600);   // een gelijktijdige starter kan het slot nog overschrijven (Codex MOET 3): pas luisteren als het na 600 ms nog van mij is
  if (await slotIsVan_mij() !== true) process.exit(0);
  const al = await lees(ALARM_BESTAND, 3000);
  try { laatsteAlarm = Date.parse(JSON.parse(al).laatste_iso) || 0; } catch (e) {}
  geschiedenisFout = await geschiedenis();
  luister();
  await tik();
  setInterval(function () { tik(); }, C.tik);
})();
