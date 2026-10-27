'use strict';
// Toetsen voor facturen-bank.js (wv798, Facturen-app F1b). Alles synthetisch: IBAN's met bankcode TEST of lage ABN-nummers, "Leverancier
// A B.V.", verzonnen bedragen. Oracle voor ING-CSV en ABN-TAB: test/referentie/fv2-bankparser.js (FV2, bewezen op 6.963 echte regels),
// alleen het pure deel, in een vm. MT940 en ING-komma hebben geen oracle: daar rekent Python de entry_ref onafhankelijk na (str(float)).
// Raakt geen pod, kluis, bank, mail of vault. Draaien: bash test/facturen-bank.sh
const { test } = require('node:test');
const assert = require('node:assert/strict');
// Prestatiegrenzen gelden voor de pod; een CI-runner is trager en wisselt (wv1044: 3115–3882 ms tegen een grens van 3 s in de
// runs 239–253). build.yml zet TOETS_TIJDFACTOR=3; lokaal blijft de grens zoals hij is. Een kwadratische uitschieter valt er nog steeds uit.
const TIJDFACTOR = Math.max(1, Number(process.env.TOETS_TIJDFACTOR) || 1);
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

// Triodos-CSV (wv1299): geen kop, komma, alles gequote, CRLF, negen kolommen, meerdere rekeningen door elkaar (elk oudste eerst).
const TRI_SEL = maakIban('NL', 'TRIO', '0000000041'), TRI_SEL_SP = maakIban('NL', 'TRIO', '0000000042'), TRI_GH = maakIban('NL', 'TRIO', '0000000043');
const TRI_REK = REKENINGEN.concat([
  { iban: TRI_SEL, entiteit: 'sel', bank_formaat: 'triodos_csv', controle: 1 },
  { iban: TRI_SEL_SP, entiteit: 'sel', bank_formaat: 'triodos_csv', controle: 1 },
  { iban: TRI_GH, entiteit: 'ghawa', bank_formaat: 'triodos_csv', controle: 1 },
]);
const triRij = (d, eigen, b, dc, naam, tegen, code, oms, saldo) => [d, eigen, b, dc, naam, tegen, code, oms, saldo].map((x) => '"' + x + '"').join(',');
const TRI_CSV = [
  triRij('23-04-2017', TRI_SEL, '20,00', 'Debet', '', '', 'KN', 'Pasbijdrage Testpas periode 2017', '-20,00'),
  triRij('01-05-2017', TRI_SEL, '1.234,56', 'Credit', 'Leverancier A B.V.', 'TESTNL2A ' + LEV.A, 'ET', 'Factuur VB-2017-0001', '1.214,56'),
  triRij('02-05-2017', TRI_GH, '100,00', 'Credit', 'Iemand', 'TESTNL2AXXX ' + LEV.B, 'ET', 'Gift', '100,00'),
  triRij('03-05-2017', TRI_SEL, '84,12', 'Debet', 'Leverancier C B.V.', 'TESTNL2A ' + LEV.C, 'EI', 'NL00ZZZTEST0000000301 2017 00001', '1.130,44'),
  triRij('04-05-2017', TRI_SEL, '30,00', 'Debet', 'Oude Partij', '12.34.56.789', 'VV', 'Verrekening', '1.100,44'),
  triRij('04-05-2017', TRI_SEL_SP, '500,00', 'Credit', 'SEL', 'TESTNL2A ' + TRI_SEL, 'ET', 'Naar spaar', '500,00'),
  triRij('05-05-2017', TRI_GH, '0,00', 'Debet', '', '', 'RE', 'Rente', '100,00'),
  triRij('05-05-2017', TRI_GH, '0,00', 'Debet', '', '', 'RE', 'Rente', '100,00'),
].join('\r\n') + '\r\n';

