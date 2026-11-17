#!/usr/bin/env bash
# Toetst (wv3248, 17-11-2026) de stille afloop van machinekamer:-agents. Draait de ECHTE server.js op een losse poort met
# een nep-`claude` (zelfde opzet als test/agent-start.sh) en een webhook-ontvanger als AI - Agent-rapport. Toetst:
#  S1 machinekamer:, geslaagd, eindtekst exact NIETS -> geen webhook, geen rapport.md in app-bestanden, register 'stil',
#     logregel agent-stil
#  S2 idem met "NIETS." en witruimte -> stil
#  S3 machinekamer:, gewone eindtekst -> webhook en rapport.md (zoals altijd)
#  S4 socev: (en zonder prefix) met NIETS -> webhook (Socev weegt dat zelf in n8n)
#  S5 machinekamer:, NIETS maar een bestand in OUTDIR -> webhook (bestanden gaan nooit stil)
#  S6 machinekamer:, NIETS maar mislukt (is_error) -> webhook
#  S7 machinekamer:, NIETS na een herstart (geen levensteken) -> webhook (de herstartregel staat erachter)
#  S8 david:, NIETS -> webhook
#  W  de wees-aflevering gebruikt dezelfde poort (statisch: agentStil vóór sendReport en appBewaarAgent met null)
# Kruisproef: AGENT_STIL_BRON=<pad naar oude server.js> -> S1/S2 en W moeten rood worden.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const BRON = process.env.AGENT_STIL_BRON || 'server.js';
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'agentstil-'));
let fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra && !ok ? '  [' + extra + ']' : '')); if (!ok) fout++; }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(path.join(W, 'bin'));
fs.writeFileSync(path.join(W, 'bin', 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const sid = a.includes('--session-id') ? a[a.indexOf('--session-id') + 1] : (a.includes('--resume') ? a[a.indexOf('--resume') + 1] : 'GEEN-ID');
const prompt = a[a.length - 1];
const modus = (/MODUS:([A-Z0-9]+)/.exec(prompt) || [])[1] || 'NORMAAL';
const sleutel = (/SLEUTEL:([a-z0-9]+)/.exec(prompt) || [])[1] || 'x';
const uit = ((/UIT:\\[([^\\]]*)\\]/.exec(prompt) || [])[1] || 'klaar').replace(/\\\\n/g, '\\n');
const W = ${JSON.stringify(W)};
const proj = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj, { recursive: true });
const tf = path.join(proj, sid + '.jsonl');
const regel = () => fs.appendFileSync(tf, JSON.stringify({ type: 'user', message: { role: 'user', content: 'opdracht' } }) + '\\n');
let poging = 0; const tel = path.join(W, 'teller-' + sleutel);
try { poging = parseInt(fs.readFileSync(tel, 'utf8'), 10) || 0; } catch (e) {}
fs.writeFileSync(tel, String(poging + 1));
const klaar = (t, fout) => { process.stdout.write(JSON.stringify({ type: 'result', is_error: !!fout, result: t, session_id: sid })); process.exit(fout ? 1 : 0); };
if (modus === 'HANG1' && poging === 0) setInterval(() => {}, 1e9);
else setTimeout(() => {
  regel();
  if (modus === 'BESTAND') fs.writeFileSync(path.join(process.env.OUTDIR, 'stand.md'), 'stand');
  setTimeout(() => klaar(uit, modus === 'FOUT'), 300);
}, 300);
`, { mode: 0o755 });

const rapporten = [];
const hook = http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
  if (req.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return res.end(JSON.stringify([{ actieve_kant: 'olares', sinds: null }]));
  if (req.url.indexOf('/rest/v1/') === 0) return res.end('[]');
  try { rapporten.push(JSON.parse(b)); } catch (e) {} res.end('ok'); }); });

function maakServer(bron, naam, poort) {
  const d = path.join(W, naam);
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
  let s = fs.readFileSync(bron, 'utf8');
  [['const INACT_MS = 20 * 60 * 1000;', 'const INACT_MS = 4000;'], ['const WATCH_INTERVAL_MS = 30 * 1000;', 'const WATCH_INTERVAL_MS = 500;'],
   ['const KILL_GRACE_MS = 10 * 1000;', 'const KILL_GRACE_MS = 1000;'], ['const AGENT_START_SPREIDING_MS = 20 * 1000;', 'const AGENT_START_SPREIDING_MS = 300;'],
   ['const VROEG_LEVEN_MS = 3 * 60 * 1000;', 'const VROEG_LEVEN_MS = 3000;'], ['const EIND_POLL_MS = 15 * 1000;', 'const EIND_POLL_MS = 300;'],
   ['const EIND_BEZINK_MS = 5 * 1000;', 'const EIND_BEZINK_MS = 200;']].forEach(([x, y]) => { s = s.split(x).join(y); });
  fs.writeFileSync(path.join(d, 'server.js'), s);
  const env = Object.assign({}, process.env, {
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: path.join(d, 'app-data'), APP_UIT_BESTAND: path.join(d, 'app-uit'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    UITROL_MARKER: path.join(d, 'uitrol-wacht'), ROL_BESTAND: path.join(d, 'rol'), AGY_MCP_TMP: path.join(d, 'agy-mcp.json'), TUNNEL_UIT_POD: '1',
    SUPABASE_URL: 'http://127.0.0.1:' + hook.address().port, SUPABASE_SERVICE_ROLE: 'proef', SOCEV_KANT: 'olares',
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '12',
    PORT: String(poort), AGENT_WEBHOOK_URL: 'http://127.0.0.1:' + hook.address().port + '/', AGENT_WEBHOOK_SECRET: 'proef',
    PATH: path.join(W, 'bin') + ':' + process.env.PATH
  });
  delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.SOCEV_AGENT_RUN;
  const p = spawn(process.execPath, [path.join(d, 'server.js')], { env, detached: true, stdio: ['ignore', fs.openSync(path.join(d, 'stdout.log'), 'a'), fs.openSync(path.join(d, 'stdout.log'), 'a')] });
  return { p, d, poort };
}
function req(srv, methode, pad, body) {
  return new Promise((ok, nok) => {
    const r = http.request({ host: '127.0.0.1', port: srv.poort, path: pad, method: methode, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { ok({ raw: b, status: res.statusCode }); } });
    });
    r.on('error', nok); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
const get = (s, p) => req(s, 'GET', p);
async function wachtOp(srv) { for (let i = 0; i < 50; i++) { try { await get(srv, '/health'); return; } catch (e) { await slaap(200); } } throw new Error('server start niet'); }
const agent = (s, label, prompt) => req(s, 'POST', '/agent', { secret: 'proef', label, prompt, chat_id: '40687', workspace: 'vault', runtime: 'claude' });
async function klaarIn(srv, id, maxMs) {
  const t = Date.now();
  while (Date.now() - t < maxMs) {
    const l = await get(srv, '/agents'); const a = (l.agents || []).find((x) => x.job_id === id);
    if (a && a.status !== 'running' && a.status !== 'pending' && a.rapport && a.rapport !== '-' && a.rapport.indexOf('herkansing') !== 0) return a;
    await slaap(250);
  }
  return null;
}
function rapportMd(srv, id) {
  const b = path.join(srv.d, 'app-bestanden');
  try { return fs.readdirSync(b).some((dag) => fs.existsSync(path.join(b, dag, id, 'rapport.md'))); } catch (e) { return false; }
}
const stop = (srv) => { try { process.kill(-srv.p.pid, 'SIGKILL'); } catch (e) {} };

(async function () {
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  let srv = null;
  try {
    srv = maakServer(BRON, 's', vrijePoort()); await wachtOp(srv);
    const gevallen = [
      ['S1', 'machinekamer:wv1 fto-ronde', 'UIT:[NIETS] SLEUTEL:s1', true],
      ['S2', 'machinekamer: fto-ronde2', 'UIT:[  NIETS.\\n] SLEUTEL:s2', true],
      ['S3', 'machinekamer:wv3 fto-ronde3', 'UIT:[Stand gewijzigd: 1 nieuw stuk] SLEUTEL:s3', false],
      ['S4', 'socev:uitzoeken', 'UIT:[NIETS] SLEUTEL:s4', false],
      ['S4b', 'zonder prefix', 'UIT:[NIETS] SLEUTEL:s4b', false],
      ['S5', 'machinekamer:met bestand', 'MODUS:BESTAND UIT:[NIETS] SLEUTEL:s5', false],
      ['S6', 'machinekamer:mislukt', 'MODUS:FOUT UIT:[NIETS] SLEUTEL:s6', false],
      ['S7', 'machinekamer:herstart', 'MODUS:HANG1 UIT:[NIETS] SLEUTEL:s7', false],
      ['S8', 'david:op verzoek', 'UIT:[NIETS] SLEUTEL:s8', false]
    ];
    const jobs = [];
    for (const [k, label, prompt, stil] of gevallen) { const r = await agent(srv, label, prompt); if (!r.job_id) toets(k + ' gestart', false, JSON.stringify(r).slice(0, 120)); jobs.push({ k, label, stil, id: r.job_id }); }
    for (const j of jobs) {
      const a = await klaarIn(srv, j.id, 40000);
      await slaap(600);
      const hooks = rapporten.filter((x) => x.job_id === j.id);
      if (j.stil) {
        toets(j.k + ' ' + j.label + ': geen webhook', a && hooks.length === 0, 'hooks=' + hooks.length + ' rapport=' + (a && a.rapport));
        toets(j.k + ' register rapport stil, ok', a && a.rapport === 'stil' && a.ok === true, a && JSON.stringify({ r: a.rapport, ok: a.ok }));
        toets(j.k + ' geen rapport.md in app-bestanden', a && !rapportMd(srv, j.id));
      } else {
        toets(j.k + ' ' + j.label + ': webhook komt', a && hooks.length === 1, 'hooks=' + hooks.length + ' rapport=' + (a && a.rapport));
        if (j.k === 'S3' || j.k === 'S7') toets(j.k + ' rapport.md in app-bestanden', rapportMd(srv, j.id));
        if (j.k === 'S7') toets('S7 herstartregel staat in het rapport', hooks[0] && /\[Pod: de eerste start kwam niet op gang/.test(hooks[0].output), hooks[0] && hooks[0].output.slice(0, 80));
      }
    }
    const log = fs.readFileSync(path.join(srv.d, 'api.log'), 'utf8');
    const stilRegels = log.split('\n').filter((r) => /"soort":"agent-stil"/.test(r));
    toets('log: precies twee agent-stil-regels (S1, S2)', stilRegels.length === 2, stilRegels.length + '');
  } catch (e) { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); fout++; }
  // W: wees-aflevering (statisch; de wees-toets zelf is test/wees-agent.sh)
  const s = fs.readFileSync(BRON, 'utf8');
  const wb = s.indexOf('function weesAfleveren('), we = s.indexOf('\nfunction ', wb + 10);
  const wees = wb > 0 ? s.slice(wb, we) : '';
  toets('W wees-aflevering: agentStil vóór sendReport', /const stil = agentStil\(a\.label, r, files\);\s*\n\s*if \(stil\) agentStilAf\(a, id\); else sendReport\(a, r\);/.test(wees));
  toets('W wees-aflevering: geen rapport.md bij stil', /appBewaarAgent\(id, a, outdir, stil \? null : r\.output/.test(wees));
  if (srv) stop(srv);
  hook.close();
  console.log(fout ? ('ROOD: ' + fout + ' toets(en) mislukt — werkmap ' + W) : 'ALLES GROEN');
  if (!fout && process.env.BEWAAR !== '1') fs.rmSync(W, { recursive: true, force: true });
  process.exit(fout ? 1 : 0);
})();
JS
