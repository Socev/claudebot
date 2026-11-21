'use strict';
// wv3689 (2C59): redactie-loket app-nieuws.js en de bedrading in server.js. Alle toetsdata verzonnen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const wortel = path.join(__dirname, '..');
const AN = require(path.join(wortel, 'app-nieuws.js'));
const SRV = fs.readFileSync(path.join(wortel, 'server.js'), 'utf8');

const T0 = Date.parse('2026-11-21T18:00:00Z');
const UUR = 3600000, DAG = 86400000;

test('proef-App: regel verschijnt, gelijk = geen herhaling, verdwijnt na zien', function () {
  let s = AN.leeg();
  let u = AN.meld(s, { app: 'proef', onderwerp: 'eerste', laan: 'editie', datum: '2026-11-22', tekst: 'Proefregel uit een verzonnen App.' }, T0);
  assert.strictEqual(u.uitkomst, 'nieuw'); s = u.staat;
  assert.strictEqual(AN.lijst(s, { ongezien: true }, T0 + 1).length, 1);
  u = AN.meld(s, { app: 'proef', onderwerp: 'eerste', laan: 'editie', datum: '2026-11-22', tekst: 'Proefregel uit een verzonnen App.' }, T0 + UUR);
  assert.strictEqual(u.uitkomst, 'gelijk'); assert.strictEqual(u.versie, 1);
  const r = AN.lijst(s, {}, T0 + UUR)[0];
  assert.strictEqual(r.sleutel, 'proef/eerste'); assert.strictEqual(r.editie, 'eerstvolgende');
  s = AN.gezien(s, [{ sleutel: 'proef/eerste', versie: 1 }], T0 + 2 * UUR).staat;
  assert.strictEqual(AN.lijst(s, { ongezien: true }, T0 + 2 * UUR).length, 0, 'na zien weg uit de ongeziene lijst');
  assert.strictEqual(AN.lijst(s, {}, T0 + 2 * UUR).length, 1, 'met alles=1 nog te zien');
});

test('bijwerken: inhoud anders = opnieuw ongezien; alleen meta anders = gezien blijft (MOET 1); oude versie zet nieuwere niet weg', function () {
  let s = AN.meld(AN.leeg(), { app: 'proef', onderwerp: 'x', laan: 'editie', datum: '2026-11-22', tekst: 'a' }, T0).staat;
  s = AN.gezien(s, [{ sleutel: 'proef/x', versie: 1 }], T0 + 1).staat;
  let u = AN.meld(s, { app: 'proef', onderwerp: 'x', laan: 'editie', datum: '2026-11-22', tekst: 'a', doel: { scherm: 'pakjes' } }, T0 + 2);
  assert.strictEqual(u.uitkomst, 'bijgewerkt'); assert.strictEqual(u.versie, 2);
  assert.ok(u.staat.regels['proef/x'].gezien_op, 'meta: gezien blijft');
  u = AN.meld(u.staat, { app: 'proef', onderwerp: 'x', laan: 'editie', datum: '2026-11-22', tekst: 'b', doel: { scherm: 'pakjes' } }, T0 + 3);
  assert.strictEqual(u.versie, 3); assert.strictEqual(u.staat.regels['proef/x'].gezien_op, null, 'inhoud: weer ongezien');
  const g = AN.gezien(u.staat, [{ sleutel: 'proef/x', versie: 2 }], T0 + 4);
  assert.strictEqual(g.gezet, 0); assert.strictEqual(g.staat.regels['proef/x'].gezien_op, null);
  assert.strictEqual(AN.meld(g.staat, { app: 'proef', onderwerp: 'x', laan: 'editie', datum: '2026-11-22', tekst: 'b', doel: { scherm: 'pakjes' }, taalmodel: true }, T0 + 5).uitkomst, 'bijgewerkt', 'taalmodel telt mee');
});

