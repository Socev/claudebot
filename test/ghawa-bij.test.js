'use strict';
// wv2880: OVIS GHAWA fase 2 (bijhouden) op VERZONNEN cijfers. De naspeeltoets op het echte overdrachtsbestand en de echte bankregels staat
// buiten de repo (mk-scripts/wv2880/naspeel-bij.js). Toetst: GHAWA-bank uit Facturen (overlap, verdwenen regel, eindsaldo van een upload,
// indeling en leren, één tik), Ecobank-csv en -pdf-tekst (keten, ontdubbelen, gat, andere rekening, Triodos-export), omwisselingen koppelen,
// fondsen (status met bevestiging, termijn, log), maandronde en kaart, herinvoer geweigerd met fase-2-gegevens, interne routes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const G = require('../ghawa.js');
const B = require('../ghawa-bij.js');
const { DONOR, REK, maakFixture, vers } = require('./ghawa-fixture.js');

const NU = { nu: '2026-11-10T10:00:00.000Z' };
const REKS = { NL00: 'Current', NL99: 'Savings' };
// Facturen-regels in de vorm van leesFacturen; de fixture heeft G0001..G0004 op 'Current NL00' (150, -100, 5, -1; saldo 54)
function fac(extra, ankers) {
  const r = (id, d, c, o) => Object.assign({ id, eigen_iban: 'NL00', boekdatum: d, bedrag_centen: c, valuta: 'EUR', tegenpartij_naam: null, tegenpartij_iban: null,
    omschrijving: null, transactietype: 'TRIODOS:ET', bestand: 'up1' }, o || {});
  const regels = [r('f1', '2024-01-05', 15000, { tegenpartij_naam: DONOR, tegenpartij_iban: REK }), r('f2', '2024-02-01', -10000, { tegenpartij_iban: 'GM00' }),
    r('f3', '2025-12-01', 500, { tegenpartij_iban: 'NL01' }), r('f4', '2025-12-31', -100, { transactietype: 'TRIODOS:KN' })].concat((extra || []).map((x) => r(...x)));
  return { regels, ankers: ankers || [], spaar_upload_op: '2026-11-01T08:00:00Z' };
}
const nieuw = [['f5', '2026-01-10', 2500, { tegenpartij_naam: DONOR, tegenpartij_iban: REK, bestand: null, transactietype: 'BANKLUIS:SEPA transfer ET' }],
  ['f6', '2026-01-11', 4000, { tegenpartij_naam: 'Nieuwe Gever Jansen', tegenpartij_iban: 'NL77NIEU0000000001' }],
  ['f7', '2026-01-12', -2000, { tegenpartij_naam: 'Vreemde Winkel', tegenpartij_iban: 'NL88VREE0000000002', transactietype: 'TRIODOS:ID' }],
  ['f8', '2026-01-13', -300, { transactietype: 'TRIODOS:KN' }], ['f9', '2026-01-14', 900000, { tegenpartij_naam: 'Grote Gift', tegenpartij_iban: 'NL66GROT0000000003' }]];
function open(db) { const x = new DatabaseSync(db); B.migreer(x); return x; }

test('GHAWA-bank: nieuwe regels erbij, ingedeeld, saldo doorgerekend, tweede keer niets', () => {
  const { db } = vers(); const x = open(db);
  const u = B.bankBij(x, null, Object.assign({ facturen: fac(nieuw, [{ iban: 'NL00', tot: '2026-01-14', eind: 5400 + 2500 + 4000 - 2000 - 300 + 900000 }]), rekeningen: REKS }, NU));
  assert.deepStrictEqual([u.uitkomst, u.nieuw, u.onbekend], ['bijgewerkt', 5, 2]);
  const r = x.prepare("SELECT datum, bedrag_cent, soort, soort_door, donateur, saldo_cent FROM bankregel_ghawa WHERE herkomst = 'bank' ORDER BY volg").all();
  assert.deepStrictEqual(r.map((y) => y.soort), ['Donation (bank transfer)', 'Donation (bank transfer)', 'Unknown', 'Bank costs', 'Unknown']);
  assert.deepStrictEqual(r.map((y) => y.soort_door), ['geleerd', 'regel', 'onbekend', 'regel', 'onbekend']);
  assert.strictEqual(r[0].donateur, DONOR); assert.strictEqual(r[1].donateur, 'Nieuwe Gever Jansen');
  assert.strictEqual(r[4].saldo_cent, 5400 + 2500 + 4000 - 2000 - 300 + 900000);
  assert.deepStrictEqual(B.bankBij(x, null, Object.assign({ facturen: fac(nieuw), rekeningen: REKS }, NU)).nieuw, 0);
  x.close();
  const k = G.bereken(G.leesData(db));
  assert.strictEqual(k.aansluiting.E.verschil, 0); assert.strictEqual(k.aansluiting.E.keten_breuken, 0);
  assert.strictEqual(k.aansluiting.E.onbekend, 900000 - 2000); assert.strictEqual(k.sluit, true);
  assert.ok(k.ghawa.per_jaar.some((s) => s.soort === 'Unknown'));
});

