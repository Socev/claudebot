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
// Alles in een eigen tijdelijke map (0700) die na afloop weg is. In log en audit alleen formaat, soort, huisstijl, grootte, ms, pogingen.
//
// Ook voor Socev zelf (bouwplan § 3.3): node /app/omzet.js <pdf|docx|xlsx> [--huisstijl <sleutel>] [--soort md|html|csv|tekst] <in> <uit>
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
const SOORTEN = ['md', 'html', 'csv', 'tekst'];
const FORMATEN = {
  pdf: { ext: 'pdf', type: 'application/pdf' },
  docx: { ext: 'docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { ext: 'xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
};
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
  s = s.replace(/^(\s*>\s*)\[!([\w-]+)\][+-]?[ \t]*(.*)$/gm, (m, p, soort, titel) =>   // callout: titel vet als eigen alinea
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
const TPL_FONT = 'font-family:\'Liberation Sans\',Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box;width:100%;';
function kopTemplate(st) {
  if (!st) return '<span></span>';
  const k = st.kleuren, b = st.briefhoofd || {};
  const lijn = 'border-bottom:1px solid #' + k.lijn + ';';
  if (st.logo) {
    return '<div style="' + TPL_FONT + 'padding:9mm 18mm 0"><div style="padding-bottom:2mm;' + lijn + '">' +
      '<img src="' + st.logo + '" style="height:' + (st.logo_maat && st.logo_maat[0] < 2 * st.logo_maat[1] ? 20 : 14) + 'mm;width:auto;display:block"></div></div>';   // rechtop logo (Tolgaarde) wat groter
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
    // html: zoals het is (JS staat uit, CSP en het routeslot houden alles buiten); alleen een meta-refresh eruit
    return String(d.tekst).replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, '');
  }

  async function pdf(html, st, tot) {
    const exe = chromiumPad();
    if (!exe) throw new Error('chromium ontbreekt');
    const rest = function () { return Math.max(1, tot - Date.now()); };
    let pogingen = 0;
    const browser = await pw().chromium.launch({ executablePath: exe, headless: true, timeout: rest(),
      args: ['--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-default-apps',
        '--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-component-update', '--disable-domain-reliability'] });
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
          margin: { top: st ? '34mm' : '16mm', bottom: '18mm', left: '18mm', right: '18mm' }, timeout: rest() });
      })();
      const grens = new Promise(function (res, rej) { timer = setTimeout(function () { rej(Object.assign(new Error('tijd'), { tijd: true })); }, rest()); });
      const buf = await Promise.race([werk, grens]);
      werk.catch(function () {});
      return { buf: buf, pogingen: pogingen };
    } finally {
      clearTimeout(timer);
      await Promise.race([browser.close().catch(function () {}), new Promise(function (r) { setTimeout(r, 5000); })]);
    }
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
    if (/"t":"(Image|RawInline|RawBlock)"/.test(json)) throw new Error('AST niet schoon');
    await pandoc(args, json, dir, tot, true);
    return fs.readFileSync(uit);
  }

  async function xlsx(d, dir, tot) {
    const lijst = tabellen(await astVan(d, dir, tot));
    if (!lijst.length) return null;
    return XLSX.schrijf(lijst);
  }

  // Invoer controleren; geeft {fout, status} of de schone invoer.
  function invoer(d) {
    d = d || {};
    const formaat = String(d.formaat || '');
    if (!FORMATEN[formaat]) return { status: 400, fout: 'kies pdf, docx of xlsx' };
    const soort = String(d.soort || 'md');
    if (SOORTEN.indexOf(soort) < 0) return { status: 400, fout: 'onbekende soort tekst' };
    if (typeof d.tekst !== 'string') return { status: 400, fout: 'tekst ontbreekt' };
    const bytes = Buffer.byteLength(d.tekst, 'utf8');
    if (bytes > MAX_TEKST) return { status: 413, fout: 'de tekst is te groot om om te zetten (' + (bytes / 1048576).toFixed(1) + ' MB; hooguit 2 MB)' };
    const hs = d.huisstijl == null || d.huisstijl === '' || d.huisstijl === 'neutraal' ? '' : String(d.huisstijl);
    if (hs && !Object.prototype.hasOwnProperty.call(STIJLEN, hs)) return { status: 400, fout: 'onbekende huisstijl' };
    if (hs && formaat === 'xlsx') return { status: 400, fout: 'Excel heeft geen huisstijl' };
    let basis = String(d.naam || '').split(/[\\/]/).pop().replace(/\.(md|markdown|txt|csv|html?|json)$/i, '')
      .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120).trim();
    if (!basis || /^\.+$/.test(basis)) basis = 'document';
    return { formaat: formaat, soort: soort, tekst: d.tekst, bytes: bytes, huisstijl: hs, basis: basis };
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
    if (d.fout) return { status: d.status, j: { ok: false, fout: d.fout }, audit: { formaat: String(ruw && ruw.formaat || '').slice(0, 8) } };
    const st = d.huisstijl ? STIJLEN[d.huisstijl] : null;
    const audit = { formaat: d.formaat, soort: d.soort, huisstijl: d.huisstijl || '-', in_kb: Math.ceil(d.bytes / 1024) };
    const t0 = Date.now();
    const r = await beurt(async function () {
      staat.gestart++;
      const tot = Date.now() + tijdMs;
      const dir = fs.mkdtempSync(path.join(TMP, 'omzet-'));   // 0700
      try {
        if (d.formaat === 'pdf') {
          const p = await pdf(await htmlVoorPdf(d, st, dir, tot), st, tot);
          audit.pogingen = p.pogingen;
          return { buf: p.buf };
        }
        if (d.formaat === 'docx') return { buf: await docx(d, st, dir, tot) };
        const x = await xlsx(d, dir, tot);
        if (!x) return { status: 422, fout: 'er staat geen tabel in deze tekst' };
        return { buf: x };
      } catch (e) {
        if (e && e.tijd) return { status: 504, fout: 'het omzetten duurde te lang (meer dan ' + Math.round(tijdMs / 1000) + ' s); probeer een kortere tekst' };
        if (e && e.groot) return { status: 413, fout: 'de tekst is te groot om om te zetten' };
        return { status: 500, fout: 'omzetten mislukt', e: e };
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { fout('omzet-tmp', e); }
      }
    });
    audit.ms = Date.now() - t0;
    let status = r.status || 200, j;
    if (r.buf && r.buf.length > MAX_UIT) { status = 413; j = { ok: false, fout: 'het bestand wordt te groot (meer dan 25 MB)' }; }
    else if (r.buf) {
      const f = FORMATEN[d.formaat];
      j = { ok: true, naam: d.basis + (d.huisstijl ? ' (' + (st.label || d.huisstijl) + ')' : '') + '.' + f.ext, type: f.type, grootte: r.buf.length, inhoud: r.buf.toString('base64'), ms: audit.ms };
      audit.uit_kb = Math.ceil(r.buf.length / 1024);
    } else j = { ok: false, fout: r.fout };
    if (r.e) fout('omzet-' + d.formaat, new Error(String(r.e && r.e.message || r.e).split('\n')[0].slice(0, 200)));
    if (status === 200) staat.ok++; else staat.mislukt++;
    staat.laatst = { op: new Date().toISOString(), formaat: d.formaat, status: status, ms: audit.ms };
    audit.status = status;
    return { status: status, j: j, audit: audit };
  }

  function health() {
    return { aan: true, pandoc: fs.existsSync(PANDOC), chromium: !!chromiumPad(), huisstijlen: Object.keys(STIJLEN).length, bezig: staat.bezig,
      wachtend: staat.rij.length, ok: staat.ok, mislukt: staat.mislukt, laatst: staat.laatst };
  }
  function stijlen() { return Object.keys(STIJLEN).map(function (k) { return { id: k, label: STIJLEN[k].label }; }); }

  return { omzet: omzet, health: health, stijlen: stijlen, invoer: invoer, _staat: staat };
}

