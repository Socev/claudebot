'use strict';
// wv3967 (David 22-11-2026: Voor jou kort, bijgevuld op vaste momenten): vj-moment.js, het zichtbaarheidsfilter in server.js (toon_vanaf),
// de route-koppeling en Te lezen. Verzonnen kaarten, vaste klok.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const M = require('../vj-moment.js');
const T = require('../te-lezen.js');
const wortel = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(wortel, 'server.js'), 'utf8');
const ms = (s) => Date.parse(s);
const iso = (t) => new Date(t).toISOString();

test('momenten in de winter (UTC+1) en zomer (UTC+2)', function () {
  // maandag 23-11-2026 01:17 NL = 00:17 UTC
  assert.strictEqual(iso(M.laatsteMoment(ms('2026-11-23T00:17:00Z'))), '2026-11-22T16:15:00.000Z');   // gisteren 17:15
  assert.strictEqual(iso(M.volgendMoment(ms('2026-11-23T00:17:00Z'))), '2026-11-23T06:15:00.000Z');   // 07:15
  assert.strictEqual(iso(M.volgendMoment(ms('2026-11-23T06:15:00Z'))), '2026-11-23T11:30:00.000Z');   // precies 07:15 → 12:30
  assert.strictEqual(iso(M.laatsteMoment(ms('2026-11-23T06:15:00Z'))), '2026-11-23T06:15:00.000Z');   // op het moment zelf = dat moment
  assert.strictEqual(iso(M.volgendMoment(ms('2027-06-01T14:00:00Z'))), '2027-06-01T15:15:00.000Z');   // zomer: 17:15 = 15:15 UTC
  // wisseldag 28-3-2027 (02:00 → 03:00): 07:15 zomertijd = 05:15 UTC; de dag ervoor 06:15 UTC
  assert.strictEqual(iso(M.nlMs(2027, 3, 28, 7, 15)), '2027-03-28T05:15:00.000Z');
  assert.strictEqual(iso(M.nlMs(2027, 3, 27, 7, 15)), '2027-03-27T06:15:00.000Z');
  assert.strictEqual(iso(M.nlMs(2026, 10, 25, 17, 15)), '2026-10-25T16:15:00.000Z');   // terug naar wintertijd
});

test('momentstap: alleen in het venster vóór het moment, één keer per moment', function () {
  const m = ms('2026-11-23T06:15:00Z');
  assert.strictEqual(M.stapMoment(ms('2026-11-23T06:08:00Z'), null), null);   // 7 min ervoor: nog niet
  assert.strictEqual(M.stapMoment(ms('2026-11-23T06:09:30Z'), null), m);      // 5,5 min ervoor
  assert.strictEqual(M.stapMoment(ms('2026-11-23T06:10:00Z'), null), m);
  assert.strictEqual(M.stapMoment(ms('2026-11-23T06:10:00Z'), m), null);      // al gedaan
  assert.strictEqual(M.stapMoment(ms('2026-11-23T06:14:45Z'), null), null);   // < 30 s ervoor: te laat (de kaarten worden dan vanzelf zichtbaar)
  assert.strictEqual(M.stapMoment(ms('2026-11-23T11:25:00Z'), m), ms('2026-11-23T11:30:00Z'));   // 12:30 ondanks gedaan 07:15
});

test('momenttekst en machinekamer-herkomst', function () {
  const nu = ms('2026-11-23T09:00:00Z');
  assert.strictEqual(M.momentTekst(ms('2026-11-23T11:30:00Z'), nu), '12:30');
  assert.strictEqual(M.momentTekst(ms('2026-11-24T06:15:00Z'), nu), 'morgen 07:15');
  assert.strictEqual(M.momentTekst(ms('2026-11-25T16:15:00Z'), nu), 'wo 17:15');
  assert.strictEqual(M.isMk({ wv: [3967] }), true);
  assert.strictEqual(M.isMk({ wv: [1], module: 'facturen' }), false);   // dag-module
  assert.strictEqual(M.isMk({ wv: [1], module: 'beleggen' }), true);
  assert.strictEqual(M.isMk({ module: 'intake' }), false);
  assert.strictEqual(M.isMk({ register: ['x'] }), false);
  assert.strictEqual(M.isMk(null), false);
  assert.deepStrictEqual(M.DAG_MODULES.slice().sort(), ['agenda', 'bandjes', 'bank', 'facturen', 'financien', 'intake', 'kalender', 'mail', 'nogbetalen']);
});

test('databank en pod gebruiken dezelfde momenten en dag-modules', function () {
  const sql = fs.readFileSync('/opt/data/mk-scripts/wv3967/nieuw.sql', 'utf8');
  assert.match(sql, /array\[time '07:15', time '12:30', time '17:15'\]/);
  M.DAG_MODULES.forEach(function (m) { assert.ok(sql.includes("'" + m + "'"), m); });
}, { skip: !fs.existsSync('/opt/data/mk-scripts/wv3967/nieuw.sql') });

// appVjZichtbaar en appVjWacht uit server.js (los geknipt)
function knip(naam) {
  const i = src.indexOf('function ' + naam + '(');
  assert.ok(i > 0, naam);
  const j = src.indexOf('\n}\n', i);
  const eenregel = src.indexOf('\n', i);
  return src.slice(i, src.slice(i, eenregel).trim().endsWith('}') ? eenregel : j + 2);
}
const zicht = new Function(knip('appVjZichtbaar') + '\n' + knip('appVjWacht') + '\nreturn { z: appVjZichtbaar, w: appVjWacht };')();

