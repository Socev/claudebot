#!/usr/bin/env bash
# Toetst het sleutelportaal (server.js, 4-10-2026) zonder de pod te starten: het blok wordt uit server.js geknipt
# en in een vm-context achter een eigen http-server gedraaid. Supabase, n8n en Telegram zijn nagebootst, behalve met
# ECHT=1: dan gaan de kluis-RPC's naar de echte Supabase (wegwerpnaam proef_portaal_<tijd>; opruimen doet de
# aanroeper) en n8n alleen lezend. Telegram wordt nooit echt aangeroepen.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http'), os = require('os');
const crypto = require('crypto');
const src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf('// ── Sleutelportaal'), b = src.indexOf('// ── einde sleutelportaal');
if (a < 0 || b < 0) { console.log('ROOD: blok niet gevonden'); process.exit(1); }
const ECHT = process.env.ECHT === '1';
const HOST = 'claudebot.primumnonnocere.olares.com';
let fouten = 0, goed = 0;
function toets(naam, ok) { if (ok) goed++; else { fouten++; console.log('ROOD: ' + naam); } }

const werk = fs.mkdtempSync(path.join(os.tmpdir(), 'sptoets-'));
const sleutelPad = ECHT ? '/opt/data/.sleutelportaal/rpc.key' : path.join(werk, 'rpc.key');
if (!ECHT) fs.writeFileSync(sleutelPad, 'a'.repeat(64));
fs.mkdirSync(path.join(werk, 'vault/00_Systeem/Beveiliging'), { recursive: true });
fs.writeFileSync(path.join(werk, 'vault/00_Systeem/Beveiliging/Sleutelregister - portaalgegevens.json'), JSON.stringify({
  kluis: { proef_een: { waarvoor: 'proef <b>vet</b>', klasse: 'A', vervangen_voor: '2026-10-01', nazorg: 'nazorg-proef' } },
  n8n: { 'Anthropic account': { klasse: 'A', vervangen_voor: '2026-10-18' } },
  handmatig: [{ naam: 'chart', plek: 'helm', waarvoor: 'x', instructie: 'via machinekamer' }],
}));

// ── nagebootste buitenwereld ──
const telegram = [], rpcs = [], n8nAanroepen = [];
let telegramStuk = false;
const kluisNep = { proef_een: { waarde: 'oud-waarde-proef-een-12345678', vorige: null },
  proef_drie: { waarde: 'proef-drie-waarde-12345678', vorige: 'proef-drie-vorige-12345678', weg: true } };   // wv1786: weg = weg_kan
