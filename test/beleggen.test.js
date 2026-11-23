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
test('lezer: rekeningoverzicht, saldo loopt door van nieuw → oud; oud → nieuw = weigeren (wv2985)', () => {
  const l = B.leesBestand(REK);
  assert.strictEqual(l.soort, 'rekening'); assert.strictEqual(l.rijen.length, 3);
  const kop = REK.split('\n')[0], rs = REK.split('\n').slice(1).reverse();
  weigert([kop, ...rs].join('\n'), /loopt niet door van onder naar boven/);
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
  weigert(TX_NL.replace('"-276,50"', '"-300,00"'), /wisselkoers geeft niet de waarde/);
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
  const info = REK + '\n01-11-2026,09:00,01-11-2026,VOORBEELD GELDFONDS,XX0000000099,Geldmarktfonds prijswijziging,,,,,,';   // wv2985: FX zonder mutatie = weigeren (zie echte vorm)
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

// ── wv2985: Davids ECHTE DEGIRO-vorm (NL-export, gemeten 14-11-2026 op zijn eigen bestanden; hier VERZONNEN namen, ISIN's, getallen en order-id's) ──
// Transacties: 17 kolommen met AutoFX, paren getal → valuta, Waarde/Totaal EUR enkel, wisselkoers = USD per euro, koop = negatieve lokale waarde.
// Rekeningoverzicht: paren valuta → getal, nieuw → oud (ook binnen één minuut), saldo per valuta loopt door, FX alleen op de Valuta Creditering
// in vreemde valuta; de bijbehorende Valuta Debitering in euro = bedrag / FX (incl. AutoFX); USD-saldo terug op nul.
const ECHT_TX = [
  'Datum,Tijd,Product,ISIN,Beurs,Uitvoeringsplaats,Aantal,Koers,,Lokale waarde,,Waarde EUR,Wisselkoers,AutoFX Kosten,Transactiekosten en/of kosten van derden EUR,Totaal EUR,Order ID',
  '10-11-2026,15:45,VOORBEELD ROBOT CORP,XX0000000044,NDQ,XNAS,4,"50,2500",USD,"-201,00",USD,"-179,46","1,1200","-0,45","-2,00","-181,91",bbbb0000-0000-4000-8000-000000000001',
  '09-11-2026,10:12,VOORBEELD ZORGFONDS,XX0000000055,EAM,XAMS,6,"20,0000",EUR,"-120,00",EUR,"-120,00",,,"-1,00","-121,00",bbbb0000-0000-4000-8000-000000000002',
].join('\n') + '\n';
const ECHT_REK = [
  'Datum,Tijd,Valutadatum,Product,ISIN,Omschrijving,FX,Mutatie,,Saldo,,Order Id',
  '10-11-2026,15:45,10-11-2026,VOORBEELD ROBOT CORP,XX0000000044,Valuta Creditering,"1,1172",USD,"201,00",USD,"0,00",bbbb0000-0000-4000-8000-000000000001',
  '10-11-2026,15:45,10-11-2026,VOORBEELD ROBOT CORP,XX0000000044,Valuta Debitering,,EUR,"-179,91",EUR,"197,09",bbbb0000-0000-4000-8000-000000000001',
  '10-11-2026,15:45,10-11-2026,VOORBEELD ROBOT CORP,XX0000000044,DEGIRO Transactiekosten en/of kosten van derden,,EUR,"-2,00",EUR,"377,00",bbbb0000-0000-4000-8000-000000000001',
  '10-11-2026,15:45,10-11-2026,VOORBEELD ROBOT CORP,XX0000000044,"Koop 4 @ 50,25 USD",,USD,"-201,00",USD,"-201,00",bbbb0000-0000-4000-8000-000000000001',
  '09-11-2026,10:12,09-11-2026,VOORBEELD ZORGFONDS,XX0000000055,DEGIRO Transactiekosten en/of kosten van derden,,EUR,"-1,00",EUR,"379,00",bbbb0000-0000-4000-8000-000000000002',
  '09-11-2026,10:12,09-11-2026,VOORBEELD ZORGFONDS,XX0000000055,"Koop 6 @ 20 EUR",,EUR,"-120,00",EUR,"380,00",bbbb0000-0000-4000-8000-000000000002',
  '08-11-2026,19:30,08-11-2026,,,Reservation iDEAL,,EUR,"500,00",EUR,"500,00",',
].join('\n') + '\n';
test('wv2985 echte vorm: transacties (AutoFX, USD per euro) en rekeningoverzicht (valuta → getal, nieuw → oud) worden gelezen', () => {
  const t = B.leesBestand(ECHT_TX);
  assert.deepStrictEqual([t.soort, t.rijen.length, t.decimaal, t.scheiding], ['transacties', 2, ',', ',']);
  const r = t.rijen[0];
  assert.deepStrictEqual([r.valuta, r.lokaal_cent, r.waarde_eur_cent, r.kosten_eur_cent, r.totaal_eur_cent, r.wisselkoers, r.order_id, r.aantal],
    ['USD', -20100, -17946, -245, -18191, '1.1200', 'bbbb0000-0000-4000-8000-000000000001', '4']);
  assert.deepStrictEqual([t.rijen[1].valuta, t.rijen[1].wisselkoers, t.rijen[1].kosten_eur_cent], ['EUR', null, -100]);
  const k = B.leesBestand(ECHT_REK);
  assert.deepStrictEqual([k.soort, k.rijen.length], ['rekening', 7]);
  assert.deepStrictEqual(k.rijen.map((x) => x.mutatie_valuta + ':' + x.mutatie_cent).slice(0, 2), ['USD:20100', 'EUR:-17991']);
  assert.strictEqual(k.rijen[6].order_id, null);
  assert.ok(!('_fx' in JSON.parse(JSON.stringify(k.rijen[0]))), 'FX-hulpveld lekt niet naar de opslag');
});
test('wv2985 echte vorm: elke afwijking = weigeren', () => {
  // paren in de andere volgorde
  weigert(ECHT_TX.replace('"-201,00",USD,"-179,46"', 'USD,"-201,00","-179,46"'), /eerst het getal, dan de valuta/);
  weigert(ECHT_REK.replace('Koop 4 @ 50,25 USD",,USD,"-201,00"', 'Koop 4 @ 50,25 USD",,"-201,00",USD'), /eerst de valuta, dan het getal/);
  // wisselkoers andersom (euro per USD) of bij een eurotransactie
  weigert(ECHT_TX.replace('"1,1200"', '"0,8929"'), /USD per euro/);
  weigert(ECHT_TX.replace('"-120,00",,,"-1,00"', '"-120,00","1,1200",,"-1,00"'), /wisselkoers bij een bedrag in euro/);
  // rekeningoverzicht oud → nieuw, of twee regels van plaats gewisseld
  const [kop, ...rs] = ECHT_REK.trim().split('\n');
  weigert([kop, ...rs.slice().reverse()].join('\n'), /loopt niet door van onder naar boven/);
  weigert([kop, rs[0], rs[1], rs[2], rs[3], rs[6], rs[4], rs[5]].join('\n'), /loopt niet door|nieuw naar oud/);
  // FX: verkeerd, op een euroregel, of op een regel die geen valutawissel is
  weigert(ECHT_REK.replace('"1,1172"', '"1,0172"'), /valutawissel klopt niet/);
  weigert(ECHT_REK.replace('Valuta Debitering,,EUR', 'Valuta Debitering,"1,1172",EUR'), /FX hoort alleen bij een valutawissel in vreemde valuta/);
  weigert(ECHT_REK.replace('"Koop 4 @ 50,25 USD",,USD', '"Koop 4 @ 50,25 USD","1,1172",USD'), /FX hoort alleen/);
  weigert(ECHT_REK.replace('Valuta Debitering,,EUR,"-179,91"', 'Valuta Debitering,,EUR,"179,91"').replace('"197,09"', '"556,91"'), /valutawissel klopt niet/);
  // review wv2985 MOET 1: FX gewist (en euroregel + saldo aangepast) = weigeren, niet stil zonder kruiscontrole
  weigert(ECHT_REK.replace('Valuta Creditering,"1,1172",USD', 'Valuta Creditering,,USD').replace('"-179,91",EUR,"197,09"', '"-279,91",EUR,"97,09"'), /FX ontbreekt bij een valutawissel in USD/);
  // review wv2985 ronde 2: order-id gewist op een valutawissel (dan geen kruiscontrole) = weigeren, aan beide kanten
  weigert(ECHT_REK.replace('"0,00",bbbb0000-0000-4000-8000-000000000001', '"0,00",').replace('"-179,91",EUR,"197,09"', '"-279,91",EUR,"97,09"'), /valutawissel zonder order-id/);
  weigert(ECHT_REK.replace('"197,09",bbbb0000-0000-4000-8000-000000000001', '"197,09",'), /valutawissel zonder order-id/);
  // review wv2985 ronde 3: twee USD-wissels tegenover één euroregel = weigeren
  { const [k0, ...r0] = ECHT_REK.trim().split('\n'); weigert([k0, r0[0].replace('"0,00"', '"201,00"'), r0[0], ...r0.slice(1)].join('\n'), /twee valutawissels/); }
  // review wv2985 ronde 4: order-id met hoofdletters (kruiscontrole zou hem missen) en een omrekening die ± 19 cent afwijkt = weigeren
  weigert(ECHT_REK.replace('"197,09",bbbb0000-0000-4000-8000-000000000001', '"197,09",BBBB0000-0000-4000-8000-000000000001'), /order-id/);
  weigert(ECHT_REK.replace('"-179,91",EUR,"197,09"', '"-180,10",EUR,"196,90"'), /valutawissel klopt niet/);
  weigert(ECHT_TX.replace('"-179,46","1,1200","-0,45","-2,00","-181,91"', '"-179,26","1,1200","-0,45","-2,00","-181,71"'), /wisselkoers geeft niet de waarde/);
  // review wv2985 ronde 5: euroregel van de wissel zonder bedragen (dan geen kruiscontrole en past het saldo nog) = weigeren
  weigert(ECHT_REK.replace('Valuta Debitering,,EUR,"-179,91",EUR,"197,09"', 'Valuta Debitering,,,,,'), /valutawissel zonder mutatie/);
  // order-id in een andere vorm
  weigert(ECHT_TX.replace('bbbb0000-0000-4000-8000-000000000002', '12345'), /order-id/);
  weigert(ECHT_REK.replace('"380,00",bbbb0000-0000-4000-8000-000000000002', '"380,00",ORDER-2'), /order-id/);
  // rekening: regels met dezelfde minuut mogen, maar een oudere regel boven een nieuwere niet (ook als het saldo toevallig klopt)
  weigert(ECHT_REK.replace('08-11-2026,19:30,08-11-2026', '11-11-2026,19:30,11-11-2026'), /nieuw naar oud/);
});

// ── wv3030: Davids vorm (14-11-2026; hier VERZONNEN): alle 14 vragen beantwoord, 7/10/13 alleen in woorden, transacties ingelezen, geen portefeuille ──
function davidVorm() {
  const r = nieuw();
  for (let v = 1; v <= 14; v++) {
    const waarden = v === 8 ? { max_aandeel: '10', max_thema: '40' } : v === 14 ? { herbalans_wijze: 'afwijking' } : {};
    assert.strictEqual(r.post('plan', { vraag: v, tekst: 'verzonnen antwoord ' + v, waarden }).status, 200);
  }
  assert.strictEqual(r.post('bestand', { naam: 'Transactions.csv', tekst: ECHT_TX, bewaar: true }).status, 200);
  return r;
}
test('wv3030 regels: beantwoorde vraag zonder getal = "geen getal" (niet "nog niet gezet"); open vraag blijft "nog niet gezet"', () => {
  const { get } = davidVorm();
  const o = get().body;
  assert.strictEqual(o.open_punten.filter((p) => p.soort === 'vraag').length, 0);
  const L = Object.fromEntries(o.stand.lampjes.map((l) => [l.sleutel, l]));
  for (const k of ['kern', 'eigen', 'leuk', 'afkoel', 'koop_niet']) { assert.strictEqual(L[k].grens, 'geen getal', k); assert.match(L[k].uitleg, /de app rekent dit niet na/); assert.strictEqual(L[k].lamp, 'grijs'); }
  assert.deepStrictEqual([L.kern.vraag, L.koop_niet.vraag, L.afkoel.vraag, L.max_aandeel.vraag], [7, 10, 13, 8]);
  assert.ok(!o.stand.lampjes.some((l) => l.grens === 'nog niet gezet'));
  assert.strictEqual(L.max_aandeel.grens, '10 %');
  const k = B.bereken({ antwoorden: {}, regels: {}, posities: [], soorten: {}, transacties: [], dagboek: [], volglijst: [], keuzes: {} }, '2026-11-12');
  assert.ok(k.lampjes.every((l) => l.grens === 'nog niet gezet'), 'zonder antwoorden blijft het "nog niet gezet"');
});
test('wv3030 stand uit transacties: aantal + aankoopwaarde incl. kosten, bron aankoop; portefeuille of handpositie gaat voor', () => {
  const { get, post } = davidVorm();
  let o = get().body;
  assert.strictEqual(o.stand.bron, 'aankoop'); assert.strictEqual(o.stand.datum, '2026-11-10');
  const P = Object.fromEntries(o.stand.posities.map((p) => [p.sleutel, p]));
  assert.deepStrictEqual([P['isin:XX0000000044'].aantal, P['isin:XX0000000044'].waarde_eur_cent, P['isin:XX0000000044'].bron], ['4', 18191, 'aankoop']);
  assert.deepStrictEqual([P['isin:XX0000000055'].aantal, P['isin:XX0000000055'].waarde_eur_cent], ['6', 12100]);
  assert.strictEqual(o.stand.verdeling.belegd_cent, 18191 + 12100);
  assert.strictEqual(o.stand.verdeling.cash_cent, 0);
  // soort en nieuwskaartje mogen op een positie uit transacties (en blijven straks bij de portefeuille: zelfde sleutel)
  assert.strictEqual(post('soort', { sleutel: 'isin:XX0000000044', soort: 'tech' }).status, 200);
  assert.strictEqual(post('soort', { sleutel: 'isin:XX0000000099', soort: 'tech' }).status, 404);
  assert.strictEqual(post('bedrijf', { sleutel: 'isin:XX0000000044', actie: 'zet', namen: ['Voorbeeld Robot'] }).status, 200);
  o = get().body;
  assert.strictEqual(o.stand.posities.find((p) => p.sleutel === 'isin:XX0000000044').soort, 'tech');
  // verkoop haalt naar rato aankoopwaarde weg; meer verkopen dan er was = onvolledig, positie weg
  const a = B.aankoopStand([{ datum: '2026-11-01', tijd: '10:00', naam: 'A', isin: 'XX0000000066', aantal: '4', totaal_eur_cent: -40000 },
    { datum: '2026-11-02', tijd: '10:00', naam: 'A', isin: 'XX0000000066', aantal: '-1', totaal_eur_cent: 12000 },
    { datum: '2026-11-02', tijd: '11:00', naam: 'B', isin: null, aantal: '-2', totaal_eur_cent: 5000 }]);
  assert.deepStrictEqual(a.posities.map((p) => [p.sleutel, p.aantal, p.waarde_eur_cent, p.onvolledig]), [['isin:XX0000000066', '3', 30000, false]]);
  assert.strictEqual(a.onvolledig, true, 'verkoop zonder bekende aankoop = stand onvolledig');
  // handpositie gaat voor
  assert.strictEqual(post('positie', { actie: 'zet', naam: 'Voorbeeld Hand', aantal: '1', waarde_eur: '50' }).status, 200);
  o = get().body;
  assert.deepStrictEqual([o.stand.bron, o.stand.posities.length], ['hand', 1]);
  // ingelezen portefeuille gaat voor
  const r2 = davidVorm();
  assert.strictEqual(r2.post('bestand', { naam: 'Portfolio.csv', tekst: PORT, datum: '2026-11-13', bewaar: true }).status, 200);
  o = r2.get().body;
  assert.deepStrictEqual([o.stand.bron, o.stand.posities.every((p) => p.bron === 'bestand')], ['bestand', true]);
});
test('wv3030 signaal op aankoopwaarde zegt dat; storting in het rekeningoverzicht telt', () => {
  const { get, post } = davidVorm();
  post('soort', { sleutel: 'isin:XX0000000044', soort: 'tech' }); post('soort', { sleutel: 'isin:XX0000000055', soort: 'health' });
  const s = get().body.signalen.find((x) => x.sleutel.startsWith('max-aandeel:'));
  assert.ok(s && /^Op aankoopwaarde \(je transacties tot en met 2026-11-10\)/.test(s.wat), s && s.wat);
  assert.strictEqual(get().body.stortingen, 0);
  assert.strictEqual(post('bestand', { naam: 'Account.csv', tekst: ECHT_REK, bewaar: true }).status, 200);
  assert.strictEqual(get().body.stortingen, 1, 'Reservation iDEAL = storting');
});
test('wv3030 dagboek: Niets doen haalt het signaal én het open punt weg', () => {
  const { get, post } = davidVorm();
  let o = get().body;
  const tx = o.open_punten.filter((p) => p.soort === 'dagboek');
  assert.strictEqual(tx.length, 2);
  for (const p of tx) assert.strictEqual(post('signaal', { sleutel: 'dagboek:' + p.transactie, keuze: 'niets' }).status, 200);
  o = get().body;
  assert.strictEqual(o.open_punten.filter((p) => p.soort === 'dagboek').length, 0);
  assert.ok(!o.signalen.some((x) => x.soort === 'dagboek'));
});
test('wv3030 review: portefeuille met alleen contant gaat voor; onvolledige transacties = niets beoordelen, geen signaal', () => {
  const r = davidVorm();
  r.post('soort', { sleutel: 'isin:XX0000000044', soort: 'tech' }); r.post('soort', { sleutel: 'isin:XX0000000055', soort: 'health' });
  const alleenCash = 'Product,Symbool/ISIN,Aantal,Slotkoers,Lokale waarde,,Waarde in EUR\nCASH & CASH FUND & FTX CASH (EUR),,,,EUR,"150,00","150,00"\n';
  assert.strictEqual(r.post('bestand', { naam: 'Portfolio.csv', tekst: alleenCash, datum: '2026-11-13', bewaar: true }).status, 200);
  let o = r.get().body;
  assert.deepStrictEqual([o.stand.bron, o.stand.posities.length, o.stand.datum], ['bestand', 0, '2026-11-13']);
  // verkoop zonder eerdere aankoop naast een geldige positie
  const tx = [{ sleutel: 't1', datum: '2026-11-01', tijd: '10:00', naam: 'A', isin: 'XX0000000066', aantal: '1', totaal_eur_cent: -10000 },
    { sleutel: 't2', datum: '2026-11-02', tijd: '10:00', naam: 'B', isin: 'XX0000000077', aantal: '-5', totaal_eur_cent: 5000 }];
  const a = B.aankoopStand(tx);
  const d = { antwoorden: {}, regels: { max_aandeel: 10 }, posities: a.posities, soorten: { 'isin:XX0000000066': 'tech' }, transacties: tx, dagboek: [{ id: 1, transactie_sleutel: 't1', datum: '2026-11-01', naam: 'A', waarom: 'x' }, { id: 2, transactie_sleutel: 't2', datum: '2026-11-02', naam: 'B', waarom: 'x' }],
    volglijst: [], keuzes: {}, stand_datum: '2026-11-02', stand_bron: 'aankoop', aankoop_onvolledig: a.onvolledig };
  const k = B.bereken(d, '2026-11-14');
  assert.strictEqual(k.volledig, false);
  assert.ok(!k.signalen.some((s) => s.soort === 'boven_maximum'), 'geen signaal op een onvolledige stand');
  assert.match(k.lampjes.find((l) => l.sleutel === 'max_aandeel').uitleg, /niet compleet/);
  const k2 = B.bereken(Object.assign({}, d, { aankoop_onvolledig: false }), '2026-11-14');
  assert.ok(k2.signalen.some((s) => s.soort === 'boven_maximum'), 'kruis: compleet → wel signaal');
});
test('wv3031 exports: per DEGIRO-export het laatst ingelezen bestand (ook na meer dan 10 bestanden), nog niet = null, geen bedragen', () => {
  const { post, get } = nieuw();
  assert.deepStrictEqual(get().body.exports, { portefeuille: null, transacties: null, rekening: null });
  assert.strictEqual(post('bestand', { naam: 'Transactions.csv', tekst: ECHT_TX, bewaar: false }).status, 200);
  assert.deepStrictEqual(get().body.exports.transacties, null, 'proef telt niet');
  assert.strictEqual(post('bestand', { naam: 'Transactions.csv', tekst: ECHT_TX, bewaar: true }).status, 200);
  let x = get().body.exports;
  assert.deepStrictEqual([x.portefeuille, x.rekening, x.transacties && x.transacties.aantal], [null, null, 1]);
  assert.match(x.transacties.op, /^\d{4}-\d\d-\d\dT/);
  for (let i = 0; i < 11; i++) assert.strictEqual(post('bestand', { naam: 'p.csv', tekst: i % 2 ? PORT.replace('"150,00","150,00"', '"160,00","160,00"') : PORT, datum: `2026-11-${String(i + 1).padStart(2, '0')}`, bewaar: true }).status, 200);
  const o = get().body;
  assert.ok(!o.bestanden.some((b) => b.soort === 'transacties'), 'de lijst van 10 ziet de transacties niet meer');
  assert.strictEqual(o.exports.transacties.aantal, 1, 'het overzicht wel');
  assert.deepStrictEqual([o.exports.portefeuille.aantal, o.exports.portefeuille.datum_bestand, o.exports.rekening], [11, '2026-11-11', null]);
  assert.strictEqual(post('bestand', { naam: 'Account.csv', tekst: ECHT_REK, bewaar: true }).status, 200);
  assert.strictEqual(get().body.exports.rekening.aantal, 1);
  assert.deepStrictEqual(Object.keys(get().body.exports.rekening).sort(), ['aantal', 'datum_bestand', 'op']);
});
// wv3727 (David Ja 21-11, nr 160): één dagboekvraag per aandeel per dag; teller voor de tegel; afgeronde beursgang
test('wv3727 dagboek: twee orders van hetzelfde aandeel op één dag = één vraag; andere dag, ander aandeel of verkoop = eigen vraag', () => {
  const tx = [
    { sleutel: 'a2', datum: '2026-11-13', tijd: '15:45', naam: 'VOORBEELD ROBOT CORP', isin: 'XX0000000044', aantal: '2' },
    { sleutel: 'a1', datum: '2026-11-13', tijd: '15:30', naam: 'VOORBEELD ROBOT CORP', isin: 'XX0000000044', aantal: '1.5' },
    { sleutel: 'b1', datum: '2026-11-13', tijd: '10:00', naam: 'VOORBEELD ZORGFONDS', isin: 'XX0000000055', aantal: '6' },
    { sleutel: 'a3', datum: '2026-11-14', tijd: '09:00', naam: 'VOORBEELD ROBOT CORP', isin: 'XX0000000044', aantal: '1' },
    { sleutel: 'a4', datum: '2026-11-14', tijd: '16:00', naam: 'VOORBEELD ROBOT CORP', isin: 'XX0000000044', aantal: '-1' }];
  // vóór wv3727 gaf dit 5 vragen (één per order); nu 4
  let k = B.bereken(data(REGELS, SOORT, { transacties: tx }), '2026-11-14');
  const dg = k.signalen.filter((x) => x.soort === 'dagboek');
  assert.strictEqual(dg.length, 4);
  const robot = dg.find((x) => x.transactie === 'a1');
  assert.ok(robot, 'groep hangt aan de vroegste order');
  assert.deepStrictEqual(robot.transacties, ['a1', 'a2']);
  assert.strictEqual(robot.sleutel, 'dagboek:a1');
  assert.match(robot.wat, /^Op 2026-11-13 kwam er 3,5 VOORBEELD ROBOT CORP bij \(2 orders\)\.$/);
  assert.strictEqual(k.open_punten.filter((p) => p.soort === 'dagboek').length, 4);
  // een regel bij de tweede order (van vóór wv3727) dekt de hele groep
  k = B.bereken(data(REGELS, SOORT, { transacties: tx, dagboek: [{ id: 1, transactie_sleutel: 'a2', datum: '2026-11-13', naam: 'VOORBEELD ROBOT CORP', waarom: 'x' }] }), '2026-11-14');
  assert.ok(!k.signalen.some((x) => x.sleutel === 'dagboek:a1'));
  assert.ok(!k.open_punten.some((p) => p.transactie === 'a1'));
  // "Niets doen" op één order van vóór wv3727 (oude sleutel per order) geldt voor de groep: geen signaal, geen open punt
  k = B.bereken(data(REGELS, SOORT, { transacties: tx, keuzes: { 'dagboek:a2': { keuze: 'niets' } } }), '2026-11-14');
  assert.ok(!k.signalen.some((x) => x.sleutel === 'dagboek:a1'));
  assert.ok(!k.open_punten.some((p) => p.transactie === 'a1'));
  // herinner op de groep verbergt tot de datum
  k = B.bereken(data(REGELS, SOORT, { transacties: tx, keuzes: { 'dagboek:a1': { keuze: 'herinner', tot: '2026-11-20' } } }), '2026-11-14');
  assert.ok(!k.signalen.some((x) => x.sleutel === 'dagboek:a1'));
});
test('wv3727 routes: Davids vorm (twee orders zelfde aandeel, zelfde dag) → één vraag; regel via de eerste order; teller', () => {
  const { m, post, get } = nieuw();
  const T = (s) => m.app({ methode: 'GET', pad: '/app/beleggen/teller' });
  assert.deepStrictEqual(T().body, { ok: true, signalen: 0, week: 0, totaal: 0 }, 'lege databank = 0');
  post('transactie', { actie: 'zet', richting: 'erbij', datum: '2026-11-10', naam: 'VOORBEELD CHIPS INC', isin: 'XX0000000011', aantal: '2', koers: '100', valuta: 'EUR', kosten_eur: '1' });
  post('transactie', { actie: 'zet', richting: 'erbij', datum: '2026-11-10', naam: 'VOORBEELD CHIPS INC', isin: 'XX0000000011', aantal: '1', koers: '101', valuta: 'EUR', kosten_eur: '1' });
  let o = get().body;
  assert.strictEqual(o.transacties.length, 2);
  const open = o.open_punten.filter((p) => p.soort === 'dagboek');
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].transacties.length, 2);
  assert.strictEqual(o.signalen.filter((s) => s.soort === 'dagboek').length, 1);
  const t = T().body;
  assert.strictEqual(t.signalen, o.signalen.length);
  assert.strictEqual(t.totaal, t.signalen + t.week);
  assert.ok(t.signalen >= 1);
  assert.strictEqual(post('dagboek', { transactie: open[0].transactie, waarom: 'één zin' }).status, 200);
  o = get().body;
  assert.strictEqual(o.signalen.filter((s) => s.soort === 'dagboek').length, 0);
  assert.strictEqual(o.open_punten.filter((p) => p.soort === 'dagboek').length, 0);
  assert.strictEqual(T().body.signalen, o.signalen.length);
  assert.ok(!/\d+,\d\d|€/.test(JSON.stringify(T().body)), 'teller: alleen aantallen');
});
test('wv3727 beursgang afronden: keuze bewaard als beursgang:<code>, terug in GET; raakt geen signaal', () => {
  const { post, get } = nieuw();
  assert.deepStrictEqual(get().body.beursgang_klaar, []);
  const voor = get().body.signalen.length;
  assert.strictEqual(post('signaal', { sleutel: 'beursgang:ANT', keuze: 'niets' }).status, 200);
  const o = get().body;
  assert.deepStrictEqual(o.beursgang_klaar, ['ANT']);
  assert.strictEqual(o.signalen.length, voor);
});
test('wv3727 teller: weekkaarten zonder keuze uit het weekbericht van de laatste 8 dagen tellen mee; ouder niet', () => {
  const { m, map, post } = nieuw();
  post('volglijst', { actie: 'zet', naam: 'Voorbeeld' });   // databank aanmaken
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(map, 'b', 'beleggen.sqlite'));
  const zet = (w, op, kaarten) => db.prepare('INSERT INTO week (iso_week, van, tot, gemaakt_op, kaarten, verder, belang, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(w, '2026-11-02', '2026-11-08', op, JSON.stringify(kaarten.map((b) => ({ bedrijf: b }))), '[]', '[]', '{}');
  zet('2026-W45', '2026-11-01T08:00:00Z', ['p', 'q', 'r']);
  zet('2026-W46', '2026-11-08T08:00:00Z', ['a', 'b']);
  db.prepare("INSERT INTO week_keuze (iso_week, bedrijf, keuze, op) VALUES ('2026-W46', 'a', 'niets', '2026-11-09T08:00:00Z')").run();
  db.close();
  let t = m.app({ methode: 'GET', pad: '/app/beleggen/teller' }).body;
  assert.deepStrictEqual([t.week, t.totaal], [1, t.signalen + 1]);
  const m2 = B.maak({ dbPad: path.join(map, 'b', 'beleggen.sqlite'), vaultSchrijf: () => {}, vandaag: () => '2026-11-20' });
  t = m2.app({ methode: 'GET', pad: '/app/beleggen/teller' }).body;
  assert.strictEqual(t.week, 0, 'weekbericht ouder dan 8 dagen telt niet meer');
});

