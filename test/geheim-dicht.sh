#!/usr/bin/env bash
# wv3410 (actieplan Fable 19-11, B03): /runtime, /run, /werkkamer-tegels, /agent, /result en /reset zijn fail-closed.
# Zonder API_SECRET (kluis overgeslagen) gaven ze vroeger alles door (`if (SECRET && ...)`); nu 503. Met geheim: fout geheim 401,
# goed geheim en de Socev-agentsleutel (smalle agent) werken zoals voorheen.
# Draait de ECHTE server.js als kopie op een losse poort met een nep-`claude`; geen taalmodel, geen pod nodig.
# De proefafscherming (wv3398) geeft een kopie zonder API_SECRET een willekeurig geheim; voor scenario "zonder geheim" knipt deze
# toets alleen die ene regel uit de kopie.
# Optioneel: OUD=<git-ref> draait scenario A tegen die versie (moet daar ROOD zijn, anders is de toets vals groen).
set -u
cd "$(dirname "$0")/.." || exit 1
BRON=server.js
if [ -n "${OUD:-}" ]; then BRON=$(mktemp /tmp/geheim-dicht-oud-XXXX.js); git show "$OUD:server.js" > "$BRON" || exit 1; fi
BRON="$BRON" node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto');
const { spawn } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'geheimdicht-'));
let fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(path.join(W, 'bin'));
fs.writeFileSync(path.join(W, 'bin', 'claude'), `#!/usr/bin/env node
const a = process.argv.slice(2);
const sid = a.includes('--session-id') ? a[a.indexOf('--session-id') + 1] : 'x';
setTimeout(() => { process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'klaar', session_id: sid })); process.exit(0); }, 300);
`, { mode: 0o755 });

const hook = http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
  if (req.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return res.end(JSON.stringify([{ actieve_kant: 'olares', sinds: null }]));
  res.end('ok'); }); });

