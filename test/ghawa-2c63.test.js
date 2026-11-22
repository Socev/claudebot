'use strict';
// wv3919 (besluitenpagina nr 163 = 2C63, David Ja 22-11 18:24): OVIS GHAWA op VERZONNEN cijfers.
// (a) een vraag krijgt een antwoord en sluit, met datum in het logboek; (b) toezegging met verwachte datum: zonder datum één regel in Vraagt
// aandacht, voorbij = opvolgconcept + één Voor jou-kaart (nooit dubbel, dicht bij ontvangen); (c) de vragen aan ECG in porties van 4 (grootste
// bedrag eerst, link naar de gedeelde stand) en via de server als CONCEPT in Gmail (nep-mailluik; de pod verstuurt nooit); (f) gedekt rond
// <maand> en het koerseffect.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');
const G = require('../ghawa.js');
const B = require('../ghawa-bij.js');
const { vers } = require('./ghawa-fixture.js');

const NU = '2026-11-22T10:00:00.000Z';
function opzet(nu) {
  const { db, map } = vers();
  const x = new DatabaseSync(db); B.migreer(x);
  const zet = x.prepare('INSERT INTO open_vraag (id, onderwerp, vraag, gmd_cent, wie, status, antwoord) VALUES (?,?,?,?,?,?,?)');
  // verzonnen: zes vragen bij ECG met verschillende bedragen, één bij David
  [['Q03', 'Receipts', 'Receipts for the roof?', 50000, 'Partner'], ['Q04', 'Rate', 'Which rate?', null, 'Partner'], ['Q05', 'Cheque', 'Cheque 9?', 900000, 'Partner'],
    ['Q06', 'Cash', 'Cash in May?', 300000, 'Partner'], ['Q07', 'Mine', 'For David himself', 99900000, 'David'], ['Q08', 'Tiles', 'Tiles invoice?', null, 'Partner']]
    .forEach((r) => zet.run(r[0], r[1], r[2], r[3], r[4], 'Open', null));
  x.close();
  let t = nu || NU;
  const m = G.maak({ dbPad: db, bronnenMap: map, vaultMap: map, nu: () => t });
  return { db, map, m, zetNu: (v) => { t = v; } };
}

test('(a) vraag: antwoord erbij en gesloten, met bevestiging, datum en logboek; herinvoer weigert daarna', () => {
  const { db, map, m } = opzet();
  const post = (b) => m.app({ pad: '/app/ghawa/vraag', methode: 'POST', body: b, door: 'app 12345678' });
  assert.strictEqual(post({ id: 'Q01', status: 'Closed' }).status, 400);   // zonder bevestiging
  assert.strictEqual(post({ id: 'Q01', status: 'Klaar', bevestigd: true }).status, 400);
  assert.strictEqual(post({ id: 'Q99', status: 'Closed', bevestigd: true }).status, 404);
  assert.strictEqual(post({ id: 'Q01', antwoord: 'x'.repeat(2001), bevestigd: true }).status, 400);
  const p = post({ id: 'Q01', antwoord: '  For the fence (receipt follows).  ', status: 'Closed', bevestigd: true });
  assert.strictEqual(p.status, 200); assert.strictEqual(p.body.gewijzigd, 2); assert.match(p.reden, /POST vraag Q01$/);
  assert.doesNotMatch(p.reden, /fence/);   // geen inhoud in de auditregel
  const v = m.app({ pad: '/app/ghawa/vragen' }).body;
  const q = v.vragen.find((y) => y.id === 'Q01');
  assert.strictEqual(q.status, 'Closed'); assert.strictEqual(q.antwoord, 'For the fence (receipt follows).'); assert.strictEqual(q.gesloten_op, NU);
  assert.deepStrictEqual(q.log.map((l) => l.veld).sort(), ['antwoord', 'status']); assert.ok(q.log.every((l) => l.op === NU));
  assert.deepStrictEqual(v.statussen, ['Open', 'Partly answered', 'Closed']);
  assert.strictEqual(post({ id: 'Q01', antwoord: 'For the fence (receipt follows).', bevestigd: true }).body.gewijzigd, 0);   // niets veranderd
  // weer open: gesloten_op weg
  post({ id: 'Q01', status: 'Partly answered', bevestigd: true });
  assert.strictEqual(m.app({ pad: '/app/ghawa/vragen' }).body.vragen.find((y) => y.id === 'Q01').gesloten_op, null);
  // overzicht telt de gesloten vraag niet meer (Q01 Partly answered telt wel; nu 1 + 6 open)
  assert.strictEqual(m.app({ pad: '/app/ghawa' }).body.vragen.open, 7);
  assert.throws(() => G.invoer(map, db), /bijgehouden regels/);   // vraag_log telt als bijgehouden
});

