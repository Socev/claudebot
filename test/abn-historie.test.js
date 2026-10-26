'use strict';
// Toetsen voor wv1329: de ABN-historie (overzetting van de PDF-afschriften) in de transactiedatabase van de bankluis (bank-archief.historieBij,
// tools/bank-historie.js). Alles verzonnen: IBAN's met bankcode TEST of lage ABN-nummers, "Leverancier A", bedragen bedacht. Raakt /opt/data/bank,
// de kluis, de bank en de vault niet (alles in TMPDIR). Facturen-kant: test/facturen-validatie.test.js (ABN-historie).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const A = require(path.join(ROOT, 'bank-archief.js'));
const { ibanFromAbnAccount } = require(path.join(ROOT, 'mt940-lezer.js'));

const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
const GEZ = ibanFromAbnAccount('0000000051'), POTI = ibanFromAbnAccount('0000000055'), LEV = ibanFromAbnAccount('0000000101');

function opzet() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abn-historie-'));
  WEG.push(dir);
  const a = A.open(dir);
  A.zakelijkZet(a, { [POTI]: 'POT' });
  A.rekeningenSync(a, { gez: { uid: 'u1', bank: 'ABN AMRO', naam: 'Gezamenlijk', iban: GEZ }, pot: { uid: 'u2', bank: 'ABN AMRO', naam: 'POT', iban: POTI } });
  return { dir, a };
}
const post = (id, datum, bedrag, saldo) => ({ id, datum, valutadatum: datum, bedrag, valuta: 'EUR', tegenpartij: 'Leverancier A', omschrijving: 'SEPA Overboeking Naam: Leverancier A',
  status: 'geboekt', saldo_na: saldo == null ? null : saldo, tegen_iban: LEV, _ruw: { id } });
const rij = (id, datum, bedrag, saldo) => ({ mutatie_id: id, datum, valutadatum: datum, bedrag, tegenpartij: 'Leverancier A', tegen_iban: LEV,
  omschrijving: 'SEPA Overboeking IBAN: ' + LEV + ' Naam: Leverancier A Omschrijving: proef', saldo_na: saldo });
const tel = (a, sql, ...p) => Number(a.db.prepare(sql).get(...p).n);

test('historieBij: wat de bank al gaf wordt afgedekt (ook 1-5 dagen verschoven), de rest ingevoegd met saldo; tweede keer al bekend', () => {
  const { a } = opzet();
  A.bij(a, 'gez', [post('b1', '2025-05-02', -10, 990), post('b2', '2025-05-09', -20, 970), post('b3', '2025-05-09', -20, 950)]);
  const lijst = [rij('X-2025-004-001', '2025-04-01', 1000, 1000), rij('X-2025-004-002', '2025-04-20', -5, 995), rij('X-2025-005-001', '2025-04-30', -10, 985),
    rij('X-2025-005-002', '2025-05-07', -20, 965), rij('X-2025-005-003', '2025-05-09', -20, 945)];
  const d = A.historieBij(a, 'gez', lijst, { droog: true });
  assert.deepEqual([d.nieuw, d.gedekt, d.in_venster, d.bestaand_rest, d.sluit], [2, 3, 0, 0, true]);
  assert.equal(tel(a, 'SELECT count(*) n FROM transacties'), 3, 'droog schrijft niets');
  const u = A.historieBij(a, 'gez', lijst);
  assert.deepEqual([u.nieuw, u.gedekt], [2, 3]);
  const nieuw = a.db.prepare("SELECT sleutel, bron_id, status, herkomst_rij, saldo_na, ruwe_json FROM transacties WHERE herkomst_rij = 'abn-historie' ORDER BY datum").all();
  assert.deepEqual(nieuw.map((x) => [x.sleutel, x.status, x.saldo_na, x.ruwe_json]), [['abnhist|X-2025-004-001', 'booked', 1000, null], ['abnhist|X-2025-004-002', 'booked', 995, null]]);
  assert.equal(A.metaLees(a, 'vuil'), '1');
  const twee = A.historieBij(a, 'gez', lijst);
  assert.deepEqual([twee.nieuw, twee.al_bekend, twee.gedekt], [0, 2, 3]);
  // de bankposten zelf onaangeroerd
  assert.equal(tel(a, "SELECT count(*) n FROM transacties WHERE herkomst_rij = 'bank' AND status = 'booked' AND vervangen_door IS NULL"), 3);
});

test('historieBij: sluit niet (bankpost zonder tegenhanger in de periode, of te veel nieuwe regels na de eerste bankdag) → geweigerd, niets ingevoegd; forceer wel', () => {
  const { a } = opzet();
  A.bij(a, 'gez', [post('b1', '2025-05-02', -10), post('b2', '2025-05-20', -77)]);
  const mist = [rij('X-1', '2025-04-01', 1000, 1000), rij('X-2', '2025-05-02', -10, 990), rij('X-3', '2025-05-25', -1, 989)];
  const u = A.historieBij(a, 'gez', mist);
  assert.deepEqual([u.geweigerd, u.bestaand_rest, u.in_venster], [true, 1, 1]);
  assert.equal(tel(a, "SELECT count(*) n FROM transacties WHERE herkomst_rij = 'abn-historie'"), 0);
  const veel = [rij('Y-1', '2025-05-02', -10, 990)].concat([1, 2, 3, 4].map((i) => rij('Y-x' + i, '2025-05-1' + i, -i, 990 - i)));
  const v = A.historieBij(a, 'gez', veel, { droog: true });
  assert.deepEqual([v.in_venster, v.sluit], [4, false]);
  assert.equal(A.historieBij(a, 'gez', mist, { forceer: true }).nieuw, 2);
});

