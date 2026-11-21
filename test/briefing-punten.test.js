'use strict';
// wv3685 (3C67): punt-model van het ochtendbericht (briefing-punten.js) en de bedrading in server.js. Alle toetsdata verzonnen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const P = require(path.join(__dirname, '..', 'briefing-punten.js'));

const DAG = '2026-11-22';
const NEP = [
  '**🌅 Ochtendbericht**',
  '',
  'Weer: droog, 6 °C.',
  '',
  '**Zondag 22 november**',
  '',
  '**Vandaag**',
  '• Om 10:00 koffie met de buren. ([[20_Prive/Buren]])',
  '• Proefconcept aan de bakker staat klaar — [[10_Werk/Bakker|bakker]]',
  '• Deze week:',
  '• het nepcontract voor de schuur tekenen',
  '',
  '**Vannacht verwerkt**',
  '• **Nepvereniging**: de ledenlijst is binnen [klik](https://voorbeeld.nl/x).',
  '• Een pagina die niet bestaat [[99_Nergens/Spook]].',
  '',
  '**Prioriteit:** de koffie.',
  '',
  'VRAAG AAN DAVID: Zal ik de proef bewaren?',
].join('\n');
const BESTAAT = function (p) { return p === '20_Prive/Buren' || p === '10_Werk/Bakker'; };

test('vijf punten, tussenkop met dubbele punt is geen punt, rubriek klopt', function () {
  const r = P.punten(NEP, DAG, { bestaat: BESTAAT });
  assert.strictEqual(r.punten.length, 5);
  assert.deepStrictEqual(r.punten.map(function (x) { return x.rubriek; }), ['Vandaag', 'Vandaag', 'Vandaag', 'Vannacht verwerkt', 'Vannacht verwerkt']);
  assert.ok(r.blokken.some(function (b) { return b.md && /Deze week:/.test(b.md); }), 'tussenkop blijft tekst');
  assert.ok(r.blokken.some(function (b) { return b.md && /VRAAG AAN DAVID/.test(b.md); }), 'vraag blijft tekst');
  assert.ok(r.blokken[0].md && /Weer: droog/.test(r.blokken[0].md), 'kop en weer vóór de punten');
  assert.strictEqual(r.blokken.filter(function (b) { return b.punt; }).length, 5);
});

test('bron: bestaande vaultpagina, md-link; verwijzing aan het eind uit de getoonde tekst; niet-bestaand pad = geen bron', function () {
  const p = P.punten(NEP, DAG, { bestaat: BESTAAT }).punten;
  assert.deepStrictEqual(p[0].bron, { soort: 'pagina', pad: '20_Prive/Buren', naam: 'Buren' });
  assert.strictEqual(p[0].tekst, 'Om 10:00 koffie met de buren.');
  assert.deepStrictEqual(p[1].bron, { soort: 'pagina', pad: '10_Werk/Bakker', naam: 'bakker' });
  assert.strictEqual(p[1].tekst, 'Proefconcept aan de bakker staat klaar');
  assert.strictEqual(p[2].bron, null);
  assert.deepStrictEqual(p[3].bron, { soort: 'link', url: 'https://voorbeeld.nl/x', naam: 'klik' });
  assert.strictEqual(p[4].bron, null, 'spookpad geeft geen Open');
  assert.ok(/Spook/.test(p[4].tekst), 'zonder geldige bron blijft de tekst heel');
});

test('id: vast voor dezelfde tekst en dag, anders per dag, dubbele tekst krijgt een volgnummer', function () {
  const a = P.punten(NEP, DAG, { bestaat: BESTAAT }).punten.map(function (x) { return x.id; });
  const b = P.punten(NEP, DAG, { bestaat: BESTAAT }).punten.map(function (x) { return x.id; });
  const c = P.punten(NEP, '2026-11-23', { bestaat: BESTAAT }).punten.map(function (x) { return x.id; });
  assert.deepStrictEqual(a, b);
  assert.notDeepStrictEqual(a, c);
  a.forEach(function (id) { assert.match(id, /^p[a-f0-9]{12}(-\d{1,3})?$/); });
  const d = P.punten('• zelfde\n• zelfde', DAG).punten;
  assert.strictEqual(d[1].id, d[0].id + '-2');
});

test('vaultPad weigert omhoog, absoluut en protocollen', function () {
  assert.strictEqual(P.vaultPad('../x'), null);
  assert.strictEqual(P.vaultPad('a/../../x'), null);
  assert.strictEqual(P.vaultPad('javascript:alert(1)'), null);
  assert.strictEqual(P.vaultPad('/00_Systeem/X.md'), '00_Systeem/X');
  assert.strictEqual(P.bronVan('zie [x](javascript:alert(1))'), null, 'alleen https of / als link');
});

