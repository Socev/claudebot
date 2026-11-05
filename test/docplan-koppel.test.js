'use strict';
// Toetst docplan-koppel.js (wv2159, Facturen › Waarnemers › Roosternamen) op verzonnen gegevens ("Bram Proefsen", "XQ", "Feestdag proef"):
// vorm van de lijst (alleen namen met dagen, volgorde, tellingen), de schrijfroute (altijd p_door 'david', alleen witte-lijstvelden) en de weigeringen.
const test = require('node:test');
const assert = require('node:assert');
const M = require('../docplan-koppel.js');

const NU = Date.parse('2026-11-01T10:00:00Z');
const EIG = { soort: 'eigenaar', ingang: 'app', wie: 'david (toets)', entiteiten: null };
const P1 = '11111111-1111-4111-8111-111111111111', P2 = '22222222-2222-4222-8222-222222222222';
const LIJST = {
  jaar: 2026, afwijking: 0,
  praktijken: [
    { code: 'GH', object_id: 'x', namen: [
      { naam: 'XQ', dagen: 3, status: 'voorgesteld', object_id: P1, persoon: 'Bram Proefsen', samengevoegd: false },
      { naam: 'Oud', dagen: 0, status: null, object_id: null, persoon: null } ] },
    { code: 'TG', object_id: 'y', namen: [
      { naam: 'BP', dagen: 10, status: 'bevestigd', object_id: P1, persoon: 'Bram Proefsen', samengevoegd: false },
      { naam: 'Feestdag proef', dagen: 1, status: 'geen', object_id: null, persoon: null },
      { naam: 'ZZ', dagen: 2.5, status: null, object_id: null, persoon: null },
      { naam: 'KV', dagen: 4, status: 'voorgesteld', object_id: P2, persoon: 'K. Verzonnen', samengevoegd: false },
      { naam: 'NN', dagen: 1, status: 'nieuw', object_id: null, persoon: null },
      { naam: 'AA', dagen: 7, status: null, object_id: null, persoon: null } ] },
    { code: 'XX', namen: [{ naam: 'vreemd', dagen: 1 }] } ],
  personen: [{ object_id: P1, naam: 'Bram Proefsen', status: 'voorgesteld', rollen: [{ praktijk: 'TG', rol: 'Waarnemend huisarts (ZZP)' }, { praktijk: 'GH', rol: 'Waarnemend huisarts (ZZP)' }] },
    { object_id: P2, naam: 'K. Verzonnen', status: 'actief', rollen: [{ praktijk: 'TG', rol: 'Huisarts' }] }],
};
function route(o) {
  const aanroepen = [];
  const r = M.maak(Object.assign({ rpc: async (fn, body) => { aanroepen.push({ fn, body }); return fn === 'sb_dienst_alias_lijst' ? LIJST : { nieuw: 0, bijgewerkt: 1, ongewijzigd: 0, overgeslagen: 0, weg: 0, fouten: [] }; } }, o || {}));
  return { r, aanroepen };
}
const v = (o) => Object.assign({ methode: 'GET', pad: '/app/facturen/roosternamen', rol: EIG, primair: true, nu: NU }, o);

test('lijst: alleen namen met dagen in het jaar, TG eerst; eerst zonder persoon, dan voorgesteld, dan gekozen; tellingen', async () => {
  const { r, aanroepen } = route();
  const x = await r.app(v());
  assert.strictEqual(x.status, 200);
  assert.deepStrictEqual(aanroepen, [{ fn: 'sb_dienst_alias_lijst', body: { p_jaar: 2026 } }]);
  assert.deepStrictEqual(x.j.praktijken.map((p) => p.code), ['TG', 'GH']);
  const tg = x.j.praktijken[0];
  assert.deepStrictEqual(tg.namen.map((n) => n.naam + ':' + n.status), ['AA:zonder', 'ZZ:zonder', 'NN:nieuw', 'KV:voorgesteld', 'BP:bevestigd', 'Feestdag proef:geen']);
  assert.deepStrictEqual([tg.n_namen, tg.n_zonder, tg.n_nieuw, tg.n_voorgesteld, tg.n_bevestigd, tg.n_geen], [6, 3, 1, 1, 1, 1]);
  assert.strictEqual(tg.n_zonder + tg.n_voorgesteld + tg.n_bevestigd + tg.n_geen, tg.n_namen, 'zonder + voorgesteld + bevestigd + geen = alle namen');
  assert.strictEqual(tg.dagen_zonder, 10.5);
  assert.deepStrictEqual(x.j.praktijken[1].namen.map((n) => n.naam), ['XQ'], 'naam zonder dagen in het jaar valt weg');
  assert.deepStrictEqual(x.j.personen[0].praktijken, ['TG', 'GH']);
  assert.deepStrictEqual(x.j.jaren, ['2025', '2026', '2027']);
  assert.strictEqual(x.j.afwijking, 0);
  assert.ok(!/Proefsen|XQ|BP/.test(x.reden), 'reden zonder namen');
  assert.strictEqual((await r.app(v({ pad: '/app/facturen/roosternamen/2025' }))).status, 200);
  assert.deepStrictEqual(aanroepen[1].body, { p_jaar: 2025 });
});

