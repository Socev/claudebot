'use strict';
// wv4168: verbruik-vooruit.js — prognose eindstand, sprongen, weken, agentklussen, agents nu. Verzonnen reeksen.
const test = require('node:test');
const assert = require('node:assert');
const V = require('../verbruik-vooruit.js');
const UUR = 3600 * 1000, DAG = 24 * UUR;
const RESET = Date.parse('2026-12-05T21:00:00Z'), START = RESET - 7 * DAG;
// een week met een vast tempo van 10 punt per dag, elk half uur een meting
function week(totDag, tempo, extra) {
  const r = [];
  for (let t = START + 30 * 60000; t <= START + totDag * DAG; t += 30 * 60000) {
    let v = ((t - START) / DAG) * tempo;
    if (extra) v = extra(t, v);
    r.push([new Date(t).toISOString(), null, Math.round(v * 100) / 100, (t - START) / (7 * DAG)]);
  }
  return r;
}
const laatsteVan = (r) => ({ gemeten_op: r[r.length - 1][0], zeven_dagen: r[r.length - 1][2], zeven_dagen_reset: new Date(RESET).toISOString() });

test('vast tempo: eindstand = tempo × 7, vervalt de rest', function () {
  const r = week(4, 0.1);
  const p = V.prognose({ laatste: laatsteVan(r), reeks: r });
  assert.strictEqual(p.te_vroeg, false);
  assert.ok(Math.abs(p.eind_pct - 0.7) < 0.011, p.eind_pct);
  assert.ok(Math.abs(p.vervalt - 0.3) < 0.011, p.vervalt);
  assert.strictEqual(p.basis, 'reset');
  assert.strictEqual(p.eind_op, new Date(RESET).toISOString());
  assert.strictEqual(p.afgeleid, true);
  assert.ok(Math.abs(p.tempo_dag - 0.1) < 0.002);
});
test('te snel: vol vóór de reset, met tijdstip; nooit boven 100%', function () {
  const r = week(3, 0.2);
  const p = V.prognose({ laatste: laatsteVan(r), reeks: r });
  assert.strictEqual(p.eind_pct, 1);
  assert.strictEqual(p.vervalt, 0);
  const vol = Date.parse(p.vol_op);
  assert.ok(Math.abs(vol - (START + 5 * DAG)) < 2 * UUR, p.vol_op);
});
test('te vroeg: minder dan 12 uur na de reset', function () {
  const r = week(0.4, 0.1);
  const p = V.prognose({ laatste: laatsteVan(r), reeks: r });
  assert.strictEqual(p.te_vroeg, true);
  assert.strictEqual(p.eind_pct, null);
});
test('daling zonder reset: tempo vanaf het punt na de daling', function () {
  const D = START + 2 * DAG;
  const r = week(4, 0.1, (t, v) => (t >= D ? 0.02 + ((t - D) / DAG) * 0.05 : v));
  const p = V.prognose({ laatste: laatsteVan(r), reeks: r });
  assert.strictEqual(p.basis, 'daling');
  assert.ok(Math.abs(p.tempo_dag - 0.05) < 0.003, p.tempo_dag);
  const s = V.sprongen(r, new Date(RESET).toISOString(), r[r.length - 1][0]);
  assert.strictEqual(s.sprongen.length, 1);
  assert.strictEqual(s.sprongen[0].soort, 'daling');
});
test('een reset tussen twee metingen heet reset, en de resets in het venster komen mee', function () {
  const vorige = [[new Date(START - 60 * 60000).toISOString(), null, 0.9, 1], [new Date(START + 30 * 60000).toISOString(), null, 0.01, 0]];
  const r = vorige.concat(week(2, 0.1).slice(1));
  const s = V.sprongen(r, new Date(RESET).toISOString(), new Date(START + 2 * DAG).toISOString());
  assert.strictEqual(s.sprongen[0].soort, 'reset');
  assert.deepStrictEqual(s.resets, [new Date(START).toISOString()]);
});
test('einde van het abonnement vóór de reset telt als einde', function () {
  const r = week(4, 0.1);
  const einde = new Date(START + 5 * DAG).toISOString();
  const p = V.prognose({ laatste: laatsteVan(r), reeks: r, einde: einde });
  assert.strictEqual(p.einde_bron, 'abonnement');
  assert.ok(Math.abs(p.eind_pct - 0.5) < 0.011, p.eind_pct);
});
test('ontbrekende of rare invoer: null, geen fout', function () {
  assert.strictEqual(V.prognose(null), null);
  assert.strictEqual(V.prognose({ laatste: { gemeten_op: 'x', zeven_dagen: 0.3, zeven_dagen_reset: null } }), null);
  assert.strictEqual(V.prognose({ laatste: { gemeten_op: '2026-12-06T00:00:00Z', zeven_dagen: 0.3, zeven_dagen_reset: '2026-12-05T21:00:00Z' } }), null);   // reset voorbij
});
test('weken: volle weken + lopende, vorige = laatste volle; onvolledig bij een gat vóór de reset', function () {
  const rij = (dag, eind, gatUur, n) => ({ reset: new Date(RESET - dag * 7 * DAG).toISOString(), eind: eind, hoogste: eind,
    laatste_op: new Date(RESET - dag * 7 * DAG - gatUur * UUR).toISOString(), metingen: n == null ? 300 : n });
  const w = V.weken([rij(3, 0.9, 0.5), rij(10, 0.5, 0.5, 1), rij(2, 0.8, 0.5), rij(1, 0.4, 9), rij(0, 0.3, 50)], new Date(START + 4 * DAG).toISOString());
  assert.deepStrictEqual(w.weken.map((x) => x.eind_pct), [0.9, 0.8, 0.4, 0.3]);   // de week met 1 meting valt weg
  assert.strictEqual(w.weken[3].lopend, true);
  assert.strictEqual(w.vorige.eind_pct, 0.4);
  assert.strictEqual(w.vorige.vervallen, 0.6);
  assert.strictEqual(w.vorige.onvolledig, true);
  assert.deepStrictEqual(V.weken(null, null), { weken: [], vorige: null });
});
test('klussen: vervallende ruimte / (gebruikt × deel agents / starts)', function () {
  const k = V.klussen({ vervalt: 0.3, nu: 0.5, agent_deel: 0.8, starts: 100 });
  assert.strictEqual(k.per_klus, 0.004);
  assert.strictEqual(k.klussen, 75);
  assert.strictEqual(V.klussen({ vervalt: 0.3, nu: 0.5, agent_deel: 0.8, starts: 5 }), null);
  assert.strictEqual(V.klussen({ vervalt: 0.3, nu: 0.5, agent_deel: null, starts: 100 }), null);
});
test('agents nu: alleen running telt als lopend, zoals het Agents-scherm', function () {
  const a = V.agentsNu({ a: { status: 'running' }, b: { status: 'pending' }, c: { status: 'done' }, d: { status: 'running' } }, 5, 71);
  assert.deepStrictEqual(a, { loopt: 2, max: 5, wachten: 71 });
});
test('Codex MOET 1: meting van een week die al voorbij is geeft geen prognose', function () {
  const r = week(4, 0.1);
  assert.strictEqual(V.prognose({ laatste: laatsteVan(r), reeks: r, nu: new Date(RESET + UUR).toISOString() }), null);
  assert.ok(V.prognose({ laatste: laatsteVan(r), reeks: r, nu: new Date(RESET - UUR).toISOString() }));
});
test('Codex MOET 2: vorige week ontbreekt of te weinig metingen = null, nooit een oudere week', function () {
  const rij = (dag, eind, n) => ({ reset: new Date(RESET - dag * 7 * DAG).toISOString(), eind: eind, hoogste: eind, laatste_op: new Date(RESET - dag * 7 * DAG - UUR).toISOString(), metingen: n });
  const nu = new Date(START + 4 * DAG).toISOString();
  assert.strictEqual(V.weken([rij(2, 0.8, 300), rij(1, 0.4, 3), rij(0, 0.3, 50)], nu).vorige, null);
  assert.strictEqual(V.weken([rij(2, 0.8, 300), rij(0, 0.3, 50)], nu).vorige, null);
  assert.strictEqual(V.weken([rij(2, 0.8, 300), rij(1, 0.4, 300), rij(0, 0.3, 50)], nu).vorige.eind_pct, 0.4);
});
