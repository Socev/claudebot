'use strict';
// wv3755 (besluiten nr 906 = L06, nr 907 = L07, nr 911 = L11): opbouwfase met doelbedrag, "Past dit?" vóór een aankoop en je eigen woorden bij
// een flinke daling — op VERZONNEN gegevens (geen echte namen, ISIN's of bedragen).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../beleggen.js');

const PORT = [
  'Product,Symbool/ISIN,Aantal,Slotkoers,Lokale waarde,,Waarde in EUR',
  'CASH & CASH FUND & FTX CASH (EUR),,,,EUR,"2000,00","2000,00"',
  'VOORBEELD CHIPS INC,XX0000000011,3,"55,00",USD,"165,00","152,07"',
].join('\n') + '\n';
const TX = [
  'Datum,Tijd,Product,ISIN,Beurs,Uitvoeringsplaats,Aantal,Koers,,Lokale waarde,,Waarde,,Wisselkoers,Transactiekosten en/of,,Totaal,,Order ID',
  '05-11-2026,15:31,VOORBEELD CHIPS INC,XX0000000011,NDQ,XNAS,3,"100,00",USD,"-300,00",USD,"-276,50",EUR,"1,0850","-2,00",EUR,"-278,50",EUR,aaaa0000-0000-0000-0000-000000000001',
].join('\r\n') + '\r\n';

const P = (sleutel, euro) => ({ sleutel, regelsoort: 'effect', naam: sleutel.toUpperCase(), isin: null, aantal: '1', valuta: 'EUR', waarde_eur_cent: euro * 100, bron: 'hand' });
function data(regels, posities, soorten, extra) {
  return Object.assign({ antwoorden: {}, regels, posities, soorten, transacties: [], dagboek: [], volglijst: [], keuzes: {}, stand_datum: '2026-11-20', stand_bron: 'hand' }, extra || {});
}
const L = (k) => Object.fromEntries(k.lampjes.map((l) => [l.sleutel, l]));

test('L07 plan: doelbedrag in hele euro (50.000, € 12.500,50, 50000) en de dalingsdrempel in %, met controle', () => {
  assert.strictEqual(B.regelsUit(4, { doel_euro: '50.000' }).doel_euro, 50000);
  assert.strictEqual(B.regelsUit(4, { doel_euro: '€ 12.500,50' }).doel_euro, 12501);
  assert.strictEqual(B.regelsUit(4, { doel_euro: '50000' }).doel_euro, 50000);
  assert.strictEqual(B.regelsUit(4, { doel_euro: '' }).doel_euro, null);
  for (const fout of ['veel', '-5', '0', '1.2.3']) assert.throws(() => B.regelsUit(4, { doel_euro: fout }), /bedrag in euro/, fout);
  assert.strictEqual(B.regelsUit(6, { daling_pct: '25' }).daling_pct, 25);
  assert.strictEqual(B.regelsUit(6, {}).daling_pct, null);
  assert.throws(() => B.regelsUit(6, { daling_pct: '0' }), /minstens 1 %/);
});

