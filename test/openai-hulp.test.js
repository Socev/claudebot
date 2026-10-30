'use strict';
// Toetst openai-hulp.js (wv2055) tegen een nep-API op 127.0.0.1: poort (patiëntpoort + geheimen) vóór elke aanroep, zachte grens met
// reservering, kostenteller per aanroep (model uit het antwoord, cache, batchprijs), batch indienen/ophalen/opruimen, stand zonder tekst.
// Alles verzonnen; raakt geen pod, kluis of het echte tegoed. Gebruik: bash test/openai-hulp.sh
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../openai-hulp.js');
const PP = require('../intake/patientpoort.js');
const poort = function (t) { return PP.beoordeel({ teksten: t }, { eigen: PP.maakEigen(null, {}) }); };

function nepApi() {
  const s = { verzoeken: [], antwoord: null, status: 200, bestanden: {}, batches: {}, gewist: [] };
  const srv = http.createServer(function (req, res) {
    const delen = [];
    req.on('data', function (c) { delen.push(c); });
    req.on('end', function () {
      const body = Buffer.concat(delen);
      s.verzoeken.push({ methode: req.method, pad: req.url, auth: req.headers.authorization, body: body.toString('utf8') });
      const stuur = function (st, j) { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(typeof j === 'string' ? j : JSON.stringify(j)); };
      if (req.method === 'POST' && req.url === '/v1/responses') {
        if (s.status !== 200) return stuur(s.status, { error: { code: 'rate_limit_exceeded', message: 'verzonnen' } });
        const b = JSON.parse(body);
        return stuur(200, s.antwoord || { id: 'resp_1', status: 'completed', model: b.model + '-2026-03-17',
          output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'pong' }] }],
          usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 400, cache_write_tokens: 0 }, output_tokens: 200, output_tokens_details: { reasoning_tokens: 50 } } });
      }
      if (req.method === 'POST' && req.url === '/v1/files') {
        const id = 'file-in' + Object.keys(s.bestanden).length;
        s.bestanden[id] = body.toString('utf8');
        return stuur(200, { id: id, purpose: 'batch' });
      }
      if (req.method === 'POST' && req.url === '/v1/batches') {
        const b = JSON.parse(body);
        s.batches.batch_1 = { id: 'batch_1', status: 'in_progress', input_file_id: b.input_file_id, endpoint: b.endpoint };
        return stuur(200, s.batches.batch_1);
      }
      if (req.method === 'GET' && req.url === '/v1/batches/batch_1') return stuur(200, s.batches.batch_1);
      if (req.method === 'GET' && req.url === '/v1/files/file-out/content') {
        const regel = function (id, tekst) { return JSON.stringify({ custom_id: id, response: { status_code: 200, body: { status: 'completed', model: 'gpt-5-nano-2025-08-07',
          output: [{ type: 'message', content: [{ type: 'output_text', text: tekst }] }], usage: { input_tokens: 1000000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1000000 } } } }); };
        res.writeHead(200, { 'Content-Type': 'application/jsonl' });
        return res.end(regel('a', 'eerste') + '\n' + regel('b', 'tweede') + '\n');
      }
      if (req.method === 'DELETE') { s.gewist.push(req.url); return stuur(200, { deleted: true }); }
      stuur(404, { error: { code: 'not_found' } });
    });
  });
  return new Promise(function (ok) { srv.listen(0, '127.0.0.1', function () { s.url = 'http://127.0.0.1:' + srv.address().port; s.srv = srv; ok(s); }); });
}
function nieuw(api, inst, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oai-'));
  if (inst) fs.writeFileSync(path.join(dir, 'openai.json'), JSON.stringify(inst));
  const logs = [];
  const h = H.maak(Object.assign({ dir: dir, api: api, sleutel: async function () { return 'nep-sleutel-123'; }, poort: poort,
    log: function (r) { logs.push(r); }, fout: function () {} }, extra || {}));
  return { h: h, dir: dir, logs: logs };
}
const PATIENT = 'Betreft: mw. J. Jansen, geboortedatum 12-03-1958. Bovengenoemde patiënt is bekend met diabetes mellitus; wij zagen haar op de polikliniek.';

