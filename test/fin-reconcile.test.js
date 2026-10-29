'use strict';
// Toetsen voor wv1864 (Second Brain 2.0 fase 4a): fin-toewijzing.js (kern) en fin-reconcile.js (momentopname, dekking per dag, aansluiting,
// reken.sqlite). Proef 3 (echte dubbele transacties blijven beide; 3a–3d via de echte inleesweg van de Facturen-app) en proef 6 (dekking:
// ontbrekend is geen nul). Ontwerp: vault 01_Ontwikkeling/Second Brain 2.0 - fase 4 financiële pilot Tolgaarde (ontwerp 28-10-2026).md § 4.
// Alles verzonnen (de repo is openbaar): IBAN's met bankcode TEST of lage ABN-nummers, "Leverancier A B.V.", ronde bedragen. Raakt
// /opt/data/facturen, /opt/data/fin-reken, de kluis, mail en de vault niet (alles in TMPDIR). Draaien: bash test/fin-reconcile.sh
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'facturen-db.js'));
const K = require(path.join(ROOT, 'facturen-kern.js'));
const B = require(path.join(ROOT, 'facturen-bank.js'));
const F = require(path.join(ROOT, 'facturen.js'));
const T = require(path.join(ROOT, 'fin-toewijzing.js'));
const FR = require(path.join(ROOT, 'fin-reconcile.js'));
const { maakIban } = require(path.join(ROOT, 'test', 'facturen-zaad.js'));
const { ibanFromAbnAccount } = require(path.join(ROOT, 'mt940-lezer.js'));
const { DatabaseSync } = require('node:sqlite');

const NU = Date.parse('2026-10-22T12:30:00Z');
const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });

const ACC_TG = '0000000041';
const TG = ibanFromAbnAccount(ACC_TG);
const LEV = { A: maakIban('NL', 'TEST', '0000000101'), B: maakIban('NL', 'TEST', '0000000102'), C: maakIban('NL', 'TEST', '0000000103'),
  E: maakIban('NL', 'TEST', '0000000105'), Z: maakIban('NL', 'TEST', '0000000199') };

// ───────────────────────────── opzet ─────────────────────────────

function opzet() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-reconcile-'));
  WEG.push(dir);
  const fdb = D.open(path.join(dir, 'db'));
  D.transactie(fdb, () => {
    for (const [s, n] of [['tolgaarde', 'Huisartsenpraktijk Proef B.V.'], ['prive', 'Privé']]) D.voegToe(fdb, 'entiteit', { sleutel: s, naam: n });
    D.voegToe(fdb, 'rekening', { id: D.nieuwId(), entiteit: 'tolgaarde', iban: TG, bank: 'ABN', bank_formaat: 'abn_tab', controle: 1, alleen_eigenaar: 0 });
  });
  D.metaZet(fdb, 'startdatum', '2026-10-01');
  const rek = fdb.db.prepare("SELECT id FROM rekening WHERE entiteit = 'tolgaarde'").get().id;
  const rekeningen = fdb.db.prepare('SELECT id, iban, entiteit, bank_formaat, controle, alleen_eigenaar FROM rekening').all();
  const eig = F.rolVoor(fdb, { ingang: 'app', wie: 'david (proef)' });
  return { dir, fdb, rek, rekeningen, eig, rk: path.join(dir, 'rk'), pad: path.join(dir, 'db', 'facturen.sqlite') };
}
const fmt = (c) => { const a = Math.abs(c), s = Math.floor(a / 100) + ',' + String(a % 100).padStart(2, '0'); return (c < 0 ? '-' : '') + s; };
// ABN-TAB met een lopend saldo (oudste eerst); r = [datum JJJJ-MM-DD, bedrag in centen, omschrijving]; o.saldo = begin; o.zonder = index weg
// uit het BESTAND (de keten breekt), de databank krijgt dan nog steeds alle regels (zie zetBron)
function tabRijen(rijen, begin) {
  let saldo = begin == null ? 1000000 : begin;
  return rijen.map(([d, c, desc]) => { const b = saldo, e = saldo + c; saldo = e; const dat = d.replace(/-/g, ''); return [ACC_TG, 'EUR', dat, fmt(b), fmt(e), dat, fmt(c), desc].join('\t'); });
}
const ov = (iban, naam, remi) => '/TRTP/SEPA OVERBOEKING/IBAN/' + iban + '/BIC/TESTNL2A/NAME/' + naam + '/REMI/' + remi + '/EREF/NOTPROVIDED';
const terug = (iban, naam, remi) => '/TRTP/SEPA OVERBOEKING/IBAN/' + iban + '/BIC/TESTNL2A/NAME/' + naam + '/REMI/' + remi + '/EREF/NOTPROVIDED';
let txTeller = 0;
function zetTx(t, x, bestand, extra) {
  const e = extra || {};
  t.fdb.db.prepare('INSERT INTO bank_transactie (id, bestand, rekening, entiteit, eigen_iban, boekdatum, bedrag_centen, valuta, tegenpartij_naam, tegenpartij_iban, omschrijving, kenmerk, transactietype, is_incasso, incassant_id, machtiging, entry_ref, formaat, alleen_eigenaar, categorie, verwijderd_op, verwijderd_door, aangemaakt_op) ' +
    "VALUES (?, ?, ?, 'tolgaarde', ?, ?, ?, 'EUR', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'abn_tab', 0, ?, ?, ?, ?) ON CONFLICT (entry_ref) DO NOTHING")
    .run('d' + String(++txTeller).padStart(15, '0'), bestand, t.rek, TG, x.boekdatum, x.bedrag_centen, x.tegenpartij_naam || null, x.tegenpartij_iban || null, x.omschrijving || null,
      x.kenmerk || null, x.transactietype || null, x.is_incasso ? 1 : 0, x.incassant_id || null, x.machtiging || null, x.entry_ref, e.categorie || null, e.verwijderd ? '2026-10-20T10:00:00Z' : null,
      e.verwijderd ? 'toets' : null, '2026-10-20T10:00:00Z');
}
// Bronbestand + bank_bestand + (tenzij db:false) de regels in de databank. o = { naam, op (uploadtijd), zonder: [index] (uit het bestand,
// niet uit de databank), dbExtra: [regels die alleen in de databank staan], begin }
function zetBron(t, rijen, o) {
  o = o || {};
  const alle = tabRijen(rijen, o.begin);
  const inBestand = alle.filter((_, i) => !(o.zonder || []).includes(i));
  const tekst = inBestand.join('\n') + '\n';
  const bytes = Buffer.from(tekst, 'utf8');
  const sha = D.sha256(bytes);
  const map = path.join(t.fdb.dir, 'bankbron');
  fs.mkdirSync(map, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(map, sha), bytes, { mode: 0o600 });
  const lees = B.leesBankbestand(new Uint8Array(Buffer.from(alle.join('\n') + '\n')), { rekeningen: t.rekeningen });
  assert.ok(lees.ok, JSON.stringify(lees));
  const bid = D.nieuwId();
  D.voegToe(t.fdb, 'bank_bestand', { id: bid, sha256: sha, formaat: 'abn_tab', naam: o.naam || 'proef TXT261020100000.TAB', aantal: inBestand.length, per_rekening: JSON.stringify({ [TG]: inBestand.length }),
    geupload_door: 'toets', geupload_op: o.op || '2026-10-20T10:00:00.000Z', modus: 'historisch', bank: 'ABN', bron_bewaard: 1 });
  if (o.db !== false) for (const x of lees.transacties) zetTx(t, x, bid);
  return { sha, bid, transacties: lees.transacties };
}
let fTeller = 0;
function zetFactuur(t, f) {
  const id = crypto.createHash('sha256').update('f' + (++fTeller)).digest('hex').slice(0, 16);
  D.voegToe(t.fdb, 'factuur_archief', { id, herkomst: 'fv2', extern_id: 'proef-' + fTeller, entiteit: 'tolgaarde', leverancier_naam: f.lev || 'Leverancier A B.V.', nummer: f.nummer === undefined ? null : f.nummer,
    factuurdatum: f.datum === undefined ? null : f.datum, vervaldatum: f.verval || null, incl: f.incl === undefined ? null : f.incl, iban: f.iban || null, kenmerk: f.kenmerk || null,
    betaalwijze: f.betaalwijze || null, status: f.status || 'beslist', aangemaakt_op: '2026-10-20T10:00:00Z' });
  return 'archief:' + id;
}
function draai(t, extra) { return FR.run(Object.assign({ dir: t.rk, facturen: t.pad, entiteit: 'tolgaarde', nu: NU }, extra || {})); }
function lees(t, run) {
  const db = new DatabaseSync(path.join(t.rk, 'reken.sqlite'), { readOnly: true });
  try {
    return {
      run: db.prepare('SELECT * FROM reken_run WHERE id = ?').get(run),
      a: new Map(db.prepare('SELECT * FROM aansluiting WHERE run = ?').all(run).map((x) => [x.factuur_ref, x])),
      dek: new Map(db.prepare('SELECT * FROM dekking WHERE run = ?').all(run).map((x) => [x.dag, x])),
      onv: db.prepare('SELECT * FROM onverklaard WHERE run = ? ORDER BY entry_ref').all(run),
      tabel: (n) => db.prepare('SELECT * FROM ' + n + ' WHERE run = ? ORDER BY 2, 3').all(run).map((x) => { const y = Object.assign({}, x); delete y.run; return y; }),
    };
  } finally { /* rijen zijn al gelezen */ setImmediate(() => db.close()); }
}
const dagenVan = (a, b) => T.dagenVan(a, b);

