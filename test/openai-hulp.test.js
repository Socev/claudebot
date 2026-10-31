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
  // poort zonder uitslag of met een fout = dicht
  const t3 = nieuw(n.url, { aan: true }, { poort: function () { return null; } });
  assert.strictEqual((await t3.h.vraag({ afnemer: 'proef', invoer: 'x' })).status, 'poort'); t3.h.sluit();
  const t4 = nieuw(n.url, { aan: true }, { poort: function () { throw new Error('stuk'); } });
  assert.strictEqual((await t4.h.vraag({ afnemer: 'proef', invoer: 'x' })).status, 'poort'); t4.h.sluit();
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

// wv2078: grens = maandtempo van de jaarcyclus. Cyclus okt–nov (2 maanden), tegoed $ 16 → $ 8 per maand; grens_usd telt niet meer.
const OKT = { aan: true, tegoed_usd: 16, cyclus_start: '2026-10-01', cyclus_eind: '2026-12-01', grens_usd: 1000 };
const klok = function (iso) { const k = { t: Date.parse(iso) }; k.nu = function () { return k.t; }; return k; };
test('zachte grens: maandtempo van de jaarcyclus, met de schatting van deze aanroep', async function () {
  const k = klok('2026-10-15T10:00:00Z');
  const n = await nepApi(); const t = nieuw(n.url, OKT, { nu: k.nu });
  assert.strictEqual(t.h.stand().grens_usd, 8);
  assert.strictEqual(t.h.stand().cyclus.maanden_over, 2); assert.strictEqual(t.h.stand().cyclus.start_afgeleid, false);
  n.antwoord = { id: 'r', status: 'completed', model: 'gpt-5.5', output: [], usage: { input_tokens: 1e5, output_tokens: 25e4 } };   // $0,50 + $7,50
  assert.strictEqual((await t.h.vraag({ afnemer: 'proef', model: 'gpt-5.5', invoer: 'x' })).ok, true);
  assert.strictEqual(t.h.stand().maand_usd, 8);
  assert.strictEqual((await t.h.vraag({ afnemer: 'proef', model: 'gpt-5-nano', invoer: 'x' })).status, 'grens');
  assert.strictEqual(t.h.stand().maand.oordeel, 'grens_bereikt');
  assert.strictEqual(n.verzoeken.length, 1);
  // november: rest $ 8 over 1 maand → weer $ 8; wat oktober verbruikte telt in de cyclus
  k.t = Date.parse('2026-11-10T10:00:00Z');
  const s = t.h.stand();
  assert.strictEqual(s.grens_usd, 8); assert.strictEqual(s.maand_usd, 0); assert.strictEqual(s.cyclus.usd, 8); assert.strictEqual(s.periode_start, '2026-11-01');
  assert.strictEqual((await t.h.vraag({ afnemer: 'proef', model: 'gpt-5-nano', invoer: 'x', max_uit: 100 })).ok, true);
  // 1 december 00:30 NL: buiten de cyclus → status cyclus, niets verstuurd
  k.t = Date.parse('2026-11-30T23:30:00Z');
  const voor = n.verzoeken.length;
  assert.strictEqual((await t.h.vraag({ afnemer: 'proef', model: 'gpt-5-nano', invoer: 'x' })).status, 'cyclus');
  assert.strictEqual(t.h.stand().maand.oordeel, 'buiten_cyclus'); assert.strictEqual(n.verzoeken.length, voor);
  n.srv.close(); t.h.sluit();
  // een grote max_uit telt mee in de schatting (tegoed $ 0,02 → $ 0,01 per maand)
  const n2 = await nepApi(); const t2 = nieuw(n2.url, Object.assign({}, OKT, { tegoed_usd: 0.02 }), { nu: klok('2026-10-15T10:00:00Z').nu });
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

test('review MOET 1: batch-afronding atomair; mislukt foutbestand = niets geteld, volgende tik telt één keer; één tik tegelijk', async function () {
  const n = await nepApi(); const t = nieuw(n.url, { aan: true, tegoed_usd: 100 });
  assert.strictEqual((await t.h.batchIndienen({ afnemer: 'proef', model: 'gpt-5-nano', verzoeken: [{ id: 'a', invoer: 'x' }, { id: 'b', invoer: 'y' }] })).ok, true);
  n.batches.batch_1.status = 'completed'; n.batches.batch_1.output_file_id = 'file-out'; n.batches.batch_1.error_file_id = 'file-stuk';   // 404 bij ophalen
  const u1 = await t.h.batchTik();
  assert.strictEqual(u1.fout, 1); assert.strictEqual(t.h.stand().maand_usd, 0); assert.ok(t.h.stand().open_batch_usd > 0);
  assert.ok(n.gewist.length === 0, 'niets gewist zolang de batch niet klaar is');
  delete n.batches.batch_1.error_file_id;
  const [u2, u3] = await Promise.all([t.h.batchTik(), t.h.batchTik()]);
  assert.deepStrictEqual(u3, { bezig: true }); assert.strictEqual(u2.klaar, 1);
  assert.strictEqual(t.h.stand().maand_usd, 0.45); assert.strictEqual(t.h.stand().open_batch_usd, 0);
  assert.deepStrictEqual(await t.h.batchTik(), { open: 0 });
  assert.strictEqual(t.h.stand().maand_usd, 0.45);
  n.srv.close(); t.h.sluit();
});

test('review MOET 2: gelijktijdige vragen reserveren vóór de eerste await', async function () {
  const n = await nepApi();
  let los; const wacht = new Promise(function (ok) { los = ok; });
  const t = nieuw(n.url, Object.assign({}, OKT, { tegoed_usd: 0.1 }), { nu: klok('2026-10-15T10:00:00Z').nu, sleutel: async function () { await wacht; return 'nep-sleutel-123'; } });   // grens $ 0,05
  const a = t.h.vraag({ afnemer: 'proef', model: 'gpt-5.4-mini', invoer: 'x', max_uit: 8000 });   // schatting ± $0,036
  const b = t.h.vraag({ afnemer: 'proef', model: 'gpt-5.4-mini', invoer: 'x', max_uit: 8000 });
  los();
  const r = await Promise.all([a, b]);
  assert.deepStrictEqual(r.map(function (x) { return x.ok ? 'ok' : x.status; }).sort(), ['grens', 'ok']);
  assert.strictEqual(t.h.health().gereserveerd_usd, 0);
  n.srv.close(); t.h.sluit();
});

test('review MOET 3 en ZOU 1: schema en batchinstructies + verzoek samen door de poort', async function () {
  const n = await nepApi(); const t = nieuw(n.url, { aan: true });
  const sch = { type: 'object', description: PATIENT, properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
  assert.strictEqual((await t.h.vraag({ afnemer: 'proef', invoer: 'x', schema: sch })).status, 'poort');
  assert.strictEqual((await t.h.vraag({ afnemer: 'proef', invoer: 'x', schema: 'tekst' })).status, 'schema');
  let gezien = null;
  const t2 = nieuw(n.url, { aan: true }, { poort: function (tk) { gezien = tk; return { tegenhouden: false, soorten: [] }; } });
  await t2.h.batchIndienen({ afnemer: 'proef', model: 'gpt-5-nano', instructies: 'INSTR', verzoeken: [{ id: 'a', invoer: 'VERZOEK' }] });
  assert.deepStrictEqual(gezien, ['INSTR', 'VERZOEK']);
  assert.strictEqual(n.verzoeken.length, 2);   // alleen de batch van t2 (upload + aanmaken)
  n.srv.close(); t.h.sluit(); t2.h.sluit();
});

test('review ZOU 2: time-out na versturen boekt de schatting (geschat); 4xx boekt niets', async function () {
  const traag = http.createServer(function () { /* antwoordt nooit */ });
  await new Promise(function (ok) { traag.listen(0, '127.0.0.1', ok); });
  const t = nieuw('http://127.0.0.1:' + traag.address().port, { aan: true });
  const r = await t.h.vraag({ afnemer: 'proef', model: 'gpt-5-nano', invoer: 'x', max_uit: 1000, ms: 200 });
  assert.strictEqual(r.status, 'fout');
  assert.strictEqual(t.h.stand().maand_usd, H._intern.schatting('gpt-5-nano', 1, 1000, false));
  traag.closeAllConnections(); traag.close(); t.h.sluit();
  const n = await nepApi(); n.status = 400; const t2 = nieuw(n.url, { aan: true });
  await t2.h.vraag({ afnemer: 'proef', invoer: 'x' });
  assert.strictEqual(t2.h.stand().maand_usd, 0);
  n.srv.close(); t2.h.sluit();
});

test('review KAN 1/2/4: lange context gevlagd en dubbel; resetdag wijzigen houdt de telling; exacte pod-geheimen', async function () {
  const k = H._intern.kosten('gpt-5.5', { input_tokens: 300000, output_tokens: 0 }, false);
  assert.strictEqual(k.prijs_onbekend, true); assert.strictEqual(k.usd, 2 * 0.3 * 5);
  const n = await nepApi();
  const t = nieuw(n.url, { aan: true }, { geheimen: function () { return ['abcdef0123456789abcdef0123456789']; } });
  assert.ok((await t.h.vraag({ afnemer: 'proef', invoer: 'x' })).ok);
  const voor = t.h.stand().maand_usd;
  fs.writeFileSync(path.join(t.dir, 'openai.json'), JSON.stringify({ aan: true, reset_dag: 2 }));
  const t3 = nieuw(n.url, null, {}); t3.h.sluit();   // (alleen om een tweede module te laten zien dat de inst per minuut herleest)
  assert.strictEqual(t.h.stand().maand_usd, voor);
  assert.strictEqual((await t.h.vraag({ afnemer: 'proef', invoer: 'hex abcdef0123456789abcdef0123456789 erin' })).status, 'geheim');
  const m = await t.h.vraag({ afnemer: 'proef', invoer: 'hex abcdef0123456789abcdef0123456789 erin', maskeer: true });
  assert.strictEqual(m.ok, true); assert.strictEqual(m.gemaskeerd, 1);
  assert.ok(n.verzoeken[n.verzoeken.length - 1].body.indexOf('abcdef0123456789abcdef') < 0);
  assert.strictEqual(H._intern.periodeVan(Date.parse('2026-10-30T12:00:00Z'), 1), '2026-10-01');
  n.srv.close(); t.h.sluit();
});

test('wv2078: cyclus zonder begin = einde min een jaar; delen van maanden; oordeel te snel', async function () {
  const c = H._intern.cyclusVan;
  const a = c(Date.parse('2026-08-25T12:00:00Z'), '2026-08-19', '2027-08-19');
  assert.strictEqual(a.maand_begin, '2026-08-19'); assert.strictEqual(Math.round(a.maanden_over * 1e6), 12e6); assert.strictEqual(a.maand_deel, 13 / 31);
  const b = c(Date.parse('2027-08-10T12:00:00Z'), '2026-08-19', '2027-08-19');
  assert.strictEqual(b.maand_eind, '2027-08-19'); assert.strictEqual(b.maanden_over, 18 / 31); assert.strictEqual(b.maand_deel, 18 / 31);
  const k = klok('2026-10-04T10:00:00Z');
  const n = await nepApi(); const t = nieuw(n.url, { aan: true, tegoed_usd: 100, cyclus_eind: '2027-08-19' }, { nu: k.nu });
  const s = t.h.stand();
  assert.strictEqual(s.cyclus.start, '2026-08-19'); assert.strictEqual(s.cyclus.start_afgeleid, true);
  assert.strictEqual(s.grens_usd, Math.round(100 / (1 + 9 + 18 / 31) * 1e6) / 1e6);
  assert.strictEqual(s.maand.oordeel, 'op_koers');
  // $ 7,50 op dag 4 van oktober: doorgetrokken ver boven ± $ 9,45 → te snel (nog onder de grens)
  n.antwoord = { id: 'r', status: 'completed', model: 'gpt-5.5', output: [], usage: { input_tokens: 0, output_tokens: 25e4 } };
  assert.ok((await t.h.vraag({ afnemer: 'proef', model: 'gpt-5.5', invoer: 'x', max_uit: 100 })).ok);
  assert.strictEqual(t.h.stand().maand.oordeel, 'te_snel');
  n.srv.close(); t.h.sluit();
});

test('wv2078: prijzen GPT-6.1 Terra (ook lange context en batch) en beeldmodellen', function () {
  const kos = H._intern.kosten;
  assert.ok(H.PRIJZEN['gpt-6.1-terra'] && H.PRIJZEN['gpt-5.6-terra']);
  assert.strictEqual(kos('gpt-6.1-terra', { input_tokens: 2e5, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1e5 }, output_tokens: 1e6 }, false).usd, 0.2 + 0.25 + 5);
  assert.strictEqual(kos('gpt-6.1-terra-2026-10-26', { input_tokens: 2e5, input_tokens_details: { cached_tokens: 2e5 }, output_tokens: 0 }, false).usd, 0.01);
  assert.strictEqual(kos('gpt-6.1-terra', { input_tokens: 2e5, output_tokens: 1e6 }, true).usd, 2.6);
  const l = kos('gpt-6.1-terra', { input_tokens: 300000, output_tokens: 1000 }, false);
  assert.strictEqual(l.usd, 0.6075); assert.strictEqual(l.prijs_onbekend, false);   // eigen lange-contexttarief, niet dubbel
  assert.strictEqual(kos('gpt-6.1-terra', { input_tokens: 300000, output_tokens: 1000 }, true).usd, 0.30375);
  const kb = H._intern.kostenBeeld;
  assert.strictEqual(kb('gpt-image-2', { input_tokens: 100, input_tokens_details: { text_tokens: 100 }, output_tokens: 4000 }, false).usd, 0.1205);
  assert.strictEqual(kb('gpt-image-2', { input_tokens: 100, input_tokens_details: { text_tokens: 100 }, output_tokens: 4000 }, true).usd, 0.06025);
  // zonder splitsing telt de invoer als beeld (duurste kant); cache eerst van de tekst
  assert.strictEqual(kb('gpt-image-1-mini', { input_tokens: 1e6, output_tokens: 0 }, false).usd, 2.5);
  assert.strictEqual(kb('gpt-image-1.5', { input_tokens: 0, output_tokens: 1e6, output_tokens_details: { text_tokens: 1e6 } }, false).usd, 10);
  assert.strictEqual(kb('dall-e-3', {}, false), null);
  assert.strictEqual(H.BEELD_DATUM, '2026-10-31');
});

test('wv2078: verbruik() — uitsplitsing per model, afnemer, batch en tokensoort; geen tekst', async function () {
  const k = klok('2026-10-20T10:00:00Z');
  const n = await nepApi(); const t = nieuw(n.url, { aan: true, tegoed_usd: 100, cyclus_eind: '2027-08-19' }, { nu: k.nu });
  assert.ok((await t.h.vraag({ afnemer: 'machinekamer', model: 'gpt-5.4-mini', invoer: 'Geheime vraag over x' })).ok);
  assert.ok((await t.h.vraag({ afnemer: 'review', model: 'gpt-5.4-mini', invoer: 'y' })).ok);
  assert.strictEqual((await t.h.vraag({ afnemer: 'review', invoer: PATIENT })).status, 'poort');
  n.status = 429;
  assert.strictEqual((await t.h.vraag({ afnemer: 'machinekamer', model: 'gpt-5.4-mini', invoer: 'z' })).status, 'api_429');
  n.status = 200;
  k.t = Date.parse('2026-10-21T08:00:00Z');
  assert.ok((await t.h.batchIndienen({ afnemer: 'machinekamer', model: 'gpt-5-nano', verzoeken: [{ id: 'a', invoer: 'een' }, { id: 'b', invoer: 'twee' }] })).ok);
  n.batches.batch_1.status = 'completed'; n.batches.batch_1.output_file_id = 'file-out';
  await t.h.batchTik();
  const v = t.h.verbruik();
  assert.strictEqual(v.ok, true);
  const m = v.deze_maand;
  // per aanroep gpt-5.4-mini: 600 × 0,75 + 400 × 0,075 + 200 × 4,5 = $ 0,00138; batch gpt-5-nano: 2 × (0,025 + 0,2) = $ 0,45
  assert.strictEqual(m.aanroepen, 4); assert.strictEqual(m.geweigerd, 1); assert.strictEqual(m.fouten, 1);
  assert.strictEqual(m.usd, 0.45276);
  assert.deepStrictEqual(m.per_model.map(function (x) { return [x.model, x.aanroepen, x.usd]; }), [['gpt-5-nano', 2, 0.45], ['gpt-5.4-mini', 2, 0.00276]]);
  assert.deepStrictEqual(m.batch, { aanroepen: 2, usd: 0.45 }); assert.deepStrictEqual(m.standaard, { aanroepen: 2, usd: 0.00276 });
  const mk = m.per_afnemer.find(function (x) { return x.afnemer === 'machinekamer'; }), rv = m.per_afnemer.find(function (x) { return x.afnemer === 'review'; });
  assert.strictEqual(mk.aanroepen, 3); assert.strictEqual(rv.aanroepen, 1); assert.strictEqual(rv.geweigerd, 1);
  assert.deepStrictEqual(m.tokens.invoer, { tokens: 2002000, usd: 0.0509 });
  assert.deepStrictEqual(m.tokens.cache_lees, { tokens: 800, usd: 0.00006 });
  assert.deepStrictEqual(m.tokens.uitvoer, { tokens: 2000400, usd: 0.4018 });
  assert.deepStrictEqual(m.tokens.redeneer, { tokens: 100, usd: 0.00045 });
  assert.strictEqual(m.niet_toegedeeld_usd, 0);
  assert.strictEqual(v.sinds_begin.usd, 0.45276); assert.strictEqual(v.cyclus.usd, 0.45276);
  assert.strictEqual(v.per_dag.length, 21); assert.strictEqual(v.per_dag[0].datum, '2026-10-01');
  assert.deepStrictEqual(v.per_dag[19], { datum: '2026-10-20', usd: 0.00276, standaard_usd: 0.00276, batch_usd: 0, aanroepen: 2 });
  assert.deepStrictEqual(v.per_dag[20], { datum: '2026-10-21', usd: 0.45, standaard_usd: 0, batch_usd: 0.45, aanroepen: 2 });
  assert.deepStrictEqual(v.open_batches, []);
  assert.ok(v.aannames.some(function (a) { return /afgeleid/.test(a); }));
  assert.ok((await t.h.vraag({ afnemer: 'constructor', model: 'gpt-5.4-mini', invoer: 'q' })).ok);   // review ZOU 2
  assert.strictEqual(t.h.verbruik().deze_maand.per_afnemer.find(function (x) { return x.afnemer === 'constructor'; }).aanroepen, 1);
  const tekst = JSON.stringify(v);
  assert.ok(tekst.indexOf('Geheime vraag') < 0 && tekst.indexOf('eerste') < 0 && tekst.indexOf('nep-sleutel') < 0 && tekst.indexOf('resp_1') < 0);
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
  assert.ok(/route === 'GET \/app\/tokens\/openai' \|\| route === 'GET \/app\/tokens' \|\|/.test(src), 'dispatch /app/tokens/openai');
  assert.ok(/route === 'GET \/app\/tokens\/openai'\) \{[^]{0,200}openaiVerbruik\(\)/.test(src), 'appTokens geeft openaiVerbruik');
  assert.ok(/terra: 'codex:gpt-6\.1-terra'/.test(src) && /id: 'gpt-6\.1-terra'/.test(src) && /id: 'gpt-5\.6-terra'/.test(src), 'alias en keuzelijst');
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
  vm.runInContext(hulp + '\n' + blok + '\n;this.openaiRoute = openaiRoute; this.openaiInfo = openaiInfo; this.openaiAppRegel = openaiAppRegel; this.openaiIsPad = openaiIsPad; this.openaiVerbruik = openaiVerbruik;', ctx);
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
  assert.deepStrictEqual(Object.keys(ctx.openaiAppRegel()).sort(), ['aan', 'cyclus', 'grens_usd', 'maand', 'maand_usd', 'open_batch_usd', 'periode_start', 'tegoed_usd']);
  const v = ctx.openaiVerbruik();
  assert.strictEqual(v.ok, true); assert.strictEqual(v.deze_maand.aanroepen, 1); assert.ok(JSON.stringify(v).indexOf('nep-sleutel') < 0);
  assert.deepStrictEqual(fouten, []);
  n.srv.close();
});
