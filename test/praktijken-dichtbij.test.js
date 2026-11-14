// wv3081: PMA › Jaarcijfers — de gemeente van de praktijk naast haar regio en Nederland (GET /app/praktijken, veld dichtbij).
// Knipt het Praktijken-blok uit server.js en draait het met stubs (geen netwerk). Alle cijfers hieronder zijn verzonnen.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const begin = SRC.indexOf('// ── Praktijken (fase 6 rest, wv174');
const eind = SRC.indexOf('// ── App Financiën (wv771');
assert.ok(begin > 0 && eind > begin, 'Praktijken-blok niet gevonden');
const BLOK = SRC.slice(begin, eind);

function laad(stubs) {
  const ctx = {
    console, Date, Math, Number, String, Object, Array, Set, Promise, JSON, isFinite, AbortSignal, Error,
    process: { env: {} },
    appStaat: {},
    logs: [],
    appKort: (s, n) => String(s == null ? '' : s).slice(0, n),
    appWeiger: () => {}, appStuur: () => {},
    fetch: () => Promise.reject(new Error('geen netwerk in de toets')),
    ...stubs,
  };
  ctx.logError = (w, e) => ctx.logs.push(w + ': ' + (e && e.message));
  vm.createContext(ctx);
  vm.runInContext(BLOK + '\n;this.uit = { appDichtbijBlok, appDichtbij, appDichtbijTegel, appPraktijkenVerzamel, APP_PRAKTIJKEN };', ctx);
  if (stubs.appFinSql) ctx.appFinSql = stubs.appFinSql;   // de echte appFinSql uit het blok vervangen (geen netwerk)
  return ctx;
}

const j = (x) => JSON.parse(JSON.stringify(x));   // waarden uit de vm-context hebben een ander prototype
const vers = (stand, op) => ({ code: 'x', stand, ververst_op: op || '2026-11-01T10:00:00+00:00' });
function profiel() {   // verzonnen gemeente "Proefdorp" in regio "Proefland" (3 gemeenten)
  return {
    ok: true,
    gemeente: { code: 'GM9999', naam: 'Proefdorp' },
    regio: { indeling: 'jeugdregio', code: 'JZ99', naam: 'Proefland', gemeenten: ['Proefdorp', 'Proefstad', 'Proefveen'] },
    reeksen: [
      { code: 'inwoners', naam: 'Inwoners (1 januari)', eenheid: 'personen', decimalen: 0, jaren: [{ jaar: 2026, gemeente: 1000, regio: 5000, regio_n: 3, nl: 20000 }],
        bronnen: ['CBS proefbron'], versheid: [vers('bij')] },
      { code: 'aandeel_65plus', naam: 'Aandeel 65-plus', eenheid: '%', decimalen: 1,
        jaren: [{ jaar: 2025, gemeente: 20.04, regio: 18.0, regio_n: 3, nl: 19.0 }, { jaar: 2026, gemeente: 21.4567, regio: 18.888, regio_n: 3, nl: 20.111 }],
        bronnen: ['CBS proefbron'], versheid: [vers('bij', '2026-11-10T00:00:00Z'), vers('bron heeft nieuwer', '2026-10-01T00:00:00Z')] },
      { code: 'aandeel_80plus', naam: 'Aandeel 80-plus', eenheid: '%', decimalen: 1,
        jaren: [{ jaar: 2026, gemeente: 5.55, regio: null, regio_n: 2, nl: 5.0 }], bronnen: ['CBS proefbron'], versheid: [vers('bij')] },
      { code: 'kosten_hz_pv', naam: 'Kosten huisartsenzorg per verzekerde', eenheid: '€ per verzekerdejaar', decimalen: 0, kanttekening: 'Kosten per verzekerde zijn geen doelmatigheidsmaat.',
        jaren: [{ jaar: 2014, gemeente: 150, regio: 150, regio_n: 3, nl: 150 }, { jaar: 2015, gemeente: 200.4, regio: 210.6, regio_n: 3, nl: 205 },
          { jaar: 2016, gemeente: 220, regio: 221, regio_n: 3, nl: 222 }],
        bronnen: ['Vektis Open Databestand proef'], versheid: [vers('bij')] },
      { code: 'afstand_huisarts_km', naam: 'Afstand tot huisartsenpraktijk', eenheid: 'km', decimalen: 1,
        jaren: [{ jaar: 2025, gemeente: 0.84, regio: 0.9, regio_n: 3, nl: 1.1 }, { jaar: 2026, gemeente: null, regio: null, regio_n: 0, nl: 1.2 }],
        bronnen: ['CBS 80305ned proef'], versheid: [vers('niet recent gekeken')] },
      { code: 'afstand_hap_km', naam: 'Afstand tot huisartsenpost', eenheid: 'km', decimalen: 1, jaren: [], bronnen: null, versheid: null },
    ],
  };
}