// ───────────────────────────── proef 3a–3d: inleesweg Facturen ─────────────────────────────

const hist = (t, bytes, naam) => F.verwerkBankbestand(t.fdb, t.eig, Buffer.from(bytes), naam || 'export.tab', NU, { modus: 'historisch', herkomst: 'toets' });
const tabTekst = (rijen, begin) => tabRijen(rijen, begin).join('\n') + '\n';
const HKOP = 'Mutatie-ID;Rekening;Boekdatum;Rentedatum;Bedrag;Af Bij;Type;Tegenrekening;BIC;Naam;Omschrijving;Kenmerk;Betalingskenmerk;Incassant;Machtiging;Volledige omschrijving;Saldo na mutatie;Afschrift datum;Afschrift volgnr;Pagina;Bronbestand';
function hcsv(rijen, begin) {
  let saldo = begin == null ? 1000000 : begin;
  const per = {};
  return '﻿' + HKOP + '\r\n' + rijen.map(([d, c, tegen, naam, oms]) => {
    saldo += c;
    const afs = d.slice(0, 4) + '-' + d.slice(5, 7).padStart(3, '0');
    per[afs] = (per[afs] || 0) + 1;
    const id = TG + '-' + afs + '-' + String(per[afs]).padStart(3, '0');
    return [id, TG, d, d, fmt(c), c < 0 ? 'Af' : 'Bij', 'SEPA Overboeking', tegen || '', tegen ? 'TESTNL2A' : '', naam || '', oms || '', '', '', '', '',
      'SEPA Overboeking | IBAN: ' + (tegen || '') + ' | Naam: ' + (naam || '') + ' | Omschrijving: ' + (oms || ''), fmt(saldo), d, afs, '1', 'proef.pdf'].join(';');
  }).join('\r\n') + '\r\n';
}
const nTx = (t) => Number(t.fdb.db.prepare('SELECT count(*) AS n FROM bank_transactie WHERE verwijderd_op IS NULL').get().n);

test('3a/3b: twee gelijke betalingen (zelfde dag, tegenrekening, bedrag, omschrijving; ander saldo na) blijven twee regels, ook na hetzelfde bestand en een overlappend tweede bestand', () => {
  const t = opzet();
  const twee = [['2026-03-10', -10000, ov(LEV.A, 'Leverancier A B.V.', 'Factuur 2026-100')], ['2026-03-10', -10000, ov(LEV.A, 'Leverancier A B.V.', 'Factuur 2026-100')]];
  const u1 = hist(t, tabTekst(twee), 'a.tab');
  assert.equal(u1.nieuw, 2, '3a: beide regels');
  assert.equal(nTx(t), 2);
  const u2 = hist(t, tabTekst(twee), 'a-weer.tab');
  assert.equal(u2.al_bekend, true, '3b: zelfde bestand → al bekend');
  assert.equal(nTx(t), 2);
  hist(t, tabTekst(twee.concat([['2026-03-12', -5000, ov(LEV.B, 'Leverancier B B.V.', 'Factuur 2026-200')]])), 'b.tab');
  assert.equal(nTx(t), 3, '3b: overlappend bestand voegt alleen de nieuwe regel toe');
  assert.equal(Number(t.fdb.db.prepare("SELECT count(*) AS n FROM bank_transactie WHERE boekdatum = '2026-03-10'").get().n), 2);
});

test('3c: afschrifthistorie met twee gelijke regels op een dag waar de databank er één heeft → geweigerd (afdekken op aantal), niets stil aangevuld', () => {
  const t = opzet();
  hist(t, tabTekst([['2026-03-10', -10000, ov(LEV.A, 'Leverancier A B.V.', 'Factuur 2026-100')]]), 'een.tab');
  assert.equal(nTx(t), 1);
  const h = hcsv([['2026-03-10', -10000, LEV.A, 'Leverancier A B.V.', 'Factuur 2026-100'], ['2026-03-10', -10000, LEV.A, 'Leverancier A B.V.', 'Factuur 2026-100']]);
  assert.throws(() => hist(t, h, 'historie.csv'), (e) => e && e.status === 409 && /sluiten niet op elkaar aan/.test(String(e.message || e.uitleg || JSON.stringify(e))));
  assert.equal(nTx(t), 1, 'geen regel erbij, niets samengevoegd');
});

test('3d: afschrifthistorie met twee gelijke regels (twee Mutatie-ID\'s) op een dag zonder TAB → twee regels', () => {
  const t = opzet();
  const h = hcsv([['2026-03-10', -10000, LEV.A, 'Leverancier A B.V.', 'Factuur 2026-100'], ['2026-03-10', -10000, LEV.A, 'Leverancier A B.V.', 'Factuur 2026-100']]);
  const u = hist(t, h, 'historie.csv');
  assert.equal(u.nieuw, 2);
  assert.equal(nTx(t), 2);
});

// ───────────────────────────── proef 3e–3j: aansluiting ─────────────────────────────

// Bank januari t/m juni 2026 in één sluitend bestand; vaste randregels op 1-1 en 30-6 zodat het hele halfjaar gedekt is.
function halfjaar(t, betalingen, o) {
  const rijen = [['2026-01-01', 100000, ov(LEV.Z, 'Klant Z', 'ontvangst januari')]].concat(betalingen).concat([['2026-06-30', 100000, ov(LEV.Z, 'Klant Z', 'ontvangst juni')]]);
  rijen.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return zetBron(t, rijen, o);
}

test('3e: twee facturen van dezelfde leverancier, zelfde bedrag, elk een uniek nummer in de omschrijving → beide betaald, elk aan de eigen regel', () => {
  const t = opzet();
  const f1 = zetFactuur(t, { nummer: 'A-2026-0101', datum: '2026-03-01', verval: '2026-03-15', incl: 25000, iban: LEV.A });
  const f2 = zetFactuur(t, { nummer: 'A-2026-0102', datum: '2026-03-01', verval: '2026-03-15', incl: 25000, iban: LEV.A });
  const b = halfjaar(t, [['2026-03-10', -25000, ov(LEV.A, 'Leverancier A B.V.', 'Factuurnummer A-2026-0102')], ['2026-03-10', -25000, ov(LEV.A, 'Leverancier A B.V.', 'Factuurnummer A-2026-0101')]]);
  const r = draai(t);
  const x = lees(t, r.run);
  assert.equal(x.a.get(f1).status, 'betaald'); assert.equal(x.a.get(f2).status, 'betaald');
  assert.equal(x.a.get(f1).laag, 1); assert.equal(x.a.get(f2).laag, 1);
  const r1 = JSON.parse(x.a.get(f1).entry_refs), r2 = JSON.parse(x.a.get(f2).entry_refs);
  const refVan = (nr) => b.transacties.find((y) => y.omschrijving.indexOf(nr) >= 0).entry_ref;
  assert.deepEqual(r1, [refVan('A-2026-0101')]); assert.deepEqual(r2, [refVan('A-2026-0102')]);
});

