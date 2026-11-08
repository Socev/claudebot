// financien-corrigeer.js — idee 6 uit Sure (wv2717; David 8-11-2026 08:18 "1 t/m 6"; alleen het idee, geen code of tekst uit Sure):
// zelf corrigeren in de App + nette winkelnamen. Ontwerp: vault "01_Ontwikkeling/Financiën - ideeën uit Sure (ontwerp 8-11-2026)" § 1c,
// review Codex ronde 1 NO-GO (MOET 1 transactie, MOET 2 regelbereik) en ronde 2 GO-MET-WIJZIGINGEN (MOET 1 regel samenvoegen), verwerkt.
//
// WAAROM. Categorie of eigenaar van een boeking aanpassen kon alleen via Socev (skill bank-lezen, corrigeer). Nu ook in de App, met "alleen
// deze" of "voortaan altijd" (een regel per tegenpartij en richting, zoals corrigeer al deed), "terug naar automatisch" per boeking en per
// regel, en een eigen weergavenaam per tegenpartij (alleen de weergave; de bankregel blijft).
//
// HOE. Een dunne laag op bank-archief.js (corrigeer, herstel, regelUit: herkomst david, david_velden, verrijking_historie, regels actief = 0;
// niets wordt verwijderd behalve een eigen naam, die alleen weergave is). Deze laag legt de grenzen van de App op: alleen bestaande
// categorieën (zonder 'intern') en eigenaren (zonder extern/POT), alleen posten op een zichtbare privérekening in euro, geen overboeking
// naar of van een gekoppelde eigen rekening, "voortaan altijd" niet bij een betaaldienst of eigen BV of zonder tegenpartij. Namen in tabel
// tegen_naam (sleutel = tpWoorden van financien-overzicht.js). Alleen via bank-lezer.js app-corrigeer (POST /app/financien/corrigeer,
// /herstel, /naam, /regels). Geen netwerk, geen taalmodel. IBAN's nooit in de uitvoer (alleen "IBAN …1234").
'use strict';
const crypto = require('crypto');
const FO = require('./financien-overzicht.js');

const EIGENAREN_APP = ['David', 'Cynthia', 'samen', 'kind', 'Gambia-hulp'];
const NAAM_MAX = 40, NAMEN_MAX = 300, VOORSTEL_MAX = 10;
const IBAN_VORM = /\b[A-Z]{2}\d{2}\s?(?:[A-Z0-9]{4}\s?){2,7}[A-Z0-9]{1,4}\b/i;

