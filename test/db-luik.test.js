// test/db-luik.test.js (wv3180) — toetst db/db-luik.js tegen een nep-PostgREST (altijd) en, met DB_LUIK_ECHT=1, tegen een echte
// PostgREST + Postgres (DB_LUIK_ECHT_PGRST_SOCKET = unix-socket van PostgREST, DB_LUIK_ECHT_SOCKET = Postgres-socket, DB_LUIK_ECHT_JWT, DB_LUIK_ECHT_SLEUTELS,
// DB_LUIK_ECHT_SERVICE / _ANON = sleutelwaarden uit de omgeving, nooit in de uitvoer).
// Het te toetsen bestand: DB_LUIK_JS (standaard db/db-luik.js) — zo kan een kruisproef een kapotte kopie aanwijzen.
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const LUIK = process.env.DB_LUIK_JS || path.join(__dirname, '..', 'db', 'db-luik.js');
let rood = 0, groen = 0;
function ok(c, naam) { if (c) { groen++; console.log('  ok   ' + naam); } else { rood++; console.log('  ROOD ' + naam); } }
function slaap(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function vraag(poort, methode, pad, kop, lijf) {
  return new Promise(function (resolve) {
    const r = http.request({ host: '127.0.0.1', port: poort, method: methode, path: pad, headers: kop || {} }, function (x) {
      let s = ''; x.on('data', function (d) { s += d; }); x.on('end', function () { resolve({ st: x.statusCode, kop: x.headers, lijf: s }); });
    });
    r.on('error', function (e) { resolve({ st: 0, fout: e.message }); });
    if (lijf) r.write(lijf);
    r.end();
  });
}
function vrijePoort() {
  return new Promise(function (resolve) { const s = http.createServer(); s.listen(0, '127.0.0.1', function () { const p = s.address().port; s.close(function () { resolve(p); }); }); });
}
function jwtDecode(t, geheim) {
  const d = String(t || '').split('.');
  if (d.length !== 3) return null;
  const sig = crypto.createHmac('sha256', geheim).update(d[0] + '.' + d[1]).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return { geldig: sig === d[2], kop: JSON.parse(Buffer.from(d[0], 'base64').toString()), lijf: JSON.parse(Buffer.from(d[1], 'base64').toString()) };
}
async function startLuik(env) {
  const k = spawn(process.execPath, [LUIK], { env: Object.assign({ PATH: process.env.PATH }, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let uit = ''; k.stdout.on('data', function (d) { uit += d; }); k.stderr.on('data', function (d) { uit += d; });
  for (let i = 0; i < 50; i++) { const r = await vraag(+env.DB_LUIK_POORT, 'GET', '/rest/v1/x', {}); if (r.st) break; await slaap(100); }
  k.uitvoer = function () { return uit; };
  return k;
}

async function nep() {
  console.log('deel A: nep-PostgREST');
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'dbluik-'));
  const geheim = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(map, 'jwt.key'), geheim, { mode: 0o600 });
  const SVC = 'sb_secret_toets_' + crypto.randomBytes(12).toString('hex');
  const ANON = 'sb_publishable_toets_' + crypto.randomBytes(12).toString('hex');
  const h = function (w) { return crypto.createHash('sha256').update(w).digest('hex'); };
  fs.writeFileSync(path.join(map, 'sleutels.json'), JSON.stringify({ sleutels: [
    { naam: 'toets-service', rol: 'service_role', sha256: h(SVC) }, { naam: 'toets-anon', rol: 'anon', sha256: h(ANON) },
    { naam: 'fout-rol', rol: 'postgres', sha256: h('rolsleutel') }] }), { mode: 0o600 });
  const gezien = [];
  const pNep = await vrijePoort(), pAdmin = await vrijePoort(), pLuik = await vrijePoort();
  const nepSrv = http.createServer(function (req, res) {
    let lijf = ''; req.on('data', function (d) { lijf += d; });
    req.on('end', function () {
      gezien.push({ m: req.method, url: req.url, kop: req.headers, lijf: lijf.length });
      res.writeHead(200, { 'content-type': 'application/json', 'content-range': '0-0/1', 'x-geheim-intern': 'nee', 'set-cookie': 'a=b' });
      res.end('[{"ok":1}]');
    });
  }).listen(pNep, '127.0.0.1');
  const admin = http.createServer(function (req, res) { res.writeHead(req.url === '/live' || req.url === '/ready' ? 200 : 404); res.end(); }).listen(pAdmin, '127.0.0.1');
  const sock = path.join(map, 'nep.sock');
  const sockSrv = require('net').createServer().listen(sock);
  const log = path.join(map, 'luik.log');
  const luik = await startLuik({ DB_LUIK_POORT: String(pLuik), DB_LUIK_HOST: '127.0.0.1', POSTGREST_POORT: String(pNep),
    DB_LUIK_SLEUTELS: path.join(map, 'sleutels.json'), DB_LUIK_JWT: path.join(map, 'jwt.key'), DB_LUIK_LOG: log, DB_LUIK_PG_SOCKET: sock, DB_LUIK_MAX_BODY: '2000' });
  try {
    let n0 = gezien.length;
    let r = await vraag(pLuik, 'GET', '/rest/v1/tabel?select=a', {});
    ok(r.st === 401 && gezien.length === n0, 'zonder sleutel: 401 en niets naar PostgREST');
    r = await vraag(pLuik, 'GET', '/rest/v1/tabel', { apikey: 'sb_secret_onbekend' });
    ok(r.st === 401 && gezien.length === n0, 'onbekende sleutel: 401');
    r = await vraag(pLuik, 'GET', '/rest/v1/tabel', { apikey: 'rolsleutel' });
    ok(r.st === 401 && gezien.length === n0, 'sleutel met ongeldige rol in de lijst telt niet');
    r = await vraag(pLuik, 'GET', '/rest/v1/tabel?select=a,b&id=eq.3', { apikey: SVC, authorization: 'Bearer ' + SVC, 'accept-profile': 'secondbrain', prefer: 'count=exact', range: '0-9', cookie: 'x=y' });
    let g = gezien[gezien.length - 1];
    ok(r.st === 200 && g && g.url === '/tabel?select=a,b&id=eq.3', 'prefix /rest/v1 eraf, query ongewijzigd');
    let j = g && jwtDecode(String(g.kop.authorization || '').replace(/^Bearer /, ''), geheim);
    ok(j && j.geldig && j.kop.alg === 'HS256' && j.lijf.role === 'service_role' && j.lijf.aud === 'db-luik' && j.lijf.exp - j.lijf.iat === 60, 'service-sleutel → HS256-JWT rol service_role, 60 s, aud db-luik');
    ok(g && g.kop['accept-profile'] === 'secondbrain' && g.kop.prefer === 'count=exact' && g.kop.range === '0-9', 'Accept-Profile, Prefer, Range gaan door');
    ok(g && g.kop.apikey === undefined && g.kop.cookie === undefined && String(g.kop.authorization).indexOf(SVC) < 0, 'apikey, cookie en de binnenkomende Authorization gaan niet door');
    ok(r.kop['content-range'] === '0-0/1' && r.kop['x-geheim-intern'] === undefined && r.kop['set-cookie'] === undefined, 'Content-Range terug, andere kopregels niet');
    r = await vraag(pLuik, 'POST', '/rest/v1/rpc/f', { authorization: 'Bearer ' + ANON, 'content-type': 'application/json', 'content-profile': 'machinekamer' }, '{"a":1}');
    g = gezien[gezien.length - 1]; j = g && jwtDecode(String(g.kop.authorization || '').replace(/^Bearer /, ''), geheim);
    ok(r.st === 200 && j && j.lijf.role === 'anon' && g.kop['content-profile'] === 'machinekamer' && g.lijf === 7, 'Bearer-sleutel (anon) → rol anon; Content-Profile en body door');
    r = await vraag(pLuik, 'GET', '/rest/v1/t', { apikey: ANON, authorization: 'Bearer ' + SVC });
    g = gezien[gezien.length - 1]; j = g && jwtDecode(String(g.kop.authorization || '').replace(/^Bearer /, ''), geheim);
    ok(j && j.lijf.role === 'anon', 'apikey gaat vóór Authorization (zoals Supabase)');
    n0 = gezien.length;
    r = await vraag(pLuik, 'GET', '/rest/v10/t', { apikey: SVC });
    let r2 = await vraag(pLuik, 'GET', '/t', { apikey: SVC });
    let r3 = await vraag(pLuik, 'GET', '/sql', { apikey: SVC });
    ok(r.st === 404 && r2.st === 404 && r3.st === 404 && gezien.length === n0, 'alleen /rest/v1: andere paden 404, geen SQL-route');
    r = await vraag(pLuik, 'PATCH', '/rest/v1/t', { apikey: SVC, 'content-type': 'application/json' }, '{"a":1}');
    r2 = await vraag(pLuik, 'DELETE', '/rest/v1/t?select=a', { apikey: SVC });
    ok(r.st === 400 && JSON.parse(r.lijf).code === '21000' && r2.st === 400 && gezien.length === n0, 'PATCH/DELETE zonder filter: 400 (safeupdate)');
    // Codex MOET 2: ingebedde parameters of een kale waarde zijn geen filter op de hoofdtabel
    const n1 = gezien.length;
    r = await vraag(pLuik, 'PATCH', '/rest/v1/t?select=*,kind(*)&kind.order=id', { apikey: SVC, 'content-type': 'application/json' }, '{"a":1}');
    r2 = await vraag(pLuik, 'DELETE', '/rest/v1/t?kind.id=eq.1', { apikey: SVC });
    r3 = await vraag(pLuik, 'DELETE', '/rest/v1/t?kind.or=(a.eq.1)&naam=x', { apikey: SVC });
    ok(r.st === 400 && r2.st === 400 && r3.st === 400 && gezien.length === n1, 'ingebed filter (kind.id, kind.order, kind.or) of waarde zonder operator telt niet: 400');
    r = await vraag(pLuik, 'DELETE', '/rest/v1/t?or=(a.eq.1,b.eq.2)', { apikey: SVC });
    r2 = await vraag(pLuik, 'PATCH', '/rest/v1/t?id=not.is.null', { apikey: SVC, 'content-type': 'application/json' }, '{"a":1}');
    ok(r.st === 200 && r2.st === 200, 'or=(…) en not.is.null op de hoofdtabel tellen als filter');
    r = await vraag(pLuik, 'PATCH', '/rest/v1/t?id=eq.1', { apikey: SVC, 'content-type': 'application/json' }, '{"a":1}');
    r2 = await vraag(pLuik, 'DELETE', '/rest/v1/rpc/x', { apikey: SVC });
    ok(r.st === 200 && r2.st === 200, 'PATCH met filter en rpc gaan door');
    n0 = gezien.length;
    const groot = JSON.stringify({ x: 'a'.repeat(3000) });
    r = await vraag(pLuik, 'POST', '/rest/v1/t', { apikey: SVC, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(groot)) }, groot);
    r2 = await vraag(pLuik, 'POST', '/rest/v1/t', { apikey: SVC, 'content-type': 'application/json' }, groot);   // chunked, zonder content-length
    ok(r.st === 413 && r2.st === 413 && gezien.length === n0, 'body boven de grens: 413, ook zonder content-length [' + r.st + '/' + r2.st + ']');
    r = await vraag(pLuik, 'GET', '/health', {});
    ok(r.st === 200 && JSON.parse(r.lijf).ok === true && JSON.parse(r.lijf).sleutels === 2, '/health zonder sleutel: ok, 2 geldige sleutels');
    await slaap(200);
    const l = fs.readFileSync(log, 'utf8');
    ok(l.indexOf(SVC) < 0 && l.indexOf(ANON) < 0 && l.indexOf('eq.3') < 0 && l.indexOf('select=') < 0 && l.indexOf('"a":1') < 0, 'logregel zonder sleutel, query of body');
    ok(/"naam":"toets-service","rol":"service_role","st":200/.test(l), 'logregel met sleutelnaam, rol en status');
    fs.writeFileSync(path.join(map, 'sleutels.json'), JSON.stringify({ sleutels: [{ naam: 'nieuw', rol: 'service_role', sha256: h('sb_secret_nieuw') }] }));
    const t = new Date(Date.now() + 5000); fs.utimesSync(path.join(map, 'sleutels.json'), t, t);
    r = await vraag(pLuik, 'GET', '/rest/v1/t', { apikey: SVC });
    r2 = await vraag(pLuik, 'GET', '/rest/v1/t', { apikey: 'sb_secret_nieuw' });
    ok(r.st === 401 && r2.st === 200, 'gewijzigde sleutellijst geldt zonder herstart');
  } finally {
    luik.kill('SIGTERM'); nepSrv.close(); admin.close(); sockSrv.close();
    fs.rmSync(map, { recursive: true, force: true });
  }
}

