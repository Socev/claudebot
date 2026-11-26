'use strict';
// wv4098 (nr 348 = 3C48, nr 339 = 3C39): ontvangers uit de draad en de feitenstrook. Verzonnen adressen (.invalid) en verzonnen tekst.
const test = require('node:test');
const assert = require('node:assert');
const O = require('../mail-ontvangers.js');

const DAVID = 'David Schaap <d.schaap@gmail.com>', DOKTER = '"D. Schaap" <dokterschaap@gmail.com>';
function b(id, datum, van, aan, cc, sent, draft) {
  return { id, datum, van, aan, cc: cc || '', onderwerp: 'Re: Overleg dinsdag', labels: (sent ? ['SENT'] : ['INBOX']).concat(draft ? ['DRAFT'] : []) };
}

test('antwoord: afzender + andere aan in aan, cc mee, eigen adressen eruit, afzendadres van Davids eigen bericht', () => {
  const r = O.ontvangers([
    b('1', '2026-11-20T09:00:00Z', 'Piet <piet@voorbeeld.invalid>', '"Schaap, D." <dokterschaap@gmail.com>, Jan <jan@voorbeeld.invalid>', 'Kees <kees@voorbeeld.invalid>'),
    b('2', '2026-11-21T09:00:00Z', DOKTER, 'piet@voorbeeld.invalid', 'kees@voorbeeld.invalid, dokterschaap@gmail.com', true),
    b('3', '2026-11-22T09:00:00Z', 'Piet <PIET@voorbeeld.invalid>', 'dokterschaap@gmail.com, jan@voorbeeld.invalid', 'kees@voorbeeld.invalid, d.schaap+x@gmail.com'),
    b('4', '2026-11-23T09:00:00Z', DOKTER, 'piet@voorbeeld.invalid', '', true, true)   // concept telt niet
  ]);
  assert.equal(r.soort, 'antwoord');
  assert.deepEqual(r.aan, ['piet@voorbeeld.invalid', 'jan@voorbeeld.invalid']);
  assert.deepEqual(r.cc, ['kees@voorbeeld.invalid']);
  assert.equal(r.van, DOKTER); assert.equal(r.van_adres, 'dokterschaap@gmail.com'); assert.equal(r.van_reden, 'eerder_in_draad');
  assert.equal(r.laatste_id, '3'); assert.deepEqual(r.weggelaten, []);
  assert.match(O.ontvangersRegel(r), /aan piet@voorbeeld\.invalid, jan@voorbeeld\.invalid · cc kees@voorbeeld\.invalid · vanaf dokterschaap@gmail\.com/);
});

test('cc die de ander liet vallen: niet mee, wel genoemd; volgorde op datum, niet op lijst', () => {
  const r = O.ontvangers([
    b('3', '2026-11-22T09:00:00Z', 'piet@voorbeeld.invalid', DAVID),
    b('1', '2026-11-20T09:00:00Z', 'piet@voorbeeld.invalid', 'd.schaap@gmail.com, jan@voorbeeld.invalid'),
    b('2', '2026-11-21T09:00:00Z', DAVID, 'piet@voorbeeld.invalid', 'jan@voorbeeld.invalid, kees@voorbeeld.invalid', true)
  ]);
  assert.deepEqual(r.aan, ['piet@voorbeeld.invalid']); assert.deepEqual(r.cc, []);
  assert.deepEqual(r.weggelaten, ['jan@voorbeeld.invalid', 'kees@voorbeeld.invalid']);
  assert.equal(r.van, '', 'd.schaap@gmail.com = standaard: leeg'); assert.equal(r.van_adres, 'd.schaap@gmail.com');
  assert.match(O.ontvangersRegel(r), /Eerder in de draad, nu niet mee: jan@voorbeeld\.invalid, kees@voorbeeld\.invalid\./);
});

test('geen eigen bericht in de draad: afzendadres = het eigen Gmail-adres waaraan de mail gericht was; nooit doktersmaten@', () => {
  let r = O.ontvangers([b('1', '2026-11-20T09:00:00Z', 'piet@voorbeeld.invalid', 'dokterschaap@gmail.com')]);
  assert.equal(r.van, 'David Schaap <dokterschaap@gmail.com>'); assert.equal(r.van_reden, 'gericht_aan');
  r = O.ontvangers([b('1', '2026-11-20T09:00:00Z', 'piet@voorbeeld.invalid', 'doktersmaten@hapleusden.nl, jan@voorbeeld.invalid')]);
  assert.equal(r.van, ''); assert.equal(r.van_reden, 'standaard'); assert.deepEqual(r.aan, ['piet@voorbeeld.invalid', 'jan@voorbeeld.invalid']);
  assert.deepEqual(r.eigen_weg, ['doktersmaten@hapleusden.nl']);
});

