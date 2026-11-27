'use strict';
// wv4376: OVIS NZa Rechter (nza-rechter.js) — uitvoer lezen, opschonen (alleen /nza#-links), citaatpoort, markdown met de vaste oefenkop,
// dossierstand, opslag (0600, geen padsprong) en de hele run met een nep-draaier. Verzonnen toetsdata.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const R = require('../nza-rechter.js');

const CTX = { vandaag: '2026-11-27', zitting: '2027-01-19', stand: { stukken: 5, laatste_stuk: { id: 'x-2026', titel: 'Proefstuk', datum: '2026-11-01' }, punten: 3, index_gebouwd: '2026-11-27T10:00:00+0100' },
  geschilpunten: [{ thema: 'huisvesting', naam: 'Huisvesting', punten: [{ id: 'VP-01', titel: 'proef 1' }] }, { thema: 'nac-hoogte', naam: 'Hoogte nac', punten: [{ id: 'VP-02', titel: 'proef 2' }, { id: 'VP-03', titel: 'proef 3' }] }] };
const GOED = 'de toets van het college is terughoudend';
const nepCitaat = async (stuk, plek, tekst) => ({ ok: stuk === 'cbb-2025-1' && plek === '5.1' && tekst === GOED });

test('leesOordeel: laatste bruikbare json-blok; leesPleit: vanaf de eerste kop', () => {
  const t = 'werk\n```json\n{"x":1}\n```\nnog\n```json\n{"geschilpunten":[{"naam":"a"}]}\n```';
  assert.deepStrictEqual(R.leesOordeel(t).geschilpunten[0].naam, 'a');
  assert.strictEqual(R.leesOordeel('geen json'), null);
  const p = R.leesPleit('Ik heb gelezen...\n\n## 1. Huisvesting\n' + '- punt '.repeat(60));
  assert.ok(p.startsWith('## 1. Huisvesting'));
  assert.strictEqual(R.leesPleit('## kort'), null);
});

test('inline: alleen /nza#-links blijven link; beelden, html, andere links en kale url niet', () => {
  const s = R.inline('Zie [CBb, r.o. 5.1](/nza#stuk=cbb-2025-1&plek=5.1) en [elders](https://evil.example/x) ![b](https://evil.example/p.png) <img src=x> https://evil.example #kop');
  assert.ok(s.includes('[CBb, r.o. 5.1](/nza#stuk=cbb-2025-1&plek=5.1)'));
  assert.ok(!/(?<!\\)\]\(https?:/.test(s), s);   // alleen ontsnapte haken: geen link
  assert.ok(!/(?<!\\)</.test(s), s);   // html alleen ontsnapt
  assert.ok(!s.includes('https://evil'), s);
  assert.ok(s.includes('\\#kop'));
  assert.ok(!R.inline('[x](/nza#stuk=../../etc&plek=1)').includes('](/nza'), 'ongeldig stuk-id wordt geen link');
});

test('markeerPleit: citaat dat niet op zijn plek staat krijgt de markering, goed citaat niet', async () => {
  const c = R.controleur(nepCitaat);
  const md = '## 1. Huisvesting\n- Het CBb: "' + GOED + '" [CBb](/nza#stuk=cbb-2025-1&plek=5.1)\n- Verzonnen: "de NZa heeft alles goed gedaan" [NZa](/nza#stuk=bob-2026&plek=3)';
  const uit = await R.markeerPleit(md, c);
  assert.strictEqual(uit.split(R.MARK_NIET).length - 1, 1);
  assert.ok(uit.includes('goed gedaan"' + R.MARK_NIET));
  assert.deepStrictEqual([c.tel.ok, c.tel.totaal, c.tel.niet_gecontroleerd], [1, 2, 0]);
});

