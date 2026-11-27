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
    beleggenApp: o.beleggenApp || null, SERVER_ECHT: false, setInterval: setInterval,   // wv3815
    vastgoedApp: o.vastgoedApp || null,   // wv4228: de teller van Vastgoed (aantal nieuw sinds Davids vorige bezoek)
    ovisAms: o.ovisAms || function () { return { datum: '2026-11-22', uur: 6, min: 50, klok: '2026-11-22 06:50' }; },
    schrijfLog: function (r) { (o.log || []).push(r); }, nu: function () { return 'NU'; },
    appN8nZend: o.zend || function () { throw new Error('geen n8n in de toets'); }, APP_MELD_TABEL: 'TABEL',
    berichtIntern: o.stuur || function () { throw new Error('geen bericht in de toets'); },
  };
  vm.createContext(ctx);
  vm.runInContext(SRV.slice(i, j) + '\nthis.__x = { loketSchaduw, loketMeld, loketTellersVerversen, appNieuwsRoute, appNieuwsTellersRoute, appNieuwsGezienRoute, appNieuwsSchaduwRoute, appNieuwsInfo, appNieuwsInstelRoute, loketOchtendEditie, loketAvondTik, loketOvergang, loketPakjesMeld, keten: function () { return appNieuwsKeten; } };', ctx);
  return { x: ctx.__x, dir: dir, fouten: fouten, antwoorden: antwoorden };
}
const nepRes = function () { return { _app: {} }; };
// wv3882: serverblok-toetsen draaien met de echte klok (Date.now()); vaste datums vervielen na een dag (tijdbom, rood op main sinds 24-11)
const VANDAAG = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
test('serverblok: schaduw schrijft de regel, routes tonen hem, gezien haalt hem weg, tellers uit de bronnen', async function () {
  const b = laadBlok({
    facturenRoutes: { rolVoor: function () { return { soort: 'eigenaar' }; }, app: function (fdb, v) { assert.strictEqual(v.pad, '/app/facturen'); return { status: 200, j: { ok: true, tellers: { beoordelen: 3, signalen: 2, wachtrij: 9 } } }; } },
    pakjes: { lijst: function () { return { status: 200, body: { ok: true, lopend: [{ stand: 'vandaag' }, { stand: 'onderweg' }] } }; } },
    beleggenApp: { app: function (v) { assert.strictEqual(v.pad, '/app/beleggen/teller'); return { status: 200, body: { ok: true, totaal: 4 } }; } },
    vastgoedApp: { nieuwAantal: function () { return 2; } },
  });
  b.x.loketSchaduw('geld', VANDAAG, 'Verzonnen geldregel.');
  b.x.loketSchaduw('onbekend', VANDAAG, 'x');   // onbekende bron: gelogd, niets geschreven, geen gooi
  await b.x.keten();
  const s = JSON.parse(fs.readFileSync(path.join(b.dir, 'app-nieuws.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(s.regels), ['financien/geld']);
  assert.strictEqual(s.regels['financien/geld'].taalmodel, false);
  assert.strictEqual(s.regels['financien/geld'].buffer, 'geld');
  assert.strictEqual((fs.statSync(path.join(b.dir, 'app-nieuws.json')).mode & 0o777).toString(8), '600');
  assert.strictEqual(b.fouten.length, 1);
  await b.x.appNieuwsTellersRoute({ url: '/app/nieuws/tellers' }, nepRes(), { id: 'a1' });
  assert.deepStrictEqual(b.antwoorden.pop(), [200, { ok: true, tellers: { facturen: 5, pakjes: 1, beleggen: 4, vastgoed: 2 }, fout: null }]);
  await b.x.appNieuwsRoute({ url: '/app/nieuws' }, nepRes(), { id: 'a1' });
  let a = b.antwoorden.pop();
  assert.strictEqual(a[0], 200);
  assert.deepStrictEqual(a[1].regels.map(function (r) { return r.sleutel; }).sort(), ['beleggen/open', 'facturen/te-doen', 'financien/geld', 'pakjes/vandaag', 'vastgoed/nieuw']);
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

// ── wv3815 fase 2: edities, schuif ──
const DAG22 = Date.parse('2026-11-22T05:00:00Z');   // 06:00 Amsterdam
function metRegels() {
  let s = AN.leeg();
  s = AN.meld(s, { app: 'proef', onderwerp: 'a', laan: 'editie', datum: '2026-11-22', tekst: 'Verzonnen regel A.' }, DAG22).staat;
  s = AN.meld(s, { app: 'pakjes', onderwerp: 'b', laan: 'editie', datum: '2026-11-22', editie: 'ochtend', tekst: 'Verzonnen pakje.' }, DAG22).staat;
  s = AN.meld(s, { app: 'facturen', onderwerp: 'c', laan: 'editie', datum: '2026-11-22', editie: 'avond', tekst: 'Verzonnen factuurregel.' }, DAG22).staat;
  s = AN.meld(s, { app: 'socev', onderwerp: 'weer', laan: 'editie', datum: '2026-11-22', editie: 'ochtend', tekst: 'Verzonnen weer.', buffer: 'weer' }, DAG22).staat;
  s = AN.meld(s, { app: 'proef', onderwerp: 'morgen', laan: 'editie', datum: '2026-11-23', tekst: 'Pas morgen.' }, DAG22).staat;
  return s;
}
test('editieRegels: geen bufferbronnen, editie past, datum ≤ dag, schuif uit = niet, na markeren niet opnieuw tot de inhoud verandert', function () {
  let s = metRegels();
  const sl = function (l) { return l.map(function (r) { return r.sleutel; }); };
  assert.deepStrictEqual(sl(AN.editieRegels(s, 'ochtend', '2026-11-22', DAG22 + 1)), ['pakjes/b', 'proef/a']);
  assert.deepStrictEqual(sl(AN.editieRegels(s, 'avond', '2026-11-22', DAG22 + 1)), ['facturen/c', 'proef/a']);
  s = AN.instelZet(s, 'pakjes', { editie: false }).staat;
  assert.deepStrictEqual(sl(AN.editieRegels(s, 'ochtend', '2026-11-22', DAG22 + 1)), ['proef/a']);
  s = AN.editieMarkeer(s, 'ochtend', '2026-11-22', AN.editieRegels(s, 'ochtend', '2026-11-22', DAG22 + 1), DAG22 + 2).staat;
  assert.deepStrictEqual(sl(AN.editieRegels(s, 'avond', '2026-11-22', DAG22 + 3)), ['facturen/c'], 'proef/a stond al in de ochtend');
  s = AN.meld(s, { app: 'proef', onderwerp: 'a', laan: 'editie', datum: '2026-11-22', tekst: 'Verzonnen regel A, bijgewerkt.' }, DAG22 + 4).staat;
  assert.deepStrictEqual(sl(AN.editieRegels(s, 'avond', '2026-11-22', DAG22 + 5)), ['facturen/c', 'proef/a'], 'nieuwe inhoud komt opnieuw');
  s = AN.gezien(s, [{ sleutel: 'facturen/c', versie: 1 }], DAG22 + 6).staat;
  assert.deepStrictEqual(sl(AN.editieRegels(s, 'avond', '2026-11-22', DAG22 + 7)), ['proef/a'], 'gezien = uit de editie');
  assert.strictEqual(s.edities.ochtend.dag, '2026-11-22');
  assert.throws(function () { AN.editieRegels(s, 'middag', '2026-11-22', DAG22); });
});
test('editieTekst: één regel per App-regel; te veel = slotregel met het aantal in het paneel, de rest niet gemarkeerd', function () {
  const r = function (i) { return { sleutel: 'proef/r' + i, versie: 1, app: 'proef', tekst: 'Regel ' + i + ' ' + 'x'.repeat(90) }; };
  const e1 = AN.editieTekst([r(1), r(2)]);
  assert.strictEqual(e1.tekst.split('\n').length, 2); assert.ok(e1.tekst.indexOf('• Proef: Regel 1') === 0); assert.strictEqual(e1.over, 0);
  const veel = []; for (let i = 0; i < 60; i++) veel.push(r(i));
  const e2 = AN.editieTekst(veel);
  assert.ok(e2.tekst.length <= AN.EDITIE_MAX, 'binnen de grens');
  assert.ok(e2.over > 0 && e2.mee.length + e2.over === 60);
  assert.ok(/en nog \d+ in Overzicht › Nieuw in je Apps$/.test(e2.tekst));
});
test('avondMoment: alleen 20:30–22:29, nooit in de stille uren, één keer per dag', function () {
  const s = AN.leeg();
  assert.strictEqual(AN.avondMoment('20:29', '2026-11-22', s), false);
  assert.strictEqual(AN.avondMoment('20:30', '2026-11-22', s), true);
  assert.strictEqual(AN.avondMoment('22:29', '2026-11-22', s), true);
  assert.strictEqual(AN.avondMoment('22:30', '2026-11-22', s), false);
  assert.strictEqual(AN.avondMoment('23:15', '2026-11-22', s), false);
  assert.strictEqual(AN.avondMoment('06:50', '2026-11-22', s), false);
  const m = AN.editieMarkeer(s, 'avond', '2026-11-22', [], DAG22).staat;
  assert.strictEqual(AN.avondMoment('21:00', '2026-11-22', m), false);
  assert.strictEqual(AN.avondMoment('21:00', '2026-11-23', m), true);
});
test('instelZet: alleen aan/uit, onbekend veld telt niet, ongeldige app gooit', function () {
  let u = AN.instelZet(AN.leeg(), 'beleggen', { teller: false });
  assert.deepStrictEqual(u.instel, { teller: false });
  u = AN.instelZet(u.staat, 'beleggen', { bundel: false });
  assert.deepStrictEqual(u.instel, { teller: false, bundel: false });
  assert.throws(function () { AN.instelZet(u.staat, 'beleggen', { teller: 'nee' }); });
  assert.throws(function () { AN.instelZet(u.staat, 'Kapot/pad', { teller: true }); });
  assert.throws(function () { AN.instelZet(u.staat, 'beleggen', { iets: true }); });
});
const klok = function (d, u, m) { return { datum: d, uur: u, min: m, klok: d + ' ' + u + ':' + m }; };
test('serverblok: ochtendeditie zet één rij bron apps (teruggelezen) en markeert; geen regels = geen rij; na 07:00 niets', async function () {
  const aanroepen = [];
  let rij = null;
  const zend = function (m, p, body) {
    aanroepen.push([m, p]);
    if (m === 'POST') { rij = body.data; return Promise.resolve({}); }
    return Promise.resolve({ data: rij ? [rij] : [] });
  };
  const b = laadBlok({ zend: zend, ovisAms: function () { return klok(VANDAAG, 6, 50); } });
  let u = await b.x.loketOchtendEditie({ datum: VANDAAG });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(u)), { ok: true, detail: { regels: 0 } }); assert.strictEqual(aanroepen.length, 0, 'geen regels = geen rij');
  await b.x.loketMeld({ app: 'proef', onderwerp: 'a', laan: 'editie', datum: VANDAAG, tekst: 'Verzonnen ochtendregel.' });
  await b.x.loketMeld({ app: 'socev', onderwerp: 'weer', laan: 'editie', datum: VANDAAG, editie: 'ochtend', tekst: 'Verzonnen weer.', buffer: 'weer' });
  u = await b.x.loketOchtendEditie({ datum: VANDAAG });
  assert.strictEqual(u.detail.regels, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rij)), { bron: 'apps', datum: VANDAAG, tekst: '• Proef: Verzonnen ochtendregel.' });
  const s = JSON.parse(fs.readFileSync(path.join(b.dir, 'app-nieuws.json'), 'utf8'));
  assert.deepStrictEqual(s.edities.verschenen, { 'proef/a': 1 });
  const b2 = laadBlok({ zend: zend, ovisAms: function () { return klok(VANDAAG, 7, 5); } });
  u = await b2.x.loketOchtendEditie({ datum: VANDAAG });
  assert.strictEqual(u.al_gedaan, true); assert.strictEqual(u.detail.te_laat, true);
});
test('serverblok: avondeditie met nepklok — dag zonder nieuws = geen bericht; met nieuws één bericht, daarna niet nog eens; buiten het venster niets', async function () {
  const berichten = [], log = [];
  const stuur = function (d) { berichten.push(d); return Promise.resolve({ status: 200, j: { ok: true } }); };
  const b = laadBlok({ stuur: stuur, log: log });
  let u = await b.x.loketAvondTik({ proef: true, ams: klok('2026-11-22', 20, 35), stuur: stuur });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(u)), { regels: 0, bericht: false }); assert.strictEqual(berichten.length, 0, 'dag zonder nieuws: geen avondeditie');
  u = await b.x.loketAvondTik({ proef: true, ams: klok('2026-11-22', 21, 0), stuur: stuur });
  assert.strictEqual(u, null, 'die avond al gedaan');
  await b.x.loketMeld({ app: 'facturen', onderwerp: 'c', laan: 'editie', datum: '2026-11-23', editie: 'avond', tekst: 'Verzonnen avondregel.' });
  u = await b.x.loketAvondTik({ proef: true, ams: klok('2026-11-23', 23, 10), stuur: stuur });
  assert.strictEqual(u, null, 'stille uren: niets'); assert.strictEqual(berichten.length, 0);
  u = await b.x.loketAvondTik({ proef: true, ams: klok('2026-11-23', 20, 30), stuur: stuur });
  assert.strictEqual(u.bericht, true); assert.strictEqual(berichten.length, 1);
  assert.strictEqual(berichten[0].bron, 'apps-avond'); assert.strictEqual(berichten[0].kanaal, 'hoofd'); assert.strictEqual(berichten[0].soort, 'dag');
  assert.strictEqual(berichten[0].tekst, '📬 Uit je Apps (avond)\n\n• Facturen: Verzonnen avondregel.');
  u = await b.x.loketAvondTik({ proef: true, ams: klok('2026-11-23', 20, 35), stuur: stuur });
  assert.strictEqual(u, null); assert.strictEqual(berichten.length, 1, 'niet twee keer');
  const n = await b.x.loketAvondTik({ ams: klok('2026-11-24', 20, 35), stuur: stuur });
  assert.strictEqual(n, null, 'zonder proef en niet echt: niets');
});
test('serverblok: schuif-route zet instel, schuif teller uit = geen getal', async function () {
  const b = laadBlok({});
  await b.x.loketMeld({ app: 'pakjes', onderwerp: 'vandaag', laan: 'teller', aantal: 2 });
  await b.x.appNieuwsInstelRoute({}, nepRes(), { id: 'a' }, { app: 'pakjes', teller: false });
  assert.deepStrictEqual(b.antwoorden.pop(), [200, { ok: true, app: 'pakjes', instel: { teller: false } }]);
  await b.x.appNieuwsRoute({ url: '/app/nieuws' }, nepRes(), { id: 'a' });
  const a = b.antwoorden.pop()[1];
  assert.deepStrictEqual(a.tellers, {}); assert.deepStrictEqual(a.instel, { pakjes: { teller: false } });
  await b.x.appNieuwsInstelRoute({}, nepRes(), { id: 'a' }, { app: 'pakjes', teller: 'x' });
  assert.strictEqual(b.antwoorden.pop()[0], 400);
});

