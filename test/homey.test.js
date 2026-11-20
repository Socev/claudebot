'use strict';
// Toetst homey.js (wv3460) tegen een nep-Athom op 127.0.0.1 (token + MCP, SSE-antwoorden), met verzonnen client en tokens:
// alleen-lezen-poort (geen tools/call, geen ander pad), state eenmalig, inlog → refresh in de nep-kluis, ronde met rotatie,
// dood token, noodkopie bij een kluisfout, en form_post-terugkeer via het kindproces.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'homey.js');
const ID = 'proefclient-123456', GEHEIM = 'proefgeheim-abcdefghijklmnop';
const DONGLE = '80384a32-0cff-4fb6-9299-cea1a9b59712', LAADPAAL = '569b0ee1-bda5-4342-b92d-dcfdc3c50ffb';
let fout32603 = false;
let poort, server, gezien = [], refreshGeldig = new Set(), codeGeldig = new Set(['proefcode-1']), roteren = true;

function sseVan(j) { return 'event: message\ndata: ' + JSON.stringify(j) + '\n\n'; }
test.before(async function () {
  server = http.createServer(function (req, res) {
    let b = '';
    req.on('data', function (c) { b += c; });
    req.on('end', function () {
      gezien.push({ methode: req.method, pad: req.url, auth: req.headers.authorization || '', body: b, sessie: req.headers['mcp-session-id'] || null });
      if (req.url === '/oauth2/token') {
        const verwacht = 'Basic ' + Buffer.from(ID + ':' + GEHEIM).toString('base64');
        if (req.headers.authorization !== verwacht) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"invalid_client"}'); }
        const f = new URLSearchParams(b);
        let ok = false;
        if (f.get('grant_type') === 'authorization_code' && codeGeldig.has(f.get('code')) && f.get('redirect_uri') === 'https://bank.socev.dev/homey/terug') { codeGeldig.delete(f.get('code')); ok = true; }
        if (f.get('grant_type') === 'refresh_token' && refreshGeldig.has(f.get('refresh_token'))) { if (roteren) refreshGeldig.delete(f.get('refresh_token')); ok = true; }
        if (!ok) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":"invalid_grant"}'); }
        const nieuw = 'refresh-' + crypto.randomBytes(12).toString('hex');
        refreshGeldig.add(nieuw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ access_token: 'access-' + crypto.randomBytes(12).toString('hex'), refresh_token: roteren || f.get('grant_type') === 'authorization_code' ? nieuw : undefined, expires_in: 3600, token_type: 'bearer' }));
      }
      if (req.url === '/') {
        if (!/^Bearer access-/.test(req.headers.authorization || '')) { res.writeHead(401); return res.end('{"error":"Missing Authorization Header"}'); }
        const m = JSON.parse(b);
        if (m.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'sessie-proef-1' });
        if (m.method === 'initialize') return res.end(sseVan({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'Proef-Homey', version: '0.1' }, capabilities: { tools: {} } } }));
        if (m.method === 'tools/list') return res.end(sseVan({ jsonrpc: '2.0', id: m.id, result: { tools: [
          { name: 'list_devices', description: 'Lijst apparaten', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { zone: {} } } },
          { name: 'set_capability', description: 'Zet iets <script>', annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: { type: 'object', properties: { device: {}, value: {} } } }] } }));
        if (m.method === 'tools/call') {
          const a = m.params.arguments;
          if (m.params.name === 'list_devices') return res.end(sseVan({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'x' }], structuredContent: { devices: [
            { id: '11111111-1111-4111-8111-111111111111', name: 'Lamp Proefkind', zone: 'Kamer Proefkind', type: 'light', state: { measure_power: 4 } },
            { id: DONGLE, name: 'Proefdongle Proefstraat 1', zone: 'Thuis', type: 'sensor', state: { 'meter_power.imported': 1000.5, 'meter_power.exported': 3, 'measure_power': 2000,
              'measure_current.phase1': 3, 'measure_current.phase2': 2, 'measure_current.phase3': 3, 'measure_power.phase1': 700, 'measure_power.phase2': 500, 'measure_power.phase3': 800 } },
            { id: LAADPAAL, name: 'Proeflader', zone: 'Thuis', type: 'evcharger', state: { evcharger_charging: true, measure_power: 7000, measure_current: 32, evcharger_charging_state: 'plugged_in_charging' } }] } } }));
          if (m.params.name === 'get_insights_log_entries_number') {
            if (fout32603 && /phase2$/.test(a.logId)) return res.end(sseVan({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'intern' } }));
            if (/phase3$/.test(a.logId) && /measure_power/.test(a.logId)) return res.end(sseVan({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Invalid structured content' } }));
            const cap = a.logId.split(':').pop();
            const v = cap === 'measure_current.phase1' ? [10, 22, 26] : cap === 'energy_power' ? [0, 7000, 7100] : cap.startsWith('measure_power') ? [500, 600, 700] : [1, 2, 3];
            return res.end(sseVan({ jsonrpc: '2.0', id: m.id, result: { structuredContent: { entries: [
              { t: '2026-11-20T05:00:00.000Z', v: v[0] }, { t: '2026-11-20T05:00:05.000Z', v: v[1] }, { t: '2026-11-20T05:01:00.000Z', v: v[2] }] } } }));
          }
        }
        return res.end(sseVan({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'onbekend' } }));
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  poort = server.address().port;
  process.env.HOMEY_BASIS = 'http://127.0.0.1:' + poort;
  process.env.HOMEY_PAUZE_MS = '0';
});
test.after(function () { server.close(); });

