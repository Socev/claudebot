'use strict';
// Toetst docplan-rekeningen.js (wv3898, DocPlan › Rekeningen) en regel (r) rekening_onbekend in docplan-controle.js op verzonnen gegevens
// ("Bram Proefsen", "Karel Verzonnen", rekeningnummers met landcode NL en bankcode TEST, geldig gemaakt met mod-97), en de proef uit het besluit:
// een rekeningwissel halverwege het jaar — vóór de wissel geen signaal, erna wel; toevoegen in het scherm zet hem op bevestigd, het totaal telt
// de betaling mee en het signaal gaat bij de volgende ronde vanzelf dicht.
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const M = require('../docplan-rekeningen.js');
const C = require('../docplan-controle.js');
const T = require('../docplan-totaal.js');

const NU = Date.parse('2026-11-01T10:00:00Z');
const EIG = { soort: 'eigenaar', ingang: 'app', wie: 'david (toets)', entiteiten: null };
const OID_A = '00000000-0000-4000-8000-00000000000a', OID_B = '00000000-0000-4000-8000-00000000000b', OID_C = '00000000-0000-4000-8000-00000000000c';
// geldig verzonnen IBAN: NL + controlecijfers + TEST + 10 cijfers
function iban(n) {
  const bban = 'TEST' + String(n).padStart(10, '0');
  const r = (bban + 'NL00').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let m = 0; for (const c of r) m = (m * 10 + Number(c)) % 97;
  return 'NL' + String(98 - m).padStart(2, '0') + bban;
}
const I1 = iban(11), I2 = iban(12), I3 = iban(21), NIEUW = iban(77), VREEMD = iban(99);

function docplan() {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table persoon (object_id text primary key, per_id text not null unique, naam text not null, pagina text not null unique, nieuw integer, entiteit_id text, cluster text, aangemaakt text);
    create table rekening (iban text primary key, object_id text not null, zekerheid text not null check (zekerheid in ('zeker','waarschijnlijk','david')), reden text, bron text not null, toegevoegd_op text not null);
    create table rol (object_id text not null, praktijk text not null, bron text, primary key (object_id, praktijk));
    create table naw (object_id text primary key, bedrijfsnaam text, achternaam text);
    create table log (id integer primary key, wanneer text not null, wat text not null, details text);`);
  const p = db.prepare("insert into persoon values (?, ?, ?, ?, 1, 'TG', ?, '2026-11-01')");
  p.run(OID_A, 'per:bram-proefsen', 'Bram Proefsen', 'x/a.md', 'c1');
  p.run(OID_B, 'per:karel-verzonnen', 'Karel Verzonnen', 'x/b.md', 'c2');
  p.run(OID_C, 'per:nooit-rekening', 'Nina Zonderrek', 'x/c.md', 'c3');
  const r = db.prepare("insert into rekening values (?, ?, ?, 'toets', 'leesproef', '2026-11-01')");
  r.run(I1, OID_A, 'waarschijnlijk');
  r.run(I3, OID_B, 'zeker');
  const l = db.prepare("insert into rol values (?, ?, 'toets')");
  l.run(OID_A, 'TG'); l.run(OID_A, 'GH'); l.run(OID_B, 'TG'); l.run(OID_C, 'GH');
  db.prepare("insert into naw values (?, 'Proefsen Waarneming BV', 'Proefsen')").run(OID_A);
  return db;
}
function facturen() {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table bank_transactie (id text primary key, entiteit text, boekdatum text, bedrag_centen integer, tegenpartij_iban text, tegenpartij_naam text, verwijderd_op text);
    create table leverancier_iban (leverancier text, iban text);
    create table factuur (id text primary key, entiteit text, leverancier text, iban text, factuurdatum text, incl integer, status text, soort text);`);
  return db;
}
let n = 0;
const tx = (fac, ent, d, c, ib, naam, weg) => fac.prepare('insert into bank_transactie values (?, ?, ?, ?, ?, ?, ?)').run('t' + (++n), ent, d, c, ib, naam, weg || null);
const app = (dp, fac) => M.maak({ openDocplan: () => dp, openDocplanRw: () => dp, openFacturen: () => ({ db: fac, sluit() {} }) });
// de verbinding mag niet echt dicht (in-memory): close overschrijven
const open = (db) => { db.close = () => {}; return db; };
const regelR = (dp, fac) => {
  const ibanVan = new Map(dp.prepare('SELECT iban, object_id FROM rekening').all().map((r) => [r.iban, r.object_id]));
  const naam = new Map(dp.prepare('SELECT object_id, naam FROM persoon').all().map((r) => [r.object_id, r.naam]));
  return C.rekeningOnbekend(dp, fac, ibanVan, naam);
};

