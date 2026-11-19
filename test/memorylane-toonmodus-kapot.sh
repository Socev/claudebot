#!/usr/bin/env bash
# Toetst A04 (Fable-review 19-11-2026, memorylane § 12): toonmodus.json onleesbaar of kapot = DICHT (elk apparaat in de toonmodus, zetten
# weigert, één box-rij, logregel zonder inhoud); geen bestand = niemand; geldig bestand = ongewijzigd gedrag; hersteld = binnen een minuut terug.
# Knipsel-toets in een vm op server.js (mlToonPad … mlToonZet + appLeesStreng/appSchrijfJson); verzonnen apparaat-ids.
# Gebruik: bash test/memorylane-toonmodus-kapot.sh [server.js]
set -u
cd "$(dirname "$0")/.." || exit 1
SRC="${1:-server.js}" node --no-warnings - <<'JS'
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm'), assert = require('assert');
const s = fs.readFileSync(process.env.SRC, 'utf8');
const knip = (van, tot) => { const a = s.indexOf(van), b = s.indexOf(tot, a); assert(a > 0 && b > a, 'knipsel ' + van); return s.slice(a, b); };
const code = knip('function appLeesStreng(f, leeg)', 'function appConfig()') + '\n' + knip('function mlToonPad()', 'async function appStatus(') +
  '\nthis.aan = mlToonAan; this.zet = mlToonZet;';
// de poort laat bij mlToonAan alleen de toonroutes door (al getoetst in memorylane-delen.test.js wv2306); hier: wanneer mlToonAan waar is
assert(/if \(mlToonAan\(a\.id\) && !ML_TOON_ROUTES\.some\(/.test(s), 'toonpoort');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mltoon-')), pad = path.join(dir, 'toonmodus.json');
const A = 'app-verzonnen-a', B = 'app-verzonnen-b';
let ok = 0;
function nieuw(klok) {
  const logs = [], box = [];
  const ctx = { fs, path, JSON, Error, Object, String, Array, Date: { now: () => klok.t }, HERINNERINGEN_DIR: dir, APP_DATA: dir, process,
    logError: (l, e) => logs.push(l + ': ' + (e && e.message)), ovisBoxRij: (t) => { box.push(t); return true; } };
  ctx.Date = Object.assign(function () { return new Date(klok.t); }, { now: () => klok.t });
  vm.createContext(ctx); vm.runInContext(code.replace(/new Date\(\)/g, 'new Date(klok_t())'), Object.assign(ctx, { klok_t: () => klok.t }));
  return { aan: ctx.aan, zet: ctx.zet, logs, box };
}
const geval = (naam, f) => { f(); console.log('GROEN ' + naam); ok++; };
const klok = { t: Date.parse('2026-11-19T12:00:00Z') };
geval('geen bestand: niemand in de toonmodus, zetten werkt', () => {
  const m = nieuw(klok);
  assert.strictEqual(m.aan(A), false); assert.strictEqual(m.zet(A, true), true); assert.strictEqual(m.aan(A), true); assert.strictEqual(m.aan(B), false);
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(pad, 'utf8')).apparaten), [A]); assert.strictEqual(m.box.length, 0);
});
geval('geldig bestand: ongewijzigd (alleen het genoemde apparaat)', () => {
  const m = nieuw(klok);
  assert.strictEqual(m.aan(A), true); assert.strictEqual(m.aan(B), false); assert.strictEqual(m.aan(''), false);
  assert.strictEqual(m.zet(A, false), true); assert.strictEqual(m.aan(A), false); assert.strictEqual(m.logs.length, 0);
});
for (const [soort, inhoud] of [['geen JSON', '{"apparaten": {"' + A + '": "2026-1'], ['lijst i.p.v. object', '{"apparaten": []}'], ['zonder apparaten', '{}'], ['null', 'null']]) {
  geval('kapot (' + soort + '): elk apparaat in de toonmodus, zetten weigert, bestand blijft, één box-rij', () => {
    fs.writeFileSync(pad, inhoud);
    const m = nieuw(klok);
    assert.strictEqual(m.aan(A), true); assert.strictEqual(m.aan(B), true, 'ook een apparaat dat er niet in stond');
    assert.strictEqual(m.zet(B, false), false, 'zetten weigert'); assert.strictEqual(m.zet(B, true), false);
    assert.strictEqual(fs.readFileSync(pad, 'utf8'), inhoud, 'niet overschreven');
    assert.strictEqual(m.box.length, 1); assert.match(m.box[0], /^\n## \[direct\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} — MemoryLane-toonmodus overal aan/);
    assert.ok(m.logs.length >= 1 && m.logs.every((l) => !l.includes(A) && !l.includes('2026-1')), 'log zonder inhoud');
    m.aan(A); m.aan(B); assert.strictEqual(m.logs.length, 1, 'binnen de minuut geen nieuwe leespoging');
  });
}
geval('hersteld: na een minuut weer gewoon (en nog steeds één box-rij)', () => {
  fs.writeFileSync(pad, '{oeps');
  const m = nieuw(klok);
  assert.strictEqual(m.aan(B), true);
  fs.writeFileSync(pad, JSON.stringify({ apparaten: { [A]: '2026-11-19T11:00:00.000Z' } }));
  assert.strictEqual(m.aan(B), true, 'binnen de minuut nog dicht');
  klok.t += 61000;
  assert.strictEqual(m.aan(B), false); assert.strictEqual(m.aan(A), true); assert.strictEqual(m.zet(B, true), true);
  assert.strictEqual(m.box.length, 1);
});
fs.rmSync(dir, { recursive: true, force: true });
console.log('GROEN ' + ok + '/7');
JS
