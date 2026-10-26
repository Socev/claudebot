'use strict';
// Toetsen voor wv944: bankhistorie definitief in Facturen (startdatum, droogloop, bron bewaren, salaris zichtbaar (wv945), aanvullen, FV2-archief) en de
// factuurvalidatie (facturen-validatie.js: profielen, betaling, controles, zoeken; route en Socev-leesroute). Alles verzonnen: IBAN's met
// bankcode TEST, "Leverancier A B.V.", bedragen bedacht. Raakt /opt/data/facturen, de kluis, mail en de vault niet (alles in TMPDIR).
const test = require('node:test');
const assert = require('node:assert/strict');
// Prestatiegrenzen gelden voor de pod; een CI-runner is trager en wisselt (wv1044: 3115–3882 ms tegen een grens van 3 s in de
// runs 239–253). build.yml zet TOETS_TIJDFACTOR=3; lokaal blijft de grens zoals hij is. Een kwadratische uitschieter valt er nog steeds uit.
const TIJDFACTOR = Math.max(1, Number(process.env.TOETS_TIJDFACTOR) || 1);
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'facturen-db.js'));
const K = require(path.join(ROOT, 'facturen-kern.js'));
const B = require(path.join(ROOT, 'facturen-bank.js'));
const V = require(path.join(ROOT, 'facturen-validatie.js'));
const F = require(path.join(ROOT, 'facturen.js'));
const { maakIban } = require(path.join(ROOT, 'test', 'facturen-zaad.js'));
const { ibanFromAbnAccount } = require(path.join(ROOT, 'mt940-lezer.js'));

const NU = Date.parse('2026-10-22T12:30:00Z');
const START = '2026-10-01';
const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });

const ACC_TG = '0000000041', ACC_PR = '0000000049';
const TG = ibanFromAbnAccount(ACC_TG), PR = ibanFromAbnAccount(ACC_PR);
const KM = maakIban('NL', 'TEST', '0000000046');
const LEV = { A: maakIban('NL', 'TEST', '0000000101'), C: maakIban('NL', 'TEST', '0000000103'), C2: maakIban('NL', 'TEST', '0000000113'),
  P: maakIban('NL', 'TEST', '0000000201'), Q: maakIban('NL', 'TEST', '0000000202') };

function opzet(o) {
  o = o || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-val-'));
  WEG.push(dir);
  const fdb = D.open(path.join(dir, 'db'));
  D.transactie(fdb, () => {
    for (const [s, n] of [['tolgaarde', 'Huisartsenpraktijk Proef B.V.'], ['kostenmaatschap', 'Maatschap Proef'], ['prive', 'Privé'], ['pot', 'POT Proef']])
      D.voegToe(fdb, 'entiteit', { sleutel: s, naam: n });
    D.voegToe(fdb, 'rekening', { id: D.nieuwId(), entiteit: 'tolgaarde', iban: TG, bank: 'ABN', bank_formaat: 'abn_tab', controle: 1, alleen_eigenaar: 0 });
    D.voegToe(fdb, 'rekening', { id: D.nieuwId(), entiteit: 'prive', iban: PR, bank: 'ABN', bank_formaat: 'abn_tab', controle: 0, alleen_eigenaar: 1 });
    D.voegToe(fdb, 'rekening', { id: D.nieuwId(), entiteit: 'kostenmaatschap', iban: KM, bank: 'ING', bank_formaat: 'ing_csv', controle: 1, alleen_eigenaar: 0 });
    D.voegToe(fdb, 'rekening', { id: D.nieuwId(), entiteit: 'pot', iban: maakIban('NL', 'TEST', '0000000045'), bank: 'ABN', bank_formaat: 'bankluis', bankluis_rek: 'proef-pot', controle: 1, alleen_eigenaar: 1 });
    D.voegToe(fdb, 'gebruiker', { id: D.nieuwId(), email: 'pm@voorbeeld.invalid', naam: 'PM', ingang: 'fac', rol: 'praktijkmanager', actief: 1 });
  });
  const g = fdb.db.prepare("SELECT id FROM gebruiker WHERE ingang = 'fac'").get();
  fdb.db.prepare("INSERT INTO gebruiker_entiteit (gebruiker, entiteit) VALUES (?, 'tolgaarde')").run(g.id);
  if (o.start !== false) D.metaZet(fdb, 'startdatum', o.start || START);
  const eig = F.rolVoor(fdb, { ingang: 'app', wie: 'david (proef)' });
  const pm = F.rolVoor(fdb, { ingang: 'fac', email: 'pm@voorbeeld.invalid' });
  const n = (sql, p) => Number(fdb.db.prepare(sql).get(...(p || [])).n);
  return { dir, fdb, eig, pm, n };
}
const fmt = (c) => { const a = Math.abs(c), s = Math.floor(a / 100) + ',' + String(a % 100).padStart(2, '0'); return (c < 0 ? '-' : '') + s; };
// ABN-TAB met een lopend saldo (oudste eerst); r = [datum JJJJMMDD, bedrag in centen, omschrijving, acct?]
function tab(rijen, beginCenten, o) {
  o = o || {};
  let saldo = beginCenten == null ? 1000000 : beginCenten;
  return rijen.map(([dat, c, desc, acct]) => {
    const b = saldo, e = saldo + c; saldo = e;
    const begin = o.saldoFout && o.saldoFout === dat ? b + 1 : b;
    return [acct || ACC_TG, 'EUR', dat, fmt(begin), fmt(e), dat, fmt(c), desc].join('\t');
  }).join('\n') + '\n';
}
const ov = (iban, naam, remi) => '/TRTP/SEPA OVERBOEKING/IBAN/' + iban + '/BIC/TESTNL2A/NAME/' + naam + '/REMI/' + remi + '/EREF/NOTPROVIDED';
const inc = (iban, naam, remi, csid, marf) => '/TRTP/SEPA Incasso algemeen doorlopend/CSID/' + (csid || 'NL00ZZZTEST0000000301') + '/NAME/' + naam + '/MARF/' + (marf || 'MTEST001') +
  '/REMI/' + remi + '/IBAN/' + iban + '/BIC/TESTNL2A/EREF/' + remi.replace(/\s/g, '');
const hist = (t, bytes, naam, extra) => F.verwerkBankbestand(t.fdb, t.eig, Buffer.from(bytes), naam || 'export.tab', NU, Object.assign({ modus: 'historisch', herkomst: 'toets' }, extra || {}));

test('Triodos-CSV (wv1299) historisch via verwerkBankbestand: bank TRIODOS en formaat triodos_csv in de database, Privé weg, saldo per rekening, tweede keer al bekend', () => {
  const t = opzet();
  const SEL = maakIban('NL', 'TRIO', '0000000041'), SELP = maakIban('NL', 'TRIO', '0000000042'), PRT = maakIban('NL', 'TRIO', '0000000049');
  D.transactie(t.fdb, () => {
    D.voegToe(t.fdb, 'entiteit', { sleutel: 'sel', naam: 'Stichting Proef' });
    D.voegToe(t.fdb, 'rekening', { id: D.nieuwId(), entiteit: 'sel', iban: SEL, bank: 'TRIODOS', bank_formaat: 'triodos_csv', controle: 1, alleen_eigenaar: 0 });
    D.voegToe(t.fdb, 'rekening', { id: D.nieuwId(), entiteit: 'sel', iban: SELP, bank: 'TRIODOS', bank_formaat: 'triodos_csv', controle: 1, alleen_eigenaar: 0 });
    D.voegToe(t.fdb, 'rekening', { id: D.nieuwId(), entiteit: 'prive', iban: PRT, bank: 'TRIODOS', bank_formaat: 'triodos_csv', controle: 0, alleen_eigenaar: 1 });
  });
  const r = (d, e, b, dc, n, tp, c, o, s) => [d, e, b, dc, n, tp, c, o, s].map((x) => '"' + x + '"').join(',');
  const csv = [
    r('03-01-2020', SEL, '250,00', 'Credit', 'Leverancier A B.V.', 'TESTNL2A ' + LEV.A, 'ET', 'terugbetaling', '250,00'),
    r('04-01-2020', PRT, '10,00', 'Debet', 'Winkel', 'TESTNL2A ' + LEV.P, 'ET', 'privé', '-10,00'),
    r('05-01-2020', SELP, '100,00', 'Credit', 'Stichting Proef', 'TESTNL2A ' + SEL, 'ET', 'sparen', '100,00'),
    r('05-01-2020', SEL, '100,00', 'Debet', 'Stichting Proef', 'TESTNL2A ' + SELP, 'ET', 'sparen', '150,00'),
    r('06-01-2020', SEL, '12,10', 'Debet', 'Leverancier C B.V.', 'TESTNL2A ' + LEV.C, 'EI', 'NL00ZZZTEST0000000301 2020 1', '137,90'),
    r('02-10-2026', SEL, '5,00', 'Debet', '', '', 'KN', 'Kosten', '132,90'),
  ].join('\r\n') + '\r\n';
  const u = hist(t, csv, 'mutations.csv');
  assert.equal(u.formaat, 'triodos_csv');
  assert.equal(u.nieuw, 5); assert.equal(u.prive_weggegooid, 1); assert.equal(u.archief, 4);
  for (const x of Object.values(u.saldo)) assert.equal(x.sluit, true, JSON.stringify(u.saldo));
  const bb = t.fdb.db.prepare('SELECT formaat, bank, modus, aantal, periode_van, periode_tot FROM bank_bestand').get();
  assert.deepEqual(Object.assign({}, bb), { formaat: 'triodos_csv', bank: 'TRIODOS', modus: 'historisch', aantal: 5, periode_van: '2020-01-03', periode_tot: '2026-10-02' });
  assert.equal(t.n("SELECT count(*) AS n FROM bank_transactie WHERE formaat = 'triodos_csv' AND entiteit = 'sel'"), 5);
  assert.equal(t.n('SELECT count(*) AS n FROM bank_transactie WHERE eigen_iban = ?', [PRT]), 0);
  assert.equal(t.n("SELECT count(*) AS n FROM bank_transactie WHERE is_incasso = 1 AND incassant_id = 'NL00ZZZTEST0000000301'"), 1);
  assert.equal(t.n("SELECT count(*) AS n FROM bank_transactie WHERE formaat = 'triodos_csv' AND boekdatum < ? AND alleen_eigenaar = 1", [START]), 4);
  const twee = hist(t, csv, 'mutations.csv');
  assert.equal(twee.al_bekend, true); assert.equal(twee.nieuw, 0);
  // dezelfde mutaties in een nieuwe export (LF, andere bytes): niets nieuw
  const drie = hist(t, csv.replace(/\r\n/g, '\n'), 'mutations2.csv');
  assert.equal(drie.nieuw, 0); assert.equal(drie.al_bekend_regels, 5);
  D.sluit(t.fdb);
});

