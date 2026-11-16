'use strict';
// Toetst de betaallijst van een POT-loonrun uit Nmbrs (wv3208, 16-11-2026): nmbrs-betaal.js (lezen van het SEPA-bestand van Nmbrs, controles,
// het nieuwe pain.001.001.09 met Davids betaaldatum tegen het XSD) en de kindopdrachten in nmbrs-data.js (ronde haalt het bestand van een
// vergrendelde POT-run op tegen een nagebootste API op 127.0.0.1; betaallijst, betaalbestand, betaalgemeld). ALLEEN VERZONNEN gegevens:
// IBAN's met bankcode TEST (geldige mod-97), namen "Proef …". Raakt de pod en /opt/data/nmbrs niet. Gebruik: node --test test/nmbrs-betaal.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawnSync, spawn } = require('child_process');
const B = require('../nmbrs-betaal.js');
const SCRIPT = path.join(__dirname, '..', 'nmbrs-data.js');
const XSD = path.join(__dirname, 'schema', 'pain.001.001.09.xsd');

const I1 = 'NL69TEST0000000001', I2 = 'NL42TEST0000000002', I3 = 'NL15TEST0000000003', POT = 'NL31ABNA0000000099';
function xsd(tekst) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-')), 'b.xml');
  fs.writeFileSync(p, tekst);
  const r = spawnSync('python3', ['-I', '-c', 'import sys\nfrom lxml import etree\ns=etree.XMLSchema(etree.parse(sys.argv[1]))\nok=s.validate(etree.parse(sys.argv[2]))\n' +
    'print("OK" if ok else "FOUT " + str(s.error_log))', XSD, p], { encoding: 'utf8' });
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
  if (r.status !== 0 && /No module named/.test(r.stderr || '')) return null;
  return (r.stdout || '').trim() || r.stderr;
}
// Een SEPA-bestand zoals een salarispakket het maakt: pain.001.001.03, met voorvoegsel, entiteiten in een naam, bedrag met één decimaal.
function nmbrsPain(o) {
  o = o || {};
  const regels = o.regels || [['Proef, Anna', I1, '2345.6', 'E2E-101'], ['Voorbeeld &amp; Co, Bert', I2, '1500.00', 'E2E-102'], ['Toets, Cor', I3, '987.65', 'E2E-103']];
  const som = o.som || '4833.25', nb = o.nb || String(regels.length);
  return '<?xml version="1.0" encoding="UTF-8"?>\n<p:Document xmlns:p="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><p:CstmrCdtTrfInitn>' +
    '<p:GrpHdr><p:MsgId>NMBRS-1</p:MsgId><p:NbOfTxs>' + nb + '</p:NbOfTxs><p:CtrlSum>' + som + '</p:CtrlSum><p:InitgPty><p:Nm>Proef POT</p:Nm></p:InitgPty></p:GrpHdr>' +
    '<p:PmtInf><p:PmtInfId>P1</p:PmtInfId><p:PmtMtd>TRF</p:PmtMtd><p:ReqdExctnDt>2026-11-25</p:ReqdExctnDt><p:Dbtr><p:Nm>Proef POT</p:Nm></p:Dbtr>' +
    '<p:DbtrAcct><p:Id><p:IBAN>' + (o.dbtr || POT) + '</p:IBAN></p:Id></p:DbtrAcct>' +
    regels.map((r) => '<p:CdtTrfTxInf><p:PmtId><p:EndToEndId>' + r[3] + '</p:EndToEndId></p:PmtId><p:Amt><p:InstdAmt Ccy="EUR">' + r[2] + '</p:InstdAmt></p:Amt>' +
      '<p:Cdtr><p:Nm>' + r[0] + '</p:Nm></p:Cdtr><p:CdtrAcct><p:Id><p:IBAN>' + r[1] + '</p:IBAN></p:Id></p:CdtrAcct><p:RmtInf><p:Ustrd>Salaris periode 11</p:Ustrd></p:RmtInf></p:CdtTrfTxInf>').join('') +
    '</p:PmtInf></p:CstmrCdtTrfInitn></p:Document>';
}

