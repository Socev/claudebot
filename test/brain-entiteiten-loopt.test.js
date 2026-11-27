// wv4236 (besluitenpagina nr 952 = L52): "Loopt nu" — koppelen alleen op vaste sleutel (pad/object_id, herkomst.knoop/entiteit), nooit op naam.
// Verzonnen toetsdata. node test/brain-entiteiten-loopt.test.js
'use strict';
const assert = require('assert');
const B = require('../brain-entiteiten.js');
let ok = 0, rood = 0;
function t(naam, f) { try { f(); ok++; console.log('ok  ', naam); } catch (e) { rood++; console.log('ROOD', naam, '-', e.message); } }
const PAD = '10_Zakelijk/Proef/Entiteit - Proefbedrijf.md', OID = '11111111-2222-3333-4444-555555555555';
const rijen = [
  { event_id: 1, soort: 'afspraak', feed: 'google-hagro', hele_dag: false, begin_tijd: '2026-12-02T13:00:00Z', titel: 'Overleg', entiteiten: [{ pad: PAD, rol: 'context' }] },
  { event_id: 2, soort: 'afspraak', feed: 'google-david', hele_dag: true, begin_datum: '2026-12-01', titel: 'Hele dag', entiteiten: [{ object_id: OID.toUpperCase(), rol: 'betreft' }] },
  { event_id: 3, soort: 'afspraak', feed: 'google-david', hele_dag: false, begin_tijd: '2026-12-03T09:00:00Z', titel: 'Proefbedrijf in de titel', entiteiten: [] },   // naam in titel, geen koppeling
  { event_id: 4, soort: 'deadline', bron_soort: 'deadline_register', begin_datum: '2026-12-01', titel: 'Deadline', entiteiten: [{ pad: PAD, rol: 'betreft' }] },
  { event_id: 5, soort: 'afspraak', feed: 'google-gezin', hele_dag: true, begin_datum: '2027-01-30', titel: 'Te ver', entiteiten: [{ pad: PAD, rol: 'context' }] },
  { event_id: 6, soort: 'dienst', feed: 'rooster-tg-artsen', hele_dag: true, begin_datum: '2026-11-30', titel: 'XX', entiteiten: [{ pad: PAD, rol: 'betreft' }, { pad: 'p.md', rol: 'context', naam: 'Proefpraktijk' }] },
];
const punten = [
  { id: 10, status: 'open', titel: 'Kaart met knoop', herkomst: { knoop: 'org:proef' }, deadline: '2026-12-10' },
  { id: 11, status: 'open', titel: 'Kaart over Proefbedrijf (alleen naam)', herkomst: { wv: [1] } },
  { id: 12, status: 'gedaan', titel: 'Dicht', herkomst: { knoop: 'org:proef' } },
  { id: 13, status: 'open', titel: 'Later te tonen', herkomst: { knoop: 'org:proef' }, toon_vanaf: '2099-01-01T00:00:00Z' },
  { id: 14, status: 'open', titel: 'Eigen entiteit', herkomst: { entiteit: 'org:proef' } },
];
const basis = { id: 'org:proef', eigen: false, persoon: false, paden: [PAD], objectId: OID, vandaag: '2026-11-27', tot: '2026-12-11', nu: Date.parse('2026-11-27T12:00:00Z') };
t('afspraken op pad en object_id, niet op naam, deadlines en buiten venster niet', () => {
  const l = B.looptUit(rijen, punten, basis);
  assert.deepStrictEqual(l.afspraken.map((a) => a.titel), ['Hele dag', 'Overleg']);
  assert.strictEqual(l.afspraken[1].tijd, '14:00'); assert.strictEqual(l.afspraken[1].agenda, 'HAGRO');
  assert.strictEqual(l.afspraken_totaal, 2);
  assert.strictEqual(l.diensten, null);   // dienst telt alleen bij een persoon
});
t('kaarten alleen op herkomst.knoop, open en al zichtbaar', () => {
  const l = B.looptUit(rijen, punten, basis);
  assert.deepStrictEqual(l.kaarten.map((k) => k.id), [10]);
  assert.strictEqual(l.kaarten[0].deadline, '2026-12-10');
  const e = B.looptUit(rijen, punten, Object.assign({}, basis, { eigen: true }));
  assert.deepStrictEqual(e.kaarten.map((k) => k.id), [10, 14]);   // herkomst.entiteit alleen bij een eigen entiteit
});
t('persoon: roosterdagen met plek', () => {
  const l = B.looptUit(rijen, punten, Object.assign({}, basis, { persoon: true }));
  assert.deepStrictEqual(l.diensten, { dagen: ['2026-11-30'], totaal: 1, plek: 'Proefpraktijk' });
});
t('Codex ZOU 1: diensten op twee plekken = geen plek', () => {
  const r2 = rijen.concat([{ event_id: 7, soort: 'dienst', hele_dag: true, begin_datum: '2026-12-01', titel: 'XX', entiteiten: [{ pad: PAD, rol: 'betreft' }, { pad: 'q.md', rol: 'context', naam: 'Andere praktijk' }] }]);
  const l = B.looptUit(r2, [], Object.assign({}, basis, { persoon: true }));
  assert.deepStrictEqual(l.diensten, { dagen: ['2026-11-30', '2026-12-01'], totaal: 2, plek: null });
});
t('geen treffer = lege lijsten; bron niet te lezen = null', () => {
  const l = B.looptUit(rijen, punten, Object.assign({}, basis, { id: 'org:ander', paden: ['10_Zakelijk/X.md'], objectId: null }));
  assert.deepStrictEqual([l.kaarten, l.afspraken, l.diensten], [[], [], null]);
  const n = B.looptUit(null, null, basis);
  assert.deepStrictEqual([n.kaarten, n.afspraken], [null, null]);
});
t('masker op titels', () => {
  const l = B.looptUit(rijen, punten, Object.assign({}, basis, { masker: (s) => s.replace(/Overleg/, '[x]') }));
  assert.ok(l.afspraken.some((a) => a.titel === '[x]'));
});
console.log(`\n${ok}/${rood}`);
process.exit(rood ? 1 : 0);
