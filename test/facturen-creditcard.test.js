'use strict';
// Toetsen voor wv2043: de creditcard (ICS) als bron in de Facturen-app (facturen-creditcard.js, migratie 13, tools/facturen-creditcard.js,
// leesroute opdracht creditcard). Alles verzonnen (de repo is openbaar): klantnummer 99990000001, kaart …0000, IBAN met een laag ABN-nummer,
// "Wolkdienst", "Proefbureau Ireland Limited", ronde bedragen. Raakt /opt/data/facturen, de kluis, mail en de vault niet (alles in TMPDIR).
// Draaien: bash test/facturen-creditcard.sh
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'facturen-db.js'));
const F = require(path.join(ROOT, 'facturen.js'));
const C = require(path.join(ROOT, 'facturen-creditcard.js'));
const { ibanFromAbnAccount } = require(path.join(ROOT, 'mt940-lezer.js'));

const NU = Date.parse('2026-10-30T12:00:00Z');
const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
const KLANT = '99990000001';
const TG = ibanFromAbnAccount('0000000041');
const ANDER = ibanFromAbnAccount('0000000042');

const KOP = 'Transactiedatum;Boekingsdatum;Omschrijving;Naam Card-houder;Card nummer;Debit/Credit;Bedrag;Merchant categorie;Land;Valuta;Bedrag in oorspronkelijke valuta;Type transactie;WalletProvider;Merchant categorie code;Maand/jaar rekeningoverzicht';
// r = [transactiedatum, boekdatum, omschrijving, kaart, D/C, bedrag, valuta, orig, type, maand]
const land = (oms) => { const m = / ([A-Z]{3})$/.exec(oms); return m ? m[1] : ''; };
const rij = (r) => [r[0], r[1], r[2], '"Proef, P"', r[3], r[4], r[5], 'Computer Software Stores', land(r[2]), r[6], r[7], r[8], '', '5734', r[9]].join(';');
const csv = (rijen) => Buffer.from('﻿' + KOP + '\n' + rijen.map(rij).join('\n') + '\n', 'utf8');

// Drie overzichten: 2026-01 (begint vóór het bestand), 2026-02 (sluit), 2026-03 (incasso geweigerd + herincasso, sluit), 2026-04 (verschil), 2026-05 open
const BASIS = [
  ['02-01-2026', '03-01-2026', 'WOLKDIENST SAN FRANCISCO USA', '****0000', 'D', '10,00', 'USD', '11,00', 'Transaction', '202601'],
  ['08-01-2026', '08-01-2026', 'GEINCASSEERD VORIG SALDO', '', 'C', '-110,00', 'EUR', '-110,00', 'Payment', '202602'],
  ['10-01-2026', '11-01-2026', 'WOLKDIENST SAN FRANCISCO USA', '****0000', 'D', '5,00', 'USD', '5,50', 'Transaction', '202602'],
  ['10-01-2026', '11-01-2026', 'WOLKDIENST SAN FRANCISCO USA', '****0000', 'D', '5,00', 'USD', '5,50', 'Transaction', '202602'],
  ['15-01-2026', '16-01-2026', 'PROEFBUREAU* ABONNEMENT DUBLIN 4 IRL', '****0000', 'D', '1.200,00', 'EUR', '1.200,00', 'Transaction', '202602'],
  ['20-01-2026', '21-01-2026', 'WINKELTJE PARIS FRA', '****0000', 'C', '-10,00', 'EUR', '-10,00', 'Transaction', '202602'],
  ['09-02-2026', '09-02-2026', 'GEINCASSEERD VORIG SALDO', '', 'C', '-1.200,00', 'EUR', '-1.200,00', 'Payment', '202603'],
  ['12-02-2026', '13-02-2026', 'PROEFBUREAU SAN FRANCISCO USA', '****0000', 'D', '30,00', 'USD', '33,00', 'Transaction', '202603'],
  ['24-02-2026', '24-02-2026', 'JAARBIJDRAGE CARD', '', 'D', '43,00', 'EUR', '43,00', 'Transaction', '202603'],
  ['08-03-2026', '08-03-2026', 'GEINCASSEERD VORIG SALDO', '', 'C', '-73,00', 'EUR', '-73,00', 'Payment', '202604'],
  ['08-03-2026', '08-03-2026', 'GEWEIGERDE INCASSO', '', 'D', '73,00', 'EUR', '73,00', 'Payment', '202604'],
  ['14-03-2026', '14-03-2026', 'HER-INCASSO', '', 'C', '-73,00', 'EUR', '-73,00', 'Payment', '202604'],
  ['15-03-2026', '16-03-2026', 'WOLKDIENST SAN FRANCISCO USA', '****0000', 'D', '20,00', 'USD', '22,00', 'Transaction', '202604'],
  ['15-04-2026', '16-04-2026', 'WOLKDIENST SAN FRANCISCO USA', '****0000', 'D', '7,00', 'USD', '7,70', 'Transaction', '202605'],
  ['20-04-2026', '20-04-2026', 'MICROSOFT PAYMENTS     DUBLIN        IRL', '****0000', 'C', '0,00', 'EUR', '0,00', 'Authorization', ''],
];

