'use strict';
// Proeven P1–P11 van de postketen (wv2684; ontwerp § 4). Alle toetsdata is verzonnen ("Leverancier A", NL00TEST…-achtige rekeningen, ronde bedragen).
const test = require('node:test');
const assert = require('node:assert/strict');
const KM = require('../keten-match.js');

const IBAN_A = 'NL91ABNA0417164300', IBAN_X = 'NL20INGB0001234567';
function brief(extra) {
  return Object.assign(KM.briefLees({ tekst: 'Herinnering\nFactuurnummer: LA-2026-0042\nOpenstaand bedrag: € 100,00\nIBAN NL91 ABNA 0417 1643 00', kop: 'Herinnering factuur LA-2026-0042',
    velden: [{ veld: 'factuurnummer', waarde: 'LA-2026-0042', letterlijk: true }, { veld: 'bedrag', waarde: '100,00', letterlijk: true }, { veld: 'factuurdatum', waarde: '01-09-2026', letterlijk: true }],
    ibans: [IBAN_A], van: 'debiteuren@leverancier-a.example', van_naam: 'Leverancier A', datum: '2026-10-01' }), extra || {});
}
function af(d, c, ex) { return Object.assign({ id: 't' + d + c, rekening: 'r1', boekdatum: d, bedrag_centen: -c, tegenpartij_naam: 'Leverancier A BV', tegenpartij_iban: IBAN_A, omschrijving: 'Factuur LA-2026-0042', kenmerk: null }, ex || {}); }
const OPT = { peil: '2026-10-02', bank_tot: '2026-10-01', leverancier_ibans: [IBAN_A], namen: ['Leverancier A'] };

test('briefLees: nummer, bedrag, datum, niveau, domein', () => {
  const b = brief();
  assert.equal(b.nummer_norm, 'LA20260042'); assert.equal(b.bedrag_centen, 10000); assert.equal(b.factuurdatum, '2026-09-01'); assert.equal(b.niveau, 1); assert.equal(b.domein, 'leverancier-a.example');
  assert.equal(KM.niveau('Tweede herinnering'), 2); assert.equal(KM.niveau('Aanmaning'), 3); assert.equal(KM.niveau('Overdracht aan incassobureau'), 4);
  assert.equal(KM.centen('1.234,56'), 123456); assert.equal(KM.centen('131.24'), 13124); assert.equal(KM.centen('€ 131'), 13100);
});

test('P1 nummer betaald vóór de brief → al betaald (hoog), kaart "Niet opnieuw betalen"', () => {
  const m = KM.match(brief(), [af('2026-09-12', 10000)], OPT);
  assert.equal(m.uitkomst, 'al_betaald'); assert.equal(m.betalingen[0].sterkte, 'hoog');
  const k = KM.kaart({ sleutel: 'intake-keten-x', schuldeiser: 'Leverancier A', nummer: 'LA-2026-0042', niveau: 1, m, afzender_herkend: true, factuur_bekend: true, stuk_id: 'stk_1' });
  assert.match(k.waarom, /al betaald op 12-9-2026 \(op factuurnummer\)\. Niet opnieuw betalen\./);
  assert.ok(k.titel.length <= 90 && k.waarom.length <= 400);
});

test('P2 betaald na de brief → eerst open (kaart), bij de hercontrole betaald en dicht met bewijs', () => {
  const m1 = KM.match(brief(), [], OPT);
  assert.equal(m1.uitkomst, 'open');
  const k = KM.kaart({ sleutel: 'k', schuldeiser: 'Leverancier A', nummer: 'LA-2026-0042', niveau: 1, m: m1, afzender_herkend: true, stuk_id: 's', vervaldatum: '2026-10-15' });
  assert.match(k.waarom, /nog niet betaald \(bank bijgewerkt t\/m 1-10-2026\)\. Bedrag € 100,00, de brief vraagt betaling vóór 15-10-2026\./);
  const m2 = KM.match(brief(), [af('2026-10-05', 10000)], Object.assign({}, OPT, { peil: '2026-10-06', bank_tot: '2026-10-05' }));
  assert.equal(m2.uitkomst, 'betaald'); assert.equal(KM.kaart({ sleutel: 'k', m: m2, niveau: 1, afzender_herkend: true }), null);
  assert.match(KM.sluitBewijs(m2), /^Betaald op 5-10-2026 \(op factuurnummer, € 100,00\)\.$/);
});

