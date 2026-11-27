'use strict';
// wv4126 (C71 stap a): pod-klok in schaduwstand — klokrekening op de Amsterdamse wandklok (ook bij zomer-/wintertijd), niet inhalen na een
// gat, nooit dubbel na een herstart, ontdubbelen na een crash tussen log en staat (Codex MOET 1), vergelijking met n8n-starts (MOET 2).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const K = require('../pod-klok.js');
const MIN = 60000;

function perDag(dag, vanUtc, totUtc) {
  const uit = {};
  K.KLOKKEN.forEach(function (k) { uit[k.klok] = K.starts(K.parseCron(k.cron), vanUtc, totUtc).filter(function (t) { return K.nlDag(t) === dag; }).length; });
  return uit;
}
function dagGrenzen(dag) { const t = Date.parse(dag + 'T00:00:00Z'); return [t - 3 * 3600000, t + 27 * 3600000]; }

test('alle acht cron-regels zijn leesbaar en n8n-regels herkend', function () {
  K.KLOKKEN.forEach(function (k) { assert.ok(K.parseCron(k.cron), k.klok); });
  assert.strictEqual(K.parseCron('5 * * *'), null);
  assert.strictEqual(K.parseCron('61 * * * *'), null);
  assert.strictEqual(K.parseCron('@hourly'), null);
  const tik = K.KLOKKEN.find(function (k) { return k.klok === 'werkvoorraad-tikker'; });
  assert.ok(K.n8nRegelGelijk(tik, { interval: [{ field: 'cronExpression', expression: '1-59/2 * * * *' }] }));
  assert.ok(!K.n8nRegelGelijk(tik, { interval: [{ field: 'cronExpression', expression: '*/2 * * * *' }] }));
  const q = K.KLOKKEN.find(function (k) { return k.klok === 'quotumalarm'; });
  assert.ok(K.n8nRegelGelijk(q, { interval: [{ field: 'minutes', minutesInterval: 30 }] }));
  assert.ok(!K.n8nRegelGelijk(q, { interval: [{ field: 'minutes', minutesInterval: 15 }] }));
});

test('gewone dagen: aantallen en tijden', function () {
  // zaterdag 28-11-2026 (wintertijd)
  const g = dagGrenzen('2026-11-28');
  assert.deepStrictEqual(perDag('2026-11-28', g[0], g[1]), { quotumalarm: 48, 'health-rapporten': 24, 'facturen-ronde': 24, 'bank-ronde': 2,
    'harvester-ronde': 0, 'nieuwsbrief-ronde': 1, 'werkvoorraad-tikker': 720, 'ciso-bezorger': 96 });
  const bank = K.starts(K.parseCron('0 7,18 * * *'), g[0], g[1]).map(K.nlTijd);
  assert.deepStrictEqual(bank, ['2026-11-28 07:00', '2026-11-28 18:00']);
  assert.deepStrictEqual(K.starts(K.parseCron('15 9 * * 6'), g[0], g[1]).map(K.nlTijd), ['2026-11-28 09:15']);
  // zondag 29-11-2026: harvester 09:00, nieuwsbrief niet
  const z = dagGrenzen('2026-11-29');
  const zd = perDag('2026-11-29', z[0], z[1]);
  assert.strictEqual(zd['harvester-ronde'], 1); assert.strictEqual(zd['nieuwsbrief-ronde'], 0);
  // de tikker op oneven minuten
  const t = K.starts(K.parseCron('1-59/2 * * * *'), Date.parse('2026-11-28T10:00:00Z'), Date.parse('2026-11-28T10:06:00Z')).map(K.nlTijd);
  assert.deepStrictEqual(t, ['2026-11-28 11:01', '2026-11-28 11:03', '2026-11-28 11:05']);
  // zomertijd: bank 07:00 NL = 05:00 UTC
  const s = K.starts(K.parseCron('0 7,18 * * *'), Date.parse('2027-06-01T00:00:00Z'), Date.parse('2027-06-02T00:00:00Z'));
  assert.deepStrictEqual(s.map(function (x) { return new Date(x).toISOString().slice(11, 16); }), ['05:00', '16:00']);
});