test('3f: twee facturen zonder kenmerk, zelfde bedrag en IBAN, twee gelijke betalingen → beide betaald (laag 2, op volgorde), aanname vastgelegd', () => {
  const t = opzet();
  const f1 = zetFactuur(t, { nummer: null, datum: '2026-03-01', verval: '2026-03-15', incl: 30000, iban: LEV.B, lev: 'Leverancier B B.V.' });
  const f2 = zetFactuur(t, { nummer: null, datum: '2026-03-02', verval: '2026-03-16', incl: 30000, iban: LEV.B, lev: 'Leverancier B B.V.' });
  halfjaar(t, [['2026-03-12', -30000, ov(LEV.B, 'Leverancier B B.V.', 'betaling')], ['2026-03-12', -30000, ov(LEV.B, 'Leverancier B B.V.', 'betaling')]]);
  const r = draai(t);
  const x = lees(t, r.run);
  assert.equal(x.a.get(f1).status, 'betaald'); assert.equal(x.a.get(f2).status, 'betaald');
  assert.equal(x.a.get(f1).laag, 2);
  assert.notDeepEqual(JSON.parse(x.a.get(f1).entry_refs), JSON.parse(x.a.get(f2).entry_refs));
  assert.ok(JSON.parse(x.run.aannames).includes('gelijke_facturen_op_volgorde'));
});

test('3g: één factuur, twee gelijke betalingen → factuur betaald; tweede regel onverklaard, mogelijk_dubbel_betaald', () => {
  const t = opzet();
  const f = zetFactuur(t, { nummer: 'C-2026-0300', datum: '2026-03-01', verval: '2026-03-15', incl: 40000, iban: LEV.C, lev: 'Leverancier C B.V.' });
  halfjaar(t, [['2026-03-11', -40000, ov(LEV.C, 'Leverancier C B.V.', 'Factuurnummer C-2026-0300')], ['2026-03-11', -40000, ov(LEV.C, 'Leverancier C B.V.', 'Factuurnummer C-2026-0300')]]);
  const r = draai(t);
  const x = lees(t, r.run);
  assert.equal(x.a.get(f).status, 'betaald');
  assert.equal(x.a.get(f).betaald_centen, 40000);
  const d = x.onv.filter((o) => o.reden === 'mogelijk_dubbel_betaald');
  assert.equal(d.length, 1);
  assert.equal(d[0].factuur_ref, f);
  assert.ok(!JSON.parse(x.a.get(f).entry_refs).includes(d[0].entry_ref));
});

test('3h: factuurnummer dat ook in een andere afschrijving voorkomt (klantnummer) → kandidaat, niet betaald', () => {
  const t = opzet();
  const f = zetFactuur(t, { nummer: 'KL-778899', datum: '2026-04-01', verval: '2026-04-15', incl: 12000, lev: 'Leverancier E B.V.' });
  halfjaar(t, [['2026-01-20', -9000, ov(LEV.E, 'Leverancier E B.V.', 'Klantnummer KL-778899 januari')], ['2026-04-10', -12000, ov(LEV.E, 'Leverancier E B.V.', 'Klantnummer KL-778899 april')]]);
  const r = draai(t);
  const x = lees(t, r.run);
  assert.equal(x.a.get(f).status, 'kandidaat');
  assert.equal(x.a.get(f).reden, 'sleutel_niet_uniek');
  assert.equal(x.a.get(f).betaald_centen, null);
});

test('3i: afschrijving + storno binnen 10 dagen → geen betaling; factuur open of onbepaald, nooit betaald', () => {
  const t = opzet();
  const f = zetFactuur(t, { nummer: 'A-2026-0500', datum: '2026-03-01', verval: '2026-03-15', incl: 50000, iban: LEV.A });
  halfjaar(t, [['2026-03-10', -50000, ov(LEV.A, 'Leverancier A B.V.', 'Factuurnummer A-2026-0500')], ['2026-03-14', 50000, terug(LEV.A, 'Leverancier A B.V.', 'Terugboeking A-2026-0500')]]);
  const r = draai(t);
  const x = lees(t, r.run);
  assert.notEqual(x.a.get(f).status, 'betaald');
  assert.ok(['open', 'onbepaald_dekking', 'nog_niet_te_beoordelen'].includes(x.a.get(f).status), x.a.get(f).status);
  assert.equal(JSON.parse(x.run.telling).storno_paren, 1);
});

test('3j: 3e–3i samen twee keer draaien op dezelfde momentopname → byte-gelijke uitkomsttabellen', () => {
  const t = opzet();
  zetFactuur(t, { nummer: 'A-2026-0101', datum: '2026-03-01', verval: '2026-03-15', incl: 25000, iban: LEV.A });
  zetFactuur(t, { nummer: 'A-2026-0102', datum: '2026-03-01', verval: '2026-03-15', incl: 25000, iban: LEV.A });
  zetFactuur(t, { nummer: null, datum: '2026-03-01', verval: '2026-03-15', incl: 30000, iban: LEV.B, lev: 'Leverancier B B.V.' });
  zetFactuur(t, { nummer: null, datum: '2026-03-02', verval: '2026-03-16', incl: 30000, iban: LEV.B, lev: 'Leverancier B B.V.' });
  zetFactuur(t, { nummer: 'C-2026-0300', datum: '2026-03-01', verval: '2026-03-15', incl: 40000, iban: LEV.C, lev: 'Leverancier C B.V.' });
  zetFactuur(t, { nummer: 'KL-778899', datum: '2026-04-01', verval: '2026-04-15', incl: 12000, lev: 'Leverancier E B.V.' });
  zetFactuur(t, { nummer: 'A-2026-0500', datum: '2026-03-01', verval: '2026-03-15', incl: 50000, iban: LEV.A });
  halfjaar(t, [
    ['2026-03-10', -25000, ov(LEV.A, 'Leverancier A B.V.', 'Factuurnummer A-2026-0102')], ['2026-03-10', -25000, ov(LEV.A, 'Leverancier A B.V.', 'Factuurnummer A-2026-0101')],
    ['2026-03-12', -30000, ov(LEV.B, 'Leverancier B B.V.', 'betaling')], ['2026-03-12', -30000, ov(LEV.B, 'Leverancier B B.V.', 'betaling')],
    ['2026-03-11', -40000, ov(LEV.C, 'Leverancier C B.V.', 'Factuurnummer C-2026-0300')], ['2026-03-11', -40000, ov(LEV.C, 'Leverancier C B.V.', 'Factuurnummer C-2026-0300')],
    ['2026-01-20', -9000, ov(LEV.E, 'Leverancier E B.V.', 'Klantnummer KL-778899 januari')], ['2026-04-10', -12000, ov(LEV.E, 'Leverancier E B.V.', 'Klantnummer KL-778899 april')],
    ['2026-03-10', -50000, ov(LEV.A, 'Leverancier A B.V.', 'Factuurnummer A-2026-0500')], ['2026-03-14', 50000, terug(LEV.A, 'Leverancier A B.V.', 'Terugboeking A-2026-0500')],
  ]);
  const r1 = draai(t);
  const r2 = draai(t, { snapshot: r1.snapshot });
  assert.equal(r1.uitkomst_hash, r2.uitkomst_hash);
  const x1 = lees(t, r1.run), x2 = lees(t, r2.run);
  for (const n of ['dekking', 'aansluiting', 'onverklaard']) assert.equal(JSON.stringify(x1.tabel(n)), JSON.stringify(x2.tabel(n)), n);
  // en een verse momentopname van dezelfde, ongewijzigde databank geeft hetzelfde
  const r3 = draai(t);
  assert.equal(r3.snapshot, r1.snapshot);
  assert.equal(r3.uitkomst_hash, r1.uitkomst_hash);
  assert.equal(r1.telling.betaald, 5);
  assert.equal(r1.telling.kandidaat, 1);
});

// ───────────────────────────── proef 6: dekking ─────────────────────────────

