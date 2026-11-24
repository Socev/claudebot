'use strict';
// wv3906 (3C156): dagplan in Vandaag te doen + Zet erbij. Verzonnen toetsdata.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const D = require('../dagplan-app.js');

const PLAN = [
  '# Heartbeat', '', '## Toon', 'kort', '', '---', '',
  '## 📅 Dagplan vandaag (automatisch)', '',
  '> uitleg', '',
  '**Dinsdag 24 november 2026.**',
  'Agenda vandaag: niets bijzonders.', '',
  '- [x] tik 08:00 - agendavoorstel (één bericht, met vraagregel): "Zal ik de afspraak "Proefoverleg" op donderdag 26 november 14:00-17:00 in je Werk-agenda zetten?" Context in één zin: verzonnen. Eerst opnieuw meten via de agenda-API. — gedaan 08:00: kaart gezet',
  '- [ ] tik 12:00 - agendavoorstel (één bericht, met vraagregel): "Zal ik de afspraak "Werksessie" op maandag 14 december in je HAGRO-agenda zetten?" Erbij in één regel: verzonnen.',
  '- [ ] tik 18:00 - herinner David: morgen (woensdag 25 november) de groene bak aan de straat. (Eerst de tijdlijn meten.)',
  '- [ ] tik 15:00 - herinner David: proefpakket ophalen bij de buren (doorgeschoven 1x sinds 23-11; reden: reden onbekend)',
  '', '## Na de sectie', '- [ ] tik 09:00 - hoort er niet bij',
].join('\n');

test('lees: regels van vandaag, opgeschoond voor David', function () {
  const l = D.lees(PLAN, '2026-11-24');
  assert.strictEqual(l.datum, '2026-11-24');
  assert.strictEqual(l.regels.length, 4);
  assert.deepStrictEqual(l.regels.map(function (r) { return [r.tijd, r.open]; }), [['08:00', false], ['12:00', true], ['18:00', true], ['15:00', true]]);
  assert.strictEqual(l.regels[0].tekst, 'Zal ik de afspraak "Proefoverleg" op donderdag 26 november 14:00-17:00 in je Werk-agenda zetten?');
  assert.strictEqual(l.regels[2].tekst, 'Morgen (woensdag 25 november) de groene bak aan de straat.');
  assert.strictEqual(l.regels[3].tekst, 'Proefpakket ophalen bij de buren');
  assert.ok(l.regels.every(function (r) { return /^[0-9a-f]{12}$/.test(r.sleutel); }));
});
test('lees: plan van gisteren of geen sectie = geen regels', function () {
  assert.deepStrictEqual(D.lees(PLAN, '2026-11-25').regels, []);
  assert.deepStrictEqual(D.lees('# niets', '2026-11-24'), { datum: null, regels: [] });
});
test('sleutel hangt aan de plandatum (Codex MOET 2)', function () {
  const morgen = PLAN.replace('Dinsdag 24 november', 'Woensdag 25 november');
  const a = D.lees(PLAN, '2026-11-24').regels[1].sleutel, b = D.lees(morgen, '2026-11-25').regels[1].sleutel;
  assert.notStrictEqual(a, b);
  const r = D.veeg(morgen, a, { vandaag: '2026-11-25', hhmm: '10:00', nuMin: 600 });
  assert.strictEqual(r.status, 409);
});
test('veeg: alleen die open regel, daarna niet meer open; tweede veeg 409', function () {
  const k = D.lees(PLAN, '2026-11-24').regels[2].sleutel;
  const r = D.veeg(PLAN, k, { vandaag: '2026-11-24', hhmm: '10:12', nuMin: 612 });
  assert.ok(r.tekst, JSON.stringify(r));
  assert.ok(r.tekst.includes('- [x] tik 18:00 - herinner David: morgen (woensdag 25 november) de groene bak aan de straat. (Eerst de tijdlijn meten.) — weggeveegd door David 10:12 (niet doen)'));
  assert.strictEqual(r.tekst.split('\n').length, PLAN.split('\n').length);
  const l = D.lees(r.tekst, '2026-11-24');
  assert.strictEqual(l.regels[2].open, false);
  assert.strictEqual(l.regels[2].tekst, 'Morgen (woensdag 25 november) de groene bak aan de straat.');
  assert.strictEqual(D.veeg(r.tekst, k, { vandaag: '2026-11-24', hhmm: '10:13', nuMin: 613 }).status, 409);   // sleutel = ruwe regel → nu onbekend
  const k0 = D.lees(PLAN, '2026-11-24').regels[0].sleutel;
  assert.strictEqual(D.veeg(PLAN, k0, { vandaag: '2026-11-24', hhmm: '10:12', nuMin: 612 }).fout, 'deze regel is al gedaan of weg');
  assert.strictEqual(D.veeg(PLAN, 'abcdefabcdef', { vandaag: '2026-11-24', hhmm: '10:12', nuMin: 612 }).status, 409);
});
test('claim [~]: niet open, veeg 409; ruw = volledige regel', function () {
  const k = D.lees(PLAN, '2026-11-24').regels[1];
  assert.ok(k.ruw.startsWith('tik 12:00 - agendavoorstel') && k.ruw.endsWith('Erbij in één regel: verzonnen.'));
  const p2 = PLAN.replace('- [ ] tik 12:00', '- [~] tik 12:00');
  const r = D.lees(p2, '2026-11-24').regels[1];
  assert.deepStrictEqual([r.open, r.bezig], [false, true]);
  assert.strictEqual(D.veeg(p2, r.sleutel, { vandaag: '2026-11-24', hhmm: 'x', nuMin: 600 }).fout, 'Socev is hier nu mee bezig; probeer het over een kwartier');
});
test('veeg in een tikvenster weigert (Codex MOET 3)', function () {
  const l = D.lees(PLAN, '2026-11-24').regels;
  const o = function (min) { return { vandaag: '2026-11-24', hhmm: 'x', nuMin: min }; };
  assert.strictEqual(D.veeg(PLAN, l[1].sleutel, o(12 * 60 + 5)).status, 409);        // 12:00-regel tijdens tik 12:00
  assert.ok(D.veeg(PLAN, l[2].sleutel, o(12 * 60 + 5)).tekst);                         // 18:00-regel tijdens tik 12:00 mag
  assert.strictEqual(D.veeg(PLAN, l[2].sleutel, o(15 * 60 + 2)).status, 409);        // 18:00-regel tijdens tik 15:00 (thuisdingen)
  assert.ok(D.veeg(PLAN, l[2].sleutel, o(15 * 60 + 25)).tekst);                        // na het venster
  assert.strictEqual(D.tikBezig(null, 8 * 60 + 1), true);
  assert.strictEqual(D.tikBezig('18:00', 7 * 60 + 10), false);
});