test('GHAWA-bank: keten breekt → niets overgenomen en één signaal (overlap, anker, verdwenen regel)', () => {
  const geval = (f) => { const { db } = vers(); const x = open(db); const u = B.bankBij(x, null, Object.assign({ facturen: f, rekeningen: REKS }, NU));
    const n = x.prepare("SELECT COUNT(*) AS n FROM bankregel_ghawa WHERE herkomst = 'bank'").get().n;
    const s = x.prepare("SELECT COUNT(*) AS n FROM signaal WHERE id = 'bank' AND dicht_op IS NULL").get().n; x.close(); return [u.uitkomst, n, s]; };
  const f1 = fac(nieuw); f1.regels[2].bedrag_centen += 1;   // overlap: 5,00 werd 5,01
  assert.deepStrictEqual(geval(f1), ['geweigerd', 0, 1]);
  assert.deepStrictEqual(geval(fac(nieuw, [{ iban: 'NL00', tot: '2026-01-14', eind: 1 }])), ['geweigerd', 0, 1]);   // eindsaldo upload wijkt af
  const f3 = fac(nieuw); f3.regels.splice(1, 1);   // regel uit de overlap weg
  assert.deepStrictEqual(geval(f3), ['geweigerd', 0, 1]);
  // al overgenomen regel verdwijnt
  const { db } = vers(); const x = open(db);
  B.bankBij(x, null, Object.assign({ facturen: fac(nieuw), rekeningen: REKS }, NU));
  const f4 = fac(nieuw.slice(1));
  assert.strictEqual(B.bankBij(x, null, Object.assign({ facturen: f4, rekeningen: REKS }, NU)).uitkomst, 'geweigerd');
  // weer goed → signaal dicht
  assert.strictEqual(B.bankBij(x, null, Object.assign({ facturen: fac(nieuw), rekeningen: REKS }, NU)).uitkomst, 'niets nieuw');
  assert.strictEqual(x.prepare("SELECT COUNT(*) AS n FROM signaal WHERE dicht_op IS NULL").get().n, 0);
  x.close();
});

test('indelen: één tik, alleen bankregels, David wint bij het leren', () => {
  const { db } = vers(); const x = open(db);
  B.bankBij(x, null, Object.assign({ facturen: fac(nieuw), rekeningen: REKS }, NU));
  const id = x.prepare("SELECT id FROM bankregel_ghawa WHERE soort = 'Unknown' AND bedrag_cent = -2000").get().id;
  assert.strictEqual(B.indelen(x, id, 'Other costs', G.GHAWA_SOORTEN, NU.nu).ok, true);
  assert.strictEqual(B.indelen(x, 'G0001', 'Other costs', G.GHAWA_SOORTEN, NU.nu).status, 409);
  assert.strictEqual(B.indelen(x, id, 'Unknown', G.GHAWA_SOORTEN, NU.nu).status, 400);
  assert.strictEqual(B.indelen(x, id, 'Iets', G.GHAWA_SOORTEN, NU.nu).status, 400);
  const leer = B.leerKaart(x);
  assert.deepStrictEqual(B.deelInGhawa({ eigen_iban: 'NL00', bedrag_centen: -500, tegenpartij_iban: 'NL88VREE0000000002', transactietype: 'TRIODOS:ID' }, leer, REKS),
    { soort: 'Other costs', donateur: null, door: 'david' });
  // eigen rekening en rente
  assert.strictEqual(B.deelInGhawa({ eigen_iban: 'NL00', bedrag_centen: -500, tegenpartij_iban: 'NL99', transactietype: 'TRIODOS:ET' }, leer, REKS).soort, 'Internal transfer (current/savings)');
  assert.strictEqual(B.deelInGhawa({ eigen_iban: 'NL99', bedrag_centen: 120, tegenpartij_iban: null, transactietype: 'TRIODOS:RE' }, leer, REKS).soort, 'Interest');
  // oud rekeningnummer met punten is ook een sleutel
  assert.strictEqual(B.ibanUit('ABNANL2A 123.45.67.890'), '123.45.67.890'); assert.strictEqual(B.ibanUit('ASNBNL21 NL90ASNB0123456789'), 'NL90ASNB0123456789');
  x.close();
});