// Twaalf maanden 2025 in losse, sluitende maandbestanden (randregels op de 1e en de laatste dag), twintig facturen (15 betaald met het nummer
// in de omschrijving, 5 zonder betaling). o.zonder: maand(en) weg (regels én bestand); o.zonderBron: bestand weg, regels in de databank;
// o.breuk: maand → index die uit het bestand gaat (keten breekt, databank houdt hem); o.extra: [regel] alleen in de databank;
// o.halfjuni: juni-bestand begint op 16-6; o.laatsteNaam: bestandsnaam van december (TXT…, gemaakt op de laatste dag).
const MAAND_EIND = ['31', '28', '31', '30', '31', '30', '31', '31', '30', '31', '30', '31'];
function jaar(t, o) {
  o = o || {};
  const facturen = [];
  for (let i = 0; i < 20; i++) {
    const datum = K.plusDagen('2025-02-05', i * 14);
    const betaald = i % 4 !== 3;
    facturen.push({ i, nummer: 'PRF-' + (1001 + i), datum, verval: K.plusDagen(datum, 14), incl: 10000 * (i + 1), betaald, betaaldag: K.plusDagen(datum, 10) });
  }
  const refs = facturen.map((f) => zetFactuur(t, { nummer: f.nummer, datum: f.datum, verval: f.verval, incl: f.incl, iban: LEV.A }));
  let saldo = 5000000;
  const bronnen = {};
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const eerste = (m === 6 && o.halfjuni) ? '2025-06-16' : '2025-' + mm + '-01';
    const rijen = [[eerste, -500, ov(LEV.Z, 'Bank Proef', 'kosten ' + mm)]];
    for (const f of facturen) if (f.betaald && f.betaaldag.slice(0, 7) === '2025-' + mm && f.betaaldag >= eerste) rijen.push([f.betaaldag, -f.incl, ov(LEV.A, 'Leverancier A B.V.', 'Factuurnummer ' + f.nummer)]);
    rijen.push(['2025-' + mm + '-' + MAAND_EIND[m - 1], 200000, ov(LEV.Z, 'Klant Z', 'ontvangst ' + mm)]);
    rijen.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const begin = saldo;
    saldo += rijen.reduce((a, r) => a + r[1], 0);
    if ((o.zonder || []).includes(m)) continue;
    const naam = m === 12 && o.laatsteNaam ? o.laatsteNaam : 'maand-' + mm + ' TXT261020100000.TAB';
    bronnen[m] = zetBron(t, rijen, { begin, naam, zonder: o.breuk && o.breuk[m] !== undefined ? [o.breuk[m]] : [] });
    if ((o.zonderBron || []).includes(m)) fs.unlinkSync(path.join(t.fdb.dir, 'bankbron', bronnen[m].sha));
  }
  const eenBestand = Object.values(bronnen)[0].bid;
  for (const x of o.extra || []) zetTx(t, { boekdatum: x[0], bedrag_centen: x[1], omschrijving: 'extra', entry_ref: 'x' + crypto.createHash('sha1').update(String(x[0]) + '|' + x[1]).digest('hex').slice(0, 19) }, eenBestand, x[2]);
  return { facturen, refs, bronnen };
}
const nodig = (f) => dagenVan(f.datum, K.plusDagen(f.verval, 14));

test('6a: twaalf maanden sluitend, twintig facturen, alles aanwezig → antwoord, totalen gevuld', () => {
  const t = opzet();
  const j = jaar(t);
  const r = draai(t);
  assert.equal(r.uitkomst, 'antwoord');
  assert.equal(r.code, null);
  assert.equal(r.telling.betaald, 15);
  assert.equal(r.telling.open, 5);
  const x = lees(t, r.run);
  const tot = JSON.parse(x.run.totalen);
  assert.ok(tot);
  assert.equal(tot.facturen, 20);
  assert.equal(tot.open_centen, j.facturen.filter((f) => !f.betaald).reduce((a, f) => a + f.incl, 0));
  assert.equal(tot.betaald_centen, j.facturen.filter((f) => f.betaald).reduce((a, f) => a + f.incl, 0));
  assert.equal(x.run.bank_tm, '2025-12-31');
  // de eerste dag van het allereerste bestand is onzeker (geen eerder bestand om op aan te sluiten); vanaf 2-1 alles gedekt
  assert.equal(x.dek.get('2025-01-01').reden, 'eerste_dag_onzeker');
  for (const d of dagenVan('2025-01-02', '2025-12-31')) assert.equal(x.dek.get(d).status, 'gedekt', d);
  assert.match(x.run.dekkingsregel, /alles gedekt/);
});

test('6b: juni weggelaten (regels én bronbestand) → onvolledig / INCOMPLETE_COVERAGE, juni ontbreekt, totalen null, geen factuur met een juni-dag open', () => {
  const t = opzet();
  const j = jaar(t, { zonder: [6] });
  const r = draai(t);
  assert.equal(r.uitkomst, 'onvolledig');
  assert.equal(r.code, 'INCOMPLETE_COVERAGE');
  const x = lees(t, r.run);
  assert.equal(x.run.totalen, null);
  for (const d of dagenVan('2025-06-01', '2025-06-30')) assert.equal(x.dek.get(d).status, 'ontbreekt', d);
  let geraakt = 0;
  j.facturen.forEach((f, i) => {
    const a = x.a.get(j.refs[i]);
    const juni = nodig(f).some((d) => d.slice(0, 7) === '2025-06');
    const betaaldBuitenJuni = f.betaald && f.betaaldag.slice(0, 7) !== '2025-06' && K.plusDagen(f.betaaldag, 10).slice(0, 7) !== '2025-06';
    if (juni) assert.notEqual(a.status, 'open', f.nummer);
    // zonder (zichtbare) betaling en met een juni-dag nodig, of betaald in juni (die regel ontbreekt nu): niet te beoordelen
    if (juni && !betaaldBuitenJuni) { geraakt++; assert.equal(a.status, 'onbepaald_dekking', f.nummer); }
    if (betaaldBuitenJuni) assert.equal(a.status, 'betaald', f.nummer);
  });
  assert.ok(geraakt >= 2, 'er zijn facturen die juni nodig hebben');
  assert.equal(x.run.bank_tm, '2025-05-31');
  // ook 1-7 telt niet: het juli-bestand sluit met zijn beginsaldo niet aan op mei (de juni-mutaties ontbreken)
  assert.equal(x.dek.get('2025-07-01').reden, 'eerste_dag_onzeker');
  assert.match(x.run.dekkingsregel, /niet gedekt: 1-6-2025 t\/m 1-7-2025/);
});

test('6c: juni-regels in de databank, bronbestand weg → alleen_databank; onvolledig', () => {
  const t = opzet();
  jaar(t, { zonderBron: [6] });
  const r = draai(t);
  const x = lees(t, r.run);
  assert.equal(x.dek.get('2025-06-01').status, 'alleen_databank');
  assert.equal(x.dek.get('2025-06-10').status, 'ontbreekt', 'een dag zonder regels en zonder bron');
  assert.equal(r.uitkomst, 'onvolledig');
  assert.ok(JSON.parse(x.run.bronnen).some((b) => b.fout === 'bron_ontbreekt'));
});

test('6d: saldoketen in juni gebroken (één regel weg uit het bestand) → afwijkend; onvolledig', () => {
  const t = opzet();
  const j = jaar(t, { breuk: { 6: 1 } });
  const r = draai(t);
  const x = lees(t, r.run);
  const weg = j.bronnen[6].transacties[1].boekdatum;
  assert.equal(x.dek.get(weg).status, 'afwijkend');
  assert.equal(x.dek.get(weg).reden, 'saldoketen');
  assert.equal(r.uitkomst, 'onvolledig');
});

test('6e: één extra regel in de databank die niet in het bronbestand staat → die dag afwijkend; onvolledig', () => {
  const t = opzet();
  // 5-6 hoort bij de dagen die de onbetaalde factuur PRF-1008 (14-5, vervaldatum + 14 = 11-6) nodig heeft → onvolledig; een extra regel op
  // een dag die geen factuur nodig heeft (20-1, vóór elke factuurdatum − 7) maakt die dag afwijkend maar de uitkomst niet onvolledig (§ 3.5)
  const t0 = opzet();
  jaar(t0, { extra: [['2025-01-20', -777]] });
  const r0 = draai(t0);
  assert.equal(lees(t0, r0.run).dek.get('2025-01-20').status, 'afwijkend');
  assert.equal(r0.uitkomst, 'antwoord');
  const j = jaar(t, { extra: [['2025-06-05', -777]] });
  const r = draai(t);
  const x = lees(t, r.run);
  assert.equal(x.dek.get('2025-06-05').status, 'afwijkend');
  assert.equal(x.dek.get('2025-06-05').reden, 'databank_wijkt_af');
  assert.equal(x.dek.get('2025-06-04').status, 'gedekt');
  assert.equal(x.a.get(j.refs[7]).status, 'onbepaald_dekking');
  assert.equal(r.uitkomst, 'onvolledig');
});