test('(c) concept: portie van 4, grootste bedrag eerst, Davids eigen vragen niet, link erin; daarna de volgende portie', () => {
  const { m, zetNu } = opzet();
  const v = m.app({ pad: '/app/ghawa/vragen' }).body;
  assert.deepStrictEqual(v.portie.ids, ['Q05', 'Q06', 'Q01', 'Q03']);   // 9000, 3000, 600, 500 GMD; Q07 is van David
  assert.strictEqual(v.portie.rest, 2);
  assert.match(v.concept, /^Dear Momodou,/); assert.match(v.concept, /these 4 questions/); assert.match(v.concept, /https:\/\/ghawa\.socev\.dev/);
  assert.doesNotMatch(v.concept, /Q07|Q04|Q08/);
  assert.strictEqual(v.aan, null);   // geen ECG-kijker in de fixture, nog nooit gemaild
  // conceptVoor weigert een slecht adres; met een goed adres dezelfde portie
  assert.strictEqual(m.conceptVoor({ wat: 'vragen', aan: 'geen adres' }).status, 400);
  assert.strictEqual(m.conceptVoor({ wat: 'vragen', aan: 'a@x.test,b@x.test,c@x.test,d@x.test' }).status, 400);
  assert.strictEqual(m.conceptVoor({ wat: 'vragen', aan: '"Jansen, P" <p@x.test>' }).status, 400);
  const cv = m.conceptVoor({ wat: 'vragen', aan: ' partner@voorbeeld.test ' });
  assert.strictEqual(cv.ok, true); assert.strictEqual(cv.aan, 'partner@voorbeeld.test'); assert.deepStrictEqual(cv.ids, ['Q05', 'Q06', 'Q01', 'Q03']);
  assert.match(cv.onderwerp, /4 open questions \(Q05, Q06, Q01, Q03\)/);
  m.conceptGezet(cv, 'app 1');
  const v2 = m.app({ pad: '/app/ghawa/vragen' }).body;
  assert.deepStrictEqual(v2.portie.ids, ['Q04', 'Q08']); assert.strictEqual(v2.aan, 'partner@voorbeeld.test');   // adres onthouden
  assert.match(v2.concept, /these 2 questions/);
  assert.strictEqual(v2.vragen.find((y) => y.id === 'Q05').concept_op, NU);
  assert.ok(v2.vragen.find((y) => y.id === 'Q05').log.some((l) => l.veld === 'concept'));
  assert.strictEqual(m.app({ pad: '/app/ghawa/ronde' }).body.stappen.find((s) => s.id === 'vragen').klaar, true);   // maandstap vanzelf af
  m.conceptGezet(m.conceptVoor({ wat: 'vragen', aan: 'partner@voorbeeld.test' }), 'app 1');
  assert.deepStrictEqual(m.app({ pad: '/app/ghawa/vragen' }).body.portie.ids, ['Q05', 'Q06', 'Q01', 'Q03']);   // alles net in een concept: weer vooraan
  zetNu('2026-12-07T10:00:00.000Z');   // 15 dagen later: de eerste portie mag weer
  assert.deepStrictEqual(m.app({ pad: '/app/ghawa/vragen' }).body.portie.ids, ['Q05', 'Q06', 'Q01', 'Q03']);
});

