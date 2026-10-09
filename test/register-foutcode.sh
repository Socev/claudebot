#!/usr/bin/env bash
# Toetst (wv51, 8-10-2026): (1) een afgeronde agent zet zijn foutcode in het register en GET /agents toont die
# ('limiet'; null bij succes); (2) saveAgents() trimt naar 50 gewone afgeronde entries maar spaart werkvoorraad-jobs
# (label <prefix>:wv<id> …) tot 48 u na afloop. Laadt de ECHTE server.js met een nep-claude.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'regfout-'));
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; };
const slaap = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(path.join(W, 'bin'));
fs.writeFileSync(path.join(W, 'bin', 'claude'), `#!/usr/bin/env node
const a = process.argv.slice(2), prompt = a[a.length - 1];
const sleutel = (/SLEUTEL:([a-z0-9]+)/.exec(prompt) || [])[1] || 'x';
const sid = a.includes('--session-id') ? a[a.indexOf('--session-id') + 1] : 'x';
const limiet = sleutel === 'limiet';
setTimeout(() => { process.stdout.write(JSON.stringify({ type: 'result', is_error: limiet, result: limiet ? 'Claude AI usage limit reached, resets at 5pm' : 'klaar ' + sleutel, session_id: sid })); process.exit(limiet ? 1 : 0); }, 300);
`, { mode: 0o755 });
const rapporten = [];
// De hook is ook de nep-Supabase voor de rolwachter (actieve kant olares): de toets hangt zo niet af van de echte stand.
const hook = http.createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => {
  if (q.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return s.end(JSON.stringify([{ actieve_kant: 'olares', sinds: null }]));
  try { rapporten.push(JSON.parse(b)); } catch (e) {} s.end('{}'); }); });