test('ibanVorm: spaties en kleine letters weg, mod-97 verplicht', () => {
  assert.strictEqual(M.ibanVorm(I1.toLowerCase().replace(/(.{4})/g, '$1 ')), I1);
  assert.strictEqual(M.ibanVorm(I1.slice(0, -1) + (I1.slice(-1) === '1' ? '2' : '1')), null);
  assert.strictEqual(M.ibanVorm('NL00TEST0000000011'), null);
  assert.strictEqual(M.ibanVorm(''), null);
  assert.strictEqual(M.ibanVorm(12), null);
});

test('naamSleutel: accenten, hoofdletters en tekens weg; korter dan 4 letters = leeg', () => {
  assert.strictEqual(M.naamSleutel('B. Pröefsen-Waarneming'), 'bproefsenwaarneming');
  assert.strictEqual(M.naamSleutel('A B'), '');
});

test('proef rekeningwissel halverwege het jaar: vóór geen signaal, erna één; toevoegen = bevestigd, telt mee, signaal dicht', () => {
  const dp = open(docplan()), fac = facturen();
  // januari–juni op de bekende rekening
  for (const m of ['01', '02', '03', '04', '05', '06']) tx(fac, 'tolgaarde', '2026-' + m + '-15', -100000, I1, 'B. PROEFSEN');
  assert.deepStrictEqual(regelR(dp, fac), [], 'vóór de wissel: geen signaal');
  // juli–oktober op een nieuwe rekening, zelfde naam op de bank
  for (const m of ['07', '08', '09', '10']) tx(fac, 'tolgaarde', '2026-' + m + '-15', -100000, NIEUW, 'B. Proefsen');
  const s = regelR(dp, fac);
  assert.strictEqual(s.length, 1, 'na de wissel: één signaal per (persoon, rekening)');
  assert.strictEqual(s[0].soort, 'rekening_onbekend');
  assert.strictEqual(s[0].details.persoon, OID_A);
  assert.strictEqual(s[0].details.datum, '2026-07-15');
  assert.strictEqual(s[0].details.aantal, 4);
  assert.strictEqual(s[0].details.iban_eind, NIEUW.slice(-4));
  assert.ok(!JSON.stringify(s[0].details).includes(NIEUW), 'geen volledig IBAN in de signaaldetails');
  assert.strictEqual(s[0].alleen_eigenaar, true);
  // totaal telt alleen de eerste helft
  const voor = T.totaal(dp, fac, '2026', NU).praktijken.find((p) => p.code === 'TG').personen.find((p) => p.object_id === OID_A);
  assert.strictEqual(voor.af_centen, 600000);
  // het scherm toont de nieuwe rekening als kandidaat
  const a = app(dp, fac);
  const g = a.app({ methode: 'GET', pad: '/app/facturen/rekeningen', rol: EIG, primair: true, nu: NU });
  assert.strictEqual(g.status, 200);
  const pa = g.j.personen.find((p) => p.object_id === OID_A);
  assert.deepStrictEqual(pa.kandidaten.map((k) => [k.iban, k.n, k.waarom]), [[NIEUW, 4, 'naam']]);
  assert.strictEqual(pa.status, 'waarschijnlijk');
  // toevoegen
  const p = a.app({ methode: 'POST', pad: '/app/facturen/rekeningen', d: { actie: 'toevoeg', iban: NIEUW.replace(/(.{4})/g, '$1 ').trim(), object_id: OID_A }, rol: EIG, primair: true, nu: NU });
  assert.strictEqual(p.status, 200, JSON.stringify(p.j));
  const rij = dp.prepare('SELECT zekerheid, bron FROM rekening WHERE iban = ?').get(NIEUW);
  assert.strictEqual(rij.zekerheid, 'david');
  const na = T.totaal(dp, fac, '2026', NU).praktijken.find((x) => x.code === 'TG').personen.find((x) => x.object_id === OID_A);
  assert.strictEqual(na.af_centen, 1000000, 'na toevoegen telt de betaling mee in het totaal');
  assert.deepStrictEqual(regelR(dp, fac), [], 'volgende ronde: geen signaal meer (schrijf sluit hem vanzelf)');
  // bevestig de oude waarschijnlijke rekening → persoon bevestigd
  const b = a.app({ methode: 'POST', pad: '/app/facturen/rekeningen', d: { actie: 'bevestig', iban: I1, object_id: OID_A }, rol: EIG, primair: true, nu: NU });
  assert.strictEqual(b.status, 200);
  const g2 = a.app({ methode: 'GET', pad: '/app/facturen/rekeningen', rol: EIG, primair: true, nu: NU });
  const pa2 = g2.j.personen.find((x) => x.object_id === OID_A);
  assert.strictEqual(pa2.status, 'bevestigd');
  assert.deepStrictEqual(pa2.kandidaten, []);
  // log: drie acties, nooit een volledig IBAN
  const log = dp.prepare("SELECT wat, details FROM log ORDER BY id").all();
  assert.deepStrictEqual(log.map((x) => x.wat), ['rekening toevoeg (app)', 'rekening bevestig (app)']);
  assert.ok(log.every((x) => !x.details.includes(NIEUW) && !x.details.includes(I1)));
});

