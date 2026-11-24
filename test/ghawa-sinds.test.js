'use strict';
// wv3955 (besluitenpagina nr 902 = L02, David Ja 22-11 18:25): "de app komt naar jou toe", op VERZONNEN cijfers.
// Ochtend: eerste keer = alleen vastleggen; niets veranderd = geen regel; een verandering (fonds betaald, antwoord van ECG, mijlpaal
// verschoven, nieuw voorstel uit WhatsApp) = één regel met een link naar het goede scherm; bewaar pas na de melding.
// Overzicht: "Sinds je vorige bezoek" vergelijkt met de opname van het vorige bezoek (een uur stil = nieuw bezoek).
// Server: de nachtstap meldt één editie-regel (met link en doel), te laat = niets en morgen alsnog.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const G = require('../ghawa.js');
const S = require('../ghawa-stichting.js');
const AN = require('../app-nieuws.js');
const { vers } = require('./ghawa-fixture.js');

const TABEL = '# Proefproject\n\n## Mijlpalen tot de eerste patiënt\n\n| Wanneer | Mijlpaal | Stand | Bron |\n|---|---|---|---|\n' +
  '| 3-3-2025 | Proefstichting opgericht | gehaald | a |\n| najaar 2026 | Proefdak | gepland | d |\n| 2027 | Proefopening | gepland | f |\n';
function opzet() {
  const { db, map } = vers();
  const p = path.join(map, S.BRONNEN.project); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, TABEL);
  let nu = '2026-11-24T05:35:00.000Z';
  const m = G.maak({ dbPad: db, bronnenMap: map, vaultMap: map, nu: () => nu });
  return { db, map, m, zetNu: (x) => { nu = x; }, tabel: p };
}
function sql(db, q, ...a) { const x = new DatabaseSync(db); try { return x.prepare(q).run(...a); } finally { x.close(); } }

test('ochtend: eerste keer stil, daarna zonder verandering stil', () => {
  const { m, zetNu } = opzet();
  const a = m.ochtend('2026-11-24');
  assert.strictEqual(a.eerste, true); assert.strictEqual(a.regel, null); a.bewaar();
  assert.strictEqual(m.ochtend('2026-11-24').al_gedaan, true);
  zetNu('2026-11-25T05:35:00.000Z');
  const b = m.ochtend('2026-11-25');
  assert.strictEqual(b.eerste, false); assert.deepStrictEqual(b.items, []); assert.strictEqual(b.regel, null);
});

test('ochtend: fonds betaald, antwoord van ECG, mijlpaal verschoven, voorstel = één regel; Overzicht-link bij meer schermen', () => {
  const { db, m, zetNu, tabel } = opzet();
  m.ochtend('2026-11-24').bewaar();
  sql(db, "UPDATE fonds SET status = 'Received by GHAWA NL' WHERE id = 'F02'");
  sql(db, "UPDATE open_vraag SET status = 'Partly answered', antwoord = 'verzonnen antwoord' WHERE id = 'Q01'");
  fs.writeFileSync(tabel, TABEL.replace('| najaar 2026 | Proefdak |', '| voorjaar 2027 | Proefdak |'));
  const x = new DatabaseSync(db);
  x.exec(require('../ghawa-voorstel.js').SCHEMA);
  x.prepare("INSERT INTO voorstel (id, sleutel, soort, gegevens, bron, gemaakt_op) VALUES ('V001', 'k1', 'antwoord', '{}', 'proef', '2026-11-24T09:00:00Z')").run();
  x.close();
  zetNu('2026-11-25T05:35:00.000Z');
  const b = m.ochtend('2026-11-25');
  const soorten = b.items.map((i) => i.soort + ':' + i.scherm);
  assert.deepStrictEqual(soorten, ['fonds:fondsen', 'ecg:vragen', 'mijlpaal:doelen', 'voorstel:voorstellen']);
  assert.match(b.items[0].tekst, /^Club Vallei betaald \(€ 20\), binnen bij GHAWA$/);
  assert.match(b.items[1].tekst, /antwoord van ECG op vraag Q01/);
  assert.match(b.items[2].tekst, /mijlpaal verschoven: Proefdak \(najaar 2026 → voorjaar 2027\)/);
  assert.match(b.items[3].tekst, /één voorstel uit WhatsApp klaar om Ja of Nee te zeggen/);
  assert.strictEqual(b.regel.scherm, 'overzicht');
  assert.strictEqual(b.regel.link, 'https://app.socev.dev/?app=ghawa&ghscherm=overzicht');   // review MOET 1
  assert.match(b.regel.tekst, /^Club Vallei betaald .*; en nog 1 \(Overzicht\)\.$/);
  // niet bewaard = morgen opnieuw; bewaard = stil
  zetNu('2026-11-26T05:35:00.000Z');
  const c = m.ochtend('2026-11-26');
  assert.strictEqual(c.items.length, 4); c.bewaar();
  zetNu('2026-11-27T05:35:00.000Z');
  assert.deepStrictEqual(m.ochtend('2026-11-27').items, []);
});

