'use strict';
// wv4376: het Rechter-blok van server.js in een vm met de echte nza-rechter.js en een nep-ronde (processJob geeft verzonnen uitvoer).
// Meet: start → drie rollen na elkaar in hun eigen sessie (gewist), model en bovengrens per rol → bewaarde run met markdown; tweede druk = al bezig;
// weigeringen (geen loper, noodstop, dagteller, leeg register, onbekende run); "bezig" na een herstart → fout in het antwoord; mislukte advocaat → fout.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm'), crypto = require('crypto');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const a = SRC.indexOf('// ── OVIS NZa Rechter (wv4376');
const b = SRC.indexOf('// ── einde OVIS NZa Rechter ──');
const BLOK = SRC.slice(a, b);

const PLEIT = '## 1. Huisvesting\n- argument [CBb](/nza#stuk=cbb-2025-1&plek=5.1) ' + 'x '.repeat(150);
const OORDEEL = '```json\n' + JSON.stringify({ dictum: 'Proefdictum.', geschilpunten: [{ thema: 'huisvesting', naam: 'Huisvesting', oordeel: 'onzeker', motivering: 'm', bronnen: [{ stuk: 'cbb-2025-1', plek: '5.1' }] }], richtingen: [], sterk: [], zwak: [] }) + '\n```';

