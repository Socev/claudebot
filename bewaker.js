#!/usr/bin/env node
/*
 * bewaker.js — levensbewaking van server.js (wv701, 21-10-2026, akkoord David vraag-id ca8d289c).
 * Bouwplan: 01_Ontwikkeling/Levensbewaking server.js (bouwplan 21-10-2026).md in de vault.
 *
 * WAAROM. Op 21-10-2026 liep server.js van 10:48 tot 12:11 vast: geen antwoord, ook niet op /health, en David moest de
 * pod zelf herstarten. De supervisor kijkt alleen bij de opstart naar /health en herstart alleen een kind dat STERFT;
 * een kind dat leeft maar niet antwoordt, bleef eeuwig hangen. De supervisor zit in het image (route A, later); deze
 * bewaker komt met de gewone uitrol mee (route B) en doet het tot die tijd.
 *
 * HOE. server.js (alleen de echte, SERVER_ECHT) start bij elke opstart `node bewaker.js --server-pid <pid> --poort <p>`,
 * losgekoppeld. Eén bewaker per server-leven: hij onthoudt de starttijd van dat pid en stopt zodra dát proces weg is; de
 * nieuwe server start een nieuwe bewaker met de code van zijn eigen release. Nooit het pad van server.js als argument:
 * uitrol.sh stap 4 zoekt kinderen met pgrep op `server\.js` en zou de bewaker dan meedoden.
 *
 *   meten     elke 15 s GET /health/publiek (geen bestandswerk: bewijst alleen dat de event loop draait; de volle /health
 *             doet zelf fs-werk en zou een stokkende server erger maken, Fable wv701 #3), 10 s time-out. Eén keer per
 *             minuut de volle /health voor de context (lopende beurten, agents). Gewapend pas na de eerste ok.
 *   ingrijpen pas als ≥ 180 s geen ok (monotone klok) ÉN ≥ 8 missers op rij: een bevroren container of een klokspong
 *             telt niet. Niet bij een verse uitrolmarker, niet als bewaker-uit bestaat, niet als de ouder van server.js
 *             geen supervisor.js is (niemand zou herstarten: alleen melden).
 *   rem       hooguit 3 ingrepen per uur (bin/bewaker-staat.json); de vierde: niet doden, één melding.
 *   ingreep   vorige tijdelijk gelijk aan current (anders flipt de supervisor een gezonde release terug als de herstart
 *             niet binnen 25 s gezond is, en is zijn enige terugflip op; Fable #1) → momentopname (bin/bewaker-bewijs-*.json,
 *             voor wv700) → SIGTERM, 10 s genade, SIGKILL (de SIGTERM-handler van server.js draait niet in een dichte loop)
 *             → losse niet-losgekoppelde kinderen opruimen (socev-auto; beurten en agents hebben een eigen procesgroep en
 *             blijven) → wachten tot /health weer ok is → vorige terugzetten → regel in supervisor.log, rij in de box,
 *             seintje via mk-scripts/bericht.py (niet 23:00–07:00).
 *   herstart  doet de supervisor (verwerkCrash): het kind sterft aan SIGKILL en telt als één crash.
 *
 * Alles wat bestanden raakt is asynchroon en begrensd: een hangend bestandssysteem mag het doden nooit tegenhouden.
 * Uitzetten: touch /opt/data/bewaker-uit (wordt elke tik gelezen) of BEWAKER=0 in de omgeving van server.js.
 * Toetsen: test/bewaker-*.sh (eigen APP_ROOT, poort en paden via de BEWAKER_*-omgeving; nooit de echte pod).
 */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ── starten vanuit server.js ────────────────────────────────────────────────────────────────────────────────────────
function start(o) {
  const k = spawn(process.execPath, [__filename, '--server-pid', String(o.serverPid), '--poort', String(o.poort)], {
    detached: true, stdio: 'ignore', cwd: '/', env: o.env || process.env
  });
  k.on('error', function () {});
  k.unref();
  return k.pid;
}
if (require.main !== module) { module.exports = { start: start }; return; }

