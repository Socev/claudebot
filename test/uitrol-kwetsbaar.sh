#!/usr/bin/env bash
# wv2667 (7-11-2026): uitrol.sh wacht alleen nog op agents.kwetsbaar, niet op elke lopende agent (die leeft door als wees).
# Toetst (1) agentKwetsbaar per geval (vm-knip uit server.js), (2) de echte server.js met een nep-claude: een hangende agent is
# eerst 'jong' (kwetsbaar), daarna niet meer, terwijl lopend 1 blijft, (3) uitrol.sh droog wacht dan niet, (4) met
# UITROL_AGENTS=alle wel, (5) tegen een pod zonder het veld (oudere release) ook wel: het oude wachten op lopend.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), vm = require('vm');
const { spawn, execSync } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'uitrolkwets-'));
let fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const bron = fs.readFileSync('server.js', 'utf8');

// 1. agentKwetsbaar los
(function () {
  const i = bron.indexOf('const AGENT_JONG_MS'), j = bron.indexOf('\nfunction agentInfo()');
  toets('1 knip: agentKwetsbaar staat vóór agentInfo', i > 0 && j > i);
  if (!(i > 0 && j > i)) return;
  const ctx = { process: { env: { AGENT_JONG_MS: '120000' } }, parseInt: parseInt, Math: Math, String: String };
  vm.runInNewContext(bron.slice(i, j) + '\nthis.k = agentKwetsbaar;', ctx);
  const k = ctx.k, nu = 10e6, oud = nu - 600000;
  const basis = { status: 'running', runtime: 'claude', pid: 123, transcript: '/x.jsonl', started: oud };
  const g = (extra) => k(Object.assign({}, basis, extra), nu);
  toets('1 oud lopend, alles geregistreerd: niet kwetsbaar', g({}) === null);
  toets('1 pending: start', g({ status: 'pending' }) === 'start');
  toets('1 zonder pid: start', g({ pid: null }) === 'start');
  toets('1 loper zonder starttijd: start', g({ loper_id: 'l1' }) === 'start' && g({ loper_id: 'l1', pid_start: '9' }) === null);
  toets('1 claude zonder transcript: start', g({ transcript: null }) === 'start');
  toets('1 codex zonder transcript: niet kwetsbaar', g({ runtime: 'codex', transcript: null }) === null);
  toets('1 andere runtime: runtime', g({ runtime: 'agy' }) === 'runtime');
  toets('1 in eindcontrole: eindcontrole', g({ voorlopig: true }) === 'eindcontrole');
  toets('1 jong (< 2 min): jong', g({ started: nu - 60000 }) === 'jong');
  toets('1 jong maar al wees: niet kwetsbaar', g({ started: nu - 60000, wees: nu - 1000 }) === null);
  toets('1 klaar, rapport in herkansing: rapport', g({ status: 'done', rapport: 'herkansing-2' }) === 'rapport');
  toets('1 klaar (lang geleden): niet kwetsbaar', g({ status: 'done', rapport: 'verzonden', ended: oud }) === null && g({ status: 'afgebroken-containerherstart', ended: oud }) === null && g({ status: 'done' }) === null);
  toets('1 net afgerond (< 30 s): afronding', g({ status: 'done', rapport: '-', ended: nu - 5000 }) === 'afronding' && g({ status: 'done', ended: nu - 31000 }) === null);
})();

