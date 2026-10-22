'use strict';
// Toetsen voor facturen-bank.js (wv798, Facturen-app F1b). Alles synthetisch: IBAN's met bankcode TEST of lage ABN-nummers, "Leverancier
// A B.V.", verzonnen bedragen. Oracle voor ING-CSV en ABN-TAB: test/referentie/fv2-bankparser.js (FV2, bewezen op 6.963 echte regels),
// alleen het pure deel, in een vm. MT940 en ING-komma hebben geen oracle: daar rekent Python de entry_ref onafhankelijk na (str(float)).
// Raakt geen pod, kluis, bank, mail of vault. Draaien: bash test/facturen-bank.sh
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const B = require(path.resolve(__dirname, '..', 'facturen-bank.js'));
const L = require(path.resolve(__dirname, '..', 'mt940-lezer.js'));

// ── oracle: het pure deel van de FV2-parser (tot de n8n-hoofdlogica) ──
const refBron = fs.readFileSync(path.join(__dirname, 'referentie', 'fv2-bankparser.js'), 'utf8');
const refPuur = refBron.slice(0, refBron.indexOf('// ---------- hoofdlogica'));
const REF = {};
vm.runInNewContext(refPuur + '\nOUT.parseIng = parseIng; OUT.parseAbn = parseAbn; OUT.assignEntryRefs = assignEntryRefs; OUT.utf8DecodeReplace = utf8DecodeReplace;', { OUT: REF, BigInt });
function oracle(tekst) {
  const isIng = tekst.split('\n', 1)[0].indexOf('"Datum";') !== -1;
  const rijen = isIng ? REF.parseIng(tekst) : REF.parseAbn(tekst);
  REF.assignEntryRefs(rijen, 'x');
  for (const r of rijen) {
    r.omschrijving = r.omschrijving === null ? null : r.omschrijving.slice(0, 200);
    r.transactietype = r.transactietype === null ? null : r.transactietype.slice(0, 60);
  }
  return JSON.parse(JSON.stringify(rijen));   // uit de vm: gewone objecten
}

// ── synthetische stamgegevens ──
function maakIban(land, bank, rek) {
  const r = bank + rek + land + '00';
  let rest = 0;
  for (const ch of r) { const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch; for (const d of v) rest = (rest * 10 + Number(d)) % 97; }
  return land + String(98 - rest).padStart(2, '0') + bank + rek;
}
const ING_KM = maakIban('NL', 'TEST', '0000000031'), ING_SLOEL = maakIban('NL', 'TEST', '0000000032');
const ABN_TG = L.ibanFromAbnAccount('0000000011'), ABN_GH = L.ibanFromAbnAccount('0000000012'), ABN_PRIVE = L.ibanFromAbnAccount('0000000019');
const ABN_POT = L.ibanFromAbnAccount('0000000015'), ABN_ONBEKEND = L.ibanFromAbnAccount('0000000099');
const LEV = { A: maakIban('NL', 'TEST', '0000000101'), B: maakIban('NL', 'TEST', '0000000201'), C: maakIban('NL', 'TEST', '0000000301'),
  E: maakIban('NL', 'TEST', '0000000501'), F: maakIban('NL', 'TEST', '0000000601'), VREEMD: maakIban('NL', 'TEST', '0000000666'),
  ZV: maakIban('NL', 'TEST', '0000000701'), BD: maakIban('NL', 'TEST', '0000000801') };
const REKENINGEN = [
  { iban: ING_KM, entiteit: 'kostenmaatschap', bank_formaat: 'ing_csv', controle: 1 },
  { iban: ING_SLOEL, entiteit: 'sloel', bank_formaat: 'ing_csv', controle: 1 },
  { iban: ABN_TG, entiteit: 'tolgaarde', bank_formaat: 'abn_tab', controle: 1 },
  { iban: ABN_GH, entiteit: 'groenhouten', bank_formaat: 'abn_mt940', controle: 1 },
  { iban: ABN_PRIVE, entiteit: 'prive', bank_formaat: 'abn_tab', controle: 0, alleen_eigenaar: 1 },
  { rek: 'b0000000000000a1', iban: ABN_POT, entiteit: 'pot', bank_formaat: 'bankluis', controle: 1, alleen_eigenaar: 1 },
];
const ENT = [
  { sleutel: 'tolgaarde', ibans: [ABN_TG] }, { sleutel: 'groenhouten', ibans: [ABN_GH] }, { sleutel: 'prive', ibans: [ABN_PRIVE] },
  { sleutel: 'kostenmaatschap', ibans: [ING_KM] }, { sleutel: 'sloel', ibans: [ING_SLOEL] }, { sleutel: 'pot', ibans: [ABN_POT] },
];
const lang = (n, basis) => { let s = ''; let i = 0; while (s.length < n) s += (basis || 'Omschrijving deel ') + (i++) + ' '; return s.slice(0, n); };

