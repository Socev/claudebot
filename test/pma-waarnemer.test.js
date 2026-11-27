'use strict';
// wv4218 (besluitenpagina nr 930 = L30): waarnemers uit de verzamelnaam halen met het DocPlan-rooster. Alles verzonnen (namen, rooster, export).
// Regel: op een dag met precies één waarnemer in het rooster van die praktijk (na aftrek van wie onder een eigen naam declareerde) gaan de
// regels van de verzamelnaam naar die waarnemer (bron docplan-rooster); dag met twee waarnemers of zonder rooster = groep.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const P = require('../pma.js');
const { exportPersoneel, NEP_PERSONEEL: NEP } = require('./pma-maak.js');

const W1 = 'aaaaaaaa-0000-0000-0000-000000000001', W2 = 'aaaaaaaa-0000-0000-0000-000000000002', QA = 'aaaaaaaa-0000-0000-0000-000000000003', HA = 'aaaaaaaa-0000-0000-0000-000000000004';
const WN = 'Waarnemend huisarts (ZZP)';
const PERSONEN = [
  { object_id: W1, naam: 'Wanda Proefwaar', rollen: [{ praktijk: 'TG', rol: WN }] },
  { object_id: W2, naam: 'Wim Testneem', rollen: [{ praktijk: 'TG', rol: WN }, { praktijk: 'GH', rol: WN }] },
  { object_id: QA, naam: 'Quinten Artsma', rollen: [{ praktijk: 'TG', rol: WN }] },              // heeft in PMA een eigen naam (Q. Artsma)
  { object_id: HA, naam: 'Hanna Vastarts', rollen: [{ praktijk: 'TG', rol: 'Huisarts in loondienst' }] },   // geen waarnemer: telt nooit mee
];
const d = (pr, obj, datum, dagen) => ({ pr, obj, datum, dagen: dagen == null ? 1 : dagen });
// vrijdagen sep–okt 2026: 4, 11, 18, 25 sep; 2, 9, 16, 23, 30 okt (Waarnemer2 Proefpraktijk declareert elke vrijdag één regel)
const DAGEN = [
  d('TG', W1, '2026-09-04'), d('TG', HA, '2026-09-04'),                 // één waarnemer (+ vaste arts) → W1
  d('TG', W1, '2026-09-11'), d('TG', W2, '2026-09-11'),                 // twee → groep
  /* 18-9: geen rooster → groep */
  d('TG', W2, '2026-09-25'), d('TG', QA, '2026-09-25'),                 // QA declareerde onder eigen naam → W2
  d('TG', QA, '2026-10-02'),                                            // alleen QA, die zelf declareerde → niemand over → groep
  d('TG', W1, '2026-10-09', 0.5),                                       // halve dag → W1
  d('GH', W1, '2026-10-16'),                                            // andere praktijk → groep
  d('TG', W2, '2026-10-23'), d('GH', W1, '2026-10-23'),                 // GH telt niet voor TG → W2
];
const ROOSTER = { dagen: DAGEN, personen: PERSONEN };

test('waarnemerDagen: één → toegewezen, twee → groep, geen rooster → groep, eigen naam telt niet mee', () => {
  const pma = [{ id: 7, naam: 'Quinten Artsma', groep: false, rollen: [{ praktijk: 'TG', rol: 'huisarts-praktijkhouder', van: '2020-01-01', tot: null }] },
    { id: 9, naam: 'Waarnemer2 Proefpraktijk', groep: true, rollen: [{ praktijk: 'TG', rol: 'waarnemer', van: '2026-01-01', tot: null }] }];
  const eigen = new Map([['2026-09-25', new Set([7])], ['2026-10-02', new Set([7])]]);
  const match = new Map();
  const u = P.waarnemerDagen({ praktijk: 'TG', rooster: ROOSTER, personen: pma, eigen, uitMatch: match });
  assert.deepStrictEqual([...u.keys()].sort(), ['2026-09-04', '2026-09-25', '2026-10-09', '2026-10-23']);
  assert.deepStrictEqual([u.get('2026-09-04').obj, u.get('2026-09-25').obj, u.get('2026-10-09').obj, u.get('2026-10-23').obj], [W1, W2, W1, W2]);
  assert.deepStrictEqual([...match], [[QA, 7]]);   // Quinten Artsma (DocPlan) = Q. Artsma (PMA, artsrol bij TG)
  // zonder eigen declaratie van QA is hij op 2-10 de enige: dan naar de bestaande PMA-persoon
  const u2 = P.waarnemerDagen({ praktijk: 'TG', rooster: ROOSTER, personen: pma, eigen: new Map() });
  assert.deepStrictEqual(u2.get('2026-10-02'), { obj: QA, naam: 'Quinten Artsma', pid: 7 });
  assert.ok(!u2.has('2026-09-25'));   // dan zijn er twee (W2 + QA)
  // geen rooster of kapotte vorm = niets
  for (const r of [null, {}, { dagen: 'x', personen: [] }]) assert.strictEqual(P.waarnemerDagen({ praktijk: 'TG', rooster: r, personen: pma }).size, 0);
  // GH: W1 staat daar wel in het rooster maar heeft bij GH geen waarnemerrol → niets (de rol geldt per praktijk)
  assert.deepStrictEqual([...P.waarnemerDagen({ praktijk: 'GH', rooster: ROOSTER, personen: [] }).keys()], []);
  assert.deepStrictEqual([...P.waarnemerDagen({ praktijk: 'GH', rooster: { dagen: DAGEN.concat([d('GH', W2, '2026-10-30')]), personen: PERSONEN }, personen: [] }).keys()], ['2026-10-30']);
  assert.ok(P.dpId(W1) < 0 && P.dpId(W1) === P.dpId(W1) && P.dpId(W1) !== P.dpId(W2));
});

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pma-wn-')); }
function opzet(rooster) {
  const map = tmp();
  const m = P.maak({ map, personeel: () => NEP, rooster: () => rooster });
  const zip = exportPersoneel();
  const c = m.app({ methode: 'POST', pad: '/app/pma/controleer', body: { naam: 'proef.zip', zip: zip.toString('base64') } });
  assert.strictEqual(m.app({ methode: 'POST', pad: '/app/pma/inlees', body: { sha: c.body.sha } }).status, 200);
  const post = (pad, body) => m.app({ methode: 'POST', pad: '/app/pma/' + pad, body });
  const b = m.app({ methode: 'GET', pad: '/app/pma/personeel' }).body;
  for (const n of ['Q. Artsma', 'Waarnemer2 Proefpraktijk']) { const v = b.registreerders.find((x) => x.naam === n).voorstel; assert.strictEqual(post('koppel', { praktijk: 'TG', naam: n, nieuw: v.nieuw, rollen: v.rollen }).status, 200, n); }
  return { m, map, post, pp: () => m.app({ methode: 'GET', pad: '/app/pma/personeel' }).body };
}
const somN = (rows) => rows.reduce((a, r) => a + r[5], 0);

