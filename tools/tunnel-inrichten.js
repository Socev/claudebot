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
 *   --editor bestaat niet meer (6-10-2026): geen editor en geen inlogpagina onder huisdokter.dev (phishingvlag Google).
 *
 * Nooit `cloudflared tunnel route dns` (kaapt het record); DNS gaat hier via de API.
 */
'use strict';
const fs = require('fs');
const { spawn } = require('child_process');

const ACC = '23df9b0607bb70f6d7f15a63ec843d6d';
const ZONE = 'd58516136eb42c086bc872afb55bf169';           // huisdokter.dev
const NAAM = 'socev-olares';
const N8N = 'n8n.huisdokter.dev';
const SOCEV = 'socev.huisdokter.dev';
const N8N_ORIGIN_HOST = '5877e26c.primumnonnocere.olares.com'; // vanuit de pod: intern (192.168.20.54), geen Olares-login
const KLUISNAAM = 'cloudflare_tunnel_token_olares';
const BIN = '/opt/data/bin/cloudflared';
const LOG = '/opt/data/bin/tunnel.log';
const METRICS = '127.0.0.1:20241';

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
function rauw(methode, host, pad) {
  return new Promise(function (ok) {
    const q = require('https').request({ host: host, path: pad, method: methode, timeout: 15000, servername: host }, function (res) {
      let t = ''; res.setEncoding('utf8');
      res.on('data', function (d) { if (t.length < 300) t += d; });
      res.on('end', function () { ok({ status: res.statusCode, tekst: t, location: res.headers.location || '' }); });
    });
    q.on('timeout', function () { q.destroy(); ok({ status: 0, tekst: 'time-out' }); });
    q.on('error', function (e) { ok({ status: 0, tekst: e.code || 'fout' }); });
    q.end();
  });
}

async function http(methode, url) {
  try {
    const r = await fetch(url, { method: methode, redirect: 'manual', signal: AbortSignal.timeout(15000) });
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
  const apps = await accessOpHuisdokter().catch(function (e) { return ['(niet leesbaar: ' + e.message + ')']; });
  if (apps.length) fout++;
  console.log((apps.length ? 'ROOD  ' : 'GROEN ') + 'geen Access-app op huisdokter.dev' + (apps.length ? ' [' + apps.join('; ') + ']' : ''));
  console.log(fout ? fout + ' ROOD' : 'TOETS GROEN');
  return fout;
}

(async function () {
  const stap = process.argv[2] || 'toets';
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
    if (stap !== 'inrichten') throw new Error('onbekende stap ' + stap + ' (toets | ingress | inrichten)');
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