test('standen: zetten, wissen, correctietekst alleen Gedaan en Klopt niet, snoeien', function () {
  const r = P.punten(NEP, DAG, { bestaat: BESTAAT }).punten;
  const m = { versie: 1, edities: {} }, sl = P.editieSleutel('briefing', DAG), t0 = Date.parse('2026-11-22T08:00:00Z');
  assert.strictEqual(P.zetStand(m, sl, r[0], 'gedaan', t0), null);
  P.zetStand(m, sl, r[1], 'later', t0);
  P.zetStand(m, sl, r[2], 'klopt_niet', t0);
  P.zetStand(m, sl, r[3], 'gedaan', t0);
  P.zetStand(m, sl, r[4], 'later', t0);
  assert.deepStrictEqual(P.standenVan(m, sl), { [r[0].id]: 'gedaan', [r[1].id]: 'later', [r[2].id]: 'klopt_niet', [r[3].id]: 'gedaan', [r[4].id]: 'later' });
  const t = P.correctieTekst(m, sl, DAG);
  assert.match(t, /Klopt niet[^\n]*\n- het nepcontract voor de schuur tekenen/);
  assert.match(t, /Gedaan[^\n]*\n- Om 10:00 koffie met de buren\.\n- Nepvereniging: de ledenlijst is binnen\./);
  assert.ok(!/Proefconcept/.test(t), 'Later gaat niet door');
  assert.strictEqual(P.zetStand(m, sl, r[3], null, t0), 'gedaan');
  assert.ok(!(r[3].id in P.standenVan(m, sl)));
  P.zetStand(m, sl, r[0], null, t0); P.zetStand(m, sl, r[2], null, t0);
  assert.strictEqual(P.correctieTekst(m, sl, DAG), '', 'niets door te geven = lege tekst');
  m.edities['briefing:2026-10-01'] = { punten: {} };
  P.snoei(m, t0, 14);
  assert.ok(!m.edities['briefing:2026-10-01'] && m.edities[sl]);
  assert.strictEqual(P.volgendeDag('2026-12-31'), '2027-01-01');
  assert.strictEqual(P.volgendeDag('2026-03-28'), '2026-03-29');
});

test('MOET 1: punten uit het geldblok zijn aan te tikken maar gaan nooit mee naar de briefing van morgen', function () {
  const T = NEP.replace('VRAAG AAN DAVID', '**💶 Geld deze maand**\n• Nepabonnement kost nu € 99 meer.\n\nVRAAG AAN DAVID');
  const r = P.punten(T, DAG, { bestaat: BESTAAT }).punten;
  const g = r[r.length - 1];
  assert.strictEqual(g.niet_door, true);
  assert.ok(!r[0].niet_door);
  const m = { versie: 1, edities: {} }, sl = P.editieSleutel('briefing', DAG);
  P.zetStand(m, sl, g, 'klopt_niet', Date.now());
  assert.deepStrictEqual(P.standenVan(m, sl), { [g.id]: 'klopt_niet' });
  assert.ok(!JSON.stringify(m).includes('99'), 'bedrag niet eens bewaard');
  assert.strictEqual(P.correctieTekst(m, sl, DAG), '');
  P.zetStand(m, sl, r[0], 'gedaan', Date.now());
  assert.ok(!/99|Nepabonnement/.test(P.correctieTekst(m, sl, DAG)));
});

test('briefing zonder bolletjes: geen punten (de app toont dan de tekst zoals altijd)', function () {
  const r = P.punten('**🌅 Ochtendbericht**\n\nRustige dag, niets bijzonders.', DAG);
  assert.strictEqual(r.punten.length, 0);
});

test('server.js: route, glijdroute, punten bij het laden, correctierij met teruglezen, één keten', function () {
  const s = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(s, /route === 'POST \/app\/briefing\/punt'\) return appBriefingPuntRoute\(req, res, a, d\)/);
  assert.match(s, /APP_GLIJD_ROUTES\.add\('POST \/app\/briefing\/punt'\)/);
  assert.match(s, /b\.p = appBriefingPuntenVan\(b\.tekst, b\.dag\)/);
  assert.match(s, /const \{ stem, tekst, p, \.\.\.kaal \} = b;/);
  assert.match(s, /value: 'briefing_correctie'/);
  assert.match(s, /rij na het schrijven niet teruggelezen/);
  assert.match(s, /appBriefingPuntKeten = deze\.catch/);
});
