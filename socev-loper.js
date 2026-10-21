#!/usr/bin/env node
/*
 * socev-loper.js — start smalle Socev-gesprekken als gebruiker socev (uid 1002), op verzoek van server.js (wv699, 21-10-2026).
 *
 * WAAROM. Alles in de pod draaide als één gebruiker (claude, 1001). Een proces van dezelfde gebruiker kan de omgeving van
 * een ander proces lezen (/proc/<pid>/environ): een Socev-gesprek dat via een prompt-injectie een paar Bash-commando's draait,
 * kon zo bij de kluissleutel van server.js en daarmee bij de bunq-sleutel die kan betalen. Bouwplan: 01_Ontwikkeling/Socev-
 * gesprekken onder eigen gebruiker - sleutelscheiding (bouwplan 21-10-2026).md, § 3.3 en Fable-review § 5 (#2, #3).
 *
 * HOE. Root bindt de socket /run/socev-loper/loper.sock (map root 0755, socket root:claude 0660: alleen uid 1001 kan
 * verbinden, deze loper zelf en de gesprekken die hij start niet) en geeft hem als fd 3 aan dit proces, dat via setpriv als
 * 1002 draait zonder capabilities en met no_new_privs (/app/loper-bind.py). Dit proces doet nooit bind of chmod, alleen
 * accept op fd 3. Een Socev-gesprek kan de loper stoppen (zelfde uid): dat is hinder, geen inbraak; de root-lus start hem
 * binnen een paar seconden opnieuw en de socket blijft van root.
 *
 * PROTOCOL. Eén JSON-object per regel, beide kanten. Verzoek {op, nr?, ...}; antwoord {nr, ok, ...} of {nr, ok:false, fout}.
 *   ping                                → {uid, gid, pid, versie, lopend, sinds}
 *   start {id, brein, args, cwd, env, invoer?}
 *                                       → {id, pid}; daarna op deze verbinding {ev:'uit'|'fout', id, b64} en
 *                                         {ev:'einde', id, code, signaal}. brein: alleen claude of codex (vaste paden);
 *                                         cwd binnen de vault of io; env zonder pod-sleutels (anders fout env-geweigerd).
 *   invoer {id, b64?|tekst?, einde?}    → stdin van een lopende job
 *   stop {id, signaal?}                 → kill(-pgid): server.js mag een 1002-proces zelf niet signaleren
 *   volg {id, vanaf_uit?, vanaf_fout?}  → buffer vanaf die offset nasturen, daarna live (na een herstart van server.js)
 *   lijst                               → lopende en < 10 min geleden afgeronde jobs (zonder inhoud)
 *   leeft {pid, naam, waarde?} | {naam, waarde}
 *                                       → vervangt het lezen van /proc/<pid>/environ door server.js (Fable #3): leeft het
 *                                         1002-proces en draagt het naam=waarde? Zonder waarde: de waarde van die marker.
 *                                         Zonder pid: alle 1002-processen met die marker (pid, ppid). Alleen SOCEV_-markers.
 *   stat {pad} | map {pad} | lees {pad, vanaf?, max?}
 *                                       → alleen binnen socev-thuis/.claude/projects en socev-thuis/.codex/sessions
 *                                         (transcripts zijn 0600 en voor server.js anders onleesbaar)
 * Logt nooit inhoud (geen args, env, invoer of uitvoer); alleen op, id, pid, code. Geen eigen netwerk.
 */
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const VERSIE = 'wv699-1';
const VAULT = process.env.SOCEV_LOPER_VAULT || '/opt/data/AI_SecondBrain';
const IO = process.env.SOCEV_LOPER_IO || '/opt/data/io';
const THUIS = process.env.SOCEV_LOPER_THUIS || '/opt/data/socev-thuis';
// Vaste paden; alleen de toets (test/socev-loper.sh) zet ze anders, via de omgeving die root meegeeft.
const BREINEN = process.env.SOCEV_LOPER_BREINEN ? JSON.parse(process.env.SOCEV_LOPER_BREINEN)
  : { claude: '/usr/local/bin/claude', codex: '/usr/local/bin/codex' };
