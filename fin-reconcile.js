'use strict';
/*
 * fin-reconcile.js — dekking per dag + aansluiting bank ↔ inkoopfacturen, als rekenproduct (wv1864, Second Brain 2.0 fase 4a, 28-10-2026).
 *
 * WAAROM. "Welke inkoopfacturen van Tolgaarde zijn betaald, deels, open of niet te beoordelen — en hoe zeker is dat?" Een antwoord daarop
 * mag nooit op een onvolledige bank rusten zonder dat te zeggen (ontbrekend is geen nul). Ontwerp: vault 01_Ontwikkeling/Second Brain 2.0 -
 * fase 4 financiële pilot Tolgaarde (ontwerp 28-10-2026).md § 3.1, 3.2, 3.4–3.6. De koppelregels zelf staan in fin-toewijzing.js (puur).
 *
 * WAT. (1) Momentopname: VACUUM INTO van de Facturen-databank (alleen-lezen verbinding) naar <dir>/snapshot/<sha256>.sqlite (map 700,
 * bestand 600); alles wordt daarop gerekend, nooit op de levende databank, en er wordt nooit in de Facturen-databank geschreven.
 * (2) Dekking per dag (§ 3.4): per bewaard bronbestand (bankbron/<sha256>, sha256 nagerekend) de regels van de rekening, de saldoketen per
 * regel en het aantal + de som per dag; een dag is 'gedekt' als een bronbestand met sluitende keten hem dekt en de databank op die dag
 * hetzelfde aantal en dezelfde som heeft (verwijderde regels tellen niet). De laatste dag van een bestand telt alleen als het bestand na die
 * dag gemaakt is (ABN-naam TXTjjmmddhhmmss, anders de uploaddatum). (3) Aansluiting (fin-toewijzing.sluitAan). (4) Opslag in
 * <dir>/reken.sqlite (map 700, bestand 600): reken_run, dekking, aansluiting, onverklaard, besluit. Bedragen en tegenpartijen blijven hier op
 * de pod. Twee keer rekenen op dezelfde momentopname geeft byte-gelijke uitkomsttabellen (uitkomst_hash, zonder run-id en tijden).
 *
 * Terugrol: map <dir> weg (de Facturen-app merkt niets). CLI: tools/fin-reconcile.js (of node fin-reconcile.js run|stand|besluit|opruim|droog).
 * droog (SB2 fase 6a, wv1962): dezelfde berekening op een bestaand facturenbestand, zonder schrijven en zonder klok (referentie voor de
 * herstelproef; nachtketen-stap sb2-herstelreferentie).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const B = require('./facturen-bank.js');
const K = require('./facturen-kern.js');
const T = require('./fin-toewijzing.js');

const STANDAARD_DIR = '/opt/data/fin-reken';
const STANDAARD_FACTUREN = '/opt/data/facturen/facturen.sqlite';
const MAX_FACTUREN = 5000, MAX_DAGEN = 4000, BEWAAR_DAGEN = 90;
const ARCHIEF_IN = ['beslist'];
const ARCHIEF_UIT = ['genegeerd', 'geen_factuur'];
// Facturen-app: vanaf verstuurd/ingevoerd, niet concept_klaar (§ 3.5)
const APP_SPOREN = ['ingevoerd', 'incasso_verwacht', 'betaald_vooraf', 'betaald_gezien'];
const APP_NIET = ['concept_klaar', 'te_beoordelen', 'geen_factuur', 'dubbel', 'prive_archief'];

class FinFout extends Error { constructor(code, uitleg) { super(code + ': ' + uitleg); this.code = code; this.uitleg = uitleg; } }

function sqlite() { return require('node:sqlite').DatabaseSync; }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function canon(x) { return JSON.stringify(x); }
// Map 700. Een bestaande map die niet van ons is (geen reken.sqlite/snapshot, niet leeg, bv. een verkeerde --dir als /opt/data) raken we niet aan.
function maakMap(p) {
  if (fs.existsSync(p)) {
    const inhoud = fs.readdirSync(p);
    const eigen = inhoud.every((n) => /^(reken\.sqlite(-journal|-wal|-shm)?|snapshot|\.tmp-.*|[0-9a-f]{64}\.sqlite)$/.test(n));
    if (!eigen) throw new FinFout('map_onveilig', 'de map bevat bestanden die niet van de aansluiting zijn; kies een eigen map');
  }
  fs.mkdirSync(p, { recursive: true, mode: 0o700 }); fs.chmodSync(p, 0o700);
}
function dagAmsterdam(ms) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
function tijdAmsterdam(ms) {
  const p = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const v = (t) => (p.find((x) => x.type === t) || {}).value;
  return v('day') + '-' + v('month') + ' ' + v('hour') + ':' + v('minute');
}
function dagNL(d) { return d ? Number(d.slice(8, 10)) + '-' + Number(d.slice(5, 7)) + '-' + d.slice(0, 4) : '?'; }
function eind4(iban) { return '…' + String(iban || '').slice(-4); }

// ───────────────────────────── reken.sqlite ─────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reken_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  soort TEXT NOT NULL CHECK (soort = 'finance.reconcile'),
  entiteit TEXT NOT NULL, rekening_label TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
  invoer_vingerafdruk TEXT NOT NULL CHECK (length(invoer_vingerafdruk) = 64),
  scope TEXT NOT NULL CHECK (json_valid(scope)),
  regels_versie TEXT NOT NULL, regels_hash TEXT NOT NULL,
  gestart_op TEXT NOT NULL, klaar_op TEXT,
  uitkomst TEXT CHECK (uitkomst IS NULL OR uitkomst IN ('antwoord','onvolledig','fout')),
  code TEXT, bank_tm TEXT, laatst_gedekt TEXT,
  telling TEXT CHECK (telling IS NULL OR json_valid(telling)),
  totalen TEXT CHECK (totalen IS NULL OR json_valid(totalen)),
  aannames TEXT CHECK (aannames IS NULL OR json_valid(aannames)),
  bronnen TEXT CHECK (bronnen IS NULL OR json_valid(bronnen)),
  dekkingsregel TEXT,
  uitkomst_hash TEXT
);
CREATE TABLE IF NOT EXISTS dekking (
  run INTEGER NOT NULL REFERENCES reken_run(id),
  rekening_label TEXT NOT NULL,
  dag TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('gedekt','alleen_databank','afwijkend','ontbreekt')),
  reden TEXT,
  db_regels INTEGER NOT NULL, db_som_centen INTEGER NOT NULL,
  PRIMARY KEY (run, dag)
);
CREATE TABLE IF NOT EXISTS aansluiting (
  run INTEGER NOT NULL REFERENCES reken_run(id),
  factuur_ref TEXT NOT NULL,
  leverancier TEXT, nummer TEXT, factuurdatum TEXT, vervaldatum TEXT,
  status TEXT NOT NULL CHECK (status IN ('onbepaald_gegevens','betaald','deels','overbetaald','kandidaat','elders_voldaan','onbepaald_dekking','nog_niet_te_beoordelen','open')),
  reden TEXT, laag INTEGER CHECK (laag IS NULL OR laag BETWEEN 0 AND 2),
  factuurbedrag_centen INTEGER, betaald_centen INTEGER, rest_centen INTEGER, betaaldatum TEXT,
  entry_refs TEXT NOT NULL CHECK (json_valid(entry_refs)),
  kandidaat_refs TEXT NOT NULL CHECK (json_valid(kandidaat_refs)),
  PRIMARY KEY (run, factuur_ref)
);
CREATE TABLE IF NOT EXISTS onverklaard (
  run INTEGER NOT NULL REFERENCES reken_run(id),
  entry_ref TEXT NOT NULL,
  boekdatum TEXT NOT NULL, bedrag_centen INTEGER NOT NULL,
  tegenpartij_naam TEXT, omschrijving TEXT,
  reden TEXT NOT NULL CHECK (reden IN ('geen_factuur','kandidaat','mogelijk_dubbel_betaald')),
  factuur_ref TEXT,
  PRIMARY KEY (run, entry_ref)
);
-- Mensbesluit over een koppeling (§ 3.1 punt 7): alleen na een expliciet antwoord van David (bron = de vraag in Open vragen).
CREATE TABLE IF NOT EXISTS besluit (
  id INTEGER PRIMARY KEY,
  factuur_ref TEXT NOT NULL CHECK (factuur_ref GLOB 'archief:*' OR factuur_ref GLOB 'factuur:*'),
  entry_refs TEXT NOT NULL CHECK (json_valid(entry_refs) AND json_type(entry_refs) = 'array' AND json_array_length(entry_refs) >= 1),
  oordeel TEXT NOT NULL CHECK (oordeel IN ('ja','nee')),
  wie TEXT NOT NULL, wanneer TEXT NOT NULL, bron TEXT NOT NULL CHECK (length(bron) BETWEEN 3 AND 300),
  toelichting TEXT CHECK (toelichting IS NULL OR length(toelichting) <= 500)
);
CREATE INDEX IF NOT EXISTS besluit_factuur ON besluit (factuur_ref);
-- Antwoordcontract in Supabase (wv1899, fase 4b): per run de uitslag van public.sb_fin_run_zet (ok = run + query_run staan er).
CREATE TABLE IF NOT EXISTS supabase_zet (
  run INTEGER PRIMARY KEY REFERENCES reken_run(id),
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  run_id INTEGER, query_run_id INTEGER,
  fout TEXT CHECK (fout IS NULL OR length(fout) <= 60),
  pogingen INTEGER NOT NULL DEFAULT 1,
  op TEXT NOT NULL
);
`;
function openReken(dir) {
  maakMap(dir);
  const p = path.join(dir, 'reken.sqlite');
  const DB = sqlite();
  const db = new DB(p);
  try { fs.chmodSync(p, 0o600); } catch (e) { /* net aangemaakt door SQLite: hieronder nog eens */ }
  db.exec('PRAGMA busy_timeout = 15000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  fs.chmodSync(p, 0o600);
  return db;
}

