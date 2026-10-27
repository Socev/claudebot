'use strict';
// Toetsen voor pdf-lezer.js (wv1431). De echte SDK (@anthropic-ai/sdk, pad in PDF_SDK) tegen een nep-API op 127.0.0.1 die SSE streamt en
// Batches nabootst. Alles verzonnen (de repo is openbaar): nep-PDF's ("%PDF-" + tekst), nep-sleutel, IBAN's met bankcode TEST.
// Raakt geen pod, kluis, mail, vault of het echte API-tegoed. Draaien: bash test/pdf-lezer.sh
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const L = require(path.resolve(__dirname, '..', 'pdf-lezer.js'));
const K = require(path.resolve(__dirname, '..', 'facturen-kern.js'));
const POORT_PP = require(path.resolve(__dirname, '..', 'intake', 'patientpoort.js'));

const SDK_PAD = process.env.PDF_SDK;
const SDK = SDK_PAD ? require('module').createRequire(path.join(SDK_PAD, 'package.json'))('@anthropic-ai/sdk') : null;
const KLASSE = SDK && (SDK.Anthropic || SDK.default || SDK);
const NEP_SLEUTEL = 'nep-sleutel-wv1431';
const WEG = [], SERVERS = [];
after(() => { for (const d of WEG) fs.rmSync(d, { recursive: true, force: true }); for (const s of SERVERS) { s.closeAllConnections(); s.close(); } });

// De omgeving mag niets uitmaken (B1): een verkeerde sleutel en basis-URL in process.env worden genegeerd.
process.env.ANTHROPIC_API_KEY = 'verkeerd-uit-de-omgeving';
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';

function maakIban(land, bank, rek) {
  const r = bank + rek + land + '00';
  let rest = 0;
  for (const ch of r) { const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch; for (const d of v) rest = (rest * 10 + Number(d)) % 97; }
  return land + String(98 - rest).padStart(2, '0') + bank + rek;
}
const IBAN_A = maakIban('NL', 'TEST', '0000000101');
const ENT = [{ sleutel: 'tolgaarde', naam: 'Huisartsenpraktijk Tolgaarde B.V.', kvk: '99000001', aliassen: ['Tolgaarde'] }, { sleutel: 'groenhouten', naam: 'Huisartsenpraktijk Groenhouten', kvk: '99000002', aliassen: [] }];
// Nep-PDF: "%PDF-" + pagina's gescheiden door \f; een lege pagina is een beeldpagina.
const nepPdf = (paginas) => Buffer.from('%PDF-nep\n' + paginas.join('\f'));
const pagVan = (b) => b.toString('utf8').slice(9).split('\f');
const FACTUUR = ['Leverancier A B.V.\nKvK 99100001\nFactuur\nAan: Huisartsenpraktijk Tolgaarde B.V.\nFactuurnummer: VB-2026-0412\nFactuurdatum: 12-10-2026\n' +
  'Subtotaal 1.180,58\nBTW 247,92\nTotaal € 1.428,50\nIBAN ' + IBAN_A.replace(/(.{4})/g, '$1 ') + '\nMerkwoord Zwaluwstaartvlinder'];
const ANTWOORD = {
  soort_stuk: 'factuur', documentdatum: '2026-10-12', afzender: { naam: 'Leverancier A B.V.', kvk: '99100001', btw: null },
  geadresseerde: { naam: 'Huisartsenpraktijk Tolgaarde B.V.', entiteit: 'tolgaarde', rol: 'factuuradres', reden: 'naam op het stuk' },
  factuur: { nummer: 'VB-2026-0412', datum: '2026-10-12', vervaldatum: null, bedrag_excl: '1180.58', btw: '247.92', bedrag_incl: '1428.50', valuta: 'EUR',
    iban_begunstigde: IBAN_A, andere_ibans: [], betaalwijze: 'overmaken', kenmerk: null },
  leesbaarheid: 'goed', onzeker: [], rekencontrole: null,
};