// Ecobank-csv in de vorm van de echte export (kopregels, nieuwste eerst, geen duizendtallen)
function eco(nr, munt, rijen) {
  const kop = ['Account No,' + nr, 'Account Name,ELITE CARE GROUP', 'Currency,', 'Period,From - To', 'Opening Balance,' + munt + ' 0.00', 'Closing Balance,' + munt + ' 0.00',
    'Transaction Date,Description,Reference Number,DEBIT,CREDIT,Balance'];
  return Buffer.from(kop.concat(rijen.slice().reverse().map((r) => [r[0], '"' + r[1] + '"', '"' + r[2] + '"', r[3] < 0 ? (-r[3] / 100).toFixed(2) : '', r[3] > 0 ? (r[3] / 100).toFixed(2) : '', (r[4] / 100).toFixed(2)].join(','))).join('\r\n') + '\r\n');
}
const hulp = { csvLees: G.csvLees };
test('ECG-afschrift: csv erin, ontdubbeld, ingedeeld, omwisseling gekoppeld, saldo = afschrift', () => {
  const { db } = vers(); const x = open(db);
  // fixture: GMD eindigt op 595 (22-7-2026), EUR op 39,75 (7-2-2025)
  const gmd = [['01 Aug 2026', 'B/O ELITE CARE GROUP, IFO ELITE CARE GROUP, Cheque 5', 'I61X0001AB', 80000, 139500],
    ['02 Aug 2026', 'EGM CHQ NO 00000005 PAID TO BOUWER B', 'I64CQ0002AB', -60000, 79500], ['02 Aug 2026', 'COMMISSION ON TURNOVER', 'I61COTA0001', -500, 79000],
    ['03 Aug 2026', 'B/O ELITE CARE GROUP, IFO SOLAR WINKEL, panels', 'I61X0003AB', -9000, 70000], ['03 Aug 2026', 'B/O ELITE CARE GROUP, IFO SOLAR WINKEL, panels', 'I61X0003AB', -100, 69900]];
  const eur = [['01 Aug 2026', '0001TRF b/o 1/ Stichting GHAWA iro / ROC/abc', 'TRF0001AB12', 2000, 5975], ['01 Aug 2026', 'B/O ELITE CARE GROUP, IFO ELITE CARE GROUP, Cheque 5', 'I61X0001AB', -1000, 4975],
    ['01 Aug 2026', 'B/O ELITE CARE GROUP, IFO ELITE CARE GROUP, Cheque 5', 'I61X0001AB', -5, 4970]];
  const r1 = B.ecgAfschrift(x, { naam: 'gmd.csv', bytes: eco('6240042907', 'GMD', gmd.slice(0, 3)) }, hulp, NU);
  assert.deepStrictEqual([r1.uitkomst, r1.munt, r1.nieuw], ['overgenomen', 'GMD', 3]);
  const r2 = B.ecgAfschrift(x, { naam: 'gmd2.csv', bytes: eco('6240042907', 'GMD', gmd.slice(1)) }, hulp, NU);   // overlap van twee regels
  assert.deepStrictEqual([r2.uitkomst, r2.nieuw, r2.al_bekend], ['overgenomen', 2, 2]);
  assert.strictEqual(B.ecgAfschrift(x, { naam: 'gmd2.csv', bytes: eco('6240042907', 'GMD', gmd.slice(1)) }, hulp, NU).uitkomst, 'al ingelezen');
  const r3 = B.ecgAfschrift(x, { naam: 'eur.csv', bytes: eco('6240042909', 'EUR', eur) }, hulp, NU);
  assert.deepStrictEqual([r3.uitkomst, r3.nieuw, r3.geldstromen], ['overgenomen', 3, 2]);   // omwisseling + overboeking van GHAWA
  const s = x.prepare("SELECT munt, soort, cheque FROM bankregel_ecg WHERE herkomst = 'afschrift' ORDER BY volg").all();
  assert.deepStrictEqual(s.map((y) => y.soort), ['Conversion in', 'Cheque withdrawal', 'Bank charge', 'Payment to supplier', 'Bank charge', 'Transfer in from NL', 'Conversion out', 'Bank charge']);
  assert.strictEqual(s[1].cheque, '5');
  const m = x.prepare("SELECT soort, van, eur_cent, gmd_cent FROM geldstroom WHERE herkomst = 'afschrift' ORDER BY id").all().map((y) => Object.assign({}, y));
  assert.deepStrictEqual(m, [{ soort: 'Conversion EUR to GMD', van: 'EUR 111', eur_cent: 1000, gmd_cent: 80000 }, { soort: 'Transfer to ECG', van: 'Stichting GHAWA (Triodos)', eur_cent: 2000, gmd_cent: null }]);
  x.close();
  const k = G.bereken(G.leesData(db));
  assert.strictEqual(k.ecg.gmd.saldo, 69900); assert.strictEqual(k.ecg.eur.saldo, 4970);
  assert.strictEqual(k.aansluiting.A.verschil + k.aansluiting.A.breuken, 0); assert.strictEqual(k.aansluiting.A.instelling_gelijk, true);
  assert.strictEqual(k.aansluiting.C.totaal.aantal, 2);
  assert.strictEqual(k.standen.ecg_gmd, '2026-08-03');
});