test('blok: vijf vaste reeksen, laatste jaar met gemeentecijfer, regio en NL uit hetzelfde jaar', () => {
  const c = laad({});
  const b = c.uit.appDichtbijBlok(profiel(), ['TG', 'GH']);
  assert.ok(b);
  assert.strictEqual(b.gemeente.naam, 'Proefdorp');
  assert.strictEqual(b.regio.naam, 'Proefland');
  assert.strictEqual(b.regio.gemeenten.length, 3);
  assert.strictEqual(b.gemeente.inwoners, 1000);
  assert.strictEqual(b.regio.inwoners, 5000);
  assert.deepStrictEqual(j(b.praktijken), ['TG', 'GH']);
  // afstand_hap_km heeft geen jaren: geen tegel; inwoners is geen tegel
  assert.deepStrictEqual(j(b.tegels.map((t) => t.code)), ['kosten_hz_pv', 'aandeel_65plus', 'aandeel_80plus', 'afstand_huisarts_km']);
  const a65 = b.tegels.find((t) => t.code === 'aandeel_65plus');
  assert.deepStrictEqual(j([a65.jaar, a65.gemeente, a65.regio, a65.nl]), [2026, 21.5, 18.9, 20.1]);
  assert.strictEqual(a65.stand, 'bron heeft nieuwer', 'slechtste versheid telt');
  assert.strictEqual(a65.ververst, '2026-11-10');
  const afst = b.tegels.find((t) => t.code === 'afstand_huisarts_km');
  assert.deepStrictEqual(j([afst.jaar, afst.gemeente, afst.nl]), [2025, 0.8, 1.1], 'jaar zonder gemeentecijfer telt niet als laatste');
  const a80 = b.tegels.find((t) => t.code === 'aandeel_80plus');
  assert.strictEqual(a80.regio, null, 'onvolledige regio = geen regiocijfer');
  assert.strictEqual(a80.regio_n, 2);
  assert.ok(!/berekend/.test(a80.bron), 'zonder regiocijfer geen "berekend" in de bron');
  assert.ok(/Proefland berekend uit de 3 gemeenten/.test(a65.bron));
});

test('Vektis: bronvermelding "bron: Vektis" en de vaste kanttekening', () => {
  const b = laad({}).uit.appDichtbijBlok(profiel(), ['TG']);
  const k = b.tegels.find((t) => t.code === 'kosten_hz_pv');
  assert.ok(k.bron.startsWith('bron: Vektis'));
  assert.ok(/geen doelmatigheidsmaat/.test(k.kanttekening));
  assert.strictEqual(k.gemeente, 220);
  const g = b.grafieken[0];
  assert.strictEqual(g.soort, 'lijn');
  assert.deepStrictEqual(j(g.x), ['2015', '2016'], 'lijn vanaf 2015');
  assert.deepStrictEqual(j(g.reeksen.map((r) => r.naam)), ['Proefdorp', 'Proefland', 'Nederland']);
  assert.deepStrictEqual(j(g.reeksen[0].waarden), [200, 220]);
  assert.ok(g.bron.startsWith('Vektis — '), 'de grafiek zet er zelf "Bron:" voor');
});

test('vraag voor de Cijfer-Meester: gemeente, regio en Nederland, zonder eigen cijfers', () => {
  const b = laad({}).uit.appDichtbijBlok(profiel(), ['TG']);
  assert.strictEqual(b.vraag, 'Vergelijk de huisartsenzorgkosten in Proefdorp met Proefland en Nederland sinds 2015');
});