hook.listen(0, '127.0.0.1', async () => {
  const d = path.join(W, 'pod');
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach(m => fs.mkdirSync(path.join(d, m), { recursive: true }));
  // Register vooraf: 55 gewone entries (1-55 min oud), een wv-job van 10 u oud (ouder dan alle gewone: moet blijven),
  // een wv-job die 50 u geleden eindigde (moet weg).
  const nu = Date.now(), reg = {};
  const zet = (id, label, startMs, eindMs) => { reg[id] = { job_id: id, label: label, status: 'done', ok: true, started: startMs, ended: eindMs, rapport: 'verzonden', chat_id: '40687' }; };
  for (let i = 1; i <= 55; i++) zet('gewoon' + i, 'socev: proef ' + i, nu - i * 60000, nu - i * 60000 + 30000);
  zet('wvvers', 'machinekamer:wv900 tien uur oud', nu - 10 * 3600e3, nu - 10 * 3600e3 + 60000);
  zet('wvoud', 'machinekamer:wv901 vijftig uur oud', nu - 51 * 3600e3, nu - 50 * 3600e3);
  fs.writeFileSync(path.join(d, 'home', 'agent_jobs.json'), JSON.stringify(reg));
  fs.writeFileSync(path.join(d, 'server.js'), fs.readFileSync('server.js', 'utf8').split('const AGENT_START_SPREIDING_MS = 20 * 1000;').join('const AGENT_START_SPREIDING_MS = 300;'));
  const poort = vrijePoort();
  Object.assign(process.env, {
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: path.join(d, 'app-data'), APP_UIT_BESTAND: path.join(d, 'app-uit'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    // wv202: eigen uitrolmarker en rolbestand. Zonder UITROL_MARKER las de toets de echte /opt/data/uitrol-wacht: zolang
    // er op de pod een uitrol op stilte wachtte, gaf POST /agent voor het machinekamer:-label 503 uitrol-wacht en waren
    // de twee limiettoetsen rood (8-10: 14:14-14:34 en 15:54-16:22). Ook de rol kwam uit de echte Supabase.
    UITROL_MARKER: path.join(d, 'uitrol-wacht'), ROL_BESTAND: path.join(d, 'rol'),
    SUPABASE_URL: 'http://127.0.0.1:' + hook.address().port, SUPABASE_SERVICE_ROLE: 'proef', SOCEV_KANT: 'olares',
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '6',
    PORT: String(poort), AGENT_WEBHOOK_URL: 'http://127.0.0.1:' + hook.address().port + '/', AGENT_WEBHOOK_SECRET: 'proef',
    PATH: path.join(W, 'bin') + ':' + process.env.PATH });
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN; delete process.env.SOCEV_AGENT_RUN;
  require(path.join(d, 'server.js'));
  const vraag = (methode, pad, body) => new Promise((ok, nok) => { const r = http.request({ host: '127.0.0.1', port: poort, path: pad, method: methode, headers: { 'content-type': 'application/json' } },
    res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { ok({ raw: b }); } }); }); r.on('error', nok); r.end(body ? JSON.stringify(body) : undefined); });
  try {
    for (let i = 0; i < 50; i++) { try { await vraag('GET', '/agents'); break; } catch (e) { await slaap(200); } }
    const agent = (label, sl) => vraag('POST', '/agent', { secret: 'proef', label: label, prompt: 'SLEUTEL:' + sl, chat_id: '40687', workspace: 'vault', runtime: 'claude' });
    const a1 = await agent('machinekamer:wv902 limietproef', 'limiet');
    const a2 = await agent('socev: goedproef', 'goed');
    toets('POST /agent neemt beide agents aan', !!(a1 && a1.job_id) && !!(a2 && a2.job_id), JSON.stringify(a1) + ' ' + JSON.stringify(a2));
    const t0 = Date.now(); while (Date.now() - t0 < 20000 && rapporten.length < 2) await slaap(200);
    await slaap(300);
    const lijst = ((await vraag('GET', '/agents')).agents) || [];
    const l1 = lijst.find(x => x.job_id === a1.job_id), l2 = lijst.find(x => x.job_id === a2.job_id);
    toets('agent met limietfout: /agents toont error "limiet"', l1 && l1.status === 'done' && l1.ok === false && l1.error === 'limiet', JSON.stringify(l1));
    toets('geslaagde agent: /agents toont error null', l2 && l2.status === 'done' && l2.ok === true && l2.error === null, JSON.stringify(l2));
    const f = JSON.parse(fs.readFileSync(path.join(d, 'home', 'agent_jobs.json'), 'utf8'));
    const gewoon = Object.keys(f).filter(id => !/^(machinekamer|socev):wv\d+ /.test(f[id].label || '')).length;
    toets('register: 50 gewone afgeronde entries', gewoon === 50, String(gewoon));
    toets('register: wv-job van 10 u oud blijft (ouder dan de 50 gewone)', !!f.wvvers && lijst.some(x => x.job_id === 'wvvers'));
    toets('register: wv-job die 50 u geleden eindigde is weg', !f.wvoud);
    toets('register: verse wv-job met foutcode bewaard op schijf', f[a1.job_id] && f[a1.job_id].error === 'limiet');
    toets('register: oudste gewone entries weg (gewoon55)', !f.gewoon55 && !!f.gewoon1);
    toets('agentFoutcode: vrije fouttekst wordt "overig"', /agentFoutcode/.test(fs.readFileSync('server.js', 'utf8')) && (function () {
      const m = /function agentFoutcode\(err\) \{[\s\S]*?\n\}/.exec(fs.readFileSync('server.js', 'utf8'));
      const fn = new Function(m[0] + '; return agentFoutcode;')();
      return fn('Error: ENOENT /opt/data/x') === 'overig' && fn('afgebroken-gestopt') === 'afgebroken-gestopt' && fn(null) === null && fn('') === null;
    })());
  } catch (e) { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); fout++; }
  console.log(fout ? 'ROOD: ' + fout + ' toets(en) mislukt — werkmap ' + W : 'ALLES GROEN');
  if (!fout) fs.rmSync(W, { recursive: true, force: true });
  process.exit(fout ? 1 : 0);
});
JS