// ── nep-API ──
function nepApi() {
  const st = { verzoeken: [], antwoord: () => ({ json: ANTWOORD }), batches: {}, n: 0 };
  const srv = http.createServer((q, s) => {
    let b = '';
    q.on('data', (d) => (b += d));
    q.on('end', () => {
      const body = b ? JSON.parse(b) : null;
      st.verzoeken.push({ url: q.url, methode: q.method, kop: q.headers, body });
      if (q.method === 'POST' && q.url.startsWith('/v1/messages?') || (q.method === 'POST' && q.url === '/v1/messages')) {
        const a = st.antwoord(body);
        if (a.status) { s.writeHead(a.status, { 'content-type': 'application/json' }); return s.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'nep' } })); }
        s.writeHead(200, { 'content-type': 'text/event-stream' });
        const ev = (t, d) => s.write('event: ' + t + '\ndata: ' + JSON.stringify(Object.assign({ type: t }, d)) + '\n\n');
        const model = a.model || body.model;
        ev('message_start', { message: { id: 'msg_nep', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 5000, output_tokens: 1, cache_read_input_tokens: a.cache || 0, cache_creation_input_tokens: 0 } } });
        const tekst = a.tekst != null ? a.tekst : JSON.stringify(a.json);
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: tekst } });
        ev('content_block_stop', { index: 0 });
        ev('message_delta', { delta: { stop_reason: a.stop || 'end_turn', stop_sequence: null }, usage: { output_tokens: 400 } });
        ev('message_stop', {});
        return s.end();
      }
      if (q.method === 'POST' && q.url.startsWith('/v1/messages/batches')) {
        const id = 'msgbatch_nep' + (++st.n);
        st.batches[id] = { requests: body.requests, klaar: false };
        s.writeHead(200, { 'content-type': 'application/json' });
        return s.end(JSON.stringify({ id, type: 'message_batch', processing_status: 'in_progress', request_counts: { processing: body.requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
          created_at: new Date().toISOString(), expires_at: new Date().toISOString(), ended_at: null, archived_at: null, cancel_initiated_at: null, results_url: null }));
      }
      const m = /^\/v1\/messages\/batches\/([a-z0-9_]+)(\/results)?/.exec(q.url);
      if (q.method === 'GET' && m) {
        const bt = st.batches[m[1]];
        if (m[2]) {
          s.writeHead(200, { 'content-type': 'application/binary' });
          return s.end(bt.requests.map((r) => JSON.stringify({ custom_id: r.custom_id, result: { type: 'succeeded', message: { id: 'msg_b', type: 'message', role: 'assistant', model: r.params.model,
            content: [{ type: 'text', text: JSON.stringify(ANTWOORD) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 4000, output_tokens: 300 } } } })).join('\n') + '\n');
        }
        s.writeHead(200, { 'content-type': 'application/json' });
        return s.end(JSON.stringify({ id: m[1], type: 'message_batch', processing_status: bt.klaar ? 'ended' : 'in_progress', request_counts: {}, created_at: new Date().toISOString(),
          expires_at: new Date().toISOString(), ended_at: null, archived_at: null, cancel_initiated_at: null,
          results_url: bt.klaar ? 'http://127.0.0.1:' + srv.address().port + '/v1/messages/batches/' + m[1] + '/results' : null }));
      }
      s.writeHead(404); s.end('{}');
    });
  });
  SERVERS.push(srv);
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => { st.basis = 'http://127.0.0.1:' + srv.address().port; st.sluit = () => { srv.closeAllConnections(); srv.close(); }; r(st); }));
}

function lezer(api, extra, inst) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-lezer-'));
  WEG.push(dir);
  fs.writeFileSync(path.join(dir, 'pdf-lezer.json'), JSON.stringify(Object.assign({ aan: true, schaduw: true }, inst || {})));
  const meld = [];
  const o = Object.assign({
    dir, basisUrl: api.basis, sleutel: async () => NEP_SLEUTEL, sdk: () => (KLASSE ? { klasse: KLASSE, bron: 'toets' } : null), kern: K, patientpoort: POORT_PP,
    paginas: async (b) => pagVan(b).length,
    pdftotext: async (b) => ({ ok: true, tekst: pagVan(b).map((x) => x + '\f').join('') }),   // zoals pdftotext: \f na elke pagina
    beeldPaginas: async () => [],
    ocr: async (b, pag) => ({ per: pag.map(() => 'Leverancier B B.V. Factuur 77 Totaal 10,00 onschuldige scantekst') }),
    melding: (t) => meld.push(t), fout: () => {},
  }, extra || {});
  const l = L.maak(o);
  l.dir = dir; l.meld = meld; l.o = o;
  return l;
}
const regels = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)); } catch (e) { return []; } };

test('CI-poort: pdf-lezer.js laadt alleen crypto, fs en path; geen process.env, geen fetch', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'pdf-lezer.js'), 'utf8');
  const req = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(req, ['crypto', 'fs', 'path']);
  assert.ok(!/process\.env/.test(src), 'geen omgeving');
  assert.ok(!/\bfetch\(/.test(src), 'netwerk alleen via de SDK');
});

