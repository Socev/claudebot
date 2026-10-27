'use strict';
// Toetsen voor facturen-sepa.js (wv1405): datums (TARGET2), kenmerk en RF, tekens, bedragen, BIC, en het pain.001.001.09-bestand tegen het
// XSD (test/schema/pain.001.001.09.xsd, het ISO 20022-schema; zie het bouwplan voor de herkomst). Alles verzonnen: IBAN's met bankcode TEST
// (geldig mod-97, geen echte rekening) en het voorbeeld-IBAN uit de documentatie; kenmerken met de hand uitgerekend.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const S = require(path.join(ROOT, 'facturen-sepa.js'));
const K = require(path.join(ROOT, 'facturen-kern.js'));
const Z = require(path.join(ROOT, 'test', 'facturen-zaad.js'));
const XSD = path.join(__dirname, 'schema', 'pain.001.001.09.xsd');

const LEV = Z.maakIban('NL', 'TEST', '0000000777');
const DOC_IBAN = 'NL91ABNA0417164300';   // het voorbeeld-IBAN uit de bankdocumentatie

// XSD-validatie met lxml (python3 -I); zonder lxml: overslaan met een melding (de pod heeft hem, gemeten 27-10)
function xsd(tekst) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sepa-')), 'b.xml');
  fs.writeFileSync(p, tekst);
  const r = spawnSync('python3', ['-I', '-c', 'import sys\nfrom lxml import etree\ns=etree.XMLSchema(etree.parse(sys.argv[1]))\nok=s.validate(etree.parse(sys.argv[2]))\n' +
    'print("OK" if ok else "FOUT " + str(s.error_log))', XSD, p], { encoding: 'utf8' });
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
  if (r.status !== 0 && /No module named/.test(r.stderr || '')) return null;
  return (r.stdout || '').trim() || r.stderr;
}
const kop = (o) => Object.assign({ msg_id: 'SOCEV-20261027-0a1b2c3d', cre_dt_tm: '2026-10-27T09:30:00', initg_naam: 'Proefpraktijk B.V.', dbtr_naam: 'Proefpraktijk B.V.',
  dbtr_iban: DOC_IBAN, dbtr_bic: S.bicVoor(DOC_IBAN) }, o || {});
const regel = (o) => Object.assign({ factuur: '0123456789abcdef', datum: '2026-10-28', centen: 12345, iban: LEV, naam: 'Leverancier A B.V.', rmt: { ustrd: 'F-2026-001' } }, o || {});

test('TARGET2-werkdagen: weekend, Nieuwjaar, Goede Vrijdag en Paasmaandag (2027: 26-3 en 29-3), 1 mei, Kerst; Koningsdag is wel een werkdag', () => {
  assert.equal(S.pasen(2027), '2027-03-28');
  assert.equal(S.pasen(2026), '2026-04-05');
  for (const d of ['2026-10-31', '2026-11-01', '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-01', '2026-12-25', '2026-12-26', '2026-04-03', '2026-04-06']) assert.equal(S.isWerkdag(d), false, d);
  for (const d of ['2026-10-27', '2026-10-30', '2027-03-25', '2027-03-30', '2027-04-27', '2026-12-24', '2026-12-28']) assert.equal(S.isWerkdag(d), true, d);
  assert.equal(S.isWerkdag('2026-02-30'), false);
  assert.equal(S.werkdagVanaf('2026-12-25'), '2026-12-28');
  assert.equal(S.werkdagTot('2027-03-29'), '2027-03-25');
});

test('uitvoerdatum: vervaldatum; in het weekend de werkdag ervóór; nooit vóór vandaag; zelf gekozen wint; voorbij → eerstvolgende werkdag; te ver', () => {
  const v = '2026-10-27';   // dinsdag
  assert.deepEqual(S.grenzen(v), { vroegst: '2026-10-27', uiterst: '2027-10-26' });
  assert.equal(S.grenzen('2026-10-31').vroegst, '2026-11-02', 'zaterdag → maandag');
  assert.deepEqual(S.uitvoerVoor({ vervaldatum: '2026-11-05' }, v), { datum: '2026-11-05', bron: 'vervaldatum', te_ver: false });
  assert.deepEqual(S.uitvoerVoor({ vervaldatum: '2026-11-01' }, v), { datum: '2026-10-30', bron: 'werkdag_ervoor', te_ver: false }, 'zondag → vrijdag');
  assert.deepEqual(S.uitvoerVoor({ vervaldatum: '2026-10-01' }, v), { datum: '2026-10-27', bron: 'eerstvolgende_werkdag', te_ver: false }, 'verlopen');
  assert.deepEqual(S.uitvoerVoor({ vervaldatum: '2026-11-01' }, '2026-10-31'), { datum: '2026-11-02', bron: 'eerstvolgende_werkdag', te_ver: false }, 'vrijdag ligt al achter ons');
  assert.deepEqual(S.uitvoerVoor({}, v), { datum: '2026-10-27', bron: 'eerstvolgende_werkdag', te_ver: false });
  assert.deepEqual(S.uitvoerVoor({ vervaldatum: '2026-11-05', betaal_op: '2026-12-15' }, v), { datum: '2026-12-15', bron: 'gekozen', te_ver: false });
  assert.deepEqual(S.uitvoerVoor({ vervaldatum: '2026-11-05', betaal_op: '2026-10-20' }, v), { datum: '2026-10-27', bron: 'gekozen_voorbij', te_ver: false });
  assert.equal(S.uitvoerVoor({ vervaldatum: '2062-10-27' }, v).te_ver, true, 'OCR-fout in het jaartal');
});

