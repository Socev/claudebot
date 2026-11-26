'use strict';
// wv4170 (besluitenpagina nr 154 = 2C54, David Ja 25-11-2026 22:27; Fable-review "Een 9 - vastgoed" § S1, S4, S6): de drie getallen bovenaan
// Vastgoed (restschuld incl. de woninglening van de Holding, overwaarde als indicatie, rentevast tot) sluiten op de hypotheekpagina en op
// Financiën; de rentevaste datum uit je Excel vult een "onbekend" op de pagina; een box leest "Gebruik" uit zijn Kerngegevens.
// Verzonnen dossier (test/vastgoed-maak.js) plus een verzonnen bank-json en DGA-json in de echte vorm. VASTGOED_JS=<pad> voor de kruisproef.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const VJS = process.env.VASTGOED_JS || path.join(__dirname, '..', 'vastgoed.js');
const V = require(VJS), WB = require(path.join(path.dirname(VJS), 'woning-bron.js'));
const M = require('./vastgoed-maak.js');

const DGA = { contracten: { woninglening: { hoofdsom: 20000, ingangsdatum: '2023-07-01', rente_pct: 4.2 } },
  woninglening_verloop: { samenvatting: { jaarrekening: { 2023: 20000, 2024: 19600, 2025: 19100 } } } };
function vault(o) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-kern-'));
  const v = M.maakVault(path.join(t, 'vault'));
  const fin = path.join(v, '20_Prive', 'Bronnen', 'Financien'); fs.mkdirSync(fin, { recursive: true });
  const delen = [['Hypo1', 11, 119000, '2031-05-01'], ['Hypo2', 12, 29800, '2031-05-01'], ['Hypo3', 13, 17900, '2031-05-01'], ['Hypo4', 14, 27900, '2028-06-01']]
    .map((x) => ({ bank_leningdeel: x[1], excel_deel: x[0], bank_restschuld: x[2], bank_rente_pct: 1.5, rentevast_tm_excel_groen: x[3] }));
  fs.writeFileSync(path.join(fin, 'Prive - 2026-11-20 - Hypotheek bank vs Excel data.json'), JSON.stringify({ bron_bank: 'bankapp, schermafdruk 20-11-2026', bank_totaal_restschuld: 194600, leningdelen: delen }));
  if (!(o && o.zonderDga)) {
    const h = path.join(v, '10_Zakelijk', 'Holding', 'Bronnen'); fs.mkdirSync(h, { recursive: true });
    fs.writeFileSync(path.join(h, 'Holding - 2026-10-26 - DGA-reconstructie data.json'), JSON.stringify(DGA));
  }
  if (o && o.gebruik) {
    const p = path.join(v, '20_Prive', 'Huis', 'Garagebox-Hofstraat-110-12.md');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('| Hypotheek | Niet nodig |', '| Hypotheek | Niet nodig |\n| Gebruik | **verhuurd** |'));
  }
  return { t, v, weg: () => fs.rmSync(t, { recursive: true, force: true }) };
}
async function proef(o) {
  const x = vault(o);
  const m = V.maak({ map: path.join(x.t, 'map'), vault: x.v, bronnen: M.nepBronnen(), nu: () => new Date('2026-11-26T10:00:00Z') });
  m.leesDossier();
  await m.ververs(m.overzicht().objecten.find((o) => o.soort === 'woning').id);   // de CBS-index (nep) voor de indicatie
  return Object.assign(x, { u: m.overzicht() });
}

test('woninglening Holding: dezelfde trap als Financiën (0 vóór de ingang, hoofdsom, dan de laatste jaarrekening die voorbij is)', () => {
  assert.deepStrictEqual(WB.holdingLeningUit(DGA, '2023-06-30'), { hoofdsom: 20000, ingang: '2023-07-01', rente_pct: 4.2, stand: 0, stand_op: null, stand_bron: 'nog niet ingegaan' });
  assert.strictEqual(WB.holdingLeningUit(DGA, '2023-08-01').stand_bron, 'contract');
  assert.strictEqual(WB.holdingLeningUit(DGA, '2025-12-30').stand, 19600);
  const n = WB.holdingLeningUit(DGA, '2026-11-26');
  assert.strictEqual(n.stand, 19100); assert.strictEqual(n.stand_bron, 'jaarrekening 2025');
  assert.strictEqual(WB.holdingLeningUit({}, '2026-11-26'), null);
});