function opzet() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-creditcard-'));
  WEG.push(dir);
  const fdb = D.open(path.join(dir, 'db'));
  const ids = {};
  D.transactie(fdb, () => {
    for (const [s, n] of [['tolgaarde', 'Huisartsenpraktijk Proef B.V.'], ['groenhouten', 'Proefpraktijk Twee'], ['prive', 'Privé']]) D.voegToe(fdb, 'entiteit', { sleutel: s, naam: n });
    ids.rek = D.nieuwId(); ids.ander = D.nieuwId();
    D.voegToe(fdb, 'rekening', { id: ids.rek, entiteit: 'tolgaarde', iban: TG, bank: 'ABN', bank_formaat: 'abn_tab', controle: 1, alleen_eigenaar: 0 });
    D.voegToe(fdb, 'rekening', { id: ids.ander, entiteit: 'groenhouten', iban: ANDER, bank: 'ABN', bank_formaat: 'abn_tab', controle: 1, alleen_eigenaar: 0 });
    for (const [k, naam] of [['wolk', 'Wolkdienst'], ['pbIe', 'Proefbureau Ireland Limited'], ['pbUs', 'Proefbureau, PBC'], ['win', 'Winkel Groothandel B.V.']]) {
      ids[k] = D.nieuwId();
      D.voegToe(fdb, 'leverancier', { id: ids[k], naam, genormaliseerd: require(path.join(ROOT, 'facturen-kern.js')).normNaam(naam), aangemaakt_op: '2026-01-01T00:00:00Z' });
    }
    ids.bestand = D.nieuwId();
    D.voegToe(fdb, 'bank_bestand', { id: ids.bestand, sha256: 'a'.repeat(64), formaat: 'abn_tab', naam: 'proef.TAB', geupload_door: 'toets', geupload_op: '2026-10-01T00:00:00Z' });
    // FV2-archief: Wolkdienst 22,00 met 'EUR' bij het dollarbedrag (zoals FV2 dat deed)
    ids.arch = D.nieuwId();
    D.voegToe(fdb, 'factuur_archief', { id: ids.arch, herkomst: 'fv2', extern_id: 'x1', entiteit: 'tolgaarde', leverancier_naam: 'Wolkdienst', factuurdatum: '2026-03-15', incl: 2200, valuta: 'EUR', aangemaakt_op: '2026-04-01T00:00:00Z' });
  });
  let n = 0;
  const bank = (rek, iban, datum, centen, oms, extra) => fdb.db.prepare('INSERT INTO bank_transactie (id, bestand, rekening, entiteit, eigen_iban, boekdatum, bedrag_centen, tegenpartij_naam, omschrijving, is_incasso, entry_ref, formaat, aangemaakt_op) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, \'abn_tab\', ?)')
    .run('e' + String(++n).padStart(15, '0'), ids.bestand, rek, rek === ids.rek ? 'tolgaarde' : 'groenhouten', iban, datum, centen, (extra && extra.naam) || 'INT CARD SERVICES', oms, 'ref' + n, '2026-10-01T00:00:00Z');
  const oms = (m) => 'Incasso ' + m + ' betreffende uw creditcard ICS-klantnummer ' + KLANT;
  bank(ids.rek, TG, '2026-01-07', -11000, oms('jan 2026'));
  bank(ids.rek, TG, '2026-02-08', -120000, oms('feb 2026'));
  bank(ids.rek, TG, '2026-03-07', -7300, oms('mrt 2026'));
  bank(ids.rek, TG, '2026-03-07', 7300, '/RTYP/SEPA Incasso correctieboeking/NAME/INT CARD SERVICES/MARF/E0' + KLANT + '001/REMI/' + oms('mrt 2026'));
  bank(ids.rek, TG, '2026-03-13', -7300, oms('mrt 2026'));
  bank(ids.rek, TG, '2026-04-07', -2100, oms('apr 2026'));   // 1 euro minder dan de kaart: verschil
  bank(ids.rek, TG, '2025-12-08', -5000, oms('dec 2025'));   // vóór het bestand
  bank(ids.ander, ANDER, '2026-02-08', -999, oms('feb 2026'));   // andere rekening: telt niet
  bank(ids.rek, TG, '2026-02-10', -5000, 'factuur 12', { naam: 'Winkel Groothandel BV' });   // een gewone bankbetaling aan Winkel
  return { dir, fdb, ids };
}

// ───────────────────────────── lezer ─────────────────────────────

test('lezer: kop, BOM, bedragen, soorten, overzicht; Naam Card-houder niet bewaard', () => {
  const g = C.leesIcsCsv(csv(BASIS));
  assert.equal(g.regels.length, BASIS.length);
  assert.deepEqual(g.aantallen, { transactie: 9, betaling: 5, autorisatie: 1 });
  assert.deepEqual(g.periode, { van: '2026-01-02', tot: '2026-04-20' });
  const pb = g.regels[4];
  assert.equal(pb.bedrag_centen, 120000); assert.equal(pb.overzicht, '2026-02'); assert.equal(pb.laatste4, '0000');
  assert.equal(g.regels[5].bedrag_centen, -1000);
  assert.equal(g.regels[0].valuta_orig, 'USD'); assert.equal(g.regels[0].bedrag_orig_centen, 1100);
  assert.equal(g.regels[14].soort, 'autorisatie'); assert.equal(g.regels[14].overzicht, null);
  assert.equal(g.regels[1].laatste4, null);
  for (const r of g.regels) assert.ok(!Object.values(r).some((v) => String(v).includes('Proef, P')), 'kaarthouder niet bewaard');
});

test('lezer weigert het hele bestand: kop, kaartnummer, lange cijferreeks, debet met min, datum, valuta', () => {
  const fout = (rijen, code, tekst) => assert.throws(() => C.leesIcsCsv(tekst || csv(rijen)), (e) => e instanceof C.KaartFout && e.code === code);
  fout(null, 'formaat', Buffer.from(KOP.replace('Bedrag;', 'Saldo;') + '\n'));
  fout(null, 'leeg', Buffer.from(''));
  const r = BASIS[0].slice();
  fout([Object.assign(r.slice(), { 3: '4111111111111111' })], 'kaartnummer');
  fout([Object.assign(r.slice(), { 3: '12340000' })], 'kaartnummer');
  fout([Object.assign(r.slice(), { 2: 'WOLKDIENST 4111 1111 1111 1111 USA' })], 'kaartnummer');
  assert.equal(C.leesIcsCsv(csv([Object.assign(r.slice(), { 2: 'WEBWINKEL ORDER 123-1234567-1234567 USA' })])).regels.length, 1, 'ordernummer zonder Luhn houdt niets tegen');
  fout([Object.assign(r.slice(), { 2: 'WEBWINKEL 4111-1111-1111-1111 USA' })], 'kaartnummer');
  fout([Object.assign(r.slice(), { 5: '-10,00' })], 'regel');
  fout([Object.assign(r.slice(), { 0: '2026-01-02' })], 'regel');
  fout([Object.assign(r.slice(), { 5: '10.00' })], 'regel');
  fout([Object.assign(r.slice(), { 8: 'Refund' })], 'regel');
  fout([Object.assign(r.slice(), { 9: '' })], 'regel');
  fout([Object.assign(r.slice(), { 6: 'EUR', 7: '11,00' })], 'regel');
});

test('sleutels: deterministisch, twee gelijke regels zijn twee regels', () => {
  const g = C.leesIcsCsv(csv(BASIS));
  const a = C.sleutels('0123456789abcdef', g.regels), b = C.sleutels('0123456789abcdef', g.regels);
  assert.deepEqual(a.map((x) => x.sleutel), b.map((x) => x.sleutel));
  assert.equal(new Set(a.map((x) => x.sleutel)).size, a.length);
  assert.notEqual(a[2].sleutel, a[3].sleutel);
  assert.notEqual(C.sleutels('fedcba9876543210', g.regels)[0].sleutel, a[0].sleutel, 'andere kaart, andere sleutel');
});

