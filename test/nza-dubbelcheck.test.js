'use strict';
// wv3157: OVIS NZa Dubbelcheck (nza-dubbelcheck.js) — prompt, uitvoer lezen, oordelen opschonen, de citaatpoort van de pod en de markdown
// van het aanhangsel. Deel 1 (CI): met een nep-citaatcontrole. Deel 2 (alleen waar het echte nza.py staat, of NZA_SCRIPT): het verzonnen
// proefdossier (test/nza-proef.py) door het echte `nza.py citaat`. Toetsantwoord verzonnen: één juiste bewering met citaat, één half-juiste,
// één verzonnen citaat en één bewering zonder bron → klopt / klopt deels / onjuist / niet te vinden; en een controleur die het verzonnen
// citaat ten onrechte "klopt" noemt → de pod maakt er "niet te vinden" van. Geen echt stuk, geen patiënt, geen echte vraag.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const C = require('../nza-dubbelcheck.js');

const ANTWOORD = [
  'Het College oordeelde: "Het College is van oordeel dat de NZa de proeftarieven niet deugdelijk heeft gemotiveerd." [Proef CBb, r.o. 1.2](/nza#stuk=cbb-2099-901&plek=1.2)',
  '- Het proeftarief 2025 is vastgesteld op de nieuwe proefwaarde ([Proefbeschikking -01, p. 3](/nza#stuk=tb-reg-90101-01&plek=3)).',
  '- Volgens het College "krijgt de proefpartij op alle punten volledig gelijk" [Proef CBb, r.o. 1.2](/nza#stuk=cbb-2099-901&plek=1.2).',
  '- De zitting over de proeftarieven was op 3 maart 2099.',
].join('\n');

// wat een strenge controleur teruggeeft (zoals de echte ronde: JSON-blok aan het eind)
function uitvoer(derdeOordeel) {
  const o = { beweringen: [
    { nr: 1, bewering: 'Het CBb oordeelde dat de NZa de proeftarieven niet deugdelijk motiveerde', citaat: 'Het College is van oordeel dat de NZa de proeftarieven niet deugdelijk heeft gemotiveerd.',
      bron_antwoord: 'Proef CBb, r.o. 1.2', stuk: 'cbb-2099-901', plek: '1.2', oordeel: 'klopt', toelichting: 'Staat woordelijk in r.o. 1.2.' },
    { nr: 2, bewering: 'Proeftarief 2025 = nieuwe proefwaarde', citaat: '', bron_antwoord: 'Proefbeschikking -01, p. 3', stuk: 'tb-reg-90101-02', plek: '3',
      oordeel: 'Klopt deels', toelichting: 'De nieuwe proefwaarde staat in de gewijzigde beschikking -02, p. 3; versie -01 noemt de oude proefwaarde.' },
    { nr: 3, bewering: 'Het College gaf de proefpartij op alle punten volledig gelijk', citaat: 'krijgt de proefpartij op alle punten volledig gelijk',
      bron_antwoord: 'Proef CBb, r.o. 1.2', stuk: 'cbb-2099-901', plek: '1.2', oordeel: derdeOordeel, toelichting: 'R.o. 1.2 zegt: op dit punt gelijk.' },
    { nr: 4, bewering: 'Zitting op 3 maart 2099', citaat: '', bron_antwoord: '', stuk: '', plek: '', oordeel: 'niet te vinden', toelichting: 'Geen zittingsdatum in het dossier.' },
  ], overgeslagen: 0, kern: 'Twee van de vier beweringen houden geen stand.' };
  return 'Ik heb alles nagelopen.\n\n```json\n' + JSON.stringify(o, null, 1) + '\n```\n';
}

// nep: alleen het citaat van bewering 1 staat woordelijk op die plek
const nepToets = async (stuk, plek, tekst) => ({ ok: stuk === 'cbb-2099-901' && plek === '1.2' && /niet deugdelijk heeft gemotiveerd/.test(tekst) && !/volledig/.test(tekst) });