test('tegels sluiten: hypotheek (woning + box) = banktotaal; restschuld = woningdelen + Holding; overwaarde = indicatie − restschuld', async () => {
  const x = await proef();
  try {
    const w = x.u.objecten.find((o) => o.soort === 'woning'), k = w.geld_kern;
    assert.ok(k, 'geld_kern ontbreekt');
    assert.strictEqual(k.hypotheek.totaal, 194600);
    assert.strictEqual(k.hypotheek.restschuld, 119000 + 29800 + 27900);
    assert.deepStrictEqual(k.hypotheek.elders, [{ naam: 'Garagebox 7', restschuld: 17900 }]);
    assert.strictEqual(k.holding.stand, 19100);
    assert.strictEqual(k.restschuld, 119000 + 29800 + 27900 + 19100);
    assert.ok(w.indicatie && w.indicatie.waarde > 0);
    assert.strictEqual(k.overwaarde, Math.round(w.indicatie.waarde - k.restschuld));
    assert.strictEqual(k.reden, null);
    assert.strictEqual(x.u.geld.holding.ok, true);
  } finally { x.weg(); }
});

test('rentevast tot: vroegste datum over de hele hypotheek; "onbekend" op de pagina wordt de datum uit je Excel (zoals Financiën)', async () => {
  const x = await proef();
  try {
    const w = x.u.objecten.find((o) => o.soort === 'woning');
    const d4 = w.leningdelen.find((d) => d.naam.startsWith('Hypo4'));
    assert.strictEqual(d4.rentevast_tot, '1-6-2028 (je Excel)');
    assert.deepStrictEqual(w.geld_kern.rentevast, { datum: '2028-06-01', deel: 'Hypo4 Zolder', restschuld: 27900, excel: true, zonder_datum: 0 });
    assert.strictEqual(w.leningdelen.find((d) => d.naam.startsWith('Hypo1')).rentevast_tot, '1-5-2031');   // de pagina gaat voor
  } finally { x.weg(); }
});

test('zonder DGA-json: geen restschuld en geen overwaarde, met de reden (nooit stil een te lage schuld)', async () => {
  const x = await proef({ zonderDga: true });
  try {
    const k = x.u.objecten.find((o) => o.soort === 'woning').geld_kern;
    assert.strictEqual(k.restschuld, null); assert.strictEqual(k.overwaarde, null); assert.strictEqual(k.holding, null);
    assert.match(k.reden.join(' '), /Holding/);
    assert.strictEqual(k.hypotheek.restschuld, 176700);
  } finally { x.weg(); }
});

test('geldKern: een leningdeel zonder stand = geen restschuld', () => {
  const won = { sleutel: 'w', naam: 'Woning', indicatie: { waarde: 500000 }, leningdelen: [{ naam: 'Hypo1 Huis', restschuld: 1000, rentevast_tot: '1-5-2031' }, { naam: 'Hypo2 Huis', restschuld: null, rentevast_tot: 'onbekend' }] };
  const k = V.geldKern(won, [won], { ok: true, stand: 10 });
  assert.strictEqual(k.hypotheek.restschuld, null); assert.strictEqual(k.restschuld, null); assert.strictEqual(k.overwaarde, null);
  assert.match(k.reden.join(' '), /stand/);
});

test('box: "Gebruik" uit de Kerngegevens wordt een feit (eigen gebruik of verhuurd)', async () => {
  const x = await proef({ gebruik: true });
  try {
    const b = x.u.objecten.find((o) => o.naam === 'Garagebox 12');
    assert.deepStrictEqual(b.feiten.filter((f) => f.veld === 'Gebruik').map((f) => f.waarde), ['verhuurd']);
    assert.strictEqual(x.u.objecten.find((o) => o.naam === 'Garagebox 7').feiten.some((f) => f.veld === 'Gebruik'), false);
  } finally { x.weg(); }
});

test('review MOET 1: een boxdeel zonder stand = onbekend subtotaal en geen totaal (nooit € 0)', () => {
  const won = { sleutel: 'w', naam: 'Woning', indicatie: { waarde: 500000 }, leningdelen: [{ naam: 'Hypo1 Huis', restschuld: 1000, rentevast_tot: '1-5-2031' }] };
  const box = { sleutel: 'b', naam: 'Garagebox 7', leningdelen: [{ naam: 'Hypo3 Garagebox', restschuld: null, rentevast_tot: '1-5-2031' }] };
  const k = V.geldKern(won, [won, box], { ok: true, stand: 10 });
  assert.deepStrictEqual(k.hypotheek.elders, [{ naam: 'Garagebox 7', restschuld: null }]);
  assert.strictEqual(k.hypotheek.totaal, null);
  assert.strictEqual(k.restschuld, 1010);
});
