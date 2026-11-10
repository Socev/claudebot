'use strict';
// ── OVIS GHAWA fase 1 (wv2877, 10-11-2026; plan vault "01_Ontwikkeling/OVIS GHAWA - plan naar een 8 (Fable 5.2, 10-11-2026)" § 3, § 4, § 8) ──
// De cijfers van de bouw van het gezondheidscentrum in Sukuta (ECG) en van Stichting GHAWA op één plek: een eigen databank ghawa.sqlite op
// de pod, één keer gevuld uit de csv's van het overdrachtsbestand (datastand 6-10-2026), en een rekenkern die de regels van dat bestand volgt:
//   - dalasi (GMD) is leidend; euro is een indicatie tegen één koers (instelling indicative_rate_gmd_per_eur);
//   - nog open per begrotingsregel volgens still_open_rule (full budget / budget - realised / none / activity balance / offset / estimate);
//   - "niet meer nodig" en "overschrijding" worden per activiteit verrekend, niet per regel;
//   - geoormerkt geld (fondsen "Received by GHAWA NL" en "Committed - not yet received") telt één keer: wat al bij GHAWA staat gaat
//     van het vrije saldo af;
//   - de bank wint: saldi komen uit de bankregels, niet uit de instellingen (die staan er alleen als vergelijking).
// Alle bedragen in centen (gehele getallen) zodat de som op de cent klopt; euro-indicaties pas aan het eind gedeeld door de koers.
//
// INTERN: bankregel_ghawa (Triodos-regels met tegenpartij en rekeningnummer) en donateur staan in de databank maar komen in geen enkele
// route; de routes geven van GHAWA alleen totalen per jaar en soort, saldi en de som van de verwachte giften. Geen log met inhoud.
//
// Gebruik vanuit server.js: require('./ghawa.js').maak({ dbPad, bronnenMap, vaultMap }) → { app({ pad }), info() }.
// Invoer (machinekamer): node ghawa.js invoer <csv-map overview> <ghawa.sqlite>   (vervangt alle tabellen in één transactie)
// Alleen rekenen:        node ghawa.js reken <ghawa.sqlite>                         (json met de kerncijfers en aansluitingen, zonder namen)

const fs = require('fs');
const path = require('path');