function veilig(s, n) { return String(s == null ? '' : s).normalize('NFC').replace(/[^\p{L}\p{N} .,&'()\-/+*—]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 40).trim(); }
function naamId(sleutel) { return crypto.createHash('sha256').update('naam:' + sleutel).digest('hex').slice(0, 16); }
function categorieenApp(A, a) { return A.categorieen(a).filter(function (c) { return c !== 'intern'; }); }
function keuzes(A, a) { return { categorieen: categorieenApp(A, a), eigenaren: EIGENAREN_APP.slice() }; }

// ── namen ──
function namenTabel(a) { a.db.exec('CREATE TABLE IF NOT EXISTS tegen_naam (sleutel TEXT PRIMARY KEY, naam TEXT NOT NULL, herkomst TEXT NOT NULL, aangemaakt TEXT NOT NULL)'); }
function namenLees(a) {
  const m = new Map();
  if (!a.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tegen_naam'").get()) return m;
  a.db.prepare('SELECT sleutel, naam FROM tegen_naam').all().forEach(function (r) { m.set(r.sleutel, r.naam); });
  return m;
}
// een eigen naam op vorm: 1-40 tekens, geen IBAN-vorm; null/'' = weg
function naamOpVorm(n) {
  if (n == null || String(n).trim() === '') return null;
  if (typeof n !== 'string') throw new Error('naam: tekst');
  if (IBAN_VORM.test(n.replace(/\s+/g, ' '))) throw new Error('naam: geen rekeningnummer');
  const v = veilig(n, NAAM_MAX + 1);
  if (!v || v.length > NAAM_MAX) throw new Error('naam: 1-' + NAAM_MAX + ' tekens');
  return v;
}
// alle tegenpartij-sleutels van de laatste 36 maanden op de zichtbare privérekeningen, met een banknaam en het aantal
function tegenpartijen(a, maanden) {
  const m = new Map();
  a.db.prepare("SELECT t.tegenpartij FROM transacties t JOIN rekeningen r ON r.rek = t.rek WHERE t.status IN ('booked', 'pending') AND t.tegenpartij IS NOT NULL" +
    " AND lower(coalesce(r.eigenaar, '')) NOT IN ('extern', 'pot') AND t.datum >= date('now', ?)").all('-' + (maanden || 36) + ' months').forEach(function (r) {
    const k = FO.tpWoorden(r.tegenpartij);
    if (!k) return;
    const x = m.get(k) || { sleutel: k, bank: veilig(FO.zonderIban(r.tegenpartij), 40), aantal: 0 };
    x.aantal++; m.set(k, x);
  });
  return m;
}
function naamZet(A, a, o) {
  if (!/^[a-f0-9]{16}$/.test(String(o && o.id || ''))) throw new Error('onbekende tegenpartij');
  const naam = naamOpVorm(o.naam);
  let hit = null;
  tegenpartijen(a, 36).forEach(function (x) { if (!hit && naamId(x.sleutel) === o.id) hit = x; });
  if (!hit) throw new Error('onbekende tegenpartij');
  namenTabel(a);
  if (naam === null) { a.db.prepare('DELETE FROM tegen_naam WHERE sleutel = ?').run(hit.sleutel); return { id: o.id, naam: null, bank: hit.bank }; }
  if (!a.db.prepare('SELECT 1 FROM tegen_naam WHERE sleutel = ?').get(hit.sleutel) && a.db.prepare('SELECT count(*) n FROM tegen_naam').get().n >= NAMEN_MAX) throw new Error('al ' + NAMEN_MAX + ' eigen namen');
  a.db.prepare("INSERT INTO tegen_naam (sleutel, naam, herkomst, aangemaakt) VALUES (?, ?, 'david', ?) ON CONFLICT (sleutel) DO UPDATE SET naam = excluded.naam, herkomst = 'david', aangemaakt = excluded.aangemaakt")
    .run(hit.sleutel, naam, new Date().toISOString());
  return { id: o.id, naam: naam, bank: hit.bank };
}
// voorstel voor een nette naam: de winkelketen of dienst uit financien-bijsturen.js, als die anders is dan de banknaam
function netteNaam(tegenpartij) {
  const B = require('./financien-bijsturen.js');
  const w = B.winkel({ tegenpartij: tegenpartij, omschrijving: '' });
  if (w && !/^andere winkels/.test(w)) return w;
  const t = String(tegenpartij || '').toLowerCase();
  const N = B.NETJES || {};
  const k = Object.keys(N).find(function (x) { return new RegExp('\\b' + x + '\\b').test(t); });
  return k ? N[k] : null;
}

// ── een post uit de App: bestaat, zichtbaar, euro, geen overboeking met een gekoppelde eigen rekening ──
function postApp(a, nr) {
  const n = parseInt(nr, 10);
  if (!(n > 0)) throw new Error('boeking ontbreekt');
  const t = a.db.prepare("SELECT t.nr, t.rek, t.bedrag, t.valuta, t.tegenpartij, t.status, coalesce(nullif(trim(t.tegen_iban), ''), CASE WHEN json_valid(t.ruwe_json) THEN json_extract(t.ruwe_json, CASE WHEN t.bedrag < 0 THEN '$.creditor_account.iban' ELSE '$.debtor_account.iban' END) END) AS tegen_iban," +
    " v.herkomst, v.regel_id, (SELECT p.rek FROM transacties p WHERE p.nr = v.intern_paar) AS paar_rek, lower(coalesce(r.eigenaar, '')) AS r_eig FROM transacties t JOIN rekeningen r ON r.rek = t.rek LEFT JOIN verrijking v ON v.nr = t.nr WHERE t.nr = ?").get(n);
  if (!t || (t.status !== 'booked' && t.status !== 'pending')) throw new Error('onbekende boeking');
  if (t.r_eig === 'extern' || t.r_eig === 'pot') throw new Error('deze rekening staat niet in Financiën');
  if (t.valuta && t.valuta !== 'EUR') throw new Error('alleen boekingen in euro');
  const zicht = a.db.prepare("SELECT rek, iban FROM rekeningen WHERE lower(coalesce(eigenaar, '')) NOT IN ('extern', 'pot')").all();
  const reks = new Set(zicht.map(function (r) { return r.rek; }));
  const ibans = new Set(zicht.filter(function (r) { return r.iban; }).map(function (r) { return String(r.iban).replace(/\s+/g, '').toUpperCase(); }));
  const ib = String(t.tegen_iban || '').replace(/\s+/g, '').toUpperCase();
  if ((t.paar_rek && reks.has(t.paar_rek)) || (ib && ibans.has(ib))) throw new Error('overboeking tussen twee eigen rekeningen: die telt niet als uitgave of inkomen');
  return t;
}
function altijdKan(tegenpartij) { return !!FO.tpWoorden(tegenpartij) && !FO.GEMENGD.test(String(tegenpartij || '')) && !FO.ENTITEIT.test(String(tegenpartij || '')); }

function corrigeerApp(A, a, o) {
  o = o || {};
  const t = postApp(a, o.nr), v = {};
  if (o.categorie != null) { if (categorieenApp(A, a).indexOf(o.categorie) < 0) throw new Error('onbekende categorie'); v.categorie = o.categorie; }
  if (o.eigenaar != null) { if (EIGENAREN_APP.indexOf(o.eigenaar) < 0) throw new Error('onbekende eigenaar'); v.eigenaar = o.eigenaar; }
  if (!Object.keys(v).length) throw new Error('kies een categorie of eigenaar');
  if (typeof o.altijd !== 'boolean') throw new Error('alleen deze of voortaan altijd?');
  if (o.altijd && !altijdKan(t.tegenpartij)) throw new Error('voortaan altijd kan niet bij een betaaldienst, je eigen BV of een boeking zonder naam; kies alleen deze');
  // een andere categorie: de oude subcategorie hoort er niet meer bij
  if (v.categorie) v.subcategorie = '';
  const r = A.corrigeer(a, Object.assign({ nr: t.nr, regel: o.altijd }, v));
  return { nr: t.nr, regel: r.regel || null, andere: r.andere_posten_bijgewerkt | 0 };
}
function herstelApp(A, a, o) {
  o = o || {};
  if (o.regel != null) {
    const id = parseInt(o.regel, 10);
    const g = id > 0 ? a.db.prepare("SELECT * FROM regels WHERE id = ? AND herkomst = 'david' AND actief = 1").get(id) : null;
    if (!g || regelAfgescheiden(A, a, g)) throw new Error('onbekende regel');
    const r = A.regelUit(a, { id: id });
    return { regel: id, posten: r.posten_bijgewerkt | 0 };
  }
  const t = postApp(a, o.nr);
  const r = A.herstel(a, { nr: t.nr });
  return { nr: t.nr, door: r.al_automatisch ? 'auto' : r.regel && (a.db.prepare('SELECT herkomst FROM regels WHERE id = ?').get(r.regel) || {}).herkomst === 'david' ? 'regel' : 'auto' };
}
// een regel op of over de POT of een externe rekening die alleen voor die rekening geldt, hoort niet in de App
function regelAfgescheiden(A, a, g) {
  const ext = A.externeRekeningen(a), pot = A.potRekeningen(a);
  if (g.rek && ext.has(g.rek)) return true;
  if ((g.soort === 'extern' || g.soort === 'intern') && pot.has(g.patroon)) return true;
  return false;
}

// ── Jouw regels: de regels en keuzes van David, de namen en de voorstellen ──
function regelsLijst(A, a) {
  const reks = new Map(a.db.prepare('SELECT * FROM rekeningen').all().map(function (r) { return [r.rek, r]; }));
  const rekNaam = function (rek) { const r = reks.get(rek); return r ? veilig(r.weergavenaam || r.label || r.naam, 30) || 'eigen rekening' : 'eigen rekening'; };
  const namen = namenLees(a);
  const voorbeeld = a.db.prepare('SELECT t.tegenpartij FROM transacties t WHERE t.nr = ?');
  const telV = a.db.prepare('SELECT count(*) n FROM verrijking WHERE regel_id = ?');
  const regels = a.db.prepare("SELECT * FROM regels WHERE herkomst = 'david' AND actief = 1 ORDER BY id DESC").all().filter(function (g) { return !regelAfgescheiden(A, a, g); }).map(function (g) {
    let wie;
    if (g.soort === 'tegenpartij') {
      const bron = g.bron_nr ? voorbeeld.get(g.bron_nr) : null, k = bron ? FO.tpWoorden(bron.tegenpartij) : '';
      wie = (k && namen.get(k)) || (bron ? veilig(FO.zonderIban(bron.tegenpartij), 40) : '') || g.patroon;
    } else if (g.soort === 'tegen_iban') wie = 'IBAN …' + String(g.patroon || '').slice(-4);
    else wie = rekNaam(g.patroon);
    return { id: g.id, wie: wie, soort: g.soort, richting: g.richting || null, categorie: g.categorie || null, eigenaar: g.eigenaar || null, sinds: String(g.aangemaakt || '').slice(0, 10), boekingen: telV.get(g.id).n };
  });
  const keuzes = a.db.prepare("SELECT t.nr, t.datum, t.bedrag, t.tegenpartij, v.categorie, v.eigenaar, v.david_velden, v.bijgewerkt FROM verrijking v JOIN transacties t ON t.nr = v.nr JOIN rekeningen r ON r.rek = t.rek" +
    " WHERE v.herkomst = 'david' AND lower(coalesce(r.eigenaar, '')) NOT IN ('extern', 'pot') ORDER BY v.bijgewerkt DESC, t.nr DESC LIMIT 50").all().map(function (x) {
    const k = FO.tpWoorden(x.tegenpartij), vast = String(x.david_velden || 'categorie,eigenaar').split(',');
    return { nr: x.nr, datum: x.datum, bedrag: x.bedrag, wie: (k && namen.get(k)) || veilig(FO.zonderIban(x.tegenpartij), 40) || 'zonder naam',
      categorie: vast.indexOf('categorie') >= 0 ? x.categorie : undefined, eigenaar: vast.indexOf('eigenaar') >= 0 ? x.eigenaar : undefined };
  });
  const tp = tegenpartijen(a, 12);
  const namenUit = [];
  namen.forEach(function (naam, k) { const x = tp.get(k); namenUit.push({ id: naamId(k), naam: naam, bank: x ? x.bank : null, aantal: x ? x.aantal : 0 }); });
  namenUit.sort(function (p, q) { return q.aantal - p.aantal || p.naam.localeCompare(q.naam); });
  const voorstellen = [];
  tp.forEach(function (x, k) {
    if (namen.has(k) || !x.bank) return;
    const n = netteNaam(x.bank);
    if (n && n.toLowerCase() !== x.bank.toLowerCase()) voorstellen.push({ id: naamId(k), bank: x.bank, naam: n, aantal: x.aantal });
  });
  voorstellen.sort(function (p, q) { return q.aantal - p.aantal || p.bank.localeCompare(q.bank); });
  return { regels: regels, keuzes: keuzes, namen: namenUit, voorstellen: voorstellen.slice(0, VOORSTEL_MAX), voorstellen_totaal: voorstellen.length };
}

module.exports = { corrigeerApp: corrigeerApp, herstelApp: herstelApp, naamZet: naamZet, regelsLijst: regelsLijst, namenLees: namenLees, naamId: naamId, netteNaam: netteNaam,
  altijdKan: altijdKan, keuzes: keuzes, naamOpVorm: naamOpVorm, EIGENAREN_APP: EIGENAREN_APP };