function laad() { delete require.cache[require.resolve(SCRIPT)]; return require(SCRIPT); }
function kindDeps(dir, kluis) {
  return {
    dir: dir, wacht: function () { return Promise.resolve(); },
    kluisLees: async function () { return { client_id: ID, client_secret: GEHEIM, refresh: kluis.refresh || '' }; },
    kluisZet: async function (w) { if (kluis.stuk) throw new Error('kluis stuk'); kluis.refresh = w; return crypto.createHash('sha256').update(w).digest('hex'); },
    kind: function (opdracht, invoer) {
      return new Promise(function (resolve) {
        const p = spawn(process.execPath, ['--no-warnings', SCRIPT, opdracht], { env: { PATH: process.env.PATH, HOMEY_DIR: dir, HOMEY_BASIS: process.env.HOMEY_BASIS, HOMEY_PAUZE_MS: '0' } });
        let o = ''; p.stdout.on('data', function (c) { o += c; });
        p.on('close', function (code) { let j = null; try { j = JSON.parse(o.trim().split('\n').pop()); } catch (e) {} resolve({ code: code, j: j }); });
        p.stdin.end(JSON.stringify(invoer || {}));
      });
    },
  };
}
function map() { return fs.mkdtempSync(path.join(os.tmpdir(), 'homey-proef-')); }

