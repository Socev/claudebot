// wv4155 (2C46): PMA › Naast elkaar — Tolgaarde naast Groenhouten per 1000 patiënten, per jaar, uit de VIP-aantallen in de datahub.
// Knipt het Praktijken-blok uit server.js (SERVER_JS = andere server.js voor de kruisproef) en draait appPraktijkenVerzamel met stubs.
// Alle cijfers hieronder zijn verzonnen; de handtelling rekent ze los na.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(__dirname, '..', 'server.js'), 'utf8');
const BLOK = SRC.slice(SRC.indexOf('// ── Praktijken (fase 6 rest, wv174'), SRC.indexOf('// ── App Financiën (wv771'));
const JAAR = Number(new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }).slice(0, 4));
const j = (x) => JSON.parse(JSON.stringify(x));

// verzonnen VIP-aantallen: [entiteit, jaar, tot, code, oms, cat, aantal]
const T = (jr, md) => jr + '-' + md;
const RIJEN = [];
const zet = (e, jr, tot, code, oms, cat, n) => RIJEN.push({ entiteit: e, jaar: jr, tot: T(jr, tot), code, oms, cat, aantal: n });
const ECG = { TG: [40, 55, 21], GH: [31, 62, 17] };          // per jaar JAAR-2, JAAR-1, JAAR
const PAT = { TG: [2000, 2100.5, 2050.25], GH: [1500, 1480, 1555.33] };
const TOT = { TG: ['12-31', '12-31', '08-12'], GH: ['12-31', '12-31', '08-11'] };
for (const e of ['TG', 'GH']) [0, 1, 2].forEach((i) => {
  const jr = JAAR - 2 + i, tot = TOT[e][i];
  zet(e, jr, tot, '13005', 'ECG-diagnostiek (ECG maken, interpreteren en bespreken met patiënt)', 'mi', ECG[e][i]);
  zet(e, jr, tot, '12011', 'Consult regulier vanaf 5 minuten en korter dan 20 minuten', 'consult', 1000 + i * 100 + (e === 'GH' ? 7 : 0));
  zet(e, jr, tot, '12010', 'Consult regulier korter dan 5 minuten', 'consult', 300 + i);
  zet(e, jr, tot, '12111', 'Consult praktijkondersteuner GGZ 20 minuten en langer', 'consult', 80 + i * 3);
  zet(e, jr, tot, '13004', 'Longfunctiemeting (= spirometrie)', 'mi', i === 0 ? 5 : 9);   // klein: geen verschil
  zet(e, jr, tot, '11115', 'Inschrijving verzekerden tot 65 jaar', 'ion', 7000);
});
zet('TG', JAAR - 3, '12-31', '13005', 'ECG', 'mi', 999);   // te oud: valt buiten de drie jaren
const PATRIJEN = [];
for (const e of ['TG', 'GH']) [0, 1, 2].forEach((i) => {
  const jr = JAAR - 2 + i, p = PAT[e][i];
  PATRIJEN.push({ entiteit: e, peildatum: jr + '-01-01', leeftijdsgroep: null, aantal: p });
  PATRIJEN.push({ entiteit: e, peildatum: jr + '-01-01', leeftijdsgroep: '<65', aantal: p * 0.8 });
  PATRIJEN.push({ entiteit: e, peildatum: jr + '-01-01', leeftijdsgroep: '85+', aantal: p * 0.05 });
});

function fin(sql, o) {
  if (o.weg && o.weg.test(sql)) return Promise.reject(new Error('fin http 500'));
  if (/d\.code, p\.omschrijving AS oms/.test(sql)) return Promise.resolve(RIJEN);
  if (/patienten WHERE soort='declaratie_kwartaalgemiddelde' AND entiteit IN/.test(sql) && /leeftijdsgroep, aantal/.test(sql)) return Promise.resolve(PATRIJEN);
  if (/FROM reeks WHERE versie='jaarrekening'/.test(sql)) return Promise.resolve([{ entiteit: 'TG', rubriek: 'omzet_totaal', jaar: JAAR - 1, bedrag: 1000000, bron_id: 1 }]);
  if (/FROM bron/.test(sql)) return Promise.resolve([{ id: 1, titel: 'Jaarrekening proef' }]);
  return Promise.resolve([]);
}
function laad(o) {
  o = o || {};
  const ctx = { console, Date, Math, Number, String, Object, Array, Set, Promise, JSON, isFinite, AbortSignal, Error, process: { env: {} }, appStaat: {}, logs: [],
    appKort: (s, n) => String(s == null ? '' : s).slice(0, n), appWeiger: () => {}, appStuur: () => {}, fetch: () => Promise.reject(new Error('geen netwerk')),
    appSbRpc: () => Promise.resolve([]), potDhD1: () => Promise.resolve([{ results: [] }]) };
  ctx.logError = (w, e) => ctx.logs.push(w + ': ' + (e && e.message));
  vm.createContext(ctx);
  vm.runInContext(BLOK + '\n;this.v = appPraktijkenVerzamel;', ctx);
  ctx.appFinSql = (sql) => { (ctx.sqls = ctx.sqls || []).push(sql); return fin(sql, o); };
  return ctx;
}
const per1000 = (n, p) => Math.round(n / p * 10000) / 10;

