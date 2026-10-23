'use strict';
/*
 * facturen-ingang.js — de smalle ingang van de Facturen-app voor de praktijkmanager: pod-pad /fac/* (wv856, fase F6, 23-10-2026).
 * Bouwplan: vault "01_Ontwikkeling/Facturen-app - bouwplan (App, 22-10-2026).md" § 4.3 en § 7 (F6); ontwerp en Fable-review in
 * /opt/data/mk-scripts/wv856/ontwerp.md.
 *
 * WAAROM. Cynthia doet het facturenwerk mee (beoordelen, bevestigen, bankexports), maar mag niet in de Socev-app van David (gesprek,
 * mail, agenda, alle Apps). Daarom een eigen site (facturen.socev.dev, eigen Access-app met Google-login) met een eigen doorgeef-Function
 * en een eigen servicetoken naar deze ingang, die alleen Facturen kent. Een fout hier blijft binnen Facturen en binnen haar rol.
 *
 * SLOTEN (in deze volgorde; elke weigering zonder inhoud):
 *   1. noodstop van de app (app-uit) of de eigen schakelaar <dir>/ingang/uit → 503;
 *   2. pad ^/fac/[a-z0-9/-]{1,64}$ en GET/POST, anders 404. Geen config → 404 (de ingang is dan niet ingericht: slapend);
 *      config kapot (onleesbaar, velden mis, aud gelijk aan die van de Socev-app of aan elkaar, poortgeheim niet 0600) → 503;
 *   3. poortgeheim X-Fac-Poort (eigen geheim, niet dat van de app) → anders 403;
 *   4. Access-bewijs van de pod-ingang (Cf-Access-Jwt-Assertion, gezet door de Access-app op fac-pod.socev.dev): RS256, iss = team,
 *      aud = aud_pod, common_name = het servicetoken van de facturen-Functions, geen e-mail → anders 403;
 *   5. gebruikers-JWT (X-Fac-Gebruiker = de Cf-Access-Jwt-Assertion van de Access-app op facturen.socev.dev, door de Function
 *      ongewijzigd doorgegeven): RS256, iss = team, aud = aud_gebruiker, e-mail aanwezig, geen common_name → anders 403;
 *   6. rol uit de facturentabel gebruiker (ingang 'fac', actief); onbekend → 403. Via deze ingang nooit eigenaar (geen passkey):
 *      facturen.js geeft hier altijd praktijkmanager, de database weigert een fac-rij met een andere rol, en dit bestand eist het nog eens.
 * Daarna: tellers per gebruiker, en alleen de routes GET /fac/wie, /fac/facturen[/…] (→ facturen.js met pad /app/facturen[/…]; geen
 * verse vingerafdruk, dus Nagebeld, adres en verzendmodus kunnen hier niet) en POST /fac/upload/<beurt>/<n> (ruwe bytes; de bestaande
 * uploadroute van de app met een eigen map per gebruiker; POST /fac/facturen/upload neemt het bestand daarna over).
 *
 * GEHEIMEN EN SPOREN. De gebruikers-JWT is een toegangsbewijs van uren: hij komt nooit in een log, audit of antwoord (CI-poort). De
 * audit (<dir>/ingang/audit.jsonl, 0600) bevat route, status, gebruiker-id en reden; geen e-mail, geen JWT, geen inhoud.
 *
 * PLAFOND (eerlijk, bouwplan § 8). Wie het Cloudflare-account of de Pages-uitroltoken heeft, kan een Function uitrollen die een
 * gebruikers-JWT afvangt. Met alleen de Pages-secrets (servicetoken + poortgeheim) praat niemand als Cynthia of David. De schade blijft
 * in elk geval binnen de praktijkmanager-scope: geen Privé, geen POT-rekening, geen Instellingen, geen eigenaar, geen /app/*.
 *
 * VORM. Geen netwerk- of procesmodule (CI-poort): de certs van het Access-team, de uploadroute, de body-lezer en het antwoord komen van
 * server.js (maak({...})). Zo toetst test/facturen-ingang.sh alles met een echte http-server en eigen RSA-sleutels.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PAD_RE = /^\/fac\/[a-z0-9/-]{1,64}$/;
const UPLOAD_RE = /^\/fac\/upload\/([a-z0-9-]{8,64}\/[1-9][0-9]?)$/;
const JWT_MAX = 8192;
const JWT_DEEL_RE = /^[A-Za-z0-9_-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const KLOK_MARGE_S = 60;
const VERZOEKEN_PER_UUR = 600;      // per gebruiker
const UPLOADS_PER_UUR = 30;         // per gebruiker
const UPLOADS_TEGELIJK = 2;         // lopende stromen per gebruiker (Fable wv856 #4)
const UPLOAD_TOTAAL = 60 * 1024 * 1024;   // alles wat via deze ingang klaarstaat, alle gebruikers samen (diffreview wv856 #2)
const VOOR_AUTH_PER_MIN = 5;        // auditregels voor weigeringen vóór slot 5
const AUDIT_MAX = 5 * 1024 * 1024;
const CONFIG_MS = 10 * 1000;

function gelijk(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function b64Json(s) { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); }

/*
 * JWT-controle (RS256 tegen de certs van het Access-team). verwacht = { team, aud, soort: 'dienst' | 'gebruiker', clientId }.
 * → { ok: true, email? } of { ok: false, reden }. certs(team, kid) → Promise<jwk[]> (server.js: appCerts, met hervragen bij een
 * onbekende kid). Fail-closed: elke twijfel is een weigering.
 */
