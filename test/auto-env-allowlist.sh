#!/usr/bin/env bash
# Toetst (5-10-2026, akkoord David): een achtergrondagent met beperkt=auto (spraakkastje) krijgt een omgeving op
# ALLOWLIST (AUTO_AGENT_ENV_MAG in server.js) in plaats van de oude denylist. Draait een kopie van de ECHTE server.js
# (startspreiding verkort) op een losse poort met een nep-`claude` vooraan in PATH die de namen in zijn omgeving
# opschrijft; geen taalmodel nodig. Toetst ook dat een gewone agent (zonder beperkt) zijn omgeving houdt.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'autoenv-'));
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
const poort = 18632;
const geheim = { GEHEIM_NEP: 'x', TELEGRAM_SESSIE: 'x', VAULT_BACKUP_CRYPT_WACHTWOORD: 'x', GEMINI_API_KEY_AUTO: 'x',
  CLOUDFLARE_AI_TOKEN_AUTO: 'x', N8N_API_KEY: 'x', N8N_WEBHOOK_SMS: 'x', N8N_WEBHOOK_SOCEV_AGENDA: 'x', N8N_WEBHOOK_MAILCONCEPT: 'x',
  WERKKAMER_SLEUTEL_POD: 'x', SUPABASE_MCP_TOKEN: 'x', SUPABASE_SERVICE_ROLE: 'x', TELEGRAM_DEBUG_BOT_TOKEN: 'x', GIT_REPO_URL: 'x' };
const mag = { N8N_WEBHOOK_AGENDA_API: 'x', N8N_WEBHOOK_WERKROOSTER: 'x', N8N_WEBHOOK_WHATSAPP: 'x', SUPABASE_RPC_CONTACTEN: 'x',
  TZ: 'Europe/Amsterdam', CLAUDE_CODE_OAUTH_TOKEN: 'nep-inlog' };
const start = () => {
const env = Object.assign({}, process.env, geheim, mag, {
  HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'),
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

rpc.listen(0, '127.0.0.1', async function () {
  try {
    p = start();
    for (let i = 0; i < 50; i++) { try { await req('GET', '/health'); break; } catch (e) { await slaap(200); } }
    let h = {};
    for (let i = 0; i < 50; i++) { h = await req('GET', '/health'); if (h.rol === 'primair') break; await slaap(200); }
    toets('(opzet) pod is primair via de nagebootste rol-RPC', h.rol === 'primair', String(h.rol));

    // A. beperkt=auto: alleen de allowlist (+ OUTDIR, ANTHROPIC_MODEL, agentmarker).
    const a = await agent('aa', { beperkt: 'auto' });
    toets('A start ok', a.ok && a.job_id, JSON.stringify(a).slice(0, 120));
    const sa = await wachtOp('aa');
    const ea = sa ? sa.env : [];
    const lek = Object.keys(geheim).filter((k) => ea.includes(k));
    toets('A geen geheime nepvariabele of sleutel in de omgeving', sa && lek.length === 0, lek.join(','));
    const mist = Object.keys(mag).concat(['HOME', 'PATH', 'OUTDIR', 'SOCEV_AGENT_RUN']).filter((k) => !ea.includes(k));
    toets('A toegestane variabelen (leesluiken, inlogtoken, HOME/PATH/TZ, OUTDIR, marker) wel aanwezig', sa && mist.length === 0, mist.join(','));
    const lijst = ['HOME', 'PATH', 'TZ', 'LANG', 'LC_ALL', 'TMPDIR', 'NODE_VERSION', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_EFFORT', 'PLAYWRIGHT_BROWSERS_PATH', 'VAULT_DIR', 'N8N_WEBHOOK_AGENDA_API', 'N8N_WEBHOOK_WERKROOSTER', 'N8N_WEBHOOK_WHATSAPP',
      'SUPABASE_RPC_CONTACTEN', 'OUTDIR', 'ANTHROPIC_MODEL', 'SOCEV_AGENT_RUN'];
    const vreemd = ea.filter((k) => lijst.indexOf(k) < 0);
    toets('A omgeving is een allowlist (niets onbekends)', sa && vreemd.length === 0, vreemd.join(','));
    toets('A verboden tools blijven (--disallowedTools)', sa && sa.args.includes('--disallowedTools'));

    // B. Gewone agent: omgeving ongewijzigd (geen allowlist voor andere aanroepers).
    await agent('bb');
    const sb = await wachtOp('bb');
    toets('B gewone agent houdt zijn omgeving', sb && sb.env.includes('GEHEIM_NEP') && sb.env.includes('N8N_API_KEY') && !sb.args.includes('--disallowedTools'));
  } catch (e) { console.log('ROOD  toets brak af: ' + (e && e.stack)); fout++; }
  try { p && process.kill(-p.pid, 'SIGKILL'); } catch (e) {}
  rpc.close();
  console.log(fout ? ('\n' + fout + ' ROOD — werkmap ' + W) : '\nALLES GROEN');
  if (!fout) fs.rmSync(W, { recursive: true, force: true });
  process.exit(fout ? 1 : 0);
});
JS