test('nooit inkorten of stil weglaten: ongeldige invoer gooit', function () {
  const s = AN.leeg();
  const lang = 'x'.repeat(AN.MAX_TEKST + 1);
  assert.throws(function () { AN.meld(s, { app: 'proef', onderwerp: 'x', laan: 'editie', datum: '2026-11-22', tekst: lang }, T0); }, /te lang/);
  assert.throws(function () { AN.meld(s, { app: 'Proef', onderwerp: 'x', laan: 'editie', datum: '2026-11-22', tekst: 'a' }, T0); }, /app/);
  assert.throws(function () { AN.meld(s, { app: 'proef', onderwerp: '../x', laan: 'editie', datum: '2026-11-22', tekst: 'a' }, T0); }, /onderwerp/);
  assert.throws(function () { AN.meld(s, { app: 'proef', onderwerp: 'x', laan: 'editie', tekst: 'a' }, T0); }, /datum/);
  assert.throws(function () { AN.meld(s, { app: 'proef', onderwerp: 'x', laan: 'teller', aantal: 1.5 }, T0); }, /geheel/);
  assert.throws(function () { AN.meld(s, { app: 'proef', onderwerp: 'x', laan: 'teller', aantal: 2, buffer: 'mail' }, T0); }, /buffer/);
  assert.deepStrictEqual(Object.keys(s.regels), []);
});

test('teller: som per App, 0 = weg, schuif uit = geen getal', function () {
  let s = AN.meld(AN.leeg(), { app: 'pakjes', onderwerp: 'vandaag', laan: 'teller', aantal: 2 }, T0).staat;
  s = AN.meld(s, { app: 'pakjes', onderwerp: 'afhaal', laan: 'teller', aantal: 1 }, T0).staat;
  s = AN.meld(s, { app: 'facturen', onderwerp: 'te-doen', laan: 'teller', aantal: 7 }, T0).staat;
  assert.deepStrictEqual(AN.tellers(s, T0), { pakjes: 3, facturen: 7 });
  const u = AN.meld(s, { app: 'pakjes', onderwerp: 'afhaal', laan: 'teller', aantal: 0 }, T0);
  assert.strictEqual(u.uitkomst, 'weg'); s = u.staat;
  s.instel.facturen = { teller: false };
  assert.deepStrictEqual(AN.tellers(s, T0), { pakjes: 2 });
});

test('vervallen en opruimen: editie leeft t/m de dag erna; geziene zonder vervaldatum 30 dagen; ongeziene levende nooit (MOET 2)', function () {
  let s = AN.meld(AN.leeg(), { app: 'socev', onderwerp: 'weer', laan: 'editie', datum: '2026-11-22', tekst: 'Regen bij vertrek.' }, T0).staat;
  assert.strictEqual(s.regels['socev/weer'].vervalt, '2026-11-23T22:59:59.000Z');
  assert.strictEqual(AN.lijst(s, {}, Date.parse('2026-11-23T22:00:00Z')).length, 1);
  assert.strictEqual(AN.lijst(s, {}, Date.parse('2026-11-23T23:00:00Z')).length, 0);
  s = AN.meld(s, { app: 'proef', onderwerp: 'kaart1', laan: 'kaart', tekst: 'Een kaart.' }, T0).staat;
  s = AN.meld(s, { app: 'proef', onderwerp: 'kaart2', laan: 'kaart', tekst: 'Nog een kaart.' }, T0).staat;
  s = AN.gezien(s, [{ sleutel: 'proef/kaart1', versie: 1 }], T0).staat;
  const o = AN.opruim(s, T0 + 40 * DAG);
  assert.deepStrictEqual(Object.keys(o.staat.regels).sort(), ['proef/kaart2'], 'weer (14 d na vervallen) en geziene kaart (30 d) weg, ongeziene kaart blijft');
});

