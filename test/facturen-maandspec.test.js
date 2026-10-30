'use strict';
// Toetsen voor wv2060: maandspecificatie PayPal en creditcard voor de boekhouder (facturen-maandspec.js, facturen.js maandspec + routes
// maand-specificatie, de ICS-upload in Uploads). Alles verzonnen (de repo is openbaar): PayPal-rekening PROEFACC01, "Wolkdienst",
// "Proefbureau Ireland Limited", ICS-klantnummer 99990000001, kaart …0000, adres boekhouder@voorbeeld.nl. Raakt PayPal, de kluis, Gmail,
// /opt/data/facturen en de vault niet (alles in TMPDIR, het mailluik zit in server.js). Draaien: bash test/facturen-maandspec.sh
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'facturen-db.js'));
const F = require(path.join(ROOT, 'facturen.js'));
const P = require(path.join(ROOT, 'facturen-paypal.js'));
const C = require(path.join(ROOT, 'facturen-creditcard.js'));
const MS = require(path.join(ROOT, 'facturen-maandspec.js'));
const K = require(path.join(ROOT, 'facturen-kern.js'));
const { ibanFromAbnAccount } = require(path.join(ROOT, 'mt940-lezer.js'));

const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
const KLANT = '99990000001';
const TG = ibanFromAbnAccount('0000000041');
const ANDER = ibanFromAbnAccount('0000000042');
const AAN = 'boekhouder@voorbeeld.nl';

// ── PayPal (zelfde vorm als test/facturen-paypal.test.js) ──
const tx = (id, ev, tijd, bedrag, valuta, x) => ({
  transaction_info: Object.assign({ transaction_id: id, transaction_event_code: ev, transaction_status: 'S', transaction_initiation_date: tijd, transaction_updated_date: tijd,
    transaction_amount: { currency_code: valuta, value: bedrag }, ending_balance: { currency_code: valuta, value: '0.00' } }, x || {}),
  payer_info: (x && x._payer) || { payer_name: { alternate_full_name: 'PayPal-houder' } }, cart_info: {},
});
const naar = (id) => ({ paypal_reference_id: id, paypal_reference_id_type: 'TXN' });
const DETAILS = [
  tx('PROEF0000000001A', 'T0003', '2026-08-29T14:50:51Z', '-15.12', 'EUR', { transaction_subject: 'Wolkdienst abonnement', _payer: { payer_name: { alternate_full_name: 'Wolkdienst' } } }),
  tx('PROEF0000000002B', 'T0300', '2026-08-29T14:50:51Z', '15.12', 'EUR', Object.assign(naar('PROEF0000000001A'), { bank_reference_id: '9990000000001' })),
  tx('PROEF0000000003C', 'T0006', '2026-09-16T16:21:53Z', '-38.50', 'USD', { transaction_subject: 'Proefonderdeel A', _payer: { payer_name: { alternate_full_name: 'Proefbureau Ireland Limited' } } }),
  tx('PROEF0000000004D', 'T0200', '2026-09-16T16:21:53Z', '38.50', 'USD', naar('PROEF0000000003C')),
  tx('PROEF0000000005E', 'T0200', '2026-09-16T16:21:53Z', '-34.80', 'EUR', naar('PROEF0000000003C')),
  tx('PROEF0000000006F', 'T0300', '2026-09-16T16:21:53Z', '34.80', 'EUR', Object.assign(naar('PROEF0000000003C'), { bank_reference_id: '9990000000002' })),
];