// ───────────────────────────── parser: saldocontrole ─────────────────────────────

test('saldocontrole: ABN-TAB sluit (ook nieuwste eerst), een gat is een breuk maar geen weigering; ING met en zonder saldokolom', () => {
  const rek = [{ iban: TG, entiteit: 'tolgaarde', bank_formaat: 'abn_tab', controle: 1 }, { iban: KM, entiteit: 'kostenmaatschap', bank_formaat: 'ing_csv', controle: 1 }];
  const t1 = tab([['20250105', -1000, ov(LEV.A, 'Leverancier A B.V.', 'f1')], ['20250106', -2000, ov(LEV.A, 'Leverancier A B.V.', 'f2')], ['20250107', 5000, ov(LEV.A, 'Leverancier A B.V.', 'terug')]], 50000);
  let r = B.leesBankbestand(t1, { rekeningen: rek });
  assert.equal(r.ok, true);
  assert.deepEqual(r.saldo[TG], { gecontroleerd: true, sluit: true, breuken: 0, regels: 3, begin_centen: 50000, eind_centen: 52000 });
  assert.deepEqual(r.periode, { van: '2025-01-05', tot: '2025-01-07' });
  const omgekeerd = t1.trim().split('\n').reverse().join('\n') + '\n';
  r = B.leesBankbestand(omgekeerd, { rekeningen: rek });
  assert.equal(r.saldo[TG].sluit, true, 'nieuwste eerst sluit ook');
  assert.equal(r.saldo[TG].begin_centen, 50000);
  // regel weg uit het midden: keten breekt (één breuk), bestand wordt niet geweigerd
  const gat = t1.trim().split('\n').filter((_, i) => i !== 1).join('\n') + '\n';
  r = B.leesBankbestand(gat, { rekeningen: rek });
  assert.equal(r.ok, true);
  assert.equal(r.saldo[TG].sluit, false);
  assert.equal(r.saldo[TG].breuken, 1);
  // ING nieuwste eerst met saldo
  const kop = '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen";"Saldo na mutatie";"Tag"';
  const rij = (d, af, b, s) => ['"' + d + '"', '"Leverancier A B.V."', '"' + KM + '"', '"' + LEV.A + '"', '"OV"', '"' + af + '"', '"' + b + '"', '"Overschrijving"', '"x"', '"' + s + '"', '""'].join(';');
  const ing = kop + '\r\n' + [rij('20250110', 'Af', '10,00', '80,00'), rij('20250109', 'Bij', '50,00', '90,00'), rij('20250108', 'Af', '60,00', '40,00')].join('\r\n') + '\r\n';
  r = B.leesBankbestand(ing, { rekeningen: rek });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.saldo[KM], { gecontroleerd: true, sluit: true, breuken: 0, regels: 3, begin_centen: 10000, eind_centen: 8000 });
  const zonder = ing.replace(/"80,00"|"90,00"|"40,00"/g, '""');
  r = B.leesBankbestand(zonder, { rekeningen: rek });
  assert.equal(r.saldo[KM].gecontroleerd, false);
  // entry_ref verandert niet door de saldocontrole (zelfde als vóór wv944: alleen saldo_na in de hash)
  const ref = B.mkRef([TG, '2025-01-05', -10, '490,00', 'f1', LEV.A]);
  assert.equal(B.leesBankbestand(t1, { rekeningen: rek }).transacties[0].entry_ref, ref);
});

// ───────────────────────────── historische invoer ─────────────────────────────

test('historie: zonder startdatum geweigerd; met startdatum archief zonder signalen, na de start wél signalen; bron bewaard; Privé weg', () => {
  const t0 = opzet({ start: false });
  assert.throws(() => hist(t0, tab([['20250105', -1000, ov(LEV.A, 'Leverancier A B.V.', 'f1')]])), (e) => e.status === 409);
  assert.equal(t0.n('SELECT count(*) n FROM bank_bestand'), 0);
  // praktijkmanager mag geen historie inlezen
  const t = opzet();
  assert.throws(() => F.verwerkBankbestand(t.fdb, t.pm, Buffer.from(tab([['20250105', -1000, ov(LEV.A, 'Leverancier A B.V.', 'f1')]])), 'x.tab', NU, { modus: 'historisch' }),
    (e) => e.status === 403);
  const bytes = tab([
    ['20250105', -1000, ov(LEV.A, 'Leverancier A B.V.', 'oud 1')],
    ['20260905', -1500, ov(LEV.A, 'Leverancier A B.V.', 'oud 2')],
    ['20260910', -700, ov(LEV.A, 'Iets privé', 'privé'), ACC_PR],
    ['20261005', -2500, ov(LEV.A, 'Leverancier A B.V.', 'na de start')],
  ]);
  const u = hist(t, bytes);
  assert.equal(u.nieuw, 3);
  assert.equal(u.archief, 2);
  assert.equal(u.prive_weggegooid, 1);
  assert.equal(u.bron_bewaard, true);
  assert.equal(u.modus, 'historisch');
  assert.deepEqual(u.periode, { van: '2025-01-05', tot: '2026-10-05' });
  const sha = D.sha256(Buffer.from(bytes));
  assert.ok(D.bronBestaat(t.fdb, sha), 'ruwe bestand in bankbron/');
  assert.equal((fs.statSync(D.bronPad(t.fdb, sha)).mode & 0o777).toString(8), '600');
  assert.equal((fs.statSync(path.dirname(D.bronPad(t.fdb, sha))).mode & 0o777).toString(8), '700');
  const bb = t.fdb.db.prepare('SELECT * FROM bank_bestand').get();
  assert.equal(bb.modus, 'historisch'); assert.equal(bb.bank, 'ABN'); assert.equal(bb.bron_bewaard, 1); assert.equal(bb.herkomst, 'toets');
  assert.equal(bb.periode_van, '2025-01-05');
  assert.ok(JSON.parse(bb.saldo)[TG], 'saldo per rekening');
  // historie alleen-eigenaar, na de start niet
  assert.equal(t.n("SELECT count(*) n FROM bank_transactie WHERE boekdatum < ? AND alleen_eigenaar = 1", [START]), 2);
  assert.equal(t.n("SELECT count(*) n FROM bank_transactie WHERE boekdatum >= ? AND alleen_eigenaar = 0", [START]), 1);
  // signalen: alleen voor de regel na de start (geen factuur, > 7 dagen oud); niets voor de historie
  const sig = t.fdb.db.prepare('SELECT soort, transacties FROM signaal').all();
  assert.equal(sig.length, 1, JSON.stringify(sig));
  assert.equal(sig[0].soort, 'geen_factuur');
  assert.equal(u.controle.historie_stil, 1, 'oud 2 (binnen 400 dagen, vóór de start) zou zonder startdatum een signaal geven');
  // dezelfde bytes nog eens: al bekend, niets nieuws
  const v = hist(t, bytes);
  assert.equal(v.al_bekend, true); assert.equal(v.nieuw, 0);
  // een overlappend bestand (zelfde regels + één nieuwe): alleen de nieuwe erbij — dubbel inladen = 0 nieuw
  const meer = tab([
    ['20250105', -1000, ov(LEV.A, 'Leverancier A B.V.', 'oud 1')],
    ['20260905', -1500, ov(LEV.A, 'Leverancier A B.V.', 'oud 2')],
  ]) + tab([['20250301', -300, ov(LEV.A, 'Leverancier A B.V.', 'oud 3')]], 1000000 - 2500);
  const w = hist(t, meer, 'meer.tab');
  assert.equal(w.nieuw, 1); assert.equal(w.al_bekend_regels, 2); assert.equal(w.check.mogelijk_dubbel, 0);
  assert.equal(t.n('SELECT count(*) n FROM bank_transactie'), 4);
  // App-upload zonder modus: dezelfde regels stapelen ook niet
  const x = F.verwerkBankbestand(t.fdb, t.eig, Buffer.from(meer + tab([['20250302', -1, 'BEA, Betaalpas x']], 0)), 'app.tab', NU);
  assert.equal(x.nieuw, 1);
});

