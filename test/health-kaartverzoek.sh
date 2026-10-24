#!/usr/bin/env bash
# Toetst healthKaartVerzoek uit server.js (wv1033, 24-10-2026) in een vm-context tegen een nagebootst script:
# start alleen als er op de plek van het verzoek iets ligt (ook een link of map: het script ruimt op), alleen op de primaire kant,
# omgeving alleen de allowlist (SUPABASE_URL + SUPABASE_SERVICE_ROLE wel, API_SECRET/N8N_API_KEY/CLAUDE_CODE_OAUTH_TOKEN niet),
# argumenten -I <bin> --kaartverzoek, één tegelijk, tijdgrens, foutlog alleen met exitcode (geen uitvoer van het script).
# Raakt het echte script, de werkvoorraad en de health-pod niet. Gebruik: bash test/health-kaartverzoek.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'kaartverzoek-'));
const src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf('const HEALTH_KAARTVERZOEK '), b = src.indexOf('function bankRondeStart() {');
const c = src.indexOf('function smalKind('), d = src.indexOf('async function smalSbRpc(');
if (a < 0 || b < a || c < 0 || d < c) { console.log('ROOD  blok niet gevonden'); process.exit(1); }
toets('route roept healthKaartVerzoek na healthRapportenStart aan', /healthRapportenStart\(function \(r\) \{[\s\S]{0,400}healthKaartVerzoek\(\)\.catch/.test(src));
const blok = src.slice(c, d) + src.slice(a, b) + '\nthis.healthKaartVerzoek = healthKaartVerzoek;';
const verzoek = path.join(W, 'kaartverzoek.json');
const uitF = path.join(W, 'uit.json');
function script(naam, py) { const p = path.join(W, naam); fs.writeFileSync(p, py); return p; }
const logs = [];
function laad(bin, opts) {
  opts = opts || {};
  const env = Object.assign({}, process.env, { HEALTH_KAARTVERZOEK: verzoek, HEALTH_KAARTVERZOEK_MS: String(opts.ms || 5000),
    API_SECRET: 'geheim-x', N8N_API_KEY: 'n8n-x', CLAUDE_CODE_OAUTH_TOKEN: 'tok-x', SUPABASE_URL: 'https://nep.invalid', SUPABASE_SERVICE_ROLE: 'sr-x' });
  const ctx = { require: require, process: { env: env }, spawn: require('child_process').spawn, VAULT: W, HEALTH_OPGAVEN_BIN: bin,
    rolPrimair: function () { return opts.primair !== false; }, logError: function (w, e) { logs.push(w + ': ' + e.message + ' ' + e.code); },
    setTimeout: setTimeout, clearTimeout: clearTimeout, Number: Number, String: String, Promise: Promise, Error: Error };
  vm.createContext(ctx); vm.runInContext(blok, ctx); return ctx.healthKaartVerzoek;
}
(async function () {
  const goedS = script('goed.py', `import os,json,sys\njson.dump({"env": sorted(os.environ), "argv": sys.argv[1:]}, open(${JSON.stringify(uitF)},'w'))\nprint('{"kaartverzoek": "gezet"}')\n`);
  let r = await laad(goedS)();
  toets('geen verzoekbestand → niets gestart', r === null && !fs.existsSync(uitF), r);
  fs.symlinkSync(path.join(W, 'bestaat-niet'), verzoek);
  r = await laad(goedS)();
  toets('verzoek is een (dode) link → wel gestart (script weigert en ruimt op)', r === 0 && fs.existsSync(uitF), r);
  fs.unlinkSync(verzoek); fs.unlinkSync(uitF); fs.mkdirSync(verzoek);
  r = await laad(goedS)();
  toets('verzoek is een map → wel gestart', r === 0 && fs.existsSync(uitF), r);
  fs.rmdirSync(verzoek); fs.unlinkSync(uitF); fs.writeFileSync(verzoek, '{}');
  r = await laad(goedS, { primair: false })();
  toets('reservekant → niets gestart', r === null && !fs.existsSync(uitF), r);
  r = await laad(goedS)();
  const u = fs.existsSync(uitF) ? JSON.parse(fs.readFileSync(uitF, 'utf8')) : { env: [], argv: [] };
  toets('gewoon bestand → gestart, exit 0', r === 0, r);
  toets('argumenten alleen <bin> --kaartverzoek (met -I ervoor)', JSON.stringify(u.argv) === '["--kaartverzoek"]', u.argv);
  toets('omgeving met SUPABASE_URL + SUPABASE_SERVICE_ROLE', u.env.indexOf('SUPABASE_URL') >= 0 && u.env.indexOf('SUPABASE_SERVICE_ROLE') >= 0, u.env);
  toets('omgeving zonder API_SECRET/N8N_API_KEY/CLAUDE_CODE_OAUTH_TOKEN/HEALTH_*', ['API_SECRET', 'N8N_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].every((k) => u.env.indexOf(k) < 0) && !u.env.some((k) => /^HEALTH_/.test(k)), u.env);
  toets('omgeving niets buiten de allowlist', u.env.every((k) => ['HOME', 'PATH', 'TZ', 'LANG', 'LC_ALL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE', 'LC_CTYPE', 'PWD'].indexOf(k) >= 0), u.env);
  toets('exit 0 → geen foutlog', logs.length === 0, logs);
  r = await laad(script('fout.py', 'import sys\nprint("geheime inhoud Hb 7,1")\nsys.stderr.write("Traceback: diagnose X")\nsys.exit(1)\n'))();
  toets('exit 1 → foutlog met alleen de exitcode', r === 1 && logs.length === 1 && logs[0] === 'health-kaartverzoek: kaartverzoek exit 1' , logs);
  const traag = script('traag.py', 'import time\ntime.sleep(30)\n');
  const f = laad(traag, { ms: 1200 });
  const p1 = f(); const r2 = await f();
  toets('tweede start tijdens de eerste → niets', r2 === null, r2);
  r = await p1;
  toets('tijdgrens → foutlog tijdgrens', logs[1] === 'health-kaartverzoek: kaartverzoek tijdgrens', logs);
  r = await f.call(null);
  toets('na de tijdgrens weer vrij (startte opnieuw)', logs.length === 3, logs);
  toets('geen scriptuitvoer in de foutlog', logs.every((l) => l.indexOf('Hb') < 0 && l.indexOf('diagnose') < 0), logs);
  fs.rmSync(W, { recursive: true, force: true });
  console.log('health-kaartverzoek: ' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})();
JS
