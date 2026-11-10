'use strict';
// ── OVIS GHAWA fase 2: bijhouden (wv2880, 10-11-2026; plan vault "01_Ontwikkeling/OVIS GHAWA - plan naar een 8 (Fable 5.2, 10-11-2026)" § 4, § 8) ──
// David 10-11-2026: "één systeem waarin we alles van Gambia bijhouden … Richt op een 8!"; fase 2 = de cijfers blijven bij met hooguit tien
// minuten werk per maand. Dit bestand schrijft in ghawa.sqlite; ghawa.js leest en rekent. Vaste regels, geen taalmodel.
//
// 1. GHAWA-bank (bankBij): de Triodos-regels van GHAWA uit de bankdatabank van Facturen (facturen.sqlite, alleen lezen: de bankkoppeling én
//    Davids Triodos-uploads, ook de spaarrekening). De keten moet sluiten, anders wordt er NIETS overgenomen en komt er een signaal:
//    a. overlap: in de periode die zowel de overdracht als Facturen heeft, zijn de regels (datum, bedrag) precies gelijk;
//    b. wat al eerder uit Facturen kwam, staat er nog (geen verdwenen regels);
//    c. elk eindsaldo van een gecontroleerde Triodos-upload in Facturen = de som van al onze regels van die rekening t/m die dag.
//    Indeling in de soorten van de overdracht: eigen rekening, code KN/RE/PR, wat dezelfde tegenrekening eerder was (David wint), een
//    kleine bijschrijving = gift; de rest is "Nog in te delen" en vraagt één tik van David (indelen).
// 2. ECG-afschriften (ecgAfschrift): Ecobank-csv of -pdf (pdftotext -layout) volgens § 12 van de overdracht: nieuwste eerst, bedrag =
//    saldoverschil, ontdubbelen op (datum, referentie, saldo), keten 0 breuken en aansluitend op de laatste bewaarde regel, omwisselingen
//    gekoppeld op referentie. Breekt iets: niets overnemen, signaal. Alleen de twee rekeningen van ECG; elk ander rekeningnummer weigert.
// 3. Fondsen: status en termijn wijzigen (fondsZet), met logregel. 4. Maandronde: vijf stappen, alleen-afvinken (rondeZet).
//
// INTERN: tegenpartij, tegenrekening en donateur van GHAWA komen alleen in de routes indelen en donateurs (eigen app, nooit gedeeld).
// Geen log met inhoud: signalen noemen aantallen en datums, geen namen of rekeningnummers.

const fs = require('fs');
const path = require('path');

const REK_GHAWA = { NL10TRIO0320736857: 'Current', NL59TRIO2300542544: 'Savings' };
const ECG_REK = { '6240042907': 'GMD', '6240042909': 'EUR' };
const GIFT_GRENS = 500000;   // bijschrijving van een onbekende tegenrekening onder € 5.000 = gift; daarboven (sponsor?) vraagt een tik
const SOORT_ONBEKEND = 'Unknown';
const FONDS_STATUS = ['Committed - not yet received', 'Received by GHAWA NL', 'Received by ECG', 'Expected per year', 'Withdrawn'];

const EXTRA_KOLOMMEN = [
  ['bankregel_ghawa', 'herkomst', "TEXT NOT NULL DEFAULT 'overdracht'"], ['bankregel_ghawa', 'bron_sleutel', 'TEXT'],
  ['bankregel_ghawa', 'soort_door', 'TEXT'], ['bankregel_ghawa', 'saldo_berekend', 'INTEGER NOT NULL DEFAULT 0'],
  ['bankregel_ecg', 'herkomst', "TEXT NOT NULL DEFAULT 'overdracht'"], ['bankregel_ecg', 'afschrift', 'TEXT'],
  ['geldstroom', 'herkomst', "TEXT NOT NULL DEFAULT 'overdracht'"], ['geldstroom', 'referentie', 'TEXT'],
  ['fonds', 'termijn', 'TEXT'], ['fonds', 'gewijzigd_op', 'TEXT'],
];
const SCHEMA_BIJ = `
CREATE TABLE IF NOT EXISTS fonds_log (nr INTEGER PRIMARY KEY, fonds TEXT NOT NULL, veld TEXT NOT NULL, oud TEXT, nieuw TEXT, op TEXT NOT NULL, door TEXT);
CREATE TABLE IF NOT EXISTS afschrift (id TEXT PRIMARY KEY, naam TEXT, formaat TEXT, rekening TEXT, munt TEXT, van TEXT, tot TEXT, regels INTEGER,
  nieuw INTEGER, al_bekend INTEGER, uitkomst TEXT NOT NULL, fout TEXT, op TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS signaal (id TEXT PRIMARY KEY, soort TEXT NOT NULL, tekst TEXT NOT NULL, op TEXT NOT NULL, dicht_op TEXT);
CREATE TABLE IF NOT EXISTS ronde (maand TEXT NOT NULL, stap TEXT NOT NULL, op TEXT NOT NULL, PRIMARY KEY (maand, stap));
`;
const BIJ_TABELLEN = ['fonds_log', 'afschrift', 'signaal', 'ronde'];

// Schema bijwerken zonder iets weg te gooien (bestaande databank van fase 1); idempotent.
function migreer(db) {
  for (const [t, k, def] of EXTRA_KOLOMMEN) {
    const kol = new Set(db.prepare('PRAGMA table_info(' + t + ')').all().map((r) => r.name));
    if (!kol.has(k)) db.exec('ALTER TABLE ' + t + ' ADD COLUMN ' + k + ' ' + def);
  }
  db.exec(SCHEMA_BIJ);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS bankregel_ghawa_bron ON bankregel_ghawa (bron_sleutel) WHERE bron_sleutel IS NOT NULL');
  db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('schema', '3');
}
// Wat fase 2 aan gegevens heeft (een herinvoer uit het Excel-bestand zou dat wissen).
function fase2Gegevens(db) {
  const heeft = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const kol = (t, k) => heeft(t) && db.prepare('PRAGMA table_info(' + t + ')').all().some((r) => r.name === k);
  let n = 0;
  if (kol('bankregel_ghawa', 'herkomst')) n += db.prepare("SELECT COUNT(*) AS n FROM bankregel_ghawa WHERE herkomst <> 'overdracht'").get().n;
  if (kol('bankregel_ecg', 'herkomst')) n += db.prepare("SELECT COUNT(*) AS n FROM bankregel_ecg WHERE herkomst <> 'overdracht'").get().n;
  if (heeft('fonds_log')) n += db.prepare('SELECT COUNT(*) AS n FROM fonds_log').get().n;
  return n;
}