test('grens telt alleen ongeziene regels (MOET 2)', function () {
  let s = AN.leeg();
  for (let i = 0; i < AN.MAX_ONGEZIEN; i++) s.regels['proef/k' + i] = { app: 'proef', onderwerp: 'k' + i, laan: 'kaart', tekst: 't', versie: 1, gezien_op: null, vervalt: null, bijgewerkt: '2026-11-21T00:00:00.000Z' };
  assert.throws(function () { AN.meld(s, { app: 'proef', onderwerp: 'nieuw', laan: 'kaart', tekst: 't' }, T0); }, /vol/);
  s = AN.gezien(s, [{ sleutel: 'proef/k0', versie: 1 }], T0).staat;
  assert.strictEqual(AN.meld(s, { app: 'proef', onderwerp: 'nieuw', laan: 'kaart', tekst: 't' }, T0).uitkomst, 'nieuw');
});

test('pakjesVandaag = vandaagTeller van de app (src/pakjes.ts)', function () {
  const l = { lopend: [{ stand: 'vandaag' }, { stand: 'afhaalpunt' }, { stand: 'vandaag', verborgen: true }, { stand: 'onderweg' }, null], eerder: [{ stand: 'vandaag' }] };
  assert.strictEqual(AN.pakjesVandaag(l), 2);
  assert.strictEqual(AN.pakjesVandaag(null), 0);
});

// ── gelijke uitvoer: de generieke bufferZet doet voor elk van de zes bronnen exact dezelfde HTTP-aanroepen als de oude kopie ──
function knipFunctie(naam) {
  const i = SRV.indexOf('async function ' + naam + '(');
  assert.ok(i >= 0, naam + ' gevonden');
  const j = SRV.indexOf('\n}\n', i);
  return SRV.slice(i, j + 2);
}
function knipRegel(begin) { const i = SRV.indexOf(begin); assert.ok(i >= 0, begin); return SRV.slice(i, SRV.indexOf('\n', i) + 1); }
function nepZend(bron, datum, tekst, eersteFaalt) {
  const calls = [];
  let n = 0;
  const zend = async function (m, p, body) {
    calls.push([m, p, body === undefined ? null : JSON.parse(JSON.stringify(body))]);
    if (m === 'POST' && eersteFaalt && n++ === 0) throw new Error('nep 503');
    if (m === 'GET') return { data: [{ bron: bron, datum: datum, tekst: tekst }] };
    return {};
  };
  return { zend: zend, calls: calls };
}
const OUD = [
  ['mailSluitOchtend', 'mail', ['const MAIL_SLUIT_FILTER = ']],
  ['weerRijZet', 'weer', ['const WEER_FILTER = ']],
  ['crRijZet', 'contactringen', ['const CR_FILTER = ']],
  ['promedicoRijZet', 'promedico', ['const PB_FILTER = ']],
  ['appBriefingCorrectieRij', 'briefing_correctie', ['const BRIEFING_CORRECTIE_FILTER = ']],
  ['geldRijZet', 'geld', ['const GELD_FILTER = '], ['geldRijLees']],
];
for (const [fn, bron, consts, extra] of OUD) {
  for (const faalt of [false, true]) {
    test('gelijke uitvoer ' + bron + (faalt ? ' (eerste poging faalt)' : ''), async function () {
      const datum = '2026-11-22', tekst = 'Verzonnen regel voor ' + bron + ' * met "tekens" & zo.';
      const oud = nepZend(bron, datum, tekst, faalt), nieuw = nepZend(bron, datum, tekst, faalt);
      const schaduw = [];
      const ctx = { appN8nZend: oud.zend, APP_MELD_TABEL: 'TABELNEP', loketSchaduw: function () { schaduw.push([].slice.call(arguments)); },
        setTimeout: function (f) { return setTimeout(f, 1); }, Promise: Promise, JSON: JSON, encodeURIComponent: encodeURIComponent, Array: Array, String: String, Error: Error };
      vm.createContext(ctx);
      vm.runInContext(consts.map(knipRegel).join('') + (extra || []).map(knipFunctie).join('\n') + knipFunctie(fn) + '\nthis.__f = ' + fn + ';', ctx);
      await ctx.__f(datum, tekst);
      await AN.bufferZet(nieuw.zend, 'TABELNEP', bron, datum, tekst, function () { return Promise.resolve(); });
      assert.deepStrictEqual(nieuw.calls, oud.calls);
      assert.deepStrictEqual(schaduw, [[bron, datum, tekst]], 'oude schrijver meldt na teruglezen bij het loket');
    });
  }
}
test('oude schrijver: teruglezen mislukt = geen schaduwregel', async function () {
  const schaduw = [];
  const ctx = { appN8nZend: async function (m) { return m === 'GET' ? { data: [] } : {}; }, APP_MELD_TABEL: 'T', loketSchaduw: function () { schaduw.push(1); },
    setTimeout: setTimeout, Promise: Promise, JSON: JSON, encodeURIComponent: encodeURIComponent, Array: Array, String: String, Error: Error };
  vm.createContext(ctx);
  vm.runInContext(knipRegel('const WEER_FILTER = ') + knipFunctie('weerRijZet') + '\nthis.__f = weerRijZet;', ctx);
  await assert.rejects(ctx.__f('2026-11-22', 'x'), /teruggelezen/);
  assert.strictEqual(schaduw.length, 0);
});