test('poort: alleen POST op token en MCP met leesmethoden', function () {
  const H = laad(), b = process.env.HOMEY_BASIS;
  assert.ok(H.verzoekToets('POST', b + '/oauth2/token'));
  assert.ok(H.verzoekToets('POST', b + '/', { jsonrpc: '2.0', method: 'tools/list', id: 1 }));
  // wv3462: tools/call alleen met de vaste leeslijst en precies de argumentvorm
  const roep = function (params) { return H.verzoekToets('POST', b + '/', { jsonrpc: '2.0', method: 'tools/call', id: 1, params: params }); };
  assert.ok(roep({ name: 'list_devices', arguments: {} }));
  assert.ok(roep({ name: 'get_insights_log_entries_number', arguments: { logId: 'homey:device:' + DONGLE + ':measure_current.phase2', resolution: 'lastHour' } }));
  assert.ok(roep({ name: 'get_insights_log_entries_number', arguments: { logId: 'homey:device:' + LAADPAAL + ':energy_power', resolution: 'lastHour' } }));
  for (const p of [undefined, null, [], { name: 'list_devices' }, { name: 'list_devices', arguments: { homeyId: 'x' } }, { name: 'list_devices', arguments: {}, extra: 1 },
    { name: 'set_devices_capabilities_values', arguments: {} }, { name: 'start_flow', arguments: {} }, { name: 'set_mood', arguments: {} }, { name: 'list_flows', arguments: {} },
    { name: 'get_insights_log_entries_number', arguments: { logId: 'homey:device:' + DONGLE + ':onoff', resolution: 'lastHour' } },
    { name: 'get_insights_log_entries_number', arguments: { logId: 'homey:device:' + DONGLE + ':measure_current.phase1', resolution: 'last2Years' } },
    { name: 'get_insights_log_entries_number', arguments: { logId: 'homey:device:' + DONGLE + ':measure_current.phase1', resolution: 'lastHour', homeyId: 'x' } },
    { name: 'get_insights_log_entries_number', arguments: { logId: 'homey:app:com.tibber:x', resolution: 'lastHour' } }]) {
    assert.throws(function () { roep(p); }, /niet toegestaan/, JSON.stringify(p));
  }
  for (const m of ['resources/read', 'prompts/get', 'initialize ']) assert.throws(function () { H.verzoekToets('POST', b + '/', { jsonrpc: '2.0', method: m, id: 1 }); }, /niet toegestaan/);
  assert.throws(function () { H.verzoekToets('POST', b + '/', [{ jsonrpc: '2.0', method: 'tools/list', id: 1 }]); }, /niet toegestaan/);
  assert.throws(function () { H.verzoekToets('GET', b + '/oauth2/token'); }, /niet toegestaan/);
  assert.throws(function () { H.verzoekToets('POST', b + '/oauth2/client'); }, /niet toegestaan/);
  assert.throws(function () { H.verzoekToets('POST', b + '/?x=1', { jsonrpc: '2.0', method: 'tools/list', id: 1 }); }, /niet toegestaan/);
  assert.throws(function () { H.verzoekToets('POST', 'https://api.athom.com/', { jsonrpc: '2.0', method: 'tools/list', id: 1 }); }, /niet toegestaan/);
  assert.throws(function () { H.verzoekToets('POST', b + '/oauth2/token', { jsonrpc: '2.0', method: 'tools/list' }); }, /geen JSON-RPC/);
});

test('rpcUit leest SSE en JSON, kiest het juiste id', function () {
  const H = laad();
  assert.deepStrictEqual(H.rpcUit('data: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\n', 'text/event-stream', 1).result, { a: 1 });
  assert.strictEqual(H.rpcUit('data: {"jsonrpc":"2.0","id":2,"result":{}}\n\n', 'text/event-stream', 1), null);
  assert.deepStrictEqual(H.rpcUit('{"jsonrpc":"2.0","id":3,"result":{"b":2}}', 'application/json', 3).result, { b: 2 });
});

