#!/usr/bin/env bash
# Toetst de telefoon-poort (/tel/*, server.js handleTel, wv264 9-10-2026) en de app-routes ⚙ → Telefoon zonder de pod te
# starten: het app-blok (met het tel-blok erin) wordt uit server.js geknipt en in een vm-context achter een eigen
# http-server gedraaid (zoals test/socev-app-poort.sh). Access, Whisper, Gemini, Telegram en n8n zijn nagebootst; sessies
# en apparaten worden rechtstreeks gezet (de passkey-route zelf toetst socev-app-poort.sh). Klokken verkort via
# tekstvervanging. Daarna een echte SIGTERM op een kindproces: een open lange vraag krijgt een leeg antwoord en het kind
# sterft aan SIGTERM. Raakt de echte pod, Cloudflare en Telegram niet.
# Gebruik: bash test/tel-poort.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http'), os = require('os'), crypto = require('crypto');
const src = fs.readFileSync('server.js', 'utf8');
const a0 = src.indexOf('// ── Socev-app poort'), b0 = src.indexOf('// ── einde socev-app poort');
if (a0 < 0 || b0 < 0) { console.log('ROOD: blok niet gevonden'); process.exit(1); }
let blok = src.slice(a0, b0);
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra !== undefined && !ok ? '  [' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) + ']' : '')); }
for (const [x, y] of [['const TEL_LEASE_MS = 3 * 60 * 1000;', 'const TEL_LEASE_MS = 1500;'],
                      ['const TEL_BEURTEN_PER_UUR = 30;', 'const TEL_BEURTEN_PER_UUR = 12;'],
                      ['const TEL_KOPPEL_PER_UUR = 10;', 'const TEL_KOPPEL_PER_UUR = 20;'],
                      ['const TEL_CODES_PER_DAG = 10;', 'const TEL_CODES_PER_DAG = 12;'],
                      ['const TEL_ZELF_HERHAAL_MS = 4 * 60 * 1000;', 'const TEL_ZELF_HERHAAL_MS = 1200;'],
                      ['const TEL_ZELF_AANKONDIG_MS = 20 * 1000;', 'const TEL_ZELF_AANKONDIG_MS = 400;'],
                      // wv3826: te-lezen.js laden in de vm (geen __dirname daar); de toets draait in de repo-wortel
                      ["if (typeof __dirname !== 'string') return null; return require(path.join(__dirname, 'te-lezen.js'));", "return require(path.resolve('te-lezen.js'));"],
                      // wv4016: briefing-punten.js laden in de vm (autovragen, gesprek)
                      ["const BP = (function () { try { return require(path.join(__dirname, 'briefing-punten.js'));", "const BP = (function () { try { return require(path.resolve('briefing-punten.js'));"]]) {
  if (blok.indexOf(x) < 0) toets('vervanging gevonden: ' + x, false); blok = blok.split(x).join(y);
}
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'teltoets-'));
const DATA = path.join(W, 'data'); fs.mkdirSync(path.join(DATA, 'geheim'), { recursive: true, mode: 0o700 });
const UIT = path.join(W, 'app-uit'), TELUIT = path.join(W, 'tel-uit');
const TEAM = 'https://huisdokter.cloudflareaccess.com', AUD = 'a'.repeat(64), CLIENT = 'proefclient.access', POORT = 'p'.repeat(64);
const TAUD = 'b'.repeat(64), TCLIENT = 'taskerclient.access', TGEHEIM = 'g'.repeat(64);
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ access_team: TEAM, access_aud: AUD, servicetoken_client_id: CLIENT }));
fs.writeFileSync(path.join(DATA, 'tel-config.json'), JSON.stringify({ access_team: TEAM, access_aud: TAUD, servicetoken_client_id: TCLIENT }));
fs.writeFileSync(path.join(DATA, 'geheim', 'tel-servicetoken.json'), JSON.stringify({ client_id: TCLIENT, client_secret: TGEHEIM }), { mode: 0o600 });
const LOGDIR = path.join(W, 'app-log');
// nagebootste apparaten in de app: de Pixel (goedkeurder) en een laptop
const PIXEL = '1111222233334444', LAPTOP = '5555666677778888';
const ck = { [PIXEL]: crypto.randomBytes(32).toString('hex'), [LAPTOP]: crypto.randomBytes(32).toString('hex') };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
fs.writeFileSync(path.join(DATA, 'apparaten.json'), JSON.stringify({ versie: 1, ooit_gekoppeld: true, apparaten: [
  { id: PIXEL, naam: 'Pixel', systeem: 'Chrome op Android', actief: true, goedkeurder: true, soort: 'reist', cookie_hash: sha(ck[PIXEL]), credential: { id: 'credP' } },
  { id: LAPTOP, naam: 'Laptop', systeem: 'Chrome op Windows', actief: true, soort: 'reist', cookie_hash: sha(ck[LAPTOP]), credential: { id: 'credL' } }] }));

// Whisper/Gemini/Access/Telegram/n8n nagebootst
const st = { stt: [], sttTekst: 'Wat staat er morgen in mijn agenda', sttStatus: 200, tts: [], telegram: [], chatlog: [] };
function wavMaak(sec, rate) {
  rate = rate || 16000; const n = Math.round(sec * rate), h = Buffer.alloc(44), d = Buffer.alloc(n * 2);
  h.write('RIFF', 0); h.writeUInt32LE(36 + n * 2, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(n * 2, 40);
  return Buffer.concat([h, d]);
}
// minimale MPEG4 (ftyp + moov/mvhd + mdat) zoals Android MediaRecorder hem maakt; duur in seconden
function mp4Maak(sec, extra) {
  const box = (t, b) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + b.length, 0); h.write(t, 4, 'ascii'); return Buffer.concat([h, b]); };
  const mv = Buffer.alloc(100); mv.writeUInt32BE(0, 0); mv.writeUInt32BE(1000, 12); mv.writeUInt32BE(Math.round(sec * 1000), 16);
  return Buffer.concat([box('ftyp', Buffer.from('mp42\0\0\0\0isommp42')), box('mdat', Buffer.alloc(extra || 2000, 7)), box('moov', box('mvhd', mv))]);
}
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'proef', alg: 'RS256' });
function jwt(over) {
  const nu = Math.floor(Date.now() / 1000);
  const k = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'proef', typ: 'JWT' })).toString('base64url');
  const i = Buffer.from(JSON.stringify(Object.assign({ aud: [TAUD], iss: TEAM, common_name: TCLIENT, type: 'app', sub: '', iat: nu, exp: nu + 600 }, over || {}))).toString('base64url');
  return k + '.' + i + '.' + crypto.sign('RSA-SHA256', Buffer.from(k + '.' + i), privateKey).toString('base64url');
}
async function nepFetch(url, opt) {
  url = String(url); (st.urls = st.urls || []).push(url);   // wv3771: welke diensten er geraakt werden
  const antw = (status, j, kop) => ({ ok: status < 300, status, json: async () => j, text: async () => JSON.stringify(j), headers: { get: (n) => (kop || {})[String(n).toLowerCase()] || null } });
  if (/whisper-large-v3-turbo$/.test(url)) {
    st.stt.push(JSON.parse(opt.body));
    if (st.sttStatus !== 200) return antw(st.sttStatus, { success: false });
    return antw(200, { success: true, result: { text: ' ' + st.sttTekst + ' ' } });
  }
  if (url === 'https://generativelanguage.googleapis.com/v1beta/interactions') {
    const b = JSON.parse(opt.body); st.tts.push(b.input[0].content[0].text);
    if (st.ttsTraag) await new Promise((r) => setTimeout(r, st.ttsTraag));
    return antw(200, { usage: { total_input_tokens: 7, total_output_tokens: 8 }, steps: [{ content: [{ type: 'audio', data: wavMaak(0.3, 24000).toString('base64') }] }] });
  }
  if (url === TEAM + '/cdn-cgi/access/certs') return antw(200, { keys: [jwk] }, { date: new Date().toUTCString() });
  if (url.startsWith('https://api.telegram.org/')) { st.telegram.push(JSON.parse(opt.body).text); return antw(200, { ok: true }); }
  if (url.indexOf('/api/v1/data-tables/47QYtj7WHyQXewJ4/rows') >= 0) {
    if (opt.method === 'POST') { st.chatlog.push(...JSON.parse(opt.body).data); return antw(200, { success: true }); }
    return antw(200, true);
  }
  return antw(404, {});
}
const logs = [];
const jobs = {}, ketens = {}, gestart = [], afmaken = {};
function enqueue(key, fn) { const prev = ketens[key] || Promise.resolve(); const next = prev.then(fn, fn).catch(() => {}); ketens[key] = next; return next; }
function processJob(jobId, prompt, sess, files, chatId) {
  const j = jobs[jobId]; j.status = 'running'; j.started = Date.now();
  gestart.push({ jobId, prompt, chatId });
  return new Promise((r) => { afmaken[jobId] = (uit, ok) => { j.status = 'done'; j.done_at = Date.now(); j.result = { ok: ok !== false, output: ok === false ? '' : uit, error: ok === false ? uit : undefined, files: [] }; r(); }; });
}
const rolStub = { eerste: 1, primair: true };
const ctxGlobals = () => ({ require, fs, path, crypto, Buffer, console, URL, setInterval, setTimeout, clearTimeout, AbortSignal, Promise, JSON, Date, URLSearchParams,
  process: { env: { APP_DATA_DIR: DATA, APP_UIT_BESTAND: UIT, TEL_UIT_BESTAND: TELUIT, TELEGRAM_DEBUG_BOT_TOKEN: 'nep', APP_POORT_SECRET: POORT, APP_LOG_DIR: LOGDIR,
    APP_BUS_PAD: path.join(W, 'bus.md'), SUPABASE_URL: 'https://sb.toets', SUPABASE_SERVICE_ROLE: 'nep', APP_BESTANDEN_DIR: path.join(W, 'bew'), APP_UPLOAD_DIR: path.join(W, 'upload'), IO_DIR: path.join(W, 'io'),
    N8N_MCP_URL: 'https://n8n.toets/mcp-server/http', N8N_API_KEY: 'nep-n8n', CLOUDFLARE_AI_TOKEN_AUTO: 'nep-cf', GEMINI_API_KEY_AUTO: 'nep-gemini', APP_VAULT_DIR: path.join(W, 'vault') }, pid: process.pid },
  VAULT: path.join(W, 'vault'), TOETSUUR: () => 12, agentsReg: {},
  jobs, enqueue, processJob, DEFAULT_WS: 'vault', sessionKey: (ws, c) => c, resolveKeuze: () => ({ runtime: 'claude', model: '' }),
  rol: rolStub, rolPrimair: () => rolStub.primair, rolEerste: Promise.resolve(), ROL_START_WACHT_MS: 100, ROL_KANT: 'olares', SPAARSTAND: false, SPAAR_STIL_TEKST: '',   // wv4017: zoals socev-app-poort (wv3909)
  fetch: nepFetch, SP_CHAT: '40687', logError: (w, e) => logs.push(w + ': ' + (e && e.message || JSON.stringify(e))),
  reqPath: (req) => { const u = req.url || ''; const i = u.indexOf('?'); return i === -1 ? u : u.slice(0, i); } });
const EXPORT = '\n;globalThis.__h = { handleApp, appIsPad, handleTel, telIsPad, telStaat, appStaat, appNoodstop, appAan, appOntmasker, telAfsluiten, telSpreektekst, telOpname, telInfo, appInfo, telOpruim, TEL_ROUTE_RE, telMerkAgent, telZelfStart, telZelfNaRun, telAanwezig, telBelletje, agentsReg, TEL_ZELF_AANKONDIGING, telOnderwegVelden, telVraagzin, appBriefingLaad, telRij, telRitLaad: typeof telRitLaad === "function" ? telRitLaad : function () { return { open: {}, ritten: [] }; }, telRitNu: typeof telRitNu === "function" ? telRitNu : function () { return {}; }, telRitten: typeof telRitten === "function" ? telRitten : function () { return []; }, __zet: function (n, f) { globalThis[n] = f; }, __haal: function (n) { return globalThis[n]; } };';
function laad() { const c = vm.createContext(ctxGlobals()); vm.runInContext(blok + EXPORT, c, { filename: 'server.js#app' }); return c.__h; }
let H = laad();
let srv = http.createServer((q, s) => { if (H.telIsPad(q)) return H.handleTel(q, s); if (H.appIsPad(q)) return H.handleApp(q, s); s.writeHead(418); s.end(); });
const wacht = (ms) => new Promise((r) => setTimeout(r, ms));

// sessies rechtstreeks zetten (de passkey-route toetst socev-app-poort.sh)
function sessie(apparaat, cred, vers) {
  const tok = crypto.randomBytes(32).toString('hex'), nu = Date.now();
  Object.keys(H.appStaat.sessies).forEach((h) => { if (H.appStaat.sessies[h].apparaat === apparaat) delete H.appStaat.sessies[h]; });
  H.appStaat.sessies[sha(tok)] = { apparaat, credential: cred, start: nu, vers_tot: vers ? nu + 60000 : 0, tot: nu + 3600000 };
  return tok;
}
function app(m, pad, body, o) {
  o = o || {};
  const koppen = { 'content-type': 'application/json', 'x-app-ua': o.ua || 'Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/141.0', 'x-app-poort': POORT,
    'cf-access-jwt-assertion': jwt({ aud: [AUD], common_name: CLIENT }), 'x-app-apparaat': o.apparaat + '.' + ck[o.apparaat], 'x-app-sessie': o.sessie };
  return verzoek(m, pad, koppen, body === undefined ? undefined : JSON.stringify(body));
}
function verzoek(m, pad, koppen, body, o) {
  o = o || {};
  return new Promise((ok) => {
    const r = http.request({ host: '127.0.0.1', port: srv.address().port, path: pad, method: m, headers: koppen, agent: false }, (res) => {
      const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => {
        const b = Buffer.concat(d); let j = {}; try { j = JSON.parse(b.toString('utf8')); } catch (e) { j = { raw: b.length }; }
        ok({ status: res.statusCode, j, b, ct: res.headers['content-type'] || '' });
      });
    });
    r.on('error', (e) => ok({ status: 0, j: { fout: e.code } }));
    if (body !== undefined) r.write(body);
    r.end();
  });
}
let SLEUTEL = null;
function tel(m, pad, o) {
  o = o || {};
  const koppen = {};
  if (o.jwt !== false) koppen['cf-access-jwt-assertion'] = o.jwt || jwt();
  if (o.sleutel !== false) koppen.authorization = 'Bearer ' + (o.sleutel || SLEUTEL);
  if (o.ct) koppen['content-type'] = o.ct;
  if (o.lengte !== undefined) koppen['content-length'] = String(o.lengte);
  else if (o.body !== undefined) koppen['content-length'] = String(Buffer.byteLength(o.body));
  return verzoek(m, pad, koppen, o.body);
}
function tik() { return wacht(30); }
const audit = () => { try { return fs.readFileSync(path.join(DATA, 'tel-audit.jsonl'), 'utf8'); } catch (e) { return ''; } };