test('6f: bronbestand juni begint halverwege → de dagen ervóór ontbreken', () => {
  const t = opzet();
  jaar(t, { halfjuni: true });
  const r = draai(t);
  const x = lees(t, r.run);
  for (const d of dagenVan('2025-06-01', '2025-06-15')) assert.equal(x.dek.get(d).status, 'ontbreekt', d);
  // hier had juni vóór de 16e geen mutaties: het beginsaldo sluit aan op mei, dus de eerste dag telt wel (de dagen ertussen niet)
  assert.equal(x.dek.get('2025-06-16').status, 'gedekt');
  // een bestand waarvan het beginsaldo niet aansluit (er ontbreken mutaties ervóór): de eerste dag is onzeker
  const t3 = opzet();
  zetBron(t3, [['2026-01-02', -100, ov(LEV.Z, 'Bank Proef', 'k')], ['2026-01-30', 100, ov(LEV.Z, 'Klant Z', 'o')]], { begin: 1000000 });
  zetBron(t3, [['2026-03-10', -100, ov(LEV.Z, 'Bank Proef', 'k')], ['2026-03-31', 100, ov(LEV.Z, 'Klant Z', 'o')]], { begin: 1234500 });
  zetFactuur(t3, { nummer: 'A-7001', datum: '2026-03-20', verval: '2026-03-25', incl: 1000, iban: LEV.A });
  const x3 = lees(t3, draai(t3).run);
  assert.equal(x3.dek.get('2026-03-10').status, 'alleen_databank');
  assert.equal(x3.dek.get('2026-03-10').reden, 'eerste_dag_onzeker');
  assert.equal(x3.dek.get('2026-03-11').status, 'gedekt');
  // in 6a sluit elk maandbestand aan op het vorige: elke eerste dag telt
  const t2 = opzet();
  jaar(t2);
  assert.equal(lees(t2, draai(t2).run).dek.get('2025-06-01').status, 'gedekt');
});

test('6g: laatste exportdag, bestand op die dag zelf gemaakt → "bank t/m" is de dag ervoor', () => {
  const t = opzet();
  jaar(t, { laatsteNaam: 'TXT251231140000.TAB' });
  const r = draai(t);
  const x = lees(t, r.run);
  assert.equal(r.bank_tm, '2025-12-30');
  assert.equal(x.dek.get('2025-12-31').status, 'alleen_databank');
  assert.equal(x.dek.get('2025-12-31').reden, 'exportdag');
  assert.equal(FR.gemaaktOp({ naam: 'TXT251231140000.TAB', geupload_op: '2026-01-05T10:00:00Z' }), '2025-12-31');
  assert.equal(FR.gemaaktOp({ naam: 'export.tab', geupload_op: '2026-01-05T10:00:00Z' }), null, 'uploaddag bewijst niets');
  // zonder TXT-naam telt de laatste dag niet (onbekend wanneer het bestand die dag gemaakt is)
  const t2 = opzet();
  jaar(t2, { laatsteNaam: 'december.tab' });
  assert.equal(draai(t2).bank_tm, '2025-12-30');
});

test('6h: regel met verwijderd_op telt niet; dag gedekt als het bestand hem niet heeft, afwijkend als het bestand hem wel heeft', () => {
  const t = opzet();
  const j = jaar(t, { extra: [['2025-07-10', -333, { verwijderd: true }]] });
  // een regel die in het bestand staat, in de databank op verwijderd
  const weg = j.bronnen[8].transacties.find((x) => x.bedrag_centen === -500);
  t.fdb.db.prepare("UPDATE bank_transactie SET verwijderd_op = '2026-10-20T11:00:00Z', verwijderd_door = 'toets' WHERE entry_ref = ?").run(weg.entry_ref);
  const r = draai(t);
  const x = lees(t, r.run);
  assert.equal(x.dek.get('2025-07-10').status, 'gedekt', 'verwijderde regel die het bestand niet heeft');
  assert.equal(x.dek.get(weg.boekdatum).status, 'afwijkend', 'verwijderde regel die het bestand wel heeft');
});

test('6i: factuur met vervaldatum + 14 ná "bank t/m" → nog_niet_te_beoordelen, niet open, uitkomst niet onvolledig', () => {
  const t = opzet();
  jaar(t);
  const f = zetFactuur(t, { nummer: 'PRF-9001', datum: '2025-12-20', verval: '2026-01-03', incl: 77700, iban: LEV.A });
  const r = draai(t);
  const x = lees(t, r.run);
  assert.equal(x.a.get(f).status, 'nog_niet_te_beoordelen');
  assert.equal(r.uitkomst, 'antwoord');
  assert.match(x.run.dekkingsregel, /1 nog niet te beoordelen/);
});

test('6j: factuur zonder factuurdatum → onbepaald_gegevens (niet zoeken over de hele historie)', () => {
  const t = opzet();
  jaar(t);
  const f = zetFactuur(t, { nummer: 'PRF-1001', datum: null, incl: 10000, iban: LEV.A });
  const r = draai(t);
  const x = lees(t, r.run);
  assert.equal(x.a.get(f).status, 'onbepaald_gegevens');
  assert.equal(x.a.get(f).reden, 'geen_factuurdatum');
});

test('6k: dag zonder mutaties binnen een sluitend bestand → gedekt', () => {
  const t = opzet();
  jaar(t);
  const r = draai(t);
  const x = lees(t, r.run);
  assert.equal(x.dek.get('2025-03-02').db_regels, 0);
  assert.equal(x.dek.get('2025-03-02').status, 'gedekt');
});

// ───────────────────────────── regels van de kern (puur) ─────────────────────────────

const ALLES = { status: () => 'gedekt', laatst_gedekt: '2099-12-31', bank_tm: '2099-12-31' };
let eTeller = 0;
const tx = (d, c, iban, naam, oms, extra) => Object.assign({ entry_ref: crypto.createHash('sha1').update('t' + (++eTeller)).digest('hex').slice(0, 20), boekdatum: d, bedrag_centen: c,
  tegenpartij_iban: iban, tegenpartij_naam: naam, omschrijving: oms, kenmerk: null, categorie: null }, extra || {});
const fk = (ref, o) => Object.assign({ ref, leverancier: 'Leverancier A B.V.', nummer: null, kenmerk: null, factuurdatum: '2026-03-01', vervaldatum: '2026-03-15', bedrag_centen: 10000,
  ibans: [LEV.A], soort: 'factuur', fv2_betaalwijze: null }, o || {});
const kern = (facturen, transacties, o) => T.sluitAan(Object.assign({ facturen, transacties, dekking: ALLES, aanname: { van: '2026-01-01', tot: '2026-12-31' }, scope: { van: '2025-01-01', tot: '2026-12-31' } }, o || {}));
const st = (u, ref) => u.regels.find((r) => r.ref === ref);

test('kern: IBAN + bedrag ruim vóór de factuurdatum (huur van de vorige maand) is geen betaling; met het nummer erin wel', () => {
  const t1 = tx('2026-01-30', -10000, LEV.A, 'Leverancier A B.V.', 'huur');
  const u = kern([fk('archief:0000000000000001', { factuurdatum: '2026-03-01' })], [t1]);
  assert.notEqual(st(u, 'archief:0000000000000001').status, 'betaald');
  const t2 = tx('2026-02-01', -10000, LEV.A, 'Leverancier A B.V.', 'Factuur HUUR-2026-03');
  const u2 = kern([fk('archief:0000000000000001', { factuurdatum: '2026-03-01', nummer: 'HUUR-2026-03' })], [t2]);
  assert.equal(st(u2, 'archief:0000000000000001').status, 'betaald');
});

test('kern: een kort nummer bij een andere tegenpartij met een ander bedrag is geen bewijs → kandidaat (sleutel_andere_partij)', () => {
  const t1 = tx('2026-03-10', -98000, LEV.B, 'Leverancier B B.V.', 'Factuurnummer 2026-17');
  const u = kern([fk('archief:0000000000000002', { nummer: '2026-17', bedrag_centen: 16000 })], [t1]);
  assert.equal(st(u, 'archief:0000000000000002').status, 'kandidaat');
  assert.equal(st(u, 'archief:0000000000000002').reden, 'sleutel_andere_partij');
});

test('kern: een betaling die een ánder factuurnummer noemt telt niet via IBAN + bedrag, maar maakt de factuur kandidaat (nooit open)', () => {
  const t1 = tx('2026-03-10', -10000, LEV.A, 'Leverancier A B.V.', 'Factuurnummer 2026-9120');
  const u = kern([fk('archief:0000000000000003', { nummer: '2026-9100' })], [t1]);
  assert.equal(st(u, 'archief:0000000000000003').status, 'kandidaat');
  assert.equal(st(u, 'archief:0000000000000003').reden, 'noemt_ander_nummer');
  assert.equal(st(u, 'archief:0000000000000003').laag, null);
  // zonder enige afschrijving naar die leverancier: open
  assert.equal(st(kern([fk('archief:0000000000000003', { nummer: '2026-9100' })], [tx('2026-03-10', -10000, LEV.E, 'Iemand Anders', 'iets')]), 'archief:0000000000000003').status, 'open');
});

