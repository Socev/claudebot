'use strict';
// wv4230 (besluitenpagina nr 942 = L42, David Ja 25-11-2026 22:27; Fable-review "Een 9 - vastgoed" F7): wat het huis werkelijk kostte.
// Per verbouwing de offerte naast wat er betaald is (privébank, alleen lezen), koppeling alleen via de tabel "Betaald" op de verbouwpagina
// (tegenpartij gelijk na normaliseren + periode); twijfel en overlap zichtbaar "niet gekoppeld"; bouw + verbouwingen tegenover de indicatie.
// Verzonnen dossier (test/vastgoed-maak.js) en verzonnen bank. VASTGOED_JS=<pad> voor de kruisproef.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const VJS = process.env.VASTGOED_JS || path.join(__dirname, '..', 'vastgoed.js');
const V = require(VJS);
const M = require('./vastgoed-maak.js');

const BETAALD = `
## Betaald

| Aan (zoals in de bank) | Van | Tot | Toelichting |
|---|---|---|---|
| Bouwbedrijf Proef | 1-10-2018 | 30-11-2019 | slotnota |
| Keukens Voorbeeld B.V. | 1-3-2019 | 15-5-2019 | kast |
| (bouwdepot hypotheek) | 1-1-2019 | 31-5-2019 | termijnen via het depot |
| Schilder Twijfel | ? | ? | niet in de stukken |
`;
const TUIN = `# Tuin 2021

## Offerte tuin — Hovenier Proef (1-4-2021)

| Onderdeel | Bedrag |
|---|---|
| **Totaal incl. btw** | **€ 10.000,00** |

## Betaald

| Aan (zoals in de bank) | Van | Tot | Toelichting |
|---|---|---|---|
| Hovenier Proef | 1-3-2021 | 30-11-2021 | facturen |
| Bouwbedrijf Proef | 1-6-2019 | 31-8-2021 | overlapt bewust met de verbouwing (toets) |
`;
const BOUW = `
### Kosten bij de bouw

| Post | Bedrag incl. btw | Bron |
|---|---|---|
| Grond en woning | € 300.000 | proef |
| Meerwerk | € 20.000,50 | proef |
| **Totaal** | € 999.999 | telt niet |
`;
function maakBankKost(pad) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(pad), { recursive: true });
  const db = new DatabaseSync(pad);
  db.exec(`CREATE TABLE rekeningen (rek TEXT PRIMARY KEY, eigenaar TEXT, bron TEXT);
    CREATE TABLE transacties (nr INTEGER PRIMARY KEY, rek TEXT NOT NULL, status TEXT NOT NULL, datum TEXT, bedrag REAL, valuta TEXT, tegenpartij TEXT, omschrijving TEXT, vervangen_door INTEGER);`);
  db.exec(`INSERT INTO rekeningen VALUES ('r1', 'David', 'bunq'), ('r2', 'samen', 'abn'), ('pot', 'POT', 'abn'), ('ext', 'extern', 'bunq');`);
  const t = db.prepare('INSERT INTO transacties (rek, status, datum, bedrag, valuta, tegenpartij, omschrijving, vervangen_door) VALUES (?,?,?,?,?,?,?,?)');
  for (const r of [
    ['r1', 'booked', '2018-08-01', -1, 'Supermarkt', 'eerste post (dekking)', null],
    ['r1', 'booked', '2019-04-11', -1200, 'Keukens Voorbeeld B.V. by Betaaldienst', 'Referentie: 4711', null],
    ['r1', 'booked', '2019-05-03', -2000, 'Schilder Twijfel', '501', null],
    ['r1', 'booked', '2019-10-09', -23456, 'Bouwbedrijf Proef', 'PROEF-A1', null],     // valt in twee perioden → niet gekoppeld
    ['r1', 'booked', '2019-03-01', -5000, 'Bouwbedrijf Proef', 'termijn 2', null],         // alleen de verbouwing
    ['r1', 'booked', '2021-05-01', -6000, 'Hovenier Proef', '611', null],
    ['r2', 'booked', '2021-09-01', -6500.5, 'HOVENIER PROEF', 'SEPA Overboeking IBAN: NL00TEST0123456789 BIC: TESTNL2A Naam: Hovenier Proef Omschrijving: 612', null],
    ['r1', 'booked', '2021-10-01', 500, 'Hovenier Proef', 'creditnota', null],              // terugbetaling telt negatief
    ['r1', 'booked', '2021-07-01', -9999, 'J. Proef', 'privé, andere tegenpartij', null], // lijkt erop, is niet gelijk
    ['r1', 'booked', '2021-07-02', -8888, 'Hovenier Proefbedrijf', 'ander bedrijf', null],
    ['r1', 'pending', '2021-07-03', -777, 'Hovenier Proef', 'niet geboekt', null],
    ['r1', 'booked', '2021-07-04', -666, 'Hovenier Proef', 'vervangen', 1],
    ['pot', 'booked', '2021-07-05', -555, 'Hovenier Proef', 'POT telt niet', null],
    ['ext', 'booked', '2021-07-06', -444, 'Hovenier Proef', 'extern telt niet', null],
    ['r1', 'booked', '2023-01-01', -333, 'Hovenier Proef', 'na de periode', null],
  ]) t.run(...r.slice(0, 4), 'EUR', ...r.slice(4));
  db.close();
  return pad;
}
function proef(o) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-kostte-'));
  const v = M.maakVault(path.join(t, 'vault'));
  const huis = path.join(v, '20_Prive', 'Huis');
  const vb = path.join(huis, 'Verbouwing 2018-2019 (uitbouw).md');
  if (!(o && o.zonderTabellen)) {
    fs.writeFileSync(vb, fs.readFileSync(vb, 'utf8') + BETAALD);
    fs.writeFileSync(path.join(huis, 'Tuin 2021.md'), TUIN);
    const w = path.join(huis, 'Woning Hofstraat 110.md');
    fs.writeFileSync(w, fs.readFileSync(w, 'utf8') + BOUW);
  }
  const bank = o && o.zonderBank ? path.join(t, 'geen.sqlite') : maakBankKost(path.join(t, 'bank.sqlite'));
  const m = V.maak({ map: path.join(t, 'map'), vault: v, bank, bronnen: M.nepBronnen(), nu: () => new Date('2026-11-26T10:00:00Z') });
  m.leesDossier();
  const k = m.overzicht().objecten.find((x) => x.soort === 'woning').kostte;
  return { t, m, k, v, weg: () => fs.rmSync(t, { recursive: true, force: true }) };
}
const per = (k, re) => k.verbouwingen.find((x) => re.test(x.titel));

