'use strict';
// Toetst docplan-controle.js (wv2293, DocPlan § 8.1) op verzonnen gegevens (namen "Bram Proefsen" e.d., IBAN's NL00TEST…): de regels
// (a) dienst zonder betaling > 75 d, (b) betaling zonder dienst in de 120 d ervoor, (c) roosternaam zonder koppeling; daarna schrijf() in een
// echte facturendatabase (tijdelijke map, migratie 17): geen dubbel, wegzetten blijft dicht, vanzelf dicht, heropenen.
// wv2297: (f) factuurtoets — werkdagen uit verzonnen factuurteksten (vormen zoals gemeten op echte stukken), oordeel, signaal, behoud, migratie 18.
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
  assert.deepEqual(u.tel, { TG: { a: 2, b: 0, c: 0, beoordeeld: 5, f_klopt: 0, f_afwijkend: 0, f_onbekend: 0, f_overgeslagen: 0 }, GH: { a: 1, b: 1, c: 2, beoordeeld: 1, f_klopt: 0, f_afwijkend: 0, f_onbekend: 0, f_overgeslagen: 0 } });
  assert.deepEqual(u.behoud, []);
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
    assert.ok(D.SCHEMA_VERSIE >= 18);   // wv2316: migratie 19 (boekstuk) kwam erna
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
    assert.deepEqual(weer.toegepast, [17]);   // M17 slaat over (CHECK al op V18), M18 staat er nog
    assert.equal(weer.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'signaal'").get().sql, sql);
    D.sluit(weer);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ───────────── (f) factuurtoets (wv2297, § 4.2) — verzonnen teksten in de vormen die op echte waarnemersfacturen staan ─────────────
const T_DAGEN = `Factuurnummer: 2026-99
Factuurdatum: 31-10-2026
Hierbij stuur ik je de factuur voor de gewerkte dagen in oktober.
    1-10-2026      9:00-16:00      7      87,5     612,50
   14-10-2026      8:00-17:30    9,5      87,5     831,25
Wilt u het bedrag binnen 14 dagen na datering overmaken op NL00TEST0000000011`;
const T_TEKSTMAAND = `do 29 oktober 2026                         14 dagen
                                           Uiterlijk 12 november 2026
OMSCHRIJVING                         UREN     TARIEF       BEDRAG
do 22 oktober 2026                     9u   €85.00/u     € 781,00
vr 23 oktober 2026                    11u   €85.00/u     € 948,00
Proefzorg · KVK 00000000 · Factuur 2026-005 · do 29 oktober 2026`;
const T_ZONDERJAAR = `Factuurdatum   29-10-2026
Waarneming oktober 2026
4      zorg avond weekend                   € 87,50     € 350,00
9      Basisuren 5-10                       € 87,50     € 787,50
9      Basisuren 6-10                       € 87,50     € 787,50`;
const T_SCHUIN = `Factuurdatum                 1/nov/26
01/10/2026       9            €   83,00     waarneming                 €   747,00
01/10/2026            10      €    0,25     reiskosten incl. visites   €     2,50
22/07/2026            17      €    0,25     reiskosten incl. visites   €     4,25`;
const T_MAAND = `Factuurdatum 02-11-2026
Waarneming oktober 2026                      totaal € 1.400,00`;

test('(f) dagenUitTekst: de vormen van echte facturen, kopdatums en reiskosten niet', () => {
  assert.deepEqual(C.dagenUitTekst(T_DAGEN, '2026-10-31'), { datums: ['2026-10-01', '2026-10-14'], maanden: ['2026-10'] });   // "gewerkte dagen in oktober"
  assert.deepEqual(C.dagenUitTekst(T_TEKSTMAAND, '2026-10-29').datums, ['2026-10-22', '2026-10-23']);
  assert.deepEqual(C.dagenUitTekst(T_ZONDERJAAR, '2026-10-29'), { datums: ['2026-10-05', '2026-10-06'], maanden: ['2026-10'] });
  assert.deepEqual(C.dagenUitTekst(T_SCHUIN, '2026-11-01').datums, ['2026-10-01']);
  assert.deepEqual(C.dagenUitTekst(T_MAAND, '2026-11-02'), { datums: [], maanden: ['2026-10'] });
  assert.deepEqual(C.dagenUitTekst('', '2026-11-02'), { datums: [], maanden: [] });
  // zonder jaar over de jaargrens: 15-12 op een factuur van januari is december van het jaar ervoor
  assert.deepEqual(C.dagenUitTekst('Basisuren 15-12      € 87,50', '2027-01-05').datums, ['2026-12-15']);
  // tijden en bedragen zijn geen datum; buiten het venster (> 31 d na de factuur) telt niet
  assert.deepEqual(C.dagenUitTekst('12:15-12:45 overleg   € 10,00\n3-12-2026 dienst € 10,00', '2026-10-01').datums, []);
  // review MOET 3: een datum met punten is geen bedrag (kopregel zonder bedrag telt niet)
  assert.deepEqual(C.dagenUitTekst('Periode 01.10.2026 t/m 31.10.2026\n05.10.2026   Waarneming   8   87,50   700,00', '2026-11-01').datums, ['2026-10-05']);
});

function rooster() {
  const dagSet = new Map([['TG|oid-a', new Set(['2026-10-01', '2026-10-14', '2026-10-22'])]]);
  const md = new Map([['TG|oid-a|2026-10', 3]]);
  return { dagSet, md };
}
test('(f) factuurOordeel: klopt / afwijkend / niet te beoordelen', () => {
  const { dagSet, md } = rooster();
  const k = { pr: 'TG', obj: 'oid-a', factuurdatum: '2026-10-31' };
  assert.equal(C.factuurOordeel(k, { datums: ['2026-10-01', '2026-10-14'], maanden: [] }, dagSet, md).oordeel, 'klopt');
  const af = C.factuurOordeel(k, { datums: ['2026-10-01', '2026-10-15'], maanden: [] }, dagSet, md);
  assert.deepEqual([af.oordeel, af.vorm, af.mis, af.aantal], ['afwijkend', 'dagen', ['2026-10-15'], 2]);
  // zelfde dagen maar bij de andere praktijk gefactureerd → afwijkend (de persoon staat daar niet in het rooster)
  assert.equal(C.factuurOordeel({ pr: 'GH', obj: 'oid-a', factuurdatum: '2026-10-31' }, { datums: ['2026-10-01'], maanden: [] }, dagSet, md).oordeel, 'afwijkend');
  assert.equal(C.factuurOordeel(k, { datums: [], maanden: ['2026-10'] }, dagSet, md).oordeel, 'klopt');
  assert.deepEqual(C.factuurOordeel(k, { datums: [], maanden: ['2026-09'] }, dagSet, md), { oordeel: 'afwijkend', vorm: 'maand', maanden: ['2026-09'], dagen: 0 });
  // geen periode: factuurmaand of de maand ervoor; dagen daar = niet te beoordelen, geen dagen = afwijkend
  assert.deepEqual(C.factuurOordeel({ pr: 'TG', obj: 'oid-a', factuurdatum: '2026-11-02' }, { datums: [], maanden: [] }, dagSet, md),
    { oordeel: 'onbekend', vorm: 'factuurmaand', maanden: ['2026-10', '2026-11'], dagen: 3 });
  assert.equal(C.factuurOordeel({ pr: 'TG', obj: 'oid-a', factuurdatum: '2026-07-02' }, { datums: [], maanden: [] }, dagSet, md).oordeel, 'afwijkend');
});

function fKand(id, tekst, extra) {
  return Object.assign({ id, entiteit: 'tolgaarde', pr: 'TG', obj: 'oid-a', factuurdatum: '2026-10-31', nummer: 'P-' + id.slice(-2), incl: 144375, sha256: 'x', soort: 'pdf', tekst }, extra || {});
}
const DAGEN = [{ pr: 'TG', obj: 'oid-a', datum: '2026-10-01', dagen: 1 }, { pr: 'TG', obj: 'oid-a', datum: '2026-10-14', dagen: 0.5 },
  { pr: 'TG', obj: 'oid-a', datum: '2026-10-22', dagen: 1 }, { pr: 'TG', obj: 'oid-a', datum: '2026-10-23', dagen: 1 }];
const MAANDEN_F = MAANDEN.concat([{ pr: 'TG', obj: 'oid-a', maand: '2026-10', dagen: 3.5 }]);

test('(f) controle: een factuur die klopt geeft geen signaal; een verschoven dag wel (kruisproef); geen IBAN in de details', () => {
  const run = (fl, dagen) => C.controle({ maanden: MAANDEN_F, lijsten: [LIJST], dp: docplan(), fac: facturen(), nu: NU, dagen: dagen === undefined ? DAGEN : dagen, facturen: fl });
  const goed = run([fKand('aaaaaaaaaaaaaa01', T_DAGEN), fKand('aaaaaaaaaaaaaa02', T_TEKSTMAAND, { factuurdatum: '2026-10-29' })]);
  assert.equal(goed.signalen.filter((s) => s.soort === 'factuur_dagen_afwijkend').length, 0);
  assert.equal(goed.tel.TG.f_klopt, 2);
  const fout = run([fKand('aaaaaaaaaaaaaa01', T_DAGEN.replace('14-10-2026', '15-10-2026'))]);
  const s = fout.signalen.filter((x) => x.soort === 'factuur_dagen_afwijkend');
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].sleutel, s[0].facturen, s[0].alleen_eigenaar, s[0].details.mis, s[0].knoppen], ['factuur_dagen_afwijkend:aaaaaaaaaaaaaa01', ['aaaaaaaaaaaaaa01'], true, ['2026-10-15'], ['wegzetten']]);
  assert.ok(!/NL00TEST/.test(JSON.stringify(s[0].details)), 'geen IBAN in de details');
  assert.equal(B.signaalUitleg(s[0]), 'Op deze factuur staan 2 werkdagen; 1 daarvan staat niet in het rooster van Tolgaarde bij deze waarnemer (15-10-2026). Klopt het toch (geruild, avond- of weekenddienst), zet het dan weg met de reden.');
  // pdftotext mislukt (tekst null) of de dagen-RPC ontbreekt (dagen null): geen oordeel, het signaal blijft staan (behoud)
  assert.deepEqual(run([fKand('aaaaaaaaaaaaaa01', null)]).behoud, ['factuur_dagen_afwijkend:aaaaaaaaaaaaaa01']);
  const afk = run(Array.from({ length: 301 }, (_, i) => fKand('dddddddddddd' + String(i).padStart(4, '0'), T_DAGEN)));
  assert.deepEqual([afk.f.klaar, afk.f.afgekapt, afk.f.beoordeeld.length, afk.tel.TG.f_klopt], [true, true, 300, 300]);
  const zonder = run([fKand('aaaaaaaaaaaaaa01', T_DAGEN)], null);
  assert.deepEqual([zonder.behoud, zonder.tel.TG.f_overgeslagen], [['factuur_dagen_afwijkend:aaaaaaaaaaaaaa01'], 1]);
  // geen tekstlaag ('') en geen dagen in factuurmaand of maand ervoor → afwijkend (vorm factuurmaand)
  const leeg = run([fKand('aaaaaaaaaaaaaa03', '', { factuurdatum: '2026-05-02' })]).signalen.find((x) => x.soort === 'factuur_dagen_afwijkend');
  assert.match(B.signaalUitleg(leeg), /^Geen werkdagen of periode op de factuur gevonden; in april 2026 en mei 2026 staat deze waarnemer niet in het rooster van Tolgaarde\.$/);
});