// ───────────────────────────── momentopname ─────────────────────────────

function momentopname(facturenPad, dir) {
  const snap = path.join(dir, 'snapshot');
  maakMap(dir); maakMap(snap);
  if (!fs.existsSync(facturenPad)) throw new FinFout('geen_facturen', 'Facturen-databank niet gevonden');
  const tmp = path.join(snap, '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex') + '.sqlite');
  const DB = sqlite();
  const bron = new DB(facturenPad, { readOnly: true });
  try { bron.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'"); } finally { bron.close(); }
  fs.chmodSync(tmp, 0o600);
  const sha = sha256(fs.readFileSync(tmp));
  const doel = path.join(snap, sha + '.sqlite');
  if (fs.existsSync(doel)) fs.unlinkSync(tmp); else fs.renameSync(tmp, doel);
  return { sha256: sha, pad: doel };
}
function snapshotPad(dir, sha) {
  if (!/^[0-9a-f]{64}$/.test(String(sha || ''))) throw new FinFout('snapshot_ongeldig', 'snapshot-id is geen sha256');
  const p = path.join(dir, 'snapshot', sha + '.sqlite');
  if (!fs.existsSync(p)) throw new FinFout('snapshot_ontbreekt', 'momentopname ' + sha.slice(0, 12) + ' bestaat niet (meer)');
  if (sha256(fs.readFileSync(p)) !== sha) throw new FinFout('snapshot_beschadigd', 'momentopname ' + sha.slice(0, 12) + ' klopt niet met zijn sha256');
  return p;
}

// ───────────────────────────── bronbestanden en dekking per dag ─────────────────────────────

function cent(euro) { const c = Math.round(Number(euro) * 100); return Object.is(c, -0) ? 0 : c; }
function centTekst(s) { const v = B.normBedrag(s); return v === null ? null : cent(v); }
// Regels van één rekening uit een bronbestand → { formaat, rijen: [{ dag, c, b?, e? }] } (bestandsvolgorde). Weigert zoals de Facturen-lezer.
function bronRegels(bytes, iban) {
  let tekst = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes);
  if (tekst.charCodeAt(0) === 0xfeff) tekst = tekst.slice(1);
  const formaat = B.herkenFormaat(tekst);
  let rijen;
  if (formaat === 'abn_tab') rijen = B.leesAbnTab(tekst).map((r) => ({ iban: K.ibanNorm(r.eigen_iban_ruw), dag: r.boekdatum, c: cent(r.bedrag), b: centTekst(r.saldo_begin), e: centTekst(r.saldo_na) }));
  else if (formaat === 'abn_historie_csv') rijen = B.leesAbnHistorie(tekst).map((h) => ({ iban: K.ibanNorm(h.rekening), dag: h.rentedatum, c: cent(h.bedrag), e: centTekst(h.saldo_na) }));
  else if (formaat === 'ing_csv') rijen = B.leesIng(tekst).map((r) => ({ iban: K.ibanNorm(r.eigen_iban_ruw), dag: r.boekdatum, c: cent(r.bedrag), e: r.saldo_na === '' || r.saldo_na == null ? null : centTekst(r.saldo_na) }));
  else if (formaat === 'triodos_csv') rijen = B.leesTriodos(tekst).map((r) => ({ iban: K.ibanNorm(r.eigen_iban_ruw), dag: r.boekdatum, c: cent(r.bedrag), e: r.saldo_na === '' || r.saldo_na == null ? null : centTekst(r.saldo_na) }));
  else if (formaat === 'abn_mt940') rijen = B.leesAbnMt940(tekst).map((r) => ({ iban: K.ibanNorm(r.eigen_iban_ruw), dag: r.boekdatum, c: cent(r.bedrag) }));
  else throw new FinFout('formaat_onbekend', 'bronbestand in een formaat dat de dekking niet leest');
  return { formaat, rijen: rijen.filter((r) => r.iban === iban) };
}
function dagReeks(a, b) {
  const uit = [];
  for (let d = a, i = 0; d <= b; d = K.plusDagen(d, 1), i++) { if (i >= MAX_DAGEN) throw new FinFout('scope_te_groot', 'meer dan ' + MAX_DAGEN + ' dagen'); uit.push(d); }
  return uit;
}
/*
 * Saldoketen van de regels van één rekening in één bestand → { gecontroleerd, breuk: Set(dag) }. ABN-TAB: per regel begin + bedrag = eind
 * en de keten tussen opeenvolgende regels; historie/ING/Triodos: saldo na mutatie; MT940: de lezer weigert al een afschrift dat niet sluit.
 * De richting (oudste of nieuwste eerst) met de minste breuken telt (zoals facturen-bank.js saldoControle). Een breuk tussen twee regels
 * maakt alle dagen van de ene t/m de andere regel afwijkend.
 */
