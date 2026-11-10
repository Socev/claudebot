'use strict';
// wv2877: OVIS GHAWA rekenkern en routes op VERZONNEN cijfers (nooit de echte overdracht in deze repo; die naspeeltoets staat in mk-scripts).
// Toetst: invoer (csv → ghawa.sqlite), nog open per regel volgens de vijf regels, verrekening per activiteit, oormerken één keer,
// aansluitingen A/D/E/F, dat een gewijzigde uitgave de uitkomst verandert (kruisproef in de toets), dat routes geen donateur of
// tegenrekening teruggeven, en dat een onbekende regel of een uitgave zonder regel de invoer weigert.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../ghawa.js');

const DONOR = 'Verzonnen Gever Pietersen';
const REK = 'NL00TEST0123456789';
function schrijfCsv(map, naam, kop, rijen) {
  const v = (x) => (x === null || x === undefined ? '' : /[",\n]/.test(String(x)) ? '"' + String(x).replace(/"/g, '""') + '"' : String(x));
  fs.writeFileSync(path.join(map, naam + '.csv'), [kop.join(','), ...rijen.map((r) => r.map(v).join(','))].join('\n') + '\n');
}
function maakFixture(wijzig) {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'ghawa-'));
  const w = wijzig || {};
  schrijfCsv(map, 'Activities', ['activity_no', 'project', 'phase', 'activity', 'status', 'summary'], [
    ['1', 'Building', 'Phase 1A', 'Fence', 'Partly done', ''], ['2', 'Building', 'Phase 1A', 'Walls', 'In progress', ''],
    ['3', 'Building', 'Phase 3', 'Roof', 'Not started', ''], ['15', 'Building', 'Unbudgeted', 'Bank charges', '', ''],
    ['P1', 'Pharmacy', 'Pharmacy', 'Pharmacy building', 'Not started', '']]);
  schrijfCsv(map, 'Budget_Lines', ['line_id', 'project', 'phase', 'activity_no', 'activity', 'budget_item', 'quantity', 'unit_price_gmd', 'budget_gmd',
    'realised_gmd', 'status', 'still_open_gmd', 'forecast_gmd', 'variance_gmd', 'budget_eur_indicative', 'still_open_eur_indicative', 'still_open_rule', 'notes', 'possible_overlap', 'wg_workbook_explanation'], [
    ['1.1', 'Building', 'Phase 1A', '1', 'Fence', 'Blocks', '', '', '1000', '', 'Completed', '', '', '', '', '', 'none', '', '', ''],
    ['1.2', 'Building', 'Phase 1A', '1', 'Fence', 'Cement', '', '', '500', '', 'Partly done', '', '', '', '', '', 'budget - realised', '', '', ''],
    ['2.1', 'Building', 'Phase 1A', '2', 'Walls', 'Blocks', '', '', '2000', '', 'Completed', '', '', '', '', '', 'none', '', '', ''],
    ['2.9', 'Building', 'Phase 1A', '2', 'Walls', 'Plastering', '', '', '0', '', 'To come', '', '', '', '', '', 'activity balance', '', '', ''],
    ['3.1', 'Building', 'Phase 3', '3', 'Roof', 'Sheets', '', '', '3000', '', 'Not started', '', '', '', '', '', 'full budget', '', '', ''],
    ['3.99', 'Building', 'Phase 3', '3', 'Roof', 'Not itemised', '', '', '0', '', 'To be itemised', '', '', '', '', '', w.regel || 'offset', '', '', ''],
    ['15.1', 'Building', 'Unbudgeted', '15', 'Bank charges', 'Charges', '', '', '0', '', '', '', '', '', '', '', 'none', '', '', ''],
    ['P1.1', 'Pharmacy', 'Pharmacy', 'P1', 'Pharmacy building', 'Room', '', '', '850', '', 'Not started', '', '', '', '', '', 'full budget', '', 'Check against 2.1', '']]);
  schrijfCsv(map, 'Transactions', ['txn_id', 'date', 'project', 'phase', 'activity_no', 'activity', 'line_id', 'budget_item', 'description', 'invoice_or_ref', 'amount_gmd',
    'paid_from', 'payment_method', 'cheque_no', 'evidence', 'source', 'wg_2023_0476_phase1a_gmd', 'wg_2023_0476_item', 'notes'], [
    ['T0001', '2025-02-10', 'Building', 'Phase 1A', '1', '', '1.1', '', 'Blocks', 'INV1', w.t1 || '1100', 'GMD (ECG)', 'Cheque', '2', 'Listed in WG ledger', '', w.wg1 || '1100', '1.1', ''],
    ['T0002', '2025-02-11', 'Building', 'Phase 1A', '1', '', '1.2', '', 'Cement', 'INV2', '200', 'GMD (ECG)', 'Cheque', '2', 'Listed in WG ledger', '', '200', '1.2', ''],
    ['T0003', '2025-03-01', 'Building', 'Phase 1A', '2', '', '2.1', '', 'Blocks', 'INV3', '1500', 'GMD (ECG)', 'Cheque', '3', 'Handwritten list', '', '', '', ''],
    ['T0004', '2026-07-20', 'Building', 'Phase 3', '3', '', '3.99', '', 'Cheque 3 not itemised', '', '400', 'GMD (ECG)', 'Cheque', '4', 'Bank statement only', '', '', '', ''],
    ['T0005', '2025-02-05', 'Building', 'Unbudgeted', '15', '', w.regelT5 || '15.1', '', 'Charge', 'C1', '20', 'EUR account', 'Bank debit (EUR)', '', 'Bank statement', '', '', '', '']]);
  schrijfCsv(map, 'Bank', ['bank_txn_id', 'account', 'date', 'description', 'reference', 'amount', 'currency', 'balance_after', 'type', 'cheque_no', 'payee', 'source'], [
    ['B0001', 'EUR 111', '2025-02-01', 'TRF B/ in', 'R1', '100', 'EUR', '100', 'Transfer in from NL', '', '', ''],
    ['B0002', 'EUR 111', '2025-02-05', 'COMMISSION', 'R2', '-0.25', 'EUR', '99.75', 'Bank charge', '', '', ''],
    ['B0003', 'EUR 111', '2025-02-06', 'PURCH', 'R3', '-50', 'EUR', '49.75', 'Conversion out', '', '', ''],
    ['B0004', 'EUR 111', '2025-02-07', 'CASH WDL', 'R4', '-10', 'EUR', '39.75', 'Cash withdrawal', '', '', ''],
    ['B0005', 'GMD 222', '2025-02-06', 'PURCH', 'R3', '4000', 'GMD', '4000', 'Conversion in', '', '', ''],
    ['B0006', 'GMD 222', '2025-02-12', 'CHQ 2', 'R5', '-1300', 'GMD', '2700', 'Cheque withdrawal', '2', 'Builder', ''],
    ['B0007', 'GMD 222', '2025-03-02', 'CHQ 3', 'R6', '-1500', 'GMD', '1200', 'Cheque withdrawal', '3', 'Builder', ''],
    ['B0008', 'GMD 222', '2026-07-21', 'CHQ 4', 'R7', '-600', 'GMD', '600', 'Cheque withdrawal', '4', 'Builder', ''],
    ['B0009', 'GMD 222', '2026-07-22', 'CHARGE', 'R8', '-5', 'GMD', '595', 'Bank charge', '', '', '']]);
  schrijfCsv(map, 'Money_Flows', ['flow_id', 'date', 'type', 'from', 'to', 'eur', 'gmd', 'rate_gmd_per_eur', 'project', 'purpose', 'source', 'notes'], [
    ['M001', '2025-01-20', 'Transfer to ECG', 'Stichting GHAWA (Triodos)', 'ECG', '100', '', '', 'Building', '', '', ''],
    ['M002', '2025-02-06', 'Conversion EUR to GMD', 'EUR 111', 'GMD 222', '50', '4000', '80', 'Building', '', '', '']]);
  schrijfCsv(map, 'Funding', ['fund_id', 'funder', 'type', 'project', 'purpose', 'amount_eur', 'date', 'status', 'where_the_money_is', 'notes'], [
    ['F01', 'Sponsor Zon', 'Sponsor', 'Pharmacy', 'Pharmacy', '5', '2025-12-01', 'Received by GHAWA NL', 'GHAWA', ''],
    ['F02', 'Club Vallei', 'Sponsor', 'Building', 'Interior', '20', '', 'Committed - not yet received', '', ''],
    ['F03', 'GHAWA online donations', 'Donations (yearly)', 'Building', 'General', '12.5', '', 'Expected per year', 'GHAWA', '']]);
  schrijfCsv(map, 'Open_Questions', ['q_id', 'topic', 'question', 'amount_gmd', 'who', 'status', 'answer'], [
    ['Q01', 'Cheque', 'What was cheque 4 for?', '600', 'Partner', 'Open', ''], ['Q02', 'Old', 'Closed one', '', 'David', 'Closed', 'done']]);
  schrijfCsv(map, 'GHAWA_Bank', ['g_id', 'account', 'date', 'year', 'amount_eur', 'direction', 'counterparty', 'counter_account', 'code', 'description', 'balance_after',
    'category', 'donor', 'project', 'purpose'], [
    ['G0001', 'Current NL00', '2024-01-05', '2024', '150', 'in', DONOR, REK, '', 'gift', '150', 'Donation (bank transfer)', DONOR, 'General', ''],
    ['G0002', 'Current NL00', '2024-02-01', '2024', w.g2 || '-100', 'out', 'ECG', 'GM00', '', 'to ECG', '50', 'Transfer to ECG', '', 'Building', ''],
    ['G0003', 'Current NL00', '2025-12-01', '2025', '5', 'in', 'Sponsor Zon', 'NL01', '', 'sponsor', '55', 'Sponsor AFAS (pharmacy)', '', 'Pharmacy', ''],
    ['G0004', 'Current NL00', '2025-12-31', '2025', '-1', 'out', 'Bank', '', '', 'costs', '54', 'Bank costs', '', 'General', '']]);
  schrijfCsv(map, 'GHAWA_Donors', ['donor', 'type', 'recurring', 'y2023', 'y2024', 'y2025', 'y2026_to_date', 'total', 'expected_per_year', 'gifts', 'last_gift', 'notes'], [
    [DONOR, 'Private', 'Yes', '', '150', '', '', '150', '30', '1', '2024-01-05', '']]);
  fs.writeFileSync(path.join(map, 'Settings.csv'), 'Settings\n\nkey,value,note\nas_of_date,2026-07-31,x\nindicative_rate_gmd_per_eur,80,x\nbank_balance_gmd,595,x\nbank_balance_eur,39.75,x\n');
  fs.writeFileSync(path.join(map, 'Reconciliation.csv'), 'Reconciliation\n\nB. Cheque withdrawals Jul-Sep 2026: how much is itemised?\n' +
    '"Cash withdrawn from the EUR account on 7-2-2025 (EUR 10, exchanged at 73.80)",,,,,738\n' +
    'Received for Phase 1A (WG workbook),,,,,1300\nBalance according to the statements (current),,,,,54\n' +
    'G. First withdrawals (Feb-May 2025)\n"7-2-2025: cash from the EUR account, EUR 10",,,,,738,,,"Clearing"\n');
  return map;
}
function vers(wijzig) {
  const map = maakFixture(wijzig);
  const db = path.join(map, 'ghawa.sqlite');
  const n = G.invoer(map, db, { nu: '2026-11-10T10:00:00Z' });
  return { map, db, n };
}