test('(f) schrijf: signaal bij de factuur, bijwerken, behoud, vanzelf dicht; factuurKandidaten op een echte facturendatabase', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docplan-factuur-'));
  try {
    const fdb = D.open(dir);
    fdb.db.exec("INSERT INTO entiteit (sleutel, naam) VALUES ('tolgaarde', 'TG (proef)'), ('groenhouten', 'GH (proef)')");
    const ronde = (fl, dagen) => C.schrijf(fdb, D, C.controle({ maanden: MAANDEN_F, lijsten: [LIJST], dp: docplan(), fac: facturen(), nu: NU, dagen: dagen === undefined ? DAGEN : dagen, facturen: fl }),
      '2026-11-03T10:00:00.000Z');
    const fq = () => fdb.db.prepare("SELECT status, afhandeling, details FROM signaal WHERE soort = 'factuur_dagen_afwijkend'").all();
    const scheef = T_DAGEN.replace('14-10-2026', '15-10-2026');
    assert.equal(ronde([fKand('aaaaaaaaaaaaaa01', scheef)]).nieuw, 7);   // 6 van (a)(b)(c) + 1 factuur
    assert.equal(ronde([fKand('aaaaaaaaaaaaaa01', scheef)]).nieuw, 0);
    // de waarnemer stuurt geen nieuwe factuur, maar het rooster verschuift: details bijgewerkt, nog steeds één signaal
    const r2 = ronde([fKand('aaaaaaaaaaaaaa01', scheef.replace('    1-10-2026', '    2-10-2026'))]);
    assert.deepEqual([r2.nieuw, r2.bijgewerkt], [0, 1]);
    assert.deepEqual(JSON.parse(fq()[0].details).mis, ['2026-10-02', '2026-10-15']);
    // pdftotext mislukt: blijft open; dagen-RPC weg: blijft open
    assert.equal(ronde([fKand('aaaaaaaaaaaaaa01', null)]).vanzelf_dicht, 0);
    assert.equal(ronde([fKand('aaaaaaaaaaaaaa01', T_DAGEN)], null).vanzelf_dicht, 0);
    // review MOET 1: zo roept de server het aan als sb_dienst_dagen faalt (dagen null, lege facturenlijst): niets sluiten
    assert.equal(ronde([], null).vanzelf_dicht, 0);
    // review MOET 2: afgekapte lijst (meer dan FACTUUR_MAX) waarin deze factuur niet zit: niets sluiten
    const veel = Array.from({ length: 301 }, (_, i) => fKand('dddddddddddd' + String(i).padStart(4, '0'), T_DAGEN));
    assert.equal(ronde(veel).vanzelf_dicht, 0);
    assert.equal(fq()[0].status, 'open');
    // rooster bijgewerkt (of de factuur hersteld): vanzelf dicht
    assert.equal(ronde([fKand('aaaaaaaaaaaaaa01', T_DAGEN)]).vanzelf_dicht, 1);
    assert.deepEqual(fq().map((x) => [x.status, x.afhandeling]), [['afgehandeld', 'vanzelf_opgelost']]);
    // factuurKandidaten: alleen Facturen-app, vanaf 2026, niet geen_factuur/dubbel, geen creditnota, IBAN van een persoon
    fdb.db.exec("INSERT INTO leverancier (id, naam, genormaliseerd, aangemaakt_op) VALUES ('bbbbbbbbbbbbbb01', 'Proefzorg', 'proefzorg', '2026-10-01T00:00:00Z')");
    const doc = fdb.db.prepare("INSERT INTO document (id, sha256, soort, aangemaakt_op) VALUES (?, ?, 'pdf', '2026-10-01T00:00:00Z')");
    const fac = fdb.db.prepare("INSERT INTO factuur (id, document, leverancier, factuurdatum, incl, incl_eur, entiteit, status, soort, iban, aangemaakt_op, bijgewerkt_op) " +
      "VALUES (?, ?, 'bbbbbbbbbbbbbb01', ?, 1000, 1000, ?, ?, ?, ?, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')");
    const rij = (n, datum, ent, status, soort, iban) => { const id = 'cccccccccccccc' + n; doc.run(id, String(n).repeat(32)); fac.run(id, id, datum, ent, status, soort, iban); };
    rij('01', '2026-10-31', 'tolgaarde', 'te_beoordelen', 'factuur', 'NL00TEST0000000011');
    rij('02', '2026-10-31', 'groenhouten', 'geen_factuur', 'factuur', 'NL00TEST0000000011');
    rij('03', '2025-12-31', 'tolgaarde', 'te_beoordelen', 'factuur', 'NL00TEST0000000011');
    rij('04', '2026-10-31', 'tolgaarde', 'te_beoordelen', 'creditnota', 'NL00TEST0000000011');
    rij('05', '2026-10-31', 'groenhouten', 'te_beoordelen', 'factuur', 'NL00TEST0000000099');
    rij('06', '2026-09-30', 'groenhouten', 'te_beoordelen', 'factuur', 'NL00TEST0000000021');
    assert.deepEqual(C.factuurKandidaten(fdb.db, docplan()).map((k) => [k.id, k.pr, k.obj, k.soort]),
      [['cccccccccccccc01', 'TG', 'oid-a', 'pdf'], ['cccccccccccccc06', 'GH', 'oid-b', 'pdf']]);
    D.sluit(fdb);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