test('droogloop: dezelfde posten onder een andere entry_ref (ander saldo) worden vóór de start geweigerd tot forceer; droog schrijft niets', () => {
  const t = opzet();
  const a = tab([['20250105', -1000, ov(LEV.A, 'Leverancier A B.V.', 'f1')], ['20250106', -2000, ov(LEV.A, 'Leverancier A B.V.', 'f2')], ['20250107', -3000, ov(LEV.A, 'Leverancier A B.V.', 'f3')]], 500000);
  hist(t, a);
  // zelfde posten, ander beginsaldo → andere entry_ref (saldo_na zit in de hash): mogelijk dubbel
  const b = tab([['20250105', -1000, ov(LEV.A, 'Leverancier A B.V.', 'f1')], ['20250106', -2000, ov(LEV.A, 'Leverancier A B.V.', 'f2')], ['20250107', -3000, ov(LEV.A, 'Leverancier A B.V.', 'f3')]], 700000);
  const droog = hist(t, b, 'b.tab', { droog: true });
  assert.equal(droog.droog, true);
  assert.equal(droog.check.mogelijk_dubbel, 3);
  assert.equal(droog.check.boven_drempel, true);
  assert.equal(t.n('SELECT count(*) n FROM bank_bestand'), 1, 'droog schrijft geen bestand');
  assert.equal(D.bronBestaat(t.fdb, D.sha256(Buffer.from(b))), false, 'droog bewaart geen bron');
  let fout = null;
  try { hist(t, b, 'b.tab'); } catch (e) { fout = e; }
  assert.ok(fout && fout.status === 409 && fout.extra && fout.extra.code === 'mogelijk_dubbel', String(fout && fout.fout));
  assert.equal(t.n('SELECT count(*) n FROM bank_transactie'), 3);
  assert.equal(D.bronBestaat(t.fdb, D.sha256(Buffer.from(b))), false, 'geweigerd: geen wees in bankbron/ (diffreview #3)');
  const f = hist(t, b, 'b.tab', { forceer: true });
  assert.equal(f.nieuw, 3);
  assert.equal(t.fdb.db.prepare("SELECT na FROM audit WHERE wat = 'bankbestand_historisch' ORDER BY wanneer DESC, rowid DESC LIMIT 1").get().na.includes('"geforceerd":true'), true);
  // zonder startdatum: gewone App-upload, geen droogloop-weigering (gedrag van vóór wv944; diffreview #2)
  const t3 = opzet({ start: false });
  F.verwerkBankbestand(t3.fdb, t3.eig, Buffer.from(a), 'a.tab', NU);
  const z = F.verwerkBankbestand(t3.fdb, t3.eig, Buffer.from(b), 'b.tab', NU);
  assert.equal(z.nieuw, 3); assert.equal(z.check.mogelijk_dubbel, 0);
  // praktijkmanager-upload: ruwe bestand niet bewaard (F2-belofte voor de smalle ingang; diffreview #13)
  const t4 = opzet({ start: false });
  const pmBytes = tab([['20261012', -100, ov(LEV.A, 'Leverancier A B.V.', 'pm')]]);
  const pmu = F.verwerkBankbestand(t4.fdb, t4.pm, Buffer.from(pmBytes), 'pm.tab', NU);
  assert.equal(pmu.nieuw, 1); assert.equal(pmu.bron_bewaard, false);
  assert.equal(D.bronBestaat(t4.fdb, D.sha256(Buffer.from(pmBytes))), false);
  // suffix: twee identieke posten in A (ref X en X-1); B bevat er maar één → basis telt 1 in B en 2 in de database
  const t2 = opzet();
  const regel = [acc => [acc, 'EUR', '20250110', '100,00', '90,00', '20250110', '-10,00', 'BEA, Betaalpas x'].join('\t')];
  hist(t2, regel[0](ACC_TG) + '\n' + regel[0](ACC_TG) + '\n');
  const een = hist(t2, regel[0](ACC_TG) + '\n' + [ACC_TG, 'EUR', '20250111', '90,00', '80,00', '20250111', '-10,00', 'BEA, Betaalpas y'].join('\t') + '\n', 'een.tab', { droog: true });
  assert.equal(een.check.suffix_verschil, 1);
  assert.equal(een.check.al_bekend, 1);
});

test('koppelen (wv951): dezelfde post onder een andere sleutel één-op-één gekoppeld, niet dubbel; incassant aangevuld; na de start nooit', () => {
  const t = opzet();
  // "FV2": vier posten, waarvan twee identiek op dezelfde dag; andere sleutel dan het nieuwe bestand (ander beginsaldo)
  const a = tab([['20250105', -1000, ov(LEV.A, 'Leverancier A B.V.', 'f1')], ['20250106', -2000, ov(LEV.A, 'Leverancier A B.V.', 'f2')],
    ['20250107', -500, ov(LEV.A, 'Leverancier A B.V.', 'dag')], ['20250107', -500, ov(LEV.A, 'Leverancier A B.V.', 'dag')]], 500000);
  hist(t, a);
  // een bestaande regel na de start onder een andere sleutel: wordt nooit gekoppeld
  F.verwerkBankbestand(t.fdb, t.eig, Buffer.from(tab([['20261005', -1000, ov(LEV.A, 'Leverancier A B.V.', 'f1')]], 300000)), 'na.tab', NU);
  t.fdb.db.prepare('UPDATE bank_transactie SET incassant_id = NULL, machtiging = NULL').run();
  // één kant zonder IBAN (ABN-incasso in de TAB-export): dan telt de naam
  t.fdb.db.prepare("UPDATE bank_transactie SET tegenpartij_iban = NULL WHERE boekdatum = '2025-01-06'").run();
  // nieuw bestand: f1 als incasso (krijgt incassant), f2, drie keer "dag" (één meer dan in de database), één echt nieuwe post, één na de start
  const b = tab([['20250105', -1000, inc(LEV.A, 'Leverancier A B.V.', 'f1')], ['20250106', -2000, ov(LEV.A, 'Leverancier A B.V.', 'f2')],
    ['20250107', -500, ov(LEV.A, 'Leverancier A B.V.', 'dag')], ['20250107', -500, ov(LEV.A, 'Leverancier A B.V.', 'dag')], ['20250107', -500, ov(LEV.A, 'Leverancier A B.V.', 'dag')],
    ['20250201', -700, ov(LEV.A, 'Leverancier A B.V.', 'nieuw')], ['20261005', -1000, ov(LEV.A, 'Leverancier A B.V.', 'f1')]], 700000);
  const zonder = hist(t, b, 'b.tab', { droog: true });
  assert.equal(zonder.check.mogelijk_dubbel, 5);
  assert.equal(zonder.check.boven_drempel, true);
  assert.equal(zonder.check.te_koppelen, undefined, 'zonder --koppel geen koppeling');
  const droog = hist(t, b, 'b.tab', { droog: true, koppel: true });
  assert.equal(droog.check.te_koppelen, 4);
  assert.equal(droog.check.boven_drempel, false, '5 mogelijk dubbel, 4 gekoppeld: 1 rest onder de drempel van 2');
  assert.equal(t.n('SELECT count(*) n FROM bank_transactie'), 5, 'droog schrijft niets');
  // --koppel in een gewone upload doet niets
  assert.equal(F.verwerkBankbestand(t.fdb, t.eig, Buffer.from(b), 'b.tab', NU, { koppel: true, droog: true }).check.te_koppelen, undefined);
  const u = hist(t, b, 'b.tab', { koppel: true });
  assert.equal(u.gekoppeld, 4);
  assert.equal(u.nieuw, 3, 'derde "dag", de nieuwe post en de post na de start');
  assert.equal(u.al_bekend_regels, 0);
  assert.equal(u.aangevuld, 1);
  assert.equal(t.n('SELECT count(*) n FROM bank_transactie'), 8);
  assert.equal(t.n("SELECT count(*) n FROM bank_transactie WHERE boekdatum = '2025-01-07'"), 3);
  assert.equal(t.n("SELECT count(*) n FROM bank_transactie WHERE boekdatum = '2025-01-05' AND incassant_id = 'NL00ZZZTEST0000000301' AND machtiging = 'MTEST001'"), 1);
  assert.equal(t.n("SELECT count(*) n FROM bank_transactie WHERE boekdatum = '2025-01-05'"), 1);
  assert.equal(t.n("SELECT count(*) n FROM bank_transactie WHERE boekdatum = '2026-10-05'"), 2, 'na de start nooit gekoppeld (de bestaande regel op die dag blijft, de nieuwe komt erbij)');
  const au = JSON.parse(t.fdb.db.prepare("SELECT na FROM audit WHERE wat = 'bankbestand_historisch' ORDER BY wanneer DESC, rowid DESC LIMIT 1").get().na);
  assert.equal(au.gekoppeld, 4); assert.equal(au.sleutels.length, 4);
  // de gekoppelde regels dragen nu de sleutel van het bestand
  const refsB = B.leesBankbestand(b, { rekeningen: t.fdb.db.prepare('SELECT iban, entiteit, bank_formaat, controle, alleen_eigenaar FROM rekening').all() }).transacties.map((x) => x.entry_ref);
  assert.equal(t.n('SELECT count(*) n FROM bank_transactie WHERE entry_ref IN (' + refsB.map(() => '?').join(',') + ')', refsB), 7);
  // nog eens: al bekend
  assert.equal(hist(t, b, 'b.tab', { koppel: true }).al_bekend, true);
  // een ander bestand met dezelfde posten (andere bytes) zonder --koppel, en als App-upload: alles al bekend, niets dubbel (review wv951 #1)
  const b2 = b + tab([['20250301', -100, ov(LEV.A, 'Leverancier A B.V.', 'nog een')]], 100000);
  const w2 = hist(t, b2, 'b2.tab');
  assert.equal(w2.nieuw, 1); assert.equal(w2.check.mogelijk_dubbel, 0); assert.equal(w2.al_bekend_regels, 7);
  assert.equal(F.verwerkBankbestand(t.fdb, t.eig, Buffer.from(b2 + tab([['20250302', -1, 'BEA, Betaalpas x']], 0)), 'app.tab', NU).nieuw, 1);
  assert.equal(t.n('SELECT count(*) n FROM bank_transactie'), 10, '8 + de nieuwe post uit b2 + de BEA-regel uit de App-upload');
  // een bestaande regel die zelf in het bestand staat wordt nooit gekoppeld (die is al gedekt): A opnieuw plus een kopie van f1 met ander saldo
  const t2 = opzet();
  hist(t2, a);
  const c = a + tab([['20250105', -1000, ov(LEV.A, 'Leverancier A B.V.', 'f1')]], 900000);
  const v = hist(t2, c, 'c.tab', { koppel: true });
  assert.equal(v.gekoppeld, 0); assert.equal(v.nieuw, 1);
  // twee incasso's op één dag, zelfde incassant en bedrag, elk een eigen machtiging; de database heeft ze zonder: koppelen, niet aanvullen
  const t3 = opzet();
  hist(t3, tab([['20250110', -900, ov(LEV.A, 'Leverancier A B.V.', 'abo')], ['20250110', -900, ov(LEV.A, 'Leverancier A B.V.', 'abo')]], 400000));
  const d = tab([['20250110', -900, inc(LEV.A, 'Leverancier A B.V.', 'abo een', null, 'M-EEN')], ['20250110', -900, inc(LEV.A, 'Leverancier A B.V.', 'abo twee', null, 'M-TWEE')]], 800000);
  const dd = hist(t3, d, 'd.tab', { koppel: true, droog: true });
  assert.equal(dd.check.te_koppelen, 2); assert.equal(dd.check.onbeslist, 2);
  const vd = hist(t3, d, 'd.tab', { koppel: true });
  assert.equal(vd.gekoppeld, 2); assert.equal(vd.aangevuld, 0); assert.equal(vd.nieuw, 0);
  assert.equal(t3.n('SELECT count(*) n FROM bank_transactie WHERE machtiging IS NOT NULL'), 0);
  // na koppelen nog boven de drempel: geweigerd, niets veranderd
  const t4 = opzet();
  hist(t4, tab([['20250105', -1000, ov(LEV.A, 'Leverancier A B.V.', 'x1')], ['20250106', -2000, ov(LEV.A, 'Leverancier A B.V.', 'x2')], ['20250107', -3000, ov(LEV.A, 'Leverancier A B.V.', 'x3')]], 500000));
  const e = tab([['20250105', -1000, ov(LEV.A, 'Leverancier A B.V.', 'x1')], ['20250106', -2000, ov(LEV.A, 'Leverancier A B.V.', 'x2')], ['20250107', -3000, ov(LEV.A, 'Leverancier A B.V.', 'x3')]], 600000)
    + tab([['20250105', -1000, ov(LEV.A, 'Leverancier A B.V.', 'x1b')], ['20250106', -2000, ov(LEV.A, 'Leverancier A B.V.', 'x2b')], ['20250107', -3000, ov(LEV.A, 'Leverancier A B.V.', 'x3b')]], 700000);
  let fout = null;
  try { hist(t4, e, 'e.tab', { koppel: true }); } catch (x) { fout = x; }
  assert.ok(fout && fout.status === 409 && fout.extra.check.te_koppelen === 3, String(fout && fout.fout));
  assert.equal(t4.n('SELECT count(*) n FROM bank_transactie'), 3);
});

