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
      return stuur(200, pagina([{ payrollRunId: RUN, number: 12, description: 'November 2026', year: 2026, periodStart: 11, periodEnd: 11, createdAt: recent, type: 'normal', locked: true },
        { payrollRunId: RUNOUD, number: 11, description: 'Oud', year: 2026, periodStart: 10, periodEnd: 10, createdAt: oud, type: 'normal', locked: true },
        { payrollRunId: RUNOPEN, number: 13, description: 'Open', year: 2026, periodStart: 11, periodEnd: 11, createdAt: recent, type: 'normal', locked: false }]));
    }
    if (u.pathname === '/api/companies/' + C1 + '/runs/' + RUN + '/sepa') { if (u.searchParams.get('year') !== '2026') return stuur(400, {}); return stuur(200, { taskId: TAAK }); }
    if (u.pathname === '/api/documents/' + TAAK) { if (M.doc202-- > 0) return stuur(202, '"Document is being processed"'); res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(M.pain); }
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