// ── ICS (zelfde vorm als test/facturen-creditcard.test.js) ──
const KOP = 'Transactiedatum;Boekingsdatum;Omschrijving;Naam Card-houder;Card nummer;Debit/Credit;Bedrag;Merchant categorie;Land;Valuta;Bedrag in oorspronkelijke valuta;Type transactie;WalletProvider;Merchant categorie code;Maand/jaar rekeningoverzicht';
const land = (oms) => { const m = / ([A-Z]{3})$/.exec(oms); return m ? m[1] : ''; };
const rij = (r) => [r[0], r[1], r[2], '"Proef, P"', r[3], r[4], r[5], 'Computer Software Stores', land(r[2]), r[6], r[7], r[8], '', '5734', r[9]].join(';');
const csv = (rijen) => Buffer.from('﻿' + KOP + '\n' + rijen.map(rij).join('\n') + '\n', 'utf8');
// overzicht 2026-09: 2 transacties (45,00), geïncasseerd 8-9; overzicht 2026-10: in dit eerste bestand maar 1 van de 2 transacties (de
// bank incasseert 7-10 voor 30,00); het tweede bestand (de upload) brengt de tweede en een regel van overzicht 2026-11
const ICS1 = [
  ['05-08-2026', '06-08-2026', 'WOLKDIENST SAN FRANCISCO USA', '****0000', 'D', '20,00', 'USD', '22,00', 'Transaction', '202609'],
  ['20-08-2026', '21-08-2026', 'PROEFBUREAU* ABONNEMENT DUBLIN 4 IRL', '****0000', 'D', '25,00', 'EUR', '25,00', 'Transaction', '202609'],
  ['08-09-2026', '08-09-2026', 'GEINCASSEERD VORIG SALDO', '', 'C', '-45,00', 'EUR', '-45,00', 'Payment', '202610'],
  ['10-09-2026', '11-09-2026', 'WOLKDIENST SAN FRANCISCO USA', '****0000', 'D', '10,00', 'USD', '11,00', 'Transaction', '202610'],
];
const ICS2 = ICS1.concat([
  ['28-09-2026', '29-09-2026', 'WINKELTJE PARIS FRA', '****0000', 'D', '20,00', 'EUR', '20,00', 'Transaction', '202610'],
  ['07-10-2026', '07-10-2026', 'GEINCASSEERD VORIG SALDO', '', 'C', '-30,00', 'EUR', '-30,00', 'Payment', '202611'],
  ['10-10-2026', '11-10-2026', 'WOLKDIENST SAN FRANCISCO USA', '****0000', 'D', '5,00', 'USD', '5,50', 'Transaction', '202611'],
]);

