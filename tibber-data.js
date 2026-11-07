'use strict';
/*
 * tibber-data.js — Tibber Data API, alleen lezen (wv2625, 7-11-2026). Laadhistorie per auto en laadpaal.
 * Bouwplan: vault 01_Ontwikkeling/Tibber Data API - laadhistorie per auto (bouwplan 7-11-2026).md (review gpt-5.5 verwerkt).
 *
 * TWEE ROLLEN IN ÉÉN BESTAND.
 *  1. Module voor server.js (require): toestemmingslink maken (state + PKCE S256), state eenmalig innemen, en de dagelijkse
 *     ronde regisseren (slot, noodkopie, kluis vooraf toetsen, verversen, nieuw refresh token duurzaam opslaan, pas dan lezen).
 *     De kluis zelf (Management-API) zit in server.js en komt hier binnen als deps.kluisLees / deps.kluisZet.
 *  2. Kindproces (node tibber-data.js <opdracht>): de enige plek die Tibber aanroept. Omgeving alleen PATH/HOME/TZ/LANG en
 *     TIBBER_DIR; geheimen via stdin. Opdrachten: wissel (code → tokens), ververs (refresh → tokens), ronde (lezen en opslaan),
 *     apparaten (veldenlijst meten, alleen namen), stand (lokaal, geen netwerk).
 *
 * NETWERK. Eén fetch, in roep(), en die gaat altijd eerst door verzoekToets: POST alleen op het tokenendpoint, GET alleen op
 * /v1/homes, /v1/homes/{id}/devices, /v1/homes/{id}/devices/{id} en .../history (cursor, since, until, resolution) van
 * data-api.tibber.com. Redirects staan uit (redirect: 'error'). Een toetsbasis mag alleen http://127.0.0.1:<poort> zijn.
 *
 * OPSLAG. TIBBER_DIR (700): tibber.sqlite (600; tabellen apparaat, apparaat_historie, apparaat_cursor naast de uurtabellen van
 * wv2584), states.json (600; sha256 van de state → verifier, 48 uur, eenmalig), refresh.nood (600; alleen tussen het verversen
 * en het teruglezen uit de kluis), ronde.lock (O_EXCL), ronde.json (laatste uitkomst, geen geheimen).
 * Niet opgeslagen: naam van het apparaat, externalId (kan een VIN zijn), locatie, kenteken, e-mail, adres, EAN, id_token.
 * Uit de historie alleen velden op de witte lijst (getallen, ja/nee, korte standwoorden); onbekende veldnamen alleen als naam.
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'data-api-user-read', 'data-api-homes-read', 'data-api-vehicles-read', 'data-api-chargers-read'];
const REDIRECT = 'https://bank.socev.dev/tibber/terug';
const UA = 'Socev/1.0';
const STATE_MS = 48 * 3600 * 1000;
const SLOT_OUD_MS = 15 * 60 * 1000;
const MAX_PAGINAS = Number(process.env.TIBBER_MAX_PAGINAS) || 1500;   // per ronde, over alle apparaten; de cursor gaat de volgende dag verder
const PAUZE_MS = process.env.TIBBER_PAUZE_MS != null ? Number(process.env.TIBBER_PAUZE_MS) : 400;   // basis van de backoff (Tibber-voorbeeld: 400 ms, ×2, max 15 s)
const PAGINA_PAUZE_MS = PAUZE_MS / 2;   // beleefd tussen twee historiepagina's

function basis(v, echt) {
  if (!v) return echt;
  if (/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(v)) return v;
  throw new Error('toetsbasis alleen op 127.0.0.1');
}
const AUTH_BASIS = basis(process.env.TIBBER_AUTH_BASIS, 'https://thewall.tibber.com');
const API_BASIS = basis(process.env.TIBBER_API_BASIS, 'https://data-api.tibber.com');
const TOKEN_PAD = '/connect/token';
const AUTHORIZE = 'https://thewall.tibber.com/connect/authorize';

class TibberFout extends Error { constructor(reden, uitleg, status) { super(uitleg || reden); this.reden = reden; this.status = status || null; } }

// ── netwerk: alleen deze verzoeken ────────────────────────────────────────────────────────────────────────────────────
const ID = '[A-Za-z0-9_-]{1,80}';
const PADEN_GET = [new RegExp('^/v1/homes$'), new RegExp('^/v1/homes/' + ID + '/devices$'), new RegExp('^/v1/homes/' + ID + '/devices/' + ID + '$'),
  new RegExp('^/v1/homes/' + ID + '/devices/' + ID + '/history$')];
const HISTORIE_QUERY = { cursor: /^[\x20-\x7e]{1,2000}$/, since: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/,
  until: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/, resolution: /^(quarterHour|hour|day|month)$/ };
function verzoekToets(methode, url) {
  let u;
  try { u = new URL(url); } catch (e) { throw new TibberFout('pad', 'Tibber-adres niet toegestaan'); }
  if (u.username || u.password || u.hash) throw new TibberFout('pad', 'Tibber-adres niet toegestaan');
  if (methode === 'POST') {
    if (u.origin !== AUTH_BASIS || u.pathname !== TOKEN_PAD || u.search) throw new TibberFout('pad', 'POST alleen op het tokenendpoint');
    return u.href;
  }
  if (methode !== 'GET') throw new TibberFout('pad', 'methode niet toegestaan');
  if (u.origin !== API_BASIS) throw new TibberFout('pad', 'GET alleen op de Data API');
  const i = PADEN_GET.findIndex(function (r) { return r.test(u.pathname); });
  if (i < 0) throw new TibberFout('pad', 'Data API-pad niet toegestaan');
  const gezien = new Set();
  for (const [k, v] of u.searchParams) {
    if (i !== 3 || !Object.hasOwn(HISTORIE_QUERY, k) || !HISTORIE_QUERY[k].test(v) || gezien.has(k)) throw new TibberFout('pad', 'queryparameter niet toegestaan');
    gezien.add(k);
  }
  return u.href;
}
function slaap(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// De enige netwerkaanroep. Herhalen alleen op 429/500/502/503 (Retry-After eerst, anders full jitter), hooguit 5 pogingen.
async function roep(methode, url, o) {
  const doel = verzoekToets(methode, url);
  const headers = { Accept: 'application/json', 'User-Agent': UA };
  if (o.token) headers.Authorization = 'Bearer ' + o.token;
  if (o.form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  for (let poging = 1; ; poging++) {
    let r;
    try { r = await fetch(doel, { method: methode, headers: headers, body: o.form ? new URLSearchParams(o.form).toString() : undefined, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
    catch (e) {
      if (methode === 'GET' && poging < 5) { await slaap(Math.random() * Math.min(15000, PAUZE_MS * 2 ** poging)); continue; }
      throw new TibberFout('netwerk', 'Tibber niet bereikbaar (' + String(e && e.name || 'fout').slice(0, 40) + ')');
    }
    // POST (token) alleen op 429/503: na een 500/502 kan Tibber het eenmalige refresh token al verbruikt hebben; dan niet nog eens.
    const herhaal = methode === 'POST' ? [429, 503] : [429, 500, 502, 503];
    if (herhaal.indexOf(r.status) >= 0 && poging < 5) {
      await r.text().catch(function () {});
      const ra = Number(r.headers.get('retry-after'));
      await slaap(ra > 0 && ra <= 120 ? (PAUZE_MS ? ra * 1000 + Math.random() * 250 : 0) : Math.random() * Math.min(15000, PAUZE_MS * 2 ** poging));
      continue;
    }
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    return { status: r.status, j: j };
  }
}

// ── tokens ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const TOKEN_VORM = /^[A-Za-z0-9._~+\/=-]{16,4096}$/;
function scopesVan(j) {
  if (j && typeof j.scope === 'string') return j.scope.split(/\s+/).filter(Boolean);
  try {   // terugval: de scope-claim van het access token (JWT); alleen gelezen, niet bewaard
    const p = JSON.parse(Buffer.from(String(j.access_token).split('.')[1], 'base64url').toString('utf8'));
    if (Array.isArray(p.scope)) return p.scope.map(String);
    if (typeof p.scope === 'string') return p.scope.split(/\s+/).filter(Boolean);
  } catch (e) {}
  return null;
}
function scopesExact(lijst) {
  if (!Array.isArray(lijst)) return false;
  const a = new Set(lijst), b = new Set(SCOPES);
  return a.size === b.size && SCOPES.every(function (s) { return a.has(s); });
}
async function tokenVraag(form) {
  const r = await roep('POST', AUTH_BASIS + TOKEN_PAD, { form: form });
  const err = r.j && typeof r.j.error === 'string' ? r.j.error.replace(/[^a-z_]/g, '').slice(0, 40) : '';
  if (r.status === 400 && err === 'invalid_grant') throw new TibberFout('grant', 'Tibber: invalid_grant (verlopen, ingetrokken of al gebruikt)', 400);
  if (r.status === 400 || r.status === 401) throw new TibberFout(err === 'invalid_client' || r.status === 401 ? 'client' : 'token', 'Tibber-token: HTTP ' + r.status + (err ? ' ' + err : ''), r.status);
  if (r.status !== 200 || !r.j || typeof r.j.access_token !== 'string' || !TOKEN_VORM.test(r.j.access_token)) throw new TibberFout('token', 'Tibber-token: HTTP ' + r.status, r.status);
  const scopes = scopesVan(r.j);
  if (!scopesExact(scopes)) throw new TibberFout('scope', 'Tibber gaf andere rechten dan gevraagd (' + (scopes ? scopes.length : 0) + ' scopes; verwacht exact ' + SCOPES.length + ')');
  const refresh = typeof r.j.refresh_token === 'string' && TOKEN_VORM.test(r.j.refresh_token) ? r.j.refresh_token : null;
  return { access: r.j.access_token, refresh: refresh, verloopt_s: Number(r.j.expires_in) || null };
}
// Noodkopie: tijdelijk bestand + fsync + rename, 600. Schrijft het kind zelf meteen na het antwoord van Tibber, vóór stdout:
// stopt het proces of de pod daarna, dan staat het (eenmalige) nieuwe token toch duurzaam op schijf (review MOET 1).
function noodPad(dir) { return path.join(dir, 'refresh.nood'); }
function noodSchrijf(dir, refresh) {
  const doel = noodPad(dir), tmp = doel + '.' + process.pid + '.tmp';
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeSync(fd, JSON.stringify({ refresh: refresh, sinds: new Date().toISOString() })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, doel);
  try { const d = fs.openSync(dir, 'r'); fs.fsyncSync(d); fs.closeSync(d); } catch (e) {}
}
function noodLees(dir) {
  try { const j = JSON.parse(fs.readFileSync(noodPad(dir), 'utf8')); return j && TOKEN_VORM.test(j.refresh || '') ? j : null; } catch (e) { return null; }
}
function noodWis(dir) { try { fs.unlinkSync(noodPad(dir)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }

// ── toestemmingslink en state (in server.js aangeroepen, geen netwerk) ────────────────────────────────────────────────
function statesPad(dir) { return path.join(dir, 'states.json'); }
function statesLees(dir) { try { const j = JSON.parse(fs.readFileSync(statesPad(dir), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } }
function statesSchrijf(dir, s) {
  const tmp = statesPad(dir) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, statesPad(dir));
}
function sha(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function linkMaak(dir, clientId) {
  if (typeof clientId !== 'string' || !/^[\x21-\x7e]{4,200}$/.test(clientId)) throw new TibberFout('sleutel', 'client-id ontbreekt of heeft een vreemde vorm');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const state = crypto.randomBytes(32).toString('hex');
  const verifier = crypto.randomBytes(48).toString('base64url');   // 64 tekens
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const s = statesLees(dir), nu = Date.now();
  for (const k of Object.keys(s)) if (!s[k] || nu - Date.parse(s[k].sinds) > STATE_MS * 2) delete s[k];   // oude weg
  s[sha(state)] = { verifier: verifier, sinds: new Date(nu).toISOString() };
  statesSchrijf(dir, s);
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: SCOPES.join(' '), state: state,
    code_challenge: challenge, code_challenge_method: 'S256' });
  return { url: AUTHORIZE + '?' + q.toString(), geldig_tot: new Date(nu + STATE_MS).toISOString() };
}
function stateOpen(dir, state) {
  const w = statesLees(dir)[sha(state)];
  return !!(w && !w.verbruikt && Date.now() - Date.parse(w.sinds) <= STATE_MS);
}
// Eenmalig: markeert de state als verbruikt vóór de code wordt ingewisseld. → verifier of null.
function stateNeem(dir, state) {
  const s = statesLees(dir), k = sha(state), w = s[k];
  if (!w || w.verbruikt || Date.now() - Date.parse(w.sinds) > STATE_MS) return null;
  const v = w.verifier;
  s[k] = { sinds: w.sinds, verbruikt: new Date().toISOString() };   // verifier meteen weg
  statesSchrijf(dir, s);
  return v;
}

// ── slot (O_EXCL) ─────────────────────────────────────────────────────────────────────────────────────────────────────
function slotPad(dir) { return path.join(dir, 'ronde.lock'); }
function pidLeeft(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function slotNeem(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(slotPad(dir), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, sinds: new Date().toISOString() })); fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let w = null; try { w = JSON.parse(fs.readFileSync(slotPad(dir), 'utf8')); } catch (e2) {}
      const oud = !w || (Date.now() - Date.parse(w.sinds) > SLOT_OUD_MS && !pidLeeft(Number(w.pid)));
      if (!oud || i) return false;
      try { fs.unlinkSync(slotPad(dir)); } catch (e3) {}
    }
  }
  return false;
}
function slotLos(dir) { try { fs.unlinkSync(slotPad(dir)); } catch (e) {} }

// ── regie van een ronde (in server.js) ────────────────────────────────────────────────────────────────────────────────
// deps: { dir, kluisLees() → {client_id, client_secret, refresh, bereikbaar}, kluisZet(waarde) → sha256 teruggelezen,
//         kind(opdracht, invoer) → {code, j}, wacht(ms) }
// Volgorde (review MOET 1/2): slot → noodkopie eerst in de kluis → kluis vooraf toetsen → verversen (kind schrijft noodkopie)
// → nieuw token in de kluis + teruglezen (3 pogingen) → noodkopie weg → pas dan lezen. Lukt de kluis niet: noodkopie blijft,
// melding, geen lezen; de volgende ronde neemt de noodkopie eerst.
async function kluisBewaar(deps, waarde) {
  let laatste = null;
  for (let i = 0; i < 3; i++) {
    try { const h = await deps.kluisZet(waarde); if (h === sha(waarde)) return true; laatste = 'teruglezen gaf een andere waarde'; }
    catch (e) { laatste = String(e && e.message || e).slice(0, 120); }
    if (i < 2) await (deps.wacht || slaap)(1000 * 2 ** i);
  }
  throw new TibberFout('kluis', 'nieuw token niet in de kluis: ' + laatste);
}
async function ronde(deps, opdracht) {
  const dir = deps.dir, uit = { ok: false, begin: new Date().toISOString() };
  if (!slotNeem(dir)) return Object.assign(uit, { reden: 'bezig', fout: 'er loopt al een Tibber-ronde' });
  try {
    let k;
    try { k = await deps.kluisLees(); } catch (e) { return Object.assign(uit, { reden: 'kluis', fout: 'kluis niet bereikbaar; niets ververst' }); }
    if (!k || !k.client_id || !k.client_secret) return Object.assign(uit, { reden: 'sleutel', fout: 'client-id of -secret ontbreekt in de kluis' });
    let refresh = k.refresh || null;
    const nood = noodLees(dir);
    if (nood) {   // een eerder nieuw token dat de kluis nooit bereikte: eerst dat bewaren
      await kluisBewaar(deps, nood.refresh);
      noodWis(dir);
      refresh = nood.refresh;
      uit.nood_hersteld = true;
    }
    if (!refresh) return Object.assign(uit, { reden: 'toestemming', fout: 'nog geen toestemming (tibber_data_refresh ontbreekt)' });
    const v = await deps.kind('ververs', { client_id: k.client_id, client_secret: k.client_secret, refresh: refresh });
    if (!v.j || v.j.ok !== true) return Object.assign(uit, { reden: (v.j && v.j.reden) || 'kind', fout: (v.j && v.j.fout) || 'verversen faalde (exit ' + v.code + ')' });
    const nieuw = v.j._refresh || null;
    if (nieuw && nieuw !== refresh) {
      try { await kluisBewaar(deps, nieuw); }
      catch (e) { return Object.assign(uit, { reden: 'kluis', fout: e.message, nood: true }); }   // noodkopie blijft staan
    }
    noodWis(dir);
    uit.geroteerd = !!(nieuw && nieuw !== refresh);
    const r = await deps.kind(opdracht === 'apparaten' ? 'apparaten' : 'ronde', { access: v.j._access });
    const j = r.j || { ok: false, fout: 'lezen gaf geen JSON (exit ' + r.code + ')' };
    return Object.assign(uit, j, { begin: uit.begin, geroteerd: uit.geroteerd, nood_hersteld: uit.nood_hersteld });
  } catch (e) {
    return Object.assign(uit, { reden: e.reden || 'fout', fout: String(e && e.message || e).slice(0, 200), nood: e.reden === 'kluis' ? true : undefined });
  } finally { slotLos(dir); }
}
// Terugkeer na toestemming (in server.js). → { status, soort: 'gekoppeld'|'dicht'|'mislukt'|'scope'|'bezig', reden }
async function terug(deps, state, code, fout) {
  const dir = deps.dir;
  if (!stateOpen(dir, state)) return { status: 404, soort: 'dicht' };
  if (!slotNeem(dir)) return { status: 503, soort: 'bezig' };   // de state blijft geldig
  try {
    const verifier = stateNeem(dir, state);
    if (!verifier) return { status: 404, soort: 'dicht' };
    if (fout) return { status: 200, soort: 'mislukt', reden: 'geweigerd' };
    let k;
    try { k = await deps.kluisLees(); } catch (e) { return { status: 502, soort: 'mislukt', reden: 'kluis' }; }
    if (!k || !k.client_id || !k.client_secret) return { status: 502, soort: 'mislukt', reden: 'sleutel' };
    const w = await deps.kind('wissel', { client_id: k.client_id, client_secret: k.client_secret, code: code, verifier: verifier, redirect_uri: REDIRECT });
    if (!w.j || w.j.ok !== true) return { status: 200, soort: (w.j && w.j.reden) === 'scope' ? 'scope' : 'mislukt', reden: (w.j && w.j.reden) || 'kind' };
    if (!w.j._refresh) { noodWis(dir); return { status: 200, soort: 'mislukt', reden: 'geen refresh token (offline_access?)' }; }
    try { await kluisBewaar(deps, w.j._refresh); }
    catch (e) { return { status: 200, soort: 'gekoppeld', reden: 'kluis', nood: true }; }   // noodkopie staat; de ronde zet hem in de kluis
    noodWis(dir);
    return { status: 200, soort: 'gekoppeld' };
  } finally { slotLos(dir); }
}

// ── witte lijst historievelden ────────────────────────────────────────────────────────────────────────────────────────
function woorden(k) { return String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
const VERBODEN = new Set(['lat', 'latitude', 'lng', 'lon', 'long', 'longitude', 'location', 'locations', 'position', 'gps', 'geo', 'coordinate', 'coordinates',
  'vin', 'plate', 'license', 'licence', 'kenteken', 'name', 'email', 'mail', 'address', 'street', 'city', 'zip', 'postal', 'postcode', 'ean', 'serial',
  'owner', 'user', 'phone', 'odometer', 'mileage', 'id', 'heading', 'altitude', 'place', 'home', 'ip']);
const TOEGESTAAN = new Set(['energy', 'power', 'soc', 'charge', 'charging', 'charged', 'charger', 'battery', 'level', 'consumption', 'consumed', 'cost', 'costs',
  'import', 'imported', 'export', 'exported', 'kwh', 'wh', 'kw', 'w', 'state', 'status', 'session', 'sessions', 'duration', 'range', 'current', 'voltage',
  'percent', 'percentage', 'avg', 'average', 'min', 'max', 'sum', 'total', 'value', 'plugged', 'connected', 'grid', 'solar', 'storage']);
function veldMag(pad) {
  const w = pad.split('.').flatMap(woorden);
  if (!w.length || w.some(function (x) { return VERBODEN.has(x); })) return false;
  return w.some(function (x) { return TOEGESTAAN.has(x); });
}
// → { velden: [[pad, num|null, tekst|null]], onbekend: Set(namen) }
function plat(data) {
  const velden = [], onbekend = new Set();
  (function loop(o, pre, diep) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const k of Object.keys(o).slice(0, 100)) {
      const naam = /^[A-Za-z0-9_]{1,40}$/.test(k) ? k : '?';
      const pad = pre ? pre + '.' + naam : naam, v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {   // genest: alleen dieper als geen stuk van het pad verboden is
        if (diep < 3 && !pad.split('.').flatMap(woorden).some(function (x) { return VERBODEN.has(x); })) loop(v, pad, diep + 1); else onbekend.add(pad + '{}');
        continue;
      }
      if (Array.isArray(v)) { onbekend.add(pad + '[]'); continue; }
      const ok = veldMag(pad);
      if (ok && typeof v === 'number' && Number.isFinite(v)) velden.push([pad, v, null]);
      else if (ok && typeof v === 'boolean') velden.push([pad, v ? 1 : 0, null]);
      else if (ok && typeof v === 'string' && /^[A-Za-z_ -]{1,32}$/.test(v)) velden.push([pad, null, v]);
      else onbekend.add(pad);
    }
  })(data, '', 0);
  return { velden: velden, onbekend: onbekend };
}

// ── opslag ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function db(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, 'tibber.' + 'sqlite');
  const nieuw = !fs.existsSync(p);
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(p);
  if (nieuw) fs.chmodSync(p, 0o600);
  d.exec("pragma busy_timeout = 10000; create table if not exists apparaat (volg integer primary key, tibber_id text unique not null, home_id text not null, " +
    "label text, merk text, model text, resoluties text, max_dagen integer, onbekend text, eerst text not null, laatst text not null);" +
    "create table if not exists apparaat_historie (apparaat integer not null, resolutie text not null, tijd text not null, veld text not null, num real, tekst text, " +
    "primary key (apparaat, resolutie, tijd, veld)) without rowid;" +
    "create table if not exists apparaat_cursor (apparaat integer not null, resolutie text not null, volgende text, laatste_tijd text, bijgewerkt text, " +
    "primary key (apparaat, resolutie));");
  return d;
}
function tekst(v, n) { return typeof v === 'string' ? v.replace(/[^\p{L}\p{N} ._+-]/gu, '').slice(0, n || 40) : null; }

// ── kindopdrachten ────────────────────────────────────────────────────────────────────────────────────────────────────
function idVan(v) { return typeof v === 'string' && new RegExp('^' + ID + '$').test(v) ? v : null; }
async function haal(token, pad) {
  const r = await roep('GET', API_BASIS + pad, { token: token });
  if (r.status === 401) throw new TibberFout('token', 'Data API: 401 (token niet geldig)', 401);
  if (r.status === 403) throw new TibberFout('scope', 'Data API: 403 (recht ontbreekt)', 403);
  if (r.status !== 200 || !r.j || typeof r.j !== 'object') throw new TibberFout('http', 'Data API: HTTP ' + r.status, r.status);
  return r.j;
}
// Een next/prev-link van Tibber: alleen hetzelfde historiepad van hetzelfde apparaat, alleen toegestane query.
function volgLink(link, pad) {
  if (typeof link !== 'string' || !link || link.length > 3000) return null;
  let u;
  try { u = new URL(link, API_BASIS); } catch (e) { return null; }
  if (u.origin !== API_BASIS || u.pathname !== pad) return null;
  try { verzoekToets('GET', u.href); } catch (e) { return null; }
  return u.pathname + u.search;
}
async function apparatenLijst(token) {
  const h = await haal(token, '/v1/homes');
  const uit = [];
  for (const home of (Array.isArray(h.homes) ? h.homes : []).slice(0, 5)) {
    const hid = idVan(home && home.id); if (!hid) continue;
    const l = await haal(token, '/v1/homes/' + hid + '/devices');
    for (const dv of (Array.isArray(l.devices) ? l.devices : []).slice(0, 30)) {
      const did = idVan(dv && dv.id); if (!did) continue;
      const det = await haal(token, '/v1/homes/' + hid + '/devices/' + did);
      uit.push({ hid: hid, did: did, det: det });
    }
  }
  return uit;
}
function apparaatZet(d, a, nu) {
  const sh = a.det.supportedHistory || {}, info = a.det.info || {};
  const res = (Array.isArray(sh.resolutions) ? sh.resolutions : []).filter(function (x) { return HISTORIE_QUERY.resolution.test(x); });
  const max = Number(sh.maxRetentionDays);
  d.prepare('insert into apparaat (tibber_id, home_id, merk, model, resoluties, max_dagen, eerst, laatst) values (?, ?, ?, ?, ?, ?, ?, ?) ' +
    'on conflict (tibber_id) do update set merk = excluded.merk, model = excluded.model, resoluties = excluded.resoluties, max_dagen = excluded.max_dagen, laatst = excluded.laatst')
    .run(a.did, a.hid, tekst(info.brand), tekst(info.model), res.join(','), Number.isInteger(max) && max > 0 ? max : null, nu, nu);
  const r = d.prepare('select volg, label from apparaat where tibber_id = ?').get(a.did);
  if (!r.label) d.prepare('update apparaat set label = ? where volg = ?').run('apparaat ' + r.volg, r.volg);
  return { volg: r.volg, res: res, max: Number.isInteger(max) && max > 0 ? max : null };
}
async function kindRonde(invoer, dir) {
  const token = invoer.access;
  if (typeof token !== 'string' || !TOKEN_VORM.test(token)) throw new TibberFout('token', 'geen access token');
  const d = db(dir), nu = new Date().toISOString();
  const lijst = await apparatenLijst(token);
  const uit = { ok: true, apparaten: lijst.length, met_historie: 0, paginas: 0, punten: 0, velden: 0, onbekend: 0, klaar: true };
  let paginas = 0;
  for (const a of lijst) {
    const z = apparaatZet(d, a, nu);
    const resolutie = z.res.indexOf('hour') >= 0 ? 'hour' : (z.res.indexOf('quarterHour') >= 0 ? 'quarterHour' : null);
    if (!resolutie) continue;
    uit.met_historie++;
    const pad = '/v1/homes/' + a.hid + '/devices/' + a.did + '/history';
    const c = d.prepare('select volgende, laatste_tijd from apparaat_cursor where apparaat = ? and resolutie = ?').get(z.volg, resolutie) || {};
    let link = c.volgende || null;
    if (!link) {
      const van = c.laatste_tijd ? new Date(Date.parse(c.laatste_tijd) + 1000) : new Date(Date.now() - (z.max || 3650) * 86400000);
      link = pad + '?' + new URLSearchParams({ since: van.toISOString().slice(0, 13) + ':00:00Z', resolution: resolutie }).toString();
    }
    const onb = new Set(JSON.parse(d.prepare('select onbekend from apparaat where volg = ?').get(z.volg).onbekend || '[]'));
    const zet = d.prepare('insert or replace into apparaat_historie (apparaat, resolutie, tijd, veld, num, tekst) values (?, ?, ?, ?, ?, ?)');
    const gezien = new Set();
    let laatste = c.laatste_tijd || null;
    while (link && !gezien.has(link)) {
      if (paginas >= MAX_PAGINAS) { uit.klaar = false; break; }
      if (paginas) await slaap(PAGINA_PAUZE_MS);
      gezien.add(link); paginas++;
      const p = await haal(token, link);
      const items = Array.isArray(p.items) ? p.items : [];
      d.exec('begin');
      try {
        for (const it of items) {
          const t = it && typeof it.time === 'string' && !isNaN(Date.parse(it.time)) ? new Date(Date.parse(it.time)).toISOString() : null;
          if (!t) continue;
          const f = plat(it.data);
          f.velden.forEach(function (v) { zet.run(z.volg, resolutie, t, v[0], v[1], v[2]); uit.velden++; });
          f.onbekend.forEach(function (n) { onb.add(n); });
          uit.punten++;
          if (!laatste || t > laatste) laatste = t;
        }
        const volgende = volgLink(p.next, pad);
        d.prepare('insert into apparaat_cursor (apparaat, resolutie, volgende, laatste_tijd, bijgewerkt) values (?, ?, ?, ?, ?) on conflict (apparaat, resolutie) do update set ' +
          'volgende = excluded.volgende, laatste_tijd = excluded.laatste_tijd, bijgewerkt = excluded.bijgewerkt').run(z.volg, resolutie, volgende || (items.length ? null : link), laatste, nu);
        d.exec('commit');
        link = items.length ? volgende : null;   // lege pagina: einde bereikt; de link blijft staan voor de volgende ronde
      } catch (e) { d.exec('rollback'); throw e; }
    }
    d.prepare('update apparaat set onbekend = ? where volg = ?').run(JSON.stringify([...onb].sort().slice(0, 200)), z.volg);
    uit.onbekend += onb.size;
  }
  uit.paginas = paginas;
  d.close();
  return uit;
}
// Veldenlijst meten: alleen namen en eenheden, nooit waarden (een attribuut kan een locatie of VIN zijn).
async function kindApparaten(invoer, dir) {
  const token = invoer.access;
  if (typeof token !== 'string' || !TOKEN_VORM.test(token)) throw new TibberFout('token', 'geen access token');
  const lijst = await apparatenLijst(token);
  const d = db(dir), nu = new Date().toISOString();
  const uit = lijst.map(function (a) {
    const z = apparaatZet(d, a, nu), det = a.det;
    const r = d.prepare('select label, merk, model, onbekend from apparaat where volg = ?').get(z.volg);
    const opgeslagen = d.prepare('select veld, count(*) as n from apparaat_historie where apparaat = ? group by veld order by veld').all(z.volg);
    return { volg: z.volg, label: r.label, merk: r.merk, model: r.model, resoluties: z.res, max_dagen: z.max,
      capabilities: (Array.isArray(det.capabilities) ? det.capabilities : []).slice(0, 60).map(function (c) { return tekst(c && c.id, 60) + (c && typeof c.unit === 'string' ? ' [' + c.unit.replace(/[^\p{L}\p{N} %°\/._-]/gu, '').slice(0, 12) + ']' : ''); }),
      attributes: (Array.isArray(det.attributes) ? det.attributes : []).slice(0, 60).map(function (x) { return tekst(x && x.id, 60); }),
      historie_opgeslagen: opgeslagen.map(function (o) { return o.veld + ' (' + o.n + ')'; }), historie_onbekend: JSON.parse(r.onbekend || '[]') };
  });
  d.close();
  return { ok: true, apparaten: uit };
}
function kindStand(dir) {
  if (!fs.existsSync(path.join(dir, 'tibber.' + 'sqlite'))) return { ok: true, apparaten: [] };
  const d = db(dir);
  const a = d.prepare('select a.volg, a.label, a.merk, a.model, a.resoluties, (select count(distinct tijd) from apparaat_historie h where h.apparaat = a.volg) as punten, ' +
    '(select min(tijd) from apparaat_historie h where h.apparaat = a.volg) as van, (select max(tijd) from apparaat_historie h where h.apparaat = a.volg) as tot from apparaat a order by a.volg').all();
  d.close();
  return { ok: true, apparaten: a, nood: !!noodLees(dir) };
}
async function kind(opdracht, invoer, dir) {
  if (opdracht === 'stand') return kindStand(dir);
  if (opdracht === 'ronde') return kindRonde(invoer, dir);
  if (opdracht === 'apparaten') return kindApparaten(invoer, dir);
  if (opdracht !== 'wissel' && opdracht !== 'ververs') throw new TibberFout('opdracht', 'opdracht: wissel, ververs, ronde, apparaten, stand');
  const id = String(invoer.client_id || ''), geheim = String(invoer.client_secret || '');
  if (!id || !geheim) throw new TibberFout('sleutel', 'client-id of -secret ontbreekt');
  let form;
  if (opdracht === 'wissel') {
    if (typeof invoer.code !== 'string' || !/^[\x21-\x7e]{1,2000}$/.test(invoer.code) || !/^[A-Za-z0-9_-]{43,128}$/.test(String(invoer.verifier || ''))) throw new TibberFout('invoer', 'code of verifier ongeldig');
    form = { grant_type: 'authorization_code', code: invoer.code, redirect_uri: REDIRECT, client_id: id, client_secret: geheim, code_verifier: invoer.verifier };
  } else {
    if (!TOKEN_VORM.test(String(invoer.refresh || ''))) throw new TibberFout('invoer', 'refresh token ontbreekt');
    form = { grant_type: 'refresh_token', refresh_token: invoer.refresh, client_id: id, client_secret: geheim };
  }
  const t = await tokenVraag(form);
  const refresh = t.refresh || (opdracht === 'ververs' ? invoer.refresh : null);
  if (refresh) noodSchrijf(dir, refresh);   // vóór stdout (review MOET 1)
  return { ok: true, _access: t.access, _refresh: refresh, verloopt_s: t.verloopt_s, nieuw_refresh: !!t.refresh };
}

if (require.main === module) {
  const dir = process.env.TIBBER_DIR || '/opt/data/tibber';
  let invoer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (c) { if (invoer.length < 1e5) invoer += c; });
  process.stdin.on('end', function () {
    let j = {};
    try { j = invoer.trim() ? JSON.parse(invoer) : {}; } catch (e) { j = {}; }
    kind(String(process.argv[2] || ''), j, dir).then(function (u) { process.stdout.write(JSON.stringify(u) + '\n'); },
      function (e) { process.stdout.write(JSON.stringify({ ok: false, reden: e.reden || 'fout', fout: String(e && e.message || e).slice(0, 200) }) + '\n'); process.exitCode = 1; });
  });
}

module.exports = { SCOPES, REDIRECT, linkMaak, stateOpen, stateNeem, ronde, terug, slotNeem, slotLos, noodLees, noodSchrijf, noodWis, verzoekToets, plat, veldMag, scopesExact, sha, TibberFout };
