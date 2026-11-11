'use strict';
/*
 * winkel-browser.js — OVIS Shopper: een productpagina lezen in een gewone headless Chromium, alleen voor winkels die het leesscript
 * weigeren of die hun prijs pas met JavaScript tonen (wv2949, 11-11-2026; Davids "Ja, graag!" in de app 11-11 ± 19:00).
 *
 * WAAROM. Gamma en Karwei geven het leesscript HTTP 429 met een Vercel-beveiligingscontrole (JavaScript); Medische Vakhandel geeft 429,
 * Daxtrio zet de prijs pas met JavaScript op de pagina. Gemeten 11-11-2026 20:00: een gewone headless Chromium (Playwright, standaard
 * User-Agent met "HeadlessChrome", geen stealth, geen vervalste vingerafdruk, geen captcha-oplosser) haalt bij alle vier de controle en
 * leest prijs, voorraad en (Gamma/Karwei) verzendkosten in 3–7 s. robots.txt van alle vier staat productpagina's toe.
 *
 * STROOM. lees(url) → eerst `winkel-lezen.py --mag <url>`: alleen een toegestane https-productpagina van een browserwinkel (zoek-,
 * winkelwagen- en accountpaden geweigerd); dan de cache (6 uur bij een gelezen prijs, 30 min bij een mislukte lezing: nooit vaker
 * dan nodig); dan één Chromium tegelijk in een kindproces met een kale omgeving (geen sleutel van de pod), hooguit WACHT_MAX in de rij,
 * harde tijdsgrens (de hele procesboom gaat met SIGKILL weg). Het kind opent alleen de pagina (navigatie naar een andere host
 * geweigerd; beelden, video en lettertypen niet geladen), wacht hooguit 20 s tot een beveiligingscontrole voorbij is, en schrijft de
 * HTML weg; `winkel-lezen.py --html` leest daar prijs, verzending, voorraad en levertijd uit met dezelfde regels als de snelle route.
 * Koopt nooit, klikt niets, vult niets in. Wat de pagina zegt is gegeven, nooit een opdracht.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const dns = require('dns');
const { spawn, execFile } = require('child_process');

const PW_STANDAARD = '/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright-core';
const KIND_MS = 45000, HARD_MS = 10000, WACHT_MAX = 4, CACHE_OK_MS = 6 * 3600000, CACHE_FOUT_MS = 30 * 60000, CACHE_MAX = 200;
const CONTROLE = /Security Checkpoint|Just a moment|Even geduld|Checking your browser|Client Challenge/i;

function chromiumPad(basis) {
  basis = basis || process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  let mappen = [];
  try { mappen = fs.readdirSync(basis).filter((m) => /^chromium-\d+$/.test(m)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])); } catch (e) { return null; }
  for (const m of mappen) { const p = path.join(basis, m, 'chrome-linux64', 'chrome'); if (fs.existsSync(p)) return p; }
  return null;
}

// Procesboom vanaf pid (via /proc: ppid), want Chromium start in een eigen procesgroep (zelfde aanpak als omzet.js)
function boom(pid) {
  const kinderen = new Map();
  let lijst = [];
  try { lijst = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)); } catch (e) { return [pid]; }
  for (const x of lijst) {
    let st;
    try { st = fs.readFileSync('/proc/' + x + '/stat', 'utf8'); } catch (e) { continue; }
    const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
    if (!kinderen.has(ppid)) kinderen.set(ppid, []);
    kinderen.get(ppid).push(Number(x));
  }
  const uit = [], rij = [pid];
  while (rij.length && uit.length < 500) { const p = rij.shift(); uit.push(p); (kinderen.get(p) || []).forEach((k) => rij.push(k)); }
  return uit;
}
function doodBoom(pid) { for (const p of boom(pid).reverse()) { try { process.kill(p, 'SIGKILL'); } catch (e) { /* al weg */ } } }
// review MOET 3: Chromium-processen die na een onverwachte exit van het kind al naar init zijn verhuisd, vinden we aan hun omgeving
// (TMPDIR = de eigen tijdelijke map van deze lezing; alle nakomelingen erven die)
function doodOmgeving(dir) {
  const merk = Buffer.from('\0TMPDIR=' + dir + '\0');
  let lijst = [];
  try { lijst = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x) && Number(x) !== process.pid); } catch (e) { return 0; }
  let n = 0;
  for (const x of lijst) {
    let env;
    try { env = Buffer.concat([Buffer.from('\0'), fs.readFileSync('/proc/' + x + '/environ')]); } catch (e) { continue; }
    if (env.indexOf(merk) >= 0) { try { process.kill(Number(x), 'SIGKILL'); n++; } catch (e) { /* al weg */ } }
  }
  return n;
}