test('signaal via factuur: leverancier met alleen rekeningen van één persoon; ambigue leverancier niet (Codex ZOU 1)', () => {
  const dp = open(docplan()), fac = facturen();
  fac.prepare('insert into leverancier_iban values (?, ?)').run('lev-a', I1);
  fac.prepare('insert into leverancier_iban values (?, ?)').run('lev-ab', I1);
  fac.prepare('insert into leverancier_iban values (?, ?)').run('lev-ab', I3);
  const f = fac.prepare("insert into factuur values (?, 'groenhouten', ?, ?, ?, 50000, 'beoordeeld', ?)");
  f.run('f1', 'lev-a', NIEUW, '2026-09-01', 'factuur');
  f.run('f2', 'lev-ab', VREEMD, '2026-09-02', 'factuur');      // ambigu: overslaan
  f.run('f3', 'lev-a', iban(55), '2025-12-01', 'factuur');     // vóór 2026: overslaan
  f.run('f4', 'lev-a', iban(56), '2026-09-03', 'creditnota');  // geen factuur: overslaan
  const s = regelR(dp, fac);
  assert.strictEqual(s.length, 1);
  assert.deepStrictEqual([s[0].details.spoor, s[0].details.praktijk, s[0].facturen[0]], ['factuur', 'GH', 'f1']);
});