test('handelaar en leverancier: eerste woord, alias, land beslist, onzeker = geen', () => {
  assert.equal(C.handelaar('PROEFBUREAU* ABONNEMENT DUBLIN 4 IRL', 'transactie'), 'PROEFBUREAU');
  assert.equal(C.handelaar('IE TAB EXTENSION KIRKLAND USA', 'transactie'), 'IE TAB');
  assert.equal(C.handelaar('CLAUDE.AI SUBSCRIPTION SAN FRANCISCO USA', 'transactie'), 'ANTHROPIC');
  assert.equal(C.handelaar('JAARBIJDRAGE CARD', 'transactie'), 'ICS');
  assert.equal(C.handelaar('HER-INCASSO', 'betaling'), 'ICS');
  const L = ['Proefbureau Ireland Limited', 'Proefbureau, PBC', 'Een Twee Drie', 'Abcd Efghij', 'Bakkerij Proefmans', 'Van der Proef', 'Wolk Dienst EMEA', 'Anthropic, PBC']
    .map((naam, i) => ({ id: 'l' + i, naam }));
  const z = (oms, land) => { const r = { omschrijving: oms, land, handelaar: C.handelaar(oms, 'transactie') }; return C.zoekLeverancier(r, L).leverancier; };
  assert.equal(z('PROEFBUREAU* ABONNEMENT DUBLIN 4 IRL', 'IRL').id, 'l0');
  assert.equal(z('PROEFBUREAU SAN FRANCISCO USA', 'USA').id, 'l1');
  assert.equal(z('PROEFBUREAU PARIS FRA', 'FRA'), null, 'twee kandidaten zonder beslissend land');
  assert.equal(z('ABCDEFGHIJ.IO NEW YORK USA', 'USA').id, 'l3', 'aaneen geschreven (≥ 8)');
  assert.equal(z('WOLK*DIENST 7R4KW8 CC WOLK.COM IRL', 'IRL').id, 'l6', 'kern zonder afdeling (EMEA)');
  assert.equal(z('CLAUDE.AI SUBSCRIPTION SAN FRANCISCO USA', 'USA').id, 'l7', 'alias');
  // diffreview MOET 1: een los algemeen eerste woord of een tussenvoegsel is geen leverancier
  assert.equal(z('BAKKERIJ JANSEN UTRECHT NLD', 'NLD'), null);
  assert.equal(z('VAN DER VALK HOTEL UTRECHT NLD', 'NLD'), null);
  assert.equal(z('EEN WINKEL NLD', 'NLD'), null, 'kort woord alleen telt niet');
});

// ───────────────────────────── database ─────────────────────────────

test('inlezen: idempotent, bron bewaard, koppelen, aansluiting op de cent, tweede bestand alleen nieuw', () => {
  const t = opzet();
  assert.equal(t.fdb.schema, D.SCHEMA_VERSIE);
  const k = C.kaartZet(t.fdb, { klantnummer: KLANT, laatste4: '0000', rekening: TG.slice(-4), naam: 'ICS proef', wie: 'toets', nu: NU });
  assert.equal(C.kaartZet(t.fdb, { klantnummer: KLANT, laatste4: '0000', rekening: TG.slice(-4), wie: 'toets', nu: NU }).al_bekend, true);
  const bytes = csv(BASIS);
  const droog = C.inlezen(t.fdb, '0000', bytes, { droog: true, wie: 'toets', nu: NU });
  assert.equal(droog.nieuw, BASIS.length);
  assert.equal(t.fdb.db.prepare('SELECT count(*) AS n FROM kaart_regel').get().n, 0, 'droog schrijft niets');
  assert.equal(D.bronBestaat(t.fdb, D.sha256(bytes)), false);
  const u = C.inlezen(t.fdb, '0000', bytes, { wie: 'toets', nu: NU, naam: 'ics.csv' });
  assert.equal(u.nieuw, BASIS.length);
  assert.ok(D.bronBestaat(t.fdb, D.sha256(bytes)), 'ruwe bestand in bankbron/');
  assert.equal(u.koppeling.incasso_nieuw, 7, 'zes op de kaartrekening (dec–apr) + geen van de andere rekening of de gewone betaling');
  const nog = C.inlezen(t.fdb, '0000', bytes, { wie: 'toets', nu: NU });
  assert.equal(nog.al_bekend, true); assert.equal(nog.nieuw, 0);
  // tweede bestand: dezelfde regels vanaf februari + één nieuwe in mei (andere sha256)
  const tweede = csv(BASIS.slice(6).concat([['01-05-2026', '02-05-2026', 'WOLKDIENST SAN FRANCISCO USA', '****0000', 'D', '3,00', 'USD', '3,30', 'Transaction', '202605']]));
  const u2 = C.inlezen(t.fdb, '0000', tweede, { wie: 'toets', nu: NU });
  // nieuw: de regel van mei + de autorisatie (hoort bij het bestand waarin hij staat, diffreview ZOU 2)
  assert.equal(u2.al_bekend, false); assert.equal(u2.nieuw, 2); assert.equal(u2.al_bekend_regels, BASIS.length - 6 - 1);
  assert.equal(t.fdb.db.prepare("SELECT count(*) AS n FROM kaart_regel WHERE soort <> 'autorisatie'").get().n, BASIS.length - 1 + 1, '0 dubbel');
  // aansluiting
  const a = Object.fromEntries(C.aansluitingDb(t.fdb, C.kaartVan(t.fdb, '0000')).map((x) => [x.overzicht, x]));
  assert.equal(a['2025-12'].status, 'buiten_bestand');
  assert.equal(a['2026-01'].status, 'onvolledig_begin'); assert.equal(a['2026-01'].bank_centen, 11000); assert.equal(a['2026-01'].ics_betaald_centen, 11000);
  assert.equal(a['2026-02'].status, 'sluit'); assert.equal(a['2026-02'].transacties_centen, 120000); assert.equal(a['2026-02'].ics_bank_gelijk, true);
  assert.equal(a['2026-03'].status, 'sluit'); assert.equal(a['2026-03'].bankregels, 3); assert.equal(a['2026-03'].bank_centen, 7300, 'incasso + storno + herincasso = één keer');
  assert.equal(a['2026-04'].status, 'verschil'); assert.equal(a['2026-04'].verschil_centen, 100);
  assert.equal(a['2026-05'].status, 'nog_niet_geincasseerd'); assert.equal(a['2026-05'].transacties_centen, 1000);
  // herkenning: leverancier (land), factuur uit het archief (dollarbedrag met EUR), betalingen zonder leverancier
  const r = (oms, dag) => t.fdb.db.prepare('SELECT * FROM kaart_regel WHERE omschrijving = ? AND transactiedatum = ?').get(oms, dag);
  assert.equal(r('PROEFBUREAU* ABONNEMENT DUBLIN 4 IRL', '2026-01-15').leverancier, t.ids.pbIe);
  assert.equal(r('PROEFBUREAU SAN FRANCISCO USA', '2026-02-12').leverancier, t.ids.pbUs);
  assert.equal(r('WOLKDIENST SAN FRANCISCO USA', '2026-03-15').factuur_archief, t.ids.arch);
  assert.equal(r('WOLKDIENST SAN FRANCISCO USA', '2026-01-02').factuur_archief, null);
  assert.equal(r('GEINCASSEERD VORIG SALDO', '2026-01-08').leverancier, null);
  // koppelen is herhaalbaar
  assert.deepEqual(C.koppel(t.fdb, k.id, { wie: 'toets', nu: NU }), { incasso_nieuw: 0, incasso_onbekend: 0, leverancier_nieuw: 0, factuur_nieuw: 0 });
  D.sluit(t.fdb);
});

