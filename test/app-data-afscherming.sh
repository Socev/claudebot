#!/usr/bin/env bash
# Toetst (wv318, 9-10-2026) dat een proefkopie van server.js nooit de echte app-data raakt. Aanleiding: toetsen startten
# een kopie zonder APP_DATA_DIR; die erfde via de agentshell RELEASE_DIR en PORT=8080, viel terug op
# /opt/data/socev-app-data, herschreef sessies.json en schreef 22 sessies-herstart-regels in de echte audit.
# A. De keuze (APP_ECHT) in een vm-context: alleen als dit bestand in RELEASE_DIR ligt, gelden de echte mappen.
# B. De ECHTE server.js als kopie op een losse poort, met de geërfde RELEASE_DIR en ZONDER APP_DATA_DIR enz.: hij schrijft
#    in /tmp/socev-app-proef-<pid>, en sessies.json, audit.jsonl en audit-voor-auth.jsonl van de echte map blijven gelijk.
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
  } catch (e) { toets('onverwachte fout', false, String(e && e.stack || e)); }
  finally {
    try { process.kill(-p.pid, 'SIGKILL'); } catch (e) {}
    await slaap(300);
    fs.rmSync(PROEF, { recursive: true, force: true });
    fs.rmSync(W, { recursive: true, force: true });
    console.log(fout ? 'ROOD: ' + fout + ' toets(en) mislukt' : 'GROEN: alles');
    process.exit(fout ? 1 : 0);
  }
})();
JS