function maakServer(naam, geheim) {
  const d = path.join(W, naam), poort = vrijePoort();
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
  let s = fs.readFileSync(process.env.BRON, 'utf8');
  if (!geheim) {
    const r = '  if (geheim) env.API_SECRET = maakGeheim();\n';
    if (s.indexOf(r) >= 0) s = s.split(r).join('');
  }
  fs.writeFileSync(path.join(d, 'server.js'), s);
  const env = {
    PATH: path.join(W, 'bin') + ':' + process.env.PATH, LANG: process.env.LANG || 'C.UTF-8',
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: path.join(d, 'app-data'), APP_UIT_BESTAND: path.join(d, 'app-uit'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    UITROL_MARKER: path.join(d, 'uitrol-wacht'), ROL_BESTAND: path.join(d, 'rol'), AGY_MCP_TMP: path.join(d, 'agy-mcp.json'), TUNNEL_UIT_POD: '1',
    SUPABASE_URL: 'http://127.0.0.1:' + hook.address().port, SUPABASE_SERVICE_ROLE: 'proef', SOCEV_KANT: 'olares',
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', MAX_AGENTS: '6', PORT: String(poort),
    AGENT_WEBHOOK_URL: 'http://127.0.0.1:' + hook.address().port + '/', AGENT_WEBHOOK_SECRET: 'proef-hook'
  };
  if (geheim) env.API_SECRET = geheim;
  const uit = fs.openSync(path.join(d, 'stdout.log'), 'a');
  const p = spawn(process.execPath, [path.join(d, 'server.js')], { env, detached: true, stdio: ['ignore', uit, uit] });
  return { p, d, poort };
}
function req(srv, methode, pad, body) {
  return new Promise((ok, nok) => {
    const r = http.request({ host: '127.0.0.1', port: srv.poort, path: pad, method: methode, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} ok({ status: res.statusCode, j, raw: b }); });
    });
    r.on('error', nok); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
async function wachtOp(srv) { for (let i = 0; i < 75; i++) { try { await req(srv, 'GET', '/health'); return; } catch (e) { await slaap(200); } } throw new Error('server start niet: ' + fs.readFileSync(path.join(srv.d, 'stdout.log'), 'utf8').slice(-800)); }
function stop(srv) { try { process.kill(-srv.p.pid, 'SIGKILL'); } catch (e) {} }

// Elke route met een onschuldige body (geen prompt, onbekend job_id): de geheimtoets komt vóór al het andere.
const ROUTES = [
  ['/runtime', {}], ['/run', {}], ['/werkkamer-tegels', {}], ['/agent', {}], ['/result', { job_id: 'bestaat-niet' }], ['/reset', { chat_id: 'geheim-dicht-toets' }]
];

(async function () {
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const alle = [];
  try {
    // ── A. Zonder API_SECRET: alle zes 503, ook met een willekeurig of leeg geheim in de body.
    const s0 = maakServer('zonder', ''); alle.push(s0); await wachtOp(s0);
    for (const [pad, body] of ROUTES) {
      const z = await req(s0, 'POST', pad, Object.assign({}, body));
      const l = await req(s0, 'POST', pad, Object.assign({ secret: '' }, body));
      const g = await req(s0, 'POST', pad, Object.assign({ secret: 'wat-dan-ook' }, body));
      toets('A zonder geheim ' + pad + ' -> 503', z.status === 503 && l.status === 503 && g.status === 503, [z.status, l.status, g.status].join('/'));
    }
    stop(s0);
    if (!process.env.OUD_ALLEEN_A) {

    // ── B. Met API_SECRET: fout geheim 401, goed geheim voorbij de poort.
    const GEHEIM = 'proef-geheim-' + crypto.randomBytes(6).toString('hex');
    const s1 = maakServer('met', GEHEIM); alle.push(s1); await wachtOp(s1);
    for (const [pad, body] of ROUTES) {
      const f = await req(s1, 'POST', pad, Object.assign({ secret: 'fout' }, body));
      const f2 = await req(s1, 'POST', pad, Object.assign({ secret: GEHEIM + 'x' }, body));
      const zonder = await req(s1, 'POST', pad, Object.assign({}, body));
      toets('B fout/lang/geen geheim ' + pad + ' -> 401', f.status === 401 && f2.status === 401 && zonder.status === 401, [f.status, f2.status, zonder.status].join('/'));
    }
    const r1 = await req(s1, 'POST', '/result', { secret: GEHEIM, job_id: 'bestaat-niet' });
    toets('B goed geheim /result -> 200 found:false', r1.status === 200 && r1.j && r1.j.found === false, r1.status + ' ' + r1.raw.slice(0, 80));
    const rs = await req(s1, 'POST', '/reset', { secret: GEHEIM, chat_id: 'geheim-dicht-toets' });
    toets('B goed geheim /reset -> 200', rs.status === 200, rs.status + ' ' + rs.raw.slice(0, 80));
    const rr = await req(s1, 'POST', '/run', { secret: GEHEIM });
    toets('B goed geheim /run zonder prompt -> 400 (voorbij de poort)', rr.status === 400 && /missing prompt/.test(rr.raw), rr.status + ' ' + rr.raw.slice(0, 80));
    const a1 = await req(s1, 'POST', '/agent', { secret: GEHEIM, label: 'machinekamer: geheim-dicht', prompt: 'toets', chat_id: '40687', workspace: 'vault', runtime: 'claude' });
    toets('B goed geheim /agent start', a1.status === 200 && a1.j && a1.j.ok && a1.j.job_id, a1.status + ' ' + a1.raw.slice(0, 120));
    // Socev-agentsleutel (HMAC van het geheim): smalle agent en zijn resultaat blijven werken; /run en /reset niet.
    const SOCEV = crypto.createHmac('sha256', GEHEIM).update('wv424-socev-agent').digest('hex');
    const a2 = await req(s1, 'POST', '/agent', { secret: SOCEV, label: 'socev: geheim-dicht', prompt: 'toets', chat_id: '40687', workspace: 'vault', runtime: 'claude' });
    toets('B Socev-sleutel /agent start (smal)', a2.status === 200 && a2.j && a2.j.ok && a2.j.job_id, a2.status + ' ' + a2.raw.slice(0, 120));
    let r2 = null;
    for (let i = 0; i < 40 && a2.j && a2.j.job_id; i++) { r2 = await req(s1, 'POST', '/result', { secret: SOCEV, job_id: a2.j.job_id }); if (r2.j && r2.j.done) break; await slaap(300); }
    toets('B Socev-sleutel /result van eigen smalle agent -> 200', r2 && r2.status === 200 && r2.j && r2.j.found === true, r2 ? r2.status + ' ' + r2.raw.slice(0, 120) : 'geen');
    const r3 = await req(s1, 'POST', '/result', { secret: SOCEV, job_id: a1.j && a1.j.job_id });
    toets('B Socev-sleutel /result van machinekamer-agent -> 401', r3.status === 401, String(r3.status));
    const r4 = await req(s1, 'POST', '/reset', { secret: SOCEV, chat_id: 'geheim-dicht-toets' });
    toets('B Socev-sleutel /reset -> 401', r4.status === 401, String(r4.status));
    }
  } catch (e) { toets('onverwachte fout', false, e.message); }
  finally { alle.forEach(stop); hook.close(); }
  console.log(fout ? fout + ' ROOD' : 'ALLES GROEN');
  try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {}
  process.exit(fout ? 1 : 0);
})();
JS
rc=$?
[ -n "${OUD:-}" ] && rm -f "$BRON"
exit $rc