test('de database bewaakt: ruwe velden vast, incasso op de rekening van de kaart, andere kaart geweigerd, geen volledig kaartnummer', () => {
  const t = opzet();
  const k = C.kaartZet(t.fdb, { klantnummer: KLANT, laatste4: '0000', rekening: TG.slice(-4), wie: 'toets', nu: NU });
  C.inlezen(t.fdb, '0000', csv(BASIS), { wie: 'toets', nu: NU });
  const een = t.fdb.db.prepare("SELECT id FROM kaart_regel WHERE soort = 'transactie' LIMIT 1").get().id;
  assert.throws(() => t.fdb.db.prepare('UPDATE kaart_regel SET bedrag_centen = 1 WHERE id = ?').run(een), /kaart_regel_vast/);
  t.fdb.db.prepare("UPDATE kaart_regel SET handelaar = 'X' WHERE id = ?").run(een);   // koppelvelden mogen
  const ander = t.fdb.db.prepare('SELECT id FROM bank_transactie WHERE rekening = ?').get(t.ids.ander).id;
  assert.throws(() => t.fdb.db.prepare("INSERT INTO kaart_incasso (transactie, kaart, overzicht, methode, wie, wanneer) VALUES (?, ?, '2026-02', 'omschrijving', 'toets', 'x')").run(ander, k.id), /kaart_incasso_rekening/);
  assert.throws(() => t.fdb.db.prepare("UPDATE kaart_incasso SET overzicht = '2026-01'").run(), /kaart_incasso_vast/);
  assert.throws(() => C.kaartZet(t.fdb, { klantnummer: '123', laatste4: '0000', rekening: TG.slice(-4), wie: 'toets', nu: NU }), (e) => e.code === 'klantnummer');
  assert.throws(() => C.kaartZet(t.fdb, { klantnummer: '99990000002', laatste4: '4111111111111111', rekening: TG.slice(-4), wie: 'toets', nu: NU }), (e) => e.code === 'laatste4');
  assert.throws(() => C.kaartZet(t.fdb, { klantnummer: '4111111111111111', laatste4: '0000', rekening: TG.slice(-4), wie: 'toets', nu: NU }), (e) => e.code === 'klantnummer');
  assert.throws(() => t.fdb.db.prepare("INSERT INTO kaart (id, uitgever, klantnummer, laatste4, entiteit, rekening, aangemaakt_door, aangemaakt_op) VALUES ('ffffffffffff0001', 'ICS', '4111111111111111', '0000', 'tolgaarde', ?, 'toets', 'x')").run(t.ids.rek), /CHECK/);
  assert.throws(() => C.inlezen(t.fdb, '0000', csv([Object.assign(BASIS[0].slice(), { 3: '****9999' })]), { wie: 'toets', nu: NU }), (e) => e.code === 'andere_kaart');
  assert.throws(() => C.kaartZet(t.fdb, { klantnummer: '99990000003', laatste4: '1111', rekening: 'zzzz', wie: 'toets', nu: NU }), (e) => e.code === 'rekening');
  D.sluit(t.fdb);
});

test('betaalwijze per leverancier: creditcard = betaald alleen zonder bankbetaling en zonder standaard; audit', () => {
  const t = opzet();
  C.kaartZet(t.fdb, { klantnummer: KLANT, laatste4: '0000', rekening: TG.slice(-4), wie: 'toets', nu: NU });
  C.inlezen(t.fdb, '0000', csv(BASIS.concat([['21-01-2026', '22-01-2026', 'WINKEL GROOTHANDEL PARIS FRA', '****0000', 'D', '12,00', 'EUR', '12,00', 'Transaction', '202602']])), { wie: 'toets', nu: NU });
  t.fdb.db.prepare("UPDATE leverancier SET standaard_betaalwijze = 'incasso' WHERE id = ?").run(t.ids.pbUs);
  const k = C.kaartVan(t.fdb, '0000');
  const v = Object.fromEntries(C.betaalwijze(t.fdb, k, { nu: NU }).map((x) => [x.leverancier, x]));
  assert.equal(v[t.ids.wolk].voorstel, 'betaald');
  assert.equal(v[t.ids.pbIe].voorstel, 'eenmalig', 'één kaartregel: niet vanzelf');
  assert.equal(v[t.ids.pbUs].voorstel, 'andere_standaard');
  assert.equal(v[t.ids.win].voorstel, 'wisselend'); assert.equal(v[t.ids.win].bank_365, 1);
  C.betaalwijze(t.fdb, k, { nu: NU, zet: true, wie: 'toets' });
  const sb = (id) => t.fdb.db.prepare('SELECT standaard_betaalwijze AS s FROM leverancier WHERE id = ?').get(id).s;
  assert.equal(sb(t.ids.wolk), 'betaald'); assert.equal(sb(t.ids.pbUs), 'incasso'); assert.equal(sb(t.ids.win), null);
  assert.equal(sb(t.ids.pbIe), null, 'eenmalig blijft zonder --leverancier');
  assert.equal(t.fdb.db.prepare("SELECT count(*) AS n FROM audit WHERE wat = 'leverancier_bijwerken' AND wie = 'toets'").get().n, 1);
  C.betaalwijze(t.fdb, k, { nu: NU, zet: true, wie: 'toets', leveranciers: [t.ids.pbIe, t.ids.win] });
  assert.equal(sb(t.ids.pbIe), 'betaald', 'met --leverancier ook eenmalig'); assert.equal(sb(t.ids.win), null, 'wisselend nooit');
  assert.equal(C.betaalwijze(t.fdb, k, { nu: NU }).find((x) => x.leverancier === t.ids.wolk).voorstel, 'staat_al');
  D.sluit(t.fdb);
});

