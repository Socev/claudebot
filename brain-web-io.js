'use strict';
/*
 * brain-web-io.js — de twee dingen met de buitenwereld voor brain-web.js (wv2660): pandoc (html → markdown, lokaal) en het ophalen van een
 * link die David met de rechtermuisknop aanklikte. Los van brain-web.js zodat die alleen crypto laadt (CI-poort).
 *
 * OPHALEN (review MOET 1: zelf, niet via een derde). SSRF-slot: alleen http/https op poort 80/443; elke DNS-uitkomst moet een publiek adres
 * zijn (geen loopback, privé, link-local, CGNAT, ULA, multicast, gereserveerd; ook niet als IPv4-in-IPv6), gemeten in de lookup van de
 * verbinding zelf (geen tweede DNS-ronde waartussen het adres kan wisselen). Doorverwijzingen hooguit 5, elke stap opnieuw langs het slot.
 * Hooguit HAAL_MAX bytes en HAAL_MS ms; alleen text/html, application/xhtml+xml of text/plain. Geen cookies, geen inlog.
 * PANDOC: --sandbox (geen bestanden of netwerk), html-native_divs-native_spans → gfm-raw_html (geen ruwe html in de uitkomst), stdin.
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { spawn } = require('child_process');

const HAAL_MAX = 4 * 1024 * 1024, HAAL_MS = 25000, OMLEIDING_MAX = 5;
const PANDOC_MS = 30000, PANDOC_UIT_MAX = 6 * 1024 * 1024;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 Socev-NaarSecondBrain/1.0';

function v4Publiek(a) {
  const p = a.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [x, y] = p;
  if (x === 0 || x === 10 || x === 127) return false;
  if (x === 100 && y >= 64 && y <= 127) return false;          // CGNAT
  if (x === 169 && y === 254) return false;                    // link-local (o.a. metadata)
  if (x === 172 && y >= 16 && y <= 31) return false;
  if (x === 192 && y === 168) return false;
  if (x === 192 && y === 0) return false;                      // 192.0.0.0/24 en 192.0.2.0/24
  if (x === 198 && (y === 18 || y === 19)) return false;       // benchmark
  if (x === 198 && y === 51) return false;
  if (x === 203 && y === 0) return false;
  if (x >= 224) return false;                                  // multicast + gereserveerd + broadcast
  return true;
}
function v6Publiek(a) {
  const s = a.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const m = /^(?:0*:)*:?(?:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s) || /^::(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (m) return v4Publiek(m[1]);
  if (s === '::' || s === '::1') return false;
  const eerste = parseInt((s.split(':')[0] || '0'), 16);
  if (Number.isNaN(eerste)) return false;
  if ((eerste & 0xfe00) === 0xfc00) return false;              // ULA fc00::/7
  if ((eerste & 0xffc0) === 0xfe80) return false;              // link-local
  if ((eerste & 0xff00) === 0xff00) return false;              // multicast
  if (eerste === 0x2001 && /^2001:0*db8:/.test(s)) return false;
  if (eerste === 0x64 && /^64:ff9b:/.test(s)) return false;    // NAT64 naar mogelijk privé v4
  if (eerste === 0x2002) return false;                         // 6to4 (kan naar privé v4 wijzen)
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) {        // ::ffff:7f00:1 = 127.0.0.1
    const d = s.split(':'); const h = parseInt(d[3], 16), l = parseInt(d[4], 16);
    return v4Publiek([h >> 8, h & 255, l >> 8, l & 255].join('.'));
  }
  return (eerste & 0xe000) === 0x2000;                         // alleen global unicast 2000::/3
}
function publiek(a) { const f = net.isIP(a); return f === 4 ? v4Publiek(a) : (f === 6 ? v6Publiek(a) : false); }

// lookup voor http(s).request: alleen publieke adressen
function veiligeLookup(host, opties, cb) {
  if (typeof opties === 'function') { cb = opties; opties = {}; }
  dns.lookup(host, Object.assign({}, opties, { all: true }), function (e, lijst) {
    if (e) return cb(e);
    const goed = (lijst || []).filter((x) => publiek(x.address));
    if (!lijst || !lijst.length || goed.length !== lijst.length) { const f = new Error('adres niet publiek'); f.code = 'ENIETPUBLIEK'; return cb(f); }
    if (opties && opties.all) return cb(null, goed);
    return cb(null, goed[0].address, goed[0].family);
  });
}

function eenVerzoek(adres, eind) {
  return new Promise(function (klaar) {
    let u;
    try { u = new URL(adres); } catch (e) { return klaar({ fout: 'geen geldig adres' }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return klaar({ fout: 'alleen http en https' });
    if (u.username || u.password) return klaar({ fout: 'inlog in het adres' });
    if (u.port && u.port !== '80' && u.port !== '443') return klaar({ fout: 'alleen poort 80 en 443' });
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !publiek(host)) return klaar({ fout: 'adres niet publiek' });
    const mod = u.protocol === 'https:' ? https : http;
    let af = false;
    const klaarEen = (x) => { if (!af) { af = true; klaar(x); } };
    const rest = Math.max(1000, eind - Date.now());
    const req = mod.request(u, { method: 'GET', lookup: veiligeLookup, agent: false, timeout: rest,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain;q=0.8', 'accept-language': 'nl,en;q=0.8', 'accept-encoding': 'identity' } }, function (res) {
      const st = res.statusCode || 0;
      if (st >= 300 && st < 400 && res.headers.location) { res.resume(); return klaarEen({ naar: new URL(res.headers.location, u).toString() }); }
      if (st !== 200) { res.resume(); return klaarEen({ fout: 'de site gaf ' + st }); }
      const ct = String(res.headers['content-type'] || '').toLowerCase();
      if (!/^(text\/html|application\/xhtml\+xml|text\/plain)\b/.test(ct)) { res.resume(); return klaarEen({ fout: 'geen webpagina (' + ct.split(';')[0].slice(0, 40) + ')' }); }
      const stukken = []; let n = 0;
      res.on('data', function (c) { n += c.length; if (n > HAAL_MAX) { req.destroy(); return klaarEen({ fout: 'te groot' }); } stukken.push(c); });
      res.on('end', function () {
        const buf = Buffer.concat(stukken);
        let cs = (/charset=([A-Za-z0-9_-]{1,40})/.exec(ct) || [])[1];
        if (!cs) cs = (/<meta[^>]{0,200}charset=["']?([A-Za-z0-9_-]{1,40})/i.exec(buf.subarray(0, 4096).toString('latin1')) || [])[1];
        let t;
        try { t = new TextDecoder(cs || 'utf-8').decode(buf); } catch (e) { t = buf.toString('utf8'); }
        if (/^text\/plain/.test(ct)) t = '<pre>' + t.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>';
        klaarEen({ ok: true, html: t, url: u.toString() });
      });
      res.on('error', function () { klaarEen({ fout: 'afgebroken' }); });
    });
    req.on('timeout', function () { req.destroy(); klaarEen({ fout: 'te traag' }); });
    req.on('error', function (e) { klaarEen({ fout: e && e.code === 'ENIETPUBLIEK' ? 'adres niet publiek' : 'niet bereikbaar' }); });
    req.end();
  });
}
// → { ok, html, url } | { ok: false, fout }
async function haal(adres) {
  const eind = Date.now() + HAAL_MS;
  let a = adres;
  for (let i = 0; i <= OMLEIDING_MAX; i++) {
    if (Date.now() > eind) return { ok: false, fout: 'te traag' };
    const r = await eenVerzoek(a, eind);
    if (r.naar) { a = r.naar; continue; }
    if (r.ok) return r;
    return { ok: false, fout: r.fout || 'onbekend' };
  }
  return { ok: false, fout: 'te veel doorverwijzingen' };
}

// html → gfm via pandoc op stdin. → string of null
function pandoc(html, opt) {
  opt = opt || {};
  return new Promise(function (klaar) {
    let k, af = false, n = 0;
    const uit = [];
    const eind = (t) => { if (!af) { af = true; klaar(t); } };
    try {
      k = spawn(opt.bin || 'pandoc', ['--sandbox', '-f', 'html-native_divs-native_spans', '-t', 'gfm-raw_html', '--wrap=none'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) { return eind(null); }
    const tm = setTimeout(function () { try { k.kill('SIGKILL'); } catch (e) {} eind(null); }, opt.ms || PANDOC_MS);
    k.stdout.on('data', function (c) { n += c.length; if (n > PANDOC_UIT_MAX) { try { k.kill('SIGKILL'); } catch (e) {} clearTimeout(tm); return eind(null); } uit.push(c); });
    k.on('error', function () { clearTimeout(tm); eind(null); });
    k.on('close', function (code) { clearTimeout(tm); eind(code === 0 ? Buffer.concat(uit).toString('utf8') : null); });
    k.stdin.on('error', function () { /* pandoc stopte vroeg: close geeft de uitkomst */ });
    k.stdin.end(String(html), 'utf8');
  });
}

module.exports = { haal, pandoc, K: { publiek, v4Publiek, v6Publiek, veiligeLookup, eenVerzoek } };
