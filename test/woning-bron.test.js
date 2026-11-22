'use strict';
// wv3923 (besluitenpagina nr 59 = C49, David 22-11-2026; Fable-review financien § M2): Financiën en Vastgoed lezen de woningwaarde en de
// restschuld met één lezer (woning-bron.js). Op een verzonnen dossier (test/vastgoed-maak.js, laatste taxatie mét "na verbouwing", plus een
// nieuwere bank-json dan de tabel Bankstand op de pagina): beide apps dezelfde woningwaarde (de gewone marktwaarde) en dezelfde restschuld (de
// bank-json); zonder json blijft Vastgoed op de tabel van de pagina. WB_SRC=<map> voor de kruisproef (main: beide toetsen rood).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const SRC = process.env.WB_SRC || path.join(__dirname, '..');
const M = require('./vastgoed-maak.js');
const FO = require(path.join(SRC, 'financien-overzicht.js')), FV = require(path.join(SRC, 'financien-vault.js')), VG = require(path.join(SRC, 'vastgoed.js'));

function vault(metJson) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'woning-bron-'));
  const v = M.maakVault(path.join(t, 'vault'));
  // de laatste taxatie van het verzonnen dossier (1-6-2023) noemt marktwaarde 400.000 en na verbouwing 450.000
  fs.mkdirSync(path.join(v, '20_Prive', 'Bronnen', 'Financien'), { recursive: true });
  if (metJson) {
    const delen = [['Hypo1', 11, 119000], ['Hypo2', 12, 29800], ['Hypo3', 13, 17900], ['Hypo4', 14, 27900]].map((x) => ({ bank_leningdeel: x[1], excel_deel: x[0], bank_restschuld: x[2], bank_rente_pct: 1.5 }));
    fs.writeFileSync(path.join(v, '20_Prive', 'Bronnen', 'Financien', 'Prive - 2026-11-20 - Hypotheek bank vs Excel data.json'),
      JSON.stringify({ bron_bank: 'bankapp, schermafdruk 20-11-2026', bank_totaal_restschuld: 194600, leningdelen: delen }));
  }
  return { t, v, weg: () => fs.rmSync(t, { recursive: true, force: true }) };
}
function vastgoedRestschuld(v) {
  const h = VG.leesDossierMap(v).hypotheek;
  return Math.round(h.delen.reduce((s, d) => { const r = VG.laatsteStand(d, h.delen); return s + (r ? r.waarde : 0); }, 0) * 100) / 100;
}

test('C49: beide apps dezelfde woningwaarde = de gewone marktwaarde van de laatste taxatie ("na verbouwing" telt niet)', () => {
  const o = vault(false);
  try {
    const fin = FO.leesWoning(o.v, FV);
    const tax = VG.leesDossierMap(o.v).objecten.find((x) => x.soort === 'woning').reeks.filter((r) => r.reeks === 'taxatie').sort((a, b) => (a.peildatum < b.peildatum ? -1 : 1));
    assert.strictEqual(fin.waarde, 400000);
    assert.strictEqual(fin.peildatum, '2023-06-01');
    assert.strictEqual(tax[tax.length - 1].waarde, fin.waarde);
    assert.deepStrictEqual(fin.taxaties.map((x) => x.waarde), [310000, 350000, 400000]);   // de trap van het vermogensverloop: ook marktwaarde
  } finally { o.weg(); }
});

test('C49: beide apps dezelfde restschuld = de bankstand uit de bank-json (de tabel Bankstand op de pagina telt dan niet)', () => {
  const o = vault(true);
  try {
    const h = FV.lees(o.v).hypotheek;
    assert.ok(h, 'hypotheekblok van Financiën');
    assert.strictEqual(h.bank.restschuld, 194600);
    assert.strictEqual(h.bron.bank_op, '2026-11-20');
    assert.strictEqual(vastgoedRestschuld(o.v), h.bank.restschuld);
    const d = VG.leesDossierMap(o.v).hypotheek.delen.find((x) => x.naam.startsWith('Hypo2'));
    assert.deepStrictEqual(VG.laatsteStand(d, VG.leesDossierMap(o.v).hypotheek.delen), { peildatum: '2026-11-20', waarde: 29800, bron: 'bank' });
  } finally { o.weg(); }
});

test('zonder bank-json: Vastgoed houdt de tabel Bankstand van de pagina (terugval)', () => {
  const o = vault(false);
  try { assert.strictEqual(vastgoedRestschuld(o.v), 195300.5); } finally { o.weg(); }
});

test('woning-bron: taxaties op kolomnaam, ook in een andere kolomvolgorde; geen sectie = eerste tabel met Peildatum en Marktwaarde', () => {
  const WB = require(path.join(SRC, 'woning-bron.js'));
  const md = '# W\n\n| Marktwaarde | Peildatum | Na verbouwing |\n|---|---|---|\n| € 300.000 | 1-1-2020 | |\n| — | 2-2-2021 | € 380.000 |\n| € 320.000 | 3 maart 2022 | € 360.000 |\n';
  const t = WB.taxaties(md);
  assert.deepStrictEqual(t.map((x) => [x.datum, x.marktwaarde, x.na_verbouwing]), [['2020-01-01', 300000, null], ['2021-02-02', null, 380000], ['2022-03-03', 320000, 360000]]);
  assert.deepStrictEqual(WB.woningWaarde(t), { waarde: 320000, peildatum: '2022-03-03', na_verbouwing: 360000 });
  assert.strictEqual(WB.woningWaarde([]), null);
  // review MOET 2: het hele bedrag of niets
  assert.deepStrictEqual(['€ 450k', '€ 1,5 mln', '€ 450.000', '**€ 450.000** (zolder)', '€ 45.678,90', 'n.v.t.'].map(WB.euroUit), [null, null, 450000, 450000, 45678.9, null]);
  assert.deepStrictEqual(['€ 450000.00', '€ 450000', '€ 45.67.8', '€ 1.234.567'].map(WB.euroUit), [null, 450000, null, 1234567]);   // ronde 2 MOET 2
});

test('review MOET 1: een bank-json die niet heel op de leningdelen past, telt niet half: Vastgoed houdt dan de tabel van de pagina, met reden', () => {
  const o = vault(true);
  try {
    const p = path.join(o.v, '20_Prive', 'Bronnen', 'Financien', 'Prive - 2026-11-20 - Hypotheek bank vs Excel data.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    j.leningdelen[3].excel_deel = 'Hypo9';   // één deel past niet
    fs.writeFileSync(p, JSON.stringify(j));
    assert.strictEqual(vastgoedRestschuld(o.v), 195300.5);
    assert.match(VG.leesDossierMap(o.v).hypotheek.bank_afwijking, /past niet/);
    j.leningdelen[3].excel_deel = 'Hypo4'; j.bank_totaal_restschuld = 1;   // som sluit niet aan op het banktotaal
    fs.writeFileSync(p, JSON.stringify(j));
    assert.strictEqual(vastgoedRestschuld(o.v), 195300.5);
    j.leningdelen.forEach((d) => { d.bank_restschuld = ' '; }); j.bank_totaal_restschuld = '';   // ronde 2 MOET 1: lege bedragen zijn geen € 0
    fs.writeFileSync(p, JSON.stringify(j));
    assert.strictEqual(vastgoedRestschuld(o.v), 195300.5);
    assert.strictEqual(FV.lees(o.v).hypotheek.bank.restschuld, null);
  } finally { o.weg(); }
});