const kluisWeg = [];
const echteFetch = global.fetch;
async function nepFetch(url, opt) {
  url = String(url); opt = opt || {};
  const antw = (status, j) => ({ ok: status < 300, status, json: async () => j, text: async () => JSON.stringify(j) });
  if (url.startsWith('https://api.telegram.org/')) { if (telegramStuk) return antw(502, { ok: false }); telegram.push(JSON.parse(opt.body).text); return antw(200, { ok: true }); }
  if (url.includes('/rest/v1/rpc/')) {
    const fn = url.split('/rpc/')[1], body = JSON.parse(opt.body);
    rpcs.push({ fn, body });
    if (ECHT) return echteFetch(url, opt);
    if (body.p_sleutel !== 'a'.repeat(64)) return antw(200, { ok: false, reden: 'portaalsleutel ongeldig' });
    if (fn === 'sb_sleutelportaal_overzicht') return antw(200, { ok: true, sleutels: Object.keys(kluisNep).map(n => ({
      naam: n, omschrijving: '<script>alert(1)</script>', gewijzigd: '2026-08-16T10:00:00Z', witte_lijst: true,
      gemaskeerd: '••••' + kluisNep[n].waarde.slice(-4), vingerafdruk: 'abcdef', vorige_van: kluisNep[n].vorige ? '2026-10-04T10:00:00Z' : null, geweigerd: null,
      weg_kan: !!kluisNep[n].weg, vorige_weg_kan: !!kluisNep[n].vorige })), weg: kluisWeg.map(n => ({ naam: n, weg_op: '2026-10-28' })) });
    if (fn === 'sb_sleutelportaal_weg') {   // wv1786
      const vorige = /__vorige$/.test(body.p_naam), basis = body.p_naam.replace(/__vorige$/, ''), k = kluisNep[basis];
      if (!k || (vorige ? !k.vorige : !k.weg)) return antw(200, { ok: false, reden: 'nep: mag niet' });
      if (vorige) { k.vorige = null; kluisWeg.push('weg__20261028__' + body.p_naam); return antw(200, { ok: true, actie: 'weggegooid', nieuwe_naam: 'weg__20261028__' + body.p_naam, ook_vorige: false, definitief_na: '2026-11-12' }); }
      const ook = !!k.vorige; delete kluisNep[basis]; kluisWeg.push('weg__20261028__' + basis);
      return antw(200, { ok: true, actie: 'weggegooid', nieuwe_naam: 'weg__20261028__' + basis, ook_vorige: ook, definitief_na: '2026-11-12' });
    }
    if (fn === 'sb_sleutelportaal_schrijven') {
      const k = kluisNep[body.p_naam];
      if (body.p_nieuw) { if (k) return antw(200, { ok: false, reden: 'naam bestaat al' }); kluisNep[body.p_naam] = { waarde: body.p_waarde }; return antw(200, { ok: true, actie: 'aangemaakt' }); }
      if (!k) return antw(200, { ok: false, reden: 'naam bestaat niet' });
      k.vorige = k.waarde; k.waarde = body.p_waarde; return antw(200, { ok: true, actie: 'bijgewerkt', vorige_bewaard: true });
    }
    if (fn === 'sb_sleutelportaal_terugzetten') { const k = kluisNep[body.p_naam]; const t = k.waarde; k.waarde = k.vorige; k.vorige = t; return antw(200, { ok: true, actie: 'teruggezet' }); }
    if (fn === 'sb_sleutelportaal_auditlog') return antw(200, { ok: true, regels: [{ tijd: '2026-10-04T15:00:00Z', plek: 'kluis', naam: 'x', actie: 'bijwerken', uitkomst: 'opgeslagen' }] });
    if (fn === 'sb_sleutelportaal_log') return antw(200, { ok: true });
    return antw(404, {});
  }
  if (url.includes('/api/v1/')) {
    n8nAanroepen.push({ url, methode: opt.method, body: opt.body ? JSON.parse(opt.body) : null });
    if (ECHT && (opt.method || 'GET') === 'GET') return echteFetch(url, opt);
    if (url.includes('/credentials/schema/')) return antw(200, { properties: { apiKey: {}, url: {} } });
    if (url.includes('/credentials?')) return antw(200, { data: [
      { id: 'cred1', name: 'Anthropic account', type: 'anthropicApi', updatedAt: '2026-06-09T00:00:00Z' },
      { id: 'cred2', name: 'Gmail account', type: 'gmailOAuth2', updatedAt: '2026-10-04T00:00:00Z' }] });
    if (opt.method === 'PATCH') return antw(200, { id: 'cred1' });
    if (url.endsWith('/test')) return antw(200, { status: 'OK', message: 'Connection successful' });
    return antw(404, {});
  }
  throw new Error('onverwachte url in toets');
}

const env = Object.assign({}, process.env, ECHT ? {} : { SUPABASE_URL: 'https://nep.supabase.co', SUPABASE_SERVICE_ROLE: 'nep-service', N8N_API_KEY: 'nep-n8n', N8N_MCP_URL: 'https://nep-n8n.local/mcp-server/http' },
  { TELEGRAM_DEBUG_BOT_TOKEN: 'nep-bot', SLEUTELPORTAAL_SLEUTEL: sleutelPad });
