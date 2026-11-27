// wv4216 (besluitenpagina nr 928 = L28): PMA › Jaarcijfers — Tolgaarde berekend: eigen volume × tarief van volgend jaar, en de groei
// gesplitst in tarief, werk en nieuwe codes. Knipt het Praktijken-blok uit server.js (SERVER_JS = andere server.js voor de kruisproef) en
// draait appPraktijkenVerzamel met stubs. Alle cijfers hieronder zijn verzonnen en met de hand uitgerekend.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(__dirname, '..', 'server.js'), 'utf8');
const BLOK = SRC.slice(SRC.indexOf('// ── Praktijken (fase 6 rest, wv174'), SRC.indexOf('// ── App Financiën (wv771'));
const J = Number(new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }).slice(0, 4));
const j = (x) => JSON.parse(JSON.stringify(x));

// lopend jaar J t/m 30-6: dagen en kwartalen met de hand
const DAGEN = Math.round((Date.UTC(J, 5, 30) - Date.UTC(J, 0, 1)) / 864e5) + 1;
const JAARDAGEN = Math.round((Date.UTC(J + 1, 0, 1) - Date.UTC(J, 0, 1)) / 864e5);
// [jaar, tot, code, oms, cat, aantal, gedeclareerd]
const R = [
  [J - 2, '12-31', '12011', 'Consult regulier vanaf 5 minuten', 'consult', 1000, 10000],
  [J - 2, '12-31', '11115', 'Inschrijving verzekerden tot 65 jaar', 'ion', 4000, 80000],
  [J - 1, '12-31', '12011', 'Consult regulier vanaf 5 minuten', 'consult', 1100, 11550],
  [J - 1, '12-31', '11115', 'Inschrijving verzekerden tot 65 jaar', 'ion', 4400, 92400],
  [J - 1, '12-31', '13005', 'ECG-diagnostiek (ECG maken)', 'mi', 50, 3000],
  [J - 1, '12-31', '31080', 'POH-S', 'module', 4400, 13200],
  [J - 1, '12-31', '13050', 'Meer tijd voor de patiënt', 'module', 4400, 8800],
  [J - 1, '12-31', '30121', 'Resultaatbeloning', 'module', 4400, 4400],
  [J - 1, '12-31', '12850', 'SMR gedragsmatige ondersteuning', 'consult', 10, 1000],
  [J - 1, '12-31', '11201', 'Opslag praktijkondersteuner GGZ', 'module', 4400, 17600],
  [J - 1, '12-31', '12501', 'Consult militair', 'consult', 0, 0],
  [J - 1, '12-31', '31174', 'Praktijkmanagement', 'module', 4400, 5500],
  [J - 1, '12-31', '13038', 'Euthanasie', 'mi', 2, 600],
  [J, '06-30', '12011', 'Consult regulier vanaf 5 minuten', 'consult', 600, 6600],
  [J, '06-30', '11115', 'Inschrijving verzekerden tot 65 jaar', 'ion', 2300, 50600],
  [J, '06-30', '13005', 'ECG-diagnostiek (ECG maken)', 'mi', 20, 1240],
  [J, '06-30', '31080', 'POH-S', 'module', 2300, 6900],
  [J, '06-30', '13050', 'Meer tijd voor de patiënt', 'module', 2300, 4830],
  [J, '06-30', '30121', 'Resultaatbeloning', 'module', 2300, 2300],
  [J, '06-30', '11201', 'Opslag praktijkondersteuner GGZ', 'module', 2300, 9200],
  [J, '06-30', '13051', 'Meedenkadvies', 'mi', 30, 600],
  [J, '06-30', '31174', 'Praktijkmanagement', 'module', 2300, 2875],
].map(([jaar, t, code, oms, cat, aantal, gedeclareerd]) => ({ entiteit: 'TG', jaar, tot: jaar + '-' + t, code, oms, cat, aantal, gedeclareerd }))
  .concat([{ entiteit: 'GH', jaar: J - 1, tot: (J - 1) + '-12-31', code: '12011', oms: 'x', cat: 'consult', aantal: 999, gedeclareerd: 9990 }]);
