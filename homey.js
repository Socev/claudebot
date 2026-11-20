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
 * meting/<JJJJ-MM-DD>.json (per minuut [A1,A2,A3,W1,W2,W3,Wtotaal,Wlaadpaal], standen, laadpaal; 600).
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
    const r = await deps.kind(soort === 'lees' ? 'lees' : 'meet', { access: v.j._access });
    const j = r.j || { ok: false, fout: 'meten gaf geen JSON (exit ' + r.code + ')' };
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
  if (a.error) throw new HomeyFout('mcp', 'MCP ' + methode + ': fout ' + String(a.error.code || '') + ' ' + tekst(String(a.error.message || ''), 80));
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
function gestructureerd(res, sleutel) {
  const sc = res && res.structuredContent;
  if (res && res.isError) throw new HomeyFout('mcp', 'MCP-tool gaf een fout');
  if (!sc || !Array.isArray(sc[sleutel])) throw new HomeyFout('mcp', 'MCP-tool zonder ' + sleutel);
  return sc[sleutel];
}
// Kies uit list_devices de dongle (heeft alle zes fasewaarden) en de laadpaal (type evcharger). Alleen id's en getallen gaan verder.
function apparatenKies(devs) {
  const dongle = devs.find(function (d) { return d && UUID.test(String(d.id)) && d.state && FASE_CAPS.every(function (c) { return getal(d.state[c]) != null; }); }) || null;
  const laad = devs.find(function (d) { return d && UUID.test(String(d.id)) && d.type === 'evcharger' && d.state; }) || null;
  const st = function (d, c) { return d ? getal(d.state[c]) : null; };
  return {
    dongle: dongle ? dongle.id : null, laadpaal: laad ? laad.id : null,
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
    r[i] = hoogst(r[i], v);
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
      j.m[mm] = o ? o.map(function (x, i) { return hoogst(x, r[i]); }) : r;
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
async function kindLees(invoer, dir) {
  const token = invoer.access;
  if (typeof token !== 'string' || !TOKEN_VORM.test(token)) throw new HomeyFout('token', 'geen access token');
  const staat = { sessie: null, protocol: PROTOCOL };
  const init = await rpc(token, staat, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Socev', version: '1.0' } }, 1);
  if (typeof init.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(init.protocolVersion)) staat.protocol = init.protocolVersion;
  await rpc(token, staat, 'notifications/initialized', null, null);
  let n = 2;
  const keus = apparatenKies(gestructureerd(await rpc(token, staat, 'tools/call', { name: 'list_devices', arguments: {} }, n++), 'devices'));
  if (!keus.dongle) throw new HomeyFout('dongle', 'geen apparaat met stroom en vermogen per fase gevonden');
  const logs = { a1: 'measure_current.phase1', a2: 'measure_current.phase2', a3: 'measure_current.phase3', w1: 'measure_power.phase1', w2: 'measure_power.phase2', w3: 'measure_power.phase3' };
  const reeksen = {}, gaten = [];
  const haal = async function (naam, id, cap) {
    try {
      const res = await rpc(token, staat, 'tools/call', { name: 'get_insights_log_entries_number', arguments: { logId: 'homey:device:' + id + ':' + cap, resolution: RESOLUTIE } }, n++);
      reeksen[naam] = gestructureerd(res, 'entries').slice(0, 5000);
    } catch (e) { if (e.reden === 'mcp') gaten.push(naam); else throw e; }   // -32602: Athom weigert een reeks met een lege waarde
  };
  for (const k of Object.keys(logs)) await haal(k, keus.dongle, logs[k]);
  if (keus.laadpaal) await haal('ev', keus.laadpaal, 'energy_power');
  const nu = new Date().toISOString();
  const stand = Object.assign({}, keus.stand, { laadpaal: keus.laad });
  const nieuw = metingVoegToe(dir, perMinuut(reeksen), stand, nu);
  const hoogste = [1, 2, 3].map(function (i) { return (reeksen['a' + i] || []).reduce(function (m, e) { return hoogst(m, getal(e && e.v)); }, null); });
  return { ok: true, soort: 'lees', tijd: nu, minuten: nieuw, gaten: gaten, nu_a: keus.stand.a, uur_max_a: hoogste, laadpaal: !!keus.laadpaal,
    laden: !!(keus.laad && keus.laad.laden) };
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
      if (s.max_a[i] == null || a > s.max_a[i]) { s.max_a[i] = a; s.max_a_om[i] = mm; }
      if (a >= WAARSCHUW_A) s.boven_20[i]++;
      if (a > ZEKERING_A) s.boven_25[i]++;
    }
    if (r[6] != null && (s.piek_w == null || r[6] > s.piek_w)) { s.piek_w = r[6]; s.piek_w_om = mm; }
    if (r[7] != null && r[7] >= 1000) s.laad_min++;
    s.laad_max_w = hoogst(s.laad_max_w, r[7]);
  });
  const st = (j.standen || []).filter(function (x) { return x && typeof x.import_kwh === 'number'; });
  if (st.length >= 2) s.kwh = Math.round((st[st.length - 1].import_kwh - st[0].import_kwh) * 10) / 10;
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
    const fi = s.max_a.reduce(function (b, a, i) { return a != null && (b < 0 || a > s.max_a[b]) ? i : b; }, -1);
    rijen.push('| ' + dag + ' | ' + Math.round(s.minuten / 6) / 10 + ' u | ' + maxA + (fi >= 0 ? ' (L' + (fi + 1) + ' om ' + s.max_a_om[fi] + ')' : '') + ' | ' +
      s.boven_20.join(' / ') + ' | ' + s.boven_25.join(' / ') + ' | ' + (s.piek_w == null ? '–' : nlGetal(s.piek_w / 1000, 1) + ' kW om ' + s.piek_w_om) + ' | ' +
      (s.laad_max_w == null ? '–' : s.laad_min + ' min, piek ' + nlGetal(s.laad_max_w / 1000, 1) + ' kW') + ' | ' + (s.kwh == null ? '–' : nlGetal(s.kwh, 1)) + ' |');
  });
  const bij = NL.format(new Date(nuIso));
  return [BLOK_BEGIN,
    'Bron: Homey Energy Dongle op de slimme meter (3-fase, hoofdzekering ' + ZEKERING_A + ' A) en de laadpaal in Homey; elk uur het laatste uur per 5 seconden,',
    'per minuut de hoogste waarde. ' + WAARSCHUW_A + ' A = 80 % van de zekering. Alleen lezen; Socev schakelt niets. Bijgewerkt ' + bij + '.',
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
  if (opdracht !== 'wissel' && opdracht !== 'ververs') throw new HomeyFout('opdracht', 'opdracht: wissel, ververs, meet, lees, stand');
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

module.exports = { REDIRECT, METHODEN, LEESLIJST, leesToets, perMinuut, apparatenKies, dagSamenvat, vaultBlok, blokZet, metingLees, linkMaak, stateOpen, stateNeem, ronde, terug, slotNeem, slotLos, noodLees, noodWis, doodLees, verzoekToets, rpcUit, sha, HomeyFout };