test('lezen: pain.001.001.03 met voorvoegsel, entiteiten, bedragen in centen, van-rekening', () => {
  const p = B.leesPain(nmbrsPain());
  assert.equal(p.ok, true); assert.equal(p.formaat, 'pain.001.001.03'); assert.equal(p.nb, 3); assert.equal(p.ctrl_centen, 483325);
  assert.deepEqual(p.regels.map((r) => r.centen), [234560, 150000, 98765]);
  assert.equal(p.regels[1].naam, 'Voorbeeld & Co, Bert'); assert.equal(p.dbtr.iban, POT); assert.equal(p.regels[0].e2e, 'E2E-101');
});
test('lezen: geen pain.001 of met DOCTYPE → niet ok', () => {
  assert.equal(B.leesPain('<x>' + 'a'.repeat(100) + '</x>').ok, false);
  assert.equal(B.leesPain('<!DOCTYPE x [<!ENTITY a "b">]>' + nmbrsPain()).ok, false);
});
test('controle: alles goed → geen harde punten; aantal medewerkers wijkt af → zacht', () => {
  const p = B.leesPain(nmbrsPain());
  assert.deepEqual(B.controle(p, { medewerkers_run: 3, pot_iban: POT }), { hard: [], zacht: [], aantal: 3, totaal_centen: 483325 });
  assert.deepEqual(B.controle(p, { medewerkers_run: 4, pot_iban: POT }).zacht, ['aantal_medewerkers']);
  assert.deepEqual(B.controle(p, { medewerkers_run: null, pot_iban: POT }).zacht, ['medewerkers_run_onbekend']);
  assert.deepEqual(B.controle(B.leesPain(nmbrsPain({ dbtr: I3 })), { medewerkers_run: 3, pot_iban: POT }).zacht, ['andere_van_rekening']);
});
test('controle: harde punten (mod-97, negatief, som, aantal, dubbel, geen POT-rekening)', () => {
  const h = (o, x) => B.controle(B.leesPain(nmbrsPain(o)), Object.assign({ medewerkers_run: 3, pot_iban: POT }, x || {})).hard;
  assert.ok(h({ regels: [['Proef, A', 'NL70TEST0000000001', '10.00', 'a']], som: '10.00' }).includes('iban_mod97'));
  assert.ok(h({ regels: [['Proef, A', I1, '-10.00', 'a']], som: '-10.00' }).includes('bedrag_niet_positief'));
  assert.ok(h({ regels: [['Proef, A', I1, '0.00', 'a']], som: '0.00' }).includes('bedrag_niet_positief'));
  assert.ok(h({ som: '4833.26' }).includes('som_kop'));
  assert.ok(h({ nb: '4' }).includes('aantal_kop'));
  assert.ok(h({ regels: [['Proef, A', I1, '10.00', 'a'], ['Proef, B', I1, '10.00', 'b']], som: '20.00' }).includes('dubbel'));
  assert.ok(h({}, { pot_iban: null }).includes('pot_rekening_onbekend'));
  assert.ok(h({}, { pot_iban: 'NL00ABNA0000000099' }).includes('pot_rekening_onbekend'));
  assert.deepEqual(h({}), []);
});
test('review MOET 1+2: valuta met enkele aanhalingstekens of zonder → hard; tweede blok met andere van-rekening → zacht', () => {
  const usd = nmbrsPain().replace('<p:InstdAmt Ccy="EUR">1500.00', "<p:InstdAmt Ccy='USD'>1500.00");
  assert.ok(B.controle(B.leesPain(usd), { medewerkers_run: 3, pot_iban: POT }).hard.includes('geen_euro'));
  const geen = nmbrsPain().replace('<p:InstdAmt Ccy="EUR">1500.00', '<p:InstdAmt>1500.00');
  assert.ok(B.controle(B.leesPain(geen), { medewerkers_run: 3, pot_iban: POT }).hard.includes('geen_euro'));
  const eurEnkel = nmbrsPain().replace('<p:InstdAmt Ccy="EUR">1500.00', "<p:InstdAmt Ccy='EUR'>1500.00");
  assert.deepEqual(B.controle(B.leesPain(eurEnkel), { medewerkers_run: 3, pot_iban: POT }).hard, []);
  const tweeBlokken = nmbrsPain().replace('</p:PmtInf></p:CstmrCdtTrfInitn>', '</p:PmtInf><p:PmtInf><p:PmtInfId>P2</p:PmtInfId><p:DbtrAcct><p:Id><p:IBAN>' + I3 + '</p:IBAN></p:Id></p:DbtrAcct>' +
    '<p:CdtTrfTxInf><p:PmtId><p:EndToEndId>E2E-104</p:EndToEndId></p:PmtId><p:Amt><p:InstdAmt Ccy="EUR">1.00</p:InstdAmt></p:Amt><p:Cdtr><p:Nm>Proef, D</p:Nm></p:Cdtr><p:CdtrAcct><p:Id><p:IBAN>NL85TEST0000000004</p:IBAN></p:Id></p:CdtrAcct></p:CdtTrfTxInf></p:PmtInf></p:CstmrCdtTrfInitn>')
    .replace('<p:NbOfTxs>3</p:NbOfTxs><p:CtrlSum>4833.25', '<p:NbOfTxs>4</p:NbOfTxs><p:CtrlSum>4834.25');
  const c = B.controle(B.leesPain(tweeBlokken), { medewerkers_run: 4, pot_iban: POT });
  assert.deepEqual(c.hard, []); assert.deepEqual(c.zacht, ['andere_van_rekening']);
});
test('bestand: datum, bewust, harde controle; geldig pain.001.001.09 met Davids datum en de POT-rekening', () => {
  const p = B.leesPain(nmbrsPain());
  const run = { year: 2026, number: 12, periodEnd: 11 };
  const basis = { run, periode_soort: 'month', regels: p.regels, pot: { iban: POT, naam: 'Samenwerkende Werkgevers Proef (POT)' }, vandaag: '2026-11-16', msg_hex: '0a1b2c3d', cre_dt_tm: '2026-11-16T12:00:00' };
  assert.equal(B.bestand(Object.assign({}, basis, { controle: B.controle(p, { medewerkers_run: 3, pot_iban: POT }), datum: '2026-11-21' })).code, 'datum');   // zaterdag
  assert.equal(B.bestand(Object.assign({}, basis, { controle: B.controle(p, { medewerkers_run: 3, pot_iban: POT }), datum: '2026-11-13' })).code, 'datum');   // voorbij
  assert.equal(B.bestand(Object.assign({}, basis, { controle: B.controle(p, { medewerkers_run: 4, pot_iban: POT }), datum: '2026-11-25' })).code, 'bewust');
  assert.equal(B.bestand(Object.assign({}, basis, { controle: { hard: ['iban_mod97'], zacht: [] }, datum: '2026-11-25' })).code, 'controle');
  const u = B.bestand(Object.assign({}, basis, { controle: B.controle(p, { medewerkers_run: 4, pot_iban: POT }), datum: '2026-11-25', bewust: true }));
  assert.equal(u.ok, true); assert.equal(u.aantal, 3); assert.equal(u.totaal_centen, 483325);
  assert.equal(u.naam, 'POT-salarissen-2026-R12-betaal-2026-11-25.xml');
  assert.match(u.tekst, /<ReqdExctnDt><Dt>2026-11-25<\/Dt><\/ReqdExctnDt>/);
  assert.match(u.tekst, new RegExp('<DbtrAcct><Id><IBAN>' + POT + '</IBAN>'));
  assert.match(u.tekst, /<CtrlSum>4833.25<\/CtrlSum>/);
  assert.match(u.tekst, /<Nm>Voorbeeld en Co, Bert<\/Nm>/);
  assert.match(u.tekst, /<EndToEndId>E2E-101<\/EndToEndId>/);
  const v = xsd(u.tekst);
  if (v === null) console.log('# lxml ontbreekt: XSD overgeslagen'); else assert.equal(v, 'OK');
});
test('maandTekst en bestandsnaam zonder namen', () => {
  assert.equal(B.maandTekst({ year: 2026, periodEnd: 11 }, 'month'), 'november 2026');
  assert.equal(B.maandTekst({ year: 2026, periodEnd: 11 }, '4-weeks'), 'periode 11 2026');
});

