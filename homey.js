'use strict';
/*
 * homey.js — Homey (Athom) via de officiële MCP-server mcp.athom.com, alleen lezen (wv3460, 19-11-2026).
 *
 * WAAROM. David sloot op 19-11 een Homey Energy Dongle aan op de slimme meter thuis (Blaricum) en vroeg "kun je koppelen met Homey?".
 * De pod staat in Leusden (geen LAN), dus alleen een cloudroute werkt. Gemeten 19-11: mcp.athom.com is een MCP-server over HTTP met
 * OAuth (authorization_code + refresh_token, dynamische clientregistratie, client_secret_basic, response_mode form_post; PKCE wordt
 * niet doorgegeven). De client is op 19-11 dynamisch geregistreerd (kluis homey_mcp_client_id, homey_mcp_client_secret; Davids Ja op
 * de kaart van wv3460). Athom publiceert geen toollijst: die meten we pas na Davids inlog (opdracht meet = tools/list).
 *
 * TWEE ROLLEN IN ÉÉN BESTAND (zelfde opzet als tibber-data.js).
 *  1. Module voor server.js (require): inloglink maken (state, eenmalig, 72 uur), state innemen, en de ronde regisseren (slot,
 *     noodkopie, kluis vooraf, verversen, nieuw refresh token duurzaam opslaan, pas dan meten). De kluis zit in server.js (deps).
 *  2. Kindproces (node homey.js <opdracht>): de enige plek die Athom aanroept. Opdrachten: wissel (code → tokens), ververs
 *     (refresh → tokens), meet (MCP initialize + tools/list; de lijst naar HOMEY_DIR/tools.json), stand (lokaal).
 *
 * ALLEEN LEZEN, HARD. Eén fetch, in roep(), altijd eerst door verzoekToets: POST alleen op /oauth2/token of op het MCP-adres, en op
 * het MCP-adres alleen de JSON-RPC-methoden initialize, notifications/initialized, tools/list en tools/call. tools/call alleen via
 * leesToets (wv3462): de vaste leeslijst list_devices (zonder argumenten) en get_insights_log_entries_number (precies logId +
 * resolution 'lastHour', logId alleen fasestroom/-vermogen of energy_power van één apparaat). Geen schakelen, geen Flow, Mood of
 * variabele, geen ander argument (ook geen homeyId: Athom neemt dan de eerste Homey). Redirects uit. Toetsbasis alleen 127.0.0.1.
 *
 * FASEMETING (wv3462, 20-11-2026). Gemeten 20-11: de Homey Energy Dongle geeft per fase stroom (A, hele getallen), vermogen (W) en
 * belasting (%, t.o.v. de hoofdzekering 25 A); Insights 'lastHour' = één waarde per 5 s (720 punten); 'last24Hours' = 5 min en faalt
 * bij Athom zodra er één lege waarde in zit (MCP -32602, o.a. van vóór de aansluiting). Daarom: opdracht lees, één keer per uur (de
 * pod-tik), het laatste uur van 3 × stroom + 3 × vermogen per fase en het laadpaalvermogen, per minuut de hoogste waarde naar
 * HOMEY_DIR/meting/<dag>.json (overlap vloeit samen). Plus de meterstanden van de dongle en de laadpaalstand uit list_devices.
 * Alleen getallen en apparaat-id's; geen namen van apparaten, zones of personen (list_devices bevat die wel: blijft in het kind).
 *
 * OPSLAG. HOMEY_DIR (700): states.json (sha256 van de state, 72 uur, eenmalig), refresh.nood (alleen tussen verversen en kluis),
 * dood.json (sha van een dood token), ronde.lock, tools.json (namen, korte omschrijving, hints, invoerveldnamen; geen tokens),
 * meting/<JJJJ-MM-DD>.json (per minuut [A1,A2,A3,W1,W2,W3,Wtotaal,Wlaadpaal], standen, laadpaal; 600), dongle.json (het vaste
 * dongle-id, wv3482). Per fase per minuut de grootste absolute waarde met teken (wv3482); Wtotaal en laadpaal de hoogste.
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const REDIRECT = 'https://bank.socev.dev/homey/terug';
const UA = 'Socev/1.0';
const STATE_MS = 72 * 3600 * 1000;
const SLOT_OUD_MS = 15 * 60 * 1000;
const PAUZE_MS = process.env.HOMEY_PAUZE_MS != null ? Number(process.env.HOMEY_PAUZE_MS) : 400;
function basis(v, echt) {
  if (!v) return echt;
  if (/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(v)) return v;
  throw new Error('toetsbasis alleen op 127.0.0.1');
}
const BASIS = basis(process.env.HOMEY_BASIS, 'https://mcp.athom.com');
const TOKEN_PAD = '/oauth2/token';
const MCP_PAD = '/';
const AUTHORIZE = 'https://mcp.athom.com/oauth2/authorise';
const METHODEN = new Set(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
const LEESLIJST = Object.freeze(['list_devices', 'get_insights_log_entries_number']);
const RESOLUTIE = 'lastHour';
const LOG_VORM = /^homey:device:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(measure_current\.phase[123]|measure_power\.phase[123]|energy_power)$/;
const PROTOCOL = '2025-06-18';

class HomeyFout extends Error { constructor(reden, uitleg, status) { super(uitleg || reden); this.reden = reden; this.status = status || null; } }

// ── netwerk: alleen deze verzoeken ────────────────────────────────────────────────────────────────────────────────────
function verzoekToets(methode, url, rpc) {
  let u;
  try { u = new URL(url); } catch (e) { throw new HomeyFout('pad', 'Homey-adres niet toegestaan'); }
  if (methode !== 'POST' || u.username || u.password || u.hash || u.search || u.origin !== BASIS) throw new HomeyFout('pad', 'Homey-adres niet toegestaan');
  if (u.pathname === TOKEN_PAD) { if (rpc) throw new HomeyFout('pad', 'geen JSON-RPC op het tokenendpoint'); return u.href; }
  if (u.pathname !== MCP_PAD) throw new HomeyFout('pad', 'Homey-pad niet toegestaan');
  if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc) || rpc.jsonrpc !== '2.0' || !METHODEN.has(rpc.method)) throw new HomeyFout('pad', 'MCP-methode niet toegestaan');
  if (rpc.method === 'tools/call') leesToets(rpc.params);
  return u.href;
}
// tools/call alleen met een naam uit LEESLIJST en precies deze argumentvorm (wv3462).
function gewoon(o) { return !!o && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype; }
function leesToets(p) {
  const nee = function () { throw new HomeyFout('pad', 'MCP-tool niet toegestaan'); };
  if (!gewoon(p) || Object.keys(p).sort().join(',') !== 'arguments,name' || LEESLIJST.indexOf(p.name) < 0 || !gewoon(p.arguments)) nee();
  const a = p.arguments, k = Object.keys(a).sort().join(',');
  if (p.name === 'list_devices') { if (k !== '') nee(); return true; }
  if (k !== 'logId,resolution' || a.resolution !== RESOLUTIE || typeof a.logId !== 'string' || !LOG_VORM.test(a.logId)) nee();
  return true;
}
function slaap(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// SSE of JSON → het JSON-RPC-antwoord met dit id (of null)
function rpcUit(tekst, type, id) {
  const kandidaten = [];
  if (/text\/event-stream/i.test(type || '')) {
    String(tekst || '').split(/\r?\n\r?\n/).forEach(function (blok) {
      const data = blok.split(/\r?\n/).filter(function (r) { return r.indexOf('data:') === 0; }).map(function (r) { return r.slice(5).replace(/^ /, ''); }).join('\n');
      if (data) { try { kandidaten.push(JSON.parse(data)); } catch (e) {} }
    });
  } else { try { kandidaten.push(JSON.parse(tekst)); } catch (e) {} }
  const plat = [].concat.apply([], kandidaten.map(function (k) { return Array.isArray(k) ? k : [k]; }));
  return plat.find(function (k) { return k && typeof k === 'object' && k.id === id; }) || null;
}
// De enige netwerkaanroep. Herhalen alleen op 429/503 (token: refresh tokens kunnen eenmalig zijn), hooguit 4 pogingen.
async function roep(pad, o) {
  const doel = verzoekToets('POST', BASIS + pad, o.rpc);
  const headers = { 'User-Agent': UA };
  let body;
  if (o.rpc) {
    headers.Accept = 'application/json, text/event-stream'; headers['Content-Type'] = 'application/json';
    headers.Authorization = 'Bearer ' + o.token;
    if (o.sessie) headers['Mcp-Session-Id'] = o.sessie;
    if (o.rpc.method !== 'initialize') headers['MCP-Protocol-Version'] = o.protocol || PROTOCOL;
    body = JSON.stringify(o.rpc);
  } else {
    headers.Accept = 'application/json'; headers['Content-Type'] = 'application/x-www-form-urlencoded';
    headers.Authorization = 'Basic ' + Buffer.from(encodeURIComponent(o.id) + ':' + encodeURIComponent(o.geheim)).toString('base64');
    body = new URLSearchParams(o.form).toString();
  }
  for (let poging = 1; ; poging++) {
    let r;
    try { r = await fetch(doel, { method: 'POST', headers: headers, body: body, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
    catch (e) { throw new HomeyFout('netwerk', 'Homey niet bereikbaar (' + String(e && e.name || 'fout').slice(0, 40) + ')'); }
    if ([429, 503].indexOf(r.status) >= 0 && poging < 4) {
      await r.text().catch(function () {});
      const ra = Number(r.headers.get('retry-after'));
      await slaap(ra > 0 && ra <= 60 ? (PAUZE_MS ? ra * 1000 : 0) : Math.random() * Math.min(10000, PAUZE_MS * 2 ** poging));
      continue;
    }
    const tekst = await r.text().catch(function () { return ''; });
    return { status: r.status, type: r.headers.get('content-type') || '', sessie: r.headers.get('mcp-session-id') || null, tekst: tekst.slice(0, 2e6) };
  }
}

// ── tokens ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const TOKEN_VORM = /^[A-Za-z0-9._~+\/=-]{16,4096}$/;
async function tokenVraag(id, geheim, form) {
  const r = await roep(TOKEN_PAD, { id: id, geheim: geheim, form: form });
  let j = null; try { j = JSON.parse(r.tekst); } catch (e) {}
  const err = j && typeof j.error === 'string' ? j.error.replace(/[^a-z_]/g, '').slice(0, 40) : '';
  if (r.status === 400 && err === 'invalid_grant') throw new HomeyFout('grant', 'Homey: invalid_grant (verlopen, ingetrokken of al gebruikt)', 400);
  if (r.status === 400 || r.status === 401) throw new HomeyFout(err === 'invalid_client' || r.status === 401 ? 'client' : 'token', 'Homey-token: HTTP ' + r.status + (err ? ' ' + err : ''), r.status);
  if (r.status !== 200 || !j || typeof j.access_token !== 'string' || !TOKEN_VORM.test(j.access_token)) throw new HomeyFout('token', 'Homey-token: HTTP ' + r.status, r.status);
  const refresh = typeof j.refresh_token === 'string' && TOKEN_VORM.test(j.refresh_token) ? j.refresh_token : null;
  return { access: j.access_token, refresh: refresh, verloopt_s: Number(j.expires_in) || null, scope: typeof j.scope === 'string' ? j.scope.replace(/[^\w .:\/-]/g, '').slice(0, 200) : null };
}
function noodPad(dir) { return path.join(dir, 'refresh.nood'); }
function noodSchrijf(dir, refresh) {
  mapKlaar(dir);
  const doel = noodPad(dir), tmp = doel + '.' + process.pid + '.tmp';
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeSync(fd, JSON.stringify({ refresh: refresh, sinds: new Date().toISOString() })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, doel);
  try { const d = fs.openSync(dir, 'r'); fs.fsyncSync(d); fs.closeSync(d); } catch (e) {}
}
function noodLees(dir) { try { const j = JSON.parse(fs.readFileSync(noodPad(dir), 'utf8')); return j && TOKEN_VORM.test(j.refresh || '') ? j : null; } catch (e) { return null; } }
function noodWis(dir) { try { fs.unlinkSync(noodPad(dir)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
function doodPad(dir) { return path.join(dir, 'dood.json'); }
function doodLees(dir) { try { const j = JSON.parse(fs.readFileSync(doodPad(dir), 'utf8')); return j && typeof j.token_sha === 'string' ? j : null; } catch (e) { return null; } }
function doodZet(dir, refresh) { const tmp = doodPad(dir) + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ sinds: new Date().toISOString(), token_sha: sha(refresh) }), { mode: 0o600 }); fs.renameSync(tmp, doodPad(dir)); }
function doodWis(dir) { try { fs.unlinkSync(doodPad(dir)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }

// ── inloglink en state (server.js, geen netwerk) ──────────────────────────────────────────────────────────────────────
function sha(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function mapKlaar(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); }
function statesPad(dir) { return path.join(dir, 'states.json'); }
function statesLees(dir) { try { const j = JSON.parse(fs.readFileSync(statesPad(dir), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } }
function statesSchrijf(dir, s) { const tmp = statesPad(dir) + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 }); fs.renameSync(tmp, statesPad(dir)); }
function linkMaak(dir, clientId) {
  if (typeof clientId !== 'string' || !/^[\x21-\x7e]{4,200}$/.test(clientId)) throw new HomeyFout('sleutel', 'client-id ontbreekt of heeft een vreemde vorm');
  mapKlaar(dir);
  const state = crypto.randomBytes(32).toString('hex');
  const s = statesLees(dir), nu = Date.now();
  for (const k of Object.keys(s)) if (!s[k] || nu - Date.parse(s[k].sinds) > STATE_MS * 2) delete s[k];
  s[sha(state)] = { sinds: new Date(nu).toISOString() };
  statesSchrijf(dir, s);
  const q = new URLSearchParams({ response_type: 'code', response_mode: 'form_post', client_id: clientId, redirect_uri: REDIRECT, state: state });   // review ZOU 1; gemeten 19-11: 302 naar de Athom-inlog
  return { url: AUTHORIZE + '?' + q.toString(), geldig_tot: new Date(nu + STATE_MS).toISOString() };
}
function stateOpen(dir, state) {
  const w = statesLees(dir)[sha(state)];
  return !!(w && !w.verbruikt && Date.now() - Date.parse(w.sinds) <= STATE_MS);
}
function stateNeem(dir, state) {
  const s = statesLees(dir), k = sha(state), w = s[k];
  if (!w || w.verbruikt || Date.now() - Date.parse(w.sinds) > STATE_MS) return false;
  s[k] = { sinds: w.sinds, verbruikt: new Date().toISOString() };
  statesSchrijf(dir, s);
  return true;
}

// ── slot ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function slotPad(dir) { return path.join(dir, 'ronde.lock'); }
function pidLeeft(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function slotNeem(dir) {
  mapKlaar(dir);
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(slotPad(dir), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, sinds: new Date().toISOString() })); fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let w = null; try { w = JSON.parse(fs.readFileSync(slotPad(dir), 'utf8')); } catch (e2) {}
      // Onleesbaar slot (net aangemaakt, nog leeg): alleen oud als het bestand zelf ouder is dan SLOT_OUD_MS (review wv3460 MOET 1).
      let leeftijd = 0; try { leeftijd = Date.now() - fs.statSync(slotPad(dir)).mtimeMs; } catch (e2) { leeftijd = 0; }
      const oud = w ? (Date.now() - Date.parse(w.sinds) > SLOT_OUD_MS && !pidLeeft(Number(w.pid))) : leeftijd > SLOT_OUD_MS;
      if (!oud || i) return false;
      try { fs.unlinkSync(slotPad(dir)); } catch (e3) {}
    }
  }
  return false;
}
function slotLos(dir) { try { fs.unlinkSync(slotPad(dir)); } catch (e) {} }

// ── regie (server.js) ─────────────────────────────────────────────────────────────────────────────────────────────────
// deps: { dir, kluisLees() → {client_id, client_secret, refresh}, kluisZet(waarde) → sha256 teruggelezen, kind(opdracht, invoer) → {code, j}, wacht(ms) }
async function kluisBewaar(deps, waarde) {
  let laatste = null;
  for (let i = 0; i < 3; i++) {
    try { const h = await deps.kluisZet(waarde); if (h === sha(waarde)) return true; laatste = 'teruglezen gaf een andere waarde'; }
    catch (e) { laatste = String(e && e.message || e).slice(0, 120); }
    if (i < 2) await (deps.wacht || slaap)(1000 * 2 ** i);
  }
  throw new HomeyFout('kluis', 'nieuw token niet in de kluis: ' + laatste);
}
async function ronde(deps, soort) {
  const dir = deps.dir, uit = { ok: false, begin: new Date().toISOString() };
  if (!slotNeem(dir)) return Object.assign(uit, { reden: 'bezig', fout: 'er loopt al een Homey-ronde' });
  try {
    let k;
    try { k = await deps.kluisLees(); } catch (e) { return Object.assign(uit, { reden: 'kluis', fout: 'kluis niet bereikbaar; niets ververst' }); }
    if (!k || !k.client_id || !k.client_secret) return Object.assign(uit, { reden: 'sleutel', fout: 'client-id of -secret ontbreekt in de kluis' });
    let refresh = k.refresh || null;
    const nood = noodLees(dir);
    if (nood) { await kluisBewaar(deps, nood.refresh); noodWis(dir); refresh = nood.refresh; uit.nood_hersteld = true; }
    if (!refresh) return Object.assign(uit, { reden: 'toestemming', fout: 'nog geen inlog (homey_mcp_refresh ontbreekt)' });
    const dood = doodLees(dir);
    if (dood && dood.token_sha === sha(refresh)) return Object.assign(uit, { reden: 'dood', fout: 'koppeling dood sinds ' + String(dood.sinds).slice(0, 10) + '; wacht op een nieuwe inlog' });
    if (dood) doodWis(dir);
    const v = await deps.kind('ververs', { client_id: k.client_id, client_secret: k.client_secret, refresh: refresh });
    if (v.j && v.j.ok !== true && v.j.reden === 'grant') doodZet(dir, refresh);
    if (!v.j || v.j.ok !== true) return Object.assign(uit, { reden: (v.j && v.j.reden) || 'kind', fout: (v.j && v.j.fout) || 'verversen faalde (exit ' + v.code + ')' });
    const nieuw = v.j._refresh || null;
    if (nieuw && nieuw !== refresh) {
      try { await kluisBewaar(deps, nieuw); } catch (e) { return Object.assign(uit, { reden: 'kluis', fout: e.message, nood: true }); }
    }
    noodWis(dir);
    uit.geroteerd = !!(nieuw && nieuw !== refresh);
    uit.verloopt_s = v.j.verloopt_s || null;
    const r = await deps.kind(soort === 'lees' ? 'lees' : soort === 'nu' ? 'nu' : 'meet', { access: v.j._access });   // wv3586: nu = momentopname voor de App Energie
    const j = r.j || { ok: false, reden: 'kind', fout: 'meten gaf geen JSON (exit ' + r.code + ')' };   // wv3482: ook een gestopt kind heeft een reden
    return Object.assign(uit, j, { begin: uit.begin, geroteerd: uit.geroteerd, nood_hersteld: uit.nood_hersteld, verloopt_s: uit.verloopt_s });
  } catch (e) {
    return Object.assign(uit, { reden: e.reden || 'fout', fout: String(e && e.message || e).slice(0, 200), nood: e.reden === 'kluis' ? true : undefined });
  } finally { slotLos(dir); }
}
// Terugkeer na Davids inlog. → { status, soort: 'gekoppeld'|'dicht'|'mislukt'|'bezig', reden, nood }
async function terug(deps, state, code, fout) {
  const dir = deps.dir;
  if (!stateOpen(dir, state)) return { status: 404, soort: 'dicht' };
  if (!slotNeem(dir)) return { status: 503, soort: 'bezig' };
  try {
    if (!stateNeem(dir, state)) return { status: 404, soort: 'dicht' };
    if (fout) return { status: 200, soort: 'mislukt', reden: 'geweigerd' };
    let k;
    try { k = await deps.kluisLees(); } catch (e) { return { status: 502, soort: 'mislukt', reden: 'kluis' }; }
    if (!k || !k.client_id || !k.client_secret) return { status: 502, soort: 'mislukt', reden: 'sleutel' };
    const w = await deps.kind('wissel', { client_id: k.client_id, client_secret: k.client_secret, code: code });
    if (!w.j || w.j.ok !== true) return { status: 200, soort: 'mislukt', reden: (w.j && w.j.reden) || 'kind' };
    if (!w.j._refresh) return { status: 200, soort: 'mislukt', reden: 'geen refresh token' };
    try { await kluisBewaar(deps, w.j._refresh); }
    catch (e) { doodWis(dir); return { status: 200, soort: 'gekoppeld', reden: 'kluis', nood: true }; }
    noodWis(dir);
    doodWis(dir);
    return { status: 200, soort: 'gekoppeld', scope: w.j.scope || null };
  } finally { slotLos(dir); }
}

// ── kindopdrachten ────────────────────────────────────────────────────────────────────────────────────────────────────
function tekst(v, n) { return typeof v === 'string' ? v.replace(/[^\p{L}\p{N} .,:;()'"\/_+%°-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 40) : null; }
async function rpc(token, staat, methode, params, id) {
  const bericht = { jsonrpc: '2.0', method: methode };
  if (id != null) bericht.id = id;
  if (params) bericht.params = params;
  const r = await roep(MCP_PAD, { token: token, rpc: bericht, sessie: staat.sessie, protocol: staat.protocol });
  if (r.status === 401) throw new HomeyFout('token', 'MCP: 401 (token niet geldig)', 401);
  if (r.status === 403) throw new HomeyFout('scope', 'MCP: 403 (recht ontbreekt)', 403);
  if (id == null) { if (r.status >= 300) throw new HomeyFout('http', 'MCP ' + methode + ': HTTP ' + r.status, r.status); return null; }
  if (r.status !== 200) throw new HomeyFout('http', 'MCP ' + methode + ': HTTP ' + r.status, r.status);
  if (r.sessie && /^[\x21-\x7e]{1,200}$/.test(r.sessie)) staat.sessie = r.sessie;
  const a = rpcUit(r.tekst, r.type, id);
  if (!a) throw new HomeyFout('mcp', 'MCP ' + methode + ': geen antwoord met id ' + id);
  if (a.error) { const f = new HomeyFout('mcp', 'MCP ' + methode + ': fout ' + String(a.error.code || '') + ' ' + tekst(String(a.error.message || ''), 80)); f.rpcCode = a.error.code; throw f; }
  return a.result || {};
}
function toolKort(t) {
  const ann = t && t.annotations && typeof t.annotations === 'object' ? t.annotations : {};
  const props = t && t.inputSchema && t.inputSchema.properties && typeof t.inputSchema.properties === 'object' ? Object.keys(t.inputSchema.properties) : [];
  return { naam: tekst(t && t.name, 80), omschrijving: tekst(t && t.description, 300),
    alleen_lezen: ann.readOnlyHint === true ? true : ann.readOnlyHint === false ? false : null, destructief: ann.destructiveHint === true ? true : ann.destructiveHint === false ? false : null,
    invoer: props.slice(0, 20).map(function (p) { return tekst(p, 40); }) };
}
async function kindMeet(invoer, dir) {
  const token = invoer.access;
  if (typeof token !== 'string' || !TOKEN_VORM.test(token)) throw new HomeyFout('token', 'geen access token');
  const staat = { sessie: null, protocol: PROTOCOL };
  const init = await rpc(token, staat, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Socev', version: '1.0' } }, 1);
  if (typeof init.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(init.protocolVersion)) staat.protocol = init.protocolVersion;
  await rpc(token, staat, 'notifications/initialized', null, null);
  const tools = [];
  let cursor = null, n = 2;
  do {
    const l = await rpc(token, staat, 'tools/list', cursor ? { cursor: cursor } : {}, n++);
    (Array.isArray(l.tools) ? l.tools : []).slice(0, 200).forEach(function (t) { if (tools.length < 300) tools.push(toolKort(t)); });
    cursor = typeof l.nextCursor === 'string' && l.nextCursor.length < 500 ? l.nextCursor : null;
  } while (cursor && n < 12);
  const uit = { ok: true, tijd: new Date().toISOString(), server: { naam: tekst(init.serverInfo && init.serverInfo.name, 60), versie: tekst(init.serverInfo && init.serverInfo.version, 30), protocol: staat.protocol },
    tools: tools.length, alleen_lezen: tools.filter(function (t) { return t.alleen_lezen === true; }).length };
  mapKlaar(dir);
  const p = path.join(dir, 'tools.json'), tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, uit, { lijst: tools }), null, 1), { mode: 0o600 });
  fs.renameSync(tmp, p);
  return uit;
}
// ── fasemeting (wv3462) ───────────────────────────────────────────────────────────────────────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FASE_CAPS = ['measure_current.phase1', 'measure_current.phase2', 'measure_current.phase3', 'measure_power.phase1', 'measure_power.phase2', 'measure_power.phase3'];
const NL = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function nlMinuut(t) { const s = NL.format(new Date(t)); return { dag: s.slice(0, 10), mm: s.slice(11, 16) }; }
function getal(v) { return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null; }
function hoogst(a, b) { return a == null ? b : b == null ? a : Math.max(a, b); }
// wv3482 (Fable-review energie, bevinding 7): per fase telt de grootste absolute waarde, met teken; -22 A (teruglevering) belast de
// zekering even zwaar als +22 A en mag niet achter +1 A verdwijnen. Bij gelijke grootte blijft de eerste staan.
function grootst(a, b) { return a == null ? b : b == null ? a : Math.abs(b) > Math.abs(a) ? b : a; }
function kolomMax(i) { return i < 6 ? grootst : hoogst; }   // [A1,A2,A3,W1,W2,W3] grootst; Wtotaal en laadpaal hoogst
function gestructureerd(res, sleutel) {
  const sc = res && res.structuredContent;
  if (res && res.isError) throw new HomeyFout('mcp', 'MCP-tool gaf een fout');
  if (!sc || !Array.isArray(sc[sleutel])) throw new HomeyFout('mcp', 'MCP-tool zonder ' + sleutel);
  return sc[sleutel];
}
// Kies uit list_devices de dongle en de laadpaal (type evcharger). Alleen id's en getallen gaan verder.
// wv3482 (bevinding 6): de dongle heeft alle zes fasewaarden ÉN een afnamestand (meter_power.imported); een 3-fase laadpaal of omvormer
// meldt wel fasewaarden maar geen netafname. Het gekozen id (vast, uit HOMEY_DIR/dongle.json) blijft gelden zolang het in de lijst staat.
function isDongle(d) { return !!(d && UUID.test(String(d.id)) && d.state && getal(d.state['meter_power.imported']) != null && FASE_CAPS.every(function (c) { return getal(d.state[c]) != null; })); }
function apparatenKies(devs, vast) {
  const vastDev = typeof vast === 'string' && UUID.test(vast) ? devs.find(function (d) { return d && d.id === vast; }) || null : null;
  const dongle = vastDev || devs.find(isDongle) || null;
  const laad = devs.find(function (d) { return d && UUID.test(String(d.id)) && d.type === 'evcharger' && d.state; }) || null;
  const st = function (d, c) { return d && d.state ? getal(d.state[c]) : null; };
  return {
    dongle: dongle ? dongle.id : null, laadpaal: laad ? laad.id : null, vast: !!vastDev,
    stand: dongle ? { import_kwh: st(dongle, 'meter_power.imported'), export_kwh: st(dongle, 'meter_power.exported'), import_vandaag_kwh: st(dongle, 'meter_power.imported_today'),
      export_vandaag_kwh: st(dongle, 'meter_power.exported_today'), tarief: st(dongle, 'current_tariff'), w: st(dongle, 'measure_power'),
      a: [1, 2, 3].map(function (i) { return st(dongle, 'measure_current.phase' + i); }), w3: [1, 2, 3].map(function (i) { return st(dongle, 'measure_power.phase' + i); }) } : null,
    laad: laad ? { laden: laad.state.evcharger_charging === true, w: st(laad, 'measure_power'), a_instelling: st(laad, 'measure_current'), kwh: st(laad, 'meter_power'),
      toestand: typeof laad.state.evcharger_charging_state === 'string' ? laad.state.evcharger_charging_state.replace(/[^a-z_]/g, '').slice(0, 30) : null } : null,
  };
}
// Reeksen (per log [{t, v}]) → per NL-dag per minuut [A1,A2,A3,W1,W2,W3,Wtotaal,Wlaadpaal] met de hoogste waarde in die minuut.
// Wtotaal = hoogste som van de drie fasevermogens op hetzelfde 5-s-tijdstip.
function perMinuut(reeksen) {
  const uit = {}, som = {};
  const zet = function (t, i, v) {
    if (v == null || !Number.isFinite(Date.parse(t))) return;
    const k = nlMinuut(t);
    const dag = uit[k.dag] || (uit[k.dag] = {});
    const r = dag[k.mm] || (dag[k.mm] = [null, null, null, null, null, null, null, null]);
    r[i] = kolomMax(i)(r[i], v);
  };
  ['a1', 'a2', 'a3', 'w1', 'w2', 'w3'].forEach(function (n, i) {
    (reeksen[n] || []).forEach(function (e) {
      const v = getal(e && e.v); zet(e && e.t, i, v);
      if (i >= 3 && v != null) { const s = som[e.t] || (som[e.t] = [0, 0]); s[0] += v; s[1]++; }
    });
  });
  Object.keys(som).forEach(function (t) { if (som[t][1] === 3) zet(t, 6, Math.round(som[t][0])); });
  (reeksen.ev || []).forEach(function (e) { zet(e && e.t, 7, getal(e && e.v)); });
  return uit;
}
function metingPad(dir, dag) { return path.join(dir, 'meting', dag + '.json'); }
function metingLees(dir, dag) { try { const j = JSON.parse(fs.readFileSync(metingPad(dir, dag), 'utf8')); return j && j.m ? j : null; } catch (e) { return null; } }
function metingSchrijf(dir, dag, j) {
  mapKlaar(path.join(dir, 'meting'));
  const p = metingPad(dir, dag), tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j), { mode: 0o600 });
  fs.renameSync(tmp, p);
}
function metingVoegToe(dir, perDag, stand, nuIso) {
  let nieuw = 0;
  Object.keys(perDag).forEach(function (dag) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dag)) return;
    const j = metingLees(dir, dag) || { dag: dag, m: {}, standen: [] };
    Object.keys(perDag[dag]).forEach(function (mm) {
      const r = perDag[dag][mm], o = j.m[mm];
      if (!o) nieuw++;
      j.m[mm] = o ? o.map(function (x, i) { return kolomMax(i)(x, r[i]); }) : r;
    });
    metingSchrijf(dir, dag, j);
  });
  if (stand) {
    const dag = nlMinuut(nuIso).dag;
    const j = metingLees(dir, dag) || { dag: dag, m: {}, standen: [] };
    j.standen = (j.standen || []).concat([Object.assign({ t: nuIso }, stand)]).slice(-48);
    metingSchrijf(dir, dag, j);
  }
  return nieuw;
}
function vastPad(dir) { return path.join(dir, 'dongle.json'); }
function vastLees(dir) { try { const j = JSON.parse(fs.readFileSync(vastPad(dir), 'utf8')); return j && UUID.test(String(j.id)) ? j.id : null; } catch (e) { return null; } }
function vastZet(dir, id) { mapKlaar(dir); const tmp = vastPad(dir) + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ id: id, sinds: new Date().toISOString() }), { mode: 0o600 }); fs.renameSync(tmp, vastPad(dir)); }
async function kindLees(invoer, dir) {
  const token = invoer.access;
  if (typeof token !== 'string' || !TOKEN_VORM.test(token)) throw new HomeyFout('token', 'geen access token');
  const staat = { sessie: null, protocol: PROTOCOL };
  const init = await rpc(token, staat, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Socev', version: '1.0' } }, 1);
  if (typeof init.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(init.protocolVersion)) staat.protocol = init.protocolVersion;
  await rpc(token, staat, 'notifications/initialized', null, null);
  let n = 2;
  const vast = vastLees(dir);
  const keus = apparatenKies(gestructureerd(await rpc(token, staat, 'tools/call', { name: 'list_devices', arguments: {} }, n++), 'devices'), vast);
  if (!keus.dongle) throw new HomeyFout('dongle', 'geen apparaat met afnamestand en stroom en vermogen per fase gevonden');
  if (keus.dongle !== vast) vastZet(dir, keus.dongle);
  const logs = { a1: 'measure_current.phase1', a2: 'measure_current.phase2', a3: 'measure_current.phase3', w1: 'measure_power.phase1', w2: 'measure_power.phase2', w3: 'measure_power.phase3' };
  const reeksen = {}, gaten = [];
  const haal = async function (naam, id, cap) {
    try {
      const res = await rpc(token, staat, 'tools/call', { name: 'get_insights_log_entries_number', arguments: { logId: 'homey:device:' + id + ':' + cap, resolution: RESOLUTIE } }, n++);
      reeksen[naam] = gestructureerd(res, 'entries').slice(0, 5000);
    } catch (e) { if (e.reden === 'mcp' && e.rpcCode === -32602) gaten.push(naam); else throw e; }   // alleen -32602: Athom weigert een reeks met een lege waarde (review ZOU 1)
  };
  for (const k of Object.keys(logs)) await haal(k, keus.dongle, logs[k]);
  if (keus.laadpaal) await haal('ev', keus.laadpaal, 'energy_power');
  if (Object.keys(logs).every(function (k) { return gaten.indexOf(k) >= 0; })) throw new HomeyFout('gat', 'alle fasereeksen van het laatste uur leeg (dongle offline?)');
  const nu = new Date().toISOString();
  const stand = Object.assign({}, keus.stand, { laadpaal: keus.laad });
  const nieuw = metingVoegToe(dir, perMinuut(reeksen), stand, nu);
  const hoogste = [1, 2, 3].map(function (i) { return (reeksen['a' + i] || []).reduce(function (m, e) { return grootst(m, getal(e && e.v)); }, null); });
  return { ok: true, soort: 'lees', tijd: nu, minuten: nieuw, gaten: gaten, nu_a: keus.stand.a, uur_max_a: hoogste, laadpaal: !!keus.laadpaal,
    laden: !!(keus.laad && keus.laad.laden) };
}
// ── wv3586: momentopname voor de App Energie (alleen list_devices; geen Insights) ─────────────────────────────────────
// Alleen als David het scherm open heeft (server.js: hooguit één per 30 s). Schrijft de laatste stand (alleen getallen van dongle en
// laadpaal) naar HOMEY_DIR/nu.json; geen namen, geen zones, geen andere apparaten.
function nuPad(dir) { return path.join(dir, 'nu.json'); }
function nuLees(dir) { try { const j = JSON.parse(fs.readFileSync(nuPad(dir), 'utf8')); return j && typeof j.t === 'string' && j.stand ? j : null; } catch (e) { return null; } }
async function kindNu(invoer, dir) {
  const token = invoer.access;
  if (typeof token !== 'string' || !TOKEN_VORM.test(token)) throw new HomeyFout('token', 'geen access token');
  const staat = { sessie: null, protocol: PROTOCOL };
  const init = await rpc(token, staat, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Socev', version: '1.0' } }, 1);
  if (typeof init.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(init.protocolVersion)) staat.protocol = init.protocolVersion;
  await rpc(token, staat, 'notifications/initialized', null, null);
  const vast = vastLees(dir);
  const keus = apparatenKies(gestructureerd(await rpc(token, staat, 'tools/call', { name: 'list_devices', arguments: {} }, 2), 'devices'), vast);
  if (!keus.dongle) throw new HomeyFout('dongle', 'geen apparaat met afnamestand en stroom en vermogen per fase gevonden');
  if (keus.dongle !== vast) vastZet(dir, keus.dongle);
  const t = new Date().toISOString();
  const j = { t: t, stand: keus.stand, laadpaal: keus.laad };
  mapKlaar(dir);
  const tmp = nuPad(dir) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j), { mode: 0o600 });
  fs.renameSync(tmp, nuPad(dir));
  return { ok: true, soort: 'nu', tijd: t };
}
// ── wv3586: wat het scherm Energie toont (puur rekenwerk op HOMEY_DIR; server.js voegt de Tibber-prijzen toe) ─────────────
const BLOK_MIN = 5;   // dagverloop per 5 minuten
function faseNiveau(a) { return a == null ? null : Math.abs(a) > ZEKERING_A ? 'over' : Math.abs(a) >= WAARSCHUW_A ? 'krap' : 'ok'; }
function dagVerloop(j) {
  const blok = {};
  Object.keys(j.m || {}).forEach(function (mm) {
    if (!/^\d{2}:\d{2}$/.test(mm)) return;
    const min = Number(mm.slice(0, 2)) * 60 + Number(mm.slice(3, 5)), b = min - (min % BLOK_MIN);
    const k = String(Math.floor(b / 60)).padStart(2, '0') + ':' + String(b % 60).padStart(2, '0');
    const r = j.m[mm], o = blok[k] || (blok[k] = [null, null, null, null, null]);
    for (let i = 0; i < 3; i++) o[i] = grootst(o[i], getal(r[i]));
    o[3] = hoogst(o[3], getal(r[6])); o[4] = hoogst(o[4], getal(r[7]));
  });
  return Object.keys(blok).sort().map(function (k) { return [k].concat(blok[k]); });   // [hh:mm, A1, A2, A3, Wtotaal, Wlaadpaal]
}
function laadKort(l) {
  if (!l) return null;
  return { laden: l.laden === true, w: getal(l.w), a_instelling: getal(l.a_instelling), toestand: typeof l.toestand === 'string' ? l.toestand.replace(/[^a-z_]/g, '').slice(0, 30) : null };
}
function energieScherm(dir, nuIso) {
  const nuMs = Date.parse(nuIso) || Date.now();
  const vandaag = nlMinuut(nuMs).dag;
  let dagen = [];
  try { dagen = fs.readdirSync(path.join(dir, 'meting')).filter(function (f) { return /^\d{4}-\d{2}-\d{2}\.json$/.test(f); }).map(function (f) { return f.slice(0, 10); }).sort().reverse(); } catch (e) {}
  const jv = metingLees(dir, vandaag);
  // "nu": de verste van momentopname (nu.json) en de laatste stand van de uurronde
  let nu = null;
  const n = nuLees(dir);
  if (n) nu = { t: n.t, bron: 'moment', stand: n.stand, laadpaal: n.laadpaal };
  const laatsteDag = jv || (dagen.length ? metingLees(dir, dagen[0]) : null);
  const st = laatsteDag && Array.isArray(laatsteDag.standen) && laatsteDag.standen.length ? laatsteDag.standen[laatsteDag.standen.length - 1] : null;
  if (st && (!nu || Date.parse(st.t) > Date.parse(nu.t))) nu = { t: st.t, bron: 'uur', stand: st, laadpaal: st.laadpaal };
  let nuUit = null;
  if (nu && nu.stand) {
    const a = (Array.isArray(nu.stand.a) ? nu.stand.a : []).slice(0, 3).map(getal);
    while (a.length < 3) a.push(null);
    const niveaus = a.map(faseNiveau);
    nuUit = { tijd: nu.t, bron: nu.bron, leeftijd_s: Math.max(0, Math.round((nuMs - Date.parse(nu.t)) / 1000)), a: a, niveau: niveaus,
      w: getal(nu.stand.w), w3: (Array.isArray(nu.stand.w3) ? nu.stand.w3 : []).slice(0, 3).map(getal),
      ruimte_a: a.map(function (x) { return x == null ? null : Math.round((ZEKERING_A - Math.abs(x)) * 10) / 10; }),
      kwh_vandaag: getal(nu.stand.import_vandaag_kwh), laadpaal: laadKort(nu.laadpaal) };
  }
  // waarschuwing: alleen als het speelt, alleen uit de gemeten stand (geen voorspelling)
  let waarschuwing = null;
  if (nuUit && nuUit.leeftijd_s <= 15 * 60) {
    const krap = [0, 1, 2].filter(function (i) { return nuUit.niveau[i] === 'krap' || nuUit.niveau[i] === 'over'; });
    const laadt = !!(nuUit.laadpaal && nuUit.laadpaal.laden);
    if (krap.length) {
      const i = krap.reduce(function (b, x) { return Math.abs(nuUit.a[x]) > Math.abs(nuUit.a[b]) ? x : b; }, krap[0]);
      waarschuwing = { niveau: krap.some(function (x) { return nuUit.niveau[x] === 'over'; }) ? 'rood' : 'oranje', fase: i + 1, a: nuUit.a[i], laadt: laadt, fasen: krap.map(function (x) { return x + 1; }) };
    } else if (laadt) waarschuwing = { niveau: 'info', laadt: true, ruimte_a: nuUit.ruimte_a };
  }
  const samen = jv ? dagSamenvat(jv) : null;
  const vorige = dagen.filter(function (d) { return d !== vandaag; }).slice(0, 7).map(function (d) {
    const j = metingLees(dir, d); if (!j) return null;
    const s = dagSamenvat(j); if (!s.minuten) return null;
    return { dag: s.dag, minuten: s.minuten, max_a: s.max_a, max_a_om: s.max_a_om, boven_20: s.boven_20, boven_25: s.boven_25, piek_w: s.piek_w, piek_w_om: s.piek_w_om, laad_min: s.laad_min, laad_max_w: s.laad_max_w, kwh: s.kwh };
  }).filter(Boolean);
  return { zekering_a: ZEKERING_A, waarschuw_a: WAARSCHUW_A, dag: vandaag, nu: nuUit, waarschuwing: waarschuwing,
    vandaag: samen ? { minuten: samen.minuten, eerste: samen.eerste, laatste: samen.laatste, max_a: samen.max_a, max_a_om: samen.max_a_om, boven_20: samen.boven_20,
      boven_25: samen.boven_25, piek_w: samen.piek_w, piek_w_om: samen.piek_w_om, laad_min: samen.laad_min, laad_max_w: samen.laad_max_w, kwh: samen.kwh, verloop: dagVerloop(jv) } : null,
    dagen: vorige };
}
// ── dagtabel voor de energiepagina (server.js schrijft; hier alleen tekst) ──────────────────────────────────────────────
const BLOK_BEGIN = '<!-- homey-fase:begin -->', BLOK_EINDE = '<!-- homey-fase:einde -->';
const KOP = '## Fasebelasting thuis uit Homey (automatisch, sinds 20-11-2026)';
const WAARSCHUW_A = 20, ZEKERING_A = 25;
function dagSamenvat(j) {
  const ks = Object.keys(j.m || {}).sort();
  const s = { dag: j.dag, minuten: ks.length, eerste: ks[0] || null, laatste: ks[ks.length - 1] || null, max_a: [null, null, null], max_a_om: [null, null, null],
    boven_20: [0, 0, 0], boven_25: [0, 0, 0], piek_w: null, piek_w_om: null, laad_min: 0, laad_max_w: null, kwh: null };
  ks.forEach(function (mm) {
    const r = j.m[mm];
    for (let i = 0; i < 3; i++) {
      const a = r[i];
      if (a == null) continue;
      if (s.max_a[i] == null || Math.abs(a) > Math.abs(s.max_a[i])) { s.max_a[i] = a; s.max_a_om[i] = mm; }   // wv3482: grootte telt, teken blijft
      if (Math.abs(a) >= WAARSCHUW_A) s.boven_20[i]++;
      if (Math.abs(a) > ZEKERING_A) s.boven_25[i]++;
    }
    if (r[6] != null && (s.piek_w == null || r[6] > s.piek_w)) { s.piek_w = r[6]; s.piek_w_om = mm; }
    if (r[7] != null && r[7] >= 1000) s.laad_min++;
    s.laad_max_w = hoogst(s.laad_max_w, r[7]);
  });
  // wv3482 (bevinding 3): de dagteller van de dongle (import_vandaag_kwh) van de laatste stand, niet laatste − eerste import_kwh
  // (dat miste de uren vóór de eerste en na de laatste ronde). Mist hooguit het stuk na de laatste ronde van de dag.
  const st = (j.standen || []).filter(function (x) { return x && typeof x.import_vandaag_kwh === 'number'; });
  if (st.length) s.kwh = Math.round(st[st.length - 1].import_vandaag_kwh * 10) / 10;
  return s;
}
function nlGetal(v, d) { return v == null ? '–' : (Math.round(v * 10 ** d) / 10 ** d).toFixed(d).replace('.', ','); }
function vaultBlok(dir, nuIso) {
  let dagen = [];
  try { dagen = fs.readdirSync(path.join(dir, 'meting')).filter(function (f) { return /^\d{4}-\d{2}-\d{2}\.json$/.test(f); }).sort().reverse().slice(0, 14); } catch (e) {}
  const vandaag = nlMinuut(nuIso).dag;
  const rijen = [];
  dagen.forEach(function (f) {
    const j = metingLees(dir, f.slice(0, 10));
    if (!j) return;
    const s = dagSamenvat(j);
    if (!s.minuten) return;
    const dag = s.dag.slice(8, 10) + '-' + s.dag.slice(5, 7) + (s.dag === vandaag ? ' (t/m ' + s.laatste + ')' : '');
    const maxA = s.max_a.map(function (a) { return a == null ? '–' : String(a); }).join(' / ');
    const fi = s.max_a.reduce(function (b, a, i) { return a != null && (b < 0 || Math.abs(a) > Math.abs(s.max_a[b])) ? i : b; }, -1);
    rijen.push('| ' + dag + ' | ' + nlGetal(s.minuten / 60, 1) + ' u | ' + maxA + (fi >= 0 ? ' (L' + (fi + 1) + ' om ' + s.max_a_om[fi] + ')' : '') + ' | ' +
      s.boven_20.join(' / ') + ' | ' + s.boven_25.join(' / ') + ' | ' + (s.piek_w == null ? '–' : nlGetal(s.piek_w / 1000, 1) + ' kW om ' + s.piek_w_om) + ' | ' +
      (s.laad_max_w == null ? '–' : s.laad_min + ' min, piek ' + nlGetal(s.laad_max_w / 1000, 1) + ' kW') + ' | ' + (s.kwh == null ? '–' : nlGetal(s.kwh, 1)) + ' |');
  });
  const bij = NL.format(new Date(nuIso));
  return [BLOK_BEGIN,
    'Bron: Homey Energy Dongle op de slimme meter (3-fase, hoofdzekering ' + ZEKERING_A + ' A) en de laadpaal in Homey; elk uur het laatste uur per 5 seconden,',
    'per minuut de grootste waarde (negatief = teruglevering, telt even zwaar). ' + WAARSCHUW_A + ' A = 80 % van de zekering. Alleen lezen; Socev schakelt niets. Bijgewerkt ' + bij + '.',
    '',
    '| Dag | Gemeten | Hoogste stroom L1 / L2 / L3 (A) | Minuten ≥ ' + WAARSCHUW_A + ' A (L1/L2/L3) | Minuten > ' + ZEKERING_A + ' A | Piek totaal | Laadpaal (≥ 1 kW) | Afname kWh |',
    '|---|---|---|---|---|---|---|---|'].concat(rijen.length ? rijen : ['| – | nog geen meting | | | | | | |']).concat([BLOK_EINDE]).join('\n');
}
function blokZet(pagina, blok) {
  const t = String(pagina), b = t.indexOf(BLOK_BEGIN), e = t.indexOf(BLOK_EINDE);
  if (b >= 0 && e > b && t.indexOf(BLOK_BEGIN, b + 1) < 0) return t.slice(0, b) + blok + t.slice(e + BLOK_EINDE.length);
  if (b >= 0 || e >= 0) return null;   // half of dubbel blok: niet raden
  return t.replace(/\s*$/, '') + '\n\n' + KOP + '\n\n' + blok + '\n';
}

function kindStand(dir) {
  let t = null; try { t = JSON.parse(fs.readFileSync(path.join(dir, 'tools.json'), 'utf8')); } catch (e) {}
  return { ok: true, nood: !!noodLees(dir), dood: !!doodLees(dir), tools: t ? { tijd: t.tijd, server: t.server, aantal: t.tools, alleen_lezen: t.alleen_lezen, namen: (t.lijst || []).map(function (x) { return x.naam; }) } : null };
}
async function kind(opdracht, invoer, dir) {
  if (opdracht === 'stand') return kindStand(dir);
  if (opdracht === 'meet') return kindMeet(invoer, dir);
  if (opdracht === 'lees') return kindLees(invoer, dir);
  if (opdracht === 'nu') return kindNu(invoer, dir);   // wv3586
  if (opdracht !== 'wissel' && opdracht !== 'ververs') throw new HomeyFout('opdracht', 'opdracht: wissel, ververs, meet, lees, nu, stand');
  const id = String(invoer.client_id || ''), geheim = String(invoer.client_secret || '');
  if (!id || !geheim) throw new HomeyFout('sleutel', 'client-id of -secret ontbreekt');
  let form;
  if (opdracht === 'wissel') {
    if (typeof invoer.code !== 'string' || !/^[\x21-\x7e]{1,2000}$/.test(invoer.code)) throw new HomeyFout('invoer', 'code ongeldig');
    form = { grant_type: 'authorization_code', code: invoer.code, redirect_uri: REDIRECT };
  } else {
    if (!TOKEN_VORM.test(String(invoer.refresh || ''))) throw new HomeyFout('invoer', 'refresh token ontbreekt');
    form = { grant_type: 'refresh_token', refresh_token: invoer.refresh };
  }
  const t = await tokenVraag(id, geheim, form);
  const refresh = t.refresh || (opdracht === 'ververs' ? invoer.refresh : null);
  if (refresh) noodSchrijf(dir, refresh);   // vóór stdout: een eenmalig nieuw token staat duurzaam op schijf
  return { ok: true, _access: t.access, _refresh: refresh, verloopt_s: t.verloopt_s, nieuw_refresh: !!t.refresh, scope: t.scope };
}

// ── Pod-koppeling van Homey (wv3886, 22-11-2026) ─────────────────────────────────────────────────────────────────────────────────
// WAAROM HIER. Davids ontwerpregel (OVIS-ontwerplijnen § 4.4: gegevens, logica en weergave gescheiden) en de Data Manager (DM9, 22-11)
// vroegen om de homey*-functies uit server.js te halen (zoals wv3883 met OVIS Code). Ze staan hier ongewijzigd (wv3460 koppeling, wv3462
// fasemeting, wv3482 herpogingen, wv3586 momentopname); server.js roept homeyMod.pod(S) één keer aan en houdt alleen de koppeling
// (HOMEY_DIR, HOMEY_SCRIPT, timers, router, /smal, /health, App Energie). S levert alles van de server als getter (lui gelezen: geen TDZ
// bij het laden; een toets die een global vervangt ziet die meteen). mod = de module met ronde/terug/stateOpen/linkMaak/vaultBlok/blokZet
// (standaard deze exports; test/homey-route.test.js geeft een nepmodule). Date uit S zodat een toets de klok kan zetten. pod() doet bij
// het laden niets (ook niet als kindproces): alleen let-staat in de closure, geen timers.
function pod(S, mod) {
  const homeyMod = mod || module.exports;
  const Date = S.Date || global.Date;
  const HOMEY_TERUG_PER_UUR = 30;
  const homeyTerugTijden = [];
  let homeyBezig = false;
  function homeyIsPad(req) { return S.reqPath(req) === '/homey/terug'; }
  async function homeyKluisLees() {
    const rijen = await S.tibberMgmt("select name, decrypted_secret as w from vault.decrypted_secrets where name in ('homey_mcp_client_id', 'homey_mcp_client_secret', 'homey_mcp_refresh')");
    const w = { client_id: '', client_secret: '', refresh: '' };
    rijen.forEach(function (x) {
      if (x && x.name === 'homey_mcp_client_id') w.client_id = String(x.w || '').trim();
      if (x && x.name === 'homey_mcp_client_secret') w.client_secret = String(x.w || '').trim();
      if (x && x.name === 'homey_mcp_refresh') w.refresh = String(x.w || '').trim();
    });
    return w;
  }
  async function homeyKluisZet(waarde) {
    if (typeof waarde !== 'string' || !/^[A-Za-z0-9._~+\/=-]{16,4096}$/.test(waarde)) throw new Error('token heeft een onverwachte vorm');
    const n = (await S.tibberMgmt("select count(*)::int as n from vault.secrets where name = 'homey_mcp_refresh'"))[0];
    if (!n || (n.n !== 0 && n.n !== 1)) throw new Error('kluis: homey_mcp_refresh niet eenduidig');
    const q = n.n === 1 ? "select count(*)::int as n from (select vault.update_secret(id, $hm$" + waarde + "$hm$) from vault.secrets where name = 'homey_mcp_refresh') x"
      : "select count(*)::int as n from (select vault.create_secret($hm$" + waarde + "$hm$, 'homey_mcp_refresh', 'Homey MCP (Athom) refresh token; pod schrijft zelf (wv3460)')) x";
    const z = (await S.tibberMgmt(q))[0];
    if (!z || z.n !== 1) throw new Error('kluis: niet precies één regel geschreven');
    const t = (await S.tibberMgmt("select encode(sha256(convert_to(decrypted_secret, 'UTF8')), 'hex') as h from vault.decrypted_secrets where name = 'homey_mcp_refresh'"))[0];
    return t && typeof t.h === 'string' ? t.h : null;
  }
  async function homeyKind(opdracht, invoer) {
    const env = { HOMEY_DIR: S.HOMEY_DIR };
    ['PATH', 'HOME', 'TZ', 'LANG'].forEach(function (k) { if (process.env[k] != null) env[k] = process.env[k]; });
    ['HOMEY_BASIS', 'HOMEY_PAUZE_MS'].forEach(function (k) { if (process.env[k] != null) env[k] = process.env[k]; });   // alleen de toets (127.0.0.1)
    const r = await S.smalKind(process.execPath, ['--no-warnings', S.HOMEY_SCRIPT, opdracht], JSON.stringify(invoer || {}), 120000, env);
    let j = null;
    try { j = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch (e) {}
    if (r.code !== 0 && r.stderr) S.logError('homey-' + opdracht, new Error(String(r.stderr).slice(0, 200)));
    return { code: r.code, j: j && typeof j === 'object' ? j : null };
  }
  function homeyDeps() { return { dir: S.HOMEY_DIR, kluisLees: homeyKluisLees, kluisZet: homeyKluisZet, kind: homeyKind }; }
  function homeySchoon(u) { const o = {}; Object.keys(u || {}).forEach(function (k) { if (k[0] !== '_') o[k] = u[k]; }); return o; }
  function homeyRondeLees() { try { return JSON.parse(fs.readFileSync(path.join(S.HOMEY_DIR, 'ronde.json'), 'utf8')); } catch (e) { return null; } }
  function homeyInfo() {
    const r = homeyRondeLees();
    let gekoppeld = null; try { gekoppeld = JSON.parse(fs.readFileSync(path.join(S.HOMEY_DIR, 'gekoppeld.json'), 'utf8')).tijd || null; } catch (e) {}
    return { module: !!homeyMod, gekoppeld: gekoppeld, laatste: r ? { tijd: r.eind || null, ok: r.ok === true, soort: r.soort || 'meet', reden: r.reden || undefined, tools: r.tools, alleen_lezen: r.alleen_lezen,
      minuten: r.minuten, gaten: r.gaten && r.gaten.length ? r.gaten : undefined } : null,
      nood: fs.existsSync(path.join(S.HOMEY_DIR, 'refresh.nood')), vault: homeyVaultStaat() };
  }
  function homeyBoxRij(reden, tekst) {
    try {
      const dag = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
      const pad = path.join(S.VAULT, '00_Systeem', 'Meldingen', 'machinekamer.md');
      const t = S.VV().lees(pad);
      const kenmerk = 'homey-' + reden + '-' + dag;
      if (t.indexOf(kenmerk) >= 0) return;
      const eerste = /\n## \[[a-z]{2,10}\] \d{4}-\d{2}-\d{2}/.exec(t);
      if (!eerste) return;
      const tijd = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }).slice(0, 16);
      const voorstel = reden === 'grant' ? 'koppeling dood (verlopen, ingetrokken of al gebruikt). Nieuwe inloglink: `POST /smal/homey {opdracht: link}` (API_SECRET) en die als Voor jou-kaart aan David geven. Niet herhalen tot David opnieuw inlogde.'
        : reden === 'kluis' ? 'het nieuwe refresh token staat als noodkopie in `/opt/data/homey/refresh.nood` (600); de volgende ronde zet hem eerst in de kluis. Kluis nagaan; daarna `POST /smal/homey {opdracht: meet}`.'
        : reden === 'gat' ? 'de dongle gaf het laatste uur geen enkele fasewaarde (offline, stroomloos of uit Homey). Homey-app: staat de Energy Dongle online? Daarna `POST /smal/homey {opdracht: lees}`.'
        : 'api.log `homey` en `POST /smal/homey {opdracht: stand}` nalopen.';
      const rij = '\n## [direct] ' + tijd + ' — Homey (MCP): ' + String(tekst || reden).replace(/[\r\n]+/g, ' ').slice(0, 90) + ' (pod, automatisch) #homey\n' +
        '- status: open\n- van: pod homey (server.js, wv3460; hooguit 1× per dag per reden; kenmerk ' + kenmerk + ')\n' +
        '- gevolg als er niets gebeurt: Socev ziet Homey (energie, apparaten) niet.\n- voorstel: ' + voorstel + '\n';
      S.VV().schrijf(pad, t.slice(0, eerste.index) + rij + t.slice(eerste.index));
    } catch (e) { S.logError('homey-box', e); }
  }
  const HOMEY_MELD_NA_REEKS = ['gat', 'netwerk', 'kind'];
  let homeyMisReeks = 0;   // mislukte rondes op rij (in het geheugen; een herstart begint opnieuw te tellen)
  async function homeyRondeDraai(bron, soort) {
    if (!homeyMod) return { ok: false, fout: 'homey.js zit niet in deze release' };
    if (homeyBezig) return { ok: false, reden: 'bezig', fout: 'er loopt al een Homey-ronde' };
    homeyBezig = true;
    soort = soort === 'lees' ? 'lees' : 'meet';
    try {
      const u = homeySchoon(await homeyMod.ronde(homeyDeps(), soort));
      u.eind = new Date().toISOString();
      S.schrijfLog(S.nu() + ' homey ' + S.velden({ opdracht: soort, bron: bron, ok: u.ok === true, reden: u.reden, tools: u.tools, minuten: u.minuten, gaten: u.gaten && u.gaten.length ? u.gaten.join('+') : undefined, geroteerd: u.geroteerd, nood: u.nood || undefined }));
      if (u.reden !== 'bezig') {
        try { const p = path.join(S.HOMEY_DIR, 'ronde.json'), tmp = p + '.' + process.pid + '.tmp', vorig = homeyRondeLees() || {};
          fs.writeFileSync(tmp, JSON.stringify({ eind: u.eind, soort: soort, ok: u.ok === true, reden: u.reden || null, fout: u.ok === true ? null : String(u.fout || '').slice(0, 160),
            tools: soort === 'meet' ? u.tools : vorig.tools, alleen_lezen: soort === 'meet' ? u.alleen_lezen : vorig.alleen_lezen, server: soort === 'meet' ? u.server : vorig.server,
            minuten: u.minuten, gaten: u.gaten, verloopt_s: u.verloopt_s, geroteerd: u.geroteerd }), { mode: 0o600 });
          fs.renameSync(tmp, p); }
        catch (e) { S.logError('homey-ronde-json', e); }
      }
      // wv3482 (Fable-review energie, bevinding 4): gat (dongle geeft niets), netwerk en kind pas na 3 mislukte rondes op rij; 'bezig' telt niet mee
      if (u.reden !== 'bezig') homeyMisReeks = u.ok === true ? 0 : homeyMisReeks + 1;
      if (u.ok !== true && ['grant', 'kluis', 'client', 'token', 'mcp', 'http', 'dongle'].indexOf(u.reden) >= 0) homeyBoxRij(u.reden, u.fout);   // wv3462: ook leesfouten (1× per dag per reden)
      else if (u.ok !== true && HOMEY_MELD_NA_REEKS.indexOf(u.reden) >= 0 && homeyMisReeks >= 3) homeyBoxRij(u.reden, homeyMisReeks + ' rondes op rij mislukt: ' + String(u.fout || u.reden));
      else if (u.nood) homeyBoxRij('kluis', u.fout);
      return u;
    } finally { homeyBezig = false; }
  }
  async function homeySmal(d, wie) {
    if (!wie || !wie.mk) return { status: 403, j: { ok: false, fout: 'homey alleen vanuit de machinekamer (API_SECRET)' } };
    if (!homeyMod) return { status: 404, j: { ok: false, fout: 'homey.js zit niet in deze release' } };
    if (!S.rolPrimair()) return { status: 409, j: { ok: false, fout: 'Socev draait nu op de reservekant' } };
    const opdracht = String(d.opdracht || '');
    if (opdracht === 'link') {
      let k; try { k = await homeyKluisLees(); } catch (e) { return { status: 503, j: { ok: false, fout: 'kluis nu niet bereikbaar' } }; }
      if (!k.client_id) return { status: 409, j: { ok: false, fout: 'homey_mcp_client_id ontbreekt in de kluis' } };
      const l = homeyMod.linkMaak(S.HOMEY_DIR, k.client_id);
      S.schrijfLog(S.nu() + ' homey ' + S.velden({ opdracht: 'link' }));
      return { status: 200, j: { ok: true, url: l.url, geldig_tot: l.geldig_tot } };
    }
    if (opdracht === 'meet' || opdracht === 'lees') { const u = await homeyRondeDraai('machinekamer', opdracht); return { status: u.reden === 'bezig' ? 409 : 200, j: u }; }
    if (opdracht === 'vault') { const v = homeyVaultSchrijf(true); return { status: v.ok ? 200 : 409, j: v }; }
    if (opdracht === 'stand') {
      const s = await homeyKind('stand', {});
      return { status: 200, j: Object.assign({ ok: !!(s.j && s.j.ok) }, homeySchoon(s.j), { info: homeyInfo() }) };
    }
    return { status: 400, j: { ok: false, fout: 'opdracht: link, meet, lees, vault, stand' } };
  }
  // wv3462 (20-11-2026): fasemeting. WAAROM. Bij laden + koken klapt thuis de fasezekering (3 × 25 A); de Homey Energy Dongle meet per fase.
  // HOE. homeyTik (elke 5 min) start hooguit één leesronde per 55 min (Insights 'lastHour' = 5-s-waarden van het laatste uur; per minuut
  // de grootste naar HOMEY_DIR/meting). wv3482: lastHour is het enige venster, dus een mislukte ronde komt na ± 10 min terug (hooguit 3
  // herpogingen per uur; niet bij een dode of ontbrekende koppeling); de boxrij zit in homeyRondeDraai.
  // Eén keer per NL-dag (vanaf 01:00) zet homeyVaultSchrijf de tabel van de laatste 14 dagen tussen de markers op de energiepagina.
  const HOMEY_LEES_MS = 55 * 60 * 1000, HOMEY_HERPOGING_MS = 10 * 60 * 1000, HOMEY_HERPOGING_MAX = 3;
  const HOMEY_GEEN_HERPOGING = ['dood', 'grant', 'client', 'sleutel', 'toestemming'];   // opnieuw proberen helpt niet: wacht op een inlog of de kluis
  const HOMEY_P_ENERGIE = '20_Prive/Financien/Energieverbruik thuis (Tibber).md';
  let homeyLeesPoging = 0, homeyVolgende = 0, homeyHerpogingen = 0;
  function homeyVaultStaat() { try { return JSON.parse(fs.readFileSync(path.join(S.HOMEY_DIR, 'vault.json'), 'utf8')); } catch (e) { return null; } }
  function homeyVaultSchrijf(dwing) {
    if (!homeyMod || typeof homeyMod.vaultBlok !== 'function') return { ok: false, fout: 'homey.js zonder dagtabel' };
    const nuIso = new Date().toISOString(), nl = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    const vorig = homeyVaultStaat();
    if (!dwing && ((vorig && vorig.dag === nl.slice(0, 10)) || Number(nl.slice(11, 13)) < 1)) return { ok: false, fout: 'vandaag al geschreven' };
    let z = null;
    try {
      const blok = homeyMod.vaultBlok(S.HOMEY_DIR, nuIso);
      const ok = S.VV().wijzig(path.join(S.VAULT, HOMEY_P_ENERGIE), function (pagina) { z = homeyMod.blokZet(pagina, blok); return z; }, { krimpGrens: true });
      if (!ok || z == null) { if (z == null) homeyBoxRij('vault', 'dagtabel niet gezet: markers op de energiepagina half of dubbel'); return { ok: false, fout: z == null ? 'markers half of dubbel' : 'pagina veranderde tijdens schrijven' }; }
      const p = path.join(S.HOMEY_DIR, 'vault.json'), tmp = p + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ dag: nl.slice(0, 10), tijd: nuIso }), { mode: 0o600 }); fs.renameSync(tmp, p);
      S.schrijfLog(S.nu() + ' homey ' + S.velden({ opdracht: 'vault', ok: true }));
      return { ok: true, dag: nl.slice(0, 10) };
    } catch (e) { S.logError('homey-vault', e); return { ok: false, fout: String(e && e.message || e).slice(0, 120) }; }
  }
  // Na een leesronde: wanneer de volgende. Gelukt → over HOMEY_LEES_MS; mislukt → over HOMEY_HERPOGING_MS, hooguit HOMEY_HERPOGING_MAX keer
  // achter elkaar, daarna terug op het uurritme (gerekend vanaf de laatste gewone poging).
  function homeyNaLees(u, t) {
    if (u && u.ok === true) { homeyHerpogingen = 0; homeyVolgende = t + HOMEY_LEES_MS; return; }
    if (u && HOMEY_GEEN_HERPOGING.indexOf(u.reden) < 0 && homeyHerpogingen < HOMEY_HERPOGING_MAX) { homeyHerpogingen++; homeyVolgende = t + HOMEY_HERPOGING_MS; return; }
    homeyHerpogingen = 0; homeyVolgende = Math.max(t + HOMEY_HERPOGING_MS, homeyLeesPoging + HOMEY_LEES_MS);
  }
  function homeyTik() {
    if (!homeyMod || homeyBezig || homeyNuBezig || !S.rolPrimair() || Date.now() < homeyVolgende) return;   // wv3586: niet tijdens een momentopname van de App
    if (!fs.existsSync(path.join(S.HOMEY_DIR, 'gekoppeld.json'))) return;
    const t = Date.now();
    if (!homeyHerpogingen) homeyLeesPoging = t;   // begin van een uurvenster; herpogingen schuiven het niet op
    homeyVolgende = t + HOMEY_LEES_MS;   // tot de ronde terug is: geen tweede start
    return homeyRondeDraai('uur', 'lees').then(function (u) { homeyNaLees(u, t); if (u && u.ok === true) homeyVaultSchrijf(false); })
      .catch(function (e) { homeyNaLees({ ok: false, reden: 'fout' }, t); S.logError('homey-lees', e); });
  }
  let homeyNuBezig = null, homeyNuLaatst = 0;
  const HOMEY_NU_MS = 30 * 1000;
  function homeyNuDraai() {
    if (!homeyMod) return Promise.resolve({ ok: false, reden: 'module' });
    if (!S.rolPrimair()) return Promise.resolve({ ok: false, reden: 'reserve' });
    if (!fs.existsSync(path.join(S.HOMEY_DIR, 'gekoppeld.json'))) return Promise.resolve({ ok: false, reden: 'toestemming' });
    if (homeyNuBezig) return homeyNuBezig;
    if (homeyBezig) return Promise.resolve({ ok: false, reden: 'bezig' });
    if (Date.now() - homeyNuLaatst < HOMEY_NU_MS) return Promise.resolve({ ok: true, reden: 'kort' });
    homeyNuLaatst = Date.now();
    homeyNuBezig = homeyMod.ronde(homeyDeps(), 'nu').then(function (r) {
      const u = homeySchoon(r);
      S.schrijfLog(S.nu() + ' homey ' + S.velden({ opdracht: 'nu', bron: 'app', ok: u.ok === true, reden: u.reden || undefined, geroteerd: u.geroteerd || undefined, nood: u.nood || undefined }));
      if (u.ok !== true && u.reden === 'grant') homeyBoxRij('grant', u.fout);   // de uurronde ziet daarna alleen nog 'dood'
      else if (u.nood) homeyBoxRij('kluis', u.fout);
      return u;
    }).catch(function (e) { S.logError('homey-nu', e); return { ok: false, reden: 'fout' }; })
      .finally(function () { homeyNuBezig = null; });
    return homeyNuBezig;
  }
  // Terugkeer na Davids inlog. Athom levert code en state als form_post (POST, application/x-www-form-urlencoded); GET met query ook.
  function homeyTerug(req, res) {
    const kaal404 = function () { if (!res.headersSent) { res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('niet gevonden'); } };
    if (!homeyMod || (req.method !== 'GET' && req.method !== 'POST')) { req.resume(); return kaal404(); }
    const verder = function (q) {
      const state = q.get('state') || '', code = q.get('code') || '', fout = q.get('error') || '';
      if (!/^[0-9a-f]{64}$/.test(state) || code.length > 2000 || /[^\x21-\x7e]/.test(code) || fout.length > 100 || (!code && !fout)) return kaal404();
      res._log = { homey_terug: 1 };
      if (!S.rolPrimair()) return S.bankPagina(res, 503, 'Even niet beschikbaar', 'Er is niets gekoppeld. Probeer het later opnieuw met een nieuwe link van Socev.');
      if (!homeyMod.stateOpen(S.HOMEY_DIR, state)) return kaal404();
      const t = Date.now();
      while (homeyTerugTijden.length && t - homeyTerugTijden[0] > 3600000) homeyTerugTijden.shift();
      if (homeyTerugTijden.length >= HOMEY_TERUG_PER_UUR) { res.writeHead(429, { 'Content-Type': 'text/plain' }); return res.end('te vaak'); }
      homeyTerugTijden.push(t);
      homeyMod.terug(homeyDeps(), state, code, fout ? 'ja' : '').then(function (u) {
        res._log.homey = u.soort;
        S.schrijfLog(S.nu() + ' homey ' + S.velden({ opdracht: 'terug', soort: u.soort, reden: u.reden, nood: u.nood || undefined, scope: u.scope || undefined }));
        if (u.soort === 'dicht') return kaal404();
        if (u.soort === 'bezig') return S.bankPagina(res, 503, 'Nog even geduld', 'Socev was net bezig met Homey. Laad deze pagina over een minuut opnieuw; de link is nog geldig.');
        if (u.soort !== 'gekoppeld') return S.bankPagina(res, 200, 'Niet gekoppeld', 'De koppeling werd afgebroken of lukte niet. Er is niets bewaard. Wil je het opnieuw proberen, vraag dan om een nieuwe link.');
        try { fs.writeFileSync(path.join(S.HOMEY_DIR, 'gekoppeld.json'), JSON.stringify({ tijd: new Date().toISOString() }), { mode: 0o600 }); } catch (e) {}
        if (u.nood) homeyBoxRij('kluis', 'inlog gelukt, kluis nog niet bijgewerkt');
        S.bankPagina(res, 200, 'Gekoppeld', 'Homey is gekoppeld; Socev kan nu alleen meekijken, niets schakelen. Je kunt dit venster sluiten.');
        homeyRondeDraai('inlog').catch(function (e) { S.logError('homey-ronde', e); });   // meteen de toollijst meten
      }).catch(function (e) {
        S.logError('homey-terug', e);
        if (!res.headersSent) S.bankPagina(res, 502, 'Koppelen lukte niet', 'Er ging iets mis. Er is niets gekoppeld. Vraag om een nieuwe link.');
      });
    };
    if (req.method === 'GET') {
      req.resume();
      let q; try { q = new URL(req.url, 'http://x').searchParams; } catch (e) { return kaal404(); }
      return verder(q);
    }
    if (!/^application\/x-www-form-urlencoded\b/i.test(String(req.headers['content-type'] || ''))) { req.resume(); return kaal404(); }
    let body = '', te = false;
    req.setEncoding('utf8');
    req.on('data', function (c) { if (te) return; body += c; if (body.length > 8192) { te = true; body = ''; } });
    req.on('end', function () { if (te) return kaal404(); verder(new URLSearchParams(body)); });
    req.on('error', function () { kaal404(); });
  }
  function homeyStand() { return { bezig: homeyBezig, nu_bezig: homeyNuBezig, volgende: homeyVolgende, herpogingen: homeyHerpogingen, reeks: homeyMisReeks }; }   // alleen voor toetsen
  return { homeyIsPad, homeyKluisLees, homeyKluisZet, homeyKind, homeyDeps, homeySchoon, homeyRondeLees, homeyInfo, homeyBoxRij, homeyRondeDraai, homeySmal, homeyVaultStaat, homeyVaultSchrijf, homeyNaLees, homeyTik, homeyNuDraai, homeyTerug, homeyStand };
}

if (require.main === module) {
  const dir = process.env.HOMEY_DIR || '/opt/data/homey';
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

module.exports = { pod, energieScherm, faseNiveau, dagVerloop, nuLees, REDIRECT, METHODEN, LEESLIJST, leesToets, perMinuut, apparatenKies, grootst, vastLees, dagSamenvat, vaultBlok, blokZet, metingLees, linkMaak, stateOpen, stateNeem, ronde, terug, slotNeem, slotLos, noodLees, noodWis, doodLees, verzoekToets, rpcUit, sha, HomeyFout };
