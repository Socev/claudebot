'use strict';
// wv3754 (besluiten nr 905 = L05, nr 909 = L09): daglijn, vergelijking met het wereldindexfonds en de geld-tegels, op VERZONNEN gegevens.
const test = require('node:test');
const assert = require('node:assert');
const { daglijn, geldOverzicht, aankoopStand, WERELD } = require('../beleggen.js');

const P = (sleutel, isin, aantal) => ({ sleutel, regelsoort: 'effect', naam: sleutel, isin, aantal: String(aantal), valuta: 'USD', waarde_eur_cent: 1 });
const K = (rijen) => rijen.map(([datum, slot]) => ({ datum, slot: String(slot), valuta: 'USD' }));
const W = { USD: [['2026-11-20', '1.25'], ['2026-11-19', '1.25'], ['2026-11-18', '1.2'], ['2026-11-17', '1.2'], ['2026-11-14', '1.2'], ['2026-11-13', '1.2'], ['2026-11-12', '1.2']].map(([datum, per_eur]) => ({ datum, per_eur })) };

test('daglijn: aantal per dag uit de transacties, koers ÷ ECB-koers, vandaag telt niet mee, feestdag neemt de vorige koers', () => {
  const reeks = { US0000000AA1: K([['2026-11-12', 100], ['2026-11-13', 110], ['2026-11-14', 120], ['2026-11-17', 120], ['2026-11-18', 132], ['2026-11-21', 999]]),
    US0000000BB2: K([['2026-11-13', 50], ['2026-11-14', 50], ['2026-11-18', 60]]) };
  const tx = [{ isin: 'US0000000AA1', datum: '2026-11-13', aantal: '3' }, { isin: 'US0000000BB2', datum: '2026-11-14', aantal: '10' }];
  const l = daglijn([P('a', 'US0000000AA1', 3), P('b', 'US0000000BB2', 10)], tx, reeks, W, {}, '2026-11-21');
  assert.deepStrictEqual(l.punten.map((x) => x.datum), ['2026-11-13', '2026-11-14', '2026-11-17', '2026-11-18'], 'vanaf de eerste aankoop, zonder vandaag');
  assert.strictEqual(l.punten[0].waarde_cent, Math.round(3 * 110 / 1.2 * 100));
  assert.strictEqual(l.punten[1].waarde_cent, Math.round((3 * 120 + 10 * 50) / 1.2 * 100));
  assert.strictEqual(l.punten[2].waarde_cent, Math.round((3 * 120 + 10 * 50) / 1.2 * 100), 'B op 17-11 zonder koers: die van 14-11 (≤ 4 dagen)');
  assert.strictEqual(l.posities_in, 2); assert.strictEqual(l.posities_zonder, 0); assert.strictEqual(l.onvolledig, false);
  assert.strictEqual(l.vergelijk, null, 'zonder wereldindexfonds geen vergelijking');
});

test('daglijn: positie zonder koers doet niet mee; transacties die de stand niet dekken = onvolledig; geen wisselkoers = dag weg', () => {
  const reeks = { US0000000AA1: K([['2026-11-17', 100], ['2026-11-18', 100], ['2026-11-19', 100]]) };
  const l = daglijn([P('a', 'US0000000AA1', 2), P('c', 'NL0000000CC3', 5)], [{ isin: 'US0000000AA1', datum: '2026-11-18', aantal: '5' }], reeks, { USD: [{ datum: '2026-11-18', per_eur: '1.25' }, { datum: '2026-11-19', per_eur: '1.25' }] }, {}, '2026-11-21');
  assert.strictEqual(l.posities_zonder, 1);
  assert.strictEqual(l.onvolledig, true, '2 nu, 5 gekocht op 18-11 → op 17-11 min 3');
  assert.deepStrictEqual(l.punten.map((x) => x.datum), ['2026-11-18', '2026-11-19'], '17-11: aantal 0 (onvolledig), en geen wisselkoers op of vóór 17-11');
});