test('leesroute (Socev): opdracht creditcard via facturen.js, zonder klantnummer, autorisatie alleen uit het nieuwste bestand', () => {
  const t = opzet();
  assert.equal(F.lees(t.fdb, { opdracht: 'creditcard' }, { wie: 'socev', nu: NU }).j.kaarten.length, 0);
  C.kaartZet(t.fdb, { klantnummer: KLANT, laatste4: '0000', rekening: TG.slice(-4), wie: 'toets', nu: NU });
  C.inlezen(t.fdb, '0000', csv(BASIS), { wie: 'toets', nu: NU });
  const a = F.lees(t.fdb, { opdracht: 'creditcard' }, { wie: 'socev', nu: NU });
  assert.equal(a.status, 200);
  assert.ok(!JSON.stringify(a.j).includes(KLANT), 'geen klantnummer naar buiten');
  assert.equal(a.j.kaart.laatste4, '0000'); assert.equal(a.j.kaart.rekening, '…' + TG.slice(-4));
  assert.equal(a.j.aansluiting.find((x) => x.overzicht === '2026-02').status, 'sluit');
  assert.ok(!a.j.aansluiting.some((x) => x.status === 'buiten_bestand')); assert.equal(a.j.buiten_bestand.overzichten, 1);
  const r = F.lees(t.fdb, { opdracht: 'creditcard', weergave: 'regels', tekst: 'wolkdienst' }, { wie: 'socev', nu: NU }).j;
  assert.equal(r.aantal, 5); assert.equal(r.totaal_transacties_centen, 4700);
  assert.ok(r.regels.every((x) => x.valuta_orig === 'USD'));
  const alle = F.lees(t.fdb, { opdracht: 'creditcard', weergave: 'regels' }, { wie: 'socev', nu: NU }).j;
  assert.equal(alle.regels.filter((x) => x.soort === 'autorisatie').length, 1);
  C.inlezen(t.fdb, '0000', csv(BASIS.slice(0, 2)).subarray(0), { wie: 'toets', nu: NU + 1000 });   // zelfde sha? nee: ander bestand zonder autorisatie
  assert.equal(F.lees(t.fdb, { opdracht: 'creditcard', weergave: 'regels' }, { wie: 'socev', nu: NU }).j.regels.filter((x) => x.soort === 'autorisatie').length, 0, 'oude autorisatie verdwijnt');
  C.inlezen(t.fdb, '0000', csv(BASIS.slice(13)), { wie: 'toets', nu: NU + 2000 });   // de autorisatie staat nog open in het nieuwste bestand (diffreview ZOU 2)
  assert.equal(F.lees(t.fdb, { opdracht: 'creditcard', weergave: 'regels' }, { wie: 'socev', nu: NU }).j.regels.filter((x) => x.soort === 'autorisatie').length, 1, 'open autorisatie blijft zichtbaar');
  const l = F.lees(t.fdb, { opdracht: 'creditcard', weergave: 'leveranciers' }, { wie: 'socev', nu: NU }).j;
  assert.ok(l.leveranciers.some((x) => x.naam === 'Wolkdienst'));
  assert.equal(F.lees(t.fdb, { opdracht: 'creditcard', kaart: '9999' }, { wie: 'socev', nu: NU }).status, 400);
  assert.equal(F.lees(t.fdb, { opdracht: 'onzin' }, { wie: 'socev', nu: NU }).status, 400);
  const voor = t.fdb.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  F.lees(t.fdb, { opdracht: 'creditcard', weergave: 'leveranciers' }, { wie: 'socev', nu: NU });
  assert.equal(t.fdb.db.prepare('SELECT count(*) AS n FROM audit').get().n, voor, 'lezen schrijft niets');
  D.sluit(t.fdb);
});

test('CLI: stand en inlezen op een map; weigert een database met een ouder schema', () => {
  const t = opzet();
  D.sluit(t.fdb);
  const cp = require('child_process');
  const env = Object.assign({}, process.env, { FACTUREN_DIR: path.join(t.dir, 'db'), SOCEV_KANT: 'olares' });
  const cli = (args) => cp.spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'tools', 'facturen-creditcard.js')].concat(args), { env, encoding: 'utf8' });
  assert.equal(cli(['kaart-zet', '--klantnummer', KLANT, '--laatste4', '0000', '--rekening', TG.slice(-4)]).status, 0);
  const f = path.join(t.dir, 'ics.csv');
  fs.writeFileSync(f, csv(BASIS));
  const i = cli(['inlezen', f]);
  assert.equal(i.status, 0, i.stderr); assert.equal(JSON.parse(i.stdout).nieuw, BASIS.length);
  const s = cli(['stand']);
  assert.equal(s.status, 0); assert.match(s.stdout, /2026-02 {2}sluit/); assert.ok(!s.stdout.includes(KLANT));
  // ouder schema: weigeren (de pod draait dan nog een oudere release)
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(t.dir, 'db', D.BESTAND));
  db.exec('DELETE FROM schema_migratie WHERE versie = ' + D.SCHEMA_VERSIE); db.close();
  const o = cli(['koppel']);
  assert.notEqual(o.status, 0); assert.match(o.stderr, /oudere release/);
});

// ───────────────────────────── wv2958: het rekeningoverzicht als PDF ─────────────────────────────
// Verzonnen overzicht met dezelfde opbouw als een echt ICS-rekeningoverzicht (pdftotext -layout): klantnummer 999.9000.0001, kaart …0000,
// overzicht van 03-04-2026 (overzicht 2026-04) met de regels van BASIS die op overzicht 202604 staan plus één nieuwe na de CSV.
const sp = (n) => ' '.repeat(n);
const pdfRegel = (td, bd, naam, plaats, land, vreemd, eur, dc) => td + sp(3) + bd + sp(9) + naam.padEnd(37) + (plaats || '').padEnd(25) + (land || '').padEnd(16) +
  (vreemd ? vreemd.padStart(9) : sp(9)) + sp(10) + eur.padStart(10) + ' ' + dc;