test('link + state eenmalig; inlog zet refresh in de kluis; ronde meet de toollijst met rotatie', async function () {
  const H = laad(), dir = map(), kluis = {};
  const l = H.linkMaak(dir, ID);
  const u = new URL(l.url);
  assert.strictEqual(u.origin + u.pathname, 'https://mcp.athom.com/oauth2/authorise');
  assert.strictEqual(u.searchParams.get('redirect_uri'), 'https://bank.socev.dev/homey/terug');
  assert.strictEqual(u.searchParams.get('response_mode'), 'form_post');
  const state = u.searchParams.get('state');
  assert.match(state, /^[0-9a-f]{64}$/);
  assert.ok(!fs.readFileSync(path.join(dir, 'states.json'), 'utf8').includes(state), 'state alleen als sha256 bewaard');
  assert.strictEqual((fs.statSync(dir).mode & 0o777), 0o700);
  assert.ok(H.stateOpen(dir, state));
  assert.ok(!H.stateOpen(dir, 'b'.repeat(64)));
  const t = await H.terug(kindDeps(dir, kluis), state, 'proefcode-1', '');
  assert.strictEqual(t.soort, 'gekoppeld', JSON.stringify(t));
  assert.match(kluis.refresh, /^refresh-/);
  assert.ok(!H.noodLees(dir), 'noodkopie weg na kluis');
  const t2 = await H.terug(kindDeps(dir, kluis), state, 'proefcode-1', '');
  assert.strictEqual(t2.soort, 'dicht', 'state is eenmalig');
  const oud = kluis.refresh;
  gezien = [];
  const r = await H.ronde(kindDeps(dir, kluis));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.tools, 2); assert.strictEqual(r.alleen_lezen, 1); assert.strictEqual(r.geroteerd, true);
  assert.notStrictEqual(kluis.refresh, oud);
  const methoden = gezien.filter(function (g) { return g.pad === '/'; }).map(function (g) { return JSON.parse(g.body).method; });
  assert.deepStrictEqual(methoden, ['initialize', 'notifications/initialized', 'tools/list']);
  assert.strictEqual(gezien.filter(function (g) { return g.pad === '/'; })[2].sessie, 'sessie-proef-1', 'sessie-id doorgegeven');
  const tl = JSON.parse(fs.readFileSync(path.join(dir, 'tools.json'), 'utf8'));
  assert.deepStrictEqual(tl.lijst.map(function (x) { return x.naam; }), ['list_devices', 'set_capability']);
  assert.ok(!JSON.stringify(tl).includes('<script>'));
  assert.ok(!JSON.stringify(tl).includes('access-') && !JSON.stringify(tl).includes('refresh-'), 'geen tokens in tools.json');
});

test('slot: leeg vers slotbestand wordt niet overgenomen, een oud wel', function () {
  const H = laad(), dir = map();
  fs.writeFileSync(path.join(dir, 'ronde.lock'), '');
  assert.strictEqual(H.slotNeem(dir), false);
  const oud = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(path.join(dir, 'ronde.lock'), oud, oud);
  assert.strictEqual(H.slotNeem(dir), true);
  H.slotLos(dir);
});

test('dood token: één keer vragen, daarna niets meer', async function () {
  const H = laad(), dir = map(), kluis = { refresh: 'refresh-onbekend-0000000000' };
  const r = await H.ronde(kindDeps(dir, kluis));
  assert.strictEqual(r.reden, 'grant');
  gezien = [];
  const r2 = await H.ronde(kindDeps(dir, kluis));
  assert.strictEqual(r2.reden, 'dood');
  assert.strictEqual(gezien.length, 0);
});

test('kluisfout na verversen: noodkopie blijft, volgende ronde zet hem eerst in de kluis', async function () {
  const H = laad(), dir = map(), start = 'refresh-start-' + crypto.randomBytes(8).toString('hex');
  refreshGeldig.add(start);
  const kluis = { refresh: start, stuk: true };
  const r = await H.ronde(kindDeps(dir, kluis));
  assert.strictEqual(r.reden, 'kluis'); assert.strictEqual(r.nood, true);
  const nood = H.noodLees(dir);
  assert.ok(nood && nood.refresh !== start);
  kluis.stuk = false;
  const r2 = await H.ronde(kindDeps(dir, kluis));
  assert.strictEqual(r2.ok, true, JSON.stringify(r2)); assert.strictEqual(r2.nood_hersteld, true);
  assert.ok(!H.noodLees(dir));
});

test('foute client: geen tokens, reden client', async function () {
  const H = laad(), dir = map(), kluis = { refresh: 'refresh-x-00000000000000' };
  const d = kindDeps(dir, kluis);
  d.kluisLees = async function () { return { client_id: ID, client_secret: 'fout-geheim-000000', refresh: kluis.refresh }; };
  const r = await H.ronde(d);
  assert.strictEqual(r.reden, 'client');
});