test('ochtend: alleen een nieuw voorstel = link naar Voorstellen; besloten voorstel telt niet opnieuw', () => {
  const { db, m, zetNu } = opzet();
  const x = new DatabaseSync(db); x.exec(require('../ghawa-voorstel.js').SCHEMA); x.close();
  m.ochtend('2026-11-24').bewaar();
  sql(db, "INSERT INTO voorstel (id, sleutel, soort, gegevens, bron, gemaakt_op) VALUES ('V001', 'k1', 'antwoord', '{}', 'proef', 'x'), ('V002', 'k2', 'bon', '{}', 'proef', 'x')");
  zetNu('2026-11-25T05:35:00.000Z');
  const b = m.ochtend('2026-11-25');
  assert.strictEqual(b.regel.tekst, '2 voorstellen uit WhatsApp klaar om Ja of Nee te zeggen.');
  assert.strictEqual(b.regel.link, 'https://app.socev.dev/?app=ghawa&ghscherm=voorstellen');
  b.bewaar();
  sql(db, "UPDATE voorstel SET staat = 'ja' WHERE id = 'V001'");
  zetNu('2026-11-26T05:35:00.000Z');
  assert.deepStrictEqual(m.ochtend('2026-11-26').items, []);
});

test('verschil: geld binnen (giften en bij ECG), nieuwe afschriften, gehaalde mijlpaal; andere versie of geen opname = stil', () => {
  const o = { v: G.STAND_V, fondsen: {}, vragen: { Q1: { status: 'Open', a: null } }, ecg_tot: '2026-10-06', ecg_in: 100000, giften: 50000,
    mijl: [{ t: 'Dak', w: 'najaar 2026', e: '2026-11-30', s: 'gepland' }], voorstellen: [] };
  const n = Object.assign({}, o, { ecg_tot: '2026-11-03', ecg_in: 350000, giften: 62500, mijl: [{ t: 'Dak', w: 'najaar 2026', e: '2026-11-30', s: 'gehaald' }] });
  const t = G.verschil(o, n).map((x) => x.tekst);
  assert.deepStrictEqual(t, ['€ 125 aan giften binnen op de GHAWA-rekening', '€ 2.500 binnen bij ECG', 'nieuwe afschriften van ECG, cijfers nu t/m 3-11', 'mijlpaal gehaald: Dak']);
  assert.deepStrictEqual(G.verschil(null, n), []);
  assert.deepStrictEqual(G.verschil(Object.assign({}, o, { v: 0 }), n), []);
  assert.strictEqual(G.ochtendRegel([]), null);
  // review ZOU 1: een nieuw toegevoegde, al gesloten vraag is geen nieuwe open vraag; een nieuwe open wel
  const v = Object.assign({}, o, { vragen: { Q1: o.vragen.Q1, Q2: { status: 'Closed', a: null }, Q3: { status: 'Open', a: null } } });
  assert.deepStrictEqual(G.verschil(o, v).map((x) => x.tekst), ['nieuwe open vraag Q3']);
  assert.strictEqual(G.ochtendRegel([{ tekst: 'x', scherm: 'geld' }, { tekst: 'y', scherm: 'geld' }]).link, 'https://app.socev.dev/?app=ghawa&ghscherm=geld');
});

test('Overzicht: Sinds je vorige bezoek (eerste bezoek null; binnen een uur blijft vorig; na een uur schuift hij door)', () => {
  const { db, m, zetNu } = opzet();
  zetNu('2026-11-24T10:00:00.000Z');
  assert.strictEqual(m.app({ pad: '/app/ghawa' }).body.sinds, null);
  sql(db, "UPDATE fonds SET status = 'Received by GHAWA NL' WHERE id = 'F02'");
  zetNu('2026-11-24T10:20:00.000Z');   // zelfde bezoek: nog geen vorig bezoek
  assert.strictEqual(m.app({ pad: '/app/ghawa' }).body.sinds, null);
  zetNu('2026-11-25T08:00:00.000Z');   // nieuw bezoek: vorig = de stand van 10:20 (F02 al binnen) → niets nieuw
  let s = m.app({ pad: '/app/ghawa' }).body.sinds;
  assert.strictEqual(s.op, '2026-11-24T10:20:00.000Z'); assert.deepStrictEqual(s.items, []);
  sql(db, "UPDATE open_vraag SET status = 'Closed' WHERE id = 'Q01'");
  zetNu('2026-11-25T08:05:00.000Z');   // zelfde bezoek: vorig blijft 10:20 van gisteren, de vraag staat erin
  s = m.app({ pad: '/app/ghawa' }).body.sinds;
  assert.strictEqual(s.op, '2026-11-24T10:20:00.000Z'); assert.deepStrictEqual(s.items.map((x) => x.scherm), ['vragen']);
  zetNu('2026-11-25T12:00:00.000Z');   // nieuw bezoek: vorig = 08:05 → niets meer
  assert.deepStrictEqual(m.app({ pad: '/app/ghawa' }).body.sinds.items, []);
});