// ── schema ──
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (sleutel TEXT PRIMARY KEY, waarde TEXT);
CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, naam TEXT NOT NULL, volgorde INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fase (id TEXT PRIMARY KEY, project TEXT NOT NULL, naam TEXT NOT NULL, omschrijving TEXT, volgorde INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS activiteit (nr TEXT PRIMARY KEY, project TEXT NOT NULL, fase TEXT NOT NULL, naam TEXT NOT NULL, naam_nl TEXT,
  status TEXT, toelichting TEXT, volgorde INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS begrotingsregel (id TEXT PRIMARY KEY, activiteit TEXT NOT NULL, post TEXT, aantal TEXT, prijs_cent INTEGER,
  begroot_cent INTEGER NOT NULL, status TEXT, regel_open TEXT NOT NULL, open_cent INTEGER, notitie TEXT, overlap TEXT, wg_toelichting TEXT,
  volgorde INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS uitgave (id TEXT PRIMARY KEY, datum TEXT, regel TEXT NOT NULL, omschrijving TEXT, referentie TEXT,
  gmd_cent INTEGER NOT NULL, betaald_van TEXT, betaalwijze TEXT, cheque TEXT, bewijs TEXT, bron TEXT, wg_cent INTEGER, wg_post TEXT, notitie TEXT);
CREATE TABLE IF NOT EXISTS bankregel_ecg (id TEXT PRIMARY KEY, rekening TEXT NOT NULL, datum TEXT NOT NULL, omschrijving TEXT, referentie TEXT,
  bedrag_cent INTEGER NOT NULL, munt TEXT NOT NULL, saldo_cent INTEGER NOT NULL, soort TEXT NOT NULL, cheque TEXT, begunstigde TEXT, bron TEXT,
  volg INTEGER NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS geldstroom (id TEXT PRIMARY KEY, datum TEXT, soort TEXT NOT NULL, van TEXT, naar TEXT, eur_cent INTEGER,
  gmd_cent INTEGER, project TEXT, doel TEXT, bron TEXT, notitie TEXT);
CREATE TABLE IF NOT EXISTS fonds (id TEXT PRIMARY KEY, gever TEXT NOT NULL, soort TEXT, project TEXT, doel TEXT, eur_cent INTEGER, datum TEXT,
  status TEXT, waar TEXT, notitie TEXT);
CREATE TABLE IF NOT EXISTS instelling (sleutel TEXT PRIMARY KEY, waarde TEXT, toelichting TEXT);
CREATE TABLE IF NOT EXISTS open_vraag (id TEXT PRIMARY KEY, onderwerp TEXT, vraag TEXT, gmd_cent INTEGER, wie TEXT, status TEXT, antwoord TEXT);
CREATE TABLE IF NOT EXISTS opname_uitleg (volgorde INTEGER PRIMARY KEY, wat TEXT NOT NULL, gmd_cent INTEGER, uitleg TEXT);
-- INTERN: nooit in een route, nooit gedeeld
CREATE TABLE IF NOT EXISTS bankregel_ghawa (id TEXT PRIMARY KEY, rekening TEXT NOT NULL, datum TEXT NOT NULL, jaar INTEGER NOT NULL,
  bedrag_cent INTEGER NOT NULL, richting TEXT, tegenpartij TEXT, tegenrekening TEXT, code TEXT, omschrijving TEXT, saldo_cent INTEGER,
  soort TEXT NOT NULL, donateur TEXT, project TEXT, doel TEXT, volg INTEGER NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS donateur (naam TEXT PRIMARY KEY, soort TEXT, vast TEXT, verwacht_cent INTEGER, giften INTEGER, laatste TEXT, notitie TEXT);
`;
const TABELLEN = ['project', 'fase', 'activiteit', 'begrotingsregel', 'uitgave', 'bankregel_ecg', 'geldstroom', 'fonds', 'instelling',
  'open_vraag', 'opname_uitleg', 'bankregel_ghawa', 'donateur'];

// Vaste namen (Nederlands); de Engelse bronnamen blijven in de databank voor het latere gedeelde deel.
const PROJECTEN = [['Building', 'Bouw gezondheidscentrum', 1], ['Pharmacy', 'Apotheek (AFAS-project)', 2]];
const FASEN = [
  ['Phase 1A', 'Building', 'Fase 1A', 'fundering, boorput en pomp, septictank, hek, zonne-energie'],
  ['Phase 1B', 'Building', 'Fase 1B', 'muren begane grond en eerste vloer'],
  ['Phase 2', 'Building', 'Fase 2', 'eerste verdieping en tweede vloer'],
  ['Phase 3', 'Building', 'Fase 3', 'tweede verdieping, derde vloer en dak'],
  ['Phase 4', 'Building', 'Fase 4', 'afbouw, inrichting en installaties'],
  ['Phase 5', 'Building', 'Fase 5', 'terrein vrijmaken en extra ophogen'],
  ['All phases', 'Building', 'Projectleiding', 'vergoeding projectleiding, alle fasen'],
  ['Unbudgeted', 'Building', 'Niet begroot', 'buitentoiletten, bankkosten, nog te specificeren'],
  ['Pharmacy', 'Pharmacy', 'Apotheek', 'apart project, gesponsord door AFAS'],
];
// Nederlandse naam op de Engelse bronnaam (niet op het nummer: een nummer kan in een latere begroting iets anders zijn)
const ACT_NL = { 'solar panels': 'Zonnepanelen', 'solar water pumping system': 'Waterpomp op zonne-energie', foundation: 'Fundering', 'septic tank': 'Septictank',
  fencing: 'Omheining', 'floor level to top beam for first floor including plastering': 'Muren begane grond (met pleisteren)', 'rc slab 1': 'Betonvloer 1',
  'first floor': 'Eerste verdieping', 'rc slab 2': 'Betonvloer 2', 'second floor': 'Tweede verdieping', 'rc slab 3 / roof': 'Betonvloer 3 en dak', interior: 'Inrichting',
  'ground clearing expenses and extra expenses on backfilling': 'Terrein vrijmaken en ophogen', 'two outside toilets': 'Twee buitentoiletten (niet begroot)',
  'bank charges': 'Bankkosten (niet begroot)', 'other / to be specified': 'Overig, nog te specificeren', 'project management': 'Projectleiding',
  'pharmacy - building': 'Gebouw apotheek', 'pharmacy - furniture & fittings': 'Meubilair en inrichting', 'pharmacy - equipment & technology': 'Apparatuur en techniek',
  'pharmacy - medication stock': 'Eerste voorraad medicijnen', 'pharmacy - staff': 'Personeel', 'pharmacy - transport & logistics': 'Vervoer en logistiek',
  'pharmacy - communication & marketing': 'Communicatie', 'pharmacy - contingency': 'Onvoorzien' };
const REGELS_OPEN = ['full budget', 'budget - realised', 'none', 'activity balance', 'offset', 'estimate'];
// GHAWA-soorten (Triodos) in de volgorde van het overdrachtsbestand; groep bepaalt aansluiting E.
const GHAWA_SOORTEN = [
  ['Donation (bank transfer)', 'opgehaald', 'Giften (overboeking)'], ['Donation online (Mollie)', 'opgehaald', 'Giften online'],
  ['Sponsor AFAS (pharmacy)', 'opgehaald', 'Sponsor AFAS (apotheek)'], ['Interest', 'opgehaald', 'Rente'],
  ['Bank costs', 'kosten', 'Bankkosten'], ['Bank fee foreign payment', 'kosten', 'Kosten buitenlandse betaling'], ['Other costs', 'kosten', 'Overige kosten'],
  ['Transfer to Wilde Ganzen', 'wg', 'Naar Wilde Ganzen'], ['Transfer to ECG', 'ecg', 'Naar ECG'],
  ['Internal transfer (current/savings)', 'intern', 'Tussen eigen rekeningen'],
  ['Unknown', 'onbekend', 'Nog in te delen'],   // wv2880: uit de bank, nog niet ingedeeld (één tik van David)
];
const OORMERK_STATUS = ['Received by GHAWA NL', 'Committed - not yet received'];

// ── kleine hulpen ──
function csvLees(tekst) {   // RFC 4180: aanhalingstekens, "" binnen een veld, regeleinde binnen een veld
  const rijen = []; let rij = [], veld = '', i = 0, q = false;
  if (tekst.charCodeAt(0) === 0xfeff) tekst = tekst.slice(1);
  while (i < tekst.length) {
    const c = tekst[i];
    if (q) { if (c === '"') { if (tekst[i + 1] === '"') { veld += '"'; i++; } else q = false; } else veld += c; }
    else if (c === '"') q = true;
    else if (c === ',') { rij.push(veld); veld = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && tekst[i + 1] === '\n') i++; rij.push(veld); rijen.push(rij); rij = []; veld = ''; }
    else veld += c;
    i++;
  }
  if (veld !== '' || rij.length) { rij.push(veld); rijen.push(rij); }
  return rijen;
}
function csvObjecten(bestand, verplicht) {
  const r = csvLees(fs.readFileSync(bestand, 'utf8'));
  const kop = r[0] || [];
  const mist = (verplicht || []).filter((k) => kop.indexOf(k) < 0);
  if (mist.length) throw new Error('invoer geweigerd: ' + path.basename(bestand) + ' mist kolom ' + mist.join(', '));
  return r.slice(1).filter((x) => x.some((v) => v !== '')).map((x) => Object.fromEntries(kop.map((k, j) => [k, x[j] === undefined ? '' : x[j]])));
}
// Houdt de rijen met een geldige sleutel; een rij zonder geldige sleutel mag alleen een voetnoot zijn (alleen de eerste kolom gevuld).
// Een echte datarij met een afwijkende of lege sleutel stopt de invoer: nooit stil uitgaven of bankregels kwijt.
function rijenMet(rijen, sleutel, re, naam, fouten) {
  return rijen.filter((x) => {
    if (re.test(x[sleutel] || '')) return true;
    const vals = Object.values(x);   // volgorde = kolomvolgorde van de kop
    if (vals.slice(1).every((v) => v === '')) return false;   // voetnoot: alleen de eerste kolom gevuld
    fouten.push(naam + ': rij met ongeldige sleutel ' + JSON.stringify(String(x[sleutel] || '').slice(0, 12)));
    return false;
  });
}
function cent(v) {   // '2666620.78' → 266662078; '' → null; decimaal exact (geen binaire afronding), meer dan 2 decimalen: half naar boven op het 3e cijfer
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error('geen bedrag: ' + s.slice(0, 20));
  const frac = (m[3] || '') + '000';
  let c = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) c += 1;
  if (!Number.isSafeInteger(c)) throw new Error('bedrag te groot: ' + s.slice(0, 20));
  return m[1] === '-' && c !== 0 ? -c : c;
}
const leeg = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v));

// ── invoer ──
// csvMap = map met de csv's per tabblad (Overview, Activities, Budget_Lines, ...). Leest alles eerst, toetst, en schrijft dan in één transactie.
function leesCsvMap(csvMap) {
  const fouten = [];
  const f = (n, verplicht) => csvObjecten(path.join(csvMap, n + '.csv'), verplicht);
  const act = rijenMet(f('Activities', ['activity_no', 'project', 'phase', 'activity']), 'activity_no', /^(\d+|B|P\d+)$/, 'Activities', fouten);
  const regels = rijenMet(f('Budget_Lines', ['line_id', 'activity_no', 'budget_gmd', 'still_open_rule']), 'line_id', /^([A-Z]\d*|\d+)\.\d+$/, 'Budget_Lines', fouten);
  const uit = rijenMet(f('Transactions', ['txn_id', 'line_id', 'amount_gmd', 'paid_from']), 'txn_id', /^T\d+$/, 'Transactions', fouten);
  const bank = rijenMet(f('Bank', ['bank_txn_id', 'account', 'date', 'amount', 'currency', 'balance_after', 'type']), 'bank_txn_id', /^B\d+$/, 'Bank', fouten);
  const stromen = rijenMet(f('Money_Flows', ['flow_id', 'type', 'eur', 'gmd']), 'flow_id', /^M\d+$/, 'Money_Flows', fouten);
  const fondsen = rijenMet(f('Funding', ['fund_id', 'funder', 'project', 'amount_eur', 'status']), 'fund_id', /^F\d+[a-z]?$/, 'Funding', fouten);
  const vragen = rijenMet(f('Open_Questions', ['q_id', 'question', 'status']), 'q_id', /^Q\d+/, 'Open_Questions', fouten);
  const ghb = rijenMet(f('GHAWA_Bank', ['g_id', 'account', 'date', 'year', 'amount_eur', 'balance_after', 'category']), 'g_id', /^G\d+$/, 'GHAWA_Bank', fouten);
  const don = f('GHAWA_Donors', ['donor', 'type', 'recurring', 'expected_per_year']).filter((x) => x.donor && x.type);
  if (fouten.length) throw new Error('invoer geweigerd: ' + fouten.slice(0, 5).join('; ') + (fouten.length > 5 ? ' (+' + (fouten.length - 5) + ')' : ''));
  // Settings: titelregel, lege regel, dan key,value,note
  const st = csvLees(fs.readFileSync(path.join(csvMap, 'Settings.csv'), 'utf8'));
  const ki = st.findIndex((r) => r[0] === 'key');
  const inst = st.slice(ki + 1).filter((r) => r[0] && r[0] !== '' && r.length >= 2 && !/^Blue text/.test(r[0])).map((r) => [r[0], r[1], r[2] || '']);
  // Reconciliation: WG ontvangen (F) en de toelichting op de eerste opnames (G) staan alleen daar
  const rc = csvLees(fs.readFileSync(path.join(csvMap, 'Reconciliation.csv'), 'utf8'));
  const wg = rc.find((r) => /^Received for Phase 1A/.test(r[0] || ''));
  if (wg) inst.push(['wg_received_gmd', wg[5], 'Wilde Ganzen 2023.0476: ontvangen voor Phase 1A volgens het WG-werkboek (Amounts received).']);
  const cash = rc.find((r) => /exchanged at 73\.80/.test(r[0] || ''));
  if (cash) inst.push(['eur_cash_rate', '73.8', 'Koers van de contante opname van de eurorekening (7-2-2025), volgens het ECG-verslag van 23-4-2025.']);
  const gi = rc.findIndex((r) => /^G\. First withdrawals/.test(r[0] || ''));
  const g = gi < 0 ? [] : rc.slice(gi + 1).filter((r) => r[0] && r[5] !== undefined && r[5] !== '').map((r, j) => ({ volgorde: j + 1, wat: r[0], gmd: r[5], uitleg: r[8] || '' }));
  const sp = rc.findIndex((r) => /^Balance according to the statements/.test(r[0] || ''));
  if (sp >= 0) inst.push(['ghawa_statement_balance_eur', rc[sp][5], 'Saldo volgens de Triodos-afschriften (betaal + spaar), ter vergelijking met de som van de regels.']);
  const bv = rc.findIndex((r) => /^B\. Cheque withdrawals/.test(r[0] || ''));
  if (bv >= 0) inst.push(['recon_b_from', '2026-07-01', 'Aansluiting B: cheques vanaf deze datum tegenover de handgeschreven lijsten.']);
  return { act, regels, uit, bank, stromen, fondsen, vragen, ghb, don, inst, g };
}

function invoer(csvMap, dbPad, opties) {
  const o = opties || {};
  const BIJ = require('./ghawa-bij.js');
  const b = leesCsvMap(csvMap);
  const fouten = [];
  const actNrs = new Set(b.act.map((x) => x.activity_no));
  const regelIds = new Set(b.regels.map((x) => x.line_id));
  for (const r of b.regels) {
    if (!actNrs.has(r.activity_no)) fouten.push('regel ' + r.line_id + ': onbekende activiteit');
    if (REGELS_OPEN.indexOf(r.still_open_rule) < 0) fouten.push('regel ' + r.line_id + ': onbekende still_open_rule');
  }
  for (const u of b.uit) if (!regelIds.has(u.line_id)) fouten.push('uitgave ' + u.txn_id + ': onbekende regel');
  for (const g of b.ghb) if (!GHAWA_SOORTEN.some((s) => s[0] === g.category)) fouten.push('GHAWA-regel ' + g.g_id + ': onbekende soort');
  if (fouten.length) throw new Error('invoer geweigerd: ' + fouten.slice(0, 5).join('; ') + (fouten.length > 5 ? ' (+' + (fouten.length - 5) + ')' : ''));
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(dbPad), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPad);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('BEGIN IMMEDIATE');
    try {
      // wv2880 (review MOET 4): binnen dezelfde schrijftransactie kijken of er bijgehouden regels zijn (bank, afschriften, fondsen); die wist
      // een herinvoer alleen met --forceer
      const f2 = BIJ.fase2Gegevens(db);
      if (f2 > 0 && !o.forceer) throw new Error('invoer geweigerd: de databank heeft ' + f2 + ' bijgehouden regels (fase 2); alleen met --forceer');
      // de invoer vervangt alles: tabellen opnieuw opbouwen, zodat een databank van een oudere versie (zonder kolom volg) geen half schema houdt
      for (const t of TABELLEN.concat(BIJ.BIJ_TABELLEN)) db.exec('DROP TABLE IF EXISTS ' + t);
      db.exec(SCHEMA);
      const z = (sql) => db.prepare(sql);
      const pP = z('INSERT INTO project VALUES (?,?,?)'); for (const p of PROJECTEN) pP.run(...p);
      const pF = z('INSERT INTO fase VALUES (?,?,?,?,?)'); FASEN.forEach((f, i) => pF.run(f[0], f[1], f[2], f[3], i + 1));
      const pA = z('INSERT INTO activiteit VALUES (?,?,?,?,?,?,?,?)');
      b.act.forEach((a, i) => pA.run(a.activity_no, a.project, a.phase, a.activity, ACT_NL[String(a.activity).trim().toLowerCase()] || null, leeg(a.status), leeg(a.summary), i + 1));
      const pR = z('INSERT INTO begrotingsregel VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
      b.regels.forEach((r, i) => pR.run(r.line_id, r.activity_no, leeg(r.budget_item), leeg(r.quantity), cent(r.unit_price_gmd), cent(r.budget_gmd) || 0,
        leeg(r.status), r.still_open_rule, r.still_open_rule === 'estimate' ? cent(r.still_open_gmd) : null, leeg(r.notes), leeg(r.possible_overlap),
        leeg(r.wg_workbook_explanation), i + 1));
      const pU = z('INSERT INTO uitgave VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const u of b.uit) pU.run(u.txn_id, leeg(u.date), u.line_id, leeg(u.description), leeg(u.invoice_or_ref), cent(u.amount_gmd) || 0, leeg(u.paid_from),
        leeg(u.payment_method), leeg(u.cheque_no), leeg(u.evidence), leeg(u.source), cent(u.wg_2023_0476_phase1a_gmd), leeg(u.wg_2023_0476_item), leeg(u.notes));
      const pB = z('INSERT INTO bankregel_ecg VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');   // volg = volgorde in het afschrift (boekingsvolgorde)
      b.bank.forEach((x, i) => pB.run(x.bank_txn_id, x.account, x.date, leeg(x.description), leeg(x.reference), cent(x.amount), x.currency, cent(x.balance_after),
        x.type, leeg(x.cheque_no), leeg(x.payee), leeg(x.source), i + 1));
      const pM = z('INSERT INTO geldstroom VALUES (?,?,?,?,?,?,?,?,?,?,?)');
      for (const m of b.stromen) pM.run(m.flow_id, leeg(m.date), m.type, leeg(m.from), leeg(m.to), cent(m.eur), cent(m.gmd), leeg(m.project), leeg(m.purpose), leeg(m.source), leeg(m.notes));
      const pFo = z('INSERT INTO fonds VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const f of b.fondsen) pFo.run(f.fund_id, f.funder, leeg(f.type), leeg(f.project), leeg(f.purpose), cent(f.amount_eur), leeg(f.date), leeg(f.status), leeg(f.where_the_money_is), leeg(f.notes));
      const pI = z('INSERT INTO instelling VALUES (?,?,?)'); for (const s of b.inst) pI.run(s[0], s[1], s[2]);
      const pV = z('INSERT INTO open_vraag VALUES (?,?,?,?,?,?,?)');
      for (const v of b.vragen) pV.run(v.q_id, leeg(v.topic), leeg(v.question), cent(v.amount_gmd), leeg(v.who), leeg(v.status), leeg(v.answer));
      const pG = z('INSERT INTO opname_uitleg VALUES (?,?,?,?)'); for (const g of b.g) pG.run(g.volgorde, g.wat, cent(g.gmd), leeg(g.uitleg));
      const pGh = z('INSERT INTO bankregel_ghawa VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      b.ghb.forEach((g, i) => pGh.run(g.g_id, g.account, g.date, Number(g.year), cent(g.amount_eur), leeg(g.direction), leeg(g.counterparty), leeg(g.counter_account),
        leeg(g.code), leeg(g.description), cent(g.balance_after), g.category, leeg(g.donor), leeg(g.project), leeg(g.purpose), i + 1));
      const pD = z('INSERT INTO donateur VALUES (?,?,?,?,?,?,?)');
      for (const d of b.don) pD.run(d.donor, leeg(d.type), leeg(d.recurring), cent(d.expected_per_year), d.gifts === '' ? null : Number(d.gifts), leeg(d.last_gift), leeg(d.notes));
      const pMe = z('INSERT OR REPLACE INTO meta VALUES (?,?)');
      pMe.run('invoer_op', o.nu || new Date().toISOString()); pMe.run('invoer_bron', o.bron || 'csv'); pMe.run('schema', '2');
      BIJ.migreer(db);   // wv2880: kolommen en tabellen van fase 2 (bijhouden) erbij, schema 3
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally { db.close(); }
  try { fs.chmodSync(dbPad, 0o600); } catch (e) { /* bestaat */ }
  return { activiteiten: b.act.length, regels: b.regels.length, uitgaven: b.uit.length, bank_ecg: b.bank.length, geldstromen: b.stromen.length,
    fondsen: b.fondsen.length, vragen: b.vragen.length, bank_ghawa: b.ghb.length, donateurs: b.don.length };
}

// ── lezen (alleen-lezen verbinding; intern alleen aggregaten) ──
function leesData(dbPad) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPad, { readOnly: true });
  try {
    const a = (sql) => db.prepare(sql).all();
    db.exec('BEGIN');   // één momentopname: een herinvoer tijdens het lezen mengt geen oude en nieuwe tabellen
    const uit = {
      projecten: a('SELECT * FROM project ORDER BY volgorde'),
      fasen: a('SELECT * FROM fase ORDER BY volgorde'),
      activiteiten: a('SELECT * FROM activiteit ORDER BY volgorde'),
      regels: a('SELECT * FROM begrotingsregel ORDER BY volgorde'),
      uitgaven: a('SELECT * FROM uitgave ORDER BY id'),
      bank: a('SELECT * FROM bankregel_ecg ORDER BY volg'),
      stromen: a('SELECT * FROM geldstroom ORDER BY id'),
      fondsen: a('SELECT * FROM fonds ORDER BY id'),
      instelling: Object.fromEntries(a('SELECT sleutel, waarde FROM instelling').map((r) => [r.sleutel, r.waarde])),
      vragen: a('SELECT * FROM open_vraag ORDER BY id'),
      opnameUitleg: a('SELECT * FROM opname_uitleg ORDER BY volgorde'),
      // INTERN → alleen sommen, nooit namen of rekeningnummers
      ghawaPerSoortJaar: a('SELECT soort, jaar, SUM(bedrag_cent) AS cent, COUNT(*) AS n FROM bankregel_ghawa GROUP BY soort, jaar'),
      ghawaSaldo: a("SELECT CASE WHEN rekening LIKE 'Savings%' THEN 'spaar' ELSE 'betaal' END AS rek, MAX(datum) AS datum, " +
        "(SELECT saldo_cent FROM bankregel_ghawa g2 WHERE (CASE WHEN g2.rekening LIKE 'Savings%' THEN 'spaar' ELSE 'betaal' END) = " +
        "(CASE WHEN g.rekening LIKE 'Savings%' THEN 'spaar' ELSE 'betaal' END) ORDER BY g2.volg DESC LIMIT 1) AS saldo_cent, COUNT(*) AS n " +
        'FROM bankregel_ghawa g GROUP BY rek'),
      ghawaKetenBreuken: (function () {   // saldoketen per rekening: elk saldo = vorige + bedrag (rekening begint op 0)
        let breuk = 0; const vorig = {};
        for (const r of a('SELECT rekening, bedrag_cent, saldo_cent FROM bankregel_ghawa ORDER BY volg')) {
          const k = String(r.rekening).slice(0, 7); const v = vorig[k] || 0;
          if (r.saldo_cent !== null && v + r.bedrag_cent !== r.saldo_cent) breuk++;
          vorig[k] = r.saldo_cent === null ? v + r.bedrag_cent : r.saldo_cent;
        }
        return breuk;
      })(),
      donateurVerwacht: a("SELECT vast, SUM(verwacht_cent) AS cent, COUNT(*) AS n FROM donateur WHERE vast IS NOT NULL GROUP BY vast"),
      meta: Object.fromEntries(a('SELECT sleutel, waarde FROM meta').map((r) => [r.sleutel, r.waarde])),
    };
    // wv2880 (fase 2): wat bijgehouden wordt; op een databank van fase 1 (nog niet gemigreerd) leeg
    const heeft = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    const f2 = heeft('signaal') && db.prepare('PRAGMA table_info(bankregel_ghawa)').all().some((r) => r.name === 'herkomst');
    uit.fase2 = f2;
    uit.signalen = f2 ? a('SELECT soort, tekst, op FROM signaal WHERE dicht_op IS NULL ORDER BY op') : [];
    uit.afschriften = f2 ? a('SELECT naam, formaat, munt, van, tot, regels, nieuw, al_bekend, uitkomst, fout, op FROM afschrift ORDER BY op DESC LIMIT 12') : [];
    uit.ronde = f2 ? a('SELECT maand, stap, op FROM ronde') : [];
    uit.fondsLog = f2 ? a('SELECT fonds, veld, oud, nieuw, op FROM fonds_log ORDER BY nr DESC LIMIT 50') : [];
    uit.ghawaBank = f2 ? db.prepare("SELECT COUNT(*) AS n, SUM(soort = 'Unknown') AS onbekend, MAX(datum) AS tot FROM bankregel_ghawa WHERE herkomst = 'bank'").get() : { n: 0, onbekend: 0, tot: null };
    uit.ecgAfschrift = f2 ? db.prepare("SELECT COUNT(*) AS n FROM bankregel_ecg WHERE herkomst = 'afschrift'").get().n : 0;
    db.exec('COMMIT');
    return uit;
  } finally { db.close(); }
}

// ── rekenkern ──
const kwartaal = (d) => d.slice(0, 4) + ' Q' + (Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1);
const som = (l, f) => l.reduce((s, x) => s + (f(x) || 0), 0);
const r2 = (x) => Math.round(x * 100) / 100;

function bereken(d) {
  const inst = d.instelling;
  const koers = Number(inst.indicative_rate_gmd_per_eur);
  if (!(koers > 0)) throw new Error('indicatieve koers ontbreekt');
  const signalen = [];
  // 1. begrotingsregels
  const regelIds = new Set(d.regels.map((r) => r.id));
  const gereal = new Map();
  for (const u of d.uitgaven) {
    if (!regelIds.has(u.regel)) signalen.push({ soort: 'uitgave zonder regel', id: u.id });
    gereal.set(u.regel, (gereal.get(u.regel) || 0) + u.gmd_cent);
  }
  const perAct = new Map();
  for (const r of d.regels) {
    const p = perAct.get(r.activiteit) || { begroot: 0, gerealiseerd: 0 };
    p.begroot += r.begroot_cent; p.gerealiseerd += gereal.get(r.id) || 0; perAct.set(r.activiteit, p);
  }
  const regels = d.regels.map((r) => {
    const g = gereal.get(r.id) || 0; let open;
    switch (r.regel_open) {
      case 'full budget': open = r.begroot_cent; break;
      case 'budget - realised': open = Math.max(0, r.begroot_cent - g); break;
      case 'none': open = 0; break;
      case 'activity balance': { const p = perAct.get(r.activiteit); open = p.begroot - p.gerealiseerd; break; }
      case 'offset': open = -g; break;
      case 'estimate': open = r.open_cent || 0; break;
      default: throw new Error('onbekende still_open_rule bij ' + r.id);
    }
    return { id: r.id, activiteit: r.activiteit, post: r.post, aantal: r.aantal, prijs: r.prijs_cent, begroot: r.begroot_cent, gerealiseerd: g, open,
      prognose: g + open, verschil: r.begroot_cent - (g + open), status: r.status, regel_open: r.regel_open, notitie: r.notitie, overlap: r.overlap,
      wg_toelichting: r.wg_toelichting };
  });
  // 2. activiteiten: niet meer nodig en overschrijding per activiteit verrekend
  const actMap = new Map();
  const activiteiten = d.activiteiten.map((a) => {
    const rs = regels.filter((r) => r.activiteit === a.nr);
    const begroot = som(rs, (r) => r.begroot), gerealiseerd = som(rs, (r) => r.gerealiseerd), open = som(rs, (r) => r.open);
    const prognose = gerealiseerd + open;
    const x = { nr: a.nr, project: a.project, fase: a.fase, naam: a.naam, naam_nl: a.naam_nl, status: a.status, toelichting: a.toelichting,
      begroot, gerealiseerd, niet_nodig: Math.max(0, begroot - prognose), open, overschrijding: Math.max(0, prognose - begroot), prognose,
      pct: begroot === 0 ? null : gerealiseerd / begroot, open_eur: r2(open / 100 / koers), regels: rs.length };
    actMap.set(a.nr, x); return x;
  });
  const tel = (l) => ({ begroot: som(l, (x) => x.begroot), gerealiseerd: som(l, (x) => x.gerealiseerd), niet_nodig: som(l, (x) => x.niet_nodig),
    open: som(l, (x) => x.open), overschrijding: som(l, (x) => x.overschrijding) });
  const fasen = d.fasen.filter((f) => f.project === 'Building').map((f) => {
    const t = tel(activiteiten.filter((a) => a.project === 'Building' && a.fase === f.id));
    return Object.assign({ id: f.id, naam: f.naam, omschrijving: f.omschrijving }, t, { open_eur: r2(t.open / 100 / koers), pct: t.begroot ? t.gerealiseerd / t.begroot : null });
  });
  const bouw = tel(activiteiten.filter((a) => a.project === 'Building'));
  bouw.open_eur_exact = bouw.open / 100 / koers; bouw.open_eur = r2(bouw.open_eur_exact); bouw.pct = bouw.begroot ? bouw.gerealiseerd / bouw.begroot : null;
  bouw.controle = bouw.begroot - bouw.niet_nodig + bouw.overschrijding - bouw.gerealiseerd - bouw.open;   // moet 0 zijn
  const apo = tel(activiteiten.filter((a) => a.project === 'Pharmacy'));
  apo.open_eur_exact = apo.open / 100 / koers; apo.open_eur = r2(apo.open_eur_exact);

  // 3. ECG-bank: saldoketen, saldi, kwartalen (aansluiting A)
  const rek = { GMD: d.bank.filter((b) => b.munt === 'GMD'), EUR: d.bank.filter((b) => b.munt === 'EUR') };
  const keten = {}, saldo = {}, laatsteDatum = {}, kwartalen = {};
  for (const m of ['GMD', 'EUR']) {
    let v = 0, breuk = 0;
    for (const b of rek[m]) { if (v + b.bedrag_cent !== b.saldo_cent) breuk++; v = b.saldo_cent; }
    keten[m] = { regels: rek[m].length, breuken: breuk };
    saldo[m] = rek[m].length ? rek[m][rek[m].length - 1].saldo_cent : 0;
    laatsteDatum[m] = rek[m].length ? rek[m].reduce((x, b) => (b.datum > x ? b.datum : x), '') : null;
    const qs = [...new Set(rek[m].map((b) => kwartaal(b.datum)))].sort();
    let open = 0; kwartalen[m] = [];
    for (const q of qs) {
      const rs = rek[m].filter((b) => kwartaal(b.datum) === q);
      const inn = som(rs.filter((b) => b.bedrag_cent > 0), (b) => b.bedrag_cent), uit = -som(rs.filter((b) => b.bedrag_cent < 0), (b) => b.bedrag_cent);
      const sluit = open + inn - uit, afschrift = rs[rs.length - 1].saldo_cent;
      kwartalen[m].push({ kwartaal: q, rekening: rs[0].rekening, begin: open, in: inn, uit, eind: sluit, afschrift, verschil: sluit - afschrift });
      open = sluit;
    }
  }
  const somSoort = (m, soort) => som(rek[m].filter((b) => b.soort === soort), (b) => b.bedrag_cent);

  // 4. geldstromen
  const omw = d.stromen.filter((s) => s.soort === 'Conversion EUR to GMD').map((s) => ({ id: s.id, datum: s.datum, eur: s.eur_cent, gmd: s.gmd_cent,
    koers: s.eur_cent ? s.gmd_cent / s.eur_cent : null, notitie: s.notitie, doel: s.doel }));
  const naarEcg = d.stromen.filter((s) => s.soort === 'Transfer to ECG').map((s) => ({ id: s.id, datum: s.datum, van: s.van, eur: s.eur_cent, notitie: s.notitie }));
  const naarWg = d.stromen.filter((s) => s.soort === 'Transfer GHAWA to Wilde Ganzen').map((s) => ({ id: s.id, datum: s.datum, eur: s.eur_cent }));
  const omwTot = { eur: som(omw, (x) => x.eur), gmd: som(omw, (x) => x.gmd), aantal: omw.length };
  omwTot.koers = omwTot.eur ? omwTot.gmd / omwTot.eur : null;
  const omwKw = [...new Set(omw.map((x) => kwartaal(x.datum)))].sort().map((q) => {
    const rs = omw.filter((x) => kwartaal(x.datum) === q); const e = som(rs, (x) => x.eur), g = som(rs, (x) => x.gmd);
    return { kwartaal: q, eur: e, gmd: g, koers: e ? g / e : null, aantal: rs.length };
  });
  const cashKoers = Number(inst.eur_cash_rate || 0);
  const ecgEur = { ontvangen: som(rek.EUR.filter((b) => b.soort === 'Transfer in from NL'), (b) => b.bedrag_cent),
    omgewisseld: -somSoort('EUR', 'Conversion out'), contant: -somSoort('EUR', 'Cash withdrawal'), bankkosten: -somSoort('EUR', 'Bank charge'),
    overig: -somSoort('EUR', 'Payment from EUR account'), saldo: saldo.EUR, datum: laatsteDatum.EUR };
  const ecgGmd = { in: somSoort('GMD', 'Conversion in'), cheques: -somSoort('GMD', 'Cheque withdrawal'), contant: -somSoort('GMD', 'Cash withdrawal'),
    leveranciers: -somSoort('GMD', 'Payment to supplier'), terugboekingen: somSoort('GMD', 'Reversal'), bankkosten: -somSoort('GMD', 'Bank charge'),
    saldo: saldo.GMD, datum: laatsteDatum.GMD };
  ecgGmd.uitbetaald = ecgGmd.cheques + ecgGmd.contant + ecgGmd.leveranciers - ecgGmd.terugboekingen;

  // GHAWA (alleen sommen)
  const gs = (soort) => som(d.ghawaPerSoortJaar.filter((x) => x.soort === soort), (x) => x.cent);
  const groep = (gr) => som(GHAWA_SOORTEN.filter((s) => s[1] === gr), (s) => gs(s[0]));
  const jaren = [...new Set(d.ghawaPerSoortJaar.map((x) => x.jaar))].sort();
  const ghawaPerJaar = GHAWA_SOORTEN.map((s) => ({ soort: s[0], naam: s[2], groep: s[1],
    jaren: Object.fromEntries(jaren.map((j) => [j, som(d.ghawaPerSoortJaar.filter((x) => x.soort === s[0] && x.jaar === j), (x) => x.cent)])), totaal: gs(s[0]) }))
    .filter((s) => s.groep !== 'onbekend' || d.ghawaPerSoortJaar.some((x) => x.soort === s.soort));   // wv2880: "nog in te delen" alleen als er zulke regels zijn
  let cum = 0;
  const ghawaEindJaar = jaren.map((j) => { cum += som(d.ghawaPerSoortJaar.filter((x) => x.jaar === j), (x) => x.cent); return { jaar: j, saldo: cum }; });
  const ghawaSaldo = som(d.ghawaPerSoortJaar, (x) => x.cent);
  const ghawaAfschrift = som(d.ghawaSaldo, (x) => x.saldo_cent);
  const ghawaDatum = d.ghawaSaldo.reduce((x, r) => (r.datum > x ? r.datum : x), '');

  // 5. fondsen en nog te werven (Overview § 2)
  const oormerk = (proj) => som(d.fondsen.filter((f) => f.project === proj && OORMERK_STATUS.indexOf(f.status) >= 0), (f) => f.eur_cent);
  const bijGhawaGeoormerkt = som(d.fondsen.filter((f) => f.status === 'Received by GHAWA NL'), (f) => f.eur_cent);
  const fondsBouw = oormerk('Building'), fondsApo = oormerk('Pharmacy');
  const bouwNa = Math.max(0, bouw.open_eur_exact - fondsBouw / 100), apoNa = Math.max(0, apo.open_eur_exact - fondsApo / 100);
  const apoOverschot = Math.max(0, fondsApo / 100 - apo.open_eur_exact);
  const ecgGmdEur = saldo.GMD / 100 / koers;
  const ghawaVrij = (ghawaSaldo - bijGhawaGeoormerkt) / 100;
  const nogTeWerven = Math.max(0, bouwNa + apoNa - saldo.EUR / 100 - ecgGmdEur - ghawaVrij);
  const vasteDonateurs = som(d.donateurVerwacht.filter((x) => x.vast === 'Yes'), (x) => x.cent);
  const online = d.fondsen.find((f) => f.gever === 'GHAWA online donations');
  const werven = { bouw_open: r2(bouw.open_eur_exact), apo_open: r2(apo.open_eur_exact), oormerk_bouw: fondsBouw / 100, oormerk_apo: fondsApo / 100,
    bouw_na_oormerk: r2(bouwNa), apo_na_oormerk: r2(apoNa), apo_overschot: r2(apoOverschot), ecg_eur: saldo.EUR / 100, ecg_gmd_in_eur: r2(ecgGmdEur),
    ghawa_vrij: r2(ghawaVrij), nog_te_werven: r2(nogTeWerven), verwacht_vaste_donateurs: vasteDonateurs / 100,
    verwacht_online: online ? online.eur_cent / 100 : null };

  // 6. aansluitingen A t/m G
  const A = { GMD: kwartalen.GMD, EUR: kwartalen.EUR, verschil: som(kwartalen.GMD, (q) => Math.abs(q.verschil)) + som(kwartalen.EUR, (q) => Math.abs(q.verschil)),
    breuken: keten.GMD.breuken + keten.EUR.breuken, saldo_instelling: { GMD: cent(inst.bank_balance_gmd), EUR: cent(inst.bank_balance_eur) } };
  A.instelling_gelijk = A.saldo_instelling.GMD === saldo.GMD && A.saldo_instelling.EUR === saldo.EUR;
  const bVan = inst.recon_b_from || '9999';
  const chequesB = [...new Set(rek.GMD.filter((b) => b.soort === 'Cheque withdrawal' && b.datum >= bVan && b.cheque).map((b) => b.cheque))]
    .sort((x, y) => Number(x) - Number(y)).map((c) => {
      const op = -som(rek.GMD.filter((b) => b.soort === 'Cheque withdrawal' && b.cheque === c), (b) => b.bedrag_cent);
      const spec = som(d.uitgaven.filter((u) => u.cheque === c && u.bewijs === 'Handwritten list'), (u) => u.gmd_cent);
      return { cheque: c, opgenomen: op, gespecificeerd: spec, niet: op - spec };
    });
  const B = { vanaf: bVan, cheques: chequesB, opgenomen: som(chequesB, (x) => x.opgenomen), gespecificeerd: som(chequesB, (x) => x.gespecificeerd), niet: som(chequesB, (x) => x.niet) };
  const C = { kwartalen: omwKw, totaal: omwTot };
  const uitbetaald = -som(rek.GMD.filter((b) => ['Cheque withdrawal', 'Cash withdrawal', 'Payment to supplier', 'Reversal'].indexOf(b.soort) >= 0), (b) => b.bedrag_cent);
  const gespec = som(d.uitgaven.filter((u) => u.betaald_van === 'GMD (ECG)' && u.regel !== '15.1'), (u) => u.gmd_cent);
  const contantGmd = Math.round(ecgEur.contant * cashKoers);
  const D = { uitbetaald, gespecificeerd: gespec, verschil_gmd_rekening: uitbetaald - gespec, contant_eur: ecgEur.contant, contant_koers: cashKoers,
    contant_gmd: contantGmd, niet_gespecificeerd: uitbetaald - gespec + contantGmd };
  D.niet_gespecificeerd_eur = r2(D.niet_gespecificeerd / 100 / koers);
  const E = { opgehaald: groep('opgehaald'), kosten: -groep('kosten'), wilde_ganzen: -groep('wg'), naar_ecg: -groep('ecg'), intern: groep('intern') };
  E.onbekend = groep('onbekend');   // wv2880: uit de bank, nog niet ingedeeld; telt mee zodat het saldo sluit
  E.berekend = E.opgehaald - E.kosten - E.wilde_ganzen - E.naar_ecg + E.onbekend;
  E.afschrift = ghawaAfschrift; E.verschil = E.berekend - E.afschrift; E.keten_breuken = d.ghawaKetenBreuken;
  E.ecg_2026 = som(naarEcg.filter((x) => x.van === 'Stichting GHAWA (Triodos)' && x.datum >= '2026-01-01'), (x) => x.eur)
    - som(rek.EUR.filter((b) => b.soort === 'Transfer in from NL' && b.datum >= '2026-01-01'), (b) => b.bedrag_cent);
  const F = { ontvangen: cent(inst.wg_received_gmd), gerapporteerd: som(d.uitgaven, (u) => u.wg_cent) };
  F.verschil = F.ontvangen === null ? null : F.ontvangen - F.gerapporteerd;
  const G = d.opnameUitleg.map((g) => ({ wat: g.wat, gmd: g.gmd_cent, uitleg: g.uitleg }));
  const aansluiting = { A, B, C, D, E, F, G };
  const sluit = A.verschil === 0 && A.breuken === 0 && E.verschil === 0 && E.keten_breuken === 0 && F.verschil === 0 && bouw.controle === 0;

  // wv2880: per bron tot wanneer de cijfers lopen (uitgaven en bonnen nog uit de overdracht; bank en afschriften bijgehouden)
  const vandaag = d.vandaag || new Date().toISOString().slice(0, 10);
  const standen = { uitgaven: inst.as_of_date || null, ghawa: ghawaDatum || null, ecg_gmd: laatsteDatum.GMD, ecg_eur: laatsteDatum.EUR };
  return { koers, datastand: inst.as_of_date || null, standen, vandaag, regels, activiteiten, fasen, bouw, apotheek: apo, ecg: { eur: ecgEur, gmd: ecgGmd, keten },
    omwisselingen: omw, naar_ecg: naarEcg, naar_wg: naarWg, ghawa: { per_jaar: ghawaPerJaar, jaren, eind_jaar: ghawaEindJaar, saldo: ghawaSaldo,
      afschrift: ghawaAfschrift, datum: ghawaDatum, geoormerkt: bijGhawaGeoormerkt }, werven, aansluiting, sluit, signalen };
}

// ── routes voor de app ──
// Antwoorden in centen (gehele getallen); de app deelt door 100. Nooit bankregel_ghawa- of donateurvelden.
const STATUS_OPEN = /^(open|partly answered)$/i;
function overzicht(d, k) {
  const vragenOpen = d.vragen.filter((v) => STATUS_OPEN.test(v.status || ''));
  const aandacht = [];
  if (k.aansluiting.D.niet_gespecificeerd > 0) aandacht.push({ toon: 'wacht', label: 'bonnen', titel: 'Opgenomen maar nog niet gespecificeerd',
    sub: 'GMD ' + Math.round(k.aansluiting.D.niet_gespecificeerd / 100).toLocaleString('nl-NL') + ' (± € ' + Math.round(k.aansluiting.D.niet_gespecificeerd_eur).toLocaleString('nl-NL') + '); vraag Q06 bij ECG', gmd: k.aansluiting.D.niet_gespecificeerd });
  if (k.aansluiting.B.niet > 0) aandacht.push({ toon: 'wacht', label: 'cheques', titel: 'Cheques zonder lijst',
    sub: k.aansluiting.B.cheques.filter((c) => c.niet > 0).map((c) => 'cheque ' + c.cheque).join(', '), gmd: k.aansluiting.B.niet });
  for (const f of d.fondsen.filter((x) => x.status === 'Committed - not yet received')) aandacht.push({ toon: 'info', label: 'toezegging',
    titel: f.gever + ': € ' + Math.round(f.eur_cent / 100).toLocaleString('nl-NL') + ' nog niet binnen', sub: 'bedoeld voor ' + (f.doel || f.project || '').toLowerCase() });
  if (!k.sluit) aandacht.push({ toon: 'fout', label: 'sluit niet', titel: 'Een aansluiting sluit niet op de cent', sub: 'zie Geldstromen › Sluit het?' });
  // wv2880 (fase 2): signalen van het bijhouden, posten om in te delen, termijnen van fondsen, AFAS-geld binnen maar nog toegezegd
  for (const s of d.signalen || []) aandacht.push({ toon: 'fout', label: s.soort === 'bank' ? 'bank' : 'afschrift', titel: s.tekst, sub: 'sinds ' + String(s.op).slice(0, 10), scherm: 'ronde' });
  const onb = (d.ghawaBank && d.ghawaBank.onbekend) || 0;
  if (onb) aandacht.push({ toon: 'wacht', label: 'indelen', titel: onb + (onb === 1 ? ' bankregel' : ' bankregels') + ' van GHAWA nog in te delen', sub: 'één tik per regel', scherm: 'indelen' });
  for (const t of termijnen(d, k.vandaag)) aandacht.push({ toon: t.dagen < 0 ? 'fout' : 'info', label: 'termijn', titel: t.gever + ': ' + (t.dagen < 0 ? 'termijn verlopen' : 'termijn over ' + t.dagen + (t.dagen === 1 ? ' dag' : ' dagen')),
    sub: 'op ' + t.termijn, scherm: 'fondsen' });
  const afas = afasBank(d);
  if (afas.binnen_niet_geboekt > 0) aandacht.push({ toon: 'info', label: 'fonds', titel: 'AFAS-geld binnen op de bank, nog als toegezegd geboekt',
    sub: '€ ' + Math.round(afas.binnen_niet_geboekt / 100).toLocaleString('nl-NL') + ' · zet de toezegging op ontvangen', scherm: 'fondsen' });
  return { datastand: k.datastand, standen: k.standen, sluit: k.sluit, koers: k.koers, werven: k.werven,
    bouw: { begroot: k.bouw.begroot, gerealiseerd: k.bouw.gerealiseerd, niet_nodig: k.bouw.niet_nodig, open: k.bouw.open, open_eur: k.bouw.open_eur, pct: k.bouw.pct },
    apotheek: { begroot: k.apotheek.begroot, open: k.apotheek.open, open_eur: k.apotheek.open_eur },
    fasen: k.fasen.map((f) => ({ id: f.id, naam: f.naam, omschrijving: f.omschrijving, begroot: f.begroot, gerealiseerd: f.gerealiseerd, niet_nodig: f.niet_nodig, open: f.open, pct: f.pct })),
    ecg: { eur: k.ecg.eur.saldo, eur_datum: k.ecg.eur.datum, gmd: k.ecg.gmd.saldo, gmd_datum: k.ecg.gmd.datum },
    ghawa: { saldo: k.ghawa.saldo, geoormerkt: k.ghawa.geoormerkt, datum: k.ghawa.datum },
    vragen: { open: vragenOpen.length, totaal: d.vragen.length }, aandacht };
}
function bouwRoute(d, k, project) {
  const acts = k.activiteiten.filter((a) => a.project === project).map((a) => { const x = Object.assign({}, a); return x; });
  const fasen = project === 'Building' ? k.fasen : [{ id: 'Pharmacy', naam: 'Apotheek', omschrijving: 'apart project, gesponsord door AFAS',
    begroot: k.apotheek.begroot, gerealiseerd: k.apotheek.gerealiseerd, niet_nodig: k.apotheek.niet_nodig, open: k.apotheek.open, overschrijding: k.apotheek.overschrijding }];
  const totaal = project === 'Building' ? k.bouw : k.apotheek;
  const r = { datastand: k.datastand, koers: k.koers, fasen, activiteiten: acts,
    totaal: { begroot: totaal.begroot, gerealiseerd: totaal.gerealiseerd, niet_nodig: totaal.niet_nodig, open: totaal.open, overschrijding: totaal.overschrijding, open_eur: totaal.open_eur } };
  if (project === 'Pharmacy') {
    r.regels = k.regels.filter((x) => /^P/.test(x.activiteit));
    r.fondsen = d.fondsen.filter((f) => f.project === 'Pharmacy').map((f) => ({ id: f.id, gever: f.gever, eur: f.eur_cent, datum: f.datum, status: f.status, waar: f.waar }));
    r.werven = { open_eur: k.werven.apo_open, oormerk: k.werven.oormerk_apo, overschot: k.werven.apo_overschot };
  }
  return r;
}
function activiteitRoute(d, k, nr) {
  const a = k.activiteiten.find((x) => x.nr === nr);
  if (!a) return null;
  const regels = k.regels.filter((r) => r.activiteit === nr).map((r) => Object.assign({}, r, {
    uitgaven: d.uitgaven.filter((u) => u.regel === r.id).map((u) => ({ id: u.id, datum: u.datum, omschrijving: u.omschrijving, referentie: u.referentie,
      gmd: u.gmd_cent, betaald_van: u.betaald_van, betaalwijze: u.betaalwijze, cheque: u.cheque, bewijs: u.bewijs, bron: u.bron, notitie: u.notitie, wg_post: u.wg_post })) }));
  return { datastand: k.datastand, koers: k.koers, activiteit: a, regels };
}
function geldRoute(d, k) {
  return { datastand: k.datastand, standen: k.standen, koers: k.koers, ghawa: k.ghawa, naar_wg: k.naar_wg, naar_ecg: k.naar_ecg, omwisselingen: k.omwisselingen, ecg: k.ecg,
    fondsen: d.fondsen.map((f) => ({ id: f.id, gever: f.gever, soort: f.soort, project: f.project, doel: f.doel, eur: f.eur_cent, datum: f.datum, status: f.status, waar: f.waar })),
    werven: k.werven, aansluiting: k.aansluiting, sluit: k.sluit };
}
function vragenRoute(d, k) {
  return { datastand: k.datastand, vragen: d.vragen.map((v) => ({ id: v.id, onderwerp: v.onderwerp, vraag: v.vraag, gmd: v.gmd_cent, wie: v.wie, status: v.status, antwoord: v.antwoord })),
    concept: vragenConcept(d) };
}
// wv2880: de open vragen als één conceptbericht in het Engels (David kopieert en verstuurt zelf; de pod stuurt niets naar ECG)
function vragenConcept(d) {
  const open = d.vragen.filter((v) => STATUS_OPEN.test(v.status || '') && !/david|ghawa/i.test(v.wie || ''));
  if (!open.length) return null;
  const r = ['Dear Momodou,', '', 'To keep the finances of the health centre up to date, could you help me with these open questions?', ''];
  for (const v of open) r.push('- ' + v.id + ' (' + (v.onderwerp || 'question') + '): ' + String(v.vraag || '').replace(/\s+/g, ' ').trim() +
    (v.gmd_cent ? ' [GMD ' + Math.round(v.gmd_cent / 100).toLocaleString('en-GB') + ']' : ''));
  r.push('', 'Thank you very much.', '', 'Kind regards,', 'David');
  return r.join('\n');
}
// ── wv2880 (fase 2): fondsen en dossiers, donateurs (INTERN), indelen (INTERN), maandronde ──
const DOSSIER = [[/wilde ganzen/i, 'Wilde Ganzen'], [/afas/i, 'AFAS Foundation'], [/rotary/i, 'Rotary Club Leusden'], [/rota\b/i, 'ROTA'], [/ghawa/i, 'Stichting GHAWA']];
const dossierVan = (g) => { const x = DOSSIER.find((d) => d[0].test(g || '')); return x ? x[1] : g; };
function termijnen(d, vandaag) {
  return d.fondsen.filter((f) => f.termijn && !/^Received/.test(f.status || '') && f.status !== 'Withdrawn').map((f) => ({ id: f.id, gever: dossierVan(f.gever), termijn: f.termijn,
    dagen: Math.round((Date.parse(f.termijn) - Date.parse(vandaag)) / 86400000) })).filter((t) => t.dagen <= 30).sort((a, b) => a.dagen - b.dagen);
}
function afasBank(d) {   // AFAS-betalingen volgens de GHAWA-bank tegenover wat als ontvangen geboekt staat
  const bank = som(d.ghawaPerSoortJaar.filter((x) => x.soort === 'Sponsor AFAS (pharmacy)'), (x) => x.cent);
  const geboekt = som(d.fondsen.filter((f) => /afas/i.test(f.gever) && /^Received/.test(f.status || '')), (f) => f.eur_cent);
  return { bank, geboekt, binnen_niet_geboekt: Math.max(0, bank - geboekt) };
}
function fondsenRoute(d, k) {
  const BIJ = require('./ghawa-bij.js');
  const groepen = new Map();
  for (const f of d.fondsen) {
    const n = dossierVan(f.gever);
    if (!groepen.has(n)) groepen.set(n, []);
    groepen.get(n).push(f);
  }
  const log = d.fondsLog || [];
  const dossiers = [...groepen.entries()].map(([naam, fs]) => {
    const s = (re) => som(fs.filter((f) => re.test(f.status || '')), (f) => f.eur_cent);
    const t = fs.map((f) => f.termijn).filter(Boolean).sort();
    return { naam, toegezegd: s(/^Committed/), ontvangen: s(/^Received/), verwacht_per_jaar: s(/^Expected/),
      oormerk: [...new Set(fs.map((f) => f.doel || f.project).filter(Boolean))].join(', ') || null, termijn: t[0] || null,
      fondsen: fs.map((f) => ({ id: f.id, gever: f.gever, soort: f.soort, project: f.project, doel: f.doel, eur: f.eur_cent, datum: f.datum, status: f.status,
        waar: f.waar, notitie: f.notitie, termijn: f.termijn || null, gewijzigd_op: f.gewijzigd_op || null })),
      log: log.filter((l) => fs.some((f) => f.id === l.fonds)).slice(0, 5) };
  });
  return { datastand: k.datastand, standen: k.standen, dossiers, statussen: BIJ.FONDS_STATUS, afas: afasBank(d), termijnen: termijnen(d, k.vandaag) };
}
// INTERN (eigen app, nooit in een gedeelde route): giften per donateur per jaar. Geen rekeningnummers.
function donateursRoute(dbPad) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPad, { readOnly: true });
  try {
    const rijen = db.prepare("SELECT COALESCE(donateur, '(zonder naam)') AS naam, jaar, SUM(bedrag_cent) AS cent, COUNT(*) AS n, MAX(datum) AS laatste " +
      "FROM bankregel_ghawa WHERE soort LIKE 'Donation%' GROUP BY 1, 2").all();
    const vast = new Map(db.prepare('SELECT naam, soort, vast, verwacht_cent FROM donateur').all().map((x) => [x.naam, x]));
    const jaren = [...new Set(rijen.map((r) => r.jaar))].sort();
    const per = new Map();
    for (const r of rijen) {
      if (!per.has(r.naam)) per.set(r.naam, { naam: r.naam, per_jaar: {}, totaal: 0, giften: 0, laatste: '' });
      const p = per.get(r.naam); p.per_jaar[r.jaar] = (p.per_jaar[r.jaar] || 0) + r.cent; p.totaal += r.cent; p.giften += r.n; if (r.laatste > p.laatste) p.laatste = r.laatste;
    }
    const donateurs = [...per.values()].map((p) => { const v = vast.get(p.naam); return Object.assign(p, { soort: v ? v.soort : null, vast: v ? v.vast : null, verwacht: v ? v.verwacht_cent : null }); })
      .sort((a, b) => b.totaal - a.totaal);
    const totaal = Object.fromEntries(jaren.map((j) => [j, som(rijen.filter((r) => r.jaar === j), (r) => r.cent)]));
    return { intern: true, jaren, donateurs, totaal, aantal: donateurs.length };
  } finally { db.close(); }
}
function indelenRoute(dbPad, vandaag) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPad, { readOnly: true });
  try {
    const vanaf = new Date(Date.parse(vandaag) - 60 * 86400000).toISOString().slice(0, 10);
    const vorm = (r) => ({ id: r.id, rekening: /^Savings/.test(r.rekening) ? 'spaar' : 'betaal', datum: r.datum, bedrag: r.bedrag_cent, tegenpartij: r.tegenpartij,
      omschrijving: r.omschrijving ? String(r.omschrijving).slice(0, 60) : null, soort: r.soort, door: r.soort_door });
    const sel = 'SELECT id, rekening, datum, bedrag_cent, tegenpartij, omschrijving, soort, soort_door FROM bankregel_ghawa WHERE herkomst = \'bank\' ';
    return { intern: true, soorten: GHAWA_SOORTEN.filter((s) => s[1] !== 'onbekend').map((s) => ({ id: s[0], naam: s[2], groep: s[1] })),
      onbekend: db.prepare(sel + "AND soort = 'Unknown' ORDER BY datum, volg").all().map(vorm),
      recent: db.prepare(sel + "AND soort <> 'Unknown' AND datum >= ? ORDER BY datum DESC, volg DESC LIMIT 60").all(vanaf).map(vorm) };
  } finally { db.close(); }
}
function rondeRoute(d, k, bijInfo) {
  const BIJ = require('./ghawa-bij.js');
  const nu = k.vandaag, maand = nu.slice(0, 7);
  const af = new Set((d.ronde || []).filter((r) => r.maand === maand).map((r) => r.stap));
  const oud = (x) => BIJ.dagen(x, nu);
  const spaar = d.meta.spaar_upload_op || null;
  const ecgOud = Math.max(oud(k.standen.ecg_gmd) || 0, oud(k.standen.ecg_eur) || 0);
  const onb = (d.ghawaBank && d.ghawaBank.onbekend) || 0;
  const vragenOpen = d.vragen.filter((v) => STATUS_OPEN.test(v.status || '')).length;
  const nl = (x) => (x && /^\d{4}-\d{2}-\d{2}/.test(x) ? Number(x.slice(8, 10)) + '-' + Number(x.slice(5, 7)) + '-' + x.slice(0, 4) : '—');
  const stappen = [
    { id: 'afschriften', titel: 'Afschriften erin', klaar: ecgOud <= 35 && (!spaar || oud(spaar) <= 35),
      tekst: 'ECG euro t/m ' + nl(k.standen.ecg_eur) + ', dalasi t/m ' + nl(k.standen.ecg_gmd) + '; GHAWA-bank vanzelf t/m ' + nl(k.standen.ghawa) +
        (spaar ? '; spaarrekening laatst in Facturen gezet op ' + nl(spaar) : '') },
    { id: 'indelen', titel: 'Onbekende posten indelen', klaar: onb === 0, tekst: onb ? onb + ' nog in te delen' : 'alles ingedeeld' },
    { id: 'aansluiting', titel: 'Aansluiting bekijken', klaar: af.has('aansluiting'), sluit: k.sluit, tekst: k.sluit ? 'sluit op de cent' : 'een aansluiting sluit niet', afvinken: true },
    { id: 'vragen', titel: 'Open vragen als concept naar ECG', klaar: af.has('vragen'), tekst: vragenOpen + ' open vragen; jij verstuurt', afvinken: true },
    { id: 'delen', titel: 'Gedeelde stand verversen', klaar: false, later: true, tekst: 'komt met het delen met ECG (fase 5)' },
  ];
  return { maand, stappen, afschriften: d.afschriften || [], signalen: d.signalen || [], standen: k.standen, bank: bijInfo || null,
    ecg_dagen: ecgOud, stil: ecgOud <= 35 };
}
const SOORT = { md: 'tekst', pdf: 'pdf', xlsx: 'Excel', docx: 'Word', html: 'webpagina', jpg: 'foto', jpeg: 'foto', png: 'foto', csv: 'csv' };
function documentenRoute(bronnenMap, vaultMap) {
  const uit = [];
  if (!bronnenMap || !fs.existsSync(bronnenMap)) return { map: null, stukken: [] };
  const loop = (m, diepte) => {
    for (const e of fs.readdirSync(m, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const p = path.join(m, e.name);
      if (e.isDirectory()) { if (diepte < 3) loop(p, diepte + 1); continue; }
      if (!e.isFile()) continue;
      const ext = (e.name.split('.').pop() || '').toLowerCase();
      const rel = path.relative(bronnenMap, p);
      uit.push({ naam: e.name, map: path.dirname(rel) === '.' ? '' : path.dirname(rel), soort: SOORT[ext] || ext, bytes: fs.statSync(p).size,
        vault: vaultMap ? path.relative(vaultMap, p) : null,
        intern: /Financial overview\.xlsx$|GHAWA_(Bank|Donors)/i.test(e.name) });
    }
  };
  loop(bronnenMap, 0);
  return { map: vaultMap ? path.relative(vaultMap, bronnenMap) : null, stukken: uit };
}

function maak(cfg) {
  const c = cfg || {};
  const BIJ = require('./ghawa-bij.js');
  let laatste = null, bijLaatst = 0, bijUitkomst = null, gemigreerd = false;
  const nuIso = () => (c.nu ? c.nu() : new Date().toISOString());
  const vandaag = () => nuIso().slice(0, 10);
  function schrijf(fn) {   // korte schrijfverbinding; schema van fase 2 bij de eerste keer
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(c.dbPad);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      if (!gemigreerd) { db.exec('BEGIN IMMEDIATE'); try { BIJ.migreer(db); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } gemigreerd = true; }
      return fn(db);
    } finally { db.close(); }
  }
  // GHAWA-bank bijwerken uit Facturen: bij het openen van een scherm, hooguit eens per 10 minuten (of direct met dwing)
  function bankBij(dwing) {
    if (!c.facturenPad || !c.dbPad || !fs.existsSync(c.dbPad)) return null;
    const t = Date.now();
    if (!dwing && t - bijLaatst < 10 * 60000) return bijUitkomst;
    bijLaatst = t;
    try { bijUitkomst = Object.assign({ op: nuIso() }, schrijf((db) => BIJ.bankBij(db, c.facturenPad, { nu: nuIso(), rekeningen: c.ghawaRekeningen }))); }
    catch (e) { bijUitkomst = { op: nuIso(), uitkomst: 'fout' }; if (c.fout) c.fout(e); }
    return bijUitkomst;
  }
  function lees() { const d = leesData(c.dbPad); d.vandaag = vandaag(); return d; }
  function app(v) {
    const pad = String((v && v.pad) || '');
    const post = !!(v && v.methode === 'POST');
    const m = /^\/app\/ghawa(?:\/([a-z]+))?(?:\/([A-Za-z0-9]{1,4}))?$/.exec(pad);
    if (!m) return { status: 404, body: { ok: false, fout: 'onbekend' }, reden: 'ghawa onbekend' };
    const scherm = m[1] || 'overzicht';
    if (!post && scherm === 'documenten') return { status: 200, body: Object.assign({ ok: true }, documentenRoute(c.bronnenMap, c.vaultMap)), reden: 'ghawa documenten' };
    if (!c.dbPad || !fs.existsSync(c.dbPad)) return { status: 503, body: { ok: false, fout: 'De GHAWA-databank is er nog niet' }, reden: 'ghawa geen databank' };
    if (post) return schrijfRoute(scherm, (v && v.body) || {}, v);
    const t0 = Date.now();
    if (!gemigreerd) schrijf(() => null);
    const bij = ['overzicht', 'geld', 'indelen', 'ronde', 'donateurs', 'fondsen'].indexOf(scherm) >= 0 ? bankBij(false) : bijUitkomst;
    const d = lees();
    const k = bereken(d);
    let body;
    if (scherm === 'overzicht') body = overzicht(d, k);
    else if (scherm === 'bouw') body = bouwRoute(d, k, 'Building');
    else if (scherm === 'apotheek') body = bouwRoute(d, k, 'Pharmacy');
    else if (scherm === 'activiteit' && m[2]) body = activiteitRoute(d, k, m[2]);
    else if (scherm === 'geld') body = geldRoute(d, k);
    else if (scherm === 'vragen') body = vragenRoute(d, k);
    else if (scherm === 'fondsen') body = fondsenRoute(d, k);
    else if (scherm === 'ronde') body = rondeRoute(d, k, bij);
    else if (scherm === 'donateurs') body = donateursRoute(c.dbPad);   // INTERN
    else if (scherm === 'indelen') body = indelenRoute(c.dbPad, k.vandaag);   // INTERN
    if (!body) return { status: 404, body: { ok: false, fout: 'onbekend' }, reden: 'ghawa onbekend ' + scherm };
    laatste = { op: nuIso(), scherm, ms: Date.now() - t0, sluit: k.sluit };
    return { status: 200, body: Object.assign({ ok: true, invoer_op: d.meta.invoer_op || null }, body), reden: 'ghawa ' + scherm + (k.sluit ? '' : ' sluit niet') };
  }
  // POST /app/ghawa/{indelen,fonds,afschrift,ronde,bank}. Geen inhoud in de reden (die komt in de auditregel): alleen id's en aantallen.
  function schrijfRoute(scherm, b, v) {
    const nu = nuIso();
    let r;
    if (scherm === 'indelen') r = schrijf((db) => BIJ.indelen(db, b.id, b.soort, GHAWA_SOORTEN, nu));
    else if (scherm === 'fonds') r = schrijf((db) => BIJ.fondsZet(db, b.id, { status: b.status, termijn: b.termijn, bevestigd: b.bevestigd }, nu, (v && v.door) || 'app'));
    else if (scherm === 'ronde') r = schrijf((db) => BIJ.rondeZet(db, String(b.stap || ''), b.aan !== false, nu));
    else if (scherm === 'bank') r = Object.assign({ ok: true }, bankBij(true));
    else if (scherm === 'afschrift') {
      const b64 = typeof b.bestand === 'string' ? b.bestand : '';
      if (!b64 || b64.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) return { status: 400, body: { ok: false, fout: 'geen bestand (hooguit 10 MB)' }, reden: 'ghawa afschrift leeg' };
      const bytes = Buffer.from(b64, 'base64');
      r = schrijf((db) => BIJ.ecgAfschrift(db, { naam: b.naam, bytes }, { csvLees }, { nu }));
    } else return { status: 404, body: { ok: false, fout: 'onbekend' }, reden: 'ghawa onbekend POST ' + scherm };
    const st = r.ok === false ? (r.status || 400) : 200;
    const kort = scherm === 'afschrift' ? (r.uitkomst || '') + ' ' + (r.munt || '') + ' nieuw ' + (r.nieuw || 0) : scherm === 'bank' ? (r.uitkomst || '') + ' ' + (r.nieuw || 0)
      : scherm === 'indelen' ? String(b.id || '').slice(0, 8) : scherm === 'fonds' ? String(b.id || '').slice(0, 6) : String(b.stap || '').slice(0, 12);
    const body = Object.assign({}, r); delete body.status;
    return { status: st, body: Object.assign({ ok: st === 200 }, body), reden: 'ghawa POST ' + scherm + ' ' + kort };
  }
  // Maandronde: kaart als de ECG-cijfers ouder zijn dan 35 dagen (één per maand); de server roept dit eens per dag aan.
  function maandKaart() {
    if (!c.dbPad || !fs.existsSync(c.dbPad)) return null;
    if (!gemigreerd) schrijf(() => null);
    const d = lees(); const k = bereken(d);
    if (d.meta['kaart:ghawa-maandronde-' + nuIso().slice(0, 7)]) return null;   // deze maand al gezet: nooit dubbel
    return BIJ.rondeKaart({ afschrift_ooit: (d.afschriften || []).some((a) => a.uitkomst === 'overgenomen') || d.ecgAfschrift > 0, ecg_gmd: k.standen.ecg_gmd, ecg_eur: k.standen.ecg_eur }, nuIso());
  }
  function info() {
    const u = { aan: true, databank: !!(c.dbPad && fs.existsSync(c.dbPad)), laatste, bank: bijUitkomst ? { op: bijUitkomst.op, uitkomst: bijUitkomst.uitkomst, nieuw: bijUitkomst.nieuw || 0 } : null };
    return u;
  }
  function kaartGezet(sleutel) { schrijf((db) => db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('kaart:' + String(sleutel).slice(0, 60), nuIso())); }
  return { app, info, bankBij, maandKaart, kaartGezet };
}

module.exports = { maak, invoer, leesData, bereken, csvLees, cent, SCHEMA, TABELLEN, GHAWA_SOORTEN, donateursRoute, indelenRoute };

if (require.main === module) {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (cmd === 'invoer' && a1 && a2) { process.stdout.write(JSON.stringify(invoer(a1, a2, { forceer: process.argv.includes('--forceer') })) + '\n'); }
  else if (cmd === 'reken' && a1) {
    const k = bereken(leesData(a1));
    process.stdout.write(JSON.stringify({ datastand: k.datastand, sluit: k.sluit, bouw: k.bouw, apotheek: k.apotheek, werven: k.werven,
      aansluiting: { A: { verschil: k.aansluiting.A.verschil, breuken: k.aansluiting.A.breuken }, D: k.aansluiting.D, E: k.aansluiting.E, F: k.aansluiting.F } }) + '\n');
  } else { process.stderr.write('gebruik: node ghawa.js invoer <csv-map> <db> | reken <db>\n'); process.exit(2); }
}