test('salaris (wv945): salarisregels op een praktijkrekening zijn gewone regels, zichtbaar voor eigenaar, praktijkmanager en Socev; historie en POT blijven alleen-eigenaar', () => {
  const t = opzet();
  const u = hist(t, tab([
    ['20250125', -250000, ov(LEV.P, 'J. Proef', 'Salaris januari')],
    ['20261010', -260000, ov(LEV.P, 'J. Proef', 'Salaris oktober')],
    ['20261012', -4500, ov(LEV.P, 'J. Proef', 'declaratie parkeren')],
    ['20261011', -1200, ov(LEV.A, 'Leverancier A B.V.', 'salarisadministratie oktober')],
  ]));
  assert.equal(u.nieuw, 4);
  assert.equal(u.personeel, undefined, 'geen personeelsteller meer');
  const ae = (remi) => t.fdb.db.prepare("SELECT alleen_eigenaar a FROM bank_transactie WHERE omschrijving LIKE ?").get('%' + remi + '%').a;
  assert.equal(ae('Salaris oktober'), 0, 'salaris na de start is een gewone regel');
  assert.equal(ae('declaratie parkeren'), 0, 'zelfde IBAN als een salarisregel: ook gewoon');
  assert.equal(ae('salarisadministratie'), 0);
  assert.equal(ae('Salaris januari'), 1, 'historie (vóór de start) blijft alleen-eigenaar, zoals elke historische regel');
  // categorie loon zegt niets over zichtbaarheid; een tweede upload met nog een loonregel: ook gewoon
  t.fdb.db.prepare("UPDATE bank_transactie SET categorie = 'loon' WHERE omschrijving = 'Salaris oktober'").run();
  hist(t, tab([['20261020', -10000, ov(LEV.Q, 'K. Proef', 'netto loon oktober')]], 500000), 'twee.tab');
  assert.equal(ae('netto loon'), 0);
  assert.equal(ae('Salaris oktober'), 0, 'een volgende upload zet niets terug op alleen-eigenaar');
  // POT: een regel op de POT-rekening (alleen-eigenaar via de rekening) — praktijkmanager ziet hem nooit
  const pot = t.fdb.db.prepare("SELECT id, iban FROM rekening WHERE entiteit = 'pot'").get();
  t.fdb.db.prepare('INSERT INTO bank_transactie (id, rekening, entiteit, eigen_iban, boekdatum, bedrag_centen, valuta, tegenpartij_iban, tegenpartij_naam, omschrijving, ' +
    "entry_ref, formaat, bankluis_sleutel, alleen_eigenaar, aangemaakt_op) VALUES (?, ?, 'pot', ?, '2026-10-15', -310000, 'EUR', ?, 'J. Proef', 'Salaris POT oktober', ?, 'bankluis', 'proef-pot-1', 1, '2026-10-15T10:00:00Z')")
    .run(D.nieuwId(), pot.id, pot.iban, LEV.P, 'b'.repeat(20));
  // eigenaar ziet alles na de start + historie
  const eig = F.validatie(t.fdb, t.eig, { soort: 'zoek', tekst: 'salaris' }, NU);
  assert.deepEqual(eig.regels.map((r) => r.omschrijving).sort(), ['Salaris POT oktober', 'Salaris januari', 'Salaris oktober', 'salarisadministratie oktober']);
  // praktijkmanager (Tolgaarde): salaris op de praktijkrekening wél, historie en POT niet
  const pmz = F.validatie(t.fdb, t.pm, { soort: 'zoek', tekst: 'salaris' }, NU);
  assert.deepEqual(pmz.regels.map((r) => r.omschrijving).sort(), ['Salaris oktober', 'salarisadministratie oktober']);
  const pmall = F.validatie(t.fdb, t.pm, { soort: 'zoek' }, NU);
  assert.ok(!pmall.regels.some((r) => r.entiteit === 'pot' || r.entiteit === 'prive'), 'geen POT of Privé voor de praktijkmanager');
  assert.equal(pmall.aantal, 4, 'oktober-salaris, declaratie, salarisadministratie, netto loon');
  const pmt = F.validatie(t.fdb, t.pm, { soort: 'tegenpartij', tekst: 'j. proef' }, NU);
  assert.equal(pmt.profielen.length, 1);
  assert.equal(pmt.profielen[0].aantal, 2, 'alleen de twee praktijkregels na de start');
  // Socev-leesroute: salarisregels gewoon mee (ook zonder machinekamer-sleutel), geen personeel-veld meer
  const routes = F.maak({ fout: () => {} });
  const z = routes.lees(t.fdb, { opdracht: 'zoek', tekst: 'loon' }, { nu: NU });
  assert.equal(z.status, 200);
  assert.equal(z.j.personeel, undefined);
  assert.deepEqual(z.j.regels.map((r) => r.omschrijving), ['netto loon oktober']);
  assert.equal(routes.lees(t.fdb, { opdracht: 'zoek', tekst: 'salaris' }, { nu: NU }).j.aantal, 4);
  // App-route (POST /app/facturen/validatie): dezelfde zichtbaarheid per rol
  const call = (rol) => routes.app(t.fdb, { methode: 'POST', pad: '/app/facturen/validatie', d: { soort: 'zoek', tekst: 'salaris' }, rol, primair: true, nu: NU });
  const ae_ = call(t.eig), ap_ = call(t.pm);
  assert.equal(ae_.status, 200); assert.equal(ap_.status, 200, JSON.stringify(ap_.j));
  assert.ok(ae_.j.regels.some((r) => r.omschrijving === 'Salaris oktober') && ae_.j.regels.some((r) => r.omschrijving === 'Salaris POT oktober'));
  assert.ok(ap_.j.regels.some((r) => r.omschrijving === 'Salaris oktober'), 'praktijkmanager ziet het salaris op de praktijkrekening');
  assert.ok(!ap_.j.regels.some((r) => r.entiteit === 'pot' || r.entiteit === 'prive'), 'praktijkmanager ziet de POT niet');
  assert.throws(() => t.fdb.db.prepare('UPDATE bank_transactie SET alleen_eigenaar = 0').run(), /transactie_eigenaar/, 'historie en POT blijven alleen-eigenaar');
  assert.equal(routes.lees(null, { opdracht: 'zoek' }, {}).status, 409, 'passieve kant');
  assert.equal(routes.lees(t.fdb, { opdracht: 'wis' }, {}).status, 400);
});

test('aanvullen: een archiefregel zonder incassant krijgt hem uit een latere export (zelfde entry_ref), nooit overschreven', () => {
  const t = opzet();
  const bytes = tab([['20250302', -8412, inc(LEV.C, 'Leverancier C B.V.', 'Termijn maart')]], 300000);
  const rek = t.fdb.db.prepare('SELECT iban, entiteit, bank_formaat, controle, alleen_eigenaar FROM rekening').all();
  const ref = B.leesBankbestand(bytes, { rekeningen: rek }).transacties[0];
  const a = F.archiefInvoeren(t.fdb, t.eig, { entiteit: 'tolgaarde', regels: [{ entry_ref: ref.entry_ref, boekdatum: '2025-03-02', bedrag: -84.12, tegenpartij_iban: LEV.C,
    tegenpartij_naam: 'Leverancier C B.V.', omschrijving: 'Termijn maart', transactietype: 'ABN:SEPA Incasso algemeen doorlopend', is_incasso: true }], facturen: [],
  bestand_op: '2026-07-23T00:00:00.000Z' }, NU);
  assert.equal(a.nieuw, 1);
  const voor = t.fdb.db.prepare('SELECT incassant_id, machtiging, bestand_op FROM bank_transactie').get();
  assert.equal(voor.incassant_id, null); assert.equal(voor.bestand_op, '2026-07-23T00:00:00.000Z');
  const u = hist(t, bytes);
  assert.equal(u.nieuw, 0); assert.equal(u.aangevuld, 1);
  const na = t.fdb.db.prepare('SELECT incassant_id, machtiging, omschrijving FROM bank_transactie').get();
  assert.equal(na.incassant_id, 'NL00ZZZTEST0000000301'); assert.equal(na.machtiging, 'MTEST001');
  assert.equal(na.omschrijving, 'Termijn maart', 'archieftekst blijft');
});