test('loket: editie-regel met link krijgt ([open](…)) in de editie; ongeldige link weigert', () => {
  const nu = Date.parse('2026-11-25T05:40:00Z');
  const r = AN.meld(null, { app: 'ghawa', onderwerp: 'sinds-gisteren', laan: 'editie', editie: 'ochtend', datum: '2026-11-25', tekst: 'Club Vallei betaald.', link: 'https://app.socev.dev/?app=ghawa&ghscherm=fondsen', doel: { scherm: 'ghawa', focus: 'fondsen' } }, nu);
  const e = AN.editieTekst(AN.editieRegels(r.staat, 'ochtend', '2026-11-25', nu));
  assert.strictEqual(e.tekst, '• GHAWA: Club Vallei betaald. ([open](https://app.socev.dev/?app=ghawa&ghscherm=fondsen))');
  for (const l of ['https://evil.example/?app=ghawa', 'https://app.socev.dev/x?app=ghawa', 'https://app.socev.dev/?app=ghawa&x=<b>', 'javascript:alert(1)'])
    assert.throws(() => AN.meld(null, { app: 'ghawa', onderwerp: 'x', laan: 'editie', datum: '2026-11-25', tekst: 't', link: l }, nu), /ongeldige link/);
  assert.throws(() => AN.meld(null, { app: 'ghawa', onderwerp: 'x', laan: 'teller', aantal: 1, link: 'https://app.socev.dev/?app=ghawa' }, nu), /ongeldige link/);
  // briefing-punten maakt van de staart een Open-knop
  const BP = require('../briefing-punten.js');
  const p = BP.punten('## Uit je Apps\n' + e.tekst, '2026-11-25').punten[0];
  assert.strictEqual(p.bron.soort, 'link'); assert.strictEqual(p.bron.url, 'https://app.socev.dev/?app=ghawa&ghscherm=fondsen');
  assert.strictEqual(p.tekst, 'GHAWA: Club Vallei betaald.');
});

// server-stap: het blok uit server.js knippen zou te zwaar zijn; dezelfde logica met een nagebootste app en loket
test('server: ghawaOchtendStap meldt één regel met link en doel; te laat = niets en niet bewaard', async () => {
  const bron = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = bron.indexOf('async function ghawaOchtendStap('), j = bron.indexOf('\n}\n', i);
  assert.ok(i > 0 && j > i);
  const AN_ = {}; let ghawaApp = null; const ovisAms = null; const loketMeld = null; void ghawaApp; void ovisAms; void loketMeld;
  const stap = new Function('AN', 'ghawaApp', 'ovisAms', 'loketMeld', bron.slice(i, j + 2) + '\nreturn ghawaOchtendStap;')(AN_, null, null, null);
  let bewaard = 0; const meld = [];
  const app = { ochtend: () => ({ eerste: false, items: [{ soort: 'fonds' }], regel: { tekst: 'Club Vallei betaald.', scherm: 'fondsen', link: 'https://app.socev.dev/?app=ghawa&ghscherm=fondsen' }, bewaar: () => { bewaard++; } }) };
  const u = await stap({ datum: '2026-11-25' }, { app, ams: { datum: '2026-11-25', uur: 6, min: 31 }, meld: async (m) => { meld.push(m); } });
  assert.strictEqual(u.ok, true); assert.strictEqual(bewaard, 1); assert.strictEqual(meld.length, 1);
  assert.deepStrictEqual(meld[0], { app: 'ghawa', onderwerp: 'sinds-gisteren', laan: 'editie', editie: 'ochtend', datum: '2026-11-25', tekst: 'Club Vallei betaald.', link: 'https://app.socev.dev/?app=ghawa&ghscherm=fondsen', doel: { scherm: 'ghawa', focus: 'fondsen' } });
  const laat = await stap({ datum: '2026-11-25' }, { app, ams: { datum: '2026-11-25', uur: 6, min: 55 }, meld: async (m) => { meld.push(m); } });
  assert.strictEqual(laat.detail.te_laat, true); assert.strictEqual(bewaard, 1); assert.strictEqual(meld.length, 1);
  await assert.rejects(stap({ datum: '2026-11-25' }, { app, ams: { datum: '2026-11-25', uur: 6, min: 31 }, meld: async () => { throw new Error('loket stuk'); } }));
  assert.strictEqual(bewaard, 1);   // melding mislukt = niet bewaard (morgen alsnog)
  const stil = await stap({ datum: '2026-11-25' }, { app: { ochtend: () => ({ items: [], regel: null, bewaar: () => { bewaard++; } }) }, ams: { datum: '2026-11-25', uur: 6, min: 31 }, meld: async (m) => { meld.push(m); } });
  assert.strictEqual(stil.ok, true); assert.strictEqual(bewaard, 2); assert.strictEqual(meld.length, 1);
});