// ── kleine hulpen ──
const nuIso = (o) => (o && o.nu) || new Date().toISOString();
function teller(l) { const m = new Map(); for (const k of l) m.set(k, (m.get(k) || 0) + 1); return m; }
function tellerVerschil(a, b) {   // aantal sleutels dat in a vaker staat dan in b
  let n = 0; for (const [k, v] of a) n += Math.max(0, v - (b.get(k) || 0)); return n;
}
// tegenrekening als sleutel: het IBAN ("BIC IBAN" of los), of een oud/buitenlands nummer met punten zoals Facturen het bewaart (ECG: 999.99.99.999)
function ibanUit(s) { const m = /(?:^|\s)([A-Z]{2}\d{2}[A-Z0-9]{11,30}|\d[\d.]{4,30}\d)\s*$/.exec(String(s || '').trim()); return m ? m[1] : null; }
const schoon = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
function naamNorm(s) { const t = schoon(s, 80); return t || null; }
function signaal(db, soort, tekst, nu) {   // één open signaal per soort; nieuw = vervangt de tekst, nooit dubbel
  const id = soort;
  db.prepare('INSERT INTO signaal (id, soort, tekst, op, dicht_op) VALUES (?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET tekst=excluded.tekst, op=excluded.op, dicht_op=NULL')
    .run(id, soort, schoon(tekst, 300), nu);
}
function signaalDicht(db, soort, nu) { db.prepare('UPDATE signaal SET dicht_op = ? WHERE id = ? AND dicht_op IS NULL').run(nu, soort); }
function metaZet(db, k, v) { db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(k, v == null ? null : String(v)); }
function volgendId(db, tabel, letter) {
  let max = 0;
  for (const r of db.prepare('SELECT id FROM ' + tabel).all()) { const m = new RegExp('^' + letter + '(\\d+)$').exec(r.id); if (m) max = Math.max(max, Number(m[1])); }
  return () => { max += 1; return letter + String(max).padStart(4, '0'); };
}
function centTekst(c) { const n = Math.abs(c), s = Math.floor(n / 100) + '.' + String(n % 100).padStart(2, '0'); return (c < 0 ? '-' : '') + s; }

