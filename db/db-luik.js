#!/usr/bin/env node
/*
 * db-luik.js (wv3180) — sleutelluik voor de eigen databank in de pod (ontwerp § 2).
 *
 * Vertaalt de Supabase-vorm naar PostgREST, zodat aanroepers (pod, n8n, scripts) alleen hun ADRES wijzigen:
 *   /rest/v1/<pad>  →  PostgREST (127.0.0.1:3001) /<pad>, met een kort HS256-JWT (60 s, rol uit de sleutellijst).
 *   Sleutel uit `apikey` (of `Authorization: Bearer` als er geen apikey is) → sha256 → vergelijken (constante tijd) met
 *   /opt/data/.pg/luik-sleutels.json ({"sleutels":[{"naam","rol","sha256"}]}, alleen hashes). Geen treffer = 401, niets door.
 *   Accept-Profile/Content-Profile, Prefer, Range gaan ongewijzigd door; apikey en de binnenkomende Authorization nooit.
 * Grenzen: body ≤ 10 MB (413), 60 s (504), PATCH/DELETE op een tabel zonder filter = 400 (zoals safeupdate bij Supabase),
 *   rij-limiet 1000 in PostgREST (db-max-rows). Logregel per verzoek: tijd, methode, pad zonder query, sleutelnaam, rol, status, ms.
 *   Nooit een sleutel, query of body in het log.
 * /health (zonder sleutel): postgres-socket, PostgREST live/ready, sleutellijst geladen. Geen SQL-route over HTTP.
 * Alleen standaardbibliotheek.
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const env = process.env;
const POORT = parseInt(env.DB_LUIK_POORT || '8091', 10);
const HOST = env.DB_LUIK_HOST || '0.0.0.0';
// PostgREST luistert alleen op een unix-socket in een map van claude (Codex MOET 1); POSTGREST_POORT alleen voor de toets (nep op TCP)
const DOEL_SOCKET = env.POSTGREST_SOCKET || '/run/pgrst/pgrst.sock';
const DOEL_POORT = env.POSTGREST_POORT ? parseInt(env.POSTGREST_POORT, 10) : null;
const DOEL_HOST = '127.0.0.1';
function doelOpties(o) { return Object.assign(DOEL_POORT ? { host: DOEL_HOST, port: DOEL_POORT } : { socketPath: DOEL_SOCKET }, o); }
const SLEUTELS = env.DB_LUIK_SLEUTELS || '/opt/data/.pg/luik-sleutels.json';
const JWT_PAD = env.DB_LUIK_JWT || '/opt/data/.pg/jwt.key';
const LOG = env.DB_LUIK_LOG || '/opt/data/bin/db-luik.log';
const SOCKET = env.DB_LUIK_PG_SOCKET || '/run/pg/.s.PGSQL.5432';
const MAX_BODY = parseInt(env.DB_LUIK_MAX_BODY || String(10 * 1024 * 1024), 10);
const TIJDSLIMIET_MS = parseInt(env.DB_LUIK_TIMEOUT_MS || '60000', 10);
const ROLLEN = new Set(['anon', 'service_role']);
const PREFIX = '/rest/v1';
// kopregels die PostgREST mag zien (de rest valt weg; zeker apikey, authorization, cookie, host)
const DOOR_IN = ['accept', 'accept-profile', 'content-profile', 'content-type', 'prefer', 'range', 'range-unit', 'accept-encoding', 'content-length'];
const DOOR_UIT = ['content-type', 'content-range', 'content-location', 'location', 'preference-applied', 'content-encoding', 'content-length', 'proxy-status'];
// query-parameters die geen filter zijn (voor de PATCH/DELETE-grens)
const GEEN_FILTER = new Set(['select', 'columns', 'order', 'limit', 'offset', 'on_conflict']);

let lijst = { mtime: -1, sleutels: [], fout: 'nog niet geladen' };
function laadSleutels() {
  let st;
  try { st = fs.statSync(SLEUTELS); } catch (e) { lijst = { mtime: -1, sleutels: [], fout: 'sleutellijst ontbreekt' }; return; }
  if (st.mtimeMs === lijst.mtime) return;
  try {
    const j = JSON.parse(fs.readFileSync(SLEUTELS, 'utf8'));
    const s = (j && Array.isArray(j.sleutels) ? j.sleutels : []).filter(function (x) {
      return x && typeof x.naam === 'string' && ROLLEN.has(x.rol) && /^[0-9a-f]{64}$/.test(String(x.sha256 || ''));
    }).map(function (x) { return { naam: x.naam, rol: x.rol, hash: Buffer.from(x.sha256, 'hex') }; });
    lijst = { mtime: st.mtimeMs, sleutels: s, fout: s.length ? null : 'sleutellijst leeg' };
  } catch (e) { lijst = { mtime: st.mtimeMs, sleutels: [], fout: 'sleutellijst onleesbaar' }; }
}
let geheim = null;
function jwtGeheim() {
  if (geheim) return geheim;
  const g = fs.readFileSync(JWT_PAD, 'utf8');
  if (g.length < 32) throw new Error('jwt-geheim te kort');
  geheim = g;
  return geheim;
}
function b64u(b) { return Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
const jwtCache = new Map();   // rol → { t, tot }
function jwtVoor(rol) {
  const nu = Math.floor(Date.now() / 1000);
  const c = jwtCache.get(rol);
  if (c && c.tot - nu > 30) return c.t;
  const kop = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const lijf = b64u(JSON.stringify({ role: rol, aud: 'db-luik', iss: 'db-luik', iat: nu, exp: nu + 60 }));
  const sig = b64u(crypto.createHmac('sha256', jwtGeheim()).update(kop + '.' + lijf).digest());
  const t = kop + '.' + lijf + '.' + sig;
  jwtCache.set(rol, { t: t, tot: nu + 60 });
  return t;
}
function zoekSleutel(waarde) {
  if (!waarde) return null;
  const h = crypto.createHash('sha256').update(String(waarde), 'utf8').digest();
  let treffer = null;
  for (const s of lijst.sleutels) {   // geen vroege stop: elke vergelijking kost even veel
    if (crypto.timingSafeEqual(h, s.hash) && !treffer) treffer = s;
  }
  return treffer;
}
function sleutelUit(req) {
  const a = req.headers.apikey;
  if (typeof a === 'string' && a) return a.trim();
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1] : '';
}

let logStroom = null;
function logRegel(o) {
  try {
    if (!logStroom) logStroom = fs.createWriteStream(LOG, { flags: 'a', mode: 0o600 });
    logStroom.write(JSON.stringify(o) + '\n');
  } catch (e) { /* log mag nooit een verzoek breken */ }
}
function antwoord(res, status, obj) {
  if (res.headersSent) { try { res.end(); } catch (e) {} return; }
  const t = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(t) });
  res.end(t);
}
// gereedheid: GET / als anon (OpenAPI-overzicht); 200 = verbonden met Postgres en schemacache geladen
function doelGet(pad) {
  return new Promise(function (resolve) {
    const r = http.get(doelOpties({ path: pad, timeout: 3000, headers: { accept: 'application/openapi+json' } }), function (x) { x.resume(); resolve(x.statusCode); });
    r.on('error', function () { resolve(0); });
    r.on('timeout', function () { r.destroy(); resolve(0); });
  });
}
const start = Date.now();
async function gezondheid(res) {
  laadSleutels();
  let socket = false;
  try { socket = fs.statSync(SOCKET).isSocket(); } catch (e) { socket = false; }
  const st = await doelGet('/');
  const ok = socket && st === 200 && !lijst.fout;
  antwoord(res, ok ? 200 : 503, { ok: ok, postgres_socket: socket, postgrest_live: st > 0, postgrest_ready: st === 200,
    sleutels: lijst.sleutels.length, sleutel_fout: lijst.fout, sinds_s: Math.round((Date.now() - start) / 1000) });
}