test('invoer en rekenkern op verzonnen cijfers', () => {
  const { db, n } = vers();
  assert.deepStrictEqual([n.activiteiten, n.regels, n.uitgaven, n.bank_ecg, n.bank_ghawa, n.donateurs], [5, 8, 5, 9, 4, 1]);
  assert.strictEqual(fs.statSync(db).mode & 0o777, 0o600);
  const k = G.bereken(G.leesData(db));
  const r = Object.fromEntries(k.regels.map((x) => [x.id, x]));
  assert.strictEqual(r['1.1'].open, 0);                 // none
  assert.strictEqual(r['1.2'].open, 30000);             // budget - realised: 500 - 200
  assert.strictEqual(r['2.9'].open, 50000);             // activity balance: (2000 + 0) - 1500
  assert.strictEqual(r['3.1'].open, 300000);            // full budget
  assert.strictEqual(r['3.99'].open, -40000);           // offset: niet gespecificeerde opname tegen het budget
  const a = Object.fromEntries(k.activiteiten.map((x) => [x.nr, x]));
  // activiteit 1: begroot 1500, gerealiseerd 1300, open 300 → prognose 1600: overschrijding 100, niet nodig 0 (verrekend, niet per regel)
  assert.deepStrictEqual([a['1'].begroot, a['1'].gerealiseerd, a['1'].open, a['1'].niet_nodig, a['1'].overschrijding], [150000, 130000, 30000, 0, 10000]);
  assert.deepStrictEqual([a['3'].open, a['3'].niet_nodig], [260000, 0]);
  assert.strictEqual(k.bouw.controle, 0);
  assert.strictEqual(k.bouw.begroot, 650000); assert.strictEqual(k.bouw.gerealiseerd, 322000);
  // fasen
  const f = Object.fromEntries(k.fasen.map((x) => [x.id, x]));
  assert.strictEqual(f['Phase 1A'].open, 80000); assert.strictEqual(f['Phase 3'].gerealiseerd, 40000);
  // aansluitingen
  assert.strictEqual(k.aansluiting.A.verschil, 0); assert.strictEqual(k.aansluiting.A.breuken, 0); assert.strictEqual(k.aansluiting.A.instelling_gelijk, true);
  assert.strictEqual(k.aansluiting.D.uitbetaald, 340000);
  assert.strictEqual(k.aansluiting.D.gespecificeerd, 320000);   // GMD (ECG) zonder 15.1: 1100 + 200 + 1500 + 400
  assert.strictEqual(k.aansluiting.D.contant_gmd, 73800);
  assert.strictEqual(k.aansluiting.D.niet_gespecificeerd, 20000 + 73800);
  assert.strictEqual(k.aansluiting.E.verschil, 0); assert.strictEqual(k.aansluiting.E.keten_breuken, 0);
  assert.strictEqual(k.aansluiting.F.verschil, 0);
  assert.deepStrictEqual(k.aansluiting.B.cheques, [{ cheque: '4', opgenomen: 60000, gespecificeerd: 0, niet: 60000 }]);
  assert.strictEqual(k.sluit, true);
  // nog te werven: bouw open 2600+... /80, oormerk bouw 20, ECG 39,75 + 595/80, GHAWA vrij 54 - 5
  const bouwOpen = k.bouw.open / 100 / 80;
  assert.strictEqual(k.werven.nog_te_werven, Math.max(0, Math.round((bouwOpen - 20 - 39.75 - 595 / 80 - 49) * 100) / 100));   // hier genoeg geld: 0, nooit negatief
  assert.strictEqual(k.werven.bouw_na_oormerk, Math.round((bouwOpen - 20) * 100) / 100);
  assert.strictEqual(k.werven.verwacht_vaste_donateurs, 30);
  assert.strictEqual(k.werven.apo_overschot, 0);   // 850/80 = 10,63 open, oormerk 5
});