// 24-11-2026 is wintertijd (UTC+1)
const T = function (hm, dag) { return D.msVan(dag || '2026-11-24', Number(hm.slice(0, 2)), Number(hm.slice(3))); };
const tijd = function (zin, nu, dag) { const r = D.tijdUit(zin, T(nu, dag)); if (!r) return null; const a = D.ams(r.wanneer); return a.ymd.slice(5) + ' ' + String(a.h).padStart(2, '0') + ':' + String(a.m).padStart(2, '0') + ' | ' + r.tekst; };
test('tijdUit: de zinnen uit de opdracht en varianten', function () {
  assert.strictEqual(tijd('herinner me om drie uur aan de proefsalarissen', '10:00'), '11-24 15:00 | De proefsalarissen');
  assert.strictEqual(tijd('Herinner me om 3 uur aan Proefbedrijf bellen', '16:00'), '11-25 15:00 | Proefbedrijf bellen');
  assert.strictEqual(tijd('om 8 uur pakket ophalen', '07:00'), '11-24 08:00 | Pakket ophalen');
  assert.strictEqual(tijd('om 8 uur pakket ophalen', '09:00'), '11-24 20:00 | Pakket ophalen');
  assert.strictEqual(tijd('half vier de bak buiten', '10:00'), '11-24 15:30 | De bak buiten');
  assert.strictEqual(tijd('kwart over drie bellen', '10:00'), '11-24 15:15 | Bellen');
  assert.strictEqual(tijd('kwart voor vier bellen', '10:00'), '11-24 15:45 | Bellen');
  assert.strictEqual(tijd('tien voor half vijf vertrekken', '10:00'), '11-24 16:20 | Vertrekken');
  assert.strictEqual(tijd('om 15:30 medicijnen', '10:00'), '11-24 15:30 | Medicijnen');
  assert.strictEqual(tijd('15.30 medicijnen', '16:00'), '11-25 15:30 | Medicijnen');
  assert.strictEqual(tijd('om 06:30 vroeg op', '10:00'), '11-25 06:30 | Vroeg op');
  assert.strictEqual(tijd('over 20 minuten de oven uit', '10:00'), '11-24 10:20 | De oven uit');
  assert.strictEqual(tijd('herinner me over een uur aan de was', '10:00'), '11-24 11:00 | De was');
  assert.strictEqual(tijd('over een kwartier thee', '10:00'), '11-24 10:15 | Thee');
  assert.strictEqual(tijd('morgen om negen uur de garage', '10:00'), '11-25 09:00 | De garage');
  assert.strictEqual(tijd("om 7 uur 's avonds sporten", '10:00'), '11-24 19:00 | Sporten');
  assert.strictEqual(tijd('vanavond om half acht film', '10:00'), '11-24 19:30 | Film');
  assert.strictEqual(tijd("'s ochtends om acht uur fietsen", '10:00'), '11-25 08:00 | Fietsen');
  assert.strictEqual(tijd('om twaalf uur lunch', '10:00'), '11-24 12:00 | Lunch');
  assert.strictEqual(tijd('om 3 uur', '10:00'), '11-24 15:00 | Om 3 uur');
});
test('tijdUit: geen tijd = null', function () {
  assert.strictEqual(D.tijdUit('de bak buiten zetten', T('10:00')), null);
  assert.strictEqual(D.tijdUit('', T('10:00')), null);
  assert.strictEqual(D.tijdUit('om 25 uur', T('10:00')), null);
});
test('tijdUit: zomertijd (juli, UTC+2)', function () {
  assert.strictEqual(tijd('om drie uur proef', '10:00', '2026-07-01'), '07-01 15:00 | Proef');
  const r = D.tijdUit('om drie uur proef', T('10:00', '2026-07-01'));
  assert.strictEqual(new Date(r.wanneer).toISOString(), '2026-07-01T13:00:00.000Z');
});

