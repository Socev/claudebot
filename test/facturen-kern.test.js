'use strict';
// Toetsen voor facturen-kern.js (wv797, Facturen-app F1a). Alles synthetisch: IBAN's met bankcode TEST, "Leverancier A B.V.",
// plaatshouders voor boekhoudadressen. Raakt geen pod, kluis, mail of vault. Draaien: bash test/facturen-kern.sh
const { test } = require('node:test');
const assert = require('node:assert/strict');
// Prestatiegrenzen gelden voor de pod; een CI-runner is trager en wisselt (wv1044: 3115–3882 ms tegen een grens van 3 s in de
// runs 239–253). build.yml zet TOETS_TIJDFACTOR=3; lokaal blijft de grens zoals hij is. Een kwadratische uitschieter valt er nog steeds uit.
const TIJDFACTOR = Math.max(1, Number(process.env.TOETS_TIJDFACTOR) || 1);
const fs = require('fs');
const path = require('path');
const K = require(path.resolve(__dirname, '..', 'facturen-kern.js'));

// ── synthetische stamgegevens ──
function maakIban(land, bank, rek) {
  const r = bank + rek + land + '00';
  let rest = 0;
  for (const ch of r) { const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch; for (const d of v) rest = (rest * 10 + Number(d)) % 97; }
  return land + String(98 - rest).padStart(2, '0') + bank + rek;
}
const IBAN = {
  TG: maakIban('NL', 'TEST', '0000000011'), GH: maakIban('NL', 'TEST', '0000000012'), HOLD: maakIban('NL', 'TEST', '0000000013'),
  PRIVE: maakIban('NL', 'TEST', '0000000019'), A: maakIban('NL', 'TEST', '0000000101'), A2: maakIban('NL', 'TEST', '0000000102'),
  B: maakIban('NL', 'TEST', '0000000201'),
};
const spatie = (i) => i.replace(/(.{4})/g, '$1 ').trim();
const sha = (s) => require('crypto').createHash('sha256').update(String(s)).digest('hex');
const ENT = [
  { sleutel: 'tolgaarde', naam: 'Huisartsenpraktijk Tolgaarde B.V.', naam_kort: 'Tolgaarde', aliassen: ['Tolgaarde'], kvk: '99000001', ibans: [IBAN.TG], boekhoud_doel: '<exact-inkoopadres-tolgaarde>' },
  { sleutel: 'groenhouten', naam: 'Huisartsenpraktijk Groenhouten', naam_kort: 'Groenhouten', aliassen: ['Groenhouten'], kvk: '99000002', ibans: [IBAN.GH], boekhoud_doel: '<exact-inkoopadres-groenhouten>' },
  { sleutel: 'holding', naam: 'Primum Non Nocere Holding B.V.', naam_kort: 'Holding', aliassen: ['PNN Holding'], kvk: '99000003', ibans: [IBAN.HOLD], boekhoud_doel: '<exact-inkoopadres-holding>' },
  { sleutel: 'pot', naam: 'Samenwerkende Werkgevers', naam_kort: 'POT', aliassen: [], ibans: [], boekhoud_doel: '<exact-inkoopadres-pot>' },
  { sleutel: 'prive', naam: 'Privé', aliassen: [{ tekst: 'D. Schaap', gewicht: 1 }], ibans: [IBAN.PRIVE], boekhoud_doel: null },
  { sleutel: 'hagro', naam: 'HAGRO Voorbeeld', aliassen: ['Tolgaarde'], actief: false },
];
const LEV_A = { id: 'a000000000000001', naam: 'Leverancier A B.V.', kvk: '99100001', domeinen: ['leverancier-a.example'], ibans: [IBAN.A], standaard_entiteit: 'tolgaarde', standaard_betaalwijze: 'zelf', mediaan: { tolgaarde: 50000 } };
const LEV_B = { id: 'b000000000000002', naam: 'Leverancier B B.V.', kvk: '99100002', domeinen: ['leverancier-b.example'], ibans: [IBAN.B], standaard_entiteit: 'groenhouten', standaard_betaalwijze: 'incasso' };
const ctxBasis = (extra) => Object.assign({ vandaag: '2026-10-22', entiteiten: ENT, leveranciers: [LEV_A, LEV_B], tekstankers: [], geenFactuur: [], bekendeSha256: [], bestaandeFacturen: [] }, extra || {});
const BERICHT_A = { message_id: 'm1', afzender: 'Leverancier A <facturen@leverancier-a.example>', onderwerp: 'Factuur VB-2026-0412' };

const pdfA = (o) => {
  o = o || {};
  return [
    'Leverancier A B.V.', 'Voorbeeldstraat 1, 1234 AB Voorbeeld', 'KvK 99100001   BTW NL999999999B01', '',
    o.titel || 'FACTUUR', 'Aan: Huisartsenpraktijk Tolgaarde B.V.', 't.a.v. D. Schaap', '',
    'Factuurnummer: ' + (o.nummer || 'VB-2026-0412'), 'Factuurdatum: ' + (o.datum || '12-10-2026'), 'Vervaldatum: ' + (o.verval || '11-11-2026'), '',
    'Omschrijving                         Bedrag', 'Verbruiksmaterialen               1.180,58', '',
    'Subtotaal                          ' + (o.excl || '1.180,58'), 'BTW 21%                              ' + (o.btw || '247,92'),
    'Totaal te betalen                ' + (o.incl || '€ 1.428,50'), '',
    o.betaalzin || ('Gelieve het bedrag binnen 30 dagen over te maken op IBAN ' + spatie(o.iban || IBAN.A) + ' t.n.v. Leverancier A B.V.'),
    'o.v.v. het factuurnummer ' + (o.nummer || 'VB-2026-0412'), o.extra || '',
  ].join('\n');
};
const doc = (tekst, o) => Object.assign({ sha256: sha(tekst + JSON.stringify(o || {})), naam: 'factuur.pdf', mime: 'application/pdf', tekst, tekstlaag: true }, o || {});

