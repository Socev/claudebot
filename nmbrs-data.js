'use strict';
/*
 * nmbrs-data.js — Nmbrs REST-API (salarisadministratie, Aurore), alleen lezen (wv2797, 8-11-2026).
 * Ontwerp: vault 01_Ontwikkeling/Nmbrs-koppeling (ontwerp 8-11-2026).md (review Codex NO-GO, beide MOET verwerkt).
 *
 * TWEE ROLLEN IN ÉÉN BESTAND (zelfde vorm als tibber-data.js).
 *  1. Module voor server.js (require): toestemmingslink (state 32 bytes, 48 uur, eenmalig + PKCE S256), state innemen, en de regie
 *     van een ronde (slot O_EXCL, noodkopie eerst, kluis vooraf toetsen, verversen, nieuw refresh token duurzaam, pas dan lezen).
 *     De kluis (Management-API) zit in server.js en komt binnen als deps.kluisLees / deps.kluisZet.
 *  2. Kindproces (node nmbrs-data.js <opdracht>): de enige plek die Nmbrs aanroept. Omgeving alleen PATH/HOME/TZ/LANG en NMBRS_DIR;
 *     geheimen via stdin. Netwerk: wissel (code → tokens), ververs (refresh → tokens), intrek (revocation), ronde, peil.
 *     Lokaal (geen netwerk): stand, signalen, gemeld, persoon, koppel, instel.
 *
 * NETWERK. Eén fetch, in roep(), altijd eerst door verzoekToets: POST alleen op identityservice /connect/token en /connect/revocation,
 * GET alleen op de witte lijst paden van api.nmbrsapp.com (PADEN_GET) met per pad de toegestane queryparameters; /api/documents/{taskId}
 * alleen met een taskId die dit proces zelf van journalsemployee kreeg. Redirects uit. Een toetsbasis mag alleen http://127.0.0.1:<poort>.
 * Nooit op de lijst: privateInfos (BSN), personalinfo, addresses, bankaccounts, children, partner, absences (verzuim), payslips, documenten.
 *
 * OPSLAG. NMBRS_DIR (700): nmbrs.sqlite (600), states.json (600; sha256 van de state → verifier), refresh.nood (600, alleen tussen verversen
 * en kluis), dood.json, ronde.lock (O_EXCL), instellingen.json (signalen aan/uit). Uit elk antwoord alleen velden op de witte lijst
 * (kies()); onbekende velden alleen als naam in de peiling. Geen BSN, geboortedatum, adres, IBAN, e-mail, telefoon, gezin, verzuim.
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const SCOPES = ['offline_access', 'user.info.read', 'debtor.info.read', 'company.info.read', 'company.payrollsettings.read', 'company.leave.read',
  'employee.info.read', 'employee.employment.read', 'employee.orgstructure.read', 'employee.payment.read', 'employee.leave.read'];
const REDIRECT = 'https://bank.socev.dev/nmbrs/terug';
const UA = 'Socev/1.0';
const STATE_MS = 48 * 3600 * 1000;
const SLOT_OUD_MS = 30 * 60 * 1000;
const PAUZE_MS = process.env.NMBRS_PAUZE_MS != null ? Number(process.env.NMBRS_PAUZE_MS) : 300;
const MAX_PAGINAS = 50;          // per lijst
const MAX_VRAGEN = 3000;         // per ronde (Starter: 500/min, 50.000/maand)
const MAX_BEDRIJVEN = 25;
const MAX_JOURNALEN = 3;         // nieuwe loonruns per bedrijf per ronde (de rest volgt de dagen erna)
const MAX_DOC = 8 * 1024 * 1024;

function basis(v, echt) {
  if (!v) return echt;
  if (/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(v)) return v;
  throw new Error('toetsbasis alleen op 127.0.0.1');
}
const AUTH_BASIS = basis(process.env.NMBRS_AUTH_BASIS, 'https://identityservice.nmbrs.com');
const API_BASIS = basis(process.env.NMBRS_API_BASIS, 'https://api.nmbrsapp.com');
const TOKEN_PAD = '/connect/token', INTREK_PAD = '/connect/revocation';
const AUTHORIZE = 'https://identityservice.nmbrs.com/connect/authorize';

class NmbrsFout extends Error { constructor(reden, uitleg, status) { super(uitleg || reden); this.reden = reden; this.status = status || null; } }

// ── netwerk: alleen deze verzoeken ────────────────────────────────────────────────────────────────────────────────────
const G = '[0-9A-Za-z-]{1,64}';
const Q_LIJST = ['pageNumber', 'pageSize'];
const PADEN_GET = [
  ['^/api/user/info$', Q_LIJST], ['^/api/debtors$', Q_LIJST], ['^/api/debtors/' + G + '/companies$', Q_LIJST], ['^/api/companies$', Q_LIJST],
  ['^/api/companies/' + G + '/period$', []], ['^/api/companies/' + G + '/salarytables$', Q_LIJST], ['^/api/salarytable/' + G + '$', Q_LIJST],
  ['^/api/companies/' + G + '/salarytable/' + G + '/content$', Q_LIJST], ['^/api/companies/' + G + '/runs$', Q_LIJST.concat(['year'])],
  ['^/api/companies/' + G + '/runs/' + G + '/journalsemployee$', ['year']], ['^/api/documents/(' + G + ')$', []],
  ['^/api/companies/' + G + '/employees$', Q_LIJST],
  ['^/api/companies/' + G + '/employees/(employments|contracts|schedules|functions|departments|salaries|leaveBalances)$', Q_LIJST],
  ['^/api/companies/' + G + '/hourcodes$', Q_LIJST], ['^/api/employees/' + G + '/(fixedhours|variablehours)$', Q_LIJST.concat(['year', 'period'])],
].map(function (x) { return { re: new RegExp(x[0]), q: x[1] }; });
const DOC_PAD = 10;   // index van /api/documents in PADEN_GET
const Q_VORM = { pageNumber: /^[1-9]\d{0,2}$/, pageSize: /^(100|[1-9]\d?)$/, year: /^20\d\d$/, period: /^([1-9]|[1-4]\d|5[0-3])$/ };
const TAKEN = new Set();   // taskIds die dit proces zelf van journalsemployee kreeg
function verzoekToets(methode, url) {
  let u;
  try { u = new URL(url); } catch (e) { throw new NmbrsFout('pad', 'Nmbrs-adres niet toegestaan'); }
  if (u.username || u.password || u.hash) throw new NmbrsFout('pad', 'Nmbrs-adres niet toegestaan');
  if (methode === 'POST') {
    if (u.origin !== AUTH_BASIS || (u.pathname !== TOKEN_PAD && u.pathname !== INTREK_PAD) || u.search) throw new NmbrsFout('pad', 'POST alleen op token en revocation');
    return u.href;
  }
  if (methode !== 'GET') throw new NmbrsFout('pad', 'methode niet toegestaan');
  if (u.origin !== API_BASIS) throw new NmbrsFout('pad', 'GET alleen op api.nmbrsapp.com');
  const i = PADEN_GET.findIndex(function (r) { return r.re.test(u.pathname); });
  if (i < 0) throw new NmbrsFout('pad', 'Nmbrs-pad niet op de witte lijst');
  if (i === DOC_PAD && !TAKEN.has(PADEN_GET[i].re.exec(u.pathname)[1])) throw new NmbrsFout('pad', 'document alleen voor een eigen journaaltaak');
  const gezien = new Set();
  for (const [k, v] of u.searchParams) {
    if (PADEN_GET[i].q.indexOf(k) < 0 || !Q_VORM[k].test(v) || gezien.has(k)) throw new NmbrsFout('pad', 'queryparameter niet toegestaan');
    gezien.add(k);
  }
  return u.href;
}
function slaap(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// De enige netwerkaanroep. Herhalen: GET op 429/500/502/503/504, POST alleen op 429/503 (een verbruikt refresh token niet nog eens).
async function roep(methode, url, o) {
  const doel = verzoekToets(methode, url);
  const headers = { Accept: o.tekst ? '*/*' : 'application/json', 'User-Agent': UA };
  if (o.basic) headers.Authorization = 'Basic ' + Buffer.from(encodeURIComponent(o.basic[0]) + ':' + encodeURIComponent(o.basic[1])).toString('base64');
  if (o.token) { headers.Authorization = 'Bearer ' + o.token; headers['X-Subscription-Key'] = o.sub; }
  if (o.form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  for (let poging = 1; ; poging++) {
    let r;
    try { r = await fetch(doel, { method: methode, headers: headers, body: o.form ? new URLSearchParams(o.form).toString() : undefined, redirect: 'error', signal: AbortSignal.timeout(45000) }); }
    catch (e) {
      if (methode === 'GET' && poging < 4) { await slaap(Math.random() * Math.min(15000, PAUZE_MS * 2 ** poging)); continue; }
      throw new NmbrsFout('netwerk', 'Nmbrs niet bereikbaar (' + String(e && e.name || 'fout').slice(0, 40) + ')');
    }
    const herhaal = methode === 'POST' ? [429, 503] : [429, 500, 502, 503, 504];
    if (herhaal.indexOf(r.status) >= 0 && poging < 5) {
      await r.text().catch(function () {});
      const ra = Number(r.headers.get('retry-after'));
      await slaap(ra > 0 && ra <= 120 ? (PAUZE_MS ? ra * 1000 + Math.random() * 250 : 0) : Math.random() * Math.min(15000, PAUZE_MS * 2 ** poging));
      continue;
    }
    if (o.tekst) {
      const b = Buffer.from(await r.arrayBuffer());
      return { status: r.status, tekst: b.length <= MAX_DOC ? b.toString('utf8') : null, groot: b.length > MAX_DOC };
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
  try {
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
async function intrek(id, geheim, token, soort) {
  try { const r = await roep('POST', AUTH_BASIS + INTREK_PAD, { basic: [id, geheim], form: { token: token, token_type_hint: soort } }); return r.status === 200; }
  catch (e) { return false; }
}
async function tokenVraag(form, id, geheim) {
  const r = await roep('POST', AUTH_BASIS + TOKEN_PAD, { basic: [id, geheim], form: form });
  const err = r.j && typeof r.j.error === 'string' ? r.j.error.replace(/[^a-z_]/g, '').slice(0, 40) : '';
  if (r.status === 400 && err === 'invalid_grant') throw new NmbrsFout('grant', 'Nmbrs: invalid_grant (verlopen, ingetrokken of al gebruikt)', 400);
  if (r.status === 400 || r.status === 401) throw new NmbrsFout(err === 'invalid_client' || r.status === 401 ? 'client' : 'token', 'Nmbrs-token: HTTP ' + r.status + (err ? ' ' + err : ''), r.status);
  if (r.status !== 200 || !r.j || typeof r.j.access_token !== 'string' || !TOKEN_VORM.test(r.j.access_token)) throw new NmbrsFout('token', 'Nmbrs-token: HTTP ' + r.status, r.status);
  const refresh = typeof r.j.refresh_token === 'string' && TOKEN_VORM.test(r.j.refresh_token) ? r.j.refresh_token : null;
  const scopes = scopesVan(r.j);
  if (!scopesExact(scopes)) {   // andere rechten dan gevraagd: intrekken en melden (ontwerp punt 3)
    if (refresh) await intrek(id, geheim, refresh, 'refresh_token');
    await intrek(id, geheim, r.j.access_token, 'access_token');
    throw new NmbrsFout('scope', 'Nmbrs gaf andere rechten dan gevraagd (' + (scopes ? scopes.length : 0) + ' scopes; verwacht exact ' + SCOPES.length + '); ingetrokken');
  }
  return { access: r.j.access_token, refresh: refresh, verloopt_s: Number(r.j.expires_in) || null };
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
function noodLees(dir) {
  try { const j = JSON.parse(fs.readFileSync(noodPad(dir), 'utf8')); return j && TOKEN_VORM.test(j.refresh || '') ? j : null; } catch (e) { return null; }
}
function noodWis(dir) { try { fs.unlinkSync(noodPad(dir)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
function doodPad(dir) { return path.join(dir, 'dood.json'); }
function doodLees(dir) { try { const j = JSON.parse(fs.readFileSync(doodPad(dir), 'utf8')); return j && typeof j.token_sha === 'string' ? j : null; } catch (e) { return null; } }
function doodZet(dir, refresh) { const tmp = doodPad(dir) + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ sinds: new Date().toISOString(), token_sha: sha(refresh) }), { mode: 0o600 }); fs.renameSync(tmp, doodPad(dir)); }
function doodWis(dir) { try { fs.unlinkSync(doodPad(dir)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }

// ── toestemmingslink en state (in server.js, geen netwerk) ────────────────────────────────────────────────────────────
function statesPad(dir) { return path.join(dir, 'states.json'); }
function statesLees(dir) { try { const j = JSON.parse(fs.readFileSync(statesPad(dir), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } }
function statesSchrijf(dir, s) { const tmp = statesPad(dir) + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 }); fs.renameSync(tmp, statesPad(dir)); }
function sha(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function mapKlaar(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); }
function linkMaak(dir, clientId) {
  if (typeof clientId !== 'string' || !/^[\x21-\x7e]{4,200}$/.test(clientId)) throw new NmbrsFout('sleutel', 'client-id ontbreekt of heeft een vreemde vorm');
  mapKlaar(dir);
  const state = crypto.randomBytes(32).toString('hex');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const s = statesLees(dir), nu = Date.now();
  for (const k of Object.keys(s)) if (!s[k] || nu - Date.parse(s[k].sinds) > STATE_MS * 2) delete s[k];
  s[sha(state)] = { verifier: verifier, sinds: new Date(nu).toISOString() };
  statesSchrijf(dir, s);
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: SCOPES.join(' '), state: state,
    code_challenge: challenge, code_challenge_method: 'S256' });
  return { url: AUTHORIZE + '?' + q.toString(), geldig_tot: new Date(nu + STATE_MS).toISOString() };
}
function stateOpen(dir, state) { const w = statesLees(dir)[sha(state)]; return !!(w && !w.verbruikt && Date.now() - Date.parse(w.sinds) <= STATE_MS); }
function stateNeem(dir, state) {
  const s = statesLees(dir), k = sha(state), w = s[k];
  if (!w || w.verbruikt || Date.now() - Date.parse(w.sinds) > STATE_MS) return null;
  const v = w.verifier;
  s[k] = { sinds: w.sinds, verbruikt: new Date().toISOString() };
  statesSchrijf(dir, s);
  return v;
}

// ── slot (O_EXCL) ─────────────────────────────────────────────────────────────────────────────────────────────────────
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
      let w = null, mt = Date.now(); try { mt = fs.statSync(slotPad(dir)).mtimeMs; w = JSON.parse(fs.readFileSync(slotPad(dir), 'utf8')); } catch (e2) {}
      // review wv2797 MOET 1: een (nog) leeg of onleesbaar slot is pas oud na SLOT_OUD_MS op zijn mtime, nooit meteen
      const oud = w && w.sinds ? Date.now() - Date.parse(w.sinds) > SLOT_OUD_MS && !pidLeeft(Number(w.pid)) : Date.now() - mt > SLOT_OUD_MS;
      if (!oud || i) return false;
      try { fs.unlinkSync(slotPad(dir)); } catch (e3) {}
    }
  }
  return false;
}
function slotLos(dir) { try { fs.unlinkSync(slotPad(dir)); } catch (e) {} }

// ── regie (in server.js) ──────────────────────────────────────────────────────────────────────────────────────────────
// deps: { dir, kluisLees() → {client_id, client_secret, sub, refresh}, kluisZet(waarde) → sha256 teruggelezen, kind(opdracht, invoer) → {code, j}, wacht(ms) }
async function kluisBewaar(deps, waarde) {
  let laatste = null;
  for (let i = 0; i < 3; i++) {
    try { const h = await deps.kluisZet(waarde); if (h === sha(waarde)) return true; laatste = 'teruglezen gaf een andere waarde'; }
    catch (e) { laatste = String(e && e.message || e).slice(0, 120); }
    if (i < 2) await (deps.wacht || slaap)(1000 * 2 ** i);
  }
  throw new NmbrsFout('kluis', 'nieuw token niet in de kluis: ' + laatste);
}
async function ronde(deps, opdracht) {
  const dir = deps.dir, uit = { ok: false, begin: new Date().toISOString() };
  if (!slotNeem(dir)) return Object.assign(uit, { reden: 'bezig', fout: 'er loopt al een Nmbrs-ronde' });
  try {
    let k;
    try { k = await deps.kluisLees(); } catch (e) { return Object.assign(uit, { reden: 'kluis', fout: 'kluis niet bereikbaar; niets ververst' }); }
    if (!k || !k.client_id || !k.client_secret || !k.sub) return Object.assign(uit, { reden: 'sleutel', fout: 'client-id, -secret of subscription key ontbreekt in de kluis' });
    let refresh = k.refresh || null;
    const nood = noodLees(dir);
    if (nood) { await kluisBewaar(deps, nood.refresh); noodWis(dir); refresh = nood.refresh; uit.nood_hersteld = true; }
    if (!refresh) return Object.assign(uit, { reden: 'toestemming', fout: 'nog geen toestemming (nmbrs_refresh ontbreekt)' });
    const dood = doodLees(dir);
    if (dood && dood.token_sha === sha(refresh)) return Object.assign(uit, { reden: 'dood', fout: 'koppeling dood sinds ' + String(dood.sinds).slice(0, 10) + '; wacht op nieuwe toestemming' });
    if (dood) doodWis(dir);
    const v = await deps.kind('ververs', { client_id: k.client_id, client_secret: k.client_secret, refresh: refresh });
    if (v.j && v.j.ok !== true && v.j.reden === 'grant') doodZet(dir, refresh);
    if (!v.j || v.j.ok !== true) return Object.assign(uit, { reden: (v.j && v.j.reden) || 'kind', fout: (v.j && v.j.fout) || 'verversen faalde (exit ' + v.code + ')' });
    const nieuw = v.j._refresh || null;
    if (nieuw && nieuw !== refresh) {
      try { await kluisBewaar(deps, nieuw); }
      catch (e) { return Object.assign(uit, { reden: 'kluis', fout: e.message, nood: true }); }
    }
    noodWis(dir);
    uit.geroteerd = !!(nieuw && nieuw !== refresh);
    const r = await deps.kind(opdracht === 'peil' ? 'peil' : 'ronde', { access: v.j._access, sub: k.sub });
    const j = r.j || { ok: false, fout: 'lezen gaf geen JSON (exit ' + r.code + ')' };
    return Object.assign(uit, j, { begin: uit.begin, geroteerd: uit.geroteerd, nood_hersteld: uit.nood_hersteld });
  } catch (e) {
    return Object.assign(uit, { reden: e.reden || 'fout', fout: String(e && e.message || e).slice(0, 200), nood: e.reden === 'kluis' ? true : undefined });
  } finally { slotLos(dir); }
}
async function terug(deps, state, code, fout) {
  const dir = deps.dir;
  if (!stateOpen(dir, state)) return { status: 404, soort: 'dicht' };
  if (!slotNeem(dir)) return { status: 503, soort: 'bezig' };
  try {
    const verifier = stateNeem(dir, state);
    if (!verifier) return { status: 404, soort: 'dicht' };
    if (fout) return { status: 200, soort: 'mislukt', reden: 'geweigerd' };
    let k;
    try { k = await deps.kluisLees(); } catch (e) { return { status: 502, soort: 'mislukt', reden: 'kluis' }; }
    if (!k || !k.client_id || !k.client_secret) return { status: 502, soort: 'mislukt', reden: 'sleutel' };
    const w = await deps.kind('wissel', { client_id: k.client_id, client_secret: k.client_secret, code: code, verifier: verifier });
    if (!w.j || w.j.ok !== true) return { status: 200, soort: (w.j && w.j.reden) === 'scope' ? 'scope' : 'mislukt', reden: (w.j && w.j.reden) || 'kind' };
    if (!w.j._refresh) { noodWis(dir); return { status: 200, soort: 'mislukt', reden: 'geen refresh token (offline_access?)' }; }
    try { await kluisBewaar(deps, w.j._refresh); }
    catch (e) { doodWis(dir); return { status: 200, soort: 'gekoppeld', reden: 'kluis', nood: true }; }
    noodWis(dir);
    doodWis(dir);
    return { status: 200, soort: 'gekoppeld' };
  } finally { slotLos(dir); }
}

// ── witte lijst velden ────────────────────────────────────────────────────────────────────────────────────────────────
// Alleen deze velden, alleen getallen, ja/nee, null of korte tekst. Al het andere in een antwoord valt weg (alleen de naam in de peiling).
function kies(o, velden) {
  const u = {};
  if (!o || typeof o !== 'object' || Array.isArray(o)) return u;
  for (const v of velden) {
    if (!Object.hasOwn(o, v)) continue;
    const w = o[v];
    if (w === null || typeof w === 'boolean' || (typeof w === 'number' && Number.isFinite(w))) u[v] = w;
    else if (typeof w === 'string' && w.length <= 120) u[v] = w.replace(/[\x00-\x1f]/g, ' ');
  }
  return u;
}
const V = {
  bedrijf: ['companyId', 'number', 'name', 'debtorId'],
  debiteur: ['debtorId', 'number', 'name'],
  medewerker: ['employeeNumber', 'firstName', 'prefix', 'lastName'],
  employments: ['employmentId', 'startDate', 'endDate', 'seniorityDate', 'creationDate', 'changedDate'],
  contracts: ['contractId', 'startDate', 'endDate', 'trialPeriod', 'indefinite', 'writtenContract', 'hoursPerWeek', 'createdAt'],
  schedules: ['scheduleId', 'startDate', 'parttimePercentage', 'hoursPerWeek', 'daysPerWeek', 'createdAt'],
  week: ['hoursMonday', 'hoursTuesday', 'hoursWednesday', 'hoursThursday', 'hoursFriday', 'hoursSaturday', 'hoursSunday'],
  functions: ['functionId', 'code', 'description', 'startDate', 'createdAt'],
  departments: ['departmentId', 'code', 'description', 'startDate', 'createdAt'],
  salaries: ['salaryId', 'startDate', 'type', 'value', 'createdAt'],
  salaristabel: ['tableId', 'tableCode', 'tableName', 'tableVersion'],
  schaal: ['scaleCode', 'scaleDescription'], trede: ['stepCode', 'stepDescription'],
  leaveBalances: ['leaveGroupId', 'leaveBalance'],
  tabel: ['salaryTableId', 'tableCode', 'tableName'], versie: ['versionId', 'version', 'year', 'month'],
  stap: ['stepCode', 'stepDescription', 'amountMonth', 'amountFourWeeks', 'amountWeek', 'amountHour'],
  run: ['payrollRunId', 'number', 'description', 'year', 'periodStart', 'periodEnd', 'createdAt', 'type', 'locked'],
  uren: ['hourCode', 'hourCodeDescription', 'hours'],
};
// Veldnamen (nooit waarden) voor de peiling.
function namen(o, pre, set, diep) {
  if (!o || typeof o !== 'object' || diep > 4) return;
  if (Array.isArray(o)) { o.slice(0, 20).forEach(function (x) { namen(x, pre + '[]', set, diep + 1); }); return; }
  for (const k of Object.keys(o).slice(0, 80)) {
    const n = /^[A-Za-z0-9_-]{1,50}$/.test(k) ? k : '?';
    const p = pre ? pre + '.' + n : n;
    if (o[k] && typeof o[k] === 'object') namen(o[k], p, set, diep + 1); else set.add(p);
  }
}

// ── opslag ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function db(dir) {
  mapKlaar(dir);
  const p = path.join(dir, 'nmbrs.' + 'sqlite');
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(p);
  fs.chmodSync(p, 0o600);
  d.exec('pragma busy_timeout = 10000;' +
    'create table if not exists bedrijf (id text primary key, debiteur text, data text not null, periode_soort text, periode_jaar integer, periode integer, gezien text not null);' +
    'create table if not exists medewerker (id text primary key, bedrijf text not null, data text not null, gezien text not null);' +
    // soort: dienstverband, contract, rooster, functie, afdeling, salaris, verlofsaldo
    'create table if not exists historie (soort text not null, medewerker text not null, bedrijf text not null, sub text not null, data text not null, primary key (soort, medewerker, sub)) without rowid;' +
    'create table if not exists salaristabel (bedrijf text not null, tabel text not null, versie text not null, data text not null, primary key (bedrijf, tabel, versie)) without rowid;' +
    'create table if not exists salaristrede (versie text not null, schaal text not null, trede text not null, data text not null, primary key (versie, schaal, trede)) without rowid;' +
    'create table if not exists loonrun (id text primary key, bedrijf text not null, data text not null, journaal text, journaal_tijd text);' +
    'create table if not exists loonrun_regel (run text not null, medewerker text not null, soort text not null, bedrag real not null, primary key (run, medewerker, soort)) without rowid;' +
    'create table if not exists uren (medewerker text not null, jaar integer not null, periode integer not null, uren real not null, gezien text not null, primary key (medewerker, jaar, periode)) without rowid;' +
    'create table if not exists bedrijf_entiteit (bedrijf text primary key, entiteit text not null, door text, sinds text not null);' +
    'create table if not exists signaal (sleutel text primary key, soort text not null, eerst text not null, laatst text not null, gemeld text);' +
    'create table if not exists ronde (volg integer primary key, begin text, eind text, ok integer, uitkomst text);');
  return d;
}
function lid(d, sql, args) { const s = d.prepare(sql); return s.all.apply(s, args || []); }

// ── kindopdrachten: lezen ─────────────────────────────────────────────────────────────────────────────────────────────
function idVan(v) { return typeof v === 'string' && new RegExp('^' + G + '$').test(v) ? v : null; }
function nieuweLezer(token, sub, peil) {
  const L = { vragen: 0, eindpunten: {}, velden: {} };
  function soortVan(pad) { return pad.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}').replace(/\?.*$/, ''); }
  L.haal = async function (pad, tekst) {
    if (L.vragen >= MAX_VRAGEN) throw new NmbrsFout('grens', 'meer dan ' + MAX_VRAGEN + ' vragen in één ronde');
    if (L.vragen && PAUZE_MS) await slaap(PAUZE_MS / 3);
    L.vragen++;
    const r = await roep('GET', API_BASIS + pad, { token: token, sub: sub, tekst: !!tekst });
    const s = soortVan(pad);
    L.eindpunten[s] = L.eindpunten[s] && L.eindpunten[s] !== r.status ? L.eindpunten[s] + ',' + r.status : r.status;
    if (r.status === 401) throw new NmbrsFout('token', 'Nmbrs: 401 (token of subscription key niet geldig)', 401);
    if (peil && r.j) { const set = L.velden[s] || (L.velden[s] = new Set()); namen(r.j, '', set, 0); }
    return r;
  };
  // Alle pagina's van een lijst (pageSize 100). 403/404 → null (recht ontbreekt of niet beschikbaar); de ronde gaat door.
  L.alle = async function (pad, extra) {
    const uit = [];
    for (let p = 1; p <= MAX_PAGINAS; p++) {
      const q = new URLSearchParams(Object.assign({ pageNumber: String(p), pageSize: '100' }, extra || {}));
      const r = await L.haal(pad + '?' + q.toString());
      if (r.status === 403 || r.status === 404) return p === 1 ? null : uit;
      if (r.status !== 200 || !r.j || typeof r.j !== 'object') throw new NmbrsFout('http', 'Nmbrs: HTTP ' + r.status + ' op ' + soortVan(pad), r.status);
      const data = Array.isArray(r.j.data) ? r.j.data : (Array.isArray(r.j) ? r.j : []);
      uit.push.apply(uit, data);
      const tp = r.j.pagination && Number(r.j.pagination.totalPages);
      if (!data.length || !(tp > p)) break;
    }
    return uit;
  };
  return L;
}
// Per medewerker de geschiedenis uit een lijst-endpoint → [[medewerker, sub, data]].
function historieRijen(lijst, veld, velden, sub) {
  const uit = [];
  (lijst || []).forEach(function (e) {
    const mw = idVan(e && e.employeeId); if (!mw) return;
    (Array.isArray(e[veld]) ? e[veld] : []).slice(0, 200).forEach(function (x, i) {
      const data = kies(x, velden);
      if (veld === 'schedules') { const w1 = kies(x && x.week1, V.week), w2 = kies(x && x.week2, V.week); data.weekuren = weekUren(w1, w2); }
      if (veld === 'salaries' && x && x.salaryTable) {
        data.tabel = kies(x.salaryTable, V.salaristabel);
        data.schaal = kies(x.salaryTable.scale, V.schaal); data.trede = kies(x.salaryTable.step, V.trede);
      }
      uit.push([mw, String((x && idVan(x[sub])) || i), data]);
    });
  });
  return uit;
}
function weekUren(w1, w2) {
  const som = function (w) { return Object.keys(w).reduce(function (a, k) { return a + (Number(w[k]) || 0); }, 0); };
  const a = som(w1), b = som(w2);
  if (!a && !b) return null;
  return Math.round(((a || b) + (b || a)) / 2 * 100) / 100;
}
const HIST = [['employments', 'employments', 'dienstverband', 'employmentId'], ['contracts', 'contracts', 'contract', 'contractId'], ['schedules', 'schedules', 'rooster', 'scheduleId'],
  ['functions', 'functions', 'functie', 'functionId'], ['departments', 'departments', 'afdeling', 'departmentId'], ['salaries', 'salaries', 'salaris', 'salaryId'],
  ['leaveBalances', 'leaveBalances', 'verlofsaldo', 'leaveGroupId']];

// Journaal per medewerker (XML, via documents/{taskId}). Structuur nog niet gemeten: generiek lezen, alleen records met een
// personeelsnummer, een bedrag en een omschrijving die op de witte lijst van soorten past; de peiling toont alleen elementnamen.
function xmlBoom(t) {
  const wortel = { n: '#', k: [], t: '' }, stapel = [wortel];
  const re = /<(\/?)([A-Za-z_][\w.:-]{0,80})((?:\s+[^>]*?)?)(\/?)>|([^<]+)/g;
  let m, n = 0;
  t = String(t || '').replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>/g, '');
  while ((m = re.exec(t)) && n++ < 500000) {
    const top = stapel[stapel.length - 1];
    if (m[5] != null) { if (m[5].trim()) top.t += m[5].trim(); continue; }
    const naam = m[2].replace(/^.*:/, '');
    if (m[1]) { if (stapel.length > 1 && top.n === naam) stapel.pop(); continue; }
    const el = { n: naam, k: [], t: '' };
    const attr = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g; let a;
    while ((a = attr.exec(m[3] || ''))) el.k.push({ n: a[1].replace(/^.*:/, ''), k: [], t: a[2] });
    top.k.push(el);
    if (!m[4] && stapel.length < 30) stapel.push(el);
  }
  return wortel;
}
function xmlNamen(el, pre, set) { el.k.forEach(function (c) { const p = pre ? pre + '/' + c.n : c.n; set.add(p); if (set.size < 300) xmlNamen(c, p, set); }); }
const SOORT_RE = [['vakantiegeld', /vakantie\s*(geld|toeslag|bijslag)|holiday\s*allowance/i], ['eindejaars', /eindejaar|13e\s*maand|year.?end/i],
  ['pensioen', /pensioen|pension/i], ['wg_lasten', /werkgevers?(lasten|deel|premie)|employer/i], ['bruto', /^(bruto\s*)?(salaris|loon|uurloon|maandloon)$|^bruto\s*(salaris|loon)|gross\s*(salary|wage)/i]];
