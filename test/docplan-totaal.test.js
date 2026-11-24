'use strict';
// Toetst docplan-totaal.js (wv2158, Facturen › Waarnemers): de rekenregel van mk-scripts/docplan/entiteiten.py totaal op verzonnen gegevens
// (namen "Bram Proefsen" e.d., IBAN's NL00TEST…, ronde bedragen), de som tegen een losse SQL-som, en de weigeringen van de route.
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const M = require('../docplan-totaal.js');

const NU = Date.parse('2026-11-01T10:00:00Z');
const EIG = { soort: 'eigenaar', ingang: 'app', wie: 'david (toets)', entiteiten: null };

function docplan() {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table persoon (object_id text primary key, per_id text not null unique, naam text not null, pagina text not null unique, nieuw integer, entiteit_id text, cluster text, aangemaakt text);
    create table rekening (iban text primary key, object_id text not null, zekerheid text not null, reden text, bron text, toegevoegd_op text);
    create table rol (object_id text not null, praktijk text not null, bron text, primary key (object_id, praktijk));`);
  const p = db.prepare("insert into persoon values (?, ?, ?, ?, 1, 'TG', ?, '2026-11-01')");
  p.run('oid-a', 'per:bram-proefsen', 'Bram Proefsen', 'x/a.md', 'c1');
  p.run('oid-b', 'per:k-verzonnen', 'K. Verzonnen', 'x/b.md', 'c2');
  p.run('oid-c', 'per:nooit-betaald', 'Nooit Betaald', 'x/c.md', 'c3');
  const r = db.prepare("insert into rekening values (?, ?, ?, 'toets', 'toets', '2026-11-01')");
  r.run('NL00TEST0000000011', 'oid-a', 'zeker');
  r.run('NL00TEST0000000012', 'oid-a', 'waarschijnlijk');
  r.run('NL00TEST0000000021', 'oid-b', 'zeker');
  r.run('NL00TEST0000000031', 'oid-c', 'david');
  const l = db.prepare("insert into rol values (?, ?, 'toets')");
  l.run('oid-a', 'TG'); l.run('oid-a', 'GH'); l.run('oid-b', 'TG');
  return db;
}
function facturen() {
  const db = new DatabaseSync(':memory:');
  db.exec('create table bank_transactie (id text primary key, entiteit text, boekdatum text, bedrag_centen integer, tegenpartij_iban text, verwijderd_op text)');
  const t = db.prepare('insert into bank_transactie values (?, ?, ?, ?, ?, ?)');
  let n = 0;
  const tx = (ent, d, c, iban, weg) => t.run('t' + (++n), ent, d, c, iban, weg || null);
  tx('tolgaarde', '2026-02-01', -100000, 'NL00TEST0000000011');
  tx('tolgaarde', '2026-03-01', -50000, 'NL00TEST0000000012');
  tx('tolgaarde', '2026-03-05', 20000, 'NL00TEST0000000011');           // bijschrijving: apart, niet aftrekken
  tx('tolgaarde', '2026-04-01', -99900, 'NL00TEST0000000011', '2026-04-02T00:00:00Z');   // verwijderd: telt niet
  tx('tolgaarde', '2025-12-31', -70000, 'NL00TEST0000000011');           // vorig jaar
  tx('groenhouten', '2026-05-01', -30000, 'NL00TEST0000000011');
  tx('holding', '2026-05-02', -40000, 'NL00TEST0000000011');             // andere entiteit: telt niet
  tx('tolgaarde', '2026-06-01', -200000, 'NL00TEST0000000021');
  tx('tolgaarde', '2026-06-02', -12300, 'NL00TEST0000000099');           // onbekende rekening
  tx('tolgaarde', '2026-10-30', -1000, 'NL00TEST0000000098');             // laatste bankdag Tolgaarde
  tx('groenhouten', '2026-10-29', -1000, 'NL00TEST0000000098', '2026-10-31T00:00:00Z');   // verwijderd: geen bankdag
  tx('groenhouten', '2026-10-28', -1000, 'NL00TEST0000000098');
  return db;
}

test('rekenregel: alleen afschrijvingen van TG/GH in het jaar, niet verwijderd; bijschrijvingen apart', () => {
  const j = M.totaal(docplan(), facturen(), '2026', NU);
  const tg = j.praktijken.find((p) => p.code === 'TG'), gh = j.praktijken.find((p) => p.code === 'GH');
  assert.deepStrictEqual(tg.personen.map((p) => p.naam), ['K. Verzonnen', 'Bram Proefsen']);   // hoogste totaal eerst
  const a = tg.personen[1];
  assert.strictEqual(a.af_centen, 150000); assert.strictEqual(a.af_n, 2); assert.strictEqual(a.laatste, '2026-03-01');
  assert.strictEqual(a.terug_centen, 20000); assert.strictEqual(a.terug_n, 1);
  assert.strictEqual(a.koppeling, 'waarschijnlijk');   // zwakste van zijn rekeningen
  assert.strictEqual(a.rol, true);
  assert.strictEqual(a.betalingen.length, 3);
  assert.strictEqual(tg.som_centen, 350000); assert.strictEqual(tg.af_n, 3); assert.strictEqual(tg.terug_centen, 20000);
  assert.strictEqual(tg.tm_bankdag, '2026-10-30'); assert.strictEqual(gh.tm_bankdag, '2026-10-28');
  assert.strictEqual(gh.personen.length, 1); assert.strictEqual(gh.som_centen, 30000);
  assert.strictEqual(gh.personen[0].koppeling, 'zeker');
  assert.strictEqual(gh.personen[0].rol, true);
  assert.ok(!JSON.stringify(j).includes('NL00TEST0000000099'), 'onbekende rekening niet in het antwoord');
  assert.ok(!JSON.stringify(j).includes('Nooit Betaald'), 'persoon zonder betaling in het jaar niet in de lijst');
  assert.deepStrictEqual(j.jaren, ['2026']);
});

test('som per praktijk = losse SQL-som over bank_transactie', () => {
  const dp = docplan(), fac = facturen();
  const j = M.totaal(dp, fac, '2026', NU);
  const ibans = dp.prepare('select iban from rekening').all().map((r) => r.iban);
  for (const [ent, code] of [['tolgaarde', 'TG'], ['groenhouten', 'GH']]) {
    const s = fac.prepare("select coalesce(-sum(bedrag_centen), 0) AS s from bank_transactie where verwijderd_op is null and entiteit = ? and bedrag_centen < 0 and boekdatum like '2026%' and tegenpartij_iban in ("
      + ibans.map(() => '?').join(',') + ')').get(ent, ...ibans).s;
    assert.strictEqual(j.praktijken.find((p) => p.code === code).som_centen, Number(s), code);
  }
});

test('vorig jaar apart op te vragen; zonder rekeningen een lege lijst', () => {
  assert.strictEqual(M.totaal(docplan(), facturen(), '2025', NU).praktijken[0].som_centen, 70000);
  const leeg = docplan(); leeg.exec('delete from rekening');
  const j = M.totaal(leeg, facturen(), '2026', NU);
  assert.ok(j.praktijken.every((p) => p.personen.length === 0 && p.som_centen === 0));
  assert.deepStrictEqual(M.totaal(docplan(), facturen(), '2027', Date.parse('2027-01-15T10:00:00Z')).jaren, ['2026', '2027']);
});

function route(extra) {
  const dicht = { dp: 0, fac: 0 };
  const o = Object.assign({
    openDocplan: () => { const d = docplan(); const c = d.close.bind(d); d.close = () => { dicht.dp++; c(); }; return d; },
    openFacturen: () => { const f = facturen(); return { db: f, sluit: () => { dicht.fac++; f.close(); } }; },
  }, extra || {});
  return { r: M.maak(o), dicht };
}

test('route: eigenaar krijgt het overzicht, beide verbindingen weer dicht', () => {
  const { r, dicht } = route();
  const x = r.app({ methode: 'GET', pad: '/app/facturen/waarnemers', rol: EIG, primair: true, nu: NU });
  assert.strictEqual(x.status, 200); assert.strictEqual(x.j.ok, true); assert.strictEqual(x.j.jaar, '2026');
  assert.deepStrictEqual(dicht, { dp: 1, fac: 1 });
  assert.ok(!/Proefsen|NL00|\d{4,}/.test(x.reden.replace('2026', '')), 'reden zonder naam, rekening of bedrag');
  assert.strictEqual(r.app({ methode: 'GET', pad: '/app/facturen/waarnemers/2025', rol: EIG, primair: true, nu: NU }).j.praktijken[0].som_centen, 70000);
});

test('route: 403 zonder eigenaarssessie (praktijkmanager, geen rol, andere ingang)', () => {
  const { r, dicht } = route();
  for (const rol of [null, { soort: 'praktijkmanager', ingang: 'fac', entiteiten: ['tolgaarde'] }, { soort: 'eigenaar', ingang: 'fac' }, {}]) {
    const x = r.app({ methode: 'GET', pad: '/app/facturen/waarnemers', rol, primair: true, nu: NU });
    assert.strictEqual(x.status, 403, JSON.stringify(rol)); assert.strictEqual(x.j.ok, false);
    assert.ok(!('praktijken' in x.j));
  }
  assert.deepStrictEqual(dicht, { dp: 0, fac: 0 }, 'geen databank geopend bij een weigering');
});

test('route: 404 POST en andere paden, 409 niet primair, 400 jaar buiten bereik', () => {
  const { r } = route();
  const v = (o) => r.app(Object.assign({ methode: 'GET', pad: '/app/facturen/waarnemers', rol: EIG, primair: true, nu: NU }, o)).status;
  assert.strictEqual(v({ methode: 'POST' }), 404);
  assert.strictEqual(v({ pad: '/app/facturen/waarnemers/x' }), 404);
  assert.strictEqual(v({ pad: '/app/facturen/waarnemersx' }), 404);
  assert.strictEqual(v({ primair: false }), 409);
  assert.strictEqual(v({ primair: undefined }), 409);
  assert.strictEqual(v({ pad: '/app/facturen/waarnemers/2019' }), 400);
  assert.strictEqual(v({ pad: '/app/facturen/waarnemers/2027' }), 400);
});

test('route: geen docplan-bestand = lege lijst; kapotte databank = 503 zonder inhoud, verbinding dicht', () => {
  assert.deepStrictEqual(route({ openDocplan: () => null }).r.app({ methode: 'GET', pad: '/app/facturen/waarnemers', rol: EIG, primair: true, nu: NU }).j,
    { ok: true, leeg: true, jaar: '2026', praktijken: [], jaren: ['2026'] });
  const fouten = [];
  const { r, dicht } = route({ openFacturen: () => { throw new Error('kapot'); }, fout: (w, e) => fouten.push(w + ':' + e.message) });
  const x = r.app({ methode: 'GET', pad: '/app/facturen/waarnemers', rol: EIG, primair: true, nu: NU });
  assert.strictEqual(x.status, 503); assert.deepStrictEqual(Object.keys(x.j).sort(), ['fout', 'ok']);
  assert.deepStrictEqual(fouten, ['waarnemers:kapot']); assert.strictEqual(dicht.dp, 1);
  assert.strictEqual(route({ openFacturen: () => null }).r.app({ methode: 'GET', pad: '/app/facturen/waarnemers', rol: EIG, primair: true, nu: NU }).status, 503);
});

// ── wv4011 (actieplan 2B43): betalingen uit een betaalbestand (SEPA-batch). Verzonnen gegevens; vorm van bankregel en kenmerk zoals gemeten
// 25-11-2026 (één afschrijving per betaalopdracht-blok, zonder tegenrekening, kenmerk = pmtinf_id).
function sepaFac() {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table bank_transactie (id text primary key, entiteit text, rekening text, boekdatum text, bedrag_centen integer, tegenpartij_iban text,
      kenmerk text, omschrijving text, verwijderd_op text);
    create table sepa_batch (id text primary key, rekening text, entiteit text, msg_id text, cre_dt_tm text, aantal integer, totaal_centen integer);
    create table sepa_regel (id integer primary key, batch text, pmtinf_id text, positie integer, uitvoerdatum text, centen integer, iban text);`);
  let n = 0;
  const t = db.prepare('insert into bank_transactie values (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const tx = (ent, d, c, iban, o) => { o = o || {}; const id = 't' + (++n); t.run(id, ent, o.rek || 'rek-' + ent, d, c, iban, o.kenmerk || null, o.oms || null, o.weg || null); return id; };
  const b = db.prepare('insert into sepa_batch values (?, ?, ?, ?, ?, ?, ?)');
  const r = db.prepare('insert into sepa_regel (batch, pmtinf_id, positie, uitvoerdatum, centen, iban) values (?, ?, ?, ?, ?, ?)');
  const batch = (id, ent, cre, regels, o) => {
    o = o || {};
    b.run(id, 'rek-' + ent, ent, 'SOCEV-TEST-' + id, cre + 'T10:00:00', o.aantal || regels.length, o.totaal || regels.reduce((s, x) => s + x[3], 0));
    regels.forEach((x, i) => r.run(id, x[0], i + 1, x[1], x[3], x[2]));
  };
  return { db, tx, batch };
}
const A1 = 'NL00TEST0000000011', B1 = 'NL00TEST0000000021';
const tgA = (j) => j.praktijken.find((p) => p.code === 'TG').personen.find((p) => p.object_id === 'oid-a');