test('P3 twee afschrijvingen met hetzelfde nummer en bedrag → twee keer betaald (ook via een betaaldienst)', () => {
  const m = KM.match(brief(), [af('2026-10-01', 10000, { tegenpartij_naam: 'Stichting Mollie Payments', tegenpartij_iban: IBAN_X, omschrijving: 'LA-2026-0042 Leverancier A' }), af('2026-10-20', 10000)], Object.assign({}, OPT, { peil: '2026-11-01', bank_tot: '2026-10-31' }));
  assert.equal(m.uitkomst, 'twee_keer');
  const k = KM.kaart({ sleutel: 'k', schuldeiser: 'Leverancier A', nummer: 'LA-2026-0042', niveau: 1, m, afzender_herkend: true, stuk_id: 's' });
  assert.match(k.waarom, /lijkt twee keer betaald \(1-10-2026 en 20-10-2026, elk € 100,00\)\. Terugvragen of verrekenen\?/); assert.equal(k.soort, 'besluit');
});

test('P4 bank_tot vóór de briefdatum → niet vast te stellen, nooit open', () => {
  const m = KM.match(brief(), [], Object.assign({}, OPT, { bank_tot: '2026-09-20' }));
  assert.equal(m.uitkomst, 'niet_vast'); assert.equal(m.reden, 'bank_achter');
  assert.equal(KM.match(brief(), [], Object.assign({}, OPT, { bank_tot: null })).uitkomst, 'niet_vast');
  const k = KM.kaart({ sleutel: 'k', schuldeiser: 'Leverancier A', nummer: 'X1234', niveau: 1, m, afzender_herkend: true, stuk_id: 's' });
  assert.match(k.waarom, /niet na te gaan: bank pas bij tot 20-9-2026/); assert.ok(!/nog niet betaald/.test(k.waarom));
});

test('P5 origineel + doorgestuurd + antwoord + tweede herinnering → één dossier, niveau 2', () => {
  const eigen = ['praktijk.example'];
  const orig = KM.briefLees({ tekst: 'Factuurnummer: LA-2026-0042', kop: 'Herinnering', velden: [{ veld: 'factuurnummer', waarde: 'LA-2026-0042', letterlijk: true }], van: 'debiteuren@mail.leverancier-a.example', eigen_domeinen: eigen });
  const door = KM.briefLees({ tekst: 'Zie hieronder\n---------- Forwarded message ---------\nVan: Leverancier A <debiteuren@leverancier-a.example>\nDatum: 1 okt 2026\nFactuurnummer: LA 2026 0042', kop: 'Fwd: Herinnering',
    velden: [{ veld: 'factuurnummer', waarde: 'LA-2026-0042', letterlijk: true }], van: 'poh@praktijk.example', doorgestuurd: true, eigen_domeinen: eigen });
  const antw = KM.briefLees({ tekst: 'Dank, wij kijken het na.\nOp 1 okt 2026 schreef Leverancier A <debiteuren@leverancier-a.example>:\n> Factuurnummer: LA-2026-0042', kop: 'Re: Herinnering',
    velden: [{ veld: 'factuurnummer', waarde: 'LA-2026-0042', letterlijk: true }], van: 'poh@praktijk.example', doorgestuurd: true, eigen_domeinen: eigen });
  const twee = KM.briefLees({ tekst: 'Factuurnummer: LA-2026-0042', kop: 'Tweede herinnering', velden: [{ veld: 'factuurnummer', waarde: 'LA-2026-0042', letterlijk: true }], van: 'debiteuren@leverancier-a.example', eigen_domeinen: eigen });
  const sl = [orig, door, antw, twee].map(function (b) { return KM.dossierSleutel(KM.schuldeiser(b, null), b.nummer_norm); });
  assert.equal(new Set(sl).size, 1, JSON.stringify([orig.domein, door.domein, antw.domein, twee.domein]));
  assert.equal(Math.max(orig.niveau, door.niveau, antw.niveau, twee.niveau), 2);
  // een stuk zonder herkende afzender met hetzelfde nummer valt ook in het dossier; twee verschillende leveranciers niet
  const d = { schuldeiser_soort: 'domein', schuldeiser: KM.schuldeiserHash(KM.schuldeiser(orig, null)) };
  assert.ok(KM.zelfdeDossier(d, { soort: 'naam', waarde: 'x' }));
  assert.ok(!KM.zelfdeDossier({ schuldeiser_soort: 'leverancier', schuldeiser: KM.schuldeiserHash({ soort: 'leverancier', waarde: 'L1' }) }, { soort: 'leverancier', waarde: 'L2' }));
});

