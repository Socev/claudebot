'use strict';
// wv4232 (L48): de afloop terug op de kaart (vj-afloop.js, puur). Verzonnen kaarten, rijen en berichten.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const A = require('../vj-afloop.js');
const AF = require('../agents-af.js');
const TL = require('../te-lezen.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const J1 = 'a1a1a1a1a1a1a1a1', J2 = 'b2b2b2b2b2b2b2b2', R1 = 'c3c3c3c3c3c3c3c3', L1 = 'd4d4d4d4d4d4d4d4';
const kaart = (o) => Object.assign({ id: 7, status: 'gedaan', soort: 'besluit', herkomst: { wv: [901] }, gesloten_door: 'david' }, o || {});
const log = { [J1]: { kanaal: 'machinekamer', job_id: J1, soort: 'knop', ok: true, antwoord: 'Gedaan. De twee proefbestanden zijn gewist.' },
  [J2]: { kanaal: 'hoofd', job_id: J2, soort: 'knop', ok: false, antwoord: 'Het lukte niet: de proefdienst antwoordde niet.' } };
const klus = { [R1]: { kanaal: 'machinekamer', job_id: L1, agent_job: R1, soort: 'socev', ok: true, antwoord: '🤖 Agentrapport — proefklus\n\nUitkomst: de proefknop staat aan en werkt.\n\nVoor David: Niets doen' } };
const opts = (o) => Object.assign({ log: (j, k) => (k ? klus[j] : log[j]), zin: (t) => { const u = AF.uitkomstUitRapport(t); return u ? u.zin : null; }, jobStatus: () => null }, o || {});

test('rij klaar met klusrapport: Gedaan met de uitkomstzin, link naar het rapport', function () {
  const a = A.afloop(kaart(), opts({ rijen: [{ id: 901, status: 'klaar', job_id: R1, klaar_op: '2026-11-27T10:00:00Z' }], knopJob: J1 }));
  assert.strictEqual(a.stand, 'gedaan');
  assert.strictEqual(a.tekst, 'Gedaan: de proefknop staat aan en werkt.');
  assert.strictEqual(a.job_id, L1);
  assert.strictEqual(a.kanaal, 'machinekamer');
  assert.strictEqual(a.open, false);
});
test('rij klaar zonder klus (de knopbeurt deed het zelf): het knopantwoord', function () {
  const a = A.afloop(kaart(), opts({ rijen: [{ id: 901, status: 'klaar', job_id: null }], knopJob: J1 }));
  assert.strictEqual(a.tekst, 'Gedaan: De twee proefbestanden zijn gewist.');
  assert.strictEqual(a.job_id, J1);
});
test('lopend, in de rij, wacht weer op jou, niet doorgegaan', function () {
  assert.strictEqual(A.afloop(kaart(), opts({ rijen: [{ id: 901, status: 'gestart' }] })).tekst, 'Loopt nog');
  assert.strictEqual(A.afloop(kaart(), opts({ rijen: [{ id: 901, status: 'open' }] })).tekst, 'Staat in de rij');
  const w = A.afloop(kaart(), opts({ rijen: [{ id: 901, status: 'geblokkeerd', geblokkeerd_door: 'David: nieuwe vraag' }], knopJob: J1 }));
  assert.strictEqual(w.tekst, 'Wacht weer op jou');
  assert.strictEqual(w.job_id, J1);
  assert.strictEqual(A.afloop(kaart(), opts({ rijen: [{ id: 901, status: 'geblokkeerd', geblokkeerd_door: 'wacht op wv12' }] })).tekst, 'Staat in de rij');
  assert.strictEqual(A.afloop(kaart(), opts({ rijen: [{ id: 901, status: 'vervallen' }] })).tekst, 'Niet doorgegaan');
  assert.strictEqual(A.afloop(kaart(), opts({ rijen: [{ id: 901, status: 'gestart' }] })).open, true);
});
test('knopbeurt loopt nog: Socev is ermee bezig (ook als de rij nog wacht)', function () {
  const a = A.afloop(kaart(), opts({ rijen: [{ id: 901, status: 'geblokkeerd', geblokkeerd_door: 'David: x' }], knopJob: J1, jobStatus: (j) => (j === J1 ? 'running' : null) }));
  assert.strictEqual(a.stand, 'bezig');
});
test('mislukt: rij mislukt of het antwoord met ok false', function () {
  const m = A.afloop(kaart(), opts({ rijen: [{ id: 901, status: 'mislukt', job_id: null }], knopJob: J2 }));
  assert.strictEqual(m.stand, 'mislukt');
  assert.match(m.tekst, /^Mislukt: Het lukte niet/);
  const k = A.afloop(kaart({ herkomst: {} }), opts({ knopJob: J2 }));
  assert.strictEqual(k.stand, 'mislukt');
  assert.strictEqual(k.kanaal, 'hoofd');
});
test('geen rij: het knopantwoord als Reactie; niets bekend of Niet meer nodig = geen regel', function () {
  const r = A.afloop(kaart({ herkomst: {} }), opts({ knopJob: J1 }));
  assert.strictEqual(r.stand, 'reactie');
  assert.strictEqual(r.tekst, 'Reactie: De twee proefbestanden zijn gewist.');
  assert.strictEqual(A.afloop(kaart({ herkomst: {} }), opts({})), null);
  assert.strictEqual(A.afloop(kaart({ status: 'vervallen' }), opts({ rijen: [{ id: 901, status: 'klaar' }], knopJob: J1 })), null);
  assert.strictEqual(A.afloop(kaart(), opts({ rijen: [{ id: 902, status: 'klaar' }] })), null);   // andere rij
  assert.strictEqual(A.afloop(kaart(), opts({ knopJob: 'geen-job' })), null);
});
test('klus klaar maar zijn rapport is weg: alleen Gedaan, niet het knopantwoord', function () {
  const a = A.afloop(kaart(), opts({ rijen: [{ id: 901, status: 'klaar', job_id: 'eeeeeeeeeeeeeeee' }], knopJob: J1 }));
  assert.strictEqual(a.tekst, 'Gedaan');
  assert.strictEqual(a.job_id, null);
});
test('zin wordt kort en zonder dubbel Gedaan', function () {
  assert.strictEqual(A.metKop('Gedaan', 'De proefknop staat nu aan. Daarna heb ik nog veel meer gedaan.'), 'Gedaan: De proefknop staat nu aan.');
  assert.strictEqual(A.metKop('Gedaan', 'Kort. En nog wat.'), 'Gedaan: Kort. En nog wat.');
  assert.strictEqual(A.metKop('Gedaan', 'Gedaan: staat erin'), 'Gedaan: staat erin');
  assert.strictEqual(A.metKop('Gedaan', ''), 'Gedaan');
  assert.ok(Array.from(A.metKop('Gedaan', 'x'.repeat(400))).length <= 'Gedaan: '.length + A.ZIN_MAX);
});
test('doe-kaart met een kale Gedaan: geen regel; met bericht wel', function () {
  assert.strictEqual(A.afloop(kaart({ soort: 'doen' }), opts({ rijen: [{ id: 901, status: 'klaar', job_id: null }] })), null);
  assert.strictEqual(A.afloop(kaart({ soort: 'doen' }), opts({ rijen: [{ id: 901, status: 'gestart' }] })).tekst, 'Loopt nog');
  assert.strictEqual(A.afloop(kaart(), opts({ rijen: [{ id: 901, status: 'klaar', job_id: null }] })).tekst, 'Gedaan');
});
test('meer klussen aan één kaart: loopt nog en mislukt gaan vóór gedaan', function () {
  const k = kaart({ herkomst: { wv: [901, 902] } });
  assert.strictEqual(A.afloop(k, opts({ rijen: [{ id: 901, status: 'klaar', job_id: R1 }, { id: 902, status: 'gestart' }] })).tekst, 'Loopt nog');
  assert.strictEqual(A.afloop(k, opts({ rijen: [{ id: 901, status: 'klaar', job_id: R1 }, { id: 902, status: 'mislukt', job_id: null }], knopJob: J2 })).stand, 'mislukt');
  assert.strictEqual(A.afloop(k, opts({ rijen: [{ id: 901, status: 'vervallen' }, { id: 902, status: 'klaar', job_id: R1 }] })).tekst, 'Gedaan: de proefknop staat aan en werkt.');
});
test('Te lezen: een bericht dat aan een kaart hangt staat er niet los; mislukt wel', function () {
  const nu = Date.parse('2026-11-27T12:00:00Z'), t = '2026-11-27T11:00:00Z';
  const per = { hoofd: [
    { t, job_id: J1, soort: 'knop', ok: true, tekst: '✓ Ja', antwoord: 'Klaar, met bijlage.', bestanden: ['proef.pdf'] },
    { t, job_id: J2, soort: 'knop', ok: false, tekst: '✓ Ja', antwoord: 'Mislukt.' },
    { t, job_id: L1, soort: 'socev', bron: 'agentrapport-david', agent_job: R1, ok: true, antwoord: 'Uitkomst: proef.' }], machinekamer: [] };
  const basis = { per, staat: { sinds: '2026-11-01T00:00:00Z' }, tabs: {}, nu, mkKlussen: false };
  const zonder = TL.uit(basis).punten.map((p) => p.job_id).sort();
  assert.deepStrictEqual(zonder, [J1, J2, L1].sort());
  const met = TL.uit(Object.assign({ aanKaart: new Set([J1, J2, R1]) }, basis)).punten.map((p) => p.job_id).sort();
  assert.deepStrictEqual(met, [J2, L1].sort());   // L1 hangt via agent_job R1 aan geen getoonde regel: blijft
  assert.deepStrictEqual(TL.uit(Object.assign({ aanKaart: new Set([L1]) }, basis)).punten.map((p) => p.job_id).sort(), [J1, J2].sort());
});
test('server.js: lijstroute geeft snel en afloop alleen op het kanaal, gevoelig blijft openklappen, Te lezen krijgt aanKaart', function () {
  assert.match(src, /if \(!k\.kan \|\| k\.gevoelig \|\| k\.stop\) continue;/);
  assert.match(src, /snel: snel\[p\.id\], afloop: appVjAfloopVorm\(afl\.per\[p\.id\]\)/);
  assert.match(src, /appTeLezen\(a, moet, nu, aanKaart\)/);
  assert.match(src, /lijst\.concat\(afgehandeld\)\.forEach\(function \(x\) \{ if \(x\.afloop && x\.afloop\.job_id\) aanKaart\.add\(x\.afloop\.job_id\); \}\);/);
  assert.match(src, /aanKaart: aanKaart instanceof Set \? aanKaart : undefined/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'uitrol.sh'), 'utf8'), /RELEASE_OPTIONEEL="[^"]*\bvj-afloop\.js\b/);
});
