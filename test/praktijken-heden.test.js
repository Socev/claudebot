// wv3098: PMA › Jaarcijfers — heden (PMA naast VIP lopend jaar en omzet vorig jaar) en toekomst (modelprognose GH, POT-subsidieprognose).
// Knipt het Praktijken-blok uit server.js (SERVER_JS mag een andere server.js zijn: kruisproef) en draait het met stubs; pma.jaarBedragen op
// verzonnen exports (test/pma-maak.js). Alle cijfers hieronder zijn verzonnen.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(__dirname, '..', 'server.js'), 'utf8');
const BLOK = SRC.slice(SRC.indexOf('// ── Praktijken (fase 6 rest, wv174'), SRC.indexOf('// ── App Financiën (wv771'));
const PMA_JS = process.env.PMA_JS || path.join(__dirname, '..', 'pma.js');
const P = require(PMA_JS);
const M = require('./pma-maak.js');
const JAAR = Number(new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }).slice(0, 4));
const j = (x) => JSON.parse(JSON.stringify(x));

// Verzonnen fin-antwoorden; het lopende jaar volgt de klok (de pod rekent "dit jaar" zelf uit)
function fin(sql, o) {
  o = o || {};
  if (o.weg && o.weg.test(sql)) return Promise.reject(new Error('fin http 500'));
  if (/FROM reeks WHERE versie='jaarrekening'/.test(sql)) return Promise.resolve([
    { entiteit: 'TG', rubriek: 'omzet_totaal', jaar: JAAR - 1, bedrag: 1000000, bron_id: 1 }, { entiteit: 'TG', rubriek: 'omzet_totaal', jaar: JAAR - 2, bedrag: 900000, bron_id: 2 },
    { entiteit: 'GH', rubriek: 'omzet_totaal', jaar: JAAR - 1, bedrag: 800000, bron_id: 3 }, { entiteit: 'GH', rubriek: 'resultaat', jaar: JAAR - 1, bedrag: 300000, bron_id: 3 }]);
  if (/FROM patienten/.test(sql)) return Promise.resolve([{ entiteit: 'GH', peildatum: (JAAR - 1) + '-01-01', aantal: 4000.4, bron_id: 10 },
    { entiteit: 'GH', peildatum: JAAR + '-01-01', aantal: 4100, bron_id: 11 }]);
  if (/FROM bron/.test(sql)) return Promise.resolve([{ id: 1, titel: 'Jaarrekening ' + (JAAR - 1) + ' Proef TG' }, { id: 2, titel: 'Jaarrekening ' + (JAAR - 2) + ' Proef TG' },
    { id: 3, titel: 'Jaarrekening ' + (JAAR - 1) + ' Proef GH' }, { id: 10, titel: 'VIP proef', periode_tot: (JAAR - 1) + '-12-31' }, { id: 11, titel: 'VIP proef lopend', periode_tot: JAAR + '-03-31' }]);
  if (o.vipRijen && /COALESCE\(p\.categorie/.test(sql)) return Promise.resolve(o.vipRijen);   // wv4217: per code
  if (/COALESCE\(p\.categorie/.test(sql)) return Promise.resolve([
    { entiteit: 'TG', jaar: JAAR, tot: JAAR + '-01-31', cat: 'ion', toegezegd: 500 }, { entiteit: 'TG', jaar: JAAR, tot: JAAR + '-01-31', cat: 'module', toegezegd: 100 },
    { entiteit: 'TG', jaar: JAAR, tot: JAAR + '-01-31', cat: 'consult', toegezegd: 200 }, { entiteit: 'TG', jaar: JAAR, tot: JAAR + '-01-31', cat: 'mi', toegezegd: 50 },
    { entiteit: 'TG', jaar: JAAR - 1, tot: (JAAR - 1) + '-12-31', cat: 'ion', toegezegd: 99999 },
    { entiteit: 'GH', jaar: JAAR, tot: JAAR + '-03-31', cat: 'ion', toegezegd: 700 }, { entiteit: 'GH', jaar: JAAR, tot: JAAR + '-03-31', cat: 'onbekend', toegezegd: 30 }]);
  if (/FROM declaratie/.test(sql)) return Promise.resolve([]);
  if (/FROM model_run/.test(sql)) return Promise.resolve(o.runs || [
    { id: 1, model: 'gh_maatschap', reeks_versie: 'model-1.3-*', gedraaid_op: '2026-01-01', werkelijk_tm: JAAR - 2 },
    { id: 2, model: 'gh_maatschap', reeks_versie: 'model-1.4-*', gedraaid_op: '2026-09-17', werkelijk_tm: JAAR - 1 }]);
  if (/versie LIKE 'model-%'/.test(sql)) {
    const r = [];
    for (const [s, f] of [['basis', 1], ['laag', 0.9], ['hoog', 1.1]]) for (let y = JAAR; y <= JAAR + 2; y++) {
      r.push({ entiteit: 'GH', versie: 'model-1.4-' + s, rubriek: 'omzet_totaal', jaar: y, bedrag: 900000 * f + (y - JAAR) * 10000 });
      r.push({ entiteit: 'GH', versie: 'model-1.4-' + s, rubriek: 'patienten_gem', jaar: y, bedrag: 4200.6 * f });
    }
    r.push({ entiteit: 'GH', versie: 'model-1.3-basis', rubriek: 'omzet_totaal', jaar: JAAR, bedrag: 1 });   // oude versie telt niet
    return Promise.resolve(r);
  }
  return Promise.resolve([]);
}
const POT = [{ jaar: 2026, n: 3, totaal: 3000.4, bron: 'Proefvoorstel 2026.pdf, tabel PRAKTIJK/BEDRAG', bron2: 'Proefvoorstel 2026.pdf, tabel PRAKTIJK/BEDRAG' },
  { jaar: 2027, n: 3, totaal: 3500, bron: 'Proefbegroting 2027.pdf, tabel X', bron2: 'Proefbegroting 2027.pdf, tabel X' }];

function pmaMet(exports) {
  const map = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pma-heden-')), 'pma');
  const m = P.maak({ map, finPatienten: () => null });
  for (const e of exports) {
    const c = m.app({ methode: 'POST', pad: '/app/pma/controleer', body: { naam: 'x.zip', zip: M.maakExport(e).toString('base64') } });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    const i = m.app({ methode: 'POST', pad: '/app/pma/inlees', body: { sha: c.body.sha } });
    assert.strictEqual(i.status, 200, JSON.stringify(i.body));
  }
  return { m, map };
}
// verzonnen export A/B (jaar 2026) naar het lopende jaar verschuiven, zodat "dit jaar" klopt
function naarJaar(e) {
  const z = (s) => (typeof s === 'string' ? s.replace(/^2026-/, JAAR + '-') : s);
  return Object.assign({}, e, { exportdatum: z(e.exportdatum), begin: z(e.begin), eind: z(e.eind), regels: e.regels.map((r) => Object.assign({}, r, { dag: z(r.dag), factuur: z(r.factuur) })) });
}

function laad(o) {
  o = o || {};
  const ctx = { console, Date, Math, Number, String, Object, Array, Set, Promise, JSON, isFinite, AbortSignal, Error, process: { env: {} }, appStaat: {}, logs: [],
    appKort: (s, n) => String(s == null ? '' : s).slice(0, n), appWeiger: () => {}, appStuur: () => {}, fetch: () => Promise.reject(new Error('geen netwerk')),
    appSbRpc: () => Promise.resolve([]) };
  if (o.pmaApp !== undefined) ctx.pmaApp = o.pmaApp;
  ctx.potDhD1 = o.potDhD1 || (() => Promise.resolve([{ results: POT }]));
  ctx.logError = (w, e) => ctx.logs.push(w + ': ' + (e && e.message));
  vm.createContext(ctx);
  vm.runInContext(BLOK + '\n;this.v = appPraktijkenVerzamel;', ctx);
  ctx.appFinSql = (sql) => { (ctx.sqls = ctx.sqls || []).push(sql); return fin(sql, o); };
  return ctx;
}

test('pma.jaarBedragen: alleen aaneengesloten dekking vanaf 1 januari, inschrijfgeld per gedekt kwartaal, knip binnen de dekking', () => {
  const A = naarJaar(M.exportA()), B = naarJaar(M.exportB());
  const { m } = pmaMet([A, B]);
  const r = m.jaarBedragen(JAAR, { TG: JAAR + '-01-31', GH: JAAR + '-01-31' });
  const tg = r.find((x) => x.code === 'TG'), gh = r.find((x) => x.code === 'GH');
  assert.strictEqual(gh.stand, 'geen-export');
  assert.strictEqual(tg.stand, 'ok');
  assert.deepStrictEqual([tg.van, tg.tot], [JAAR + '-01-01', JAAR + '-04-01']);
  assert.deepStrictEqual(j(tg.kwartalen), [JAAR + '-01-01', JAAR + '-04-01']);
  // handtelling uit de verzonnen regels (zelfde regels als in de databank: nieuwste export wint per dag)
  const cent = (t) => Math.round(Number(String(t).replace(',', '.')) * 100);
  const regels = B.regels.filter((x) => x.type === 'V').concat(A.regels.filter((x) => x.type === 'V' && x.dag < JAAR + '-01-20'));
  const ins = A.regels.filter((x) => x.type === 'I').concat(B.regels.filter((x) => x.type === 'I'));
  assert.strictEqual(tg.verricht_cent, regels.reduce((s, x) => s + cent(x.tarief), 0));
  assert.strictEqual(tg.inschrijf_cent, ins.reduce((s, x) => s + cent(x.tarief), 0));
  assert.strictEqual(tg.maanden.reduce((s, x) => s + x.verricht_cent, 0), tg.verricht_cent);
  assert.ok(tg.knip && tg.knip.tot === JAAR + '-01-31');
  assert.strictEqual(tg.knip.inschrijf_cent, A.regels.filter((x) => x.type === 'I').reduce((s, x) => s + cent(x.tarief), 0), 'alleen het kwartaal van 1-1');
  assert.strictEqual(tg.knip.verricht_cent, regels.filter((x) => x.dag <= JAAR + '-01-31').reduce((s, x) => s + cent(x.tarief), 0));
  assert.strictEqual(m.jaarBedragen(JAAR, { TG: JAAR + '-06-30' })[0].knip, null, 'knip na de dekking = geen vergelijking');
  const t = JSON.stringify(r);
  for (const x of A.regels.concat(B.regels)) assert.ok(!new RegExp('(^|[^0-9])' + x.pnr + '([^0-9]|$)').test(t), 'geen patiëntnummer');
  for (const n of M.REG.concat(['Z. Proefhouder'])) assert.ok(!t.includes(n), 'geen registreerder');   // wv4217: codenamen mogen 'Verzonnen' heten
  assert.throws(() => m.jaarBedragen('2026; DROP'), /jaar/);
});

test('pma.jaarBedragen: alleen een export vanaf februari = begint-later (geen "tot nu")', () => {
  const B = naarJaar(M.exportB());
  B.begin = JAAR + '-02-01'; B.regels = B.regels.filter((x) => x.dag >= JAAR + '-02-01');
  const { m } = pmaMet([B]);
  const tg = m.jaarBedragen(JAAR, {}).find((x) => x.code === 'TG');
  assert.strictEqual(tg.stand, 'begint-later');
  assert.strictEqual(tg.inschrijf_cent, 0);
});

test('pma.jaarBedragen: ontbreekt een kwartaal inschrijfgeld vóór de knipdatum, dan geen vergelijking (review MOET 1)', () => {
  const A = naarJaar(M.exportA()), B = naarJaar(M.exportB());
  B.regels = B.regels.filter((x) => x.type !== 'I');   // export B zonder het inschrijfgeld van 1 april: geen kwartaalbron voor april
  const { m } = pmaMet([A, B]);
  const vroeg = m.jaarBedragen(JAAR, { TG: JAAR + '-01-31' })[0], laat = m.jaarBedragen(JAAR, { TG: JAAR + '-04-01' })[0];
  assert.strictEqual(laat.stand, 'kwartaal-mist');
  assert.ok(vroeg.knip, 'knip vóór het ontbrekende kwartaal mag');
  assert.strictEqual(laat.knip, null, 'knip na het ontbrekende kwartaal niet');
});

test('heden: PMA naast VIP lopend jaar (laatste export), vergelijking over dezelfde dagen, omzet vorig jaar; nooit opgeteld', async () => {
  const { m } = pmaMet([naarJaar(M.exportA()), naarJaar(M.exportB())]);
  const c = laad({ pmaApp: m });
  const d = j(await c.v());
  assert.ok(d.heden, 'veld heden');
  assert.strictEqual(d.heden.jaar, JAAR);
  const tg = d.heden.praktijken.find((p) => p.code === 'TG'), gh = d.heden.praktijken.find((p) => p.code === 'GH');
  assert.strictEqual(tg.pma.stand, 'ok'); assert.strictEqual(tg.pma.soort, 'werkelijk');
  assert.strictEqual(tg.pma.tot, JAAR + '-04-01');
  assert.deepStrictEqual([tg.vip.toegezegd, tg.vip.inschrijf, tg.vip.verricht, tg.vip.tot], [850, 600, 250, JAAR + '-01-31']);
  assert.strictEqual(tg.vip.soort, 'werkelijk');
  assert.strictEqual(tg.vergelijk.soort, 'berekend');
  assert.strictEqual(tg.vergelijk.tot, JAAR + '-01-31');
  const k = m.jaarBedragen(JAAR, { TG: JAAR + '-01-31' })[0].knip;
  assert.strictEqual(tg.vergelijk.pma_inschrijf, Math.round(k.inschrijf_cent / 100));
  assert.strictEqual(tg.vergelijk.pct_inschrijf, Math.round((Math.round(k.inschrijf_cent / 100) / 600 - 1) * 1000) / 10);
  assert.deepStrictEqual([tg.vorig.jaar, tg.vorig.omzet, tg.vorig.soort], [JAAR - 1, 1000000, 'werkelijk']);
  assert.ok(/Jaarrekening/.test(tg.vorig.bron));
  assert.deepStrictEqual(gh.pma, { stand: 'geen-export' });
  assert.deepStrictEqual([gh.vip.inschrijf, gh.vip.verricht], [700, 30], 'onbekende categorie telt bij verrichtingen');
  assert.strictEqual(gh.vergelijk, null);
  assert.ok(/nooit opgeteld/.test(d.heden.uitleg));
  assert.ok(!Object.keys(tg).some((x) => /som|totaal_samen/.test(x)), 'geen opgeteld veld');
  assert.ok(!d.fouten.some((f) => /PMA|VIP|model|subsidie/.test(f)), JSON.stringify(d.fouten));
});

// wv4217 (L29): per groep verrichtingen, PMA naast VIP over dezelfde dagen. Alle getallen verzonnen en hieronder met de hand nagerekend.
test('heden per groep: handgerekend — PMA-indeling ook voor VIP-codes, alleen in PMA/VIP, verschil in aantal en euro, totaal in centen', () => {
  const c = laad({ pmaApp: null });
  vm.runInContext('this.pg = appHedenGroepen;', c);
  const indeling = P.maak({ map: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pma-ind-')), 'pma') }).indeling();
  const knip = [{ code: '11115', naam: 'Inschrijving', groep: 'inschrijving', n: 5, cent: 10000 }, { code: '12011', naam: 'Consult', groep: 'consult', n: 10, cent: 14000 },
    { code: '12820', naam: 'Informatieverstrekking', groep: 'overig', n: 3, cent: 5070 }];
  const vip = [{ code: '11115', cat: 'ion', aantal: 5, toegezegd: 100 }, { code: '12011', cat: 'consult', aantal: 8, toegezegd: 112 },
    { code: '12501', cat: 'consult', aantal: 0, toegezegd: 67.6 },     // militair: alleen in VIP, aantal 0 maar wel een bedrag
    { code: '12850', cat: 'consult', aantal: 2, toegezegd: 250.5 },    // VIP noemt het consult, PMA deelt het in bij M&I: PMA-indeling wint
    { code: '99999', cat: 'mi', aantal: 1, toegezegd: 10 },            // code die PMA niet kent: groep uit de VIP-categorie
    { code: '12100', cat: 'onbekend', aantal: 0, toegezegd: 0 }];      // niets: niet tonen
  const r = j(c.pg(knip, vip, indeling));
  assert.deepStrictEqual(r.groepen.map((g) => g.groep), ['inschrijving', 'consult', 'mi', 'overig'], 'volgorde van de PMA-groepen');
  const g = (id) => r.groepen.find((x) => x.groep === id);
  const kort = (x) => [x.pma_n, x.pma, x.vip_n, x.vip, x.verschil_n, x.verschil, x.alleen];
  assert.deepStrictEqual(kort(g('inschrijving')), [5, 100, 5, 100, 0, 0, null]);
  assert.deepStrictEqual(kort(g('consult')), [10, 140, 8, 180, 2, -40, null], '112 + 67,60 = 179,60; 140 − 179,60 = −39,60');
  assert.deepStrictEqual(kort(g('mi')), [null, null, 3, 261, null, null, 'vip'], '250,50 + 10 = 260,50');
  assert.deepStrictEqual(kort(g('overig')), [3, 51, null, null, null, null, 'pma'], '50,70; 12100 zonder aantal en bedrag weg');
  assert.deepStrictEqual(g('consult').codes.map((x) => [x.code, x.alleen]), [['12011', null], ['12501', 'vip']]);
  assert.strictEqual(g('consult').codes[1].naam, indeling.codes['12501'].naam, 'naam uit de PMA-indeling');
  assert.deepStrictEqual(g('mi').codes.map((x) => x.code), ['12850', '99999']);
  assert.deepStrictEqual(r.totaal, { pma: 291, vip: 540, verschil: -249 }, '290,70 / 540,10 / −249,40');
  assert.strictEqual(c.pg(null, vip, indeling), null, 'zonder PMA-codes geen tabel');
  assert.strictEqual(c.pg(knip, vip, null), null, 'zonder indeling geen tabel');
});

test('heden per groep in de route: tabeltotaal = de twee totalen van de zin; codes van PMA tellen op tot de knip; geen patiënt of naam', async () => {
  const A = naarJaar(M.exportA()), B = naarJaar(M.exportB());
  const { m } = pmaMet([A, B]);
  const t = JAAR + '-01-31';
  const vipRijen = [{ entiteit: 'TG', jaar: JAAR, tot: t, code: '11115', cat: 'ion', aantal: 2, toegezegd: 40 }, { entiteit: 'TG', jaar: JAAR, tot: t, code: '13050', cat: 'module', aantal: 2, toegezegd: 4 },
    { entiteit: 'TG', jaar: JAAR, tot: t, code: '12011', cat: 'consult', aantal: 3, toegezegd: 42 }, { entiteit: 'TG', jaar: JAAR, tot: t, code: '13005', cat: 'mi', aantal: 1, toegezegd: 50.4 },
    { entiteit: 'TG', jaar: JAAR - 1, tot: (JAAR - 1) + '-12-31', code: '12011', cat: 'consult', aantal: 999, toegezegd: 99999 },   // ander jaar telt niet
    { entiteit: 'GH', jaar: JAAR, tot: t, code: '12011', cat: 'consult', aantal: 7, toegezegd: 98 }];                                // andere praktijk telt niet
  const d = j(await laad({ pmaApp: m, vipRijen }).v());
  const tg = d.heden.praktijken.find((p) => p.code === 'TG'), v = tg.vergelijk;
  assert.ok(v && Array.isArray(v.groepen) && v.groepen.length, 'tabel per groep');
  const k = m.jaarBedragen(JAAR, { TG: t })[0].knip;
  assert.strictEqual(k.codes.reduce((s, x) => s + x.cent, 0), k.inschrijf_cent + k.verricht_cent, 'codes = knip in centen');
  assert.strictEqual(v.totaal.pma, Math.round((k.inschrijf_cent + k.verricht_cent) / 100));
  assert.ok(Math.abs(v.totaal.pma - (v.pma_inschrijf + v.pma_verricht)) <= 1, 'PMA-totaal = zin (± afronding)');
  assert.strictEqual(v.totaal.vip, v.vip_inschrijf + v.vip_verricht, 'VIP-totaal = zin');
  assert.strictEqual(v.totaal.vip, Math.round(40 + 4 + 42 + 50.4));
  assert.strictEqual(v.groepen.reduce((s, g) => s + (g.vip_n || 0), 0), 8, 'alleen TG, dit jaar, deze export');
  const consult = v.groepen.find((g) => g.groep === 'consult');
  assert.strictEqual(consult.pma_n, k.codes.filter((x) => x.groep === 'consult').reduce((s, x) => s + x.n, 0));
  assert.strictEqual(consult.vip_n, 3);
  const s = JSON.stringify(d.heden);
  for (const x of A.regels.concat(B.regels)) assert.ok(!new RegExp('(^|[^0-9])' + x.pnr + '([^0-9]|$)').test(s), 'geen patiëntnummer');
  for (const n of M.REG.concat(['Z. Proefhouder'])) assert.ok(!s.includes(n), 'geen registreerder');
  assert.strictEqual(d.heden.praktijken.find((p) => p.code === 'GH').vergelijk, null);
});

test('heden per groep: een pod-module zonder indeling (oud) = alleen de zin, geen fout', async () => {
  const { m } = pmaMet([naarJaar(M.exportA()), naarJaar(M.exportB())]);
  const oud = { jaarBedragen: m.jaarBedragen };
  const d = j(await laad({ pmaApp: oud }).v());
  const v = d.heden.praktijken.find((p) => p.code === 'TG').vergelijk;
  assert.ok(v && v.pma_verricht >= 0 && !v.groepen && !v.totaal);
  assert.ok(!d.fouten.some((f) => /PMA/.test(f)), JSON.stringify(d.fouten));
});

test('toekomst: GH laatste modelrun, drie scenario\'s gestippeld naast werkelijk; TG geen model', async () => {
  const c = laad({ pmaApp: null });
  const d = j(await c.v());
  const gh = d.toekomst.find((t) => t.code === 'GH'), tg = d.toekomst.find((t) => t.code === 'TG');
  assert.strictEqual(tg.geen, 'geen prognose (geen model)');
  assert.ok(!tg.grafieken);
  assert.strictEqual(gh.soort, 'model');
  assert.deepStrictEqual(gh.model, { naam: 'model 1.4', gedraaid_op: '2026-09-17', werkelijk_tm: JAAR - 1, scenarios: ['basis', 'laag', 'hoog'] });
  const omzet = gh.grafieken.find((g) => /^Omzet/.test(g.titel));
  assert.deepStrictEqual(omzet.x, [String(JAAR - 1), String(JAAR), String(JAAR + 1), String(JAAR + 2)]);
  assert.deepStrictEqual(omzet.reeksen.map((r) => [r.naam, !!r.stippel]), [['Werkelijk', false], ['Model basis', true], ['Model laag', true], ['Model hoog', true]]);
  assert.deepStrictEqual(omzet.reeksen[0].waarden, [800000, null, null, null]);
  assert.deepStrictEqual(omzet.reeksen[1].waarden, [null, 900000, 910000, 920000], 'model 1.3 telt niet');
  assert.ok(/model 1\.4/.test(omzet.titel) && /doorgerekend 17-9-2026/.test(omzet.bron));
  const pat = gh.grafieken.find((g) => /^Patiënten/.test(g.titel));
  assert.deepStrictEqual(pat.reeksen[0].waarden, [4000, null, null, null], 'lopend jaar (t/m 31-3) telt niet als werkelijk');
  const res = gh.grafieken.find((g) => /^Resultaat/.test(g.titel));
  assert.strictEqual(res, undefined, 'zonder modelcijfers geen grafiek (alleen werkelijk)');
  assert.ok(d.fouten.includes('OVIS PMA is nu niet te lezen; dit jaar tot nu zonder PMA'));
  assert.deepStrictEqual(d.heden.praktijken[0].pma, { stand: 'uit' });
});

test('POT: subsidieprognose als totaal per jaar, met bron per jaar; geen inschrijftarief', async () => {
  const c = laad({ pmaApp: null });
  const d = j(await c.v());
  const pot = d.entiteiten.find((e) => e.code === 'POT');
  assert.ok(pot.prognose);
  assert.strictEqual(pot.prognose.soort, 'prognose');
  assert.deepStrictEqual(pot.prognose.grafiek.items, [{ label: '2026', waarde: 3000 }, { label: '2027', waarde: 3500 }]);
  assert.deepStrictEqual(pot.prognose.bronnen.map((b) => b.bron), ['Proefvoorstel 2026.pdf', 'Proefbegroting 2027.pdf']);
  assert.ok(!c.sqls.some((s) => /inschrijftarief/.test(s)));
  assert.ok(!d.entiteiten.some((e) => e.code !== 'POT' && e.prognose));
});

test('elk nieuw deel mag apart mislukken: één regel, de jaarcijfers blijven', async () => {
  const c = laad({ pmaApp: null, weg: /COALESCE\(p\.categorie|FROM model_run/, potDhD1: () => Promise.reject(new Error('D1 http 500')) });
  const d = j(await c.v());
  for (const f of ['de VIP-export van dit jaar is nu niet te lezen', 'de modelprognose is nu niet te lezen', 'de subsidieprognose van POT is nu niet te lezen'])
    assert.strictEqual(d.fouten.filter((x) => x === f).length, 1, f);
  assert.deepStrictEqual(d.toekomst, []);
  assert.ok(!d.entiteiten.find((e) => e.code === 'POT').prognose);
  assert.ok(d.entiteiten.find((e) => e.code === 'TG').kern.some((k) => k.label === 'Omzet' && k.waarde === 1000000), 'verleden blijft');
  assert.strictEqual(d.heden.praktijken[0].vip, null);
});

test('vaste SELECT\'s zonder invoer van de app; route geeft heden en toekomst door', async () => {
  const c = laad({ pmaApp: null });
  await c.v();
  for (const s of c.sqls) assert.ok(/^\s*SELECT\b/i.test(s) && !/[;]/.test(s), s);
  assert.ok(/heden: d\.heden \|\| null, toekomst: d\.toekomst \|\| \[\]/.test(BLOK));
});
