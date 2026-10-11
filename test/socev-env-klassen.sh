#!/usr/bin/env bash
# Toetst wv424 (A1, 11-10-2026): Socev buiten de machinekamer zonder beheersleutels. Zelfde opzet als auto-env-allowlist.sh
# (kopie van de ECHTE server.js, nep-`claude` die de namen in zijn omgeving opschrijft, geen taalmodel):
#  - /run hoofdkanaal 40687, app/Telegram en een lege of onbekende sessie: geen N8N_API_KEY/N8N_MCP_TOKEN/API_SECRET/SERVICE_ROLE;
#  - /run telegram-debug (machinekamer): wel;
#  - /agent met API_SECRET en label machinekamer:: wel; met SOCEV_AGENT_SLEUTEL en label machinekamer:: niet;
#  - SOCEV_AGENT_SLEUTEL opent /result alleen voor de eigen smalle agent en niets anders; een verkeerde sleutel = 401.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'socevenv-'));
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; };
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(path.join(W, 'bin'));
fs.writeFileSync(path.join(W, 'bin', 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), prompt = a[a.length - 1];
const sid = a.includes('--session-id') ? a[a.indexOf('--session-id') + 1] : (a.includes('--resume') ? a[a.indexOf('--resume') + 1] : 'GEEN-ID');
const sleutel = (/SLEUTEL:([a-z0-9]+)/.exec(prompt) || [])[1] || 'x';
const proj = path.join(process.env.HOME || '/tmp', '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, sid + '.jsonl'), '{}\\n');
fs.appendFileSync(${JSON.stringify(path.join(W, 'spawns.log'))}, JSON.stringify({ sleutel, args: a, env: Object.keys(process.env).sort() }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'KLAAR ' + sleutel, session_id: sid }));
`, { mode: 0o755 });

// Rol-RPC nabootsen (8-10-2026, wv216): sinds de uitwijk start /agent alleen als primair; zonder ontvanger las de server de
// echte SUPABASE_URL met een nepsleutel, bleef passief en antwoordde 'passief' (6x rood, ook op main).
const rpc = http.createServer((q, s) => { q.resume(); q.on('end', () => {
  if (q.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return s.end(JSON.stringify([{ actieve_kant: 'olares', sinds: null }]));
  s.end('[]'); }); });
const d = path.join(W, 'srv');
['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
fs.writeFileSync(path.join(d, 'server.js'), fs.readFileSync('server.js', 'utf8')
  .split('const AGENT_START_SPREIDING_MS = 20 * 1000;').join('const AGENT_START_SPREIDING_MS = 500;'));
const poort = vrijePoort();
const geheim = { GEHEIM_NEP: 'x', TELEGRAM_SESSIE: 'x', VAULT_BACKUP_CRYPT_WACHTWOORD: 'x', GEMINI_API_KEY_AUTO: 'x',
  CLOUDFLARE_AI_TOKEN_AUTO: 'x', N8N_API_KEY: 'x', N8N_WEBHOOK_SMS: 'x', N8N_WEBHOOK_SOCEV_AGENDA: 'x', N8N_WEBHOOK_MAILCONCEPT: 'x',
  SUPABASE_MCP_TOKEN: 'x', SUPABASE_SERVICE_ROLE: 'x', TELEGRAM_DEBUG_BOT_TOKEN: 'x', GIT_REPO_URL: 'x',
  N8N_MCP_TOKEN: 'x', AGENT_WEBHOOK_SECRET: 'x', CLOUDFLARE_API_TOKEN: 'x', CLOUDFLARE_TUNNEL_TOKEN_OLARES: 'x', TELEGRAM_API_HASH: 'x' };
const mag = { N8N_WEBHOOK_AGENDA_API: 'x', N8N_WEBHOOK_WERKROOSTER: 'x', N8N_WEBHOOK_WHATSAPP: 'x', SUPABASE_RPC_CONTACTEN: 'x',
  SUPABASE_RPC_NIEUW: 'x', N8N_WEBHOOK_SMS: 'x', N8N_WEBHOOK_SOCEV_AGENDA: 'x', N8N_WEBHOOK_MAILCONCEPT: 'x', WERKKAMER_SLEUTEL_POD: 'x',
  TODOIST_MCP_TOKEN: 'x', TZ: 'Europe/Amsterdam', CLAUDE_CODE_OAUTH_TOKEN: 'nep-inlog' };
const start = () => {
const env = Object.assign({}, process.env, geheim, mag, {
  HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: path.join(d, 'app-data'), APP_UIT_BESTAND: path.join(d, 'app-uit'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'),
  JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
  RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
  OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '6',
  ROL_BESTAND: path.join(d, 'rol'), UITROL_MARKER: path.join(d, 'uitrol-wacht'),
  SUPABASE_URL: 'http://127.0.0.1:' + rpc.address().port, SOCEV_KANT: 'olares',
  PORT: String(poort), PATH: path.join(W, 'bin') + ':' + process.env.PATH });
delete env.AGENT_WEBHOOK_URL; delete env.SOCEV_AGENT_RUN;
return spawn(process.execPath, [path.join(d, 'server.js')], { env, detached: true, stdio: ['ignore', fs.openSync(path.join(d, 'stdout.log'), 'a'), fs.openSync(path.join(d, 'stdout.log'), 'a')] });
};
let p = null;
const req = (methode, pad, body) => new Promise((ok, nok) => {
  const r = http.request({ host: '127.0.0.1', port: poort, path: pad, method: methode, headers: { 'content-type': 'application/json' } }, (res) => {
    let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = { raw: b }; } j._status = res.statusCode; ok(j); });
  });
  r.on('error', nok); if (body) r.write(JSON.stringify(body)); r.end();
});
const spawns = () => { try { return fs.readFileSync(path.join(W, 'spawns.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } };
async function wachtOp(sl) { for (let i = 0; i < 100; i++) { const s = spawns().find((x) => x.sleutel === sl); if (s) return s; await slaap(200); } return null; }
const agent = (sl, extra) => req('POST', '/agent', Object.assign({ secret: 'proef', label: 'proef ' + sl, prompt: 'SLEUTEL:' + sl, chat_id: '40687', workspace: 'vault' }, extra));


const run = (sl, chat, extra) => req('POST', '/run', Object.assign({ secret: 'proef', prompt: 'SLEUTEL:' + sl, chat_id: chat }, extra));
const BEHEER = ['N8N_API_KEY', 'N8N_MCP_TOKEN', 'API_SECRET', 'AGENT_WEBHOOK_SECRET', 'SUPABASE_SERVICE_ROLE', 'SUPABASE_MCP_TOKEN',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_TUNNEL_TOKEN_OLARES', 'TELEGRAM_DEBUG_BOT_TOKEN', 'TELEGRAM_API_HASH', 'TELEGRAM_SESSIE',
  'VAULT_BACKUP_CRYPT_WACHTWOORD', 'GEHEIM_NEP', 'GIT_REPO_URL', 'GEMINI_API_KEY_AUTO'];
const lekVan = (s) => BEHEER.filter((k) => s && s.env.includes(k));
const crypto = require('crypto');
const SMAL = crypto.createHmac('sha256', 'proef').update('wv424-socev-agent').digest('hex');

rpc.listen(0, '127.0.0.1', async function () {
  try {
    p = start();
    for (let i = 0; i < 50; i++) { try { await req('GET', '/health'); break; } catch (e) { await slaap(200); } }
    let h = {};
    for (let i = 0; i < 50; i++) { h = await req('GET', '/health'); if (h.rol === 'primair') break; await slaap(200); }
    toets('(opzet) pod is primair via de nagebootste rol-RPC', h.rol === 'primair', String(h.rol));

    // A. Hoofdkanaal 40687 (Telegram, app, heartbeat, nachtconsolidatie): smal.
    await run('ha', '40687');
    const sa = await wachtOp('ha');
    toets('A hoofdkanaal 40687: geen N8N_API_KEY/N8N_MCP_TOKEN/API_SECRET/SERVICE_ROLE of andere beheersleutel', sa && lekVan(sa).length === 0, sa ? lekVan(sa).join(',') : 'geen spawn');
    const nodig = Object.keys(mag).concat(['HOME', 'PATH', 'OUTDIR', 'SOCEV_AGENT_SLEUTEL']).filter((k) => !(sa && sa.env.includes(k)));
    toets('A hoofdkanaal houdt de skill-luiken (sms, agenda-voorstel, mailconcept, Todoist, forum, RPC-voorvoegsel) en de agent-sleutel', sa && nodig.length === 0, nodig.join(','));

    // B. Lege sessie (nachtwachters zonder chat_id) en een onbekende sessie: smal.
    await run('hb', '');
    await run('hc', 'iets-nieuws-' + Date.now());
    const sb = await wachtOp('hb'), sc = await wachtOp('hc');
    toets('B /run zonder chat_id: smal', sb && lekVan(sb).length === 0, sb ? lekVan(sb).join(',') : 'geen spawn');
    toets('B /run met onbekende sessie: smal (fout valt naar minder rechten)', sc && lekVan(sc).length === 0, sc ? lekVan(sc).join(',') : 'geen spawn');

    // C. Extra per sessie: personeels-wachter krijgt alleen de Supabase-MCP erbij.
    await run('hd', 'personeels-wachter');
    const sd = await wachtOp('hd');
    toets('C personeels-wachter: SUPABASE_MCP_TOKEN wel, de rest van de beheersleutels niet', sd && sd.env.includes('SUPABASE_MCP_TOKEN') && lekVan(sd).filter((k) => k !== 'SUPABASE_MCP_TOKEN').length === 0, sd ? lekVan(sd).join(',') : 'geen spawn');

    // D. Machinekamer-sessie: volledige omgeving.
    await run('he', 'telegram-debug');
    const se = await wachtOp('he');
    toets('D machinekamer telegram-debug: wel N8N_API_KEY, N8N_MCP_TOKEN, API_SECRET, SUPABASE_SERVICE_ROLE', se && ['N8N_API_KEY', 'N8N_MCP_TOKEN', 'API_SECRET', 'SUPABASE_SERVICE_ROLE'].every((k) => se.env.includes(k)), se ? lekVan(se).join(',') : 'geen spawn');
    await run('hf', 'telegram-debug', { workspace: 'ghawa' });
    const sf = await wachtOp('hf');
    toets('D telegram-debug in een andere werkruimte (ghawa): smal', sf && lekVan(sf).length === 0, sf ? lekVan(sf).join(',') : 'geen spawn');

    // E. Agents.
    const e1 = await agent('ag', { label: 'machinekamer: proef ag' });
    const sg = await wachtOp('ag');
    toets('E agent met API_SECRET + machinekamer:: volledige omgeving, /agent zegt omgeving mk', e1.omgeving === 'mk' && sg && sg.env.includes('N8N_API_KEY') && sg.env.includes('API_SECRET'), JSON.stringify(e1).slice(0, 160));
    const e2 = await agent('ah', { label: 'machinekamer: proef ah', secret: SMAL });
    const sh = await wachtOp('ah');
    toets('E agent met SOCEV_AGENT_SLEUTEL + label machinekamer:: smal', e2.ok && e2.omgeving === 'smal' && sh && lekVan(sh).length === 0, (sh ? lekVan(sh).join(',') : 'geen spawn') + ' ' + JSON.stringify(e2).slice(0, 120));
    const e3 = await agent('ai', { label: 'david: proef ai' });
    const si = await wachtOp('ai');
    toets('E agent met API_SECRET zonder machinekamer:-label (Socev-klus van de tikker): smal', e3.omgeving === 'smal' && si && lekVan(si).length === 0, si ? lekVan(si).join(',') : 'geen spawn');
    await agent('al', { label: 'proef al', secret: SMAL, chat_id: 'personeels-wachter' });
    const sl = await wachtOp('al');
    toets('E smalle agent met chat_id personeels-wachter: geen SUPABASE_MCP_TOKEN (EXTRA alleen voor /run)', sl && lekVan(sl).length === 0, sl ? lekVan(sl).join(',') : 'geen spawn');
    const ej = await req('POST', '/agent', { secret: 'é'.repeat(64), label: 'x', prompt: 'SLEUTEL:am' });
    toets('E sleutel met niet-ASCII van de goede lengte: 401, geen hangend antwoord', ej._status === 401, String(ej._status));
    const e4 = await agent('aj', { label: 'machinekamer: proef aj', secret: SMAL.slice(0, 63) + (SMAL[63] === '0' ? '1' : '0') });
    toets('E verkeerde agent-sleutel: 401', e4._status === 401, String(e4._status));
    const e5 = await req('POST', '/run', { secret: SMAL, prompt: 'SLEUTEL:ak', chat_id: 'telegram-debug' });
    toets('E agent-sleutel opent /run niet (401)', e5._status === 401, String(e5._status));

    // F. /result: agent-sleutel alleen voor de eigen smalle agent.
    for (let i = 0; i < 50; i++) { const ag = await req('GET', '/agents'); const x = (ag.agents || []).find((a) => a.job_id === e2.job_id); if (x && x.status === 'done') break; await slaap(200); }
    const r1 = await req('POST', '/result', { secret: SMAL, job_id: e2.job_id });
    toets('F /result met agent-sleutel voor de eigen smalle agent: gevonden', r1._status === 200 && r1.found === true, JSON.stringify(r1).slice(0, 120));
    const r2 = await req('POST', '/result', { secret: SMAL, job_id: e1.job_id });
    toets('F /result met agent-sleutel voor een machinekamer-agent: 401', r2._status === 401, String(r2._status));
    const ag = await req('GET', '/agents');
    const kl = {}; (ag.agents || []).forEach((a) => { kl[a.label] = a.omgeving; });
    toets('F /agents toont de klasse (mk/smal) zonder inhoud', kl['machinekamer: proef ag'] === 'mk' && kl['machinekamer: proef ah'] === 'smal', JSON.stringify(kl));
  } catch (e) { console.log('ROOD  toets brak af: ' + (e && e.stack)); fout++; }
  try { p && process.kill(-p.pid, 'SIGKILL'); } catch (e) {}
  rpc.close();
  console.log(fout ? ('\n' + fout + ' ROOD — werkmap ' + W) : '\nALLES GROEN');
  if (!fout) fs.rmSync(W, { recursive: true, force: true });
  process.exit(fout ? 1 : 0);
});
JS
