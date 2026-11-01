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
