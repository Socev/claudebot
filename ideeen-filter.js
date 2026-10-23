'use strict';
// Ideeënbeurs fase 2 (wv861, 23-10-2026; bouwplan "01_Ontwikkeling/Ideeënbeurs met Albert van der Veer (ontwerp 22-10-2026).md" § 6):
// de VASTE TOETS — laag 1 van het uitgaande filter. Een script, geen model: wat hier een treffer geeft, gaat niet naar Albert van der Veer
// (de kaart blijft concept met de reden; Socev herschrijft hem of laat hem liggen). Laag 2 is de inhoudsregel in de beurt die de kaart
// schrijft, laag 3 is David (Ja met verse vingerafdruk). Valse treffers zijn de bedoelde afloop: liever een gewoon woord tegengehouden
// dan een naam doorgelaten.
// Ook gebruikt als waarschuwing boven Davids reactieveld in de app: daar blokkeert hij nooit (werkafspraak "David nooit blokkeren").
//
// Toetst op: namen uit de contactenlijst en de medewerkerspagina's (volledige naam overal, losse voor- of achternaam als woord met een
// hoofdletter), praktijk- en entiteitsnamen, adressen en postcodes, telefoonnummers, e-mailadressen, IBAN- en BSN-achtige getallen,
// bedragen in euro, percentages naast een praktijkwoord, hostnamen (*.socev.dev, *.olares.com, huisdokter.dev), paden, workflow- en
// werkvoorraadnummers, sleutelnamen, en de secretgrep van het forum. CLI: node ideeen-filter.js [--vault <map>] "<tekst>" of
// --catalogus <pad> (toetst elke kaart; uitvoer JSON).

const fs = require('fs');
const path = require('path');

const CONTACTEN = '20_Prive/Contacten/Contacten.md';
const MEDEWERKERS = ['10_Zakelijk/Tolgaarde/Medewerkers', '10_Zakelijk/Groenhouten/Medewerkers', '10_Zakelijk/POT_POH_GGZ/Medewerkers'];
// Woorden die als losse naam te gewoon of juist bedoeld zijn (merken en diensten die in een kaart mogen staan). Hoofdletterongevoelig.
const VRIJ = new Set(['socev', 'claude', 'gemini', 'whisper', 'telegram', 'whatsapp', 'todoist', 'obsidian', 'google', 'android', 'pixel', 'tasker',
  'signal', 'gmail', 'outlook', 'teams', 'apple', 'iphone', 'github', 'cloudflare', 'supabase', 'docker', 'chrome', 'linux', 'python', 'excel',
  'word', 'drive', 'agenda', 'support', 'service', 'info', 'team', 'praktijk', 'huisarts', 'huisartsen', 'assistent', 'thuis', 'werk', 'mobiel',
  'privé', 'prive', 'administratie', 'secretariaat', 'receptie', 'balie', 'kantoor', 'apotheek', 'notaris', 'garage', 'school', 'opvang',
  'billing', 'klantenservice', 'helpdesk', 'nederland', 'holland', 'amsterdam', 'utrecht', 'rotterdam', 'europa', 'van', 'der', 'den', 'de', 'het',
  'ter', 'ten', 'op', 'in', 'en', 'of', 'met', 'voor', 'bij', 'aan', 'tot', 'uit', 'la', 'le', 'du', 'da', 'di', 'el', 'al', 'bin', 'von', 'zu',
  'dhr', 'mevr', 'mw', 'mr', 'mrs', 'dr', 'drs', 'ing', 'ir', 'prof', 'jr', 'sr', 'bv', 'b.v', 'vof', 'nv', 'mail', 'tel', 'fax', 'www', 'com', 'nl',
  'appie', 'albert',
  // gewone zinsbegin-woorden die ook als voornaam in de contacten staan (gemeten 23-10: alleen deze); echte achternamen (Groot, Bos …) blijven tegengehouden
  'eén', 'één', 'een', 'wil', 'wij', 'niet', 'dag', 'drie', 'snel']);