test('FV2-archief: alleen zakelijk buiten de bankkoppeling, alleen-eigenaar, facturen als velden, tweede keer al bekend', () => {
  const t = opzet();
  assert.throws(() => F.archiefInvoeren(t.fdb, t.eig, { entiteit: 'pot', regels: [{ entry_ref: 'c'.repeat(20), boekdatum: '2025-01-01', bedrag: -1 }] }, NU), (e) => e.status === 400);
  const potF = F.archiefInvoeren(t.fdb, t.eig, { entiteit: 'pot', regels: [], facturen: [{ extern_id: 'pot-1', leverancier_naam: 'Leverancier G', bedrag_incl: 10 }] }, NU);
  assert.equal(potF.facturen, 1); assert.equal(potF.bestand, null, 'POT: alleen facturen, geen bankbestand');
  assert.throws(() => F.archiefInvoeren(t.fdb, t.eig, { entiteit: 'prive', regels: [] }, NU), (e) => e.status === 400);
  assert.throws(() => F.archiefInvoeren(t.fdb, t.pm, { entiteit: 'tolgaarde', regels: [] }, NU), (e) => e.status === 403);
  const t0 = opzet({ start: false });
  assert.throws(() => F.archiefInvoeren(t0.fdb, t0.eig, { entiteit: 'tolgaarde', regels: [] }, NU), (e) => e.status === 409);
  const inv = { entiteit: 'kostenmaatschap', bestand_op: '2026-07-23T00:00:00.000Z', regels: [
    { entry_ref: 'a'.repeat(20), boekdatum: '2025-04-01', bedrag: '-121.00', tegenpartij_iban: LEV.A, tegenpartij_naam: 'Leverancier A B.V.', omschrijving: 'x'.repeat(400), betalingskenmerk: 'VB20250401', transactietype: 'ING:OV:Overschrijving', is_incasso: false },
    { entry_ref: 'b'.repeat(20) + '-1', boekdatum: '2025-04-02', bedrag: -5, tegenpartij_naam: 'Kosten', transactietype: 'ING:DV:Diversen' },
    { entry_ref: 'niet-goed', boekdatum: '2025-04-03', bedrag: -1 },
  ], facturen: [{ extern_id: '11111111-2222-3333-4444-555555555555', leverancier_naam: 'Leverancier A B.V.', factuurnummer: 'VB-2025-0401', factuurdatum: '2025-03-25',
    vervaldatum: '2025-04-08', bedrag_incl: '121.00', valuta: 'EUR', iban_begunstigde: LEV.A, betalingskenmerk: 'VB20250401', betaalwijze: 'zelf', status: 'verstuurd' }] };
  const a = F.archiefInvoeren(t.fdb, t.eig, inv, NU);
  assert.equal(a.nieuw, 2); assert.equal(a.overgeslagen, 1); assert.equal(a.facturen, 1);
  const r = t.fdb.db.prepare("SELECT * FROM bank_transactie WHERE entry_ref = ?").get('a'.repeat(20));
  assert.equal(r.bedrag_centen, -12100); assert.equal(r.alleen_eigenaar, 1); assert.equal(r.omschrijving.length, 200); assert.equal(r.formaat, 'ing_csv');
  assert.equal(t.fdb.db.prepare("SELECT modus FROM bank_bestand").get().modus, 'archief_fv2');
  assert.equal(t.n('SELECT count(*) n FROM signaal'), 0, 'archief geeft geen signalen');
  const b = F.archiefInvoeren(t.fdb, t.eig, inv, NU);
  assert.equal(b.al_bekend, true);
  // de archieffactuur is betaald (kenmerk), dat ziet de validatie
  const fa = t.fdb.db.prepare("SELECT id FROM factuur_archief WHERE extern_id LIKE '1111%'").get();
  const v = F.validatie(t.fdb, t.eig, { soort: 'factuur', id: fa.id }, NU);
  assert.equal(v.betaling.betaald, true); assert.equal(v.betaling.zekerheid, 'hoog'); assert.equal(v.betaling.wanneer, '2025-04-01');
  assert.equal(v.betaling.hoe, 'overboeking'); assert.equal(v.betaling.bedrag_centen, 12100);
  assert.equal(F.validatie(t.fdb, t.pm, { soort: 'zoek' }, NU).aantal, 0, 'praktijkmanager: geen archief');
  assert.throws(() => F.validatie(t.fdb, t.pm, { soort: 'factuur', id: fa.id }, NU), (e) => e.status === 404);
});

// ───────────────────────────── validatie (puur) ─────────────────────────────

// Drie leveranciers, met de hand nagerekend:
//  C: incasso elke maand op de 2e, 12× € 84,12 (jan–dec 2025), dan okt 2026 € 120,00 → maand, incasso, gebruikelijk 8412, afwijkend +43 %
//  A: overboeking per kwartaal € 1.210,00 (4×), plus op 2026-10-06 en 2026-10-09 twee keer € 99,00 → dubbele betaling
//  E: jaarlijks € 500,00 (2023, 2024, 2025) via iDEAL → jaar
function proefTxs() {
  const tx = [];
  let n = 0;
  const zet = (o) => tx.push(Object.assign({ id: 'tx' + String(++n).padStart(4, '0'), entiteit: 'tolgaarde', eigen_iban: TG, is_incasso: false, alleen_eigenaar: false }, o));
  for (let m = 1; m <= 12; m++) zet({ boekdatum: '2025-' + String(m).padStart(2, '0') + '-02', bedrag_centen: -8412, tegenpartij_iban: LEV.C, tegenpartij_naam: 'Leverancier C B.V.',
    is_incasso: true, incassant_id: 'NL00ZZZTEST0000000301', machtiging: 'MTEST001', transactietype: 'ABN:SEPA Incasso algemeen doorlopend', omschrijving: 'Termijn ' + m });
  zet({ boekdatum: '2026-10-02', bedrag_centen: -12000, tegenpartij_iban: LEV.C, tegenpartij_naam: 'Leverancier C B.V.', is_incasso: true, incassant_id: 'NL00ZZZTEST0000000301',
    machtiging: 'MTEST001', transactietype: 'ABN:SEPA Incasso algemeen doorlopend', omschrijving: 'Termijn oktober' });
  for (const d of ['2025-01-15', '2025-04-15', '2025-07-15', '2025-10-15']) zet({ boekdatum: d, bedrag_centen: -121000, tegenpartij_iban: LEV.A, tegenpartij_naam: 'Leverancier A B.V.',
    transactietype: 'ABN:SEPA Overboeking', omschrijving: 'Factuur kwartaal', kenmerk: 'K' + d.replace(/-/g, '') });
  zet({ boekdatum: '2026-10-06', bedrag_centen: -9900, tegenpartij_iban: LEV.A, tegenpartij_naam: 'Leverancier A B.V.', transactietype: 'ABN:SEPA Overboeking', omschrijving: 'Factuur VB-77' });
  zet({ boekdatum: '2026-10-09', bedrag_centen: -9900, tegenpartij_iban: LEV.A, tegenpartij_naam: 'Leverancier A B.V.', transactietype: 'ABN:SEPA Overboeking', omschrijving: 'Factuur VB-77' });
  for (const j of ['2023', '2024', '2025']) zet({ boekdatum: j + '-03-01', bedrag_centen: -50000, tegenpartij_iban: maakIban('NL', 'TEST', '0000000105'), tegenpartij_naam: 'Leverancier E',
    transactietype: 'ABN:SEPA iDEAL', omschrijving: 'Lidmaatschap ' + j });
  // nieuwe IBAN bij een bekende naam (C, ander IBAN, recent)
  zet({ boekdatum: '2026-10-15', bedrag_centen: -8412, tegenpartij_iban: LEV.C2, tegenpartij_naam: 'Leverancier C B.V.', transactietype: 'ABN:SEPA Overboeking', omschrijving: 'Termijn' });
  // een inkomst (telt niet in de afschrijvingsprofielen)
  zet({ boekdatum: '2025-05-05', bedrag_centen: 100000, tegenpartij_iban: maakIban('NL', 'TEST', '0000000900'), tegenpartij_naam: 'Zorgverzekeraar Voorbeeld', omschrijving: 'declaratie' });
  return tx;
}

test('profielen: drie leveranciers met de hand nagerekend (betaalwijze, frequentie, gebruikelijk bedrag, eerste/laatste, per jaar)', () => {
  const p = V.profielen(proefTxs());
  const c = p.get('iban:' + LEV.C), a = p.get('iban:' + LEV.A), e = p.get('iban:' + maakIban('NL', 'TEST', '0000000105'));
  // C: 13 betalingen, 12 × 8412 + 12000 = 100944 + 12000 = 112944; mediaan 8412; jan 2025 – okt 2026
  assert.equal(c.aantal, 13); assert.equal(c.totaal_centen, 112944); assert.equal(c.gebruikelijk_centen, 8412);
  assert.equal(c.betaalwijze, 'incasso'); assert.equal(c.betaalwijze_aandeel, 1); assert.equal(c.frequentie.soort, 'maand');
  assert.equal(c.eerste, '2025-01-02'); assert.equal(c.laatste, '2026-10-02'); assert.equal(c.min_centen, 8412); assert.equal(c.max_centen, 12000);
  assert.deepEqual(c.per_jaar, { 2025: { aantal: 12, totaal_centen: 100944 }, 2026: { aantal: 1, totaal_centen: 12000 } });
  assert.deepEqual(c.incassant_ids, ['NL00ZZZTEST0000000301']);
  // A: 4 × 121000 + 2 × 9900 = 484000 + 19800 = 503800; mediaan van [121000×4, 9900×2] = (121000+121000)/2 = 121000
  assert.equal(a.aantal, 6); assert.equal(a.totaal_centen, 503800); assert.equal(a.gebruikelijk_centen, 121000); assert.equal(a.betaalwijze, 'overboeking');
  // tussenpozen A: 90, 91, 92, 356, 3 → mediaan 91 → kwartaal, maar 2 van de 5 wijken af → onregelmatig
  assert.equal(a.frequentie.interval_dagen, 91); assert.equal(a.frequentie.soort, 'onregelmatig');
  // E: jaarlijks, iDEAL, 3 × 50000
  assert.equal(e.aantal, 3); assert.equal(e.totaal_centen, 150000); assert.equal(e.betaalwijze, 'ideal'); assert.equal(e.frequentie.soort, 'jaar');
  assert.equal(p.has('iban:' + maakIban('NL', 'TEST', '0000000900')), false, 'inkomsten niet in de afschrijvingsprofielen');
});