function ubl(o) {
  o = o || {};
  const root = o.root || 'Invoice';
  const credit = root === 'CreditNote';
  const p = o.prefix === false ? { cbc: '', cac: '' } : { cbc: 'cbc:', cac: 'cac:' };
  const ns = o.prefix === false
    ? `xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2"`
    : `xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"`;
  const b = (n, v, a) => `<${p.cbc}${n}${a ? ' ' + a : ''}>${v}</${p.cbc}${n}>`;
  const cur = o.valuta || 'EUR';
  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} ${ns}>
  ${b('CustomizationID', o.profiel || 'urn:cen.eu:en16931:2017#compliant#urn:fdc:nen.nl:nlcius:v1.0')}
  ${b('ID', o.nummer || 'VB-2026-0413')}
  ${b('IssueDate', o.datum || '2026-10-12')}
  ${!credit && o.verval !== null ? b('DueDate', o.verval || '2026-11-11') : ''}
  ${b(credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode', o.typecode || (credit ? '381' : '380'))}
  ${o.notitie ? b('Note', o.notitie) : ''}
  ${b('DocumentCurrencyCode', cur)}
  ${o.pdf ? `<${p.cac}AdditionalDocumentReference>${b('ID', '1')}<${p.cac}Attachment><${p.cbc}EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="${o.pdf}">${'QUFB'.repeat(80)}</${p.cbc}EmbeddedDocumentBinaryObject></${p.cac}Attachment></${p.cac}AdditionalDocumentReference>` : ''}
  <${p.cac}AccountingSupplierParty><${p.cac}Party>
    ${b('EndpointID', o.levKvk || '99100001', 'schemeID="0106"')}
    <${p.cac}PartyName>${b('Name', o.levNaam || 'Leverancier A &amp; Zn B.V.')}</${p.cac}PartyName>
    <${p.cac}PartyTaxScheme>${b('CompanyID', 'NL999999999B01')}<${p.cac}TaxScheme>${b('ID', 'VAT')}</${p.cac}TaxScheme></${p.cac}PartyTaxScheme>
    <${p.cac}PartyLegalEntity>${b('RegistrationName', o.levNaam || 'Leverancier A &amp; Zn B.V.')}${b('CompanyID', o.levKvk || '99100001', 'schemeID="0106"')}</${p.cac}PartyLegalEntity>
  </${p.cac}Party></${p.cac}AccountingSupplierParty>
  <${p.cac}AccountingCustomerParty><${p.cac}Party>
    <${p.cac}PartyName>${b('Name', o.klantNaam || 'Huisartsenpraktijk Groenhouten')}</${p.cac}PartyName>
    <${p.cac}PartyLegalEntity>${b('RegistrationName', o.klantNaam || 'Huisartsenpraktijk Groenhouten')}${o.klantKvk ? b('CompanyID', o.klantKvk, 'schemeID="0106"') : ''}</${p.cac}PartyLegalEntity>
  </${p.cac}Party></${p.cac}AccountingCustomerParty>
  <${p.cac}PaymentMeans>
    ${b('PaymentMeansCode', o.betaalcode || '58')}
    ${credit ? b('PaymentDueDate', o.verval || '2026-11-11') : ''}
    ${b('PaymentID', o.kenmerk || '1234567890123456')}
    ${o.betaalcode === '59' ? `<${p.cac}PaymentMandate>${b('ID', 'MANDAAT-1')}<${p.cac}PayerFinancialAccount>${b('ID', o.payer || IBAN.GH)}</${p.cac}PayerFinancialAccount></${p.cac}PaymentMandate>` : `<${p.cac}PayeeFinancialAccount>${b('ID', o.iban || IBAN.A)}</${p.cac}PayeeFinancialAccount>`}
  </${p.cac}PaymentMeans>
  <${p.cac}TaxTotal>${b('TaxAmount', o.btw || '247.92', `currencyID="${cur}"`)}</${p.cac}TaxTotal>
  <${p.cac}${credit ? 'LegalMonetaryTotal' : 'LegalMonetaryTotal'}>
    ${b('LineExtensionAmount', o.excl || '1180.58', `currencyID="${cur}"`)}
    ${b('TaxExclusiveAmount', o.excl || '1180.58', `currencyID="${cur}"`)}
    ${b('TaxInclusiveAmount', o.incl || '1428.50', `currencyID="${cur}"`)}
    ${o.vooraf ? b('PrepaidAmount', o.vooraf, `currencyID="${cur}"`) : ''}
    ${b('PayableAmount', o.tebetalen || o.incl || '1428.50', `currencyID="${cur}"`)}
  </${p.cac}LegalMonetaryTotal>
</${root}>`;
}
const ublDoc = (xml, o) => Object.assign({ sha256: sha(xml), naam: 'factuur.xml', mime: 'application/xml', ubl_xml: xml }, o || {});

// ───────────── basis ─────────────

test('bedragen: NL- en EN-notatie, teken, exact in centen', () => {
  assert.equal(K.bedragNaarCenten('€ 1.234,56'), 123456);
  assert.equal(K.bedragNaarCenten('1,234.56'), 123456);
  assert.equal(K.bedragNaarCenten('1234,56'), 123456);
  assert.equal(K.bedragNaarCenten('-12,50'), -1250);
  assert.equal(K.bedragNaarCenten('12,50-'), -1250);
  assert.equal(K.bedragNaarCenten('12.345'), null);
  assert.equal(K.bedragNaarCenten('1.234.56'), null);
  assert.equal(K.decimaalNaarCenten('1428.5'), 142850);
  assert.equal(K.decimaalNaarCenten('-0.02'), -2);
  assert.equal(K.decimaalNaarCenten('0.105'), 11);
  assert.equal(K.decimaalNaarCenten('abc'), null);
  assert.deepEqual(K.bedragenIn('BTW 21%   247,92   (over 1.180,58)'), [24792, 118058]);
});

test('datums: dd-mm-jjjj, ISO, maandnaam; ongeldige dag weigeren', () => {
  assert.equal(K.leesDatum('12-10-2026'), '2026-10-12');
  assert.equal(K.leesDatum('2026-10-12'), '2026-10-12');
  assert.equal(K.leesDatum('12 oktober 2026'), '2026-10-12');
  assert.equal(K.leesDatum('3 Oct. 2026'), '2026-10-03');
  assert.equal(K.leesDatum('31-02-2026'), null);
  assert.equal(K.leesDatum('12/13/2026'), null);
});

test('IBAN mod-97: synthetisch geldig, NL00TEST… ongeldig, landlengte', () => {
  assert.ok(K.ibanMod97(IBAN.A));
  assert.ok(K.ibanMod97(spatie(IBAN.A).toLowerCase()));
  assert.equal(K.ibanMod97('NL00TEST0000000101'), false);
  assert.equal(K.ibanMod97(IBAN.A + '1'), false);
  assert.ok(K.ibanMod97('GB82WEST12345698765432'));   // voorbeeld uit de norm
  assert.equal(K.ibanMod97('GB82WEST12345698765431'), false);
  const i = K.ibansIn('Betaal op IBAN ' + spatie(IBAN.A) + ' BIC TESTNL2A, of NL00 TEST 0000 0001 01');
  assert.deepEqual(i.map((x) => [x.iban, x.geldig]), [[IBAN.A, true]]);
  const fout = K.ibansIn('IBAN: NL00 TEST 0000 0001 01');
  assert.deepEqual(fout.map((x) => [x.iban, x.geldig]), [['NL00TEST0000000101', false]]);
});

test('BSN-elfproef', () => {
  assert.ok(K.bsnElfproef('111222333'));
  assert.ok(K.bsnElfproef('1112.22.333'));
  assert.equal(K.bsnElfproef('111222334'), false);
  assert.equal(K.bsnElfproef('000000000'), false);
  assert.equal(K.bsnElfproef('12345678'), false);
});

// ───────────── UBL ─────────────

test('UBL 2.1 / SI-UBL 2.0 Invoice: velden, centen, KvK, IBAN, kenmerk, betaalwijze', () => {
  const u = K.leesUbl(ubl());
  assert.equal(u.ok, true);
  assert.equal(u.soort, 'factuur');
  assert.equal(u.si_ubl, true);
  assert.equal(u.nummer, 'VB-2026-0413');
  assert.equal(u.factuurdatum, '2026-10-12');
  assert.equal(u.vervaldatum, '2026-11-11');
  assert.deepEqual([u.excl, u.btw, u.incl], [118058, 24792, 142850]);
  assert.equal(u.leverancier.naam, 'Leverancier A & Zn B.V.');
  assert.equal(u.leverancier.kvk, '99100001');
  assert.equal(u.leverancier.btw, 'NL999999999B01');
  assert.equal(u.iban, IBAN.A);
  assert.equal(u.kenmerk, '1234567890123456');
  assert.equal(u.betaalwijze_hint, 'zelf');
  assert.equal(u.valuta, 'EUR');
});

test('UBL zonder voorvoegsels (standaard-namespace) leest hetzelfde', () => {
  const u = K.leesUbl(ubl({ prefix: false }));
  assert.equal(u.ok, true);
  assert.deepEqual([u.nummer, u.incl, u.iban], ['VB-2026-0413', 142850, IBAN.A]);
});

test('UBL CreditNote: bedragen negatief, vervaldatum uit PaymentMeans', () => {
  const u = K.leesUbl(ubl({ root: 'CreditNote', nummer: 'CN-77', excl: '100.00', btw: '21.00', incl: '121.00' }));
  assert.equal(u.soort, 'creditnota');
  assert.deepEqual([u.excl, u.btw, u.incl], [-10000, -2100, -12100]);
  assert.equal(u.vervaldatum, '2026-11-11');
  const u2 = K.leesUbl(ubl({ typecode: '381', incl: '50.00', excl: '50.00', btw: '0.00' }));
  assert.equal(u2.soort, 'creditnota');
  assert.equal(u2.incl, -5000);
});

test('UBL incasso (code 59 + mandaat) en vooruitbetaald', () => {
  const u = K.leesUbl(ubl({ betaalcode: '59' }));
  assert.equal(u.betaalwijze_hint, 'incasso');
  assert.deepEqual(u.klant_ibans, [IBAN.GH]);
  const v = K.leesUbl(ubl({ vooraf: '1428.50', tebetalen: '0.00' }));
  assert.equal(v.betaalwijze_hint, 'betaald');
});

test('UBL weigert DOCTYPE/ENTITY en kapotte XML; ander XML is geen UBL', () => {
  assert.equal(K.leesUbl('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><Invoice/>').reden, 'xml_doctype');
  assert.equal(K.leesUbl('<Invoice><ID>1</Invoice>').ok, false);
  assert.equal(K.leesUbl('<Invoice><ID>1</ID>').ok, false);
  assert.equal(K.leesUbl('<Bestelling><ID>1</ID></Bestelling>').reden, 'geen_ubl_factuur');
  assert.equal(K.leesUbl(ubl() + '<Invoice><ID>2</ID></Invoice>').ok, false, 'twee wortels');
  assert.equal(K.leesUbl(ubl() + 'rommel').ok, false, 'losse tekst na de wortel');
  const sbd = '<StandardBusinessDocument><Header/>' + ubl().replace(/^<\?xml[^>]*>/, '') + '</StandardBusinessDocument>';
  assert.equal(K.leesUbl(sbd).nummer, 'VB-2026-0413');
});

// ───────────── regex-velden ─────────────

test('PDF-tekst: velden uit de vluchtige tekst', () => {
  const v = K.leesPdfTekst(pdfA());
  assert.equal(v.nummer, 'VB-2026-0412');
  assert.equal(v.factuurdatum, '2026-10-12');
  assert.equal(v.vervaldatum, '2026-11-11');
  assert.deepEqual([v.excl, v.btw, v.incl], [118058, 24792, 142850]);
  assert.equal(v.valuta, 'EUR');
  assert.deepEqual(v.ibans.map((x) => x.iban), [IBAN.A]);
  assert.equal(v.kenmerk, 'VB-2026-0412');
  assert.deepEqual(v.kvks, ['99100001']);
  assert.deepEqual(v.btwnrs, ['NL999999999B01']);
});

test('PDF-tekst: btw over twee tarieven opgeteld, betalingstermijn → vervaldatum', () => {
  const t = 'Factuur nr. 2026/88\nFactuurdatum: 1 oktober 2026\nBetalingstermijn: 14 dagen\nTotaal excl. btw 200,00\nBTW 9% 9,00\nBTW 21% 21,00\nTotaal incl. btw 230,00';
  const v = K.leesPdfTekst(t);
  assert.equal(v.nummer, '2026/88');
  assert.equal(v.vervaldatum, '2026-10-15');
  assert.deepEqual([v.excl, v.btw, v.incl], [20000, 3000, 23000]);
});

// ───────────── fixtures besliskader ─────────────

test('gewone factuur: voorstel Tolgaarde, zelf betalen, alle controles geslaagd, bevestigen mag', () => {
  const r = K.beslisBericht({ bericht: BERICHT_A, documenten: [doc(pdfA())] }, ctxBasis());
  assert.equal(r.facturen.length, 1);
  const f = r.facturen[0];
  assert.equal(f.status, 'te_beoordelen');
  assert.equal(f.leverancier_id, LEV_A.id);
  assert.equal(f.entiteit, 'tolgaarde');
  assert.equal(f.betaalwijze, 'zelf');
  assert.equal(f.iban, IBAN.A);
  assert.equal(f.iban_nieuw, false);
  assert.equal(f.intern, null);
  assert.ok(f.controles.every((c) => c.ok), JSON.stringify(f.controles));
  assert.deepEqual(f.geslaagd.sort(), ['bedragen', 'datums', 'drempel', 'iban_mod97', 'teken', 'valuta']);
  assert.ok(f.redenen.includes('Naam Tolgaarde op de factuur'));
  assert.ok(f.redenen.includes('Leverancier factureert eerder aan Tolgaarde'));
  assert.equal(f.bevestigen.ok, true);
  for (const b of f.besluiten) assert.ok(K.BESLUIT_BRONNEN.includes(b.bron));
  for (const stap of ['dubbel', 'soort', 'patientkenmerk', 'velden', 'entiteit', 'geen_factuur', 'betaalwijze', 'validatie']) assert.ok(f.besluiten.some((b) => b.stap === stap), 'besluit voor stap ' + stap);
});

test('fixture dubbele factuur: zelfde leverancier + nummer + bedrag → dubbel + signaal; zelfde bestand ook', () => {
  const ctx = ctxBasis({ bestaandeFacturen: [{ id: 'f000000000000001', leverancier_id: LEV_A.id, nummer: 'VB 2026 0412', incl: 142850 }] });
  const r = K.beslisBericht({ bericht: BERICHT_A, documenten: [doc(pdfA())] }, ctx);
  assert.equal(r.facturen[0].status, 'dubbel');
  assert.deepEqual(r.signalen, [{ soort: 'dubbele_factuur', factuur_document: r.facturen[0].document, van: 'f000000000000001' }]);
  assert.equal(r.facturen[0].bevestigen.ok, false);
  // ander bedrag = andere factuur
  const r2 = K.beslisBericht({ bericht: BERICHT_A, documenten: [doc(pdfA({ incl: '€ 1.428,51', btw: '247,93' }))] }, ctx);
  assert.equal(r2.facturen[0].status, 'te_beoordelen');
  // zelfde bestand (sha256) al bekend
  const d = doc(pdfA());
  const r3 = K.beslisBericht({ bericht: BERICHT_A, documenten: [d] }, ctxBasis({ bekendeSha256: [d.sha256] }));
  assert.equal(r3.facturen.length, 0);
  assert.equal(r3.documenten[0].uitkomst, 'dubbel');
  assert.equal(r3.signalen[0].zelfde_bestand, true);
});

test('fixture orderbevestiging: geen factuur (ook met "is geen factuur" en "u ontvangt de factuur")', () => {
  const t = 'Leverancier A B.V.\nORDERBEVESTIGING 55123\nDatum: 10-10-2026\nHartelijk dank voor uw bestelling.\nTotaal 1.428,50\nDeze orderbevestiging is geen factuur. U ontvangt de factuur na levering.';
  const r = K.beslisBericht({ bericht: BERICHT_A, documenten: [doc(t)] }, ctxBasis());
  assert.equal(r.facturen[0].status, 'geen_factuur');
  assert.match(r.facturen[0].redenen[0], /orderbevestiging zonder factuurwoord/);
  // een factuur die naar de orderbevestiging verwijst, blijft een factuur
  const r2 = K.beslisBericht({ bericht: BERICHT_A, documenten: [doc(pdfA({ extra: 'Uw orderbevestiging 55123' }))] }, ctxBasis());
  assert.equal(r2.facturen[0].status, 'te_beoordelen');
  // register "geen factuur"
  const r3 = K.beslisBericht({ bericht: { afzender: 'x@leverancier-a.example', onderwerp: 'Nieuwsbrief oktober' }, documenten: [doc(pdfA())] }, ctxBasis({ geenFactuur: [{ patroon: 'nieuwsbrief' }] }));
  assert.equal(r3.facturen[0].status, 'geen_factuur');
});

test('fixture nieuw IBAN bij bekende leverancier: iban_nieuw, Bevestigen geblokkeerd tot Nagebeld', () => {
  const r = K.beslisBericht({ bericht: BERICHT_A, documenten: [doc(pdfA({ iban: IBAN.A2 }))] }, ctxBasis());
  const f = r.facturen[0];
  assert.equal(f.leverancier_id, LEV_A.id, 'leverancier herkend via KvK, niet via het IBAN');
  assert.equal(f.iban, IBAN.A2);
  assert.equal(f.iban_nieuw, true);
  assert.ok(f.redenen.includes('Nieuw IBAN voor een bekende leverancier: eerst nabellen'));
  assert.equal(f.bevestigen.ok, false);
  assert.ok(f.bevestigen.redenen.includes('nieuw IBAN: eerst nabellen'));
  const s = K.statusOvergang('te_beoordelen', 'bevestigen', f);
  assert.equal(s.ok, false);
  assert.match(s.reden, /nabellen/);
  const n = K.nagebeld(f, 'eigenaar', '2026-10-22T10:00:00+02:00');
  assert.deepEqual(n.leverancier_iban, [{ leverancier_id: LEV_A.id, iban: IBAN.A2, toegevoegd_door: 'eigenaar', toegevoegd_op: '2026-10-22T10:00:00+02:00' }]);
  assert.deepEqual(n.factuur.nagebeld_ibans, [IBAN.A2]);
  assert.equal(n.besluit.bron, 'mens');
  const na = Object.assign({}, f, n.factuur);
  assert.equal(K.magBevestigen(na).ok, true);
  assert.deepEqual(K.statusOvergang('te_beoordelen', 'bevestigen', na), { ok: true, naar: 'in_wachtrij' });
  assert.throws(() => K.nagebeld(Object.assign({}, f, { iban_nieuw: false }), 'eigenaar', 'x'), /geen nieuw IBAN/);
  // nabellen hangt aan het IBAN: daarna een ander (nieuw) IBAN invullen → opnieuw geblokkeerd
  const ander = maakIban('NL', 'TEST', '0000000777');
  const herpoort = K.ibanPoort({ iban: ander }, LEV_A, ctxBasis());
  assert.equal(K.magBevestigen(Object.assign({}, na, { iban: ander, ibans_betaal: [ander], ibans_onbekend: herpoort.onbekend, iban_nieuw: herpoort.iban_nieuw })).ok, false);
  // nieuwe leverancier: ook nabellen
  const r2 = K.beslisBericht({ bericht: { afzender: 'x@onbekend.example' }, documenten: [doc(pdfA().replace('KvK 99100001', 'KvK 99100099'))] }, ctxBasis());
  assert.equal(r2.facturen[0].leverancier_id, LEV_A.id, 'onbekende KvK, maar het IBAN is bekend bij leverancier A');
  assert.ok(r2.facturen[0].besluiten.some((b) => b.stap === 'leverancier' && b.toelichting === 'herkend via iban'));
  assert.equal(r2.facturen[0].iban_nieuw, false);
  const r3 = K.beslisBericht({ bericht: { afzender: 'x@onbekend.example' }, documenten: [doc(pdfA({ iban: IBAN.A2 }).replace('KvK 99100001', 'KvK 99100099'))] }, ctxBasis());
  assert.equal(r3.facturen[0].iban_nieuw, true);
  assert.match(r3.facturen[0].redenen.join(' | '), /Nieuwe leverancier/);
});

test('fixture creditnota: UBL en PDF negatief, controle teken', () => {
  const r = K.beslisBericht({ bericht: BERICHT_A, documenten: [ublDoc(ubl({ root: 'CreditNote', nummer: 'CN-77', excl: '100.00', btw: '21.00', incl: '121.00' }))] }, ctxBasis());
  const f = r.facturen[0];
  assert.equal(f.soort, 'creditnota');
  assert.deepEqual([f.excl, f.btw, f.incl], [-10000, -2100, -12100]);
  assert.ok(f.controles.find((c) => c.naam === 'teken').ok);
  assert.ok(f.controles.find((c) => c.naam === 'bedragen').ok);
  const t = pdfA({ titel: 'CREDITNOTA', nummer: 'CN-78', excl: '100,00', btw: '21,00', incl: '121,00' });
  const p = K.beslisBericht({ bericht: BERICHT_A, documenten: [doc(t)] }, ctxBasis()).facturen[0];
  assert.equal(p.soort, 'creditnota');
  assert.deepEqual([p.excl, p.btw, p.incl], [-10000, -2100, -12100]);
  assert.equal(p.status, 'te_beoordelen');
});

test('fixture buitenlandse valuta: USD uit PDF en UBL → melding', () => {
  const t = 'Example Corp Ltd\nINVOICE\nInvoice number: INV-1001\nInvoice date: 2026-10-01\nDue date: 2026-10-31\nSubtotal 100.00\nVAT 0.00\nTotal due USD 120.00\nPlease pay by bank transfer.';
  const f = K.beslisBericht({ bericht: { afzender: 'billing@example.com' }, documenten: [doc(t)] }, ctxBasis()).facturen[0];
  assert.equal(f.valuta, 'USD');
  assert.equal(f.incl, 12000);
  const val = f.controles.find((c) => c.naam === 'valuta');
  assert.equal(val.ok, false);
  assert.equal(val.ernst, 'melding');
  assert.equal(f.controles.find((c) => c.naam === 'bedragen').ok, false, '100 + 0 ≠ 120');
  const u = K.beslisBericht({ bericht: BERICHT_A, documenten: [ublDoc(ubl({ valuta: 'GBP' }))] }, ctxBasis()).facturen[0];
  assert.equal(u.valuta, 'GBP');
  assert.match(u.redenen.join(' | '), /valuta GBP/);
});

test('fixture PDF + UBL uit één bericht = één factuur (velden uit de UBL)', () => {
  const x = ubl({ nummer: 'VB-2026-0413', klantNaam: 'Huisartsenpraktijk Tolgaarde B.V.' });
  const p = doc(pdfA({ nummer: 'VB-2026-0413' }));
  const r = K.beslisBericht({ bericht: BERICHT_A, documenten: [p, ublDoc(x)] }, ctxBasis());
  assert.equal(r.facturen.length, 1);
  const f = r.facturen[0];
  assert.equal(f.document, p.sha256);
  assert.equal(f.ubl_document, sha(x));
  assert.equal(f.leverancier_naam, 'Leverancier A B.V.');
  assert.ok(f.besluiten.some((b) => b.veld === 'nummer' && b.toelichting === 'uit UBL'));
  assert.deepEqual(r.documenten.map((d) => d.rol).sort(), ['document', 'ubl_document']);
  // PDF-nummer onleesbaar, één paar met gelijk bedrag → toch één factuur
  const p2 = doc(pdfA().replace(/Factuurnummer: VB-2026-0412/, 'Ref: ---').replace(/o\.v\.v\.[^\n]*/, ''));
  const r2 = K.beslisBericht({ bericht: BERICHT_A, documenten: [p2, ublDoc(x)] }, ctxBasis());
  assert.equal(r2.facturen.length, 1);
  // twee verschillende nummers → twee facturen
  const r3 = K.beslisBericht({ bericht: BERICHT_A, documenten: [doc(pdfA({ nummer: 'VB-2026-0499' })), ublDoc(x)] }, ctxBasis());
  assert.equal(r3.facturen.length, 2);
});

test('fixture scan zonder tekstlaag → te_beoordelen, geen velden, wel leveranciersstem', () => {
  const r = K.beslisBericht({ bericht: BERICHT_A, documenten: [{ sha256: sha('scan'), naam: 'scan.pdf', mime: 'application/pdf', tekst: '', tekstlaag: false }] }, ctxBasis());
  const f = r.facturen[0];
  assert.equal(f.status, 'te_beoordelen');
  assert.equal(f.scan, true);
  assert.equal(f.incl, null);
  assert.equal(f.nummer, null);
  assert.ok(f.redenen.includes('Scan zonder tekstlaag: velden met de hand invullen'));
  assert.equal(f.leverancier_id, LEV_A.id, 'via het afzenderdomein');
  assert.equal(f.entiteit, 'tolgaarde');
  const foto = K.beslisBericht({ bericht: null, documenten: [{ sha256: sha('foto'), naam: 'IMG_1.jpg', mime: 'image/jpeg' }] }, ctxBasis());
  assert.equal(foto.facturen[0].status, 'te_beoordelen');
  assert.equal(foto.facturen[0].entiteit, null);
});

test('fixture patiëntkenmerk → alleen eigenaar, geen model, geen kenmerk in redenen', () => {
  const t = pdfA({ extra: 'Betreft patiënt: zie dossier\nBSN: 111222333\nGeboortedatum: 01-02-1950' });
  const mk = { factuurnummer: 'MODEL-1', entiteit_hint: 'groenhouten' };
  const r = K.beslisBericht({ bericht: BERICHT_A, documenten: [doc(t)], model_kandidaat: mk }, ctxBasis());
  const f = r.facturen[0];
  assert.equal(f.patientkenmerk, true);
  assert.deepEqual(f.patientkenmerk_soorten, ['bsn', 'patient_geboortedatum']);
  assert.equal(f.alleen_eigenaar, true);
  assert.equal(K.zichtbaarVoor('eigenaar', f), true);
  assert.equal(K.zichtbaarVoor('praktijkmanager', f), false);
  assert.equal(K.zichtbaarVoor('onbekend', f), false);
  assert.ok(!f.besluiten.some((b) => b.bron === 'model'), 'modelkandidaat telt niet bij een patiëntkenmerk');
  const uit = JSON.stringify(r);
  assert.ok(!uit.includes('111222333') && !uit.includes('1950'), 'kenmerk zelf niet in de uitkomst');
  // los BSN-achtig getal zonder label ook; factuurnummer, IBAN en KvK niet
  assert.deepEqual(K.stapPatientkenmerk(['Referentie zorg 111222333 overige tekst'.replace('Referentie zorg', 'Zorg')]).soorten, ['bsn_los']);
  assert.equal(K.stapPatientkenmerk(['Factuurnummer: 111222333']).kenmerk, false);
  assert.equal(K.stapPatientkenmerk(['IBAN ' + maakIban('NL', 'TEST', '0111222333')]).kenmerk, false);
  assert.equal(K.stapPatientkenmerk([pdfA()]).kenmerk, false);
  assert.equal(K.stapPatientkenmerk(['Aantal patiënten: 3']).kenmerk, false);
  assert.equal(K.stapPatientkenmerk(['x'], true).soorten[0], 'koerier');
  // zonder kenmerk telt de modelkandidaat wel als één stem en vult hij alleen lege velden
  const r2 = K.beslisBericht({ bericht: BERICHT_A, documenten: [doc(pdfA())], model_kandidaat: mk }, ctxBasis());
  const f2 = r2.facturen[0];
  assert.equal(f2.nummer, 'VB-2026-0412', 'deterministische waarde wint');
  assert.equal(f2.entiteit, 'tolgaarde');
  assert.ok(f2.besluiten.some((b) => b.bron === 'model' && b.veld === 'entiteit'));
  const f3 = K.beslisBericht({ bericht: BERICHT_A, documenten: [doc(pdfA())] }, ctxBasis()).facturen[0];
  assert.equal(K.zichtbaarVoor('praktijkmanager', f3), true);
  assert.equal(K.zichtbaarVoor('praktijkmanager', Object.assign({}, f3, { entiteit: 'prive' })), false);
  assert.equal(K.zichtbaarVoor('praktijkmanager', Object.assign({}, f3, { entiteit: null })), false, 'zonder entiteit kan het Privé zijn');
});

test('de factuurtekst komt niet in de uitkomst (vluchtig)', () => {
  const zin = 'ZEER-UNIEKE-ZIN-QX7 omschrijving van de levering';
  const r = K.beslisBericht({ bericht: BERICHT_A, documenten: [doc(pdfA({ extra: zin })), ublDoc(ubl({ notitie: 'UBL-NOTITIE-QX8' }))] }, ctxBasis());
  const uit = JSON.stringify(r);
  assert.ok(!uit.includes('QX7') && !uit.includes('QX8') && !uit.includes('Verbruiksmaterialen'));
});

// ───────────── entiteit, betaalwijze, validators ─────────────

test('entiteit: UBL-klant-KvK, tekstanker, staking, inactieve entiteit, klant-IBAN bij incasso', () => {
  const u = K.beslisBericht({ bericht: { afzender: 'x@onbekend.example' }, documenten: [ublDoc(ubl({ levKvk: '99100077', levNaam: 'Leverancier C', klantNaam: 'Een praktijk', klantKvk: '99000002', iban: IBAN.B }))] }, ctxBasis()).facturen[0];
  assert.equal(u.entiteit, 'groenhouten');
  assert.ok(u.redenen.includes('KvK van Groenhouten als klant in de UBL'));
  const anker = K.stapEntiteit({ kvks: [] }, 'Debiteur 4711-X', ctxBasis({ tekstankers: [{ tekst: 'debiteur 4711-x', entiteit: 'holding' }] }), {});
  assert.equal(anker.entiteit, 'holding');
  const staak = K.stapEntiteit({ kvks: [] }, 'Tolgaarde en Groenhouten', ctxBasis(), {});
  assert.equal(staak.entiteit, null);
  assert.match(staak.redenen[0], /Stemmen staken/);
  assert.ok(!K.stapEntiteit({ kvks: [] }, 'Tolgaarde', ctxBasis(), {}).stemmen.some((s) => s.entiteit === 'hagro'));
  const leeg = K.stapEntiteit({ kvks: [] }, 'niets', ctxBasis(), {});
  assert.equal(leeg.entiteit, null);
  const t = 'Factuur 2026-55\nFactuurdatum: 01-10-2026\nTotaal te betalen 50,00\nHet bedrag wordt automatisch afgeschreven van uw rekening ' + IBAN.GH;
  const f = K.beslisBericht({ bericht: { afzender: 'noreply@leverancier-b.example' }, documenten: [doc(t)] }, ctxBasis()).facturen[0];
  assert.equal(f.entiteit, 'groenhouten');
  assert.equal(f.betaalwijze, 'incasso');
  assert.equal(f.iban, null, 'de af te schrijven rekening is geen betaal-IBAN');
  assert.ok(f.redenen.includes('Rekening van Groenhouten staat op de factuur als af te schrijven rekening'));
});

test('betaalwijze: tekst → leverancierstandaard → bankhistorie → onbekend', () => {
  const v = {};
  assert.equal(K.stapBetaalwijze('Het totaalbedrag wordt automatisch geïncasseerd.', v, {}, {}).betaalwijze, 'incasso');
  assert.equal(K.stapBetaalwijze('Voldaan via iDEAL', v, {}, {}).betaalwijze, 'betaald');
  assert.equal(K.stapBetaalwijze('Nog te betalen: € 0,00', v, {}, {}).betaalwijze, 'betaald');
  assert.equal(K.stapBetaalwijze('Gelieve binnen 30 dagen te voldoen', v, {}, {}).betaalwijze, 'zelf');
  assert.equal(K.stapBetaalwijze('Dit bedrag dient binnen 14 dagen te worden voldaan; te betalen vóór 1-11', v, {}, {}).betaalwijze, 'zelf');
  assert.equal(K.stapBetaalwijze('', v, {}, { leverancier: LEV_B }).betaalwijze, 'incasso');
  const bh = K.stapBetaalwijze('', v, {}, { leverancier: { bankhistorie: { incasso: 4, zelf: 1 } } });
  assert.deepEqual([bh.betaalwijze, bh.besluiten[0].bron], ['incasso', 'bank']);
  assert.equal(K.stapBetaalwijze('', v, {}, { leverancier: { bankhistorie: { incasso: 1 } } }).betaalwijze, 'onbekend');
  assert.equal(K.stapBetaalwijze('', { betaalwijze_hint: 'incasso' }, {}, { leverancier: LEV_A }).betaalwijze, 'incasso', 'UBL wint van de leverancierstandaard');
  const f = K.beslisBericht({ bericht: { afzender: 'x@onbekend.example' }, documenten: [doc('Factuur 9\nFactuurdatum: 01-10-2026\nTotaal 50,00')] }, ctxBasis()).facturen[0];
  assert.equal(f.betaalwijze, 'onbekend');
  assert.ok(f.bevestigen.redenen.includes('betaalwijze onbekend'));
  assert.ok(f.bevestigen.redenen.includes('geen entiteit'));
});

test('validators: ±0,02, datums, 3× mediaan, mod-97, eigen IBAN fout/intern', () => {
  const basis = { soort: 'factuur', excl: 10000, btw: 2100, incl: 12102, factuurdatum: '2026-10-01', vervaldatum: '2026-10-31', valuta: 'EUR', entiteit: 'tolgaarde', betaalwijze: 'zelf', iban: IBAN.A };
  const c = (f, lev) => Object.fromEntries(K.valideer(f, ctxBasis(), { leverancier: lev }).controles.map((x) => [x.naam, x]));
  assert.equal(c(basis).bedragen.ok, true);
  assert.equal(c(Object.assign({}, basis, { incl: 12103 })).bedragen.ok, false);
  assert.equal(c(Object.assign({}, basis, { excl: null, btw: null })).bedragen.ok, false, 'niet na te rekenen = melding');
  assert.equal(c(Object.assign({}, basis, { excl: null, btw: 21694, incl: 12500 })).bedrag_volgorde.ok, false);
  assert.equal(c(basis).drempel_vast, undefined);
  assert.equal(c(Object.assign({}, basis, { excl: 826446, btw: 173554, incl: 1000000 })).drempel_vast.ok, false, 'boven € 2.500');
  assert.equal(c(Object.assign({}, basis, { vervaldatum: '2026-09-01' })).datums.ok, false);
  assert.equal(c(Object.assign({}, basis, { factuurdatum: '2026-12-31', vervaldatum: '2027-01-30' })).datums.ok, false);
  assert.equal(c(Object.assign({}, basis, { factuurdatum: '2025-01-01', vervaldatum: '2025-01-31' })).datums.ok, false);
  assert.equal(c(basis, LEV_A).drempel.ok, true);
  assert.equal(c(Object.assign({}, basis, { incl: 150001, excl: 123967, btw: 26034 }), LEV_A).drempel.ok, false);
  const ongeldig = c(Object.assign({}, basis, { iban: 'NL00TEST0000000101' }));
  assert.deepEqual([ongeldig.iban_mod97.ok, ongeldig.iban_mod97.ernst], [false, 'fout']);
  assert.equal(K.magBevestigen(Object.assign({ status: 'te_beoordelen', controles: Object.values(ongeldig) }, basis, { iban: 'NL00TEST0000000101' })).ok, false);
  assert.equal(K.magBevestigen(Object.assign({ status: 'te_beoordelen', controles: Object.values(ongeldig) }, basis, { iban: 'NL00TEST0000000101', betaalwijze: 'incasso' })).ok, true, 'IBAN-fout blokkeert alleen bij zelf betalen');
  const zelf = K.valideer(Object.assign({}, basis, { iban: IBAN.TG }), ctxBasis(), {});
  assert.equal(zelf.controles.find((x) => x.naam === 'iban_eigen').ernst, 'fout');
  const intern = K.valideer(Object.assign({}, basis, { iban: IBAN.HOLD }), ctxBasis(), {});
  assert.equal(intern.intern, 'holding');
  assert.equal(K.ibanPoort(Object.assign({}, basis, { iban: IBAN.HOLD }), null, ctxBasis()).iban_nieuw, false);
});

test('rekening-courant: Holding factureert Tolgaarde → intern, geen nabellen', () => {
  const t = 'PNN Holding\nFactuur RC-2026-10\nAan: Huisartsenpraktijk Tolgaarde B.V.\nFactuurdatum: 01-10-2026\nVervaldatum: 31-10-2026\nTotaal excl. btw 1.000,00\nBTW 0,00\nTotaal te betalen 1.000,00\nGraag overmaken op ' + IBAN.HOLD;
  const f = K.beslisBericht({ bericht: null, documenten: [doc(t)] }, ctxBasis()).facturen[0];
  assert.equal(f.intern, 'holding');
  assert.equal(f.iban_nieuw, false);
  assert.ok(f.redenen.includes('Interne factuur: betaling aan Holding'));
});

// ───────────── leren ─────────────

test('leren uit een bevestiging met wijziging: nieuwe leveranciersstandaard + melding', () => {
  const l = K.leerUitBevestiging({ entiteit: 'tolgaarde', betaalwijze: 'zelf' }, { entiteit: 'groenhouten', betaalwijze: 'zelf' }, LEV_A);
  assert.deepEqual(l.wijzigingen, [{ veld: 'standaard_entiteit', van: 'tolgaarde', naar: 'groenhouten', reden: 'aangepast bij bevestigen' }]);
  assert.equal(l.melding, 'Aangepast — wordt onthouden voor Leverancier A B.V.');
  assert.equal(l.besluiten[0].bron, 'mens');
  const geen = K.leerUitBevestiging({ entiteit: 'tolgaarde', betaalwijze: 'zelf' }, { entiteit: 'tolgaarde', betaalwijze: 'zelf' }, LEV_A);
  assert.deepEqual([geen.wijzigingen, geen.melding], [[], null]);
  const eerst = K.leerUitBevestiging({ entiteit: 'pot', betaalwijze: 'incasso' }, { entiteit: 'pot', betaalwijze: 'incasso' }, { naam: 'Nieuw B.V.' });
  assert.deepEqual(eerst.wijzigingen.map((w) => [w.veld, w.naar, w.reden]), [['standaard_entiteit', 'pot', 'eerste bevestiging'], ['standaard_betaalwijze', 'incasso', 'eerste bevestiging']]);
  assert.equal(eerst.melding, null);
  assert.deepEqual(K.leerUitBevestiging({ entiteit: 'a' }, { entiteit: 'b' }, null).wijzigingen, []);
});

// ───────────── statusovergangen ─────────────

test('statusovergangen: precies de tabel uit § 4.4, elke andere combinatie geweigerd', () => {
  const ok = { entiteit: 'tolgaarde', betaalwijze: 'zelf', iban: IBAN.A, opdracht_status: 'wacht', modus: 'concept' };
  const geldig = new Set(K.STATUS_OVERGANGEN.map((o) => (o[0] || '—') + '|' + o[1]));
  let geweigerd = 0, toegestaan = 0;
  for (const van of [null].concat(K.STATUSSEN)) {
    for (const g of K.GEBEURTENISSEN) {
      const r = K.statusOvergang(van, g, ok);
      if (geldig.has((van || '—') + '|' + g)) {
        const alt = Object.assign({}, ok, { modus: 'versturen' }, van === 'te_beoordelen' && g === 'bevestigen' ? {} : {});
        assert.ok(r.ok || K.statusOvergang(van, g, alt).ok, (van || '—') + ' ' + g + ' hoort te kunnen');
        toegestaan++;
      } else { assert.equal(r.ok, false, (van || '—') + ' ' + g + ' hoort geweigerd'); assert.equal(r.fout, 'ongeldige_overgang'); geweigerd++; }
    }
  }
  assert.equal(toegestaan, 16);
  assert.equal(geweigerd, (K.STATUSSEN.length + 1) * K.GEBEURTENISSEN.length - 16);
  assert.equal(K.statusOvergang('bestaat_niet', 'bevestigen').fout, 'onbekende_status');
  assert.equal(K.statusOvergang('te_beoordelen', 'betalen').fout, 'onbekende_gebeurtenis');
});

test('statusovergangen: voorwaarden (privé, terugdraaien na claimen, modus)', () => {
  assert.deepEqual(K.statusOvergang('te_beoordelen', 'bevestigen', { entiteit: 'tolgaarde', betaalwijze: 'zelf', iban: IBAN.A }), { ok: true, naar: 'in_wachtrij' });
  assert.deepEqual(K.statusOvergang('te_beoordelen', 'bevestigen', { entiteit: 'prive', betaalwijze: 'incasso' }), { ok: true, naar: 'prive_archief' });
  assert.equal(K.statusOvergang('te_beoordelen', 'bevestigen', { entiteit: 'tolgaarde', betaalwijze: 'onbekend' }).ok, false);
  assert.equal(K.statusOvergang('te_beoordelen', 'bevestigen', { betaalwijze: 'zelf' }).ok, false);
  assert.match(K.statusOvergang('te_beoordelen', 'bevestigen', { entiteit: 'tolgaarde', betaalwijze: 'zelf' }).reden, /zonder IBAN/);
  assert.match(K.statusOvergang('te_beoordelen', 'bevestigen', { entiteit: 'tolgaarde', betaalwijze: 'zelf', iban: 'NL00TEST0000000101' }).reden, /IBAN-fout/);
  assert.match(K.statusOvergang('te_beoordelen', 'bevestigen', { entiteit: 'tolgaarde', betaalwijze: 'zelf', iban: IBAN.A2, iban_nieuw: true, ibans_onbekend: [IBAN.A2], nagebeld_op: 'x', nagebeld_ibans: [IBAN.B] }).reden, /nabellen/);
  assert.equal(K.statusOvergang('in_wachtrij', 'terugdraaien', { opdracht_status: 'opgehaald' }).ok, false);
  assert.deepEqual(K.statusOvergang('in_wachtrij', 'terugdraaien', { opdracht_status: 'wacht' }), { ok: true, naar: 'te_beoordelen' });
  assert.deepEqual(K.statusOvergang('prive_archief', 'terugdraaien', {}), { ok: true, naar: 'te_beoordelen' });
  assert.deepEqual(K.statusOvergang('wordt_verstuurd', 'gelukt', { modus: 'concept' }), { ok: true, naar: 'concept_klaar' });
  assert.deepEqual(K.statusOvergang('wordt_verstuurd', 'gelukt', { modus: 'versturen' }), { ok: true, naar: 'verstuurd' });
  assert.equal(K.statusOvergang('wordt_verstuurd', 'gelukt', {}).ok, false);
  assert.equal(K.statusOvergang('verzending_mislukt', 'opnieuw_proberen', { entiteit: 'prive' }).ok, false);
  // privé komt langs geen enkele weg in de wachtrij
  for (const van of [null].concat(K.STATUSSEN)) for (const g of K.GEBEURTENISSEN) {
    const r = K.statusOvergang(van, g, { entiteit: 'prive', betaalwijze: 'zelf', iban: IBAN.A, opdracht_status: 'wacht', modus: 'versturen' });
    assert.ok(!(r.ok && r.naar === 'in_wachtrij'), 'privé naar in_wachtrij via ' + (van || '—') + ' ' + g);
  }
});

test('betaalspoor: begin per betaalwijze, onbekend kan niet, alleen de tabel', () => {
  assert.equal(K.betaalspoorBegin('zelf'), 'te_betalen');
  assert.equal(K.betaalspoorBegin('incasso'), 'incasso_verwacht');
  assert.equal(K.betaalspoorBegin('betaald'), 'betaald_vooraf');
  assert.throws(() => K.betaalspoorBegin('onbekend'), /onbekend/);
  const geldig = new Set(K.BETAALSPOOR_OVERGANGEN.map((o) => o[0] + '|' + o[1]));
  const gebeurtenissen = [...new Set(K.BETAALSPOOR_OVERGANGEN.map((o) => o[1]))].concat(['betalen']);
  for (const van of K.BETAALSPOREN) for (const g of gebeurtenissen) assert.equal(K.betaalspoorOvergang(van, g).ok, geldig.has(van + '|' + g), van + ' ' + g);
  assert.deepEqual(K.betaalspoorOvergang('te_betalen', 'ingevoerd_in_bank'), { ok: true, naar: 'ingevoerd' });
  assert.deepEqual(K.betaalspoorOvergang('ingevoerd', 'ongedaan'), { ok: true, naar: 'te_betalen' });
  assert.deepEqual(K.betaalspoorOvergang('incasso_verwacht', 'toch_zelf_betalen'), { ok: true, naar: 'te_betalen' });
  assert.equal(K.betaalspoorOvergang('betaald_gezien', 'bankmatch').ok, false);
});

// ───────────── opdracht, claimen, verstuur_na ─────────────

test('opdracht: pas na verstuur_na, 30 min, max 3 pogingen, tweede gelukt verandert niets, terugdraaien alleen bij wacht', () => {
  const t0 = Date.parse('2026-10-22T13:00:00Z');
  const op = { status: 'wacht', verstuur_na: '2026-10-22T14:00:00.000Z', poging: 0 };
  assert.equal(K.claimbaar(op, t0).claim, false);
  const c1 = K.opdrachtOvergang(op, 'claim', Date.parse('2026-10-22T14:00:00Z'));
  assert.deepEqual([c1.ok, c1.naar, c1.poging, c1.factuur], [true, 'opgehaald', 1, 'koerier_haalt_op']);
  const opg = { status: 'opgehaald', opgehaald_op: c1.opgehaald_op, poging: 1 };
  assert.equal(K.opdrachtOvergang(opg, 'terugdraaien').ok, false);
  assert.equal(K.claimbaar(opg, Date.parse('2026-10-22T14:29:00Z')).claim, false);
  const c2 = K.opdrachtOvergang(opg, 'claim', Date.parse('2026-10-22T14:31:00Z'));
  assert.deepEqual([c2.ok, c2.poging, c2.factuur], [true, 2, null]);
  assert.equal(K.opdrachtOvergang({ status: 'opgehaald', opgehaald_op: c1.opgehaald_op, poging: 3 }, 'claim', Date.parse('2026-10-22T15:00:00Z')).definitief, true);
  const m2 = K.opdrachtOvergang({ status: 'opgehaald', poging: 2 }, 'mislukt');
  assert.deepEqual([m2.naar, m2.definitief], ['mislukt', false]);
  assert.equal(K.claimbaar({ status: 'mislukt', poging: 2 }, t0).claim, true);
  const m3 = K.opdrachtOvergang({ status: 'opgehaald', poging: 3 }, 'mislukt');
  assert.deepEqual([m3.definitief, m3.factuur], [true, 'mislukt_definitief']);
  assert.equal(K.claimbaar({ status: 'mislukt', poging: 3 }, t0).claim, false);
  assert.deepEqual(K.opdrachtOvergang({ status: 'opgehaald', poging: 1 }, 'gelukt'), { ok: true, naar: 'gelukt', gewijzigd: true, factuur: 'gelukt' });
  assert.deepEqual(K.opdrachtOvergang({ status: 'gelukt', poging: 1 }, 'gelukt'), { ok: true, naar: 'gelukt', gewijzigd: false });
  assert.equal(K.opdrachtOvergang({ status: 'opgehaald', poging: 1 }, 'geweigerd').factuur, 'geweigerd');
  assert.equal(K.claimbaar({ status: 'geweigerd', poging: 1 }, t0).claim, false);
  assert.equal(K.claimbaar({ status: 'teruggedraaid', poging: 0, verstuur_na: '2026-10-22T00:00:00Z' }, t0).claim, false);
  assert.deepEqual(K.opdrachtOvergang(op, 'terugdraaien'), { ok: true, naar: 'teruggedraaid', factuur: 'terugdraaien' });
  assert.equal(K.opdrachtOvergang({ status: 'teruggedraaid' }, 'gelukt').ok, false);
  assert.throws(() => K.claimbaar(op), /nu/);
});

test('verstuur_na: volgende hele uur; dagelijks 17:00 Nederlandse tijd (ook rond de wintertijd)', () => {
  assert.equal(K.verstuurNa(Date.parse('2026-10-22T14:50:00Z')), '2026-10-22T15:00:00.000Z');
  assert.equal(K.verstuurNa(Date.parse('2026-10-22T14:00:00Z')), '2026-10-22T15:00:00.000Z');
  assert.equal(K.verstuurNa(Date.parse('2026-10-22T14:30:00Z'), { soort: 'dagelijks', uur: 17 }), '2026-10-22T15:00:00.000Z');
  assert.equal(K.verstuurNa(Date.parse('2026-10-22T16:30:00Z'), { soort: 'dagelijks', uur: 17 }), '2026-10-23T15:00:00.000Z');
  assert.equal(K.verstuurNa(Date.parse('2026-10-25T00:30:00Z'), { soort: 'dagelijks', uur: 17 }), '2026-10-25T16:00:00.000Z');
  assert.throws(() => K.verstuurNa(Date.parse('2026-10-22T14:00:00Z'), { soort: 'dagelijks', uur: 24 }));
  assert.throws(() => K.verstuurNa());
});

test('maakOpdracht: privé geweigerd, doeladres uit de entiteit, vingerafdruk erbij', () => {
  const f = { id: 'fedcba9876543210', entiteit: 'tolgaarde', betaalwijze: 'incasso', incl: 142850, document: 'a'.repeat(64), doeladres: 'kwaadwillig@voorbeeld.test' };
  const ent = ENT.find((e) => e.sleutel === 'tolgaarde');
  const op = K.maakOpdracht(f, ent, { id: '0123456789abcdef', bijlagen: [{ naam: 'a.pdf', sha256: 'a'.repeat(64) }], verstuur_na: '2026-10-22T15:00:00.000Z' });
  assert.equal(op.doeladres, '<exact-inkoopadres-tolgaarde>');
  assert.equal(op.regel.doeladres, '<exact-inkoopadres-tolgaarde>');
  assert.equal(op.status, 'wacht');
  assert.equal(op.vingerafdruk, K.vingerafdruk(op));
  assert.throws(() => K.maakOpdracht(Object.assign({}, f, { entiteit: 'prive' }), ENT.find((e) => e.sleutel === 'prive'), { id: '0123456789abcdef', bijlagen: ['a'.repeat(64)] }), /privé/);
  assert.throws(() => K.maakOpdracht(f, ENT.find((e) => e.sleutel === 'prive'), { id: '0123456789abcdef', bijlagen: ['a'.repeat(64)] }), /privé/);
  assert.throws(() => K.maakOpdracht(f, ENT.find((e) => e.sleutel === 'groenhouten'), { id: '0123456789abcdef', bijlagen: ['a'.repeat(64)] }), /wijkt af/);
  assert.throws(() => K.maakOpdracht(f, ent, { id: 'op_1', bijlagen: ['a'.repeat(64)] }), /16 hex/);
  assert.throws(() => K.maakOpdracht(f, ent, { id: '0123456789abcdef', bijlagen: ['b'.repeat(64)] }), /niet in de bijlagen/);
  assert.throws(() => K.maakOpdracht(Object.assign({}, f, { betaalwijze: 'zelf', iban: IBAN.A2, iban_nieuw: true, ibans_onbekend: [IBAN.A2] }), ent, { id: '0123456789abcdef', bijlagen: ['a'.repeat(64)] }), /nabellen/);
  assert.throws(() => K.maakOpdracht(Object.assign({}, f, { betaalwijze: 'onbekend' }), ent, { id: '0123456789abcdef', bijlagen: ['a'.repeat(64)] }), /betaalwijze/);
});

// ───────────── vingerafdruk: vaste testvectoren (onafhankelijk berekend met Python json.dumps(separators=(',',':'), ensure_ascii=False)) ─────────────

test('vingerafdruk exact volgens contracten/koerier-api.md (vaste testvectoren)', () => {
  const op = {
    id: '0123456789abcdef', soort: 'boekhouder_factuur', doeladres: 'inkoop-tolgaarde@voorbeeld.test', extra: 'telt niet mee',
    regel: { doeladres: 'inkoop-tolgaarde@voorbeeld.test', bedrag_centen: 142850, entiteit: 'tolgaarde', factuur_id: 'fedcba9876543210' },
    bijlagen: [{ naam: 'VB-2026-0412.pdf', mime: 'application/pdf', sha256: 'a'.repeat(64) }, 'b'.repeat(64)],
  };
  assert.equal(K.vingerafdrukCanoniek(op), '{"id":"0123456789abcdef","soort":"boekhouder_factuur","doeladres":"inkoop-tolgaarde@voorbeeld.test","regel":{"factuur_id":"fedcba9876543210","entiteit":"tolgaarde","bedrag_centen":142850,"doeladres":"inkoop-tolgaarde@voorbeeld.test"},"bijlagen":["' + 'a'.repeat(64) + '","' + 'b'.repeat(64) + '"]}');
  assert.equal(K.vingerafdruk(op), '2b3946502c9782d6bbd8f9b93ce466382dc361929661347ced6dbccdcbf0a37a');
  const af = { id: '00000000000000aa', soort: 'boekhouder_afschrift', doeladres: 'afschrift-pöt@voorbeeld.test', regel: { afschrift_id: '00000000000000bb', entiteit: 'pot', periode: '2026-09', doeladres: 'afschrift-pöt@voorbeeld.test' }, bijlagen: ['c'.repeat(64), 'd'.repeat(64)] };
  assert.ok(K.vingerafdrukCanoniek(af).includes('pöt'), 'niet-ASCII niet ge-escaped');
  assert.equal(K.vingerafdruk(af), 'b964a98a9b18ca29c57a14146fa7373243af3928ff001dbb49ac9f9c1948edf7');
  // volgorde van bijlagen telt; een ander bedrag of adres geeft een andere afdruk
  assert.notEqual(K.vingerafdruk(Object.assign({}, op, { bijlagen: ['b'.repeat(64), 'a'.repeat(64)] })), K.vingerafdruk(op));
  assert.notEqual(K.vingerafdruk(Object.assign({}, op, { regel: Object.assign({}, op.regel, { bedrag_centen: 142851 }) })), K.vingerafdruk(op));
  assert.throws(() => K.vingerafdruk(Object.assign({}, op, { regel: Object.assign({}, op.regel, { bedrag_centen: 1428.5 }) })), /geheel getal/);
  assert.throws(() => K.vingerafdruk(Object.assign({}, op, { bijlagen: ['A'.repeat(64)] })), /sha256/);
  assert.throws(() => K.vingerafdruk(Object.assign({}, op, { bijlagen: [] })), /sha256/);
  assert.throws(() => K.vingerafdruk(Object.assign({}, op, { soort: 'betaling' })), /soort/);
  assert.throws(() => K.vingerafdruk(Object.assign({}, op, { regel: { entiteit: 'tolgaarde', bedrag_centen: 1, doeladres: 'x' } })), /factuur_id/);
  assert.throws(() => K.vingerafdruk(Object.assign({}, op, { regel: Object.assign({}, op.regel, { factuur_id: '' }) })), /factuur_id/);
  assert.throws(() => K.vingerafdruk(Object.assign({}, op, { regel: Object.assign({}, op.regel, { entiteit: 'prive' }) })), /privé/);
});

// ───────────── puurheid (zelfde regel als de CI-poort) ─────────────

test('facturen-kern.js is puur: geen bestand-, netwerk- of procesmodule, geen klok', () => {
  const bron = fs.readFileSync(path.resolve(__dirname, '..', 'facturen-kern.js'), 'utf8').split('\n').filter((r) => !/^\s*(\*|\/\/)/.test(r)).join('\n');
  assert.doesNotMatch(bron, /require\([`'"](node:)?(fs(\/promises)?|os|http|https|net|tls|dgram|dns|child_process|worker_threads|cluster|vm|undici)[`'"]\)|\bfetch\s*\(|process\.|import\(/);
  assert.doesNotMatch(bron.replace(/new Date\(\s*[^)\s]/g, 'NIEUWEDATUM('), /Date\.now\s*\(|new Date\b|(^|[^.A-Za-z0-9_])Date\(|\.format(ToParts)?\(\s*\)|Math\.random/);
  assert.deepEqual((bron.match(/require\(['"][^'"]+['"]\)/g) || []), ["require('crypto')"]);
});

// ───────────── diffreview wv797: vangnetten ─────────────

test('ReDoS: 200.000 tekens witruimte en vulsel lopen in alle stappen snel door', () => {
  const t0 = process.hrtime.bigint();
  const lang = [
    'saldo' + ' '.repeat(200000) + 'x', 'wordt omstreeks ' + ' '.repeat(200000), 'datum' + ' '.repeat(200000) + '1',
    'Factuur' + '\n'.repeat(100000) + 'nummer', 'patiënt geboren op' + ' \n'.repeat(90000), 'IBAN ' + 'NL12 '.repeat(40000),
    '1'.repeat(200000), ('Totaal te betalen ' + '9'.repeat(30) + ',0').repeat(5000), 'gelieve ' + 'a'.repeat(200000) + ' over te maken',
  ];
  for (const t of lang) {
    K.beslisBericht({ bericht: BERICHT_A, documenten: [doc(t)] }, ctxBasis());
    K.stapBetaalwijze(t, {}, {}, {});
    K.stapPatientkenmerk([t]);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 5000 * TIJDFACTOR, 'duurde ' + Math.round(ms) + ' ms (grens ' + 5000 * TIJDFACTOR + ' ms)');
});

test('betaalwijze: voorwaardelijke en mogelijke vormen zijn geen "al betaald"; incassoaanbod wint niet van een betaalverzoek', () => {
  const nietBetaald = [
    'Wanneer het bedrag niet binnen de termijn is betaald, volgt een herinnering. Gelieve binnen 14 dagen over te maken.',
    'Het bedrag kan worden voldaan via iDEAL of overboeking.',
    'Vorig saldo € 0,00\nNieuw saldo € 121,00',
    'Amount paid € 0,00\nAmount due € 121,00',
    'Het bedrag wordt niet automatisch afgeschreven. Graag overmaken op de rekening hieronder.',
  ];
  for (const t of nietBetaald) assert.notEqual(K.stapBetaalwijze(t, {}, {}, {}).betaalwijze, 'betaald', t);
  assert.equal(K.stapBetaalwijze('Wij verzoeken u het bedrag binnen 14 dagen over te maken. Liever automatische incasso? Vraag een machtiging aan.', {}, {}, {}).betaalwijze, 'zelf');
  assert.equal(K.stapBetaalwijze('Het bedrag wordt omstreeks 5 november van uw rekening afgeschreven.', {}, {}, {}).betaalwijze, 'incasso');
  assert.equal(K.stapBetaalwijze('Betaalwijze: automatische incasso', {}, {}, {}).betaalwijze, 'incasso');
  assert.equal(K.stapBetaalwijze('Deze factuur is reeds voldaan.', {}, {}, {}).betaalwijze, 'betaald');
  assert.equal(K.stapBetaalwijze('Betaald op 03-10-2026 via iDEAL', {}, {}, {}).betaalwijze, 'betaald');
  const tegen = K.stapBetaalwijze('Het bedrag wordt automatisch geïncasseerd. Gelieve binnen 14 dagen over te maken.', {}, {}, {});
  assert.deepEqual([tegen.betaalwijze, /tegenstrijdig/.test(tegen.reden)], ['onbekend', true]);
  assert.equal(K.stapBetaalwijze('Het bedrag wordt automatisch geïncasseerd. Gelieve binnen 14 dagen over te maken.', {}, {}, { leverancier: LEV_B }).betaalwijze, 'incasso');
});

test('IBAN-poort: tweede IBAN, vreemd IBAN in incassotaal en andere notaties blokkeren; zelf zonder IBAN blokkeert', () => {
  const tweede = pdfA({ extra: 'Let op: ons rekeningnummer is gewijzigd, maak over naar IBAN ' + IBAN.A2 });
  const f1 = K.beslisBericht({ bericht: BERICHT_A, documenten: [doc(tweede)] }, ctxBasis()).facturen[0];
  assert.deepEqual([f1.iban, f1.iban_nieuw, f1.bevestigen.ok], [IBAN.A2, true, false]);
  assert.deepEqual(f1.ibans_onbekend, [IBAN.A2]);
  assert.match(f1.redenen.join(' | '), /meer dan één IBAN/);
  const n = K.nagebeld(f1, 'eigenaar', '2026-10-22T10:00:00Z');
  assert.equal(K.magBevestigen(Object.assign({}, f1, n.factuur)).ok, true);
  const incassotaal = pdfA({ betaalzin: 'Wij stoppen met incasso, maak over op ' + IBAN.A2 });
  const f2 = K.beslisBericht({ bericht: BERICHT_A, documenten: [doc(incassotaal)] }, ctxBasis()).facturen[0];
  assert.deepEqual([f2.iban, f2.iban_nieuw], [IBAN.A2, true]);
  for (const vorm of [IBAN.A2.replace(/(.{4})/g, '$1-').replace(/-$/, ''), IBAN.A2.slice(0, 2) + ' ' + IBAN.A2.slice(2, 4) + ' ' + spatie(IBAN.A2.slice(4)), IBAN.A2.slice(0, 4) + ' ' + IBAN.A2.slice(4, 8) + ' ' + IBAN.A2.slice(8, 12) + ' ' + IBAN.A2.slice(12, 15) + ' ' + IBAN.A2.slice(15)]) {
    const f = K.beslisBericht({ bericht: BERICHT_A, documenten: [doc(pdfA({ betaalzin: 'Gelieve over te maken op IBAN ' + vorm + ' t.n.v. Leverancier A' }))] }, ctxBasis()).facturen[0];
    assert.deepEqual([f.iban, f.iban_nieuw], [IBAN.A2, true], vorm);
  }
  const zonder = K.beslisBericht({ bericht: BERICHT_A, documenten: [doc(pdfA({ betaalzin: 'Gelieve binnen 30 dagen over te maken.' }))] }, ctxBasis()).facturen[0];
  assert.equal(zonder.iban, null);
  assert.ok(zonder.bevestigen.redenen.includes('zelf betalen zonder IBAN'));
});

test('patiëntkenmerk: samenstellingen en "geb." worden gevangen', () => {
  for (const t of ['Patiëntnaam: J. Voorbeeld\nGeb.datum: 01-02-1950', 'Patiënt: J. Voorbeeld geb. 01-02-1950', 'Cliëntnummer 123 Geboortedatum: 01-02-1950', 'Patiëntgegevens\nGeboortedatum 01-02-1950']) {
    assert.ok(K.stapPatientkenmerk([t]).soorten.includes('patient_geboortedatum'), t);
  }
  assert.equal(K.stapPatientkenmerk(['IBAN ' + maakIban('NL', 'TEST', '0111222333') + '\nnogmaals ' + maakIban('NL', 'TEST', '0111222333')]).kenmerk, false, 'tweede keer hetzelfde IBAN');
});

test('bedragen: "excl" na een totaallabel, ",-", datum na een bedrag, spatie als duizendtal, losse min, betaalzin vóór het totaal', () => {
  const v1 = K.leesPdfTekst('Factuur 1\nTotaalbedrag excl. btw € 100,00\nBtw € 21,00\nTotaalbedrag incl. btw € 121,00');
  assert.deepEqual([v1.excl, v1.btw, v1.incl], [10000, 2100, 12100]);
  const v2 = K.leesPdfTekst('Factuur 2\nTotaal € 1.250,-\nWaarvan btw € 216,94');
  assert.deepEqual([v2.incl, v2.btw], [125000, 21694]);
  assert.equal(K.leesPdfTekst('Factuur 3\nTotaal te betalen: € 121,00 vóór 22.10.2026').incl, 12100);
  assert.equal(K.leesPdfTekst('Factuur 4\nTotaal € 121,00 per 01.11').incl, 12100);
  assert.deepEqual(K.bedragenIn('Totaal € 1 234,56'), [123456]);
  assert.deepEqual(K.bedragenIn('aantal 3 120,00'), [12000]);
  assert.deepEqual(K.bedragenIn('Abonnement oktober - € 12,50'), [1250]);
  assert.deepEqual(K.bedragenIn('Korting -€ 5,00 en € -2,50 en 7,50-'), [-500, -250, -750]);
  const v3 = K.leesPdfTekst('Factuur 5\nGelieve het bedrag binnen 30 dagen te voldoen.\nSubtotaal € 100,00\nBtw 21% € 21,00\nTotaal € 121,00');
  assert.deepEqual([v3.excl, v3.incl], [10000, 12100]);
});

test('creditnota alleen op een kop of nummerlabel, niet op een los woord in de voettekst', () => {
  for (const voet of ['Bij een klacht volgt creditering.', "Creditnota's worden verrekend met de volgende factuur."]) {
    const v = K.leesPdfTekst(pdfA({ extra: voet }));
    assert.deepEqual([v.soort, v.incl], ['factuur', 142850], voet);
  }
  assert.equal(K.leesPdfTekst('Leverancier A\nCreditnotanummer: CN-9\nTotaal 10,00').soort, 'creditnota');
  assert.equal(K.leesPdfTekst('Factuur 6\nTotaal -10,00').soort, 'creditnota', 'negatief totaal');
});

test('kenmerk vraagt minstens één cijfer', () => {
  assert.equal(K.leesPdfTekst('Factuur 7\nGelieve te betalen o.v.v. het factuurnummer.').kenmerk, null);
  assert.equal(K.leesPdfTekst('Factuur 8\nonder vermelding van Voorbeeldnaam').kenmerk, null);
  assert.equal(K.leesPdfTekst('Factuur 9\nBetalingskenmerk: 1234 5678 9012 3456').kenmerk, '1234 5678 9012 3456');
});

test('opdracht drie keer opgehaald zonder resultaat → definitief mislukt', () => {
  const r = K.opdrachtOvergang({ status: 'opgehaald', opgehaald_op: '2026-10-22T14:00:00Z', poging: 3 }, 'claim', Date.parse('2026-10-22T15:00:00Z'));
  assert.deepEqual([r.ok, r.naar, r.definitief, r.factuur], [true, 'mislukt', true, 'mislukt_definitief']);
});

// ───────────── natoets diffreview wv797 ─────────────

test('IBAN-lezer: btw-nummer + woord is nooit een IBAN; onbekend land weigeren; exacte landlengte', () => {
  for (let i = 0; i < 2000; i++) assert.deepEqual(K.ibansIn('Btw-nr NL' + String(100000000 + i * 37).slice(0, 9) + 'B01 KvK 12345678'), []);
  assert.deepEqual(K.ibansIn('IBAN LT12 1000 0111 0100 1000 BIC HABALT22').map((x) => x.iban), ['LT121000011101001000']);
  assert.equal(K.ibanMod97('XX121000011101001000'), false);
  assert.equal(K.ibansIn('IBAN ' + spatie(IBAN.A) + 'X').length, 0, 'laatste stukje loopt over de lengte: liever geen IBAN dan een geplakt (zelf betalen blokkeert dan)');
  assert.equal(K.ibansIn('IBAN ' + spatie(IBAN.A) + ' BIC TESTNL2A').length, 1);
});

test('betaalwijze: "reeds betaald € 0,00", vorige factuur en rentebeding zijn geen betaald; "niets afgeschreven" geen incasso', () => {
  for (const t of ['Reeds betaald: € 0,00\nNog te betalen: € 121,00', 'Uw vorige factuur is betaald, bedankt!', 'Over facturen die na de vervaldatum zijn voldaan, rekenen wij rente.']) {
    assert.notEqual(K.stapBetaalwijze(t, {}, {}, {}).betaalwijze, 'betaald', t);
    assert.equal(K.stapBetaalwijze(t, {}, {}, { leverancier: LEV_A }).betaalwijze, 'zelf', t);
  }
  assert.notEqual(K.stapBetaalwijze('Er wordt niets afgeschreven; maak het bedrag zelf over.', {}, {}, {}).betaalwijze, 'incasso');
  assert.equal(K.stapBetaalwijze('Betaal via bankoverschrijving. Wilt u liever automatische incasso? Vraag dan een machtiging aan.', {}, {}, { leverancier: LEV_A }).betaalwijze, 'zelf');
  assert.equal(K.stapBetaalwijze('Er is een machtiging afgegeven.', {}, {}, {}).betaalwijze, 'incasso', 'zwak patroon zonder standaard');
});

test('bedragen: "nog/bedrag te betalen" als laatste redmiddel, haakjes overslaan, korting met losse min', () => {
  assert.equal(K.leesPdfTekst('Factuur 10\nNog te betalen: € 121,00').incl, 12100);
  assert.equal(K.leesPdfTekst('Factuur 11\nBedrag te betalen: € 121,00').incl, 12100);
  assert.equal(K.leesPdfTekst('Factuur 12\nTotaal 121,00\nBetaald 50,00\nNog te betalen 71,00').incl, 12100);
  const v = K.leesPdfTekst('Factuur 13\nTotaal te betalen (btw € 21,00): € 121,00');
  assert.equal(v.incl, 12100);
  assert.deepEqual(K.bedragenIn('Korting - € 5,00'), [-500]);
  assert.deepEqual(K.bedragenIn('Abonnement oktober - € 12,50'), [1250]);
});

test('nabellen hangt aan de IBANs van nu: gewijzigd IBAN of verouderde vlag blokkeert met verse poort', () => {
  const NL20 = maakIban('NL', 'TEST', '0000000888'), NL91 = maakIban('NL', 'TEST', '0000000999');
  const f = { status: 'te_beoordelen', entiteit: 'tolgaarde', betaalwijze: 'zelf', iban: NL20, iban_nieuw: true, ibans_onbekend: [NL91], nagebeld_ibans: [NL91], nagebeld_op: 'x', leverancier_id: LEV_A.id };
  assert.equal(K.magBevestigen(f).ok, false, 'het gekozen IBAN is niet nagebeld');
  const oud = Object.assign({}, f, { iban_nieuw: false, ibans_onbekend: [], nagebeld_ibans: [] });
  assert.equal(K.magBevestigen(oud).ok, true, 'zonder poort vertrouwt hij de vlag');
  assert.equal(K.magBevestigen(oud, { leverancier: LEV_A, ctx: ctxBasis() }).ok, false, 'met verse poort niet');
  assert.equal(K.magBevestigen(Object.assign({}, oud, { iban: IBAN.A }), { leverancier: LEV_A, ctx: ctxBasis() }).ok, true);
  const n = K.nagebeld(Object.assign({}, f), 'eigenaar', 'y');
  assert.deepEqual(n.factuur.nagebeld_ibans.sort(), [NL20, NL91].sort());
  assert.equal(K.statusOvergang('te_beoordelen', 'bevestigen', Object.assign({}, oud, { poort: { leverancier: LEV_A, ctx: ctxBasis() } })).ok, false);
  assert.throws(() => K.maakOpdracht(Object.assign({ id: 'fedcba9876543210', incl: 100 }, oud), ENT[0], { id: '0123456789abcdef', bijlagen: ['a'.repeat(64)], poort: { leverancier: LEV_A, ctx: ctxBasis() } }), /nabellen/);
});

test('patiëntkenmerk: patiënt met oude datum op één regel en "Geb:"', () => {
  assert.ok(K.stapPatientkenmerk(['Patiënt: J. Voorbeeld (01-02-1950)']).kenmerk);
  assert.ok(K.stapPatientkenmerk(['Naam patiënt: Voorbeeld\nGeb: 01-02-1950']).kenmerk);
  assert.equal(K.stapPatientkenmerk(['Aantal patiënten oktober 2026: 3']).kenmerk, false);
});