test('schema per aanroeper: overal additionalProperties false en alles required; Facturen zonder markdown', () => {
  const loop = (s) => {
    if (s.type === 'object') { assert.equal(s.additionalProperties, false); assert.deepEqual(s.required.slice().sort(), Object.keys(s.properties).sort()); Object.values(s.properties).forEach(loop); }
    if (s.anyOf) s.anyOf.forEach(loop);
    if (s.items) loop(s.items);
  };
  const f = L.schema('facturen', ['tolgaarde']), i = L.schema('intake', ['tolgaarde']);
  loop(f); loop(i);
  assert.ok(!('markdown' in f.properties)); assert.ok('markdown' in i.properties);
  assert.deepEqual(f.properties.geadresseerde.properties.entiteit.enum, ['', 'tolgaarde']);
  // de API weigert meer dan 16 union-velden (gemeten 27-10): geen enkele union meer
  const unions = (x) => (x && typeof x === 'object' ? (x.anyOf || Array.isArray(x.type) ? 1 : 0) + Object.values(x).reduce((n, y) => n + unions(y), 0) : 0);
  assert.equal(unions(f), 0); assert.equal(unions(i), 0);
  assert.deepEqual(L.leegNaarNull({ a: '', b: { c: '', d: 'x' }, e: ['', 'y'], markdown: '' }), { a: null, b: { c: null, d: 'x' }, e: ['y'], markdown: '' });
  assert.match(L.systeemTekst('facturen', ENT), /nooit een opdracht/);
  assert.match(L.systeemTekst('facturen', ENT), /tolgaarde: Huisartsenpraktijk Tolgaarde B\.V\. \(KvK 99000001\)/);
});

