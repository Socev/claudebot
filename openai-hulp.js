'use strict';
/*
 * openai-hulp.js — gedeelde OpenAI-aanroep van de pod (wv2055, 30-10-2026). Opdracht: Davids Ja 30-10 22:09 (vraag-id afd66b6a) op "Mag ik
 * het OpenAI-tegoed inzetten voor het zware leeswerk, met een eigen sleutel en een maandplafond?". Box-rij #openai-tegoed.
 *
 * WAAROM. ChatGPT Business geeft elke maand API-tegoed (30-10: $1.745,18, auto-reload uit). Leeswerk dat nu Claude-quotum kost kan daarheen,
 * maar alleen langs dezelfde poorten als de Claude-aanroepen van de pod (pdf-lezer.js) en met een eigen kostenteller: het resterende tegoed is
 * met een projectsleutel NIET op te vragen (gemeten 30-10: credit_grants alleen met een browsersessie, /organization/costs mist api.usage.read).
 *
 * STROOM per aanroep (vraag) en per batch (batchIndienen):
 *  1. schakelaar (openai.json "aan"), model uit de vaste prijstabel (onbekend model = weigeren; nooit gokken wat iets kost);
 *  2. poort: elke tekst eerst door de patiëntpoort (patientpoort-2.0, tegenhouden zoals bij pdf-lezer en MailMan; fout of geen uitslag = dicht)
 *     en door een geheimenfilter (sleutels,
 *     tokens, wachtwoordregels). Raak = niet naar OpenAI, één rij met status poort/geheim, nooit de tekst;
 *  3. zachte grens (wv2078, 31-10-2026): het tegoed geldt per JAARCYCLUS (David 31-10: jaarlijks betaald, verloopt 19-08-2027). Binnen
 *     de cyclus een maandtempo: grens deze kalendermaand = (tegoed − verbruik vóór deze maand) / resterende maanden × het deel van de maand
 *     dat in de cyclus valt. Maandtotaal + open reserveringen + schatting van deze aanroep (invoer ≈ tekens/3, uitvoer = max_uit,
 *     ongecachet) > die grens, of boven het tegoed van de cyclus → weigeren (status grens); buiten de cyclus → status cyclus.
 *     Instelbaar in openai.json: tegoed_usd, cyclus_eind (en eventueel cyclus_start; zonder = eind − 1 jaar, gevlagd als afgeleid);
 *  4. aanroep: POST /v1/responses met store:false; werkelijk verbruik uit usage van het antwoord, met het model uit het antwoord;
 *  5. telling: één rij in openai.sqlite (tabel aanroep): model, tokens in/cache/uit, batch ja/nee, usd, prijsdatum. Nooit tekst of sleutel.
 * Batch: JSONL naar /v1/files (purpose batch), /v1/batches op /v1/responses (24 u). batchTik haalt klare batches op, telt per regel tegen de
 * batchprijs, legt de antwoorden in <dir>/batch/<id>.jsonl (0600) en wist de bestanden bij OpenAI.
 *
 * SLEUTEL. Kluisnaam openai_api_key (projectsleutel, project van David met een eigen maandbudget = de harde rem). NIET op de witte lijst van
 * de pod: server.js leest hem via de Management-API (zoals pdfSleutel) en geeft hem via o.sleutel(); hier alleen als Authorization-kop.
 * Nooit in process.env (de Codex-CLI zou een OPENAI_API_KEY oppakken), nooit in een log, antwoord of rij.
 *
 * VORM. Alleen crypto, fs, path en node:sqlite; netwerk via global fetch naar o.api (standaard https://api.openai.com; toetsen 127.0.0.1).
 * De patiëntpoort komt via maak({ poort }) van server.js. Toets: test/openai-hulp.sh (nep-API, verzonnen teksten; de repo is openbaar).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSIE = 'openai-hulp-1.1';
// Prijzen per miljoen tokens (developers.openai.com/api/docs/pricing, gelezen 30-10-2026, tabellen Standard en Batch). cache_schrijven = de
// "12h write"-kolom (de hoogste; de API gaf 30-10 prompt_cache_retention 24h), alleen bij modellen die schrijfkosten rekenen. Modellen zonder
// eigen rij hier worden geweigerd. Lange context (> 272k invoer) bij gpt-5.4/5.5 (lang: true) kost meer: de hulp weigert dat vooraf (LANG_MAX)
// en rekent het achteraf dubbel met de vlag prijs_onbekend, tenzij de rij een eigen lange-contexttarief heeft (lang_p). datum = eigen leesdatum.
const PRIJS_DATUM = '2026-10-30';
const PRIJZEN = {
  // wv2078: gelezen 31-10-2026 op developers.openai.com/api/docs/pricing (Standard en Batch, korte én lange context > 272k; schrijven = 12h write)
  'gpt-6.1-terra': { in: 1, cache: 0.05, schrijf: 2.5, uit: 5, b_in: 0.5, b_cache: 0.025, b_schrijf: 1.25, b_uit: 2.5, datum: '2026-10-31',
    lang_p: { in: 2, cache: 0.1, schrijf: 5, uit: 7.5, b_in: 1, b_cache: 0.05, b_schrijf: 2.5, b_uit: 3.75 } },
  'gpt-6-astra': { in: 10, cache: 1, schrijf: 25, uit: 50, b_in: 5, b_cache: 0.5, b_schrijf: 12.5, b_uit: 25 },
  'gpt-6-sol': { in: 2, cache: 0.2, schrijf: 5, uit: 10, b_in: 1, b_cache: 0.1, b_schrijf: 2.5, b_uit: 5 },
  'gpt-6-luna': { in: 0.10, cache: 0.01, schrijf: 0.25, uit: 0.50, b_in: 0.05, b_cache: 0.005, b_schrijf: 0.125, b_uit: 0.25 },
  'gpt-5.6-sol': { in: 4, cache: 0.4, schrijf: 10, uit: 20, b_in: 2, b_cache: 0.2, b_schrijf: 5, b_uit: 10 },
  'gpt-5.6-terra': { in: 2, cache: 0.2, schrijf: 5, uit: 12, b_in: 1, b_cache: 0.1, b_schrijf: 2.5, b_uit: 6 },
  'gpt-5.6-luna': { in: 0.20, cache: 0.02, schrijf: 0.5, uit: 1.2, b_in: 0.10, b_cache: 0.01, b_schrijf: 0.25, b_uit: 0.6 },
  'gpt-5.5': { in: 5, cache: 0.5, uit: 30, b_in: 2.5, b_cache: 0.25, b_uit: 15, lang: true },
  'gpt-5.4': { in: 2.5, cache: 0.25, uit: 15, b_in: 1.25, b_cache: 0.13, b_uit: 7.5, lang: true },
  'gpt-5.4-mini': { in: 0.75, cache: 0.075, uit: 4.5, b_in: 0.375, b_cache: 0.0375, b_uit: 2.25 },
  'gpt-5.4-nano': { in: 0.20, cache: 0.02, uit: 1.25, b_in: 0.10, b_cache: 0.01, b_uit: 0.625 },
  'gpt-5-mini': { in: 0.25, cache: 0.025, uit: 2, b_in: 0.125, b_cache: 0.0125, b_uit: 1 },
  'gpt-5-nano': { in: 0.05, cache: 0.005, uit: 0.4, b_in: 0.025, b_cache: 0.0025, b_uit: 0.2 },
};
/*
 * Beeldmodellen (wv2078; David 31-10: beeldgeneratie hoort bij de gerichte inzet). Per miljoen tokens, gelezen 31-10-2026 op dezelfde
 * prijspagina (Standard en Batch; per-beeldprijzen staan daar niet, alleen tokens). t_uit null = tekstuitvoer niet genoemd. Er is nog GEEN
 * beeldroute: kostenBeeld staat klaar zodat een latere route meteen telt; tegen een echt antwoord is hij nog niet gemeten.
 */