test('POT: historie telt mee in het POT-afschrift (saldo per post), niet in de datahub-invoer', () => {
  const { a } = opzet();
  A.bij(a, 'pot', [post('p1', '2025-05-02', -10, 990)]);
  A.historieBij(a, 'pot', [rij('P-2025-004-001', '2025-04-03', 1000, 1000), rij('P-2025-004-002', '2025-04-10', -5, 995), rij('P-2025-004-003', '2025-04-30', 5, 1000),
    rij('P-2025-005-001', '2025-05-02', -10, 990)]);
  const dh = A.potDatahubInvoer(a, null);
  assert.deepEqual(dh.posten.map((p) => p.sleutel), ['p1'], 'datahub ziet alleen wat de bankkoppeling gaf');
  const m = A.potAfschriftMaanden(a);
  assert.equal(m.eerste_maand, '2025-04');
  const inv = A.potAfschriftInvoer(a, '2025-04');
  assert.equal(inv.posten.length, 3);
  assert.ok(inv.posten.every((p) => Number.isFinite(Number(p.saldo_na))));
});

test('tools/bank-historie.js: leest het CSV, weigert een gebroken saldoketen en een onbekende rekening, bewaart de bron byte-gelijk (0600)', () => {
  const { dir, a } = opzet();
  A.bij(a, 'gez', [post('b1', '2025-05-02', -10, 990)]);
  a.db.close();
  const kop = 'Mutatie-ID;Rekening;Boekdatum;Rentedatum;Bedrag;Af Bij;Type;Tegenrekening;BIC;Naam;Omschrijving;Kenmerk;Betalingskenmerk;Incassant;Machtiging;Volledige omschrijving;Saldo na mutatie;Afschrift datum;Afschrift volgnr;Pagina;Bronbestand';
  const r = (iban, id, d, b, s) => [iban + '-' + id, iban, d, d, b, b.startsWith('-') ? 'Af' : 'Bij', 'SEPA Overboeking', LEV, 'TESTNL2A', 'Leverancier A', 'proef', '', '', '', '',
    'SEPA Overboeking | IBAN: ' + LEV + ' | Naam: Leverancier A | Omschrijving: proef', s, d, id.slice(0, 8), '1', 'x.pdf'].join(';');
  const csv = (iban, regels) => '﻿' + kop + '\r\n' + regels.join('\r\n') + '\r\n';
  const goed = path.join(dir, 'goed.csv'), stuk = path.join(dir, 'stuk.csv'), vreemd = path.join(dir, 'vreemd.csv');
  fs.writeFileSync(goed, csv(GEZ, [r(GEZ, '2025-004-001', '2025-04-01', '1000,00', '1000,00'), r(GEZ, '2025-005-001', '2025-05-02', '-10,00', '990,00')]));
  fs.writeFileSync(stuk, csv(GEZ, [r(GEZ, '2025-004-001', '2025-04-01', '1000,00', '1000,00'), r(GEZ, '2025-004-002', '2025-04-02', '-10,00', '991,00')]));
  const ander = ibanFromAbnAccount('0000000099');
  fs.writeFileSync(vreemd, csv(ander, [r(ander, '2025-004-001', '2025-04-01', '1000,00', '1000,00')]));
  const p = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'bank-historie.js'), goed, stuk, vreemd], { env: Object.assign({}, process.env, { BANK_DIR: dir }), encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  const u = JSON.parse(p.stdout);
  assert.deepEqual(u.map((x) => [x.ok, x.nieuw, x.gedekt]), [[true, 1, 1], [false, undefined, undefined], [false, undefined, undefined]]);
  assert.match(u[1].fout, /saldoketen breekt op 1 regel/);
  assert.match(u[2].fout, /niet in de bankluis/);
  assert.ok(!/Leverancier|1000|990/.test(p.stdout), 'geen namen of bedragen in de uitvoer');
  const bron = path.join(dir, 'historie-bron');
  const f = fs.readdirSync(bron);
  assert.equal(f.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(bron, f[0])), fs.readFileSync(goed));
  assert.equal((fs.statSync(path.join(bron, f[0])).mode & 0o777).toString(8), '600');
  // de omschrijving in de vorm van de bankluis (labels zonder |), zodat machtiging en naam herkend worden
  const b = A.open(dir);
  assert.equal(b.db.prepare("SELECT omschrijving FROM transacties WHERE herkomst_rij = 'abn-historie'").get().omschrijving.indexOf('|'), -1);
});
