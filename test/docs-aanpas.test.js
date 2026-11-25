'use strict';
// wv4023 (3C151): Docs "Wat moet er anders?" — docs-aanpas.js met een nep-SDK (verzonnen tekst). node --test test/docs-aanpas.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const M = require(path.join(__dirname, '..', 'docs-aanpas.js'));

const PAGINA = '# Werkoverleg (verzonnen)\n\nDatum: 12-12-2026 om 19:30\n\n## Punten\n1. Koffieautomaat\n2. Zomerrooster\n3. Nieuwe printer\n\nBudget: 400 euro\n';

// nep-SDK: antwoorden = lijst objecten (of functies die het verzoek krijgen); elke aanroep pakt de volgende
function nepSdk(antwoorden, log) {
  return function () {
    return { klasse: function () {
      this.beta = { messages: { stream: function (p) {
        log && log.push(p);
        const a = antwoorden.shift();
        return { finalMessage: async function () {
          if (a instanceof Error) throw a;
          const j = typeof a === 'function' ? a(p) : a;
          return { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 }, content: [{ type: 'text', text: JSON.stringify(j) }] };
        } };
      } } };
    } };
  };
}
const mk = (antw, log, extra) => M.maak(Object.assign({ sleutel: async () => 'nep', sdk: nepSdk(antw, log) }, extra || {}));
const masker = (t) => t.replace(/sk-[A-Za-z0-9]{20,}/g, '••••');
const V = '0123456789abcdef0123456789abcdef';
const brain = (md, x) => async () => ({ status: 200, j: Object.assign({ ok: true, versie: V, bewerkbaar: true, md }, x || {}), audit: { h: 'abc' } });

test('pasToe: in volgorde, uniek, niet leeg', () => {
  assert.deepStrictEqual(M.pasToe('a b c', [{ oud: 'b', nieuw: 'B' }, { oud: 'B c', nieuw: 'x' }]), { ok: true, na: 'a x' });
  assert.strictEqual(M.pasToe('a a', [{ oud: 'a', nieuw: 'b' }]).ok, false);
  assert.strictEqual(M.pasToe('abc', [{ oud: 'z', nieuw: 'b' }]).ok, false);
  assert.strictEqual(M.pasToe('abc', [{ oud: '', nieuw: 'b' }]).ok, false);
  assert.strictEqual(M.pasToe('abc', [{ oud: 'a' }]).ok, false);
  assert.strictEqual(M.pasToe('abc', 'x').ok, false);
  assert.deepStrictEqual(M.pasToe('abc', []), { ok: true, na: 'abc' });
});

test('letOp: veranderde getallen die niet in de zin staan', () => {
  assert.strictEqual(M.letOp('op 12-12', 'op 3-12', 'zet het op 3-12'), null);   // het oude getal weg is normaal als de zin een nieuw noemt
  assert.strictEqual(M.letOp('1. a\n2. b\n3. c', '1. a\n2. c', 'haal b weg'), null);   // lijstnummers tellen niet
  assert.deepStrictEqual(M.letOp('budget 400', 'budget', 'haal de zin over koffie weg'), { n: 1, getallen: ['400'] });   // eraf zonder getal in de zin
});
test('letOp telt wat eraf en erbij ging buiten de zin', () => {
  const r = M.letOp('op 12-12, budget 400', 'op 3-12, budget 450', 'zet het op 3-12');
  assert.deepStrictEqual(r, { n: 1, getallen: ['450'] });
});

