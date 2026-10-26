'use strict';
// Second Brain (wv832, 22/23-10-2026; bouwplan "01_Ontwikkeling/Second Brain - Obsidian-browser in de app (bouwplan 22-10-2026).md").
// WAAROM. David (22-10 ± 23:00): "dat je kan klikken op een betaling en dat je dan naar de Obsidian Browser gaat … (App: "Second Brain",
// met in Overzicht die mooie 3d-view van alle bestanden)". De vault was alleen in Obsidian op de laptop te lezen; deze module geeft de
// App een kaart (pad, domein, datum, links; geen inhoud), één pagina met opgeloste wikilinks en backlinks, een bestand voor de lezer,
// en zoeken. Voert idee 17b (vaultkaart) uit.
//
// Privacy (bouwplan § 4, Fable-review vooraf § 11):
// - P2 op een apparaat met een vaste plek bestaan 20_Prive, 30_Conversaties, personeelsmappen, 00_Systeem/Meldingen en de 0b-werkmap
//   niet: niet in de kaart, niet te openen, niet in zoeken, ook niet via een link of backlink (Fable M5).
// - P3 nooit: punt-mappen, node_modules, Beveiliging, Tokens, Vault-RAG, TempFinData, Claude outputs, 0b-werkmap, Drive-conflictkopieën,
//   symlinks, geen gewoon bestand, > 20 MB, en elke extensie die de App niet veilig toont (code, html, svg; Fable M1/M2).
// - P4 standaard verborgen (Bronnen, raw_input, _INBOX, 30_Conversaties): alleen uit de kaart en de zoeklijst, via een link te openen.
// - P5 elke tekst die de module teruggeeft gaat door masker() (secretpoort-patronen + kale tokens; op een vaste plek ook IBAN/BSN).
// - P7 openen alleen als het pad in de kaart staat (en voor dit apparaat mag), daarna realpath binnen de vault en lstat geen symlink.
// - P8 de module geeft per verzoek een audit {domein, h} terug: een HMAC van het pad, nooit het pad zelf.
// Alles alleen lezen; de module schrijft alleen zijn eigen kaart.json (0600) in dir, buiten de vault.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KAART_VERS_MS = 120000;       // ouder = opnieuw bouwen bij de volgende vraag
const MAX_MD = 2 * 1024 * 1024;
const MAX_BESTAND = 20 * 1024 * 1024;
const MAX_TREFFERS = 40, FRAGMENT = 160, ZOEK_MS = 4000, MAX_Q = 200;

const NOOIT_MAP = ['00_Systeem/Beveiliging', '01_Ontwikkeling/Beveiliging', '00_Systeem/Tokens', '00_Systeem/Vault-RAG', 'TempFinData', 'Claude outputs', '01_Ontwikkeling/0b-werkmap'];
const VAST_DICHT_TOP = ['20_Prive', '30_Conversaties'];
const VAST_DICHT_DEEL = ['medewerkers', 'personeel', 'gesprekken'];
const VAST_DICHT_PREFIX = ['00_Systeem/Meldingen/', '01_Ontwikkeling/0b-werkmap/'];
const VERBORGEN_DEEL = ['bronnen', 'raw_input', '_inbox'];
const VERBORGEN_TOP = ['30_Conversaties'];

const SOORT = {
  md: 'md', markdown: 'md',
  png: 'beeld', jpg: 'beeld', jpeg: 'beeld', gif: 'beeld', webp: 'beeld',
  pdf: 'pdf',
  doc: 'office', docx: 'office', xls: 'office', xlsx: 'office', ppt: 'office', pptx: 'office', odt: 'office', ods: 'office',
  wav: 'audio', mp3: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', m4a: 'audio', aac: 'audio',
  txt: 'tekst', csv: 'tekst', json: 'tekst', log: 'tekst',
};
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
  txt: 'text/plain', csv: 'text/csv', json: 'application/json', log: 'text/plain', md: 'text/markdown' };

const DOMEIN_TOP = { '00_Systeem': 'Systeem', '01_Ontwikkeling': 'Ontwikkeling', '20_Prive': 'Privé', '30_Conversaties': 'Gesprekken',
  '90_Cijfermeester': 'Cijfer-Meester' };
const DOMEIN_ZAKELIJK = { Tolgaarde: 'Tolgaarde', Groenhouten: 'Groenhouten', HAGRO: 'HAGRO', POT_POH_GGZ: 'POT', DBH: 'DBH', Holding: 'Holding',
  Praktijkhouders_BV: 'Praktijkhouders', Projecten: 'Projecten', _Gedeeld: 'Gedeeld' };
// vaste volgorde (kleur in de App volgt de index)
const DOMEINEN = ['Tolgaarde', 'Groenhouten', 'HAGRO', 'POT', 'DBH', 'Holding', 'Praktijkhouders', 'Projecten', 'Gedeeld', 'Zakelijk overig',
  'Privé', 'Ontwikkeling', 'Systeem', 'Gesprekken', 'Cijfer-Meester', 'Vault', 'Overig'];

