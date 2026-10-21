'use strict';
/*
 * bunq-lezer.js — ALLEEN-LEZEN bron "bunq" voor bank-lezer.js (wv683, 20-10-2026). Bouwplan: vault 01_Ontwikkeling/
 * Bankkoppeling open banking - verkenning en bouwplan (20-10-2026).md, fase 2.
 *
 * WAAROM. David wil al zijn privérekeningen in Socev zien, zodat samenhang en interne overboekingen te volgen zijn (20-10
 * 20:59). Alles behalve de gezamenlijke ABN-rekening staat bij bunq; bunq heeft een eigen API en David zette daarvoor een
 * sleutel in de kluis (bunq_api_key, 22:03). De machinekamer activeerde hem 22:05 (mk-scripts/bunq/activeer.py): installatie,
 * device-server met alleen het thuis-IP, sleutelpaar en serversleutel in BANK_DIR/bunq/staat.json (600).
 *
 * LET OP. De bunq-sleutel is een volledige productiesleutel: met een sessie kan hij ook betalen. Dit bestand is daarom de
 * enige plek die bunq aanroept, en het kent precies twee soorten verzoeken (witte lijst in padToets, alles anders weigert):
 *   GET  /v1/user/{eigen id}/monetary-account[-bank|-savings|-joint]   (query alleen count, older_id)
 *   GET  /v1/user/{eigen id}/monetary-account/{id}/payment              (query alleen count, older_id) = transactielijst
 *   POST /v1/session-server                                              (sessie openen met de sleutel; ondertekend)
 * Geen PUT, PATCH, DELETE en geen andere POST; geen redirects volgen. De CI-build controleert dat (build.yml).
 * Elk 2xx-antwoord moet een geldige X-Bunq-Server-Signature hebben (RSA-SHA256 over de ruwe body, serversleutel uit de
 * installatie); zonder of met een foute handtekening weigeren we het antwoord.
 *
 * SESSIE. Het sessietoken staat nooit op schijf: server.js houdt het in het geheugen en geeft het via stdin mee
 * (geheim.bunq_sessie); een nieuw token gaat via het uitvoerveld _bunq_sessie terug naar server.js, dat het eruit haalt
 * voordat de uitvoer naar de sessie gaat. De sleutel komt ook via stdin (geheim.bunq_sleutel).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASIS = (function () {
  const b = process.env.BUNQ_API_BASIS || 'https://api.bunq.com';
  if (b !== 'https://api.bunq.com' && !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(b)) return 'https://api.bunq.com';
  return b;
})();
const SOORTEN = { MonetaryAccountBank: 'lopend', MonetaryAccountSavings: 'spaar', MonetaryAccountJoint: 'gezamenlijk' };
const SESSIE_MAX_MS = 24 * 3600 * 1000;    // ook als bunq een week geeft: elke dag een verse sessie
// bunq: 3 GET per 3 s per endpoint (429-tekst); dus ≥ 1,1 s tussen pagina's en bij 429 één keer 3 s wachten (Fable wv683 #1)
const PAUZE_MS = parseInt(process.env.BUNQ_PAUZE_MS, 10) >= 0 ? parseInt(process.env.BUNQ_PAUZE_MS, 10) : 1100;
const WACHT_429_MS = parseInt(process.env.BUNQ_PAUZE_MS, 10) >= 0 ? parseInt(process.env.BUNQ_PAUZE_MS, 10) : 3000;
const MAX_PAGINAS = Math.min(Math.max(parseInt(process.env.BUNQ_MAX_PAGINAS, 10) || 40, 1), 40);   // 40 × 200 posten per rekening per opvraag (lager alleen in de toets)

class BunqFout extends Error {
  constructor(status, reden, tekst) { super('bunq HTTP ' + status); this.status = status; this.reden = reden; this.tekst = String(tekst || '').slice(0, 300); }
}
class BunqWeigering extends Error {}

// ── witte lijst ─────────────────────────────────────────────────────────────
const LEES_PADEN = [
  /^\/v1\/user\/(\d{1,15})\/monetary-account(?:-bank|-savings|-joint)?$/,
  /^\/v1\/user\/(\d{1,15})\/monetary-account\/\d{1,15}\/payment$/,
];
const QUERY_MAG = { count: /^\d{1,3}$/, older_id: /^\d{1,15}$/ };
// Geeft de volledige URL terug of gooit BunqWeigering. userId = eigen gebruiker uit staat.json: een ander id weigert.
function padToets(methode, padQuery, userId) {
  if (typeof padQuery !== 'string' || padQuery.length > 300 || !/^\/v1\//.test(padQuery)) throw new BunqWeigering('bunq-pad niet toegestaan');
  const u = new URL(padQuery, 'http://x');
  if (u.origin !== 'http://x' || u.hash || u.username || u.password) throw new BunqWeigering('bunq-pad niet toegestaan');
  const p = u.pathname;
  if (p !== decodeURIComponent(p) || /\/\.\.?(\/|$)|\/\//.test(p)) throw new BunqWeigering('bunq-pad niet toegestaan');
  if (methode === 'POST') {
    if (p !== '/v1/session-server' || u.search) throw new BunqWeigering('bunq: POST alleen op /v1/session-server');
  } else if (methode === 'GET') {
    const m = LEES_PADEN.map(function (r) { return r.exec(p); }).find(Boolean);
    if (!m) throw new BunqWeigering('bunq-pad niet toegestaan (alleen rekeningen en transacties lezen)');
    if (String(m[1]) !== String(userId)) throw new BunqWeigering('bunq: andere gebruiker dan de eigen');
    const keys = new Set();
    for (const [k, v] of u.searchParams) {
      if (!Object.hasOwn(QUERY_MAG, k) || !QUERY_MAG[k].test(v) || keys.has(k)) throw new BunqWeigering('bunq: queryparameter niet toegestaan');
      keys.add(k);
    }
  } else throw new BunqWeigering('bunq: methode niet toegestaan');
  return BASIS + p + u.search;
}

// ── staat ───────────────────────────────────────────────────────────────────
function staatPad(bankDir) { return path.join(bankDir, 'bunq', 'staat.json'); }
function staatLees(bankDir) {
  let s;
  try { s = JSON.parse(fs.readFileSync(staatPad(bankDir), 'utf8')); } catch (e) { return null; }
  if (!s || !s.private_key_pem || !s.installation_token || !s.server_public_key || !s.user_id) return null;
  return s;
}

// ── verzoek ─────────────────────────────────────────────────────────────────
function kop(token) {
  return { 'Cache-Control': 'no-cache', 'User-Agent': 'Socev-pod', 'X-Bunq-Language': 'nl_NL', 'X-Bunq-Region': 'nl_NL',
    'X-Bunq-Geolocation': '0 0 0 0 000', 'X-Bunq-Client-Request-Id': crypto.randomUUID(), 'X-Bunq-Client-Authentication': token };
}
function handtekeningOk(ctx, koppen, ruw) {
  const sig = koppen.get('x-bunq-server-signature');
  if (!sig || !/^[A-Za-z0-9+/=]{100,1000}$/.test(sig)) return false;
  try { return crypto.verify('RSA-SHA256', ruw, { key: ctx.serverSleutel, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(sig, 'base64')); }
  catch (e) { return false; }
}
async function roep(ctx, methode, padQuery, body, token) {
  const url = padToets(methode, padQuery, ctx.staat.user_id);
  const h = kop(token);
  let data;
  if (methode === 'POST') {
    data = JSON.stringify(body);
    h['Content-Type'] = 'application/json';
    h['X-Bunq-Client-Signature'] = crypto.sign('RSA-SHA256', Buffer.from(data), { key: ctx.privSleutel, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64');
  }
  let r;
  try { r = await fetch(url, { method: methode, headers: h, body: data, redirect: 'manual', signal: AbortSignal.timeout(30000) }); }
  catch (e) { throw new BunqFout(0, 'storing', 'onbereikbaar: ' + (e && e.name || 'fout')); }
  const ruw = Buffer.from(await r.arrayBuffer());
  if (r.status >= 300 && r.status < 400) throw new BunqFout(r.status, 'storing', 'omleiding geweigerd');
  if (!r.ok) {
    let desc = '';
    try { desc = (JSON.parse(ruw.toString('utf8')).Error || []).map(function (x) { return x.error_description; }).join('; '); } catch (e) {}
    throw new BunqFout(r.status, r.status === 429 ? 'grens' : 'http', desc);
  }
  if (!handtekeningOk(ctx, r.headers, ruw)) throw new BunqFout(r.status, 'handtekening', 'antwoord zonder geldige bunq-handtekening; geweigerd');
  try { return JSON.parse(ruw.toString('utf8')); } catch (e) { throw new BunqFout(502, 'storing', 'geen JSON'); }
}
function pauze() { return new Promise(function (ok) { setTimeout(ok, PAUZE_MS); }); }

// ── context en sessie ──────────────────────────────────────────────────────
// ctx: { staat, privSleutel, serverSleutel, sleutel, sessie: {token, tot}, nieuweSessie }
function context(bankDir, geheim) {
  const staat = staatLees(bankDir);
  if (!staat) return null;
  const ctx = { staat: staat, sleutel: typeof geheim.bunq_sleutel === 'string' ? geheim.bunq_sleutel.trim() : '', sessie: null, nieuweSessie: null };
  try { ctx.privSleutel = crypto.createPrivateKey(staat.private_key_pem); ctx.serverSleutel = crypto.createPublicKey(staat.server_public_key); }
  catch (e) { throw new BunqWeigering('bunq-staat onleesbaar (sleutelpaar); opnieuw registreren in de machinekamer'); }
  const s = geheim.bunq_sessie;
  if (s && typeof s.token === 'string' && /^[A-Za-z0-9]{20,200}$/.test(s.token) && Date.parse(s.tot) > Date.now() + 60000) ctx.sessie = { token: s.token, tot: s.tot };
  return ctx;
}
async function sessieOpen(ctx) {
  if (!ctx.sleutel) throw new BunqFout(0, 'sleutel', 'bunq-sleutel ontbreekt (kluis: bunq_api_key)');
  let j;
  try { j = await roep(ctx, 'POST', '/v1/session-server', { secret: ctx.sleutel }, ctx.staat.installation_token); }
  catch (e) {
    // Fout IP of ingetrokken sleutel geeft bunq als 400/401/403 "Incorrect API key or IP address".
    if (e instanceof BunqFout && [400, 401, 403].indexOf(e.status) >= 0)
      throw new BunqFout(e.status, 'toegang', 'bunq weigert de sessie: thuis-IP gewijzigd of sleutel ingetrokken; opnieuw registreren (machinekamer)');
    throw e;
  }
  let token = null, timeout = null, gebruiker = null;
  (j.Response || []).forEach(function (x) {
    Object.keys(x).forEach(function (k) {
      if (k === 'Token') token = x[k] && x[k].token;
      if (/^User/.test(k)) { gebruiker = x[k] && x[k].id; timeout = x[k] && x[k].session_timeout; }
    });
  });
  if (!token || !/^[A-Za-z0-9]{20,200}$/.test(token)) throw new BunqFout(502, 'storing', 'sessie zonder token');
  if (String(gebruiker) !== String(ctx.staat.user_id)) throw new BunqFout(502, 'storing', 'sessie voor een andere gebruiker');
  const duur = Math.min(Math.max((Number(timeout) || 3600) * 1000 - 600000, 300000), SESSIE_MAX_MS);
  ctx.sessie = ctx.nieuweSessie = { token: token, tot: new Date(Date.now() + duur).toISOString() };
  return ctx.sessie;
}
// GET met sessie; bij 401 op een oude sessie één keer een nieuwe sessie en opnieuw; bij 429 één keer na 3 s opnieuw.
async function lees(ctx, padQuery) {
  try { return await lees1(ctx, padQuery); }
  catch (e) {
    if (!(e instanceof BunqFout) || e.status !== 429) throw e;
    await new Promise(function (ok) { setTimeout(ok, WACHT_429_MS); });
    return lees1(ctx, padQuery);
  }
}
async function lees1(ctx, padQuery) {
  if (!ctx.sessie) await sessieOpen(ctx);
  try { return await roep(ctx, 'GET', padQuery, null, ctx.sessie.token); }
  catch (e) {
    if (!(e instanceof BunqFout) || e.status !== 401 || ctx.nieuweSessie) {
      if (e instanceof BunqFout && e.status === 401) throw new BunqFout(401, 'toegang', 'bunq weigert ook met een verse sessie: thuis-IP gewijzigd of sleutel ingetrokken');
      throw e;
    }
    ctx.sessie = null;
    await sessieOpen(ctx);
    return roep(ctx, 'GET', padQuery, null, ctx.sessie.token);
  }
}

// ── rekeningen ──────────────────────────────────────────────────────────────
function r2(n) { return Math.round(n * 100) / 100; }
async function rekeningen(ctx) {
  const uit = [], overgeslagen = {};
  let pad = '/v1/user/' + ctx.staat.user_id + '/monetary-account?count=200', paginas = 0;
  while (pad && paginas < 5) {
    const j = await lees(ctx, pad);
    paginas++;
    (j.Response || []).forEach(function (x) {
      Object.keys(x).forEach(function (k) {
        const v = x[k] || {};
        if (!Object.hasOwn(SOORTEN, k)) { overgeslagen[k] = (overgeslagen[k] || 0) + 1; return; }
        const iban = (v.alias || []).find(function (a) { return a && a.type === 'IBAN'; });
        uit.push({ id: v.id, soort: SOORTEN[k], status: String(v.status || '?'), naam: v.description || null, iban: iban ? iban.value : null,
          valuta: v.currency || (v.balance && v.balance.currency) || 'EUR', saldo: v.balance ? r2(Number(v.balance.value)) : null,
          mede_eigenaars: Array.isArray(v.all_co_owner) ? v.all_co_owner.length : undefined });
      });
    });
    const ou = j.Pagination && j.Pagination.older_url;
    pad = ou ? ou : null;
    if (pad) await pauze();
  }
  return { rekeningen: uit, overgeslagen: overgeslagen, afgekapt: !!pad };
}

// ── transacties (payment-lijst, nieuwste eerst) ─────────────────────────────
function dagAms(ts) {
  // bunq geeft "JJJJ-MM-DD UU:MM:SS.ffffff" in UTC
  const d = new Date(String(ts || '').replace(' ', 'T').slice(0, 23) + 'Z');
  return isNaN(d) ? '' : d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
}
// Nieuwste eerst, terug tot 'van'. vanafId: verder terug vanaf een eerder afgekapte opvraag (older_id; Fable wv683 #2).
// Een fout na ≥ 1 pagina geeft wat er al was plus de fout (fout), zodat de caller dat deel kan bewaren (Fable wv683 #1).
async function transacties(ctx, rekId, van, telPagina, vanafId) {
  if (!/^\d{1,15}$/.test(String(rekId))) throw new BunqWeigering('bunq: ongeldig rekening-id');
  if (vanafId != null && !/^\d{1,15}$/.test(String(vanafId))) throw new BunqWeigering('bunq: ongeldig older_id');
  const alle = [];
  let pad = '/v1/user/' + ctx.staat.user_id + '/monetary-account/' + rekId + '/payment?count=200' + (vanafId != null ? '&older_id=' + vanafId : ''), paginas = 0, klaar = false, fout = null;
  while (pad && paginas < MAX_PAGINAS) {
    let j;
    try { j = await lees(ctx, pad); }
    catch (e) { if (!alle.length) throw e; fout = e; break; }
    paginas++; if (telPagina) telPagina();
    const lijst = (j.Response || []).map(function (x) { return x.Payment; }).filter(Boolean);
    lijst.forEach(function (p) { alle.push(p); });
    const oudste = lijst.length ? dagAms(lijst[lijst.length - 1].created) : '';
    if (!lijst.length || (oudste && oudste < van)) { klaar = true; break; }
    const ou = j.Pagination && j.Pagination.older_url;
    pad = ou ? ou : null;
    if (!pad) { klaar = true; break; }
    await pauze();
  }
  const laatste = alle.length ? alle[alle.length - 1] : null;
  return { posten: alle.filter(function (p) { const d = dagAms(p.created); return !d || d >= van; }), paginas: paginas, afgekapt: !klaar,
    oudste_id: laatste ? laatste.id : null, oudste_dag: laatste ? dagAms(laatste.created) || null : null,
    onleesbaar: alle.filter(function (p) { return !dagAms(p.created); }).length, fout: fout };
}
function eenvoudig(lijst, schoon) {
  return (lijst || []).map(function (p) {
    const ca = p.counterparty_alias || {};
    const tegen = schoon(ca.display_name, 140), omschr = schoon(p.description, 500);
    return { id: 'b:' + p.id, datum: dagAms(p.created), valutadatum: null, bedrag: r2(Number(p.amount && p.amount.value)),
      valuta: (p.amount && p.amount.currency) || 'EUR', tegenpartij: tegen, omschrijving: omschr && omschr !== tegen ? omschr : null,
      status: 'geboekt', saldo_na: p.balance_after_mutation ? r2(Number(p.balance_after_mutation.value)) : null,
      mcc: ca.merchant_category_code ? String(ca.merchant_category_code).slice(0, 8) : null,
      tegen_iban: typeof ca.iban === 'string' && /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(ca.iban) ? ca.iban : null,
      _ruw: p };   // wv687: het ruwe bankobject voor het archief (bank-archief.js, kolom ruwe_json); nooit in de uitvoer
  });
}

module.exports = { BunqFout, BunqWeigering, padToets, staatLees, context, rekeningen, transacties, eenvoudig, dagAms, sessieOpen, SOORTEN };