function icsTekst(o) {
  o = o || {};
  const regels = o.regels || [
    pdfRegel('08 mrt', '08 mrt', 'GEINCASSEERD VORIG SALDO', '', '', '', '73,00', 'credit'),
    pdfRegel('08 mrt', '08 mrt', 'GEWEIGERDE INCASSO', '', '', '', '73,00', 'debet'),
    pdfRegel('14 mrt', '14 mrt', 'HER-INCASSO', '', '', '', '73,00', 'credit'),
    pdfRegel('15 mrt', '16 mrt', 'WOLKDIENST', 'SAN FRANCISCO', 'USA', '22,00 USD', '20,00', 'debet'),
    sp(24) + 'Wisselkoers USD' + sp(22) + '1.10000',
    pdfRegel('01 apr', '02 apr', 'PROEFBUREAU* ABONNEMENT', 'DUBLIN 4', 'IRL', '', '1.210,00', 'debet'),
  ];
  return [
    sp(140) + 'rekeningoverzicht', sp(96) + 'International Card Services BV', 'Proefpraktijk B.V.' + sp(78) + 'Postbus 1', '',
    'Mastercard Business', '',
    'Datum' + sp(28) + 'ICS-klantnummer' + sp(19) + 'Volgnummer' + sp(22) + 'Bladnummer',
    (o.datum || '03 april 2026') + sp(17) + (o.klant || '999.9000.0001') + sp(19) + '4' + sp(30) + '1 van 1',
    'Vorig openstaand saldo' + sp(11) + 'Totaal credit' + sp(19) + 'Totaal debet' + sp(20) + 'Nieuw openstaand saldo',
    '€ ' + (o.vorig || '73,00') + sp(13) + 'debet' + sp(7) + '€ ' + (o.credit || '146,00') + sp(24) + '€ ' + (o.debet || '1.303,00') + sp(22) + '€ ' + (o.nieuw || '1.230,00') + sp(12) + 'debet',
    '', '', 'Datum      Datum         Omschrijving' + sp(59) + 'Bedrag in             Bedrag in', 'transactie boeking' + sp(78) + 'vreemde valuta        Euro', '', '',
    'Card-nummer: ' + (o.kaart || '************0000'), 'Card-houder: P. PROEF',
  ].concat(regels, ['', '', 'Het te betalen bedrag van € 1.230,00 wordt omstreeks 9 april 2026 van uw bankrekening geïncasseerd.']).join('\n') + '\n';
}
// Een echte (minimale) PDF met die tekst: Courier, één regel per Tj, WinAnsi (€ = 0x80); /Author zoals bij ICS.
function icsPdf(tekst) {
  const lijnen = tekst.split('\n');
  const esc = (s) => s.replace(/[\\()]/g, (c) => '\\' + c).replace(/€/g, '\\200').replace(/ï/g, '\\357');
  const stroom = lijnen.map((l, i) => 'BT /F1 5 Tf 10 ' + (820 - i * 7) + ' Td (' + esc(l) + ') Tj ET').join('\n');
  const obj = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + Buffer.byteLength(stroom, 'latin1') + ' >>\nstream\n' + stroom + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
    '<< /Author (International Card Services) /Title (W03042026proef) >>'];
  let uit = '%PDF-1.4\n'; const pos = [];
  obj.forEach((o, i) => { pos.push(Buffer.byteLength(uit, 'latin1')); uit += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const x = Buffer.byteLength(uit, 'latin1');
  uit += 'xref\n0 ' + (obj.length + 1) + '\n0000000000 65535 f \n' + pos.map((p) => String(p).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size ' + (obj.length + 1) + ' /Root 1 0 R /Info 6 0 R >>\nstartxref\n' + x + '\n%%EOF\n';
  return Buffer.from(uit, 'latin1');
}
function pdfNaarTekst(bytes) {
  const r = require('child_process').spawnSync('/usr/bin/pdftotext', ['-q', '-layout', '-enc', 'UTF-8', '-', '-'], { input: bytes, encoding: 'utf8' });
  assert.equal(r.status, 0, 'pdftotext'); return r.stdout;
}

test('PDF-lezer: opbouw, jaar uit de overzichtsdatum, betalingen zonder kaart, op de cent op de totalen', () => {
  const g = C.leesIcsPdfTekst(icsTekst());
  assert.equal(g.formaat, 'ics_pdf'); assert.equal(g.overzicht, '2026-04'); assert.equal(g.klantnummer, KLANT);
  assert.deepEqual(g.aantallen, { transactie: 2, betaling: 3, autorisatie: 0 });
  assert.deepEqual(g.totalen, { vorig_saldo_centen: 7300, credit_centen: 14600, debet_centen: 130300, nieuw_saldo_centen: 123000 });
  const w = g.regels.find((r) => r.omschrijving === 'WOLKDIENST SAN FRANCISCO USA');
  assert.deepEqual([w.transactiedatum, w.boekdatum, w.bedrag_centen, w.valuta_orig, w.bedrag_orig_centen, w.land, w.laatste4], ['2026-03-15', '2026-03-16', 2000, 'USD', 2200, 'USA', '0000']);
  const h = g.regels.find((r) => r.omschrijving === 'HER-INCASSO');
  assert.deepEqual([h.soort, h.bedrag_centen, h.laatste4, h.valuta_orig], ['betaling', -7300, null, 'EUR']);
  assert.equal(g.regels.find((r) => r.omschrijving.startsWith('PROEFBUREAU')).bedrag_centen, 121000);
  // januari-overzicht met een regel uit december: het jaar ervoor
  const jan = C.leesIcsPdfTekst(icsTekst({ datum: '03 januari 2027', vorig: '0,00', credit: '0,00', debet: '10,00', nieuw: '10,00', regels: [pdfRegel('28 dec', '29 dec', 'WOLKDIENST', 'SAN FRANCISCO', 'USA', '', '10,00', 'debet')] }));
  assert.equal(jan.regels[0].transactiedatum, '2026-12-28'); assert.equal(jan.overzicht, '2027-01');
  assert.equal(C.isIcsPdfTekst('Factuur 12\nProefbureau\nTotaal € 10,00'), false, 'een gewone factuur is het niet');
});

test('PDF-lezer weigert het hele overzicht: totaal, kaartnummer, onleesbare regel, kenmerken', () => {
  const fout = (tekst, code) => assert.throws(() => C.leesIcsPdfTekst(tekst), (e) => e instanceof C.KaartFout && e.code === code);
  fout(icsTekst({ debet: '1.303,01' }), 'totaal');
  fout(icsTekst({ nieuw: '1.230,01' }), 'totaal');
  fout(icsTekst({ regels: [pdfRegel('15 mrt', '16 mrt', 'WOLKDIENST', 'SAN FRANCISCO', 'USA', '', '20,00', 'debet')] }), 'totaal');
  fout(icsTekst({ kaart: '4111111111111111' }), 'formaat');   // het kenmerk "Card-nummer: ****1234" ontbreekt dan al
  fout(icsTekst().replace('Card-houder', 'Card-nummer: 4111 1111 1111 1111\nCard-houder'), 'kaartnummer');
  fout(icsTekst({ vorig: '0,00', credit: '0,00', debet: '20,00', nieuw: '20,00', regels: [pdfRegel('15 mrt', '16 mrt', 'WEBWINKEL 4111-1111-1111-1111', 'AMSTERDAM', 'NLD', '', '20,00', 'debet')] }), 'kaartnummer');
  fout(icsTekst({ regels: [pdfRegel('15 xyz', '16 mrt', 'WOLKDIENST', 'SAN FRANCISCO', 'USA', '', '20,00', 'debet')] }), 'regel');
  fout(icsTekst().replace('International Card Services BV', 'Andere Kaart BV'), 'formaat');
});

test('PDF en CSV van dezelfde periode tellen niet dubbel (beide volgordes); ander klantnummer geweigerd', () => {
  for (const volgorde of ['csv-eerst', 'pdf-eerst']) {
    const t = opzet();
    C.kaartZet(t.fdb, { klantnummer: KLANT, laatste4: '0000', rekening: TG.slice(-4), wie: 'toets', nu: NU });
    const pdf = icsPdf(icsTekst()), tekst = pdfNaarTekst(pdf);
    const telTr = () => t.fdb.db.prepare("SELECT count(*) AS n FROM kaart_regel WHERE soort <> 'autorisatie'").get().n;
    if (volgorde === 'csv-eerst') {
      C.inlezen(t.fdb, '0000', csv(BASIS), { wie: 'toets', nu: NU });
      const u = C.inlezen(t.fdb, '0000', pdf, { wie: 'toets', nu: NU, pdfTekst: tekst, naam: 'ics.pdf' });
      assert.equal(u.formaat, 'ics_pdf'); assert.equal(u.regels, 5); assert.equal(u.nieuw, 1, 'alleen PROEFBUREAU van 1 april is nieuw'); assert.equal(u.al_bekend_regels, 4);
      assert.equal(telTr(), BASIS.length - 1 + 1);
    } else {
      const u = C.inlezen(t.fdb, '0000', pdf, { wie: 'toets', nu: NU, pdfTekst: tekst });
      assert.equal(u.nieuw, 5);
      const c = C.inlezen(t.fdb, '0000', csv(BASIS), { wie: 'toets', nu: NU });
      assert.equal(c.al_bekend_regels, 4, 'de vier regels van overzicht 2026-04 uit de PDF tellen als binnen'); assert.equal(c.nieuw, BASIS.length - 4);
      assert.equal(telTr(), BASIS.length - 1 + 1);
    }
    assert.equal(t.fdb.db.prepare("SELECT formaat FROM kaart_bestand WHERE formaat = 'ics_pdf'").get().formaat, 'ics_pdf');
    assert.ok(D.bronBestaat(t.fdb, D.sha256(pdf)), 'de PDF in bankbron/');
    const nog = C.inlezen(t.fdb, '0000', pdf, { wie: 'toets', nu: NU, pdfTekst: tekst });
    assert.equal(nog.al_bekend, true);
    assert.throws(() => C.inlezen(t.fdb, '0000', icsPdf(icsTekst({ klant: '999.9000.0002' })), { wie: 'toets', nu: NU, pdfTekst: icsTekst({ klant: '999.9000.0002' }) }),
      (e) => e instanceof C.KaartFout && e.code === 'andere_kaart');
  }
});

test('upload in de app: ICS-PDF naar de kaart, niet naar de stukken; niet zeker of niet sluitend = oude weg of geweigerd', () => {
  const t = opzet();
  C.kaartZet(t.fdb, { klantnummer: KLANT, laatste4: '0000', rekening: TG.slice(-4), wie: 'toets', nu: NU });
  const R = F.maak({ fout: () => {} });
  const david = F.rolVoor(t.fdb, { ingang: 'app', wie: 'toets' });
  let n = 0;
  const up = (bytes, naam, extra) => R.app(t.fdb, Object.assign({ methode: 'POST', pad: '/app/facturen/upload', d: { beurt: 'fac-proef-' + String(++n).padStart(4, '0'), n: 1 }, rol: david, primair: true, nu: NU + n,
    uploadNeem: () => ({ naam, bytes, weg: () => {} }), pdfTekst: (b) => ({ ok: true, tekst: pdfNaarTekst(b) }) }, extra || {}));
  const docs = () => t.fdb.db.prepare('SELECT count(*) AS n FROM document').get().n;
  // niet sluitend: geweigerd, niets ingelezen en niet bij de stukken
  const mis = up(icsPdf(icsTekst({ debet: '1.303,01' })), '_202604.pdf');
  assert.equal(mis.status, 415); assert.match(mis.j.fout || JSON.stringify(mis.j), /sluiten niet/);
  assert.equal(t.fdb.db.prepare('SELECT count(*) AS n FROM kaart_regel').get().n, 0); assert.equal(docs(), 0);
  // goed: naar de kaart
  const pdf = icsPdf(icsTekst());
  const ok = up(pdf, '_202604.pdf');
  assert.equal(ok.status, 200, JSON.stringify(ok.j)); assert.equal(ok.j.soort, 'creditcard'); assert.equal(ok.j.formaat, 'pdf'); assert.equal(ok.j.kaart, '…0000');
  assert.equal(ok.j.overzicht, '2026-04'); assert.equal(ok.j.nieuw, 5); assert.equal(docs(), 0, 'geen document voor de koerier');
  assert.equal(up(pdf, '_202604.pdf').j.al_bekend, true);
  // zonder pdftotext (oude pod-kant) of als de tekst het niet zeker is: de oude weg (stukken, te_lezen)
  const ander = icsPdf(icsTekst({ datum: '03 mei 2026', vorig: '0,00', credit: '0,00', debet: '10,00', nieuw: '10,00', regels: [pdfRegel('20 apr', '21 apr', 'WOLKDIENST', 'SAN FRANCISCO', 'USA', '', '10,00', 'debet')] }));
  const zonder = up(ander, '_202605.pdf', { pdfTekst: undefined });
  assert.equal(zonder.status, 200); assert.equal(zonder.j.te_lezen, true); assert.equal(docs(), 1);
  const factuur = up(icsPdf('Factuur 12\nProefbureau\nTotaal 10,00'), 'factuur.pdf');
  assert.equal(factuur.j.te_lezen, true); assert.equal(docs(), 2);
  // niet de eigenaar (praktijkmanager via de ingang): de oude weg, de kaart is van de eigenaar
  const pm = up(icsPdf(icsTekst({ datum: '03 juni 2026', vorig: '0,00', credit: '0,00', debet: '10,00', nieuw: '10,00', regels: [pdfRegel('20 mei', '21 mei', 'WOLKDIENST', 'SAN FRANCISCO', 'USA', '', '10,00', 'debet')] })), '_202606.pdf',
    { rol: { soort: 'praktijkmanager', wie: 'pm', entiteiten: ['tolgaarde'], ingang: 'fac' } });
  assert.notEqual(pm.j && pm.j.soort, 'creditcard');
});

test('CLI: een PDF inlezen en een al geüpload document alsnog naar de kaart (te_lezen 0 met audit; een factuur blijft staan)', () => {
  const t = opzet();
  C.kaartZet(t.fdb, { klantnummer: KLANT, laatste4: '0000', rekening: TG.slice(-4), wie: 'toets', nu: NU });
  const pdf = icsPdf(icsTekst());
  const st = D.stukSchrijf(t.fdb, pdf), id = D.nieuwId();
  D.voegToe(t.fdb, 'document', { id, sha256: st.sha256, naam: '_202604.pdf', mime: 'application/pdf', bytes: st.bytes, soort: 'pdf', te_lezen: 1, geupload_door: 'toets', aangemaakt_op: '2026-04-05T00:00:00Z' });
  D.sluit(t.fdb);
  const cp = require('child_process');
  const env = Object.assign({}, process.env, { FACTUREN_DIR: path.join(t.dir, 'db'), SOCEV_KANT: 'olares' });
  const cli = (args) => cp.spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'tools', 'facturen-creditcard.js')].concat(args), { env, encoding: 'utf8' });
  const droog = cli(['document', '--droog', id]);
  assert.equal(droog.status, 0, droog.stderr); assert.equal(JSON.parse(droog.stdout).document.uit_stapel, false);
  const d = cli(['document', id]);
  assert.equal(d.status, 0, d.stderr);
  const j = JSON.parse(d.stdout);
  assert.equal(j.formaat, 'ics_pdf'); assert.equal(j.nieuw, 5); assert.deepEqual(j.document, { id, te_lezen_was: true, uit_stapel: true, facturen: 0 });
  const fdb = D.open(path.join(t.dir, 'db'));
  assert.equal(fdb.db.prepare('SELECT te_lezen FROM document WHERE id = ?').get(id).te_lezen, 0);
  assert.equal(fdb.db.prepare("SELECT count(*) AS n FROM audit WHERE wat = 'document_creditcard' AND object_id = ?").get(id).n, 1);
  D.sluit(fdb);
  assert.equal(JSON.parse(cli(['document', id]).stdout).al_bekend, true, 'nog eens: al bekend');
  // inlezen van een PDF-bestand (pdftotext in het gereedschap)
  const f = path.join(t.dir, 'mei.pdf');
  fs.writeFileSync(f, icsPdf(icsTekst({ datum: '03 mei 2026', vorig: '1.230,00', credit: '1.230,00', debet: '10,00', nieuw: '10,00',
    regels: [pdfRegel('09 apr', '09 apr', 'GEINCASSEERD VORIG SALDO', '', '', '', '1.230,00', 'credit'), pdfRegel('20 apr', '21 apr', 'WOLKDIENST', 'SAN FRANCISCO', 'USA', '11,00 USD', '10,00', 'debet'), sp(24) + 'Wisselkoers USD' + sp(22) + '1.10000'] })));
  const i = cli(['inlezen', f]);
  assert.equal(i.status, 0, i.stderr); assert.equal(JSON.parse(i.stdout).nieuw, 2); assert.equal(JSON.parse(i.stdout).overzicht, '2026-05');
  assert.notEqual(cli(['document', 'ffffffffffffffff']).status, 0);
});

