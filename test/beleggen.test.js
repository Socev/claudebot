'use strict';
// wv2982: OVIS Beleggen fase 1 — bestandslezer, rekenwerk en routes op VERZONNEN gegevens (geen echte namen, ISIN's of bedragen).
// Toetst: drie DEGIRO-vormen (portefeuille, transacties oud NL en nieuw EN, rekeningoverzicht), weigeren bij onbekende kolommen, verkeerde
// of gemengde decimalen, een rij die niet optelt, leeg bestand; dubbele upload; verdeling, lampjes en signalen; routes en vaultpagina's.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../beleggen.js');

const PORT = [
  'Product,Symbool/ISIN,Aantal,Slotkoers,Lokale waarde,,Waarde in EUR',
  'CASH & CASH FUND & FTX CASH (EUR),,,,EUR,"150,00","150,00"',
  'VOORBEELD WERELD ETF,XX0000000022,10,"81,00",EUR,"810,00","810,00"',
  'VOORBEELD CHIPS INC,XX0000000011,3,"110,00",USD,"330,00","304,15"',
  'VOORBEELD ZORG INC,XX0000000033,2,"55,00",USD,"110,00","101,38"',
].join('\n') + '\n';
const TX_NL = [
  'Datum,Tijd,Product,ISIN,Beurs,Uitvoeringsplaats,Aantal,Koers,,Lokale waarde,,Waarde,,Wisselkoers,Transactiekosten en/of,,Totaal,,Order ID',
  '05-11-2026,15:31,VOORBEELD CHIPS INC,XX0000000011,NDQ,XNAS,3,"100,00",USD,"-300,00",USD,"-276,50",EUR,"1,0850","-2,00",EUR,"-278,50",EUR,aaaa0000-0000-0000-0000-000000000001',
  '04-11-2026,09:05,VOORBEELD WERELD ETF,XX0000000022,EAM,XAMS,10,"80,00",EUR,"-800,00",EUR,"-800,00",EUR,,"-1,00",EUR,"-801,00",EUR,aaaa0000-0000-0000-0000-000000000002',
].join('\r\n') + '\r\n';
const TX_EN = '﻿' + [
  'Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,,Local value,,Value EUR,Exchange rate,AutoFX Fee,Transaction and/or third party fees EUR,Total EUR,Order ID,',
  '06-11-2026,16:00,VOORBEELD ZORG INC,XX0000000033,NYS,XNYS,2,50.00,USD,-100.00,USD,-92.17,1.0850,-0.23,-2.00,-94.40,,aaaa0000-0000-0000-0000-000000000003',
].join('\n') + '\n';
const REK = [
  'Datum,Tijd,Valutadatum,Product,ISIN,Omschrijving,FX,Mutatie,,Saldo,,Order Id',
  '05-11-2026,15:31,05-11-2026,VOORBEELD CHIPS INC,XX0000000011,DEGIRO Transactiekosten,,EUR,"-2,00",EUR,"917,00",aaaa0000-0000-0000-0000-000000000001',
  '04-11-2026,09:05,04-11-2026,VOORBEELD WERELD ETF,XX0000000022,Koop 10 @ 80 EUR,,EUR,"-800,00",EUR,"919,00",aaaa0000-0000-0000-0000-000000000002',
  '01-11-2026,10:00,01-11-2026,,,iDEAL storting,,EUR,"1719,00",EUR,"1719,00",',
].join('\n');

function weigert(tekst, re) {
  assert.throws(() => B.leesBestand(tekst), (e) => e instanceof B.LeesFout && re.test(e.message), 'verwacht weigering ' + re);
}

