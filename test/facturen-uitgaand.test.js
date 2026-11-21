'use strict';
// wv3660 (David 21-11-2026): uitgaande factuur van een eigen entiteit herkennen, en een scan zonder model lokaal (OCR) lezen als voorstel.
// Alles verzonnen: IBAN's met bankcode TEST, KvK's 99…, het BSN 111222333 is een verzonnen elfproefgetal. Draaien: bash test/facturen-uitgaand.sh
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const K = require(path.resolve(__dirname, '..', 'facturen-kern.js'));

function maakIban(land, bank, rek) {
  const r = bank + rek + land + '00';
  let rest = 0;
  for (const ch of r) { const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch; for (const d of v) rest = (rest * 10 + Number(d)) % 97; }
  return land + String(98 - rest).padStart(2, '0') + bank + rek;
}
const IBAN = { TG: maakIban('NL', 'TEST', '0000000011'), GH: maakIban('NL', 'TEST', '0000000012'), A: maakIban('NL', 'TEST', '0000000101') };
const sha = (s) => require('crypto').createHash('sha256').update(String(s)).digest('hex');
const ENT = [
  { sleutel: 'tolgaarde', naam: 'Huisartsenpraktijk Tolgaarde B.V.', naam_kort: 'Tolgaarde', aliassen: ['Tolgaarde'], kvk: '99000001', ibans: [IBAN.TG] },
  { sleutel: 'groenhouten', naam: 'Huisartsenpraktijk Groenhouten', naam_kort: 'Groenhouten', aliassen: ['Groenhouten'], kvk: '99000002', btw: 'NL999999999B01', ibans: [IBAN.GH] },
  { sleutel: 'prive', naam: 'Privé', aliassen: [{ tekst: 'D. Voorbeeld', gewicht: 1 }], ibans: [] },
];
const ctx = (x) => Object.assign({ vandaag: '2026-11-21', entiteiten: ENT, leveranciers: [], tekstankers: [], geenFactuur: [], bekendeSha256: [], bestaandeFacturen: [] }, x || {});
const NOTA = ['Huisartsenpraktijk Groenhouten', 'Voorbeeldstraat 1, 9999 ZZ Voorbeeld', 'KvK 99000002', '', 'Nota', 'Notanummer: GH-2026-0042', 'Notadatum: 18-11-2026',
  'Vaccinatie (verzonnen)', 'Totaal te betalen € 25,00', 'Graag overmaken op ' + IBAN.GH + ' t.n.v. Huisartsenpraktijk Groenhouten'].join('\n');
const INKOOP = ['Leverancier A B.V.', 'KvK 99100001', 'Factuur', 'Factuurnummer: SCAN-0007', 'Factuurdatum: 19-11-2026', 'Aan: Huisartsenpraktijk Groenhouten',
  'Totaal incl. btw: EUR 42,35', 'IBAN ' + IBAN.A].join('\n');
const scan = (ocr, x) => Object.assign({ sha256: sha(ocr + JSON.stringify(x || {})), naam: 'scan.pdf', mime: 'application/pdf', tekst: '', tekstlaag: false, ocr_tekst: ocr }, x || {});
const tekstPdf = (t) => ({ sha256: sha(t), naam: 'f.pdf', mime: 'application/pdf', tekst: t, tekstlaag: true });
const BER_GH = { message_id: 'm1', afzender: 'Huisartsenpraktijk Groenhouten <info@hapleusden.nl>', onderwerp: 'Nota' };
const een = (bericht, doc, c) => K.beslisBericht({ bericht, documenten: [doc] }, c || ctx()).facturen[0];