const logregels = [];
const ctx = {
  fs, path, crypto, Buffer, console, setTimeout, JSON, Object, String, Number, Math, Date, Array, Promise, Set, RegExp, URLSearchParams, AbortSignal, encodeURIComponent,
  process: { env }, fetch: nepFetch, VAULT: path.join(werk, 'vault'),
  reqPath: function (req) { const u = req.url || ''; const i = u.indexOf('?'); return i === -1 ? u : u.slice(0, i); },
  logError: function (w, e) { logregels.push(w + ' ' + (e && e.name)); },
  require: function (m) { if (m !== './huisstijl-pod.js') throw new Error('onverwachte require ' + m); return require(path.resolve(m)); },   // wv1373
};
vm.createContext(ctx);
vm.runInContext(src.slice(a, b) + '\nthis.sleutelportaal = sleutelportaal; this.sleutelportaalIsPad = sleutelportaalIsPad; this.spStaat = spStaat; this.spSchoon = spSchoon;', ctx);

// wv1373 (Opus-review ZOU 1, KAN 6): zonder huisstijl-pod.js een leesbare noodstijl en een leeg icoon; module in de release
const ctxNood = vm.createContext(Object.assign({}, ctx, { require: function () { throw new Error('module weg (proef)'); }, logError: function () {} }));
vm.runInContext(src.slice(a, b) + '\nthis.spPagina = spPagina;', ctxNood);
const nood = ctxNood.spPagina('Proef', '<p>x</p>');
toets('zonder module: noodstijl op systeemkleuren + leeg icoon', /--sb-rand-veld:CanvasText/.test(nood) && nood.includes('href="data:,"') && !nood.includes('--sb-vlak: light-dark'));
toets('huisstijl-pod.js in RELEASE_OPTIONEEL en Dockerfile', /RELEASE_OPTIONEEL="[^"]*\bhuisstijl-pod\.js\b/.test(fs.readFileSync('uitrol.sh', 'utf8')) &&
  /COPY huisstijl-pod\.js \/app\/release-bootstrap\/huisstijl-pod\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