// ── instellingen ────────────────────────────────────────────────────────────────────────────────────────────────────
function getal(naam, standaard) {
  const v = parseInt(process.env[naam] || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : standaard;
}
const C = {
  tik: getal('BEWAKER_TIK_MS', 15000),
  timeout: getal('BEWAKER_TIMEOUT_MS', 10000),
  grens: getal('BEWAKER_GRENS_MS', 180000),
  minMissers: getal('BEWAKER_MIN_MISSERS', 8),
  context: getal('BEWAKER_CONTEXT_MS', 60000),
  genade: getal('BEWAKER_GENADE_MS', 10000),
  killWacht: getal('BEWAKER_KILL_WACHT_MS', 30000),
  terug: getal('BEWAKER_TERUG_MS', 120000),
  remMax: getal('BEWAKER_REM_MAX', 3),
  remVenster: getal('BEWAKER_REM_VENSTER_MS', 3600000),
  cpuSample: getal('BEWAKER_CPU_MS', 5000),
  bootMarge: getal('BEWAKER_BOOT_MARGE_MS', 30000),   // na gezond nog zo lang vorige=current: de supervisor toetst /health tot 25 s
  inspector: process.env.BEWAKER_INSPECTOR !== '0',
  inspectorPoort: getal('BEWAKER_INSPECTOR_POORT', 9229),
  fs: 8000   // grens voor één bestandshandeling
};
const BIN = process.env.BIN_DIR || '/opt/data/bin';
const LOG = path.join(BIN, 'supervisor.log');
const STAAT = process.env.BEWAKER_STAAT || path.join(BIN, 'bewaker-staat.json');
const SLOT = process.env.BEWAKER_SLOT || path.join(BIN, 'bewaker.pid');
const MARKER = process.env.UITROL_MARKER || '/opt/data/uitrol-wacht';
const MARKER_MAX_MS = 5 * 60 * 1000;
const UIT = process.env.BEWAKER_UIT || '/opt/data/bewaker-uit';
const VAULT = process.env.VAULT_DIR || '/opt/data/AI_SecondBrain';
const BOX = process.env.BEWAKER_BOX || path.join(VAULT, '00_Systeem', 'Meldingen', 'machinekamer.md');
const BERICHT = process.env.BEWAKER_BERICHT || '/opt/data/mk-scripts/bericht.py';
const API_LOG = process.env.API_LOG || path.join(BIN, 'api.log');
const AGENTS = process.env.BEWAKER_AGENTS || path.join(process.env.HOME || '/opt/data', 'agent_jobs.json');
const CGROUP = process.env.BEWAKER_CGROUP || '/sys/fs/cgroup';
const RELEASE_DIR = process.env.RELEASE_DIR || '';
const APP_ROOT = process.env.APP_ROOT || (RELEASE_DIR ? path.dirname(path.dirname(RELEASE_DIR)) : '/opt/data/app');
const SHA = process.env.RELEASE_SHA || (RELEASE_DIR ? path.basename(RELEASE_DIR) : 'onbekend');

const arg = {};
for (let i = 2; i < process.argv.length - 1; i++) if (process.argv[i].startsWith('--')) arg[process.argv[i].slice(2)] = process.argv[i + 1];
const SERVER = parseInt(arg['server-pid'] || '', 10);
const POORT = parseInt(arg.poort || process.env.PORT || '8080', 10);
if (!(SERVER > 1)) { process.stderr.write('bewaker: --server-pid ontbreekt\n'); process.exit(2); }

// ── hulpjes ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const mono = () => Number(process.hrtime.bigint() / 1000000n);
const wacht = (ms) => new Promise((r) => setTimeout(r, ms));
function metGrens(p, ms, standaard) {
  let t;
  return Promise.race([Promise.resolve(p).catch(() => standaard), new Promise((r) => { t = setTimeout(() => r(standaard), ms); })])
    .finally(() => clearTimeout(t));
}
const lees = (p, ms) => metGrens(fsp.readFile(p, 'utf8'), ms || C.fs, null);
function stempelUtc(d) { return (d || new Date()).toISOString().replace('T', ' ').slice(0, 19); }
function amsterdam(d) { return (d || new Date()).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }   // 'JJJJ-MM-DD HH:MM:SS'
function eenRegel(s, n) { return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').slice(0, n || 300); }

// Zelfde formaat als de supervisor (UTC), per regel toegevoegd (geen stream: logrotatie).
function log(regel) {
  const s = stempelUtc() + ' bewaker[' + process.pid + ']: ' + regel + '\n';
  return metGrens(fsp.mkdir(BIN, { recursive: true }).then(() => fsp.appendFile(LOG, s)), C.fs, null);
}
const gemeld = {};
function eens(sleutel, regel) { if (gemeld[sleutel]) return; gemeld[sleutel] = true; log(regel); }

async function procStat(pid) {
  const s = await lees('/proc/' + pid + '/stat', 3000);
  if (!s) return null;
  const na = s.slice(s.lastIndexOf(')') + 2).split(' ');
  return { state: na[0], ppid: parseInt(na[1], 10), pgrp: parseInt(na[2], 10), utime: parseInt(na[11], 10),
    stime: parseInt(na[12], 10), start: na[19], comm: s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')) };
}
let SERVER_START = null;
// Leeft DIT proces nog (zelfde pid én starttijd, geen zombie)? Vóór elk signaal opnieuw gevraagd (pid-hergebruik).
async function serverLeeft() {
  const st = await procStat(SERVER);
  return !!(st && st.start === SERVER_START && st.state !== 'Z' && st.state !== 'X');
}
async function leeftMetStart(pid, start) {
  const st = pid > 1 ? await procStat(pid) : null;
  return !!(st && st.start === start && st.state !== 'Z');
}
async function schrijfAtomair(p, inhoud) {
  const tmp = path.join(path.dirname(p), '.' + path.basename(p) + '.bewaker-' + crypto.randomBytes(4).toString('hex') + '.tmp');
  return metGrens(fsp.writeFile(tmp, inhoud).then(() => fsp.rename(tmp, p)).then(() => true), C.fs, false);
}
async function leesJson(p) { const s = await lees(p); if (!s) return null; try { return JSON.parse(s); } catch (e) { return null; } }

function vraag(pad, ms) {
  return new Promise(function (resolve) {
    let klaar = false;
    const einde = (v) => { if (!klaar) { klaar = true; clearTimeout(t); resolve(v); } };
    const req = http.get({ host: '127.0.0.1', port: POORT, path: pad, agent: false, timeout: ms || C.timeout }, function (res) {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (s.length < 2000000) s += d; });
      res.on('end', () => { try { const j = JSON.parse(s); einde(j && j.ok === true ? j : null); } catch (e) { einde(null); } });
      res.on('error', () => einde(null));
    });
    const t = setTimeout(() => { req.destroy(); einde(null); }, (ms || C.timeout) + 500);
    req.on('error', () => einde(null));
    req.on('timeout', () => { req.destroy(); einde(null); });
  });
}

// ── slot: één bewaker per server; een bewaker van een andere (nieuwe) server neemt over (Fable #2) ─────────────────
let mijnStart = null;
async function neemSlot() {
  const oud = await leesJson(SLOT);
  if (oud && oud.bewaker_pid !== process.pid && oud.server_pid === SERVER && oud.server_start === SERVER_START &&
      await leeftMetStart(oud.bewaker_pid, oud.bewaker_start)) {
    await log('er bewaakt al een bewaker (pid ' + oud.bewaker_pid + ') server ' + SERVER + ' - deze stopt');
    process.exit(0);
  }
  await schrijfAtomair(SLOT, JSON.stringify({ bewaker_pid: process.pid, bewaker_start: mijnStart, server_pid: SERVER,
    server_start: SERVER_START, release: SHA, sinds: new Date().toISOString() }) + '\n');
}
async function geefSlot() {
  const oud = await leesJson(SLOT);
  if (oud && oud.bewaker_pid === process.pid) await metGrens(fsp.unlink(SLOT), C.fs, null);
}

// ── staat (rem, vorige-herstel) ─────────────────────────────────────────────────────────────────────────────────────
let staatGeheugen = { ingrepen: [] };
async function leesStaat() {
  const j = await leesJson(STAAT);
  if (j && Array.isArray(j.ingrepen)) staatGeheugen = j;   // onleesbaar: de rem rekent met wat deze bewaker weet (Fable #7)
  return staatGeheugen;
}
async function schrijfStaat(s) { staatGeheugen = s; return schrijfAtomair(STAAT, JSON.stringify(s) + '\n'); }
function recenteIngrepen(s) {
  const nu = Date.now();
  // Toekomststempels (podklok sprong) tellen niet mee (Fable #5).
  return (s.ingrepen || []).filter((t) => typeof t === 'number' && t <= nu + 60000 && nu - t < C.remVenster);
}

// ── symlinks: vorige tijdelijk = current, zodat de supervisor niet terugflipt (Fable #1) ──────────────────────────────
const CURRENT = path.join(APP_ROOT, 'current');
const VORIGE = path.join(APP_ROOT, 'vorige');
const leesLink = (p) => metGrens(fsp.readlink(p), C.fs, null);
async function zetLink(p, doel) {
  const tmp = p + '.bewaker-' + process.pid;
  return metGrens(fsp.unlink(tmp).catch(() => {}).then(() => fsp.symlink(doel, tmp)).then(() => fsp.rename(tmp, p)).then(() => true), C.fs, false);
}
async function beschermVorige() {
  const cur = await leesLink(CURRENT), vor = await leesLink(VORIGE);
  if (!cur || !vor || cur === vor) return null;
  // Alleen als current nog naar de release van MIJN server wijst: zette een uitrol intussen een nieuwe release neer,
  // dan is vorige het vangnet voor die release en blijft hij staan (Fable wv701-code #2).
  if (cur !== path.join('releases', SHA)) { await log('vorige niet aangeraakt: current wijst naar ' + cur + ', niet naar mijn release ' + SHA + ' (uitrol bezig?)'); return null; }
  if (!(await zetLink(VORIGE, cur))) { await log('LET OP: kon vorige niet tijdelijk op current zetten - een trage herstart kan nu terugflippen'); return null; }
  const s = await leesStaat();
  s.vorige_herstel = { current: cur, vorige: vor, tijd: Date.now() };
  await schrijfStaat(s);
  await log('vorige tijdelijk -> ' + cur + ' (was ' + vor + '): een vastloper is geen oordeel over de release');
  return s.vorige_herstel;
}
// Alleen terugzetten als niemand (uitrol.sh) de links intussen veranderde.
async function herstelVorige(h) {
  if (!h) return 'niet nodig';
  const cur = await leesLink(CURRENT), vor = await leesLink(VORIGE);
  let uitkomst;
  if (cur !== h.current || vor !== h.current) uitkomst = 'niet teruggezet: de links veranderden intussen (current ' + cur + ', vorige ' + vor + ')';
  else if (!(await metGrens(fsp.stat(path.join(APP_ROOT, h.vorige, 'server.js')).then(() => true), C.fs, false))) uitkomst = 'niet teruggezet: ' + h.vorige + ' bestaat niet meer';
  else uitkomst = (await zetLink(VORIGE, h.vorige)) ? 'vorige -> ' + h.vorige + ' (teruggezet)' : 'terugzetten mislukte';
  const s = await leesStaat();
  delete s.vorige_herstel;
  await schrijfStaat(s);
  await log(uitkomst);
  return uitkomst;
}

// ── momentopname voor wv700 (Fable #9: geen stack/syscall, wel CPU-samples, threads, cgroup) ─────────────────────────
async function threads(pid) {
  const tids = await metGrens(fsp.readdir('/proc/' + pid + '/task'), 3000, []);
  const uit = [];
  for (const tid of tids.slice(0, 64)) {
    const st = await procStat(pid + '/task/' + tid);
    if (!st) continue;
    uit.push({ tid: parseInt(tid, 10), comm: st.comm, state: st.state, utime: st.utime, stime: st.stime,
      wchan: eenRegel(await lees('/proc/' + pid + '/task/' + tid + '/wchan', 2000), 60) || null });
  }
  return uit;
}
async function kinderenVan(pid) {
  const namen = await metGrens(fsp.readdir('/proc'), 3000, []);
  const uit = [];
  for (const n of namen) {
    if (!/^\d+$/.test(n)) continue;
    const st = await procStat(n);
    if (st && st.ppid === pid) uit.push({ pid: parseInt(n, 10), comm: st.comm, start: st.start, pgrp: st.pgrp });
  }
  return uit;
}
async function staartVan(p, regels) {
  const fh = await metGrens(fsp.open(p, 'r'), C.fs, null);
  if (!fh) return [];
  try {
    const st = await metGrens(fh.stat(), C.fs, null);
    if (!st) return [];
    const n = Math.min(st.size, 65536), buf = Buffer.alloc(n);
    const r = await metGrens(fh.read(buf, 0, n, st.size - n), C.fs, null);
    if (!r) return [];
    return buf.slice(0, r.bytesRead).toString('utf8').split('\n').filter(Boolean).slice(-regels).map((x) => x.slice(0, 400));
  } finally { fh.close().catch(() => {}); }
}
// JS-stapel via de inspector: SIGUSR1 start hem ook bij een dichte loop (V8-interrupt), Debugger.pause breekt in een
// draaiende lus in. Zit de server vast in een systeemaanroep, dan komt er geen pauze: ook dat is een bevinding.
async function jsStapel(pid) {
  if (!C.inspector || typeof WebSocket !== 'function') return { uit: C.inspector ? 'geen WebSocket in deze node' : 'uitgezet' };
  try { process.kill(pid, 'SIGUSR1'); } catch (e) { return { fout: 'SIGUSR1: ' + e.code }; }
  let doel = null;
  const tot = mono() + 4000;
  while (!doel && mono() < tot) {
    const lijst = await new Promise(function (resolve) {
      const req = http.get({ host: '127.0.0.1', port: C.inspectorPoort, path: '/json/list', agent: false, timeout: 1000 }, function (res) {
        let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(null); } });
      });
      req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
    });
    // Alleen de server zelf: titel = pad van het hoofdscript (of node[pid]); nooit een ander proces op 9229.
    // (socev-auto heet ook .../server.js: dus het volledige pad van de release, Fable wv701-code #5)
    const titel = RELEASE_DIR ? path.join(RELEASE_DIR, 'server.js') : null;
    doel = (lijst || []).find((t) => t && t.webSocketDebuggerUrl && ((titel && t.title === titel) || String(t.title).includes('[' + pid + ']')));
    if (!doel) await wacht(300);
  }
  if (!doel) return { fout: 'inspector niet bereikbaar op ' + C.inspectorPoort };
  return new Promise(function (resolve) {
    let klaar = false, ws;
    const scripts = {};   // scriptId -> url (callFrame.url is in node vaak leeg)
    const einde = (v) => { if (klaar) return; klaar = true; clearTimeout(t); try { ws.close(); } catch (e) {} resolve(v); };
    const t = setTimeout(() => einde({ fout: 'geen pauze binnen 6 s (vermoedelijk vast in een systeemaanroep; zie threads/wchan)' }), 6000);
    try { ws = new WebSocket(doel.webSocketDebuggerUrl); } catch (e) { return einde({ fout: 'websocket: ' + e.message }); }
    ws.onerror = () => einde({ fout: 'websocket-fout' });
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Debugger.enable' }));
      ws.send(JSON.stringify({ id: 2, method: 'Debugger.pause' }));
    };
    ws.onmessage = (m) => {
      let j; try { j = JSON.parse(String(m.data)); } catch (e) { return; }
      if (j.method === 'Debugger.scriptParsed' && j.params) { scripts[j.params.scriptId] = j.params.url; return; }
      if (j.method !== 'Debugger.paused') return;
      const fr = (j.params && j.params.callFrames) || [];
      einde({ reden: j.params.reason, stapel: fr.slice(0, 20).map((f) => (f.functionName || '(anoniem)') + ' ' +
        path.basename(String(f.url || (f.location && scripts[f.location.scriptId]) || '?')) + ':' + ((f.location && f.location.lineNumber) + 1)) });
    };
  });
}
async function momentopname(stilS) {
  const b = { tijd_iso: new Date().toISOString(), server_pid: SERVER, release: SHA, stil_s: stilS, missers: missers,
    laatste_gezond: laatsteContext };
  const s1 = await procStat(SERVER), t1 = mono(), th1 = await threads(SERVER);
  const status = await lees('/proc/' + SERVER + '/status', 3000);
  b.status = {};
  if (status) for (const k of ['State', 'VmRSS', 'VmHWM', 'VmSwap', 'Threads', 'voluntary_ctxt_switches', 'nonvoluntary_ctxt_switches']) {
    const m = new RegExp('^' + k + ':\\s*(.+)$', 'm').exec(status); if (m) b.status[k] = m[1].trim();
  }
  b.wchan = eenRegel(await lees('/proc/' + SERVER + '/wchan', 2000), 80) || null;
  b.fds = await metGrens(fsp.readdir('/proc/' + SERVER + '/fd').then((x) => x.length), 3000, null);
  b.cgroup = { cpu_stat: eenRegel(await lees(path.join(CGROUP, 'cpu.stat'), 2000), 400),
    memory_current: eenRegel(await lees(path.join(CGROUP, 'memory.current'), 2000), 40),
    memory_max: eenRegel(await lees(path.join(CGROUP, 'memory.max'), 2000), 40),
    cpu_pressure: eenRegel(await lees(path.join(CGROUP, 'cpu.pressure'), 2000), 200),
    io_pressure: eenRegel(await lees(path.join(CGROUP, 'io.pressure'), 2000), 200) };
  b.kinderen = await kinderenVan(SERVER);
  b.api_log = await staartVan(API_LOG, 50);
  const ag = await leesJson(AGENTS);
  b.agents_lopend = ag ? Object.keys(ag).map((k) => ag[k]).filter((a) => a && a.status === 'running')
    .map((a) => ({ job_id: a.job_id, label: eenRegel(a.label, 80), started: a.started })) : null;
  // CPU: twee samples (busy-loop ≈ 100% op de hoofdthread, wachten ≈ 0%), vóór de inspector die de lus stilzet.
  await wacht(Math.max(0, C.cpuSample - (mono() - t1)));
  const s2 = await procStat(SERVER), t2 = mono(), th2 = await threads(SERVER);
  if (s1 && s2) {
    const tik = (s2.utime + s2.stime) - (s1.utime + s1.stime);   // klokticks van 1/100 s
    b.cpu = { procent: Math.round(tik / ((t2 - t1) / 1000)), user_ticks: s2.utime - s1.utime, sys_ticks: s2.stime - s1.stime, state: s2.state };
  }
  b.threads = th2.map(function (t) {
    const v = th1.find((x) => x.tid === t.tid);
    return { tid: t.tid, comm: t.comm, state: t.state, wchan: t.wchan, cpu_ticks: v ? (t.utime + t.stime) - (v.utime + v.stime) : null };
  });
  b.js = await jsStapel(SERVER);
  return b;
}
function kortBewijs(b) {
  if (!b || b.fout) return (b && b.fout) || 'geen momentopname';
  const delen = ['State ' + (b.status.State || '?'), 'CPU ' + (b.cpu ? b.cpu.procent + '%' : '?'), 'RSS ' + (b.status.VmRSS || '?'),
    'threads ' + (b.status.Threads || '?'), 'fds ' + (b.fds == null ? '?' : b.fds), 'wchan ' + (b.wchan || '?')];
  if (b.js && b.js.stapel && b.js.stapel.length) delen.push('JS-stapel boven: ' + b.js.stapel.slice(0, 3).join(' < '));
  else if (b.js) delen.push('JS-stapel: ' + (b.js.fout || b.js.uit || '?'));
  return delen.join('; ');
}