test('route: verzamelregels naar de ene roosterwaarnemer, de rest blijft groep; som gelijk aan het oude groepstotaal', () => {
  const oud = opzet(null).pp(), nu = opzet(ROOSTER).pp();
  const groepId = (pp) => pp.personen.find((p) => p.groep).id;
  const wOud = oud.werkdagen.TG, wNu = nu.werkdagen.TG;
  assert.strictEqual(somN(wOud[groepId(oud)]), 9);   // negen vrijdagen
  assert.deepStrictEqual(oud.docplan, { stand: 'niet te lezen', praktijken: { TG: { dagen_persoon: 0, dagen_groep: 9, regels_persoon: 0, regels_groep: 9, personen: 0 } } });
  assert.ok(!oud.personen.some((p) => p.docplan));
  const dp = nu.personen.filter((p) => p.docplan);
  assert.deepStrictEqual(dp.map((p) => [p.naam, p.groep, p.dienst, p.rollen.length, p.id < 0]), [['Wanda Proefwaar', false, 'zzp', 0, true], ['Wim Testneem', false, 'zzp', 0, true]]);
  const w1 = wNu[dp[0].id], w2 = wNu[dp[1].id];
  assert.deepStrictEqual(w1.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5]]), [['2026-09-04', 'gewerkt', null, 'waarnemer', 'docplan-rooster', 1], ['2026-10-09', 'gewerkt', null, 'waarnemer', 'docplan-rooster', 1]]);
  assert.deepStrictEqual(w2.map((r) => r[0]), ['2026-09-25', '2026-10-23']);
  assert.deepStrictEqual(wNu[groepId(nu)].map((r) => r[0]), ['2026-09-11', '2026-09-18', '2026-10-02', '2026-10-16', '2026-10-30']);
  assert.strictEqual(somN(w1) + somN(w2) + somN(wNu[groepId(nu)]), somN(wOud[groepId(oud)]));
  assert.deepStrictEqual(nu.docplan, { stand: 'ok', praktijken: { TG: { dagen_persoon: 4, dagen_groep: 5, regels_persoon: 4, regels_groep: 5, personen: 2 } } });
  // de anderen (Q. Artsma) veranderen niet
  const q = (pp) => pp.personen.find((p) => p.naam === 'Quinten Artsma' || /Artsma/.test(p.naam) && !p.docplan).id;
  assert.deepStrictEqual(wNu[q(nu)], wOud[q(oud)]);
});

test('route: een DocPlan-waarnemer is niet te koppelen of te bewerken (negatieve id bestaat niet in PMA)', () => {
  const o = opzet(ROOSTER);
  const vid = o.pp().personen.find((p) => p.docplan).id;
  assert.strictEqual(o.post('koppel', { praktijk: 'TG', naam: 'Waarnemer2 Proefpraktijk', persoon: vid }).status, 404);
  assert.strictEqual(o.post('persoon', { id: vid, naam: 'x y' }).status, 404);
  assert.strictEqual(o.post('rol', { persoon: vid, praktijk: 'TG', rol: 'waarnemer', van: '2026-01-01' }).status, 404);
});

test('route: rooster met een rol "waarnemer" bij de groep alleen op de roldag; buiten de rolperiode blijft alles groep', () => {
  const o = opzet(ROOSTER);
  const g = o.pp().personen.find((p) => p.groep);
  const rol = g.rollen[0];
  assert.strictEqual(o.post('rol', { id: rol.id, persoon: g.id, praktijk: 'TG', rol: 'waarnemer', van: '2026-10-01' }).status, 200);
  const pp = o.pp();
  // september valt nu buiten de rol van de groep: die dagen niet verschuiven
  assert.deepStrictEqual(pp.personen.filter((p) => p.docplan).flatMap((p) => pp.werkdagen.TG[p.id].map((r) => r[0])).sort(), ['2026-10-09', '2026-10-23']);
});
