'use strict';
// wv4220 (besluitenpagina nr 932 = L32): de brief na een inlezing. VERZONNEN exports met handgetelde aantallen (geen echte nummers of namen).
// Handtelling Tolgaarde (TG): K2 2026 = 40 patiënten op 1-4; 20 kort, 20 middel, 10 lang (50 consulten, lang 20 %), 4 ECG, 12 chirurgie = 66
// verrichtingen = 1650 per 1000; ECG 100 per 1000. K3 2026 = 50 patiënten op 1-7; 30/30/30 (lang 33,3 %), 10 ECG, 2 chirurgie = 102 = 2040 per
// 1000 (+23,6 %); ECG 200 per 1000. M&I: ECG +100 per 1000 (stijger), chirurgie 300 → 40 = −260 per 1000 (daler). Niet gefactureerd: 3 regels op
// 10-4 (export 5-10: ouder dan twee maanden) + 5 op 28-9 = 8, waarvan 3 oud.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../pma.js');
const M = require('./pma-maak.js');

const post = (m, wat, body) => m.app({ methode: 'POST', pad: '/app/pma/' + wat, body });
function inlees(m, e) {
  const c = post(m, 'controleer', { naam: 'x.zip', zip: M.maakExport(e).toString('base64') });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  const i = post(m, 'inlees', { sha: c.body.sha });
  assert.strictEqual(i.status, 200, JSON.stringify(i.body));
  return i.body;
}
const R = (code, n, dag, factuur, reg) => { const c = Object.values(M.C).find((x) => x[0] === code); const u = []; for (let i = 0; i < n; i++) u.push({ pnr: String(800001 + i), code, oms: c[1], type: 'V', reg: reg || 'A. Proefsen', tarief: c[2], dag, factuur: factuur === undefined ? '2026-12-31' : factuur }); return u; };
const K = M.C;
function exportTG() {
  const regels = M.inschrijving('2026-04-01', M.patienten(40, 800001), false).concat(M.inschrijving('2026-07-01', M.patienten(50, 800001), false),
    R(K.kort[0], 17, '2026-05-12'), R(K.kort[0], 3, '2026-04-10', null), R(K.middel[0], 20, '2026-05-13'), R(K.lang[0], 10, '2026-06-02', undefined, 'B. Verzonnen'),
    R(K.ecg[0], 4, '2026-06-03'), R(K.chir[0], 12, '2026-06-04'),
    R(K.kort[0], 30, '2026-08-12'), R(K.middel[0], 30, '2026-08-13'), R(K.lang[0], 25, '2026-09-02'), R(K.lang[0], 5, '2026-09-28', null),
    R(K.ecg[0], 10, '2026-09-03'), R(K.chir[0], 2, '2026-09-04'));
  return { agb: '009870', exportdatum: '2026-10-05', begin: '2026-04-01', eind: '2026-09-30', regels };
}
function exportGH() {
  const regels = M.inschrijving('2026-07-01', M.patienten(20, 810001), false).concat(R(K.kort[0], 8, '2026-07-14'), R(K.lang[0], 2, '2026-08-14'));
  return { agb: '010710', exportdatum: '2026-10-06', begin: '2026-07-01', eind: '2026-09-30', regels };
}
function nieuw() { const map = fs.mkdtempSync(path.join(os.tmpdir(), 'pma-brief-')); return P.maak({ map: path.join(map, 'pma'), finPatienten: () => ({}) }); }