const PAT = [[J - 2, null, 1000], [J - 1, null, 1100], [J - 1, '<65', 1100], [J, null, 1150], [J, '<65', 1150], [J, '85+', 3]]
  .map(([jr, g, a]) => ({ entiteit: 'TG', peildatum: jr + '-01-01', leeftijdsgroep: g, aantal: a }));
const L = (code, jr, tarief, niveau) => ({ code, soort: 'zk_gecontracteerd', entiteit: null, geldig_van: jr + '-01-01', geldig_tot: jr + '-12-31', tarief, niveau: niveau || null });
const TAR = [
  L('12011', J, 11), L('11115', J, 22), L('13005', J, 62), L('13050', J, 2.1), L('13051', J, 20), L('12850', J, 100), L('11201', J, 5.4),
  L('12011', J + 1, 12), L('11115', J + 1, 23), L('13005', J + 1, 65), L('13050', J + 1, 2.2), L('13051', J + 1, 21), L('11201', J + 1, 5.6),
  L('30121', J + 1, 0.5, 'niveau 1'), L('30121', J + 1, 1.1, 'niveau 2'),
  L('31174', J, 1.25), L('31174', J + 1, 1.3), L('13038', J + 1, 330),   // 31174: lijst = wat TG nu krijgt, maar TG heeft een eigen contract (alleen J)
  { code: '31174', soort: 'zk_module_contract', entiteit: 'TG', geldig_van: J + '-01-01', geldig_tot: J + '-12-31', tarief: 1.25, niveau: null },
  { code: '31080', soort: 'zk_module_contract', entiteit: 'TG', geldig_van: J + '-01-01', geldig_tot: (J + 1) + '-12-31', tarief: 3.5, niveau: null },
  { code: '31080', soort: 'zk_module_contract', entiteit: 'TG', geldig_van: (J - 1) + '-01-01', geldig_tot: (J - 1) + '-12-31', tarief: 3, niveau: null },
];