test('lezer: portefeuille (NL, komma) met contant geld apart', () => {
  const l = B.leesBestand(PORT);
  assert.strictEqual(l.soort, 'portefeuille'); assert.strictEqual(l.decimaal, ',');
  assert.strictEqual(l.rijen.length, 4);
  const cash = l.rijen.find((r) => r.regelsoort === 'cash');
  assert.deepStrictEqual([cash.sleutel, cash.waarde_eur_cent], ['cash:EUR', 15000]);
  const chips = l.rijen.find((r) => r.isin === 'XX0000000011');
  assert.deepStrictEqual([chips.sleutel, chips.valuta, chips.lokaal_cent, chips.waarde_eur_cent, chips.aantal], ['isin:XX0000000011', 'USD', 33000, 30415, '3']);
});
test('lezer: transacties oud NL (19 kolommen) en nieuw EN (18 kolommen, punt, BOM, AutoFX)', () => {
  const a = B.leesBestand(TX_NL);
  assert.strictEqual(a.soort, 'transacties'); assert.strictEqual(a.rijen.length, 2);
  assert.deepStrictEqual([a.rijen[0].datum, a.rijen[0].valuta, a.rijen[0].waarde_eur_cent, a.rijen[0].kosten_eur_cent, a.rijen[0].totaal_eur_cent, a.rijen[0].order_id],
    ['2026-11-05', 'USD', -27650, -200, -27850, 'aaaa0000-0000-0000-0000-000000000001']);
  const b = B.leesBestand(TX_EN);
  assert.strictEqual(b.soort, 'transacties'); assert.strictEqual(b.decimaal, '.');
  assert.deepStrictEqual([b.rijen[0].kosten_eur_cent, b.rijen[0].totaal_eur_cent, b.rijen[0].order_id], [-223, -9440, 'aaaa0000-0000-0000-0000-000000000003']);
});
test('lezer: rekeningoverzicht, saldo loopt door (nieuw → oud én oud → nieuw)', () => {
  const l = B.leesBestand(REK);
  assert.strictEqual(l.soort, 'rekening'); assert.strictEqual(l.rijen.length, 3);
  const kop = REK.split('\n')[0], rs = REK.split('\n').slice(1).reverse();
  assert.strictEqual(B.leesBestand([kop, ...rs].join('\n')).rijen.length, 3);
  weigert(REK.replace('"917,00"', '"916,00"'), /saldo in EUR loopt niet door/);
});
test('lezer: verkeerde of onbekende kolommen = weigeren met de namen', () => {
  weigert(PORT.replace('Slotkoers', 'Koersdoel'), /onbekende kolommen: Koersdoel/);
  weigert(TX_NL.replace(',Wisselkoers,', ',Rente,'), /geen bekend DEGIRO-bestand/);
  weigert('Naam,Bedrag\nX,1\n', /geen bekend DEGIRO-bestand/);
});
test('lezer: verkeerde decimalen = weigeren', () => {
  weigert(PORT.replace('"810,00","810,00"', '"810.00","810.00"'), /mengt komma en punt/);
  weigert(PORT.replace('"810,00","810,00"', '"1.810,00","810,00"'), /punt én komma/);
  weigert(TX_EN.replace('-92.17', '"-92,17"'), /mengt komma en punt/);
  weigert(TX_EN.replace('-92.17', '-92,17'), /velden/);
  weigert(PORT.replace('"81,00"', '"81 euro"'), /geen getal/);
});
test('lezer: rij die niet optelt = weigeren met regelnummer', () => {
  try { B.leesBestand(PORT.replace('"810,00","810,00"', '"820,00","820,00"')); assert.fail('niet geweigerd'); }
  catch (e) { assert.ok(e instanceof B.LeesFout); assert.match(e.message, /aantal × slotkoers/); assert.strictEqual(e.regel, 3); }
  weigert(TX_NL.replace('"-276,50"', '"-300,00"'), /wisselkoers geven niet de waarde/);
  weigert(TX_NL.replace('"-278,50"', '"-280,50"'), /totaal is niet waarde \+ kosten/);
  weigert(TX_NL.replace('05-11-2026', '31-11-2026'), /datum bestaat niet/);
  weigert(TX_NL.replace('05-11-2026', '2026-11-05'), /dd-mm-jjjj/);
  weigert(TX_NL.replace('XX0000000011', 'ABC'), /ISIN/);
});
test('lezer: leeg bestand, alleen kopregel, kapotte aanhalingstekens', () => {
  weigert('', /leeg bestand/);
  weigert('﻿  \n', /leeg bestand/);
  weigert(PORT.split('\n')[0] + '\n', /alleen een kopregel/);
  weigert(PORT.replace('"81,00"', '"81,00'), /aanhalingsteken|velden/);
});
test('lezer: twee gelijke deeluitvoeringen op één dag krijgen elk een eigen sleutel, opnieuw lezen dezelfde', () => {
  const kop = TX_NL.split('\r\n')[0], r = TX_NL.split('\r\n')[2];
  const a = B.leesBestand([kop, r, r].join('\n'));
  assert.strictEqual(new Set(a.rijen.map((x) => x.sleutel)).size, 2);
  const b = B.leesBestand([kop, r, r].join('\n'));
  assert.deepStrictEqual(a.rijen.map((x) => x.sleutel), b.rijen.map((x) => x.sleutel));
});

