'use strict';
/*
 * bank-archief.js — de blijvende transactiedatabase van de bankluis (wv687, 21-10-2026). Bouwplan: vault 01_Ontwikkeling/
 * Bankkoppeling open banking - verkenning en bouwplan (20-10-2026).md, § 9c.
 *
 * WAAROM. David (20-10 22:38): "Ik wil dat je in een database alle banktransacties plaatst van alle rekeningen. Zodat wij een
 * 'lokale' kopie hebben van alles wat we gesynct hebben. Die database mag best kolommen extra krijgen, voor typeringen etc, AI
 * omschrijving, categorieen etc, eigenaren". De cache (cache.sqlite) gooit alles ouder dan 400 dagen weg en wist wachtende
 * posten; dit archief bewaart alles en verrijkt het (type, categorie, eigenaar, interne overboeking, abonnement).
 *
 * HOE. bank-lezer.js schrijft elke opgehaalde post ook hierheen (archief.bij) en roept de leesopdrachten aan (zoek, maand,
 * intern, abonnementen, corrigeer, stand). BANK_DIR/transacties.sqlite (600, WAL). Ruwe velden worden nooit bijgewerkt en
 * nooit verwijderd; alleen laatst_gezien, de status (pending → vervangen/vervallen) en een ontbrekende ruwe_json.
 * Verrijking staat los van de ruwe rij (tabel verrijking, met versie en historie). Voorrang: David per post > regel van David >
 * systeemregel (intern, eigenaar van de rekening) > AI. Een rij met herkomst 'david' wordt nooit overschreven.
 *
 * GEEN NETWERK. Dit bestand laadt geen netwerk- of procesmodules (CI-poort in build.yml): het archief kan per constructie niets
 * naar een bank of elders sturen. Het AI-oordeel komt van server.js (Sonnet via claude -p) en gaat via aiZet hierin.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSIE = 1;
// Categorielijst, vastgesteld door David 21-10-2026 (bouwplan § 9c; David kan er via corrigeer een bij maken).
const CAT_UIT = ['wonen', 'verzekeringen', 'boodschappen', 'huishouden', 'vervoer', 'abonnementen en communicatie', 'kinderen', 'gezondheid',
  'kleding en persoonlijk', 'horeca en uit eten', 'vrije tijd en sport', 'vakantie en reizen', 'cadeaus en goede doelen', 'Gambia-hulp',
  'belastingen', 'bankkosten', 'contant geld', 'overig'];
const CAT_IN = ['inkomen', 'teruggave en terugbetaling', 'toeslagen en kinderbijslag', 'rente', 'overig inkomen'];
const CAT_OVER = ['sparen en beleggen', 'intern'];
const TYPES = ['uitgave', 'inkomst', 'intern', 'terugboeking'];
const EIGENAREN = ['David', 'Cynthia', 'samen', 'kind', 'Gambia-hulp', 'extern', 'onbekend'];
// Extern (wv709, David 21-10-2026): een rekening op Davids naam die van een ander is (de bunq-rekening van Elizabeth). Een
// overboeking ernaar of ervan is geen interne overboeking maar een uitgave of inkomst; haar eigen posten tellen niet mee in
// zoek, maand, intern en abonnementen (wel bewaard; met rekening=… op te vragen); haar saldo is geen vermogen van David.
const EXTERN = 'extern';
const LET_OP_EXTERN = 'externe rekening: staat op Davids naam maar is van een ander; posten en saldo zijn niet van David';
const OORDEEL = ['type', 'categorie', 'subcategorie', 'ai_omschrijving', 'eigenaar'];
const ZICHTBAAR = "t.status IN ('booked', 'pending')";
const LET_OP_GEZAMENLIJK = 'gezamenlijke rekening: posten van de mede-eigenaar staan erin; alleen voor David, nooit naar buiten';
// wv764: kolommen van een herkende reeks (ontwerp privé-financiën § 4). sleutel_soort: machtiging | naam | omschrijving (+ |cluster).
const ABO_KOLOMMEN = [['sleutel_soort', 'TEXT'], ['groep', 'TEXT'], ['soort', 'TEXT'], ['wijze', 'TEXT'], ['per_maand', 'REAL'], ['n_per_maand', 'INTEGER'],
  ['termijnen', 'INTEGER'], ['termijnen_bron', 'TEXT'], ['bedrag_vorig', 'REAL'], ['gewijzigd_op', 'TEXT'], ['verwacht_volgende', 'TEXT'], ['dag', 'INTEGER'],
  ['extra', 'INTEGER'], ['afrekening', 'INTEGER'], ['bedrag_min', 'REAL'], ['bedrag_max', 'REAL'], ['categorie', 'TEXT'], ['subcategorie', 'TEXT'],
  ['laatste_afwijkend', 'REAL'], ['laatste_afwijkend_op', 'TEXT']];
// Vaste last (niet opzegbaar) of abonnement (opzegbaar), naar de categorie van de laatste post; David stuurt via de categorie (corrigeer).
const VAST_CAT = ['wonen', 'verzekeringen', 'belastingen', 'bankkosten'];
const GEEN_REEKS_CAT = ['boodschappen', 'horeca en uit eten', 'contant geld', 'vakantie en reizen', 'kleding en persoonlijk'];

function nuIso() { return new Date().toISOString(); }
function vandaag() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
function plusDagen(datum, n) { const d = new Date(datum + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dagVerschil(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }
function r2(n) { return Math.round(n * 100) / 100; }
function ibanNorm(i) { return i ? String(i).replace(/\s+/g, '').toUpperCase() : null; }
function mediaan(l) { const s = l.slice().sort(function (a, b) { return a - b; }); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; }
// Sleutel van een tegenpartij of omschrijving: kleine letters, zonder accenten, cijfers en leestekens, eerste 4 woorden.
function woordSleutel(t) {
  if (!t) return '';
  return String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim()
    .split(' ').filter(function (w) { return w.length >= 2; }).slice(0, 4).join(' ');
}
function richting(bedrag) { return bedrag < 0 ? 'af' : 'bij'; }
function groepSleutel(t) {
  return crypto.createHash('sha256').update([richting(t.bedrag), woordSleutel(t.tegenpartij), woordSleutel(t.omschrijving)].join('|')).digest('hex').slice(0, 16);
}
// Tekst voor het taalmodel: geen naam van David of Cynthia (opdracht wv687), geen IBAN of lange cijferreeks. Extra namen (meisjesnaam,
// kinderen) staan alleen lokaal in meta 'masker_namen', gezet door de machinekamer (opdracht masker), niet in de code (Fable wv687 #9).
function maskeer(t, n, extra) {
  if (t == null) return null;
  let s = String(t).normalize('NFC');
  (extra || []).forEach(function (re) { s = s.replace(re, '[eigen]'); });
  return s.replace(/\b(d\.?\s*)?schaap\b/gi, '[eigen]').replace(/\bdavid\b/gi, '[eigen]').replace(/\bcynthia\b/gi, '[eigen]')
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9 ]{10,30}\b/g, '[iban]').replace(/\d{7,}/g, '#').replace(/\s+/g, ' ').trim().slice(0, n || 140) || null;
}
function maskerLijst(a) {
  let l = [];
  try { l = JSON.parse(metaLees(a, 'masker_namen') || '[]'); } catch (e) { l = []; }
  return (Array.isArray(l) ? l : []).filter(function (x) { return typeof x === 'string' && x.trim().length >= 2; })
    .map(function (x) { return new RegExp('(?<![\\p{L}])' + x.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '(?![\\p{L}])', 'giu'); });
}
function maskerZet(a, namen) {
  const l = (Array.isArray(namen) ? namen : []).map(function (x) { return String(x).normalize('NFC').trim(); }).filter(function (x) { return x.length >= 2 && x.length <= 60 && /^[\p{L} .'-]+$/u.test(x); });
  metaZet(a, 'masker_namen', JSON.stringify(Array.from(new Set(l))));
  return { namen: l.length };
}
function geldigLabel(v, n) { return typeof v === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} .,&'()\-/]{0,79}$/u.test(v.trim()) && v.trim().length <= (n || 40) ? v.trim() : null; }

// ── openen en schema ────────────────────────────────────────────────────────
function open(bankDir) {
  fs.mkdirSync(bankDir, { recursive: true, mode: 0o700 });
  const pad = path.join(bankDir, 'transacties.sqlite');
  const nieuw = !fs.existsSync(pad);
  if (nieuw) fs.closeSync(fs.openSync(pad, 'a', 0o600));
  try { fs.chmodSync(pad, 0o600); } catch (e) {}
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(pad);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;');
  ['-wal', '-shm'].forEach(function (s) { try { fs.chmodSync(pad + s, 0o600); } catch (e) {} });
  db.exec(
    'CREATE TABLE IF NOT EXISTS meta (sleutel TEXT PRIMARY KEY, waarde TEXT);' +
    'CREATE TABLE IF NOT EXISTS rekeningen (rek TEXT PRIMARY KEY, bron TEXT NOT NULL, uid TEXT, iban TEXT, iban_eind TEXT, naam TEXT, label TEXT,' +
    ' soort TEXT, status TEXT, gezamenlijk INTEGER NOT NULL DEFAULT 0, eigenaar TEXT, eigenaar_herkomst TEXT, eerste_gezien TEXT NOT NULL, laatst_gezien TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS transacties (nr INTEGER PRIMARY KEY, rek TEXT NOT NULL, sleutel TEXT NOT NULL, bron_id TEXT NOT NULL, status TEXT NOT NULL,' +
    ' datum TEXT, valutadatum TEXT, bedrag REAL, valuta TEXT, tegenpartij TEXT, tegen_iban TEXT, omschrijving TEXT, saldo_na REAL, mcc TEXT,' +
    ' ruwe_json TEXT, herkomst_rij TEXT NOT NULL, eerste_gezien TEXT NOT NULL, laatst_gezien TEXT NOT NULL, vervangen_door INTEGER, UNIQUE (rek, sleutel));' +
    'CREATE INDEX IF NOT EXISTS t_rek_datum ON transacties (rek, datum);' +
    'CREATE INDEX IF NOT EXISTS t_datum ON transacties (datum);' +
    'CREATE TABLE IF NOT EXISTS regels (id INTEGER PRIMARY KEY, soort TEXT NOT NULL, patroon TEXT NOT NULL, rek TEXT, richting TEXT,' +
    ' type TEXT, categorie TEXT, subcategorie TEXT, eigenaar TEXT, herkomst TEXT NOT NULL, actief INTEGER NOT NULL DEFAULT 1, aangemaakt TEXT NOT NULL, bron_nr INTEGER);' +
    'CREATE TABLE IF NOT EXISTS ai_groepen (sleutel TEXT PRIMARY KEY, type TEXT, categorie TEXT NOT NULL, subcategorie TEXT, ai_omschrijving TEXT,' +
    ' model TEXT, gemaakt TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS abonnementen (id INTEGER PRIMARY KEY, rek TEXT NOT NULL, tegen_sleutel TEXT NOT NULL, naam TEXT, ritme TEXT,' +
    ' bedrag_typisch REAL, aantal INTEGER, eerste TEXT, laatste TEXT, actief INTEGER, bijgewerkt TEXT, UNIQUE (rek, tegen_sleutel));' +
    'CREATE TABLE IF NOT EXISTS verrijking (nr INTEGER PRIMARY KEY REFERENCES transacties (nr), type TEXT, categorie TEXT, subcategorie TEXT,' +
    ' ai_omschrijving TEXT, eigenaar TEXT, intern_paar INTEGER, abonnement_id INTEGER, herkomst TEXT NOT NULL, regel_id INTEGER,' +
    ' david_velden TEXT, versie INTEGER NOT NULL DEFAULT 1, bijgewerkt TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS ai_overslaan (sleutel TEXT PRIMARY KEY, pogingen INTEGER NOT NULL, laatst TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS verrijking_historie (id INTEGER PRIMARY KEY, nr INTEGER NOT NULL, versie INTEGER NOT NULL, json TEXT NOT NULL, tijd TEXT NOT NULL);');
  const v = db.prepare("SELECT waarde FROM meta WHERE sleutel = 'schema'").get();
  if (!v) db.prepare("INSERT INTO meta (sleutel, waarde) VALUES ('schema', ?)").run(String(SCHEMA_VERSIE));
  // Een nieuwer schema dan deze code kent (terugrollen): niet schrijven met oude code. Latere versies migreren hier (ALTER TABLE).
  else if (Number(v.waarde) > SCHEMA_VERSIE) { db.close(); throw new Error('archief heeft schema ' + v.waarde + ', deze code kent ' + SCHEMA_VERSIE); }
  // wv764 (idee 16 fase B): extra kolommen voor de vaste-lastenherkenning. Alleen toevoegen, geen schemaversie omhoog: oudere code
  // (terugrollen) leest en schrijft de tabel gewoon door; de rijen die zij schrijft (sleutel_soort leeg) ruimt de nieuwe herkenning op.
  // Onder BEGIN IMMEDIATE met hercontrole: twee processen die tegelijk voor het eerst openen (bank-ronde + leesopdracht) botsten
  // anders op 'database is locked' of 'duplicate column' (Fable wv764 #9).
  const abOntbreekt = function () { const k = new Set(db.prepare('PRAGMA table_info(abonnementen)').all().map(function (x) { return x.name; })); return ABO_KOLOMMEN.filter(function (x) { return !k.has(x[0]); }); };
  if (abOntbreekt().length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      abOntbreekt().forEach(function (k) { try { db.exec('ALTER TABLE abonnementen ADD COLUMN ' + k[0] + ' ' + k[1]); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } });
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) {} db.close(); throw e; }
  }
  return { db: db, pad: pad, dir: bankDir };
}
function externeRekeningen(a) { return new Set(a.db.prepare("SELECT rek FROM rekeningen WHERE lower(eigenaar) = 'extern'").all().map(function (r) { return r.rek; })); }
function metaLees(a, k) { const r = a.db.prepare('SELECT waarde FROM meta WHERE sleutel = ?').get(k); return r ? r.waarde : null; }
function metaZet(a, k, v) { a.db.prepare('INSERT INTO meta (sleutel, waarde) VALUES (?, ?) ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde').run(k, v == null ? null : String(v)); }
// Re-entrant: binnen een lopende transactie gewoon doorlopen (verrijk roept abonnementenHerken binnen zijn eigen transactie aan).
function inTransactie(a, fn) {
  if (a._inTx) return fn();
  a.db.exec('BEGIN IMMEDIATE');
  a._inTx = true;
  try { const r = fn(); a.db.exec('COMMIT'); return r; } catch (e) { try { a.db.exec('ROLLBACK'); } catch (e2) {} throw e; }
  finally { a._inTx = false; }
}

// ── rekeningen (uit stand.json) ─────────────────────────────────────────────
// Eigenaar van een rekening (systeem): gezamenlijk → samen, naam met kids/kind → kind, Gambia → Gambia-hulp, anders David.
// Een eigenaar die David zette (eigenaar_herkomst 'david') blijft altijd staan.
function eigenaarStandaard(r) {
  const n = String((r.label || '') + ' ' + (r.naam || '') + ' ' + (r.product || '')).toLowerCase();
  if (r.gezamenlijk || r.soort === 'gezamenlijk' || r.bron !== 'bunq') return 'samen';   // de enige ABN-rekening is de gezamenlijke (bouwplan § 2)
  if (/gambia/.test(n)) return 'Gambia-hulp';
  if (/\bkids?\b|\bkind(eren)?\b/.test(n)) return 'kind';
  return 'David';
}
function rekeningenSync(a, rekeningen) {
  const nu = nuIso(), gezien = new Set();
  const oud = new Map(a.db.prepare('SELECT rek, eigenaar, eigenaar_herkomst, status FROM rekeningen').all().map(function (r) { return [r.rek, r]; }));
  const zet = a.db.prepare('INSERT INTO rekeningen (rek, bron, uid, iban, iban_eind, naam, label, soort, status, gezamenlijk, eigenaar, eigenaar_herkomst, eerste_gezien, laatst_gezien)' +
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'systeem', ?, ?) ON CONFLICT (rek) DO UPDATE SET bron = excluded.bron, uid = excluded.uid, iban = COALESCE(excluded.iban, rekeningen.iban)," +
    ' iban_eind = COALESCE(excluded.iban_eind, rekeningen.iban_eind), naam = excluded.naam, label = excluded.label, soort = excluded.soort, status = excluded.status,' +
     " gezamenlijk = excluded.gezamenlijk, eigenaar = CASE WHEN rekeningen.eigenaar_herkomst IN ('david', 'machinekamer') THEN rekeningen.eigenaar ELSE excluded.eigenaar END," +
    ' laatst_gezien = excluded.laatst_gezien');
  inTransactie(a, function () {
    Object.keys(rekeningen || {}).forEach(function (h) {
      const r = rekeningen[h] || {}, bunq = r.bron === 'bunq', iban = ibanNorm(r.iban);
      gezien.add(h);
      zet.run(h, bunq ? 'bunq' : (/abn/i.test(r.bank || '') ? 'abn' : 'enablebanking'), r.uid || null, iban, iban ? iban.slice(-4) : null, r.naam || null, r.label || null,
        r.soort || r.product || null, bunq ? String(r.status || '?') : 'ACTIVE', (r.gezamenlijk || r.soort === 'gezamenlijk' || !bunq) ? 1 : 0, eigenaarStandaard(r), nu, nu);
    });
    // Lege lijst (onleesbare stand.json): niets op ontkoppeld zetten (Fable wv687 #10)
    if (gezien.size) oud.forEach(function (r, h) { if (!gezien.has(h) && r.status !== 'ontkoppeld') a.db.prepare("UPDATE rekeningen SET status = 'ontkoppeld' WHERE rek = ?").run(h); });
  });
  return gezien.size;
}

// Ontkoppelen (bank-lezer.js ontkoppel): de rekening blijft met al haar posten; alleen de status gaat op ontkoppeld.
function markeerOntkoppeld(a, reks) {
  const zet = a.db.prepare("UPDATE rekeningen SET status = 'ontkoppeld' WHERE rek = ?");
  inTransactie(a, function () { (reks || []).forEach(function (h) { zet.run(h); }); });
}

// ── schrijven ───────────────────────────────────────────────────────────────
// lijst: vereenvoudigde posten uit bank-lezer.js/bunq-lezer.js (id, datum, bedrag, status 'geboekt'/'wachtend', _ruw = het ruwe
// bankobject). volledigVanaf: de opvraag was volledig vanaf die dag tot vandaag (niet afgekapt); dan krijgt een wachtende post
// van die rekening die niet meer terugkwam status vervangen (geboekte tegenhanger) of vervallen.
function bij(a, rek, lijst, opties) {
  const o = opties || {}, nu = nuIso();
  const zet = a.db.prepare('INSERT INTO transacties (rek, sleutel, bron_id, status, datum, valutadatum, bedrag, valuta, tegenpartij, tegen_iban, omschrijving, saldo_na,' +
    ' mcc, ruwe_json, herkomst_rij, eerste_gezien, laatst_gezien) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)' +
    ' ON CONFLICT (rek, sleutel) DO UPDATE SET laatst_gezien = excluded.laatst_gezien, ruwe_json = COALESCE(transacties.ruwe_json, excluded.ruwe_json),' +
    " status = CASE WHEN transacties.status IN ('vervangen', 'vervallen') AND excluded.status = 'pending' THEN 'pending' ELSE transacties.status END," +
    " vervangen_door = CASE WHEN transacties.status IN ('vervangen', 'vervallen') AND excluded.status = 'pending' THEN NULL ELSE transacties.vervangen_door END");
  const telVoor = a.db.prepare('SELECT count(*) n FROM transacties WHERE rek = ?').get(rek).n;
  return inTransactie(a, function () {
    const gezien = new Set();
    (lijst || []).forEach(function (t) {
      const wacht = t.status === 'wachtend' || t.status === 'pending';
      gezien.add((wacht ? 'p|' : '') + t.id);
      let ruw = null;
      if (t._ruw) { try { ruw = JSON.stringify(t._ruw); } catch (e) { ruw = null; } }
      zet.run(rek, (wacht ? 'p|' : '') + t.id, String(t.id), wacht ? 'pending' : 'booked', t.datum || null, t.valutadatum || null, t.bedrag, t.valuta || 'EUR',
        t.tegenpartij || null, ibanNorm(t.tegen_iban), t.omschrijving || null, t.saldo_na == null ? null : t.saldo_na, t.mcc || null, ruw, o.herkomst || 'bank', nu, nu);
    });
    let vervangen = 0, vervallen = 0;
    if (o.volledigVanaf) {
      // zonder datum: het venster telt vanaf eerste_gezien (Fable wv687 #6)
      // niet teruggekomen = niet in deze lijst (op sleutel, niet op tijd: twee schrijfacties in dezelfde milliseconde, CI #159)
      const weg = a.db.prepare("SELECT nr, sleutel, datum, bedrag FROM transacties WHERE rek = ? AND status = 'pending' AND (datum >= ? OR (datum IS NULL AND eerste_gezien >= ?))")
        .all(rek, o.volledigVanaf, o.volledigVanaf).filter(function (p) { return !gezien.has(p.sleutel); });
      const kand = a.db.prepare("SELECT nr, datum FROM transacties t WHERE rek = ? AND status = 'booked' AND bedrag = ? AND datum >= ? AND datum <= ?" +
        ' AND NOT EXISTS (SELECT 1 FROM transacties p WHERE p.vervangen_door = t.nr) ORDER BY datum, nr');
      weg.forEach(function (p) {
        const k = kand.all(rek, p.bedrag, p.datum || '0000', plusDagen(p.datum || vandaag(), 10))[0];
        if (k) { a.db.prepare("UPDATE transacties SET status = 'vervangen', vervangen_door = ? WHERE nr = ?").run(k.nr, p.nr); vervangen++; }
        else { a.db.prepare("UPDATE transacties SET status = 'vervallen' WHERE nr = ?").run(p.nr); vervallen++; }
      });
    }
    metaZet(a, 'vuil', '1');
    const telNa = a.db.prepare('SELECT count(*) n FROM transacties WHERE rek = ?').get(rek).n;
    return { nieuw: telNa - telVoor, gezien: (lijst || []).length, vervangen: vervangen, vervallen: vervallen };
  });
}

// Cache → archief, incrementeel op 'opgehaald' (idempotent: INSERT OR IGNORE op de unieke sleutel). Zonder ruwe JSON (die
// bewaarde de cache niet); een latere opvraag van dezelfde post vult hem aan.
function migreerCache(a, cachePad) {
  if (!fs.existsSync(cachePad)) return { gemigreerd: 0, reden: 'geen cache' };
  const tot = metaLees(a, 'cache_tot') || '';
  const voor = a.db.prepare('SELECT count(*) n FROM transacties').get().n;
  a.db.prepare('ATTACH DATABASE ? AS c').run(cachePad);
  try {
    const heeft = a.db.prepare("SELECT count(*) n FROM c.sqlite_master WHERE type = 'table' AND name = 'tx'").get().n;
    if (!heeft) return { gemigreerd: 0, reden: 'geen tabel tx' };
    const kolIban = a.db.prepare('PRAGMA c.table_info(tx)').all().some(function (k) { return k.name === 'tegen_iban'; });
    const max = (a.db.prepare('SELECT max(opgehaald) m FROM c.tx').get() || {}).m || '';
    if (max && max <= tot) return { gemigreerd: 0, reden: 'bij' };
    inTransactie(a, function () {
      a.db.prepare('INSERT OR IGNORE INTO transacties (rek, sleutel, bron_id, status, datum, valutadatum, bedrag, valuta, tegenpartij, tegen_iban, omschrijving, saldo_na,' +
        ' mcc, ruwe_json, herkomst_rij, eerste_gezien, laatst_gezien)' +
        " SELECT rek, CASE WHEN status = 'wachtend' THEN 'p|' || id ELSE id END, id, CASE WHEN status = 'wachtend' THEN 'pending' ELSE 'booked' END," +
        ' datum, valutadatum, bedrag, valuta, tegenpartij, ' + (kolIban ? 'upper(replace(tegen_iban, \' \', \'\'))' : 'NULL') + ", omschrijving, saldo_na, mcc, NULL, 'cache', opgehaald, opgehaald" +
        ' FROM c.tx WHERE opgehaald > ?').run(tot);
      metaZet(a, 'cache_tot', max);
      metaZet(a, 'vuil', '1');
    });
  } finally { a.db.exec('DETACH DATABASE c'); }
  return { gemigreerd: a.db.prepare('SELECT count(*) n FROM transacties').get().n - voor };
}

// ── verrijken (regels) ──────────────────────────────────────────────────────
function categorieen(a) {
  const extra = a.db.prepare("SELECT DISTINCT categorie c FROM regels WHERE herkomst = 'david' AND categorie IS NOT NULL").all().map(function (r) { return r.c; })
    .concat(a.db.prepare("SELECT DISTINCT categorie c FROM verrijking WHERE herkomst = 'david' AND categorie IS NOT NULL").all().map(function (r) { return r.c; }));
  const alle = CAT_UIT.concat(CAT_IN, CAT_OVER);
  return alle.concat(extra.filter(function (c, i) { return alle.indexOf(c) < 0 && extra.indexOf(c) === i; }));
}
function rekeningNaam(r) { return r ? (r.label || r.naam || (r.uid ? String(r.uid).slice(0, 20) : String(r.rek).slice(0, 12))) : null; }

// Alle regels opnieuw toepassen op alle zichtbare posten; schrijft alleen wat verandert (versie + historie). Idempotent.
// Alles (lezen, rekenen, schrijven) in één BEGIN IMMEDIATE: een correctie van David in een ander proces kan er niet tussendoor
// en daarna weer overschreven worden (Fable wv687 #1). De upsert raakt een david-rij bovendien alleen met herkomst david.
function verrijk(a) { return inTransactie(a, function () { return verrijkBinnen(a); }); }
function verrijkBinnen(a) {
  const nu = nuIso(), db = a.db;
  const reks = new Map(db.prepare('SELECT * FROM rekeningen').all().map(function (r) { return [r.rek, r]; }));
  const ibanRek = new Map();
  reks.forEach(function (r) { if (r.iban) ibanRek.set(r.iban, r.rek); });
  const tx = db.prepare('SELECT t.nr, t.rek, t.datum, t.bedrag, t.tegenpartij, t.tegen_iban, t.omschrijving, t.status FROM transacties t WHERE ' + ZICHTBAAR + ' ORDER BY t.datum, t.nr').all();
  const bestaand = new Map(db.prepare('SELECT * FROM verrijking').all().map(function (v) { return [v.nr, v]; }));
  // regels van David gaan voor die van de machinekamer (alleen soort extern, wv709)
  const regels = db.prepare("SELECT * FROM regels WHERE actief = 1 AND herkomst IN ('david', 'machinekamer') ORDER BY herkomst = 'david' DESC, id DESC").all();
  const ext = externeRekeningen(a);
  const ai = new Map(db.prepare('SELECT * FROM ai_groepen').all().map(function (g) { return [g.sleutel, g]; }));

  // 1. interne overboekingen en paren (zelfde bedrag tegengesteld, ± 3 dagen, op de andere eigen rekening)
  const intern = new Map(), paar = new Map(), perRekBedrag = new Map();
  tx.forEach(function (t) {
    const doel = t.tegen_iban && ibanRek.get(t.tegen_iban);
    if (doel && doel !== t.rek) intern.set(t.nr, doel);
    const k2 = t.rek + '|' + r2(t.bedrag);
    if (!perRekBedrag.has(k2)) perRekBedrag.set(k2, []);
    perRekBedrag.get(k2).push(t);
  });
  tx.forEach(function (t) {
    const doel = intern.get(t.nr);
    if (!doel || paar.has(t.nr)) return;
    const eigenIban = (reks.get(t.rek) || {}).iban;
    // Voorkeur: een tegenpost die zelf naar deze rekening wijst; een post zonder tegen-IBAN alleen als er geen zo'n post is
    // (anders werd een storting van een derde zonder IBAN 'intern', Fable wv687 #3).
    const kand = (perRekBedrag.get(doel + '|' + r2(-t.bedrag)) || []).filter(function (u) {
      return !paar.has(u.nr) && t.datum && u.datum && Math.abs(dagVerschil(t.datum, u.datum)) <= 3 && (!u.tegen_iban || !eigenIban || u.tegen_iban === eigenIban);
    }).sort(function (x, y) {
      const wx = x.tegen_iban && x.tegen_iban === eigenIban ? 0 : 1, wy = y.tegen_iban && y.tegen_iban === eigenIban ? 0 : 1;
      return wx - wy || Math.abs(dagVerschil(t.datum, x.datum)) - Math.abs(dagVerschil(t.datum, y.datum)) || x.nr - y.nr;
    });
    if (kand.length) { paar.set(t.nr, kand[0].nr); paar.set(kand[0].nr, t.nr); if (!intern.has(kand[0].nr)) intern.set(kand[0].nr, t.rek); }
  });

  // 2. oordeel per post (3. daarna de reeksen: de herkenning gebruikt de categorie van dit oordeel, wv764)
  const zetV = db.prepare('INSERT INTO verrijking (nr, type, categorie, subcategorie, ai_omschrijving, eigenaar, intern_paar, abonnement_id, herkomst, regel_id, david_velden, versie, bijgewerkt)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (nr) DO UPDATE SET type = excluded.type, categorie = excluded.categorie, subcategorie = excluded.subcategorie,' +
    ' ai_omschrijving = excluded.ai_omschrijving, eigenaar = excluded.eigenaar, intern_paar = excluded.intern_paar, abonnement_id = excluded.abonnement_id,' +
    ' herkomst = excluded.herkomst, regel_id = excluded.regel_id, david_velden = excluded.david_velden, versie = excluded.versie, bijgewerkt = excluded.bijgewerkt' +
    " WHERE verrijking.herkomst <> 'david' OR excluded.herkomst = 'david'");
  const hist = db.prepare('INSERT INTO verrijking_historie (nr, versie, json, tijd) VALUES (?, ?, ?, ?)');
  let gewijzigd = 0;
  const oordelen = [];
  let abo = new Map();
  {
    tx.forEach(function (t) {
      const oud = bestaand.get(t.nr), rek = reks.get(t.rek) || {};
      // naarExt: overboeking tussen een eigen en een externe rekening (het paar blijft, maar het is geen intern); op de externe
      // rekening zelf is niets intern
      let doel = intern.get(t.nr);
      const naarExt = doel && ext.has(doel) && !ext.has(t.rek) ? doel : null;
      if (naarExt || ext.has(t.rek)) doel = null;
      const ts = woordSleutel(t.tegenpartij), rt = richting(t.bedrag);
      let n;
      {
        const r = regels.find(function (g) {
          if (g.rek && g.rek !== t.rek) return false;
          if (g.richting && g.richting !== rt) return false;
          if (g.soort === 'intern') return !!doel && g.patroon === doel;
          if (g.soort === 'extern') return !!naarExt && g.patroon === naarExt;
          if (g.herkomst !== 'david') return false;
          if (g.soort === 'tegenpartij') return !doel && !naarExt && !!ts && g.patroon === ts;
          return false;
        });
        const g = ai.get(groepSleutel(t));
        if (doel) {
          const dr = reks.get(doel) || {};
          n = { type: 'intern', categorie: /spaar/i.test(String(dr.soort || '')) || /spaar/i.test(String(dr.naam || '')) ? 'sparen en beleggen' : 'intern',
            subcategorie: null, ai_omschrijving: (t.bedrag < 0 ? 'Naar ' : 'Van ') + (rekeningNaam(dr) || 'eigen rekening'), eigenaar: null, herkomst: 'regel', regel_id: null };
        } else if (naarExt) {
          n = { type: t.bedrag < 0 ? 'uitgave' : 'inkomst', categorie: null, subcategorie: null, ai_omschrijving: (t.bedrag < 0 ? 'Naar ' : 'Van ') + (rekeningNaam(reks.get(naarExt)) || 'externe rekening'),
            eigenaar: null, herkomst: 'regel', regel_id: null };
        } else if (g) n = { type: g.type || (t.bedrag < 0 ? 'uitgave' : 'inkomst'), categorie: g.categorie, subcategorie: g.subcategorie, ai_omschrijving: g.ai_omschrijving, eigenaar: null, herkomst: 'ai', regel_id: null };
        else n = { type: t.bedrag < 0 ? 'uitgave' : 'inkomst', categorie: null, subcategorie: null, ai_omschrijving: null, eigenaar: null, herkomst: 'regel', regel_id: null };
        if (r) {
          // Een regel met een andere categorie dan de AI: subcategorie, type en omschrijving van de AI horen er niet meer bij (tegenlezing #1)
          if (r.categorie != null && !doel && !naarExt && !(g && g.categorie === r.categorie)) { n.ai_omschrijving = null; n.subcategorie = null; n.type = t.bedrag < 0 ? 'uitgave' : 'inkomst'; }
          ['type', 'categorie', 'subcategorie'].forEach(function (k) { if (r[k] != null) n[k] = r[k]; });
          n.herkomst = 'regel'; n.regel_id = r.id;
          if (r.eigenaar) n.eigenaar = r.eigenaar;
        }
        if ((naarExt || ext.has(t.rek)) && n.type === 'intern') n.type = t.bedrag < 0 ? 'uitgave' : 'inkomst';   // extern is nooit intern
        if (!n.eigenaar) n.eigenaar = rek.eigenaar || 'onbekend';
      }
      // David: alleen de velden die hij zelf zette staan vast; de rest rekent gewoon mee (Fable wv687 #4). Zonder lijst: alles vast.
      n.david_velden = null;
      if (oud && oud.herkomst === 'david') {
        let vast = oud.david_velden ? oud.david_velden.split(',') : OORDEEL;
        // Zette David een andere categorie dan de berekende, dan horen subcategorie en type van regel/AI er niet bij (tegenlezing #1)
        if (vast.indexOf('categorie') >= 0 && oud.categorie !== n.categorie) { n.subcategorie = null; if (!doel) n.type = t.bedrag < 0 ? 'uitgave' : 'inkomst'; }
        // een type 'intern' dat David zette voordat de tegenrekening extern werd, blijft niet staan: extern is nooit intern
        if ((naarExt || ext.has(t.rek)) && vast.indexOf('type') >= 0 && oud.type === 'intern') vast = vast.filter(function (k) { return k !== 'type'; });
        vast.forEach(function (k) { if (OORDEEL.indexOf(k) >= 0) n[k] = oud[k]; });
        n.herkomst = 'david'; n.regel_id = null; n.david_velden = oud.david_velden || null;
      }
      n.intern_paar = paar.get(t.nr) || null;
      oordelen.push({ t: t, oud: oud, n: n });
    });
    // 3. reeksen (vaste lasten en abonnementen): niet op een externe rekening, geen interne overboeking (ook niet naar een
    // externe rekening: die staat in vaste-lasten apart als steun), geen terugboeking
    abo = abonnementenHerken(a, oordelen.filter(function (x) {
      return !ext.has(x.t.rek) && !intern.has(x.t.nr) && x.n.type !== 'intern' && x.n.type !== 'terugboeking';
    }).map(function (x) { return Object.assign({}, x.t, { categorie: x.n.categorie, subcategorie: x.n.subcategorie }); }), nu);
    oordelen.forEach(function (x) {
      const t = x.t, oud = x.oud, n = x.n;
      n.abonnement_id = abo.get(t.nr) || null;
      const anders = !oud || OORDEEL.concat(['intern_paar', 'abonnement_id', 'herkomst', 'regel_id', 'david_velden']).some(function (k) { return (oud[k] == null ? null : oud[k]) !== (n[k] == null ? null : n[k]); });
      if (!anders) return;
      const oordeelAnders = oud && OORDEEL.some(function (k) { return (oud[k] == null ? null : oud[k]) !== (n[k] == null ? null : n[k]); });
      if (oordeelAnders) hist.run(t.nr, oud.versie, JSON.stringify(oud), nu);
      zetV.run(t.nr, n.type, n.categorie, n.subcategorie, n.ai_omschrijving, n.eigenaar, n.intern_paar, n.abonnement_id, n.herkomst, n.regel_id, n.david_velden,
        oud ? oud.versie + (oordeelAnders ? 1 : 0) : 1, nu);
      gewijzigd++;
    });
    metaZet(a, 'vuil', '0');
    metaZet(a, 'verrijkt_op', nu);
  }
  return { posten: tx.length, gewijzigd: gewijzigd, intern: intern.size, paren: paar.size / 2, abonnementen: new Set(abo.values()).size };
}
function verrijkAlsVuil(a) { return metaLees(a, 'vuil') === '0' ? null : verrijk(a); }

// ── reeksen: vaste lasten en abonnementen (wv764, idee 16 fase B) ──────────
// Ontwerp: vault 01_Ontwikkeling/Privé-financiën - ontwerp levend overzicht (bouwplan 22-10-2026).md § 4. Sleutel per reeks:
// 1. de SEPA-machtiging, genormaliseerd (spaties en voorloopnullen weg: ABN breekt waarden met spaties, de gemeente ging van
//    000000043562 naar 43562; niet de incassant erbij, het waterschap wisselde van incassant-ID bij dezelfde machtiging);
// 2. anders de genormaliseerde tegenpartij (rechtsvorm en "via …" weg); 3. zonder tegenpartij de omschrijving (ABN-betaalpakket).
// bunq kent geen incasso's en geen machtigingsvelden (gemeten 22-10-2026 over alle 26.789 bunq-posten): daar altijd sleutel 2.
// Binnen een sleutel: meerdere posten per maand (PayPal: ± 10 diensten achter één machtiging) → per bedragcluster (± 2%), met
// het aantal per maand per cluster; anders één reeks met een hoofdpost per maand. Een losse afwijkende post (eigen bijdrage,
// jaarafrekening, eenmalige extra) is geen ruis maar hangt als extra of afrekening aan de reeks en telt niet mee in het bedrag.
// Bedrag: dalend (lineaire hypotheek) = laatste post; wisselend (wonen/energie, Tibber) = gemiddelde over 12 maanden; anders de
// laatste vaste stand, met bedrag_vorig en gewijzigd_op bij een prijsstap; schommelt het na een stap licht, het gemiddelde sinds de stap.
// Termijnen (gemeente, waterschap): maandposten met een gat van 2+ maanden; per maand = termijnbedrag × termijnen / 12, met het
// aantal termijnen van de laatste volledig geziene termijnreeks, anders 10 (termijnen_bron 'aangenomen').
const OMS_LABEL = '(?:Incassant|Naam|Machtiging|Omschrijving|IBAN|BIC|Kenmerk|Betalingskenm\\w*|Eigen ?ref\\w*|Valutadatum|Reden|Terugboeking)\\s*:';
function omsVeld(oms, naam) {
  const m = new RegExp('\\b' + naam + '\\s*:\\s*([\\s\\S]*?)\\s*(?=' + OMS_LABEL + '|$)', 'i').exec(String(oms || ''));
  return m ? m[1] : null;
}
function machtigingVan(oms) {
  const m = omsVeld(oms, 'Machtiging');
  if (!m) return null;
  const s = m.replace(/\s+/g, '').toUpperCase().replace(/^0+(?=.)/, '');
  return /^[A-Z0-9./+?:()\-]{2,60}$/.test(s) ? s : null;
}
const RECHTSVORM = new Set(['bv', 'nv', 'sarl', 'sa', 'gmbh', 'ltd', 'inc', 'bvba', 'vof', 'cv']);
function naamNorm(t) {
  if (!t) return '';
  const s = String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+via\s+.*$/, '').replace(/[^a-z]+/g, ' ').trim();
  return s.split(' ').filter(function (w) { return w.length >= 2 && !RECHTSVORM.has(w); }).slice(0, 4).join(' ');
}
const RITMES = [['maand', 25, 35, 52], ['kwartaal', 80, 100, 150], ['jaar', 350, 380, 570]];   // naam, gat van–tot (dagen), actief tot
function plusMaanden(d, n) {
  const j = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1 + n, dg = Number(d.slice(8, 10));
  const jj = j + Math.floor(m / 12), mm = ((m % 12) + 12) % 12, max = new Date(Date.UTC(jj, mm + 1, 0)).getUTCDate();
  return jj + '-' + String(mm + 1).padStart(2, '0') + '-' + String(Math.min(dg, max)).padStart(2, '0');
}
function maandEinde(m) { return plusDagen(plusMaanden(m + '-01', 1), -1); }
function modus(l) {
  const tel = new Map();
  l.forEach(function (x, i) { const k = r2(x); const v = tel.get(k) || { n: 0, i: 0 }; v.n++; v.i = i; tel.set(k, v); });
  let best = null;
  tel.forEach(function (v, k) { if (!best || v.n > best.n || (v.n === best.n && v.i > best.i)) best = { k: k, n: v.n, i: v.i }; });
  return best ? best.k : null;
}
// afrondingsruis (219,24 / 219,25; laatste termijn 84,72 na 84,69) is geen prijsstap; 387,32 → 389,04 (0,44%) wel
function zelfdeBedrag(a, b) { return Math.abs(a - b) <= Math.max(0.05, 0.001 * Math.abs(b)); }

// posten: [{nr, rek, datum, bedrag, tegenpartij, omschrijving, categorie, subcategorie}] (al zonder intern, extern en terugboeking).
// o.ref: peildatum (JJJJ-MM-DD); o.start: {rek: eerste datum in het archief} (een reeks die daar begint, is aan de voorkant afgekapt).
function reeksenBereken(posten, o) {
  const ref = o.ref, van = plusDagen(ref, -800), start = o.start || {}, groepen = new Map(), uit = [];
  (posten || []).forEach(function (t) {
    if (!(t.bedrag < 0) || !t.datum || t.datum < van || t.datum > ref) return;
    const m = machtigingVan(t.omschrijving);
    // zonder machtiging een overboeking (ABN: SEPA Overboeking / Periodieke overb.): aan een persoon of eenmalig, geen vaste last
    if (!m && /^\s*SEPA\s+(Periodieke\s+)?overb/i.test(t.omschrijving || '')) return;
    const nn = naamNorm(t.tegenpartij), ow = t.tegenpartij ? '' : woordSleutel(t.omschrijving);
    const k = m ? 'm:' + m : nn ? 'n:' + nn : ow ? 'o:' + ow : null;
    if (!k) return;
    const g = t.rek + '\u0000' + k;
    if (!groepen.has(g)) groepen.set(g, { rek: t.rek, sleutel: k, soort: m ? 'machtiging' : nn ? 'naam' : 'omschrijving', l: [] });
    groepen.get(g).l.push(t);
  });
  groepen.forEach(function (g) {
    const l = g.l.sort(function (x, y) { return x.datum < y.datum ? -1 : x.datum > y.datum ? 1 : x.nr - y.nr; });
    const perMaand = new Map();
    l.forEach(function (t) { perMaand.set(t.datum.slice(0, 7), (perMaand.get(t.datum.slice(0, 7)) || 0) + 1); });
    const info = { rek: g.rek, sleutel: g.sleutel, sleutel_soort: g.soort, ref: ref, start: start[g.rek] || null };
    const pm = Array.from(perMaand.values());
    if (pm.reduce(function (x, y) { return x + y; }, 0) / pm.length >= 1.9) {
      // meerdere diensten achter één sleutel: per bedragcluster (± 2%), oplopend aaneengeregen
      const s = l.slice().sort(function (x, y) { return -x.bedrag - -y.bedrag || (x.datum < y.datum ? -1 : 1); });
      const cl = [];
      s.forEach(function (t) { const c = cl[cl.length - 1]; if (c && -t.bedrag <= c.basis * 1.02 + 0.005) c.l.push(t); else cl.push({ basis: -t.bedrag, l: [t] }); });
      cl.forEach(function (c) {
        const lc = c.l.sort(function (x, y) { return x.datum < y.datum ? -1 : x.datum > y.datum ? 1 : x.nr - y.nr; });
        const r = reeksVan(lc, Object.assign({}, info, { cluster: true, sleutel: g.sleutel + '|c:' + modus(lc.map(function (t) { return -t.bedrag; })).toFixed(2), groep: g.sleutel }));
        if (r) uit.push(r);
      });
    } else {
      const r = reeksVan(l, Object.assign({}, info, { cluster: false, groep: g.sleutel }));
      if (r) uit.push(r);
    }
  });
  return uit;
}

function reeksVan(l, i) {
  if (l.length < 2) return null;
  const machtiging = i.sleutel_soort === 'machtiging';
  const laatsteMet = l.slice().reverse().find(function (t) { return t.categorie; }) || {};
  const categorie = laatsteMet.categorie || null, subcategorie = laatsteMet.subcategorie || null;
  const bedragen = l.map(function (t) { return -t.bedrag; }), md = mediaan(bedragen);
  const binnen20 = bedragen.filter(function (b) { return Math.abs(b - md) <= 0.2 * md; }).length;
  // wisselend alleen bij energie, warmte en water (niet heel 'wonen': een huur- of VvE-stap is een prijsstap; Fable wv764 #8)
  const woonEnergie = /energie|stroom|\bgas\b|warmte|water/i.test(String(subcategorie || ''));
  let wisselend = !i.cluster && woonEnergie && binnen20 < 0.8 * l.length;
  // 1. afwijkende losse posten: wijkt af van de stand ervoor én erna (een blijvende prijsstap dus niet). Aan het eind (geen
  // posten erna) is één afwijkende post dubbelzinnig: nieuwe prijs of losse post. Lijkt hij op de post ervoor, dan is het een
  // nieuwe stand; anders 'voorlopig': telt mee voor actief en laatste, niet voor het bedrag (Fable wv764 #2)
  const afw = new Map();
  if (!wisselend && !i.cluster) {
    l.forEach(function (t, k) {
      const b = -t.bedrag;
      const voor = mediaan(l.slice(Math.max(0, k - 3), k).map(function (x) { return -x.bedrag; })), na = mediaan(l.slice(k + 1, k + 4).map(function (x) { return -x.bedrag; }));
      const soort = function (ref) { return ref == null ? null : b < 0.5 * ref ? 'extra' : b > 1.35 * ref ? 'afrekening' : 'gewoon'; };
      const sv = soort(voor), sn = soort(na);
      let s = sv && sn ? (sv === sn ? sv : 'gewoon') : (sv || sn || 'gewoon');
      // alleen omhoog is dubbelzinnig (Natuurmonumenten 2,75 → 9,25); een veel lagere laatste post is een losse extra (eigen bijdrage)
      if (s !== 'gewoon' && na == null) s = k > 0 && Math.abs(b + l[k - 1].bedrag) <= 0.02 * b ? 'gewoon' : s === 'afrekening' ? 'voorlopig' : 'extra';
      if (s !== 'gewoon') afw.set(t.nr, s);
    });
  }
  // 2. hoofdposten: twee posten dichter bij elkaar dan de helft van het gewone gat zijn er één te veel (eigen bijdrage naast de
  // premie); de post die het dichtst bij de vorige hoofdpost ligt blijft, de ander is extra. Niet per kalendermaand: KPN schuift
  // tussen de 30e en de 5e (07-01 en 07-31). Grens 10–45 dagen, uit het voorlopige gat (Fable wv764 #7)
  let hoofd = l.filter(function (t) { return !afw.has(t.nr); });
  if (!i.cluster) {
    const g0 = [];
    for (let k = 1; k < hoofd.length; k++) g0.push(dagVerschil(hoofd[k - 1].datum, hoofd[k].datum));
    const grens = Math.min(45, Math.max(10, 0.5 * (mediaan(g0.filter(function (g) { return g >= 10; })) || 30)));
    const mdH = mediaan(hoofd.map(function (t) { return -t.bedrag; }));
    const gekozen = [];
    hoofd.forEach(function (t) {
      const p = gekozen[gekozen.length - 1];
      if (!p || dagVerschil(p.datum, t.datum) >= grens) { gekozen.push(t); return; }
      const ref = gekozen.length > 1 ? -gekozen[gekozen.length - 2].bedrag : mdH;
      if (Math.abs(-t.bedrag - ref) < Math.abs(-p.bedrag - ref)) { gekozen[gekozen.length - 1] = t; afw.set(p.nr, 'extra'); }
      else afw.set(t.nr, 'extra');
    });
    hoofd = gekozen;
  }
  if (hoofd.length < 2) return null;
  // 3. ritme (bij een cluster per maand de eerste post: twee diensten met hetzelfde bedrag geven anders een gat van 0). Een
  // afrekening valt meestal op het ritme (PWN: de kwartaalpost van december): in een maand zonder hoofdpost telt hij mee
  const hoofdMnd = new Set(hoofd.map(function (t) { return t.datum.slice(0, 7); }));
  const ritmeL = i.cluster ? hoofd.filter(function (t, k) { return k === 0 || t.datum.slice(0, 7) !== hoofd[k - 1].datum.slice(0, 7); })
    : hoofd.concat(l.filter(function (t) { return afw.get(t.nr) === 'afrekening' && !hoofdMnd.has(t.datum.slice(0, 7)); }))
      .sort(function (x, y) { return x.datum < y.datum ? -1 : x.datum > y.datum ? 1 : x.nr - y.nr; });
  if (ritmeL.length < 2) return null;
  const gaten = [];
  for (let k = 1; k < ritmeL.length; k++) gaten.push(dagVerschil(ritmeL[k - 1].datum, ritmeL[k].datum));
  const mg = mediaan(gaten);
  let r = RITMES.find(function (x) { return mg >= x[1] && mg <= x[2]; });
  if (!r) return null;
  let ritme = r[0];
  // termijnen: belastingen (gemeente, waterschap; ook in het eerste jaar, vóór het eerste gat), of minstens twee reeksen van 3+
  // maandposten met een gat van 75–200 dagen ertussen. Eén pauze maakt van een abonnement nog geen termijnreeks (Fable wv764 #3, #4)
  const runs = [[ritmeL[0]]];
  for (let k = 1; k < ritmeL.length; k++) { if (dagVerschil(ritmeL[k - 1].datum, ritmeL[k].datum) >= 75) runs.push([]); runs[runs.length - 1].push(ritmeL[k]); }
  const lang = gaten.filter(function (g) { return g >= 75 && g <= 200; });
  if (ritme === 'maand' && !i.cluster && (categorie === 'belastingen' || (lang.length && runs.filter(function (u) { return u.length >= 3; }).length >= 2))) ritme = 'termijnen';
  const telGaten = ritme === 'termijnen' ? gaten.filter(function (g) { return g < 75; }) : gaten;
  const regelmatig = telGaten.filter(function (g) { return g >= r[1] * 0.8 && g <= r[2] * 1.2; }).length;
  if (regelmatig < 0.7 * telGaten.length) return null;
  // een bedragcluster (paraplumachtiging PayPal, of een naam) alleen per maand: twee losse aankopen een jaar of kwartaal uit elkaar
  // zijn geen abonnement (Fable wv764 #5). Zonder machtiging strenger: een jaarreeks pas bij 3 posten (toiletbezoek op vakantie,
  // inschrijving voor een loop), een cluster vanaf 4 posten (Albert Heijn)
  const minN = machtiging ? 2 : i.cluster ? 4 : 3;
  if (ritmeL.length < minN || (i.cluster && ritme !== 'maand')) return null;
  // wisselend alleen bij een strak ritme. Zonder machtiging de oude veiligheid: bedrag binnen 20% (anders vallen toevallige
  // herhalingen bij een winkel erin)
  wisselend = wisselend && regelmatig >= 0.8 * telGaten.length;
  if (!machtiging && !wisselend) {
    // zonder machtiging: de hoofdposten binnen 20% van hun mediaan, of grotendeels herhaalde bedragen (prijsstappen: bunq 28,99 →
    // 26,99 → 23,19 bij een naamwissel 'bunq' → 'bunq BV'); losse winkelbedragen herhalen zich niet
    const mdH = mediaan(hoofd.map(function (t) { return -t.bedrag; }));
    const band = hoofd.filter(function (t) { return Math.abs(-t.bedrag - mdH) <= 0.2 * mdH; }).length;
    const herhaald = hoofd.filter(function (t, k) { return (k > 0 && zelfdeBedrag(-t.bedrag, -hoofd[k - 1].bedrag)) || (k < hoofd.length - 1 && zelfdeBedrag(-t.bedrag, -hoofd[k + 1].bedrag)); }).length;
    if (band < 0.8 * hoofd.length && herhaald < 0.7 * hoofd.length) return null;
  }
  // zonder machtiging nooit een reeks bij boodschappen, horeca, contant, vakantie of kleding (de kantine van de hockeyclub elk september)
  if (!machtiging && GEEN_REEKS_CAT.indexOf(categorie) >= 0) return null;

  // 4. bedrag en stand
  const hb = hoofd.map(function (t) { return -t.bedrag; });
  const laatste = hoofd[hoofd.length - 1];
  let wijze = 'vast', bedrag, vorig = null, gewijzigd = null, bmin = null, bmax = null;
  const staart = hb.slice(-4);
  const dalend = !i.cluster && staart.length >= 4 && staart.every(function (b, k) { return k === 0 || (b < staart[k - 1] && (staart[k - 1] - b) / staart[k - 1] < 0.02); });
  if (wisselend) {
    const jaar = hoofd.filter(function (t) { return t.datum > plusDagen(i.ref, -365); }).map(function (t) { return -t.bedrag; });
    const l12 = jaar.length >= 2 ? jaar : hb.slice(-12);
    wijze = 'wisselend'; bedrag = r2(l12.reduce(function (s, b) { return s + b; }, 0) / l12.length);
    bmin = Math.min.apply(null, l12); bmax = Math.max.apply(null, l12);
  } else if (dalend) {
    wijze = 'dalend'; bedrag = r2(hb[hb.length - 1]); vorig = r2(hb[0]);   // vorig = eerste post in het venster (sinds = eerste)
  } else {
    // segmenten van gelijke bedragen (± max(2 ct, 0,5%))
    const seg = [];
    // in een cluster op de cent (0,99 → 1,00 is een andere dienst of een prijsstap; de wisselkoersruis van een dollardienst schommelt dan)
    const gelijk = i.cluster ? function (x, y) { return Math.abs(x - y) < 0.005; } : zelfdeBedrag;
    hoofd.forEach(function (t) { const b = -t.bedrag, s = seg[seg.length - 1]; if (s && gelijk(b, s.basis)) s.l.push(t); else seg.push({ basis: b, l: [t] }); });
    const S = seg[seg.length - 1], P = seg.length > 1 ? seg[seg.length - 2] : null;
    const bedr = function (s) { return modus(s.l.map(function (t) { return -t.bedrag; })); };
    if (S.l.length >= 2 || !P || P.l.length >= 2) {
      bedrag = bedr(S);
      if (P) { vorig = bedr(P); gewijzigd = S.l[0].datum; }
    } else {
      // schommelt na de laatste grote stap (> 10%): gemiddelde sinds die stap
      let k = hb.length - 1;
      while (k > 0 && Math.abs(hb[k] - hb[k - 1]) <= 0.1 * hb[k - 1]) k--;
      const sinds = hb.slice(k);
      bedrag = r2(sinds.reduce(function (s, b) { return s + b; }, 0) / sinds.length);
      wijze = 'schommelt'; bmin = Math.min.apply(null, sinds); bmax = Math.max.apply(null, sinds);
      if (k > 0) { vorig = r2(hb[k - 1]); gewijzigd = hoofd[k].datum; }
    }
  }
  // zonder machtiging alleen een vaste stand (of energie/dalend), niet een bedrag dat blijft schommelen (HEMA elk kwartaal)
  if (!machtiging && wijze === 'schommelt') return null;
  // 5. termijnen: aantal van de laatste volledig geziene termijnreeks (begin en eind gezien), anders 10
  let termijnen = null, tBron = null;
  if (ritme === 'termijnen') {
    const afgekapt = i.start && dagVerschil(i.start, runs[0][0].datum) <= 45;
    const volledig = runs.filter(function (u, k) { return (k > 0 || !afgekapt) && (k < runs.length - 1 || dagVerschil(u[u.length - 1].datum, i.ref) >= 75); });
    const huidig = runs[runs.length - 1].length;
    if (volledig.length) { termijnen = Math.max(volledig[volledig.length - 1].length, huidig); tBron = 'gemeten'; }
    else { termijnen = Math.max(10, huidig); tBron = 'aangenomen'; }
    termijnen = Math.min(termijnen, 12);
  }
  // 6. actief op de laatste post die bij de reeks hoort (hoofd, afrekening of voorlopig); aantal per maand (cluster: posten in de
  // laatste 91 dagen / 3) en per maand
  const bij = l.filter(function (t) { const s = afw.get(t.nr); return !s || s === 'afrekening' || s === 'voorlopig'; });
  const laatsteBij = bij[bij.length - 1] || laatste;
  const voorlopig = l.filter(function (t) { return afw.get(t.nr) === 'voorlopig'; }).pop() || null;
  const actiefTot = ritme === 'termijnen' ? 200 : r[3];
  const actief = dagVerschil(laatsteBij.datum, i.ref) <= actiefTot ? 1 : 0;
  let nPm = 1;
  if (i.cluster && ritme === 'maand') nPm = Math.max(actief, Math.round(hoofd.filter(function (t) { return t.datum > plusDagen(i.ref, -91); }).length / 3));
  const perMaand = r2(ritme === 'maand' ? bedrag * nPm : ritme === 'kwartaal' ? bedrag / 3 : ritme === 'jaar' ? bedrag / 12 : bedrag * termijnen / 12);
  const dagen = ritmeL.slice(-3).map(function (t) { return Number(t.datum.slice(8, 10)); });
  const stap = ritme === 'kwartaal' ? 3 : ritme === 'jaar' ? 12 : 1;
  const nrs = new Map();
  l.forEach(function (t) { nrs.set(t.nr, afw.get(t.nr) || 'hoofd'); });
  return { rek: i.rek, sleutel: i.sleutel, sleutel_soort: i.sleutel_soort + (i.cluster ? '|cluster' : ''), groep: i.groep, naam: laatste.tegenpartij || null,
    categorie: categorie, subcategorie: subcategorie, soort: VAST_CAT.indexOf(categorie) >= 0 ? 'vast' : 'abonnement', wijze: wijze, ritme: ritme,
    bedrag: r2(bedrag), per_maand: perMaand, n_per_maand: nPm, termijnen: termijnen, termijnen_bron: tBron, bedrag_vorig: vorig, gewijzigd_op: gewijzigd,
    bedrag_min: bmin, bedrag_max: bmax, aantal: hoofd.length, eerste: hoofd[0].datum, laatste: laatsteBij.datum, actief: actief,
    verwacht_volgende: actief ? plusMaanden(ritmeL[ritmeL.length - 1].datum, stap) : null, dag: Math.round(mediaan(dagen)),
    laatste_afwijkend: voorlopig ? -voorlopig.bedrag : null, laatste_afwijkend_op: voorlopig ? voorlopig.datum : null,
    extra: Array.from(afw.values()).filter(function (s) { return s === 'extra'; }).length, afrekening: Array.from(afw.values()).filter(function (s) { return s === 'afrekening'; }).length,
    start_afgekapt: !!(i.start && dagVerschil(i.start, hoofd[0].datum) <= 45), nrs: nrs };
}

// Peildag: vandaag, of de nieuwste post als de podklok achterloopt (de klok liep eerder dagen mis; Fable wv764 #12)
function peildag(a) {
  const m = (a.db.prepare("SELECT max(datum) d FROM transacties WHERE status IN ('booked', 'pending')").get() || {}).d;
  return m && m > vandaag() ? m : vandaag();
}
function archiefStart(a) { return new Map(a.db.prepare("SELECT rek, min(datum) d FROM transacties WHERE status IN ('booked', 'pending') GROUP BY rek").all().map(function (r) { return [r.rek, r.d]; })); }
function abonnementenHerken(a, tx, nu) {
  const uit = new Map();
  const start = {};
  archiefStart(a).forEach(function (d, rek) { start[rek] = d; });
  const reeksen = reeksenBereken(tx, { ref: peildag(a), start: start });
  const kol = ['rek', 'tegen_sleutel', 'naam', 'ritme', 'bedrag_typisch', 'aantal', 'eerste', 'laatste', 'actief', 'bijgewerkt'].concat(ABO_KOLOMMEN.map(function (k) { return k[0]; }));
  const zet = a.db.prepare('INSERT INTO abonnementen (' + kol.join(', ') + ') VALUES (' + kol.map(function () { return '?'; }).join(', ') + ')' +
    ' ON CONFLICT (rek, tegen_sleutel) DO UPDATE SET ' + kol.slice(2).map(function (k) { return k + ' = excluded.' + k; }).join(', '));
  const id = a.db.prepare('SELECT id FROM abonnementen WHERE rek = ? AND tegen_sleutel = ?');
  inTransactie(a, function () {
    // rijen van de herkenning van vóór wv764 (of van teruggerolde code): opnieuw opbouwen
    a.db.prepare('DELETE FROM abonnementen WHERE sleutel_soort IS NULL').run();
    reeksen.forEach(function (r) {
      zet.run(r.rek, r.sleutel, r.naam, r.ritme, r.bedrag, r.aantal, r.eerste, r.laatste, r.actief, nu, r.sleutel_soort, r.groep, r.soort, r.wijze, r.per_maand, r.n_per_maand,
        r.termijnen, r.termijnen_bron, r.bedrag_vorig, r.gewijzigd_op, r.verwacht_volgende, r.dag, r.extra, r.afrekening, r.bedrag_min, r.bedrag_max, r.categorie, r.subcategorie,
        r.laatste_afwijkend, r.laatste_afwijkend_op);
      const n = id.get(r.rek, r.sleutel).id;
      // hoofdposten en afrekeningen horen bij de reeks; een losse extra post (eigen bijdrage) niet
      r.nrs.forEach(function (s, nr) { if (s !== 'extra') uit.set(nr, n); });
    });
    // niet meer herkend (ritme of bedrag veranderd): niet meer actief
    a.db.prepare('UPDATE abonnementen SET actief = 0 WHERE bijgewerkt < ?').run(nu);
  });
  return uit;
}

// ── AI (server.js levert het oordeel; hier alleen de groepen en de controle) ─
function aiOpen(a, max) {
  verrijkAlsVuil(a);
  const rijen = a.db.prepare('SELECT t.nr, t.bedrag, t.tegenpartij, t.omschrijving FROM transacties t JOIN verrijking v ON v.nr = t.nr WHERE ' + ZICHTBAAR +
    " AND v.categorie IS NULL AND v.herkomst <> 'david' AND v.type <> 'intern' AND t.rek NOT IN (SELECT rek FROM rekeningen WHERE lower(eigenaar) = 'extern')" +
    // ook geen overboeking van of naar een externe rekening (die deelt de regel per rekening in; Fable wv709 #5)
    " AND (v.intern_paar IS NULL OR (SELECT p.rek FROM transacties p WHERE p.nr = v.intern_paar) NOT IN (SELECT rek FROM rekeningen WHERE lower(eigenaar) = 'extern'))" +
    " AND (t.tegen_iban IS NULL OR t.tegen_iban NOT IN (SELECT iban FROM rekeningen WHERE lower(eigenaar) = 'extern' AND iban IS NOT NULL))").all();
  const ai = new Set(a.db.prepare('SELECT sleutel FROM ai_groepen').all().map(function (g) { return g.sleutel; }));
  // twee keer geen bruikbaar oordeel: niet opnieuw aanbieden (Fable wv687 #5); blijft 'nog niet ingedeeld' tot David of een regel hem indeelt
  // na 90 dagen weer aanbieden (ander model of nieuwe categorie van David; tegenlezing #2)
  const over = new Set(a.db.prepare('SELECT sleutel FROM ai_overslaan WHERE pogingen >= 2 AND laatst >= ?').all(new Date(Date.now() - 90 * 86400000).toISOString()).map(function (g) { return g.sleutel; }));
  const extra = maskerLijst(a);
  const groepen = new Map();
  let overgeslagen = 0;
  rijen.forEach(function (t) {
    const g = groepSleutel(t);
    if (ai.has(g)) return;
    if (over.has(g)) { overgeslagen++; return; }
    if (!groepen.has(g)) groepen.set(g, { g: g, richting: richting(t.bedrag), tegenpartij: maskeer(t.tegenpartij, 80, extra), omschrijving: maskeer(t.omschrijving, 140, extra), bedragen: [], aantal: 0 });
    const x = groepen.get(g); x.aantal++; x.bedragen.push(Math.abs(t.bedrag));
  });
  const lijst = Array.from(groepen.values()).sort(function (x, y) { return y.aantal - x.aantal || (x.g < y.g ? -1 : 1); });
  return { open_groepen: lijst.length, open_posten: rijen.length, posten_overgeslagen: overgeslagen, groepen: lijst.slice(0, Math.min(Math.max(max || 60, 1), 500)).map(function (x) {
    return { g: x.g, richting: x.richting, tegenpartij: x.tegenpartij, omschrijving: x.omschrijving, bedrag_typisch: r2(mediaan(x.bedragen)), aantal: x.aantal };
  }), categorieen: categorieen(a) };
}
// resultaten: [{g, type, categorie, subcategorie, omschrijving}] van het model. Alleen bekende open groepen en categorieën uit de
// lijst; tekst geschoond en kort. Daarna verrijk (past toe, zonder 'david'-rijen te raken).
function aiZet(a, resultaten, model, gestuurd) {
  const open = new Map(aiOpen(a, 500).groepen.map(function (x) { return [x.g, x]; }));
  const gezetSet = new Set();
  const cats = categorieen(a), nu = nuIso();
  let gezet = 0, geweigerd = 0;
  const zet = a.db.prepare('INSERT OR REPLACE INTO ai_groepen (sleutel, type, categorie, subcategorie, ai_omschrijving, model, gemaakt) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const schoonKort = function (s, n) { return typeof s === 'string' ? (s.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\[[^\]]*BANK\s*DATA[^\]]*\]?/giu, '').replace(/\s+/g, ' ').trim().slice(0, n) || null) : null; };
  inTransactie(a, function () {
    (Array.isArray(resultaten) ? resultaten : []).slice(0, 500).forEach(function (r) {
      const x = r && open.get(String(r.g || ''));
      const type = r && TYPES.indexOf(r.type) >= 0 && r.type !== 'intern' ? r.type : null;
      if (!x || !r.categorie || cats.indexOf(r.categorie) < 0 || r.categorie === 'intern') { geweigerd++; return; }
      zet.run(x.g, type || (x.richting === 'af' ? 'uitgave' : 'inkomst'), r.categorie, schoonKort(r.subcategorie, 40), schoonKort(r.omschrijving, 80), String(model || '').slice(0, 40) || null, nu);
      gezet++; gezetSet.add(x.g);
    });
    (Array.isArray(gestuurd) ? gestuurd : []).slice(0, 500).forEach(function (g) {
      g = String(g || '');
      if (!open.has(g) || gezetSet.has(g)) return;
      a.db.prepare('INSERT INTO ai_overslaan (sleutel, pogingen, laatst) VALUES (?, 1, ?) ON CONFLICT (sleutel) DO UPDATE SET pogingen = pogingen + 1, laatst = excluded.laatst').run(g, nu);
    });
    metaZet(a, 'vuil', '1');
  });
  const v = verrijk(a);
  return { gezet: gezet, geweigerd: geweigerd, verrijkt: v.gewijzigd };
}

// ── correctie door David ────────────────────────────────────────────────────
// Per post: herkomst 'david' (wint altijd) + standaard een regel voor dezelfde tegenpartij (of hetzelfde rekeningpaar bij een
// interne overboeking), die daarna ook nieuwe posten zo indeelt. Per rekening: eigenaar (eigenaar_herkomst 'david').
function corrigeer(a, o) {
  const nu = nuIso(), cats = categorieen(a);
  const velden = {};
  if (o.categorie != null) { const c = geldigLabel(o.categorie, 40); if (!c) throw new Error('categorie: 1-40 tekens'); velden.categorie = c; }
  if (o.subcategorie != null) { const c = o.subcategorie === '' ? '' : geldigLabel(o.subcategorie, 40); if (c == null) throw new Error('subcategorie: 1-40 tekens'); velden.subcategorie = c || null; }
  if (o.eigenaar != null) { const e = geldigLabel(o.eigenaar, 30); if (!e) throw new Error('eigenaar: 1-30 tekens (bv. ' + EIGENAREN.join(', ') + ')'); velden.eigenaar = e.toLowerCase() === EXTERN ? EXTERN : e; }
  if (o.type != null) { if (TYPES.indexOf(o.type) < 0) throw new Error('type: ' + TYPES.join(', ')); velden.type = o.type; }
  if (o.rek) {
    // per rekening: de eigenaar, en voor een externe rekening de categorie van de overboekingen ernaartoe (wv709)
    if (velden.type || (!velden.eigenaar && !velden.categorie) || (velden.subcategorie !== undefined && !velden.categorie)) throw new Error('per rekening kan alleen de eigenaar, en bij een externe rekening de categorie (en subcategorie) van de overboekingen ernaartoe');
    // door machinekamer (alleen API_SECRET): een eigenaar die de naam niet verraadt (rekening op naam van een kind); David kan hem altijd overschrijven
    const door = o.door === 'machinekamer' ? 'machinekamer' : 'david';
    if (!a.db.prepare('SELECT 1 FROM rekeningen WHERE rek = ?').get(o.rek)) throw new Error('rekening niet in het archief');
    let regelId = null;
    inTransactie(a, function () {
      if (velden.eigenaar) {
        const r = a.db.prepare("UPDATE rekeningen SET eigenaar = ?, eigenaar_herkomst = ? WHERE rek = ? AND (? = 'david' OR eigenaar_herkomst IS NOT 'david')").run(velden.eigenaar, door, o.rek, door);
        if (!r.changes) throw new Error('eigenaar van deze rekening is door David gezet; die wint');
      }
      if (velden.categorie) {
        if (!externeRekeningen(a).has(o.rek)) throw new Error('categorie per rekening alleen voor een externe rekening (eigenaar extern)');
        if (velden.categorie === 'intern') throw new Error('een externe rekening is nooit intern');
        if (door === 'machinekamer' && a.db.prepare("SELECT 1 FROM regels WHERE soort = 'extern' AND patroon = ? AND richting = 'af' AND herkomst = 'david' AND actief = 1").get(o.rek)) throw new Error('categorie voor deze rekening is door David gezet; die wint');
        a.db.prepare("UPDATE regels SET actief = 0 WHERE soort = 'extern' AND patroon = ? AND richting = 'af' AND actief = 1 AND (herkomst = ? OR ? = 'david')").run(o.rek, door, door);
        regelId = Number(a.db.prepare("INSERT INTO regels (soort, patroon, rek, richting, type, categorie, subcategorie, eigenaar, herkomst, actief, aangemaakt, bron_nr) VALUES ('extern', ?, NULL, 'af', NULL, ?, ?, NULL, ?, 1, ?, NULL)")
          .run(o.rek, velden.categorie, velden.subcategorie || null, door, nu).lastInsertRowid);
      }
      metaZet(a, 'vuil', '1');
    });
    const v = verrijk(a);
    return { ok: true, rekening: true, eigenaar: velden.eigenaar, categorie: velden.categorie, regel: regelId || undefined, door: door, posten_bijgewerkt: v.gewijzigd,
      nieuwe_categorie: velden.categorie && cats.indexOf(velden.categorie) < 0 ? true : undefined };
  }
  const nr = parseInt(o.nr, 10);
  if (!(nr > 0)) throw new Error('nr ontbreekt (het nummer uit zoek)');
  if (!Object.keys(velden).length) throw new Error('niets te corrigeren: categorie, subcategorie, eigenaar of type');
  const t = a.db.prepare('SELECT * FROM transacties WHERE nr = ?').get(nr);
  if (!t) throw new Error('post ' + nr + ' bestaat niet');
  verrijkAlsVuil(a);
  const oud = a.db.prepare('SELECT * FROM verrijking WHERE nr = ?').get(nr) || { versie: 0 };
  const n = { type: oud.type, categorie: oud.categorie, subcategorie: oud.subcategorie, ai_omschrijving: oud.ai_omschrijving, eigenaar: oud.eigenaar };
  Object.assign(n, velden);
  if (velden.categorie && velden.categorie !== oud.categorie && oud.herkomst === 'ai') n.ai_omschrijving = null;
  // welke velden David vastzette (vorige correcties tellen mee); bij een categorie hoort de omschrijving erbij
  const vast = new Set(oud.herkomst === 'david' ? (oud.david_velden ? oud.david_velden.split(',') : OORDEEL) : []);
  Object.keys(velden).forEach(function (k) { vast.add(k); if (k === 'categorie') vast.add('ai_omschrijving'); });
  const davidVelden = OORDEEL.filter(function (k) { return vast.has(k); }).join(',');
  // overboeking tussen een eigen en een externe rekening (wv709): nooit intern; de regel gaat op de externe rekening
  const ibanRek = new Map(a.db.prepare('SELECT rek, iban FROM rekeningen WHERE iban IS NOT NULL').all().map(function (r) { return [r.iban, r.rek]; }));
  const ext = externeRekeningen(a);
  const paarRek = oud.intern_paar ? (a.db.prepare('SELECT rek FROM transacties WHERE nr = ?').get(oud.intern_paar) || {}).rek : null;
  const tegenRek = t.tegen_iban && ibanRek.get(t.tegen_iban) !== t.rek ? ibanRek.get(t.tegen_iban) : null;
  const naarExt = ext.has(t.rek) ? null : [paarRek, tegenRek].find(function (x) { return x && ext.has(x); }) || null;
  if (velden.type === 'intern' && (naarExt || ext.has(t.rek))) throw new Error('een externe rekening is nooit intern');
  let regelId = null;
  inTransactie(a, function () {
    if (oud.nr) a.db.prepare('INSERT INTO verrijking_historie (nr, versie, json, tijd) VALUES (?, ?, ?, ?)').run(nr, oud.versie, JSON.stringify(oud), nu);
    a.db.prepare('INSERT INTO verrijking (nr, type, categorie, subcategorie, ai_omschrijving, eigenaar, intern_paar, abonnement_id, herkomst, regel_id, david_velden, versie, bijgewerkt)' +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'david', NULL, ?, ?, ?) ON CONFLICT (nr) DO UPDATE SET type = excluded.type, categorie = excluded.categorie, subcategorie = excluded.subcategorie," +
      " ai_omschrijving = excluded.ai_omschrijving, eigenaar = excluded.eigenaar, herkomst = 'david', regel_id = NULL, david_velden = excluded.david_velden, versie = excluded.versie, bijgewerkt = excluded.bijgewerkt")
      .run(nr, n.type, n.categorie, n.subcategorie, n.ai_omschrijving, n.eigenaar, oud.intern_paar || null, oud.abonnement_id || null, davidVelden, (oud.versie || 0) + 1, nu);
    if (o.regel !== false) {
      // naar een externe rekening: regel op die rekening, voor elke eigen rekening; een post óp de externe rekening: regel alleen
      // voor die rekening (anders kregen Davids eigen posten bij dezelfde tegenpartij haar categorie en eigenaar; Fable wv709 #2)
      const doel = naarExt || ext.has(t.rek) || (tegenRek && ext.has(tegenRek)) ? null : tegenRek;
      const soort = naarExt ? 'extern' : doel ? 'intern' : 'tegenpartij', patroon = naarExt || doel || woordSleutel(t.tegenpartij);
      if (patroon) {
        const rk = doel || ext.has(t.rek) ? t.rek : null, rt = richting(t.bedrag);
        a.db.prepare("UPDATE regels SET actief = 0 WHERE herkomst = 'david' AND actief = 1 AND soort = ? AND patroon = ? AND rek IS ? AND richting = ?").run(soort, patroon, rk, rt);
        regelId = Number(a.db.prepare("INSERT INTO regels (soort, patroon, rek, richting, type, categorie, subcategorie, eigenaar, herkomst, actief, aangemaakt, bron_nr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'david', 1, ?, ?)")
          .run(soort, patroon, rk, rt, velden.type || null, velden.categorie || null, velden.subcategorie || null, velden.eigenaar || null, nu, nr).lastInsertRowid);
      }
    }
    metaZet(a, 'vuil', '1');
  });
  const v = verrijk(a);
  return { ok: true, nr: nr, herkomst: 'david', vast: davidVelden, regel: regelId, nieuwe_categorie: velden.categorie && cats.indexOf(velden.categorie) < 0 ? true : undefined,
    andere_posten_bijgewerkt: v.gewijzigd };
}

// ── lezen ───────────────────────────────────────────────────────────────────
const UIT_KOLOMMEN = 'SELECT t.nr, t.rek, t.datum, t.bedrag, t.valuta, t.tegenpartij, t.omschrijving, t.status, v.type, v.categorie, v.subcategorie, v.ai_omschrijving,' +
  ' v.eigenaar, v.intern_paar, v.abonnement_id, v.herkomst, (SELECT p.rek FROM transacties p WHERE p.nr = v.intern_paar) AS paar_rek FROM transacties t LEFT JOIN verrijking v ON v.nr = t.nr';
function rekNamen(a) { return new Map(a.db.prepare('SELECT * FROM rekeningen').all().map(function (r) { return [r.rek, r]; })); }
function postUit(t, reks, n) {
  const r = reks.get(t.rek), isExt = function (x) { return !!x && String(x.eigenaar || '').toLowerCase() === EXTERN; };
  const ext = isExt(r) || isExt(reks.get(t.paar_rek));   // overboeking van of naar een externe rekening (wv709)
  return { nr: t.nr, datum: t.datum, rekening: rekeningNaam(r), bedrag: t.bedrag, valuta: t.valuta !== 'EUR' ? t.valuta : undefined, tegenpartij: t.tegenpartij,
    omschrijving: t.omschrijving ? String(t.omschrijving).slice(0, n || 140) : null, status: t.status === 'pending' ? 'wachtend' : undefined,
    type: t.type, categorie: t.categorie, subcategorie: t.subcategorie || undefined, ai_omschrijving: t.ai_omschrijving || undefined, eigenaar: t.eigenaar,
    intern_met: t.paar_rek && !ext ? rekeningNaam(reks.get(t.paar_rek)) : undefined, extern_met: t.paar_rek && ext ? rekeningNaam(reks.get(t.paar_rek)) : undefined, abonnement: t.abonnement_id ? true : undefined, herkomst: t.herkomst,
    gezamenlijk: r && r.gezamenlijk ? true : undefined };
}
function filter(o) {
  const w = [ZICHTBAAR], p = [];
  if (o.van) { w.push('t.datum >= ?'); p.push(o.van); }
  if (o.tot) { w.push('t.datum <= ?'); p.push(o.tot); }
  if (o.rek) { w.push('t.rek = ?'); p.push(o.rek); }
  // zonder rekening: de posten op een externe rekening tellen niet mee (wv709); met rekening=… of eigenaar=extern wel
  else if (String(o.eigenaar || '').toLowerCase() !== EXTERN) w.push("t.rek NOT IN (SELECT rek FROM rekeningen WHERE lower(eigenaar) = 'extern')");
  if (o.categorie) { w.push('lower(v.categorie) = lower(?)'); p.push(o.categorie); }
  if (o.eigenaar) { w.push('lower(v.eigenaar) = lower(?)'); p.push(o.eigenaar); }
  if (o.type) { w.push('v.type = ?'); p.push(o.type); }
  return { w: w, p: p };
}
// Uitleg bij een overzicht: is de gevraagde rekening extern, of bleven er externe rekeningen buiten beschouwing?
function letOpExtern(a, o) {
  const ext = externeRekeningen(a);
  if (!ext.size) return undefined;
  if (o.rek) return ext.has(o.rek) ? LET_OP_EXTERN : undefined;
  return String(o.eigenaar || '').toLowerCase() === EXTERN ? LET_OP_EXTERN : 'posten op een externe rekening (eigenaar extern) tellen niet mee; vraag ze op met rekening=…';
}
function zoek(a, o) {
  verrijkAlsVuil(a);
  const f = filter(o), max = Math.min(Math.max(parseInt(o.max, 10) || 100, 1), 1000), tekst = o.tekst ? String(o.tekst).toLowerCase().slice(0, 80) : '';
  let rijen = a.db.prepare(UIT_KOLOMMEN + ' WHERE ' + f.w.join(' AND ') + ' ORDER BY t.datum DESC, t.nr DESC').all(...f.p);
  if (tekst) rijen = rijen.filter(function (t) {
    return [t.tegenpartij, t.omschrijving, t.ai_omschrijving, t.categorie, t.subcategorie].some(function (v) { return v && String(v).toLowerCase().indexOf(tekst) >= 0; }) ||
      String(Math.abs(t.bedrag)).indexOf(tekst) === 0;
  });
  const reks = rekNamen(a);
  const som = function (l, teken) { return r2(l.filter(function (t) { return teken > 0 ? t.bedrag > 0 : t.bedrag < 0; }).reduce(function (x, t) { return x + t.bedrag; }, 0)); };
  const gez = rijen.some(function (t) { const r = reks.get(t.rek); return r && r.gezamenlijk; });
  return { aantal: rijen.length, getoond: Math.min(rijen.length, max), totaal_in: som(rijen, 1), totaal_uit: som(rijen, -1), let_op_gezamenlijk: gez ? LET_OP_GEZAMENLIJK : undefined,
    let_op_extern: letOpExtern(a, o),
    let_op_intern: rijen.some(function (t) { return t.type === 'intern'; }) ? 'interne overboekingen tellen mee in de totalen; filter type=uitgave of type=inkomst om ze weg te laten' : undefined,
    posten: rijen.slice(0, max).map(function (t) { return postUit(t, reks); }) };
}
function maand(a, o) {
  verrijkAlsVuil(a);
  const m = o.maand || vandaag().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) throw new Error('maand: JJJJ-MM');
  const f = filter(Object.assign({}, o, { van: m + '-01', tot: m + '-31' }));
  const rijen = a.db.prepare(UIT_KOLOMMEN + ' WHERE ' + f.w.join(' AND ')).all(...f.p);
  const per = new Map();
  let intIn = 0, intUit = 0, intN = 0, open = 0;
  rijen.forEach(function (t) {
    if (t.type === 'intern') { intN++; if (t.bedrag > 0) intIn += t.bedrag; else intUit += t.bedrag; return; }
    if (!t.categorie) open++;
    const k = (t.categorie || 'nog niet ingedeeld');
    if (!per.has(k)) per.set(k, { categorie: k, aantal: 0, uit: 0, in: 0 });
    const x = per.get(k); x.aantal++; if (t.bedrag < 0) x.uit += t.bedrag; else x.in += t.bedrag;
  });
  const lijst = Array.from(per.values()).map(function (x) { return { categorie: x.categorie, aantal: x.aantal, uit: r2(x.uit), in: r2(x.in) }; })
    .sort(function (x, y) { return x.uit - y.uit || y.in - x.in; });
  const uit = r2(lijst.reduce(function (s, x) { return s + x.uit; }, 0)), inn = r2(lijst.reduce(function (s, x) { return s + x.in; }, 0));
  const reks = rekNamen(a), gez = rijen.some(function (t) { const r = reks.get(t.rek); return r && r.gezamenlijk; });
  return { maand: m, rekening: o.rek ? rekeningNaam(reks.get(o.rek)) : 'alle', eigenaar: o.eigenaar || undefined, posten: rijen.length, totaal_uit: uit, totaal_in: inn,
    let_op_gezamenlijk: gez ? LET_OP_GEZAMENLIJK : undefined, let_op_extern: letOpExtern(a, o),
    per_categorie: lijst, intern: { aantal: intN, in: r2(intIn), uit: r2(intUit), let_op: 'overboekingen tussen eigen rekeningen; niet in de totalen' },
    nog_niet_ingedeeld: open || undefined };
}
function internLijst(a, o) {
  verrijkAlsVuil(a);
  const f = filter(Object.assign({}, o, { type: 'intern' })), max = Math.min(Math.max(parseInt(o.max, 10) || 100, 1), 1000);
  const rijen = a.db.prepare(UIT_KOLOMMEN + ' WHERE ' + f.w.join(' AND ') + ' AND t.bedrag < 0 ORDER BY t.datum DESC, t.nr DESC').all(...f.p);
  const reks = rekNamen(a);
  const ibanRek = new Map(a.db.prepare('SELECT rek, iban FROM rekeningen WHERE iban IS NOT NULL').all().map(function (r) { return [r.iban, r.rek]; }));
  const tegen = new Map(a.db.prepare("SELECT nr, tegen_iban FROM transacties WHERE tegen_iban IS NOT NULL").all().map(function (r) { return [r.nr, r.tegen_iban]; }));
  const zonderPaar = a.db.prepare("SELECT count(*) n FROM verrijking v JOIN transacties t ON t.nr = v.nr WHERE v.type = 'intern' AND v.intern_paar IS NULL AND " + ZICHTBAAR).get().n;
  const gez = rijen.some(function (t) { const r = reks.get(t.rek); return r && r.gezamenlijk; });
  return { aantal: rijen.length, getoond: Math.min(rijen.length, max), zonder_paar: zonderPaar, let_op_gezamenlijk: gez ? LET_OP_GEZAMENLIJK : undefined,
    let_op: 'per overboeking één regel (de afschrijving); de bijschrijving op de andere rekening is het paar',
    overboekingen: rijen.slice(0, max).map(function (t) {
      const naar = t.paar_rek || ibanRek.get(tegen.get(t.nr));
      return { nr: t.nr, datum: t.datum, van: rekeningNaam(reks.get(t.rek)), naar: rekeningNaam(reks.get(naar)) || 'eigen rekening', bedrag: r2(-t.bedrag),
        omschrijving: t.omschrijving ? String(t.omschrijving).slice(0, 80) : null, paar: t.intern_paar || undefined };
    }) };
}
function abonnementen(a, o) {
  verrijkAlsVuil(a);
  const reks = rekNamen(a);
  const l = a.db.prepare("SELECT b.* FROM abonnementen b WHERE (? OR b.actief = 1) AND b.rek NOT IN (SELECT rek FROM rekeningen WHERE lower(eigenaar) = 'extern')" +
    ' ORDER BY b.actief DESC, b.per_maand DESC, b.bedrag_typisch DESC').all(o && o.alle ? 1 : 0);
  const perMaand = function (b) { return b.per_maand != null ? b.per_maand : b.ritme === 'maand' ? b.bedrag_typisch : b.ritme === 'kwartaal' ? b.bedrag_typisch / 3 : b.bedrag_typisch / 12; };
  return { aantal: l.length, per_maand_totaal: r2(l.filter(function (b) { return b.actief; }).reduce(function (s, b) { return s + perMaand(b); }, 0)),
    let_op: 'herkend aan machtiging, tegenpartij, ritme en bedrag (vaste lasten zoals hypotheek en verzekeringen tellen mee; soort vast of abonnement); geen opzegdata.' +
      ' Het overzicht per maand met verschil: vaste-lasten',
    abonnementen: l.map(function (b) { return { id: b.id, naam: b.naam, rekening: rekeningNaam(reks.get(b.rek)), soort: b.soort || undefined, ritme: b.ritme,
      wijze: b.wijze && b.wijze !== 'vast' ? b.wijze : undefined, bedrag: b.bedrag_typisch, aantal_per_maand: b.n_per_maand > 1 ? b.n_per_maand : undefined,
      termijnen: b.termijnen || undefined, termijnen_bron: b.termijnen_bron || undefined, per_maand: r2(perMaand(b)),
      categorie: b.categorie || undefined, subcategorie: b.subcategorie || undefined, sinds: b.eerste, laatst: b.laatste, aantal: b.aantal,
      bedrag_vorig: b.bedrag_vorig == null ? undefined : b.bedrag_vorig, gewijzigd_op: b.gewijzigd_op || undefined, verwacht_volgende: b.verwacht_volgende || undefined,
      extra_posten: b.extra || undefined, afrekeningen: b.afrekening || undefined, actief: !!b.actief }; }) };
}

// ── vaste lasten per maand en geldstroom (wv764, ontwerp § 3 en § 5) ──────
// vaste-lasten rekent de reeksen opnieuw uit op de peildatum (einde van de maand, of vandaag) en op het einde van de maand ervoor,
// en geeft de tabel ook als markdown (tabel_md): die mag, en alleen die, in het blok tussen de markeringen op de vault-pagina
// Huishoudbudget en vaste lasten (smalle uitzondering, Ja van David 22-10-2026). Daarom alleen namen van organisaties, bedragen,
// ritme en maanden; nooit IBAN, machtiging, omschrijving of saldo. Tekst van derden (tegenpartij) gaat door mdVeilig.
const MAANDEN = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
function eur(n) { const v = Math.abs(r2(n)).toFixed(2).split('.'); return (n < -0.004 ? '− ' : '') + '€ ' + v[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + v[1]; }
function getal(n) { const v = Math.abs(r2(n)).toFixed(2).split('.'); return v[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + v[1]; }
function mndJaar(d) { return d ? MAANDEN[Number(d.slice(5, 7)) - 1] + ' ' + d.slice(0, 4) : '—'; }
function dmj(d) { return Number(d.slice(8, 10)) + '-' + Number(d.slice(5, 7)) + '-' + d.slice(0, 4); }
function mdVeilig(s, n) { return String(s || '').normalize('NFC').replace(/[^\p{L}\p{N} .,&'()\-/+]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 40).trim(); }
function hoofdletter(s) { s = mdVeilig(s, 40); return s ? s[0].toUpperCase() + s.slice(1) : s; }
function vasteLastenRekening(a, rek) {
  const reks = rekNamen(a);
  if (rek) {
    if (!reks.has(rek)) throw new Error('rekening: niet in het archief');
    if (externeRekeningen(a).has(rek)) throw new Error('rekening: een externe rekening (eigenaar extern) heeft geen vaste lasten van David');
    return rek;
  }
  const l = Array.from(reks.values()).filter(function (r) { return r.bron !== 'bunq' && String(r.eigenaar || '').toLowerCase() !== EXTERN; });
  if (l.length !== 1) throw new Error('rekening: noem de rekening (bijvoorbeeld rekening="Vaste lasten")');
  return l[0].rek;
}
// Posten van één rekening, gesplitst: lasten (kandidaat voor een reeks), naar een externe rekening (steun) en interne bijschrijvingen.
function vastePosten(a, rek) {
  const ext = externeRekeningen(a);
  const iban = new Map(a.db.prepare('SELECT rek, iban FROM rekeningen WHERE iban IS NOT NULL').all().map(function (r) { return [r.iban, r.rek]; }));
  const rijen = a.db.prepare('SELECT t.nr, t.rek, t.datum, t.bedrag, t.tegenpartij, t.tegen_iban, t.omschrijving, t.saldo_na, v.type, v.categorie, v.subcategorie,' +
    ' (SELECT p.rek FROM transacties p WHERE p.nr = v.intern_paar) AS paar_rek FROM transacties t LEFT JOIN verrijking v ON v.nr = t.nr WHERE ' + ZICHTBAAR +
    ' AND t.rek = ? ORDER BY t.datum, t.nr').all(rek);
  const uit = { lasten: [], steun: [], intern_in: [], intern_uit: [], alle: rijen };
  rijen.forEach(function (t) {
    const tegen = t.paar_rek || (t.tegen_iban && iban.get(t.tegen_iban) !== t.rek ? iban.get(t.tegen_iban) : null);
    t.tegen_rek = tegen || null;
    if (tegen && ext.has(tegen)) { if (t.bedrag < 0) uit.steun.push(t); return; }
    if (tegen || t.type === 'intern') { (t.bedrag > 0 ? uit.intern_in : uit.intern_uit).push(t); return; }
    if (t.type === 'terugboeking') return;
    uit.lasten.push(t);
  });
  return uit;
}
// Terugkerende bedragen (± tol) in de laatste 183 dagen tot ref, in minstens 3 verschillende maanden: de vaste stroom.
function vasteBedragen(lijst, ref, tol) {
  const van = plusDagen(ref, -183), cl = [];
  lijst.filter(function (t) { return t.datum > van && t.datum <= ref; }).sort(function (x, y) { return Math.abs(x.bedrag) - Math.abs(y.bedrag); }).forEach(function (t) {
    const b = Math.abs(t.bedrag), c = cl[cl.length - 1];
    if (c && b <= c.basis * (1 + tol) + 0.005) c.l.push(t); else cl.push({ basis: b, l: [t] });
  });
  return cl.filter(function (c) { return new Set(c.l.map(function (t) { return t.datum.slice(0, 7); })).size >= 3; }).map(function (c) {
    const l = c.l.sort(function (x, y) { return x.datum < y.datum ? -1 : 1; });
    return { bedrag: modus(l.map(function (t) { return Math.abs(t.bedrag); })), dag: Math.round(mediaan(l.slice(-3).map(function (t) { return Number(t.datum.slice(8, 10)); }))),
      laatste: l[l.length - 1].datum, l: l };
  });
}
function rijenVan(reeksen) {
  const per = new Map();
  reeksen.forEach(function (r) {
    const k = (r.sleutel_soort.indexOf('cluster') >= 0 ? 'g:' + r.groep : 'n:' + (naamNorm(r.naam) || r.sleutel)) + '|' + r.ritme;
    if (!per.has(k)) per.set(k, []);
    per.get(k).push(r);
  });
  return Array.from(per.entries()).map(function (e) {
    const l = e[1].sort(function (x, y) { return y.per_maand - x.per_maand || y.bedrag - x.bedrag; }), r0 = l[0], cluster = e[0].indexOf('g:') === 0;
    const nieuwste = l.slice().sort(function (x, y) { return x.laatste < y.laatste ? 1 : -1; })[0];
    const sub = l.map(function (r) { return r.subcategorie; }).find(Boolean), cat = l.map(function (r) { return r.categorie; }).find(Boolean);
    const naam = mdVeilig(nieuwste.naam, 30), soortNaam = hoofdletter(sub || cat || '');
    const ritmes = Array.from(new Set(l.map(function (r) { return r.ritme; })));
    const wijziging = l.filter(function (r) { return r.gewijzigd_op; }).sort(function (x, y) { return x.gewijzigd_op < y.gewijzigd_op ? 1 : -1; })[0];
    const rij = { sleutel: e[0], sleutels: l.map(function (r) { return r.sleutel; }), naam: naam || null, soort_post: soortNaam || null, categorie: cat || null, soort: r0.soort, ritme: ritmes.length === 1 ? ritmes[0] : 'gemengd',
      reeksen: l.length, bedrag: r2(l.reduce(function (s, r) { return s + (r.ritme === 'maand' ? r.bedrag * r.n_per_maand : r.bedrag); }, 0)),
      per_maand: r2(l.reduce(function (s, r) { return s + r.per_maand; }, 0)), wijze: l.length === 1 ? r0.wijze : undefined,
      bedrag_min: l.length === 1 ? r0.bedrag_min : undefined, bedrag_max: l.length === 1 ? r0.bedrag_max : undefined,
      bedrag_vorig: l.length === 1 ? r0.bedrag_vorig : undefined, gewijzigd_op: wijziging ? wijziging.gewijzigd_op : null,
      laatste_afwijkend: l.length === 1 && r0.laatste_afwijkend != null ? r0.laatste_afwijkend : undefined, laatste_afwijkend_op: l.length === 1 ? r0.laatste_afwijkend_op || undefined : undefined,
      eerste: l.map(function (r) { return r.eerste; }).sort()[0], laatste_start: l.filter(function (r) { return !r.start_afgekapt; }).map(function (r) { return r.eerste; }).sort().pop() || null,
      start_afgekapt: l.every(function (r) { return r.start_afgekapt; }),
      termijnen: l.length === 1 ? r0.termijnen : undefined, termijnen_bron: l.length === 1 ? r0.termijnen_bron : undefined,
      onderdelen: l.length > 1 ? l.map(function (r) { return { bedrag: r.bedrag, aantal: r.n_per_maand > 1 ? r.n_per_maand : undefined, dag: r.dag, ritme: r.ritme !== 'maand' ? r.ritme : undefined }; }) : undefined,
      cluster: cluster || undefined };
    return rij;
  }).sort(function (x, y) { return y.per_maand - x.per_maand; });
}
function rijTekst(r) {
  let t = r.soort_post && r.naam ? r.soort_post + ' (' + r.naam + ')' : (r.soort_post || r.naam || 'Zonder naam');
  if (r.wijze === 'dalend') t += ' — daalt elke maand';
  else if (r.wijze === 'wisselend') t += ' — wisselend, ' + getal(r.bedrag_min) + '–' + getal(r.bedrag_max) + ' (12 maanden)';
  else if (r.wijze === 'schommelt') t += ' — schommelt ' + getal(r.bedrag_min) + '–' + getal(r.bedrag_max);
  if (r.laatste_afwijkend != null) t += ' — laatste post ' + getal(r.laatste_afwijkend) + ' (' + dmj(r.laatste_afwijkend_op) + ') wijkt af; nog niet meegeteld';
  if (r.onderdelen) {
    const ond = r.onderdelen.map(function (o) { return getal(o.bedrag) + (o.aantal ? ' ×' + o.aantal : '') + (r.cluster && o.dag ? ' (' + o.dag + 'e)' : '') + (o.ritme ? ' per ' + o.ritme : ''); });
    t += ' — ' + (r.cluster ? r.onderdelen.reduce(function (s, o) { return s + (o.aantal || 1); }, 0) + ' vaste betalingen: ' + ond.join(' · ') : r.reeksen + ' reeksen: ' + ond.join(' + '));
  }
  return t;
}
function ritmeTekst(r) {
  if (r.ritme === 'termijnen') return (r.termijnen || '?') + ' termijnen' + (r.termijnen_bron === 'aangenomen' ? ' (aantal aangenomen)' : '');
  return r.ritme;
}
function sindsTekst(r, start) {
  if (r.wijze === 'dalend') return 'daalt sinds ' + mndJaar(r.eerste) + ' (toen ' + eur(r.bedrag_vorig) + ')';
  if (r.cluster && r.reeksen > 1) return 'laatste wijziging ' + mndJaar([r.gewijzigd_op || '', r.laatste_start || ''].sort().pop());
  if (r.gewijzigd_op) return mndJaar(r.gewijzigd_op) + (r.bedrag_vorig != null ? ' (was ' + eur(r.bedrag_vorig) + ')' : r.reeksen > 1 ? ' (bedragen schuiven)' : '');
  return r.start_afgekapt ? 'vóór ' + mndJaar(plusMaanden(start, 1)) : mndJaar(r.eerste);
}
function vasteLasten(a, o) {
  verrijkAlsVuil(a);
  const nu = peildag(a), m = o.maand || nu.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new Error('maand: JJJJ-MM');
  if (m > nu.slice(0, 7)) throw new Error('maand: die maand is nog niet begonnen');
  const rek = vasteLastenRekening(a, o.rek), reks = rekNamen(a), r = reks.get(rek);
  // alleen de tabel van de vaste-lastenrekening (de enige niet-bunq-rekening) mag de vault in: op bunq zijn reeksen naam-gebaseerd en
  // kan een vaste overboeking aan een persoon ertussen staan (Fable wv764 #6); bank.py schrijft alleen bij standaard_rekening
  let standaard = false;
  try { standaard = vasteLastenRekening(a, null) === rek; } catch (e) { standaard = false; }
  const eind = maandEinde(m), ref = eind < nu ? eind : nu, vorigeRef = plusDagen(m + '-01', -1);
  const start = archiefStart(a).get(rek) || null, st = {};
  st[rek] = start;
  const p = vastePosten(a, rek);
  const reeksNu = reeksenBereken(p.lasten, { ref: ref, start: st }).filter(function (x) { return x.actief; });
  const reeksVor = reeksenBereken(p.lasten, { ref: vorigeRef, start: st }).filter(function (x) { return x.actief; });
  const rijen = rijenVan(reeksNu), vorigL = rijenVan(reeksVor), vorig = new Map();
  // een rij uit de vorige stand hoort bij een rij nu als ze een reeks delen (naamwissel bij dezelfde machtiging: gemeente aug 2026)
  rijen.forEach(function (x) { const v = vorigL.find(function (y) { return y.sleutels.some(function (k) { return x.sleutels.indexOf(k) >= 0; }); }); if (v) vorig.set(x.sleutel, v); });
  const totaal = r2(rijen.reduce(function (s, x) { return s + x.per_maand; }, 0));
  const hyp = r2(rijen.filter(function (x) { return /hypothe/i.test(String(x.soort_post || '')); }).reduce(function (s, x) { return s + x.per_maand; }, 0));
  // steun: vaste overboekingen naar een externe rekening (Elizabeth); vaste storting: vaste interne bijschrijving (± 0,5%)
  const steunPer = new Map();
  p.steun.forEach(function (t) { if (!steunPer.has(t.tegen_rek)) steunPer.set(t.tegen_rek, []); steunPer.get(t.tegen_rek).push(t); });
  const steun = [];
  steunPer.forEach(function (l, tr) {
    const v = vasteBedragen(l, ref, 0.02);
    if (!v.length) return;
    const sub = l.slice().reverse().map(function (t) { return t.subcategorie; }).find(Boolean);
    steun.push({ naam: sub ? hoofdletter(sub) : 'Naar ' + mdVeilig(rekeningNaam(reks.get(tr)), 30), per_maand: r2(v.reduce(function (s, x) { return s + x.bedrag; }, 0)), dag: v[0].dag });
  });
  const stortPer = new Map();
  p.intern_in.forEach(function (t) { const k = t.tegen_rek || '?'; if (!stortPer.has(k)) stortPer.set(k, []); stortPer.get(k).push(t); });
  const storting = [];
  stortPer.forEach(function (l, tr) {
    vasteBedragen(l, ref, 0.005).forEach(function (v) {
      if (v.laatste < plusDagen(ref, -45)) return;   // gestopt
      storting.push({ van: mdVeilig(rekeningNaam(reks.get(tr)) || 'eigen rekening', 30), bedrag: v.bedrag, dag: v.dag });
    });
  });
  const steunTot = r2(steun.reduce(function (s, x) { return s + x.per_maand; }, 0)), stortTot = r2(storting.reduce(function (s, x) { return s + x.bedrag; }, 0));
  // verschil met de vorige stand (einde vorige maand); wisselende reeksen pas bij meer dan 5%
  const verschil = [];
  rijen.forEach(function (x) {
    const v = vorig.get(x.sleutel);
    if (!v) { verschil.push({ wat: 'nieuw', post: rijTekst(x).split(' — ')[0], per_maand: x.per_maand }); return; }
    const d = r2(x.per_maand - v.per_maand);
    // dalend (hypotheek) verandert elke maand; wisselend en schommelend pas boven 5%
    if (Math.abs(d) >= 0.5 && x.wijze !== 'dalend' && ((x.wijze !== 'wisselend' && x.wijze !== 'schommelt') || Math.abs(d) > 0.05 * v.per_maand)) verschil.push({ wat: 'anders', post: rijTekst(x).split(' — ')[0], van: v.per_maand, naar: x.per_maand });
    x.verschil = d || undefined;
  });
  const gebruikt = new Set(Array.from(vorig.values()));
  vorigL.forEach(function (v) { if (!gebruikt.has(v)) verschil.push({ wat: 'weg', post: rijTekst(v).split(' — ')[0], per_maand: v.per_maand }); });
  const uit = { maand: m, peildatum: ref, vorige_stand: vorigeRef, rekening: rekeningNaam(r), standaard_rekening: standaard, vanaf: start, posten: rijen.length,
    reeksen: reeksNu.length, totaal_per_maand: totaal, waarvan_hypotheek: hyp || undefined, steun: steun, vaste_storting: storting,
    over: storting.length ? r2(stortTot - totaal - steunTot) : undefined, verschil: verschil,
    let_op_gezamenlijk: r && r.gezamenlijk ? LET_OP_GEZAMENLIJK : undefined,
    let_op: 'tabel_md mag alleen in het blok tussen de markeringen op de vault-pagina Huishoudbudget en vaste lasten (Ja van David 22-10-2026); de rest is gesprek',
    vaste_lasten: rijen.map(function (x) { const y = Object.assign({}, x); delete y.sleutel; delete y.sleutels; delete y.cluster; delete y.start_afgekapt; delete y.laatste_start; return y; }) };
  uit.tabel_md = vasteLastenMd(uit, rijen, r, start);
  return uit;
}
function vasteLastenMd(u, rijen, r, start) {
  const rij = function (x) { return '| ' + rijTekst(x) + ' | ' + eur(x.bedrag) + ' | ' + ritmeTekst(x) + ' | ' + sindsTekst(x, start) + ' | ' + eur(x.per_maand) + ' |'; };
  const kop = '| Post (tegenpartij op het afschrift) | Bedrag | Ritme | Sinds | Per maand |\n|---|--:|---|---|--:|';
  const mnd = rijen.filter(function (x) { return x.ritme === 'maand'; }), ander = rijen.filter(function (x) { return x.ritme !== 'maand'; });
  const regels = ['*Stand ' + dmj(u.peildatum) + ', automatisch berekend door Socev uit de transactiedatabase van de bankkoppeling (rekening "' + mdVeilig(u.rekening, 30) + '", afschrijvingen vanaf ' +
    (start ? dmj(start) : '—') + '). Alleen terugkerende posten aan organisaties; geen rekeningnummers, saldi of losse uitgaven. "Sinds" = sinds wanneer dít bedrag geldt; "vóór ' +
    (start ? mndJaar(plusMaanden(start, 1)) : '—') + '" = al zo bij het begin van de meetreeks.*', ''];
  if (mnd.length) regels.push('**Maandelijks**', '', kop, mnd.map(rij).join('\n'), '');
  if (ander.length) regels.push('**In termijnen, per kwartaal of per jaar** (per maand = jaarbedrag / 12)', '', kop, ander.map(rij).join('\n'), '');
  regels.push('| | Per maand |', '|---|--:|', '| **Totaal vaste lasten** | **' + eur(u.totaal_per_maand) + '** |');
  if (u.waarvan_hypotheek) regels.push('| waarvan zonder hypotheek | ' + eur(u.totaal_per_maand - u.waarvan_hypotheek) + ' |');
  u.steun.forEach(function (s) { regels.push('| ' + s.naam + ' (rond de ' + s.dag + 'e) | ' + eur(s.per_maand) + ' |'); });
  u.vaste_storting.forEach(function (s) { regels.push('| **Vaste storting** vanaf ' + s.van + ', rond de ' + s.dag + 'e | **' + eur(s.bedrag) + '** |'); });
  if (u.over != null) regels.push('| **Over na vaste lasten' + (u.steun.length ? ' en steun' : '') + '** | **' + eur(u.over) + '** |');
  regels.push('');
  const vs = u.verschil.map(function (v) {
    return v.wat === 'nieuw' ? '- nieuw: ' + v.post + ' (' + eur(v.per_maand) + ' per maand)' : v.wat === 'weg' ? '- niet meer gezien: ' + v.post + ' (was ' + eur(v.per_maand) + ' per maand)'
      : '- ' + v.post + ': ' + eur(v.van) + ' → ' + eur(v.naar) + ' per maand';
  });
  regels.push('**Verschil met de stand van ' + dmj(u.vorige_stand) + ':** ' + (vs.length ? '' : 'geen.'));
  if (vs.length) regels.push('', vs.join('\n'));
  return regels.join('\n').replace(/<!--|-->/g, '');
}

// Geldstroom per maand (ontwerp § 5): per rekeningpaar (van → naar) aantal en som van de overboekingen, vast (zelfde paar en
// bedrag in minstens 3 verschillende maanden van het laatste half jaar) of los; en voor de vaste-lastenrekening de buffer (vaste storting − alle uitgaven,
// rollend over 3 maanden) en de dekking voor wat tot de 5e van de volgende maand nog afgaat. Saldo: alleen gesprek, nooit de vault.
function stroom(a, o) {
  verrijkAlsVuil(a);
  const nu = peildag(a), m = o.maand || nu.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new Error('maand: JJJJ-MM');
  if (m > nu.slice(0, 7)) throw new Error('maand: die maand is nog niet begonnen');
  const reks = rekNamen(a), ext = externeRekeningen(a);
  const eind = maandEinde(m), ref = eind < nu ? eind : nu, van4 = plusDagen(ref, -183);
  const iban = new Map(a.db.prepare('SELECT rek, iban FROM rekeningen WHERE iban IS NOT NULL').all().map(function (r) { return [r.iban, r.rek]; }));
  const rijen = a.db.prepare('SELECT t.nr, t.rek, t.datum, t.bedrag, t.tegen_iban, v.type, (SELECT p.rek FROM transacties p WHERE p.nr = v.intern_paar) AS paar_rek' +
    ' FROM transacties t LEFT JOIN verrijking v ON v.nr = t.nr WHERE ' + ZICHTBAAR + ' AND t.bedrag < 0 AND t.datum >= ? AND t.datum <= ?').all(van4, ref);
  const paren = new Map();
  rijen.forEach(function (t) {
    if (ext.has(t.rek)) return;   // posten op de externe rekening zelf zijn niet van David
    const naar = t.paar_rek || (t.tegen_iban && iban.get(t.tegen_iban) !== t.rek ? iban.get(t.tegen_iban) : null);
    if (!naar || (t.type !== 'intern' && !ext.has(naar))) return;
    const k = t.rek + '>' + naar;
    if (!paren.has(k)) paren.set(k, { van: t.rek, naar: naar, l: [] });
    paren.get(k).l.push(t);
  });
  const uit = [];
  paren.forEach(function (p) {
    const inM = p.l.filter(function (t) { return t.datum.slice(0, 7) === m; });
    if (!inM.length) return;
    const vast = vasteBedragen(p.l, ref, 0.005).filter(function (v) { return v.l.some(function (t) { return t.datum.slice(0, 7) === m; }); });
    const vastNr = new Set();
    vast.forEach(function (v) { v.l.forEach(function (t) { if (t.datum.slice(0, 7) === m) vastNr.add(t.nr); }); });
    const los = inM.filter(function (t) { return !vastNr.has(t.nr); });
    uit.push({ van: rekeningNaam(reks.get(p.van)), naar: rekeningNaam(reks.get(p.naar)), extern: ext.has(p.naar) || undefined, aantal: inM.length,
      som: r2(-inM.reduce(function (s, t) { return s + t.bedrag; }, 0)), vast: vast.map(function (v) { return { bedrag: v.bedrag, dag: v.dag }; }),
      los: los.length ? { aantal: los.length, som: r2(-los.reduce(function (s, t) { return s + t.bedrag; }, 0)) } : undefined });
  });
  uit.sort(function (x, y) { return y.som - x.som; });
  // buffer en dekking van de vaste-lastenrekening (als die er is)
  let buffer;
  try {
    const rek = vasteLastenRekening(a, o.rek);
    const p = vastePosten(a, rek), r = reks.get(rek);
    const maanden = [plusMaanden(m + '-01', -2).slice(0, 7), plusMaanden(m + '-01', -1).slice(0, 7), m];
    const perM = maanden.map(function (mm) {
      const inn = r2(p.intern_in.filter(function (t) { return t.datum.slice(0, 7) === mm; }).reduce(function (s, t) { return s + t.bedrag; }, 0));
      const af = r2(-p.lasten.concat(p.steun).filter(function (t) { return t.datum.slice(0, 7) === mm && t.bedrag < 0; }).reduce(function (s, t) { return s + t.bedrag; }, 0));
      return { maand: mm, stortingen: inn, uitgaven: af, verschil: r2(inn - af) };
    });
    const st = {}; st[rek] = archiefStart(a).get(rek) || null;
    const tot = plusDagen(eind, 5);
    const nog = reeksenBereken(p.lasten, { ref: ref, start: st }).filter(function (x) { return x.actief && x.verwacht_volgende && x.verwacht_volgende > ref && x.verwacht_volgende <= tot; });
    const saldoRij = p.alle.filter(function (t) { return t.datum <= ref && t.saldo_na != null; }).pop();
    const nogAf = r2(nog.reduce(function (s, x) { return s + (x.ritme === 'maand' ? x.bedrag * x.n_per_maand : x.bedrag); }, 0));
    buffer = { rekening: rekeningNaam(r), per_maand: perM, rollend_3_maanden: r2(perM.reduce(function (s, x) { return s + x.verschil; }, 0)),
      dekking: saldoRij ? { saldo_op: saldoRij.datum, saldo: saldoRij.saldo_na, nog_af_tot: tot, vaste_lasten_nog_af: nogAf, genoeg: saldoRij.saldo_na - nogAf >= 0 } : undefined,
      let_op: 'saldo alleen voor David in het gesprek; nooit in de vault' };
  } catch (e) { if (!/^rekening:/.test(e.message)) throw e; }
  return { maand: m, peildatum: ref, overboekingen: uit, buffer: buffer,
    let_op: 'per rekeningpaar één regel (de afschrijvingen); vast = zelfde paar en bedrag in minstens 3 verschillende maanden van het laatste half jaar; naar een externe rekening is een uitgave, geen intern' };
}
// Alleen aantallen, data en herkomst; geen bedragen, namen of IBAN's (mag in een rapport).
function stand(a) {
  const db = a.db;
  const per = db.prepare('SELECT r.rek, r.bron, r.status, r.eigenaar, r.eigenaar_herkomst, count(t.nr) n, min(t.datum) van, max(t.datum) tot, sum(t.ruwe_json IS NOT NULL) ruw' +
    ' FROM rekeningen r LEFT JOIN transacties t ON t.rek = r.rek GROUP BY r.rek ORDER BY n DESC').all();
  const tel = function (q) { return db.prepare(q).all().reduce(function (o, r) { o[r.k == null ? 'leeg' : r.k] = r.n; return o; }, {}); };
  return {
    bestand: path.basename(a.pad), schema: Number(metaLees(a, 'schema')),
    transacties: db.prepare('SELECT count(*) n FROM transacties').get().n,
    rekeningen_met_posten: per.filter(function (r) { return r.n > 0; }).length, rekeningen: per.length,
    vanaf: (db.prepare('SELECT min(datum) m FROM transacties').get() || {}).m || null, tot: (db.prepare('SELECT max(datum) m FROM transacties').get() || {}).m || null,
    per_status: tel('SELECT status k, count(*) n FROM transacties GROUP BY status'),
    per_bron: tel('SELECT r.bron k, count(*) n FROM transacties t JOIN rekeningen r ON r.rek = t.rek GROUP BY r.bron'),
    met_ruwe_json: db.prepare('SELECT count(*) n FROM transacties WHERE ruwe_json IS NOT NULL').get().n,
    herkomst_rij: tel('SELECT herkomst_rij k, count(*) n FROM transacties GROUP BY herkomst_rij'),
    verrijking: {
      per_herkomst: tel('SELECT herkomst k, count(*) n FROM verrijking GROUP BY herkomst'),
      per_type: tel('SELECT type k, count(*) n FROM verrijking GROUP BY type'),
      met_categorie: db.prepare('SELECT count(*) n FROM verrijking WHERE categorie IS NOT NULL').get().n,
      intern_met_paar: db.prepare("SELECT count(*) n FROM verrijking WHERE type = 'intern' AND intern_paar IS NOT NULL").get().n,
      regels_david: db.prepare("SELECT count(*) n FROM regels WHERE herkomst = 'david' AND actief = 1").get().n,
      ai_groepen: db.prepare('SELECT count(*) n FROM ai_groepen').get().n,
      abonnementen_actief: db.prepare('SELECT count(*) n FROM abonnementen WHERE actief = 1').get().n,
      verrijkt_op: metaLees(a, 'verrijkt_op'), vuil: metaLees(a, 'vuil') !== '0',
    },
    // Vrije labels van David (een eigenaar of categorie buiten de vaste lijst) alleen als 'anders' of geteld (Fable wv687 #8)
    per_rekening: per.map(function (r) { return { rek_kort: String(r.rek).slice(0, 8), bron: r.bron, status: r.status, eigenaar: EIGENAREN.indexOf(r.eigenaar) >= 0 ? r.eigenaar : 'anders', eigenaar_door: r.eigenaar_herkomst,
      posten: r.n, van: r.van, tot: r.tot, met_ruwe_json: r.ruw || 0 }; }),
    categorieen: CAT_UIT.concat(CAT_IN, CAT_OVER), eigen_categorieen: categorieen(a).length - CAT_UIT.length - CAT_IN.length - CAT_OVER.length, eigenaren: EIGENAREN,
    masker_namen: (function () { try { return JSON.parse(metaLees(a, 'masker_namen') || '[]').length; } catch (e) { return 0; } })(),
    ai_overgeslagen_groepen: db.prepare('SELECT count(*) n FROM ai_overslaan WHERE pogingen >= 2').get().n,
  };
}

module.exports = { open, rekeningenSync, markeerOntkoppeld, bij, migreerCache, verrijk, verrijkAlsVuil, aiOpen, aiZet, corrigeer, zoek, maand, internLijst, abonnementen, vasteLasten, stroom, stand, maskerZet,
  categorieen, externeRekeningen, woordSleutel, groepSleutel, maskeer, reeksenBereken, vastePosten, archiefStart, machtigingVan, naamNorm, CAT_UIT, CAT_IN, CAT_OVER, TYPES, EIGENAREN, EXTERN, LET_OP_EXTERN, SCHEMA_VERSIE };