test('P6 afschrijving + terugboeking binnen 10 dagen telt niet', () => {
  const rijen = [af('2026-09-20', 10000), Object.assign(af('2026-09-25', 10000), { bedrag_centen: 10000, omschrijving: 'Storno LA-2026-0042' })];
  assert.equal(KM.match(brief(), rijen, OPT).uitkomst, 'open');
  // na 12 dagen terug: de afschrijving telt wel
  const r2 = [af('2026-09-10', 10000), Object.assign(af('2026-09-22', 10000), { bedrag_centen: 10000 })];
  assert.equal(KM.match(brief(), r2, OPT).uitkomst, 'al_betaald');
});

test('P7 IBAN in de brief anders dan bekend → waarschuwing op de kaart', () => {
  const m = KM.match(brief({ ibans: [IBAN_X] }), [], OPT);
  assert.equal(m.iban_onbekend, true);
  const k = KM.kaart({ sleutel: 'k', schuldeiser: 'Leverancier A', nummer: 'LA-2026-0042', niveau: 1, m, afzender_herkend: false, factuur_bekend: false, stuk_id: 's' });
  assert.match(k.waarom, /ander rekeningnummer dan we van deze leverancier kennen/); assert.match(k.waarom, /Afzender niet herkend/); assert.match(k.waarom, /factuur staat niet in Facturen/);
});

test('P8 alleen naam + bedrag ± 1 % → kandidaat, nooit betaald', () => {
  const m = KM.match(brief(), [af('2026-09-15', 10090, { tegenpartij_iban: 'NL02RABO0123456789', omschrijving: 'Abonnement september' })], OPT);
  assert.equal(m.uitkomst, 'kandidaat'); assert.equal(m.betalingen.length, 0);
  const k = KM.kaart({ sleutel: 'k', schuldeiser: 'Leverancier A', nummer: 'LA-2026-0042', niveau: 1, m, afzender_herkend: true, stuk_id: 's' });
  assert.match(k.waarom, /mogelijk al betaald op 15-9-2026 \(€ 100,90; alleen naam en bedrag kloppen\)\. Klopt dat\?/); assert.match(k.titel, /\?$/);
});

test('P9 som kleiner dan het bedrag → deels met rest; redelijk = rekening + bedrag', () => {
  const m = KM.match(brief(), [af('2026-09-10', 4000)], OPT);
  assert.equal(m.uitkomst, 'deels'); assert.equal(m.rest_centen, 6000);
  const k = KM.kaart({ sleutel: 'k', schuldeiser: 'Leverancier A', nummer: 'LA-2026-0042', niveau: 1, m, afzender_herkend: true, stuk_id: 's' });
  assert.match(k.waarom, /deels betaald: € 40,00 op 10-9-2026, rest € 60,00/);
  const r = KM.match(brief(), [af('2026-09-10', 10000, { omschrijving: 'Betaling' })], OPT);
  assert.equal(r.uitkomst, 'al_betaald'); assert.equal(r.betalingen[0].sterkte, 'redelijk');
});