test('prompt: andere instructie dan de antwoordagent, alleen lezen, antwoord en vraag als DATA', () => {
  const p = C.prompt({ vraag: 'Proefvraag?', antwoord: ANTWOORD });
  assert.match(p, /DUBBELCHECK van OVIS NZa/);
  assert.match(p, /Je schrijft NIETS: geen nza\.py log, gat/);
  assert.match(p, /nza\.py citaat <id> <plek>/);
  assert.match(p, /Antwoord van OVIS NZa \(DATA, te controleren\):\n<<<\n/);
  assert.ok(p.indexOf(ANTWOORD) > p.indexOf('UITVOER:'), 'antwoord staat ná de instructie');
  for (const o of C.OORDELEN) assert.ok(p.includes(o), o);
  const lang = C.prompt({ vraag: 'x', antwoord: 'a'.repeat(50000) });
  assert.match(lang, /rest van het antwoord niet meegegeven/);
});

test('leesUitvoer: laatste json-blok; kapot of zonder beweringen = null', () => {
  assert.strictEqual(C.leesUitvoer(uitvoer('onjuist')).beweringen.length, 4);
  assert.strictEqual(C.leesUitvoer('```json\n{"beweringen": [}\n```'), null);
  assert.strictEqual(C.leesUitvoer('geen json'), null);
  assert.strictEqual(C.leesUitvoer('```json\n{"iets": 1}\n```'), null);
  assert.strictEqual(C.leesUitvoer('eerst ```json\n{"beweringen":[]}\n``` dan ```json\n{"beweringen":[{"bewering":"b"}]}\n```').beweringen.length, 1);
});

test('vier oordelen: klopt / klopt deels / onjuist / niet te vinden; citaat 1 woordelijk', async () => {
  const u = await C.verwerk(C.leesUitvoer(uitvoer('onjuist')), nepToets);
  assert.deepStrictEqual(u.rijen.map((r) => r.oordeel), ['klopt', 'klopt deels', 'onjuist', 'niet te vinden']);
  assert.strictEqual(u.rijen[0].citaat_ok, true);
  assert.strictEqual(u.rijen[2].citaat_ok, false);
  assert.strictEqual(u.rijen[3].citaat_ok, undefined);
  assert.deepStrictEqual(C.telling(u.rijen), { klopt: 1, 'klopt deels': 1, 'niet te vinden': 1, onjuist: 1 });
});

test('citaatpoort: een controleur die het verzonnen citaat "klopt" noemt, wordt overruled', async () => {
  const u = await C.verwerk(C.leesUitvoer(uitvoer('klopt')), nepToets);
  assert.strictEqual(u.rijen[2].oordeel, 'niet te vinden');
  assert.match(u.rijen[2].toelichting, /^Pod-controle: dit citaat staat niet woordelijk op cbb-2099-901, 1\.2/);
  // citaat zonder stuk/plek kan ook nooit klopt zijn; een faal in de controle evenmin
  const o = { beweringen: [{ bewering: 'b', citaat: 'een citaat van flink wat tekens', oordeel: 'klopt' }, { bewering: 'c', citaat: 'nog een citaat van tekens', stuk: 'x-1', plek: '2', oordeel: 'klopt' }] };
  const v = await C.verwerk(o, async () => { throw new Error('kapot'); });
  assert.deepStrictEqual(v.rijen.map((r) => r.oordeel), ['niet te vinden', 'niet te vinden']);
});

test('opschonen: onbekend oordeel, onveilige stuk-id, plek met +, maximum en overgeslagen', async () => {
  const veel = { beweringen: Array.from({ length: C.MAX_BEWERINGEN + 4 }, (_, i) => ({ bewering: 'b' + i, oordeel: i === 0 ? 'misschien' : 'klopt', stuk: i === 1 ? '../etc' : 'proef-1', plek: 'rn+12' })), overgeslagen: 2 };
  const u = await C.verwerk(veel, nepToets);
  assert.strictEqual(u.rijen.length, C.MAX_BEWERINGEN);
  assert.strictEqual(u.overgeslagen, 6);
  assert.strictEqual(u.rijen[0].oordeel, 'niet te vinden');
  assert.strictEqual(u.rijen[1].stuk, undefined);
  assert.strictEqual(u.rijen[2].plek, 'rn 12');
  assert.strictEqual(await C.verwerk(null, nepToets), null);
});