test('review P1/P1b: terugkerend IBAN + bedrag (vaste opdracht) schuift geen betaling op naar een onbetaalde factuur → kandidaat', () => {
  // oktober onbetaald, november betaald, de decemberfactuur staat niet in de set maar de betaling wel
  const okt = fk('archief:00000000000000a1', { factuurdatum: '2025-10-01', vervaldatum: '2025-10-15' }), nov = fk('archief:00000000000000a2', { factuurdatum: '2025-11-01', vervaldatum: '2025-11-15' });
  // een vaste opdracht heeft eerdere maanden in de historie (hier september); zonder die historie is het patroon niet te zien (grens, zie de kern)
  const ts = [tx('2025-09-05', -10000, LEV.A, 'Leverancier A B.V.', 'huur'), tx('2025-11-05', -10000, LEV.A, 'Leverancier A B.V.', 'huur'), tx('2025-12-05', -10000, LEV.A, 'Leverancier A B.V.', 'huur')];
  const u = kern([okt, nov], ts, { aanname: {}, scope: {} });
  assert.notEqual(st(u, okt.ref).status, 'betaald');
  assert.equal(st(u, okt.ref).reden, 'terugkerend_bedrag');
  const u1 = kern([okt], [tx('2025-11-05', -10000, LEV.A, 'Leverancier A B.V.', 'huur')].concat([tx('2025-09-05', -10000, LEV.A, 'Leverancier A B.V.', 'huur')]), { aanname: {}, scope: {} });
  assert.notEqual(st(u1, okt.ref).status, 'betaald');
});

test('review P3/P4: terugboeking (sepa_terug) heft de afschrijving op — geen betaling via laag 0 en de regel betaalt niet de volgende factuur', () => {
  const f1 = fk('factuur:00000000000000b1', {}), f2 = fk('factuur:00000000000000b2', { factuurdatum: '2026-03-20', vervaldatum: '2026-04-03' });
  const af1 = tx('2026-03-10', -10000, LEV.A, 'Leverancier A B.V.', 'batch'), terugB = tx('2026-03-14', 10000, LEV.A, 'Leverancier A B.V.', 'terugboeking');
  const kop = [{ entry_ref: af1.entry_ref, factuur_ref: f1.ref, methode: 'sepa_batch' }, { entry_ref: terugB.entry_ref, factuur_ref: f1.ref, methode: 'sepa_terug' }];
  const u = kern([f1, f2], [af1, terugB], { koppelingen: kop, besluiten: [{ factuur_ref: f1.ref, entry_refs: [af1.entry_ref], oordeel: 'ja' }] });
  assert.equal(st(u, f1.ref).status, 'kandidaat');
  assert.equal(st(u, f1.ref).reden, 'besluit_teruggeboekt');
  assert.notEqual(st(u, f2.ref).status, 'betaald', 'de teruggeboekte regel betaalt de volgende factuur niet');
  const u2 = kern([f1, f2], [af1, terugB], { koppelingen: kop });
  assert.notEqual(st(u2, f2.ref).status, 'betaald');
});

test('review P2: een later besluit nee heft een eerder ja op hetzelfde paar op', () => {
  const t1 = tx('2026-03-10', -10000, LEV.E, 'Iemand Anders', 'losse betaling');
  const f = fk('archief:00000000000000c1', {});
  const u = kern([f], [t1], { besluiten: [{ factuur_ref: f.ref, entry_refs: [t1.entry_ref], oordeel: 'ja' }, { factuur_ref: f.ref, entry_refs: [t1.entry_ref], oordeel: 'nee' }] });
  assert.notEqual(st(u, f.ref).status, 'betaald');
  assert.notEqual(st(u, f.ref).laag, 0);
});

test('review P5: een gat in de bank ná vervaldatum + 14 maar binnen +120 (vóór de laatste gedekte dag) maakt open onzeker → onbepaald_dekking', () => {
  const dek = { status: (d) => (d >= '2026-04-10' && d <= '2026-04-20' ? 'ontbreekt' : 'gedekt'), laatst_gedekt: '2026-12-31' };
  const u = kern([fk('archief:00000000000000d1', {})], [], { dekking: dek });
  assert.equal(st(u, 'archief:00000000000000d1').status, 'onbepaald_dekking');
  assert.equal(st(u, 'archief:00000000000000d1').reden, 'gat_na_vervaldatum');
  assert.equal(u.uitkomst, 'onvolledig');
});

test('kern: twee facturen met elk een uniek nummer in dezelfde afschrijving → beide kandidaat (verzamelbetaling), de som telt niet', () => {
  const t1 = tx('2026-03-10', -20000, LEV.A, 'Leverancier A B.V.', 'Facturen A-1001 A-1002');
  const u = kern([fk('archief:0000000000000004', { nummer: 'A-1001' }), fk('archief:0000000000000005', { nummer: 'A-1002' })], [t1]);
  assert.equal(st(u, 'archief:0000000000000004').reden, 'verzamelbetaling');
  assert.equal(st(u, 'archief:0000000000000005').reden, 'verzamelbetaling');
  assert.equal(u.totalen.betaald_centen, 0);
});

test('kern: deelbetaling via unieke sleutel → deels met restbedrag; termijnen zonder sleutel → kandidaat', () => {
  const t1 = tx('2026-03-10', -4000, LEV.A, 'Leverancier A B.V.', 'Factuurnummer A-2001 deel 1');
  const u = kern([fk('archief:0000000000000006', { nummer: 'A-2001' })], [t1]);
  assert.equal(st(u, 'archief:0000000000000006').status, 'deels');
  assert.equal(st(u, 'archief:0000000000000006').rest_centen, 6000);
  const u2 = kern([fk('archief:0000000000000007', {})], [tx('2026-03-05', -6000, LEV.A, 'Leverancier A B.V.', 'termijn'), tx('2026-04-05', -4000, LEV.A, 'Leverancier A B.V.', 'termijn')]);
  assert.equal(st(u2, 'archief:0000000000000007').status, 'kandidaat');
  assert.equal(st(u2, 'archief:0000000000000007').reden, 'termijnen');
});

test('kern: besluit ja (laag 0) koppelt; besluit nee verbiedt het paar; reeds voldaan zonder betaling → elders_voldaan; creditnota → onbepaald_gegevens', () => {
  const t1 = tx('2026-03-10', -10000, LEV.E, 'Iemand Anders', 'losse betaling');
  const f = fk('archief:0000000000000008', {});
  const u = kern([f], [t1], { besluiten: [{ factuur_ref: f.ref, entry_refs: [t1.entry_ref], oordeel: 'ja' }] });
  assert.equal(st(u, f.ref).status, 'betaald'); assert.equal(st(u, f.ref).laag, 0);
  const t2 = tx('2026-03-10', -10000, LEV.A, 'Leverancier A B.V.', 'Factuurnummer A-3001');
  const g = fk('archief:0000000000000009', { nummer: 'A-3001' });
  const u2 = kern([g], [t2], { besluiten: [{ factuur_ref: g.ref, entry_refs: [t2.entry_ref], oordeel: 'nee' }] });
  assert.notEqual(st(u2, g.ref).status, 'betaald');
  const u3 = kern([fk('archief:000000000000000a', { fv2_betaalwijze: 'reeds_voldaan' })], []);
  assert.equal(st(u3, 'archief:000000000000000a').status, 'elders_voldaan');
  // reeds voldaan, maar op de factuurdatum gaat precies dat bedrag af onder een andere naam (betaaldienst) → kandidaat, geen aanname
  const u3b = kern([fk('archief:000000000000000d', { fv2_betaalwijze: 'reeds_voldaan', ibans: [] })], [tx('2026-03-01', -10000, LEV.E, 'Betaaldienst Proef', 'order 123')]);
  assert.equal(st(u3b, 'archief:000000000000000d').status, 'kandidaat');
  assert.equal(st(u3b, 'archief:000000000000000d').reden, 'bedrag_rond_factuurdatum');
  const u4 = kern([fk('archief:000000000000000b', { soort: 'creditnota' }), fk('archief:000000000000000c', { bedrag_centen: -500 })], []);
  assert.equal(st(u4, 'archief:000000000000000b').status, 'onbepaald_gegevens');
  assert.equal(st(u4, 'archief:000000000000000c').status, 'onbepaald_gegevens');
});

