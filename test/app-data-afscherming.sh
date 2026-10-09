#!/usr/bin/env bash
# Toetst (wv318, 9-10-2026) dat een proefkopie van server.js nooit de echte app-data raakt. Aanleiding: toetsen startten
# een kopie zonder APP_DATA_DIR; die erfde via de agentshell RELEASE_DIR en PORT=8080, viel terug op
# /opt/data/socev-app-data, herschreef sessies.json en schreef 22 sessies-herstart-regels in de echte audit.
# A. De keuze (APP_ECHT) in een vm-context: alleen als dit bestand in RELEASE_DIR ligt, gelden de echte mappen.
# B. De ECHTE server.js als kopie op een losse poort, met de geërfde RELEASE_DIR en ZONDER APP_DATA_DIR enz.: hij schrijft
#    in /tmp/socev-app-proef-<pid>, en sessies.json, audit.jsonl en audit-voor-auth.jsonl van de echte map blijven gelijk.
# C. (wv349) Een kopie die ALLES erft zoals een handmatige proef: HOME=/opt/data, geen IO_DIR, JOBOUT_DIR, API_LOG,
#    ROL_BESTAND, UITROL_MARKER, RUNTIME_FILE, CODEX_HOME, SLEUTELPORTAAL_SLEUTEL en zonder de offsite-, auto- en
#    tunnelschakelaars. Elk pad buiten het app-blok wijst in /health naar de wegwerpmap; de proef leest de echte sessies en
#    agents niet, en /opt/data/io, /opt/data/joboutput, /tmp/agy-mcp_config.json, ~/.gemini en het rolbestand blijven gelijk.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), vm = require('vm');
const { spawn } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'app-afscherming-'));
let fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const src = fs.readFileSync('server.js', 'utf8');

// ── A. de keuze ──
const blok = src.slice(src.indexOf('const APP_ECHT = '), src.indexOf("const APP_UIT = "));
const R = path.join(W, 'releases', 'abc'); fs.mkdirSync(R, { recursive: true });
fs.symlinkSync(R, path.join(W, 'current'));
function kies(dir, env, metDirname) {
  const c = { fs, path, process: { env, pid: 4242 } };
  if (metDirname !== false) c.__dirname = dir;
  vm.createContext(c);
  vm.runInContext(blok + '\n;globalThis.__u = { echt: APP_ECHT, data: APP_DATA, log: appStandaard("/opt/data/app-log", "app-log") };', c);
  return c.__u;
}
let u = kies(R, { RELEASE_DIR: R });
toets('A1 release in RELEASE_DIR -> echte map', u.echt === true && u.data === '/opt/data/socev-app-data' && u.log === '/opt/data/app-log', JSON.stringify(u));
u = kies(R, { RELEASE_DIR: path.join(W, 'current') });
toets('A2 RELEASE_DIR via symlink naar dezelfde map -> echte map', u.echt === true, JSON.stringify(u));
u = kies(path.join(W, 'kopie'), { RELEASE_DIR: R });
toets('A3 kopie elders met geërfde RELEASE_DIR -> wegwerpmap', u.echt === false && u.data === '/tmp/socev-app-proef-4242/data' && u.log === '/tmp/socev-app-proef-4242/app-log', JSON.stringify(u));
u = kies(R, {});
toets('A4 zonder RELEASE_DIR -> wegwerpmap', u.echt === false && /^\/tmp\/socev-app-proef-/.test(u.data), JSON.stringify(u));
u = kies(R, { RELEASE_DIR: path.join(W, 'bestaat-niet') });
toets('A5 RELEASE_DIR bestaat niet -> wegwerpmap (fail-closed)', u.echt === false, JSON.stringify(u));
u = kies(R, { RELEASE_DIR: R }, false);
toets('A6 geen __dirname (vm-toets) -> wegwerpmap', u.echt === false, JSON.stringify(u));
u = kies(path.join(W, 'kopie'), { RELEASE_DIR: R, APP_DATA_DIR: '/x/eigen' });
toets('A7 eigen APP_DATA_DIR gaat altijd voor', u.data === '/x/eigen', JSON.stringify(u));
// wv349: dezelfde keuze bovenaan server.js, voor HOME, IO, JOBOUT enz. (buiten het app-blok)
const vroeg = src.slice(src.indexOf('const SERVER_ECHT = '), src.indexOf('const MAX_FILE = '));
function vroegKies(dir, env) {
  const c = { fs, path, process: { env, pid: 4242 }, __dirname: dir };
  vm.createContext(c);
  vm.runInContext(vroeg + '\n;globalThis.__u = { echt: SERVER_ECHT, home: HOME, io: IO, rol: serverPad("rol", process.env.ROL_BESTAND, serverEchteHome("bin", "uitwijk-rol"), path.join(HOME, "bin", "uitwijk-rol")) };', c);
  return c.__u;
}
u = vroegKies(R, { RELEASE_DIR: R, HOME: '/opt/data' });
toets('A8 productie: HOME uit env, IO standaard', u.echt === true && u.home === '/opt/data' && u.io === '/opt/data/io' && u.rol === '/opt/data/bin/uitwijk-rol', JSON.stringify(u));
u = vroegKies(path.join(W, 'kopie'), { RELEASE_DIR: R, HOME: '/opt/data', IO_DIR: '/opt/data/io/' });
toets('A9 proef met geërfde HOME en IO_DIR naar het echte pad -> wegwerpmap', u.echt === false && u.home === '/tmp/socev-app-proef-4242/home' &&
  u.io === '/tmp/socev-app-proef-4242/io' && u.rol === '/tmp/socev-app-proef-4242/home/bin/uitwijk-rol', JSON.stringify(u));