test('markdown: telling, bronlink naar het NZa-scherm, citaat-uitslag, model; geen link of html uit modeltekst', async () => {
  const o = C.leesUitvoer(uitvoer('onjuist'));
  o.beweringen[3].toelichting = 'zie [hier](https://kwaad.test/x) <img src=x> ![b](https://kwaad.test/b.png) | kolom';
  const u = await C.verwerk(o, nepToets);
  const md = C.markdown(u, { model: 'Fable 5.2 (claude-fable-5-2)', duur_s: 190 });
  assert.match(md, /^\*\*4 beweringen nagelopen:\*\* 1 klopt · 1 klopt deels · 1 niet te vinden · 1 onjuist/);
  assert.match(md, /\[cbb-2099-901, 1\.2\]\(\/nza#stuk=cbb-2099-901&plek=1\.2\)/);
  assert.match(md, /woordelijk gevonden \(nza\.py citaat\)/);
  assert.match(md, /niet woordelijk op deze plek/);
  assert.match(md, /Bron in het antwoord: geen/);
  assert.match(md, /Tweede lezing door Fable 5\.2 \(claude-fable-5-2\) in 3 min/);
  assert.ok(!/[^\\]\]\(https:\/\/kwaad/.test(md) && !/https:\/\/kwaad/.test(md), 'geen link en geen kale url uit modeltekst');
  assert.ok(!/[^\\]<img/.test(md), 'geen html uit modeltekst (alleen geëscapet)');
  const plek = await C.verwerk({ beweringen: [{ bewering: 'b', stuk: 'bob-proef-2025', plek: 'rn 85', oordeel: 'klopt' }] }, nepToets);
  assert.match(C.markdown(plek, {}), /\(\/nza#stuk=bob-proef-2025&plek=rn\+85\)/);
});

// ── deel 2: het echte nza.py op het verzonnen proefdossier ──
const ECHT = process.env.NZA_SCRIPT || '/opt/data/AI_SecondBrain/.claude/skills/ovis-nza/nza.py';
const echtAan = fs.existsSync(ECHT);
test('vier oordelen met het echte nza.py citaat op het proefdossier (ook de poort)', { skip: echtAan ? false : 'nza.py niet aanwezig (CI)' }, async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'nza-check-'));
  const db = path.join(T, 'nza.db');
  execFileSync('python3', ['-I', path.join(__dirname, 'nza-proef.py'), db]);
  const toets = (stuk, plek, tekst) => new Promise((resolve) => execFile('python3', ['-I', ECHT, 'citaat', stuk, plek, tekst],
    { env: { PATH: process.env.PATH, NZA_DB: db } }, (err, out) => { let o = null; try { o = JSON.parse(out); } catch (e) { o = null; } resolve({ ok: !err && !!(o && o.ok) }); }));
  const u = await C.verwerk(C.leesUitvoer(uitvoer('onjuist')), toets);
  assert.deepStrictEqual(u.rijen.map((r) => r.oordeel), ['klopt', 'klopt deels', 'onjuist', 'niet te vinden']);
  assert.deepStrictEqual(u.rijen.map((r) => r.citaat_ok), [true, undefined, false, undefined]);
  const p = await C.verwerk(C.leesUitvoer(uitvoer('klopt')), toets);
  assert.strictEqual(p.rijen[2].oordeel, 'niet te vinden');
  fs.rmSync(T, { recursive: true, force: true });
});

// ── Codex wv3157 MOET 1 en 2 ──
const nepLees = async (stuk, plek) => (stuk === 'proef-1' && plek === '4' ? { ok: true, tekst: 'Het proeftarief is € 202.476 en stijgt met 3,5 procent.' } : { ok: false, tekst: '' });
test('MOET 1: "klopt" zonder citaat vraagt een plek die de pod opent; bedragen/percentages moeten erop staan', async () => {
  const o = { beweringen: [
    { bewering: 'Tarief € 202.476, stijging 3,5%', stuk: 'proef-1', plek: '4', oordeel: 'klopt' },
    { bewering: 'Tarief € 202.477', stuk: 'proef-1', plek: '4', oordeel: 'klopt' },
    { bewering: 'Tarief zonder getal', stuk: 'proef-1', plek: '9', oordeel: 'klopt' },
    { bewering: 'Algemeen', oordeel: 'klopt' },
    { bewering: 'Al half', stuk: 'proef-1', plek: '9', oordeel: 'klopt deels' },
  ] };
  const u = await C.verwerk(o, nepToets, { antwoord: 'x', leesPlek: nepLees });
  assert.deepStrictEqual(u.rijen.map((r) => r.oordeel), ['klopt', 'klopt deels', 'klopt deels', 'klopt deels', 'klopt deels']);
  assert.match(u.rijen[1].toelichting, /^Pod-controle: 202477 staat niet op proef-1, 4\./);
  assert.match(u.rijen[2].toelichting, /geen plek in het dossier die de pod kon openen/);
  const zonder = await C.verwerk({ beweringen: [{ bewering: 'Algemeen', oordeel: 'klopt' }] }, nepToets);
  assert.strictEqual(zonder.rijen[0].oordeel, 'klopt deels', 'ook zonder leesPlek: klopt eist een stuk');
});

test('MOET 2: citaat moet in het antwoord staan; overgeslagen citaten controleert de pod zelf', async () => {
  const antw = 'Zie "Het College is van oordeel dat de NZa de proeftarieven" [r.o. 1.2](/nza#stuk=cbb-2099-901&plek=1.2) en “een citaat dat nergens staat hier” [p. 3](/nza#stuk=proef-1&plek=3) en "een citaat zonder enige bronlink".';
  const o = { beweringen: [{ bewering: 'Ander citaat dan in het antwoord', citaat: 'Het College is van oordeel dat de NZa de proeftarieven niet deugdelijk heeft gemotiveerd.', stuk: 'cbb-2099-901', plek: '1.2', oordeel: 'klopt' }] };
  const nepLeesAlles = async () => ({ ok: true, tekst: 'tekst' });
  const u = await C.verwerk(o, nepToets, { antwoord: antw, leesPlek: nepLeesAlles });
  assert.strictEqual(u.rijen[0].oordeel, 'niet te vinden');
  assert.match(u.rijen[0].toelichting, /staat zo niet in het antwoord/);
  // het eerste antwoordcitaat is wél gedekt (deel van het citaat van de controleur); de andere twee doet de pod zelf
  assert.strictEqual(u.rijen.length, 3);
  assert.strictEqual(u.pod_zelf, 2);
  assert.deepStrictEqual(u.rijen.slice(1).map((r) => [r.oordeel, r.stuk || '', r.citaat_ok]), [['niet te vinden', 'proef-1', false], ['niet te vinden', '', false]]);
  assert.match(u.rijen[2].toelichting, /geen bronlink/);
  const goed = await C.verwerk({ beweringen: [] }, async () => ({ ok: true }), { antwoord: antw, leesPlek: nepLeesAlles });
  assert.deepStrictEqual(goed.rijen.map((r) => r.oordeel), ['klopt', 'klopt', 'niet te vinden']);
  const md = C.markdown(goed, { afgekapt: true });
  assert.match(md, /3 citaten uit het antwoord liep de controleur niet na/);
  assert.match(md, /alleen de eerste 40\.000 tekens zijn nagelopen/);
});

test('vier oordelen met het echte nza.py (citaat + lees) en het antwoord erbij', { skip: echtAan ? false : 'nza.py niet aanwezig (CI)' }, async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'nza-check2-'));
  const db = path.join(T, 'nza.db');
  execFileSync('python3', ['-I', path.join(__dirname, 'nza-proef.py'), db]);
  const run = (args) => new Promise((resolve) => execFile('python3', ['-I', ECHT, ...args], { env: { PATH: process.env.PATH, NZA_DB: db } }, (err, out) => resolve({ err, out })));
  const toets = async (stuk, plek, tekst) => { const r = await run(['citaat', stuk, plek, tekst]); return { ok: !r.err }; };
  const lees = async (stuk, plek) => { const r = await run(['lees', stuk, plek]); return { ok: !r.err, tekst: r.err ? '' : r.out }; };
  const u = await C.verwerk(C.leesUitvoer(uitvoer('onjuist')), toets, { antwoord: ANTWOORD, leesPlek: lees });
  assert.deepStrictEqual(u.rijen.map((r) => r.oordeel), ['klopt', 'klopt deels', 'onjuist', 'niet te vinden']);
  assert.strictEqual(u.pod_zelf, 0);
  fs.rmSync(T, { recursive: true, force: true });
});