function journaalRegels(boom) {
  const regels = [];
  (function loop(el) {
    const blad = {};
    el.k.forEach(function (c) { if (!c.k.length && c.t) blad[c.n.toLowerCase()] = c.t; });   // bladeren en attributen
    const nr = Object.keys(blad).find(function (k) { return /^(employee_?number|employeenr|personeelsnummer|empnr|employeeid)$/.test(k); });
    const getal = function (k) { return blad[k] != null && /^-?\d+([.,]\d+)?$/.test(blad[k]) ? Number(String(blad[k]).replace(',', '.')) : null; };
    const oms = Object.keys(blad).find(function (k) { return /^(description|omschrijving|wagecodedescription|looncodeomschrijving|name)$/.test(k); });
    // review wv2797 MOET 2: het teken telt (correcties verlagen); debet/credit als debet − credit. Het formaat is nog niet gemeten:
    // de som per soort wordt pas na het optellen absoluut (zie journaal()), en de signalen S4/S5 staan uit tot de peiling.
    let bedrag = null;
    if (getal('debit') != null || getal('credit') != null) bedrag = (getal('debit') || 0) - (getal('credit') || 0);
    else { const k = Object.keys(blad).find(function (x) { return /^(amount|bedrag|value|waarde)$/.test(x) && getal(x) != null; }); if (k) bedrag = getal(k); }
    if (nr && oms && bedrag != null) {
      const s = SOORT_RE.find(function (x) { return x[1].test(blad[oms]); });
      if (s) regels.push({ nr: String(blad[nr]).slice(0, 40), soort: s[0], bedrag: bedrag });
    }
    el.k.forEach(loop);
  })(boom);
  return regels;
}
async function journaal(L, bedrijf, run, jaar) {
  const r = await L.haal('/api/companies/' + bedrijf + '/runs/' + run + '/journalsemployee?' + new URLSearchParams({ year: String(jaar) }).toString());
  if (r.status !== 200 || !r.j || !idVan(r.j.taskId)) return { status: 'taak:' + r.status };
  TAKEN.add(r.j.taskId);
  for (let i = 0; i < 8; i++) {
    await slaap(PAUZE_MS * 5 * (i + 1));
    const d = await L.haal('/api/documents/' + r.j.taskId, true);
    if (d.status === 202) continue;
    if (d.status !== 200 || d.tekst == null) return { status: 'document:' + d.status + (d.groot ? ':groot' : '') };
    const boom = xmlBoom(d.tekst);
    const set = new Set(); xmlNamen(boom, '', set);
    return { status: 'ok', regels: journaalRegels(boom), namen: [...set].slice(0, 200) };
  }
  return { status: 'document:wacht' };
}
function periodeVan(j) {
  const x = Array.isArray(j && j.data) ? j.data[0] : (j && j.data) || j;
  if (!x || typeof x !== 'object') return {};
  const p = x.period || {};
  const soort = ['month', '1-week', '4-weeks'].indexOf(x.periodType) >= 0 ? x.periodType : null;
  return { soort: soort, jaar: Number.isInteger(p.year) ? p.year : null, periode: Number.isInteger(p.period) ? p.period : null };
}
async function kindLees(invoer, dir, peil) {
  const token = invoer.access, sub = invoer.sub;
  if (typeof token !== 'string' || !TOKEN_VORM.test(token)) throw new NmbrsFout('token', 'geen access token');
  if (typeof sub !== 'string' || !/^[\x21-\x7e]{8,200}$/.test(sub)) throw new NmbrsFout('sleutel', 'geen subscription key');
  const L = nieuweLezer(token, sub, peil), nu = new Date().toISOString(), jaar = new Date().getFullYear();
  const uit = { ok: true, bedrijven: 0, medewerkers: 0, loonruns: 0, journalen: 0, regels: 0, uren: 0 };
  const extra = {};
  if (peil) {
    const ui = await L.alle('/api/user/info');
    extra.gebruiker = ui === null ? 'geen recht' : { profielen: ui.length };   // naam en e-mail van de inlogger: niet
    const deb = await L.alle('/api/debtors');
    extra.debiteuren = deb === null ? 'geen recht' : deb.slice(0, 50).map(function (x) { return kies(x, V.debiteur); });
  }
  let bedrijven = await L.alle('/api/companies');
  if (bedrijven === null) {   // terugval: via de debiteuren
    bedrijven = [];
    for (const db0 of ((await L.alle('/api/debtors')) || []).slice(0, 20)) {
      const did = idVan(db0 && db0.debtorId); if (!did) continue;
      bedrijven.push.apply(bedrijven, (await L.alle('/api/debtors/' + did + '/companies')) || []);
    }
  }
  const d = db(dir);
  for (const b of bedrijven.slice(0, MAX_BEDRIJVEN)) {
    const cid = idVan(b && b.companyId); if (!cid) continue;
    uit.bedrijven++;
    const per = await L.haal('/api/companies/' + cid + '/period');
    const pv = per.status === 200 ? periodeVan(per.j) : {};
    const lijsten = {};
    lijsten.employees = await L.alle('/api/companies/' + cid + '/employees');
    for (const h of HIST) lijsten[h[0]] = await L.alle('/api/companies/' + cid + '/employees/' + h[0]);
    // salaristabellen (schaal en trede; geen persoonsgegevens): per tabel de laatste geldige versie
    const tabellen = [];
    for (const t of ((await L.alle('/api/companies/' + cid + '/salarytables')) || []).slice(0, 15)) {
      const tid = idVan(t && t.salaryTableId); if (!tid) continue;
      const versies = ((await L.alle('/api/salarytable/' + tid)) || []).map(function (x) { return kies(x, V.versie); }).filter(function (x) { return idVan(x.versionId); });
      const nuJm = jaar * 100 + new Date().getMonth() + 1;
      const geldig = versies.filter(function (x) { return (x.year || 0) * 100 + (x.month || 0) <= nuJm; }).sort(function (a, c) { return (c.year * 100 + c.month) - (a.year * 100 + a.month) || (c.version || 0) - (a.version || 0); })[0];
      if (!geldig) continue;
      const inhoud = (await L.alle('/api/companies/' + cid + '/salarytable/' + geldig.versionId + '/content')) || [];
      tabellen.push({ tabel: tid, versie: geldig.versionId, data: Object.assign(kies(t, V.tabel), { versie: geldig }), inhoud: inhoud });
    }
    // loonruns van dit en vorig jaar
    const runs = [];
    for (const y of [jaar - 1, jaar]) { const l = await L.alle('/api/companies/' + cid + '/runs', { year: String(y) }); if (l) runs.push.apply(runs, l); }
    // schrijven: actuele stand per bedrijf vervangen, loonruns aanvullen
    d.exec('begin');
    try {
      d.prepare('insert into bedrijf (id, debiteur, data, periode_soort, periode_jaar, periode, gezien) values (?, ?, ?, ?, ?, ?, ?) on conflict (id) do update set debiteur = excluded.debiteur, ' +
        'data = excluded.data, periode_soort = excluded.periode_soort, periode_jaar = excluded.periode_jaar, periode = excluded.periode, gezien = excluded.gezien')
        .run(cid, idVan(b.debtorId), JSON.stringify(kies(b, V.bedrijf)), pv.soort || null, pv.jaar || null, pv.periode || null, nu);
      if (lijsten.employees) {
        d.prepare('delete from medewerker where bedrijf = ?').run(cid);
        const zet = d.prepare('insert or replace into medewerker (id, bedrijf, data, gezien) values (?, ?, ?, ?)');
        lijsten.employees.forEach(function (e) {
          const mw = idVan(e && e.employeeId); if (!mw) return;
          zet.run(mw, cid, JSON.stringify(kies(e.employeeBasicInfo || e, V.medewerker)), nu); uit.medewerkers++;
        });
      }
      for (const h of HIST) {
        if (!lijsten[h[0]]) continue;   // 403: oude stand laten staan
        d.prepare('delete from historie where bedrijf = ? and soort = ?').run(cid, h[2]);
        const zet = d.prepare('insert or replace into historie (soort, medewerker, bedrijf, sub, data) values (?, ?, ?, ?, ?)');
        historieRijen(lijsten[h[0]], h[1], V[h[0]], h[3]).forEach(function (r) { zet.run(h[2], r[0], cid, r[1], JSON.stringify(r[2])); });
      }
      tabellen.forEach(function (t) {
        d.prepare('delete from salaristabel where bedrijf = ? and tabel = ? and versie <> ?').run(cid, t.tabel, t.versie);
        d.prepare('insert or replace into salaristabel (bedrijf, tabel, versie, data) values (?, ?, ?, ?)').run(cid, t.tabel, t.versie, JSON.stringify(t.data));
        d.prepare('delete from salaristrede where versie = ?').run(t.versie);
        const zet = d.prepare('insert or replace into salaristrede (versie, schaal, trede, data) values (?, ?, ?, ?)');
        t.inhoud.slice(0, 500).forEach(function (s) {
          const sc = kies(s, V.schaal);
          if (!sc.scaleCode) return;
          (Array.isArray(s.steps) ? s.steps : []).slice(0, 100).forEach(function (st) { const x = kies(st, V.stap); if (x.stepCode != null) zet.run(t.versie, String(sc.scaleCode), String(x.stepCode), JSON.stringify(Object.assign({ scaleDescription: sc.scaleDescription }, x))); });
        });
      });
      const zetRun = d.prepare('insert into loonrun (id, bedrijf, data) values (?, ?, ?) on conflict (id) do update set data = excluded.data');
      runs.forEach(function (r) { const rid = idVan(r && r.payrollRunId); if (rid) { zetRun.run(rid, cid, JSON.stringify(kies(r, V.run))); uit.loonruns++; } });
      d.exec('commit');
    } catch (e) { d.exec('rollback'); throw e; }
    // journalen van nieuwe loonruns (laatste 13 maanden, nieuwste eerst, hooguit MAX_JOURNALEN per ronde)
    const nrNaarId = {};
    lid(d, 'select id, data from medewerker where bedrijf = ?', [cid]).forEach(function (m) { const x = JSON.parse(m.data); if (x.employeeNumber != null) nrNaarId[String(x.employeeNumber)] = m.id; });
    // review wv2797 MOET 5: herstelbare fouten (429, 5xx, wachten, netwerk) opnieuw, hooguit 5 keer; blijvend alleen bij een andere 4xx
    const open = lid(d, "select id, data from loonrun where bedrijf = ? and (journaal is null or journaal like 'opnieuw:%')", [cid]).map(function (r) { return { id: r.id, x: JSON.parse(r.data) }; })
      .filter(function (r) { return r.x.year >= jaar - 1; }).sort(function (a, c) { return (c.x.year * 100 + (c.x.periodEnd || 0)) - (a.x.year * 100 + (a.x.periodEnd || 0)); }).slice(0, MAX_JOURNALEN);
    for (const r of open) {
      let j;
      try { j = await journaal(L, cid, r.id, r.x.year); }
      catch (e) { if (e.reden === 'token' || e.reden === 'grens') throw e; j = { status: 'netwerk' }; }
      const vorig = /^opnieuw:.*:(\d+)$/.exec(d.prepare('select journaal from loonrun where id = ?').get(r.id).journaal || '');
      const poging = vorig ? Number(vorig[1]) + 1 : 1;
      const code = Number((/:(\d{3})/.exec(j.status) || [])[1]);
      const status = j.status === 'ok' ? 'ok:' : (code >= 400 && code < 500 && code !== 429) || poging >= 5 ? 'blijvend:' + j.status : 'opnieuw:' + j.status + ':' + poging;
      if (peil && j.namen) extra.journaal_elementen = j.namen;
      d.exec('begin');
      try {
        const som = {};
        (j.regels || []).forEach(function (g) { const mw = nrNaarId[g.nr]; if (!mw) return; const k = mw + '|' + g.soort; som[k] = (som[k] || 0) + g.bedrag; });
        d.prepare('delete from loonrun_regel where run = ?').run(r.id);
        const zet = d.prepare('insert into loonrun_regel (run, medewerker, soort, bedrag) values (?, ?, ?, ?)');
        Object.keys(som).forEach(function (k) { const [mw, s] = k.split('|'); zet.run(r.id, mw, s, Math.round(Math.abs(som[k]) * 100) / 100); uit.regels++; });
        d.prepare('update loonrun set journaal = ?, journaal_tijd = ? where id = ?').run(status + (j.status === 'ok' ? Object.keys(som).length : ''), nu, r.id);
        d.exec('commit');
      } catch (e) { d.exec('rollback'); throw e; }
      if (j.status !== 'ok') continue;
      uit.journalen++;
      // uurloners: betaalde uren van die periode (vaste + variabele urencomponenten; onbetaald telt niet)
      for (const m of lid(d, "select distinct medewerker from historie where soort = 'salaris' and bedrijf = ? and json_extract(data, '$.type') in ('grossHourlyWage', 'netHourlyWageExclWageComp', 'netHourlyWageInclWageComp')", [cid])) {
        // review wv2797 MOET 4: alleen een urentotaal als beide lijsten (vast én variabel) beschikbaar waren; anders geen S4 voor die persoon
        let totaal = 0, beide = 0;
        const per = r.x.periodStart || r.x.periodEnd || 1;
        for (const soort of ['fixedhours', 'variablehours']) {
          const l = await L.alle('/api/employees/' + m.medewerker + '/' + soort, { year: String(r.x.year), period: String(per) });
          if (l === null) continue;
          beide++;
          l.forEach(function (x) { const u = kies(x, V.uren); if (!/onbetaald|unpaid/i.test(String(u.hourCodeDescription || ''))) totaal += Number(u.hours) || 0; });
        }
        if (beide === 2) { d.prepare('insert or replace into uren (medewerker, jaar, periode, uren, gezien) values (?, ?, ?, ?, ?)').run(m.medewerker, r.x.year, per, totaal, nu); uit.uren++; }
        else d.prepare('delete from uren where medewerker = ? and jaar = ? and periode = ?').run(m.medewerker, r.x.year, per);
      }
    }
  }
  uit.vragen = L.vragen;
  uit.eindpunten = L.eindpunten;
  d.prepare('insert into ronde (begin, eind, ok, uitkomst) values (?, ?, ?, ?)').run(nu, new Date().toISOString(), 1, JSON.stringify(uit));
  d.prepare('delete from ronde where volg < (select max(volg) - 400 from ronde)').run();
  if (peil) {
    extra.bedrijven = lid(d, 'select id, data, periode_soort from bedrijf order by id').map(function (x) { const j = JSON.parse(x.data); return { id: x.id, nummer: j.number, naam: j.name, periode: x.periode_soort, entiteit: (d.prepare('select entiteit from bedrijf_entiteit where bedrijf = ?').get(x.id) || {}).entiteit || null }; });
    extra.veldnamen = {}; Object.keys(L.velden).forEach(function (k) { extra.veldnamen[k] = [...L.velden[k]].sort().slice(0, 120); });
  }
  d.close();
  return Object.assign(uit, extra);
}