u = vroegKies(path.join(W, 'kopie'), { RELEASE_DIR: R, HOME: '/x/h', IO_DIR: '/x/io', ROL_BESTAND: '/opt/data/bin/uitwijk-rol' });
toets('A10 proef met eigen HOME/IO houdt die; ROL_BESTAND naar het echte pad niet', u.home === '/x/h' && u.io === '/x/io' && u.rol === '/x/h/bin/uitwijk-rol', JSON.stringify(u));
u = vroegKies(R, { RELEASE_DIR: R, HOME: '/opt/data', IO_DIR: '/x/io' });
toets('A11 productie houdt een eigen IO_DIR', u.echt === true && u.io === '/x/io', JSON.stringify(u));
const appVroeg = src.slice(src.indexOf('const SERVER_ECHT = '), src.indexOf('const MAX_FILE = ')) + '\n' + blok;
u = (function () { const c = { fs, path, process: { env: { RELEASE_DIR: R, HOME: '/opt/data' }, pid: 4242 }, __dirname: path.join(W, 'kopie') }; vm.createContext(c);
  vm.runInContext(appVroeg + '\n;globalThis.__u = { echt: APP_ECHT, data: APP_DATA, proef: SERVER_PROEF };', c); return c.__u; })();
toets('A12 app-blok neemt SERVER_ECHT en de proefmap over', u.echt === false && u.data === u.proef + '/data', JSON.stringify(u));