// ── wv3228: vorm van het Nmbrs-document (vingerafdruk zonder inhoud) en uitpakken ───────────────────────────────────────
const zlib = require('zlib');
// Minimale zip (verzonnen inhoud): methode 8 (deflate) of 0; met descriptor = groottes alleen in de centrale map en een data descriptor.
function maakZip(bestanden, o) {
  o = o || {};
  const lok = [], cd = []; let off = 0;
  for (const f of bestanden) {
    const naam = Buffer.from(f.naam, 'utf8'), data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const meth = f.meth == null ? 8 : f.meth, comp = meth === 8 ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32 ? zlib.crc32(data) : 0, vlag = (o.descriptor ? 8 : 0) | (f.versleuteld ? 1 : 0);
    const usz = f.usz != null ? f.usz : data.length;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(vlag, 6); lh.writeUInt16LE(meth, 8);
    lh.writeUInt32LE(o.descriptor ? 0 : crc, 14); lh.writeUInt32LE(o.descriptor ? 0 : comp.length, 18); lh.writeUInt32LE(o.descriptor ? 0 : usz, 22); lh.writeUInt16LE(naam.length, 26);
    const dd = o.descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (o.descriptor) { dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(comp.length, 8); dd.writeUInt32LE(usz, 12); }
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(vlag, 8); ch.writeUInt16LE(meth, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(usz, 24); ch.writeUInt16LE(naam.length, 28); ch.writeUInt32LE(off, 42);
    lok.push(lh, naam, comp, dd); cd.push(ch, naam); off += 30 + naam.length + comp.length + dd.length;
  }
  const cdb = Buffer.concat(cd), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(bestanden.length, 8); e.writeUInt16LE(bestanden.length, 10); e.writeUInt32LE(cdb.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat(lok.concat([cdb, e]));
}
const geenInhoud = (v) => { const t = JSON.stringify(v); return ![I1, I2, I3, POT, 'Proef', 'Anna', '2345', 'E2E-', 'Salaris'].some((x) => t.includes(x)); };
function leesVia(buf, ct) { const o = B.ontpak(buf, ct); return { o, p: o.tekst == null ? null : B.leesPain(o.tekst) }; }
test('wv3228 ontpak: utf-8 (met/zonder BOM), utf-16 LE/BE met BOM en zonder BOM → leesbaar, vorm zonder inhoud', () => {
  const x = nmbrsPain();
  for (const [naam, buf, begin] of [['utf8', Buffer.from(x, 'utf8'), 'xml'], ['utf8-bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(x)]), 'xml'],
    ['utf16le-bom', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(x.replace('UTF-8', 'UTF-16'), 'utf16le')]), 'utf16-bom'],
    ['utf16be-bom', (() => { const b = Buffer.from(x, 'utf16le'); b.swap16(); return Buffer.concat([Buffer.from([0xfe, 0xff]), b]); })(), 'utf16-bom'],
    ['utf16le-zonder', Buffer.from(x, 'utf16le'), 'utf16']]) {
    const { o, p } = leesVia(buf, 'application/xml; charset=utf-8');
    assert.equal(p && p.ok, true, naam); assert.equal(p.regels.length, 3, naam);
    assert.equal(o.vorm.begin, begin, naam); assert.equal(o.vorm.ct, 'application/xml', naam); assert.equal(o.vorm.bytes, buf.length, naam);
    assert.equal(o.vorm.wortel, 'Document', naam); assert.equal(o.vorm.ns, 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.03', naam);
    assert.ok(geenInhoud(o.vorm), naam + ' ' + JSON.stringify(o.vorm));
  }
});
test('wv3228 ontpak: base64, JSON-omhulsel (content / data.content / willekeurig veld / JSON-string), zip deflate/stored/descriptor → leesbaar', () => {
  const x = nmbrsPain(), b = Buffer.from(x).toString('base64');
  const gevallen = [
    ['base64', Buffer.from(b.replace(/(.{76})/g, '$1\r\n')), ['base64', 'xml']],
    ['json-content', Buffer.from(JSON.stringify({ fileName: 'Proef Anna.xml', contentType: 'application/xml', content: b })), ['json', 'xml']],
    ['json-data', Buffer.from(JSON.stringify({ data: { fileContent: b }, ok: true })), ['json', 'xml']],
    ['json-anders', Buffer.from(JSON.stringify({ naamloos: b, x: 1 })), ['json', 'xml']],
    ['json-string', Buffer.from(JSON.stringify(b)), ['json', 'xml']],
    ['json-xml-tekst', Buffer.from(JSON.stringify({ content: x })), ['json', 'xml']],
    ['zip-deflate', maakZip([{ naam: 'SEPA Proef Anna.xml', data: x }]), ['zip', 'xml']],
    ['zip-stored', maakZip([{ naam: 'a.xml', data: x, meth: 0 }]), ['zip', 'xml']],
    ['zip-descriptor', maakZip([{ naam: 'map/', data: '' , meth: 0 }, { naam: 'b.XML', data: x }, { naam: 'leesmij.txt', data: 'hallo' }], { descriptor: true }), ['zip', 'xml']],
    ['base64-zip', Buffer.from(maakZip([{ naam: 'c.xml', data: x }]).toString('base64')), ['base64', 'zip', 'xml']],
    ['json-zip', Buffer.from(JSON.stringify({ content: maakZip([{ naam: 'd.xml', data: x }]).toString('base64') })), ['json', 'zip', 'xml']],
  ];
  for (const [naam, buf, lagen] of gevallen) {
    const { o, p } = leesVia(buf, 'application/octet-stream');
    assert.equal(p && p.ok, true, naam + ' ' + JSON.stringify(o.vorm)); assert.equal(p.regels.length, 3, naam); assert.deepEqual(o.vorm.lagen, lagen, naam);
    assert.ok(geenInhoud(o.vorm), naam + ' ' + JSON.stringify(o.vorm));
  }
  const j = B.ontpak(Buffer.from(JSON.stringify({ fileName: 'Proef Anna.xml', content: b })), 'application/json').vorm;
  assert.deepEqual(j.json_sleutels, ['fileName', 'content']); assert.equal(j.ct, 'application/json');
});
test('wv3228 ontpak: niet te lezen → tekst null, vorm beschrijft het (pdf, json zonder inhoud, zip met twee xml, versleuteld, te groot, leeg)', () => {
  const x = nmbrsPain();
  const v = (buf, ct) => { const o = B.ontpak(buf, ct); assert.equal(o.tekst, null, JSON.stringify(o.vorm)); assert.ok(geenInhoud(o.vorm), JSON.stringify(o.vorm)); return o.vorm; };
  assert.equal(v(Buffer.from('%PDF-1.4\nProef Anna NL69TEST0000000001\n'), 'application/pdf').begin, 'anders');
  const j = v(Buffer.from(JSON.stringify({ status: 'Proef Anna', 'NL69TEST0000000001': 1, aantal: 3 })), 'application/json');
  assert.equal(j.json, 'geen_inhoudsveld'); assert.deepEqual(j.json_sleutels, ['status', '?', '?']); assert.equal(j.json_aantal, 3);
  assert.equal(v(maakZip([{ naam: 'a.xml', data: x }, { naam: 'b.xml', data: x }])).zip, 'niet_precies_een_xml');
  assert.equal(v(maakZip([{ naam: 'a.xml', data: x, versleuteld: true }])).zip, 'versleuteld');
  assert.equal(v(maakZip([{ naam: 'a.xml', data: x, usz: 9 * 1024 * 1024 }])).zip, 'te_groot');
  // zip-bom: echte uitgepakte grootte > 8 MB terwijl de centrale map klein zegt
  assert.ok(['te_groot', 'grootte_wijkt_af'].includes(v(maakZip([{ naam: 'a.xml', data: Buffer.alloc(9 * 1024 * 1024, 0x20), usz: 100 }])).zip));
  assert.equal(v(Buffer.alloc(0)).begin, 'leeg');
  assert.equal(v(Buffer.from('{kapot')).json, 'onleesbaar');
  // een JSON-sleutel die op inhoud lijkt komt als '?'
  assert.deepEqual(B.ontpak(Buffer.from(JSON.stringify({ 'Proef Anna heeft NL69': 1 })), null).vorm.json_sleutels, ['?']);
  // review MOET 1: sleutel, wortel, namespace en content-type alleen van vaste lijsten
  assert.deepEqual(B.ontpak(Buffer.from(JSON.stringify({ Anna: 1, 'Jan.Jansen': 2, content: 'kort' })), null).vorm.json_sleutels, ['?', '?', 'content']);
  const w = B.ontpak(Buffer.from('<Anna xmlns="urn:proef:Anna:Jansen"><x/></Anna>'), 'text/anna-jansen').vorm;
  assert.equal(w.wortel, 'anders'); assert.equal(w.ns, 'anders'); assert.equal(w.ct, 'anders');
  const w2 = B.ontpak(Buffer.from('<p:Jansen xmlns:p="http://proef.invalid/Anna"/>'), 'application/xml; name=Anna').vorm;
  assert.equal(w2.wortel, 'anders'); assert.equal(w2.ns, 'anders'); assert.equal(w2.ct, 'application/xml');
  assert.equal(B.ontpak(Buffer.from('<Document xmlns="http://www.w3.org/2026/Anna/Jansen"/>'), null).vorm.ns, 'anders');
  assert.ok(!JSON.stringify([w, w2]).includes('Anna') && !JSON.stringify([w, w2]).includes('Jansen'));
});
test('wv3228 leesPain: namespace tussen enkele aanhalingstekens', () => {
  const p = B.leesPain(nmbrsPain().replace('xmlns:p="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"', "xmlns:p='urn:iso:std:iso:20022:tech:xsd:pain.001.001.03'"));
  assert.equal(p.ok, true); assert.equal(p.formaat, 'pain.001.001.03');
});

// ── kindopdrachten tegen een nagebootste API ────────────────────────────────────────────────────────────────────────
const C1 = 'c0000000-0000-4000-8000-000000000001', D1 = 'd0000000-0000-4000-8000-000000000001';
const RUN = 'r0000000-0000-4000-8000-000000000012', RUNOUD = 'r0000000-0000-4000-8000-000000000011', RUNOPEN = 'r0000000-0000-4000-8000-000000000013';
const TAAK = 'a0000000-0000-4000-8000-0000000000bb';
function nep(M) {
  const pagina = (data) => ({ pagination: { pageNumber: 1, pageSize: 100, totalPages: 1 }, data });
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), stuur = (st, j) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(typeof j === 'string' ? j : JSON.stringify(j)); };
    M.log.push(u.pathname + u.search);
    if (u.pathname === '/api/companies') return stuur(200, pagina([{ companyId: C1, number: '7', name: 'Proef POT', debtorId: D1 }]));
    if (u.pathname === '/api/companies/' + C1 + '/period') return stuur(200, { period: { year: 2026, period: 11 }, periodType: 'month' });
    if (u.pathname === '/api/companies/' + C1 + '/runs') {
      if (u.searchParams.get('year') !== '2026') return stuur(200, pagina([]));
      const recent = new Date(Date.now() - 2 * 86400000).toISOString(), oud = new Date(Date.now() - 80 * 86400000).toISOString();
      return stuur(200, pagina([{ payrollRunId: RUN, number: 12, description: 'November 2026', year: 2026, periodStart: 11, periodEnd: 11, createdAt: recent, type: 'normal', locked: true, control: true, visibleEmployeeLogin: true, visibleDocumentViewer: false },
        { payrollRunId: RUNOUD, number: 11, description: 'Oud', year: 2026, periodStart: 10, periodEnd: 10, createdAt: oud, type: 'normal', locked: true },
        { payrollRunId: RUNOPEN, number: 13, description: 'Open', year: 2026, periodStart: 11, periodEnd: 11, createdAt: recent, type: 'normal', locked: false }]));
    }
    if (u.pathname === '/api/companies/' + C1 + '/runs/' + RUN + '/sepa') { if (u.searchParams.get('year') !== '2026') return stuur(400, {}); return stuur(200, { taskId: TAAK }); }
    if (u.pathname === '/api/documents/' + TAAK) { if (M.doc202-- > 0) return stuur(202, '"Document is being processed"'); if (M.leeg != null && M.leeg-- > 0) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(); } res.writeHead(200, { 'Content-Type': M.ct || 'application/octet-stream' }); return res.end(M.pain); }
    if (u.pathname === '/api/companies/' + C1 + '/runs/' + RUN + '/employees') return stuur(200, pagina([1, 2, 3].map((i) => ({ employeeId: 'e0000000-0000-4000-8000-00000000000' + i, employeeNumber: 100 + i }))));
    if (/journalsemployee$/.test(u.pathname)) return stuur(403, { title: 'Forbidden' });
    if (/\/api\/companies\/[^/]+\/(employees|salarytables)/.test(u.pathname)) return stuur(200, pagina([]));
    stuur(404, {});
  });
}
function kind(dir, opdracht, invoer, env) {
  return new Promise((klaar) => {
    const p = spawn(process.execPath, ['--no-warnings', SCRIPT, opdracht], { env: Object.assign({ PATH: process.env.PATH, NMBRS_DIR: dir, NMBRS_PAUZE_MS: '0' }, env || {}) });
    let uit = ''; p.stdout.on('data', (c) => uit += c); p.on('close', () => { let j = null; try { j = JSON.parse(uit); } catch (e) {} klaar(j); });
    p.stdin.end(JSON.stringify(invoer || {}));
  });
}
test('ronde: alleen de vergrendelde, recente POT-run; betaallijst klaar; zonder documentrecht geen vraag; bestand en gemeld', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-kind-'));
  const M = { log: [], doc202: 1, pain: nmbrsPain() };
  const srv = nep(M); await new Promise((k) => srv.listen(0, '127.0.0.1', k));
  const env = { NMBRS_API_BASIS: 'http://127.0.0.1:' + srv.address().port };
  try {
    const tok = 'at-' + 'a'.repeat(30);
    // eerste ronde zonder koppeltabel: niets met betaallijsten
    let r = await kind(dir, 'ronde', { access: tok, sub: 'sub-proef-0000000000001', doc: true, pot_iban: POT }, env);
    assert.equal(r.ok, true, JSON.stringify(r)); assert.ok(!M.log.some((x) => /\/sepa/.test(x)));
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(path.join(dir, 'nmbrs.sqlite'));
    d.prepare("insert into bedrijf_entiteit (bedrijf, entiteit, door, sinds) values (?, 'POT', 'toets', '2026-11-16')").run(C1); d.close();
    // zonder documentrecht: geen SEPA-vraag
    M.log.length = 0;
    r = await kind(dir, 'ronde', { access: tok, sub: 'sub-proef-0000000000001', doc: false, pot_iban: POT }, env);
    assert.equal(r.ok, true); assert.equal(r.betaal.recht, false); assert.ok(!M.log.some((x) => /\/sepa|\/documents/.test(x)));
    // met documentrecht: alleen RUN (niet de oude, niet de open)
    M.log.length = 0;
    r = await kind(dir, 'ronde', { access: tok, sub: 'sub-proef-0000000000001', doc: true, pot_iban: POT }, env);
    assert.equal(r.ok, true, JSON.stringify(r)); assert.deepEqual(r.betaal, { recht: true, nieuw: 1, klaar: 1, afgekeurd: 0, opnieuw: 0 });
    assert.equal(M.log.filter((x) => /\/sepa\?year=2026$/.test(x)).length, 1);
    assert.ok(!M.log.some((x) => x.includes(RUNOUD + '/sepa') || x.includes(RUNOPEN + '/sepa')));
    assert.ok(!JSON.stringify(r).includes(I1) && !JSON.stringify(r).includes('Proef, Anna'), 'geen IBAN of naam in de ronde-uitvoer');
    // tweede ronde: niet opnieuw ophalen
    M.log.length = 0;
    r = await kind(dir, 'ronde', { access: tok, sub: 'sub-proef-0000000000001', doc: true, pot_iban: POT }, env);
    assert.ok(!M.log.some((x) => /\/sepa/.test(x))); assert.equal(r.betaal.nieuw, 0);
    // lijst voor de app
    const l = await kind(dir, 'betaallijst', {});
    assert.equal(l.lijsten.length, 1); const x = l.lijsten[0];
    assert.equal(x.status, 'klaar'); assert.equal(x.aantal, 3); assert.equal(x.totaal_centen, 483325); assert.equal(x.medewerkers_run, 3); assert.equal(x.periode, 'november 2026');
    assert.equal(x.regels[0].iban4, '…0001'); assert.ok(!JSON.stringify(l).includes(I1), 'volledig IBAN niet in de lijst'); assert.equal(x.gemeld, null);
    // bestand
    const bad = await kind(dir, 'betaalbestand', { run: RUN, datum: '2026-11-22', vandaag: '2026-11-16', msg_hex: '0a1b2c3d', cre_dt_tm: '2026-11-16T12:00:00', pot: { iban: POT, naam: 'Proef POT' } });
    assert.equal(bad.code, 'datum');
    const geenPot = await kind(dir, 'betaalbestand', { run: RUN, datum: '2026-11-25', vandaag: '2026-11-16', msg_hex: '0a1b2c3d', cre_dt_tm: '2026-11-16T12:00:00', pot: {} });
    assert.equal(geenPot.code, 'controle');
    const b = await kind(dir, 'betaalbestand', { run: RUN, datum: '2026-11-25', vandaag: '2026-11-16', msg_hex: '0a1b2c3d', cre_dt_tm: '2026-11-16T12:00:00', pot: { iban: POT, naam: 'Proef POT' } });
    assert.equal(b.ok, true, JSON.stringify(b)); assert.equal(b.aantal, 3);
    const v = xsd(b.tekst); if (v !== null) assert.equal(v, 'OK');
    // gemeld
    assert.equal((await kind(dir, 'betaalgemeld', { runs: [RUN, 'x y'] })).gemeld, 1);
    const l2 = await kind(dir, 'betaallijst', {});
    assert.ok(l2.lijsten[0].gemeld && l2.lijsten[0].gedownload);
    // bestandsrechten
    assert.equal(fs.statSync(path.join(dir, 'nmbrs.sqlite')).mode & 0o777, 0o600);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('review MOET 3+4: POT-rekening ontbreekt bij ophalen → klaar (download weigert tot hij er is); regels gewist na 60 dagen, ook zonder documentrecht', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-kind-'));
  const M = { log: [], doc202: 0, pain: nmbrsPain() };
  const srv = nep(M); await new Promise((k) => srv.listen(0, '127.0.0.1', k));
  const env = { NMBRS_API_BASIS: 'http://127.0.0.1:' + srv.address().port };
  try {
    const tok = 'at-' + 'a'.repeat(30);
    await kind(dir, 'betaalgemeld', { runs: [] }, env);
    const { DatabaseSync } = require('node:sqlite');
    let d = new DatabaseSync(path.join(dir, 'nmbrs.sqlite'));
    d.prepare("insert into bedrijf_entiteit (bedrijf, entiteit, door, sinds) values (?, 'POT', 'toets', '2026-11-16')").run(C1); d.close();
    const r = await kind(dir, 'ronde', { access: tok, sub: 'sub-proef-0000000000001', doc: true, pot_iban: null }, env);
    assert.equal(r.betaal.klaar, 1, JSON.stringify(r.betaal));
    let l = await kind(dir, 'betaallijst', { pot_iban: null });
    assert.equal(l.lijsten[0].status, 'klaar'); assert.ok(l.lijsten[0].hard.some((h) => /POT-rekening/.test(h)));
    const arg = { run: RUN, datum: '2026-11-25', vandaag: '2026-11-16', msg_hex: '0a1b2c3d', cre_dt_tm: '2026-11-16T12:00:00' };
    assert.equal((await kind(dir, 'betaalbestand', Object.assign({ pot: {} }, arg))).code, 'controle');
    l = await kind(dir, 'betaallijst', { pot_iban: POT });
    assert.deepEqual(l.lijsten[0].hard, []);
    assert.equal((await kind(dir, 'betaalbestand', Object.assign({ pot: { iban: POT, naam: 'Proef POT' } }, arg))).ok, true);
    // 61 dagen later: ronde zonder documentrecht wist de regels toch
    d = new DatabaseSync(path.join(dir, 'nmbrs.sqlite'));
    d.prepare('update betaallijst set opgehaald = ?').run(new Date(Date.now() - 61 * 86400000).toISOString()); d.close();
    await kind(dir, 'ronde', { access: tok, sub: 'sub-proef-0000000000001', doc: false, pot_iban: POT }, env);
    d = new DatabaseSync(path.join(dir, 'nmbrs.sqlite'));
    assert.equal(d.prepare('select count(*) as n from betaalregel').get().n, 0); d.close();
    assert.equal((await kind(dir, 'betaalbestand', Object.assign({ pot: { iban: POT, naam: 'Proef POT' } }, arg))).code, 'controle');
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('nacontrole: bestand zonder controletotaal blijft zacht in lijst en download', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-kind-'));
  const M = { log: [], doc202: 0, pain: nmbrsPain().replace(/<p:NbOfTxs>3<\/p:NbOfTxs><p:CtrlSum>4833.25<\/p:CtrlSum>/, '') };
  const srv = nep(M); await new Promise((k) => srv.listen(0, '127.0.0.1', k));
  const env = { NMBRS_API_BASIS: 'http://127.0.0.1:' + srv.address().port };
  try {
    await kind(dir, 'betaalgemeld', { runs: [] }, env);
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(path.join(dir, 'nmbrs.sqlite'));
    d.prepare("insert into bedrijf_entiteit (bedrijf, entiteit, door, sinds) values (?, 'POT', 'toets', '2026-11-16')").run(C1); d.close();
    await kind(dir, 'ronde', { access: 'at-' + 'a'.repeat(30), sub: 'sub-proef-0000000000001', doc: true, pot_iban: POT }, env);
    const l = await kind(dir, 'betaallijst', { pot_iban: POT });
    assert.ok(l.lijsten[0].zacht.some((z) => /controletotaal/.test(z)) && !l.lijsten[0].hard.length, JSON.stringify(l.lijsten[0]));
    const arg = { run: RUN, datum: '2026-11-25', vandaag: '2026-11-16', msg_hex: '0a1b2c3d', cre_dt_tm: '2026-11-16T12:00:00', pot: { iban: POT, naam: 'Proef POT' } };
    assert.equal((await kind(dir, 'betaalbestand', arg)).code, 'bewust');
    assert.equal((await kind(dir, 'betaalbestand', Object.assign({ bewust: true }, arg))).ok, true);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('ronde: afgekeurd bestand (mod-97) → status afgekeurd, geen bestand', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-kind-'));
  const M = { log: [], doc202: 0, pain: nmbrsPain({ regels: [['Proef, A', 'NL70TEST0000000001', '10.00', 'a']], som: '10.00' }) };
  const srv = nep(M); await new Promise((k) => srv.listen(0, '127.0.0.1', k));
  const env = { NMBRS_API_BASIS: 'http://127.0.0.1:' + srv.address().port };
  try {
    const tok = 'at-' + 'a'.repeat(30);
    await kind(dir, 'betaalgemeld', { runs: [] }, env);   // maakt de database met de tabellen
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(path.join(dir, 'nmbrs.sqlite'));
    d.prepare("insert into bedrijf_entiteit (bedrijf, entiteit, door, sinds) values (?, 'POT', 'toets', '2026-11-16')").run(C1); d.close();
    const r = await kind(dir, 'ronde', { access: tok, sub: 'sub-proef-0000000000001', doc: true, pot_iban: POT }, env);
    assert.equal(r.betaal.afgekeurd, 1);
    const l = await kind(dir, 'betaallijst', {});
    assert.equal(l.lijsten[0].status, 'afgekeurd'); assert.ok(l.lijsten[0].hard.some((h) => /mod-97/.test(h)));
    const b = await kind(dir, 'betaalbestand', { run: RUN, datum: '2026-11-25', vandaag: '2026-11-16', msg_hex: '0a1b2c3d', cre_dt_tm: '2026-11-16T12:00:00', pot: { iban: POT, naam: 'Proef POT' } });
    assert.equal(b.code, 'controle');
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wv3228 ronde: zip-document → klaar; JSON zonder inhoud → afgekeurd met vorm in controle en ronde-uitvoer (zonder inhoud); runstaat', async () => {
  for (const geval of ['zip', 'json']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-kind-'));
    const M = geval === 'zip' ? { log: [], doc202: 0, ct: 'application/zip', pain: maakZip([{ naam: 'SEPA.xml', data: nmbrsPain() }], { descriptor: true }) }
      : { log: [], doc202: 0, ct: 'application/json; charset=utf-8', pain: JSON.stringify({ documentId: 'x', status: 'Proef Anna', aantal: 3 }) };
    const srv = nep(M); await new Promise((k) => srv.listen(0, '127.0.0.1', k));
    const env = { NMBRS_API_BASIS: 'http://127.0.0.1:' + srv.address().port };
    try {
      await kind(dir, 'betaalgemeld', { runs: [] }, env);
      const { DatabaseSync } = require('node:sqlite');
      let d = new DatabaseSync(path.join(dir, 'nmbrs.sqlite'));
      d.prepare("insert into bedrijf_entiteit (bedrijf, entiteit, door, sinds) values (?, 'POT', 'toets', '2026-11-16')").run(C1); d.close();
      const r = await kind(dir, 'ronde', { access: 'at-' + 'a'.repeat(30), sub: 'sub-proef-0000000000001', doc: true, pot_iban: POT }, env);
      assert.equal(r.ok, true, JSON.stringify(r));
      d = new DatabaseSync(path.join(dir, 'nmbrs.sqlite'));
      const b = d.prepare('select status, formaat, controle from betaallijst where run = ?').get(RUN);
      const st = d.prepare('select * from runstaat where run = ?').get(RUN), open = d.prepare('select * from runstaat where run = ?').get(RUNOPEN);
      const data = JSON.parse(d.prepare('select data from loonrun where id = ?').get(RUN).data);
      d.close();
      const c = JSON.parse(b.controle);
      if (geval === 'zip') {
        assert.equal(b.status, 'klaar', b.controle); assert.equal(b.formaat, 'pain.001.001.03'); assert.deepEqual(c.vorm.lagen, ['zip', 'xml']); assert.equal(c.vorm.ct, 'application/zip');
        assert.ok(!r.betaal.vorm);
      } else {
        assert.equal(b.status, 'afgekeurd'); assert.equal(b.formaat, null);
        assert.deepEqual(c.vorm.json_sleutels, ['documentId', 'status', '?']); assert.equal(c.vorm.json, 'geen_inhoudsveld'); assert.equal(c.vorm.begin, 'json'); assert.equal(c.vorm.ct, 'application/json');
        assert.equal(r.betaal.vorm.length, 1); assert.equal(r.betaal.vorm[0].nummer, 12); assert.deepEqual(r.betaal.vorm[0].json_sleutels, ['documentId', 'status', '?']);
        assert.ok(!JSON.stringify(r).includes('Proef Anna') && !b.controle.includes('Proef Anna'));
      }
      assert.ok(st.locked_sinds && st.zichtbaar_sinds && !st.documenten_sinds, JSON.stringify(st));
      assert.ok(open && !open.locked_sinds && !open.zichtbaar_sinds, JSON.stringify(open));
      assert.equal(data.visibleEmployeeLogin, true); assert.equal(data.control, true);
    } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('wv3229 ronde: document eerst leeg (200, 0 bytes) → doorvragen → klaar; altijd leeg → opnieuw (geen afkeuring), daarna klaar', async () => {
  for (const geval of ['eerst', 'altijd']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-kind-'));
    const M = { log: [], doc202: 0, leeg: geval === 'eerst' ? 2 : 1000, pain: nmbrsPain() };
    const srv = nep(M); await new Promise((k) => srv.listen(0, '127.0.0.1', k));
    const env = { NMBRS_API_BASIS: 'http://127.0.0.1:' + srv.address().port };
    try {
      await kind(dir, 'betaalgemeld', { runs: [] }, env);
      const { DatabaseSync } = require('node:sqlite');
      let d = new DatabaseSync(path.join(dir, 'nmbrs.sqlite'));
      d.prepare("insert into bedrijf_entiteit (bedrijf, entiteit, door, sinds) values (?, 'POT', 'toets', '2026-11-16')").run(C1); d.close();
      const inv = { access: 'at-' + 'a'.repeat(30), sub: 'sub-proef-0000000000001', doc: true, pot_iban: POT };
      let r = await kind(dir, 'ronde', inv, env);
      assert.equal(r.ok, true, JSON.stringify(r));
      d = new DatabaseSync(path.join(dir, 'nmbrs.sqlite'));
      let b = d.prepare('select status, formaat, pogingen, controle from betaallijst where run = ?').get(RUN); d.close();
      const docs = M.log.filter((x) => x.startsWith('/api/documents/')).length;
      if (geval === 'eerst') {
        assert.equal(b.status, 'klaar', b.controle); assert.equal(b.formaat, 'pain.001.001.03');
        const c = JSON.parse(b.controle); assert.equal(c.vorm.leeg, 2); assert.equal(c.vorm.vragen, 3); assert.equal(docs, 3);
      } else {
        assert.equal(b.status, 'opnieuw', b.controle); assert.equal(b.pogingen, 1); assert.equal(JSON.parse(b.controle).ophalen, 'document:leeg:8'); assert.equal(docs, 8);
        assert.equal(r.betaal.opnieuw, 1); assert.equal(r.betaal.afgekeurd, 0);
        M.leeg = 0; r = await kind(dir, 'ronde', inv, env);   // volgende ronde: nu wel inhoud
        d = new DatabaseSync(path.join(dir, 'nmbrs.sqlite')); b = d.prepare('select status, pogingen from betaallijst where run = ?').get(RUN); d.close();
        assert.equal(b.status, 'klaar'); assert.equal(b.pogingen, 2);
      }
    } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
