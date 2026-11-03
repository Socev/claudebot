'use strict';
// Toetst docplan-controle.js (wv2293, DocPlan § 8.1) op verzonnen gegevens (namen "Bram Proefsen" e.d., IBAN's NL00TEST…): de regels
// (a) dienst zonder betaling > 75 d, (b) betaling zonder dienst in de 120 d ervoor, (c) roosternaam zonder koppeling; daarna schrijf() in een
// echte facturendatabase (tijdelijke map, migratie 17): geen dubbel, wegzetten blijft dicht, vanzelf dicht, heropenen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const C = require('../docplan-controle.js');
const B = require('../facturen-bank.js');
const D = require('../facturen-db.js');

const NU = Date.parse('2026-11-03T10:00:00Z');
function docplan() {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table persoon (object_id text primary key, naam text not null);
    create table rekening (iban text primary key, object_id text not null);
    create table rol (object_id text not null, praktijk text not null, primary key (object_id, praktijk));`);
  db.exec("insert into persoon values ('oid-a', 'Bram Proefsen'), ('oid-b', 'K. Verzonnen'), ('oid-d', 'Eigen Arts')");
  db.exec("insert into rekening values ('NL00TEST0000000011', 'oid-a'), ('NL00TEST0000000021', 'oid-b')");
  db.exec("insert into rol values ('oid-a', 'TG'), ('oid-b', 'TG'), ('oid-b', 'GH')");   // oid-d: geen waarneemrol (eigen arts)
  return db;
}
function facturen() {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table bank_transactie (id text primary key, entiteit text, boekdatum text, bedrag_centen integer, tegenpartij_iban text, verwijderd_op text);
    create table factuur (entiteit text, iban text, factuurdatum text, status text);
    create table factuur_archief (entiteit text, iban text, factuurdatum text, status text);`);
  const t = db.prepare('insert into bank_transactie values (?, ?, ?, ?, ?, ?)');
  t.run('t1', 'tolgaarde', '2026-03-10', -100000, 'NL00TEST0000000011', null);   // betaalt A's februari (binnen 75 d) en maart
  t.run('t2', 'tolgaarde', '2026-10-30', -5000, 'NL00TEST0000000099', null);     // onbekende rekening: bank t/m 30-10
  t.run('t3', 'groenhouten', '2026-10-30', -5000, 'NL00TEST0000000099', null);
  t.run('t4', 'groenhouten', '2026-06-15', -40000, 'NL00TEST0000000021', null);  // B bij GH: geen dienst bij GH in de 4 maanden ervoor → (b)
  t.run('t5', 'tolgaarde', '2026-05-20', -40000, 'NL00TEST0000000021', '2026-05-21T00:00:00Z');   // verwijderd: telt niet
  t.run('t6', 'tolgaarde', '2026-02-02', 7000, 'NL00TEST0000000011', null);      // bijschrijving: geen betaling
  db.exec("insert into factuur values ('tolgaarde', 'NL00TEST0000000021', '2026-10-01', 'te_beoordelen')");   // B's juli: factuur dekt (niet juni: na 13-9)
  db.exec("insert into factuur values ('tolgaarde', 'NL00TEST0000000021', '2026-06-30', 'geen_factuur')");   // telt niet
  db.exec("insert into factuur_archief values ('tolgaarde', 'NL00TEST0000000021', '2026-06-20', 'genegeerd'), ('groenhouten', 'NL00TEST0000000021', '2026-01-20', 'geen_factuur')");   // tellen niet (review MOET 2)
  return db;
}
const MAANDEN = [
  { pr: 'TG', obj: 'oid-a', maand: '2026-02', dagen: 3 }, { pr: 'TG', obj: 'oid-a', maand: '2026-03', dagen: 2 },
  { pr: 'TG', obj: 'oid-a', maand: '2026-07', dagen: 1.5 },   // geen betaling t/m 14-10 → (a)
  { pr: 'TG', obj: 'oid-a', maand: '2026-08', dagen: 4 },     // 31-8 + 75 = 14-11 > bank t/m 30-10 → nog niet beoordeelbaar
  { pr: 'TG', obj: 'oid-b', maand: '2026-06', dagen: 2 },     // B bij TG in juni: geen betaling (t5 verwijderd), factuur 'geen_factuur' → (a)
  { pr: 'TG', obj: 'oid-b', maand: '2026-07', dagen: 1 },     // gedekt door factuur
  { pr: 'TG', obj: 'oid-d', maand: '2026-05', dagen: 9 },     // geen rol → nooit (a)
  { pr: 'GH', obj: 'oid-b', maand: '2026-01', dagen: 1 },     // GH januari: te ver vóór 15-6 (120 d = 16-2) → (b) voor t4; zelf (a)
  { pr: 'TG', obj: 'oid-a', maand: '2025-12', dagen: 5 },     // vóór 2026: nooit (a)
];
const LIJST = { jaar: 2026, praktijken: [
  { code: 'TG', namen: [{ naam: 'Bram', dagen: 6.5, status: 'bevestigd' }, { naam: 'co-assistent', dagen: 2, status: 'geen' }] },
  { code: 'GH', namen: [{ naam: '2e Paasdag', dagen: 1, status: null }, { naam: 'Nieuw Iemand', dagen: 2, status: 'nieuw' }, { naam: 'Toekomst', dagen: 0, status: null }] },
] };