test('lees: dongle + laadpaal per minuut, gat bij -32602, geen namen opgeslagen, dagtabel', async function () {
  const H = laad(), dir = map(), start = 'refresh-lees-' + crypto.randomBytes(8).toString('hex');
  refreshGeldig.add(start);
  const kluis = { refresh: start };
  gezien = [];
  const r = await H.ronde(kindDeps(dir, kluis), 'lees');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.gaten, ['w3']);
  assert.strictEqual(r.laden, true);
  const calls = gezien.filter(function (g) { return g.pad === '/'; }).map(function (g) { return JSON.parse(g.body); }).filter(function (m) { return m.method === 'tools/call'; });
  assert.deepStrictEqual(calls.map(function (m) { return m.params.name; }), ['list_devices'].concat(Array(7).fill('get_insights_log_entries_number')));
  const j = H.metingLees(dir, '2026-11-20');
  assert.ok(j, 'meting van 20-11 (06:00 NL)');
  assert.deepStrictEqual(j.m['06:00'], [22, 2, 2, 600, 600, null, null, 7000]);
  assert.deepStrictEqual(j.m['06:01'], [26, 3, 3, 700, 700, null, null, 7100]);
  const ruw = fs.readdirSync(path.join(dir, 'meting')).map(function (f) { return fs.readFileSync(path.join(dir, 'meting', f), 'utf8'); }).join('');
  for (const n of ['Proefkind', 'Proefdongle', 'Proefstraat', 'Proeflader', 'Kamer', 'access-', 'refresh-']) assert.ok(!ruw.includes(n), 'geen ' + n + ' in de opslag');
  assert.strictEqual((fs.statSync(path.join(dir, 'meting')).mode & 0o777), 0o700);
  const s = H.dagSamenvat(j);
  assert.deepStrictEqual(s.max_a, [26, 3, 3]); assert.deepStrictEqual(s.boven_20, [2, 0, 0]); assert.deepStrictEqual(s.boven_25, [1, 0, 0]);
  assert.strictEqual(s.laad_min, 2);
  const blok = H.vaultBlok(dir, '2026-11-20T06:00:00.000Z');
  assert.match(blok, /\| 20-11 \(t\/m 06:01\) \| 0,0 u \| 26 \/ 3 \/ 3 \(L1 om 06:01\) \| 2 \/ 0 \/ 0 \| 1 \/ 0 \/ 0 \|/);
  const p1 = H.blokZet('# Pagina\n\ntekst\n', blok);
  assert.strictEqual(H.blokZet(p1, blok), p1, 'tweede keer gelijk');
  assert.strictEqual(p1.split('<!-- homey-fase:begin -->').length, 2);
  assert.strictEqual(H.blokZet(p1 + '\n<!-- homey-fase:begin -->\n', blok), null, 'dubbel blok: niet raden');
  // een andere MCP-fout dan -32602 laat de ronde falen (review ZOU 1)
  fout32603 = true;
  const rf = await H.ronde(kindDeps(dir, kluis), 'lees');
  fout32603 = false;
  assert.strictEqual(rf.ok, false); assert.strictEqual(rf.reden, 'mcp');
  // tweede ronde vloeit samen (zelfde minuten, geen dubbele tellingen)
  const r2 = await H.ronde(kindDeps(dir, kluis), 'lees');
  assert.strictEqual(r2.minuten, 0);
  assert.strictEqual(H.metingLees(dir, '2026-11-20').standen.length, 2, 'mislukte ronde schrijft geen stand');
  // wv3482: het gekozen dongle-id staat vast (alleen het id)
  assert.strictEqual(H.vastLees(dir), DONGLE);
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'dongle.json'), 'utf8'))).sort(), ['id', 'sinds']);
});