test('L07 opbouwfase: één positie = 100 % (oranje); met een doel meet het maximum tegen het doel (groen); voorbij het doel weer gewoon', () => {
  const R = { max_aandeel: 20, max_thema: 40 };
  const pos = [P('a', 5000)];
  const zonder = B.bereken(data(R, pos, { a: 'tech' }), '2026-11-21');
  assert.strictEqual(L(zonder).max_aandeel.lamp, 'oranje'); assert.strictEqual(L(zonder).max_thema.lamp, 'oranje');
  assert.strictEqual(zonder.opbouw, null);
  assert.strictEqual(zonder.signalen.filter((s) => s.soort === 'boven_maximum').length, 2);
  const met = B.bereken(data(Object.assign({ doel_euro: 50000 }, R), pos, { a: 'tech' }), '2026-11-21');
  assert.strictEqual(L(met).max_aandeel.lamp, 'groen'); assert.strictEqual(L(met).max_thema.lamp, 'groen');
  assert.match(L(met).max_aandeel.grens, /20 % van je doel/); assert.match(L(met).max_aandeel.stand, /^10 % van je doel/);
  assert.match(L(met).max_aandeel.uitleg, /Opbouwfase: je hebt 10 % van je doel van € 50\.000 belegd/);
  assert.deepStrictEqual(met.opbouw, { doel_cent: 5000000, belegd_cent: 500000, pct: 10, actief: true });
  assert.strictEqual(met.verdeling.tech, 100, 'de verdeling zelf blijft op wat er staat');
  assert.strictEqual(met.signalen.filter((s) => s.soort === 'boven_maximum').length, 0);
  // in de opbouwfase kan het nog steeds te veel zijn: 15.000 van 50.000 = 30 % > 20 %
  const veel = B.bereken(data(Object.assign({ doel_euro: 50000 }, R), [P('a', 15000)], { a: 'tech' }), '2026-11-21');
  assert.strictEqual(L(veel).max_aandeel.lamp, 'oranje');
  const s = veel.signalen.find((x) => x.sleutel.startsWith('max-aandeel:'));
  assert.match(s.sleutel, /:doel5000000$/, 'eigen sleutel: een eerder weggeklikt 100 %-signaal telt niet mee');
  assert.match(s.wat, /30 % van je doel van € 50\.000/);
  // doel bereikt: gewoon tegen wat er staat
  const bereikt = B.bereken(data(Object.assign({ doel_euro: 4000 }, R), pos, { a: 'tech' }), '2026-11-21');
  assert.strictEqual(bereikt.opbouw.actief, false); assert.strictEqual(L(bereikt).max_aandeel.lamp, 'oranje');
  assert.doesNotMatch(L(bereikt).max_aandeel.grens, /doel/);
});

test('L11 daling: ≥ 30 % (standaard) → signaal bovenaan met vraag 6 en "wanneer verkoop ik"; eigen drempel; Niets doen verbergt het', () => {
  const tx = [{ sleutel: 't1', datum: '2026-06-01', tijd: '10:00', naam: 'A', isin: 'XX0000000099', aantal: '1' }];
  const pos = [Object.assign(P('isin:XX0000000099', 600), { isin: 'XX0000000099', naam: 'A' }), P('b', 400)];
  const ex = { transacties: tx, daling: { 'isin:XX0000000099': { waarde_cent: 60000, aankoop_cent: 100000, datum: '2026-11-20', bron: 'koers' } },
    antwoorden: { 6: { status: 'beantwoord', tekst: 'Niets doen; ik kijk pas na een jaar weer.' } },
    dagboek: [{ id: 1, transactie_sleutel: 't1', datum: '2026-06-01', naam: 'A', waarom: 'goede zaak', verkoop_wanneer: 'als de reden weg is, niet om de koers' }] };
  const R = { max_aandeel: 80 };
  const k = B.bereken(data(R, pos, { 'isin:XX0000000099': 'tech', b: 'kern' }, ex), '2026-11-21');
  const s = k.signalen[0];
  assert.strictEqual(s.soort, 'daling', 'daling staat bovenaan');
  assert.match(s.titel, /A staat 40 % lager dan bij aankoop/);
  assert.strictEqual(s.keuzes[0], 'niets', 'Niets doen voorop');
  assert.deepStrictEqual(s.eigen, { plan6: 'Niets doen; ik kijk pas na een jaar weer.', verkoop_wanneer: 'als de reden weg is, niet om de koers', verkoop_datum: '2026-06-01' });
  assert.match(s.plan, /30 %.*standaard/);
  assert.strictEqual(s.schreef, 'goede zaak');
  assert.strictEqual(k.daling_drempel, 30); assert.strictEqual(k.daling_standaard, true);
  // eigen drempel 50 %: geen signaal; 40 %: wel, zonder "standaard"
  assert.ok(!B.bereken(data(Object.assign({ daling_pct: 50 }, R), pos, {}, ex), '2026-11-21').signalen.some((x) => x.soort === 'daling'));
  const k40 = B.bereken(data(Object.assign({ daling_pct: 40 }, R), pos, {}, ex), '2026-11-21');
  assert.match(k40.signalen.find((x) => x.soort === 'daling').plan, /vanaf 40 % daling \(vraag 6\)/);
  // 29 % = onder de standaard
  const ex2 = Object.assign({}, ex, { daling: { 'isin:XX0000000099': { waarde_cent: 71000, aankoop_cent: 100000, datum: '2026-11-20', bron: 'koers' } } });
  assert.ok(!B.bereken(data(R, pos, {}, ex2), '2026-11-21').signalen.some((x) => x.soort === 'daling'));
  // Niets doen
  const kn = B.bereken(data(R, pos, {}, Object.assign({}, ex, { keuzes: { [s.sleutel]: { keuze: 'niets', tot: null } } })), '2026-11-21');
  assert.ok(!kn.signalen.some((x) => x.soort === 'daling')); assert.strictEqual(kn.signalen_verborgen, 1);
  // zonder vraag 6 en dagboek: velden leeg, signaal blijft
  const kl = B.bereken(data(R, pos, {}, { daling: ex.daling }), '2026-11-21');
  assert.deepStrictEqual(kl.signalen.find((x) => x.soort === 'daling').eigen, { plan6: null, verkoop_wanneer: null, verkoop_datum: null });
});