test('tegenpartij normaliseren: betaaldienst eraf, leestekens weg, gelijk = gelijk', () => {
  assert.strictEqual(V.tegenSleutel('Keukens Voorbeeld B.V. by Betaaldienst'), V.tegenSleutel('Keukens Voorbeeld B.V.'));
  assert.strictEqual(V.tegenSleutel('Schilder B.V. via Stichting Mollie Payments'), 'schilder b v');
  assert.notStrictEqual(V.tegenSleutel('Hovenier Proefbedrijf'), V.tegenSleutel('Hovenier Proef'));
});

test('tabel Betaald: periode, buiten-de-bank-vlag en twijfelrij zonder periode', () => {
  const b = V.leesBetaald('# X\n' + BETAALD);
  assert.deepStrictEqual(b.aan.map((a) => [a.naam, a.van, a.tot]), [['Bouwbedrijf Proef', '2018-10-01', '2019-11-30'], ['Keukens Voorbeeld B.V.', '2019-03-01', '2019-05-15']]);
  assert.deepStrictEqual(b.buiten.map((a) => a.naam), ['bouwdepot hypotheek']);
  assert.deepStrictEqual(b.zonder_periode.map((a) => a.naam), ['Schilder Twijfel']);
  assert.strictEqual(V.leesBetaald('# X\n\nGeen tabel.'), null);
});