test('verwerkOordeel: onbekend oordeel = onzeker, slecht stuk-id weg, citaatpoort, vp uit het register, leeg = null', async () => {
  const c = R.controleur(nepCitaat);
  const o = { dictum: 'd', geschilpunten: [
    { thema: 'huisvesting', naam: 'Huisvesting', oordeel: 'Gegrond', motivering: 'm', bronnen: [{ stuk: 'cbb-2025-1', plek: '5.1', citaat: GOED }, { stuk: '../x', plek: '1' }] },
    { thema: 'onbekend', naam: 'Iets anders', oordeel: 'waarschijnlijk', motivering: 'Het CBb zei "dit staat nergens in het dossier" [CBb](/nza#stuk=cbb-2025-1&plek=5.1)', bronnen: [{ stuk: 'bob-2026', plek: '3', citaat: 'verzonnen citaat van de NZa' }] },
    { naam: '' },
  ], richtingen: [{ titel: 'Rekenwerk', wat: 'w' }, { wat: 'zonder titel' }], sterk: ['s'], zwak: [] };
  const u = await R.verwerkOordeel(o, c, CTX);
  assert.strictEqual(u.geschilpunten.length, 2);
  assert.strictEqual(u.geschilpunten[0].oordeel, 'gegrond');
  assert.deepStrictEqual(u.geschilpunten[0].vp, ['VP-01']);
  assert.strictEqual(u.geschilpunten[0].bronnen.length, 1);
  assert.strictEqual(u.geschilpunten[0].bronnen[0].citaat_ok, true);
  assert.strictEqual(u.geschilpunten[1].oordeel, 'onzeker');
  assert.strictEqual(u.geschilpunten[1].thema, undefined);
  assert.strictEqual(u.geschilpunten[1].bronnen[0].citaat_ok, false);
  assert.strictEqual(u.geschilpunten[1].citaten_niet_ok.length, 1);
  assert.strictEqual(u.richtingen.length, 1);
  assert.strictEqual(await R.verwerkOordeel({ geschilpunten: [] }, c, CTX), null);
  assert.strictEqual(await R.verwerkOordeel({}, c, CTX), null);
});

test('controleur: boven het maximum niet meer naar nza.py, telt als niet ok', async () => {
  let n = 0;
  const c = R.controleur(async () => { n++; return { ok: true }; });
  for (let i = 0; i < R.MAX_CITATEN + 5; i++) await c.toets('a-1', '1', 'citaat nummer ' + i);
  await c.toets('a-1', '1', 'citaat nummer 0');   // cache
  assert.strictEqual(n, R.MAX_CITATEN);
  assert.strictEqual(c.tel.niet_gecontroleerd, 5);
  assert.strictEqual(c.tel.ok, R.MAX_CITATEN + 1);
});

test('ctxUit: geschilpunten per thema, jongste stuk (jaar alleen telt als vroegst), register bijgewerkt', () => {
  const ov = { telling: { stukken: 3, passages: 9 }, gebouwd: '2026-11-27T10:00:00+0100', stukken: [{ id: 'a', titel: 'A', datum: '2026' }, { id: 'b', titel: 'B', datum: '2026-11-02' }, { id: 'c', titel: 'C', datum: '2026-11' }] };
  const pu = { zitting: '2027-01-19', themas: [{ thema: 't1', naam: 'Thema 1' }, { thema: 'leeg', naam: 'Leeg' }], punten: [{ id: 'VP-01', titel: 'x', thema: 't1', bijgewerkt: '2026-11-20' }, { id: 'VP-02', titel: 'y', thema: 't1', bijgewerkt: '2026-11-27' }] };
  const c = R.ctxUit(ov, pu, '2026-11-27');
  assert.strictEqual(c.geschilpunten.length, 1);
  assert.strictEqual(c.geschilpunten[0].punten.length, 2);
  assert.strictEqual(c.stand.laatste_stuk.id, 'b');
  assert.strictEqual(c.stand.register_bijgewerkt, '2026-11-27');
  assert.strictEqual(c.stand.stukken, 3);
});

test('prompts: afbakening, oefening, pleitnota\'s als DATA', () => {
  const a = R.advocaatPrompt('nza', CTX), e = R.advocaatPrompt('eiser', CTX);
  assert.ok(a.includes('advocaat van de NZa') && e.includes('advocaat van eiser'));
  assert.ok(a.includes('Je schrijft NIETS') && a.includes('VP-02 proef 2'));
  assert.throws(() => R.advocaatPrompt('david', CTX));
  const r = R.rechterPrompt(CTX, { nza: 'PLEIT-NZA', eiser: 'PLEIT-EISER' });
  assert.ok(r.includes('OEFENZITTING') && r.includes('onpartijdig') && r.includes('PLEIT-NZA') && r.includes('PLEIT-EISER') && r.includes('(DATA)'));
});