test('(c) het ECG-adres komt uit de ECG-kijker van Delen met ECG (niet uit de code)', () => {
  const { db, m } = opzet();
  const x = new DatabaseSync(db);
  x.exec('CREATE TABLE IF NOT EXISTS deel_kijker (hash TEXT PRIMARY KEY, naam TEXT NOT NULL, adres TEXT NOT NULL, rol TEXT NOT NULL, op TEXT NOT NULL, door TEXT, weg_op TEXT)');
  x.prepare('INSERT INTO deel_kijker VALUES (?,?,?,?,?,?,?)').run('h1', 'Partner', 'kijker@voorbeeld.test', 'ecg', NU, 'app', null);
  x.prepare('INSERT INTO deel_kijker VALUES (?,?,?,?,?,?,?)').run('h2', 'Ik', 'ik@voorbeeld.test', 'eigenaar', NU, 'app', null);
  x.close();
  assert.strictEqual(m.app({ pad: '/app/ghawa/vragen' }).body.aan, 'kijker@voorbeeld.test');
});

test('(b) toezegging: zonder datum één aandachtregel, voorbij = opvolgconcept en één kaart, dicht bij ontvangen', () => {
  const { db, m, zetNu } = opzet();
  let o = m.app({ pad: '/app/ghawa' }).body;
  const zonder = o.aandacht.filter((a) => a.label === 'datum');
  assert.strictEqual(zonder.length, 1); assert.match(zonder[0].titel, /Club Vallei: wanneer verwacht je de € 20\?/); assert.strictEqual(zonder[0].scherm, 'fondsen');
  assert.deepStrictEqual(m.fondsKaarten(), { zet: [], dicht: [] });
  const fz = m.app({ pad: '/app/ghawa/fonds', methode: 'POST', body: { id: 'F02', termijn: '2026-11-15', bevestigd: true } });
  assert.strictEqual(fz.status, 200);
  o = m.app({ pad: '/app/ghawa' }).body;
  assert.ok(!o.aandacht.some((a) => a.label === 'datum'));
  assert.ok(o.aandacht.some((a) => a.label === 'termijn' && /termijn verlopen/.test(a.titel)));
  const f = m.app({ pad: '/app/ghawa/fondsen' }).body;
  const rij = f.dossiers.flatMap((d) => d.fondsen).find((y) => y.id === 'F02');
  assert.match(rij.opvolg.bericht, /^Beste Club Vallei,/); assert.match(rij.opvolg.bericht, /€ 20 voor interior/); assert.match(rij.opvolg.bericht, /15 november 2026/);
  assert.match(rij.opvolg.onderwerp, /Toezegging € 20/);
  assert.strictEqual(f.dossiers.flatMap((d) => d.fondsen).find((y) => y.id === 'F01').opvolg, null);   // ontvangen: geen opvolging
  const k = m.fondsKaarten();
  assert.strictEqual(k.zet.length, 1); assert.strictEqual(k.zet[0].sleutel, 'ghawa-fonds-f02-2026-11-15');
  assert.ok(k.zet[0].titel.length <= 90 && k.zet[0].waarom.length <= 400); assert.deepStrictEqual(k.zet[0].herkomst.doel, { scherm: 'ghawa', focus: 'fondsen' });
  assert.ok(k.zet[0].stappen.every((s) => !/wv\d|\/opt\/|\.md\b/.test(s)));
  m.kaartGezet(k.zet[0].sleutel);
  assert.deepStrictEqual(m.fondsKaarten(), { zet: [], dicht: [] });   // nooit dubbel
  // opvolgconcept via conceptVoor; vóór de datum geweigerd
  assert.strictEqual(m.conceptVoor({ wat: 'fonds', id: 'F01', aan: 'fonds@voorbeeld.test' }).status, 409);
  const cv = m.conceptVoor({ wat: 'fonds', id: 'F02', aan: 'fonds@voorbeeld.test' });
  assert.strictEqual(cv.ok, true); assert.strictEqual(cv.dossier, 'Club Vallei');
  m.conceptGezet(cv, 'app 1');
  const f2 = m.app({ pad: '/app/ghawa/fondsen' }).body;
  assert.strictEqual(f2.dossiers.find((d) => d.naam === 'Club Vallei').aan, 'fonds@voorbeeld.test');
  // ontvangen → kaart mag dicht, één keer
  m.app({ pad: '/app/ghawa/fonds', methode: 'POST', body: { id: 'F02', status: 'Received by GHAWA NL', bevestigd: true } });
  assert.deepStrictEqual(m.fondsKaarten().dicht, ['ghawa-fonds-f02-2026-11-15']);
  m.kaartDicht('ghawa-fonds-f02-2026-11-15');
  assert.deepStrictEqual(m.fondsKaarten(), { zet: [], dicht: [] });
  void db; void zetNu;
});