// ── wv3756 (nr 908 / L08): Socev in het gewone gesprek — stand, dagboekzin koppelen, niet dubbel, later koppelen bij inlezen ──
test('wv3756 naam zoals David hem zegt: Nvidia ↔ NVIDIA CORP, geen deelwoord', () => {
  assert.ok(B.pastNaam('Voorbeeld Chips', 'VOORBEELD CHIPS INC'));
  assert.ok(B.pastNaam('voorbeeld chips inc.', 'VOORBEELD CHIPS INC'));
  assert.ok(!B.pastNaam('arm', 'VOORBEELD PHARMA'), 'deelwoord past niet');
  assert.ok(!B.pastNaam('x', 'X CORP'), 'één letter is te kort');
});
test('wv3756 gesprek: stand zoals het scherm, aandacht en open punten; onbekende opdracht = 400', () => {
  const { m, post } = nieuw();
  let u = m.gesprek({ opdracht: 'stand' });
  assert.strictEqual(u.status, 200); assert.strictEqual(u.body.stand.posities.length, 0); assert.strictEqual(u.body.open_punten.aantal, 14);
  post('bestand', { naam: 'Portfolio.csv', tekst: PORT, datum: '2026-11-11', bewaar: true });
  u = m.gesprek({ opdracht: 'stand' });
  const s = u.body.stand;
  assert.deepStrictEqual([s.datum, s.bron, s.belegd_eur, s.contant_eur, s.posities.length], ['2026-11-11', 'bestand', 1215.53, 150, 3]);
  assert.match(s.bron_uitleg, /portefeuille/);
  assert.strictEqual(s.posities[0].naam, 'VOORBEELD WERELD ETF');
  assert.ok(Array.isArray(u.body.lampjes) && u.body.lampjes.length > 0);
  assert.ok(!('secret' in u.body));
  assert.strictEqual(m.gesprek({ opdracht: 'koop' }).status, 400, 'alleen stand, dagboek-open, dagboek');
  assert.strictEqual(m.gesprek({}).status, 400);
});
test('wv3756 gesprek: "X gekocht omdat …" hangt aan de open aankoop; de dagboekvraag is weg; tweede keer = dubbel, geen tweede regel', () => {
  const { m, post, get, vault } = nieuw();
  post('bestand', { naam: 'Transactions.csv', tekst: TX_NL, bewaar: true });
  assert.strictEqual(m.gesprek({ opdracht: 'dagboek-open' }).body.open.length, 2);
  let u = m.gesprek({ opdracht: 'dagboek', naam: 'voorbeeld chips', waarom: 'AI-chips blijven nodig', richting: 'koop' });
  assert.strictEqual(u.status, 200, JSON.stringify(u.body));
  assert.strictEqual(u.body.gekoppeld.naam, 'VOORBEELD CHIPS INC'); assert.strictEqual(u.body.gekoppeld.datum, '2026-11-05');
  const o = get().body;
  assert.strictEqual(o.dagboek.length, 1); assert.strictEqual(o.dagboek[0].transactie_sleutel, u.body.gekoppeld.transactie);
  assert.strictEqual(o.signalen.filter((x) => x.soort === 'dagboek').length, 1, 'alleen de ETF vraagt nog');
  assert.match(vault['20_Prive/Financien/Beleggen/Dagboek.md'], /AI-chips blijven nodig/);
  u = m.gesprek({ opdracht: 'dagboek', naam: 'voorbeeld chips', waarom: 'AI-chips blijven nodig' });
  assert.strictEqual(u.status, 409); assert.strictEqual(u.body.dubbel, true);
  assert.strictEqual(get().body.dagboek.length, 1, 'niet dubbel');
  assert.strictEqual(m.gesprek({ opdracht: 'dagboek', naam: 'voorbeeld chips' }).status, 400, 'zonder waarom');
  assert.strictEqual(m.gesprek({ opdracht: 'dagboek', naam: 'voorbeeld wereld', waarom: 'x', richting: 'kopen' }).status, 400, 'richting alleen koop of verkoop');
  // met een transactiesleutel; een sleutel die al een regel heeft = 409
  const etf = m.gesprek({ opdracht: 'dagboek-open' }).body.open[0];
  assert.strictEqual(m.gesprek({ opdracht: 'dagboek', transactie: etf.transactie, waarom: 'spreiding' }).status, 200);
  assert.strictEqual(m.gesprek({ opdracht: 'dagboek', transactie: etf.transactie, waarom: 'spreiding' }).status, 409);
  assert.strictEqual(m.gesprek({ opdracht: 'dagboek', transactie: 'bestaat-niet', waarom: 'x' }).status, 404);
});
test('wv3756 gesprek: twee passende aankopen = keuze terug, niets geschreven', () => {
  const { m, post, get } = nieuw();
  const TX2 = [TX_NL.split('\r\n')[0],
    '05-11-2026,15:31,VOORBEELD CHIPS INC,XX0000000011,NDQ,XNAS,3,"100,00",USD,"-300,00",USD,"-276,50",EUR,"1,0850","-2,00",EUR,"-278,50",EUR,aaaa0000-0000-0000-0000-000000000001',
    '03-11-2026,15:31,VOORBEELD CHIPS INC,XX0000000011,NDQ,XNAS,1,"100,00",USD,"-100,00",USD,"-92,17",EUR,"1,0850","-2,00",EUR,"-94,17",EUR,aaaa0000-0000-0000-0000-000000000009'].join('\r\n') + '\r\n';
  assert.strictEqual(post('bestand', { naam: 'Transactions.csv', tekst: TX2, bewaar: true }).status, 200);
  const u = m.gesprek({ opdracht: 'dagboek', naam: 'Voorbeeld Chips', waarom: 'x' });
  assert.strictEqual(u.status, 409); assert.strictEqual(u.body.keuzes.length, 2);
  assert.strictEqual(get().body.dagboek.length, 0);
  assert.strictEqual(m.gesprek({ opdracht: 'dagboek', naam: 'Voorbeeld Chips', datum: '2026-11-04', waarom: 'eerste stap' }).status, 200, 'met een datum past er één');
});
test('wv3756 gesprek: zin vóór het inlezen = regel zonder transactie; zelfde zin opnieuw = dubbel; na het inlezen hangt hij aan de aankoop (geen tweede vraag)', () => {
  const { m, post, get, vault } = nieuw();
  let u = m.gesprek({ opdracht: 'dagboek', naam: 'Voorbeeld Chips', waarom: 'AI-chips blijven nodig', datum: '2026-11-05' });
  assert.strictEqual(u.status, 200); assert.strictEqual(u.body.zonder_transactie, true);
  const id = u.body.id;
  u = m.gesprek({ opdracht: 'dagboek', naam: 'voorbeeld chips', waarom: 'AI-chips blijven nodig', datum: '2026-11-05' });
  assert.deepStrictEqual([u.status, u.body.dubbel, u.body.id], [200, true, id]);
  assert.strictEqual(get().body.dagboek.length, 1);
  u = post('bestand', { naam: 'Transactions.csv', tekst: TX_NL, bewaar: true });
  assert.strictEqual(u.body.dagboek_gekoppeld, 1);
  const o = get().body;
  assert.strictEqual(o.dagboek.length, 1); assert.ok(o.dagboek[0].transactie_sleutel);
  assert.strictEqual(o.signalen.filter((x) => x.soort === 'dagboek').length, 1, 'alleen de ETF vraagt nog; Chips niet opnieuw');
  assert.match(vault['20_Prive/Financien/Beleggen/Dagboek.md'], /transactie: `/);
});
test('wv3756 koppelen bij inlezen: twee losse regels voor één aankoop of een aankoop buiten het venster = niets koppelen', () => {
  const { m, post, get } = nieuw();
  m.gesprek({ opdracht: 'dagboek', naam: 'Voorbeeld Chips', waarom: 'een', datum: '2026-11-05' });
  m.gesprek({ opdracht: 'dagboek', naam: 'Voorbeeld Chips', waarom: 'twee', datum: '2026-11-06' });
  m.gesprek({ opdracht: 'dagboek', naam: 'Voorbeeld Wereld ETF', waarom: 'te laat', datum: '2026-12-30' });
  const u = post('bestand', { naam: 'Transactions.csv', tekst: TX_NL, bewaar: true });
  assert.strictEqual(u.body.dagboek_gekoppeld, undefined);
  assert.ok(get().body.dagboek.every((d) => !d.transactie_sleutel));
});
test('wv3756 review MOET 1: een losse verkoopregel hangt bij het inlezen niet aan een aankoop', () => {
  const { m, post, get } = nieuw();
  assert.strictEqual(m.gesprek({ opdracht: 'dagboek', naam: 'Voorbeeld Chips', waarom: 'winst nemen', richting: 'verkoop', datum: '2026-11-05' }).status, 200);
  const u = post('bestand', { naam: 'Transactions.csv', tekst: TX_NL, bewaar: true });
  assert.strictEqual(u.body.dagboek_gekoppeld, undefined);
  const o = get().body;
  assert.strictEqual(o.dagboek[0].transactie_sleutel, null); assert.strictEqual(o.dagboek[0].richting, 'verkoop');
  assert.strictEqual(o.signalen.filter((x) => x.soort === 'dagboek').length, 2, 'de aankoopvraag blijft');
});
test('wv3756 review MOET 2: zin herhaald nadat hij aan een aankoop van later (tot +5 dagen) hing = dubbel, geen losse regel erbij', () => {
  const { m, post, get } = nieuw();
  m.gesprek({ opdracht: 'dagboek', naam: 'Voorbeeld Zorg', waarom: 'diagnostiek groeit', richting: 'koop', datum: '2026-11-04' });
  const TX = TX_EN;   // VOORBEELD ZORG op 06-11-2026
  assert.strictEqual(post('bestand', { naam: 'Transactions.csv', tekst: TX, bewaar: true }).body.dagboek_gekoppeld, 1);
  const u = m.gesprek({ opdracht: 'dagboek', naam: 'Voorbeeld Zorg', waarom: 'diagnostiek groeit', richting: 'koop', datum: '2026-11-04' });
  assert.strictEqual(u.status, 409); assert.strictEqual(u.body.dubbel, true);
  assert.strictEqual(get().body.dagboek.length, 1);
});
test('wv3756 migratie: bestaande databank zonder kolom richting krijgt hem bij openen', () => {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'beleggen-'));
  const pad = path.join(map, 'b', 'beleggen.sqlite');
  fs.mkdirSync(path.dirname(pad), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(pad);
  db.exec("CREATE TABLE dagboek (id INTEGER PRIMARY KEY AUTOINCREMENT, transactie_sleutel TEXT UNIQUE, datum TEXT NOT NULL, naam TEXT NOT NULL, waarom TEXT, blijven TEXT, verkoop_wanneer TEXT, terugblik6 TEXT, terugblik12 TEXT, op TEXT NOT NULL, bijgewerkt TEXT NOT NULL); INSERT INTO dagboek (datum, naam, waarom, op, bijgewerkt) VALUES ('2026-11-01', 'Oud', 'x', 'o', 'o');");
  db.close();
  const m = B.maak({ dbPad: pad, vaultSchrijf: () => {}, vandaag: () => '2026-11-12' });
  const u = m.app({ methode: 'GET', pad: '/app/beleggen' });
  assert.strictEqual(u.status, 200); assert.strictEqual(u.body.dagboek.length, 1); assert.strictEqual(u.body.dagboek[0].richting, null);
});

// wv3927 (Fable-review financien M5 / C50): de lezer op Davids echte portefeuille-export (23-11; hier met VERZONNEN namen, ISIN's en bedragen)
// en twee soorten regels die hij overslaat met een telling in plaats van het hele bestand te weigeren.
const ECHT_PORT = [
  'Product,Symbool/ISIN,Aantal,Slotkoers,Lokale waarde,,Waarde in EUR',
  'CASH & CASH FUND & FTX CASH (EUR),,,,EUR,"123,45","123,45"',
  'VOORBEELD ROBOT CORP,XX0000000044,7,"40,10",USD,"280,70","255,41"',
].join('\n') + '\n';
test('wv3927 echte portefeuille-vorm: valuta → getal in "Lokale waarde,,", slotkoers zonder valuta, komma; 0 overgeslagen', () => {
  const l = B.leesBestand(ECHT_PORT);
  assert.deepStrictEqual([l.soort, l.decimaal, l.rijen.length, l.overgeslagen.length], ['portefeuille', ',', 2, 0]);
  const e = l.rijen.find((r) => r.regelsoort === 'effect');
  assert.deepStrictEqual([e.isin, e.aantal, e.koers, e.valuta, e.lokaal_cent, e.waarde_eur_cent], ['XX0000000044', '7', '40.10', 'USD', 28070, 25541]);
  assert.deepStrictEqual(l.rijen.find((r) => r.regelsoort === 'cash').waarde_eur_cent, 12345);
  // de vorm uit de review (valuta en bedrag in één cel, punt tussen komma's) blijft geweigerd
  weigert(ECHT_PORT.replace('USD,"280,70"', '"USD 280.70",'), /./);
});
test('wv3927 transactie met koers nul en verder alleen nullen (claim, omwisseling) = overslaan en tellen; met geld blijft weigeren', () => {
  const kop = ECHT_TX.split('\n')[0], rs = ECHT_TX.trim().split('\n').slice(1);
  const nul = '09-11-2026,08:00,VOORBEELD CLAIM,XX0000000066,EAM,XAMS,6,"0,0000",EUR,"0,00",EUR,"0,00",,,,"0,00",';
  const l = B.leesBestand([kop, rs[0], nul, rs[1]].join('\n') + '\n');
  assert.deepStrictEqual([l.rijen.length, l.overgeslagen], [2, [{ regel: 3, reden: 'koers nul' }]]);
  weigert([kop, nul.replace(',,,"0,00",', ',,"-1,00","-1,00",')].join('\n'), /koers moet groter dan nul/);   // kosten erbij = geld
  weigert([kop, nul.replace('EUR,"0,00",EUR,"0,00"', 'EUR,"-5,00",EUR,"-5,00"')].join('\n'), /koers moet groter dan nul|lokale waarde/);
  // elk bedrag apart niet nul (lokale waarde, waarde, totaal, AutoFX) = geen nulregel, dus weigeren
  weigert([kop, nul.replace('EUR,"0,00",EUR,"0,00"', 'EUR,"-5,00",EUR,"0,00"')].join('\n'), /koers moet groter dan nul/);
  weigert([kop, nul.replace('EUR,"0,00",EUR,"0,00"', 'EUR,"0,00",EUR,"-5,00"')].join('\n'), /koers moet groter dan nul/);
  weigert([kop, nul.replace(',,,"0,00",', ',,,"-5,00",')].join('\n'), /koers moet groter dan nul/);
  weigert([kop, nul.replace(',,,"0,00",', ',"-0,50",,"-0,50",')].join('\n'), /koers moet groter dan nul/);
  weigert([kop, nul.replace(',,,"0,00",', ',,"-1,00","0,00",')].join('\n'), /koers moet groter dan nul/);   // kosten, totaal nul
  weigert([kop, nul.replace(',,,"0,00",', ',"-0,50",,"0,00",')].join('\n'), /koers moet groter dan nul/);   // AutoFX, totaal nul
  assert.strictEqual(B.leesBestand(ECHT_TX).overgeslagen.length, 0);
});
test('wv3927 rekeningoverzicht: vervolgregel zonder datum, tijd en geld = overslaan en tellen; zonder datum mét geld blijft weigeren', () => {
  const [kop, ...rs] = ECHT_REK.trim().split('\n');
  const verv = ',,,,,"vervolg van de omschrijving",,,,,,';
  const l = B.leesBestand([kop, rs[0], verv, ...rs.slice(1)].join('\n') + '\n');
  assert.deepStrictEqual([l.rijen.length, l.overgeslagen], [7, [{ regel: 3, reden: 'vervolgregel' }]]);
  weigert([kop, rs[0], ',,,,,"vervolg",,EUR,"1,00",EUR,"1,00",', ...rs.slice(1)].join('\n'), /datum/);
  weigert([kop, rs[0], '10-11-2026,,,,,"vervolg",,,,,,', ...rs.slice(1)].join('\n'), /tijd/);
  weigert([kop, ',,,,,"vervolg","1,1172",,,,,', ...rs].join('\n'), /datum/);   // FX zonder datum = geen vervolgregel
  weigert([kop, rs[0], ',15:45,,,,"vervolg",,,,,,', ...rs.slice(1)].join('\n'), /datum/);   // tijd zonder datum
  weigert([kop, rs[0], ',,,,,"vervolg",,EUR,"1,00",,,', ...rs.slice(1)].join('\n'), /datum/);   // alleen mutatie
  weigert([kop, rs[0], ',,,,,"vervolg",,,,EUR,"1,00",', ...rs.slice(1)].join('\n'), /datum/);   // alleen saldo
  weigert([kop, rs[0], ',,,,,"vervolg",,,"1,00",,,', ...rs.slice(1)].join('\n'), /datum/);   // alleen het getal van de mutatie (partnerkolom)
});
test('wv3927 route: niet_meegenomen en de regelnummers in het antwoord; stand uit de echte portefeuille-vorm', () => {
  const { post, get } = nieuw();
  const [kop, ...rs] = ECHT_REK.trim().split('\n');
  let u = post('bestand', { naam: 'Account.csv', tekst: [kop, rs[0], ',,,,,vervolg,,,,,,', ...rs.slice(1)].join('\n') + '\n', bewaar: true });
  assert.deepStrictEqual([u.status, u.body.rijen, u.body.niet_meegenomen, u.body.niet_meegenomen_regels], [200, 7, 1, [3]]);
  u = post('bestand', { naam: 'Portfolio.csv', tekst: ECHT_PORT, bewaar: true, datum: '2026-11-20' });
  assert.deepStrictEqual([u.status, u.body.effecten, u.body.niet_meegenomen], [200, 1, 0]);
  const s = get().body.stand;
  assert.deepStrictEqual([s.bron, s.verdeling.belegd_cent, s.verdeling.cash_cent], ['bestand', 25541, 12345]);
});