test('bevestigen: één item, altijd p_door david; velden van buiten de witte lijst gaan niet mee', async () => {
  const { r, aanroepen } = route();
  const x = await r.app(v({ methode: 'POST', d: { praktijk: 'TG', naam: 'KV', status: 'bevestigd', object_id: P2, p_door: 'voorstel', door: 'voorstel', bron: { x: 1 }, p_items: [] } }));
  assert.strictEqual(x.status, 200);
  assert.deepStrictEqual(aanroepen, [{ fn: 'sb_dienst_alias_zet', body: { p_items: [{ praktijk: 'TG', naam: 'KV', status: 'bevestigd', bron: 'koppelscherm', object_id: P2 }], p_door: 'david' } }]);
  assert.strictEqual(x.reden, 'roosternaam bevestigd');
  for (const st of ['geen', 'nieuw', 'weg']) {
    const y = await r.app(v({ methode: 'POST', d: { praktijk: 'GH', naam: 'XQ', status: st } }));
    assert.strictEqual(y.status, 200, st);
    assert.deepStrictEqual(aanroepen[aanroepen.length - 1].body, { p_items: [{ praktijk: 'GH', naam: 'XQ', status: st, bron: 'koppelscherm' }], p_door: 'david' });
  }
});

test('ongeldige keuzes: 400 zonder aanroep van de databank', async () => {
  const { r, aanroepen } = route();
  const slecht = [{}, { praktijk: 'XX', naam: 'a', status: 'geen' }, { praktijk: 'TG', naam: ' a', status: 'geen' }, { praktijk: 'TG', naam: '', status: 'geen' },
    { praktijk: 'TG', naam: 'a\nb', status: 'geen' }, { praktijk: 'TG', naam: 'x'.repeat(201), status: 'geen' }, { praktijk: 'TG', naam: 'a', status: 'voorgesteld' },
    { praktijk: 'TG', naam: 'a', status: 'bevestigd' }, { praktijk: 'TG', naam: 'a', status: 'bevestigd', object_id: 'geen-uuid' },
    { praktijk: 'TG', naam: 'a', status: 'geen', object_id: P1 }, { praktijk: 'TG', naam: 1, status: 'geen' }];
  for (const d of slecht) assert.strictEqual((await r.app(v({ methode: 'POST', d }))).status, 400, JSON.stringify(d).slice(0, 60));
  assert.strictEqual((await r.app(v({ methode: 'POST', d: null }))).status, 400);
  assert.strictEqual((await r.app(v({ methode: 'POST', d: [{ praktijk: 'TG', naam: 'a', status: 'geen' }] }))).status, 400);
  assert.strictEqual(aanroepen.length, 0);
});

test('403 zonder eigenaarssessie (praktijkmanager, geen rol, andere ingang), ook voor POST; geen databankaanroep', async () => {
  const { r, aanroepen } = route();
  for (const rol of [null, undefined, { soort: 'praktijkmanager', ingang: 'fac', entiteiten: ['tolgaarde'] }, { soort: 'eigenaar', ingang: 'fac' }, { soort: 'eigenaar' }]) {
    assert.strictEqual((await r.app(v({ rol }))).status, 403);
    assert.strictEqual((await r.app(v({ rol, methode: 'POST', d: { praktijk: 'TG', naam: 'KV', status: 'geen' } }))).status, 403);
  }
  assert.strictEqual(aanroepen.length, 0);
});

test('404 andere methoden en paden, 409 niet primair, 400 jaar buiten bereik', async () => {
  const { r, aanroepen } = route();
  const st = async (o) => (await r.app(v(o))).status;
  assert.strictEqual(await st({ methode: 'DELETE' }), 404);
  assert.strictEqual(await st({ methode: 'POST', pad: '/app/facturen/roosternamen/2026', d: { praktijk: 'TG', naam: 'KV', status: 'geen' } }), 404);
  assert.strictEqual(await st({ pad: '/app/facturen/roosternamen/abc' }), 404);
  assert.strictEqual(await st({ pad: '/app/facturen/roosternamenx' }), 404);
  assert.strictEqual(await st({ primair: false }), 409);
  assert.strictEqual(await st({ primair: false, methode: 'POST', d: { praktijk: 'TG', naam: 'KV', status: 'geen' } }), 409);
  assert.strictEqual(await st({ pad: '/app/facturen/roosternamen/2024' }), 400);
  assert.strictEqual(await st({ pad: '/app/facturen/roosternamen/2028' }), 400);
  assert.strictEqual(aanroepen.length, 0);
});

