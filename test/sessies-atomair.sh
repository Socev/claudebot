#!/usr/bin/env bash
# Toetst (wv3548, actieplan 2B04, 20-11-2026) dat het gespreksregister (home/chat_sessions.json, ± 67 sessies: hoofd,
# machinekamer, wachters) veilig wordt weggeschreven en dat een fout zichtbaar wordt. Vroeger: saveSessions() schreef met
# writeFileSync in place en slikte elke fout; bij de opstart begon een onleesbaar register stil met nul sessies.
# Draait de ECHTE server.js als los proces met een preload die fs-aanroepen op het register telt en een schrijffout kan nabootsen.
#  A  half register bij de opstart: logregel sessies-onleesbaar + .onleesbaar-kopie met de oude inhoud
#  A2 leesbaar maar geen object (array): ook onleesbaar (logregel Vormfout), daarna een object
#  B  saveSessions schrijft nooit rechtstreeks op chat_sessions.json, wel via rename
#  C  schijffout midden in het schrijven: het vorige goede register blijft staan, logregel, geen .tmp achter
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'sessatomair-'));
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra && !ok ? '  [' + extra + ']' : '')); if (!ok) fout++; };
const slaap = ms => new Promise(r => setTimeout(r, ms));
const PRE = path.join(W, 'preload.js'), TEL = path.join(W, 'telling.json'), FAAL = path.join(W, 'faal-schrijven');
// preload: telt directe schrijfacties op het register; bestaat FAAL, dan schrijft elke writeFileSync naar (een tmp van) het
// register maar de helft en gooit ENOSPC (schijf vol midden in het schrijven).
fs.writeFileSync(PRE, `
const fs = require('fs'), path = require('path');
const doel = path.join(process.env.HOME, 'chat_sessions.json'), tel = { direct: 0, rename: 0 };
const res = p => { try { return path.resolve(String(p)); } catch (e) { return ''; } };
const zelfde = p => res(p) === doel;
const familie = p => res(p).indexOf(doel) === 0 && res(p).indexOf('.onleesbaar-') < 0;
const ws = fs.writeFileSync, as = fs.appendFileSync, os_ = fs.openSync, rs = fs.renameSync;
const bewaar = () => { try { ws.call(fs, ${JSON.stringify(TEL)}, JSON.stringify(tel)); } catch (e) {} };
fs.writeFileSync = function (p, data) {
  if (zelfde(p)) { tel.direct++; bewaar(); }
  if (familie(p) && fs.existsSync(${JSON.stringify(FAAL)})) {
    const s = String(data); ws.call(fs, p, s.slice(0, Math.floor(s.length / 2)));
    const e = new Error('ENOSPC: no space left on device, write'); e.code = 'ENOSPC'; throw e;
  }
  return ws.apply(fs, arguments);
};
fs.appendFileSync = function (p) { if (zelfde(p)) { tel.direct++; bewaar(); } return as.apply(fs, arguments); };
fs.openSync = function (p, v) { if (zelfde(p) && v && v !== 'r') { tel.direct++; bewaar(); } return os_.apply(fs, arguments); };
fs.renameSync = function (a, b) { const r = rs.apply(fs, arguments); if (zelfde(b)) { tel.rename++; bewaar(); } return r; };
`);
const hook = http.createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => {
  if (q.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return s.end(JSON.stringify([{ actieve_kant: 'olares', sinds: null }]));
  s.end('{}'); }); });
