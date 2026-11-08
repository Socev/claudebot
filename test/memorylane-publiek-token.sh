#!/usr/bin/env bash
# Toetst wv2738: memorylanePubliek (server.js) schrijft D1/R2 met het eigen token uit kluisrij cloudflare_memorylane, valt alleen bij een
# ontbrekende rij terug op CLOUDFLARE_API_TOKEN, en valt bij een kluisfout NIET terug. Knipsel-toets in een vm; verzonnen tokens.
# Gebruik: bash test/memorylane-publiek-token.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const s = fs.readFileSync('server.js', 'utf8');
const a = s.indexOf('// ── wv2636: MemoryLane op memorylane.socev.dev'), b = s.indexOf('let mlPubLoopt = false;', a);
const c = s.indexOf('async function smalCf(url, body, tok)'), d = s.indexOf('\n}\n', c) + 3;
assert(a > 0 && b > a && c > 0 && d > c, 'knipsels niet gevonden');
assert(/const ML_KLUIS = \{[^}]*cloudflare_memorylane: true/.test(s), 'ML_KLUIS mist cloudflare_memorylane');
assert(/memorylanePubliek\.health\(\), \{ token: mlPubTokenSoort \}/.test(s), '/health mist token');
const code = s.slice(c, d) + '\n' + s.slice(a, b) + '\nthis.__o = __o; this.soort = function () { return mlPubTokenSoort; };';
let ok = 0;
async function geval(naam, kluis, env, verwacht) {
  const gezien = [];
  const ctx = { __o: null, __dirname: '/x', Buffer, process: { env: env }, path: require('path'), fs: { existsSync: () => true }, memorylaneDelen: {}, SERVER_ECHT: true,
    intake: { _db: {} }, VAULT: '/x', VV: () => ({}), HERINNERINGEN_DIR: '/x', HERINNERINGEN_MOD: { CATEGORIEEN: [] }, logError: () => {},
    SMAL_CF_BASIS: 'https://cf', SMAL_CF_ACCOUNT: 'acc', JSON, Error, Promise, AbortSignal: { timeout: () => null },
    mlKluis: async (n) => { assert.strictEqual(n, 'cloudflare_memorylane'); if (kluis instanceof Error) throw kluis; return kluis; },
    fetch: async (url, opt) => { gezien.push({ url, m: opt.method, auth: opt.headers.Authorization });
      return { ok: true, status: 200, json: async () => ({ success: true, result: [{ success: true, results: [] }] }), text: async () => '' }; } };
  ctx.require = function () { return { maak: function (o) { ctx.__o = o; return {}; } }; };
  vm.createContext(ctx); vm.runInContext(code.replace('this.__o = __o;', ''), ctx);
  const o = ctx.__o; assert(o && o.d1 && o.r2, naam + ': maak kreeg geen d1/r2');
  const uit = [];
  for (const [w, f] of [['d1', () => o.d1([{ sql: 'SELECT 1', params: [] }])], ['put', () => o.r2.put('f/familie/proef-1', Buffer.from('x'), 'text/plain')], ['del', () => o.r2.del('f/familie/proef-1')]]) {
    try { await f(); uit.push(w + ':ok'); } catch (e) { uit.push(w + ':' + e.message); }
  }
  assert.deepStrictEqual({ uit, auth: gezien.map((g) => g.auth), soort: ctx.soort() }, verwacht, naam);
  console.log('GROEN ' + naam); ok++;
}
(async () => {
  await geval('eigen token uit de kluis', 'EIGEN-verzonnen', { CLOUDFLARE_API_TOKEN: 'POD-verzonnen' },
    { uit: ['d1:ok', 'put:ok', 'del:ok'], auth: ['Bearer EIGEN-verzonnen', 'Bearer EIGEN-verzonnen', 'Bearer EIGEN-verzonnen'], soort: 'eigen' });
  await geval('rij ontbreekt: terugval pod-token', null, { CLOUDFLARE_API_TOKEN: 'POD-verzonnen' },
    { uit: ['d1:ok', 'put:ok', 'del:ok'], auth: ['Bearer POD-verzonnen', 'Bearer POD-verzonnen', 'Bearer POD-verzonnen'], soort: 'pod' });
  await geval('geen van beide: geen verzoek', null, {},
    { uit: ['d1:geen Cloudflare-sleutel', 'put:geen Cloudflare-sleutel', 'del:geen Cloudflare-sleutel'], auth: [], soort: null });
  await geval('kluisfout: geen terugval', new Error('kluis gaf HTTP 500'), { CLOUDFLARE_API_TOKEN: 'POD-verzonnen' },
    { uit: ['d1:kluis gaf HTTP 500', 'put:kluis gaf HTTP 500', 'del:kluis gaf HTTP 500'], auth: [], soort: null });
  console.log('GROEN ' + ok + '/4');
})().catch((e) => { console.log('ROOD ' + e.message); process.exit(1); });
JS