test('databank weigert een item: 409 met de reden; databank weg: 503 zonder inhoud', async () => {
  const fouten = [];
  const r1 = M.maak({ rpc: async () => ({ nieuw: 0, bijgewerkt: 0, ongewijzigd: 0, overgeslagen: 0, weg: 0, fouten: [{ praktijk: 'TG', naam: 'KV', reden: 'naam staat niet in het rooster van deze praktijk' }] }) });
  const x = await r1.app(v({ methode: 'POST', d: { praktijk: 'TG', naam: 'KV', status: 'geen' } }));
  assert.strictEqual(x.status, 409);
  assert.match(x.j.fout, /niet opgeslagen: naam staat niet in het rooster/);
  const r2 = M.maak({ rpc: async () => { throw new Error('rpc sb_dienst_alias_zet http 500'); }, fout: (w, e) => fouten.push(w + ' ' + e.message) });
  assert.strictEqual((await r2.app(v({ methode: 'POST', d: { praktijk: 'TG', naam: 'KV', status: 'geen' } }))).status, 503);
  const g = await r2.app(v());
  assert.strictEqual(g.status, 503);
  assert.deepStrictEqual(Object.keys(g.j).sort(), ['fout', 'ok']);
  assert.ok(fouten.every((f) => !/KV/.test(f)), 'geen roosternaam in de log');
  const r3 = M.maak({ rpc: async () => null });
  assert.strictEqual((await r3.app(v({ methode: 'POST', d: { praktijk: 'TG', naam: 'KV', status: 'geen' } }))).status, 503);
});

// ── wv2531: "Nieuwe persoon" gaat zelf naar de werklijst van de machinekamer ──
function routeNieuw(o) {
  const werk = [], aanroepen = [];
  let staat = {};
  const r = M.maak(Object.assign({
    rpc: async (fn, body) => { aanroepen.push({ fn, body }); return fn === 'sb_dienst_alias_lijst' ? LIJST : { nieuw: 0, bijgewerkt: 1, ongewijzigd: 0, overgeslagen: 0, weg: 0, fouten: [] }; },
    nieuw: async (items, nu) => { werk.push({ items, nu }); items.forEach((it) => { staat[it.praktijk + '|' + it.naam] = { t: it.t || '2026-11-01T10:00:00.000Z', wv: 77 }; }); return { ok: true, id: 77 }; },
    gevraagd: () => { const s = Object.assign({}, staat); return (p, n) => s[p + '|' + n] || null; },
  }, o || {}));
  return { r, werk, aanroepen, zet: (k, w) => { staat[k] = w; } };
}

test('wv2531 POST nieuw: na de keuze één werklijst-aanroep met praktijk, naam en tijdstip; werklijst true', async () => {
  const { r, werk, aanroepen } = routeNieuw();
  const x = await r.app(v({ methode: 'POST', d: { praktijk: 'TG', naam: 'NN', status: 'nieuw' } }));
  assert.strictEqual(x.status, 200);
  assert.strictEqual(x.j.werklijst, true);
  assert.deepStrictEqual(werk, [{ items: [{ praktijk: 'TG', naam: 'NN', t: '2026-11-01T10:00:00.000Z' }], nu: NU }]);
  assert.strictEqual(aanroepen[0].fn, 'sb_dienst_alias_zet', 'eerst de keuze in de databank, dan de werklijst');
  for (const st of ['geen', 'weg']) await r.app(v({ methode: 'POST', d: { praktijk: 'TG', naam: 'NN', status: st } }));
  await r.app(v({ methode: 'POST', d: { praktijk: 'TG', naam: 'KV', status: 'bevestigd', object_id: P2 } }));
  assert.strictEqual(werk.length, 1, 'andere keuzes gaan niet naar de werklijst');
});