// ── rekenwerk ──
function data(regels, soorten, extra) {
  const l = B.leesBestand(PORT);
  return Object.assign({ antwoorden: {}, regels: regels || {}, posities: l.rijen.map((r) => Object.assign({ bron: 'bestand' }, r)), soorten: soorten || {}, transacties: [], dagboek: [], volglijst: [], keuzes: {},
    stand_datum: '2026-11-12' }, extra || {});
}
const REGELS = { kern_min: 60, kern_max: 80, eigen_min: 15, eigen_max: 35, leuk_max: 5, max_aandeel: 30, max_thema: 30, herbalans_wijze: 'momenten', herbalans_maanden: [1, 7], afkoel_dagen: 14 };
const SOORT = { 'isin:XX0000000022': 'kern', 'isin:XX0000000011': 'tech', 'isin:XX0000000033': 'health' };
test('rekenwerk: verdeling zonder cash, lampjes groen binnen de regels', () => {
  const k = B.bereken(data(REGELS, SOORT), '2026-11-12');
  assert.strictEqual(k.verdeling.belegd_cent, 81000 + 30415 + 10138);
  assert.strictEqual(k.verdeling.cash_cent, 15000);
  assert.deepStrictEqual([k.verdeling.kern, k.verdeling.tech, k.verdeling.health, k.verdeling.eigen, k.verdeling.leuk], [66.6, 25, 8.3, 33.4, 0]);
  const L = Object.fromEntries(k.lampjes.map((l) => [l.sleutel, l.lamp]));
  assert.deepStrictEqual(L, { kern: 'groen', eigen: 'groen', leuk: 'groen', max_aandeel: 'groen', max_thema: 'groen', herbalans: 'groen', afkoel: 'groen', koop_niet: 'grijs' });
  assert.deepStrictEqual(k.signalen, []);
});
test('rekenwerk: grens overschreden = oranje lampje + signaal met vaste opbouw; positie zonder soort = grijs + open punt', () => {
  const k = B.bereken(data(Object.assign({}, REGELS, { max_aandeel: 10, max_thema: 20, kern_min: 70 }), SOORT), '2026-11-12');
  const L = Object.fromEntries(k.lampjes.map((l) => [l.sleutel, l.lamp]));
  assert.deepStrictEqual([L.kern, L.max_aandeel, L.max_thema], ['oranje', 'oranje', 'oranje']);
  const s = k.signalen.map((x) => x.soort).sort();
  assert.deepStrictEqual(s, ['boven_maximum', 'boven_maximum']);
  for (const x of k.signalen) { assert.ok(x.wat && x.raakt && x.plan); assert.strictEqual(x.keuzes[0], 'niets'); }
  const k2 = B.bereken(data(REGELS, { 'isin:XX0000000022': 'kern' }), '2026-11-12');
  assert.strictEqual(Object.fromEntries(k2.lampjes.map((l) => [l.sleutel, l.lamp])).kern, 'grijs');
  assert.strictEqual(k2.open_punten.filter((o) => o.soort === 'positie').length, 2);
});
test('rekenwerk: potje, herbalansmaand, afwijking, koop ik niet, Anthropic-zin', () => {
  const k = B.bereken(data(Object.assign({}, REGELS, { leuk_max: 5, koop_niet: ['Zorg Inc'] }), Object.assign({}, SOORT, { 'isin:XX0000000033': 'leuk' })), '2026-07-03');
  const soorten = k.signalen.map((x) => x.soort).sort();
  assert.deepStrictEqual(soorten, ['herbalans', 'koop_niet', 'potje']);
  const k2 = B.bereken(data(Object.assign({}, REGELS, { herbalans_wijze: 'afwijking', kern_min: 70 }), SOORT), '2026-11-12');
  assert.ok(k2.signalen.some((x) => x.sleutel.startsWith('herbalans:afwijking')));
  assert.strictEqual(k2.belang, null);
  const k3 = B.bereken(data(REGELS, SOORT, { volglijst: [{ id: 1, naam: 'Anthropic', code: 'ANT', op: '2026-11-12T10:00:00Z' }] }), '2026-11-12');
  assert.strictEqual(k3.belang, B.ANTHROPIC_ZIN);
});
test('rekenwerk: transactie zonder dagboekregel, terugblik na 6 en 12 maanden, Niets doen en herinnering', () => {
  const tx = [{ sleutel: 'tx:1', datum: '2026-01-10', naam: 'VOORBEELD CHIPS INC', isin: 'XX0000000011', aantal: '3' }];
  let k = B.bereken(data(REGELS, SOORT, { transacties: tx }), '2026-11-12');
  assert.deepStrictEqual(k.signalen.map((x) => x.soort), ['dagboek']);
  const db = [{ id: 7, transactie_sleutel: 'tx:1', datum: '2026-01-10', naam: 'VOORBEELD CHIPS INC', waarom: 'eigen reden' }];
  k = B.bereken(data(REGELS, SOORT, { transacties: tx, dagboek: db }), '2026-11-12');
  assert.deepStrictEqual(k.signalen.map((x) => x.sleutel), ['terugblik6:7']);
  assert.strictEqual(k.signalen[0].schreef, 'eigen reden');
  k = B.bereken(data(REGELS, SOORT, { transacties: tx, dagboek: db }), '2027-01-10');
  assert.deepStrictEqual(k.signalen.map((x) => x.sleutel).sort(), ['herbalans:2027-01', 'terugblik12:7', 'terugblik6:7']);
  k = B.bereken(data(REGELS, SOORT, { transacties: tx, dagboek: db, keuzes: { 'terugblik6:7': { keuze: 'niets' }, 'terugblik12:7': { keuze: 'herinner', tot: '2027-01-20' } } }), '2027-01-10');
  assert.deepStrictEqual(k.signalen.map((x) => x.sleutel), ['herbalans:2027-01']);
  assert.strictEqual(B.plusMaanden('2026-08-31', 6), '2027-02-28');
});
test('plan: regels uit de antwoorden, met controle', () => {
  assert.deepStrictEqual(B.regelsUit(7, { kern_min: '60', kern_max: '80,5', eigen_min: '', eigen_max: '30', leuk_max: '5 %' }), { kern_min: 60, kern_max: 80.5, eigen_min: null, eigen_max: 30, leuk_max: 5 });
  assert.throws(() => B.regelsUit(7, { kern_min: '90', kern_max: '80' }), /minstens is groter/);
  assert.throws(() => B.regelsUit(8, { max_aandeel: '120' }), /tussen 0 en 100/);
  assert.deepStrictEqual(B.regelsUit(14, { herbalans_wijze: 'momenten', herbalans_maanden: '7, 1 1' }), { herbalans_wijze: 'momenten', herbalans_maanden: [1, 7] });
  assert.deepStrictEqual(B.regelsUit(10, { koop_niet: 'Leverancier A\n\n Leverancier B ' }), { koop_niet: ['Leverancier A', 'Leverancier B'] });
});