test('controles: afwijkend bedrag, dubbele betaling, nieuwe IBAN, incasso zonder factuur (alleen gedekt), factuur zonder betaling', () => {
  const tx = proefTxs();
  const facturen = [
    { id: 'f1', herkomst: 'facturen', entiteit: 'tolgaarde', leverancier_naam: 'Leverancier A B.V.', nummer: 'VB-77', incl: 9900, iban: LEV.A, factuurdatum: '2026-10-01', vervaldatum: '2026-10-15' },
    { id: 'f2', herkomst: 'facturen', entiteit: 'tolgaarde', leverancier_naam: 'Leverancier B B.V.', nummer: 'B-1', incl: 5000, iban: maakIban('NL', 'TEST', '0000000102'), factuurdatum: '2026-09-01', vervaldatum: '2026-09-15' },
  ];
  for (const f of facturen) f.betaling = V.betalingVan(f, tx, {});
  assert.equal(facturen[0].betaling.betaald, true);
  assert.equal(facturen[1].betaling.betaald, false);
  const c = V.controles({ vandaag: '2026-10-22', transacties: tx, facturen, dekking: [{ van: '2026-10-01', tot: null }] });
  // C okt 2026: 12000 tegen mediaan 8412 → +3588 > max(500, 1682) → afwijkend, (12000−8412)/8412 = 42,65 % → 43
  // A: tussenpozen 90, 91, 92, 356 → mediaan 92, 3 van 4 binnen → kwartaal; de € 99,00 van 9-10 wijkt af van 121000 → ook afwijkend
  assert.equal(c.afwijkend_bedrag.length, 2);
  const ca = c.afwijkend_bedrag.find((x) => x.naam === 'Leverancier C B.V.');
  assert.equal(ca.bedrag_centen, 12000); assert.equal(ca.gebruikelijk_centen, 8412); assert.equal(ca.verschil_pct, 43); assert.equal(ca.frequentie, 'maand');
  const aa = c.afwijkend_bedrag.find((x) => x.naam === 'Leverancier A B.V.');
  assert.equal(aa.datum, '2026-10-09'); assert.equal(aa.frequentie, 'kwartaal');
  assert.equal(c.dubbele_betalingen.length, 1);
  assert.deepEqual(c.dubbele_betalingen[0].datums, ['2026-10-06', '2026-10-09']); assert.equal(c.dubbele_betalingen[0].bedrag_centen, 9900);
  assert.equal(c.nieuwe_iban.length, 1); assert.equal(c.nieuwe_iban[0].iban_nieuw, LEV.C2); assert.equal(c.nieuwe_iban[0].alleen_eigenaar, true);
  // incasso C 2026-10-02 valt in de dekking en hoort bij geen factuur; de 12 uit 2025 vallen buiten de dekking
  assert.equal(c.incasso_zonder_factuur.length, 1); assert.equal(c.incasso_zonder_factuur[0].aantal, 1); assert.equal(c.incasso_zonder_factuur[0].totaal_centen, 12000);
  // f2: vervaldatum 15-9 + 14 = 29-9 voorbij, bank loopt tot 15-10 → zonder betaling
  assert.deepEqual(c.facturen_zonder_betaling.map((x) => x.factuur), ['f2']);
  // zonder dekking geen incasso-oordeel
  assert.equal(V.controles({ vandaag: '2026-10-22', transacties: tx, facturen, dekking: [] }).incasso_zonder_factuur.length, 0);
});

test('betalingVan: kenmerk, IBAN + bedrag, incasso van de leverancier, gekoppeld; niets gevonden', () => {
  const tx = proefTxs();
  const b1 = V.betalingVan({ entiteit: 'tolgaarde', kenmerk: 'K20250415', incl: 121000, factuurdatum: '2025-04-01' }, tx);
  assert.equal(b1.betaald, true); assert.equal(b1.zekerheid, 'hoog'); assert.equal(b1.wanneer, '2025-04-15');
  const b2 = V.betalingVan({ entiteit: 'tolgaarde', incl: 8412, factuurdatum: '2025-06-25', incassant_ids: ['NL00ZZZTEST0000000301'] }, tx);
  assert.equal(b2.betaald, true); assert.equal(b2.hoe, 'incasso'); assert.equal(b2.wanneer, '2025-07-02', 'dichtst bij de factuurdatum');
  const b3 = V.betalingVan({ entiteit: 'tolgaarde', incl: 50000, iban: maakIban('NL', 'TEST', '0000000105'), factuurdatum: '2024-02-20' }, tx);
  assert.equal(b3.wanneer, '2024-03-01'); assert.equal(b3.hoe, 'ideal');
  const b4 = V.betalingVan({ entiteit: 'tolgaarde', incl: 77700, iban: LEV.A, factuurdatum: '2025-02-01' }, tx);
  assert.equal(b4.betaald, false);
  const b5 = V.betalingVan({ entiteit: 'tolgaarde', incl: 1 }, tx, { koppelingen: ['tx0001'] });
  assert.equal(b5.zekerheid, 'vast');
  assert.equal(V.betalingVan({ entiteit: 'kostenmaatschap', kenmerk: 'K20250415', incl: 121000 }, tx).betaald, false, 'andere entiteit');
});

test('zoeken: tekst, IBAN, periode, richting, totalen per jaar; "kpn" is geen IBAN', () => {
  const tx = proefTxs();
  const z = V.zoek(tx, { tekst: 'leverancier c', sinds: '2025-06-01' });
  assert.equal(z.aantal, 9);   // jul–dec 2025 (7: jun t/m dec) … nagerekend: jun, jul, aug, sep, okt, nov, dec = 7 + okt 2026 + nieuwe IBAN 15-10 = 9
  assert.equal(z.totaal_af_centen, 7 * 8412 + 12000 + 8412);
  assert.equal(z.regels[0].boekdatum, '2026-10-15', 'nieuwste eerst');
  assert.equal(V.zoek(tx, { tekst: LEV.A }).aantal, 6);
  assert.equal(V.zoek(tx, { tekst: 'kpn' }).aantal, 0);
  assert.equal(V.zoek(tx, { richting: 'bij' }).aantal, 1);
  assert.equal(V.zoek(tx, { max: 2 }).regels.length, 2);
});

test('routes: GET/POST validatie voor de eigenaar; praktijkmanager ziet geen historie of nieuwe IBAN; route-id past', () => {
  const t = opzet();
  hist(t, tab([['20250102', -8412, inc(LEV.C, 'Leverancier C B.V.', 'Termijn jan')], ['20261015', -500, ov(LEV.A, 'Leverancier A B.V.', 'na start')]]));
  const routes = F.maak({ fout: () => {} });
  const call = (methode, rest, d, rol) => routes.app(t.fdb, { methode, pad: '/app/facturen/' + rest, d: d || {}, rol: rol || t.eig, primair: true, nu: NU });
  const g = call('GET', 'validatie');
  assert.equal(g.status, 200, JSON.stringify(g.j));
  assert.equal(g.j.bank.regels, 2); assert.equal(g.j.startdatum, START);
  const p = call('POST', 'validatie', { soort: 'tegenpartij', tekst: 'leverancier c' });
  assert.equal(p.status, 200); assert.equal(p.j.profielen[0].betaalwijze, 'incasso');
  assert.equal(call('POST', 'validatie', { soort: 'onzin' }).status, 400);
  const pg = call('GET', 'validatie', {}, t.pm);
  assert.equal(pg.status, 200); assert.equal(pg.j.bank.regels, 1, 'alleen de regel na de start'); assert.equal(pg.j.facturen.archief, 0);
  assert.deepEqual(pg.j.controles.nieuwe_iban, []);
  assert.ok(F.ROUTES.GET.includes('validatie') && F.ROUTES.POST.includes('validatie'));
});

// Prestaties (diffreview #1; wv1225: ook los van de snelheid van de runner). Drie toetsen op één meting:
// 1. absoluut: 1.500 facturen × 30.000 regels onder 3 s (× TOETS_TIJDFACTOR op CI);
// 2. schaal: twee keer zoveel regels kost hooguit 3,2× zoveel tijd (lineair ± 2–2,5×; een kwadratische uitschieter ± 4×);
// 3. ijkwerk: het overzicht kost hooguit 3× de kale doorloop die betalingVan minstens moet doen (filter op entiteit, venster als tekst en
//    bedrag, drie keer per factuur) op dezelfde runner en dezelfde gegevens. Een constante vertraging (Date-objecten in venster() maakte
//    het ± 10× trager) verandert de schaalverhouding niet, maar deze wel. Bij 2 en 3 telt de trage van twee metingen in de noemer, zodat
//    een drukke runner de toets niet rood maakt.
function prestatieGegevens(nTx) {
  const tx = [], fs_ = [];
  for (let i = 0; i < nTx; i++) {
    const d = K.plusDagen('2024-01-01', i % 900);
    tx.push({ id: 'x' + i, entiteit: i % 2 ? 'tolgaarde' : 'groenhouten', boekdatum: d, bedrag_centen: -(1000 + (i % 97) * 10), tegenpartij_iban: maakIban('NL', 'TEST', String(1000 + (i % 400)).padStart(10, '0')),
      tegenpartij_naam: 'Leverancier ' + (i % 400), is_incasso: i % 3 === 0, incassant_id: i % 3 === 0 ? 'NL00ZZZ' + (i % 400) : null, omschrijving: 'factuur ' + i });
  }
  for (let j = 0; j < 1500; j++) fs_.push({ id: 'f' + j, entiteit: j % 2 ? 'tolgaarde' : 'groenhouten', nummer: 'N' + j, incl: 1000 + (j % 97) * 10,
    iban: maakIban('NL', 'TEST', String(1000 + (j % 400)).padStart(10, '0')), factuurdatum: K.plusDagen('2024-01-01', j % 900) });
  return { tx, fs_ };
}
function msVan(f) { const t0 = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - t0) / 1e6; }
function overzichtMs({ tx, fs_ }) {
  return msVan(() => {
    for (const f of fs_) f.betaling = V.betalingVan(f, tx, {});
    V.controles({ vandaag: '2026-10-22', transacties: tx, facturen: fs_, dekking: [] });
    V.profielen(tx);
  });
}
function ijkMs({ tx, fs_ }) {
  let n = 0;
  const ms = msVan(() => {
    for (const f of fs_) {
      const van = K.plusDagen(f.factuurdatum, -45), tot = K.plusDagen(f.factuurdatum, 120);
      for (let r = 0; r < 3; r++) n += tx.filter((t) => t.entiteit === f.entiteit && t.bedrag_centen < 0 && t.boekdatum >= van && t.boekdatum <= tot && Math.abs(t.bedrag_centen) === f.incl).length;
    }
  });
  assert.ok(n > 0, 'ijkwerk vond niets (gegevens veranderd?)');
  return ms;
}