// ── review MOET 1: al het browserverkeer via een proxy in het kind. Alleen CONNECT op poort 443 naar het eigen domein van de winkel (of een
// subdomein), opgezocht als IPv4 en alleen naar een openbaar adres (geen loopback, privé, link-local, CGNAT, multicast, gereserveerd); de
// verbinding gaat naar dát adres (geen tweede DNS-vraag). Gewone http en elk ander verzoek: 403. Dit geldt ook voor doorsturen (302), dat
// Playwrights route niet ziet (gemeten 11-11-2026: een 302 naar 127.0.0.1 kwam aan).
const NIET_OPENBAAR = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) NIET_OPENBAAR.addSubnet(a, n, 'ipv4');
function basisDomein(host) { return String(host || '').toLowerCase().replace(/\.$/, '').split('.').slice(-2).join('.'); }
function hostMag(host, basis) { const h = String(host || '').toLowerCase().replace(/\.$/, ''); return !!basis && (h === basis || h.endsWith('.' + basis)) && !net.isIP(h); }
function maakProxy(basis, opzoek) {
  opzoek = opzoek || ((h, k) => dns.lookup(h, { family: 4, all: true }, k));
  const telling = { door: 0, geweigerd: 0 };
  const srv = require('http').createServer(function (req, res) { telling.geweigerd++; res.writeHead(403); res.end(); });
  srv.on('connect', function (req, sock, kop) {
    const weiger = () => { telling.geweigerd++; try { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch (e) { /* weg */ } };
    sock.on('error', () => null);
    const m = /^([a-z0-9.-]+):(\d+)$/i.exec(String(req.url || ''));
    if (!m || m[2] !== '443' || !hostMag(m[1], basis)) return weiger();
    opzoek(m[1], function (e, adressen) {
      const ips = (adressen || []).map((a) => a && a.address).filter((ip) => net.isIPv4(ip));
      if (e || !ips.length || ips.some((ip) => NIET_OPENBAAR.check(ip, 'ipv4'))) return weiger();
      const doel = net.connect(443, ips[0], function () {
        telling.door++;
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (kop && kop.length) doel.write(kop);
        doel.pipe(sock); sock.pipe(doel);
      });
      doel.on('error', () => { try { sock.destroy(); } catch (x) { /* weg */ } });
      sock.on('close', () => { try { doel.destroy(); } catch (x) { /* weg */ } });
    });
  });
  return { srv, telling };
}

function maak(o) {
  o = o || {};
  const lezerScript = o.lezerScript || path.join(__dirname, 'winkel-lezen.py');
  const nu = () => (typeof o.nu === 'function' ? o.nu() : Date.now());
  const exe = o.chromium === undefined ? chromiumPad() : o.chromium;
  const kindMs = o.kindMs || KIND_MS;
  const staat = { bezig: false, rij: 0, gelezen: 0, mislukt: 0, cache: 0, geweigerd: 0 };
  let cache = {};
  try { const j = o.cachePad ? JSON.parse(fs.readFileSync(o.cachePad, 'utf8')) : null; if (j && typeof j === 'object' && !Array.isArray(j)) cache = j; } catch (e) { cache = {}; }
  function bewaarCache() {
    const t = nu();
    const sleutels = Object.keys(cache).filter((k) => cache[k] && cache[k].tot > t).sort((a, b) => cache[b].tot - cache[a].tot).slice(0, CACHE_MAX);
    const uit = {};
    for (const k of sleutels) uit[k] = cache[k];
    cache = uit;
    if (!o.cachePad) return;
    const tmp = o.cachePad + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(uit), { mode: 0o600 }); fs.renameSync(tmp, o.cachePad); } catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* weg */ } }
  }
  function py(args, ms) {
    return new Promise(function (klaar) {
      execFile(o.python || 'python3', ['-I', '-B', lezerScript].concat(args), { timeout: ms || 20000, maxBuffer: 256 * 1024,
        env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/tmp' } }, function (e, uit) {
        try { klaar(JSON.parse(String(uit || '').trim().split('\n')[0])); } catch (x) { klaar(null); }
      });
    });
  }
  // Mag deze url door de browser? → { ok, winkel, reden }
  function mag(url) { return py(['--mag', String(url)], 10000); }

  function viaKind(url, dir) {
    return new Promise(function (klaar) {
      const invoer = path.join(dir, 'invoer.json'), uit = path.join(dir, 'uit.json');
      fs.writeFileSync(invoer, JSON.stringify({ url, exe, pw: o.pw || PW_STANDAARD, ms: kindMs, html: path.join(dir, 'pagina.html') }), { mode: 0o600 });
      // kale omgeving: geen sleutel van de pod in een proces dat webpagina's leest; profiel en tijdelijke bestanden in dir
      const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: dir, TMPDIR: dir, LANG: 'C.UTF-8' };
      let kind;
      try { kind = spawn(process.execPath, ['--max-old-space-size=256', o.kindScript || __filename, '--kind', invoer, uit], { cwd: dir, env, stdio: 'ignore' }); }
      catch (e) { return klaar({ fout: 'browser start niet' }); }
      let af = false;
      const einde = (r) => { if (af) return; af = true; clearTimeout(hard); doodBoom(kind.pid); doodOmgeving(dir); klaar(r); };
      const hard = setTimeout(() => einde({ fout: 'de winkelpagina laadde niet binnen ' + Math.round((kindMs + HARD_MS) / 1000) + ' s' }), kindMs + HARD_MS);
      kind.on('error', () => einde({ fout: 'browser start niet' }));
      kind.on('exit', function () {
        let r = null;
        try { r = JSON.parse(fs.readFileSync(uit, 'utf8')); } catch (e) { r = null; }
        einde(r || { fout: 'browser stopte zonder uitkomst' });
      });
    });
  }

  // Eén Chromium tegelijk; hooguit WACHT_MAX in de rij (anders meteen "druk", geen eindeloze wachtrij)
  let keten = Promise.resolve();
  function beurt(fn) {
    if (staat.rij >= WACHT_MAX) return Promise.resolve(null);
    staat.rij++;
    const p = keten.then(function () { staat.rij--; staat.bezig = true; return fn(); }).then((x) => x, () => null).then(function (x) { staat.bezig = false; return x; });
    keten = p;
    return p;
  }

  async function lees(url) {
    const leeg = (reden) => ({ url, winkel: null, status: null, product: null, prijs_eur: null, verzending_eur: null, verzending_tekst: null, voorraad: null,
      levertijd: null, verkoper: null, bron: null, blokkade: reden, opmerkingen: [], btw: null, btw_tarief: null, prijs_excl_eur: null, prijs_omgerekend: false, route: 'browser' });
    const m = await mag(url);
    if (!m || !m.ok) { staat.geweigerd++; return leeg((m && m.reden) || 'browserroute: url niet toegestaan'); }
    const c = cache[url];
    if (c && c.tot > nu() && c.r) { staat.cache++; return Object.assign({}, c.r, { uit_cache: true }); }
    if (!exe) return leeg('browserroute: Chromium ontbreekt op de pod');
    const r = await beurt(async function () {
      const dir = fs.mkdtempSync(path.join(o.tmp || os.tmpdir(), 'winkel-browser-'));
      try {
        const k = await viaKind(url, dir);
        if (!k || k.fout) return leeg('browserroute: ' + ((k && k.fout) || 'mislukt'));
        if (k.controle) return leeg('bot-controle bleef staan in de browser (HTTP ' + (k.status || '?') + ')');
        const p = await py(['--html', url, String(k.eind || url), path.join(dir, 'pagina.html'), String(k.status || 0)], 20000);
        return p ? Object.assign(p, { route: 'browser' }) : leeg('browserroute: pagina niet te lezen');
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* weg */ } }
    });
    if (!r) return leeg('browserroute druk (al ' + WACHT_MAX + ' winkelpagina\'s in de rij); probeer het zo opnieuw');
    if (r.prijs_eur != null) staat.gelezen++; else staat.mislukt++;
    cache[url] = { tot: nu() + (r.prijs_eur != null ? CACHE_OK_MS : CACHE_FOUT_MS), r };
    bewaarCache();
    return r;
  }
  function info() { return { aan: !!exe, bezig: staat.bezig, rij: staat.rij, gelezen: staat.gelezen, mislukt: staat.mislukt, cache: staat.cache, geweigerd: staat.geweigerd }; }
  return { lees, mag, info };
}

