#!/usr/bin/env bash
# Toetst healthPgxSeintje uit server.js (wv1386, 28-10-2026) in een vm-context tegen een nagebootst script: na de uurronde, ná het
# kaartverzoek; alleen op de primaire kant; argumenten -I <bin> --pgx-seintje; omgeving alleen de allowlist van het kaartverzoek;
# één tegelijk; foutlog alleen met de exitcode. Raakt het echte script, de werkvoorraad en de health-pod niet.
# De eind-tot-eind-proef (echt script + nep-pod → precies één werkvoorraadrij) staat in de machinekamer (mk-scripts/wv1386).
# Gebruik: bash test/health-pgx-seintje.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'pgx-seintje-'));
const src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf('const HEALTH_KAARTVERZOEK '), b = src.indexOf('function bankRondeStart() {');
const c = src.indexOf('function smalKind('), d = src.indexOf('async function smalSbRpc(');
if (a < 0 || b < a || c < 0 || d < c) { console.log('ROOD  blok niet gevonden'); process.exit(1); }
toets('route: seintje ná het kaartverzoek', /healthKaartVerzoek\(\)\.catch\([\s\S]{0,200}\.then\(function \(\) \{ return healthPgxSeintje\(\); \}\)\.catch/.test(src));
const blok = src.slice(c, d) + src.slice(a, b) + '\nthis.healthPgxSeintje = healthPgxSeintje;';
const uitF = path.join(W, 'uit.json');
function script(naam, py) { const p = path.join(W, naam); fs.writeFileSync(p, py); return p; }
const logs = [];
function laad(bin, opts) {
  opts = opts || {};
  const env = Object.assign({}, process.env, { HEALTH_KAARTVERZOEK_MS: String(opts.ms || 5000), HEALTH_POD_SLEUTELS: '/x',
    API_SECRET: 'geheim-x', N8N_API_KEY: 'n8n-x', CLAUDE_CODE_OAUTH_TOKEN: 'tok-x', SUPABASE_URL: 'https://nep.invalid', SUPABASE_SERVICE_ROLE: 'sr-x' });
  const ctx = { require: require, process: { env: env }, spawn: require('child_process').spawn, VAULT: W, HEALTH_OPGAVEN_BIN: bin,
    rolPrimair: function () { return opts.primair !== false; }, logError: function (w, e) { logs.push(w + ': ' + e.message + ' ' + e.code); },
    setTimeout: setTimeout, clearTimeout: clearTimeout, Number: Number, String: String, Promise: Promise, Error: Error };
  vm.createContext(ctx); vm.runInContext(blok, ctx); return ctx.healthPgxSeintje;
}
(async function () {
  const goedS = script('goed.py', `import os,json,sys\njson.dump({"env": sorted(os.environ), "argv": sys.argv[1:]}, open(${JSON.stringify(uitF)},'w'))\nprint('{"pgx": "gezet"}')\n`);
  let r = await laad(goedS, { primair: false })();
  toets('reservekant → niets gestart', r === null && !fs.existsSync(uitF), r);
  r = await laad(goedS)();
  const u = fs.existsSync(uitF) ? JSON.parse(fs.readFileSync(uitF, 'utf8')) : { env: [], argv: [] };
  toets('primair → gestart, exit 0', r === 0, r);
  toets('argumenten alleen <bin> --pgx-seintje (met -I ervoor)', JSON.stringify(u.argv) === '["--pgx-seintje"]', u.argv);
  toets('omgeving met SUPABASE_URL + SUPABASE_SERVICE_ROLE', u.env.indexOf('SUPABASE_URL') >= 0 && u.env.indexOf('SUPABASE_SERVICE_ROLE') >= 0, u.env);
  toets('omgeving zonder geheimen en zonder HEALTH_*', ['API_SECRET', 'N8N_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].every((k) => u.env.indexOf(k) < 0) && !u.env.some((k) => /^HEALTH_/.test(k)), u.env);
  toets('omgeving niets buiten de allowlist', u.env.every((k) => ['HOME', 'PATH', 'TZ', 'LANG', 'LC_ALL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE', 'LC_CTYPE', 'PWD'].indexOf(k) >= 0), u.env);
  toets('exit 0 → geen foutlog', logs.length === 0, logs);
  r = await laad(script('fout.py', 'import sys\nprint("fenotype X")\nsys.stderr.write("Traceback: middel Y")\nsys.exit(2)\n'))();
  toets('exit 2 → foutlog met alleen de exitcode', r === 2 && logs.length === 1 && logs[0] === 'health-pgx-seintje: pgx-seintje exit 2', logs);
  const f = laad(script('traag.py', 'import time\ntime.sleep(30)\n'), { ms: 1200 });
  const p1 = f(); const r2 = await f();
  toets('tweede start tijdens de eerste → niets', r2 === null, r2);
  await p1;
  toets('tijdgrens → foutlog tijdgrens', logs[1] === 'health-pgx-seintje: pgx-seintje tijdgrens', logs);
  toets('geen scriptuitvoer in de foutlog', logs.every((l) => l.indexOf('fenotype') < 0 && l.indexOf('middel') < 0), logs);
  fs.rmSync(W, { recursive: true, force: true });
  console.log('health-pgx-seintje: ' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})();
JS
