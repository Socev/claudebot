#!/usr/bin/env bash
# Toetst de bunq-kant van de bankluis in server.js (wv683, 20-10-2026): bankSmal/bankKind/bankBoxRij uit server.js in een
# vm-context met de echte bank-lezer.js en bunq-lezer.js tegen een nagebootste, ondertekenende bunq-API.
# Toetst: kluis vraagt ook bunq_api_key; sleutel en sessietoken nooit in de uitvoer naar de sessie; het token blijft in het
# geheugen van de pod en wordt hergebruikt (geen tweede session-server); _-velden eruit; box-rij in de vault bij geweigerde
# toegang (1×/dag); historie alleen met API_SECRET en sessie bunq; rekeningen werkt ook als de kluis weg is.
# Raakt de pod, de kluis, de echte vault en /opt/data/bank niet. Gebruik: bash test/bunq-poort.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings --require ./test/vaste-klok.cjs - <<'JS'   # wv1225: TOETS_NU=<ISO> = vast moment
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), http = require('http'), vm = require('vm');
const { spawn } = require('child_process');
// wv1225: TOETS_NU=<ISO> draait de toets én elk bank-lezer.js-kind (ook via smalKind in server.js) op dezelfde vaste klok
// (test/vaste-klok.cjs); zonder TOETS_NU doet klokSpawn precies wat spawn doet.
const KLOK = path.resolve('test/vaste-klok.cjs');
function klokSpawn(cmd, args, o) {
  if (!process.env.TOETS_KLOK_DELTA || cmd !== process.execPath) return spawn(cmd, args, o);
  const env = o && o.env ? Object.assign({}, o.env, { TOETS_KLOK_DELTA: process.env.TOETS_KLOK_DELTA }) : undefined;
  return spawn(cmd, ['--require', KLOK].concat(args), Object.assign({}, o, env ? { env: env } : {}));
}
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'bunqpoort-'));
const BD = path.join(W, 'bank');
fs.mkdirSync(path.join(BD, 'bunq'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(W, '00_Systeem', 'Meldingen'), { recursive: true });
const BOX = path.join(W, '00_Systeem', 'Meldingen', 'machinekamer.md');
fs.writeFileSync(BOX, '---\ntype: meldingenbus\n---\n\n# Meldingen\n\n**Formaat** (nieuwste bovenaan)\n\n## [week] 2026-10-20 22:06 — oude rij\n- status: open\n');
const client = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }), server = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const UID = 77, SLEUTEL = 'B'.repeat(64);
fs.writeFileSync(path.join(BD, 'bunq', 'staat.json'), JSON.stringify({ private_key_pem: client.privateKey.export({ type: 'pkcs8', format: 'pem' }), installation_token: 'i'.repeat(64),
  server_public_key: server.publicKey.export({ type: 'spki', format: 'pem' }), user_id: UID }), { mode: 0o600 });