test('Triodos-CSV (wv1299): herkenning, teken uit Debet/Credit, tegenrekening uit "BIC IBAN", incassant bij EI; entry_ref door Python nagerekend', () => {
  assert.equal(B.herkenFormaat(TRI_CSV), 'triodos_csv');
  assert.equal(B.herkenFormaat('﻿' + TRI_CSV), 'triodos_csv');
  assert.equal(B.herkenFormaat(ING_CSV), 'ing_csv');
  const r = B.leesBankbestand(TRI_CSV, { rekeningen: TRI_REK });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.formaat, 'triodos_csv');
  assert.equal(r.transacties.length, 8);
  assert.deepEqual(r.per_rekening, { [TRI_SEL]: 4, [TRI_SEL_SP]: 1, [TRI_GH]: 3 });
  const t = r.transacties;
  assert.deepEqual(t.map((x) => x.bedrag_centen), [-2000, 123456, 10000, -8412, -3000, 50000, 0, 0]);
  assert.equal(Object.is(t[6].bedrag, -0), false);
  assert.deepEqual(t.map((x) => x.tegenpartij_iban), [null, LEV.A, LEV.B, LEV.C, '12.34.56.789', TRI_SEL, null, null]);
  assert.deepEqual(t.map((x) => x.tegenpartij_naam), [null, 'Leverancier A B.V.', 'Iemand', 'Leverancier C B.V.', 'Oude Partij', 'SEL', null, null]);
  assert.deepEqual(t.map((x) => x.transactietype), ['TRIODOS:KN', 'TRIODOS:ET', 'TRIODOS:ET', 'TRIODOS:EI', 'TRIODOS:VV', 'TRIODOS:ET', 'TRIODOS:RE', 'TRIODOS:RE']);
  assert.deepEqual(t.map((x) => x.is_incasso), [false, false, false, true, false, false, false, false]);
  assert.equal(t[3].incassant_id, 'NL00ZZZTEST0000000301');
  assert.equal(t[3].machtiging, null);
  assert.equal(t[1].omschrijving, 'Factuur VB-2017-0001');
  assert.equal(t[1].boekdatum, '2017-05-01');
  assert.equal(t[1].entiteit, 'sel'); assert.equal(t[2].entiteit, 'ghawa');
  assert.ok(t[7].entry_ref.endsWith('-1') && t[7].ref_basis === t[6].entry_ref, 'duplicaat binnen het bestand → -1');
  assert.deepEqual(r.periode, { van: '2017-04-23', tot: '2017-05-05' });
  // saldo: per rekening de keten, ook als de rekeningen door elkaar staan
  for (const iban of [TRI_SEL, TRI_SEL_SP, TRI_GH]) assert.equal(r.saldo[iban].sluit, true, iban.slice(-4) + ' ' + JSON.stringify(r.saldo[iban]));
  assert.equal(r.saldo[TRI_SEL].begin_centen, 0); assert.equal(r.saldo[TRI_SEL].eind_centen, 110044);
  if (PY) {
    const py = pyRefs([
      [TRI_SEL, '2017-04-23', -20.0, '-20,00', 'Pasbijdrage Testpas periode 2017', null],
      [TRI_SEL, '2017-05-01', 1234.56, '1.214,56', 'Factuur VB-2017-0001', LEV.A],
      [TRI_GH, '2017-05-02', 100.0, '100,00', 'Gift', LEV.B],
      [TRI_SEL, '2017-05-03', -84.12, '1.130,44', 'NL00ZZZTEST0000000301 2017 00001', LEV.C],
      [TRI_SEL, '2017-05-04', -30.0, '1.100,44', 'Verrekening', '12.34.56.789'],
      [TRI_SEL_SP, '2017-05-04', 500.0, '500,00', 'Naar spaar', TRI_SEL],
      [TRI_GH, '2017-05-05', 0.0, '100,00', 'Rente', null],
      [TRI_GH, '2017-05-05', 0.0, '100,00', 'Rente', null],
    ]);
    assert.deepEqual(t.map((x) => x.entry_ref), py);
  }
  // deterministisch: dezelfde export opnieuw (ook als bytes, LF in plaats van CRLF) geeft dezelfde sleutels
  const twee = B.leesBankbestand(Buffer.from(TRI_CSV.replace(/\r\n/g, '\n'), 'utf8'), { rekeningen: TRI_REK });
  assert.deepEqual(twee.transacties.map((x) => x.entry_ref), t.map((x) => x.entry_ref));
  // een breuk in de keten staat in de uitkomst (bestand niet geweigerd)
  const breuk = B.leesBankbestand(TRI_CSV.replace('"1.130,44"', '"1.130,45"'), { rekeningen: TRI_REK });
  assert.equal(breuk.ok, true); assert.equal(breuk.saldo[TRI_SEL].sluit, false); assert.ok(breuk.saldo[TRI_SEL].breuken >= 1);
});

