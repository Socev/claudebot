'use strict';
// Toetst de betaallijst van een POT-loonrun (wv3208, sinds wv3232 16-11-2026 door Socev zelf gemaakt): nmbrs-betaal.js (run output lezen, regels,
// controles, CSV voor de extensie POT-invoer en pain.001.001.09 tegen het XSD, ontpak) en de kindopdrachten in nmbrs-data.js (ronde leest de run
// output met alleen 9880/9900 en de bankrekeningen tegen een nagebootste API op 127.0.0.1; betaallijst, betaalbestand csv/xml, betaalgemeld).
// ALLEEN VERZONNEN gegevens: IBAN's met bankcode TEST (geldige mod-97), namen "Proef …". Raakt de pod en /opt/data/nmbrs niet.
// Gebruik: node --test test/nmbrs-betaal.test.js
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

test('maandTekst en bestandsnaam zonder namen', () => {
  assert.equal(B.maandTekst({ year: 2026, periodEnd: 11 }, 'month'), 'november 2026');
  assert.equal(B.maandTekst({ year: 2026, periodEnd: 11 }, '4-weeks'), 'periode 11 2026');
  assert.equal(B.bestandNaam({ year: 2026, number: 12 }, '2026-11-25', 'csv'), 'POT-salarissen-2026-R12-betaal-2026-11-25.csv');
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
function painLees(t) { return { ok: /<(\w+:)?CstmrCdtTrfInitn>/.test(t), regels: (t.match(/<(\w+:)?CdtTrfTxInf>/g) || []) }; }
function leesVia(buf, ct) { const o = B.ontpak(buf, ct); return { o, p: o.tekst == null ? null : painLees(o.tekst) }; }
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

// ── wv3232: Socev maakt de betaallijst zelf (run output + bankrekeningen) ───────────────────────────────────────────────
const T = require(SCRIPT);
const E = (i) => 'e0000000-0000-4000-8000-00000000000' + i;
// Run output zoals Nmbrs hem geeft (vorm gemeten 16-11-2026, inhoud verzonnen): per medewerker per periode een report met lines.
function runOutput(rijen, o) {
  o = o || {};
  return '<reports>' + rijen.map((r) => '<report><employeeid>' + r.id + '</employeeid><period>' + (r.per || 11) + '</period><year>2026</year><runnumber>12</runnumber><lines>' +
    (r.lines || [[9900, 'Totaal netto', r.netto != null ? r.netto : r.bank], [9880, 'Per Bank', r.bank]]).map((l) => '<line><code>' + l[0] + '</code><description>' + l[1] + '</description><value>' + l[2] + '</value></line>').join('') +
    '</lines></report>').join('') + (o.staart || '') + '</reports>';
}
const MW = { [E(1)]: { persnr: '101', naam: 'Proef, Anna' }, [E(2)]: { persnr: '102', naam: 'Voorbeeld, Bert van' }, [E(3)]: { persnr: '103', naam: 'Toets, Cor' } };
const IB = { [E(1)]: { iban: I1 }, [E(2)]: { iban: I2 }, [E(3)]: { iban: I3 } };
const RO3 = () => runOutput([{ id: E(1), bank: '2345.60' }, { id: E(2), bank: '1500.00' }, { id: E(3), bank: '987.65' }]);
function ctl(ro, o, mw, ib) { const r = B.leesRunOutput(ro); const sam = B.regelsUitRun(r, { medewerkers: mw || MW, ibans: ib === undefined ? IB : ib }); return { r, sam, c: B.controleRun(r, sam, Object.assign({ in_run: [E(1), E(2), E(3)], definitief: true, met_iban: ib !== null }, o || {})) }; }

test('wv3232 run output: lezen in centen, periodes opgeteld, andere codes genegeerd; DOCTYPE, geen reports of kapotte waarde → niet ok/onleesbaar', () => {
  const r = B.leesRunOutput(runOutput([{ id: E(1), bank: '1000.00', per: 10 }, { id: E(1), bank: '234.5', per: 11 }, { id: E(2), bank: '0', lines: [[9880, 'Per Bank', '0'], [8800, 'Loonheffing', '-500.00']] }]));
  assert.equal(r.ok, true); assert.equal(r.rapporten, 3); assert.equal(r.per[E(1)].bank, 123450); assert.equal(r.per[E(1)].netto, 123450); assert.equal(r.per[E(2)].bank, 0);
  assert.equal(B.leesRunOutput('<!DOCTYPE x [<!ENTITY a "b">]>' + RO3()).ok, false);
  assert.equal(B.leesRunOutput('<Document>' + RO3() + '</Document>').ok, false);
  assert.equal(B.leesRunOutput('').ok, false);
  assert.equal(B.leesRunOutput(runOutput([{ id: E(1), bank: '12,34.5' }])).onleesbaar, true);
  assert.equal(B.leesRunOutput(runOutput([{ id: 'x y', bank: '1.00' }])).onleesbaar, true);
  assert.equal(B.leesRunOutput('<?xml version="1.0"?>\n' + RO3()).ok, true);
  // review MOET 2: hetzelfde report twee keer → hard dubbel_rapport; twee periodes van één medewerker niet
  const dub = B.leesRunOutput(runOutput([{ id: E(1), bank: '10.00' }, { id: E(1), bank: '10.00' }]));
  assert.equal(dub.dubbel, true); assert.ok(B.controleRun(dub, B.regelsUitRun(dub, { medewerkers: MW, ibans: IB }), { in_run: [E(1)], definitief: true, met_iban: true }).hard.includes('dubbel_rapport'));
  assert.equal(B.leesRunOutput(runOutput([{ id: E(1), bank: '1.00', per: 10 }, { id: E(1), bank: '1.00', per: 11 }])).dubbel, false);
  // review ronde 2 MOET 1: afgekapt document (na een heel report, of midden in een regel) → niet ok
  const heel = RO3(), knip = heel.lastIndexOf('<report>');
  assert.equal(B.leesRunOutput(heel.slice(0, knip)).ok, false);
  assert.equal(B.leesRunOutput(heel.slice(0, knip) + '</reports>').ok, true, 'een kortere maar volledige lijst is wel geldig (dan zacht: aantal medewerkers)');
  assert.equal(B.leesRunOutput(heel.slice(0, heel.length - 40)).ok, false);
  assert.equal(B.leesRunOutput(heel.replace('</line></lines></report>', '</lines></report>')).ok, false);
  assert.equal(B.leesRunOutput(heel + '<reports></reports>').ok, false);
  // review ronde 3 MOET 1: regel zonder of met kapotte code → onleesbaar
  assert.equal(B.leesRunOutput(runOutput([{ id: E(1), bank: '1.00', lines: [[9880, 'Per Bank', '1.00'], ['', 'Per Bank', '5.00']] }])).onleesbaar, true);
  assert.equal(B.leesRunOutput(heel.replace('<code>9880</code>', '<code>98x0</code>')).onleesbaar, true);
  assert.equal(B.leesRunOutput(heel.replace('<code>9880</code>', '')).onleesbaar, true);
});
test('wv3232 regels + controle: alles goed → klaar; open run → zacht voorlopig; regels zonder bedrag 0, namen gesorteerd', () => {
  const { sam, c } = ctl(RO3());
  assert.deepEqual(c, { hard: [], zacht: [], aantal: 3, totaal_centen: 483325, netto_centen: 483325 });
  assert.deepEqual(sam.regels.map((x) => x.persnr), ['101', '103', '102']);   // Proef, Toets, Voorbeeld
  assert.deepEqual(ctl(RO3(), { definitief: false }).c.zacht, ['voorlopig']);
  const nul = ctl(runOutput([{ id: E(1), bank: '10.00' }, { id: E(2), bank: '0.00' }]), { in_run: [E(1), E(2)] });
  assert.equal(nul.c.aantal, 1); assert.deepEqual(nul.c.zacht, ['aantal_medewerkers']);
});
test('wv3232 controle hard: negatief (sinds wv3917 per regel), onbekende medewerker, geen IBAN, mod-97, onleesbaar, leeg', () => {
  // wv3917: één negatief bedrag als enige regel → die regel afgekeurd, de lijst dus leeg (hard); bewaarde regel ≤ 0 blijft hard
  const neg = ctl(runOutput([{ id: E(1), bank: '-10.00' }]), { in_run: [E(1)] });
  assert.ok(neg.c.hard.includes('leeg')); assert.ok(neg.c.zacht.includes('regel_afgekeurd')); assert.equal(neg.sam.afgekeurd.length, 1);
  assert.deepEqual(B.controleRegels([{ persnr: '1', naam: 'Proef, Anna', iban: I1, centen: -5 }], true), ['bedrag_niet_positief']);
  assert.ok(ctl(runOutput([{ id: E(4), bank: '10.00' }]), { in_run: [E(4)] }).c.hard.includes('medewerker_onbekend'));
  assert.ok(ctl(RO3(), {}, MW, { [E(1)]: { iban: I1 }, [E(2)]: { iban: I2 } }).c.hard.includes('iban_ontbreekt'));
  assert.ok(ctl(RO3(), {}, MW, { [E(1)]: { iban: 'NL70TEST0000000001' }, [E(2)]: { iban: I2 }, [E(3)]: { iban: I3 } }).c.hard.includes('iban_mod97'));
  assert.ok(ctl(runOutput([{ id: E(1), bank: 'x' }]), { in_run: [E(1)] }).c.hard.includes('onleesbaar'));
  assert.ok(ctl('<reports></reports>', { in_run: [] }).c.hard.includes('leeg'));
});
test('wv3232 controle zacht: netto deels anders, aantal medewerkers, niet in run, IBAN recent gewijzigd; zonder bankrecht geen IBAN-controles', () => {
  assert.ok(ctl(runOutput([{ id: E(1), bank: '2345.60', netto: '2400.00' }, { id: E(2), bank: '1500.00' }, { id: E(3), bank: '987.65' }])).c.zacht.includes('netto_niet_alles_per_bank'));
  assert.deepEqual(ctl(RO3(), { in_run: [E(1), E(2), E(3), E(4)] }).c.zacht, ['aantal_medewerkers']);
  assert.deepEqual(ctl(RO3(), { in_run: [E(1), E(2), E(4)] }).c.zacht, ['niet_in_run']);
  assert.deepEqual(ctl(RO3(), { in_run: null }).c.zacht, ['medewerkers_run_onbekend']);
  assert.deepEqual(ctl(RO3(), {}, MW, { [E(1)]: { iban: I1, recent: true }, [E(2)]: { iban: I2 }, [E(3)]: { iban: I3 } }).c.zacht, ['iban_recent_gewijzigd']);
  const z = ctl(RO3(), {}, MW, null);
  assert.deepEqual(z.c.hard, []); assert.ok(z.sam.regels.every((x) => x.iban === null));
});
test('wv3917 (2C15) gedeelde rekening = zacht punt met beide namen en laatste 4; negatief bedrag keurt alleen die regel af', () => {
  const g = ctl(RO3(), {}, MW, { [E(1)]: { iban: I1 }, [E(2)]: { iban: I1 }, [E(3)]: { iban: I3 } });
  assert.deepEqual(g.c.hard, []); assert.deepEqual(g.c.zacht, ['iban_gedeeld']); assert.equal(g.c.aantal, 3); assert.equal(g.c.totaal_centen, 483325);
  assert.deepEqual(B.controleRegels(g.sam.regels, true), [], 'ook bij lijst en download niet meer hard');
  const t = B.zachtDetail(g.c.zacht, g.sam.regels, []);
  assert.equal(t.length, 1); assert.match(t[0], /^Anna Proef en Bert van Voorbeeld hebben hetzelfde rekeningnummer \(…0001\)/);
  // zonder bankrecht geen IBAN, dus ook geen gedeeld-punt
  assert.deepEqual(ctl(RO3(), {}, MW, null).c.zacht, []);
  // negatief: alleen die regel weg, punt erbij; geen extra 'aantal_medewerkers' of 'netto'-punt door de afgekeurde regel
  const n = ctl(runOutput([{ id: E(1), bank: '2345.60' }, { id: E(2), bank: '-25.00' }, { id: E(3), bank: '987.65' }]));
  assert.deepEqual(n.c.hard, []); assert.deepEqual(n.c.zacht, ['regel_afgekeurd']); assert.equal(n.c.aantal, 2); assert.equal(n.c.totaal_centen, 333325);
  assert.deepEqual(n.sam.regels.map((x) => x.persnr), ['101', '103']); assert.deepEqual(n.sam.afgekeurd.map((x) => x.persnr), ['102']);
  assert.match(B.zachtDetail(n.c.zacht, n.sam.regels, n.sam.afgekeurd)[0], /^Bert van Voorbeeld \(…0002\): negatief bedrag \(€ -25,00\); deze regel staat niet in het bestand/);
  // de melding (UITLEG) noemt geen namen
  assert.ok(!/Proef|Anna|Bert/.test(B.UITLEG.iban_gedeeld + B.UITLEG.regel_afgekeurd));
  // CSV met gedeelde rekening: pas na 'bewust', dan beide regels erin
  const a = { run: { year: 2026, number: 12, periodEnd: 11 }, periode_soort: 'month', regels: g.sam.regels, controle: { hard: [], zacht: g.c.zacht }, datum: '2026-11-25', vandaag: '2026-11-22' };
  assert.equal(B.csvBestand(a).code, 'bewust');
  const csv = B.csvBestand(Object.assign({}, a, { bewust: true }));
  assert.equal(csv.ok, true); assert.equal((csv.tekst.match(new RegExp(I1, 'g')) || []).length, 4, 'twee regels × (Rekeningnr + IBAN)');
});
test('wv3232 ibanKeuze: bankAccount1 nieuwste wint; recent gewijzigd; geen type maar één IBAN; twee IBAN zonder bankAccount1 → geen', () => {
  const nu = Date.parse('2026-11-16T12:00:00Z');
  assert.deepEqual(T.ibanKeuze([{ IBAN: 'nl69 test 0000 0000 01', bankAccountType: 'bankAccount1', createdAt: '2025-01-01T00:00:00Z' }], nu), { iban: I1, recent: false });
  assert.deepEqual(T.ibanKeuze([{ IBAN: I1, bankAccountType: 'bankAccount1', createdAt: '2025-01-01T00:00:00Z' }, { IBAN: I2, bankAccountType: 'bankAccount1', createdAt: '2026-11-10T00:00:00Z' },
    { IBAN: I3, bankAccountType: 'bankAccount2', createdAt: '2026-11-12T00:00:00Z' }], nu), { iban: I2, recent: true });
  assert.deepEqual(T.ibanKeuze([{ IBAN: I3, bankAccountType: 'anders', createdAt: '2020-01-01T00:00:00Z' }], nu), { iban: I3, recent: false });
  assert.deepEqual(T.ibanKeuze([{ IBAN: I2, bankAccountType: 'bankAccount2' }, { IBAN: I3, bankAccountType: 'bankAccount3' }], nu), { iban: null, recent: false });
  assert.deepEqual(T.ibanKeuze(null, nu), { iban: null, recent: false });
});
test('wv3232 CSV: kop en regels in het formaat van de Nmbrs-lijst + Betaaldatum, BOM, CRLF, NL-bedragen; datum/bewust/hard; geen formule of ; in een veld', () => {
  const { sam } = ctl(RO3());
  const run = { year: 2026, number: 12, periodEnd: 11 };
  const basis = { run, periode_soort: 'month', regels: sam.regels, controle: { hard: [], zacht: [] }, vandaag: '2026-11-16', datum: '2026-11-25' };
  const u = B.csvBestand(basis);
  assert.equal(u.ok, true); assert.equal(u.naam, 'POT-salarissen-2026-R12-betaal-2026-11-25.csv'); assert.equal(u.type, 'text/csv'); assert.equal(u.aantal, 3); assert.equal(u.totaal_centen, 483325);
  assert.ok(u.tekst.startsWith('﻿Type;Persnr;Naam;Rekeningnr;BIC;IBAN;Bedrag pos.;Bedrag neg.;Periode;Betaaldatum;\r\n'));
  const rij = u.tekst.split('\r\n')[1];
  assert.equal(rij, 'Bankrekening;101;Proef, Anna;' + I1 + ';;' + I1 + ';2345,60;0,00;2026-11-M;2026-11-25;');
  assert.ok(u.tekst.endsWith('\r\n')); assert.equal(u.tekst.split('\r\n').length, 5);
  assert.match(u.tekst, /;987,65;/);
  assert.equal(B.csvBestand(Object.assign({}, basis, { datum: '2026-11-21' })).code, 'datum');
  assert.equal(B.csvBestand(Object.assign({}, basis, { controle: { hard: [], zacht: ['voorlopig'] } })).code, 'bewust');
  assert.equal(B.csvBestand(Object.assign({}, basis, { controle: { hard: [], zacht: ['voorlopig'] }, bewust: true })).ok, true);
  assert.equal(B.csvBestand(Object.assign({}, basis, { controle: { hard: ['iban_mod97'], zacht: [] } })).code, 'controle');
  const gek = B.csvBestand(Object.assign({}, basis, { regels: [{ persnr: '1;2', naam: '=Proef;"x"\r\nAnna', iban: I1, centen: 5 }] }));
  assert.equal(gek.tekst.split('\r\n')[1], 'Bankrekening;1 2;Proef  x   Anna;' + I1 + ';;' + I1 + ';0,05;0,00;2026-11-M;2026-11-25;');
});
test('wv3232 pain.001: geldig tegen het XSD met de POT-rekening en Davids datum, namen voornaam-eerst; zonder POT-rekening geweigerd', () => {
  const { sam } = ctl(RO3());
  const a = { run: { year: 2026, number: 12, periodEnd: 11 }, periode_soort: 'month', regels: sam.regels, controle: { hard: [], zacht: [] }, pot: { iban: POT, naam: 'Samenwerkende Werkgevers Proef (POT)' },
    vandaag: '2026-11-16', datum: '2026-11-25', msg_hex: '0a1b2c3d', cre_dt_tm: '2026-11-16T12:00:00' };
  const u = B.bestand(a);
  assert.equal(u.ok, true); assert.equal(u.naam, 'POT-salarissen-2026-R12-betaal-2026-11-25.xml'); assert.equal(u.totaal_centen, 483325);
  assert.match(u.tekst, /<ReqdExctnDt><Dt>2026-11-25<\/Dt><\/ReqdExctnDt>/); assert.match(u.tekst, new RegExp('<DbtrAcct><Id><IBAN>' + POT + '</IBAN>'));
  assert.match(u.tekst, /<Nm>Bert van Voorbeeld<\/Nm>/); assert.match(u.tekst, /<EndToEndId>POT-2026-R12-101<\/EndToEndId>/); assert.match(u.tekst, /Salaris november 2026/);
  const v = xsd(u.tekst); if (v === null) console.log('# lxml ontbreekt: XSD overgeslagen'); else assert.equal(v, 'OK');
  assert.equal(B.bestand(Object.assign({}, a, { pot: {} })).code, 'controle');
  assert.equal(B.naamGewoon('Proef, Anna'), 'Anna Proef'); assert.equal(B.naamGewoon('Zonderkomma'), 'Zonderkomma');
});

// kindopdrachten tegen een nagebootste API
const C1 = 'c0000000-0000-4000-8000-000000000001', D1 = 'd0000000-0000-4000-8000-000000000001';
const RUN = 'r0000000-0000-4000-8000-000000000012', RUNOUD = 'r0000000-0000-4000-8000-000000000011', RUNANDER = 'r0000000-0000-4000-8000-000000000013';
const TAAK = 'a0000000-0000-4000-8000-0000000000bb';
function nep(M) {
  const pagina = (data) => ({ pagination: { pageNumber: 1, pageSize: 100, totalPages: 1 }, data });
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), stuur = (st, j) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(typeof j === 'string' ? j : JSON.stringify(j)); };
    M.log.push(u.pathname + u.search);
    if (u.pathname === '/api/companies') return stuur(200, pagina([{ companyId: C1, number: '7', name: 'Proef POT', debtorId: D1 }]));
    if (u.pathname === '/api/companies/' + C1 + '/period') return stuur(200, { period: { year: 2026, period: 11 }, periodType: 'month' });
    if (u.pathname === '/api/companies/' + C1 + '/employees') return stuur(200, pagina([1, 2, 3].map((i) => ({ employeeId: E(i), employeeBasicInfo: { employeeNumber: 100 + i, firstName: ['Anna', 'Bert', 'Cor'][i - 1], prefix: i === 2 ? 'van' : null, lastName: ['Proef', 'Voorbeeld', 'Toets'][i - 1] } }))));
    if (u.pathname === '/api/companies/' + C1 + '/runs') {
      if (u.searchParams.get('year') !== '2026') return stuur(200, pagina([]));
      const recent = new Date(Date.now() - 2 * 86400000).toISOString(), oud = new Date(Date.now() - 80 * 86400000).toISOString();
      return stuur(200, pagina([{ payrollRunId: RUN, number: 12, description: 'November 2026', year: 2026, periodStart: 11, periodEnd: 11, createdAt: recent, type: 'normal', locked: M.locked !== false, control: true, visibleEmployeeLogin: true, visibleDocumentViewer: false },
        { payrollRunId: RUNOUD, number: 11, description: 'Oud', year: 2026, periodStart: 10, periodEnd: 10, createdAt: oud, type: 'normal', locked: true }]));
    }
    if (u.pathname === '/api/companies/' + C1 + '/runs/' + RUN + '/wagecodes/xml') {
      if (M.taak403) return stuur(403, { title: 'Forbidden' });
      if (u.searchParams.get('year') !== '2026' || u.searchParams.getAll('wageCodes').join(',') !== '9880,9900') return stuur(400, {});
      return stuur(200, { taskId: TAAK });
    }
    if (u.pathname === '/api/documents/' + TAAK) { if (M.doc202-- > 0) return stuur(202, '"Document is being processed"'); res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(M.ro()); }
    if (u.pathname === '/api/companies/' + C1 + '/runs/' + RUN + '/employees') return stuur(200, pagina([1, 2, 3].map((i) => ({ employeeId: E(i), employeeNumber: 100 + i }))));
    if (u.pathname === '/api/companies/' + C1 + '/employees/bankaccounts') {
      if (M.bank403) return stuur(403, { title: 'Forbidden' });
      return stuur(200, pagina([1, 2, 3].map((i) => ({ employeeId: E(i), bankAccounts: [{ bankAccountId: 'b' + i, IBAN: M.ibans[i - 1], bankAccountType: 'bankAccount1', createdAt: '2024-01-01T00:00:00Z', name: 'Proef ' + i }] }))));
    }
    if (/journalsemployee$/.test(u.pathname)) return stuur(403, { title: 'Forbidden' });
    if (/\/api\/companies\/[^/]+\/(employees|salarytables)/.test(u.pathname)) return stuur(200, pagina([]));
    stuur(404, {});
  });
}
// betaalbestand zonder versie: de toets vult de versie in die de app zou sturen (uit 'betaallijst'); met versie: precies die
async function kind(dir, opdracht, invoer, env) {
  if (opdracht === 'betaalbestand' && invoer && invoer.versie === undefined) {
    const l = await kindRuw(dir, 'betaallijst', {}, env); const x = ((l && l.lijsten) || []).find((y) => y.run === invoer.run);
    invoer = Object.assign({}, invoer, { versie: x ? x.versie : '' });
  }
  return kindRuw(dir, opdracht, invoer, env);
}
function kindRuw(dir, opdracht, invoer, env) {
  return new Promise((klaar) => {
    const p = spawn(process.execPath, ['--no-warnings', SCRIPT, opdracht], { env: Object.assign({ PATH: process.env.PATH, NMBRS_DIR: dir, NMBRS_PAUZE_MS: '0' }, env || {}) });
    let uit = ''; p.stdout.on('data', (c) => uit += c); p.on('close', () => { let j = null; try { j = JSON.parse(uit); } catch (e) {} klaar(j); });
    p.stdin.end(JSON.stringify(invoer || {}));
  });
}
async function opzet(M) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-kind-'));
  const srv = nep(M); await new Promise((k) => srv.listen(0, '127.0.0.1', k));
  const env = { NMBRS_API_BASIS: 'http://127.0.0.1:' + srv.address().port };
  await kind(dir, 'betaalgemeld', { runs: [] }, env);   // maakt de database
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(path.join(dir, 'nmbrs.sqlite'));
  d.prepare("insert into bedrijf_entiteit (bedrijf, entiteit, door, sinds) values (?, 'POT', 'toets', '2026-11-16')").run(C1); d.close();
  return { dir, srv, env, db: () => new DatabaseSync(path.join(dir, 'nmbrs.sqlite')), sluit: () => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const INV = (o) => Object.assign({ access: 'at-' + 'a'.repeat(30), sub: 'sub-proef-0000000000001', doc: true, bank: true, pot_iban: POT }, o || {});
const ARG = (o) => Object.assign({ run: RUN, datum: '2026-11-25', vandaag: '2026-11-16', msg_hex: '0a1b2c3d', cre_dt_tm: '2026-11-16T12:00:00', pot: { iban: POT, naam: 'Proef POT' } }, o || {});

test('wv3232 ronde: zonder bankrecht wacht_iban (aantal + totaal, geen bestand); met bankrecht klaar; CSV en pain; geen SEPA-vraag; geen naam/IBAN in de uitvoer', async () => {
  const M = { log: [], doc202: 1, ro: RO3, ibans: [I1, I2, I3] };
  const o = await opzet(M);
  try {
    let r = await kind(o.dir, 'ronde', INV({ doc: false }), o.env);
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.betaal.recht, false); assert.ok(!M.log.some((x) => /wagecodes|bankaccounts|documents/.test(x)));
    M.log.length = 0;
    r = await kind(o.dir, 'ronde', INV({ bank: false }), o.env);
    assert.equal(r.betaal.wacht_iban, 1, JSON.stringify(r.betaal)); assert.ok(!M.log.some((x) => /bankaccounts/.test(x)));
    assert.ok(M.log.some((x) => x === '/api/companies/' + C1 + '/runs/' + RUN + '/wagecodes/xml?year=2026&wageCodes=9880&wageCodes=9900'), M.log.join('\n'));
    assert.ok(!M.log.some((x) => /\/sepa|RUNOUD/.test(x) || x.includes(RUNOUD + '/wagecodes')));
    let l = await kind(o.dir, 'betaallijst', {});
    assert.equal(l.lijsten.length, 1); assert.equal(l.lijsten[0].status, 'wacht_iban'); assert.equal(l.lijsten[0].aantal, 3); assert.equal(l.lijsten[0].totaal_centen, 483325);
    assert.equal(l.lijsten[0].regels[0].iban4, '—'); assert.deepEqual(l.lijsten[0].hard, []);
    assert.equal((await kind(o.dir, 'betaalbestand', ARG({ formaat: 'csv' }))).code, 'controle');
    // wacht_iban + vergrendeld + nog steeds geen bankrecht: niet opnieuw vragen
    M.log.length = 0; r = await kind(o.dir, 'ronde', INV({ bank: false }), o.env);
    assert.ok(!M.log.some((x) => /wagecodes/.test(x))); assert.equal(r.betaal.nieuw, 0);
    // bankrecht erbij → klaar
    M.log.length = 0; r = await kind(o.dir, 'ronde', INV(), o.env);
    assert.equal(r.betaal.klaar, 1, JSON.stringify(r.betaal)); assert.equal(r.bankrecht, undefined);
    const uit = JSON.stringify(r); assert.ok(![I1, I2, 'Proef', 'Anna', '2345'].some((x) => uit.includes(x)), 'geen naam, IBAN of bedrag in de ronde-uitvoer');
    l = await kind(o.dir, 'betaallijst', {});
    const x = l.lijsten[0];
    assert.equal(x.status, 'klaar'); assert.deepEqual(x.hard, []); assert.deepEqual(x.zacht, []); assert.equal(x.medewerkers_run, 3); assert.equal(x.netto_centen, 483325); assert.equal(x.definitief, true);
    assert.deepEqual(x.regels.map((y) => y.iban4), ['…0001', '…0003', '…0002']); assert.ok(!JSON.stringify(l).includes(I1)); assert.equal(x.regels[0].naam, 'Proef, Anna');
    assert.equal(x.gemeld, null, 'wacht_iban → klaar zonder wijziging: nog niet gemeld, dus nu één melding');
    // downloads
    assert.equal((await kind(o.dir, 'betaalbestand', ARG({ formaat: 'csv', datum: '2026-11-22' }))).code, 'datum');
    assert.equal((await kind(o.dir, 'betaalbestand', ARG({ formaat: 'pdf' }))).code, 'invoer');
    // review ronde 2 MOET 2: alleen de versie die de app liet zien
    assert.equal((await kind(o.dir, 'betaalbestand', ARG({ formaat: 'csv', versie: 'oud0000000000000' }))).code, 'versie');
    assert.equal((await kind(o.dir, 'betaalbestand', ARG({ formaat: 'csv', versie: '' }))).code, 'versie');
    const csv = await kind(o.dir, 'betaalbestand', ARG({ formaat: 'csv', pot: {} }));
    assert.equal(csv.ok, true, JSON.stringify(csv)); assert.equal(csv.type, 'text/csv'); assert.equal(csv.aantal, 3); assert.match(csv.tekst, /Bankrekening;102;Voorbeeld, Bert van;/);
    assert.equal((await kind(o.dir, 'betaalbestand', ARG({ formaat: 'xml', pot: {} }))).code, 'controle');
    const xml = await kind(o.dir, 'betaalbestand', ARG());
    assert.equal(xml.ok, true); const v = xsd(xml.tekst); if (v !== null) assert.equal(v, 'OK');
    assert.equal((await kind(o.dir, 'betaalgemeld', { runs: [RUN, 'x y'] })).gemeld, 1);
    const l2 = await kind(o.dir, 'betaallijst', {}); assert.ok(l2.lijsten[0].gemeld && l2.lijsten[0].gedownload);
    // vergrendeld, klaar en gedownload: dezelfde dag niets meer; een dag later weer nagekeken (opnieuw downloaden blijft mogelijk)
    M.log.length = 0; r = await kind(o.dir, 'ronde', INV(), o.env);
    assert.ok(!M.log.some((y) => /wagecodes|bankaccounts/.test(y)), M.log.join('\n'));
    let dd = o.db(); dd.prepare('update betaallijst set opgehaald = ?').run(new Date(Date.now() - 25 * 3600000).toISOString()); dd.close();
    M.log.length = 0; r = await kind(o.dir, 'ronde', INV(), o.env);
    assert.ok(M.log.some((y) => /wagecodes/.test(y))); assert.ok((await kind(o.dir, 'betaallijst', {})).lijsten[0].gedownload, 'ongewijzigd: download-stempel blijft');
    assert.equal(fs.statSync(path.join(o.dir, 'nmbrs.sqlite')).mode & 0o777, 0o600);
  } finally { o.sluit(); }
});
test('wv3232 open run: voorlopig, elke ronde opnieuw; bedrag gewijzigd na melding + download → opnieuw te melden, download gewist; vergrendeld → definitief', async () => {
  let bedrag = '1500.00';
  const M = { log: [], doc202: 0, locked: false, ro: () => runOutput([{ id: E(1), bank: '2345.60' }, { id: E(2), bank: bedrag }, { id: E(3), bank: '987.65' }]), ibans: [I1, I2, I3] };
  const o = await opzet(M);
  try {
    await kind(o.dir, 'ronde', INV(), o.env);
    let x = (await kind(o.dir, 'betaallijst', {})).lijsten[0];
    assert.equal(x.status, 'klaar'); assert.ok(x.zacht.some((z) => /nog niet vergrendeld/.test(z))); assert.equal(x.definitief, false);
    assert.equal((await kind(o.dir, 'betaalbestand', ARG({ formaat: 'csv' }))).code, 'bewust');
    assert.equal((await kind(o.dir, 'betaalbestand', ARG({ formaat: 'csv', bewust: true }))).ok, true);
    await kind(o.dir, 'betaalgemeld', { runs: [RUN] });
    // zelfde bedragen: opnieuw gelezen, niets gewijzigd
    M.log.length = 0; await kind(o.dir, 'ronde', INV(), o.env);
    assert.ok(M.log.some((y) => /wagecodes/.test(y)));
    x = (await kind(o.dir, 'betaallijst', {})).lijsten[0]; assert.ok(x.gemeld && x.gedownload && !x.gewijzigd);
    // Aurore rekent opnieuw: ander bedrag; de versie die de app eerder zag geeft geen bestand meer
    const oudeVersie = x.versie;
    bedrag = '1600.00'; await kind(o.dir, 'ronde', INV(), o.env);
    assert.equal((await kind(o.dir, 'betaalbestand', ARG({ formaat: 'csv', bewust: true, versie: oudeVersie }))).code, 'versie');
    x = (await kind(o.dir, 'betaallijst', {})).lijsten[0];
    assert.equal(x.gemeld, null); assert.equal(x.gedownload, null); assert.equal(x.gewijzigd, true); assert.equal(x.totaal_centen, 493325);
    assert.ok(x.zacht.some((z) => /gewijzigd sinds/.test(z)));
    // vergrendeld
    M.locked = true; await kind(o.dir, 'ronde', INV(), o.env);
    x = (await kind(o.dir, 'betaallijst', {})).lijsten[0];
    assert.equal(x.definitief, true); assert.ok(!x.zacht.some((z) => /vergrendeld/.test(z))); assert.equal(x.gewijzigd, true, 'nog niet opnieuw gemeld: blijft gewijzigd');
    // review MOET 3: het punt blijft staan (ook na een ongewijzigde ronde) tot een bewuste download
    assert.ok(x.zacht.some((z) => /gewijzigd sinds/.test(z)), 'MOET 3: punt blijft na vergrendeling');
    assert.equal((await kind(o.dir, 'betaalbestand', ARG({ formaat: 'csv' }))).code, 'bewust');
    assert.equal((await kind(o.dir, 'betaalbestand', ARG({ formaat: 'csv', bewust: true }))).ok, true);
    x = (await kind(o.dir, 'betaallijst', {})).lijsten[0]; assert.deepEqual(x.zacht, []);
    // vergrendeld én gedownload: dezelfde dag geen nieuwe vragen meer
    M.log.length = 0; await kind(o.dir, 'ronde', INV(), o.env);
    assert.ok(!M.log.some((y) => /wagecodes/.test(y)));
  } finally { o.sluit(); }
});
test('review ronde 4 MOET 1: lijst langer dan 2 dagen niet nagekeken → hard verouderd, geen bestand', async () => {
  const M = { log: [], doc202: 0, ro: RO3, ibans: [I1, I2, I3] };
  const o = await opzet(M);
  try {
    await kind(o.dir, 'ronde', INV(), o.env);
    const d = o.db(); d.prepare('update betaallijst set opgehaald = ?').run(new Date(Date.now() - 49 * 3600000).toISOString()); d.close();
    const x = (await kind(o.dir, 'betaallijst', {})).lijsten[0];
    assert.ok(x.hard.some((h) => /2 dagen/.test(h)), JSON.stringify(x.hard));
    assert.equal((await kind(o.dir, 'betaalbestand', ARG({ formaat: 'csv' }))).code, 'controle');
  } finally { o.sluit(); }
});
test('review MOET 1: vergrendeld maar nog niet gedownload → elke ronde opnieuw; IBAN gewijzigd in Nmbrs → nieuw IBAN, opnieuw te melden', async () => {
  const M = { log: [], doc202: 0, ro: RO3, ibans: [I1, I2, I3] };
  const o = await opzet(M);
  try {
    await kind(o.dir, 'ronde', INV(), o.env);
    await kind(o.dir, 'betaalgemeld', { runs: [RUN] });
    M.ibans = [I1, 'NL85TEST0000000004', I3]; M.log.length = 0;
    await kind(o.dir, 'ronde', INV(), o.env);
    assert.ok(M.log.some((y) => /bankaccounts/.test(y)) && M.log.some((y) => /wagecodes/.test(y)));
    const x = (await kind(o.dir, 'betaallijst', {})).lijsten[0];
    assert.equal(x.gemeld, null); assert.equal(x.gewijzigd, true); assert.ok(x.regels.some((r) => r.iban4 === '…0004'));
    const csv = await kind(o.dir, 'betaalbestand', ARG({ formaat: 'csv' }));
    assert.ok(csv.tekst.includes('NL85TEST0000000004') && !csv.tekst.includes(I2));
  } finally { o.sluit(); }
});
test('wv3232 oude SEPA-rij wordt opnieuw gelezen; taak 403 → blijvend; bankrekeningen 403 → wacht_iban; afgekeurd (mod-97) → geen bestand', async () => {
  const M = { log: [], doc202: 0, ro: RO3, ibans: [I1, 'NL70TEST0000000001', I3] };
  const o = await opzet(M);
  try {
    // een rij uit wv3229 (SEPA, afgekeurd) — loonrun eerst laten bestaan
    M.taak403 = true; await kind(o.dir, 'ronde', INV(), o.env);
    let d = o.db(); let b = d.prepare('select status from betaallijst where run = ?').get(RUN); d.close();
    assert.equal(b.status, 'blijvend');
    // oude SEPA-rij die al gemeld was (zoals R11): nooit opnieuw lezen en niet tonen
    d = o.db(); d.prepare("update betaallijst set status = 'afgekeurd', controle = ?, gemeld = '2026-11-16T10:00:00Z' where run = ?").run(JSON.stringify({ hard: ['onleesbaar', 'leeg'], zacht: [] }), RUN); d.close();
    M.taak403 = false; M.log.length = 0;
    let r = await kind(o.dir, 'ronde', INV(), o.env);
    assert.ok(!M.log.some((y) => /wagecodes/.test(y))); assert.equal((await kind(o.dir, 'betaallijst', {})).lijsten.length, 0);
    // oude SEPA-rij zonder melding: wel opnieuw lezen
    d = o.db(); d.prepare("update betaallijst set gemeld = null where run = ?").run(RUN); d.close();
    M.bank403 = true;
    r = await kind(o.dir, 'ronde', INV(), o.env);
    assert.equal(r.betaal.wacht_iban, 1, JSON.stringify(r.betaal)); assert.equal(r.betaal.bank, false);
    let x = (await kind(o.dir, 'betaallijst', {})).lijsten[0]; assert.equal(x.status, 'wacht_iban');
    M.bank403 = false; r = await kind(o.dir, 'ronde', INV(), o.env);
    x = (await kind(o.dir, 'betaallijst', {})).lijsten[0];
    assert.equal(x.status, 'afgekeurd'); assert.ok(x.hard.some((h) => /mod-97/.test(h)));
    assert.equal((await kind(o.dir, 'betaalbestand', ARG({ formaat: 'csv' }))).code, 'controle');
  } finally { o.sluit(); }
});