test('voorstel: wijziging toegepast, uitleg, eur, niets geschreven', async () => {
  const log = [];
  const m = mk([{ kan: true, uitleg: 'Punt 2 weggehaald.', wijzigingen: [{ oud: '2. Zomerrooster\n', nieuw: '' }] }], log);
  const r = await m.verzoek({ waar: 'brain', pad: 'x.md', versie: V, zin: 'haal het zomerrooster weg' }, { vast: false, masker, leesBrain: brain(PAGINA) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.j.kan, true);
  assert.strictEqual(r.j.voor, PAGINA);
  assert.strictEqual(r.j.na, PAGINA.replace('2. Zomerrooster\n', ''));
  assert.strictEqual(r.j.uitleg, 'Punt 2 weggehaald.');
  assert.ok(r.j.eur > 0);
  assert.ok(!/Zomerrooster|zomerrooster/.test(r.reden), 'geen tekst in de logregel');
  // pagina en zin als gegeven tussen grenzen met een willekeurig token; geen tools
  const tekst = log[0].messages[0].content[0].text, tok = /^TOKEN = ([0-9a-f]{12})/.exec(tekst)[1];
  assert.ok(tekst.includes('<pagina-' + tok + '>') && tekst.includes('<zin-' + tok + '>'));
  assert.strictEqual(log[0].tools, undefined);
  assert.strictEqual(log[0].model, 'claude-sonnet-5-5');
});

test('voorstel: let_op bij een bedrag dat niet gevraagd werd', async () => {
  const m = mk([{ kan: true, uitleg: 'Datum aangepast.', wijzigingen: [{ oud: '12-12-2026', nieuw: '3-12-2026' }, { oud: '400 euro', nieuw: '450 euro' }] }]);
  const r = await m.verzoek({ waar: 'brain', pad: 'x.md', versie: V, zin: 'de vergadering is op 3-12-2026' }, { vast: false, masker, leesBrain: brain(PAGINA) });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.j.let_op, { n: 1, getallen: ['450'] });
  assert.ok(/let_op=1/.test(r.reden));
});