test('vergelijking: rendement op de stukken van gisteren (bijkopen is geen winst), wereldindex in euro, beide 100 op de eerste dag', () => {
  const reeks = { US0000000AA1: K([['2026-11-17', 100], ['2026-11-18', 110], ['2026-11-19', 110]]),
    [WERELD.sleutel]: K([['2026-11-17', 200], ['2026-11-18', 202], ['2026-11-19', 204]]) };
  const tx = [{ isin: 'US0000000AA1', datum: '2026-11-19', aantal: '10' }];   // op 19-11 bijgekocht: waarde verdubbelt, rendement 0
  const l = daglijn([P('a', 'US0000000AA1', 20)], tx, reeks, W, { a: 'tech' }, '2026-11-21');
  assert.ok(l.vergelijk, 'vergelijking aanwezig');
  assert.strictEqual(l.vergelijk.eigen_naam, 'Je eigen keuzes');
  const [p0, p1, p2] = l.vergelijk.punten;
  assert.deepStrictEqual([p0.eigen, p0.index], [100, 100]);
  assert.strictEqual(p1.eigen, 110); assert.strictEqual(p1.index, 101);
  assert.strictEqual(p2.eigen, Math.round(110 * (110 / 1.25) / (110 / 1.2) * 100) / 100, 'koers gelijk, dollar zwakker');
  assert.strictEqual(p2.index, Math.round(101 * (204 / 1.25) / (202 / 1.2) * 100) / 100);
  assert.ok(l.punten[2].waarde_cent > 1.9 * l.punten[1].waarde_cent, 'de daglijn zelf toont het bijkopen wel');
  // zonder soort tech/health: "Je aandelen"
  assert.strictEqual(daglijn([P('a', 'US0000000AA1', 20)], tx, reeks, W, {}, '2026-11-21').vergelijk.eigen_naam, 'Je aandelen');
});

test('geld: ingelegd (reservering heft zich op), kosten gesplitst, overige kosten en dividend uit het rekeningoverzicht, resultaat na kosten', () => {
  const rekening = [
    { datum: '2026-11-10', omschrijving: 'Reservation iDEAL', mutatie_cent: 100000, mutatie_valuta: 'EUR' },
    { datum: '2026-11-11', omschrijving: 'iDEAL storting', mutatie_cent: 100000, mutatie_valuta: 'EUR' },
    { datum: '2026-11-11', omschrijving: 'Reservation iDEAL', mutatie_cent: -100000, mutatie_valuta: 'EUR' },
    { datum: '2026-11-15', omschrijving: 'Terugstorting', mutatie_cent: -20000, mutatie_valuta: 'EUR' },
    { datum: '2026-11-13', omschrijving: 'DEGIRO Transactiekosten en/of kosten van derden', mutatie_cent: -200, mutatie_valuta: 'EUR' },
    { datum: '2026-11-13', omschrijving: 'Valuta Debitering', mutatie_cent: -30000, mutatie_valuta: 'EUR' },
    { datum: '2026-11-13', omschrijving: 'Valuta Creditering', mutatie_cent: 36000, mutatie_valuta: 'USD' },
    { datum: '2026-11-14', omschrijving: 'DEGIRO Aansluitingskosten 2026 (Voorbeeldbeurs)', mutatie_cent: -250, mutatie_valuta: 'EUR' },
    { datum: '2026-11-19', omschrijving: 'Dividend', mutatie_cent: 1250, mutatie_valuta: 'USD' },
    { datum: '2026-11-19', omschrijving: 'Dividendbelasting', mutatie_cent: -125, mutatie_valuta: 'USD' },
  ];
  const transacties = [{ sleutel: 'tx:1', bron: 'bestand', kosten_eur_cent: -311 }, { sleutel: 'tx:2', bron: 'hand', kosten_eur_cent: -100 }, { sleutel: 'tx:3', bron: 'bestand', kosten_eur_cent: -50 }];
  const g = geldOverzicht({ rekening, transacties, autofx: new Map([['tx:1', -111]]), wissels: W, vandaag: { waarde_cent: 50000, verschil_aankoop_cent: 2000 }, gerealiseerd: { cent: 300, onbekend: 0 } });
  assert.strictEqual(g.ingelegd_cent, 80000);
  assert.deepStrictEqual([g.ingelegd_van, g.ingelegd_tot], ['2026-11-10', '2026-11-19']);
  assert.strictEqual(g.kosten_valuta_cent, 111);
  assert.strictEqual(g.kosten_transactie_cent, 200 + 100 + 50);
  assert.strictEqual(g.kosten_splits_onbekend, 1, 'tx:3 uit een bestand zonder AutoFX-kolom');
  assert.strictEqual(g.kosten_overig_cent, 250, 'transactiekosten in het rekeningoverzicht tellen niet nog eens');
  assert.strictEqual(g.kosten_cent, 711);
  assert.strictEqual(g.dividend_cent, Math.round(1250 / 1.25) + Math.round(-125 / 1.25));
  assert.strictEqual(g.resultaat_cent, 2000 + 300 + g.dividend_cent - 250);
});

