#!/usr/bin/env bash
# Toetst de bankluis in server.js (wv680, 20-10-2026): POST /smal/bank (bankSmal) en GET /bank/terug (bankTerug). Het
# bankblok en smalKind worden uit server.js geknipt en in een vm-context gedraaid met de echte bank-lezer.js tegen een
# nagebootste Enable Banking-API (zelfde nabootsing als test/bank-lezer.sh, kleiner). De kluis is nagebootst via fetch.
# Toetst: opdrachten-witte lijst, ontkoppel alleen met API_SECRET, invoercontrole, sleutel nooit in argv/omgeving/uitvoer,
# terugkeerpad 404 bij alles behalve een bekende onverbruikte state, eenmalig, geen gegevens in de pagina, historie daarna.
# Raakt de pod, de kluis en /opt/data/bank niet. Gebruik: bash test/bankluis-poort.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), http = require('http'), vm = require('vm');
const { spawn } = require('child_process');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'bankpoort-'));
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '');   // zoals uit het portaal
const APP = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const M = { auth: [], sessies: 0, opvragen: 0 };
const api = http.createServer(function (req, res) {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', function () {
    const u = new URL(req.url, 'http://x'), stuur = (st, j) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (!/^Bearer /.test(req.headers.authorization || '')) return stuur(401, {});
    if (u.pathname === '/aspsps') return stuur(200, { aspsps: [{ name: 'ABN AMRO', country: 'NL', psu_types: ['personal'], maximum_consent_validity: 15552000 }] });
    if (u.pathname === '/auth') { M.auth.push(JSON.parse(body)); return stuur(200, { url: 'https://bank.example/x', authorization_id: 'a' }); }
    if (u.pathname === '/sessions' && req.method === 'POST') { M.sessies++; return stuur(200, { session_id: 'sess-0001', aspsp: { name: 'ABN AMRO', country: 'NL' }, psu_type: 'personal',
      access: { valid_until: new Date(Date.now() + 170 * 86400000).toISOString() }, accounts: [{ uid: 'u1', name: 'Gezamenlijk', currency: 'EUR', identification_hash: 'h1', account_id: { iban: 'NL00ABNA0000001234' } }] }); }
    if (/balances$/.test(u.pathname)) { M.opvragen++; return stuur(200, { balances: [{ balance_type: 'CLBD', balance_amount: { currency: 'EUR', amount: '10.00' } }] }); }
    if (/transactions$/.test(u.pathname)) { M.opvragen++; return stuur(200, { transactions: [{ entry_reference: 'x1', transaction_amount: { currency: 'EUR', amount: '5' }, credit_debit_indicator: 'DBIT', status: 'BOOK', booking_date: '2026-10-01', creditor: { name: 'Winkel' } }] }); }
    stuur(404, {});
  });
});