// ── signalen (lokaal, geen netwerk, geen taalmodel) ──────────────────────────────────────────────────────────────────
const DAG = 86400000;
function datum(s) { const t = Date.parse(s); return isNaN(t) ? null : t; }
function dmj(t) { const d = new Date(t); return d.getUTCDate() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCFullYear(); }
function geldig(rijen, op) {   // laatste record met startDate ≤ op
  return rijen.filter(function (r) { const s = datum(r.startDate); return s != null && s <= op; })
    .sort(function (a, b) { return datum(b.startDate) - datum(a.startDate) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')); })[0] || null;
}
function periodeStart(soort, jaar, p) {
  if (soort === '4-weeks') return Date.UTC(jaar, 0, 1) + (p - 1) * 28 * DAG;
  if (soort === '1-week') return Date.UTC(jaar, 0, 1) + (p - 1) * 7 * DAG;
  return Date.UTC(jaar, p - 1, 1);
}
function periodeEind(soort, jaar, p) {
  if (soort === '4-weeks' || soort === '1-week') return periodeStart(soort, jaar, p) + (soort === '1-week' ? 7 : 28) * DAG - 1;
  return Date.UTC(jaar, p, 1) - 1;
}
const NAAR_PERIODE = { month: 1, '4-weeks': 12 / 13, '1-week': 12 / 52 };
function naamVan(m) { return [m.firstName, m.prefix, m.lastName].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || ('medewerker ' + (m.employeeNumber || '?')); }
function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function laad(d) {
  const bedrijven = {}, mw = {};
  lid(d, 'select b.id, b.data, b.periode_soort, e.entiteit from bedrijf b left join bedrijf_entiteit e on e.bedrijf = b.id').forEach(function (b) { bedrijven[b.id] = { naam: JSON.parse(b.data).name, soort: b.periode_soort || 'month', entiteit: b.entiteit || null }; });
  lid(d, 'select id, bedrijf, data from medewerker').forEach(function (m) { mw[m.id] = { id: m.id, bedrijf: m.bedrijf, info: JSON.parse(m.data), h: {} }; });
  lid(d, 'select soort, medewerker, data from historie').forEach(function (h) { const m = mw[h.medewerker]; if (m) (m.h[h.soort] || (m.h[h.soort] = [])).push(JSON.parse(h.data)); });
  return { bedrijven: bedrijven, mw: mw };
}
function inDienst(m, op) {
  const e = m.h.dienstverband || [];
  return e.some(function (x) { const s = datum(x.startDate), t = datum(x.endDate); return s != null && s <= op && (t == null || t >= op); });
}
// review wv2797 MOET 3: de versie die geldig is op de controledatum (jaar/maand ≤ op, nieuwste eerst), niet zomaar de eerste
function trede(d, bedrijf, sal, op) {
  if (!sal.tabel || !sal.schaal || !sal.trede || sal.schaal.scaleCode == null || sal.trede.stepCode == null) return null;
  const opJm = new Date(op).getUTCFullYear() * 100 + new Date(op).getUTCMonth() + 1;
  const v = d.prepare('select versie, data from salaristabel where bedrijf = ? and tabel = ?').all(bedrijf, String(sal.tabel.tableId || ''))
    .map(function (x) { const j = JSON.parse(x.data).versie || {}; return { versie: x.versie, jm: (Number(j.year) || 0) * 100 + (Number(j.month) || 0), nr: Number(j.version) || 0 }; })
    .filter(function (x) { return x.jm > 0 && x.jm <= opJm; }).sort(function (a, b) { return b.jm - a.jm || b.nr - a.nr; })[0];
  if (!v) return null;
  const r = d.prepare('select data from salaristrede where versie = ? and schaal = ? and trede = ?').get(v.versie, String(sal.schaal.scaleCode), String(sal.trede.stepCode));
  return r ? JSON.parse(r.data) : null;
}
// → [{ sleutel, soort, entiteit, naam, datum, tekst }]; nooit een bedrag in de tekst (die gaat naar de wachter en de app)
function signalenBereken(d, invoer, nu) {
  const { bedrijven, mw } = laad(d), uit = [];
  const vandaag = nu || Date.now();
  const zet = function (s) { uit.push(s); };
  Object.values(mw).forEach(function (m) {
    if (!inDienst(m, vandaag)) return;
    const b = bedrijven[m.bedrijf] || {}, naam = naamVan(m.info), ent = b.entiteit;
    const sal = geldig(m.h.salaris || [], vandaag), rst = geldig(m.h.rooster || [], vandaag), con = geldig(m.h.contract || [], vandaag);
    const pt = rst && Number(rst.parttimePercentage) > 0 ? Number(rst.parttimePercentage) / 100 : null;
    // S1: salaris lager dan schaal/trede (Nmbrs-salaristabel)
    if (sal && sal.value != null) {
      const t = trede(d, m.bedrijf, sal, vandaag);
      if (t) {
        const soort = b.soort || 'month';
        const tab = sal.type === 'grossHourlyWage' ? t.amountHour : soort === '4-weeks' ? t.amountFourWeeks : soort === '1-week' ? t.amountWeek : t.amountMonth;
        let min = Number(tab);
        if (sal.type === 'grossParttimeSalary') min = pt ? min * pt : NaN;
        if (['grossFulltimeSalary', 'grossParttimeSalary', 'grossHourlyWage'].indexOf(sal.type) >= 0 && min > 0 && Number(sal.value) < min * 0.995)
          zet({ sleutel: 'S1:' + m.id + ':' + (sal.salaryId || sal.startDate), soort: 'S1', entiteit: ent, naam: naam, datum: sal.startDate ? sal.startDate.slice(0, 10) : null,
            tekst: naam + ': salaris lager dan schaal ' + sal.schaal.scaleCode + ' trede ' + sal.trede.stepCode + ' in de salaristabel' });
      }
    }
    // S2: contract loopt binnen 6 weken af zonder opvolger
    if (con && con.indefinite !== true && datum(con.endDate) != null) {
      const eind = datum(con.endDate);
      const opvolger = (m.h.contract || []).some(function (x) { const s = datum(x.startDate); return s != null && s > datum(con.startDate) && s >= eind - DAG; });
      if (eind >= vandaag - DAG && eind <= vandaag + 42 * DAG && !opvolger)
        zet({ sleutel: 'S2:' + m.id + ':' + con.endDate.slice(0, 10), soort: 'S2', entiteit: ent, naam: naam, datum: con.endDate.slice(0, 10),
          tekst: naam + ': contract loopt af op ' + dmj(eind) + ', geen vervolgcontract in Nmbrs' });
    }
    // S3: roosteruren wijken af van de contracturen
    if (rst && con && Number(con.hoursPerWeek) > 0) {
      const ru = rst.weekuren != null ? rst.weekuren : Number(rst.hoursPerWeek);
      if (ru > 0 && Math.abs(ru - Number(con.hoursPerWeek)) > 0.5)
        zet({ sleutel: 'S3:' + m.id + ':' + (con.contractId || '') + ':' + (rst.scheduleId || ''), soort: 'S3', entiteit: ent, naam: naam, datum: rst.startDate ? rst.startDate.slice(0, 10) : null,
          tekst: naam + ': rooster ' + ru + ' uur per week, contract ' + Number(con.hoursPerWeek) + ' uur' });
    }
  });
  // S4: bruto in een loonrun wijkt > 3 % af van het verwachte bruto (zonder mutatie in of vlak voor de periode)
  lid(d, "select r.id, r.bedrijf, r.data from loonrun r where r.journaal like 'ok%'").forEach(function (r) {
    const x = JSON.parse(r.data), b = bedrijven[r.bedrijf] || {}, soort = b.soort || 'month';
    const p = x.periodStart || x.periodEnd; if (!x.year || !p) return;
    const ps = periodeStart(soort, x.year, p), pe = periodeEind(soort, x.year, x.periodEnd || p);
    if (pe < vandaag - 400 * DAG) return;
    const lengte = pe - ps + 1;
    lid(d, "select medewerker, bedrag from loonrun_regel where run = ? and soort = 'bruto'", [r.id]).forEach(function (g) {
      const m = mw[g.medewerker]; if (!m) return;
      const mutatie = ['salaris', 'rooster', 'contract', 'dienstverband'].some(function (s) { return (m.h[s] || []).some(function (h) { return [h.startDate, h.endDate].some(function (t) { const v = datum(t); return v != null && v >= ps - lengte && v <= pe; }); }); });
      if (mutatie) return;
      const sal = geldig(m.h.salaris || [], ps), rst = geldig(m.h.rooster || [], ps); if (!sal || sal.value == null) return;
      const pt = rst && Number(rst.parttimePercentage) > 0 ? Number(rst.parttimePercentage) / 100 : null;
      let verwacht = null;
      if (sal.type === 'grossFulltimeSalary' && pt) verwacht = Number(sal.value) * pt * NAAR_PERIODE[soort];
      else if (sal.type === 'grossParttimeSalary') verwacht = Number(sal.value) * NAAR_PERIODE[soort];
      else if (sal.type === 'grossHourlyWage') { const u = d.prepare('select uren from uren where medewerker = ? and jaar = ? and periode = ?').get(m.id, x.year, p); if (u && u.uren > 0) verwacht = Number(sal.value) * u.uren; }
      if (!(verwacht > 0)) return;
      const afw = (g.bedrag - verwacht) / verwacht;
      if (Math.abs(afw) > 0.03) {
        const naam = naamVan(m.info);
        zet({ sleutel: 'S4:' + r.id + ':' + m.id, soort: 'S4', entiteit: b.entiteit || null, naam: naam, datum: x.year + '-' + String(p).padStart(2, '0'),
          tekst: naam + ': bruto in loonrun ' + x.year + '/' + p + ' ligt ' + (afw > 0 ? 'boven' : 'onder') + ' de verwachting (meer dan 3 %)' });
      }
    });
  });
  // S5: vakantiegeld / eindejaarsuitkering niet in de verwachte maand (alleen als het journaal die soort ooit liet zien)
  const inst = invoer.instellingen || {};
  const verwacht = [['vakantiegeld', inst.vakantiegeld_periode || [5, 6], 'vakantiegeld'], ['eindejaars', inst.eindejaars_periode || [12], 'eindejaarsuitkering']];
  Object.keys(bedrijven).forEach(function (bid) {
    const b = bedrijven[bid]; if (b.soort !== 'month') return;
    const runs = lid(d, "select id, data from loonrun where bedrijf = ? and journaal like 'ok%'", [bid]).map(function (r) { return { id: r.id, x: JSON.parse(r.data) }; });
    verwacht.forEach(function (v) {
      if (!d.prepare("select 1 from loonrun_regel g join loonrun r on r.id = g.run where r.bedrijf = ? and g.soort = ? limit 1").get(bid, v[0])) return;
      const jaren = new Set(runs.map(function (r) { return r.x.year; }));
      jaren.forEach(function (y) {
        const laatst = Math.max(...v[1]);
        const inJaar = runs.filter(function (r) { return r.x.year === y; });
        if (!inJaar.some(function (r) { return (r.x.periodEnd || r.x.periodStart) >= laatst; })) return;   // die maand nog niet gedraaid
        const ids = inJaar.filter(function (r) { const p = r.x.periodEnd || r.x.periodStart; return p <= laatst && p >= Math.min(...v[1]) - 1; }).map(function (r) { return r.id; });
        if (!ids.length) return;
        const metSoort = new Set(), metBruto = new Set();
        ids.forEach(function (id) { lid(d, 'select medewerker, soort from loonrun_regel where run = ?', [id]).forEach(function (g) { if (g.soort === v[0]) metSoort.add(g.medewerker); if (g.soort === 'bruto') metBruto.add(g.medewerker); }); });
        metBruto.forEach(function (mid) {
          if (metSoort.has(mid) || !mw[mid]) return;
          const naam = naamVan(mw[mid].info);
          zet({ sleutel: 'S5:' + v[0] + ':' + y + ':' + mid, soort: 'S5', entiteit: b.entiteit, naam: naam, datum: y + '-' + String(laatst).padStart(2, '0'), tekst: naam + ': geen ' + v[2] + ' in de loonruns van ' + y + ' t/m periode ' + laatst });
        });
      });
    });
  });
  // S6: in dienst volgens Nmbrs zonder medewerkerpagina, of een actieve pagina zonder Nmbrs (alleen gekoppelde entiteiten)
  const vault = Array.isArray(invoer.vault) ? invoer.vault : null;
  if (vault) {
    const gekoppeld = new Set(Object.values(bedrijven).map(function (b) { return b.entiteit; }).filter(Boolean));
    const paginaNamen = {};
    vault.forEach(function (p) { if (!gekoppeld.has(p.entiteit)) return; (paginaNamen[p.entiteit] || (paginaNamen[p.entiteit] = [])).push({ p: p, n: new Set((p.namen || []).map(norm).filter(Boolean)) }); });
    const nmbrsNamen = {};
    Object.values(mw).forEach(function (m) {
      const ent = (bedrijven[m.bedrijf] || {}).entiteit; if (!ent || !inDienst(m, vandaag)) return;
      const n = norm(naamVan(m.info)), kort = norm([m.info.firstName, m.info.lastName].filter(Boolean).join(' '));
      (nmbrsNamen[ent] || (nmbrsNamen[ent] = [])).push(n, kort);
      const pag = (paginaNamen[ent] || []).some(function (x) { return x.n.has(n) || x.n.has(kort); });
      if (!pag) zet({ sleutel: 'S6:nmbrs:' + m.id, soort: 'S6', entiteit: ent, naam: naamVan(m.info), datum: null, tekst: naamVan(m.info) + ' (' + ent + '): in dienst volgens Nmbrs, geen medewerkerpagina gevonden' });
    });
    Object.keys(paginaNamen).forEach(function (ent) {
      paginaNamen[ent].forEach(function (x) {
        if (!x.p.actief) return;
        const n = new Set(nmbrsNamen[ent] || []);
        if (![...x.n].some(function (y) { return n.has(y); })) zet({ sleutel: 'S6:pagina:' + ent + ':' + String(x.p.naam || '').slice(0, 120), soort: 'S6', entiteit: ent, naam: String(x.p.naam || '').slice(0, 80), datum: null, tekst: String(x.p.naam || '').slice(0, 80) + ' (' + ent + '): actieve medewerkerpagina, niet in dienst volgens Nmbrs' });
      });
    });
  }
  return uit;
}
function instellingenLees(dir) { try { const j = JSON.parse(fs.readFileSync(path.join(dir, 'instellingen.json'), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } }
// signalen: alles berekenen (lokaal); 'nieuw' = aan (instellingen.signalen_aan) en nog nooit gemeld. Uitvoer zonder bedragen, schaal-
// bedragen of trede-bedragen (review MOET 1). 'gemeld' legt de sleutels vast nadat het bericht bezorgd is.
function kindSignalen(invoer, dir) {
  if (!fs.existsSync(path.join(dir, 'nmbrs.' + 'sqlite'))) return { ok: true, aan: [], signalen: [], nieuw: [], totaal: 0 };
  const inst = instellingenLees(dir), aan = new Set(Array.isArray(inst.signalen_aan) ? inst.signalen_aan : []);
  const d = db(dir), nu = new Date().toISOString();
  const lijst = signalenBereken(d, Object.assign({}, invoer, { instellingen: inst }), invoer.nu ? Date.parse(invoer.nu) : undefined);
  const nieuw = [];
  d.exec('begin');
  try {
    lijst.forEach(function (s) {
      const oud = d.prepare('select gemeld from signaal where sleutel = ?').get(s.sleutel);
      if (!oud) d.prepare('insert into signaal (sleutel, soort, eerst, laatst) values (?, ?, ?, ?)').run(s.sleutel, s.soort, nu, nu);
      else d.prepare('update signaal set laatst = ? where sleutel = ?').run(nu, s.sleutel);
      if (aan.has(s.soort) && !(oud && oud.gemeld)) nieuw.push(s);
    });
    d.exec('commit');
  } catch (e) { d.exec('rollback'); throw e; }
  d.close();
  const uit = function (s) { return { sleutel: s.sleutel, soort: s.soort, entiteit: s.entiteit, naam: s.naam, datum: s.datum, tekst: s.tekst }; };
  return { ok: true, aan: [...aan], signalen: lijst.filter(function (s) { return aan.has(s.soort); }).map(uit), nieuw: nieuw.map(uit), totaal: lijst.length };
}
function kindGemeld(invoer, dir) {
  const sl = Array.isArray(invoer.sleutels) ? invoer.sleutels.filter(function (x) { return typeof x === 'string' && x.length <= 200; }).slice(0, 500) : [];
  const d = db(dir), nu = new Date().toISOString();
  let n = 0;
  sl.forEach(function (k) { n += Number(d.prepare('update signaal set gemeld = ? where sleutel = ? and gemeld is null').run(nu, k).changes) || 0; });
  d.close();
  return { ok: true, gemeld: n };
}
// persoon: op Davids vraag voor één genoemde persoon de velden voor een contract (functie, uren, parttime, schaal, trede, ingangsdatum).
function kindPersoon(invoer, dir) {
  const vraag = norm(invoer.naam);
  if (vraag.length < 3) throw new NmbrsFout('invoer', 'naam te kort');
  if (!fs.existsSync(path.join(dir, 'nmbrs.' + 'sqlite'))) return { ok: true, treffers: [] };
  const d = db(dir), { bedrijven, mw } = laad(d), nu = Date.now();
  const tr = Object.values(mw).filter(function (m) { const n = norm(naamVan(m.info)); return n === vraag || n.indexOf(vraag) >= 0; });
  d.close();
  if (tr.length > 1) return { ok: true, meerdere: tr.slice(0, 10).map(function (m) { return { naam: naamVan(m.info), bedrijf: (bedrijven[m.bedrijf] || {}).naam || null, in_dienst: inDienst(m, nu) }; }) };
  return { ok: true, treffers: tr.map(function (m) {
    const sal = geldig(m.h.salaris || [], nu) || {}, con = geldig(m.h.contract || [], nu) || {}, rst = geldig(m.h.rooster || [], nu) || {}, fn = geldig(m.h.functie || [], nu) || (m.h.functie || []).slice(-1)[0] || {}, dv = geldig(m.h.dienstverband || [], nu) || {};
    return { naam: naamVan(m.info), bedrijf: (bedrijven[m.bedrijf] || {}).naam || null, entiteit: (bedrijven[m.bedrijf] || {}).entiteit || null, in_dienst: inDienst(m, nu),
      functie: fn.description || null, in_dienst_sinds: dv.startDate ? dv.startDate.slice(0, 10) : null, contract: { begin: con.startDate ? con.startDate.slice(0, 10) : null, eind: con.endDate ? con.endDate.slice(0, 10) : null, onbepaald: con.indefinite === true, uren_per_week: con.hoursPerWeek != null ? con.hoursPerWeek : null },
      parttime_pct: rst.parttimePercentage != null ? rst.parttimePercentage : null, salaristabel: sal.tabel ? sal.tabel.tableName || null : null,
      schaal: sal.schaal ? sal.schaal.scaleCode || null : null, trede: sal.trede ? sal.trede.stepCode || null : null, ingangsdatum_salaris: sal.startDate ? sal.startDate.slice(0, 10) : null };
  }) };
}
function kindStand(dir) {
  if (!fs.existsSync(path.join(dir, 'nmbrs.' + 'sqlite'))) return { ok: true, bedrijven: [], nood: !!noodLees(dir), dood: !!doodLees(dir), instellingen: instellingenLees(dir) };
  const d = db(dir);
  const b = lid(d, 'select b.id, b.data, b.periode_soort, (select count(*) from medewerker m where m.bedrijf = b.id) as medewerkers, (select count(*) from loonrun r where r.bedrijf = b.id) as loonruns, ' +
    "(select count(*) from loonrun r where r.bedrijf = b.id and r.journaal like 'ok%') as journalen, e.entiteit from bedrijf b left join bedrijf_entiteit e on e.bedrijf = b.id order by b.id")
    .map(function (x) { const j = JSON.parse(x.data); return { id: x.id, nummer: j.number, naam: j.name, periode: x.periode_soort, medewerkers: x.medewerkers, loonruns: x.loonruns, journalen: x.journalen, entiteit: x.entiteit || null }; });
  const h = lid(d, 'select soort, count(*) as n from historie group by soort');
  const r = d.prepare('select uitkomst from ronde order by volg desc limit 1').get();
  d.close();
  let laatste = null; try { laatste = r ? JSON.parse(r.uitkomst) : null; } catch (e) {}
  return { ok: true, bedrijven: b, historie: h, laatste_ronde: laatste ? { vragen: laatste.vragen, eindpunten: laatste.eindpunten } : null, nood: !!noodLees(dir), dood: !!doodLees(dir), instellingen: instellingenLees(dir) };
}
const ENTITEITEN = /^(TG|GH|HOLD|PH|POT|KM|SLOEL|[A-Z]{2,6})$/;
function kindKoppel(invoer, dir) {
  const bedrijf = idVan(invoer.bedrijf), ent = String(invoer.entiteit || '');
  if (!bedrijf || !ENTITEITEN.test(ent)) throw new NmbrsFout('invoer', 'bedrijf (id) en entiteit (TG, GH, HOLD, PH, POT, …) nodig');
  const d = db(dir);
  if (!d.prepare('select 1 from bedrijf where id = ?').get(bedrijf)) { d.close(); throw new NmbrsFout('invoer', 'onbekend bedrijf'); }
  d.prepare('insert into bedrijf_entiteit (bedrijf, entiteit, door, sinds) values (?, ?, ?, ?) on conflict (bedrijf) do update set entiteit = excluded.entiteit, door = excluded.door, sinds = excluded.sinds')
    .run(bedrijf, ent, String(invoer.door || 'machinekamer').slice(0, 40), new Date().toISOString());
  d.close();
  return { ok: true, bedrijf: bedrijf, entiteit: ent };
}
const SIGNALEN = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
function kindInstel(invoer, dir) {
  const aan = Array.isArray(invoer.signalen_aan) ? invoer.signalen_aan.filter(function (s) { return SIGNALEN.indexOf(s) >= 0; }) : null;
  if (!aan) throw new NmbrsFout('invoer', 'signalen_aan: lijst uit S1–S6');
  mapKlaar(dir);
  const inst = Object.assign(instellingenLees(dir), { signalen_aan: aan, bijgewerkt: new Date().toISOString() });
  const p = path.join(dir, 'instellingen.json'), tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(inst), { mode: 0o600 }); fs.renameSync(tmp, p);
  return { ok: true, instellingen: inst };
}
async function kind(opdracht, invoer, dir) {
  if (opdracht === 'stand') return kindStand(dir);
  if (opdracht === 'signalen') return kindSignalen(invoer, dir);
  if (opdracht === 'gemeld') return kindGemeld(invoer, dir);
  if (opdracht === 'persoon') return kindPersoon(invoer, dir);
  if (opdracht === 'koppel') return kindKoppel(invoer, dir);
  if (opdracht === 'instel') return kindInstel(invoer, dir);
  if (opdracht === 'ronde') return kindLees(invoer, dir, false);
  if (opdracht === 'peil') return kindLees(invoer, dir, true);
  if (opdracht !== 'wissel' && opdracht !== 'ververs' && opdracht !== 'intrek') throw new NmbrsFout('opdracht', 'opdracht: wissel, ververs, intrek, ronde, peil, stand, signalen, gemeld, persoon, koppel, instel');
  const id = String(invoer.client_id || ''), geheim = String(invoer.client_secret || '');
  if (!id || !geheim) throw new NmbrsFout('sleutel', 'client-id of -secret ontbreekt');
  if (opdracht === 'intrek') {
    if (!TOKEN_VORM.test(String(invoer.refresh || ''))) throw new NmbrsFout('invoer', 'refresh token ontbreekt');
    return { ok: await intrek(id, geheim, invoer.refresh, 'refresh_token') };
  }
  let form;
  if (opdracht === 'wissel') {
    if (typeof invoer.code !== 'string' || !/^[\x21-\x7e]{1,2000}$/.test(invoer.code) || !/^[A-Za-z0-9_-]{43,128}$/.test(String(invoer.verifier || ''))) throw new NmbrsFout('invoer', 'code of verifier ongeldig');
    form = { grant_type: 'authorization_code', code: invoer.code, redirect_uri: REDIRECT, code_verifier: invoer.verifier };
  } else {
    if (!TOKEN_VORM.test(String(invoer.refresh || ''))) throw new NmbrsFout('invoer', 'refresh token ontbreekt');
    form = { grant_type: 'refresh_token', refresh_token: invoer.refresh };
  }
  const t = await tokenVraag(form, id, geheim);
  const refresh = t.refresh || (opdracht === 'ververs' ? invoer.refresh : null);
  if (refresh) noodSchrijf(dir, refresh);   // vóór stdout
  return { ok: true, _access: t.access, _refresh: refresh, verloopt_s: t.verloopt_s, nieuw_refresh: !!t.refresh };
}

if (require.main === module) {
  const dir = process.env.NMBRS_DIR || '/opt/data/nmbrs';
  let invoer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (c) { if (invoer.length < 2e6) invoer += c; });
  process.stdin.on('end', function () {
    let j = {};
    try { j = invoer.trim() ? JSON.parse(invoer) : {}; } catch (e) { j = {}; }
    kind(String(process.argv[2] || ''), j, dir).then(function (u) { process.stdout.write(JSON.stringify(u) + '\n'); },
      function (e) { process.stdout.write(JSON.stringify({ ok: false, reden: e.reden || 'fout', fout: String(e && e.message || e).slice(0, 200) }) + '\n'); process.exitCode = 1; });
  });
}

module.exports = { SCOPES, REDIRECT, linkMaak, stateOpen, stateNeem, ronde, terug, slotNeem, slotLos, noodLees, noodSchrijf, noodWis, doodLees, doodZet, verzoekToets, kies, scopesExact,
  sha, xmlBoom, journaalRegels, signalenBereken, periodeStart, NmbrsFout };