test('regels (a), (b), (c) op verzonnen gegevens', () => {
  const u = C.controle({ maanden: MAANDEN, lijsten: [LIJST], dp: docplan(), fac: facturen(), nu: NU });
  const per = (soort) => u.signalen.filter((s) => s.soort === soort);
  const a = per('dienst_zonder_betaling').map((s) => s.details.persoon + ' ' + s.details.praktijk + ' ' + s.details.maand).sort();
  assert.deepEqual(a, ['oid-a TG 2026-07', 'oid-b GH 2026-01', 'oid-b TG 2026-06']);
  assert.deepEqual(per('betaling_zonder_dienst').map((s) => s.transacties[0]), ['t4']);
  assert.deepEqual(per('roosternaam_zonder_koppeling').map((s) => s.naam).sort(), ['2e Paasdag', 'Nieuw Iemand']);
  assert.deepEqual(u.tel, { TG: { a: 2, b: 0, c: 0, beoordeeld: 5 }, GH: { a: 1, b: 1, c: 2, beoordeeld: 1 } });
  for (const s of u.signalen) {
    assert.equal(s.alleen_eigenaar, true);
    assert.ok(!/NL00TEST/.test(JSON.stringify(s.details)), 'geen IBAN in de details');
    assert.ok(B.signaalUitleg(s).length > 20, s.soort);
    assert.deepEqual(s.knoppen, ['wegzetten']);
  }
  // sleutels vast en uniek; (c) zonder naam in de sleutel
  assert.equal(new Set(u.signalen.map((s) => s.sleutel)).size, u.signalen.length);
  assert.ok(u.signalen.filter((s) => s.soort === 'roosternaam_zonder_koppeling').every((s) => !/Paasdag|Iemand/.test(s.sleutel)));
  assert.match(B.signaalUitleg(per('dienst_zonder_betaling').find((s) => s.details.maand === '2026-07')), /^1,5 dagen in het rooster van Tolgaarde in juli 2026; van 1 juli 2026 t\/m 14-10-2026/);
});

test('lege invoer gooit (dan schrijft de ronde niets en sluit niets)', () => {
  assert.throws(() => C.controle({ maanden: [], lijsten: [LIJST], dp: docplan(), fac: facturen(), nu: NU }), /roostermaanden/);
  assert.throws(() => C.controle({ maanden: MAANDEN, lijsten: [{ jaar: 2026, praktijken: [] }], dp: docplan(), fac: facturen(), nu: NU }), /roosternamenlijst/);
  assert.equal(C.maandenVanaf(), '2025-09-01');
  assert.deepEqual(C.jaren(Date.parse('2027-01-02T10:00:00Z')), [2026, 2027]);
});

