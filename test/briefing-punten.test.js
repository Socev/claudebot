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

// wv3940 (3C46): Gambia-weekreview als blok onder het zaterdagse ochtendbericht. Verzonnen namen en inhoud.
const ZAT = '2026-11-28';
const GAMBIA = NEP.replace('VRAAG AAN DAVID', [
  '**🇬🇲 Gambia-weekreview**',
  '🇬🇲 Gambia-weekreview (week t/m 2026-11-28)',
  '• **Nepcontact Een** — 4 berichten (NL 3, GM 1): vraagt hoe het gaat. 💰 Verzoek: D 1.500 voor nepschoolboeken — past bij het patroon. 👉 Advies: vriendelijk antwoorden.',
  '• **Nepgroep Twee** — 2 berichten: foto van een nepvergadering. 👉 Advies: niets nodig.',
  'Totaal: rustige week.',
  '',
  'VRAAG AAN DAVID'].join('\n'));

test('wv3940: bolletjes onder de Gambia-kop zijn Gambia-punten met de naam; andere punten niet', function () {
  const r = P.punten(GAMBIA, ZAT, { bestaat: BESTAAT }).punten;
  const g = r.filter(function (x) { return x.gambia; });
  assert.strictEqual(g.length, 2);
  assert.deepStrictEqual(g.map(function (x) { return x.gambia.contact; }), ['Nepcontact Een', 'Nepgroep Twee']);
  assert.ok(r.slice(0, 5).every(function (x) { return !x.gambia; }));
  assert.ok(/1\.500/.test(g[0].tekst), 'de volledige tekst blijft zichtbaar (niets afgeschermd)');
  // Codex MOET 2: zonder vette naam geen naam uit vrije tekst; tik bewaart dan niets van de tekst en geeft niets door
  const z = P.punten('**🇬🇲 Gambia-weekreview**\n• Nepfatou heeft nepkoorts en vraagt 1500 — 1 bericht', ZAT).punten[0];
  assert.strictEqual(z.gambia.contact, '');
  const mz = { versie: 1, edities: {} }, slz = P.editieSleutel('briefing', ZAT);
  P.zetStand(mz, slz, z, 'laat_rusten', Date.now());
  assert.ok(!/nepkoorts|1500/.test(JSON.stringify(mz)));
  assert.strictEqual(P.correctieTekst(mz, slz, ZAT), '');
  assert.deepStrictEqual(P.rustLopend(mz, ZAT), []);
  P.zetStand(mz, slz, z, 'gedaan', Date.now());
  assert.strictEqual(P.correctieTekst(mz, slz, ZAT), '');
});

test('wv3949 (3C99): antwoord achter ✍️ wordt een kopieerblok, niet dubbel in de tekst en nooit in opslag of correctierij', function () {
  const blok = '**🇬🇲 Gambia-weekreview**\nSteunbord: Nepcontact Een — nepschoolgeld doorlopend.\n' +
    '• **Nepcontact Een** — 2 berichten: vraagt hoe het gaat. 👉 Advies: kort groeten. ✍️ `Hello my brother, all good here. Greetings to the family!`\n' +
    '• **Nepgroep Twee** — 1 bericht. 👉 Advies: niets nodig.';
  const r = P.punten(blok, ZAT).punten;
  assert.strictEqual(r.length, 2, 'de steunbordregel is geen punt');
  assert.strictEqual(r[0].gambia.antwoord, 'Hello my brother, all good here. Greetings to the family!');
  assert.ok(!/Hello my brother|✍️/.test(r[0].tekst)); assert.ok(/Advies: kort groeten\.$/.test(r[0].tekst));
  assert.strictEqual(r[1].gambia.antwoord, undefined);
  const m = { versie: 1, edities: {} }, sl = P.editieSleutel('briefing', ZAT);
  P.zetStand(m, sl, r[0], 'laat_rusten', Date.now()); P.zetStand(m, sl, r[1], 'gedaan', Date.now());
  assert.ok(!/Hello|brother/.test(JSON.stringify(m)) && !/Hello|brother/.test(P.correctieTekst(m, sl, ZAT)));
  // zonder backticks of buiten het Gambia-blok: niets
  assert.strictEqual(P.punten('**🇬🇲 Gambia-weekreview**\n• **X Y** — advies ✍️ Hello', ZAT).punten[0].gambia.antwoord, undefined);
  assert.strictEqual(P.punten('**Agenda**\n• overleg ✍️ `Hello`', ZAT).punten[0].gambia, undefined);
});

test('wv3940: Gambia-punten alleen met naam in opslag en correctierij; Laat rusten 6 dagen (t/m vrijdag)', function () {
  const r = P.punten(GAMBIA, ZAT, { bestaat: BESTAAT }).punten;
  const g = r.filter(function (x) { return x.gambia; });
  const m = { versie: 1, edities: {} }, sl = P.editieSleutel('briefing', ZAT), t0 = Date.parse('2026-11-28T08:00:00Z');
  P.zetStand(m, sl, g[0], 'laat_rusten', t0);
  P.zetStand(m, sl, g[1], 'gedaan', t0);
  assert.deepStrictEqual(P.standenVan(m, sl), { [g[0].id]: 'laat_rusten', [g[1].id]: 'gedaan' });
  assert.ok(!/1\.500|schoolboeken|vergadering/.test(JSON.stringify(m)), 'geen inhoud bewaard, alleen de naam');
  const t = P.correctieTekst(m, sl, ZAT);
  assert.match(t, /afgehandeld[^\n]*\n- Nepgroep Twee/);
  assert.match(t, /laat rusten[^\n]*\n- Nepcontact Een \(t\/m 2026-12-04\)/);
  assert.ok(!/1\.500|schoolboeken/.test(t));
  // de dagen erna: geen eigen tikken, wel lopend tot en met de briefing van vrijdag 4-12 (correctierij van do 3-12)
  assert.deepStrictEqual(P.rustLopend(m, '2026-12-03'), [{ contact: 'Nepcontact Een', tot: '2026-12-04' }]);
  assert.match(P.correctieTekst(m, P.editieSleutel('briefing', '2026-12-01'), '2026-12-01'), /Nepcontact Een/);
  assert.deepStrictEqual(P.rustLopend(m, '2026-12-04'), [], 'de briefing van zaterdag 5-12 kent hem niet meer (nieuwe review)');
  assert.strictEqual(P.correctieTekst(m, P.editieSleutel('briefing', '2026-12-04'), '2026-12-04'), '');
  assert.deepStrictEqual(P.rustLopend(m, '2026-11-27'), [], 'niet vóór de tik');
  P.zetStand(m, sl, g[0], null, t0);
  assert.deepStrictEqual(P.rustLopend(m, '2026-12-01'), [], 'weer open = niet meer rusten');
});

test('wv3940: server.js weigert Laat rusten buiten Gambia, telt het voor de correctierij en heeft de nachtketenstap', function () {
  const s = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(s, /stand === 'laat_rusten' && !punt\.gambia\) return appWeiger\(res, 400/);
  assert.match(s, /x === 'klopt_niet' \|\| x === 'laat_rusten'/);
  assert.match(s, /naam: 'briefing-rust', start_na: \[6, 45\][^\n]*appBriefingRustStap\(ctx\)/);
  assert.match(s, /BP\.rustLopend\(appBriefingPuntenLees\(\), gisteren\)/);
});