test('Triodos-CSV (wv1299): weigeren — onbekende of verkeerd vastgelegde rekening, kolommen, Debet/Credit, bedrag, datum, tegenrekening; nooit een bedrag of naam in de uitleg', () => {
  const rek = (wijzig) => TRI_REK.map((x) => (x.iban === TRI_GH ? Object.assign({}, x, wijzig) : x));
  const zonderGh = TRI_REK.filter((x) => x.iban !== TRI_GH);
  const o = B.leesBankbestand(TRI_CSV, { rekeningen: zonderGh });
  assert.equal(o.ok, false); assert.equal(o.fout, 'onbekende_rekening'); assert.ok(o.uitleg.includes(TRI_GH.slice(-4)) && !o.uitleg.includes(TRI_GH));
  assert.equal(B.leesBankbestand(TRI_CSV, { rekeningen: rek({ bank_formaat: 'ing_csv' }) }).fout, 'verkeerd_formaat');
  // Privé-rekening in een Triodos-bestand: weg zonder spoor, rest ongewijzigd
  const p = B.leesBankbestand(TRI_CSV, { rekeningen: rek({ controle: 0 }) });
  assert.equal(p.ok, true); assert.equal(p.prive_weggegooid, 3); assert.equal(p.transacties.length, 5);
  assert.deepEqual(p.transacties.map((x) => x.entry_ref), B.leesBankbestand(TRI_CSV, { rekeningen: TRI_REK }).transacties.filter((x) => x.eigen_iban !== TRI_GH).map((x) => x.entry_ref));
  const eerste = TRI_CSV.split('\r\n')[0];
  const fout = (regel) => B.leesBankbestand(eerste + '\r\n' + regel + '\r\n', { rekeningen: TRI_REK });
  const goed = ['05-05-2017', TRI_SEL, '1,00', 'Credit', 'Iemand', 'TESTNL2A ' + LEV.B, 'ET', 'x', '1,00'];
  const met = (i, w) => { const v = goed.slice(); v[i] = w; return v.map((x) => '"' + x + '"').join(','); };
  assert.equal(fout(goed.map((x) => '"' + x + '"').join(',')).ok, true);
  const gevallen = [
    met(3, 'Af'), met(3, ''), met(2, '-1,00'), met(2, 'twaalf'), met(0, '2017-05-05'), met(0, '31-02-2017'), met(5, 'Iemand anders'),
    met(6, ''), met(8, 'veel'), met(1, 'GEEN-IBAN'), goed.slice(0, 8).map((x) => '"' + x + '"').join(','), goed.concat(['x']).map((x) => '"' + x + '"').join(','),
  ];
  for (const g of gevallen) {
    const u = fout(g);
    assert.equal(u.ok, false, g); assert.equal(u.fout, 'regel_ongeldig', g + ' → ' + u.fout);
    assert.ok(!/Leverancier|Iemand|\d+,\d{2}/.test(u.uitleg), u.uitleg);
  }
  // een Triodos-achtige regel zonder TRIO-rekening is geen Triodos (en ook geen ander formaat)
  assert.equal(B.herkenFormaat(met(1, LEV.A)), null);
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

test('wv1360: betaald via een betaaldienst of derdengeldenrekening → geen onbekend-IBAN-signaal; een gewone vreemde rekening wel', () => {
  const basis = { boekdatum: '2026-10-10', bedrag_centen: -6000, is_incasso: true, incassant_id: 'NL00ZZZTEST0000000301', tegenpartij_iban: LEV.VREEMD };
  const via = tx(Object.assign({}, basis, { tegenpartij_naam: 'Leverancier C B.V. via Stichting Mollie Payments' }));
  // incasso via een betaaldienst: geen signaal
  assert.ok(!soorten(controle({ transacties: [via], facturen: [] })).includes('onbekend_iban'));
  // overboeking met "via" in de (zelf getypte) naam, rekening nooit eerder als betaaldienst betaald (alleen deze post): wél een signaal
  const viaOver = tx(Object.assign({}, basis, { is_incasso: false, incassant_id: null, tegenpartij_naam: 'Leverancier C B.V. via Mollie' }));
  assert.ok(soorten(controle({ transacties: [viaOver], facturen: [], verzamelTel: { [LEV.VREEMD]: 1 } })).includes('onbekend_iban'));
  // rekening al eerder als betaaldienst betaald: geen signaal
  assert.ok(!soorten(controle({ transacties: [viaOver], facturen: [], verzamelTel: { [LEV.VREEMD]: 3 } })).includes('onbekend_iban'));
  const gewoon = tx(Object.assign({}, basis, { tegenpartij_naam: 'Leverancier C B.V.' }));
  assert.ok(!soorten(controle({ transacties: [gewoon], facturen: [], verzamelTel: { [LEV.VREEMD]: 2 } })).includes('onbekend_iban'));
  assert.ok(soorten(controle({ transacties: [gewoon], facturen: [], verzamelTel: { NL02ABNA0123456789: 5 } })).includes('onbekend_iban'));
});

test('wv1360: rekening uit de bankhistorie met een andere naam op de post → niet die leverancier; bekende naam elders → onbekend-IBAN-signaal', () => {
  const levs = LEVS.concat([{ id: 'mw', naam: 'Proef Medewerker', namen: ['P. Medewerker'], ibans: ['NL02ABNA0123456789'], ibans_naamtoets: ['NL02ABNA0123456789'], incassant_ids: [] }]);
  const naarMw = tx({ boekdatum: '2026-10-10', bedrag_centen: -6000, tegenpartij_iban: 'NL02ABNA0123456789', tegenpartij_naam: 'Leverancier C B.V.' });
  assert.equal(B.leverancierBijTx(naarMw, { leveranciers: levs }).leverancier.id, 'lc');
  assert.ok(soorten(controle({ transacties: [naarMw], facturen: [], leveranciers: levs })).includes('onbekend_iban'));
  const salaris = tx({ boekdatum: '2026-10-10', bedrag_centen: -6000, tegenpartij_iban: 'NL02ABNA0123456789', tegenpartij_naam: 'P. Medewerker' });
  assert.equal(B.leverancierBijTx(salaris, { leveranciers: levs }).via, 'iban');
  assert.ok(!soorten(controle({ transacties: [salaris], facturen: [], leveranciers: levs })).includes('onbekend_iban'));
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
    teruggeboekt: ['opnieuw_betalen', 'leverancier_incasseert'],
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
  assert.ok(Date.now() - t0 < 2000 * TIJDFACTOR, 'te traag: ' + (Date.now() - t0) + ' ms');
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
  assert.ok(Date.now() - t0 < 1500 * TIJDFACTOR, 'te traag: ' + (Date.now() - t0) + ' ms');
});

test('#13 een uitzondering op naam zet het fraudesignaal niet uit', () => {
  const uitz = [{ id: 'u', richting: 'af', tegenpartij: 'Leverancier C', categorie: 'abonnement_zonder_factuur' }];
  const t = tx({ boekdatum: '2026-10-10', bedrag_centen: -6000, is_incasso: true, incassant_id: 'NL00ZZZTEST0000000301', tegenpartij_iban: LEV.VREEMD, tegenpartij_naam: 'Leverancier C B.V.' });
  const r = controle({ transacties: [t], facturen: [], uitzonderingen: uitz });
  assert.deepEqual(soorten(r), ['onbekend_iban']);
  assert.equal(r.uitzonderingen.length, 1);
});

// ═════════════════════════════ natoets wv798 ═════════════════════════════

test('natoets #1: zelf betaald + incasso binnen de tolerantie = dubbel betaald, in beide volgordes', () => {
  const f = () => fac({ id: 'n1', leverancier: 'lc', nummer: 'C-50', incl: 10000, factuurdatum: '2026-09-20', vervaldatum: '2026-10-01' });
  const zelf = tx({ boekdatum: '2026-10-01', bedrag_centen: -10000, tegenpartij_iban: LEV.C });
  const inc = tx({ boekdatum: '2026-10-03', bedrag_centen: -9800, is_incasso: true, incassant_id: 'NL00ZZZTEST0000000301', tegenpartij_iban: LEV.C });
  const A = controle({ transacties: [zelf, inc], facturen: [f()] });
  assert.deepEqual(A.koppelingen.map((k) => k.transactie), [zelf.id]); assert.deepEqual(soorten(A), ['dubbel_betaald']); assert.deepEqual(A.voorstellen, []);
  const inc2 = tx({ boekdatum: '2026-09-30', bedrag_centen: -9800, is_incasso: true, incassant_id: 'NL00ZZZTEST0000000301', tegenpartij_iban: LEV.C });
  const B2 = controle({ transacties: [inc2, zelf], facturen: [f()] });
  assert.deepEqual(B2.koppelingen.map((k) => k.transactie), [zelf.id]); assert.deepEqual(soorten(B2), ['dubbel_betaald']); assert.deepEqual(B2.voorstellen, []);
});

test('natoets #2/#4: incasso met twee gelijke open facturen → voorstel met alternatief; eigenaar-vlag ook via een alternatief', () => {
  const lev = LEVS.concat([{ id: 'li', naam: 'Leverancier I B.V.', ibans: [], incassant_ids: ['NL00ZZZTEST0000000909'] }]);
  const fx = [fac({ id: 'i9', leverancier: 'li', nummer: 'I-9', incl: 3000, betaalwijze: 'incasso', betaalspoor: 'incasso_verwacht', factuurdatum: '2026-09-01', vervaldatum: '2026-09-10' }),
    fac({ id: 'i10', leverancier: 'li', nummer: 'I-10', incl: 3000, betaalwijze: 'incasso', betaalspoor: 'incasso_verwacht', factuurdatum: '2026-09-25', vervaldatum: '2026-10-05', patientkenmerk: 'bsn' })];
  const t = tx({ boekdatum: '2026-09-28', bedrag_centen: -3000, is_incasso: true, incassant_id: 'NL00ZZZTEST0000000909' });
  const r = controle({ leveranciers: lev, transacties: [t], facturen: fx });
  assert.equal(r.koppelingen.length, 0);
  assert.equal(r.voorstellen.length, 1);
  assert.equal(r.voorstellen[0].alternatieven.length, 1);
  assert.equal(r.voorstellen[0].alleen_eigenaar, true);
  assert.deepEqual(r.signalen, []);
});

test('natoets #3: een met de hand gekoppelde eerste termijn maakt de factuur niet voldaan; "volledig" wel', () => {
  const f = fac({ id: 'tm', leverancier: 'la', nummer: 'A-300', incl: 10000, factuurdatum: '2026-09-01', vervaldatum: '2026-09-30' });
  const t1 = tx({ boekdatum: '2026-09-10', bedrag_centen: -5000, tegenpartij_iban: LEV.A });
  const t2 = tx({ boekdatum: '2026-10-10', bedrag_centen: -5000, tegenpartij_iban: LEV.A, omschrijving: 'A-300 termijn 2' });
  const r = controle({ transacties: [t1, t2], facturen: [f], koppelingen: [{ transactie: t1.id, factuur: 'tm', bron: 'mens' }] });
  assert.equal(r.voorstellen.length, 1); assert.deepEqual(r.voorstellen[0].facturen, ['tm']); assert.deepEqual(r.signalen, []);
  const v = controle({ transacties: [t1, t2], facturen: [f], koppelingen: [{ transactie: t1.id, factuur: 'tm', bron: 'mens', volledig: true }] });
  assert.equal(v.voorstellen.length, 0);
});

test('natoets #5: twaalf vooruit ingevoerde huurfacturen van gelijk bedrag → de maandbetaling koppelt automatisch', () => {
  const huur = [];
  for (let m = 1; m <= 12; m++) huur.push(fac({ id: 'h' + m, leverancier: 'la', nummer: 'H-' + m, incl: 250000, factuurdatum: '2026-01-01', vervaldatum: '2026-' + String(m).padStart(2, '0') + '-01' }));
  const r = controle({ transacties: [tx({ boekdatum: '2026-10-01', bedrag_centen: -250000, tegenpartij_iban: LEV.A })], facturen: huur.slice(9) });
  assert.deepEqual(r.koppelingen.map((k) => k.factuur), ['h10']);
});

test('natoets #6/#7: bestand 10 is jonger dan bestand 9; de weg te halen post krijgt geen eigen "geen factuur" ernaast', () => {
  const a = tx({ id: 'oud', boekdatum: '2026-10-01', bedrag_centen: -4500, tegenpartij_iban: LEV.F, bestand: '9', entry_ref: 'r9' });
  const b = tx({ id: 'nieuw', boekdatum: '2026-10-01', bedrag_centen: -4500, tegenpartij_iban: LEV.F, bestand: '10', entry_ref: 'r10' });
  const r = controle({ transacties: [a, b], facturen: [] });
  const s = r.signalen.find((x) => x.soort === 'mogelijk_dubbel_geupload');
  assert.equal(s.details.te_verwijderen, 'nieuw');
  assert.deepEqual(r.signalen.filter((x) => x.soort === 'geen_factuur').map((x) => x.transacties[0]), ['oud']);
});

// ═════════════════════════════ wv1317: koppelvoorstellen kloppen en zeggen wat David akkordeert ═════════════════════════════

test('wv1317 huurpatroon: betalingen van september en oktober (elk met een eigen factuurnummer) horen niet bij de huurfactuur van november', () => {
  const nov = () => fac({ id: 'hnov', leverancier: null, nummer: '3.2026.00982', incl: 852221, iban: LEV.VREEMD, factuurdatum: '2026-11-01', vervaldatum: '2026-11-01', status: 'te_beoordelen', betaalspoor: null });
  const sep = tx({ boekdatum: '2026-08-27', bedrag_centen: -852221, tegenpartij_iban: LEV.VREEMD, tegenpartij_naam: 'Verhuurder Proef', omschrijving: 'Factuurnummer 3.2026.00689', kenmerk: 'NOTPROVIDED' });
  const okt = tx({ boekdatum: '2026-10-01', bedrag_centen: -852221, tegenpartij_iban: LEV.VREEMD, tegenpartij_naam: 'Verhuurder Proef', omschrijving: 'Factuurnummer 3.2026.00819', kenmerk: 'NOTPROVIDED' });
  const r = controle({ transacties: [sep, okt], facturen: [nov()] });
  assert.deepEqual(r.voorstellen, []); assert.deepEqual(r.koppelingen, []);
  assert.deepEqual(soorten(r), ['geen_factuur', 'geen_factuur']);
  // ook zonder omschrijving: 31 dagen vóór de factuurdatum is geen betaling van die factuur
  const kaal = tx({ boekdatum: '2026-10-01', bedrag_centen: -852221, tegenpartij_iban: LEV.VREEMD });
  assert.equal(B.matchTransactie(kaal, [nov()], { leveranciers: LEVS }).length, 0);
  // binnen de marge (4 dagen vóór) wel, als voorstel (leverancier onbekend = niet geborgd)
  const op = tx({ boekdatum: '2026-10-28', bedrag_centen: -852221, tegenpartij_iban: LEV.VREEMD });
  const r2 = controle({ vandaag: '2026-11-10', transacties: [op], facturen: [nov()] });
  assert.deepEqual(r2.voorstellen.map((v) => [v.transactie, v.facturen[0], v.methode]), [[op.id, 'hnov', 'iban_bedrag']]);
  // vooruitbetaling mét het nummer in de omschrijving blijft gewoon gevonden
  const vooruit = tx({ boekdatum: '2026-09-20', bedrag_centen: -852221, tegenpartij_iban: LEV.VREEMD, omschrijving: 'Factuurnummer 3.2026.00982 vooruit' });
  assert.equal(B.matchTransactie(vooruit, [nov()], { leveranciers: LEVS })[0].methode, 'kenmerk');
  assert.equal(B.VOORUIT_MARGE, 7);
});

test('wv1317 ander factuurnummer genoemd (ook door de bank geknipt, of een los nummer uit dezelfde reeks) → geen IBAN+bedrag-kandidaat', () => {
  const f = { nummer: '3.2026.00982' };
  assert.equal(B.andereFactuurGenoemd({ omschrijving: 'Factuurnummer 3.2026.00819' }, f), true);
  assert.equal(B.andereFactuurGenoemd({ omschrijving: 'Factuurnummer : 3.2026.00308' }, f), true);
  assert.equal(B.andereFactuurGenoemd({ omschrijving: '3.2026.00192' }, f), true);
  assert.equal(B.andereFactuurGenoemd({ omschrijving: 'Factuurnummer 3.2026.00982' }, f), false);
  assert.equal(B.andereFactuurGenoemd({ omschrijving: 'Factuurnummer 53. 73.00303' }, { nummer: '53.73.00303' }), false);
  assert.equal(B.andereFactuurGenoemd({ omschrijving: 'Factuurnummer 53. 73.00303' }, { nummer: '53.73.00573' }), true);
  assert.equal(B.andereFactuurGenoemd({ omschrijving: 'factuur van september' }, f), false);
  assert.equal(B.andereFactuurGenoemd({ omschrijving: 'huur kantoor' }, f), false);
  assert.equal(B.andereFactuurGenoemd({ omschrijving: 'Factuur 9999' }, { nummer: '12' }), false);   // te kort nummer: geen oordeel
  const fa = fac({ id: 'an', leverancier: null, nummer: 'R-2026-0412', incl: 5000, iban: LEV.VREEMD, factuurdatum: '2026-10-01', vervaldatum: '2026-10-15', status: 'te_beoordelen', betaalspoor: null });
  assert.equal(B.matchTransactie(tx({ boekdatum: '2026-10-05', bedrag_centen: -5000, tegenpartij_iban: LEV.VREEMD, omschrijving: 'Invoice R-2026-0399' }), [fa], {}).length, 0);
  assert.equal(B.matchTransactie(tx({ boekdatum: '2026-10-05', bedrag_centen: -5000, tegenpartij_iban: LEV.VREEMD, omschrijving: 'betaling' }), [fa], {})[0].methode, 'iban_bedrag');
});

test('wv1317 één open voorstel per factuur: de dichtstbijzijnde betaling krijgt hem; maandreeks koppelt per periode, zonder valse alternatieven', () => {
  const e = fac({ id: 'e1', leverancier: null, nummer: 'E-1', incl: 5000, iban: LEV.VREEMD, factuurdatum: '2026-09-01', vervaldatum: '2026-09-15', status: 'te_beoordelen', betaalspoor: null });
  const t1 = tx({ boekdatum: '2026-09-14', bedrag_centen: -5000, tegenpartij_iban: LEV.VREEMD });
  const t2 = tx({ boekdatum: '2026-10-10', bedrag_centen: -5000, tegenpartij_iban: LEV.VREEMD });
  const r = controle({ transacties: [t2, t1], facturen: [e] });
  assert.deepEqual(r.voorstellen.map((v) => [v.transactie, v.facturen[0]]), [[t1.id, 'e1']]);
  // de verliezer: geen voorstel en (nog) geen "geen factuur" zolang de factuur bij t1 voorgesteld staat (diffreview ZOU 4)
  assert.deepEqual(r.signalen.filter((s) => s.soort === 'geen_factuur'), []);
  // David wijst t1 → e1 af: dan krijgt t2 het voorstel
  const na = controle({ transacties: [t2, t1], facturen: [e], afgewezenVoorstellen: [r.voorstellen[0].sleutel] });
  assert.deepEqual(na.voorstellen.map((v) => [v.transactie, v.facturen[0]]), [[t2.id, 'e1']]);
  assert.deepEqual(na.signalen.filter((s) => s.soort === 'geen_factuur').map((s) => s.transacties[0]), [t1.id]);
  // David bevestigt t1 → e1: dan krijgt t2 alsnog "geen factuur"
  const bev = controle({ transacties: [t2, t1], facturen: [e], koppelingen: [{ transactie: t1.id, factuur: 'e1', bron: 'mens', volledig: true }] });
  assert.deepEqual(bev.voorstellen, []);
  assert.deepEqual(bev.signalen.filter((s) => s.soort === 'geen_factuur').map((s) => s.transacties[0]), [t2.id]);
  // binnen de periode (tussen factuur- en vervaldatum) wint van net na de vervaldatum
  const tIn = tx({ boekdatum: '2026-09-05', bedrag_centen: -5000, tegenpartij_iban: LEV.VREEMD });
  const tNa = tx({ boekdatum: '2026-09-16', bedrag_centen: -5000, tegenpartij_iban: LEV.VREEMD });
  assert.deepEqual(controle({ transacties: [tNa, tIn], facturen: [e] }).voorstellen.map((v) => v.transactie), [tIn.id]);
  // maandreeks: september en oktober, zelfde bedrag
  const sep = fac({ id: 'ms', leverancier: null, nummer: 'M-09', incl: 7000, iban: LEV.VREEMD, factuurdatum: '2026-09-01', vervaldatum: '2026-09-15', status: 'te_beoordelen', betaalspoor: null });
  const okt = fac({ id: 'mo', leverancier: null, nummer: 'M-10', incl: 7000, iban: LEV.VREEMD, factuurdatum: '2026-10-01', vervaldatum: '2026-10-15', status: 'te_beoordelen', betaalspoor: null });
  const ps = tx({ boekdatum: '2026-09-03', bedrag_centen: -7000, tegenpartij_iban: LEV.VREEMD });
  const po = tx({ boekdatum: '2026-10-03', bedrag_centen: -7000, tegenpartij_iban: LEV.VREEMD });
  const m = controle({ transacties: [ps, po], facturen: [sep, okt] });
  assert.deepEqual(m.voorstellen.map((v) => [v.transactie, v.facturen[0]]).sort(), [[ps.id, 'ms'], [po.id, 'mo']].sort());
  assert.ok(m.voorstellen.every((v) => !v.alternatieven || !v.alternatieven.length), 'een al voorgestelde factuur is geen alternatief meer');
  const fs = new Set(); for (const v of m.voorstellen) for (const f of v.facturen) { assert.ok(!fs.has(f), 'factuur twee keer voorgesteld'); fs.add(f); }
});

test('wv1317 uitleg: één zin met datum, bedrag, tegenpartij, rekening en factuur; waarom en zekerheid in woorden; nooit een "?"', () => {
  const t = { boekdatum: '2026-10-28', bedrag_centen: -852221, tegenpartij_naam: 'Verhuurder Proef', tegenpartij_iban: LEV.VREEMD };
  const u = B.voorstelUitleg({ methode: 'iban_bedrag', zekerheid: 0.95, tegenpartij_geborgd: false }, t,
    [{ nummer: '3.2026.00982', factuurdatum: '2026-11-01', incl: 852221, iban: LEV.VREEMD, leverancier_naam: null }], [],
    { aantal: 11, laag_centen: 825996, hoog_centen: 852221, frequentie: 'maand', oordeel: 'binnen' });
  assert.equal(u.zin, 'Afschrijving van 28-10-2026 van € 8.522,21 aan Verhuurder Proef (rekening …' + LEV.VREEMD.slice(-4) + ') = betaling van factuur 3.2026.00982 ' +
    '(leverancier nog niet bekend, factuurdatum 1-11-2026, € 8.522,21).');
  assert.deepEqual(u.waarom, ['zelfde rekeningnummer als op de factuur en precies hetzelfde bedrag', 'betaald 4 dagen vóór de factuurdatum',
    'gebruikelijk aan deze rekening: € 8.259,96 – € 8.522,21 per maand (11 betalingen in 12 maanden)']);
  assert.equal(u.zekerheid_tekst, 'vrijwel zeker');
  assert.ok(u.let_op.some((x) => /leverancier van deze factuur is nog niet bekend/.test(x)));
  assert.ok(!/\?/.test(JSON.stringify(u)));
  const g = B.voorstelUitleg({ methode: 'iban_bedrag', zekerheid: 0.6, tegenpartij_geborgd: true }, t,
    [{ nummer: 'A-2', factuurdatum: '2026-10-01', incl: 852221, iban: LEV.VREEMD, leverancier_naam: 'Verhuurder Proef B.V.' }], [{ nummer: 'A-1' }],
    { aantal: 5, laag_centen: 100000, hoog_centen: 120000, frequentie: 'onregelmatig', oordeel: 'boven' });
  assert.match(g.zin, /van Verhuurder Proef B\.V\./);
  assert.ok(g.let_op.some((x) => /A-1/.test(x) && /bij A-2/.test(x)));
  assert.ok(g.let_op.some((x) => /boven het gebruikelijke/.test(x)));
  assert.equal(g.zekerheid_tekst, 'mogelijk: kijk even na');
  const c = B.voorstelUitleg({ methode: 'subset', zekerheid: 0.88, tegenpartij_geborgd: true, creditnota: true }, Object.assign({}, t, { bedrag_centen: -40000 }),
    [{ nummer: 'B-10', factuurdatum: '2026-10-01', incl: 50000, leverancier_naam: 'L' }, { nummer: 'CN-3', soort: 'creditnota', factuurdatum: '2026-10-05', incl: -10000, leverancier_naam: 'L' }], [], null);
  assert.match(c.zin, /betaling van 2 stukken samen: factuur B-10 .*; creditnota CN-3 .*€ 100,00\)/);
  assert.match(c.waarom[0], /creditnota is verrekend/);
  // diffreview MOET 2: de uitleg rekent zelf, ook zonder details (oud voorstel): kenmerk met ander bedrag, incasso met verschil, geen IBAN
  const k = B.voorstelUitleg({ methode: 'kenmerk', zekerheid: 0.6, tegenpartij_geborgd: true }, Object.assign({}, t, { bedrag_centen: -10000 }),
    [{ nummer: 'K-1', factuurdatum: '2026-10-01', incl: 12000, leverancier_naam: 'L' }], [], null);
  assert.match(k.waarom[0], /factuurnummer staat in de omschrijving van de betaling; bedrag € 20,00 lager dan de factuur/);
  assert.ok(!/klopt precies/.test(k.waarom.join(' ')));
  const inc = B.voorstelUitleg({ methode: 'incasso', zekerheid: 0.85, tegenpartij_geborgd: false }, { boekdatum: '2026-10-15', bedrag_centen: -9200, tegenpartij_naam: 'L' },
    [{ nummer: 'C-10', factuurdatum: '2026-10-01', incl: 9105, leverancier_naam: 'L B.V.' }], [], null);
  assert.match(inc.waarom[0], /incasso van deze leverancier, bedrag € 0,95 hoger dan de factuur \(binnen de marge\)/);
  assert.ok(inc.let_op.some((x) => /deze tegenpartij is nog niet als incassant van L B\.V\. bevestigd/.test(x)), JSON.stringify(inc.let_op));
});

test('wv1317 wat we leerden: gegroepeerd in gewone taal, geen interne codes', () => {
  const h = B.leerRegel({ soort: 'geen_factuur', titel: 'Afschrijving zonder factuur', afhandeling: 'historie_voor_start', les: null, aantal: 257 });
  assert.equal(h, '257 afschrijvingen van vóór de start van de App zonder factuur: genegeerd (oude historie).');
  assert.equal(B.leerRegel({ soort: 'geen_factuur', afhandeling: 'factuur_uploaden', les: 'Les X.', aantal: 1 }), 'Les X.');
  assert.equal(B.leerRegel({ soort: 'geen_factuur', afhandeling: 'factuur_uploaden', les: 'Les X.', aantal: 3 }), 'Les X. (3×)');
  assert.equal(B.leerRegel({ soort: 'dubbel_betaald', titel: 'Dubbel betaald', afhandeling: 'geen_dubbel', les: null, aantal: 2 }), 'Dubbel betaald: "Geen dubbel" (2×).');
  assert.equal(B.leerRegel({ soort: 'x', titel: 'Iets', afhandeling: 'interne_code_123', les: null, aantal: 1 }), 'Iets: afgehandeld.');
  assert.equal(B.vervalRegel('vooruit', 2), '2 koppelvoorstellen vervielen: de betaling lag ruim vóór de factuurdatum.');
  assert.equal(B.vervalRegel('onzin', 1), '1 koppelvoorstel verviel: bij herbeoordeling past de betaling niet meer bij de factuur.');
  for (const r of [h, B.vervalRegel('ander_nummer', 1)]) assert.ok(!/_/.test(r), r);
});

test('wv1323: feitUitleg — zin, bron met entiteiten en andere spellingen, aanleiding bij één of meer facturen, nooit het hele IBAN', () => {
  const k = { iban: 'NL91TEST0000001234', naam: 'Proef B.V.', bank_naam: 'Proef BV', namen: [{ naam: 'Proef BV', aantal: 20 }, { naam: 'Proef', aantal: 4 }], aantal: 24,
    eerste: '2025-02-20', laatste: '2026-10-03', entiteiten: ['Tolgaarde', 'Groenhouten', 'Holding'], facturen: [{ nummer: 'F-1', leverancier_naam: 'Proef B.V.', incl: 123456 }] };
  const u = B.feitUitleg(k);
  assert.equal(u.zin, 'Rekening …1234 is van Proef B.V..');
  assert.equal(u.bron, '24 betalingen sinds 20-2-2025 (laatste 3-10-2026) vanaf Tolgaarde, Groenhouten en Holding, steeds aan Proef BV (ook gespeld als Proef).');
  assert.equal(u.aanleiding, 'Factuur F-1 van Proef B.V. (€ 1.234,56) noemt deze rekening; die moet nu eerst nagebeld worden.');
  assert.match(u.ja, /^Ja: Proef B\.V\. wordt een bekende leverancier/);
  const meer = B.feitUitleg(Object.assign({}, k, { leverancier_bestaat: true, entiteiten: ['Tolgaarde'], namen: [{ naam: 'Proef BV', aantal: 24 }],
    facturen: [1, 2, 3, 4].map((i) => ({ nummer: 'F-' + i, incl: 100 })) }));
  assert.equal(meer.bron, '24 betalingen sinds 20-2-2025 (laatste 3-10-2026) vanaf Tolgaarde, steeds aan Proef BV.');
  assert.match(meer.aanleiding, /^4 facturen noemen deze rekening \(F-1 \(€ 1,00\); F-2 \(€ 1,00\); F-3 \(€ 1,00\); …\)/);
  assert.match(meer.ja, /^Ja: Proef B\.V\. krijgt deze rekening erbij/);
  assert.ok(!JSON.stringify([u, meer]).includes('NL91TEST'));
});

// ───────────────────────────── terugboeking van een batchregel (wv1415) ─────────────────────────────
// Vorm gemeten 27-10 in de ABN-export (een batch van 12-8-2026): "/TRTP/SEPA Terugboeking/IBAN/…/NAME/…/RTRN/MS02/REMI/…/EREF/<EndToEndId>",
// dezelfde dag als de batchafschrijving. Alle waarden hieronder verzonnen.
test('wv1415 terugboeking: bijschrijving met de factuur-id → sepa_terug, factuur weer te betalen, signaal; verrekend (geen dubbel betaald bij een nieuwe betaling)', () => {
  const F1 = '0000000000000f01', F2 = '0000000000000f02';
  const fx = [fac({ id: F1, leverancier: 'la', nummer: 'TB-1', incl: 50000, iban: LEV.A, factuurdatum: '2026-09-20', vervaldatum: '2026-10-04', betaalspoor: 'ingevoerd' }),
    fac({ id: F2, leverancier: 'lb', nummer: 'TB-2', incl: 20000, iban: LEV.B, factuurdatum: '2026-09-20', vervaldatum: '2026-10-04', betaalspoor: 'ingevoerd' })];
  const sepa = [{ pmtinf_id: 'PROEF-BATCH-1', eigen_iban: ABN_TG, entiteit: 'tolgaarde', datum: '2026-10-02', centen: 70000,
    regels: [{ factuur: F1, centen: 50000, iban: LEV.A }, { factuur: F2, centen: 20000, iban: LEV.B }] }];
  const af = tx({ boekdatum: '2026-10-02', bedrag_centen: -70000, kenmerk: 'PROEF-BATCH-1', transactietype: 'ABN:SEPA Batch' });
  const terug = tx({ boekdatum: '2026-10-02', bedrag_centen: 50000, tegenpartij_iban: LEV.A, kenmerk: F1, omschrijving: 'TB-1', transactietype: 'ABN:SEPA Terugboeking' });
  // afschrijving en terugboeking in één upload (zoals gemeten): F2 betaald gezien, F1 blijft van ingevoerd vandaan naar te betalen
  const r = controle({ vandaag: '2026-10-05', transacties: [af, terug], facturen: fx, sepa });
  assert.deepEqual(r.koppelingen.map((k) => [k.transactie, k.factuur, k.methode]).sort(), [[af.id, F1, 'sepa_batch'], [af.id, F2, 'sepa_batch'], [terug.id, F1, 'sepa_terug']].sort());
  assert.deepEqual(r.betaalspoor.map((b) => [b.factuur, b.gebeurtenis, b.van, b.naar]).sort(), [[F1, 'teruggeboekt', 'ingevoerd', 'te_betalen'], [F2, 'bankmatch', 'ingevoerd', 'betaald_gezien']].sort());
  assert.deepEqual(soorten(r), ['teruggeboekt']);
  const s = r.signalen[0];
  assert.deepEqual([s.facturen, s.transacties, s.bedrag_centen, s.details.batch, s.details.automatisch], [[F1], [terug.id], 50000, 'PROEF-BATCH-1', true]);
  assert.deepEqual(s.knoppen, ['opnieuw_betalen', 'leverancier_incasseert']);
  // volgende ronde (koppelingen staan er, factuur op te betalen, signaal bestaat): niets nieuws, en geen "te betalen, niet betaald" zolang het signaal open is
  const kop = r.koppelingen.map((k) => ({ transactie: k.transactie, factuur: k.factuur, bron: 'auto', methode: k.methode }));
  const fx2 = [Object.assign({}, fx[0], { betaalspoor: 'te_betalen' }), Object.assign({}, fx[1], { betaalspoor: 'betaald_gezien' })];
  const r2 = controle({ vandaag: '2026-10-20', transacties: [af, terug], facturen: fx2, sepa, koppelingen: kop, bestaandeSignalen: [{ sleutel: s.sleutel, status: 'open' }] });
  assert.deepEqual([r2.koppelingen, r2.betaalspoor, r2.signalen], [[], [], []]);
  // signaal afgehandeld en nog steeds niet betaald → het gewone signaal, met een eigen sleutel (een oud afgehandeld signaal houdt het niet tegen)
  const oud = 'te_betalen_niet_betaald:|' + F1;
  const r3 = controle({ vandaag: '2026-10-20', transacties: [af, terug], facturen: fx2, sepa, koppelingen: kop,
    bestaandeSignalen: [{ sleutel: s.sleutel, status: 'afgehandeld' }, { sleutel: oud, status: 'afgehandeld' }] });
  assert.deepEqual(r3.signalen.map((x) => [x.soort, x.sleutel]), [['te_betalen_niet_betaald', oud + '|na_terug=' + terug.id]]);
  // David betaalt opnieuw (met de hand): gewoon gekoppeld en betaald gezien, geen "dubbel betaald"
  const nieuw = tx({ boekdatum: '2026-10-21', bedrag_centen: -50000, tegenpartij_iban: LEV.A, omschrijving: 'Factuur TB-1' });
  const r4 = controle({ vandaag: '2026-10-22', transacties: [af, terug, nieuw], facturen: fx2, sepa, koppelingen: kop, bestaandeSignalen: [{ sleutel: s.sleutel, status: 'afgehandeld' }] });
  assert.deepEqual(r4.koppelingen.map((k) => [k.transactie, k.factuur]), [[nieuw.id, F1]]);
  assert.deepEqual(r4.betaalspoor.map((b) => [b.factuur, b.naar]), [[F1, 'betaald_gezien']]);
  assert.deepEqual(r4.signalen, []);
});

test('wv1415 terugboeking: eerst gezien, afschrijving later → geen betaald gezien; ander bedrag of andere rekening → alleen signaal; vóór de uitvoerdatum of andere rekening → niets', () => {
  const F1 = '0000000000000f11';
  const f = fac({ id: F1, leverancier: 'la', nummer: 'TB-11', incl: 30000, iban: LEV.A, factuurdatum: '2026-09-20', vervaldatum: '2026-10-04', betaalspoor: 'ingevoerd' });
  const sepa = [{ pmtinf_id: 'PROEF-BATCH-11', eigen_iban: ABN_TG, entiteit: 'tolgaarde', datum: '2026-10-02', centen: 30000, regels: [{ factuur: F1, centen: 30000, iban: LEV.A }] }];
  // afschrift-CSV-variant: geen kenmerk, de EndToEndId los in de omschrijving
  const terug = tx({ boekdatum: '2026-10-03', bedrag_centen: 30000, omschrijving: 'Geannuleerd door opdrachtgever TB-11 ' + F1, transactietype: 'ABN:Overig' });
  const r = controle({ vandaag: '2026-10-05', transacties: [terug], facturen: [f], sepa });
  assert.deepEqual(r.koppelingen.map((k) => k.methode), ['sepa_terug']);
  assert.deepEqual(r.betaalspoor.map((b) => [b.van, b.naar]), [['ingevoerd', 'te_betalen']]);
  // de losse afschrijving (blok van één betaling: EREF = factuur-id) komt pas in de volgende upload: koppelt, maar dekt de factuur niet
  const af = tx({ boekdatum: '2026-10-02', bedrag_centen: -30000, tegenpartij_iban: LEV.A, kenmerk: F1 });
  const kop = [{ transactie: terug.id, factuur: F1, bron: 'auto', methode: 'sepa_terug' }];
  const r2 = controle({ vandaag: '2026-10-06', transacties: [af, terug], facturen: [Object.assign({}, f, { betaalspoor: 'te_betalen' })], sepa, koppelingen: kop,
    bestaandeSignalen: r.signalen.map((s) => ({ sleutel: s.sleutel, status: 'open' })) });
  assert.deepEqual(r2.koppelingen.map((k) => [k.transactie, k.methode]), [[af.id, 'sepa_e2e']]);
  assert.deepEqual([r2.betaalspoor, r2.signalen], [[], []]);
  // ander bedrag (kosten ingehouden) of een andere tegenrekening: geen koppeling of spoorwissel, wel het signaal (niet automatisch), geen voorstel ernaast
  for (const o of [{ bedrag_centen: 29500 }, { tegenpartij_iban: LEV.B }]) {
    const t = tx(Object.assign({ boekdatum: '2026-10-03', bedrag_centen: 30000, kenmerk: F1 }, o));
    const x = controle({ vandaag: '2026-10-05', transacties: [t], facturen: [f], sepa });
    assert.deepEqual([x.koppelingen, x.betaalspoor, x.voorstellen], [[], [], []], JSON.stringify(o));
    assert.deepEqual(x.signalen.map((s) => [s.soort, s.details.automatisch]), [['teruggeboekt', false]]);
  }
  // vóór de uitvoerdatum − 3 dagen, of op een andere eigen rekening: geen terugboeking van deze regel
  for (const o of [{ boekdatum: '2026-09-28' }, { eigen_iban: ING_KM, entiteit: 'kostenmaatschap' }]) {
    const t = tx(Object.assign({ boekdatum: '2026-10-03', bedrag_centen: 30000, kenmerk: F1 }, o));
    const x = controle({ vandaag: '2026-10-05', transacties: [t], facturen: [f], sepa });
    assert.ok(!x.koppelingen.some((k) => k.methode === 'sepa_terug') && !x.signalen.some((s) => s.soort === 'teruggeboekt'), JSON.stringify(o));
  }
});
