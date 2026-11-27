'use strict';
// wv4176 (3C150): de namenlijst voor het uitschrijven in het gesprek. Alle namen hier zijn verzonnen (openbare repo).
const test = require('node:test');
const assert = require('node:assert');
const SN = require('../spraak-namen.js');

const REG = { knopen: [
  { id: 'AA', soort: 'entiteit', rol: 'eigen', naam: 'Huisartsenpraktijk Appelgaard (maatschap)', aliassen: ['Appelgaard', 'Huisartsenpraktijk Appelgaard'], actief: true },
  { id: 'BB', soort: 'entiteit', rol: 'eigen', naam: 'Stichting Berkenlaan Op Een Lijn', aliassen: ['Berkenlaan op een Lijn met veel woorden'], actief: true },
  { id: 'PRIVE', soort: 'entiteit', rol: 'eigen', naam: 'Privé', aliassen: ['K. Verzonnen'], actief: true },
  { id: 'org:1', soort: 'organisatie', rol: 'leverancier', naam: 'Pennenwinkel.nl - J. Pen en Zonen B.V.', aliassen: [], actief: true, concept: true },
  { id: 'org:2', soort: 'organisatie', rol: 'leverancier', naam: 'Wolkdienst, Inc.', aliassen: [], actief: true, concept: true },
  { id: 'org:3', soort: 'organisatie', rol: 'leverancier', naam: 'Nooitgefactureerd BV', aliassen: [], actief: true },
  { id: 'org:4', soort: 'organisatie', rol: 'zorgpartner', naam: 'Apotheek de Kastanje', aliassen: [], actief: true },
  { id: 'org:5', soort: 'organisatie', rol: 'leverancier', naam: 'Uitgezet', aliassen: [], actief: false },
  { id: 'per:1', soort: 'persoon', rol: null, naam: 'Jan Verzonnenpersoon', aliassen: ['Jantje'], actief: true },
] };
const WOORDEN = ['# Woordenlijst', '## Handmatig — zakelijk', '### Maildomeinen', '- voorbeeld.nl · post@voorbeeld.nl — niet deze sectie',
  '### Zorggroep, verzekeraars en regio', '- **ZGV** · Zorggroep Verzonnen · zgv.nl — [[x]]', '- ? Onbevestigd · Wel niet — te bevestigen',
  '### Functies en personeel', '- Piet Collega · PC — nooit personen', '### Projecten, regelingen', '- Kastanjeproject — iets', '## Personen en dossiers', '- Marie Verzonnen · Mies — nee'].join('\n');
const FACT = [{ knoop_id: null, naam: 'Wolkdienst, Inc.', n: 9 }, { knoop_id: 'org:1', naam: 'x', n: 2 }, { knoop_id: null, naam: 'Jan Verzonnenpersoon', n: 50 }];

function maak(over) {
  const o = Object.assign({ register: async () => REG, gezin: () => 'Ankie, Bram, Socev', facturen: () => FACT, lees: () => WOORDEN }, over || {});
  return SN.maak(o);
}

test('kort: rechtsvorm, haakjes, domein en lange namen', function () {
  assert.strictEqual(SN.kort('Pennenwinkel.nl - J. Pen en Zonen B.V.'), 'Pennenwinkel');
  assert.strictEqual(SN.kort('Wolkdienst, Inc.'), 'Wolkdienst');
  assert.strictEqual(SN.kort('Huisartsenpraktijk Appelgaard (maatschap)'), 'Huisartsenpraktijk Appelgaard');
  assert.strictEqual(SN.kort('Een heel erg lange statutaire naam van een stichting'), '');
  assert.strictEqual(SN.kort('info@voorbeeld.nl'), '');
  assert.strictEqual(SN.kort('ab'), '');
});

test('woordenUit: alleen de drie secties, code en eerste naam, geen ?-regels en geen personen', function () {
  assert.deepStrictEqual(SN.woordenUit(WOORDEN), ['ZGV', 'Zorggroep Verzonnen', 'Kastanjeproject']);
});