test('wv2531 POST nieuw: werklijst faalt of geeft niets → keuze blijft 200, werklijst false, fout gelogd zonder naam', async () => {
  const fouten = [];
  for (const nieuw of [async () => { throw new Error('rpc mk_werkvoorraad_zet http 500'); }, async () => null, async () => ({ ok: false })]) {
    const { r } = routeNieuw({ nieuw, fout: (w, e) => fouten.push(w + ' ' + e.message) });
    const x = await r.app(v({ methode: 'POST', d: { praktijk: 'TG', naam: 'NN', status: 'nieuw' } }));
    assert.strictEqual(x.status, 200);
    assert.strictEqual(x.j.werklijst, false);
  }
  assert.strictEqual(fouten.length, 1);
  assert.ok(!/NN/.test(fouten[0]));
  const zonder = M.maak({ rpc: async () => ({ nieuw: 1, bijgewerkt: 0, ongewijzigd: 0, overgeslagen: 0, weg: 0, fouten: [] }) });
  const y = await zonder.app(v({ methode: 'POST', d: { praktijk: 'TG', naam: 'NN', status: 'nieuw' } }));
  assert.strictEqual(y.status, 200);
  assert.ok(!('werklijst' in y.j), 'zonder o.nieuw: antwoord zoals vóór wv2531');
});

test('wv2531 GET: nieuw-naam die nog niet op de werklijst staat gaat erop (t null); daarna gevraagd_op + op_werklijst; staat hij er al: geen aanroep', async () => {
  const { r, werk, zet } = routeNieuw();
  const x = await r.app(v());
  assert.strictEqual(x.status, 200);
  assert.deepStrictEqual(werk.map((w) => w.items), [[{ praktijk: 'TG', naam: 'NN', t: null }]]);
  const nn = x.j.praktijken[0].namen.find((n) => n.naam === 'NN');
  assert.deepStrictEqual([nn.status, nn.op_werklijst, nn.gevraagd_op], ['nieuw', true, '2026-11-01T10:00:00.000Z']);
  assert.ok(x.j.praktijken[0].namen.filter((n) => n.status !== 'nieuw').every((n) => !('gevraagd_op' in n)), 'alleen nieuw-namen krijgen de velden');
  zet('TG|NN', { t: '2026-11-01T09:42:00.000Z', wv: 78 });
  const y = await r.app(v());
  assert.strictEqual(werk.length, 1, 'staat al op de werklijst: geen tweede aanroep');
  assert.strictEqual(y.j.praktijken[0].namen.find((n) => n.naam === 'NN').gevraagd_op, '2026-11-01T09:42:00.000Z');
});

test('wv2531 GET: werklijst of opzoeker faalt → lijst blijft 200, nieuw-naam zonder werklijst; zonder opties zoals vóór wv2531', async () => {
  const { r } = routeNieuw({ nieuw: async () => { throw new Error('weg'); }, fout: () => {}, gevraagd: () => { throw new Error('onleesbaar'); } });
  const x = await r.app(v());
  assert.strictEqual(x.status, 200);
  const nn = x.j.praktijken[0].namen.find((n) => n.naam === 'NN');
  assert.deepStrictEqual([nn.op_werklijst, nn.gevraagd_op], [false, null]);
  const kaal = M.maak({ rpc: async () => LIJST });
  const k = await kaal.app(v());
  assert.strictEqual(k.status, 200);
  const kn = k.j.praktijken[0].namen.find((n) => n.naam === 'NN');
  assert.deepStrictEqual([kn.status, kn.op_werklijst, kn.gevraagd_op], ['nieuw', false, null], 'zonder opzoeker: nieuw zonder werklijst');
});