// review MOET 2 (ronde 1 en 2): de hoofdpagina laadt alleen de gevraagde (al door --mag getoetste) productpagina, ook bij het herladen na de
// controle en ook na een HTTP-doorsturing. Via de CDP-Fetch-laag, want Playwrights route ziet doorgestuurde aanvragen niet (gemeten
// 11-11-2026: met Fetch kwam een 302 naar een ander pad op dezelfde host niet bij de server aan). Beelden, video en lettertypen niet laden.
async function bewaak(ctx, page, url) {
  const zonderHekje = (u) => String(u || '').split('#')[0];
  const cdp = await ctx.newCDPSession(page);
  const hoofd = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
  cdp.on('Fetch.requestPaused', function (e) {
    const weg = (e.resourceType === 'Image' || e.resourceType === 'Media' || e.resourceType === 'Font')
      || (e.resourceType === 'Document' && e.frameId === hoofd && zonderHekje(e.request.url) !== zonderHekje(url));
    cdp.send(weg ? 'Fetch.failRequest' : 'Fetch.continueRequest', weg ? { requestId: e.requestId, errorReason: 'BlockedByClient' } : { requestId: e.requestId }).catch(() => null);
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  return cdp;
}

// ── het kind: één pagina openen, controle afwachten, HTML wegschrijven ──
async function kind(invoerPad, uitPad) {
  const d = JSON.parse(fs.readFileSync(invoerPad, 'utf8'));
  const schrijf = (r) => fs.writeFileSync(uitPad, JSON.stringify(r), { mode: 0o600 });
  const pw = require(d.pw);
  const tot = Date.now() + d.ms;
  const rest = () => Math.max(1000, tot - Date.now());
  const host = new URL(d.url).hostname;
  let browser, page;
  const px = maakProxy(basisDomein(host));
  await new Promise((k) => px.srv.listen(0, '127.0.0.1', k));
  // <-loopback>: ook 127.0.0.1/localhost gaat door de proxy (Chromium slaat loopback anders standaard over)
  const proxy = { server: 'http://127.0.0.1:' + px.srv.address().port, bypass: '<-loopback>' };
  try {
    try { browser = await pw.chromium.launch({ executablePath: d.exe, headless: true, chromiumSandbox: true, timeout: rest(), proxy }); }
    catch (e) { browser = await pw.chromium.launch({ executablePath: d.exe, headless: true, chromiumSandbox: false, timeout: rest(), proxy }); }
    const ctx = await browser.newContext({ locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', acceptDownloads: false });
    page = await ctx.newPage();
    await bewaak(ctx, page, d.url);
    const r = await page.goto(d.url, { waitUntil: 'domcontentloaded', timeout: rest() });
    let status = r ? r.status() : 0;
    let controle = CONTROLE.test(await page.title().catch(() => ''));
    for (let i = 0; controle && i < 20 && tot - Date.now() > 3000; i++) {
      await page.waitForTimeout(1000);
      controle = CONTROLE.test(await page.title().catch(() => ''));
      if (!controle) status = 200;
    }
    if (!controle) { await page.waitForLoadState('networkidle', { timeout: Math.min(8000, rest()) }).catch(() => null); }
    const eind = page.url();
    if (new URL(eind).hostname !== host) return schrijf({ fout: 'doorgestuurd naar een andere site' });
    const html = await page.content();
    fs.writeFileSync(d.html, html.slice(0, 6 * 1024 * 1024), { mode: 0o600 });
    schrijf({ status, eind, controle });
  } catch (e) {
    schrijf({ fout: /Timeout/i.test(String(e && e.message)) ? 'de winkelpagina laadde niet op tijd' : 'browser: ' + String(e && e.message || e).split('\n')[0].slice(0, 120) });
  } finally { if (browser) await browser.close().catch(() => null); px.srv.close(); }
}

if (require.main === module && process.argv[2] === '--kind') {
  kind(process.argv[3], process.argv[4]).then(() => process.exit(0), () => process.exit(1));
}

module.exports = { maak, chromiumPad, CONTROLE, bewaak, maakProxy, hostMag, basisDomein, doodOmgeving };