test('ECG-afschrift weigert: gat, saldo dat niet sluit, andere rekening, Triodos-export, geen export', () => {
  const { db } = vers(); const x = open(db);
  const nee = (naam, buf, re) => { const r = B.ecgAfschrift(x, { naam, bytes: buf }, hulp, NU); assert.strictEqual(r.uitkomst, 'geweigerd', naam); assert.match(r.fout, re, naam); };
  nee('gat.csv', eco('6240042907', 'GMD', [['05 Aug 2026', 'COMMISSION', 'I61C0001', -100, 49400]]), /ontbreekt een periode/);
  nee('kapot.csv', eco('6240042907', 'GMD', [['05 Aug 2026', 'COMMISSION', 'I61C0001', -100, 59400], ['06 Aug 2026', 'COMMISSION', 'I61C0002', -100, 59000]]), /sluiten niet/);
  nee('eigen.csv', eco('6240099857', 'GMD', [['05 Aug 2026', 'COMMISSION', 'I61C0001', -100, 59400]]), /andere rekening/);
  nee('triodos.csv', Buffer.from('05-08-2026,NL00TRIO0000000001,"1,00",Credit,X,,ET,y,"1,00"\n'), /Triodos-export/);
  nee('leeg.csv', Buffer.from('a,b,c\n'), /geen Ecobank-export/);
  assert.strictEqual(x.prepare("SELECT COUNT(*) AS n FROM bankregel_ecg WHERE herkomst = 'afschrift'").get().n, 0);
  assert.strictEqual(x.prepare("SELECT COUNT(*) AS n FROM signaal WHERE id = 'afschrift' AND dicht_op IS NULL").get().n, 1);
  x.close();
});

