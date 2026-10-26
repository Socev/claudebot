'use strict';
// OVIS Docs — Delen › Openbaar (wv1382, stap c; bouwplan "01_Ontwikkeling/OVIS Docs - bouwplan (26-10-2026).md" § 3.3, Opus-review § 7 #7–#11).
// WAAROM. David (26-10 15:31): "Nu zet ik vaak dingen over in PDF om te delen met anderen - maar PDF moet de wereld uit... Maar de meeste
// mensen kunnen niet overweg met Markdown." Hij drukt in de App Docs op Delen en krijgt een link naar een nette, leesbare pagina op
// deel.socev.dev; onder Gedeeld ziet hij wat er buiten staat en trekt hij een deling met één knop in. Davids Ja op het subdomein: 26-10 21:58.
//
// Werking. De pod rendert de markdown zelf (escapende renderer, afgeleid van socev-site build.js; wikilinks → platte tekst, alleen
// http(s)-links, %%…%% en <!-- --> eruit) tot één HTML-pagina in de publieke stijl (licht, schreefloos, geen meta). De App toont David
// vooraf precies die pagina; delen kan alleen met de sha van wat hij zag. De HTML gaat via de Cloudflare D1-API in de tabel `deel`; de
// Pages Function op deel.socev.dev (socev-app/deel/worker.js) geeft hem onder /p/<slug> terug. Intrekken = D1-rij weg: de volgende
// aanvraag is 404, de inhoud zat nooit in een deployment of git.
//
// Poort vóór elke deling (grondwet 2 en 3; review #8):
// - nooit te delen: alles wat op een vaste plek dicht of verborgen is (Privé, Gesprekken, personeel, bronnen), 00_Systeem, Beveiliging,
//   dossier-, patiënt-, personeels- en gespreksmappen, en de pagina's die Socev zelf bijhoudt;
// - het masker van secondbrain.js met IBAN en BSN aan, op de gerenderde tekst incl. titel, linklabels en linkadressen: treffer = weigeren;
// - namen (contactenlijst + medewerkerspagina's, zoals socev-site namenpoort.js toetsProza): de App toont de namen en David bevestigt
//   expliciet (niet zelf weghalen: geheugen publiceren-niet-zelf-sanitiseren). Is de namenlijst niet te lezen, dan is de poort dicht.
// Slug alleen willekeurig (geen naam in de URL). Register /opt/data/docs/gedeeld.json (0600): pad-HMAC ↔ slug, soort, titel, sinds, sha256.
// Het register bevat de slugs (= de links); het auditlog nooit (alleen domein + HMAC van het pad).
//
// Beveiligd (wv1383, stap d; bouwplan § 3.4, review #7 en #9). David kiest 1–10 mailadressen; per deling maakt de pod een eigen
// Cloudflare Access-app op deel.socev.dev/b/<slug> (beleid: precies die adressen, alleen One-time PIN, sessie 24 u). Een padspecifieke app
// wint van de app op het hele subdomein (alleen David). De Function controleert daarnaast zelf de Access-JWT (aud van die app, mail in de
// ontvangers: D1 bewaart alleen sha256 van elk adres). Toestaanlijst (review #9): de pod raakt alleen Access-apps waarvan het domein precies
// deel.socev.dev/b/<slug> is, met een slug die in het deelregister staat (gedeeld.json, of D1 bij opruimen); bij wijzigen en verwijderen eerst
// de app ophalen en het domein vergelijken. server.js bewaakt het nog eens (alleen access/apps[/<uuid>], alleen dat domein in de body).
// Geen nieuwe sleutels of credentials: het pod-token dat de Access-apps al beheerde. Van soort wisselen kan niet (eerst intrekken).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_HTML = 1536 * 1024;      // D1: rij ≤ 2 MB
const MAX_NAMEN = 25;
const NAMEN_VERS_MS = 10 * 60 * 1000;
const ALLEEN_LEZEN_NAAM = ['actueel.md', 'claude.md', 'claude.local.md', 'agents.md'];
const NOOIT_MAPDEEL = /(beveiliging|dossier|patient|patiënt|client|cliënt|sollicit|medewerker|personeel|gesprek)/i;
const SLUG_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_ONTVANGERS = 10;
const MAIL_RE = /^[a-z0-9._%+'-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const mailHash = (m) => crypto.createHash('sha256').update(String(m).trim().toLowerCase(), 'utf8').digest('hex');

// Mailadressen van David → schone lijst (kleine letters, uniek) of een fout in gewone taal.
function ontvangersUit(lijst) {
  const ruw = Array.isArray(lijst) ? lijst : typeof lijst === 'string' ? lijst.split(/[\s,;]+/) : [];
  const uit = [];
  for (const x of ruw) {
    const m = String(x == null ? '' : x).trim().toLowerCase();
    if (!m) continue;
    if (m.length > 254 || !MAIL_RE.test(m) || m.indexOf('..') >= 0) return { fout: '"' + String(x).slice(0, 80) + '" is geen mailadres' };
    if (uit.indexOf(m) < 0) uit.push(m);
  }
  if (!uit.length) return { fout: 'vul minstens één mailadres in' };
  if (uit.length > MAX_ONTVANGERS) return { fout: 'hooguit ' + MAX_ONTVANGERS + ' mailadressen per pagina' };
  return { lijst: uit };
}

// ── renderer ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Bewust klein en voorspelbaar (zoals build.js): eerst alles escapen, daarna alleen vaste tags invoegen. Geen ruwe HTML, geen scripts,
// geen beelden (de CSP van de Function laat alleen data:-beelden toe; een beeld toont zijn alt-tekst).
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const ontEsc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// Wat niet zichtbaar hoort: frontmatter, BOM, Obsidian-commentaar %%…%% (ook open tot het eind, zoals Obsidian) en HTML-commentaar.
function voorbewerk(src) {
  let s = String(src == null ? '' : src).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');   // stuurtekens (o.a. de plaatshouders van inline) eruit
  s = s.replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*(\n|$)/, '');
  s = s.replace(/%%[\s\S]*?(%%|$)/g, '');
  s = s.replace(/<!--[\s\S]*?(-->|$)/g, '');
  return vouwLijstitemsTerug(s);
}