test('geld: wat ontbreekt, zegt het (geen storting, geen rekening, geen koers, aankoop onbekend)', () => {
  const g = geldOverzicht({ rekening: [{ datum: '2026-11-13', omschrijving: 'DEGIRO Transactiekosten en/of kosten van derden', mutatie_cent: -200, mutatie_valuta: 'EUR' }], transacties: [], vandaag: null });
  assert.strictEqual(g.ingelegd_cent, null, 'geen storting in het overzicht = niet vast te stellen, niet 0');
  assert.strictEqual(g.kosten_cent, null, 'zonder Transacties geen kostentotaal (review MOET 3)');
  assert.strictEqual(g.resultaat_reden, 'koers');
  const h = geldOverzicht({ rekening: [], transacties: [{ sleutel: 't', bron: 'bestand', kosten_eur_cent: -5 }], autofx: new Map([['t', 0]]), vandaag: { waarde_cent: 1, verschil_aankoop_cent: null } });
  assert.strictEqual(h.rekening, false); assert.strictEqual(h.ingelegd_cent, null); assert.strictEqual(h.kosten_cent, 5); assert.strictEqual(h.resultaat_reden, 'aankoop');
});

test('aankoopStand: gerealiseerd bij verkoop = opbrengst na kosten min het weggaande deel van de aankoopwaarde', () => {
  const a = aankoopStand([
    { datum: '2026-11-01', tijd: '10:00', naam: 'X', isin: 'US0000000AA1', aantal: '10', totaal_eur_cent: -100000 },
    { datum: '2026-11-05', tijd: '10:00', naam: 'X', isin: 'US0000000AA1', aantal: '-4', totaal_eur_cent: 50000 },
  ]);
  assert.strictEqual(a.gerealiseerd_cent, 50000 - 40000);
  assert.strictEqual(a.posities[0].waarde_eur_cent, 60000, 'aankoopwaarde van de rest ongewijzigd');
  assert.strictEqual(a.gerealiseerd_onbekend, 0);
});

test('review MOET 1: een overgeslagen dag (koers ontbreekt > 4 dagen) laat geen eigen koersverandering verdwijnen; beide reeksen over dezelfde periode', () => {
  const reeks = { US0000000AA1: K([['2026-11-10', 100], ['2026-11-11', 120], ['2026-11-20', 150]]), US0000000BB2: K([['2026-11-10', 50], ['2026-11-11', 50], ['2026-11-12', 50], ['2026-11-19', 50], ['2026-11-20', 50]]),
    [WERELD.sleutel]: K([['2026-11-10', 200], ['2026-11-11', 200], ['2026-11-12', 200], ['2026-11-19', 210], ['2026-11-20', 220]]) };
  const w = { USD: ['2026-11-20', '2026-11-19', '2026-11-12', '2026-11-11', '2026-11-10'].map((datum) => ({ datum, per_eur: '1' })) };
  const l = daglijn([P('a', 'US0000000AA1', 1), P('b', 'US0000000BB2', 2)], [], reeks, w, {}, '2026-11-21');
  const v = l.vergelijk.punten, z = v[v.length - 1];
  assert.strictEqual(z.datum, '2026-11-20');
  assert.strictEqual(z.eigen, Math.round((150 + 100) / (100 + 100) * 10000) / 100, 'eigen: 10-11 → 20-11 over de stukken, ook over de gat-dagen');
  assert.strictEqual(z.index, 110, 'index: 200 → 220');
});