const LEESBAAR = [path.join(THUIS, '.claude', 'projects'), path.join(THUIS, '.codex', 'sessions')];
const MAX_REGEL = 8 * 1024 * 1024;        // verzoekregel (de prompt kan in args staan)
const MAX_BUF = 64 * 1024 * 1024;         // uitvoerbuffer per stroom per job
const MAX_LOPEND = 16;
const NA_EINDE_MS = 10 * 60 * 1000;
const MAX_LEES = 8 * 1024 * 1024;
// Pod-sleutels komen nooit in een 1002-gesprek, ook niet als server.js zich vergist (verdediging in de diepte). Ook de
// Supabase-MCP (kluis = bunq) niet: een 1002-proces kan de omgeving van zijn zustergesprekken lezen (Fable #9).
const ENV_VERBODEN = /^(POD_BOOTSTRAP_SECRET|API_SECRET|N8N_API_KEY|N8N_MCP_TOKEN|SUPABASE_SERVICE_ROLE\w*|SUPABASE_MCP_TOKEN|SUPABASE_ACCESS_TOKEN|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_API_TOKEN|TELEGRAM_\w*|TG_TOKEN|GITHUB_\w*|GH_TOKEN|VAULT_BACKUP_\w*|BUNQ\w*|ENABLE_BANKING\w*|AGENT_WEBHOOK_SECRET|GEMINI_\w*|GOOGLE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|SECRETS_GELADEN|NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH)$/;
const MARKER = /^SOCEV_[A-Z0-9_]{1,40}$/;
const WAARDE = /^[A-Za-z0-9._:@\/-]{1,200}$/;
const SIGNALEN = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGQUIT']);
const EIGEN_UID = typeof process.getuid === 'function' ? process.getuid() : -1;

const jobs = new Map();   // id -> job
const sinds = Date.now();
function log(t) { process.stderr.write(new Date().toISOString() + ' socev-loper: ' + t + '\n'); }

function binnen(p, wortel) { return p === wortel || p.indexOf(wortel + '/') === 0; }
function echtPad(p) { try { return fs.realpathSync(p); } catch (e) { return null; } }
function lopend() { let n = 0; jobs.forEach(function (j) { if (!j.klaar) n++; }); return n; }

function opruimen() {
  const nu = Date.now();
  jobs.forEach(function (j, id) { if (j.klaar && nu - j.klaar > NA_EINDE_MS) jobs.delete(id); });
}
setInterval(opruimen, 60 * 1000).unref();

function stuur(sock, obj) {
  if (!sock || sock.destroyed) return;
  try { sock.write(JSON.stringify(obj) + '\n'); } catch (e) { /* verbinding weg: de job loopt door, volg kan hem terughalen */ }
}
function voegToe(j, stroom, chunk) {
  const b = j[stroom];
  if (b.lengte + chunk.length <= MAX_BUF) { b.delen.push(chunk); b.lengte += chunk.length; } else b.afgekapt = true;
  b.totaal += chunk.length;
  const ev = { ev: stroom, id: j.id, b64: chunk.toString('base64') };
  j.volgers.forEach(function (s) { stuur(s, ev); });
}
function bufferVanaf(b, vanaf) {
  const alles = Buffer.concat(b.delen, b.lengte);
  return vanaf > 0 ? alles.subarray(Math.min(vanaf, alles.length)) : alles;
}
function jobInfo(j) {
  return { id: j.id, pid: j.pid, brein: j.brein, gestart: j.gestart, klaar: j.klaar || null, code: j.code, signaal: j.signaal,
    uit_bytes: j.uit.totaal, fout_bytes: j.fout.totaal, afgekapt: j.uit.afgekapt || j.fout.afgekapt };
}

