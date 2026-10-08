#!/usr/bin/env bash
# Toetst (wv223, 8-10-2026) dat het agentregister (home/agent_jobs.json) atomair wordt weggeschreven. Aanleiding: wv202
# gaf test/wees-agent.sh 1 op 4 keer "Unexpected end of JSON input": de toets las het register terwijl saveAgents() het
# met writeFileSync in place herschreef. In productie: een uitrol, OOM of SIGKILL midden in die schrijfactie laat een
# half register achter, en de opstart begon dan stil met een leeg register (foutcodes, wees-herkenning, 48-u-bewaring weg).
# Draait de ECHTE server.js als los proces met een nep-claude en een preload die fs-aanroepen op het register telt.
#  A  geen enkele writeFileSync/appendFileSync/openSync-voor-schrijven rechtstreeks op agent_jobs.json; wel renameSync erheen
#  B  een tweede proces leest het register honderden keren tijdens 12 agents met een groot register: nooit leeg of half
#  C  onleesbaar register bij de opstart: niet stil leeg, maar een logregel en het oude bestand bewaard naast het register
#  D  geen achtergebleven .tmp-bestanden
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'regatomair-'));
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra && !ok ? '  [' + extra + ']' : '')); if (!ok) fout++; };
const slaap = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(path.join(W, 'bin'));
fs.writeFileSync(path.join(W, 'bin', 'claude'), `#!/usr/bin/env node
process.stdout.on('error', () => {});
const a = process.argv.slice(2);
const sid = a.includes('--session-id') ? a[a.indexOf('--session-id') + 1] : 'x';
setTimeout(() => { process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'klaar', session_id: sid })); process.exit(0); }, 150);
`, { mode: 0o755 });
// preload: telt directe schrijfacties op het register (A)
const PRE = path.join(W, 'preload.js'), TEL = path.join(W, 'telling.json');
fs.writeFileSync(PRE, `
const fs = require('fs'), path = require('path');
const doel = path.join(process.env.HOME, 'agent_jobs.json'), tel = { direct: 0, rename: 0 };
const zelfde = p => { try { return path.resolve(String(p)) === doel; } catch (e) { return false; } };
const bewaar = () => { try { fs.__echtSchrijf(${JSON.stringify(TEL)}, JSON.stringify(tel)); } catch (e) {} };
fs.__echtSchrijf = fs.writeFileSync;
const ws = fs.writeFileSync, as = fs.appendFileSync, os_ = fs.openSync, rs = fs.renameSync;
fs.writeFileSync = function (p) { if (zelfde(p)) { tel.direct++; bewaar(); } return ws.apply(fs, arguments); };
fs.appendFileSync = function (p) { if (zelfde(p)) { tel.direct++; bewaar(); } return as.apply(fs, arguments); };
fs.openSync = function (p, v) { if (zelfde(p) && v && v !== 'r') { tel.direct++; bewaar(); } return os_.apply(fs, arguments); };
fs.renameSync = function (a, b) { const r = rs.apply(fs, arguments); if (zelfde(b)) { tel.rename++; bewaar(); } return r; };
`);
const hook = http.createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => {
  if (q.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return s.end(JSON.stringify([{ actieve_kant: 'olares', sinds: null }]));
  s.end('{}'); }); });