function nieuw(vandaag) {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'wv3755-'));
  const dbPad = path.join(map, 'b', 'beleggen.sqlite');
  const m = B.maak({ dbPad, vaultSchrijf: () => {}, vandaag: () => vandaag });
  const post = (wat, body) => m.app({ methode: 'POST', pad: '/app/beleggen/' + wat, body });
  const get = () => m.app({ methode: 'GET', pad: '/app/beleggen' });
  return { m, post, get, dbPad };
}

test('L11 route: ingelezen portefeuille ver onder de aankoopwaarde → signaal met je eigen woorden (stand, geen dagkoers)', () => {
  const { post, get } = nieuw('2026-11-21');
  assert.strictEqual(post('bestand', { naam: 'Portfolio.csv', tekst: PORT, datum: '2026-11-20', bewaar: true }).status, 200);
  assert.strictEqual(post('bestand', { naam: 'Transactions.csv', tekst: TX, bewaar: true }).status, 200);
  assert.strictEqual(post('plan', { vraag: 6, tekst: 'Niets doen. Wakker lig ik pas bij de helft.', waarden: {} }).status, 200);
  const tx = get().body.transacties[0].sleutel;
  assert.strictEqual(post('dagboek', { transactie: tx, waarom: 'chips blijven nodig', verkoop_wanneer: 'als de vraag naar chips wegvalt' }).status, 200);
  const o = get().body;
  const s = o.signalen.find((x) => x.soort === 'daling');
  assert.ok(s, 'dalingssignaal');
  assert.strictEqual(o.signalen[0].soort, 'daling');
  assert.match(s.titel, /VOORBEELD CHIPS INC staat 45,4 % lager dan bij aankoop/);
  assert.match(s.wat, /Volgens je stand van 2026-11-20/);
  assert.strictEqual(s.eigen.plan6, 'Niets doen. Wakker lig ik pas bij de helft.');
  assert.strictEqual(s.eigen.verkoop_wanneer, 'als de vraag naar chips wegvalt');
  assert.strictEqual(o.stand.daling_drempel, 30);
  for (const p of o.stand.posities) assert.ok(!('_maat' in p) && !('_ruw' in p), 'geen hulpvelden naar buiten');
});