test('(f) gedekt rond <maand> bij gelijke instroom en het koerseffect (± 5 dalasi per euro)', () => {
  const { db } = opzet();
  const d = G.leesData(db); d.vandaag = '2026-11-22';
  const k = G.bereken(d);
  const w = k.werven;
  assert.ok(Array.isArray(w.koers_effect) && w.koers_effect.length === 2);
  assert.deepStrictEqual(w.koers_effect.map((x) => x.koers), [75, 85]);   // fixture-koers 80
  if (w.nog_te_werven > 0) {
    assert.strictEqual(w.gedekt.nu, false);
    const perMaand = w.gedekt.per_jaar / 12;
    assert.strictEqual(w.gedekt.maanden, Math.ceil(w.nog_te_werven / perMaand));
    assert.match(w.gedekt.rond, /^\d{4}-\d{2}$/);
  } else assert.deepStrictEqual(w.gedekt, { nu: true });
  // lagere koers = meer euro nodig voor de dalasi-begroting (of gelijk als alles al gedekt is)
  assert.ok(w.koers_effect[0].nog_te_werven >= w.koers_effect[1].nog_te_werven);
  // de som klopt met de rekenkern bij de eigen koers
  const zelf = (() => { const d2 = G.leesData(db); d2.vandaag = '2026-11-22'; d2.instelling.indicative_rate_gmd_per_eur = '75'; return G.bereken(d2).werven.nog_te_werven; })();
  assert.strictEqual(w.koers_effect[0].nog_te_werven, zelf);
});