// ── doden en opvangen ───────────────────────────────────────────────────────────────────────────────────────────────
async function wachtTotWeg(ms) {
  const tot = mono() + ms;
  while (mono() < tot) { if (!(await serverLeeft())) return true; await wacht(250); }
  return !(await serverLeeft());
}
async function dood() {
  if (!(await serverLeeft())) return 'al-weg';
  try { process.kill(SERVER, 'SIGTERM'); } catch (e) { return 'al-weg'; }
  await log('SIGTERM naar server ' + SERVER);
  if (await wachtTotWeg(C.genade)) return 'sigterm';
  if (!(await serverLeeft())) return 'sigterm';
  try { process.kill(SERVER, 'SIGKILL'); } catch (e) { return 'sigterm'; }
  await log('server ' + SERVER + ' stopte niet binnen ' + Math.round(C.genade / 1000) + ' s - SIGKILL');
  if (await wachtTotWeg(C.killWacht)) return 'sigkill';
  return 'blijft';
}
// Niet-losgekoppelde kinderen (zelfde procesgroep als de server, bv. socev-auto) leven anders als wees door en houden
// hun poort bezet. Kinderen met een eigen procesgroep (beurten, agents) blijven: die heeft de weesafhandeling.
async function ruimKinderenOp(kinderen, serverPgrp) {
  const weg = [];
  for (const k of kinderen || []) {
    if (k.pgrp !== serverPgrp || k.pgrp === k.pid) continue;
    if (!(await leeftMetStart(k.pid, k.start))) continue;
    try { process.kill(k.pid, 'SIGTERM'); weg.push(k.pid + ' (' + k.comm + ')'); } catch (e) {}
  }
  if (weg.length) await log('losse kinderen van de oude server gestopt: ' + weg.join(', '));
  return weg;
}
async function wachtOpGezond(ms) {
  const t0 = mono();
  while (mono() - t0 < ms) {
    // De volle /health, zoals de boot-zelfcontrole van de supervisor (Fable wv701-code #3).
    const j = await vraag('/health', C.timeout);
    if (j) return { na_s: Math.round((mono() - t0) / 1000), versie: j.versie || null };
    await wacht(2000);
  }
  return null;
}

