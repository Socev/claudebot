'use strict';
// wv4121 (besluitenpagina nr 316 = 3C16, David Ja 25-11-2026): het seintje zegt het soort (vraag, antwoord, machinekamer, storing),
// zonder inhoud. Toetst seintje-soort.js (keuze van het soort, lijst per apparaat, ophalen door de service worker) en dat elke
// verzendplek in server.js een soort meegeeft (behalve poets en proef). Kruisproef: TOETS_SERVER_JS = kopie zonder soort bij
// de meldingen → laatste toets rood.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const M = require(path.join(__dirname, '..', 'seintje-soort.js'));

test('soortVanBeurt: machinekamer en OVIS Code = machinekamer; vraag alleen in hoofd; rest antwoord', () => {
  assert.strictEqual(M.soortVanBeurt('machinekamer', false), 'machinekamer');
  assert.strictEqual(M.soortVanBeurt('machinekamer', true), 'machinekamer');
  assert.strictEqual(M.soortVanBeurt('code-facturen', false), 'machinekamer');
  assert.strictEqual(M.soortVanBeurt('hoofd', true), 'vraag');
  assert.strictEqual(M.soortVanBeurt('hoofd', false), 'antwoord');
  assert.strictEqual(M.soortVanBeurt('cijfer-meester', true), 'antwoord');
  assert.strictEqual(M.soortVanBeurt('ovis-nza', false), 'antwoord');
  assert.strictEqual(M.soortVanBeurt(undefined, false), 'antwoord');
});

test('soortVanBerichten: vraag gaat voor, dringend zonder vraag en Stiltewachter = storing, anders antwoord', () => {
  assert.strictEqual(M.soortVanBerichten('hoofd', [{ soort: 'dag', klasse: 'normaal', bron: 'heartbeat' }, { soort: 'vraag', klasse: 'dringend', bron: 'agenda' }]), 'vraag');
  assert.strictEqual(M.soortVanBerichten('hoofd', [{ soort: 'dag', klasse: 'dringend', bron: 'foutmelder' }]), 'storing');
  assert.strictEqual(M.soortVanBerichten('hoofd', [{ soort: 'dag', klasse: 'normaal', bron: 'stiltewachter-david' }]), 'storing');
  assert.strictEqual(M.soortVanBerichten('hoofd', [{ soort: 'dag', klasse: 'normaal', bron: 'briefing' }]), 'antwoord');
  assert.strictEqual(M.soortVanBerichten('hoofd', [{ soort: 'antwoord', klasse: 'normaal', bron: 'agentrapport-david' }]), 'antwoord');
  assert.strictEqual(M.soortVanBerichten('machinekamer', [{ soort: 'vraag', klasse: 'dringend' }]), 'machinekamer');
  assert.strictEqual(M.soortVanBerichten('hoofd', [undefined, null]), 'antwoord');
  assert.strictEqual(M.soortVanBerichten('hoofd', undefined), 'antwoord');
});

test('noteer + haal: één soort; tweede keer = herhaal van het jongste', () => {
  let st = M.noteer(undefined, 'vraag', 1000);
  assert.deepStrictEqual(M.haal(st, 1500), { soorten: ['vraag'], herhaal: false });
  assert.deepStrictEqual(M.haal(st, 1600), { soorten: ['vraag'], herhaal: true });
});

test('noteer + haal: samengevoegde pushes = alle soorten sinds de vorige vraag, op voorrang, elk één keer', () => {
  let st = M.noteer(undefined, 'antwoord', 1000);
  st = M.noteer(st, 'vraag', 1100);
  st = M.noteer(st, 'antwoord', 1200);
  st = M.noteer(st, 'storing', 1300);
  assert.deepStrictEqual(M.haal(st, 2000), { soorten: ['vraag', 'storing', 'antwoord'], herhaal: false });
  st = M.noteer(st, 'machinekamer', 2100);
  assert.deepStrictEqual(M.haal(st, 2200), { soorten: ['machinekamer'], herhaal: false });
});

test('noteer: onbekend soort telt niet; ouder dan 6 uur vervalt', () => {
  let st = M.noteer(undefined, 'inhoud', 1000);
  assert.deepStrictEqual(M.haal(st, 1001), { soorten: [], herhaal: false });
  st = M.noteer(undefined, 'vraag', 0);
  assert.deepStrictEqual(M.haal(st, M.BEWAAR_MS + 1), { soorten: [], herhaal: false });
});

test('Codex MOET 1: een vraag gevolgd door dertig antwoorden blijft een vraag', () => {
  let st = M.noteer(undefined, 'vraag', 1000);
  for (let i = 0; i < 30; i++) st = M.noteer(st, 'antwoord', 1001 + i);
  assert.deepStrictEqual(M.haal(st, 2000), { soorten: ['vraag', 'antwoord'], herhaal: false });
});

test('Codex MOET 2: push in dezelfde milliseconde als de vorige stand telt als nieuw', () => {
  let st = M.noteer(undefined, 'antwoord', 1000);
  assert.deepStrictEqual(M.haal(st, 1000), { soorten: ['antwoord'], herhaal: false });
  st = M.noteer(st, 'vraag', 1000);
  assert.deepStrictEqual(M.haal(st, 1000), { soorten: ['vraag'], herhaal: false });
  assert.deepStrictEqual(M.haal(st, 1000), { soorten: ['vraag'], herhaal: true });
});

test('haal: niets bekend (herstart) = lege lijst; kapotte staat = lege lijst', () => {
  assert.deepStrictEqual(M.haal(undefined, 1), { soorten: [], herhaal: false });
  assert.deepStrictEqual(M.haal({ per: 'x' }, 1), { soorten: [], herhaal: false });
  assert.deepStrictEqual(M.haal({ per: { geheim: { op: 1, n: 1 } }, n: 1, jongste: 'geheim' }, 2), { soorten: [], herhaal: false });
});

test('server.js: elke verzendplek geeft een soort mee (poets en proef niet), de stand geeft soorten', () => {
  const SRC = fs.readFileSync(process.env.TOETS_SERVER_JS || path.join(__dirname, '..', 'server.js'), 'utf8');
  const stuur = SRC.split('\n').filter((r) => /appPushStuur\(/.test(r) && !/^\s*(async )?function /.test(r));
  for (const r of stuur) {
    if (/'poets'|'proef'|appPushStuur\(id, reden, null, extra\)/.test(r)) continue;
    assert.match(r, /soort: '(storing|antwoord|vraag|machinekamer)'/, 'zonder soort: ' + r.trim());
  }
  const alle = SRC.split('\n').filter((r) => /appPushAlle\(/.test(r) && !/^\s*(async )?function /.test(r));
  assert.ok(alle.length >= 3, 'drie appPushAlle-plekken');
  for (const r of alle) assert.match(r, /soort|extra\)/, 'appPushAlle zonder soort: ' + r.trim());
  assert.match(SRC, /uit\.soorten = h\.soorten/);
  assert.match(SRC, /if \(soort\) appSeintjeSoortNoteer\(id, soort\);[^\n]*\n\s*try \{\n\s*\/\/ meldingen/);   // vóór de fetch
});