test('wintertijd in (25-10-2026, dubbel uur): uurklokken 25×, dagklokken 1×', function () {
  const g = dagGrenzen('2026-10-25');
  const d = perDag('2026-10-25', g[0], g[1]);
  assert.strictEqual(d['health-rapporten'], 25); assert.strictEqual(d['facturen-ronde'], 25);
  assert.strictEqual(d.quotumalarm, 50); assert.strictEqual(d['werkvoorraad-tikker'], 750); assert.strictEqual(d['ciso-bezorger'], 100);
  assert.strictEqual(d['bank-ronde'], 2); assert.strictEqual(d['harvester-ronde'], 1);
});

test('zomertijd in (28-3-2027, uur valt weg): uurklokken 23×, dagklokken 1×', function () {
  const g = dagGrenzen('2027-03-28');
  const d = perDag('2027-03-28', g[0], g[1]);
  assert.strictEqual(d['health-rapporten'], 23); assert.strictEqual(d['facturen-ronde'], 23);
  assert.strictEqual(d.quotumalarm, 46); assert.strictEqual(d['werkvoorraad-tikker'], 690);
  assert.strictEqual(d['bank-ronde'], 2); assert.strictEqual(d['harvester-ronde'], 1);
  const bank = K.starts(K.parseCron('0 7,18 * * *'), g[0], g[1]).map(K.nlTijd);
  assert.deepStrictEqual(bank, ['2027-03-28 07:00', '2027-03-28 18:00']);
});

