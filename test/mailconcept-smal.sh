#!/usr/bin/env bash
# wv4098 (nr 339 = 3C39, nr 348 = 3C48): POST /smal/mailconcept met de ECHTE server.js op een losse poort. Feitenstrook zonder draad (geen
# luik nodig), invoerfouten, sleutel. Verzonnen tekst. Gebruik: bash test/mailconcept-smal.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mailconcept-smal-'));
let fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
['server.js', 'mail-ontvangers.js', 'voorwerk-poort.js'].forEach((f) => fs.copyFileSync(f, path.join(d, f)));
const poort = vrijePoort(), sbPoort = vrijePoort();
// nep-Supabase: alleen de rolstand (actieve kant = olares), anders blijft de pod passief en weigert /smal
const sb = http.createServer((req, res) => { res.setHeader('content-type', 'application/json');
  if (req.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return res.end(JSON.stringify([{ actieve_kant: 'olares', sinds: null }]));
  res.statusCode = 404; res.end('[]'); }).listen(sbPoort, '127.0.0.1');
const env = Object.assign({}, process.env, {
  HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: path.join(d, 'app-data'), APP_UIT_BESTAND: path.join(d, 'app-uit'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'),
  JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
  RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
  UITROL_MARKER: path.join(d, 'uitrol-wacht'), ROL_BESTAND: path.join(d, 'rol'), AGY_MCP_TMP: path.join(d, 'agy-mcp.json'), TUNNEL_UIT_POD: '1',
  SUPABASE_URL: 'http://127.0.0.1:' + sbPoort, SUPABASE_SERVICE_ROLE: 'proef', SOCEV_KANT: 'olares',
  OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '1', PORT: String(poort)
});
delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.SCHEIDS_URL; delete env.SOCEV_AGENT_RUN; delete env.N8N_WEBHOOK_AGENDA_API;
const uit = fs.openSync(path.join(d, 'stdout.log'), 'a');
const p = spawn(process.execPath, [path.join(d, 'server.js')], { env, detached: true, stdio: ['ignore', uit, uit] });
function post(pad, body) {
  return new Promise((ok, nok) => {
    const r = http.request({ host: '127.0.0.1', port: poort, path: pad, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} ok({ st: res.statusCode, j }); });
    });
    r.on('error', nok); r.end(JSON.stringify(body));
  });
}
(async function () {
  try {
    let up = false;
    for (let i = 0; i < 150 && !up; i++) { try { const x = await post('/smal/mailconcept', {}); up = x.st !== 409; } catch (e) {} if (!up) await slaap(200); }
    toets('server start', up);
    let r = await post('/smal/mailconcept', { secret: 'fout', opdracht: 'feiten', concept: 'Dat wordt € 450.' });
    toets('verkeerde sleutel = 401', r.st === 401, r.st);
    r = await post('/smal/mailconcept', { secret: 'proef', opdracht: 'feiten', concept: 'Hoi,\n\nDat wordt € 450, uiterlijk 1 februari.\n\nGroet, David',
      stukken: [{ naam: 'offerte.txt', tekst: 'Totaal EUR 450,00' }] });
    toets('feiten: 200', r.st === 200 && r.j && r.j.ok === true, JSON.stringify(r.j).slice(0, 200));
    toets('feiten: precies de verzonnen datum niet onderbouwd', r.j && r.j.regel === '2 feiten; niet onderbouwd: 1 februari.' && r.j.onderbouwd[0].bron === 'stuk: offerte.txt', r.j && r.j.regel);
    r = await post('/smal/mailconcept', { secret: 'proef', opdracht: 'feiten', concept: 'kort', draad: 'aa11bb22cc33dd44' });
    toets('feiten: te kort = 400', r.st === 400, r.st);
    r = await post('/smal/mailconcept', { secret: 'proef', opdracht: 'feiten', concept: 'Tot 3 december, groet David', draad: 'aa11bb22cc33dd44' });
    toets('feiten: draad niet te lezen = eerlijk gezegd', r.st === 200 && r.j.draad_gelezen === false && /niet te lezen/.test(r.j.regel), r.j && r.j.regel);
    r = await post('/smal/mailconcept', { secret: 'proef', opdracht: 'feiten', concept: 'Groet. ' + 'x'.repeat(20000) + ' € 999' });
    toets('feiten: te lang = 413, nooit stil afkappen (review MOET 1)', r.st === 413 && /zelf na/.test(r.j.fout), r.st);
    r = await post('/smal/mailconcept', { secret: 'proef', opdracht: 'draad', draad: '../x' });
    toets('draad: geen hex = 400', r.st === 400, r.st);
    r = await post('/smal/mailconcept', { secret: 'proef', opdracht: 'draad', draad: 'aa11bb22cc33dd44' });
    toets('draad: luik weg = 502 met gewone taal', r.st === 502 && /loop de ontvangers zelf na/.test(r.j.fout), r.st);
    r = await post('/smal/mailconcept', { secret: 'proef', opdracht: 'stuur' });
    toets('onbekende opdracht = 400 (geen concept maken)', r.st === 400, r.st);
  } finally { try { process.kill(-p.pid, 'SIGKILL'); } catch (e) {} sb.close(); }
  process.exit(fout ? 1 : 0);
})();
JS