// ── melden ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function stilleUren() {
  const uur = process.env.BEWAKER_UUR !== undefined ? parseInt(process.env.BEWAKER_UUR, 10)
    : parseInt(amsterdam().slice(11, 13), 10);
  return uur >= 23 || uur < 7;
}
// Rij bovenaan de box, vóór de eerste echte rij (zelfde anker als bankBoxRij), tmp met punt ervoor + rename (Fable #8).
async function boxRij(titel, velden) {
  const t = await lees(BOX);
  if (!t) { await log('LET OP: box ' + BOX + ' niet leesbaar - geen rij geschreven'); return false; }
  const eerste = /\n## \[[a-z]{2,10}\] \d{4}-\d{2}-\d{2}/.exec(t);
  if (!eerste) { await log('LET OP: geen anker in de box - geen rij geschreven'); return false; }
  const rij = '\n## [direct] ' + amsterdam().slice(0, 16) + ' — ' + titel + '\n' +
    velden.map((v) => '- ' + v[0] + ': ' + eenRegel(v[1], 1500)).join('\n') + '\n';
  const ok = await schrijfAtomair(BOX, t.slice(0, eerste.index) + rij + t.slice(eerste.index));
  await log(ok ? 'rij in de box: ' + titel : 'LET OP: box schrijven mislukte');
  return ok;
}
function seintje(tekst, sleutel) {
  if (stilleUren()) return log('stille uren (23:00-07:00): geen seintje, alleen de box');
  return new Promise(function (resolve) {
    let p;
    try {
      p = spawn('python3', [BERICHT, '--klasse', 'normaal', '--sleutel', sleutel, tekst], { stdio: 'ignore', env: process.env });
    } catch (e) { log('seintje niet te starten: ' + e.message).then(resolve); return; }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 120000);
    p.on('error', (e) => { clearTimeout(t); log('seintje faalde: ' + e.message).then(resolve); });
    p.on('exit', (code) => { clearTimeout(t); log('seintje via bericht.py: exit ' + code).then(resolve); });
  });
}
function minuten(s) { const m = Math.max(1, Math.round(s / 60)); return m + (m === 1 ? ' minuut' : ' minuten'); }
function tijdKort(ms) { return amsterdam(new Date(ms)).slice(11, 16); }