module.exports = { maak: maak, schoon: schoon, tabellen: tabellen, voorMd: voorMd, tekstHtml: tekstHtml, platteTekst: platteTekst,
  MAX_TEKST: MAX_TEKST, CSP: CSP, kopTemplate: kopTemplate, voetTemplate: voetTemplate };

// ── opdrachtregel (Socev, bouwplan § 3.3) ──
if (require.main === module) {
  const a = process.argv.slice(2);
  const opties = {};
  const los = [];
  for (let i = 0; i < a.length; i++) { if (a[i] === '--huisstijl' || a[i] === '--soort') opties[a[i].slice(2)] = a[++i]; else los.push(a[i]); }
  const [formaat, inPad, uitPad] = los;
  if (!FORMATEN[formaat] || !inPad || !uitPad) {
    console.error('gebruik: node omzet.js <pdf|docx|xlsx> [--huisstijl <' + Object.keys((function () { try { return require('./omzet-huisstijl.js').STIJLEN; } catch (e) { return {}; } })()).join('|') + '>] [--soort md|html|csv|tekst] <in> <uit>');
    process.exit(2);
  }
  const ext = path.extname(inPad).toLowerCase();
  const soort = opties.soort || (ext === '.html' || ext === '.htm' ? 'html' : ext === '.csv' ? 'csv' : ext === '.txt' ? 'tekst' : 'md');
  maak({ fout: function (w, e) { console.error(w + ': ' + (e && e.message)); } })
    .omzet({ naam: path.basename(inPad), soort: soort, tekst: fs.readFileSync(inPad, 'utf8'), formaat: formaat, huisstijl: opties.huisstijl })
    .then(function (r) {
      if (r.status !== 200) { console.error('mislukt (' + r.status + '): ' + r.j.fout); process.exit(1); }
      fs.writeFileSync(uitPad, Buffer.from(r.j.inhoud, 'base64'));
      console.log(uitPad + ' (' + r.j.grootte + ' bytes, ' + r.j.ms + ' ms)');
    });
}
