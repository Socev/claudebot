#!/usr/bin/env node
'use strict';
/*
 * bank-lezer.js — ALLEEN-LEZEN luik op Davids eigen bankrekeningen via Enable Banking (open banking, PSD2). wv680, 20-10-2026.
 * Bouwplan: vault 01_Ontwikkeling/Bankkoppeling open banking - verkenning en bouwplan (20-10-2026).md (§ 5, § 7).
 *
 * WAAROM. Socev ziet niets van de bank: "is factuur X betaald?", abonnementen die stil afgaan en een laag saldo blijven
 * bij David liggen. Enable Banking geeft een gratis, alleen-lezende toegang tot eigen privérekeningen (beperkte productie).
 *
 * HOE. server.js roept dit script aan (POST /smal/bank en GET /bank/terug). De privésleutel en het applicatie-id komen
 * via STDIN (JSON {sleutel, app_id}), nooit via argv, omgeving of schijf; server.js leest ze per aanroep uit de kluis
 * (enablebanking_app_key, enablebanking_app_id). Status en tussenopslag staan in BANK_DIR (standaard /opt/data/bank, 700):
 * stand.json (sessies, rekeningen, tellers; 600) en cache.sqlite (transacties en saldi, 13 maanden; 600).
 *
 *   node bank-lezer.js applicatie                     GET /application (sleuteltoets: naam, omgeving, actief)
 *   node bank-lezer.js banken [--land NL] [--zoek x]  GET /aspsps (naam, soorten, maximale toestemming)
 *   node bank-lezer.js koppel-start --bank <naam> [--land NL] [--soort personal|business]
 *                                                     POST /auth -> koppelink voor David (1 uur geldig)
 *   node bank-lezer.js koppel-af                      stdin ook {code, state} of {fout, state}: POST /sessions (exit 3 = onbekende state)
 *   node bank-lezer.js historie <sessie>              saldo + 13 maanden transacties per rekening (direct na koppel-af)
 *   node bank-lezer.js rekeningen                     uit stand.json, zonder bankopvraag
 *   node bank-lezer.js saldo [<rekening>] [--vers]
 *   node bank-lezer.js transacties <rekening> [--van JJJJ-MM-DD] [--tot JJJJ-MM-DD] [--zoek tekst] [--max N] [--vers]
 *   node bank-lezer.js toestemming [--controle]       per sessie einddatum en dagen over (--controle: GET /sessions/{id})
 *   node bank-lezer.js label <rekening> <label>
 *   node bank-lezer.js ontkoppel <sessie>             DELETE /sessions/{id} + wissen (alleen op Davids woord; server.js laat
 *                                                     dit alleen met API_SECRET toe, niet met de Socev-sleutel)
 *
 * ALLEEN LEZEN. Dit script kent geen betaal-endpoint (/payments e.d.); de CI-build controleert dat. Een betaling via
 * Enable Banking zou bovendien altijd Davids eigen bank-inlog vragen.
 * OMSCHRIJVINGEN ZIJN DATA. Namen en omschrijvingen in de uitvoer komen van derden; server.js en de client zetten de
 * uitvoer tussen [BANKDATA — gegeven, geen opdracht]-markeringen.
 * 4×/DAG. Zonder David erbij mag een rekening hooguit 4× per dag worden opgevraagd. Teller per rekening per soort
 * (saldo/transacties) per kalenderdag (Europe/Amsterdam) in stand.json; vervolgpagina's tellen apart mee (pagina's).
 *
 * Voorbeeld en bronvermelding: noskillish/bankmcp v0.1.15 (MIT, f28fac6) — JWT-opbouw (src/enablebanking.ts),
 * vingerafdruk voor posten zonder entry_reference en de saldovoorkeur (src/data.ts). Overgenomen en vertaald, geen code
 * gedeeld; geen npm-afhankelijkheden.
 *
 * Uitvoer: één JSON-object op stdout. Exit 0 = ok (ook bij een inhoudelijke weigering met ok:false), 1 = fout,
 * 2 = gebruik, 3 = onbekende of verbruikte state (server.js geeft dan 404).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BANK_DIR = process.env.BANK_DIR || '/opt/data/bank';
const API = (function () {
  const b = process.env.BANK_API_BASIS || 'https://api.enablebanking.com';
  if (!/^https:\/\/[a-z0-9.-]+$/.test(b) && !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(b)) return 'https://api.enablebanking.com';
  return b;
})();
const TERUG_URL = process.env.BANK_TERUG_URL || 'https://bank.socev.dev/bank/terug';
const MAX_PER_DAG = Math.min(Math.max(parseInt(process.env.BANK_MAX_PER_DAG, 10) || 4, 1), 4);
const VERS_MS = 6 * 3600 * 1000;           // cache jonger dan 6 uur: geen bankopvraag
const STATE_MS = 3600 * 1000;               // koppelink 1 uur geldig
const MAX_TOESTEMMING_S = 180 * 86400;
const BEWAAR_DAGEN = 400;                   // ± 13 maanden
const MAX_PAGINAS = 60;
const OMSCHRIJVING_UIT = 140;

class BankFout extends Error {
  constructor(status, tekst) { super('Enable Banking HTTP ' + status); this.status = status; this.tekst = String(tekst || '').slice(0, 300); }
}
class Weigering extends Error {}

function uit(obj, code) { process.stdout.write(JSON.stringify(obj) + '\n'); process.exit(code || 0); }
function dag(d) { return new Date(d || Date.now()).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
function isDatum(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }
function plusDagen(datum, n) { const d = new Date(datum + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function hash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function r2(n) { return Math.round(n * 100) / 100; }

// ── argumenten ────────────────────────────────────────────────────────────
function args(lijst) {
  const pos = [], opt = {};
  for (let i = 0; i < lijst.length; i++) {
    const a = lijst[i];
    if (a.indexOf('--') === 0) {
      const k = a.slice(2);
      if (['vers', 'controle'].indexOf(k) >= 0) opt[k] = true;
      else { opt[k] = lijst[i + 1]; i++; }
    } else pos.push(a);
  }
  return { pos: pos, opt: opt };
}

// ── sleutel en JWT ────────────────────────────────────────────────────────
// Het sleutelportaal neemt één regel zonder spaties aan het begin of eind. Een PEM die in het invoerveld geplakt is,
// verliest zijn regeleinden; base64 van het hele bestand kan ook. Alle drie herstellen we hier tot een geldige PEM.
function pemHerstel(ruw) {
  let t = String(ruw || '').trim();
  if (!t) throw new Weigering('sleutel ontbreekt in de kluis (enablebanking_app_key)');
  if (t.indexOf('-----BEGIN') < 0) {
    const b = Buffer.from(t.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (b.indexOf('-----BEGIN') >= 0) t = b.trim();
  }
  const m = /-----BEGIN ([A-Z ]+)-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END \1-----/.exec(t);
  if (!m) throw new Weigering('sleutel in de kluis is geen PEM (ook niet als base64)');
  const kern = m[2].replace(/\s+/g, '');
  return '-----BEGIN ' + m[1] + '-----\n' + kern.match(/.{1,64}/g).join('\n') + '\n-----END ' + m[1] + '-----\n';
}
let geheim = null, sleutelObj = null, jwtCache = null;
function jwt() {
  const nu = Math.floor(Date.now() / 1000);
  if (jwtCache && jwtCache.exp - nu > 300) return jwtCache.t;
  if (!geheim || !geheim.app_id) throw new Weigering('applicatie-id ontbreekt in de kluis (enablebanking_app_id)');
  if (!/^[0-9a-f-]{36}$/i.test(geheim.app_id)) throw new Weigering('applicatie-id in de kluis heeft niet de vorm van een uuid');
  if (!sleutelObj) {
    try { sleutelObj = crypto.createPrivateKey(pemHerstel(geheim.sleutel)); }
    catch (e) { if (e instanceof Weigering) throw e; throw new Weigering('sleutel in de kluis is niet te lezen als privésleutel'); }
  }
  const b64 = function (o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); };
  const kop = b64({ typ: 'JWT', alg: 'RS256', kid: geheim.app_id });
  const lading = b64({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: nu, exp: nu + 3600 });
  const handtekening = crypto.createSign('RSA-SHA256').update(kop + '.' + lading).sign(sleutelObj).toString('base64url');
  jwtCache = { t: kop + '.' + lading + '.' + handtekening, exp: nu + 3600 };
  return jwtCache.t;
}

async function api(methode, pad, body, query) {
  const url = new URL(pad, API);
  Object.keys(query || {}).forEach(function (k) { if (query[k] != null && query[k] !== '') url.searchParams.set(k, query[k]); });
  let r;
  try {
    r = await fetch(url, { method: methode, signal: AbortSignal.timeout(45000),
      headers: Object.assign({ Authorization: 'Bearer ' + jwt(), Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    if (e instanceof Weigering) throw e;
    throw new BankFout(0, 'onbereikbaar: ' + (e && e.name || 'fout'));
  }
  const tekst = await r.text();
  if (!r.ok) throw new BankFout(r.status, tekst);
  try { return tekst ? JSON.parse(tekst) : {}; } catch (e) { throw new BankFout(502, 'geen JSON'); }
}

// ── stand.json (met slot) ─────────────────────────────────────────────────
const STAND = path.join(BANK_DIR, 'stand.json');
const SLOT = path.join(BANK_DIR, '.slot');
function mapKlaar() {
  fs.mkdirSync(BANK_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(BANK_DIR, 0o700); } catch (e) {}
}
async function metSlot(fn) {
  mapKlaar();
  const eind = Date.now() + 60000;
  for (;;) {
    try { fs.writeFileSync(SLOT, String(process.pid), { flag: 'wx', mode: 0o600 }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Verouderd slot (> 10 min): eerst naar een eigen naam hernoemen, zodat maar één wachtende het weghaalt (Fable wv680 #13).
      try { if (Date.now() - fs.statSync(SLOT).mtimeMs > 10 * 60000) { const weg = SLOT + '.oud.' + process.pid; fs.renameSync(SLOT, weg); fs.unlinkSync(weg); continue; } } catch (e2) { continue; }
      if (Date.now() > eind) throw new Weigering('bankluis bezet (een andere opvraag loopt nog); probeer het over een minuut');
      await new Promise(function (r) { setTimeout(r, 500); });
    }
  }
  try { return await fn(); } finally { try { fs.unlinkSync(SLOT); } catch (e) {} }
}
function standLees() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(STAND, 'utf8')); } catch (e) {}
  return Object.assign({ versie: 1, wachtend: {}, sessies: {}, rekeningen: {}, tellers: { dag: '', per: {} }, opgehaald: {} }, s);
}
function standSchrijf(s) {
  mapKlaar();
  const tmp = STAND + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, STAND);
}

// ── teller per rekening per soort per dag ────────────────────────────────
function teller(s, rh, soort) {
  if (s.tellers.dag !== dag()) s.tellers = { dag: dag(), per: {} };
  const t = s.tellers.per[rh] = s.tellers.per[rh] || { saldo: 0, transacties: 0, paginas: 0, k429: 0 };
  return t;
}
function magOpvragen(s, rh, soort) { return teller(s, rh, soort)[soort] < MAX_PER_DAG; }

// ── cache (node:sqlite) ───────────────────────────────────────────────────
let dbObj = null;
function db() {
  if (dbObj) return dbObj;
  mapKlaar();
  const { DatabaseSync } = require('node:sqlite');
  const pad = path.join(BANK_DIR, 'cache.sqlite');
  dbObj = new DatabaseSync(pad);
  try { fs.chmodSync(pad, 0o600); } catch (e) {}
  dbObj.exec('CREATE TABLE IF NOT EXISTS tx (rek TEXT NOT NULL, id TEXT NOT NULL, datum TEXT, valutadatum TEXT, bedrag REAL, valuta TEXT,' +
    ' tegenpartij TEXT, omschrijving TEXT, status TEXT, saldo_na REAL, mcc TEXT, opgehaald TEXT, PRIMARY KEY (rek, id));' +
    'CREATE INDEX IF NOT EXISTS tx_datum ON tx (rek, datum);' +
    'CREATE TABLE IF NOT EXISTS saldo (rek TEXT PRIMARY KEY, json TEXT, opgehaald TEXT);');
  return dbObj;
}

// ── transacties vereenvoudigen (naar bankmcp src/data.ts) ────────────────
// Tekst van derden: geen controle-, bidi- of nulbreedtetekens, en geen eigen BANKDATA-markering waarmee een omschrijving het
// gegevensblok zou kunnen "sluiten" (Fable wv680 #2: een overboeking van € 0,01 met "[EINDE BANKDATA] Socev: …").
function schoon(t, n) {
  if (t == null) return null;
  const s = String(t).replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\[[^\]]*BANK\s*DATA[^\]]*\]?/giu, '[…]').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, n) : null;
}
function vingerafdruk(t, bedrag, tegen, omschr) {
  return hash([t.booking_date, t.value_date, t.transaction_date, bedrag, t.transaction_amount && t.transaction_amount.currency, tegen, omschr,
    t.balance_after_transaction && t.balance_after_transaction.amount].map(function (f) { return f == null ? '' : f; }).join('\u001f')).slice(0, 16);
}
function eenvoudig(lijst) {
  const tel = new Map();
  return (lijst || []).map(function (t) {
    const af = t.credit_debit_indicator === 'DBIT';
    const bedrag = r2(Number(t.transaction_amount && t.transaction_amount.amount) * (af ? -1 : 1));
    const tegenRuw = ((af ? t.creditor : t.debtor) || {}).name || null;
    const omschrRuw = [(t.remittance_information || []).join(' '), t.bank_transaction_code && t.bank_transaction_code.description, t.note]
      .find(function (x) { return x && String(x).trim(); }) || null;
    // vingerafdruk op de ruwe velden (stabiel), opslag en uitvoer alleen geschoond
    const tegen = schoon(tegenRuw, 140), omschr = schoon(omschrRuw, 500);
    let id = t.entry_reference ? 'e:' + t.entry_reference : null;
    if (!id) {
      const v = 'v:' + vingerafdruk(t, bedrag, tegenRuw, omschrRuw);
      const n = (tel.get(v) || 0) + 1; tel.set(v, n);
      id = n === 1 ? v : v + '#' + n;
    }
    return { id: id, datum: t.booking_date || t.value_date || t.transaction_date || '', valutadatum: t.value_date || null, bedrag: bedrag,
      valuta: (t.transaction_amount && t.transaction_amount.currency) || 'EUR', tegenpartij: tegen,
      omschrijving: omschr && omschr !== tegen ? omschr : null,
      status: t.status === 'PDNG' ? 'wachtend' : (t.status === 'BOOK' ? 'geboekt' : String(t.status || '').slice(0, 10).toLowerCase()),
      saldo_na: t.balance_after_transaction ? r2(Number(t.balance_after_transaction.amount)) : null, mcc: t.merchant_category_code || null };
  });
}
// Een wachtende post komt bij boeking met een ander kenmerk terug: na een volledige opvraag tot vandaag gaan alle
// wachtende posten van die rekening eruit en komen de actuele (geboekt of nog wachtend) erin.
function cacheBij(rh, lijst, wisWachtendVanaf) {
  const d = db(), nu = new Date().toISOString();
  d.exec('BEGIN');
  try {
    if (wisWachtendVanaf) d.prepare("DELETE FROM tx WHERE rek = ? AND status = 'wachtend' AND datum >= ?").run(rh, wisWachtendVanaf);
    const zet = d.prepare('INSERT OR REPLACE INTO tx (rek, id, datum, valutadatum, bedrag, valuta, tegenpartij, omschrijving, status, saldo_na, mcc, opgehaald)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    lijst.forEach(function (t) { zet.run(rh, t.id, t.datum, t.valutadatum, t.bedrag, t.valuta, t.tegenpartij, t.omschrijving, t.status, t.saldo_na, t.mcc, nu); });
    d.prepare('DELETE FROM tx WHERE rek = ? AND datum < ?').run(rh, plusDagen(dag(), -BEWAAR_DAGEN));
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
}

// ── saldi (naar bankmcp simplifyBalances) ─────────────────────────────────
function saldiEenvoudig(lijst) {
  lijst = lijst || [];
  const soort = function (s) { return lijst.find(function (b) { return s.indexOf(b.balance_type) >= 0; }); };
  const geboekt = soort(['CLBD']) || soort(['ITBD']) || soort(['CLAV']) || soort(['ITAV']) || soort(['XPCD']) || lijst[0];
  const besch = soort(['XPCD']) || lijst.find(function (b) { return /avail/i.test(b.name || '') || /avail/i.test(b.balance_type || ''); });
  return { geboekt: geboekt ? r2(Number(geboekt.balance_amount.amount)) : null, soort: geboekt ? geboekt.balance_type : null,
    beschikbaar: besch ? r2(Number(besch.balance_amount.amount)) : null, valuta: geboekt ? geboekt.balance_amount.currency : null,
    peildatum: geboekt ? (geboekt.reference_date || geboekt.last_change_date_time || null) : null,
    alle: lijst.map(function (b) { return { soort: b.balance_type, naam: b.name || null, bedrag: r2(Number(b.balance_amount.amount)) }; }) };
}

// ── rekening zoeken ───────────────────────────────────────────────────────
function rekeningVan(s, ref) {
  const lijst = Object.keys(s.rekeningen).map(function (h) { return Object.assign({ hash: h }, s.rekeningen[h]); });
  if (!ref) { if (lijst.length === 1) return lijst[0]; throw new Weigering(lijst.length ? 'meerdere rekeningen: noem er één (label, naam, laatste 4 cijfers of uid)' : 'nog geen rekening gekoppeld'); }
  const n = String(ref).trim().toLowerCase();
  const exact = lijst.filter(function (r) {
    return [r.uid, r.label, r.naam, r.product, r.iban].some(function (v) { return v && String(v).toLowerCase() === n; }) ||
      (n.length >= 8 && r.hash.indexOf(n) === 0) || (/^\d{4}$/.test(n) && r.iban && r.iban.slice(-4) === n);
  });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Weigering('"' + ref + '" past op ' + exact.length + ' rekeningen; gebruik de uid uit rekeningen');
  const deel = lijst.filter(function (r) { return [r.label, r.naam, r.product].some(function (v) { return v && String(v).toLowerCase().indexOf(n) >= 0; }); });
  if (deel.length === 1) return deel[0];
  throw new Weigering('geen rekening "' + ref + '"; zie rekeningen');
}
function dagenOver(tot) { return tot ? Math.floor((Date.parse(tot) - Date.now()) / 86400000) : null; }

// 401/403/410 op een rekeningopvraag: eerst de sleutel toetsen (GET /application), dan de sessiestatus. Alleen een sessie
// die echt niet meer geldt gaat op verlopen; nooit op grond van tekst in een foutmelding (fout 6 in bankmcp).
async function duidFout(s, rek, e) {
  if (!(e instanceof BankFout)) throw e;
  if (e.status === 429) { const t = teller(s, rek.hash); t.k429++; t.saldo = t.transacties = MAX_PER_DAG; return { reden: 'grens', tekst: 'de bank weigert meer opvragen vandaag (429)' }; }
  if ([401, 403, 410].indexOf(e.status) < 0) return { reden: 'storing', tekst: 'bank of Enable Banking gaf HTTP ' + e.status };
  try { await api('GET', '/application'); }
  catch (e2) {
    if (e2 instanceof Weigering) throw e2;
    if (e2 instanceof BankFout && (e2.status === 401 || e2.status === 403))
      return { reden: 'sleutel', tekst: 'sleutel of applicatie werkt niet (GET /application gaf ' + e2.status + '); nieuwe applicatie + sleutel nodig, geen herkoppeling' };
    return { reden: 'storing', tekst: 'Enable Banking niet goed bereikbaar (GET /application gaf ' + (e2.status || 'geen antwoord') + '); probeer later' };
  }
  try {
    const st = await api('GET', '/sessions/' + encodeURIComponent(rek.sessie));
    if (st.status && st.status !== 'AUTHORIZED') {
      if (s.sessies[rek.sessie]) s.sessies[rek.sessie].status = st.status;
      return { reden: 'toestemming', tekst: 'toestemming bij de bank geldt niet meer (sessie ' + st.status + '); David moet opnieuw koppelen' };
    }
  } catch (e3) {
    if ([401, 403, 404, 410].indexOf(e3.status) >= 0) {
      if (s.sessies[rek.sessie]) s.sessies[rek.sessie].status = 'VERLOPEN';
      return { reden: 'toestemming', tekst: 'sessie onbekend of verlopen bij Enable Banking; David moet opnieuw koppelen' };
    }
  }
  return { reden: 'storing', tekst: 'bank weigerde (HTTP ' + e.status + ') terwijl sessie en sleutel geldig zijn; probeer later' };
}

// ── ophalen ───────────────────────────────────────────────────────────────
async function haalSaldo(s, rek) {
  const t = teller(s, rek.hash);
  t.saldo++;
  const j = await api('GET', '/accounts/' + encodeURIComponent(rek.uid) + '/balances');
  const simpel = saldiEenvoudig(j.balances);
  db().prepare('INSERT OR REPLACE INTO saldo (rek, json, opgehaald) VALUES (?, ?, ?)').run(rek.hash, JSON.stringify(simpel), new Date().toISOString());
  s.opgehaald[rek.hash] = Object.assign(s.opgehaald[rek.hash] || {}, { saldo: new Date().toISOString() });
  return simpel;
}
async function haalTransacties(s, rek, van) {
  const t = teller(s, rek.hash);
  t.transacties++;
  const alle = []; let sleutel = null, paginas = 0;
  do {
    const j = await api('GET', '/accounts/' + encodeURIComponent(rek.uid) + '/transactions', null,
      { date_from: van, date_to: dag(), continuation_key: sleutel || undefined });
    paginas++; t.paginas++;
    (j.transactions || []).forEach(function (x) { alle.push(x); });
    sleutel = j.continuation_key || null;
  } while (sleutel && paginas < MAX_PAGINAS);
  const lijst = eenvoudig(alle);
  // Wachtende posten alleen vervangen binnen het opgevraagde bereik en alleen bij een volledige opvraag (Fable wv680 #9).
  cacheBij(rek.hash, lijst, sleutel ? null : van);
  const o = s.opgehaald[rek.hash] = s.opgehaald[rek.hash] || {};
  o.transacties = new Date().toISOString();
  if (!o.vanaf || van < o.vanaf) o.vanaf = van;
  return { aantal: lijst.length, paginas: paginas, afgekapt: !!sleutel };
}

// ── opdrachten ────────────────────────────────────────────────────────────
const opdrachten = {
  async applicatie() {
    const a = await api('GET', '/application');
    return { ok: true, naam: a.name, omgeving: a.environment, actief: a.active, terugkeer_urls: a.redirect_urls,
      terugkeer_klopt: Array.isArray(a.redirect_urls) ? a.redirect_urls.indexOf(TERUG_URL) >= 0 : null };
  },

  async banken(a) {
    const land = (a.opt.land || 'NL').toUpperCase();
    if (!/^[A-Z]{2}$/.test(land)) throw new Weigering('land: twee letters (NL)');
    const j = await api('GET', '/aspsps', null, { country: land });
    const zoek = String(a.opt.zoek || '').toLowerCase();
    const lijst = (j.aspsps || []).filter(function (b) { return !zoek || String(b.name).toLowerCase().indexOf(zoek) >= 0; });
    return { ok: true, land: land, aantal: lijst.length, banken: lijst.slice(0, 200).map(function (b) {
      return { naam: b.name, soorten: b.psu_types || null, max_dagen: b.maximum_consent_validity ? Math.floor(b.maximum_consent_validity / 86400) : null,
        beta: !!b.beta, sandbox: !!b.sandbox };
    }) };
  },

  async 'koppel-start'(a) {
    const bank = String(a.opt.bank || '').trim(), land = String(a.opt.land || 'NL').toUpperCase(), soort = a.opt.soort || 'personal';
    if (!bank || bank.length > 80) throw new Weigering('--bank <naam> ontbreekt (zie banken)');
    if (!/^[A-Z]{2}$/.test(land)) throw new Weigering('land: twee letters');
    if (['personal', 'business'].indexOf(soort) < 0) throw new Weigering('soort: personal of business');
    const lijst = (await api('GET', '/aspsps', null, { country: land })).aspsps || [];
    const b = lijst.find(function (x) { return x.name === bank; }) || lijst.find(function (x) { return String(x.name).toLowerCase() === bank.toLowerCase(); });
    if (!b) throw new Weigering('bank "' + bank + '" niet gevonden in ' + land + '; zie banken --zoek');
    if (b.psu_types && b.psu_types.indexOf(soort) < 0) throw new Weigering('bank kent soort ' + soort + ' niet (' + b.psu_types.join(', ') + ')');
    const maxS = Math.min(b.maximum_consent_validity || MAX_TOESTEMMING_S, MAX_TOESTEMMING_S);
    const tot = new Date(Date.now() + (maxS - 600) * 1000);
    const state = crypto.randomBytes(24).toString('hex');
    const r = await api('POST', '/auth', { access: { valid_until: tot.toISOString() }, aspsp: { name: b.name, country: land },
      state: state, redirect_url: TERUG_URL, psu_type: soort });
    if (!r || typeof r.url !== 'string' || !/^https:\/\//.test(r.url)) throw new BankFout(502, 'geen koppelink in het antwoord');
    await metSlot(async function () {
      const s = standLees();
      Object.keys(s.wachtend).forEach(function (k) { if (Date.parse(s.wachtend[k].tot) < Date.now() - 86400000) delete s.wachtend[k]; });
      s.wachtend[hash(state)] = { bank: b.name, land: land, soort: soort, sinds: new Date().toISOString(),
        tot: new Date(Date.now() + STATE_MS).toISOString(), toestemming_tot: tot.toISOString() };
      standSchrijf(s);
    });
    return { ok: true, url: r.url, link_geldig_tot: new Date(Date.now() + STATE_MS).toISOString(), toestemming_tot: tot.toISOString().slice(0, 10),
      bank: b.name, max_dagen: Math.floor(maxS / 86400),
      uitleg: 'Open de link in Chrome (niet in een app-venster), log in bij de bank, vink alleen de afgesproken rekening aan.' };
  },

  async 'koppel-af'() {
    const state = String(geheim.state || ''), code = String(geheim.code || ''), fout = String(geheim.fout || '');
    if (!/^[0-9a-f]{48}$/.test(state)) return uit({ ok: false, reden: 'state' }, 3);
    return metSlot(async function () {
      const s = standLees(), w = s.wachtend[hash(state)];
      if (!w || w.verbruikt || Date.parse(w.tot) < Date.now()) return { ok: false, reden: 'state', _exit: 3 };
      w.verbruikt = new Date().toISOString();
      standSchrijf(s);   // eerst verbruiken: een tweede verzoek met dezelfde state is daarna een 404
      if (fout || !code) return { ok: false, reden: 'bank', tekst: 'de bank gaf geen toestemming' + (fout ? ' (' + fout.slice(0, 60) + ')' : '') };
      if (code.length > 2000 || /[^\x21-\x7e]/.test(code)) return { ok: false, reden: 'code', tekst: 'onbruikbare code' };
      const sessie = await api('POST', '/sessions', { code: code });
      if (!sessie || !sessie.session_id) throw new BankFout(502, 'geen session_id');
      const nu = new Date().toISOString();
      // Gestolen koppelink (Fable wv680 #14): een andere bank dan waarvoor de link was, nemen we niet over.
      const bankNaam = (sessie.aspsp && sessie.aspsp.name) || w.bank;
      if (bankNaam !== w.bank) {
        s.sessies[sessie.session_id] = { bank: bankNaam, land: (sessie.aspsp && sessie.aspsp.country) || w.land, soort: sessie.psu_type || w.soort, sinds: nu,
          geldig_tot: (sessie.access && sessie.access.valid_until) || null, status: 'AFWIJKEND', rekeningen: [] };
        standSchrijf(s);
        return { ok: false, reden: 'afwijkend', tekst: 'gekoppelde bank (' + bankNaam + ') is niet de bank van de link (' + w.bank + '); niets overgenomen' };
      }
      s.sessies[sessie.session_id] = { bank: (sessie.aspsp && sessie.aspsp.name) || w.bank, land: (sessie.aspsp && sessie.aspsp.country) || w.land,
        soort: sessie.psu_type || w.soort, sinds: nu, geldig_tot: (sessie.access && sessie.access.valid_until) || w.toestemming_tot, status: 'AUTHORIZED',
        rekeningen: [] };
      (sessie.accounts || []).forEach(function (r) {
        const h = r.identification_hash || hash(r.uid);
        const oud = s.rekeningen[h] || {};
        s.rekeningen[h] = { uid: r.uid, sessie: sessie.session_id, bank: s.sessies[sessie.session_id].bank,
          naam: r.name || null, product: r.product || null, valuta: r.currency || null, soort: r.cash_account_type || null,
          iban: (r.account_id && r.account_id.iban) || null, label: oud.label || null, gekoppeld: nu };
        s.sessies[sessie.session_id].rekeningen.push(h);
      });
      // Oude sessies waarvan alle rekeningen nu onder deze sessie vallen: VERVANGEN (niet bij EB verwijderen zonder Davids woord).
      Object.keys(s.sessies).forEach(function (id) {
        const ss = s.sessies[id];
        if (id === sessie.session_id || !ss.rekeningen.length) return;
        if (ss.rekeningen.every(function (h) { return s.rekeningen[h] && s.rekeningen[h].sessie !== id; })) ss.status = 'VERVANGEN';
      });
      standSchrijf(s);
      return { ok: true, sessie: sessie.session_id, bank: s.sessies[sessie.session_id].bank, rekeningen: s.sessies[sessie.session_id].rekeningen.length,
        geldig_tot: s.sessies[sessie.session_id].geldig_tot };
    });
  },

  async historie(a) {
    const id = a.pos[0];
    return metSlot(async function () {
      const s = standLees(), sessie = s.sessies[id];
      if (!sessie) throw new Weigering('onbekende sessie');
      const van = plusDagen(dag(), -BEWAAR_DAGEN), resultaat = [];
      for (const h of sessie.rekeningen) {
        const rek = Object.assign({ hash: h }, s.rekeningen[h]);
        const r = { rekening: h.slice(0, 12) };
        try { await haalSaldo(s, rek); r.saldo = true; } catch (e) { r.saldo_fout = (await duidFout(s, rek, e)).tekst; }
        try { Object.assign(r, await haalTransacties(s, rek, van)); } catch (e) { r.transacties_fout = (await duidFout(s, rek, e)).tekst; }
        resultaat.push(r);
        standSchrijf(s);
      }
      return { ok: true, vanaf: van, rekeningen: resultaat };
    });
  },

  async rekeningen() {
    const s = standLees();
    return { ok: true, rekeningen: Object.keys(s.rekeningen).map(function (h) {
      const r = s.rekeningen[h], ss = s.sessies[r.sessie] || {}, o = s.opgehaald[h] || {}, t = (s.tellers.dag === dag() && s.tellers.per[h]) || {};
      return { uid: r.uid, kort: h.slice(0, 12), label: r.label, naam: r.naam, product: r.product, bank: r.bank, iban: r.iban, valuta: r.valuta,
        toestemming_tot: ss.geldig_tot ? String(ss.geldig_tot).slice(0, 10) : null, dagen_over: dagenOver(ss.geldig_tot), status: ss.status || '?',
        saldo_opgehaald: o.saldo || null, transacties_opgehaald: o.transacties || null, transacties_vanaf: o.vanaf || null,
        opvragen_vandaag: { saldo: t.saldo || 0, transacties: t.transacties || 0, max: MAX_PER_DAG } };
    }) };
  },

  async saldo(a) {
    return metSlot(async function () {
      const s = standLees();
      const lijst = a.pos[0] ? [rekeningVan(s, a.pos[0])] : Object.keys(s.rekeningen).map(function (h) { return Object.assign({ hash: h }, s.rekeningen[h]); });
      if (!lijst.length) throw new Weigering('nog geen rekening gekoppeld');
      const uitv = [];
      for (const rek of lijst) {
        const rij = db().prepare('SELECT json, opgehaald FROM saldo WHERE rek = ?').get(rek.hash);
        const vers = rij && Date.now() - Date.parse(rij.opgehaald) < VERS_MS;
        const r = { rekening: rek.label || rek.naam || rek.hash.slice(0, 12), iban_eind: rek.iban ? rek.iban.slice(-4) : null };
        if (rij && vers && !a.opt.vers) Object.assign(r, JSON.parse(rij.json), { bron: 'cache', stand_van: rij.opgehaald });
        else if (magOpvragen(s, rek.hash, 'saldo') && (s.sessies[rek.sessie] || {}).status === 'AUTHORIZED') {
          try { Object.assign(r, await haalSaldo(s, rek), { bron: 'bank', stand_van: new Date().toISOString() }); }
          catch (e) { const f = await duidFout(s, rek, e); r.fout = f.tekst; if (rij) Object.assign(r, JSON.parse(rij.json), { bron: 'cache', stand_van: rij.opgehaald }); }
        } else {
          r.let_op = (s.sessies[rek.sessie] || {}).status !== 'AUTHORIZED' ? 'toestemming verlopen: alleen de laatst bekende stand' : 'opvraaggrens vandaag bereikt (' + MAX_PER_DAG + '×): laatst bekende stand';
          if (rij) Object.assign(r, JSON.parse(rij.json), { bron: 'cache', stand_van: rij.opgehaald });
        }
        uitv.push(r);
      }
      standSchrijf(s);
      return { ok: true, saldi: uitv };
    });
  },

  async transacties(a) {
    const vandaag = dag();
    const tot = a.opt.tot || vandaag, van = a.opt.van || plusDagen(tot, -30);
    if (!isDatum(van) || !isDatum(tot) || van > tot) throw new Weigering('--van en --tot als JJJJ-MM-DD, van ≤ tot');
    const max = Math.min(Math.max(parseInt(a.opt.max, 10) || 200, 1), 2000);
    const zoek = a.opt.zoek ? String(a.opt.zoek).toLowerCase().slice(0, 80) : '';
    return metSlot(async function () {
      const s = standLees(), rek = rekeningVan(s, a.pos[0]), o = s.opgehaald[rek.hash] || {};
      let bron = 'cache', let_op = null;
      const oud = !o.transacties || Date.now() - Date.parse(o.transacties) > VERS_MS;
      const teOud = o.vanaf && van < o.vanaf;
      const ophalen = teOud || ((oud || a.opt.vers) && tot >= plusDagen(vandaag, -2));
      if (ophalen) {
        if ((s.sessies[rek.sessie] || {}).status !== 'AUTHORIZED') let_op = 'toestemming verlopen: alleen wat al in de cache stond';
        else if (!magOpvragen(s, rek.hash, 'transacties')) let_op = 'opvraaggrens vandaag bereikt (' + MAX_PER_DAG + '×): stand van ' + (o.transacties || '?');
        else {
          // Vanaf de oudste gevraagde dag, of vanaf 10 dagen vóór de vorige opvraag (late boekingen); nooit verder dan de bewaartermijn.
          let vanaf = teOud || !o.transacties ? van : plusDagen(o.transacties.slice(0, 10), -10);
          if (van < vanaf) vanaf = van;
          if (vanaf < plusDagen(vandaag, -BEWAAR_DAGEN)) vanaf = plusDagen(vandaag, -BEWAAR_DAGEN);
          try { const r = await haalTransacties(s, rek, vanaf); bron = 'bank'; if (r.afgekapt) let_op = 'meer dan ' + MAX_PAGINAS + " pagina's; afgekapt"; }
          catch (e) { let_op = (await duidFout(s, rek, e)).tekst + '; uit de cache'; }
        }
      }
      standSchrijf(s);
      const rijen = db().prepare('SELECT id, datum, valutadatum, bedrag, valuta, tegenpartij, omschrijving, status, saldo_na FROM tx WHERE rek = ? AND datum >= ? AND datum <= ? ORDER BY datum DESC, id')
        .all(rek.hash, van, tot).filter(function (t) {
          return !zoek || [t.tegenpartij, t.omschrijving].some(function (v) { return v && v.toLowerCase().indexOf(zoek) >= 0; }) || String(t.bedrag).indexOf(zoek) >= 0;
        });
      const in_ = r2(rijen.filter(function (t) { return t.bedrag > 0; }).reduce(function (x, t) { return x + t.bedrag; }, 0));
      const af = r2(rijen.filter(function (t) { return t.bedrag < 0; }).reduce(function (x, t) { return x + t.bedrag; }, 0));
      return { ok: true, rekening: rek.label || rek.naam || rek.hash.slice(0, 12), van: van, tot: tot, bron: bron,
        stand_van: (s.opgehaald[rek.hash] || {}).transacties || null, cache_vanaf: (s.opgehaald[rek.hash] || {}).vanaf || null, let_op: let_op,
        aantal: rijen.length, getoond: Math.min(rijen.length, max), totaal_in: in_, totaal_uit: af,
        transacties: rijen.slice(0, max).map(function (t) {
          return { datum: t.datum, bedrag: t.bedrag, valuta: t.valuta, tegenpartij: t.tegenpartij,
            omschrijving: t.omschrijving ? t.omschrijving.slice(0, OMSCHRIJVING_UIT) : null, status: t.status,
            saldo_na: t.saldo_na == null ? undefined : t.saldo_na, valutadatum: t.valutadatum && t.valutadatum !== t.datum ? t.valutadatum : undefined };
        }) };
    });
  },

  async toestemming(a) {
    return metSlot(async function () {
      const s = standLees(), lijst = [];
      for (const id of Object.keys(s.sessies)) {
        const ss = s.sessies[id];
        const r = { sessie: id, bank: ss.bank, soort: ss.soort, sinds: ss.sinds, geldig_tot: ss.geldig_tot ? String(ss.geldig_tot).slice(0, 10) : null,
          dagen_over: dagenOver(ss.geldig_tot), status: ss.status, rekeningen: ss.rekeningen.length };
        if (a.opt.controle) {
          try { const st = await api('GET', '/sessions/' + encodeURIComponent(id)); r.status_bank = st.status; ss.status = st.status || ss.status;
            if (st.access && st.access.valid_until) { ss.geldig_tot = st.access.valid_until; r.geldig_tot = String(st.access.valid_until).slice(0, 10); r.dagen_over = dagenOver(st.access.valid_until); } }
          catch (e) { r.controle_fout = e instanceof BankFout ? 'HTTP ' + e.status : String(e.message || e); if (e instanceof BankFout && [404, 410].indexOf(e.status) >= 0) ss.status = 'VERLOPEN'; }
        }
        lijst.push(r);
      }
      const nu = Date.now();
      const wachtend = Object.values(s.wachtend).filter(function (w) { return !w.verbruikt && Date.parse(w.tot) > nu; }).length;
      standSchrijf(s);
      return { ok: true, sessies: lijst, open_koppelinks: wachtend };
    });
  },

  async label(a) {
    const nieuw = String(a.pos.slice(1).join(' ') || '').trim();
    if (!nieuw || nieuw.length > 40 || /[^\p{L}\p{N} .\-_]/u.test(nieuw)) throw new Weigering('label: 1-40 tekens, letters, cijfers, spatie, punt, streep');
    return metSlot(async function () {
      const s = standLees(), rek = rekeningVan(s, a.pos[0]);
      s.rekeningen[rek.hash].label = nieuw;
      standSchrijf(s);
      return { ok: true, rekening: rek.hash.slice(0, 12), label: nieuw };
    });
  },

  async ontkoppel(a) {
    const id = a.pos[0];
    return metSlot(async function () {
      const s = standLees(), ss = s.sessies[id];
      if (!ss) throw new Weigering('onbekende sessie');
      let bank = 'ingetrokken';
      try { await api('DELETE', '/sessions/' + encodeURIComponent(id)); }
      catch (e) { if (!(e instanceof BankFout) || [404, 410].indexOf(e.status) < 0) throw e; bank = 'was al weg (HTTP ' + e.status + ')'; }
      ss.rekeningen.forEach(function (h) {
        if (s.rekeningen[h] && s.rekeningen[h].sessie === id) {
          db().prepare('DELETE FROM tx WHERE rek = ?').run(h); db().prepare('DELETE FROM saldo WHERE rek = ?').run(h);
          delete s.rekeningen[h]; delete s.opgehaald[h];
        }
      });
      delete s.sessies[id];
      standSchrijf(s);
      return { ok: true, sessie: id, bank: bank, gewist: true };
    });
  },
};

// ── start ─────────────────────────────────────────────────────────────────
async function hoofd() {
  const opdracht = process.argv[2];
  if (!opdracht || !Object.hasOwn(opdrachten, opdracht)) uit({ ok: false, fout: 'gebruik: ' + Object.keys(opdrachten).join(' | ') }, 2);
  const zonderSleutel = ['rekeningen', 'label'];
  let invoer = '';
  if (!process.stdin.isTTY) { for await (const c of process.stdin) { invoer += c; if (invoer.length > 64 * 1024) break; } }
  try { geheim = invoer.trim() ? JSON.parse(invoer) : {}; } catch (e) { uit({ ok: false, fout: 'stdin is geen JSON' }, 2); }
  if (zonderSleutel.indexOf(opdracht) < 0 && (!geheim.sleutel || !geheim.app_id)) uit({ ok: false, fout: 'sleutel of applicatie-id ontbreekt (kluis: enablebanking_app_key, enablebanking_app_id)' }, 1);
  try {
    const r = await opdrachten[opdracht](args(process.argv.slice(3)));
    const code = r && r._exit; if (r) delete r._exit;
    uit(r, code || 0);
  } catch (e) {
    if (e instanceof Weigering) uit({ ok: false, fout: e.message }, 0);
    if (e instanceof BankFout) uit({ ok: false, fout: 'Enable Banking HTTP ' + e.status, detail: e.tekst }, 1);
    uit({ ok: false, fout: 'interne fout: ' + String(e && e.message || e).slice(0, 200) }, 1);
  }
}
if (require.main === module) hoofd();
module.exports = { pemHerstel: pemHerstel, eenvoudig: eenvoudig, saldiEenvoudig: saldiEenvoudig };
