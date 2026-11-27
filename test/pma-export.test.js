'use strict';
// wv4219 (besluitenpagina nr 931 = L31): PMA-exportherinnering. pma.js exportHerinnering (puur) met verzonnen datums, en server.js
// pmaExportStap (uit de bron geknipt, met stubs): kaart, sluiten, ochtendregel, nooit dubbel, te laat, fout = ok:false zonder staat.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../pma.js');
const H = P.exportHerinnering;
const TG = (tot) => ({ code: 'TG', naam: 'Tolgaarde', data_tot: tot });
const GH = (tot) => ({ code: 'GH', naam: 'Groenhouten', data_tot: tot });

test('toets uit de opdracht: 2-1 data tot 31-12 → kaart; data tot 2-1 → niets; 20-2 data tot 1-1 → regel; tweede keer → niets', () => {
  let u = H({ vandaag: '2027-01-02', praktijken: [TG('2026-12-31')], staat: {}, open: [] });
  assert.ok(u.kaart && u.kaart.sleutel === 'pma-kwartaal-2027-q1', JSON.stringify(u));
  assert.strictEqual(u.regel, null);
  assert.ok(/1-1-2027/.test(u.kaart.waarom) && /Tolgaarde cijfers tot 31-12-2026/.test(u.kaart.waarom), u.kaart.waarom);
  assert.ok(u.kaart.stappen[0].includes('gegevensset PMA') && u.kaart.stappen[0].includes('1-1-2027 t/m vandaag'));
  assert.ok(u.kaart.titel.length <= 90 && u.kaart.soort === 'doen' && u.kaart.herkomst.doel.scherm === 'pma');
  // tweede dag van dezelfde week: staat zegt al gezet → geen tweede kaart
  const u2 = H({ vandaag: '2027-01-03', praktijken: [TG('2026-12-31')], staat: u.staat, open: [{ sleutel: 'pma-kwartaal-2027-q1', titel: u.kaart.titel, status: 'open' }] });
  assert.strictEqual(u2.kaart, null); assert.strictEqual(u2.regel, null); assert.deepStrictEqual(u2.sluit, []);
  u = H({ vandaag: '2027-01-02', praktijken: [TG('2027-01-02')], staat: {}, open: [] });
  assert.strictEqual(u.kaart, null); assert.strictEqual(u.regel, null); assert.deepStrictEqual(u.sluit, []);
  u = H({ vandaag: '2027-02-20', praktijken: [TG('2027-01-01')], staat: {}, open: [] });
  assert.strictEqual(u.kaart, null);
  assert.ok(u.regel && /Tolgaarde lopen tot 1-1-2027 \(50 dagen\)/.test(u.regel), u.regel);
  const st = u.staat; u.regel_voor.forEach((r) => { st.gemeld[r.code] = r.data_tot; });
  u = H({ vandaag: '2027-02-21', praktijken: [TG('2027-01-01')], staat: st, open: [] });
  assert.strictEqual(u.regel, null, 'nooit twee keer dezelfde');
  // nieuwe export die nog steeds achterloopt = nieuwe stand → mag één keer
  u = H({ vandaag: '2027-04-30', praktijken: [TG('2027-03-01')], staat: st, open: [] });
  assert.ok(u.regel);
});
test('eerste week: grens, andere open exportkaart (L26), oude kwartaalkaart blokkeert niet (Codex MOET 1)', () => {
  assert.ok(H({ vandaag: '2027-04-07', praktijken: [TG('2027-03-20')], staat: {}, open: [] }).kaart, 'dag 7 telt nog');
  assert.strictEqual(H({ vandaag: '2027-04-08', praktijken: [TG('2027-03-20')], staat: {}, open: [] }).kaart, null, 'dag 8 niet meer');
  const l26 = { sleutel: 'wv4316', titel: 'PMA — exports 2024, 2025 en Groenhouten uit Promedico halen', status: 'open' };
  let u = H({ vandaag: '2027-01-02', praktijken: [TG('2026-11-01')], staat: {}, open: [l26] });
  assert.strictEqual(u.kaart, null); assert.ok(u.reden.includes('andere exportkaart open'));
  assert.strictEqual(u.staat.kaarten['pma-kwartaal-2027-q1'], undefined, 'morgen opnieuw kijken');
  // L26 dicht (status gedaan telt niet als open)
  assert.ok(H({ vandaag: '2027-01-03', praktijken: [TG('2026-11-01')], staat: u.staat, open: [Object.assign({}, l26, { status: 'gedaan' })] }).kaart);
  // oude kwartaalkaart nog open: nieuwe kaart komt, oude gaat dicht
  u = H({ vandaag: '2027-04-01', praktijken: [TG('2027-01-05')], staat: { kaarten: { 'pma-kwartaal-2027-q1': '2027-01-02' } }, open: [{ sleutel: 'pma-kwartaal-2027-q1', titel: 'PMA — nieuw kwartaal: export t/m vandaag inlezen', status: 'later' }] });
  assert.strictEqual(u.kaart.sleutel, 'pma-kwartaal-2027-q2');
  assert.deepStrictEqual(u.sluit.map((s) => [s.sleutel, s.van]), [['pma-kwartaal-2027-q1', 'later']]);
  assert.strictEqual(u.regel, null, 'naast een nieuwe kaart geen regel (ook al > 45 dagen)');
});
test('kaart dicht als de data bij is; zolang hij open staat geen ochtendregel', () => {
  const open = [{ sleutel: 'pma-kwartaal-2027-q1', titel: 'PMA — nieuw kwartaal: export t/m vandaag inlezen', status: 'open' }];
  let u = H({ vandaag: '2027-01-12', praktijken: [TG('2027-01-11')], staat: { kaarten: { 'pma-kwartaal-2027-q1': '2027-01-02' } }, open });
  assert.deepStrictEqual(u.sluit.map((s) => s.sleutel), ['pma-kwartaal-2027-q1']);
  assert.ok(/Gezien: PMA heeft nu cijfers t\/m 11-1-2027/.test(u.sluit[0].bewijs));
  u = H({ vandaag: '2027-02-20', praktijken: [TG('2026-12-01')], staat: { kaarten: { 'pma-kwartaal-2027-q1': '2027-01-02' } }, open });
  assert.deepStrictEqual(u.sluit, []); assert.strictEqual(u.regel, null, 'kaart staat nog open en zegt het al');
  u = H({ vandaag: '2027-02-20', praktijken: [TG('2026-12-01')], staat: { kaarten: { 'pma-kwartaal-2027-q1': '2027-01-02' } }, open: [] });
  assert.ok(u.regel, 'kaart weggetikt: wel de regel');
});
test('januari: vorig jaar niet af → extra stap; twee praktijken; geen data → niets', () => {
  let u = H({ vandaag: '2027-01-04', praktijken: [TG('2026-11-01'), GH('2026-12-31')], staat: {}, open: [] });
  assert.ok(u.kaart.stappen.some((s) => /^Tolgaarde: exporteer ook 2026 \(1-1 t\/m 31-12\)/.test(s)), u.kaart.stappen.join('|'));
  assert.ok(!u.kaart.stappen.some((s) => /^Groenhouten: exporteer ook/.test(s)));
  assert.ok(/Tolgaarde cijfers tot 1-11-2026 en van Groenhouten cijfers tot 31-12-2026/.test(u.kaart.waarom), u.kaart.waarom);
  u = H({ vandaag: '2027-04-02', praktijken: [TG('2027-03-31')], staat: {}, open: [] });
  assert.ok(!u.kaart.stappen.some((s) => /exporteer ook/.test(s)), 'alleen in januari');
  u = H({ vandaag: '2027-01-02', praktijken: [], staat: {}, open: [] });
  assert.strictEqual(u.kaart, null); assert.strictEqual(u.regel, null);
  u = H({ vandaag: '2027-02-20', praktijken: [TG('2027-01-01'), GH('2027-02-19')], staat: {}, open: [] });
  assert.ok(/Tolgaarde/.test(u.regel) && !/Groenhouten/.test(u.regel), 'alleen wie achterloopt');
});