// Codex MOET 2: alleen een filter op de HOOFDtabel telt. Ingebedde parameters (child.order, child.id=eq.1) beperken de te wijzigen
// rijen niet. Kolomfilter = sleutel zonder punt met een operatorwaarde (eq., in., is., …); logisch = or/and/not.or/not.and met (…).
function heeftFilter(zoek) {
  for (const [k, v] of new URLSearchParams(zoek)) {
    if (GEEN_FILTER.has(k)) continue;
    if (/^(not\.)?(or|and)$/.test(k)) { if (/^\(.+\)$/.test(v)) return true; continue; }
    if (k.indexOf('.') >= 0) continue;
    if (/^(not\.)?[a-z]+(\([a-z0-9_,]+\))?\..+/i.test(v)) return true;
  }
  return false;
}

const server = http.createServer(function (req, res) {
  const t0 = Date.now();
  const url = String(req.url || '/');
  const q = url.indexOf('?');
  const pad = q >= 0 ? url.slice(0, q) : url;
  const zoek = q >= 0 ? url.slice(q + 1) : '';
  const regel = { t: new Date().toISOString(), m: req.method, pad: pad.slice(0, 200), naam: null, rol: null, st: 0, ms: 0 };
  res.on('finish', function () { regel.st = res.statusCode; regel.ms = Date.now() - t0; logRegel(regel); });

  if (pad === '/health' && req.method === 'GET') { gezondheid(res).catch(function () { antwoord(res, 500, { ok: false }); }); return; }
  if (pad !== PREFIX && pad.indexOf(PREFIX + '/') !== 0) { req.resume(); antwoord(res, 404, { message: 'onbekend pad' }); return; }
  laadSleutels();
  const s = zoekSleutel(sleutelUit(req));
  if (!s) { req.resume(); antwoord(res, 401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' }); return; }
  regel.naam = s.naam; regel.rol = s.rol;
  const doelPad = pad.slice(PREFIX.length) || '/';
  if ((req.method === 'PATCH' || req.method === 'DELETE') && doelPad.indexOf('/rpc/') !== 0 && !heeftFilter(zoek)) {
    req.resume();
    antwoord(res, 400, { code: '21000', details: null, hint: null, message: req.method === 'PATCH' ? 'UPDATE requires a WHERE clause' : 'DELETE requires a WHERE clause' });
    return;
  }
  const lengte = parseInt(req.headers['content-length'] || '0', 10);
  if (lengte > MAX_BODY) { req.resume(); res.setHeader('connection', 'close'); antwoord(res, 413, { message: 'body te groot' }); return; }

  const kop = {};
  DOOR_IN.forEach(function (k) { if (req.headers[k] !== undefined) kop[k] = req.headers[k]; });
  let token;
  try { token = jwtVoor(s.rol); } catch (e) { req.resume(); antwoord(res, 503, { message: 'luik niet ingericht' }); return; }
  kop.authorization = 'Bearer ' + token;
  kop.host = 'postgrest';
  const naar = http.request(doelOpties({ method: req.method, path: doelPad + (zoek ? '?' + zoek : ''), headers: kop }));
  const klok = setTimeout(function () {
    naar.destroy(new Error('tijd'));
    antwoord(res, 504, { message: 'databank antwoordt niet binnen ' + Math.round(TIJDSLIMIET_MS / 1000) + ' s' });
  }, TIJDSLIMIET_MS);
  naar.on('response', function (x) {
    const uit = {};
    DOOR_UIT.forEach(function (k) { if (x.headers[k] !== undefined) uit[k] = x.headers[k]; });
    res.writeHead(x.statusCode, uit);
    x.pipe(res);
    x.on('end', function () { clearTimeout(klok); });
    x.on('error', function () { clearTimeout(klok); try { res.destroy(); } catch (e) {} });
  });
  naar.on('error', function () { clearTimeout(klok); if (!teGroot) antwoord(res, 502, { message: 'PostgREST onbereikbaar' }); });
  let gelezen = 0, teGroot = false;
  req.on('data', function (d) {
    if (teGroot) return;   // rest weggooien; de verbinding sluit na het antwoord
    gelezen += d.length;
    if (gelezen > MAX_BODY) {
      teGroot = true; clearTimeout(klok); naar.destroy(new Error('te groot'));
      res.setHeader('connection', 'close'); antwoord(res, 413, { message: 'body te groot' }); return;
    }
    naar.write(d);
  });
  req.on('end', function () { if (!teGroot) naar.end(); });
  req.on('error', function () { clearTimeout(klok); naar.destroy(); });
});
server.requestTimeout = TIJDSLIMIET_MS + 5000;
server.headersTimeout = 20000;
server.keepAliveTimeout = 5000;
server.listen(POORT, HOST, function () { logRegel({ t: new Date().toISOString(), start: true, poort: POORT }); });
function stop() { server.close(function () { process.exit(0); }); setTimeout(function () { process.exit(0); }, 3000).unref(); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
