'use strict';
// wv4207 (3C199): kaart bij aankomst op de praktijk. Alle namen, punten en tijden zijn verzonnen. Draai: node test/aankomst-kaart.test.js
// Kruisproef: AANKOMST_MOD=<kopie zonder praktijkfilter of zonder dagslot> node test/aankomst-kaart.test.js moet rood zijn.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AK = require(process.env.AANKOMST_MOD || '../aankomst-kaart.js');

const T = (s) => Date.parse(s);             // november = CET (UTC+1)
const VRIJ_0805 = T('2026-11-27T07:05:00Z'); // vrijdag 08:05 NL
const VRIJ_0640 = T('2026-11-27T05:40:00Z'); // 06:40 NL (stille uren)
const ZAT_0905 = T('2026-11-28T08:05:00Z');  // zaterdag 09:05 NL
const VRIJ_1210 = T('2026-11-27T11:10:00Z'); // 12:10 NL

const BRIEFING = [
  '**🌅 Ochtendbericht**',
  'Weer: koud en droog.',
  '**Goedemorgen David, vrijdag 27 november**',
  '**De drie van vandaag**',
  '• Voor de waarneming op Tolgaarde vandaag is nog niemand gevonden.',
  '• De verjaardag van Oom Verzon is maandag.',
  '• De loonaangifte van de POT moet maandag betaald zijn.',
  '**Ook vandaag**',
  '• De nieuwe koffiemachine voor HAP Leusden is besteld.',
  '**✅ Je acties van vandaag (2)**',
  '1. Contract Verzonnen Leverancier tekenen (deadline Tolgaarde, uiterlijk 30-11)',
  '1. Contract Verzonnen Leverancier tekenen (deadline Tolgaarde, uiterlijk 30-11)',
  '**Tolgaarde**',
  '_Wacht op jou_',
  '• Assistent A vraagt of de proefplaatsing doorgaat.',
  '_Deze week_',
  '• Maandag komt de monteur voor het onderhoud.',
  '• Voor de waarneming op Tolgaarde vandaag is nog niemand gevonden.',
  '_Ter info_',
  '**Groenhouten**',
  '_Deze week_',
  '• Dinsdag begint een nieuwe POH.',
  '**Privé en gezin**',
  '• Zaterdag sport om 11:30 (Tolgaarde staat hier niet).',
].join('\n');
const ROOSTER = [
  { soort: 'dienst', feed: 'rooster-tg-artsen', titel: 'AA', status: 'actief' },
  { soort: 'dienst', feed: 'rooster-tg-artsen', titel: 'DS', status: 'actief' },
  { soort: 'dienst', feed: 'rooster-tg-artsen', titel: 'XX', status: 'geannuleerd' },
  { sb_kalender_tijdlijn: { soort: 'dienst', feed: 'rooster-gh-artsen', titel: 'BB', status: 'actief' } },
  { soort: 'dienst', feed: 'rooster-gh-artsen', titel: 'CC', status: 'actief', begin_datum: '2026-11-30' },
  { soort: 'afspraak', feed: 'rooster-tg-artsen', titel: 'Geen dienst', status: 'actief' },
];

test('praktijkVan herkent beide praktijken uit de plek', function () {
  assert.strictEqual(AK.praktijkVan('Huisartsenpraktijk Tolgaarde'), 'Tolgaarde');
  assert.strictEqual(AK.praktijkVan('Huisartsenpraktijk Groenhouten'), 'Groenhouten');
  assert.strictEqual(AK.praktijkVan('Thuis'), null);
  assert.strictEqual(AK.praktijkVan(null), null);
});

test('roosterVoor: alleen diensten van die praktijk en die dag, niet geannuleerd, ingepakte rijen ook', function () {
  assert.deepStrictEqual(AK.roosterVoor(ROOSTER, 'Tolgaarde', '2026-11-27'), ['AA', 'DS']);
  assert.deepStrictEqual(AK.roosterVoor(ROOSTER, 'Groenhouten', '2026-11-27'), ['BB']);
});