function opzet() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-maandspec-'));
  WEG.push(dir);
  const fdb = D.open(path.join(dir, 'db'));
  const ids = {};
  D.transactie(fdb, () => {
    for (const [s, n] of [['tolgaarde', 'Huisartsenpraktijk Proef B.V.'], ['groenhouten', 'Proefpraktijk Twee'], ['prive', 'Privé']]) D.voegToe(fdb, 'entiteit', { sleutel: s, naam: n });
    ids.rek = D.nieuwId(); ids.ander = D.nieuwId();
    D.voegToe(fdb, 'rekening', { id: ids.rek, entiteit: 'tolgaarde', iban: TG, bank: 'ABN', bank_formaat: 'abn_tab', controle: 1, alleen_eigenaar: 0 });
    D.voegToe(fdb, 'rekening', { id: ids.ander, entiteit: 'groenhouten', iban: ANDER, bank: 'ABN', bank_formaat: 'abn_tab', controle: 1, alleen_eigenaar: 0 });
    for (const [k, naam] of [['wolk', 'Wolkdienst'], ['pb', 'Proefbureau Ireland Limited']]) {
      ids[k] = D.nieuwId();
      D.voegToe(fdb, 'leverancier', { id: ids[k], naam, genormaliseerd: K.normNaam(naam), aangemaakt_op: '2026-01-01T00:00:00Z' });
    }
    ids.bestand = D.nieuwId();
    D.voegToe(fdb, 'bank_bestand', { id: ids.bestand, sha256: 'b'.repeat(64), formaat: 'abn_tab', naam: 'proef.TAB', geupload_door: 'toets', geupload_op: '2026-10-01T00:00:00Z' });
    D.voegToe(fdb, 'factuur_archief', { id: D.nieuwId(), herkomst: 'fv2', extern_id: 'pp1', entiteit: 'tolgaarde', leverancier_naam: 'Wolkdienst', nummer: 'WD-2026-08',
      factuurdatum: '2026-08-28', incl: 1512, valuta: 'EUR', aangemaakt_op: '2026-10-01T00:00:00Z' });
  });
  fdb.db.prepare("UPDATE entiteit SET afschrift_doel = ? WHERE sleutel = 'groenhouten'").run(AAN);
  let n = 0;
  const bank = (rek, datum, centen, oms, naam) => {
    const id = 'e' + String(++n).padStart(15, '0');
    fdb.db.prepare('INSERT INTO bank_transactie (id, bestand, rekening, entiteit, eigen_iban, boekdatum, bedrag_centen, tegenpartij_naam, omschrijving, is_incasso, entry_ref, formaat, aangemaakt_op) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, \'abn_tab\', ?)')
      .run(id, ids.bestand, rek, rek === ids.rek ? 'tolgaarde' : 'groenhouten', rek === ids.rek ? TG : ANDER, datum, centen, naam || 'PayPal Europe S.a.r.l. et Cie S.C.A', oms, 'ref' + n, '2026-10-01T00:00:00Z');
    return id;
  };
  ids.b1 = bank(ids.rek, '2026-09-01', -1512, '9990000000001/PAYPAL');
  ids.b2 = bank(ids.rek, '2026-09-18', -3480, '9990000000002/PAYP AL');
  ids.bAnder = bank(ids.ander, '2026-09-25', -2232, '9990000000099/PAYPAL');   // een andere PayPal-rekening
  const ics = (m) => 'Incasso ' + m + ' betreffende uw creditcard ICS-klantnummer ' + KLANT;
  ids.i9 = bank(ids.rek, '2026-09-08', -4500, ics('sep 2026'), 'INT CARD SERVICES');
  ids.i10 = bank(ids.rek, '2026-10-07', -3000, ics('okt 2026'), 'INT CARD SERVICES');
  P.verwerk(fdb, { account: 'PROEFACC01', details: DETAILS, ververst: '2026-10-02T09:00:00Z' }, { wie: 'toets', nu: Date.parse('2026-10-02T10:00:00Z') });
  C.kaartZet(fdb, { klantnummer: KLANT, laatste4: '0000', rekening: TG.slice(-4), wie: 'toets', nu: Date.parse('2026-10-01T00:00:00Z') });
  C.inlezen(fdb, null, csv(ICS1), { wie: 'toets', naam: 'ics1.csv', nu: Date.parse('2026-10-01T00:00:00Z') });
  const R = F.maak({ fout: () => {} });
  const rol = F.rolVoor(fdb, { ingang: 'app', wie: 'toets' });
  return { dir, fdb, ids, R, rol };
}
// tekst uit de PDF (de schrijver zet tekst als <hex> in WinAnsi)
const WIN = { 0x80: '€', 0x85: '…', 0x96: '–', 0x97: '—' };
const pdfTekst = (b) => (b.toString('latin1').match(/<([0-9A-F]+)> Tj/g) || []).map((x) => [...Buffer.from(x.slice(1, x.indexOf('>')), 'hex')].map((c) => WIN[c] || String.fromCharCode(c)).join('')).join('\n');

// ───────────────────────────── puur ─────────────────────────────

