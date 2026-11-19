'use strict';
// Toetst de Homey-terugkeer in server.js (wv3460) los: het blok wordt uit server.js geknipt en in een vm gedraaid met nepdeps.
// form_post (POST + formulier) en GET komen bij terug(); zonder open state, met vreemde content-type of te grote body: 404 zonder kluis.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm'), { Readable } = require('stream');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const begin = SRC.indexOf('// ── wv3460: Homey (Athom MCP, alleen lezen)'), eind = SRC.indexOf('// ── wv2707: Tibber-uurverbruik dagelijks bij');
assert.ok(begin > 0 && eind > begin);
const BLOK = SRC.slice(begin, eind);

function omgeving(open) {
  const geroepen = [];
  const mod = { stateOpen: function (dir, s) { return s === open; }, terug: async function (deps, s, c, f) { geroepen.push({ s: s, c: c, f: f }); return { soort: 'gekoppeld' }; },
    ronde: async function () { return { ok: true, tools: 0 }; }, linkMaak: function () { return { url: 'x', geldig_tot: 'y' }; } };
  const ctx = { require: function (p) { if (/homey\.js$/.test(p)) return mod; return require(p); }, process: { env: { HOMEY_DIR: '/tmp/homey-route-proef' } }, path: path, fs: fs,
    __dirname: '/x', reqPath: function (req) { return new URL(req.url, 'http://x').pathname; }, rolPrimair: function () { return true; },
    bankPagina: function (res, status, kop) { res.writeHead(status, {}); res.end(kop); }, schrijfLog: function () {}, nu: function () { return ''; }, velden: function () { return ''; },
    logError: function () {}, tibberMgmt: async function () { throw new Error('geen kluis in de toets'); }, smalKind: async function () { return { code: 0, stdout: '{}' }; },
    VV: function () { return { lees: function () { return ''; }, schrijf: function () {} }; }, VAULT: '/tmp', Date: Date, JSON: JSON, URL: URL, URLSearchParams: URLSearchParams, String: String, Error: Error };
  vm.createContext(ctx);
  vm.runInContext(BLOK + '\n;this.homeyTerug = homeyTerug; this.homeyIsPad = homeyIsPad;', ctx);
  return { ctx: ctx, geroepen: geroepen };
}
function verzoek(methode, url, body, type) {
  const r = Readable.from(body ? [Buffer.from(body)] : []);
  r.method = methode; r.url = url; r.headers = type ? { 'content-type': type } : {};
  return r;
}
function antwoord() {
  return new Promise(function (resolve) {
    const res = { headersSent: false, status: null, writeHead: function (s) { this.status = s; this.headersSent = true; }, end: function (b) { resolve({ status: this.status, body: String(b || '') }); } };
    res._klaar = resolve;
    antwoord.res = res;
  });
}
const S = 'c'.repeat(64);

test('POST form_post met open state → terug() met code', async function () {
  const o = omgeving(S); const p = antwoord();
  o.ctx.homeyTerug(verzoek('POST', '/homey/terug', 'code=proefcode-9&state=' + S, 'application/x-www-form-urlencoded'), antwoord.res);
  const r = await p;
  assert.strictEqual(r.status, 200); assert.match(r.body, /Gekoppeld/);
  assert.deepStrictEqual(o.geroepen.map(function (g) { return g.c; }), ['proefcode-9']);
});
test('GET met query werkt ook', async function () {
  const o = omgeving(S); const p = antwoord();
  o.ctx.homeyTerug(verzoek('GET', '/homey/terug?code=proefcode-8&state=' + S), antwoord.res);
  assert.strictEqual((await p).status, 200);
  assert.strictEqual(o.geroepen.length, 1);
});
test('onbekende state, verkeerde content-type, te grote body, andere methode: 404 zonder terug()', async function () {
  for (const [m, u, b, t] of [['POST', '/homey/terug', 'code=x&state=' + 'd'.repeat(64), 'application/x-www-form-urlencoded'],
    ['POST', '/homey/terug', JSON.stringify({ code: 'x', state: S }), 'application/json'],
    ['POST', '/homey/terug', 'code=x&state=' + S + '&p=' + 'z'.repeat(9000), 'application/x-www-form-urlencoded'],
    ['PUT', '/homey/terug', 'code=x&state=' + S, 'application/x-www-form-urlencoded'],
    ['GET', '/homey/terug?state=' + S]]) {
    const o = omgeving(S); const p = antwoord();
    o.ctx.homeyTerug(verzoek(m, u, b, t), antwoord.res);
    assert.strictEqual((await p).status, 404, m + ' ' + (t || ''));
    assert.strictEqual(o.geroepen.length, 0);
  }
});
test('homeyIsPad alleen het exacte pad', function () {
  const o = omgeving(S);
  assert.ok(o.ctx.homeyIsPad({ url: '/homey/terug?x=1' }));
  assert.ok(!o.ctx.homeyIsPad({ url: '/homey/terug/x' }));
  assert.ok(!o.ctx.homeyIsPad({ url: '/HOMEY/terug' }));
});