test('zelf gekozen datum: werkdag, niet voorbij, hooguit 364 dagen vooruit', () => {
  const v = '2026-10-27';
  assert.equal(S.datumFout('2026-11-05', v), null);
  assert.equal(S.datumFout('2026-10-27', v), null, 'vandaag mag (de bank schuift na de cut-off)');
  assert.match(S.datumFout('2026-10-31', v), /bankwerkdag.*2026-11-02/);
  assert.match(S.datumFout('2026-12-25', v), /bankwerkdag.*2026-12-28/);
  assert.match(S.datumFout('2026-10-26', v), /voorbij/);
  assert.match(S.datumFout('2027-10-27', v), /364/);
  assert.equal(S.datumFout('2027-10-26', v), null);
  assert.match(S.datumFout('27-10-2026', v), /JJJJ-MM-DD/);
});

test('betalingskenmerk (elfproef, met de hand uitgerekend) en RF-referentie (ISO 11649-voorbeeld)', () => {
  for (const k of ['9000000000000001', '1100000000000000', '1000000000000005', '5000000000000011', '0000000000000000', '1000001000000000']) assert.equal(S.kenmerkOk(k), true, k);
  for (const k of ['8000000000000001', '9000000000000002', '900000000000001', '90000000000000011', 'a000000000000001']) assert.equal(S.kenmerkOk(k), false, k);
  assert.equal(S.rfOk('RF18539007547034'), true);
  assert.equal(S.rfOk('RF18539007547035'), false);
  assert.equal(S.rfOk('RF1'), false);
  assert.deepEqual(S.omschrijving({ nummer: 'F-1', kenmerk: '9000 0000 0000 0001' }), { strd: { ref: '9000000000000001', issr: 'CUR' } });
  assert.deepEqual(S.omschrijving({ nummer: 'F-1', kenmerk: 'rf18 5390 0754 7034' }), { strd: { ref: 'RF18539007547034', issr: 'ISO' } });
  assert.deepEqual(S.omschrijving({ nummer: 'F-1', kenmerk: '8000000000000001' }), { ustrd: 'F-1 8000000000000001', waarschuwing: 'kenmerk_fout' });
  assert.deepEqual(S.omschrijving({ nummer: 'F-1', kenmerk: '1234567' }), { ustrd: 'F-1 1234567' }, '7 cijfers: vrije tekst');
  assert.deepEqual(S.omschrijving({ nummer: null, kenmerk: null }), { ustrd: null });
  assert.equal(S.omschrijving({ nummer: 'x'.repeat(200) }).ustrd.length, 140);
});

test('tekens: basis-Latijnse set van de EPC (accenten weg, & → en, rest een spatie); id zonder begin- of eind-/ en zonder //', () => {
  assert.equal(S.tekst('Café Ærø & Søn — “test” ß', 70), "Cafe AEro en Son - test ss".replace(' - ', ' '));
  assert.equal(S.tekst('a<b>c"d', 70), 'a b c d');
  assert.equal(S.tekst('Łódź Đurđevac Œuvre', 70), 'Lodz Durdevac OEuvre', 'letters die NFKD niet opsplitst (diffreview #11)');
  assert.equal(S.tekst('x'.repeat(80), 70).length, 70);
  assert.equal(S.id('//ab//cd/', 35), 'ab/cd');
  assert.equal(S.bedrag(12345), '123.45');
  assert.equal(S.bedrag(5), '0.05');
  assert.equal(S.bedrag(100), '1.00');
  assert.throws(() => S.bedrag(0));
  assert.throws(() => S.bedrag(-1));
  assert.throws(() => S.bedrag(1.5));
});