// ── routes ──
function nieuw() {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'beleggen-'));
  const vault = {};
  const m = B.maak({ dbPad: path.join(map, 'b', 'beleggen.sqlite'), vaultSchrijf: (rel, t) => { vault[rel] = t; }, vandaag: () => '2026-11-12' });
  const post = (p, body) => m.app({ methode: 'POST', pad: '/app/beleggen/' + p, body });
  const get = () => m.app({ methode: 'GET', pad: '/app/beleggen' });
  return { m, map, vault, post, get };
}
test('routes: leeg begin, bestand proef → bewaar → dubbel, map 700 en bestand 600', () => {
  const { map, post, get } = nieuw();
  let u = get(); assert.strictEqual(u.status, 200); assert.strictEqual(u.body.stand.posities.length, 0); assert.strictEqual(u.body.open_punten.filter((o) => o.soort === 'vraag').length, 14);
  u = post('bestand', { naam: 'Transactions.csv', tekst: TX_NL, bewaar: false });
  assert.deepStrictEqual([u.status, u.body.soort, u.body.nieuw, u.body.bewaard], [200, 'transacties', 2, false]);
  assert.strictEqual(get().body.transacties.length, 0, 'proef schrijft niets');
  u = post('bestand', { naam: 'Transactions.csv', tekst: TX_NL, bewaar: true });
  assert.deepStrictEqual([u.body.nieuw, u.body.bewaard], [2, true]);
  u = post('bestand', { naam: 'Transactions.csv', tekst: TX_NL, bewaar: true });
  assert.deepStrictEqual([u.body.nieuw, u.body.al_bekend], [0, 2]);
  assert.match(u.body.melding, /niets nieuws/);
  assert.strictEqual(get().body.transacties.length, 2, 'dubbele upload voegt niets toe');
  u = post('bestand', { naam: 'x.csv', tekst: '', bewaar: true });
  assert.deepStrictEqual([u.status, u.reden], [422, 'beleggen bestand geweigerd']);
  assert.strictEqual(fs.statSync(path.join(map, 'b')).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(map, 'b', 'beleggen.sqlite')).mode & 0o777, 0o600);
});
test('routes: portefeuille, soort, plan met versie en vaultpagina, dagboek, volglijst, signaalkeuze, handinvoer', () => {
  const { post, get, vault, m } = nieuw();
  assert.strictEqual(post('bestand', { naam: 'Portfolio.csv', tekst: PORT, datum: '2026-11-11', bewaar: true }).body.effecten, 3);
  let o = get().body;
  assert.strictEqual(o.stand.datum, '2026-11-11'); assert.strictEqual(o.stand.cash.length, 1);
  for (const [sl, s] of Object.entries(SOORT)) assert.strictEqual(post('soort', { sleutel: sl, soort: s }).status, 200);
  assert.strictEqual(post('soort', { sleutel: 'isin:XX0000000022', soort: 'koop' }).status, 400);
  assert.strictEqual(post('plan', { vraag: 8, waarden: { max_aandeel: '10', max_thema: '40' }, tekst: 'niet te veel in één' }).status, 200);
  assert.strictEqual(post('plan', { vraag: 3, overslaan: true }).status, 200);
  o = get().body;
  assert.strictEqual(o.versies.length, 2); assert.strictEqual(o.regels.max_aandeel, 10);
  assert.ok(o.signalen.some((s) => s.sleutel.startsWith('max-aandeel:isin:XX0000000011')));
  assert.ok(o.open_punten.some((p) => p.vraag === 3 && /overgeslagen/.test(p.tekst)));
  const plan = vault['20_Prive/Financien/Beleggen/Beleggingsplan.md'];
  assert.match(plan, /db_sleutel: planversie 2/); assert.match(plan, /Open punt: overgeslagen/); assert.match(plan, /\| Eén aandeel hoogstens \(vraag 8\) \| 10 % \|/);
  // Niets doen verbergt het signaal
  const sig = o.signalen.find((s) => s.sleutel.startsWith('max-aandeel:'));
  assert.strictEqual(post('signaal', { sleutel: sig.sleutel, keuze: 'niets' }).status, 200);
  assert.ok(!get().body.signalen.some((s) => s.sleutel === sig.sleutel));
  // dagboek bij een transactie
  post('bestand', { naam: 'Transactions.csv', tekst: TX_NL, bewaar: true });
  o = get().body;
  assert.strictEqual(o.signalen.filter((s) => s.soort === 'dagboek').length, 2);
  const tx = o.transacties[0].sleutel;
  assert.strictEqual(post('dagboek', { transactie: tx, waarom: 'reden', blijven: 'de vraag naar chips', verkoop_wanneer: 'als de reden niet meer klopt' }).status, 200);
  assert.strictEqual(post('dagboek', { transactie: tx, waarom: 'nog eens' }).status, 409);
  assert.strictEqual(get().body.signalen.filter((s) => s.soort === 'dagboek').length, 1);
  assert.match(vault['20_Prive/Financien/Beleggen/Dagboek.md'], /Wat moet waar blijven:\*\* de vraag naar chips/);
  // volglijst
  assert.strictEqual(post('volglijst', { actie: 'zet', naam: 'Voorbeeld Diagnostiek', thema: 'health', waarom: 'ken het uit de praktijk', wanneer: 'na de eerste studie' }).status, 200);
  o = get().body; assert.strictEqual(o.volglijst.length, 1); assert.strictEqual(o.volglijst[0].vroegst, null);
  assert.strictEqual(post('volglijst', { actie: 'weg', id: o.volglijst[0].id }).status, 200);
  assert.strictEqual(get().body.volglijst.length, 0);
  // handinvoer: positie en transactie; een positie uit het bestand niet met de hand overschrijven
  assert.strictEqual(post('positie', { actie: 'zet', naam: 'Voorbeeld Hand', aantal: '1', waarde_eur: '50,00', soort: 'leuk' }).status, 200);
  assert.strictEqual(post('positie', { actie: 'zet', naam: 'X', isin: 'XX0000000011', aantal: '1', waarde_eur: '1' }).status, 409);
  const t = post('transactie', { actie: 'zet', richting: 'erbij', datum: '2026-11-10', naam: 'Voorbeeld Hand', aantal: '1', koers: '50', valuta: 'EUR', kosten_eur: '1' });
  assert.strictEqual(t.status, 200);
  assert.ok(get().body.transacties.some((x) => x.sleutel === t.body.sleutel && x.aantal === '1'));
  assert.strictEqual(post('transactie', { actie: 'weg', sleutel: t.body.sleutel }).status, 200);
  assert.strictEqual(post('transactie', { actie: 'weg', sleutel: tx }).status, 404, 'een transactie uit het bestand kan niet weg');
  assert.strictEqual(post('onbekend', {}).status, 404);
  const i = m.info();
  assert.deepStrictEqual([i.posities, i.transacties, i.planversies, i.vault_ok], [5, 2, 2, true]);
});
test('niets met bedragen in reden of info', () => {
  const { post, m } = nieuw();
  const redenen = [post('bestand', { naam: 'p.csv', tekst: PORT, bewaar: true }).reden, post('bestand', { naam: 'p.csv', tekst: PORT.replace('"810,00","810,00"', '"820,00","820,00"'), bewaar: true }).reden];
  for (const r of redenen) assert.ok(!/\d+[,.]\d{2}/.test(r), r);
  assert.ok(!/cent|810|304/.test(JSON.stringify(m.info())));
});