fs.mkdirSync(path.join(W, 'bin'));
fs.writeFileSync(path.join(W, 'bin', 'claude'), `#!/usr/bin/env node
const a = process.argv.slice(2); const p = a[a.length - 1];
if (/MODUS:HANG/.test(p)) setInterval(() => {}, 1e9);
else setTimeout(() => { process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'klaar', session_id: 'x' })); process.exit(0); }, 300);
`, { mode: 0o755 });
const hook = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('ok')); });
const POORT = vrijePoort();
function maakServer() {
  const d = path.join(W, 's');
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
  fs.copyFileSync('server.js', path.join(d, 'server.js'));
  const env = Object.assign({}, process.env, {
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: path.join(d, 'app-data'), APP_UIT_BESTAND: path.join(d, 'app-uit'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '6', AGENT_JONG_MS: '3000',
    PORT: String(POORT), AGENT_WEBHOOK_URL: 'http://127.0.0.1:' + hook.address().port + '/', AGENT_WEBHOOK_SECRET: 'proef',
    UITROL_MARKER: path.join(W, 'uitrol-wacht'), PATH: path.join(W, 'bin') + ':' + process.env.PATH
  });
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const out = fs.openSync(path.join(d, 'stdout.log'), 'a');
  return { p: spawn(process.execPath, [path.join(d, 'server.js')], { env, detached: true, stdio: ['ignore', out, out] }), d };
}
function req(poort, methode, pad, body) {
  return new Promise((ok, nok) => {
    const r = http.request({ host: '127.0.0.1', port: poort, path: pad, method: methode, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = { raw: b }; } j._status = res.statusCode; ok(j); });
    });
    r.on('error', nok); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
const klaar = (p) => new Promise((r) => { if (p.exitCode !== null) return r(p.exitCode); p.on('exit', (c, s) => r(c === null ? s : c)); });
let nr = 0;
function uitrol(poort, extraEnv) {
  const app = path.join(W, 'app' + (++nr)); fs.mkdirSync(app, { recursive: true });
  const bin = path.join(W, 'b' + nr); fs.mkdirSync(bin);
  const sha = execSync('git rev-parse HEAD').toString().trim();
  const p = spawn('bash', ['uitrol.sh', sha], { env: Object.assign({}, process.env, {
    APP_ROOT: app, BIN_DIR: bin, PORT: String(poort), UITROL_MARKER: path.join(W, 'uitrol-wacht'), UITROL_DROOG: '1', UITROL_WACHT_MAX: '10', UITROL_DATAKAART: '0' }, extraEnv || {}),
    stdio: 'ignore' });
  return { p, log: () => { try { return fs.readFileSync(path.join(bin, 'uitrol.log'), 'utf8'); } catch (e) { return ''; } } };
}

(async function () {
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const srv = maakServer();
  const nep = http.createServer((q, r) => r.end(JSON.stringify({ lopend: { beurten: 0, onopgehaald: 0 }, agents: { lopend: 1 } })));
  try {
    for (let i = 0; i < 50; i++) { try { await req(POORT, 'GET', '/health'); break; } catch (e) { await slaap(200); } }
    const a = await req(POORT, 'POST', '/agent', { secret: 'proef', label: 'machinekamer: hangt', prompt: 'MODUS:HANG', chat_id: '40687', workspace: 'vault', runtime: 'claude' });
    toets('2 voorbereiding: hangende agent start', a.ok === true, a._status + ' ' + (a.error || ''));
    await slaap(500);
    let h = await req(POORT, 'GET', '/health');
    toets('2 net gestart: lopend 1, kwetsbaar 1 (jong)', h.agents.lopend === 1 && h.agents.kwetsbaar === 1 && h.agents.kwetsbaar_redenen.jong === 1, JSON.stringify(h.agents));
    await slaap(3500);
    h = await req(POORT, 'GET', '/health');
    toets('2 na de jong-grens: lopend 1, kwetsbaar 0, gesprekken 0 (beurten telt de agent)', h.agents.lopend === 1 && h.agents.kwetsbaar === 0 && h.lopend.gesprekken === 0 && h.lopend.beurten === 1, JSON.stringify([h.agents, h.lopend]));

    let t0 = Date.now(), u = uitrol(POORT); let c = await klaar(u.p);
    toets('3 uitrol.sh (droog) wacht niet op een gewone lopende agent', c === 0 && !/wachten:/.test(u.log()) && /droog: gestopt/.test(u.log()) && Date.now() - t0 < 9000, (Date.now() - t0) + ' ms / ' + u.log().split('\n').slice(-3).join(' | '));

    u = uitrol(POORT, { UITROL_AGENTS: 'alle' }); c = await klaar(u.p);
    toets('4 UITROL_AGENTS=alle: wacht wel (oud gedrag)', c === 0 && /wachten: [12] /.test(u.log()) && /na 1\ds nog [12] lopend/.test(u.log()), u.log().split('\n').slice(-3).join(' | '));

    await new Promise((r) => nep.listen(0, '127.0.0.1', r));
    u = uitrol(nep.address().port); c = await klaar(u.p);
    toets('5 pod zonder agents.kwetsbaar: wacht op lopend (oud gedrag)', c === 0 && /wachten: 1 /.test(u.log()) && /na 1\ds nog 1 lopend/.test(u.log()), u.log().split('\n').slice(-3).join(' | '));
  } catch (e) { toets('onverwachte fout', false, e.stack); }
  finally {
    try { process.kill(-srv.p.pid, 'SIGKILL'); } catch (e) {}
    try { execSync('pkill -f "' + W + '" || true'); } catch (e) {}
    hook.close(); nep.close();
    console.log(fout ? fout + ' ROOD' : 'alles groen');
    process.exit(fout ? 1 : 0);
  }
})();
JS