// ═══════════════ 1. GHAWA-bank uit Facturen ═══════════════
function code(t) {
  const a = /^TRIODOS:([A-Z]{1,6})$/.exec(String(t.transactietype || ''));
  if (a) return a[1];
  const b = /^BANKLUIS:.*?\b([A-Z]{2,4})$/.exec(String(t.transactietype || ''));
  return b ? b[1] : null;
}
// Wat elke tegenrekening eerder was, per richting; Davids eigen keuze wint, daarna de jongste regel.
function leerKaart(db) {
  const m = new Map();
  for (const r of db.prepare("SELECT tegenrekening, bedrag_cent, soort, donateur, soort_door, volg FROM bankregel_ghawa WHERE soort <> ? ORDER BY volg").all(SOORT_ONBEKEND)) {
    const iban = ibanUit(r.tegenrekening); if (!iban) continue;
    const k = iban + '|' + (r.bedrag_cent > 0 ? 'in' : 'uit');
    const oud = m.get(k);
    if (oud && oud.door === 'david' && r.soort_door !== 'david') continue;
    m.set(k, { soort: r.soort, donateur: r.donateur, door: r.soort_door === 'david' ? 'david' : 'geleerd' });
  }
  return m;
}
// t = regel uit Facturen; geeft { soort, donateur, door }
function deelInGhawa(t, leer, rekeningen) {
  const REK = rekeningen || REK_GHAWA;
  const c = code(t), inn = t.bedrag_centen > 0, ti = t.tegenpartij_iban || null;
  if (ti && REK[ti] && ti !== t.eigen_iban) return { soort: 'Internal transfer (current/savings)', donateur: null, door: 'regel' };
  if (!inn && (c === 'KN' || /^triodos bank\b.*kosten/i.test(String(t.omschrijving || '')))) return { soort: 'Bank costs', donateur: null, door: 'regel' };
  if (inn && c === 'RE') return { soort: 'Interest', donateur: null, door: 'regel' };
  if (!inn && c === 'PR') return { soort: 'Bank fee foreign payment', donateur: null, door: 'regel' };
  const tk = ibanUit(ti);
  const l = tk ? leer.get(tk + '|' + (inn ? 'in' : 'uit')) : null;
  if (l && l.soort !== SOORT_ONBEKEND) return { soort: l.soort, donateur: l.donateur || null, door: l.door };
  if (inn && t.bedrag_centen < GIFT_GRENS && (c === 'ET' || c === 'EI' || c === 'EIST')) return { soort: 'Donation (bank transfer)', donateur: naamNorm(t.tegenpartij_naam), door: 'regel' };
  return { soort: SOORT_ONBEKEND, donateur: null, door: 'onbekend' };
}
// Leest Facturen (alleen lezen). → { regels, ankers } of null als de databank er niet is.
function leesFacturen(facPad, rekeningen) {
  const REK = rekeningen || REK_GHAWA;
  if (!facPad || !fs.existsSync(facPad)) return null;
  const { DatabaseSync } = require('node:sqlite');
  const f = new DatabaseSync(facPad, { readOnly: true });
  try {
    f.exec('BEGIN');
    const ib = Object.keys(REK);
    if (ib.length !== 2) throw new Error('twee rekeningen verwacht');
    const regels = f.prepare('SELECT id, eigen_iban, boekdatum, bedrag_centen, valuta, tegenpartij_naam, tegenpartij_iban, omschrijving, transactietype, bestand ' +
      'FROM bank_transactie WHERE eigen_iban IN (?, ?) AND verwijderd_op IS NULL ORDER BY boekdatum, id').all(...ib);
    const ankers = [];
    for (const b of f.prepare("SELECT id, saldo FROM bank_bestand WHERE saldo IS NOT NULL AND formaat = 'triodos_csv'").all()) {
      let j; try { j = JSON.parse(b.saldo); } catch (e) { continue; }
      for (const iban of ib) {
        const x = j && j[iban];
        if (!x || x.gecontroleerd !== true || x.sluit !== true || !Number.isSafeInteger(x.eind_centen)) continue;
        const tot = regels.filter((t) => t.bestand === b.id && t.eigen_iban === iban).reduce((m, t) => (t.boekdatum > m ? t.boekdatum : m), '');
        if (tot) ankers.push({ iban, tot, eind: x.eind_centen });
      }
    }
    const sp = f.prepare('SELECT laatste_invoer_op AS op FROM rekening WHERE iban = ?').get(ib.find((i) => REK[i] === 'Savings'));
    f.exec('COMMIT');
    return { regels, ankers, spaar_upload_op: sp && sp.op ? String(sp.op) : null };
  } finally { f.close(); }
}
// Vergelijkt en neemt over. db = schrijfbare ghawa-databank (gemigreerd). → { uitkomst, nieuw, onbekend, fout? }
function bankBij(db, facPad, o) {
  const nu = nuIso(o);
  const REK = (o && o.rekeningen) || REK_GHAWA;
  const F = (o && o.facturen) || leesFacturen(facPad, REK);
  if (!F) return { uitkomst: 'geen bron', nieuw: 0, onbekend: 0 };
  if (F.regels.some((t) => t.valuta !== 'EUR' || !Number.isSafeInteger(t.bedrag_centen) || !/^\d{4}-\d{2}-\d{2}$/.test(String(t.boekdatum)))) {
    return weiger('een bankregel van GHAWA in Facturen heeft geen geldige datum of euro-bedrag');
  }
  function weiger(fout) {
    signaal(db, 'bank', 'GHAWA-bank niet bijgewerkt: ' + fout + '. Er is niets overgenomen.', nu);
    metaZet(db, 'bank_bij_op', nu); metaZet(db, 'bank_bij_uitkomst', 'geweigerd');
    return { uitkomst: 'geweigerd', nieuw: 0, onbekend: 0, fout };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const G = db.prepare('SELECT id, rekening, datum, bedrag_cent, herkomst, bron_sleutel, volg FROM bankregel_ghawa ORDER BY volg').all();
    const breuken = [], nieuw = [];
    for (const [iban, soortRek] of Object.entries(REK)) {
      const rekNaam = (G.find((g) => g.rekening.indexOf(iban) >= 0) || {}).rekening || soortRek + ' ' + iban;
      const naam = soortRek === 'Current' ? 'betaalrekening' : 'spaarrekening';
      const g = G.filter((x) => x.rekening === rekNaam);
      const go = g.filter((x) => x.herkomst === 'overdracht');
      const gEind = go.reduce((m, x) => (x.datum > m ? x.datum : m), '');
      const ft = F.regels.filter((t) => t.eigen_iban === iban);
      if (!ft.length) continue;
      const fStart = ft.reduce((m, t) => (t.boekdatum < m ? t.boekdatum : m), '9999');
      const sl = (d, c) => d + '|' + c;
      // a. overlap
      const tG = teller(go.filter((x) => x.datum >= fStart && x.datum <= gEind).map((x) => sl(x.datum, x.bedrag_cent)));
      const tF = teller(ft.filter((t) => t.boekdatum <= gEind).map((t) => sl(t.boekdatum, t.bedrag_centen)));
      const alleenG = tellerVerschil(tG, tF), alleenF = tellerVerschil(tF, tG);
      if (alleenG || alleenF) breuken.push(naam + ': tot ' + gEind + ' staan ' + alleenF + ' regel(s) alleen in de bank en ' + alleenG + ' alleen in de overdracht');
      // b. na de overdracht: wat al binnen was moet er nog staan; de rest is nieuw
      const bestaand = g.filter((x) => x.herkomst === 'bank');
      const vrij = new Map();
      for (const x of bestaand) { const k = sl(x.datum, x.bedrag_cent); if (!vrij.has(k)) vrij.set(k, []); vrij.get(k).push(x); }
      const nieuwF = [];
      for (const t of ft.filter((t) => t.boekdatum > gEind)) { const l = vrij.get(sl(t.boekdatum, t.bedrag_centen)); if (l && l.length) l.pop(); else nieuwF.push(t); }
      const weg = [...vrij.values()].reduce((s, l) => s + l.length, 0);
      if (weg) breuken.push(naam + ': ' + weg + ' eerder overgenomen regel(s) staan niet meer in de bank');
      // c. eindsaldo van elke gecontroleerde upload
      const alle = go.map((x) => [x.datum, x.bedrag_cent]).concat(bestaand.map((x) => [x.datum, x.bedrag_cent]), nieuwF.map((t) => [t.boekdatum, t.bedrag_centen]));
      for (const a of F.ankers.filter((a) => a.iban === iban)) {
        const s = alle.filter((x) => x[0] <= a.tot).reduce((s, x) => s + x[1], 0);
        if (s !== a.eind) breuken.push(naam + ': saldo op ' + a.tot + ' volgens de upload wijkt ' + centTekst(s - a.eind) + ' af van de som van de regels');
      }
      for (const t of nieuwF) nieuw.push({ t, rekNaam });
    }
    if (breuken.length) { db.exec('ROLLBACK'); return weiger(breuken.join('; ')); }
    let onbekend = 0;
    if (nieuw.length) {
      const leer = leerKaart(db);
      const id = volgendId(db, 'bankregel_ghawa', 'G');
      let volg = db.prepare('SELECT COALESCE(MAX(volg), 0) AS v FROM bankregel_ghawa').get().v;
      const saldo = {};
      const laatst = db.prepare('SELECT saldo_cent FROM bankregel_ghawa WHERE rekening = ? ORDER BY volg DESC LIMIT 1');
      const zet = db.prepare('INSERT INTO bankregel_ghawa (id, rekening, datum, jaar, bedrag_cent, richting, tegenpartij, tegenrekening, code, omschrijving, saldo_cent, soort, ' +
        'donateur, project, doel, volg, herkomst, bron_sleutel, soort_door, saldo_berekend) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      nieuw.sort((a, b) => (a.t.boekdatum < b.t.boekdatum ? -1 : a.t.boekdatum > b.t.boekdatum ? 1 : 0));
      for (const { t, rekNaam } of nieuw) {
        if (saldo[rekNaam] === undefined) { const r = laatst.get(rekNaam); saldo[rekNaam] = r && r.saldo_cent !== null ? r.saldo_cent : 0; }
        saldo[rekNaam] += t.bedrag_centen;
        const s = deelInGhawa(t, leer, REK);
        if (s.soort === SOORT_ONBEKEND) onbekend++;
        // bron_sleutel = id in Facturen; vervangt Facturen die regel (upload na koppeling), dan blijft de vergelijking op datum en bedrag
        zet.run(id(), rekNaam, t.boekdatum, Number(t.boekdatum.slice(0, 4)), t.bedrag_centen, t.bedrag_centen > 0 ? 'in' : 'out', naamNorm(t.tegenpartij_naam),
          t.tegenpartij_iban || null, code(t), schoon(t.omschrijving, 140) || null, saldo[rekNaam], s.soort, s.donateur, 'General', null, ++volg, 'bank',
          'fac:' + String(t.id).slice(0, 40) + ':' + volg, s.door, 1);
      }
    }
    signaalDicht(db, 'bank', nu);
    if (F.spaar_upload_op) metaZet(db, 'spaar_upload_op', F.spaar_upload_op);
    metaZet(db, 'bank_bij_op', nu); metaZet(db, 'bank_bij_uitkomst', nieuw.length ? 'bijgewerkt' : 'niets nieuw');
    db.exec('COMMIT');
    return { uitkomst: nieuw.length ? 'bijgewerkt' : 'niets nieuw', nieuw: nieuw.length, onbekend };
  } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { /* al dicht */ } throw e; }
}
// Eén tik van David: soort van een bankregel die uit de bank kwam (niet de overdracht).
function indelen(db, id, soort, soorten, nu) {
  if (!soorten.some((s) => s[0] === soort) || soort === SOORT_ONBEKEND) return { ok: false, status: 400, fout: 'onbekende soort' };
  const r = db.prepare('SELECT id, herkomst, bedrag_cent, tegenpartij FROM bankregel_ghawa WHERE id = ?').get(String(id || ''));
  if (!r) return { ok: false, status: 404, fout: 'die regel bestaat niet' };
  if (r.herkomst !== 'bank') return { ok: false, status: 409, fout: 'regels uit het overdrachtsbestand blijven zoals ze zijn' };
  const gift = /^Donation/.test(soort);
  db.prepare('UPDATE bankregel_ghawa SET soort = ?, soort_door = ?, donateur = CASE WHEN ? THEN COALESCE(donateur, tegenpartij) ELSE NULL END WHERE id = ?')
    .run(soort, 'david', gift ? 1 : 0, r.id);
  metaZet(db, 'laatste_tik', nu);
  return { ok: true, id: r.id, soort };
}