test('ECG-afschrift als pdf-tekst (pdftotext -layout, nieuwste eerst, bedrag = saldoverschil)', () => {
  const { db } = vers(); const x = open(db);
  const tekst = ['ECOBANK THE GAMBIA', 'Account Number: 6240042907   Currency: GMD', 'Opening Balance            595.00', '',
    'Date        Value Date  Description                         Reference          Debit        Credit       Balance',
    '03-AUG-26   03-AUG-26   EGM CHQ NO 6 PAID TO BOUWER B       I64CQ0006AB     1,000.00                    1,395.00',
    '            continued text of the line above',
    '01-AUG-26   01-AUG-26   PURCH OF EUR 10 AGAINST GMD 800     I61X0009AB                     800.00     2,395.00',
    '01-AUG-26   01-AUG-26   B/O ELITE CARE GROUP, IFO ELITE CARE GROUP  I61X0008AB              1,000.00     1,595.00'].join('\n');
  const r = B.ecgAfschrift(x, { naam: 'a.pdf', bytes: Buffer.from('%PDF-1.4 x') }, { csvLees: G.csvLees, pdfNaarTekst: () => ({ tekst }) }, NU);
  assert.deepStrictEqual([r.uitkomst, r.formaat, r.nieuw], ['overgenomen', 'pdf', 3]);
  const s = x.prepare("SELECT bedrag_cent, soort, cheque FROM bankregel_ecg WHERE herkomst = 'afschrift' ORDER BY volg").all();
  assert.deepStrictEqual(s.map((y) => y.bedrag_cent), [100000, 80000, -100000]);
  assert.deepStrictEqual(s.map((y) => y.soort), ['Conversion in', 'Conversion in', 'Cheque withdrawal']);
  assert.strictEqual(s[2].cheque, '6');
  // kolombedrag dat niet past bij het saldoverschil → weigeren
  const fout = tekst.replace('1,395.00', '1,394.00');
  const { db: db2 } = vers(); const y = open(db2);
  assert.strictEqual(B.ecgAfschrift(y, { naam: 'b.pdf', bytes: Buffer.from('%PDF-1.4 y') }, { csvLees: G.csvLees, pdfNaarTekst: () => ({ tekst: fout }) }, NU).uitkomst, 'geweigerd');
  x.close(); y.close();
  assert.strictEqual(B.datumEco('02 Nov 2026'), '2026-11-02'); assert.strictEqual(B.datumEco('31-FEB-26'), null); assert.strictEqual(B.centEco('1,234.5'), 123450);
});

test('fondsen: status en termijn met bevestiging en log; termijn en AFAS-geld in Vraagt aandacht', () => {
  const { db, map } = vers(); const x = open(db);
  assert.strictEqual(B.fondsZet(x, 'F02', { status: 'Received by GHAWA NL' }, NU.nu, 'app').status, 400);   // zonder bevestiging
  assert.strictEqual(B.fondsZet(x, 'F02', { status: 'Iets', bevestigd: true }, NU.nu, 'app').status, 400);
  assert.strictEqual(B.fondsZet(x, 'F02', { termijn: '2026-11-20', bevestigd: true }, NU.nu, 'app').gewijzigd, 1);
  x.close();
  const app = G.maak({ dbPad: db, bronnenMap: map, vaultMap: map, nu: () => NU.nu }).app;
  const o = app({ pad: '/app/ghawa' }).body;
  assert.ok(o.aandacht.some((a) => a.label === 'termijn' && /over 10 dagen/.test(a.titel)));
  const f = app({ pad: '/app/ghawa/fondsen' }).body;
  assert.strictEqual(f.dossiers.find((d) => d.fondsen.some((y) => y.id === 'F02')).termijn, '2026-11-20');
  const p = app({ pad: '/app/ghawa/fonds', methode: 'POST', body: { id: 'F02', status: 'Received by GHAWA NL', bevestigd: true } });
  assert.strictEqual(p.status, 200); assert.match(p.reden, /POST fonds F02/);
  const f2 = app({ pad: '/app/ghawa/fondsen' }).body;
  assert.strictEqual(f2.dossiers.find((d) => d.fondsen.some((y) => y.id === 'F02')).log.length, 2);
  assert.ok(!app({ pad: '/app/ghawa' }).body.aandacht.some((a) => a.label === 'termijn'));   // ontvangen: geen termijn meer
});