test('BIC uit de eigen bankcode; EER-lijst (geen GB, CH of TR)', () => {
  assert.equal(S.bicVoor(DOC_IBAN), 'ABNANL2A');
  assert.equal(S.bicVoor(Z.maakIban('NL', 'INGB', '0000000001')), 'INGBNL2A');
  assert.equal(S.bicVoor(Z.maakIban('NL', 'TRIO', '0000000001')), 'TRIONL2U');
  assert.equal(S.bicVoor(LEV), null);
  assert.equal(S.isEer(LEV), true);
  assert.equal(S.isEer('DE89370400440532013000'), true);
  for (const l of ['GB', 'CH', 'TR', 'MC', 'SM']) assert.equal(S.isEer(l + '00X'), false, l);
});

test('bestand: geldig volgens het XSD (pain.001.001.09); één PmtInf per datum; totalen; NOTPROVIDED zonder BIC; gestructureerd kenmerk', (t) => {
  const r = [regel(), regel({ factuur: '1123456789abcdef', datum: '2026-11-02', centen: 5, naam: 'Leverancier Ä & Zoon', rmt: { strd: { ref: '9000000000000001', issr: 'CUR' } } }),
    regel({ factuur: '2123456789abcdef', datum: '2026-10-28', centen: 100, rmt: null })];
  const x = S.xml(kop(), r);
  assert.equal(x.blokken.length, 2);
  assert.deepEqual(x.blokken.map((b) => [b.pmtinf_id, b.datum, b.regels.length]), [['SOCEV-20261027-0a1b2c3d-1', '2026-10-28', 2], ['SOCEV-20261027-0a1b2c3d-2', '2026-11-02', 1]]);
  assert.match(x.tekst, /<NbOfTxs>3<\/NbOfTxs>\s*<CtrlSum>124\.50<\/CtrlSum>/);
  assert.match(x.tekst, /<CtrlSum>124\.45<\/CtrlSum>/);
  assert.match(x.tekst, /<BICFI>ABNANL2A<\/BICFI>/);
  assert.match(x.tekst, /<Nm>Leverancier A en Zoon<\/Nm>/);
  assert.match(x.tekst, /<Cd>SCOR<\/Cd><\/CdOrPrtry><Issr>CUR<\/Issr><\/Tp><Ref>9000000000000001<\/Ref>/);
  assert.doesNotMatch(x.tekst, /PstlAdr|CdtrAgt|BtchBookg/, 'geen adres, geen BIC van de ontvanger, geen BtchBookg');
  const v = xsd(x.tekst);
  if (v === null) { t.skip('lxml ontbreekt'); return; }
  assert.equal(v, 'OK');
  const zonder = S.xml(kop({ dbtr_iban: LEV, dbtr_bic: null }), [regel()]);
  assert.match(zonder.tekst, /<Othr><Id>NOTPROVIDED<\/Id><\/Othr>/);
  assert.equal(xsd(zonder.tekst), 'OK');
  // het grootste bedrag en de langste velden
  const groot = S.xml(kop({ initg_naam: 'N'.repeat(70) }), [regel({ centen: 99999999999, naam: 'Z'.repeat(70), rmt: { ustrd: 'O'.repeat(140) } })]);
  assert.equal(xsd(groot.tekst), 'OK');
  assert.throws(() => S.xml(kop(), []));
});

test('deterministisch: dezelfde invoer = hetzelfde bestand; de inhoudsleutel verandert met datum, bedrag, IBAN of naam, niet met MsgId of tijd', () => {
  const r = [regel()];
  assert.equal(S.xml(kop(), r).tekst, S.xml(kop(), r).tekst);
  const k0 = S.inhoudSleutel(kop(), r);
  assert.equal(S.inhoudSleutel(kop({ msg_id: 'SOCEV-20261027-ffffffff', cre_dt_tm: '2026-10-27T23:59:59' }), r), k0);
  for (const o of [{ datum: '2026-10-29' }, { centen: 12346 }, { iban: Z.maakIban('NL', 'TEST', '0000000778') }, { naam: 'Leverancier B B.V.' }, { rmt: { ustrd: 'anders' } }])
    assert.notEqual(S.inhoudSleutel(kop(), [regel(o)]), k0, JSON.stringify(o));
  assert.notEqual(S.inhoudSleutel(kop({ dbtr_iban: LEV }), r), k0);
  assert.equal(S.nieuwMsgId('2026-10-27', '0a1b2c3d'), 'SOCEV-20261027-0a1b2c3d');
  assert.throws(() => S.nieuwMsgId('2026-10-27', 'xyz'));
  assert.ok(K.ibanMod97(LEV));
});
