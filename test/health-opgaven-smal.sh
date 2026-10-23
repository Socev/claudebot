#!/usr/bin/env bash
# Toetst /smal/health-opgaven (wv887, 23-10-2026): healthOpgaven uit server.js (vm-context, met de echte smalKind) tegen
# nagebootste importeurs. Toetst: vast commando (python3 -I <bin> --alleen-opgaven, de body doet niet mee), omgeving alleen de
# allowlist, uitslag alleen tellers + overgeslagen (hooguit 20, ingekort), stop → 502 met alleen de IMPORT GESTOPT-regel, andere
# fout → 502 zonder uitvoer van het script, tijdgrens, één tegelijk (409), reservekant (409), foutlog zonder inhoud.
# Raakt het echte script en de health-pod niet. Gebruik: bash test/health-opgaven-smal.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'healthopg-'));
const src = fs.readFileSync('server.js', 'utf8');
function knip(van, tot) { const a = src.indexOf(van), b = src.indexOf(tot, a); if (a < 0 || b < a) { console.log('ROOD  blok niet gevonden: ' + van); process.exit(1); } return src.slice(a, b); }
const blok = knip('function smalKind(', 'async function smalSbRpc(') + knip('const HEALTH_OPGAVEN_BIN', 'function bankRondeStart() {') +
  '\nthis.healthOpgaven = healthOpgaven;';
