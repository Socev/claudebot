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
 *  3. zachte grens: maandtotaal (sinds reset_dag, Nederlandse tijd) + open reserveringen + schatting van deze aanroep (invoer ≈ tekens/3,
 *     uitvoer = max_uit, ongecachet) > grens → weigeren (status grens). Grens = grens_usd, of grens_pct × tegoed_usd (standaard 80 %);
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

const VERSIE = 'openai-hulp-1.0';
// Prijzen per miljoen tokens (developers.openai.com/api/docs/pricing, gelezen 30-10-2026, tabellen Standard en Batch). cache_schrijven = de
// "12h write"-kolom (de hoogste; de API gaf 30-10 prompt_cache_retention 24h), alleen bij modellen die schrijfkosten rekenen. Modellen zonder
// eigen rij hier worden geweigerd. Lange context (> 272k invoer) bij gpt-5.4/5.5 (lang: true) kost meer: de hulp weigert dat vooraf (LANG_MAX)
// en rekent het achteraf dubbel met de vlag prijs_onbekend.
const PRIJS_DATUM = '2026-10-30';
const PRIJZEN = {
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
const LANG_MAX = 272000;        // invoertokens: daarboven een ander tarief → weigeren
const STANDAARD = {
  aan: false,                   // hoofdschakelaar; uit = elke aanroep geweigerd (status uit)
  tegoed_usd: 1745.18,          // wat David noemde (30-10); alleen voor de grens en de regel in de app
  grens_pct: 0.8,               // zachte grens = 80 % van het tegoed, tenzij grens_usd
  grens_usd: null,
  reset_dag: 1,                 // dag van de maand waarop het tegoed opnieuw begint (niet gemeten; David kan het zetten)
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
  const pin = batch ? p.b_in : p.in, pc = batch ? p.b_cache : p.cache, puit = batch ? p.b_uit : p.uit;
  const ps = (batch ? p.b_schrijf : p.schrijf) || pin;
  // Lange context (> 272k invoer) heeft een eigen, hoger tarief dat de tabel niet kent: dubbel rekenen en vlaggen (review wv2055 KAN 1)
  const lang = p.lang && inT > LANG_MAX ? 2 : 1;
  const usd = lang * ((inT - cache) * pin + cache * pc + schrijf * ps + uitT * puit) / 1e6;
  return { usd: rond(usd), in: inT, cache: cache, schrijf: schrijf, uit: uitT, redeneer: red, prijs_onbekend: !k || lang > 1 };
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
    i.grens_pct = Number(i.grens_pct) > 0 && Number(i.grens_pct) <= 1 ? Number(i.grens_pct) : STANDAARD.grens_pct;
    i.grens = Number(i.grens_usd) > 0 ? Number(i.grens_usd) : rond(i.tegoed_usd * i.grens_pct);
    if (!PRIJZEN[i.standaard_model]) i.standaard_model = STANDAARD.standaard_model;
    instBuf = { t: nu(), i: i };
    return i;
  }
  const tel = { gereserveerd: 0, uur: [], sleutel: 'nog_niet_gevraagd', tik_bezig: false };
  function maandUsd(periode) {
    const r = db.prepare('SELECT COALESCE(SUM(usd), 0) AS u FROM aanroep WHERE t >= ?').get(startIso(periode));
    const b = db.prepare("SELECT COALESCE(SUM(reserve_usd), 0) AS u FROM batch WHERE klaar = 0").get();
    return { usd: rond(r.u), open_batch: rond(b.u) };
  }
  function rijRuw(r) {
      db.prepare(`INSERT INTO aanroep (t, periode, afnemer, model, batch, invoer, cache_lees, cache_schrijf, uitvoer, redeneer, usd, prijs_datum,
        prijs_onbekend, status, fout, ref, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(new Date(nu()).toISOString(),
        periodeVan(nu(), inst().reset_dag), r.afnemer, r.model || null, r.batch ? 1 : 0, r.in || 0, r.cache || 0, r.schrijf || 0, r.uit || 0,
        r.redeneer || 0, r.usd || 0, PRIJS_DATUM, r.prijs_onbekend ? 1 : 0, r.status, kort(r.fout, 120), kort(r.ref, 80), r.ms == null ? null : r.ms);
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
    const m = maandUsd(periodeVan(t0, i.reset_dag));
    if (m.usd + m.open_batch + tel.gereserveerd + sch > i.grens) return weiger(afnemer, model, 'grens');
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
    const m = maandUsd(periodeVan(nu(), i.reset_dag));
    if (m.usd + m.open_batch + tel.gereserveerd + sch > i.grens) return weiger(afnemer, model, 'grens', { batch: 1 });
    // Reserveren meteen na de controle (review wv2055 MOET 2); na de INSERT telt de batchrij zelf (open_batch), dus vrijgeven in finally
    tel.gereserveerd += sch;
    let bestand = null, btId = null, sl = null;
    try {
      sl = await sleutel();
      if (!sl) return weiger(afnemer, model, 'geen_sleutel', { batch: 1 });
      const grens = '----socev' + crypto.randomBytes(12).toString('hex');
      const body = Buffer.concat([Buffer.from('--' + grens + '\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nbatch\r\n--' + grens +
        '\r\nContent-Disposition: form-data; name="file"; filename="socev.jsonl"\r\nContent-Type: application/jsonl\r\n\r\n'),
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
  function stand() {
    const i = inst();
    const per = periodeVan(nu(), i.reset_dag);
    const m = maandUsd(per);
    return { maand_usd: m.usd, open_batch_usd: m.open_batch, tegoed_usd: i.tegoed_usd, grens_usd: i.grens, periode_start: per, prijzen: PRIJS_DATUM, aan: i.aan };
  }
  function health() {
    const i = inst();
    const per = periodeVan(nu(), i.reset_dag);
    const st = {};
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM aanroep WHERE periode = ? GROUP BY status').all(per)) st[r.status] = r.n;
    const l = db.prepare('SELECT t, afnemer, model, batch, status FROM aanroep ORDER BY id DESC LIMIT 1').get() || null;
    return Object.assign(stand(), { module: true, versie: VERSIE, sleutel: tel.sleutel, gereserveerd_usd: rond(tel.gereserveerd), per_status: st,
      batches_open: db.prepare('SELECT COUNT(*) AS n FROM batch WHERE klaar = 0').get().n, laatste: l, standaard_model: i.standaard_model });
  }
  function sluit() { try { db.close(); } catch (e) {} }
  return { vraag, batchIndienen, batchTik, batchStand, stand, health, sluit };
}

module.exports = { maak, VERSIE, PRIJZEN, PRIJS_DATUM, _intern: { kosten, schatting, periodeVan, tekstVan, geheimIn, maskeer, prijsSleutel } };