test('review MOET 2: gerealiseerd van een volledige positie blijft staan als een andere positie onvolledig is', () => {
  const a = aankoopStand([
    { datum: '2026-11-01', tijd: '10:00', naam: 'X', isin: 'US0000000AA1', aantal: '10', totaal_eur_cent: -100000 },
    { datum: '2026-11-05', tijd: '10:00', naam: 'X', isin: 'US0000000AA1', aantal: '-4', totaal_eur_cent: 50000 },
    { datum: '2026-11-06', tijd: '10:00', naam: 'Y', isin: 'US0000000BB2', aantal: '-3', totaal_eur_cent: 9000 },
  ]);
  assert.strictEqual(a.onvolledig, true);
  assert.strictEqual(a.gerealiseerd_cent, 10000);
  assert.strictEqual(a.gerealiseerd_onbekend, 1, 'Y: verkoop zonder bekende aankoop = onbekend (geteld, de tegel zegt het)');
});

test('review ronde 2: index mist een dag + tussentijds bijgekocht → eigen rendement per dag (bijkopen geen winst); eigen stukken tijdelijk weg → keten loopt door', () => {
  const reeks = { US0000000AA1: K([['2026-11-16', 100], ['2026-11-17', 110], ['2026-11-18', 110], ['2026-11-19', 121]]),
    [WERELD.sleutel]: K([['2026-11-10', 200], ['2026-11-16', 200], ['2026-11-19', 210]]) };   // index ontbreekt 17 en 18 (> 4 dagen niet, maar koersOp neemt de vorige: geef bewust een gat > 4 dagen niet nodig)
  const w = { USD: ['2026-11-19', '2026-11-18', '2026-11-17', '2026-11-16'].map((datum) => ({ datum, per_eur: '1' })) };
  // 1 stuk tot 17-11, op 18-11 bijgekocht tot 10 stuks
  const l = daglijn([P('a', 'US0000000AA1', 10)], [{ isin: 'US0000000AA1', datum: '2026-11-18', aantal: '9' }], reeks, w, {}, '2026-11-21');
  const z = l.vergelijk.punten[l.vergelijk.punten.length - 1];
  assert.strictEqual(z.eigen, 121, '100 → 110 → 110 → 121: +21 %, ongeacht het bijkopen');
  // tijdelijk niets in eigen keuzes (verkocht op 17-11, terug op 19-11): de keten loopt door en de vergelijking stopt niet
  const r2 = { US0000000AA1: K([['2026-11-16', 100], ['2026-11-17', 110], ['2026-11-18', 120], ['2026-11-19', 132]]), US0000000BB2: K([['2026-11-16', 10], ['2026-11-17', 10], ['2026-11-18', 10], ['2026-11-19', 10]]),
    [WERELD.sleutel]: K([['2026-11-16', 200], ['2026-11-17', 200], ['2026-11-18', 200], ['2026-11-19', 200]]) };
  const tx = [{ isin: 'US0000000AA1', datum: '2026-11-17', aantal: '-1' }, { isin: 'US0000000AA1', datum: '2026-11-19', aantal: '1' }];
  const l2 = daglijn([P('a', 'US0000000AA1', 1), P('b', 'US0000000BB2', 5)], tx, r2, w, { a: 'tech', b: 'kern' }, '2026-11-21');
  assert.deepStrictEqual(l2.vergelijk.punten.map((x) => x.datum), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19']);
  assert.strictEqual(l2.vergelijk.punten[3].eigen, 110, '16→17 +10 % (stuk van 16-11), 17→18 en 18→19 geen eigen stukken op de dag ervoor: blijft 110');
});