// ── de lus ──────────────────────────────────────────────────────────────────────────────────────────────────────────
let gewapend = false, laatsteOkMono = null, laatsteOkWand = null, missers = 0, laatsteContext = null, contextMono = -Infinity;
let opgegeven = false, bezig = false, wegTeller = 0;

async function tik() {
  // Twee keer op rij: één trage /proc-lezing mag de bewaking niet beëindigen (Fable wv701-code #6).
  if (!(await serverLeeft())) wegTeller++; else wegTeller = 0;
  if (wegTeller === 1) return;
  if (wegTeller >= 2) {
    await log('server ' + SERVER + ' is weg (gestopt of vervangen) - bewaker stopt');
    await geefSlot();
    process.exit(0);
  }
  const ok = await vraag('/health/publiek');
  if (ok) {
    if (!gewapend) { gewapend = true; await log('gewapend: server ' + SERVER + ' (release ' + SHA + ') antwoordt op /health/publiek'); }
    else if (missers >= 4) await log('server ' + SERVER + ' antwoordt weer, na ' + missers + ' missers');
    missers = 0; laatsteOkMono = mono(); laatsteOkWand = Date.now();
    for (const k in gemeld) delete gemeld[k];
    if (mono() - contextMono >= C.context) {
      contextMono = mono();
      const j = await vraag('/health');
      if (j) laatsteContext = { tijd_iso: new Date().toISOString(), versie: j.versie, lopend: j.lopend || null,
        agents_lopend: j.agents ? j.agents.lopend : null };
      await oudHerstel();   // ook als een bewaker halverwege stierf en de nieuwe meteen startte (Fable wv701-code #4)
    }
    return;
  }
  missers++;
  if (!gewapend) return;
  const stil = mono() - laatsteOkMono;
  if (missers === 4) await log('server ' + SERVER + ' antwoordt al ' + Math.round(stil / 1000) + ' s niet (' + missers + ' missers op rij)');
  if (stil < C.grens || missers < C.minMissers || opgegeven) return;
  await overweeg(stil);
}