// Zachte regelafbreking binnen een lijstitem terugvouwen (uit socev-site publiceer-vaultpagina.js): de vault breekt lange regels op
// ± 100 tekens; zonder dit valt één punt uiteen in een halve zin plus een losse alinea.
function vouwLijstitemsTerug(src) {
  const uit = [];
  let inItem = false;
  for (const regel of src.split('\n')) {
    const m = regel.match(/^(\s*>\s?)?(.*)$/);
    const prefix = m[1] || '', kaal = m[2];
    const isItem = /^\s*([-*+]|\d+[.)])\s+/.test(kaal);
    const isVervolg = /^\s{2,}\S/.test(kaal);
    if (inItem && isVervolg && !isItem && !/^\s*(```|~~~)/.test(kaal)) { uit[uit.length - 1] += ' ' + kaal.trim(); continue; }
    if (isItem) inItem = true;
    else if (kaal.trim() === '' || !isVervolg) inItem = false;
    uit.push(prefix + kaal);
  }
  return uit.join('\n');
}

const wikiLabel = (binnen) => {
  const delen = binnen.split(/\\?\|/);
  if (delen.length > 1 && delen.slice(1).join('|').trim()) return delen.slice(1).join('|').trim();
  const [pad, kop] = delen[0].split('#');
  return (pad.split('/').pop().replace(/\.md$/i, '') || (kop || '').trim()).trim();
};

function maakInline(hrefs) {
  return function inline(s) {
    let t = esc(s);
    const stuk = [];
    const zet = (html) => { stuk.push(html); return '\u0001' + (stuk.length - 1) + '\u0001'; };
    t = t.replace(/`([^`\n]+)`/g, (m, c) => zet('<code>' + c + '</code>'));
    t = t.replace(/!\[\[[^\]\n]*\]\]/g, '');                                       // embed: inhoud staat niet online
    t = t.replace(/\[\[([^\[\]\n]+?)\]\]/g, (m, b) => wikiLabel(ontEsc(b)) ? esc(wikiLabel(ontEsc(b))) : '');
    t = t.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, (m, alt) => alt);                 // beeld → alt-tekst
    t = t.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^\n]*?&quot;)?\)/g, (m, l, u) => {
      const echt = ontEsc(u).replace(/^<|>$/g, '');
      if (!/^https?:\/\/[^\s]+$/i.test(echt)) return l;
      hrefs.push(echt);
      return zet('<a href="' + esc(echt) + '" rel="noopener noreferrer nofollow">') + l + zet('</a>');
    });
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<\u0001]+[^\s<.,;:!?)\u0001'"])/g, (m, voor, u) => {
      const echt = ontEsc(u);
      hrefs.push(echt);
      return voor + zet('<a href="' + esc(echt) + '" rel="noopener noreferrer nofollow">' + u + '</a>');
    });
    t = t.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^\w])__([^_\n]+)__(?!\w)/g, '$1<strong>$2</strong>');
    t = t.replace(/(^|[^*])\*([^*\s][^*\n]*?)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>').replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
    for (let i = 0; i < 3 && /\u0001\d+\u0001/.test(t); i++) t = t.replace(/\u0001(\d+)\u0001/g, (m, n) => stuk[Number(n)]);
    return t;
  };
}