test('opbouw: subtotalen uit de regels, PayPal-teken omgedraaid (+ = uitgave), status van de kaart nageteld', () => {
  const g = MS.opbouw({ maand: '2026-09',
    paypal: { bijgewerkt: '2026-10-02', rekeningen: [{ entiteit: 'tolgaarde', entiteit_naam: 'Proef', rekening_eind: TG, posten: [
      { datum: '2026-09-01', bank_centen: -1512, status: 'sluit', tegenpartij: 'Wolkdienst', onderwerp: 'abo', valuta: 'EUR', bedrag_centen: -1512, factuur: 'WD-1' },
      { datum: '2026-09-20', bank_centen: 500, status: 'sluit', tegenpartij: 'Winkel', onderwerp: null, valuta: 'EUR', bedrag_centen: 500, factuur: '' },
      { datum: '2026-09-18', bank_centen: -3480, status: 'sluit', tegenpartij: 'Proefbureau', onderwerp: null, valuta: 'USD', bedrag_centen: -3850, factuur: '' }] }] },
    kaarten: [{ laatste4: '0000', entiteit: 'tolgaarde', entiteit_naam: 'Proef', rekening_eind: '0041', status: 'sluit', bank: [{ datum: '2026-09-08', bedrag_centen: -4400 }],
      regels: [{ datum: '2026-08-05', omschrijving: 'A', valuta: 'USD', bedrag_orig_centen: 2200, bedrag_centen: 2000 }, { datum: '2026-08-20', omschrijving: 'B', valuta: 'EUR', bedrag_orig_centen: 2500, bedrag_centen: 2500 }] }] });
  const rk = g.paypal.rekeningen[0];
  assert.equal(rk.rekening_eind, TG.slice(-4), 'van de eigen rekening alleen de laatste vier');
  assert.equal(rk.totaal_centen, 1512 - 500 + 3480);
  assert.deepEqual(rk.posten.map((p) => p.datum), ['2026-09-01', '2026-09-18', '2026-09-20'], 'op datum');
  assert.equal(rk.posten[1].origineel, 'USD 38,50');
  assert.equal(g.kaarten[0].status, 'verschil', 'bank 44,00 tegen transacties 45,00');
  assert.equal(g.kaarten[0].verschil_centen, -100);
  assert.equal(g.kaarten[0].regels[0].origineel, 'USD 22,00');
  assert.equal(g.kaarten[0].regels[1].origineel, '', 'euro: geen origineel');
  assert.throws(() => MS.opbouw({ maand: '2026-13' }), MS.MaandFout);
  assert.throws(() => MS.opbouw({ maand: '2026-09', paypal: { rekeningen: [{ posten: [{ datum: '2026-08-31', bank_centen: -1, status: 'sluit' }] }] }, kaarten: [] }), /buiten de maand/);
  assert.throws(() => MS.opbouw({ maand: '2026-09', paypal: null, kaarten: [{ laatste4: '4111111111111111', status: 'sluit' }] }), MS.MaandFout, 'alleen de laatste 4');
});

test('mail: Davids toon, PayPal en creditcard per regel; zonder creditcard "nog niet aangeleverd"; nagekomen = aanvulling', () => {
  const g = MS.opbouw({ maand: '2026-10', paypal: { bijgewerkt: null, rekeningen: [] },
    kaarten: [{ laatste4: '0000', entiteit: 'tolgaarde', entiteit_naam: 'Proef', rekening_eind: '0041', status: 'niet_aangeleverd', bank: [{ datum: '2026-10-07', bedrag_centen: -3000 }], regels: [] }] });
  const m = MS.mail(g);
  assert.match(m.bericht, /^Ha pa,\n/);
  assert.match(m.bericht, /PayPal: geen PayPal-posten op de bank in oktober 2026/);
  assert.match(m.bericht, /Creditcard ICS …0000, overzicht oktober 2026: heb ik nog niet aangeleverd; die stuur ik na\./);
  assert.match(m.bericht, /\nGroet,\nDavid$/);
  assert.equal(m.onderwerp, 'Specificatie PayPal en creditcard oktober 2026');
  assert.equal(g.ics_ontbreekt, true);
  assert.match(MS.mail(g, { nagekomen: true }).onderwerp, /^Aanvulling: /);
  assert.equal(MS.bestandsnaam(g, { nagekomen: true }), 'Specificatie PayPal en creditcard 2026-10 aanvulling.pdf');
});