test('kosten: cache tegen cachetarief, schrijftokens extra, batch halve prijs, model met datumstaart', function () {
  const k = H._intern.kosten('gpt-5.4-mini-2026-03-17', { input_tokens: 1e6, input_tokens_details: { cached_tokens: 4e5 }, output_tokens: 1e6 }, false);
  assert.strictEqual(k.usd, 0.6 * 0.75 + 0.4 * 0.075 + 4.5);
  assert.strictEqual(k.prijs_onbekend, false);
  const b = H._intern.kosten('gpt-5-nano', { input_tokens: 1e6, output_tokens: 1e6 }, true);
  assert.strictEqual(b.usd, 0.025 + 0.2);
  const s = H._intern.kosten('gpt-6-luna', { input_tokens: 1e6, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1e6 }, output_tokens: 0 }, false);
  assert.strictEqual(s.usd, 0.10 + 0.25);   // voorzichtig: invoer én schrijven
  const o = H._intern.kosten('iets-nieuws', { input_tokens: 1e6, output_tokens: 0 }, false);
  assert.strictEqual(o.prijs_onbekend, true); assert.strictEqual(o.usd, 10);
});
test('periode: reset_dag in Nederlandse tijd', function () {
  assert.strictEqual(H._intern.periodeVan(Date.parse('2026-10-30T22:00:00Z'), 1), '2026-10-01');
  assert.strictEqual(H._intern.periodeVan(Date.parse('2026-10-31T23:30:00Z'), 1), '2026-11-01');   // 00:30 NL op 1 nov
  assert.strictEqual(H._intern.periodeVan(Date.parse('2026-01-10T12:00:00Z'), 15), '2025-12-15');
});
test('geheimenfilter', function () {
  assert.ok(H._intern.geheimIn('sleutel sk-proj-' + 'a'.repeat(40)));
  assert.ok(H._intern.geheimIn('wachtwoord: Geheim123!'));
  assert.ok(!H._intern.geheimIn('Een gewone zin over facturen van oktober.'));
});

test('maskeer: geheim-vormige stukken vervangen, gewone tekst blijft', async function () {
  const m = H._intern.maskeer('a sk-proj-' + 'c'.repeat(40) + ' b\nwachtwoord: Geheim123!\nc');
  assert.strictEqual(m.n, 2); assert.ok(!H._intern.geheimIn(m.tekst)); assert.ok(m.tekst.indexOf('a [geheim-gemaskeerd] b') === 0);
  const n = await nepApi(); const t = nieuw(n.url, { aan: true });
  assert.strictEqual((await t.h.vraag({ afnemer: 'review', invoer: 'diff met wachtwoord: Geheim123!' })).status, 'geheim');
  const r = await t.h.vraag({ afnemer: 'review', invoer: 'diff met wachtwoord: Geheim123!', maskeer: true });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.gemaskeerd, 1);
  assert.ok(n.verzoeken[0].body.indexOf('Geheim123') < 0);
  assert.strictEqual((await t.h.vraag({ afnemer: 'review', invoer: PATIENT, maskeer: true })).status, 'poort');
  n.srv.close(); t.h.sluit();
});
test('uit (geen openai.json): geweigerd, geen aanroep, wel een rij', async function () {
  const n = await nepApi(); const t = nieuw(n.url, null);
  const r = await t.h.vraag({ afnemer: 'proef', invoer: 'Zeg pong.' });
  assert.deepStrictEqual(r, { ok: false, status: 'uit' });
  assert.strictEqual(n.verzoeken.length, 0);
  assert.strictEqual(t.h.health().per_status.uit, 1);
  n.srv.close(); t.h.sluit();
});

