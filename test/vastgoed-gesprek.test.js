'use strict';
// wv4227 (besluitenpagina nr 939 = L39, David Ja 25-11-2026 22:27): Socev leest Vastgoed in het gewone gesprek (skill vastgoed,
// POST /smal/vastgoed). Toetst dat kern/tab/zoek dezelfde cijfers geven als het scherm (GET /app/vastgoed), elke regel een link naar het
// tabblad heeft, en dat er via het gesprek niets te schrijven of naar buiten te halen is. Verzonnen dossier (test/vastgoed-maak.js).
// VASTGOED_JS=<pad> voor de kruisproef.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const VJS = process.env.VASTGOED_JS || path.join(__dirname, '..', 'vastgoed.js');
const V = require(VJS);
const M = require('./vastgoed-maak.js');
const BASIS = 'https://app.socev.dev/vastgoed';

async function proef() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gesprek-'));
  const v = M.maakVault(path.join(t, 'vault'));
  const br = M.nepBronnen();
  const m = V.maak({ map: path.join(t, 'map'), vault: v, bronnen: br, nu: () => new Date('2026-11-27T10:00:00Z') });
  m.leesDossier();
  await m.ververs(m.overzicht().objecten.find((o) => o.soort === 'woning').id);
  return { t, v, m, br, weg: () => fs.rmSync(t, { recursive: true, force: true }) };
}
const tel = (m) => { const i = m.info(); return JSON.stringify([i.aanroepen, i.woz_eigen, i.feiten_extern, i.beelden]); };

test('kern: zelfde restschuld, overwaarde, rentevast, indicatie en WOZ als het scherm; links naar de tabbladen', async () => {
  const x = await proef();
  try {
    const scherm = (await x.m.app({ pad: '/app/vastgoed', methode: 'GET' })).body;
    const u = await x.m.gesprek({ opdracht: 'kern' });
    assert.strictEqual(u.status, 200);
    const w = u.body.objecten.find((o) => o.soort === 'woning'), sw = scherm.objecten.find((o) => o.soort === 'woning');
    assert.ok(sw.geld_kern, 'scherm heeft geld_kern');
    for (const k of ['restschuld', 'overwaarde', 'indicatie']) assert.strictEqual(w.geld[k], sw.geld_kern[k], k);
    assert.deepStrictEqual(w.geld.rentevast, sw.geld_kern.rentevast);
    assert.strictEqual(w.indicatie.waarde, sw.indicatie.waarde);
    const wozS = sw.reeksen.filter((r) => r.reeks === 'woz').slice(-1)[0];
    assert.ok(wozS && w.woz && w.woz.waarde === wozS.waarde && w.woz.peildatum === wozS.peildatum, 'laatste WOZ gelijk');
    assert.strictEqual(w.geld.link, BASIS + '#o=woning&s=waarde');
    assert.strictEqual(w.tabbladen.stukken, BASIS + '#o=woning&s=stukken');
    assert.ok(w.energielabel.feiten.length >= 1, 'energielabel uit het dossier');
    assert.strictEqual(u.body.objecten.length, scherm.objecten.filter((o) => !o.weg_op).length);
    assert.ok(u.body.objecten.filter((o) => o.soort === 'garagebox').every((o) => !('geld' in o) && o.link.startsWith(BASIS + '#o=box-')));
    assert.ok(!JSON.stringify(u.body).includes('data:image'), 'geen beelden in het gesprek');
  } finally { x.weg(); }
});

test('zoek "palenplan" vindt het stuk met link naar Stukken; "bestemmingsplan" vindt regels; niets = lege lijst', async () => {
  const x = await proef();
  try {
    const u = await x.m.gesprek({ opdracht: 'zoek', woorden: 'Palenplan' });
    assert.strictEqual(u.status, 200);
    assert.ok(u.body.stukken.n >= 1 && u.body.stukken.lijst[0].link === BASIS + '#o=woning&s=stukken', 'palenplan → Stukken');
    const r = await x.m.gesprek({ opdracht: 'zoek', woorden: 'proefplan' });
    assert.ok(r.body.feiten.lijst.some((f) => f.tab === 'regels' && f.link.endsWith('&s=regels')), 'plan → Regels en buurt');
    const n = await x.m.gesprek({ opdracht: 'zoek', woorden: 'zwembad helikopter' });
    assert.strictEqual(n.body.feiten.n + n.body.stukken.n + n.body.gebeurtenissen.n, 0);
    const accent = await x.m.gesprek({ opdracht: 'zoek', woorden: 'PALENPLÄN' });
    assert.strictEqual(accent.body.stukken.n, u.body.stukken.n, 'zonder hoofdletters en accenten');
  } finally { x.weg(); }
});

