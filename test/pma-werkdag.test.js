'use strict';
// wv3047: OVIS PMA fase 2 — de werkdagregels (plan § 3) als toetslijst. De gevallen komen uit het oude Ovis-PMA-implementatieplan (§ 5.3 en
// § 8: roosterdag met klein consult, roosterdag zonder declaraties, invaldag boven/onder de drempel, weekend, om-de-week, vakantieweek,
// inschrijfgeld, roosterresolutie grens-exact), uitgebreid met de lagen van het nieuwe plan (handrooster > Nmbrs per weekdag > Nmbrs per week
// met declaratiepatroon > alleen patroon), feestdagen, dienstverband en rolperiodes: samen 30 gevallen. Alles verzonnen.
// Daarna de routes van fase 2 op een verzonnen export (koppelen, voorstel uit verzonnen Nmbrs en dossiers, rollen, handrooster, kengetallen).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const P = require('../pma.js');
const M = require('./pma-maak.js');

const tel = (n, x) => Object.assign({ n, d: n, kort: 0, middel: n, lang: 0, vk: 0, vl: 0, mi: 0, poh: 0, cent: n * 1400 }, x || {});
function reeks(van, tot) { const u = []; for (let d = van; d <= tot;) { u.push(d); const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); d = x.toISOString().slice(0, 10); } return u; }
const wd = (d) => (new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7;
// september–oktober 2026 (geen feestdagen); maandag 7-9-2026
const GEDEKT = new Set(reeks('2026-08-31', '2026-10-25'));
const VAST = [1, 1, 0, 1, 0, 0, 0].map((x) => x * 8);   // ma, di, do 8 uur
function vaste(dagenWd, uitzondering) {   // declaraties op de gegeven weekdagen in alle gedekte weken
  const m = new Map();
  for (const d of GEDEKT) if (dagenWd.includes(wd(d))) m.set(d, tel(12));
  for (const [d, t] of Object.entries(uitzondering || {})) { if (t === null) m.delete(d); else m.set(d, t); }
  return m;
}
const op = (u, d) => u.find((x) => x.dag === d);
const R = (x) => P.werkdagenVan(Object.assign({ gedekt: GEDEKT, drempel: 5 }, x));
const GEVALLEN = [];
const geval = (naam, f) => GEVALLEN.push([naam, f]);

geval('1 roosterdag met één klein consult telt als volle werkdag (drempel niet op roosterdagen)', () => {
  const u = R({ dagen: vaste([0, 1, 3], { '2026-09-08': tel(1) }), hand: [{ ingang: '2026-01-01', uren: VAST }] });
  assert.deepStrictEqual([op(u, '2026-09-08').soort, op(u, '2026-09-08').uren], ['gewerkt', 8]);
});
geval('2 roosterdag zonder declaraties = afwezig', () => {
  const u = R({ dagen: vaste([0, 1, 3], { '2026-09-08': null }), hand: [{ ingang: '2026-01-01', uren: VAST }] });
  assert.deepStrictEqual([op(u, '2026-09-08').soort, op(u, '2026-09-08').uren], ['afwezig', null]);
});
geval('3 niet-roosterdag ma–vr boven de drempel = invaldag met de gemiddelde daguren', () => {
  const u = R({ dagen: vaste([0, 1, 3], { '2026-09-09': tel(6) }), hand: [{ ingang: '2026-01-01', uren: [8, 8, 0, 5, 0, 0, 0] }] });
  assert.deepStrictEqual([op(u, '2026-09-09').soort, op(u, '2026-09-09').uren], ['invaldag', 7]);
});
geval('4 niet-roosterdag ma–vr onder de drempel = los (geen werkdag)', () => {
  const u = R({ dagen: vaste([0, 1, 3], { '2026-09-09': tel(2) }), hand: [{ ingang: '2026-01-01', uren: VAST }] });
  assert.deepStrictEqual([op(u, '2026-09-09').soort, op(u, '2026-09-09').uren], ['los', null]);
});
geval('5 zaterdag met declaraties = weekend, nooit werkdag', () => {
  const u = R({ dagen: vaste([0, 1, 3], { '2026-09-12': tel(3) }), hand: [{ ingang: '2026-01-01', uren: VAST }] });
  assert.deepStrictEqual([op(u, '2026-09-12').soort, op(u, '2026-09-12').uren], ['weekend', null]);
});
geval('6 zondag met veel declaraties = weekend, ook boven de drempel', () => {
  const u = R({ dagen: vaste([0, 1, 3], { '2026-09-13': tel(40) }), hand: [{ ingang: '2026-01-01', uren: VAST }] });
  assert.strictEqual(op(u, '2026-09-13').soort, 'weekend');
});
geval('7 weekend zonder declaraties geeft geen rij', () => {
  const u = R({ dagen: vaste([0, 1, 3]), hand: [{ ingang: '2026-01-01', uren: VAST }] });
  assert.strictEqual(u.filter((x) => wd(x.dag) > 4).length, 0);
});
geval('8 om-de-week: alleen de weken met declaraties hebben gewerkte dagen, nooit een invaldag', () => {
  const m = new Map(); for (const d of GEDEKT) { const w = Math.floor((Date.parse(d) - Date.parse('2026-08-31')) / (7 * 86400000)); if (w % 2 === 0 && wd(d) === 1) m.set(d, tel(10)); }
  const u = R({ dagen: m });
  assert.strictEqual(u.filter((x) => x.soort === 'gewerkt').length, m.size);
  assert.strictEqual(u.filter((x) => x.soort === 'invaldag').length, 0);
});
geval('9 een hele week zonder declaraties (vakantie): de roosterdagen zijn afwezig, niets gewerkt', () => {
  const zonder = {}; for (const d of reeks('2026-09-14', '2026-09-20')) zonder[d] = null;
  const u = R({ dagen: vaste([0, 1, 3], zonder) });
  const w = u.filter((x) => x.dag >= '2026-09-14' && x.dag <= '2026-09-20');
  assert.deepStrictEqual(w.map((x) => x.soort), ['afwezig', 'afwezig', 'afwezig']);
});
geval('10 roosterresolutie grens-exact: op de ingangsdatum geldt het nieuwe rooster', () => {
  const u = R({ dagen: vaste([0, 1, 2, 3]), hand: [{ ingang: '2026-01-01', uren: VAST }, { ingang: '2026-09-16', uren: [8, 8, 8, 8, 0, 0, 0] }] });
  assert.deepStrictEqual([op(u, '2026-09-16').soort, op(u, '2026-09-16').uren], ['gewerkt', 8]);
});
geval('11 roosterresolutie: de dag vóór de ingangsdatum houdt het oude rooster', () => {
  const u = R({ dagen: vaste([0, 1, 2, 3]), hand: [{ ingang: '2026-01-01', uren: VAST }, { ingang: '2026-09-16', uren: [8, 8, 8, 8, 0, 0, 0] }] });
  assert.strictEqual(op(u, '2026-09-09').soort, 'invaldag');
});
geval('12 handrooster gaat voor Nmbrs', () => {
  const u = R({ dagen: vaste([0, 1, 3]), hand: [{ ingang: '2026-01-01', uren: [6, 6, 0, 6, 0, 0, 0] }], nmbrs: { rooster: [{ begin: '2025-01-01', uren: 24, dagen_per_week: 3, dagen1: [8, 8, 0, 8, 0, 0, 0], dagen2: null }] } });
  assert.deepStrictEqual([op(u, '2026-09-07').uren, op(u, '2026-09-07').bron], [6, 'hand']);
});
geval('13 Nmbrs per weekdag (echt patroon) wordt gebruikt', () => {
  const u = R({ dagen: vaste([0, 1, 3]), nmbrs: { rooster: [{ begin: '2025-01-01', uren: 20, dagen_per_week: 3, dagen1: [8, 4, 0, 8, 0, 0, 0], dagen2: [8, 4, 0, 8, 0, 0, 0] }] } });
  assert.deepStrictEqual([op(u, '2026-09-08').uren, op(u, '2026-09-08').bron], [4, 'nmbrs-dag']);
});
geval('14 Nmbrs gelijk verdeeld over ma–vr bij drie dagen = geen echt patroon → uren per week over het declaratiepatroon', () => {
  const u = R({ dagen: vaste([0, 1, 3]), nmbrs: { rooster: [{ begin: '2025-01-01', uren: 24, dagen_per_week: 3, dagen1: [4.8, 4.8, 4.8, 4.8, 4.8, 0, 0], dagen2: null }] } });
  assert.deepStrictEqual([op(u, '2026-09-07').uren, op(u, '2026-09-07').bron, op(u, '2026-09-09')], [8, 'nmbrs-week', undefined]);
});
geval('15 Nmbrs week 1 ≠ week 2 (om-de-week): niet als patroon gebruiken', () => {
  const u = R({ dagen: vaste([0, 1, 3]), nmbrs: { rooster: [{ begin: '2025-01-01', uren: 20, dagen_per_week: 2.5, dagen1: [8, 8, 0, 8, 0, 0, 0], dagen2: [8, 0, 0, 8, 0, 0, 0] }] } });
  assert.strictEqual(op(u, '2026-09-07').bron, 'nmbrs-week');
});
test('review MOET 3: een ingevulde nulweek 2 maakt het rooster om-de-week (geen vast patroon)', () => {
  assert.strictEqual(P.nmbrsDagenEcht({ dagen1: [8, 8, 0, 8, 0, 0, 0], dagen2: [0, 0, 0, 0, 0, 0, 0], dagen_per_week: 3 }), null);
  assert.deepStrictEqual(P.nmbrsDagenEcht({ dagen1: [8, 8, 0, 8, 0, 0, 0], dagen2: null, dagen_per_week: 3 }), [8, 8, 0, 8, 0, 0, 0]);
});
geval('16 Nmbrs uren per week + patroon: daguren = weekuren / aantal patroondagen', () => {
  const u = R({ dagen: vaste([0, 1, 3]), nmbrs: { rooster: [{ begin: '2025-01-01', uren: 18, dagen_per_week: 3 }] } });
  assert.strictEqual(op(u, '2026-09-10').uren, 6);
});
geval('17 geen rooster-uren in Nmbrs: de contracturen', () => {
  const u = R({ dagen: vaste([0, 1, 3]), nmbrs: { rooster: [{ begin: '2025-01-01', uren: null }], contract: [{ begin: '2025-01-01', eind: null, uren: 27 }] } });
  assert.deepStrictEqual([op(u, '2026-09-07').uren, op(u, '2026-09-07').bron], [9, 'nmbrs-week']);
});
geval('18 zonder rooster en zonder Nmbrs: werkdagen uit het patroon, uren onbekend', () => {
  const u = R({ dagen: vaste([0, 1, 3], { '2026-09-08': null }) });
  assert.deepStrictEqual([op(u, '2026-09-07').soort, op(u, '2026-09-07').uren, op(u, '2026-09-07').bron, op(u, '2026-09-08').soort], ['gewerkt', null, 'patroon', 'afwezig']);
});
geval('19 te weinig geschiedenis (één actieve week in het venster): gewerkt zonder patroon, nooit afwezig', () => {
  const m = new Map([['2026-09-07', tel(10)], ['2026-09-08', tel(10)]]);
  const u = P.werkdagenVan({ dagen: m, gedekt: GEDEKT, drempel: 5 });
  assert.deepStrictEqual(u.map((x) => [x.soort, x.bron]), [['gewerkt', 'zonder-patroon'], ['gewerkt', 'zonder-patroon']]);
});
geval('20 een dag die geen export dekt is niet afwezig (geen rij)', () => {
  const gedekt = new Set([...GEDEKT].filter((d) => d !== '2026-09-08'));
  const u = P.werkdagenVan({ dagen: vaste([0, 1, 3], { '2026-09-08': null }), gedekt, drempel: 5, hand: [{ ingang: '2026-01-01', uren: VAST }] });
  assert.strictEqual(op(u, '2026-09-08'), undefined);
});
geval('21 feestdag op een roosterdag zonder declaraties = feestdag, niet afwezig (2e paasdag 6-4-2026)', () => {
  const gedekt = new Set(reeks('2026-03-02', '2026-04-26'));
  const m = new Map(); for (const d of gedekt) if (wd(d) === 0 && d !== '2026-04-06') m.set(d, tel(10));
  const u = P.werkdagenVan({ dagen: m, gedekt, drempel: 5, feest: new Set(P.feestdagen(2026)) });
  assert.strictEqual(op(u, '2026-04-06').soort, 'feestdag');
});
geval('22 feestdag met declaraties op een roosterdag = gewerkt (Hemelvaart 14-5-2026)', () => {
  const gedekt = new Set(reeks('2026-04-13', '2026-06-07'));
  const m = new Map(); for (const d of gedekt) if (wd(d) === 3) m.set(d, tel(10));
  const u = P.werkdagenVan({ dagen: m, gedekt, drempel: 5, feest: new Set(P.feestdagen(2026)) });
  assert.strictEqual(op(u, '2026-05-14').soort, 'gewerkt');
});
geval('23 buiten het dienstverband (Nmbrs) zonder declaraties: geen rij', () => {
  const u = R({ dagen: vaste([0, 1, 3], { '2026-10-12': null, '2026-10-13': null, '2026-10-15': null }), hand: [{ ingang: '2026-01-01', uren: VAST }],
    nmbrs: { dienst: [{ begin: '2020-01-01', eind: '2026-10-11' }], rooster: [] } });
  assert.deepStrictEqual([op(u, '2026-10-12'), op(u, '2026-10-05').soort], [undefined, 'gewerkt']);
});
geval('24 declaraties buiten elke rolperiode: wel een rij, rol leeg', () => {
  const u = R({ dagen: vaste([0, 1, 3]), rollen: [{ rol: 'assistente', van: '2026-09-14', tot: null }] });
  assert.deepStrictEqual([op(u, '2026-09-07').soort, op(u, '2026-09-07').rol, op(u, '2026-09-14').rol], ['gewerkt', null, 'assistente']);
});
geval('25 twee rollen na elkaar: op de begindatum van de tweede geldt die', () => {
  const u = R({ dagen: vaste([0, 1, 3]), rollen: [{ rol: 'assistente', van: '2026-01-01', tot: '2026-09-27' }, { rol: 'poh-s', van: '2026-09-28', tot: null }] });
  assert.deepStrictEqual([op(u, '2026-09-24').rol, op(u, '2026-09-28').rol], ['assistente', 'poh-s']);
});
geval('26 precies op de drempel = invaldag (≥)', () => {
  const u = R({ dagen: vaste([0, 1, 3], { '2026-09-09': tel(5) }), hand: [{ ingang: '2026-01-01', uren: VAST }] });
  assert.strictEqual(op(u, '2026-09-09').soort, 'invaldag');
});
geval('27 vaste dagen ma/di/do: afwezig valt nooit op wo of vr', () => {
  const zonder = {}; for (const d of reeks('2026-09-21', '2026-09-27')) zonder[d] = null;
  const u = R({ dagen: vaste([0, 1, 3], zonder) });
  assert.ok(u.filter((x) => x.soort === 'afwezig').every((x) => [0, 1, 3].includes(wd(x.dag))));
});
geval('28 helft-regel: een weekdag in precies de helft van de actieve weken is een werkdag', () => {
  const m = vaste([0, 1]);
  for (const d of GEDEKT) { const w = Math.floor((Date.parse(d) - Date.parse('2026-08-31')) / (7 * 86400000)); if (wd(d) === 3 && w % 2 === 0) m.set(d, tel(10)); }
  const u = R({ dagen: m });
  const do2 = u.find((x) => x.dag === '2026-09-10');   // week 1 (oneven): geen declaratie op donderdag
  assert.strictEqual(do2 && do2.soort, 'afwezig');
});
geval('29 weekenduren in een handrooster maken het weekend geen werkdag', () => {
  const u = R({ dagen: vaste([0, 1, 3], { '2026-09-12': tel(9) }), hand: [{ ingang: '2026-01-01', uren: [8, 8, 0, 8, 0, 4, 0] }] });
  assert.deepStrictEqual([op(u, '2026-09-12').soort, u.some((x) => x.dag === '2026-09-19')], ['weekend', false]);
});
geval('30 feestdagen: Pasen 2026 en Koningsdag op zaterdag 26-4-2025, Bevrijdingsdag alleen in een lustrumjaar', () => {
  assert.deepStrictEqual(P.feestdagen(2026), ['2026-01-01', '2026-04-06', '2026-04-27', '2026-05-14', '2026-05-25', '2026-12-25', '2026-12-26']);
  assert.ok(P.feestdagen(2025).includes('2025-04-26') && P.feestdagen(2025).includes('2025-05-05'));
});
// wv3054 (gemeten op de echte koppeling van 14-11-2026): het patroonvenster liep 4 weken voor de eerste en na de laatste declaratie door
// (vertrokken stagiair/leerling kreeg weken afwezig), en een verzamelnaam (groep waarnemers) kreeg afwezige dagen.
geval('31 zonder rooster: na de laatste declaratie (vertrokken) geen afwezig', () => {
  const zonder = {}; for (const d of reeks('2026-10-05', '2026-10-25')) zonder[d] = null;
  const u = R({ dagen: vaste([0, 1, 3], zonder), rollen: [{ rol: 'stagiair', van: '2026-08-31', tot: null }] });
  assert.deepStrictEqual([op(u, '2026-10-05'), op(u, '2026-10-12'), op(u, '2026-10-01').soort], [undefined, undefined, 'gewerkt']);
});
geval('32 zonder rooster: vóór de eerste declaratie (later begonnen) geen afwezig; ertussen wel', () => {
  const zonder = { '2026-09-29': null }; for (const d of reeks('2026-08-31', '2026-09-20')) zonder[d] = null;
  const u = R({ dagen: vaste([0, 1, 3], zonder), rollen: [{ rol: 'poh-ggz', van: '2026-01-01', tot: null }] });   // rol al eerder (andere praktijk)
  assert.deepStrictEqual([op(u, '2026-09-14'), op(u, '2026-09-29').soort], [undefined, 'afwezig']);
});
geval('33 met handrooster blijft een lege roosterdag na de laatste declaratie afwezig (binnen de rol)', () => {
  const u = R({ dagen: vaste([0, 1, 3], { '2026-10-19': null, '2026-10-20': null, '2026-10-22': null }), hand: [{ ingang: '2026-01-01', uren: VAST }],
    rollen: [{ rol: 'assistente', van: '2026-01-01', tot: null }] });
  assert.strictEqual(op(u, '2026-10-19').soort, 'afwezig');
});
geval('34 groep (verzamelnaam): nooit afwezig, declaratiedagen blijven gewerkt', () => {
  const u = R({ groep: true, dagen: vaste([0, 1, 3], { '2026-09-08': null }) });
  assert.deepStrictEqual([op(u, '2026-09-08'), op(u, '2026-09-07').soort, u.some((x) => x.soort === 'afwezig')], [undefined, 'gewerkt', false]);
});
for (const [naam, f] of GEVALLEN) test('werkdag ' + naam, f);
test('de toetslijst heeft 34 gevallen', () => assert.strictEqual(GEVALLEN.length, 34));

// ── namen en rollen ──
test('naam ontleden en vergelijken (voorletter + achternaam, tussenvoegsel, dubbele naam)', () => {
  assert.strictEqual(P.lijkt(P.ontleedNaam('A. de Proef'), P.ontleedNaam('Anke de Proef')), 2);
  assert.strictEqual(P.lijkt(P.ontleedNaam('A.B. van Testmans'), P.ontleedNaam('Anke Testmans-Verzonnen')), 1);
  assert.strictEqual(P.lijkt(P.ontleedNaam('B. de Proef'), P.ontleedNaam('Anke de Proef')), 0);
  assert.strictEqual(P.lijkt(P.ontleedNaam('Anke Proef'), P.ontleedNaam('Bea Proef')), 0);
  assert.deepStrictEqual(['Doktersassistente', 'POH-S', 'PO GGZ', 'Huisarts in opleiding', 'Praktijkmanager', 'Waarnemend huisarts'].map(P.rolUit),
    ['assistente', 'poh-s', 'poh-ggz', 'aios', 'overig', 'waarnemer']);
});

// ── routes op een verzonnen export ──
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pma2-')); }
const { exportPersoneel, NEP_PERSONEEL: NEP } = M;
function lees(m, zip) {
  const c = m.app({ methode: 'POST', pad: '/app/pma/controleer', body: { naam: 'x.zip', zip: zip.toString('base64') } });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  const i = m.app({ methode: 'POST', pad: '/app/pma/inlees', body: { sha: c.body.sha } });
  assert.strictEqual(i.status, 200, JSON.stringify(i.body));
}
test('personeel: voorstellen uit Nmbrs, dossier en codes; verzamelnaam als groep; arts-hint bij een AGB', () => {
  const m = P.maak({ map: tmp(), personeel: () => NEP });
  lees(m, exportPersoneel());
  const u = m.app({ methode: 'GET', pad: '/app/pma/personeel' });
  assert.strictEqual(u.status, 200);
  const r = (n) => u.body.registreerders.find((x) => x.naam === n);
  assert.deepStrictEqual([r('A. Proefsen').voorstel.nieuw.nmbrs, r('A. Proefsen').voorstel.nieuw.dossier, r('A. Proefsen').voorstel.rollen.map((x) => [x.rol, x.van])],
    [NEP.medewerkers[0].id, NEP.medewerkers[0].dossier, [['assistente', '2024-03-01']]]);
  assert.deepStrictEqual([r('B. Verzonnen').voorstel.nieuw.dienst, r('B. Verzonnen').voorstel.rollen[0].rol], ['pot', 'poh-ggz']);
  assert.deepStrictEqual([r('Waarnemer2 Proefpraktijk').soort, r('Waarnemer2 Proefpraktijk').voorstel.nieuw.groep, r('Waarnemer2 Proefpraktijk').voorstel.rollen[0].rol], ['verzamel', true, 'waarnemer']);
  assert.deepStrictEqual([r('Q. Artsma').voorstel.nieuw.dossier, r('Q. Artsma').voorstel.rollen[0].rol], [NEP.dossiers[1].pad, 'huisarts-praktijkhouder']);
  assert.ok(!(r('Z. Proefhouder') || {}).voorstel, 'inschrijfgeld-naam zonder verrichtingen krijgt geen voorstel');
});
test('koppelen, rollen, handrooster → werkdagen; inschrijfgeld telt nooit; schrijfroutes weigeren onzin', () => {
  const m = P.maak({ map: tmp(), personeel: () => NEP });
  lees(m, exportPersoneel());
  const g = () => m.app({ methode: 'GET', pad: '/app/pma/personeel' }).body;
  const post = (pad, body) => m.app({ methode: 'POST', pad: '/app/pma/' + pad, body });
  let b = g();
  const v = b.registreerders.find((x) => x.naam === 'A. Proefsen').voorstel;
  assert.strictEqual(post('koppel', { praktijk: 'TG', naam: 'A. Proefsen', nieuw: v.nieuw, rollen: v.rollen }).status, 200);
  const q = b.registreerders.find((x) => x.naam === 'Q. Artsma').voorstel;
  const kq = post('koppel', { praktijk: 'TG', naam: 'Q. Artsma', nieuw: q.nieuw, rollen: q.rollen });
  assert.strictEqual(kq.status, 200);
  // zelfde Nmbrs-medewerker nog eens = dezelfde persoon
  assert.strictEqual(post('koppel', { praktijk: 'TG', naam: 'B. Verzonnen', nieuw: { naam: 'x y', nmbrs: NEP.medewerkers[0].id } }).body.persoon, 1);
  // review MOET 1: B werkt via POT; zijn Nmbrs-rooster (8 uur, 1 dag) geldt niet bij TG → alleen het patroon, uren onbekend
  const kb = post('koppel', { praktijk: 'TG', naam: 'B. Verzonnen', nieuw: { naam: 'Bram Verzonnen', nmbrs: NEP.medewerkers[1].id, dienst: 'pot' }, rollen: [{ rol: 'poh-ggz', van: '2025-01-01' }] });
  const wb = g().werkdagen.TG[String(kb.body.persoon)];
  assert.deepStrictEqual(wb.find((x) => x[0] === '2026-09-09').slice(1, 5), ['gewerkt', null, 'poh-ggz', 'patroon']);
  assert.strictEqual(post('koppel', { praktijk: 'TG', naam: 'B. Verzonnen', los: true }).status, 200);
  // onzin
  assert.strictEqual(post('koppel', { praktijk: 'TG', naam: 'Bestaat Niet', persoon: 1 }).status, 404);
  assert.strictEqual(post('koppel', { praktijk: 'TG', naam: 'B. Verzonnen', nieuw: { naam: 'B V', dossier: '10_Zakelijk/../../etc/passwd' } }).status, 400);
  assert.strictEqual(post('rol', { persoon: 1, praktijk: 'TG', rol: 'baas', van: '2026-01-01' }).status, 400);
  assert.strictEqual(post('rol', { persoon: 1, praktijk: 'TG', rol: 'poh-s', van: '2026-10-01', tot: '2026-09-01' }).status, 400);
  assert.strictEqual(post('rooster', { persoon: 1, praktijk: 'TG', ingang: '2026-01-01', uren: [8, 8, 8] }).status, 400);
  assert.strictEqual(post('persoon', { id: kq.body.persoon, nmbrs: NEP.medewerkers[0].id }).status, 409);
  b = g();
  const w = b.werkdagen.TG['1'];
  const soort = (d) => (w.find((x) => x[0] === d) || [])[1];
  assert.strictEqual(soort('2026-09-07'), 'gewerkt');
  assert.strictEqual(w.find((x) => x[0] === '2026-09-07')[2], 8, '24 uur over drie patroondagen');
  assert.strictEqual(soort('2026-09-09'), undefined, 'woensdag is geen werkdag van A');
  // arts: elke weekdag; 1-10 (inschrijfgeld op naam van de praktijkhouder, maar dat is een andere naam) telt alleen zijn verrichtingen
  const wq = b.werkdagen.TG[String(kq.body.persoon)];
  assert.strictEqual(wq.find((x) => x[0] === '2026-10-01')[5], 4);
  // handrooster gaat voor: vanaf 1-10 ma t/m vr 6 uur → woensdag wordt afwezig, maandag 6 uur
  assert.strictEqual(post('rooster', { persoon: 1, praktijk: 'TG', ingang: '2026-10-01', uren: [6, 6, 6, 6, 6, 0, 0] }).status, 200);
  b = g();
  const w2 = b.werkdagen.TG['1'];
  assert.deepStrictEqual(w2.find((x) => x[0] === '2026-10-07').slice(1, 3), ['afwezig', null]);
  assert.deepStrictEqual(w2.find((x) => x[0] === '2026-10-05').slice(1, 3), ['gewerkt', 6]);
  assert.strictEqual(w2.find((x) => x[0] === '2026-09-07')[2], 8, 'vóór de ingangsdatum blijft Nmbrs gelden');
  // tweede rol en weer weg
  const r2 = post('rol', { persoon: 1, praktijk: 'TG', rol: 'poh-s', van: '2026-10-19' });
  assert.strictEqual(r2.status, 200);
  b = g();
  assert.strictEqual(b.werkdagen.TG['1'].find((x) => x[0] === '2026-10-19')[3], 'poh-s');
  assert.strictEqual(post('rol', { id: r2.body.id, weg: true }).status, 200);
  // de naam is na bevestigen geen voorstel meer
  assert.ok(!b.registreerders.find((x) => x.naam === 'A. Proefsen').voorstel);
  // geen pseudoniem in het antwoord (deze export heeft geen patiëntnummer; het pseudoniem is ''), geen patiëntnummer
  assert.ok(!/9000\d\d/.test(JSON.stringify(b)));
});
test('andere schrijfwijze (zelfde AGB of bijna dezelfde naam) wordt als dezelfde persoon voorgesteld', () => {
  const m = P.maak({ map: tmp(), personeel: () => NEP });
  lees(m, exportPersoneel());
  const b = m.app({ methode: 'GET', pad: '/app/pma/personeel' }).body;
  const q = b.registreerders.find((x) => x.naam === 'Q. Artsma').voorstel;
  const k = m.app({ methode: 'POST', pad: '/app/pma/koppel', body: { praktijk: 'TG', naam: 'Q. Artsma', nieuw: q.nieuw, rollen: q.rollen } });
  // een latere export schrijft "Q.R. Artsma" met hetzelfde AGB
  const regels = [];
  for (const d of reeks('2026-11-02', '2026-11-06')) regels.push({ pnr: '900001', code: M.C.lang[0], oms: M.C.lang[1], type: 'V', reg: 'Q.R. Artsma', agb: '01990001', tarief: M.C.lang[2], dag: d, factuur: '' });
  lees(m, M.maakExport({ agb: '009870', exportdatum: '2026-11-10', begin: '2026-11-02', eind: '2026-11-06', regels, zonderPnr: true }));
  const b2 = m.app({ methode: 'GET', pad: '/app/pma/personeel' }).body;
  const v = b2.registreerders.find((x) => x.naam === 'Q.R. Artsma').voorstel;
  assert.deepStrictEqual([v.persoon, /zelfde AGB/.test(v.reden)], [k.body.persoon, true]);
});
test('zonder Nmbrs of dossiers (personeel = null) werkt het scherm gewoon', () => {
  const m = P.maak({ map: tmp() });
  lees(m, exportPersoneel());
  const u = m.app({ methode: 'GET', pad: '/app/pma/personeel' });
  assert.strictEqual(u.status, 200);
  assert.ok(u.body.registreerders.some((x) => x.voorstel));
});