test('P10 entiteit privé → niet vast te stellen', () => {
  const m = KM.match(brief(), [af('2026-09-10', 10000)], Object.assign({}, OPT, { prive: true }));
  assert.equal(m.uitkomst, 'niet_vast'); assert.equal(m.reden, 'prive');
  assert.match(KM.kaart({ sleutel: 'k', schuldeiser: 'A', nummer: 'N1234', niveau: 1, m, afzender_herkend: true, stuk_id: 's' }).waarom, /privérekening niet gekoppeld/);
});

test('P11 kort nummer (3 tekens) of nummer ook bij een andere tegenpartij → niet hoog', () => {
  const kort = KM.briefLees({ tekst: 'x', kop: 'Herinnering', velden: [{ veld: 'factuurnummer', waarde: 'A12', letterlijk: true }], datum: '2026-10-01' });
  assert.equal(kort.nummer, null);
  const rijen = [af('2026-09-10', 5000, { omschrijving: 'Factuur LA-2026-0042', tegenpartij_iban: 'NL02RABO0123456789', tegenpartij_naam: 'Andere Partij' }), af('2026-09-11', 10000, { omschrijving: 'ref LA20260042', tegenpartij_iban: IBAN_X, tegenpartij_naam: 'Weer Een Ander' })];
  const m = KM.match(brief({ ibans: [] }), rijen, Object.assign({}, OPT, { leverancier_ibans: [] }));
  assert.ok(!m.betalingen.some((t) => t.sterkte === 'hoog'), JSON.stringify(m.betalingen));
  // nummer als deel van een langer getal telt niet
  assert.equal(KM.nummerIn('1130', { omschrijving: 'Ref 211305' }), false);
  assert.equal(KM.nummerIn('1130', { omschrijving: 'Factuur 1130 sept' }), true);
  assert.equal(KM.nummerIn('F2974554', { omschrijving: 'Betaling F 2974554' }), true);
});

test('wv2684 terugtoets-lessen: nummer uit het onderwerp, schone afzendernaam, openstaand bedrag na een ontvangen deel', () => {
  assert.equal(KM.kopNummer('Herinnering factuur 2026294, klantnummer 13296'), '2026294');
  assert.equal(KM.kopNummer('Betalingsherinnering voor F2974554 (ORD2912079)'), 'F2974554');
  assert.equal(KM.kopNummer('Eerste herinnering voor Praktijk Voorbeeldweg (factuurnr: 2026-4329)'), '2026-4329');
  assert.equal(KM.kopNummer('Herinnering afspraak 29-08-2026'), null); assert.equal(KM.kopNummer('Herinnering 2026'), null);
  const b = KM.briefLees({ tekst: 'Beste,\nBijgaand de factuur.', onderwerp: 'Tweede herinnering factuur LA26S0042', van: 'x@leverancier-a.example', van_naam: "'Leverancier A' via Administratie", datum: '2026-05-18' });
  assert.equal(b.nummer, 'LA26S0042'); assert.equal(b.nummer_soort, 'onderwerp'); assert.equal(b.niveau, 2); assert.equal(b.naam, 'Leverancier A');
  // openstaand 600 van 1000: de rest (600) op de dag van de brief → betaald; eerder ontvangen deel (400) alleen → open met die opmerking
  const br = Object.assign(brief(), { bedrag_centen: 100000, openstaand_centen: 60000, datum: '2026-10-01' });
  const deel = af('2026-09-01', 40000);
  assert.equal(KM.match(br, [deel], OPT).uitkomst, 'open'); assert.equal(KM.match(br, [deel], OPT).reden, 'deel_ontvangen');
  const m = KM.match(br, [deel, af('2026-10-01', 60000)], OPT);
  assert.equal(m.uitkomst, 'betaald'); assert.match(KM.sluitBewijs(m), /€ 600,00/);
  assert.equal(KM.match(br, [deel, af('2026-10-01', 20000)], OPT).rest_centen, 40000);
});