test('kruisproef: één uitgave anders → andere uitkomst; GHAWA-regel anders → E sluit niet', () => {
  const k1 = G.bereken(G.leesData(vers().db));
  const k2 = G.bereken(G.leesData(vers({ t1: '1101' }).db));
  assert.notStrictEqual(k1.bouw.gerealiseerd, k2.bouw.gerealiseerd);
  assert.strictEqual(k2.aansluiting.D.niet_gespecificeerd, k1.aansluiting.D.niet_gespecificeerd - 100);
  const k2b = G.bereken(G.leesData(vers({ wg1: '1101' }).db));
  assert.strictEqual(k2b.aansluiting.F.verschil, -100);
  assert.strictEqual(k2b.sluit, false);
  const k3 = G.bereken(G.leesData(vers({ g2: '-99' }).db));
  assert.notStrictEqual(k3.aansluiting.E.keten_breuken, 0);
  assert.strictEqual(k3.sluit, false);
});

test('invoer weigert een onbekende regel en een uitgave zonder begrotingsregel', () => {
  assert.throws(() => vers({ regel: 'guess' }), /onbekende still_open_rule/);
  assert.throws(() => vers({ regelT5: '99.9' }), /onbekende regel/);
});

test('routes: alle schermen 200, geen donateur of tegenrekening in een antwoord', () => {
  const { db, map } = vers();
  const bron = path.join(map, 'bronnen'); fs.mkdirSync(path.join(bron, 'csv'), { recursive: true });
  fs.writeFileSync(path.join(bron, 'Overdracht.md'), '# x'); fs.writeFileSync(path.join(bron, 'Financial overview.xlsx'), 'x');
  const app = G.maak({ dbPad: db, bronnenMap: bron, vaultMap: map }).app;
  const paden = ['/app/ghawa', '/app/ghawa/overzicht', '/app/ghawa/bouw', '/app/ghawa/apotheek', '/app/ghawa/geld', '/app/ghawa/vragen', '/app/ghawa/documenten',
    '/app/ghawa/activiteit/1', '/app/ghawa/activiteit/P1'];
  for (const p of paden) {
    const u = app({ pad: p });
    assert.strictEqual(u.status, 200, p);
    const t = JSON.stringify(u.body);
    assert.ok(!t.includes(DONOR) && !t.includes('Pietersen') && !t.includes(REK), 'donateur of rekening in ' + p);
  }
  const o = app({ pad: '/app/ghawa' }).body;
  assert.strictEqual(o.datastand, '2026-07-31'); assert.strictEqual(o.vragen.open, 1); assert.strictEqual(o.sluit, true);
  assert.ok(o.aandacht.some((x) => x.label === 'toezegging'));
  const ak = app({ pad: '/app/ghawa/activiteit/1' }).body;
  assert.strictEqual(ak.regels.find((r) => r.id === '1.1').uitgaven[0].referentie, 'INV1');
  const doc = app({ pad: '/app/ghawa/documenten' }).body;
  assert.strictEqual(doc.stukken.length, 2); assert.strictEqual(doc.stukken.find((s) => /xlsx$/.test(s.naam)).intern, true);
  assert.strictEqual(app({ pad: '/app/ghawa/activiteit/77' }).status, 404);
  assert.strictEqual(app({ pad: '/app/ghawa/donateurs' }).status, 404);
  assert.strictEqual(app({ pad: '/app/ghawa/../x' }).status, 404);
  assert.strictEqual(G.maak({ dbPad: path.join(map, 'nee.sqlite') }).app({ pad: '/app/ghawa' }).status, 503);
});