test('prestaties: overzicht met 1.500 facturen en 30.000 regels blijft onder 3 s, schaalt lineair en blijft dicht bij het ijkwerk (diffreview #1, wv1225)', (t) => {
  const vol = prestatieGegevens(30000), half = prestatieGegevens(15000);
  overzichtMs(prestatieGegevens(1500));   // opwarmen
  const ijk1 = ijkMs(half), half1 = overzichtMs(half);
  const ms = overzichtMs(vol);
  const half2 = overzichtMs(half), ijk2 = ijkMs(half);
  const meting = 'vol ' + Math.round(ms) + ' ms, half ' + Math.round(half1) + '/' + Math.round(half2) + ' ms, ijk ' + Math.round(ijk1) + '/' + Math.round(ijk2) + ' ms';
  t.diagnostic(meting);   // in de CI-log: hoe ver de runner van de grenzen zit
  assert.ok(ms < 3000 * TIJDFACTOR, 'duurde ' + Math.round(ms) + ' ms (grens ' + 3000 * TIJDFACTOR + ' ms; ' + meting + ')');
  const schaal = ms / Math.max(half1, half2), ijk = Math.min(half1, half2) / Math.max(ijk1, ijk2);
  assert.ok(schaal < 3.2, 'dubbel zoveel regels kost ' + schaal.toFixed(2) + '× zoveel tijd (grens 3,2; ' + meting + ')');
  assert.ok(ijk < 3, 'overzicht kost ' + ijk.toFixed(2) + '× het ijkwerk (grens 3; ' + meting + ')');
});

test('wv1317 bedragpatroon: band = 10e–90e percentiel plus de laatste drie (indexatie hoort erbij), uitschieter erbuiten; < 3 betalingen geen patroon', () => {
  const huur = [];
  const maand = (i) => { const d = new Date(Date.UTC(2025, 10 + i, 27)); return d.toISOString().slice(0, 10); };
  for (let i = 0; i < 11; i++) huur.push({ id: 'h' + i, boekdatum: maand(i), bedrag_centen: -(i < 3 ? 825996 : i < 9 ? 833655 : 852221) });
  huur.push({ id: 'los', boekdatum: '2026-01-22', bedrag_centen: -212647 });   // losse naheffing: valt buiten de band
  const p = V.bedragPatroon(huur, '2026-10-26', 852221);
  assert.equal(p.aantal, 12);
  assert.equal(p.laag_centen, 825996); assert.equal(p.hoog_centen, 852221);
  assert.equal(p.oordeel, 'binnen');
  assert.equal(V.bedragPatroon(huur, '2026-10-26', 1000000).oordeel, 'boven');
  assert.equal(V.bedragPatroon(huur, '2026-10-26', 300000).oordeel, 'onder');
  assert.equal(V.bedragPatroon(huur, '2026-10-26', null).oordeel, null);
  // de regel zelf telt niet mee; ouder dan 12 maanden en bijschrijvingen tellen niet
  assert.equal(V.bedragPatroon(huur, '2026-10-26', 852221, { zonder: 'h10' }).aantal, 11);
  assert.equal(V.bedragPatroon([{ id: 'a', boekdatum: '2024-01-01', bedrag_centen: -100 }, { id: 'b', boekdatum: '2026-10-01', bedrag_centen: -100 }, { id: 'c', boekdatum: '2026-10-02', bedrag_centen: 100 }], '2026-10-26', 100), null);
  assert.equal(V.bedragPatroon(huur, 'gisteren', 1), null);
});

test('wv1323: ibanHistorie en naamVerwant — ≥ 3 afschrijvingen met een naam over ≥ 60 dagen, steeds dezelfde (verwante) naam', () => {
  const t = (d, naam, o) => Object.assign({ boekdatum: d, bedrag_centen: -1000, tegenpartij_naam: naam, entiteit: 'tolgaarde' }, o || {});
  // verwant: rechtsvorm, leestekens, afkorting binnen de naam, voorletters + achternaam
  for (const [a, b] of [['Mediq Nederland B.V.', 'Mediq'], ['A.M.C. Roskott', 'AMC Roskott'], ["Lot's Waarneming", 'Lots Waarneming'], ['LvN', 'LvN Huisartswaarneming'],
    ['M. den Uijl', 'Marijke den Uijl'], ['M. Volman', 'Mattijs Volman Waarnemend Huisarts'], ['Qli Chef', 'Qlichef']]) assert.equal(V.naamVerwant(a, b), true, a + ' ~ ' + b);
  for (const [a, b] of [['Xebia', 'G-company B.V.'], ['Aurore Salaris', 'Actasynergia'], ['T. van Riessen', 'Tim Mobiel Waarnemen'], ['M. Volman', 'Peter Volman'],
    ['AB', 'AB Groep'], ['', 'Iets'], [null, null], ['Stichting Pensioen', 'Stichting Bewaarder']]) assert.equal(V.naamVerwant(a, b), false, a + ' ≁ ' + b);
  const ok = V.ibanHistorie([t('2026-01-05', 'Mediq Nederland B.V.'), t('2026-03-10', 'Mediq'), t('2026-02-02', 'Mediq Nederland B.V.', { entiteit: 'groenhouten' }),
    t('2026-04-01', 'Mediq', { bedrag_centen: 500 }), t('2026-04-02', 'Mediq', { verwijderd_op: 'x' })]);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.aantal, 3); assert.equal(ok.eerste, '2026-01-05'); assert.equal(ok.laatste, '2026-03-10'); assert.equal(ok.dagen, 64);
  assert.equal(ok.naam, 'Mediq Nederland B.V.'); assert.deepEqual(ok.entiteiten, ['groenhouten', 'tolgaarde']);
  assert.deepEqual(ok.namen, [{ naam: 'Mediq Nederland B.V.', aantal: 2 }, { naam: 'Mediq', aantal: 1 }]);
  assert.equal(V.ibanHistorie([t('2026-01-01', 'X Proef'), t('2026-03-15', 'X Proef')]).reden, 'minder dan 3 betalingen');
  assert.equal(V.ibanHistorie([t('2026-01-01', 'X Proef'), t('2026-02-01', 'X Proef'), t('2026-02-28', 'X Proef')]).reden, 'korter dan 60 dagen');
  assert.equal(V.ibanHistorie([t('2026-01-01', 'X Proef'), t('2026-02-01', 'Y Anders'), t('2026-03-15', 'X Proef')]).reden, 'verschillende namen');
  // zonder naam telt een betaling niet; alleen bijschrijvingen: niets
  assert.equal(V.ibanHistorie([t('2026-01-01', null), t('2026-02-01', 'X Proef'), t('2026-03-15', 'X Proef')]).ok, false);
  assert.equal(V.ibanHistorie([t('2026-01-01', 'X', { bedrag_centen: 1 })]).aantal, 0);
  assert.equal(V.ibanHistorie([t('2026-01-01', 'X Proef'), t('2026-01-31', 'X Proef'), t('2026-03-02', 'X Proef')]).ok, true, 'precies 60 dagen telt');
  // verzamelrekeningen (betaaldienst, derdengelden): nooit
  for (const n of ['Stichting Mollie Payments', 'St. Beheer Derdengelden Notaris', 'Webwinkel via Adyen', 'PAY.NL'])
    assert.equal(V.ibanHistorie([t('2026-01-01', n), t('2026-02-01', n), t('2026-03-15', n)]).reden, 'verzamelrekening (betaaldienst of derdengelden)', n);
  assert.equal(V.vollereNaam('Gemeente', 'Gemeente Leusden'), 'Gemeente Leusden');
  assert.equal(V.vollereNaam('Mattijs Volman', 'M. Volman'), 'Mattijs Volman');
  assert.equal(V.vollereNaam('Mediq Nederland B.V.', 'MEDIQ'), 'Mediq Nederland B.V.');
  assert.equal(V.vollereNaam(null, 'Bank Naam'), 'Bank Naam');
});

// ───────────────────────────── ABN-historie-CSV (wv1329) ─────────────────────────────

const HKOP = 'Mutatie-ID;Rekening;Boekdatum;Rentedatum;Bedrag;Af Bij;Type;Tegenrekening;BIC;Naam;Omschrijving;Kenmerk;Betalingskenmerk;Incassant;Machtiging;Volledige omschrijving;Saldo na mutatie;Afschrift datum;Afschrift volgnr;Pagina;Bronbestand';
// r = [datum JJJJ-MM-DD, bedrag in centen, tegen-IBAN, naam, omschrijving, rentedatum?]; oudste eerst, lopend saldo, CRLF en BOM zoals de echte bestanden
function hcsv(rijen, beginCenten, o) {
  o = o || {};
  let saldo = beginCenten == null ? 1000000 : beginCenten;
  const per = {};
  return '﻿' + HKOP + '\r\n' + rijen.map(([d, c, tegen, naam, oms, rd], i) => {
    saldo += c;
    const afs = d.slice(0, 4) + '-' + d.slice(5, 7).padStart(3, '0');
    per[afs] = (per[afs] || 0) + 1;
    const id = (o.rek || TG) + '-' + afs + '-' + String(per[afs]).padStart(3, '0');
    return [id, o.rek || TG, d, rd || d, fmt(c), c < 0 ? 'Af' : 'Bij', 'SEPA Overboeking', tegen || '', tegen ? 'TESTNL2A' : '', naam || '', oms || '', '', '', '', '',
      'SEPA Overboeking | IBAN: ' + (tegen || '') + ' | Naam: ' + (naam || '') + ' | Omschrijving: ' + (oms || ''), fmt(saldo), d, afs, '1', 'proef.pdf'].join(';');
  }).join('\r\n') + '\r\n';
}