test('kern: elke bankregel hooguit één keer, ook met veel gelijke facturen en regels; volgorde van de invoer doet er niet toe', () => {
  const fs_ = [], ts = [];
  for (let i = 0; i < 30; i++) { fs_.push(fk('archief:' + String(i).padStart(16, '0'), { factuurdatum: K.plusDagen('2026-01-05', i * 3), nummer: i % 2 ? 'R-' + (5000 + i) : null })); ts.push(tx(K.plusDagen('2026-01-10', i * 3), -10000, LEV.A, 'Leverancier A B.V.', i % 2 ? 'Factuurnummer R-' + (5000 + i) : 'betaling')); }
  const u = kern(fs_, ts);
  const gezien = new Map();
  for (const r of u.regels) for (const e of r.entry_refs) { assert.ok(!gezien.has(e), 'regel ' + e + ' aan twee facturen'); gezien.set(e, r.ref); }
  const u2 = kern(fs_.slice().reverse(), ts.slice().reverse());
  assert.equal(JSON.stringify(u2), JSON.stringify(u));
});

test('kern: dagenGedekt onderscheidt gat (vóór de laatste gedekte dag) en toekomst', () => {
  const dek = { status: (d) => (d === '2026-03-05' ? 'ontbreekt' : d <= '2026-03-31' ? 'gedekt' : null), laatst_gedekt: '2026-03-31' };
  assert.equal(T.dagenGedekt(dek, '2026-03-01', '2026-03-10'), 'gat');
  assert.equal(T.dagenGedekt(dek, '2026-03-20', '2026-04-10'), 'toekomst');
  assert.equal(T.dagenGedekt(dek, '2026-03-10', '2026-03-20'), 'ok');
});

test('kern: sleutels ≥ 5 tekens met een cijfer, als heel stuk; SEPA-vulsel telt niet', () => {
  assert.equal(T.sleutelVan('2026-17'), '202617');
  assert.equal(T.sleutelVan('12-3'), null);
  assert.equal(T.sleutelVan('NOTPROVIDED'), null);
  assert.equal(T.sleutelVan('ABCDEF'), null);
  const s = T.stukkenVan({ omschrijving: 'Order 7012X445566 webshop', kenmerk: null });
  assert.equal(T.noemt(s, '445566'), false);
  assert.equal(T.noemt(T.stukkenVan({ omschrijving: 'Factuurnummer 2026-00917', kenmerk: null }), '20260091'), false);
  assert.equal(T.noemt(T.stukkenVan({ omschrijving: 'betaling 1234 5678 9012 3456', kenmerk: null }), '1234567890123456'), true);
});

// ───────────────────────────── opslag, rechten, alleen lezen ─────────────────────────────

test('momentopname en reken.sqlite: map 700, bestand 600, sha256 als naam; de Facturen-databank verandert niet; opruimen laat de laatste staan', () => {
  const t = opzet();
  jaar(t);
  t.fdb.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const voor = D.sha256(fs.readFileSync(t.pad));
  const r = draai(t);
  t.fdb.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.equal(D.sha256(fs.readFileSync(t.pad)), voor, 'Facturen-databank onveranderd');
  const snap = path.join(t.rk, 'snapshot', r.snapshot + '.sqlite');
  assert.equal(D.sha256(fs.readFileSync(snap)), r.snapshot);
  assert.equal(fs.statSync(t.rk).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(t.rk, 'snapshot')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(snap).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(t.rk, 'reken.sqlite')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(t.rk, 'snapshot', 'f'.repeat(64) + '.sqlite'), 'oud');
  assert.equal(FR.opruim(t.rk, NU).weg, 1);
  assert.ok(fs.existsSync(snap));
  assert.throws(() => FR.snapshotPad(t.rk, 'f'.repeat(64)), /snapshot_ontbreekt/);
  // een verkeerde --dir (een map met andere bestanden) wordt niet aangeraakt
  const vreemd = path.join(t.dir, 'vreemd');
  fs.mkdirSync(vreemd); fs.chmodSync(vreemd, 0o755); fs.writeFileSync(path.join(vreemd, 'iets.txt'), 'x');
  assert.throws(() => draai(t, { dir: vreemd }), /map_onveilig/);
  assert.equal(fs.statSync(vreemd).mode & 0o777, 0o755);
  // bewaren: ouder dan 7 dagen hooguit één momentopname per dag (de laatste run van die dag)
  const db = new DatabaseSync(path.join(t.rk, 'reken.sqlite'));
  const oud = new Date(NU - 10 * 86400000).toISOString();
  const kol = "(soort, entiteit, rekening_label, snapshot_sha256, invoer_vingerafdruk, scope, regels_versie, regels_hash, gestart_op, klaar_op) VALUES ('finance.reconcile', 'tolgaarde', 'x', ?, ?, '{}', 'v', 'h', ?, ?)";
  for (const c of ['a', 'b']) { fs.writeFileSync(path.join(t.rk, 'snapshot', c.repeat(64) + '.sqlite'), c); db.prepare('INSERT INTO reken_run ' + kol).run(c.repeat(64), 'e'.repeat(64), oud, oud); }
  db.close();
  FR.opruim(t.rk, NU);
  assert.ok(!fs.existsSync(path.join(t.rk, 'snapshot', 'a'.repeat(64) + '.sqlite')), 'eerdere van dezelfde dag weg');
  assert.ok(fs.existsSync(path.join(t.rk, 'snapshot', 'b'.repeat(64) + '.sqlite')), 'laatste van die dag blijft');
  assert.ok(fs.existsSync(snap), 'recente blijft');
});

test('laatste(): statustelling, lijst per status en de dekkingsregel; besluit() schrijft alleen in reken.sqlite en telt in de volgende run', () => {
  const t = opzet();
  const j = jaar(t);
  const r = draai(t);
  const s = FR.laatste(t.rk, { entiteit: 'tolgaarde' });
  assert.equal(s.run, r.run);
  assert.equal(s.telling.facturen.per_status.open, 5);
  assert.equal(s.facturen.open.length, 5);
  assert.match(s.dekkingsregel, /^Bank …\d{4} t\/m 31-12-2025, alles gedekt vanaf /);
  assert.match(s.dekkingsregel, /Momentopname \d{1,2}-\d{1,2} \d{2}:\d{2}\.$/);
  // David zegt: de open factuur 3 is betaald met de kostenregel van die maand (verzonnen) → besluit ja
  const open = j.facturen.find((f) => !f.betaald);
  const ref = j.refs[open.i];
  const kosten = new DatabaseSync(t.pad, { readOnly: true }).prepare("SELECT entry_ref FROM bank_transactie WHERE bedrag_centen = -500 ORDER BY boekdatum LIMIT 1 OFFSET 3").get().entry_ref;
  assert.throws(() => FR.besluit(t.rk, { factuur_ref: ref, entry_refs: [kosten], oordeel: 'misschien', wie: 'david', bron: 'Open vragen proef' }, NU), /besluit_ongeldig/);
  FR.besluit(t.rk, { factuur_ref: ref, entry_refs: [kosten], oordeel: 'ja', wie: 'david', bron: 'Open vragen proef' }, NU);
  const r2 = draai(t, { snapshot: r.snapshot });
  const x = lees(t, r2.run);
  assert.equal(x.a.get(ref).laag, 0);
  assert.equal(x.a.get(ref).status, 'deels');
});

test('CLI: node fin-reconcile.js run/stand geeft JSON; een onbekend commando geeft een vaste foutcode zonder inhoud', () => {
  const t = opzet();
  jaar(t);
  const { spawnSync } = require('child_process');
  const env = { PATH: process.env.PATH, HOME: t.dir, TZ: 'Europe/Amsterdam' };
  const a = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'fin-reconcile.js'), 'run', '--dir', t.rk, '--facturen', t.pad], { env, encoding: 'utf8' });
  const ja = JSON.parse(a.stdout);
  assert.equal(ja.ok, true, a.stdout + a.stderr);
  assert.equal(ja.uitkomst, 'antwoord');
  const b = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'fin-reconcile.js'), 'stand', '--dir', t.rk], { env, encoding: 'utf8' });
  assert.equal(JSON.parse(b.stdout).run, ja.run);
  const c = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'fin-reconcile.js'), 'iets'], { env, encoding: 'utf8' });
  assert.equal(c.status, 1);
  assert.equal(JSON.parse(c.stdout).fout, 'onbekend');
});