test('wv4011 vaste toets: drie betalingen, twee in een batch met één bankregel — vóór een derde, erna het volle bedrag', () => {
  const f = sepaFac();
  f.tx('tolgaarde', '2026-10-01', -30000, A1);                                                       // losse betaling
  f.tx('tolgaarde', '2026-11-02', -60000, null, { kenmerk: 'SOCEV-TEST-b1-1' });                       // batchregel: twee betalingen
  f.tx('tolgaarde', '2026-11-20', -1000, 'NL00TEST0000000098');                                       // bankdag
  const voor = M.totaal(docplan(), f.db, '2026', NU, null);                                          // zoals vóór wv4011: geen batch
  assert.strictEqual(tgA(voor).af_centen, 30000, 'vóór: een derde van het bedrag');
  f.batch('b1', 'tolgaarde', '2026-11-02', [['SOCEV-TEST-b1-1', '2026-11-02', A1, 30000], ['SOCEV-TEST-b1-1', '2026-11-02', A1, 30000]]);
  const na = M.totaal(docplan(), f.db, '2026', NU);
  const a = tgA(na);
  assert.strictEqual(a.af_centen, 90000, 'erna: het volle bedrag'); assert.strictEqual(a.af_n, 3); assert.strictEqual(a.batch_n, 2);
  assert.strictEqual(a.laatste, '2026-11-02', 'datum = boekdatum van de batchregel');
  assert.deepStrictEqual(a.betalingen.map((x) => x.bron), ['betaalbestand', 'betaalbestand', 'bank']);
  assert.strictEqual(na.praktijken.find((p) => p.code === 'TG').batch_n, 2);
  // som tegen een losse som: bank + bestand = 3 × 30000
  assert.strictEqual(na.praktijken.find((p) => p.code === 'TG').som_centen, 90000);
});

