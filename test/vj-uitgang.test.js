'use strict';
// wv4194 (3C17 + 3C84): Niet nu › Vanavond en de uitgangen Lukt niet / Doe jij het (vj-uitgang.js, puur). Verzonnen kaarten, vaste klok.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const U = require('../vj-uitgang.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const ms = (s) => Date.parse(s);
const iso = (t) => new Date(t).toISOString();

test('Vanavond: vóór 20:00 = 20:00; tussen 20 en 22 = een uur later; vanaf 22:00 niet', function () {
  assert.strictEqual(iso(U.vanavondTot(ms('2026-11-27T09:00:00Z'))), '2026-11-27T19:00:00.000Z');   // 10:00 NL → 20:00 NL
  assert.strictEqual(iso(U.vanavondTot(ms('2026-11-27T05:30:00Z'))), '2026-11-27T19:00:00.000Z');   // 06:30 NL → vanavond
  assert.strictEqual(iso(U.vanavondTot(ms('2026-11-27T18:59:00Z'))), '2026-11-27T19:00:00.000Z');   // 19:59
  assert.strictEqual(iso(U.vanavondTot(ms('2026-11-27T19:30:00Z'))), '2026-11-27T20:30:00.000Z');   // 20:30 NL → 21:30
  assert.strictEqual(iso(U.vanavondTot(ms('2026-11-27T20:58:00Z'))), '2026-11-27T21:45:00.000Z');   // 21:58 → uiterlijk 22:45
  assert.strictEqual(U.vanavondTot(ms('2026-11-27T21:00:00Z')), null);   // 22:00 NL
  assert.strictEqual(U.vanavondTot(ms('2026-11-27T22:30:00Z')), null);   // 23:30 NL
  assert.strictEqual(iso(U.vanavondTot(ms('2027-06-01T08:00:00Z'))), '2027-06-01T18:00:00.000Z');   // zomertijd: 20:00 = 18:00 UTC
  for (let t = ms('2026-11-27T00:00:00Z'); t < ms('2026-11-28T00:00:00Z'); t += 7 * 60000) {   // nooit in de stille uren
    const v = U.vanavondTot(t); if (v == null) continue;
    const u = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hourCycle: 'h23' }).format(new Date(v)));
    assert.ok(u >= 20 && u < 23, iso(t) + ' → ' + iso(v));
    assert.ok(v > t && v - t <= 24 * 3600000);
  }
  assert.strictEqual(U.klokNL(ms('2026-11-27T19:00:00Z')), '20:00');
});

test('stand: Socev kijkt ernaar / doet het zolang de beurt loopt; opmerking en oud = niets', function () {
  const nu = ms('2026-11-27T10:00:00Z'), jobs = { a: 'pending', b: 'running', c: 'done' };
  const js = function (j) { return jobs[j] || null; };
  assert.deepStrictEqual(U.stand({ soort: 'lukt_niet', t: nu - 1000, job: 'a' }, js, nu), { soort: 'lukt_niet', t: iso(nu - 1000), bezig: true });
  assert.strictEqual(U.stand({ soort: 'doe_jij', t: nu, job: 'b' }, js, nu).bezig, true);
  assert.strictEqual(U.stand({ soort: 'doe_jij', t: nu, job: 'c' }, js, nu).bezig, false);
  assert.strictEqual(U.stand({ soort: 'doe_jij', t: nu, job: 'weg' }, js, nu).bezig, false);   // na een herstart onbekend = niet meer bezig: kaart terug
  assert.strictEqual(U.stand({ soort: 'opmerking', t: nu, job: 'a' }, js, nu), null);
  assert.strictEqual(U.stand({ soort: 'lukt_niet', t: nu - U.BEWAAR_MS - 1, job: 'a' }, js, nu), null);
  assert.strictEqual(U.stand({ soort: 'raar', t: nu, job: 'a' }, js, nu), null);
  assert.strictEqual(U.verborgen(U.stand({ soort: 'doe_jij', t: nu, job: 'a' }, js, nu)), true);
  assert.strictEqual(U.verborgen(U.stand({ soort: 'doe_jij', t: nu, job: 'c' }, js, nu)), false);
  assert.strictEqual(U.verborgen(U.stand({ soort: 'lukt_niet', t: nu, job: 'a' }, js, nu)), false);
  const st = { 1: { soort: 'lukt_niet', t: nu - U.BEWAAR_MS - 5 }, 2: { soort: 'doe_jij', t: nu } };
  assert.strictEqual(U.ruim(st, nu), true); assert.deepStrictEqual(Object.keys(st), ['2']);
});

test('mag op: besluit nooit, proef zonder Doe jij het', function () {
  assert.strictEqual(U.magOp('lukt_niet', 'doen'), null);
  assert.strictEqual(U.magOp('doe_jij', 'doen'), null);
  assert.strictEqual(U.magOp('opmerking', 'proef'), null);
  assert.strictEqual(U.magOp('lukt_niet', 'proef'), null);
  assert.match(U.magOp('doe_jij', 'proef'), /alleen jij/);
  assert.match(U.magOp('lukt_niet', 'besluit'), /Ja \/ Nee/);
  assert.strictEqual(U.magOp('x', 'doen'), 'ongeldige knop');
});

test('beurttekst: eigen kop per knop, kaartregel erin, geen Anders-woord', function () {
  const o = { titel: 'Proefkaart pakket ophalen', toelichting: '', tijd: '10:00', kanaalNaam: 'de machinekamer', gedaanWaar: false, kaartRegel: 'Kaart: punt proef-1 (status open).' };
  const l = U.beurtTekst('lukt_niet', o), d = U.beurtTekst('doe_jij', o), m = U.beurtTekst('opmerking', Object.assign({}, o, { toelichting: 'ging prima', gedaanWaar: true }));
  assert.match(l.kop, /^\[KNOP\] David koos LUKT NIET bij de Voor jou-kaart "Proefkaart pakket ophalen"$/);
  assert.match(l.ctx, /Socev kijkt ernaar/); assert.match(l.ctx, /punt proef-1/);
  assert.match(d.kop, /DOE JIJ HET/); assert.match(d.ctx, /voor-jou\.py status --sleutel/); assert.match(d.ctx, /komt na deze beurt vanzelf terug/);
  assert.match(m.kop, /GEDAAN, MET OPMERKING .* — toelichting: ging prima$/); assert.match(m.ctx, /laat hem dicht/);
  [l, d, m].forEach(function (x) { assert.doesNotMatch(x.kop, /ANDERS/); });
});

test('server.js: keuze, anders en lijst zijn gekoppeld', function () {
  assert.match(src, /vanavond: 1, wacht: 1, vervallen: 1, terug: 1/);
  assert.match(src, /fn = 'mk_voor_jou_toon'/);
  assert.match(src, /p_naar: keuze === 'wacht' \? 'later' : keuze/);
  assert.match(src, /VJU\.verborgen\(appVjUitgang\(p\.id, nu\)\)/);
  assert.match(src, /appVjUitgangZet\(d\.id, uitgang, st\.job_id\)/);
  assert.match(src, /status: 'socev', t: u\.t/);
  assert.match(src, /'anders uitgang met gedaan'/);
});
