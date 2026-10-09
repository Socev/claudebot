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
                      ['const TEL_ZELF_AANKONDIG_MS = 20 * 1000;', 'const TEL_ZELF_AANKONDIG_MS = 400;']]) {
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
  url = String(url);
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
  rol: rolStub, rolPrimair: () => rolStub.primair, rolEerste: Promise.resolve(), ROL_START_WACHT_MS: 100,
  fetch: nepFetch, SP_CHAT: '40687', logError: (w, e) => logs.push(w + ': ' + (e && e.message || JSON.stringify(e))),
  reqPath: (req) => { const u = req.url || ''; const i = u.indexOf('?'); return i === -1 ? u : u.slice(0, i); } });
const EXPORT = '\n;globalThis.__h = { handleApp, appIsPad, handleTel, telIsPad, telStaat, appStaat, appNoodstop, appAan, appOntmasker, telAfsluiten, telSpreektekst, telOpname, telInfo, appInfo, telOpruim, TEL_ROUTE_RE, telMerkAgent, telZelfStart, telZelfNaRun, telAanwezig, telBelletje, agentsReg, TEL_ZELF_AANKONDIGING };';
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
    toets('8 start: gemerkt + aanwezig -> regel vooraf, job gekoppeld', /^\[AUTO-RAPPORT\]/.test(hint) && /Verder in Telegram:/.test(hint) && jobs[run1].tel_zelf === ja1 && H.agentsReg[ja1].tel.gebruikt === run1, hint);
    toets('8 start: tweede /run met hetzelfde agent_job (herkansing) -> geen regel', H.telZelfStart(ja1, 'b2b2b2b2b2b2b2b2') === '' && H.telStaat.zelf.dubbel >= 1);
    const nTts0 = st.tts.length;
    jobs[run1] = Object.assign(jobs[run1], { status: 'done', result: { ok: true, output: 'De tweede offerte is goedkoper, ongeveer **tien procent**. Zie [link](https://x.y).\n\nVRAAG AAN DAVID: Zal ik de leverancier mailen?\n\nVerder in Telegram:\n- bedrag 1\n- bedrag 2' } });
    const pZ = tel('GET', '/tel/uit?wacht=10&plek=Auto'); await wacht(100);
    const xz = H.telZelfNaRun(run1);
    r = await pZ;
    toets('8 na de afweging: item zelf, meteen naar de open lange vraag, aankondigen ja', xz && r.j.id === ja1 && r.j.soort === 'zelf' && r.j.aankondigen === 'ja', r.j);
    toets('8 spreektekst: zonder "Verder in Telegram", vraag "in Telegram"', xz && !/bedrag|https|\*\*/.test(xz.spreek) && /Ik heb een vraag voor je in Telegram\.$/.test(xz.spreek), xz && xz.spreek);
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
    toets('6 geen onverwachte fouten in logError', !logs.some((l) => !/^(app-|tel-whisper|tel-deel)/.test(l) || /uitzondering/.test(l)), logs);
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