async function overweeg(stil) {
  if (await metGrens(fsp.stat(UIT).then(() => true), C.fs, false)) return eens('uit', UIT + ' staat er - niet ingrijpen');
  const m = await leesJson(MARKER);
  const mst = await metGrens(fsp.stat(MARKER), C.fs, null);
  if (mst && Date.now() - mst.mtimeMs <= MARKER_MAX_MS) {
    let leeft = true;
    if (m && m.pid) { try { process.kill(m.pid, 0); } catch (e) { if (e.code === 'ESRCH') leeft = false; } }
    if (leeft) return eens('uitrol', 'uitrolmarker staat er (sha ' + (m && m.sha) + ', pid ' + (m && m.pid) + ') - niet ingrijpen, de uitrol stopt de server zelf');
  }
  const st = await procStat(SERVER);
  const sup = st ? await lees('/proc/' + st.ppid + '/cmdline', 3000) : null;
  if (!sup || !/supervisor\.js/.test(sup)) {
    if (gemeld['geen-sup']) return;
    eens('geen-sup', 'server ' + SERVER + ' hangt, maar zijn ouder (pid ' + (st && st.ppid) + ') is geen supervisor.js - niet doden, niemand zou herstarten');
    await boxRij('Server hangt, maar de bewaker kan hem niet herstarten (geen supervisor als ouder)', [
      ['status', 'open'], ['van', 'bewaker.js (levensbewaking wv701, release ' + SHA + ')'],
      ['gemeten', 'geen antwoord op /health/publiek sinds ' + tijdKort(laatsteOkWand) + ' (' + Math.round(stil / 1000) + ' s, ' + missers + ' missers); ouder van server ' + SERVER + ' is pid ' + (st && st.ppid) + ' (' + eenRegel(String(sup || '?').replace(/\0/g, ' '), 80) + ')'],
      ['gevolg als er niets gebeurt', 'de pod blijft stil tot iemand hem herstart'],
      ['voorstel', 'procesboom nakijken (ps -ef); zo nodig David vragen de pod te herstarten']]);
    await seintje('De server reageert al ' + Math.round(stil / 60000) + ' minuten niet en ik kan hem niet zelf herstarten. Herstart de pod in Olares als ik over een paar minuten nog niet antwoord.', 'bewaker-geen-sup-' + SERVER);
    return;
  }
  const s = await leesStaat();
  const recent = recenteIngrepen(s);
  if (recent.length >= C.remMax) {
    if (s.rem_gemeld && s.rem_gemeld >= Math.max.apply(null, recent)) return;   // deze remperiode al gemeld
    s.rem_gemeld = Date.now();
    await schrijfStaat(s);
    await log('REM: server ' + SERVER + ' hangt weer, maar er waren al ' + recent.length + ' herstarts in het laatste uur - niet herstarten');
    await boxRij('Server hangt weer; rem bereikt (' + recent.length + ' automatische herstarts in een uur), bewaker herstart niet meer', [
      ['status', 'open'], ['van', 'bewaker.js (levensbewaking wv701, release ' + SHA + ')'],
      ['gemeten', 'geen antwoord sinds ' + tijdKort(laatsteOkWand) + ' (' + Math.round(stil / 1000) + ' s); eerdere herstarts om ' + recent.map(tijdKort).join(', ') + ' (supervisor.log, bin/bewaker-bewijs-*.json)'],
      ['gevolg als er niets gebeurt', 'de pod blijft stil tot David herstart of tot het uur om is (dan herstart de bewaker weer)'],
      ['voorstel', 'oorzaak met voorrang (wv700); de momentopnamen naast elkaar leggen']]);
    await seintje('De server hangt voor de ' + (recent.length + 1) + 'e keer binnen een uur. Ik herstart hem niet meer vanzelf; herstart de pod in Olares als ik over een kwartier nog niet antwoord.', 'bewaker-rem-' + s.rem_gemeld);
    return;
  }
  await ingreep(stil, s, recent.length + 1);
}