hook.listen(0, '127.0.0.1', async () => {
  const d = path.join(W, 'pod'), home = path.join(d, 'home'), REG = path.join(home, 'agent_jobs.json');
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach(m => fs.mkdirSync(path.join(d, m), { recursive: true }));
  fs.writeFileSync(path.join(d, 'server.js'), fs.readFileSync('server.js', 'utf8').split('const AGENT_START_SPREIDING_MS = 20 * 1000;').join('const AGENT_START_SPREIDING_MS = 100;'));
  const poort = 18671;
  const env = Object.assign({}, process.env, {
    HOME: home, VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'),
    APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    UITROL_MARKER: path.join(d, 'uitrol-wacht'), ROL_BESTAND: path.join(d, 'rol'),
    SUPABASE_URL: 'http://127.0.0.1:' + hook.address().port, SUPABASE_SERVICE_ROLE: 'proef', SOCEV_KANT: 'olares',
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '12',
    PORT: String(poort), AGENT_WEBHOOK_URL: 'http://127.0.0.1:' + hook.address().port + '/', AGENT_WEBHOOK_SECRET: 'proef',
    PATH: path.join(W, 'bin') + ':' + process.env.PATH });
  delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.SOCEV_AGENT_RUN;
  const out = fs.openSync(path.join(W, 'server.out'), 'a');
  const start = () => spawn(process.execPath, ['-r', PRE, path.join(d, 'server.js')], { cwd: d, env: env, stdio: ['ignore', out, out] });
  const vraag = (methode, pad, body) => new Promise((ok, nok) => { const r = http.request({ host: '127.0.0.1', port: poort, path: pad, method: methode, headers: { 'content-type': 'application/json' } },
    res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { ok({ raw: b }); } }); }); r.on('error', nok); r.end(body ? JSON.stringify(body) : undefined); });
  const wacht = async () => { for (let i = 0; i < 100; i++) { try { await vraag('GET', '/health'); return true; } catch (e) { await slaap(100); } } return false; };
  const stop = async (k) => { if (k.exitCode !== null) return; k.kill('SIGTERM'); for (let i = 0; i < 50 && k.exitCode === null; i++) await slaap(100); if (k.exitCode === null) k.kill('SIGKILL'); };
  let srv = null;
  try {
    // groot register (±250 afgeronde wv-jobs met lange labels): elke saveAgents schrijft dan >100 KB, het venster wordt ruim
    const reg = {}, nu = Date.now();
    for (let i = 0; i < 250; i++) reg['oud' + i] = { job_id: 'oud' + i, label: 'machinekamer:wv' + (500 + i) + ' ' + 'x'.repeat(300), status: 'done', ok: true, started: nu - i * 1000, ended: nu - i * 1000 + 500, rapport: 'verzonden' };
    fs.writeFileSync(REG, JSON.stringify(reg));
    srv = start();
    toets('server start', await wacht());
    // B: lezer in een tweede proces
    const LEES = path.join(W, 'lezer.json');
    const lezer = spawn(process.execPath, ['-e', `
      const fs = require('fs'); let n = 0, slecht = 0, eerste = '';
      const eind = Date.now() + 6000;
      while (Date.now() < eind) { let t = ''; try { t = fs.readFileSync(${JSON.stringify(REG)}, 'utf8'); JSON.parse(t); n++; } catch (e) { if (e.code !== 'ENOENT') { slecht++; if (!eerste) eerste = e.message + ' (len ' + t.length + ')'; } } }
      fs.writeFileSync(${JSON.stringify(LEES)}, JSON.stringify({ n: n, slecht: slecht, eerste: eerste }));`], { stdio: 'ignore' });
    const ids = [];
    for (let i = 0; i < 12; i++) { const a = await vraag('POST', '/agent', { secret: 'proef', label: 'proef' + i, prompt: 'p' + i, chat_id: '40687', workspace: 'vault', runtime: 'claude' }); if (a && a.job_id) ids.push(a.job_id); }
    toets('POST /agent neemt 12 agents aan', ids.length === 12, ids.length + '');
    await new Promise(r => lezer.on('exit', r));
    const l = JSON.parse(fs.readFileSync(LEES, 'utf8'));
    toets('B lezer: nooit een leeg of half register (' + l.n + ' lezingen)', l.slecht === 0 && l.n > 50, JSON.stringify(l));
    const t = JSON.parse(fs.readFileSync(TEL, 'utf8'));
    toets('A geen directe schrijfactie op agent_jobs.json', t.direct === 0, JSON.stringify(t));
    toets('A register via rename vervangen', t.rename > 0, JSON.stringify(t));
    await stop(srv);
    toets('D geen achtergebleven .tmp-bestanden', fs.readdirSync(home).filter(n => /^agent_jobs\.json\.tmp/.test(n)).length === 0, fs.readdirSync(home).join(','));
    // C: onleesbaar register bij de opstart
    const half = JSON.stringify(reg).slice(0, 5000);
    fs.writeFileSync(REG, half);
    srv = start();
    toets('C server start met onleesbaar register', await wacht());
    await slaap(300);
    const log = fs.existsSync(path.join(d, 'api.log')) ? fs.readFileSync(path.join(d, 'api.log'), 'utf8') : '';
    toets('C logregel register-onleesbaar', /register-onleesbaar/.test(log), log.split('\n').slice(-5).join(' | '));
    const kopie = fs.readdirSync(home).filter(n => /^agent_jobs\.json\.onleesbaar-/.test(n));
    toets('C onleesbaar register bewaard naast het register', kopie.length === 1 && fs.readFileSync(path.join(home, kopie[0]), 'utf8') === half, fs.readdirSync(home).join(','));
    // C2 (Fable K4): leesbaar maar geen object (array) -> ook onleesbaar, niet stil een array als register
    await stop(srv);
    kopie.forEach(n => fs.unlinkSync(path.join(home, n)));
    fs.writeFileSync(REG, '[]');
    srv = start();
    toets('C2 server start met een array als register', await wacht());
    await slaap(300);
    const log2 = fs.readFileSync(path.join(d, 'api.log'), 'utf8');
    toets('C2 logregel Vormfout', /register-onleesbaar name=Vormfout/.test(log2), log2.split('\n').slice(-4).join(' | '));
    const a = await vraag('POST', '/agent', { secret: 'proef', label: 'na-array', prompt: 'p', chat_id: '40687', workspace: 'vault', runtime: 'claude' });
    await slaap(1500);
    let na = null; try { na = JSON.parse(fs.readFileSync(REG, 'utf8')); } catch (e) {}
    toets('C2 nieuw register is een object met de nieuwe job', !!na && !Array.isArray(na) && !!(a && a.job_id && na[a.job_id]), JSON.stringify(na).slice(0, 200));
  } catch (e) { toets('uitzondering', false, String(e && e.stack || e)); }
  if (srv) await stop(srv);
  hook.close();
  console.log(fout ? 'ROOD: ' + fout + ' fout(en)' : 'ALLES GROEN');
  process.exit(fout ? 1 : 0);
});
JS