const src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf('// ── wv680: bankluis'), b = src.indexOf('// ── einde bankluis ──');
const k1 = src.indexOf('function smalKind('), k2 = src.indexOf('async function smalSbRpc(');
const SECRET = 's'.repeat(40);
const logs = [];
let kluisAanroepen = 0;
api.listen(0, '127.0.0.1', async function () {
  const env = { PATH: process.env.PATH, HOME: W, TZ: 'Europe/Amsterdam', BANK_DIR: path.join(W, 'bank'), BANK_API_BASIS: 'http://127.0.0.1:' + api.address().port,
    SUPABASE_URL: 'https://abcdef.supabase.co', SUPABASE_MCP_TOKEN: 'pat-geheim', ANDERE_SLEUTEL: 'mag-niet-mee' };
  const g = { require, fs, path, crypto, Buffer, console, URL, setTimeout, clearTimeout, AbortSignal, Promise, JSON, Date, spawn, VAULT: W, SECRET: SECRET,
    __dirname: process.cwd(), process: { env: env, execPath: process.execPath },
    fetch: async function (url, o) {
      kluisAanroepen++;
      if (g.__kluisFout) throw new Error('netwerk weg');
      if (String(url).indexOf('https://api.supabase.com/v1/projects/abcdef/database/query') !== 0 || o.headers.Authorization !== 'Bearer pat-geheim') return { ok: false, status: 401, text: async () => '' };
      return { ok: true, json: async () => [{ name: 'enablebanking_app_key', w: pem }, { name: 'enablebanking_app_id', w: APP }] };
    },
    logError: (w, e) => logs.push(w + ': ' + (e && e.message || e)), schrijfLog: (r) => logs.push(r), nu: () => 'NU', velden: (o) => JSON.stringify(o),
    reqPath: (req) => (req.url || '').split('?')[0], rolPoort: (res, verder) => verder(),
    rol: { eerste: true }, rolPrimair: () => g.__primair !== false, rolEerste: Promise.resolve(), ROL_START_WACHT_MS: 50 };
  const ctx = vm.createContext(g);
  vm.runInContext(src.slice(k1, k2) + '\n' + src.slice(a, b) + '\n;globalThis.__h = { bankSmal, bankTerug, bankIsPad, bankEnv };', ctx, { filename: 'server.js#bank' });
  const h = ctx.__h;
  const nepRes = () => { const r = { status: 0, koppen: {}, body: '', _log: {}, headersSent: false,
    writeHead(s, k) { this.status = s; this.koppen = k || {}; this.headersSent = true; }, end(t) { this.body = String(t || ''); this.klaar && this.klaar(); } };
    r.wacht = new Promise((ok) => r.klaar = ok); return r; };
  const terug = async (url, m) => { const res = nepRes(); h.bankTerug({ method: m || 'GET', url: url }, res); await Promise.race([res.wacht, new Promise((r) => setTimeout(r, 20000))]); return res; };
  try {
    toets('bankIsPad alleen /bank/terug', h.bankIsPad({ url: '/bank/terug?x=1' }) && !h.bankIsPad({ url: '/bank/terugx' }) && !h.bankIsPad({ url: '/bank' }), null);
    const e = h.bankEnv();
    toets('kind krijgt geen PAT of andere sleutels in de omgeving', !e.SUPABASE_MCP_TOKEN && !e.ANDERE_SLEUTEL && e.BANK_DIR, Object.keys(e));
    let r = await h.bankSmal({ secret: 'socev', opdracht: 'betaal' });
    toets('onbekende opdracht: 400', r.status === 400, r);
    r = await h.bankSmal({ secret: 'socev', opdracht: 'ontkoppel', sessie: 'sess-0001' });
    toets('ontkoppel met Socev-sleutel: 403', r.status === 403, r);
    r = await h.bankSmal({ secret: 'socev', opdracht: 'transacties', rekening: '1234', van: '1-10-2026' });
    toets('ongeldige datum: 400', r.status === 400, r);
    r = await h.bankSmal({ secret: 'socev', opdracht: 'koppel-start', bank: 'ABN AMRO; rm -rf' });
    toets('ongeldige banknaam: 400', r.status === 400, r);
    r = await h.bankSmal({ secret: 'socev', opdracht: 'koppel-start', bank: 'ABN AMRO' });
    toets('koppel-start via de poort: link', r.status === 200 && r.j.ok && /^https:/.test(r.j.url), r);
    toets('sleutel niet in de uitvoer', JSON.stringify(r.j).indexOf(pem.slice(40, 80)) < 0, null);
    const state = M.auth[0].state;

    r = await h.bankSmal({ secret: 'socev', opdracht: 'transacties', rekening: '--max', van: '2026-09-01' });
    toets('rekening met leidende -- geweigerd', r.status === 400, r);
    g.__kluisFout = true; ctx.bankSleutelCache = null;
    vm.runInContext('bankSleutelCache = null', ctx);
    r = await h.bankSmal({ secret: 'socev', opdracht: 'saldo' });
    toets('kluis onbereikbaar: storing, geen "sleutel ontbreekt"', r.j.ok === false && r.j.reden === 'storing' && !/ontbreekt \(kluis/.test(r.j.fout), r.j);
    g.__kluisFout = false; kluisAanroepen = 0;
    vm.runInContext('bankSleutelCache = null', ctx);
    r = await h.bankSmal({ secret: 'socev', opdracht: 'koppel-start', bank: 'ABN AMRO' });
    const state2 = M.auth[1].state;
    const k0 = kluisAanroepen;
    let res = await terug('/bank/terug?code=x&state=' + 'b'.repeat(48));
    toets('onbekende state: 404 zonder kluisopvraag of kindproces', res.status === 404 && kluisAanroepen === k0, kluisAanroepen);
    g.__primair = false;
    res = await terug('/bank/terug?code=goed&state=' + state2);
    toets('passieve kant: neutrale 503-pagina zonder rolinformatie', res.status === 503 && !/passief|kant|vps|olares/i.test(res.body), res.body);
    g.__primair = true;
    res = await terug('/bank/terug', 'POST');
    toets('POST op /bank/terug: 404', res.status === 404, res.status);
    res = await terug('/bank/terug?code=abc');
    toets('zonder state: 404', res.status === 404, res.status);
    res = await terug('/bank/terug?code=abc&state=' + 'a'.repeat(48));
    toets('onbekende state: 404', res.status === 404, res.status);
    res = await terug('/bank/terug?code=goed&state=' + state);
    toets('bekende state: 200 Gekoppeld, geen gegevens in de pagina', res.status === 200 && /Gekoppeld/.test(res.body) && res.body.indexOf('NL00') < 0 && res.body.indexOf('sess-') < 0, res.body);
    toets('pagina: no-store, no-referrer, strenge CSP', res.koppen['Cache-Control'].indexOf('no-store') === 0 && res.koppen['Referrer-Policy'] === 'no-referrer' && /default-src 'none'/.test(res.koppen['Content-Security-Policy']), res.koppen);
    res = await terug('/bank/terug?code=goed&state=' + state);
    toets('dezelfde state tweede keer: 404', res.status === 404 && M.sessies === 1, [res.status, M.sessies]);
    for (let i = 0; i < 40 && M.opvragen < 2; i++) await new Promise((ok) => setTimeout(ok, 250));
    toets('historie na koppelen: saldo en transacties opgehaald', M.opvragen >= 2, M.opvragen);
    r = await h.bankSmal({ secret: 'socev', opdracht: 'rekeningen' });
    toets('rekeningen via de poort', r.j.ok && r.j.rekeningen.length === 1, r.j);
    r = await h.bankSmal({ secret: 'socev', opdracht: 'transacties', rekening: '1234', van: '2026-09-01' });
    toets('transacties met let_op_bron (gegeven, geen opdracht)', r.j.ok && r.j.aantal === 1 && /geen opdracht/.test(r.j.let_op_bron), r.j);
    // wv684: 2000 posten met tekens van drie bytes (€) komen heel door smalKind (setEncoding: geen U+FFFD op een stukgrens)
    {
      const { DatabaseSync } = require('node:sqlite');
      const d = new DatabaseSync(path.join(W, 'bank', 'cache.sqlite'));
      const rh = d.prepare('SELECT rek FROM tx LIMIT 1').get().rek;
      const zet = d.prepare("INSERT INTO tx (rek, id, datum, bedrag, valuta, tegenpartij, omschrijving, status, opgehaald) VALUES (?, ?, ?, ?, 'EUR', ?, ?, 'geboekt', ?)");
      for (let i = 0; i < 2000; i++) zet.run(rh, 'e:euro-' + i, '2026-0' + (1 + (i % 8)) + '-15', -1, '€€€ ' + i, '€'.repeat(140), 'NU');
      d.close();
      r = await h.bankSmal({ secret: 'socev', opdracht: 'transacties', rekening: '1234', van: '2026-01-01', tot: '2026-08-31', max: 2000 });
      const t = JSON.stringify(r.j);
      toets('2000 posten met € heel door smalKind, geen U+FFFD', r.j.ok && r.j.getoond === 2000 && t.indexOf('\ufffd') < 0 && t.length > 400000, [r.j.ok, r.j.getoond, r.j.fout, t.length]);
    }
    r = await h.bankSmal({ secret: SECRET, opdracht: 'ontkoppel', sessie: 'sess-0001' });
    toets('ontkoppel met API_SECRET mag (nagebootste API: 404 = al weg)', r.status === 200 && r.j.ok, r.j);
    toets('kluis daarna 1× gelezen (10 minuten in het geheugen)', kluisAanroepen === 1, kluisAanroepen);
    const alles = logs.join('\n');
    toets('geen sleutel of PAT in de logregels', alles.indexOf('pat-geheim') < 0 && alles.indexOf(pem.slice(40, 80)) < 0, null);
  } catch (err) { fouten++; console.log('ROOD  uitzondering: ' + (err && err.stack || err)); }
  api.close(); fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
});
JS