test('kaart Tolgaarde: rubriek + praktijkpunten uit De drie en acties, ontdubbeld, niets van een andere praktijk of privé', function () {
  const k = AK.kaart({ praktijk: 'Tolgaarde', ymd: '2026-11-27', briefing: BRIEFING, rooster: ['AA', 'DS'] });
  assert.ok(/^\*\*📍 Op Tolgaarde — vrijdag 27 november\*\*/.test(k.tekst), k.tekst);
  assert.ok(/Artsen vandaag: AA, DS/.test(k.tekst));
  assert.ok(/proefplaatsing/.test(k.tekst) && /monteur/.test(k.tekst));
  assert.strictEqual((k.tekst.match(/waarneming op Tolgaarde/g) || []).length, 1, 'zelfde punt in De drie en rubriek maar één keer');
  assert.strictEqual((k.tekst.match(/Verzonnen Leverancier/g) || []).length, 1, 'dubbele actie maar één keer');
  assert.ok(!/nieuwe POH/.test(k.tekst) && !/koffiemachine/.test(k.tekst) && !/sport/.test(k.tekst) && !/Oom/.test(k.tekst));
  assert.ok(!/_Ter info_/.test(k.tekst), 'leeg tussenkopje weg');
  assert.ok(k.tekst.indexOf('_Vandaag eerst_') < k.tekst.indexOf('_Wacht op jou_'), 'De drie/acties bovenaan');
  assert.ok(/Alles staat ook in je ochtendbericht/.test(k.tekst));
  assert.strictEqual(k.leeg, false);
});

test('kaart Groenhouten: ook "HAP Leusden" telt', function () {
  const k = AK.kaart({ praktijk: 'Groenhouten', ymd: '2026-11-27', briefing: BRIEFING, rooster: ['BB'] });
  assert.ok(/koffiemachine/.test(k.tekst) && /nieuwe POH/.test(k.tekst) && /Artsen vandaag: BB/.test(k.tekst));
  assert.ok(!/proefplaatsing/.test(k.tekst));
});

test('kaart: niets voor de praktijk en geen rooster = leeg; alleen rooster = kaart met zin', function () {
  const zonder = '**Goedemorgen David**\n**De drie van vandaag**\n• Iets privé.';
  assert.strictEqual(AK.kaart({ praktijk: 'Groenhouten', ymd: '2026-11-27', briefing: zonder, rooster: [] }).leeg, true);
  const k = AK.kaart({ praktijk: 'Groenhouten', ymd: '2026-11-27', briefing: zonder, rooster: ['BB'] });
  assert.strictEqual(k.leeg, false);
  assert.ok(/niets apart/.test(k.tekst));
});

test('kaart: hooguit 12 punten, de rest genoemd', function () {
  const veel = '**Tolgaarde**\n' + Array.from({ length: 20 }, (_, i) => '• Verzonnen punt nummer ' + i + '.').join('\n');
  const k = AK.kaart({ praktijk: 'Tolgaarde', ymd: '2026-11-27', briefing: veel, rooster: [] });
  assert.strictEqual(k.regels, 12);
  assert.ok(/en nog 8 in je ochtendbericht/.test(k.tekst));
});

function opzet(o) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aankomst-'));
  const st = { nu: o.nu, loc: o.loc, b: o.b === undefined ? { dag: '2026-11-27', tekst: BRIEFING, compleet: true } : o.b, berichten: [], faal: o.faal || 0, logs: [] };
  const m = AK.maak({ staatPad: path.join(dir, 's.json'), nu: () => st.nu,
    locatie: async () => st.loc, rooster: async () => ROOSTER, briefing: async () => st.b,
    melden: async (tekst, sl) => { if (st.faal > 0) { st.faal--; throw new Error('verzonnen storing'); } st.berichten.push({ tekst, sl }); },
    log: (x) => st.logs.push(x) });
  return { m, st, pad: path.join(dir, 's.json') };
}
const OP_TG = { klasse: 'werk', plek: 'Huisartsenpraktijk Tolgaarde', leeftijd_s: 120, toekomst: false };

test('tik: aankomst op Tolgaarde om 08:05 = één kaart, tweede tik niets', async function () {
  const { m, st } = opzet({ nu: VRIJ_0805, loc: OP_TG });
  assert.strictEqual((await m.tik()).stap, 'bezorgd');
  assert.strictEqual(st.berichten.length, 1);
  assert.strictEqual(st.berichten[0].sl, 'aankomst:2026-11-27');
  st.loc = { klasse: 'werk', plek: 'Huisartsenpraktijk Groenhouten', leeftijd_s: 60, toekomst: false };
  assert.strictEqual((await m.tik()).stap, 'al gedaan');
  assert.strictEqual(st.berichten.length, 1);
  assert.strictEqual(m.info().laatste.praktijk, 'Tolgaarde');
  assert.strictEqual(m.info().laatste.bezorgd, true);
});

test('tik: stille uren, weekend en na 12:00 niets', async function () {
  for (const nu of [VRIJ_0640, ZAT_0905, VRIJ_1210]) {
    const { m, st } = opzet({ nu, loc: OP_TG });
    assert.strictEqual((await m.tik()).stap, 'buiten venster');
    assert.strictEqual(st.berichten.length, 0);
  }
});