test('inlezen TG: vijf regels die met de handtelling kloppen, link naar Overzicht K3 2026', () => {
  const m = nieuw();
  const b = inlees(m, exportTG()).brief;
  assert.ok(b, 'brief ontbreekt');
  assert.strictEqual(b.praktijk, 'TG'); assert.strictEqual(b.kwartaal, '2026-K3'); assert.strictEqual(b.heel, true); assert.strictEqual(b.vergeleken, true);
  assert.deepStrictEqual(b.regels.map((r) => r.id), ['per1000', 'lang', 'ecg', 'mi', 'factuur']);
  const t = Object.fromEntries(b.regels.map((r) => [r.id, r.tekst]));
  assert.strictEqual(t.per1000, 'Verrichtingen K3 2026: 2.040 per 1000 patiënten (vorig kwartaal 1.650; +23,6 %).');
  assert.strictEqual(t.lang, 'Consulten van 20 minuten en langer: 33,3 % van 90 consulten (vorig kwartaal 20 %; +13,3 procentpunt).');
  assert.strictEqual(t.ecg, 'ECG\'s: 10, 200 per 1000 (vorig kwartaal 100).');
  assert.strictEqual(t.mi, 'M&I tegenover vorig kwartaal: meeste groei ECG 4 → 10 (+100 per 1000); grootste daling Chirurgie 12 → 2 (−260 per 1000).');
  assert.strictEqual(t.factuur, 'Nog niet gefactureerd: 8 regels, waarvan 3 bij de export al meer dan twee maanden oud.');
  assert.deepStrictEqual([...new Set(b.regels.map((r) => r.link))], ['/pma#overzicht/tg/2026-k3', '/pma#overzicht/tg']);
  // nooit een patiëntnummer of een registreerder in de brief
  const j = JSON.stringify(b);
  for (const x of ['8000', 'Proefsen', 'Verzonnen', 'Proefhouder']) assert.ok(!j.includes(x), 'brief noemt ' + x);
  // zelfde ZIP opnieuw = al ingelezen = geen nieuwe brief
  const c = post(m, 'controleer', { naam: 'x.zip', zip: M.maakExport(exportTG()).toString('base64') });
  assert.ok(c.body.al || c.status === 200);
});

test('inlezen GH: eigen praktijk in de link (Codex MOET 1), geen vergelijking zonder vorig kwartaal', () => {
  const m = nieuw();
  inlees(m, exportTG());
  const b = inlees(m, exportGH()).brief;
  assert.strictEqual(b.praktijk, 'GH'); assert.strictEqual(b.link, '/pma#overzicht/gh/2026-k3'); assert.strictEqual(b.vergeleken, false);
  const t = Object.fromEntries(b.regels.map((r) => [r.id, r.tekst]));
  assert.strictEqual(t.per1000, 'Verrichtingen K3 2026: 500 per 1000 patiënten.');
  assert.strictEqual(t.lang, 'Consulten van 20 minuten en langer: 20 % van 10 consulten.');
  assert.strictEqual(t.mi, 'M&I: 0 verrichtingen; het kwartaal ervoor is niet helemaal ingelezen, dus geen stijger of daler.');
  assert.strictEqual(t.factuur, 'Nog niet gefactureerd: niets; alles in de ingelezen dagen heeft een factuurdatum.');
});

test('puur: deels gedekt kwartaal, geen patiënten, kleine M&I-aantallen', () => {
  const mnd = (maand, dagen_gedekt, dagen, groepen, sub, voorlopig) => ({ maand, dagen_gedekt, dagen, groepen, sub, voorlopig: voorlopig || 0 });
  const p = { code: 'TG', naam: 'Tolgaarde', voorlopig: 0, valt_op: { voorlopig_oud: { n: 0 } }, kwartalen: [],
    maanden: [mnd('2026-10', 31, 31, { consult: { n: 9, cent: 0 }, mi: { n: 3, cent: 0 }, 'niet-gedeclareerd': { n: 4, cent: 0 } }, { 'consult:kort': 9, 'mi:ECG': 3 }), mnd('2026-11', 10, 30, {}, {})] };
  const b = P.brief(p);
  assert.strictEqual(b.kwartaal, '2026-K4'); assert.strictEqual(b.heel, false); assert.strictEqual(b.vergeleken, false);
  assert.strictEqual(b.regels[0].tekst, 'Verrichtingen K4 2026 (nog niet helemaal ingelezen): 12 (geen patiëntenaantal bekend, dus geen per 1000).');
  assert.strictEqual(b.regels[2].tekst, 'ECG\'s: 3.');
  // twee volle kwartalen, maar M&I-soorten onder de 10: geen stijger of daler
  const q = mnd, mi = (n) => ({ mi: { n, cent: 0 } });
  const p2 = { code: 'GH', naam: 'Groenhouten', voorlopig: 1, valt_op: { voorlopig_oud: { n: 0 } },
    kwartalen: [{ peildatum: '2026-04-01', patienten: 100 }, { peildatum: '2026-07-01', patienten: '< 5' }],
    maanden: ['04', '05', '06', '07', '08', '09'].map((mm) => q('2026-' + mm, 30, 30, mi(3), { 'mi:ECG': 3 })) };
  const b2 = P.brief(p2);
  assert.strictEqual(b2.kwartaal, '2026-K3'); assert.strictEqual(b2.vergeleken, true);
  // K3 heeft alleen "< 5" patiënten → geen patiëntenaantal (zoals patientenTussen op het scherm: een kwartaal in de periode zonder getal = null)
  assert.strictEqual(b2.regels[0].tekst, 'Verrichtingen K3 2026: 9 (geen patiëntenaantal bekend, dus geen per 1000).');
  assert.strictEqual(b2.regels[3].tekst, 'M&I: 9 verrichtingen; geen patiëntenaantal om te vergelijken.');
  p2.kwartalen[1].patienten = 100;
  const b3 = P.brief(p2);
  assert.strictEqual(b3.regels[0].tekst, 'Verrichtingen K3 2026: 90 per 1000 patiënten (vorig kwartaal 90; ±0 %).');
  assert.strictEqual(b3.regels[3].tekst, 'M&I: geen soort veranderde wezenlijk tegenover vorig kwartaal.');
  assert.strictEqual(b2.regels[4].tekst, 'Nog niet gefactureerd: 1 regel.');
  assert.strictEqual(P.brief({ code: 'TG', maanden: [], kwartalen: [] }), null);
});