function fin(sql, o) {
  if (o.weg && o.weg.test(sql)) return Promise.reject(new Error('fin http 500'));
  if (/d\.code, p\.omschrijving AS oms/.test(sql)) return Promise.resolve(o.rijen || R);
  if (/patienten WHERE soort='declaratie_kwartaalgemiddelde' AND entiteit IN/.test(sql) && /leeftijdsgroep, aantal/.test(sql)) return Promise.resolve(PAT);
  if (/FROM tarief WHERE/.test(sql)) return Promise.resolve(o.tar || TAR);
  if (/FROM reeks WHERE versie='jaarrekening'/.test(sql)) return Promise.resolve([{ entiteit: 'TG', rubriek: 'omzet_totaal', jaar: J - 1, bedrag: 1000000, bron_id: 1 }]);
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
const tg = (d) => d.toekomst.find((t) => t.code === 'TG');
const rond = Math.round;

test('berekend: doeljaar = volgend jaar, basis = het laatste hele jaar, patiëntenstand van dit jaar', async () => {
  const t = tg(j(await laad().v()));
  assert.strictEqual(t.soort, 'berekend');
  const b = t.berekend;
  assert.strictEqual(b.doel, J + 1);
  assert.strictEqual(b.basis, J - 1);
  assert.strictEqual(b.patienten_jaar, J);
  assert.strictEqual(b.patienten, 1150);
  assert.strictEqual(b.label, 'berekend, geen model');
});

test('berekend: per code met de hand — aantal × tarief doeljaar; inschrijving op de patiëntenstand × 4; eigen contract wint', async () => {
  const b = tg(j(await laad().v())).berekend;
  const r = (c) => b.regels.find((x) => x.code === c);
  assert.strictEqual(r('12011').bedrag, 1100 * 12);               // verrichting: aantal heel J-1 × lijst J+1
  assert.strictEqual(r('12011').tarief_nu, 11);
  assert.strictEqual(r('13005').bedrag, 50 * 65);
  assert.strictEqual(r('11115').aantal, 1150 * 4);                 // <65 op de stand van J × 4 kwartalen
  assert.strictEqual(r('11115').bedrag, 1150 * 4 * 23);
  assert.strictEqual(r('31080').aantal, 4600);                     // module: 4400 × 1150 / 1100
  assert.strictEqual(r('31080').tarief_doel, 3.5);                 // eigen contract TG, geldig tot eind J+1
  assert.strictEqual(r('31080').bedrag, 4600 * 3.5);
  assert.strictEqual(r('13050').bedrag, rond(4600 * 2.2));
  assert.strictEqual(r('13051').herkomst, 'nieuw in ' + J + ', omgerekend');   // pas in J: per dag naar een heel jaar
  assert.strictEqual(r('13051').bedrag, rond(30 * JAARDAGEN / DAGEN * 21));
  assert.ok(!r('12501'), 'aantal 0 telt niet');
});

test('berekend: zonder tarief doeljaar staat met naam en reden en telt mee op het tarief van nu', async () => {
  const b = tg(j(await laad().v())).berekend;
  const z = b.zonder_tarief;
  assert.deepStrictEqual(z.lijst.map((x) => x.code).sort(), ['11201', '12850', '13038', '30121', '31174']);
  const zr = (c) => z.lijst.find((x) => x.code === c);
  assert.match(zr('11201').reden, /^eigen contract \(nu 4,00, lijst 5,40\)/);   // TG krijgt 4, lijst J zegt 5,40 → lijst J+1 geldt niet
  assert.strictEqual(zr('11201').bedrag, 4600 * 4);
  assert.match(zr('30121').reden, /meer niveaus \(niveau 1, niveau 2\)/);
  assert.strictEqual(zr('30121').bedrag, 4600 * 1);
  assert.match(zr('12850').reden, new RegExp('niet op de tarievenlijst ' + (J + 1)));
  assert.strictEqual(zr('12850').bedrag, 10 * 100);                 // niet in J: tarief van nu = gedeclareerd J-1
  // Codex MOET 1: eigen contract dat alleen nu loopt → niet de lijst van J+1, ook al is het lijsttarief nu gelijk
  assert.match(zr('31174').reden, new RegExp('^eigen contract; tarief ' + (J + 1) + ' niet in de datahub$'));
  assert.strictEqual(zr('31174').bedrag, rond(4600 * 1.25));
  // alleen in J-1 gedeclareerd, geen lijst J-1 om mee te vergelijken → niet geraden
  assert.match(zr('13038').reden, /niet na te gaan of de lijst/);
  assert.strictEqual(zr('13038').bedrag, 600);
  assert.strictEqual(z.codes, 5);
  assert.strictEqual(z.nu, 18400 + 4600 + 1000 + 5750 + 600);
  const met = 1100 * 12 + 50 * 65 + 4600 * 23 + 4600 * 3.5 + 4600 * 2.2 + 30 * JAARDAGEN / DAGEN * 21;
  const metNu = 1100 * 11 + 50 * 62 + 4600 * 22 + 4600 * 3 + 4600 * 2.1 + 30 * JAARDAGEN / DAGEN * 20;
  assert.strictEqual(b.met_tarief.codes, 6);
  assert.strictEqual(b.met_tarief.doel, rond(met));
  assert.strictEqual(b.met_tarief.nu, rond(metNu));
  assert.strictEqual(b.totaal, rond(met + 30350));
  assert.strictEqual(b.op_nu, rond(metNu + 30350));
  assert.strictEqual(b.met_tarief.pct, rond((met / metNu - 1) * 1000) / 10);
});

test('berekend: groei van twee hele jaren met de hand — tarief + werk + nieuwe codes = verschil', async () => {
  const g = tg(j(await laad().v())).berekend.groei;
  assert.strictEqual(g.length, 2);
  const a = g[0];
  assert.deepStrictEqual([a.van, a.naar, a.heel], [J - 2, J - 1, true]);
  assert.strictEqual(a.bedrag_van, 90000);
  assert.strictEqual(a.tarief, 1100 * 0.5 + 4400 * 1);              // 4950
  assert.strictEqual(a.werk, 100 * 10 + 400 * 20);                  // 9000
  assert.strictEqual(a.nieuw, 3000 + 13200 + 8800 + 4400 + 1000 + 17600 + 5500 + 600);
  assert.strictEqual(a.verschil, a.tarief + a.werk + a.nieuw);
  assert.strictEqual(a.bedrag_naar, 158050);
  assert.ok(a.nieuw_codes.includes('ECG-diagnostiek'));
});

test('berekend: groei naar het lopende jaar is omgerekend naar een heel jaar en sluit', async () => {
  const b = j(await laad().v());
  const g = tg(b).berekend.groei[1];
  assert.deepStrictEqual([g.van, g.naar, g.heel, g.dagen, g.kwartalen], [J - 1, J, false, DAGEN, 2]);
  const f = JAARDAGEN / DAGEN, pv = 1100, pn = 1150;
  // verrichtingen per dag; modules/inschrijving: aantal J-1 × 1150/1100; 13051 nieuw (mi): per dag
  const nj = { '12011': 600 * f, '13005': 20 * f, '11115': 4400 * pn / pv, '31080': 4400 * pn / pv, '13050': 4400 * pn / pv, '30121': 4400 * pn / pv, '11201': 4400 * pn / pv, '12850': 0, '31174': 4400 * pn / pv, '13038': 0 };
  const pB = { '12011': 10.5, '13005': 60, '11115': 21, '31080': 3, '13050': 2, '30121': 1, '11201': 4, '12850': 100, '31174': 1.25, '13038': 300 };
  const pL = { '12011': 11, '13005': 62, '11115': 22, '31080': 3, '13050': 2.1, '30121': 1, '11201': 4, '31174': 1.25 };
  const nB = { '12011': 1100, '13005': 50, '11115': 4400, '31080': 4400, '13050': 4400, '30121': 4400, '11201': 4400, '12850': 10, '31174': 4400, '13038': 2 };
  let tarief = 0, werk = 0;
  for (const c of Object.keys(nB)) { werk += (nj[c] - nB[c]) * pB[c]; if (pL[c]) tarief += nj[c] * (pL[c] - pB[c]); }
  const nieuw = 30 * f * 20;
  assert.strictEqual(g.tarief, rond(tarief));
  assert.strictEqual(g.werk, rond(werk));
  assert.strictEqual(g.nieuw, rond(nieuw));
  assert.ok(Math.abs(g.verschil - (g.tarief + g.werk + g.nieuw)) <= 1, 'sluit op afronding na');
  assert.deepStrictEqual(g.nieuw_codes, ['Meedenkadvies']);
});

test('berekend: lijn werkelijk (hele jaren) → lopend jaar omgerekend → doeljaar, gestippeld', async () => {
  const b = tg(j(await laad().v())).berekend;
  const gr = b.grafiek;
  assert.deepStrictEqual(gr.x, [J - 2, J - 1, J, J + 1].map(String));
  assert.deepStrictEqual(gr.reeksen[0].waarden, [90000, 158050, null, null]);
  assert.strictEqual(gr.reeksen[1].stippel, true);
  assert.deepStrictEqual(gr.reeksen[1].waarden, [null, 158050, b.groei[1].bedrag_naar, b.totaal]);
});

test('berekend: alleen Tolgaarde; Groenhouten houdt zijn model of zijn eigen regel', async () => {
  const d = j(await laad().v());
  assert.ok(!d.toekomst.some((t) => t.code === 'GH' && t.soort === 'berekend'));
  assert.ok(!JSON.stringify(tg(d)).includes('9990'));
});

test('berekend: geen tarievenlijst voor dit jaar of later → de oude regel blijft, niets verzonnen', async () => {
  const c = laad({ tar: TAR.filter((x) => String(x.geldig_van) < J + '') });
  vm.runInContext('this.b = appBerekend', c);
  assert.match(c.b('TG', R, TAR.filter((x) => String(x.geldig_van) < J + ''), PAT, J).geen, /geen tarievenlijst/);
  const t = tg(j(await c.v()));
  assert.ok(!t || t.soort !== 'berekend');
});

test('berekend: tarief-vraag faalt → één foutregel, Jaarcijfers blijft', async () => {
  const d = j(await laad({ weg: /FROM tarief WHERE/ }).v());
  assert.ok(d.fouten.some((f) => /nieuwe tarief/.test(f)));
  assert.ok(!d.toekomst.some((t) => t.soort === 'berekend'));
  assert.ok(d.entiteiten.length > 0);
});

test('berekend: de tarief-vraag leest alleen lijst en eigen contracten van de praktijken zonder model', async () => {
  const c = laad();
  await c.v();
  const q = c.sqls.find((s) => /FROM tarief WHERE/.test(s));
  assert.match(q, /entiteit IS NULL OR entiteit IN \('TG'\)/);
  assert.match(q, /zk_gecontracteerd','zk_module_contract/);
});