test('zichtbaarheidsfilter: toon_vanaf in de toekomst = wacht, null of verleden = zichtbaar', function () {
  const nu = ms('2026-11-23T10:00:00Z'), vandaag = '2026-11-23';
  const k = (o) => Object.assign({ id: 1, status: 'open', toon_vanaf: null }, o);
  assert.strictEqual(zicht.z(k(), vandaag, nu), true);
  assert.strictEqual(zicht.z(k({ toon_vanaf: '2026-11-23T11:30:00+00:00' }), vandaag, nu), false);
  assert.strictEqual(zicht.z(k({ toon_vanaf: '2026-11-23T06:15:00+00:00' }), vandaag, nu), true);
  assert.strictEqual(zicht.z(k({ toon_vanaf: '2026-11-23T10:00:00Z' }), vandaag, nu), true);   // op het moment zelf
  assert.strictEqual(zicht.z(k({ toon_vanaf: 'onzin' }), vandaag, nu), true);   // onleesbaar = zichtbaar (faalt open)
  assert.strictEqual(zicht.z(k({ status: 'later', later_tot: '2026-11-22' }), vandaag, nu), true);
  assert.strictEqual(zicht.z(k({ status: 'later', later_tot: '2026-11-24' }), vandaag, nu), false);
  assert.strictEqual(zicht.z(k({ status: 'gedaan' }), vandaag, nu), false);
  assert.strictEqual(zicht.w(k({ toon_vanaf: '2026-11-23T11:30:00Z' }), nu), true);
  assert.strictEqual(zicht.w(k({ toon_vanaf: '2026-11-23T11:30:00Z', status: 'gedaan' }), nu), false);
  assert.strictEqual(zicht.w(k(), nu), false);
});

test('server.js: route geeft wacht en bundel, momentstap via mk_voor_jou_moment, vj-moment in de release', function () {
  assert.match(src, /wacht: wacht \}/);
  assert.match(src, /bundel: vjMoment && vjMoment\.isMk\(p\.herkomst\) \? 'machinekamer' : undefined/);
  assert.match(src, /appSbRpc\('mk_voor_jou_moment', \{ p_moment: new Date\(m\)\.toISOString\(\) \}\)/);
  assert.match(src, /mkKlussen: false, momentSinds: vjMoment \? vjMoment\.laatsteMoment\(nu\) : null/);
  const u = fs.readFileSync(path.join(wortel, 'uitrol.sh'), 'utf8');
  assert.match(u, /RELEASE_OPTIONEEL="[^"]*\bvj-moment\.js\b/);
  assert.ok(!/require\(/.test(fs.readFileSync(path.join(wortel, 'vj-moment.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '')), 'vj-moment.js is puur');
});

test('Te lezen: geen machinekamer-klusrapport meer, hoofdklus pas na het moment, antwoord meteen', function () {
  const NU = ms('2026-11-23T13:00:00Z');   // 14:00 NL; laatste moment 12:30 NL = 11:30 UTC
  const sinds = M.laatsteMoment(NU);
  const A = 'a1a1a1a1a1a1a1a1';
  const klussen = { [A]: { rij: 10, herkomst: 'david', soort: 'gewoon', diepte: 0, titel: 'Proefklus.', wortel: 10 } };
  const rap = (job, t, x) => Object.assign({ t: iso(t), job_id: job, soort: 'socev', bron: 'agentrapport', antwoord: 'Agentrapport — proef. Gedaan.', ok: true, agent_job: A }, x || {});
  const mk = rap('b1b1b1b1b1b1b1b1', NU - 3 * 3600000);
  const hoofdOud = rap('c1c1c1c1c1c1c1c1', ms('2026-11-23T10:00:00Z'), { bron: 'agentrapport-david', agent_job: undefined });
  const hoofdNieuw = rap('c2c2c2c2c2c2c2c2', ms('2026-11-23T12:30:00Z'), { bron: 'agentrapport-david', agent_job: undefined });
  const antw = { t: iso(NU - 600000), job_id: 'd1d1d1d1d1d1d1d1', soort: 'bericht', tekst: 'Kun je dat nakijken?', antwoord: 'Nagekeken.', ok: true };
  const o = { per: { hoofd: [hoofdOud, hoofdNieuw, antw], machinekamer: [mk] }, klussen: klussen, staat: { sinds: iso(NU - 86400000) }, tabs: {}, vraag: () => false, nu: NU };
  const oud = T.uit(o).punten.map((p) => p.job_id).sort();
  assert.deepStrictEqual(oud, [mk.job_id, hoofdOud.job_id, hoofdNieuw.job_id, antw.job_id].sort(), 'zonder de nieuwe opties: zoals voorheen');
  const nieuw = T.uit(Object.assign({}, o, { mkKlussen: false, momentSinds: sinds })).punten.map((p) => p.job_id).sort();
  assert.deepStrictEqual(nieuw, [hoofdOud.job_id, antw.job_id].sort());
  // bewaard blijft, ook uit de machinekamer
  const bew = T.uit(Object.assign({}, o, { mkKlussen: false, momentSinds: sinds, staat: { sinds: iso(NU - 86400000), bewaard: { [mk.job_id]: { kanaal: 'machinekamer', op: iso(NU - 60000) } } } }));
  assert.ok(bew.punten.some((p) => p.job_id === mk.job_id && p.soort === 'bewaard'));
});