// ───────────────────────────── 4b: antwoordcontract in Supabase (wv1899) ─────────────────────────────

const CONTRACT_SLEUTELS = {
  top: ['assumptions', 'bronnen', 'code', 'coverage', 'gestart_op', 'klaar_op', 'pod_run', 'rows_matched', 'rows_returned', 'scope', 'sleutel', 'snapshot', 'telling', 'uitkomst', 'versie'],
  scope: ['dekking_tot', 'dekking_van', 'entiteit', 'facturenset', 'peil_van', 'periode_tot', 'periode_van', 'rekening_label'],
  coverage: ['bank_tm', 'dagen_per_status', 'facturen_aanname_tot', 'facturen_aanname_van', 'laatst_gedekt'],
  telling: ['bronnen_zonder_bestand', 'onverklaard', 'per_status', 'storno_paren', 'uitgesloten'],
  bron: ['formaat', 'grootte', 'sha256', 'tot', 'van'],
};
const sleutels = (o) => Object.keys(o).sort();
// elk getal in het contract is een telling (≤ 5000), behalve pod_run en de bestandsgrootte: geen bedrag past erin
function getallen(x, pad, uit) {
  if (typeof x === 'number') uit.push([pad, x]);
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) getallen(v, pad + '.' + k, uit);
  return uit;
}

test('4b contract: alleen de velden van de witte lijst; geen bedragen, IBAN\'s, namen of omschrijvingen; bronbestanden met sha256, grootte en periode', async () => {
  const t = opzet();
  const j = jaar(t);
  const r = draai(t);
  const bankbron = path.join(t.fdb.dir, 'bankbron');
  const d = await FR.registreer(t.rk, null, { bankbron, droog: true, nu: NU });
  assert.equal(d.open, 1);
  const c = d.contracten[0];
  assert.deepEqual(sleutels(c), CONTRACT_SLEUTELS.top);
  assert.deepEqual(sleutels(c.scope), CONTRACT_SLEUTELS.scope);
  assert.deepEqual(sleutels(c.coverage), CONTRACT_SLEUTELS.coverage);
  assert.deepEqual(sleutels(c.telling), CONTRACT_SLEUTELS.telling);
  for (const b of c.bronnen) {
    assert.deepEqual(sleutels(b), CONTRACT_SLEUTELS.bron);
    assert.equal(b.grootte, fs.statSync(path.join(bankbron, b.sha256)).size);
    assert.ok(b.van <= b.tot && /^abn_/.test(b.formaat));
  }
  assert.equal(c.bronnen.length, 12);
  assert.equal(c.telling.bronnen_zonder_bestand, 0);
  assert.equal(c.pod_run, r.run);
  assert.equal(c.rows_matched, 20);
  assert.equal(c.rows_returned, Object.values(c.telling.per_status).reduce((a, b) => a + b, 0));
  assert.match(c.scope.rekening_label, /^…\d{4}$/);
  assert.equal(c.coverage.facturen_aanname_van, j.facturen.map((f) => f.datum).sort()[0]);
  for (const a of c.assumptions) assert.match(a, /^[a-z0-9_+-]+$/);
  const tekst = JSON.stringify(c);
  for (const verboden of [TG, ...Object.values(LEV), 'Leverancier', 'Klant', 'Bank Proef', 'Factuurnummer', 'kosten', 'ontvangst', ...j.facturen.map((f) => fmt(f.incl))])
    assert.ok(!tekst.includes(verboden), 'contract bevat ' + verboden);
  for (const [p, n] of getallen(c, '', [])) if (!/\.(pod_run|grootte)$/.test(p)) assert.ok(Number.isInteger(n) && n >= 0 && n <= 5000, p + ' = ' + n);
  // FV2-status is vrije tekst: alleen bekende codes
  assert.equal(FR.uitgeslotenCode('archief_Jansen BV'), 'archief_overig');
  assert.equal(FR.uitgeslotenCode('app_iets_nieuws'), 'app_overig');
  assert.equal(FR.uitgeslotenCode('app_concept_klaar'), 'app_concept_klaar');
  assert.equal(FR.uitgeslotenCode('genegeerd'), 'genegeerd');
});

test('4b registreer: één keer per run (idempotent), vaste foutcode, hooguit 5 pogingen; een ontbrekend bronbestand gaat niet mee', async () => {
  const t = opzet();
  jaar(t, { zonderBron: [3] });
  const r = draai(t);
  const bankbron = path.join(t.fdb.dir, 'bankbron');
  const gezien = new Set(), aanroepen = [];
  const goed = async (fn, body) => { aanroepen.push([fn, body]); const nieuw = !gezien.has(body.p.sleutel); gezien.add(body.p.sleutel); return { ok: true, nieuw, run_id: 11, query_run_id: 22 }; };
  const a = await FR.registreer(t.rk, goed, { bankbron, nu: NU });
  assert.deepEqual(a, { gezet: 1, al: 0, fouten: [], open: 0 });
  assert.equal(aanroepen[0][0], 'sb_fin_run_zet');
  assert.equal(aanroepen[0][1].p.bronnen.length, 11);
  assert.equal(aanroepen[0][1].p.telling.bronnen_zonder_bestand, 1);
  assert.deepEqual(await FR.registreer(t.rk, goed, { bankbron, nu: NU }), { gezet: 0, al: 0, fouten: [], open: 0 });
  assert.equal(aanroepen.length, 1, 'een geregistreerde run gaat niet nog eens');
  assert.deepEqual(FR.laatste(t.rk, {}).antwoordcontract, { query_run_id: 22 });
  // tweede run: Supabase weigert met een vaste code → bijgehouden, na 5 pogingen niet meer vanzelf
  const r2 = draai(t, { snapshot: r.snapshot });
  assert.deepEqual(FR.laatste(t.rk, {}).antwoordcontract, { nog_niet: true });
  let n = 0;
  const weiger = async () => { n++; return { ok: false, fout: 'scope.entiteit' }; };
  for (let i = 0; i < 5; i++) assert.deepEqual((await FR.registreer(t.rk, weiger, { bankbron, nu: NU })).fouten, [{ run: r2.run, fout: 'scope.entiteit' }]);
  assert.equal((await FR.registreer(t.rk, weiger, { bankbron, nu: NU })).open, 0);
  assert.equal(n, 5);
  assert.deepEqual(FR.laatste(t.rk, {}).antwoordcontract, { fout: 'scope.entiteit' });
  // een fout van de aanroep zelf → alleen de HTTP-code; een vreemd antwoord → antwoord_onbekend
  const r3 = draai(t, { snapshot: r.snapshot });
  assert.deepEqual((await FR.registreer(t.rk, async () => { throw new Error('rpc sb_fin_run_zet http 400 https://x.invalid geheim'); }, { bankbron, nu: NU })).fouten, [{ run: r3.run, fout: 'rpc_http_400' }]);
  assert.deepEqual((await FR.registreer(t.rk, async () => { throw new TypeError('fetch failed'); }, { bankbron, nu: NU })).fouten, [{ run: r3.run, fout: 'rpc_netwerk' }]);
  assert.deepEqual((await FR.registreer(t.rk, async () => ({ ok: false, fout: 'NL91 ABNA 0417 1643 00 / € 1.234,56' }), { bankbron, nu: NU })).fouten, [{ run: r3.run, fout: 'antwoord_onbekend' }]);
  assert.equal((await FR.registreer(t.rk, goed, { bankbron, nu: NU })).gezet, 1);
});

test('4b CLI: registreer --droog geeft het contract zonder te versturen; zonder Supabase-omgeving een vaste foutcode', () => {
  const t = opzet();
  jaar(t);
  draai(t);
  const { spawnSync } = require('child_process');
  const env = { PATH: process.env.PATH, HOME: t.dir, TZ: 'Europe/Amsterdam' };
  const a = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'fin-reconcile.js'), 'registreer', '--droog', '--dir', t.rk, '--facturen', t.pad], { env, encoding: 'utf8' });
  const ja = JSON.parse(a.stdout);
  assert.equal(ja.contracten.length, 1, a.stdout + a.stderr);
  assert.equal(ja.contracten[0].bronnen.length, 12);
  const b = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'fin-reconcile.js'), 'registreer', '--dir', t.rk, '--facturen', t.pad], { env, encoding: 'utf8' });
  assert.equal(b.status, 1);
  assert.equal(JSON.parse(b.stdout).fout, 'geen_supabase');
});