test('geen signaal: onbekende naam, gedeelde naam, bijschrijving, verwijderd, andere entiteit, korte naam', () => {
  const dp = open(docplan()), fac = facturen();
  dp.prepare("insert into rekening values (?, ?, 'zeker', 't', 't', '2026-11-01')").run(iban(31), OID_C);
  tx(fac, 'tolgaarde', '2026-02-01', -1000, I3, 'Gedeelde Naam');
  tx(fac, 'tolgaarde', '2026-02-01', -1000, iban(31), 'Gedeelde Naam');   // naam op rekeningen van twee personen = ambigu
  tx(fac, 'tolgaarde', '2026-03-01', -1000, VREEMD, 'Gedeelde Naam');
  tx(fac, 'tolgaarde', '2026-03-01', -1000, iban(41), 'Iemand Anders');
  tx(fac, 'tolgaarde', '2026-03-01', 5000, iban(42), 'Karel Verzonnen');                 // bijschrijving
  tx(fac, 'tolgaarde', '2026-03-01', -5000, iban(43), 'Karel Verzonnen', '2026-03-02');   // verwijderd
  tx(fac, 'holding', '2026-03-01', -5000, iban(44), 'Karel Verzonnen');                   // andere entiteit
  tx(fac, 'tolgaarde', '2026-03-01', -5000, iban(45), 'K.V');                             // te kort
  assert.deepStrictEqual(regelR(dp, fac), []);
  // naam = persoon.naam of NAW-bedrijfsnaam telt wel
  tx(fac, 'groenhouten', '2026-04-01', -5000, iban(46), 'PROEFSEN WAARNEMING B.V.');
  tx(fac, 'tolgaarde', '2026-04-02', -5000, iban(47), 'Karel Verzonnen');
  assert.deepStrictEqual(regelR(dp, fac).map((s) => s.details.persoon).sort(), [OID_A, OID_B].sort());
});

test('scherm: status per persoon, ontbreekt eerst, achternaam alleen als kandidaat (nooit als signaal)', () => {
  const dp = open(docplan()), fac = facturen();
  tx(fac, 'groenhouten', '2025-06-01', -7000, iban(61), 'N. Zonderrek Huisartsenzorg');
  tx(fac, 'tolgaarde', '2026-02-01', -1000, I3, 'K Verzonnen');
  const g = app(dp, fac).app({ methode: 'GET', pad: '/app/facturen/rekeningen', rol: EIG, primair: true, nu: NU });
  assert.strictEqual(g.status, 200);
  assert.deepStrictEqual(g.j.personen.map((p) => [p.naam, p.status]), [['Nina Zonderrek', 'ontbreekt'], ['Bram Proefsen', 'waarschijnlijk'], ['Karel Verzonnen', 'zeker']]);
  assert.deepStrictEqual(g.j.personen[0].kandidaten.map((k) => [k.iban, k.waarom]), [[iban(61), 'achternaam']]);
  assert.deepStrictEqual(g.j.n, { personen: 3, ontbreekt: 1, waarschijnlijk: 1, zeker: 1, bevestigd: 0, kandidaten: 1, rekeningen: 2 });
  const kb = g.j.personen[2].rekeningen[0];
  assert.deepStrictEqual(kb.dit_jaar, [{ praktijk: 'TG', n: 1, laatste: '2026-02-01' }, { praktijk: 'GH', n: 0, laatste: null }]);
  assert.deepStrictEqual(regelR(dp, fac), [], 'achternaam-kandidaat geeft geen signaal');
});