test('ABN-historie (wv1329): herkend, opgeslagen als abn_tab, overlap met TAB afgedekt zonder de TAB-sleutels te raken; tweede keer al bekend; TAB opnieuw niets dubbel', () => {
  const t = opzet();
  // de TAB gaf september 2026 al (twee regels, waarvan één zonder tegenpartij zoals een betaalautomaat)
  const tabBytes = tab([['20260905', -1500, ov(LEV.A, 'Leverancier A B.V.', 'f9')], ['20260907', -400, 'BEA, Betaalpas  WINKEL PROEF,PAS123']], 1000000);
  const ut = hist(t, tabBytes, 'sep.tab');
  assert.equal(ut.nieuw, 2);
  const tabRefs = t.fdb.db.prepare('SELECT entry_ref FROM bank_transactie ORDER BY entry_ref').all().map((x) => x.entry_ref);
  // de historie: twee oude regels en dezelfde twee van september (de betaalautomaat hier met een naam)
  const h = hcsv([['2025-01-05', -1000, LEV.A, 'Leverancier A B.V.', 'oud'], ['2025-02-05', 5000, LEV.C, 'Klant C', 'ontvangst'],
    ['2026-09-05', -1500, LEV.A, 'Leverancier A B.V.', 'f9'], ['2026-09-07', -400, '', 'WINKEL PROEF', 'pas']], 1000000 + 1000 - 5000);
  assert.equal(B.herkenFormaat(h), 'abn_historie_csv');
  const droog = hist(t, h, 'h.csv', { droog: true });
  assert.equal(droog.formaat, 'abn_historie_csv');
  assert.deepEqual([droog.check.te_dekken, droog.check.in_venster, droog.check.bestaand_rest, droog.check.boven_drempel], [2, 0, 0, false]);
  assert.equal(droog.saldo['…' + TG.slice(-4)].sluit, true);
  const u = hist(t, h, 'h.csv');
  assert.deepEqual([u.nieuw, u.gedekt, u.archief, u.al_bekend_regels], [2, 2, 2, 0]);
  assert.deepEqual(t.fdb.db.prepare('SELECT entry_ref FROM bank_transactie WHERE entry_ref IN (' + tabRefs.map(() => '?').join(',') + ')').all(...tabRefs).length, 2, 'TAB-sleutels onaangeroerd');
  assert.equal(t.n("SELECT count(*) n FROM bank_transactie WHERE formaat = 'abn_tab'"), 4);
  assert.equal(t.fdb.db.prepare("SELECT formaat FROM bank_bestand WHERE naam = 'h.csv'").get().formaat, 'abn_tab');
  // per (datum, bedrag) gelijk aan het bestand
  assert.deepEqual(t.fdb.db.prepare('SELECT boekdatum, bedrag_centen FROM bank_transactie ORDER BY boekdatum').all().map((x) => x.boekdatum + ':' + x.bedrag_centen),
    ['2025-01-05:-1000', '2025-02-05:5000', '2026-09-05:-1500', '2026-09-07:-400']);
  // zelfde bestand: al bekend; andere regeleinden: dezelfde sleutels, niets nieuw
  assert.equal(hist(t, h, 'h.csv').al_bekend, true);
  const lf = hist(t, h.replace(/\r\n/g, '\n'), 'h-lf.csv');
  assert.deepEqual([lf.nieuw, lf.gedekt, lf.al_bekend_regels], [0, 2, 2]);
  // de TAB later nog eens (andere bytes): niets nieuw
  assert.equal(F.verwerkBankbestand(t.fdb, t.eig, Buffer.from(tabBytes + '\n'), 'sep2.tab', NU, { modus: 'upload' }).nieuw, 0);
  // een historiebestand via de app (upload): geweigerd
  assert.throws(() => F.verwerkBankbestand(t.fdb, t.eig, Buffer.from(h), 'h.csv', NU, { modus: 'upload' }), (e) => e.status === 422 && /machinekamer/.test(e.message));
});

test('ABN-historie (wv1329): sluit het bestand niet op de database (bestaande regel zonder tegenhanger, nieuwe regel binnen de bestaande periode) → 409, niets ingelezen; --forceer wel', () => {
  const t = opzet();
  hist(t, tab([['20260905', -1500, ov(LEV.A, 'Leverancier A B.V.', 'f9')], ['20260906', -700, ov(LEV.A, 'Leverancier A B.V.', 'f10')], ['20260920', -50, ov(LEV.A, 'Leverancier A B.V.', 'f11')]], 1000000), 'sep.tab');
  // het bestand mist de regel van 6-9 (binnen zijn eigen periode); de regel van 20-9 ligt erbuiten en telt niet
  const mist = hcsv([['2025-01-05', -1000, LEV.A, 'Leverancier A B.V.', 'oud'], ['2026-09-05', -1500, LEV.A, 'Leverancier A B.V.', 'f9'], ['2026-09-07', -10, LEV.C, 'Klant C', 'x']], 1001000);
  assert.throws(() => hist(t, mist, 'mist.csv'), (e) => e.status === 409 && /sluiten niet/.test(e.message));
  const dm = hist(t, mist, 'mist.csv', { droog: true });
  assert.deepEqual([dm.check.te_dekken, dm.check.in_venster, dm.check.bestaand_rest], [1, 1, 1]);
  assert.equal(t.n('SELECT count(*) n FROM bank_transactie'), 3);
  const extra = hcsv([['2026-09-05', -1500, LEV.A, 'Leverancier A B.V.', 'f9'], ['2026-09-06', -700, LEV.A, 'Leverancier A B.V.', 'f10'], ['2026-09-06', -33, LEV.C, 'Klant C', 'nieuw']], 1001500);
  const d = hist(t, extra, 'extra.csv', { droog: true });
  assert.deepEqual([d.check.te_dekken, d.check.in_venster, d.check.bestaand_rest, d.check.boven_drempel], [2, 1, 0, true]);
  assert.throws(() => hist(t, extra, 'extra.csv'), (e) => e.status === 409);
  assert.equal(hist(t, extra, 'extra.csv', { forceer: true }).nieuw, 1);
});

test('ABN-historie (wv1329): parser weigert afwijkingen met regelnummer, nooit een waarde', () => {
  const goed = hcsv([['2025-01-05', -1000, LEV.A, 'Leverancier A B.V.', 'oud']]);
  const rek = [{ iban: TG, entiteit: 'tolgaarde', bank_formaat: 'abn_tab', controle: 1 }];
  assert.equal(B.leesBankbestand(goed, { rekeningen: rek }).ok, true);
  const r1 = B.leesBankbestand(goed, { rekeningen: rek }).transacties[0];
  assert.equal(r1.formaat, 'abn_tab'); assert.match(r1.entry_ref, /^[0-9a-f]{20}$/);
  assert.equal(B.leesBankbestand(goed.replace(';Af;', ';Bij;'), { rekeningen: rek }).fout, 'regel_ongeldig');
  assert.equal(B.leesBankbestand(goed.replace('Mutatie-ID;', 'MutatieID;'), { rekeningen: rek }).fout, 'formaat_onbekend');
  const dubbel = goed + goed.split('\r\n')[1] + '\r\n';
  assert.match(B.leesBankbestand(dubbel, { rekeningen: rek }).uitleg, /regel 3: Mutatie-ID dubbel/);
  const g = B.leesBankbestand(goed.replace(';Af;', ';Bij;'), { rekeningen: rek });
  assert.ok(!/1000|10,00|Leverancier/.test(g.uitleg), g.uitleg);
  // rekening met een ander formaat (ING) weigert; een Privé-historie (controle 0) hoort in de bankluis
  assert.equal(B.leesBankbestand(goed, { rekeningen: [{ iban: TG, entiteit: 'tolgaarde', bank_formaat: 'ing_csv', controle: 1 }] }).fout, 'verkeerd_formaat');
  assert.equal(B.leesBankbestand(goed, { rekeningen: [{ iban: TG, entiteit: 'prive', bank_formaat: 'abn_tab', controle: 0 }] }).fout, 'prive_historie');
  // boekdatum = Rentedatum (zoals de TAB)
  assert.equal(B.leesBankbestand(hcsv([['2025-01-05', -1000, LEV.A, 'A', 'x', '2025-01-06']]), { rekeningen: rek }).transacties[0].boekdatum, '2025-01-06');
});

test('review wv1329 #3/#4/#5: historie met gebroken saldoketen → 409 (forceer wel); een abn_mt940-rekening en een Privé-historie worden geweigerd zonder bron', () => {
  const t = opzet();
  const goed = hcsv([['2025-01-05', -1000, LEV.A, 'Leverancier A B.V.', 'a'], ['2025-01-06', -2000, LEV.A, 'Leverancier A B.V.', 'b'], ['2025-01-07', -3000, LEV.A, 'Leverancier A B.V.', 'c']]);
  const regels = goed.split('\r\n');
  regels[2] = regels[2].replace(/;([\d-]+,\d\d);2025-01-06;/, (m, s) => ';' + s.replace(/\d,/, (x) => String((Number(x[0]) + 1) % 10) + ',') + ';2025-01-06;');
  const stuk = regels.join('\r\n');
  assert.notEqual(stuk, goed);
  assert.throws(() => hist(t, stuk, 'stuk.csv'), (e) => e.status === 409 && /saldoketen/.test(e.message));
  assert.equal(t.n('SELECT count(*) n FROM bank_bestand'), 0);
  assert.equal(hist(t, stuk, 'stuk.csv', { forceer: true }).nieuw, 3);
  const mt = [{ iban: TG, entiteit: 'tolgaarde', bank_formaat: 'abn_mt940', controle: 1 }];
  assert.equal(B.leesBankbestand(goed, { rekeningen: mt }).fout, 'verkeerd_formaat');
  const prive = hcsv([['2025-01-05', -1000, LEV.A, 'Winkel', 'x']], 1000000, { rek: PR });
  assert.throws(() => hist(t, prive, 'prive.csv'), (e) => e.status === 422 && /bankluis/.test(e.message));
  assert.ok(!D.bronBestaat(t.fdb, D.sha256(Buffer.from(prive))), 'geen Privé-bron in Facturen');
});
