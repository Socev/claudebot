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
 *   node bank-lezer.js ronde                          vaste ronde (wv685): saldo + nieuwe transacties per rekening, binnen 2 rondes
 *                                                     per dag en met 2 opvragen over voor David; alleen aantallen in de uitvoer
 *   node bank-lezer.js ontkoppel <sessie>             DELETE /sessions/{id} + wissen (alleen op Davids woord; server.js laat
 *                                                     dit alleen met API_SECRET toe, niet met de Socev-sleutel)
 *
 * TRANSACTIEDATABASE (wv687, bouwplan § 9c). Elke opgehaalde post gaat ook naar BANK_DIR/transacties.sqlite (bank-archief.js):
 * blijvend, nooit verwijderd, met ruwe JSON en een losse verrijking (type, categorie, eigenaar, interne overboeking,
 * abonnement). Leesopdrachten op dat archief (geen bankopvraag, geen sleutel nodig):
 *   node bank-lezer.js zoek [--tekst x] [--van] [--tot] [--rekening r] [--categorie c] [--eigenaar e] [--type t] [--max N]
 *   node bank-lezer.js maand [--maand JJJJ-MM] [--rekening r] [--eigenaar e]     per categorie in/uit, intern apart
 *   node bank-lezer.js intern [--van] [--tot] [--rekening r] [--max N]           overboekingen tussen eigen rekeningen
 *   node bank-lezer.js abonnementen [--alle]
 *   node bank-lezer.js vaste-lasten [--maand JJJJ-MM] [--rekening r]   vaste lasten per maand + verschil met de vorige stand + tabel_md (wv764)
 *   node bank-lezer.js stroom [--maand JJJJ-MM] [--rekening r]         overboekingen per rekeningpaar (vast/los), buffer en dekking (wv764)
 *   node bank-lezer.js corrigeer --nr N [--categorie c] [--subcategorie s] [--eigenaar e] [--type t] [--regel nee]
 *   node bank-lezer.js corrigeer --rekening r --eigenaar e                     eigenaar van een hele rekening
 *   node bank-lezer.js corrigeer --rekening r --categorie c [--subcategorie s] externe rekening (eigenaar extern, wv709): categorie
 *                                                                              van de overboekingen ernaartoe (die zijn een uitgave, geen intern)
 *   node bank-lezer.js archief                                                  alleen aantallen (mag in een rapport)
 *   node bank-lezer.js verrijk                                                  regels opnieuw toepassen (lokaal)
 *   node bank-lezer.js verrijk-open [--max N] / verrijk-zet (stdin {resultaten, model})   alleen server.js (AI-stap)
 * PayPal-laag (wv765, paypal-bewijs.js; bewijzen uit de ontvangstbewijzen in Gmail, gekoppeld aan de PayPal-posten):
 *   node bank-lezer.js paypal [--van] [--tot] [--dienst d] [--max N]            bewijzen met hun bankpost; posten zonder bewijs
 *   node bank-lezer.js paypal-diensten                                          vaste PayPal-diensten (ritme, bedrag, signalen)
 *   node bank-lezer.js paypal-bekend [--van]                                    alleen server.js: mail-id's die al bewaard zijn
 *   node bank-lezer.js paypal-bij (stdin {bewijzen, fouten, ronde})            alleen server.js: bewaren (idempotent) + koppelen
 * Historie voor het archief (alleen machinekamer via server.js):
 *   node bank-lezer.js historie bunq --volledig [--opgeheven] [--opnieuw]       alle bunq-posten ooit, per rekening onder eigen slot
 *   node bank-lezer.js historie abn-diep --van JJJJ-MM-DD                       ABN zo ver als de bank geeft (laat David er 2 over)
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
 * BUNQ (wv683, fase 2). Tweede bron naast Enable Banking: alle bunq-rekeningen via bunq's eigen API, alleen lezen. Alle
 * bunq-verkeer loopt via bunq-lezer.js (witte lijst: alleen GET op rekeningen en transacties, POST alleen /session-server,
 * responsehandtekening verplicht). Een bunq-rekening staat in stand.json met bron 'bunq' en uid 'bunq-<id>'; saldo komt
 * uit de rekeningenlijst (één opvraag voor alle rekeningen), transacties uit de payment-lijst. Opgeheven, bevroren en
 * verdwenen rekeningen standaard weg (--alle toont ze). Zelfde 4×/dag-teller, cache en BANKDATA-regels. Extra stdin-velden:
 * bunq_sleutel, bunq_sessie {token, tot}. Een nieuw sessietoken gaat terug in _bunq_sessie, een box-melding in _box;
 * server.js haalt beide uit de uitvoer. Interne overboekingen: tegen_iban (alleen in de cache) → veld intern in de uitvoer.
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
// wv685: vaste ronde (n8n AI - Bank-ronde 07:00 en 18:00 -> POST /bank-ronde -> opdracht ronde). Per rekening per soort per dag
// hooguit RONDE_PER_DAG rondes, en een ronde vraagt alleen op als David daarna nog RESERVE eigen opvragen overhoudt.
const RONDE_PER_DAG = 2;
const BUNQ_STOP = ['toegang', 'handtekening', 'sleutel', 'weigering'];   // ronde: na zo'n bunq-fout geen verdere bunq-opvragen
const RESERVE = 2;
const RONDE_VERS_MS = parseInt(process.env.BANK_RONDE_VERS_MS, 10) >= 0 ? parseInt(process.env.BANK_RONDE_VERS_MS, 10) : 2 * 3600 * 1000;   // jonger: niet opvragen (env alleen in de toets)

class BankFout extends Error {
  constructor(status, tekst) { super('Enable Banking HTTP ' + status); this.status = status; this.tekst = String(tekst || '').slice(0, 300); }
}
class Weigering extends Error {}