function proef(startIso) {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-klok-'));
  const klok = { t: Date.parse(startIso) };
  const dep = { staatPad: path.join(map, 'pod-klok.json'), logPad: path.join(map, 'schaduw.jsonl'), nu: function () { return klok.t; } };
  const lees = function () { try { return fs.readFileSync(dep.logPad, 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } };
  return { map: map, klok: klok, dep: dep, lees: lees, maak: function () { return K.maak(dep); } };
}

test('tik: eerste keer niet inhalen, elke minuut één keer, gat niet inhalen, herstart niet dubbel', function () {
  const p = proef('2026-11-28T10:04:30Z');   // 11:04:30 NL
  let k = p.maak();
  let u = k.tik();
  assert.deepStrictEqual(u.zou.map(function (z) { return z.klok; }), []);   // 11:04: niets
  assert.strictEqual(p.lees()[0].soort, 'aan');
  p.klok.t += 40000;   // 11:05:10
  u = k.tik(); assert.deepStrictEqual(u.zou.map(function (z) { return z.klok; }).sort(), ['facturen-ronde', 'werkvoorraad-tikker']);
  u = k.tik(); assert.strictEqual(u.zou.length, 0, 'zelfde minuut niet nog eens');
  // herstart binnen dezelfde minuut: nieuwe instantie, zelfde staat
  k = p.maak(); u = k.tik(); assert.strictEqual(u.zou.length, 0, 'na herstart in dezelfde minuut niet dubbel');
  // twee minuten verder in één keer (eventloop even traag): beide minuten verwerkt
  p.klok.t += 2 * MIN;   // 11:07:10
  u = k.tik(); assert.deepStrictEqual(u.zou.map(function (z) { return K.nlTijd(Date.parse(z.tick)); }), ['2026-11-28 11:07']);
  assert.strictEqual(u.gat, null);
  // pod 40 min weg: gat, niet inhalen (geen health 11:23, geen ciso 11:15/11:30/11:45 behalve de huidige minuut)
  p.klok.t = Date.parse('2026-11-28T10:47:10Z');   // 11:47:10
  k = p.maak(); u = k.tik();
  assert.ok(u.gat && u.gat.aantal === 39, 'gat ' + JSON.stringify(u.gat));
  assert.deepStrictEqual(u.zou.map(function (z) { return z.klok; }), ['werkvoorraad-tikker']);
  const h = k.health();
  assert.strictEqual(h.gaten_24u, 1); assert.strictEqual(h.vandaag['facturen-ronde'], 1); assert.strictEqual(h.vandaag['health-rapporten'], undefined);
  fs.rmSync(p.map, { recursive: true, force: true });
});

test('crash tussen log en staat (Codex MOET 1): regel dubbel in het log, health en vergelijk tellen hem één keer', function () {
  const p = proef('2026-11-28T10:04:30Z');
  const k = p.maak(); k.tik();
  p.klok.t = Date.parse('2026-11-28T10:05:10Z'); k.tik();
  // nabootsen: de staat werd niet meer bijgewerkt na het loggen van 11:05
  const s = JSON.parse(fs.readFileSync(p.dep.staatPad, 'utf8')); s.laatste_minuut -= MIN; fs.writeFileSync(p.dep.staatPad, JSON.stringify(s));
  const k2 = p.maak(); const u = k2.tik();
  assert.strictEqual(u.zou.length, 2, 'minuut opnieuw verwerkt');
  assert.strictEqual(p.lees().filter(function (o) { return o.klok === 'facturen-ronde'; }).length, 2, 'dubbel in het log');
  assert.strictEqual(k2.health().vandaag['facturen-ronde'], 1);
  const v = K.vergelijk(p.lees(), { 'facturen-ronde': [Date.parse('2026-11-28T10:05:00.026Z')] }, ['2026-11-28']);
  assert.deepStrictEqual([v.dagen['2026-11-28']['facturen-ronde'].pod, v.dagen['2026-11-28']['facturen-ronde'].gekoppeld], [1, 1]);
  fs.rmSync(p.map, { recursive: true, force: true });
});

test('noodrem: uit() = niets loggen', function () {
  const p = proef('2026-11-28T10:05:10Z');
  const k = K.maak(Object.assign({}, p.dep, { uit: function () { return true; } }));
  assert.deepStrictEqual(k.tik(), { uit: true }); assert.deepStrictEqual(p.lees(), []);
  fs.rmSync(p.map, { recursive: true, force: true });
});

test('vergelijk: koppelen binnen 60 s, alleen-pod, alleen-n8n, n8n-start in een pod-gat', function () {
  const T = function (s) { return Date.parse(s); };
  const schaduw = [
    { soort: 'aan', t: '2026-11-28T08:00:00Z', vanaf: '2026-11-28T08:00:00Z' },
    { soort: 'zou_starten', klok: 'quotumalarm', tick: '2026-11-28T09:00:00.000Z' },
    { soort: 'zou_starten', klok: 'quotumalarm', tick: '2026-11-28T09:30:00.000Z' },
    { soort: 'zou_starten', klok: 'quotumalarm', tick: '2026-11-28T10:00:00.000Z' },
    { soort: 'gat', t: '2026-11-28T11:20:00Z', van: '2026-11-28T10:20:00.000Z', tot: '2026-11-28T11:19:00.000Z', aantal: 60 },
  ];
  const n8n = { quotumalarm: [T('2026-11-28T08:59:44Z'), T('2026-11-28T09:29:44Z'), T('2026-11-28T10:29:44Z'), T('2026-11-28T07:29:44Z')] };
  const r = K.vergelijk(schaduw, n8n, ['2026-11-28']).dagen['2026-11-28'].quotumalarm;
  assert.strictEqual(r.pod, 3); assert.strictEqual(r.n8n, 3, 'n8n-start van vóór de schaduw telt niet');
  assert.strictEqual(r.gekoppeld, 2);
  assert.deepStrictEqual(r.alleen_pod, ['2026-11-28 11:00']);
  assert.deepStrictEqual(r.alleen_n8n, ['2026-11-28 11:29']); assert.strictEqual(r.alleen_n8n_in_gat, 1);
  // één-op-één: twee n8n-starts binnen 60 s van één pod-tick → één gekoppeld, één alleen-n8n
  const r2 = K.koppel([T('2026-11-28T10:00:00Z')], [T('2026-11-28T09:59:50Z'), T('2026-11-28T10:00:30Z')]);
  assert.strictEqual(r2.gekoppeld, 1); assert.strictEqual(r2.alleen_n8n.length, 1);
  // 61 s ernaast = niet dezelfde start
  assert.strictEqual(K.koppel([T('2026-11-28T10:00:00Z')], [T('2026-11-28T10:01:01Z')]).gekoppeld, 0);
});

test('samenvoegen (Codex MOET 2): foutrun binnen 60 s van een luikregel = dezelfde start, anders erbij', function () {
  const T = function (s) { return Date.parse(s); };
  const luik = [T('2026-11-25T08:45:00.08Z'), T('2026-11-25T09:15:00.08Z')];
  const fout = [T('2026-11-25T08:45:00.02Z'), T('2026-11-25T09:00:00.049Z')];   // 08:45 faalde ná de RPC, 09:00 bereikte het luik niet (403)
  assert.deepStrictEqual(K.samenvoegen(luik, fout).map(function (x) { return new Date(x).toISOString().slice(11, 19); }), ['08:45:00', '09:00:00', '09:15:00']);
});
