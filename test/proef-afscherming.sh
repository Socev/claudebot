#!/usr/bin/env bash
# wv3398 (actieplan 19-11 B82): een proefkopie van server.js (elke toets) mag geen echte podomgeving erven.
# Draait de ECHTE server.js (of SERVER_BRON=<bestand>, voor de kruisproef tegen main) als kopie in een wegwerpmap, met een
# nep-"pid 1-omgeving" (PROEF_REF_ENVIRON) die zegt welke waarden de pod zelf heeft, een geldig adres.env en een nep-claude.
#   A  geërfde podwaarden (zelfde naam + waarde als pid 1) zijn weg in wat de server aan een agent doorgeeft; eigen nepwaarden blijven
#   B  SUPABASE_URL naar :8091 en SB_SQL_LOKAAL zonder SB_SQL_BIN zijn weg; adres.env wordt niet toegepast
#   C  een geërfd API_SECRET werkt niet meer (401), de server kreeg een willekeurig geheim
#   D  hij luistert op 127.0.0.1, niet op 0.0.0.0
#   E  valt zijn ouder weg (afgebroken toets), dan stopt hij zichzelf binnen enkele seconden
#   F  (blok geknipt) SUPABASE_URL naar :8091 en SB_SQL_LOKAAL zonder SB_SQL_BIN gaan eruit; veilige namen blijven
# SUPABASE_URL wijst in de serverruns naar een nep-Supabase van de toets zelf (rolwachter: actieve kant olares).
# Alles met verzonnen waarden; geen netwerk buiten 127.0.0.1, geen echte sleutels, geen databank.
set -u
cd "$(dirname "$0")/.." || exit 1
BRON="${SERVER_BRON:-server.js}"
W=$(mktemp -d /tmp/proefafscherming-XXXXXX)
PIDS_BESTAND="$W/pids"; : > "$PIDS_BESTAND"
opruimen() { while read -r p; do [ -n "$p" ] && kill -KILL -- "-$p" 2>/dev/null; kill -KILL "$p" 2>/dev/null; done < "$PIDS_BESTAND"; rm -rf "$W"; }
trap opruimen EXIT INT TERM
node - "$BRON" "$W" <<'JS'
const fs = require('fs'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const vrijePoort = require(path.resolve('test/vrije-poort.js'));
const [BRON, W] = process.argv.slice(2);
let fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const leeft = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
const pidBij = (p) => fs.appendFileSync(path.join(W, 'pids'), p + '\n');

// nep-"pid 1": wat de pod zelf in zijn omgeving heeft (verzonnen waarden)
const REF = { API_SECRET: 'pod-geheim-verzonnen-1', SUPABASE_SERVICE_ROLE: 'pod-rol-verzonnen-2', N8N_API_KEY: 'pod-n8n-verzonnen-3',
  CLOUDFLARE_API_TOKEN: 'pod-cf-verzonnen-4', CLAUDE_CODE_OAUTH_TOKEN: 'pod-oauth-verzonnen-5', N8N_WEBHOOK_SMS: 'https://n8n.voorbeeld.invalid/webhook/x' };
fs.writeFileSync(path.join(W, 'ref-environ'), Object.keys(REF).map((k) => k + '=' + REF[k]).join('\0') + '\0');
fs.writeFileSync(path.join(W, 'adres.env'), 'SUPABASE_URL=http://127.0.0.1:8091\nSB_SQL_LOKAAL=1\n');
fs.mkdirSync(path.join(W, 'bin'));
fs.writeFileSync(path.join(W, 'bin', 'claude'), `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(path.join(W, 'kind-env.json'))}, JSON.stringify({ namen: Object.keys(process.env).sort(), sb: process.env.SUPABASE_URL || null }));
const a = process.argv.slice(2); const sid = a.includes('--session-id') ? a[a.indexOf('--session-id') + 1] : 'x';
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'klaar', session_id: sid }));
`, { mode: 0o755 });

function maakServer(naam, extraEnv) {
  const d = path.join(W, naam);
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
  fs.copyFileSync(BRON, path.join(d, 'server.js'));
  const poort = vrijePoort();
  // Alleen wat een toets zelf zet + wat hij "erft" (REF-waarden); niets uit de echte omgeving van deze shell behalve PATH.
  const env = Object.assign({
    PATH: path.join(W, 'bin') + ':' + process.env.PATH, HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'),
    IO_DIR: path.join(d, 'io'), JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: path.join(d, 'app-data'),
    APP_UIT_BESTAND: path.join(d, 'app-uit'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'), RUNTIME_FILE: path.join(d, 'runtime.json'),
    CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'), UITROL_MARKER: path.join(d, 'uitrol-wacht'),
    ROL_BESTAND: path.join(d, 'rol'), AGY_MCP_TMP: path.join(d, 'agy-mcp.json'), TUNNEL_UIT_POD: '1', OFFSITE_INTERVAL_MIN: '0',
    AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', MAX_AGENTS: '2', SOCEV_KANT: 'olares', PORT: String(poort),
    PROEF_REF_ENVIRON: path.join(W, 'ref-environ'), SOCEV_ADRES_ENV: path.join(W, 'adres.env'), PROEF_OUDER_TIK_MS: '300',
    // "geërfd": zelfde waarde als pid 1
    SUPABASE_SERVICE_ROLE: REF.SUPABASE_SERVICE_ROLE, N8N_API_KEY: REF.N8N_API_KEY, CLOUDFLARE_API_TOKEN: REF.CLOUDFLARE_API_TOKEN,
    CLAUDE_CODE_OAUTH_TOKEN: REF.CLAUDE_CODE_OAUTH_TOKEN, N8N_WEBHOOK_SMS: REF.N8N_WEBHOOK_SMS,
    SUPABASE_URL: 'http://127.0.0.1:' + hook.address().port, SB_SQL_LOKAAL: '1',
    // eigen nepwaarde van de toets: blijft
    TOETS_EIGEN_NEP: 'blijft-staan'
  }, extraEnv);
  // De server draait onder een tussenouder (zoals een toets), zodat E die ouder kan laten wegvallen.
  const ouder = spawn(process.execPath, ['-e', `
    const { spawn } = require('child_process'); const fs = require('fs');
    const uit = fs.openSync(process.argv[2], 'a');
    const k = spawn(process.execPath, [process.argv[1]], { env: JSON.parse(process.argv[3]), stdio: ['ignore', uit, uit] });
    fs.writeFileSync(process.argv[4], String(k.pid)); setInterval(() => {}, 1e9);`,
    path.join(d, 'server.js'), path.join(d, 'stdout.log'), JSON.stringify(env), path.join(d, 'server.pid')], { detached: true, stdio: 'ignore' });
  pidBij(ouder.pid);
  return { ouder, d, poort, serverPid: () => { try { return parseInt(fs.readFileSync(path.join(d, 'server.pid'), 'utf8'), 10); } catch (e) { return null; } } };
}
// nep-Supabase (rolwachter leest hier de actieve kant); telt verzoeken
const hookVerzoeken = [];
const hook = http.createServer((q, res) => { hookVerzoeken.push(q.url); res.setHeader('content-type', 'application/json');
  if (q.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return res.end(JSON.stringify([{ actieve_kant: 'olares', sinds: null }]));
  res.end('[]'); });
function req(s, methode, pad, body) {
  return new Promise((ok, nok) => {
    const r = http.request({ host: '127.0.0.1', port: s.poort, path: pad, method: methode, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} ok({ status: res.statusCode, j }); });
    });
    r.on('error', nok); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
async function wachtOp(s) { for (let i = 0; i < 100; i++) { try { await req(s, 'GET', '/health/publiek'); return true; } catch (e) { await slaap(200); } } return false; }
function luistertOp(poort) {
  const hex = poort.toString(16).toUpperCase().padStart(4, '0'), uit = [];
  ['/proc/net/tcp', '/proc/net/tcp6'].forEach((f) => { let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch (e) {}
    t.split('\n').slice(1).forEach((r) => { const c = r.trim().split(/\s+/); if (c[3] === '0A' && c[1] && c[1].endsWith(':' + hex)) uit.push(c[1].split(':')[0]); }); });
  return uit;
}

(async function () {
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  try {
    // ── F: blok geknipt
    const src = fs.readFileSync(BRON, 'utf8');
    const i = src.indexOf('/* proefAfscherming:begin'), j = src.indexOf('/* proefAfscherming:end');
    toets('F blok proefAfscherming gevonden', i > 0 && j > i);
    if (i > 0 && j > i) {
      const m = { exports: null };
      new Function('fs', 'module', src.slice(i, j) + '\nmodule.exports = { schermProefAf };')(fs, m);
      const ref = 'HOME=/opt/data\0API_SECRET=x1\0';
      const e1 = { HOME: '/opt/data', SUPABASE_URL: 'http://127.0.0.1:8091', SB_SQL_LOKAAL: '1', API_SECRET: 'x1' };
      const u1 = m.exports.schermProefAf(e1, ref, () => 'willekeurig');
      toets('F :8091 en SB_SQL_LOKAAL weg, HOME blijft, geërfd geheim vervangen', !('SUPABASE_URL' in e1) && !('SB_SQL_LOKAAL' in e1) && e1.HOME === '/opt/data' && e1.API_SECRET === 'willekeurig' && u1.geheim, JSON.stringify(u1));
      const e2 = { SUPABASE_URL: 'http://127.0.0.1:4321', SB_SQL_LOKAAL: '1', SB_SQL_BIN: '/tmp/nep-sb-sql', API_SECRET: 'eigen' };
      m.exports.schermProefAf(e2, ref, () => 'willekeurig');
      toets('F eigen nep-SUPABASE_URL en SB_SQL_LOKAAL met nep-SB_SQL_BIN blijven', e2.SUPABASE_URL === 'http://127.0.0.1:4321' && e2.SB_SQL_LOKAAL === '1' && e2.API_SECRET === 'eigen');
    }
    // ── run 1: geërfd API_SECRET (zelfde als pid 1)
    const s1 = maakServer('s1', { API_SECRET: REF.API_SECRET });
    toets('start s1', await wachtOp(s1));
    const r = await req(s1, 'POST', '/result', { job_id: 'bestaat-niet', secret: REF.API_SECRET });
    toets('C geërfd API_SECRET geeft geen toegang (401)', r.status === 401, 'status ' + r.status);
    const adressen = luistertOp(s1.poort);
    toets('D luistert alleen op 127.0.0.1', adressen.length > 0 && adressen.every((a) => a === '0100007F' || a === '0000000000000000FFFF00000100007F'), adressen.join(','));
    const log1 = fs.readFileSync(path.join(s1.d, 'stdout.log'), 'utf8');
    toets('B adres.env niet toegepast', !/eigen databank in de pod/.test(log1));
    // ── E: tussenouder weg -> server stopt zichzelf
    const sp = s1.serverPid();
    try { process.kill(s1.ouder.pid, 'SIGKILL'); } catch (e) {}   // alleen de ouder, niet zijn groep
    let weg = false; for (let i = 0; i < 40 && !weg; i++) { await slaap(250); weg = !leeft(sp); }
    toets('E ouder weg: proefserver stopt zichzelf binnen 10 s', sp > 0 && weg, 'pid ' + sp);
    if (sp > 0 && !weg) { try { process.kill(sp, 'SIGKILL'); } catch (e) {} }

    // ── run 2: eigen API_SECRET van de toets; kijk wat een machinekamer-agent erft (die krijgt de volle omgeving van de server)
    // eigen nep-rolsleutel voor de nep-Supabase (zoals agent-start.sh); de overige geërfde sleutels blijven geërfd
    const s2 = maakServer('s2', { API_SECRET: 'toets-eigen-geheim', SUPABASE_SERVICE_ROLE: 'proef' });
    toets('start s2', await wachtOp(s2));
    const a = await req(s2, 'POST', '/agent', { secret: 'toets-eigen-geheim', label: 'machinekamer:proefafscherming', prompt: 'x', chat_id: '40687', workspace: 'vault', runtime: 'claude' });
    toets('agent gestart met eigen toetsgeheim', a.status === 200 && a.j && a.j.ok, 'status ' + a.status);
    let kind = null; for (let i = 0; i < 80 && !kind; i++) { await slaap(250); try { kind = JSON.parse(fs.readFileSync(path.join(W, 'kind-env.json'), 'utf8')); } catch (e) {} }
    toets('agent-kind gestart', !!kind);
    const namen = (kind && kind.namen) || [];
    const geerfd = ['N8N_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'N8N_WEBHOOK_SMS'].filter((k) => namen.includes(k));
    toets('A geërfde podwaarden niet doorgegeven', geerfd.length === 0, geerfd.join(','));
    toets('A eigen nepwaarde van de toets blijft', namen.includes('TOETS_EIGEN_NEP'));
    toets('B geen SB_SQL_LOKAAL zonder nep-SB_SQL_BIN', !namen.includes('SB_SQL_LOKAAL'));
    toets('B eigen nep-SUPABASE_URL van de toets blijft', kind && kind.sb === 'http://127.0.0.1:' + hook.address().port, kind && kind.sb);
    try { process.kill(-s2.ouder.pid, 'SIGKILL'); } catch (e) {}
    const sp2 = s2.serverPid(); await slaap(1500); if (sp2 && leeft(sp2)) { try { process.kill(sp2, 'SIGKILL'); } catch (e) {} }
    toets('nep-Supabase kreeg verzoeken (de rolwachter las de toets, niet de echte databank)', hookVerzoeken.length > 0, hookVerzoeken.length + '');
  } catch (e) { toets('onverwachte fout', false, e && e.stack); }
  console.log(fout ? fout + ' ROOD' : 'ALLES GROEN');
  process.exit(fout ? 1 : 0);
})();
JS
