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
  for (const m of ['tools/call', 'resources/read', 'prompts/get', 'initialize ']) assert.throws(function () { H.verzoekToets('POST', b + '/', { jsonrpc: '2.0', method: m, id: 1 }); }, /niet toegestaan/);
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