function keten(rijen, formaat) {
  const breuk = new Set();
  if (formaat === 'abn_mt940') return { gecontroleerd: true, breuk };
  const n = rijen.length;
  const reeks = (a, b) => { const [x, y] = a <= b ? [a, b] : [b, a]; for (const d of dagReeks(x, y)) breuk.add(d); };
  if (formaat === 'abn_tab') {
    if (rijen.some((r) => r.b === null || r.e === null)) return { gecontroleerd: false, breuk };
    for (const r of rijen) if (r.b + r.c !== r.e) breuk.add(r.dag);
    const voor = [], achter = [];
    for (let i = 0; i + 1 < n; i++) { if (rijen[i].e !== rijen[i + 1].b) voor.push(i); if (rijen[i].b !== rijen[i + 1].e) achter.push(i); }
    const v = voor.length <= achter.length;
    for (const i of v ? voor : achter) reeks(rijen[i].dag, rijen[i + 1].dag);
    return { gecontroleerd: true, breuk, begin: n ? (v ? rijen[0].b : rijen[n - 1].b) : null, eind: n ? (v ? rijen[n - 1].e : rijen[0].e) : null };
  }
  if (rijen.some((r) => r.e === null || r.e === undefined)) return { gecontroleerd: false, breuk };
  const oud = [], nieuw = [];
  for (let i = 0; i + 1 < n; i++) { if (rijen[i].e + rijen[i + 1].c !== rijen[i + 1].e) oud.push(i); if (rijen[i].e - rijen[i].c !== rijen[i + 1].e) nieuw.push(i); }
  const o = oud.length <= nieuw.length;
  for (const i of o ? oud : nieuw) reeks(rijen[i].dag, rijen[i + 1].dag);
  return { gecontroleerd: true, breuk, begin: n ? (o ? rijen[0].e - rijen[0].c : rijen[n - 1].e - rijen[n - 1].c) : null, eind: n ? (o ? rijen[n - 1].e : rijen[0].e) : null };
}
// Wanneer is het bestand gemaakt (dag)? Alleen de ABN-export zegt het zelf: TXTjjmmddhhmmss in de naam. De uploaddag is een bovengrens, geen
// bewijs dat het bestand ná zijn laatste regeldag gemaakt is (review wv1864 ZOU 6): zonder TXT-naam → null, en dan telt de laatste dag niet.
function gemaaktOp(b) {
  const m = /TXT(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(b.naam || ''));
  if (m) { const d = '20' + m[1] + '-' + m[2] + '-' + m[3]; if (K.isIsoDatum(d)) return d; }
  return null;
}
/*
 * Dekking per dag voor één rekening over [van, tot] → { dagen: [{ dag, status, reden, db_regels, db_som_centen }], status(dag), bank_tm,
 * laatst_gedekt, bronnen: [{ sha256, formaat, van, tot, eind, regels, gecontroleerd, fout }] }.
 */
function dekkingRekening(snap, rekening, van, tot, bankbronDir, peilVan) {
  const bestanden = snap.prepare('SELECT sha256, formaat, naam, modus, bron_bewaard, geupload_op, per_rekening FROM bank_bestand ORDER BY sha256').all()
    .filter((b) => { try { return Object.hasOwn(JSON.parse(b.per_rekening || '{}'), rekening.iban); } catch (e) { return false; } });
  const db = new Map();
  for (const r of snap.prepare('SELECT boekdatum AS dag, count(*) AS n, sum(bedrag_centen) AS som FROM bank_transactie WHERE rekening = ? AND verwijderd_op IS NULL AND boekdatum BETWEEN ? AND ? GROUP BY boekdatum').all(rekening.id, van, tot))
    db.set(r.dag, { n: Number(r.n), som: Number(r.som) });
  const bronnen = [];
  for (const b of bestanden) {
    const info = { sha256: b.sha256, modus: b.modus, formaat: null, van: null, tot: null, eind: null, regels: 0, gecontroleerd: false, fout: null };
    bronnen.push(info);
    if (!b.bron_bewaard) { info.fout = 'geen_bronbestand'; continue; }
    const p = path.join(bankbronDir, b.sha256);
    let bytes;
    try { bytes = fs.readFileSync(p); } catch (e) { info.fout = 'bron_ontbreekt'; continue; }
    if (sha256(bytes) !== b.sha256) { info.fout = 'bron_beschadigd'; continue; }
    info.grootte = bytes.length;
    let br;
    try { br = bronRegels(bytes, rekening.iban); } catch (e) { info.fout = e instanceof FinFout ? e.code : 'bron_onleesbaar'; continue; }
    info.formaat = br.formaat; info.regels = br.rijen.length;
    if (!br.rijen.length) { info.fout = 'geen_regels_van_rekening'; continue; }
    const dagen = br.rijen.map((r) => r.dag).sort();
    info.van = dagen[0]; info.tot = dagen[dagen.length - 1];
    const gemaakt = gemaaktOp(b);
    info.eind = !gemaakt || gemaakt <= info.tot ? K.plusDagen(info.tot, -1) : info.tot;
    const k = keten(br.rijen, br.formaat);
    info.gecontroleerd = k.gecontroleerd;
    if (!k.gecontroleerd) info.fout = 'saldo_niet_te_controleren';
    const perDag = new Map();
    for (const r of br.rijen) { const x = perDag.get(r.dag) || { n: 0, som: 0 }; x.n++; x.som += r.c; perDag.set(r.dag, x); }
    info._dag = perDag; info._breuk = k.breuk; info._begin = k.begin; info._eind = k.eind;
  }
  // De eerste dag van een bestand kan half zijn (export "sinds de vorige download"): hij telt alleen als het beginsaldo aansluit op het eindsaldo
  // van een eerder bestand, of als een ander bestand die dag midden in zijn eigen periode heeft (review wv1864 ZOU 6). MT940: per afschrift.
  for (const s of bronnen) {
    if (!s._dag || !s.gecontroleerd) continue;
    s.start = s.van;
    if (s.formaat === 'abn_mt940') continue;
    const sluit = bronnen.some((y) => y !== s && y._dag && y.gecontroleerd && y.tot < s.van && y._eind !== null && y._eind === s._begin);
    const binnen = bronnen.some((y) => y !== s && y._dag && y.gecontroleerd && y.van < s.van && s.van <= y.eind);
    if (!sluit && !binnen) s.start = K.plusDagen(s.van, 1);
  }
  const dagen = [];
  for (const d of dagReeks(van, tot)) {
    const dv = db.get(d) || { n: 0, som: 0 };
    const dekt = bronnen.filter((s) => s._dag && s.gecontroleerd && d >= s.start && d <= s.eind);
    let status, reden;
    if (!dekt.length) {
      status = dv.n ? 'alleen_databank' : 'ontbreekt';
      reden = bronnen.some((s) => s._dag && s.gecontroleerd && d === s.tot && s.eind < s.tot) ? 'exportdag'
        : bronnen.some((s) => s._dag && s.gecontroleerd && d === s.van && s.start > s.van) ? 'eerste_dag_onzeker'
        : bronnen.some((s) => s._dag && !s.gecontroleerd && d >= s.van && d <= s.tot) ? 'saldo_niet_te_controleren' : 'geen_bronbestand';
    } else if (dekt.some((s) => s._breuk.has(d))) { status = 'afwijkend'; reden = 'saldoketen'; }
    else if (dekt.some((s) => { const x = s._dag.get(d) || { n: 0, som: 0 }; return x.n !== dv.n || x.som !== dv.som; })) { status = 'afwijkend'; reden = 'databank_wijkt_af'; }
    else { status = 'gedekt'; reden = 'bron:' + dekt.map((s) => s.sha256.slice(0, 12)).join(','); }
    dagen.push({ dag: d, status, reden, db_regels: dv.n, db_som_centen: dv.som });
  }
  const per = new Map(dagen.map((x) => [x.dag, x.status]));
  // "bank t/m" (§ 3.4): de laatste dag die aaneengesloten gedekt is vanaf de start van de facturenscope (eerste factuurdatum − 7; de dagen
  // daarvóór staan in de tabel voor de sleutelbetalingen tot 45 dagen vooraf, maar een rekening die pas later opende maakt de peildatum niet leeg)
  let bank_tm = null;
  for (const x of dagen) { if (peilVan && x.dag < peilVan) continue; if (x.status !== 'gedekt') break; bank_tm = x.dag; }
  let laatst_gedekt = null;
  for (const x of dagen) if (x.status === 'gedekt') laatst_gedekt = x.dag;
  for (const s of bronnen) { delete s._dag; delete s._breuk; delete s._begin; delete s._eind; }
  return { dagen, status: (d) => per.get(d) || null, bank_tm, laatst_gedekt, bronnen, peil_van: peilVan || van };
}

