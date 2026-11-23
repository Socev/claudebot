'use strict';
// wv3965 (besluitenpagina nr 163 = 2C63, onderdeel e): mijlpalen op Overzicht en in OVIS Calendar met "loopt uit", op VERZONNEN mijlpalen.
// Einde uit "wanneer" (periode → laatste dag, alleen jaar → 31-12), loopt uit = einde voorbij en niet gehaald; Overzicht = de volgende twee;
// Calendar = mijlpalen, verwachte datum van een toezegging en de ANBI-datum als soort mijlpaal, bij het lezen (twee keer lezen = één keer erin).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const G = require('../ghawa.js');
const S = require('../ghawa-stichting.js');
const K = require('../kalender-app.js');
const { vers } = require('./ghawa-fixture.js');

const NU = '2026-11-22T10:00:00.000Z';
const TABEL = '# Proefproject\n\n## Mijlpalen tot de eerste patiënt\n\n| Wanneer | Mijlpaal | Stand | Bron |\n|---|---|---|---|\n' +
  '| 3-3-2025 | Proefstichting opgericht | gehaald | a |\n| jul–sep 2026 | Proefverdieping | bezig | b |\n| aug 2026 | Proefput gegraven | gehaald | c |\n' +
  '| najaar 2026 | Proefdak | gepland | d |\n| eind december 2026 | Proefbouw klaar | gepland | e |\n| 2027 | Proefopening | gepland | f |\n| ooit | Proefwens | gepland | g |\n';
function opzet() {
  const { db, map } = vers();
  const p = path.join(map, S.BRONNEN.project); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, TABEL);
  const x = new DatabaseSync(db);
  x.prepare("UPDATE fonds SET status = 'Committed - not yet received', termijn = '2026-12-15' WHERE id = (SELECT id FROM fonds ORDER BY id LIMIT 1)").run();
  x.close();
  return { db, map, m: G.maak({ dbPad: db, bronnenMap: map, vaultMap: map, nu: () => NU }) };
}

test('einde uit wanneer: datum, maand, periode, begin/eind, seizoen, jaar; onleesbaar = null', () => {
  const t = { '18-10-2023': '2023-10-18', 'mei 2025': '2025-05-31', 'jul–sep 2026': '2026-09-30', 'feb-jun 2024': '2024-06-30', 'eind december 2026': '2026-12-31',
    'begin 2027': '2027-03-31', 'najaar 2026': '2026-11-30', '2027': '2027-12-31', 'dec 2026 – feb 2028': '2028-02-29', 'Q2 2027': '2027-06-30', 'ooit': null, '': null, '31-2-2026': null };
  for (const [w, e] of Object.entries(t)) assert.strictEqual(S.mijlpaalEinde(w), e, w);
});

test('loopt uit: jul–sep 2026 op bezig wel, gehaald niet; Overzicht toont de volgende twee', () => {
  const { m } = opzet();
  const o = m.app({ pad: '/app/ghawa/overzicht' });
  assert.strictEqual(o.status, 200);
  const v = o.body.mijlpalen.volgende;
  assert.deepStrictEqual(v.map((x) => [x.tekst, x.einde, x.loopt_uit]), [['Proefverdieping', '2026-09-30', true], ['Proefdak', '2026-11-30', false]]);
  assert.strictEqual(o.body.mijlpalen.loopt_uit, 1);
  const d = m.app({ pad: '/app/ghawa/doelen' });
  const per = Object.fromEntries(d.body.mijlpalen.map((x) => [x.tekst, x.loopt_uit]));
  assert.strictEqual(per.Proefverdieping, true); assert.strictEqual(per['Proefput gegraven'], false); assert.strictEqual(per.Proefwens, false);
  assert.strictEqual(d.body.mijlpalen.find((x) => x.tekst === 'Proefwens').einde, null);
});

test('Calendar: mijlpalen, toezegging en ANBI als soort mijlpaal, één keer, ook na een tweede ronde; fout = tijdlijn blijft', async () => {
  const { m } = opzet();
  const db = [{ event_id: 7, begin_datum: '2026-11-25', eind_datum: '2026-11-25', hele_dag: true, titel: 'Proefafspraak', soort: 'afspraak', voor_wie: 'david',
    status: 'actief', zekerheid: 'hoog', bron_soort: 'google_spiegel', sync_stand: 'gespiegeld', sync_agenda: 'david', entiteiten: [] }];
  const kal = K.maak({ rpc: async () => db, extra: (van, tot) => m.kalenderItems(van, tot) });
  const nu = Date.parse(NU);
  for (const ronde of [1, 2]) {
    const r = await kal.app({ methode: 'GET', pad: '/app/kalender/2026-11-01/2026-12-31', nu });
    assert.strictEqual(r.status, 200, 'ronde ' + ronde);
    const gh = r.body.regels.filter((x) => x.bron.soort === 'ghawa');
    assert.deepStrictEqual(gh.map((x) => [x.van, x.soort]).sort(), [['2026-11-30', 'mijlpaal'], ['2026-12-15', 'mijlpaal'], ['2026-12-31', 'mijlpaal']], 'ronde ' + ronde);
    assert.ok(gh.every((x) => x.id < 0 && x.bron.tekst === 'GHAWA' && x.voor_wie === 'david'));
    assert.strictEqual(new Set(gh.map((x) => x.id)).size, gh.length);
    assert.strictEqual(r.body.regels.filter((x) => x.id === 7).length, 1);
    assert.strictEqual(r.body.tel.soort.mijlpaal, 3);
  }
  const zomer = await kal.app({ methode: 'GET', pad: '/app/kalender/2027-06-15/2027-07-15', nu });
  assert.deepStrictEqual(zomer.body.regels.filter((x) => x.bron.soort === 'ghawa').map((x) => x.van), ['2027-07-01']);
  const sep = (await kal.app({ methode: 'GET', pad: '/app/kalender/2026-09-01/2026-09-30', nu })).body.regels.filter((x) => x.bron.soort === 'ghawa');
  assert.deepStrictEqual(sep.map((x) => x.titel), ['GHAWA-mijlpaal: Proefverdieping · jul–sep 2026 · loopt uit']);
  const stuk = K.maak({ rpc: async () => db, extra: () => { throw new Error('weg'); } });
  const r = await stuk.app({ methode: 'GET', pad: '/app/kalender/2026-11-01/2026-12-31', nu });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.regels.length, 1); assert.ok(stuk.info().extra_fout);
  const pos = K.maak({ rpc: async () => db, extra: () => [Object.assign({}, db[0])] });   // een positief id uit extra telt nooit (geen dubbele databankrij)
  assert.strictEqual((await pos.app({ methode: 'GET', pad: '/app/kalender/2026-11-01/2026-12-31', nu })).body.regels.length, 1);
});

test('review ZOU 1: lege mijlpalentabel in de vault = geen mijlpalen (niet de oude databankkopie); pagina weg = databankkopie', () => {
  const { map, m } = opzet();
  m.app({ pad: '/app/ghawa/doelen' });   // databankkopie met zeven mijlpalen
  const p = path.join(map, S.BRONNEN.project);
  fs.writeFileSync(p, '# Proefproject\n\n## Mijlpalen tot de eerste patiënt\n\n| Wanneer | Mijlpaal | Stand | Bron |\n|---|---|---|---|\n');
  assert.deepStrictEqual(m.app({ pad: '/app/ghawa/overzicht' }).body.mijlpalen.volgende, []);
  fs.unlinkSync(p);
  assert.strictEqual(m.app({ pad: '/app/ghawa/overzicht' }).body.mijlpalen.volgende.length, 2);
});
