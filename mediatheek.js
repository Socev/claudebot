'use strict';
// Mediatheek (wv1269, 26-10-2026; opdracht David 24-10 17:02, box-rij "Opdracht David: Mediatheek-app in de Socev-app").
// WAAROM. David (24-10): "Leuk die mediatheek, hebben we er al een app voor die het inzichtelijk maakt?" Hij wil liedjes en andere
// artistieke uitingen (eerst de Shizzle-liedjes) zelf terugvinden en afspelen, niet alleen via Socev op afroep; de tab Bestanden
// bewaart maar 30 dagen.
// Sinds wv1397 (27-10-2026; David 26-10: "elk mediatheekbestand verdient zijn eigen markdown-bestand ... 1x bestand fout schrijven =
// allle mediatheekdata corrupt") staat elk stuk in een eigen beschrijving naast het bestand: zelfde map, zelfde naam, .md, met
// `bron_soort: mediatheek`, categorie, titel, wie, datum en `bestanden:` in de frontmatter; de eerste alinea is de omschrijving.
// De pagina 20_Prive/Mediatheek.md is alleen nog de kaft: haar ##-koppen geven volgorde en uitleg van de categorieën. Bouwplan:
// 01_Ontwikkeling/Mediatheek - beschrijving per bestand (bouwplan 27-10-2026).md.
//
// Padcontrole (opdracht wv1269: "geen bestand buiten de mediatheek-links bereikbaar"; strenger sinds wv1397):
// - M1 alleen een bestand dat in `bestanden:` van een geldige beschrijving staat; de App vraagt het op met een id (de sha256 van het
//   pad, 16 hex); een pad van buiten wordt nooit aangenomen. Bij elk bestand-verzoek worden die ene beschrijving en dat bestand opnieuw
//   gelezen en gecontroleerd (de lijst mag ± 1 minuut oud zijn, de toegang niet).
// - M2 het bestand ligt in dezelfde map als de beschrijving, en die map ligt onder 20_Prive (geen punt-mappen, geen '..', geen
//   absoluut pad, geen symlink-map: de zoektocht volgt geen koppelingen). Een link naar 10_Zakelijk (personeelsgesprekken,
//   Plaud-opnames) of 00_Systeem maakt de beschrijving "te herstellen", nooit een bestand.
// - M3 alleen de extensies hieronder (geluid om af te spelen, een paar soorten om te downloaden); geen md/html/svg/code.
// - M4 realpath binnen de vault én binnen die bovenmap, lstat: gewoon bestand, geen symlink, nlink 1; lezen via één fd met O_NOFOLLOW
//   en O_NONBLOCK, /proc/self/fd = het verwachte echte pad (geen tussenmap die intussen een koppeling werd), fstat = zelfde inode,
//   nlink 1 (geen hardlink naar buiten); hooguit 20 MB (base64 in JSON). De beschrijving en de kaft ook: zelfde leesweg, ≤ 64 kB / 1 MB.
// Eén fout = één stuk: een beschrijving die niet klopt komt in `te_herstellen` (bestandsnaam + reden in gewone taal), de rest staat er.
// Alles alleen lezen; de module schrijft niets. Privé-module: op een vaste plek onder het invoerslot (server.js, wv1901); dicht alleen als APP_VAST_AFSCHERMEN aan staat.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PAGINA = '20_Prive/Mediatheek.md';
const MAX_PAGINA = 1024 * 1024;
const MAX_BESTAND = 20 * 1024 * 1024;
const AUDIO = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg' };
// alleen downloaden (beeld en video krijgen later een eigen weergave; geparkeerd als beeldbank, Ideeënbus § 22)
const ANDERS = { pdf: 'application/pdf', flp: 'application/octet-stream', mid: 'audio/midi', midi: 'audio/midi',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };

const extVan = (p) => { const m = /\.([a-z0-9]{1,5})$/i.exec(p); return m ? m[1].toLowerCase() : ''; };
const idVan = (p) => crypto.createHash('sha256').update(p, 'utf8').digest('hex').slice(0, 16);

// Doel van een link → vaultpad of null (M2/M3 nog niet: dat doet zoekBestand). Obsidian: [[pad#kop|alias]], ook [[pad\|alias]] in tabellen.
function schoonDoel(t) {
  let p = String(t || '').split('|')[0].replace(/\\$/, '').split('#')[0].trim();
  try { if (/%[0-9a-f]{2}/i.test(p)) p = decodeURIComponent(p); } catch (e) { return null; }
  p = p.replace(/\\/g, '/').normalize('NFC');
  if (!p || p.length > 600 || p.indexOf('\u0000') >= 0 || p[0] === '/' || /^[a-z]+:/i.test(p)) return null;
  if (p.split('/').some((s) => s === '..' || s === '.' || s === '' || s[0] === '.')) return null;
  return p;
}