test('wv4011: batch zonder bankregel (nog niet uitgevoerd) telt niet, staat in "niet"', () => {
  const f = sepaFac();
  f.batch('b2', 'tolgaarde', '2026-11-20', [['SOCEV-TEST-b2-1', '2026-11-26', A1, 40000], ['SOCEV-TEST-b2-1', '2026-11-26', B1, 50000]]);
  const s = M.sepaBetalingen(f.db, [A1, B1]);
  assert.strictEqual(s.geteld.length, 0);
  assert.deepStrictEqual(s.niet.map((x) => [x.iban, x.centen, x.uitvoerdatum]), [[A1, 40000, '2026-11-26'], [B1, 50000, '2026-11-26']]);
  assert.strictEqual(M.totaal(docplan(), f.db, '2026', NU).praktijken.find((p) => p.code === 'TG').som_centen, 0);
});

test('wv4011: batch plus dezelfde betaling los op de bank telt één keer', () => {
  const f = sepaFac();
  f.batch('b3', 'tolgaarde', '2026-11-05', [['SOCEV-TEST-b3-1', '2026-11-05', A1, 25000], ['SOCEV-TEST-b3-1', '2026-11-05', B1, 35000]]);
  f.tx('tolgaarde', '2026-11-05', -60000, null, { oms: 'SEPA BatchReferentie: SOCEV-TEST-b3-1Aantal opdrachten: 2' });   // bankluis-vorm
  f.tx('tolgaarde', '2026-11-06', -25000, A1);                                                       // zelfde betaling ook los
  f.tx('tolgaarde', '2026-03-06', -35000, B1);                                                       // vaste maandbetaling maanden eerder: géén dekking
  const j = M.totaal(docplan(), f.db, '2026', NU);
  const tg = j.praktijken.find((p) => p.code === 'TG');
  assert.strictEqual(tgA(j).af_centen, 25000); assert.strictEqual(tgA(j).af_n, 1); assert.strictEqual(tgA(j).batch_n, 0);
  const b = tg.personen.find((p) => p.object_id === 'oid-b');
  assert.strictEqual(b.af_centen, 70000, 'maart los + november uit de batch'); assert.strictEqual(b.batch_n, 1);
});