test('vraag: poort en geheim houden tegen vóór het netwerk; gewone vraag telt kosten met het model uit het antwoord', async function () {
  const n = await nepApi(); const t = nieuw(n.url, { aan: true });
  assert.strictEqual((await t.h.vraag({ afnemer: 'proef', invoer: PATIENT })).status, 'poort');
  assert.strictEqual((await t.h.vraag({ afnemer: 'proef', instructies: PATIENT, invoer: 'x' })).status, 'poort');
  assert.strictEqual((await t.h.vraag({ afnemer: 'proef', invoer: 'Mijn sleutel is sk-proj-' + 'b'.repeat(40) })).status, 'geheim');
  assert.strictEqual((await t.h.vraag({ afnemer: 'proef', model: 'gpt-onbekend', invoer: 'Zeg pong.' })).status, 'model');
  assert.strictEqual((await t.h.vraag({ afnemer: 'Fout Naam', invoer: 'x' })).status, 'afnemer');
  assert.strictEqual(n.verzoeken.length, 0);
  const r = await t.h.vraag({ afnemer: 'proef', instructies: 'Antwoord kort.', invoer: 'Zeg pong.', max_uit: 100, effort: 'low' });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.tekst, 'pong'); assert.strictEqual(r.model, 'gpt-5.4-mini-2026-03-17');
  assert.strictEqual(r.usd, H._intern.kosten('gpt-5.4-mini', { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 200 }).usd);
  const v = n.verzoeken[0];
  assert.strictEqual(v.auth, 'Bearer nep-sleutel-123');
  const b = JSON.parse(v.body);
  assert.strictEqual(b.store, false); assert.strictEqual(b.instructions, 'Antwoord kort.'); assert.deepStrictEqual(b.reasoning, { effort: 'low' });
  const h = t.h.health();
  assert.strictEqual(h.per_status.ok, 1); assert.strictEqual(h.per_status.poort, 2); assert.strictEqual(h.per_status.geheim, 1);
  assert.strictEqual(h.maand_usd, r.usd); assert.strictEqual(h.sleutel, 'aanwezig');
  const tekst = JSON.stringify(h) + JSON.stringify(t.h.stand());
  assert.ok(tekst.indexOf('pong') < 0 && tekst.indexOf('nep-sleutel') < 0 && tekst.indexOf('Jansen') < 0);
  // de databank bevat geen tekst
  const db = fs.readFileSync(path.join(t.dir, 'openai.sqlite'));
  assert.ok(db.indexOf('Jansen') < 0 && db.indexOf('nep-sleutel') < 0);
  n.srv.close(); t.h.sluit();
});

test('gestructureerde uitvoer: schema mee, json terug', async function () {
  const n = await nepApi(); const t = nieuw(n.url, { aan: true });
  n.antwoord = { id: 'r', status: 'completed', model: 'gpt-5-nano', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"a":1}' }] }], usage: { input_tokens: 10, output_tokens: 5 } };
  const r = await t.h.vraag({ afnemer: 'proef', model: 'gpt-5-nano', invoer: 'x', schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false } });
  assert.deepStrictEqual(r.json, { a: 1 });
  assert.strictEqual(JSON.parse(n.verzoeken[0].body).text.format.type, 'json_schema');
  n.srv.close(); t.h.sluit();
});

test('zachte grens: 80 % van het tegoed, met de schatting van deze aanroep', async function () {
  const n = await nepApi(); const t = nieuw(n.url, { aan: true, tegoed_usd: 10 });
  assert.strictEqual(t.h.stand().grens_usd, 8);
  n.antwoord = { id: 'r', status: 'completed', model: 'gpt-5.5', output: [], usage: { input_tokens: 1e6, output_tokens: 1e5 } };   // $5 + $3
  assert.strictEqual((await t.h.vraag({ afnemer: 'proef', model: 'gpt-5.5', invoer: 'x' })).ok, true);
  assert.strictEqual(t.h.stand().maand_usd, 8);
  assert.strictEqual((await t.h.vraag({ afnemer: 'proef', model: 'gpt-5-nano', invoer: 'x' })).status, 'grens');
  assert.strictEqual(n.verzoeken.length, 1);
  n.srv.close(); t.h.sluit();
  // grens_usd gaat voor het percentage; een grote max_uit telt mee in de schatting
  const n2 = await nepApi(); const t2 = nieuw(n2.url, { aan: true, grens_usd: 0.01 });
  assert.strictEqual((await t2.h.vraag({ afnemer: 'proef', model: 'gpt-5.5', invoer: 'x', max_uit: 32000 })).status, 'grens');
  assert.strictEqual((await t2.h.vraag({ afnemer: 'proef', model: 'gpt-5-nano', invoer: 'x', max_uit: 100 })).ok, true);
  n2.srv.close(); t2.h.sluit();
});