// ── masker (P5) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const WEG = '[sleutel weggelaten]';
const heeftLetterEnCijfer = (s) => /[A-Za-z]/.test(s) && /[0-9]/.test(s);
function willekeurig(tok) {
  const stukken = tok.match(/[A-Za-z0-9]{20,}/g) || [];
  return stukken.some(function (x) { return heeftLetterEnCijfer(x) && (x.match(/[A-Za-z](?=[0-9])|[0-9](?=[A-Za-z])/g) || []).length >= 4; });
}
function masker(t, vast, bsnMasker) {
  let s = String(t == null ? '' : t);
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, WEG);
  s = s.replace(/eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*){0,2}/g, WEG);
  s = s.replace(/github_pat_[A-Za-z0-9_]{20,}/gi, WEG);
  s = s.replace(/gh[pousr]_[A-Za-z0-9]{20,}/gi, WEG);
  s = s.replace(/sk-[A-Za-z0-9_-]{20,}/gi, WEG);
  s = s.replace(/xox[baprs]-[A-Za-z0-9-]{6,}/gi, WEG);
  s = s.replace(/[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}/g, WEG);
  s = s.replace(/AIza[0-9A-Za-z_-]{30,}/g, WEG);
  s = s.replace(/ya29\.[0-9A-Za-z_-]{20,}/g, WEG);
  s = s.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, WEG);
  s = s.replace(/hooks\.slack\.com\/services\/[A-Za-z0-9\/_-]+/gi, 'hooks.slack.com/services/' + WEG);
  s = s.replace(/(discord(?:app)?\.com\/api\/webhooks\/)[A-Za-z0-9\/_-]+/gi, function (m, a) { return a + WEG; });
  s = s.replace(/(bearer\s+)([A-Za-z0-9+\/=._-]{16,})/gi, function (m, a) { return a + WEG; });
  s = s.replace(/((?:service_role|anon[_-]?key|api[_-]?key|token|password|passwd|wachtwoord)["'`]?\s*[:=]\s*["'`]?)([^\s"'`]{16,})/gi, function (m, a) { return a + WEG; });
  // naam-route: secret/geheim/sleutel als naamdeel, waarde ≥ 12 tekens met letters én cijfers en geen omgevingsnaam (HOOFDLETTERS_ONDER)
  s = s.replace(/((?<![A-Za-z0-9_.-])["'`]?[A-Za-z0-9_.-]*(?:secret(?!ar)|geheim|sleutel)[A-Za-z0-9_.-]*["'`]?\s*[:=]\s*["'`]?)([^\s"'`]{12,})/gi,
    function (m, a, w) { return heeftLetterEnCijfer(w) && !/^[A-Z0-9_]+$/.test(w) && w.indexOf(WEG) < 0 ? a + WEG : m; });
  // kale tokens (Fable M1): een reeks [A-Za-z0-9_-] met daarin een stuk van 20+ letters/cijfers dat vaak wisselt tussen letter en
  // cijfer (willekeurig, zoals een sleutel of hash); niet direct na een / (pad in een URL) en niet binnen [[ ]]. Namen als
  // `mk_werkvoorraad_tik_wv427` of `n8n-backup-2026-10-22` blijven staan (korte stukken), een UUID ook.
  s = s.replace(/(\[\[[^\]\n]*\]\])|(^|[^A-Za-z0-9_\-\/])([A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/g, function (m, wiki, voor, tok) {
    if (wiki) return wiki;
    return willekeurig(tok) ? voor + WEG : m;
  });
  if (vast) {
    // IBAN, ook in kleine letters en uit andere landen (Fable diffreview K3): landcode, controlegetal, blokken van vier
    s = s.replace(/\b[A-Za-z]{2}[0-9]{2}(?: ?[A-Za-z0-9]{4}){2,7}(?: ?[A-Za-z0-9]{1,4})?\b/g, function (m) { return /[0-9]{6}/.test(m.replace(/ /g, '')) ? '[IBAN weggelaten]' : m; });
    if (typeof bsnMasker === 'function') { try { s = bsnMasker(s); } catch (e) {} }
  }
  return s;
}

// ── paden ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sleutel = (p) => String(p).normalize('NFC').toLowerCase();
const extVan = (n) => (/\.([a-z0-9]+)$/i.exec(n) || [])[1] ? (/\.([a-z0-9]+)$/i.exec(n)[1]).toLowerCase() : '';
function domeinVan(pad) {
  const d = pad.split('/');
  if (d.length === 1) return 'Vault';
  if (d[0] === '10_Zakelijk') return d.length > 2 ? (DOMEIN_ZAKELIJK[d[1]] || 'Zakelijk overig') : 'Zakelijk overig';
  return DOMEIN_TOP[d[0]] || 'Overig';
}
function isVastDicht(pad) {
  const d = pad.split('/');
  if (VAST_DICHT_TOP.indexOf(d[0]) >= 0) return true;
  if (d.slice(0, -1).some(function (x) { return VAST_DICHT_DEEL.indexOf(x.toLowerCase()) >= 0; })) return true;
  return VAST_DICHT_PREFIX.some(function (p) { return pad.indexOf(p) === 0; });
}
function isVerborgen(pad) {
  const d = pad.split('/');
  if (VERBORGEN_TOP.indexOf(d[0]) >= 0) return true;
  return d.slice(0, -1).some(function (x) { return VERBORGEN_DEEL.indexOf(x.toLowerCase()) >= 0; });
}
function nooitMap(rel) {
  return NOOIT_MAP.some(function (m) { return rel === m || rel.indexOf(m + '/') === 0; });
}

// ── links ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Alle linkdoelen in een markdowntekst, buiten codeblokken en inline code. Geeft [{doel, embed, md}] (doel zonder #kop en |tekst).
function linksIn(tekst) {
  const uit = [];
  const regels = String(tekst).split(/\r?\n/);
  let hek = null;
  for (const r of regels) {
    const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(r);
    if (m) {
      if (!hek) hek = m[1][0];
      else if (m[1][0] === hek) hek = null;
      continue;
    }
    if (hek) continue;
    const stukken = r.split(/(`[^`]*`)/);
    for (let i = 0; i < stukken.length; i += 2) {
      const s = stukken[i];
      let w;
      const wr = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
      while ((w = wr.exec(s))) {
        const binnen = w[2].split(/\\?\|/)[0];
        uit.push({ ruw: binnen, doel: binnen.split('#')[0].trim(), embed: w[1] === '!', md: false });
      }
      const mr = /(!?)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
      while ((w = mr.exec(s))) {
        let h = w[2].replace(/^<|>$/g, '');
        if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h[0] === '#') continue;
        try { h = decodeURI(h); } catch (e) {}
        uit.push({ ruw: w[2], doel: h.split('#')[0].trim(), embed: w[1] === '!', md: true });
      }
    }
  }
  return uit;
}

