#!/usr/bin/env bash
# Toetst /health-rapporten (wv811, 22-10-2026): healthRapportenStart uit server.js (vm-context) tegen nagebootste generators.
# Toetst: startregel GESTART/LOOPT NOG → 200 met alleen die regel; geen regel of exit ≠ 0 → 502 zonder stdout/stderr van het script;
# tijdgrens → 502 en het proces is weg; één start tegelijk (409); omgeving alleen de allowlist (geen API_SECRET e.d.).
# Raakt het echte script en de health-pod niet. Gebruik: bash test/health-rapporten-start.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'healthrap-'));
const src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf('const HEALTH_RAPPORTEN_BIN'), b = src.indexOf('function bankRondeStart() {');
if (a < 0 || b < a) { console.log('ROOD  blok niet gevonden'); process.exit(1); }
const blok = src.slice(a, b) + '\nthis.healthRapportenStart = healthRapportenStart;';
function script(naam, py) { const p = path.join(W, naam); fs.writeFileSync(p, py); return p; }
const logs = [];
function laad(bin, ms) {
  const env = Object.assign({}, process.env, { HEALTH_RAPPORTEN_BIN: bin, HEALTH_RAPPORTEN_MS: String(ms || 5000), API_SECRET: 'geheim-x', N8N_API_KEY: 'n8n-x', CLAUDE_CODE_OAUTH_TOKEN: 'tok-x' });
  const ctx = { require: require, process: { env: env }, logError: function (w, e) { logs.push(w + ': ' + e.message); }, Math: Math, Number: Number, String: String };
  vm.createContext(ctx); vm.runInContext(blok, ctx); return ctx.healthRapportenStart;
}
const start = (f) => new Promise((r) => f(r));
(async function () {
  const envUit = path.join(W, 'env.json');
  const goedS = script('goed.py', `import os,json,sys\njson.dump(sorted(os.environ), open(${JSON.stringify(envUit)},'w'))\nprint("GESTART (pid 123); vorige: geslaagd 4/4")\n`);
  let r = await start(laad(goedS));
  toets('GESTART → 200 met alleen de startregel (zonder vorige)', r.status === 200 && r.j.ok === true && r.j.regel === 'GESTART (pid 123)' && JSON.stringify(r).indexOf('vorige') < 0, r);
  const keys = JSON.parse(fs.readFileSync(envUit, 'utf8'));
  toets('omgeving alleen de allowlist (geen API_SECRET/N8N_API_KEY/HEALTH_RAPPORTEN_*)', keys.indexOf('API_SECRET') < 0 && keys.indexOf('N8N_API_KEY') < 0 && keys.indexOf('HEALTH_RAPPORTEN_BIN') < 0 && keys.indexOf('CLAUDE_CODE_OAUTH_TOKEN') >= 0, keys);
  toets('omgeving bevat niets buiten de allowlist', keys.every((k) => ['HOME', 'PATH', 'TZ', 'LANG', 'LC_ALL', 'TMPDIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'LC_CTYPE', 'PWD'].indexOf(k) >= 0), keys);
  r = await start(laad(script('loopt.py', 'print("ruis")\nprint("LOOPT NOG (pid 9); vorige: -")\n')));
  toets('LOOPT NOG → 200, alleen de regel zonder vorige', r.status === 200 && r.j.regel === 'LOOPT NOG (pid 9)', r);
  r = await start(laad(script('geen.py', 'import sys\nprint("geheime inhoud Hb 7,1")\nsys.stderr.write("Traceback: diagnose X")\n')));
  toets('geen startregel → 502 zonder uitvoer van het script', r.status === 502 && r.j.ok === false && JSON.stringify(r).indexOf('Hb') < 0 && JSON.stringify(r).indexOf('diagnose') < 0, r);
  r = await start(laad(script('exit.py', 'import sys\nprint("GESTART (pid 1)")\nsys.exit(3)\n')));
  toets('exit ≠ 0 → 502 met exitcode', r.status === 502 && /exit 3/.test(r.j.fout), r);
  const pidF = path.join(W, 'pid');
  const traag = script('traag.py', `import os,time\nopen(${JSON.stringify(pidF)},'w').write(str(os.getpid()))\ntime.sleep(30)\nprint("GESTART")\n`);
  const f = laad(traag, 1500);
  const p1 = start(f); const r2 = await start(f);
  toets('tweede start tijdens de eerste → 409', r2.status === 409, r2);
  r = await p1;
  toets('tijdgrens → 502', r.status === 502 && /langer dan/.test(r.j.fout), r);
  let leeft = true; try { process.kill(Number(fs.readFileSync(pidF, 'utf8')), 0); } catch (e) { leeft = false; }
  toets('proces na de tijdgrens weg', !leeft);
  r = await start(f.bind ? laad(goedS) : f);
  toets('na de tijdgrens weer vrij', r.status === 200, r);
  toets('fouten gelogd zonder inhoud', logs.length === 3 && logs.every((l) => /^health-rapporten: /.test(l) && l.indexOf('Hb') < 0), logs);
  r = await start(laad(path.join(W, 'bestaat-niet.py')));
  toets('script ontbreekt → 502', r.status === 502, r);
  fs.rmSync(W, { recursive: true, force: true });
  console.log('health-rapporten-start: ' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})();
JS