// Een fout halverwege mag de bewaker niet stil laten hangen met bezig = true (Fable wv701-code #1).
async function ingreep(stil, s, n) {
  bezig = true;
  try { await ingreepKern(stil, s, n); }
  catch (e) {
    await log('fout in de ingreep: ' + eenRegel(e && e.stack, 400));
    if (!(await serverLeeft())) { await geefSlot(); await log('server ' + SERVER + ' is weg - bewaker stopt'); process.exit(0); }
  }
  finally { bezig = false; }
}
async function ingreepKern(stil, s, n) {
  const stilS = Math.round(stil / 1000);
  const stempel = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  s.ingrepen = recenteIngrepen(s).concat([Date.now()]);
  await schrijfStaat(s);   // eerst vastleggen: een bewaker die halverwege sterft, telt toch voor de rem
  await log('INGREEP ' + n + '/' + C.remMax + ' dit uur: server ' + SERVER + ' antwoordt ' + stilS + ' s niet (' + missers + ' missers op rij) - momentopname, dan herstarten');
  const serverPgrp = (await procStat(SERVER) || {}).pgrp;
  const vorige = await beschermVorige();
  const bewijs = await metGrens(momentopname(stilS), C.cpuSample + 20000, { fout: 'momentopname niet binnen de tijd' });
  const bewijsPad = path.join(BIN, 'bewaker-bewijs-' + stempel + '.json');
  const bewaard = await schrijfAtomair(bewijsPad, JSON.stringify(bewijs, null, 1) + '\n');
  await log('momentopname: ' + kortBewijs(bewijs) + (bewaard ? ' -> ' + bewijsPad : ' (niet bewaard)'));
  const uitkomst = await dood();
  await log('server ' + SERVER + ': ' + uitkomst);
  await geefSlot();
  const kinderen = uitkomst === 'blijft' ? [] : await ruimKinderenOp(bewijs.kinderen, serverPgrp);
  const terug = uitkomst === 'blijft' ? null : await wachtOpGezond(C.terug);
  if (vorige && terug) await wacht(C.bootMarge);
  const herstel = await herstelVorige(vorige);
  const curNa = await leesLink(CURRENT);
  const flip = vorige && curNa && curNa !== vorige.current ? 'LET OP: current wijst nu naar ' + curNa + ' (was ' + vorige.current + ')' : null;
  const ctx = laatsteContext;
  const verloren = ctx && ctx.lopend ? 'bij de laatste gezonde meting (' + tijdKort(Date.parse(ctx.tijd_iso)) + ') liepen ' + (ctx.lopend.beurten || 0) +
    ' beurt(en), ' + (ctx.lopend.onopgehaald || 0) + ' onopgehaald resultaat, ' + (ctx.agents_lopend || 0) + ' agent(s)' : 'geen gezonde meting met lopende beurten bekend';
  const beurtWeg = !!(ctx && ctx.lopend && (ctx.lopend.beurten || ctx.lopend.onopgehaald));
  let uitslag;
  if (uitkomst === 'blijft') uitslag = 'server ' + SERVER + ' reageert ook niet op SIGKILL (State ' + (bewijs.status && bewijs.status.State) + ') - herstart lukt niet, pod herstarten';
  else if (terug) uitslag = 'weer gezond na ' + terug.na_s + ' s (versie ' + (terug.versie || '?') + ')';
  else uitslag = 'na ' + Math.round(C.terug / 1000) + ' s nog niet gezond - zie supervisor.log';
  if (uitkomst === 'blijft') opgegeven = true;
  await log('uitslag: ' + uitslag + (flip ? '; ' + flip : '') + '; ' + herstel);
  await boxRij('Server reageerde ' + Math.max(1, Math.round(stilS / 60)) + ' min niet; bewaker ' + (uitkomst === 'blijft' ? 'kon hem niet stoppen' : 'herstartte hem') + ' (' + n + 'e keer dit uur)', [
    ['status', 'open — oorzaak in wv700; momentopname ' + (bewaard ? '`' + bewijsPad + '`' : 'niet bewaard')],
    ['van', 'bewaker.js (levensbewaking wv701, release ' + SHA + ')'],
    ['gemeten', 'geen antwoord op /health/publiek sinds ' + tijdKort(laatsteOkWand) + ' (' + stilS + ' s, ' + missers + ' missers op rij); ' + kortBewijs(bewijs) +
      '; stoppen: ' + uitkomst + (kinderen.length ? '; losse kinderen gestopt: ' + kinderen.join(', ') : '') + '; ' + uitslag + (flip ? '; ' + flip : '') + '; ' + herstel],
    ['verloren', verloren + (beurtWeg ? '; een beurt die toen liep gaf geen antwoord (jobs staan alleen in het geheugen); agents rondt de weesafhandeling af' : '')],
    ['gevolg als er niets gebeurt', 'de bewaker vangt het op (hooguit ' + C.remMax + '×/uur), maar de oorzaak blijft en elke keer gaat een lopend antwoord verloren'],
    ['voorstel', 'momentopname naast wv700 leggen (JS-stapel, CPU, threads); bij een herhaling de oorzaak met voorrang']]);
  let tekst;
  if (uitkomst === 'blijft') tekst = 'De server hangt en laat zich niet stoppen. Herstart de pod in Olares, dan kijk ik daarna wat er was.';
  else if (terug) tekst = 'De server reageerde ' + minuten(stilS) + ' niet; ik heb hem om ' + tijdKort(Date.now() - terug.na_s * 1000) +
    ' zelf herstart en hij draait weer.' + (beurtWeg ? ' Er liep toen een vraag; dat antwoord kwam niet aan, stel hem gerust opnieuw.' : '');
  else tekst = 'De server reageerde ' + minuten(stilS) + ' niet. Ik heb hem herstart, maar hij is na twee minuten nog niet terug. Herstart de pod in Olares als ik over een kwartier nog niet antwoord.';
  await seintje(tekst, 'bewaker-' + stempel);
  if (uitkomst !== 'blijft') { await log('bewaker van server ' + SERVER + ' klaar - de nieuwe server start zijn eigen bewaker'); process.exit(0); }
}