test('klok: erbij, zichtbaar, tik stuurt één keer, weg stuurt niet, fout → opnieuw + één box-rij', async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dagplan-'));
  let nu = T('10:00');
  const gestuurd = [], box = [];
  let faal = false;
  const k = D.maak({ staatPad: path.join(dir, 'dagplan-erbij', 'erbij.json'), nu: function () { return nu; },
    melden: async function (t, sl) { if (faal) throw new Error('pod weg'); gestuurd.push([t, sl]); }, boxRij: function (t) { box.push(t); } });
  const a = k.erbij('herinner me om drie uur aan de proefsalarissen');
  assert.deepStrictEqual([a.ok, a.tijd, a.dag, a.tekst], [true, '15:00', 'vandaag', 'De proefsalarissen']);
  const b = k.erbij('om half vier proef weg');
  assert.strictEqual(k.erbij('geen tijd hier').status, 400);
  assert.strictEqual(k.zichtbaar(nu).length, 2);
  assert.strictEqual((fs.statSync(path.join(dir, 'dagplan-erbij', 'erbij.json')).mode & 0o777), 0o600);
  assert.deepStrictEqual(k.weg(b.id), { ok: true });
  assert.strictEqual(k.weg(b.id).status, 409);
  nu = T('14:59'); await k.tik(); assert.strictEqual(gestuurd.length, 0);
  nu = T('15:00'); faal = true; await k.tik(); assert.strictEqual(gestuurd.length, 0);
  nu = T('15:31'); await k.tik(); assert.strictEqual(box.length, 1);
  nu = T('15:32'); await k.tik(); assert.strictEqual(box.length, 1);
  faal = false; nu = T('15:33'); await k.tik();
  assert.deepStrictEqual(gestuurd, [['Herinnering: De proefsalarissen', 'herinnering-david-' + a.id]]);
  nu = T('15:40'); await k.tik(); assert.strictEqual(gestuurd.length, 1);   // half vier was weggeveegd, 15:00 al verstuurd
  const z = k.zichtbaar(nu);
  assert.deepStrictEqual(z.map(function (x) { return [x.tijd, x.open]; }), [['15:00', false]]);
  // te laat (pod lag stil)
  const c = k.erbij('om vier uur proef laat');
  nu = T('18:30'); await k.tik();
  assert.strictEqual(gestuurd[1][0], 'Herinnering (te laat: gepland 16:00): Proef laat');
  assert.strictEqual(k.weg(c.id).status, 409);
  fs.rmSync(dir, { recursive: true, force: true });
});