// server.js: de werklijstrij zelf (knipsel docplanNieuw* in een vm met nep-rpc; verzonnen namen)
test('wv2531 server.js: één rij per uur, label met Amsterdams uur, niet vóór het volgende hele uur, herkomst david alleen bij een nieuwe rij, geen naam in prompt of log', async () => {
  const fs = require('fs'), vm = require('vm'), path = require('path'), crypto = require('crypto');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const a = src.indexOf("const DOCPLAN_NIEUW_STAAT = "), b = src.indexOf("return { ok: true, id: z.id, bestond: !!z.bestond };\n}", a);
  assert.ok(a > 0 && b > a, 'knipsel gevonden');
  const knip = src.slice(a, b) + "return { ok: true, id: z.id, bestond: !!z.bestond };\n}\nthis.zet = docplanNieuwZet; this.opz = docplanNieuwOpzoeker;";
  const J = (x) => JSON.parse(JSON.stringify(x));   // vm-objecten komen uit een ander realm
  const rpc = [], log = [];
  let schijf = null, rijen = {};
  const ctx = {
    process: { env: {} }, crypto, Promise, Date, Number, Object, String, Math, Error, JSON,
    fs: { readFileSync: () => 'GRONDWET-KERN v1\nblok' }, DOORGEEF_BLOK: '/x', MK_TEKST: null,
    appLeesStreng: (f, leeg) => (schijf ? JSON.parse(schijf) : leeg), appSchrijfJson: (f, d) => { schijf = JSON.stringify(d); },
    appSbRpc: async (fn, body) => {
      rpc.push({ fn, body });
      if (fn === 'mk_werkvoorraad_zet') { if (rijen[body.p_label]) return { ok: true, id: rijen[body.p_label], bestond: true }; rijen[body.p_label] = 100 + Object.keys(rijen).length; return { ok: true, id: rijen[body.p_label], bestond: false }; }
      return { ok: true, herkomst: 'david' };
    },
    logError: () => {}, schrijfLog: (r) => log.push(r), nu: () => 'NU', velden: (o) => JSON.stringify(o),
  };
  vm.createContext(ctx);
  vm.runInContext(knip, ctx);
  const t1 = Date.parse('2026-11-05T20:42:09Z');   // 21:42 in Amsterdam
  const u1 = await ctx.zet([{ praktijk: 'TG', naam: 'Proef Verzonnen', t: new Date(t1).toISOString() }], t1);
  const u2 = await ctx.zet([{ praktijk: 'TG', naam: 'Tweede Proef', t: null }], t1 + 60000);
  const u3 = await ctx.zet([{ praktijk: 'GH', naam: 'Derde Proef', t: null }], Date.parse('2026-11-05T21:01:00Z'));
  assert.deepStrictEqual([u1.id, u1.bestond, u2.id, u2.bestond, u3.id, u3.bestond], [100, false, 100, true, 101, false]);
  const zet = rpc.filter((x) => x.fn === 'mk_werkvoorraad_zet');
  assert.deepStrictEqual(zet.map((x) => x.body.p_label), ['machinekamer:docplan-nieuwe-persoon-2026110521', 'machinekamer:docplan-nieuwe-persoon-2026110521', 'machinekamer:docplan-nieuwe-persoon-2026110522']);
  assert.strictEqual(zet[0].body.p_niet_voor, '2026-11-05T21:00:00.000Z');
  assert.strictEqual(zet[0].body.p_status, 'open');
  assert.match(zet[0].body.p_prompt, /^GRONDWET-KERN v1/);
  assert.match(zet[0].body.p_prompt, /status = 'nieuw'/);
  assert.deepStrictEqual(J(rpc.filter((x) => x.fn === 'mk_werkvoorraad_herkomst').map((x) => x.body)), [{ p_id: 100, p_herkomst: 'david' }, { p_id: 100, p_herkomst: 'david' }, { p_id: 101, p_herkomst: 'david' }]);
  const alles = JSON.stringify(rpc) + log.join('\n') + schijf;
  assert.ok(!/Proef|Verzonnen/.test(alles), 'geen naam in prompt, notitie, log of staatbestand');
  ctx.Date = class extends Date { static now() { return t1 + 3600000; } };   // opzoeker rekent met Date.now()
  const opz = ctx.opz();
  assert.deepStrictEqual(J(opz('TG', 'Proef Verzonnen')), { t: '2026-11-05T20:42:09.000Z', wv: 100 });
  assert.deepStrictEqual(J(opz('TG', 'Tweede Proef')), { t: '2026-11-05T20:43:09.000Z', wv: 100 });
  assert.strictEqual(opz('TG', 'Onbekend'), null);
  // oud gevraagd tijdstip blijft staan als de naam later (t null) opnieuw meegaat; ouder dan 30 dagen valt weg
  ctx.Date = class extends Date { static now() { return t1 + 25 * 3600000; } };
  assert.strictEqual(ctx.opz()('TG', 'Proef Verzonnen'), null, 'na 24 uur telt de werklijst niet meer: de GET zet hem opnieuw');
  await ctx.zet([{ praktijk: 'TG', naam: 'Proef Verzonnen', t: null }], t1 + 25 * 3600000);
  assert.strictEqual(ctx.opz()('TG', 'Proef Verzonnen').t, '2026-11-05T20:42:09.000Z', 'oorspronkelijk tijdstip blijft');
  ctx.Date = Date;
  await ctx.zet([{ praktijk: 'GH', naam: 'Later', t: null }], Date.parse('2026-12-10T10:00:00Z'));
  assert.strictEqual(ctx.opz()('TG', 'Proef Verzonnen'), null);
  // werkvoorraad geeft niets terug → fout naar boven (de module vangt hem)
  ctx.appSbRpc = async () => null;
  await assert.rejects(ctx.zet([{ praktijk: 'TG', naam: 'x', t: null }], t1), /werkvoorraad gaf geen rij terug/);
});