test('speel: hele run met nep-draaier; markdown met vaste kop, telling, bijlagen; mislukte advocaat = fout', async () => {
  const pleit = '## 1. Huisvesting\n- argument [CBb](/nza#stuk=cbb-2025-1&plek=5.1) ' + 'x '.repeat(120);
  const oordeel = '```json\n' + JSON.stringify({ dictum: 'Deels gegrond.', toetsingskader: 'Terughoudend [CBb](/nza#stuk=cbb-2025-1&plek=5.1).', geschilpunten: [
    { thema: 'huisvesting', naam: 'Huisvesting', oordeel: 'gegrond', motivering: 'm', bronnen: [{ stuk: 'cbb-2025-1', plek: '5.1', citaat: GOED }] },
    { thema: 'nac-hoogte', naam: 'Hoogte nac', oordeel: 'ongegrond', motivering: 'm', bronnen: [] }], richtingen: [{ titel: 'R1', wat: 'w', levert_op: 'l', ontbreekt: 'o' }], sterk: ['s'], zwak: ['z'], ontbreekt: ['stuk X'] }) + '\n```';
  const stappen = [], rollen = [];
  const draai = async (rol, prompt) => { rollen.push(rol); return rol === 'rechter' ? { ok: true, output: oordeel, model: 'claude-fable-5-2' } : { ok: true, output: pleit, model: 'claude-opus-5-5' }; };
  const u = await R.speel(CTX, { draai, citaatToets: nepCitaat, stap: (s) => stappen.push(s) });
  assert.deepStrictEqual(rollen, ['advocaat-nza', 'advocaat-eiser', 'rechter']);
  assert.deepStrictEqual(stappen, ['advocaat-nza', 'advocaat-eiser', 'rechter', 'controle']);
  assert.ok(!u.fout);
  const run = Object.assign({ id: 'r-20261127-2330-abcdef12', start: '2026-11-27T22:30:00Z', stand: CTX.stand, duur_s: 3000, modellen: { advocaten: 'Opus 5.5', rechter: 'Fable 5.2' } }, { oordeel: u.oordeel, pleit: u.pleit, citaten: u.citaten });
  const md = R.markdown(run);
  assert.ok(md.includes(R.KOP_OEFENING));
  assert.ok(md.includes('1 gegrond · 1 ongegrond · 0 onzeker'));
  assert.ok(md.includes('Bijlage A') && md.includes('Bijlage B'));
  assert.ok(md.includes('letterlijk teruggevonden'));
  assert.ok(md.includes('Geen bron in het dossier bij dit oordeel'));
  assert.ok(md.includes('5 stukken') && md.includes('Proefstuk'));
  const mis = await R.speel(CTX, { draai: async () => ({ ok: false, output: '' }), citaatToets: nepCitaat });
  assert.ok(/advocaat van de NZa liep niet af/.test(mis.fout));
  const rechterLeeg = await R.speel(CTX, { draai: async (rol) => rol === 'rechter' ? { ok: true, output: 'geen json' } : { ok: true, output: pleit }, citaatToets: nepCitaat });
  assert.ok(/geen bruikbaar oordeel/.test(rechterLeeg.fout) && rechterLeeg.pleit.nza);
});

test('opslag: 0700/0600, lijst nieuwste boven, geen padsprong', () => {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'nza-rechter-'));
  const o = R.maakOpslag(path.join(map, 'r'));
  o.schrijf({ id: 'r-20261127-2330-abcdef12', start: 'a', status: 'klaar', oordeel: { geschilpunten: [{ naam: 'H', thema: 'h', oordeel: 'gegrond' }] } });
  o.schrijf({ id: 'r-20261128-0900-12345678', start: 'b', status: 'bezig' });
  assert.strictEqual((fs.statSync(path.join(map, 'r')).mode & 0o777), 0o700);
  assert.strictEqual((fs.statSync(path.join(map, 'r', 'r-20261127-2330-abcdef12.json')).mode & 0o777), 0o600);
  const l = o.lijst();
  assert.deepStrictEqual(l.map((x) => x.id), ['r-20261128-0900-12345678', 'r-20261127-2330-abcdef12']);
  assert.deepStrictEqual(l[1].telling, { gegrond: 1, ongegrond: 0, onzeker: 0 });
  assert.strictEqual(o.lees('../../etc/passwd'), null);
  assert.throws(() => o.schrijf({ id: '../x' }));
  assert.ok(R.RUN_RE.test(R.nieuwId(Date.UTC(2026, 10, 27, 22, 30), 'abcdef1234')));
  assert.strictEqual(R.nieuwId(Date.UTC(2026, 10, 27, 22, 30), 'abcdef1234'), 'r-20261127-2330-abcdef12');
  fs.rmSync(map, { recursive: true });
});