// Links in een stuk tekst: [[doel|alias]] en [alias](doel). Geeft { doel, naam, van, tot }.
function links(t) {
  const uit = [];
  // md-link: <doel met spaties> of een doel met hooguit één niveau haakjes ("Lied A (Sven).mp3"; review wv1269 ZOU 3)
  const re = /\[\[([^\]\n]+?)\]\]|\[([^\]\n]*)\]\((<[^>\n]+>|(?:[^()\n]|\([^()\n]*\))+)\)/g;
  let m;
  while ((m = re.exec(t))) {
    if (m[1] !== undefined) {
      const delen = m[1].split('|');
      uit.push({ doel: delen[0], naam: delen.length > 1 ? delen.slice(1).join('|').trim() : '', van: m.index, tot: re.lastIndex });
    } else uit.push({ doel: m[3].replace(/^<|>$/g, ''), naam: m[2].trim(), van: m.index, tot: re.lastIndex });
  }
  return uit;
}

// Markdown naar platte tekst voor de App (die toont alles als tekst): links → hun naam, *, _ en ` weg.
function plat(t) {
  return String(t)
    .replace(/\[\[([^\]\n]+?)\]\]/g, (_, x) => { const d = x.split('|'); return (d.length > 1 ? d.slice(1).join('|') : d[0].split('/').pop()).trim(); })
    .replace(/\[([^\]\n]*)\]\((<[^>\n]+>|(?:[^()\n]|\([^()\n]*\))+)\)/g, '$1')
    .replace(/\*\*|__|`/g, '').replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ').trim();
}

const MAANDEN = { jan: 1, feb: 2, mrt: 3, maa: 3, apr: 4, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12 };
function datumIso(s) {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return m[0];
  m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return null;
}

// Oude vorm (vóór wv1397), alleen nog voor de overzetting en de toetsen. Eén opsommingsregel (met vervolgregels samengevoegd) → item. Vorm (Mediatheek.md): **"Titel"** — Wie, datum; omschrijving. Bestand [[…|mp3]].
function leesItem(ruw) {
  const t = ruw.replace(/\s+/g, ' ').trim();
  const kop = /^\*\*(.+?)\*\*\s*/.exec(t);
  let titel, rest;
  if (kop) { titel = kop[1]; rest = t.slice(kop[0].length); } else { titel = null; rest = t; }
  const ls = links(rest);
  const bestanden = [], paginas = [];
  let geweigerd = 0;
  for (const l of ls) {
    const p = schoonDoel(l.doel);
    if (!p) { if (/\.[a-z0-9]{1,5}(#|\||$)/i.test(l.doel) && !/^[a-z]+:/i.test(l.doel)) geweigerd++; continue; }
    const ext = extVan(p);
    if (AUDIO[ext] || ANDERS[ext]) bestanden.push({ pad: p, ext: ext, label: l.naam || ext });
    else if (!ext || ext === 'md') paginas.push({ pad: /\.md$/i.test(p) ? p : p + '.md', naam: plat(l.naam || p.split('/').pop()) });
    else geweigerd++;
  }
  // "Bestand [[…]]" / "Bestanden [[…]] en [[…]]" hoort niet in de omschrijving: de App toont de knoppen
  let tekst = rest.replace(/\s*\bBestand(en)?\b:?\s*((\[\[[^\]]+\]\]|\[[^\]]*\]\((<[^>\n]+>|(?:[^()\n]|\([^()\n]*\))+)\))(\s*(,|en|of)\s*)?)+\.?/g, (x) => {
    return links(x).every((l) => { const p = schoonDoel(l.doel); const e = p ? extVan(p) : ''; return !!(AUDIO[e] || ANDERS[e]); }) ? '' : x;
  });
  let noot = null;
  const nm = /\*Nog geen bestand:?\*:?\s*(.*)$/i.exec(tekst);
  if (nm) { noot = plat(nm[1]) || null; tekst = tekst.slice(0, nm.index); }
  tekst = tekst.replace(/^[—–-]\s*/, '');
  let wie = null, datum = null, datumTekst = null;
  const wd = /^([^,;.]{1,60}?),\s*(\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2}-\d{4})\s*[.;:]?\s*/.exec(tekst);
  if (wd) { wie = plat(wd[1]); datumTekst = wd[2]; datum = datumIso(wd[2]); tekst = tekst.slice(wd[0].length); }
  const omschrijving = plat(tekst).replace(/[;,]\s*$/, '').replace(/^[;,.]\s*/, '');
  return {
    titel: plat(titel || '').replace(/^["“”„']+|["“”„']+$/g, '') || (bestanden[0] ? bestanden[0].pad.split('/').pop() : plat(t).slice(0, 80)),
    wie: wie, datum: datum, datum_tekst: datumTekst && !datum ? datumTekst : null,
    omschrijving: omschrijving || null, noot: noot, bestanden: bestanden, paginas: paginas, geweigerd: geweigerd,
  };
}

// Pagina → { onderwerpen: [{ naam, uitleg, items }], intro }. Alleen ## koppen; ### valt onder het lopende onderwerp.
function leesPagina(md) {
  let t = String(md).replace(/\r\n?/g, '\n');
  if (t.startsWith('---\n')) { const e = t.indexOf('\n---', 4); if (e > 0) t = t.slice(t.indexOf('\n', e + 1) + 1); }
  const onderwerpen = [];
  let huidig = null, item = null, para = [];
  const sluitItem = () => {
    if (item !== null && huidig) {
      const it = leesItem(item);
      const vorig = huidig.items[huidig.items.length - 1];
      if (it.noot && /^\(?idem\)?\.?$/i.test(it.noot) && vorig && vorig.noot) it.noot = vorig.noot;   // "*Nog geen bestand* (idem)."
      huidig.items.push(it);
    }
    item = null;
  };
  const sluitPara = () => { if (para.length && huidig) { const p = plat(para.join(' ')); if (p) huidig.uitleg.push(p); } para = []; };
  for (const regel of t.split('\n')) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(regel);
    if (h && !/^###/.test(regel)) {
      sluitItem(); sluitPara();
      huidig = { naam: plat(h[1]), uitleg: [], items: [] };
      onderwerpen.push(huidig);
      continue;
    }
    if (!huidig) continue;   // kop en uitleg boven het eerste onderwerp zijn voor Socev
    const b = /^[-*+]\s+(.*)$/.exec(regel);
    if (b) { sluitPara(); sluitItem(); item = b[1]; continue; }
    if (item !== null && /^\s{2,}\S/.test(regel)) { item += ' ' + regel.trim(); continue; }
    if (!regel.trim()) { sluitItem(); sluitPara(); continue; }
    sluitItem();
    if (/^#{3,}\s/.test(regel)) { sluitPara(); continue; }
    para.push(regel.trim());
  }
  sluitItem(); sluitPara();
  return onderwerpen.filter((o) => o.items.length || o.uitleg.length);
}

// ── wv1397: de kaft (20_Prive/Mediatheek.md) → categorieën { naam, uitleg, paginas } in de volgorde van de ##-koppen ──
// Opsommingsregels (de oude vorm van vóór wv1397) en code-blokken (het sjabloon) tellen niet mee; alleen gewone alinea's zijn uitleg,
// en een paginalink in die uitleg wordt een knop "Lees … in Second Brain" (alleen onder 20_Prive, filter in maak).
function leesKaft(md) {
  let t = String(md).replace(/\r\n?/g, '\n');
  if (t.startsWith('---\n')) { const e = t.indexOf('\n---', 4); if (e > 0) t = t.slice(t.indexOf('\n', e + 1) + 1); }
  t = t.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
  const uit = [];
  let huidig = null, para = [], inLijst = false;
  const sluit = () => {
    if (para.length && huidig) {
      const ruw = para.join(' '), p = plat(ruw);
      if (p) huidig.uitleg.push(p);
      for (const l of links(ruw)) {
        const d = schoonDoel(l.doel);
        if (!d) continue;
        const ext = extVan(d);
        if (ext && ext !== 'md' && (AUDIO[ext] || ANDERS[ext] || /^[a-z]+$/.test(ext))) continue;
        const pad = /\.md$/i.test(d) ? d : d + '.md';
        if (!huidig.paginas.some((x) => x.pad === pad)) huidig.paginas.push({ pad: pad, naam: plat(l.naam || d.split('/').pop()) });
      }
    }
    para = [];
  };
  for (const regel of t.split('\n')) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(regel);
    if (h && !/^###/.test(regel)) { sluit(); inLijst = false; huidig = { naam: plat(h[1]), uitleg: [], paginas: [] }; uit.push(huidig); continue; }
    if (!huidig) continue;
    if (!regel.trim() || /^#{3,}\s/.test(regel)) { sluit(); inLijst = false; continue; }
    if (/^\s*[-*+]\s/.test(regel)) { sluit(); inLijst = true; continue; }
    if (inLijst && /^\s{2,}\S/.test(regel)) continue;
    inLijst = false;
    para.push(regel.trim());
  }
  sluit();
  return uit;
}

// Categorie vergelijken met een kop: zonder opmaak, accenten en hoofdletters, en zonder toevoeging tussen haakjes aan het eind
// ("Eigen muziek (Fruityloops, 2001–2005)" = "Eigen muziek").
const catSleutel = (s) => plat(String(s || '')).replace(/\s*\([^)]*\)\s*$/, '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

let FM = null;   // frontmatter-lezer uit ovis-register.js (geen tweede YAML-lezer); ontbreekt hij, dan is elke beschrijving te herstellen
function fmLezer() {
  if (FM === null) { try { FM = require('./ovis-register.js').frontmatter || false; } catch (e) { FM = false; } }
  return FM || null;
}

// Herkent een mediatheekbeschrijving aan `bron_soort: mediatheek`: in de frontmatter, of (kapotte kop) in een regel buiten een
// code-blok. Een pagina die het sjabloon in een code-blok toont (de kaft) telt dus niet.
function noemtMediatheek(tekst) {
  const t = String(tekst).replace(/\r\n?/g, '\n');
  if (t.startsWith('---\n')) { const e = t.indexOf('\n---', 3); if (e > 0) return BRON_RE.test(t.slice(4, e + 1)); return BRON_RE.test(t); }
  return BRON_RE.test(t.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(^\1[^\n]*$|(?![\s\S]))/gm, ''));
}

// Review wv1397 MOET 1: O_NOFOLLOW kijkt alleen naar het laatste deel van het pad. Na elke open toetsen we via /proc/self/fd dat de fd
// echt het verwachte (realpath-)pad is; een tussenmap die tussen controle en open door een koppeling is vervangen, valt zo af.
function fdOpPlek(fd, verwacht) {
  try { return fs.readlinkSync('/proc/self/fd/' + fd) === verwacht; } catch (e) { return false; }
}

const geldigeDatum = (iso) => { const d = new Date(iso + 'T12:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === iso; };

// Eén beschrijving (tekst + map waarin hij staat, NFC) → { niet } (geen mediatheekbeschrijving) | { reden } | { stuk }.
// Alleen de inhoud; of de bestanden echt bestaan toetst maak().
function leesBeschrijving(tekst, map) {
  const lees = fmLezer();
  if (!lees) return { reden: 'de lezer voor beschrijvingen ontbreekt in deze versie van de pod' };
  const fm = lees(tekst);
  if (fm.fout) {
    if (!noemtMediatheek(String(tekst).slice(0, KOP))) return { niet: true };
    return { reden: 'de kop (frontmatter) is niet te lezen: ' + fm.fout };
  }
  const v = fm.velden;
  const een = (k) => { const x = v[k]; if (x === undefined || x === '') return null; return typeof x === 'string' ? x.trim() : undefined; };
  if (een('bron_soort') !== 'mediatheek') return { niet: true };
  for (const k of ['categorie', 'titel', 'wie', 'datum', 'datum_tekst', 'favoriet']) if (een(k) === undefined) return { reden: k + ' moet één waarde zijn, geen lijst' };
  const categorie = een('categorie');
  if (!categorie) return { reden: 'categorie ontbreekt' };
  let datum = null;
  if (een('datum')) {
    datum = datumIso(een('datum'));
    if (!datum || !geldigeDatum(datum)) return { reden: 'de datum is onleesbaar (schrijf 2026-10-19, of gebruik datum_tekst)' };
  }
  let favoriet = false;
  const fav = een('favoriet');
  if (fav) { if (/^(true|ja|yes)$/i.test(fav)) favoriet = true; else if (!/^(false|nee|no)$/i.test(fav)) return { reden: 'favoriet moet true of false zijn' }; }
  let bs = v.bestanden;
  if (typeof bs === 'string') bs = bs ? [bs] : [];
  if (!Array.isArray(bs) || !bs.length) return { reden: 'bestanden ontbreekt (de link naar het mediabestand)' };
  const bestanden = [];
  for (let ruw of bs) {
    if (/^\[[^[\]]+\]$/.test(String(ruw).trim())) ruw = '[' + String(ruw).trim() + ']';   // bestanden: [[x]] zonder aanhalingstekens leest de lezer als lijst "[x]"
    const ls = links(String(ruw));
    const doel = ls.length === 1 ? ls[0].doel : ls.length === 0 ? String(ruw).trim() : null;
    if (doel === null) return { reden: 'een regel bij bestanden heeft meer dan één link' };
    let p = schoonDoel(doel);
    if (p && p.indexOf('/') < 0) p = map + '/' + p;   // alleen de naam: dan in de map van de beschrijving
    if (!p) return { reden: 'een link bij bestanden is geen pad in de vault' };
    const naam = p.split('/').pop(), ext = extVan(p);
    if (!AUDIO[ext] && !ANDERS[ext]) return { reden: naam + ' is een soort bestand dat de app niet opent' };
    if (p.slice(0, -naam.length - 1) !== map) return { reden: naam + ' staat in een andere map dan de beschrijving' };
    if (!bestanden.some((b) => b.pad === p)) bestanden.push({ pad: p, naam: naam, ext: ext });
  }
  // omschrijving: de eerste alinea van de tekst (koppen overgeslagen); de rest is voor de vault
  const romp = fm.regels.slice(fm.eind + 1);
  let i = 0;
  while (i < romp.length && (!romp[i].trim() || /^#{1,6}\s/.test(romp[i]))) i++;
  const alinea = [];
  while (i < romp.length && romp[i].trim() && !/^#{1,6}\s/.test(romp[i])) alinea.push(romp[i++].trim());
  const omschrijving = plat(alinea.join(' ')).slice(0, 1200) || null;
  return { stuk: { categorie: categorie, titel: een('titel') ? plat(een('titel')) : null, wie: een('wie') ? plat(een('wie')) : null, datum: datum,
    datum_tekst: datum ? null : een('datum_tekst'), favoriet: favoriet, omschrijving: omschrijving, bestanden: bestanden } };
}

const MAX_BESCHRIJVING = 64 * 1024;
const KOP = 16384;                // zoveel leest de zoektocht van elke .md om bron_soort: mediatheek te herkennen
const MAX_DIEPTE = 12, MAX_INGANGEN = 60000, MAX_ZOEK_MS = 3000;
const BRON_RE = /^bron_soort:\s*["']?mediatheek["']?\s*(#.*)?$/m;
const MEDIA_EXT = Object.keys(AUDIO).concat(Object.keys(ANDERS));
const WEG = { ontbreekt: 'ontbreekt', 'geen bestand': 'is geen gewoon bestand (koppeling of map)', hardlink: 'heeft nog een tweede naam ergens anders (hardlink)',
  buiten: 'staat buiten de mediatheek', soort: 'is een soort bestand dat de app niet opent' };

function maak(opt) {
  const VAULT = opt.vault;
  const PAD = opt.pagina || PAGINA;
  const TOP = PAD.split('/')[0];
  const fout = opt.fout || function () {};
  const CACHE_MS = typeof opt.cacheMs === 'number' ? opt.cacheMs : 60000;
  let echteVault = null, echteTop = null;
  let kopCache = new Map();   // rel → { k: ino:grootte:mtime, mt: bool }
  let cache = null;

  function echt() {
    if (!echteVault) echteVault = fs.realpathSync(VAULT);
    if (!echteTop) {
      const t = fs.realpathSync(path.join(VAULT, TOP));
      if (t !== path.join(echteVault, TOP)) throw new Error('bovenmap is een koppeling');   // 20_Prive zelf mag nergens anders heen wijzen
      echteTop = t;
    }
    return { vault: echteVault, top: echteTop };
  }

  // Klein bestand lezen via één fd, zonder een koppeling te volgen (ook niet in een tussenmap: fdOpPlek), niet blokkerend (FIFO);
  // abs moet een echt pad zijn (realpath van de vault erin). kop: alleen de eerste max bytes; anders is groter dan max een fout.
  function leesKlein(abs, max, kop) {
    let fd = null;
    try {
      fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      if (!fdOpPlek(fd, abs)) return { fout: 'de beschrijving staat niet op haar plek (koppeling)' };
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return { fout: 'de beschrijving is geen gewoon bestand' };
      if (!kop && st.size > max) return { fout: 'de beschrijving is te groot (meer dan ' + Math.round(max / 1024) + ' kB)' };
      const n = Math.min(st.size, max), buf = Buffer.alloc(n);
      let g = 0;
      while (g < n) { const k = fs.readSync(fd, buf, g, n - g, g); if (k <= 0) break; g += k; }
      return { tekst: buf.slice(0, g).toString('utf8'), mtimeMs: st.mtimeMs };
    } catch (e) { return { fout: 'de beschrijving is niet te lezen' }; }
    finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* al dicht */ } }
  }

  // M2–M4 voor één bestand in de (echte) map van de beschrijving → { abs, grootte, dev, ino } of { weg }
  function zoekIn(dirReal, naam) {
    const ext = extVan(naam);
    if (!AUDIO[ext] && !ANDERS[ext]) return { weg: 'soort' };
    let abs = path.join(dirReal, naam);
    try {
      let st;
      try { st = fs.lstatSync(abs); }
      catch (e) { abs = path.join(dirReal, naam.normalize('NFD')); st = fs.lstatSync(abs); }   // de schijf kan een naam in NFD hebben (macOS/Drive)
      if (st.isSymbolicLink() || !st.isFile()) return { weg: 'geen bestand' };
      if (st.nlink !== 1) return { weg: 'hardlink' };
      const r = fs.realpathSync(abs);
      if (path.dirname(r) !== dirReal || r.indexOf(echt().top + path.sep) !== 0) return { weg: 'buiten' };
      return { abs: r, grootte: st.size, dev: st.dev, ino: st.ino, m: st.mtimeMs };
    } catch (e) { return { weg: 'ontbreekt' }; }
  }

  // Eén beschrijving beoordelen (ook bij elk bestand-verzoek opnieuw): mapRaw = vaultpad van de map zoals op schijf.
  function beoordeel(mapRaw, mdNaam) {
    const e = echt();
    let dirReal;
    try { dirReal = fs.realpathSync(path.join(VAULT, mapRaw)); } catch (x) { return { reden: 'de map is niet te lezen' }; }
    if (dirReal !== path.join(e.vault, mapRaw) || dirReal.indexOf(e.top + path.sep) !== 0) return { reden: 'de map is een koppeling' };
    const t = leesKlein(path.join(dirReal, mdNaam), MAX_BESCHRIJVING, false);
    if (t.fout) return { reden: t.fout };
    const r = leesBeschrijving(t.tekst, mapRaw.normalize('NFC'));
    if (r.niet || r.reden) return r;
    const basis = mdNaam.slice(0, -3).normalize('NFC');
    if (!r.stuk.bestanden.some((b) => b.naam.slice(0, -b.ext.length - 1) === basis))
      return { reden: 'het mediabestand met dezelfde naam als de beschrijving staat niet bij bestanden' };
    const rijen = [];
    for (const b of r.stuk.bestanden) {
      const z = zoekIn(dirReal, b.naam);
      if (z.weg) return { reden: b.naam + ' ' + WEG[z.weg], ontbreekt: z.weg === 'ontbreekt' ? 1 : 0 };
      rijen.push({ b: b, z: z });
    }
    return { stuk: r.stuk, rijen: rijen, mtimeMs: t.mtimeMs };
  }

  // Zoektocht door 20_Prive: geen punt-mappen, geen koppelingen (Dirent: symlink is geen map en geen bestand), begrensd in ingangen, diepte
  // en tijd (review wv1397 ZOU 1: map per ingang lezen met opendir, niet eerst alles in het geheugen). Kapt hij af, dan zegt hij dat
  // (afgekapt in tel en /health): dan kan er een stuk ontbreken.
  function zoek() {
    const e = echt();
    const gevonden = [], audio = new Map(), nieuweKop = new Map();
    let n = 0, afgekapt = false;
    const t0 = Date.now();
    const stapel = [[TOP, 0]];
    while (stapel.length) {
      if (n > MAX_INGANGEN || Date.now() - t0 > MAX_ZOEK_MS) { afgekapt = true; break; }
      const [rel, diepte] = stapel.pop();
      const ds = [];
      let dir = null;
      try {
        dir = fs.opendirSync(path.join(e.vault, rel));
        let d;
        while ((d = dir.readSync()) !== null) { if (++n > MAX_INGANGEN) { afgekapt = true; break; } ds.push(d); }
      } catch (x) { /* map onleesbaar of intussen weg */ }
      finally { if (dir) try { dir.closeSync(); } catch (x) { /* al dicht */ } }
      if (afgekapt) break;
      const media = new Set();
      for (const d of ds) { const x = extVan(d.name); if (!d.isDirectory() && MEDIA_EXT.indexOf(x) >= 0) media.add(d.name.slice(0, -x.length - 1).normalize('NFC')); }
      for (const d of ds) {
        if (d.name[0] === '.') continue;
        if (d.isDirectory()) { if (diepte < MAX_DIEPTE) stapel.push([rel + '/' + d.name, diepte + 1]); else afgekapt = true; continue; }
        if (!d.isFile()) continue;
        const ext = extVan(d.name), r = rel + '/' + d.name;
        if (AUDIO[ext]) { if (!audio.has(rel)) audio.set(rel, []); audio.get(rel).push(r.normalize('NFC')); continue; }
        if (ext !== 'md' || r === PAD) continue;
        let st;
        try { st = fs.lstatSync(path.join(e.vault, r)); } catch (x) { continue; }
        if (!st.isFile()) continue;
        const k = st.ino + ':' + st.size + ':' + st.mtimeMs;
        let c = kopCache.get(r);
        if (!c || c.k !== k) { const t = leesKlein(path.join(e.vault, r), KOP, true); c = { k: k, mt: !t.fout && noemtMediatheek(t.tekst) }; }
        nieuweKop.set(r, c);
        if (c.mt) gevonden.push({ map: rel, naam: d.name, zus: media.has(d.name.slice(0, -3).normalize('NFC')) });
      }
    }
    kopCache = nieuweKop;
    gevonden.sort((a, b) => (a.map + '/' + a.naam < b.map + '/' + b.naam ? -1 : 1));   // vaste volgorde (review O3: naam van een categorie zonder kop)
    return { gevonden: gevonden, audio: audio, afgekapt: afgekapt };
  }

  function bereken() {
    try {
      const st = fs.lstatSync(path.join(VAULT, TOP));
      if (!st.isDirectory()) return { ok: false, fout: 'de mediatheekmap is niet te lezen' };
      echt();
    } catch (e) { return { ok: false, fout: 'de mediatheekmap staat niet op de verwachte plek' }; }
    // de kaft: zelfde leesweg als een beschrijving (review wv1397 MOET 2/3: geen koppeling volgen, niet blokkeren op een FIFO)
    let kaft = null, kaftM = 0;
    const kt = leesKlein(path.join(echt().vault, PAD), MAX_PAGINA, false);
    if (!kt.fout) { kaft = leesKaft(kt.tekst); kaftM = kt.mtimeMs; }
    const z = zoek();
    const perId = new Map(), perCat = new Map(), teHerstellen = [], geclaimd = new Set(), mtMappen = new Set();
    let nb = 0, nweg = 0, laatst = kaftM;
    for (const g of z.gevonden) {
      mtMappen.add(g.map);
      const md = g.naam.normalize('NFC');
      if (!g.zus) { teHerstellen.push({ naam: md, reden: 'er staat geen mediabestand met dezelfde naam naast deze beschrijving' }); continue; }
      const r = beoordeel(g.map, g.naam);
      if (r.niet) continue;
      if (r.reden) { teHerstellen.push({ naam: md, reden: r.reden }); nweg += r.ontbreekt || 0; continue; }
      laatst = Math.max(laatst, r.mtimeMs);
      const s = r.stuk, bs = [];
      for (const { b, z: f } of r.rijen) {
        const id = idVan(b.pad);
        geclaimd.add(b.pad);
        if (!perId.has(id)) nb++;
        perId.set(id, { map: g.map, md: g.naam });
        bs.push({ id: id, naam: b.naam, ext: b.ext, soort: AUDIO[b.ext] ? 'audio' : 'bestand', label: b.ext, grootte: f.grootte, ontbreekt: false, te_groot: f.grootte > MAX_BESTAND });
      }
      const sl = catSleutel(s.categorie);
      if (!perCat.has(sl)) perCat.set(sl, { naam: plat(s.categorie), items: [] });
      perCat.get(sl).items.push({ titel: s.titel || bs[0].naam.replace(/\.[^.]+$/, ''), wie: s.wie, datum: s.datum, datum_tekst: s.datum_tekst,
        omschrijving: s.omschrijving, noot: null, favoriet: s.favoriet, bestanden: bs, paginas: [], geweigerd: 0 });
    }
    // zonder beschrijving: geluid in een map met beschrijvingen dat geen stuk is en geen (kapotte) beschrijving ernaast heeft
    const metBesch = new Set(z.gevonden.map((g) => (g.map + '/' + g.naam.slice(0, -3)).normalize('NFC')));
    let zonder = 0;
    for (const m of mtMappen) for (const a of z.audio.get(m) || []) if (!geclaimd.has(a) && !metBesch.has(a.slice(0, -extVan(a).length - 1))) zonder++;
    const nl = (a, b) => a.localeCompare(b, 'nl');
    const volg = (it) => it.sort((a, b) => nl(a.datum || '9999', b.datum || '9999') || nl(a.titel, b.titel));
    const onderwerpen = [];
    for (const k of kaft || []) {
      const sl = catSleutel(k.naam), c = perCat.get(sl);
      if (onderwerpen.some((o) => o._sl === sl)) continue;   // twee keer dezelfde kop: de eerste telt
      const paginas = k.paginas.filter((p) => p.pad.split('/')[0] === TOP && p.pad.indexOf('/') > 0);
      if (!c && !k.uitleg.length && !paginas.length) continue;
      onderwerpen.push({ _sl: sl, naam: k.naam, uitleg: k.uitleg, paginas: paginas, items: c ? volg(c.items) : [] });
    }
    const rest = [...perCat.entries()].filter(([sl]) => !onderwerpen.some((o) => o._sl === sl)).sort((a, b) => nl(a[1].naam, b[1].naam));
    for (const [sl, c] of rest) onderwerpen.push({ _sl: sl, naam: c.naam, uitleg: [], paginas: [], items: volg(c.items) });
    onderwerpen.forEach((o) => { delete o._sl; });
    teHerstellen.sort((a, b) => nl(a.naam, b.naam));
    const n = onderwerpen.reduce((t, o) => t + o.items.length, 0);
    return { ok: true, pagina: PAD, kaft: !!kaft, bijgewerkt: new Date(laatst || Date.now()).toISOString(), onderwerpen: onderwerpen, te_herstellen: teHerstellen,
      tel: { items: n, bestanden: nb, ontbreekt: nweg, te_herstellen: teHerstellen.length, zonder_beschrijving: zonder, afgekapt: z.afgekapt }, _perId: perId };
  }

  // De lijst hooguit CACHE_MS oud (20_Prive heeft ± 1.600 pagina's; alleen gewijzigde .md worden opnieuw gelezen)
  function lijst() {
    if (cache && Date.now() - cache.t < CACHE_MS) return cache.r;
    let r;
    try { r = bereken(); } catch (e) { fout('mediatheek-lijst', e); r = { ok: false, fout: 'de mediatheek is niet te lezen' }; }
    cache = { t: Date.now(), r: r };
    return r;
  }

  // M1: alleen een id uit de lijst; die ene beschrijving en dat bestand worden nu opnieuw gelezen en gecontroleerd
  function bestand(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) return { status: 404, j: { ok: false, fout: 'dit bestand is er niet (meer)' } };
    const l = lijst();
    if (!l.ok) return { status: 503, j: { ok: false, fout: l.fout } };
    const ref = l._perId.get(id);
    if (!ref) return { status: 404, j: { ok: false, fout: 'dit bestand staat niet (meer) in de mediatheek' } };
    let r;
    try { r = beoordeel(ref.map, ref.md); } catch (e) { r = { reden: 'fout' }; }
    const rij = r.rijen && r.rijen.find((x) => idVan(x.b.pad) === id);
    if (!rij) return { status: 404, j: { ok: false, fout: 'dit bestand staat niet (meer) in de mediatheek' } };
    const b = { pad: rij.b.pad, ext: rij.b.ext, abs: rij.z.abs, grootte: rij.z.grootte, dev: rij.z.dev, ino: rij.z.ino };
    if (b.grootte > MAX_BESTAND) return { status: 413, j: { ok: false, fout: 'te groot voor de app (meer dan 20 MB)' } };
    // Lezen via één fd (review wv1269 ZOU 1): O_NOFOLLOW (intussen een symlink = weigeren), O_NONBLOCK (een FIFO blokkeert de pod niet),
    // fstat: gewoon bestand, dezelfde inode als bij de controle, geen hardlink (nlink 1), en precies die grootte lezen.
    let fd = null;
    try {
      fd = fs.openSync(b.abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      if (!fdOpPlek(fd, b.abs)) return { status: 404, j: { ok: false, fout: 'niet te lezen' } };   // review wv1397 MOET 1
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.dev !== b.dev || st.ino !== b.ino) return { status: 404, j: { ok: false, fout: 'niet te lezen' } };
      if (st.size > MAX_BESTAND) return { status: 413, j: { ok: false, fout: 'te groot voor de app (meer dan 20 MB)' } };
      const buf = Buffer.alloc(st.size);
      let n = 0;
      while (n < st.size) { const k = fs.readSync(fd, buf, n, st.size - n, n); if (k <= 0) break; n += k; }
      if (n !== st.size) return { status: 404, j: { ok: false, fout: 'niet te lezen' } };
      return { status: 200, ext: b.ext, j: { ok: true, naam: b.pad.split('/').pop(), type: AUDIO[b.ext] || ANDERS[b.ext], grootte: buf.length,
        inhoud: buf.toString('base64') } };
    } catch (e) { fout('mediatheek-bestand', e); return { status: 404, j: { ok: false, fout: 'niet te lezen' } }; }
    finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* al dicht */ } }
  }

  function stand() {
    const l = lijst();
    if (!l.ok) return { status: 503, j: { ok: false, fout: l.fout } };
    const j = Object.assign({}, l);
    delete j._perId;
    return { status: 200, j: j };
  }

  function health() {
    const l = lijst();
    return l.ok ? { aan: true, pagina: l.kaft, items: l.tel.items, bestanden: l.tel.bestanden, ontbreekt: l.tel.ontbreekt,
      te_herstellen: l.tel.te_herstellen, zonder_beschrijving: l.tel.zonder_beschrijving, afgekapt: l.tel.afgekapt } : { aan: true, pagina: false };
  }

  return { stand: stand, bestand: bestand, health: health, lijst: lijst };
}

module.exports = { maak: maak, leesKaft: leesKaft, leesBeschrijving: leesBeschrijving, catSleutel: catSleutel, leesPagina: leesPagina, leesItem: leesItem, schoonDoel: schoonDoel, plat: plat, idVan: idVan, AUDIO: AUDIO, ANDERS: ANDERS, MAX_BESTAND: MAX_BESTAND };
