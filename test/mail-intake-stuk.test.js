// wv2344: mailIntakeStukken (server.js) — per Gmail-draad het Intake-stuk voor de Mail-knop "Waar hoort dit?". Knipt de functie uit
// server.js en draait hem op een wegwerp-databank met het schema van stuk en live_stuk (verzonnen id's). Raakt /opt/data niet.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const begin = src.indexOf('function mailIntakeStukken(');
assert.ok(begin > 0, 'mailIntakeStukken staat in server.js');
const eind = src.indexOf('\n}\n', begin);
const ctx = { Map };
vm.runInNewContext(src.slice(begin, eind + 2), ctx);
const f = ctx.mailIntakeStukken;

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE stuk (stuk_id TEXT PRIMARY KEY, bron TEXT NOT NULL, bron_id TEXT NOT NULL, profiel TEXT NOT NULL, versie INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL, aangemaakt TEXT NOT NULL, meta TEXT NOT NULL);
    CREATE TABLE live_stuk (stuk_id TEXT PRIMARY KEY, versie INTEGER NOT NULL, bron TEXT NOT NULL, staat TEXT NOT NULL, sinds TEXT NOT NULL);`);
  const s = d.prepare("INSERT INTO stuk VALUES (?, ?, ?, 'mail', 1, 'compleet', ?, ?)");
  const l = d.prepare('INSERT INTO live_stuk VALUES (?, 1, ?, ?, ?)');
  const zet = function (id, bron, draad, staat, sinds) { s.run(id, bron, id.slice(-8) + 'aaaaaaaa', sinds, JSON.stringify({ thread_id: draad })); if (staat) l.run(id, bron, staat, sinds); };
  zet('stk_20261101_00000001', 'gmail:david', 'aaaa0000bbbb0001', 'klaar', '2026-11-01T08:00:00Z');
  zet('stk_20261102_00000002', 'gmail:david', 'aaaa0000bbbb0001', 'klaar', '2026-11-02T08:00:00Z');        // nieuwer, zelfde draad
  zet('stk_20261101_00000003', 'gmail:david', 'aaaa0000bbbb0002', 'twijfel', '2026-11-01T08:00:00Z');
  zet('stk_20261103_00000004', 'gmail:david', 'aaaa0000bbbb0002', 'klaar', '2026-11-03T08:00:00Z');        // nieuwer maar wachtend gaat voor
  zet('stk_20261101_00000005', 'gmail:david', 'aaaa0000bbbb0003', 'bewaard', '2026-11-01T08:00:00Z');      // buiten de Brain: niet tonen
  zet('stk_20261101_00000006', 'gmail:david', 'aaaa0000bbbb0004', 'weg', '2026-11-01T08:00:00Z');
  zet('stk_20261101_00000007', 'gmail:groenhouten', 'aaaa0000bbbb0005', 'klaar', '2026-11-01T08:00:00Z'); // ander postvak
  zet('stk_20261101_00000008', 'gmail:david', 'aaaa0000bbbb0006', null, '2026-11-01T08:00:00Z');          // nog niet live
  zet('stk_20261101_00000009', 'gmail:david', 'aaaa0000bbbb0007', 'vastgehouden', '2026-11-01T08:00:00Z');
  zet('stk_20261101_0000000a', 'gmail:david', 'aaaa0000bbbb0008', 'automatisch', '2026-11-01T08:00:00Z');
  zet('stuk-zonder-vorm', 'gmail:david', 'aaaa0000bbbb0009', 'klaar', '2026-11-01T08:00:00Z');            // geen stk_-vorm: niet doorgeven
  return d;
}

test('per draad het juiste stuk, alleen live wachtend of met een plek', function () {
  const m = f(db(), ['aaaa0000bbbb0001', 'aaaa0000bbbb0002', 'aaaa0000bbbb0003', 'aaaa0000bbbb0004', 'aaaa0000bbbb0005', 'aaaa0000bbbb0006',
    'aaaa0000bbbb0007', 'aaaa0000bbbb0008', 'aaaa0000bbbb0009', 'ffff0000ffff0000']);
  assert.strictEqual(m.get('aaaa0000bbbb0001'), 'stk_20261102_00000002', 'nieuwste bij gelijke staat');
  assert.strictEqual(m.get('aaaa0000bbbb0002'), 'stk_20261101_00000003', 'wachtend gaat voor');
  assert.strictEqual(m.get('aaaa0000bbbb0007'), 'stk_20261101_00000009', 'vastgehouden telt als wachtend');
  assert.strictEqual(m.get('aaaa0000bbbb0008'), 'stk_20261101_0000000a', 'automatisch = plek gekregen');
  for (const d of ['aaaa0000bbbb0003', 'aaaa0000bbbb0004', 'aaaa0000bbbb0005', 'aaaa0000bbbb0006', 'aaaa0000bbbb0009', 'ffff0000ffff0000']) assert.ok(!m.has(d), d + ' niet');
  assert.strictEqual(m.size, 4);
});

test('vreemde invoer: geen fout, niets terug', function () {
  const d = db();
  assert.strictEqual(f(null, ['aaaa0000bbbb0001']).size, 0);
  assert.strictEqual(f(d, null).size, 0);
  assert.strictEqual(f(d, []).size, 0);
  assert.strictEqual(f(d, ["' OR 1=1 --", 'AAAA0000BBBB0001', null, 12, {}]).size, 0);
});

test('koppeling in appMailZaken: alleen het id, typeof-bewaakt, fout gelogd', function () {
  const a = src.indexOf('function appMailZaken('), b = src.indexOf('\n}\n', a);
  const body = src.slice(a, b);
  assert.ok(body.includes("typeof mailIntakeStukken === 'function' && typeof mailmanIntakeOpen === 'function'"));
  assert.ok(body.includes("z.intake_stuk = st.get(String(z.draad)) || null;"));
  assert.ok(body.includes("logError('mail-zaken-intake', e)"));
  assert.ok(body.indexOf('mail-zaken-intake') > body.indexOf("if (appAfscherm(a)) return appWeiger(res, 403"), 'na de afschermtoets');
});