test('echte koppeling: betaald per verbouwing herleidbaar, overlap en twijfel zichtbaar niet gekoppeld', () => {
  const x = proef();
  try {
    const vb = per(x.k, /^Verbouwing/), tuin = per(x.k, /^Tuin/);
    // verbouwing: termijn 2 (5000) en de kast (1200); de slotnota valt ook in de periode van de tuin → niet gekoppeld
    assert.deepStrictEqual(vb.betalingen.map((b) => [b.datum, b.bedrag]), [['2019-03-01', 5000], ['2019-04-11', 1200]]);
    assert.strictEqual(vb.betaald, 6200);
    assert.strictEqual(vb.offerte, 36300);
    assert.strictEqual(vb.telt_als, 'offerte');   // bouwdepot-vlag en offerte hoger dan betaald
    assert.strictEqual(vb.telt, 36300);
    // tuin: 6000 + 6500,50 − 500 (creditnota); niet: pending, vervangen, POT, extern, ander bedrijf, privépersoon, na de periode
    assert.deepStrictEqual(tuin.betalingen.map((b) => b.bedrag), [6000, 6500.5, -500]);
    assert.strictEqual(tuin.betaald, 12000.5);
    assert.strictEqual(tuin.offerte, 10000);
    assert.strictEqual(tuin.telt_als, 'betaald');
    assert.strictEqual(tuin.betalingen[1].kenmerk, '612');   // omschrijving zonder IBAN
    assert.ok(!JSON.stringify(x.k).includes('NL00TEST'), 'geen IBAN in de uitvoer');
    const los = x.k.niet_gekoppeld.map((b) => [b.datum, b.bedrag, /meer verbouwingen/.test(b.reden) ? 'overlap' : /^twijfel/.test(b.reden) ? 'twijfel' : 'buiten']);
    assert.deepStrictEqual(los, [['2019-05-03', 2000, 'twijfel'], ['2019-10-09', 23456, 'overlap'], ['2023-01-01', 333, 'buiten']]);
    // som handmatig: bouw 300.000 + 20.000,50 (totaalregel telt niet); verbouwingen 36.300 + 12.000,50 + terras 1.089 (alleen prijs, geen tabel)
    assert.strictEqual(per(x.k, /^Terras/).telt_als, 'offerte');
    assert.strictEqual(x.k.bouw_som, 320000.5);
    assert.strictEqual(x.k.verbouwingen_som, 49389.5);
    assert.strictEqual(x.k.samen, 369390);
    assert.ok(!x.k.verbouwingen.some((v) => /^Kelder/.test(v.titel)), 'een plan zonder offerte of tabel staat er niet in');
    assert.deepStrictEqual(x.k.bank.dekking.map((d) => [d.bron, d.vanaf]), [['bunq', '2018-08-01'], ['abn', '2021-09-01']]);
    assert.strictEqual(x.k.bank.ok, true);
  } finally { x.weg(); }
});

test('zonder tabellen: geen koppeling, verbouwing telt met de offerte, aankoop als terugval voor de bouw', () => {
  const x = proef({ zonderTabellen: true });
  try {
    const vb = per(x.k, /^Verbouwing/);
    assert.deepStrictEqual(vb.betalingen, []);
    assert.strictEqual(vb.betaald, null);
    assert.strictEqual(vb.telt_als, 'offerte');
    assert.strictEqual(x.k.niet_gekoppeld.length, 0);
    assert.ok(x.k.bouw.length <= 1);
  } finally { x.weg(); }
});

test('bank niet te lezen: dossier telt, betalingen leeg met de reden, geen gok', () => {
  const x = proef({ zonderBank: true });
  try {
    assert.strictEqual(x.k.bank.ok, false);
    assert.ok(x.k.bank.reden);
    assert.strictEqual(per(x.k, /^Tuin/).betaald, null);
    assert.strictEqual(per(x.k, /^Tuin/).telt_als, 'offerte');
  } finally { x.weg(); }
});

test('kostteUit puur: indicatie en verschil, geen indicatie = geen verschil', () => {
  const vb = [{ titel: 'A 2020', pagina: 'p', datum: '2020-01-01', kosten: [{ waarde: 100, kop: null, offerte: true }], betaald: null }];
  const k = V.kostteUit(vb, [], [{ post: 'x', waarde: 1000 }], null, 1500);
  assert.strictEqual(k.samen, 1100); assert.strictEqual(k.verschil, 400);
  assert.strictEqual(V.kostteUit(vb, [], [], 900, null).verschil, null);
  assert.strictEqual(V.kostteUit(vb, [], [], 900, null).samen, 1000);
});