// Velden voor server.js (niet voor de sessie): een nieuw bunq-sessietoken en een box-melding. server.js haalt ze eruit.
const naarServer = {};
// Synchroon schrijven tot alles weg is: process.stdout.write + process.exit kapte onder een niet-Node-ouder (Python, shell)
// af op 64 KB (gemeten wv683: 65.536 tekens bij --max 2000). EAGAIN op een niet-blokkerende pijp: kort wachten, opnieuw.
function uit(obj, code) {
  const buf = Buffer.from(JSON.stringify(Object.assign({}, obj, naarServer)) + '\n');
  let o = 0, pogingen = 0;
  while (o < buf.length && pogingen < 20000) {
    try { o += fs.writeSync(1, buf, o); }
    catch (e) { if (e.code !== 'EAGAIN') break; pogingen++; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
  }
  process.exit(code || 0);
}
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
      if (['vers', 'controle', 'alle', 'volledig', 'opgeheven', 'opnieuw'].indexOf(k) >= 0) opt[k] = true;
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
      // Slot van een proces dat niet meer bestaat (herstart midden in een ronde): meteen opruimen (tegenlezing Fable wv685 #5)
      let dood = false;
      try { const pid = parseInt(fs.readFileSync(SLOT, 'utf8'), 10); if (pid > 0 && pid !== process.pid) process.kill(pid, 0); } catch (e2) { dood = e2.code === 'ESRCH'; }
      try { if (dood || Date.now() - fs.statSync(SLOT).mtimeMs > 10 * 60000) { const weg = SLOT + '.oud.' + process.pid; fs.renameSync(SLOT, weg); fs.unlinkSync(weg); continue; } } catch (e2) { continue; }
      if (Date.now() > eind) throw new Weigering('bankluis bezet (een andere opvraag loopt nog); probeer het over een minuut');
      await new Promise(function (r) { setTimeout(r, 500); });
    }
  }
  // Een lange opdracht (de ronde) ververst het slot elke minuut, anders ruimt een wachter het na 10 min op (Fable wv685 #2)
  const vers = setInterval(function () { try { const n = new Date(); fs.utimesSync(SLOT, n, n); } catch (e) {} }, 60000);
  try { return await fn(); } finally { clearInterval(vers); try { fs.unlinkSync(SLOT); } catch (e) {} }
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
// wv685: ronde_<soort> telt de opvragen van de vaste ronde (zitten ook in <soort>). eigen = wat David (of de machinekamer met
// de hand) vandaag al vroeg; die houdt samen met wat nog over is altijd RESERVE: ronde < 2 en teller < MAX − max(0, RESERVE − eigen).
function rondeMag(s, rh, soort) {
  const t = teller(s, rh), r = t['ronde_' + soort] || 0, eigen = Math.max(0, t[soort] - r);
  return r < RONDE_PER_DAG && t[soort] < MAX_PER_DAG - Math.max(0, RESERVE - eigen);
}
function rondeTel(s, rh, soort) { const t = teller(s, rh); t['ronde_' + soort] = (t['ronde_' + soort] || 0) + 1; }

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
  // wv683: IBAN van de tegenpartij, alleen om interne overboekingen te herkennen (nooit in de uitvoer)
  if (!dbObj.prepare('PRAGMA table_info(tx)').all().some(function (k) { return k.name === 'tegen_iban'; })) dbObj.exec('ALTER TABLE tx ADD COLUMN tegen_iban TEXT');
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
      saldo_na: t.balance_after_transaction ? r2(Number(t.balance_after_transaction.amount)) : null, mcc: t.merchant_category_code || null,
      tegen_iban: (((af ? t.creditor_account : t.debtor_account) || {}).iban) || null, _ruw: t };
  });
}
// Een wachtende post komt bij boeking met een ander kenmerk terug: na een volledige opvraag tot vandaag gaan alle
// wachtende posten van die rekening eruit en komen de actuele (geboekt of nog wachtend) erin.
function cacheBij(rh, lijst, wisWachtendVanaf) {
  const d = db(), nu = new Date().toISOString();
  d.exec('BEGIN');
  try {
    if (wisWachtendVanaf) d.prepare("DELETE FROM tx WHERE rek = ? AND status = 'wachtend' AND datum >= ?").run(rh, wisWachtendVanaf);
    const zet = d.prepare('INSERT OR REPLACE INTO tx (rek, id, datum, valutadatum, bedrag, valuta, tegenpartij, omschrijving, status, saldo_na, mcc, opgehaald, tegen_iban)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    lijst.forEach(function (t) { zet.run(rh, t.id, t.datum, t.valutadatum, t.bedrag, t.valuta, t.tegenpartij, t.omschrijving, t.status, t.saldo_na, t.mcc, nu, t.tegen_iban || null); });
    d.prepare('DELETE FROM tx WHERE rek = ? AND datum < ?').run(rh, plusDagen(dag(), -BEWAAR_DAGEN));
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
}

// ── archief (wv687): de blijvende transactiedatabase (bank-archief.js) ─────
// Schrijven gaat altijd via archiefVeilig: een fout in het archief breekt de bankopvraag nooit; de reden gaat in _archief_fout
// naar server.js (logregel), niet naar de sessie. Leesopdrachten gebruiken archiefOpen en geven een fout gewoon terug.
let archiefObj;
function archiefOpen() {
  if (archiefObj) return archiefObj;
  const A = require(path.join(__dirname, 'bank-archief.js'));
  archiefObj = { A: A, a: A.open(BANK_DIR) };
  return archiefObj;
}
function archiefVeilig(wat, fn) {
  try { const x = archiefOpen(); return fn(x.A, x.a); }
  catch (e) { naarServer._archief_fout = String((naarServer._archief_fout ? naarServer._archief_fout + '; ' : '') + wat + ': ' + String(e && e.message || e)).slice(0, 300); return null; }
}
// Externe rekeningen (wv709): op Davids naam, maar van een ander. Uit het archief; faalt dat, dan een lege set met fout (logregel via
// archiefVeilig) en zegt de uitvoer dat de markering ontbreekt (Fable wv709 #9).
function externSet() { const x = archiefVeilig('extern', function (A, a) { return A.externeRekeningen(a); }); const s = x || new Set(); s.fout = !x; return s; }
const EXTERN_ONBEKEND = 'archief niet leesbaar: externe rekeningen (niet van David) zijn nu niet gemarkeerd';
const LET_OP_EXTERN = 'externe rekening: staat op Davids naam maar is van een ander; saldo en posten zijn niet van David (niet meetellen als zijn geld)';
function archiefBij(s, rh, lijst, opties) {
  return archiefVeilig('bij', function (A, a) { A.rekeningenSync(a, s.rekeningen); return A.bij(a, rh, lijst, opties); });
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
function zichtbaar(r) { return r.bron !== 'bunq' || r.status === 'ACTIVE'; }
function rekeningVan(s, ref, alle) {
  const n0 = String(ref || '').trim().toLowerCase();
  // Opgeheven of bevroren bunq-rekeningen alleen op hun exacte uid (anders zouden oude namen elke zoekterm dubbel maken).
  // alle (archiefopdrachten, wv687): ook opgeheven rekeningen, als een zichtbare niet past.
  const lijst = Object.keys(s.rekeningen).map(function (h) { return Object.assign({ hash: h }, s.rekeningen[h]); })
    .filter(function (r) { return alle || zichtbaar(r) || (r.uid && String(r.uid).toLowerCase() === n0); });
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
  archiefBij(s, rek.hash, lijst, { volledigVanaf: sleutel ? null : van });
  const o = s.opgehaald[rek.hash] = s.opgehaald[rek.hash] || {};
  o.transacties = new Date().toISOString();
  if (!o.vanaf || van < o.vanaf) o.vanaf = van;
  return { aantal: lijst.length, paginas: paginas, afgekapt: !!sleutel };
}

// ── bunq (wv683) ──────────────────────────────────────────────────────────
let bunqMod = null, bunqCtxObj, bunqCtxFout = null;
function ebKlaar() { return !!(geheim && geheim.sleutel && geheim.app_id); }
// Zonder bunq-lezer.js in de release of zonder staat.json: geen bunq (stil), de Enable Banking-kant werkt gewoon door.
function bunqCtx() {
  if (bunqCtxObj !== undefined) return bunqCtxObj;
  bunqCtxObj = null;
  try { bunqMod = require(path.join(__dirname, 'bunq-lezer.js')); } catch (e) { return null; }
  // Kapotte staat.json: bunq uit voor deze aanroep, Enable Banking werkt door; de reden staat in rekeningen/toestemming (Fable wv683 #7).
  try { bunqCtxObj = bunqMod.context(BANK_DIR, geheim || {}); } catch (e) { bunqCtxFout = String(e && e.message || e).slice(0, 200); bunqCtxObj = null; }
  return bunqCtxObj;
}
function bunqKan(ctx) { return !!(ctx && (ctx.sessie || ctx.sleutel)); }
function bunqRekeningen(s, ook) {
  return Object.keys(s.rekeningen).filter(function (h) { return s.rekeningen[h].bron === 'bunq' && (ook || zichtbaar(s.rekeningen[h])); });
}
// 4×/dag: de rekeningenlijst geeft alle saldi tegelijk en telt als saldo-opvraag voor elke actieve bunq-rekening.
function bunqMag(s) { return bunqRekeningen(s).every(function (h) { return magOpvragen(s, h, 'saldo'); }); }
function bunqOud(s) { return !s.bunq || !s.bunq.lijst || Date.now() - Date.parse(s.bunq.lijst) > VERS_MS; }
// Fout duiden. Geen toegang (thuis-IP of sleutel) of een foute handtekening: één box-rij per dag via server.js.
function bunqDuid(s, e) {
  const B = bunqMod || {};
  if (B.BunqWeigering && e instanceof B.BunqWeigering) return { reden: 'weigering', tekst: e.message };
  if (!(B.BunqFout && e instanceof B.BunqFout)) throw e;
  s.bunq = s.bunq || {};
  let tekst = e.tekst || ('bunq gaf HTTP ' + e.status);
  if (e.reden === 'grens') tekst = 'bunq: te veel verzoeken (429)';
  if (e.reden === 'toegang' || e.reden === 'handtekening') {
    s.bunq.fout = { reden: e.reden, tekst: tekst, sinds: (s.bunq.fout && s.bunq.fout.reden === e.reden && s.bunq.fout.sinds) || new Date().toISOString() };
    naarServer._bunq_sessie = null;   // server.js vergeet de sessie
    if (s.bunq.box_dag !== dag()) { s.bunq.box_dag = dag(); naarServer._box = { reden: e.reden, tekst: tekst }; }
  }
  return { reden: e.reden, tekst: tekst };
}
function bunqNaRoep(ctx) { if (ctx && ctx.nieuweSessie) naarServer._bunq_sessie = ctx.nieuweSessie; }
async function bunqLijstBij(s, ctx) {
  let r;
  try { r = await bunqMod.rekeningen(ctx); } finally { bunqNaRoep(ctx); }
  const nu = new Date().toISOString(), gezien = new Set();
  const zet = db().prepare('INSERT OR REPLACE INTO saldo (rek, json, opgehaald) VALUES (?, ?, ?)');
  r.rekeningen.forEach(function (b) {
    const h = hash('bunq:' + ctx.staat.user_id + ':' + b.id), oud = s.rekeningen[h] || {};
    gezien.add(h);
    s.rekeningen[h] = { bron: 'bunq', uid: 'bunq-' + b.id, bunq_id: b.id, sessie: null, bank: 'bunq', naam: schoon(b.naam, 80), product: b.soort, soort: b.soort,
      valuta: b.valuta, iban: b.iban, status: b.status, gezamenlijk: b.soort === 'gezamenlijk', mede_eigenaars: b.mede_eigenaars,
      label: oud.label || null, gekoppeld: oud.gekoppeld || nu };
    if (b.status === 'ACTIVE') teller(s, h).saldo++;
    zet.run(h, JSON.stringify({ geboekt: b.saldo, beschikbaar: null, valuta: b.valuta, peildatum: nu }), nu);
    s.opgehaald[h] = Object.assign(s.opgehaald[h] || {}, { saldo: nu });
  });
  if (!r.afgekapt) Object.keys(s.rekeningen).forEach(function (h) { const x = s.rekeningen[h]; if (x.bron === 'bunq' && !gezien.has(h)) x.status = 'WEG'; });
  s.bunq = Object.assign(s.bunq || {}, { lijst: nu, overgeslagen: r.overgeslagen });
  delete s.bunq.fout;
  return r;
}
// Eerste keer (nog geen bunq-rekeningen bekend): lijst ophalen zodat namen en labels te vinden zijn.
async function bunqEersteKeer(s, ctx) {
  if (!ctx || (s.bunq && s.bunq.lijst) || !bunqKan(ctx)) return null;
  try { await bunqLijstBij(s, ctx); return null; } catch (e) { return bunqDuid(s, e).tekst; }
}
// Twee soorten opvraag. Gewoon: nieuwste eerst tot 'van'. Verlengen: staat er een afgekapte vulling (o.bunq_terug = id van de
// oudste opgehaalde post) en vraagt men ouder dan o.vanaf, dan verder vanaf die post (older_id) in plaats van weer bovenaan
// te beginnen; anders zou een afgekapte eerste vulling nooit af komen (Fable wv683 #2). Een fout halverwege: het opgehaalde
// deel gaat wél de cache in, daarna de fout (Fable wv683 #1).
async function haalTransactiesBunq(s, rek, van, ctx) {
  const t = teller(s, rek.hash);
  t.transacties++;
  const o = s.opgehaald[rek.hash] = s.opgehaald[rek.hash] || {};
  const verlengen = !!(o.bunq_terug && o.vanaf && van < o.vanaf);
  let r;
  try { r = await bunqMod.transacties(ctx, rek.bunq_id, van, function () { t.paginas++; }, verlengen ? o.bunq_terug : null); } finally { bunqNaRoep(ctx); }
  const lijst = bunqMod.eenvoudig(r.posten, schoon);
  cacheBij(rek.hash, lijst, null);
  archiefBij(s, rek.hash, lijst, null);
  if (!verlengen) o.transacties = new Date().toISOString();
  const af = r.afgekapt || r.fout;
  if (!af) { if (!o.vanaf || van < o.vanaf || verlengen) o.vanaf = van; if (verlengen || !o.bunq_terug || van <= o.vanaf) delete o.bunq_terug; }
  else if (r.oudste_id && (verlengen || !o.vanaf || (r.oudste_dag && r.oudste_dag < o.vanaf))) {
    // De cache loopt nu aaneengesloten tot de oudste opgehaalde post; daar gaat de volgende verlenging verder. Ook als er al een
    // kortere vulling stond (o.vanaf) en deze opvraag van bovenaf verder terug kwam, anders begon elke herhaling weer bovenaan (wv684).
    o.bunq_terug = r.oudste_id;
    // De afkapdag zelf is maar half binnen (oudere posten van die dag staan op de volgende pagina): de cache geldt vanaf de dag erna.
    if (r.oudste_dag) { const nv = plusDagen(r.oudste_dag, 1); if (!o.vanaf || nv < o.vanaf || (verlengen && nv <= o.vanaf)) o.vanaf = nv; }
  }
  if (r.fout) throw r.fout;
  return { aantal: lijst.length, paginas: r.paginas, afgekapt: r.afgekapt, onleesbaar: r.onleesbaar || undefined };
}
// Eigen IBAN's (beide bronnen, ook opgeheven) → naam, voor het veld 'intern' bij een overboeking tussen eigen rekeningen.
// alleenExtern: juist de externe rekeningen (veld 'extern'); anders zonder de externe (wv709).
function eigenIbans(s, ext, alleenExtern) {
  const m = new Map();
  Object.keys(s.rekeningen).forEach(function (h) {
    const r = s.rekeningen[h];
    if (r.iban && !!alleenExtern === !!(ext && ext.has(h))) m.set(String(r.iban).replace(/\s+/g, '').toUpperCase(), r.label || r.naam || h.slice(0, 12));
  });
  return m;
}
const LET_OP_GEZAMENLIJK = 'gezamenlijke rekening: posten van de mede-eigenaar staan erin; alleen voor David, nooit naar buiten';

// ── historie voor het archief (wv687) ─────────────────────────────────────
// bunq volledig: alle posten ooit, nieuwste eerst, met een eigen vervolgpunt (o.archief_terug) los van dat van de cache. Schrijft
// alleen naar het archief (de cache blijft 13 maanden). Telt als één transactieopvraag per rekening per aanroep.
async function haalArchiefBunq(s, rek, ctx) {
  const x = archiefOpen();   // eerst: faalt het archief, dan geen getelde opvraag (tegenlezing INFO 6)
  const t = teller(s, rek.hash);
  t.transacties++;
  const o = s.opgehaald[rek.hash] = s.opgehaald[rek.hash] || {};
  let r;
  try { r = await bunqMod.transacties(ctx, rek.bunq_id, '2000-01-01', function () { t.paginas++; }, o.archief_terug || null); } finally { bunqNaRoep(ctx); }
  const lijst = bunqMod.eenvoudig(r.posten, schoon);
  x.A.rekeningenSync(x.a, s.rekeningen);
  const u = x.A.bij(x.a, rek.hash, lijst, null);
  if (r.afgekapt || r.fout) { if (r.oudste_id) o.archief_terug = r.oudste_id; }
  else { o.archief_klaar = new Date().toISOString(); delete o.archief_terug; }
  if (r.fout) throw r.fout;
  return { aantal: lijst.length, nieuw: u.nieuw, paginas: r.paginas, afgekapt: r.afgekapt || undefined, oudste: r.oudste_dag || null };
}
// ABN (Enable Banking) zo ver als de bank geeft: één opvraag vanaf 'van'; alleen naar het archief.
async function haalArchiefEb(s, rek, van) {
  const t = teller(s, rek.hash);
  t.transacties++;
  const alle = []; let sleutel = null, paginas = 0;
  do {
    const j = await api('GET', '/accounts/' + encodeURIComponent(rek.uid) + '/transactions', null, { date_from: van, date_to: dag(), continuation_key: sleutel || undefined });
    paginas++; t.paginas++;
    (j.transactions || []).forEach(function (x) { alle.push(x); });
    sleutel = j.continuation_key || null;
  } while (sleutel && paginas < MAX_PAGINAS);
  const lijst = eenvoudig(alle);
  const x = archiefOpen();
  x.A.rekeningenSync(x.a, s.rekeningen);
  const u = x.A.bij(x.a, rek.hash, lijst, { volledigVanaf: sleutel ? null : van });
  const oudste = lijst.reduce(function (m, p) { return p.datum && (!m || p.datum < m) ? p.datum : m; }, null);
  return { aantal: lijst.length, nieuw: u.nieuw, paginas: paginas, afgekapt: !!sleutel || undefined, oudste: oudste };
}
// Leesopdrachten op het archief: eerst de cache bijwerken in het archief (incrementeel) en de rekeningen gelijkzetten.
function archiefKlaar() {
  const x = archiefOpen(), s = standLees();
  x.A.migreerCache(x.a, path.join(BANK_DIR, 'cache.sqlite'));
  x.A.rekeningenSync(x.a, s.rekeningen);
  return { A: x.A, a: x.a, s: s };
}
// wv765: de PayPal-laag; zelfde database, eigen tabel. Laadt pas als een PayPal-opdracht hem nodig heeft.
let paypalObj;
function paypalModule() { if (!paypalObj) paypalObj = require(path.join(__dirname, 'paypal-bewijs.js')); return paypalObj; }
function archiefFilter(a, s) {
  const o = a.opt, f = {};
  ['van', 'tot'].forEach(function (k) { if (o[k] != null) { if (!isDatum(o[k])) throw new Weigering('--' + k + ' als JJJJ-MM-DD'); f[k] = o[k]; } });
  if (o.rekening) f.rek = rekeningVan(s, o.rekening, true).hash;
  ['categorie', 'eigenaar', 'tekst', 'max', 'maand'].forEach(function (k) { if (o[k] != null) f[k] = String(o[k]).slice(0, 80); });
  if (o.type != null) f.type = String(o.type);
  return f;
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
    // wv687: bunq volledig (alle posten ooit, per rekening onder een eigen slot zodat Davids vragen ertussendoor kunnen)
    if (id === 'bunq' && a.opt.volledig) {
      const ctx = bunqCtx();
      if (!ctx) throw new Weigering('bunq is niet ingericht (staat.json of bunq-lezer.js ontbreekt)');
      let lijst = [];
      await metSlot(async function () {
        const s = standLees(), eerst = await bunqEersteKeer(s, ctx);
        standSchrijf(s);
        if (eerst) throw new Weigering(eerst);
        lijst = Object.keys(s.rekeningen).filter(function (h) {
          const r = s.rekeningen[h];
          return r.bron === 'bunq' && r.bunq_id != null && (r.status === 'ACTIVE' || (a.opt.opgeheven && r.status !== 'WEG'));
        });
      });
      const resultaat = [];
      let stop = false;
      for (const h of lijst) {
        if (stop) break;
        const r = { rek_kort: h.slice(0, 8) };
        await metSlot(async function () {
          const s = standLees(), rek = Object.assign({ hash: h }, s.rekeningen[h]), o = s.opgehaald[h] || {};
          r.status = String(rek.status || '?').toLowerCase();
          if (o.archief_klaar && !o.archief_terug && !a.opt.opnieuw) { r.al_klaar = o.archief_klaar.slice(0, 10); return; }
          if (!magOpvragen(s, h, 'transacties')) { r.overgeslagen = 'opvraaggrens vandaag'; return; }
          try { Object.assign(r, await haalArchiefBunq(s, rek, ctx)); }
          catch (e) {
            const B = bunqMod || {};
            if ((B.BunqFout && e instanceof B.BunqFout) || (B.BunqWeigering && e instanceof B.BunqWeigering)) { r.fout = bunqDuid(s, e).tekst; if (s.bunq && s.bunq.fout && /toegang|handtekening/.test(s.bunq.fout.reden)) stop = true; }
            else { r.fout = 'archief: ' + String(e && e.message || e).slice(0, 120); naarServer._archief_fout = r.fout; stop = true; }   // vervolgpunt niet verschoven: volgende keer opnieuw
          }
          standSchrijf(s);
        });
        resultaat.push(r);
      }
      const v = archiefVeilig('verrijk', function (A, x) { return A.verrijk(x); });
      return { ok: true, bron: 'bunq', volledig: true, rekeningen: resultaat, archief_posten: v ? v.posten : null };
    }
    // wv687: ABN zo ver terug als de bank geeft; alleen als David er vandaag daarna nog RESERVE overhoudt
    if (id === 'abn-diep') {
      const van = a.opt.van;
      if (!isDatum(van) || van >= dag()) throw new Weigering('--van JJJJ-MM-DD (vóór vandaag)');
      return metSlot(async function () {
        const s = standLees(), resultaat = [];
        for (const h of Object.keys(s.rekeningen).filter(function (k) { return s.rekeningen[k].bron !== 'bunq'; })) {
          const rek = Object.assign({ hash: h }, s.rekeningen[h]), ss = s.sessies[rek.sessie] || {}, r = { rek_kort: h.slice(0, 8) };
          if (ss.status !== 'AUTHORIZED' || (ss.geldig_tot && Date.parse(ss.geldig_tot) <= Date.now())) r.overgeslagen = 'toestemming geldt niet';
          else if (teller(s, h).transacties + 1 > MAX_PER_DAG - RESERVE) r.overgeslagen = 'David moet er vandaag nog ' + RESERVE + ' overhouden';
          else { try { Object.assign(r, await haalArchiefEb(s, rek, van)); } catch (e) { r.fout = (await duidFout(s, rek, e)).tekst; } }
          resultaat.push(r);
          standSchrijf(s);
        }
        const v = archiefVeilig('verrijk', function (A, x) { return A.verrijk(x); });
        return { ok: true, bron: 'enablebanking', van: van, rekeningen: resultaat, archief_posten: v ? v.posten : null };
      });
    }
    // historie bunq: 13 maanden transacties van elke actieve bunq-rekening (eerste vulling; alleen machinekamer via server.js)
    if (id === 'bunq') return metSlot(async function () {
      const s = standLees(), ctx = bunqCtx();
      if (!ctx) throw new Weigering('bunq is niet ingericht (staat.json of bunq-lezer.js ontbreekt)');
      const eerst = await bunqEersteKeer(s, ctx);
      if (eerst) { standSchrijf(s); return { ok: false, fout: eerst }; }
      const van = plusDagen(dag(), -BEWAAR_DAGEN), resultaat = [];
      for (const h of bunqRekeningen(s)) {
        const rek = Object.assign({ hash: h }, s.rekeningen[h]), r = { rekening: h.slice(0, 12) };
        if (!magOpvragen(s, h, 'transacties')) r.overgeslagen = 'opvraaggrens vandaag';
        else { try { Object.assign(r, await haalTransactiesBunq(s, rek, van, ctx)); } catch (e) { r.transacties_fout = bunqDuid(s, e).tekst; } }
        resultaat.push(r);
        standSchrijf(s);
        if (r.transacties_fout && /toegang|handtekening/.test(s.bunq && s.bunq.fout ? s.bunq.fout.reden : '')) break;
      }
      return { ok: true, bron: 'bunq', vanaf: van, rekeningen: resultaat };
    });
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

  async rekeningen(a) {
    let s = standLees(), let_op = null;
    const ctx = bunqCtx();
    // bunq: lijst ophalen als hij er nog niet is of ouder is dan een dag (nieuwe of opgeheven rekeningen), binnen de grens
    if (ctx && bunqKan(ctx) && (!s.bunq || !s.bunq.lijst || Date.now() - Date.parse(s.bunq.lijst) > 24 * 3600 * 1000)) {
      await metSlot(async function () {
        s = standLees();
        if (!bunqMag(s)) let_op = 'bunq: opvraaggrens vandaag bereikt; lijst van ' + ((s.bunq && s.bunq.lijst) || '?');
        else { try { await bunqLijstBij(s, ctx); } catch (e) { let_op = bunqDuid(s, e).tekst; } }
        standSchrijf(s);
      });
    }
    const alle = !!(a && a.opt.alle);
    const hashes = Object.keys(s.rekeningen).filter(function (h) { return alle || zichtbaar(s.rekeningen[h]); }), ext = externSet();
    return { ok: true, let_op: let_op || undefined, let_op_extern: ext.fout ? EXTERN_ONBEKEND : undefined, verborgen: Object.keys(s.rekeningen).length - hashes.length || undefined,
      bunq: ctx ? { lijst_van: (s.bunq && s.bunq.lijst) || null, fout: (s.bunq && s.bunq.fout && s.bunq.fout.tekst) || undefined } : (bunqCtxFout ? { fout: bunqCtxFout } : undefined),
      rekeningen: hashes.map(function (h) {
        const r = s.rekeningen[h], ss = s.sessies[r.sessie] || {}, o = s.opgehaald[h] || {}, t = (s.tellers.dag === dag() && s.tellers.per[h]) || {};
        const bunq = r.bron === 'bunq';
        return { uid: r.uid, label: r.label, naam: r.naam, product: r.product, bank: r.bank, iban: r.iban, valuta: r.valuta,
          bron: bunq ? 'bunq' : 'enablebanking', gezamenlijk: r.gezamenlijk || undefined, extern: ext.has(h) || undefined, let_op_extern: ext.has(h) ? LET_OP_EXTERN : undefined,
          toestemming_tot: bunq ? null : (ss.geldig_tot ? String(ss.geldig_tot).slice(0, 10) : null), dagen_over: bunq ? null : dagenOver(ss.geldig_tot),
          status: bunq ? r.status : (ss.status || '?'),
          saldo_opgehaald: o.saldo || null, transacties_opgehaald: o.transacties || null, transacties_vanaf: o.vanaf || null,
          opvragen_vandaag: { saldo: t.saldo || 0, transacties: t.transacties || 0, max: MAX_PER_DAG } };
      }) };
  },

  async saldo(a) {
    return metSlot(async function () {
      const s = standLees(), ctx = bunqCtx();
      let bunqLetOp = await bunqEersteKeer(s, ctx), bunqVers = false;
      const lijst = a.pos[0] ? [rekeningVan(s, a.pos[0])] : Object.keys(s.rekeningen).filter(function (h) { return zichtbaar(s.rekeningen[h]); })
        .map(function (h) { return Object.assign({ hash: h }, s.rekeningen[h]); });
      if (!lijst.length) throw new Weigering(bunqLetOp || 'nog geen rekening gekoppeld');
      // bunq: één lijstopvraag geeft alle saldi; alleen als de stand ouder is dan 6 uur of vers gevraagd
      if (!bunqLetOp && ctx && lijst.some(function (r) { return r.bron === 'bunq'; }) && (a.opt.vers || bunqOud(s))) {
        if (!bunqMag(s)) bunqLetOp = 'opvraaggrens vandaag bereikt (' + MAX_PER_DAG + '×): laatst bekende stand';
        else if (!bunqKan(ctx)) bunqLetOp = 'bunq-sleutel nu niet beschikbaar: laatst bekende stand';
        else { try { await bunqLijstBij(s, ctx); bunqVers = true; } catch (e) { bunqLetOp = bunqDuid(s, e).tekst + '; laatst bekende stand'; } }
      }
      const uitv = [], ext = externSet();
      for (const rek0 of lijst) {
        const rek = rek0.bron === 'bunq' ? Object.assign({ hash: rek0.hash }, s.rekeningen[rek0.hash]) : rek0;
        const rij = db().prepare('SELECT json, opgehaald FROM saldo WHERE rek = ?').get(rek.hash);
        const vers = rij && Date.now() - Date.parse(rij.opgehaald) < VERS_MS;
        const r = { rekening: rek.label || rek.naam || rek.hash.slice(0, 12), iban_eind: rek.iban ? rek.iban.slice(-4) : null };
        if (ext.has(rek.hash)) Object.assign(r, { extern: true, let_op_extern: LET_OP_EXTERN });
        if (rek.bron === 'bunq') {
          Object.assign(r, { bank: 'bunq', soort: rek.soort, gezamenlijk: rek.gezamenlijk || undefined, let_op_gezamenlijk: rek.gezamenlijk ? LET_OP_GEZAMENLIJK : undefined });
          if (rek.status !== 'ACTIVE') r.let_op = 'rekening ' + String(rek.status).toLowerCase();
          if (rij) Object.assign(r, JSON.parse(rij.json), { bron: bunqVers ? 'bank' : 'cache', stand_van: rij.opgehaald });
          else r.fout = 'nog geen stand bekend';
          if (bunqLetOp) r.let_op = bunqLetOp;
          delete r.alle;
          uitv.push(r);
          continue;
        }
        if (rij && vers && !a.opt.vers) Object.assign(r, JSON.parse(rij.json), { bron: 'cache', stand_van: rij.opgehaald });
        else if (!ebKlaar()) {
          r.let_op = 'Enable Banking-sleutel nu niet beschikbaar: laatst bekende stand';
          if (rij) Object.assign(r, JSON.parse(rij.json), { bron: 'cache', stand_van: rij.opgehaald });
        }
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
      return { ok: true, let_op_extern: ext.fout ? EXTERN_ONBEKEND : undefined, saldi: uitv };
    });
  },

  async transacties(a) {
    const vandaag = dag();
    const tot = a.opt.tot || vandaag, van = a.opt.van || plusDagen(tot, -30);
    if (!isDatum(van) || !isDatum(tot) || van > tot) throw new Weigering('--van en --tot als JJJJ-MM-DD, van ≤ tot');
    const max = Math.min(Math.max(parseInt(a.opt.max, 10) || 200, 1), 2000);
    const zoek = a.opt.zoek ? String(a.opt.zoek).toLowerCase().slice(0, 80) : '';
    return metSlot(async function () {
      const s = standLees(), ctx = bunqCtx();
      const eerst = await bunqEersteKeer(s, ctx);
      let rek;
      try { rek = rekeningVan(s, a.pos[0]); } catch (e) { if (eerst) standSchrijf(s); throw eerst && e instanceof Weigering ? new Weigering(e.message + ' (' + eerst + ')') : e; }
      const o = s.opgehaald[rek.hash] || {}, bunq = rek.bron === 'bunq';
      let bron = 'cache', let_op = null;
      const oud = !o.transacties || Date.now() - Date.parse(o.transacties) > VERS_MS;
      // Ouder dan de bewaartermijn bewaart de cache niets: zo'n begindatum telt als de grens, anders ging elke vraag van vóór
      // de grens opnieuw naar de bank (o.vanaf komt nooit verder terug dan vandaag − BEWAAR_DAGEN; wv684).
      const grens = plusDagen(vandaag, -BEWAAR_DAGEN), vanCache = van < grens ? grens : van;
      const teOud = o.vanaf && vanCache < o.vanaf;
      const ophalen = teOud || ((oud || a.opt.vers) && tot >= plusDagen(vandaag, -2));
      if (ophalen) {
        if (bunq && rek.status !== 'ACTIVE') let_op = 'rekening ' + String(rek.status).toLowerCase() + ': alleen wat al in de cache stond';
        else if (bunq && !bunqKan(ctx)) let_op = 'bunq-sleutel nu niet beschikbaar: alleen wat al in de cache stond';
        else if (!bunq && !ebKlaar()) let_op = 'Enable Banking-sleutel nu niet beschikbaar: alleen wat al in de cache stond';
        else if (!bunq && (s.sessies[rek.sessie] || {}).status !== 'AUTHORIZED') let_op = 'toestemming verlopen: alleen wat al in de cache stond';
        else if (!magOpvragen(s, rek.hash, 'transacties')) let_op = 'opvraaggrens vandaag bereikt (' + MAX_PER_DAG + '×): stand van ' + (o.transacties || '?');
        else {
          // Vanaf de oudste gevraagde dag, of vanaf 10 dagen vóór de vorige opvraag (late boekingen); nooit verder dan de bewaartermijn.
          let vanaf = teOud || !o.transacties ? van : plusDagen(o.transacties.slice(0, 10), -10);
          if (van < vanaf) vanaf = van;
          if (vanaf < grens) vanaf = grens;
          if (bunq) {
            try {
              const r = await haalTransactiesBunq(s, rek, vanaf, ctx); bron = 'bank';
              if (r.afgekapt) let_op = "te veel posten in één keer; afgekapt bij " + ((s.opgehaald[rek.hash] || {}).vanaf || '?') + ' (dezelfde vraag nog eens haalt het volgende deel)';
              if (r.onleesbaar) let_op = (let_op ? let_op + '; ' : '') + r.onleesbaar + ' post(en) zonder leesbare datum overgeslagen';
            }
            catch (e) { let_op = bunqDuid(s, e).tekst + '; uit de cache'; }
          } else {
            try { const r = await haalTransacties(s, rek, vanaf); bron = 'bank'; if (r.afgekapt) let_op = 'meer dan ' + MAX_PAGINAS + " pagina's; afgekapt"; }
            catch (e) { let_op = (await duidFout(s, rek, e)).tekst + '; uit de cache'; }
          }
        }
      }
      if (van < grens) let_op = (let_op ? let_op + '; ' : '') + 'de cache gaat niet verder terug dan ' + grens + ' (bewaartermijn ' + BEWAAR_DAGEN + ' dagen)';
      standSchrijf(s);
      // op een externe rekening is niets intern; een overboeking naar of van een externe rekening heet 'extern' (wv709)
      const ext = externSet(), isExt = ext.has(rek.hash);
      const eigen = isExt ? new Map() : eigenIbans(s, ext), extIb = isExt ? new Map() : eigenIbans(s, ext, true), eigenIban = rek.iban ? String(rek.iban).replace(/\s+/g, '').toUpperCase() : '';
      const rijen = db().prepare('SELECT id, datum, valutadatum, bedrag, valuta, tegenpartij, omschrijving, status, saldo_na, tegen_iban FROM tx WHERE rek = ? AND datum >= ? AND datum <= ? ORDER BY datum DESC, id')
        .all(rek.hash, van, tot).filter(function (t) {
          return !zoek || [t.tegenpartij, t.omschrijving].some(function (v) { return v && v.toLowerCase().indexOf(zoek) >= 0; }) || String(t.bedrag).indexOf(zoek) >= 0;
        });
      const in_ = r2(rijen.filter(function (t) { return t.bedrag > 0; }).reduce(function (x, t) { return x + t.bedrag; }, 0));
      const af = r2(rijen.filter(function (t) { return t.bedrag < 0; }).reduce(function (x, t) { return x + t.bedrag; }, 0));
      return { ok: true, rekening: rek.label || rek.naam || rek.hash.slice(0, 12), bank: rek.bank || undefined, van: van, tot: tot, bron: bron,
        let_op_gezamenlijk: rek.gezamenlijk ? LET_OP_GEZAMENLIJK : undefined, let_op_extern: isExt ? LET_OP_EXTERN : (ext.fout ? EXTERN_ONBEKEND : undefined),
        stand_van: (s.opgehaald[rek.hash] || {}).transacties || null, cache_vanaf: (s.opgehaald[rek.hash] || {}).vanaf || null, let_op: let_op,
        aantal: rijen.length, getoond: Math.min(rijen.length, max), totaal_in: in_, totaal_uit: af,
        transacties: rijen.slice(0, max).map(function (t) {
          return { datum: t.datum, bedrag: t.bedrag, valuta: t.valuta, tegenpartij: t.tegenpartij,
            omschrijving: t.omschrijving ? t.omschrijving.slice(0, OMSCHRIJVING_UIT) : null, status: t.status,
            saldo_na: t.saldo_na == null ? undefined : t.saldo_na, valutadatum: t.valutadatum && t.valutadatum !== t.datum ? t.valutadatum : undefined,
            intern: t.tegen_iban && t.tegen_iban.toUpperCase() !== eigenIban && eigen.has(t.tegen_iban.toUpperCase()) ? eigen.get(t.tegen_iban.toUpperCase()) : undefined,
            extern: t.tegen_iban && extIb.has(t.tegen_iban.toUpperCase()) ? extIb.get(t.tegen_iban.toUpperCase()) : undefined };
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
        if (a.opt.controle && ebKlaar()) {
          try { const st = await api('GET', '/sessions/' + encodeURIComponent(id)); r.status_bank = st.status; ss.status = st.status || ss.status;
            if (st.access && st.access.valid_until) { ss.geldig_tot = st.access.valid_until; r.geldig_tot = String(st.access.valid_until).slice(0, 10); r.dagen_over = dagenOver(st.access.valid_until); } }
          catch (e) { r.controle_fout = e instanceof BankFout ? 'HTTP ' + e.status : String(e.message || e); if (e instanceof BankFout && [404, 410].indexOf(e.status) >= 0) ss.status = 'VERLOPEN'; }
        }
        lijst.push(r);
      }
      const nu = Date.now();
      const wachtend = Object.values(s.wachtend).filter(function (w) { return !w.verbruikt && Date.parse(w.tot) > nu; }).length;
      standSchrijf(s);
      // bunq heeft geen toestemming met einddatum: de sleutel geldt tot David hem intrekt (bunq-app → Instellingen → Developers → API-sleutels).
      const ctx = bunqCtx();
      const bunq = ctx ? { ingericht: true, sinds: ctx.staat.aangemaakt || null, rekeningen: bunqRekeningen(s).length, lijst_van: (s.bunq && s.bunq.lijst) || null,
        fout: (s.bunq && s.bunq.fout) ? s.bunq.fout.tekst + ' (sinds ' + s.bunq.fout.sinds + ')' : undefined } : { ingericht: false, fout: bunqCtxFout || undefined };
      return { ok: true, sessies: lijst, open_koppelinks: wachtend, bunq: bunq };
    });
  },

  // wv685: vaste ronde. Alleen via POST /bank-ronde (server.js, API_SECRET). Per rekening saldo + nieuwe transacties binnen
  // rondeMag; vóór de rekeningen per Enable Banking-sessie GET /sessions/{id} (metadata, geen bankopvraag). Uitvoer: alleen
  // aantallen, tijden, toestemmingsdata en foutredenen (gaat naar n8n); geen bedragen, namen, IBAN's of sessie-id's.
  // geslaagd = geen enkele fout; een opvraag die de grens overslaat is geen fout, een 429 van de bank wel (dan telt de bank
  // anders dan wij). Enable Banking 'sleutel' of 'toestemming': één box-melding per reden per dag (_box_ronde, server.js).
  async ronde() {
    const begin = Date.now();
    return metSlot(async function () {
      const s = standLees(), ctx = bunqCtx(), vandaag = dag(), grens = plusDagen(vandaag, -BEWAAR_DAGEN);
      const tel = { saldo: { bank: 0, vers: 0, grens: 0, fout: 0 }, transacties: { bank: 0, vers: 0, grens: 0, fout: 0, posten: 0 } };
      const fouten = [];
      const fout = function (bron, reden, tekst) {
        const f = fouten.find(function (x) { return x.bron === bron && x.reden === reden; });
        if (f) f.aantal++; else fouten.push({ bron: bron, reden: reden, tekst: String(tekst || '').slice(0, 200), aantal: 1 });
      };
      const vers = function (iso) { return !!iso && Date.now() - Date.parse(iso) < RONDE_VERS_MS; };
      const vanafVoor = function (o) { const v = o && o.transacties ? plusDagen(dag(o.transacties), -10) : plusDagen(vandaag, -30); return v < grens ? grens : v; };
      const ebDuid = async function (rek, e) {
        if (e instanceof Weigering) return { reden: 'sleutel', tekst: 'sleutel in de kluis onbruikbaar: ' + e.message };
        if (!(e instanceof BankFout)) return { reden: 'storing', tekst: 'interne fout: ' + String(e && e.message || e).slice(0, 120) };
        return duidFout(s, rek, e);
      };
      const bqDuid = function (e) {
        try { return bunqDuid(s, e); } catch (x) { return { reden: 'storing', tekst: 'interne fout: ' + String(e && e.message || e).slice(0, 120) }; }
      };

      // ── Enable Banking ──
      const ebRek = Object.keys(s.rekeningen).filter(function (h) { return s.rekeningen[h].bron !== 'bunq'; });
      let ebSleutel = ebKlaar();
      if (ebRek.length && !ebSleutel) fout('enablebanking', 'sleutel', 'Enable Banking-sleutel of applicatie-id ontbreekt in de kluis');
      const ebSessies = Array.from(new Set(ebRek.map(function (h) { return s.rekeningen[h].sessie; }).filter(Boolean)));
      for (const id of ebSessies) {
        const ss = s.sessies[id];
        if (!ss || !ebSleutel || ss.status !== 'AUTHORIZED') continue;
        try {
          const st = await api('GET', '/sessions/' + encodeURIComponent(id));
          if (st.status) ss.status = st.status;
          if (st.access && st.access.valid_until) ss.geldig_tot = st.access.valid_until;
        } catch (e) {
          // 404/410 hier zet de sessie níet op verlopen: één meting is te weinig voor een kaart en een regel bij David (Fable
          // wv685 #8). De rekeningopvraag hieronder krijgt dan een 401 en duidFout meet de sessie opnieuw.
          if (e instanceof Weigering || (e instanceof BankFout && [401, 403].indexOf(e.status) >= 0)) {
            const f = await ebDuid({ hash: ss.rekeningen[0], sessie: id }, e);
            if (f.reden === 'sleutel') { ebSleutel = false; fout('enablebanking', 'sleutel', f.tekst); }
          }
          // anders (storing, 429): geen oordeel; de rekeningopvraag hieronder beslist
        }
      }
      for (const h of ebRek) {
        const rek = Object.assign({ hash: h }, s.rekeningen[h]), ss = s.sessies[rek.sessie] || {};
        // Einddatum voorbij: verlopen, ook als Enable Banking de status nog AUTHORIZED noemt (niet gemeten of EB hem omzet;
        // de docs noemen alleen EXPIRED_SESSION bij een opvraag). Geen bankopvraag meer (Fable wv685 #4).
        if (ss.geldig_tot && Date.parse(ss.geldig_tot) <= Date.now()) { fout('enablebanking', 'toestemming', 'toestemming liep af op ' + String(ss.geldig_tot).slice(0, 10) + '; David moet opnieuw koppelen'); continue; }
        if (ss.status !== 'AUTHORIZED') { fout('enablebanking', 'toestemming', 'toestemming bij de bank geldt niet meer (sessie ' + (ss.status || 'onbekend') + '); David moet opnieuw koppelen'); continue; }
        if (!ebSleutel) continue;
        const o = s.opgehaald[h] || {};
        let stop = false;
        for (const soort of ['saldo', 'transacties']) {
          if (stop) break;
          if (vers(o[soort])) { tel[soort].vers++; continue; }
          if (!rondeMag(s, h, soort)) { tel[soort].grens++; continue; }
          rondeTel(s, h, soort);
          try {
            if (soort === 'saldo') await haalSaldo(s, rek);
            else tel.transacties.posten += (await haalTransacties(s, rek, vanafVoor(o))).aantal;
            tel[soort].bank++;
          } catch (e) {
            const f = await ebDuid(rek, e);
            tel[soort].fout++;
            fout('enablebanking', f.reden, f.tekst);
            if (f.reden === 'sleutel') ebSleutel = false;
            if (f.reden === 'sleutel' || f.reden === 'toestemming' || f.reden === 'grens') stop = true;
          }
          standSchrijf(s);
        }
      }

      // ── bunq ──
      let bunqN = 0;
      if (!ctx && bunqCtxFout) fout('bunq', 'staat', 'bunq-staat onleesbaar: ' + bunqCtxFout);
      if (ctx && !bunqKan(ctx)) fout('bunq', 'sleutel', 'bunq-sleutel nu niet beschikbaar (kluis bunq_api_key)');
      else if (ctx) {
        let stop = false, bh = bunqRekeningen(s);
        if (s.bunq && vers(s.bunq.lijst) && bh.length) tel.saldo.vers += bh.length;
        else if (bh.length && !bh.every(function (h) { return rondeMag(s, h, 'saldo'); })) tel.saldo.grens += bh.length;
        else {
          try { await bunqLijstBij(s, ctx); bh = bunqRekeningen(s); bh.forEach(function (h) { rondeTel(s, h, 'saldo'); }); tel.saldo.bank += bh.length; }
          catch (e) { const f = bqDuid(e); tel.saldo.fout++; fout('bunq', f.reden, f.tekst); stop = BUNQ_STOP.indexOf(f.reden) >= 0; }
          standSchrijf(s);
        }
        bh = bunqRekeningen(s);
        bunqN = bh.length;
        if (!stop) for (const h of bh) {
          const rek = Object.assign({ hash: h }, s.rekeningen[h]), o = s.opgehaald[h] || {};
          if (vers(o.transacties)) { tel.transacties.vers++; continue; }
          if (!rondeMag(s, h, 'transacties')) { tel.transacties.grens++; continue; }
          rondeTel(s, h, 'transacties');
          try { tel.transacties.posten += (await haalTransactiesBunq(s, rek, vanafVoor(o), ctx)).aantal; tel.transacties.bank++; }
          catch (e) {
            const f = bqDuid(e);
            tel.transacties.fout++; fout('bunq', f.reden, f.tekst);
            if (BUNQ_STOP.indexOf(f.reden) >= 0) { standSchrijf(s); break; }
          }
          standSchrijf(s);
        }
      }

      // ── toestemming (alleen Enable Banking; bunq heeft geen einddatum) ──
      const toestemming = ebSessies.map(function (id) {
        const ss = s.sessies[id] || {}, eigen = (ss.rekeningen || []).filter(function (h) { return s.rekeningen[h] && s.rekeningen[h].sessie === id; });
        const r0 = s.rekeningen[eigen[0]] || {};
        return { sessie_kort: hash(id).slice(0, 8), bank: ss.bank || null, geldig_tot: ss.geldig_tot ? String(ss.geldig_tot).slice(0, 10) : null,
          dagen_over: dagenOver(ss.geldig_tot), status: ss.status || null, verlopen: !!(ss.geldig_tot && Date.parse(ss.geldig_tot) <= Date.now()) || undefined, rekeningen: eigen.length, rekening: schoon(r0.label || r0.product || '', 40) || null };
      });

      // ── tellers (voor de toets "laat 2 over") en uitkomst ──
      const zicht = Object.keys(s.rekeningen).filter(function (h) { return zichtbaar(s.rekeningen[h]); });
      const opv = { max: MAX_PER_DAG, reserve: RESERVE };
      ['saldo', 'transacties'].forEach(function (soort) {
        const ts = zicht.map(function (h) { return teller(s, h); });
        opv[soort] = { hoogst: ts.reduce(function (m, t) { return Math.max(m, t[soort] || 0); }, 0),
          ronde_hoogst: ts.reduce(function (m, t) { return Math.max(m, t['ronde_' + soort] || 0); }, 0),
          minst_over: ts.length ? ts.reduce(function (m, t) { return Math.min(m, MAX_PER_DAG - (t[soort] || 0)); }, MAX_PER_DAG) : null };
      });
      // wv687: archief bijwerken (cache incrementeel) en regels toepassen; alleen aantallen in de uitvoer
      const arch = archiefVeilig('ronde', function (A, x) { A.migreerCache(x, path.join(BANK_DIR, 'cache.sqlite')); A.rekeningenSync(x, s.rekeningen); const v = A.verrijk(x); return { posten: v.posten, gewijzigd: v.gewijzigd }; });
      // Zonder één rekening leest de ronde niets: dat is stille uitval, geen succes (Fable wv685 #6).
      if (!ebRek.length && !bunqN) fout('bank', 'leeg', 'geen enkele rekening gekoppeld of zichtbaar');
      const geslaagd = fouten.length === 0, nu = new Date().toISOString();
      // stempel (hartslag): ook als de enige fout een verlopen Enable Banking-toestemming is. Die ligt bij David (kaart + regel);
      // anders gaf de stiltewachter elke 26 u een machinekamer-alarm over een ronde die gewoon draait (Fable wv685 #3).
      const stempel = fouten.every(function (f) { return f.bron === 'enablebanking' && f.reden === 'toestemming'; });
      s.ronde = Object.assign(s.ronde || {}, { laatst: nu, geslaagd: geslaagd });
      if (geslaagd) s.ronde.laatst_geslaagd = nu;
      // box-melding (server.js zet de rij): Enable Banking sleutel/toestemming, hooguit één per reden per dag
      const box = [];
      s.ronde.box = s.ronde.box || {};
      fouten.forEach(function (f) {
        if (f.bron !== 'enablebanking' || (f.reden !== 'sleutel' && f.reden !== 'toestemming')) return;
        if (s.ronde.box[f.reden] === vandaag) return;
        s.ronde.box[f.reden] = vandaag;
        box.push({ bron: f.bron, reden: f.reden, tekst: f.tekst });
      });
      if (box.length) naarServer._box_ronde = box;
      standSchrijf(s);
      return { ok: true, geslaagd: geslaagd, stempel: stempel, begin: new Date(begin).toISOString(), duur_s: Math.round((Date.now() - begin) / 100) / 10,
        rekeningen: { enablebanking: ebRek.length, bunq: bunqN }, saldo: tel.saldo, transacties: tel.transacties, opvragen: opv,
        fouten: fouten, toestemming: toestemming, bunq: { ingericht: !!ctx }, archief: arch || { fout: true } };
    });
  },

  // ── transactiedatabase (wv687) ──
  async zoek(a) { const x = archiefKlaar(); return Object.assign({ ok: true, bron: 'archief' }, x.A.zoek(x.a, archiefFilter(a, x.s))); },
  async maand(a) { const x = archiefKlaar(); try { return Object.assign({ ok: true, bron: 'archief' }, x.A.maand(x.a, archiefFilter(a, x.s))); } catch (e) { if (/^maand:/.test(e.message)) throw new Weigering(e.message); throw e; } },
  async intern(a) { const x = archiefKlaar(); return Object.assign({ ok: true, bron: 'archief' }, x.A.internLijst(x.a, archiefFilter(a, x.s))); },
  async abonnementen(a) {
    const x = archiefKlaar(), uit = Object.assign({ ok: true, bron: 'archief' }, x.A.abonnementen(x.a, { alle: !!a.opt.alle }));
    // wv765: achter de PayPal-incasso's de echte diensten (uit de ontvangstbewijzen); faalt dat, dan alleen een let_op
    try { const d = paypalModule().diensten(x.a); uit.paypal_diensten = { per_maand_totaal: d.per_maand_totaal, per_maand_bank: d.per_maand_bank,
      let_op: 'de PayPal-regel hierboven is de som van deze diensten (plus losse PayPal-aankopen); details: opdracht paypal-diensten',
      diensten: d.diensten.filter(function (r) { return r.actief; }).map(function (r) { return { naam: r.naam, ritme: r.ritme, bedrag: r.bedrag, valuta: r.valuta, per_maand: r.per_maand, betaald_via: r.betaald_via, signalen: r.signalen }; }) }; }
    catch (e) { uit.paypal_diensten = { fout: 'PayPal-laag niet leesbaar' }; }
    return uit;
  },
  // ── PayPal-laag (wv765): paypal-bewijs.js op dezelfde database ──
  async paypal(a) {
    const x = archiefKlaar(), o = {};
    ['van', 'tot'].forEach(function (k) { if (a.opt[k] != null) { if (!isDatum(a.opt[k])) throw new Weigering('--' + k + ' als JJJJ-MM-DD'); o[k] = a.opt[k]; } });
    if (a.opt.dienst != null) o.dienst = String(a.opt.dienst).slice(0, 40);
    if (a.opt.max != null) o.max = a.opt.max;
    return Object.assign({ ok: true, bron: 'archief' }, paypalModule().lijst(x.a, o));
  },
  async 'paypal-diensten'() { const x = archiefKlaar(); return Object.assign({ ok: true, bron: 'archief' }, paypalModule().diensten(x.a)); },
  async 'paypal-bekend'(a) {
    const x = archiefOpen();
    if (a.opt.van != null && !isDatum(a.opt.van)) throw new Weigering('--van als JJJJ-MM-DD');
    return { ok: true, mail_ids: paypalModule().bekend(x.a, a.opt.van) };
  },
  async 'paypal-bij'() {
    const x = archiefKlaar(), P = paypalModule();
    if (!Array.isArray(geheim.bewijzen)) throw new Weigering('bewijzen ontbreken');
    const b = P.bij(x.a, geheim.bewijzen.slice(0, 200), Array.isArray(geheim.fouten) ? geheim.fouten.slice(0, 200) : []);
    const k = geheim.koppel === false ? null : P.koppel(x.a);
    if (geheim.ronde === true) P.metaZet(x.a, 'paypal_ronde_op', new Date().toISOString());
    return { ok: true, bewaard: b, koppeling: k || undefined, stand: P.stand(x.a) };
  },
  // wv764 (idee 16 fase B): vaste lasten en geldstroom per maand, alleen het archief
  async 'vaste-lasten'(a) { const x = archiefKlaar(); try { return Object.assign({ ok: true, bron: 'archief' }, x.A.vasteLasten(x.a, archiefFilter(a, x.s))); } catch (e) { if (/^(maand|rekening):/.test(e.message)) throw new Weigering(e.message); throw e; } },
  async stroom(a) { const x = archiefKlaar(); try { return Object.assign({ ok: true, bron: 'archief' }, x.A.stroom(x.a, archiefFilter(a, x.s))); } catch (e) { if (/^(maand|rekening):/.test(e.message)) throw new Weigering(e.message); throw e; } },
  async archief() { const x = archiefKlaar(); x.A.verrijkAlsVuil(x.a); return Object.assign({ ok: true }, x.A.stand(x.a)); },
  async verrijk() { const x = archiefKlaar(); return Object.assign({ ok: true }, x.A.verrijk(x.a)); },
  async corrigeer(a) {
    const x = archiefKlaar(), o = a.opt, v = {};
    ['categorie', 'subcategorie', 'eigenaar', 'type'].forEach(function (k) { if (o[k] != null) v[k] = String(o[k]); });
    if (o.regel != null) v.regel = !/^(nee|false|0)$/i.test(String(o.regel));
    if (o.rekening) { if (o.nr) throw new Weigering('nr of rekening, niet allebei'); v.rek = rekeningVan(x.s, o.rekening, true).hash; if (o.door === 'machinekamer') v.door = 'machinekamer'; }
    else v.nr = o.nr;
    try { return x.A.corrigeer(x.a, v); } catch (e) { throw new Weigering(e.message); }
  },
  async 'verrijk-open'(a) { const x = archiefKlaar(); return Object.assign({ ok: true }, x.A.aiOpen(x.a, parseInt(a.opt.max, 10) || 60)); },
  async 'verrijk-zet'() {
    const x = archiefKlaar();
    if (!Array.isArray(geheim.resultaten)) throw new Weigering('resultaten ontbreken');
    return Object.assign({ ok: true }, x.A.aiZet(x.a, geheim.resultaten, geheim.model, geheim.gestuurd));
  },
  // Extra namen die niet naar het taalmodel mogen (meisjesnaam, kinderen). Alleen machinekamer, alleen via de CLI (stdin {namen: [...]}),
  // niet via /smal/bank; de namen staan alleen in het archief (meta), nooit in de code of de uitvoer.
  async masker() {
    const x = archiefKlaar();
    if (!Array.isArray(geheim.namen)) throw new Weigering('stdin {namen: [...]} ontbreekt');
    return Object.assign({ ok: true }, x.A.maskerZet(x.a, geheim.namen));
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
      const weg = [];
      ss.rekeningen.forEach(function (h) {
        if (s.rekeningen[h] && s.rekeningen[h].sessie === id) {
          weg.push(h);
          db().prepare('DELETE FROM tx WHERE rek = ?').run(h); db().prepare('DELETE FROM saldo WHERE rek = ?').run(h);
          delete s.rekeningen[h]; delete s.opgehaald[h];
        }
      });
      delete s.sessies[id];
      standSchrijf(s);
      // wv687: het archief blijft (rekening krijgt status ontkoppeld); wissen alleen op Davids uitdrukkelijke woord, met de hand
      archiefVeilig('ontkoppel', function (A, x) { A.markeerOntkoppeld(x, weg); A.rekeningenSync(x, s.rekeningen); });
      return { ok: true, sessie: id, bank: bank, gewist: true, archief: 'bewaard (rekening op ontkoppeld)' };
    });
  },
};

// ── start ─────────────────────────────────────────────────────────────────
async function hoofd() {
  const opdracht = process.argv[2];
  if (!opdracht || !Object.hasOwn(opdrachten, opdracht)) uit({ ok: false, fout: 'gebruik: ' + Object.keys(opdrachten).join(' | ') }, 2);
  // Enable Banking-sleutel alleen verplicht voor opdrachten die alleen Enable Banking raken; saldo/transacties/toestemming
  // werken per rekening door (bunq zonder EB-sleutel en andersom).
  const alleenEb = ['applicatie', 'banken', 'koppel-start', 'koppel-af', 'ontkoppel'];
  let invoer = '';
  if (!process.stdin.isTTY) { for await (const c of process.stdin) { invoer += c; if (invoer.length > 64 * 1024) break; } }
  try { geheim = invoer.trim() ? JSON.parse(invoer) : {}; } catch (e) { uit({ ok: false, fout: 'stdin is geen JSON' }, 2); }
  if ((alleenEb.indexOf(opdracht) >= 0 || (opdracht === 'historie' && process.argv[3] !== 'bunq')) && (!geheim.sleutel || !geheim.app_id)) uit({ ok: false, fout: 'sleutel of applicatie-id ontbreekt (kluis: enablebanking_app_key, enablebanking_app_id)' }, 1);
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