async function controleerJwt(token, verwacht, certs, nuMs) {
  if (typeof token !== 'string' || !token) return { ok: false, reden: 'geen bewijs' };
  if (token.length > JWT_MAX) return { ok: false, reden: 'te lang' };
  const d = token.split('.');
  if (d.length !== 3 || !d.every((x) => JWT_DEEL_RE.test(x))) return { ok: false, reden: 'vorm' };
  let kop, inh;
  try { kop = b64Json(d[0]); inh = b64Json(d[1]); } catch (e) { return { ok: false, reden: 'vorm' }; }
  if (!kop || typeof kop !== 'object' || !inh || typeof inh !== 'object') return { ok: false, reden: 'vorm' };
  if (kop.alg !== 'RS256' || typeof kop.kid !== 'string' || !kop.kid) return { ok: false, reden: 'alg' };
  let keys;
  try { keys = await certs(verwacht.team, kop.kid); } catch (e) { return { ok: false, reden: 'certs' }; }
  const jwk = (Array.isArray(keys) ? keys : []).find((k) => k && k.kid === kop.kid);
  if (!jwk || jwk.kty !== 'RSA') return { ok: false, reden: 'onbekende sleutel' };
  let geldig = false;
  try {
    const sleutel = crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    geldig = crypto.verify('RSA-SHA256', Buffer.from(d[0] + '.' + d[1]), sleutel, Buffer.from(d[2], 'base64url'));
  } catch (e) { return { ok: false, reden: 'handtekening' }; }
  if (!geldig) return { ok: false, reden: 'handtekening' };
  const nu = Math.floor((Number.isFinite(nuMs) ? nuMs : Date.now()) / 1000);
  if (typeof inh.exp !== 'number' || inh.exp + KLOK_MARGE_S < nu) return { ok: false, reden: 'verlopen' };
  if (inh.nbf !== undefined && (typeof inh.nbf !== 'number' || inh.nbf - KLOK_MARGE_S > nu)) return { ok: false, reden: 'nog niet geldig' };
  if (inh.iss !== verwacht.team) return { ok: false, reden: 'iss' };
  const aud = Array.isArray(inh.aud) ? inh.aud : [inh.aud];
  if (!aud.some((a) => typeof a === 'string' && gelijk(a, verwacht.aud))) return { ok: false, reden: 'aud' };
  if (verwacht.soort === 'dienst') {
    if (typeof inh.email === 'string' && inh.email) return { ok: false, reden: 'gebruiker in plaats van servicetoken' };
    if (typeof inh.common_name !== 'string' || !gelijk(inh.common_name, verwacht.clientId)) return { ok: false, reden: 'servicetoken' };
    return { ok: true };
  }
  if (typeof inh.common_name === 'string' && inh.common_name) return { ok: false, reden: 'servicetoken in plaats van gebruiker' };
  const email = typeof inh.email === 'string' ? inh.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) return { ok: false, reden: 'e-mail' };
  return { ok: true, email };
}