// Een vorige-herstel dat bleef staan (bewaker stierf halverwege een ingreep): terugzetten als de links nog kloppen.
async function oudHerstel() {
  const s = await leesStaat();
  const h = s.vorige_herstel;
  if (h && typeof h.tijd === 'number' && Date.now() - h.tijd > 10 * 60 * 1000) await herstelVorige(h);
}

process.on('uncaughtException', (e) => { log('fout (gaat door): ' + eenRegel(e && e.stack, 400)); });
process.on('unhandledRejection', (e) => { log('fout (gaat door): ' + eenRegel(e && (e.stack || e), 400)); });
process.on('SIGTERM', () => { geefSlot().finally(() => process.exit(0)); });

(async function () {
  const st = await procStat(SERVER);
  if (!st) { await log('server ' + SERVER + ' bestaat niet - bewaker stopt'); process.exit(0); }
  SERVER_START = st.start;
  mijnStart = (await procStat(process.pid) || {}).start || null;
  await neemSlot();
  await log('start - bewaakt server ' + SERVER + ' op poort ' + POORT + ' (release ' + SHA + '; grens ' + Math.round(C.grens / 1000) + ' s en ' +
    C.minMissers + ' missers, rem ' + C.remMax + '/' + Math.round(C.remVenster / 60000) + ' min)');
  const lus = async function () {
    const t0 = mono();
    try { if (!bezig) await tik(); } catch (e) { await log('fout in tik: ' + eenRegel(e && e.stack, 400)); }
    setTimeout(lus, Math.max(500, C.tik - (mono() - t0)));
  };
  lus();
})();