// Albert en Appie zijn de ontvangers: hun naam in een reactie is gewoon. In een kaart hoort hij niet, maar dat is laag 2 (inhoudsregel).
const ENTITEITEN = [/\bgroenhouten\b/i, /\btolgaarde\b/i, /\bPOT\b/, /\bPOH[- ]?(GGZ|S|J|jeugd|ouderen)?\b/i, /\bhagro\b/i, /\bsloel\b/i, /\bDBH\b/,
  /\bontie\b/i, /\bghawa\b/i, /\beemwerk\b/i, /\bourmind\b/i, /\bkostenmaatschap\b/i, /\bpraktijkhouders\b/i, /\bholding\b/i, /\bSEL\b/,
  /\bleusden\b/i, /\bamersfoort\b/i, /\bgambia\b/i, /\bpromedico\b/i, /\bordus\b/i, /\bhuisdokter\b/i, /\bprimumnonnocere\b/i, /\bolares\b/i,
  /\babrona\b/i, /\bstoz\b/i, /\bzorgdata\b/i];
const PRAKTIJKWOORD = /(praktijk|patiënt|patient|omzet|winst|declar|inschrijv|fte|norm|kosten|salaris|loon|tarief|budget|verzuim|bezetting|personeel|zorg|consult|ggz|poh)/i;
const PATRONEN = [
  ['e-mailadres', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['hostnaam', /\b(?:[a-z0-9-]+\.)*(?:socev\.dev|olares\.com|huisdokter\.dev)\b/i],
  ['hostnaam', /\b[a-z0-9-]{2,}(?:\.[a-z0-9-]{2,})*\.[a-z]{2,6}\b/i],   // Fable wv861 #3: elke domeinnaam, niet alleen .nl/.com
  ['pad', /(?:^|[\s(\["'`])(?:~|\.{1,2})?\/(?:[\w.@-]+\/)+[\w.@-]*/],
  ['pad', /\b\d{2}_[A-Z][\w-]*\//],
  ['pad', /\b[\w-]+\.(?:md|js|mjs|ts|tsx|py|sh|json|jsonl|sql|yml|yaml|env)\b/i],
  ['pad', /\b[A-Z]:\\/],
  ['werkvoorraadnummer', /\bwv[\s-]?\d{1,5}[a-z]?\b/i],
  ['workflow', /\bAI - [A-Z][\w-]*/],
  ['workflow', /\b(?=[A-Za-z0-9]{16}\b)(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])[A-Za-z0-9]{16}\b/],
  ['workflow', /\b(?:run|executie|execution|job)\s*#?\s*[0-9a-f]{4,}\b/i],
  ['sleutelnaam', /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/],
  ['sleutelnaam', /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:secret|token|key|sleutel|wachtwoord|password)\b/i],
  ['IBAN', /\b[A-Z]{2}\d{2}\s?[A-Z]{4}\s?(?:\d{4}\s?){2}\d{2}\b/],
  ['BSN-achtig getal', /\b\d{3}[.\s-]?\d{3}[.\s-]?\d{3}\b/],
  ['telefoonnummer', /(?:\+|00)\d{2}[\s-]?\(?\d{1,3}\)?(?:[\s-]?\d{2,4}){2,4}/],
  ['telefoonnummer', /\b0\d{1,3}[\s-]?\d{3}[\s-]?\d{3,4}\b/],
  ['telefoonnummer', /\b06[\s-]?\d{8}\b/],
  ['telefoonnummer', /\b06(?:[\s-]?\d{2}){4}\b|\b06[\s-]?\d{4}[\s-]?\d{4}\b/],   // Fable #11: 06 12 34 56 78, 06 1234 5678
  ['postcode', /\b[1-9]\d{3}\s?(?!SA|SD|SS)[A-Z]{2}\b/],
  ['adres', /\b[A-Z][a-z]+(?:straat|laan|weg|plein|gracht|kade|singel|hof|dreef|dijk|park|steeg|pad|veld|baan|erf|markt)\s+\d{1,4}\s?[a-zA-Z]?\b/],
  ['bedrag', /€\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:euro|EUR|k€)\b|\bEUR\s?\d[\d.,]*|\b\d[\d.]*,-/i],   // Fable #11: €45 heel, 45,-
];
// zoals SECRET_PATRONEN in functions/api/[[pad]].js van het forum (F6, 23-10-2026)
const SECRETGREP = [
  /\bwk_[a-z0-9]+_[A-Za-z0-9_-]{20,}/, /\bcfut_[A-Za-z0-9_-]{30,}/, /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /\b\d{9,10}:[A-Za-z0-9_-]{35}\b/,
  /(secret|token|wachtwoord|password|api[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{16,}/i,
];

const LETTER = 'A-Za-zÀ-ÖØ-öø-ÿ';
const isNaamWoord = (w) => new RegExp('^[' + LETTER + "][" + LETTER + "'’-]*$").test(w);
// Fable wv861 #2: onzichtbare tekens (zachte afbreking, nulbreedte, woordverbinder, BOM, richtingtekens) weg vóór het toetsen, zodat
// "Da\u00ADvid" niet langs de naamtoets glipt; NFKC maakt van een breedtevariant (Ｄ) een gewone letter. Hun aanwezigheid is zelf een treffer.
const ONZICHTBAAR = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0]/g;
// Fable wv861 #1: bezitsvorm en genitief ("Davids", "Cynthia's", "Cynthia’s") tegen de kale naam leggen
const zonderBezit = (k) => k.replace(/['’]s$/, '').replace(/['’]$/, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Namen uit de vault: volledige namen (≥ 2 woorden) en losse naamwoorden (≥ 3 letters, niet op de vrije lijst)
function leesNamen(vault) {
  const vol = new Set(), los = new Set();
  const neem = function (ruw) {
    let n = String(ruw || '').replace(/\(.*?\)/g, ' ').split(/[,;]/)[0].replace(/\s+/g, ' ').trim();
    if (!n || /[@\d+]/.test(n) || n.length > 60) return;
    const w = n.split(' ').filter(Boolean);
    if (w.length >= 2) vol.add(w.join(' ').toLowerCase());
    w.forEach(function (x) { const y = x.replace(/[.']+$/, ''); if (y.length >= 3 && isNaamWoord(y) && !VRIJ.has(y.toLowerCase())) los.add(y.toLowerCase()); });
  };
  try {
    fs.readFileSync(path.join(vault, CONTACTEN), 'utf8').split('\n').forEach(function (r) { const m = /^- \*\*(.+?)\*\*/.exec(r); if (m) neem(m[1]); });
  } catch (e) {}
  MEDEWERKERS.forEach(function (d) {
    try { fs.readdirSync(path.join(vault, d)).forEach(function (f) { if (/\.md$/.test(f) && !/^index/i.test(f)) neem(f.replace(/\.md$/, '').split(' - ')[0]); }); } catch (e) {}
  });
  return { vol: vol, los: los };
}

// maak({vault}) of maak({namen: {vol, los}}): toets(tekst) -> [{soort, treffer}] (leeg = schoon). Namen worden per mtime ververst.
function maak(o) {
  o = o || {};
  let namen = o.namen || null, stempel = null;
  function huidigeNamen() {
    if (o.namen) return o.namen;
    let s = '';
    try { s = [CONTACTEN].concat(MEDEWERKERS).map(function (p) { try { return String(fs.statSync(path.join(o.vault, p)).mtimeMs); } catch (e) { return '-'; } }).join('|'); } catch (e) {}
    if (!namen || s !== stempel) { namen = leesNamen(o.vault); stempel = s; }
    return namen;
  }
  function toets(tekst) {
    const ruw = String(tekst == null ? '' : tekst);
    const uit = [];
    const zet = function (soort, treffer) { if (!uit.some(function (x) { return x.soort === soort && x.treffer === treffer; }) && uit.length < 20) uit.push({ soort: soort, treffer: String(treffer).slice(0, 60) }); };
    if (ONZICHTBAAR.test(ruw)) zet('onzichtbaar teken', '(onzichtbaar teken in de tekst)');
    ONZICHTBAAR.lastIndex = 0;
    const t = ruw.replace(ONZICHTBAAR, '').normalize('NFKC');
    SECRETGREP.forEach(function (re) { if (re.test(t)) zet('sleutel', '(iets dat op een sleutel lijkt)'); });
    PATRONEN.forEach(function (p) { const m = p[1].exec(t); if (m) zet(p[0], m[0].trim()); });
    ENTITEITEN.forEach(function (re) { const m = re.exec(t); if (m) zet('praktijk- of entiteitsnaam', m[0]); });
    const pr = /(\d+(?:[.,]\d+)?)\s?(%|procent)/gi;
    let m;
    while ((m = pr.exec(t))) { const rond = t.slice(Math.max(0, m.index - 50), m.index + m[0].length + 50); if (PRAKTIJKWOORD.test(rond)) { zet('percentage bij een praktijkwoord', m[0]); break; } }
    const n = huidigeNamen();
    const laag = t.toLowerCase();
    // volledige naam: overal, hoofdletterongevoelig, als woordgroep
    for (const v of n.vol) {
      if (laag.indexOf(v) < 0) continue;
      if (new RegExp('(^|[^' + LETTER + '])' + esc(v) + '($|[^' + LETTER + '])').test(laag)) { zet('naam', v); if (uit.length >= 20) break; }
    }
    // losse naam: alleen als woord met een hoofdletter (een gewoon woord midden in een zin is dan meestal klein)
    const woorden = t.match(new RegExp('[' + LETTER + "][" + LETTER + "'’-]*", 'g')) || [];
    for (const w of woorden) {
      if (w[0] !== w[0].toUpperCase() || w[0] === w[0].toLowerCase()) continue;
      const k = zonderBezit(w.replace(/[-]+$/, '').toLowerCase());
      const kaal = k.length > 3 && /s$/.test(k) ? k.slice(0, -1) : null;   // "Davids" → "david"
      if (n.los.has(k) || (kaal && n.los.has(kaal))) zet('naam', w);
      else if (k.indexOf('-') > 0 && k.split('-').some(function (d) { return n.los.has(zonderBezit(d)); })) zet('naam', w);
    }
    return uit;
  }
  return { toets: toets, namen: huidigeNamen };
}

// Catalogus: één blok per kaart (### K01 · titel, daarna "- veld: waarde"-regels). Alleen de velden die Albert ziet worden getoetst.
const DEELBAAR = ['concept', 'ja', 'nee', 'privé'];
const VELDEN = { titel: 70, wat: 300, waarom: 160 };
const MIN = { titel: 3, wat: 10, waarom: 5 };
const ALLE_VELDEN = ['titel', 'wat', 'waarom', 'status', 'link', 'plaatje', 'bron', 'deelbaar', 'gedeeld_op', 'draad'];
// zoals zinnen() in de forum-API (functions/api/[[pad]].js): een punt/!/? gevolgd door spatie en een hoofdletter of cijfer = nieuwe zin
const zinnen = (s) => (String(s).match(/[.!?]+(?=\s+["'(]?[A-ZÀ-Ý0-9])/g) || []).length + 1;
const STATUSSEN = ['bedacht', 'in aanbouw', 'in gebruik'];
function leesCatalogus(md) {
  const kaarten = [], fouten = [];
  const delen = String(md || '').replace(/\r\n?/g, '\n').split(/^### /m).slice(1);
  delen.forEach(function (blok) {
    const kop = /^(K\d{2,3})\b/.exec(blok);
    if (!kop) return;
    const k = { id: kop[1].toLowerCase() };
    blok.split('\n').slice(1).forEach(function (r) {
      const m = /^- ([a-zé ]+?):\s?(.*)$/.exec(r);
      const veld = m ? m[1].trim().replace(/ /g, '_') : null;
      if (veld && ALLE_VELDEN.indexOf(veld) >= 0) k[veld] = m[2].trim();   // Fable #7: een regel "- id: …" overschrijft het id niet
    });
    k.deelbaar = String(k.deelbaar || '').toLowerCase();
    const f = [];
    Object.keys(VELDEN).forEach(function (v) {
      if (!k[v]) f.push(v + ' ontbreekt'); else if (k[v].length > VELDEN[v]) f.push(v + ' te lang (' + k[v].length + '/' + VELDEN[v] + ')'); else if (k[v].length < MIN[v]) f.push(v + ' te kort');
    });
    if (k.wat && zinnen(k.wat) > 2) f.push('wat: hooguit twee zinnen');   // Fable #9: zoals het forum, anders strandt hij pas na Davids Ja op 422
    if (k.waarom && zinnen(k.waarom) > 1) f.push('waarom: één zin');
    if (STATUSSEN.indexOf(k.status) < 0) f.push('status onbekend');
    if (DEELBAAR.indexOf(k.deelbaar) < 0) f.push('deelbaar onbekend');
    if (k.link) f.push('link: in fase 2 niet toegestaan (de toets houdt elke domeinnaam tegen)');   // Fable #3
    if (k.plaatje) f.push('plaatje: in fase 2 niet toegestaan');
    const eerder = kaarten.find(function (x) { return x.id === k.id; });
    if (eerder) { f.push('dubbel id'); if (eerder.vormfout.indexOf('dubbel id') < 0) { eerder.vormfout.push('dubbel id'); fouten.push(eerder.id + ': dubbel id'); } }   // Fable #8: beide
    k.vormfout = f;
    if (f.length) fouten.push(k.id + ': ' + f.join(', '));
    kaarten.push(k);
  });
  return { kaarten: kaarten, fouten: fouten };
}
const kaartTekst = function (k) { return [k.titel, k.wat, k.waarom, k.link || ''].join('\n'); };

module.exports = { maak: maak, leesNamen: leesNamen, leesCatalogus: leesCatalogus, kaartTekst: kaartTekst, zinnen: zinnen, STATUSSEN: STATUSSEN, VELDEN: VELDEN, DEELBAAR: DEELBAAR };

if (require.main === module) {
  const a = process.argv.slice(2);
  const vi = a.indexOf('--vault'), vault = vi >= 0 ? a.splice(vi, 2)[1] : (process.env.VAULT_DIR || '/opt/data/AI_SecondBrain');
  const F = maak({ vault: vault });
  const ci = a.indexOf('--catalogus');
  if (ci >= 0) {
    const c = leesCatalogus(fs.readFileSync(a[ci + 1], 'utf8'));
    const uit = c.kaarten.map(function (k) { return { id: k.id, titel: k.titel, deelbaar: k.deelbaar, vormfout: k.vormfout, treffers: F.toets(kaartTekst(k)) }; });
    console.log(JSON.stringify({ kaarten: uit.length, schoon: uit.filter(function (x) { return !x.treffers.length && !x.vormfout.length; }).length, uit: uit }, null, 1));
    process.exit(uit.some(function (x) { return x.deelbaar === 'concept' && (x.treffers.length || x.vormfout.length); }) ? 1 : 0);
  }
  const r = F.toets(a.join(' '));
  console.log(JSON.stringify(r));
  process.exit(r.length ? 1 : 0);
}