test('L06 Past dit?: koop ik niet, afkoeltijd, lampjes voor/na, eigen woorden, contant; bewaart niets', () => {
  const { post, get, m, dbPad } = nieuw('2026-11-21');
  post('bestand', { naam: 'Portfolio.csv', tekst: PORT, datum: '2026-11-20', bewaar: true });
  post('soort', { sleutel: 'isin:XX0000000011', soort: 'tech' });
  post('plan', { vraag: 4, tekst: 'elke maand', waarden: { doel_euro: '10.000' } });
  post('plan', { vraag: 8, tekst: 'spreiden', waarden: { max_aandeel: '25', max_thema: '50' } });
  post('plan', { vraag: 10, tekst: 'zakelijk', waarden: { koop_niet: 'Voorbeeld Verzekeraar\nVoorbeeld Apotheek' } });
  post('plan', { vraag: 13, tekst: 'twee weken', waarden: { afkoel_dagen: '14' } });
  post('volglijst', { actie: 'zet', naam: 'Voorbeeld Zorg', thema: 'health', waarom: 'ken het uit de praktijk', wanneer: 'na de studie' });
  // de volglijstregel kwam op 10-11 (verzonnen): afkoeltijd voorbij op 24-11
  m.metDb((db) => db.prepare("UPDATE volglijst SET op = '2026-11-10T09:00:00.000Z'").run(), true);
  const voorStat = fs.statSync(dbPad).mtimeMs;
  const voorO = JSON.stringify(get().body.regels) + get().body.versies.length;

  // 1. koop ik niet
  let r = post('past', { naam: 'Voorbeeld Verzekeraar NV', bedrag: '1.000', soort: 'kern' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.oordeel, 'let_op');
  assert.ok(r.body.punten.some((p) => p.lamp === 'oranje' && /koop ik niet.*Voorbeeld Verzekeraar/.test(p.tekst)));
  assert.ok(r.body.punten.some((p) => /Niet op je volglijst.*14 dagen.*2026-12-05/.test(p.tekst)), 'afkoeltijd nog niet begonnen');
  assert.match(r.body.zin, /geen advies en geen order/);

  // 2. volglijst-bedrijf: soort uit de volglijst, afkoeltijd loopt nog, eigen woorden, maxima tegen het doel (10.000)
  r = post('past', { naam: 'voorbeeld zorg', bedrag: '3000' });
  assert.strictEqual(r.body.soort, 'health'); assert.strictEqual(r.body.soort_bron, 'volglijst');
  assert.ok(r.body.punten.some((p) => p.lamp === 'oranje' && /loopt nog tot 2026-11-24/.test(p.tekst)));
  assert.deepStrictEqual(r.body.schreef.map((x) => x.tekst), ['ken het uit de praktijk', 'na de studie']);
  assert.strictEqual(r.body.opbouw.actief, true);
  const ma = r.body.regels.find((x) => x.sleutel === 'max_aandeel');
  assert.strictEqual(ma.voor.lamp, 'groen'); assert.strictEqual(ma.na.lamp, 'oranje', '3.000 van 10.000 = 30 % > 25 %');
  assert.strictEqual(r.body.aandeel_maat_na, 30);
  assert.ok(r.body.verdeling.na.health > 0 && r.body.verdeling.voor.health === 0);
  assert.deepStrictEqual(r.body.contant, { voor_cent: 200000, na_cent: -100000, genoeg: false });
  assert.ok(r.body.punten.some((p) => /Meer dan je contant/.test(p.tekst)));

  // 3. past: klein bedrag, na de afkoeltijd
  const m2 = B.maak({ dbPad, vaultSchrijf: () => {}, vandaag: () => '2026-11-25' });
  r = m2.app({ methode: 'POST', pad: '/app/beleggen/past', body: { naam: 'Voorbeeld Zorg', bedrag: 500 } });
  assert.strictEqual(r.body.oordeel, 'past', JSON.stringify(r.body.punten));
  assert.ok(r.body.punten.some((p) => p.lamp === 'groen' && /afkoeltijd van 14 dagen is voorbij/.test(p.tekst)));
  assert.ok(r.body.punten.some((p) => p.lamp === 'groen' && /niet op je lijst "koop ik niet"/.test(p.tekst)));

  // review MOET 1: centen blijven centen
  r = post('past', { naam: 'Voorbeeld Zorg', bedrag: '100,49' });
  assert.strictEqual(r.body.bedrag_cent, 10049); assert.strictEqual(r.body.contant.na_cent, 200000 - 10049);
  assert.strictEqual(r.body.verdeling.na.cash_cent, 200000 - 10049); assert.strictEqual(r.body.verdeling.voor.cash_cent, 200000);
  // 4. zonder soort: onvolledig; fouten
  r = post('past', { naam: 'Iets Nieuws', bedrag: '100' });
  assert.strictEqual(r.body.oordeel, 'let_op', 'afkoeltijd nog niet begonnen gaat voor');
  assert.ok(r.body.punten.some((p) => p.lamp === 'grijs' && /Kies een soort/.test(p.tekst)));
  r = m.app({ methode: 'POST', pad: '/app/beleggen/past', body: { naam: 'Voorbeeld Zorg', bedrag: '100' } });
  assert.strictEqual(r.body.soort, 'health');
  assert.strictEqual(post('past', { naam: '', bedrag: '100' }).status, 400);
  assert.strictEqual(post('past', { naam: 'X', bedrag: 'veel' }).status, 400);
  assert.strictEqual(post('past', { naam: 'X', bedrag: '100', soort: 'gok' }).status, 400);

  // bewaart niets
  assert.strictEqual(fs.statSync(dbPad).mtimeMs, voorStat, 'databank onaangeroerd');
  assert.strictEqual(JSON.stringify(get().body.regels) + get().body.versies.length, voorO);
});

test('L06 Past dit? zonder databank (nog nooit geopend): werkt op het plan van niemand, maakt niets aan', () => {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'wv3755-leeg-'));
  const dbPad = path.join(map, 'b', 'beleggen.sqlite');
  const m = B.maak({ dbPad, vaultSchrijf: () => {}, vandaag: () => '2026-11-21' });
  const r = m.app({ methode: 'POST', pad: '/app/beleggen/past', body: { naam: 'Voorbeeld Wereld ETF', bedrag: '1000', soort: 'kern' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.verdeling.na.kern, 100);
  assert.strictEqual(r.body.oordeel, 'onvolledig', 'review MOET 2: zonder enige grens in het plan geen "past"');
  assert.ok(r.body.punten.some((p) => /nog geen getal voor je verdeling of je maxima/.test(p.tekst)));
  assert.strictEqual(r.body.contant, null, 'geen contantregel = onbekend');
  assert.ok(!fs.existsSync(dbPad));
});

test('review MOET 2 en 3: positie zonder soort = onvolledig; contant € 0 is bekend en te weinig', () => {
  const { post } = nieuw('2026-11-21');
  const P0 = PORT.replace('"2000,00","2000,00"', '"0,00","0,00"');
  assert.strictEqual(post('bestand', { naam: 'Portfolio.csv', tekst: P0, datum: '2026-11-20', bewaar: true }).status, 200);
  post('plan', { vraag: 8, tekst: 'spreiden', waarden: { max_aandeel: '90', max_thema: '90' } });
  let r = post('past', { naam: 'Voorbeeld Wereld', bedrag: '100', soort: 'kern' });
  assert.strictEqual(r.body.oordeel, 'let_op');
  assert.deepStrictEqual(r.body.contant, { voor_cent: 0, na_cent: -10000, genoeg: false });
  // CHIPS heeft nog geen soort: zonder het contantpunt zou het "past" lijken; nu onvolledig
  const P1 = PORT.replace('"2000,00","2000,00"', '"5000,00","5000,00"');
  const t2 = nieuw('2026-11-21');
  t2.post('bestand', { naam: 'Portfolio.csv', tekst: P1, datum: '2026-11-20', bewaar: true });
  t2.post('plan', { vraag: 8, tekst: 'spreiden', waarden: { max_aandeel: '90', max_thema: '90' } });
  r = t2.post('past', { naam: 'Voorbeeld Wereld', bedrag: '100', soort: 'kern' });
  assert.strictEqual(r.body.oordeel, 'onvolledig', JSON.stringify(r.body.punten));
  t2.post('soort', { sleutel: 'isin:XX0000000011', soort: 'tech' });
  assert.strictEqual(t2.post('past', { naam: 'Voorbeeld Wereld', bedrag: '100', soort: 'kern' }).body.oordeel, 'past');
});