test('maandronde, kaart na 35 dagen (één per maand), routes en herinvoer', () => {
  const { db, map } = vers(); const x = open(db);
  assert.strictEqual(B.rondeZet(x, 'indelen', true, NU.nu).status, 400);
  assert.strictEqual(B.rondeZet(x, 'vragen', true, NU.nu).ok, true);
  x.close();
  let nu = '2026-11-10T10:00:00.000Z';
  const m = G.maak({ dbPad: db, bronnenMap: map, vaultMap: map, nu: () => nu });
  const r = m.app({ pad: '/app/ghawa/ronde' }).body;
  assert.deepStrictEqual(r.stappen.map((s) => s.id), ['afschriften', 'indelen', 'aansluiting', 'vragen', 'delen']);
  assert.strictEqual(r.stappen[3].klaar, true); assert.strictEqual(r.stappen[4].later, true);
  assert.strictEqual(m.maandKaart(), null);   // nog nooit een afschrift via de app: de aanleverkaart dekt dit
  const y = open(db);
  B.ecgAfschrift(y, { naam: 'g.csv', bytes: eco('6240042907', 'GMD', [['23 Jul 2026', 'COMMISSION', 'I61C0001', -100, 59400]]) }, hulp, NU); y.close();
  const k = m.maandKaart();
  assert.strictEqual(k.sleutel, 'ghawa-maandronde-2026-11'); assert.ok(k.waarom.length <= 400 && k.titel.length <= 90);
  m.kaartGezet(k.sleutel);
  assert.strictEqual(m.maandKaart(), null);   // nooit twee keer
  nu = '2026-12-02T10:00:00.000Z'; assert.strictEqual(m.maandKaart().sleutel, 'ghawa-maandronde-2026-12');
  assert.strictEqual(B.rondeKaart({ afschrift_ooit: true, ecg_gmd: '2026-11-01', ecg_eur: '2026-11-01' }, '2026-11-20T00:00:00Z'), null);   // vers: stil
  // vragen: concept voor ECG zonder Davids eigen vragen
  const v = m.app({ pad: '/app/ghawa/vragen' }).body;
  assert.match(v.concept, /^Dear Momodou/); assert.match(v.concept, /Q01/); assert.doesNotMatch(v.concept, /Q02/);
  // POST-routes en onbekend
  assert.strictEqual(m.app({ pad: '/app/ghawa/onzin', methode: 'POST', body: {} }).status, 404);
  assert.strictEqual(m.app({ pad: '/app/ghawa/afschrift', methode: 'POST', body: { bestand: '' } }).status, 400);
  const up = m.app({ pad: '/app/ghawa/afschrift', methode: 'POST', body: { naam: 'n.csv', bestand: eco('6240042907', 'GMD', [['24 Jul 2026', 'COMMISSION', 'I61C0002', -100, 59300]]).toString('base64') } });
  assert.strictEqual(up.status, 200); assert.match(up.reden, /overgenomen GMD nieuw 1/);
  // herinvoer weigert nu (bijgehouden regels) en kan alleen met forceer
  assert.throws(() => G.invoer(map, db), /bijgehouden regels/);
  G.invoer(map, db, { forceer: true });
  { const z = new DatabaseSync(db, { readOnly: true }); assert.strictEqual(z.prepare('SELECT COUNT(*) AS n FROM afschrift').get().n, 0); z.close(); }
});

test('interne routes: donateurs en indelen alleen met intern:true, nooit rekeningnummers; gedeelde routes zonder namen', () => {
  const { db, map } = vers(); const x = open(db);
  B.bankBij(x, null, Object.assign({ facturen: fac(nieuw), rekeningen: REKS }, NU)); x.close();
  const app = G.maak({ dbPad: db, bronnenMap: map, vaultMap: map, nu: () => NU.nu }).app;
  const d = app({ pad: '/app/ghawa/donateurs' }).body, i = app({ pad: '/app/ghawa/indelen' }).body;
  assert.strictEqual(d.intern, true); assert.strictEqual(i.intern, true);
  assert.ok(d.donateurs.some((y) => y.naam === DONOR && y.totaal === 17500));
  assert.strictEqual(i.onbekend.length, 2); assert.ok(i.soorten.every((s) => s.id !== 'Unknown'));
  for (const t of [JSON.stringify(d), JSON.stringify(i)]) { assert.ok(!t.includes(REK)); assert.ok(!/NL\d\d[A-Z]{4}\d{6,}/.test(t)); }
  for (const p of ['/app/ghawa', '/app/ghawa/geld', '/app/ghawa/fondsen', '/app/ghawa/ronde', '/app/ghawa/vragen']) {
    const t = JSON.stringify(app({ pad: p }).body);
    for (const n of [DONOR, 'Nieuwe Gever', 'Vreemde Winkel', 'Grote Gift', REK]) assert.ok(!t.includes(n), n + ' in ' + p);
  }
  void maakFixture; void fs; void path;
});