toets('smalActie geeft de body niet door', /if \(actie === 'health-opgaven'\) return healthOpgaven\(\);/.test(src));
toets('grens in SMAL_GRENS', /'health-opgaven': 20\b/.test(src));
function script(naam, py) { const p = path.join(W, naam); fs.writeFileSync(p, py); return p; }
const logs = [];
let primair = true;
function laad(bin, ms) {
  const env = Object.assign({}, process.env, { HEALTH_OPGAVEN_BIN: bin, HEALTH_OPGAVEN_MS: String(ms || 5000), API_SECRET: 'geheim-x',
    SOCEV_AGENT_SLEUTEL: 'socev-x', CLAUDE_CODE_OAUTH_TOKEN: 'tok-x', HEALTH_POD_SLEUTELS: '/tmp/x.env', VAULT_DIR: '/tmp/nep', HEALTH_API_URL: 'http://x' });
  const ctx = { require: require, process: { env: env }, spawn: require('child_process').spawn, VAULT: W, setTimeout: setTimeout, clearTimeout: clearTimeout,
    rolPrimair: function () { return primair; }, logError: function (w, e) { logs.push(w + ': ' + e.message); }, Math: Math, Number: Number, String: String,
    JSON: JSON, Array: Array, Error: Error, Promise: Promise };
  vm.createContext(ctx); vm.runInContext(blok, ctx); return ctx.healthOpgaven;
}
const J = (o) => JSON.stringify(Object.assign({ droog: false, deel: 'opgaven', per_route: {}, nieuw: 0, bestond: 0, overgeslagen: [], geschreven: [], persoon_id: 1 }, o));
(async function () {
  const envUit = path.join(W, 'env.json');
  const goedS = script('goed.py', `import os,json,sys\njson.dump({"env": sorted(os.environ), "argv": sys.argv[1:], "flags": sys.flags.isolated, "cwd": os.getcwd()}, open(${JSON.stringify(envUit)},'w'))\nprint("ruis vooraf")\nprint(${JSON.stringify(J({ nieuw: 1, bestond: 1, geschreven: [{ route: '/metingen', id: 7 }] }))})\n`);
  let r = await laad(goedS)();
  toets('geslaagd → 200 met alleen tellers', r.status === 200 && r.j.ok === true && r.j.nieuw === 1 && r.j.bestond === 1 && r.j.overgeslagen.length === 0 && !('geschreven' in r.j) && !('persoon_id' in r.j), r);
  const m = JSON.parse(fs.readFileSync(envUit, 'utf8'));
  toets('vast commando: -I en alleen --alleen-opgaven', m.flags === 1 && JSON.stringify(m.argv) === '["--alleen-opgaven"]', m);
  toets('werkmap = de vault', fs.realpathSync(m.cwd) === fs.realpathSync(W), m.cwd);
  toets('omgeving alleen de allowlist (geen sleutels, geen VAULT_DIR/HEALTH_*)', m.env.every((k) => ['HOME', 'PATH', 'TZ', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PWD'].indexOf(k) >= 0), m.env);
  const lang = 'x'.repeat(400);
  const over = Array.from({ length: 25 }, (_, i) => ({ route: 'opgaven', rij: 'O-20261023-07' + String(i).padStart(2, '0') + lang, reden: 'waarde 85 staat niet in Davids woorden' + lang }));
  r = await laad(script('over.py', `import sys\nprint(${JSON.stringify(J({ overgeslagen: over }))})\nsys.exit(1)\n`))();
  toets('overgeslagen → 200 ok:false, hooguit 20, ingekort', r.status === 200 && r.j.ok === false && r.j.overgeslagen.length === 20 && r.j.en_nog_overgeslagen === 5 &&
    r.j.overgeslagen.every((o) => o.rij.length <= 120 && o.reden.length <= 300 && Object.keys(o).join() === 'rij,reden'), r.j && r.j.overgeslagen && r.j.overgeslagen[0]);
  r = await laad(script('stop.py', 'import sys\nprint("geheime inhoud Hb 7,1")\nsys.stderr.write("waarschuwing\\nIMPORT GESTOPT: importkaart niet te lezen: pad \'20_Prive/x.md\' bevat een symlink\\n")\nsys.exit(2)\n'))();
  toets('stop → 502 met alleen de IMPORT GESTOPT-regel', r.status === 502 && /^IMPORT GESTOPT: importkaart niet te lezen/.test(r.j.fout) && JSON.stringify(r).indexOf('Hb') < 0 && JSON.stringify(r).indexOf('waarschuwing') < 0, r);
  r = await laad(script('tb.py', 'import sys\nprint("diagnose X")\nsys.stderr.write("Traceback: diagnose Y")\nsys.exit(1)\n'))();
  toets('andere fout → 502 zonder uitvoer van het script', r.status === 502 && r.j.fout === 'de importeur faalde (exit 1)' && JSON.stringify(r).indexOf('diagnose') < 0, r);
  r = await laad(script('droog.py', `print(${JSON.stringify(J({ droog: true }))})\n`))();
  toets('uitvoer die geen echte opgavenronde is → 502', r.status === 502, r);
  r = await laad(script('anders.py', `print(${JSON.stringify(J({ deel: 'dossier', nieuw: 3 }))})\n`))();
  toets('ander deel dan opgaven → 502', r.status === 502, r);
  const pidF = path.join(W, 'pid');
  const traag = laad(script('traag.py', `import os,time\nopen(${JSON.stringify(pidF)},'w').write(str(os.getpid()))\ntime.sleep(30)\n`), 1500);
  const p1 = traag(); await new Promise((k) => setTimeout(k, 300)); const r2 = await traag();
  toets('tweede ronde tijdens de eerste → 409', r2.status === 409 && /loopt al/.test(r2.j.fout), r2);
  r = await p1;
  toets('tijdgrens → 502', r.status === 502 && /langer dan 2 s|langer dan 1 s/.test(r.j.fout), r);
  let leeft = true; try { process.kill(Number(fs.readFileSync(pidF, 'utf8')), 0); } catch (e) { leeft = false; }
  toets('proces na de tijdgrens weg', !leeft);
  r = await traag.call(null);
  toets('na de tijdgrens weer vrij (start opnieuw)', r.status === 502, r);
  primair = false;
  fs.rmSync(envUit, { force: true });
  r = await laad(goedS)();
  toets('reservekant → 409 zonder start', r.status === 409 && !fs.existsSync(envUit), r);
  primair = true;
  r = await laad(path.join(W, 'bestaat-niet.py'))();
  toets('script ontbreekt → 502', r.status === 502, r);
  toets('fouten gelogd zonder inhoud', logs.length >= 5 && logs.every((l) => /^health-opgaven: importeur: (gestopt|tijdgrens|exit -?\d+)$/.test(l)), logs);
  fs.rmSync(W, { recursive: true, force: true });
  console.log('health-opgaven-smal: ' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})();
JS