function opStart(v, sock) {
  if (typeof v.id !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(v.id)) return { fout: 'id-ongeldig' };
  const oud = jobs.get(v.id);
  if (oud && !oud.klaar) return { fout: 'id-loopt-al' };
  if (lopend() >= MAX_LOPEND) return { fout: 'te-veel-lopend' };
  const bin = Object.prototype.hasOwnProperty.call(BREINEN, v.brein) ? BREINEN[v.brein] : null;
  if (!bin) return { fout: 'brein-geweigerd' };
  const args = Array.isArray(v.args) ? v.args : [];
  if (!args.every(function (a) { return typeof a === 'string' && a.indexOf('\0') < 0; })) return { fout: 'args-ongeldig' };
  const cwd = echtPad(typeof v.cwd === 'string' ? v.cwd : '');
  if (!cwd || !(binnen(cwd, VAULT) || binnen(cwd, IO))) return { fout: 'cwd-geweigerd' };
  const env = {};
  const geweigerd = [];
  const bron = v.env && typeof v.env === 'object' ? v.env : {};
  Object.keys(bron).forEach(function (k) {
    const w = bron[k];
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(k) || typeof w !== 'string' || w.indexOf('\0') >= 0) { geweigerd.push(k.slice(0, 40)); return; }
    if (ENV_VERBODEN.test(k)) { geweigerd.push(k); return; }
    env[k] = w;
  });
  if (geweigerd.length) return { fout: 'env-geweigerd', namen: geweigerd };
  // Eigen plek; wat server.js hierover meestuurt telt niet.
  env.HOME = THUIS; env.TMPDIR = path.join(THUIS, 'tmp'); env.CODEX_HOME = path.join(THUIS, '.codex');
  env.USER = 'socev'; env.LOGNAME = 'socev'; env.SHELL = '/bin/bash';
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  let kind;
  try {
    kind = spawn(bin, args, { cwd: cwd, env: env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) { return { fout: 'spawn-mislukt', code: e.code || null }; }
  const j = { id: v.id, brein: v.brein, pid: kind.pid || null, kind: kind, gestart: Date.now(), klaar: 0, code: null, signaal: null,
    uit: { delen: [], lengte: 0, totaal: 0, afgekapt: false }, fout: { delen: [], lengte: 0, totaal: 0, afgekapt: false },
    volgers: new Set([sock]) };
  jobs.set(v.id, j);
  kind.stdout.on('data', function (c) { voegToe(j, 'uit', c); });
  kind.stderr.on('data', function (c) { voegToe(j, 'fout', c); });
  kind.stdin.on('error', function () { /* kind sloot stdin */ });
  kind.on('error', function (e) {
    if (j.klaar) return;
    j.klaar = Date.now(); j.code = null; j.signaal = null;
    log('fout id=' + j.id + ' ' + (e.code || 'onbekend'));
    j.volgers.forEach(function (s) { stuur(s, { ev: 'einde', id: j.id, code: null, signaal: null, fout: e.code || 'spawn' }); });
  });
  kind.on('close', function (code, signaal) {
    if (j.klaar) return;
    j.klaar = Date.now(); j.code = code; j.signaal = signaal;
    log('einde id=' + j.id + ' pid=' + j.pid + ' code=' + code + ' signaal=' + signaal + ' ms=' + (j.klaar - j.gestart));
    j.volgers.forEach(function (s) { stuur(s, { ev: 'einde', id: j.id, code: code, signaal: signaal }); });
  });
  if (typeof v.invoer === 'string') { kind.stdin.end(v.invoer); }
  log('start id=' + j.id + ' pid=' + j.pid + ' brein=' + v.brein);
  return { id: j.id, pid: j.pid };
}

function opInvoer(v) {
  const j = jobs.get(v.id);
  if (!j || j.klaar) return { fout: 'onbekende-job' };
  const data = typeof v.b64 === 'string' ? Buffer.from(v.b64, 'base64') : (typeof v.tekst === 'string' ? Buffer.from(v.tekst) : null);
  if (data && data.length) j.kind.stdin.write(data);
  if (v.einde) j.kind.stdin.end();
  return {};
}

function opStop(v) {
  const j = jobs.get(v.id);
  if (!j) return { fout: 'onbekende-job' };
  if (j.klaar || !j.pid) return { al_klaar: true };
  const sig = SIGNALEN.has(v.signaal) ? v.signaal : 'SIGTERM';
  try { process.kill(-j.pid, sig); } catch (e) { try { process.kill(j.pid, sig); } catch (e2) { return { fout: 'kill-mislukt', code: e2.code || null }; } }
  log('stop id=' + j.id + ' signaal=' + sig);
  return { signaal: sig };
}

function opVolg(v, sock) {
  const j = jobs.get(v.id);
  if (!j) return { fout: 'onbekende-job' };
  const uit = bufferVanaf(j.uit, Number(v.vanaf_uit) || 0);
  const fout = bufferVanaf(j.fout, Number(v.vanaf_fout) || 0);
  // Eerst het antwoord, dan de buffer, dan live (of meteen het einde).
  setImmediate(function () {
    if (uit.length) stuur(sock, { ev: 'uit', id: j.id, b64: uit.toString('base64') });
    if (fout.length) stuur(sock, { ev: 'fout', id: j.id, b64: fout.toString('base64') });
    if (j.klaar) stuur(sock, { ev: 'einde', id: j.id, code: j.code, signaal: j.signaal });
    else j.volgers.add(sock);
  });
  return { job: jobInfo(j), afgekapt: j.uit.afgekapt || j.fout.afgekapt };
}

// /proc/<pid>/status: uid en ppid, zombie = dood (zoals weesLeeft in server.js).
function procStatus(pid) {
  try {
    const st = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
    return { uid: Number((/^Uid:\s+(\d+)/m.exec(st) || [])[1]), ppid: Number((/^PPid:\s+(\d+)/m.exec(st) || [])[1] || 0),
      dood: /^State:\s+[ZX]/m.test(st) };
  } catch (e) { return null; }
}
function markerWaarde(pid, naam) {
  let env;
  try { env = fs.readFileSync('/proc/' + pid + '/environ').toString('latin1'); } catch (e) { return undefined; }
  const delen = env.split('\0');
  for (let i = 0; i < delen.length; i++) if (delen[i].indexOf(naam + '=') === 0) return delen[i].slice(naam.length + 1);
  return undefined;
}
function opLeeft(v) {
  if (typeof v.naam !== 'string' || !MARKER.test(v.naam)) return { fout: 'naam-ongeldig' };
  if (v.waarde != null && (typeof v.waarde !== 'string' || !WAARDE.test(v.waarde))) return { fout: 'waarde-ongeldig' };
  if (v.pid != null) {
    if (!/^\d{1,9}$/.test(String(v.pid))) return { fout: 'pid-ongeldig' };
    const st = procStatus(v.pid);
    if (!st || st.dood || st.uid !== EIGEN_UID) return { leeft: false };
    const w = markerWaarde(v.pid, v.naam);
    if (v.waarde != null) return { leeft: w === v.waarde };
    return { leeft: true, waarde: w !== undefined && WAARDE.test(w) ? w : null };
  }
  if (v.waarde == null) return { fout: 'waarde-nodig' };
  const uit = [];
  let namen = [];
  try { namen = fs.readdirSync('/proc'); } catch (e) { return { fout: 'proc-onleesbaar' }; }
  namen.forEach(function (p) {
    if (!/^\d+$/.test(p) || Number(p) === process.pid) return;
    const st = procStatus(p);
    if (!st || st.dood || st.uid !== EIGEN_UID) return;
    if (markerWaarde(p, v.naam) === v.waarde) uit.push({ pid: Number(p), ppid: st.ppid });
  });
  return { pids: uit };
}

function leesbaarPad(p) {
  if (typeof p !== 'string' || !p) return null;
  const echt = echtPad(p);
  if (!echt) return null;
  for (let i = 0; i < LEESBAAR.length; i++) {
    const w = echtPad(LEESBAAR[i]);
    if (w && binnen(echt, w)) return echt;
  }
  return null;
}
function opStat(v) {
  const p = leesbaarPad(v.pad);
  if (!p) return { fout: 'pad-geweigerd' };
  try { const st = fs.statSync(p); return { grootte: st.size, mtime_ms: st.mtimeMs, map: st.isDirectory() }; }
  catch (e) { return { fout: 'stat-mislukt', code: e.code || null }; }
}
function opMap(v) {
  const p = leesbaarPad(v.pad);
  if (!p) return { fout: 'pad-geweigerd' };
  try {
    return { namen: fs.readdirSync(p, { withFileTypes: true }).slice(0, 5000).map(function (d) { return { naam: d.name, map: d.isDirectory() }; }) };
  } catch (e) { return { fout: 'map-mislukt', code: e.code || null }; }
}
function opLees(v) {
  const p = leesbaarPad(v.pad);
  if (!p) return { fout: 'pad-geweigerd' };
  const vanaf = Math.max(0, Number(v.vanaf) || 0);
  const max = Math.min(MAX_LEES, Math.max(1, Number(v.max) || 4 * 1024 * 1024));
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { fout: 'geen-bestand' };
    const n = Math.max(0, Math.min(max, st.size - vanaf));
    const buf = Buffer.alloc(n);
    const gelezen = n ? fs.readSync(fd, buf, 0, n, vanaf) : 0;
    return { b64: buf.subarray(0, gelezen).toString('base64'), grootte: st.size, mtime_ms: st.mtimeMs, vanaf: vanaf };
  } catch (e) { return { fout: 'lees-mislukt', code: e.code || null }; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {} }
}

