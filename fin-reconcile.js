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
 * Terugrol: map <dir> weg (de Facturen-app merkt niets). CLI: tools/fin-reconcile.js (of node fin-reconcile.js run|stand|besluit|opruim).
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
function maakMap(p) { fs.mkdirSync(p, { recursive: true, mode: 0o700 }); fs.chmodSync(p, 0o700); }
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
`;
function openReken(dir) {
  maakMap(dir);
  const p = path.join(dir, 'reken.sqlite');
  const DB = sqlite();
  const db = new DB(p);
  try { fs.chmodSync(p, 0o600); } catch (e) { /* net aangemaakt door SQLite: hieronder nog eens */ }
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
    for (const i of voor.length <= achter.length ? voor : achter) reeks(rijen[i].dag, rijen[i + 1].dag);
    return { gecontroleerd: true, breuk };
  }
  if (rijen.some((r) => r.e === null || r.e === undefined)) return { gecontroleerd: false, breuk };
  const oud = [], nieuw = [];
  for (let i = 0; i + 1 < n; i++) { if (rijen[i].e + rijen[i + 1].c !== rijen[i + 1].e) oud.push(i); if (rijen[i].e - rijen[i].c !== rijen[i + 1].e) nieuw.push(i); }
  for (const i of oud.length <= nieuw.length ? oud : nieuw) reeks(rijen[i].dag, rijen[i + 1].dag);
  return { gecontroleerd: true, breuk };
}
// Wanneer is het bestand gemaakt (dag)? ABN-export: TXTjjmmddhhmmss in de naam; anders de uploaddag (bovengrens: gemaakt vóór of op die dag).
function gemaaktOp(b) {
  const m = /TXT(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(b.naam || ''));
  if (m) { const d = '20' + m[1] + '-' + m[2] + '-' + m[3]; if (K.isIsoDatum(d)) return d; }
  const u = String(b.geupload_op || '').slice(0, 10);
  return K.isIsoDatum(u) ? u : null;
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
    let br;
    try { br = bronRegels(bytes, rekening.iban); } catch (e) { info.fout = e instanceof FinFout ? e.code : 'bron_onleesbaar'; continue; }
    info.formaat = br.formaat; info.regels = br.rijen.length;
    if (!br.rijen.length) { info.fout = 'geen_regels_van_rekening'; continue; }
    const dagen = br.rijen.map((r) => r.dag).sort();
    info.van = dagen[0]; info.tot = dagen[dagen.length - 1];
    const gemaakt = gemaaktOp(b);
    info.eind = gemaakt && gemaakt <= info.tot ? K.plusDagen(info.tot, -1) : info.tot;
    const k = keten(br.rijen, br.formaat);
    info.gecontroleerd = k.gecontroleerd;
    if (!k.gecontroleerd) info.fout = 'saldo_niet_te_controleren';
    const perDag = new Map();
    for (const r of br.rijen) { const x = perDag.get(r.dag) || { n: 0, som: 0 }; x.n++; x.som += r.c; perDag.set(r.dag, x); }
    info._dag = perDag; info._breuk = k.breuk;
  }
  const dagen = [];
  for (const d of dagReeks(van, tot)) {
    const dv = db.get(d) || { n: 0, som: 0 };
    const dekt = bronnen.filter((s) => s._dag && s.gecontroleerd && d >= s.van && d <= s.eind);
    let status, reden;
    if (!dekt.length) {
      status = dv.n ? 'alleen_databank' : 'ontbreekt';
      reden = bronnen.some((s) => s._dag && s.gecontroleerd && d === s.tot && s.eind < s.tot) ? 'exportdag'
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
  for (const s of bronnen) { delete s._dag; delete s._breuk; }
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
    const rekening = rekeningVan(sdb, o.entiteit, o.rekening);
    const label = eind4(rekening.iban);
    const fv = facturenVan(sdb, o.entiteit, o.periode || {});
    const datums = fv.lijst.map((f) => f.factuurdatum).filter((d) => d && K.isIsoDatum(d)).sort();
    const vandaag = dagAmsterdam(o.nu);
    const scope = { entiteit: o.entiteit, rekening_label: label, periode_van: (o.periode || {}).van || null, periode_tot: (o.periode || {}).tot || null,
      facturenset: 'fv2_archief_beslist+facturen_vanaf_verstuurd', dekking_van: datums.length ? K.plusDagen(datums[0], -T.VENSTER_VOOR) : K.plusDagen(vandaag, -365), dekking_tot: vandaag };
    scope.peil_van = datums.length ? K.plusDagen(datums[0], -T.VOORUIT_ZONDER_SLEUTEL) : scope.dekking_van;
    const dek = dekkingRekening(sdb, rekening, scope.dekking_van, scope.dekking_tot, o.bankbron, scope.peil_van);
    const transacties = sdb.prepare('SELECT entry_ref, boekdatum, bedrag_centen, tegenpartij_iban, tegenpartij_naam, omschrijving, kenmerk, categorie FROM bank_transactie WHERE rekening = ? AND verwijderd_op IS NULL').all(rekening.id)
      .map((t) => Object.assign({}, t, { bedrag_centen: Number(t.bedrag_centen) }));
    const ks = sdb.prepare('SELECT k.factuur, k.bron, k.methode, k.volledig, t.entry_ref FROM koppeling k JOIN bank_transactie t ON t.id = k.transactie WHERE t.rekening = ? AND t.verwijderd_op IS NULL ORDER BY k.id').all(rekening.id);
    const koppelingen = ks.map((k) => ({ entry_ref: k.entry_ref, factuur_ref: 'factuur:' + k.factuur, methode: k.methode }));
    const besluiten = ks.filter((k) => k.bron === 'mens' && k.methode !== 'sepa_terug').map((k) => ({ factuur_ref: 'factuur:' + k.factuur, entry_refs: [k.entry_ref], oordeel: 'ja', bron: 'koppeling' }))
      .concat(rdb.prepare('SELECT factuur_ref, entry_refs, oordeel FROM besluit ORDER BY id').all().map((b) => ({ factuur_ref: b.factuur_ref, entry_refs: JSON.parse(b.entry_refs), oordeel: b.oordeel, bron: 'besluit' })));
    const fv2 = fv.lijst.filter((f) => f.herkomst === 'fv2' && f.factuurdatum && K.isIsoDatum(f.factuurdatum)).map((f) => f.factuurdatum).sort();
    const aanname = fv2.length ? { van: K.plusDagen(fv2[0], T.VENSTER_VOOR), tot: fv2[fv2.length - 1], fv2_van: fv2[0], fv2_tot: fv2[fv2.length - 1] } : {};
    const uitk = T.sluitAan({ facturen: fv.lijst, transacties, besluiten, koppelingen, dekking: dek, aanname, scope: { van: scope.dekking_van, tot: scope.dekking_tot } });
    const aannames = ['venster_-45_+120_met_sleutel_-7_+120_zonder', 'reeds_voldaan_niet_getoetst', 'andere_eigen_rekening_niet_bekeken', 'facturenset_fv2_aanname_compleet']
      .concat(Object.keys(fv.uitgesloten).sort().map((s) => 'uitgesloten_' + s)).concat(uitk.aannames);
    const vinger = sha256(canon({ snap: snap.sha256, bronnen: dek.bronnen.map((b) => b.sha256), besluiten, scope, regels: regelsHash() }));
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
    if (o.regels) uit.onverklaard_regels = db.prepare('SELECT boekdatum, bedrag_centen, tegenpartij_naam, omschrijving, reden, factuur_ref FROM onverklaard WHERE run = ? ORDER BY reden, boekdatum, entry_ref LIMIT ?').all(r.id, max);
    return uit;
  } finally { db.close(); }
}

// Momentopnamen zonder run in de laatste 90 dagen weg; halve tijdelijke bestanden (> 1 uur) ook. → { weg: n }
function opruim(dir, nu) {
  const snap = path.join(dir, 'snapshot');
  if (!fs.existsSync(snap)) return { weg: 0 };
  const p = path.join(dir, 'reken.sqlite');
  const nodig = new Set();
  if (fs.existsSync(p)) {
    const DB = sqlite();
    const db = new DB(p, { readOnly: true });
    try { for (const r of db.prepare('SELECT DISTINCT snapshot_sha256 AS s FROM reken_run WHERE gestart_op >= ?').all(new Date(nu - BEWAAR_DAGEN * 86400000).toISOString())) nodig.add(r.s); }
    finally { db.close(); }
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

// ───────────────────────────── CLI ─────────────────────────────

function argsVan(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('--')) { const k = x.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; a[k] = v; } else a._.push(x);
  }
  return a;
}
function main(argv) {
  const a = argsVan(argv);
  const dir = a.dir || process.env.FIN_REKEN_DIR || STANDAARD_DIR;
  const nu = Date.now();
  const cmd = a._[0] || 'stand';
  let uit;
  if (cmd === 'run') {
    uit = run({ dir, facturen: a.facturen || process.env.FIN_FACTUREN || STANDAARD_FACTUREN, bankbron: a.bankbron, entiteit: a.entiteit || 'tolgaarde', rekening: a.rekening,
      snapshot: a.snapshot, periode: { van: a.van || null, tot: a.tot || null }, nu });
    uit.opruim = opruim(dir, nu);
  } else if (cmd === 'stand') uit = laatste(dir, { entiteit: a.entiteit || 'tolgaarde', status: a.status, max: a.max, regels: !!a.regels });
  else if (cmd === 'opruim') uit = opruim(dir, nu);
  else if (cmd === 'besluit') uit = besluit(dir, { factuur_ref: a.factuur, entry_refs: String(a['entry-refs'] || '').split(',').filter(Boolean), oordeel: a.oordeel, wie: a.wie, bron: a.bron, toelichting: a.toelichting }, nu);
  else throw new FinFout('onbekend', 'gebruik: run|stand|opruim|besluit');
  process.stdout.write(JSON.stringify(uit, null, 1) + '\n');
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (e) {
    // een onverwachte fout kan bankinhoud in zijn melding dragen: alleen de naam, de stapel alleen met FIN_DEBUG=1 (op de pod, nooit in een rapport)
    if (process.env.FIN_DEBUG === '1') process.stderr.write(String(e && e.stack || e) + '\n');
    process.stdout.write(JSON.stringify({ ok: false, fout: e instanceof FinFout ? e.code : 'fout', uitleg: e instanceof FinFout ? e.uitleg : String(e && e.name || 'fout') }) + '\n'); process.exitCode = 1;
  }
}

module.exports = { FinFout, STANDAARD_DIR, SCHEMA, openReken, momentopname, snapshotPad, bronRegels, keten, gemaaktOp, dekkingRekening, rekeningVan, facturenVan, run, laatste, opruim, besluit, dekkingsregel, main };
