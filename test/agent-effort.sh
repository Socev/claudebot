#!/usr/bin/env bash
# Toetst (wv2111, 31-10-2026): POST /agent met een eigen effort. (1) effort 'medium' gaat als --effort medium naar de CLI, ook in
# een hervatting van de eindcontrole, en staat in het antwoord, /agents en de joblog; (2) zonder effort = podstandaard (CLAUDE_EFFORT,
# hier high) en geen effort-veld; hoofdletters/spaties worden genormaliseerd; (3) een onbekende waarde geeft 400 onbekend-effort en
# start geen CLI. Laadt de ECHTE server.js met een nep-claude die zijn argumenten vastlegt.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-'));
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; };
const slaap = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(path.join(W, 'bin'));
const ARGLOG = path.join(W, 'args.jsonl');
fs.writeFileSync(path.join(W, 'bin', 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2), prompt = a[a.length - 1];
const sleutel = (/SLEUTEL:([a-z0-9]+)/.exec(prompt) || [])[1] || 'x';
const hervat = a.includes('--resume');
const sid = hervat ? a[a.indexOf('--resume') + 1] : (a.includes('--session-id') ? a[a.indexOf('--session-id') + 1] : 'x');
fs.appendFileSync(${JSON.stringify(ARGLOG)}, JSON.stringify({ sleutel: sleutel, sid: sid, hervat: hervat, effort: a.includes('--effort') ? a[a.indexOf('--effort') + 1] : null }) + '\\n');
const tekst = (sleutel === 'wacht' && !hervat) ? 'Ik wacht nu op de build.' : 'klaar ' + sleutel;
setTimeout(() => { process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: tekst, session_id: sid })); process.exit(0); }, 200);
`, { mode: 0o755 });
const hook = http.createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => {
  if (q.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return s.end(JSON.stringify([{ actieve_kant: 'olares', sinds: null }]));
  s.end('{}'); }); });
hook.listen(0, '127.0.0.1', async () => {
  const d = path.join(W, 'pod');
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach(m => fs.mkdirSync(path.join(d, m), { recursive: true }));
  fs.writeFileSync(path.join(d, 'server.js'), fs.readFileSync('server.js', 'utf8').split('const AGENT_START_SPREIDING_MS = 20 * 1000;').join('const AGENT_START_SPREIDING_MS = 100;')
    .split('const EIND_BEZINK_MS = 5 * 1000;').join('const EIND_BEZINK_MS = 100;'));
  const PROEF = path.join(d, 'advisor-proef.json');
  const poort = vrijePoort();
  Object.assign(process.env, {
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: path.join(d, 'app-data'), APP_UIT_BESTAND: path.join(d, 'app-uit'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    UITROL_MARKER: path.join(d, 'uitrol-wacht'), ROL_BESTAND: path.join(d, 'rol'), ADVISOR_PROEF_FILE: PROEF, CLAUDE_EFFORT: 'high',
    SUPABASE_URL: 'http://127.0.0.1:' + hook.address().port, SUPABASE_SERVICE_ROLE: 'proef', SOCEV_KANT: 'olares',
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '20',
    PORT: String(poort), AGENT_WEBHOOK_URL: 'http://127.0.0.1:' + hook.address().port + '/', AGENT_WEBHOOK_SECRET: 'proef',
    PATH: path.join(W, 'bin') + ':' + process.env.PATH });
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN; delete process.env.SOCEV_AGENT_RUN; delete process.env.ANTHROPIC_MODEL;
  fs.writeFileSync(path.join(d, 'runtime.json'), JSON.stringify({ default: 'claude', fallback: '', models: { claude: 'claude-opus-5-5' } }));
  require(path.join(d, 'server.js'));
  const vraag = (methode, pad, body) => new Promise((ok, nok) => { const r = http.request({ host: '127.0.0.1', port: poort, path: pad, method: methode, headers: { 'content-type': 'application/json' } },
    res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = { raw: b }; } j._status = res.statusCode; ok(j); }); }); r.on('error', nok); r.end(body ? JSON.stringify(body) : undefined); });
  const agent = (o) => vraag('POST', '/agent', Object.assign({ secret: 'proef', chat_id: '40687', workspace: 'vault' }, o));
  const argsVan = sl => { try { return fs.readFileSync(ARGLOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(x => x.sleutel === sl); } catch (e) { return []; } };
  const wachtOp = async (sl, n) => { const t0 = Date.now(); while (Date.now() - t0 < 15000 && argsVan(sl).length < (n || 1)) await slaap(100); return argsVan(sl); };
  try {
    for (let i = 0; i < 50; i++) { try { await vraag('GET', '/agents'); break; } catch (e) { await slaap(200); } }

    // (1) eigen effort, ook in de hervatting
    const a1 = await agent({ label: 'machinekamer:los effort', prompt: 'SLEUTEL:wacht', effort: ' Medium ' });
    toets('effort medium aangenomen (genormaliseerd), staat in het antwoord', a1.ok === true && a1.effort === 'medium', JSON.stringify(a1));
    let r = await wachtOp('wacht');
    toets('CLI kreeg --effort medium', r.length === 1 && r[0].effort === 'medium', JSON.stringify(r));
    const hv = async () => { const t0 = Date.now(); let h = []; while (Date.now() - t0 < 15000) { h = argsVan('x').filter(x => x.hervat && r[0] && x.sid === r[0].sid); if (h.length) break; await slaap(100); } return h; };
    const h = await hv();
    toets('hervatting door de eindcontrole houdt --effort medium', h.length === 1 && h[0].effort === 'medium', JSON.stringify(h));
    const a3 = await agent({ label: 'machinekamer:los low', prompt: 'SLEUTEL:laag', effort: 'low', model: 'claude-sonnet-5-5' });
    r = await wachtOp('laag');
    toets('effort low bij een eigen model', a3.ok === true && r.length === 1 && r[0].effort === 'low', JSON.stringify(r));

    // (2) zonder effort: podstandaard
    const a2 = await agent({ label: 'machinekamer:los zonder', prompt: 'SLEUTEL:zonder' });
    r = await wachtOp('zonder');
    toets('zonder effort: --effort high (CLAUDE_EFFORT), geen effort-veld', a2.ok === true && a2.effort === undefined && r.length === 1 && r[0].effort === 'high', JSON.stringify(r));
    const a4 = await agent({ label: 'machinekamer:los leeg', prompt: 'SLEUTEL:leeg', effort: '' });
    r = await wachtOp('leeg');
    toets('lege effort = podstandaard', a4.ok === true && r.length === 1 && r[0].effort === 'high', JSON.stringify(r));

    // (3) weigeringen
    const f1 = await agent({ label: 'machinekamer:los fout', prompt: 'SLEUTEL:fout1', effort: 'hoog' });
    toets('onbekend effort: 400 onbekend-effort', f1._status === 400 && f1.error === 'onbekend-effort', JSON.stringify(f1));
    const f2 = await agent({ label: 'machinekamer:los fout', prompt: 'SLEUTEL:fout2', effort: 3 });
    toets('getal als effort: 400', f2._status === 400 && f2.error === 'onbekend-effort', JSON.stringify(f2));
    await slaap(500);
    toets('geweigerde starts riepen de CLI niet aan', !argsVan('fout1').length && !argsVan('fout2').length);

    // register en joblog
    await slaap(800);
    const lijst = ((await vraag('GET', '/agents')).agents) || [];
    const l1 = lijst.find(x => x.job_id === a1.job_id), l2 = lijst.find(x => x.job_id === a2.job_id);
    toets('/agents toont effort (alleen bij eigen effort)', l1 && l1.effort === 'medium' && l2 && l2.effort === undefined, JSON.stringify([l1, l2]));
    const log = fs.readFileSync(path.join(d, 'api.log'), 'utf8');
    toets('joblog: regel met effort=medium voor de agent', new RegExp('job job_id=' + a1.job_id + '[^\\n]*effort=medium').test(log));
  } catch (e) { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); fout++; }
  console.log(fout ? 'ROOD: ' + fout + ' toets(en) mislukt' : 'ALLES GROEN');
  process.exit(fout ? 1 : 0);
});
JS