/*
 * maak(o) → { isPad(req), verwerk(req, res), info() }.
 * o = { dir (FACTUREN_DIR), appUit (pad noodstop), appAud() → aud van de Socev-app, certs(team, kid), routes (facturen.js maak()),
 *       open() → fdb | null, primair() → bool, body(req, cb(fout, d)), upload(req, res, pseudo, rest), uploadNeem(pseudo, beurt, n),
 *       stuur(res, status, obj), bankluisPad, fout(label, e), nu(), uploadBytes() → bytes die via deze ingang klaarstaan }
 */
function maak(o) {
  const dir = path.join(o.dir, 'ingang');
  const CONFIG = path.join(dir, 'config.json');
  const POORT = path.join(dir, 'geheim', 'poort.key');
  const UIT = path.join(dir, 'uit');
  const AUDIT = path.join(dir, 'audit.jsonl');
  const nu = typeof o.nu === 'function' ? o.nu : Date.now;
  const tellers = {};        // gebruiker-id → { alles: [t], upload: [t], lopend: n }
  const voorAuth = { minuut: 0, n: 0, overgeslagen: 0 };
  let cfgCache = null;

  function isPad(req) { const p = padVan(req); return p === '/fac' || p.indexOf('/fac/') === 0; }
  function padVan(req) { const u = String(req.url || ''); const i = u.indexOf('?'); return i < 0 ? u : u.slice(0, i); }

  // Config: { staat: 'afwezig' | 'kapot' | 'ingericht', reden?, cfg? }. 10 s in het geheugen, zodat een wijziging snel geldt.
  function config() {
    const t = nu();
    if (cfgCache && t - cfgCache.op < CONFIG_MS) return cfgCache.uit;
    let uit;
    try { uit = leesConfig(); } catch (e) { uit = { staat: 'kapot', reden: 'onleesbaar' }; }
    cfgCache = { op: t, uit };
    return uit;
  }
  function leesConfig() {
    let tekst;
    try { tekst = fs.readFileSync(CONFIG, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return { staat: 'afwezig' }; throw e; }
    let c;
    try { c = JSON.parse(tekst); } catch (e) { return { staat: 'kapot', reden: 'config geen json' }; }
    const team = String(c && c.access_team || '').replace(/\/+$/, '');
    const cfg = { team, audPod: String(c.aud_pod || ''), audGebruiker: String(c.aud_gebruiker || ''), clientId: String(c.servicetoken_client_id || '') };
    if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) return { staat: 'kapot', reden: 'team' };
    if (!HEX64.test(cfg.audPod) || !HEX64.test(cfg.audGebruiker)) return { staat: 'kapot', reden: 'aud' };
    if (cfg.audPod === cfg.audGebruiker) return { staat: 'kapot', reden: 'aud gelijk' };
    const appAud = typeof o.appAud === 'function' ? String(o.appAud() || '') : '';
    if (appAud && (appAud === cfg.audPod || appAud === cfg.audGebruiker)) return { staat: 'kapot', reden: 'aud van de Socev-app' };
    if (!/^[0-9a-f]{32}\.access$/.test(cfg.clientId)) return { staat: 'kapot', reden: 'client-id' };
    let st;
    try { st = fs.statSync(POORT); } catch (e) { return { staat: 'kapot', reden: 'geen poortgeheim' }; }
    if (!st.isFile() || (st.mode & 0o077) !== 0) return { staat: 'kapot', reden: 'poortgeheim niet 0600' };
    const geheim = fs.readFileSync(POORT, 'utf8').trim();
    if (geheim.length < 32) return { staat: 'kapot', reden: 'poortgeheim te kort' };
    cfg.poort = geheim;
    return { staat: 'ingericht', cfg };
  }

  function info() {
    const c = config();
    return { ingericht: c.staat === 'ingericht', staat: c.staat === 'kapot' ? 'kapot: ' + c.reden : c.staat, uit: fs.existsSync(UIT) || fs.existsSync(o.appUit) };
  }

  function audit(r, gebruiker, voor) {
    try {
      if (voor) {
        const m = Math.floor(nu() / 60000);
        if (voorAuth.minuut !== m) { voorAuth.minuut = m; voorAuth.n = 0; }
        if (++voorAuth.n > VOOR_AUTH_PER_MIN) { voorAuth.overgeslagen++; return; }
      }
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        if (fs.statSync(AUDIT).size > AUDIT_MAX) {
          for (let i = 3; i >= 1; i--) { try { fs.renameSync(AUDIT + (i > 1 ? '.' + (i - 1) : ''), AUDIT + '.' + i); } catch (e) {} }
        }
      } catch (e) {}
      const regel = { t: new Date(nu()).toISOString(), route: r.route, m: r.m, status: r.status, gebruiker: gebruiker || null, reden: r.reden ? String(r.reden).slice(0, 80) : null };
      if (voor && voorAuth.overgeslagen) { regel.overgeslagen_voor_auth = voorAuth.overgeslagen; voorAuth.overgeslagen = 0; }
      fs.appendFileSync(AUDIT, JSON.stringify(regel) + '\n', { mode: 0o600 });
    } catch (e) { if (typeof o.fout === 'function') o.fout('facturen-ingang-audit', e); }
  }

  function teller(gid, soort, max) {
    const t = nu();
    const g = tellers[gid] = tellers[gid] || { alles: [], upload: [], lopend: 0 };
    g[soort] = g[soort].filter((x) => t - x < 3600000);
    if (g[soort].length >= max) return false;
    g[soort].push(t);
    return true;
  }

  async function verwerk(req, res) {
    const p = padVan(req);
    // res._app: dezelfde vorm als in handleApp, zodat appStuur/appWeiger en de uploadroute van server.js hier werken.
    res._app = { route: p.slice(0, 64), status: 0, reden: null, apparaat: null, voorAuth: true, fac: true };
    let gebruiker = null;
    res.on('finish', function () { audit({ route: res._app.route, m: req.method, status: res.statusCode, reden: res._app.reden }, gebruiker, res._app.voorAuth); });
    const weiger = function (status, fout, reden) { req.resume(); res._app.reden = reden || fout; return o.stuur(res, status, { ok: false, fout }); };
    try {
      if (fs.existsSync(o.appUit) || fs.existsSync(UIT)) return weiger(503, 'Facturen staat even uit', 'uit');
      if (!PAD_RE.test(p) || (req.method !== 'GET' && req.method !== 'POST')) return weiger(404, 'onbekend', 'pad/methode');
      const c = config();
      if (c.staat === 'afwezig') return weiger(404, 'onbekend', 'niet ingericht');
      if (c.staat !== 'ingericht') return weiger(503, 'niet goed ingericht; vraag het David', 'config ' + c.reden);
      const cfg = c.cfg;
      if (!gelijk(String(req.headers['x-fac-poort'] || ''), cfg.poort)) return weiger(403, 'niet toegestaan', 'poortgeheim');
      const certs = (team, kid) => o.certs(team, kid);
      const dienst = await controleerJwt(String(req.headers['cf-access-jwt-assertion'] || ''), { team: cfg.team, aud: cfg.audPod, soort: 'dienst', clientId: cfg.clientId }, certs, nu());
      if (!dienst.ok) return weiger(403, 'niet toegestaan', 'access: ' + dienst.reden);
      const wie = await controleerJwt(String(req.headers['x-fac-gebruiker'] || ''), { team: cfg.team, aud: cfg.audGebruiker, soort: 'gebruiker' }, certs, nu());
      if (!wie.ok) return weiger(403, 'niet toegestaan', 'gebruiker: ' + wie.reden);
      res._app.voorAuth = false;
      if (!o.routes) return weiger(404, 'Facturen zit niet in deze versie van de pod', 'facturen ontbreekt');
      const fdb = o.open();
      if (!fdb) return weiger(o.primair() ? 503 : 409, o.primair() ? 'de facturendatabase is nu niet te openen' : 'Facturen draait alleen op de primaire kant', 'geen database');
      const rol = o.routes.rolVoor(fdb, { ingang: 'fac', email: wie.email });
      if (!rol || rol.soort !== 'praktijkmanager' || rol.ingang !== 'fac' || !rol.id) return weiger(403, 'je hebt geen toegang tot Facturen; vraag het David', 'onbekende gebruiker');
      gebruiker = rol.id;
      res._app.apparaat = 'fac-' + rol.id;
      if (!teller(rol.id, 'alles', VERZOEKEN_PER_UUR)) return weiger(429, 'te veel verzoeken dit uur', 'grens alles');
      const pseudo = { id: 'fac-' + rol.id };
      // mag_bevestigen = 0: alleen kijken en uploaden (lezen, ruwe upload en de overname); elke andere handeling 403 (diffreview wv856 #4)
      if (rol.mag_bevestigen === false && req.method === 'POST' && !UPLOAD_RE.test(p) && p !== '/fac/facturen/upload')
        return weiger(403, 'je kunt in Facturen alleen kijken en uploaden; vraag het David', 'alleen kijken');

      // ruwe upload (één bestand per verzoek); de route van server.js schrijft naar een eigen map per gebruiker
      const up = UPLOAD_RE.exec(p);
      if (up) {
        if (req.method !== 'POST') return weiger(404, 'onbekend', 'upload methode');
        const g = tellers[rol.id];
        // de verbinding kan tijdens de JWT-controle al weg zijn; dan nooit een lopende stroom tellen (diffreview wv856 #3)
        if (req.destroyed || req.aborted || res.destroyed) return weiger(400, 'upload afgebroken', 'upload weg vóór start');
        if (g.lopend >= UPLOADS_TEGELIJK) return weiger(429, 'wacht tot de vorige upload klaar is', 'upload tegelijk');
        if (typeof o.uploadBytes === 'function' && o.uploadBytes() > UPLOAD_TOTAAL) return weiger(507, 'er staan nu te veel bestanden klaar; probeer het over een uur', 'upload vol');
        if (!teller(rol.id, 'upload', UPLOADS_PER_UUR)) return weiger(429, 'te veel bestanden dit uur (max ' + UPLOADS_PER_UUR + ')', 'grens upload');
        g.lopend++;
        let af = false;
        const klaar = () => { if (!af) { af = true; g.lopend = Math.max(0, g.lopend - 1); } };
        res.on('finish', klaar); res.on('close', klaar);
        res.on('finish', function () { if (!req.complete) req.resume(); });
        return o.upload(req, res, pseudo, up[1]);
      }
      if (p === '/fac/wie') {
        req.resume();
        if (req.method !== 'GET') return weiger(404, 'onbekend', 'wie methode');
        res._app.stil = true;
        return o.stuur(res, 200, { ok: true, email: wie.email, rol: rol.soort, mag_bevestigen: rol.mag_bevestigen !== false });
      }
      if (p !== '/fac/facturen' && p.indexOf('/fac/facturen/') !== 0) return weiger(404, 'onbekend', 'route');
      const d = await new Promise(function (ok) {
        o.body(req, function (fout, data) { ok(fout ? { fout } : { data: data || {} }); });
      });
      if (d.fout) return weiger(400, 'ongeldig verzoek', 'body ' + d.fout);
      const pad = '/app' + p.slice('/fac'.length);
      const r = o.routes.app(fdb, { methode: req.method, pad, d: d.data, rol, primair: o.primair(),
        versOk: function () { return false; }, versVerbruik: function () {},
        uploadNeem: function (b, n) { return o.uploadNeem(pseudo, b, n); }, bankluisPad: o.bankluisPad });
      res._app.reden = 'facturen ' + (r.reden || pad.slice('/app/facturen'.length) || '/');
      return o.stuur(res, r.status, r.j);
    } catch (e) {
      if (typeof o.fout === 'function') o.fout('facturen-ingang', e);
      if (!res.headersSent) return weiger(500, 'fout op de pod', 'uitzondering');
    }
  }

  return { isPad, verwerk, info, config, _tellers: tellers };
}

module.exports = { maak, controleerJwt, PAD_RE };