// ── B. een echte proefserver ──
const ECHT = '/opt/data/socev-app-data';
const echte = ['sessies.json', 'audit.jsonl', 'audit-voor-auth.jsonl'].map((n) => path.join(ECHT, n));
const stand = () => echte.map((f) => { try { const s = fs.statSync(f); return s.size + '@' + s.mtimeMs; } catch (e) { return 'geen'; } }).join(' ');
const d = path.join(W, 'srv');
['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
fs.copyFileSync('server.js', path.join(d, 'server.js'));
const poort = vrijePoort();
const env = Object.assign({}, process.env, {
  HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'),
  JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
  RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
  UITROL_MARKER: path.join(d, 'uitrol-wacht'), ROL_BESTAND: path.join(d, 'rol'),
  OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', TUNNEL_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', PORT: String(poort),
  RELEASE_DIR: process.env.RELEASE_DIR || '/opt/data/app/current'   // zoals geërfd uit de agentshell
});
['APP_DATA_DIR', 'APP_LOG_DIR', 'APP_BESTANDEN_DIR', 'APP_UIT_BESTAND', 'TEL_UIT_BESTAND', 'APP_UPLOAD_DIR',
  'AGENT_WEBHOOK_URL', 'SOCEV_AGENT_RUN', 'CLOUDFLARE_TUNNEL_TOKEN_OLARES'].forEach((k) => delete env[k]);
// geen echte sleutels in de proef (Fable wv318 #4): anders ruimt hij bv. echte chat_log-rijen op of leest hij de echte Supabase
Object.keys(env).filter((k) => /TOKEN|KEY|SECRET|SERVICE_ROLE|SUPABASE|N8N_|TELEGRAM|WACHTWOORD|SLEUTEL|SESSIE|ANON/.test(k) && k !== 'SLEUTELPORTAAL_SLEUTEL').forEach((k) => delete env[k]);
const voor = stand();
const p = spawn(process.execPath, [path.join(d, 'server.js')], { cwd: d, env, detached: true, stdio: ['ignore', fs.openSync(path.join(d, 'stdout.log'), 'a'), fs.openSync(path.join(d, 'stdout.log'), 'a')] });
const PROEF = '/tmp/socev-app-proef-' + p.pid;
function req(methode, pad) {
  return new Promise((ok, nok) => {
    const r = http.request({ host: '127.0.0.1', port: poort, path: pad, method: methode }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => ok({ s: res.statusCode, b })); });
    r.on('error', nok); r.end();
  });
}
// ── C. een proef die alles erft ──
const C = {};
function lijst(map) {   // naam@mtime van elk item op het hoogste niveau (alleen lezen)
  try { return fs.readdirSync(map).sort().map((n) => { try { return n + '@' + fs.lstatSync(path.join(map, n)).mtimeMs; } catch (e) { return n + '@weg'; } }); }
  catch (e) { return ['(' + e.code + ')']; }
}
function verschil(voor, na) {   // nieuwe items mag productie maken; weg of gewijzigd telt
  const n = new Set(na); return voor.filter((x) => !n.has(x));
}
function mt(f) { try { const st = fs.lstatSync(f); return st.size + '@' + st.mtimeMs; } catch (e) { return 'geen'; } }
function rolRegel() { try { return (/^rol=.*$/m.exec(fs.readFileSync('/opt/data/bin/uitwijk-rol', 'utf8')) || [''])[0]; } catch (e) { return 'geen'; } }
async function deelC() {
  const dc = path.join(W, 'srv-c'); fs.mkdirSync(dc, { recursive: true });
  fs.copyFileSync('server.js', path.join(dc, 'server.js'));
  const poortC = vrijePoort();
  const envC = Object.assign({}, process.env, { HOME: '/opt/data', API_SECRET: 'proef', PORT: String(poortC), LESSEN_INJECTIE: '0',
    RELEASE_DIR: process.env.RELEASE_DIR || '/opt/data/app/current' });
  ['IO_DIR', 'JOBOUT_DIR', 'API_LOG', 'ROL_BESTAND', 'UITROL_MARKER', 'RUNTIME_FILE', 'CODEX_HOME', 'SLEUTELPORTAAL_SLEUTEL', 'AGY_MCP_TMP',
    'OFFSITE_INTERVAL_MIN', 'OFFSITE_SCRIPT', 'OFFSITE_BACKUP_LOG', 'AUTO_UIT_POD', 'AUTO_DIR', 'AUTO_CONFIG', 'AUTO_LOG',
    'TUNNEL_UIT_POD', 'TUNNEL_BIN', 'TUNNEL_LOG', 'TUNNEL_UIT_BESTAND',
    'APP_DATA_DIR', 'APP_LOG_DIR', 'APP_BESTANDEN_DIR', 'APP_UIT_BESTAND', 'TEL_UIT_BESTAND', 'APP_UPLOAD_DIR',
    'AGENT_WEBHOOK_URL', 'SOCEV_AGENT_RUN', 'CLOUDFLARE_TUNNEL_TOKEN_OLARES'].forEach((k) => delete envC[k]);
  Object.keys(envC).filter((k) => /TOKEN|KEY|SECRET|SERVICE_ROLE|SUPABASE|N8N_|TELEGRAM|WACHTWOORD|SLEUTEL|SESSIE|ANON/.test(k) && k !== 'API_SECRET').forEach((k) => delete envC[k]);
  const echteBestanden = ['/opt/data/chat_sessions.json', '/opt/data/agent_jobs.json', '/opt/data/runtime.json', '/tmp/agy-mcp_config.json',
    '/opt/data/.gemini/GEMINI.md', '/opt/data/.gemini/config/skills.json', '/opt/data/.gemini/config/mcp_config.json'];
  const voorIo = lijst('/opt/data/io'), voorJob = lijst('/opt/data/joboutput'), voorB = echteBestanden.map(mt).join(' '), voorRol = rolRegel();
  // twee mappen van een dode proef: een uur oud (moet weg) en vers (blijft)
  const dood = require('child_process').spawnSync('true').pid;
  const oudeMap = '/tmp/socev-app-proef-' + dood, verseMap = '/tmp/socev-app-proef-' + (dood + 1000000);
  fs.mkdirSync(oudeMap + '/home', { recursive: true }); fs.mkdirSync(verseMap, { recursive: true });
  const uurGeleden = new Date(Date.now() - 2 * 3600 * 1000); fs.utimesSync(oudeMap, uurGeleden, uurGeleden);
  const pc = spawn(process.execPath, [path.join(dc, 'server.js')], { cwd: dc, env: envC, detached: true, stdio: ['ignore', fs.openSync(path.join(dc, 'stdout.log'), 'a'), fs.openSync(path.join(dc, 'stdout.log'), 'a')] });
  C.pid = pc.pid;
  const PC = '/tmp/socev-app-proef-' + pc.pid;
  const reqC = (pad) => new Promise((ok, nok) => { const r = http.request({ host: '127.0.0.1', port: poortC, path: pad, method: 'GET' }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => ok({ s: res.statusCode, b })); }); r.on('error', nok); r.end(); });
  try {
    let h = null;
    for (let i = 0; i < 60; i++) { try { h = await reqC('/health'); break; } catch (e) { await slaap(200); } }
    toets('C0 proef die alles erft draait', h && h.s === 200, h && h.s);
    let hj = {}; try { hj = JSON.parse(h.b); } catch (e) {}
    const sp = (hj.server && hj.server.paden) || {};
    const buiten = Object.keys(sp).filter((k) => sp[k].indexOf(PC + '/') !== 0);
    toets('C1 /health: server.echt false, alle ' + Object.keys(sp).length + ' paden in ' + PC, hj.server && hj.server.echt === false && hj.server.proefmap === PC &&
      Object.keys(sp).length >= 18 && buiten.length === 0, buiten.map((k) => k + '=' + sp[k]).join(' ') || Object.keys(sp).join(','));
    toets('C2 home/io/jobout/api_log/rol/uitrol_marker in de wegwerpmap', sp.home === PC + '/home' && sp.io === PC + '/io' && sp.jobout === PC + '/joboutput' &&
      sp.api_log === PC + '/api.log' && sp.rol === PC + '/home/bin/uitwijk-rol' && sp.uitrol_marker === PC + '/uitrol-wacht', JSON.stringify(sp));
    toets('C3 leest de echte sessies niet (chats 0)', hj.chats === 0 && hj.sessies && hj.sessies.chats === 0, 'chats=' + hj.chats);
    toets('C4 app-blok in dezelfde wegwerpmap', hj.app && hj.app.echt === false && hj.app.data === PC + '/data', JSON.stringify(hj.app && hj.app.data));
    toets('C5 offsite, kastje en tunnel staan stil', hj.offsite && hj.offsite.ronde_bezig === false && !(hj.auto && hj.auto.pid) && !(hj.tunnel && hj.tunnel.pid),
      JSON.stringify({ o: hj.offsite && hj.offsite.laatste_overslag_reden, a: hj.auto && hj.auto.reden_uit, t: hj.tunnel && hj.tunnel.reden_uit }));
    toets('C5b oude map van een dode proef weg, verse blijft', !fs.existsSync(oudeMap) && fs.existsSync(verseMap), oudeMap + ' ' + fs.existsSync(oudeMap));
    fs.rmSync(verseMap, { recursive: true, force: true });
    const a = await reqC('/agents'); let aj = {}; try { aj = JSON.parse(a.b); } catch (e) {}
    const nAg = Array.isArray(aj.agents) ? aj.agents.length : (Array.isArray(aj) ? aj.length : (aj.totaal || 0));
    toets('C6 leest het echte agentregister niet', a.s === 200 && nAg === 0, a.s + ' ' + String(a.b).slice(0, 120));
    await slaap(17000);   // de eerste rolronde (15 s na een mislukte lezing) en de gemini-opzet zijn dan zeker langs geweest
    let api = ''; try { api = fs.readFileSync(PC + '/api.log', 'utf8'); } catch (e) {}
    toets('C7 eigen api.log met de proefregel', /proefserver /.test(api), api.split('\n').filter((r) => /proefserver/.test(r))[0]);
    let echtApi = ''; try { echtApi = fs.readFileSync('/opt/data/bin/api.log', 'utf8').slice(-2000000); } catch (e) {}
    toets('C8 niets in de echte api.log', echtApi.indexOf(PC) < 0);
    toets('C9 rolbestand in de wegwerpmap, het echte gelijk', fs.existsSync(PC + '/home/bin/uitwijk-rol') && rolRegel() === voorRol, voorRol + ' -> ' + rolRegel());
    const naB = echteBestanden.map(mt).join(' ');
    toets('C10 echte sessies, agents, runtime, agy-mcp en ~/.gemini onaangeroerd', naB === voorB, voorB + ' -> ' + naB);
    const wegIo = verschil(voorIo, lijst('/opt/data/io')), wegJob = verschil(voorJob, lijst('/opt/data/joboutput'));
    toets('C11 /opt/data/io: niets weg of gewijzigd (' + voorIo.length + ' items)', wegIo.length === 0, wegIo.join(' '));
    toets('C12 /opt/data/joboutput: niets weg of gewijzigd (' + voorJob.length + ' items)', wegJob.length === 0, wegJob.join(' '));
  } finally {
    try { process.kill(-pc.pid, 'SIGKILL'); } catch (e) {}
    await slaap(300);
    fs.rmSync(PC, { recursive: true, force: true });
  }
}
(async function () {
  try {
    let h = null;
    for (let i = 0; i < 60; i++) { try { h = await req('GET', '/health'); break; } catch (e) { await slaap(200); } }
    toets('B0 proefserver draait', h && h.s === 200, h && h.s);
    let hj = {}; try { hj = JSON.parse(h.b); } catch (e) {}
    toets('B0b /health meldt app.echt false en de wegwerpmap', hj.app && hj.app.echt === false && hj.app.data === PROEF + '/data', JSON.stringify(hj.app && { echt: hj.app.echt, data: hj.app.data }));
    // een paar app-routes zonder Access: weigeringen worden geaudit (audit-voor-auth) -> moeten in de wegwerpmap landen
    for (const pad of ['/app/', '/app/nieuw', '/app/sessie', '/tel/stand']) { try { await req('GET', pad); } catch (e) {} }
    await slaap(1500);
    let inhoud = []; try { inhoud = fs.readdirSync(path.join(PROEF, 'data')); } catch (e) {}
    toets('B1 app-data van de proef in ' + PROEF + '/data', inhoud.length > 0, inhoud.join(','));
    toets('B2 echte sessies.json en audits onaangeroerd', stand() === voor, voor + ' -> ' + stand());
    const bp = (hj.server && hj.server.paden) || {};
    toets('B3 eigen env buiten het app-blok gaat voor', hj.server && hj.server.echt === false && bp.io === path.join(d, 'io') &&
      bp.jobout === path.join(d, 'jobout') && bp.home === path.join(d, 'home') && bp.rol === path.join(d, 'rol'), JSON.stringify(bp));
    try { process.kill(-p.pid, 'SIGKILL'); } catch (e) {}
    await deelC();
  } catch (e) { toets('onverwachte fout', false, String(e && e.stack || e)); }
  finally {
    try { process.kill(-p.pid, 'SIGKILL'); } catch (e) {}
    await slaap(300);
    fs.rmSync(PROEF, { recursive: true, force: true });
    fs.rmSync('/tmp/socev-app-proef-4242', { recursive: true, force: true });   // A9/A12 maken daar home/ aan
    fs.rmSync(W, { recursive: true, force: true });
    console.log(fout ? 'ROOD: ' + fout + ' toets(en) mislukt' : 'GROEN: alles');
    process.exit(fout ? 1 : 0);
  }
})();
JS