// ── de module ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function maak(opt) {
  const VAULT = opt.vault;
  const DIR = opt.dir;
  const fout = opt.fout || function () {};
  const hmac = opt.hmac || function (s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); };
  const bsnMasker = opt.bsnMasker || null;
  const nu = opt.nu || Date.now;
  let kaart = null;          // { op, duur, bestanden: [{p, d, s, m, g, v, x, l: [idx], k: [[idx…]]}], perPad: Map, perNaam: Map }
  let bouwBezig = null;
  let laatsteHash = null;
  let laatsteNacht = null;
  let bestandBezig = 0, zoekBezig = false, laatsteDwang = 0;
  let echteVault = null;

  function mkdir() {
    try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.chmodSync(DIR, 0o700); } catch (e) { fout('secondbrain-dir', e); }
  }

  function wandel() {
    const lijst = [];
    const stap = function (abs, rel) {
      let items;
      try { items = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
      items.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
      for (const e of items) {
        const naam = e.name;
        if (naam[0] === '.' || naam === 'node_modules') continue;
        const r = rel ? rel + '/' + naam : naam;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (!nooitMap(r)) stap(path.join(abs, naam), r); continue; }
        if (!e.isFile()) continue;
        if (/\.conflict\d*($|\.)/i.test(naam) || /\.conflict/i.test(naam) || /sync-conflict/i.test(naam)) continue;   // wv1378: ook Syncthing-conflictkopieën (review #4)
        const soort = SOORT[extVan(naam)];
        if (!soort) continue;
        let st;
        try { st = fs.lstatSync(path.join(abs, naam)); } catch (e2) { continue; }
        if (!st.isFile() || st.size > MAX_BESTAND) continue;
        lijst.push({ p: r, s: soort, m: Math.floor(st.mtimeMs), g: st.size });
      }
    };
    stap(VAULT, '');
    return lijst;
  }

  function indexeer(bestanden) {
    const perPad = new Map(), perNaam = new Map();
    bestanden.forEach(function (b, i) {
      perPad.set(sleutel(b.p), i);
      if (b.s === 'md') perPad.set(sleutel(b.p.replace(/\.(md|markdown)$/i, '')), i);
      const naam = b.p.split('/').pop();
      const sl = [sleutel(naam)];
      if (b.s === 'md') sl.push(sleutel(naam.replace(/\.(md|markdown)$/i, '')));
      sl.forEach(function (k) { if (!perNaam.has(k)) perNaam.set(k, []); perNaam.get(k).push(i); });
    });
    return { perPad: perPad, perNaam: perNaam };
  }

  // Obsidian-achtig: exact pad (met of zonder .md), relatief pad voor md-links, dan bestandsnaam; bij meer kandidaten eerst de map van
  // de bron, anders dubbelzinnig (Fable K6: geen stille gok). Geeft {i} of {k: [i…]} of null.
  function los(doel, bronPad, md, k) {
    let d = String(doel || '').normalize('NFC').replace(/\\/g, '/').trim();
    if (!d) return null;
    if (d.indexOf('\u0000') >= 0) return null;
    const bronMap = bronPad.indexOf('/') >= 0 ? bronPad.slice(0, bronPad.lastIndexOf('/')) : '';
    const kand = [];
    if (md || /^\.\.?\//.test(d)) {
      const rel = path.posix.normalize((bronMap ? bronMap + '/' : '') + d);
      if (rel.indexOf('..') !== 0) kand.push(rel);
    }
    kand.push(d.replace(/^\/+/, ''));
    for (const c of kand) {
      const i = k.perPad.get(sleutel(c));
      if (i !== undefined) return { i: i };
      const j = k.perPad.get(sleutel(c + '.md'));
      if (j !== undefined) return { i: j };
    }
    const naam = d.split('/').pop();
    let lijst = k.perNaam.get(sleutel(naam)) || [];
    if (d.indexOf('/') >= 0) {   // [[map/naam]] dat niet exact past: op achtervoegsel
      const staart = sleutel('/' + d.replace(/^\/+/, ''));
      lijst = lijst.filter(function (i) { const p = sleutel('/' + k.bestanden[i].p); return p.endsWith(staart) || p.endsWith(staart + '.md'); });
    }
    if (!lijst.length) return null;
    if (lijst.length === 1) return { i: lijst[0] };
    const zelfdeMap = lijst.filter(function (i) { const p = k.bestanden[i].p; return (p.indexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/')) : '') === bronMap; });
    if (zelfdeMap.length === 1) return { i: zelfdeMap[0] };
    return { k: lijst.slice(0, 12) };
  }

  function bouw() {
    const t0 = Date.now();
    const bestanden = wandel();
    bestanden.forEach(function (b) { b.d = domeinVan(b.p); b.v = isVerborgen(b.p); b.x = isVastDicht(b.p); b.l = []; });
    const k = Object.assign({ bestanden: bestanden }, indexeer(bestanden));
    for (let i = 0; i < bestanden.length; i++) {
      const b = bestanden[i];
      if (b.s !== 'md' || b.g > MAX_MD) continue;
      let t;
      try { t = fs.readFileSync(path.join(VAULT, b.p), 'utf8'); } catch (e) { continue; }
      const gezien = new Set();
      for (const l of linksIn(t)) {
        if (!l.doel) continue;
        const r = los(l.doel, b.p, l.md, k);
        if (r && r.i !== undefined && r.i !== i && !gezien.has(r.i)) { gezien.add(r.i); b.l.push(r.i); }
      }
    }
    k.op = nu(); k.duur = Date.now() - t0;
    kaart = k;
    bewaar(k);
    return k;
  }

  function bewaar(k) {
    try {
      const inhoud = JSON.stringify({ versie: 1, gebouwd: new Date(k.op).toISOString(), domeinen: DOMEINEN,
        bestanden: k.bestanden.map(function (b) { return { p: b.p, d: b.d, s: b.s, m: b.m, g: b.g, v: b.v, x: b.x, l: b.l }; }) });
      const h = crypto.createHash('sha256').update(inhoud.replace(/"gebouwd":"[^"]*"/, '')).digest('hex');
      if (h === laatsteHash) return;
      mkdir();
      const doel = path.join(DIR, 'kaart.json'), tmp = doel + '.tmp' + process.pid;
      fs.writeFileSync(tmp, inhoud, { mode: 0o600 });
      fs.renameSync(tmp, doel);
      laatsteHash = h;
    } catch (e) { fout('secondbrain-bewaar', e); }
  }

  // Eén bouw tegelijk (Fable K9); vers genoeg = de bestaande. Synchroon onder de motorkap (± 60–300 ms).
  function vers(dwing) {
    if (!dwing && kaart && nu() - kaart.op < KAART_VERS_MS) return kaart;
    if (bouwBezig) return kaart || bouw();
    bouwBezig = true;
    try { return bouw(); } catch (e) { fout('secondbrain-bouw', e); return kaart; } finally { bouwBezig = null; }
  }

  // Mag dit bestand op dit apparaat (P2) en in deze weergave (P4)? Op een vaste plek is verborgen ook dicht: in Bronnen-mappen staan
  // sollicitatietranscripten en arbeidsovereenkomsten (Fable diffreview M2), en "alles" doet daar niets.
  const mag = function (b, ctx) { return !(ctx.vast && (b.x || b.v)); };
  const inLijst = function (b, ctx, alles) { return mag(b, ctx) && (alles || !b.v); };

  function kaartVoor(ctx, alles) {
    const k = vers(false);
    if (!k) return { status: 503, j: { ok: false, fout: 'de kaart is nu niet te bouwen' } };
    const naar = new Map(), knopen = [];
    const tel = {};
    let verborgen = 0;
    k.bestanden.forEach(function (b, i) {
      if (!mag(b, ctx)) return;
      if (!alles && b.v) { verborgen++; return; }
      naar.set(i, knopen.length);
      knopen.push(b);
    });
    const lijnen = [];
    const graad = new Array(knopen.length).fill(0);
    knopen.forEach(function (b, li) {
      for (const j of b.l) {
        const lj = naar.get(j);
        if (lj === undefined) continue;
        lijnen.push(li, lj); graad[li]++; graad[lj]++;
      }
    });
    knopen.forEach(function (b) { tel[b.d] = (tel[b.d] || 0) + 1; });
    return { status: 200, j: { ok: true, bijgewerkt: new Date(k.op).toISOString(), vaste_plek: !!ctx.vast, alles: !!alles,
      domeinen: DOMEINEN.map(function (n, i) { return { i: i, naam: n, n: tel[n] || 0 }; }),
      knopen: knopen.map(function (b, li) { return [b.p, DOMEINEN.indexOf(b.d), b.s, new Date(b.m).toISOString().slice(0, 10), graad[li]]; }),
      lijnen: lijnen, verborgen_n: verborgen } };
  }

  // Pad uit de kaart (exacte tekst, ook NFC/hoofdletters), dan realpath binnen de vault en lstat geen symlink (P7).
  function zoekPad(pad, ctx) {
    if (typeof pad !== 'string' || !pad || pad.length > 600 || pad.indexOf('\u0000') >= 0 || pad[0] === '/' || /(^|\/)\.\.(\/|$)/.test(pad)) return null;
    let k = vers(false);
    if (!k) return null;
    let i = k.perPad.get(sleutel(pad));
    // onbekend pad: hooguit eens per 10 s geforceerd herbouwen (anders blokkeert elk fout pad de event-loop ± 130 ms; Fable diffreview K6)
    if (i === undefined && nu() - laatsteDwang > 10000) { laatsteDwang = nu(); k = vers(true); i = k && k.perPad.get(sleutel(pad)); }
    if (i === undefined || !k) return null;
    const b = k.bestanden[i];
    if (!mag(b, ctx)) return null;
    try {
      if (!echteVault) echteVault = fs.realpathSync(VAULT);
      const abs = path.join(VAULT, b.p);
      const st = fs.lstatSync(abs);
      if (!st.isFile() || st.isSymbolicLink()) return null;
      const echt = fs.realpathSync(abs);
      if (echt.indexOf(echteVault + path.sep) !== 0) return null;
      return { b: b, i: i, abs: echt, st: st, k: k };
    } catch (e) { return null; }
  }
  // Bij een weigering de HMAC van het gevraagde pad, zodat pogingen achteraf aan een pad te koppelen zijn (Fable diffreview K5)
  const audit = function (b, gevraagd) { return { domein: b ? b.d : null, h: b ? hmac(b.p) : (typeof gevraagd === 'string' && gevraagd ? hmac(gevraagd.slice(0, 600)) : null) }; };

  function eigenschappen(fm, ctx) {
    const uit = [];
    let huidig = null;
    for (const r of fm.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_][A-Za-z0-9_ .-]{0,40}):\s*(.*)$/.exec(r);
      if (m) { huidig = { naam: m[1], waarde: m[2].trim() }; uit.push(huidig); continue; }
      const l = /^\s+-\s+(.*)$/.exec(r);
      if (l && huidig) huidig.waarde = (huidig.waarde ? huidig.waarde + ', ' : '') + l[1].trim();
    }
    return uit.slice(0, 30).map(function (e) {
      // naam en waarde samen door het masker (api_key: …), daarna de naam er weer af
      const kop = e.naam + ': ';
      const m = masker(kop + e.waarde.replace(/^["']|["']$/g, ''), ctx.vast, bsnMasker);
      return { naam: e.naam, waarde: (m.indexOf(kop) === 0 ? m.slice(kop.length) : m).slice(0, 500) };
    });
  }

  function open(d, ctx) {
    const z = zoekPad(d && d.pad, ctx);
    if (!z || z.b.s !== 'md') return { status: 404, j: { ok: false, fout: 'deze pagina is er niet (meer)' }, audit: audit(null, d && d.pad) };
    if (z.st.size > MAX_MD) return { status: 413, j: { ok: false, fout: 'deze pagina is te groot om hier te tonen' }, audit: audit(z.b) };
    let t;
    try { t = fs.readFileSync(z.abs, 'utf8'); } catch (e) { return { status: 404, j: { ok: false, fout: 'niet te lezen' }, audit: audit(z.b) }; }
    t = t.replace(/^﻿/, '');
    let fm = '';
    const f = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(t);
    if (f) { fm = f[1]; t = t.slice(f[0].length); }
    const k = z.k;
    const doelen = {};
    const linksAlles = linksIn((fm ? fm + '\n' : '') + t);
    for (const l of linksAlles) {
      if (Object.prototype.hasOwnProperty.call(doelen, l.ruw)) continue;
      if (!l.doel) { doelen[l.ruw] = { p: z.b.p }; continue; }   // [[#kop]] = deze pagina
      const r = los(l.doel, z.b.p, l.md, k);
      if (r && r.i !== undefined) {
        const b = k.bestanden[r.i];
        doelen[l.ruw] = mag(b, ctx) ? { p: b.p, s: b.s } : null;
      } else if (r && r.k) {
        const ks = r.k.map(function (i) { return k.bestanden[i]; }).filter(function (b) { return mag(b, ctx); });
        doelen[l.ruw] = ks.length === 1 ? { p: ks[0].p, s: ks[0].s } : ks.length ? { k: ks.map(function (b) { return b.p; }) } : null;
      } else doelen[l.ruw] = null;
    }
    const terug = [];
    k.bestanden.forEach(function (b) { if (b.l.indexOf(z.i) >= 0 && mag(b, ctx)) terug.push(b.p); });
    terug.sort(function (a, b) { return a.split('/').pop().localeCompare(b.split('/').pop(), 'nl'); });
    return { status: 200, audit: audit(z.b), j: { ok: true, pad: z.b.p, domein: z.b.d, gewijzigd: new Date(z.b.m).toISOString(),
      grootte: z.b.g, eigenschappen: fm ? eigenschappen(fm, ctx) : [], md: masker(t, ctx.vast, bsnMasker), doelen: doelen, terug: terug.slice(0, 200),
      terug_n: terug.length } };
  }

  function bestand(d, ctx) {
    const z = zoekPad(d && d.pad, ctx);
    if (!z || z.b.s === 'md') return { status: 404, j: { ok: false, fout: 'dit bestand is er niet (meer)' }, audit: audit(null, d && d.pad) };
    if (bestandBezig >= 2) return { status: 429, j: { ok: false, fout: 'even geduld: er worden al twee bestanden geladen' }, audit: audit(z.b) };
    bestandBezig++;
    try {
      const ext = extVan(z.b.p);
      let buf = fs.readFileSync(z.abs);
      if (z.b.s === 'tekst') buf = Buffer.from(masker(buf.toString('utf8'), ctx.vast, bsnMasker), 'utf8');
      return { status: 200, audit: audit(z.b), j: { ok: true, naam: z.b.p.split('/').pop(), type: MIME[ext] || 'application/octet-stream',
        grootte: buf.length, inhoud: buf.toString('base64') } };
    } catch (e) {
      return { status: 404, j: { ok: false, fout: 'niet te lezen' }, audit: audit(z.b) };
    } finally { bestandBezig--; }
  }

  // ── OVIS Docs (wv1378; bouwplan "01_Ontwikkeling/OVIS Docs - bouwplan (26-10-2026).md" § 3.2, Opus-review § 7) ─────────────────
  // bewerk: de tekst onder de frontmatter, ongemaskeerd alleen als de pagina bewerkbaar is (anders zou opslaan de echte waarde achter het
  // masker overschrijven), met versie = sha256 van het hele bestand. bewaar: beslist alles opnieuw op wat er nú staat (review #3), schrijft
  // alleen als de versie nog klopt (409), via opt.wijzig (vault-veilig: symlinkvrij, eigen tmp + rename), zet BOM, regeleinden en de
  // frontmatter-bytes van het bestand terug, en bewaart de vorige inhoud buiten de vault (opt.versieDir, 0600, laatste 10; review #2).
  const MAX_BEWERK = 512 * 1024, MAX_NIEUW = 1024 * 1024, VERSIES = 10;
  const ALLEEN_LEZEN_NAAM = ['actueel.md', 'claude.md', 'claude.local.md', 'agents.md'];
  const sha = function (t) { return crypto.createHash('sha256').update(Buffer.from(String(t), 'utf8')).digest('hex').slice(0, 32); };
  function delen(t) {
    const bom = t.charCodeAt(0) === 0xFEFF ? '﻿' : '';
    let r = bom ? t.slice(1) : t;
    const f = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(r);
    const fm = f ? f[0] : '';
    r = r.slice(fm.length);
    return { bom: bom, fm: fm, fmTekst: f ? f[1] : '', body: r, crlf: /\r\n/.test(r) || (!r && /\r\n/.test(fm)) };
  }
  // Waarom deze pagina niet in Docs bewerkt kan worden (null = wel). t = de hele inhoud zoals die nu op schijf staat.
  function nietBewerkbaar(z, t, ctx) {
    if (ctx.vast) return 'op een vaste plek kun je hier alleen lezen';
    const p = z.b.p, naam = p.split('/').pop().toLowerCase();
    if (p.indexOf('00_Systeem/') === 0) return 'systeempagina\'s houden Socev en de wachters bij';
    if (ALLEEN_LEZEN_NAAM.indexOf(naam) >= 0) return 'deze pagina houdt Socev zelf bij';
    if (isVerborgen(p)) return 'bronnen blijven zoals ze binnenkwamen';
    if (z.st.size > MAX_BEWERK) return 'deze pagina is te groot om hier te bewerken';
    if (Buffer.byteLength(t, 'utf8') !== z.st.size) return 'deze pagina bevat tekens die hier niet veilig te bewaren zijn';
    if (masker(t, false, null) !== t) return 'er staat iets in dat op een sleutel lijkt; dat blijft afgeschermd';
    return null;
  }
  function docsBewerk(d, ctx) {
    const z = zoekPad(d && d.pad, ctx);
    if (!z || z.b.s !== 'md') return { status: 404, j: { ok: false, fout: 'deze pagina is er niet (meer)' }, audit: audit(null, d && d.pad) };
    if (z.st.size > MAX_MD) return { status: 413, j: { ok: false, fout: 'deze pagina is te groot om hier te tonen' }, audit: audit(z.b) };
    let t;
    try { t = opt.lees ? opt.lees(z.abs) : fs.readFileSync(z.abs, 'utf8'); } catch (e) { return { status: 404, j: { ok: false, fout: 'niet te lezen' }, audit: audit(z.b) }; }
    const reden = nietBewerkbaar(z, t, ctx);
    const dl = delen(t);
    const body = dl.body.replace(/\r\n/g, '\n');
    return { status: 200, audit: audit(z.b), j: { ok: true, pad: z.b.p, versie: sha(t), bewerkbaar: !reden, reden: reden,
      eigenschappen: dl.fmTekst ? eigenschappen(dl.fmTekst, ctx) : [], md: reden ? masker(body, ctx.vast, bsnMasker) : body } };
  }
  function bewaarVorige(p, t) {
    if (!opt.versieDir) return;
    const map = path.join(opt.versieDir, hmac(p));
    fs.mkdirSync(map, { recursive: true, mode: 0o700 });
    const naam = new Date(nu()).toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex') + '.md';
    fs.writeFileSync(path.join(map, naam), t, { mode: 0o600, flag: 'wx' });
    const oud = fs.readdirSync(map).filter(function (n) { return /\.md$/.test(n); }).sort();
    oud.slice(0, Math.max(0, oud.length - VERSIES)).forEach(function (n) { try { fs.unlinkSync(path.join(map, n)); } catch (e) { /* weg */ } });
  }
  function docsBewaar(d, ctx) {
    const md = d && d.md, versie = d && d.versie;
    if (typeof md !== 'string' || typeof versie !== 'string' || !/^[0-9a-f]{32}$/.test(versie))
      return { status: 400, j: { ok: false, fout: 'onvolledig verzoek' }, audit: audit(null, d && d.pad) };
    if (Buffer.byteLength(md, 'utf8') > MAX_NIEUW || md.indexOf('\u0000') >= 0)
      return { status: 413, j: { ok: false, fout: 'deze tekst is te groot om op te slaan' }, audit: audit(null, d && d.pad) };
    const z = zoekPad(d.pad, ctx);
    if (!z || z.b.s !== 'md') return { status: 404, j: { ok: false, fout: 'deze pagina is er niet meer; misschien is hij verplaatst. Je tekst staat nog hier.' }, audit: audit(null, d.pad) };
    if (ctx.vast) return { status: 403, j: { ok: false, fout: 'op een vaste plek kun je hier alleen lezen' }, audit: audit(z.b) };
    if (opt.onderhoud && opt.onderhoud()) return { status: 423, j: { ok: false, fout: 'de vault staat even in onderhoud; probeer het later opnieuw. Je tekst staat nog hier.' }, audit: audit(z.b) };
    if (opt.grendelVrij && !opt.grendelVrij()) return { status: 423, j: { ok: false, fout: 'er loopt net een synchronisatie; probeer het over een minuut opnieuw. Je tekst staat nog hier.' }, audit: audit(z.b) };
    if (masker(md, false, null) !== md) return { status: 422, j: { ok: false, fout: 'in je tekst staat iets dat op een sleutel lijkt; sleutels horen niet in de vault' }, audit: audit(z.b) };
    if (!opt.wijzig) return { status: 503, j: { ok: false, fout: 'opslaan kan in deze versie van de pod niet' }, audit: audit(z.b) };
    let uitkomst = null, nieuweVersie = null, geschreven = false;
    try {
      geschreven = opt.wijzig(z.abs, function (oud) {
        if (sha(oud) !== versie) { uitkomst = 'conflict'; return null; }
        const reden = nietBewerkbaar(Object.assign({}, z, { st: { size: Buffer.byteLength(oud, 'utf8') } }), oud, ctx);
        if (reden) { uitkomst = reden; return null; }
        const dl = delen(oud);
        let body = md.replace(/\r\n/g, '\n');
        if (/\n$/.test(dl.body) && !/\n$/.test(body)) body += '\n';
        if (dl.crlf) body = body.replace(/\n/g, '\r\n');
        const nieuw = dl.bom + dl.fm + body;
        if (nieuw === oud) { uitkomst = 'gelijk'; nieuweVersie = versie; return null; }
        bewaarVorige(z.b.p, oud);
        nieuweVersie = sha(nieuw);
        uitkomst = 'ok';
        return nieuw;
      });
    } catch (e) {
      if (e && e.code === 'ENOENT') return { status: 404, j: { ok: false, fout: 'deze pagina is er niet meer; misschien is hij verplaatst. Je tekst staat nog hier.' }, audit: audit(z.b) };
      fout('docs-bewaar', e);
      return { status: 500, j: { ok: false, fout: 'opslaan lukte niet; je tekst staat nog hier' }, audit: audit(z.b) };
    }
    if (uitkomst === 'conflict') return { status: 409, j: { ok: false, fout: 'deze pagina is intussen veranderd (Socev of een agent schreef erin). Je tekst staat nog hier: kopieer hem, of laad de nieuwe versie.' }, audit: audit(z.b) };
    if ((uitkomst === 'ok' && geschreven) || uitkomst === 'gelijk') return { status: 200, j: { ok: true, versie: nieuweVersie, gewijzigd: uitkomst === 'ok' }, audit: audit(z.b) };
    if (uitkomst && uitkomst !== 'ok') return { status: 403, j: { ok: false, fout: uitkomst }, audit: audit(z.b) };
    return { status: 409, j: { ok: false, fout: 'de pagina veranderde tijdens het opslaan; laad hem opnieuw. Je tekst staat nog hier.' }, audit: audit(z.b) };
  }

  const plat = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Eerst een ruim stuk maskeren en dan pas knippen: anders verliest een sleutel op de knipgrens zijn kop en herkent het masker
  // de staart niet meer (Fable diffreview K4).
  function fragment(tekst, pos, ctx) {
    const ruimVan = Math.max(0, pos - 600);
    const ruim = masker(tekst.slice(ruimVan, pos + 600), ctx.vast, bsnMasker);
    const rel = Math.min(ruim.length, pos - ruimVan);
    const van = Math.max(0, rel - 60);
    const f = ruim.slice(van, van + FRAGMENT * 2).replace(/\s+/g, ' ').trim().slice(0, FRAGMENT);
    return (van > 0 || ruimVan > 0 ? '… ' : '') + f + (f.length >= FRAGMENT ? ' …' : '');
  }

  async function zoek(d, ctx) {
    const q = String(d && d.q || '').trim().slice(0, MAX_Q);
    if (q.length < 2) return { status: 400, j: { ok: false, fout: 'typ minstens twee tekens' } };
    const alles = !!(d && d.alles);
    const k = vers(false);
    if (!k) return { status: 503, j: { ok: false, fout: 'de kaart is nu niet te bouwen' } };
    if (d && d.betekenis) {
      if (typeof opt.betekenis !== 'function') return { status: 503, j: { ok: false, fout: 'zoeken op betekenis kan nu niet' } };
      let chunks;
      try { chunks = await opt.betekenis(q); } catch (e) { chunks = null; }
      if (!Array.isArray(chunks)) return { status: 502, j: { ok: false, fout: 'zoeken op betekenis gaf geen antwoord; probeer het gewone zoeken' } };
      const uit = [], gezien = new Set();
      for (const c of chunks) {
        const key = String(c && c.key || '').replace(/^vault\//, '');
        const i = k.perPad.get(sleutel(key));
        if (i === undefined || gezien.has(i)) continue;   // stale index of buiten de kaart (Fable K11)
        const b = k.bestanden[i];
        if (!inLijst(b, ctx, alles)) continue;
        gezien.add(i);
        uit.push({ pad: b.p, waar: 'betekenis', fragment: masker(String(c.text || ''), ctx.vast, bsnMasker).replace(/\s+/g, ' ').trim().slice(0, FRAGMENT) });
        if (uit.length >= MAX_TREFFERS) break;
      }
      return { status: 200, j: { ok: true, q: q, treffers: uit, betekenis: true } };
    }
    if (zoekBezig) return { status: 429, j: { ok: false, fout: 'er loopt al een zoekvraag; even geduld' } };
    zoekBezig = true;
    try {
      const woorden = plat(q).split(/\s+/).filter(function (w) { return w.length > 0; }).slice(0, 8);
      const opNaam = [], opTekst = [];
      const t0 = Date.now();
      let afgekapt = false;
      const lijst = k.bestanden.filter(function (b) { return inLijst(b, ctx, alles); });
      for (const b of lijst) {
        const p = plat(b.p);
        if (woorden.every(function (w) { return p.indexOf(w) >= 0; })) opNaam.push({ b: b, pad: b.p, waar: 'naam', fragment: '' });
      }
      const opNaamSet = new Set(opNaam.map(function (x) { return x.pad; }));
      const tekstLijst = lijst.filter(function (b) { return (b.s === 'md' || b.s === 'tekst') && b.g <= MAX_MD && !opNaamSet.has(b.p); })
        .sort(function (a, b) { return b.m - a.m; });
      for (const b of tekstLijst) {
        if (opTekst.length + opNaam.length >= MAX_TREFFERS) { afgekapt = true; break; }
        if (Date.now() - t0 > ZOEK_MS) { afgekapt = true; break; }
        let t;
        try { t = fs.readFileSync(path.join(VAULT, b.p), 'utf8'); } catch (e) { continue; }
        const l = t.toLowerCase();
        // snelle voortoets zonder accenten-omzetting; alleen bij een kans de dure omzetting
        const eerste = woorden[0];
        let pos = l.indexOf(eerste);
        let vlak = null;
        if (pos < 0) { if (!/[À-ɏ]/.test(t)) continue; vlak = plat(t); pos = vlak.indexOf(eerste); if (pos < 0) continue; }
        const bron = vlak || l;
        if (!woorden.every(function (w) { return bron.indexOf(w) >= 0; })) {
          if (vlak) continue;
          vlak = plat(t);
          if (!woorden.every(function (w) { return vlak.indexOf(w) >= 0; })) continue;
          pos = vlak.indexOf(eerste);
        }
        opTekst.push({ pad: b.p, waar: 'tekst', fragment: fragment(t, Math.min(pos, t.length), ctx) });
      }
      opNaam.sort(function (a, b) { return b.b.m - a.b.m; });
      const treffers = opNaam.slice(0, MAX_TREFFERS).map(function (x) { return { pad: x.pad, waar: 'naam', fragment: '' }; }).concat(opTekst).slice(0, MAX_TREFFERS);
      return { status: 200, j: { ok: true, q: q, treffers: treffers, afgekapt: afgekapt || opNaam.length > MAX_TREFFERS, ms: Date.now() - t0 } };
    } finally { zoekBezig = false; }
  }

  // Financiën (bouwplan § 7): koppeltabel tegenpartij → pagina. Geeft Map(normNaam → pad) met alleen paden die in de kaart staan.
  const KOPPEL_PAD = '20_Prive/Financien/Financiën - koppeling Second Brain.md';
  const normNaam = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/\b(b\.?v\.?|n\.?v\.?)\b/g, ' ').replace(/[^a-z0-9à-ÿ]+/g, ' ').trim();
  let koppelCache = null;   // { m (mtime), map }
  function koppel() {
    const abs = path.join(VAULT, KOPPEL_PAD);
    let st;
    try { st = fs.lstatSync(abs); } catch (e) { return new Map(); }
    if (!st.isFile()) return new Map();
    const k = vers(false);
    if (koppelCache && koppelCache.m === st.mtimeMs && koppelCache.op === (k && k.op)) return koppelCache.map;
    const map = new Map();
    let t = '';
    try { t = fs.readFileSync(abs, 'utf8'); } catch (e) { return map; }
    for (const r of t.split(/\r?\n/)) {
      if (!/^\s*\|/.test(r) || /^\s*\|\s*-/.test(r)) continue;
      const cellen = r.replace(/\\\|/g, '\u0001').split('|').slice(1, -1).map(function (c) { return c.replace(/\u0001/g, '|').trim(); });
      if (cellen.length < 2 || /^tegenpartij$/i.test(cellen[0])) continue;
      const w = /\[\[([^\]|#]+)/.exec(cellen[1]);
      if (!w || !k) continue;
      const lr = los(w[1], KOPPEL_PAD, false, k);
      if (!lr || lr.i === undefined) continue;
      const nn = normNaam(cellen[0]);
      if (nn) map.set(nn, k.bestanden[lr.i].p);
    }
    koppelCache = { m: st.mtimeMs, op: k && k.op, map: map };
    return map;
  }
  function koppelNaam(naam) { const m = koppel(); return m.get(normNaam(naam)) || null; }

  function nacht(datum) {
    if (laatsteNacht === datum) return false;
    laatsteNacht = datum;
    vers(true);
    return true;
  }

  // Bij een podstart: de laatste kaart als vertrekpunt (de eerste vraag bouwt hem vers).
  function laadBewaard() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DIR, 'kaart.json'), 'utf8'));
      if (!j || !Array.isArray(j.bestanden)) return;
      const bestanden = j.bestanden.filter(function (b) { return b && typeof b.p === 'string' && Array.isArray(b.l); });
      const k = Object.assign({ bestanden: bestanden }, indexeer(bestanden));
      k.op = 0; k.duur = null;   // op 0 = meteen niet vers: de eerste vraag bouwt opnieuw
      kaart = k;
    } catch (e) { /* geen of onleesbare kaart: de eerste vraag bouwt */ }
  }

  async function app(route, d, ctx) {
    ctx = ctx || {};
    if (route === 'GET /app/secondbrain') return kaartVoor(ctx, false);
    if (route === 'POST /app/secondbrain/kaart') return kaartVoor(ctx, !!(d && d.alles));
    if (route === 'POST /app/secondbrain/open') return open(d, ctx);
    if (route === 'POST /app/secondbrain/bestand') return bestand(d, ctx);
    if (route === 'POST /app/secondbrain/zoek') return zoek(d, ctx);
    if (route === 'POST /app/secondbrain/bewerk') return docsBewerk(d, ctx);   // wv1378: OVIS Docs
    if (route === 'POST /app/secondbrain/bewaar') return docsBewaar(d, ctx);   // wv1378: OVIS Docs
    return { status: 404, j: { ok: false, fout: 'onbekend' } };
  }

  function health() {
    const k = kaart;
    return { aan: true, knopen: k ? k.bestanden.length : 0, lijnen: k ? k.bestanden.reduce(function (n, b) { return n + b.l.length; }, 0) : 0,
      gebouwd: k && k.op ? new Date(k.op).toISOString() : null, duur_ms: k ? k.duur : null, nacht: laatsteNacht };
  }

  return { mkdir: mkdir, laadBewaard: laadBewaard, app: app, health: health, vers: vers, koppelNaam: koppelNaam, nacht: nacht,
    _los: function (doel, bron, md) { return los(doel, bron, md, vers(false)); } };
}

module.exports = { maak: maak, masker: masker, linksIn: linksIn, domeinVan: domeinVan, isVastDicht: isVastDicht, isVerborgen: isVerborgen,
  DOMEINEN: DOMEINEN, KAART_VERS_MS: KAART_VERS_MS };
