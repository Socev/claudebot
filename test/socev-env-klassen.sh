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
const klaar = () => process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'KLAAR ' + sleutel, session_id: sid }));
// wv1030: PASPROEF = tijdens de beurt de eigen beurtpas gebruiken (zoals wachter-state.py/zd.py) en de antwoorden opschrijven.
if (!/PASPROEF/.test(prompt)) klaar();
else {
  const http = require('http');
  let pas = null; try { pas = fs.readFileSync(path.join(path.dirname(process.env.OUTDIR), 'beurtpas'), 'utf8'); } catch (e) {}
  const beurt = process.env.SOCEV_BEURT;
  const post = (pad, body) => new Promise((ok) => { const r = http.request({ host: '127.0.0.1', port: process.env.PORT, path: pad, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = {}; } ok({ s: res.statusCode, j }); }); }); r.on('error', () => ok({ s: -1 })); r.end(JSON.stringify(Object.assign({ secret: pas, beurt }, body))); });
  (async () => {
    const u = { pas: !!pas, beurt, env_pas: Object.keys(process.env).filter((k) => /PAS/.test(k)) };
    u.state_lees = await post('/smal/state', { tabel: 'personeel', actie: 'lees' });
    u.state_zet = await post('/smal/state', { tabel: 'personeel', actie: 'zet', rijen: [{ item_id: 'a', toelichting: "met 'apostrof' en $w$" }] });
    u.state_ander = await post('/smal/state', { tabel: 'concierge', actie: 'lees' });
    u.sync = await post('/smal/sync-fouten', {});
    u.zd_lees = await post('/smal/zorgdata', { sql: 'select code from v_actueel limit 3' });
    u.zd_schrijf = await post('/smal/zorgdata', { sql: 'with x as (delete from waarden returning 1) select * from x' });
    u.zd_catalogus = await post('/smal/zorgdata', { sql: 'select prosrc from pg_catalog.pg_proc' });
    u.zd_schema = await post('/smal/zorgdata', { sql: "select public.sb_contacten_zoek('x') from waarden w" });
    u.zd_log = await post('/smal/zorgdata', { log: { afzender: 'proef', kanaal: 'app', vraag: 'hoeveel?', antwoordkern: '42' } });
    u.les = await post('/smal/les', { lessen: { kort: 'een les van tien tekens of meer' } });
    u.fin = await post('/smal/fin-sql', { sql: 'select 1' });
    u.ander_beurt = await post('/smal/state', { tabel: 'personeel', actie: 'lees', beurt: 'abcdef0123456789' });
    fs.writeFileSync(${JSON.stringify(W)} + '/pasproef-' + sleutel + '.json', JSON.stringify(Object.assign(u, { pas_waarde: pas })));
    klaar();
  })();
}
`, { mode: 0o755 });

// Rol-RPC nabootsen (8-10-2026, wv216): sinds de uitwijk start /agent alleen als primair; zonder ontvanger las de server de
// echte SUPABASE_URL met een nepsleutel, bleef passief en antwoordde 'passief' (6x rood, ook op main).
const rapporten = [], cfVragen = [], lesRpc = [], mgmt = [];
const rpc = http.createServer((q, s) => { let b = ''; q.on('data', (c) => b += c); q.on('end', () => {
  if (q.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return s.end(JSON.stringify([{ actieve_kant: 'olares', sinds: null }]));
  if (q.url === '/rest/v1/rpc/mk_les_vast') { lesRpc.push(JSON.parse(b || '{}')); return s.end(String(100 + lesRpc.length)); }   // wv424b
  if (q.url === '/rest/v1/rpc/mk_les_zonder_embedding') return s.end(JSON.stringify(lesRpc.map((x, i) => ({ uit_id: 101 + i, uit_tekst: x.p_kort }))));
  if (q.url === '/rest/v1/rpc/mk_les_embedding_zet') { const r = JSON.parse(b || '{}'); return s.end(JSON.stringify([{ uit_bijgewerkt: (r.p_rijen || []).length }])); }
  if (q.url.indexOf('/ai/run/') > 0) { const r = JSON.parse(b || '{}'); return s.end(JSON.stringify({ success: true, result: { data: (r.text || []).map(() => new Array(1024).fill(0.01)) } })); }
  if (q.url === '/agentrapport') { try { rapporten.push(JSON.parse(b)); } catch (e) {} return s.end('{}'); }   // wv424b #9
  if (q.url === '/v1/projects/proef/database/query') {   // wv1030: nep-Management-API voor /smal/state en /smal/zorgdata
    const sql = (JSON.parse(b || '{}').query) || ''; mgmt.push({ sql, auth: q.headers.authorization });
    if (/_state_zet\(/.test(sql)) return s.end(JSON.stringify([{ uit: { ok: true, bijgewerkt: ['a'], nieuw: [] } }]));
    if (/json_agg\(t order by/.test(sql)) return s.end(JSON.stringify([{ uit: [{ item_id: 'a' }] }]));
    if (/zd_sql_lees/.test(sql)) return s.end(JSON.stringify([{ uit: [{ code: 'bevolking_nl' }] }]));
    if (/zd_log_vraag/.test(sql)) return s.end(JSON.stringify([{ uit: 7 }]));
    s.statusCode = 400; return s.end(JSON.stringify({ message: 'onbekende proefquery' }));
  }
  if (q.url.indexOf('/client/v4/') === 0) {   // wv424b: nep-Cloudflare voor /smal/vault-zoek en /smal/fin-sql
    cfVragen.push({ url: q.url, auth: q.headers.authorization, body: JSON.parse(b || '{}') });
    if (q.url.indexOf('/d1/database/') > 0) return s.end(JSON.stringify({ success: true, result: [{ results: [{ een: 1 }] }] }));
    return s.end(JSON.stringify({ success: true, result: { chunks: [{ score: 0.5, text: 'x', item: { key: 'vault/a.md' } }] } }));
  }
  s.end('[]'); }); });
const d = path.join(W, 'srv');
['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
fs.writeFileSync(path.join(d, 'server.js'), fs.readFileSync('server.js', 'utf8')
  .split('const AGENT_START_SPREIDING_MS = 20 * 1000;').join('const AGENT_START_SPREIDING_MS = 500;'));
const poort = vrijePoort();
// wv424b: nep-telegram-reader.js schrijft alleen op wat hij kreeg (args, NAMEN uit de omgeving).
fs.writeFileSync(path.join(W, 'tg.js'), `require('fs').writeFileSync(${JSON.stringify(path.join(W, 'tg.uit'))}, JSON.stringify({ args: process.argv.slice(2), env: Object.keys(process.env) })); console.log('dialogen-lijst');`);
const geheim = { GEHEIM_NEP: 'x', TELEGRAM_SESSIE: 'x', VAULT_BACKUP_CRYPT_WACHTWOORD: 'x', GEMINI_API_KEY_AUTO: 'x', ANTHROPIC_API_KEY_AUTO: 'x',
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
delete env.SOCEV_AGENT_RUN;
env.AGENT_WEBHOOK_URL = 'http://127.0.0.1:' + rpc.address().port + '/agentrapport';   // wv424b #9: payload vangen
env.SMAL_CF_BASIS = 'http://127.0.0.1:' + rpc.address().port; env.SMAL_SB_MGMT = 'http://127.0.0.1:' + rpc.address().port; env.SMAL_TG_SCRIPT = path.join(W, 'tg.js');
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

    // C. wv1030: personeels-wachter krijgt geen beheersleutel meer (ook geen SUPABASE_MCP_TOKEN), wel een beurtpas in zijn jobmap.
    //    Alleen design-/ui-manager houden SOCEV_ENV_EXTRA (3f van mk-scripts/wv1030/ontwerp.md).
    const c0 = await run('hd PASPROEF', 'personeels-wachter');
    const sd = await wachtOp('hd');
    toets('C personeels-wachter: geen enkele beheersleutel (ook geen SUPABASE_MCP_TOKEN) en geen pas in de omgeving', sd && lekVan(sd).length === 0 && !sd.env.some((k) => /PAS/.test(k)), sd ? lekVan(sd).join(',') : 'geen spawn');
    let pw = null; for (let i = 0; i < 50 && !pw; i++) { try { pw = JSON.parse(fs.readFileSync(path.join(W, 'pasproef-hd.json'), 'utf8')); } catch (e) { await slaap(200); } }
    const nZet = mgmt.find((x) => /personeel_state_zet/.test(x.sql)) || {};
    toets('H personeels-wachter: beurtpas in de jobmap; state personeel lees 200 + zet 200 (dollar-quote, PAT van de pod)',
      pw && pw.pas && pw.state_lees.s === 200 && pw.state_lees.j.rijen[0].item_id === 'a' && pw.state_zet.s === 200 && pw.state_zet.j.ok === true
      && /^select secondbrain\.personeel_state_zet\(\$w[0-9a-f]{12}\$\[\{"item_id":"a","toelichting":"met 'apostrof' en \$w\$"\}\]\$w[0-9a-f]{12}\$::jsonb\) as uit$/.test(nZet.sql) && nZet.auth === 'Bearer x',
      pw ? JSON.stringify({ l: pw.state_lees, z: pw.state_zet, sql: nZet.sql }).slice(0, 300) : 'geen pasproef');
    toets('H personeels-wachter: andere tabel, sync, zorgdata, les en fin-sql 403; pas met een andere beurt 401',
      pw && pw.state_ander.s === 403 && pw.sync.s === 403 && pw.zd_lees.s === 403 && pw.les.s === 403 && pw.fin.s === 403 && pw.ander_beurt.s === 401,
      pw ? [pw.state_ander.s, pw.sync.s, pw.zd_lees.s, pw.les.s, pw.fin.s, pw.ander_beurt.s].join(',') : '');
    for (let i = 0; i < 50; i++) { const rr = await req('POST', '/result', { secret: 'proef', job_id: c0.job_id }); if (rr.found && rr.status === 'done') break; await slaap(200); }
    const naAfloop = pw ? await req('POST', '/smal/state', { secret: pw.pas_waarde, beurt: pw.beurt, tabel: 'personeel', actie: 'lees' }) : {};
    toets('H beurtpas na afloop van de beurt: 401', naAfloop._status === 401, String(naAfloop._status));
    await run('hz PASPROEF', 'cijfer-meester');
    let cm = null; for (let i = 0; i < 50 && !cm; i++) { try { cm = JSON.parse(fs.readFileSync(path.join(W, 'pasproef-hz.json'), 'utf8')); } catch (e) { await slaap(200); } }
    const nZd = mgmt.find((x) => /zd_sql_lees/.test(x.sql)) || {}, nLog = mgmt.find((x) => /zd_log_vraag/.test(x.sql)) || {};
    toets('H cijfer-meester: zorgdata lezen 200 via zd_sql_lees met time-out, log 200; schrijf-CTE en catalogus 403 (niets naar de databank)',
      cm && cm.zd_lees.s === 200 && cm.zd_lees.j.rijen[0].code === 'bevolking_nl' && /^set local statement_timeout = '15s'; select public\.zd_sql_lees\(\$w[0-9a-f]{12}\$select code from v_actueel limit 3\$w[0-9a-f]{12}\$\) as uit$/.test(nZd.sql)
      && cm.zd_log.s === 200 && /"vraag":"hoeveel\?","antwoord_kern":"42"/.test(nLog.sql) && cm.zd_schrijf.s === 403 && cm.zd_catalogus.s === 403 && cm.zd_schema.s === 403
      && mgmt.filter((x) => /delete|pg_proc/.test(x.sql)).length === 0,
      cm ? JSON.stringify({ l: cm.zd_lees.s, lg: cm.zd_log.s, w: cm.zd_schrijf.s, c: cm.zd_catalogus.s, sql: nZd.sql }).slice(0, 300) : 'geen pasproef');
    toets('H cijfer-meester: state, sync en les 403', cm && cm.state_lees.s === 403 && cm.sync.s === 403 && cm.les.s === 403, cm ? [cm.state_lees.s, cm.sync.s, cm.les.s].join(',') : '');
    const hs = await req('POST', '/smal/state', { secret: SMAL, tabel: 'personeel', actie: 'lees' });
    const hz = await req('POST', '/smal/zorgdata', { secret: SMAL, sql: 'select 1' });
    toets('H agent-sleutel (elk smal gesprek) opent state en zorgdata niet: 403', hs._status === 403 && hz._status === 403, hs._status + ',' + hz._status);
    const hm = await req('POST', '/smal/state', { secret: 'proef', tabel: 'concierge', actie: 'lees' });
    const hm2 = await req('POST', '/smal/state', { secret: 'proef', tabel: 'structuur', actie: 'lees' });
    toets('H machinekamer (API_SECRET): state concierge 200; onbekende tabel 400', hm._status === 200 && hm2._status === 400, hm._status + ',' + hm2._status);
    await agent('hy PASPROEF', { label: 'proef hy', secret: SMAL, chat_id: 'cijfer-meester' });
    let ay = null; for (let i = 0; i < 50 && !ay; i++) { try { ay = JSON.parse(fs.readFileSync(path.join(W, 'pasproef-hy.json'), 'utf8')); } catch (e) { await slaap(200); } }
    toets('H smalle agent met chat_id cijfer-meester: geen beurtpas, zorgdata 401', ay && !ay.pas && ay.zd_lees.s === 401, ay ? String(ay.zd_lees.s) : 'geen pasproef');

    // D. Machinekamer-sessie: volledige omgeving.
    await run('he', 'telegram-debug');
    const se = await wachtOp('he');
    toets('D machinekamer telegram-debug: wel N8N_API_KEY, N8N_MCP_TOKEN, API_SECRET, SUPABASE_SERVICE_ROLE', se && ['N8N_API_KEY', 'N8N_MCP_TOKEN', 'API_SECRET', 'SUPABASE_SERVICE_ROLE'].every((k) => se.env.includes(k)), se ? lekVan(se).join(',') : 'geen spawn');
    toets('D telegram-debug: houdt SUPABASE_MCP_TOKEN (MK_ENV_WEG geldt alleen per genoemde sessie)', se && se.env.includes('SUPABASE_MCP_TOKEN'), se ? '' : 'geen spawn');
    // wv640: n8n-git-backup = volle omgeving min MK_ENV_WEG (geen beheer-PAT), de rest van wat het script nodig heeft blijft.
    await run('hgb', 'n8n-git-backup');
    const sgb = await wachtOp('hgb');
    const gbNodig = ['N8N_API_KEY', 'N8N_MCP_TOKEN', 'API_SECRET', 'SUPABASE_SERVICE_ROLE', 'SUPABASE_URL', 'TELEGRAM_DEBUG_BOT_TOKEN', 'CLOUDFLARE_API_TOKEN'];
    toets('D n8n-git-backup: geen SUPABASE_MCP_TOKEN, wel N8N_API_KEY/N8N_MCP_TOKEN/API_SECRET/SERVICE_ROLE/SUPABASE_URL en de andere geheimen (poortdekking)',
      sgb && !sgb.env.includes('SUPABASE_MCP_TOKEN') && gbNodig.every((k) => sgb.env.includes(k)), sgb ? gbNodig.filter((k) => !sgb.env.includes(k)).concat(sgb.env.includes('SUPABASE_MCP_TOKEN') ? ['PAT!'] : []).join(',') : 'geen spawn');
    const verschil = se && sgb ? se.env.filter((k) => !sgb.env.includes(k)).concat(sgb.env.filter((k) => !se.env.includes(k)).map((k) => '+' + k)) : ['geen spawn'];
    toets('D n8n-git-backup = omgeving van telegram-debug min precies SUPABASE_MCP_TOKEN (review wv640 #4)', verschil.length === 1 && verschil[0] === 'SUPABASE_MCP_TOKEN', verschil.join(','));
    await run('hdm', 'data-manager');   // wv844: weekronde Data Manager draait als machinekamer
    const sdm = await wachtOp('hdm');
    toets('D data-manager: wel SUPABASE_MCP_TOKEN, N8N_API_KEY, CLOUDFLARE_API_TOKEN', sdm && ['SUPABASE_MCP_TOKEN', 'N8N_API_KEY', 'CLOUDFLARE_API_TOKEN'].every((k) => sdm.env.includes(k)), sdm ? lekVan(sdm).join(',') : 'geen spawn');
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

    // G. wv424b: smalle pod-routes (werkles, vault-zoek, fin-sql alleen lezen, telegram) en de klasse in het agentrapport.
    const g0 = await req('POST', '/smal/les', { lessen: { kort: 'een les van tien tekens of meer' } });
    const g0b = await req('POST', '/smal/les', { secret: SMAL.slice(0, 63) + (SMAL[63] === '0' ? '1' : '0'), lessen: { kort: 'een les van tien tekens of meer' } });
    toets('G /smal zonder of met verkeerde sleutel: 401', g0._status === 401 && g0b._status === 401, g0._status + ',' + g0b._status);
    const g1 = await req('POST', '/smal/les', { secret: SMAL, lessen: [{ kort: 'een les van tien tekens of meer', herkomst: 'David 14-10', domein: 'machine', vervangt_id: 7, draad_id: 3 }, { kort: 'tweede les, ook lang genoeg' }] });
    const l0 = lesRpc[0] || {}, l1 = lesRpc[1] || {};
    toets('G /smal/les: insert in server.js, domein altijd pa, geen vervangt_id/draad_id, herkomst gemerkt, beide geembed, notities terug',
      g1._status === 200 && g1.ok === true && g1.ids.join() === '101,102' && g1.ingebed === 2 && g1.notities.length === 2
      && l0.p_domein === 'pa' && l0.p_vervangt_id === null && l0.p_draad_id === null && l0.p_herkomst === 'David 14-10 (via /smal/les)'
      && l1.p_domein === 'pa' && l1.p_herkomst === '(via /smal/les)', JSON.stringify(g1).slice(0, 250));
    const g1b = await req('POST', '/smal/les', { secret: SMAL, lessen: Array.from({ length: 21 }, () => ({ kort: 'een les van tien tekens of meer' })) });
    const g1c = await req('POST', '/smal/les', { secret: SMAL, lessen: { kort: 'kort' } });
    toets('G /smal/les: meer dan 20 of een te korte les -> 400, niets geschreven', g1b._status === 400 && g1c._status === 400 && lesRpc.length === 2, [g1b._status, g1c._status, lesRpc.length].join());
    const g2 = await req('POST', '/smal/vault-zoek', { secret: SMAL, query: 'wie regelt de verzekering', max_num_results: 500 });
    const cv = cfVragen[cfVragen.length - 1] || {};
    toets('G /smal/vault-zoek: naar AI Search /search van vault met het pod-token, max 50 resultaten', g2._status === 200 && g2.success === true && /ai-search\/instances\/vault\/search$/.test(cv.url) && cv.auth === 'Bearer x' && cv.body.max_num_results === 50, JSON.stringify(cv).slice(0, 200));
    const nCf = cfVragen.length;
    const schrijf = ['DELETE FROM reeks', 'WITH a AS (SELECT 1) DELETE FROM reeks', 'SELECT 1; DROP TABLE reeks', 'INSERT INTO reeks VALUES (1)', 'select 1;\nupdate reeks set bedrag=0',
      'PRAGMA table_info(reeks)', 'REPLACE INTO reeks VALUES (1)', 'ATTACH DATABASE x AS y', ''];
    const gw = []; for (const q of schrijf) gw.push((await req('POST', '/smal/fin-sql', { secret: SMAL, sql: q }))._status);
    toets('G /smal/fin-sql: elke schrijf- of beheeropdracht 403, niets naar D1', gw.every((x) => x === 403) && cfVragen.length === nCf, gw.join(','));
    const g3 = await req('POST', '/smal/fin-sql', { secret: SMAL, sql: "SELECT jaar, replace(rubriek,'_',' ') r FROM reeks WHERE entiteit=? ;", params: ['TG'] });
    const cd = cfVragen[cfVragen.length - 1] || {};
    toets('G /smal/fin-sql: SELECT (ook met replace()) en params gaan door naar D1 fin', g3._status === 200 && g3.success === true && /\/d1\/database\/ffcb09ad/.test(cd.url) && cd.body.params[0] === 'TG' && !/;/.test(cd.body.sql), JSON.stringify(cd).slice(0, 200));
    const g4 = await req('POST', '/smal/telegram', { secret: SMAL, opdracht: 'lees', chat: '--help' });
    const g5 = await req('POST', '/smal/telegram', { secret: SMAL, opdracht: 'stuur', chat: 'x' });
    const g6 = await req('POST', '/smal/telegram', { secret: SMAL, opdracht: 'dialogen', aantal: 9999 });
    let tu = null; try { tu = JSON.parse(fs.readFileSync(path.join(W, 'tg.uit'), 'utf8')); } catch (e) {}
    toets('G /smal/telegram: vlag als chat 400, onbekende opdracht 400, dialogen met plafond 200; het kindproces krijgt alleen zijn eigen Telegram-sleutels',
      g4._status === 400 && g5._status === 400 && g6._status === 200 && /dialogen-lijst/.test(g6.stdout) && tu && tu.args.join(' ') === 'dialogen --aantal 200' && tu.env.includes('TELEGRAM_SESSIE') && !tu.env.includes('SUPABASE_SERVICE_ROLE') && !tu.env.includes('N8N_API_KEY') && !tu.env.includes('API_SECRET'), [g4._status, g5._status, g6._status, tu && tu.args.join(' ')].join(' | '));
    const g7 = await req('POST', '/smal/iets', { secret: SMAL });
    toets('G onbekende smalle route: 404', g7._status === 404, String(g7._status));
    const rp = {}; rapporten.forEach((r) => { rp[r.label] = r.omgeving; });
    toets('G agentrapport geeft de klasse mee (Fable #9): mk en smal', rp['machinekamer: proef ag'] === 'mk' && rp['machinekamer: proef ah'] === 'smal', JSON.stringify(rp));
    // wv1431 (review B1 PDF-lezer): geen enkele beurt of agent (hoofdkanaal, smal, machinekamer, /agent mk en smal) krijgt een
    // Anthropic-API-sleutel, -token of -basis in zijn omgeving; anders liep de claude-CLI op het API-tegoed in plaats van het abonnement.
    const alle = spawns();
    const anth = alle.filter((x) => x.env.some((k) => /^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)$/.test(k)));
    toets('B1 (wv1431): geen ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL in ' + alle.length + ' beurten en agents (ook met ANTHROPIC_API_KEY_AUTO in de pod-omgeving)', alle.length >= 8 && anth.length === 0, anth.map((x) => x.sleutel).join(','));
  } catch (e) { console.log('ROOD  toets brak af: ' + (e && e.stack)); fout++; }
  try { p && process.kill(-p.pid, 'SIGKILL'); } catch (e) {}
  rpc.close();
  console.log(fout ? ('\n' + fout + ' ROOD — werkmap ' + W) : '\nALLES GROEN');
  if (!fout) fs.rmSync(W, { recursive: true, force: true });
  process.exit(fout ? 1 : 0);
});
JS