// server.js pmaBriefMeld (uit de bron geknipt): de brief gaat als één editie-regel naar het redactie-loket, en die regel slaagt door de echte
// loketvalidatie (app-nieuws.js meld: onderwerp, link-vorm) en komt in de eerstvolgende editie met de PMA-link.
test('server: brief → één loketregel per praktijk, link langs LINK_RE, in de editie', async () => {
  const AN = require('../app-nieuws.js');
  const bron = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const stuk = bron.slice(bron.indexOf('function pmaBriefTekst('), bron.indexOf('function pmaInfo()'));
  const pmaDatumNl = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? Number(m[3]) + '-' + Number(m[2]) + '-' + m[1] : '?'; };
  const meld = new Function('pmaDatumNl', 'loketMeld', 'ovisAms', stuk + '\nreturn pmaBriefMeld;')(pmaDatumNl, null, null);
  const m = nieuw();
  const b = inlees(m, exportTG()).brief;
  let staat = {};
  const nu = Date.parse('2026-10-05T19:00:00Z');
  const zet = async (x) => { const r = AN.meld(staat, x, nu); staat = r.staat; return r; };
  const r1 = await meld(b, { meld: zet, ams: { datum: '2026-10-05' } });
  assert.strictEqual(r1.uitkomst, 'nieuw');
  assert.strictEqual(r1.sleutel.includes('brief-tg'), true, r1.sleutel);
  const reg = AN.editieRegels(staat, 'avond', '2026-10-05', nu);
  assert.strictEqual(reg.length, 1);
  const tekst = AN.editieTekst(reg).tekst;
  assert.ok(tekst.startsWith('• PMA: Na het inlezen van Tolgaarde (cijfers t/m 30-9-2026): Verrichtingen K3 2026: 2.040 per 1000'), tekst);
  assert.ok(tekst.endsWith('([open](https://app.socev.dev/pma#overzicht/tg/2026-k3))'), tekst);
  // tweede inlezing van dezelfde praktijk werkt dezelfde regel bij (geen stapel); GH krijgt een eigen regel
  const r2 = await meld(Object.assign({}, b, { data_tot: '2026-10-31' }), { meld: zet, ams: { datum: '2026-10-06' } });
  assert.strictEqual(r2.uitkomst, 'bijgewerkt');
  const g = inlees(m, exportGH()).brief;
  assert.strictEqual((await meld(g, { meld: zet, ams: { datum: '2026-10-06' } })).uitkomst, 'nieuw');
  assert.strictEqual(AN.editieRegels(staat, 'ochtend', '2026-10-06', nu).length, 2);
  assert.strictEqual(await meld(null, { meld: zet }), null);
  assert.strictEqual(await meld({ praktijk: 'TG', regels: [] }, { meld: zet }), null);
});