test('hint: volgorde eigen → Apps → gezin → partners → leveranciers → woordenlijst; geen personen, geen PRIVE, niets dubbel', async function () {
  const m = maak();
  const t = await m.hint();
  const l = t.split(', ');
  assert.strictEqual(l[0], 'Appelgaard');
  assert.ok(l.indexOf('MemoryLane') > l.indexOf('Appelgaard'));
  assert.ok(l.indexOf('Ankie') > l.indexOf('MemoryLane'));
  assert.ok(l.indexOf('Apotheek de Kastanje') > l.indexOf('Bram'));
  // leveranciers: vaakst gefactureerd eerst (naammatch telt), nooit gefactureerd en uitgezet niet
  assert.ok(l.indexOf('Wolkdienst') > 0 && l.indexOf('Wolkdienst') < l.indexOf('Pennenwinkel'));
  assert.strictEqual(l.indexOf('Nooitgefactureerd'), -1);
  assert.strictEqual(l.indexOf('Uitgezet'), -1);
  assert.ok(l.indexOf('Zorggroep Verzonnen') > l.indexOf('Pennenwinkel'));
  for (const nee of ['Jan Verzonnenpersoon', 'Jantje', 'K. Verzonnen', 'Piet Collega', 'Marie Verzonnen', 'Mies', 'Onbevestigd', 'Socev']) assert.strictEqual(l.indexOf(nee), -1, nee);
  assert.strictEqual(new Set(l.map((x) => x.toLowerCase())).size, l.length);
  assert.ok(t.length <= SN.MAX_TEKENS);
  const i = m.info();
  assert.strictEqual(i.tekens, t.length);
  assert.deepStrictEqual(i.fouten, []);
  assert.ok(!JSON.stringify(i).includes('Appelgaard'), 'info zonder namen');
});

test('hint: tweede naam van een eigen entiteit pas als er plek is; lange naam valt weg', async function () {
  const l = (await maak().hint()).split(', ');
  assert.ok(l.includes('Huisartsenpraktijk Appelgaard'));
  assert.ok(l.indexOf('Huisartsenpraktijk Appelgaard') > l.indexOf('Appelgaard'));
});

test('hint: een bron die faalt, valt weg; de rest blijft; korte tussenopslag', async function () {
  let n = 0, t0 = 1e12;
  const m = maak({ register: async () => { n++; throw new Error('weg'); }, nu: () => t0 });
  const t = await m.hint();
  assert.ok(t.startsWith('MemoryLane'));
  assert.deepStrictEqual(m.info().fouten, ['register']);
  await m.hint(); assert.strictEqual(n, 1, 'binnen een minuut uit de tussenopslag');
  t0 += 61000; await m.hint(); assert.strictEqual(n, 2, 'na een minuut opnieuw');
  const alles = SN.maak({ register: async () => { throw new Error('x'); }, gezin: () => { throw new Error('x'); }, facturen: () => { throw new Error('x'); }, lees: () => { throw new Error('x'); } });
  assert.strictEqual((await alles.hint()).split(', ')[0], 'MemoryLane');
});

test('hint: grote bronnen blijven binnen hun plafond en het totaal binnen MAX_TEKENS', async function () {
  const veel = { knopen: REG.knopen.concat(Array.from({ length: 300 }, (_, i) => ({ id: 'org:x' + i, soort: 'organisatie', rol: 'leverancier', naam: 'Leverancier' + i, aliassen: [], actief: true }))) };
  const f = Array.from({ length: 300 }, (_, i) => ({ knoop_id: 'org:x' + i, naam: '', n: 300 - i }));
  const t = await maak({ register: async () => veel, facturen: () => f, gezin: () => Array.from({ length: 80 }, (_, i) => 'Naam' + i).join(', ') }).hint();
  assert.ok(t.length <= SN.MAX_TEKENS, String(t.length));
  assert.ok(t.includes('Leverancier0') && !t.includes('Leverancier299'));
  assert.ok(t.includes('Appelgaard') && t.includes('MemoryLane'));
});

test('nagepraat: drie of meer lijstnamen in lijstvolgorde en niets anders = nagepraat', function () {
  const p = 'Socev, Appelgaard, MemoryLane, Tripper, Ankie, Bram';
  assert.strictEqual(SN.nagepraat('Appelgaard, MemoryLane, Tripper.', p), true);
  assert.strictEqual(SN.nagepraat('Socev, Appelgaard, Ankie, Bram', p), true);
  assert.strictEqual(SN.nagepraat('Tripper, MemoryLane, Appelgaard', p), false, 'andere volgorde = echt gezegd');
  assert.strictEqual(SN.nagepraat('Appelgaard, MemoryLane', p), false, 'twee namen is te weinig');
  assert.strictEqual(SN.nagepraat('Zet Appelgaard, MemoryLane en Tripper klaar', p), false);
  assert.strictEqual(SN.nagepraat('', p), false);
  assert.strictEqual(SN.nagepraat('a, b, c', ''), false);
});