test('wv4011: geen telling bij ander kenmerk ("-1" is geen "-10"), andere som, onvolledige batch, verwijderde of te vroege bankregel', () => {
  const f = sepaFac();
  f.batch('c1', 'tolgaarde', '2026-11-02', [['SOCEV-TEST-c1-1', '2026-11-02', A1, 10000], ['SOCEV-TEST-c1-1', '2026-11-02', A1, 10000]]);
  f.tx('tolgaarde', '2026-11-02', -20000, null, { kenmerk: 'SOCEV-TEST-c1-10' });
  f.batch('c2', 'tolgaarde', '2026-11-02', [['SOCEV-TEST-c2-1', '2026-11-02', A1, 11000], ['SOCEV-TEST-c2-1', '2026-11-02', A1, 11000]]);
  f.tx('tolgaarde', '2026-11-02', -22100, null, { kenmerk: 'SOCEV-TEST-c2-1' });                       // som klopt niet
  f.batch('c3', 'tolgaarde', '2026-11-02', [['SOCEV-TEST-c3-1', '2026-11-02', A1, 12000], ['SOCEV-TEST-c3-1', '2026-11-02', A1, 12000]], { aantal: 3, totaal: 36000 });
  f.tx('tolgaarde', '2026-11-02', -24000, null, { kenmerk: 'SOCEV-TEST-c3-1' });                       // batch niet heel
  f.batch('c4', 'tolgaarde', '2026-11-02', [['SOCEV-TEST-c4-1', '2026-11-02', A1, 13000], ['SOCEV-TEST-c4-1', '2026-11-02', A1, 13000]]);
  f.tx('tolgaarde', '2026-11-02', -26000, null, { kenmerk: 'SOCEV-TEST-c4-1', weg: '2026-11-03T00:00:00Z' });   // verwijderd
  f.batch('c5', 'tolgaarde', '2026-11-02', [['SOCEV-TEST-c5-1', '2026-11-02', A1, 14000], ['SOCEV-TEST-c5-1', '2026-11-02', A1, 14000]]);
  f.tx('tolgaarde', '2026-10-20', -28000, null, { kenmerk: 'SOCEV-TEST-c5-1' });                       // vóór het bestand bestond
  f.batch('c6', 'groenhouten', '2026-11-02', [['SOCEV-TEST-c6-1', '2026-11-02', A1, 15000], ['SOCEV-TEST-c6-1', '2026-11-02', A1, 15000]]);
  f.tx('groenhouten', '2026-11-02', -30000, null, { kenmerk: 'SOCEV-TEST-c6-1', rek: 'rek-andere' });   // andere rekening
  const s = M.sepaBetalingen(f.db, [A1, B1]);
  assert.strictEqual(s.geteld.length, 0);
  assert.strictEqual(s.niet.length, 12);
  assert.strictEqual(M.totaal(docplan(), f.db, '2026', NU).praktijken.reduce((x, p) => x + p.som_centen, 0), 0);
});