hook.listen(0, '127.0.0.1', async () => {
  const d = path.join(W, 'pod'), home = path.join(d, 'home'), REG = path.join(home, 'chat_sessions.json'), LOG = path.join(d, 'api.log');
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach(m => fs.mkdirSync(path.join(d, m), { recursive: true }));
  fs.copyFileSync('server.js', path.join(d, 'server.js'));
  const poort = vrijePoort();
  const env = Object.assign({}, process.env, {
    HOME: home, VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'),
    APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: path.join(d, 'app-data'), APP_UIT_BESTAND: path.join(d, 'app-uit'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: LOG, SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    UITROL_MARKER: path.join(d, 'uitrol-wacht'), ROL_BESTAND: path.join(d, 'rol'),
    SUPABASE_URL: 'http://127.0.0.1:' + hook.address().port, SUPABASE_SERVICE_ROLE: 'proef', SOCEV_KANT: 'olares',
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef',
    PORT: String(poort), AGENT_WEBHOOK_URL: 'http://127.0.0.1:' + hook.address().port + '/', AGENT_WEBHOOK_SECRET: 'proef' });
  delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.SOCEV_AGENT_RUN;
  const out = fs.openSync(path.join(W, 'server.out'), 'a');
  const start = () => spawn(process.execPath, ['-r', PRE, path.join(d, 'server.js')], { cwd: d, env: env, stdio: ['ignore', out, out] });
  const vraag = (methode, pad, body) => new Promise((ok, nok) => { const r = http.request({ host: '127.0.0.1', port: poort, path: pad, method: methode, headers: { 'content-type': 'application/json' } },
    res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { ok({ raw: b }); } }); }); r.on('error', nok); r.end(body ? JSON.stringify(body) : undefined); });
  const wacht = async () => { for (let i = 0; i < 100; i++) { try { await vraag('GET', '/health'); return true; } catch (e) { await slaap(100); } } return false; };
  const stop = async (k) => { if (!k || k.exitCode !== null) return; k.kill('SIGTERM'); for (let i = 0; i < 50 && k.exitCode === null; i++) await slaap(100); if (k.exitCode === null) k.kill('SIGKILL'); };
  const log = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
  const kopieen = () => fs.readdirSync(home).filter(n => /^chat_sessions\.json\.onleesbaar-/.test(n));
  // verzonnen sessies (geen echte chat-id's)
  const reg = {}; for (let i = 0; i < 70; i++) reg['proef' + i] = '00000000-0000-4000-8000-' + String(i).padStart(12, '0');
  const reset = id => vraag('POST', '/reset', { secret: 'proef', chat_id: id, workspace: 'vault' });
  let srv = null;
  try {
    // A: half register bij de opstart
    const half = JSON.stringify(reg).slice(0, 700);
    fs.writeFileSync(REG, half);
    srv = start();
    toets('A server start met half register', await wacht());
    await slaap(300);
    toets('A logregel sessies-onleesbaar', /fout waar=sessies-onleesbaar/.test(log()), log().split('\n').slice(-4).join(' | '));
    const k = kopieen();
    toets('A half register bewaard als .onleesbaar-kopie', k.length === 1 && fs.readFileSync(path.join(home, k[0]), 'utf8') === half, fs.readdirSync(home).join(','));
    await stop(srv); k.forEach(n => fs.unlinkSync(path.join(home, n)));
    // A2: leesbaar maar geen object
    fs.writeFileSync(REG, '[]');
    srv = start();
    toets('A2 server start met array als register', await wacht());
    await slaap(300);
    toets('A2 logregel Vormfout', /sessies-onleesbaar name=Vormfout/.test(log()), log().split('\n').slice(-4).join(' | '));
    await reset('proef-a2');
    let na = null; try { na = JSON.parse(fs.readFileSync(REG, 'utf8')); } catch (e) {}
    toets('A2 na een save is het register een object', !!na && typeof na === 'object' && !Array.isArray(na), JSON.stringify(na));
    await stop(srv); kopieen().forEach(n => fs.unlinkSync(path.join(home, n)));
    // B: goed register, save via rename
    fs.writeFileSync(REG, JSON.stringify(reg));
    try { fs.unlinkSync(TEL); } catch (e) {}
    srv = start();
    toets('B server start met goed register', await wacht());
    const r = await reset('proef0');
    toets('B /reset ok', r && r.ok === true, JSON.stringify(r));
    const t = fs.existsSync(TEL) ? JSON.parse(fs.readFileSync(TEL, 'utf8')) : { direct: 0, rename: 0 };
    toets('B geen directe schrijfactie op chat_sessions.json', t.direct === 0, JSON.stringify(t));
    toets('B register via rename vervangen', t.rename > 0, JSON.stringify(t));
    const naB = JSON.parse(fs.readFileSync(REG, 'utf8'));
    toets('B reset wist alleen de eigen sessie', !naB['proef0'] && Object.keys(naB).length === 69, Object.keys(naB).length + '');
    // C: schijffout midden in het schrijven
    const voor = fs.readFileSync(REG, 'utf8');
    fs.writeFileSync(FAAL, '1');
    await reset('proef1');
    fs.unlinkSync(FAAL);
    const naC = fs.readFileSync(REG, 'utf8');
    let leesbaar = true; try { JSON.parse(naC); } catch (e) { leesbaar = false; }
    toets('C vorige goede register blijft staan na schijffout', leesbaar && naC === voor, 'lengte ' + naC.length + ' vs ' + voor.length);
    toets('C logregel sessies-schrijven', /fout waar=sessies-schrijven .*code=ENOSPC/.test(log()), log().split('\n').slice(-4).join(' | '));
    toets('C geen achtergebleven .tmp-bestanden', fs.readdirSync(home).filter(n => /^chat_sessions\.json\.tmp/.test(n)).length === 0, fs.readdirSync(home).join(','));
    // en de volgende save lukt weer (sessie proef1 alsnog weg)
    await reset('proef2');
    const naD = JSON.parse(fs.readFileSync(REG, 'utf8'));
    toets('C volgende save na de fout lukt weer', !naD['proef1'] && !naD['proef2'] && Object.keys(naD).length === 67, Object.keys(naD).length + '');
  } catch (e) { toets('uitzondering', false, String(e && e.stack || e)); }
  await stop(srv);
  hook.close();
  try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {}
  console.log(fout ? 'ROOD: ' + fout + ' fout(en)' : 'ALLES GROEN');
  process.exit(fout ? 1 : 0);
});
JS
