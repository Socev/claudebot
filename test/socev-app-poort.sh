#!/usr/bin/env bash
# Toetst de Socev-app poort (/app/*, server.js handleApp, fase 1, 7-10-2026) zonder de pod te starten: het blok wordt
# uit server.js geknipt en in een vm-context achter een eigen http-server gedraaid (zoals test/sleutelportaal.sh).
# Access (certs + bewijs) en Telegram zijn nagebootst; de passkeys zijn ECHT: Chromium met een virtuele authenticator
# op https://app.socev.dev (verzoeken onderschept door deze toets, die de rol van de Pages Function speelt).
# Raakt de echte pod, Cloudflare en Telegram niet. Klokken verkort via tekstvervanging.
# Gebruik: bash test/socev-app-poort.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http'), os = require('os'), crypto = require('crypto');
let src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf('// ── Socev-app poort'), b = src.indexOf('// ── einde socev-app poort');
if (a < 0 || b < 0) { console.log('ROOD: blok niet gevonden'); process.exit(1); }
let blok = src.slice(a, b);
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra && !ok ? '  [' + String(extra).slice(0, 300) + ']' : '')); }
for (const [x, y] of [['const APP_CODE_INTERVAL_MS = 60 * 1000;', 'const APP_CODE_INTERVAL_MS = 1000;'],
                      ['const APP_VERS_MS = 2 * 60 * 1000;', 'const APP_VERS_MS = 4000;']]) {
  if (blok.indexOf(x) < 0) toets('vervanging gevonden: ' + x, false); blok = blok.split(x).join(y);
}
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'apptoets-'));
const DATA = path.join(W, 'data'); fs.mkdirSync(DATA, { recursive: true });
fs.symlinkSync('/opt/data/socev-app-data/vendor', path.join(DATA, 'vendor'));   // brug-pad ook getoetst
const UIT = path.join(W, 'app-uit');
const TEAM = 'https://huisdokter.cloudflareaccess.com', AUD = 'a'.repeat(64), CLIENT = 'proefclient.access', POORT = 'p'.repeat(64);
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ access_team: TEAM, access_aud: AUD, servicetoken_client_id: CLIENT }));
const OMLIJST = fs.readFileSync('/opt/data/socev-app-data/machinekamer-omlijsting.txt', 'utf8');
fs.writeFileSync(path.join(DATA, 'machinekamer-omlijsting.txt'), OMLIJST);
const LOGDIR = path.join(W, 'app-log');
// Broedstoof (wv92): echte ideeënbus als kopie; databank nagebootst
const BUS = path.join(W, 'bus.md');
fs.copyFileSync('/opt/data/AI_SecondBrain/01_Ontwikkeling/Ideeënbus David - vibecoden.md', BUS);
const SB = 'https://sb.toets';
const sbRpc = [];
const sbStaat = { voorrang: {}, items: [], kapot: false };
const agentsReg = {};
const BEWAAR = path.join(W, 'app-bestanden');   // fase 5a (wv98)

// nep-Access: eigen RSA-sleutel met kid 'proef'
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const vreemd = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'proef', alg: 'RS256' });
function jwt(over, sleutel, kid) {
  const nu = Math.floor(Date.now() / 1000);
  const k = Buffer.from(JSON.stringify({ alg: 'RS256', kid: kid || 'proef', typ: 'JWT' })).toString('base64url');
  const i = Buffer.from(JSON.stringify(Object.assign({ aud: [AUD], iss: TEAM, common_name: CLIENT, type: 'app', sub: '', iat: nu, exp: nu + 600 }, over || {}))).toString('base64url');
  return k + '.' + i + '.' + crypto.sign('RSA-SHA256', Buffer.from(k + '.' + i), sleutel || privateKey).toString('base64url');
}
const telegram = [];
let certsTeller = 0, certsVertraging = 0, klokScheef = 0;
async function nepFetch(url, opt) {
  url = String(url);
  const antw = (status, j, kop) => ({ ok: status < 300, status, json: async () => j, text: async () => JSON.stringify(j), headers: { get: (n) => (kop || {})[String(n).toLowerCase()] || null } });
  if (url === TEAM + '/cdn-cgi/access/certs') {
    certsTeller++;
    if (certsVertraging) await new Promise((r) => setTimeout(r, certsVertraging));
    return antw(200, { keys: [jwk] }, { date: new Date(Date.now() - klokScheef).toUTCString() });
  }
  if (url.startsWith('https://api.telegram.org/')) { telegram.push(JSON.parse(opt.body).text); return antw(200, { ok: true }); }
  if (url.startsWith(SB + '/rest/v1/rpc/')) {
    const fn = url.slice((SB + '/rest/v1/rpc/').length), b = JSON.parse(opt.body || '{}');
    sbRpc.push({ fn, b, sleutel: opt.headers && opt.headers.apikey });
    if (sbStaat.kapot) return antw(500, { message: 'kapot' });
    if (fn === 'mk_broedstoof') return antw(200, { voorrang: Object.keys(sbStaat.voorrang).filter((k) => sbStaat.voorrang[k] > 0).map((k) => ({ idee: Number(k), voorrang: sbStaat.voorrang[k], bijgewerkt: new Date().toISOString(), door: 'x' })),
      items: sbStaat.items, ruimte: { mag: true, pad: 'vrij', reden: 'vrije periode tot 10-10 23:00' },
      tikker: { aan: true, reden: 'wacht op ruimte: dagmaximum (42 starts)', laatste_tik: new Date().toISOString(), starts_vandaag: 42, max_dag: 24, alleen_doorwerk: true } });
    if (fn === 'mk_werkvoorraad_stand') return antw(200, { items: sbStaat.wvItems || [], stand: { aan: true }, ruimte: { mag: true, pad: 'vrij', reden: 'vrije periode tot 10-10 23:00' } });
    if (fn === 'mk_idee_voorrang') {
      const van = sbStaat.voorrang[b.p_idee] || 0, max = Math.max(0, ...Object.values(sbStaat.voorrang));
      const naar = b.p_actie === 'normaal' ? 0 : (van > 0 && van === max ? van : max + 1);
      sbStaat.voorrang[b.p_idee] = naar;
      return antw(200, { ok: true, idee: b.p_idee, van, voorrang: naar, gewijzigd: naar !== van });
    }
    return antw(404, {});
  }
  return antw(404, {});
}
const logs = [];
// nagebootste pod rond het blok: jobs, wachtrij per gesprek (zoals enqueue), processJob die de toets zelf afmaakt, rolwachter
const jobs = {}, ketens = {}, gestart = [], afmaken = {};
function enqueue(key, fn) { const prev = ketens[key] || Promise.resolve(); const next = prev.then(fn, fn).catch(() => {}); ketens[key] = next; return next; }
function processJob(jobId, prompt, sess, files, chatId, ws, keuze) {
  const j = jobs[jobId]; j.status = 'running'; j.started = Date.now(); j.progress = { running_ms: 5, last_activity_ms: 1 };
  gestart.push({ jobId, prompt, chatId, ws, keuze });
  return new Promise((r) => { afmaken[jobId] = (uit, ok) => { j.status = 'done'; j.done_at = Date.now(); j.result = { ok: ok !== false, output: ok === false ? '' : uit, error: ok === false ? uit : undefined, files: [] }; r(); }; });
}
const rolStub = { eerste: 1, primair: true };
const ctx = vm.createContext({ require, fs, path, crypto, Buffer, console, setInterval, setTimeout, clearTimeout, AbortSignal, Promise, JSON, Date, URLSearchParams,
  process: { env: { APP_DATA_DIR: DATA, APP_UIT_BESTAND: UIT, TELEGRAM_DEBUG_BOT_TOKEN: 'nep', APP_POORT_SECRET: POORT, APP_LOG_DIR: LOGDIR,
    APP_BUS_PAD: BUS, SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE: 'nep-sleutel', APP_BESTANDEN_DIR: BEWAAR }, pid: process.pid },
  agentsReg,
  jobs, enqueue, processJob, DEFAULT_WS: 'vault', sessionKey: (ws, c) => (ws === 'vault' ? c : ws + ':' + c), resolveKeuze: () => ({ runtime: 'claude', model: '' }),
  rol: rolStub, rolPrimair: () => rolStub.primair, rolEerste: Promise.resolve(), ROL_START_WACHT_MS: 100,
  fetch: nepFetch, SP_CHAT: '40687', logError: (w, e) => logs.push(w + ': ' + (e && e.message || JSON.stringify(e))),
  reqPath: (req) => { const u = req.url || ''; const i = u.indexOf('?'); return i === -1 ? u : u.slice(0, i); } });
vm.runInContext(blok + '\n;globalThis.__h = { handleApp, appIsPad, appInfo, appStaat, appNoodstop, appAan, appStartBeurt, appBewaar, appBestandenOpruim, appRoute, appLabelGewoon };', ctx, { filename: 'server.js#app' });
const H = ctx.__h;
const srv = http.createServer((q, s) => { if (H.appIsPad(q)) return H.handleApp(q, s); s.writeHead(418); s.end(); });