srv.listen(0, '127.0.0.1', async () => {
  try {
    // ── 1. koppelen ──
    let r = await verzoek('POST', '/tel/koppel', {}, '12345678');
    toets('1 koppel zonder code in omloop: 401', r.status === 401, r);
    let sP = sessie(PIXEL, 'credP', false);
    r = await app('GET', '/app/tel', undefined, { apparaat: PIXEL, sessie: sP });
    toets('1 app-stand: ingericht, niet gekoppeld, mag koppelen', r.status === 200 && r.j.ingericht === true && r.j.gekoppeld === false && r.j.mag_koppelen === true, r.j);
    r = await app('POST', '/app/tel/koppelcode', {}, { apparaat: PIXEL, sessie: sP });
    toets('1 koppelcode zonder verse vingerafdruk: 403 vers_nodig', r.status === 403 && r.j.vers_nodig === true, r.j);
    const sL = sessie(LAPTOP, 'credL', true);
    r = await app('POST', '/app/tel/koppelcode', {}, { apparaat: LAPTOP, sessie: sL, ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/141.0' });
    toets('1 koppelcode op de laptop: 403 (alleen de Pixel)', r.status === 403 && /Pixel/.test(r.j.fout), r.j);
    sP = sessie(PIXEL, 'credP', true);
    r = await app('POST', '/app/tel/koppelcode', {}, { apparaat: PIXEL, sessie: sP, ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/141.0' });
    toets('1 koppelcode op de Pixel met desktop-UA: 403', r.status === 403, r.j);
    r = await app('POST', '/app/tel/koppelcode', {}, { apparaat: PIXEL, sessie: sP });
    toets('1 koppelcode met verse vingerafdruk: 8 cijfers', r.status === 200 && /^\d{8}$/.test(r.j.code) && r.j.geldig_s === 120, r.j);
    let code = r.j.code;
    r = await app('POST', '/app/tel/koppelcode', {}, { apparaat: PIXEL, sessie: sP });
    toets('1 vingerafdruk verbruikt: tweede code vraagt opnieuw', r.status === 403 && r.j.vers_nodig === true, r.j);
    toets('1 auditlog app noemt de code niet', !fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8').includes(code));
    const fout = code === '00000000' ? '00000001' : '00000000';
    for (let i = 0; i < 4; i++) await verzoek('POST', '/tel/koppel', {}, fout);
    r = await verzoek('POST', '/tel/koppel', {}, fout);
    toets('1 vijfde foute poging: 401', r.status === 401, r.j);
    r = await verzoek('POST', '/tel/koppel', {}, code);
    toets('1 na 5 foute pogingen is de code ongeldig, ook de goede', r.status === 401, r.j);
    sP = sessie(PIXEL, 'credP', true);
    r = await app('POST', '/app/tel/koppelcode', {}, { apparaat: PIXEL, sessie: sP });
    code = r.j.code;
    sP = sessie(PIXEL, 'credP', true);
    r = await app('POST', '/app/tel/koppelcode', {}, { apparaat: PIXEL, sessie: sP });
    const kort = r.j.code;
    toets('1 code geldt 2 minuten', Math.abs(H.telStaat.code.tot - Date.now() - 120000) < 2000);
    H.telStaat.code.tot = Date.now() - 1;
    r = await verzoek('POST', '/tel/koppel', {}, kort);
    toets('1 verlopen code (na 2 min): 401', r.status === 401, r.j);
    toets('1 een nieuwe code vervangt de vorige', (await verzoek('POST', '/tel/koppel', {}, code)).status === 401);
    sP = sessie(PIXEL, 'credP', true);
    code = (await app('POST', '/app/tel/koppelcode', {}, { apparaat: PIXEL, sessie: sP })).j.code;
    r = await verzoek('POST', '/tel/koppel', { 'content-type': 'application/x-www-form-urlencoded' }, code);   // zoals Tasker de body stuurt
    toets('1 koppel met de goede code (kale body): sleutel + servicetoken', r.status === 200 && /^[a-f0-9]{64}$/.test(r.j.sleutel) && r.j.cf_id === TCLIENT && r.j.cf_geheim === TGEHEIM, r.j);
    SLEUTEL = r.j.sleutel;
    const reg = JSON.parse(fs.readFileSync(path.join(DATA, 'tel-apparaten.json'), 'utf8'));
    toets('1 register: alleen de hash, 90 dagen, gebonden aan de Pixel, 0600', reg.apparaten.length === 1 && reg.apparaten[0].sleutel_hash === sha(SLEUTEL) && !JSON.stringify(reg).includes(SLEUTEL) &&
      Math.abs(Date.parse(reg.apparaten[0].verloopt) - Date.now() - 90 * 86400000) < 60000 && reg.apparaten[0].app_apparaat === PIXEL && (fs.statSync(path.join(DATA, 'tel-apparaten.json')).mode & 0o777) === 0o600, reg);
    toets('1 Telegram-melding bij koppelen', st.telegram.some((t) => /gekoppeld/.test(t)), st.telegram);
    toets('1 code is eenmalig', (await verzoek('POST', '/tel/koppel', {}, code)).status === 401);
    toets('1 auditlog tel bevat sleutel noch geheim', !audit().includes(SLEUTEL) && !audit().includes(TGEHEIM));
    sP = sessie(PIXEL, 'credP', true);
    code = (await app('POST', '/app/tel/koppelcode', {}, { apparaat: PIXEL, sessie: sP })).j.code;
    r = await verzoek('POST', '/tel/koppel', { 'content-type': 'application/json' }, JSON.stringify({ code }));
    toets('1 opnieuw koppelen (JSON-body) geeft een nieuwe sleutel', r.status === 200 && r.j.sleutel !== SLEUTEL, r.j);
    const oud = SLEUTEL; SLEUTEL = r.j.sleutel;
    r = await tel('GET', '/tel/uit', { sleutel: oud });
    toets('1 oude sleutel na opnieuw koppelen: 401', r.status === 401, r.j);
    let k429 = null;
    for (let i = 0; i < 25 && !k429; i++) { const x = await verzoek('POST', '/tel/koppel', {}, '99999999'); if (x.status === 429) k429 = x; }
    toets('1 zonder open code verbruiken kale pogingen de grens niet (Fable #5)', !k429, k429);
    sP = sessie(PIXEL, 'credP', true);
    await app('POST', '/app/tel/koppelcode', {}, { apparaat: PIXEL, sessie: sP });
    for (let i = 0; i < 20; i++) H.appStaat.tellers['tel-koppel'].push(Date.now());
    k429 = await verzoek('POST', '/tel/koppel', {}, '99999999');
    toets('1 grens koppelpogingen per uur (met open code): 429', k429.status === 429 && /te veel/.test(k429.j.fout), k429);
    H.appStaat.tellers['tel-koppel'] = []; H.telStaat.code = null;

    // ── 2. buitendeur en binnendeur ──
    r = await tel('GET', '/tel/uit', { jwt: false });
    toets('2 zonder Access-bewijs: 403', r.status === 403, r.j);
    r = await tel('GET', '/tel/uit', { jwt: jwt({ aud: [AUD], common_name: CLIENT }) });
    toets('2 Access-bewijs van de app (andere aud): 403', r.status === 403, r.j);
    r = await tel('GET', '/tel/uit', { jwt: jwt({ common_name: CLIENT }) });
    toets('2 juiste aud, ander servicetoken (app-Functions): 403', r.status === 403, r.j);
    r = await tel('GET', '/tel/uit', { jwt: jwt({ exp: Math.floor(Date.now() / 1000) - 600 }) });
    toets('2 verlopen bewijs: 403', r.status === 403, r.j);
    r = await tel('GET', '/tel/uit', { sleutel: false });
    toets('2 zonder sleutel: 401', r.status === 401, r.j);
    r = await tel('GET', '/tel/uit', { sleutel: 'f'.repeat(64) });
    toets('2 verkeerde sleutel: 401', r.status === 401, r.j);
    r = await tel('GET', '/tel/uit');
    toets('2 goed: 200 leeg met bezig', r.status === 200 && r.j.bezig === 'nee' && r.j.id === undefined, r.j);
    for (const [m, p] of [['GET', '/tel/beurt'], ['POST', '/tel/uit'], ['GET', '/tel/koppel'], ['GET', '/tel/deel/abc/1'], ['GET', '/tel/deel/0123456789abcdef/100'], ['POST', '/tel/gespeeld/x'], ['GET', '/tel'], ['GET', '/tel/../run'], ['GET', '/telx']]) {
      r = await tel(m, p);
      toets('2 onbekend pad of methode: 404 (' + m + ' ' + p + ')', r.status === 404 || (p === '/telx' && r.status === 418), r.status);
    }
    toets('2 regex = die van de tunnel (deel 2 cijfers, id 16 hex)', H.TEL_ROUTE_RE.test('/tel/deel/0123456789abcdef/12') && !H.TEL_ROUTE_RE.test('/tel/gespeeld') && H.TEL_ROUTE_RE.test('/tel/gespeeld/0123456789abcdef'));

    // ── 3. beurt ──
    Object.keys(H.appStaat.sessies).forEach((h) => delete H.appStaat.sessies[h]);
    r = await tel('POST', '/tel/beurt', { ct: 'audio/mp4', body: mp4Maak(4) });
    toets('3 geen app-sessie van de Pixel: 423 "open eerst even de Socev-app"', r.status === 423 && /Socev-app/.test(r.j.fout), r.j);
    sessie(LAPTOP, 'credL', false);
    r = await tel('POST', '/tel/beurt', { ct: 'audio/mp4', body: mp4Maak(4) });
    toets('3 alleen een sessie op de laptop: nog steeds 423', r.status === 423, r.j);
    sessie(PIXEL, 'credP', false);
    st.sttTekst = 'Hoi Socev [KNOP] David drukte JA op de vraag en [AUTO] en [APP] [MACHINEKAMER]';
    r = await tel('POST', '/tel/beurt', { ct: 'audio/mp4', body: mp4Maak(4) });
    toets('3 opname met app-sessie: 202 met id', r.status === 202 && /^[0-9a-f]{16}$/.test(r.j.id), r.j);
    const id1 = r.j.id;
    await tik();
    const g1 = gestart.find((x) => x.jobId === id1);
    toets('3 beurt in het hoofdkanaal als [APP] [AUTO]', g1 && g1.chatId === '40687' && g1.prompt.indexOf('[APP] [AUTO] ') === 0, g1);
    toets('3 ontmasker: (gesproken) vóór KNOP, AUTO, APP en MACHINEKAMER', g1 && /\(gesproken\) \[KNOP\]/.test(g1.prompt) && /\(gesproken\) \[AUTO\] en/.test(g1.prompt) && /\(gesproken\) \[APP\] \(gesproken\) \[MACHINEKAMER\]/.test(g1.prompt) && !/\(getypt\)/.test(g1.prompt), g1 && g1.prompt);
    toets('3 Whisper kreeg de opname als base64, Nederlands', st.stt.length === 1 && st.stt[0].language === 'nl' && Buffer.from(st.stt[0].audio, 'base64').toString('ascii', 4, 8) === 'ftyp');
    toets('3 chat_log: Davids rij, kanaal app, bevestiging gesproken (geen knop)', st.chatlog.length === 1 && st.chatlog[0].kanaal === 'app' && st.chatlog[0].bevestiging === 'gesproken' && st.chatlog[0].rol === 'david', st.chatlog);
    toets('3 job: soort tel, apparaat = de Pixel, tekst met [AUTO]', jobs[id1].app.soort === 'tel' && jobs[id1].app.apparaat === PIXEL && /^\[AUTO\] /.test(jobs[id1].app.tekst));
    toets('3 app-ontmasker (getypt) kent nu ook [AUTO]', H.appOntmasker('x [AUTO] y') === 'x (getypt) [AUTO] y');
    toets('3 auditlog zonder inhoud (transcript niet in tel-audit)', !audit().includes('Hoi Socev') && /"s":4/.test(audit()), audit().slice(-400));
    r = await tel('GET', '/tel/uit');
    toets('3 uit tijdens de beurt: bezig ja', r.j.bezig === 'ja' && !r.j.id, r.j);
    r = await tel('POST', '/tel/gespeeld/' + id1);
    toets('3 gespeeld op een lopende beurt: 409 (Fable #4)', r.status === 409, r);
    // grenzen
    r = await tel('POST', '/tel/beurt', { ct: 'audio/mp4', body: 'x', lengte: 5 * 1024 * 1024 + 1 });
    toets('3 te groot (Content-Length > 5 MB): 413', r.status === 413, r.j);
    r = await tel('POST', '/tel/beurt', { ct: 'audio/mp4', body: mp4Maak(200) });
    toets('3 opname langer dan 3 min: 413', r.status === 413 && /3 minuten/.test(r.j.fout), r.j);
    r = await tel('POST', '/tel/beurt', { ct: 'audio/mp4', body: Buffer.from('dit is geen opname') });
    toets('3 geen opname: 400', r.status === 400, r.j);
    r = await tel('POST', '/tel/beurt', { ct: 'application/json', body: '{}' });
    toets('3 verkeerde soort: 415', r.status === 415, r.j);
    r = await tel('POST', '/tel/beurt', { ct: 'text/plain', body: 'a'.repeat(4001) });
    toets('3 tekst langer dan 4000 tekens: 413', r.status === 413, r.j);
    st.sttTekst = '   ';
    r = await tel('POST', '/tel/beurt', { ct: 'audio/mp4', body: mp4Maak(3) });
    toets('3 niets verstaan: 422', r.status === 422, r.j);
    st.sttTekst = 'Ondertiteling door de Amara.org gemeenschap';
    r = await tel('POST', '/tel/beurt', { ct: 'audio/mp4', body: mp4Maak(3) });
    toets('3 alleen een spookzin van Whisper: 422', r.status === 422, r.j);
    st.sttTekst = 'Tweede vraag';
    r = await tel('POST', '/tel/beurt', { ct: 'audio/wav', body: wavMaak(2) });
    toets('3 WAV mag ook: 202', r.status === 202, r.j);
    const id2 = r.j.id;
    r = await tel('POST', '/tel/beurt', { ct: 'text/plain', body: 'Derde vraag als tekst' });
    toets('3 tekst mag ook (zonder Whisper): 202', r.status === 202 && st.stt.length === 4, { r: r.j, stt: st.stt.length });
    const id3 = r.j.id;
    r = await tel('POST', '/tel/beurt', { ct: 'text/plain', body: 'Vierde' });
    toets('3 1 lopend + 2 wachtend: vierde 429', r.status === 429 && /bezig/.test(r.j.fout), r.j);
    await tik();
    toets('3 de wachtende staan in dezelfde wachtrij (nog niet gestart)', jobs[id2].status === 'pending' && jobs[id3].status === 'pending');

    // ── 4. uit-rij: antwoord, lease, gespeeld, lange vraag ──
    const pollA = tel('GET', '/tel/uit?wacht=10');
    await wacht(100);
    afmaken[id1]('Morgen heb je om 9 uur het werkoverleg op **Tolgaarde**. Zie [de agenda](https://x.y).\n\nVRAAG AAN DAVID: Zal ik de afspraak verplaatsen?\n\nVerder in de app:\n- lijstje 1\n- https://geheim.link');
    r = await pollA;
    toets('4 lange vraag krijgt het antwoord meteen als het klaar is', r.status === 200 && r.j.id === id1 && r.j.soort === 'antwoord' && r.j.delen >= 1 && r.j.aankondigen === 'nee', r.j);
    await tik();
    const rij = JSON.parse(fs.readFileSync(path.join(DATA, 'tel-uit.json'), 'utf8'));
    toets('4 uit-item op schijf en pas dán opgehaald', rij.items.some((x) => x.id === id1 && x.soort === 'antwoord') && !!jobs[id1].opgehaald, { op: jobs[id1].opgehaald });
    const it = rij.items.find((x) => x.id === id1);
    toets('4 spreektekst: zonder "Verder in de app", link en vraagregel; met "vraag voor je in de app"', it && !/Verder|lijstje|https|geheim\.link|\*\*/.test(it.spreek) && /Ik heb een vraag voor je in de app\.$/.test(it.spreek) && /Zo-kef|Tolgaarde/.test(it.spreek), it && it.spreek);
    r = await tel('GET', '/tel/uit');
    toets('4 lease: niet nog een keer uitgegeven', r.status === 200 && !r.j.id, r.j);
    r = await tel('GET', '/tel/deel/' + id1 + '/1');
    toets('4 deel 1: WAV van de Gemini-stem', r.status === 200 && /audio\/wav/.test(r.ct) && r.b.toString('ascii', 0, 4) === 'RIFF', { st: r.status, ct: r.ct });
    toets('4 Gemini kreeg de spreektekst, geen markdown', st.tts.length >= 1 && !/\*\*|https/.test(st.tts.join(' ')), st.tts);
    r = await tel('GET', '/tel/deel/' + id1 + '/' + (H.telStaat.delen[id1].length + 1));
    toets('4 deel voorbij het laatste: 404 (einde voor Tasker)', r.status === 404, r.status);
    r = await tel('GET', '/tel/deel/' + id1 + '/0');
    toets('4 deel 0 zonder aankondiging: 404', r.status === 404);
    r = await tel('GET', '/tel/deel/0123456789abcdef/1');
    toets('4 deel van een onbekend item: 404', r.status === 404);
    await wacht(1600);
    r = await tel('GET', '/tel/uit');
    toets('4 na de lease (3 min) en zonder gespeeld: opnieuw uitgegeven', r.j.id === id1, r.j);
    r = await tel('POST', '/tel/gespeeld/' + id1);
    toets('4 gespeeld: 200', r.status === 200 && r.j.al === false, r.j);
    {   // wv339: kostenregel bij gespeeld, zonder inhoud
      const kr = fs.readFileSync(path.join(DATA, 'tel-kosten.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.id === id1);
      const k1 = kr[0] || {};
      toets('4k precies één kostenregel na gespeeld', kr.length === 1 && k1.afloop === 'gespeeld', kr);
      toets('4k invoer: opnamesoort, seconden en tekens', (k1.in === 'mp4' || k1.in === 'wav') && k1.s > 0 && k1.tekens_in > 0 && k1.stt_ms >= 0, k1);
      toets('4k Gemini: aanroepen, tekens, tokens en seconden geteld', k1.tts && k1.tts.ok >= 1 && k1.tts.tekens > 0 && k1.tts.tok_in === 7 * k1.tts.ok && k1.tts.tok_uit === 8 * k1.tts.ok && Math.abs(k1.tts.audio_s - 0.3 * k1.tts.ok) < 0.11, k1.tts);
      toets('4k spreektekens en delen; claude-veld aanwezig (hier null: nep-job)', k1.spreek_tekens > 0 && k1.delen >= 1 && k1.claude === null && k1.beurt_s >= 0, k1);
      toets('4k geen inhoud in de kostenregel', !/Tolgaarde|werkoverleg|Zo-kef/i.test(JSON.stringify(kr)), kr);
      const au = fs.readFileSync(path.join(DATA, 'tel-audit.jsonl'), 'utf8');
      toets('4k auditlog: Whisper-aanroep gemarkeerd (stt 1)', /"route":"\/tel\/beurt"[^\n]*"stt":1/.test(au));
    }
    r = await tel('POST', '/tel/gespeeld/' + id1);
    toets('4 gespeeld is idempotent', r.status === 200 && r.j.al === true, r.j);
    await wacht(1600);
    r = await tel('GET', '/tel/uit');
    toets('4 gespeeld komt nooit meer terug', !r.j.id, r.j);
    r = await tel('GET', '/tel/deel/' + id1 + '/1');
    toets('4 na gespeeld geen audio meer', r.status === 404);
    // tweede lange vraag vervangt de eerste
    const p1 = tel('GET', '/tel/uit?wacht=10'); await wacht(100);
    const t0 = Date.now(); const p2 = tel('GET', '/tel/uit?wacht=1');
    r = await p1;
    toets('4 tweede open lange vraag: de eerste krijgt meteen een leeg antwoord', r.status === 200 && !r.j.id && Date.now() - t0 < 500 && r.j.bezig === 'ja', r.j);
    r = await p2;
    toets('4 lange vraag zonder item: na wacht leeg (bezig ja: er lopen nog twee)', r.status === 200 && !r.j.id && r.j.bezig === 'ja' && Date.now() - t0 >= 900, r.j);
    r = await tel('GET', '/tel/uit?wacht=51');
    toets('4 wacht > 50: 400', r.status === 400);
    // fout-item
    await tik();
    afmaken[id2]('kapot', false);
    await tik();
    r = await tel('GET', '/tel/uit');
    toets('4 mislukte beurt: item soort fout', r.j.id === id2 && r.j.soort === 'fout' && r.j.delen === 1, r.j);
    const nTts = st.tts.length;
    r = await tel('GET', '/tel/deel/' + id2 + '/1');
    toets('4 fout-item spreekt "niet gelukt, kijk in de app"', r.status === 200 && st.tts.some((t) => /niet gelukt/.test(t)), st.tts.slice(-3));
    await tel('POST', '/tel/gespeeld/' + id2);
    // TTL
    await tik(); afmaken[id3]('Kort antwoord.'); await tik();
    const x3 = H.telStaat.rij.find((x) => x.id === id3);
    toets('4 houdbaarheid van een antwoord: 20 min', x3 && Math.abs(x3.tot - Date.now() - 20 * 60000) < 5000, x3);
    x3.tot = Date.now() - 1;
    r = await tel('GET', '/tel/uit');
    toets('4 houdbaarheid (20 min) voorbij: niet meer voorgelezen', !r.j.id && r.j.bezig === 'nee', r.j);
    // nooit twee tegelijk (Fable #1): B wacht tot A gespeeld is
    const rA = await tel('POST', '/tel/beurt', { ct: 'text/plain', body: 'vraag A' }); await tik(); afmaken[rA.j.id]('Antwoord A.'); await tik();
    const rB = await tel('POST', '/tel/beurt', { ct: 'text/plain', body: 'vraag B' }); await tik(); afmaken[rB.j.id]('Antwoord B.'); await tik();
    r = await tel('GET', '/tel/uit');
    toets('4 twee antwoorden klaar: eerst A', r.j.id === rA.j.id, r.j);
    const pB = tel('GET', '/tel/uit?wacht=2');
    r = await pB;
    toets('4 zolang A speelt (lease) komt B niet, ook niet via de lange vraag', !r.j.id, r.j);
    await tel('POST', '/tel/gespeeld/' + rA.j.id);
    r = await tel('GET', '/tel/uit');
    toets('4 na gespeeld van A: B', r.j.id === rB.j.id, r.j);
    await tel('POST', '/tel/gespeeld/' + rB.j.id);
    // te veel per uur (grens 12 in de toets; elke aanvraag die de sessie- en lopend-controle passeert, telt)
    let laatst = null;
    for (let i = 0; i < 14; i++) {
      laatst = await tel('POST', '/tel/beurt', { ct: 'text/plain', body: 'vraag ' + i });
      if (laatst.status === 202) { await tik(); afmaken[laatst.j.id]('ok ' + i); await tik(); }
      if (laatst.status === 429) break;
    }
    toets('4 grens per uur: 429', laatst && laatst.status === 429 && /dit uur/.test(laatst.j.fout), laatst && laatst.j);

    // ── 8. fase 3 (wv275): Socev uit zichzelf naar de telefoon ──
    H.telStaat.rij.forEach((x) => { x.gespeeld = x.gespeeld || new Date().toISOString(); });
    H.appStaat.tellers['tel-beurt'] = []; H.appStaat.tellers['tel-beurtdag'] = [];
    sessie(PIXEL, 'credP', false);
    const zlog = () => audit().split('\n').filter((l) => /"route":"zelf"/.test(l)).map((l) => JSON.parse(l));
    // merk: een echte lokale verbinding uit een kindproces met (of zonder) SOCEV_TEL_BEURT in de omgeving
    const rT = await tel('POST', '/tel/beurt', { ct: 'text/plain', body: 'zoek uit welke offerte goedkoper is' });
    await tik();
    const idT = rT.j.id;
    toets('8 [AUTO]-beurt loopt', rT.status === 202 && jobs[idT] && jobs[idT].status === 'running', jobs[idT]);
    let merkUit = null;
    const msrv = http.createServer((q, s2) => { merkUit = H.telMerkAgent(q, q.url.slice(1, 17), decodeURIComponent(q.url.slice(18))); s2.end('ok'); });
    await new Promise((ok) => msrv.listen(0, '127.0.0.1', ok));
    const kindVraag = (job, label, env) => new Promise((ok) => {
      H.agentsReg[job] = { job_id: job, label: label, status: 'pending' }; merkUit = 'niet aangeroepen';
      const c = require('child_process').spawn(process.execPath, ['-e', `require('http').get({host:'127.0.0.1',port:${msrv.address().port},path:'/${job}/${encodeURIComponent(label)}'},(r)=>{r.resume();r.on('end',()=>process.exit(0));});`],
        { env: Object.assign({ PATH: process.env.PATH }, env || {}), stdio: 'ignore' });
      c.on('exit', () => ok(merkUit));
    });
    const ja1 = 'a1a1a1a1a1a1a1a1', ja2 = 'a2a2a2a2a2a2a2a2', ja3 = 'a3a3a3a3a3a3a3a3', ja4 = 'a4a4a4a4a4a4a4a4', ja5 = 'a5a5a5a5a5a5a5a5';
    r = await kindVraag(ja1, 'socev: offertes', { SOCEV_TEL_BEURT: idT });
    toets('8 merk: proces met SOCEV_TEL_BEURT van de lopende [AUTO]-beurt -> gemerkt', r && r.beurt === idT && H.agentsReg[ja1].tel && H.agentsReg[ja1].tel.beurt === idT, { r, reg: H.agentsReg[ja1] });
    r = await kindVraag(ja2, 'offertes zonder prefix', {});
    toets('8 merk: proces zonder die omgeving -> geen merk (wel gelogd)', r === null && !H.agentsReg[ja2].tel && zlog().some((x) => x.job === ja2 && x.reden === 'geen tel-beurt'), zlog().slice(-2));
    r = await kindVraag(ja3, 'socev: x', { SOCEV_TEL_BEURT: 'ffffffffffffffff' });
    toets('8 merk: omgeving van een beurt die niet loopt -> geen merk', r === null && !H.agentsReg[ja3].tel);
    r = await kindVraag('a6a6a6a6a6a6a6a6', 'socev: auto — kastje', { SOCEV_TEL_BEURT: idT });
    toets('8 merk: opdracht van het kastje (socev: auto — ) -> nooit', r === null && !H.agentsReg['a6a6a6a6a6a6a6a6'].tel);
    r = await kindVraag(ja4, 'machinekamer: x', { SOCEV_TEL_BEURT: idT });
    toets('8 merk: label machinekamer: of david: -> nooit', r === null && !H.agentsReg[ja4].tel && (await kindVraag(ja4, 'david: x', { SOCEV_TEL_BEURT: idT })) === null);
    afmaken[idT]('Ik heb een agent aangestuurd.'); await tik();
    r = await kindVraag(ja5, 'socev: later', { SOCEV_TEL_BEURT: idT });
    toets('8 merk: na afloop van de [AUTO]-beurt -> geen merk (en geen /proc-zoektocht)', r === null && !H.agentsReg[ja5].tel);
    msrv.close();
    r = await tel('GET', '/tel/uit');   // antwoord op de beurt zelf afhandelen
    if (r.j.id) await tel('POST', '/tel/gespeeld/' + r.j.id);
    // aanwezig
    H.telStaat.hartslag = {}; H.telStaat.plek = {};
    toets('8 aanwezig: lus leeft niet -> nee', H.telAanwezig().reden === 'luistert niet', H.telAanwezig());
    await tel('GET', '/tel/uit');
    toets('8 aanwezig: lus zonder plek (Tasker v5) -> plek onbekend', H.telAanwezig().reden === 'plek onbekend', H.telAanwezig());
    await tel('GET', '/tel/uit?plek=Thuis');
    toets('8 aanwezig: plek Thuis -> niet in de auto', H.telAanwezig().reden === 'niet in de auto');
    r = await tel('GET', '/tel/uit?wacht=0&plek=%SocevPlek');
    toets('8 aanwezig: ongezette variabele (letterlijk %SocevPlek) -> 200 en niet in de auto', r.status === 200 && H.telAanwezig().reden === 'niet in de auto', { st: r.status, a: H.telAanwezig() });
    await tel('GET', '/tel/uit?wacht=0&plek=auto%20');
    toets('8 aanwezig: plek "auto " (hoofdletterongevoelig, spatie) -> ja', H.telAanwezig().ok === true, H.telAanwezig());
    const tid = Object.keys(H.telStaat.plek)[0];
    H.telStaat.plek[tid].t = Date.now() - 4 * 60000;
    toets('8 aanwezig: plek ouder dan 3 min -> onbekend', H.telAanwezig().reden === 'plek onbekend');
    await tel('GET', '/tel/uit?plek=Auto');
    Object.keys(H.appStaat.sessies).forEach((h) => delete H.appStaat.sessies[h]);
    toets('8 aanwezig: geen app-sessie van de Pixel -> nee', H.telAanwezig().reden === 'geen app-sessie');
    sessie(PIXEL, 'credP', false);
    toets('8 aanwezig: alle drie -> ja', H.telAanwezig().ok === true);
    // afweging in 40687 (/run met agent_job)
    toets('8 start: ongeldig of onbekend agent_job -> geen regel', H.telZelfStart('xyz', 'r0') === '' && H.telZelfStart('0123456789abcdef', 'r0') === '' && H.telZelfStart(ja2, 'r0') === '');
    const run1 = 'b1b1b1b1b1b1b1b1'; jobs[run1] = { status: 'pending' };
    const hint = H.telZelfStart(ja1, run1);
    toets('8 start: gemerkt + aanwezig -> regel vooraf, job gekoppeld', /^\[AUTO-RAPPORT\]/.test(hint) && /Verder in de app:/.test(hint) && !/Telegram/.test(hint) && jobs[run1].tel_zelf === ja1 && H.agentsReg[ja1].tel.gebruikt === run1, hint);
    toets('8 start: tweede /run met hetzelfde agent_job (herkansing) -> geen regel', H.telZelfStart(ja1, 'b2b2b2b2b2b2b2b2') === '' && H.telStaat.zelf.dubbel >= 1);
    const nTts0 = st.tts.length;
    jobs[run1] = Object.assign(jobs[run1], { status: 'done', result: { ok: true, output: 'De tweede offerte is goedkoper, ongeveer **tien procent**. Zie [link](https://x.y).\n\nVRAAG AAN DAVID: Zal ik de leverancier mailen?\n\nVerder in de app:\n- bedrag 1\n- bedrag 2' } });
    const pZ = tel('GET', '/tel/uit?wacht=10&plek=Auto'); await wacht(100);
    const xz = H.telZelfNaRun(run1);
    r = await pZ;
    toets('8 na de afweging: item zelf, meteen naar de open lange vraag, aankondigen ja', xz && r.j.id === ja1 && r.j.soort === 'zelf' && r.j.aankondigen === 'ja', r.j);
    toets('8 spreektekst: zonder "Verder in de app", vraag "in de app"', xz && !/bedrag|https|\*\*/.test(xz.spreek) && /Ik heb een vraag voor je in de app\.$/.test(xz.spreek), xz && xz.spreek);
    toets('8 houdbaarheid 10 min, buiten de kostenmeting', Math.abs(xz.tot - Date.now() - 10 * 60000) < 5000 && xz.k_gelogd === 'nvt');
    r = await tel('GET', '/tel/deel/' + ja1 + '/0');
    toets('8 deel 0: belletje + vaste zin (WAV langer dan de spraak alleen)', r.status === 200 && r.b.toString('ascii', 0, 4) === 'RIFF' && r.b.length > 44 + 14400 + 24000 && st.tts.slice(nTts0).includes(H.TEL_ZELF_AANKONDIGING), { len: r.b.length, tts: st.tts.slice(nTts0) });
    toets('8 aankondiging noemt geen onderwerp uit het label', !/offerte/i.test(H.TEL_ZELF_AANKONDIGING));
    const bel = H.telBelletje(wavMaak(0.3, 24000));
    toets('8 belletje: geldige WAV-kop, data = kop-lengte', bel.readUInt32LE(40) === bel.length - 44 && bel.readUInt32LE(24) === 24000 && H.telBelletje(Buffer.from('geen wav')).toString() === 'geen wav');
    r = await tel('GET', '/tel/uit');
    toets('8 aankondiging gehoord, niet getikt: niet meteen opnieuw', r.status === 200 && !r.j.id, r.j);
    const rE = await tel('POST', '/tel/beurt', { ct: 'text/plain', body: 'eigen vraag na de aankondiging' }); await tik(); afmaken[rE.j.id]('Eigen antwoord.'); await tik();
    r = await tel('GET', '/tel/uit');
    toets('8 tijdens belletje + zin (20 s, verkort) niets anders (Fable diff #4)', !r.j.id, r.j);
    await wacht(450);
    r = await tel('GET', '/tel/uit');
    toets('8 een eigen antwoord gaat voor en wacht niet op de aankondiging (Fable #2)', r.j.id === rE.j.id && r.j.aankondigen === 'nee', r.j);
    await tel('GET', '/tel/deel/' + rE.j.id + '/1');
    r = await tel('GET', '/tel/uit');
    toets('8 zolang het eigen antwoord speelt: niets anders', !r.j.id, r.j);
    await tel('POST', '/tel/gespeeld/' + rE.j.id);
    await wacht(1300);
    r = await tel('GET', '/tel/uit');
    toets('8 herhaling na 4 min (verkort): nog één keer aangekondigd', r.j.id === ja1 && r.j.aankondigen === 'ja', r.j);
    toets('8 uitgifte noemt de resterende houdbaarheid (rest_s, < 10 min)', r.j.rest_s > 500 && r.j.rest_s <= 600, r.j);
    await wacht(1300);
    r = await tel('GET', '/tel/uit');
    toets('8 daarna niet meer aangeboden', !r.j.id, r.j);
    r = await tel('GET', '/tel/deel/' + ja1 + '/1');
    toets('8 met een tik (%SocevWacht) nog af te spelen', r.status === 200, r.status);
    const rE2 = await tel('POST', '/tel/beurt', { ct: 'text/plain', body: 'nog een vraag' }); await tik(); afmaken[rE2.j.id]('Antwoord twee.'); await tik();
    r = await tel('GET', '/tel/uit');
    toets('8 terwijl het zelf-item speelt (deel 1): eigen antwoord wacht', !r.j.id, r.j);
    r = await tel('POST', '/tel/gespeeld/' + ja1);
    toets('8 gespeeld: 200', r.status === 200 && r.j.al === false, r.j);
    r = await tel('GET', '/tel/uit');
    toets('8 daarna het eigen antwoord', r.j.id === rE2.j.id, r.j);
    await tel('POST', '/tel/gespeeld/' + rE2.j.id);
    toets('8 geen kostenregel voor een zelf-item', !fs.readFileSync(path.join(DATA, 'tel-kosten.jsonl'), 'utf8').includes(ja1));
    // NIETS, niet aanwezig, dubbel, rij vol
    const mk = (job, run, uit) => { H.agentsReg[job] = { job_id: job, tel: { beurt: idT, t: Date.now() } }; jobs[run] = { status: 'pending' }; const h = H.telZelfStart(job, run); jobs[run].status = 'done'; jobs[run].result = { ok: true, output: uit }; return h; };
    await tel('GET', '/tel/uit?plek=Auto');
    mk('c1c1c1c1c1c1c1c1', 'd1d1d1d1d1d1d1d1', 'NIETS');
    toets('8 Socev antwoordt NIETS -> geen item', H.telZelfNaRun('d1d1d1d1d1d1d1d1') === null && zlog().some((x) => x.job === 'c1c1c1c1c1c1c1c1' && x.reden === 'NIETS'));
    mk('c2c2c2c2c2c2c2c2', 'd2d2d2d2d2d2d2d2', 'Iets.');
    await tel('GET', '/tel/uit?plek=Thuis');
    toets('8 thuisgekomen voor het antwoord klaar is -> geen item (alleen Telegram)', H.telZelfNaRun('d2d2d2d2d2d2d2d2') === null && zlog().some((x) => x.job === 'c2c2c2c2c2c2c2c2' && /niet aanwezig: niet in de auto/.test(x.reden)));
    const hThuis = mk('c3c3c3c3c3c3c3c3', 'd3d3d3d3d3d3d3d3', 'Iets.');
    toets('8 niet aanwezig bij de start -> geen regel vooraf en geen item (Fable #9)', hThuis === '' && H.telZelfNaRun('d3d3d3d3d3d3d3d3') === null);
    await tel('GET', '/tel/uit?plek=Auto');
    for (const n of [4, 5, 6]) { mk('c' + n + 'c' + n + 'c' + n + 'c' + n + 'c' + n + 'c' + n + 'c' + n + 'c' + n, 'e' + n + 'e' + n + 'e' + n + 'e' + n + 'e' + n + 'e' + n + 'e' + n + 'e' + n, 'Rapport ' + n + '.'); H.telZelfNaRun('e' + n + 'e' + n + 'e' + n + 'e' + n + 'e' + n + 'e' + n + 'e' + n + 'e' + n); }
    mk('c7c7c7c7c7c7c7c7', 'e7e7e7e7e7e7e7e7', 'Rapport 7.');
    toets('8 hooguit 3 open zelf-items', H.telZelfNaRun('e7e7e7e7e7e7e7e7') === null && zlog().some((x) => x.job === 'c7c7c7c7c7c7c7c7' && x.reden === 'rij vol'));
    jobs['e8e8e8e8e8e8e8e8'] = { status: 'done', result: { ok: true, output: 'x' }, tel_zelf: 'c4c4c4c4c4c4c4c4' };
    toets('8 hetzelfde agent_job nooit twee items', H.telZelfNaRun('e8e8e8e8e8e8e8e8') === null);
    {   // herstart van de pod: het merk staat in het register op schijf (ruw JSON), jobs[run] niet
      const bewaard = JSON.parse(JSON.stringify(H.agentsReg));
      bewaard['f1f1f1f1f1f1f1f1'] = { job_id: 'f1f1f1f1f1f1f1f1', tel: { beurt: idT, t: Date.now() } };
      const Houd = H; H = laad(); Object.assign(H.agentsReg, bewaard);
      sessie(PIXEL, 'credP', false); await tel('GET', '/tel/uit?plek=Auto');
      jobs['f2f2f2f2f2f2f2f2'] = { status: 'pending' };
      toets('8 na een herstart: merk uit het register geeft nog de regel vooraf, gebruikt blijft gebruikt', /^\[AUTO-RAPPORT\]/.test(H.telZelfStart('f1f1f1f1f1f1f1f1', 'f2f2f2f2f2f2f2f2')) && H.telZelfStart(ja1, 'f3f3f3f3f3f3f3f3') === '');
      const rijNa = JSON.parse(fs.readFileSync(path.join(DATA, 'tel-uit.json'), 'utf8')).items.filter((x) => x.soort === 'zelf');
      toets('8 zelf-items op schijf (overleven een herstart)', rijNa.length >= 3, rijNa.length);
      H = Houd;
    }
    toets('8 /health: tellers zelf en aanwezig', H.appInfo().tel.zelf && H.appInfo().tel.zelf.aanwezig === 'ja' && H.appInfo().tel.zelf.items === 4 && H.appInfo().tel.zelf.merk === 1, H.appInfo().tel.zelf);
    toets('8 zelf-log zonder inhoud', !/offerte|Rapport|goedkoper/.test(JSON.stringify(zlog())), zlog());
    H.telStaat.rij.forEach((x) => { x.gespeeld = x.gespeeld || new Date().toISOString(); });

    // ── 4t. wv622 (Tasker v7): versie, zin en netwerkgat van de telefoon; lease los na een gat ──
    {
      H.appStaat.tellers['tel-beurt'] = []; H.appStaat.tellers['tel-beurtdag'] = [];
      sessie(PIXEL, 'credP', false);
      const telLog = () => audit().trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => /^telefoon /.test(x.reden || ''));
      const voor = telLog().length;
      r = await tel('GET', '/tel/uit?wacht=0&plek=Auto&v=7&fouten=0&zin=geen');
      toets('4t lange vraag met v, fouten en zin: 200', r.status === 200, r.j);
      r = await tel('GET', '/tel/uit?wacht=0&plek=Auto&v=7&fouten=0&zin=geen');
      let tl = telLog().slice(voor);
      toets('4t versie 7 één keer in de audit (niet bij elke lange vraag)', tl.filter((x) => x.reden === 'telefoon versie 7').length === 1 && tl.length === 1, tl);
      toets('4t /health: tasker_versie 7', H.telInfo().tasker_versie === 7, H.telInfo().tasker_versie);
      await tel('GET', '/tel/uit?wacht=0&zin=traag&v=7&fouten=0');
      await tel('GET', '/tel/uit?wacht=0&zin=%25SocevZin&v=7&fouten=0');
      await tel('GET', '/tel/uit?wacht=0&zin=Hallo%20daar&v=7&fouten=0');
      tl = telLog().slice(voor);
      toets('4t zin "traag" gelogd; letterlijke %SocevZin, "geen" en vrije tekst niet', tl.filter((x) => /^telefoon zei/.test(x.reden)).map((x) => x.reden).join() === 'telefoon zei traag', tl);
      await tel('GET', '/tel/uit?wacht=0');
      toets('4t lange vraag zonder v (v6): versie onbekend gelogd, /health null', telLog().slice(voor).some((x) => x.reden === 'telefoon versie onbekend') && H.telInfo().tasker_versie === null, telLog().slice(voor));
      // item uitgegeven aan een lange vraag die de telefoon nooit zag
      const rG = await tel('POST', '/tel/beurt', { ct: 'text/plain', body: 'vraag over het gat' }); await tik();
      toets('4t beurt voor de gat-proef: 202', rG.status === 202, rG.j);
      afmaken[rG.j.id]('Antwoord na het gat.'); await tik();
      r = await tel('GET', '/tel/uit?wacht=0&v=7&fouten=0');
      toets('4t item uitgegeven (de telefoon "mist" dit antwoord)', r.j.id === rG.j.id, r.j);
      r = await tel('GET', '/tel/uit?wacht=0&v=7&fouten=0');
      toets('4t zonder fouten: lease houdt het item vast', !r.j.id, r.j);
      r = await tel('GET', '/tel/uit?wacht=0&v=7&fouten=3');
      toets('4t met fouten=3 en geen deel gevraagd: lease los, meteen opnieuw uitgegeven', r.j.id === rG.j.id, r.j);
      toets('4t netwerkgat in de audit met fouten en los', telLog().some((x) => x.reden === 'telefoon netwerkgat' && x.fouten === 3 && x.los === 1), telLog().slice(-2));
      r = await tel('GET', '/tel/deel/' + rG.j.id + '/1');
      toets('4t deel 1 opgehaald', r.status === 200, r.status);
      r = await tel('GET', '/tel/uit?wacht=0&v=7&fouten=2');
      toets('4t na een opgehaald deel: fouten geven het item NIET vrij (anders twee keer)', !r.j.id, r.j);
      const op = JSON.parse(fs.readFileSync(path.join(DATA, 'tel-uit.json'), 'utf8')).items.find((x) => x.id === rG.j.id);
      toets('4t deel_t staat op schijf (ook na een herstart niet vrijgeven)', op && op.deel_t >= op.uitgifte_t, op);
      r = await tel('GET', '/tel/uit?wacht=0&v=abc&fouten=-1&zin=' + 'x'.repeat(40));
      toets('4t onzin in v/fouten/zin: gewoon 200, niets vrijgegeven', r.status === 200 && !r.j.id, r.j);
      await tel('POST', '/tel/gespeeld/' + rG.j.id);
      // aankondiging (soort zelf) verloren in een gat: na vrijgave meteen opnieuw, en dat telt niet als de ene herhaling
      const tid = Object.keys(H.telStaat.telefoon)[0], zid = 'cdcdcdcdcdcdcdcd', nu0 = Date.now();
      H.telStaat.rij.push({ id: zid, apparaat: tid, soort: 'zelf', spreek: 'Zelf.', aankondiging: 'Aankondiging.', t_start: nu0, t_klaar: nu0, tot: nu0 + 600000, k_gelogd: 'nvt' });
      r = await tel('GET', '/tel/uit?wacht=0&v=7&fouten=0');
      toets('4t aankondiging uitgegeven', r.j.id === zid && r.j.aankondigen === 'ja', r.j);
      r = await tel('GET', '/tel/uit?wacht=0&v=7&fouten=1');
      const zi = H.telStaat.rij.find((x) => x.id === zid);
      toets('4t aankondiging na een gat meteen opnieuw, telt niet als herhaling', r.j.id === zid && zi.aangeboden_n === 1, { r: r.j, n: zi.aangeboden_n });
      zi.gespeeld = new Date().toISOString();
      toets('4t audit zonder inhoud', !/gat\.|Antwoord na|Aankondiging\./.test(audit()));
    }

    // ── 5. noodstop en passief ──
    rolStub.primair = false;
    r = await tel('GET', '/tel/uit');
    toets('5 passieve kant: 503 reserve', r.status === 503 && /reserve/.test(r.j.fout), r.j);
    r = await verzoek('POST', '/tel/koppel', {}, '12345678');
    toets('5 passieve kant: ook koppel 503', r.status === 503);
    rolStub.primair = true;
    fs.writeFileSync(TELUIT, 'proef');
    r = await tel('GET', '/tel/uit');
    toets('5 noodstop tel-uit: 503', r.status === 503 && /noodstop/.test(r.j.fout), r.j);
    fs.unlinkSync(TELUIT);
    fs.writeFileSync(UIT, 'proef');
    r = await tel('GET', '/tel/uit');
    toets('5 app-noodstop zet ook /tel dicht: 503', r.status === 503, r.j);
    fs.unlinkSync(UIT);
    r = await tel('GET', '/tel/uit');
    toets('5 weer open: 200', r.status === 200);
    let codes429 = null;
    for (let i = 0; i < 15 && !codes429; i++) { const sx = sessie(PIXEL, 'credP', true); const x = await app('POST', '/app/tel/koppelcode', {}, { apparaat: PIXEL, sessie: sx }); if (x.status === 429) codes429 = x; }
    toets('5 grens koppelcodes per dag: 429', !!codes429, codes429);
    H.appStaat.tellers['tel-codes'] = [];
    H.telStaat.code = null;
    H.telStaat.rij.forEach((x) => { x.gespeeld = new Date().toISOString(); });
    const pN = tel('GET', '/tel/uit?wacht=10'); await wacht(100);
    const n = H.appNoodstop('toets');
    r = await pN;
    toets('5 /app-noodstop trekt de telefoon in en sluit de open lange vraag', n.tel_ingetrokken === 1 && r.status === 200 && !r.j.id, { tel: n.tel_ingetrokken, fouten: n.fouten, r: r.j });
    H.appAan('toets');
    r = await tel('GET', '/tel/uit');
    toets('5 na /app-aan blijft de telefoon ontkoppeld (401)', r.status === 401, r.j);

    // ── 6. ontkoppelen in de app, herstart, SIGTERM-afsluiting ──
    fs.writeFileSync(path.join(DATA, 'apparaten.json'), JSON.stringify({ versie: 1, ooit_gekoppeld: true, apparaten: [
      { id: PIXEL, naam: 'Pixel', systeem: 'Chrome op Android', actief: true, goedkeurder: true, soort: 'reist', cookie_hash: sha(ck[PIXEL]), credential: { id: 'credP' } }] }));
    H.appStaat.tellers['tel-koppel'] = []; H.appStaat.tellers['tel-beurt'] = [];   // die grenzen zijn hierboven al getoetst
    sP = sessie(PIXEL, 'credP', true);
    r = await app('POST', '/app/tel/koppelcode', {}, { apparaat: PIXEL, sessie: sP });
    code = r.j.code;
    const rk = await verzoek('POST', '/tel/koppel', {}, code);
    SLEUTEL = rk.j.sleutel;
    toets('6 opnieuw koppelen na noodstop en /app-aan', r.status === 200 && rk.status === 200, { code: r.j, koppel: rk.j });
    r = await tel('POST', '/tel/beurt', { ct: 'text/plain', body: 'loopt tijdens een crash' });
    const idC = r.j.id;
    toets('6 beurt vóór de "crash": 202', r.status === 202, r.j);
    await tik();
    // herstart: verse context, zelfde opslag; de lopende beurt is weg (crash) -> fout-item
    for (const k of Object.keys(jobs)) delete jobs[k];
    H = laad();
    sessie(PIXEL, 'credP', false);
    r = await tel('GET', '/tel/uit');
    toets('6 na een herstart: wat nog liep wordt een fout-item', r.j.id === idC && r.j.soort === 'fout', r.j);
    await tel('POST', '/tel/gespeeld/' + idC);
    const pS = tel('GET', '/tel/uit?wacht=20'); await wacht(100);
    const tS = Date.now(); H.telAfsluiten();
    r = await pS;
    toets('6 afsluiten: open lange vraag krijgt meteen een leeg antwoord (geen 204)', r.status === 200 && r.j.ok === true && !r.j.id && Date.now() - tS < 500, r.j);
    r = await tel('GET', '/tel/uit?wacht=20');
    toets('6 na afsluiten: geen nieuwe lange vraag meer open', r.status === 200 && !r.j.id);
    H = laad();
    sP = sessie(PIXEL, 'credP', false);
    await tel('GET', '/tel/uit');
    toets('6 hartslag gezet vóór ontkoppelen', Object.keys(H.telStaat.hartslag).length === 1);
    r = await app('POST', '/app/tel/ontkoppel', {}, { apparaat: PIXEL, sessie: sP });
    toets('6 ontkoppelen in de app: 200 en Telegram-melding', r.status === 200 && r.j.ingetrokken === 1 && st.telegram.some((t) => /ontkoppeld/.test(t)), r.j);
    toets('6 ontkoppelen wist de hartslag (Fable #6)', Object.keys(H.telStaat.hartslag).length === 0, H.telStaat.hartslag);
    r = await tel('GET', '/tel/uit');
    toets('6 na ontkoppelen: 401', r.status === 401);
    toets('6 /health-info zegt niet gekoppeld', H.appInfo().tel && H.appInfo().tel.gekoppeld === false && H.appInfo().tel.ingericht === true, H.appInfo().tel);
    // opname herkennen
    toets('6 opname: MPEG4 duur uit mvhd, WAV uit de kop, rest null', Math.abs(H.telOpname(mp4Maak(12.5)).s - 12.5) < 0.01 && Math.abs(H.telOpname(wavMaak(2)).s - 2) < 0.01 && H.telOpname(Buffer.from('#!AMR\n')) === null);
    toets('6 spreektekst zonder inhoud: vaste zin', H.telSpreektekst('Verder in de app:\nalles') === 'Ik heb een antwoord voor je in de app.');
    toets('6 wv1035: "VRAAG AAN DAVID: geen." -> geen "ik heb een vraag"', H.telSpreektekst('Klaar.\n\n**VRAAG AAN DAVID:** geen.') === 'Klaar.' && /Ik heb een vraag voor je in de app\.$/.test(H.telSpreektekst('Klaar.\n\nVRAAG AAN DAVID: Zal ik verder?')), JSON.stringify([H.telSpreektekst('Klaar.\n\n**VRAAG AAN DAVID:** geen.'), H.telSpreektekst('Klaar.\n\nVRAAG AAN DAVID: Zal ik verder?')]));
    toets('6 spreektekst: oude regel "Verder in Telegram" knipt nog (wv571)', H.telSpreektekst('Kern.\n\nVerder in Telegram:\n- bedrag') === 'Kern.', H.telSpreektekst('Kern.\n\nVerder in Telegram:\n- bedrag'));
    toets('6 geen onverwachte fouten in logError', !logs.some((l) => !/^(app-|tel-whisper|tel-deel)/.test(l) || /uitzondering/.test(l)), logs);

    // ── 8. Onderweg naast Tasker (wv3700) ──
    H.appStaat.tellers['tel-koppel'] = []; H.appStaat.tellers['tel-codes'] = []; H.appStaat.tellers['tel-beurt'] = []; H.appStaat.tellers['tel-beurtdag'] = [];
    for (const k of Object.keys(ketens)) delete ketens[k];   // de beurt van de nagebootste crash (6) hangt nog in de keten
    const koppel = async (body, ct) => { const sx = sessie(PIXEL, 'credP', true); const c = (await app('POST', '/app/tel/koppelcode', {}, { apparaat: PIXEL, sessie: sx })).j.code;
      return verzoek('POST', '/tel/koppel', ct ? { 'content-type': ct } : {}, body(c)); };
    const kT = await koppel((c) => c);
    const kO = await koppel((c) => JSON.stringify({ code: c, app: 'onderweg' }), 'application/json');
    const TK = kT.j.sleutel, OW = kO.j.sleutel;
    toets('8 Tasker (kale code) en Onderweg (app onderweg) allebei gekoppeld', kT.status === 200 && kO.status === 200 && TK && OW && TK !== OW, { t: kT.j, o: kO.j });
    toets('8 Onderweg-koppeling trekt Tasker niet in', (await tel('GET', '/tel/uit', { sleutel: TK })).status === 200 && (await tel('GET', '/tel/uit', { sleutel: OW })).status === 200);
    toets('8 Telegram noemt de app Onderweg', st.telegram.some((t) => /de app Onderweg op de telefoon is gekoppeld/.test(t)), st.telegram.slice(-2));
    let reg8 = JSON.parse(fs.readFileSync(path.join(DATA, 'tel-apparaten.json'), 'utf8'));
    toets('8 register: één actieve Tasker- en één actieve Onderweg-rij', reg8.apparaten.filter((x) => x.actief && x.soort === 'onderweg').length === 1 && reg8.apparaten.filter((x) => x.actief && x.soort !== 'onderweg').length === 1, reg8.apparaten.map((x) => [x.naam, x.soort, x.actief]));
    const kT2 = await koppel((c) => JSON.stringify({ code: c }), 'application/json');
    toets('8 Tasker opnieuw koppelen (zonder app): oude Tasker 401, Onderweg blijft (Codex MOET 2)', kT2.status === 200 && (await tel('GET', '/tel/uit', { sleutel: TK })).status === 401 && (await tel('GET', '/tel/uit', { sleutel: OW })).status === 200);
    const TK2 = kT2.j.sleutel;
    const kO2 = await koppel((c) => JSON.stringify({ code: c, app: 'onderweg' }), 'application/json');
    toets('8 Onderweg opnieuw koppelen: oude Onderweg 401, Tasker blijft', kO2.status === 200 && (await tel('GET', '/tel/uit', { sleutel: OW })).status === 401 && (await tel('GET', '/tel/uit', { sleutel: TK2 })).status === 200);
    const OW2 = kO2.j.sleutel;
    const kX = await koppel((c) => JSON.stringify({ code: c, app: 'iets-anders' }), 'application/json');
    toets('8 onbekende app telt als Tasker', kX.status === 200 && (await tel('GET', '/tel/uit', { sleutel: TK2 })).status === 401 && (await tel('GET', '/tel/uit', { sleutel: OW2 })).status === 200);
    const TK3 = kX.j.sleutel;
    // voorjou
    Object.keys(H.appStaat.sessies).forEach((h) => delete H.appStaat.sessies[h]);
    r = await tel('GET', '/tel/uit?lijst=voorjou', { sleutel: TK3 });
    toets('8 voorjou met een Tasker-sleutel: 404', r.status === 404, r.j);
    // wv3976: Onderweg zonder app-sessie toetst § 8x
    r = await tel('GET', '/tel/uit?lijst=iets', { sleutel: OW2 });
    toets('8 onbekende lijst: 400', r.status === 400, r.j);
    sessie(PIXEL, 'credP', false);
    H.__zet('appVjPunten', async () => [
      { id: 11, sleutel: 'k11', soort: 'besluit', status: 'open', titel: 'Zal ik **iets** doen?', herkomst: {} },
      { id: 12, sleutel: 'k12', soort: 'doen', status: 'open', titel: 'Klusje', herkomst: {} },
      { id: 13, sleutel: 'k13', soort: 'besluit', status: 'gedaan', titel: 'Al dicht?', herkomst: {} }]);
    r = await tel('GET', '/tel/uit?lijst=voorjou', { sleutel: OW2 });
    toets('8 voorjou: alleen open besluitkaarten, zonder opmaak', r.status === 200 && Array.isArray(r.j.voorjou) && r.j.voorjou.length === 1 && r.j.voorjou[0].id === 11 && !/\*\*/.test(r.j.voorjou[0].titel) && r.j.voorjou[0].vraag, r.j);
    toets('8 voorjou zet geen hartslag en geen plek', !H.telStaat.plek[H.telStaat.soort ? Object.keys(H.telStaat.soort).find((k) => H.telStaat.soort[k] === 'onderweg') : ''], H.telStaat.plek);
    H.__zet('appVjPunten', async () => { throw new Error('databank weg'); });
    r = await tel('GET', '/tel/uit?lijst=voorjou', { sleutel: OW2 });
    toets('8 voorjou als de lijst niet te lezen is: 503', r.status === 503, r.j);
    // beurt via Onderweg: verstaan, tekst, wedervraag, rest; Tasker krijgt de extra velden niet
    r = await tel('POST', '/tel/beurt', { sleutel: OW2, ct: 'text/plain', body: 'Wat staat er vandaag in mijn agenda?' });
    toets('8 beurt via Onderweg: 202 met verstaan', r.status === 202 && r.j.verstaan === 'Wat staat er vandaag in mijn agenda?', r.j);
    const id8O = r.j.id; await tik();
    afmaken[id8O]('Je hebt om 10 uur overleg. Zal ik het verzetten?\n\nVerder in de app:\n- details');
    await tik();
    r = await tel('GET', '/tel/uit', { sleutel: OW2 });
    toets('8 uitgifte voor Onderweg: tekst, wedervraag ja, rest ja, knopvraag nee', r.j.id === id8O && /10 uur overleg/.test(r.j.tekst) && !/details/.test(r.j.tekst) && r.j.wedervraag === 'ja' && r.j.rest === 'ja' && r.j.knopvraag === 'nee', r.j);
    await tel('POST', '/tel/gespeeld/' + id8O, { sleutel: OW2 });
    r = await tel('POST', '/tel/beurt', { sleutel: TK3, ct: 'text/plain', body: 'vraag via Tasker' });
    toets('8 beurt via Tasker: 202 zonder verstaan', r.status === 202 && r.j.verstaan === undefined, r.j);
    const id8T = r.j.id; await tik();
    afmaken[id8T]('Klaar.\n\nVRAAG AAN DAVID: Zal ik verder?'); await tik();
    r = await tel('GET', '/tel/uit', { sleutel: OW2 });
    toets('8 antwoord op de Tasker-vraag gaat niet naar Onderweg', !r.j.id, r.j);
    r = await tel('GET', '/tel/uit', { sleutel: TK3 });
    toets('8 uitgifte voor Tasker: zonder tekst/wedervraag (zoals voorheen)', r.j.id === id8T && r.j.tekst === undefined && r.j.wedervraag === undefined, r.j);
    await tel('POST', '/tel/gespeeld/' + id8T, { sleutel: TK3 });
    toets('8 knopvraag-veld: vaste vraagzin = knopvraag ja, geen wedervraag', (function () { const v = H.telOnderwegVelden({ soort: 'antwoord', spreek: H.telSpreektekst('Klaar.\n\nVRAAG AAN DAVID: Zal ik verder?') }); return v.knopvraag === 'ja' && v.wedervraag === 'nee'; })());
    // telActief: wie plek Auto meldt gaat voor, bij gelijkspel Onderweg
    await tel('GET', '/tel/uit?plek=Auto', { sleutel: TK3 });
    await tel('GET', '/tel/uit?plek=Thuis', { sleutel: OW2 });
    toets('8 zelf-belletje: Tasker als alleen die plek Auto meldt', H.telAanwezig().ok && H.telAanwezig().t.soort !== 'onderweg', H.telAanwezig());
    await tel('GET', '/tel/uit?plek=Auto', { sleutel: OW2 });
    toets('8 zelf-belletje: Onderweg als beide in de auto zijn', H.telAanwezig().ok && H.telAanwezig().t.soort === 'onderweg', H.telAanwezig());
    const inf8 = H.telInfo();
    toets('8 /health: Tasker-versie blijft, Onderweg apart', inf8.gekoppeld === true && inf8.onderweg && inf8.onderweg.luistert === true, inf8);
    // ── 8b. wv3770: dagbericht zonder wachten en de vraagzin voor het autodashboard ──
    H.appStaat.tellers['tel-alles'] = [];
    r = await tel('GET', '/tel/uit?lijst=dagbericht', { sleutel: TK3 });
    toets('8b dagbericht met een Tasker-sleutel: 404', r.status === 404, r.j);
    Object.keys(H.appStaat.sessies).forEach((h) => delete H.appStaat.sessies[h]);
    // wv3976: Onderweg zonder app-sessie toetst § 8x
    sessie(PIXEL, 'credP', false);
    const ymd = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
    const HOOFD = path.join(LOGDIR, 'hoofd.jsonl');
    fs.mkdirSync(LOGDIR, { recursive: true });
    const hoofdVoor = fs.existsSync(HOOFD) ? fs.readFileSync(HOOFD, 'utf8') : '';
    r = await tel('GET', '/tel/uit?lijst=dagbericht', { sleutel: OW2 });
    toets('8b geen briefing: dagbericht null', r.status === 200 && r.j.ok === true && r.j.dagbericht === null, r.j);
    r = await tel('GET', '/tel/uit?lijst=dagbericht&audio=1', { sleutel: OW2 });
    toets('8b geen briefing: audio 404 met zin', r.status === 404 && /dagbericht/.test(r.j.fout), r.j);
    // briefing van gisteren met stem: telt niet
    const BEW = path.join(W, 'bew'), MP3 = Buffer.concat([Buffer.from('ID3'), crypto.randomBytes(5000)]);
    const zetBriefing = (t, jobT, jobS, naam) => {
      fs.appendFileSync(HOOFD, JSON.stringify({ soort: 'socev', bron: 'briefing', klasse: 'normaal', job_id: jobT, t: new Date(t).toISOString(), antwoord: '**🌅 Ochtendbericht**\n\n**Goedemorgen David, proefdag**\n- Om 9 uur overleg.' }) + '\n' +
        JSON.stringify({ soort: 'socev', bron: 'briefing', klasse: 'stil', job_id: jobS, t: new Date(t + 30000).toISOString(), antwoord: '🔊 Ochtendbriefing' }) + '\n');
      const d = path.join(BEW, ymd(t), jobS); fs.mkdirSync(path.join(d, 'b'), { recursive: true });
      fs.writeFileSync(path.join(d, 'b', '1'), MP3);
      fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ job_id: jobS, soort: 'socev', kanaal: 'hoofd', label: 'briefing', ok: true, op: new Date(t + 30000).toISOString(), bestanden: [{ n: 1, naam: naam, grootte: MP3.length }] }));
      H.appStaat.bestandenIndex = null;
    };
    zetBriefing(Date.now() - 26 * 3600000, 'a1a1a1a1a1a1a1a1', 'b1b1b1b1b1b1b1b1', 'ochtendbriefing-gisteren.mp3');
    r = await tel('GET', '/tel/uit?lijst=dagbericht', { sleutel: OW2 });
    toets('8b alleen een dagbericht van gisteren: null', r.status === 200 && r.j.dagbericht === null, r.j);
    zetBriefing(Date.now() - 60000, 'a2a2a2a2a2a2a2a2', 'b2b2b2b2b2b2b2b2', 'ochtendbriefing-vandaag.mp3');
    r = await tel('GET', '/tel/uit?lijst=dagbericht', { sleutel: OW2 });
    toets('8b dagbericht van vandaag: dag en grootte, geen pad of job', r.status === 200 && r.j.dagbericht && r.j.dagbericht.dag === ymd(Date.now()) && r.j.dagbericht.grootte === MP3.length && !/bew|b2b2|pad/.test(JSON.stringify(r.j)), r.j);
    r = await tel('GET', '/tel/uit?lijst=dagbericht&audio=1', { sleutel: OW2 });
    toets('8b audio=1: de mp3 zelf, audio/mpeg', r.status === 200 && /audio\/mpeg/.test(r.ct) && Buffer.compare(r.b, MP3) === 0, { status: r.status, ct: r.ct, n: r.b && r.b.length });
    toets('8b de app-route /app/briefing gebruikt dezelfde lader (stem van vandaag)', (await H.appBriefingLaad()).stem[0] === 'b2b2b2b2b2b2b2b2');
    H.appStaat.tellers['tel-dagbericht'] = Array(40).fill(Date.now());
    r = await tel('GET', '/tel/uit?lijst=dagbericht', { sleutel: OW2 });
    toets('8b grens per uur: 429', r.status === 429, r.j);
    H.appStaat.tellers['tel-dagbericht'] = [];
    fs.writeFileSync(HOOFD, hoofdVoor);
    // vraagzin
    const A1 = 'Klaar.\n\n**VRAAG AAN DAVID:** Zal ik de **afspraak** verzetten?\n\nVerder in de app:\n- details';
    const v1 = H.telOnderwegVelden({ soort: 'antwoord', spreek: H.telSpreektekst(A1), vraag: H.telVraagzin(A1) });
    toets('8b vraagzin: zonder opmaak, knopvraag ja', v1.knopvraag === 'ja' && v1.vraagzin === 'Zal ik de afspraak verzetten?', v1);
    toets('8b vraagzin: "geen" telt niet, na "Verder in de app" telt niet', H.telVraagzin('Klaar.\n\nVRAAG AAN DAVID: geen.') === null && H.telVraagzin('Klaar.\n\nVerder in de app:\nVRAAG AAN DAVID: Zal ik?') === null);
    toets('8b vraagzin leeg zonder knopvraag', H.telOnderwegVelden({ soort: 'antwoord', spreek: 'Klaar.', vraag: 'Zal ik?' }).vraagzin === '');
    r = await tel('POST', '/tel/beurt', { sleutel: OW2, ct: 'text/plain', body: 'Moet ik nog iets?' });
    const id8V = r.j.id; await tik();
    afmaken[id8V]('Eén ding.\n\nVRAAG AAN DAVID: Zal ik de mail klaarzetten?'); await tik();
    r = await tel('GET', '/tel/uit', { sleutel: OW2 });
    toets('8b uitgifte voor Onderweg: vraagzin bij een knopvraag', r.j.id === id8V && r.j.knopvraag === 'ja' && r.j.vraagzin === 'Zal ik de mail klaarzetten?', r.j);
    await tel('POST', '/tel/gespeeld/' + id8V, { sleutel: OW2 });
    // ── 8c. wv3771: klaargezet antwoord uit de auto op de kaart (378 + 466) en de kaart ingesproken ──
    H.appStaat.tellers['tel-alles'] = [];
    H.__zet('appVjPunten', async () => [
      { id: 11, sleutel: 'k11', soort: 'besluit', status: 'open', titel: 'Zal ik **iets** doen?', herkomst: {} },
      { id: 12, sleutel: 'k12', soort: 'doen', status: 'open', titel: 'Klusje', herkomst: {} },
      { id: 13, sleutel: 'k13', soort: 'besluit', status: 'gedaan', titel: 'Al dicht?', herkomst: {} }]);
    const VS = path.join(DATA, 'tel-voorstellen.json');
    const vragenPad = path.join(DATA, 'vragen.json');
    const vragenVoor = fs.existsSync(vragenPad) ? fs.readFileSync(vragenPad, 'utf8') : null;
    r = await tel('GET', '/tel/uit?lijst=voorjou', { sleutel: OW2 });
    const TID = r.j.voorjou && r.j.voorjou[0] && r.j.voorjou[0].tekst_id;
    toets('8c voorjou geeft tekst_id en nog geen klaargezet antwoord', r.status === 200 && /^[a-f0-9]{8}$/.test(String(TID)) && r.j.voorjou[0].auto === null, r.j);
    const vst = (id, body, sl) => tel('GET', '/tel/uit?lijst=voorstel&id=' + id + '&keuze=' + encodeURIComponent(body.keuze) + '&tekst_id=' + encodeURIComponent(body.tekst_id), { sleutel: sl || OW2 });
    r = await vst(11, { keuze: 'ja', tekst_id: TID }, TK3);
    toets('8c voorstel met een Tasker-sleutel: 404', r.status === 404, r.j);
    Object.keys(H.appStaat.sessies).forEach((h) => delete H.appStaat.sessies[h]);
    // wv3976: Onderweg zonder app-sessie toetst § 8x
    const sP8 = sessie(PIXEL, 'credP', false);
    r = await vst(11, { keuze: 'misschien', tekst_id: TID });
    toets('8c onbekende keuze: 400', r.status === 400, r.j);
    r = await vst(11, { keuze: 'ja', tekst_id: 'deadbeef' === TID ? 'feedbeef' : 'deadbeef' });
    toets('8c andere tekst_id (vraag veranderd): 409, niets opgeslagen', r.status === 409 && /veranderd/.test(r.j.fout) && !fs.existsSync(VS), r.j);
    r = await vst(13, { keuze: 'ja', tekst_id: TID });
    toets('8c gesloten kaart: 409', r.status === 409, r.j);
    r = await vst(12, { keuze: 'ja', tekst_id: TID });
    toets('8c doe-kaart (geen besluit): 409', r.status === 409, r.j);
    const gestartVoor = gestart.length, chatVoor = st.chatlog.length, urlsVoor = st.urls.length;
    r = await vst(11, { keuze: 'ja', tekst_id: TID });
    toets('8c voorstel ja: 200', r.status === 200 && r.j.ok === true && r.j.auto === 'ja', r.j);
    const vsJ = JSON.parse(fs.readFileSync(VS, 'utf8'));
    toets('8c voorstelbestand 0600, alleen keuze/tekst_id/t/apparaat (geen inhoud)', (fs.statSync(VS).mode & 0o777) === 0o600 && Object.keys(vsJ.items['11']).sort().join() === 'apparaat,keuze,t,tekst_id' && !/iets|Zal ik/.test(JSON.stringify(vsJ)), vsJ);
    toets('8c EEN VOORSTEL IS GEEN KNOPDRUK: geen beurt, geen chat_log, vragen.json gelijk, geen databank/n8n', gestart.length === gestartVoor && st.chatlog.length === chatVoor &&
      (fs.existsSync(vragenPad) ? fs.readFileSync(vragenPad, 'utf8') : null) === vragenVoor && st.urls.slice(urlsVoor).every((u) => !/sb\.toets|n8n|telegram/.test(u)), { beurten: gestart.length - gestartVoor, urls: st.urls.slice(urlsVoor) });
    r = await tel('GET', '/tel/uit?lijst=voorjou', { sleutel: OW2 });
    toets('8c voorjou toont het klaargezette antwoord', r.j.voorjou && r.j.voorjou[0].auto === 'ja', r.j);
    r = await app('GET', '/app/voor-jou/kanaal', undefined, { apparaat: PIXEL, sessie: sP8 });
    const p11 = r.j.punten && r.j.punten.find((x) => x.id === 11), p12 = r.j.punten && r.j.punten.find((x) => x.id === 12);
    toets('8c app-lijst: kaart 11 met auto {keuze ja, tekst_id}, doe-kaart zonder', r.status === 200 && p11 && p11.auto && p11.auto.keuze === 'ja' && p11.auto.tekst_id === TID && p12 && p12.auto === undefined, { status: r.status, p11, p12, fout: r.j.fout });
    toets('8c app-lijst: kaart blijft open en onbeantwoord', p11 && !p11.beantwoord && p11.status === 'open', p11);
    r = await app('GET', '/app/voor-jou/11', undefined, { apparaat: PIXEL, sessie: sP8 });
    toets('8c app-detail: auto naast de gewone knop (zelfde tekst_id, knop kan nog)', r.status === 200 && r.j.auto && r.j.auto.keuze === 'ja' && r.j.knop && r.j.knop.kan === true && r.j.knop.tekst_id === r.j.auto.tekst_id, { status: r.status, auto: r.j.auto, knop: r.j.knop });
    r = await vst(11, { keuze: 'nee', tekst_id: TID });
    toets('8c nee vervangt ja', r.status === 200 && JSON.parse(fs.readFileSync(VS, 'utf8')).items['11'].keuze === 'nee', r.j);
    r = await vst(11, { keuze: 'weg', tekst_id: TID });
    toets('8c weg (Later) wist het voorstel', r.status === 200 && r.j.auto === null && !JSON.parse(fs.readFileSync(VS, 'utf8')).items['11'], r.j);
    // 48 uur
    fs.writeFileSync(VS, JSON.stringify({ versie: 1, items: { 11: { keuze: 'ja', tekst_id: TID, t: new Date(Date.now() - 49 * 3600000).toISOString(), apparaat: 'x' } } }));
    r = await tel('GET', '/tel/uit?lijst=voorjou', { sleutel: OW2 });
    toets('8c ouder dan 48 uur telt niet meer', r.j.voorjou && r.j.voorjou[0].auto === null, r.j);
    H.appStaat.tellers['tel-voorstel'] = Array(130).fill(Date.now());
    r = await vst(11, { keuze: 'ja', tekst_id: TID });
    toets('8c grens per uur: 429', r.status === 429, r.j);
    H.appStaat.tellers['tel-voorstel'] = [];
    // kaartstem
    r = await tel('GET', '/tel/uit?lijst=kaartstem&id=11', { sleutel: TK3 });
    toets('8c kaartstem met een Tasker-sleutel: 404', r.status === 404, r.j);
    Object.keys(H.appStaat.sessies).forEach((h) => delete H.appStaat.sessies[h]);
    // wv3976: Onderweg zonder app-sessie toetst § 8x
    sessie(PIXEL, 'credP', false);
    const ttsVoor = st.tts.length;
    r = await tel('GET', '/tel/uit?lijst=kaartstem&id=11', { sleutel: OW2 });
    toets('8c kaartstem: wav met titel en vraag, zonder opmaak', r.status === 200 && /audio\/wav/.test(r.ct) && st.tts.length === ttsVoor + 1 && /Zal ik iets doen\?/.test(st.tts[st.tts.length - 1]) && !/\*\*/.test(st.tts[st.tts.length - 1]), { status: r.status, tekst: st.tts.slice(ttsVoor) });
    r = await tel('GET', '/tel/uit?lijst=kaartstem&id=11', { sleutel: OW2 });
    toets('8c kaartstem tweede keer uit het geheugen (geen nieuwe Gemini-aanroep)', r.status === 200 && st.tts.length === ttsVoor + 1, st.tts.length - ttsVoor);
    r = await tel('GET', '/tel/uit?lijst=kaartstem&id=13', { sleutel: OW2 });
    toets('8c kaartstem van een gesloten kaart: 404', r.status === 404, r.j);
    r = await tel('GET', '/tel/uit?lijst=kaartstem&id=abc', { sleutel: OW2 });
    toets('8c kaartstem ongeldig id: 400', r.status === 400, r.j);
    H.telStaat.kaartstem = {};
    H.appStaat.tellers['tel-kaartstem'] = Array(40).fill(Date.now());
    r = await tel('GET', '/tel/uit?lijst=kaartstem&id=11', { sleutel: OW2 });
    toets('8c kaartstem dagplafond: 429', r.status === 429, r.j);
    H.appStaat.tellers['tel-kaartstem'] = [];
    toets('8c geen onverwachte fouten (wv3771)', !logs.some((l) => /tel-voorstel|tel-kaartstem/.test(l)), logs.filter((l) => /tel-voorstel|tel-kaartstem/.test(l)));
    // ── 8r. wv3779: ritten onthouden (nr 324) en GET /app/ritten (nr 426) ──
    const RITF = path.join(DATA, 'tel-ritten.json');
    const ritLees = () => JSON.parse(fs.readFileSync(RITF, 'utf8'));
    try { fs.unlinkSync(RITF); } catch (e) {}
    H.telStaat.ritten = null;
    await tel('GET', '/tel/uit?plek=Auto', { sleutel: TK3 });
    toets('8r Tasker meldt Auto: geen rit', !fs.existsSync(RITF) && H.telInfo().onderweg.rijdt === false, H.telInfo().onderweg);
    await tel('GET', '/tel/uit?plek=Weg', { sleutel: OW2 });
    toets('8r Onderweg zonder ritdienst (plek Weg): geen rit', !fs.existsSync(RITF));
    const tA = Date.now();
    await tel('GET', '/tel/uit?plek=Auto', { sleutel: OW2 });
    let inf = H.telInfo().onderweg;
    toets('8r Onderweg meldt Auto: rit open, /health rijdt en sinds', inf.rijdt === true && Math.abs(Date.parse(inf.sinds) - tA) < 2000, inf);
    let rf = ritLees();
    toets('8r bestand 0600, alleen begin/eind/soort (geen apparaat, plek of inhoud)', (fs.statSync(RITF).mode & 0o777) === 0o600 && JSON.stringify(Object.keys(rf).sort()) === '["open","ritten","versie"]' &&
      JSON.stringify(Object.keys(rf.open).sort()) === '["begin","laatst","soort"]' && rf.open.soort === 'onderweg' && !/[0-9a-f]{16}/.test(JSON.stringify(rf)), rf);
    // herstart: verse context, zelfde opslag
    H = laad();
    sessie(PIXEL, 'credP', false);
    inf = H.telInfo().onderweg;
    toets('8r na een herstart rijdt hij nog (sinds gelijk)', inf.rijdt === true && Math.abs(Date.parse(inf.sinds) - tA) < 2000, inf);
    // 2 min stil, dan weer Auto: dezelfde rit
    H.telRitLaad().open.laatst -= 2 * 60000;
    await tel('GET', '/tel/uit?plek=Auto', { sleutel: OW2 });
    inf = H.telInfo().onderweg;
    toets('8r Auto na 2 min stilte: dezelfde rit', inf.rijdt === true && Math.abs(Date.parse(inf.sinds) - tA) < 2000 && H.telRitLaad().ritten.length === 0, H.telRitLaad());
    // > 3 min geen Auto (telefoon stil): dicht, eind = laatste Auto
    H.telRitLaad().open.begin -= 30 * 60000; H.telRitLaad().open.laatst -= 4 * 60000;
    const eindVerwacht = H.telRitLaad().open.laatst;
    H.telOpruim();   // ook zonder melding (de minuuttik roept telOpruim); daarna alleen het bestand meten (geen lezer die zelf sluit; Codex ZOU 2)
    rf = ritLees();
    toets('8r telefoon stil > 3 min: telOpruim sluit de rit, eind = laatste Auto (bestand)', rf.open === null && rf.ritten.length === 1 && Date.parse(rf.ritten[0].eind) === eindVerwacht, rf);
    // plek Weg verlengt niet
    await tel('GET', '/tel/uit?plek=Auto', { sleutel: OW2 });
    H.telRitLaad().open.laatst -= 4 * 60000;
    await tel('GET', '/tel/uit?plek=Weg', { sleutel: OW2 });
    toets('8r plek Weg verlengt de rit niet; > 3 min = dicht', H.telRitNu().rijdt === false && H.telRitLaad().ritten.length === 2, H.telRitLaad());
    // Auto na > 3 min: nieuwe rit
    await tel('GET', '/tel/uit?plek=Auto', { sleutel: OW2 });
    toets('8r Auto na een dichte rit: nieuwe rit', H.telRitNu().rijdt === true && H.telRitLaad().ritten.length === 2 && H.telRitten(10).length === 3 && H.telRitten(10)[0].loopt === true, H.telRitten(10));
    // bewaren: 90 dagen, hooguit 500
    const oudR = []; for (let i = 0; i < 520; i++) oudR.push({ begin: new Date(Date.now() - (600 - i) * 3600000).toISOString(), eind: new Date(Date.now() - (600 - i) * 3600000 + 60000).toISOString(), soort: 'onderweg' });
    oudR.unshift({ begin: new Date(Date.now() - 100 * 86400000).toISOString(), eind: new Date(Date.now() - 100 * 86400000 + 60000).toISOString(), soort: 'onderweg' });
    fs.writeFileSync(RITF, JSON.stringify({ versie: 1, open: null, ritten: oudR }));
    H.telStaat.ritten = null; H.telRitNu();
    toets('8r bewaren: ouder dan 90 dagen weg, hooguit 500', ritLees().ritten.length === 500 && Date.now() - Date.parse(ritLees().ritten[0].begin) < 90 * 86400000, ritLees().ritten.length);
    // GET /app/ritten
    const m = 60000, T = Date.now();
    fs.writeFileSync(RITF, JSON.stringify({ versie: 1, open: null, ritten: [
      { begin: new Date(T - 300 * m).toISOString(), eind: new Date(T - 280 * m).toISOString(), soort: 'onderweg' },   // rit 1: zonder vraag
      { begin: new Date(T - 120 * m).toISOString(), eind: new Date(T - 90 * m).toISOString(), soort: 'onderweg' },    // rit 2
      { begin: new Date(T - 40 * m).toISOString(), eind: new Date(T - 20 * m).toISOString(), soort: 'onderweg' },     // rit 3
      { begin: new Date(T - 15 * m).toISOString(), eind: new Date(T - 15 * m).toISOString(), soort: 'onderweg' }] })); // losse Auto-tik
    H.telStaat.ritten = null;
    const HOOFDr = path.join(LOGDIR, 'hoofd.jsonl');
    const hoofdVoorR = fs.existsSync(HOOFDr) ? fs.readFileSync(HOOFDr, 'utf8') : '';
    const regel = (job, tMin, extra) => JSON.stringify(Object.assign({ t: new Date(T + tMin * m + 5000).toISOString(), getypt: new Date(T + tMin * m).toISOString(), job_id: job, beurt_id: null, soort: 'tel', apparaat: PIXEL, ok: true, bestanden: [] }, extra)) + '\n';
    fs.writeFileSync(HOOFDr,   // alleen deze regels (eerdere secties schreven ook tel-beurten van nu)
      regel('e1e1e1e1e1e1e1e1', -110, { tekst: '[AUTO] Wat staat er morgen in mijn proefagenda?', antwoord: 'Morgen om tien uur proefoverleg.\n\n**Verder in de app:**\n- Proefdetail één\n- Proefdetail twee' }) +
      regel('e2e2e2e2e2e2e2e2', -80, { tekst: '[AUTO] Nog een proefvraag na de rit', antwoord: 'Alles voorgelezen.' }) +
      regel('e3e3e3e3e3e3e3e3', -60, { tekst: '[AUTO] Te laat voor rit 2', antwoord: 'Hoort nergens bij.' }) +
      regel('e4e4e4e4e4e4e4e4', -30, { tekst: '[AUTO] Vraag in rit 3', antwoord: 'Antwoord drie.', ok: false }) +
      regel('e5e5e5e5e5e5e5e5', -35, { soort: 'bericht', tekst: 'Getypt tijdens rit 3', antwoord: 'Geen autobeurt.' }));
    const idBezig = 'f0f0f0f0f0f0f0f0';
    jobs[idBezig] = { status: 'running', created: T - 25 * m, app: { tekst: '[AUTO] Loopt nog in rit 3' } };
    H.telRij().push({ id: idBezig, apparaat: 'x', soort: 'bezig', t_start: T - 25 * m, tot: T + 20 * m, k: {} });
    r = await app('GET', '/app/ritten', undefined, { apparaat: PIXEL, sessie: 'f'.repeat(64) });
    toets('8r /app/ritten zonder geldige sessie: geweigerd, geen ritten', r.status >= 400 && !r.j.ritten, { status: r.status, j: r.j });
    const sR = sessie(PIXEL, 'credP', false);
    r = await app('GET', '/app/ritten', undefined, { apparaat: PIXEL, sessie: sR });
    const rt = r.j.ritten || [];
    toets('8r /app/ritten: 200, nieuwste eerst, losse Auto-tik zonder vraag weg', r.status === 200 && rt.length === 3 && Date.parse(rt[0].begin) === T - 40 * m && rt[0].eind === new Date(T - 20 * m).toISOString() && r.j.rijdt === false, r.j);
    const r2 = rt[1] || { beurten: [] };
    toets('8r rit 2: vraag in de rit en binnen 15 min erna, niet daarna', JSON.stringify(r2.beurten.map((b) => b.job_id)) === '["e1e1e1e1e1e1e1e1","e2e2e2e2e2e2e2e2"]', r2.beurten.map((b) => b.job_id));
    const b1 = r2.beurten[0] || {};
    toets('8r vraag zonder [AUTO]', b1.vraag === 'Wat staat er morgen in mijn proefagenda?', b1);
    toets('8r knip: voorgelezen tot "Verder in de app", rest zonder die kop', b1.voorgelezen === 'Morgen om tien uur proefoverleg.' && b1.rest === '- Proefdetail één\n- Proefdetail twee', b1);
    toets('8r alles voorgelezen: rest leeg', r2.beurten[1] && r2.beurten[1].rest === '' && r2.beurten[1].voorgelezen === 'Alles voorgelezen.', r2.beurten[1]);
    const r3 = rt[0] || { beurten: [] };
    toets('8r rit 3: mislukte beurt (ok false) en wat nog loopt; getypt bericht niet', r3.beurten.length === 2 && r3.beurten[0].job_id === 'e4e4e4e4e4e4e4e4' && r3.beurten[0].ok === false &&
      r3.beurten[1].job_id === idBezig && r3.beurten[1].bezig === true && r3.beurten[1].vraag === 'Loopt nog in rit 3', r3.beurten);
    toets('8r rit 1 zonder vragen staat er (20 min) met lege lijst', rt[2] && rt[2].beurten.length === 0, rt[2]);
    toets('8r e3 (> 15 min na rit 2, vóór rit 3) hoort bij geen rit', !JSON.stringify(rt).includes('e3e3e3e3e3e3e3e3'));
    // lopende rit: eind null, venster tot nu
    await tel('GET', '/tel/uit?plek=Auto', { sleutel: OW2 });
    r = await app('GET', '/app/ritten', undefined, { apparaat: PIXEL, sessie: sR });
    toets('8r lopende rit vooraan: loopt, eind null, rijdt', r.status === 200 && r.j.rijdt === true && r.j.ritten[0].loopt === true && r.j.ritten[0].eind === null, r.j.ritten && r.j.ritten[0]);
    const iB = H.telRij().findIndex((x) => x.id === idBezig); if (iB >= 0) H.telRij().splice(iB, 1); delete jobs[idBezig];
    fs.writeFileSync(HOOFDr, hoofdVoorR);
    toets('8r geen fouten in logError (rit)', !logs.some((l) => /tel-rit|app-ritten/.test(l)), logs.filter((l) => /rit/.test(l)));
    // ── 8s. wv3826: snelle vraag uit de auto (434, Zoek snel; geen Socev-beurt) en Te lezen voorlezen (484) ──
    H.appStaat.tellers['tel-alles'] = [];
    sessie(PIXEL, 'credP', false);
    const telS = (o) => { const k = { 'cf-access-jwt-assertion': jwt(), authorization: 'Bearer ' + (o.sleutel || OW2), 'content-type': o.ct || 'audio/mp4', 'x-tel-snel': o.kop === undefined ? '1' : o.kop };
      const b = o.body || mp4Maak(2); k['content-length'] = String(Buffer.byteLength(b)); return verzoek('POST', '/tel/beurt', k, b); };
    const gestartS = gestart.length, chatS = st.chatlog.length, sttS = st.stt.length;
    r = await telS({ sleutel: TK3 });
    toets('8s snel met een Tasker-sleutel: 404 (Tasker krijgt nooit Zoek snel)', r.status === 404, r.j);
    r = await telS({ kop: 'ja' });
    toets('8s snel met een rare kopwaarde: 404', r.status === 404, r.j);
    r = await telS({});
    toets('8s snel op een pod zonder Zoek snel: 404 met zin', r.status === 404 && /snelle vraag/.test(r.j.fout), r.j);
    const zsAanroep = [];
    let zsAan = false, zsUit = null, zsWacht = null;
    H.__zet('zoekSnel', {});
    H.__zet('zoekSnelAan', () => zsAan);
    H.__zet('zoekSnelVoer', async (a, id, vraag, toon) => { zsAanroep.push({ a: a.id, id, vraag, toon }); if (zsWacht) await zsWacht; if (zsUit instanceof Error) throw zsUit; return zsUit; });
    r = await telS({});
    toets('8s Zoek snel uit: 409 met zin, Whisper niet aangeroepen', r.status === 409 && /Zoek snel staat uit/.test(r.j.fout) && st.stt.length === sttS, { r: r.j, stt: st.stt.length - sttS });
    zsAan = true;
    Object.keys(H.appStaat.sessies).forEach((h) => delete H.appStaat.sessies[h]);
    // wv3976: Onderweg zonder app-sessie toetst § 8x
    sessie(PIXEL, 'credP', false);
    st.sttTekst = 'Wat is mijn kenteken';
    let vrij; zsWacht = new Promise((ok) => { vrij = ok; });
    zsUit = { status: 200, j: { ok: true, soort: 'antwoord', tekst: 'Je kenteken is AB-12-CD.', waarden: [{ label: 'kenteken', waarde: 'AB-12-CD' }, { label: 'garage', waarde: '0612345678' }] } };
    r = await telS({});
    const idS = r.j.id;
    toets('8s snel: 202 met id, verstaan en snel ja', r.status === 202 && /^[0-9a-f]{16}$/.test(String(idS)) && r.j.verstaan === 'Wat is mijn kenteken' && r.j.snel === 'ja', r.j);
    await tik();
    toets('8s zoekSnelVoer met de app-Pixel, de vraag en toon_dekking', zsAanroep.length === 1 && zsAanroep[0].a === PIXEL && zsAanroep[0].id === idS && zsAanroep[0].vraag === 'Wat is mijn kenteken' && zsAanroep[0].toon === true, zsAanroep);
    toets('8s GEEN Socev-beurt en GEEN chat_log-rij', gestart.length === gestartS && st.chatlog.length === chatS, { beurten: gestart.length - gestartS, chat: st.chatlog.length - chatS });
    r = await telS({});
    toets('8s tweede snelle vraag terwijl de eerste loopt: 429', r.status === 429 && /snelle vraag/.test(r.j.fout), r.j);
    H.telOpruim();
    toets('8s opruimen laat een lopende snelle vraag staan (geen job)', H.telRij().find((x) => x.id === idS).soort === 'bezig');
    r = await tel('GET', '/tel/uit', { sleutel: OW2 });
    toets('8s nog niets uitgegeven, bezig ja', !r.j.id && r.j.bezig === 'ja', r.j);
    vrij(); await tik(); await tik();
    r = await tel('GET', '/tel/uit', { sleutel: OW2 });
    toets('8s antwoord als gewoon item: soort antwoord, snel ja, nooit een wedervraag', r.j.id === idS && r.j.soort === 'antwoord' && r.j.snel === 'ja' && r.j.wedervraag === 'nee' && r.j.knopvraag === 'nee', r.j);
    toets('8s spreektekst: zin + alleen de waarde die er nog niet in stond', (r.j.tekst.match(/AB-12-CD/g) || []).length === 1 && /garage: 0612345678/.test(r.j.tekst), r.j.tekst);
    const delS = await tel('GET', '/tel/deel/' + idS + '/1', { sleutel: OW2 });
    toets('8s deel 1 met de pod-stem', delS.status === 200 && /audio\/wav/.test(delS.ct) && /kenteken/.test(st.tts[st.tts.length - 1]), { status: delS.status });
    await tel('POST', '/tel/gespeeld/' + idS, { sleutel: OW2 });
    toets('8s tel-audit zonder inhoud', !/kenteken|AB-12-CD|0612345678/.test(audit()) && /snel /.test(audit()));
    // niets gevonden, fout, te lang, vastgelopen
    zsWacht = null; zsUit = { status: 200, j: { ok: true, soort: 'geen', melding: 'Niet gevonden in je Brain.', tekst: '' } };
    r = await telS({}); const idG = r.j.id; await tik(); await tik();
    r = await tel('GET', '/tel/uit', { sleutel: OW2 });
    toets('8s niets gevonden: de melding hardop', r.j.id === idG && r.j.soort === 'antwoord' && /Niet gevonden in je Brain/.test(r.j.tekst), r.j);
    await tel('POST', '/tel/gespeeld/' + idG, { sleutel: OW2 });
    zsUit = new Error('stuk');
    r = await telS({}); const idF = r.j.id; await tik(); await tik();
    r = await tel('GET', '/tel/uit', { sleutel: OW2 });
    toets('8s Zoek snel faalt: fout-item met de vaste zin', r.j.id === idF && r.j.soort === 'fout' && /niet gelukt/.test(r.j.tekst), r.j);
    await tel('POST', '/tel/gespeeld/' + idF, { sleutel: OW2 });
    st.sttTekst = 'x'.repeat(230);
    r = await telS({});
    toets('8s vraag langer dan 200 tekens: 413', r.status === 413 && /snelle vraag/.test(r.j.fout), r.j);
    st.sttTekst = 'Wat is mijn kenteken';
    zsWacht = new Promise(() => {});
    r = await telS({}); const idV = r.j.id; await tik();
    H.telRij().find((x) => x.id === idV).t_start -= 100000;
    H.telOpruim();
    toets('8s snelle vraag zonder uitkomst na 90 s: fout-item', H.telRij().find((x) => x.id === idV).soort === 'fout');
    delete H.appStaat.zoekSnel.bezig[PIXEL];
    r = await tel('GET', '/tel/uit', { sleutel: OW2 }); await tel('POST', '/tel/gespeeld/' + idV, { sleutel: OW2 });
    toets('8s nog steeds geen Socev-beurt of chat_log', gestart.length === gestartS && st.chatlog.length === chatS);
    r = await tel('POST', '/tel/beurt', { sleutel: OW2, ct: 'text/plain', body: 'Gewone vraag zonder kop' });
    toets('8s zonder kop: gewone Socev-beurt (geen snel)', r.status === 202 && r.j.snel === undefined && gestart.length === gestartS + 1, r.j);
    { const idN = r.j.id; await tik(); afmaken[idN]('Gewoon antwoord.'); await tik(); r = await tel('GET', '/tel/uit', { sleutel: OW2 }); await tel('POST', '/tel/gespeeld/' + idN, { sleutel: OW2 });
      toets('8s gewoon antwoord: snel nee', r.j.id === idN && r.j.snel === 'nee', r.j); }

    // 484 — Te lezen
    const JK = 'a1a1a1a1a1a1a1a1', JA = 'b2b2b2b2b2b2b2b2', JL = 'c3c3c3c3c3c3c3c3';
    const lang = Array.from({ length: 60 }, (_, i) => 'Zin nummer ' + (i + 1) + ' van het lange rapport over de planning.').join(' ');
    const tlPunten = [
      { sleutel: 't:' + JK, soort: 'klus', kanaal: 'machinekamer', job_id: JK, t: new Date().toISOString(), titel: 'Rapport **bandjes**', van: null, bericht: 'Uitkomst: het bandje staat klaar.\n\nVerder in de app:\n- geheim detail', afgekapt: false },
      { sleutel: 't:' + JA, soort: 'antwoord', kanaal: 'hoofd', job_id: JA, t: new Date().toISOString(), titel: null, van: 'Hoe laat is de tandarts', bericht: 'Om **15:30** bij de tandarts.', afgekapt: false },
      { sleutel: 't:' + JL, soort: 'bewaard', kanaal: 'hoofd', job_id: JL, t: new Date().toISOString(), titel: null, van: null, bericht: '# Planning\n' + lang, afgekapt: false }];
    let tlFout = null;
    H.__zet('appVjPunten', async () => []);   // Moet iets leeg (de echte lijst zit in de databank)
    H.__zet('appTeLezen', async () => { if (tlFout) throw tlFout; return { punten: tlPunten.slice(), meer: 0 }; });
    r = await tel('GET', '/tel/uit?lijst=telezen', { sleutel: TK3 });
    toets('8s telezen met een Tasker-sleutel: 404', r.status === 404, r.j);
    Object.keys(H.appStaat.sessies).forEach((h) => delete H.appStaat.sessies[h]);
    // wv3976: Onderweg zonder app-sessie toetst § 8x
    sessie(PIXEL, 'credP', false);
    r = await tel('GET', '/tel/uit?lijst=telezen', { sleutel: OW2 });
    const tl = r.j.telezen || [];
    toets('8s telezen: drie titels met soort, sleutel en aantal delen', r.status === 200 && tl.length === 3 && tl[0].sleutel === 't:' + JK && tl[0].soort === 'klus' && tl[0].titel === 'Rapport bandjes' && tl[1].titel === 'Antwoord op: Hoe laat is de tandarts' && tl[2].titel === 'Planning' && tl.every((x) => x.delen >= 1), tl);
    toets('8s telezen geeft geen berichttekst', !/Uitkomst|geheim|15:30|Zin nummer/.test(JSON.stringify(r.j)), r.j);
    toets('8s lang stuk heeft meer delen', tl[2].delen >= 2, tl[2]);
    const stem = (sl, n, o) => tel('GET', '/tel/uit?lijst=telezenstem&sleutel=' + encodeURIComponent(sl) + '&deel=' + n, Object.assign({ sleutel: OW2 }, o || {}));
    r = await stem('t:' + JK, 1, { sleutel: TK3 });
    toets('8s telezenstem met een Tasker-sleutel: 404', r.status === 404, r.j);
    r = await stem('t:zz', 1);
    toets('8s telezenstem met een ongeldige sleutel: 400', r.status === 400, r.j);
    r = await stem('t:' + 'd4'.repeat(8), 1);
    toets('8s telezenstem van een stuk dat er niet (meer) staat: 404', r.status === 404 && /Te lezen/.test(r.j.fout), r.j);
    r = await tel('GET', '/tel/uit?lijst=telezengezien&sleutel=' + encodeURIComponent('t:' + JK), { sleutel: OW2 });
    toets('8s gezien zonder voorlezen: 409', r.status === 409 && /voorlezen/.test(r.j.fout), r.j);
    const ttsV8s = st.tts.length;
    r = await stem('t:' + JK, 1);
    toets('8s telezenstem deel 1: wav', r.status === 200 && /audio\/wav/.test(r.ct), { status: r.status, ct: r.ct });
    const gesproken = st.tts.slice(ttsV8s).join(' ');
    toets('8s voorgelezen: titel + bericht tot "Verder in de app", zonder opmaak', /Rapport bandjes/.test(gesproken) && /bandje staat klaar/.test(gesproken) && !/geheim detail|\*\*/.test(gesproken) && /De rest staat in de app/.test(gesproken), gesproken);
    r = await stem('t:' + JK, tl[0].delen + 1);
    toets('8s deel voorbij het einde: 404', r.status === 404, r.j);
    const TLF = path.join(DATA, 'te-lezen.json');
    const tlVoor = fs.existsSync(TLF) ? fs.readFileSync(TLF, 'utf8') : null;
    const gestartT = gestart.length, chatT = st.chatlog.length, vrVoor = fs.existsSync(path.join(DATA, 'vragen.json')) ? fs.readFileSync(path.join(DATA, 'vragen.json'), 'utf8') : null;
    for (let n = 2; n <= tl[0].delen; n++) await stem('t:' + JK, n);
    r = await tel('GET', '/tel/uit?lijst=telezengezien&sleutel=' + encodeURIComponent('t:' + JK), { sleutel: TK3 });
    toets('8s gezien met een Tasker-sleutel: 404', r.status === 404, r.j);
    r = await tel('GET', '/tel/uit?lijst=telezengezien&sleutel=' + encodeURIComponent('t:' + JK), { sleutel: OW2 });
    const tlNa = fs.existsSync(TLF) ? JSON.parse(fs.readFileSync(TLF, 'utf8')) : {};
    toets('8s na helemaal voorlezen: gezien 200, te-lezen.json gezien voor die klus', r.status === 200 && r.j.gezien === true && tlNa.gezien && tlNa.gezien[JK] && tlVoor !== JSON.stringify(tlNa), { r: r.j, tlNa });
    toets('8s te-lezen.json alleen ids en tijden (geen inhoud)', !/bandje|Uitkomst|Rapport/.test(JSON.stringify(tlNa)));
    toets('8s GEZIEN IS GEEN KNOPDRUK: geen beurt, geen chat_log, vragen.json gelijk', gestart.length === gestartT && st.chatlog.length === chatT &&
      (fs.existsSync(path.join(DATA, 'vragen.json')) ? fs.readFileSync(path.join(DATA, 'vragen.json'), 'utf8') : null) === vrVoor);
    r = await tel('GET', '/tel/uit?lijst=telezengezien&sleutel=' + encodeURIComponent('t:' + JK), { sleutel: OW2 });
    toets('8s tweede keer gezien zonder opnieuw voorlezen: 409', r.status === 409, r.j);
    // lang stuk: geknipt op ± 1.500 tekens
    const ttsL = st.tts.length;
    for (let n = 1; n <= tl[2].delen; n++) { r = await stem('t:' + JL, n); if (r.status !== 200) break; }
    const langGesproken = st.tts.slice(ttsL).join(' ');
    toets('8s lang stuk: ± 1.500 tekens en "De rest staat in de app"', r.status === 200 && langGesproken.length <= 1650 && /De rest staat in de app/.test(langGesproken) && !/Zin nummer 60/.test(langGesproken), { n: langGesproken.length });
    // cache: hetzelfde deel opnieuw maakt geen tweede stem
    const ttsC = st.tts.length;
    await stem('t:' + JL, 1);
    toets('8s hetzelfde deel opnieuw: uit het geheugen (geen nieuwe stem)', st.tts.length === ttsC, st.tts.length - ttsC);
    // dagplafond: 80 echte stemaanroepen (ook vooruitladen telt; Codex MOET 1)
    const tz = H.telStaat.telezen;
    toets('8s elke stemaanroep telt (ook vooruitladen)', H.appStaat.tellers['tel-telezenstem'].length === st.tts.length - ttsV8s, { teller: H.appStaat.tellers['tel-telezenstem'].length, tts: st.tts.length - ttsV8s });
    tz.audio = {};
    H.appStaat.tellers['tel-telezenstem'] = Array.from({ length: 80 }, () => Date.now());
    const ttsP = st.tts.length;
    r = await stem('t:' + JA, 1);
    toets('8s dagplafond (80 aanroepen): 429 met zin, geen stem gemaakt', r.status === 429 && /genoeg voorgelezen/.test(r.j.fout) && st.tts.length === ttsP, r.j);
    H.appStaat.tellers['tel-telezenstem'] = [];
    r = await stem('t:' + JA, 1);
    toets('8s onder het plafond weer 200', r.status === 200);
    tlFout = new Error('log weg');
    r = await tel('GET', '/tel/uit?lijst=telezen', { sleutel: OW2 });
    toets('8s Te lezen onleesbaar: 503', r.status === 503, r.j);
    tlFout = null;
    toets('8s tel-audit zonder inhoud (Te lezen)', !/bandje|Uitkomst|tandarts|Planning|Zin nummer/.test(audit()) && /telezen /.test(audit()));
    toets('8s geen onverwachte fouten (snel/telezen)', !logs.some((l) => /tel-snel|tel-telezen/.test(l) && !/stuk|log weg/.test(l)), logs.filter((l) => /tel-snel|tel-telezen/.test(l)));
    // ── 8v. wv3862: echte JA met vingerafdruk in Onderweg (handtekening van een sleutel in de chip; hier een nagebootste P-256-sleutel) ──
    H.appStaat.tellers['tel-alles'] = []; H.appStaat.tellers['tel-koppel'] = []; H.appStaat.tellers['tel-codes'] = [];
    for (const k of Object.keys(ketens)) delete ketens[k];
    const vk = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const vPub = vk.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const vTeken = (tekst, sleutel) => crypto.sign('sha256', Buffer.from(tekst, 'utf8'), sleutel || vk.privateKey).toString('base64url');
    const regLees = () => JSON.parse(fs.readFileSync(path.join(DATA, 'tel-apparaten.json'), 'utf8'));
    // koppelen: fout bewijs = gekoppeld zonder vingerafdruk-JA; goed bewijs = met
    let kV = await koppel((c) => JSON.stringify({ code: c, app: 'onderweg', pub: vPub, bewijs: vTeken('socev-onderweg-koppel-v1\n00000000') }), 'application/json');
    toets('8v koppel met fout bewijs: gekoppeld, vingerja nee, geen sleutel in het register', kV.status === 200 && kV.j.vingerja === 'nee' && !regLees().apparaten.some((x) => x.actief && x.vinger_pub), kV.j);
    const tgVoor = st.telegram.length;
    kV = await koppel((c) => JSON.stringify({ code: c, app: 'onderweg', pub: vPub, bewijs: vTeken('socev-onderweg-koppel-v1\n' + c) }), 'application/json');
    const OWV = kV.j.sleutel, OWVid = kV.j.apparaat;
    const rowV = regLees().apparaten.find((x) => x.actief && x.soort === 'onderweg');
    toets('8v koppel met goed bewijs: vingerja ja, publieke sleutel + id in het register (geen geheim)', kV.status === 200 && kV.j.vingerja === 'ja' && rowV && rowV.vinger_pub === vPub && /^[a-f0-9]{16}$/.test(rowV.vinger_id) && rowV.vinger_sinds, { j: kV.j, rowV });
    toets('8v Telegram noemt de JA via vingerafdruk', st.telegram.slice(tgVoor).some((t) => /JA via vingerafdruk/.test(t)), st.telegram.slice(tgVoor));
    r = await koppel((c) => JSON.stringify({ code: c, app: 'onderweg', pub: 'A'.repeat(1100) }), 'application/json');
    toets('8v koppel-body boven 1024 bytes: 400', r.status === 400, r.j);
    const kOud = await koppel((c) => JSON.stringify({ code: c, app: 'tasker' }), 'application/json');   // Tasker (onbekende app): Onderweg blijft
    const TKV = kOud.j.sleutel;
    toets('8v Tasker-koppeling krijgt geen vingerja-veld', kOud.status === 200 && kOud.j.vingerja === undefined, kOud.j);
    // uitdaging
    Object.keys(H.appStaat.sessies).forEach((h) => delete H.appStaat.sessies[h]);
    r = await tel('GET', '/tel/uit?lijst=uitdaging', { sleutel: TKV });
    toets('8v uitdaging met een Tasker-sleutel: 404', r.status === 404, r.j);
    // wv3976: de hele JA met vingerafdruk hieronder loopt ZONDER app-sessie (David hoeft de Socev-app niet te openen)
    r = await tel('GET', '/tel/uit?lijst=uitdaging', { sleutel: OWV });
    toets('8v uitdaging zonder app-sessie: 200 (wv3976)', r.status === 200 && /^[a-f0-9]{32}$/.test(String(r.j.uitdaging)), r.j);
    const uitd = async () => (await tel('GET', '/tel/uit?lijst=uitdaging', { sleutel: OWV })).j.uitdaging;
    let U = await uitd();
    toets('8v uitdaging: 32 hex, 2 minuten', /^[a-f0-9]{32}$/.test(String(U)) && Math.abs(H.telStaat.uitdaging[OWVid].tot - Date.now() - 120000) < 2000, H.telStaat.uitdaging);
    // een vraag in een antwoord (hoofdkanaal), via een autobeurt
    const rond = async () => { for (const id of Object.keys(afmaken)) if (jobs[id] && jobs[id].status === 'running') afmaken[id]('Goed.'); await tik(); await tik(); };
    const vraagBeurt = async (zin) => {
      await rond();
      const rb = await tel('POST', '/tel/beurt', { sleutel: OWV, ct: 'text/plain', body: 'Wat moet ik nog doen?' });
      const id = rb.j.id; await tik();
      afmaken[id]('Eén ding.\n\nVRAAG AAN DAVID: ' + zin); await tik();
      const ru = await tel('GET', '/tel/uit', { sleutel: OWV });
      await tel('POST', '/tel/gespeeld/' + id, { sleutel: OWV });
      return ru.j;
    };
    const it1 = await vraagBeurt('Zal ik het rapport in de map Werk bewaren?');
    toets('8v uitgifte: vraag_job en vraag_hash bij een knopvraag (zelfde id als vragen.json)', it1.knopvraag === 'ja' && /^[a-f0-9]{16}$/.test(it1.vraag_job) && /^[a-f0-9]{8}$/.test(it1.vraag_hash) &&
      !!JSON.parse(fs.readFileSync(path.join(DATA, 'vragen.json'), 'utf8'))[it1.vraag_job + ':' + it1.vraag_hash], it1);
    const vja = (o) => {
      const t = String(o.t || Date.now()), doel = o.doel, soort = o.soort || 'vraag', stil = o.stil || 'gps', u = o.u;
      const sig = o.sig || vTeken(['socev-onderweg-ja-v1', o.app || OWVid, soort, o.tekenDoel || doel, t, u, stil].join('\n'), o.sleutel);
      return tel('GET', '/tel/uit?lijst=vingerja&soort=' + soort + '&doel=' + encodeURIComponent(doel) + '&t=' + t + '&u=' + u + '&stil=' + stil + '&sig=' + sig, { sleutel: o.ow || OWV });
    };
    const D1 = it1.vraag_job + ':' + it1.vraag_hash;
    r = await vja({ doel: D1, u: U, tekenDoel: D1.replace(/.$/, D1.endsWith('0') ? '1' : '0') });
    toets('8v handtekening over iets anders: 403', r.status === 403 && /handtekening/.test(r.j.fout), r.j);
    r = await vja({ doel: D1, u: U });
    toets('8v uitdaging is na een fout verbruikt: 409', r.status === 409 && /verlopen/.test(r.j.fout), r.j);
    U = await uitd();
    r = await vja({ doel: D1, u: U, sleutel: crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey });
    toets('8v andere sleutel (niet gekoppeld): 403', r.status === 403, r.j);
    U = await uitd();
    r = await vja({ doel: D1, u: U, t: Date.now() - 5 * 60000 });
    toets('8v tijd 5 min ernaast: 409', r.status === 409 && /klok/.test(r.j.fout), r.j);
    U = await uitd();
    r = await vja({ doel: D1, u: U, stil: 'geenrit' });
    toets('8v zonder GPS-stilstand (ook zonder rit): 403 "alleen als je stilstaat" (Codex MOET 1)', r.status === 403 && /stilstaat/.test(r.j.fout), r.j);
    U = await uitd(); const Uoud = U; U = await uitd();
    r = await vja({ doel: D1, u: Uoud });
    toets('8v een nieuwe uitdaging vervangt de oude', r.status === 409, r.j);
    U = await uitd();
    const gestartV = gestart.length, chatV = st.chatlog.length;
    r = await vja({ doel: D1, u: U });
    await tik(); await tik();
    toets('8v JA op een gewone vraag: 200, bevestigd 1', r.status === 200 && r.j.ok === true && r.j.bevestigd === 1, r.j);
    const kb = gestart.slice(gestartV).find((g) => /\[KNOP\] David drukte JA/.test(g.prompt));
    toets('8v ZELFDE ALS EEN KNOPDRUK: [KNOP]-beurt in het hoofdkanaal, "in Onderweg", vraag-id erin', !!kb && /in Onderweg \(auto, stilstaand/.test(kb.prompt) && kb.prompt.includes(it1.vraag_hash) && !/verse vingerafdruk/.test(kb.prompt), gestart.slice(gestartV).map((g) => g.prompt.slice(0, 200)));
    const vrV = JSON.parse(fs.readFileSync(path.join(DATA, 'vragen.json'), 'utf8'))[D1];
    toets('8v vragen.json: antwoord ja van het app-apparaat (Pixel), via onderweg', vrV.antwoord && vrV.antwoord.keuze === 'ja' && vrV.antwoord.apparaat === PIXEL && vrV.antwoord.via === 'onderweg', vrV);
    const crV = st.chatlog.slice(chatV).find((c) => c.rol === 'david');
    toets('8v chat_log: bevestiging knop-ja, tekst "in Onderweg, stilstaand"', crV && crV.bevestiging === 'knop-ja' && /in Onderweg, stilstaand/.test(crV.tekst), st.chatlog.slice(chatV));
    toets('8v app-audit: regel /app/knop via onderweg', /"route":"\/app\/knop","m":"ONDERWEG","status":200/.test(fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8')));
    U = await uitd();
    r = await vja({ doel: D1, u: U });
    toets('8v dezelfde vraag nog eens: 409 al beantwoord', r.status === 409 && /al beantwoord/.test(r.j.fout), r.j);
    r = await vja({ doel: D1, u: U });
    toets('8v dezelfde uitdaging tweemaal: 409 (eenmalig)', r.status === 409 && /verlopen/.test(r.j.fout), r.j);
    // gevoelig: agenda mag (verse vingerafdruk), geld en versturen niet (Codex MOET 2)
    const it2 = await vraagBeurt('Zal ik de afspraak om 10 uur in je agenda zetten?');
    const vr2 = JSON.parse(fs.readFileSync(path.join(DATA, 'vragen.json'), 'utf8'))[it2.vraag_job + ':' + it2.vraag_hash];
    U = await uitd();
    const gestartA = gestart.length, chatA = st.chatlog.length;
    r = await vja({ doel: it2.vraag_job + ':' + it2.vraag_hash, u: U });
    await tik(); await tik();
    const kbA = gestart.slice(gestartA).find((g) => /\[KNOP\] David drukte JA/.test(g.prompt));
    const crA = st.chatlog.slice(chatA).find((c) => c.rol === 'david');
    toets('8v agenda-vraag (gevoelig): 200, knop-ja-vers, "met verse vingerafdruk bevestigd"', vr2 && vr2.gevoelig_reden === 'agenda' && r.status === 200 && kbA && /met verse vingerafdruk bevestigd/.test(kbA.prompt) && crA && crA.bevestiging === 'knop-ja-vers', { vr2, r: r.j, crA });
    for (const [zin, reden] of [['Zal ik de factuur van 200 euro betalen?', 'geld'], ['Zal ik de mail aan de leverancier versturen?', 'versturen']]) {
      const itG = await vraagBeurt(zin);
      U = await uitd();
      const gG = gestart.length;
      r = await vja({ doel: itG.vraag_job + ':' + itG.vraag_hash, u: U });
      toets('8v ' + reden + '-vraag: 409 "bevestig je in de Socev-app", geen beurt, onbeantwoord', r.status === 409 && /Socev-app/.test(r.j.fout) && gestart.length === gG &&
        !JSON.parse(fs.readFileSync(path.join(DATA, 'vragen.json'), 'utf8'))[itG.vraag_job + ':' + itG.vraag_hash].antwoord, r.j);
    }
    // de rit-ronde: Bevestig (n) met één vingerafdruk = per kaart de gewone knop (zoals Bevestig alles); gevoelig gaat niet mee
    H.__zet('appVjPunten', async () => [
      { id: 21, sleutel: 'k21', soort: 'besluit', status: 'open', prive: true, titel: 'Zal ik het rapport bewaren?', herkomst: {} },
      { id: 22, sleutel: 'k22', soort: 'besluit', status: 'open', prive: true, titel: 'Zal ik de factuur betalen?', herkomst: {} },
      { id: 23, sleutel: 'k23', soort: 'besluit', status: 'open', prive: true, titel: 'Zal ik het overleg plannen?', herkomst: {} }]);
    H.appStaat.vjCache = null;
    r = await tel('GET', '/tel/uit?lijst=voorjou', { sleutel: OWV });
    const tidV = {}; (r.j.voorjou || []).forEach((k) => { tidV[k.id] = k.tekst_id; });
    toets('8v ronde: drie kaarten met tekst_id', tidV[21] && tidV[22] && tidV[23], r.j);
    const DK = '21.ja.' + tidV[21] + ',22.ja.' + tidV[22] + ',23.nee.' + (tidV[23] === 'deadbeef' ? 'feedbeef' : 'deadbeef');
    U = await uitd();
    const gestartK = gestart.length;
    r = await vja({ soort: 'kaarten', doel: DK, u: U });
    await tik(); await tik();
    const u21 = (r.j.uitslag || []).find((x) => x.id === 21), u22 = (r.j.uitslag || []).find((x) => x.id === 22), u23 = (r.j.uitslag || []).find((x) => x.id === 23);
    toets('8v ronde: gewone Ja bevestigd, gevoelige Ja "met de knop in de Socev-app", gewijzigde kaart "lees hem opnieuw"', r.status === 200 && r.j.bevestigd === 1 && u21 && u21.ok && u22 && !u22.ok && /Socev-app/.test(u22.fout) && u23 && !u23.ok && /opnieuw/.test(u23.fout), r.j);
    const kbK = gestart.slice(gestartK).find((g) => /\[KNOP\] David drukte JA/.test(g.prompt));
    toets('8v ronde: [KNOP]-beurt "op de Voor jou-kaart in Onderweg", zonder verse vingerafdruk', !!kbK && /op de Voor jou-kaart in Onderweg/.test(kbK.prompt) && !/verse vingerafdruk/.test(kbK.prompt), gestart.slice(gestartK).map((g) => g.prompt.slice(0, 160)));
    U = await uitd();
    r = await vja({ soort: 'kaarten', doel: '21.ja.' + tidV[21] + ',21.nee.' + tidV[21], u: U });
    toets('8v ronde: dubbele kaart in één JA: 400', r.status === 400, r.j);
    // velden, grens
    r = await vja({ soort: 'iets', doel: D1, u: await uitd() });
    toets('8v onbekende soort: 400', r.status === 400, r.j);
    H.appStaat.tellers['tel-vingerja'] = Array(31).fill(Date.now());
    r = await vja({ doel: D1, u: await uitd() });
    toets('8v grens per uur: 429', r.status === 429, r.j);
    H.appStaat.tellers['tel-vingerja'] = [];
    // stand in de app, intrekken alleen de vingerafdruk-JA
    const sPV = sessie(PIXEL, 'credP', false);
    r = await app('GET', '/app/tel', undefined, { apparaat: PIXEL, sessie: sPV });
    const owA = (r.j.apparaten || []).find((x) => x.soort === 'onderweg');
    toets('8v app-stand: Onderweg met vingerja, sinds en id (geen sleutel)', owA && owA.vingerja === true && owA.vinger_id === rowV.vinger_id && !JSON.stringify(r.j).includes(vPub.slice(10, 40)), r.j);
    toets('8v /health: onderweg.vingerja', H.telInfo().onderweg && H.telInfo().onderweg.vingerja === true, H.telInfo().onderweg);
    r = await app('POST', '/app/tel/ontkoppel', { alleen: 'vingerja' }, { apparaat: PIXEL, sessie: sPV });
    toets('8v intrekken alleen vingerja: 200, spraakkoppeling blijft', r.status === 200 && r.j.alleen === 'vingerja' && r.j.ingetrokken === 1 && (await tel('GET', '/tel/uit', { sleutel: OWV })).status === 200 &&
      !regLees().apparaten.some((x) => x.actief && x.vinger_pub), r.j);
    sessie(PIXEL, 'credP', false);
    r = await tel('GET', '/tel/uit?lijst=uitdaging', { sleutel: OWV });
    toets('8v na intrekken: uitdaging 409 "koppel opnieuw"', r.status === 409 && /koppel Onderweg opnieuw/.test(r.j.fout), r.j);
    toets('8v tel-audit zonder handtekening of sleutel', !audit().includes(vPub.slice(20, 60)) && /vingerja/.test(audit()));
    toets('8v geen onverwachte fouten (vingerja)', !logs.some((l) => /tel-vinger|app-register|app-vragen/.test(l)), logs.filter((l) => /tel-vinger|app-register|app-vragen/.test(l)));
    // ── 8w. wv3878 (opzet Fable stap 2): agendaregel (lijst=agenda/agendastem) en één microfoon (X-Tel-Kies) ──
    H.appStaat.tellers['tel-alles'] = []; H.appStaat.tellers['tel-beurt'] = []; H.appStaat.tellers['tel-beurtdag'] = [];
    await rond();
    sessie(PIXEL, 'credP', false);
    const Ag = { items: H.__haal('telAgendaItems'), zin: H.__haal('telAgendaZin'), ms: H.__haal('telLokaalMs') };
    toets('8w functies aanwezig', typeof Ag.items === 'function' && typeof Ag.zin === 'function' && typeof Ag.ms === 'function');
    if (typeof Ag.ms === 'function') {
      toets('8w lokale tijd winter en zomer', Ag.ms('2026-11-23', '10:15') === Date.parse('2026-11-23T10:15:00+01:00') && Ag.ms('2026-07-01', '10:15') === Date.parse('2026-07-01T10:15:00+02:00'),
        [Ag.ms('2026-11-23', '10:15'), Ag.ms('2026-07-01', '10:15')]);
      const kw = [['2026-03-29', '01:30', '+01:00'], ['2026-03-29', '10:00', '+02:00'], ['2026-03-30', '00:00', '+02:00'], ['2026-10-25', '01:30', '+02:00'],
        ['2026-10-25', '10:00', '+01:00'], ['2026-10-26', '00:00', '+01:00']].filter(([d, k, o]) => Ag.ms(d, k) !== Date.parse(d + 'T' + k + ':00' + o));
      toets('8w lokale tijd op beide klokwisseldagen, ook vroeg in de nacht (Codex MOET 2)', kw.length === 0, kw.map(([d, k]) => d + ' ' + k + ' -> ' + new Date(Ag.ms(d, k)).toISOString()));
      const dA = { vandaag: '2026-11-23', morgen: '2026-11-24', fouten: [], op: Date.now(), agenda: { vandaag: [
        { hele_dag: true, titel: 'Proefverjaardag', start: '2026-11-23', van: null, tot: null },
        { hele_dag: false, titel: 'Vroeg proefoverleg', start: '2026-11-23T08:00:00+01:00', van: '08:00', tot: '09:00' },
        { hele_dag: false, titel: 'Lopend proefblok', start: '2026-11-23T10:00:00+01:00', van: '10:00', tot: '11:00' },
        { hele_dag: false, titel: 'Proeftandarts **zuid**', start: '2026-11-23T14:30:00+01:00', van: '14:30', tot: '15:00' },
        { hele_dag: false, titel: 'Proefnachtdienst', start: '2026-11-23T22:00:00+01:00', van: '22:00', tot: null },
        { hele_dag: false, titel: 'Proef tot middernacht', start: '2026-11-23T23:00:00+01:00', van: '23:00', tot: '00:00' }],
        morgen: [{ hele_dag: false, titel: 'Proefwerkoverleg', start: '2026-11-24T08:30:00+01:00', van: '08:30', tot: '09:30' }] } };
      const nuA = Ag.ms('2026-11-23', '10:15');
      const aA = Ag.items(dA, nuA);
      const titels = aA.nog.map((x) => x.titel);
      toets('8w voorbije afspraak weg, de rest op volgorde', JSON.stringify(titels) === JSON.stringify(['Proefverjaardag', 'Lopend proefblok', 'Proeftandarts **zuid**', 'Proefnachtdienst', 'Proef tot middernacht']), titels);
      const lop = aA.nog[1], mid = aA.nog[4], nacht = aA.nog[3];
      toets('8w begin/eind in ms; tot middernacht en doorlopend eindigen om middernacht', lop.begin === Date.parse('2026-11-23T10:00:00+01:00') && lop.eind === Ag.ms('2026-11-23', '11:00') &&
        mid.eind === Ag.ms('2026-11-24', '00:00') && mid.tot === null && nacht.eind === Ag.ms('2026-11-24', '00:00') && aA.morgen.length === 1, { lop, mid, nacht });
      const zA = Ag.zin(aA, nuA, false);
      toets('8w voorleeszin: nu, straks, hele dag; geen opmaak, niet het voorbije', /^Vandaag nog in je agenda\./.test(zA) && /Nu: Lopend proefblok, tot 11:00\./.test(zA) && /Om 14:30: Proeftandarts zuid\./.test(zA) &&
        /Hele dag: Proefverjaardag\./.test(zA) && !/Vroeg|\*\*/.test(zA), zA);
      const zL = Ag.zin(Ag.items(dA, Ag.ms('2026-11-24', '00:00') + 1), Ag.ms('2026-11-24', '00:00') + 1, true);
      toets('8w niets meer vandaag: morgen eerste afspraak + onvolledig', /^Vandaag staat er niets meer in je agenda\.\nMorgen om 08:30: Proefwerkoverleg\.\nNiet alle agenda's waren te lezen\.$/.test(zL), zL);
      toets('8w zin gelijk zolang er niets begint of eindigt (stem blijft bewaard)', Ag.zin(Ag.items(dA, nuA + 60000), nuA + 60000, false) === zA);
    }
    // de route
    const ymdNu = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    const ymdMo = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    let agD = { vandaag: ymdNu, morgen: ymdMo, fouten: [], op: Date.now(), agenda: { vandaag: [{ hele_dag: true, titel: 'Proefdag met Socev', start: ymdNu, van: null, tot: null }], morgen: [] } };
    let agFout = null, agN = 0;
    H.__zet('appVandaag', async () => { agN++; if (agFout) throw agFout; return agD; });
    const gestartW = gestart.length, chatW = st.chatlog.length;
    r = await tel('GET', '/tel/uit?lijst=agenda', { sleutel: TKV });
    toets('8w agenda met een Tasker-sleutel: 404', r.status === 404, r.j);
    Object.keys(H.appStaat.sessies).forEach((h) => delete H.appStaat.sessies[h]);
    // wv3976: Onderweg zonder app-sessie toetst § 8x
    sessie(PIXEL, 'credP', false);
    st.ttsTraag = 200;
    const ttsW = st.tts.length;
    r = await tel('GET', '/tel/uit?lijst=agenda', { sleutel: OWV });
    toets('8w agenda: 200, items met begin/eind, zin, stem bezig (vooruit)', r.status === 200 && r.j.ok === true && r.j.items.length === 1 && r.j.items[0].titel === 'Proefdag met Socev' &&
      Number.isFinite(r.j.items[0].begin) && Number.isFinite(r.j.items[0].eind) && /Hele dag: Proefdag met/.test(r.j.zin) && r.j.stem === 'bezig' && r.j.vandaag === ymdNu, r.j);
    await tik();
    toets('8w vooruit: één stemaanroep met de zin', st.tts.length === ttsW + 1 && /Hele dag: Proefdag/.test(st.tts[st.tts.length - 1]), st.tts.slice(ttsW));
    r = await tel('GET', '/tel/uit?lijst=agendastem', { sleutel: OWV });
    toets('8w agendastem terwijl de stem nog gemaakt wordt: wacht erop, geen tweede aanroep', r.status === 200 && /audio\/wav/.test(r.ct) && st.tts.length === ttsW + 1, { status: r.status, n: st.tts.length - ttsW });
    st.ttsTraag = 0;
    r = await tel('GET', '/tel/uit?lijst=agendastem', { sleutel: OWV });
    toets('8w agendastem nog een keer: bewaard, geen aanroep', r.status === 200 && st.tts.length === ttsW + 1, st.tts.length - ttsW);
    r = await tel('GET', '/tel/uit?lijst=agenda', { sleutel: OWV });
    toets('8w agenda daarna: stem klaar', r.status === 200 && r.j.stem === 'klaar', r.j.stem);
    agD = Object.assign({}, agD, { agenda: { vandaag: [], morgen: [] }, fouten: ['niet alle agenda\'s waren te lezen'] });
    H.appStaat.tellers['tel-agendastem'] = Array.from({ length: 40 }, () => Date.now());
    r = await tel('GET', '/tel/uit?lijst=agenda', { sleutel: OWV });
    toets('8w nieuwe zin, dagplafond vol: stem nee, onvolledig, geen aanroep', r.status === 200 && r.j.stem === 'nee' && r.j.onvolledig === true && r.j.items.length === 0 &&
      /Morgen ook nog niets\./.test(r.j.zin) && st.tts.length === ttsW + 1, r.j);
    r = await tel('GET', '/tel/uit?lijst=agendastem', { sleutel: OWV });
    toets('8w agendastem met vol plafond: 429 met zin', r.status === 429 && /genoeg voorgelezen/.test(r.j.fout), r.j);
    H.appStaat.tellers['tel-agendastem'] = [];
    agD = Object.assign({}, agD, { agenda: null, fouten: ['je agenda is nu niet te lezen'] });
    r = await tel('GET', '/tel/uit?lijst=agenda', { sleutel: OWV });
    toets('8w agenda onleesbaar: 503 met zin', r.status === 503 && /agenda is nu niet te lezen/.test(r.j.fout), r.j);
    agFout = new Error('luik weg');
    r = await tel('GET', '/tel/uit?lijst=agendastem', { sleutel: OWV });
    toets('8w agendastem als het luik faalt: 503', r.status === 503, r.j);
    agFout = null;
    toets('8w agenda start geen beurt en geen chat_log', gestart.length === gestartW && st.chatlog.length === chatW, { b: gestart.length - gestartW, c: st.chatlog.length - chatW });
    toets('8w tel-audit: geen titels, agendastem wel, lijst=agenda 200 stil', !/Proefdag|Proefverjaardag/.test(audit()) && /agendastem/.test(audit()) &&
      !audit().split('\n').some((l) => /"reden":"agenda /.test(l) && /"status":200/.test(l)));
    // één microfoon
    const telK = (o) => { const k = { 'cf-access-jwt-assertion': jwt(), authorization: 'Bearer ' + (o.sleutel || OWV), 'content-type': o.ct || 'audio/mp4', 'x-tel-kies': o.kop === undefined ? '1' : o.kop };
      if (o.snel) k['x-tel-snel'] = '1';
      const b = o.body || mp4Maak(2); k['content-length'] = String(Buffer.byteLength(b)); return verzoek('POST', '/tel/beurt', k, b); };
    const kiesAanroep = [];
    let kiesUit = null;
    zsAan = true;
    H.__zet('zoekSnelVoer', async (a, id, vraag, toon, opt) => { kiesAanroep.push({ a: a.id, id, vraag, toon, opt }); if (kiesUit instanceof Error) throw kiesUit; return kiesUit; });
    delete (H.appStaat.zoekSnel || { bezig: {} }).bezig[PIXEL];
    r = await telK({ sleutel: TKV });
    toets('8w kies met een Tasker-sleutel: 404', r.status === 404, r.j);
    r = await telK({ kop: 'ja' });
    toets('8w kies met een rare kopwaarde: 404', r.status === 404, r.j);
    r = await telK({ snel: true });
    toets('8w kies samen met snel: 404', r.status === 404, r.j);
    // Zoek snel vindt het: snel antwoord, geen beurt
    st.sttTekst = 'Wat is mijn proefkenteken';
    kiesUit = { status: 200, j: { ok: true, soort: 'antwoord', tekst: 'Je proefkenteken is ZZ-99-ZZ.', waarden: [] } };
    let gB = gestart.length, cB = st.chatlog.length;
    r = await telK({});
    const idK1 = r.j.id;
    toets('8w kies: 202 met id en verstaan', r.status === 202 && /^[0-9a-f]{16}$/.test(String(idK1)) && r.j.verstaan === 'Wat is mijn proefkenteken', r.j);
    await tik(); await tik();
    toets('8w kies: Zoek snel eerst, stil bij een misser, met toon_dekking', kiesAanroep.length === 1 && kiesAanroep[0].a === PIXEL && kiesAanroep[0].vraag === 'Wat is mijn proefkenteken' &&
      kiesAanroep[0].toon === true && kiesAanroep[0].opt && kiesAanroep[0].opt.stilBijMis === true, kiesAanroep);
    r = await tel('GET', '/tel/uit', { sleutel: OWV });
    toets('8w kies gevonden: snel antwoord, geen Socev-beurt of chat_log', r.j.id === idK1 && r.j.soort === 'antwoord' && r.j.snel === 'ja' && /ZZ-99-ZZ/.test(r.j.tekst) &&
      gestart.length === gB && st.chatlog.length === cB, { j: r.j, b: gestart.length - gB });
    await tel('POST', '/tel/gespeeld/' + idK1, { sleutel: OWV });
    // niets gevonden, een handeling of een fout: door naar Socev, zelfde item
    for (const [naam, uit] of [['geen', { status: 200, j: { ok: true, soort: 'geen', melding: 'Niet gevonden in je Brain.', tekst: '' } }],
                               ['handeling', { status: 200, j: { ok: true, soort: 'handeling', melding: 'Dat kan in het gesprek met Socev.', tekst: '' } }],
                               ['fout', new Error('stuk')], ['500', { status: 500, j: { ok: false, fout: 'fout op de pod' } }]]) {
      kiesUit = uit; gB = gestart.length; cB = st.chatlog.length;
      st.sttTekst = 'Proefvraag ' + naam + ' voor Socev';
      r = await telK({});
      const idK = r.j.id;
      await tik(); await tik();
      const nieuw = gestart.slice(gB);
      const job = nieuw[0] && nieuw[0].jobId;
      toets('8w kies ' + naam + ': gewone Socev-beurt met [AUTO] en chat_log', r.status === 202 && nieuw.length === 1 && /\[AUTO\] Proefvraag /.test(nieuw[0].prompt) && st.chatlog.length === cB + 1, { r: r.j, n: nieuw.length });
      const it = H.telRij().find((x) => x.id === job);
      toets('8w kies ' + naam + ': het wachtende item heeft nu de job-id (niet meer snel)', it && it.soort === 'bezig' && it.snel === false && !H.telRij().some((x) => x.id === idK) && it.k.kies === 'socev', it);
      if (job && afmaken[job]) { afmaken[job]('Proefantwoord ' + naam + '.'); await tik(); }
      r = await tel('GET', '/tel/uit', { sleutel: OWV });
      toets('8w kies ' + naam + ': antwoord van Socev als gewoon item (snel nee)', r.j.id === job && r.j.soort === 'antwoord' && r.j.snel === 'nee' && /Proefantwoord/.test(r.j.tekst), r.j);
      if (r.j.id) await tel('POST', '/tel/gespeeld/' + r.j.id, { sleutel: OWV });
    }
    // Zoek snel niet te proberen: meteen de gewone beurt, Zoek snel niet aangeroepen
    for (const [naam, voor, na] of [['Zoek snel uit', () => { zsAan = false; }, () => { zsAan = true; }],
                                     ['vraag > 200 tekens', () => { st.sttTekst = 'Lange proefvraag ' + 'x'.repeat(220); }, () => {}],
                                     ['Zoek snel bezig', () => { H.appStaat.zoekSnel.bezig[PIXEL] = true; }, () => { delete H.appStaat.zoekSnel.bezig[PIXEL]; }]]) {
      st.sttTekst = 'Proefvraag zonder zoeken'; voor();
      const kA = kiesAanroep.length; gB = gestart.length;
      r = await telK({});
      toets('8w kies, ' + naam + ': meteen een gewone beurt (202, job-id), Zoek snel niet', r.status === 202 && gestart.length === gB + 1 && gestart[gB].jobId === r.j.id && kiesAanroep.length === kA, { r: r.j, z: kiesAanroep.length - kA });
      na();
      await tik(); if (afmaken[r.j.id]) afmaken[r.j.id]('Goed.'); await tik();
      const u = await tel('GET', '/tel/uit', { sleutel: OWV }); if (u.j.id) await tel('POST', '/tel/gespeeld/' + u.j.id, { sleutel: OWV });
    }
    toets('8w zoekSnelVoer kent stilBijMis (geen zoekregel en geen systeemregel bij een misser)', /async function zoekSnelVoer\(a, id, vraag, toonDekking, opt\)/.test(src) &&
      /const gelogd = stil \? false : await appLogSchrijf\('hoofd'/.test(src) && /if \(!stil\) zoekSnelRegelZet\(r\);/.test(src));
    toets('8w tel-audit zonder vraag of antwoord (kies)', !/proefkenteken|ZZ-99-ZZ|Proefvraag/.test(audit()) && /kies /.test(audit()));
    toets('8w geen onverwachte fouten (agenda, kies)', !logs.some((l) => /tel-agenda|tel-kies/.test(l) && !/luik weg|: stuk/.test(l)), logs.filter((l) => /tel-agenda|tel-kies/.test(l)));
    // ── 8x. wv3976 (David 23-11 06:23, rijdend): Onderweg werkt zonder app-sessie; Tasker houdt de eis; zonder sleutel of Access dicht ──
    H.appStaat.tellers['tel-alles'] = []; H.appStaat.tellers['tel-beurt'] = []; H.appStaat.tellers['tel-beurtdag'] = []; H.appStaat.tellers['tel-agenda'] = [];
    H.appStaat.tellers['tel-dagbericht'] = []; H.appStaat.tellers['tel-voorjou'] = []; H.appStaat.tellers['tel-telezen'] = [];
    await rond();
    Object.keys(H.appStaat.sessies).forEach((h) => delete H.appStaat.sessies[h]);
    zsAan = true; delete (H.appStaat.zoekSnel || { bezig: {} }).bezig[PIXEL];
    agD = { vandaag: ymdNu, morgen: ymdMo, fouten: [], op: Date.now(), agenda: { vandaag: [], morgen: [] } }; agFout = null;
    const a423 = () => audit().split('\n').filter((l) => /geen app-sessie/.test(l)).length;
    const n423 = a423();
    for (const lijst of ['dagbericht', 'agenda', 'voorjou', 'telezen']) {
      r = await tel('GET', '/tel/uit?lijst=' + lijst, { sleutel: OWV });
      toets('8x ' + lijst + ' met Onderweg-sleutel zonder app-sessie: 200', r.status === 200 && r.j.ok !== false, { status: r.status, j: r.j });
    }
    r = await tel('GET', '/tel/uit?lijst=dagbericht&audio=1', { sleutel: OWV });
    toets('8x dagbericht-audio zonder app-sessie: geen 423 (200 mp3 of 404 "nog geen")', r.status === 200 || r.status === 404, { status: r.status, j: r.j });
    const gX = gestart.length;
    r = await tel('POST', '/tel/beurt', { sleutel: OWV, ct: 'text/plain', body: 'Proefvraag zonder app-sessie' });
    toets('8x beurt met Onderweg-sleutel zonder app-sessie: 202 met id', r.status === 202 && /^[0-9a-f]{16}$/.test(String(r.j.id)), r.j);
    await tik(); await tik();
    toets('8x die beurt start gewoon in het hoofdkanaal', gestart.length === gX + 1 && /Proefvraag zonder app-sessie/.test(gestart[gX].prompt), gestart.slice(gX).map((g) => g.prompt.slice(0, 120)));
    if (gestart[gX] && afmaken[gestart[gX].jobId]) { afmaken[gestart[gX].jobId]('Goed.'); await tik(); }
    const uX = await tel('GET', '/tel/uit', { sleutel: OWV }); if (uX.j.id) await tel('POST', '/tel/gespeeld/' + uX.j.id, { sleutel: OWV });
    toets('8x geen enkele 423 "geen app-sessie" voor Onderweg', a423() === n423, audit().split('\n').filter((l) => /geen app-sessie/.test(l)).slice(-3));
    r = await tel('POST', '/tel/beurt', { sleutel: TKV, ct: 'text/plain', body: 'Proefvraag Tasker' });
    toets('8x Tasker zonder app-sessie: nog steeds 423 (ongewijzigd)', r.status === 423 && /Socev-app/.test(r.j.fout), r.j);
    r = await tel('GET', '/tel/uit?lijst=dagbericht', { sleutel: false });
    toets('8x zonder apparaatsleutel: 401', r.status === 401, r.j);
    r = await tel('GET', '/tel/uit?lijst=dagbericht', { sleutel: OWV, jwt: false });
    toets('8x zonder Access-bewijs: 403', r.status === 403, r.j);
    fs.writeFileSync(TELUIT, '');
    r = await tel('GET', '/tel/uit?lijst=dagbericht', { sleutel: OWV });
    toets('8x noodstop blijft: Onderweg zonder app-sessie 503', r.status === 503, r.j);
    fs.unlinkSync(TELUIT);
    toets('8x telSessieOk: Onderweg-rij true, Tasker-rij zonder sessie false', H.__haal('telSessieOk')({ soort: 'onderweg', app_apparaat: PIXEL }) === true && H.__haal('telSessieOk')({ app_apparaat: PIXEL }) === false);
    // ── 8y. wv4016 (dagbriefing als gesprek, fase 1): vragen uit de briefing → kaarten; lijst=gesprek/gesprekstem; tik = knopdruk (niet gevoelig) ──
    H.appStaat.tellers['tel-alles'] = []; H.appStaat.tellers['tel-beurt'] = []; H.appStaat.tellers['tel-beurtdag'] = []; H.appStaat.tellers['tel-voorjou'] = [];
    await rond();
    const BPm = require(path.resolve('briefing-punten.js'));
    const blokTekst = (vr, vorm) => (vorm === 'oud' ? '```\nsocev-autovragen\n' : '```socev-autovragen\n') + JSON.stringify(vr) + '\n```';
    const VR = [
      { punt: 'Proefgarage bellen', vraag: 'Zal ik je om tien uur herinneren aan de proefgarage?', uitleg: 'De proefkeuring verloopt vrijdag. Bij Ja zet ik een herinnering om tien uur, bij Nee doe ik niets.', gevoelig: '-' },
      { punt: 'Proefoverleg', vraag: 'Zal ik het proefoverleg naar donderdag verschuiven?', uitleg: 'Woensdag botst het met de proefdienst. Bij Ja zet ik het voorstel klaar, bij Nee blijft het staan.', gevoelig: 'agenda' },
      { punt: 'iets dat er niet staat', vraag: 'Zal ik de proefvoorraad laten uitzoeken?', uitleg: 'Er speelt een vraag over de voorraad. Bij Ja zoek ik het uit, bij Nee niet.', gevoelig: 'raar' },
      { punt: 'x', vraag: 'Een vierde vraag?', uitleg: 'Deze is er één te veel en valt weg.', gevoelig: '-' }];
    const avA = BPm.autovragen('Kop\n\n' + blokTekst(VR) + '\n'), avB = BPm.autovragen('Kop\n' + blokTekst(VR.slice(0, 1), 'oud')), avK = BPm.autovragen('Kop\n```socev-autovragen\n{kapot\n```');
    toets('8y autovragen: blok weg, hooguit 3, onbekend label = versturen, oude vorm ook, kapot blok ook weg', avA.tekst === 'Kop' && avA.vragen.length === 3 && avA.vragen[2].gevoelig === 'versturen' && avA.fouten.length === 1 &&
      avB.tekst === 'Kop' && avB.vragen.length === 1 && avK.tekst === 'Kop' && avK.vragen.length === 0 && avK.fouten[0] === 'geen json' && BPm.autovragen('Gewoon').blokken === 0, { avA, avB, avK });
    toets('8y autovragen: vraag zonder ? of te korte uitleg valt weg', BPm.autovragen(blokTekst([{ vraag: 'Zal ik het doen', uitleg: 'Lang genoeg om te tellen hier.' }, { vraag: 'Zal ik het doen?', uitleg: 'kort' }])).vragen.length === 0);
    // zet-oproepen vangen (de rest van de databank zoals in de toets)
    const sbOrig = H.__haal('appSbRpc'), zetten = [], statussen = [];
    H.__zet('appSbRpc', async (fn, b) => {
      if (fn === 'mk_voor_jou_zet') { zetten.push(b.p); return { sleutel: b.p.sleutel }; }
      if (fn === 'mk_voor_jou_status') { statussen.push(b); return { ok: true }; }
      return sbOrig(fn, b);
    });
    const dagY = ymdNu, gisteren = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    H.__zet('appVjPunten', async () => [{ id: 51, sleutel: 'briefing-' + gisteren + '-1', soort: 'besluit', status: 'open', prive: true, titel: 'Zal ik iets van gisteren doen?', waarom: 'Oude uitleg van gisteren hier.',
      herkomst: { module: 'briefing', briefing: { dag: gisteren, punt: null, gevoelig: '-' } } }]);
    H.appStaat.vjCache = null;
    const briefTekst = '**🌅 Ochtendbericht**\n\n**Goedemorgen David**\n\nVandaag:\n• Proefgarage bellen over de keuring\n• Proefoverleg woensdag om 10:00\n\nPrioriteit: de keuring.\n\n' + blokTekst(VR);
    const bres = () => { let k; const p = new Promise((r) => { k = r; }); return { p, res: { headersSent: false, writeHead(s) { this.s = s; this.headersSent = true; }, end(b) { k({ status: this.s, j: JSON.parse(b) }); }, setHeader() {}, on() { return this; } } }; };
    let bx = bres();
    H.__haal('berichtNieuw')(bx.res, { kanaal: 'hoofd', bron: 'briefing', klasse: 'normaal', tekst: briefTekst, sleutel: 'proef-8y-briefing' });
    let rb = await bx.p; await tik(); await tik(); await wacht(150);
    const logH = fs.readFileSync(path.join(LOGDIR, 'hoofd.jsonl'), 'utf8');
    toets('8y briefingbericht: 200 en het blok staat niet in het app-log', rb.status === 200 && rb.j.ok && /Proefgarage bellen/.test(logH) && !/socev-autovragen|proefvoorraad laten/.test(logH), rb);
    const z1 = zetten.find((p) => p.sleutel === 'briefing-' + dagY + '-1'), z2 = zetten.find((p) => p.sleutel === 'briefing-' + dagY + '-2'), z3 = zetten.find((p) => p.sleutel === 'briefing-' + dagY + '-3');
    const modY = BPm.punten(briefTekst.replace(/```socev[\s\S]*$/, '').trim(), dagY);
    const pGarage = modY.punten.find((p) => /Proefgarage/.test(p.tekst)), pOverleg = modY.punten.find((p) => /Proefoverleg/.test(p.tekst));
    toets('8y drie besluitkaarten: hoofdkanaal (prive), uitleg als waarom, deadline vandaag, module briefing, punt-id', zetten.length === 3 && z1 && z1.soort === 'besluit' && z1.prive === true && z1.deadline === dagY &&
      z1.waarom === VR[0].uitleg && z1.titel === VR[0].vraag && z1.herkomst.module === 'briefing' && z1.herkomst.briefing.punt === pGarage.id && z2.herkomst.briefing.punt === pOverleg.id &&
      z2.herkomst.briefing.gevoelig === 'agenda' && z3.herkomst.briefing.punt === null && z3.herkomst.briefing.gevoelig === 'versturen', zetten);
    toets('8y de vraag van gisteren gaat op vervallen', statussen.some((s) => s.p_sleutel === 'briefing-' + gisteren + '-1' && s.p_naar === 'vervallen' && s.p_door === 'agent'), statussen);
    const zN = zetten.length;
    bx = bres();
    H.__haal('berichtNieuw')(bx.res, { kanaal: 'machinekamer', bron: 'agentrapport', klasse: 'normaal', tekst: 'Rapport\n' + blokTekst(VR.slice(0, 1)) });
    rb = await bx.p; await tik(); await wacht(80);
    toets('8y blok in een ander bericht: wel weg, geen kaart', rb.status === 200 && zetten.length === zN && !/socev-autovragen/.test(fs.readFileSync(path.join(LOGDIR, 'machinekamer.jsonl'), 'utf8')), rb);
    // de kaarten zoals de databank ze teruggeeft (+ een andere open vraag in het hoofdkanaal en een in de machinekamer)
    const kaartVan = (z, id) => ({ id, sleutel: z.sleutel, soort: 'besluit', status: 'open', prive: true, titel: z.titel, waarom: z.waarom, deadline: z.deadline, herkomst: z.herkomst });
    let punten8y = [kaartVan(z1, 61), kaartVan(z2, 62), kaartVan(z3, 63),
      { id: 64, sleutel: 'k64', soort: 'besluit', status: 'open', prive: true, titel: 'Zal ik het proefdossier bewaren?', waarom: 'Het dossier staat los.', herkomst: {} },
      { id: 65, sleutel: 'k65', soort: 'besluit', status: 'open', prive: false, titel: 'Zal ik de proefmachine herstarten?', herkomst: {} },
      { id: 51, sleutel: 'briefing-' + gisteren + '-1', soort: 'besluit', status: 'open', prive: true, titel: 'Zal ik iets van gisteren doen?', herkomst: { module: 'briefing', briefing: { dag: gisteren, punt: null, gevoelig: '-' } } }];
    H.__zet('appVjPunten', async () => punten8y);
    H.appStaat.vjCache = null;
    const zicht = H.__haal('appVjZichtbaar');
    toets('8y vraag van gisteren niet meer zichtbaar, die van vandaag wel', zicht(punten8y[5], dagY) === false && zicht(punten8y[0], dagY) === true);
    r = await tel('GET', '/tel/uit?lijst=voorjou', { sleutel: OWV });
    const vj = {}; (r.j.voorjou || []).forEach((k) => { vj[k.id] = k; });
    toets('8y voorjou: waarom, gevoelig + reden (strengste van label en pod), kanaal; gisteren weg', vj[61] && vj[61].waarom === VR[0].uitleg && vj[61].gevoelig === false && vj[62] && vj[62].gevoelig === true && vj[62].reden === 'agenda' &&
      vj[63] && vj[63].gevoelig === true && vj[63].reden === 'versturen' && vj[61].kanaal === 'hoofd' && vj[65].kanaal === 'machinekamer' && !vj[51] && vj[61].briefing.punt === pGarage.id, r.j);
    const ks = H.__haal('appVjKnopStand');
    const gevVan = (titel, label) => { const k = ks({ id: 9, sleutel: 'briefing-' + dagY + '-1', soort: 'besluit', status: 'open', prive: true, titel, herkomst: { module: 'briefing', briefing: { dag: dagY, gevoelig: label } } }, null, {}); return k.gevoelig ? k.gevoeligReden : null; };
    toets('8y gevoelig = strengste: pod geld boven label -, label geld boven pod agenda, label - en pod niets = gewoon', gevVan('Zal ik de factuur betalen?', '-') === 'geld' && gevVan('Zal ik het overleg in je agenda zetten?', 'geld') === 'geld' &&
      gevVan('Zal ik je herinneren?', '-') === null && gevVan('Zal ik je herinneren?', 'agenda') === 'agenda', [gevVan('Zal ik de factuur betalen?', '-'), gevVan('Zal ik het overleg in je agenda zetten?', 'geld'), gevVan('Zal ik je herinneren?', '-')]);
    const tidVan = (waarom) => ks({ id: 9, sleutel: 'briefing-' + dagY + '-1', soort: 'besluit', status: 'open', prive: true, titel: 'Zal ik je herinneren?', waarom, herkomst: { module: 'briefing', briefing: { dag: dagY, gevoelig: '-' } } }, null, {}).tekstId;
    toets('8y andere uitleg = andere tekst_id (Codex MOET 2); een gewone kaart houdt zijn tekst_id', tidVan('Uitleg een hier.') !== tidVan('Uitleg twee hier.') &&
      ks({ id: 8, sleutel: 'k8', soort: 'besluit', status: 'open', prive: true, titel: 'Zal ik het bewaren?', waarom: 'a', herkomst: {} }, null, {}).tekstId === ks({ id: 8, sleutel: 'k8', soort: 'besluit', status: 'open', prive: true, titel: 'Zal ik het bewaren?', waarom: 'b', herkomst: {} }, null, {}).tekstId);
    // gesprek
    const ttsG = st.tts.length;
    r = await tel('GET', '/tel/uit?lijst=gesprek', { sleutel: OWV });
    const sk = (r.j.gesprek && r.j.gesprek.stukken) || [];
    const iG = sk.findIndex((s) => s.punt_id === pGarage.id && s.soort === 'punt'), iO = sk.findIndex((s) => s.punt_id === pOverleg.id && s.soort === 'punt');
    toets('8y gesprek: punten in volgorde, de vraag direct na zijn punt, de losse vraag na het laatste punt, nog 1 (alleen hoofdkanaal)', r.status === 200 && iG >= 0 && sk[iG + 1].soort === 'vraag' && sk[iG + 1].kaart.id === 61 &&
      sk[iO + 1].soort === 'vraag' && sk[iO + 1].kaart.id === 62 && sk[iO + 2].soort === 'vraag' && sk[iO + 2].kaart.id === 63 && r.j.gesprek.nog === 1 && sk.every((s) => /^[a-f0-9]{12}$/.test(s.stem)), r.j);
    toets('8y gesprek: vraagstuk met uitleg, tekst_id en gevoelig van de kaart; geen wikilink of blok in de tekst', sk[iG + 1].uitleg === VR[0].uitleg && sk[iG + 1].kaart.tekst_id === vj[61].tekst_id && sk[iG + 1].kaart.gevoelig === false &&
      sk[iO + 1].kaart.gevoelig === true && sk[iO + 1].kaart.reden === 'agenda' && !sk.some((s) => /\[\[|socev-autovragen/.test(s.tekst)), sk);
    await wacht(400);
    toets('8y gesprek: stem vooruit, per stuk één keer (uitleg + vraag in één stuk)', st.tts.length - ttsG === sk.length && st.tts.slice(ttsG).some((t) => t.includes('proefkeuring verloopt vrijdag') && /herinneren aan de proefgarage\?/.test(t)), st.tts.slice(ttsG));
    const ttsS = st.tts.length;
    r = await tel('GET', '/tel/uit?lijst=gesprekstem&s=' + sk[iG].stem, { sleutel: OWV });
    toets('8y gesprekstem: wav uit het geheugen, geen nieuwe stemaanroep', r.status === 200 && /audio\/wav/.test(r.ct) && st.tts.length === ttsS, { status: r.status, ct: r.ct });
    r = await tel('GET', '/tel/uit?lijst=gesprekstem&s=abcdefabcdef', { sleutel: OWV });
    toets('8y gesprekstem onbekend stuk: 404', r.status === 404, r.j);
    r = await tel('GET', '/tel/uit?lijst=gesprekstem&s=x', { sleutel: OWV });
    toets('8y gesprekstem ongeldig: 400', r.status === 400, r.j);
    r = await tel('GET', '/tel/uit?lijst=gesprek', { sleutel: TKV });
    toets('8y gesprek met een Tasker-sleutel: 404', r.status === 404, r.j);
    H.telStaat.gesprek.wav = {}; H.appStaat.tellers['tel-gesprekstem'] = Array(60).fill(Date.now());
    r = await tel('GET', '/tel/uit?lijst=gesprekstem&s=' + sk[iG].stem, { sleutel: OWV });
    toets('8y gesprekstem boven het dagplafond: 429', r.status === 429 && /genoeg voorgelezen/.test(r.j.fout), r.j);
    H.appStaat.tellers['tel-gesprekstem'] = [];
    // 🎤 Reageer: kop X-Tel-Bij
    const bijB = (stem, tekst, o) => { o = o || {}; const k2 = { 'cf-access-jwt-assertion': jwt(), authorization: 'Bearer ' + (o.sleutel || OWV), 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(tekst)), 'x-tel-bij': stem };
      if (o.kies) k2['x-tel-kies'] = '1'; return verzoek('POST', '/tel/beurt', k2, tekst); };
    await rond();
    let gBij = gestart.length;
    r = await bijB(sk[iG].stem, 'Gedaan.');
    await tik();
    const bpJ = JSON.parse(fs.readFileSync(path.join(DATA, 'briefing-punten.json'), 'utf8'));
    toets('8y Reageer "Gedaan." op een punt: 200 punt-stand gedaan, geen Socev-beurt', r.status === 200 && r.j.stand === 'gedaan' && gestart.length === gBij &&
      ((bpJ.edities['briefing:' + dagY] || {}).punten || {})[pGarage.id] && bpJ.edities['briefing:' + dagY].punten[pGarage.id].stand === 'gedaan', { r: r.j, bpJ });
    H.appStaat.tellers['briefingpunt'] = Array(200).fill(Date.now());
    r = await bijB(sk[iO].stem, 'Klopt niet.');
    toets('8y Reageer "Klopt niet." boven de grens: 429 met zin, geen beurt (Codex ronde 3)', r.status === 429 && /te vaak/.test(r.j.fout) && gestart.length === gBij, r.j);
    H.appStaat.tellers['briefingpunt'] = [];
    r = await bijB(sk[iG + 1].stem, 'Ja, graag.');
    await tik();
    toets('8y Reageer "Ja, graag." op een vraag: 409 tik_ja "Tik op JA", geen beurt, kaart niet beantwoord (Codex MOET 2)', r.status === 409 && r.j.tik_ja === true && /Tik op JA/.test(r.j.fout) && gestart.length === gBij &&
      !statussen.some((x) => x.p_sleutel === z1.sleutel && x.p_naar === 'gedaan'), r.j);
    r = await bijB(sk[iO].stem, 'Kan dat ook vrijdag?');
    await tik(); await tik();
    toets('8y Reageer met een zin: gewone [AUTO]-beurt met het punt als context', r.status === 202 && gestart.length === gBij + 1 && /\[AUTO\] Kan dat ook vrijdag\?/.test(gestart[gBij].prompt) &&
      /reageert David hiermee op dit stuk uit je ochtendbriefing/.test(gestart[gBij].prompt) && gestart[gBij].prompt.includes('Proefoverleg woensdag') && /nooit een knopdruk/.test(gestart[gBij].prompt), gestart.slice(gBij).map((g) => g.prompt.slice(0, 300)));
    await rond();
    const uBij = await tel('GET', '/tel/uit', { sleutel: OWV }); if (uBij.j.id) await tel('POST', '/tel/gespeeld/' + uBij.j.id, { sleutel: OWV });
    r = await bijB(sk[iG].stem, 'Gedaan.', { sleutel: TKV });
    toets('8y Reageer met een Tasker-sleutel: 404', r.status === 404, r.j);
    r = await bijB(sk[iG].stem, 'Gedaan.', { kies: true });
    toets('8y Reageer samen met kies: 404', r.status === 404, r.j);
    r = await bijB('xyz', 'Gedaan.');
    toets('8y Reageer met een rare kop: 404', r.status === 404, r.j);
    // kaartstem zegt nu ook het waarom
    const ttsK = st.tts.length;
    r = await tel('GET', '/tel/uit?lijst=kaartstem&id=64', { sleutel: OWV });
    toets('8y kaartstem: titel + waarom', r.status === 200 && st.tts.length === ttsK + 1 && /Het dossier staat los\./.test(st.tts[ttsK]), st.tts.slice(ttsK));
    // tik op JA: gewone kaart = knopdruk, rijdend, zonder vingerafdruk
    const tikR = (q) => tel('GET', '/tel/uit?lijst=tik&' + q, { sleutel: OWV });
    const gT = gestart.length, cT = st.chatlog.length;
    r = await tikR('soort=kaart&doel=61&keuze=ja&tekst_id=' + vj[61].tekst_id);
    await tik(); await tik();
    const kbT = gestart.slice(gT).find((g) => /\[KNOP\] David drukte JA/.test(g.prompt));
    toets('8y tik JA op een gewone briefingkaart: 200, [KNOP]-beurt "Knopdruk in Onderweg (auto)", met de uitleg, zonder vingerafdruk', r.status === 200 && r.j.ok === true && !!kbT &&
      /Knopdruk in Onderweg \(auto\)/.test(kbT.prompt) && /ochtendbriefing van/.test(kbT.prompt) && kbT.prompt.includes('proefkeuring verloopt vrijdag') && /niet als door David gecontroleerd/.test(kbT.prompt) && !/vingerafdruk bevestigd|stilstaand/.test(kbT.prompt), { r: r.j, p: gestart.slice(gT).map((g) => g.prompt.slice(0, 300)) });
    const crT = st.chatlog.slice(cT).find((c) => c.rol === 'david');
    toets('8y chat_log: knop-ja-kaart, "in Onderweg (auto)"', crT && crT.bevestiging === 'knop-ja-kaart' && /in Onderweg \(auto\)/.test(crT.tekst), st.chatlog.slice(cT));
    const vrT = Object.values(JSON.parse(fs.readFileSync(path.join(DATA, 'vragen.json'), 'utf8'))).find((v) => v.soort === 'voorjou' && v.antwoord && v.antwoord.via === 'onderweg' && v.antwoord.keuze === 'ja');
    toets('8y vragen.json: antwoord ja via onderweg, zonder vingerafdruk', vrT && !vrT.antwoord.vingerafdruk && vrT.antwoord.apparaat === PIXEL, vrT);
    toets('8y de kaart gaat op beantwoord (door david)', statussen.some((s) => s.p_sleutel === z1.sleutel && s.p_naar === 'gedaan' && s.p_door === 'david'), statussen.slice(-3));
    const gT2 = gestart.length;
    r = await tikR('soort=kaart&doel=62&keuze=ja&tekst_id=' + vj[62].tekst_id);
    toets('8y tik JA op een agenda-vraag: 409 "vingerafdruk als je stilstaat", geen beurt', r.status === 409 && /vingerafdruk/.test(r.j.fout) && r.j.gevoelig === 'agenda' && gestart.length === gT2, r.j);
    r = await tikR('soort=kaart&doel=63&keuze=ja&tekst_id=' + vj[63].tekst_id);
    toets('8y tik JA op een versturen-vraag: 409 "in de Socev-app", geen beurt', r.status === 409 && /Socev-app/.test(r.j.fout) && gestart.length === gT2, r.j);
    await rond();
    r = await tikR('soort=kaart&doel=63&keuze=nee&tekst_id=' + vj[63].tekst_id);
    await tik(); await tik();
    toets('8y tik NEE op een gevoelige vraag mag wel: 200, [KNOP] NEE', r.status === 200 && gestart.slice(gT2).some((g) => /\[KNOP\] David drukte NEE/.test(g.prompt) && /Knopdruk in Onderweg \(auto\)/.test(g.prompt)), r.j);
    r = await tikR('soort=kaart&doel=64&keuze=ja&tekst_id=' + (vj[64].tekst_id === 'deadbeef' ? 'feedbeef' : 'deadbeef'));
    toets('8y tik met een oude tekst_id: 409 "veranderd"', r.status === 409 && /veranderd/.test(r.j.fout), r.j);
    r = await tikR('soort=kaart&doel=51&keuze=ja&tekst_id=deadbeef');
    toets('8y tik op de vraag van gisteren: 409', r.status === 409, r.j);
    r = await tel('GET', '/tel/uit?lijst=tik&soort=kaart&doel=64&keuze=ja&tekst_id=' + vj[64].tekst_id, { sleutel: TKV });
    toets('8y tik met een Tasker-sleutel: 404', r.status === 404, r.j);
    for (const q of ['soort=kaart&doel=64&keuze=anders&tekst_id=' + vj[64].tekst_id, 'soort=kaart&doel=64&keuze=ja', 'soort=iets&doel=64&keuze=ja', 'soort=vraag&doel=abc&keuze=ja']) {
      r = await tikR(q);
      toets('8y tik ongeldig (' + q.split('&')[0] + ' ' + q.split('&')[2] + '): 400', r.status === 400, r.j);
    }
    // een vraag onder een antwoord (autobeurt): uitgifte zegt of hij gevoelig is; tik = knopdruk
    await rond(); await rond();
    const itT = await vraagBeurt('Zal ik het proefrapport in de map Werk bewaren?');
    toets('8y uitgifte: vraag_gevoelig nee bij een gewone vraag', itT.vraag_gevoelig === 'nee', itT);
    const gV = gestart.length;
    r = await tikR('soort=vraag&doel=' + itT.vraag_job + ':' + itT.vraag_hash + '&keuze=ja');
    await tik(); await tik();
    const kbV = gestart.slice(gV).find((g) => /\[KNOP\] David drukte JA/.test(g.prompt));
    toets('8y tik JA op de vraag onder een antwoord: [KNOP]-beurt "Knopdruk in Onderweg (auto)"', r.status === 200 && !!kbV && /Knopdruk in Onderweg \(auto\)/.test(kbV.prompt) && kbV.prompt.includes(itT.vraag_hash), { r: r.j, p: gestart.slice(gV).map((g) => g.prompt.slice(0, 200)) });
    await rond(); await rond();
    const itG2 = await vraagBeurt('Zal ik de factuur van 200 euro betalen?');
    toets('8y uitgifte: vraag_gevoelig geld bij een geldvraag', itG2.vraag_gevoelig === 'geld', itG2);
    const gV2 = gestart.length;
    r = await tikR('soort=vraag&doel=' + itG2.vraag_job + ':' + itG2.vraag_hash + '&keuze=ja');
    toets('8y tik JA op een geldvraag: 409, geen beurt, onbeantwoord', r.status === 409 && gestart.length === gV2 && !JSON.parse(fs.readFileSync(path.join(DATA, 'vragen.json'), 'utf8'))[itG2.vraag_job + ':' + itG2.vraag_hash].antwoord, r.j);
    // CODEX MOET 2: een gesproken "ja" is geen knopdruk: gewone [AUTO]-beurt, de vraag blijft open
    const itS = await vraagBeurt('Zal ik het proefverslag opslaan?');
    const gS = gestart.length;
    r = await tel('POST', '/tel/beurt', { sleutel: OWV, ct: 'text/plain', body: 'ja' });
    await tik(); await tik();
    toets('8y gesproken ja: [AUTO]-beurt, geen [KNOP], de vraag blijft onbeantwoord', r.status === 202 && gestart.slice(gS).length === 1 && /\[AUTO\] ja/.test(gestart[gS].prompt) && !/\[KNOP\]/.test(gestart[gS].prompt) &&
      !JSON.parse(fs.readFileSync(path.join(DATA, 'vragen.json'), 'utf8'))[itS.vraag_job + ':' + itS.vraag_hash].antwoord, gestart.slice(gS).map((g) => g.prompt.slice(0, 120)));
    await rond();
    H.appStaat.tellers['tel-tik'] = Array(60).fill(Date.now());
    r = await tikR('soort=kaart&doel=64&keuze=ja&tekst_id=' + vj[64].tekst_id);
    toets('8y tik grens per uur: 429', r.status === 429, r.j);
    H.appStaat.tellers['tel-tik'] = [];
    toets('8y tel-audit zonder vraag of uitleg', !/proefkeuring|proefgarage|Proefoverleg|proefrapport/.test(audit()) && /tik kaart ja -> 200/.test(audit()) && /gesprek \d+ stukken/.test(audit()));
    toets('8y geen onverwachte fouten (gesprek, tik, autovragen)', !logs.some((l) => /tel-gesprek|tel-tik|briefing-autovragen/.test(l)), logs.filter((l) => /tel-gesprek|tel-tik|briefing-autovragen/.test(l)));
    // ── 8z. wv4017 (fase 2): herhaalvraag bij een agenda- of sms-voorstel; tweede tik = de ✅ uit de app; zonder vaste zin naar de app ──
    {
      const sha = (x) => crypto.createHash('sha256').update(String(x), 'utf8').digest('hex');
      const nonce = () => crypto.randomBytes(16).toString('hex'), h64 = () => crypto.randomBytes(32).toString('hex');
      const tNu = new Date().toISOString(), tot = Date.now() + 3600000;
      const AGT = 'Bevestig in je agenda:\nNieuwe afspraak in Davids Werk-agenda op dinsdag 1 december 2026, 15:00-16:00: "Proefoverleg salarissen", locatie "Proefzaal 3".';
      const WZT = 'Bevestig in je agenda:\nWijzig afspraak van woensdag 2 december 2026, 09:00-10:00 in Davids hoofdagenda, "Proefafspraak tandarts": tijd van woensdag 2 december 2026, 09:00-10:00 naar woensdag 2 december 2026, 11:00-12:00.';
      const VWT = 'Bevestig in je agenda:\nVerwijder afspraak van donderdag 3 december 2026, 09:00-10:00: "Proefafspraak weg" uit Davids hoofdagenda.';
      const OMT = 'Bevestig in je agenda:\nNieuwe afspraak in Davids hoofdagenda op vrijdag 4 december 2026 (hele dag): "Deadline: proefformulier", omschrijving "Lange uitleg met een link https://voorbeeld.test/x.".';
      const J = { ag: 'a1a1a1a1a1a1a1a1', wz: 'a2a2a2a2a2a2a2a2', vw: 'a3a3a3a3a3a3a3a3', om: 'a4a4a4a4a4a4a4a4', sms: 'a5a5a5a5a5a5a5a5', rk: 'a6a6a6a6a6a6a6a6', mk: 'a7a7a7a7a7a7a7a7', kl: 'a8a8a8a8a8a8a8a8', oud: 'a9a9a9a9a9a9a9a9', ge: 'aaaaaaaaaaaaaaa1' };
      const kaart = (tekst, x) => Object.assign({ kanaal: 'hoofd', t: tNu, knoppen: { uitvoeren: { nonce: nonce(), verloopt: tot, stand: 'open', sinds: null, pagina: null, uitkomst: null, hash: h64(), th: sha(tekst) } } }, x || {});
      const AK = {};
      AK[J.ag] = kaart(AGT); AK[J.wz] = kaart(WZT); AK[J.vw] = kaart(VWT); AK[J.om] = kaart(OMT);
      AK[J.sms] = { kanaal: 'hoofd', t: tNu, knoppen: { uitvoeren: { nonce: nonce(), verloopt: tot, stand: 'open', sinds: null, pagina: null, uitkomst: null } }, sms: { naar: '+31612345678', tekst: 'Proefbericht: ik ben om vijf uur thuis.', naam: 'Proefbuur' } };
      AK[J.rk] = kaart(AGT, { reeks: { id: 'proefreeks', nr: 1, van: 2 } });
      AK[J.mk] = kaart(AGT, { kanaal: 'machinekamer' });
      AK[J.kl] = kaart(AGT); AK[J.kl].knoppen.uitvoeren.stand = 'klaar';
      AK[J.oud] = kaart(AGT); delete AK[J.oud].knoppen.uitvoeren.hash;
      AK[J.ge] = kaart(AGT); AK[J.ge].knoppen.uitvoeren.th = sha(AGT + ' (anders)');
      const nonceAg = AK[J.ag].knoppen.uitvoeren.nonce, hashAg = AK[J.ag].knoppen.uitvoeren.hash;
      fs.writeFileSync(path.join(DATA, 'agenda-knoppen.json'), JSON.stringify(AK)); H.appStaat.agendaKnoppen = null;
      const lH = path.join(LOGDIR, 'hoofd.jsonl');
      [[J.ag, AGT], [J.wz, WZT], [J.vw, VWT], [J.om, OMT], [J.rk, AGT], [J.kl, AGT], [J.oud, AGT], [J.ge, AGT]].forEach(([id, tx]) =>
        fs.appendFileSync(lH, JSON.stringify({ t: tNu, job_id: id, soort: 'socev', bron: 'agenda', klasse: 'normaal', tekst: '', antwoord: tx, ok: true, bestanden: [] }) + '\n'));
      const n8n = [], sms = [];
      H.__zet('appKnopSleutel', () => 'nep-knop');
      H.__zet('appAgendaKnopN8n', async (b) => { n8n.push(b); return b.a === 'ja' ? { pagina: 'uitgevoerd', tekst: 'In je Werk-agenda gezet: proef.' } : { pagina: 'afgewezen' }; });
      H.__zet('appSmsKnop', async (res2, id, knop, keuze) => { sms.push({ id, knop, keuze }); return H.__haal('appStuur')(res2, 200, { ok: true, pagina: 'uitgevoerd', melding: '✅ Verstuurd.' }); });
      r = await tel('GET', '/tel/uit?lijst=voorjou', { sleutel: OWV });
      const VS = {}; (r.j.voorstellen || []).forEach((v) => { VS[v.id] = v; });
      toets('8z voorjou: voorstellen = open ✅ in het hoofdkanaal (niet machinekamer, klaar), hooguit 5', r.status === 200 && Array.isArray(r.j.voorstellen) && r.j.voorstellen.length === 5 && !VS[J.mk] && !VS[J.kl], r.j.voorstellen);
      toets('8z agendakaart: kan, tekst = herhaalzin zonder "Klopt dat?", geen nonce of hash', VS[J.ag] && VS[J.ag].kan === true && VS[J.ag].soort === 'agenda' &&
        VS[J.ag].tekst === 'Ik zet dinsdag 1 december 2026 van 15:00 tot 16:00 "Proefoverleg salarissen" in je Werk-agenda, locatie Proefzaal 3.' && !JSON.stringify(r.j).includes(nonceAg) && !JSON.stringify(r.j).includes(hashAg), VS[J.ag]);
      toets('8z verwijderen: kan false (altijd in de app)', VS[J.vw] && VS[J.vw].kan === false && VS[J.vw].tekst === null, VS[J.vw]);
      toets('8z wijzigen en omschrijving: vaste zin', VS[J.wz] && VS[J.wz].kan && /^Ik wijzig in je eigen agenda de afspraak "Proefafspraak tandarts" \(woensdag 2 december 2026 van 09:00 tot 10:00\): tijd van .* naar woensdag 2 december 2026, 11:00 tot 12:00\.$/.test(VS[J.wz].tekst) &&
        VS[J.om] && VS[J.om].kan && /de hele dag "Deadline: proefformulier" in je eigen agenda, met de omschrijving uit het voorstel\.$/.test(VS[J.om].tekst), [VS[J.wz], VS[J.om]]);
      // reeks, oud zonder hash en gewijzigde kaarttekst staan na de eerste 5; direct toetsen
      const vk = H.__haal('telVoorstelKnop');
      const vRk = await vk(J.rk), vOud = await vk(J.oud), vGe = await vk(J.ge);
      toets('8z reeks, voorstel zonder kaart-hash en gewijzigde kaarttekst: kan false', vRk && !vRk.kan && vOud && !vOud.kan && vGe && !vGe.kan && /anders dan vastgelegd/.test(vGe._waarom), [vRk, vOud, vGe]);
      const hz = (id, h) => tel('GET', '/tel/uit?lijst=herhaal&doel=' + id + '&h=' + h, { sleutel: OWV });
      const tv = (id, k, h, pas) => tel('GET', '/tel/uit?lijst=tik&soort=voorstel&doel=' + id + '&keuze=' + k + '&h=' + h + (pas ? '&pas=' + pas : ''), { sleutel: OWV });
      r = await hz(J.ag, VS[J.ag].h);
      toets('8z eerste tik (herhaal): 200, zin met "Klopt dat?", pas, niets uitgevoerd', r.status === 200 && r.j.zin === VS[J.ag].tekst + ' Klopt dat?' && /^[a-f0-9]{16}$/.test(r.j.pas) && n8n.length === 0, r.j);
      let pas = r.j.pas;
      r = await tv(J.ag, 'ja', VS[J.ag].h);
      toets('8z tweede tik zonder pas: 400, niets uitgevoerd', r.status === 400 && n8n.length === 0, r.j);
      r = await tv(J.ag, 'ja', VS[J.ag].h, pas.replace(/./, (c) => (c === 'a' ? 'b' : 'a')));
      toets('8z tweede tik met een verkeerde pas: 409, niets uitgevoerd', r.status === 409 && /herhaalvraag/.test(r.j.fout) && n8n.length === 0, r.j);
      r = await tv(J.ag, 'ja', VS[J.ag].h, pas);
      toets('8z de pas is na een mislukte poging op: 409', r.status === 409 && n8n.length === 0, r.j);
      r = await hz(J.ag, VS[J.ag].h); pas = r.j.pas;
      Object.values(H.telStaat.herhaal).forEach((x) => { x.tot = Date.now() - 1; });
      r = await tv(J.ag, 'ja', VS[J.ag].h, pas);
      toets('8z verlopen pas (90 s): 409, niets uitgevoerd', r.status === 409 && n8n.length === 0, r.j);
      // gewijzigde rij tussen de eerste en de tweede tik → 409 (Codex MOET 1)
      r = await hz(J.ag, VS[J.ag].h); pas = r.j.pas;
      const ak = H.__haal('appAgendaKnoppen')(), thOud = ak[J.ag].knoppen.uitvoeren.th;
      ak[J.ag].knoppen.uitvoeren.th = sha('iets anders');
      r = await tv(J.ag, 'ja', VS[J.ag].h, pas);
      toets('8z vastgelegde rij gewijzigd na de herhaalzin: 409 "veranderd", niets uitgevoerd', r.status === 409 && /veranderd/.test(r.j.fout) && n8n.length === 0, r.j);
      ak[J.ag].knoppen.uitvoeren.th = thOud;
      // rij vervangen terwijl de pod de kaarttekst ophaalt (Codex MOET 1 ronde 1): niet de nieuwe uitvoeren
      r = await hz(J.ag, VS[J.ag].h); pas = r.j.pas;
      const abOrig = H.__haal('appAndersBericht');
      let nonceOrig = null;
      H.__zet('appAndersBericht', async (k, id) => { const x = await abOrig(k, id); if (id === J.ag && !nonceOrig) { const K = H.__haal('appAgendaKnoppen')()[J.ag].knoppen.uitvoeren; nonceOrig = K.nonce; K.nonce = nonce(); } return x; });
      r = await tv(J.ag, 'ja', VS[J.ag].h, pas);
      H.__zet('appAndersBericht', abOrig);
      toets('8z rij vervangen tijdens het ophalen van de kaarttekst: 409, niets uitgevoerd', r.status === 409 && /veranderd/.test(r.j.fout) && n8n.length === 0 && !!nonceOrig, r.j);
      H.__haal('appAgendaKnoppen')()[J.ag].knoppen.uitvoeren.nonce = nonceOrig;
      r = await hz(J.ag, 'ffffffffffffffff');
      toets('8z herhaal met een oude h: 409 "veranderd"', r.status === 409 && /veranderd/.test(r.j.fout), r.j);
      // goed: herhaal → tweede tik = de ✅ (zelfde nonce, kaart-hash en tekst-hash naar Agenda-knoppen), zonder vingerafdruk, rijdend
      const aT = audit().length;
      r = await hz(J.ag, VS[J.ag].h); pas = r.j.pas;
      r = await tv(J.ag, 'ja', VS[J.ag].h, pas);
      toets('8z tweede tik: 200 uitgevoerd, één aanroep met n/a/h/t van de vastgelegde rij', r.status === 200 && r.j.ok === true && r.j.pagina === 'uitgevoerd' && n8n.length === 1 &&
        n8n[0].n === nonceAg && n8n[0].a === 'ja' && n8n[0].h === hashAg && n8n[0].t === sha(AGT), { r: r.j, n8n });
      toets('8z stand klaar; tel-audit zonder kaarttekst', H.__haal('appAgendaKnoppen')()[J.ag].knoppen.uitvoeren.stand === 'klaar' && /tik voorstel agenda ja -> 200 uitgevoerd/.test(audit().slice(aT)) && !/Proefoverleg|Proefzaal/.test(audit()), audit().slice(aT));
      r = await tv(J.ag, 'ja', VS[J.ag].h, pas);
      toets('8z dezelfde pas nog eens: 409, geen tweede aanroep', r.status === 409 && n8n.length === 1, r.j);
      r = await hz(J.ag, VS[J.ag].h);
      toets('8z na uitvoeren: herhaal 409 "niet meer open"', r.status === 409 && /niet meer open/.test(r.j.fout), r.j);
      // verwijderen → app
      r = await hz(J.vw, VS[J.vw].h);
      toets('8z verwijderen: herhaal 409 app "in de Socev-app", geen pas', r.status === 409 && r.j.app === true && /Socev-app/.test(r.j.fout) && !r.j.pas, r.j);
      // ❌ zonder herhaalvraag
      r = await tv(J.wz, 'nee', VS[J.wz].h);
      toets('8z ❌ zonder herhaalvraag: 200 afgewezen via de gewone ❌', r.status === 200 && r.j.pagina === 'afgewezen' && n8n.length === 2 && n8n[1].a === 'nee', { r: r.j, n8n });
      // sms
      r = await hz(J.sms, VS[J.sms].h);
      toets('8z sms herhaal: naam, nummer in cijfers en de letterlijke tekst', r.status === 200 && r.j.zin === 'Ik verstuur vanaf je eigen telefoon een sms aan Proefbuur, nummer 06 12 34 56 78, met de tekst: "Proefbericht: ik ben om vijf uur thuis.". Klopt dat?', r.j);
      r = await tv(J.sms, 'ja', VS[J.sms].h, r.j.pas);
      toets('8z sms tweede tik: 200, één keer de sms-knop', r.status === 200 && sms.length === 1 && sms[0].id === J.sms && sms[0].keuze === 'ja', { r: r.j, sms });
      // andere sleutels en vormen
      r = await tel('GET', '/tel/uit?lijst=herhaal&doel=' + J.om + '&h=' + VS[J.om].h, { sleutel: TKV });
      toets('8z herhaal met een Tasker-sleutel: 404', r.status === 404, r.j);
      r = await tel('GET', '/tel/uit?lijst=herhaal&doel=xyz&h=' + VS[J.om].h, { sleutel: OWV });
      toets('8z herhaal ongeldig: 400', r.status === 400, r.j);
      r = await hz('bbbbbbbbbbbbbbbb', VS[J.om].h);
      toets('8z herhaal zonder vastgelegde rij: 409', r.status === 409, r.j);
      toets('8z geen onverwachte fouten (herhaal)', !logs.some((l) => /tel-herhaal|app-agenda/.test(l)), logs.filter((l) => /tel-herhaal|app-agenda/.test(l)));
      fs.writeFileSync(path.join(DATA, 'agenda-knoppen.json'), '{}'); H.appStaat.agendaKnoppen = null;
    }
    H.__zet('appSbRpc', sbOrig);
    toets('8 geen onverwachte fouten (wv3700)', !logs.some((l) => /tel-voorjou/.test(l) && !/databank weg/.test(l)), logs.filter((l) => /tel-voorjou/.test(l)));
  } catch (e) { toets('uitzondering in de toets', false, e && e.stack); }
  srv.close();
  // ── 7. echte SIGTERM op een kindproces ──
  const kind = require('child_process').spawn(process.execPath, ['-e', `
    const fs=require('fs'),path=require('path'),vm=require('vm'),http=require('http'),crypto=require('crypto');
    const src=fs.readFileSync('server.js','utf8');const blok=src.slice(src.indexOf('// ── Socev-app poort'),src.indexOf('// ── einde socev-app poort'));
    const W=${JSON.stringify(W)};process.env.APP_DATA_DIR=path.join(W,'kind');process.env.APP_UIT_BESTAND=path.join(W,'kind-uit');process.env.TEL_UIT_BESTAND=path.join(W,'kind-tel-uit');process.env.APP_LOG_DIR=path.join(W,'kind-log');
    const c=vm.createContext({require,fs,path,crypto,Buffer,console,URL,setInterval,setTimeout,clearTimeout,AbortSignal,Promise,JSON,Date,URLSearchParams,process,
      VAULT:W,agentsReg:{},jobs:{},enqueue:()=>{},processJob:()=>{},DEFAULT_WS:'vault',sessionKey:(w,x)=>x,resolveKeuze:()=>({}),rol:{eerste:1},rolPrimair:()=>true,rolEerste:Promise.resolve(),ROL_START_WACHT_MS:100,
      fetch:async()=>({ok:false,status:404,json:async()=>({}),headers:{get:()=>null}}),SP_CHAT:'1',logError:()=>{},reqPath:(q)=>q.url.split('?')[0]});
    vm.runInContext(blok+';globalThis.__h={telStaat,telStuur};',c);
    // een open lange vraag rechtstreeks in de rij (de routes zelf toetst het deel hierboven)
    http.createServer((q,s)=>{c.__h.telStaat.polls.x={res:s,timer:setTimeout(()=>{},60000)};s._tel={};}).listen(0,'127.0.0.1',function(){console.log('POORT '+this.address().port);});`],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  let poort = null;
  kind.stdout.on('data', async (d) => {
    const m = /POORT (\d+)/.exec(String(d));
    if (!m || poort) return;
    poort = Number(m[1]);
    const t0 = Date.now();
    const p = new Promise((ok) => http.get({ host: '127.0.0.1', port: poort, path: '/tel/uit?wacht=50' }, (res) => { let t = ''; res.on('data', (c) => t += c); res.on('end', () => ok({ status: res.statusCode, t })); }).on('error', (e) => ok({ status: 0, t: e.code })));
    await wacht(300);
    kind.kill('SIGTERM');
    const r = await p;
    toets('7 echte SIGTERM: open lange vraag krijgt 200 {ok, bezig}', r.status === 200 && /"ok":true/.test(r.t) && /"bezig"/.test(r.t) && Date.now() - t0 < 3000, r);
  });
  kind.on('exit', (code, sig) => {
    toets('7 kind sterft daarna aan SIGTERM (zoals zonder handler; supervisor herstart)', sig === 'SIGTERM' && code === null, { code, sig });
    try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {}
    console.log(fouten ? fouten + ' ROOD, ' + goed + ' GROEN' : 'TOETS GROEN (' + goed + ')');
    process.exit(fouten ? 1 : 0);
  });
  setTimeout(() => { toets('7 kind reageerde binnen 15 s', false); kind.kill('SIGKILL'); }, 15000).unref();
});
JS