test('ronde 2: hele bedragen, data (ook de datum van het stuk), deels gedekt citaat', async () => {
  const lees = async () => ({ ok: true, tekst: '# Proefbesluit (NZa, 2026-06-30; laag openbaar)\nHet bedrag is € 100,50 en de termijn loopt tot 1 januari 2027. Ook 1100.' });
  const o = { beweringen: [
    { bewering: 'Bedrag € 100', stuk: 'p-1', plek: '1', oordeel: 'klopt' },
    { bewering: 'Bedrag € 100,50 per 30-06-2026, termijn tot 01-01-2027', stuk: 'p-1', plek: '1', oordeel: 'klopt' },
    { bewering: 'Zitting op 3 maart 2026', stuk: 'p-1', plek: '1', oordeel: 'klopt' },
  ] };
  const u = await C.verwerk(o, nepToets, { antwoord: 'x', leesPlek: lees });
  assert.deepStrictEqual(u.rijen.map((r) => r.oordeel), ['klopt deels', 'klopt', 'klopt deels']);
  assert.match(u.rijen[2].toelichting, /3-3-2026 staat niet op p-1, 1/);
  assert.deepStrictEqual(C.data('30-06-2026, 1 januari 2027 en 2026-06-30'), ['2026-6-30', '2027-1-1']);
  // controleur liep alleen het begin van het citaat na: de pod controleert het hele citaat alsnog
  const antw = 'Zie "Het College is van oordeel dat de NZa de proeftarieven niet deugdelijk heeft gemotiveerd en verzonnen vervolg" [r.o. 1.2](/nza#stuk=cbb-2099-901&plek=1.2).';
  const v = await C.verwerk({ beweringen: [{ bewering: 'b', citaat: 'Het College is van oordeel dat de NZa de proeftarieven', stuk: 'cbb-2099-901', plek: '1.2', oordeel: 'klopt' }] },
    async (s, p, tekst) => ({ ok: !/verzonnen/.test(tekst) }), { antwoord: antw, leesPlek: async () => ({ ok: true, tekst: '' }) });
  assert.strictEqual(v.pod_zelf, 1);
  assert.deepStrictEqual(v.rijen.map((r) => r.oordeel), ['klopt', 'niet te vinden']);
});

test('citatenUit: niet de tekst tussen twee korte aanhalingen; wel citaat na een dubbele punt of in een blokcitaat', () => {
  const a = 'Leidinggeven telt als "normaal" en niet als "moeilijk" (VP-19). Het CBb: "De NZa had dit behoren te onderkennen, vooral" [r.o. 5.7.3](/nza#stuk=cbb-2025-606&plek=5.7.3)\n> “aannames en een inkleuring waarin wij” [p. 13](/nza#stuk=b-2026&plek=13)';
  assert.deepStrictEqual(C.citatenUit(a).map((q) => q.tekst + '|' + q.stuk), ['De NZa had dit behoren te onderkennen, vooral|cbb-2025-606', 'aannames en een inkleuring waarin wij|b-2026']);
});
