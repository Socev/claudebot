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

function omgeving(open, pagina, dir) {
  const geroepen = [];
  const mod = { stateOpen: function (dir, s) { return s === open; }, terug: async function (deps, s, c, f) { geroepen.push({ s: s, c: c, f: f }); return { soort: 'gekoppeld' }; },
    ronde: async function () { return { ok: true, tools: 0 }; }, vaultBlok: function () { return '<!-- homey-fase:begin -->\nX\n<!-- homey-fase:einde -->'; },
    blokZet: function (p, b) { return /homey-fase:begin -->[\s\S]*homey-fase:begin/.test(p) ? null : p + '\n' + b; }, linkMaak: function () { return { url: 'x', geldig_tot: 'y' }; } };
  const ctx = { require: function (p) { if (/homey\.js$/.test(p)) return mod; return require(p); }, process: { env: { HOMEY_DIR: dir || '/tmp/homey-route-proef' } }, path: path, fs: fs,
    __dirname: '/x', reqPath: function (req) { return new URL(req.url, 'http://x').pathname; }, rolPrimair: function () { return true; },
    bankPagina: function (res, status, kop) { res.writeHead(status, {}); res.end(kop); }, schrijfLog: function () {}, nu: function () { return ''; }, velden: function () { return ''; },
    logError: function () {}, tibberMgmt: async function () { throw new Error('geen kluis in de toets'); }, smalKind: async function () { return { code: 0, stdout: '{}' }; },
    VV: function () { return { lees: function () { return ''; }, schrijf: function () {}, wijzig: function (p, fn) { const n = fn(pagina.tekst); if (n == null) return false; pagina.tekst = n; pagina.pad = p; return true; } }; }, VAULT: '/tmp', SERVER_ECHT: false, Date: Date, JSON: JSON, URL: URL, URLSearchParams: URLSearchParams, String: String, Error: Error };
  vm.createContext(ctx);
  vm.runInContext(BLOK + '\n;this.homeyTerug = homeyTerug; this.homeyIsPad = homeyIsPad; this.homeyVaultSchrijf = homeyVaultSchrijf;', ctx);
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
test('dagtabel (wv3462): één keer per dag, dwingen mag, half blok = niets en box', function () {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'homey-vault-'));
  const pagina = { tekst: '# Energie\n' };
  const o2 = omgeving(S, pagina, dir);
  const a = o2.ctx.homeyVaultSchrijf(true);
  assert.strictEqual(a.ok, true, JSON.stringify(a));
  assert.match(pagina.pad, /20_Prive\/Financien\/Energieverbruik thuis \(Tibber\)\.md$/);
  assert.match(pagina.tekst, /homey-fase:begin/);
  const b = o2.ctx.homeyVaultSchrijf(false);
  assert.strictEqual(b.ok, false); assert.match(b.fout, /vandaag al/);
  pagina.tekst += '\n<!-- homey-fase:begin -->\n';
  const c = o2.ctx.homeyVaultSchrijf(true);
  assert.strictEqual(c.ok, false); assert.match(c.fout, /markers/);
  fs.rmSync(dir, { recursive: true, force: true });
});
