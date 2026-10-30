'use strict';
/*
 * paypal-zakelijk-lezer.js — de enige plek die PayPal zakelijk aanroept (wv2056, 30-10-2026). Bron voor facturen-paypal.js.
 *
 * WAAROM ZO STRAK. De sleutel (kluis paypal_zakelijk_client_id / paypal_zakelijk_secret) kan technisch meer dan lezen: PayPal laat
 * "Accept payments" niet uitzetten, dus het token draagt ook refund, authcapture, v1/payments en dergelijke. David gaf 30-10-2026 22:50 Ja
 * op "lezen met een sleutel die technisch ook kan terugbetalen?" onder de voorwaarde dat de pod alleen de transactielijst aanroept. Dit
 * bestand kent daarom precies twee verzoeken (witte lijst in padToets, alles anders weigert vóór er een verbinding is):
 *   POST /v1/oauth2/token                  (grant_type=client_credentials; het token blijft in het geheugen van deze aanroep)
 *   GET  /v1/reporting/transactions        (alleen start_date, end_date, fields=all, page_size, page)
 * op https://api-m.paypal.com, zonder redirects. Er is één fetch, in roep(), en die gaat altijd eerst door padToets (CI-poort in
 * build.yml, toets in test/facturen-paypal.sh). Geen andere netwerk- of procesmodule.
 *
 * SLEUTEL. De beller geeft { id, geheim } mee (server.js leest ze op het moment van gebruik uit de kluis via de Management-API, 10 min in
 * het geheugen; de machinekamer-CLI net zo). Nooit in process.env, nooit in een log, foutmelding of antwoord: fouten noemen alleen de
 * HTTP-status en de PayPal-foutnaam.
 *
 * GRENZEN VAN PAYPAL (gemeten 30-10-2026): een venster is hooguit 31 dagen; start_date mag niet vóór "nu min 3 jaar" liggen (400
 * INVALID_REQUEST); last_refreshed_datetime loopt tot ± 3 uur achter.
 */

const BASIS = 'https://api-m.paypal.com';
const TOKEN_PAD = '/v1/oauth2/token';
const TRANSACTIE_PAD = '/v1/reporting/transactions';
const ISO_SEC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const QUERY_MAG = Object.freeze({ start_date: ISO_SEC, end_date: ISO_SEC, fields: /^all$/, page_size: /^([1-9]\d{0,2})$/, page: /^([1-9]\d{0,2})$/ });
const VENSTER_MS = 31 * 86400000 - 1000;
const MAX_PAGINAS = 400;   // over alle vensters samen; 3 jaar = 36 vensters, bij 500 per pagina ruim genoeg

class PaypalLezerFout extends Error {
  constructor(code, uitleg, status) { super(uitleg || code); this.code = code; this.uitleg = uitleg || code; this.status = status || null; }
}

// Witte lijst. → de volledige url, of PaypalLezerFout('pad'). Weigert alles wat niet precies een van de twee verzoeken is.
function padToets(methode, padQuery) {
  if (typeof padQuery !== 'string' || padQuery.length > 300 || padQuery[0] !== '/') throw new PaypalLezerFout('pad', 'PayPal-pad niet toegestaan');
  const u = new URL(padQuery, 'http://x');
  if (u.origin !== 'http://x' || u.hash || u.username || u.password) throw new PaypalLezerFout('pad', 'PayPal-pad niet toegestaan');
  const p = u.pathname;
  if (methode === 'POST') {
    if (p !== TOKEN_PAD || u.search) throw new PaypalLezerFout('pad', 'PayPal: POST alleen op ' + TOKEN_PAD);
  } else if (methode === 'GET') {
    if (p !== TRANSACTIE_PAD) throw new PaypalLezerFout('pad', 'PayPal: GET alleen op ' + TRANSACTIE_PAD);
    const gezien = new Set();
    for (const [k, v] of u.searchParams) {
      if (!Object.hasOwn(QUERY_MAG, k) || !QUERY_MAG[k].test(v) || gezien.has(k)) throw new PaypalLezerFout('pad', 'PayPal: queryparameter niet toegestaan');
      gezien.add(k);
    }
    if (!gezien.has('start_date') || !gezien.has('end_date')) throw new PaypalLezerFout('pad', 'PayPal: start_date en end_date verplicht');
  } else throw new PaypalLezerFout('pad', 'PayPal: methode niet toegestaan');
  return BASIS + p + u.search;
}

// De enige netwerkaanroep. ctx = { sleutels: { id, geheim }, token?, timeoutMs? }. → { status, j }
async function roep(ctx, methode, padQuery) {
  const url = padToets(methode, padQuery);
  const headers = { Accept: 'application/json', 'User-Agent': 'socev-facturen-paypal/1' };
  let body;
  if (methode === 'POST') {
    headers.Authorization = 'Basic ' + Buffer.from(ctx.sleutels.id + ':' + ctx.sleutels.geheim).toString('base64');
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = 'grant_type=client_credentials';
  } else headers.Authorization = 'Bearer ' + ctx.token;
  const r = await fetch(url, { method: methode, headers, body, redirect: 'error', signal: AbortSignal.timeout(ctx.timeoutMs || 30000) });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, j };
}
function foutVan(r, wat) {
  const naam = r.j && typeof r.j.name === 'string' ? r.j.name.replace(/[^A-Z_]/g, '').slice(0, 40) : (r.j && typeof r.j.error === 'string' ? r.j.error.replace(/[^a-z_]/g, '').slice(0, 40) : '');
  return new PaypalLezerFout('http', wat + ': PayPal gaf HTTP ' + r.status + (naam ? ' ' + naam : ''), r.status);
}