function behandel(v, sock) {
  switch (v.op) {
    case 'ping': return { uid: EIGEN_UID, gid: typeof process.getgid === 'function' ? process.getgid() : -1, pid: process.pid, versie: VERSIE, lopend: lopend(), sinds: sinds };
    case 'start': return opStart(v, sock);
    case 'invoer': return opInvoer(v);
    case 'stop': return opStop(v);
    case 'volg': return opVolg(v, sock);
    case 'lijst': { const l = []; jobs.forEach(function (j) { l.push(jobInfo(j)); }); return { jobs: l }; }
    case 'leeft': return opLeeft(v);
    case 'stat': return opStat(v);
    case 'map': return opMap(v);
    case 'lees': return opLees(v);
    default: return { fout: 'onbekende-op' };
  }
}

function verbinding(sock) {
  let rest = '';
  sock.setEncoding('utf8');
  sock.on('data', function (d) {
    rest += d;
    if (rest.length > MAX_REGEL && rest.indexOf('\n') < 0) { stuur(sock, { ok: false, fout: 'regel-te-lang' }); sock.destroy(); return; }
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      const regel = rest.slice(0, i); rest = rest.slice(i + 1);
      if (!regel.trim()) continue;
      let v;
      try { v = JSON.parse(regel); } catch (e) { stuur(sock, { ok: false, fout: 'geen-json' }); continue; }
      if (!v || typeof v !== 'object') { stuur(sock, { ok: false, fout: 'geen-object' }); continue; }
      let r;
      try { r = behandel(v, sock) || {}; } catch (e) { r = { fout: 'intern' }; log('interne fout op=' + String(v.op).slice(0, 20) + ' ' + (e && e.code || '')); }
      const antwoord = Object.assign({ nr: v.nr === undefined ? null : v.nr, ok: !r.fout }, r);
      stuur(sock, antwoord);
    }
  });
  sock.on('error', function () {});
  sock.on('close', function () { jobs.forEach(function (j) { j.volgers.delete(sock); }); });
}

function afsluiten(sig) {
  // Lopende gesprekken verliezen hun pijp toch; netjes stoppen in plaats van ze als wees te laten schrijven.
  jobs.forEach(function (j) { if (!j.klaar && j.pid) { try { process.kill(-j.pid, 'SIGTERM'); } catch (e) {} } });
  log('gestopt (' + sig + ')');
  process.exit(0);
}
process.on('SIGTERM', function () { afsluiten('SIGTERM'); });
process.on('SIGINT', function () { afsluiten('SIGINT'); });

if (require.main === module) {
  process.umask(0o077);
  const fd = Number(process.env.SOCEV_LOPER_FD || 3);
  const server = net.createServer(verbinding);
  server.on('error', function (e) { log('socketfout ' + (e.code || '')); process.exit(1); });
  server.listen({ fd: fd }, function () { log('klaar uid=' + EIGEN_UID + ' versie=' + VERSIE); });
}
module.exports = { _toets: { markerWaarde: markerWaarde, ENV_VERBODEN: ENV_VERBODEN } };
