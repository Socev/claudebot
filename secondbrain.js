'use strict';
// Second Brain (wv832, 22/23-10-2026; bouwplan "01_Ontwikkeling/Second Brain - Obsidian-browser in de app (bouwplan 22-10-2026).md").
// WAAROM. David (22-10 ± 23:00): "dat je kan klikken op een betaling en dat je dan naar de Obsidian Browser gaat … (App: "Second Brain",
// met in Overzicht die mooie 3d-view van alle bestanden)". De vault was alleen in Obsidian op de laptop te lezen; deze module geeft de
// App een kaart (pad, domein, datum, links; geen inhoud), één pagina met opgeloste wikilinks en backlinks, een bestand voor de lezer,
// en zoeken. Voert idee 17b (vaultkaart) uit.
//
// Privacy (bouwplan § 4, Fable-review vooraf § 11):
// - P2 (vervallen, wv1901/wv3446): een apparaat met een vaste plek ziet de hele vault, net als de telefoon. isVastDicht() bestaat nog
//   alleen voor de poort van Docs › Delen (naar buiten; docs-delen.js).
// - P3 nooit: punt-mappen, node_modules, Beveiliging, Tokens, Vault-RAG, TempFinData, Claude outputs, 0b-werkmap, Drive-conflictkopieën,
//   symlinks, geen gewoon bestand, > 20 MB, en elke extensie die de App niet veilig toont (code, html, svg; Fable M1/M2).
// - P4 standaard verborgen (Bronnen, raw_input, _INBOX, 30_Conversaties): alleen uit de kaart en de zoeklijst, via een link te openen.
// - P5 elke tekst die de module teruggeeft gaat door masker() (secretpoort-patronen + kale tokens). De IBAN/BSN-stand van masker()
//   (tweede argument) gebruikt alleen nog de poort van Docs › Delen; de weergave voor David maskeert geen IBAN of BSN (wv3446).
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
const MAX_ENT = 8, MIN_TEKST = 10, MAX_LEZEN = 300;
const GELIJKEND_MAX = 12, GELIJKEND_ONDER = 5;   // wv3735: hooguit 12 pagina's uit de tekstindex (tikfouten, Woordenlijst), alleen bij < 5 eigen vondsten   // wv2077: hooguit 8 entiteiten, minstens 10 plekken voor tekstvondsten, 300 tekstvondsten om te rangschikken

// wv1931 (David 28-10: "Jij schermt af wat ik al heb"): geen vaultmap meer verborgen voor David. Beveiliging, Tokens, Vault-RAG,
// TempFinData, Claude outputs en 0b-werkmap zijn zichtbaar; het sleutelmasker (masker) geldt er zoals overal. Punt-mappen en
// node_modules slaat wandel() zelf over; de lijst blijft voor techniek die er later bij komt.
const NOOIT_MAP = [];
const VAST_DICHT_TOP = ['20_Prive', '30_Conversaties'];
const VAST_DICHT_DEEL = ['medewerkers', 'personeel', 'gesprekken'];
// VAST_DICHT_*: alleen nog voor isVastDicht(), de deelpoort van Docs › Delen (privé, gesprekken, personeel en systeem gaan niet naar buiten).
const VAST_DICHT_PREFIX = ['00_Systeem/Meldingen/', '01_Ontwikkeling/0b-werkmap/', '00_Systeem/Beveiliging/', '01_Ontwikkeling/Beveiliging/',
  '00_Systeem/Tokens/', '00_Systeem/Vault-RAG/', 'TempFinData/', 'Claude outputs/'];
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
// Sinds wv3405 (A32 deel 1) staat de patroonlijst in geheimen.js (één lijst voor alle filters). Weergave (streng weg) = precies het masker van
// vóór wv3405: app-weergave en de schrijfpoorten van de vault. streng = poortstand voor alles wat het huis verlaat (Zoek snel-model, Docs › Delen).
const GEHEIMEN = require('./geheimen.js');
const LW = require('./lees-of-weiger.js');   // wv3423 (B80): niet kunnen lezen is nooit leeg
// wv3750: de vaste landkaart (optioneel in de release; ontbreekt hij, dan geen plekken en schikt de app zelf zoals vroeger)
const BS = (function () { try { return require('./brein-schik.js'); } catch (e) { return null; } })();
function masker(t, vast, bsnMasker, streng) {
  let s = GEHEIMEN.maskeer(t, { streng: streng === true }).tekst;
  if (vast) {
    // IBAN, ook in kleine letters en uit andere landen (Fable diffreview K3): landcode, controlegetal, blokken van vier
    s = s.replace(/\b[A-Za-z]{2}[0-9]{2}(?: ?[A-Za-z0-9]{4}){2,7}(?: ?[A-Za-z0-9]{1,4})?\b/g, function (m) { return /[0-9]{6}/.test(m.replace(/ /g, '')) ? '[IBAN weggelaten]' : m; });
    if (typeof bsnMasker === 'function') { try { s = bsnMasker(s); } catch (e) {} }
  }
  return s;
}
// Strenge poortstand (wv3405): zelfde handtekening als masker, voor plekken die een masker als functie doorgeven.
function maskerStreng(t, vast, bsnMasker) { return masker(t, vast, bsnMasker, true); }

// Markeringen van gegenereerde blokken (<!-- sb:generated id="…" content_hash="<64 hex>" begin --> en … eind -->) zijn voor de
// scripts, niet voor de lezer: zonder dit toonde react-markdown ze als tekst en maakte het masker van de hash "[sleutel weggelaten]"
// (wv1999). Alleen de markering zelf verdwijnt (een regel met alleen de markering wordt leeg), het blok ertussen blijft; in
// codeblokken (documentatie) blijft alles staan.
const SB_MARKERING = /<!--[ \t]*sb:generated\b[^\r\n]{0,400}?-->/g;
function zonderMarkeringen(t) {
  const regels = String(t).split(/(\r?\n)/);
  let hek = null;
  for (let i = 0; i < regels.length; i += 2) {
    const r = regels[i];
    const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(r);
    if (m) {
      if (!hek) hek = m[1][0];
      else if (m[1][0] === hek) hek = null;
      continue;
    }
    if (hek || r.indexOf('sb:generated') < 0) continue;
    const z = r.replace(SB_MARKERING, '');
    if (z === r) continue;
    regels[i] = z.trim() ? z : '';   // lege regel i.p.v. weg: anders loopt tekst na het blok lui door in de callout (> …)
  }
  return regels.join('');
}

