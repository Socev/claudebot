'use strict';
// wv4232 (L48): de lijm in server.js (appVjSnel, appVjKnopJob, appVjAfloopAlle, appVjAfloopVorm) in een vm met verzonnen kaarten, rijen,
// vragen en app-log. Raakt niets echts. SRC=<pad> voor een kruisproef op een andere bron.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const src = fs.readFileSync(process.env.SRC || path.join(__dirname, '..', 'server.js'), 'utf8');
const fn = (n) => { const m = new RegExp('\\n(?:async )?function ' + n + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n').exec(src); assert.ok(m, 'gevonden: ' + n); return m[0]; };
const b1 = src.indexOf('// ── wv4232 (besluitenpagina nr 948'), b2 = src.indexOf('async function appVoorJouRoute(');
const J = (c) => c.repeat(16);

function ctx(o) {
  const fouten = [];
  const c = vm.createContext(Object.assign({ console, Date, JSON, crypto, Promise, Set, path, require, __dirname: path.join(__dirname, '..'), jobs: {}, APP_JOB_RE: /^[a-f0-9]{16}$/,
    logError: (k, e) => fouten.push(k + ': ' + (e && e.message)), appSleutelMasker: (t) => t, AGENTS_AF: require('../agents-af.js'),
    APP_VJ_JANEE_RE: vm.runInNewContext(/\nconst APP_VJ_JANEE_RE = (\/[^\n]*\/i);/.exec(src)[1]), appVjGekoppeld: () => null,
    appWerkvoorraad: async () => ({ items: o.rijen || [] }), appVragen: () => o.vragen || {}, appMoetLog: async () => [],
    appGeschiedenisRuw: async (k) => ({ items: (o.log && o.log[k]) || [] }),
    appVjVraagRegels: () => null, appSwSetVoor: async () => null, wachterKaarten: null, vjKnoplinkVoor: () => undefined,
    appVjRegisterVraag: async () => ({ vraag: null, herkomst: [], leesbaar: true }), appVjKnopStand: (p) => ({ p }),
    appVjKnopVormDb: async (p) => Object.assign({ vraag_id: 'v', tekst_id: 't' + p.id, kanaal: 'machinekamer', gevoelig: false, vraag: p.titel, voorstel: null, beantwoord: null, elders: null, kan: true, waarom_niet: null }, (o.knop || {})[p.id] || {}),
  }, o.extra || {}));
  const hulp = ['appKort', 'appVjGewoon', 'appVjKaartSleutel', 'appSha', 'appVjFnv', 'appVjStap', 'appVjJaNee'].map(fn).join('\n');
  vm.runInContext(hulp + '\n' + src.slice(b1, b2) + ';globalThis.__r = { appVjSnel, appVjKnopJob, appVjAfloopAlle, appVjAfloopVorm, VJA };', c);
  return { r: c.__r, fouten, c };
}
const kaart = (id, o) => Object.assign({ id, sleutel: 'wv' + (9000 + id), soort: 'besluit', status: 'open', titel: 'Proef ' + id + '?', stappen: [], herkomst: {} }, o || {});

test('blok gevonden en vj-afloop.js geladen', function () {
  assert.ok(b1 > 0 && b2 > b1);
  assert.ok(ctx({}).r.VJA);
});
test('snel: alleen open besluiten, gevoelig/stop/regels/steekwoorden/knopstap niet, hooguit 10', async function () {
  const lijst = [kaart(1), kaart(2, { soort: 'doen' }), kaart(3), kaart(4), kaart(5), kaart(6, { status: 'later' }), kaart(7, { stappen: ['Ja = de proefknop gaat aan.', 'Nee = alles blijft zoals het is.'] })];
  for (let i = 10; i < 25; i++) lijst.push(kaart(i));
  const { r, fouten } = ctx({ knop: { 3: { gevoelig: true }, 4: { stop: true }, 5: { kan: false } }, extra: { appVjVraagRegels: (p) => (p.id === 10 ? [{}] : null), appSwSetVoor: async (p) => (p.id === 11 ? {} : null), vjKnoplinkVoor: (p) => (p.id === 12 ? { tekst: 'x' } : undefined) } });
  const s = await r.appVjSnel(lijst, {});
  const ids = Object.keys(s).map(Number).sort((a, b) => a - b);
  assert.deepStrictEqual(ids, [1, 7, 13, 14]);   // de eerste 10 open besluiten (1,3,4,5,7,10,11,12,13,14) bekeken; 15 en verder niet meer
  assert.strictEqual(s[7].ja, 'de proefknop gaat aan.');
  assert.strictEqual(s[1].knop.tekst_id, 't1');
  assert.deepStrictEqual(fouten, []);
});
test('afloop: Ja met klus klaar = Gedaan + link naar het rapport; knopbeurt bezig; Niet meer nodig niet; Te lezen-jobs', async function () {
  const nu = Date.parse('2026-11-27T18:00:00Z');
  const k1 = kaart(1, { status: 'gedaan', gesloten_door: 'david', gesloten_op: '2026-11-27T12:00:00Z', herkomst: { wv: [901] } });
  const k2 = kaart(2, { status: 'gedaan', gesloten_door: 'david', gesloten_op: '2026-11-27T17:59:00Z', herkomst: {} });
  const k3 = kaart(3, { status: 'vervallen', gesloten_door: 'david', gesloten_op: '2026-11-27T12:00:00Z', herkomst: { wv: [903] } });
  const k4 = kaart(4, { status: 'gedaan', gesloten_door: 'beheer', gesloten_op: '2026-11-27T12:00:00Z', herkomst: { wv: [904] } });
  const k5 = kaart(5, { status: 'gedaan', gesloten_door: 'david', gesloten_op: '2026-11-10T12:00:00Z', herkomst: { wv: [905] } });   // > 7 dagen
  const { r: r0, c } = ctx({});
  const sl = (p) => { const ks = r0.appVjKnopJob ? c.appVjKaartSleutel(p) : null; return ks.job + ':' + ks.hash; };
  const vragen = { [sl(k1)]: { antwoord: { job: J('a'), keuze: 'ja' } }, [sl(k2)]: { antwoord: { job: J('b'), keuze: 'ja' } } };
  const rijen = [{ id: 901, status: 'klaar', job_id: J('c'), klaar_op: '2026-11-27T13:00:00Z' }, { id: 903, status: 'open' }, { id: 904, status: 'gestart' }, { id: 905, status: 'gestart' }];
  const log = { machinekamer: [{ t: '2026-11-27T13:00:00Z', job_id: J('d'), soort: 'socev', bron: 'agentrapport', agent_job: J('c'), ok: true, antwoord: '🤖 Agentrapport — wv901 proef\n\nUitkomst: de proefknop staat aan (wv901).\n' },
    { t: '2026-11-27T12:01:00Z', job_id: J('a'), soort: 'knop', ok: true, antwoord: 'Genoteerd, de klus staat op de werklijst.' }] };
  const { r, fouten } = ctx({ vragen, rijen, log, extra: { jobs: { [J('b')]: { status: 'running' } } } });
  const a = await r.appVjAfloopAlle([k1, k2, k3, k4, k5], nu, {});
  assert.deepStrictEqual(Object.keys(a.per).map(Number).sort(), [1, 2]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.appVjAfloopVorm(a.per[1]))), { stand: 'gedaan', tekst: 'Gedaan: de proefknop staat aan (een klus van Socev).', kanaal: 'machinekamer', job_id: J('d') });
  assert.strictEqual(a.per[2].stand, 'bezig');
  assert.strictEqual(r.appVjAfloopVorm(a.per[2]).job_id, null);
  assert.deepStrictEqual([...a.jobs].sort(), [J('a'), J('b'), J('c')].sort());
  assert.strictEqual(r.appVjAfloopVorm(undefined), undefined);
  assert.deepStrictEqual(fouten, []);
});
test('afloop: een fout in het lezen van rijen of log = geen regel, geen uitzondering', async function () {
  const k1 = kaart(1, { status: 'gedaan', gesloten_door: 'david', gesloten_op: new Date().toISOString(), herkomst: { wv: [901] } });
  const { r, fouten } = ctx({ extra: { appWerkvoorraad: async () => { throw new Error('rpc dicht'); }, appGeschiedenisRuw: async () => { throw new Error('log weg'); } } });
  const a = await r.appVjAfloopAlle([k1], Date.now(), {});
  assert.strictEqual(JSON.stringify(a.per), '{}');
  assert.ok(fouten.length >= 2);
});