// server.js: de stap zelf
const bron = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const a = bron.indexOf('function pmaExportBestand()'), b = bron.indexOf('// ── einde PMA-exportherinnering ──');
assert.ok(a > 0 && b > a, 'stap niet gevonden in server.js');
const stuk = bron.slice(a, b);
function maakStap() {
  const logs = [];
  const f = new Function('require', 'pmaApp', 'path', '__dirname', 'APP_DATA', 'appLeesStreng', 'appSchrijfJson', 'logError', 'schrijfLog', 'nu', 'velden', 'ovisAms', 'appSbRpc', 'loketMeld',
    stuk + '\nreturn pmaExportStap;');
  const lees = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
  const stap = f(require, null, path, path.join(__dirname, '..'), '/bestaat-niet', lees, (p, d) => fs.writeFileSync(p, JSON.stringify(d)), (w, e) => logs.push('F ' + w + ' ' + e.message),
    (r) => logs.push(r), () => 'nu', (o) => JSON.stringify(o), () => ({ datum: '2027-01-02', uur: 6, min: 30 }), () => { throw new Error('geen rpc in de toets'); }, () => { throw new Error('geen loket'); });
  return { stap, logs };
}
function omgeving(dataTot, open) {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'pma-exp-'));
  const zet = [], dicht = [], meld = [];
  return { zet, dicht, meld, opt: {
    mod: { dataTot: () => dataTot }, bestand: path.join(map, 'staat.json'),
    lijst: async () => ({ punten: open }), zet: async (k) => zet.push(k), status: async (x) => dicht.push(x), meld: async (m) => meld.push(m) } };
}
test('stap: kaart één keer per dag, staat bewaard, log zonder inhoud', async () => {
  const { stap, logs } = maakStap();
  const o = omgeving([TG('2026-12-31')], []);
  let r = await stap({ datum: '2027-01-02' }, Object.assign({ ams: { datum: '2027-01-02', uur: 6, min: 31 } }, o.opt));
  assert.strictEqual(r.ok, true); assert.strictEqual(o.zet.length, 1); assert.strictEqual(o.zet[0].sleutel, 'pma-kwartaal-2027-q1');
  r = await stap({ datum: '2027-01-02' }, Object.assign({ ams: { datum: '2027-01-02', uur: 6, min: 40 } }, o.opt));
  assert.strictEqual(r.al_gedaan, true); assert.strictEqual(o.zet.length, 1);
  r = await stap({ datum: '2027-01-03' }, Object.assign({ ams: { datum: '2027-01-03', uur: 6, min: 31 } }, o.opt));
  assert.strictEqual(o.zet.length, 1, 'staat onthoudt de kaart van dit kwartaal');
  assert.ok(logs.every((l) => !/Tolgaarde|cijfers/.test(l)), logs.join('\n'));
});
test('stap: ochtendregel via het loket, te laat = niet gemeld en morgen opnieuw; fout = ok:false zonder staat', async () => {
  const { stap } = maakStap();
  let o = omgeving([TG('2027-01-01')], []);
  let r = await stap({ datum: '2027-02-20' }, Object.assign({ ams: { datum: '2027-02-20', uur: 6, min: 55 } }, o.opt));
  assert.strictEqual(o.meld.length, 0); assert.strictEqual(r.detail.te_laat, true);
  r = await stap({ datum: '2027-02-21' }, Object.assign({ ams: { datum: '2027-02-21', uur: 6, min: 31 } }, o.opt));
  assert.strictEqual(o.meld.length, 1);
  const m = o.meld[0];
  assert.deepStrictEqual([m.app, m.onderwerp, m.laan, m.editie, m.datum, m.link], ['pma', 'achterstand', 'editie', 'ochtend', '2027-02-21', 'https://app.socev.dev/?app=pma']);
  require('../app-nieuws.js').meld(require('../app-nieuws.js').leeg(), m, Date.parse('2027-02-21T05:31:00Z'));   // het echte loket aanvaardt hem
  r = await stap({ datum: '2027-02-22' }, Object.assign({ ams: { datum: '2027-02-22', uur: 6, min: 31 } }, o.opt));
  assert.strictEqual(o.meld.length, 1, 'tweede keer niets');
  // fout bij kaart zetten: ok:false, geen staat → volgende poging opnieuw
  o = omgeving([TG('2026-12-31')], []);
  o.opt.zet = async () => { throw new Error('rpc stuk'); };
  r = await stap({ datum: '2027-01-02' }, Object.assign({ ams: { datum: '2027-01-02', uur: 6, min: 31 } }, o.opt));
  assert.strictEqual(r.ok, false); assert.ok(!fs.existsSync(o.opt.bestand));
  // Voor jou niet te lezen: ok:false
  o = omgeving([TG('2026-12-31')], []); o.opt.lijst = async () => { throw new Error('x'); };
  r = await stap({ datum: '2027-01-02' }, Object.assign({ ams: { datum: '2027-01-02', uur: 6, min: 31 } }, o.opt));
  assert.strictEqual(r.ok, false);
  // alleen PMA-kaarten gaan de pure functie in; L26 blokkeert
  o = omgeving([TG('2026-11-01')], [{ sleutel: 'wv4316', titel: 'PMA — exports 2024, 2025 en Groenhouten uit Promedico halen', status: 'open' }, { sleutel: 'x', titel: 'Iets anders', status: 'open' }]);
  r = await stap({ datum: '2027-01-02' }, Object.assign({ ams: { datum: '2027-01-02', uur: 6, min: 31 } }, o.opt));
  assert.strictEqual(o.zet.length, 0); assert.deepStrictEqual(r.detail.reden, ['andere exportkaart open']);
});
test('pma.maak dataTot: alleen datums, lege databank = lege lijst', () => {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'pma-dt-'));
  const m = P.maak({ map: path.join(map, 'pma'), finPatienten: () => ({}) });
  assert.deepStrictEqual(m.dataTot(), []);
  const M = require('./pma-maak.js');
  const e = M.exportA();
  const c = m.app({ methode: 'POST', pad: '/app/pma/controleer', body: { naam: 'a.zip', zip: M.maakExport(e).toString('base64') } });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body).slice(0, 200));
  const i = m.app({ methode: 'POST', pad: '/app/pma/inlees', body: { sha: c.body.sha } });
  assert.strictEqual(i.status, 200, JSON.stringify(i.body).slice(0, 200));
  assert.deepStrictEqual(m.dataTot(), [{ code: 'TG', naam: 'Tolgaarde', data_tot: '2026-01-31' }]);
});