// ───────────────────────────── invoer uit de momentopname ─────────────────────────────

function rekeningVan(snap, entiteit, eind) {
  let l = snap.prepare('SELECT id, entiteit, iban, bank_formaat FROM rekening WHERE entiteit = ? ORDER BY iban').all(entiteit);
  if (eind) l = l.filter((r) => String(r.iban).endsWith(String(eind)));
  if (l.length !== 1) throw new FinFout('rekening_onduidelijk', l.length + ' rekeningen voor ' + entiteit + (eind ? ' eindigend op ' + eind : '') + '; geef --rekening');
  return l[0];
}
function facturenVan(snap, entiteit, periode) {
  const inPeriode = (d) => !d || ((!periode.van || d >= periode.van) && (!periode.tot || d <= periode.tot));
  const archief = snap.prepare('SELECT id, leverancier_naam, nummer, kenmerk, factuurdatum, vervaldatum, incl, iban, betaalwijze, status FROM factuur_archief WHERE entiteit = ? ORDER BY id').all(entiteit)
    .filter((f) => inPeriode(f.factuurdatum));
  const app = snap.prepare('SELECT id, leverancier_naam, nummer, kenmerk, factuurdatum, vervaldatum, incl, incl_eur, valuta, iban, ibans_betaal, soort, status, betaalspoor FROM factuur WHERE entiteit = ? ORDER BY id').all(entiteit)
    .filter((f) => inPeriode(f.factuurdatum));
  const lijst = [], uitgesloten = {};
  for (const f of archief) {
    if (!ARCHIEF_IN.includes(f.status)) { const s = ARCHIEF_UIT.includes(f.status) ? f.status : 'archief_' + String(f.status || 'leeg'); uitgesloten[s] = (uitgesloten[s] || 0) + 1; continue; }
    lijst.push({ ref: 'archief:' + f.id, herkomst: 'fv2', leverancier: f.leverancier_naam, nummer: f.nummer, kenmerk: f.kenmerk, factuurdatum: f.factuurdatum,
      vervaldatum: f.vervaldatum, bedrag_centen: f.incl == null ? null : Number(f.incl), ibans: [f.iban].filter(Boolean), soort: 'factuur', fv2_betaalwijze: f.betaalwijze });
  }
  for (const f of app) {
    const mee = !APP_NIET.includes(f.status) && (f.status === 'verstuurd' || APP_SPOREN.includes(f.betaalspoor));
    if (!mee) { const s = 'app_' + f.status; uitgesloten[s] = (uitgesloten[s] || 0) + 1; continue; }
    let extra = [];
    try { extra = JSON.parse(f.ibans_betaal || '[]'); } catch (e) { extra = []; }
    const bedrag = f.valuta === 'EUR' ? f.incl : f.incl_eur;
    lijst.push({ ref: 'factuur:' + f.id, herkomst: 'facturen', leverancier: f.leverancier_naam, nummer: f.nummer, kenmerk: f.kenmerk, factuurdatum: f.factuurdatum,
      vervaldatum: f.vervaldatum, bedrag_centen: bedrag == null ? null : Number(bedrag), ibans: [...new Set([f.iban].concat(extra).filter(Boolean))].sort(), soort: f.soort, fv2_betaalwijze: null });
  }
  if (lijst.length > MAX_FACTUREN) throw new FinFout('te_veel_facturen', 'meer dan ' + MAX_FACTUREN + ' facturen in de scope');
  return { lijst, uitgesloten };
}

// ───────────────────────────── de run ─────────────────────────────