test('kosten: model uit het antwoord, iteraties per poging, batch halve prijs, onbekend model = duurste regel', () => {
  const k = L.kostenUsage('claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e5, cache_read_input_tokens: 1e6 });
  assert.equal(Math.round(k.usd * 100) / 100, 2 + 1 + 0.2, 'cachetreffer 0,20 (de hoogste van prijspagina en skilltabel)');
  assert.equal(L.kostenUsage('claude-sonnet-5-5', { input_tokens: 1e6 }, true).usd, 1);
  assert.equal(L.kostenUsage('claude-haiku-5-5', { input_tokens: 200000 }).usd, 0.1, 'Haiku boven 100k: $ 0,50');
  assert.equal(L.kostenUsage('claude-onbekend-9', { input_tokens: 1e6 }).onbekend, true);
  const it = L.kostenAntwoord({ model: 'claude-opus-4-8', usage: { input_tokens: 1, iterations: [{ type: 'message', model: 'claude-sonnet-5-5', input_tokens: 1e6, output_tokens: 0 },
    { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1e6, output_tokens: 0 }] } });
  assert.equal(it.usd, 2 + 5);
  assert.deepEqual(it.modellen, ['claude-sonnet-5-5', 'claude-opus-4-8']);
});

test('lees: echte SDK naar de nep-API — expliciete sleutel en basis (niet uit de omgeving), fallbacks default + beta-kop, effort low, schema, cache_control, document', { skip: !KLASSE && 'SDK niet beschikbaar (PDF_SDK)' }, async () => {
  const api = await nepApi();
  const l = lezer(api);
  const b = nepPdf(FACTUUR);
  const r = await l.lees(b, { aanroeper: 'facturen', entiteiten: ENT, lokaleTekst: FACTUUR[0] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.r.factuur.nummer, 'VB-2026-0412');
  assert.deepEqual(r.controle.vlaggen, ['entiteit_kvk_niet_op_stuk'], 'bedragen, IBAN, nummer en KvK lokaal gevonden; alleen de KvK van Tolgaarde staat niet op het stuk');
  const r2 = await l.lees(b, { aanroeper: 'facturen', entiteiten: ENT, lokaleTekst: FACTUUR[0].replace('1.428,50', '1.482,50') + '\nKvK 99000001' });
  assert.deepEqual(r2.controle.vlaggen, ['incl_niet_lokaal']);
  const r3 = await l.lees(b, { aanroeper: 'facturen', entiteiten: ENT, lokaleTekst: '' });
  assert.deepEqual(r3.controle.vlaggen, ['alleen_claude'], 'scan die de OCR niet haalde: veld blijft, vlag erbij');
  const v = api.verzoeken[0];
  // SDK 1.x stuurt de API-sleutel als Bearer; het moet de expliciete sleutel zijn, niet die uit de omgeving
  assert.equal(v.kop.authorization || v.kop['x-api-key'], v.kop.authorization ? 'Bearer ' + NEP_SLEUTEL : NEP_SLEUTEL);
  assert.ok(!JSON.stringify(v.kop).includes('verkeerd-uit-de-omgeving'));
  assert.match(v.kop['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(v.body.fallbacks, 'default');
  assert.equal(v.body.model, 'claude-sonnet-5-5');
  assert.equal(v.body.stream, true);
  assert.equal(v.body.output_config.effort, 'low');
  assert.equal(v.body.output_config.format.type, 'json_schema');
  assert.ok(!('markdown' in v.body.output_config.format.schema.properties));
  assert.deepEqual(v.body.system[0].cache_control, { type: 'ephemeral' });
  const doc = v.body.messages[0].content[0];
  assert.equal(doc.type, 'document'); assert.equal(doc.source.media_type, 'application/pdf');
  assert.ok(Buffer.from(doc.source.data, 'base64').equals(b));
  assert.equal(v.body.max_tokens, L.maxTokens(1, false));
  const vb = regels(path.join(l.dir, 'verbruik.jsonl'));
  assert.equal(vb.length, 3);
  assert.equal(vb[0].model, 'claude-sonnet-5-5'); assert.equal(vb[0].in, 5000); assert.equal(vb[0].uit, 400);
  assert.ok(!JSON.stringify(vb).includes('Zwaluwstaartvlinder') && !JSON.stringify(vb).includes('VB-2026-0412'), 'geen tekst of velden in het verbruikslog');
  const h = l.health();
  assert.equal(h.aanroepen_vandaag, 3); assert.ok(h.vandaag_usd > 0); assert.equal(h.sleutel, 'aanwezig'); assert.equal(h.gereserveerd_usd, 0);
  assert.ok(!JSON.stringify(h).includes(NEP_SLEUTEL));
  // review wv1431 ZOU 5: basis_url in het instellingenbestand telt niet (alleen maak({ basisUrl }) uit de toets)
  const vang = []; const kaper = http.createServer((q, s2) => { vang.push(q.headers.authorization); s2.writeHead(500); s2.end(); }); SERVERS.push(kaper);
  await new Promise((r9) => kaper.listen(0, '127.0.0.1', r9));
  const lk = lezer(api, { basisUrl: undefined, sdk: () => ({ klasse: class extends KLASSE { constructor(x) { assert.equal(x.baseURL, 'https://api.anthropic.com'); assert.equal(x.logLevel, 'off'); throw new Error('stop'); } }, bron: 'toets' }) }, { basis_url: 'http://127.0.0.1:' + kaper.address().port });
  await assert.rejects(lk.lees(b, { aanroeper: 'facturen' }), /stop/);
  assert.equal(vang.length, 0);
  // Intake: met markdown en meer max_tokens
  api.antwoord = () => ({ json: Object.assign({}, ANTWOORD, { markdown: '# x', categorie_voorstel: null, samenvatting: 'Een factuur.' }) });
  const ri = await l.lees(nepPdf(['a', 'b', 'c']), { aanroeper: 'intake', entiteiten: ENT, lokaleTekst: 'tekst' });
  assert.equal(ri.ok, true);
  assert.ok('markdown' in api.verzoeken[3].body.output_config.format.schema.properties);
  assert.equal(api.verzoeken[3].body.max_tokens, L.maxTokens(3, true));
  api.sluit();
});

test('terugval: weigering, afgekapt, ongeldige JSON, HTTP-fout, geen pdf, te veel pagina\'s, sleutel ontbreekt, uit', { skip: !KLASSE && 'SDK niet beschikbaar' }, async () => {
  const api = await nepApi();
  const l = lezer(api);
  const b = nepPdf(FACTUUR);
  api.antwoord = () => ({ tekst: '', stop: 'refusal' });
  assert.equal((await l.lees(b, { aanroeper: 'facturen' })).terugval, 'weigering');
  api.antwoord = () => ({ tekst: '{"soort_stuk":', stop: 'max_tokens' });
  assert.equal((await l.lees(b, { aanroeper: 'facturen' })).terugval, 'afgekapt');
  api.antwoord = () => ({ tekst: 'geen json' });
  assert.equal((await l.lees(b, { aanroeper: 'facturen' })).terugval, 'schema');
  api.antwoord = () => ({ status: 400 });
  assert.equal((await l.lees(b, { aanroeper: 'facturen' })).terugval, 'api_400');
  assert.equal((await l.lees(Buffer.from('geen pdf'), { aanroeper: 'facturen' })).terugval, 'geen_pdf');
  assert.equal((await l.lees(nepPdf(new Array(151).fill('x')), { aanroeper: 'facturen' })).terugval, 'te_veel_paginas');
  const zonder = lezer(api, { sleutel: async () => null });
  assert.equal((await zonder.lees(b, { aanroeper: 'facturen' })).terugval, 'sleutel_ontbreekt');
  const kluis = lezer(api, { sleutel: async () => { throw new Error('kluis weg'); } });
  assert.equal((await kluis.lees(b, { aanroeper: 'facturen' })).terugval, 'kluis_fout');
  const uit = lezer(api, {}, { aan: false });
  assert.equal((await uit.lees(b, { aanroeper: 'facturen' })).terugval, 'uit');
  assert.equal(l.health().terugvallen_maand, 6);
  assert.equal(l.health().gereserveerd_usd, 0, 'reservering na elke uitkomst vrij');
  api.sluit();
});

test('grens: reservering vóór de aanroep (parallel niet erover), dag- en maandgrens, één melding per maand, telling na een herstart', { skip: !KLASSE && 'SDK niet beschikbaar' }, async () => {
  const api = await nepApi();
  const een = (() => { const i = Object.assign({}, L.STANDAARD); return L.kostenUsage('claude-sonnet-5-5', { input_tokens: 1 * i.tokens_per_pagina + 3000, output_tokens: L.maxTokens(1, false) }).usd; })();
  const l = lezer(api, {}, { grens_dag_usd: een * 1.5 });
  const b = nepPdf(FACTUUR);
  const [a, c] = await Promise.all([l.lees(b, { aanroeper: 'facturen' }), l.lees(b, { aanroeper: 'facturen' })]);
  assert.deepEqual([a.ok, c.ok].sort(), [false, true]);
  assert.equal([a, c].find((x) => !x.ok).terugval, 'grens_dag');
  assert.equal(api.verzoeken.length, 1, 'de tweede aanroep ging niet de deur uit');
  await l.lees(b, { aanroeper: 'facturen' });
  assert.equal(l.meld.length, 1, 'één melding per maand');
  const vandaag = l.health().vandaag_usd;
  // herstart: zelfde map, nieuwe lezer telt op uit verbruik.jsonl
  const l2 = L.maak(Object.assign({}, l.o));
  assert.equal(l2.health().vandaag_usd, vandaag);
  assert.equal(l2.health().maand_usd, vandaag);
  assert.equal(l2.health().terugvallen_maand, l.health().terugvallen_maand);
  assert.equal(l2.health().aanroepen_maand, l.health().aanroepen_maand);
  const m = lezer(api, {}, { grens_maand_usd: een / 2 });
  assert.equal((await m.lees(b, { aanroeper: 'facturen' })).terugval, 'grens_maand');
  api.sluit();
});

test('patiëntregel Facturen (B2/B3): kenmerk, scan zonder of met deels OCR, mislukte OCR, ingebedde PDF — dicht; schoon bericht open', async () => {
  const api = await nepApi();
  const l = lezer(api);
  const pdf = (pag) => ({ sha256: L.sha256(nepPdf(pag)), naam: 'f.pdf', mime: 'application/pdf', bytes: nepPdf(pag), tekst: pag.join('\f'), tekstlaag: true });
  assert.equal((await l.poortFacturen({ overgeslagen: 0, documenten: [pdf(FACTUUR)] })).open, true);
  const bsn = await l.poortFacturen({ overgeslagen: 0, documenten: [pdf([FACTUUR[0] + '\nBSN: 111222333'])] });
  assert.deepEqual([bsn.open, bsn.reden], [false, 'kenmerk']);
  const brief = await l.poortFacturen({ overgeslagen: 0, documenten: [pdf(['Geachte collega, wij zagen bovengenoemde patiënt op de polikliniek. Diagnose volgt; medicatie aangepast, uitslag lab volgt.'])] });
  assert.equal(brief.open, false);
  // scan: OCR leest patiënttaal → dicht
  const ocrPat = lezer(api, { ocr: async (b, p) => ({ per: p.map(() => 'Patiënt geboortedatum 01-02-1950, BSN 111222333') }) });
  const scan = { sha256: 'a'.repeat(64), naam: 's.pdf', mime: 'application/pdf', bytes: nepPdf(['', '']), tekst: '\f', tekstlaag: false };
  assert.equal((await ocrPat.poortFacturen({ overgeslagen: 0, documenten: [scan] })).open, false);
  const ocrStuk = lezer(api, { ocr: async () => null });
  assert.equal((await ocrStuk.poortFacturen({ overgeslagen: 0, documenten: [scan] })).reden, 'ocr_mislukt');
  const half = lezer(api, { ocr: async (b, p) => ({ per: p.slice(1).map(() => 'x'.repeat(50)) }) });
  assert.equal((await half.poortFacturen({ overgeslagen: 0, documenten: [scan] })).reden, 'ocr_mislukt', 'deels gelezen = dicht');
  const elf = Object.assign({}, scan, { bytes: nepPdf(new Array(11).fill('')), tekst: '' });
  assert.equal((await l.poortFacturen({ overgeslagen: 0, documenten: [elf] })).reden, 'ocr_deels');
  // review wv1431 MOET 1: lege of ruis-OCR op een beeldpagina telt niet als gelezen, ook als de andere pagina genoeg tekst heeft
  const gemengd = Object.assign({}, scan, { bytes: nepPdf([FACTUUR[0], '']) });
  for (const t of ['', '| ~ . ,', '   \n  ']) {
    const lg = lezer(api, { ocr: async (b, p) => ({ per: p.map(() => t) }) });
    assert.equal((await lg.poortFacturen({ overgeslagen: 0, documenten: [gemengd] })).reden, 'ocr_leeg', JSON.stringify(t));
  }
  // ZOU 3: een beeld op een pagina met genoeg tekst wordt ook geOCR'd; pagina-einden ≠ pdfinfo, afgekapte tekst of pdfimages kapot → dicht
  const gevraagd = [];
  const metBeeld = lezer(api, { beeldPaginas: async () => [1], ocr: async (b, p) => { gevraagd.push(...p); return { per: p.map(() => 'Geachte collega, wij zagen bovengenoemde patiënt op de polikliniek; medicatie en uitslag lab volgen.') }; } });
  const r1 = await metBeeld.poortFacturen({ overgeslagen: 0, documenten: [pdf(FACTUUR)] });
  assert.deepEqual(gevraagd, [1]); assert.equal(r1.open, false, 'de scan onder een tekstpagina ging door de patiëntpoort');
  const ff = lezer(api, { pdftotext: async (b) => ({ ok: true, tekst: pagVan(b).join('') + '\f' }) });
  assert.equal((await ff.poortFacturen({ overgeslagen: 0, documenten: [pdf(['a'.repeat(50), 'b'.repeat(50)])] })).reden, 'paginatelling');
  const kap = lezer(api, { pdftotext: async (b) => ({ ok: true, tekst: pagVan(b).map((x) => x + '\f').join(''), afgekapt: true }) });
  assert.equal((await kap.poortFacturen({ overgeslagen: 0, documenten: [pdf(FACTUUR)] })).reden, 'tekst_afgekapt');
  const pi = lezer(api, { beeldPaginas: async () => null });
  assert.equal((await pi.poortFacturen({ overgeslagen: 0, documenten: [pdf(FACTUUR)] })).reden, 'pdfimages');
  // ZOU 4: een bijlage die de koerier niet doorgaf (of onbekend aantal) sluit het bericht
  assert.equal((await l.poortFacturen({ overgeslagen: 1, documenten: [pdf(FACTUUR)] })).reden, 'onderdeel_overgeslagen');
  assert.equal((await l.poortFacturen({ documenten: [pdf(FACTUUR)] })).reden, 'onderdeel_overgeslagen');
  assert.equal((await l.poortFacturen({ overgeslagen: 0, documenten: [Object.assign({}, pdf(FACTUUR), { patientkenmerk_koerier: true })] })).reden, 'koerier_kenmerk');
  // UBL met ingebedde PDF waarin een kenmerk staat → het hele bericht dicht (ook de schone PDF ernaast)
  const ingebed = nepPdf(['Patiënt: zie dossier\nBSN: 111222333\nGeboortedatum: 01-02-1950']).toString('base64');
  const ubl = '<Invoice><cac:AdditionalDocumentReference><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="x.pdf">' + ingebed +
    '</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference><cbc:ID>VB-1</cbc:ID></Invoice>';
  const r = await l.poortFacturen({ overgeslagen: 0, documenten: [pdf(FACTUUR), { sha256: 'b'.repeat(64), naam: 'f.xml', mime: 'application/xml', ubl_xml: ubl }] });
  assert.deepEqual([r.open, r.reden], [false, 'kenmerk']);
  assert.deepEqual(L.ingebeddePdfs(ubl).length, 1);
  const ublAnders = ubl.replace('mimeCode="application/pdf"', 'mimeCode="application/octet-stream"');
  assert.equal((await l.poortFacturen({ overgeslagen: 0, documenten: [pdf(FACTUUR), { sha256: 'd'.repeat(64), naam: 'f.xml', mime: 'application/xml', ubl_xml: ublAnders }] })).reden, 'ingebed_geen_pdf');
  assert.ok(!/EmbeddedDocumentBinaryObject|QlNO/.test(L.ublTekst(ubl)));
  // onbekend onderdeel (geen PDF, geen UBL) → dicht
  assert.equal((await l.poortFacturen({ overgeslagen: 0, documenten: [{ sha256: 'c'.repeat(64), naam: 'x.bin', mime: 'application/octet-stream' }] })).reden, 'onbekend_onderdeel');
  api.sluit();
});

test('schaduw Facturen: dicht bericht → geen aanroep, alleen reden en soorten; open bericht → velden + verschilvlaggen, geen tekst', { skip: !KLASSE && 'SDK niet beschikbaar' }, async () => {
  const api = await nepApi();
  const l = lezer(api);
  const pdf = (pag) => ({ sha256: L.sha256(nepPdf(pag)), naam: 'f.pdf', mime: 'application/pdf', bytes: nepPdf(pag), tekst: pag.join('\f'), tekstlaag: true });
  const dicht = pdf([FACTUUR[0] + '\nBSN: 111222333']);
  assert.equal(l.schaduw({ soort: 'facturen', overgeslagen: 0, bericht: { onderwerp: 'Factuur' }, documenten: [dicht], kern: [] }), true);
  const open = pdf(FACTUUR);
  l.schaduw({ soort: 'facturen', overgeslagen: 0, bericht: { onderwerp: 'Factuur' }, documenten: [open], entiteiten: ENT,
    kern: [{ document: open.sha256, status: 'te_beoordelen', nummer: 'VB-2026-0412', factuurdatum: null, incl: 142850, iban: IBAN_A, entiteit: 'groenhouten', scan: false }] });
  await l.leeg();
  assert.equal(api.verzoeken.length, 1, 'alleen het open bericht ging naar de API');
  const s = regels(path.join(l.dir, 'schaduw.jsonl'));
  assert.equal(s.length, 2);
  assert.deepEqual([s[0].gesloten, s[0].reden], [true, 'kenmerk']);
  assert.deepEqual(s[1].verschil, { nummer: 'gelijk', datum: 'alleen_claude', incl: 'gelijk', iban: 'gelijk', entiteit: 'anders' });
  assert.deepEqual(s[1].controle, ['entiteit_kvk_niet_op_stuk']);
  const alles = fs.readFileSync(path.join(l.dir, 'schaduw.jsonl'), 'utf8');
  assert.ok(!/Zwaluwstaartvlinder|111222333|Leverancier A/.test(alles), 'geen tekst, geen kenmerk, geen afzender in het schaduwlog');
  assert.equal(fs.statSync(path.join(l.dir, 'schaduw.jsonl')).mode & 0o777, 0o600);
  assert.equal(l.health().schaduw_stand.gesloten, 1);
  // schaduw uit → niets in de rij
  const uit = lezer(api, {}, { schaduw: false });
  assert.equal(uit.schaduw({ soort: 'facturen', documenten: [open] }), false);
  api.sluit();
});

test('schaduw Intake: leest het blob-pad, logt soort/datum/entiteit (knoop) tegen de router, nooit markdown', { skip: !KLASSE && 'SDK niet beschikbaar' }, async () => {
  const api = await nepApi();
  api.antwoord = () => ({ json: Object.assign({}, ANTWOORD, { markdown: '# Geheime markdowntekst', categorie_voorstel: 'facturen', samenvatting: 'Samenvatting die niet gelogd wordt.' }) });
  const l = lezer(api);
  const blob = path.join(l.dir, 'blob.pdf');
  fs.writeFileSync(blob, nepPdf(FACTUUR));
  l.schaduw({ soort: 'intake', stuk_id: 'stk_1', entiteiten: ENT, delen: [{ deel: 'd0', sha256: L.sha256(nepPdf(FACTUUR)), pad: blob, tekst: FACTUUR[0] }], router: { soort: 'bewijsstuk', entiteit: 'TG' } });
  await l.leeg();
  const s = regels(path.join(l.dir, 'schaduw.jsonl'));
  assert.equal(s.length, 1);
  assert.equal(s[0].claude.knoop, 'TG');
  assert.deepEqual(s[0].verschil, { entiteit: 'gelijk' });
  assert.equal(s[0].claude.markdown_tekens, '# Geheime markdowntekst'.length);
  assert.ok(!/Geheime markdowntekst|Samenvatting die niet/.test(JSON.stringify(s)));
  // review wv1431 MOET 2: getypte eerste pagina + gescande patiëntbrief erachter → de lezer OCR't zelf, sluit, en roept de API niet aan
  const voor = api.verzoeken.length;
  const l2 = lezer(api, { ocr: async (b, p) => ({ per: p.map(() => 'Geachte collega, wij zagen bovengenoemde patiënt op de polikliniek; medicatie en uitslag lab volgen. ZWAARDVIS') }) });
  const blob2 = path.join(l2.dir, 'blob2.pdf');
  fs.writeFileSync(blob2, nepPdf([FACTUUR[0], '']));
  l2.schaduw({ soort: 'intake', stuk_id: 'stk_2', entiteiten: ENT, delen: [{ deel: 'd0', sha256: 'e'.repeat(64), pad: blob2, tekst: FACTUUR[0] }], router: { soort: 'bewijsstuk', entiteit: 'TG' } });
  await l2.leeg();
  assert.equal(api.verzoeken.length, voor, 'geen API-aanroep');
  const s2 = regels(path.join(l2.dir, 'schaduw.jsonl'));
  assert.equal(s2[0].gesloten, true); assert.ok(!/ZWAARDVIS/.test(JSON.stringify(s2)));
  api.sluit();
});

test('batches: indienen zonder fallbacks, reservering tegen batchprijs, ophalen op custom_id, ontvanger krijgt het resultaat, reservering na herstart', { skip: !KLASSE && 'SDK niet beschikbaar' }, async () => {
  const api = await nepApi();
  const l = lezer(api);
  const gekregen = [];
  l.bijBatch('intake', async (sha, r) => gekregen.push([sha, r.ok, r.r && r.r.factuur.nummer]));
  const sha = L.sha256(nepPdf(FACTUUR));
  assert.equal(l.batchWachtrij({ aanroeper: 'intake', sha256: sha, bytes: nepPdf(FACTUUR), entiteiten: ENT }), false, 'zonder patiëntregel geweigerd');
  assert.equal(l.batchWachtrij({ aanroeper: 'intake', sha256: sha, bytes: nepPdf(FACTUUR), entiteiten: ENT, patientregel: 'doorgelaten' }), true);
  const u = await l.batchTik();
  assert.equal(u.ingediend, 1, JSON.stringify(u));
  const req = api.verzoeken.find((v) => v.url.startsWith('/v1/messages/batches') && v.methode === 'POST').body.requests[0];
  assert.ok(!('fallbacks' in req.params) && !('betas' in req.params), 'de Batches API weigert fallbacks');
  assert.match(req.custom_id, /^[a-f0-9]{48}_intake$/);
  assert.ok(l.health().gereserveerd_usd > 0);
  // herstart vóór het resultaat: de reservering telt weer mee
  const l2 = L.maak(Object.assign({}, l.o));
  assert.equal(l2.health().gereserveerd_usd, l.health().gereserveerd_usd);
  l2.bijBatch('intake', async (s2, r) => gekregen.push([s2, r.ok, r.r && r.r.factuur.nummer]));
  Object.values(api.batches)[0].klaar = true;
  const u2 = await l2.batchTik();
  assert.equal(u2.opgehaald, 1, JSON.stringify(u2));
  assert.deepEqual(gekregen, [[sha, true, 'VB-2026-0412']]);
  assert.equal(l2.health().gereserveerd_usd, 0);
  assert.equal(l2.health().batch.open, 0);
  const vb = regels(path.join(l.dir, 'verbruik.jsonl')).filter((x) => x.batch);
  assert.equal(vb.length, 1);
  assert.equal(vb[0].usd, L.kostenUsage('claude-sonnet-5-5', { input_tokens: 4000, output_tokens: 300 }, true).usd);
  // lege wachtrij en geen open batch: geen API-aanroep
  const voor = api.verzoeken.length;
  await l2.batchTik();
  assert.equal(api.verzoeken.length, voor);
  api.sluit();
});

test('server.js: sleutel via de Management-API (niet uit de omgeving), alleen op de primaire kant, /health, koerier en router; kastje krijgt geen Anthropic-sleutel', () => {
  const s = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  const blok = s.slice(s.indexOf('// ── PDF-lezer via de Claude-API (wv1431'), s.indexOf('async function pdfBatchTik()'));
  assert.match(blok, /const PDF_SLEUTEL_NAAM = 'anthropic_api_key_pdf';/);
  assert.match(blok, /api\.supabase\.com\/v1\/projects\//);
  assert.ok(!/process\.env\.ANTHROPIC/.test(blok), 'geen ANTHROPIC_* uit de omgeving');
  assert.match(blok, /function pdfSchaduw\(job\) \{ if \(!pdfLezer \|\| !rolPrimair\(\)\) return false;/);
  assert.match(s, /pdf_lezer: pdfLezerInfo\(\)/);
  assert.match(s, /function facturenIo\(\) \{ return \{[^}]*pdfSchaduw: pdfSchaduw \}; \}/);
  assert.match(s, /ocr: intakeOcr, docx: intakeDocx, pdfSchaduw: pdfSchaduw,/);
  assert.ok(!/ANTHROPIC_API_KEY_AUTO/.test(s), 'geen doorgifte meer aan het kastje-kind');
  const u = fs.readFileSync(path.resolve(__dirname, '..', 'uitrol.sh'), 'utf8');
  assert.match(u, /RELEASE_OPTIONEEL="[^"]*\bpdf-lezer\.js\b/);
});
