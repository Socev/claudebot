'use strict';
/*
 * brain-web.js — Chrome-extensie "Naar Second Brain": een webpagina als markdown naar OVIS Intake (wv2660, 7-11-2026).
 * Ontwerp + review (codex, 4 MOET verwerkt): vault "01_Ontwikkeling/Chrome-extensie Naar Second Brain - pagina als markdown via Intake
 * (ontwerp 7-11-2026).md".
 *
 * WAAROM. David 7-11 15:40: "Ik wil een pagina naar Markdown converten, en die markdown laten landen in de Raw_input van Brain." De
 * extensie leest op zijn rechtsklik de pagina zoals hij hem ziet (DOM, ook achter zijn eigen inlog) of alleen het adres (rechtsklik op een
 * link); de app (zijn sessie + apparaatbinding) stuurt het hierheen. Deze module zet het om naar markdown en levert het als eigen bron
 * (webpagina@1, web:david) aan bij OVIS Intake; de router doet patiëntcontrole, Jev en de plek (alleen de kennislens).
 *
 * ROUTE  POST /app/brain/webpagina  { url, titel?, html? }  → 201 { ok, uitkomst: 'ontvangen'|'dubbel', titel, stuk_id, tekens, ... }
 *   html aanwezig = de pagina uit het tabblad (wijze 'pagina'); zonder html = een link: de pod haalt hem zelf op (o.haal, met SSRF-slot in
 *   brain-web-io.js), nooit via een derde (review MOET 1).
 * GRENZEN  url http(s) ≤ 2048 zonder inlog in het adres; html ≤ HTML_MAX tekens; markdown ≥ 40 tekens tekst; de HELE hoofdtekst (kop +
 *   pagina + inkortregel) ≤ HOOFD_MAX bytes (review MOET 4). Geheimenpoort op markdown, titel én adres (review MOET 2): sleutelvormen →
 *   "[sleutel weggelaten]", gevoelige queryparameters → "[weggelaten]"; alleen het aantal gaat mee in de meta.
 * VORM. Alleen crypto (CI-poort in test/brain-web.sh). Omzetten (pandoc), ophalen en de aanlevering komen via maak({...}).
 */
const crypto = require('crypto');

const URL_MAX = 2048, TITEL_MAX = 300;
const HTML_MAX = 2 * 1024 * 1024;           // tekens html uit het tabblad (de extensie houdt dezelfde grens aan)
const HOOFD_MAX = 1000 * 1000;              // bytes van de hele hoofdtekst; Intake staat inline 1 MiB toe
const TEKST_MIN = 40;                       // tekens zonder witruimte
const INKORT = '\n\n_(ingekort: de pagina was groter dan 1 MB; het begin staat hierboven)_\n';

// Sleutelvormen (grondwet 2). Breder dan DOORGEEF_GEHEIM in server.js: webpagina's tonen soms een eigen dashboard of documentatie.
const GEHEIM = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /\b(sk|rk|pk)_live_[A-Za-z0-9]{16,}/g,
  /\bwhsec_[A-Za-z0-9]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /sbp_[a-f0-9]{40}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];
const GEVOELIG_PARAM = /^(access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth|authorization|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|pass|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|code|session|sessionid|sid|jwt|otp)$/i;

function geheimen(t) {
  let n = 0, s = String(t == null ? '' : t);
  for (const re of GEHEIM) s = s.replace(re, function () { n++; return '[sleutel weggelaten]'; });
  return { tekst: s, n };
}