test('API-fout en ontbrekende sleutel: rij met status, geen tekst', async function () {
  const n = await nepApi(); const t = nieuw(n.url, { aan: true });
  n.status = 429;
  const r = await t.h.vraag({ afnemer: 'proef', invoer: 'x' });
  assert.strictEqual(r.status, 'api_429'); assert.strictEqual(r.soort, 'rate_limit_exceeded');
  n.srv.close(); t.h.sluit();
  const t2 = nieuw('http://127.0.0.1:9', { aan: true }, { sleutel: async function () { return null; } });
  assert.strictEqual((await t2.h.vraag({ afnemer: 'proef', invoer: 'x' })).status, 'geen_sleutel');
  assert.strictEqual(t2.h.health().sleutel, 'ontbreekt');
  t2.h.sluit();
});

test('batch: poort per verzoek, indienen, reservering telt mee, ophalen tegen batchprijs, bestanden gewist', async function () {
  const n = await nepApi(); const t = nieuw(n.url, { aan: true, tegoed_usd: 100 });
  const r = await t.h.batchIndienen({ afnemer: 'proef', model: 'gpt-5-nano', instructies: 'Deel in.', verzoeken: [
    { id: 'a', invoer: 'Factuur oktober van een leverancier.' }, { id: 'b', invoer: 'Nieuwsbrief.' }, { id: 'c', invoer: PATIENT }] });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.aantal, 2); assert.deepStrictEqual(r.geweigerd, ['c']);
  const upload = n.bestanden['file-in0'];
  assert.ok(upload.indexOf('name="purpose"') > 0 && upload.indexOf('Jansen') < 0);
  const regels = upload.split('\n').filter(function (x) { return x.indexOf('custom_id') >= 0; }).map(function (x) { return JSON.parse(x); });
  assert.strictEqual(regels.length, 2); assert.strictEqual(regels[0].url, '/v1/responses'); assert.strictEqual(regels[0].body.store, false);
  assert.strictEqual(JSON.parse(n.verzoeken.find(function (v) { return v.pad === '/v1/batches'; }).body).endpoint, '/v1/responses');
  assert.ok(t.h.stand().open_batch_usd > 0);
  // nog bezig: niets geteld
  assert.deepStrictEqual(await t.h.batchTik(), { open: 1, klaar: 0, fout: 0 });
  assert.strictEqual(t.h.batchStand('batch_1').klaar, false);
  n.batches.batch_1.status = 'completed'; n.batches.batch_1.output_file_id = 'file-out';
  const u = await t.h.batchTik();
  assert.strictEqual(u.klaar, 1);
  const s = t.h.batchStand('batch_1');
  assert.strictEqual(s.klaar, true); assert.strictEqual(s.usd, 2 * (0.025 + 0.2));
  assert.deepStrictEqual(s.antwoorden.map(function (a) { return a.id + ':' + a.tekst; }), ['a:eerste', 'b:tweede']);
  assert.strictEqual(t.h.stand().maand_usd, 0.45); assert.strictEqual(t.h.stand().open_batch_usd, 0);
  const pad = path.join(t.dir, 'batch', 'batch_1.jsonl');
  assert.strictEqual(fs.statSync(pad).mode & 0o777, 0o600);
  await new Promise(function (ok) { setTimeout(ok, 100); });
  assert.ok(n.gewist.indexOf('/v1/files/file-out') >= 0 && n.gewist.indexOf('/v1/files/file-in0') >= 0);
  n.srv.close(); t.h.sluit();
});

test('api-basis alleen OpenAI of 127.0.0.1', function () {
  assert.throws(function () { H.maak({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'oai-')), api: 'https://elders.example', sleutel: async function () {}, poort: poort }); });
});