function omgeving(opts) {
  opts = opts || {};
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'nza-rechter-pod-'));
  const uit = { geweigerd: [], gestuurd: [], jobs: {}, prompts: [], log: [], rij: [] };
  const NZA_SCHERM = { app: async (v) => v.pad === '/app/nza' ? { status: 200, body: { telling: { stukken: 4 }, gebouwd: '2026-11-27T10:00:00+0100', stukken: [{ id: 's1', titel: 'S1', datum: '2026-11-01' }] } }
    : { status: 200, body: { zitting: '2027-01-19', themas: opts.leeg ? [] : [{ thema: 'huisvesting', naam: 'Huisvesting' }], punten: opts.leeg ? [] : [{ id: 'VP-01', titel: 't', thema: 'huisvesting', bijgewerkt: '2026-11-27' }] } } };
  const ctx = {
    require, path, fs, crypto, console, setTimeout, process: { env: { NZA_RECHTER: path.join(T, 'rechter'), PATH: process.env.PATH } },
    __dirname: path.join(__dirname, '..'), SERVER_ECHT: false, DEFAULT_WS: 'vault', APP_UIT: path.join(T, 'app-uit'), NZA_SCHERM,
    jobs: uit.jobs, chatSessions: { 'vault|ovis-nza-rechter': 'oud', 'vault|ovis-nza-rechter-nza': 'oud' }, sessieResetOp: {}, RUNTIMES_LIJST: ['claude', 'codex'],
    sessionKey: (ws, c) => ws + '|' + c, sessieSleutel: (k, rt) => rt === 'claude' ? k : rt + ':' + k, saveSessions: () => {},
    loperVoorRun: (c) => opts.loper !== false && /^ovis-nza-rechter/.test(c), appTeller: (n) => !(opts.teller === false && n === 'nza-rechter'),
    resolveKeuze: (d) => ({ runtime: 'claude', model: d.model, fallback: '' }),
    serverPad: (n, env, echt) => env || echt, serverProefDeel: (x) => x,
    schrijfLog: (r) => uit.log.push(r), nu: () => 'NU', velden: (o) => JSON.stringify(o), logError: (n) => uit.log.push('fout ' + n),
    nzaCitaatToets: async () => ({ ok: false }),
    appWeiger: (res, status, melding, reden) => { uit.geweigerd.push({ status, reden }); return { status, reden }; },
    appStuur: (res, status, body) => { uit.gestuurd.push({ status, body }); return { status, body }; },
    enqueue: (key, f) => { uit.rij.push({ key, f }); },
    processJob: async (jobId, prompt, s, f, chatId, ws, keuze) => {
      uit.prompts.push({ chatId, model: keuze.model, max: uit.jobs[jobId].max_ms, prompt });
      uit.jobs[jobId].status = 'done';
      const rol = chatId === 'ovis-nza-rechter' ? 'rechter' : 'adv';
      uit.jobs[jobId].result = opts.faal === rol ? { ok: false, error: 'bovengrens' } : { ok: true, output: rol === 'rechter' ? OORDEEL : PLEIT, model: keuze.model };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(BLOK + '\nthis.appNzaRechter = appNzaRechter; this.info = nzaRechterInfo; this.opslag = NZA_RECHTER_OPSLAG; this.lopend = function () { return nzaRechterLopend; };', ctx);
  return { ctx, uit, T };
}
const RES = () => ({ _app: {} });
async function draaiRij(o) {   // de drie rollen komen na elkaar in de rij (elke volgende pas na de vorige)
  for (let i = 0; i < 3; i++) {
    for (let k = 0; k < 50 && o.uit.rij.length <= i; k++) await new Promise((r) => setTimeout(r, 10));
    if (o.uit.rij.length <= i) break;
    await o.uit.rij[i].f();
  }
  for (let k = 0; k < 50 && o.ctx.lopend(); k++) await new Promise((r) => setTimeout(r, 10));
}

test('blok gevonden', () => { assert.ok(a > 0 && b > a); });

test('start → advocaat NZa, advocaat eiser, rechter (eigen sessies, vers, modellen, bovengrens) → run klaar met markdown', async () => {
  const o = omgeving();
  const r = await o.ctx.appNzaRechter({}, RES(), {}, 'POST /app/nza/rechter', {});
  assert.strictEqual(r.status, 200);
  const id = r.body.run.id;
  assert.match(id, /^r-\d{8}-\d{4}-[a-f0-9]{8}$/);
  assert.strictEqual(r.body.run.stand.stukken, 4);
  assert.strictEqual((await o.ctx.appNzaRechter({}, RES(), {}, 'POST /app/nza/rechter', {})).body.al, true, 'tweede druk = al bezig');
  const l1 = await o.ctx.appNzaRechter({}, RES(), {}, 'GET /app/nza/rechter', {});
  assert.strictEqual(l1.body.runs[0].status, 'bezig');
  assert.strictEqual(l1.body.lopend.id, id);
  await draaiRij(o);
  assert.deepStrictEqual(o.uit.prompts.map((p) => p.chatId), ['ovis-nza-rechter-nza', 'ovis-nza-rechter-eiser', 'ovis-nza-rechter']);
  assert.deepStrictEqual(o.uit.prompts.map((p) => p.model), ['claude-opus-5-5', 'claude-opus-5-5', 'claude-fable-5-2']);
  assert.deepStrictEqual(o.uit.prompts.map((p) => p.max), [25 * 60000, 25 * 60000, 30 * 60000]);
  assert.strictEqual(o.ctx.chatSessions['vault|ovis-nza-rechter'], undefined);
  assert.strictEqual(o.ctx.chatSessions['vault|ovis-nza-rechter-nza'], undefined);
  assert.match(o.uit.prompts[2].prompt, /PLEITNOTA ADVOCAAT VAN DE NZa \(DATA\)/);
  const run = await o.ctx.appNzaRechter({}, RES(), {}, 'POST /app/nza/rechter/run', { id });
  assert.strictEqual(run.body.run.status, 'klaar');
  assert.deepStrictEqual(run.body.run.telling, { gegrond: 0, ongegrond: 0, onzeker: 1 });
  assert.match(run.body.run.md, /Oefening, geen voorspelling en geen juridisch advies/);
  assert.strictEqual(run.body.run.modellen.rechter, 'Fable 5.2');
  assert.strictEqual(o.ctx.lopend(), null);
  assert.ok(o.uit.log.every((x) => !/argument|Proefdictum/.test(x)), 'geen inhoud in de log');
  assert.strictEqual((fs.statSync(path.join(o.T, 'rechter', id + '.json')).mode & 0o777), 0o600);
  assert.strictEqual(o.ctx.info().klaar, 1);
});

test('weigeringen: geen loper, noodstop, dagteller, leeg register, onbekende run', async () => {
  let o = omgeving({ loper: false });
  assert.strictEqual((await o.ctx.appNzaRechter({}, RES(), {}, 'POST /app/nza/rechter', {})).reden, 'nza-rechter geen loper');
  o = omgeving();
  fs.writeFileSync(path.join(o.T, 'app-uit'), '');
  assert.strictEqual((await o.ctx.appNzaRechter({}, RES(), {}, 'POST /app/nza/rechter', {})).reden, 'nza-rechter noodstop');
  o = omgeving({ teller: false });
  assert.strictEqual((await o.ctx.appNzaRechter({}, RES(), {}, 'POST /app/nza/rechter', {})).reden, 'grens nza-rechter');
  o = omgeving({ leeg: true });
  assert.strictEqual((await o.ctx.appNzaRechter({}, RES(), {}, 'POST /app/nza/rechter', {})).reden, 'nza-rechter leeg');
  assert.strictEqual((await o.ctx.appNzaRechter({}, RES(), {}, 'POST /app/nza/rechter/run', { id: '../x' })).reden, 'nza-rechter id');
  assert.strictEqual((await o.ctx.appNzaRechter({}, RES(), {}, 'POST /app/nza/rechter/run', { id: 'r-20261127-2330-abcdef12' })).reden, 'nza-rechter weg');
});

test('mislukte advocaat → run fout; "bezig" zonder lopende run (herstart) → fout in het antwoord', async () => {
  const o = omgeving({ faal: 'adv' });
  const r = await o.ctx.appNzaRechter({}, RES(), {}, 'POST /app/nza/rechter', {});
  await draaiRij(o);
  const run = await o.ctx.appNzaRechter({}, RES(), {}, 'POST /app/nza/rechter/run', { id: r.body.run.id });
  assert.strictEqual(run.body.run.status, 'fout');
  assert.match(run.body.run.fout, /advocaat van de NZa liep niet af/);
  assert.strictEqual(o.uit.prompts.length, 1, 'na een mislukte advocaat geen volgende rol');
  o.ctx.opslag.schrijf({ id: 'r-20261127-0100-aaaaaaaa', start: 'x', status: 'bezig', stap: 'rechter' });
  const l = await o.ctx.appNzaRechter({}, RES(), {}, 'GET /app/nza/rechter', {});
  const oud = l.body.runs.find((x) => x.id === 'r-20261127-0100-aaaaaaaa');
  assert.strictEqual(oud.status, 'fout');
  assert.match(oud.fout, /afgebroken/);
});