const BEELD_DATUM = '2026-10-31';
const BEELDPRIJZEN = {
  'gpt-image-2.5-sunburst': { t_in: 5, t_cache: 1.25, b_in: 8, b_cache: 2, b_uit: 30, t_uit: null, batch: { t_in: 2.5, t_cache: 0.625, b_in: 4, b_cache: 1, b_uit: 15, t_uit: null } },
  'gpt-image-2.5-flare': { t_in: 5, t_cache: 1.25, b_in: 8, b_cache: 2, b_uit: 30, t_uit: null, batch: { t_in: 2.5, t_cache: 0.625, b_in: 4, b_cache: 1, b_uit: 15, t_uit: null } },
  'gpt-image-2': { t_in: 5, t_cache: 1.25, b_in: 8, b_cache: 2, b_uit: 30, t_uit: null, batch: { t_in: 2.5, t_cache: 0.625, b_in: 4, b_cache: 1, b_uit: 15, t_uit: null } },
  'gpt-image-1.5': { t_in: 5, t_cache: 1.25, b_in: 8, b_cache: 2, b_uit: 32, t_uit: 10, batch: { t_in: 2.5, t_cache: 0.63, b_in: 4, b_cache: 1, b_uit: 16, t_uit: 5 } },
  'gpt-image-1-mini': { t_in: 2, t_cache: 0.2, b_in: 2.5, b_cache: 0.25, b_uit: 8, t_uit: null, batch: { t_in: 1, t_cache: 0.1, b_in: 1.25, b_cache: 0.13, b_uit: 4, t_uit: null } },
  'chatgpt-image-latest': { t_in: 5, t_cache: 1.25, b_in: 8, b_cache: 2, b_uit: 32, t_uit: 10, batch: { t_in: 2.5, t_cache: 0.63, b_in: 4, b_cache: 1, b_uit: 16, t_uit: 5 } },
};
const LANG_MAX = 272000;        // invoertokens: daarboven een ander tarief → weigeren
const STANDAARD = {
  aan: false,                   // hoofdschakelaar; uit = elke aanroep geweigerd (status uit)
  tegoed_usd: 1745.18,          // tegoed van de jaarcyclus (David 30-10; 31-10 noemde hij $ 1.730): instelbaar in openai.json
  cyclus_eind: '2027-08-19',    // David 31-10: het tegoed verloopt op 19-08-2027 (00:00 Nederlandse tijd = eerste dag zonder tegoed)
  cyclus_start: null,           // niet genoemd: dan cyclus_eind − 1 jaar, in stand() gevlagd als afgeleid
  standaard_model: 'gpt-5.4-mini',
  per_uur: 300,                 // synchrone aanroepen per uur
  max_tekens: 600000,           // invoer per aanroep (instructies + invoer)
  max_uit: 32000,
  batch_max: 5000,              // verzoeken per batch
  ms: 300000,                   // time-out per synchrone aanroep
};
const AFNEMER = /^[a-z0-9][a-z0-9-]{0,39}$/;
// Geheimen die nooit in een prompt horen (grondwet 2). Vorm-herkenning, geen inhoud: raak = niet versturen.
const GEHEIM = [
  /\bsk-(proj-|ant-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/, /\bsbp_[a-f0-9]{30,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/, /\bxox[abpr]-[A-Za-z0-9-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\./,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/, /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/i,
  /\b(wachtwoord|password|passwd|pwd)\s*[:=]\s*\S{6,}/i,
];

function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function kort(s, n) { return s == null ? null : String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n); }
function rond(x) { return Math.round(x * 1e6) / 1e6; }
function geheimIn(t) { return GEHEIM.some(function (r) { return r.test(t); }); }
// maskeer: true (bijv. een diff met verzonnen toetssleutels) → elk geheim-vormig stuk wordt '[geheim-gemaskeerd]' in plaats van weigeren
function maskeer(t) {
  let n = 0, uit = String(t);
  for (const r of GEHEIM) uit = uit.replace(new RegExp(r.source, r.flags.indexOf('g') >= 0 ? r.flags : r.flags + 'g'), function () { n++; return '[geheim-gemaskeerd]'; });
  return { tekst: uit, n: n };
}
// Model uit het antwoord ("gpt-5.4-mini-2026-03-17") → rij in de tabel; eerst exact, dan zonder datumstaart.
function prijsDatum(model) { const k = prijsSleutel(model); return k && PRIJZEN[k].datum ? PRIJZEN[k].datum : PRIJS_DATUM; }
function prijsSleutel(model) {
  const m = String(model || '');
  if (Object.prototype.hasOwnProperty.call(PRIJZEN, m)) return m;
  const z = m.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return Object.prototype.hasOwnProperty.call(PRIJZEN, z) ? z : null;
}
/*
 * usage van de Responses-API → dollars. input_tokens telt cached_tokens mee (OpenAI-documentatie); of cache_write_tokens daarin zit is niet
 * gemeten, dus rekenen we het voorzichtig: (invoer − cache) tegen het volle tarief én de schrijftokens tegen het schrijftarief (kan iets te
 * hoog uitvallen, nooit te laag). output_tokens bevat de redeneertokens. Onbekend model: de duurste rij, met vlag.
 */
function kosten(model, u, batch) {
  u = isObj(u) ? u : {};
  const d = isObj(u.input_tokens_details) ? u.input_tokens_details : {};
  const inT = Number(u.input_tokens) || 0, uitT = Number(u.output_tokens) || 0;
  const cache = Math.min(inT, Number(d.cached_tokens) || 0), schrijf = Number(d.cache_write_tokens) || 0;
  const red = isObj(u.output_tokens_details) ? Number(u.output_tokens_details.reasoning_tokens) || 0 : 0;
  const k = prijsSleutel(model);
  const p = k ? PRIJZEN[k] : PRIJZEN['gpt-6-astra'];
  // Lange context (> 272k invoer): het eigen tarief van de rij (lang_p, wv2078), anders dubbel rekenen en vlaggen (review wv2055 KAN 1)
  const langP = inT > LANG_MAX && p.lang_p ? p.lang_p : null;
  const t = tarief(langP || p, batch);
  const lang = !langP && p.lang && inT > LANG_MAX ? 2 : 1;
  const usd = lang * ((inT - cache) * t.in + cache * t.cache + schrijf * t.schrijf + uitT * t.uit) / 1e6;
  return { usd: rond(usd), in: inT, cache: cache, schrijf: schrijf, uit: uitT, redeneer: red, prijs_onbekend: !k || lang > 1 };
}
// Tarief van één prijsrij, standaard of batch; schrijven zonder eigen tarief = het invoertarief
function tarief(p, batch) {
  const pin = batch ? p.b_in : p.in;
  return { in: pin, cache: batch ? p.b_cache : p.cache, schrijf: (batch ? p.b_schrijf : p.schrijf) || pin, uit: batch ? p.b_uit : p.uit };
}
/*
 * Beeldkosten uit de usage van een beeldantwoord (wv2078, nog geen route): input_tokens_details.text_tokens/image_tokens, cached_tokens
 * (ongesplitst: gerekend tegen het hoogste cachetarief), output_tokens_details.text_tokens (zonder eigen tarief: tegen het beeldtarief).
 * Ontbreekt de splitsing, dan telt alles als beeld (duurste kant). → null bij een onbekend beeldmodel.
 */
function kostenBeeld(model, u, batch) {
  const m = String(model || '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (!Object.prototype.hasOwnProperty.call(BEELDPRIJZEN, m)) return null;
  const p = batch ? BEELDPRIJZEN[m].batch : BEELDPRIJZEN[m];
  u = isObj(u) ? u : {};
  const di = isObj(u.input_tokens_details) ? u.input_tokens_details : {}, du = isObj(u.output_tokens_details) ? u.output_tokens_details : {};
  const inT = Number(u.input_tokens) || 0, uitT = Number(u.output_tokens) || 0;
  const tIn = Math.min(inT, Number(di.text_tokens) || 0), bIn = inT - tIn;
  const cache = Math.min(inT, Number(di.cached_tokens) || 0);
  const tUit = p.t_uit == null ? 0 : Math.min(uitT, Number(du.text_tokens) || 0);
  // de cache eerst van de (goedkopere) tekst af: zo valt het nooit te laag uit
  const vol = Math.max(0, tIn - cache) * p.t_in + Math.max(0, bIn - Math.max(0, cache - tIn)) * p.b_in;
  const usd = (vol + cache * Math.max(p.b_cache, p.t_cache) + (uitT - tUit) * p.b_uit + tUit * (p.t_uit || 0)) / 1e6;
  return { usd: rond(usd), in: inT, cache: cache, schrijf: 0, uit: uitT, redeneer: 0, prijs_onbekend: false };
}
function schatting(model, tekens, maxUit, batch) {
  const p = PRIJZEN[model];
  const inT = Math.ceil(tekens / 3) + 200;
  return rond((inT * (batch ? p.b_in : p.in) + maxUit * (batch ? p.b_uit : p.uit)) / 1e6);
}
// Periode (Nederlandse tijd) waarin ms valt: begint op reset_dag 00:00. → 'JJJJ-MM-DD' van de start.
function periodeVan(ms, resetDag) {
  const d = new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  let j = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
  const dag = Number(d.slice(8, 10)), r = Math.min(28, Math.max(1, Math.floor(Number(resetDag) || 1)));
  if (dag < r) { m -= 1; if (m < 1) { m = 12; j -= 1; } }
  return j + '-' + String(m).padStart(2, '0') + '-' + String(r).padStart(2, '0');
}
// 'JJJJ-MM-DD' (00:00 Nederlandse tijd) → ISO-tijdstip in UTC, om op t te kunnen tellen (review wv2055 KAN 2: reset_dag wijzigen mag de
// telling niet op 0 zetten)
function startIso(dag) {
  const g = Date.UTC(Number(dag.slice(0, 4)), Number(dag.slice(5, 7)) - 1, Number(dag.slice(8, 10)));
  const l = new Date(g).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }).replace(' ', 'T') + 'Z';
  return new Date(g - (Date.parse(l) - g)).toISOString();
}
// ── Jaarcyclus en maandtempo (wv2078). Dagen als 'JJJJ-MM-DD' in Nederlandse tijd; een dag begint om 00:00 NL (startIso).
const DAG = /^\d{4}-\d{2}-\d{2}$/;
function dagNL(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
function dagUtc(dag) { return Date.UTC(Number(dag.slice(0, 4)), Number(dag.slice(5, 7)) - 1, Number(dag.slice(8, 10))); }
function dagUit(ms) { return new Date(ms).toISOString().slice(0, 10); }
function echteDag(d) { return typeof d === 'string' && DAG.test(d) && dagUit(dagUtc(d)) === d; }
function maandBegin(dag) { return dag.slice(0, 8) + '01'; }
function volgendeMaand(dag) { const j = Number(dag.slice(0, 4)), m = Number(dag.slice(5, 7)); return m === 12 ? (j + 1) + '-01-01' : j + '-' + String(m + 1).padStart(2, '0') + '-01'; }
function jaarEerder(dag) { const d = new Date(dagUtc(dag)); d.setUTCFullYear(d.getUTCFullYear() - 1); return dagUit(d.getTime()); }
function dagen(van, tot) { return Math.round((dagUtc(tot) - dagUtc(van)) / 864e5); }
/*
 * Waar ms valt in de cyclus [start, eind): de kalendermaand (ingekort tot de cyclus), welk deel van die kalendermaand in de cyclus valt
 * (maand_deel), hoeveel maanden er vanaf het begin van deze maand nog over zijn (delen van maanden naar rato van de dagen) en welk deel van
 * deze maand voorbij is. Buiten de cyclus: binnen false.
 */
function cyclusVan(ms, start, eind) {
  const nuDag = dagNL(ms), km = maandBegin(nuDag), kv = volgendeMaand(km);
  const mb = km < start ? start : km, me = kv > eind ? eind : kv;
  const binnen = nuDag >= start && nuDag < eind;
  let over = 0;
  for (let a = km; a < eind; a = volgendeMaand(a)) {
    const b = volgendeMaand(a), van = a < mb ? mb : a, tot = b > eind ? eind : b;
    if (tot > van) over += dagen(van, tot) / dagen(a, b);
  }
  const t0 = Date.parse(startIso(mb)), t1 = Date.parse(startIso(me));
  return { binnen: binnen, maand_begin: mb, maand_eind: me, maand_deel: binnen ? dagen(mb, me) / dagen(km, kv) : 0, maanden_over: binnen ? over : 0,
    verstreken: binnen && t1 > t0 ? Math.min(1, Math.max(0, (ms - t0) / (t1 - t0))) : null,
    cyclus_verstreken: Math.min(1, Math.max(0, (ms - Date.parse(startIso(start))) / (Date.parse(startIso(eind)) - Date.parse(startIso(start))))) };
}
const GESLAAGD = ['ok', 'onvolledig'];
function isFout(status) { return /^api_/.test(status) || status === 'fout'; }

// Tekst uit een Responses-antwoord: alle output_text-delen achter elkaar.
function tekstVan(r) {
  const out = [];
  for (const o of (r && Array.isArray(r.output) ? r.output : [])) {
    if (!o || o.type !== 'message' || !Array.isArray(o.content)) continue;
    for (const c of o.content) if (c && c.type === 'output_text' && typeof c.text === 'string') out.push(c.text);
  }
  return out.join('');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS aanroep (id INTEGER PRIMARY KEY, t TEXT NOT NULL, periode TEXT NOT NULL, afnemer TEXT NOT NULL, model TEXT,
  batch INTEGER NOT NULL DEFAULT 0, invoer INTEGER NOT NULL DEFAULT 0, cache_lees INTEGER NOT NULL DEFAULT 0, cache_schrijf INTEGER NOT NULL DEFAULT 0,
  uitvoer INTEGER NOT NULL DEFAULT 0, redeneer INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, prijs_datum TEXT, prijs_onbekend INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, fout TEXT, ref TEXT, ms INTEGER);
CREATE INDEX IF NOT EXISTS aanroep_periode ON aanroep(periode);
CREATE TABLE IF NOT EXISTS batch (id TEXT PRIMARY KEY, afnemer TEXT NOT NULL, model TEXT NOT NULL, aantal INTEGER NOT NULL, geweigerd INTEGER NOT NULL DEFAULT 0,
  ingediend TEXT NOT NULL, status TEXT NOT NULL, reserve_usd REAL NOT NULL, invoer_bestand TEXT, uitvoer_bestand TEXT, fout_bestand TEXT,
  afgerond TEXT, usd REAL, klaar INTEGER NOT NULL DEFAULT 0, mislukt INTEGER NOT NULL DEFAULT 0);
`;

function maak(o) {
  o = o || {};
  const dir = o.dir;
  if (!dir) throw new Error('openai-hulp: dir ontbreekt');
  const API = String(o.api || 'https://api.openai.com').replace(/\/$/, '');
  if (!/^https:\/\/api\.openai\.com$|^http:\/\/127\.0\.0\.1:\d+$/.test(API)) throw new Error('openai-hulp: onverwachte api-basis');
  const nu = o.nu || Date.now;
  const fout = o.fout || function () {};
  const log = o.log || function () {};
  const INST = path.join(dir, 'openai.json');
  const BATCHMAP = path.join(dir, 'batch');
  fs.mkdirSync(BATCHMAP, { recursive: true, mode: 0o700 });

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'openai.sqlite'));
  try { fs.chmodSync(path.join(dir, 'openai.sqlite'), 0o600); } catch (e) {}
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  let instBuf = null;
  function inst() {
    if (instBuf && nu() - instBuf.t < 60000) return instBuf.i;
    let j = {};
    try { j = JSON.parse(fs.readFileSync(INST, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') fout('openai-inst', e); }
    const i = Object.assign({}, STANDAARD, isObj(j) ? j : {});
    i.aan = i.aan === true;
    i.tegoed_usd = Number(i.tegoed_usd) > 0 ? Number(i.tegoed_usd) : STANDAARD.tegoed_usd;
    // wv2078: grens_usd, grens_pct en reset_dag bestaan niet meer; de grens volgt uit de cyclus (grensStand)
    if (!echteDag(i.cyclus_eind)) i.cyclus_eind = STANDAARD.cyclus_eind;
    i.start_afgeleid = !echteDag(i.cyclus_start) || i.cyclus_start >= i.cyclus_eind;
    if (i.start_afgeleid) i.cyclus_start = jaarEerder(i.cyclus_eind);
    if (!PRIJZEN[i.standaard_model]) i.standaard_model = STANDAARD.standaard_model;
    instBuf = { t: nu(), i: i };
    return i;
  }
  const tel = { gereserveerd: 0, uur: [], sleutel: 'nog_niet_gevraagd', tik_bezig: false };
  // Som van usd in [van, tot) (dagen, Nederlandse tijd); open batches tellen apart (hun reservering, tot ze klaar zijn)
  function som(van, tot) { return rond(db.prepare('SELECT COALESCE(SUM(usd), 0) AS u FROM aanroep WHERE t >= ? AND t < ?').get(startIso(van), startIso(tot)).u); }
  function openBatchUsd() { return rond(db.prepare('SELECT COALESCE(SUM(reserve_usd), 0) AS u FROM batch WHERE klaar = 0').get().u); }
  /*
   * Grens van nu (wv2078): rest bij het begin van deze maand = tegoed − verbruik in de cyclus vóór deze maand; tempo = rest / resterende
   * maanden; grens deze maand = tempo × het deel van de maand dat in de cyclus valt. Wat een maand overhoudt, schuift door naar de rest.
   * oordeel: op_koers, te_snel (dit maandtempo doorgetrokken komt boven de grens; de eerste 10 % van de maand gedempt), grens_bereikt, buiten_cyclus.
   */
  function grensStand() {
    const i = inst(), t = nu();
    const c = cyclusVan(t, i.cyclus_start, i.cyclus_eind);
    const voor = c.binnen ? som(i.cyclus_start, c.maand_begin) : 0;
    const maand = som(c.maand_begin, c.maand_eind), cyclus = som(i.cyclus_start, i.cyclus_eind), open = openBatchUsd();
    const rest0 = Math.max(0, rond(i.tegoed_usd - voor));
    const tempo = c.maanden_over > 0 ? rond(rest0 / c.maanden_over) : 0;
    const grens = c.binnen ? rond(tempo * c.maand_deel) : 0;
    const projectie = c.verstreken == null ? null : rond(maand / Math.max(0.1, c.verstreken));
    const oordeel = !c.binnen ? 'buiten_cyclus' : maand + open >= grens ? 'grens_bereikt' : projectie > grens ? 'te_snel' : 'op_koers';
    return { binnen: c.binnen, tegoed: i.tegoed_usd, grens: grens, maand_usd: maand, open_batch: open, cyclus_usd: cyclus,
      cyclus: { start: i.cyclus_start, eind: i.cyclus_eind, start_afgeleid: i.start_afgeleid, usd: cyclus, rest_usd: rond(Math.max(0, i.tegoed_usd - cyclus - open)),
        rest_begin_maand_usd: rest0, maanden_over: Math.round(c.maanden_over * 100) / 100, tempo_usd: tempo, verstreken: Math.round(c.cyclus_verstreken * 1000) / 1000 },
      maand: { begin: c.maand_begin, eind: c.maand_eind, usd: maand, grens_usd: grens, over_usd: rond(Math.max(0, grens - maand - open)),
        verstreken: c.verstreken == null ? null : Math.round(c.verstreken * 1000) / 1000, projectie_usd: projectie, oordeel: oordeel } };
  }
  // null = mag; anders de weigerstatus. extra = schatting van deze aanroep (de lopende reserveringen tellen mee)
  function grensWeigering(extra) {
    const g = grensStand();
    if (!g.binnen) return 'cyclus';
    const bij = g.open_batch + tel.gereserveerd + extra;
    return g.maand_usd + bij > g.grens || g.cyclus_usd + bij > g.tegoed ? 'grens' : null;
  }
  function rijRuw(r) {
      db.prepare(`INSERT INTO aanroep (t, periode, afnemer, model, batch, invoer, cache_lees, cache_schrijf, uitvoer, redeneer, usd, prijs_datum,
        prijs_onbekend, status, fout, ref, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(new Date(nu()).toISOString(),
        periodeVan(nu(), 1), r.afnemer, r.model || null, r.batch ? 1 : 0, r.in || 0, r.cache || 0, r.schrijf || 0, r.uit || 0,
        r.redeneer || 0, r.usd || 0, prijsDatum(r.model), r.prijs_onbekend ? 1 : 0, r.status, kort(r.fout, 120), kort(r.ref, 80), r.ms == null ? null : r.ms);
  }
  function rij(r) { try { rijRuw(r); } catch (e) { fout('openai-rij', e); } }
  async function sleutel() {
    let k = null;
    try { k = await o.sleutel(); } catch (e) { tel.sleutel = 'kluis_fout'; fout('openai-sleutel', e); return null; }
    tel.sleutel = k ? 'aanwezig' : 'ontbreekt';
    return k || null;
  }
  // Poort: patiëntpoort (fail-closed) + geheimenfilter. → null (vrij) of 'poort' / 'geheim'
  // Exacte waarden van de pod-geheimen (server.js geeft ze via o.geheimen; review wv2055 KAN 4): vorm-herkenning ziet hex/base64 niet
  function podGeheimen() {
    try { return (o.geheimen ? o.geheimen() : []).filter(function (w) { return typeof w === 'string' && w.length >= 16; }); } catch (e) { return []; }
  }
  function maskeerAlles(t) {
    const m = maskeer(t);
    let n = m.n, uit = m.tekst;
    for (const w of podGeheimen()) while (uit.indexOf(w) >= 0) { uit = uit.split(w).join('[geheim-gemaskeerd]'); n++; }
    return { tekst: uit, n: n };
  }
  function poort(teksten) {
    const t = teksten.filter(function (x) { return typeof x === 'string' && x; });
    if (t.some(geheimIn)) return 'geheim';
    const pg = podGeheimen();
    if (t.some(function (x) { return pg.some(function (w) { return x.indexOf(w) >= 0; }); })) return 'geheim';
    try {
      const b = o.poort(t);
      if (!b || b.tegenhouden !== false) return 'poort';   // zelfde beslisregel als pdf-lezer en MailMan; geen uitslag = dicht
    } catch (e) { fout('openai-poort', e); return 'poort'; }
    return null;
  }
  async function api(methode, pad, body, sl, ms, ruw) {
    const kop = { Authorization: 'Bearer ' + sl };
    if (body != null && !ruw) kop['Content-Type'] = 'application/json';
    const r = await fetch(API + pad, { method: methode, headers: kop, body: body == null ? undefined : (ruw ? body : JSON.stringify(body)),
      signal: AbortSignal.timeout(ms || 60000), redirect: 'error' });
    const tekst = await r.text();
    let j = null; try { j = JSON.parse(tekst); } catch (e) { j = null; }
    if (!r.ok) { const e = new Error('openai ' + r.status); e.status = r.status; e.soort = j && j.error && (j.error.code || j.error.type) ? kort(j.error.code || j.error.type, 60) : null; throw e; }
    return j == null ? tekst : j;
  }
  function weiger(afnemer, model, status, extra) { rij(Object.assign({ afnemer: afnemer, model: model, status: status }, extra || {})); return { ok: false, status: status }; }

  /*
   * Eén synchrone vraag. v: { afnemer, model?, instructies?, invoer, max_uit?, effort?, schema? (JSON-schema voor gestructureerde uitvoer),
 *   maskeer? (true: geheim-vormige stukken vervangen in plaats van weigeren; de patiëntpoort weigert altijd) }
   * → { ok: true, tekst, json?, model, usd, onvolledig, ms } of { ok: false, status } (uit, afnemer, model, invoer, te_groot, poort, geheim,
   *   grens, uurgrens, geen_sleutel, api_<code>, fout).
   */
  async function vraag(v) {
    v = isObj(v) ? v : {};
    const i = inst();
    const afnemer = AFNEMER.test(String(v.afnemer || '')) ? String(v.afnemer) : null;
    if (!afnemer) return { ok: false, status: 'afnemer' };
    const model = v.model == null ? i.standaard_model : String(v.model);
    if (!i.aan) return weiger(afnemer, model, 'uit');
    if (!PRIJZEN[model]) return weiger(afnemer, kort(model, 40), 'model');
    if (typeof v.invoer !== 'string' || !v.invoer) return { ok: false, status: 'invoer' };
    let instr = typeof v.instructies === 'string' ? v.instructies : '';
    let gemaskeerd = 0;
    if (v.maskeer === true) { const a = maskeerAlles(instr), b = maskeerAlles(v.invoer); instr = a.tekst; v = Object.assign({}, v, { invoer: b.tekst }); gemaskeerd = a.n + b.n; }
    const tekens = instr.length + v.invoer.length;
    if (tekens > i.max_tekens || Math.ceil(tekens / 3) > LANG_MAX) return weiger(afnemer, model, 'te_groot');
    const maxUit = Math.min(i.max_uit, Math.max(16, Math.floor(Number(v.max_uit) || 4000)));
    if (v.schema != null && !isObj(v.schema)) return { ok: false, status: 'schema' };
    const p = poort([instr, v.invoer].concat(isObj(v.schema) ? [JSON.stringify(v.schema)] : []));   // review wv2055 MOET 3: ook het schema
    if (p) return weiger(afnemer, model, p);
    const t0 = nu();
    tel.uur = tel.uur.filter(function (x) { return t0 - x < 3600000; });
    if (tel.uur.length >= i.per_uur) return weiger(afnemer, model, 'uurgrens');
    const sch = schatting(model, tekens, maxUit, false);
    const g = grensWeigering(sch);
    if (g) return weiger(afnemer, model, g);
    // Reserveren meteen na de controle, zonder await ertussen (review wv2055 MOET 2); vrijgeven in finally
    tel.uur.push(t0); tel.gereserveerd += sch;
    let verstuurd = false;
    try {
    const sl = await sleutel();
    if (!sl) return weiger(afnemer, model, 'geen_sleutel');
    const body = { model: model, input: v.invoer, max_output_tokens: maxUit, store: false };
    if (instr) body.instructions = instr;
    if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].indexOf(v.effort) >= 0) body.reasoning = { effort: v.effort };
    if (isObj(v.schema)) body.text = { format: { type: 'json_schema', name: 'antwoord', strict: true, schema: v.schema } };
    try {
      verstuurd = true;
      const r = await api('POST', '/v1/responses', body, sl, Math.min(600000, Number(v.ms) || i.ms));
      const k = kosten(r && r.model || model, r && r.usage, false);
      const tekst = tekstVan(r);
      const onvolledig = !!(r && r.status === 'incomplete');
      rij(Object.assign({ afnemer: afnemer, model: kort(r && r.model || model, 60), status: onvolledig ? 'onvolledig' : 'ok', ref: r && r.id, ms: nu() - t0 }, k));
      const uit = { ok: true, tekst: tekst, model: kort(r && r.model || model, 60), usd: k.usd, onvolledig: onvolledig, ms: nu() - t0 };
      if (gemaskeerd) uit.gemaskeerd = gemaskeerd;
      if (isObj(v.schema)) { try { uit.json = JSON.parse(tekst); } catch (e) { uit.json = null; } }
      return uit;
    } catch (e) {
      const st = e.status ? 'api_' + e.status : 'fout';
      // Time-out, verbroken verbinding of 5xx nadat het verzoek weg was: OpenAI kan het toch rekenen en met store:false is het niet terug te
      // vinden → de schatting boeken, gevlagd als geschat (review wv2055 ZOU 2). Een 4xx rekent OpenAI niet.
      const geschat = verstuurd && (!e.status || e.status >= 500);
      rij({ afnemer: afnemer, model: model, status: st, fout: (geschat ? 'geschat; ' : '') + (e.soort || kort(e.name, 40)), ms: nu() - t0,
        usd: geschat ? sch : 0, prijs_onbekend: geschat });
      if (e.status === 401 || e.status === 403) tel.sleutel = 'geweigerd';
      return { ok: false, status: st, soort: e.soort || null };
    }
    } finally { tel.gereserveerd = Math.max(0, rond(tel.gereserveerd - sch)); }
  }

  /*
   * Batch indienen. b: { afnemer, model?, instructies?, max_uit?, effort?, verzoeken: [{ id: 'a-z0-9_-', invoer }] }. Elk verzoek door de poort;
   * geraakte verzoeken gaan niet mee (geweigerd: [id], zonder reden per id in de rij). → { ok, id, aantal, geweigerd } of { ok: false, status }.
   */
  async function batchIndienen(b) {
    b = isObj(b) ? b : {};
    const i = inst();
    const afnemer = AFNEMER.test(String(b.afnemer || '')) ? String(b.afnemer) : null;
    if (!afnemer) return { ok: false, status: 'afnemer' };
    const model = b.model == null ? i.standaard_model : String(b.model);
    if (!i.aan) return weiger(afnemer, model, 'uit', { batch: 1 });
    if (!PRIJZEN[model]) return weiger(afnemer, kort(model, 40), 'model', { batch: 1 });
    const vz = Array.isArray(b.verzoeken) ? b.verzoeken : [];
    if (!vz.length || vz.length > i.batch_max) return { ok: false, status: 'aantal' };
    const instr = typeof b.instructies === 'string' ? b.instructies : '';
    const pi = poort([instr]);
    if (pi) return weiger(afnemer, model, pi, { batch: 1 });
    const maxUit = Math.min(i.max_uit, Math.max(16, Math.floor(Number(b.max_uit) || 2000)));
    const regels = [], geweigerd = [], ids = new Set();
    let sch = 0;
    for (const x of vz) {
      const id = x && /^[A-Za-z0-9_-]{1,64}$/.test(String(x.id || '')) ? String(x.id) : null;
      if (!id || ids.has(id) || typeof x.invoer !== 'string' || !x.invoer) return { ok: false, status: 'verzoek' };
      ids.add(id);
      const tekens = instr.length + x.invoer.length;
      if (tekens > i.max_tekens || Math.ceil(tekens / 3) > LANG_MAX || poort([instr, x.invoer])) { geweigerd.push(id); continue; }
      const body = { model: model, input: x.invoer, max_output_tokens: maxUit, store: false };
      if (instr) body.instructions = instr;
      if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].indexOf(b.effort) >= 0) body.reasoning = { effort: b.effort };
      regels.push(JSON.stringify({ custom_id: id, method: 'POST', url: '/v1/responses', body: body }));
      sch += schatting(model, tekens, maxUit, true);
    }
    if (geweigerd.length) rij({ afnemer: afnemer, model: model, batch: 1, status: 'poort', fout: geweigerd.length + ' verzoeken' });
    if (!regels.length) return { ok: false, status: 'poort', geweigerd: geweigerd };
    sch = rond(sch);
    const g = grensWeigering(sch);
    if (g) return weiger(afnemer, model, g, { batch: 1 });
    // Reserveren meteen na de controle (review wv2055 MOET 2); na de INSERT telt de batchrij zelf (open_batch), dus vrijgeven in finally
    tel.gereserveerd += sch;
    let bestand = null, btId = null, sl = null;
    try {
      sl = await sleutel();
      if (!sl) return weiger(afnemer, model, 'geen_sleutel', { batch: 1 });
      const grens = '----socev' + crypto.randomBytes(12).toString('hex');
      const body = Buffer.concat([Buffer.from('--' + grens + '\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nbatch\r\n--' + grens +
        // bestandsnaam in twee stukken: de datakaart-poort van uitrol.sh las hem als nieuw opslagpad (uitrol 30-10 23:18 strandde)
        '\r\nContent-Disposition: form-data; name="file"; filename="socev.' + 'jsonl"\r\nContent-Type: application/jsonl\r\n\r\n'),
        Buffer.from(regels.join('\n') + '\n'), Buffer.from('\r\n--' + grens + '--\r\n')]);
      const f = await (async function () {
        const r = await fetch(API + '/v1/files', { method: 'POST', headers: { Authorization: 'Bearer ' + sl, 'Content-Type': 'multipart/form-data; boundary=' + grens },
          body: body, signal: AbortSignal.timeout(300000), redirect: 'error' });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
        if (!r.ok || !j || !j.id) { const e = new Error('openai ' + r.status); e.status = r.status || 0; throw e; }
        return j;
      })();
      bestand = f.id;
      const bt = await api('POST', '/v1/batches', { input_file_id: f.id, endpoint: '/v1/responses', completion_window: '24h' }, sl, 60000);
      if (!bt || !bt.id) throw new Error('batch zonder id');
      btId = String(bt.id);
      db.prepare('INSERT INTO batch (id, afnemer, model, aantal, geweigerd, ingediend, status, reserve_usd, invoer_bestand) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(kort(bt.id, 80), afnemer, model, regels.length, geweigerd.length, new Date(nu()).toISOString(), kort(bt.status || 'validating', 30), sch, f.id);
      log('batch ' + kort(bt.id, 80) + ' afnemer=' + afnemer + ' model=' + model + ' n=' + regels.length + ' reserve=' + sch);
      return { ok: true, id: bt.id, aantal: regels.length, geweigerd: geweigerd, reserve_usd: sch };
    } catch (e) {
      const st = e.status ? 'api_' + e.status : 'fout';
      rij({ afnemer: afnemer, model: model, batch: 1, status: st, fout: e.soort || kort(e.name, 40) });
      // Batch wel aangemaakt maar niet vastgelegd: annuleren, anders draait hij ongeteld (review wv2055 KAN 5)
      if (btId) api('POST', '/v1/batches/' + encodeURIComponent(btId) + '/cancel', {}, sl, 30000).catch(function (x) { fout('openai-batch-annuleer', x); });
      if (bestand) api('DELETE', '/v1/files/' + encodeURIComponent(bestand), null, sl, 30000).catch(function () {});
      return { ok: false, status: st };
    } finally { tel.gereserveerd = Math.max(0, rond(tel.gereserveerd - sch)); }
  }

  // Open batches nalopen (server.js: elke 10 min). Klaar → eerst alles ophalen, dan in één transactie de verbruiksrijen, het antwoordbestand
  // (<dir>/batch/<id>.jsonl, 0600) en klaar=1; pas daarna de bestanden bij OpenAI wissen. Mislukt iets, dan blijft de batch open en telt
  // niets dubbel (review wv2055 MOET 1). Eén tik tegelijk (vlag tik_bezig).
  async function batchTik() {
    if (tel.tik_bezig) return { bezig: true };
    tel.tik_bezig = true;
    try { return await batchTikBinnen(); } finally { tel.tik_bezig = false; }
  }
  async function batchTikBinnen() {
    const open = db.prepare('SELECT * FROM batch WHERE klaar = 0 ORDER BY ingediend').all();
    if (!open.length) return { open: 0 };
    const sl = await sleutel();
    if (!sl) return { open: open.length, sleutel: false };
    const u = { open: open.length, klaar: 0, fout: 0 };
    for (const b of open) {
      try {
        const s = await api('GET', '/v1/batches/' + encodeURIComponent(b.id), null, sl, 30000);
        const st = kort(s && s.status, 30) || 'onbekend';
        if (['completed', 'failed', 'expired', 'cancelled'].indexOf(st) < 0) { db.prepare('UPDATE batch SET status = ? WHERE id = ?').run(st, b.id); continue; }
        const teksten = [], wis = [];
        for (const veld of ['output_file_id', 'error_file_id']) {
          const fid = s && s[veld];
          if (!fid) continue;
          const t = await api('GET', '/v1/files/' + encodeURIComponent(fid) + '/content', null, sl, 300000);
          teksten.push(typeof t === 'string' ? t : JSON.stringify(t));
          wis.push(fid);
        }
        const rijen = [], uitRegels = [];
        let usd = 0, mislukt = 0;
        for (const r of teksten.join('\n').split('\n')) {
          if (!r.trim()) continue;
          let j; try { j = JSON.parse(r); } catch (e) { mislukt++; continue; }
          const resp = j && j.response, lijf = resp && resp.body;
          if (resp && resp.status_code === 200 && isObj(lijf)) {
            const k = kosten(lijf.model || b.model, lijf.usage, true);
            usd += k.usd;
            rijen.push(Object.assign({ afnemer: b.afnemer, model: kort(lijf.model || b.model, 60), batch: 1, status: lijf.status === 'incomplete' ? 'onvolledig' : 'ok', ref: b.id }, k));
            uitRegels.push(JSON.stringify({ id: kort(j.custom_id, 64), ok: true, tekst: tekstVan(lijf), onvolledig: lijf.status === 'incomplete' }));
          } else {
            mislukt++;
            uitRegels.push(JSON.stringify({ id: kort(j && j.custom_id, 64), ok: false, status: resp && resp.status_code || null }));
          }
        }
        const pad = path.join(BATCHMAP, b.id.replace(/[^A-Za-z0-9_-]/g, '') + '.jsonl');
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const r of rijen) rijRuw(r);
          fs.writeFileSync(pad, uitRegels.join('\n') + (uitRegels.length ? '\n' : ''), { mode: 0o600 });
          db.prepare('UPDATE batch SET status = ?, klaar = 1, afgerond = ?, usd = ?, mislukt = ? WHERE id = ? AND klaar = 0').run(st, new Date(nu()).toISOString(), rond(usd), mislukt, b.id);
          db.exec('COMMIT');
        } catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} throw e; }
        for (const fid of wis.concat(b.invoer_bestand ? [b.invoer_bestand] : [])) api('DELETE', '/v1/files/' + encodeURIComponent(fid), null, sl, 30000).catch(function () {});
        log('batch ' + b.id + ' ' + st + ' klaar=' + rijen.length + ' mislukt=' + mislukt + ' usd=' + rond(usd));
        u.klaar++;
      } catch (e) { u.fout++; fout('openai-batch', e); }
    }
    return u;
  }
  // Stand en antwoorden van één batch (alleen voor de machinekamer-route). Antwoorden pas als hij klaar is.
  function batchStand(id) {
    const b = db.prepare('SELECT id, afnemer, model, aantal, geweigerd, ingediend, status, reserve_usd, afgerond, usd, klaar, mislukt FROM batch WHERE id = ?').get(String(id || ''));
    if (!b) return null;
    const uit = Object.assign({}, b, { klaar: !!b.klaar });
    if (b.klaar) {
      try { uit.antwoorden = fs.readFileSync(path.join(BATCHMAP, b.id.replace(/[^A-Za-z0-9_-]/g, '') + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(function (r) { return JSON.parse(r); }); }
      catch (e) { uit.antwoorden = null; }
    }
    return uit;
  }

  // Voor /health en de regel in de app: alleen bedragen, aantallen en tijden; nooit tekst, sleutel of afnemersinhoud.
  // maand_usd en grens_usd gelden voor de kalendermaand (grens = het maandtempo van de cyclus, wv2078); periode_start = begin van die maand.
  function stand() {
    const i = inst(), g = grensStand();
    return { maand_usd: g.maand_usd, open_batch_usd: g.open_batch, tegoed_usd: i.tegoed_usd, grens_usd: g.grens, periode_start: g.maand.begin,
      prijzen: PRIJS_DATUM, aan: i.aan, cyclus: g.cyclus, maand: g.maand };
  }
  function health() {
    const i = inst();
    const per = periodeVan(nu(), 1);
    const st = {};
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM aanroep WHERE periode = ? GROUP BY status').all(per)) st[r.status] = r.n;
    const l = db.prepare('SELECT t, afnemer, model, batch, status FROM aanroep ORDER BY id DESC LIMIT 1').get() || null;
    return Object.assign(stand(), { module: true, versie: VERSIE, sleutel: tel.sleutel, gereserveerd_usd: rond(tel.gereserveerd), per_status: st,
      batches_open: db.prepare('SELECT COUNT(*) AS n FROM batch WHERE klaar = 0').get().n, laatste: l, standaard_model: i.standaard_model });
  }
  /*
   * Uitsplitsing over [van, tot) voor de Verbruikspagina (wv2078). Alleen getallen: per model, per afnemer, standaard of batch, en per
   * tokensoort met tokens en dollars. De dollars per tokensoort rekent deze functie uit de tokens en de prijstabel (lange context naar het
   * eigen tarief of dubbel, zoals kosten()); usd in de rijen blijft leidend: wat niet toe te delen is (geschatte time-outs, onbekende prijs,
   * beeldmodellen) staat in niet_toegedeeld_usd.
   */
  function uitsplitsing(van, tot) {
    const rijen = db.prepare(`SELECT model, batch, status, afnemer, invoer > ${LANG_MAX} AS lang, COUNT(*) AS n, SUM(usd) AS usd, SUM(invoer) AS invoer,
      SUM(cache_lees) AS cache_lees, SUM(cache_schrijf) AS cache_schrijf, SUM(uitvoer) AS uitvoer, SUM(redeneer) AS redeneer FROM aanroep
      WHERE t >= ? AND t < ? GROUP BY model, batch, status, afnemer, lang`).all(startIso(van), startIso(tot));
    const SOORTEN = ['invoer', 'cache_lees', 'cache_schrijf', 'uitvoer', 'redeneer'];
    const leeg = function () { return { aanroepen: 0, usd: 0 }; };
    const u = { van: van, tot: tot, usd: 0, aanroepen: 0, onvolledig: 0, geweigerd: 0, fouten: 0, per_status: Object.create(null), per_model: Object.create(null), per_afnemer: Object.create(null),   // review ZOU 2: geen prototype-sleutels
      standaard: leeg(), batch: leeg(), tokens: {}, niet_toegedeeld_usd: 0 };
    for (const k of SOORTEN) u.tokens[k] = { tokens: 0, usd: 0 };
    let toegedeeld = 0;
    for (const r of rijen) {
      const n = r.n, usd = Number(r.usd) || 0, gelukt = GESLAAGD.indexOf(r.status) >= 0;
      u.usd += usd;
      u.per_status[r.status] = (u.per_status[r.status] || 0) + n;
      if (gelukt) u.aanroepen += n; else if (isFout(r.status)) u.fouten += n; else u.geweigerd += n;
      if (r.status === 'onvolledig') u.onvolledig += n;
      const mk = prijsSleutel(r.model) || kort(r.model, 60) || 'onbekend';
      const m = u.per_model[mk] || (u.per_model[mk] = { model: mk, aanroepen: 0, usd: 0, tokens: 0, bekend: !!prijsSleutel(r.model) });
      const a = u.per_afnemer[r.afnemer] || (u.per_afnemer[r.afnemer] = { afnemer: r.afnemer, aanroepen: 0, usd: 0, geweigerd: 0 });
      const sb = r.batch ? u.batch : u.standaard;
      m.usd += usd; a.usd += usd; sb.usd += usd;
      if (gelukt) { m.aanroepen += n; a.aanroepen += n; sb.aanroepen += n; } else if (!isFout(r.status)) a.geweigerd += n;
      m.tokens += (r.invoer || 0) + (r.uitvoer || 0);
      for (const k of SOORTEN) u.tokens[k].tokens += r[k] || 0;
      const pk = prijsSleutel(r.model);
      if (!pk) continue;
      const p = PRIJZEN[pk], langP = r.lang && p.lang_p ? p.lang_p : null, f = !langP && p.lang && r.lang ? 2 : 1, t = tarief(langP || p, !!r.batch);
      const d = { invoer: Math.max(0, (r.invoer || 0) - (r.cache_lees || 0)) * t.in, cache_lees: (r.cache_lees || 0) * t.cache,
        cache_schrijf: (r.cache_schrijf || 0) * t.schrijf, uitvoer: (r.uitvoer || 0) * t.uit, redeneer: (r.redeneer || 0) * t.uit };
      for (const k of SOORTEN) { u.tokens[k].usd += f * d[k] / 1e6; if (k !== 'redeneer') toegedeeld += f * d[k] / 1e6; }
    }
    const lijst = function (o) { return Object.values(o).map(function (x) { x.usd = rond(x.usd); return x; }).sort(function (a, b) { return b.usd - a.usd || b.aanroepen - a.aanroepen; }); };
    u.per_model = lijst(u.per_model); u.per_afnemer = lijst(u.per_afnemer); u.per_status = Object.assign({}, u.per_status);
    for (const k of SOORTEN) u.tokens[k].usd = rond(u.tokens[k].usd);
    u.standaard.usd = rond(u.standaard.usd); u.batch.usd = rond(u.batch.usd);
    u.usd = rond(u.usd);
    u.niet_toegedeeld_usd = u.usd - toegedeeld > 0.000005 ? rond(u.usd - toegedeeld) : 0;
    return u;
  }
  // Verbruikspagina (GET /app/tokens/openai): stand van de cyclus en de maand, uitsplitsing voor beide, dagen van deze maand, open batches.
  function verbruik() {
    const i = inst(), g = grensStand(), t = nu();
    const per_dag = [];
    const dagIdx = {};
    for (let d = g.maand.begin; d < g.maand.eind && d <= dagNL(t); d = dagUit(dagUtc(d) + 864e5)) { dagIdx[d] = per_dag.length; per_dag.push({ datum: d, usd: 0, standaard_usd: 0, batch_usd: 0, aanroepen: 0 }); }
    for (const r of db.prepare('SELECT t, batch, status, usd FROM aanroep WHERE t >= ? AND t < ?').all(startIso(g.maand.begin), startIso(g.maand.eind))) {
      const x = per_dag[dagIdx[dagNL(Date.parse(r.t))]];
      if (!x) continue;
      x.usd += r.usd || 0; x[r.batch ? 'batch_usd' : 'standaard_usd'] += r.usd || 0;
      if (GESLAAGD.indexOf(r.status) >= 0) x.aanroepen++;
    }
    for (const x of per_dag) { x.usd = rond(x.usd); x.standaard_usd = rond(x.standaard_usd); x.batch_usd = rond(x.batch_usd); }
    const open = db.prepare('SELECT ingediend, afnemer, model, aantal, status, reserve_usd FROM batch WHERE klaar = 0 ORDER BY ingediend').all();
    const aannames = ['eigen telling van de pod (OpenAI geeft het saldo niet aan een projectsleutel); maanden zijn kalendermaanden, Nederlandse tijd'];
    if (i.start_afgeleid) aannames.push('begin van de cyclus afgeleid: einddatum min één jaar');
    return { ok: true, versie: VERSIE, aan: i.aan, nu: new Date(t).toISOString(), prijzen: { tekst: PRIJS_DATUM, terra: PRIJZEN['gpt-6.1-terra'].datum, beeld: BEELD_DATUM },
      tegoed_usd: i.tegoed_usd, open_batch_usd: g.open_batch, cyclus: g.cyclus, maand: g.maand,
      deze_maand: uitsplitsing(g.maand.begin, g.maand.eind), sinds_begin: uitsplitsing(i.cyclus_start, i.cyclus_eind), per_dag: per_dag,
      open_batches: open.map(function (b) { return { ingediend: b.ingediend, afnemer: b.afnemer, model: b.model, aantal: b.aantal, status: b.status, reserve_usd: rond(b.reserve_usd) }; }),
      aannames: aannames };
  }
  function sluit() { try { db.close(); } catch (e) {} }
  return { vraag, batchIndienen, batchTik, batchStand, stand, health, verbruik, sluit };
}

module.exports = { maak, VERSIE, PRIJZEN, PRIJS_DATUM, BEELDPRIJZEN, BEELD_DATUM, _intern: { kosten, kostenBeeld, schatting, periodeVan, cyclusVan, tekstVan, geheimIn, maskeer, prijsSleutel } };