// ── server.js-koppeling: het blok OpenAI-hulp in een vm, met de echte berichtBody/berichtGeheimOk/berichtStuur van server.js ──
test('server.js: route alleen met API_SECRET, op de primaire kant; vraag loopt door de module; health zonder sleutel', async function () {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const knip = function (begin, eind) { const a = src.indexOf(begin), e = src.indexOf(eind, a + 1); assert.ok(a > 0 && e > a, begin); return src.slice(a, e); };
  const blok = knip('// ── OpenAI-hulp (wv2055', '// ── ScanSnap → OVIS Intake');
  const hulp = knip('function berichtStuur(res, status, obj) {', '// Index: in het geheugen');
  assert.ok(/if \(openaiIsPad\(req\)\) return openaiRoute\(req, res\);/.test(src), 'dispatch');
  assert.ok(/openai: typeof openaiInfo === 'function' \? openaiInfo\(\)/.test(src), '/health');
  assert.ok(/uit\.openai = openaiAppRegel\(\)/.test(src), '/app/tokens');
  const n = await nepApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oai-srv-'));
  fs.writeFileSync(path.join(dir, 'openai.json'), JSON.stringify({ aan: true }));
  const fouten = [];
  const ctx = { require: require, __dirname: path.join(__dirname, '..'), fs: fs, path: path, crypto: require('crypto'), Buffer: Buffer, Date: Date, JSON: JSON,
    setInterval: setInterval, setTimeout: setTimeout, Promise: Promise, fetch: fetch, AbortSignal: AbortSignal, Object: Object, Array: Array, String: String, Number: Number, Error: Error,
    process: { env: { OPENAI_DIR: dir, OPENAI_TOETS_API: n.url, OPENAI_TOETS_SLEUTEL: 'nep-sleutel-srv' } }, SERVER_ECHT: false, SECRET: 'geheim-van-de-toets',
    serverPad: function (naam, env) { return env; }, serverProefDeel: function (d) { return path.join(dir, d); },
    schrijfLog: function () {}, nu: function () { return 't'; }, logError: function (w, e) { fouten.push(w + ': ' + (e && e.message)); },
    reqPath: function (req) { return req.url; }, rolPrimair: function () { return ctx.primair; }, primair: true, BERICHT_AFBREEK: 64 * 1024 * 1024 };
  vm.createContext(ctx);
  vm.runInContext(hulp + '\n' + blok + '\n;this.openaiRoute = openaiRoute; this.openaiInfo = openaiInfo; this.openaiAppRegel = openaiAppRegel; this.openaiIsPad = openaiIsPad;', ctx);
  const roep = function (url, body, methode) {
    return new Promise(function (ok) {
      const req = new (require('events').EventEmitter)();
      req.method = methode || 'POST'; req.url = url; req.resume = function () {}; req.destroy = function () {};
      const res = { headersSent: false, writeHead: function (st) { this.st = st; this.headersSent = true; }, end: function (b) { ok({ st: this.st, j: JSON.parse(b) }); } };
      ctx.openaiRoute(req, res);
      setImmediate(function () { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
    });
  };
  assert.ok(ctx.openaiIsPad({ url: '/openai/vraag' }) && !ctx.openaiIsPad({ url: '/openai/elders' }));
  assert.strictEqual((await roep('/openai/vraag', { afnemer: 'proef', invoer: 'x' })).st, 401);
  assert.strictEqual((await roep('/openai/vraag', { secret: 'fout-geheim-van-de-t', afnemer: 'proef', invoer: 'x' })).st, 401);
  assert.strictEqual((await roep('/openai/vraag', {}, 'GET')).st, 405);
  ctx.primair = false;
  assert.strictEqual((await roep('/openai/vraag', { secret: 'geheim-van-de-toets', afnemer: 'proef', invoer: 'x' })).st, 409);
  ctx.primair = true;
  const r = await roep('/openai/vraag', { secret: 'geheim-van-de-toets', afnemer: 'proef', invoer: 'Zeg pong.' });
  assert.strictEqual(r.st, 200); assert.strictEqual(r.j.ok, true); assert.strictEqual(r.j.tekst, 'pong');
  assert.strictEqual(n.verzoeken[0].auth, 'Bearer nep-sleutel-srv');
  assert.ok(n.verzoeken[0].body.indexOf('geheim-van-de-toets') < 0, 'het pod-geheim gaat niet mee naar OpenAI');
  assert.strictEqual((await roep('/openai/vraag', { secret: 'geheim-van-de-toets', afnemer: 'proef', invoer: PATIENT })).j.status, 'poort');
  assert.strictEqual((await roep('/openai/batch/stand', { secret: 'geheim-van-de-toets', id: 'batch_x' })).st, 404);
  const h = ctx.openaiInfo();
  assert.strictEqual(h.module, true); assert.strictEqual(h.per_status.ok, 1); assert.strictEqual(h.per_status.poort, 1);
  assert.ok(JSON.stringify(h).indexOf('nep-sleutel') < 0);
  assert.deepStrictEqual(Object.keys(ctx.openaiAppRegel()).sort(), ['aan', 'grens_usd', 'maand_usd', 'open_batch_usd', 'periode_start', 'tegoed_usd']);
  assert.deepStrictEqual(fouten, []);
  n.srv.close();
});