test('tik: thuis, oude melding, toekomst of onbekende plek = niets', async function () {
  for (const loc of [{ klasse: 'thuis', plek: 'Thuis', leeftijd_s: 60 }, Object.assign({}, OP_TG, { leeftijd_s: 3600 }), Object.assign({}, OP_TG, { toekomst: true }),
    Object.assign({}, OP_TG, { leeftijd_s: null }), { klasse: 'werk', plek: 'Verzonnen Kliniek', leeftijd_s: 60 }, null]) {
    const { m, st } = opzet({ nu: VRIJ_0805, loc });
    assert.strictEqual((await m.tik()).stap, 'niet op de praktijk', JSON.stringify(loc));
    assert.strictEqual(st.berichten.length, 0);
  }
});

test('tik: wacht op de briefing van vandaag (geen, van gisteren, alleen vroege versie)', async function () {
  for (const b of [null, { dag: '2026-11-26', tekst: BRIEFING, compleet: true }, { dag: '2026-11-27', tekst: BRIEFING, compleet: false }]) {
    const { m, st } = opzet({ nu: VRIJ_0805, loc: OP_TG, b });
    assert.strictEqual((await m.tik()).stap, 'wacht op briefing');
    assert.strictEqual(st.berichten.length, 0);
    st.b = { dag: '2026-11-27', tekst: BRIEFING, compleet: true };
    assert.strictEqual((await m.tik()).stap, 'bezorgd');
  }
});

test('tik: mislukte bezorging blijft staan en gaat de volgende tik alsnog (Codex MOET 1), met dezelfde sleutel', async function () {
  const { m, st, pad } = opzet({ nu: VRIJ_0805, loc: OP_TG, faal: 2 });
  assert.strictEqual((await m.tik()).stap, 'mislukt');
  const j = JSON.parse(fs.readFileSync(pad, 'utf8'));
  assert.ok(j.dagen['2026-11-27'].tekst && !j.dagen['2026-11-27'].bezorgd);
  st.loc = { klasse: 'thuis', plek: 'Thuis', leeftijd_s: 60 };   // ook als hij inmiddels weg is: de vastgelegde kaart gaat
  assert.strictEqual((await m.tik()).stap, 'mislukt');
  assert.strictEqual((await m.tik()).stap, 'bezorgd');
  assert.strictEqual(st.berichten.length, 1);
  assert.strictEqual(st.berichten[0].sl, 'aankomst:2026-11-27');
  const j2 = JSON.parse(fs.readFileSync(pad, 'utf8'));
  assert.ok(j2.dagen['2026-11-27'].bezorgd && !j2.dagen['2026-11-27'].tekst, 'na bezorging geen tekst meer in de staat');
});

test('tik: leeg = geen bericht, wel vastgelegd; uit = niets; onleesbare staat = niets', async function () {
  // zonder rooster en zonder praktijkpunt: leeg
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aankomst-'));
  const berichten = [];
  const m = AK.maak({ staatPad: path.join(dir, 's.json'), nu: () => VRIJ_0805, locatie: async () => OP_TG, rooster: async () => [],
    briefing: async () => ({ dag: '2026-11-27', tekst: '**De drie van vandaag**\n• Privé.', compleet: true }), melden: async (t) => berichten.push(t) });
  assert.strictEqual((await m.tik()).stap, 'leeg');
  assert.strictEqual((await m.tik()).stap, 'al gedaan');
  assert.strictEqual(berichten.length, 0);
  const u = opzet({ nu: VRIJ_0805, loc: OP_TG });
  fs.writeFileSync(u.pad, JSON.stringify({ versie: 1, uit: true, dagen: {} }));
  assert.strictEqual((await u.m.tik()).stap, 'uit');
  fs.writeFileSync(u.pad, '{kapot');
  assert.strictEqual((await u.m.tik()).stap, 'staat onleesbaar');
  assert.strictEqual(u.st.berichten.length, 0);
});

test('server.js en uitrol.sh: bron, meldsoort, klok, health en release-lijst', function () {
  const SRV = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/\n  'aankomst',\s+\/\/ wv4207/.test(SRV), 'bron aankomst');
  assert.ok(/aankomst: 'dag'/.test(SRV), 'meldsoort dag');
  assert.ok(SRV.indexOf("bron: 'aankomst', klasse: 'normaal', soort: 'dag'") > 0);
  assert.ok(SRV.indexOf('setInterval(function () { aankomstTik(); }, 2 * 60000)') > 0);
  assert.ok(SRV.indexOf('aankomst: typeof aankomstInfo') > 0);
  const u = fs.readFileSync(path.join(__dirname, '..', 'uitrol.sh'), 'utf8');
  assert.ok(/RELEASE_OPTIONEEL="[^"]* aankomst-kaart\.js[ "]/.test(u));
});