const M = { sessies: 0, posts: 0, ipFout: false };
const api = http.createServer(function (req, res) {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', function () {
    const u = new URL(req.url, 'http://x');
    const stuur = (st, j) => { const t = JSON.stringify(j); res.writeHead(st, { 'Content-Type': 'application/json',
      'X-Bunq-Server-Signature': crypto.sign('RSA-SHA256', Buffer.from(t), { key: server.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64') }); res.end(t); };
    if (req.method === 'POST' && u.pathname === '/v1/session-server') {
      M.posts++;
      if (M.ipFout || JSON.parse(body).secret !== SLEUTEL) return stuur(400, { Error: [{ error_description: 'Incorrect API key or IP address.' }] });
      M.sessies++; return stuur(200, { Response: [{ Token: { token: 'tok' + M.sessies + 'x'.repeat(60) } }, { UserPerson: { id: UID, session_timeout: 604800 } }] });
    }
    if (!/^tok\d+x+$/.test(req.headers['x-bunq-client-authentication'] || '')) return stuur(401, {});
    if (u.pathname === '/v1/user/77/monetary-account') return stuur(200, { Response: [{ MonetaryAccountBank: { id: 1, status: 'ACTIVE', description: 'Privé', currency: 'EUR',
      balance: { value: '12.34', currency: 'EUR' }, alias: [{ type: 'IBAN', value: 'NL11BUNQ0000000001' }] } }], Pagination: { older_url: null } });
    if (u.pathname === '/v1/user/77/monetary-account/1/payment') return stuur(200, { Response: [{ Payment: { id: 5, created: new Date().toISOString().replace('T', ' ').replace('Z', ''),
      amount: { value: '-3.00', currency: 'EUR' }, description: 'koffie', counterparty_alias: { display_name: 'Café', iban: 'NL99RABO0123456789' } } }], Pagination: { older_url: null } });
    stuur(404, {});
  });
});
const src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf('// ── wv680: bankluis'), b = src.indexOf('// ── einde bankluis ──');
const k1 = src.indexOf('function smalKind('), k2 = src.indexOf('async function smalSbRpc(');
const SECRET = 's'.repeat(40);
const logs = [];
let kluisQuery = '', kluisWeg = false;
api.listen(0, '127.0.0.1', async function () {
  const env = { PATH: process.env.PATH, HOME: W, TZ: 'Europe/Amsterdam', BANK_DIR: BD, BUNQ_API_BASIS: 'http://127.0.0.1:' + api.address().port, BUNQ_PAUZE_MS: '0',
    SUPABASE_URL: 'https://abcdef.supabase.co', SUPABASE_MCP_TOKEN: 'pat-geheim' };
  const g = { VV: () => require(require('path').resolve('vault-veilig.js')), require, fs, path, crypto, Buffer, console, URL, setTimeout, clearTimeout, AbortSignal, Promise, JSON, Date, spawn: klokSpawn, VAULT: W, SECRET: SECRET,
    __dirname: process.cwd(), process: { env: env, execPath: process.execPath },
    fetch: async function (url, o) {
      if (kluisWeg) throw new Error('netwerk weg');
      kluisQuery = JSON.parse(o.body).query;
      return { ok: true, json: async () => [{ name: 'bunq_api_key', w: SLEUTEL }] };   // geen Enable Banking-sleutels: bunq werkt los daarvan
    },
    logError: (w, e) => logs.push(w + ': ' + (e && e.message || e)), schrijfLog: (r) => logs.push(r), nu: () => 'NU', velden: (o) => JSON.stringify(o),
    reqPath: (req) => (req.url || '').split('?')[0], rol: { eerste: true }, rolPrimair: () => true, rolEerste: Promise.resolve(), ROL_START_WACHT_MS: 50 };
  const ctx = vm.createContext(g);
  vm.runInContext(src.slice(k1, k2) + '\n' + src.slice(a, b) + '\n;globalThis.__h = { bankSmal, bankEnv, sessie: () => bunqSessie };', ctx, { filename: 'server.js#bank' });
  const h = ctx.__h;
  try {
    toets('bankEnv geeft BUNQ_API_BASIS door (alleen toets), geen PAT', h.bankEnv().BUNQ_API_BASIS && !h.bankEnv().SUPABASE_MCP_TOKEN, Object.keys(h.bankEnv()));
    let r = await h.bankSmal({ secret: 'socev', opdracht: 'saldo' });
    toets('kluisvraag bevat bunq_api_key', /'bunq_api_key'/.test(kluisQuery), kluisQuery);
    toets('saldo via de poort: bunq-rekening zonder Enable Banking-sleutel', r.status === 200 && r.j.ok && r.j.saldi.length === 1 && r.j.saldi[0].geboekt === 12.34 && /geen opdracht/.test(r.j.let_op_bron), r.j);
    const uit1 = JSON.stringify(r.j);
    toets('geen _-velden, sleutel of token in de uitvoer naar de sessie', !/"_/.test(uit1) && uit1.indexOf(SLEUTEL) < 0 && uit1.indexOf('tok1') < 0, uit1.slice(0, 300));
    toets('sessietoken staat in het geheugen van de pod', h.sessie() && /^tok1/.test(h.sessie().token), h.sessie());
    r = await h.bankSmal({ secret: 'socev', opdracht: 'transacties', rekening: 'Privé', vers: true });
    toets('transacties met de bewaarde sessie: geen tweede session-server', r.j.ok && r.j.aantal === 1 && M.posts === 1, [r.j, M.posts]);
    r = await h.bankSmal({ secret: 'socev', opdracht: 'historie', sessie: 'bunq' });
    toets('historie met de Socev-sleutel: 403', r.status === 403, r);
    r = await h.bankSmal({ secret: SECRET, opdracht: 'historie', sessie: 'abc12345' });
    toets('historie met API_SECRET maar niet bunq: 403', r.status === 403, r);
    r = await h.bankSmal({ secret: SECRET, opdracht: 'historie', sessie: 'bunq' });
    toets('historie bunq met API_SECRET: ok', r.status === 200 && r.j.ok && r.j.rekeningen.length === 1, r.j);

    // IP gewijzigd: sessie weg in het geheugen, box-rij één keer
    vm.runInContext('bunqSessie = null', ctx);
    M.ipFout = true;
    const st = JSON.parse(fs.readFileSync(path.join(BD, 'stand.json'), 'utf8')); st.bunq.lijst = '2020-01-01T00:00:00Z'; st.tellers = { dag: '', per: {} }; fs.writeFileSync(path.join(BD, 'stand.json'), JSON.stringify(st));
    r = await h.bankSmal({ secret: 'socev', opdracht: 'saldo', vers: true });
    toets('IP geweigerd: tekst "thuis-IP gewijzigd" naar de sessie', r.j.ok && /thuis-IP gewijzigd/.test(r.j.saldi[0].let_op || ''), r.j);
    let box = fs.readFileSync(BOX, 'utf8');
    toets('box-rij bovenaan, met status open en voorstel', /\*\*Formaat\*\* \(nieuwste bovenaan\)\n\n## \[direct\] .* bunq-leesroute geweigerd: thuis-IP gewijzigd/.test(box) && /- status: open\n/.test(box) && /activeer\.py/.test(box) && /oude rij/.test(box), box.slice(0, 600));
    r = await h.bankSmal({ secret: 'socev', opdracht: 'saldo', vers: true });
    box = fs.readFileSync(BOX, 'utf8');
    toets('tweede weigering dezelfde dag: geen tweede box-rij', (box.match(/bunq-leesroute geweigerd/g) || []).length === 1, null);
    toets('geen sessie meer in het geheugen', h.sessie() === null, h.sessie());
    M.ipFout = false;

    kluisWeg = true; vm.runInContext('bankSleutelCache = null', ctx);
    r = await h.bankSmal({ secret: 'socev', opdracht: 'rekeningen' });
    toets('rekeningen werkt ook als de kluis weg is (bekende lijst)', r.j.ok && r.j.rekeningen.length === 1, r.j);
    r = await h.bankSmal({ secret: 'socev', opdracht: 'saldo' });
    toets('saldo zonder kluis: storing, geen kindproces', r.j.ok === false && r.j.reden === 'storing', r.j);
    toets('geen sleutel of token in de logregels', logs.join('\n').indexOf(SLEUTEL) < 0 && !/tok\d+x/.test(logs.join('\n')), logs);
  } catch (err) { fouten++; console.log('ROOD  uitzondering: ' + (err && err.stack || err)); }
  api.close(); fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
});
JS