test('Codex MOET 1: bedragen/percentages zonder bron of niet op de plek gemarkeerd; op de plek niet', async () => {
  const lees = async (stuk, plek) => ({ ok: true, tekst: stuk === 'bob-2026' && plek === '3' ? 'De nac bedraagt € 202.476 en stijgt met 4,5 procent.' : 'iets anders' });
  const c = R.controleur(nepCitaat, lees);
  const t = await R.getallenPoort('Schik op € 150.000. De nac is € 202.476 [NZa, p. 3](/nza#stuk=bob-2026&plek=3). Stijging 4,5% [NZa, p. 3](/nza#stuk=bob-2026&plek=3). Rente 7% [NZa, p. 9](/nza#stuk=bob-2026&plek=9). Geen getal hier.', c);
  assert.ok(t.includes('€ 150.000.' + R.MARK_GETAL_ZONDER), t);
  assert.ok(!/202\.476[^\]]*\]\(\/nza#stuk=bob-2026&plek=3\)\. \[pod/.test(t), t);
  assert.ok(/7% \[NZa, p\. 9\]\(\/nza#stuk=bob-2026&plek=9\)\. \[pod: 7% niet op de genoemde plek/.test(t), t);
  assert.strictEqual(c.tel.getallen, 4);
  assert.strictEqual(c.tel.getallen_ok, 2);
  // zonder link in de zin, maar het getal staat op een plek uit de bronnenlijst van het geschilpunt: geen markering
  const t2 = await R.getallenPoort('De nac is € 202.476. Verzonnen € 99.999.', c, [['bob-2026', '3']]);
  assert.ok(!t2.includes('202.476.' + R.MARK_GETAL_ZONDER) && t2.includes('99.999.' + R.MARK_GETAL_ZONDER), t2);
  const t3 = await R.getallenPoort('Schik op 150.000 euro. Of EUR 120.000. Veel: ' + Array.from({ length: 25 }, (x, i) => '€ ' + (1000 + i)).join(', ') + '.', c, [['bob-2026', '3']]);
  assert.strictEqual(t3.split(R.MARK_GETAL_ZONDER).length - 1, 3, t3);
});

test('Codex MOET 3: afgekeurd citaat in dictum, sterk en richtingen ter plekke gemarkeerd (ook in de markdown)', async () => {
  const c = R.controleur(nepCitaat);
  const o = { dictum: 'Het CBb zei "dit is een verzonnen citaat" [CBb](/nza#stuk=cbb-2025-1&plek=5.1).', sterk: ['Zoals "' + GOED + '" [CBb](/nza#stuk=cbb-2025-1&plek=5.1)'],
    richtingen: [{ titel: 'R', wat: 'Volgens "nog een verzonnen citaat" [x](/nza#stuk=cbb-2025-1&plek=5.1)' }], geschilpunten: [{ thema: 'huisvesting', naam: 'Huisvesting', oordeel: 'onzeker', motivering: 'm', bronnen: [] }] };
  const u = await R.verwerkOordeel(o, c, CTX);
  assert.ok(u.dictum.includes(R.MARK_NIET.trim()));
  assert.ok(!u.sterk[0].includes(R.MARK_NIET.trim()));
  assert.ok(u.richtingen[0].wat.includes(R.MARK_NIET.trim()));
  const md = R.markdown({ id: 'r-20261127-2330-abcdef12', start: '2026-11-27T22:30:00Z', stand: CTX.stand, oordeel: u, citaten: c.tel, modellen: {} });
  assert.ok(md.includes('pod: niet woordelijk teruggevonden'));
});