// ── actieplan 2B13 (Fable-review R2-46): één kapotte tekenverwijzing breekt de ronde niet meer af ──────────────────────
test('2B13 tekenverwijzing buiten Unicode (&#x110000; / &#1114112;) → geen RangeError; in employeeid of een sleutelveld onleesbaar', () => {
  for (const ref of ['&#x110000;', '&#1114112;', '&#xFFFFFFFFFF;', '&#99999999999999999999;']) {
    let r;
    assert.doesNotThrow(() => { r = B.leesRunOutput(runOutput([{ id: '1' + ref, bank: '1.00' }, { id: E(2), bank: '1500.00' }])); }, ref);
    assert.equal(r.ok, true); assert.equal(r.onleesbaar, true, ref); assert.equal(r.per[E(2)].bank, 150000);
  }
  const r2 = B.leesRunOutput(RO3().replace('<year>2026</year>', '<year>2026&#x110000;</year>'));
  assert.equal(r2.ok, true); assert.equal(r2.onleesbaar, true, 'kapotte verwijzing in jaar/periode/run: dubbel-controle niet te omzeilen');
  assert.equal(B.leesRunOutput(runOutput([{ id: E(1), bank: '10.00' }, { id: E(1), bank: '10.00' }]).replace('<runnumber>12</runnumber>', '<runnumber>12&#x110000;</runnumber>')).onleesbaar, true);
  assert.equal(B.leesRunOutput(runOutput([{ id: E(1), bank: '1.0&#x110000;' }])).onleesbaar, true);
  // geldige verwijzingen blijven werken
  assert.equal(B.leesRunOutput(runOutput([{ id: 'e&#x30;1', bank: '&#49;.00' }])).per['e01'].bank, 100);
});

