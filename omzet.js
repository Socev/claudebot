'use strict';
// Download als… — omzetten naar PDF, Word of Excel (wv1854; bouwplan vault 01_Ontwikkeling/Download als - bouwplan (28-10-2026).md § 3.2).
// WAAROM. David (28-10-2026 08:27): "Bij voorkeur wil ik alles wat je produceert in markdown! … En dan kunnen we altijd, op het moment dat het
// er toe doet, het omzetten naar een Word of PDF … Als ik in onze Markdown-Viewer een knop "Download als..." krijg en dan kiezen voor PDF, PDF
// met huisstijl, Word, Xlsx - als voorbeelden, dan is dat al super." De app stuurt de tekst die David al in beeld heeft; dit maakt er een
// bestand van voor zijn eigen apparaat (niet naar buiten: dat is Delen).
//
// Werking (één omzetting tegelijk, de rest wacht in een korte rij; tijdslimiet 20 s per omzetting):
// - PDF: markdown → de escapende renderer van Delen (docs-delen.js render: wikilinks → tekst, alleen http(s)-links, geen beelden) + printstijl;
//   csv/tekst → een tabel of alinea's in dezelfde pagina; een html-bestand zoals het is. Chromium (headless shell uit het image) met JS uit,
//   een CSP-kop (default-src 'none'; alleen data:-beelden en -lettertypen) en elk verzoek afgebroken; de teller van pogingen gaat in de audit.
//   Huisstijl = briefhoofd en voet (naam, website, paginanummer) uit omzet-huisstijl.js; geen IBAN of KvK (dit is geen factuur).
// - Word: pandoc (--sandbox, geen lua-filter, geen --extract-media) leest de tekst naar zijn AST; schoon() haalt beelden, ruwe HTML en
//   niet-http(s)-links eruit; daarna AST → docx met de reference-doc van de huisstijl.
// - Excel: dezelfde AST → de tabellen → xlsx-schrijver.js (elke tabel een blad; formules nooit).
// - Markdown uit Word (wv1893, Word-weergave in de Lezer: "Bewaar als markdown"): soort docx, tekst = de .docx in base64 (de app haalt de
//   afbeeldingen er vooraf uit; hooguit MAX_DOCX). pandoc --sandbox leest docx → AST, schoon() en dezelfde witte lijst als bij Word, dan
//   AST → gfm (ook --sandbox). Een binnengekomen .docx is onbetrouwbare invoer: alles in hetzelfde kindproces met dezelfde grenzen.
// Alles in een eigen tijdelijke map (0700) die na afloop weg is. In log en audit alleen formaat, soort, huisstijl, grootte, ms, pogingen.
// Opus-review (28-10, MOET 1 en 2): het werk draait in een eigen kindproces (node omzet.js --werker, eigen heap, kale omgeving zonder de
// sleutels van server.js), zodat een trage regex of een grote AST de pod niet stillegt. De ouder bewaakt de hele procesboom (kind, pandoc,
// Chromium): na de harde tijdslimiet of boven MAX_RSS gaat alles met SIGKILL weg. Een PDF met meer dan MAX_PDF_RIJEN tabelregels wordt
// vooraf geweigerd (Chromium groeide daar gemeten tot ± 12 GB; een OOM schiet de hele pod af).
//
// Ook voor Socev zelf (bouwplan § 3.3): node /app/omzet.js <pdf|docx|xlsx|md> [--huisstijl <sleutel>] [--soort md|html|csv|tekst|docx] <in> <uit>
// (md alleen uit een .docx)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const MAX_TEKST = 2 * 1024 * 1024;          // bytes UTF-8; daarboven 413
const MAX_UIT = 25 * 1024 * 1024;           // het bestand gaat base64 in een JSON-antwoord
const MAX_PANDOC_UIT = 150 * 1024 * 1024;   // AST van een grote tekst
const TIJD_MS = 20 * 1000;
const WACHT_MAX = 3;
const WACHT_MS = 30 * 1000;
const HARD_MS = 5 * 1000;                   // bovenop TIJD_MS: dan haalt de ouder de hele procesboom weg
const MAX_RSS = 2560 * 1024 * 1024;         // hele procesboom (kind + pandoc + Chromium)
const KIND_HEAP_MB = 1536;
const MAX_PDF_RIJEN = 5000;
const MAX_DOCX = 3.5 * 1024 * 1024;         // wv1893: .docx in bytes (base64 + JSON blijft onder de 5 MB van het doorgeefluik en server.js)
const SOORTEN = ['md', 'html', 'csv', 'tekst', 'docx'];
const FORMATEN = {
  pdf: { ext: 'pdf', type: 'application/pdf' },
  docx: { ext: 'docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { ext: 'xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  md: { ext: 'md', type: 'text/markdown; charset=utf-8' },   // wv1893: alleen uit een .docx
};
const FORMAAT_NAAM = { pdf: 'PDF', docx: 'Word', xlsx: 'Excel', md: 'markdown' };
const PW_STANDAARD = '/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright-core';
const DOC_URL = 'http://omzet.invalid/';
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'; frame-src 'none'";

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ── tekst voorbereiden ──────────────────────────────────────────────────────────────────────────────────────────────────────
const wikiLabel = (binnen) => {
  const delen = String(binnen).split(/\\?\|/);
  if (delen.length > 1 && delen.slice(1).join('|').trim()) return delen.slice(1).join('|').trim();
  const [pad, kop] = delen[0].split('#');
  return (pad.split('/').pop().replace(/\.md$/i, '') || (kop || '').trim()).trim();
};
const mdEsc = (s) => String(s).replace(/([\\`*_{}\[\]<>|#!])/g, '\\$1');

// Obsidian-taal → gewone markdown (zelfde voorbewerking als Delen: frontmatter, %%…%%, HTML-commentaar, teruggevouwen lijstitems).
function voorMd(md, voorbewerk) {
  let s = voorbewerk(md);
  s = s.replace(/!\[\[[^\]\n]*\]\]/g, '');
  s = s.replace(/\[\[([^\[\]\n]+?)\]\]/g, (m, b) => mdEsc(wikiLabel(b)));
  s = s.replace(/^([ \t]*>[ \t]*)\[!([\w-]+)\][+-]?[ \t]*(.*)$/gm, (m, p, soort, titel) =>   // [ \t], niet \s: \s over regels heen = kwadratisch (review)   // callout: titel vet als eigen alinea
    p + '**' + (titel.trim() || (soort[0].toUpperCase() + soort.slice(1).toLowerCase())) + '**\n' + p.replace(/\s+$/, ''));
  s = s.replace(/==([^=\n]+)==/g, '$1');
  return s;
}

// Platte tekst → veilige HTML (alinea's; regels binnen een alinea met <br>).
function tekstHtml(t) {
  return String(t).replace(/\r\n?/g, '\n').split(/\n{2,}/).filter((p) => p.trim())
    .map((p) => '<p>' + p.split('\n').map(esc).join('<br>') + '</p>').join('\n');
}

// ── pandoc-AST ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Beelden → hun alt-tekst (niets ophalen, ook geen lokaal bestand), links alleen http(s), ruwe HTML weg (behalve <br> → regelafbreking).
function schoon(x) {
  if (Array.isArray(x)) {
    const uit = [];
    for (const el of x) {
      if (el && typeof el === 'object' && !Array.isArray(el) && typeof el.t === 'string') {
        if (el.t === 'Image') { uit.push(...schoon(el.c[1])); continue; }
        if (el.t === 'Link') {
          const url = String(el.c[2] && el.c[2][0] || '');
          if (!/^https?:\/\/[^\s]+$/i.test(url)) { uit.push(...schoon(el.c[1])); continue; }
          uit.push({ t: 'Link', c: [['', [], []], schoon(el.c[1]), [url, '']] });
          continue;
        }
        if (el.t === 'RawInline') { if (el.c[0] === 'html' && /^<br\s*\/?>$/i.test(String(el.c[1]).trim())) uit.push({ t: 'LineBreak' }); continue; }
        if (el.t === 'RawBlock') continue;
      }
      uit.push(schoon(el));
    }
    return uit;
  }
  if (x && typeof x === 'object') {
    const uit = {};
    for (const k of Object.keys(x)) uit[k] = schoon(x[k]);
    return uit;
  }
  return x;
}

// Inlines/blocks → platte tekst (voor tabelcellen en bladnamen); attributen tellen niet mee.
function platteTekst(x) {
  if (Array.isArray(x)) return x.map(platteTekst).join('');
  if (!x || typeof x !== 'object') return '';
  const c = x.c;
  switch (x.t) {
    case 'Str': return String(c);
    case 'Space': case 'SoftBreak': return ' ';
    case 'LineBreak': return '\n';
    case 'Code': case 'Math': return String(c[1]);
    case 'Emph': case 'Strong': case 'Strikeout': case 'Superscript': case 'Subscript': case 'SmallCaps': case 'Underline': return platteTekst(c);
    case 'Span': case 'Link': case 'Quoted': case 'Cite': return (x.t === 'Quoted' ? '"' : '') + platteTekst(c[1]) + (x.t === 'Quoted' ? '"' : '');
    case 'Plain': case 'Para': return platteTekst(c) + '\n';
    case 'LineBlock': return c.map(platteTekst).join('\n') + '\n';
    case 'CodeBlock': return String(c[1]) + '\n';
    case 'Header': return platteTekst(c[2]) + '\n';
    case 'BlockQuote': return platteTekst(c);
    case 'Div': return platteTekst(c[1]);
    case 'BulletList': return c.map(platteTekst).join('');
    case 'OrderedList': return c[1].map(platteTekst).join('');
    default: return '';
  }
}
const celTekst = (blocks) => platteTekst(blocks).replace(/[ \t]+\n/g, '\n').replace(/\n+$/, '').trim();

// Tabellen in documentvolgorde, met de laatste kop ervoor als bladnaam.
function tabellen(ast) {
  const uit = [];
  let kop = '';
  const rijUit = (rij) => {
    const cellen = [];
    for (const cel of rij[1] || []) {
      cellen.push(celTekst(cel[4]));
      for (let i = 1; i < Math.min(Number(cel[3]) || 1, 200); i++) cellen.push('');
    }
    return cellen;
  };
  const loop = (blocks) => {
    for (const b of blocks || []) {
      if (!b || typeof b !== 'object') continue;
      if (b.t === 'Header') kop = celTekst([{ t: 'Plain', c: b.c[2] }]);
      else if (b.t === 'Table') {
        const c = b.c;
        const rijen = [];
        (c[3][1] || []).forEach((r) => rijen.push(rijUit(r)));
        for (const body of c[4] || []) { (body[2] || []).forEach((r) => rijen.push(rijUit(r))); (body[3] || []).forEach((r) => rijen.push(rijUit(r))); }
        (c[5][1] || []).forEach((r) => rijen.push(rijUit(r)));
        const bijschrift = celTekst(c[1] && c[1][1] || []);
        if (rijen.length) uit.push({ naam: bijschrift || kop || '', rijen: rijen });
      } else if (b.t === 'Div') loop(b.c[1]);
      else if (b.t === 'BlockQuote') loop(b.c);
      else if (b.t === 'BulletList') b.c.forEach(loop);
      else if (b.t === 'OrderedList') b.c[1].forEach(loop);
    }
  };
  loop(ast.blocks);
  return uit;
}

// ── stijl ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const PRINT = [
  'html,body{background:#fff}',
  'body{font-family:"Liberation Sans",Arial,Helvetica,sans-serif;font-size:10.5pt;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
  '.wrap{max-width:none;margin:0;padding:0}',
  'h1{font-size:19pt;margin:0 0 12pt}h2{font-size:14pt;margin:18pt 0 6pt}h3{font-size:12pt;margin:14pt 0 4pt}',
  'h1,h2,h3,h4,h5,h6{break-after:avoid;page-break-after:avoid}',
  '.tabel{overflow:visible}table{border-collapse:collapse;width:100%;font-size:9.5pt}thead{display:table-header-group}',
  'tr,img,pre,blockquote,.callout{break-inside:avoid;page-break-inside:avoid}',
  'pre{white-space:pre-wrap;word-break:break-word}a{text-decoration:none}',
  'table.csv th,table.csv td{border-bottom:1px solid #e3e3df;padding:4pt 6pt;text-align:left;vertical-align:top}',
].join('');

function stijlCss(st, fonts) {
  if (!st) return '';
  const k = st.kleuren;
  let font = '';
  if (st.font && fonts && fonts[st.font]) {
    font = '@font-face{font-family:"Huisstijl";src:url(' + fonts[st.font] + ') format("woff2");font-weight:100 900}' +
      'body{font-family:"Huisstijl","Liberation Sans",Arial,sans-serif}';
  }
  return font + ':root{--acc:#' + k.accent + ';--lijn:#' + k.lijn + '}' +
    'h1,h2,h3,h4{color:#' + k.titel + '}h1{border-bottom:1.5pt solid #' + k.lijn + ';padding-bottom:4pt}' +
    'th{color:#' + k.caps + '}a{color:#' + k.accent + '}blockquote,.callout{border-left-color:#' + k.lijn + '}';
}

// Chromium tekent kop en voet in de paginamarge: breedte 100 % van het papier, dus de zijmarge als padding (margin schuift ze van het blad).
const staand = (st) => !!(st && st.logo && st.logo_maat && st.logo_maat[0] < 2 * st.logo_maat[1]);   // logo eerder hoog dan breed
const TPL_FONT = 'font-family:\'Liberation Sans\',Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box;width:100%;';
function kopTemplate(st) {
  if (!st) return '<span></span>';
  const k = st.kleuren, b = st.briefhoofd || {};
  const lijn = 'border-bottom:1px solid #' + k.lijn + ';';
  if (st.logo) {
    return '<div style="' + TPL_FONT + 'padding:9mm 18mm 0"><div style="padding-bottom:2mm;' + lijn + '">' +
      '<img src="' + st.logo + '" style="height:' + (staand(st) ? 20 : 14) + 'mm;width:auto;display:block"></div></div>';   // rechtop logo (Tolgaarde) wat groter
  }
  return '<div style="' + TPL_FONT + 'padding:9mm 18mm 0"><div style="padding-bottom:2mm;' + lijn + '">' +
    (b.caps ? '<div style="font-size:7.5pt;font-weight:700;letter-spacing:.12em;color:#' + k.caps + '">' + esc(b.caps) + '</div>' : '') +
    '<div style="font-size:15pt;font-weight:700;color:#' + k.titel + ';line-height:1.15">' + esc(b.naam || st.naam) + '</div>' +
    (b.ondertitel ? '<div style="font-size:7.5pt;color:#' + k.caps + '">' + esc(b.ondertitel) + '</div>' : '') + '</div></div>';
}
function voetTemplate(st) {
  const kleur = st ? '#' + st.kleuren.caps : '#5f6368';
  const delen = st ? [st.naam, st.website].filter(Boolean).map(esc) : [];
  return '<div style="' + TPL_FONT + 'font-size:7.5pt;color:' + kleur + ';padding:0 18mm 6mm;display:flex;justify-content:space-between">' +
    '<span>' + delen.join(' · ') + '</span><span>pagina <span class="pageNumber"></span> van <span class="totalPages"></span></span></div>';
}

// ── de module ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// opt: { delen (docs-delen.js: render, voorbewerk), huisstijl (omzet-huisstijl.js), xlsx (xlsx-schrijver.js), pandoc, chromium, pw, tmp, fout }
function maak(opt) {
  opt = opt || {};
  const DELEN = opt.delen || require('./docs-delen.js');
  const HS = opt.huisstijl !== undefined ? opt.huisstijl : (function () { try { return require('./omzet-huisstijl.js'); } catch (e) { return null; } })();
  const XLSX = opt.xlsx || require('./xlsx-schrijver.js');
  const PANDOC = opt.pandoc || '/usr/bin/pandoc';
  const TMP = opt.tmp || os.tmpdir();
  const tijdMs = opt.tijdMs || TIJD_MS;
  const fout = opt.fout || function () {};
  const STIJLEN = (HS && HS.STIJLEN) || {};
  const staat = { bezig: false, rij: [], laatst: null, ok: 0, mislukt: 0, gestart: 0 };

  function chromiumPad() {
    if (opt.chromium) return opt.chromium;
    const basis = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
    let mappen = [];
    try { mappen = fs.readdirSync(basis).filter((m) => /^chromium_headless_shell-\d+$/.test(m)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])); } catch (e) { return null; }
    for (const m of mappen) {
      const p = path.join(basis, m, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  let pwMod = null;
  function pw() { if (!pwMod) pwMod = require(opt.pw || process.env.OMZET_PLAYWRIGHT || PW_STANDAARD); return pwMod; }

  // pandoc met --sandbox (geen bestanden of netwerk tijdens het lezen/schrijven), geheugengrens, tijdslimiet; uitvoer naar stdout of -o.
  // Uitzondering: AST → docx draait zonder --sandbox, want pandoc 2.17 vindt dan zijn eigen docx-databestanden niet (gemeten 28-10: "Could
  // not find data file data/data/docx/[Content_Types].xml", code 97). Veilig omdat die stap alleen de geschoonde AST krijgt: zonder Image
  // (het enige dat de docx-schrijver ophaalt) en zonder ruwe HTML; docx() controleert dat nog eens.
  function pandoc(args, invoer, dir, tot, zonderSandbox) {
    return new Promise(function (resolve, reject) {
      const rest = tot - Date.now();
      if (rest <= 0) return reject(Object.assign(new Error('tijd'), { tijd: true }));
      const p = spawn(PANDOC, ['+RTS', '-M768m', '-RTS'].concat(zonderSandbox ? [] : ['--sandbox'], args), { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8', TMPDIR: dir } });
      const uit = []; let n = 0, klaar = false, err = '';
      const stop = function (e) { if (klaar) return; klaar = true; clearTimeout(t); try { p.kill('SIGKILL'); } catch (x) {} reject(e); };
      const t = setTimeout(function () { stop(Object.assign(new Error('tijd'), { tijd: true })); }, rest);
      p.stdout.on('data', function (c) { n += c.length; if (n > MAX_PANDOC_UIT) return stop(Object.assign(new Error('pandoc-uitvoer te groot'), { groot: true })); uit.push(c); });
      p.stderr.on('data', function (c) { if (err.length < 400) err += c; });
      p.on('error', function (e) { stop(e); });
      p.on('close', function (code) {
        if (klaar) return; klaar = true; clearTimeout(t);
        if (code === 251) return reject(Object.assign(new Error('pandoc: geheugen op'), { groot: true }));   // RTS -M bereikt (review ZOU 6)
        if (code !== 0) return reject(new Error('pandoc stopte met code ' + code));   // stderr niet in de fout: kan tekst bevatten
        resolve(Buffer.concat(uit));
      });
      p.stdin.on('error', function () {});
      p.stdin.end(invoer);
    });
  }

  async function astVan(d, dir, tot) {
    let ruw;
    if (d.soort === 'md') ruw = await pandoc(['-f', 'gfm', '-t', 'json'], voorMd(d.tekst, DELEN.voorbewerk), dir, tot);
    else if (d.soort === 'csv') ruw = await pandoc(['-f', 'csv', '-t', 'json'], String(d.tekst).replace(/^﻿/, ''), dir, tot);
    else if (d.soort === 'html') ruw = await pandoc(['-f', 'html', '-t', 'json'], d.tekst, dir, tot);
    else ruw = await pandoc(['-f', 'html', '-t', 'json'], tekstHtml(d.tekst), dir, tot);
    const ast = schoon(JSON.parse(ruw.toString('utf8')));
    ast.meta = {};
    return ast;
  }

  // Lege pagina in de stijl van Delen met de titel; body erin (al veilig: escapend gerenderd).
  function pagina(titel, body) {
    const leeg = DELEN.render('', titel).html;
    const i = leeg.lastIndexOf('\n</main>');
    return leeg.slice(0, i) + '\n' + body + leeg.slice(i);
  }
  function metStijl(html, st) {
    const css = '<style>' + PRINT + stijlCss(st, HS && HS.FONTS) + '</style>\n';
    const i = html.lastIndexOf('</head>');
    return i < 0 ? css + html : html.slice(0, i) + css + html.slice(i);
  }

  async function htmlVoorPdf(d, st, dir, tot) {
    if (d.soort === 'md') return metStijl(DELEN.render(d.tekst, d.basis).html, st);
    if (d.soort === 'tekst') return metStijl(pagina(d.basis, tekstHtml(d.tekst)), st);
    if (d.soort === 'csv') {
      const ast = await astVan(d, dir, tot);
      const frag = (await pandoc(['-f', 'json', '-t', 'html5'], JSON.stringify(ast), dir, tot)).toString('utf8').replace(/<table>/g, '<table class="csv">');
      return metStijl(pagina(d.basis, '<div class="tabel">' + frag + '</div>'), st);
    }
    // html: zoals het is (JS staat uit, CSP en het routeslot houden alles buiten); alleen een meta-refresh eruit en href's die geen
    // http(s) zijn (file:, smb:, javascript: … zouden als link in de PDF staan; review KAN 7)
    return String(d.tekst).replace(/<meta[^>]+http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi, '')
      .replace(/(<[a-z][^>]*?)\s(?:xlink:)?href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m, voor, w) => (/^["']?\s*https?:\/\//i.test(w) ? m : voor));
  }

  // Chromium met de eigen sandbox (review ZOU 4; gemeten: start in de pod). Lukt dat niet (bv. een container zonder user-namespaces),
  // dan zonder: JS uit, CSP en het routeslot blijven; health.omzet.sandbox laat zien welke het werd.
  async function startChromium(exe, rest) {
    const args = ['--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-default-apps',
      '--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-component-update', '--disable-domain-reliability',
      '--host-resolver-rules=MAP * ~NOTFOUND'];
    try { return { browser: await pw().chromium.launch({ executablePath: exe, headless: true, chromiumSandbox: true, timeout: rest(), args: args }), sandbox: true }; }
    catch (e) { return { browser: await pw().chromium.launch({ executablePath: exe, headless: true, chromiumSandbox: false, timeout: rest(), args: args }), sandbox: false }; }
  }

  async function pdf(html, st, tot) {
    const exe = chromiumPad();
    if (!exe) throw new Error('chromium ontbreekt');
    const rest = function () { return Math.max(1, tot - Date.now()); };
    let pogingen = 0;
    const { browser, sandbox } = await startChromium(exe, rest);
    let timer;
    try {
      const werk = (async function () {
        const ctx = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false, bypassCSP: false });
        let geladen = false, page = null;
        await ctx.route('**/*', function (r) {
          const q = r.request();
          if (q.url() === DOC_URL && q.isNavigationRequest() && q.frame() === page.mainFrame() && !geladen) {
            geladen = true;
            return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'Content-Security-Policy': CSP }, body: html });
          }
          return r.abort('blockedbyclient');
        });
        page = await ctx.newPage();
        page.on('request', function (q) { const u = q.url(); if (!(u === DOC_URL && q.frame() === page.mainFrame() && q.isNavigationRequest()) && !/^data:/i.test(u)) pogingen++; });
        await page.goto(DOC_URL, { waitUntil: 'load', timeout: rest() });
        return page.pdf({ format: 'A4', printBackground: true, displayHeaderFooter: true, headerTemplate: kopTemplate(st), footerTemplate: voetTemplate(st),
          margin: { top: !st ? '16mm' : staand(st) ? '42mm' : '34mm', bottom: '18mm', left: '18mm', right: '18mm' }, timeout: rest() });
      })();
      const grens = new Promise(function (res, rej) { timer = setTimeout(function () { rej(Object.assign(new Error('tijd'), { tijd: true })); }, rest()); });
      const buf = await Promise.race([werk, grens]);
      werk.catch(function () {});
      return { buf: buf, pogingen: pogingen, sandbox: sandbox };
    } finally {
      clearTimeout(timer);
      await Promise.race([browser.close().catch(function () {}), new Promise(function (r) { setTimeout(r, 5000); })]);
    }
  }

  // Witte lijst van AST-knopen (pandoc-types 1.22) voor de docx-stap zonder --sandbox (review KAN 9): alles wat er niet in staat, weigert.
  const AST_TOEGESTAAN = new Set(['Str', 'Emph', 'Underline', 'Strong', 'Strikeout', 'Superscript', 'Subscript', 'SmallCaps', 'Quoted', 'Cite', 'Code',
    'Space', 'SoftBreak', 'LineBreak', 'Math', 'Link', 'Note', 'Span', 'Plain', 'Para', 'LineBlock', 'CodeBlock', 'BlockQuote', 'OrderedList', 'BulletList',
    'DefinitionList', 'Header', 'HorizontalRule', 'Table', 'Div', 'Null', 'AlignLeft', 'AlignRight', 'AlignCenter', 'AlignDefault', 'ColWidth',
    'ColWidthDefault', 'SingleQuote', 'DoubleQuote', 'DisplayMath', 'InlineMath', 'DefaultStyle', 'Example', 'Decimal', 'LowerRoman', 'UpperRoman',
    'LowerAlpha', 'UpperAlpha', 'DefaultDelim', 'Period', 'OneParen', 'TwoParens', 'AuthorInText', 'SuppressAuthor', 'NormalCitation']);
  function alleenToegestaan(json) {
    const re = /"t":"([^"]*)"/g; let m;
    while ((m = re.exec(json))) if (!AST_TOEGESTAAN.has(m[1])) throw new Error('AST niet schoon (' + m[1].slice(0, 20) + ')');
  }
  async function docx(d, st, dir, tot) {
    const ast = await astVan(d, dir, tot);
    const eerste = ast.blocks[0];
    if (!(eerste && eerste.t === 'Header' && eerste.c[0] === 1)) ast.blocks.unshift({ t: 'Header', c: [1, ['', [], []], [{ t: 'Str', c: d.basis }]] });
    const ref = path.join(dir, 'ref.docx'), uit = path.join(dir, 'uit.docx');
    const b64 = st ? st.docx : HS && HS.NEUTRAAL_DOCX;
    const args = ['-f', 'json', '-t', 'docx', '-o', uit];
    if (b64) { fs.writeFileSync(ref, Buffer.from(b64, 'base64'), { mode: 0o600 }); args.push('--reference-doc', ref); }
    const json = JSON.stringify(ast);
    alleenToegestaan(json);
    await pandoc(args, json, dir, tot, true);
    return fs.readFileSync(uit);
  }

  // wv1893: .docx → markdown (gfm, geen regelafbreking). Beide stappen in de sandbox; beelden worden hun alt-tekst, alleen http(s)-links.
  async function markdown(d, dir, tot) {
    const ruw = await pandoc(['-f', 'docx', '-t', 'json'], Buffer.from(d.tekst, 'base64'), dir, tot);
    const ast = schoon(JSON.parse(ruw.toString('utf8')));
    ast.meta = {};
    const json = JSON.stringify(ast);
    alleenToegestaan(json);
    return pandoc(['-f', 'json', '-t', 'gfm', '--wrap=none'], json, dir, tot);
  }

  async function xlsx(d, dir, tot) {
    const lijst = tabellen(await astVan(d, dir, tot));
    if (!lijst.length) return null;
    return XLSX.schrijf(lijst);
  }

  // Bovengrens voor het aantal tabelregels (md: regels met een |, html: <tr, csv: regels): daarboven geen PDF (review MOET 2).
  function tabelRijen(d) {
    const t = String(d.tekst);
    if (d.soort === 'html') return (t.match(/<tr[\s>]/gi) || []).length;
    if (d.soort === 'csv') return (t.match(/\n/g) || []).length + 1;
    if (d.soort === 'md') return (t.match(/^[^\n]*\|[^\n]*$/gm) || []).length;
    return 0;
  }

  // Invoer controleren; geeft {fout, status} of de schone invoer.
  function invoer(d) {
    d = d || {};
    const formaat = String(d.formaat || '');
    if (!FORMATEN[formaat]) return { status: 400, fout: 'kies pdf, docx, xlsx of md' };
    const soort = String(d.soort || 'md');
    if (SOORTEN.indexOf(soort) < 0) return { status: 400, fout: 'onbekende soort tekst' };
    if (typeof d.tekst !== 'string') return { status: 400, fout: 'tekst ontbreekt' };
    if ((soort === 'docx') !== (formaat === 'md')) return { status: 400, fout: soort === 'docx' ? 'een Word-bestand kan alleen naar markdown' : 'markdown alleen uit een Word-bestand' };
    let bytes;
    if (soort === 'docx') {   // wv1893: tekst = de .docx in base64
      if (d.tekst.length > Math.ceil(MAX_DOCX / 3) * 4 + 4) return { status: 413, fout: 'het Word-bestand is te groot om naar markdown om te zetten (hooguit 3,5 MB zonder afbeeldingen)' };
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(d.tekst)) return { status: 400, fout: 'het Word-bestand komt niet goed door (geen base64)' };
      const buf = Buffer.from(d.tekst, 'base64');
      bytes = buf.length;
      if (bytes > MAX_DOCX) return { status: 413, fout: 'het Word-bestand is te groot om naar markdown om te zetten (hooguit 3,5 MB zonder afbeeldingen)' };
      if (bytes < 4 || buf.readUInt32LE(0) !== 0x04034b50) return { status: 400, fout: 'dit is geen Word-bestand (.docx)' };
    } else {
      bytes = Buffer.byteLength(d.tekst, 'utf8');
      if (bytes > MAX_TEKST) return { status: 413, fout: 'de tekst is te groot om om te zetten (' + (bytes / 1048576).toFixed(1) + ' MB; hooguit 2 MB)' };
    }
    const hs = d.huisstijl == null || d.huisstijl === '' || d.huisstijl === 'neutraal' ? '' : String(d.huisstijl);
    if (hs && !Object.prototype.hasOwnProperty.call(STIJLEN, hs)) return { status: 400, fout: 'onbekende huisstijl' };
    if (hs && (formaat === 'xlsx' || formaat === 'md')) return { status: 400, fout: FORMAAT_NAAM[formaat] + ' heeft geen huisstijl' };
    let basis = String(d.naam || '').split(/[\\/]/).pop().replace(/\.(md|markdown|txt|csv|html?|json|docx)$/i, '')
      .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120).trim();
    if (!basis || /^\.+$/.test(basis)) basis = 'document';
    const x = { formaat: formaat, soort: soort, tekst: d.tekst, bytes: bytes, huisstijl: hs, basis: basis };
    if (formaat === 'pdf' && tabelRijen(x) > MAX_PDF_RIJEN)
      return { status: 413, fout: 'deze tekst heeft meer dan ' + MAX_PDF_RIJEN.toLocaleString('nl-NL') + ' tabelregels; dat wordt als PDF te zwaar. Kies Excel (of Word).' };
    return x;
  }

  // Het eigenlijke werk (in het kindproces, of in-proces vanaf de opdrachtregel): → {status?, buf?, fout?, e?, pogingen?, sandbox?}
  async function intern(d, dir) {
    const st = d.huisstijl ? STIJLEN[d.huisstijl] : null;
    const tot = Date.now() + tijdMs;
    try {
      if (d.formaat === 'pdf') return Object.assign({}, await pdf(await htmlVoorPdf(d, st, dir, tot), st, tot));
      if (d.formaat === 'docx') return { buf: await docx(d, st, dir, tot) };
      if (d.formaat === 'md') return { buf: await markdown(d, dir, tot) };
      const x = await xlsx(d, dir, tot);
      if (!x) return { status: 422, fout: 'er staat geen tabel in deze tekst' };
      return { buf: x };
    } catch (e) {
      if ((e && e.tijd) || Date.now() >= tot) return { status: 504, fout: 'het omzetten duurde te lang (meer dan ' + Math.round(tijdMs / 1000) + ' s); probeer een kortere tekst' };   // ook een time-out van Playwright zelf
      if (e && e.groot) return { status: 413, fout: (d.soort === 'docx' ? 'het Word-bestand' : 'de tekst') + ' is te groot om om te zetten naar ' + FORMAAT_NAAM[d.formaat] };
      return { status: 500, fout: 'omzetten mislukt', e: String(e && e.message || e).split('\n')[0].slice(0, 200) };
    }
  }

  // ── kindproces en bewaking ──
  // Procesboom vanaf pid (via /proc: ppid), want Chromium start in een eigen procesgroep.
  function boom(pid) {
    const kinderen = new Map();
    let lijst = [];
    try { lijst = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)); } catch (e) { return [pid]; }
    for (const x of lijst) {
      let st;
      try { st = fs.readFileSync('/proc/' + x + '/stat', 'utf8'); } catch (e) { continue; }
      const na = st.slice(st.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(na[1]);
      if (!kinderen.has(ppid)) kinderen.set(ppid, []);
      kinderen.get(ppid).push(Number(x));
    }
    const uit = [], rij = [pid];
    while (rij.length && uit.length < 500) { const p = rij.shift(); uit.push(p); (kinderen.get(p) || []).forEach((k) => rij.push(k)); }
    return uit;
  }
  function rss(pids) {
    let n = 0;
    for (const p of pids) { try { n += Number(fs.readFileSync('/proc/' + p + '/statm', 'utf8').split(' ')[1]) * 4096; } catch (e) { /* weg */ } }
    return n;
  }
  function doodBoom(pid) {
    const pids = boom(pid);
    for (const p of pids.reverse()) { try { process.kill(p, 'SIGKILL'); } catch (e) { /* al weg */ } }
    return pids.length;
  }

  function viaKind(d, dir) {
    return new Promise(function (resolve) {
      const invoerPad = path.join(dir, 'invoer.json'), uitPad = path.join(dir, 'uit.json');
      fs.writeFileSync(invoerPad, JSON.stringify({ d: d, opt: { pandoc: opt.pandoc, chromium: opt.chromium, pw: opt.pw, tijdMs: tijdMs, dir: dir } }), { mode: 0o600 });
      // kale omgeving: geen sleutels van server.js in het kind, pandoc of Chromium; tijdelijke bestanden (ook het Chromium-profiel) in dir
      const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: dir, TMPDIR: dir, LANG: 'C.UTF-8',
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers' };
      const kind = spawn(process.execPath, ['--max-old-space-size=' + KIND_HEAP_MB, __filename, '--werker', invoerPad, uitPad], { cwd: dir, env: env, stdio: 'ignore' });
      let klaar = false;
      const einde = function (r) {
        if (klaar) return; klaar = true;
        clearTimeout(hard); clearInterval(wacht);
        resolve(r);
      };
      const hard = setTimeout(function () { doodBoom(kind.pid); einde({ status: 504, fout: 'het omzetten duurde te lang (meer dan ' + Math.round(tijdMs / 1000) + ' s); probeer een kortere tekst', hard: true }); }, opt.hardTotMs || tijdMs + HARD_MS);   // hardTotMs: alleen voor de toets
      const wacht = setInterval(function () {
        if (rss(boom(kind.pid)) > (opt.maxRss || MAX_RSS)) { doodBoom(kind.pid); einde({ status: 413, fout: 'deze tekst is te groot om om te zetten (te veel geheugen nodig); kies een kleiner stuk of Excel', geheugen: true }); }
      }, 200);
      kind.on('error', function (e) { einde({ status: 500, fout: 'omzetten mislukt', e: 'kind: ' + e.message }); });
      kind.on('exit', function (code) {
        if (klaar) return;
        doodBoom(kind.pid);   // achterblijvers (Chromium in een eigen procesgroep)
        let r = null;
        try { r = JSON.parse(fs.readFileSync(uitPad, 'utf8')); } catch (e) { /* geen uitkomst */ }
        if (!r) return einde({ status: 500, fout: 'omzetten mislukt', e: 'kind stopte met code ' + code + ' zonder uitkomst' });
        if (r.buf) { try { r.buf = fs.readFileSync(path.join(dir, 'uit.bin')); } catch (e) { return einde({ status: 500, fout: 'omzetten mislukt', e: 'uitvoer onleesbaar' }); } }
        einde(r);
      });
    });
  }

  // Eén tegelijk; hooguit WACHT_MAX in de rij, elk hooguit WACHT_MS. Bij het afgeven blijft bezig waar (geen inhaler tussendoor).
  function beurt(fn) {
    return new Promise(function (resolve) {
      const start = function () {
        staat.bezig = true;
        Promise.resolve().then(fn).then(resolve, function (e) { resolve({ status: 500, fout: 'omzetten mislukt', e: e }); }).finally(function () {
          const volgende = staat.rij.shift();
          if (volgende) volgende.ga(); else staat.bezig = false;
        });
      };
      if (!staat.bezig) return start();
      if (staat.rij.length >= WACHT_MAX) return resolve({ status: 503, fout: 'er worden nu al ' + (WACHT_MAX + 1) + ' bestanden gemaakt; probeer het zo opnieuw' });
      const plek = { ga: function () { clearTimeout(plek.t); start(); } };
      plek.t = setTimeout(function () {
        const i = staat.rij.indexOf(plek);
        if (i >= 0) staat.rij.splice(i, 1);
        resolve({ status: 503, fout: 'het is nu druk; probeer het zo opnieuw' });
      }, WACHT_MS);
      staat.rij.push(plek);
    });
  }

  // → {status, j, audit}
  async function omzet(ruw) {
    const d = invoer(ruw);
    if (d.fout) return { status: d.status, j: { ok: false, fout: d.fout }, audit: { formaat: String(ruw && ruw.formaat || '').slice(0, 8), status: d.status } };
    const st = d.huisstijl ? STIJLEN[d.huisstijl] : null;
    const audit = { formaat: d.formaat, soort: d.soort, huisstijl: d.huisstijl || '-', in_kb: Math.ceil(d.bytes / 1024) };
    const t0 = Date.now();
    const r = await beurt(async function () {
      staat.gestart++;
      const dir = fs.mkdtempSync(path.join(TMP, 'omzet-'));   // 0700
      try { return opt.inProces ? await intern(d, dir) : await viaKind(d, dir); }
      finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { fout('omzet-tmp', e); } }
    });
    audit.ms = Date.now() - t0;
    if (r.pogingen !== undefined) audit.pogingen = r.pogingen;
    if (r.sandbox !== undefined) staat.sandbox = r.sandbox;
    if (r.hard) audit.afgebroken = 'tijd';
    if (r.geheugen) audit.afgebroken = 'geheugen';
    let status = r.status || 200, j;
    if (r.buf && r.buf.length > MAX_UIT) { status = 413; j = { ok: false, fout: 'het bestand wordt te groot (meer dan 25 MB)' }; }
    else if (r.buf) {
      const f = FORMATEN[d.formaat];
      j = { ok: true, naam: d.basis + (d.huisstijl ? ' (' + (st.label || d.huisstijl) + ')' : '') + '.' + f.ext, type: f.type, grootte: r.buf.length, inhoud: r.buf.toString('base64'), ms: audit.ms };
      audit.uit_kb = Math.ceil(r.buf.length / 1024);
    } else j = { ok: false, fout: r.fout || 'omzetten mislukt' };
    if (r.e) fout('omzet-' + d.formaat, new Error(String(r.e && r.e.message || r.e).split('\n')[0].slice(0, 200)));
    if (status === 200) staat.ok++; else staat.mislukt++;
    staat.laatst = { op: new Date().toISOString(), formaat: d.formaat, status: status, ms: audit.ms };
    audit.status = status;
    return { status: status, j: j, audit: audit };
  }

  function health() {
    return { aan: true, pandoc: fs.existsSync(PANDOC), chromium: !!chromiumPad(), sandbox: staat.sandbox, huisstijlen: Object.keys(STIJLEN).length, bezig: staat.bezig,
      wachtend: staat.rij.length, ok: staat.ok, mislukt: staat.mislukt, laatst: staat.laatst };
  }
  function stijlen() { return Object.keys(STIJLEN).map(function (k) { return { id: k, label: STIJLEN[k].label }; }); }

  return { omzet: omzet, intern: intern, health: health, stijlen: stijlen, invoer: invoer, _staat: staat, _boom: boom };
}

module.exports = { maak: maak, schoon: schoon, tabellen: tabellen, voorMd: voorMd, tekstHtml: tekstHtml, platteTekst: platteTekst,
  MAX_TEKST: MAX_TEKST, MAX_PDF_RIJEN: MAX_PDF_RIJEN, MAX_DOCX: MAX_DOCX, CSP: CSP, kopTemplate: kopTemplate, voetTemplate: voetTemplate };

// ── kindproces: node omzet.js --werker <invoer.json> <uit.json> (alleen door viaKind gestart) ──
if (require.main === module && process.argv[2] === '--werker') {
  const [invoerPad, uitPad] = process.argv.slice(3);
  const x = JSON.parse(fs.readFileSync(invoerPad, 'utf8'));
  fs.unlinkSync(invoerPad);
  maak(Object.assign({}, x.opt, { inProces: true })).intern(x.d, x.opt.dir).then(function (r) {
    const uit = { status: r.status, fout: r.fout, e: r.e, pogingen: r.pogingen, sandbox: r.sandbox, buf: !!r.buf };
    if (r.buf) fs.writeFileSync(path.join(path.dirname(uitPad), 'uit.bin'), r.buf, { mode: 0o600 });
    fs.writeFileSync(uitPad, JSON.stringify(uit), { mode: 0o600 });
    process.exit(0);
  }, function (e) {
    fs.writeFileSync(uitPad, JSON.stringify({ status: 500, fout: 'omzetten mislukt', e: String(e && e.message || e).split('\n')[0].slice(0, 200) }), { mode: 0o600 });
    process.exit(0);
  });
} else if (require.main === module) {   // ── opdrachtregel (Socev, bouwplan § 3.3) ──
  const a = process.argv.slice(2);
  const opties = {};
  const los = [];
  for (let i = 0; i < a.length; i++) { if (a[i] === '--huisstijl' || a[i] === '--soort') opties[a[i].slice(2)] = a[++i]; else los.push(a[i]); }
  const [formaat, inPad, uitPad] = los;
  if (!FORMATEN[formaat] || !inPad || !uitPad) {
    console.error('gebruik: node omzet.js <pdf|docx|xlsx|md> [--huisstijl <' + Object.keys((function () { try { return require('./omzet-huisstijl.js').STIJLEN; } catch (e) { return {}; } })()).join('|') + '>] [--soort md|html|csv|tekst|docx] <in> <uit>   (md alleen uit een .docx)');
    process.exit(2);
  }
  const ext = path.extname(inPad).toLowerCase();
  const soort = opties.soort || (ext === '.html' || ext === '.htm' ? 'html' : ext === '.csv' ? 'csv' : ext === '.txt' ? 'tekst' : ext === '.docx' ? 'docx' : 'md');
  maak({ inProces: true, fout: function (w, e) { console.error(w + ': ' + (e && e.message)); } })
    .omzet({ naam: path.basename(inPad), soort: soort, tekst: fs.readFileSync(inPad, soort === 'docx' ? 'base64' : 'utf8'), formaat: formaat, huisstijl: opties.huisstijl })
    .then(function (r) {
      if (r.status !== 200) { console.error('mislukt (' + r.status + '): ' + r.j.fout); process.exit(1); }
      fs.writeFileSync(uitPad, Buffer.from(r.j.inhoud, 'base64'));
      console.log(uitPad + ' (' + r.j.grootte + ' bytes, ' + r.j.ms + ' ms)');
    });
}