test('kapotte of afgewezen antwoorden geven geen blok', () => {
  const c = laad({});
  assert.strictEqual(c.uit.appDichtbijBlok({ ok: false, fout: 'onbekende gemeente' }, ['TG']), null);
  assert.strictEqual(c.uit.appDichtbijBlok(null, ['TG']), null);
  assert.strictEqual(c.uit.appDichtbijBlok({ ok: true, gemeente: { naam: 'x' }, regio: { naam: 'y' }, reeksen: [] }, ['TG']), null);
  const p = profiel();
  p.reeksen.forEach((r) => { r.jaren = [{ jaar: 2026, gemeente: 'veel', regio: 1, nl: 1 }]; });
  assert.strictEqual(c.uit.appDichtbijBlok(p, ['TG']), null, 'geen getal = geen tegel');
});

test('appDichtbij: één vraag per gemeente (TG en GH delen Leusden), vaste parameters', async () => {
  const vragen = [];
  const c = laad({ appSbRpc: (fn, body) => { vragen.push([fn, body]); return Promise.resolve(profiel()); } });
  const d = await c.uit.appDichtbij();
  assert.strictEqual(d.fout, false);
  assert.strictEqual(vragen.length, 1);
  assert.deepStrictEqual(j(vragen[0]), ['zd_gemeente', { p_gemeente: 'GM0327', p_indeling: 'jeugdregio', p_van: 2015 }]);
  assert.deepStrictEqual(j(d.blokken[0].praktijken), ['TG', 'GH']);
});

test('zorgdata onbereikbaar: geen blok, één regel, de eigen cijfers blijven', async () => {
  const c = laad({
    appSbRpc: () => Promise.reject(new Error('rpc http 503')),
    appFinSql: (sql) => Promise.resolve(/FROM reeks/.test(sql) ? [{ entiteit: 'TG', rubriek: 'omzet_totaal', jaar: 2024, bedrag: 1000, bron_id: 1 }] : []),
  });
  const d = await c.uit.appPraktijkenVerzamel();
  assert.deepStrictEqual(j(d.dichtbij), []);
  assert.ok(d.fouten.includes('de vergelijking met gemeente, regio en Nederland is nu niet te lezen'));
  assert.strictEqual(d.fouten.filter((f) => /gemeente, regio en Nederland/.test(f)).length, 1, 'één regel');
  const tg = d.entiteiten.find((e) => e.code === 'TG');
  assert.ok(tg && tg.kern.some((k) => k.label === 'Omzet' && k.waarde === 1000), 'eigen cijfers blijven');
  assert.ok(c.logs.some((l) => /^app-praktijken: rpc http 503/.test(l)));
});

test('zorgdata antwoordt met ok:false: geen blok, één regel', async () => {
  const c = laad({
    appSbRpc: (fn) => Promise.resolve(fn === 'zd_gemeente' ? { ok: false, fout: 'onbekende gemeente' } : []),
    appFinSql: () => Promise.resolve([]),
  });
  const d = await c.uit.appPraktijkenVerzamel();
  assert.deepStrictEqual(j(d.dichtbij), []);
  assert.strictEqual(d.fouten.filter((f) => /gemeente, regio en Nederland/.test(f)).length, 1);
});

test('lukt het wel: blok in het antwoord en geen foutregel', async () => {
  const c = laad({
    appSbRpc: (fn) => Promise.resolve(fn === 'zd_gemeente' ? profiel() : []),
    appFinSql: () => Promise.resolve([]),
  });
  const d = await c.uit.appPraktijkenVerzamel();
  assert.strictEqual(d.dichtbij.length, 1);
  assert.ok(!d.fouten.some((f) => /gemeente, regio en Nederland/.test(f)));
});

test('route geeft dichtbij door (en [] als het ontbreekt)', () => {
  assert.ok(/appStuur\(res, 200, \{ ok: true, vaste_plek: false, entiteiten: d\.entiteiten, dichtbij: d\.dichtbij \|\| \[\], fouten: d\.fouten/.test(BLOK));
});