// ── fase 3 (wv3882): overgang zonder gat, Pakjes, Beleggen-weekbericht, Dienstwaarschuwer via /nieuws/meld ──
test('fase 3: ooit na editie of gezien; overgezet alleen met schuif aan (Codex MOET 1); opruim houdt ooit 60 dagen', function () {
  let s = AN.meld(AN.leeg(), { app: 'beleggen', onderwerp: 'week', laan: 'editie', editie: 'eerstvolgende', datum: '2026-11-22', tekst: 'Verzonnen week.' }, T0).staat;
  assert.strictEqual(AN.ooit(s, 'beleggen/week'), null); assert.strictEqual(AN.overgezet(s, 'beleggen/week'), false, 'nog nooit in een editie');
  const r = AN.editieRegels(s, 'avond', '2026-11-22', T0);
  s = AN.editieMarkeer(s, 'avond', '2026-11-22', [], T0).staat;
  assert.strictEqual(AN.ooit(s, 'beleggen/week'), null, 'lege markering zet niets');
  s = AN.editieMarkeer(s, 'avond', '2026-11-22', r, T0).staat;
  assert.strictEqual(AN.ooit(s, 'beleggen/week'), '2026-11-22'); assert.strictEqual(AN.overgezet(s, 'beleggen/week'), true);
  s = AN.instelZet(s, 'beleggen', { editie: false }).staat;
  assert.strictEqual(AN.overgezet(s, 'beleggen/week'), false, 'schuif uit = de oude weg komt terug');
  s = AN.instelZet(s, 'beleggen', { editie: true }).staat;
  assert.strictEqual(AN.overgezet(s, 'beleggen/week'), true);
  // gezien in het paneel telt ook (anders blijft de overgang hangen als David vóór 20:30 kijkt)
  let g = AN.meld(AN.leeg(), { app: 'kalender', onderwerp: 'diensten', laan: 'editie', editie: 'ochtend', datum: '2026-11-25', tekst: 'Verzonnen diensten.' }, T0).staat;
  g = AN.gezien(g, [{ sleutel: 'kalender/diensten', versie: 1 }], T0 + UUR).staat;
  assert.strictEqual(AN.ooit(g, 'kalender/diensten'), '2026-11-21');
  // de regel vervalt en wordt opgeruimd; ooit blijft tot 60 dagen
  s = AN.opruim(s, T0 + 20 * DAG).staat;
  assert.strictEqual(s.regels['beleggen/week'], undefined, 'regel opgeruimd');
  assert.strictEqual(AN.ooit(s, 'beleggen/week'), '2026-11-22', 'ooit blijft');
  s = AN.opruim(s, Date.parse('2027-01-22T12:00:00Z')).staat;
  assert.strictEqual(AN.ooit(s, 'beleggen/week'), null, 'na 60 dagen zonder regel weg');
});
test('fase 3: Pakjes — ochtend vandaag + afhaal, avond alleen afhaal, gelijk = geen herhaling, leeg = regel uit het paneel', function () {
  const nu = Date.parse('2026-11-25T05:50:00Z');
  const body = { lopend: [{ stand: 'vandaag', winkel: 'Verzonnen Winkel' }, { stand: 'vandaag', omschrijving: 'Boek' }, { stand: 'afhaalpunt', winkel: 'Nepshop' },
    { stand: 'vandaag', winkel: 'Verborgen', verborgen: true }, { stand: 'onderweg', winkel: 'Later' }] };
  let ms = AN.pakjesAanmeldingen(AN.leeg(), body, 'ochtend', '2026-11-25', nu);
  assert.deepStrictEqual(ms.map(function (m) { return [m.onderwerp, m.editie, m.tekst, m.doel.scherm]; }), [
    ['vandaag', 'ochtend', 'Vandaag verwacht: Verzonnen Winkel, Boek.', 'pakjes'], ['afhaal', 'eerstvolgende', 'Ligt klaar bij een afhaalpunt: Nepshop.', 'pakjes']]);
  assert.strictEqual(ms[0].vervalt, '2026-11-25T22:59:59.000Z', 'vervalt einde vandaag (Amsterdam)');
  let s = AN.leeg();
  ms.forEach(function (m) { s = AN.meld(s, m, nu).staat; });
  const rs = AN.editieRegels(s, 'ochtend', '2026-11-25', nu);
  assert.strictEqual(rs.length, 2);
  s = AN.editieMarkeer(s, 'ochtend', '2026-11-25', rs, nu).staat;
  ms = AN.pakjesAanmeldingen(s, body, 'avond', '2026-11-25', nu + 14 * UUR);
  assert.deepStrictEqual(ms.map(function (m) { return m.onderwerp; }), ['afhaal'], 'avond: alleen afhaal');
  assert.strictEqual(AN.meld(s, ms[0], nu + 14 * UUR).uitkomst, 'gelijk', 'zelfde tekst = niet opnieuw');
  assert.strictEqual(AN.editieRegels(s, 'avond', '2026-11-25', nu + 14 * UUR).length, 0, 'stond al in de ochtend');
  // afgehaald: lege lijst → afhaal-regel uit het paneel
  ms = AN.pakjesAanmeldingen(s, { lopend: [] }, 'avond', '2026-11-25', nu + 15 * UUR);
  assert.strictEqual(ms.length, 1); s = AN.meld(s, ms[0], nu + 15 * UUR).staat;
  assert.strictEqual(AN.lijst(s, { app: 'pakjes' }, nu + 15 * UUR + 1).map(function (r) { return r.onderwerp; }).join(), 'vandaag', 'afhaal weg, vandaag blijft');
  assert.strictEqual(AN.pakjesAanmeldingen(s, { lopend: [] }, 'avond', '2026-11-25', nu + 16 * UUR).length, 0, 'niet nog eens');
  // veel pakjes: max 8 namen
  const veel = { lopend: Array.from({ length: 11 }, function (x, i) { return { stand: 'vandaag', winkel: 'W' + i }; }) };
  assert.match(AN.pakjesAanmeldingen(AN.leeg(), veel, 'ochtend', '2026-11-25', nu)[0].tekst, /W7 en 3 meer\.$/);
  assert.throws(function () { AN.pakjesAanmeldingen(AN.leeg(), body, 'middag', '2026-11-25', nu); });
});
test('fase 3 serverblok: loketOvergang eerst niet overgezet, na de editie wel; fout = niet overgezet; pakjes vóór de editie', async function () {
  const berichten = [];
  const stuur = function (d) { berichten.push(d); return Promise.resolve({ status: 200, j: { ok: true } }); };
  let rij = null;
  const zend = function (m, p, body) { if (m === 'POST') { rij = body.data; return Promise.resolve({}); } return Promise.resolve({ data: rij ? [rij] : [] }); };
  const b = laadBlok({ stuur: stuur, zend: zend, ovisAms: function () { return klok(VANDAAG, 6, 50); },
    pakjes: { lijst: function () { return { status: 200, body: { ok: true, lopend: [{ stand: 'afhaalpunt', winkel: 'Nepshop' }] } }; } } });
  const m = { app: 'kalender', onderwerp: 'diensten', laan: 'editie', editie: 'ochtend', datum: VANDAAG, tekst: 'Verzonnen diensten.', doel: { scherm: 'kalender' } };
  let l = await b.x.loketOvergang(m);
  assert.strictEqual(l.overgezet, false, 'eerste keer: oude bericht gaat ook');
  const u = await b.x.loketOchtendEditie({ datum: VANDAAG });
  assert.strictEqual(u.detail.regels, 2);
  assert.strictEqual(rij.tekst, '• Kalender: Verzonnen diensten.\n• Pakjes: Ligt klaar bij een afhaalpunt: Nepshop.');
  l = await b.x.loketOvergang(Object.assign({}, m, { datum: VANDAAG, tekst: 'Verzonnen diensten week 2.' }));
  assert.strictEqual(l.overgezet, true, 'na de editie: alleen het loket');
  l = await b.x.loketOvergang({ app: 'Kapot', onderwerp: 'x', laan: 'editie', datum: VANDAAG, tekst: 'x' });
  assert.strictEqual(l.overgezet, false); assert.ok(b.fouten.some(function (f) { return /app-nieuws-overgang/.test(f); }), 'fout gelogd');
  // pakjeslijst kapot: editie gaat door zonder pakjes
  const b2 = laadBlok({ zend: zend, ovisAms: function () { return klok(VANDAAG, 6, 50); }, pakjes: { lijst: function () { throw new Error('kapot'); } } });
  await b2.x.loketMeld({ app: 'proef', onderwerp: 'a', laan: 'editie', datum: VANDAAG, tekst: 'Verzonnen.' });
  const u2 = await b2.x.loketOchtendEditie({ datum: VANDAAG });
  assert.strictEqual(u2.detail.regels, 1); assert.ok(b2.fouten.some(function (f) { return /app-nieuws-pakjes/.test(f); }));
  // avond: pakjes-afhaal vlak vóór de avondeditie
  const b3 = laadBlok({ stuur: stuur, pakjes: { lijst: function () { return { status: 200, body: { ok: true, lopend: [{ stand: 'afhaalpunt', winkel: 'Nepshop' }, { stand: 'vandaag', winkel: 'Niet s avonds' }] } }; } } });
  const a = await b3.x.loketAvondTik({ proef: true, ams: klok(VANDAAG, 20, 30), stuur: stuur });
  assert.strictEqual(a.bericht, true);
  assert.strictEqual(berichten.pop().tekst, '📬 Uit je Apps (avond)\n\n• Pakjes: Ligt klaar bij een afhaalpunt: Nepshop.');
});
test('fase 3 bedrading: Beleggen-weekbericht eerst het loket, oude bericht alleen als niet overgezet; /nieuws/meld geeft ooit en overgezet', function () {
  const i = SRV.indexOf("bron: 'beleggen-week'");
  const stuk = SRV.slice(SRV.lastIndexOf('bericht: async function (tekst, sleutel)', i), i);
  assert.match(stuk, /loketOvergang\(\{ app: 'beleggen', onderwerp: 'week', laan: 'editie', editie: 'eerstvolgende', datum: ovisAms\(\)\.datum, tekst: tekst/);
  assert.match(stuk, /if \(l\.overgezet\) return \{ ok: true, loket: true \};/);
  const r = SRV.slice(SRV.indexOf("req.url === '/nieuws/meld'"), SRV.indexOf("req.url === '/heartbeat/moment'"));
  assert.match(r, /ooit: o, overgezet: oz/);
});

// ── wv4200 (3C164): laan bezoek = stip op de tegel + strook "Nieuw hier sinds je vorige bezoek" ──
test('wv4200: bouwrapport wordt één regel app/gebouwd; nieuwste boven, hooguit twee; na zien alleen de nieuwe', function () {
  let s = AN.leeg();
  s = AN.meld(s, AN.bezoekAanmelding(s, 'proef', 'Tabblad Verzonnen erbij.', T0), T0).staat;
  s = AN.meld(s, AN.bezoekAanmelding(s, 'proef', 'Knop Probeer verzonnen.', T0 + UUR), T0 + UUR).staat;
  s = AN.meld(s, AN.bezoekAanmelding(s, 'proef', 'Derde verzonnen wijziging.', T0 + 2 * UUR), T0 + 2 * UUR).staat;
  let l = AN.lijst(s, { laan: 'bezoek', ongezien: true }, T0 + 2 * UUR);
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].sleutel, 'proef/gebouwd');
  assert.strictEqual(l[0].tekst, 'Derde verzonnen wijziging.\nKnop Probeer verzonnen.');
  assert.deepStrictEqual(l[0].doel, { scherm: 'proef' });
  s = AN.gezien(s, [{ sleutel: 'proef/gebouwd', versie: l[0].versie }], T0 + 3 * UUR).staat;
  assert.strictEqual(AN.lijst(s, { laan: 'bezoek', ongezien: true }, T0 + 3 * UUR).length, 0, 'App geopend = weg');
  s = AN.meld(s, AN.bezoekAanmelding(s, 'proef', 'Vierde verzonnen wijziging.', T0 + 4 * UUR), T0 + 4 * UUR).staat;
  l = AN.lijst(s, { laan: 'bezoek', ongezien: true }, T0 + 4 * UUR);
  assert.strictEqual(l[0].tekst, 'Vierde verzonnen wijziging.', 'wat David al zag komt niet terug');
});
test('wv4200: laan bezoek niet in editie, teller of paneel-laan; zelfde uitkomst nog eens = geen nieuwe stip', function () {
  let s = AN.leeg();
  s = AN.meld(s, AN.bezoekAanmelding(s, 'proef', 'Verzonnen.', T0), T0).staat;
  assert.deepStrictEqual(AN.tellers(s, T0 + 1), {});
  assert.strictEqual(AN.editieRegels(s, 'ochtend', '2026-11-22', T0 + 1).length, 0);
  assert.strictEqual(AN.editieRegels(s, 'avond', '2026-11-22', T0 + 1).length, 0);
  const v = AN.lijst(s, {}, T0)[0].versie;
  s = AN.gezien(s, [{ sleutel: 'proef/gebouwd', versie: v }], T0 + 2).staat;
  const u = AN.meld(s, AN.bezoekAanmelding(s, 'proef', 'Verzonnen.', T0 + 3), T0 + 3);
  assert.ok(AN.lijst(u.staat, {}, T0 + 3)[0].gezien_op, 'dubbel rapport: gezien blijft');
  assert.throws(function () { AN.bezoekAanmelding(s, 'Fout App', 'x x x', T0); });
  assert.throws(function () { AN.bezoekAanmelding(s, 'proef', '  ', T0); });
  assert.strictEqual(AN.lijst(AN.meld(AN.leeg(), AN.bezoekAanmelding(AN.leeg(), 'proef', 'Verzonnen.', T0), T0).staat, { ongezien: true }, T0 + 31 * DAG).length, 0, 'vervalt na 30 dagen');
});
test('wv4200: server.js meldt alleen een gelukt app-rapport bij het loket', function () {
  assert.ok(/if \(goed && appDoel && !appDoel\.mislukt\) loketBezoek\(appDoel\.id, tekst, regel\.slot\)/.test(SRV));
  assert.ok(/function loketBezoek\(app, tekst, slot\)[\s\S]{0,300}slot\.merk === 'mislukt'\) return/.test(SRV));
});
test('wv4200 review MOET 2: twee regels gezien, nieuwste uitkomst nog eens = blijft gezien en ongewijzigd', function () {
  let s = AN.leeg();
  s = AN.meld(s, AN.bezoekAanmelding(s, 'proef', 'Eerste verzonnen.', T0), T0).staat;
  s = AN.meld(s, AN.bezoekAanmelding(s, 'proef', 'Tweede verzonnen.', T0 + 1), T0 + 1).staat;
  const r = AN.lijst(s, {}, T0 + 2)[0];
  assert.strictEqual(r.tekst, 'Tweede verzonnen.\nEerste verzonnen.');
  s = AN.gezien(s, [{ sleutel: 'proef/gebouwd', versie: r.versie }], T0 + 3).staat;
  const u = AN.meld(s, AN.bezoekAanmelding(s, 'proef', 'Tweede verzonnen.', T0 + UUR), T0 + UUR);
  assert.strictEqual(u.uitkomst, 'gelijk');
  const na = AN.lijst(u.staat, {}, T0 + UUR)[0];
  assert.ok(na.gezien_op); assert.strictEqual(na.tekst, r.tekst); assert.strictEqual(na.versie, r.versie);
  // ongezien en herhaald: ook gelijk (geen nieuwe versie)
  let s2 = AN.meld(AN.leeg(), AN.bezoekAanmelding(AN.leeg(), 'proef', 'A verzonnen.', T0), T0).staat;
  s2 = AN.meld(s2, AN.bezoekAanmelding(s2, 'proef', 'B verzonnen.', T0 + 1), T0 + 1).staat;
  assert.strictEqual(AN.meld(s2, AN.bezoekAanmelding(s2, 'proef', 'B verzonnen.', T0 + 2), T0 + 2).uitkomst, 'gelijk');
});