const H = require(path.resolve('huisstijl-pod.js'));
toets('module: CSS zonder </, url( of @import', !Object.values(H.BESTANDEN).some(c => /<\/|url\(|@import/i.test(c)) && /^data:image\/png;base64,/.test(H.POD_FAVICON));

const server = http.createServer(function (req, res) { if (ctx.sleutelportaalIsPad(req)) return ctx.sleutelportaal(req, res); res.writeHead(404); res.end(); });
server.listen(0, '127.0.0.1', async function () {
  const poort = server.address().port;
  function vraag(methode, pad, velden, koppen) {
    return new Promise(function (ok) {
      const body = velden ? new URLSearchParams(velden).toString() : '';
      const h = Object.assign({ host: HOST }, velden ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body), origin: 'https://' + HOST } : {}, koppen || {});
      for (const k in h) if (h[k] === null) delete h[k];
      const r = http.request({ host: '127.0.0.1', port: poort, method: methode, path: pad, headers: h }, function (res) {
        let t = ''; res.on('data', c => t += c); res.on('end', () => ok({ status: res.statusCode, koppen: res.headers, tekst: t }));
      });
      r.on('error', e => ok({ status: 0, tekst: String(e) }));
      r.end(body);
    });
  }
  try {
    let r = await vraag('GET', '/sleutels');
    toets('inlogpagina 200', r.status === 200 && r.tekst.includes('Stuur code'));
    toets('no-store', /no-store/.test(r.koppen['cache-control'] || ''));
    toets('CSP zonder script', /default-src 'none'/.test(r.koppen['content-security-policy'] || '') && !/<script/i.test(r.tekst));
    // wv1373 (Design Manager DS5/DS10): Socev-blauw inline + OVIS-favicon als data:-URI; de CSP staat alleen data:-beelden toe
    toets('huisstijl inline en body.sb', r.tekst.includes('--sb-vlak:') && r.tekst.includes('<body class="sb">') && !logregels.some(x => /huisstijl-pod/.test(x)));
    toets('favicon data:-URI', /<link rel="icon" type="image\/png" sizes="32x32" href="data:image\/png;base64,[A-Za-z0-9+\/=]+">/.test(r.tekst));
    toets('CSP img-src alleen data:', /(^|; )img-src data:(;|$)/.test(r.koppen['content-security-policy'] || '') && !/https?:/.test(r.koppen['content-security-policy'] || ''));
    toets('frame DENY', r.koppen['x-frame-options'] === 'DENY');
    toets('referrer same-origin', r.koppen['referrer-policy'] === 'same-origin');
    r = await vraag('GET', '/sleutels/iets'); toets('GET subpad 405', r.status === 405);
    r = await vraag('PUT', '/sleutels'); toets('PUT 405', r.status === 405);

    // Origin
    r = await vraag('POST', '/sleutels/code', {}, { origin: null }); toets('POST zonder Origin 403', r.status === 403);
    r = await vraag('POST', '/sleutels/code', {}, { origin: 'null' }); toets('Origin null 403', r.status === 403);
    r = await vraag('POST', '/sleutels/code', {}, { origin: 'https://evil.primumnonnocere.olares.com' }); toets('andere olares-origin 403', r.status === 403);
    r = await vraag('POST', '/sleutels/code', {}, { host: 'evil.example.com', origin: 'https://evil.example.com' }); toets('vreemde host 403', r.status === 403);
    r = await vraag('POST', '/sleutels/code', {}, { host: 'claudebot:8080', 'x-forwarded-host': HOST }); 
    toets('x-forwarded-host geaccepteerd', r.status === 200);
    toets('code naar Telegram', telegram.length === 1 && /code \d{8}/.test(telegram[0]));
    // ophalen code
    const code = (telegram[0].match(/code (\d{8})/) || [])[1];
    toets('code niet in de pagina', !r.tekst.includes(code));
    r = await vraag('POST', '/sleutels/code', {}); toets('tweede code binnen minuut 429', r.status === 429 && telegram.length === 1);
    r = await vraag('POST', '/sleutels/code', {}, { 'content-type': 'application/json' }); toets('json-body geweigerd', r.status === 400);
    r = await vraag('POST', '/sleutels/inloggen', { c: '00000000' === code ? '11111111' : '00000000' }); toets('foute code 403', r.status === 403 && /Nog 4/.test(r.tekst));
    r = await vraag('POST', '/sleutels/inloggen', { c: code });
    toets('goede code 303 + cookie', r.status === 303 && /__Host-sleutelportaal=[0-9a-f]{64}; Path=\/; Secure; HttpOnly; SameSite=Strict/.test(String(r.koppen['set-cookie'])));
    const cookie = String(r.koppen['set-cookie']).split(';')[0];
    r = await vraag('POST', '/sleutels/inloggen', { c: code }); toets('code eenmalig', r.status === 403);

    r = await vraag('GET', '/sleutels', null, { cookie: 'x=1; __Host-sleutelportaal=' + 'b'.repeat(64) }); toets('valse cookie = inlogpagina', r.tekst.includes('Stuur code'));
    r = await vraag('GET', '/sleutels', null, { cookie });
    toets('overzicht 200', r.status === 200 && r.tekst.includes('Supabase-kluis') && r.tekst.includes('n8n-credentials') && r.tekst.includes('Handmatig') && r.tekst.includes('Auditlog'));
    if (!ECHT) {
      toets('geen volle waarde in overzicht', !r.tekst.includes('oud-waarde-proef-een'));
      toets('maskering zichtbaar', r.tekst.includes('••••5678'));
      toets('XSS geëscaped', !r.tekst.includes('<script>alert') && !r.tekst.includes('<b>vet</b>'));
      toets('verlopen datum rood', r.tekst.includes('class="laat"'));
      toets('oauth = link naar n8n', r.tekst.includes('/home/credentials/cred2') && r.tekst.includes('in n8n zelf'));
    }
    toets('wachtwoordvelden new-password', /type="password" name="w\d+" autocomplete="new-password"/.test(r.tekst));
    const csrf = (r.tekst.match(/name="t" value="([0-9a-f]+)"/) || [])[1];
    const form = (r.tekst.match(/name="f" value="([0-9a-f]+)"/) || [])[1];
    const veldVan = (label) => { const m = r.tekst.match(new RegExp('name="(w\\d+)" autocomplete="new-password" spellcheck="false" aria-label="nieuwe waarde ' + label + '"')); return m && m[1]; };
    toets('csrf en formtoken', !!csrf && !!form);
    toets('standaardknop vooraan is opslaan', r.tekst.indexOf('tabindex="-1" aria-hidden="true">Alles opslaan') < r.tekst.indexOf('Vorige terugzetten') || !r.tekst.includes('Vorige terugzetten'));

    // opslaan zonder csrf / met fout csrf
    let x = await vraag('POST', '/sleutels/opslaan', { f: form }, { cookie }); toets('zonder csrf 403', x.status === 403);
    x = await vraag('POST', '/sleutels/opslaan', { t: csrf, f: form }, { cookie, origin: 'null' }); toets('origin null bij opslaan 403', x.status === 403);
    x = await vraag('POST', '/sleutels/opslaan', { t: csrf, f: form }); toets('zonder cookie 403', x.status === 403);
    // te groot
    x = await vraag('POST', '/sleutels/opslaan', { t: csrf, f: form, w1: 'x'.repeat(300 * 1024) }, { cookie }); toets('te grote body 400', x.status === 400);

    const NIEUW = ECHT ? 'proef_portaal_' + Date.now() : 'proef_twee';
    const W1 = 'Nieuwe-Proefwaarde-' + crypto.randomBytes(12).toString('hex');
    const W2 = 'Tweede-Proefwaarde-' + crypto.randomBytes(12).toString('hex');
    const nn = (r.tekst.match(/name="(w\d+)" placeholder="naam_van_sleutel"/) || [])[1];
    const nw = (r.tekst.match(/name="(w\d+)" autocomplete="new-password" spellcheck="false" placeholder="waarde"/) || [])[1];
    const velden = { t: csrf, f: form }; velden[nn] = NIEUW; velden[nw] = W1;
    const anth = veldVan('Anthropic account'); if (!ECHT && anth) velden[anth] = W2;
    if (!ECHT) { const pe = veldVan('proef_een'); velden[pe] = 'kort'; }
    x = await vraag('POST', '/sleutels/opslaan', velden, { cookie });
    toets('opslaan 200', x.status === 200 && x.tekst.includes('Uitkomst'));
    toets('nieuwe aangemaakt', new RegExp(NIEUW + '</td><td>kluis</td><td class="ok">aangemaakt').test(x.tekst));
    toets('waarden nooit terug in de pagina', !x.tekst.includes(W1) && !x.tekst.includes(W2) && !x.tekst.includes(W1.slice(5, 20)));
    toets('waarden niet in Telegram', !telegram.some(t => t.includes(W1) || t.includes(W2)));
    toets('telegram-melding na opslaan', /Sleutelportaal \(sessie [0-9a-f]{8}\): \d+ opgeslagen/.test(telegram[telegram.length - 1]));
    if (!ECHT) {
      toets('te korte kluiswaarde gaat via RPC (nep accepteert) of wordt geweigerd', x.tekst.includes('proef_een'));
      const p = n8nAanroepen.find(c => c.methode === 'PATCH');
      toets('n8n PATCH alleen het geheime veld + isPartialData', p && p.body.isPartialData === true && Object.keys(p.body.data).join() === 'apiKey' && p.body.data.apiKey === W2);
      toets('n8n test uitgevoerd', x.tekst.includes('n8n-test: geslaagd'));
      toets('nazorg herstart', x.tekst.includes('herstart van de claudebot-app'));
    }
    // dubbel verzenden
    let y = await vraag('POST', '/sleutels/opslaan', velden, { cookie }); toets('formulier eenmalig (409)', y.status === 409);

    // bijwerken van de nieuwe sleutel + terugzetten (echte keten of nep)
    r = await vraag('GET', '/sleutels', null, { cookie });
    const csrf2 = (r.tekst.match(/name="t" value="([0-9a-f]+)"/) || [])[1], form2 = (r.tekst.match(/name="f" value="([0-9a-f]+)"/) || [])[1];
    const wN = veldVan(NIEUW) || (r.tekst.match(new RegExp('name="(w\\d+)" autocomplete="new-password" spellcheck="false" aria-label="nieuwe waarde ' + NIEUW + '"')) || [])[1];
    if (ECHT) toets('nieuwe sleutel zichtbaar gemaskeerd', r.tekst.includes(NIEUW) && r.tekst.includes('••••' + W1.slice(-4)));
    const v2 = { t: csrf2, f: form2 }; v2[wN] = W2;
    x = await vraag('POST', '/sleutels/opslaan', v2, { cookie });
    toets('bijwerken opgeslagen', new RegExp(NIEUW + '</td><td>kluis</td><td class="ok">opgeslagen').test(x.tekst));
    if (ECHT) toets('na bijwerken nieuw masker', x.tekst.includes('••••' + W2.slice(-4)));
    toets('terugzetknop aanwezig', x.tekst.includes('value="' + NIEUW + '" formaction="/sleutels/terugzetten"'));
    const csrf3 = (x.tekst.match(/name="t" value="([0-9a-f]+)"/) || [])[1], form3 = (x.tekst.match(/name="f" value="([0-9a-f]+)"/) || [])[1];
    const v3 = { t: csrf3, f: form3, terug: NIEUW };
    const wX = (x.tekst.match(/name="(w\d+)" autocomplete="new-password"/) || [])[1]; v3[wX] = 'iets-ingevuld-123456';
    x = await vraag('POST', '/sleutels/terugzetten', v3, { cookie });
    toets('terugzetten geslaagd', x.tekst.includes('teruggezet (huidige en vorige gewisseld)'));
    toets('waarschuwing: ingevulde waarden niet opgeslagen', x.tekst.includes('zijn NIET opgeslagen'));
    if (ECHT) toets('na terugzetten oud masker', x.tekst.includes('••••' + W1.slice(-4)));
    // onbekende naam terugzetten
    const csrf4 = (x.tekst.match(/name="t" value="([0-9a-f]+)"/) || [])[1], form4 = (x.tekst.match(/name="f" value="([0-9a-f]+)"/) || [])[1];
    x = await vraag('POST', '/sleutels/terugzetten', { t: csrf4, f: form4, terug: 'pod_bootstrap_secret' }, { cookie });
    toets('terugzetten van onbekende/geweigerde naam geweigerd', x.tekst.includes('onbekende sleutel'));

    // wv1786: weggooien (alleen proef_-rijen en vorige-kopieën; de kluis zegt welke)
    if (!ECHT) {
      const tok = (t) => [(t.match(/name="t" value="([0-9a-f]+)"/) || [])[1], (t.match(/name="f" value="([0-9a-f]+)"/) || [])[1]];
      toets('W knop Weggooien bij proef_drie (vorige gaat mee)', x.tekst.includes('name="weg" value="proef_drie" formaction="/sleutels/weggooien">Weggooien</button> <span class="klein">proefrij, vorige gaat mee'));
      toets('W knop Vorige weggooien bij een rij met vorige', x.tekst.includes('name="weg" value="' + NIEUW + '__vorige" formaction="/sleutels/weggooien">Vorige weggooien'));
      toets('W geen Weggooien (rij zelf) bij proef_een zonder weg_kan', !x.tekst.includes('value="proef_een" formaction="/sleutels/weggooien"'));
      let [tW, fW] = tok(x.tekst);
      const nRpc = rpcs.filter(c => c.fn === 'sb_sleutelportaal_weg').length;
      x = await vraag('POST', '/sleutels/weggooien', { t: tW, f: fW, weg: 'proef_een' }, { cookie });
      toets('W naam die niet op de pagina weg mocht -> geweigerd zonder RPC', x.status === 200 && x.tekst.includes('mag hier niet weggegooid worden') && rpcs.filter(c => c.fn === 'sb_sleutelportaal_weg').length === nRpc);
      [tW, fW] = tok(x.tekst);
      x = await vraag('POST', '/sleutels/weggooien', { t: tW, f: fW, weg: 'pod_bootstrap_secret' }, { cookie });
      toets('W beschermde naam -> geweigerd zonder RPC', x.tekst.includes('mag hier niet weggegooid worden') && rpcs.filter(c => c.fn === 'sb_sleutelportaal_weg').length === nRpc);
      [tW, fW] = tok(x.tekst);
      const nT = telegram.length;
      const wIn = (x.tekst.match(/name="(w\d+)" autocomplete="new-password"/) || [])[1];
      const vW = { t: tW, f: fW, weg: 'proef_drie' }; vW[wIn] = 'iets-ingevuld-weg-123456';
      x = await vraag('POST', '/sleutels/weggooien', vW, { cookie });
      const rc = rpcs.filter(c => c.fn === 'sb_sleutelportaal_weg').pop() || { body: {} };
      toets('W proef_drie weggegooid via sb_sleutelportaal_weg (sessiekenmerk, geen vraag-id)', /proef_drie<\/td><td>kluis<\/td><td class="ok">weggegooid \(vorige ging mee\)/.test(x.tekst)
        && rc.body.p_naam === 'proef_drie' && rc.body.p_vraag === null && /^[0-9a-f]{8}$/.test(rc.body.p_sessie) && rc.body.p_sleutel === 'a'.repeat(64));
      toets('W nazorg: definitief-datum en terughalen via machinekamer', x.tekst.includes('weg__20261028__proef_drie') && x.tekst.includes('2026-11-12') && x.tekst.includes('via de machinekamer'));
      toets('W ingevulde waarden niet opgeslagen: waarschuwing', x.tekst.includes('zijn NIET opgeslagen (je koos weggooien)'));
      toets('W Telegram-melding weggooien', telegram.length === nT + 1 && /: proef_drie weggegooid \(met vorige, definitief weg na 2026-11-12\)/.test(telegram[nT]));
      toets('W weggegooide rij weg uit de tabel, wel in de lijst Weggegooid', !x.tekst.includes('aria-label="nieuwe waarde proef_drie"') && /Weggegooid \(gaan 14 dagen na de datum definitief weg[^<]*<code>weg__20261028__proef_drie<\/code>/.test(x.tekst));
      x = await vraag('POST', '/sleutels/weggooien', vW, { cookie });
      toets('W formulier eenmalig (409)', x.status === 409);
      x = await vraag('GET', '/sleutels', null, { cookie });
      [tW, fW] = tok(x.tekst);
      x = await vraag('POST', '/sleutels/weggooien', { t: tW, f: fW, weg: NIEUW + '__vorige' }, { cookie });
      toets('W vorige weggooien', new RegExp(NIEUW + '__vorige</td><td>kluis</td><td class="ok">weggegooid<').test(x.tekst) && (rpcs.filter(c => c.fn === 'sb_sleutelportaal_weg').pop() || { body: {} }).body.p_naam === NIEUW + '__vorige');
      toets('W daarna geen Vorige weggooien/terugzetten meer bij die rij', !x.tekst.includes('value="' + NIEUW + '__vorige"') && !x.tekst.includes('value="' + NIEUW + '" formaction="/sleutels/terugzetten"'));
      [tW, fW] = tok(x.tekst);
      x = await vraag('POST', '/sleutels/weggooien', { t: tW, f: fW, weg: 'proef_drie' }, { origin: 'null', cookie });
      toets('W origin null 403', x.status === 403);
      x = await vraag('POST', '/sleutels/weggooien', { t: 'f'.repeat(48), f: fW, weg: 'proef_drie' }, { cookie });
      toets('W zonder geldige csrf 403', x.status === 403);
      x = await vraag('GET', '/sleutels', null, { cookie });
    }

    // uitloggen
    const csrf5 = (x.tekst.match(/name="t" value="([0-9a-f]+)"/) || [])[1];
    x = await vraag('POST', '/sleutels/uitloggen', { t: csrf5 }, { cookie }); toets('uitloggen 303', x.status === 303);
    x = await vraag('GET', '/sleutels', null, { cookie }); toets('na uitloggen inlogpagina', x.tekst.includes('Stuur code'));

    // pogingen-grens
    ctx.spStaat.codeTijden = [];
    await vraag('POST', '/sleutels/code', {});
    for (let i = 0; i < 5; i++) await vraag('POST', '/sleutels/inloggen', { c: '99999999' });
    const laatsteCode = (telegram.filter(t => /code \d{8}/.test(t)).pop().match(/code (\d{8})/) || [])[1];
    x = await vraag('POST', '/sleutels/inloggen', { c: laatsteCode }); toets('na 5 foute pogingen is de code dood', x.status === 403);
    // daggrens
    ctx.spStaat.codeTijden = Array.from({ length: 10 }, (_, i) => Date.now() - 7200000 - i * 1000);
    x = await vraag('POST', '/sleutels/code', {}); toets('daggrens 429', x.status === 429);
    // extra (code-review ronde 2)
    x = await vraag('GET', '/sleutels/'); toets('/sleutels/ -> 303', x.status === 303 && x.koppen.location === '/sleutels');
    ctx.spStaat.codeTijden = []; telegramStuk = true;
    x = await vraag('POST', '/sleutels/code', {}, { host: HOST + ':443', origin: 'https://' + HOST });
    toets('Host met :443 geaccepteerd en Telegram-fout gemeld (502)', x.status === 502 && /niet via Telegram/.test(x.tekst));
    toets('na Telegram-fout geen geldige code', ctx.spStaat.code === null);
    telegramStuk = false;
    if (!ECHT) {
      ctx.spStaat.codeTijden = [];
      await vraag('POST', '/sleutels/code', {});
      const c2 = (telegram.filter(t => /code \d{8}/.test(t)).pop().match(/code (\d{8})/) || [])[1];
      const li = await vraag('POST', '/sleutels/inloggen', { c: c2 });
      const ck = String(li.koppen['set-cookie']).split(';')[0];
      const pg = await vraag('GET', '/sleutels', null, { cookie: ck });
      const t6 = (pg.tekst.match(/name="t" value="([0-9a-f]+)"/) || [])[1], f6 = (pg.tekst.match(/name="f" value="([0-9a-f]+)"/) || [])[1];
      const metaPad = path.join(werk, 'vault/00_Systeem/Beveiliging/Sleutelregister - portaalgegevens.json');
      fs.writeFileSync(metaPad, JSON.stringify({ kluis: null, n8n: 5, handmatig: [null, 3, { naam: 'ok' }] }));
      const pe = (pg.tekst.match(/name="(w\d+)" autocomplete="new-password" spellcheck="false" aria-label="nieuwe waarde proef_een"/) || [])[1];
      const v6 = { t: t6, f: f6 }; v6[pe] = 'Nog-een-waarde-1234567890';
      const z = await vraag('POST', '/sleutels/opslaan', v6, { cookie: ck });
      toets('kapotte metagegevens: toch een uitkomst', z.status === 200 && /proef_een<\/td><td>kluis<\/td><td class="ok">opgeslagen/.test(z.tekst));
    }
    // spSchoon
    toets('spSchoon haalt waarde weg', !ctx.spSchoon('fout bij abcdefghijklmnop', 'abcdefghijklmnop').includes('abcdefghijklmnop') && !ctx.spSchoon('x cdefghij y', 'abcdefghijklmnop').includes('cdefghij'));
    toets('geen waarde in foutlog', !logregels.some(l => l.includes(W1) || l.includes(W2)));
    console.log('wegwerpnaam: ' + NIEUW);
  } catch (e) { fouten++; console.log('ROOD: uitzondering ' + (e && e.stack)); }
  console.log((fouten ? 'ROOD' : 'GROEN') + ': ' + goed + ' goed, ' + fouten + ' fout' + (ECHT ? ' (echte kluis)' : ''));
  server.close(); fs.rmSync(werk, { recursive: true, force: true });
  process.exit(fouten ? 1 : 0);
});
JS
