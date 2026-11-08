#!/usr/bin/env bash
# Toetst de twee Max-abonnementen (wv781, 22-10-2026): agents op account 2, gesprekken (/run) op account 1, terugval naar account 1
# bij een limietweigering op account 2 (in dezelfde sessie), de schakelaar (bestand en env) en /tank?account=2 zonder token.
# Draait de ECHTE server.js op een losse poort met een nep-`claude` vooraan in PATH die alleen noteert WELK nep-token hij kreeg.
# Geen taalmodel, geen echte tokens, geen pod nodig.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'tweeacc-'));
let fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const T1 = 'sk-ant-oat01-NEP1aaaaaaaaaaaaaaaaaaaaaaaa', T2 = 'sk-ant-oat01-NEP2bbbbbbbbbbbbbbbbbbbbbbbb';

fs.mkdirSync(path.join(W, 'bin'));
fs.writeFileSync(path.join(W, 'bin', 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const sid = a.includes('--session-id') ? a[a.indexOf('--session-id') + 1] : (a.includes('--resume') ? a[a.indexOf('--resume') + 1] : 'GEEN-ID');
const prompt = a[a.length - 1];
const tok = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
const acc = tok.indexOf('NEP2') > 0 ? 2 : (tok.indexOf('NEP1') > 0 ? 1 : 0);
const sleutel = (/SLEUTEL:([a-z0-9]+)/.exec(prompt) || [])[1] || 'x';
const W = ${JSON.stringify(W)};
fs.appendFileSync(path.join(W, 'spawns.log'), JSON.stringify({ sleutel, acc, sid, resume: a.includes('--resume'), pod: /tweede abonnement/.test(prompt) }) + '\\n');
const proj = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj, { recursive: true });
fs.appendFileSync(path.join(proj, sid + '.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'opdracht' } }) + '\\n');
const limiet = /MODUS:LIMIET2/.test(prompt) && acc === 2;
const auth = /MODUS:AUTH2/.test(prompt) && acc === 2;
const duur = /MODUS:LANG/.test(prompt) ? 2500 : 300;
setTimeout(() => {
  if (auth) { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has been revoked"}}', session_id: sid })); process.exit(1); }
  if (limiet) { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: "You've hit your limit · resets 7pm (Europe/Amsterdam)", session_id: sid })); process.exit(1); }
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'klaar op ' + acc, session_id: sid })); process.exit(0);
}, duur);
`, { mode: 0o755 });

const rapporten = [];
let week1 = '0.40', tankRijen = [], koppen = 'beide', weiger = new Set();   // koppen: beide | zonder5h (Anthropic sinds 31-10-2026) | alleen7d | zonder7d   // nep-tank van account 1 (headers zoals /v1/messages) en wat de pod naar de RPC's schrijft
const hook = http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
  if (req.url === '/v1/messages') {
    const tokAcc = /NEP2/.test(String(req.headers.authorization)) ? 2 : 1;   // wv2748: inlog geweigerd per account
    if (weiger.has(tokAcc)) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'OAuth access token is invalid.' } })); }
    const r7 = Math.floor(Date.now() / 1000) + 3 * 86400;
    const k = { 'anthropic-ratelimit-unified-5h-utilization': '0.10', 'anthropic-ratelimit-unified-7d-utilization': week1,
      'anthropic-ratelimit-unified-7d-reset': String(r7), 'anthropic-ratelimit-unified-5h-reset': String(r7 - 86400), 'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-status': 'allowed', 'anthropic-ratelimit-unified-7d-status': 'allowed' };
    Object.keys(k).forEach((n) => { if (((koppen === 'zonder5h' || koppen === 'alleen7d') && n.indexOf('-5h-') > 0) || (koppen === 'alleen7d' && !/-7d-/.test(n)) || (koppen === 'zonder7d' && n.indexOf('-7d-') > 0)) delete k[n]; });
    res.writeHead(200, k);
    return res.end('{}');
  }
  if (req.url.indexOf('/rest/v1/rpc/mk_tank') === 0) { try { tankRijen.push({ rpc: req.url.split('/').pop(), body: JSON.parse(b) }); } catch (e) {} return res.end(JSON.stringify([{ oordeel: 'proef' }])); }
  if (req.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return res.end(JSON.stringify([{ actieve_kant: 'olares', sinds: null }]));
  try { rapporten.push(JSON.parse(b)); } catch (e) {} res.end('ok'); }); });

function maakServer(naam, poort, extraEnv) {
  const d = path.join(W, naam);
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
  let s = fs.readFileSync('server.js', 'utf8');
  [['const AGENT_START_SPREIDING_MS = 20 * 1000;', 'const AGENT_START_SPREIDING_MS = 300;'],
   ['const EIND_POLL_MS = 15 * 1000;', 'const EIND_POLL_MS = 300;'],
   ['const EIND_BEZINK_MS = 5 * 1000;', 'const EIND_BEZINK_MS = 200;']].forEach(([x, y]) => { s = s.split(x).join(y); });
  fs.writeFileSync(path.join(d, 'server.js'), s);
  const env = Object.assign({}, process.env, {
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: path.join(d, 'app-data'), APP_UIT_BESTAND: path.join(d, 'app-uit'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    UITROL_MARKER: path.join(d, 'uitrol-wacht'), ROL_BESTAND: path.join(d, 'rol'), AGY_MCP_TMP: path.join(d, 'agy-mcp.json'), TUNNEL_UIT_POD: '1',
    CLAUDE_ACCOUNTS_STAND: path.join(d, 'claude-accounts.json'), TANK_PROEF_URL: 'http://127.0.0.1:' + hook.address().port + '/v1/messages',
    SUPABASE_URL: 'http://127.0.0.1:' + hook.address().port, SUPABASE_SERVICE_ROLE: 'proef', SOCEV_KANT: 'olares',
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '6',
    PORT: String(poort), AGENT_WEBHOOK_URL: 'http://127.0.0.1:' + hook.address().port + '/', AGENT_WEBHOOK_SECRET: 'proef',
    PATH: path.join(W, 'bin') + ':' + process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: T1
  }, extraEnv || {});
  delete env.SOCEV_AGENT_RUN; delete env.SUPABASE_MCP_TOKEN; if (!(extraEnv && extraEnv.CLAUDE_AGENTS_ACCOUNT)) delete env.CLAUDE_AGENTS_ACCOUNT;
  Object.keys(extraEnv || {}).forEach((k) => { if (extraEnv[k] === null) delete env[k]; });
  const p = spawn(process.execPath, [path.join(d, 'server.js')], { env, detached: true, stdio: ['ignore', fs.openSync(path.join(d, 'stdout.log'), 'a'), fs.openSync(path.join(d, 'stdout.log'), 'a')] });
  return { p, d, poort };
}
function req(srv, methode, pad, body) {
  return new Promise((ok, nok) => {
    const r = http.request({ host: '127.0.0.1', port: srv.poort, path: pad, method: methode, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { ok(Object.assign({ _status: res.statusCode }, JSON.parse(b))); } catch (e) { ok({ raw: b, _status: res.statusCode }); } });
    });
    r.on('error', nok); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
async function wachtOp(srv) { for (let i = 0; i < 60; i++) { try { await req(srv, 'GET', '/health'); return; } catch (e) { await slaap(200); } } throw new Error('server start niet'); }
const agent = (s, prompt) => req(s, 'POST', '/agent', { secret: 'proef', label: 'proef', prompt, chat_id: '40687', workspace: 'vault', runtime: 'claude' });
async function rapportVoor(id, maxMs) { const t = Date.now(); while (Date.now() - t < maxMs) { const r = rapporten.find((x) => x.job_id === id); if (r) return r; await slaap(200); } return null; }
async function spawnsVoor(sl, n, maxMs) { const t = Date.now(); let l = []; while (Date.now() - t < maxMs) { l = spawns().filter((x) => x.sleutel === sl); if (l.length >= n) return l; await slaap(200); } return l; }
function spawns() { try { return fs.readFileSync(path.join(W, 'spawns.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } }
function stop(srv) { try { process.kill(-srv.p.pid, 'SIGKILL'); } catch (e) {} }

(async function () {
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const alle = [];
  try {
    // ACCOUNT2_MEET=1: het opstartpad van de echte pod (meetklok), dat een proefserver anders overslaat (CI-rooktest 176 viel daarop)
    const s = maakServer('s1', vrijePoort(), { CLAUDE_OAUTH_TOKEN_2: T2, ACCOUNT2_MEET: '1' }); alle.push(s); await wachtOp(s);
    await slaap(2500);
    const m2 = tankRijen.find((x) => x.rpc === 'mk_tank2_schrijf');
    toets('A0 meetklok: na de start een meting van account 2 met bruikbaar', !!(m2 && m2.body.p_bruikbaar === true), JSON.stringify(m2 && m2.body));
    let h = await req(s, 'GET', '/health');
    toets('A /health: accounts.agents_op 2, token2 aanwezig, geen bezwaar', h.accounts && h.accounts.agents_op === 2 && h.accounts.token2 === true && h.accounts.bezwaar2 === null, JSON.stringify(h.accounts));
    toets('A /health noemt nooit het token', JSON.stringify(h).indexOf('NEP2') === -1 && JSON.stringify(h).indexOf('NEP1') === -1);

    // B. agent -> account 2, en tijdens de run staat hij in /health als 2
    const a = await agent(s, 'MODUS:LANG SLEUTEL:aa');
    await spawnsVoor('aa', 1, 5000); await slaap(400);
    h = await req(s, 'GET', '/health');
    toets('B agent loopt in /health op account 2', h.accounts && h.accounts.lopend && h.accounts.lopend[a.job_id] === 2, JSON.stringify(h.accounts && h.accounts.lopend));
    const ra = await rapportVoor(a.job_id, 15000);
    const sa = spawns().filter((x) => x.sleutel === 'aa');
    toets('B agent kreeg het token van account 2', sa.length >= 1 && sa.every((x) => x.acc === 2), JSON.stringify(sa));
    toets('B agent-rapport ok', ra && ra.ok === true);

    // C. /run (gesprek) -> account 1
    await req(s, 'POST', '/run', { secret: 'proef', chat_id: '40687', workspace: 'vault', prompt: 'SLEUTEL:rr' });
    const sr = await spawnsVoor('rr', 1, 8000);
    toets('C gesprek (/run) op account 1', sr.length >= 1 && sr.every((x) => x.acc === 1), JSON.stringify(sr));

    // D. limiet op account 2 -> dezelfde sessie verder op account 1, account 2 daarna dicht
    const l = await agent(s, 'MODUS:LIMIET2 SLEUTEL:ll');
    const rl = await rapportVoor(l.job_id, 20000);
    const sl = spawns().filter((x) => x.sleutel === 'll');
    toets('D eerst account 2, dan account 1', sl.length >= 2 && sl[0].acc === 2 && sl[1].acc === 1, JSON.stringify(sl));
    toets('D terugval hervat dezelfde sessie met podregel', sl.length >= 2 && sl[1].resume === true && sl[1].sid === sl[0].sid && sl[1].pod === true);
    toets('D rapport ok na terugval', rl && rl.ok === true, rl && String(rl.output || '').slice(0, 80));
    h = await req(s, 'GET', '/health');
    toets('D account 2 daarna dicht (bezwaar2)', h.accounts && /dicht na limiet/.test(String(h.accounts.bezwaar2)), String(h.accounts && h.accounts.bezwaar2));
    toets('D limiet staat in het log zonder token', /account2-limiet/.test(fs.readFileSync(path.join(s.d, 'api.log'), 'utf8')) && !/NEP2/.test(fs.readFileSync(path.join(s.d, 'api.log'), 'utf8')));
    toets('D na een limiet: verse meting van account 1 voor het vangnet', tankRijen.some((x) => x.rpc === 'mk_tank_schrijf'));
    const b2 = await agent(s, 'SLEUTEL:bb');
    await rapportVoor(b2.job_id, 15000);
    const sb = spawns().filter((x) => x.sleutel === 'bb');
    toets('D volgende agent meteen op account 1', sb.length >= 1 && sb[0].acc === 1, JSON.stringify(sb));
    // D1. (na D: de verse /tank vult de cache die het vangnet in D zou gebruiken) 31-10-2026: geen 5h-koppen meer -> meting ok met vijf_uur null (geen verzonnen 0); zonder 7d-koppen fail-closed
    koppen = 'zonder5h'; tankRijen = [];
    const z5 = await req(s, 'GET', '/tank?verversen=1');
    const z5rij = tankRijen.find((x) => x.rpc === 'mk_tank_schrijf');
    toets('D1 /tank zonder 5h-koppen: ok, week gemeten, vijf_uur null', z5._status === 200 && z5.ok === true && z5.zeven_dagen.benut === 0.4 && z5.vijf_uur.benut === null, JSON.stringify(z5).slice(0, 200));
    toets('D1 zonder 5h-koppen: RPC krijgt p_vijf_uur null', !!(z5rij && z5rij.body.p_vijf_uur === null && z5rij.body.p_zeven_dagen === 0.4), JSON.stringify(z5rij && z5rij.body));
    const z5b = await req(s, 'GET', '/tank?account=2&verversen=1');
    toets('D1 /tank?account=2 zonder 5h-koppen: ok', z5b._status === 200 && z5b.ok === true && z5b.vijf_uur.benut === null, JSON.stringify(z5b).slice(0, 160));
    koppen = 'alleen7d';
    const a7 = await req(s, 'GET', '/tank?verversen=1');
    toets('D1 /tank met alleen 7d-koppen: ok, status uit 7d-status', a7._status === 200 && a7.ok === true && a7.status === 'allowed' && a7.vijf_uur.benut === null, JSON.stringify(a7).slice(0, 200));
    koppen = 'zonder7d'; tankRijen = [];
    const z7 = await req(s, 'GET', '/tank?verversen=1');
    toets('D1 /tank zonder 7d-koppen: fail-closed (503, niets geschreven)', z7._status === 503 && z7.ok === false && !tankRijen.length, JSON.stringify(z7));
    koppen = 'beide';
    stop(s);

    // G. vangnet: account 1 onder Davids reserve (96% van de week) -> geen terugval, agent eindigt als limiet
    week1 = '0.96';
    const vg = maakServer('s5', vrijePoort(), { CLAUDE_OAUTH_TOKEN_2: T2 }); alle.push(vg); await wachtOp(vg);
    const v5 = await agent(vg, 'MODUS:LIMIET2 SLEUTEL:vv');
    const rv = await rapportVoor(v5.job_id, 20000);
    const sv = spawns().filter((x) => x.sleutel === 'vv');
    toets('G vangnet: account 1 onder de reserve -> geen terugval', sv.length === 1 && sv[0].acc === 2, JSON.stringify(sv));
    toets('G vangnet: agent mislukt als limiet', rv && rv.ok === false, rv && String(rv.error || rv.output || '').slice(0, 80));
    toets('G vangnet staat in het log', /"terugval":0/.test(fs.readFileSync(path.join(vg.d, 'api.log'), 'utf8')));
    stop(vg); week1 = '0.40';

    // H. ingetrokken token 2 (401) -> terugval en account 2 zes uur dicht
    const ha = maakServer('s6', vrijePoort(), { CLAUDE_OAUTH_TOKEN_2: T2 }); alle.push(ha); await wachtOp(ha);
    const h6 = await agent(ha, 'MODUS:AUTH2 SLEUTEL:hh');
    const rh = await rapportVoor(h6.job_id, 20000);
    const sh = spawns().filter((x) => x.sleutel === 'hh');
    toets('H tokenfout: eerst 2, dan 1 in dezelfde sessie', sh.length >= 2 && sh[0].acc === 2 && sh[1].acc === 1 && sh[1].sid === sh[0].sid, JSON.stringify(sh));
    toets('H tokenfout: rapport ok', rh && rh.ok === true);
    h = await req(ha, 'GET', '/health');
    toets('H tokenfout: bezwaar2 noemt de tokenfout', h.accounts && /tokenfout/.test(String(h.accounts.bezwaar2)), String(h.accounts && h.accounts.bezwaar2));
    const ag = await req(ha, 'GET', '/agents');
    toets('H /agents noemt het account', ag.agents && ag.agents.some((x) => x.job_id === h6.job_id && (x.account === 1 || x.account === 2)));
    stop(ha);

    // E. schakelaar: bestand {"agents":1} -> agent op 1; daarna bestand weg -> weer 2 (zonder herstart)
    const e = maakServer('s2', vrijePoort(), { CLAUDE_OAUTH_TOKEN_2: T2 }); alle.push(e); await wachtOp(e);
    fs.writeFileSync(path.join(e.d, 'claude-accounts.json'), '{"agents":1}');
    const e1 = await agent(e, 'SLEUTEL:ea'); await rapportVoor(e1.job_id, 15000);
    toets('E schakelaar-bestand op 1: agent op account 1', (spawns().find((x) => x.sleutel === 'ea') || {}).acc === 1);
    h = await req(e, 'GET', '/health');
    toets('E /health toont schakelaar 1', h.accounts && h.accounts.agents_op === 1 && h.accounts.bezwaar2 === 'schakelaar op 1');
    fs.unlinkSync(path.join(e.d, 'claude-accounts.json'));
    const e2 = await agent(e, 'SLEUTEL:eb'); await rapportVoor(e2.job_id, 15000);
    toets('E bestand weg: agent weer op account 2', (spawns().find((x) => x.sleutel === 'eb') || {}).acc === 2);
    fs.writeFileSync(path.join(e.d, 'claude-accounts.json'), 'kapot');
    const e3 = await agent(e, 'SLEUTEL:ec'); await rapportVoor(e3.job_id, 15000);
    toets('E onleesbaar bestand: veilig op account 1', (spawns().find((x) => x.sleutel === 'ec') || {}).acc === 1);
    stop(e);

    const v = maakServer('s3', vrijePoort(), { CLAUDE_OAUTH_TOKEN_2: T2, CLAUDE_AGENTS_ACCOUNT: '1' }); alle.push(v); await wachtOp(v);
    const v1 = await agent(v, 'SLEUTEL:va'); await rapportVoor(v1.job_id, 15000);
    toets('E env CLAUDE_AGENTS_ACCOUNT=1 wint', (spawns().find((x) => x.sleutel === 'va') || {}).acc === 1);
    stop(v);

    // I. wv2748 inlogverloop-wachter: 401 op de tankmeting -> fout 'inlog geweigerd', /health accounts.inlog, box-rij 1x/dag, bericht aan David
    //    (TOKEN_DAVID_NA_PROEF_MS 0, buiten 23-7 uur); geslaagde meting zet de stand terug. Niets geschreven naar mk_tank_schrijf bij 401.
    const berichtLog = path.join(W, 'bericht.log');
    fs.writeFileSync(path.join(W, 'bin', 'nep-bericht'), 'import json, os, sys\nf = ' + JSON.stringify(path.join(W, 'faal')) + '\nif os.path.exists(f):\n    os.remove(f); sys.exit(1)\nopen(' + JSON.stringify(berichtLog) + ', "a").write(json.dumps(sys.argv[1:]) + "\\n")\n', { mode: 0o755 });   // de pod start het met python3
    const iw = maakServer('s7', vrijePoort(), { CLAUDE_OAUTH_TOKEN_2: T2, TOKEN_WACHT_PROEF: path.join(W, 'bin', 'nep-bericht'), TOKEN_DAVID_NA_PROEF_MS: '0' }); alle.push(iw);
    fs.mkdirSync(path.join(iw.d, 'vault', '00_Systeem', 'Meldingen'), { recursive: true });
    fs.copyFileSync('vault-veilig.js', path.join(iw.d, 'vault-veilig.js'));   // ovisBoxRij laadt hem naast server.js
    fs.writeFileSync(path.join(iw.d, 'vault', '00_Systeem', 'Meldingen', 'machinekamer.md'), '# Box\n\n## [direct] 2026-11-01 10:00 — oude rij\n- status: open\n');
    await wachtOp(iw);
    weiger = new Set([1, 2]); tankRijen = [];
    fs.writeFileSync(path.join(W, 'faal'), '');   // eerste bericht (account 1) mislukt: daarna opnieuw proberen (review MOET 1)
    const i1 = await req(iw, 'GET', '/tank?verversen=1');
    await slaap(600);
    h = await req(iw, 'GET', '/health');
    toets('I mislukt bericht: account 1 nog niet gemeld', h.accounts.inlog['1'] && h.accounts.inlog['1'].david_gemeld === false || !(Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false })) >= 7), JSON.stringify(h.accounts.inlog));
    const i2 = await req(iw, 'GET', '/tank?account=2&verversen=1');
    await req(iw, 'GET', '/tank?verversen=1');   // tweede 401 op dezelfde dag: geen tweede box-rij, geen tweede bericht
    toets('I 401 account 1: 503, fout inlog geweigerd', i1._status === 503 && i1.ok === false && i1.http === 401 && /inlog geweigerd/.test(i1.fout), JSON.stringify(i1));
    toets('I 401 account 2: 503, fout inlog geweigerd', i2._status === 503 && i2.account === 2 && /inlog geweigerd/.test(i2.fout), JSON.stringify(i2));
    toets('I 401: niets naar mk_tank_schrijf', !tankRijen.length, JSON.stringify(tankRijen));
    h = await req(iw, 'GET', '/health');
    const inl = h.accounts && h.accounts.inlog;
    toets('I /health accounts.inlog noemt beide', inl && inl['1'] && inl['2'] && inl['1'].http === 401 && /authentication_error/.test(inl['1'].soort), JSON.stringify(inl));
    toets('I /health lekt geen token', !/NEP[12]/.test(JSON.stringify(h)));
    await slaap(800);
    h = await req(iw, 'GET', '/health');
    const ber0 = fs.existsSync(berichtLog) ? fs.readFileSync(berichtLog, 'utf8') : '';
    toets('I na geslaagd bericht: david_gemeld waar', !ber0 || (h.accounts.inlog['1'].david_gemeld === true && h.accounts.inlog['2'].david_gemeld === true), JSON.stringify(h.accounts.inlog));
    const box = fs.readFileSync(path.join(iw.d, 'vault', '00_Systeem', 'Meldingen', 'machinekamer.md'), 'utf8');
    toets('I box: precies één rij per account', (box.match(/Claude-inlog account 1 geweigerd/g) || []).length === 1 && (box.match(/Claude-inlog account 2 geweigerd/g) || []).length === 1, box.slice(0, 300));
    toets('I box: nieuwe rijen boven de oude', box.indexOf('Claude-inlog account') > -1 && box.indexOf('Claude-inlog account') < box.indexOf('oude rij'));
    const uurNL = Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false }));
    const ber = fs.existsSync(berichtLog) ? fs.readFileSync(berichtLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    if (uurNL >= 7 && uurNL < 23) {
      toets('I bericht: één per account, met sleutel', ber.length === 2 && ber.some((x) => x.includes('inlog-account-1')) && ber.some((x) => x.includes('inlog-account-2')), JSON.stringify(ber).slice(0, 300));
      toets('I bericht account 1 noemt setup-token en herstart', ber.some((x) => x.includes('inlog-account-1') && /claude setup-token/.test(x[x.length - 1]) && /herstart/.test(x[x.length - 1])));
    } else toets('I bericht: stille uren, niets', ber.length === 0, JSON.stringify(ber));
    weiger = new Set(); tankRijen = [];
    const i3 = await req(iw, 'GET', '/tank?verversen=1');
    const i4 = await req(iw, 'GET', '/tank?account=2&verversen=1');
    h = await req(iw, 'GET', '/health');
    toets('I herstel: meting weer ok en inlog-stand leeg', i3.ok === true && i4.ok === true && h.accounts.inlog['1'] === null && h.accounts.inlog['2'] === null, JSON.stringify(h.accounts.inlog));
    toets('I herstel staat in het log', /"soort":"inlog-hersteld"/.test(fs.readFileSync(path.join(iw.d, 'api.log'), 'utf8')));
    stop(iw);

    // F. geen token 2 (geen env, geen kluisroute): agents op 1, /tank?account=2 geeft 503 met reden, /tank zonder account ongemoeid
    const g = maakServer('s4', vrijePoort(), {}); alle.push(g); await wachtOp(g);
    const g1 = await agent(g, 'SLEUTEL:ga'); await rapportVoor(g1.job_id, 15000);
    toets('F zonder token 2: agent op account 1', (spawns().find((x) => x.sleutel === 'ga') || {}).acc === 1);
    const t2 = await req(g, 'GET', '/tank?account=2');
    toets('F /tank?account=2 zonder token: 503 met reden', t2._status === 503 && t2.account === 2 && /niet beschikbaar/.test(String(t2.fout)), JSON.stringify(t2));
    h = await req(g, 'GET', '/health');
    toets('F /health: token2 false, bezwaar "geen token"', h.accounts && h.accounts.token2 === false && h.accounts.bezwaar2 === 'geen token');
    stop(g);
  } catch (e) { console.log('ROOD  onverwachte fout: ' + (e && e.stack || e)); fout++; }
  alle.forEach(stop); hook.close();
  console.log(fout ? 'ROOD: ' + fout + ' toets(en) mislukt' : 'ALLES GROEN'); process.exit(fout ? 1 : 0);
})();
JS