test('schrijven: rekening bij een ander = 409 met naam, weg alleen eigen rij, bevestig van onbekende = 409, ongeldig = 400', () => {
  const dp = open(docplan()), fac = facturen();
  const a = app(dp, fac);
  const post = (d) => a.app({ methode: 'POST', pad: '/app/facturen/rekeningen', d, rol: EIG, primair: true, nu: NU });
  let r = post({ actie: 'toevoeg', iban: I3, object_id: OID_A });
  assert.strictEqual(r.status, 409); assert.match(r.j.fout, /Karel Verzonnen/);
  assert.strictEqual(dp.prepare('SELECT object_id FROM rekening WHERE iban = ?').get(I3).object_id, OID_B, 'niet stil verplaatst');
  r = post({ actie: 'weg', iban: I3, object_id: OID_A });
  assert.strictEqual(r.status, 409);
  r = post({ actie: 'bevestig', iban: NIEUW, object_id: OID_A });
  assert.strictEqual(r.status, 409);
  r = post({ actie: 'weg', iban: I3, object_id: OID_B });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(dp.prepare('SELECT count(*) AS n FROM rekening WHERE iban = ?').get(I3).n, 0);
  r = post({ actie: 'toevoeg', iban: I3, object_id: OID_B });   // terugdraaien
  assert.strictEqual(r.status, 200);
  r = post({ actie: 'toevoeg', iban: I2, object_id: '00000000-0000-4000-8000-0000000000ff' });
  assert.strictEqual(r.status, 404, 'persoon moet bestaan (foreign keys staan uit)');
  assert.strictEqual(post({ actie: 'verplaats', iban: I2, object_id: OID_A }).status, 400);
  assert.strictEqual(post({ actie: 'toevoeg', iban: 'NL00TEST0000000012', object_id: OID_A }).status, 400);
  assert.strictEqual(post({ actie: 'toevoeg', iban: I2, object_id: 'oid-a' }).status, 400);
  assert.strictEqual(post(null).status, 400);
  assert.strictEqual(dp.prepare("SELECT count(*) AS n FROM log").get().n, 2, 'alleen geslaagde schrijfacties in de log');
});

test('route: alleen eigenaar via de app, alleen primair, alleen GET/POST op het pad', () => {
  const dp = open(docplan()), fac = facturen();
  const a = app(dp, fac);
  assert.strictEqual(a.app({ methode: 'GET', pad: '/app/facturen/rekeningen', rol: { soort: 'praktijkmanager', ingang: 'app' }, primair: true }).status, 403);
  assert.strictEqual(a.app({ methode: 'GET', pad: '/app/facturen/rekeningen', rol: { soort: 'eigenaar', ingang: 'fac' }, primair: true }).status, 403);
  assert.strictEqual(a.app({ methode: 'POST', pad: '/app/facturen/rekeningen', d: { actie: 'toevoeg', iban: I2, object_id: OID_A }, rol: EIG, primair: false }).status, 409);
  assert.strictEqual(a.app({ methode: 'DELETE', pad: '/app/facturen/rekeningen', rol: EIG, primair: true }).status, 404);
  assert.strictEqual(a.app({ methode: 'GET', pad: '/app/facturen/rekeningen/2026', rol: EIG, primair: true }).status, 404);
  assert.strictEqual(dp.prepare('SELECT count(*) AS n FROM rekening').get().n, 2);
  const leeg = M.maak({ openDocplan: () => null, openDocplanRw: () => null, openFacturen: () => null });
  assert.strictEqual(leeg.app({ methode: 'GET', pad: '/app/facturen/rekeningen', rol: EIG, primair: true }).j.leeg, true);
  assert.strictEqual(leeg.app({ methode: 'POST', pad: '/app/facturen/rekeningen', d: { actie: 'toevoeg', iban: I2, object_id: OID_A }, rol: EIG, primair: true }).status, 503);
});

test('geen signaal voor een persoon zonder waarneemrol (maat, David zelf); achternaam-kandidaat alleen zonder rekening', () => {
  const dp = open(docplan()), fac = facturen();
  dp.prepare("insert into persoon values (?, 'per:maat-proef', 'Maarten Maatsen', 'x/m.md', 0, 'GH', 'c9', '2026-11-01')").run('00000000-0000-4000-8000-00000000000d');
  tx(fac, 'groenhouten', '2026-02-03', -500000, iban(81), 'Maarten Maatsen');
  assert.deepStrictEqual(regelR(dp, fac), []);
  tx(fac, 'tolgaarde', '2026-02-03', -500, iban(82), 'Familie Verzonnen');   // Karel heeft al een rekening: geen kandidaat
  const g = app(dp, fac).app({ methode: 'GET', pad: '/app/facturen/rekeningen', rol: EIG, primair: true, nu: NU });
  assert.deepStrictEqual(g.j.personen.find((p) => p.object_id === OID_B).kandidaten, []);
  assert.strictEqual(g.j.personen.some((p) => p.naam === 'Maarten Maatsen'), false);
});