test('review wv2877: invoervolgorde wint van het nummer, geen stille uitval, decimaal exact', () => {
  // banknummers B1, B2, B10: tekstvolgorde zou B10 vóór B2 zetten en het verkeerde saldo als laatste nemen
  const map = maakFixture();
  const bank = fs.readFileSync(path.join(map, 'Bank.csv'), 'utf8').replace('B0009,', 'B10,').replace('B0008,', 'B9,');
  fs.writeFileSync(path.join(map, 'Bank.csv'), bank);
  const db = path.join(map, 'g.sqlite'); G.invoer(map, db);
  const k = G.bereken(G.leesData(db));
  assert.strictEqual(k.ecg.gmd.saldo, 59500); assert.strictEqual(k.aansluiting.A.breuken, 0);
  // een echte datarij met een afwijkende sleutel stopt de invoer (een voetnoot met alleen de eerste kolom mag)
  const m2 = maakFixture();
  fs.appendFileSync(path.join(m2, 'Transactions.csv'), 'Footnote text only\nX0099,2025-01-01,Building,,1,,1.1,,stil weg?,,999,GMD (ECG),,,,,,,\n');
  assert.throws(() => G.invoer(m2, path.join(m2, 'g.sqlite')), /ongeldige sleutel/);
  const m4 = maakFixture();   // alleen een bedrag gevuld, sleutel leeg: geen voetnoot
  fs.appendFileSync(path.join(m4, 'Transactions.csv'), ',,,,,,,,,,777,,,,,,,,\n');
  assert.throws(() => G.invoer(m4, path.join(m4, 'g.sqlite')), /ongeldige sleutel/);
  // herinvoer over een databank van een oudere versie (tabel zonder volg) bouwt het schema opnieuw op
  const m5 = maakFixture(), db5 = path.join(m5, 'g.sqlite');
  { const { DatabaseSync } = require('node:sqlite'); const x = new DatabaseSync(db5); x.exec('CREATE TABLE bankregel_ecg (id TEXT PRIMARY KEY, rekening TEXT)'); x.close(); }
  G.invoer(m5, db5); assert.strictEqual(G.bereken(G.leesData(db5)).aansluiting.A.breuken, 0);
  const m3 = maakFixture();
  fs.writeFileSync(path.join(m3, 'Transactions.csv'), fs.readFileSync(path.join(m3, 'Transactions.csv'), 'utf8').replace('txn_id,', 'id,'));
  assert.throws(() => G.invoer(m3, path.join(m3, 'g.sqlite')), /mist kolom txn_id/);
  assert.strictEqual(G.cent('1.005'), 101); assert.strictEqual(G.cent('-0.015'), -2); assert.strictEqual(G.cent('47075.77'), 4707577); assert.throws(() => G.cent('1e3'));
});

test('csv-lezer: aanhalingstekens, komma en regeleinde in een veld', () => {
  assert.deepStrictEqual(G.csvLees('a,b\n"x, ""y""","r1\nr2"\n'), [['a', 'b'], ['x, "y"', 'r1\nr2']]);
  assert.strictEqual(G.cent('2666620.78'), 266662078); assert.strictEqual(G.cent(''), null); assert.throws(() => G.cent('12a'));
});