test('herinnering: laatste bericht van David → zijn aan en cc, zijn afzendadres', () => {
  const r = O.ontvangers([
    b('1', '2026-11-20T09:00:00Z', 'piet@voorbeeld.invalid', 'dokterschaap@gmail.com'),
    b('2', '2026-11-21T09:00:00Z', DOKTER, 'piet@voorbeeld.invalid, dokterschaap@gmail.com', 'kees@voorbeeld.invalid', true)
  ]);
  assert.equal(r.soort, 'herinnering'); assert.deepEqual(r.aan, ['piet@voorbeeld.invalid']); assert.deepEqual(r.cc, ['kees@voorbeeld.invalid']);
  assert.equal(r.van, DOKTER);
});

test('leeg of alleen concepten → null; onderwerp zonder dubbel Re', () => {
  assert.equal(O.ontvangers([]), null); assert.equal(O.ontvangers(null), null);
  assert.equal(O.ontvangers([b('1', '2026-11-20T09:00:00Z', DAVID, 'x@voorbeeld.invalid', '', true, true)]), null);
  assert.equal(O.antwoordOnderwerp('RE: Antw: Overleg'), 'Re: Overleg'); assert.equal(O.antwoordOnderwerp(''), '');
});

test('feitenstrook: precies de verzonnen datum niet onderbouwd; draad, stuk en ondertekening tellen', () => {
  const draad = ['Hoi David, kunnen we op 3 december om 14:00 overleggen? De offerte is € 1.250,00.'];
  const stuk = { naam: 'offerte.pdf', tekst: 'Totaal EUR 1250,00, geldig tot 15-12-2026.' };
  const stem = 'Groet, David\n06 12345678';
  let f = O.feitenStrook('Hoi Piet,\n\n3 december past. De offerte van € 1.250,00 is akkoord, geldig tot 15 december 2026.\n\nGroet,\nDavid\n06 12345678', { draad, stukken: [stuk], stem });
  assert.equal(f.niet_onderbouwd.length, 0); assert.equal(f.aantal, 4);
  assert.equal(f.regel, '4 feiten, alle uit de draad, de stukken en je ondertekening.');
  f = O.feitenStrook('Hoi Piet,\n\n3 december past, en ik stuur het uiterlijk 1 februari terug.\n\nGroet,\nDavid', { draad, stem });
  assert.deepEqual(f.niet_onderbouwd, [{ soort: 'datum', ruw: '1 februari' }]);
  assert.equal(f.regel, '2 feiten; niet onderbouwd: 1 februari.');
  f = O.feitenStrook('Prima, ik kom.', { draad });
  assert.equal(f.aantal, 0); assert.equal(f.regel, 'Geen bedragen, datums of nummers in dit concept.');
  f = O.feitenStrook('Dat wordt dan € 450.', {});
  assert.equal(f.regel, '1 feit; niet onderbouwd: € 450.');
});

test('review MOET 2: adres in een weergavenaam of commentaar telt niet; komma in aanhalingstekens splitst niet; aan/cc niet afgekapt', () => {
  assert.deepEqual(O.adressen('"team@extern.invalid" <dokterschaap@gmail.com>'), ['dokterschaap@gmail.com']);
  assert.deepEqual(O.adressen('"Jansen, Piet" <p@voorbeeld.invalid>, kaal@voorbeeld.invalid; (x@commentaar.invalid) z@voorbeeld.invalid'),
    ['p@voorbeeld.invalid', 'kaal@voorbeeld.invalid', 'z@voorbeeld.invalid']);
  assert.deepEqual(O.adressen('"a \\" b, c@d.invalid" <e@voorbeeld.invalid>'), ['e@voorbeeld.invalid']);
  assert.deepEqual(O.adressen('geen adres, <>'), []);
  const veel = Array.from({ length: 25 }, (_, i) => 'p' + i + '@voorbeeld.invalid').join(', ');
  const r = O.ontvangers([b('1', '2026-11-20T09:00:00Z', '"iemand@nep.invalid" <piet@voorbeeld.invalid>', 'd.schaap@gmail.com', veel)]);
  assert.deepEqual(r.aan, ['piet@voorbeeld.invalid']); assert.equal(r.cc.length, 25, 'nooit stil afkappen');
});