test('uitgaande nota van Groenhouten (scan met lokale OCR, eigen domein) → geen_factuur met reden, entiteit Groenhouten', () => {
  const f = een(BER_GH, scan(NOTA));
  assert.equal(f.status, 'geen_factuur');
  assert.match(f.redenen[0], /^Geen factuur: uitgaande factuur van Groenhouten/);
  assert.equal(f.entiteit, 'groenhouten');
  assert.ok(f.besluiten.some((b) => b.stap === 'uitgaand' && b.waarde === 1));
  assert.equal(f.alleen_eigenaar, true, 'review ZOU 5: uitgaande nota alleen voor de eigenaar');
});
test('zelfde nota als PDF met tekstlaag → ook geen_factuur', () => {
  assert.equal(een(BER_GH, tekstPdf(NOTA)).status, 'geen_factuur');
});
test('inkoop blijft inkoop: doorgestuurd, vreemd KvK/IBAN/btw, interne factuur, leveranciersdomein, geen tekst', () => {
  assert.equal(een(Object.assign({}, BER_GH, { onderwerp: 'Fwd: Nota' }), scan(NOTA)).status, 'te_beoordelen', 'doorgestuurd');
  assert.equal(een(Object.assign({}, BER_GH, { onderwerp: 'FW: factuur' }), scan(NOTA)).status, 'te_beoordelen', 'FW');
  assert.equal(een(BER_GH, scan(INKOOP)).status, 'te_beoordelen', 'vreemd KvK en IBAN');
  assert.equal(een(BER_GH, scan(NOTA.replace('KvK 99000002', 'KvK 99100001'))).status, 'te_beoordelen', 'vreemd KvK');
  assert.equal(een(BER_GH, scan(NOTA + '\nBTW NL123456789B01')).status, 'te_beoordelen', 'vreemd btw-nummer');
  assert.equal(een(BER_GH, scan(NOTA + '\nIBAN ' + IBAN.A)).status, 'te_beoordelen', 'vreemd IBAN');
  assert.equal(een(BER_GH, scan(NOTA + '\nAan: Huisartsenpraktijk Tolgaarde B.V.')).status, 'te_beoordelen', 'interne factuur');
  assert.equal(een({ message_id: 'm2', afzender: 'facturen@leverancier-a.example', onderwerp: 'Factuur' }, scan(NOTA)).status, 'te_beoordelen', 'ander domein');
  assert.equal(een(BER_GH, scan(NOTA.replace(/Groenhouten/g, 'Voorbeeldpraktijk').replace('KvK 99000002', ''))).status, 'te_beoordelen', 'eigen naam niet op het stuk');
  assert.equal(een(BER_GH, scan(null)).status, 'te_beoordelen', 'geen OCR-tekst');
  assert.equal(een({ message_id: 'm3', afzender: 'x@tolgaarde-onbekend.example' }, tekstPdf(NOTA)).status, 'te_beoordelen');
});
test('scan zonder model met lokale OCR → velden als voorstel (nummer, datum, bedrag), reden OCR, besluit "uit lokale OCR"', () => {
  const f = een({ message_id: 'm4', afzender: 'facturen@leverancier-a.example', onderwerp: 'Factuur' }, scan(INKOOP));
  assert.equal(f.status, 'te_beoordelen');
  assert.equal(f.nummer, 'SCAN-0007'); assert.equal(f.factuurdatum, '2026-11-19'); assert.equal(f.incl, 4235);
  assert.ok(f.redenen.includes('Scan zonder tekstlaag: velden lokaal gelezen (OCR), alleen een voorstel: nakijken'), JSON.stringify(f.redenen));
  assert.ok(f.besluiten.some((b) => b.stap === 'velden' && b.veld === 'nummer' && b.bron === 'regel' && b.toelichting === 'uit lokale OCR (voorstel)'));
  assert.equal(f.alleen_eigenaar, false);
});
test('scan zonder OCR → zoals vroeger: met de hand invullen', () => {
  const f = een({ message_id: 'm5', afzender: 'facturen@leverancier-a.example' }, scan(null));
  assert.ok(f.redenen.includes('Scan zonder tekstlaag: velden met de hand invullen'));
  assert.equal(f.nummer, null);
});
test('BSN in de lokale OCR van een scan → patiëntkenmerk, alleen de eigenaar', () => {
  const f = een({ message_id: 'm6', afzender: 'facturen@leverancier-a.example' }, scan(INKOOP + '\nBSN: 111222333'));
  assert.equal(f.patientkenmerk, true); assert.equal(f.alleen_eigenaar, true);
});
test('scan met live modelkandidaat: OCR-velden niet als voorstel (Claude blijft de bron, OCR de controle)', () => {
  const mk = { live: true, soort_stuk: 'factuur', factuurnummer: 'MODEL-1', factuurdatum: '2026-11-19', bedrag_incl: '42.35' };
  const f = een({ message_id: 'm7', afzender: 'facturen@leverancier-a.example' }, scan(INKOOP, { model_kandidaat: mk }));
  assert.equal(f.nummer, 'MODEL-1');
  assert.ok(f.redenen.includes('Scan: velden gelezen door Claude, de lokale OCR is de controle'));
  assert.ok(!f.besluiten.some((b) => b.toelichting === 'uit lokale OCR (voorstel)'));
});

test('review: misgelezen IBAN telt als vreemd (MOET 1); zonder eigen KvK/btw/rekening geen bewijs (ZOU 2); doorstuurvarianten (KAN 7)', () => {
  const fout = IBAN.A.slice(0, -1) + (IBAN.A.slice(-1) === '7' ? '8' : '7');   // één teken fout: mod-97 klopt niet meer
  assert.equal(een(BER_GH, scan(NOTA + '\nIBAN ' + fout)).status, 'te_beoordelen', 'misgelezen vreemd IBAN');
  const kaal = NOTA.replace('KvK 99000002', '').replace(/Graag overmaken.*$/m, 'Betaald per pin');
  assert.equal(een(BER_GH, scan(kaal)).status, 'te_beoordelen', 'alleen de naam: geen bewijs');
  assert.equal(een(BER_GH, scan(kaal + '\nBTW NL 9999.99.999.B01')).status, 'te_beoordelen', 'btw met punten herkent leesPdfTekst niet: blijft veilig in Beoordelen');
  assert.equal(een(BER_GH, scan(kaal + '\nIBAN ' + IBAN.GH)).status, 'geen_factuur', 'eigen rekening is bewijs');
  assert.equal(een(BER_GH, scan(kaal + '\nIBAN ' + IBAN.TG)).status, 'te_beoordelen', 'rekening van een andere eigen entiteit is geen bewijs voor deze');
  for (const o of ['Doorgestuurd: nota', '[EXTERN] FW: nota', 'Re: FW: nota', 'RE: Fwd: x', 'Antw: Doorst: x'])
    assert.equal(een(Object.assign({}, BER_GH, { onderwerp: o }), scan(NOTA)).status, 'te_beoordelen', o);
  assert.equal(een(Object.assign({}, BER_GH, { onderwerp: 'Re: uw vraag' }), scan(NOTA)).status, 'geen_factuur', 'gewoon Re: is geen doorsturen');
});
test('robuust: null-bericht, afzender zonder @, rare entiteiten crashen niet', () => {
  assert.equal(een(null, scan(NOTA)).status, 'te_beoordelen');
  assert.equal(een({ message_id: 'x', afzender: 'geen-adres' }, scan(NOTA)).status, 'te_beoordelen');
  assert.equal(K.stapUitgaand(NOTA, null, BER_GH, { entiteiten: [] }).uitgaand, false);
  assert.equal(K.stapUitgaand(NOTA, {}, BER_GH, null).uitgaand, false);
});