// ── de "Pages Function" van deze toets: cookiepot per browser, koppen erbij ──
function pot() { return { koppel: '', apparaat: '', sessie: '' }; }
function vraag(m, pad, body, o) {
  o = o || {};
  const koppen = { 'content-type': 'application/json', 'x-app-ua': o.ua || (o.pot && o.pot.ua) || 'Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/141.0' };
  if (o.poort !== false) koppen['x-app-poort'] = o.poort || POORT;
  if (o.jwt !== false) koppen['cf-access-jwt-assertion'] = o.jwt || jwt();
  const p = o.pot;
  if (p) { if (p.koppel) koppen['x-app-koppel'] = p.koppel; if (p.apparaat) koppen['x-app-apparaat'] = p.apparaat; if (p.sessie) koppen['x-app-sessie'] = p.sessie; }
  return new Promise((ok) => {
    const r = http.request({ host: '127.0.0.1', port: srv.address().port, path: pad, method: m, headers: koppen }, (res) => {
      if (res.headers['x-app-pod'] !== '1') console.log('ROOD  kop X-App-Pod ontbreekt op ' + pad);
      let t = ''; res.on('data', (c) => t += c); res.on('end', () => {
        let j = {}; try { j = JSON.parse(t); } catch (e) { j = { raw: t }; }
        const ck = res.headers['x-app-cookies'] ? JSON.parse(res.headers['x-app-cookies']) : null;
        if (ck && p) for (const n of Object.keys(ck)) p[n] = ck[n] ? ck[n].w : '';
        ok({ status: res.statusCode, j, ck });
      });
    });
    r.on('error', (e) => ok({ status: 0, j: { fout: e.code } }));
    if (body !== undefined && m === 'POST') r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}
const codeUit = (t) => (/koppelcode (\d{8})/.exec(t || '') || [])[1];
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

// in de pagina: opties-JSON <-> WebAuthn (zoals @simplewebauthn/browser)
const PAGINA = `<!doctype html><meta charset=utf-8><title>proef</title><script>
const b2a = (s) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/') + '==='.slice((s.length+3)%4)), c => c.charCodeAt(0)).buffer;
const a2b = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
async function post(pad, body) { const r = await fetch(pad, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' }, body: JSON.stringify(body || {}) }); return { status: r.status, j: await r.json() }; }
async function maak(o) {
  const pk = Object.assign({}, o, { challenge: b2a(o.challenge), user: Object.assign({}, o.user, { id: b2a(o.user.id) }),
    excludeCredentials: (o.excludeCredentials || []).map(c => Object.assign({}, c, { id: b2a(c.id) })) });
  const c = await navigator.credentials.create({ publicKey: pk });
  return { id: c.id, rawId: a2b(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment, clientExtensionResults: c.getClientExtensionResults(),
    response: { clientDataJSON: a2b(c.response.clientDataJSON), attestationObject: a2b(c.response.attestationObject), transports: c.response.getTransports() } };
}
async function bewijs(o) {
  const pk = Object.assign({}, o, { challenge: b2a(o.challenge), allowCredentials: (o.allowCredentials || []).map(c => Object.assign({}, c, { id: b2a(c.id) })) });
  const c = await navigator.credentials.get({ publicKey: pk });
  return { id: c.id, rawId: a2b(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment, clientExtensionResults: c.getClientExtensionResults(),
    response: { clientDataJSON: a2b(c.response.clientDataJSON), authenticatorData: a2b(c.response.authenticatorData), signature: a2b(c.response.signature),
      userHandle: c.response.userHandle ? a2b(c.response.userHandle) : undefined } };
}
</script>`;

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const pw = require('/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
  const exe = fs.readdirSync('/opt/pw-browsers').filter((d) => /^chromium-\d+$/.test(d)).map((d) => '/opt/pw-browsers/' + d + '/chrome-linux64/chrome').find((f) => fs.existsSync(f));
  const browser = await pw.chromium.launch({ executablePath: exe, headless: true });
  async function nieuweBrowser(transport, ua) {
    const c = await browser.newContext();
    const p = await c.newPage();
    const jar = pot();
    if (ua) jar.ua = ua;
    await p.route('https://app.socev.dev/**', async (route) => {
      const u = new URL(route.request().url());
      if (!u.pathname.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'text/html', body: PAGINA });
      const r = await vraag(route.request().method(), '/app/' + u.pathname.slice(5), route.request().postData() || '{}', { pot: jar });
      route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.j) });
    });
    await p.goto('https://app.socev.dev/');
    const cdp = await c.newCDPSession(p);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: transport || 'internal',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    return { c, p, jar, cdp, authenticatorId };
  }
  try {
    // ── 1. sloten vóór de routes ──
    let r = await vraag('GET', '/app/status', undefined, { poort: false });
    toets('1 zonder poortgeheim 401', r.status === 401, JSON.stringify(r));
    r = await vraag('GET', '/app/status', undefined, { poort: 'q'.repeat(64) });
    toets('1 fout poortgeheim 401', r.status === 401);
    r = await vraag('GET', '/app/status', undefined, { jwt: false });
    toets('1 poortgeheim maar geen Access-bewijs 401', r.status === 401, JSON.stringify(r));
    for (const [naam, t] of [['andere aud', jwt({ aud: ['b'.repeat(64)] })], ['ander iss', jwt({ iss: 'https://x.cloudflareaccess.com' })],
      ['ander servicetoken', jwt({ common_name: 'ander.access' })], ['gebruikersbewijs (e-mail, geen common_name)', jwt({ common_name: undefined, email: 'd.schaap@gmail.com', sub: 'x' })],
      ['verlopen', jwt({ exp: Math.floor(Date.now() / 1000) - 120 })], ['vervalst (eigen sleutel, echte kid)', jwt({}, vreemd)], ['onbekende kid', jwt({}, privateKey, 'anders')],
      ['alg none', Buffer.from('{"alg":"none","kid":"proef"}').toString('base64url') + '.' + jwt().split('.')[1] + '.']]) {
      r = await vraag('GET', '/app/status', undefined, { jwt: t });
      toets('1 Access-bewijs ' + naam + ' -> 401', r.status === 401, r.status);
    }
    r = await vraag('GET', '/app/status');
    toets('1 alles goed -> status 200, koppelen open, geen sessie', r.status === 200 && r.j.koppelen_open === true && r.j.sessie === false && r.j.passkey_klaar === true, JSON.stringify(r.j));
    r = await vraag('GET', '/app/apparaten');
    toets('1 alles behalve een pod-sessie -> 401', r.status === 401, r.status);
    for (const pad of ['/app/../run', '/app/%2e%2e/run', '/app/status/../../run', '/app/X', '/app', '/app/', '/app/status?x=1&y=../']) {
      r = await vraag('GET', pad);
      toets('1 pad ' + pad + ' -> 404 (status 200 alleen voor de querystring-variant)', pad.indexOf('?') > 0 ? r.status === 200 : r.status === 404, r.status);
    }
    r = await vraag('PUT', '/app/status');
    toets('1 PUT -> 404', r.status === 404);
    r = await vraag('POST', '/app/koppel/code', 'x'.repeat(70 * 1024));
    toets('1 te grote body -> 400 of afgebroken', r.status === 400 || r.status === 0, r.status);
    fs.writeFileSync(UIT, '');
    r = await vraag('GET', '/app/status');
    const r2 = await vraag('GET', '/app/status', undefined, { poort: false });
    toets('1 noodstop app-uit -> 503 (ook zonder geheim)', r.status === 503 && r2.status === 503, r.status + '/' + r2.status);
    fs.unlinkSync(UIT);

    // ── 2. koppelcode ──
    const A = pot(), B = pot();
    r = await vraag('POST', '/app/koppel/code', {}, { pot: A });
    const code1 = codeUit(telegram[telegram.length - 1]);
    toets('2 code aangevraagd: 200, Telegram met 8 cijfers, koppelcookie', r.status === 200 && !!code1 && /^[a-f0-9]{64}$/.test(A.koppel) && telegram.length === 1, JSON.stringify(r) + telegram);
    toets('2 Telegram noemt browser en systeem', /Chrome op Android/.test(telegram[0]));
    r = await vraag('POST', '/app/koppel/code', {}, { pot: A });
    toets('2 tweede code binnen de minuut -> 429, geen tweede bericht', r.status === 429 && telegram.length === 1, r.status);
    r = await vraag('POST', '/app/koppel/opties', { code: code1 }, { pot: B });
    toets('2 juiste code uit een andere browser -> 403', r.status === 403 && /andere browser/.test(r.j.fout), JSON.stringify(r.j));
    for (let i = 0; i < 6; i++) r = await vraag('POST', '/app/koppel/opties', { code: code1 }, { pot: B });
    toets('2 vreemde browser telt niet mee als poging (Fable #6): na 7 keer nog steeds "andere browser"', r.status === 403 && /andere browser/.test(r.j.fout), JSON.stringify(r.j));
    await slaap(1100);
    r = await vraag('POST', '/app/koppel/code', {}, { pot: B });
    toets('2 andere browser kan Davids lopende code niet overschrijven (409)', r.status === 409 && /loopt al/.test(r.j.fout) && telegram.length === 1, JSON.stringify(r.j));
    for (let i = 0; i < 4; i++) r = await vraag('POST', '/app/koppel/opties', { code: code1 === '00000000' ? '11111111' : '00000000' }, { pot: A });
    toets('2 vierde eigen fout: nog 1 poging', r.status === 403 && /nog 1/.test(r.j.fout), JSON.stringify(r.j));
    r = await vraag('POST', '/app/koppel/opties', { code: code1 === '00000000' ? '11111111' : '00000000' }, { pot: A });
    toets('2 vijfde mislukte poging maakt de code ongeldig', r.status === 403 && /ongeldig gemaakt/.test(r.j.fout), JSON.stringify(r.j));
    r = await vraag('POST', '/app/koppel/opties', { code: code1 }, { pot: A });
    toets('2 zesde poging (nu met de juiste code) -> 403', r.status === 403, JSON.stringify(r.j));
    await slaap(1100);
    // daggrens: 10 per dag (bijgehouden op schijf, overleeft een herstart)
    const st = JSON.parse(fs.readFileSync(path.join(DATA, 'staat.json'), 'utf8'));
    toets('2 codetijden op schijf', Array.isArray(st.code_tijden) && st.code_tijden.length === 1);
    fs.writeFileSync(path.join(DATA, 'staat.json'), JSON.stringify({ code_tijden: Array.from({ length: 10 }, (_, i) => Date.now() - 3600000 * (i + 2)) }));
    r = await vraag('POST', '/app/koppel/code', {}, { pot: A });
    toets('2 elfde code op een dag -> 429', r.status === 429 && telegram.length === 1, r.status);
    fs.writeFileSync(path.join(DATA, 'staat.json'), JSON.stringify(st));

    // ── 3. registratie met echte WebAuthn (virtuele authenticator) ──
    const X = await nieuweBrowser('internal');
    r = await vraag('POST', '/app/koppel/code', {}, { pot: X.jar });
    const code2 = codeUit(telegram[telegram.length - 1]);
    toets('3 nieuwe code na de minuut', r.status === 200 && !!code2 && code2 !== code1, JSON.stringify(r.j));
    let opt = await X.p.evaluate((c) => post('/api/koppel/opties', { code: c }), code2);
    const sel = opt.j.opties && opt.j.opties.authenticatorSelection || {};
    toets('3 registratie-opties: platform, UV required, rp app.socev.dev', opt.status === 200 && sel.authenticatorAttachment === 'platform' && sel.userVerification === 'required' && opt.j.opties.rp.id === 'app.socev.dev', JSON.stringify(opt));
    // "ander apparaat": een USB-sleutel of telefoon wordt door de browser al niet aangeboden bij 'platform' ...
    const U = await nieuweBrowser('usb');
    const usb = await U.p.evaluate((o) => maak(Object.assign({}, o, { timeout: 3000 })).then(() => 'gelukt', (e) => e.name), opt.j.opties);
    toets('3 browser biedt een USB-sleutel niet aan bij platform (NotAllowedError)', usb === 'NotAllowedError', usb);
    // ... en als iemand het antwoord vervalst, weigert de pod het
    let cred = await X.p.evaluate((o) => maak(o), opt.j.opties);
    toets('3 platform-passkey gemaakt in de browser', cred && cred.authenticatorAttachment === 'platform', JSON.stringify(cred).slice(0, 200));
    r = await X.p.evaluate((c) => post('/api/koppel/registreer', { antwoord: Object.assign({}, c, { authenticatorAttachment: 'cross-platform' }) }), cred);
    toets('3 registratie als "ander apparaat" (cross-platform) -> 403', r.status === 403 && /dit apparaat zelf/.test(r.j.fout), JSON.stringify(r));
    r = await X.p.evaluate((c) => post('/api/koppel/registreer', { antwoord: c }), cred);
    toets('3 echt antwoord op een al gebruikte (geweigerde) uitdaging -> 403', r.status === 403 && /uitdaging verlopen/.test(r.j.fout), JSON.stringify(r));
    const Y = await nieuweBrowser('internal');
    r = await Y.p.evaluate(() => post('/api/koppel/opties', {}));
    toets('3 andere browser kan niet meeliften op de geverifieerde code -> 403', r.status === 403, JSON.stringify(r));
    opt = await X.p.evaluate(() => post('/api/koppel/opties', {}));
    cred = await X.p.evaluate((o) => maak(o), opt.j.opties);
    // zoals een passkey van Google Wachtwoordbeheer op Android: transports hybrid + internal, attachment platform (review #1)
    r = await X.p.evaluate((c) => post('/api/koppel/registreer', { antwoord: Object.assign({}, c, { response: Object.assign({}, c.response, { transports: ['hybrid', 'internal', 'raar<x>'] }) }), naam: 'Pixel <script>' }), cred);
    toets('3 echte registratie (GPM-achtig: hybrid+internal, platform) -> 200, apparaat + sessie', r.status === 200 && r.j.apparaat && r.j.apparaat.naam === 'Pixel script' && /^[a-f0-9]{16}\.[a-f0-9]{64}$/.test(X.jar.apparaat) && /^[a-f0-9]{64}$/.test(X.jar.sessie) && X.jar.koppel === '', JSON.stringify(r) + JSON.stringify(X.jar));
    toets('3 melding "apparaat gekoppeld" naar Telegram', /apparaat gekoppeld/.test(telegram[telegram.length - 1]));
    const reg = JSON.parse(fs.readFileSync(path.join(DATA, 'apparaten.json'), 'utf8'));
    const regTekst = JSON.stringify(reg);
    toets('3 user-handle per apparaat willekeurig (niet de vaste naam)', opt.j.opties.user.id !== Buffer.from('socev-app-david').toString('base64url') && !(opt.j.opties.excludeCredentials || []).length);
    toets('3 eerste apparaat (coderoute) is de goedkeurder', reg.apparaten[0].goedkeurder === true && r.j.apparaat.goedkeurder === true, JSON.stringify(reg.apparaten[0]).slice(0, 200));
    toets('3 transports gefilterd op bekende waarden (Fable #9)', JSON.stringify(reg.apparaten[0].credential.transports) === '["hybrid","internal"]', JSON.stringify(reg.apparaten[0].credential.transports));
    toets('3 register: één apparaat, alleen een hash van het cookiegeheim, 0600', reg.apparaten.length === 1 && reg.ooit_gekoppeld === true && regTekst.indexOf(X.jar.apparaat.split('.')[1]) < 0 && (fs.statSync(path.join(DATA, 'apparaten.json')).mode & 0o077) === 0, regTekst.slice(0, 200));
    r = await vraag('GET', '/app/apparaten', undefined, { pot: X.jar });
    toets('3 met sessie: apparatenlijst 200', r.status === 200 && r.j.apparaten.length === 1 && r.j.apparaten[0].dit_apparaat === true, JSON.stringify(r.j));
    r = await vraag('POST', '/app/koppel/code', {}, { pot: pot() });
    toets('3 daarna is de coderoute dicht -> 403', r.status === 403 && /dicht/.test(r.j.fout), JSON.stringify(r.j));
    r = await vraag('GET', '/app/status', undefined, { pot: X.jar });
    toets('3 status: apparaat + sessie, koppelen dicht', r.j.koppelen_open === false && r.j.sessie === true && r.j.apparaat.id === reg.apparaten[0].id, JSON.stringify(r.j));

    // ── 4. openen met de vingerafdruk ──
    await vraag('POST', '/app/uitloggen', {}, { pot: X.jar });
    r = await vraag('GET', '/app/apparaten', undefined, { pot: X.jar });
    toets('4 na uitloggen -> 401', r.status === 401 && X.jar.sessie === '');
    opt = await X.p.evaluate(() => post('/api/passkey/opties', {}));
    toets('4 passkey-opties: alleen de passkey van dit apparaat, UV required', opt.status === 200 && opt.j.opties.allowCredentials.length === 1 && opt.j.opties.allowCredentials[0].id === reg.apparaten[0].credential.id && opt.j.opties.userVerification === 'required', JSON.stringify(opt));
    const bew = await X.p.evaluate((o) => bewijs(o), opt.j.opties);
    r = await X.p.evaluate((x) => post('/api/passkey/bevestig', { antwoord: x }), bew);
    toets('4 vingerafdruk -> sessie', r.status === 200 && /^[a-f0-9]{64}$/.test(X.jar.sessie), JSON.stringify(r));
    r = await vraag('GET', '/app/apparaten', undefined, { pot: X.jar });
    toets('4 met nieuwe sessie: 200', r.status === 200);
    {
      // lezen en pollen schuiven de sessie niet op (Fable-review 7-10 #1)
      const sx = H.appStaat.sessies[crypto.createHash('sha256').update(X.jar.sessie).digest('hex')];
      const totVoor = Date.now() + 1500; sx.tot = totVoor;
      for (let i = 0; i < 3; i++) { await vraag('GET', '/app/status', undefined, { pot: X.jar }); await vraag('GET', '/app/apparaten', undefined, { pot: X.jar }); await slaap(300); }
      toets('4 status/apparaten (lezen) schuiven de sessie niet op', sx.tot === totVoor, sx.tot - totVoor);
      await slaap(700);
      r = await vraag('GET', '/app/apparaten', undefined, { pot: X.jar });
      toets('4 open app die alleen leest: na de stilte-grens -> 401', r.status === 401, r.status);
      const bew2 = await X.p.evaluate(async () => { const o = await post('/api/passkey/opties', {}); return bewijs(o.j.opties); });
      r = await X.p.evaluate((x) => post('/api/passkey/bevestig', { antwoord: x }), bew2);
      toets('4 opnieuw vingerafdruk -> sessie', r.status === 200 && /^[a-f0-9]{64}$/.test(X.jar.sessie), JSON.stringify(r));
    }
    const sessieOud = X.jar.sessie;
    r = await X.p.evaluate((x) => post('/api/passkey/bevestig', { antwoord: x }), bew);
    toets('4 herhaald bewijs (replay) -> 401', r.status === 401, JSON.stringify(r));
    // vreemde browser met dezelfde sessie maar zonder apparaatcookie
    r = await vraag('GET', '/app/apparaten', undefined, { pot: { sessie: sessieOud } });
    toets('4 sessie zonder apparaatcookie -> 401', r.status === 401);
    r = await vraag('POST', '/app/passkey/opties', {}, { pot: { apparaat: X.jar.apparaat.split('.')[0] + '.' + 'f'.repeat(64) } });
    toets('4 vervalst apparaatcookie -> 401', r.status === 401);
    r = await Y.p.evaluate(() => post('/api/passkey/opties', {}));
    toets('4 browser zonder apparaatcookie krijgt geen uitdaging -> 401', r.status === 401);
    // bewijs uit een andere authenticator (Y heeft een eigen passkey voor hetzelfde rp) wordt geweigerd
    opt = await X.p.evaluate(() => post('/api/passkey/opties', {}));
    const vreemdBewijs = await Y.p.evaluate((o) => bewijs(Object.assign({}, o, { allowCredentials: [] })).then((x) => x, (e) => e.name), opt.j.opties);
    toets('4 andere authenticator heeft geen passkey voor dit apparaat', vreemdBewijs === 'NotAllowedError', JSON.stringify(vreemdBewijs).slice(0, 100));

    // ── 5. intrekken (gevoelig: verse vingerafdruk) ──
    await slaap(4200);
    r = await vraag('POST', '/app/apparaat/intrekken', { id: reg.apparaten[0].id }, { pot: X.jar });
    toets('5 intrekken met een te oude vingerafdruk -> 403', r.status === 403 && /opnieuw/.test(r.j.fout), JSON.stringify(r.j));
    opt = await X.p.evaluate(() => post('/api/passkey/opties', {}));
    r = await X.p.evaluate(async (o) => post('/api/passkey/bevestig', { antwoord: await bewijs(o) }), opt.j.opties);
    r = await vraag('POST', '/app/apparaat/intrekken', { id: reg.apparaten[0].id }, { pot: X.jar });
    toets('5 intrekken met verse vingerafdruk -> 200, cookies gewist', r.status === 200 && X.jar.sessie === '' && X.jar.apparaat === '', JSON.stringify(r));
    toets('5 melding "ingetrokken" naar Telegram', /ingetrokken/.test(telegram[telegram.length - 1]));
    const oudApparaat = reg.apparaten[0].id + '.' + 'x';
    r = await X.p.evaluate(() => post('/api/passkey/opties', {}));
    toets('5 ingetrokken apparaat -> direct buiten (401)', r.status === 401);
    r = await vraag('POST', '/app/koppel/code', {}, { pot: pot() });
    toets('5 alles ingetrokken: coderoute blijft dicht', r.status === 403);
    fs.writeFileSync(path.join(DATA, 'koppel-heropend'), '');
    { const oud = (Date.now() - 25 * 3600 * 1000) / 1000; fs.utimesSync(path.join(DATA, 'koppel-heropend'), oud, oud); }
    await slaap(1100);
    r = await vraag('POST', '/app/koppel/code', {}, { pot: pot() });
    toets('5 koppel-heropend ouder dan 24 u -> dicht (403)', r.status === 403 && /dicht/.test(r.j.fout), JSON.stringify(r.j));
    fs.writeFileSync(path.join(DATA, 'koppel-heropend'), '');
    r = await vraag('POST', '/app/koppel/code', {}, { pot: pot() });
    toets('5 machinekamer heropent (koppel-heropend) -> code', r.status === 200, JSON.stringify(r.j));

    // ── 6. begrenzing, kapotte opslag en auditlog ──
    let n429 = 0, nOk = 0;
    for (let i = 0; i < 32; i++) { const x = await vraag('POST', '/app/passkey/opties', {}, { pot: pot() }); if (x.status === 429) n429++; else nOk++; }
    toets('6 ontgrendelen: 32 keer in een uur mag (grens 120)', n429 === 0, nOk + ' door, ' + n429 + ' geweigerd');
    r = await vraag('GET', '/app/status');
    toets('6 pod zet kop X-App-Pod (de Function eist hem)', r.status === 200);
    const echtReg = fs.readFileSync(path.join(DATA, 'apparaten.json'));
    fs.writeFileSync(path.join(DATA, 'apparaten.json'), '{kapot');
    r = await vraag('GET', '/app/status');
    toets('6 kapot register -> 503 (fail-closed, route gaat niet open)', r.status === 503 && /register/.test(r.j.fout), JSON.stringify(r));
    fs.writeFileSync(path.join(DATA, 'apparaten.json'), echtReg);
    const echtStaat = fs.readFileSync(path.join(DATA, 'staat.json'));
    fs.writeFileSync(path.join(DATA, 'staat.json'), 'xx');
    H.appStaat.koppel = null;
    const nTel = telegram.length;
    await slaap(1100);
    r = await vraag('POST', '/app/koppel/code', {}, { pot: pot() });
    toets('6 kapotte staat -> geen code (daggrens niet op nul)', r.status >= 500 && telegram.length === nTel, JSON.stringify(r));
    fs.writeFileSync(path.join(DATA, 'staat.json'), echtStaat);
    n429 = 0;
    for (let i = 0; i < 32; i++) { const x = await vraag('POST', '/app/koppel/opties', { code: '12345678' }, { pot: pot() }); if (x.status === 429 && /dit uur/.test(x.j.fout)) n429++; }
    toets('6 koppelgrens 30/uur slaat aan', n429 > 0, n429);
    const AV = path.join(DATA, 'audit-voor-auth.jsonl');
    const regelsVoor = fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8').split('\n').length;
    await slaap(60000 - (Date.now() % 60000) + 50);   // begin van een verse minuut
    const voorVoor = fs.readFileSync(AV, 'utf8').split('\n').length;
    for (let i = 0; i < 60; i++) await vraag('GET', '/app/status', undefined, { poort: 'z'.repeat(64) });
    const regelsNa = fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8').split('\n').length;
    const voorNa = fs.readFileSync(AV, 'utf8').split('\n').length;
    toets('6 vloed van weigeringen vóór Access: niets in audit.jsonl, hooguit 5 regels/min in audit-voor-auth (Fable #4)', regelsNa === regelsVoor && voorNa - voorVoor <= 5, (regelsNa - regelsVoor) + ' / ' + (voorNa - voorVoor));
    await slaap(60000 - (Date.now() % 60000) + 50);
    await vraag('GET', '/app/status', undefined, { poort: 'z'.repeat(64) });
    toets('6 overgeslagen weigeringen worden geteld', /"overgeslagen_voor_auth":\d+/.test(fs.readFileSync(AV, 'utf8')));
    const audit = fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8') + fs.readFileSync(AV, 'utf8');
    const geheimen = [POORT, code1, code2, X.jar.koppel].filter(Boolean).concat(telegram.map(codeUit).filter(Boolean));
    toets('6 auditlog: regels met route/status/reden', audit.split('\n').filter(Boolean).length > 40 && /"reden":"access: aud"/.test(audit) && /"reden":"andere browser"/.test(audit) && /gekoppeld/.test(audit));
    toets('6 auditlog bevat geen codes, geheimen of cookies', geheimen.every((g) => audit.indexOf(g) < 0) && !/[a-f0-9]{64}/.test(audit));
    toets('6 geen onverwachte fouten in logError', logs.filter((l) => !/app-telegram|app-register: Expected property|app: Unexpected token .x., "xx"/.test(l)).length === 0, logs.join(' | '));
    const info = H.appInfo();
    toets('6 appInfo voor /health', info.ingericht === true && info.passkey_bibliotheek === 'brug' && info.apparaten === 0, JSON.stringify(info));

    // ── 7. stap 0c: certs één keer tegelijk, klokafwijking in /health ──
    {
      H.appStaat.certs = null; H.appStaat.certsFout = 0; certsTeller = 0; certsVertraging = 300; klokScheef = 5 * 60 * 1000;
      const rs = await Promise.all(Array.from({ length: 8 }, () => vraag('GET', '/app/status')));
      certsVertraging = 0;
      toets('7 acht gelijktijdige verzoeken zonder certs: één ophaalpoging (Fable #5)', certsTeller === 1 && rs.every((x) => x.status === 200), certsTeller + ' / ' + rs.map((x) => x.status));
      let info = H.appInfo();
      toets('7 podklok 5 min mis -> waarschuwing in /health.app (Fable #12)', Math.abs(info.klok_afwijking_s - 300) <= 2 && /wijkt/.test(info.klok_waarschuwing || ''), JSON.stringify(info));
      H.appStaat.certs = null; klokScheef = 0;
      await vraag('GET', '/app/status');
      info = H.appInfo();
      toets('7 klok gelijk -> geen waarschuwing', Math.abs(info.klok_afwijking_s) <= 2 && info.klok_waarschuwing === null && info.omlijsting === true, JSON.stringify(info));
    }

    // ── 8. fase 2: tweede apparaat met goedkeuring vanaf de telefoon ──
    H.appStaat.koppel = null;
    for (const t of Object.keys(H.appStaat.tellers)) H.appStaat.tellers[t] = [];
    fs.writeFileSync(path.join(DATA, 'staat.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(DATA, 'koppel-heropend'), '');
    const P = await nieuweBrowser('internal');   // de telefoon
    r = await vraag('POST', '/app/koppel/code', {}, { pot: P.jar });
    const codeP = codeUit(telegram[telegram.length - 1]);
    let o = await P.p.evaluate((c) => post('/api/koppel/opties', { code: c }), codeP);
    let c2 = await P.p.evaluate((x) => maak(x), o.j.opties);
    r = await P.p.evaluate((c) => post('/api/koppel/registreer', { antwoord: c, naam: 'Pixel' }), c2);
    toets('8 telefoon gekoppeld (coderoute heropend)', r.status === 200 && !!P.jar.sessie, JSON.stringify(r));
    const pixelId = r.j.apparaat.id;
    const L = await nieuweBrowser('internal');   // de laptop
    const ua = { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Edg/141.0' };
    r = await vraag('GET', '/app/status', undefined, Object.assign({ pot: L.jar }, ua));
    toets('8 laptop: koppelen met code dicht, aanvraag mogelijk', r.j.koppelen_open === false && r.j.aanvraag_mogelijk === true && r.j.apparaat === null, JSON.stringify(r.j));
    r = await L.p.evaluate(() => post('/api/koppel/opties', {}));
    toets('8 laptop koppelen zonder goedkeuring -> lukt niet (403)', r.status === 403, JSON.stringify(r));
    const nTel8 = telegram.length;
    r = await vraag('POST', '/app/koppel/aanvraag', { naam: 'Laptop' }, Object.assign({ pot: L.jar }, ua));
    const aanvL = r.j.aanvraag;
    toets('8 koppelcookie van de aanvraag leeft 15 min (Fable wv56 #4)', r.ck && r.ck.koppel && r.ck.koppel.s === 900, JSON.stringify(r.ck));
    toets('8 aanvraag: 200, eigen id + controlecode, koppelcookie', r.status === 200 && /^[a-f0-9]{16}$/.test(aanvL.id) && aanvL.controle === aanvL.id.slice(0, 6).toUpperCase() && /^[a-f0-9]{64}$/.test(L.jar.koppel), JSON.stringify(r));
    toets('8 Telegram-melding bij de aanvraag (naam, systeem, controlecode)', telegram.length === nTel8 + 1 && telegram[telegram.length - 1].indexOf(aanvL.controle) > 0 && /Edge op Windows/.test(telegram[telegram.length - 1]), telegram[telegram.length - 1]);
    r = await L.p.evaluate(() => post('/api/koppel/opties', {}));
    toets('8 vóór goedkeuring: opties geweigerd (wacht op goedkeuring)', r.status === 403 && /goedkeuring/.test(r.j.fout), JSON.stringify(r));
    const M = await nieuweBrowser('internal');   // een vreemde browser, kort erna
    await slaap(1100);
    r = await vraag('POST', '/app/koppel/aanvraag', { naam: 'Werk-pc' }, { pot: M.jar });
    toets('8 tweede aanvraag kort erna van een andere browser -> 409 (één open aanvraag)', r.status === 409 && /loopt al/.test(r.j.fout), JSON.stringify(r));
    r = await vraag('POST', '/app/koppel/aanvraag', { naam: 'Laptop' }, Object.assign({ pot: L.jar }, ua));
    toets('8 dezelfde browser opnieuw: zelfde aanvraag, geen extra melding', r.status === 200 && r.j.aanvraag.id === aanvL.id && telegram.length === nTel8 + 1, JSON.stringify(r.j));
    r = await vraag('GET', '/app/apparaat/aanvraag', undefined, { pot: P.jar });
    toets('8 telefoon ziet precies de open aanvraag (naam, systeem, controle)', r.status === 200 && r.j.aanvraag && r.j.aanvraag.id === aanvL.id && r.j.aanvraag.naam === 'Laptop', JSON.stringify(r.j));
    r = await vraag('GET', '/app/apparaat/aanvraag', undefined, { pot: L.jar });
    toets('8 laptop zelf kan de aanvragenlijst niet lezen (geen sessie) -> 401', r.status === 401);
    await slaap(4200);   // vingerafdruk ouder dan de (verkorte) 2 min
    r = await vraag('POST', '/app/koppel/goedkeur', { aanvraag_id: aanvL.id }, { pot: P.jar });
    toets('8 goedkeuren met een oude vingerafdruk -> 403', r.status === 403 && /opnieuw/.test(r.j.fout), JSON.stringify(r.j));
    o = await P.p.evaluate(() => post('/api/passkey/opties', {}));
    r = await P.p.evaluate(async (x) => post('/api/passkey/bevestig', { antwoord: await bewijs(x) }), o.j.opties);
    r = await vraag('POST', '/app/koppel/goedkeur', { aanvraag_id: 'f'.repeat(16) }, { pot: P.jar });
    toets('8 goedkeuren met een ander aanvraag-id -> 409', r.status === 409, JSON.stringify(r.j));
    {
      // goedkeurrecht komt uit het register (goedkeurder:true), niet uit 'reist'
      const regT = JSON.parse(fs.readFileSync(path.join(DATA, 'apparaten.json'), 'utf8'));
      toets('8 telefoon (coderoute) is goedkeurder; het vorige (ingetrokken) apparaat niet meer', regT.apparaten.find((x) => x.id === pixelId).goedkeurder === true && regT.apparaten.filter((x) => x.goedkeurder).length === 1, JSON.stringify(regT.apparaten.map((x) => [x.id, x.goedkeurder])));
      regT.apparaten.find((x) => x.id === pixelId).goedkeurder = false;
      fs.writeFileSync(path.join(DATA, 'apparaten.json'), JSON.stringify(regT));
      r = await vraag('POST', '/app/koppel/goedkeur', { aanvraag_id: aanvL.id }, { pot: P.jar });
      toets('8 goedkeuren zonder goedkeurder:true (ook reist + vers) -> 403', r.status === 403 && /Telegram-code/.test(r.j.fout), JSON.stringify(r.j));
      regT.apparaten.find((x) => x.id === pixelId).goedkeurder = true;
      fs.writeFileSync(path.join(DATA, 'apparaten.json'), JSON.stringify(regT));
    }
    r = await vraag('POST', '/app/koppel/goedkeur', { aanvraag_id: aanvL.id }, { pot: P.jar, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0' });
    toets('8 rem: Pixel-cookie + verse sessie maar user-agent Windows -> 403', r.status === 403 && /Pixel/.test(r.j.fout), JSON.stringify(r.j));
    {
      const sP = Object.values(H.appStaat.sessies).find((x) => x.apparaat === pixelId);
      const echt = sP.credential; sP.credential = 'ander-credential';
      r = await vraag('POST', '/app/koppel/goedkeur', { aanvraag_id: aanvL.id }, { pot: P.jar });
      toets('8 sessie niet geopend met de passkey van dit apparaat -> 403', r.status === 403 && sP.credential === 'ander-credential', JSON.stringify(r.j));
      sP.credential = echt;
      toets('8 sessie onthoudt de credential-id van de Pixel', !!echt && echt === JSON.parse(fs.readFileSync(path.join(DATA, 'apparaten.json'), 'utf8')).apparaten.find((x) => x.id === pixelId).credential.id);
    }
    r = await vraag('POST', '/app/koppel/goedkeur', { aanvraag_id: aanvL.id }, { pot: P.jar });
    toets('8 goedkeuren met verse vingerafdruk en het getoonde id -> 200', r.status === 200 && r.j.aanvraag.status === 'goedgekeurd', JSON.stringify(r.j));
    r = await M.p.evaluate(() => post('/api/koppel/opties', {}));
    toets('8 de goedkeuring geldt niet voor de andere browser -> 403', r.status === 403, JSON.stringify(r));
    r = await vraag('GET', '/app/koppel/stand', undefined, { pot: L.jar });
    toets('8 laptop ziet "goedgekeurd" (stand)', r.j.aanvraag && r.j.aanvraag.status === 'goedgekeurd', JSON.stringify(r.j));
    o = await L.p.evaluate(() => post('/api/koppel/opties', {}));
    c2 = await L.p.evaluate((x) => maak(x), o.j.opties);
    r = await L.p.evaluate((c) => post('/api/koppel/registreer', { antwoord: c, naam: 'iets anders' }), c2);
    toets('8 laptop koppelt na goedkeuring -> 200, naam uit de aanvraag', r.status === 200 && r.j.apparaat.naam === 'Laptop' && !!L.jar.sessie && !!L.jar.apparaat, JSON.stringify(r));
    const laptopId = r.j.apparaat.id;
    toets('8 Telegram: gekoppeld, goedgekeurd vanaf de telefoon', /gekoppeld.*goedgekeurd vanaf "Pixel"/.test(telegram[telegram.length - 1]), telegram[telegram.length - 1]);
    {
      const regT = JSON.parse(fs.readFileSync(path.join(DATA, 'apparaten.json'), 'utf8'));
      const lap = regT.apparaten.find((x) => x.id === laptopId);
      toets('8 register: gekoppeld_via goedkeuring, goedgekeurd_door = telefoon', lap.gekoppeld_via === 'goedkeuring' && lap.goedgekeurd_door === pixelId && lap.soort === 'reist', JSON.stringify(lap).slice(0, 300));
      toets('8 goedgekeurd apparaat is nooit goedkeurder', lap.goedkeurder === false && r.j.apparaat.goedkeurder === false, JSON.stringify(lap).slice(0, 300));
    }
    r = await vraag('GET', '/app/apparaten', undefined, { pot: L.jar });
    toets('8 laptop werkt (apparatenlijst)', r.status === 200 && r.j.apparaten.filter((x) => x.actief).length === 2);
    // twee aanvragen na elkaar: de eerste afgewezen, dan een tweede; goedkeuren met het oude id raakt niets
    const L2 = await nieuweBrowser('internal');
    await slaap(1100);
    r = await vraag('POST', '/app/koppel/aanvraag', { naam: 'Tablet' }, { pot: L2.jar });
    const a1 = r.j.aanvraag;
    r = await vraag('POST', '/app/koppel/afwijs', { aanvraag_id: a1.id }, { pot: P.jar });
    toets('8 afwijzen -> 200', r.status === 200 && r.j.aanvraag.status === 'afgewezen', JSON.stringify(r.j));
    await slaap(1100);
    r = await vraag('POST', '/app/koppel/aanvraag', { naam: 'Werk-pc' }, { pot: M.jar });
    const a2 = r.j.aanvraag;
    toets('8 na afwijzen: nieuwe aanvraag met een nieuw id', r.status === 200 && a2.id !== a1.id, JSON.stringify(r.j));
    o = await P.p.evaluate(() => post('/api/passkey/opties', {}));
    await P.p.evaluate(async (x) => post('/api/passkey/bevestig', { antwoord: await bewijs(x) }), o.j.opties);
    r = await vraag('POST', '/app/koppel/goedkeur', { aanvraag_id: a1.id }, { pot: P.jar });
    toets('8 goedkeuren met het id van de afgewezen aanvraag -> 409 (raakt de nieuwe niet)', r.status === 409 && H.appStaat.aanvraag.status === 'open', JSON.stringify(r.j));
    r = await L2.p.evaluate(() => post('/api/koppel/opties', {}));
    toets('8 afgewezen browser kan niet koppelen', r.status === 403);
    await slaap(4200);
    r = await vraag('POST', '/app/koppel/goedkeur', { aanvraag_id: a2.id }, { pot: L.jar });
    toets('8 laptop (reist, maar vingerafdruk niet vers) kan niet goedkeuren', r.status === 403, JSON.stringify(r.j));
    {
      // laptop met verse vingerafdruk (eigen passkey): mag niet goedkeuren, ook niet met de goede user-agent
      o = await L.p.evaluate(() => post('/api/passkey/opties', {}));
      r = await L.p.evaluate(async (x) => post('/api/passkey/bevestig', { antwoord: await bewijs(x) }), o.j.opties);
      r = await vraag('POST', '/app/koppel/goedkeur', { aanvraag_id: a2.id }, { pot: L.jar, ua: 'Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/141.0' });
      toets('8 laptop met verse vingerafdruk (en Android-UA) -> 403 geen goedkeurder', r.status === 403 && /Telegram-code/.test(r.j.fout), JSON.stringify(r.j));
      // 1Password-sync nagebootst: de Pixel-passkey staat ook in de authenticator van de laptop
      const { credentials } = await P.cdp.send('WebAuthn.getCredentials', { authenticatorId: P.authenticatorId });
      for (const cr of credentials) await L.cdp.send('WebAuthn.addCredential', { authenticatorId: L.authenticatorId, credential: cr });
      const regT = JSON.parse(fs.readFileSync(path.join(DATA, 'apparaten.json'), 'utf8'));
      const pixCred = regT.apparaten.find((x) => x.id === pixelId).credential;
      o = await L.p.evaluate(() => post('/api/passkey/opties', {}));
      const metPixel = await L.p.evaluate((x) => bewijs(Object.assign({}, x.o, { allowCredentials: [{ id: x.id, type: 'public-key' }] })).then((b) => b, (e) => 'fout ' + e.name), { o: o.j.opties, id: pixCred.id });
      toets('8 (sync) laptop kan de Pixel-passkey gebruiken', metPixel && metPixel.id === pixCred.id, JSON.stringify(metPixel).slice(0, 120));
      r = await L.p.evaluate((x) => post('/api/passkey/bevestig', { antwoord: x }), metPixel);
      toets('8 gesynchroniseerde Pixel-passkey vanaf de laptop (laptopcookie) -> 401, geen Pixel-sessie', r.status === 401 && /hoort niet bij dit apparaat/.test(r.j.fout), JSON.stringify(r.j));
      r = await vraag('POST', '/app/passkey/opties', {}, { pot: { apparaat: pixelId + '.' + '0'.repeat(64) } });
      toets('8 als Pixel opgeven zonder het Pixel-cookiegeheim -> 401', r.status === 401);
    }
    r = await vraag('POST', '/app/koppel/afwijs', { aanvraag_id: a2.id }, { pot: P.jar });
    // ingetrokken laptop -> direct buiten
    o = await P.p.evaluate(() => post('/api/passkey/opties', {}));
    await P.p.evaluate(async (x) => post('/api/passkey/bevestig', { antwoord: await bewijs(x) }), o.j.opties);
    r = await vraag('POST', '/app/apparaat/intrekken', { id: laptopId }, { pot: P.jar });
    toets('8 telefoon trekt laptop in (vers) -> 200', r.status === 200, JSON.stringify(r.j));
    r = await vraag('GET', '/app/apparaten', undefined, { pot: L.jar });
    const r2b = await L.p.evaluate(() => post('/api/passkey/opties', {}));
    toets('8 ingetrokken laptop -> direct buiten (401/401)', r.status === 401 && r2b.status === 401, r.status + '/' + r2b.status);
    // gesynchroniseerde passkey in een vreemde browser zonder apparaatcookie = nieuw apparaat
    r = await vraag('GET', '/app/status', undefined, { pot: pot() });
    toets('8 browser zonder apparaatcookie: geen apparaat, alleen een aanvraag mogelijk', r.j.apparaat === null && r.j.aanvraag_mogelijk === true && r.j.koppelen_open === false, JSON.stringify(r.j));

    // ── 9. fase 3: gesprek ──
    const bid = () => crypto.randomUUID();
    const gesprekVoor = gestart.length;
    r = await vraag('POST', '/app/beurt', { beurt_id: bid(), kanaal: 'hoofd', tekst: 'hoi' }, { pot: pot() });
    toets('9 beurt zonder sessie -> 401', r.status === 401);
    const sP = H.appStaat.sessies[crypto.createHash('sha256').update(P.jar.sessie).digest('hex')];
    let tot0 = sP.tot = Date.now() + 60000;
    const b1 = bid();
    r = await vraag('POST', '/app/beurt', { beurt_id: b1, kanaal: 'hoofd', tekst: 'Wat staat er morgen?' }, { pot: P.jar });
    const j1 = r.j.job_id;
    await slaap(30);
    const g1 = gestart[gestart.length - 1];
    toets('9 beurt hoofd -> job, prompt "[APP] …", chat 40687, vault', r.status === 200 && /^[a-f0-9]{16}$/.test(j1) && g1 && g1.jobId === j1 && g1.prompt === '[APP] Wat staat er morgen?' && g1.chatId === '40687' && g1.ws === 'vault', JSON.stringify(r.j) + JSON.stringify(g1));
    toets('9 beurt verlengt de sessie (glijdt)', sP.tot > tot0, sP.tot - tot0);
    tot0 = sP.tot = Date.now() + 60000;
    r = await vraag('POST', '/app/beurt', { beurt_id: bid(), kanaal: 'hoofd', tekst: '' }, { pot: P.jar });
    await slaap(20);
    toets('9 ongeldige beurt (400) verlengt de sessie niet (Fable wv56 #8)', r.status === 400 && sP.tot === tot0, sP.tot - tot0);
    r = await vraag('POST', '/app/beurt', { beurt_id: b1, kanaal: 'hoofd', tekst: 'Wat staat er morgen?' }, { pot: P.jar });
    await slaap(30);
    toets('9 dezelfde beurt_id nog eens -> zelfde job, geen tweede beurt', r.status === 200 && r.j.job_id === j1 && r.j.al === true && gestart.length === gesprekVoor + 1, JSON.stringify(r.j));
    r = await vraag('POST', '/app/beurt', { beurt_id: bid(), kanaal: 'hoofd', tekst: 'nog iets' }, { pot: P.jar });
    toets('9 tweede beurt in hetzelfde kanaal terwijl Socev bezig is -> 409', r.status === 409 && /bezig/.test(r.j.fout), JSON.stringify(r.j));
    tot0 = sP.tot = Date.now() + 60000;
    const auditRegels = () => fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8').split('\n').filter((l) => /app\/uitslag/.test(l)).length;
    const nAudit = auditRegels();
    r = await vraag('POST', '/app/uitslag', { job_id: j1 }, { pot: P.jar });
    await slaap(20);
    toets('9 poll "niet klaar" geeft geen auditregel (Fable wv56 #7)', auditRegels() === nAudit, auditRegels() - nAudit);
    const rg = await vraag('GET', '/app/geschiedenis/hoofd', undefined, { pot: P.jar });
    await vraag('GET', '/app/status', undefined, { pot: P.jar });
    toets('9 uitslag tijdens de beurt: niet klaar', r.status === 200 && r.j.gevonden === true && r.j.klaar === false && r.j.status === 'running', JSON.stringify(r.j));
    toets('9 geschiedenis toont de lopende beurt', rg.status === 200 && rg.j.lopend.length === 1 && rg.j.lopend[0].job_id === j1 && rg.j.lopend[0].tekst === 'Wat staat er morgen?', JSON.stringify(rg.j));
    toets('9 uitslag/geschiedenis/status verlengen de sessie niet (Fable #1)', sP.tot === tot0, sP.tot - tot0);
    // machinekamer mag tegelijk (andere sessie), met de omlijsting
    const bm = bid();
    r = await vraag('POST', '/app/beurt', { beurt_id: bm, kanaal: 'machinekamer', tekst: 'stand?' }, { pot: P.jar });
    const jm = r.j.job_id;
    await slaap(30);
    const gm = gestart[gestart.length - 1];
    toets('9 machinekamer: telegram-debug, omlijsting letterlijk + "\\n[APP] "', r.status === 200 && gm.jobId === jm && gm.chatId === 'telegram-debug' && gm.prompt === OMLIJST.replace(/\s+$/, '') + '\n[APP] stand?' && /^\[MACHINEKAMER\]/.test(gm.prompt), JSON.stringify(gm).slice(0, 200));
    // Telegram en app tegelijk in hetzelfde gesprek -> na elkaar
    let tgKlaar;
    enqueue('40687', () => new Promise((res2) => { tgKlaar = res2; }));   // een "Telegram-beurt" die achter j1 aansluit
    const VRAAG = 'Zal ik de afspraak met de accountant verzetten naar vrijdag?';
    afmaken[j1]('Morgen staat er niets bijzonders.\n\nVRAAG AAN DAVID: ' + VRAAG);
    await slaap(80);
    const nB = gestart.length;
    r = await vraag('POST', '/app/beurt', { beurt_id: bid(), kanaal: 'hoofd', tekst: 'na telegram' }, { pot: P.jar });
    const jna = r.j.job_id;
    await slaap(50);
    toets('9 app-beurt terwijl een Telegram-beurt loopt: aangenomen maar wacht (zelfde wachtrij)', r.status === 200 && gestart.length === nB && H.appInfo().beurten_lopend >= 1, gestart.length - nB);
    tgKlaar();
    await slaap(50);
    toets('9 ... en start pas als de Telegram-beurt klaar is', gestart.length === nB + 1 && gestart[gestart.length - 1].jobId === jna);
    afmaken[jna]('ok');
    afmaken[jm]('machinekamer: alles groen');
    await slaap(80);
    toets('9 na het wegschrijven in de geschiedenis telt hij als opgehaald, nog vóór de app hem ophaalt (uitrol wacht niet op een dichte app)', !!jobs[j1].opgehaald);
    r = await vraag('POST', '/app/uitslag', { job_id: j1 }, { pot: P.jar });
    const fnv = (s) => { let h = 0x811c9dc5; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
    toets('9 uitslag klaar: antwoord + vraag met dezelfde hash als Telegram', r.j.klaar === true && /niets bijzonders/.test(r.j.antwoord) && r.j.vraag && r.j.vraag.tekst === VRAAG && r.j.vraag.hash === fnv(VRAAG) && r.j.vraag.beantwoord === null, JSON.stringify(r.j));
    const logH = fs.readFileSync(path.join(LOGDIR, 'hoofd.jsonl'), 'utf8');
    toets('9 app-log hoofd: tekst + antwoord, 0600', /Wat staat er morgen/.test(logH) && /niets bijzonders/.test(logH) && (fs.statSync(path.join(LOGDIR, 'hoofd.jsonl')).mode & 0o077) === 0);
    toets('9 app-log machinekamer apart', /alles groen/.test(fs.readFileSync(path.join(LOGDIR, 'machinekamer.jsonl'), 'utf8')) && !/alles groen/.test(logH));
    // knoppen
    const hashV = fnv(VRAAG);
    tot0 = sP.tot = Date.now() + 60000;
    r = await vraag('POST', '/app/knop', { job_id: j1, vraag_hash: hashV, keuze: 'anders' }, { pot: P.jar });
    toets('9 Anders zonder toelichting -> 400', r.status === 400);
    r = await vraag('POST', '/app/knop', { job_id: j1, vraag_hash: 'deadbeef', keuze: 'ja' }, { pot: P.jar });
    toets('9 knop op een onbekende vraag -> 404', r.status === 404);
    r = await vraag('POST', '/app/knop', { job_id: j1, vraag_hash: hashV, keuze: 'ja' }, { pot: P.jar });
    const jk = r.j.job_id;
    await slaap(30);
    const gk = gestart[gestart.length - 1];
    toets('9 JA-knop -> [KNOP]-beurt met de Telegram-tekst', r.status === 200 && gk.jobId === jk && gk.prompt.indexOf('[APP] [KNOP] David drukte JA op de vraag: ' + JSON.stringify(VRAAG) + '\n(Knopdruk in de app (het hoofdkanaal) om ') === 0 && /kanaal "app-knop", en handel af\.\)$/.test(gk.prompt) && gk.prompt.indexOf('vraag-id ' + hashV) > 0, gk.prompt);
    toets('9 knop verlengt de sessie', sP.tot > tot0);
    // tweede druk vanaf een ander apparaat: eerst de laptop opnieuw koppelen kan niet meer (ingetrokken); M koppelt als derde apparaat
    await slaap(1100);
    r = await vraag('POST', '/app/koppel/aanvraag', { naam: 'Werk-pc' }, { pot: M.jar });
    o = await P.p.evaluate(() => post('/api/passkey/opties', {}));
    await P.p.evaluate(async (x) => post('/api/passkey/bevestig', { antwoord: await bewijs(x) }), o.j.opties);
    await vraag('POST', '/app/koppel/goedkeur', { aanvraag_id: r.j.aanvraag.id }, { pot: P.jar });
    o = await M.p.evaluate(() => post('/api/koppel/opties', {}));
    c2 = await M.p.evaluate((x) => maak(x), o.j.opties);
    r = await M.p.evaluate((c) => post('/api/koppel/registreer', { antwoord: c }), c2);
    toets('9 (tweede apparaat gekoppeld voor de knoptoets)', r.status === 200, JSON.stringify(r));
    afmaken[jk]('Genoteerd.');
    await slaap(60);
    r = await vraag('POST', '/app/knop', { job_id: j1, vraag_hash: hashV, keuze: 'nee' }, { pot: M.jar });
    toets('9 tweede druk vanaf een ander apparaat -> 409 "al beantwoord: Ja HH:MM"', r.status === 409 && /^al beantwoord: Ja \d\d:\d\d$/.test(r.j.fout), JSON.stringify(r.j));
    r = await vraag('POST', '/app/uitslag', { job_id: j1 }, { pot: M.jar });
    toets('9 uitslag toont de vraag als beantwoord (ja)', r.j.vraag && r.j.vraag.beantwoord && r.j.vraag.beantwoord.keuze === 'ja', JSON.stringify(r.j.vraag));
    r = await vraag('GET', '/app/geschiedenis/hoofd', undefined, { pot: M.jar });
    const it = r.j.items || [];
    toets('9 geschiedenis: bericht, antwoord, knopbeurt; vraag beantwoord', r.status === 200 && it.length >= 3 && it.some((x) => x.job_id === j1 && x.vraag && x.vraag.beantwoord && x.vraag.beantwoord.keuze === 'ja') && it.some((x) => x.soort === 'knop' && /^✓ Ja — op de vraag: /.test(x.tekst)), JSON.stringify(it).slice(0, 400));
    r = await vraag('GET', '/app/geschiedenis/elders', undefined, { pot: M.jar });
    toets('9 geschiedenis onbekend kanaal -> 400', r.status === 400);
    // vreemde job / verdwenen job
    jobs['0123456789abcdef'] = { status: 'done', result: { ok: true, output: 'geheim van /run' } };
    r = await vraag('POST', '/app/uitslag', { job_id: '0123456789abcdef' }, { pot: M.jar });
    toets('9 uitslag van een niet-app-job -> gevonden:false (geen inhoud)', r.j.gevonden === false && JSON.stringify(r.j).indexOf('geheim') < 0, JSON.stringify(r.j));
    r = await vraag('POST', '/app/uitslag', { job_id: 'fedcba9876543210' }, { pot: M.jar });
    toets('9 uitslag na een uitrol (job weg) -> gevonden:false', r.j.gevonden === false);
    // invoerfouten en grenzen
    r = await vraag('POST', '/app/beurt', { beurt_id: bid(), kanaal: 'hoofd', tekst: '   ' }, { pot: M.jar });
    const rb = await vraag('POST', '/app/beurt', { beurt_id: bid(), kanaal: 'hoofd', tekst: 'x', bestanden: [{ name: 'a.txt' }] }, { pot: M.jar });
    const rk = await vraag('POST', '/app/beurt', { beurt_id: bid(), kanaal: '40687', tekst: 'x' }, { pot: M.jar });
    const ri = await vraag('POST', '/app/beurt', { kanaal: 'hoofd', tekst: 'x' }, { pot: M.jar });
    toets('9 leeg / bestanden / onbekend kanaal / zonder beurt_id -> 400', r.status === 400 && rb.status === 400 && /bestandenportaal/.test(rb.j.fout) && rk.status === 400 && ri.status === 400, [r.status, rb.status, rk.status, ri.status].join(','));
    rolStub.primair = false;
    r = await vraag('POST', '/app/beurt', { beurt_id: bid(), kanaal: 'hoofd', tekst: 'x' }, { pot: M.jar });
    rolStub.primair = true;
    toets('9 pod passief (uitwijk) -> 409, geen beurt', r.status === 409 && /reservekant/.test(r.j.fout));
    fs.renameSync(path.join(DATA, 'machinekamer-omlijsting.txt'), path.join(DATA, 'omlijsting.weg'));
    r = await vraag('POST', '/app/beurt', { beurt_id: bid(), kanaal: 'machinekamer', tekst: 'x' }, { pot: M.jar });
    fs.renameSync(path.join(DATA, 'omlijsting.weg'), path.join(DATA, 'machinekamer-omlijsting.txt'));
    toets('9 omlijsting ontbreekt -> machinekamer 503 (nooit zonder omlijsting)', r.status === 503 && /omlijsting/.test(r.j.fout), JSON.stringify(r.j));
    // app-log onschrijfbaar: beurt werkt door, niets crasht
    fs.chmodSync(path.join(LOGDIR, 'hoofd.jsonl'), 0o400); fs.chmodSync(LOGDIR, 0o500);
    r = await vraag('POST', '/app/beurt', { beurt_id: bid(), kanaal: 'hoofd', tekst: 'log dicht' }, { pot: M.jar });
    const jl = r.j.job_id;
    await slaap(30);
    afmaken[jl]('antwoord bij dicht log');
    await slaap(80);
    const rgl = await vraag('GET', '/app/geschiedenis/hoofd', undefined, { pot: M.jar });
    toets('9 app-log onschrijfbaar en app dicht: geschiedenis geeft het antwoord uit het geheugen, nog niet opgehaald (Fable wv56 #2)', (rgl.j.items || []).some((x) => x.job_id === jl && x.antwoord === 'antwoord bij dicht log') && !jobs[jl].opgehaald, JSON.stringify((rgl.j.items || []).slice(-1)));
    const ru = await vraag('POST', '/app/uitslag', { job_id: jl }, { pot: M.jar });
    fs.chmodSync(LOGDIR, 0o700); fs.chmodSync(path.join(LOGDIR, 'hoofd.jsonl'), 0o600);
    toets('9 app-log onschrijfbaar -> beurt en uitslag werken door (fail-open)', r.status === 200 && ru.j.klaar === true && ru.j.antwoord === 'antwoord bij dicht log' && logs.some((l) => /^app-log/.test(l)), JSON.stringify(ru.j) + logs.slice(-2));
    toets('9 ... en de opgehaalde uitslag telt dan als opgehaald', !!jobs[jl].opgehaald);
    // mislukte beurt
    r = await vraag('POST', '/app/beurt', { beurt_id: bid(), kanaal: 'hoofd', tekst: 'faal' }, { pot: M.jar });
    await slaap(30);
    afmaken[r.j.job_id]('kapot', false);
    await slaap(60);
    r = await vraag('POST', '/app/uitslag', { job_id: r.j.job_id }, { pot: M.jar });
    toets('9 mislukte beurt: gelukt false met foutregel', r.j.klaar === true && r.j.gelukt === false && r.j.fout === 'kapot', JSON.stringify(r.j));
    // begrenzing 30 per uur
    H.appStaat.tellers.beurt = Array.from({ length: 30 }, () => Date.now());
    r = await vraag('POST', '/app/beurt', { beurt_id: bid(), kanaal: 'hoofd', tekst: 'x' }, { pot: M.jar });
    toets('9 31e beurt in een uur -> 429', r.status === 429);
    H.appStaat.tellers.beurt = [];
    // na een herstart: beurt_id van schijf
    H.appStaat.beurtIds = null;
    r = await vraag('POST', '/app/beurt', { beurt_id: b1, kanaal: 'hoofd', tekst: 'Wat staat er morgen?' }, { pot: M.jar });
    toets('9 beurt_id overleeft een herstart (beurten.json) -> geen tweede beurt', r.j.al === true && r.j.job_id === j1, JSON.stringify(r.j));
    const auditAlles = fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8');
    toets('9 auditlog: beurt/knop/goedkeur-regels zonder berichtinhoud', /"reden":"beurt hoofd [a-f0-9]{16}"/.test(auditAlles) && /"reden":"knop ja/.test(auditAlles) && /goedgekeurd [A-F0-9]{6}/.test(auditAlles) && auditAlles.indexOf('morgen') < 0 && auditAlles.indexOf('accountant') < 0);
    toets('9 geen onverwachte fouten in logError', logs.filter((l) => !/app-telegram|app-register: Expected property|app: Unexpected token .x., "xx"|^app-log:/.test(l)).length === 0, logs.join(' | '));
    for (const k of Object.keys(afmaken)) if (jobs[k] && jobs[k].status !== 'done') afmaken[k]('opgeruimd');

    // ── 9b. Broedstoof (wv92, bouwplan § 4.13) ──
    {
      const sB = H.appStaat.sessies[crypto.createHash('sha256').update(P.jar.sessie).digest('hex')];
      sB.tot = Date.now() + 10 * 60000;
      r = await vraag('GET', '/app/broedstoof', undefined, { pot: pot() });
      toets('9b broedstoof zonder apparaat/sessie -> 401', r.status === 401, r.status);
      // verwachte percentages, onafhankelijk uit de bus gelezen (kolom %)
      const busTekst = fs.readFileSync(BUS, 'utf8').split('\n');
      const kopI = busTekst.findIndex((l) => /^\| # \| Idee \| Genre \| % \| Kort \| Stand \|/.test(l));
      const verwacht = {};
      for (let k = kopI + 2; k < busTekst.length && busTekst[k].startsWith('|'); k++) { const m = /^\| (\d+) \| .*? \| .*? \| (\d+) \| /.exec(busTekst[k]); if (m) verwacht[m[1]] = Number(m[2]); }
      toets('9b toets-vooraf: bus heeft kolom % met 10 ideeën', kopI > 0 && Object.keys(verwacht).length === 10, JSON.stringify(verwacht));
      Object.assign(agentsReg, {
        aaaaaaaaaaaaaaa1: { job_id: 'aaaaaaaaaaaaaaa1', label: 'machinekamer:wv92 app layout + broedstoof-tab', status: 'running', started: Date.now() - 60000 },
        aaaaaaaaaaaaaaa2: { job_id: 'aaaaaaaaaaaaaaa2', label: 'machinekamer: idee 7 schaduwmeting', status: 'running', started: Date.now() - 1000 },
        aaaaaaaaaaaaaaa3: { job_id: 'aaaaaaaaaaaaaaa3', label: 'machinekamer:wv13 genoom', status: 'done', started: Date.now() - 999999 },
        aaaaaaaaaaaaaaa4: { job_id: 'aaaaaaaaaaaaaaa4', label: 'socev: idee 70 iets', status: 'running', started: Date.now() } });
      sbStaat.items = [
        { id: 92, idee: 9, label: 'machinekamer:app layout + broedstoof-tab', status: 'gestart', job_id: 'aaaaaaaaaaaaaaa1', gestart_op: new Date().toISOString(), wacht_op: [] },
        { id: 98, idee: 9, label: 'machinekamer:socev-app fase 5a', status: 'open', wacht_op: ['item:92'], wacht_op_item: true, wacht_op_job: [] },
        { id: 13, idee: 2, label: 'machinekamer:genoom', status: 'gestart', job_id: 'aaaaaaaaaaaaaaa3', wacht_op: [] },
        { id: 85, idee: 9, label: 'machinekamer:toets', status: 'geblokkeerd', geblokkeerd_door: 'David: app-toets', wacht_op: [] }];
      const nAuditVoor = fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8').split('\n').length;
      r = await vraag('GET', '/app/broedstoof', undefined, { pot: P.jar });
      const per = {}; (r.j.ideeen || []).forEach((i) => { per[i.nr] = i; });
      toets('9b broedstoof 200 met alle ideeën van de bus', r.status === 200 && Object.keys(per).length === 10, JSON.stringify(r.j).slice(0, 300));
      toets('9b percentages gelijk aan kolom % van de bus (alle 10), bron kolom', Object.keys(verwacht).every((n) => per[n] && per[n].pct === verwacht[n] && per[n].pct_bron === 'kolom'), JSON.stringify(Object.values(per).map((i) => [i.nr, i.pct, i.pct_bron])));
      toets('9b titel en kort plat (geen ** of [[ ]])', per[9] && /Socev-app/.test(per[9].titel) && per[2] && !/\*\*|\[\[/.test(per[2].titel) && per[9].kort && per[9].kort.length <= 240, JSON.stringify(per[2]) + JSON.stringify(per[9]));
      toets('9b idee 9: agent bezig (werkvoorraadrij + lopende job), 1 in de rij, 1 wacht op David', per[9].bezig.length === 1 && per[9].bezig[0].label === 'app layout + broedstoof-tab' && per[9].bezig[0].wv === 92 && per[9].in_rij === 1 && per[9].startklaar === 0 && per[9].wacht_op_david === 1, JSON.stringify(per[9]));
      toets('9b idee 7: agent buiten de werkvoorraad via label "idee 7"', per[7].bezig.length === 1 && per[7].bezig[0].wv === null && /schaduwmeting/.test(per[7].bezig[0].label), JSON.stringify(per[7]));
      toets('9b idee 2: gestarte rij met afgeronde job telt niet als bezig; "idee 70" telt niet voor 7', per[2].bezig.length === 0 && per[7].bezig.length === 1, JSON.stringify(per[2]));
      toets('9b tikkerstand meegegeven (alleen doorwerk, dagmaximum)', r.j.tikker && r.j.tikker.alleen_doorwerk === true && r.j.tikker.starts_vandaag === 42 && /dagmaximum/.test(r.j.tikker.reden), JSON.stringify(r.j.tikker));
      // startklaar zoals de claim: item-voorganger klaar = startklaar; job-voorganger nog lopend = niet
      sbStaat.items.push({ id: 200, idee: 6, label: 'machinekamer:a', status: 'open', wacht_op: ['item:1'], wacht_op_item: false, wacht_op_job: [] },
        { id: 201, idee: 6, label: 'machinekamer:b', status: 'open', wacht_op: ['aaaaaaaaaaaaaaa1'], wacht_op_item: false, wacht_op_job: ['aaaaaaaaaaaaaaa1'] },
        { id: 202, idee: 1, label: 'machinekamer:c', status: 'starten', bijgewerkt: new Date(Date.now() - 20 * 60000).toISOString(), wacht_op: [] });
      const r6 = await vraag('GET', '/app/broedstoof', undefined, { pot: P.jar });
      const i6 = r6.j.ideeen.find((i) => i.nr === 6), i1 = r6.j.ideeen.find((i) => i.nr === 1);
      toets('9b startklaar: klare item-voorganger telt, lopende job-voorganger niet', i6.in_rij === 2 && i6.startklaar === 1, JSON.stringify(i6));
      toets('9b "starten" ouder dan 15 min telt niet als bezig', i1.bezig.length === 0, JSON.stringify(i1));
      sbStaat.items.splice(-3, 3);
      toets('9b ruimte meegegeven, geen prompts in het antwoord', r.j.ruimte && r.j.ruimte.mag === true && !/"prompt"\s*:/.test(JSON.stringify(r.j)));
      toets('9b databank met service-sleutel aangeroepen (mk_broedstoof)', sbRpc.some((x) => x.fn === 'mk_broedstoof' && x.sleutel === 'nep-sleutel'));
      await slaap(30);
      const nAuditNa = fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8').split('\n').length;
      toets('9b GET broedstoof (200) schrijft geen auditregel (stil)', nAuditNa === nAuditVoor, nAuditNa - nAuditVoor);
      // voorrang
      const tot1 = sB.tot = Date.now() + 60000;
      const nRpc = sbRpc.length;
      r = await vraag('POST', '/app/broedstoof/voorrang', { idee: 9, actie: 'eerder' }, { pot: P.jar });
      const rpcV = sbRpc.slice(nRpc).find((x) => x.fn === 'mk_idee_voorrang');
      toets('9b voorrang eerder idee 9 -> 200, voorrang 1, gewijzigd', r.status === 200 && r.j.voorrang === 1 && r.j.gewijzigd === true, JSON.stringify(r.j));
      toets('9b RPC krijgt idee, actie, apparaatnaam en apparaat-id', rpcV && rpcV.b.p_idee === 9 && rpcV.b.p_actie === 'eerder' && rpcV.b.p_door === 'app: Pixel' && /^[a-f0-9]{8,}$/.test(String(rpcV.b.p_apparaat)), JSON.stringify(rpcV));
      await slaap(30);
      toets('9b voorrang verlengt de sessie (schrijvend)', sB.tot > tot1, sB.tot - tot1);
      r = await vraag('GET', '/app/broedstoof', undefined, { pot: P.jar });
      toets('9b daarna toont de broedstoof voorrang 1 bij idee 9', (r.j.ideeen || []).find((i) => i.nr === 9).voorrang === 1);
      r = await vraag('POST', '/app/broedstoof/voorrang', { idee: 5, actie: 'eerder' }, { pot: P.jar });
      toets('9b tweede idee eerder -> voorrang 2 (laatst verhoogd bovenaan)', r.status === 200 && r.j.voorrang === 2, JSON.stringify(r.j));
      r = await vraag('POST', '/app/broedstoof/voorrang', { idee: 5, actie: 'normaal' }, { pot: P.jar });
      toets('9b normaal -> 0', r.status === 200 && r.j.voorrang === 0, JSON.stringify(r.j));
      const nRpc2 = sbRpc.length;
      for (const [body, st, naam] of [[{ idee: 0, actie: 'eerder' }, 400, 'idee 0'], [{ idee: 9, actie: 'omhoog' }, 400, 'onbekende actie'], [{ idee: '9', actie: 'eerder' }, 400, 'idee als tekst'],
                                      [{ idee: 55, actie: 'eerder' }, 404, 'idee niet op de bus']]) {
        r = await vraag('POST', '/app/broedstoof/voorrang', body, { pot: P.jar });
        toets('9b voorrang ' + naam + ' -> ' + st, r.status === st, r.status + ' ' + JSON.stringify(r.j));
      }
      toets('9b ongeldige verzoeken raken de databank niet', sbRpc.slice(nRpc2).every((x) => x.fn !== 'mk_idee_voorrang'));
      r = await vraag('POST', '/app/broedstoof/voorrang', { idee: 9, actie: 'eerder' }, { pot: pot() });
      toets('9b voorrang zonder sessie -> 401', r.status === 401);
      rolStub.primair = false;
      r = await vraag('POST', '/app/broedstoof/voorrang', { idee: 9, actie: 'eerder' }, { pot: P.jar });
      toets('9b voorrang op de passieve kant -> 409', r.status === 409, r.status);
      rolStub.primair = true;
      sbStaat.kapot = true;
      r = await vraag('POST', '/app/broedstoof/voorrang', { idee: 9, actie: 'normaal' }, { pot: P.jar });
      toets('9b databank kapot bij voorrang -> 502 met nette tekst', r.status === 502 && /opslaan lukte niet/.test(r.j.fout), JSON.stringify(r.j));
      r = await vraag('GET', '/app/broedstoof', undefined, { pot: P.jar });
      toets('9b databank kapot bij lezen -> 200 met de bus en een foutregel', r.status === 200 && r.j.ideeen.length === 10 && /niet leesbaar/.test(r.j.fout) && r.j.ideeen.every((i) => i.bezig.length === 0 || i.nr === 7), JSON.stringify(r.j).slice(0, 200));
      sbStaat.kapot = false;
      H.appStaat.tellers.voorrang = Array.from({ length: 30 }, () => Date.now());
      r = await vraag('POST', '/app/broedstoof/voorrang', { idee: 9, actie: 'normaal' }, { pot: P.jar });
      toets('9b 31e voorrang in een uur -> 429', r.status === 429);
      H.appStaat.tellers.voorrang = [];
      // tabelvarianten: '|' in een wikilink-alias, % met sterretjes en ±, geen %-kolom -> standtekst, >100 ongeldig
      const BUS2 = path.join(W, 'bus2.md');
      fs.writeFileSync(BUS2, 'tekst\n\n| # | Idee | Genre | % | Kort | Stand |\n|---|---|---|---|---|---|\n' +
        '| 3 | Titel met [[a/b|alias]] | g | **± 12%** | kort [[x/y|z]] en `a|b` | stand ± 99% |\n' +
        '| 4 | Vier | g |  | k | eerst ± 44% dan ± 50% |\n| 5 | Vijf | g | 140 | k | geen getal |\n\nna de tabel | 6 | x |\n');
      ctx.process.env.APP_BUS_PAD = BUS2;
      r = await vraag('GET', '/app/broedstoof', undefined, { pot: P.jar });
      const p2 = {}; (r.j.ideeen || []).forEach((i) => { p2[i.nr] = i; });
      toets('9b tabel: | in wikilink en code verschuift niets; ** ± 12% -> 12', p2[3] && p2[3].pct === 12 && p2[3].titel === 'Titel met alias' && p2[3].kort === 'kort z en a|b', JSON.stringify(p2[3]));
      toets('9b tabel: lege % -> eerste ± NN% uit Stand, gemarkeerd', p2[4] && p2[4].pct === 44 && p2[4].pct_bron === 'standtekst', JSON.stringify(p2[4]));
      toets('9b tabel: % > 100 en geen standgetal -> geen balk (null), nooit geschat', p2[5] && p2[5].pct === null && p2[5].pct_bron === null && Object.keys(p2).length === 3, JSON.stringify(p2));
      r = await vraag('POST', '/app/broedstoof/voorrang', { idee: 9, actie: 'eerder' }, { pot: P.jar });
      toets('9b voorrang op een idee dat niet op (deze) bus staat -> 404', r.status === 404);
      ctx.process.env.APP_BUS_PAD = path.join(W, 'bestaat-niet.md');
      r = await vraag('GET', '/app/broedstoof', undefined, { pot: P.jar });
      toets('9b bus onleesbaar -> 503', r.status === 503, r.status);
      ctx.process.env.APP_BUS_PAD = BUS;
      const auditB = fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8');
      const nA0 = fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8').split('\n').length;
      H.appStaat.aanvraag = null;
      r = await vraag('GET', '/app/apparaat/aanvraag', undefined, { pot: P.jar });
      await slaap(30);
      toets('9b /apparaat/aanvraag zonder open aanvraag: 200 zonder auditregel (stil)', r.status === 200 && r.j.aanvraag === null && fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8').split('\n').length === nA0);
      toets('9b auditlog: voorrang-regels met idee, actie en van->naar', /"route":"\/app\/broedstoof\/voorrang".*"reden":"voorrang idee 9 eerder 0->1"/.test(auditB) && /"reden":"voorrang idee 5 normaal 2->0"/.test(auditB), auditB.split('\n').filter((l) => /broedstoof/.test(l)).slice(-3).join(' '));
      logs.splice(0, logs.length, ...logs.filter((l) => !/^app-broedstoof|^app-voorrang/.test(l)));
    }

    // ── 11. fase 5a: tabs Agents en Bestanden (wv98) ──
    {
      const sB = H.appStaat.sessies[crypto.createHash('sha256').update(P.jar.sessie).digest('hex')];
      sB.tot = Date.now() + 10 * 60000;
      for (const route of ['/app/agents', '/app/bestanden', '/app/agent/aaaaaaaaaaaaaab1', '/app/bestand/aaaaaaaaaaaaaab1/1']) {
        r = await vraag('GET', route, undefined, { pot: pot() });
        toets('11 ' + route + ' zonder apparaat/sessie -> 401', r.status === 401, r.status);
      }
      // agentregister: lopend (met werkvoorraadrij), wachtend, klaar, mislukt, afgebroken, socev-route
      for (const k of Object.keys(agentsReg)) delete agentsReg[k];
      const t0 = Date.now();
      Object.assign(agentsReg, {
        aaaaaaaaaaaaaab1: { job_id: 'aaaaaaaaaaaaaab1', label: 'machinekamer:wv98 socev-app fase 5a', status: 'running', started: t0 - 120000, rapport: '-' },
        aaaaaaaaaaaaaab2: { job_id: 'aaaaaaaaaaaaaab2', label: 'vakantie_Gambia-plannen', status: 'pending', started: t0 - 1000, rapport: '-' },
        aaaaaaaaaaaaaab3: { job_id: 'aaaaaaaaaaaaaab3', label: 'machinekamer:wv92 app layout', status: 'done', ok: true, started: t0 - 9e6, ended: t0 - 8e6, rapport: 'verzonden' },
        aaaaaaaaaaaaaab4: { job_id: 'aaaaaaaaaaaaaab4', label: 'david: reis uitzoeken', status: 'done', ok: false, started: t0 - 7e6, ended: t0 - 6e6, rapport: 'mislukt: 500' },
        aaaaaaaaaaaaaab5: { job_id: 'aaaaaaaaaaaaaab5', label: 'socev: mail nalopen', status: 'afgebroken-containerherstart', started: t0 - 5e6, ended: t0 - 4e6, rapport: '-' } });
      sbStaat.wvItems = [
        { id: 98, idee: 9, label: 'machinekamer:socev-app fase 5a agents + bestanden', job_id: 'aaaaaaaaaaaaaab1', status: 'gestart', samenvatting: 'In de app: tab met agents en bestanden', bron: 'GEHEIM-BRON', notitie: 'GEHEIME-NOTITIE', doorwerk_opdracht: '"GEHEIME-OPDRACHT"' },
        { id: 99, idee: 9, label: 'machinekamer:socev-app fase 5b multi-upload', status: 'open', wacht_op: ['item:98', 'aaaaaaaaaaaaaab1'], samenvatting: 'Meerdere bestanden tegelijk', doorwerk_opdracht: 'x', voorrang: 2 },
        { id: 101, label: 'machinekamer:stille uren', status: 'open', niet_voor: new Date(t0 + 3600000).toISOString(), wacht_op: [], samenvatting: null },
        { id: 85, label: 'machinekamer:f23-productietoets', status: 'geblokkeerd', geblokkeerd_door: 'David: laptop koppelen en eerste toets', samenvatting: 'Productietoets met jou' },
        { id: 70, label: 'machinekamer:x', status: 'geblokkeerd', geblokkeerd_door: 'wv3 meting', samenvatting: 'niet voor David' } ];
      H.appStaat.wvCache = null;
      const nA0 = fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8').split('\n').length;
      r = await vraag('GET', '/app/agents', undefined, { pot: P.jar });
      const ag = r.j;
      const per = {}; [...(ag.lopend || []), ...(ag.recent || [])].forEach((x) => { per[x.job_id] = x; });
      toets('11 agents 200: 2 lopend (oudste eerst), 3 recent (jongste eerst)', r.status === 200 && ag.lopend.length === 2 && ag.lopend[0].job_id === 'aaaaaaaaaaaaaab1' && ag.recent.length === 3 && ag.recent[0].job_id === 'aaaaaaaaaaaaaab5', JSON.stringify(ag).slice(0, 400));
      toets('11 label in gewone taal: samenvatting van de werkvoorraadrij, anders zonder prefix/wv/streepjes', per.aaaaaaaaaaaaaab1.label === 'In de app: tab met agents en bestanden' && per.aaaaaaaaaaaaaab1.wv === 98
        && per.aaaaaaaaaaaaaab2.label === 'vakantie Gambia plannen' && per.aaaaaaaaaaaaaab3.label === 'app layout' && per.aaaaaaaaaaaaaab4.label === 'reis uitzoeken', JSON.stringify(per));
      toets('11 status: loopt, wacht, klaar, mislukt, afgebroken; route machinekamer/socev/david', per.aaaaaaaaaaaaaab1.status === 'loopt' && per.aaaaaaaaaaaaaab2.status === 'wacht' && per.aaaaaaaaaaaaaab3.status === 'klaar'
        && per.aaaaaaaaaaaaaab4.status === 'mislukt' && per.aaaaaaaaaaaaaab5.status === 'afgebroken' && per.aaaaaaaaaaaaaab1.route === 'machinekamer' && per.aaaaaaaaaaaaaab2.route === 'socev' && per.aaaaaaaaaaaaaab4.route === 'david', JSON.stringify(per));
      toets('11 rapport bezorgd: ja / nee / onbekend', per.aaaaaaaaaaaaaab3.rapport_bezorgd === 'ja' && per.aaaaaaaaaaaaaab4.rapport_bezorgd === 'nee' && per.aaaaaaaaaaaaaab5.rapport_bezorgd === null);
      toets('11 rij: alleen open rijen in volgorde, met niet-vóór, na wv98/lopende agent, doorwerk en voorrang', ag.rij.length === 2 && ag.rij[0].wv === 99 && ag.rij[0].na.join() === 'wv98,een lopende agent' && ag.rij[0].doorwerk && ag.rij[0].voorrang
        && ag.rij[1].wv === 101 && !!ag.rij[1].niet_voor && ag.rij[1].label === 'stille uren', JSON.stringify(ag.rij));
      toets('11 wacht op David: alleen de David-blokkade, zonder "David:"', ag.wacht_op_david.length === 1 && ag.wacht_op_david[0].wv === 85 && ag.wacht_op_david[0].wat === 'laptop koppelen en eerste toets', JSON.stringify(ag.wacht_op_david));
      toets('11 geen bron, notitie of doorwerk-opdracht in het antwoord', !/GEHEIM/.test(JSON.stringify(ag)));
      await slaap(30);
      toets('11 GET agents (200) schrijft geen auditregel (stil)', fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8').split('\n').length === nA0);
      // bewaren: map met twee keer image.jpg (in een submap), een symlink naar buiten, een te groot bestand
      const OUT = path.join(W, 'io-b1', 'out');
      fs.mkdirSync(path.join(OUT, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(OUT, 'image.jpg'), 'beeld-1');
      fs.writeFileSync(path.join(OUT, 'sub', 'image.jpg'), 'beeld-2');
      fs.writeFileSync(path.join(OUT, 'Rapport wv98.docx'), Buffer.from([0, 1, 2, 250, 251]));
      fs.symlinkSync('/etc/hostname', path.join(OUT, 'koppeling.txt'));
      const groot = fs.openSync(path.join(OUT, 'groot.bin'), 'w'); fs.ftruncateSync(groot, 21 * 1024 * 1024); fs.closeSync(groot);
      const m1 = H.appBewaar('aaaaaaaaaaaaaab1', OUT, { soort: 'agent', label: 'machinekamer:wv98 socev-app fase 5a', ok: true, rapport: '# Eindrapport\\n\\nAlles **groen**.' });
      const namen = m1 ? m1.bestanden.map((b) => b.naam).sort().join('|') : '';
      toets('11 bewaren: 3 bestanden, dubbele naam uniek, symlink en > 20 MB niet', !!m1 && namen === 'Rapport wv98.docx|image (2).jpg|image.jpg' && m1.overgeslagen === 1 && m1.rapport === true, JSON.stringify(m1));
      toets('11 bewaren: bestanden verplaatst (niet meer in out/), symlink-doel ongemoeid', !fs.existsSync(path.join(OUT, 'image.jpg')) && !fs.existsSync(path.join(OUT, 'Rapport wv98.docx')) && fs.existsSync('/etc/hostname'));
      const dag = new Date().toISOString().slice(0, 10);
      const jd = path.join(BEWAAR, dag, 'aaaaaaaaaaaaaab1');
      toets('11 bewaren: map 0700, bestanden 0600 als b/<n>, geen oorspronkelijke namen op schijf', (fs.statSync(jd).mode & 0o777) === 0o700 && (fs.statSync(path.join(jd, 'b', '1')).mode & 0o777) === 0o600
        && fs.readdirSync(path.join(jd, 'b')).sort().join() === '1,2,3', fs.readdirSync(path.join(jd, 'b')).join());
      // agent zonder rapport (route socev) en een beurt met één bestand
      fs.mkdirSync(path.join(W, 'io-b2', 'out'), { recursive: true });
      fs.writeFileSync(path.join(W, 'io-b2', 'out', 'plan.md'), '# plan');
      H.appBewaar('aaaaaaaaaaaaaab2', path.join(W, 'io-b2', 'out'), { soort: 'agent', label: 'vakantie', ok: true, rapport: null });
      fs.mkdirSync(path.join(W, 'io-c1', 'out'), { recursive: true });
      fs.writeFileSync(path.join(W, 'io-c1', 'out', 'brief.pdf'), '%PDF-1.4 proef');
      H.appBewaar('ccccccccccccccc1', path.join(W, 'io-c1', 'out'), { soort: 'beurt', kanaal: 'hoofd', app: true });
      toets('11 niets te bewaren (geen bestanden, geen rapport) -> geen map', H.appBewaar('ccccccccccccccc2', path.join(W, 'bestaat-niet'), { soort: 'beurt', kanaal: 'hoofd' }) === null && !fs.existsSync(path.join(BEWAAR, dag, 'ccccccccccccccc2')));
      toets('11 ongeldig job-id -> niets', H.appBewaar('../../x', OUT, { soort: 'beurt', rapport: 'x' }) === null);
      r = await vraag('GET', '/app/bestanden', undefined, { pot: P.jar });
      const bi = {}; (r.j.items || []).forEach((x) => { bi[x.job_id] = x; });
      toets('11 bestanden 200: 3 klussen, beurt met kanaal hoofd, agent met gewone-taallabel, 30 dagen', r.status === 200 && r.j.items.length === 3 && bi.ccccccccccccccc1.soort === 'beurt' && bi.ccccccccccccccc1.kanaal === 'hoofd' && bi.ccccccccccccccc1.app === true
        && bi.aaaaaaaaaaaaaab1.label === 'In de app: tab met agents en bestanden' && bi.aaaaaaaaaaaaaab1.overgeslagen === 1 && r.j.bewaar_dagen === 30, JSON.stringify(r.j).slice(0, 400));
      const nr = bi.aaaaaaaaaaaaaab1.bestanden.find((b) => b.naam === 'Rapport wv98.docx').n;
      const nA1 = fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8').split('\n').length;
      r = await vraag('GET', '/app/bestand/aaaaaaaaaaaaaab1/' + nr, undefined, { pot: P.jar });
      toets('11 download: inhoud bytegelijk (base64), naam, Word-type', r.status === 200 && Buffer.from(r.j.inhoud, 'base64').equals(Buffer.from([0, 1, 2, 250, 251])) && r.j.naam === 'Rapport wv98.docx' && /wordprocessingml/.test(r.j.type), JSON.stringify(r.j).slice(0, 200));
      await slaap(30);
      const auditD = fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8');
      toets('11 download staat in het auditlog (job/n, geen naam of inhoud)', auditD.split('\n').length > nA1 && new RegExp('"reden":"bestand aaaaaaaaaaaaaab1/' + nr + '"').test(auditD) && !/Rapport wv98/.test(auditD));
      r = await vraag('GET', '/app/bestand/aaaaaaaaaaaaaab1/9', undefined, { pot: P.jar });
      toets('11 onbekend bestandsnummer -> 404', r.status === 404);
      for (const pad of ['/app/bestand/aaaaaaaaaaaaaab1/../../geheim', '/app/bestand/aaaaaaaaaaaaaab1', '/app/bestand/AAAAAAAAAAAAAAB1/1', '/app/bestand/' + dag + '/aaaaaaaaaaaaaab1']) {
        r = await vraag('GET', pad, undefined, { pot: P.jar });
        toets('11 rare paden -> 404: ' + pad, r.status === 404, r.status);
      }
      r = await vraag('GET', '/app/agent/aaaaaaaaaaaaaab1', undefined, { pot: P.jar });
      toets('11 rapport machinekamer-agent: tekst', r.status === 200 && /Alles \*\*groen\*\*/.test(r.j.tekst) && r.j.gelukt === true, JSON.stringify(r.j).slice(0, 200));
      r = await vraag('GET', '/app/agent/aaaaaaaaaaaaaab2', undefined, { pot: P.jar });
      toets('11 agent zonder bewaard rapport -> 404 met uitleg', r.status === 404 && /geen rapport/.test(r.j.fout));
      H.appStaat.wvCache = null;
      r = await vraag('GET', '/app/agents', undefined, { pot: P.jar });
      const pa = {}; [...r.j.lopend, ...r.j.recent].forEach((x) => { pa[x.job_id] = x; });
      toets('11 agents: rapport-vlag en aantal bestanden uit wat bewaard is', pa.aaaaaaaaaaaaaab1.rapport === true && pa.aaaaaaaaaaaaaab1.bestanden === 3 && pa.aaaaaaaaaaaaaab2.rapport === false && pa.aaaaaaaaaaaaaab2.bestanden === 1);
      // grens downloads per uur
      H.appStaat.tellers.bestand = Array.from({ length: 120 }, () => Date.now());
      r = await vraag('GET', '/app/bestand/aaaaaaaaaaaaaab1/1', undefined, { pot: P.jar });
      toets('11 121e download in een uur -> 429', r.status === 429);
      H.appStaat.tellers.bestand = [];
      // 30 dagen: 31 dagen oud weg, 29 dagen oud blijft; totaal geteld
      const oudDag = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10), jongDag = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
      for (const [d, id, t] of [[oudDag, 'ddddddddddddddd1', Date.now() - 31 * 86400000], [jongDag, 'ddddddddddddddd2', Date.now() - 29 * 86400000]]) {
        fs.mkdirSync(path.join(BEWAAR, d, id, 'b'), { recursive: true });
        fs.writeFileSync(path.join(BEWAAR, d, id, 'b', '1'), 'x');
        fs.writeFileSync(path.join(BEWAAR, d, id, 'meta.json'), JSON.stringify({ job_id: id, soort: 'beurt', kanaal: 'machinekamer', op: new Date(t).toISOString(), bestanden: [{ n: 1, naam: 'x.txt', grootte: 1 }] }));
      }
      fs.mkdirSync(path.join(BEWAAR, oudDag, 'zonder-meta'), { recursive: true });
      const op = H.appBestandenOpruim();
      toets('11 opruimen: > 30 dagen weg (ook zonder meta), < 30 dagen blijft, lege dagmap weg', !fs.existsSync(path.join(BEWAAR, oudDag)) && fs.existsSync(path.join(BEWAAR, jongDag, 'ddddddddddddddd2', 'b', '1')) && op.weg === 2, JSON.stringify(op));
      toets('11 opruimen telt het totaal (bytes)', op.totaal === 7 + 7 + 5 + 6 + 14 + 1, op.totaal);
      r = await vraag('GET', '/app/bestanden', undefined, { pot: P.jar });
      toets('11 bestanden: nu 4 klussen (jongste eerst)', r.j.items.length === 4 && r.j.items[r.j.items.length - 1].job_id === 'ddddddddddddddd2', r.j.items.map((x) => x.job_id).join());
      // vol: boven de totaalgrens geen nieuwe bestanden, rapport wel
      H.appStaat.bestandenTotaal = 3 * 1024 * 1024 * 1024;
      fs.mkdirSync(path.join(W, 'io-e1', 'out'), { recursive: true });
      fs.writeFileSync(path.join(W, 'io-e1', 'out', 'a.txt'), 'a');
      const mv = H.appBewaar('eeeeeeeeeeeeeee1', path.join(W, 'io-e1', 'out'), { soort: 'agent', label: 'machinekamer: vol', ok: true, rapport: 'rapport bij volle schijf' });
      toets('11 boven 2 GB: geen bestanden bewaard, wel het rapport, vol gemarkeerd', mv && mv.bestanden.length === 0 && mv.overgeslagen === 1 && mv.vol === true && mv.rapport === true, JSON.stringify(mv));
      H.appBestandenOpruim();
      // fail-open: bewaarmap onschrijfbaar -> null, geen uitzondering
      const echtDir = ctx.process.env.APP_BESTANDEN_DIR;
      const nLog = logs.length;
      fs.mkdirSync(path.join(W, 'io-f1', 'out'), { recursive: true });
      fs.writeFileSync(path.join(W, 'io-f1', 'out', 'f.txt'), 'f');
      fs.writeFileSync(path.join(W, 'geen-map'), '');
      let mf = 'x', gooide = false;
      // APP_BESTANDEN_DIR is een const: stel de dagmap onschrijfbaar door er een bestand neer te zetten
      fs.rmSync(path.join(BEWAAR, dag), { recursive: true, force: true }); fs.writeFileSync(path.join(BEWAAR, dag), 'bezet');
      try { mf = H.appBewaar('fffffffffffffff1', path.join(W, 'io-f1', 'out'), { soort: 'beurt', kanaal: 'hoofd' }); } catch (e) { gooide = true; }
      toets('11 schrijffout bij bewaren: null, gelogd, geen uitzondering (fail-open)', mf === null && !gooide && logs.slice(nLog).some((l) => /^app-bewaar/.test(l)), JSON.stringify(logs.slice(nLog)));
      fs.rmSync(path.join(BEWAAR, dag), { force: true });
      logs.splice(0, logs.length, ...logs.filter((l) => !/^app-bewaar/.test(l)));
      // werkvoorraad onbereikbaar: agents geeft toch 200 met fout-tekst
      sbStaat.kapot = true; H.appStaat.wvCache = null;
      r = await vraag('GET', '/app/agents', undefined, { pot: P.jar });
      toets('11 databank kapot: agents 200 met lopend + fout, rij leeg', r.status === 200 && r.j.lopend.length === 2 && r.j.rij.length === 0 && /werkvoorraad/.test(r.j.fout), JSON.stringify(r.j).slice(0, 200));
      sbStaat.kapot = false;
      logs.splice(0, logs.length, ...logs.filter((l) => !/^app-agents/.test(l)));
      // haakjes in de pod: processJob alleen hoofdkanaal/machinekamer en nooit 'lezen'; processAgent rapport alleen machinekamer/david
      const volSrc = fs.readFileSync('server.js', 'utf8');
      toets('11 processJob bewaart alleen 40687/telegram-debug, nooit lezen', /if \(gereedschap !== 'lezen' && APP_KANAAL_VAN_CHAT\[chatId\]\) appBewaar\(/.test(volSrc) && /APP_KANAAL_VAN_CHAT = \{ '40687': 'hoofd', 'telegram-debug': 'machinekamer' \}/.test(volSrc));
      toets('11 processAgent: rapport alleen bij route machinekamer of david', /rapport: \(route === 'machinekamer' \|\| route === 'david'\) \? appRapport : null/.test(volSrc));
      toets('11 appRoute: zonder prefix = socev', H.appRoute('vakantie') === 'socev' && H.appRoute(' Machinekamer: x') === 'machinekamer' && H.appRoute('david:x') === 'david');
      for (const k of Object.keys(agentsReg)) delete agentsReg[k];
    }

    // ── 10. noodstop en app-aan (7-10, Telegram /app-noodstop en /app-aan) ──
    {
      const regV = JSON.parse(fs.readFileSync(path.join(DATA, 'apparaten.json'), 'utf8'));
      const actiefV = regV.apparaten.filter((x) => x.actief).length;
      fs.writeFileSync(path.join(DATA, 'koppel-heropend'), '');
      await slaap(1100);
      await vraag('POST', '/app/koppel/aanvraag', { naam: 'Vreemd' }, { pot: pot() });
      toets('10 vooraf: actieve apparaten, sessies en een open aanvraag', actiefV >= 2 && Object.keys(H.appStaat.sessies).length >= 1 && !!H.appStaat.aanvraag, actiefV);
      const u = H.appNoodstop('toets');
      toets('10 noodstop: ok, app-uit, alle actieve ingetrokken, sessies/aanvraag weg, heropend weg', u.ok === true && u.app_uit && fs.existsSync(UIT) && u.ingetrokken.length === actiefV && u.sessies >= 1 && u.aanvraag === true && u.heropend_weg === true
        && Object.keys(H.appStaat.sessies).length === 0 && !H.appStaat.aanvraag && !H.appStaat.koppel && !fs.existsSync(path.join(DATA, 'koppel-heropend')), JSON.stringify(u));
      const regN = JSON.parse(fs.readFileSync(path.join(DATA, 'apparaten.json'), 'utf8'));
      toets('10 register: niemand actief, geen cookie-hash, ingetrokken_door noodstop', regN.apparaten.every((x) => !x.actief && !x.cookie_hash) && regN.apparaten.filter((x) => x.ingetrokken_door === 'noodstop').length === actiefV);
      r = await vraag('GET', '/app/status', undefined, { pot: P.jar });
      toets('10 na noodstop: app 503', r.status === 503, r.status);
      toets('10 tweede noodstop: niets meer in te trekken, wel ok', (() => { const u2 = H.appNoodstop('toets'); return u2.ok && u2.ingetrokken.length === 0 && u2.al_uit === regN.apparaten.length; })());
      const a = H.appAan('toets');
      toets('10 app-aan: app-uit weg, 0 actieve apparaten, coderoute dicht', a.ok && a.was_uit === true && !fs.existsSync(UIT) && a.actieve_apparaten === 0 && a.koppelen_open === false, JSON.stringify(a));
      r = await vraag('GET', '/app/status', undefined, { pot: P.jar });
      toets('10 na app-aan: Pixel is ontkoppeld (geen apparaat), geen aanvraag mogelijk', r.status === 200 && r.j.apparaat === null && r.j.aanvraag_mogelijk === false && r.j.koppelen_open === false, JSON.stringify(r.j));
      r = await P.p.evaluate(() => post('/api/passkey/opties', {}));
      toets('10 oude Pixel-cookie opent niets meer (401)', r.status === 401);
      // opnieuw koppelen via de coderoute: nieuw apparaat wordt de (enige) goedkeurder
      fs.writeFileSync(path.join(DATA, 'koppel-heropend'), '');
      H.appStaat.tellers.koppel = [];
      fs.writeFileSync(path.join(DATA, 'staat.json'), JSON.stringify({}));
      const Q = await nieuweBrowser('internal');
      r = await vraag('POST', '/app/koppel/code', {}, { pot: Q.jar });
      const cq = codeUit(telegram[telegram.length - 1]);
      o = await Q.p.evaluate((c) => post('/api/koppel/opties', { code: c }), cq);
      c2 = await Q.p.evaluate((x) => maak(x), o.j.opties);
      r = await Q.p.evaluate((c) => post('/api/koppel/registreer', { antwoord: c, naam: 'Pixel nieuw' }), c2);
      const regQ = JSON.parse(fs.readFileSync(path.join(DATA, 'apparaten.json'), 'utf8'));
      toets('10 na noodstop opnieuw koppelen via de code: nieuwe goedkeurder, de rest niet', r.status === 200 && regQ.apparaten.filter((x) => x.goedkeurder).length === 1 && regQ.apparaten.find((x) => x.goedkeurder).id === r.j.apparaat.id, JSON.stringify(r.j));
      toets('10 Telegram meldt dat alleen dit apparaat mag goedkeuren', /Alleen dit apparaat mag voortaan/.test(telegram[telegram.length - 1]), telegram[telegram.length - 1]);
      const qId = r.j.apparaat.id;
      // wachtende app-beurt vervalt bij de noodstop (Fable-review wv89 #3): een Telegram-beurt houdt de wachtrij bezet
      let losLaten; const bezet = new Promise((ok) => { losLaten = ok; });
      ctx.enqueue('40687', () => bezet);
      const nStart = gestart.length;
      r = await vraag('POST', '/app/beurt', { beurt_id: crypto.randomUUID(), kanaal: 'hoofd', tekst: 'na mij de noodstop' }, { pot: Q.jar });
      const jWacht = r.j.job_id;
      toets('10 app-beurt staat in de wachtrij (pending)', r.status === 200 && jobs[jWacht] && jobs[jWacht].status === 'pending', JSON.stringify(r.j));
      const un = H.appNoodstop('toets');
      toets('10 noodstop telt 1 vervallen beurt', un.beurten_vervallen === 1 && un.beurten_lopend === 0, JSON.stringify(un));
      H.appAan('toets');   // ook als de app meteen weer aan gaat: de beurt blijft vervallen
      losLaten(); await slaap(50);
      toets('10 vervallen beurt start niet en eindigt met "vervallen door de noodstop"', gestart.length === nStart && jobs[jWacht].status === 'done' && jobs[jWacht].result.ok === false && /noodstop/.test(jobs[jWacht].result.error) && jobs[jWacht].opgehaald === true, JSON.stringify(jobs[jWacht]));
      fs.writeFileSync(UIT, '');
      const sb = H.appStartBeurt({ id: qId }, 'hoofd', 'x', { soort: 'bericht', tekst: 'x' });
      toets('10 beurt die na de noodstop pas start -> fout noodstop', sb.fout === 'noodstop', JSON.stringify(sb));
      fs.unlinkSync(UIT);
      // coderoute vanaf een laptop: geen goedkeurder; de bestaande (Q) blijft
      fs.writeFileSync(path.join(DATA, 'koppel-heropend'), '');
      fs.writeFileSync(path.join(DATA, 'staat.json'), JSON.stringify({}));
      H.appStaat.tellers.koppel = [];
      const LW = await nieuweBrowser('internal', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0');
      r = await vraag('POST', '/app/koppel/code', {}, { pot: LW.jar });
      const cw = codeUit(telegram[telegram.length - 1]);
      o = await LW.p.evaluate((c) => post('/api/koppel/opties', { code: c }), cw);
      c2 = await LW.p.evaluate((x) => maak(x), o.j.opties);
      r = await LW.p.evaluate((c) => post('/api/koppel/registreer', { antwoord: c, naam: 'Laptop code' }), c2);
      const regW = JSON.parse(fs.readFileSync(path.join(DATA, 'apparaten.json'), 'utf8'));
      // (Q is door de noodstop hierboven ingetrokken, dus er is nu geen actieve goedkeurder)
      toets('10 laptop via de coderoute: gekoppeld maar geen goedkeurder, ook niet als er geen andere is', r.status === 200 && r.j.apparaat.goedkeurder === false && !regW.apparaten.some((x) => x.actief && x.goedkeurder), JSON.stringify(r.j));
      toets('10 Telegram: geen telefoon, dus geen goedkeurder; koppel je telefoon', /Geen telefoon, dus geen goedkeurder; koppel je telefoon/.test(telegram[telegram.length - 1]), telegram[telegram.length - 1]);
      r = await vraag('GET', '/app/status', undefined, { pot: LW.jar });
      toets('10 zonder actieve goedkeurder: geen aanvraag mogelijk', r.j.aanvraag_mogelijk === false && r.j.apparaat.goedkeurder === false, JSON.stringify(r.j));
      // kapot register: app-uit komt er toch, ok = false met de fout
      const echt = fs.readFileSync(path.join(DATA, 'apparaten.json'));
      fs.writeFileSync(path.join(DATA, 'apparaten.json'), '{kapot');
      const uk = H.appNoodstop('toets');
      toets('10 noodstop bij kapot register: app-uit staat, ok false met fout', uk.app_uit === true && fs.existsSync(UIT) && uk.ok === false && /register/.test(uk.fouten.join()), JSON.stringify(uk));
      fs.writeFileSync(path.join(DATA, 'apparaten.json'), echt);
      H.appAan('toets');
      const auditN = fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8');
      toets('10 auditlog: noodstop- en aan-regels', /"route":"noodstop"/.test(auditN) && /"route":"aan"/.test(auditN));
    }
  } catch (e) { toets('uitzondering: ' + (e && e.stack || e), false); }
  await browser.close();
  srv.close();
  console.log(fouten ? fouten + ' ROOD, ' + goed + ' GROEN' : 'TOETS GROEN (' + goed + ')');
  process.exit(fouten ? 1 : 0);
})();
JS
