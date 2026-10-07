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
async function nepFetch(url, opt) {
  url = String(url);
  const antw = (status, j) => ({ ok: status < 300, status, json: async () => j, text: async () => JSON.stringify(j) });
  if (url === TEAM + '/cdn-cgi/access/certs') return antw(200, { keys: [jwk] });
  if (url.startsWith('https://api.telegram.org/')) { telegram.push(JSON.parse(opt.body).text); return antw(200, { ok: true }); }
  return antw(404, {});
}
const logs = [];
const ctx = vm.createContext({ require, fs, path, crypto, Buffer, console, setInterval, setTimeout, clearTimeout, AbortSignal, Promise, JSON, Date,
  process: { env: { APP_DATA_DIR: DATA, APP_UIT_BESTAND: UIT, TELEGRAM_DEBUG_BOT_TOKEN: 'nep', APP_POORT_SECRET: POORT }, pid: process.pid },
  fetch: nepFetch, SP_CHAT: '40687', logError: (w, e) => logs.push(w + ': ' + (e && e.message || JSON.stringify(e))),
  reqPath: (req) => { const u = req.url || ''; const i = u.indexOf('?'); return i === -1 ? u : u.slice(0, i); } });
vm.runInContext(blok + '\n;globalThis.__h = { handleApp, appIsPad, appInfo, appStaat };', ctx, { filename: 'server.js#app' });
const H = ctx.__h;
const srv = http.createServer((q, s) => { if (H.appIsPad(q)) return H.handleApp(q, s); s.writeHead(418); s.end(); });

// ── de "Pages Function" van deze toets: cookiepot per browser, koppen erbij ──
function pot() { return { koppel: '', apparaat: '', sessie: '' }; }
function vraag(m, pad, body, o) {
  o = o || {};
  const koppen = { 'content-type': 'application/json', 'x-app-ua': o.ua || 'Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/141.0' };
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
  async function nieuweBrowser(transport) {
    const c = await browser.newContext();
    const p = await c.newPage();
    const jar = pot();
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
    for (let i = 0; i < 4; i++) r = await vraag('POST', '/app/koppel/opties', { code: code1 === '00000000' ? '11111111' : '00000000' }, { pot: A });
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
    r = await X.p.evaluate((c) => post('/api/koppel/registreer', { antwoord: Object.assign({}, c, { response: Object.assign({}, c.response, { transports: ['hybrid', 'internal'] }) }), naam: 'Pixel <script>' }), cred);
    toets('3 echte registratie (GPM-achtig: hybrid+internal, platform) -> 200, apparaat + sessie', r.status === 200 && r.j.apparaat && r.j.apparaat.naam === 'Pixel script' && /^[a-f0-9]{16}\.[a-f0-9]{64}$/.test(X.jar.apparaat) && /^[a-f0-9]{64}$/.test(X.jar.sessie) && X.jar.koppel === '', JSON.stringify(r) + JSON.stringify(X.jar));
    toets('3 melding "apparaat gekoppeld" naar Telegram', /apparaat gekoppeld/.test(telegram[telegram.length - 1]));
    const reg = JSON.parse(fs.readFileSync(path.join(DATA, 'apparaten.json'), 'utf8'));
    const regTekst = JSON.stringify(reg);
    toets('3 user-handle per apparaat willekeurig (niet de vaste naam)', opt.j.opties.user.id !== Buffer.from('socev-app-david').toString('base64url') && !(opt.j.opties.excludeCredentials || []).length);
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
    const nTel = telegram.length;
    await slaap(1100);
    r = await vraag('POST', '/app/koppel/code', {}, { pot: pot() });
    toets('6 kapotte staat -> geen code (daggrens niet op nul)', r.status >= 500 && telegram.length === nTel, JSON.stringify(r));
    fs.writeFileSync(path.join(DATA, 'staat.json'), echtStaat);
    n429 = 0;
    for (let i = 0; i < 32; i++) { const x = await vraag('POST', '/app/koppel/opties', { code: '12345678' }, { pot: pot() }); if (x.status === 429 && /dit uur/.test(x.j.fout)) n429++; }
    toets('6 koppelgrens 30/uur slaat aan', n429 > 0, n429);
    const regelsVoor = fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8').split('\n').length;
    for (let i = 0; i < 60; i++) await vraag('GET', '/app/status', undefined, { poort: 'z'.repeat(64) });
    const regelsNa = fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8').split('\n').length;
    toets('6 vloed van weigeringen vóór Access: hooguit 30 auditregels per minuut', regelsNa - regelsVoor <= 31, regelsNa - regelsVoor);
    await vraag('GET', '/app/status');
    toets('6 overgeslagen weigeringen worden geteld', /"overgeslagen_voor_auth":\d+/.test(fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8')));
    const audit = fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf8');
    const geheimen = [POORT, code1, code2, X.jar.koppel].filter(Boolean).concat(telegram.map(codeUit).filter(Boolean));
    toets('6 auditlog: regels met route/status/reden', audit.split('\n').filter(Boolean).length > 50 && /"reden":"access: aud"/.test(audit) && /"reden":"andere browser"/.test(audit) && /gekoppeld/.test(audit));
    toets('6 auditlog bevat geen codes, geheimen of cookies', geheimen.every((g) => audit.indexOf(g) < 0) && !/[a-f0-9]{64}/.test(audit));
    toets('6 geen onverwachte fouten in logError', logs.filter((l) => !/app-telegram|app-register: Expected property|app: Unexpected token .x., "xx"/.test(l)).length === 0, logs.join(' | '));
    const info = H.appInfo();
    toets('6 appInfo voor /health', info.ingericht === true && info.passkey_bibliotheek === 'brug' && info.apparaten === 0, JSON.stringify(info));
  } catch (e) { toets('uitzondering: ' + (e && e.stack || e), false); }
  await browser.close();
  srv.close();
  console.log(fouten ? fouten + ' ROOD, ' + goed + ' GROEN' : 'TOETS GROEN (' + goed + ')');
  process.exit(fouten ? 1 : 0);
})();
JS