test('ontdubbeling kijkt naar de omschrijving (review MOET 1): andere winkel zelfde bedrag/dag claimt niet; niet sluitend na inlezen = niets', () => {
  const t = opzet();
  C.kaartZet(t.fdb, { klantnummer: KLANT, laatste4: '0000', rekening: TG.slice(-4), wie: 'toets', nu: NU });
  // gedeeltelijke CSV: alleen winkel B (zelfde datums en bedrag als A)
  C.inlezen(t.fdb, '0000', csv([['15-03-2026', '16-03-2026', 'WINKEL BEE AMSTERDAM NLD', '****0000', 'D', '20,00', 'EUR', '20,00', 'Transaction', '202604']]), { wie: 'toets', nu: NU });
  const tekst = icsTekst({ vorig: '0,00', credit: '0,00', debet: '40,00', nieuw: '40,00', regels: [
    pdfRegel('15 mrt', '16 mrt', 'WINKEL AA', 'AMSTERDAM', 'NLD', '', '20,00', 'debet'), pdfRegel('15 mrt', '16 mrt', 'WINKEL BEE', 'AMSTERDAM', 'NLD', '', '20,00', 'debet')] });
  const u = C.inlezen(t.fdb, '0000', icsPdf(tekst), { wie: 'toets', nu: NU, pdfTekst: tekst });
  assert.equal(u.nieuw, 1); assert.equal(u.al_bekend_regels, 1);
  assert.deepEqual(t.fdb.db.prepare("SELECT omschrijving FROM kaart_regel WHERE overzicht = '2026-04' ORDER BY omschrijving").all().map((x) => x.omschrijving), ['WINKEL AA AMSTERDAM NLD', 'WINKEL BEE AMSTERDAM NLD']);
  // een CSV-regel op dit overzicht die niet op de PDF staat: na inlezen sluit het niet → niets ingelezen (ROLLBACK)
  const t2 = opzet();
  C.kaartZet(t2.fdb, { klantnummer: KLANT, laatste4: '0000', rekening: TG.slice(-4), wie: 'toets', nu: NU });
  C.inlezen(t2.fdb, '0000', csv([['10-03-2026', '11-03-2026', 'WINKEL CEE AMSTERDAM NLD', '****0000', 'D', '5,00', 'EUR', '5,00', 'Transaction', '202604']]), { wie: 'toets', nu: NU });
  const voor = t2.fdb.db.prepare('SELECT count(*) AS n FROM kaart_regel').get().n;
  assert.throws(() => C.inlezen(t2.fdb, '0000', icsPdf(tekst), { wie: 'toets', nu: NU, pdfTekst: tekst }), (e) => e instanceof C.KaartFout && e.code === 'dubbel');
  assert.equal(t2.fdb.db.prepare('SELECT count(*) AS n FROM kaart_regel').get().n, voor);
  assert.equal(t2.fdb.db.prepare("SELECT count(*) AS n FROM kaart_bestand WHERE formaat = 'ics_pdf'").get().n, 0);
  // twee afgekapte kandidaten: twijfel, geweigerd
  const t3 = opzet();
  C.kaartZet(t3.fdb, { klantnummer: KLANT, laatste4: '0000', rekening: TG.slice(-4), wie: 'toets', nu: NU });
  C.inlezen(t3.fdb, '0000', csv([['15-03-2026', '16-03-2026', 'WOLKDIENST EEN AMSTERDAM NLD', '****0000', 'D', '20,00', 'EUR', '20,00', 'Transaction', '202604'],
    ['15-03-2026', '16-03-2026', 'WOLKDIENST TWEE AMSTERDAM NLD', '****0000', 'D', '20,00', 'EUR', '20,00', 'Transaction', '202604']]), { wie: 'toets', nu: NU });
  const t3tekst = icsTekst({ vorig: '0,00', credit: '0,00', debet: '20,00', nieuw: '20,00', regels: [pdfRegel('15 mrt', '16 mrt', 'WOLKDIENST', '', '', '', '20,00', 'debet')] });
  assert.throws(() => C.inlezen(t3.fdb, '0000', icsPdf(t3tekst), { wie: 'toets', nu: NU, pdfTekst: t3tekst }), (e) => e instanceof C.KaartFout && e.code === 'twijfel');
});