// ── server.js: POST /app/ghawa/gmail (nep-mailluik) en de fondskaarten in de tik ──
function knip(bron, begin) {
  const i = bron.indexOf(begin); assert.ok(i >= 0, 'niet gevonden: ' + begin);
  const j = bron.indexOf('\n}\n', i); return bron.slice(i, j + 3);
}
function serverCtx(m) {
  const bron = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const code = 'let ghawaGmailBezig = false;\n' + knip(bron, 'async function appGhawaGmail(') + knip(bron, 'async function ghawaFondsKaarten(');
  const luik = [], vj = [], dicht = [];
  const ctx = { ghawaApp: m, ghawaDeel: null, APP_GMAIL_CONCEPTEN: 'https://mail.example/drafts', logError: () => {},
    appTeller: () => true, appWeiger: (res, st, fout) => ({ st, body: { ok: false, fout } }), appStuur: (res, st, body) => ({ st, body }),
    bandjesMailConcept: async (c) => { luik.push(c); return ctx.luikAntwoord || { ok: true, concept_id: 'r1' }; },
    aixVoorJou: async (k) => { vj.push(k.sleutel); return { sleutel: k.sleutel }; }, aixVoorJouSluit: async (s) => { dicht.push(s); return true; } };
  vm.createContext(ctx); vm.runInContext(code + '\nthis.appGhawaGmail = appGhawaGmail; this.ghawaFondsKaarten = ghawaFondsKaarten;', ctx);
  return { ctx, luik, vj, dicht };
}
test('server: Gmail-concept via het mailluik (nooit versturen), pas na bevestiging vastgelegd; mislukt = niets vastgelegd', async () => {
  const { m } = opzet();
  const { ctx, luik } = serverCtx(m);
  const res = { _app: {} };
  assert.strictEqual((await ctx.appGhawaGmail(res, { id: 'abcdefghij' }, { wat: 'vragen', aan: 'fout' })).st, 400);
  assert.strictEqual(luik.length, 0);
  ctx.luikAntwoord = { ok: false, zeker: true, reden: 'het mailluik weigerde het concept (HTTP 400)' };
  const mis = await ctx.appGhawaGmail(res, { id: 'abcdefghij' }, { wat: 'vragen', aan: 'partner@voorbeeld.test' });
  assert.strictEqual(mis.st, 502); assert.match(mis.body.fout, /Er staat geen concept in Gmail/);
  assert.strictEqual(m.app({ pad: '/app/ghawa/vragen' }).body.vragen.find((y) => y.id === 'Q05').concept_op, null);   // niets vastgelegd
  ctx.luikAntwoord = null;
  const ok = await ctx.appGhawaGmail(res, { id: 'abcdefghij' }, { wat: 'vragen', aan: 'partner@voorbeeld.test' });
  assert.strictEqual(ok.st, 200); assert.deepStrictEqual([...ok.body.ids], ['Q05', 'Q06', 'Q01', 'Q03']);
  assert.strictEqual(luik.length, 2); assert.deepStrictEqual(Object.keys(luik[1]).sort(), ['aan', 'bericht', 'onderwerp']);   // geen verzendveld
  assert.strictEqual(luik[1].aan, 'partner@voorbeeld.test'); assert.match(luik[1].bericht, /Q05/);
  assert.match(res._app.reden, /^ghawa gmail vragen Q05,Q06,Q01,Q03$/);
  assert.strictEqual(m.app({ pad: '/app/ghawa/vragen' }).body.vragen.find((y) => y.id === 'Q05').concept_op, NU);
});
test('server: dubbel tikken geeft één concept', async () => {
  const { m } = opzet();
  const { ctx, luik } = serverCtx(m);
  let los; ctx.bandjesMailConcept = (c) => new Promise((ok) => { luik.push(c); los = () => ok({ ok: true, concept_id: 'r1' }); });
  const een = ctx.appGhawaGmail({ _app: {} }, null, { wat: 'vragen', aan: 'partner@voorbeeld.test' });
  const twee = await ctx.appGhawaGmail({ _app: {} }, null, { wat: 'vragen', aan: 'partner@voorbeeld.test' });
  assert.strictEqual(twee.st, 409); los(); assert.strictEqual((await een).st, 200); assert.strictEqual(luik.length, 1);
});
test('server: fondskaart één keer gezet en dicht na ontvangen', async () => {
  const { m } = opzet();
  m.app({ pad: '/app/ghawa/fonds', methode: 'POST', body: { id: 'F02', termijn: '2026-11-15', bevestigd: true } });
  const { ctx, vj, dicht } = serverCtx(m);
  assert.strictEqual(await ctx.ghawaFondsKaarten(), 1); assert.strictEqual(await ctx.ghawaFondsKaarten(), 0);
  assert.deepStrictEqual(vj, ['ghawa-fonds-f02-2026-11-15']);
  m.app({ pad: '/app/ghawa/fonds', methode: 'POST', body: { id: 'F02', termijn: '2027-01-31', bevestigd: true } });   // nieuwe datum
  await ctx.ghawaFondsKaarten(); await ctx.ghawaFondsKaarten();
  assert.deepStrictEqual(dicht, ['ghawa-fonds-f02-2026-11-15']);
});
