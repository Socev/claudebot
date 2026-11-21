'use strict';
// wv3757 (besluit nr 910 / L10): Beleggen → Financiën › Vermogen en de peilwaarde op 1 januari. beleggen.js (waardeOp, jaarGeld, waardeOpDatum,
// peilVastleggen, peilTik, voorFinancien) en financien-overzicht.js (beleggenDeel, vermogenPunt) op VERZONNEN gegevens: bedrijven "Voorbeeld …",
// ISIN's, aantallen, koersen en wisselkoersen zijn verzonnen. Geen netwerk.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require(process.env.BL_JS || '../beleggen.js');
const O = require('../financien-overzicht.js');

const US = 'US0000000017', NL = 'NL0000000013';
function wereld(vandaag) {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-peil-'));
  const w = { vandaag: vandaag || '2026-12-31', pad: path.join(map, 'beleggen.sqlite') };
  w.m = B.maak({ dbPad: w.pad, vaultSchrijf: () => {}, vandaag: () => w.vandaag });
  w.sql = (f) => w.m.metDb(f, true);
  w.tx = (sl, datum, isin, naam, aantal, koers, valuta, totaal, kosten, fx) => w.sql((db) => db.prepare('INSERT INTO transactie (sleutel, datum, tijd, naam, isin, aantal, koers, valuta, waarde_eur_cent, wisselkoers, kosten_eur_cent, totaal_eur_cent, bron, op) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sl, datum, '10:00', naam, isin, String(aantal), String(koers), valuta, totaal, fx == null ? null : String(fx), kosten, totaal, 'hand', '2026-01-01T00:00:00Z'));
  w.koers = (isin, datum, slot, valuta) => w.sql((db) => db.prepare('INSERT INTO koers (isin, datum, slot, valuta, bron, op) VALUES (?, ?, ?, ?, ?, ?)').run(isin, datum, String(slot), valuta || 'USD', 'nasdaq', 'x'));
  w.wissel = (datum, per) => w.sql((db) => db.prepare('INSERT INTO wissel (valuta, datum, per_eur, op) VALUES (?, ?, ?, ?)').run('USD', datum, String(per), 'x'));
  w.rek = (sl, datum, oms, cent, val) => w.sql((db) => db.prepare('INSERT INTO rekening (sleutel, datum, omschrijving, mutatie_cent, mutatie_valuta, op) VALUES (?, ?, ?, ?, ?, ?)').run(sl, datum, oms, cent, val, 'x'));
  return w;
}
// koop 10 Voorbeeld Chips (USD) op 1-12 en 4 Voorbeeld Bank (EUR) op 5-12; dagkoersen en ECB-koersen tot en met 31-12
function gevuld(vandaag) {
  const w = wereld(vandaag);
  w.tx('t1', '2026-12-01', US, 'Voorbeeld Chips', 10, 100, 'USD', -95000, -200, 1.05);
  w.tx('t2', '2026-12-05', NL, 'Voorbeeld Bank', 4, 25, 'EUR', -10100, -100, null);
  w.koers(US, '2026-12-30', 110); w.koers(US, '2026-12-31', 120);
  w.wissel('2026-12-30', 1.25); w.wissel('2026-12-31', 1.2);
  return w;
}

test('waarde op datum: aantal uit transacties × dagkoers ÷ ECB; zonder dagkoers de transactiekoers met markering', () => {
  const w = gevuld();
  const x = w.m.waardeOpDatum('2027-01-01');
  const chips = x.posities.find((p) => p.isin === US), bank = x.posities.find((p) => p.isin === NL);
  assert.strictEqual(chips.koers_bron, 'dagkoers'); assert.strictEqual(chips.koers_datum, '2026-12-31');
  assert.strictEqual(chips.waarde_cent, 100000);   // 10 × 120 ÷ 1,2
  assert.deepStrictEqual(chips.markering, []);
  assert.strictEqual(bank.koers_bron, 'transactie'); assert.strictEqual(bank.waarde_cent, 10000);   // 4 × 25 EUR
  assert.match(bank.markering[0], /geen dagkoers.*5-12-2026/);
  assert.strictEqual(x.effecten_cent, 110000);
  assert.strictEqual(x.cash_cent, null);
  assert.strictEqual(x.volledig, false, 'contant bij DEGIRO onbekend zonder portefeuille');
  assert.ok(x.markering.some((m) => /contant bij DEGIRO niet bekend/.test(m)));
  // vóór de tweede aankoop: alleen Chips; vóór de eerste: niets
  assert.strictEqual(w.m.waardeOpDatum('2026-12-02').posities.length, 1);
  assert.strictEqual(w.m.waardeOpDatum('2026-11-30').posities.length, 0);
});

test('koersbron valt uit: laatst bekende koers met datum en markering', () => {
  const w = gevuld();
  const x = w.m.waardeOpDatum('2027-01-08');   // geen koers na 31-12
  const chips = x.posities.find((p) => p.isin === US);
  assert.strictEqual(chips.koers_datum, '2026-12-31');
  assert.match(chips.markering[0], /laatst bekende koers is van 31-12-2026/);
});

test('koers in een andere valuta dan de positie: niet raden', () => {
  const w = gevuld();
  w.koers(NL, '2026-12-31', 30, 'USD');   // verkeerde valuta voor een EUR-positie
  const x = w.m.waardeOpDatum('2027-01-01');
  assert.strictEqual(x.posities.find((p) => p.isin === NL).koers_bron, 'transactie');
});

test('portefeuille als basis: aantal teruggerekend met de transacties ertussen, contant uit de portefeuille', () => {
  const w = gevuld();
  w.sql((db) => {
    db.prepare("INSERT INTO positie (sleutel, regelsoort, naam, isin, aantal, koers, valuta, lokaal_cent, waarde_eur_cent, bron, op) VALUES ('isin:" + US + "', 'effect', 'Voorbeeld Chips', ?, '15', '118', 'USD', 177000, 147500, 'bestand', 'x')").run(US);
    db.prepare("INSERT INTO positie (sleutel, regelsoort, naam, isin, aantal, koers, valuta, lokaal_cent, waarde_eur_cent, bron, op) VALUES ('cash:EUR', 'cash', 'EUR', NULL, NULL, NULL, 'EUR', 5000, 5000, 'bestand', 'x')").run();
    db.prepare("INSERT INTO meta (sleutel, waarde) VALUES ('stand_datum', '2026-12-31'), ('stand_bron', 'bestand')").run();
  });
  w.tx('t3', '2026-12-20', US, 'Voorbeeld Chips', 5, 105, 'USD', -42000, -100, 1.25);
  const x = w.m.waardeOpDatum('2026-12-15');   // 15 − 5 (gekocht op 20-12) = 10
  const chips = x.posities.find((p) => p.isin === US);
  assert.strictEqual(chips.aantal, '10');
  assert.strictEqual(x.cash_cent, null, 'portefeuille is van later: contant op die datum onbekend');
  const y = w.m.waardeOpDatum('2027-01-01');
  assert.strictEqual(y.posities.find((p) => p.isin === US).aantal, '15');
  assert.strictEqual(y.cash_cent, 5000);
  assert.ok(!y.markering.some((m) => /kan veranderd zijn/.test(m)));
  // review MOET 1: een aankoop na de portefeuille-datum → contant onzeker, niet volledig, gemeld
  w.tx('t4', '2027-01-02', US, 'Voorbeeld Chips', 1, 121, 'USD', -10000, -100, 1.2);
  const z = w.m.waardeOpDatum('2027-01-03');
  assert.strictEqual(z.posities.find((p) => p.isin === US).aantal, '16');
  assert.strictEqual(z.volledig, false);
  assert.ok(z.markering.some((m) => /contant bij DEGIRO kan veranderd zijn: je portefeuille is van 31-12-2026/.test(m)), z.markering.join('|'));
  w.rek('r9', '2026-12-31', 'iDEAL storting', 5000, 'EUR');   // storting op de portefeuille-datum zelf telt niet als later
  assert.ok(!w.m.waardeOpDatum('2027-01-01').markering.some((m) => /kan veranderd zijn/.test(m)));
  assert.strictEqual(y.aantal_bron, 'portefeuille van 31-12-2026');
});

test('jaarGeld: dividend in USD omgerekend, dividendbelasting apart, transactiekosten niet dubbel', () => {
  const w = gevuld();
  w.rek('r1', '2026-12-30', 'Dividend', 1250, 'USD');
  w.rek('r2', '2026-12-30', 'Dividendbelasting', -188, 'USD');
  w.rek('r3', '2026-12-02', 'DEGIRO Transactiekosten en/of kosten van derden', -200, 'EUR');
  w.rek('r4', '2026-12-03', 'DEGIRO Aansluitingskosten 2026 (Nasdaq - NASDAQ)', -250, 'EUR');
  w.rek('r5', '2025-12-30', 'Dividend', 999, 'EUR');   // ander jaar
  w.rek('r6', '2026-12-01', 'DEGIRO AutoFX-kosten', -50, 'EUR');   // zit al in de transactiekosten
  const p = w.m.peilVastleggen('2027-01-01', 'proef');
  assert.strictEqual(p.nieuw, true);
  const g = w.m.peilInhoud('2027-01-01').jaar;
  assert.strictEqual(g.jaar, 2026);
  assert.strictEqual(g.dividend_cent, 1000);   // 12,50 USD ÷ 1,25 (ECB 30-12)
  assert.strictEqual(g.dividendbelasting_cent, -150);
  assert.strictEqual(g.kosten_overig_cent, -250);
  assert.strictEqual(g.kosten_transacties_cent, -300);
  assert.strictEqual(g.per_valuta.USD.dividend_cent, 1250);
});

test('peilwaarde: één keer vastgelegd, nooit overschreven (proef met peildatum = vandaag)', () => {
  const w = gevuld('2026-12-31');
  const a = w.m.peilVastleggen('2026-12-31', 'proef');
  assert.strictEqual(a.nieuw, true);
  assert.strictEqual(a.peil.waarde_cent, 110000);
  w.koers(US, '2026-12-29', 50);   // later binnengekomen gegevens veranderen de vastgelegde waarde niet
  w.sql((db) => db.prepare("UPDATE koers SET slot = '240' WHERE isin = ? AND datum = '2026-12-31'").run(US));
  const b = w.m.peilVastleggen('2026-12-31', 'proef');
  assert.strictEqual(b.nieuw, false);
  assert.strictEqual(b.peil.waarde_cent, 110000);
  assert.strictEqual(b.peil.bron, 'proef');
  const n = w.m.metDb((db) => db.prepare('SELECT COUNT(*) AS n FROM peil').get().n, false);
  assert.strictEqual(n, 1);
});

test('peilTik: 1 t/m 15 januari zolang hij er niet is; daarbuiten niets; zonder databank niets en geen databank maken', () => {
  const w = gevuld();
  assert.deepStrictEqual(w.m.peilTik('2026-12-31'), { niets: true });
  const a = w.m.peilTik('2027-01-01');
  assert.strictEqual(a.nieuw, true); assert.strictEqual(a.peil.peildatum, '2027-01-01'); assert.strictEqual(a.peil.bron, 'januari');
  assert.deepStrictEqual(w.m.peilTik('2027-01-02'), { al: true });
  assert.deepStrictEqual(w.m.peilTik('2027-01-20'), { niets: true });
  // pod stond op 1 januari uit: op 3 januari ingehaald, koers van vóór of op 1 januari
  const v = gevuld();
  v.koers(US, '2027-01-02', 130);
  const b = v.m.peilTik('2027-01-03');
  assert.strictEqual(b.peil.peildatum, '2027-01-01');
  assert.strictEqual(v.m.peilInhoud('2027-01-01').waarde.posities.find((p) => p.isin === US).koers_datum, '2026-12-31');
  const leeg = wereld();
  assert.deepStrictEqual(leeg.m.peilTik('2027-01-01'), { niets: true });
  assert.strictEqual(fs.existsSync(leeg.pad), false);
  assert.strictEqual(leeg.m.voorFinancien({ vandaag: '2027-01-01' }), null);
});

test('voorFinancien: punt, maandeinden vanaf de eerste transactie, peilwaarden en de volgende peildatum (euro)', () => {
  const w = gevuld('2027-01-05');
  w.m.peilTik('2027-01-05');
  const f = w.m.voorFinancien({});
  assert.strictEqual(f.punt.bedrag, 1100); assert.strictEqual(f.punt.posities, 2); assert.strictEqual(f.punt.volledig, false);
  assert.deepStrictEqual(Object.keys(f.maanden), ['2026-12']);
  assert.strictEqual(f.maanden['2026-12'].bedrag, 1100);
  assert.strictEqual(f.eerste, '2026-12-01');
  assert.strictEqual(f.peilen.length, 1); assert.strictEqual(f.peilen[0].peildatum, '2027-01-01'); assert.strictEqual(f.peilen[0].bedrag, 1100);
  assert.strictEqual(f.volgende_peil, '2028-01-01');
  assert.deepStrictEqual(f.peilen[0].jaar, { jaar: 2026, dividend: 0, dividendbelasting: 0, kosten: -3, zonder_wissel: 0, rekening_tot: null });   // review ZOU 1
  w.rek('r7', '2026-12-30', 'Dividend', 500, 'EUR');   // later ingelezen rekeningoverzicht telt mee; de bevroren waarde niet
  const f2 = w.m.voorFinancien({});
  assert.strictEqual(f2.peilen[0].jaar.dividend, 5); assert.strictEqual(f2.peilen[0].jaar.rekening_tot, '2026-12-30'); assert.strictEqual(f2.peilen[0].bedrag, 1100);
});

test('Financiën: Beleggen als eigen regel in Vermogen privé; zonder Beleggen niets anders', () => {
  const w = gevuld('2027-01-05');
  w.m.peilTik('2027-01-05');
  const bel = w.m.voorFinancien({});
  const blok = (n, f) => { try { return f(); } catch (e) { return null; } };
  const basis = { v: {}, sal: [], liq: { vrij: 5000, kinderen: 0, geoormerkt: 0, anders: 0, stand_van: null }, vault: '/bestaat-niet', FV: { lees: () => ({}) }, nu: '2027-01-05', blok };
  const zonder = O.vermogenPunt(basis), met = O.vermogenPunt(Object.assign({}, basis, { beleggen: bel }));
  assert.strictEqual(met.prive.delen.length, zonder.prive.delen.length + 1);
  const d = met.prive.delen.find((x) => /^Beleggingen/.test(x.tekst));
  assert.strictEqual(d.bedrag, 1100); assert.strictEqual(d.op, '2026-12-05');   // de oudste koersdatum telt assert.match(d.tekst, /onvolledig/);
  assert.ok(Array.isArray(d.let_op) && d.let_op.length > 0);
  assert.strictEqual(met.prive.beleggen.peilen[0].bedrag, 1100);
  assert.strictEqual(zonder.prive.beleggen, null);
  assert.deepStrictEqual(met.prive.ontbreekt, zonder.prive.ontbreekt);
  // rommel van buiten wordt niet geloofd
  assert.strictEqual(O.beleggenDeel({ punt: { bedrag: 'veel' } }).deel, null);
  assert.strictEqual(O.beleggenDeel(null), null);
});

test('verloop (review MOET 2): onvolledige beleggingen maken ook de lopende maand onvolledig; vóór de eerste transactie geen beleggingen', () => {
  const w = gevuld('2027-01-05');
  const bel = w.m.voorFinancien({});
  const V = require('../financien-vermogen.js');
  const r = V.verloop(null, { db: null }, { nu: '2027-01-05', saldi: { rekeningen: [] }, vault: '/bestaat-niet', fv: { lees: () => ({}) }, beleggen: bel });
  const nu = r.maanden[r.maanden.length - 1], dec = r.maanden.find((x) => x.m === '2026-12'), nov = r.maanden.find((x) => x.m === '2026-11');
  assert.strictEqual(nu.lopend, true); assert.strictEqual(nu.beleggen, 1100); assert.strictEqual(nu.volledig, false);
  assert.deepStrictEqual(nu.onvolledig, ['beleggingen (niet alles bekend)']);
  assert.strictEqual(dec.beleggen, 1100); assert.ok(dec.onvolledig.includes('beleggingen (niet alles bekend)'));
  assert.strictEqual(nov.beleggen, undefined);
});
