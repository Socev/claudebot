'use strict';
// wv2880: gedeelde verzonnen fixture voor test/ghawa.test.js en test/ghawa-bij.test.js (uit ghawa.test.js van wv2877).
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

module.exports = { DONOR, REK, schrijfCsv, maakFixture, vers };