test('tweede aanroep als het eerste voorstel niet past; daarna 422', async () => {
  const log = [];
  const m = mk([{ kan: true, uitleg: 'x', wijzigingen: [{ oud: 'Bestaat niet', nieuw: 'y' }] },
    { kan: true, uitleg: 'Printer weg.', wijzigingen: [{ oud: '3. Nieuwe printer\n', nieuw: '' }] }], log);
  const r = await m.verzoek({ waar: 'brain', pad: 'x.md', versie: V, zin: 'printer eraf' }, { vast: false, masker, leesBrain: brain(PAGINA) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(log.length, 2);
  assert.ok(/niet letterlijk/.test(log[1].messages[0].content[0].text));
  const m2 = mk([{ kan: true, uitleg: 'x', wijzigingen: [{ oud: 'nee', nieuw: 'y' }] }, { kan: true, uitleg: 'x', wijzigingen: [{ oud: 'nee', nieuw: 'y' }] }]);
  const r2 = await m2.verzoek({ waar: 'brain', pad: 'x.md', versie: V, zin: 'printer eraf' }, { vast: false, masker, leesBrain: brain(PAGINA) });
  assert.strictEqual(r2.status, 422);
  assert.strictEqual(m2.info().mislukt, 1);
});

test('kan niet: 200 zonder voorstel, na = voor', async () => {
  const m = mk([{ kan: false, uitleg: 'Welk bedrag? Dat staat niet in je zin.', wijzigingen: [] }]);
  const r = await m.verzoek({ waar: 'brain', pad: 'x.md', versie: V, zin: 'zet het juiste budget erin' }, { vast: false, masker, leesBrain: brain(PAGINA) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.j.kan, false);
  assert.strictEqual(r.j.gelijk, true);
});

test('poorten: invoer, vaste plek, sleutel in zin, niet bewerkbaar, versie, uurgrens, te groot', async () => {
  const m = mk([]);
  const h = { vast: false, masker, leesBrain: brain(PAGINA) };
  assert.strictEqual((await m.verzoek({ waar: 'brain', pad: 'x.md', versie: 'kort', zin: 'abc' }, h)).status, 400);
  assert.strictEqual((await m.verzoek({ waar: 'brain', pad: 'x.md', versie: V, zin: 'zet dit erin' }, Object.assign({}, h, { vast: true }))).status, 403);
  assert.strictEqual((await m.verzoek({ waar: 'brain', pad: 'x.md', versie: V, zin: 'zet sk-ABCDEFGHIJKLMNOPQRSTUVWX erin' }, h)).status, 422);
  const nb = await m.verzoek({ waar: 'brain', pad: 'x.md', versie: V, zin: 'zet dit erin' }, Object.assign({}, h, { leesBrain: brain(PAGINA, { bewerkbaar: false, reden: 'systeempagina\'s houden Socev en de wachters bij', reden_soort: 'systeem' }) }));
  assert.strictEqual(nb.status, 403); assert.strictEqual(nb.j.vraag_socev, true); assert.ok(/weiger=systeem/.test(nb.reden));
  assert.strictEqual((await m.verzoek({ waar: 'brain', pad: 'x.md', versie: V.replace('0', 'f'), zin: 'zet dit erin' }, h)).status, 409);
  assert.strictEqual((await m.verzoek({ waar: 'brain', pad: 'x.md', versie: V, zin: 'zet dit erin' }, Object.assign({}, h, { teller: () => false }))).status, 429);
  assert.strictEqual((await m.verzoek({ waar: 'brain', pad: 'x.md', versie: V, zin: 'zet dit erin' }, Object.assign({}, h, { leesBrain: brain('x'.repeat(M.MAX_TEKST + 1)) }))).status, 413);
  assert.strictEqual((await m.verzoek({ waar: 'brain', pad: 'x.md', versie: V, zin: 'ab' }, h)).status, 400);
  assert.strictEqual(m.info().aanroepen, 0, 'geen enkele modelaanroep bij een geweigerd verzoek');
});

test('sleutelachtig resultaat → 422', async () => {
  const m = mk([{ kan: true, uitleg: 'x', wijzigingen: [{ oud: 'Budget: 400 euro', nieuw: 'Budget: sk-ABCDEFGHIJKLMNOPQRSTUVWX' }] }]);
  const r = await m.verzoek({ waar: 'brain', pad: 'x.md', versie: V, zin: 'zet de code erin' }, { vast: false, masker, leesBrain: brain(PAGINA) });
  assert.strictEqual(r.status, 422);
});

test('werkbestand: alleen markdown, versie van het werkbestand', async () => {
  const m = mk([{ kan: true, uitleg: 'ok', wijzigingen: [{ oud: 'Budget: 400 euro', nieuw: 'Budget: 500 euro' }] }]);
  const r = await m.verzoek({ waar: 'werk', pad: 'werk:abc/1', versie: V, zin: 'budget wordt 500 euro' },
    { vast: false, masker, leesWerk: () => ({ status: 200, versie: V, md: PAGINA.replace(/\n/g, '\r\n'), naam: 'Notitie.md', h: 'h1' }) });
  assert.strictEqual(r.status, 200);
  assert.ok(!/\r/.test(r.j.voor));
  assert.strictEqual(r.j.let_op, null);
  const r2 = await m.verzoek({ waar: 'werk', pad: 'werk:abc/1', versie: V, zin: 'budget wordt 500 euro' },
    { vast: false, masker, leesWerk: () => ({ status: 200, versie: V, md: 'x', naam: 'Lijst.csv' }) });
  assert.strictEqual(r2.status, 403);
});

test('één tegelijk en daggrens', async () => {
  let los;
  const wacht = new Promise((k) => { los = k; });
  const m = M.maak({ sleutel: async () => 'nep', sdk: () => ({ klasse: function () { this.beta = { messages: { stream: () => ({ finalMessage: async () => { await wacht; return { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: JSON.stringify({ kan: false, uitleg: 'x', wijzigingen: [] }) }] }; } }) } }; } }) });
  const a = m.voorstel({ tekst: PAGINA, zin: 'doe iets' });
  await new Promise((k) => setImmediate(k));
  const b = await m.voorstel({ tekst: PAGINA, zin: 'doe iets' });
  assert.strictEqual(b.status, 429);
  los(); await a;
  let t = 0;
  const m2 = mk(Array.from({ length: 70 }, () => ({ kan: false, uitleg: 'x', wijzigingen: [] })), null, { nu: () => 1764000000000 + (t++) });
  for (let i = 0; i < M.DAG_MAX; i++) assert.strictEqual((await m2.voorstel({ tekst: PAGINA, zin: 'doe iets' })).ok, true);
  assert.strictEqual((await m2.voorstel({ tekst: PAGINA, zin: 'doe iets' })).status, 429);
});

test('API-fout → 502, geen sleutel → 503', async () => {
  const m = mk([Object.assign(new Error('x'), { status: 529 })]);
  assert.strictEqual((await m.voorstel({ tekst: PAGINA, zin: 'doe iets' })).status, 502);
  const m2 = M.maak({ sleutel: async () => null, sdk: nepSdk([]) });
  assert.strictEqual((await m2.voorstel({ tekst: PAGINA, zin: 'doe iets' })).status, 503);
});