test('wv4011: bank voert de batch vóór de uitvoerdatum uit; jaar = boekdatum; elke batchregel hoort bij één blok; geen sepa-tabellen = null', () => {
  const f = sepaFac();
  f.batch('d1', 'tolgaarde', '2026-10-30', [['SOCEV-TEST-d1-1', '2026-11-12', A1, 20000], ['SOCEV-TEST-d1-1', '2026-11-12', B1, 20000],
    ['SOCEV-TEST-d1-2', '2026-11-27', A1, 5000], ['SOCEV-TEST-d1-2', '2026-11-27', A1, 5000]]);
  f.tx('tolgaarde', '2026-10-30', -40000, null, { kenmerk: 'SOCEV-TEST-d1-1' });
  f.batch('d2', 'tolgaarde', '2026-12-30', [['SOCEV-TEST-d2-1', '2026-12-31', A1, 7000], ['SOCEV-TEST-d2-1', '2026-12-31', A1, 7000]]);
  f.tx('tolgaarde', '2027-01-04', -14000, null, { kenmerk: 'SOCEV-TEST-d2-1' });
  const s = M.sepaBetalingen(f.db, [A1, B1]);
  assert.deepStrictEqual(s.geteld.map((x) => x.boekdatum), ['2026-10-30', '2026-10-30', '2027-01-04', '2027-01-04']);
  assert.strictEqual(s.niet.length, 2, 'blok 2 van d1 staat (nog) niet op de bank');
  assert.strictEqual(tgA(M.totaal(docplan(), f.db, '2026', Date.parse('2027-01-10T10:00:00Z'))).af_centen, 20000);
  assert.strictEqual(tgA(M.totaal(docplan(), f.db, '2027', Date.parse('2027-01-10T10:00:00Z'))).af_centen, 14000);
  assert.strictEqual(M.sepaBetalingen(facturen(), [A1]), null, 'oud bestand zonder sepa-tabellen: niet vast te stellen');
  assert.strictEqual(tgA(M.totaal(docplan(), facturen(), '2026', NU)).af_centen, 150000, 'zonder sepa-tabellen blijft de gewone rekenregel');
});

