'use strict';
// wv3157: het Dubbelcheck-blok van server.js (route → ronde → aanhangsel) in een vm, met de echte nza-vragen.js en nza-dubbelcheck.js en een
// nep-ronde (processJob geeft verzonnen uitvoer). Meet: weigeringen (geen loper, bezet, leeg, onbekend), stand bezig → aanhangsel + stand weg,
// mislukte ronde → stand fout, "bezig" na een herstart → fout (alleen in het antwoord), sessie gewist en job met eigen bovengrens en model.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const a = SRC.indexOf('// ── OVIS NZa Dubbelcheck (wv3157');
const b = SRC.indexOf('// ── einde OVIS NZa Dubbelcheck ──');
const BLOK = SRC.slice(a, b);
const J = (i) => i.toString(16).padStart(16, 'b');

function omgeving(opts) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'nza-check-pod-'));
  const NZA_VRAGEN = require('../nza-vragen.js').maak({ map: path.join(T, 'vragen'), leesAppLog: async () => [] });
  const uit = { geweigerd: [], gestuurd: [], jobs: {}, gewist: 0, prompts: [], log: [] };
  const ctx = {
    require, path, fs, crypto, console, process: { env: { NZA_SCRIPT: '/bestaat/niet.py', NZA_DB: path.join(T, 'nza.db'), PATH: process.env.PATH } },
    __dirname: path.join(__dirname, '..'), SERVER_ECHT: false, VAULT: T, DEFAULT_WS: 'vault', APP_UIT: path.join(T, 'app-uit'),
    NZA_VRAGEN, jobs: uit.jobs, chatSessions: { 'vault|ovis-nza-check': 'oude-sessie' }, sessieResetOp: {}, RUNTIMES_LIJST: ['claude', 'codex'],
    sessionKey: (ws, c) => ws + '|' + c, sessieSleutel: (k, rt) => rt === 'claude' ? k : rt + ':' + k, saveSessions: () => { uit.gewist++; },
    loperVoorRun: (c) => opts.loper !== false && c === 'ovis-nza-check', appTeller: () => opts.teller !== false,
    resolveKeuze: (d) => ({ runtime: 'claude', model: d.model, fallback: '' }),
    serverPad: (n, env, echt) => env || echt, serverProefDeel: (x) => x,
    schrijfLog: (r) => uit.log.push(r), nu: () => 'NU', velden: (o) => JSON.stringify(o), logError: (n) => uit.log.push('fout ' + n),
    appWeiger: (res, status, melding, reden) => { uit.geweigerd.push({ status, reden }); return { status }; },
    appStuur: (res, status, body) => { uit.gestuurd.push({ status, body }); return { status, body }; },
    enqueue: (key, f) => { uit.rij = f; },
    processJob: async (jobId, prompt, s, f, chatId, ws, keuze) => {
      uit.prompts.push({ jobId, chatId, model: keuze.model, max: uit.jobs[jobId].max_ms, prompt });
      uit.jobs[jobId].status = 'done';
      uit.jobs[jobId].result = opts.result ? opts.result() : { ok: true, output: opts.uitvoer };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(BLOK + '\nthis.nzaCheckRoute = nzaCheckRoute; this.nzaCheckStand = nzaCheckStand; this.nzaCheckInfo = nzaCheckInfo; this.nzaCheckLopend = nzaCheckLopend;', ctx);
  return { ctx, uit, NZA_VRAGEN, T };
}
const RES = () => ({ _app: {} });
const UITVOER = '```json\n' + JSON.stringify({ beweringen: [
  { bewering: 'Proefbewering zonder bron', oordeel: 'niet te vinden', toelichting: 'nergens' },
  { bewering: 'Proefcitaat', citaat: 'een verzonnen citaat van genoeg tekens', stuk: 'proef-1', plek: '2', oordeel: 'klopt' },
], kern: 'Proefkern.' }) + '\n```';

async function draadMet(o) {
  return o.NZA_VRAGEN.naAntwoord({ job_id: J(1), soort: 'bericht', tekst: 'Proefvraag', t: '2026-11-15T12:00:00Z', antwoord: 'Proefantwoord', ok: true });
}

test('blok gevonden', () => { assert.ok(a > 0 && b > a, 'markeringen in server.js'); });

test('Dubbelcheck: bezig → ronde (sessie gewist, Fable, 20 min) → aanhangsel met citaatpoort, stand weg', async () => {
  const o = omgeving({ uitvoer: UITVOER });
  const id = await draadMet(o);
  const r = await o.ctx.nzaCheckRoute(RES(), id, { job_id: J(1) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.dubbelcheck.status, 'bezig');
  assert.strictEqual(o.NZA_VRAGEN.wisseling(id, J(1)).dubbelcheck.status, 'bezig');
  // tweede druk op dezelfde: al bezig; op een ander antwoord: bezet
  assert.strictEqual((await o.ctx.nzaCheckRoute(RES(), id, { job_id: J(1) })).body.al, true);
  const id2 = await o.NZA_VRAGEN.naAntwoord({ job_id: J(2), tekst: 'Andere', t: '2026-11-15T13:00:00Z', antwoord: 'Ander antwoord', ok: true });
  assert.strictEqual((await o.ctx.nzaCheckRoute(RES(), id2, { job_id: J(2) })).status, 409);
  await o.uit.rij();
  await new Promise((r2) => setTimeout(r2, 50));
  const p = o.uit.prompts[0];
  assert.strictEqual(p.chatId, 'ovis-nza-check');
  assert.strictEqual(p.model, 'claude-fable-5-2');
  assert.strictEqual(p.max, 20 * 60 * 1000);
  assert.match(p.prompt, /DUBBELCHECK van OVIS NZa[\s\S]*Proefantwoord/);
  assert.strictEqual(o.ctx.chatSessions['vault|ovis-nza-check'], undefined, 'sessie vers');
  const w = o.NZA_VRAGEN.wisseling(id, J(1));
  assert.strictEqual(w.dubbelcheck, undefined);
  assert.strictEqual(w.aanhangsels.length, 1);
  assert.strictEqual(w.aanhangsels[0].soort, 'dubbelcheck');
  assert.strictEqual(w.aanhangsels[0].model, 'Fable 5.2 (claude-fable-5-2)');
  assert.match(w.aanhangsels[0].md, /2 beweringen nagelopen:\*\* 0 klopt · 0 klopt deels · 2 niet te vinden · 0 onjuist/);
  assert.match(w.aanhangsels[0].md, /Pod-controle: dit citaat staat niet woordelijk/);
  assert.strictEqual(Object.keys(o.ctx.nzaCheckLopend).length, 0);
  assert.strictEqual(o.uit.jobs[p.jobId].opgehaald > 0, true);
  const info = o.ctx.nzaCheckInfo();
  assert.deepStrictEqual([info.gestart, info.klaar, info.mislukt, info.lopend, info.loper], [1, 1, 0, 0, true]);
  assert.ok(!o.uit.log.join('\n').includes('Proefantwoord') && !o.uit.log.join('\n').includes('Proefbewering'), 'geen inhoud in de log');
  // nu mag een ander antwoord weer
  assert.strictEqual((await o.ctx.nzaCheckRoute(RES(), id2, { job_id: J(2) })).status, 200);
});

test('weigeringen: geen loper (nooit als claude), daggrens, leeg antwoord, onbekend antwoord, kapotte id', async () => {
  let o = omgeving({ loper: false, uitvoer: UITVOER });
  let id = await draadMet(o);
  assert.strictEqual((await o.ctx.nzaCheckRoute(RES(), id, { job_id: J(1) })).status, 503);
  assert.strictEqual(o.uit.rij, undefined, 'niets gestart');
  assert.strictEqual(o.NZA_VRAGEN.wisseling(id, J(1)).dubbelcheck, undefined);
  o = omgeving({ teller: false, uitvoer: UITVOER });
  id = await draadMet(o);
  assert.strictEqual((await o.ctx.nzaCheckRoute(RES(), id, { job_id: J(1) })).status, 429);
  assert.strictEqual(Object.keys(o.ctx.nzaCheckLopend).length, 0);
  o = omgeving({ uitvoer: UITVOER });
  id = await draadMet(o);
  assert.strictEqual((await o.ctx.nzaCheckRoute(RES(), id, { job_id: J(9) })).status, 404);
  assert.strictEqual((await o.ctx.nzaCheckRoute(RES(), id, { job_id: 'xx' })).status, 400);
  const leeg = await o.NZA_VRAGEN.naAntwoord({ job_id: J(3), tekst: 'v', antwoord: '', ok: false, fout: 'kapot', draad: id });
  assert.strictEqual((await o.ctx.nzaCheckRoute(RES(), leeg, { job_id: J(3) })).status, 409);
});

test('mislukte ronde → stand fout (met reden), geen aanhangsel; bovengrens → "gestopt na 20 minuten"', async () => {
  for (const [result, verwacht] of [[() => ({ ok: true, output: 'geen json hier' }), /geen bruikbare uitkomst/], [() => ({ ok: false, error: 'bovengrens' }), /gestopt na 20 minuten/]]) {
    const o = omgeving({ result });
    const id = await draadMet(o);
    await o.ctx.nzaCheckRoute(RES(), id, { job_id: J(1) });
    await o.uit.rij();
    await new Promise((r2) => setTimeout(r2, 50));
    const w = o.NZA_VRAGEN.wisseling(id, J(1));
    assert.strictEqual(w.dubbelcheck.status, 'fout');
    assert.match(w.dubbelcheck.fout, verwacht);
    assert.strictEqual(w.aanhangsels.length, 0);
    assert.strictEqual(o.ctx.nzaCheckInfo().mislukt, 1);
    // opnieuw kan
    assert.strictEqual((await o.ctx.nzaCheckRoute(RES(), id, { job_id: J(1) })).status, 200);
  }
});

test('na een herstart: "bezig" zonder lopende ronde wordt in het antwoord "fout"', async () => {
  const o = omgeving({ uitvoer: UITVOER });
  const id = await draadMet(o);
  await o.NZA_VRAGEN.zetCheck(id, J(1), { status: 'bezig', start: '2026-11-15T12:00:00Z', model: 'Fable 5.2' });
  const d = (await o.NZA_VRAGEN.draad(id)).draad;
  o.ctx.nzaCheckStand(d);
  assert.strictEqual(d.wisselingen[0].dubbelcheck.status, 'fout');
  assert.match(d.wisselingen[0].dubbelcheck.fout, /afgebroken/);
  assert.strictEqual(o.NZA_VRAGEN.wisseling(id, J(1)).dubbelcheck.status, 'bezig', 'op schijf ongewijzigd');
});