test('wv3482: dongle eist afnamestand; vast id blijft zolang het bestaat', function () {
  const H = laad();
  const fase = { 'measure_current.phase1': 5, 'measure_current.phase2': 5, 'measure_current.phase3': 5, 'measure_power.phase1': 1100, 'measure_power.phase2': 1100, 'measure_power.phase3': 1100 };
  const LADER3 = '22222222-2222-4222-8222-222222222222', ANDER = '33333333-3333-4333-8333-333333333333';
  const devs = [{ id: LADER3, type: 'other', state: Object.assign({ measure_power: 3300 }, fase) },
    { id: DONGLE, type: 'sensor', state: Object.assign({ 'meter_power.imported': 1000, 'meter_power.imported_today': 4.2 }, fase) },
    { id: ANDER, type: 'sensor', state: Object.assign({ 'meter_power.imported': 5 }, fase) }];
  const k1 = H.apparatenKies(devs, null);
  assert.strictEqual(k1.dongle, DONGLE, '3-fase lader zonder afnamestand telt niet als aansluiting');
  assert.strictEqual(k1.vast, false);
  assert.strictEqual(k1.stand.import_vandaag_kwh, 4.2);
  const k2 = H.apparatenKies(devs, ANDER);
  assert.strictEqual(k2.dongle, ANDER, 'vast id wint zolang het in de lijst staat'); assert.strictEqual(k2.vast, true);
  const k3 = H.apparatenKies([{ id: ANDER, type: 'sensor' }].concat(devs.slice(0, 2)), ANDER);
  assert.strictEqual(k3.dongle, ANDER, 'ook zonder state'); assert.strictEqual(k3.stand.import_kwh, null);
  assert.strictEqual(H.apparatenKies(devs.slice(0, 2), ANDER).dongle, DONGLE, 'vast id weg → opnieuw kiezen');
  assert.strictEqual(H.apparatenKies(devs.slice(0, 1), null).dongle, null);
});

test('wv3482: teruglevering verbergt geen piek; kWh uit de dagteller', function () {
  const H = laad();
  assert.strictEqual(H.grootst(1, -22), -22); assert.strictEqual(H.grootst(-22, 1), -22); assert.strictEqual(H.grootst(null, -3), -3); assert.strictEqual(H.grootst(4, -4), 4);
  const t0 = '2026-11-20T11:00:00.000Z', t1 = '2026-11-20T11:00:05.000Z';
  const pm = H.perMinuut({ a1: [{ t: t0, v: 1 }, { t: t1, v: -22 }], a2: [{ t: t0, v: 3 }, { t: t1, v: 2 }], a3: [{ t: t0, v: 0 }, { t: t1, v: 0 }],
    w1: [{ t: t0, v: 200 }, { t: t1, v: -5000 }], w2: [{ t: t0, v: 700 }, { t: t1, v: 600 }], w3: [{ t: t0, v: 100 }, { t: t1, v: 100 }], ev: [{ t: t0, v: -1 }, { t: t1, v: 0 }] });
  const r = pm['2026-11-20']['12:00'];
  assert.deepStrictEqual(r.slice(0, 6), [-22, 3, 0, -5000, 700, 100]);
  assert.strictEqual(r[6], 1000, 'Wtotaal blijft de hoogste som'); assert.strictEqual(r[7], 0, 'laadpaal blijft de hoogste');
  const s = H.dagSamenvat({ dag: '2026-11-20', m: { '12:00': r, '12:01': [26, 1, 1, null, null, null, null, null], '12:02': [-27, 1, 1, null, null, null, null, null] },
    standen: [{ t: '2026-11-20T00:10:00Z', import_kwh: 100, import_vandaag_kwh: 0.2 }, { t: '2026-11-20T22:10:00Z', import_kwh: 112, import_vandaag_kwh: 12.04 }, { t: '2026-11-20T22:30:00Z', import_kwh: 112.3 }] });
  assert.deepStrictEqual(s.max_a, [-27, 3, 1]); assert.strictEqual(s.max_a_om[0], '12:02');
  assert.deepStrictEqual(s.boven_20, [3, 0, 0]); assert.deepStrictEqual(s.boven_25, [2, 0, 0]);
  assert.strictEqual(s.kwh, 12, 'laatste dagteller, niet laatste − eerste (11,8 of 12,3)');
  assert.strictEqual(H.dagSamenvat({ dag: '2026-11-20', m: {}, standen: [{ import_kwh: 1 }, { import_kwh: 5 }] }).kwh, null, 'zonder dagteller geen schatting');
});