// → { url (zonder #fragment, gevoelige parameters weggelaten), domein, n } of { fout }
function adresSchoon(ruw, link) {
  const t = String(ruw == null ? '' : ruw).trim();
  if (!t || t.length > URL_MAX) return { fout: 'adres ontbreekt of is te lang' };
  let u;
  try { u = new URL(t); } catch (e) { return { fout: 'geen geldig adres' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { fout: 'alleen http- en https-pagina’s' };
  if (u.username || u.password) return { fout: 'een adres met een inlognaam of wachtwoord erin neem ik niet over' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || !/^[a-z0-9.-]{1,253}$/.test(host) && !/^\[[0-9a-f:.]+\]$/.test(host)) return { fout: 'onbekende hostnaam' };
  if (link) {   // de pod haalt het zelf op: geen interne of eigen adressen (het SSRF-slot in brain-web-io.js meet daarna nog het IP-adres)
    if (/^\[|^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return { fout: 'een link naar een IP-adres haal ik niet op; open de pagina en klik op de pagina zelf' };
    if (host === 'localhost' || /\.(localhost|local|internal|lan|home|arpa|intranet|corp)$/.test(host) || !host.includes('.')) return { fout: 'een intern adres haal ik niet op' };
    if (/(^|\.)(socev\.dev|olares\.com|olares\.cn)$/.test(host)) return { fout: 'een adres van Socev zelf haal ik niet op' };
    if (u.port && u.port !== '80' && u.port !== '443') return { fout: 'alleen de gewone poorten (80 en 443)' };
  }
  u.hash = '';
  let n = 0;
  for (const k of Array.from(u.searchParams.keys())) if (GEVOELIG_PARAM.test(k)) { u.searchParams.set(k, '[weggelaten]'); n++; }
  const g = geheimen(u.toString());
  return { url: g.tekst.replace(/%5Bweggelaten%5D/g, '[weggelaten]'), domein: host.replace(/^www\./, ''), n: n + g.n };
}

// Wat pandoc teruggeeft, schoon: data:-beelden en lege beelden weg, geen stuurtekens, lege regels samengevouwen.
function schoonMarkdown(md) {
  return String(md == null ? '' : md)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/!\[[^\]\n]*\]\(\s*(data|blob|javascript):[^)]*\)/gi, '')
    .replace(/\[([^\]\n]*)\]\(\s*(javascript|data|blob|vbscript):[^)]*\)/gi, '$1')
    .replace(/!\[\]\(\s*\)/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function zonderWit(t) { return String(t || '').replace(/\s+/g, '').length; }
function yv(v) { return JSON.stringify(v == null ? '' : String(v)); }
function eenRegel(t, max) { return String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max); }
// Bytes afkappen op een tekengrens
function knipBytes(s, max) {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= max) return s;
  let e = max;
  while (e > 0 && (b[e] & 0xc0) === 0x80) e--;
  return b.subarray(0, e).toString('utf8');
}
function slug(t, max) {
  return String(t || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
}
// Nederlandse datum + uumm voor de (overgangs)bestandsnaam
function nlStempel(ms) {
  const d = new Date(ms);
  const f = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = {}; for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return p.year + '-' + p.month + '-' + p.day + '_' + p.hour + p.minute;
}

/*
 * De hoofdtekst: frontmatter (zodat het bestand ook los een nette bron is) + '# titel' + de pagina, samen ≤ HOOFD_MAX bytes.
 * → { tekst, ingekort }
 */
function hoofdtekst(x) {
  const kop = ['---', 'titel: ' + yv(x.titel), 'bron_url: ' + yv(x.url), 'opgehaald_op: ' + yv(x.opgehaald_op), 'soort: "webpagina"',
    'wijze: ' + yv(x.wijze), 'via: "Chrome-extensie Naar Second Brain (OVIS Intake)"', '---', '', '# ' + x.titel, '', ''].join('\n');
  const vol = kop + x.markdown + '\n';
  if (Buffer.byteLength(vol, 'utf8') <= HOOFD_MAX) return { tekst: vol, ingekort: false };
  const ruimte = HOOFD_MAX - Buffer.byteLength(kop, 'utf8') - Buffer.byteLength(INKORT, 'utf8');
  return { tekst: kop + knipBytes(x.markdown, Math.max(0, ruimte)).replace(/\s+$/, '') + INKORT, ingekort: true };
}

/*
 * o = { pandoc(html) → Promise<string|null>, haal(url) → Promise<{ ok, html?, url?, fout? }>, lever(env) → Promise<antwoord van leverIntern>,
 *       live() → bool (router.json live web:david), nu() → ms, fout(waar, e) }
 */
function maak(o) {
  const nu = o.nu || Date.now;
  async function verwerk(d) {
    d = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    const weiger = (status, fout, extra) => ({ status, j: Object.assign({ ok: false, fout }, extra || {}) });
    if (!o.live || !o.live()) return weiger(503, 'Naar Second Brain staat nu uit in OVIS Intake; er is niets opgeslagen.');
    const heeftHtml = typeof d.html === 'string' && d.html.length > 0;
    if (d.html != null && typeof d.html !== 'string') return weiger(400, 'de pagina kwam niet goed door; probeer het opnieuw');
    if (heeftHtml && d.html.length > HTML_MAX) return weiger(413, 'deze pagina is te groot (meer dan 2 MB html)');
    const a = adresSchoon(d.url, !heeftHtml);
    if (a.fout) return weiger(400, a.fout);
    let html = heeftHtml ? d.html : null, wijze = heeftHtml ? 'pagina' : 'link', adres = a;
    if (!heeftHtml) {
      let h = null;
      try { h = await o.haal(a.url); } catch (e) { h = null; if (o.fout) o.fout('brain-web-haal', e); }
      if (!h || !h.ok) return weiger(502, 'de pagina achter de link kon ik niet ophalen' + (h && h.fout ? ' (' + h.fout + ')' : '') + '; open hem en klik op de pagina zelf');
      if (typeof h.html !== 'string' || h.html.length > HTML_MAX) return weiger(413, 'de pagina achter de link is te groot');
      html = h.html;
      if (h.url && h.url !== a.url) { const b = adresSchoon(h.url, true); if (!b.fout) adres = { url: b.url, domein: b.domein, n: a.n + b.n }; }
    }
    let md = null;
    try { md = await o.pandoc(html); } catch (e) { md = null; if (o.fout) o.fout('brain-web-pandoc', e); }
    if (typeof md !== 'string') return weiger(502, 'omzetten naar markdown lukte niet; probeer het nog een keer');
    md = schoonMarkdown(md);
    if (zonderWit(md) < TEKST_MIN) return weiger(422, 'op deze pagina vond ik (bijna) geen tekst');
    const titelRuw = eenRegel(d.titel, TITEL_MAX) || eenRegel((html.match(/<title[^>]*>([^<]{1,600})<\/title>/i) || [])[1], TITEL_MAX) || adres.domein;
    const gt = geheimen(titelRuw), gm = geheimen(md);
    const titel = eenRegel(gt.tekst, TITEL_MAX) || adres.domein;
    const sleutels = adres.n + gt.n + gm.n;
    const opgehaald = new Date(nu()).toISOString();
    const ht = hoofdtekst({ titel, url: adres.url, opgehaald_op: opgehaald, wijze, markdown: gm.tekst });
    const buf = Buffer.from(ht.tekst, 'utf8');
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    // dubbel = zelfde adres + zelfde pagina-inhoud (niet de kop: daarin staat het tijdstip)
    const bronId = crypto.createHash('sha256').update('web|' + adres.url + '|' + crypto.createHash('sha256').update(gm.tekst).digest('hex')).digest('hex').slice(0, 24);
    const naam = nlStempel(nu()) + '_web_' + (slug(titel, 80) || slug(adres.domein, 80) || 'pagina') + '.md';
    const env = { protocol: 'ovis-intake/1', profiel: 'webpagina@1', bron: 'web:david', bron_id: bronId, ontvangen: opgehaald,
      meta: { onderwerp: titel, url: adres.url, domein: adres.domein.slice(0, 253), opgehaald_op: opgehaald, wijze, sleutels_weggelaten: sleutels, ingekort: ht.ingekort },
      onderdelen: [{ deel: 'p1', rol: 'hoofdtekst', naam, mime: 'text/markdown', grootte: buf.length, sha256: sha, tekst: ht.tekst }],
      overgang: { stand: 'om', bestandsnaam: naam },
      aanlevering: { workflow: 'pod:brain-web', knoop: 'brain-web.js' } };
    let r = null;
    try { r = await o.lever(env); } catch (e) { r = null; if (o.fout) o.fout('brain-web-intake', e); }
    if (!r) return weiger(503, 'OVIS Intake nam de pagina nu niet aan; probeer het zo nog eens');
    const basis = { titel, stuk_id: r.stuk_id || null, tekens: gm.tekst.length, wijze, sleutels_weggelaten: sleutels || undefined, ingekort: ht.ingekort || undefined };
    if (r.ok && r.uitkomst === 'dubbel') return { status: 200, j: Object.assign({ ok: true, uitkomst: 'dubbel' }, basis) };
    if (r.ok) return { status: 201, j: Object.assign({ ok: true, uitkomst: 'ontvangen' }, basis) };
    return weiger(r.http === 429 || r.http === 503 || r.http === 507 ? 503 : 502, 'OVIS Intake weigerde de pagina (' + String(r.reden || 'onbekend').slice(0, 60) + ')');
  }
  return { verwerk };
}

module.exports = { maak, K: { geheimen, adresSchoon, schoonMarkdown, hoofdtekst, knipBytes, slug, nlStempel, HOOFD_MAX, HTML_MAX } };