async function echt() {
  console.log('deel B: echte PostgREST + Postgres');
  const pLuik = await vrijePoort();
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'dbluik-echt-'));
  const luik = await startLuik({ DB_LUIK_POORT: String(pLuik), DB_LUIK_HOST: '127.0.0.1', POSTGREST_SOCKET: process.env.DB_LUIK_ECHT_PGRST_SOCKET, DB_LUIK_SLEUTELS: process.env.DB_LUIK_ECHT_SLEUTELS, DB_LUIK_JWT: process.env.DB_LUIK_ECHT_JWT,
    DB_LUIK_LOG: path.join(map, 'luik.log'), DB_LUIK_PG_SOCKET: process.env.DB_LUIK_ECHT_SOCKET });
  const SVC = process.env.DB_LUIK_ECHT_SERVICE, ANON = process.env.DB_LUIK_ECHT_ANON;
  try {
    let r = await vraag(pLuik, 'GET', '/health', {});
    ok(r.st === 200, '/health: postgres en PostgREST op');
    r = await vraag(pLuik, 'POST', '/rest/v1/rpc/luik_toets_reeks', { apikey: SVC, 'content-type': 'application/json' }, '{}');
    let n = -1; try { n = JSON.parse(r.lijf).length; } catch (e) {}
    ok(r.st === 200 && n === 1000, 'rpc met 1500 rijen geeft er 1000 (db-max-rows)');
    r = await vraag(pLuik, 'POST', '/rest/v1/rpc/luik_toets_rol', { apikey: SVC, 'content-type': 'application/json' }, '{}');
    ok(r.st === 200 && JSON.parse(r.lijf) === 'service_role', 'service-sleutel: current_user = service_role');
    r = await vraag(pLuik, 'POST', '/rest/v1/rpc/luik_toets_rol', { apikey: ANON, 'content-type': 'application/json' }, '{}');
    ok(r.st === 200 && JSON.parse(r.lijf) === 'anon', 'publishable-sleutel: current_user = anon');
    r = await vraag(pLuik, 'POST', '/rest/v1/rpc/luik_toets_rol', { apikey: SVC, 'content-type': 'application/json', 'content-profile': 'vault' }, '{}');
    ok(r.st === 406, 'Content-Profile vault (niet ontsloten): 406');
    r = await vraag(pLuik, 'GET', '/rest/v1/', { apikey: SVC, accept: 'application/openapi+json' });
    let paden = 0; try { paden = Object.keys(JSON.parse(r.lijf).paths).length; } catch (e) {}
    ok(r.st === 200 && paden > 200, 'OpenAPI-overzicht via de luik (' + paden + ' paden)');
  } finally { luik.kill('SIGTERM'); fs.rmSync(map, { recursive: true, force: true }); }
}

(async function () {
  await nep();
  if (process.env.DB_LUIK_ECHT === '1') await echt();
  console.log('db-luik: ' + groen + ' groen, ' + rood + ' rood');
  process.exit(rood ? 1 : 0);
})().catch(function (e) { console.log('ROOD toets brak af: ' + (e && e.stack || e)); process.exit(1); });
