#!/usr/bin/env bash
# Toetst (5-10-2026, review wachtrij spraakkastje): een achtergrondagent die nog op zijn startbeurt wacht
# (pending, startspreiding) is te stoppen; de start vervalt en er wordt geen claude-proces gestart. De enige
# stop-ingang is de smalle poort van het spraakkastje (ipc), dus hier laadt de toets de ECHTE server.js in
# hetzelfde proces (met verkorte spreiding) en roept jobs[id].progress.stoppen() aan zoals autoStopVerzoek doet.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'stopvoorstart-'));
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; };
const slaap = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(path.join(W, 'bin'));
fs.writeFileSync(path.join(W, 'bin', 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), prompt = a[a.length - 1];
const sleutel = (/SLEUTEL:([a-z0-9]+)/.exec(prompt) || [])[1] || 'x';
fs.appendFileSync(${JSON.stringify(path.join(W, 'spawns.log'))}, sleutel + '\\n');
const sid = a.includes('--session-id') ? a[a.indexOf('--session-id') + 1] : 'x';
setTimeout(() => { process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'klaar ' + sleutel, session_id: sid })); process.exit(0); }, 300);
`, { mode: 0o755 });
const rapporten = [];
const hook = http.createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => { try { rapporten.push(JSON.parse(b)); } catch (e) {} s.end('{}'); }); });
hook.listen(0, '127.0.0.1', async () => {
  const d = path.join(W, 'pod');
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach(m => fs.mkdirSync(path.join(d, m), { recursive: true }));
  let s = fs.readFileSync('server.js', 'utf8').split('const AGENT_START_SPREIDING_MS = 20 * 1000;').join('const AGENT_START_SPREIDING_MS = 3000;');
  fs.writeFileSync(path.join(d, 'server.js'), s + '\nglobal.__toetsJobs = jobs;\n');
  const poort = 18631;
  Object.assign(process.env, {
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '6',
    PORT: String(poort), AGENT_WEBHOOK_URL: 'http://127.0.0.1:' + hook.address().port + '/', AGENT_WEBHOOK_SECRET: 'proef',
    PATH: path.join(W, 'bin') + ':' + process.env.PATH });
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  require(path.join(d, 'server.js'));
  const post = body => new Promise((ok, nok) => { const r = http.request({ host: '127.0.0.1', port: poort, path: '/agent', method: 'POST', headers: { 'content-type': 'application/json' } },
    res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { ok({ raw: b }); } }); }); r.on('error', nok); r.end(JSON.stringify(body)); });
  try {
    for (let i = 0; i < 50; i++) { try { await post({}); break; } catch (e) { await slaap(200); } }
    const agent = (sl) => post({ secret: 'proef', label: 'proef ' + sl, prompt: 'SLEUTEL:' + sl, chat_id: '40687', workspace: 'vault', runtime: 'claude' });
    const a1 = await agent('een'), a2 = await agent('twee');
    await slaap(300);
    const j2 = global.__toetsJobs[a2.job_id];
    toets('tweede agent wacht nog op zijn startbeurt (pending) en is te stoppen', j2 && j2.status === 'pending' && j2.progress && typeof j2.progress.stoppen === 'function', j2 && j2.status);
    j2.progress.stoppen();
    const t0 = Date.now(); while (Date.now() - t0 < 15000 && rapporten.length < 2) await slaap(200);
    const r1 = rapporten.find(r => r.job_id === a1.job_id), r2 = rapporten.find(r => r.job_id === a2.job_id);
    const spawns = fs.existsSync(path.join(W, 'spawns.log')) ? fs.readFileSync(path.join(W, 'spawns.log'), 'utf8').trim().split('\n') : [];
    toets('eerste agent liep gewoon', r1 && r1.ok && /klaar een/.test(r1.output), r1 && r1.output);
    toets('gestopte agent: rapport "gestopt voordat hij begon", geen ok', r2 && !r2.ok && /gestopt voordat hij begon/.test(r2.output), r2 && (r2.error + ' / ' + r2.output));
    toets('gestopte agent: geen claude-proces gestart', spawns.indexOf('twee') < 0 && spawns.indexOf('een') >= 0, spawns.join(','));
  } catch (e) { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); fout++; }
  console.log(fout ? 'ROOD: ' + fout + ' toets(en) mislukt — werkmap ' + W : 'ALLES GROEN');
  if (!fout) fs.rmSync(W, { recursive: true, force: true });
  process.exit(fout ? 1 : 0);
});
JS