async function token(ctx) {
  const s = ctx && ctx.sleutels;
  if (!s || typeof s.id !== 'string' || typeof s.geheim !== 'string' || !s.id.trim() || !s.geheim.trim()) throw new PaypalLezerFout('sleutel', 'PayPal-sleutel ontbreekt');
  const r = await roep(ctx, 'POST', TOKEN_PAD);
  if (r.status !== 200 || !r.j || typeof r.j.access_token !== 'string') throw foutVan(r, 'token');
  const scopes = String(r.j.scope || '').split(/\s+/).filter(Boolean);
  return { token: r.j.access_token, app_id: typeof r.j.app_id === 'string' ? r.j.app_id.replace(/[^A-Z0-9-]/g, '').slice(0, 40) : null,
    leesrecht: scopes.includes('https://uri.paypal.com/services/reporting/search/read'),
    uitbetalen: scopes.some((x) => /payouts/i.test(x)) };
}

// Alleen de rechten van de sleutel (één POST op het token): app_id, leesrecht, uitbetalen. Het token zelf gaat niet terug.
async function rechten(sleutels, opties) {
  const t = await token({ sleutels, timeoutMs: (opties || {}).timeoutMs });
  return { app_id: t.app_id, leesrecht: t.leesrecht, uitbetalen: t.uitbetalen };
}

function isoSec(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
// Vroegst toegestane start: nu min 3 jaar plus één dag (marge voor klok en tijdzone).
function vroegste(nu) { const d = new Date(nu); d.setUTCFullYear(d.getUTCFullYear() - 3); d.setUTCHours(0, 0, 0, 0); return d.getTime() + 86400000; }
// Vensters van hooguit 31 dagen min 1 s, aaneensluitend, van van tot tot (ms). → [[startIso, eindIso], …]
function vensters(vanMs, totMs) {
  const uit = [];
  for (let b = vanMs; b < totMs; ) { const e = Math.min(b + VENSTER_MS, totMs); uit.push([isoSec(b), isoSec(e)]); b = e + 1000; }
  return uit;
}

/*
 * Alle transacties tussen van en tot (ms; van wordt opgehoogd tot de grens van PayPal). sleutels = { id, geheim }. opties = { nu, eisLeesrecht,
 * timeoutMs }. Een sleutel met uitbetaalrecht leest niets (geen uitzondering mogelijk). → { account, app_id, uitbetalen, ververst, vensters, paginas, details: [ruwe transaction_details] }. Gooit bij elke andere
 * status dan 200 (niets half: de beller slaat dan niets op).
 */
async function transacties(sleutels, van, tot, opties) {
  const o = opties || {};
  const nu = Number.isFinite(o.nu) ? o.nu : Date.now();
  const ctx = { sleutels, timeoutMs: o.timeoutMs };
  const t = await token(ctx);
  if (!t.leesrecht) throw new PaypalLezerFout('scope', 'de PayPal-sleutel mist Transaction Search (reporting/search/read)');
  // Davids Ja (30-10-2026) gold voor een sleutel zonder uitbetaalrecht; komt dat erbij, dan niets lezen (de beller meldt het)
  if (t.uitbetalen) throw new PaypalLezerFout('scope_uitbetalen', 'de PayPal-sleutel kan uitbetalen (payouts): ronde gestopt');
  ctx.token = t.token;
  const start = Math.max(van, vroegste(nu)), eind = Math.min(tot, nu);
  const uit = { account: null, app_id: t.app_id, uitbetalen: t.uitbetalen, ververst: null, vensters: 0, paginas: 0, details: [] };
  for (const [b, e] of vensters(start, eind)) {
    uit.vensters++;
    for (let p = 1; ; p++) {
      if (++uit.paginas > MAX_PAGINAS) throw new PaypalLezerFout('te_veel', 'meer dan ' + MAX_PAGINAS + ' pagina\'s: gestopt');
      const q = '?start_date=' + b + '&end_date=' + e + '&fields=all&page_size=500&page=' + p;
      const r = await roep(ctx, 'GET', TRANSACTIE_PAD + q);
      if (r.status !== 200 || !r.j) throw foutVan(r, 'transacties');
      const acc = typeof r.j.account_number === 'string' ? r.j.account_number : null;
      if (acc) {
        if (uit.account && uit.account !== acc) throw new PaypalLezerFout('account', 'PayPal gaf twee verschillende rekeningen in één ronde');
        uit.account = acc;
      }
      if (typeof r.j.last_refreshed_datetime === 'string') uit.ververst = r.j.last_refreshed_datetime.slice(0, 30);
      const d = Array.isArray(r.j.transaction_details) ? r.j.transaction_details : [];
      uit.details.push(...d);
      if (p >= (Number(r.j.total_pages) || 1)) break;
    }
  }
  return uit;
}

// token() zelf wordt niet geëxporteerd (review wv2056 ZOU 2): geen andere module krijgt een bearer-token in handen.
module.exports = { PaypalLezerFout, BASIS, TOKEN_PAD, TRANSACTIE_PAD, padToets, rechten, transacties, vensters, vroegste, isoSec };