test('wv4011 review MOET 1: een oud, niet uitgevoerd bestand verbruikt niet de losse regel die een later uitgevoerd bestand ontdubbelt', () => {
  const f = sepaFac();
  f.batch('e1', 'tolgaarde', '2026-11-01', [['SOCEV-TEST-e1-1', '2026-11-03', A1, 45000], ['SOCEV-TEST-e1-1', '2026-11-03', B1, 1000]]);   // eerste versie, nooit uitgevoerd
  f.batch('e2', 'tolgaarde', '2026-11-02', [['SOCEV-TEST-e2-1', '2026-11-03', A1, 45000], ['SOCEV-TEST-e2-1', '2026-11-03', B1, 1000]]);   // opnieuw gemaakt, uitgevoerd
  f.tx('tolgaarde', '2026-11-03', -46000, null, { kenmerk: 'SOCEV-TEST-e2-1' });
  f.tx('tolgaarde', '2026-11-04', -45000, A1);                                                       // dezelfde betaling ook los op de bank
  const j = M.totaal(docplan(), f.db, '2026', NU);
  assert.strictEqual(tgA(j).af_centen, 45000, 'één keer, niet twee keer');
  assert.strictEqual(tgA(j).af_n, 1);
});

test('wv4011 review ronde 2: twee afgeschreven blokken in omgekeerde volgorde geboekt, elk met een losse kopie: elk één keer', () => {
  const f = sepaFac();
  f.batch('g1', 'tolgaarde', '2026-11-01', [['SOCEV-TEST-g1-1', '2026-11-10', A1, 33000], ['SOCEV-TEST-g1-1', '2026-11-10', B1, 1000]]);   // eerst gemaakt, 10-11 geboekt
  f.batch('g2', 'tolgaarde', '2026-11-02', [['SOCEV-TEST-g2-1', '2026-11-03', A1, 33000], ['SOCEV-TEST-g2-1', '2026-11-03', B1, 2000]]);   // later gemaakt, 3-11 geboekt
  f.tx('tolgaarde', '2026-11-10', -34000, null, { kenmerk: 'SOCEV-TEST-g1-1' });
  f.tx('tolgaarde', '2026-11-03', -35000, null, { kenmerk: 'SOCEV-TEST-g2-1' });
  f.tx('tolgaarde', '2026-11-05', -33000, A1);
  f.tx('tolgaarde', '2026-11-10', -33000, A1);
  assert.strictEqual(tgA(M.totaal(docplan(), f.db, '2026', NU)).af_centen, 66000, 'twee betalingen, elk één keer');
});

test('wv4011 review ronde 3: batches op 5 en 10 november, losse kopieën op 1 en 6 november: twee betalingen, niet drie', () => {
  const f = sepaFac();
  f.batch('h1', 'tolgaarde', '2026-10-30', [['SOCEV-TEST-h1-1', '2026-11-05', A1, 21000], ['SOCEV-TEST-h1-1', '2026-11-05', B1, 1000]]);
  f.batch('h2', 'tolgaarde', '2026-10-30', [['SOCEV-TEST-h2-1', '2026-11-10', A1, 21000], ['SOCEV-TEST-h2-1', '2026-11-10', B1, 2000]]);
  f.tx('tolgaarde', '2026-11-05', -22000, null, { kenmerk: 'SOCEV-TEST-h1-1' });
  f.tx('tolgaarde', '2026-11-10', -23000, null, { kenmerk: 'SOCEV-TEST-h2-1' });
  f.tx('tolgaarde', '2026-11-01', -21000, A1);
  f.tx('tolgaarde', '2026-11-06', -21000, A1);
  assert.strictEqual(tgA(M.totaal(docplan(), f.db, '2026', NU)).af_centen, 42000);
});