// ── fixtures: ING-CSV (puntkomma, huidige variant) ──
const ING_KOP = '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen";"Saldo na mutatie";"Tag"';
const ingRij = (o) => ['"' + o.datum + '"', '"' + (o.naam || '') + '"', '"' + (o.rek || ING_KM) + '"', '"' + (o.tegen || '') + '"', '"' + (o.code || 'OV') + '"',
  '"' + (o.afbij || 'Af') + '"', '"' + o.bedrag + '"', '"' + (o.soort || 'Overschrijving') + '"', '"' + String(o.med || '').replace(/"/g, '""') + '"', '"' + (o.saldo || '') + '"', '""'].join(';');
const ING_RIJEN = [
  { datum: '20261001', naam: 'Leverancier A B.V.', tegen: LEV.A, bedrag: '1.234,56', med: 'Naam: Leverancier A B.V. Omschrijving: Factuur VB-2026-0412 Kenmerk: VB20260412 IBAN: ' + LEV.A, saldo: '10.000,00' },
  { datum: '20261002', naam: 'Leverancier C B.V.', tegen: LEV.C, code: 'IC', bedrag: '84,12', soort: 'Incasso', med: 'Naam: Leverancier C B.V. Omschrijving: Termijn oktober Machtiging ID: MTEST001 Incassant ID: NL00ZZZTEST0000000301 Kenmerk: TERMIJN10 Doorlopende incasso', saldo: '9.915,88' },
  { datum: '20261003', naam: 'Klant met "aanhalingstekens"', tegen: LEV.B, afbij: 'Bij', bedrag: '100,00', med: 'Terugbetaling; met puntkomma', saldo: '10.015,88' },
  { datum: '20261004', naam: 'Leverancier lang 1', tegen: LEV.F, bedrag: '12,50', med: lang(250), saldo: '10.003,38' },
  { datum: '20261005', naam: 'Leverancier lang 2', tegen: LEV.F, bedrag: '13,50', med: lang(650), saldo: '9.989,88' },
  { datum: '20261006', naam: 'Kosten', tegen: '', code: 'DV', bedrag: '2,00', soort: 'Diversen', med: '', saldo: '9.987,88' },
  { datum: '20261007', naam: 'Dubbel', tegen: LEV.A, bedrag: '5,00', med: 'zelfde', saldo: '' },
  { datum: '20261007', naam: 'Dubbel', tegen: LEV.A, bedrag: '5,00', med: 'zelfde', saldo: '' },
  { datum: '20261007', naam: 'Dubbel', tegen: LEV.A, bedrag: '5,00', med: 'zelfde', saldo: '' },
  { datum: '20261008', naam: 'Leverancier A B.V.', rek: ING_SLOEL, tegen: LEV.A, bedrag: '0,99', med: 'Ünïcödé € — test', saldo: '1,00' },
];
const ING_CSV = '﻿' + ING_KOP + '\r\n' + ING_RIJEN.map(ingRij).join('\r\n') + '\r\n';

// ── fixtures: ABN-TAB (twee eigen rekeningen + Privé, SEPA-gestructureerd en vrije tekst) ──
const tabRij = (acct, dat, begin, eind, bedrag, desc, munt) => [acct, munt || 'EUR', dat, begin, eind, dat, bedrag, desc].join('\t');
const ABN_TAB_REGELS = [
  tabRij('0000000011', '20261001', '5000,00', '4750,00', '-250,00', '/TRTP/SEPA OVERBOEKING/IBAN/' + LEV.A + '/BIC/TESTNL2A/NAME/Leverancier A B.V./REMI/Factuur VB-2026-0413/EREF/NOTPROVIDED'),
  tabRij('0000000011', '20261002', '4750,00', '4665,88', '-84,12', '/TRTP/SEPA Incasso algemeen doorlopend/CSID/NL00ZZZTEST0000000301/NAME/Leverancier C B.V./MARF/MTEST001/REMI/Termijn oktober/IBAN/' + LEV.C + '/BIC/TESTNL2A/EREF/TERMIJN10'),
  tabRij('0000000011', '20261003', '4665,88', '4565,88', '-100,00', 'SEPA Overboeking                 IBAN: ' + LEV.B + '        BIC: TESTNL2A                    Naam: Leverancier B B.V.         Omschrijving: Factuur 2026-77    Kenmerk: 1234567890123456'),
  tabRij('0000000011', '20261004', '4565,88', '4560,88', '-5,00', 'BEA, Betaalpas                   Winkel Voorbeeld,PAS123         NR:TEST01, 04.10.26/12:00        Voorbeeld'),
  tabRij('0000000011', '20261005', '4560,88', '4548,38', '-12,50', '/TRTP/SEPA OVERBOEKING/IBAN/' + LEV.F + '/BIC/TESTNL2A/NAME/Leverancier F/REMI/' + lang(620) + '/EREF/NOTPROVIDED'),
  tabRij('0000000011', '20261006', '4548,38', '4535,88', '-12,50', 'SEPA Incasso algemeen doorlopend Incassant: NL00ZZZTEST0000000501 Naam: Leverancier E B.V. Machtiging: MTEST005 Omschrijving: ' + lang(560, 'Lang vrij ') + ' IBAN: ' + LEV.E + ' Kenmerk: E-2026-10'),
  tabRij('0000000019', '20261006', '900,00', '850,00', '-50,00', '/TRTP/SEPA OVERBOEKING/IBAN/' + LEV.A + '/BIC/TESTNL2A/NAME/Iets privé/REMI/privé uitgave/EREF/NOTPROVIDED'),
  tabRij('0000000012', '20261007', '200,00', '1200,00', '1000,00', '/TRTP/SEPA OVERBOEKING/IBAN/' + LEV.ZV + '/BIC/TESTNL2A/NAME/Zorgverzekeraar Voorbeeld/REMI/Declaratie september/EREF/DECL09'),
  tabRij('0000000012', '20261008', '1200,00', '1100,00', '-100,00', 'ABN AMRO Bank N.V.               Rente en/of kosten'),
  tabRij('0000000012', '20261008', '1200,00', '1100,00', '-100,00', 'ABN AMRO Bank N.V.               Rente en/of kosten'),
];
const ABN_TAB = ABN_TAB_REGELS.join('\n') + '\n';

function vergelijkMetOracle(tekst, rekeningen) {
  const ref = oracle(tekst);
  const r = B.leesBankbestand(tekst, { rekeningen });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.transacties.length, ref.length);
  ref.forEach((o, i) => {
    const t = r.transacties[i];
    assert.deepEqual({ eigen_iban: t.eigen_iban, boekdatum: t.boekdatum, tegenpartij_iban: t.tegenpartij_iban, tegenpartij_naam: t.tegenpartij_naam, bedrag: t.bedrag,
      omschrijving: t.omschrijving, kenmerk: t.kenmerk, transactietype: t.transactietype, is_incasso: t.is_incasso, entry_ref: t.entry_ref },
    { eigen_iban: o.eigen_iban, boekdatum: o.boekdatum, tegenpartij_iban: o.tegenpartij_iban, tegenpartij_naam: o.tegenpartij_naam, bedrag: o.bedrag,
      omschrijving: o.omschrijving, kenmerk: o.betalingskenmerk, transactietype: o.transactietype, is_incasso: o.is_incasso, entry_ref: o.entry_ref }, 'rij ' + i);
  });
  return r;
}
const alleControle = REKENINGEN.map((r) => Object.assign({}, r, { controle: 1, bank_formaat: r.bank_formaat === 'ing_csv' ? 'ing_csv' : 'abn_tab' }));

// ── Python als onafhankelijke rekenaar van entry_ref (str(float), sha1) ──
const PY = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' }).status === 0;
function pyRefs(rijen) {
  const prog = 'import sys,json,hashlib\nseen={}\nout=[]\nfor r in json.load(sys.stdin):\n  b=float(r[2])\n  s="|".join(["None" if x is None else str(x) for x in [r[0],r[1],b,r[3],r[4],r[5]]])\n' +
    '  h=hashlib.sha1(s.encode("utf-8")).hexdigest()[:20]\n  n=seen.get(h,0); seen[h]=n+1\n  out.append(h+("-%d"%n if n else ""))\nprint(json.dumps(out))';
  const p = spawnSync('python3', ['-c', prog], { input: JSON.stringify(rijen), encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  return JSON.parse(p.stdout);
}

// ═════════════════════════════ parsers ═════════════════════════════

test('ING-CSV puntkomma: zelfde uitvoer en entry_ref als FV2 (incl. omschrijving > 200 en > 500, duplicaten -1/-2, BOM, CRLF, quotes)', () => {
  const r = vergelijkMetOracle(ING_CSV, REKENINGEN);
  assert.equal(r.formaat, 'ing_csv');
  const refs = r.transacties.map((t) => t.entry_ref);
  assert.match(refs[7], /-1$/); assert.match(refs[8], /-2$/); assert.equal(refs[6].length, 20);
  assert.equal(r.transacties[3].omschrijving.length, 200);
  assert.equal(r.transacties[4].omschrijving.length, 200);
  // de hash gebruikt de 500 tekens: wie eerst op 200 kapt, krijgt een andere ref
  const fout = B.mkRef([ING_KM, '2026-10-05', -13.5, '9.989,88', lang(650).slice(0, 200), LEV.F]);
  assert.notEqual(r.transacties[4].entry_ref, fout);
  assert.equal(r.transacties[4].entry_ref, B.mkRef([ING_KM, '2026-10-05', -13.5, '9.989,88', lang(650).slice(0, 500), LEV.F]));
  assert.equal(r.transacties[1].is_incasso, true);
  assert.equal(r.transacties[1].incassant_id, 'NL00ZZZTEST0000000301');
  assert.equal(r.transacties[1].machtiging, 'MTEST001');
  assert.equal(r.transacties[0].bedrag_centen, -123456);
  assert.equal(r.transacties[2].bedrag_centen, 10000);
  assert.equal(r.transacties[5].omschrijving, null);
  assert.equal(r.transacties[5].tegenpartij_iban, null);
  assert.deepEqual(r.per_rekening, { [ING_KM]: 9, [ING_SLOEL]: 1 });
});

test('ING-CSV als bytes (ook ongeldige UTF-8) = FV2 met utf8DecodeReplace', () => {
  const bytes = Buffer.concat([Buffer.from(ING_KOP + '\n' + ingRij({ datum: '20261001', naam: 'X', tegen: LEV.A, bedrag: '1,00', med: 'kapot ', saldo: '1,00' }).slice(0, -2), 'utf8'),
    Buffer.from([0xff, 0xc3, 0x28, 0xe2, 0x82]), Buffer.from('"' + ';"1,00";""\n', 'utf8')]);
  const ref = REF.parseIng(REF.utf8DecodeReplace(Array.from(bytes)));
  REF.assignEntryRefs(ref, 'x');
  const r = B.leesBankbestand(bytes, { rekeningen: REKENINGEN });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.transacties[0].entry_ref, ref[0].entry_ref);
  assert.equal(r.transacties[0].omschrijving, ref[0].omschrijving.slice(0, 200));
});

test('ABN-TAB: zelfde uitvoer en entry_ref als FV2 (meerdere rekeningen, SEPA-gestructureerd, vrije tekst, lange omschrijving, duplicaat)', () => {
  const r = vergelijkMetOracle(ABN_TAB, alleControle);
  assert.equal(r.formaat, 'abn_tab');
  assert.equal(r.transacties[1].incassant_id, 'NL00ZZZTEST0000000301');
  assert.equal(r.transacties[1].machtiging, 'MTEST001');
  assert.equal(r.transacties[1].is_incasso, true);
  assert.equal(r.transacties[5].incassant_id, 'NL00ZZZTEST0000000501');
  assert.equal(r.transacties[5].machtiging, 'MTEST005');
  assert.equal(r.transacties[2].kenmerk, '1234567890123456');
  assert.match(r.transacties[9].entry_ref, /-1$/);
  assert.equal(r.transacties[4].omschrijving.length, 200);
  assert.equal(r.transacties[0].valuta, 'EUR');
});

test('ABN-TAB met Privé: Privé-regels weg zonder opslag, rest ongewijzigd (zelfde entry_ref als zonder Privé)', () => {
  const r = B.leesBankbestand(ABN_TAB, { rekeningen: REKENINGEN.map((x) => (x.iban === ABN_GH ? Object.assign({}, x, { bank_formaat: 'abn_tab' }) : x)) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.prive_weggegooid, 1);
  assert.equal(r.transacties.length, 9);
  assert.ok(!r.transacties.some((t) => t.eigen_iban === ABN_PRIVE || t.entiteit === 'prive'));
  assert.ok(!JSON.stringify(r).includes('privé uitgave'));
  const zonder = oracle(ABN_TAB_REGELS.filter((x) => !x.startsWith('0000000019')).join('\n'));
  assert.deepEqual(r.transacties.map((t) => t.entry_ref), zonder.map((o) => o.entry_ref));
});

test('ING-CSV oude komma-variant (zonder saldo en tag, "MutatieSoort"): eigen parser, entry_ref door Python nagerekend', () => {
  const kop = '"Datum","Naam / Omschrijving","Rekening","Tegenrekening","Code","Af Bij","Bedrag (EUR)","MutatieSoort","Mededelingen"';
  const rij = (d, n, t, c, ab, b, s, m) => ['"' + d + '"', '"' + n + '"', '"' + ING_KM + '"', '"' + t + '"', '"' + c + '"', '"' + ab + '"', '"' + b + '"', '"' + s + '"', '"' + m + '"'].join(',');
  const tekst = kop + '\n' + [
    rij('20261001', 'Leverancier A B.V.', LEV.A, 'OV', 'Af', '1.234,56', 'Overschrijving', 'Factuur VB-2026-0412, met komma Kenmerk: VB20260412'),
    rij('20261002', 'Leverancier C B.V.', LEV.C, 'IC', 'Af', '84,12', 'Incasso', 'Incassant ID: NL00ZZZTEST0000000301 Machtiging ID: MTEST001'),
    rij('20261003', 'Iemand', LEV.B, 'GT', 'Bij', '100,00', 'Online bankieren', lang(700)),
    rij('20261003', 'Iemand', LEV.B, 'GT', 'Bij', '100,00', 'Online bankieren', lang(700)),
  ].join('\n');
  assert.equal(B.herkenFormaat(tekst), 'ing_csv');
  const r = B.leesBankbestand(tekst, { rekeningen: REKENINGEN });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.transacties.length, 4);
  assert.equal(r.transacties[0].transactietype, 'ING:OV:Overschrijving');
  assert.equal(r.transacties[0].kenmerk, 'VB20260412');
  assert.equal(r.transacties[1].incassant_id, 'NL00ZZZTEST0000000301');
  assert.equal(r.transacties[2].bedrag, 100);
  if (PY) {
    const py = pyRefs([
      [ING_KM, '2026-10-01', -1234.56, '', 'Factuur VB-2026-0412, met komma Kenmerk: VB20260412', LEV.A],
      [ING_KM, '2026-10-02', -84.12, '', 'Incassant ID: NL00ZZZTEST0000000301 Machtiging ID: MTEST001', LEV.C],
      [ING_KM, '2026-10-03', 100.0, '', lang(700).slice(0, 500), LEV.B],
      [ING_KM, '2026-10-03', 100.0, '', lang(700).slice(0, 500), LEV.B],
    ]);
    assert.deepEqual(r.transacties.map((t) => t.entry_ref), py);
  }
  // dezelfde mutatie in de nieuwe variant (met saldo) geeft een andere entry_ref → daarom één formaat per rekening + vangnet
  const nieuw = B.leesBankbestand(ING_KOP + '\n' + ingRij({ datum: '20261001', naam: 'Leverancier A B.V.', tegen: LEV.A, bedrag: '1.234,56', med: 'Factuur VB-2026-0412, met komma Kenmerk: VB20260412', saldo: '10.000,00' }), { rekeningen: REKENINGEN });
  assert.notEqual(nieuw.transacties[0].entry_ref, r.transacties[0].entry_ref);
});

// MT940: twee afschriften (IBAN en 10 cijfers), storno RC/RD, vervolgregels :86: zonder tussenteken (afgebroken midden in een woord),
// boekdatum met jaarwissel, duplicaat.
const MT_IBAN = ABN_GH;
const MT940 = [
  'ABNANL2A', '940', 'ABNANL2A',
  ':20:ABN AMRO BANK NV', ':25:' + MT_IBAN, ':28C:1', ':60F:C261230EUR1000,00',
  ':61:2612311231D45,50N426NONREF', ':86:/TRTP/SEPA OVERBOEKING/IBAN/' + LEV.A + '/BIC/TESTNL2A/NAME/Leverancier A B.V./REMI/Factuur VB-20',
  '26-0999 abonnem', 'ent/EREF/NOTPROVIDED',
  ':61:2612310102D20,00N426NONREF', ':86:/TRTP/SEPA Incasso algemeen doorlopend/CSID/NL00ZZZTEST0000000301/NAME/Leverancier C B.V./MARF/MTE',
  'ST001/REMI/Termijn januari/IBAN/' + LEV.C + '/BIC/TESTNL2A/EREF/TERMIJN01',
  ':61:2612310102RD20,00N426NONREF', ':86:/TRTP/SEPA Incasso algemeen doorlopend/CSID/NL00ZZZTEST0000000301/NAME/Leverancier C B.V./MARF/MTE',
  'ST001/REMI/Termijn januari/IBAN/' + LEV.C + '/BIC/TESTNL2A/EREF/TERMIJN01',
  ':61:2612311231C150,00N541NONREF', ':86:SEPA Overboeking                 IBAN: ' + LEV.ZV + '        BIC: TESTNL2A                    Naam: Zorgverzekeraar Voorbeeld  Omschrijving: Declaratie novem',
  'ber',
  ':61:2612311231RC7,25N426NONREF', ':86:ABN AMRO Bank N.V.               Rente en/of kosten',
  ':61:2612311231D3,00N426NONREF', ':86:ABN AMRO Bank N.V.               Kosten',
  ':61:2612311231D3,00N426NONREF', ':86:ABN AMRO Bank N.V.               Kosten',
  ':62F:C261231EUR1091,25', '-',
  ':20:ABN AMRO BANK NV', ':25:0000000012', ':28C:2', ':60F:C261231EUR1091,25',
  ':61:2701020102D85,75N426NONREF', ':86:/TRTP/SEPA OVERBOEKING/IBAN/' + LEV.B + '/BIC/TESTNL2A/NAME/Leverancier B B.V./REMI/Factuur 2026-78/EREF/NOTPROVIDED',
  ':62F:C270102EUR1005,50', '-',
].join('\r\n') + '\r\n';

test('ABN-MT940: blokken, storno RC/RD, vervolgregels zonder tussenteken, jaarwissel, 10-cijferig rekeningnummer; entry_ref door Python nagerekend', () => {
  assert.equal(B.herkenFormaat(MT940), 'abn_mt940');
  const r = B.leesBankbestand(MT940, { rekeningen: REKENINGEN });
  assert.equal(r.ok, true, JSON.stringify(r));
  const t = r.transacties;
  assert.equal(t.length, 8);
  assert.ok(t.every((x) => x.eigen_iban === MT_IBAN && x.entiteit === 'groenhouten'));
  assert.equal(t[0].omschrijving, 'Factuur VB-2026-0999 abonnement');   // midden in een woord afgebroken, zonder tussenteken aaneen
  assert.equal(t[0].boekdatum, '2026-12-31');
  assert.equal(t[1].boekdatum, '2027-01-02');   // valutadatum 31-12, boekdatum 0102 → volgend jaar
  assert.equal(t[1].bedrag_centen, -2000);
  assert.equal(t[1].is_incasso, true);
  assert.equal(t[1].incassant_id, 'NL00ZZZTEST0000000301');
  assert.equal(t[1].machtiging, 'MTEST001');
  assert.equal(t[2].bedrag_centen, 2000);   // RD = storno van een afschrijving (teruggeboekte incasso): geld terug
  assert.equal(t[2].storno, undefined);
  assert.equal(t[3].bedrag_centen, 15000);
  assert.equal(t[3].omschrijving, 'Declaratie november');
  assert.equal(t[3].transactietype, 'ABN:SEPA Overboeking');
  assert.equal(t[4].bedrag_centen, -725);   // RC = storno van een bijschrijving: geld eraf
  assert.match(t[6].entry_ref, /-1$/);
  assert.equal(t[7].boekdatum, '2027-01-02');
  if (PY) {
    const py = pyRefs(t.map((x, i) => [MT_IBAN, x.boekdatum, x.bedrag_centen / 100, '', i === 0 ? 'Factuur VB-2026-0999 abonnement' : x.omschrijving, x.tegenpartij_iban]));
    assert.deepEqual(t.map((x) => x.entry_ref), py);
  }
});

test('ABN-MT940: saldo sluit niet → hele bestand geweigerd, zonder bedragen in de uitleg', () => {
  const kapot = MT940.replace(':62F:C261231EUR1091,25', ':62F:C261231EUR1091,20');
  const r = B.leesBankbestand(kapot, { rekeningen: REKENINGEN });
  assert.equal(r.ok, false);
  assert.equal(r.fout, 'saldo_sluit_niet');
  assert.ok(!/\d+,\d{2}/.test(r.uitleg) && !r.uitleg.includes(MT_IBAN), r.uitleg);
  assert.equal(B.leesBankbestand(':20:X\r\n:25:' + MT_IBAN + '\r\n:60F:C261230EUR1,00\r\n:61:ZZZ\r\n:62F:C261231EUR1,00\r\n-', { rekeningen: REKENINGEN }).fout, 'mt940_ongeldig');
});

test('round-trip: de MT940 van de POT-afschriftmaker gaat door de eigen ABN-MT940-parser (zelfde aantallen, saldi en bedragen)', () => {
  const P = require(path.resolve(__dirname, '..', 'pot-afschrift.js'));
  const IB = L.ibanFromAbnAccount('0000000015');
  const posten = [
    { nr: 2, datum: '2026-09-02', bedrag: -1500.25, saldo_na: 8499.75, tegenpartij: 'Medewerker Een', tegen_iban: LEV.A, regels: ['SEPA Batch Salaris', 'Naam: Medewerker Een'], code: null },
    { nr: 3, datum: '2026-09-15', bedrag: 250, saldo_na: 8749.75, tegenpartij: 'Praktijk Voorbeeld', tegen_iban: LEV.B, regels: ['SEPA Overboeking', 'Omschrijving: bijdrage'], code: null },
    { nr: 4, datum: '2026-09-30', bedrag: -3.5, saldo_na: 8746.25, tegenpartij: 'ABN AMRO Bank N.V.', tegen_iban: null, regels: ['ABN AMRO Bank N.V.', 'Kosten'], code: null },
  ];
  const a = P.maakAfschrift({ maand: '2026-09', rekening: { iban: IB, valuta: 'EUR' }, gemaakt: '2026-10-03T06:00:00Z', vandaag: '2026-10-03', laatstGezien: '2026-10-03T05:00:00Z',
    nieuwstePost: '2026-10-01', eersteMaand: '2026-06', posten, voorDag: [{ nr: 1, datum: '2026-08-31', bedrag: -10, saldo_na: 10000, tegenpartij: 'x', tegen_iban: null, regels: ['x'] }], stukken: {} });
  assert.equal(a.ok, true, JSON.stringify(a.reden));
  const r = B.leesBankbestand(Buffer.from(a.mt940, 'latin1'), { rekeningen: [{ iban: IB, entiteit: 'pot', bank_formaat: 'abn_mt940', controle: 1 }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.transacties.map((t) => t.bedrag_centen), [-150025, 25000, -350]);
  assert.deepEqual(r.transacties.map((t) => t.boekdatum), ['2026-09-02', '2026-09-15', '2026-09-30']);
  // en de echte POT-rekening (bankluis) weigert dat bestand: de gemaakte MT940 wordt nooit ingelezen
  const w = B.leesBankbestand(a.mt940, { rekeningen: [{ iban: IB, entiteit: 'pot', bank_formaat: 'bankluis', controle: 1 }] });
  assert.equal(w.ok, false); assert.equal(w.fout, 'verkeerd_formaat');
});

test('formaatherkenning en weigeren: verkeerd formaat, onbekende rekening, bankluis-rekening, CAMT, onzin, leeg, kapotte regel', () => {
  assert.equal(B.herkenFormaat(ING_CSV), 'ing_csv');
  assert.equal(B.herkenFormaat(ABN_TAB), 'abn_tab');
  assert.equal(B.herkenFormaat('<?xml version="1.0"?><Document><BkToCstmrStmt/></Document>'), 'camt053');
  assert.equal(B.herkenFormaat('hallo\nwereld'), null);
  // ABN-TAB voor een rekening die als MT940 is vastgelegd → weigeren met uitleg
  const tabGh = tabRij('0000000012', '20261007', '200,00', '1200,00', '1000,00', '/TRTP/SEPA OVERBOEKING/IBAN/' + LEV.ZV + '/NAME/Zorgverzekeraar Voorbeeld/REMI/x');
  const v = B.leesBankbestand(tabGh, { rekeningen: REKENINGEN });
  assert.equal(v.ok, false); assert.equal(v.fout, 'verkeerd_formaat'); assert.match(v.uitleg, /abn_mt940/);
  // onbekende rekening → hele bestand weg (ook de bekende regels), uitleg alleen de laatste vier tekens
  const metOnbekend = ABN_TAB + tabRij('0000000099', '20261009', '1,00', '0,00', '-1,00', 'BEA, Betaalpas x') + '\n';
  const o = B.leesBankbestand(metOnbekend, { rekeningen: alleControle });
  assert.equal(o.ok, false); assert.equal(o.fout, 'onbekende_rekening'); assert.equal(o.transacties, undefined);
  assert.ok(!o.uitleg.includes(ABN_ONBEKEND) && o.uitleg.includes(ABN_ONBEKEND.slice(-4)), o.uitleg);
  // upload voor de POT (bankluis) → weigeren: anders dubbel naast de bankkoppeling
  const pot = tabRij('0000000015', '20261009', '1,00', '0,00', '-1,00', 'BEA, Betaalpas x');
  assert.equal(B.leesBankbestand(pot, { rekeningen: REKENINGEN }).fout, 'verkeerd_formaat');
  assert.equal(B.leesBankbestand('<?xml version="1.0"?><Document><BkToCstmrStmt/></Document>', { rekeningen: REKENINGEN }).fout, 'formaat_onbekend');
  assert.equal(B.leesBankbestand('hallo', { rekeningen: REKENINGEN }).fout, 'formaat_onbekend');
  assert.equal(B.leesBankbestand(ING_KOP + '\n', { rekeningen: REKENINGEN }).fout, 'leeg');
  assert.equal(B.leesBankbestand(ABN_TAB + '0000000011\tEUR\t20261009\n', { rekeningen: REKENINGEN }).fout, 'regel_ongeldig');
  assert.equal(B.leesBankbestand(ING_KOP + '\n' + ingRij({ datum: '20261001', naam: 'X', bedrag: 'twaalf', med: '' }), { rekeningen: REKENINGEN }).fout, 'regel_ongeldig');
  assert.equal(B.leesBankbestand('"Datum";"Rekening"\n"20261001";"' + ING_KM + '"', { rekeningen: REKENINGEN }).fout, 'kop_ongeldig');
  assert.equal(B.leesBankbestand(new Uint8Array(20 * 1024 * 1024 + 1), { rekeningen: REKENINGEN }).fout, 'te_groot');
  // geen weigerreden noemt een bedrag of naam uit het bestand
  for (const x of [v, o]) assert.ok(!/Leverancier|Zorgverzekeraar|\d+,\d{2}/.test(x.uitleg), x.uitleg);
  // zelfde bestand twee keer: zelfde entry_refs (stapelt niets in de UNIQUE-kolom)
  const een = B.leesBankbestand(ING_CSV, { rekeningen: REKENINGEN }), twee = B.leesBankbestand(ING_CSV, { rekeningen: REKENINGEN });
  assert.deepEqual(een.transacties.map((t) => t.entry_ref), twee.transacties.map((t) => t.entry_ref));
});

test('bankluis: alleen booked en niet vervangen; entry_ref bankluis:<rek>|<sleutel>; ABN-omschrijving uit de ruwe regels ontleed', () => {
  const rk = REKENINGEN.find((r) => r.bank_formaat === 'bankluis');
  const post = { rek: rk.rek, sleutel: 'e:ABC123', status: 'booked', datum: '2026-10-02', bedrag: -84.12, valuta: 'EUR', tegenpartij: 'Leverancier C B.V.', tegen_iban: LEV.C,
    omschrijving: 'samengevat', vervangen_door: null,
    ruwe_json: JSON.stringify({ remittance_information: ['/TRTP/SEPA Incasso algemeen doorlopend/CSID/NL00ZZZTEST0000000301/NAME/Leverancier C B.V./MARF/MTE', 'ST001/REMI/Termijn oktober/EREF/T10'] }) };
  const r = B.normaliseerBankluis(post, rk);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.transactie.entry_ref, 'bankluis:' + rk.rek + '|e:ABC123');
  assert.equal(r.transactie.bedrag_centen, -8412);
  assert.equal(r.transactie.is_incasso, true);
  assert.equal(r.transactie.incassant_id, 'NL00ZZZTEST0000000301');
  assert.equal(r.transactie.machtiging, 'MTEST001');
  assert.equal(r.transactie.omschrijving, 'Termijn oktober');
  assert.equal(r.transactie.kenmerk, 'T10');
  assert.equal(r.transactie.alleen_eigenaar, true);
  assert.equal(r.transactie.entiteit, 'pot');
  assert.equal(B.normaliseerBankluis(Object.assign({}, post, { status: 'pending' }), rk).fout, 'niet_geboekt');
  assert.equal(B.normaliseerBankluis(Object.assign({}, post, { vervangen_door: 77 }), rk).fout, 'vervangen');
  assert.equal(B.normaliseerBankluis(Object.assign({}, post, { rek: 'ander' }), rk).fout, 'andere_rekening');
  assert.equal(B.normaliseerBankluis(post, Object.assign({}, rk, { bank_formaat: 'abn_mt940' })).fout, 'geen_bankluis_rekening');
  assert.equal(B.normaliseerBankluis(post, Object.assign({}, rk, { controle: 0 })).fout, 'prive');
  const vrij = B.normaliseerBankluis(Object.assign({}, post, { ruwe_json: null, omschrijving: 'Betaling Kenmerk: K-77 webshop' }), rk);
  assert.equal(vrij.transactie.kenmerk, 'K-77');
  assert.equal(vrij.transactie.is_incasso, false);
});

// ═════════════════════════════ matching en signalen ═════════════════════════════

const VANDAAG = '2026-10-22';
const LEVS = [
  { id: 'la', naam: 'Leverancier A B.V.', ibans: [LEV.A], standaard_betaalwijze: 'zelf' },
  { id: 'lb', naam: 'Leverancier B B.V.', ibans: [LEV.B], standaard_betaalwijze: 'zelf' },
  { id: 'lc', naam: 'Leverancier C B.V.', ibans: [LEV.C], incassant_ids: ['NL00ZZZTEST0000000301'], standaard_betaalwijze: 'incasso' },
  { id: 'ld', naam: 'Leverancier D Inc.', ibans: [], standaard_betaalwijze: 'zelf' },
  { id: 'le', naam: 'Leverancier E B.V.', ibans: [LEV.E], incassant_ids: ['NL00ZZZTEST0000000501'], standaard_betaalwijze: 'zelf' },
  { id: 'lf', naam: 'Leverancier F B.V.', ibans: [LEV.F], standaard_betaalwijze: 'zelf' },
];
let txNr = 0;
const tx = (o) => Object.assign({ id: 't' + String(++txNr).padStart(3, '0'), eigen_iban: ABN_TG, entiteit: 'tolgaarde', valuta: 'EUR', is_incasso: false, incassant_id: null,
  kenmerk: null, omschrijving: null, tegenpartij_iban: null, tegenpartij_naam: null, transactietype: 'ABN:SEPA Overboeking', bestand: 'bestand1' }, o, { entry_ref: o.entry_ref || 'ref' + txNr });
const fac = (o) => Object.assign({ entiteit: 'tolgaarde', valuta: 'EUR', status: 'verstuurd', soort: 'factuur', betaalwijze: 'zelf', betaalspoor: 'te_betalen' }, o);
const controle = (o) => B.bankcontrole(Object.assign({ vandaag: VANDAAG, leveranciers: LEVS, entiteiten: ENT, rekeningen: REKENINGEN, uitzonderingen: [], koppelingen: [], opdrachten: [] }, o));
const soorten = (r) => r.signalen.map((s) => s.soort).sort();

test('kenmerk / factuurnummer in de omschrijving → automatisch gekoppeld; IBAN + exact bedrag idem; betaalspoor → betaald_gezien', () => {
  const f1 = fac({ id: 'f1', leverancier: 'la', nummer: 'VB-2026-0412', incl: 123456, iban: LEV.A, factuurdatum: '2026-09-20', vervaldatum: '2026-10-04' });
  const f2 = fac({ id: 'f2', leverancier: 'lb', nummer: '2026-77', incl: 10000, iban: LEV.B, factuurdatum: '2026-09-25', vervaldatum: '2026-10-09' });
  const t1 = tx({ boekdatum: '2026-10-01', bedrag_centen: -123456, tegenpartij_iban: LEV.A, omschrijving: 'Factuur VB-2026-0412' });
  const t2 = tx({ boekdatum: '2026-10-03', bedrag_centen: -10000, tegenpartij_iban: LEV.B, omschrijving: 'betaling' });
  const r = controle({ transacties: [t1, t2], facturen: [f1, f2] });
  assert.deepEqual(r.koppelingen.map((k) => [k.transactie, k.factuur, k.methode]), [[t1.id, 'f1', 'kenmerk'], [t2.id, 'f2', 'iban_bedrag']]);
  assert.deepEqual(r.betaalspoor.map((b) => b.naar), ['betaald_gezien', 'betaald_gezien']);
  assert.deepEqual(r.signalen, []);
  // een kort getal in een langer getal is geen factuurnummer
  const f3 = fac({ id: 'f3', leverancier: 'lb', nummer: '77', incl: 999, iban: LEV.B, factuurdatum: '2026-09-25' });
  assert.equal(B.matchTransactie(tx({ boekdatum: '2026-10-03', bedrag_centen: -5000, omschrijving: 'order 1977' }), [f3], {}).length, 0);
});

test('verzamelbetaling: één afschrijving voor twee van drie open facturen (subset-som) → beide gekoppeld, de derde blijft open', () => {
  const fs3 = [fac({ id: 'v1', leverancier: 'la', nummer: 'A-1', incl: 12000, factuurdatum: '2026-09-01', vervaldatum: '2026-10-01' }),
    fac({ id: 'v2', leverancier: 'la', nummer: 'A-2', incl: 24550, factuurdatum: '2026-09-05', vervaldatum: '2026-10-05' }),
    fac({ id: 'v3', leverancier: 'la', nummer: 'A-3', incl: 8025, factuurdatum: '2026-10-15', vervaldatum: '2026-11-14' })];
  const t = tx({ boekdatum: '2026-10-06', bedrag_centen: -36550, tegenpartij_iban: LEV.A, omschrijving: 'diverse facturen' });
  const r = controle({ transacties: [t], facturen: fs3 });
  assert.deepEqual(r.koppelingen.map((k) => k.factuur).sort(), ['v1', 'v2']);
  assert.ok(r.koppelingen.every((k) => k.methode === 'subset'));
  assert.deepEqual(r.signalen, []);   // v3 vervalt pas in november
});

test('creditnota verrekend: factuur € 500 min creditnota € 100 = één afschrijving van € 400 → beide gekoppeld, geen signaal', () => {
  const fx = [fac({ id: 'c1', leverancier: 'lb', nummer: 'B-10', incl: 50000, factuurdatum: '2026-09-01', vervaldatum: '2026-09-30' }),
    fac({ id: 'c2', leverancier: 'lb', nummer: 'CN-3', soort: 'creditnota', incl: -10000, factuurdatum: '2026-09-10', vervaldatum: '2026-09-30' })];
  const t = tx({ boekdatum: '2026-09-29', bedrag_centen: -40000, tegenpartij_iban: LEV.B, omschrijving: 'saldo' });
  const r = controle({ transacties: [t], facturen: fx });
  assert.deepEqual(r.koppelingen.map((k) => k.factuur).sort(), ['c1', 'c2']);
  assert.deepEqual(r.signalen, []);
  // een creditnota die apart wordt terugbetaald (bijschrijving) → gekoppeld op IBAN + bedrag
  const t2 = tx({ boekdatum: '2026-10-01', bedrag_centen: 10000, tegenpartij_iban: LEV.B });
  const r2 = controle({ transacties: [t2], facturen: [fx[1]] });
  assert.deepEqual(r2.koppelingen.map((k) => [k.factuur, k.methode]), [['c2', 'iban_bedrag']]);
});

test('wisselende incasso: elke maand een ander bedrag → elke incasso bij zijn eigen factuur; kleine afwijking binnen de tolerantie', () => {
  const fx = [fac({ id: 'w8', leverancier: 'lc', nummer: 'C-08', incl: 8412, betaalwijze: 'incasso', betaalspoor: 'incasso_verwacht', factuurdatum: '2026-08-01', vervaldatum: '2026-08-15' }),
    fac({ id: 'w9', leverancier: 'lc', nummer: 'C-09', incl: 9740, betaalwijze: 'incasso', betaalspoor: 'incasso_verwacht', factuurdatum: '2026-09-01', vervaldatum: '2026-09-15' }),
    fac({ id: 'w10', leverancier: 'lc', nummer: 'C-10', incl: 9105, betaalwijze: 'incasso', betaalspoor: 'incasso_verwacht', factuurdatum: '2026-10-01', vervaldatum: '2026-10-15' })];
  const inc = (d, c) => tx({ boekdatum: d, bedrag_centen: c, is_incasso: true, incassant_id: 'NL00ZZZTEST0000000301', tegenpartij_iban: LEV.C, transactietype: 'ABN:SEPA Incasso algemeen doorlopend' });
  const ts = [inc('2026-08-15', -8412), inc('2026-09-15', -9740), inc('2026-10-15', -9200)];
  const r = controle({ transacties: ts, facturen: fx });
  assert.deepEqual(r.koppelingen.map((k) => [k.transactie, k.factuur]), [[ts[0].id, 'w8'], [ts[1].id, 'w9'], [ts[2].id, 'w10']]);
  assert.equal(r.koppelingen[2].methode, 'incasso');
  assert.ok(r.koppelingen[2].zekerheid < r.koppelingen[1].zekerheid);
  assert.deepEqual(r.signalen, []);
  // buiten de tolerantie (€ 91,05 → € 120,00) geen incasso-koppeling
  const k = B.matchTransactie(inc('2026-10-15', -12000), [fx[2]], { leveranciers: LEVS });
  assert.equal(k.filter((x) => x.methode === 'incasso').length, 0);
});

test('late betaling (> 60 dagen na vervaldatum): wel gevonden, maar met lagere zekerheid en ter bevestiging (geen hard datumvenster)', () => {
  const f = fac({ id: 'l1', leverancier: 'lf', nummer: 'F-1', incl: 30000, factuurdatum: '2026-06-01', vervaldatum: '2026-07-01' });
  const op = tx({ boekdatum: '2026-07-03', bedrag_centen: -30000, tegenpartij_iban: LEV.F });
  const laat = tx({ boekdatum: '2026-09-25', bedrag_centen: -30000, tegenpartij_iban: LEV.F });
  const kOp = B.matchTransactie(op, [f], { leveranciers: LEVS })[0], kLaat = B.matchTransactie(laat, [f], { leveranciers: LEVS })[0];
  assert.equal(kLaat.facturen[0], 'l1');
  assert.ok(kLaat.zekerheid < kOp.zekerheid);
  assert.equal(kLaat.ter_bevestiging, true);
  const r = controle({ transacties: [laat], facturen: [f] });
  assert.equal(r.koppelingen.length, 0);
  assert.equal(r.voorstellen.length, 1);
  assert.deepEqual(r.signalen, []);   // er ligt een voorstel: geen "te betalen, niet betaald" ernaast
});

test('buitenlandse valuta: tegenpartij + bedrag ± 3 % met een koers → altijd ter bevestiging; zonder koers geen gok', () => {
  const f = fac({ id: 'u1', leverancier: 'ld', nummer: 'INV-2026-55', incl: 10000, valuta: 'USD', factuurdatum: '2026-10-01', vervaldatum: '2026-10-15' });
  const t = tx({ boekdatum: '2026-10-02', bedrag_centen: -9310, tegenpartij_naam: 'LEVERANCIER D INC', transactietype: 'ABN:BEA, Betaalpas' });
  const r = controle({ transacties: [t], facturen: [f], koersen: { USD: 0.92 } });
  assert.equal(r.koppelingen.length, 0);
  assert.equal(r.voorstellen.length, 1);
  assert.equal(r.voorstellen[0].methode, 'valuta');
  assert.equal(r.voorstellen[0].ter_bevestiging, true);
  assert.equal(B.matchTransactie(t, [f], { leveranciers: LEVS }).length, 0);
  assert.equal(B.matchTransactie(tx({ boekdatum: '2026-10-02', bedrag_centen: -9600, tegenpartij_naam: 'LEVERANCIER D INC' }), [f], { leveranciers: LEVS, koersen: { USD: 0.92 } }).length, 0);
});

test('uitzonderingen: declaratie-bijschrijving, loon (salarisbatch), rekening-courant tussen eigen entiteiten, privé-opname, bankkosten', () => {
  const decl = tx({ boekdatum: '2026-10-01', eigen_iban: ABN_GH, entiteit: 'groenhouten', bedrag_centen: 100000, tegenpartij_iban: LEV.ZV, tegenpartij_naam: 'Zorgverzekeraar Voorbeeld', omschrijving: 'Declaratie september' });
  const loon = tx({ boekdatum: '2026-09-25', bedrag_centen: -1200000, transactietype: 'ABN:SEPA Batch Salaris', omschrijving: 'Salarisbetaling batch' });
  const rc = tx({ boekdatum: '2026-09-20', bedrag_centen: -500000, tegenpartij_iban: ABN_GH, omschrijving: 'doorbelasting' });
  const prv = tx({ boekdatum: '2026-09-20', bedrag_centen: -20000, tegenpartij_iban: ABN_PRIVE });
  const kosten = tx({ boekdatum: '2026-09-30', bedrag_centen: -725, transactietype: 'ABN:ABN AMRO Bank N.V.', tegenpartij_naam: null, omschrijving: 'Rente en/of kosten' });
  const belasting = tx({ boekdatum: '2026-09-30', bedrag_centen: -310000, tegenpartij_iban: LEV.BD, tegenpartij_naam: 'Belastingdienst Voorbeeld' });
  const uitz = [
    { id: 'u-decl', richting: 'bij', tegenpartij: 'Zorgverzekeraar', categorie: 'declaraties' },
    { id: 'u-bank', richting: 'af', transactietype: 'ABN AMRO Bank', categorie: 'bankkosten' },
    { id: 'u-lh', richting: 'af', tegenpartij: LEV.BD, categorie: 'loonheffing' },
    { id: 'u-leeg', richting: 'af', categorie: 'overig' },   // zonder patroon: slikt niets
  ];
  const r = controle({ transacties: [decl, loon, rc, prv, kosten, belasting], facturen: [], uitzonderingen: uitz });
  const per = Object.fromEntries(r.uitzonderingen.map((u) => [u.transactie, u.categorie]));
  assert.deepEqual(per, { [decl.id]: 'declaraties', [loon.id]: 'loon', [rc.id]: 'rekening_courant', [prv.id]: 'prive_opname', [kosten.id]: 'bankkosten', [belasting.id]: 'loonheffing' });
  assert.deepEqual(r.signalen, []);
  assert.equal(B.uitzonderingPast({ richting: 'af', categorie: 'overig' }, kosten), false);
  // bedragtolerantie
  const abo = { richting: 'af', tegenpartij: 'Abonnement Voorbeeld', bedrag_centen: 1000, tolerantie_pct: 10, categorie: 'abonnement_zonder_factuur' };
  assert.equal(B.uitzonderingPast(abo, tx({ bedrag_centen: -1090, tegenpartij_naam: 'Abonnement Voorbeeld BV' })), true);
  assert.equal(B.uitzonderingPast(abo, tx({ bedrag_centen: -1200, tegenpartij_naam: 'Abonnement Voorbeeld BV' })), false);
});

test('zelf betaald én geïncasseerd → signaal dubbel betaald; terugvraagtekst om te kopiëren (de app mailt niet); zet op incasso', () => {
  const f = fac({ id: 'd1', leverancier: 'le', nummer: 'E-2026-10', incl: 1250, betaalwijze: 'zelf', betaalspoor: 'ingevoerd', ingevoerd_op: '2026-10-01', factuurdatum: '2026-09-28', vervaldatum: '2026-10-12' });
  const zelf = tx({ boekdatum: '2026-10-02', bedrag_centen: -1250, tegenpartij_iban: LEV.E, omschrijving: 'E-2026-10' });
  const inc = tx({ boekdatum: '2026-10-06', bedrag_centen: -1250, is_incasso: true, incassant_id: 'NL00ZZZTEST0000000501', tegenpartij_iban: LEV.E, transactietype: 'ABN:SEPA Incasso algemeen doorlopend', omschrijving: 'Termijn' });
  const r = controle({ transacties: [inc, zelf], facturen: [f] });
  assert.deepEqual(r.koppelingen.map((k) => [k.transactie, k.factuur]), [[zelf.id, 'd1']]);
  assert.deepEqual(soorten(r), ['dubbel_betaald']);
  const s = r.signalen[0];
  assert.deepEqual(s.transacties, [zelf.id, inc.id]);
  assert.deepEqual(s.knoppen, ['zet_op_incasso', 'terugvraagtekst', 'geen_dubbel']);
  const t = B.afhandelSignaal(s, 'terugvraagtekst', { wie: 'eigenaar', nu: '2026-10-22T10:00:00Z' });
  assert.equal(t.ok, true);
  assert.equal(t.gevolgen[0].actie, 'tekst_tonen');
  assert.match(t.gevolgen[0].tekst, /E-2026-10/); assert.match(t.gevolgen[0].tekst, /€ 12,50/); assert.match(t.gevolgen[0].tekst, /2-10-2026/);
  const z = B.afhandelSignaal(s, 'zet_op_incasso', { wie: 'eigenaar', nu: '2026-10-22T10:00:00Z' });
  assert.deepEqual(z.gevolgen, [{ actie: 'leverancier_bijwerken', leverancier: 'le', veld: 'standaard_betaalwijze', waarde: 'incasso' }]);
  assert.match(z.signaal.les, /Leverancier E B\.V\. incasseert/);
  // een tweede incasso van hetzelfde abonnement (nieuwe maand, factuur nog niet binnen) is GEEN dubbele betaling
  const f2 = fac({ id: 'd2', leverancier: 'lc', nummer: 'C-1', incl: 2000, betaalwijze: 'incasso', betaalspoor: 'incasso_verwacht', factuurdatum: '2026-08-25', vervaldatum: '2026-09-01' });
  const i1 = tx({ boekdatum: '2026-09-01', bedrag_centen: -2000, is_incasso: true, incassant_id: 'NL00ZZZTEST0000000301', tegenpartij_iban: LEV.C });
  const i2 = tx({ boekdatum: '2026-10-01', bedrag_centen: -2000, is_incasso: true, incassant_id: 'NL00ZZZTEST0000000301', tegenpartij_iban: LEV.C });
  assert.deepEqual(soorten(controle({ transacties: [i1, i2], facturen: [f2] })), ['geen_factuur']);
});

test('incasso niet gezien (> 14 dagen na vervaldatum), te betalen niet betaald, ingevoerd niet gezien (> 5 werkdagen)', () => {
  const fx = [
    fac({ id: 'i1', leverancier: 'lc', nummer: 'C-20', incl: 5000, betaalwijze: 'incasso', betaalspoor: 'incasso_verwacht', factuurdatum: '2026-09-01', vervaldatum: '2026-09-20' }),
    fac({ id: 'i2', leverancier: 'lc', nummer: 'C-21', incl: 5100, betaalwijze: 'incasso', betaalspoor: 'incasso_verwacht', factuurdatum: '2026-10-01', vervaldatum: '2026-10-15' }),
    fac({ id: 'p1', leverancier: 'la', nummer: 'A-50', incl: 7000, betaalspoor: 'te_betalen', factuurdatum: '2026-09-15', vervaldatum: '2026-10-15' }),
    fac({ id: 'p2', leverancier: 'la', nummer: 'A-51', incl: 7100, betaalspoor: 'te_betalen', factuurdatum: '2026-10-15', vervaldatum: '2026-11-14' }),
    fac({ id: 'g1', leverancier: 'lb', nummer: 'B-60', incl: 8000, betaalspoor: 'ingevoerd', ingevoerd_op: '2026-10-13T09:00:00Z', factuurdatum: '2026-10-01', vervaldatum: '2026-10-30' }),
    fac({ id: 'g2', leverancier: 'lb', nummer: 'B-61', incl: 8100, betaalspoor: 'ingevoerd', ingevoerd_op: '2026-10-16T09:00:00Z', factuurdatum: '2026-10-01', vervaldatum: '2026-10-30' }),
    fac({ id: 'x1', leverancier: 'lb', nummer: 'B-62', incl: 100, betaalspoor: 'te_betalen', status: 'geen_factuur', vervaldatum: '2026-01-01' }),
  ];
  const r = controle({ transacties: [], facturen: fx });
  assert.deepEqual(r.signalen.map((s) => [s.soort, s.facturen[0]]).sort(), [['incasso_niet_gezien', 'i1'], ['ingevoerd_niet_gezien', 'g1'], ['te_betalen_niet_betaald', 'p1']]);
  assert.equal(B.werkdagenTussen('2026-10-13', '2026-10-22'), 7);
  assert.equal(B.werkdagenTussen('2026-10-16', '2026-10-22'), 4);
  const s = r.signalen.find((x) => x.soort === 'incasso_niet_gezien');
  const a = B.afhandelSignaal(s, 'afwachten', { wie: 'eigenaar', nu: '2026-10-22T10:00:00Z' });
  assert.equal(a.signaal.sluimer_tot, '2026-11-05');
  // na de sluimer komt hij terug; ervoor niet; een gewoon afgehandeld signaal nooit
  const voor = controle({ transacties: [], facturen: fx, bestaandeSignalen: [a.signaal] });
  assert.equal(voor.signalen.filter((x) => x.soort === 'incasso_niet_gezien').length, 0);
  assert.deepEqual(voor.heropenen, []);
  const na = B.bankcontrole({ vandaag: '2026-11-05', leveranciers: LEVS, rekeningen: REKENINGEN, transacties: [], facturen: [fx[0]], bestaandeSignalen: [a.signaal] });
  assert.deepEqual(na.signalen, []);   // geen tweede rij met dezelfde sleutel: de bestaande gaat weer open
  assert.deepEqual(na.heropenen, [{ sleutel: a.signaal.sleutel, soort: 'incasso_niet_gezien' }]);
  // staat dezelfde sleutel er ook open, dan wint open: niets heropenen
  assert.deepEqual(B.bankcontrole({ vandaag: '2026-11-05', leveranciers: LEVS, rekeningen: REKENINGEN, transacties: [], facturen: [fx[0]], bestaandeSignalen: [s, a.signaal] }).heropenen, []);
  const zelf = B.afhandelSignaal(s, 'toch_zelf_betalen', { wie: 'eigenaar', nu: '2026-10-22T10:00:00Z' });
  assert.deepEqual(zelf.gevolgen, [{ actie: 'betaalspoor', factuur: 'i1', gebeurtenis: 'toch_zelf_betalen' }]);
  assert.equal(controle({ transacties: [], facturen: fx, bestaandeSignalen: [zelf.signaal] }).signalen.filter((x) => x.soort === 'incasso_niet_gezien').length, 0);
  // open signaal met dezelfde sleutel → niet nog eens
  assert.equal(controle({ transacties: [], facturen: fx, bestaandeSignalen: r.signalen }).signalen.length, 0);
});

test('incasso niet gezien → toch gevonden: incasso van een bekende incassant komt binnen → gekoppeld, geen signaal', () => {
  const f = fac({ id: 'i1', leverancier: 'lc', nummer: 'C-20', incl: 5000, betaalwijze: 'incasso', betaalspoor: 'incasso_verwacht', factuurdatum: '2026-09-01', vervaldatum: '2026-09-20' });
  const t = tx({ boekdatum: '2026-10-20', bedrag_centen: -5000, is_incasso: true, incassant_id: 'NL00ZZZTEST0000000301', tegenpartij_iban: LEV.C });
  const r = controle({ transacties: [t], facturen: [f] });
  assert.equal(r.koppelingen.length, 1);
  assert.deepEqual(r.signalen, []);
});

test('geen factuur: afschrijving > 7 dagen zonder factuur of uitzondering; een recente nog niet; bijschrijving nooit', () => {
  const oud = tx({ boekdatum: '2026-10-10', bedrag_centen: -4500, tegenpartij_iban: LEV.F, tegenpartij_naam: 'Leverancier F B.V.' });
  const nieuw = tx({ boekdatum: '2026-10-20', bedrag_centen: -4500, tegenpartij_iban: LEV.F });
  const bij = tx({ boekdatum: '2026-10-01', bedrag_centen: 4500, tegenpartij_iban: LEV.F });
  const r = controle({ transacties: [oud, nieuw, bij], facturen: [] });
  assert.deepEqual(r.signalen.map((s) => [s.soort, s.transacties[0]]), [['geen_factuur', oud.id]]);
  const s = r.signalen[0];
  assert.deepEqual(s.knoppen, ['factuur_uploaden', 'is_uitzondering', 'alleen_portaal']);
  assert.equal(B.afhandelSignaal(s, 'is_uitzondering', { wie: 'eigenaar', nu: '2026-10-22T10:00:00Z' }).fout, 'vereist');
  assert.equal(B.afhandelSignaal(s, 'is_uitzondering', { wie: 'eigenaar', nu: '2026-10-22T10:00:00Z', categorie: 'iets' }).fout, 'onbekende_categorie');
  const u = B.afhandelSignaal(s, 'is_uitzondering', { wie: 'eigenaar', nu: '2026-10-22T10:00:00Z', categorie: 'abonnement_zonder_factuur' });
  assert.deepEqual(u.gevolgen, [{ actie: 'uitzondering_maken', uitzondering: { richting: 'af', rekening: ABN_TG, tegenpartij: LEV.F, categorie: 'abonnement_zonder_factuur' } }]);
  // de gemaakte uitzondering dekt de volgende ronde
  const r2 = controle({ transacties: [oud], facturen: [], uitzonderingen: [Object.assign({ id: 'nieuw' }, u.gevolgen[0].uitzondering)] });
  assert.deepEqual(r2.signalen, []);
  assert.equal(r2.uitzonderingen[0].categorie, 'abonnement_zonder_factuur');
});

test('betaald aan onbekend IBAN: bekende incassant op een ander IBAN → fraudesignaal, nooit automatisch gekoppeld en nooit vanzelf bekend', () => {
  const f = fac({ id: 'o1', leverancier: 'lc', nummer: 'C-30', incl: 6000, betaalwijze: 'incasso', betaalspoor: 'incasso_verwacht', factuurdatum: '2026-10-01', vervaldatum: '2026-10-10' });
  const t = tx({ boekdatum: '2026-10-10', bedrag_centen: -6000, is_incasso: true, incassant_id: 'NL00ZZZTEST0000000301', tegenpartij_iban: LEV.VREEMD, tegenpartij_naam: 'Leverancier C B.V.' });
  const r = controle({ transacties: [t], facturen: [f] });
  assert.equal(r.koppelingen.length, 0);
  assert.equal(r.voorstellen.length, 1);
  assert.equal(r.voorstellen[0].tegenpartij_geborgd, false);
  assert.deepEqual(soorten(r), ['onbekend_iban']);
  const s = r.signalen[0];
  assert.deepEqual(s.knoppen, ['uitzoeken']);
  assert.equal(B.afhandelSignaal(s, 'uitzoeken', { wie: 'eigenaar', nu: '2026-10-22T10:00:00Z' }).fout, 'vereist');
  const a = B.afhandelSignaal(s, 'uitzoeken', { wie: 'eigenaar', nu: '2026-10-22T10:00:00Z', toelichting: 'nagebeld: nieuw rekeningnummer klopt' });
  assert.equal(a.ok, true);
  assert.deepEqual(a.gevolgen, []);   // geen leverancier_iban: bekend maken gaat alleen via Nagebeld bij een factuur
  // naam gelijk maar geen bekende IBAN's bij de leverancier → geen signaal (niets om mee te vergelijken)
  const t2 = tx({ boekdatum: '2026-10-10', bedrag_centen: -500, tegenpartij_iban: LEV.VREEMD, tegenpartij_naam: 'Leverancier D Inc.' });
  assert.ok(!soorten(controle({ transacties: [t2], facturen: [] })).includes('onbekend_iban'));
});

test('zelfde periode in twee bestanden (oude en nieuwe ING-variant): andere entry_ref → signaal mogelijk dubbel geüpload; zelfde bestand → niets', () => {
  const nieuwBestand = B.leesBankbestand(ING_KOP + '\n' + ingRij({ datum: '20261001', naam: 'Leverancier F B.V.', tegen: LEV.F, bedrag: '45,00', med: 'Factuur F-9', saldo: '100,00' }), { rekeningen: REKENINGEN });
  const oudKop = '"Datum","Naam / Omschrijving","Rekening","Tegenrekening","Code","Af Bij","Bedrag (EUR)","MutatieSoort","Mededelingen"';
  const oudBestand = B.leesBankbestand(oudKop + '\n"20261001","Leverancier F B.V.","' + ING_KM + '","' + LEV.F + '","OV","Af","45,00","Overschrijving","Factuur F-9"', { rekeningen: REKENINGEN });
  const a = Object.assign({ id: 'ta', bestand: 'b1' }, nieuwBestand.transacties[0]), b = Object.assign({ id: 'tb', bestand: 'b2' }, oudBestand.transacties[0]);
  assert.notEqual(a.entry_ref, b.entry_ref);
  const r = controle({ transacties: [a, b], facturen: [], uitzonderingen: [{ id: 'u', richting: 'af', tegenpartij: LEV.F, categorie: 'overig' }] });
  assert.deepEqual(soorten(r), ['mogelijk_dubbel_geupload']);
  const s = r.signalen[0];
  const h = B.afhandelSignaal(s, 'is_hetzelfde', { wie: 'eigenaar', nu: '2026-10-22T10:00:00Z' });
  assert.deepEqual(h.gevolgen, [{ actie: 'transactie_verwijderen', transactie: 'tb' }]);   // uit het jongste bestand (b2)
  // de jongste is gekoppeld → de andere gaat weg; beide gekoppeld → knop geweigerd
  const fa = fac({ id: 'fx', leverancier: 'lf', nummer: 'F-9', incl: 4500, factuurdatum: '2026-09-20' });
  const r2 = controle({ transacties: [a, b], facturen: [fa], koppelingen: [{ transactie: 'tb', factuur: 'fx', bron: 'mens' }] });
  assert.equal(r2.signalen.find((x) => x.soort === 'mogelijk_dubbel_geupload').details.te_verwijderen, 'ta');
  const r3 = controle({ transacties: [a, b], facturen: [fa], koppelingen: [{ transactie: 'tb', factuur: 'fx', bron: 'mens' }, { transactie: 'ta', factuur: 'fx', bron: 'mens' }] });
  const s3 = r3.signalen.find((x) => x.soort === 'mogelijk_dubbel_geupload');
  assert.equal(B.afhandelSignaal(s3, 'is_hetzelfde', { wie: 'eigenaar', nu: '2026-10-22T10:00:00Z' }).fout, 'voorwaarde');
  // uit hetzelfde bestand (echt twee gelijke posten) of zonder bestand (bankluis) → geen signaal
  assert.equal(B.dubbelGeupload([a, Object.assign({}, b, { bestand: 'b1' })]).length, 0);
  assert.equal(B.dubbelGeupload([Object.assign({}, a, { bestand: undefined }), Object.assign({}, b, { bestand: undefined })]).length, 0);
});

test('dubbele factuur en verzending mislukt: signalen met hun knoppen; gevolgen zijn statusovergangen uit de kern', () => {
  const K = require(path.resolve(__dirname, '..', 'facturen-kern.js'));
  const fx = [fac({ id: 'a1', leverancier: 'la', nummer: 'A-70', incl: 1000, betaalspoor: 'betaald_vooraf' }),
    fac({ id: 'a2', leverancier: 'la', nummer: 'A-70', incl: 1000, status: 'dubbel', dubbel_van: 'a1', betaalspoor: null }),
    fac({ id: 'a3', leverancier: 'la', nummer: 'A-71', incl: 1000, status: 'verzending_mislukt', betaalspoor: 'betaald_vooraf' })];
  const r = controle({ transacties: [], facturen: fx, opdrachten: [{ id: 'op1', factuur: 'a3', entiteit: 'tolgaarde', status: 'geweigerd', poging: 1 }, { id: 'op2', factuur: 'a1', entiteit: 'tolgaarde', status: 'mislukt', poging: 2 }] });
  assert.deepEqual(soorten(r), ['dubbele_factuur', 'verzending_mislukt']);
  const vm1 = r.signalen.find((s) => s.soort === 'verzending_mislukt');
  for (const knop of vm1.knoppen) {
    const a = B.afhandelSignaal(vm1, knop, { wie: 'eigenaar', nu: '2026-10-22T10:00:00Z' });
    assert.equal(K.statusOvergang('verzending_mislukt', a.gevolgen[0].gebeurtenis, { entiteit: 'tolgaarde' }).ok, true, knop);
  }
  const df = r.signalen.find((s) => s.soort === 'dubbele_factuur');
  const t = B.afhandelSignaal(df, 'toch_factuur', { wie: 'eigenaar', nu: '2026-10-22T10:00:00Z' });
  assert.equal(K.statusOvergang('dubbel', t.gevolgen[0].gebeurtenis).ok, true);
});

test('alle signalen: elke knop geeft een les, onbekende knop/zonder wie geweigerd, en geen gevolg betaalt, mailt of maakt een IBAN bekend', () => {
  const TOEGESTAAN = new Set(['upload_openen', 'uitzondering_maken', 'leverancier_bijwerken', 'tekst_tonen', 'factuur_status', 'betaalspoor', 'betaallijst', 'koppelen', 'transactie_verwijderen']);
  const opties = { wie: 'eigenaar', nu: '2026-10-22T10:00:00Z', categorie: 'overig', leverancier: 'la', transactie: 't1', toelichting: 'uitgezocht en in orde' };
  for (const soort of B.SIGNAAL_SOORTEN) {
    const s = B.maakSignaal(soort, { transacties: ['t1', 't2'], facturen: ['f1'], naam: 'Leverancier A B.V.', leverancier: 'la', bedrag_centen: -1000, eigen_iban: ABN_TG, details: { nummer: 'A-1', datums: ['2026-10-01', '2026-10-05'], te_verwijderen: 't2' } });
    assert.ok(s.knoppen.length >= 1, soort);
    for (const knop of s.knoppen) {
      const a = B.afhandelSignaal(s, knop, opties);
      assert.equal(a.ok, true, soort + '/' + knop + ' ' + JSON.stringify(a));
      assert.ok(a.signaal.les.length > 10 && a.signaal.les.length <= 300, soort + '/' + knop);
      assert.equal(a.signaal.status, 'afgehandeld');
      assert.equal(a.signaal.afhandeling, knop);
      for (const g of a.gevolgen) {
        assert.ok(TOEGESTAAN.has(g.actie), soort + '/' + knop + ': ' + g.actie);
        if (g.actie === 'leverancier_bijwerken') assert.ok(['alleen_portaal', 'standaard_betaalwijze'].includes(g.veld));
      }
      assert.equal(B.afhandelSignaal(a.signaal, knop, opties).fout, 'niet_open');
    }
    assert.equal(B.afhandelSignaal(s, 'betalen', opties).fout, 'onbekende_knop');
    assert.equal(B.afhandelSignaal(s, s.knoppen[0], { nu: opties.nu }).fout, 'wie_ontbreekt');
    assert.equal(B.afhandelSignaal(s, s.knoppen[0], { wie: 'eigenaar' }).fout, 'nu_ontbreekt');
  }
  // de tabel uit ontwerp § 4.6, knop voor knop
  assert.deepEqual(Object.fromEntries(B.SIGNAAL_SOORTEN.map((s) => [s, Object.keys(B.SIGNALEN[s].knoppen)])), {
    geen_factuur: ['factuur_uploaden', 'is_uitzondering', 'alleen_portaal'], dubbel_betaald: ['zet_op_incasso', 'terugvraagtekst', 'geen_dubbel'],
    dubbele_factuur: ['is_dubbel', 'toch_factuur'], verzending_mislukt: ['opnieuw_proberen', 'terug_naar_beoordelen'], incasso_niet_gezien: ['toch_zelf_betalen', 'afwachten'],
    te_betalen_niet_betaald: ['naar_betaallijst', 'is_al_betaald'], ingevoerd_niet_gezien: ['opnieuw_kijken', 'koppelen'], onbekend_iban: ['uitzoeken'],
    mogelijk_dubbel_geupload: ['is_hetzelfde', 'zijn_er_twee'],
  });
});

test('POT en Privé: signalen en koppelingen van een eigenaar-rekening, en van een Privé-factuur, zijn alleen voor de eigenaar', () => {
  const potTx = tx({ boekdatum: '2026-10-01', eigen_iban: ABN_POT, entiteit: 'pot', alleen_eigenaar: true, bedrag_centen: -4500, tegenpartij_iban: LEV.F, tegenpartij_naam: 'Leverancier F B.V.' });
  const potTx2 = tx({ boekdatum: '2026-10-02', eigen_iban: ABN_POT, entiteit: 'pot', alleen_eigenaar: true, bedrag_centen: -2500, tegenpartij_iban: LEV.A });
  const f = fac({ id: 'pf', entiteit: 'pot', leverancier: 'la', nummer: 'A-99', incl: 2500, factuurdatum: '2026-09-25', vervaldatum: '2026-10-05' });
  const pf = fac({ id: 'pr', entiteit: 'prive', leverancier: 'lb', nummer: 'B-99', incl: 3000, betaalspoor: 'te_betalen', factuurdatum: '2026-09-01', vervaldatum: '2026-09-15' });
  const r = controle({ transacties: [potTx, potTx2], facturen: [f, pf] });
  // Privé-bankregels worden nooit opgeslagen: een Privé-factuur krijgt dus geen (altijd valse) betaalsignalen
  assert.ok(r.signalen.length === 1 && r.signalen[0].soort === 'geen_factuur' && r.signalen[0].alleen_eigenaar === true, JSON.stringify(r.signalen));
  assert.ok(r.koppelingen.length === 1 && r.koppelingen[0].alleen_eigenaar === true);
  // een gewoon zakelijk signaal niet
  assert.equal(controle({ transacties: [tx({ boekdatum: '2026-10-01', bedrag_centen: -4500, tegenpartij_iban: LEV.F })], facturen: [] }).signalen[0].alleen_eigenaar, false);
  // een factuur van een andere entiteit wordt nooit aan deze rekening gekoppeld (één entiteit per factuur)
  const anders = fac({ id: 'gh', entiteit: 'groenhouten', leverancier: 'la', nummer: 'A-98', incl: 4500, factuurdatum: '2026-09-25' });
  assert.equal(B.matchTransactie(tx({ boekdatum: '2026-10-01', bedrag_centen: -4500, tegenpartij_iban: LEV.A }), [anders], { leveranciers: LEVS }).length, 0);
});

test('subset-som: hooguit 20 open facturen per IBAN (de dichtstbijzijnde), snel bij veel facturen', () => {
  const veel = [];
  for (let i = 0; i < 25; i++) veel.push(fac({ id: 's' + i, leverancier: 'la', nummer: 'S-' + i, incl: 1000 + i * 7, factuurdatum: '2026-' + String(1 + Math.floor(i / 3)).padStart(2, '0') + '-10' }));
  // s0 + s1 liggen het verst weg (januari): buiten de 20 dichtstbijzijnde → niet gevonden
  const ver = tx({ boekdatum: '2026-09-15', bedrag_centen: -(1000 + 1007), tegenpartij_iban: LEV.A });
  const t0 = Date.now();
  const k = B.matchTransactie(ver, veel, { leveranciers: LEVS });
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(!k.some((x) => x.methode === 'subset' && x.facturen.includes('s0') && x.facturen.includes('s1')));
  // dichtbij wel
  const dicht = tx({ boekdatum: '2026-09-15', bedrag_centen: -((1000 + 23 * 7) + (1000 + 24 * 7)), tegenpartij_iban: LEV.A });
  const k2 = B.matchTransactie(dicht, veel, { leveranciers: LEVS });
  assert.ok(k2.some((x) => x.methode === 'subset' && x.facturen.slice().sort().join() === 's23,s24'), JSON.stringify(k2));
});

// ═════════════════════════════ diffreview wv798 ═════════════════════════════

test('#1 nooit automatisch koppelen zonder geborgde tegenpartij: kenmerk naar vreemd IBAN, niet-nagebeld factuur-IBAN, leverancier zonder IBAN, dubbelzinnige naam', () => {
  const f = fac({ id: 'k1', leverancier: 'la', nummer: '1001', incl: 125000, iban: LEV.A, factuurdatum: '2026-10-01', vervaldatum: '2026-10-15' });
  const vreemd = tx({ boekdatum: '2026-10-10', bedrag_centen: -125000, tegenpartij_iban: LEV.VREEMD, tegenpartij_naam: 'Iemand Anders', omschrijving: 'Factuur 1001' });
  const r = controle({ transacties: [vreemd], facturen: [f] });
  assert.equal(r.koppelingen.length, 0);
  assert.equal(r.voorstellen.length, 1); assert.equal(r.voorstellen[0].tegenpartij_geborgd, false);
  // een factuur-IBAN dat nog niet is nagebeld telt niet als bekend
  const fn = fac({ id: 'k2', leverancier: 'la', nummer: 'A-200', incl: 7000, iban: LEV.VREEMD, iban_nieuw: 1, status: 'te_beoordelen', betaalspoor: null, factuurdatum: '2026-10-01' });
  assert.equal(controle({ transacties: [tx({ boekdatum: '2026-10-05', bedrag_centen: -7000, tegenpartij_iban: LEV.VREEMD })], facturen: [fn] }).koppelingen.length, 0);
  // leverancier zonder bekende IBAN's: alles is voorstel
  const fd = fac({ id: 'k3', leverancier: 'ld', nummer: 'D-1', incl: 5000, iban: LEV.VREEMD, factuurdatum: '2026-10-01' });
  const rd = controle({ transacties: [tx({ boekdatum: '2026-10-05', bedrag_centen: -5000, tegenpartij_iban: LEV.VREEMD, tegenpartij_naam: 'Leverancier D Inc.', omschrijving: 'D-1' })], facturen: [fd] });
  assert.equal(rd.koppelingen.length, 0); assert.equal(rd.voorstellen.length, 1);
  // naam die op twee leveranciers past → geen leverancier
  const lijst = [{ id: 'm1', naam: 'Medi Zorg', ibans: [] }, { id: 'm2', naam: 'Medi Zorg Groep B.V.', ibans: [] }, { id: 'm3', naam: 'Zorg Groep Medi', ibans: [] }];
  assert.equal(B.leverancierBijTx(tx({ tegenpartij_naam: 'MEDI ZORG GROEP BV' }), { leveranciers: lijst }).leverancier.id, 'm2');   // exact wint
  assert.equal(B.leverancierBijTx(tx({ tegenpartij_naam: 'MEDI ZORG GROEP NOORD' }), { leveranciers: lijst }), null);   // twee deel-treffers
  // factuurnummer van een ándere leverancier is geen dubbele betaling
  const betaaldA = fac({ id: 'k4', leverancier: 'la', nummer: '1002', incl: 3000, factuurdatum: '2026-09-01' });
  const eerst = tx({ boekdatum: '2026-09-05', bedrag_centen: -3000, tegenpartij_iban: LEV.A });
  const ander = tx({ boekdatum: '2026-09-20', bedrag_centen: -3000, tegenpartij_iban: LEV.F, omschrijving: 'Factuur 1002' });
  assert.deepEqual(soorten(controle({ transacties: [eerst, ander], facturen: [betaaldA] })), ['geen_factuur']);
});

test('#2 incasso binnen de tolerantie telt als voldaan: een tweede (handmatige) betaling is dubbel betaald, geen tweede koppeling', () => {
  const f = fac({ id: 'q1', leverancier: 'lc', nummer: 'C-40', incl: 10000, betaalwijze: 'incasso', betaalspoor: 'incasso_verwacht', factuurdatum: '2026-09-20', vervaldatum: '2026-10-01' });
  const inc = tx({ boekdatum: '2026-10-01', bedrag_centen: -9950, is_incasso: true, incassant_id: 'NL00ZZZTEST0000000301', tegenpartij_iban: LEV.C });
  const hand = tx({ boekdatum: '2026-10-03', bedrag_centen: -10000, tegenpartij_iban: LEV.C, omschrijving: 'C-40' });
  const r = controle({ transacties: [inc, hand], facturen: [f] });
  assert.deepEqual(r.koppelingen.map((k) => [k.transactie, k.methode]), [[inc.id, 'incasso']]);
  assert.deepEqual(soorten(r), ['dubbel_betaald']);
});

test('#3 twee open facturen met hetzelfde bedrag op hetzelfde IBAN → voorstel met alternatief, geen gok', () => {
  const fx = [fac({ id: 'ab9', leverancier: 'la', nummer: 'AB-09', incl: 5000, factuurdatum: '2026-09-01', vervaldatum: '2026-09-15' }),
    fac({ id: 'ab10', leverancier: 'la', nummer: 'AB-10', incl: 5000, factuurdatum: '2026-10-01', vervaldatum: '2026-10-15' })];
  const r = controle({ transacties: [tx({ boekdatum: '2026-10-01', bedrag_centen: -5000, tegenpartij_iban: LEV.A })], facturen: fx });
  assert.equal(r.koppelingen.length, 0);
  assert.equal(r.voorstellen.length, 1);
  assert.equal(r.voorstellen[0].alternatieven.length, 1);
  assert.deepEqual(r.signalen, []);   // geen "te betalen, niet betaald" naast het voorstel: een mens kiest welke factuur betaald is
});

test('#4 subset-som bij veel open facturen alleen automatisch als de omschrijving er één noemt', () => {
  const veel = [];
  for (let i = 0; i < 12; i++) veel.push(fac({ id: 'z' + i, leverancier: 'la', nummer: 'Z-' + (100 + i), incl: 2000 + i * i * 53 + i * 7, factuurdatum: '2026-09-' + String(10 + i) }));
  const doel = -(veel[3].incl + veel[7].incl);
  const kaal = controle({ transacties: [tx({ boekdatum: '2026-10-01', bedrag_centen: doel, tegenpartij_iban: LEV.A })], facturen: veel });
  assert.equal(kaal.koppelingen.length, 0); assert.equal(kaal.voorstellen[0].methode, 'subset');
  const genoemd = controle({ transacties: [tx({ boekdatum: '2026-10-01', bedrag_centen: doel, tegenpartij_iban: LEV.A, omschrijving: 'Z-103 en meer' })], facturen: veel });
  assert.deepEqual(genoemd.koppelingen.map((k) => k.factuur).sort(), ['z3', 'z7']);
});

test('#5/#11 rekening zonder geldige controle en een TAB-rekeningnummer met spatie → geweigerd met uitleg, nooit stil weg of een exceptie', () => {
  const tab = tabRij('0000000011', '20261001', '1,00', '0,00', '-1,00', 'BEA, Betaalpas x');
  const r = B.leesBankbestand(tab, { rekeningen: [{ iban: ABN_TG, entiteit: 'tolgaarde', bank_formaat: 'abn_tab', controle: null }] });
  assert.equal(r.ok, false); assert.equal(r.fout, 'rekening_onvolledig');
  assert.equal(B.leesBankbestand(tab, { rekeningen: [{ iban: ABN_TG, entiteit: 'tolgaarde', bank_formaat: 'abn_tab', controle: '1' }] }).ok, true);
  const spatie = B.leesBankbestand('123456789 \tEUR\t20261001\t1,00\t0,00\t20261001\t-1,00\tBEA, Betaalpas x', { rekeningen: REKENINGEN });
  assert.equal(spatie.ok, false); assert.equal(spatie.fout, 'regel_ongeldig'); assert.ok(!spatie.uitleg.includes('123456789'));
});

test('#6 incassotolerantie NULL = de standaard 5 %', () => {
  const lev = [{ id: 'lt', naam: 'Leverancier T B.V.', ibans: [LEV.C], incassant_ids: ['NL00ZZZTEST0000000999'], incasso_tolerantie_pct: null }];
  const f = fac({ id: 'tt', leverancier: 'lt', nummer: 'T-1', incl: 10000, factuurdatum: '2026-10-01' });
  const k = B.matchTransactie(tx({ boekdatum: '2026-10-05', bedrag_centen: -10300, is_incasso: true, incassant_id: 'NL00ZZZTEST0000000999', tegenpartij_iban: LEV.C }), [f], { leveranciers: lev });
  assert.ok(k.some((x) => x.methode === 'incasso'));
});

test('#7 een tweede mislukte verzending (nieuwe opdracht) geeft een nieuw signaal', () => {
  const f = fac({ id: 'vm', leverancier: 'la', nummer: 'A-80', incl: 1000, status: 'verzending_mislukt' });
  const r1 = controle({ transacties: [], facturen: [f], opdrachten: [{ id: 'op1', factuur: 'vm', entiteit: 'tolgaarde', status: 'geweigerd', poging: 1 }] });
  const af = B.afhandelSignaal(r1.signalen[0], 'opnieuw_proberen', { wie: 'eigenaar', nu: '2026-10-22T10:00:00Z' }).signaal;
  const r2 = controle({ transacties: [], facturen: [f], bestaandeSignalen: [af], opdrachten: [{ id: 'op1', factuur: 'vm', entiteit: 'tolgaarde', status: 'geweigerd', poging: 1 }, { id: 'op2', factuur: 'vm', entiteit: 'tolgaarde', status: 'mislukt', poging: 3 }] });
  assert.equal(r2.signalen.length, 1); assert.equal(r2.signalen[0].details.opdracht, 'op2');
});

test('#9 alleen_eigenaar ook op uitzonderingen en op koppelingen/voorstellen met een eigenaar-factuur (patiëntkenmerk)', () => {
  const loon = tx({ boekdatum: '2026-09-25', eigen_iban: ABN_POT, entiteit: 'pot', alleen_eigenaar: true, bedrag_centen: -300000, transactietype: 'BANKLUIS:SEPA Batch Salaris' });
  assert.equal(controle({ transacties: [loon], facturen: [] }).uitzonderingen[0].alleen_eigenaar, true);
  const f = fac({ id: 'pk', leverancier: 'la', nummer: 'A-90', incl: 4000, patientkenmerk: 'bsn', factuurdatum: '2026-10-01' });
  const r = controle({ transacties: [tx({ boekdatum: '2026-10-05', bedrag_centen: -4000, tegenpartij_iban: LEV.A })], facturen: [f] });
  assert.equal(r.koppelingen[0].alleen_eigenaar, true);
});

test('#10 MT940 met een lange reeks spaties: lineair (geen ReDoS)', () => {
  const t0 = Date.now();
  B.leesBankbestand(':20:X\n:25:' + MT_IBAN + '\n:60F:C261230EUR1,00\n:61:' + ' '.repeat(400000) + 'x\n:62F:C261231EUR1,00\n-', { rekeningen: REKENINGEN });
  assert.ok(Date.now() - t0 < 1500, 'te traag: ' + (Date.now() - t0) + ' ms');
});

test('#13 een uitzondering op naam zet het fraudesignaal niet uit', () => {
  const uitz = [{ id: 'u', richting: 'af', tegenpartij: 'Leverancier C', categorie: 'abonnement_zonder_factuur' }];
  const t = tx({ boekdatum: '2026-10-10', bedrag_centen: -6000, is_incasso: true, incassant_id: 'NL00ZZZTEST0000000301', tegenpartij_iban: LEV.VREEMD, tegenpartij_naam: 'Leverancier C B.V.' });
  const r = controle({ transacties: [t], facturen: [], uitzonderingen: uitz });
  assert.deepEqual(soorten(r), ['onbekend_iban']);
  assert.equal(r.uitzonderingen.length, 1);
});