// ── review achteraf (Codex 12-11, NO-GO 7 MOET + 1 ZOU): elk punt een toets ──
test('review MOET 1: tekens — erbij met positieve lokale waarde, positieve kosten, negatief aantal in de portefeuille = weigeren', () => {
  weigert(TX_NL.replace('"-800,00",EUR,"-800,00",EUR,,"-1,00",EUR,"-801,00"', '"800,00",EUR,"800,00",EUR,,"-1,00",EUR,"799,00"'), /teken van de lokale waarde/);
  weigert(TX_NL.replace('"-2,00",EUR,"-278,50"', '"2,00",EUR,"-274,50"'), /kosten horen negatief/);
  weigert(PORT.replace('XX0000000022,10,"81,00",EUR,"810,00","810,00"', 'XX0000000022,-10,"81,00",EUR,"-810,00","-810,00"'), /aantal moet groter dan nul/);
  weigert(TX_NL.replace('3,"100,00",USD', '3,"0,00",USD'), /koers moet groter dan nul/);
});
test('review MOET 2: een kostenkolom met valuta moet in euro staan', () => {
  weigert(TX_NL.replace('"-2,00",EUR,"-278,50"', '"-2,00",USD,"-278,50"'), /kosten moet in EUR staan, niet in USD/);
});
test('review MOET 3: alleen een CASH-regel mag zonder aantal en ISIN', () => {
  weigert(PORT.replace('VOORBEELD WERELD ETF,XX0000000022,10,"81,00",EUR,"810,00","810,00"', 'VOORBEELD WERELD ETF,,,,EUR,"810,00","810,00"'), /zonder aantal of ISIN/);
  assert.strictEqual(B.leesBestand(PORT).rijen.filter((r) => r.regelsoort === 'cash').length, 1);
});
test('review MOET 4: rekeningregel met mutatie maar zonder saldo = weigeren; zonder beide mag', () => {
  weigert(REK.replace('EUR,"917,00",aaaa', ',,aaaa'), /mutatie zonder saldo/);
  const info = REK + '\n05-11-2026,15:31,05-11-2026,VOORBEELD CHIPS INC,XX0000000011,Valuta Creditering,"1,0850",,,,,';
  assert.strictEqual(B.leesBestand(info).rijen.length, 4);
});
test('review MOET 5: 3 en 3,0 of 100,00 en 100,0 geven dezelfde dubbelsleutel', () => {
  const a = B.leesBestand(TX_NL).rijen[0].sleutel;
  const b = B.leesBestand(TX_NL.replace('XNAS,3,"100,00",USD', 'XNAS,"3,0","100,0",USD')).rijen[0].sleutel;
  assert.strictEqual(a, b);
});
test('review MOET 6: een beantwoorde vraag overslaan haalt haar regels weg', () => {
  const { post, get } = nieuw();
  post('plan', { vraag: 8, waarden: { max_aandeel: '10', max_thema: '40' } });
  assert.strictEqual(get().body.regels.max_aandeel, 10);
  post('plan', { vraag: 8, overslaan: true });
  const o = get().body;
  assert.strictEqual(o.regels.max_aandeel, undefined); assert.strictEqual(o.regels.max_thema, undefined);
  assert.strictEqual(o.stand.lampjes.find((l) => l.sleutel === 'max_aandeel').grens, 'nog niet gezet');
});
test('review MOET 7: maximum per aandeel/thema grijs zolang een positie geen soort heeft, oranje bij een overschrijding', () => {
  const L = (r, s) => Object.fromEntries(B.bereken(data(r, s), '2026-11-12').lampjes.map((l) => [l.sleutel, l.lamp]));
  assert.deepStrictEqual([L(REGELS, {}).max_aandeel, L(REGELS, {}).max_thema], ['grijs', 'grijs']);
  const half = { 'isin:XX0000000011': 'tech' };
  assert.strictEqual(L(Object.assign({}, REGELS, { max_aandeel: 10 }), half).max_aandeel, 'oranje');
  assert.strictEqual(L(REGELS, half).max_aandeel, 'grijs');
});
test('review ZOU 1: grenzen op onafgeronde percentages (10,04 % boven 10 %)', () => {
  const d = { antwoorden: {}, regels: { max_aandeel: 10, kern_max: 89.97 }, soorten: { 'isin:XX0000000011': 'tech', 'isin:XX0000000022': 'kern' }, transacties: [], dagboek: [], volglijst: [], keuzes: {}, stand_datum: '2026-11-12',
    posities: [{ sleutel: 'isin:XX0000000011', regelsoort: 'effect', naam: 'A', waarde_eur_cent: 1004 }, { sleutel: 'isin:XX0000000022', regelsoort: 'effect', naam: 'B', waarde_eur_cent: 8996 }] };
  const k = B.bereken(d, '2026-11-12');
  assert.strictEqual(k.posities[1].aandeel, 10);
  assert.ok(k.signalen.some((x) => x.sleutel.startsWith('max-aandeel:isin:XX0000000011')));
  assert.strictEqual(k.verdeling.kern, 90, 'weergave afgerond');
  assert.strictEqual(k.lampjes.find((l) => l.sleutel === 'kern').lamp, 'groen', 'kern 89,96 % ligt onder het maximum 89,97 % (afgerond 90,0 zou ten onrechte oranje geven)');
});
test('wv3006: historie — één punt per standdatum (laatste bestand van die dag), belegd en contant apart, oplopend, leeg zonder bestand', () => {
  const { post, get } = nieuw();
  assert.deepStrictEqual(get().body.stand.historie, []);
  const p2 = PORT.replace('"810,00","810,00"', '"820,00","820,00"').replace('10,"81,00"', '10,"82,00"');
  const p3 = PORT.replace('"150,00","150,00"', '"250,00","250,00"');
  assert.strictEqual(post('bestand', { naam: 'a.csv', tekst: PORT, datum: '2026-10-01', bewaar: true }).body.bewaard, true);
  assert.strictEqual(post('bestand', { naam: 'b.csv', tekst: p3, datum: '2026-11-12', bewaar: true }).body.bewaard, true);
  assert.strictEqual(post('bestand', { naam: 'c.csv', tekst: p2, datum: '2026-11-12', bewaar: true }).body.bewaard, true);   // zelfde dag: dit telt
  assert.strictEqual(post('bestand', { naam: 't.csv', tekst: TX_NL, bewaar: true }).body.bewaard, true);   // transacties tellen niet
  const h = get().body.stand.historie;
  assert.deepStrictEqual(h, [{ datum: '2026-10-01', belegd_cent: 81000 + 30415 + 10138, cash_cent: 15000 }, { datum: '2026-11-12', belegd_cent: 82000 + 30415 + 10138, cash_cent: 15000 }]);
  assert.strictEqual(get().body.stand.historie.length, 2, 'tweede lezing (cache) geeft hetzelfde');
});
test('wv3008 startfase: contant met de hand telt als contant, niet als belegd; een ingelezen portefeuille vervangt het; daarna niet meer met de hand', () => {
  const { post, get } = nieuw();
  assert.strictEqual(post('positie', { actie: 'contant', waarde_eur: '-1' }).status, 400);
  assert.strictEqual(post('positie', { actie: 'contant', waarde_eur: 'veel' }).status, 400);
  const u = post('positie', { actie: 'contant', waarde_eur: '250,50' });
  assert.strictEqual(u.status, 200); assert.ok(!/\d/.test(u.reden), 'geen bedrag in de reden');
  let o = get().body;
  assert.deepStrictEqual([o.stand.verdeling.cash_cent, o.stand.verdeling.belegd_cent, o.stand.posities.length, o.stand.cash.length, o.stand.bron, o.stand.datum], [25050, 0, 0, 1, 'hand', '2026-11-12']);
  assert.strictEqual(post('positie', { actie: 'contant', waarde_eur: '300' }).status, 200);
  assert.strictEqual(get().body.stand.verdeling.cash_cent, 30000, 'bijwerken, niet optellen');
  assert.strictEqual(post('bestand', { naam: 'Portfolio.csv', tekst: PORT, datum: '2026-11-12', bewaar: true }).status, 200);
  o = get().body;
  assert.ok(!o.stand.cash.some((c) => c.sleutel === 'cash:hand'), 'bestand vervangt de handregel');
  assert.strictEqual(post('positie', { actie: 'contant', waarde_eur: '1' }).status, 409);
  assert.strictEqual(post('positie', { actie: 'raar' }).status, 400);
});