function markdownNaarHtml(src, inline) {
  const regels = src.split('\n');
  const uit = [];
  let i = 0;
  const lijst = [];   // [{tag, ind}]
  const sluitLijst = (tot) => { while (lijst.length > (tot || 0)) uit.push('</li></' + lijst.pop().tag + '>'); };
  const isTabelScheiding = (r) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(r) && /-/.test(r) && /\|/.test(r);
  const cellen = (rij) => rij.replace(/\\\|/g, '\u0002').replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.replace(/\u0002/g, '\\|').trim());
  const blokStart = /^(#{1,6}\s|>|```|~~~|\s*([-*+]|\d+[.)])\s)/;
  while (i < regels.length) {
    const r = regels[i];
    const hek = /^\s*(```|~~~)/.exec(r);
    if (hek) {
      sluitLijst();
      const code = [];
      i++;
      while (i < regels.length && !new RegExp('^\\s*' + hek[1]).test(regels[i])) { code.push(regels[i]); i++; }
      i++;
      uit.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
      continue;
    }
    const cal = /^>\s*\[!([\w-]+)\][+-]?\s*(.*)$/.exec(r);
    if (cal) {
      sluitLijst();
      const soort = cal[1].toLowerCase();
      const klasse = ['warning', 'caution', 'attention'].indexOf(soort) >= 0 ? 'c-let' : ['danger', 'error', 'bug', 'failure'].indexOf(soort) >= 0 ? 'c-fout'
        : ['tip', 'done', 'success', 'check'].indexOf(soort) >= 0 ? 'c-tip' : 'c-noot';
      const body = [];
      i++;
      while (i < regels.length && /^>/.test(regels[i])) { body.push(regels[i].replace(/^>\s?/, '')); i++; }
      uit.push('<div class="callout ' + klasse + '">' + (cal[2] ? '<div class="ct">' + inline(cal[2]) + '</div>' : '') + markdownNaarHtml(body.join('\n'), inline) + '</div>');
      continue;
    }
    if (/^>/.test(r)) {
      sluitLijst();
      const body = [];
      while (i < regels.length && /^>/.test(regels[i])) { body.push(regels[i].replace(/^>\s?/, '')); i++; }
      uit.push('<blockquote>' + markdownNaarHtml(body.join('\n'), inline) + '</blockquote>');
      continue;
    }
    if (/\|/.test(r) && i + 1 < regels.length && isTabelScheiding(regels[i + 1])) {
      sluitLijst();
      const kop = cellen(r);
      i += 2;
      const body = [];
      while (i < regels.length && /\|/.test(regels[i]) && regels[i].trim() !== '') { body.push(cellen(regels[i])); i++; }
      uit.push('<div class="tabel"><table><thead><tr>' + kop.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' +
        body.map((rij) => '<tr>' + rij.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(r);
    if (h) { sluitLijst(); uit.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(r)) { sluitLijst(); uit.push('<hr>'); i++; continue; }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(r);
    if (li) {
      const ind = li[1].replace(/\t/g, '    ').length;
      const tag = /\d/.test(li[2]) ? 'ol' : 'ul';
      let tekst = li[3];
      const taak = /^\[([ xX])\]\s+(.*)$/.exec(tekst);
      while (lijst.length && ind < lijst[lijst.length - 1].ind) uit.push('</li></' + lijst.pop().tag + '>');
      const top = lijst[lijst.length - 1];
      if (top && ind === top.ind && top.tag !== tag) { uit.push('</li></' + lijst.pop().tag + '>'); }
      const top2 = lijst[lijst.length - 1];
      if (top2 && ind <= top2.ind) uit.push('</li><li>');
      else { uit.push('<' + tag + '><li>'); lijst.push({ tag: tag, ind: ind }); }
      uit.push(taak ? (taak[1] === ' ' ? '☐ ' : '☑ ') + inline(taak[2]) : inline(tekst));
      i++;
      continue;
    }
    if (r.trim() === '') { sluitLijst(); i++; continue; }
    const alinea = [];
    while (i < regels.length && regels[i].trim() !== '' && !blokStart.test(regels[i]) &&
      !(/\|/.test(regels[i]) && i + 1 < regels.length && isTabelScheiding(regels[i + 1]))) { alinea.push(regels[i].trim()); i++; }
    if (!alinea.length) { uit.push('<p>' + inline(r) + '</p>'); i++; continue; }
    sluitLijst();
    uit.push('<p>' + alinea.map(inline).join(' ') + '</p>');
  }
  sluitLijst();
  return uit.join('\n');
}

const STIJL = [
  ':root{color-scheme:light;--acc:#1f5fbf;--zacht:#5f6368;--lijn:#e3e3df;--bg:#fbfbf9;--fg:#141414;--kaart:#fff;--code:#f1f1ee}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-text-size-adjust:100%}',
  '.wrap{max-width:44rem;margin:0 auto;padding:36px 20px 72px}',
  'h1{font-size:1.65rem;line-height:1.25;font-weight:650;letter-spacing:-.02em;margin:0 0 20px}',
  'h2{font-size:1.2rem;font-weight:650;margin:34px 0 10px}h3{font-size:1.05rem;font-weight:650;margin:26px 0 8px}h4,h5,h6{font-size:1rem;margin:20px 0 6px}',
  'p{margin:0 0 12px}ul,ol{margin:0 0 12px;padding-left:1.3rem}li{margin:3px 0}li>ul,li>ol{margin:4px 0 4px}',
  '.tabel{overflow-x:auto;margin:12px 0 16px}table{border-collapse:collapse;font-size:.95rem;min-width:60%}',
  'th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--lijn);vertical-align:top}th{font-weight:600;color:var(--zacht)}',
  'blockquote{margin:16px 0;padding:10px 16px;background:var(--kaart);border:1px solid var(--lijn);border-left:3px solid var(--acc);border-radius:0 10px 10px 0}',
  'blockquote p:last-child,.callout p:last-child{margin-bottom:0}',
  '.callout{border:1px solid var(--lijn);border-left:3px solid var(--acc);border-radius:8px;padding:10px 14px;margin:16px 0;background:var(--kaart)}',
  '.callout .ct{font-weight:650;margin-bottom:4px}.c-let{border-left-color:#c77700}.c-fout{border-left-color:#c0392b}.c-tip{border-left-color:#2e8b57}',
  'code{background:var(--code);padding:1px 5px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}',
  'pre{background:var(--code);padding:12px 14px;border-radius:8px;overflow-x:auto}pre code{padding:0;background:none}',
  'a{color:var(--acc)}del{color:var(--zacht)}mark{background:#fff3b0}hr{border:0;border-top:1px solid var(--lijn);margin:28px 0}',
].join('');

// Eén pagina: {titel, body, html, zichtbaar (platte tekst zoals de lezer hem ziet), hrefs, sha}
function render(md, bestandsnaam) {
  const hrefs = [];
  const inline = maakInline(hrefs);
  const src = voorbewerk(md);
  let body = markdownNaarHtml(src, inline);
  const h1 = /^<h1>([\s\S]*?)<\/h1>/.exec(body.trimStart());
  let titel = h1 ? ontEsc(h1[1].replace(/<[^>]+>/g, '')).trim() : '';
  if (!titel) {
    titel = String(bestandsnaam || 'Pagina').split('/').pop().replace(/\.(md|markdown)$/i, '').trim() || 'Pagina';
    body = '<h1>' + esc(titel) + '</h1>\n' + body;
  }
  const html = '<!DOCTYPE html>\n<html lang="nl">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="robots" content="noindex, nofollow">\n<meta name="referrer" content="no-referrer">\n<title>' + esc(titel) + '</title>\n<style>' + STIJL + '</style>\n' +
    '</head>\n<body>\n<main class="wrap">\n' + body + '\n</main>\n</body>\n</html>\n';
  const zichtbaar = ontEsc(body.replace(/<br>/g, '\n').replace(/<\/(p|h\d|li|tr|td|th|div|blockquote|pre)>/g, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ');
  return { titel: titel, body: body, html: html, zichtbaar: zichtbaar, hrefs: hrefs,
    sha: crypto.createHash('sha256').update(html, 'utf8').digest('hex') };
}

// ── namen (afgeleid van socev-site namenpoort.js: bouwIndex + toetsProza) ──────────────────────────────────────────────────────
// Lopende tekst: alleen volledige namen (2–4 woorden op een rij) uit de contactenlijst en de medewerkerspagina's. Anders dan de
// namenpoort geeft deze de gevonden namen terug: de App toont ze aan David, die beslist (niet zelf weghalen). Een treffer die alleen
// uit woorden van NOOIT_NAAM bestaat (David zelf, praktijknamen) telt niet.
const NOOIT_NAAM = new Set(['groenhouten', 'tolgaarde', 'socev', 'hagro', 'pot', 'poh', 'ggz', 'huisarts', 'huisartsen', 'praktijk', 'praktijken',
  'apotheek', 'david', 'schaap', 'claude', 'supabase', 'telegram', 'todoist', 'obsidian', 'olares', 'drive', 'google', 'whatsapp', 'github',
  'cloudflare', 'amersfoort', 'utrecht', 'gambia', 'nederland', 'zorg', 'zorggroep', 'gezondheidscentrum', 'medisch', 'centrum', 'bv', 'holding',
  'vries', 'berg', 'meer', 'hout', 'wijk', 'dijk', 'veld', 'stad', 'markt', 'kerk', 'jaar', 'week', 'maand', 'nacht', 'agent', 'agents', 'skill',
  'skills', 'backup', 'vault', 'kluis', 'pagina', 'server', 'index', 'status', 'data', 'sync', 'document', 'documenten', 'administratie', 'ronde',
  'rondes', 'voort', 'dienst', 'diensten', 'kantoor', 'service', 'groep', 'team', 'punt', 'deel', 'plan', 'tekst', 'bericht', 'berichten', 'mail',
  'telefoon', 'contact', 'contacten', 'overzicht']);
const normaliseer = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function bouwNamen(vault, lees) {
  const volledig = new Set();
  let contacten = 0;
  const voegToe = (naam) => {
    const w = normaliseer(naam.replace(/\([^)]*\)/g, ' ')).split(' ').filter(Boolean);
    if (w.length >= 2) volledig.add(w.join(' '));
    return w.length > 0;
  };
  const ruw = lees(path.join(vault, '20_Prive/Contacten/Contacten.md'));   // gooit = poort dicht
  for (const regel of ruw.split(/\r?\n/)) {
    const m = /^-\s+\*\*(.+?)\*\*/.exec(regel);
    if (!m) continue;
    const naam = m[1].trim();
    if (!naam || naam === '(geen naam)' || naam[0] === '+') continue;
    if (voegToe(naam)) contacten++;
  }
  for (const rel of ['10_Zakelijk/Groenhouten/Medewerkers', '10_Zakelijk/Tolgaarde/Medewerkers', '10_Zakelijk/POT_POH_GGZ/Medewerkers']) {
    let lijst = [];
    try { lijst = fs.readdirSync(path.join(vault, rel)); } catch (e) { continue; }
    for (const b of lijst) {
      if (!/\.md$/i.test(b)) continue;
      const kaal = b.replace(/\.md$/i, '').split(' - ')[0];
      if (!/^index$/i.test(kaal)) voegToe(kaal);
    }
  }
  if (contacten < 100) throw new Error('namenlijst te kort (' + contacten + ')');
  return volledig;
}

function namenIn(volledig, tekst) {
  const w = normaliseer(tekst).split(' ').filter(Boolean);
  const gevonden = [];
  for (let i = 0; i < w.length; i++) {
    for (let n = 4; n >= 2; n--) {   // langste eerst
      if (i + n > w.length) continue;
      const stuk = w.slice(i, i + n);
      if (!volledig.has(stuk.join(' '))) continue;
      if (stuk.every((x) => NOOIT_NAAM.has(x))) continue;
      gevonden.push(stuk.join(' '));
      i += n - 1;
      break;
    }
  }
  const klein = ['van', 'de', 'der', 'den', 'het', 'ter', 'ten', 'te', 'in', 'op', 'el', 'al'];
  return Array.from(new Set(gevonden)).slice(0, MAX_NAMEN)
    .map((n) => n.split(' ').map((x, j) => j > 0 && klein.indexOf(x) >= 0 ? x : x[0].toUpperCase() + x.slice(1)).join(' '));
}

// ── de module ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// opt: { dir, vault, bron(pad, ctx) → {p, d, tekst} | null, masker(t, vast, bsn), bsnMasker, isVastDicht, isVerborgen, hmac, d1(sql, params),
//        host, lees(abs) (namenlijst), nu, fout,
//        access (beveiligd; weg = beveiligd delen uit): { idp, maak(body) → {ok, id, aud}, wijzig(id, body) → {ok, aud}, haal(id) → {ok, domein} |
//        {ok: false, weg: true}, weg(id) → {ok}, zoek(domein) → {ok, ids} } }
function maak(opt) {
  const DIR = opt.dir;
  const REG = path.join(DIR, 'gedeeld.json');
  const HOST = opt.host || 'deel.socev.dev';
  const nu = opt.nu || Date.now;
  const fout = opt.fout || function () {};
  const lees = opt.lees || function (p) { return fs.readFileSync(p, 'utf8'); };
  let namen = null;   // { op, set }

  function leesRegister() {
    try {
      const j = JSON.parse(fs.readFileSync(REG, 'utf8'));
      return j && Array.isArray(j.delingen) ? j : { versie: 1, delingen: [] };
    } catch (e) { if (e.code !== 'ENOENT') fout('docs-register-lees', e); return { versie: 1, delingen: [] }; }
  }
  function schrijfRegister(r) {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(DIR, 0o700); } catch (e) { /* niet van ons */ }
    const tmp = REG + '.tmp' + process.pid + '-' + crypto.randomBytes(3).toString('hex');
    fs.writeFileSync(tmp, JSON.stringify(r, null, 1), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, REG);
  }
  const url = (slug, soort) => 'https://' + HOST + '/' + (soort === 'beveiligd' ? 'b' : 'p') + '/' + slug;
  const ACC = opt.access || null;

  // ── Access-apps, alleen via de toestaanlijst (review #9) ──
  // bekend = slugs die buiten de registerlijst om bekend zijn (D1-rij van soort beveiligd, bij intrekken/opruimen)
  const accDomein = (slug) => HOST + '/b/' + slug;
  function accMag(slug, bekend) {
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return false;
    if (leesRegister().delingen.some((x) => x.slug === slug && x.soort === 'beveiligd')) return true;
    return !!(bekend && bekend.indexOf(slug) >= 0);
  }
  function accBody(slug, ontvangers) {
    return { name: 'Gedeelde pagina', type: 'self_hosted', domain: accDomein(slug), destinations: [{ type: 'public', uri: accDomein(slug) }],
      session_duration: '24h', allowed_idps: [ACC.idp], auto_redirect_to_identity: true, app_launcher_visible: false,
      http_only_cookie_attribute: true, same_site_cookie_attribute: 'lax',
      policies: [{ name: 'Ontvangers', decision: 'allow', precedence: 1, include: ontvangers.map((m) => ({ email: { email: m } })) }] };
  }
  async function accMaak(slug, ontvangers) {
    if (!accMag(slug)) { fout('docs-access', new Error('toestaanlijst: maken geweigerd')); return { ok: false }; }
    try { const r = await ACC.maak(accBody(slug, ontvangers)); return r && r.ok && r.id && r.aud ? r : { ok: false }; } catch (e) { fout('docs-access-maak', e); return { ok: false }; }
  }
  // haal eerst: alleen een app met precies het domein van deze slug wordt gewijzigd of verwijderd
  async function accEigen(id, slug, bekend) {
    if (!accMag(slug, bekend) || typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return { ok: false, geweigerd: true };
    let h;
    try { h = await ACC.haal(id); } catch (e) { fout('docs-access-haal', e); return { ok: false }; }
    if (h && h.weg) return { ok: true, weg: true };
    if (!h || !h.ok) return { ok: false };
    if (h.domein !== accDomein(slug)) { fout('docs-access', new Error('toestaanlijst: app ' + id.slice(0, 8) + ' hoort niet bij deze deling')); return { ok: false, geweigerd: true }; }
    return { ok: true };
  }
  async function accWijzig(id, slug, ontvangers) {
    const e = await accEigen(id, slug);
    if (!e.ok || e.weg) return { ok: false };
    try { const r = await ACC.wijzig(id, accBody(slug, ontvangers)); return r && r.ok ? r : { ok: false }; } catch (x) { fout('docs-access-wijzig', x); return { ok: false }; }
  }
  async function accWeg(id, slug, bekend) {
    const e = await accEigen(id, slug, bekend);
    if (!e.ok) return { ok: false };
    if (e.weg) return { ok: true };
    try { const r = await ACC.weg(id); return { ok: !!(r && r.ok) }; } catch (x) { fout('docs-access-weg', x); return { ok: false }; }
  }
  // apps op het domein van deze slug (ook een app waarvan de pod het id kwijt is: crash tussen maken en register)
  async function accZoek(slug, bekend) {
    if (!accMag(slug, bekend)) return { ok: false };
    try { const r = await ACC.zoek(accDomein(slug)); return r && r.ok && Array.isArray(r.ids) ? r : { ok: false }; } catch (e) { fout('docs-access-zoek', e); return { ok: false }; }
  }

  function namenSet() {
    if (namen && nu() - namen.op < NAMEN_VERS_MS) return namen.set;
    namen = { op: nu(), set: bouwNamen(opt.vault, lees) };
    return namen.set;
  }

  function nooitDelen(p) {
    const naam = p.split('/').pop().toLowerCase();
    if (opt.isVastDicht(p)) return 'privé-pagina\'s, gesprekken en personeelszaken deel je hier nooit';
    if (opt.isVerborgen(p)) return 'bronnen deel je hier niet';
    if (p.indexOf('00_Systeem/') === 0) return 'systeempagina\'s deel je niet';
    if (p.split('/').slice(0, -1).some((m) => NOOIT_MAPDEEL.test(m))) return 'uit deze map deel je nooit iets (beveiliging, dossiers, patiënten of personeel)';
    if (ALLEEN_LEZEN_NAAM.indexOf(naam) >= 0) return 'deze pagina houdt Socev zelf bij';
    return null;
  }

  // Pagina ophalen, poorten en renderen. Geeft {status, j, audit, r (render), b (bron)}.
  function bekijk(d, ctx) {
    if (ctx.vast) return { status: 403, j: { ok: false, fout: 'delen kan niet vanaf een apparaat met een vaste plek; gebruik je telefoon' } };
    const b = opt.bron(d && d.pad, ctx);
    if (!b) return { status: 404, j: { ok: false, fout: 'deze pagina is er niet (meer)' }, audit: { domein: null, h: typeof (d && d.pad) === 'string' ? opt.hmac(d.pad.slice(0, 600)) : null } };
    const audit = { domein: b.d, h: opt.hmac(b.p) };
    const nooit = nooitDelen(b.p);
    if (nooit) return { status: 403, j: { ok: false, fout: nooit, kan_niet: true }, audit: audit, b: b };
    const r = render(b.tekst, b.p);
    if (Buffer.byteLength(r.html, 'utf8') > MAX_HTML) return { status: 413, j: { ok: false, fout: 'deze pagina is te groot om te delen', kan_niet: true }, audit: audit, b: b };
    const proef = r.titel + '\n' + r.zichtbaar + '\n' + r.hrefs.join('\n');
    if (opt.masker(proef, false, null) !== proef) return { status: 422, j: { ok: false, fout: 'er staat iets in dat op een sleutel lijkt; zo\'n pagina deel je niet', kan_niet: true }, audit: audit, b: b };
    if (opt.masker(proef, true, opt.bsnMasker) !== proef) return { status: 422, j: { ok: false, fout: 'er staat een IBAN of een BSN-achtig nummer in; zo\'n pagina deel je niet', kan_niet: true }, audit: audit, b: b };
    let gevonden;
    try { gevonden = namenIn(namenSet(), r.titel + '\n' + r.zichtbaar + '\n' + r.hrefs.join('\n')); }   // ook een naam in een linkadres (…/in/jan-klaassen)
    catch (e) { fout('docs-namen', e); return { status: 503, j: { ok: false, fout: 'de namencontrole werkt nu niet; delen kan pas weer als die werkt' }, audit: audit, b: b }; }
    return { status: 200, audit: audit, b: b, r: r, namen: gevonden };
  }

  function huidigeDeling(reg, h) { return reg.delingen.find((x) => x.h === h) || null; }
  const naarApp = (x) => x ? Object.assign({ slug: x.slug, url: url(x.slug, x.soort), soort: x.soort, titel: x.titel, sinds: x.sinds, bijgewerkt: x.bijgewerkt || x.sinds },
    x.soort === 'beveiligd' ? { ontvangers: Array.isArray(x.ontvangers) ? x.ontvangers.slice() : [] } : {}) : null;

  // Is deze pagina gedeeld, en kan hij gedeeld worden? (licht: geen render)
  function stand(d, ctx) {
    const b = opt.bron(d && d.pad, ctx);
    if (!b) return { status: 404, j: { ok: false, fout: 'deze pagina is er niet (meer)' } };
    const h = opt.hmac(b.p);
    const x = huidigeDeling(leesRegister(), h);
    const nooit = ctx.vast ? 'delen kan niet vanaf een apparaat met een vaste plek' : nooitDelen(b.p);
    const bronSha = crypto.createHash('sha256').update(String(b.tekst), 'utf8').digest('hex');
    return { status: 200, audit: { domein: b.d, h: h }, j: { ok: true, kan_delen: !nooit, reden: nooit, gedeeld: naarApp(x),
      veranderd: x ? x.bron_sha !== bronSha : false } };
  }

  function voorbeeld(d, ctx) {
    const v = bekijk(d, ctx);
    if (v.status !== 200) return { status: v.status, j: v.j, audit: v.audit };
    const x = huidigeDeling(leesRegister(), v.audit.h);
    return { status: 200, audit: v.audit, j: { ok: true, titel: v.r.titel, body: v.r.body, sha: v.r.sha, namen: v.namen, gedeeld: naarApp(x),
      host: HOST, beveiligd: !!ACC } };
  }

  const D1_ZET = 'INSERT INTO deel (slug, soort, titel, html, sinds, bijgewerkt, aud, ontvangers, access_app) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ' +
    'ON CONFLICT(slug) DO UPDATE SET soort = excluded.soort, titel = excluded.titel, html = excluded.html, bijgewerkt = excluded.bijgewerkt, ' +
    'aud = excluded.aud, ontvangers = excluded.ontvangers, access_app = excluded.access_app';
  const zelfde = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x) => b.indexOf(x) >= 0);

  async function delen(d, ctx) {
    const soort = d && d.soort;
    if (soort !== 'openbaar' && soort !== 'beveiligd') return { status: 400, j: { ok: false, fout: 'kies Openbaar of Beveiligd' } };
    let ontvangers = null;
    if (soort === 'beveiligd') {
      if (!ACC) return { status: 503, j: { ok: false, fout: 'beveiligd delen werkt nu niet op de pod' } };
      const o = ontvangersUit(d.ontvangers);
      if (o.fout) return { status: 400, j: { ok: false, fout: o.fout } };
      ontvangers = o.lijst;
    }
    if (typeof d.sha !== 'string' || !/^[0-9a-f]{64}$/.test(d.sha)) return { status: 400, j: { ok: false, fout: 'onvolledig verzoek' } };
    const v = bekijk(d, ctx);
    if (v.status !== 200) return { status: v.status, j: v.j, audit: v.audit };
    if (v.r.sha !== d.sha) return { status: 409, j: { ok: false, fout: 'de pagina is veranderd sinds het voorbeeld; bekijk hem opnieuw' }, audit: v.audit };
    if (v.namen.length) {
      const bevestigd = Array.isArray(d.bevestig_namen) ? d.bevestig_namen.map(String) : [];
      if (!v.namen.every((n) => bevestigd.indexOf(n) >= 0))
        return { status: 409, j: { ok: false, fout: 'bevestig eerst de namen die op de pagina staan', namen: v.namen }, audit: v.audit };
    }
    const reg = leesRegister();
    const oud = huidigeDeling(reg, v.audit.h);
    if (oud && oud.soort !== soort)
      return { status: 409, j: { ok: false, soort_anders: true, fout: 'deze pagina is al ' + oud.soort + ' gedeeld; trek die deling eerst in (onder Gedeeld) en deel hem dan ' + soort }, audit: v.audit };
    const tijd = new Date(nu()).toISOString();
    const slug = oud ? oud.slug : crypto.randomBytes(16).toString('base64url');
    const bronSha = crypto.createHash('sha256').update(String(v.b.tekst), 'utf8').digest('hex');
    const nieuw = { h: v.audit.h, slug: slug, soort: soort, titel: v.r.titel, sinds: oud ? oud.sinds : tijd, bijgewerkt: tijd, sha: v.r.sha,
      bron_sha: bronSha, namen_bevestigd: v.namen.length };
    if (soort === 'beveiligd') Object.assign(nieuw, { ontvangers: ontvangers, access_app: oud ? oud.access_app || null : null, aud: oud ? oud.aud || null : null });
    // eerst het register (dan staat elke deling die buiten kan staan erin, ook als D1 daarna faalt; en de toestaanlijst kent de slug), dan
    // bij beveiligd de Access-app, dan D1. Mislukt een latere stap, dan gaat wat er al stond terug.
    const vorige = reg.delingen.slice();
    const zet = () => { reg.delingen = vorige.filter((x) => x.h !== v.audit.h).concat([nieuw]); schrijfRegister(reg); };
    const terug = () => { try { reg.delingen = vorige; schrijfRegister(reg); } catch (e) { fout('docs-register-terug', e); } };
    try { zet(); } catch (e) { fout('docs-register', e); return { status: 500, j: { ok: false, fout: 'het deelregister kon niet worden bijgewerkt; er is niets gedeeld' }, audit: v.audit }; }
    const misCf = { status: 502, j: { ok: false, fout: 'delen lukte niet (Cloudflare gaf geen goed antwoord); probeer het zo nog eens' }, audit: v.audit };
    let acc = null;   // 'nieuw' | 'gewijzigd' | null
    if (soort === 'beveiligd') {
      if (!nieuw.access_app) {
        const m = await accMaak(slug, ontvangers);
        if (!m.ok) { terug(); return misCf; }
        nieuw.access_app = m.id; nieuw.aud = m.aud; acc = 'nieuw';
        try { zet(); } catch (e) { fout('docs-register', e); await accWeg(m.id, slug); terug(); return misCf; }
      } else {
        // bestaat de app nog? (met de hand weggehaald = opnieuw maken; de oude aud werkt dan niet meer)
        const e = await accEigen(nieuw.access_app, slug);
        if (!e.ok) { terug(); return misCf; }
        if (e.weg) {
          const m = await accMaak(slug, ontvangers);
          if (!m.ok) { terug(); return misCf; }
          nieuw.access_app = m.id; nieuw.aud = m.aud; acc = 'nieuw';
          try { zet(); } catch (x) { fout('docs-register', x); await accWeg(m.id, slug); terug(); return misCf; }
        } else if (!zelfde(oud.ontvangers, ontvangers)) {
          const w = await accWijzig(nieuw.access_app, slug, ontvangers);
          if (!w.ok) { terug(); return misCf; }
          acc = 'gewijzigd';
        }
      }
    }
    let ok = false;
    try {
      const q = await opt.d1(D1_ZET, [slug, soort, v.r.titel, v.r.html, nieuw.sinds, tijd, soort === 'beveiligd' ? nieuw.aud : null,
        soort === 'beveiligd' ? JSON.stringify(ontvangers.map(mailHash)) : null, soort === 'beveiligd' ? nieuw.access_app : null]);
      ok = !!(q && q.ok);
    } catch (e) { fout('docs-d1', e); }
    if (!ok) {
      if (acc === 'nieuw') { const w = await accWeg(nieuw.access_app, slug); if (!w.ok) fout('docs-access', new Error('app na D1-fout niet weg')); }
      if (acc === 'gewijzigd') { const w = await accWijzig(nieuw.access_app, slug, oud.ontvangers); if (!w.ok) fout('docs-access', new Error('ontvangers na D1-fout niet terug')); }
      terug();
      return misCf;
    }
    return { status: 200, audit: v.audit, j: { ok: true, bijgewerkt: !!oud, gedeeld: naarApp(nieuw) } };
  }

  // Alles wat buiten staat: D1 is de bron, het register vult aan (titel, sinds). Staat iets alleen in het register (D1 niet bereikbaar,
  // of al weg), dan zegt de lijst dat.
  async function gedeeld() {
    const reg = leesRegister();
    let rijen = null;
    try {
      const q = await opt.d1('SELECT slug, soort, titel, sinds, bijgewerkt FROM deel ORDER BY sinds DESC', []);
      if (q && q.ok) rijen = q.rijen;
    } catch (e) { fout('docs-d1-lijst', e); }
    const perSlug = new Map(reg.delingen.map((x) => [x.slug, x]));
    const uit = [];
    if (rijen) {
      for (const r of rijen) {
        const x = perSlug.get(r.slug);
        const rij = { slug: r.slug, url: url(r.slug, r.soort), soort: r.soort, titel: r.titel, sinds: r.sinds, bijgewerkt: r.bijgewerkt, in_register: !!x };
        if (r.soort === 'beveiligd') rij.ontvangers = x && Array.isArray(x.ontvangers) ? x.ontvangers.slice() : [];
        uit.push(rij);
        perSlug.delete(r.slug);
      }
    }
    for (const x of perSlug.values()) uit.push(Object.assign(naarApp(x), { in_register: true, buiten: rijen ? false : null }));
    return { status: 200, j: { ok: true, delingen: uit, d1: !!rijen } };
  }

  // Volgorde: eerst de inhoud weg (D1-rij: de volgende aanvraag is 404), dan bij beveiligd de Access-app, dan de registerregel. Lukt het
  // opruimen bij Access niet, dan blijft de regel staan (de toestaanlijst kent de slug dan nog) en zegt de App: nog eens op Intrekken.
  async function intrekken(d) {
    const slug = d && d.slug;
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return { status: 400, j: { ok: false, fout: 'onbekende deling' } };
    const reg = leesRegister();
    const x = reg.delingen.find((y) => y.slug === slug) || null;
    let rij = null, ok = false;
    try {
      const q = await opt.d1('SELECT soort, access_app FROM deel WHERE slug = ?1', [slug]);
      if (q && q.ok) { rij = q.rijen && q.rijen[0] || null; const w = await opt.d1('DELETE FROM deel WHERE slug = ?1', [slug]); ok = !!(w && w.ok); }
    } catch (e) { fout('docs-d1-weg', e); }
    if (!ok) return { status: 502, j: { ok: false, fout: 'intrekken lukte niet (Cloudflare gaf geen goed antwoord); de pagina staat nog buiten. Probeer het zo nog eens.' } };
    const beveiligd = (x && x.soort === 'beveiligd') || (rij && rij.soort === 'beveiligd');
    if (beveiligd) {
      if (!ACC) return { status: 502, j: { ok: false, fout: 'de pagina is weg (de link werkt niet meer), maar het opruimen bij Cloudflare kan nu niet; probeer het later nog eens' } };
      const bekend = rij && rij.soort === 'beveiligd' ? [slug] : null;
      const ids = [x && x.access_app, rij && rij.access_app].filter((i, n, a) => typeof i === 'string' && a.indexOf(i) === n);
      let schoon = true;
      // een id dat niet bij deze slug hoort (toestaanlijst) blijft onaangeroerd en telt niet als fout: het zoeken op het domein hieronder beslist
      for (const id of ids) { const e = await accEigen(id, slug, bekend); if (e.geweigerd) continue; const w = e.ok ? await accWeg(id, slug, bekend) : e; if (!w.ok) schoon = false; }
      const z = await accZoek(slug, bekend);   // ook een app waarvan het id nergens staat
      if (!z.ok) schoon = false;
      else for (const id of z.ids) { if (ids.indexOf(id) >= 0) continue; const w = await accWeg(id, slug, bekend); if (!w.ok) schoon = false; }
      if (!schoon) {
        if (x) { x.access_open = true; try { schrijfRegister(reg); } catch (e) { fout('docs-register', e); } }
        return { status: 502, audit: { domein: null, h: x ? x.h : null }, j: { ok: false, deels: true,
          fout: 'de pagina is weg (de link werkt niet meer), maar het opruimen bij Cloudflare lukte niet helemaal; druk nog eens op Intrekken' } };
      }
    }
    if (x) {
      reg.delingen = reg.delingen.filter((y) => y.slug !== slug);
      try { schrijfRegister(reg); } catch (e) { fout('docs-register', e); }
    }
    return { status: 200, audit: { domein: null, h: x ? x.h : null }, j: { ok: true } };
  }

  async function app(route, d, ctx) {
    ctx = ctx || {};
    if (route === 'POST /app/docs/stand') return stand(d, ctx);
    if (route === 'POST /app/docs/voorbeeld') return voorbeeld(d, ctx);
    if (route === 'POST /app/docs/delen') return delen(d, ctx);
    if (route === 'GET /app/docs/gedeeld') return gedeeld();
    if (route === 'POST /app/docs/intrekken') return intrekken(d);
    return { status: 404, j: { ok: false, fout: 'onbekend' } };
  }

  function health() {
    const reg = leesRegister();
    return { aan: true, host: HOST, gedeeld: reg.delingen.length, beveiligd: reg.delingen.filter((x) => x.soort === 'beveiligd').length,
      beveiligd_aan: !!ACC, opruimen_open: reg.delingen.filter((x) => x.access_open).length };
  }

  return { app: app, health: health };
}

module.exports = { maak: maak, render: render, namenIn: namenIn, bouwNamen: bouwNamen, voorbewerk: voorbewerk, SLUG_RE: SLUG_RE, ontvangersUit: ontvangersUit,
  mailHash: mailHash };