function regelsHash() {
  const h = crypto.createHash('sha256');
  for (const f of ['fin-toewijzing.js', 'fin-reconcile.js']) h.update(fs.readFileSync(path.join(__dirname, f)));
  return h.digest('hex');
}
function regelsVersie() {
  if (process.env.RELEASE_SHA || process.env.IMAGE_SHA) return String(process.env.RELEASE_SHA || process.env.IMAGE_SHA).slice(0, 40);
  try { return require('child_process').execFileSync('git', ['-C', __dirname, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().slice(0, 40) || 'onbekend'; }
  catch (e) { return 'onbekend'; }
}

/*
 * opties = { dir, facturen (pad), bankbron (map), entiteit, rekening (laatste cijfers), snapshot (bestaande sha256; anders een nieuwe),
 *   periode: { van, tot } (factuurdatum), nu (ms) } → samenvatting (zonder bedragen van derden) + run-id.
 */
/*
 * De berekening zelf (zonder schrijven): momentopname (open, alleen lezen) + opties → alle uitkomstrijen en hashes. Gedeeld door run()
 * (die schrijft het weg in reken.sqlite) en droog() (die schrijft niets; SB2 fase 6a, wv1962). besluitenReken = de besluiten uit
 * reken.sqlite (droog: geen).
 */
function reken(sdb, o, snapSha, besluitenReken) {
  const rekening = rekeningVan(sdb, o.entiteit, o.rekening);
  const label = eind4(rekening.iban);
  const fv = facturenVan(sdb, o.entiteit, o.periode || {});
  const datums = fv.lijst.map((f) => f.factuurdatum).filter((d) => d && K.isIsoDatum(d)).sort();
  // het einde van de dekkingstabel volgt uit de momentopname zelf (laatste boekdag of uploaddag), niet uit de klok: dezelfde momentopname
  // geeft een dag later dezelfde tabellen (review wv1864 KAN 10); dagen erna zijn per definitie niet gedekt
  const eindDb = sdb.prepare("SELECT max(d) AS d FROM (SELECT max(boekdatum) AS d FROM bank_transactie WHERE rekening = ? UNION ALL SELECT max(substr(geupload_op, 1, 10)) FROM bank_bestand)").get(rekening.id).d;
  const vandaag = eindDb && K.isIsoDatum(eindDb) && eindDb < dagAmsterdam(o.nu) ? eindDb : dagAmsterdam(o.nu);
  const scope = { entiteit: o.entiteit, rekening_label: label, periode_van: (o.periode || {}).van || null, periode_tot: (o.periode || {}).tot || null,
    facturenset: 'fv2_archief_beslist+facturen_vanaf_verstuurd', dekking_van: datums.length ? K.plusDagen(datums[0], -T.VENSTER_VOOR) : K.plusDagen(vandaag, -365), dekking_tot: vandaag };
  scope.peil_van = datums.length ? K.plusDagen(datums[0], -T.VOORUIT_ZONDER_SLEUTEL) : scope.dekking_van;
  const dek = dekkingRekening(sdb, rekening, scope.dekking_van, scope.dekking_tot, o.bankbron, scope.peil_van);
  const transacties = sdb.prepare('SELECT entry_ref, boekdatum, bedrag_centen, tegenpartij_iban, tegenpartij_naam, omschrijving, kenmerk, categorie FROM bank_transactie WHERE rekening = ? AND verwijderd_op IS NULL').all(rekening.id)
    .map((t) => Object.assign({}, t, { bedrag_centen: Number(t.bedrag_centen) }));
  const ks = sdb.prepare('SELECT k.factuur, k.bron, k.methode, k.volledig, t.entry_ref FROM koppeling k JOIN bank_transactie t ON t.id = k.transactie WHERE t.rekening = ? AND t.verwijderd_op IS NULL ORDER BY k.id').all(rekening.id);
  const koppelingen = ks.map((k) => ({ entry_ref: k.entry_ref, factuur_ref: 'factuur:' + k.factuur, methode: k.methode }));
  const besluiten = ks.filter((k) => k.bron === 'mens' && k.methode !== 'sepa_terug').map((k) => ({ factuur_ref: 'factuur:' + k.factuur, entry_refs: [k.entry_ref], oordeel: 'ja', bron: 'koppeling' }))
    .concat(besluitenReken);
  const fv2 = fv.lijst.filter((f) => f.herkomst === 'fv2' && f.factuurdatum && K.isIsoDatum(f.factuurdatum)).map((f) => f.factuurdatum).sort();
  const aanname = fv2.length ? { van: K.plusDagen(fv2[0], T.VENSTER_VOOR), tot: fv2[fv2.length - 1], fv2_van: fv2[0], fv2_tot: fv2[fv2.length - 1] } : {};
  const uitk = T.sluitAan({ facturen: fv.lijst, transacties, besluiten, koppelingen, dekking: dek, aanname, scope: { van: scope.dekking_van, tot: scope.dekking_tot } });
  const aannames = ['venster_-45_+120_met_sleutel_-7_+120_zonder', 'reeds_voldaan_niet_getoetst', 'andere_eigen_rekening_niet_bekeken', 'facturenset_fv2_aanname_compleet']
    .concat(Object.keys(fv.uitgesloten).sort().map((s) => 'uitgesloten_' + s)).concat(uitk.aannames);
  const vinger = sha256(canon({ snap: snapSha, bronnen: dek.bronnen.map((b) => b.sha256), besluiten, scope, regels: regelsHash() }));
  const fByRef = new Map(fv.lijst.map((f) => [f.ref, f]));
  const txByRef = new Map(transacties.map((t) => [t.entry_ref, t]));
  const rijD = dek.dagen.map((x) => [label, x.dag, x.status, x.reden, x.db_regels, x.db_som_centen]);
  const rijA = uitk.regels.map((r) => { const f = fByRef.get(r.ref); return [r.ref, f.leverancier || null, f.nummer || null, f.factuurdatum || null, f.vervaldatum || null, r.status, r.reden, r.laag,
    r.factuurbedrag_centen, r.betaald_centen, r.rest_centen, r.betaaldatum, canon(r.entry_refs), canon(r.kandidaat_refs)]; });
  const rijO = uitk.onverklaard.map((x) => { const t = txByRef.get(x.entry_ref); return [x.entry_ref, x.boekdatum, x.bedrag_centen, t.tegenpartij_naam || null, t.omschrijving ? String(t.omschrijving).slice(0, 80) : null, x.reden, x.factuur_ref]; });
  const uitkomstHash = sha256(canon({ dekking: rijD, aansluiting: rijA, onverklaard: rijO }));
  const tellingFact = { facturen_in_scope: fv.lijst.length, uitgesloten: fv.uitgesloten, per_status: uitk.telling };
  const dagTelling = {};
  for (const s of T.DAG_STATUSSEN) dagTelling[s] = 0;
  for (const x of dek.dagen) dagTelling[x.status]++;
  return { label, scope, dek, fv, aanname, uitk, aannames, vinger, rijD, rijA, rijO, uitkomstHash, tellingFact, dagTelling };
}

function run(opties) {
  const o = Object.assign({ dir: STANDAARD_DIR, facturen: STANDAARD_FACTUREN, entiteit: 'tolgaarde', periode: {} }, opties || {});
  if (!Number.isFinite(o.nu)) throw new FinFout('geen_tijd', 'nu ontbreekt');
  o.bankbron = o.bankbron || path.join(path.dirname(o.facturen), 'bankbron');
  const snap = o.snapshot ? { sha256: o.snapshot, pad: snapshotPad(o.dir, o.snapshot) } : momentopname(o.facturen, o.dir);
  const DB = sqlite();
  const sdb = new DB(snap.pad, { readOnly: true });
  const rdb = openReken(o.dir);
  const gestart = new Date(o.nu).toISOString();
  try {
    const besluitenReken = rdb.prepare('SELECT factuur_ref, entry_refs, oordeel FROM besluit ORDER BY id').all().map((b) => ({ factuur_ref: b.factuur_ref, entry_refs: JSON.parse(b.entry_refs), oordeel: b.oordeel, bron: 'besluit' }));
    const { label, scope, dek, fv, aanname, uitk, aannames, vinger, rijD, rijA, rijO, uitkomstHash, tellingFact, dagTelling } = reken(sdb, o, snap.sha256, besluitenReken);
    const regel = dekkingsregel({ label, dek, scope, fv, aanname, telling: uitk.telling, gemaakt: tijdAmsterdam(o.nu) });
    let id;
    rdb.exec('BEGIN IMMEDIATE');
    try {
      id = Number(rdb.prepare("INSERT INTO reken_run (soort, entiteit, rekening_label, snapshot_sha256, invoer_vingerafdruk, scope, regels_versie, regels_hash, gestart_op) VALUES ('finance.reconcile', ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(o.entiteit, label, snap.sha256, vinger, canon(scope), regelsVersie(), regelsHash(), gestart).lastInsertRowid);
      const zd = rdb.prepare('INSERT INTO dekking (run, rekening_label, dag, status, reden, db_regels, db_som_centen) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const r of rijD) zd.run(id, ...r);
      const za = rdb.prepare('INSERT INTO aansluiting (run, factuur_ref, leverancier, nummer, factuurdatum, vervaldatum, status, reden, laag, factuurbedrag_centen, betaald_centen, rest_centen, betaaldatum, entry_refs, kandidaat_refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const r of rijA) za.run(id, ...r);
      const zo = rdb.prepare('INSERT INTO onverklaard (run, entry_ref, boekdatum, bedrag_centen, tegenpartij_naam, omschrijving, reden, factuur_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const r of rijO) zo.run(id, ...r);
      rdb.prepare('UPDATE reken_run SET klaar_op = ?, uitkomst = ?, code = ?, bank_tm = ?, laatst_gedekt = ?, telling = ?, totalen = ?, aannames = ?, bronnen = ?, dekkingsregel = ?, uitkomst_hash = ? WHERE id = ?')
        .run(new Date(o.nu).toISOString(), uitk.uitkomst, uitk.code, dek.bank_tm, dek.laatst_gedekt, canon({ facturen: tellingFact, dagen: dagTelling, onverklaard: telOnverklaard(uitk.onverklaard), storno_paren: uitk.storno.length }),
          uitk.totalen ? canon(uitk.totalen) : null, canon(aannames), canon(dek.bronnen), regel, uitkomstHash, id);
      rdb.exec('COMMIT');
    } catch (e) { try { rdb.exec('ROLLBACK'); } catch (e2) { /* al terug */ } throw e; }
    return { ok: true, run: id, snapshot: snap.sha256, uitkomst: uitk.uitkomst, code: uitk.code, bank_tm: dek.bank_tm, laatst_gedekt: dek.laatst_gedekt, telling: uitk.telling,
      dagen: dagTelling, onverklaard: telOnverklaard(uitk.onverklaard), totalen_gevuld: !!uitk.totalen, uitkomst_hash: uitkomstHash, dekkingsregel: regel };
  } finally { sdb.close(); rdb.close(); }
}

/*
 * Droge, deterministische modus (SB2 fase 6a, wv1962): rekent op een BESTAAND facturenbestand (de dump uit de podstaat-bundel, al een
 * VACUUM INTO-kopie) zonder momentopname-kopie, zonder reken.sqlite (dus ook zonder de besluiten daaruit), zonder schrijven en zonder
 * klok: `nu` komt van buiten (het podstaat-stempel). Zelfde invoer + zelfde code (regels_hash) = zelfde invoer_hash en uitkomst_hash;
 * de herstelproef op de R230 rekent zo na op de teruggezette bundel. Uitvoer zonder bedragen, namen of omschrijvingen.
 */
function droog(opties) {
  const o = Object.assign({ entiteit: 'tolgaarde', periode: {} }, opties || {});
  if (!Number.isFinite(o.nu)) throw new FinFout('geen_tijd', 'nu ontbreekt (droog rekent nooit op de klok)');
  if (!o.facturen || !fs.existsSync(o.facturen)) throw new FinFout('geen_facturen', 'facturenbestand niet gevonden');
  if (!o.bankbron || !fs.existsSync(o.bankbron)) throw new FinFout('geen_bankbron', 'bankbronmap niet gevonden');
  const snapSha = sha256(fs.readFileSync(o.facturen));
  const DB = sqlite();
  const sdb = new DB(o.facturen, { readOnly: true });
  try {
    const r = reken(sdb, o, snapSha, []);
    return { ok: true, modus: 'droog', snapshot: snapSha, invoer_hash: r.vinger, uitkomst_hash: r.uitkomstHash, regels_hash: regelsHash(),
      rekening_label: r.label, dekking_tot: r.scope.dekking_tot, uitkomst: r.uitk.uitkomst, code: r.uitk.code, telling: r.uitk.telling, dagen: r.dagTelling };
  } finally { sdb.close(); }
}
function telOnverklaard(l) { const t = {}; for (const x of l) t[x.reden] = (t[x.reden] || 0) + 1; return t; }

// Aaneengesloten reeksen niet-gedekte dagen → "12-6 t/m 30-6-2026"
function reeksen(dagen) {
  const uit = [];
  for (const d of dagen) {
    const l = uit[uit.length - 1];
    if (l && K.plusDagen(l[1], 1) === d) l[1] = d; else uit.push([d, d]);
  }
  return uit;
}
function dekkingsregel(x) {
  const delen = [];
  const gaten = x.dek.dagen.filter((d) => d.status !== 'gedekt' && x.dek.laatst_gedekt && d.dag >= x.dek.peil_van && d.dag <= x.dek.laatst_gedekt).map((d) => d.dag);
  if (!x.dek.laatst_gedekt) delen.push('Bank ' + x.label + ': geen enkele dag gedekt');
  else if (!gaten.length && x.dek.bank_tm) delen.push('Bank ' + x.label + ' t/m ' + dagNL(x.dek.bank_tm) + ', alles gedekt vanaf ' + dagNL(x.dek.peil_van));
  else if (!gaten.length) delen.push('Bank ' + x.label + ': niet gedekt vanaf ' + dagNL(x.dek.peil_van));
  else delen.push('Bank ' + x.label + ' niet gedekt: ' + reeksen(gaten).slice(0, 6).map((r) => (r[0] === r[1] ? dagNL(r[0]) : dagNL(r[0]) + ' t/m ' + dagNL(r[1]))).join(', ') +
    (reeksen(gaten).length > 6 ? ' en meer' : '') + '; laatste gedekte dag ' + dagNL(x.dek.laatst_gedekt));
  const nArch = x.fv.lijst.filter((f) => f.herkomst === 'fv2').length, nApp = x.fv.lijst.length - nArch;
  const nUit = Object.values(x.fv.uitgesloten).reduce((a, b) => a + b, 0);
  if (x.aanname.fv2_van) delen.push('facturen FV2 ' + dagNL(x.aanname.fv2_van) + ' t/m ' + dagNL(x.aanname.fv2_tot) + ' (aanname: compleet; ' + (nArch + nUit) + ', waarvan ' + nUit + ' niet meegeteld)' +
    (nApp ? ' + ' + nApp + ' uit de Facturen-app' : ''));
  else delen.push(x.fv.lijst.length + ' facturen in de scope');
  if (x.telling.nog_niet_te_beoordelen) delen.push(x.telling.nog_niet_te_beoordelen + ' nog niet te beoordelen');
  if (x.telling.onbepaald_dekking) delen.push(x.telling.onbepaald_dekking + ' niet te beoordelen door een gat in de bank (geen totalen)');
  return delen.join('; ') + '. Momentopname ' + x.gemaakt + '.';
}

// ───────────────────────────── lezen (skill-commando aansluiting) ─────────────────────────────

/*
 * De laatste run van een entiteit → { run, gemaakt, uitkomst, code, dekkingsregel, telling, totalen, facturen per status, onverklaard per
 * reden (+ regels als opties.regels), aannames }. Alleen lezen. opties = { entiteit, status, max, regels }.
 */
function laatste(dir, opties) {
  const o = Object.assign({ entiteit: 'tolgaarde', max: 100 }, opties || {});
  const p = path.join(dir || STANDAARD_DIR, 'reken.sqlite');
  if (!fs.existsSync(p)) return { ok: true, run: null, melding: 'nog geen aansluiting gedraaid' };
  const DB = sqlite();
  const db = new DB(p, { readOnly: true });
  try {
    const r = db.prepare("SELECT * FROM reken_run WHERE entiteit = ? AND klaar_op IS NOT NULL ORDER BY id DESC LIMIT 1").get(o.entiteit);
    if (!r) return { ok: true, run: null, melding: 'nog geen aansluiting gedraaid voor ' + o.entiteit };
    const max = Math.max(1, Math.min(Number(o.max) || 100, 500));
    const filter = o.status && T.STATUSSEN.includes(o.status) ? ' AND status = ?' : '';
    const args = filter ? [r.id, o.status] : [r.id];
    const fs_ = db.prepare('SELECT factuur_ref, leverancier, nummer, factuurdatum, vervaldatum, status, reden, laag, factuurbedrag_centen, betaald_centen, rest_centen, betaaldatum FROM aansluiting WHERE run = ?' + filter + ' ORDER BY status, factuurdatum, factuur_ref LIMIT ?').all(...args, max);
    const per = {};
    for (const f of fs_) { (per[f.status] = per[f.status] || []).push(f); }
    const uit = { ok: true, run: r.id, gemaakt: r.gestart_op, uitkomst: r.uitkomst, code: r.code, bank_tm: r.bank_tm, dekkingsregel: r.dekkingsregel,
      telling: JSON.parse(r.telling), totalen: r.totalen ? JSON.parse(r.totalen) : null, aannames: JSON.parse(r.aannames), facturen: per,
      afgekapt: db.prepare('SELECT count(*) AS n FROM aansluiting WHERE run = ?' + filter).get(...args).n > fs_.length, snapshot: r.snapshot_sha256.slice(0, 12), regels_versie: r.regels_versie };
    // antwoordcontract (fase 4b): staat deze run in Supabase? (tabel ontbreekt in een reken.sqlite van vóór wv1899 tot de eerste schrijver)
    try {
      const z = db.prepare('SELECT ok, query_run_id, fout FROM supabase_zet WHERE run = ?').get(r.id);
      uit.antwoordcontract = z ? (z.ok ? { query_run_id: z.query_run_id } : { fout: z.fout }) : { nog_niet: true };
    } catch (e) { uit.antwoordcontract = { nog_niet: true }; }
    if (o.regels) uit.onverklaard_regels = db.prepare('SELECT boekdatum, bedrag_centen, tegenpartij_naam, omschrijving, reden, factuur_ref FROM onverklaard WHERE run = ? ORDER BY reden, boekdatum, entry_ref LIMIT ?').all(r.id, max);
    return uit;
  } finally { db.close(); }
}

// Momentopnamen opruimen: zonder run in de laatste 90 dagen weg, ouder dan 7 dagen hooguit één per dag; halve tijdelijke bestanden (> 1 uur) ook.
// Een run waarvan de momentopname weg is, blijft leesbaar maar is niet meer na te rekenen. → { weg: n }
function opruim(dir, nu) {
  const snap = path.join(dir, 'snapshot');
  if (!fs.existsSync(snap)) return { weg: 0 };
  const p = path.join(dir, 'reken.sqlite');
  const nodig = new Set();
  if (fs.existsSync(p)) {
    const DB = sqlite();
    const db = new DB(p, { readOnly: true });
    // laatste 7 dagen: elke momentopname met een run; daarvoor tot 90 dagen: alleen die van de laatste run per dag (review wv1864 ZOU 8: elke
    // vers-run maakt een volledige kopie van ± 10 MB)
    try {
      const grens = new Date(nu - 7 * 86400000).toISOString();
      const perDag = new Map();
      for (const r of db.prepare('SELECT id, snapshot_sha256 AS s, gestart_op AS g FROM reken_run WHERE gestart_op >= ? ORDER BY id').all(new Date(nu - BEWAAR_DAGEN * 86400000).toISOString())) {
        if (r.g >= grens) nodig.add(r.s); else perDag.set(r.g.slice(0, 10), r.s);
      }
      for (const sha of perDag.values()) nodig.add(sha);
    } finally { db.close(); }
  }
  let weg = 0;
  for (const n of fs.readdirSync(snap)) {
    const vol = path.join(snap, n);
    const m = /^([0-9a-f]{64})\.sqlite$/.exec(n);
    if (m && !nodig.has(m[1])) { fs.unlinkSync(vol); weg++; }
    else if (/^\.tmp-/.test(n) && nu - fs.statSync(vol).mtimeMs > 3600000) { fs.unlinkSync(vol); weg++; }
  }
  return { weg };
}

// Besluit vastleggen (alleen na Davids expliciete antwoord; bron = de vraag in Open vragen). Schrijft alleen in reken.sqlite.
function besluit(dir, b, nu) {
  if (!/^(archief|factuur):[0-9a-f]{16}$/.test(String(b.factuur_ref || ''))) throw new FinFout('besluit_ongeldig', 'factuur_ref is archief:<id> of factuur:<id>');
  const refs = [].concat(b.entry_refs || []).map(String).filter((x) => /^[0-9a-f]{20}(-\d+)?$/.test(x));
  if (!refs.length || refs.length !== [].concat(b.entry_refs || []).length) throw new FinFout('besluit_ongeldig', 'entry_refs ontbreken of zijn ongeldig');
  if (!['ja', 'nee'].includes(b.oordeel)) throw new FinFout('besluit_ongeldig', 'oordeel is ja of nee');
  if (!b.wie || !b.bron) throw new FinFout('besluit_ongeldig', 'wie en bron zijn verplicht');
  const db = openReken(dir);
  try {
    return { ok: true, id: Number(db.prepare('INSERT INTO besluit (factuur_ref, entry_refs, oordeel, wie, wanneer, bron, toelichting) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(b.factuur_ref, canon(refs.sort()), b.oordeel, String(b.wie).slice(0, 40), new Date(nu).toISOString(), String(b.bron).slice(0, 300), b.toelichting ? String(b.toelichting).slice(0, 500) : null).lastInsertRowid) };
  } finally { db.close(); }
}

// ───────────────────────────── antwoordcontract in Supabase (wv1899, fase 4b) ─────────────────────────────

/*
 * Ontwerp § 3.2 en § 3.6. Per run één contract voor public.sb_fin_run_zet (migratie 0010 in socev-scripts): scope, dekking, tellingen,
 * vaste aannamecodes en de sha256 van de momentopname en de bronbestanden. Nooit bedragen, IBAN's, namen of omschrijvingen: de RPC is een
 * witte lijst per veld en weigert al het andere met een vaste code. Een bronbestand gaat alleen mee als het er nog is en zijn sha256 klopt
 * (Supabase: blob + source_record 'bank' + source_revision met de periode). Statussen uit het FV2-archief zijn vrije tekst: alleen bekende
 * codes gaan mee, de rest als archief_overig.
 */
const APP_STATUSSEN = ['te_beoordelen', 'geen_factuur', 'dubbel', 'in_wachtrij', 'prive_archief', 'wordt_verstuurd', 'concept_klaar', 'verstuurd', 'verzending_mislukt'];
const REGISTREER_POGINGEN = 5;
function uitgeslotenCode(s) {
  if (s === 'genegeerd' || s === 'geen_factuur' || s === 'archief_leeg') return s;
  if (/^app_/.test(s)) return APP_STATUSSEN.includes(s.slice(4)) ? s : 'app_overig';
  return 'archief_overig';
}
function contract(db, r, bankbron) {
  const scope = JSON.parse(r.scope), tel = JSON.parse(r.telling);
  const fv2 = db.prepare("SELECT factuurdatum AS d FROM aansluiting WHERE run = ? AND factuur_ref LIKE 'archief:%' AND factuurdatum IS NOT NULL").all(r.id)
    .map((x) => x.d).filter((d) => K.isIsoDatum(d)).sort();
  const uitgesloten = {};
  for (const [k, n] of Object.entries(tel.facturen.uitgesloten || {})) { const c = uitgeslotenCode(k); uitgesloten[c] = (uitgesloten[c] || 0) + Number(n); }
  const aannames = [...new Set(JSON.parse(r.aannames || '[]').map((a) => (/^uitgesloten_/.test(a) ? 'uitgesloten_' + uitgeslotenCode(a.slice(12)) : a)))];
  const bronnen = [];
  let zonder = 0;
  for (const b of JSON.parse(r.bronnen || '[]')) {
    if (!b.formaat || !b.van || !b.tot || !/^[0-9a-f]{64}$/.test(String(b.sha256))) { zonder++; continue; }
    let bytes;
    try { bytes = fs.readFileSync(path.join(bankbron, b.sha256)); } catch (e) { zonder++; continue; }
    if (sha256(bytes) !== b.sha256) { zonder++; continue; }
    bronnen.push({ sha256: b.sha256, grootte: bytes.length, formaat: b.formaat, van: b.van, tot: b.tot });
  }
  const per = tel.facturen.per_status;
  return {
    pod_run: r.id, sleutel: sha256(canon({ run: r.id, gestart: r.gestart_op, snapshot: r.snapshot_sha256, uitkomst: r.uitkomst_hash })),
    versie: /^[0-9a-f]{7,40}$/.test(String(r.regels_versie)) ? r.regels_versie : 'onbekend',
    gestart_op: r.gestart_op, klaar_op: r.klaar_op, uitkomst: r.uitkomst, code: r.code || null,
    scope: { entiteit: scope.entiteit, rekening_label: scope.rekening_label, periode_van: scope.periode_van || null, periode_tot: scope.periode_tot || null,
      facturenset: scope.facturenset, dekking_van: scope.dekking_van, dekking_tot: scope.dekking_tot, peil_van: scope.peil_van },
    coverage: { bank_tm: r.bank_tm || null, laatst_gedekt: r.laatst_gedekt || null, dagen_per_status: tel.dagen,
      facturen_aanname_van: fv2.length ? fv2[0] : null, facturen_aanname_tot: fv2.length ? fv2[fv2.length - 1] : null },
    rows_matched: tel.facturen.facturen_in_scope, rows_returned: Object.values(per).reduce((a, b) => a + Number(b), 0),
    telling: { per_status: per, onverklaard: tel.onverklaard || {}, uitgesloten, storno_paren: tel.storno_paren || 0, bronnen_zonder_bestand: zonder },
    assumptions: aannames, snapshot: r.snapshot_sha256, bronnen,
  };
}
// Een fout van de aanroep zelf → korte vaste code (nooit de melding: die kan een adres of antwoordtekst dragen)
function rpcFoutCode(e) { const m = /http (\d{3})/.exec(String(e && e.message || '')); return m ? 'rpc_http_' + m[1] : 'rpc_netwerk'; }
/*
 * Zet runs die nog niet in Supabase staan: nieuwste eerst (de run van zojuist gaat altijd mee), hooguit opties.max (3) per keer. Een geweigerd
 * contract (vaste code van de RPC) telt als poging, hooguit REGISTREER_POGINGEN; een tijdelijke fout (netwerk, HTTP, schrijffout in Supabase:
 * RPC nog niet of niet meer aanwezig) niet (diffreview wv1899 ZOU 5). opties.opnieuw: de pogingen van geweigerde runs eerst op 0.
 * rpc(fn, body) → Promise<json> (server.js: appSbRpc; CLI: rpcVanOmgeving). opties.droog: alleen de contracten teruggeven, niets versturen.
 * → { gezet, al, fouten: [{ run, fout }], open, contracten? }
 */
const tijdelijk = (f) => /^(rpc_|schrijffout:)/.test(f);
async function registreer(dir, rpc, opties) {
  const o = Object.assign({ max: 3, bankbron: path.join(path.dirname(STANDAARD_FACTUREN), 'bankbron'), nu: Date.now(), droog: false }, opties || {});
  if (!fs.existsSync(path.join(dir, 'reken.sqlite'))) return { gezet: 0, al: 0, fouten: [], open: 0 };
  const db = openReken(dir);
  try {
    if (o.opnieuw && !o.droog) db.prepare('UPDATE supabase_zet SET pogingen = 0 WHERE ok = 0').run();
    const open = db.prepare('SELECT r.* FROM reken_run r LEFT JOIN supabase_zet z ON z.run = r.id WHERE r.klaar_op IS NOT NULL AND r.uitkomst IS NOT NULL AND (z.run IS NULL OR (z.ok = 0 AND z.pogingen < ?)) ORDER BY r.id DESC')
      .all(REGISTREER_POGINGEN);
    const uit = { gezet: 0, al: 0, fouten: [], open: open.length };
    const beurt = open.slice(0, Math.max(1, Math.min(Number(o.max) || 3, 50)));
    if (o.droog) { uit.contracten = beurt.map((r) => contract(db, r, o.bankbron)); return uit; }
    const zet = db.prepare('INSERT INTO supabase_zet (run, ok, run_id, query_run_id, fout, pogingen, op) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (run) DO UPDATE SET ok = excluded.ok, run_id = excluded.run_id, query_run_id = excluded.query_run_id, fout = excluded.fout, pogingen = supabase_zet.pogingen + excluded.pogingen, op = excluded.op');
    for (const r of beurt) {
      let antw = null, fout = null, c = null;
      try { c = contract(db, r, o.bankbron); } catch (e) { fout = 'contract'; }
      if (c) { try { antw = await rpc('sb_fin_run_zet', { p: c }); } catch (e) { fout = rpcFoutCode(e); } }
      const op = new Date(o.nu).toISOString();
      if (!fout && antw && antw.ok === true && Number.isInteger(antw.run_id) && Number.isInteger(antw.query_run_id)) {
        zet.run(r.id, 1, antw.run_id, antw.query_run_id, null, 0, op);
        if (antw.nieuw === false) uit.al++; else uit.gezet++;
      } else {
        const f = fout || (antw && typeof antw.fout === 'string' && /^[a-zA-Z0-9_.:]{1,60}$/.test(antw.fout) ? antw.fout : 'antwoord_onbekend');
        zet.run(r.id, 0, null, null, f, tijdelijk(f) ? 0 : 1, op);
        uit.fouten.push({ run: r.id, fout: f });
      }
    }
    uit.open = open.length - uit.gezet - uit.al;
    return uit;
  } finally { db.close(); }
}
function rpcVanOmgeving() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, ''), key = process.env.SUPABASE_SERVICE_ROLE || '';
  if (!url || !key) throw new FinFout('geen_supabase', 'SUPABASE_URL en SUPABASE_SERVICE_ROLE ontbreken');
  return async function (fn, body) {
    const r = await fetch(url + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('rpc ' + fn + ' http ' + r.status);
    return r.json();
  };
}

// ───────────────────────────── CLI ─────────────────────────────

function argsVan(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('--')) { const k = x.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; a[k] = v; } else a._.push(x);
  }
  return a;
}
// Geeft een Promise; de uitvoer (JSON op stdout) is pas compleet als die klaar is. Supabase alleen met --registreer of het commando registreer.
async function main(argv) {
  const a = argsVan(argv);
  const dir = a.dir || process.env.FIN_REKEN_DIR || STANDAARD_DIR;
  const nu = Date.now();
  const cmd = a._[0] || 'stand';
  const facturen = a.facturen || process.env.FIN_FACTUREN || STANDAARD_FACTUREN;
  const bankbron = a.bankbron || path.join(path.dirname(facturen), 'bankbron');
  let uit;
  if (cmd === 'run') {
    const rpc = a.registreer ? rpcVanOmgeving() : null;   // zonder omgeving meteen weigeren, niet na de run (diffreview KAN)
    uit = run({ dir, facturen, bankbron: a.bankbron, entiteit: a.entiteit || 'tolgaarde', rekening: a.rekening,
      snapshot: a.snapshot, periode: { van: a.van || null, tot: a.tot || null }, nu });
    uit.opruim = opruim(dir, nu);
    if (rpc) uit.supabase = await registreer(dir, rpc, { bankbron, nu });
  } else if (cmd === 'droog') {
    // nu: ISO-tijd of epoch-ms van buiten (het podstaat-stempel); de klok van deze machine telt niet
    const n = /^\d+$/.test(String(a.nu || '')) ? Number(a.nu) : Date.parse(String(a.nu || ''));
    uit = droog({ facturen: a.facturen, bankbron: a.bankbron, entiteit: a.entiteit || 'tolgaarde', rekening: a.rekening, nu: n });
  } else if (cmd === 'registreer') {
    uit = await registreer(dir, a.droog ? null : rpcVanOmgeving(), { bankbron, nu, max: a.max, droog: !!a.droog, opnieuw: !!a.opnieuw });
  } else if (cmd === 'stand') uit = laatste(dir, { entiteit: a.entiteit || 'tolgaarde', status: a.status, max: a.max, regels: !!a.regels });
  else if (cmd === 'opruim') uit = opruim(dir, nu);
  else if (cmd === 'besluit') uit = besluit(dir, { factuur_ref: a.factuur, entry_refs: String(a['entry-refs'] || '').split(',').filter(Boolean), oordeel: a.oordeel, wie: a.wie, bron: a.bron, toelichting: a.toelichting }, nu);
  else throw new FinFout('onbekend', 'gebruik: run|stand|opruim|besluit|registreer|droog');
  process.stdout.write(JSON.stringify(uit, null, 1) + '\n');
}
if (require.main === module) {
  main(process.argv.slice(2)).catch(function (e) {
    // een onverwachte fout kan bankinhoud in zijn melding dragen: alleen de naam, de stapel alleen met FIN_DEBUG=1 (op de pod, nooit in een rapport)
    if (process.env.FIN_DEBUG === '1') process.stderr.write(String(e && e.stack || e) + '\n');
    process.stdout.write(JSON.stringify({ ok: false, fout: e instanceof FinFout ? e.code : 'fout', uitleg: e instanceof FinFout ? e.uitleg : String(e && e.name || 'fout') }) + '\n'); process.exitCode = 1;
  });
}

module.exports = { FinFout, STANDAARD_DIR, SCHEMA, openReken, momentopname, snapshotPad, bronRegels, keten, gemaaktOp, dekkingRekening, rekeningVan, facturenVan, run, droog, laatste, opruim, besluit, dekkingsregel,
  contract, registreer, uitgeslotenCode, main };