test('Voor jou-kaart ICS: binnen de grenzen van de databank, geen pad of wv-nummer, deadline eind van de maand', () => {
  const k = MS.kaartIcs({ sleutel: 'ics-upload-0000-2026-11', laatste4: '0000', maand: '2026-11', incasso_eerste: '2026-11-09', nuKort: '12-11 07:30' });
  assert.equal(k.titel, 'ICS — transacties van november uploaden');
  assert.ok(k.titel.length <= 90 && k.waarom.length <= 400 && k.meting.length <= 300 && k.stappen.length <= 12);
  assert.ok(k.stappen.every((s) => s.length <= 400));
  assert.equal(k.deadline, '2026-11-30');
  assert.equal(MS.kaartIcs({ sleutel: 'x', laatste4: '0000', maand: '2026-02', incasso_eerste: '2026-02-09' }).deadline, '2026-02-28');
  assert.match(k.waarom, /Begin december/);
  assert.doesNotMatch(JSON.stringify(k), /wv\d|\/opt\/|\.md\b|00_Systeem|klantnummer/i);
  assert.deepEqual(k.herkomst.doel, { scherm: 'facturen', focus: 'stap:uploads' });
});

// ───────────────────────────── op de database ─────────────────────────────

test('september: PayPal per rekening met de betaling erachter, andere PayPal-rekening zonder specificatie, creditcard sluit op de incasso', () => {
  const t = opzet();
  const nu = Date.parse('2026-10-05T08:00:00Z');
  const r = t.R.app(t.fdb, { methode: 'POST', pad: '/app/facturen/maand-specificatie', d: { maand: '2026-09' }, rol: t.rol, primair: true, nu });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const pdf = Buffer.from(r.j.bestand.inhoud, 'base64');
  assert.equal(pdf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.equal(r.j.bestand.naam, 'Specificatie PayPal en creditcard 2026-09.pdf');
  const tekst = pdfTekst(pdf);
  assert.match(tekst, /Wolkdienst — Wolkdienst abonnement/);
  assert.match(tekst, /WD-2026-08/, 'factuurnummer uit het archief');
  assert.match(tekst, /USD 38,50/);
  assert.match(tekst, /€ 49,92/, 'subtotaal Tolgaarde = 15,12 + 34,80');
  assert.match(tekst, /niet te specificeren/);
  assert.match(tekst, /€ 22,32/, 'Groenhouten: andere PayPal-rekening');
  assert.match(tekst, /rekeningoverzicht september 2026/);
  assert.match(tekst, /€ 45,00/);
  assert.match(tekst, /op de cent/);
  assert.match(tekst, /PayPal bijgewerkt tot/);
  assert.doesNotMatch(tekst, new RegExp(KLANT + '|' + TG + '|' + ANDER + '|NL\\d\\d'), 'geen klantnummer, geen IBAN');
  assert.ok(t.fdb.db.prepare("SELECT 1 FROM audit WHERE wat = 'maandspec_download' AND object_id = '2026-09'").get(), 'download in de audit');
  // praktijkmanager mag niet
  const pm = t.R.app(t.fdb, { methode: 'POST', pad: '/app/facturen/maand-specificatie', d: { maand: '2026-09' }, rol: { soort: 'praktijkmanager', wie: 'pm', entiteiten: ['tolgaarde'], ingang: 'fac' }, primair: true, nu });
  assert.equal(pm.status, 403);
  assert.equal(t.R.app(t.fdb, { methode: 'POST', pad: '/app/facturen/maand-specificatie', d: { maand: '2026-9' }, rol: t.rol, primair: true, nu }).status, 400);
});

test('oktober zonder volledig ICS-overzicht: creditcard "nog niet aangeleverd"; concept-spoor zoals de SEPA-specificatie; aanvulling na de upload', () => {
  const t = opzet();
  const nu = Date.parse('2026-11-03T08:00:00Z');
  const ov = t.R.app(t.fdb, { methode: 'GET', pad: '/app/facturen/maand-specificatie', rol: t.rol, primair: true, nu });
  assert.equal(ov.status, 200);
  assert.equal(ov.j.maanden[0].maand, '2026-10');
  assert.deepEqual(ov.j.maanden[0].creditcard, [{ kaart: '…0000', status: 'niet_aangeleverd', transacties: 0 }]);
  assert.deepEqual(ov.j.maanden[1].creditcard, [{ kaart: '…0000', status: 'sluit', transacties: 2 }]);
  // concept
  const c = t.R.maandspec.concept(t.fdb, t.rol, '2026-10', { nu, primair: true, aanleiding: 'ronde' });
  assert.equal(c.status, 200, JSON.stringify(c.j));
  assert.equal(c.j.aan, AAN, 'het ene afschriftadres (de boekhouder)');
  assert.equal(c.j.ics_ontbrak, true);
  assert.match(c.j.bericht, /nog niet aangeleverd/);
  assert.equal(c.j.bijlage.mime, 'application/pdf');
  assert.match(pdfTekst(Buffer.from(c.j.bijlage.inhoud_base64, 'base64')), /Creditcard nog niet aangeleverd/);
  assert.equal(t.R.maandspec.concept(t.fdb, t.rol, '2026-10', { nu: nu + 1000, primair: true }).j.code, 'bezig');
  assert.equal(t.R.maandspec.concept(t.fdb, t.rol, '2026-10', { nu, primair: false }).status, 409, 'alleen primair');
  const u = t.R.maandspec.uitkomst(t.fdb, t.rol, '2026-10', { ok: true, concept_id: 'r-proef' }, { nu: nu + 2000, primair: true });
  assert.equal(u.j.specificatie.status, 'klaar');
  assert.equal(u.j.specificatie.ics_ontbrak, true);
  assert.equal(t.R.maandspec.concept(t.fdb, t.rol, '2026-10', { nu: nu + 3000, primair: true }).j.code, 'al_klaar');
  let plan = t.R.maandspec.plan(t.fdb, nu + 4000, '2026-10');
  assert.equal(plan.vorige.maand, '2026-10');
  assert.equal(plan.vorige.binnen, false);
  assert.equal(plan.vorige.nagekomen_kan, false);
  // David uploadt het volledige overzicht in de app
  const bytes = csv(ICS2);
  const up = t.R.app(t.fdb, { methode: 'POST', pad: '/app/facturen/upload', d: { beurt: 'fac-proef-0001', n: 1 }, rol: t.rol, primair: true, nu: nu + 5000,
    uploadNeem: () => ({ naam: 'ics.csv', bytes, weg: () => {} }) });
  assert.equal(up.status, 200, JSON.stringify(up.j));
  assert.equal(up.j.soort, 'creditcard');
  assert.equal(up.j.kaart, '…0000');
  assert.equal(up.j.nieuw, 3);
  plan = t.R.maandspec.plan(t.fdb, nu + 6000, '2026-10');
  assert.equal(plan.vorige.binnen, true);
  assert.equal(plan.vorige.nagekomen_kan, true);
  assert.equal(plan.kaarten.find((k) => k.maand === '2026-10').binnen, true);
  const c2 = t.R.maandspec.concept(t.fdb, t.rol, '2026-10', { nu: nu + 7000, primair: true, nagekomen: true, aanleiding: 'nagekomen' });
  assert.equal(c2.status, 200, JSON.stringify(c2.j));
  assert.match(c2.j.onderwerp, /^Aanvulling: /);
  assert.equal(c2.j.ics_ontbrak, false);
  assert.match(pdfTekst(Buffer.from(c2.j.bijlage.inhoud_base64, 'base64')), /= de ICS-incasso op …0041 .* van 7 oktober 2026 \(€ 30,00\), op de cent/);
  t.R.maandspec.uitkomst(t.fdb, t.rol, '2026-10', { ok: true, concept_id: 'r-proef2' }, { nu: nu + 8000, primair: true });
  assert.equal(t.R.maandspec.plan(t.fdb, nu + 9000, '2026-10').vorige.nagekomen_kan, false, 'één aanvulling');
  // hetzelfde bestand nog eens: al bekend
  const nog = t.R.app(t.fdb, { methode: 'POST', pad: '/app/facturen/upload', d: { beurt: 'fac-proef-0002', n: 1 }, rol: t.rol, primair: true, nu: nu + 10000,
    uploadNeem: () => ({ naam: 'ics.csv', bytes, weg: () => {} }) });
  assert.equal(nog.j.al_bekend, true);
});

test('ICS-kaart: open vanaf 3 dagen na de incasso zolang het overzicht ontbreekt; binnen = later overzicht of som gelijk aan de incasso', () => {
  const t = opzet();
  const plan = t.R.maandspec.plan(t.fdb, Date.parse('2026-10-12T08:00:00Z'), '2026-09');
  const okt = plan.kaarten.find((k) => k.maand === '2026-10'), sep = plan.kaarten.find((k) => k.maand === '2026-09');
  assert.equal(okt.sleutel, 'ics-upload-0000-2026-10');
  assert.equal(okt.incasso_eerste, '2026-10-07');
  assert.equal(okt.open_vanaf, '2026-10-10');
  assert.equal(okt.binnen, false, '10,00 in Facturen, incasso 30,00, geen later overzicht');
  assert.equal(sep.binnen, true, 'september heeft een later overzicht');
  // vóór de incasso: geen open_vanaf
  const nov = t.R.maandspec.plan(t.fdb, Date.parse('2026-11-04T08:00:00Z'), '2026-09').kaarten.find((k) => k.maand === '2026-11');
  assert.equal(nov.incasso_eerste, null); assert.equal(nov.open_vanaf, null);
  // vanaf: geen kaart voor een maand ervóór
  assert.equal(t.R.maandspec.plan(t.fdb, Date.parse('2026-10-12T08:00:00Z'), '2026-10').kaarten.some((k) => k.maand === '2026-09'), false);
});

test('ICS-upload: alleen de eigenaar, niet als factuur, een kaartnummer weigert het hele bestand', () => {
  const t = opzet();
  const nu = Date.parse('2026-10-12T08:00:00Z');
  const neem = (b) => () => ({ naam: 'ics.csv', bytes: b, weg: () => {} });
  const als = (d, rol, b) => t.R.app(t.fdb, { methode: 'POST', pad: '/app/facturen/upload', d: Object.assign({ beurt: 'fac-proef-0003', n: 1 }, d), rol, primair: true, nu, uploadNeem: neem(b) });
  assert.equal(als({ soort: 'factuur' }, t.rol, csv(ICS2)).status, 415);
  assert.equal(als({}, { soort: 'praktijkmanager', wie: 'pm', entiteiten: ['tolgaarde'], ingang: 'fac' }, csv(ICS2)).status, 403);
  const vol = als({}, t.rol, csv([['10-10-2026', '11-10-2026', 'WINKEL 4111 1111 1111 1111 NLD', '****0000', 'D', '5,00', 'EUR', '5,00', 'Transaction', '202611']]));
  assert.equal(vol.status, 422);
  assert.equal(vol.j.code, 'creditcard_kaartnummer');
  assert.equal(t.fdb.db.prepare("SELECT count(*) AS n FROM kaart_regel WHERE overzicht = '202611' OR overzicht = '2026-11'").get().n, 0, 'niets ingelezen');
  // een gewone bankexport blijft een bankexport (geen ICS-kop)
  assert.equal(F.soortVan(Buffer.from('Transactiedatum;Iets anders\n'), 'x.csv'), 'bank');
});

test('route-id past in het doorgeefluik en staat in beide lijsten', () => {
  assert.ok(F.ROUTES.GET.includes('maand-specificatie') && F.ROUTES.POST.includes('maand-specificatie'));
  assert.match('maand-specificatie', /^[a-z0-9/-]{1,64}$/);
});