test('review wv2880: lege bronrekening, rekening alleen uit de pdf-kop, geldstroom volgt een latere export, herinvoer in de transactie', () => {
  // MOET 1: spaarregels overgenomen, daarna staat de spaarrekening helemaal niet meer in Facturen → geweigerd
  { const { db } = vers(); const x = open(db);
    const spaar = [['s1', '2026-02-01', 1000, { eigen_iban: 'NL99', tegenpartij_iban: 'NL00' }]];
    assert.strictEqual(B.bankBij(x, null, Object.assign({ facturen: fac(nieuw.concat(spaar)), rekeningen: REKS }, NU)).nieuw, 6);
    const r = B.bankBij(x, null, Object.assign({ facturen: fac(nieuw), rekeningen: REKS }, NU));
    assert.strictEqual(r.uitkomst, 'geweigerd'); assert.match(r.fout, /spaarrekening: 1 eerder overgenomen/); x.close(); }
  // MOET 2: kop noemt een andere rekening, een ECG-nummer staat alleen in een omschrijving → geweigerd (andere rekening)
  { const tekst = ['ECOBANK', 'Account Number: 6240099857   Currency: GMD', 'Opening Balance 595.00', '',
      '03-AUG-26   TRANSFER TO 6240042907 ELITE CARE      I64X0006AB     100.00        495.00'].join('\n');
    const r = B.leesEcgPdfTekst(tekst); assert.strictEqual(r.rekening, '6240099857');
    const { db } = vers(); const x = open(db);
    assert.match(B.ecgAfschrift(x, { naam: 'v.pdf', bytes: Buffer.from('%PDF-1.4 v') }, { csvLees: G.csvLees, pdfNaarTekst: () => ({ tekst }) }, NU).fout, /andere rekening/);
    assert.match(B.leesEcgPdfTekst(tekst.replace('Account Number: 6240099857', 'Statement')).fout, /niet in de kop/);
    assert.match(B.leesEcgPdfTekst(tekst.replace('Currency: GMD', 'Account 6240042909')).fout, /meerdere/); x.close(); }
  // MOET 3: eerst alleen de kosten van een omwisseling (lijkt de grootste), daarna de hele dag: de geldstroom krijgt het echte bedrag
  { const { db } = vers(); const x = open(db);
    B.ecgAfschrift(x, { naam: 'g.csv', bytes: eco('6240042907', 'GMD', [['01 Aug 2026', 'B/O ELITE CARE GROUP, IFO ELITE CARE GROUP, Cheque 7', 'I61X0007AB', 80000, 139500]]) }, hulp, NU);
    const fee = ['01 Aug 2026', 'B/O ELITE CARE GROUP, IFO ELITE CARE GROUP, Cheque 7', 'I61X0007AB', -5, 3970], hoofd = ['01 Aug 2026', 'B/O ELITE CARE GROUP, IFO ELITE CARE GROUP, Cheque 7', 'I61X0007AB', -1000, 2970];
    B.ecgAfschrift(x, { naam: 'e1.csv', bytes: eco('6240042909', 'EUR', [fee]) }, hulp, NU);
    assert.strictEqual(x.prepare("SELECT eur_cent FROM geldstroom WHERE herkomst = 'afschrift' AND soort LIKE 'Conversion%'").get().eur_cent, 5);
    const r = B.ecgAfschrift(x, { naam: 'e2.csv', bytes: eco('6240042909', 'EUR', [fee, hoofd]) }, hulp, NU);
    assert.deepStrictEqual([r.uitkomst, r.nieuw, r.al_bekend], ['overgenomen', 1, 1]);
    assert.deepStrictEqual(x.prepare("SELECT eur_cent, gmd_cent FROM geldstroom WHERE herkomst = 'afschrift'").all().map((y) => [y.eur_cent, y.gmd_cent]), [[1000, 80000]]);
    assert.deepStrictEqual(x.prepare("SELECT soort FROM bankregel_ecg WHERE herkomst = 'afschrift' AND munt = 'EUR' ORDER BY volg").all().map((y) => y.soort), ['Bank charge', 'Conversion out']);
    x.close(); }
  // MOET 4: de controle zit in de schrijftransactie (een open schrijver houdt de herinvoer tegen in plaats van dat die erlangs glipt)
  { const { db, map } = vers(); const x = open(db);
    B.bankBij(x, null, Object.assign({ facturen: fac(nieuw), rekeningen: REKS }, NU)); x.close();
    assert.throws(() => G.invoer(map, db), /bijgehouden regels/);
    const z = new DatabaseSync(db, { readOnly: true }); assert.strictEqual(z.prepare("SELECT COUNT(*) AS n FROM bankregel_ghawa WHERE herkomst = 'bank'").get().n, 5); z.close(); }
});