test('tab: feiten van precies die rubriek; waarde met leningdelen en geld; stukken met soortnaam; object ook als "huis"', async () => {
  const x = await proef();
  try {
    const scherm = (await x.m.app({ pad: '/app/vastgoed', methode: 'GET' })).body;
    const sw = scherm.objecten.find((o) => o.soort === 'woning');
    const reg = await x.m.gesprek({ opdracht: 'tab', object: 'huis', tab: 'regels' });
    assert.strictEqual(reg.status, 200);
    assert.strictEqual(reg.body.regels.length, sw.feiten.filter((f) => f.rubriek === 'regels').length);
    assert.strictEqual(reg.body.link, BASIS + '#o=woning&s=regels');
    const wa = await x.m.gesprek({ opdracht: 'tab', object: 'woning', tab: 'waarde' });
    assert.strictEqual(wa.body.leningdelen.length, sw.leningdelen.length);
    assert.strictEqual(wa.body.geld.restschuld, sw.geld_kern.restschuld);
    const st = await x.m.gesprek({ opdracht: 'tab', object: 'woning', tab: 'stukken' });
    assert.strictEqual(st.body.regels.length, sw.stukken.length);
    assert.ok(st.body.regels.some((s) => s.soort === 'Palenplan en constructie'));
  } finally { x.weg(); }
});

test('alleen lezen: geen schrijf- of ophaalopdracht via het gesprek; fouten zijn 400; niets naar buiten', async () => {
  const x = await proef();
  try {
    const voor = tel(x.m), vragen = x.br.vragen.length;
    for (const op of ['ververs', 'dossier', 'woz-bewaar', 'woz-bezwaar', 'beelden', 'aanroepen', '', 'KERN']) {
      const u = await x.m.gesprek({ opdracht: op, id: 1, jaar: 2026, waarde: 999999 });
      assert.strictEqual(u.status, 400, op);
    }
    assert.strictEqual((await x.m.gesprek({ opdracht: 'tab', object: 'woning', tab: 'kaart' })).status, 400);
    assert.strictEqual((await x.m.gesprek({ opdracht: 'tab', object: 'box-999', tab: 'waarde' })).status, 400);
    assert.strictEqual((await x.m.gesprek({ opdracht: 'zoek', woorden: ' ' })).status, 400);
    assert.strictEqual((await x.m.gesprek(null)).status, 400);
    for (const op of ['kern', 'zoek']) await x.m.gesprek({ opdracht: op, woorden: 'woz' });
    assert.strictEqual(tel(x.m), voor, 'geen aanroep, WOZ, extern feit of beeld erbij');
    assert.strictEqual(x.br.vragen.length, vragen, 'de bronnenlaag is niet aangeroepen');
  } finally { x.weg(); }
});

test('server.js: /smal/vastgoed in smalActie, grens in SMAL_GRENS, alleen bekende velden door, fout zonder inhoud', () => {
  if (path.resolve(VJS) !== path.join(__dirname, '..', 'vastgoed.js')) return;   // kruisproef gaat over de module
  const s = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(s.includes("if (actie === 'vastgoed') return vastgoedSmal(d);"));
  assert.match(s.split('\n').find((r) => r.startsWith('const SMAL_GRENS = ')), /\bvastgoed: 60\b/);
  const f = s.slice(s.indexOf('async function vastgoedSmal(d)'), s.indexOf('function vastgoedInfo()'));
  assert.ok(f.includes("['opdracht', 'object', 'tab', 'woorden'].forEach"), 'alleen bekende velden');
  assert.ok(!/secret/.test(f.replace(/\/\/.*$/gm, '')), 'de secret gaat niet door');
  assert.ok(f.includes("logError('vastgoed', new Error('gesprek faalde'))"));
  assert.ok(!/SMAL_ALLEEN_PAS = new Set\([^)]*'vastgoed'/.test(s), 'Socev mag de route openen');
});