test('2B13 ronde: run output met &#x110000; → ronde loopt door (ok), lijst afgekeurd als onleesbaar, geen bestand', async () => {
  const M = { log: [], doc202: 0, ro: () => RO3().replace('<employeeid>' + E(1), '<employeeid>' + E(1) + '&#x110000;'), ibans: [I1, I2, I3] };
  const o = await opzet(M);
  try {
    const r = await kind(o.dir, 'ronde', INV(), o.env);
    assert.equal(r && r.ok, true, JSON.stringify(r));
    const x = (await kind(o.dir, 'betaallijst', {})).lijsten[0];
    assert.equal(x.status, 'afgekeurd'); assert.ok(x.hard.some((h) => /niet \(helemaal\) te lezen/.test(h)), JSON.stringify(x.hard));
    assert.equal((await kind(o.dir, 'betaalbestand', ARG({ formaat: 'csv' }))).code, 'controle');
  } finally { o.sluit(); }
});

test('wv3917 (2C15) ronde: twee medewerkers op één IBAN → klaar, punt met namen in de app, melding zonder namen, CSV/pain met beide; negatief → alleen die regel weg', async () => {
  const M = { log: [], doc202: 0, ro: RO3, ibans: [I1, I1, I3] };
  const o = await opzet(M);
  try {
    let r = await kind(o.dir, 'ronde', INV(), o.env);
    assert.equal(r.betaal.klaar, 1, JSON.stringify(r.betaal));
    let x = (await kind(o.dir, 'betaallijst', {})).lijsten[0];
    assert.equal(x.status, 'klaar'); assert.deepEqual(x.hard, []); assert.equal(x.aantal, 3);
    assert.equal(x.zacht.length, 1); assert.match(x.zacht[0], /Anna Proef en Bert van Voorbeeld hebben hetzelfde rekeningnummer \(…0001\)/);
    assert.deepEqual(x.zacht_kort, [B.UITLEG.iban_gedeeld]);
    assert.equal((await kind(o.dir, 'betaalbestand', ARG({ formaat: 'csv' }))).code, 'bewust');
    const csv = await kind(o.dir, 'betaalbestand', ARG({ formaat: 'csv', bewust: true }));
    assert.equal(csv.ok, true, JSON.stringify(csv)); assert.equal(csv.aantal, 3);
    const xml = await kind(o.dir, 'betaalbestand', ARG({ bewust: true }));
    assert.equal(xml.ok, true, JSON.stringify(xml)); assert.equal(xml.aantal, 3); const v = xsd(xml.tekst); if (v !== null) assert.equal(v, 'OK');
    // oude bewaarde controle met het harde punt 'dubbel' (van vóór 22-11) houdt een klaar-lijst niet meer tegen
    let dd = o.db(); const c0 = JSON.parse(dd.prepare('select controle from betaallijst').get().controle);
    dd.prepare('update betaallijst set controle = ?').run(JSON.stringify(Object.assign(c0, { hard: ['dubbel'], zacht: [] }))); dd.close();
    x = (await kind(o.dir, 'betaallijst', {})).lijsten[0];
    assert.deepEqual(x.hard, []); assert.equal(x.zacht.length, 1, 'gedeeld-punt opnieuw berekend uit de regels');
    // negatief bedrag bij Bert: lijst klaar met 2 regels; Bert als punt, niet in het bestand
    M.ro = () => runOutput([{ id: E(1), bank: '2345.60' }, { id: E(2), bank: '-25.00' }, { id: E(3), bank: '987.65' }]); M.ibans = [I1, I2, I3];
    dd = o.db(); dd.prepare('update betaallijst set opgehaald = ?').run(new Date(Date.now() - 25 * 3600000).toISOString()); dd.close();
    r = await kind(o.dir, 'ronde', INV(), o.env);
    x = (await kind(o.dir, 'betaallijst', {})).lijsten[0];
    assert.equal(x.status, 'klaar', JSON.stringify(x.hard)); assert.deepEqual(x.hard, []); assert.equal(x.aantal, 2); assert.equal(x.totaal_centen, 333325);
    assert.deepEqual(x.regels.map((y) => y.naam), ['Proef, Anna', 'Toets, Cor']);
    assert.ok(x.zacht.some((z) => /^Bert van Voorbeeld \(…0002\): negatief bedrag \(€ -25,00\)/.test(z)), JSON.stringify(x.zacht));
    assert.ok(x.zacht_kort.includes(B.UITLEG.regel_afgekeurd)); assert.ok(!/Bert|Voorbeeld/.test(JSON.stringify(x.zacht_kort)));
    const c2 = await kind(o.dir, 'betaalbestand', ARG({ formaat: 'csv', bewust: true }));
    assert.equal(c2.ok, true, JSON.stringify(c2)); assert.equal(c2.aantal, 2); assert.ok(!c2.tekst.includes('Voorbeeld')); assert.ok(!c2.tekst.includes(I2));
    const uit = JSON.stringify(r); assert.ok(![I1, I2, 'Proef', 'Bert'].some((y) => uit.includes(y)), 'geen naam of IBAN in de ronde-uitvoer');
  } finally { o.sluit(); }
});