test('schrijf: geen dubbel, wegzetten blijft dicht, vanzelf dicht en weer open, migratie 17', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docplan-controle-'));
  try {
    const fdb = D.open(dir);
    assert.equal(D.SCHEMA_VERSIE, 17);
    fdb.db.exec("INSERT INTO entiteit (sleutel, naam) VALUES ('tolgaarde', 'TG (proef)'), ('groenhouten', 'GH (proef)')");
    const ronde = (lijst) => C.schrijf(fdb, D, C.controle({ maanden: MAANDEN, lijsten: [lijst], dp: docplan(), fac: facturen(), nu: NU }), '2026-11-03T10:00:00.000Z');
    assert.deepEqual(ronde(LIJST), { nieuw: 6, vanzelf_dicht: 0, heropend: 0, open: 6 });
    assert.deepEqual(ronde(LIJST), { nieuw: 0, vanzelf_dicht: 0, heropend: 0, open: 6 });
    // David zet de feestdag weg (zelfde weg als de knop: kern + UPDATE)
    const r = fdb.db.prepare("SELECT * FROM signaal WHERE soort = 'roosternaam_zonder_koppeling' AND json_extract(details, '$.roosternaam') = '2e Paasdag'").get();
    const af = B.afhandelSignaal({ soort: r.soort, status: 'open', naam: '2e Paasdag', details: JSON.parse(r.details) }, 'wegzetten', { wie: 'eigenaar', nu: '2026-11-03T11:00:00Z', toelichting: 'feestdag, geen dienst' });
    assert.equal(af.ok, true);
    assert.match(af.signaal.les, /^Roosternaam 2e Paasdag zonder persoon weggezet: feestdag/);
    fdb.db.prepare("UPDATE signaal SET status = 'afgehandeld', afhandeling = 'wegzetten', les = ?, wie = 'eigenaar', wanneer = '2026-11-03T11:00:00Z' WHERE id = ?").run(af.signaal.les, r.id);
    assert.deepEqual(ronde(LIJST), { nieuw: 0, vanzelf_dicht: 0, heropend: 0, open: 5 });
    // de nieuwe persoon is gemaakt en gekoppeld → vanzelf dicht; daarna weer los → heropend (alleen een vanzelf gesloten signaal)
    const gekoppeld = JSON.parse(JSON.stringify(LIJST));
    gekoppeld.praktijken[1].namen[1].status = 'voorgesteld';
    gekoppeld.praktijken[1].namen[0].status = 'geen';   // ook de weggezette: blijft dicht met Davids afhandeling
    assert.deepEqual(ronde(gekoppeld), { nieuw: 0, vanzelf_dicht: 1, heropend: 0, open: 4 });
    assert.deepEqual(ronde(LIJST), { nieuw: 0, vanzelf_dicht: 0, heropend: 1, open: 5 });
    assert.equal(fdb.db.prepare("SELECT afhandeling FROM signaal WHERE id = ?").get(r.id).afhandeling, 'wegzetten');
    assert.deepEqual(fdb.db.prepare("SELECT wat, count(*) n FROM audit WHERE wie = 'docplan-controle' GROUP BY wat ORDER BY wat").all().map((x) => [x.wat, x.n]),
      [['signaal_heropend', 1], ['signaal_vanzelf_opgelost', 1]]);
    assert.equal(fdb.db.prepare("SELECT count(*) n FROM signaal WHERE alleen_eigenaar = 0").get().n, 0);
    // review MOET 1: lichte terugrol (rij 17 weg, CHECK blijft verruimd) → opnieuw openen slaat M17 over, schema gelijk
    const sql = fdb.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'signaal'").get().sql;
    fdb.db.exec('DELETE FROM schema_migratie WHERE versie = 17');
    D.sluit(fdb);
    const weer = D.open(dir);
    assert.deepEqual(weer.toegepast, [17]);
    assert.equal(weer.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'signaal'").get().sql, sql);
    D.sluit(weer);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
