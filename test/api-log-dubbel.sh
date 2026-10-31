#!/usr/bin/env bash
# wv2133: api.log schreef elke regel twee keer. De supervisor geeft het kind als stdout een fd op api.log en schrijfLog
# schreef zowel appendFileSync(API_LOG) als naar stdout. Toets met de ECHTE server.js op een losse poort:
#   A. stdout = fd op API_LOG (zoals supervisor.js), kleine LOG_MAX_BYTES zodat er geroteerd wordt: elke req-regel
#      precies één keer over api.log + .1..N.
#   B. stdout = ander bestand: de stdout-kopie blijft (lezers van stdout buiten de supervisor).
#   K. kruisproef: dezelfde A tegen de server.js van KRUIS_REF (standaard HEAD) moet dubbel tellen, anders is A vals groen.
set -u
cd "$(dirname "$0")/.." || exit 1
KRUIS_REF="${KRUIS_REF:-HEAD}" node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn, execSync } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'apilogdubbel-'));
let fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

function maakServer(bronTekst, naam, poort, stdoutNaarApiLog) {
  const d = path.join(W, naam);
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
  fs.writeFileSync(path.join(d, 'server.js'), bronTekst);
  const env = Object.assign({}, process.env, {
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: path.join(d, 'app-data'), APP_UIT_BESTAND: path.join(d, 'app-uit'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    UITROL_MARKER: path.join(d, 'uitrol-wacht'), ROL_BESTAND: path.join(d, 'rol'), AGY_MCP_TMP: path.join(d, 'agy-mcp.json'), TUNNEL_UIT_POD: '1',
    SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE: 'proef', SOCEV_KANT: 'olares',
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '1',
    PORT: String(poort), LOG_MAX_BYTES: '3000', LOG_GENERATIES: '20'
  });
  delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.SOCEV_AGENT_RUN;
  const uit = fs.openSync(stdoutNaarApiLog ? path.join(d, 'api.log') : path.join(d, 'stdout.log'), 'a');
  const p = spawn(process.execPath, [path.join(d, 'server.js')], { env, detached: true, stdio: ['ignore', uit, uit] });
  return { p, d, poort };
}
function get(srv, pad) {
  return new Promise((ok, nok) => {
    const r = http.request({ host: '127.0.0.1', port: srv.poort, path: pad, method: 'GET' }, (res) => { res.resume(); res.on('end', ok); });
    r.on('error', nok); r.end();
  });
}
async function wachtOp(srv) { for (let i = 0; i < 75; i++) { try { await get(srv, '/health'); return; } catch (e) { await slaap(200); } } throw new Error('server start niet'); }
function stop(srv) { try { process.kill(-srv.p.pid, 'SIGKILL'); } catch (e) {} }
function alleRegels(d) {
  return fs.readdirSync(d).filter((f) => /^api\.log(\.\d+)?$/.test(f)).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('').split('\n');
}
async function draai(bron, naam, naarApiLog, n) {
  const s = maakServer(bron, naam, vrijePoort(), naarApiLog);
  try {
    await wachtOp(s);
    for (let i = 0; i < n; i++) await get(s, '/proef-wv2133-' + naam + '-' + i);
    await slaap(300);
  } finally { stop(s); }
  const tel = {}; alleRegels(s.d).forEach((r) => { const m = new RegExp('pad=(/proef-wv2133-' + naam + '-\\d+)\\b').exec(r); if (m) tel[m[1]] = (tel[m[1]] || 0) + 1; });
  return { s, tel, gen: fs.readdirSync(s.d).filter((f) => /^api\.log\.\d+$/.test(f)).length };
}

(async function () {
  const N = 150;
  try {
    const nieuw = fs.readFileSync('server.js', 'utf8');
    const A = await draai(nieuw, 'A', true, N);
    const waarden = Object.values(A.tel);
    toets('A gemeten: alle ' + N + ' proefaanroepen staan in api.log*', Object.keys(A.tel).length === N, Object.keys(A.tel).length);
    toets('A elke req-regel precies één keer (stdout = fd op api.log)', waarden.every((v) => v === 1), JSON.stringify(waarden.filter((v) => v !== 1).slice(0, 5)));
    toets('A er is echt geroteerd (≥ 2 generaties)', A.gen >= 2, A.gen);

    const B = await draai(nieuw, 'B', false, 10);
    let so = ''; try { so = fs.readFileSync(path.join(B.s.d, 'stdout.log'), 'utf8'); } catch (e) {}
    toets('B stdout ≠ api.log: de stdout-kopie blijft', (so.match(/pad=\/proef-wv2133-B-\d+/g) || []).length === 10, (so.match(/pad=\/proef-wv2133-B-\d+/g) || []).length);
    toets('B api.log elke regel één keer', Object.values(B.tel).length === 10 && Object.values(B.tel).every((v) => v === 1));

    let oud = null; try { oud = execSync('git show ' + process.env.KRUIS_REF + ':server.js', { maxBuffer: 1 << 28 }).toString(); } catch (e) {}
    if (oud && oud !== nieuw) {
      const K = await draai(oud, 'K', true, N);
      const dubbel = Object.values(K.tel).filter((v) => v >= 2).length;
      toets('K kruisproef ' + process.env.KRUIS_REF + ': de oude server.js schrijft regels dubbel', dubbel > 0, dubbel + ' van ' + Object.keys(K.tel).length);
    } else console.log('OVERGESLAGEN K kruisproef (geen andere server.js op ' + process.env.KRUIS_REF + ')');
  } catch (e) { toets('onverwachte fout', false, e.message); }
  console.log(fout ? 'ROOD: ' + fout : 'ALLES GROEN');
  try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {}
  process.exit(fout ? 1 : 0);
})();
JS
