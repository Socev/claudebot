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

function omgeving(open, pagina, dir, extra) {
  extra = extra || {};
  const geroepen = [];
  const mod = { stateOpen: function (dir, s) { return s === open; }, terug: async function (deps, s, c, f) { geroepen.push({ s: s, c: c, f: f }); return { soort: 'gekoppeld' }; },
    ronde: extra.ronde || async function () { return { ok: true, tools: 0 }; }, vaultBlok: function () { return '<!-- homey-fase:begin -->\nX\n<!-- homey-fase:einde -->'; },
    blokZet: function (p, b) { return /homey-fase:begin -->[\s\S]*homey-fase:begin/.test(p) ? null : p + '\n' + b; }, linkMaak: function () { return { url: 'x', geldig_tot: 'y' }; }, energieScherm: extra.energieScherm };
  const ctx = { require: function (p) { if (/homey\.js$/.test(p)) return mod; return require(p); }, process: { env: { HOMEY_DIR: dir || '/tmp/homey-route-proef' } }, path: path, fs: fs,
    __dirname: '/x', reqPath: function (req) { return new URL(req.url, 'http://x').pathname; }, rolPrimair: function () { return true; },
    bankPagina: function (res, status, kop) { res.writeHead(status, {}); res.end(kop); }, schrijfLog: function () {}, nu: function () { return ''; }, velden: function () { return ''; },
    logError: function (w, e) { if (process.env.TOETS_LOG) console.error(w, e); }, tibberMgmt: async function () { throw new Error('geen kluis in de toets'); }, smalKind: async function () { return { code: 0, stdout: '{}' }; },
    VV: function () { return { lees: function () { return extra.box ? extra.box.tekst : ''; }, schrijf: function (p, t) { if (extra.box) extra.box.tekst = t; }, wijzig: function (p, fn) { const n = fn(pagina.tekst); if (n == null) return false; pagina.tekst = n; pagina.pad = p; return true; } }; }, VAULT: '/tmp', SERVER_ECHT: false, Date: extra.Date || Date, JSON: JSON, URL: URL, URLSearchParams: URLSearchParams, String: String, Error: Error,
    // wv3586: App Energie
    setTimeout: setTimeout, appStaat: { tellers: {} }, appTeller: function () { return true; }, TIBBER_DIR: extra.tibberDir || '/tmp/homey-route-geen-tibber', tibberUurBezig: false,
    tibberUurScript: function () { return __filename; }, tibberUurDraai: extra.tibberUurDraai,
    appStuur: function (res, status, obj) { res.status = status; res.obj = obj; }, appWeiger: function (res, status, fout) { res.status = status; res.obj = { ok: false, fout: fout }; } };
  vm.createContext(ctx);
  vm.runInContext(BLOK + '\n;this.homeyTerug = homeyTerug; this.homeyIsPad = homeyIsPad; this.homeyVaultSchrijf = homeyVaultSchrijf; this.homeyTik = homeyTik; this.appEnergie = appEnergie; this.homeyNuBezigNu = function () { return homeyNuBezig; };' +
    ' this.homeyStand = function () { return { volgende: homeyVolgende, herpogingen: homeyHerpogingen, reeks: homeyMisReeks }; };', ctx);
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

test('wv3482: mislukte leesronde na 10 min opnieuw, hooguit 3 keer; gat pas na 3 op rij in de box, 1× per dag', async function () {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'homey-tik-'));
  fs.writeFileSync(path.join(dir, 'gekoppeld.json'), '{}');
  let klok = Date.parse('2026-11-20T17:00:00Z');
  class NepDate extends Date { constructor(...a) { if (a.length) super(...a); else super(klok); } static now() { return klok; } }
  const uitslagen = [], gestart = [];
  const box = { tekst: '# Box\n\n## [direct] 2026-11-20 08:00 — oud\n- status: open\n' };
  const o = omgeving(S, { tekst: '' }, dir, { Date: NepDate, box: box, ronde: async function (deps, soort) { gestart.push(klok); return uitslagen.shift() || { ok: true, minuten: 60 }; } });
  const tik = async function () { const p = o.ctx.homeyTik(); if (p) await p; };
  const MIN = 60000;
  // eerste ronde: gat
  uitslagen.push({ ok: false, reden: 'gat', fout: 'alle fasereeksen leeg' }, { ok: false, reden: 'gat', fout: 'x' }, { ok: false, reden: 'gat', fout: 'x' }, { ok: false, reden: 'gat', fout: 'x' });
  await tik();
  assert.strictEqual(gestart.length, 1);
  klok += 5 * MIN; await tik(); assert.strictEqual(gestart.length, 1, 'na 5 min nog niet');
  klok += 5 * MIN; await tik(); assert.strictEqual(gestart.length, 2, 'na 10 min herpoging 1');
  assert.ok(box.tekst.indexOf('homey-gat-') < 0, 'na 2 mislukkingen nog geen boxrij');
  klok += 10 * MIN; await tik(); assert.strictEqual(gestart.length, 3, 'herpoging 2');
  assert.strictEqual((box.tekst.match(/homey-gat-2026-11-20/g) || []).length, 1, 'na 3 op rij één boxrij');
  assert.match(box.tekst, /3 rondes op rij mislukt/);
  klok += 10 * MIN; await tik(); assert.strictEqual(gestart.length, 4, 'herpoging 3');
  assert.strictEqual((box.tekst.match(/homey-gat-2026-11-20/g) || []).length, 1, 'niet nog eens dezelfde dag');
  assert.strictEqual(o.ctx.homeyStand().reeks, 4);
  klok += 10 * MIN; await tik(); assert.strictEqual(gestart.length, 4, 'na 3 herpogingen terug op het uurritme');
  klok = Date.parse('2026-11-20T17:55:00Z') - 1; await tik(); assert.strictEqual(gestart.length, 4);
  klok += 1; await tik(); assert.strictEqual(gestart.length, 5, '55 min na de gewone poging');
  assert.strictEqual(o.ctx.homeyStand().reeks, 0, 'gelukt zet de reeks terug');
  klok += 10 * MIN; await tik(); assert.strictEqual(gestart.length, 5, 'na een gelukte ronde geen herpoging');
  // dode koppeling: geen herpoging
  klok += 45 * MIN; uitslagen.push({ ok: false, reden: 'dood', fout: 'koppeling dood' });
  await tik(); assert.strictEqual(gestart.length, 6);
  klok += 10 * MIN; await tik(); assert.strictEqual(gestart.length, 6, 'dood: niet na 10 min opnieuw');
  assert.strictEqual(o.ctx.homeyStand().reeks, 1, 'dood telt als mislukking');
  klok += 50 * MIN; await tik(); assert.strictEqual(gestart.length, 7); assert.strictEqual(o.ctx.homeyStand().reeks, 0);
  // netwerk: 2 keer mis en dan gelukt → geen boxrij voor netwerk
  klok += 55 * MIN; uitslagen.push({ ok: false, reden: 'netwerk', fout: 'n' }, { ok: false, reden: 'netwerk', fout: 'n' });
  await tik(); klok += 10 * MIN; await tik(); klok += 10 * MIN; await tik();
  assert.strictEqual(gestart.length, 10);
  assert.ok(box.tekst.indexOf('homey-netwerk-') < 0, 'twee netwerkfouten en dan gelukt: stil');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── wv3586: App Energie ──
const J = function (x) { return JSON.parse(JSON.stringify(x)); };   // vm-objecten hebben een ander prototype
function tibberProef(rijen) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'energie-tibber-'));
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(path.join(dir, 'tibber.sqlite'));
  d.exec('create table prijs(home_id text, van text, totaal real, energie real, belasting real, niveau text, primary key(home_id, van))');
  const q = d.prepare('insert into prijs values(?,?,?,?,?,?)');
  rijen.forEach(function (r) { q.run(r[3] || 'h1', r[0], r[1], null, null, r[2]); });
  d.close();
  return dir;
}
test('wv3586: GET /app/energie — scherm + prijzen vandaag/morgen; na 13:00 zonder morgen één extra Tibber-ronde per uur', async function () {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'energie-'));
  fs.writeFileSync(path.join(dir, 'gekoppeld.json'), '{}');
  let klok = Date.parse('2026-11-21T13:30:00Z');   // 14:30 NL
  class NepDate extends Date { constructor(...a) { if (a.length) super(...a); else super(klok); } static now() { return klok; } }
  const tdir = tibberProef([['2026-11-21T00:00:00.000+01:00', 0.33, 'NORMAL'], ['2026-11-21T14:00:00.000+01:00', 0.41, 'EXPENSIVE'], ['2026-11-20T23:00:00.000+01:00', 0.3, 'NORMAL'], ['2026-11-21T15:00:00.000+01:00', null, null], ['2026-11-21T01:00:00.000+01:00', 0.01, 'CHEAP', 'h0-oude-woning'], ['2026-11-01T01:00:00.000+01:00', 0.2, 'CHEAP', 'h0-oude-woning']]);
  const tibberRondes = [];
  const o = omgeving(S, { tekst: '' }, dir, { Date: NepDate, tibberDir: tdir, tibberUurDraai: async function (b) { tibberRondes.push(b); return { ok: true }; } });
  o.ctx.require = (function (oud) { return function (p) { const m = oud(p); if (/homey\.js$/.test(p)) m.energieScherm = function (d, iso) { return { dag: '2026-11-21', iso: iso, nu: null, dagen: [] }; }; return m; }; })(o.ctx.require);
  const scherm = function (d, iso) { return { dag: '2026-11-21', iso: iso, nu: null, dagen: [] }; };
  const o0 = omgeving(S, { tekst: '' }, dir, { Date: NepDate, tibberDir: tdir });
  const res0 = { _app: {} }; await o0.ctx.appEnergie({}, res0, {}, 'GET /app/energie', {});
  assert.strictEqual(res0.status, 404, 'homey.js zonder energieScherm: 404');
  const o2 = omgeving(S, { tekst: '' }, dir, { Date: NepDate, tibberDir: tdir, energieScherm: scherm, tibberUurDraai: async function (b) { tibberRondes.push(b); return { ok: true }; } });
  const res = { _app: {} }; await o2.ctx.appEnergie({}, res, {}, 'GET /app/energie', {});
  assert.strictEqual(res.status, 200, JSON.stringify(res.obj));
  assert.strictEqual(res.obj.ok, true); assert.strictEqual(res.obj.iso, '2026-11-21T13:30:00.000Z');
  assert.deepStrictEqual(J(res.obj.prijzen.vandaag).map(function (x) { return x.uur + ' ' + x.totaal + ' ' + x.niveau; }), ['00:00 0.33 NORMAL', '14:00 0.41 EXPENSIVE'], 'alleen vandaag, null-prijs weg');
  assert.deepStrictEqual(J(res.obj.prijzen.morgen), []);
  assert.strictEqual(res.obj.prijzen.morgen_gevraagd, true); assert.deepStrictEqual(tibberRondes, ['energie-app']);
  assert.strictEqual(res.obj.koppeling.gekoppeld, true); assert.strictEqual(res._app.stil, true);
  const resB = { _app: {} }; await o2.ctx.appEnergie({}, resB, {}, 'GET /app/energie', {});
  assert.strictEqual(resB.obj.prijzen.morgen_gevraagd, false, 'binnen het uur niet nog eens'); assert.strictEqual(tibberRondes.length, 1);
  klok += 61 * 60000; const resC = { _app: {} }; await o2.ctx.appEnergie({}, resC, {}, 'GET /app/energie', {});
  assert.strictEqual(tibberRondes.length, 2, 'na een uur wel');
  klok = Date.parse('2026-11-21T10:00:00Z'); const o3 = omgeving(S, { tekst: '' }, dir, { Date: NepDate, tibberDir: tdir, energieScherm: scherm, tibberUurDraai: async function (b) { tibberRondes.push(b); return { ok: true }; } });
  const resD = { _app: {} }; await o3.ctx.appEnergie({}, resD, {}, 'GET /app/energie', {});
  assert.strictEqual(resD.obj.prijzen.morgen_gevraagd, false, 'vóór 13:00 niet'); assert.strictEqual(tibberRondes.length, 2);
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(tdir, { recursive: true, force: true });
});
test('wv3586: POST /app/energie/nu — ronde soort nu, hooguit één per 30 s, uurronde wacht', async function () {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'energie-nu-'));
  fs.writeFileSync(path.join(dir, 'gekoppeld.json'), '{}');
  let klok = Date.parse('2026-11-21T16:00:00Z');
  class NepDate extends Date { constructor(...a) { if (a.length) super(...a); else super(klok); } static now() { return klok; } }
  const soorten = []; let los = null;
  const o = omgeving(S, { tekst: '' }, dir, { Date: NepDate, ronde: function (deps, soort) { soorten.push(soort); if (soort === 'nu') return new Promise(function (r) { los = r; }); return Promise.resolve({ ok: true }); }, energieScherm: function () { return { nu: null, dagen: [] }; } });
  const res = { _app: {} }; const p = o.ctx.appEnergie({}, res, {}, 'POST /app/energie/nu', {});
  await new Promise(function (r) { setImmediate(r); });
  assert.deepStrictEqual(soorten, ['nu']);
  assert.ok(o.ctx.homeyNuBezigNu(), 'momentopname loopt');
  klok += 60 * 60000; const t = o.ctx.homeyTik(); if (t) await t;
  assert.deepStrictEqual(soorten, ['nu'], 'uurronde start niet tijdens een momentopname');
  klok -= 60 * 60000;
  los({ ok: true, soort: 'nu' }); await p;
  assert.strictEqual(res.status, 200); assert.deepStrictEqual(J(res.obj.meting), { ok: true, reden: null }); assert.strictEqual(res._app.stil, true);
  const res2 = { _app: {} }; await o.ctx.appEnergie({}, res2, {}, 'POST /app/energie/nu', {});
  assert.deepStrictEqual(J(res2.obj.meting), { ok: true, reden: 'kort' }, 'binnen 30 s geen tweede'); assert.strictEqual(soorten.length, 1);
  klok += 31000; const res3 = { _app: {} }; const p3 = o.ctx.appEnergie({}, res3, {}, 'POST /app/energie/nu', {});
  await new Promise(function (r) { setImmediate(r); }); los({ ok: false, reden: 'netwerk' }); await p3;
  assert.deepStrictEqual(J(res3.obj.meting), { ok: false, reden: 'netwerk' }); assert.strictEqual(res3._app.reden, 'energie nu netwerk');
  fs.rmSync(dir, { recursive: true, force: true });
});