// ═══════════════ 2. ECG-afschriften (Ecobank) ═══════════════
const MND = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function isoDag(j, m, d) {
  if (j < 100) j += 2000;
  const t = new Date(Date.UTC(j, m - 1, d));
  if (t.getUTCFullYear() !== j || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}
// '02 Nov 2026', '02-NOV-26', '02/11/2026', '2026-11-02', '02.11.2026'
function datumEco(s) {
  const t = String(s || '').trim();
  let m = /^(\d{1,2})[ \-/.]([A-Za-z]{3})[A-Za-z]*[ \-/.,]+(\d{2,4})$/.exec(t);
  if (m && MND[m[2].toLowerCase()]) return isoDag(Number(m[3]), MND[m[2].toLowerCase()], Number(m[1]));
  m = /^(\d{1,2})[\-/.](\d{1,2})[\-/.](\d{2,4})$/.exec(t);
  if (m) return isoDag(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return isoDag(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}
// '1,234.56' → 123456 (decimaal uit de tekst, geen binaire afronding); '' → null; ongeldig → NaN
function centEco(s) {
  const t = String(s == null ? '' : s).trim().replace(/,/g, '');
  if (t === '') return null;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return NaN;
  const c = Number(m[2]) * 100 + Number(((m[3] || '') + '00').slice(0, 2));
  return Number.isSafeInteger(c) ? (m[1] && c ? -c : c) : NaN;
}
// Ecobank-csv (vorm gemeten 1-11-2026 bij ecobank-mail.js: kopregels, dan Transaction Date,Description,Reference Number,DEBIT,CREDIT,Balance; nieuwste eerst)
const CSV_KOP = ['transaction date', 'description', 'reference number', 'debit', 'credit', 'balance'];
function leesEcgCsv(tekst, csvLees) {
  const r = csvLees(String(tekst).replace(/^﻿/, ''));
  const kop = {}; let k = -1;
  for (let i = 0; i < Math.min(r.length, 25); i++) {
    if (r[i].length >= 6 && CSV_KOP.every((n, j) => String(r[i][j]).trim().toLowerCase() === n)) { k = i; break; }
    if (r[i][0]) kop[String(r[i][0]).trim().toLowerCase()] = String(r[i][1] == null ? '' : r[i][1]).trim();
  }
  if (k < 0) return { fout: 'dit is geen Ecobank-export (de kolommen Transaction Date … Balance ontbreken)' };
  const nr = String(kop['account no'] || kop['account number'] || '').replace(/\s/g, '');
  const rijen = [];
  for (let i = k + 1; i < r.length; i++) {
    const x = r[i];
    if (!x.some((v) => String(v).trim())) continue;
    if (x.length < 6) return { fout: 'regel ' + (i + 1) + ' heeft ' + x.length + ' kolommen' };
    const datum = datumEco(x[0]), deb = centEco(x[3]), cre = centEco(x[4]), saldo = centEco(x[5]);
    if (!datum) return { fout: 'regel ' + (i + 1) + ': datum niet te lezen' };
    if ([deb, cre, saldo].some((v) => Number.isNaN(v)) || saldo === null || (deb === null) === (cre === null)) return { fout: 'regel ' + (i + 1) + ': bedragen niet te lezen' };
    const ref = String(x[2]).trim();
    if (!/^[A-Za-z0-9\-/]{4,40}$/.test(ref)) return { fout: 'regel ' + (i + 1) + ': referentie niet te lezen' };
    rijen.push({ datum, omschrijving: schoon(x[1], 200), referentie: ref, bedrag: deb !== null ? -Math.abs(deb) : Math.abs(cre), saldo });
  }
  return { rekening: nr, formaat: 'csv', rijen: rijen.reverse() };   // oud → nieuw
}
// pdftotext -layout van een Ecobank-afschrift. Vorm niet gemeten op een echt ECG-pdf (er was er geen op de pod): daarom streng —
// elke regel met een datum vooraan en minstens één bedrag; het laatste bedrag is het saldo, het bedrag ervoor (als het er is) moet gelijk
// zijn aan het saldoverschil. Vervolgregels zonder datum en bedrag horen bij de omschrijving erboven. Sluit het niet: weigeren.
const DATUM_VOOR = /^\s*(\d{1,2}[\-/. ](?:[A-Za-z]{3,9}|\d{1,2})[\-/., ]+\d{2,4}|\d{4}-\d{2}-\d{2})\s+/;
const BEDRAG_G = /(?:^|\s)(-?\d{1,3}(?:,\d{3})*\.\d{2}|-?\d+\.\d{2})(?=\s|$)/g;
function leesEcgPdfTekst(tekst) {
  const t = String(tekst || '');
  const nrs = [...new Set((t.match(/\b\d{10}\b/g) || []).filter((n) => ECG_REK[n] || /^62400\d{5}$/.test(n)))];
  let opening = null;
  const mo = /(opening\s+balance|balance\s+b\/?f|brought\s+forward)[^\d\-]*(-?[\d,]+\.\d{2})/i.exec(t);
  if (mo) opening = centEco(mo[2]);
  const rijen = [];
  for (const regel of t.split(/\r?\n/)) {
    if (/opening\s+balance|closing\s+balance|balance\s+[bc]\/?f|brought\s+forward|carried\s+forward|total/i.test(regel)) continue;
    const d = DATUM_VOOR.exec(regel);
    const bedragen = [...regel.matchAll(BEDRAG_G)].map((m) => m[1]);
    if (!d || !bedragen.length) {
      if (rijen.length && !bedragen.length && regel.trim() && !DATUM_VOOR.test(regel)) {
        const vorige = rijen[rijen.length - 1];
        if (vorige.vervolg < 3) { vorige.omschrijving = schoon(vorige.omschrijving + ' ' + regel, 200); vorige.vervolg++; }
      }
      continue;
    }
    const datum = datumEco(d[1].replace(/\s+/g, ' ').replace(/,/g, ''));
    if (!datum) continue;
    let rest = regel.slice(d[0].length);
    const d2 = DATUM_VOOR.exec(rest); if (d2 && datumEco(d2[1])) rest = rest.slice(d2[0].length);   // valutadatum
    const saldo = centEco(bedragen[bedragen.length - 1]);
    const kolom = bedragen.length >= 2 ? Math.abs(centEco(bedragen[bedragen.length - 2])) : null;
    const tekstDeel = rest.replace(BEDRAG_G, ' ');
    const ref = (tekstDeel.match(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10,20}\b/g) || []).pop() || '';
    const omschrijving = schoon(ref ? tekstDeel.replace(ref, ' ') : tekstDeel, 200);
    if (Number.isNaN(saldo) || Number.isNaN(kolom)) continue;
    rijen.push({ datum, omschrijving, referentie: ref, kolom, saldo, vervolg: 0 });
  }
  if (!rijen.length) return { fout: 'in dit pdf-bestand staan geen boekingen die ik kan lezen; zet de csv-export erin' };
  // Volgorde: § 12 zegt nieuwste eerst; is de eerste datum ouder dan de laatste, dan staat hij al oud → nieuw.
  const omkeren = rijen[0].datum > rijen[rijen.length - 1].datum || (rijen[0].datum === rijen[rijen.length - 1].datum);
  const oudNieuw = omkeren ? rijen.slice().reverse() : rijen.slice();
  for (let i = 0; i < oudNieuw.length; i++) {
    const r = oudNieuw[i];
    const voor = i ? oudNieuw[i - 1].saldo : opening;
    r.bedrag = voor === null ? null : r.saldo - voor;
    if (r.bedrag !== null && r.kolom !== null && Math.abs(r.bedrag) !== r.kolom) return { fout: 'de saldi in het pdf sluiten niet op ' + r.datum + ' (bedrag ' + centTekst(r.kolom) + ', saldoverschil ' + centTekst(r.bedrag) + '); zet de csv-export erin' };
    if (r.bedrag === null && r.kolom === null) return { fout: 'bij de eerste boeking staat geen bedrag; zet de csv-export erin' };
  }
  return { rekening: nrs.length === 1 ? nrs[0] : (nrs.filter((n) => ECG_REK[n]).length === 1 ? nrs.filter((n) => ECG_REK[n])[0] : ''), formaat: 'pdf', opening,
    rijen: oudNieuw.map((r) => ({ datum: r.datum, omschrijving: r.omschrijving, referentie: r.referentie, bedrag: r.bedrag, kolom: r.kolom, saldo: r.saldo })) };
}
function pdfNaarTekst(bytes) {
  const os = require('os'), cp = require('child_process');
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'ghawa-pdf-'));
  try {
    const f = path.join(map, 'a.pdf');
    fs.writeFileSync(f, bytes, { mode: 0o600 });
    const r = cp.spawnSync('pdftotext', ['-layout', '-q', '-enc', 'UTF-8', f, '-'], { timeout: 20000, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' });
    if (r.error || r.status !== 0) return { fout: 'het pdf-bestand kon ik niet openen' };
    return { tekst: r.stdout };
  } finally { fs.rmSync(map, { recursive: true, force: true }); }
}
// Indeling volgens § 12 van de overdracht. rijen (één rekening, oud → nieuw) krijgen soort, cheque en begunstigde.
const KOSTEN = /COMMISSION|VALUE ADDED|E-? ?BANKING|E-? ?SERVICE|CHEQUE BOOK|MONTHLY|CHARGE|\bFEE|STAMP DUTY|SMS ALERT/;
function titel(s) { return schoon(s, 60).toLowerCase().replace(/(^|[\s(/.-])([a-z])/g, (m, a, b) => a + b.toUpperCase()); }
function deelInEcg(rijen, munt) {
  const groep = new Map();   // (datum, referentie) → grootste bedrag (de echte boeking; kleinere zijn kosten)
  for (const r of rijen) { if (!r.referentie) continue; const k = r.datum + '|' + r.referentie; groep.set(k, Math.max(groep.get(k) || 0, Math.abs(r.bedrag))); }
  const grootste = (r) => !r.referentie || Math.abs(r.bedrag) === groep.get(r.datum + '|' + r.referentie);
  for (const r of rijen) {
    const o = String(r.omschrijving || '').toUpperCase(), inn = r.bedrag > 0;
    let soort = 'Other', cheque = null, begunstigde = null;
    const ifo = /\bIFO\s+([^,]+?)(?:,|\s{2,}|$)/.exec(o);
    if (/TRF\s*B\s*\/\s*O?/.test(o) && inn) soort = 'Transfer in from NL';
    else if (/CASH\s+WDL/.test(o)) soort = !inn && grootste(r) ? 'Cash withdrawal' : 'Bank charge';
    else if (/\bCHQ\b/.test(o)) {
      soort = inn ? 'Reversal' : 'Cheque withdrawal';
      const m = /\bCHQ\s*(?:N[O0](?=[\s\-.:]))?[\s\-.:]*0*(\d+)/.exec(o); if (m) cheque = m[1];   // ook "CHQ N0- 40" (nul i.p.v. O, gemeten B0174)
      const p = /\bPAID\s+(?:TO|IFO)\s+(.+)$/.exec(o); if (p) begunstigde = titel(p[1]);
    } else if (/PURCH OF EUR/.test(o) || (ifo && /^ELITE CARE GROUP\b/.test(ifo[1]))) {
      if (munt === 'GMD') soort = inn ? 'Conversion in' : 'Bank charge';
      else soort = !inn && grootste(r) ? 'Conversion out' : 'Bank charge';
    } else if (KOSTEN.test(o) && !inn) soort = 'Bank charge';
    else if (ifo) {
      begunstigde = titel(ifo[1]);
      if (munt === 'GMD') soort = inn ? 'Reversal' : (grootste(r) ? 'Payment to supplier' : 'Bank charge');
      else soort = inn ? 'Other' : (grootste(r) ? 'Payment from EUR account' : 'Bank charge');
    }
    r.soort = soort; r.cheque = cheque; r.begunstigde = begunstigde;
  }
  return rijen;
}
// Afschrift erin. bytes = Buffer; naam = bestandsnaam (alleen voor de weergave). → { uitkomst, rekening, nieuw, al_bekend, ... }
function ecgAfschrift(db, inv, hulp, o) {
  const nu = nuIso(o);
  const bytes = Buffer.isBuffer(inv.bytes) ? inv.bytes : Buffer.from(inv.bytes || '');
  const crypto = require('crypto');
  const id = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24);
  const naam = schoon(inv.naam, 80) || 'afschrift';
  const eerder = db.prepare("SELECT uitkomst, op FROM afschrift WHERE id = ? AND uitkomst IN ('overgenomen', 'niets nieuw')").get(id);
  if (eerder) return { ok: true, uitkomst: 'al ingelezen', op: eerder.op, nieuw: 0, al_bekend: 0 };
  function log(u) {
    db.prepare('INSERT OR REPLACE INTO afschrift (id, naam, formaat, rekening, munt, van, tot, regels, nieuw, al_bekend, uitkomst, fout, op) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, naam, u.formaat || null, u.rekening || null, u.munt || null, u.van || null, u.tot || null, u.regels || 0, u.nieuw || 0, u.al_bekend || 0, u.uitkomst, u.fout || null, nu);
  }
  function weiger(fout, x) {
    const u = Object.assign({ uitkomst: 'geweigerd', fout }, x || {});
    log(u);
    signaal(db, 'afschrift', 'Afschrift "' + naam + '" niet overgenomen: ' + fout + '.', nu);
    return Object.assign({ ok: false, status: 422 }, u);
  }
  let lees;
  if (bytes.slice(0, 5).toString('latin1') === '%PDF-') {
    const p = (hulp && hulp.pdfNaarTekst || pdfNaarTekst)(bytes);
    if (p.fout) return weiger(p.fout, { formaat: 'pdf' });
    lees = leesEcgPdfTekst(p.tekst);
  } else {
    const tekst = bytes.toString('utf8');
    if (/^\s*\d{2}-\d{2}-\d{4},"?NL\d{2}TRIO/.test(tekst)) return weiger('dit is een Triodos-export van GHAWA: die hoort in Facturen (GHAWA leest hem daar)', { formaat: 'triodos' });
    lees = leesEcgCsv(tekst, hulp.csvLees);
  }
  if (lees.fout) return weiger(lees.fout, { formaat: lees.formaat });
  const rek = String(lees.rekening || '').replace(/\D/g, '');
  const munt = ECG_REK[rek];
  if (!munt) return weiger(rek ? 'dit afschrift is van een andere rekening (eindigt op ' + rek.slice(-3) + '), niet van ECG' : 'het rekeningnummer van ECG staat niet in het afschrift', { formaat: lees.formaat });
  const rijen = lees.rijen;
  if (!rijen.length) return weiger('er staan geen boekingen in', { formaat: lees.formaat, rekening: rek, munt });
  const basis = { formaat: lees.formaat, rekening: rek, munt, van: rijen[0].datum, tot: rijen[rijen.length - 1].datum, regels: rijen.length };
  // keten binnen het afschrift (csv: bedrag uit de kolommen; pdf: al nagerekend)
  for (let i = 1; i < rijen.length; i++) {
    if (rijen[i].bedrag !== null && rijen[i - 1].saldo + rijen[i].bedrag !== rijen[i].saldo) return weiger('de saldi in het afschrift sluiten niet op ' + rijen[i].datum, basis);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const rekNaam = (db.prepare('SELECT rekening FROM bankregel_ecg WHERE munt = ? LIMIT 1').get(munt) || {}).rekening || munt + ' ' + rek;
    const bestaand = db.prepare('SELECT id, datum, referentie, bedrag_cent, saldo_cent, volg FROM bankregel_ecg WHERE munt = ? ORDER BY volg').all(munt);
    const laatste = bestaand.length ? bestaand[bestaand.length - 1] : null;
    const sl = (d, r, s) => d + '|' + String(r || '').toUpperCase() + '|' + s;
    const vrij = teller(bestaand.map((b) => sl(b.datum, b.referentie, b.saldo_cent)));
    let bekend = 0, eersteNieuw = -1, laatsteBekend = -1;
    for (let i = 0; i < rijen.length; i++) {
      const k = sl(rijen[i].datum, rijen[i].referentie, rijen[i].saldo);
      if ((vrij.get(k) || 0) > 0) { vrij.set(k, vrij.get(k) - 1); bekend++; laatsteBekend = i; rijen[i].bekend = true; }
      else if (eersteNieuw < 0) eersteNieuw = i;
    }
    if (eersteNieuw < 0) {
      log(Object.assign({ uitkomst: 'niets nieuw', nieuw: 0, al_bekend: bekend }, basis)); db.exec('COMMIT');
      return Object.assign({ ok: true, uitkomst: 'niets nieuw', nieuw: 0, al_bekend: bekend }, basis);
    }
    if (laatsteBekend > eersteNieuw) { db.exec('ROLLBACK'); return weiger('nieuwe en al bekende boekingen lopen door elkaar', basis); }
    if (bekend && laatste && sl(rijen[laatsteBekend].datum, rijen[laatsteBekend].referentie, rijen[laatsteBekend].saldo) !== sl(laatste.datum, laatste.referentie, laatste.saldo_cent)) {
      db.exec('ROLLBACK'); return weiger('het afschrift sluit niet aan op de laatste bewaarde boeking van ' + laatste.datum, basis);
    }
    const nieuw = rijen.slice(eersteNieuw);
    const vorigSaldo = laatste ? laatste.saldo_cent : 0;
    if (nieuw[0].bedrag === null) nieuw[0].bedrag = nieuw[0].saldo - vorigSaldo;   // pdf zonder beginsaldo: het saldoverschil met onze laatste regel
    if (nieuw[0].kolom != null && Math.abs(nieuw[0].bedrag) !== nieuw[0].kolom) { db.exec('ROLLBACK'); return weiger('de eerste nieuwe boeking sluit niet aan op de laatste bewaarde (' + (laatste ? laatste.datum : 'begin') + ')', basis); }
    if (vorigSaldo + nieuw[0].bedrag !== nieuw[0].saldo) {
      db.exec('ROLLBACK');
      return weiger('er ontbreekt een periode tussen ' + (laatste ? laatste.datum : 'het begin') + ' en ' + nieuw[0].datum + ' (het saldo sluit niet aan)', basis);
    }
    // indelen samen met wat al bewaard is van dezelfde dag en referentie (een export kan midden in zo'n groep beginnen of eindigen):
    // de grootste is de boeking, de kleinere zijn kosten; eerder ingelezen afschriftregels in die groep krijgen zo nodig hun juiste soort
    const groepKey = (d, r) => d + '|' + r;
    const sleutels = new Set(nieuw.filter((r) => r.referentie).map((r) => groepKey(r.datum, r.referentie)));
    const buren = bestaand.filter((b) => b.referentie && sleutels.has(groepKey(b.datum, b.referentie)))
      .map((b) => db.prepare('SELECT id, datum, omschrijving, referentie, bedrag_cent AS bedrag, soort, herkomst FROM bankregel_ecg WHERE id = ?').get(b.id));
    deelInEcg(buren.concat(nieuw), munt);
    for (const b of buren) if (b.herkomst === 'afschrift') db.prepare('UPDATE bankregel_ecg SET soort = ?, cheque = ?, begunstigde = ? WHERE id = ?').run(b.soort, b.cheque, b.begunstigde, b.id);
    const nid = volgendId(db, 'bankregel_ecg', 'B');
    let volg = db.prepare('SELECT COALESCE(MAX(volg), 0) AS v FROM bankregel_ecg').get().v;
    const zet = db.prepare('INSERT INTO bankregel_ecg (id, rekening, datum, omschrijving, referentie, bedrag_cent, munt, saldo_cent, soort, cheque, begunstigde, bron, volg, herkomst, afschrift) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    let ander = 0;
    for (const r of nieuw) {
      if (r.soort === 'Other') ander++;
      zet.run(nid(), rekNaam, r.datum, r.omschrijving || null, r.referentie || null, r.bedrag, munt, r.saldo, r.soort, r.cheque, r.begunstigde,
        'Ecobank statement (' + basis.formaat + ', ingelezen ' + nu.slice(0, 10) + ')', ++volg, 'afschrift', id);
    }
    // bank wint: het saldo in de instellingen volgt de laatste regel (§ 12 stap 2)
    db.prepare('INSERT OR REPLACE INTO instelling (sleutel, waarde, toelichting) VALUES (?, ?, COALESCE((SELECT toelichting FROM instelling WHERE sleutel = ?), ?))')
      .run('bank_balance_' + munt.toLowerCase(), centTekst(nieuw[nieuw.length - 1].saldo), 'bank_balance_' + munt.toLowerCase(), 'Saldo volgens het laatste afschrift.');
    const stromen = koppelStromen(db);
    log(Object.assign({ uitkomst: 'overgenomen', nieuw: nieuw.length, al_bekend: bekend }, basis));
    signaalDicht(db, 'afschrift', nu);
    if (ander) signaal(db, 'ecg-onbekend', ander + ' boeking(en) op het afschrift van ' + basis.tot + ' herkende ik niet (soort Overig); ze tellen mee in het saldo, niet in de uitgaven.', nu);
    metaZet(db, 'afschrift_op', nu);
    db.exec('COMMIT');
    return Object.assign({ ok: true, uitkomst: 'overgenomen', nieuw: nieuw.length, al_bekend: bekend, onbekend: ander, geldstromen: stromen }, basis);
  } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { /* al dicht */ } throw e; }
}
// Omwisselingen (GMD in ↔ EUR uit met dezelfde referentie) en overboekingen naar ECG worden geldstromen; alleen voor regels uit een afschrift
// en nooit dubbel (referentie al in een geldstroom, ook in de toelichting van de overdracht).
function koppelStromen(db) {
  const al = (ref) => !!db.prepare('SELECT 1 FROM geldstroom WHERE referentie = ? OR notitie LIKE ?').get(ref, '%' + ref + '%');
  const mid = volgendId(db, 'geldstroom', 'M');
  const zet = db.prepare('INSERT INTO geldstroom (id, datum, soort, van, naar, eur_cent, gmd_cent, project, doel, bron, notitie, herkomst, referentie) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  let n = 0;
  const gmd = db.prepare("SELECT * FROM bankregel_ecg WHERE munt = 'GMD' AND soort = 'Conversion in' AND referentie IS NOT NULL ORDER BY volg").all();
  for (const g of gmd) {
    const e = db.prepare("SELECT * FROM bankregel_ecg WHERE munt = 'EUR' AND soort = 'Conversion out' AND referentie = ? ORDER BY volg").all(g.referentie);
    if (e.length !== 1 || (g.herkomst !== 'afschrift' && e[0].herkomst !== 'afschrift') || al(g.referentie)) continue;
    zet.run(mid(), g.datum, 'Conversion EUR to GMD', e[0].rekening, g.rekening, -e[0].bedrag_cent, g.bedrag_cent, 'Building', null, 'Ecobank statements',
      'koppeling op referentie', 'afschrift', g.referentie);
    n++;
  }
  for (const t of db.prepare("SELECT * FROM bankregel_ecg WHERE munt = 'EUR' AND soort = 'Transfer in from NL' AND herkomst = 'afschrift' AND referentie IS NOT NULL ORDER BY volg").all()) {
    if (al(t.referentie)) continue;
    const o = String(t.omschrijving || '').toUpperCase();
    const van = /GHAWA/.test(o) ? 'Stichting GHAWA (Triodos)' : /WILDE\s+GANZEN/.test(o) ? 'Stichting de Wilde Ganzen' : 'onbekend (zie afschrift)';
    zet.run(mid(), t.datum, 'Transfer to ECG', van, t.rekening, t.bedrag_cent, null, 'Building', null, 'Ecobank statements', null, 'afschrift', t.referentie);
    n++;
  }
  return n;
}

// ═══════════════ 3. Fondsen ═══════════════
function fondsZet(db, id, w, nu, door) {
  const f = db.prepare('SELECT * FROM fonds WHERE id = ?').get(String(id || ''));
  if (!f) return { ok: false, status: 404, fout: 'dat fonds bestaat niet' };
  if (w.bevestigd !== true) return { ok: false, status: 400, fout: 'bevestig de wijziging' };
  const zet = [];
  if (w.status !== undefined) {
    if (FONDS_STATUS.indexOf(w.status) < 0) return { ok: false, status: 400, fout: 'onbekende status' };
    if (w.status !== f.status) zet.push(['status', f.status, w.status]);
  }
  if (w.termijn !== undefined) {
    const t = w.termijn === null || w.termijn === '' ? null : String(w.termijn);
    if (t !== null && !/^\d{4}-\d{2}-\d{2}$/.test(t)) return { ok: false, status: 400, fout: 'termijn als jjjj-mm-dd' };
    if (t !== f.termijn) zet.push(['termijn', f.termijn, t]);
  }
  if (!zet.length) return { ok: true, id: f.id, gewijzigd: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [veld, oud, nieuw] of zet) {
      db.prepare('UPDATE fonds SET ' + (veld === 'status' ? 'status' : 'termijn') + ' = ?, gewijzigd_op = ? WHERE id = ?').run(nieuw, nu, f.id);
      db.prepare('INSERT INTO fonds_log (fonds, veld, oud, nieuw, op, door) VALUES (?,?,?,?,?,?)').run(f.id, veld, oud, nieuw, nu, schoon(door, 40) || null);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true, id: f.id, gewijzigd: zet.length };
}

// ═══════════════ 4. Maandronde ═══════════════
const RONDE_STAPPEN = ['afschriften', 'indelen', 'aansluiting', 'vragen', 'delen'];
const AFVINKBAAR = ['aansluiting', 'vragen'];
function maandVan(nu) { return String(nu).slice(0, 7); }
function rondeZet(db, stap, aan, nu) {
  if (AFVINKBAAR.indexOf(stap) < 0) return { ok: false, status: 400, fout: 'deze stap vink je niet af; hij gaat vanzelf' };
  const m = maandVan(nu);
  if (aan) db.prepare('INSERT OR REPLACE INTO ronde (maand, stap, op) VALUES (?,?,?)').run(m, stap, nu);
  else db.prepare('DELETE FROM ronde WHERE maand = ? AND stap = ?').run(m, stap);
  return { ok: true, maand: m, stap, aan: !!aan };
}
function dagen(van, nu) {
  if (!van) return null;
  return Math.floor((Date.parse(String(nu).slice(0, 10)) - Date.parse(String(van).slice(0, 10))) / 86400000);
}
// Kaart voor Voor jou als de ECG-cijfers ouder zijn dan 35 dagen; pas nadat er één afschrift via de app binnenkwam (tot dan dekt de
// aanleverkaart van wv2881 dit). Eén per maand (sleutel), nooit dubbel. → kaart of null
function rondeKaart(st, nu) {
  if (!st.afschrift_ooit) return null;
  const oud = Math.max(dagen(st.ecg_gmd, nu) || 0, dagen(st.ecg_eur, nu) || 0);
  if (oud <= 35) return null;
  const m = maandVan(nu);
  return { sleutel: 'ghawa-maandronde-' + m, soort: 'doen', titel: 'GHAWA — afschriften van ECG erin zetten',
    waarom: 'De cijfers van ECG in OVIS GHAWA zijn ' + oud + ' dagen oud. Met de nieuwe afschriften rekent de app de saldi, omwisselingen en de aansluiting zelf bij.',
    stappen: ['Vraag ECG (of download zelf) de afschriften van de euro- en de dalasirekening vanaf de laatste datum in de app, liefst als csv.',
      'Open Apps › GHAWA › Maandronde en zet ze bij stap 1 erin.', 'Loop daarna de andere stappen van de maandronde na (hooguit tien minuten).'],
    waar: 'overal', prive: false, duur_min: 10, volgorde: 40,
    herkomst: { handmatig: 'ghawa-maandronde', maand: m, module: 'ghawa', doel: { scherm: 'ghawa', focus: 'ronde' } } };
}

module.exports = { REK_GHAWA, ECG_REK, SOORT_ONBEKEND, FONDS_STATUS, RONDE_STAPPEN, AFVINKBAAR, BIJ_TABELLEN, SCHEMA_BIJ, migreer, fase2Gegevens,
  leesFacturen, bankBij, deelInGhawa, leerKaart, indelen, datumEco, centEco, leesEcgCsv, leesEcgPdfTekst, pdfNaarTekst, deelInEcg, ecgAfschrift,
  koppelStromen, fondsZet, rondeZet, rondeKaart, maandVan, dagen, ibanUit };