// ── het serverblok in een vm: schaduw, tellers, routes ──
function laadBlok(o) {
  const i = SRV.indexOf('// ── wv3689 (besluitenpagina nr 159 = 2C59');
  const j = SRV.indexOf('\n// ── fase 5a: tabs Agents en Bestanden');
  assert.ok(i > 0 && j > i, 'blok gevonden');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv3689-'));
  const fouten = [], antwoorden = [];
  const ctx = {
    require: require, path: path, fs: fs, console: console, Promise: Promise, JSON: JSON, Date: Date, Number: Number, String: String, Object: Object, Array: Array, URL: URL, URLSearchParams: URLSearchParams,
    __dirname: wortel, APP_DATA: dir,
    appLeesStreng: function (p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return d; throw e; } },
    appSchrijfJson: function (p, x) { fs.writeFileSync(p, JSON.stringify(x)); },
    logError: function (w, e) { fouten.push(w + ': ' + (e && e.message)); },
    appStaat: { tellers: {} }, appTeller: function () { return true; },
    appWeiger: function (res, c, m) { antwoorden.push([c, { ok: false, fout: m }]); },
    appStuur: function (res, c, j) { antwoorden.push([c, JSON.parse(JSON.stringify(j))]); },   // andere vm-realm: prototypes gelijk trekken
    facturenRoutes: o.facturenRoutes, facturenOpen: function () { return {}; }, rolPrimair: function () { return true; },
    pakjes: o.pakjes, pakjesGekocht: function () { return []; }, pakjesOnderwerpen: function () { return {}; },
  };
  vm.createContext(ctx);
  vm.runInContext(SRV.slice(i, j) + '\nthis.__x = { loketSchaduw, loketMeld, loketTellersVerversen, appNieuwsRoute, appNieuwsTellersRoute, appNieuwsGezienRoute, appNieuwsSchaduwRoute, appNieuwsInfo, keten: function () { return appNieuwsKeten; } };', ctx);
  return { x: ctx.__x, dir: dir, fouten: fouten, antwoorden: antwoorden };
}
const nepRes = function () { return { _app: {} }; };
test('serverblok: schaduw schrijft de regel, routes tonen hem, gezien haalt hem weg, tellers uit de bronnen', async function () {
  const b = laadBlok({
    facturenRoutes: { rolVoor: function () { return { soort: 'eigenaar' }; }, app: function (fdb, v) { assert.strictEqual(v.pad, '/app/facturen'); return { status: 200, j: { ok: true, tellers: { beoordelen: 3, signalen: 2, wachtrij: 9 } } }; } },
    pakjes: { lijst: function () { return { status: 200, body: { ok: true, lopend: [{ stand: 'vandaag' }, { stand: 'onderweg' }] } }; } },
  });
  b.x.loketSchaduw('geld', '2026-11-22', 'Verzonnen geldregel.');
  b.x.loketSchaduw('onbekend', '2026-11-22', 'x');   // onbekende bron: gelogd, niets geschreven, geen gooi
  await b.x.keten();
  const s = JSON.parse(fs.readFileSync(path.join(b.dir, 'app-nieuws.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(s.regels), ['financien/geld']);
  assert.strictEqual(s.regels['financien/geld'].taalmodel, false);
  assert.strictEqual(s.regels['financien/geld'].buffer, 'geld');
  assert.strictEqual((fs.statSync(path.join(b.dir, 'app-nieuws.json')).mode & 0o777).toString(8), '600');
  assert.strictEqual(b.fouten.length, 1);
  await b.x.appNieuwsTellersRoute({ url: '/app/nieuws/tellers' }, nepRes(), { id: 'a1' });
  assert.deepStrictEqual(b.antwoorden.pop(), [200, { ok: true, tellers: { facturen: 5, pakjes: 1 }, fout: null }]);
  await b.x.appNieuwsRoute({ url: '/app/nieuws' }, nepRes(), { id: 'a1' });
  let a = b.antwoorden.pop();
  assert.strictEqual(a[0], 200);
  assert.deepStrictEqual(a[1].regels.map(function (r) { return r.sleutel; }).sort(), ['facturen/te-doen', 'financien/geld', 'pakjes/vandaag']);
  await b.x.appNieuwsGezienRoute({}, nepRes(), { id: 'a1' }, { sleutels: [{ sleutel: 'financien/geld', versie: 1 }] });
  assert.deepStrictEqual(b.antwoorden.pop(), [200, { ok: true, gezet: 1 }]);
  await b.x.appNieuwsRoute({ url: '/app/nieuws' }, nepRes(), { id: 'a1' });
  a = b.antwoorden.pop();
  assert.ok(!a[1].regels.some(function (r) { return r.sleutel === 'financien/geld'; }), 'na zien weg');
  await b.x.appNieuwsGezienRoute({}, nepRes(), { id: 'a1' }, { sleutels: 'kapot' });
  assert.strictEqual(b.antwoorden.pop()[0], 400);
  await b.x.appNieuwsSchaduwRoute({}, nepRes(), { id: 'a1' }, { app: 'pakjes', oud: 1, nieuw: 1 });
  await b.x.appNieuwsSchaduwRoute({}, nepRes(), { id: 'a1' }, { app: 'facturen', oud: 4, nieuw: 5 });
  assert.deepStrictEqual(b.antwoorden.slice(-2).map(function (x) { return x[1].gelijk; }), [true, false]);
  const info = b.x.appNieuwsInfo();
  assert.strictEqual(info.aan, true); assert.strictEqual(info.schaduw_fout, 1);
});
test('serverblok: bron niet leesbaar = oude regel blijft, fout gemeld, geen verzonnen 0', async function () {
  let n = 2;
  const b = laadBlok({ facturenRoutes: null, pakjes: { lijst: function () { if (n === null) throw new Error('nep stuk'); return { body: { lopend: Array(n).fill({ stand: 'vandaag' }) } }; } } });
  await b.x.loketTellersVerversen({ id: 'a' });
  n = null;
  await b.x.appNieuwsTellersRoute({ url: '/' }, nepRes(), { id: 'a' });   // binnen 60 s: geen nieuwe telling
  assert.deepStrictEqual(b.antwoorden.pop()[1].tellers, { pakjes: 2 });
});