// wv2077: past de zoekvraag op een alias in de frontmatter (aliases: [a, b] of een lijst met -)? 1 = precies, 2 = alle woorden als heel woord, 0 = nee
function aliasPast(t, qPlat, woorden) {
  const fm = /^\uFEFF?---\r?\n([\s\S]{0,4000}?)\r?\n---/.exec(t);
  if (!fm) return 0;
  const m = /^(?:aliases|alias)\s*:[ \t]*(.*(?:\r?\n[ \t]+-.*)*)/m.exec(fm[1]);
  if (!m) return 0;
  const vlak = (x) => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const lijst = m[1].replace(/^\[|\]\s*$/g, '').split(/,|\r?\n[ \t]+-/).map(function (x) { return vlak(x.replace(/^[ \t]*-/, '').replace(/^\s*["']|["']\s*$/g, '')); }).filter(Boolean);
  const q = vlak(qPlat), qs = q.split(' ');
  if (lijst.some(function (a) { return a === q; })) return 1;
  if (lijst.some(function (a) { const ws = a.split(' '); return qs.every(function (w) { return ws.indexOf(w) >= 0; }); })) return 2;
  return 0;
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
  // wv3423 (B80): wat de laatste bouw niet kon lezen (deelmappen, voor /health) en de laatste mislukte bouw (oude kaart bleef staan)
  let overgeslagen = [], bouwFout = null;
  let bestandBezig = 0, zoekBezig = false, laatsteDwang = 0;
  let echteVault = null;
  // wv2607: linkdoelen per md-bestand uit de vorige bouw, op pad met mtime + ctime + grootte (ctime verandert bij elke schrijfactie en is
  // niet terug te zetten). Lezen + linksIn van ± 8.000 pagina's (± 200 MB) kostte ± 1,1 s per bouw; nu alleen gewijzigde bestanden. Het
  // oplossen (los) gebeurt elke bouw opnieuw over de hele lijst, want een nieuw of verdwenen bestand kan elk linkdoel veranderen.
  // Geen afscherming hier: de kaart is één ongefilterde lijst (sinds wv3446 ook per verzoek geen afscherming meer).
  let linkCache = new Map();
  // wv3003: de linkcache staat ook op schijf (linkcache.json naast kaart.json, 0600), zodat de eerste opening na een uitrol/podherstart niet
  // alle ± 8.500 pagina's opnieuw leest (gemeten 1,3 s; onder schijfdruk 15 s). Alleen pad + mtime + ctime + grootte + linkdoelen, geen
  // paginatekst. Even streng als in het geheugen: een hit eist dezelfde mtime, ctime en grootte (een kopie/verplaatsing van de vault geeft
  // een nieuwe ctime = opnieuw lezen), en het bestand geldt alleen voor dezelfde vault en dezelfde linksIn-code (een nieuwe parser = weg).
  const LINKCACHE_VERSIE = 1;
  const PARSER = crypto.createHash('sha256').update(linksIn.toString()).digest('hex').slice(0, 16);
  let linkCacheSchijf = null;   // sha256 van wat er op schijf staat (niet opnieuw schrijven als er niets veranderde)

  // wv3608 (actieplan 3B25, Fable-review brein-graaf idee 6): per dag tellen waar een geopende pagina vandaan kwam, zodat te zien is of de
  // kaart (Overzicht) gebruikt wordt naast Bladeren, Zoeken en links. Alleen aantallen per dag en herkomst: geen pad, naam of apparaat.
  // herkomst.json (0600) naast kaart.json, 120 dagen. Een ontbrekende of onbekende herkomst (oude app, andere aanroeper) telt niet.
  // Schrijven gebundeld en asynchroon (hooguit eens per 30 s), zodat een pagina openen nooit op de schijf wacht; een podherstart kost
  // hooguit de laatste 30 s aan tellingen. Te lezen in /health (secondbrain.herkomst: vandaag en de laatste 7 dagen).
  const HERKOMSTEN = ['kaart', 'bladeren', 'zoeken', 'link', 'app', 'terug', 'herstel', 'venster', 'anders'];
  const HERKOMST_DAGEN = 120, HERKOMST_SCHRIJF_MS = opt.herkomstSchrijfMs || 30000;
  let herkomstT = null, herkomstTimer = null, herkomstSchrijft = false, herkomstVuil = false;
  function herkomstDag(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
  // review: kalenderdagen terug vanaf de Amsterdamse datum (n × 24 u mist rond een klokwissel een dag)
  function herkomstDagMin(dag, n) { const [j, m, d] = dag.split('-').map(Number); return new Date(Date.UTC(j, m - 1, d - n)).toISOString().slice(0, 10); }
  function herkomstLees() {
    if (herkomstT) return herkomstT;
    herkomstT = {};
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DIR, 'herkomst.json'), 'utf8'));
      if (j && typeof j === 'object' && !Array.isArray(j)) for (const dag of Object.keys(j)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dag) || !j[dag] || typeof j[dag] !== 'object') continue;
        const r = {};
        for (const h of HERKOMSTEN) if (Number.isInteger(j[dag][h]) && j[dag][h] > 0) r[h] = j[dag][h];
        herkomstT[dag] = r;
      }
    } catch (e) { /* geen of onleesbaar bestand: vers beginnen */ }
    return herkomstT;
  }
  function herkomstSchrijf() {
    herkomstTimer = null;
    if (herkomstSchrijft) { herkomstVuil = true; return; }
    herkomstSchrijft = true; herkomstVuil = false;
    const doel = path.join(DIR, 'herkomst.json'), tmp = doel + '.tmp' + process.pid;
    fs.promises.writeFile(tmp, JSON.stringify(herkomstT), { mode: 0o600 })
      .then(function () { return fs.promises.rename(tmp, doel); })
      .catch(function (e) { fout('secondbrain-herkomst', e); })
      .then(function () { herkomstSchrijft = false; if (herkomstVuil && !herkomstTimer) herkomstPlan(); });
  }
  function herkomstPlan() {
    if (herkomstTimer) return;
    herkomstTimer = setTimeout(herkomstSchrijf, HERKOMST_SCHRIJF_MS);
    if (herkomstTimer.unref) herkomstTimer.unref();
  }
  function telHerkomst(h) {
    if (typeof h !== 'string' || HERKOMSTEN.indexOf(h) < 0) return false;
    const t = herkomstLees(), n = nu(), dag = herkomstDag(n);
    t[dag] = t[dag] || {};
    t[dag][h] = (t[dag][h] || 0) + 1;
    const grens = herkomstDagMin(dag, HERKOMST_DAGEN);
    for (const d of Object.keys(t)) if (d < grens) delete t[d];
    herkomstPlan();
    return true;
  }
  function herkomstStand() {
    const t = herkomstLees(), vandaag = herkomstDag(nu()), van = herkomstDagMin(vandaag, 6);
    const week = {};
    for (const d of Object.keys(t)) if (d >= van && d <= vandaag) for (const h of Object.keys(t[d])) week[h] = (week[h] || 0) + t[d][h];
    return { vandaag: Object.assign({}, t[vandaag] || {}), dagen7: week };
  }

  function mkdir() {
    try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.chmodSync(DIR, 0o700); } catch (e) { fout('secondbrain-dir', e); }
  }

  // wv3423 (B80): een onleesbare wortel gooit (NietGelezen; vers() houdt dan de oude kaart), een onleesbare deelmap telt mee in /health
  function wandel() {
    const lijst = [], over = [];
    const stap = function (abs, rel) {
      const items = LW.leesMap(abs, { lees: opt.leesMap, rel: rel, overgeslagen: rel ? over : undefined });
      if (!items) return;
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
        lijst.push({ p: r, s: soort, m: Math.floor(st.mtimeMs), g: st.size, c: st.ctimeMs });   // c (wv2607): alleen voor de linkcache; bouw haalt hem er meteen weer af
      }
    };
    stap(VAULT, '');
    overgeslagen = over;
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
    // wv3423 (B80): een leesbare maar lege wortel (lege mount) terwijl de vorige kaart bestanden had = niet gemeten; de oude kaart blijft
    LW.nulTerwijlBekend(bestanden.length, kaart ? kaart.bestanden.length : 0, 'vault');
    // wv2607: niets veranderd sinds de vorige bouw (zelfde paden, mtime, ctime, grootte) = dezelfde kaart, alleen weer vers
    const sig = crypto.createHash('sha256').update(bestanden.map(function (b) { return b.p + '\u0000' + b.m + '\u0000' + b.c + '\u0000' + b.g; }).join('\u0001')).digest('hex');
    if (kaart && kaart.sig === sig && kaart.op) { kaart.op = nu(); kaart.duur = Date.now() - t0; kaart.hergebruik = (kaart.hergebruik || 0) + 1; return kaart; }
    const ctimes = bestanden.map(function (b) { const c = b.c; delete b.c; return c; });   // review wv2607 MOET 1: ctime niet op de kaart (vers() is te lezen)
    bestanden.forEach(function (b) { b.d = domeinVan(b.p); b.v = isVerborgen(b.p); b.l = []; });
    const k = Object.assign({ bestanden: bestanden }, indexeer(bestanden));
    const nieuwCache = new Map();
    let gelezen = 0;
    for (let i = 0; i < bestanden.length; i++) {
      const b = bestanden[i];
      if (b.s !== 'md' || b.g > MAX_MD) continue;
      const c = linkCache.get(b.p);
      let doelen;
      if (c && c.m === b.m && c.c === ctimes[i] && c.g === b.g) doelen = c.doelen;
      else {
        let t;
        try { t = fs.readFileSync(path.join(VAULT, b.p), 'utf8'); } catch (e) { continue; }
        gelezen++;
        const dubbel = new Set();   // wv3003: elk doel één keer (de eerste telt; dezelfde doel+md lost toch naar hetzelfde bestand op), halveert de cache
        doelen = linksIn(t).filter(function (l) { const x = (l.md ? '1' : '0') + l.doel; if (!l.doel || dubbel.has(x)) return false; dubbel.add(x); return true; })
          .map(function (l) { return { doel: l.doel, md: l.md }; });
      }
      nieuwCache.set(b.p, { m: b.m, c: ctimes[i], g: b.g, doelen: doelen });
      const gezien = new Set();
      for (const l of doelen) {
        const r = los(l.doel, b.p, l.md, k);
        if (r && r.i !== undefined && r.i !== i && !gezien.has(r.i)) { gezien.add(r.i); b.l.push(r.i); }
      }
    }
    linkCache = nieuwCache;
    bewaarLinks(sig);
    k.sig = sig; k.gelezen = gelezen;
    k.op = nu(); k.duur = Date.now() - t0;
    kaart = k;
    bewaar(k);
    return k;
  }

  function bewaar(k) {
    try {
      const inhoud = JSON.stringify({ versie: 1, gebouwd: new Date(k.op).toISOString(), domeinen: DOMEINEN,
        bestanden: k.bestanden.map(function (b) { return { p: b.p, d: b.d, s: b.s, m: b.m, g: b.g, v: b.v, l: b.l }; }) });
      const h = crypto.createHash('sha256').update(inhoud.replace(/"gebouwd":"[^"]*"/, '')).digest('hex');
      if (h === laatsteHash) return;
      mkdir();
      const doel = path.join(DIR, 'kaart.json'), tmp = doel + '.tmp' + process.pid;
      fs.writeFileSync(tmp, inhoud, { mode: 0o600 });
      fs.renameSync(tmp, doel);
      laatsteHash = h;
    } catch (e) { fout('secondbrain-bewaar', e); }
  }

  // wv3003: linkcache naar schijf, atomisch; sig = de bestandenlijst waarvoor hij geldt (alleen om dubbel schrijven te sparen).
  function bewaarLinks(sig) {
    try {
      if (linkCacheSchijf === sig) return;
      const items = [];
      linkCache.forEach(function (c, p) { items.push([p, c.m, c.c, c.g, c.doelen.map(function (l) { return l.md ? [l.doel, 1] : [l.doel]; })]); });
      const inhoud = JSON.stringify({ versie: LINKCACHE_VERSIE, parser: PARSER, vault: VAULT, items: items });
      mkdir();
      const doel = path.join(DIR, 'linkcache.json'), tmp = doel + '.tmp' + process.pid;
      fs.writeFileSync(tmp, inhoud, { mode: 0o600 });
      fs.renameSync(tmp, doel);
      linkCacheSchijf = sig;
    } catch (e) { fout('secondbrain-linkcache', e); }
  }
  // Bij de start: alleen overnemen als versie, parser en vault kloppen en elk item de juiste vorm heeft; anders leeg (= de oude koude bouw).
  function laadLinks() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DIR, 'linkcache.json'), 'utf8'));
      if (!j || j.versie !== LINKCACHE_VERSIE || j.parser !== PARSER || j.vault !== VAULT || !Array.isArray(j.items)) return 0;
      const m = new Map();
      const getal = function (x) { return typeof x === 'number' && isFinite(x); };
      for (const it of j.items) {
        if (!Array.isArray(it) || it.length !== 5 || typeof it[0] !== 'string' || !getal(it[1]) || !getal(it[2]) || !getal(it[3]) || !Array.isArray(it[4])) return 0;
        const doelen = [];
        for (const l of it[4]) {
          if (!Array.isArray(l) || typeof l[0] !== 'string' || !l[0]) return 0;
          doelen.push({ doel: l[0], md: l[1] === 1 });
        }
        m.set(it[0], { m: it[1], c: it[2], g: it[3], doelen: doelen });
      }
      if (!linkCache.size) linkCache = m;
      return m.size;
    } catch (e) { return 0; }   // geen of onleesbaar bestand: de eerste bouw leest alles (zoals voor wv3003)
  }

  // Eén bouw tegelijk (Fable K9); vers genoeg = de bestaande. Synchroon onder de motorkap (wv2607: ± 150 ms met de linkcache, ± 1,1 s zonder).
  function vers(dwing) {
    if (!dwing && kaart && nu() - kaart.op < KAART_VERS_MS) return kaart;
    if (bouwBezig) return kaart || bouw();
    bouwBezig = true;
    try { const k = bouw(); bouwFout = null; return k; }
    catch (e) { bouwFout = { t: new Date(nu()).toISOString(), fout: String(e && e.message || e).slice(0, 160) }; fout('secondbrain-bouw', e); return kaart; }
    finally { bouwBezig = null; }
  }

  // Weergave P4: verborgen (bronnen, raw_input, _INBOX, gesprekken) alleen uit kaart en zoeklijst, met "alles" erbij. Geen afscherming per
  // apparaat meer (wv3446, David 19-11-2026: "dat soort filtering doe je niet meer. NERGENS.").

  // De knopen en lijnen zoals de App ze krijgt (alles = met het verborgen deel); ook de invoer van de nachtschikking (wv3750).
  function zichtbaar(k, alles) {
    const naar = new Map(), knopen = [];
    const tel = {};
    let verborgen = 0;
    k.bestanden.forEach(function (b, i) {
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
    return { knopen: knopen, lijnen: lijnen, graad: graad, tel: tel, verborgen: verborgen };
  }

  // wv3750 (besluitenpagina nr 483 = 3C183): de vaste landkaart. De nachtstap (schikNacht) rekent de plekken uit (brein-schik.js, in een
  // worker_thread) en bewaart ze in schikking.json naast kaart.json (0600, alleen paden + getallen); kaartVoor stuurt ze mee in de gewone
  // weergave (niet bij "alles": het verborgen deel zit niet in de schikking). plek3/plek2: platte lijst gehele getallen per knoop, null voor
  // een pagina die er sinds de nacht bij kwam (de app legt die bij zijn buren). Mislukt de nacht, dan blijft het bestand van gisteren.
  let schikCache = null;   // { mtime, j }
  function leesSchikking() {
    if (!BS) return null;
    let st;
    try { st = fs.statSync(path.join(DIR, 'schikking.json')); } catch (e) { schikCache = null; return null; }
    if (schikCache && schikCache.mtime === st.mtimeMs) return schikCache.j;
    const j = BS.lees(DIR);
    schikCache = { mtime: st.mtimeMs, j: j };
    return j;
  }
  function plekkenVoor(knopen) {
    const s = leesSchikking();
    if (!s) return null;
    const p3 = new Array(knopen.length * 3), p2 = new Array(knopen.length * 2);
    let mis = 0;
    knopen.forEach(function (b, i) {
      const a = Object.prototype.hasOwnProperty.call(s.d3, b.p) ? s.d3[b.p] : null, c = Object.prototype.hasOwnProperty.call(s.d2, b.p) ? s.d2[b.p] : null;
      const goed = function (v, n) { return Array.isArray(v) && v.length === n && v.every(function (g) { return typeof g === 'number' && isFinite(g); }); };
      if (goed(a, 3)) { p3[i * 3] = a[0]; p3[i * 3 + 1] = a[1]; p3[i * 3 + 2] = a[2]; } else { p3[i * 3] = p3[i * 3 + 1] = p3[i * 3 + 2] = null; mis++; }
      if (goed(c, 2)) { p2[i * 2] = c[0]; p2[i * 2 + 1] = c[1]; } else { p2[i * 2] = p2[i * 2 + 1] = null; }
    });
    return { plek3: p3, plek2: p2, plek_dag: s.dag || null, plek_mis: mis };
  }
  let schikBezig = null, schikLaatst = null;
  async function schikNacht(datum, opt2) {
    if (!BS) return { ok: true, al_gedaan: true, detail: { niet_in_release: true } };
    if (schikBezig) return schikBezig;
    const ms = (opt2 && opt2.ms) || 150000;
    schikBezig = (async function () {
      const t0 = Date.now();
      const k = vers(false);
      if (!k) throw new Error('de kaart is nu niet te bouwen');
      const z = zichtbaar(k, false);
      const inv = BS.invoerUitKaart(z.knopen, z.lijnen);
      const vorig = leesSchikking();
      const r = await (opt2 && opt2.reken ? opt2.reken(inv, vorig, ms) : BS.schikDraad(inv, vorig ? { d3: vorig.d3, d2: vorig.d2 } : null, ms));
      mkdir();
      BS.schrijf(DIR, { versie: BS.VERSIE, dag: datum || null, gebouwd: new Date(nu()).toISOString(), n: inv.paden.length, d3: r.d3, d2: r.d2 });
      schikLaatst = { t: new Date(nu()).toISOString(), ok: true, n: inv.paden.length, ms: Date.now() - t0, warm: !!r.warm3 };
      return { ok: true, detail: { n: inv.paden.length, ms: Date.now() - t0, warm: !!r.warm3, lijsten: r.lijsten } };
    })().catch(function (e) {
      schikLaatst = { t: new Date(nu()).toISOString(), ok: false, fout: String(e && e.message || e).slice(0, 160) };
      fout('secondbrain-schik', e);
      throw e;
    }).finally(function () { schikBezig = null; });
    return schikBezig;
  }

  function kaartVoor(ctx, alles) {
    const k = vers(false);
    if (!k) return { status: 503, j: { ok: false, fout: 'de kaart is nu niet te bouwen' } };
    const z = zichtbaar(k, alles);
    const knopen = z.knopen, graad = z.graad, tel = z.tel;
    const j = { ok: true, bijgewerkt: new Date(k.op).toISOString(), alles: !!alles,
      domeinen: DOMEINEN.map(function (n, i) { return { i: i, naam: n, n: tel[n] || 0 }; }),
      knopen: knopen.map(function (b, li) { return [b.p, DOMEINEN.indexOf(b.d), b.s, new Date(b.m).toISOString().slice(0, 10), graad[li]]; }),
      lijnen: z.lijnen, verborgen_n: z.verborgen };
    if (!alles) { let pl = null; try { pl = plekkenVoor(knopen); } catch (e) { pl = null; fout('secondbrain-plek', e); } if (pl) Object.assign(j, pl); }
    return { status: 200, j: j };
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
      const m = masker(kop + e.waarde.replace(/^["']|["']$/g, ''));
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
        doelen[l.ruw] = { p: b.p, s: b.s };
      } else if (r && r.k) {
        const ks = r.k.map(function (i) { return k.bestanden[i]; });
        doelen[l.ruw] = ks.length === 1 ? { p: ks[0].p, s: ks[0].s } : ks.length ? { k: ks.map(function (b) { return b.p; }) } : null;
      } else doelen[l.ruw] = null;
    }
    const terug = [];
    k.bestanden.forEach(function (b) { if (b.l.indexOf(z.i) >= 0) terug.push(b.p); });
    terug.sort(function (a, b) { return a.split('/').pop().localeCompare(b.split('/').pop(), 'nl'); });
    telHerkomst(d && d.herkomst);   // wv3608: alleen een geslaagde opening telt
    return { status: 200, audit: audit(z.b), j: { ok: true, pad: z.b.p, domein: z.b.d, gewijzigd: new Date(z.b.m).toISOString(),
      grootte: z.b.g, eigenschappen: fm ? eigenschappen(fm, ctx) : [], md: masker(zonderMarkeringen(t)), doelen: doelen, terug: terug.slice(0, 200),
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
      if (z.b.s === 'tekst') buf = Buffer.from(masker(buf.toString('utf8')), 'utf8');
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
      eigenschappen: dl.fmTekst ? eigenschappen(dl.fmTekst, ctx) : [], md: reden ? masker(body) : body } };
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
    return schrijf(z, versie, ctx, function (oud) {
      const dl = delen(oud);
      let body = md.replace(/\r\n/g, '\n');
      if (/\n$/.test(dl.body) && !/\n$/.test(body)) body += '\n';
      if (dl.crlf) body = body.replace(/\n/g, '\r\n');
      return dl.bom + dl.fm + body;
    });
  }
  // Eén schrijfstap voor bewaar en bewaar-terug: versie, bewerkbaarheid en vorige versie beslist op wat er nú staat (binnen wijzig).
  function schrijf(z, versie, ctx, maakNieuw) {
    let uitkomst = null, nieuweVersie = null, geschreven = false;
    try {
      geschreven = opt.wijzig(z.abs, function (oud) {
        if (sha(oud) !== versie) { uitkomst = 'conflict'; return null; }
        const reden = nietBewerkbaar(Object.assign({}, z, { st: { size: Buffer.byteLength(oud, 'utf8') } }), oud, ctx);
        if (reden) { uitkomst = reden; return null; }
        const nieuw = maakNieuw(oud);
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

  // wv1382: vorige versies (bewaarVorige) tonen en terugzetten. De lijst komt uit opt.versieDir/<hmac van het pad>; terugzetten schrijft de
  // hele vorige inhoud (met de frontmatter van toen) via dezelfde schrijfstap: versie van nu klopt (409), bewerkbaar (403), geen sleutel
  // (422), niet in onderhoud of tijdens een sync (423); wat er nu staat wordt eerst zelf een vorige versie (terugzetten is terug te draaien).
  const VERSIE_NAAM = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]{6}\.md$/;
  function versieMap(p) { return opt.versieDir ? path.join(opt.versieDir, hmac(p)) : null; }
  function docsVersies(d, ctx) {
    const z = zoekPad(d && d.pad, ctx);
    if (!z || z.b.s !== 'md') return { status: 404, j: { ok: false, fout: 'deze pagina is er niet (meer)' }, audit: audit(null, d && d.pad) };
    if (ctx.vast) return { status: 403, j: { ok: false, fout: 'op een vaste plek kun je hier alleen lezen' }, audit: audit(z.b) };
    let t;
    try { t = opt.lees ? opt.lees(z.abs) : fs.readFileSync(z.abs, 'utf8'); } catch (e) { return { status: 404, j: { ok: false, fout: 'niet te lezen' }, audit: audit(z.b) }; }
    const map = versieMap(z.b.p);
    let namen = [];
    try { namen = map ? fs.readdirSync(map).filter(function (n) { return VERSIE_NAAM.test(n); }).sort().reverse() : []; } catch (e) { namen = []; }
    const lijst = [];
    for (const n of namen) {
      let st;
      try { st = fs.lstatSync(path.join(map, n)); } catch (e) { continue; }
      if (!st.isFile()) continue;
      const m = VERSIE_NAAM.exec(n);
      lijst.push({ id: n, op: m[1] + ':' + m[2] + ':' + m[3] + '.' + m[4] + 'Z', grootte: st.size });
    }
    return { status: 200, audit: audit(z.b), j: { ok: true, pad: z.b.p, versie: sha(t), bewerkbaar: !nietBewerkbaar(z, t, ctx), versies: lijst } };
  }
  function docsBewaarTerug(d, ctx) {
    const versie = d && d.versie, id = d && d.id;
    if (typeof versie !== 'string' || !/^[0-9a-f]{32}$/.test(versie) || typeof id !== 'string' || !VERSIE_NAAM.test(id))
      return { status: 400, j: { ok: false, fout: 'onvolledig verzoek' }, audit: audit(null, d && d.pad) };
    const z = zoekPad(d.pad, ctx);
    if (!z || z.b.s !== 'md') return { status: 404, j: { ok: false, fout: 'deze pagina is er niet meer; misschien is hij verplaatst.' }, audit: audit(null, d.pad) };
    if (ctx.vast) return { status: 403, j: { ok: false, fout: 'op een vaste plek kun je hier alleen lezen' }, audit: audit(z.b) };
    if (opt.onderhoud && opt.onderhoud()) return { status: 423, j: { ok: false, fout: 'de vault staat even in onderhoud; probeer het later opnieuw.' }, audit: audit(z.b) };
    if (opt.grendelVrij && !opt.grendelVrij()) return { status: 423, j: { ok: false, fout: 'er loopt net een synchronisatie; probeer het over een minuut opnieuw.' }, audit: audit(z.b) };
    const map = versieMap(z.b.p);
    let vorige;
    try {
      const vp = path.join(map, id);
      const st = fs.lstatSync(vp);
      if (!st.isFile() || st.size > MAX_BEWERK) throw new Error('geen gewoon bestand');
      vorige = fs.readFileSync(vp, 'utf8');
    } catch (e) { return { status: 404, j: { ok: false, fout: 'deze vorige versie is er niet (meer)' }, audit: audit(z.b) }; }
    if (masker(vorige, false, null) !== vorige) return { status: 422, j: { ok: false, fout: 'in die vorige versie staat iets dat op een sleutel lijkt; die zet ik niet terug' }, audit: audit(z.b) };
    if (!opt.wijzig) return { status: 503, j: { ok: false, fout: 'terugzetten kan in deze versie van de pod niet' }, audit: audit(z.b) };
    return schrijf(z, versie, ctx, function () { return vorige; });
  }
  // wv1382: de bron voor Delen (docs-delen.js): zelfde padregels als openen (kaart, vaste plek, realpath, geen symlink), ongemaskeerd;
  // de poort van docs-delen beslist wat eruit mag.
  function bron(pad, ctx) {
    const z = zoekPad(pad, ctx || {});
    if (!z || z.b.s !== 'md' || z.st.size > MAX_MD) return null;
    let t;
    try { t = opt.lees ? opt.lees(z.abs) : fs.readFileSync(z.abs, 'utf8'); } catch (e) { return null; }
    return { p: z.b.p, d: z.b.d, tekst: t };
  }

  const plat = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Eerst een ruim stuk maskeren en dan pas knippen: anders verliest een sleutel op de knipgrens zijn kop en herkent het masker
  // de staart niet meer (Fable diffreview K4).
  function fragment(tekst, pos, ctx) {
    const ruimVan = Math.max(0, pos - 600);
    const ruim = masker(tekst.slice(ruimVan, pos + 600));
    const rel = Math.min(ruim.length, pos - ruimVan);
    const van = Math.max(0, rel - 60);
    const f = ruim.slice(van, van + FRAGMENT * 2).replace(/\s+/g, ' ').trim().slice(0, FRAGMENT);
    return (van > 0 || ruimVan > 0 ? '… ' : '') + f + (f.length >= FRAGMENT ? ' …' : '');
  }

  // wv1940 (David 29-10: "vinkjes boven … 'PDF', 'Media' — dat maakt zoeken makkelijker"): soorten = vaste codes in twee groepen. Binnen een
  // groep of, tussen de groepen en: soort van het bestand én waar het staat; een lege groep = alles in die groep, geen enkele code = alles.
  // Zonder het veld soorten het oude gedrag (alles = ook Bronnen en gesprekken), voor een app van vóór wv1940. Filteren gebeurt hier vóór
  // de limiet, zodat de 40 treffers (afgekapt) per gekozen soort gelden. Media, Excel, PowerPoint en oude .doc zoekt de pod alleen op de naam;
  // pdf en docx sinds wv3734 ook op inhoud (opt.inhoud).
  const ZOEK_SOORT = ['paginas', 'pdf', 'office', 'media'], ZOEK_PLEK = ['vault', 'bronnen', 'gesprekken'];
  const soortCode = function (b) {
    if (b.s === 'md') return 'paginas';
    if (b.s === 'tekst') return extVan(b.p) === 'csv' ? 'office' : 'paginas';
    if (b.s === 'pdf' || b.s === 'office') return b.s;
    return 'media';   // beeld, audio
  };
  const plekCode = function (b) { return b.p.split('/')[0] === '30_Conversaties' ? 'gesprekken' : b.v ? 'bronnen' : 'vault'; };
  function zoekKeuze(d) {
    if (!d || d.soorten === undefined || d.soorten === null) return null;
    const s = d.soorten;
    if (!Array.isArray(s) || s.length > ZOEK_SOORT.length + ZOEK_PLEK.length || s.some(function (c) { return ZOEK_SOORT.indexOf(c) < 0 && ZOEK_PLEK.indexOf(c) < 0; }))
      return { fout: true };
    return { soort: new Set(s.filter(function (c) { return ZOEK_SOORT.indexOf(c) >= 0; })), plek: new Set(s.filter(function (c) { return ZOEK_PLEK.indexOf(c) >= 0; })) };
  }

  async function zoek(d, ctx) {
    const q = String(d && d.q || '').trim().slice(0, MAX_Q);
    if (q.length < 2) return { status: 400, j: { ok: false, fout: 'typ minstens twee tekens' } };
    const keuze = zoekKeuze(d);
    if (keuze && keuze.fout) return { status: 400, j: { ok: false, fout: 'onbekende soort in het zoekfilter' } };
    const alles = !!(d && d.alles);
    const plekGoed = function (b) { return (keuze ? !keuze.plek.size || keuze.plek.has(plekCode(b)) : alles || !b.v); };
    const past = function (b) { return plekGoed(b) && (!keuze || !keuze.soort.size || keuze.soort.has(soortCode(b))); };
    // de vault zelf eerst, dan Bronnen en gesprekken (die zoeken nu standaard mee; zonder voorrang verdringen de dagdumps de pagina's)
    const rang = function (b) { return b.v ? 1 : 0; };
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
        if (!past(b)) continue;   // wv1940: zelfde filter als de tekstzoek
        gezien.add(i);
        uit.push({ pad: b.p, waar: 'betekenis', fragment: masker(String(c.text || '')).replace(/\s+/g, ' ').trim().slice(0, FRAGMENT) });
        if (uit.length >= MAX_TREFFERS) break;
      }
      return { status: 200, j: { ok: true, q: q, treffers: uit, betekenis: true } };
    }
    if (zoekBezig) return { status: 429, j: { ok: false, fout: 'er loopt al een zoekvraag; even geduld' } };
    zoekBezig = true;
    try {
      // wv2077 (David 31-10: "een wirwar van pagina's … de Entiteitspagina bovenaan"): drie groepen op relevantie in plaats van naam en
      // tekst op datum. 1. entiteiten: de pagina van een partij of persoon uit het register (Entiteiten & Personen) waarvan naam of alias
      // past (opt.entiteiten, brain-entiteiten.js), elk pad nog langs de kaart en het filter; 2. paginas: de paginanaam past (precies, als
      // heel woord, als begin van een woord, ergens erin) of een alias in de frontmatter; 3. tekst: in de tekst, op hoe vaak de woorden
      // erin staan, en pagina's die alleen in een map met die naam staan (vroeger "naam": dat was de wirwar). Binnen een groep eerst de
      // vault zelf, dan Bronnen en gesprekken. Een oudere app leest pad, waar en fragment en negeert de rest.
      const woorden = plat(q).split(/\s+/).filter(function (w) { return w.length > 0; }).slice(0, 8);
      const qPlat = woorden.join(' ');
      const t0 = Date.now();
      // wv3735 (besluitenpagina nr 422 = 3C122, David Ja 21-11 13:20): typfouten vergeven. De tekstindex van Zoek snel (zoekindex.py:
      // tikfout → dichtstbijzijnde woord uit de vault, varianten uit de Woordenlijst) loopt als apart proces mee terwijl hieronder gezocht
      // wordt; zijn pagina's die hier niet al gevonden zijn komen achteraan in de tekstgroep (waar 'gelijkend'). Zonder index, te oud of
      // te traag: gewoon zonder (opt.gelijkend geeft dan null).
      let gelijkendP = null;
      if (typeof opt.gelijkend === 'function') {
        try { gelijkendP = Promise.resolve(opt.gelijkend(q)).catch(function () { return null; }); } catch (e) { gelijkendP = null; }
      }
      let afgekapt = false;
      const lijst = k.bestanden.filter(past);
      const stamPlat = function (b) { return plat(b.p.split('/').pop().replace(/\.[^.\/]+$/, '')).replace(/[^a-z0-9]+/g, ' ').trim(); };
      const naamSterk = function (b) {   // 0 precies · 1 begint ermee · 2 alle woorden heel · 3 begin van een woord · 4 ergens in de naam · null
        const n = stamPlat(b), ws = n.split(' ');
        if (n === qPlat || n.replace(/^entiteit /, '') === qPlat) return 0;
        if (n.indexOf(qPlat + ' ') === 0) return 1;
        if (woorden.every(function (w) { return ws.indexOf(w) >= 0; })) return 2;
        if (woorden.every(function (w) { return ws.some(function (y) { return y.indexOf(w) === 0; }); })) return 3;
        if (woorden.every(function (w) { return n.indexOf(w) >= 0; })) return 4;
        return null;
      };
      const padPast = function (b) { const p = plat(b.p); return woorden.every(function (w) { return p.indexOf(w) >= 0; }); };
      // wv1940: teller per soort die alleen op naam zoekt (dus exact en goedkoop), binnen de gekozen plekken
      let tel;
      if (keuze) {
        tel = { pdf: 0, office: 0, media: 0 };
        for (const b of k.bestanden) {
          const c = soortCode(b);
          if (c !== 'paginas' && plekGoed(b) && padPast(b)) tel[c]++;
        }
      }
      // 1. entiteiten (hooguit 2,5 s; lukt het niet, dan zonder die groep en ent_fout)
      const ent = [], gehad = new Set();
      let entFout = false;
      if (typeof opt.entiteiten === 'function') {
        let rij = null;
        try {
          rij = await Promise.race([Promise.resolve(opt.entiteiten(q)), new Promise(function (ok) { setTimeout(function () { ok(null); }, 2500).unref(); })]);
        } catch (e) { rij = null; }
        if (!Array.isArray(rij)) entFout = true;
        else for (const e of rij) {
          const i = k.perPad.get(sleutel(String(e && e.pad || '')));
          if (i === undefined) continue;
          const b = k.bestanden[i];
          if (!past(b) || gehad.has(b.p) || ent.length >= MAX_ENT) continue;
          gehad.add(b.p);
          ent.push({ b: b, pad: b.p, waar: 'entiteit', groep: 'entiteiten', fragment: '', soort: e.soort ? String(e.soort).slice(0, 40) : null, sleutel: /^[0-9a-f]{12}$/.test(String(e.sleutel)) ? e.sleutel : null });
        }
      }
      // 2. op de paginanaam
      const opNaam = [];
      for (const b of lijst) {
        if (gehad.has(b.p)) continue;
        const s = naamSterk(b);
        if (s !== null) { opNaam.push({ b: b, pad: b.p, waar: 'naam', groep: 'paginas', fragment: '', s: s }); gehad.add(b.p); }
      }
      // 3. in de tekst (en de frontmatter-alias, die promoveert naar paginas). Eerst wat in een map met die naam staat, dan de vault zelf
      // op datum; lezen stopt bij MAX_LEZEN treffers of ZOEK_MS. Daarna gerangschikt op hoe vaak de woorden erin staan.
      const opTekst = [];
      // wv3734 (David Ja 21-11, nr 404 = 3C104): pdf en docx ook op inhoud, uit de tekstcache van brain-tekst.js (opt.inhoud; alleen als
      // het stuk sinds de laatste uitleesronde niet gewijzigd is)
      const inhoud = opt.inhoud && typeof opt.inhoud.tekst === 'function' ? opt.inhoud : null;
      const metInhoud = function (b) { return !!inhoud && (b.s === 'pdf' || b.s === 'office') && inhoud.heeft(b); };
      const tekstLijst = lijst.filter(function (b) { return ((b.s === 'md' || b.s === 'tekst') && b.g <= MAX_MD || metInhoud(b)) && !gehad.has(b.p); })
        .map(function (b) { return { b: b, map: padPast(b) ? 0 : 1 }; })
        .sort(function (a, z) { return a.map - z.map || rang(a.b) - rang(z.b) || z.b.m - a.b.m; });
      const telIn = function (t, w) { let n = 0, i = t.indexOf(w); while (i >= 0 && n < 20) { n++; i = t.indexOf(w, i + w.length); } return n; };
      // wv3734: een vraag van meer woorden die letterlijk als zin in een stuk staat ("zin die alleen in een pdf staat") komt bovenaan de
      // tekstgroep, en na de grens van MAX_LEZEN gewone vondsten wordt (binnen ZOEK_MS) nog doorgelezen op zo'n hele zin (hooguit
      // MAX_TREFFERS extra), zodat een stuk in Bronnen niet wegvalt achter honderd pagina's die dezelfde losse woorden hebben.
      const frase = woorden.length > 1 ? qPlat : null;
      let gewoon = 0, fraseNa = 0;
      for (const x of tekstLijst) {
        const b = x.b;
        const tijdOp = Date.now() - t0 > ZOEK_MS, vol = (frase ? gewoon : opTekst.length) >= MAX_LEZEN;
        if ((tijdOp || vol) && (tijdOp || !frase || fraseNa >= MAX_TREFFERS)) {
          afgekapt = true;
          if (x.map === 0) opTekst.push({ b: b, pad: b.p, waar: 'map', groep: 'tekst', fragment: '', n: 0 });   // niet meer gelezen: alleen de map
          if (opTekst.length >= MAX_LEZEN + MAX_TREFFERS) break;
          continue;
        }
        let t;
        const stuk = b.s === 'pdf' || b.s === 'office';
        if (stuk) { t = inhoud.tekst(b); if (t === null) continue; }
        else try { t = fs.readFileSync(path.join(VAULT, b.p), 'utf8'); } catch (e) { continue; }
        let bron = t.toLowerCase();
        if (!woorden.every(function (w) { return bron.indexOf(w) >= 0; })) {
          if (!/[À-ɏ]/.test(t)) { if (x.map === 0) opTekst.push({ b: b, pad: b.p, waar: 'map', groep: 'tekst', fragment: '', n: 0 }); continue; }
          bron = plat(t);
          if (!woorden.every(function (w) { return bron.indexOf(w) >= 0; })) { if (x.map === 0) opTekst.push({ b: b, pad: b.p, waar: 'map', groep: 'tekst', fragment: '', n: 0 }); continue; }
        }
        const fr = !!frase && bron.replace(/\s+/g, ' ').indexOf(frase) >= 0;
        if (vol) { afgekapt = true; if (!fr) continue; fraseNa++; }   // na de grens alleen nog de hele zin
        const al = stuk ? 0 : aliasPast(t, qPlat, woorden);
        if (al) { opNaam.push({ b: b, pad: b.p, waar: 'alias', groep: 'paginas', fragment: '', s: al === 1 ? 1.5 : 2.5 }); continue; }
        const n = woorden.reduce(function (s, w) { return s + telIn(bron, w); }, 0);
        const vanaf = fr ? Math.max(0, bron.indexOf(woorden[0])) : bron.indexOf(woorden[0]);
        opTekst.push({ b: b, pad: b.p, waar: stuk ? 'inhoud' : 'tekst', groep: 'tekst', fragment: fragment(t, Math.min(vanaf, t.length), ctx), n: n + (x.map === 0 ? 3 : 0), fr: fr ? 1 : 0 });
        if (!fr) gewoon++;
      }
      // wv3735: de pagina's uit de tekstindex die hierboven niet gevonden zijn (meestal: een typfout of een woord uit de Woordenlijst).
      // Alleen als hier weinig gevonden is (GELIJKEND_ONDER): de index zoekt elk woord los (of), zodat hij bij een vraag die al goed
      // vindt vooral ruis toevoegt. Een typfout in één van de woorden geeft hierboven niets (alle woorden moeten erin staan).
      let gelijkendN = 0;
      if (gelijkendP && ent.length + opNaam.length + opTekst.filter(function (x) { return x.waar !== 'map'; }).length < GELIJKEND_ONDER) {
        const gl = await gelijkendP;
        const pl = gl && Array.isArray(gl.paginas) ? gl.paginas : [];
        const delen = gl && Array.isArray(gl.delen) ? gl.delen : [];
        for (const [o, pd] of pl.slice(0, GELIJKEND_MAX).entries()) {
          const i = k.perPad.get(sleutel(String(pd || '')));
          if (i === undefined) continue;
          const b = k.bestanden[i];
          if (!past(b) || gehad.has(b.p) || opTekst.some(function (x) { return x.pad === b.p; })) continue;
          gehad.add(b.p);
          const d = delen.find(function (x) { return x && x.pad === pd && typeof x.tekst === 'string'; });
          const fr = d ? masker(d.tekst.replace(/^\s*\|?[-:| ]+\|?\s*$/gm, ' ')).replace(/\s+/g, ' ').trim().slice(0, FRAGMENT) : '';
          opTekst.push({ b: b, pad: b.p, waar: 'gelijkend', groep: 'tekst', fragment: fr, n: -1, gl: 1, o: o });
          gelijkendN++;
        }
      }
      opNaam.sort(function (a, z) { return rang(a.b) - rang(z.b) || a.s - z.s || z.b.m - a.b.m; });
      opTekst.sort(function (a, z) { return (a.gl || 0) - (z.gl || 0) || (a.gl ? a.o - z.o : 0) || (z.fr || 0) - (a.fr || 0) || rang(a.b) - rang(z.b) || z.n - a.n || z.b.m - a.b.m; });
      const naamDeel = opNaam.slice(0, MAX_TREFFERS - ent.length - Math.min(opTekst.length, MIN_TEKST));   // de tekstgroep houdt minstens MIN_TEKST plekken
      const alle = ent.concat(naamDeel).concat(opTekst);
      const treffers = alle.slice(0, MAX_TREFFERS).map(function (x) {
        const t = { pad: x.pad, waar: x.waar, groep: x.groep, fragment: x.fragment, domein: x.b.d, gewijzigd: new Date(x.b.m).toISOString().slice(0, 10) };
        if (x.soort) t.soort = x.soort;
        if (x.sleutel) t.sleutel = x.sleutel;
        return t;
      });
      const j = { ok: true, q: q, treffers: treffers, afgekapt: afgekapt || ent.length + opNaam.length + opTekst.length > treffers.length, ms: Date.now() - t0,
        groepen: { entiteiten: ent.length, paginas: opNaam.length, tekst: opTekst.length, gelijkend: gelijkendN } };
      if (entFout) j.ent_fout = true;
      if (tel) j.tel = tel;
      return { status: 200, j: j };
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

  // ── wv3717 (besluitenpagina nr 505 = 3C205, David Ja 21-11-2026 13:09; Fable-review brein-graaf idee 14): "Wat speelt" ──
  // De laag van vandaag op de kaart: hooguit 20 pagina's die oplichten, elk met de reden(en) waarom. Drie bronnen, alle drie alleen lezen:
  //  1. deadline: het deadline-register (00_Systeem/Deadlines.md, via opt.deadlines = de lezer van Projecten in server.js), deadlines
  //     vandaag t/m over 14 dagen, op de pagina uit de kolom Bron (opgelost zoals een wikilink vanuit Deadlines.md);
  //  2. nacht: het dagverslag van de nachtconsolidatie (00_Systeem/Logboek/<gisteren>.md, sectie "## Vastgelegd": "wat → [[pagina]]");
  //     de mtime van de vault zelf is te ruis (linkcheck, dumps, herinrichting november), het verslag zegt wat Socev bewust vastlegde;
  //  3. verkeer: hoeveel bronnen en gesprekken (verborgen deel van de kaart) met een datum van de laatste 7 dagen in de bestandsnaam naar
  //     een pagina linken (de mtime van bronnen is door de herinrichting onbruikbaar; Fable-review idee 10). Vanaf 3, de drukste 4.
  // Hooguit 10 + 6 + 4 = 20. `totaal` zegt hoeveel er in elke bron waren (meer deadlines dan er oplichten: de app zegt dat erbij).
  // 00_Systeem en 01_Ontwikkeling lichten nooit op (techniek, geen onderwerp van David). Geen pagina zonder reden; bij meer dan 20 gaan
  // deadlines voor, dan de nacht, dan het verkeer. Uitkomst per kaartbouw + dag in het geheugen (het register en het verslag op mtime).
  const VANDAAG_MAX = 20, VANDAAG_DL_DAGEN = 14, VANDAAG_DL_MAX = 10, VANDAAG_NACHT_MAX = 6, VANDAAG_VERKEER_MAX = 4, VANDAAG_VERKEER_MIN = 3;
  const BRONDATUM = /(20\d\d)-(\d\d)-(\d\d)/;
  let vandaagCache = null;   // { sleutel, j }
  const vandaagUit = function (p) { return /^(00_Systeem|01_Ontwikkeling)\//.test(p); };
  const kortTekst = function (s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
  const platTekst = function (s) { return String(s || '').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, function (m, x) { return x.split('/').pop(); }).replace(/[*_`]/g, '').trim(); };
  const dagNl = function (ymd) { return Number(ymd.slice(8, 10)) + '-' + Number(ymd.slice(5, 7)); };
  function logboekPad(vandaagYmd) { return '00_Systeem/Logboek/' + herkomstDagMin(vandaagYmd, 1) + '.md'; }
  function nachtRegels(k, vandaagYmd) {
    const rel = logboekPad(vandaagYmd), uit = [];
    let t;
    try { t = fs.readFileSync(path.join(VAULT, rel), 'utf8'); } catch (e) { return { pad: null, regels: uit }; }
    const sectie = t.split(/^## Vastgelegd\s*$/m)[1];
    if (sectie === undefined) return { pad: rel, regels: uit };
    sectie.split(/^## /m)[0].split(/\r?\n/).forEach(function (r) {
      if (!/^\s*[-*] /.test(r)) return;
      const ruw = r.replace(/^\s*[-*] /, ''), pijl = ruw.indexOf('→');
      const wat = kortTekst(platTekst(pijl >= 0 ? ruw.slice(0, pijl) : ruw), 70);
      linksIn(pijl >= 0 ? ruw.slice(pijl) : ruw).forEach(function (l) {
        if (l.md || l.embed) return;
        const lr = los(l.doel, rel, false, k);
        if (lr && lr.i !== undefined) uit.push({ i: lr.i, wat: wat });
      });
    });
    return { pad: rel, regels: uit };
  }
  function vandaag(ctx) {
    const k = vers(false);
    if (!k) return { status: 503, j: { ok: false, fout: 'de kaart is nu niet te bouwen' } };
    const dag = herkomstDag(nu()), lb = logboekPad(dag);
    const mt = function (rel) { try { return fs.statSync(path.join(VAULT, rel)).mtimeMs; } catch (e) { return 0; } };
    let dl = null, dlFout = null;
    try { dl = opt.deadlines ? opt.deadlines() : null; } catch (e) { dlFout = 'het deadline-register is nu niet te lezen'; fout('secondbrain-vandaag', e); }
    const sleutel = [k.op, dag, mt(lb), mt('00_Systeem/Deadlines.md'), dl ? dl.length : -1].join('|');
    if (vandaagCache && vandaagCache.sleutel === sleutel) return { status: 200, j: vandaagCache.j };
    const per = new Map(), volg = [];
    const telt = function (i) { const b = k.bestanden[i]; return b && !b.v && b.s === 'md' && !vandaagUit(b.p); };
    const voeg = function (i, reden) {
      let x = per.get(i);
      if (!x) { if (volg.length >= VANDAAG_MAX) return false; x = { i: i, redenen: [] }; per.set(i, x); volg.push(x); }
      if (!x.redenen.some(function (r) { return r.soort === reden.soort; })) x.redenen.push(reden);
      return true;
    };
    // 1. deadlines (vandaag t/m 14 dagen), vroegste eerst; één reden per pagina (de vroegste)
    let nDl = 0, totDl = 0;
    if (Array.isArray(dl)) {
      totDl = dl.filter(function (x) { return x && typeof x.dagen === 'number' && x.dagen >= 0 && x.dagen <= VANDAAG_DL_DAGEN; }).length;
      dl.filter(function (x) { return x && typeof x.dagen === 'number' && x.dagen >= 0 && x.dagen <= VANDAAG_DL_DAGEN && x.bron && typeof x.bron.pad === 'string' && x.bron.pad; })
        .sort(function (a, b) { return a.dagen - b.dagen; })
        .forEach(function (x) {
          if (nDl >= VANDAAG_DL_MAX) return;
          const lr = los(x.bron.pad, '00_Systeem/Deadlines.md', false, k);
          if (!lr || lr.i === undefined || !telt(lr.i) || (per.get(lr.i) && per.get(lr.i).redenen.some(function (r) { return r.soort === 'deadline'; }))) return;
          const wanneer = x.dagen === 0 ? 'vandaag' : x.dagen === 1 ? 'morgen' : dagNl(x.datum);
          if (voeg(lr.i, { soort: 'deadline', tekst: 'deadline ' + wanneer + ': ' + kortTekst(x.titel, 90), datum: x.datum })) nDl++;
        });
    }
    // 2. vannacht vastgelegd (dagverslag van gisteren)
    const nr = nachtRegels(k, dag);
    let nNacht = 0;
    nr.regels.forEach(function (x) {
      if (nNacht >= VANDAAG_NACHT_MAX || !telt(x.i) || (per.get(x.i) && per.get(x.i).redenen.some(function (r) { return r.soort === 'nacht'; }))) return;
      if (voeg(x.i, { soort: 'nacht', tekst: 'vannacht bijgewerkt' + (x.wat ? ': ' + x.wat : '') })) nNacht++;
    });
    // 3. bronverkeer deze week
    const van = herkomstDagMin(dag, 6), tel = new Map();
    k.bestanden.forEach(function (b) {
      if (!b.v) return;
      const m = BRONDATUM.exec(b.p.split('/').pop());
      if (!m || m[0] < van || m[0] > dag) return;
      const gezien = new Set();
      for (const j of b.l) { if (gezien.has(j) || !telt(j)) continue; gezien.add(j); tel.set(j, (tel.get(j) || 0) + 1); }
    });
    let nVerkeer = 0;
    Array.from(tel).filter(function (x) { return x[1] >= VANDAAG_VERKEER_MIN; })
      .sort(function (a, b) { return b[1] - a[1] || (k.bestanden[a[0]].p < k.bestanden[b[0]].p ? -1 : 1); })
      .forEach(function (x) {
        if (nVerkeer >= VANDAAG_VERKEER_MAX) return;
        if (voeg(x[0], { soort: 'verkeer', tekst: 'deze week in ' + x[1] + ' bronnen en gesprekken genoemd', n: x[1] })) nVerkeer++;
      });
    const items = volg.map(function (x) { const b = k.bestanden[x.i]; return { p: b.p, d: DOMEINEN.indexOf(b.d), redenen: x.redenen }; });
    const tellen = function (s) { return items.filter(function (x) { return x.redenen.some(function (r) { return r.soort === s; }); }).length; };
    const j = { ok: true, dag: dag, bijgewerkt: new Date(k.op).toISOString(), items: items,
      tel: { deadline: tellen('deadline'), nacht: tellen('nacht'), verkeer: tellen('verkeer') },
      totaal: { deadline: totDl, nacht: new Set(nr.regels.filter(function (x) { return telt(x.i); }).map(function (x) { return x.i; })).size,
        verkeer: Array.from(tel.values()).filter(function (n) { return n >= VANDAAG_VERKEER_MIN; }).length },
      bronnen: { deadlines: Array.isArray(dl) ? 'ok' : (dlFout || 'niet beschikbaar'), logboek: nr.pad ? nr.pad.split('/').pop().replace(/\.md$/, '') : null } };
    vandaagCache = { sleutel: sleutel, j: j };
    return { status: 200, j: j };
  }

  // ── wv3753 (besluitenpagina nr 508 = 3C208, David Ja 21-11-2026 13:21; Fable-review brein-graaf idee 12): de stamboom als waaier ──
  // De personen uit 20_Prive/Familie/Stamboom (één map, geen deelmappen) met wat de waaier nodig heeft uit hun frontmatter: naam, kwartierstaat-
  // nummer, geboren/overleden (jaar-maand-dag zoals het er staat), geslacht, relatie tot David, en ouders/partners/kinderen als wikilinks,
  // opgelost zoals overal op de kaart (los) en teruggebracht tot een plek in de lijst (links buiten de stamboommap tellen alleen mee in los_n).
  // Alleen lezen; geen keuzes: dubbele nummers, tegenstrijdige ouders en gaten bepaalt de app en zet ze als waarschuwing in beeld.
  // Een onleesbaar nummer (geen geheel getal 1..2^20) gaat niet mee als nummer maar als waarschuwing. Uitkomst per kaartbouw in het geheugen.
  const STAMBOOM_MAP = '20_Prive/Familie/Stamboom/', STAMBOOM_MAX = 6000, STAMBOOM_KOP = 16384;
  let stamboomCache = null;   // { sig, j }
  function fmVelden(t) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(t);
    if (!m) return null;
    const v = {};
    let huidig = null;
    for (const r of m[1].split(/\r?\n/)) {
      const x = /^([A-Za-z_][A-Za-z0-9_]{0,40}):\s*(.*)$/.exec(r);
      if (x) { huidig = x[1]; v[huidig] = x[2].trim(); continue; }
      const l = /^\s+-\s+(.*)$/.exec(r);
      if (l && huidig) v[huidig] = (v[huidig] ? v[huidig] + ', ' : '') + l[1].trim();
    }
    return v;
  }
  const fmTekst = function (s, n) { return kortTekst(String(s || '').replace(/^["']|["']$/g, ''), n); };
  function stamboom(ctx) {
    const k = vers(false);
    if (!k) return { status: 503, j: { ok: false, fout: 'de kaart is nu niet te bouwen' } };
    if (stamboomCache && k.sig && stamboomCache.sig === k.sig) return { status: 200, j: stamboomCache.j };
    const rijen = [], naar = new Map(), waarschuwingen = [];
    k.bestanden.forEach(function (b, i) {
      if (rijen.length >= STAMBOOM_MAX || b.s !== 'md' || b.p.indexOf(STAMBOOM_MAP) !== 0 || b.p.indexOf('/', STAMBOOM_MAP.length) >= 0) return;
      let t;
      try {
        const fd = fs.openSync(path.join(VAULT, b.p), 'r');
        try { const buf = Buffer.alloc(Math.min(STAMBOOM_KOP, b.g || STAMBOOM_KOP)); const n = fs.readSync(fd, buf, 0, buf.length, 0); t = buf.slice(0, n).toString('utf8'); }
        finally { fs.closeSync(fd); }
      } catch (e) { return; }
      const v = fmVelden(t);
      if (!v) return;
      let kw = null;
      const kr = String(v.kwartierstaat || '').replace(/^["']|["']$/g, '').trim();
      if (kr) {
        if (/^\d{1,7}$/.test(kr) && +kr >= 1 && +kr <= 1048576) kw = +kr;
        else waarschuwingen.push({ p: b.p, tekst: 'kwartierstaatnummer onleesbaar: ' + kortTekst(kr, 30) });
      }
      const ln = function (veld) {
        const uit = [];
        (v[veld] ? linksIn(v[veld]) : []).forEach(function (l) { const r = los(l.doel, b.p, false, k); uit.push(r && r.i !== undefined ? r.i : -1); });
        return uit;
      };
      const g = /^["']?(man|m)["']?$/i.test(v.geslacht || '') ? 'm' : /^["']?(vrouw|v)["']?$/i.test(v.geslacht || '') ? 'v' : '';
      naar.set(i, rijen.length);
      rijen.push({ p: b.p, naam: fmTekst(v.naam, 120) || b.p.slice(STAMBOOM_MAP.length).replace(/\.md$/i, ''), kw: kw,
        geb: fmTekst(v.geboren, 10), ovl: fmTekst(v.overleden, 10), g: g, rel: fmTekst(v.relatie_tot_david, 80),
        ouders: ln('ouders'), partners: ln('partners'), kinderen: ln('kinderen') });
    });
    let losN = 0;
    const plek = function (lijst) { const uit = []; lijst.forEach(function (i) { const j = naar.get(i); if (j === undefined) losN++; else if (uit.indexOf(j) < 0) uit.push(j); }); return uit; };
    const personen = rijen.map(function (r) { return [r.p, r.naam, r.kw, r.geb, r.ovl, r.g, r.rel, plek(r.ouders), plek(r.partners), plek(r.kinderen)]; });
    const j = { ok: true, bijgewerkt: new Date(k.op).toISOString(), map: STAMBOOM_MAP.replace(/\/$/, ''), personen: personen, los_n: losN,
      waarschuwingen: waarschuwingen.slice(0, 50) };
    if (k.sig) stamboomCache = { sig: k.sig, j: j };
    return { status: 200, j: j };
  }

  function nacht(datum) {
    if (laatsteNacht === datum) return false;
    laatsteNacht = datum;
    vers(true);
    return true;
  }

  // Bij een podstart: de laatste kaart als vertrekpunt (de eerste vraag bouwt hem vers).
  function laadBewaard() {
    laadLinks();   // wv3003
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
    if (route === 'POST /app/secondbrain/vandaag') return vandaag(ctx);   // wv3717: "Wat speelt"
    if (route === 'POST /app/secondbrain/stamboom') return stamboom(ctx);   // wv3753: de stamboom als waaier
    if (route === 'POST /app/secondbrain/open') return open(d, ctx);
    if (route === 'POST /app/secondbrain/bestand') return bestand(d, ctx);
    if (route === 'POST /app/secondbrain/zoek') return zoek(d, ctx);
    if (route === 'POST /app/secondbrain/bewerk') return docsBewerk(d, ctx);   // wv1378: OVIS Docs
    if (route === 'POST /app/secondbrain/bewaar') return docsBewaar(d, ctx);   // wv1378: OVIS Docs
    if (route === 'POST /app/secondbrain/versies') return docsVersies(d, ctx);   // wv1382: vorige versie terugzetten
    if (route === 'POST /app/secondbrain/bewaar-terug') return docsBewaarTerug(d, ctx);
    return { status: 404, j: { ok: false, fout: 'onbekend' } };
  }

  function health() {
    const k = kaart;
    return { aan: true, knopen: k ? k.bestanden.length : 0, lijnen: k ? k.bestanden.reduce(function (n, b) { return n + b.l.length; }, 0) : 0,
      gebouwd: k && k.op ? new Date(k.op).toISOString() : null, duur_ms: k ? k.duur : null, nacht: laatsteNacht,
      gelezen: k && typeof k.gelezen === 'number' ? k.gelezen : null, hergebruik: k ? k.hergebruik || 0 : 0,   // wv2607: linkcache zichtbaar
      overgeslagen: overgeslagen.length, overgeslagen_mappen: overgeslagen.slice(0, 5).map(function (x) { return x.pad.split('/').slice(0, 2).join('/') + ' (' + x.code + ')'; }),   // wv3423 (B80)
      bouw_fout: bouwFout, herkomst: herkomstStand(),   // wv3608
      schik: BS ? { laatst: schikLaatst, dag: (function () { try { const s = leesSchikking(); return s ? s.dag || null : null; } catch (e) { return null; } })() } : null };   // wv3750
  }

  return { mkdir: mkdir, laadBewaard: laadBewaard, app: app, health: health, vers: vers, koppelNaam: koppelNaam, nacht: nacht, bron: bron, schikNacht: schikNacht,
    _los: function (doel, bron, md) { return los(doel, bron, md, vers(false)); },
    _herkomstNu: function () { if (herkomstTimer) { clearTimeout(herkomstTimer); herkomstSchrijf(); } } };   // wv3608: alleen voor de toets
}

module.exports = { maak: maak, masker: masker, maskerStreng: maskerStreng, zonderMarkeringen: zonderMarkeringen, linksIn: linksIn, domeinVan: domeinVan, isVastDicht: isVastDicht, isVerborgen: isVerborgen,
  DOMEINEN: DOMEINEN, KAART_VERS_MS: KAART_VERS_MS };
