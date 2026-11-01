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
