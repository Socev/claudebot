#!/usr/bin/env node
/*
 * tunnel-inrichten.js — richt de Cloudflare-tunnel socev-olares in (uitwijk stap 2, 6-10-2026).
 * Bouwplan: vault 01_Ontwikkeling/Uitwijk claudebot en n8n - bouwplan (6-10-2026).md §4.4 en §10.
 *
 * Idempotent: elke stap kijkt eerst wat er al staat. Draai als 'claude' in de pod (CLOUDFLARE_API_TOKEN en
 * SUPABASE_SERVICE_ROLE uit de pod-omgeving). Alleen namen en uitkomsten in de uitvoer, nooit een waarde.
 *
 *   node tools/tunnel-inrichten.js toets                 alleen de toets van buiten (via de Cloudflare-rand)
 *   node tools/tunnel-inrichten.js ingress               alleen de ingress opnieuw zetten (zie INGRESS hieronder) + toets
 *   [INVOERCODE=…] node tools/tunnel-inrichten.js inrichten   (zonder INVOERCODE: kluisstap overgeslagen)
 *       1. tunnel socev-olares (remote-managed) zoeken of aanmaken          [token: Cloudflare Tunnel Bewerken]
 *       2. ingress zetten (wat de tunnel doorlaat, zie INGRESS hieronder)
 *       3. tunneltoken -> kluis cloudflare_tunnel_token_olares via sb_secret_toevoegen (eenmalige invoercode)
 *       4. DNS: n8n.huisdokter.dev (oud dood record) en socev.huisdokter.dev -> <id>.cfargotunnel.com
 *       5. overbrugging: draait er nog geen cloudflared, dan één los proces met alleen TUNNEL_TOKEN in de omgeving
 *          (tot de eerstvolgende podstart; daarna start server.js zelf het kind uit de kluiswaarde)
 *       6. toets
 *   node tools/tunnel-inrichten.js app-pod              Socev-app fase 1 (7-10-2026): pod-ingang app-pod.socev.dev
 *       a. servicetoken "Socev-app Functions" (Access) zoeken of aanmaken -> Pages-secrets APP_POD_CLIENT_ID/_SECRET
 *          + /opt/data/socev-app-data/geheim/servicetoken.json (0600, alleen voor de toets hieronder)
 *          (na de productietoets client_secret eruit halen: Fable-review 7-10 #10; de stap blijft dan idempotent)
 *       b. poortgeheim: /opt/data/socev-app-data/geheim/poort.key (0600) -> Pages-secret APP_POORT_SECRET
 *       c. Access-app op app-pod.socev.dev die ALLEEN dat servicetoken toelaat (eerst de deur, dan pas DNS)
 *       d. /opt/data/socev-app-data/config.json (aud, teamdomein, client-id; geen geheimen) voor server.js
 *       e. DNS app-pod.socev.dev -> tunnel; f. ingress (alleen ^/app/); g. toets
 *       Bouwplan: vault 01_Ontwikkeling/Socev-app - bouwplan (7-10-2026).md § 4.5. Nieuwe Pages-secrets werken pas na
 *       een nieuwe Pages-uitrol (npm run deploy in /opt/data/socev-app).
 *   --editor bestaat niet meer (6-10-2026): geen editor en geen inlogpagina onder huisdokter.dev (phishingvlag Google).
 *
 * Nooit `cloudflared tunnel route dns` (kaapt het record); DNS gaat hier via de API.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ACC = '23df9b0607bb70f6d7f15a63ec843d6d';
const ZONE = 'd58516136eb42c086bc872afb55bf169';           // huisdokter.dev
const NAAM = 'socev-olares';
const N8N = 'n8n.huisdokter.dev';
const SOCEV = 'socev.huisdokter.dev';
const N8N_ORIGIN_HOST = 'n8n.primumnonnocere.olares.com'; // vanuit de pod: intern (192.168.20.54), geen Olares-login
// Socev-app (fase 1, 7-10-2026): pod-ingang voor de app-Functions, in de zone socev.dev.
const APP_POD = 'app-pod.socev.dev';
const ZONE_SOCEV = 'e101b5a80b8fb6bf465372bf801e46d3';      // socev.dev
const APP_DATA = '/opt/data/socev-app-data';
const APP_GEHEIM = path.join(APP_DATA, 'geheim');
const APP_ST_NAAM = 'Socev-app Functions';
const APP_ACCESS_NAAM = 'Socev-app pod-ingang (alleen servicetoken)';
const APP_PAGES = 'socev-app';
const TEAM = 'https://huisdokter.cloudflareaccess.com';
const KLUISNAAM = 'cloudflare_tunnel_token_olares';
const BIN = '/opt/data/bin/cloudflared';
const LOG = '/opt/data/bin/tunnel.log';
const METRICS = '127.0.0.1:' + (process.env.TUNNEL_METRICS_POORT || '20241');   // zelfde poort als server.js (los-proces-herkenning)

// Wat de tunnel doorlaat. Volgorde telt: de eerste regel die past wint. Alles wat niet past: 404.
// Sinds 6-10-2026 avond (Google Safe Browsing vlagde heel huisdokter.dev als phishing, 3e keer): onder huisdokter.dev
// GEEN browser-HTML met invoer of inlog meer. Dus geen editor, geen /form/ (bestandenportaal, secret-invoer, FV2),
// geen Access-inlog, en ook de webhooks die een HTML-pagina geven (kluisluik, FV2-dashboard, agenda-knop) dicht.
// Editor, formulieren, kluisluik en sleutelportaal blijven op de Olares-adressen. Bij een uitwijk komen editor en
// formulieren tijdelijk achter Access op de VPS (bouwplan §6.1), niet via dit script.
// n8n: alleen /webhook/ (machinepaden, POST/JSON) en readiness (alleen {"status":"ok"}) voor de Worker.
// socev: alleen /health/publiek en de kastjepaden (met hun eigen kastjecontrole).
// (?i) en /+: n8n zoekt webhookpaden niet per se hoofdlettergevoelig op en kan dubbele slashes samenvouwen.
const HTML_WEBHOOKS = '(?i)^/webhook/+(fv2(/|$)|kluis-|agenda-knop-)';
function ingress() {
  const n8nOrigin = { service: 'https://' + N8N_ORIGIN_HOST, originRequest: { httpHostHeader: N8N_ORIGIN_HOST, originServerName: N8N_ORIGIN_HOST } };
  // Eerst: elk pad met een '..'-segment dicht. cloudflared matcht op het gedecodeerde pad zonder dot-segmenten op te
  // lossen, dus '/webhook/../rest/settings' en '/webhook/%2e%2e/rest' zouden anders op de webhook-regel passen en pas
  // achter de Olares-ingang tot '/rest/...' genormaliseerd worden (review Fable 6-10).
  return { config: { ingress: [
    { hostname: N8N, path: '/\\.\\.(/|\\\\|$)', service: 'http_status:404' },
    { hostname: SOCEV, path: '/\\.\\.(/|\\\\|$)', service: 'http_status:404' },
    { hostname: N8N, path: HTML_WEBHOOKS, service: 'http_status:404' },
    Object.assign({ hostname: N8N, path: '^/webhook/' }, n8nOrigin),
    Object.assign({ hostname: N8N, path: '^/healthz/readiness$' }, n8nOrigin),
    { hostname: N8N, service: 'http_status:404' },
    { hostname: SOCEV, path: '^/(health/publiek|auto/(ota/?|ws|hartslag|bericht/[0-9a-f]{32}/aankondiging))$', service: 'http://localhost:8080' },
    // Socev-app: alleen /app/<kleine letters, cijfers, / en ->; geen punt, geen procentteken (dus ook geen %2e%2e).
    // Daarvóór al: '..'-segmenten 404. De pod controleert daarna zelf poortgeheim, Access-bewijs en sessie.
    { hostname: APP_POD, path: '/\\.\\.(/|\\\\|$)', service: 'http_status:404' },
    { hostname: APP_POD, path: '^/app/[a-z0-9/-]{1,64}$', service: 'http://localhost:8080' },
    { hostname: APP_POD, service: 'http_status:404' },
    { service: 'http_status:404' },
  ] } };
}

async function cf(methode, pad, body) {
  const r = await fetch('https://api.cloudflare.com/client/v4' + pad, {
    method: methode, headers: { authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(function () { return {}; });
  if (!r.ok || j.success === false) {
    const fout = (j.errors || []).map(function (e) { return e.code + ' ' + e.message; }).join('; ');
    throw new Error(methode + ' ' + pad.replace(ACC, '<acc>').replace(ZONE, '<zone>') + ' -> HTTP ' + r.status + (fout ? ' (' + fout + ')' : ''));
  }
  return j.result;
}

async function tunnelZoekOfMaak() {
  const lijst = await cf('GET', '/accounts/' + ACC + '/cfd_tunnel?is_deleted=false&name=' + NAAM);
  if (lijst && lijst.length) { console.log('tunnel bestaat:', lijst[0].id); return lijst[0].id; }
  const t = await cf('POST', '/accounts/' + ACC + '/cfd_tunnel', { name: NAAM, config_src: 'cloudflare' });
  console.log('tunnel aangemaakt:', t.id);
  return t.id;
}

// Staat er nog een Access-app op een huisdokter.dev-host? Dan toont die een inlogpagina onder het domein (6-10-2026).
async function accessOpHuisdokter() {
  const apps = await cf('GET', '/accounts/' + ACC + '/access/apps?per_page=100');
  return (apps || []).filter(function (a) {
    const doelen = [a.domain].concat((a.destinations || []).map(function (d) { return d.uri; })).concat(a.self_hosted_domains || []);
    return doelen.some(function (d) { return /(^|\.)huisdokter\.dev(\/|$)/.test(String(d || '')); });
  }).map(function (a) { return a.name; });
}

async function tokenNaarKluis(token) {
  const code = process.env.INVOERCODE;
  if (!code) { console.log('kluis ' + KLUISNAAM + ': overgeslagen (geen INVOERCODE)'); return; }
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, ''), key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL of SUPABASE_SERVICE_ROLE ontbreekt');
  const r = await fetch(url + '/rest/v1/rpc/sb_secret_toevoegen', {
    method: 'POST', headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ p_code: code, p_naam: KLUISNAAM, p_waarde: token, p_omschrijving: 'Token Cloudflare-tunnel socev-olares (uitwijk stap 2)' }),
    signal: AbortSignal.timeout(20000),
  });
  const tekst = await r.text();
  // Alleen status en de velden zonder waarde tonen.
  let j = null; try { j = JSON.parse(tekst); } catch (e) {}
  const kort = j && typeof j === 'object' ? JSON.stringify({ ok: j.ok, actie: j.actie, reden: j.reden, fout: j.fout }) : '(geen json)';
  console.log('kluis ' + KLUISNAAM + ': HTTP ' + r.status + ' ' + kort);
  if (!r.ok || (j && j.ok === false)) throw new Error('kluis weigerde');
}

async function dns(id) {
  const doel = id + '.cfargotunnel.com';
  for (const naam of [N8N, SOCEV]) {
    const bestaand = await cf('GET', '/zones/' + ZONE + '/dns_records?name=' + naam);
    if (bestaand && bestaand.length > 1) throw new Error('dns ' + naam + ': ' + bestaand.length + ' records - eerst met de hand opruimen');
    const body = { type: 'CNAME', name: naam, content: doel, proxied: true, comment: 'tunnel ' + NAAM + ' (uitwijk stap 2, 6-10-2026)' };
    if (bestaand && bestaand.length) {
      if (bestaand[0].content === doel) { console.log('dns ' + naam + ': staat al goed'); continue; }
      await cf('PATCH', '/zones/' + ZONE + '/dns_records/' + bestaand[0].id, body);
      console.log('dns ' + naam + ': vervangen (was ' + bestaand[0].content + ')');
    } else {
      await cf('POST', '/zones/' + ZONE + '/dns_records', body);
      console.log('dns ' + naam + ': aangemaakt');
    }
  }
}

// ── Socev-app pod-ingang (stap app-pod) ──
function appGeheimLees(naam) { try { return fs.readFileSync(path.join(APP_GEHEIM, naam), 'utf8'); } catch (e) { return null; } }
function appGeheimSchrijf(naam, inhoud) {
  fs.mkdirSync(APP_GEHEIM, { recursive: true, mode: 0o700 });
  fs.chmodSync(APP_DATA, 0o700); fs.chmodSync(APP_GEHEIM, 0o700);
  const f = path.join(APP_GEHEIM, naam), tmp = f + '.nieuw';
  fs.writeFileSync(tmp, inhoud, { mode: 0o600 });
  fs.renameSync(tmp, f);
}
// Pages-secret zetten via wrangler; de waarde gaat alleen via stdin, nooit in argv of uitvoer. Werkmap = de eigen repo
// (niet /tmp: daar kan een geplante node_modules liggen). Welke secrets gezet zijn staat in geheim/pages-gezet.json,
// zodat een tweede run na een mislukte wrangler-stap het alsnog doet (review wv55 #9).
const PAGES_GEZET = 'pages-gezet.json';
function pagesGezet() { try { return JSON.parse(appGeheimLees(PAGES_GEZET) || '{}'); } catch (e) { return {}; } }
function pagesSecret(naam, waarde) {
  const r = spawnSync('npx', ['--yes', 'wrangler@4', 'pages', 'secret', 'put', naam, '--project-name', APP_PAGES], {
    input: waarde, encoding: 'utf8', timeout: 120000, cwd: '/opt/data/socev-app',
    env: Object.assign({}, process.env, { CLOUDFLARE_ACCOUNT_ID: ACC, WRANGLER_SEND_METRICS: 'false' }),
  });
  const uit = String((r.stdout || '') + (r.stderr || '')).split(waarde).join('••••');
  if (r.status !== 0) throw new Error('pages secret ' + naam + ': wrangler exit ' + r.status + ' ' + uit.replace(/\s+/g, ' ').slice(-200));
  const g = pagesGezet(); g[naam] = new Date().toISOString(); appGeheimSchrijf(PAGES_GEZET, JSON.stringify(g));
  console.log('pages-secret ' + naam + ': gezet');
}
async function appServicetoken() {
  const lijst = await cf('GET', '/accounts/' + ACC + '/access/service_tokens');
  const bestaand = (lijst || []).find(function (t) { return t.name === APP_ST_NAAM; });
  const lokaal = appGeheimLees('servicetoken.json');
  if (bestaand) {
    if (!lokaal || JSON.parse(lokaal).client_id !== bestaand.client_id) throw new Error('servicetoken "' + APP_ST_NAAM + '" bestaat, maar het geheim staat niet (meer) op de pod - vervangen via de machinekamer (rotate), niet blind opnieuw');
    console.log('servicetoken bestaat (verloopt ' + bestaand.expires_at + ')');
    const st = JSON.parse(lokaal), g = pagesGezet();
    if (!g.APP_POD_CLIENT_ID) pagesSecret('APP_POD_CLIENT_ID', st.client_id);
    if (!g.APP_POD_CLIENT_SECRET) pagesSecret('APP_POD_CLIENT_SECRET', st.client_secret);
    return { id: bestaand.id, client_id: bestaand.client_id };
  }
  const t = await cf('POST', '/accounts/' + ACC + '/access/service_tokens', { name: APP_ST_NAAM, duration: '8760h' });
  appGeheimSchrijf('servicetoken.json', JSON.stringify({ id: t.id, client_id: t.client_id, client_secret: t.client_secret, aangemaakt: new Date().toISOString(), verloopt: t.expires_at || null }));
  console.log('servicetoken aangemaakt (verloopt ' + (t.expires_at || '?') + ')');
  pagesSecret('APP_POD_CLIENT_ID', t.client_id);
  pagesSecret('APP_POD_CLIENT_SECRET', t.client_secret);
  return { id: t.id, client_id: t.client_id };
}
function appPoortgeheim() {
  const bestaand = (appGeheimLees('poort.key') || '').trim();
  if (bestaand) {
    if (!pagesGezet().APP_POORT_SECRET) pagesSecret('APP_POORT_SECRET', bestaand);
    else console.log('poortgeheim staat er al (niet opnieuw gezet)');
    return;
  }
  const g = crypto.randomBytes(32).toString('hex');
  appGeheimSchrijf('poort.key', g);
  pagesSecret('APP_POORT_SECRET', g);
  console.log('poortgeheim aangemaakt');
}
async function appAccess(tokenId) {
  const apps = await cf('GET', '/accounts/' + ACC + '/access/apps?per_page=100');
  const body = { name: APP_ACCESS_NAAM, domain: APP_POD, type: 'self_hosted', session_duration: '24h', app_launcher_visible: false,
    auto_redirect_to_identity: false, service_auth_401_redirect: true, skip_interstitial: true,
    policies: [{ name: 'Alleen servicetoken Socev-app Functions', decision: 'non_identity', precedence: 1, include: [{ service_token: { token_id: tokenId } }] }] };
  const bestaand = (apps || []).find(function (a) { return a.domain === APP_POD; });
  const app = bestaand ? await cf('PUT', '/accounts/' + ACC + '/access/apps/' + bestaand.id, body) : await cf('POST', '/accounts/' + ACC + '/access/apps', body);
  console.log('access-app ' + APP_POD + ': ' + (bestaand ? 'bijgewerkt' : 'aangemaakt'));
  return app.aud;
}
async function appDns(id) {
  const doel = id + '.cfargotunnel.com';
  const bestaand = await cf('GET', '/zones/' + ZONE_SOCEV + '/dns_records?name=' + APP_POD);
  if (bestaand && bestaand.length > 1) throw new Error('dns ' + APP_POD + ': ' + bestaand.length + ' records - eerst met de hand opruimen');
  const body = { type: 'CNAME', name: APP_POD, content: doel, proxied: true, comment: 'tunnel ' + NAAM + ' - Socev-app pod-ingang (fase 1, 7-10-2026)' };
  if (bestaand && bestaand.length && bestaand[0].content === doel) return console.log('dns ' + APP_POD + ': staat al goed');
  if (bestaand && bestaand.length) { await cf('PATCH', '/zones/' + ZONE_SOCEV + '/dns_records/' + bestaand[0].id, body); console.log('dns ' + APP_POD + ': vervangen'); }
  else { await cf('POST', '/zones/' + ZONE_SOCEV + '/dns_records', body); console.log('dns ' + APP_POD + ': aangemaakt'); }
}
async function appPod() {
  const st = await appServicetoken();
  appPoortgeheim();
  const aud = await appAccess(st.id);
  const cfgPad = path.join(APP_DATA, 'config.json');
  fs.writeFileSync(cfgPad + '.nieuw', JSON.stringify({ access_team: TEAM, access_aud: aud, servicetoken_client_id: st.client_id,
    herkomst: 'https://app.socev.dev', rp_id: 'app.socev.dev', bijgewerkt: new Date().toISOString() }, null, 1), { mode: 0o600 });
  fs.renameSync(cfgPad + '.nieuw', cfgPad);
  console.log('config.json geschreven (aud ' + aud.slice(0, 8) + '…)');
  const t = await tunnelZoekOfMaak();
  await appDns(t);
  await cf('PUT', '/accounts/' + ACC + '/cfd_tunnel/' + t + '/configurations', ingress());
  console.log('ingress gezet');
}

function draaitAl() {
  for (const pid of fs.readdirSync('/proc').filter(function (d) { return /^\d+$/.test(d); })) {
    let cmd = ''; try { cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8'); } catch (e) { continue; }
    const d = cmd.split('\0');
    if ((/cloudflared$/.test(d[0] || '') || /cloudflared$/.test(d[1] || '')) && d.indexOf('tunnel') >= 0 && d.indexOf('run') >= 0) return pid;
  }
  return null;
}

function overbrugging(token) {
  const pid = draaitAl();
  if (pid) { console.log('cloudflared draait al (pid ' + pid + '), geen overbrugging nodig'); return; }
  const fd = fs.openSync(LOG, 'a');
  // Gelijk aan server.js tunnelStart: alleen PATH/HOME/TZ/TUNNEL_TOKEN, log rechtstreeks naar bestand, los van deze shell.
  const k = spawn(BIN, ['tunnel', '--no-autoupdate', '--metrics', METRICS, 'run'], {
    cwd: '/opt/data', detached: true, stdio: ['ignore', fd, fd],
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/opt/data', TZ: 'Europe/Amsterdam', TUNNEL_TOKEN: token },
  });
  k.on('error', function (e) { console.error('FOUT: overbrugging start niet (' + e.code + ')'); process.exit(2); });
  k.unref();
  fs.closeSync(fd);
  console.log('overbrugging gestart: los cloudflared-proces pid ' + k.pid + ' (tot de eerstvolgende podstart)');
}

// Rauw pad (geen WHATWG-normalisatie van '..' en %2e): voor de padtrucs (review 6-10).
function rauw(methode, host, pad, koppen) {
  return new Promise(function (ok) {
    const q = require('https').request({ host: host, path: pad, method: methode, timeout: 15000, servername: host, headers: koppen || {} }, function (res) {
      let t = ''; res.setEncoding('utf8');
      res.on('data', function (d) { if (t.length < 300) t += d; });
      res.on('end', function () { ok({ status: res.statusCode, tekst: t, location: res.headers.location || '' }); });
    });
    q.on('timeout', function () { q.destroy(); ok({ status: 0, tekst: 'time-out' }); });
    q.on('error', function (e) { ok({ status: 0, tekst: e.code || 'fout' }); });
    q.end();
  });
}

async function http(methode, url, koppen) {
  try {
    const r = await fetch(url, { method: methode, redirect: 'manual', headers: koppen || {}, signal: AbortSignal.timeout(15000) });
    const t = (await r.text()).slice(0, 300);
    return { status: r.status, tekst: t, location: r.headers.get('location') || '' };
  } catch (e) { return { status: 0, tekst: e.name }; }
}

async function toets() {
  const n404 = function (r) { return r.status === 404 && !r.location; };
  // Dicht in de tunnel = lege 404 van cloudflared; een n8n-404 noemt 'webhook' (dan kwam het verzoek wél bij n8n).
  const tunnel404 = function (r) { return n404(r) && !/webhook/i.test(r.tekst); };
  const regels = [
    ['GET', 'https://' + N8N + '/healthz/readiness', function (r) { return r.status === 200 && /ok/.test(r.tekst); }, 'readiness 200'],
    ['GET', 'https://' + N8N + '/webhook/socev-wachter-ping', function (r) { return r.status === 404 && /webhook/i.test(r.tekst); }, 'n8n-404 met webhook-JSON (n8n antwoordt zelf)'],
    ['GET', 'https://' + N8N + '/', n404, 'editor dicht (404, geen redirect, geen Access)'],
    ['GET', 'https://' + N8N + '/signin', n404, 'n8n-inlog dicht'],
    ['GET', 'https://' + N8N + '/rest/settings', n404, '/rest dicht'],
    ['GET', 'https://' + N8N + '/form/files', n404, 'bestandenportaal niet via huisdokter.dev'],
    ['GET', 'https://' + N8N + '/form/secret-invoer', n404, 'secret-invoer niet via huisdokter.dev'],
    ['GET', 'https://' + N8N + '/form-waiting/1', n404, 'form-waiting dicht'],
    ['GET', 'https://' + N8N + '/webhook-test/x', n404, 'webhook-test dicht'],
    ['GET', 'https://' + N8N + '/webhook/kluis-x', tunnel404, 'kluisluik (HTML) dicht'],
    ['GET', 'https://' + N8N + '/webhook/fv2', tunnel404, 'FV2-dashboard (HTML) dicht'],
    ['GET', 'https://' + N8N + '/webhook/fv2/status', tunnel404, 'FV2-subpad (HTML) dicht'],
    ['GET', 'https://' + N8N + '/webhook/agenda-knop-x', tunnel404, 'agenda-knop (HTML) dicht'],
    ['GET', 'https://' + N8N + '/rest/oauth2-credential/callback', n404, 'oauth-callback dicht'],
    ['GET', 'https://' + N8N + '/api/v1/workflows', n404, '/api/v1 dicht'],
    ['GET', 'https://' + N8N + '/mcp-server/http', n404, '/mcp-server dicht'],
    ['GET', 'https://' + N8N + '/healthz', n404, '/healthz (zonder readiness) dicht'],
    ['GET', 'https://' + N8N + '/healthz/readiness/x', n404, 'subpad onder readiness dicht'],
    ['GET', 'https://' + SOCEV + '/health/publiek', function (r) { return r.status === 200 && /"ok":true/.test(r.tekst) && !/secrets/.test(r.tekst); }, 'pod /health/publiek 200, klein'],
    ['GET', 'https://' + SOCEV + '/health', function (r) { return r.status === 404; }, 'pod /health dicht'],
    ['POST', 'https://' + SOCEV + '/run', function (r) { return r.status === 404; }, '/run 404'],
    ['GET', 'https://' + SOCEV + '/result/x', function (r) { return r.status === 404; }, '/result 404'],
    ['POST', 'https://' + SOCEV + '/agent', function (r) { return r.status === 404; }, '/agent 404'],
    ['GET', 'https://' + SOCEV + '/agents', function (r) { return r.status === 404; }, '/agents 404'],
    ['GET', 'https://' + SOCEV + '/sleutels', function (r) { return r.status === 404 && !r.location; }, '/sleutels 404 (sleutelportaal alleen via Olares)'],
    ['GET', 'https://' + SOCEV + '/', function (r) { return r.status === 404 && !r.location; }, 'socev / 404'],
    ['GET', 'https://' + SOCEV + '/auto/ota', function (r) { return r.status === 403; }, 'kastje-OTA bereikt de pod (403 zonder kastjesleutel, zoals via Olares)'],
    ['GET', 'https://' + SOCEV + '/auto/hartslag', function (r) { return r.status === 405; }, 'kastje-hartslag bereikt de pod (405 op GET)'],
  ];
  const dicht = function (r) { return r.status === 404 || r.status === 400; };
  const trucs = [[N8N, '/webhook/../rest/settings'], [N8N, '/webhook/%2e%2e/form/files'], [N8N, '/webhook/x/../kluis-x'], [N8N, '/WEBHOOK/kluis-x'], [N8N, '/webhook//kluis-x'], [N8N, '/webhook/KLUIS-x'], [N8N, '/webhook/%6Bluis-x'], [N8N, '/webhook/..%2Frest/settings'],
    [N8N, '/webhook/%2E%2E/%2E%2E/rest/login'], [N8N, '/form/..\\rest/settings'], [SOCEV, '/auto/ota/../../health'],
    [SOCEV, '/auto/ota/..%2F..%2Fhealth'], [SOCEV, '/health%2Fpubliek/../../health'], [SOCEV, '/auto/ota/%2e%2e/%2e%2e/run']];
  let fout = 0;
  for (const [m, url, ok, wat] of regels) {
    const r = await http(m, url);
    const goed = ok(r);
    if (!goed) fout++;
    console.log((goed ? 'GROEN ' : 'ROOD  ') + wat + '  [' + m + ' ' + url.replace('https://', '') + ' -> ' + r.status + (r.location ? ' ' + r.location.slice(0, 60) : '') + ']');
  }
  for (const [host, pad] of trucs) {
    const r = await rauw('GET', host, pad);
    const goed = dicht(r);
    if (!goed) fout++;
    console.log((goed ? 'GROEN ' : 'ROOD  ') + 'padtruc dicht  [GET ' + host + pad + ' -> ' + r.status + ']');
  }
  fout += await toetsAppPod(n404);
  const apps = await accessOpHuisdokter().catch(function (e) { return ['(niet leesbaar: ' + e.message + ')']; });
  if (apps.length) fout++;
  console.log((apps.length ? 'ROOD  ' : 'GROEN ') + 'geen Access-app op huisdokter.dev' + (apps.length ? ' [' + apps.join('; ') + ']' : ''));
  console.log(fout ? fout + ' ROOD' : 'TOETS GROEN');
  return fout;
}

// Socev-app pod-ingang. Zonder servicetoken weigert Access; met servicetoken komt alleen /app/<…> bij de pod, en de pod
// weigert zonder poortgeheim (401) en zonder sessie (401). Staat de ingang nog niet (geen geheimbestand), dan alleen
// de controle dat de andere hosts /app/ niet doorlaten.
async function toetsAppPod(n404) {
  let fout = 0;
  const regel = function (goed, wat, r, extra) { if (!goed) fout++; console.log((goed ? 'GROEN ' : 'ROOD  ') + wat + '  [' + extra + ' -> ' + r.status + (r.location ? ' ' + r.location.slice(0, 50) : '') + ']'); };
  for (const host of [N8N, SOCEV]) { const r = await http('GET', 'https://' + host + '/app/status'); regel(n404(r), '/app/ niet via ' + host, r, 'GET ' + host + '/app/status'); }
  const stTekst = appGeheimLees('servicetoken.json'), poort = (appGeheimLees('poort.key') || '').trim();
  if (!stTekst || !poort) { console.log('LET OP  app-pod nog niet ingericht (geen servicetoken/poortgeheim op de pod): alleen de controle hierboven'); return fout; }
  const st = JSON.parse(stTekst);
  if (!st.client_secret) {
    // Na de productietoets is het geheim van het servicetoken van de pod gewist (Fable-review 7-10 #10); alleen Pages kent het nog.
    const r0 = await http('GET', 'https://' + APP_POD + '/app/status');
    regel(r0.status === 401 || r0.status === 403 || (r0.status === 302 && /cloudflareaccess/.test(r0.location)), 'app-pod zonder servicetoken: Access weigert', r0, 'GET /app/status');
    console.log('LET OP  servicetoken-geheim staat niet op de pod (bewust gewist): de app-pod-toetsen met servicetoken lopen niet');
    return fout;
  }
  const tok = { 'CF-Access-Client-Id': st.client_id, 'CF-Access-Client-Secret': st.client_secret };
  const metPoort = Object.assign({ 'X-App-Poort': poort }, tok);
  const U = 'https://' + APP_POD;
  let r = await http('GET', U + '/app/status');
  regel(r.status === 401 || r.status === 403 || (r.status === 302 && /cloudflareaccess/.test(r.location)), 'app-pod zonder servicetoken: Access weigert', r, 'GET /app/status');
  r = await http('GET', U + '/app/status', { 'CF-Access-Client-Id': st.client_id, 'CF-Access-Client-Secret': 'fout' });
  regel(r.status === 401 || r.status === 403 || r.status === 302, 'app-pod met fout servicetoken: Access weigert', r, 'GET /app/status');
  r = await http('GET', U + '/app/status', tok);
  regel(r.status === 401 && /niet toegestaan/.test(r.tekst), 'servicetoken zonder poortgeheim: pod weigert (401)', r, 'GET /app/status');
  r = await http('GET', U + '/app/status', Object.assign({}, tok, { 'X-App-Poort': 'f'.repeat(64) }));
  regel(r.status === 401, 'servicetoken + fout poortgeheim: 401', r, 'GET /app/status');
  r = await http('GET', U + '/app/status', metPoort);
  regel(r.status === 200 && /"koppelen_open"/.test(r.tekst), 'servicetoken + poortgeheim: pod accepteert het Access-bewijs (status 200)', r, 'GET /app/status');
  r = await http('GET', U + '/app/apparaten', metPoort);
  regel(r.status === 401 && /vingerafdruk/.test(r.tekst), 'alles behalve een pod-sessie: 401', r, 'GET /app/apparaten');
  for (const [m, pad] of [['POST', '/run'], ['GET', '/result/x'], ['POST', '/agent'], ['GET', '/agents'], ['GET', '/health'], ['GET', '/health/publiek'], ['GET', '/'], ['GET', '/sleutels'], ['GET', '/auto/ota'], ['GET', '/app'], ['GET', '/app/STATUS']]) {
    r = await http(m, U + pad, metPoort);
    regel(n404(r), 'app-pod ' + pad + ' dicht in de tunnel (404)', r, m + ' ' + pad);
  }
  for (const pad of ['/app/../run', '/app/%2e%2e/run', '/app/%2E%2E/health', '/app/..%2Frun', '/app/status/../../health', '/app/x/..\\run', '/app//../run', '/app/status%2F..%2F..%2Frun']) {
    r = await rauw('GET', APP_POD, pad, metPoort);
    regel(r.status === 404 || r.status === 400, 'app-pod padtruc dicht', r, 'GET ' + pad);
  }
  return fout;
}

(async function () {
  const stap = process.argv[2] || 'toets';
  // Uitwijk stap 6d (review 8-10 #2): dit script raakt socev-olares en start zo nodig een cloudflared met een vers
  // token van de Cloudflare-API. Op de VPS-pod (SOCEV_KANT=vps) zou dat een tweede connector aan de Olares-tunnel
  // hangen; daar weigert het daarom alles.
  const kant = process.env.SOCEV_KANT || 'olares';
  if (kant !== 'olares') { console.error('tunnel-inrichten: kant ' + kant + ': dit script hoort alleen bij Olares (socev-olares); niets gedaan'); process.exit(2); }
  try {
    if (process.argv.includes('--editor')) throw new Error('--editor bestaat niet meer: geen editor of inlog onder huisdokter.dev (phishingvlag Google, 6-10-2026); editor via n8n.primumnonnocere.olares.com');
    if (stap === 'toets') process.exit(await toets() ? 1 : 0);
    if (stap === 'ingress') {
      const t = await tunnelZoekOfMaak();
      await cf('PUT', '/accounts/' + ACC + '/cfd_tunnel/' + t + '/configurations', ingress());
      console.log('ingress gezet');
      await new Promise(function (r) { setTimeout(r, 15000); });
      process.exit(await toets() ? 1 : 0);
    }
    if (stap === 'app-pod') {
      await appPod();
      await new Promise(function (r) { setTimeout(r, 20000); });
      process.exit(await toets() ? 1 : 0);
    }
    if (stap !== 'inrichten') throw new Error('onbekende stap ' + stap + ' (toets | ingress | app-pod | inrichten)');
    const id = await tunnelZoekOfMaak();
    await cf('PUT', '/accounts/' + ACC + '/cfd_tunnel/' + id + '/configurations', ingress());
    console.log('ingress gezet');
    const token = await cf('GET', '/accounts/' + ACC + '/cfd_tunnel/' + id + '/token');
    await tokenNaarKluis(token);
    await dns(id);
    overbrugging(token);
    await new Promise(function (r) { setTimeout(r, 20000); });
    process.exit(await toets() ? 1 : 0);
  } catch (e) {
    console.error('FOUT: ' + e.message);
    process.exit(2);
  }
})();