test('naast: ECG per 1000 voor beide praktijken en drie jaren sluit op de handtelling; lopend jaar t/m de exportdag', async () => {
  const c = laad();
  const d = j(await c.v());
  assert.ok(d.naast, 'veld naast');
  const n = d.naast;
  assert.deepStrictEqual(n.jaren, [JAAR - 2, JAAR - 1, JAAR]);
  assert.deepStrictEqual(n.kolommen.map((k) => k.code + k.jaar), ['TG', 'GH'].length && [JAAR - 2, JAAR - 1, JAAR].flatMap((jr) => ['TG' + jr, 'GH' + jr]));
  assert.strictEqual(n.label, 'VIP (toegezegd)');
  assert.deepStrictEqual(n.namen, { TG: 'Tolgaarde', GH: 'Groenhouten' });
  const ecg = n.groepen.find((g) => g.titel === 'M&I per soort').rijen.find((r) => r.codes[0] === '13005');
  assert.strictEqual(ecg.label, 'ECG-diagnostiek');
  let getoetst = 0;
  n.kolommen.forEach((k, i) => {
    const x = k.jaar - (JAAR - 2);
    assert.strictEqual(ecg.cellen[i].aantal, ECG[k.code][x]);
    assert.strictEqual(ecg.cellen[i].per1000, per1000(ECG[k.code][x], PAT[k.code][x]), k.code + ' ' + k.jaar);
    assert.strictEqual(k.tot, T(k.jaar, TOT[k.code][x]));
    assert.strictEqual(k.heel, TOT[k.code][x] === '12-31');
    assert.strictEqual(k.patienten, Math.round(PAT[k.code][x]));
    getoetst++;
  });
  assert.strictEqual(getoetst, 6);
  // handwaarden expliciet (verzonnen): TG JAAR-1 55 / 2100,5 = 26,2; GH JAAR 17 / 1555,33 = 10,9
  assert.strictEqual(ecg.cellen[2].per1000, 26.2);
  assert.strictEqual(ecg.cellen[5].per1000, 10.9);
});

test('naast: verschil alleen tussen twee hele jaren en niet bij kleine aantallen; lopend jaar zonder verschil', async () => {
  const n = j(await laad().v()).naast;
  const ecg = n.groepen.find((g) => g.titel === 'M&I per soort').rijen.find((r) => r.codes[0] === '13005');
  assert.strictEqual(ecg.cellen[0].verschil, undefined, 'eerste jaar: geen jaar ervoor');
  // TG JAAR-1 tegen JAAR-2: 26,2 / 20,0 → +31 %
  assert.strictEqual(ecg.cellen[2].verschil, Math.round((per1000(55, 2100.5) / per1000(40, 2000) - 1) * 1000) / 10);
  assert.strictEqual(ecg.cellen[4].verschil, undefined, 'lopend jaar TG: geen verschil');
  assert.strictEqual(ecg.cellen[5].verschil, undefined, 'lopend jaar GH: geen verschil');
  const long = n.groepen.find((g) => g.titel === 'M&I per soort').rijen.find((r) => r.codes[0] === '13004');
  assert.ok(long.cellen.every((c) => c.verschil === undefined), 'kleine aantallen: geen procent');
});

test('naast: groepen — consulten met samen, POH-GGZ, M&I met samen, leeftijdsopbouw als aandeel; inschrijving en lege soorten niet', async () => {
  const n = j(await laad().v()).naast;
  const titels = n.groepen.map((g) => g.titel);
  assert.deepStrictEqual(titels, ['Consulten huisarts (regulier)', 'POH-GGZ', 'M&I per soort', 'Leeftijdsopbouw']);
  const cons = n.groepen[0];
  assert.deepStrictEqual(cons.rijen.map((r) => r.label), ['korter dan 5 min', '5 tot 20 min', 'samen']);
  const samen = cons.rijen[2];
  assert.strictEqual(samen.cellen[1].aantal, 300 + 1007);
  assert.strictEqual(samen.cellen[1].per1000, per1000(1307, 1500));
  const mi = n.groepen[2];
  assert.deepStrictEqual(mi.rijen.map((r) => r.codes.join() || r.label), ['13004', '13005', 'samen']);
  const lft = n.groepen[3];
  assert.ok(lft.aandeel);
  assert.deepStrictEqual(lft.rijen.map((r) => r.label), ['jonger dan 65', '85 en ouder']);
  assert.strictEqual(lft.rijen[0].cellen[0].per1000, 800);
  assert.strictEqual(lft.rijen[1].cellen[3].per1000, 50);
  const t = JSON.stringify(n);
  assert.ok(!/11115|999/.test(t.replace(/"jaren".*?\]/, '')), 'inschrijving en het te oude jaar niet in de rijen');
});

test('naast: datahub-vraag faalt → naast null met één regel, de rest van Jaarcijfers blijft', async () => {
  const c = laad({ weg: /d\.code, p\.omschrijving AS oms/ });
  const d = j(await c.v());
  assert.strictEqual(d.naast, null);
  assert.ok(d.fouten.some((f) => /Naast elkaar/.test(f)));
  assert.ok(d.entiteiten.length > 0);
});

test('naast: de vraag pakt alleen de laatste export per entiteit en jaar, en alleen de laatste drie jaren', async () => {
  const c = laad();
  await c.v();
  const q = c.sqls.find((s) => /d\.code, p\.omschrijving AS oms/.test(s));
  assert.match(q, /MAX\(periode_tot\)/);
  assert.match(q, new RegExp('jaar >= ' + (JAAR - 2)));
  assert.match(q, /verzekeraar='totaal'/);
});
