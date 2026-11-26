'use strict';
/*
 * MemoryLane delen (wv2114, 31-10-2026): reizen, eigen aanvullingen en twee deellinks (familie, vrienden). Ontwerp in de vault:
 * "01_Ontwikkeling/Second Brain 2.0 - fase R rambles en herinneringen (ontwerp 29-10-2026).md" § 14 (review vooraf OpenAI, 4 MOET verwerkt).
 *
 * WAAROM. David 31-10 19:22: een herinnering is van meer mensen; familie en vrienden moeten het verhaal kunnen zien en hun kant kunnen
 * typen of inspreken. Alle input blijft als eigen stuk bewaard; het samengestelde verhaal (R2, wv2118) is later een afgeleide.
 *
 * VORM.
 *  - Register in intake.sqlite (ml_*): alleen ids, vlaggen, tijden en hashes. GEEN tekst, titels of namen (die databank gaat elke nacht in de
 *    podstaat-bundel; zelfde regel als ramble, Opus-review wv1969 MOET 1).
 *  - Tekst in de vault: per herinnering 20_Prive/Herinneringen/MemoryLane/<hid>.md (frontmatter titel/bron, per stuk een blok
 *    "<!-- ml:stuk <sid> -->"). Davids handwijziging in een blok wint: de pod leest de tekst uit de pagina. Tot het blok in de vault staat
 *    (onderhoud, nachtgrendel) en bij een markertreffer staat het stuk in <dir>/ml-wacht/<sid>.json (0600).
 *  - wv4115 (David 25-11-2026, besluitenpagina nr 61 = C51 en nr 121 = 2C21): de oude deellinks met een wachtwoord (deel.socev.dev/h/,
 *    D1 `deel` ml_*, kluis memorylane_link_*, Access-uitzondering /h/*) en Plaatje maken (memorylane-plaatje.js) zijn weg. Delen buiten
 *    gaat alleen nog via memorylane.socev.dev (memorylane-publiek.js, kringen familie en shizzle). De kolommen zicht_familie/zicht_vrienden
 *    en toon_opname blijven in ml_herinnering staan maar tellen nergens meer; de lokale tabellen ml_link, ml_pub, ml_d1, ml_blok,
 *    ml_marker_ok, ml_plaatje en ml_plaatje_aanvraag (alleen ids en hashes) gaan bij het starten weg.
 *  - Foto's (wv2120): met o.immich koppelt memorylane-fotos.js elke herinnering aan een Immich-album (ml_album).
 *  - Verteller in Davids eigen stem (wv2366): met o.eleven maakt memorylane-verteller.js op Davids tik de vertelling (ElevenLabs, eigen
 *    stem, v4) en bewaart hem op de pod. Alleen actief, categorie gekozen en niet Privé, niet gevoelig, geen blok, niet in de toonmodus.
 *  - Als verhaal vertellen (wv2484): met o.claude schrijft memorylane-vertelscript.js van het verhaal eerst een luisterversie met audio-tags
 *    (Claude, feitentoets en taglijst in code), die de verteller (vorm 'verhaal') in Davids stem inspreekt. Zelfde regels en credit-rem als
 *    hierboven; script per herinnering + verhaalversie bewaard, opnieuw alleen bij een nieuwe verhaalversie of op Davids knop.
 *  - Vanzelf vertellen (wv2522, David 5-11 21:26: "Alles waar wat voor ingesproken wordt moet altijd direct een verhaal op gebouwd worden"):
 *    autoVertel() in de tik maakt de vertelling als verhaal zonder tik voor elke herinnering met iets ingesprokens, binnen dezelfde credit-rem (wv2751);
 *    zie de toelichting bij autoVertel. Register ml_vertel_auto (hid, hash, tellers).
 *  - Samengevoegd (wv2732, David 8-11-2026): status 'samengevoegd' + kolom bij (de herinnering die blijft); verborgen zoals 'afgewezen' en
 *    nooit in delen, toonmodus, albumsync of vertelronde. koppel() in de tik voegt een reis of fotoalbum vanzelf bij een opname over dezelfde
 *    dagen (zie de toelichting daar); losmaken(hid) zet hem terug. Register ml_koppel (alleen ids, periode, uitkomst, vlaggen).
 *    wv2932 (David 11-11-2026): ook een fotoalbum (los, google:…) bij een reis, als de dagen van zijn foto's binnen de reis vallen.
 * PRIVACY. Nooit tekst, titels of namen in logs, box, /health of fouten: alleen ids en aantallen.
 * VORM. Alleen fs, path, crypto en reizen.js (wv2136: de reispagina's, gedeeld met Tripper); marker, geheimen, vault-veilig, box en ramble-tabel komen via maak({...}).
 *
 * WV2180 (David 1-11-2026 10:02; ontwerp fase R § 16): standaard alleen de SAMENGESTELDE herinnering; de rest staat in de LOG.
 *  - Samengesteld = opname: het verhaal van herinneringen-verhaal.js (o.verhaal.samengesteld; ghostwriter, feitentoets) met Davids correcties
 *    letterlijk toegepast; reis: Davids eigen aanvullingen; los: de bijdrage zelf. Nooit het transcript.
 *  - Log (alleen in de app, alleen David): transcript, tijdcodes, wat niet lukte, correcties, eigen aanvullingen en losse bijdragen
 *    (opnemen/afwijzen). Een bezoeker ziet nooit de log.
 *  - Wanneer: frontmatter `wanneer` op de MemoryLane-pagina, door David gezet: "JJJJ[-MM[-DD]]" of een reeks "<van>/<tot>". Davids invoer
 *    wint; anders de periode van de reis of de datum die de code uit het verhaal rekende. De lijst staat op tijd (nieuwste eerst, zoals de
 *    straat van nu naar vroeger); zonder datum achteraan, op opnamedatum.
 *  - Titel: `titel_bron` david (wint altijd) | naamgeving (Davids vaste naamgeving, door de machinekamer of naamVoorReis) | standaard; een
 *    opname zonder eigen titel krijgt de titel van het verhaal.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REIZEN = require('./reizen.js');   // wv2136: de reispagina's lezen Tripper en MemoryLane met dezelfde functie
// wv2180: Davids correcties ("X is Y") letterlijk; ontbreekt de verhaalmodule (terugrol), dan zonder correcties
const VH = (function () { try { return require('./herinneringen-verhaal.js'); } catch (e) { return null; } })();
function correcties(teksten) { return VH ? VH.correctiesUit(teksten) : []; }
function pasToe(t, cs) { return VH && cs && cs.length ? VH.pasCorrectiesToe(t, cs) : String(t == null ? '' : t); }
const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const DEEL_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
// "JJJJ[-MM[-DD]]" → { tekst, van: eerste dag, tot: laatste dag, precisie } of null
function datumDeel(s) {
  const m = DEEL_RE.exec(String(s || ''));
  if (!m) return null;
  const j = Number(m[1]), mm = m[2] ? Number(m[2]) : null, d = m[3] ? Number(m[3]) : null;
  if (j < 1900 || j > 2100 || (mm !== null && (mm < 1 || mm > 12))) return null;
  const p2 = (x) => String(x).padStart(2, '0');
  if (d !== null) { const x = new Date(Date.UTC(j, mm - 1, d)); if (x.getUTCMonth() !== mm - 1 || x.getUTCDate() !== d) return null; const s2 = j + '-' + p2(mm) + '-' + p2(d); return { j, mm, d, van: s2, tot: s2, precisie: 'dag' }; }
  if (mm !== null) return { j, mm, d: null, van: j + '-' + p2(mm) + '-01', tot: j + '-' + p2(mm) + '-' + p2(new Date(Date.UTC(j, mm, 0)).getUTCDate()), precisie: 'maand' };
  return { j, mm: null, d: null, van: j + '-01-01', tot: j + '-12-31', precisie: 'jaar' };
}
// Davids invoer "van" of "van/tot" → { van, tot, precisie, invoer: {van, tot} } of null
function wanneerUit(s) {
  const delen = String(s || '').split('/');
  if (!delen[0] || delen.length > 2) return null;
  const a = datumDeel(delen[0]), b = delen[1] ? datumDeel(delen[1]) : null;
  if (!a || (delen[1] && !b) || (b && b.tot < a.van)) return null;
  return { van: a.van, tot: b ? b.tot : a.tot, precisie: a.precisie, a, b, invoer: { van: delen[0], tot: delen[1] || '' } };
}
// Leesbaar: "1995", "juli 1995", "12 juli 1995", "1990–1993", "11–16 juni 2025", "juni–juli 2025"
function wanneerTekst(a, b) {
  const een = (x) => (x.d ? x.d + ' ' : '') + (x.mm ? MAANDEN[x.mm - 1] + ' ' : '') + x.j;
  if (!b) return een(a);
  if (a.precisie === b.precisie && a.j === b.j && a.mm && b.mm) {
    if (a.d && b.d && a.mm === b.mm) return a.d + '–' + b.d + ' ' + MAANDEN[a.mm - 1] + ' ' + a.j;
    if (!a.d && !b.d) return MAANDEN[a.mm - 1] + '–' + MAANDEN[b.mm - 1] + ' ' + a.j;
  }
  if (a.precisie === 'jaar' && b.precisie === 'jaar') return a.j + '–' + b.j;
  return een(a) + ' – ' + een(b);
}
// Datum van de code (reis, verhaal): "JJJJ-MM-DD" van/tot + precisie → zelfde vorm
function codeWanneer(van, tot, precisie) {
  const a = datumDeel(precisie === 'jaar' || precisie === 'ongeveer_jaar' || precisie === 'decennium' ? String(van).slice(0, 4) : precisie === 'maand' ? String(van).slice(0, 7) : van);
  if (!a) return null;
  if (precisie === 'decennium') return { van: a.van, tot: String(tot || a.tot), tekst: 'jaren ' + String(a.j).slice(2), precisie };
  if (precisie === 'ongeveer_jaar') return { van: a.van, tot: a.tot, tekst: 'rond ' + a.j, precisie };
  const b = tot && tot !== van ? datumDeel(precisie === 'dag' ? tot : precisie === 'maand' ? String(tot).slice(0, 7) : String(tot).slice(0, 4)) : null;
  return { van: a.van, tot: b ? b.tot : a.tot, tekst: wanneerTekst(a, b && b.van !== a.van ? b : null), precisie };
}
/*
 * Davids vaste naamgeving voor een reis (1-11-2026): Zomervakantie <jaar> - <omschrijving>, Gambia <jaar>, Citytrip <plaats> <jaar>,
 * Shizzle: <naam> - <jaar>, anders de naam met het jaar. Een titel die David zelf zet wint; de bestaande reizen kregen een titel met de hand.
 */
function naamVoorReis(rel, i, tagLijst) {
  const jaar = i && i.van ? String(i.van).slice(0, 4) : (/(\d{4})/.exec(path.basename(rel)) || [])[1] || '';
  const kaal = path.basename(rel, '.md').replace(/^\d{4}\s*-\s*/, '').replace(/\s+&\s+/g, ' en ').trim();
  const tags = (tagLijst || []).map((x) => String(x).toLowerCase());
  const heeft = (x) => tags.indexOf(x) >= 0 || new RegExp('\\b' + x + '\\b', 'i').test(kaal);
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(kaal);
  const naam = (m ? m[1] : kaal).replace(new RegExp('\\s*\\b' + jaar + '\\b'), '').trim(), extra = m ? m[2].trim() : '';
  const met = (s) => s + (extra ? ' - ' + extra : '');
  if (heeft('gambia')) return 'Gambia ' + jaar;
  if (heeft('shizzle')) return 'Shizzle: ' + met(naam) + ' - ' + jaar;
  if (heeft('stedentrip') || heeft('citytrip')) return 'Citytrip ' + naam.replace(/^(stedentrip|citytrip)\s+/i, '') + ' ' + jaar;
  if (heeft('zomer') || heeft('zomervakantie')) return 'Zomervakantie ' + jaar + ' - ' + met(naam.replace(/^(zomervakantie|vakantie)\s*/i, ''));
  return met(naam + (jaar ? ' ' + jaar : ''));
}

const PKRINGEN = ['familie', 'shizzle'];   // wv2636: de kringen van memorylane.socev.dev
const HID_RE = /^h[0-9a-f]{16}$/, SID_RE = /^s[0-9a-f]{16}$/;
const MAP = '20_Prive/Herinneringen/MemoryLane';
const MAX_TEKST = 5000, MAX_TITEL = 120;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ml_herinnering (hid TEXT PRIMARY KEY, soort TEXT NOT NULL, ref TEXT, categorie TEXT, gevoelig INTEGER,
  zicht_familie INTEGER NOT NULL DEFAULT 0, zicht_vrienden INTEGER NOT NULL DEFAULT 0, toon_opname INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL, aangemaakt TEXT NOT NULL, gewijzigd TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ml_herinnering_ref ON ml_herinnering (soort, ref);
CREATE TABLE IF NOT EXISTS ml_stuk (sid TEXT PRIMARY KEY, hid TEXT NOT NULL, wie TEXT NOT NULL, kring TEXT NOT NULL, vorm TEXT NOT NULL,
  soort TEXT NOT NULL, status TEXT NOT NULL, marker TEXT NOT NULL DEFAULT 'geen', sha256 TEXT NOT NULL, vault INTEGER NOT NULL DEFAULT 0,
  binnen_op TEXT NOT NULL, besluit_op TEXT, bron_id TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS ml_vertel_auto (hid TEXT PRIMARY KEY, hash TEXT NOT NULL, pogingen INTEGER NOT NULL DEFAULT 0, op TEXT NOT NULL,
  weg INTEGER NOT NULL DEFAULT 0, gemeld INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ml_koppel (hid TEXT PRIMARY KEY, sleutel TEXT NOT NULL, uitkomst TEXT NOT NULL, kandidaat TEXT, titel_gezet INTEGER NOT NULL DEFAULT 0,
  album_gezet INTEGER NOT NULL DEFAULT 0, op TEXT NOT NULL);
DROP TABLE IF EXISTS ml_link;
DROP TABLE IF EXISTS ml_pub;
DROP TABLE IF EXISTS ml_d1;
DROP TABLE IF EXISTS ml_blok;
DROP TABLE IF EXISTS ml_marker_ok;
DROP TABLE IF EXISTS ml_plaatje;
DROP TABLE IF EXISTS ml_plaatje_aanvraag;
`;

function iso(ms) { return new Date(ms).toISOString(); }
function sha256(x) { return crypto.createHash('sha256').update(x).digest('hex'); }
function rnd(n) { return crypto.randomBytes(n); }
function amsDmj(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { dmj: p.day + '-' + p.month + '-' + p.year, klok: (p.hour === '24' ? '00' : p.hour) + ':' + p.minute, datum: p.year + '-' + p.month + '-' + p.day };
}
// Tekst van buiten (of van David) schoon: geen stuurtekens behalve regeleinden, hooguit max tekens, nooit ons blokmerkteken.
function schoon(t, max, regels) {
  let s = String(t == null ? '' : t).normalize('NFC').replace(/\r\n?/g, '\n');
  s = regels ? s.replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/g, ' ') : s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ');
  s = s.replace(/<!--/g, '<!‐‐').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return Array.from(s).length > max ? null : s;
}
function yaml(s) { return JSON.stringify(String(s)); }
// "[01:00] tekst" → "tekst"; stilte en gaten weg (de bezoeker krijgt het verhaal, geen tijdcodes)
function kaleOpname(body) {
  return String(body || '').split(/\n{2,}/).map((x) => x.trim()).filter(Boolean)
    .map((x) => x.replace(/^\[[0-9:]+\]\s*/, '')).filter((x) => x && x !== '(stilte)' && !/^\[[0-9:–-]+ (ontbreekt|niet uitgeschreven)\]$/.test(x)).join('\n\n');
}
function zonderFrontmatter(t) { const m = /^---\n[\s\S]*?\n---\n?/.exec(t); return m ? t.slice(m[0].length) : t; }
function fmVeld(t, veld) {
  const m = /^---\n([\s\S]*?)\n---/.exec(t || '');
  if (!m) return null;
  const r = new RegExp('^' + veld + ':\\s*(.*)$', 'm').exec(m[1]);
  if (!r) return null;
  let v = r[1].trim();
  if (v.startsWith('"')) { try { v = JSON.parse(v); } catch (e) { v = v.replace(/^"|"$/g, ''); } }
  return v;
}

// wv2449 (David 5-11-2026, MemoryLane ronde 4: "een klein stats-schermpje … de leeftijden van de main-characters"): de hoofdpersonen voor het
// notitieboekje in het eigen MemoryLane-scherm. Welke personen dat zijn staat op één vaultpagina (HOOFD_PAGINA, een tabel Naam | Rol | Pagina's),
// zodat er geen namen in de code staan en David of Socev de lijst kan aanvullen. Per persoon de geboortedatum (frontmatter geboortedatum of
// geboren) en eventueel overleden van de eerste gelinkte pagina die er een heeft. De app rekent de leeftijd elke keer zelf uit (nooit een getal
// opslaan). Niet in de toonmodus (de route staat niet in ML_TOON_ROUTES) en ook hier geweigerd als de toonmodus aan staat.
const HOOFD_PAGINA = '20_Prive/Herinneringen/Hoofdpersonen.md';
const HOOFD_MAX = 40;
// "1984-01-07", "2019-10", "1990", "07-01-1984" → "1984-01-07" / "2019-10" / "1990"; anders null
function hoofdDatum(v) {
  const t = String(v == null ? '' : v).trim().replace(/^"|"$/g, '');
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) { const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))); return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? t : null; }   // een echte dag (geen 29-2 in 1981)
  if ((m = /^(\d{4})-(\d{2})$/.exec(t))) return Number(m[2]) >= 1 && Number(m[2]) <= 12 ? t : null;
  if ((m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(t))) return hoofdDatum(m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'));
  if (/^\d{4}$/.test(t)) return t;
  return null;
}
// de tabel: rijen "| Naam | Rol | [[pad]] · [[pad2]] |"; kop- en scheidingsregel overslaan; alleen links binnen de vault (geen .., geen absoluut pad)
function hoofdTabel(tekst) {
  const uit = [];
  for (const regel of zonderFrontmatter(String(tekst || '')).split('\n')) {
    if (!/^\s*\|/.test(regel) || /^\s*\|\s*:?-{2,}/.test(regel)) continue;
    // wv2579: een | binnen [[pad|alias]] (ook \|) splitst geen cel; de links alleen uit de derde kolom, de vierde is het uiterlijk
    const c = regel.trim().replace(/^\||\|$/g, '').replace(/\[\[[^\]]*\]\]/g, (m) => m.replace(/\\?\|/g, '\u0000')).split('|').map((x) => x.replace(/\u0000/g, '|').trim());
    if (c.length < 3 || /^naam$/i.test(c[0]) || !c[0]) continue;
    const links = [];
    const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
    let m;
    while ((m = re.exec(c[2])) && links.length < 3) {
      const rel = m[1].trim().replace(/\.md$/i, '');
      if (!rel || rel.startsWith('/') || rel.split('/').some((d) => d === '..' || d === '.' || d === '')) continue;
      links.push(rel + '.md');
    }
    // wv2579: optionele vierde kolom Uiterlijk (vrije tekst: lengte, haar, kleding) voor de poppetjes in de straat; geen links, hooguit 160 tekens
    const uit4 = c.length >= 4 && c[3].indexOf('[[') < 0 ? c[3].replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    uit.push({ naam: c[0].slice(0, 60), rol: c[1].slice(0, 60), links, uiterlijk: uit4 || null });
    if (uit.length >= HOOFD_MAX) break;
  }
  return uit;
}
function hoofdpersonenLees(vault, vv) {
  let t;
  try { t = vv.lees(path.join(vault, HOOFD_PAGINA), 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return { pagina: false, personen: [] }; throw e; }
  const personen = hoofdTabel(t).map((r) => {
    let geboren = null, overleden = null, geslacht = null;
    for (const rel of r.links) {
      const abs = path.join(vault, rel);
      if (abs.indexOf(path.join(vault, path.sep)) !== 0) continue;
      let p; try { p = vv.lees(abs, 'utf8'); } catch (e) { continue; }
      // wv2579: geslacht (man/vrouw) van de eerste gelinkte pagina die het noemt (stamboom), voor het poppetje in de straat
      if (!geslacht) { const gs = String(fmVeld(p, 'geslacht') || '').trim().toLowerCase(); if (gs === 'man' || gs === 'vrouw') geslacht = gs; }
      if (geboren) continue;
      const g = hoofdDatum(fmVeld(p, 'geboortedatum')) || hoofdDatum(fmVeld(p, 'geboren'));
      if (!g) continue;
      geboren = g; overleden = hoofdDatum(fmVeld(p, 'overleden')) || hoofdDatum(fmVeld(p, 'overlijdensdatum'));
    }
    // wv2579: sleutels = de paginanamen zoals een herinnering ze als persoon noemt (bestandsnaam zonder "(1984)"), zodat de app het poppetje
    // bij de juiste huizen zet; uiterlijk = de vierde kolom van de tabel
    const sleutels = [...new Set(r.links.map((l) => path.basename(l, '.md').replace(/\s*\(.*\)$/, '').trim()).filter(Boolean))];
    return { naam: r.naam, rol: r.rol, geboren, overleden, geslacht, uiterlijk: r.uiterlijk, sleutels };
  });
  return { pagina: true, personen };
}

/*
 * maak(o) → { lijst, detail, titel, tekst, categorie, stukBesluit, tik, info, kringen, … , _db }.
 * o = { db (intake._db), vault, vv (vault-veilig), dir (/opt/data/herinneringen), marker (patientpoort: beoordeel), geheimen() → [string],
 *       categorieen (herinneringen CATEGORIEEN), onderhoudAan() → bool, nachtgrendel() → bool, nu() → ms, box(tekst), fout(label, e),
 *       reisVandaag?() → 'JJJJ-MM-DD', immich?, video?, eleven?, claude?, verhaal? }
 */
// wv2636: de bezoekerslijst van memorylane.socev.dev (één vaultpagina, nooit namen of adressen in code). Tabel | Naam | Kring | Mailadressen | … |;
// kring familie of shizzle; alle mailadressen uit de derde kolom. status uit de frontmatter (alleen 'bevestigd' telt voor de deur).
const BEZOEKERS_PAGINA = '20_Prive/Herinneringen/MemoryLane-bezoekers.md';
const MAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
function bezoekersTabel(t) {
  const rijen = [];
  for (const regel of zonderFrontmatter(String(t || '')).split('\n')) {
    if (!/^\|/.test(regel)) continue;
    const c = regel.split('|').slice(1, -1).map((x) => x.trim());
    if (c.length < 3) continue;
    const kring = c[1].toLowerCase().replace(/[*_`]/g, '');
    if (kring !== 'familie' && kring !== 'shizzle') continue;
    const naam = c[0].replace(/[*_`[\]]/g, '').trim();
    const mails = [...new Set((c[2].match(MAIL_RE) || []).map((m) => m.trim().toLowerCase()))];
    if (naam && mails.length) rijen.push({ naam, kring, mails });
  }
  return rijen;
}
function bezoekersLees(vault, vv) {
  let t;
  try { t = vv.lees(path.join(vault, BEZOEKERS_PAGINA), 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return { pagina: false, status: null, rijen: [] }; throw e; }
  return { pagina: true, status: fmVeld(t, 'status') || null, rijen: bezoekersTabel(t) };
}

function maak(o) {
  const nu = typeof o.nu === 'function' ? o.nu : Date.now;
  const db = o.db;
  db.exec(SCHEMA_SQL);
  // wv2636: kring per herinnering (familie, shizzle). NULL = het voorstel van de code; 0/1 = Davids keuze; kring_cat = de categorie op het moment
  // van die keuze (wordt de herinnering daarna gevoelig met een andere categorie, dan telt de keuze niet meer).
  { const kol = db.prepare('PRAGMA table_info(ml_herinnering)').all().map((r) => r.name);
    // wv2732: bij = de herinnering waarbij deze is samengevoegd (status 'samengevoegd')
    for (const k of ['kring_familie INTEGER', 'kring_shizzle INTEGER', 'kring_cat TEXT', 'bij TEXT']) if (kol.indexOf(k.split(' ')[0]) < 0) db.exec('ALTER TABLE ml_herinnering ADD COLUMN ' + k); }
  const CAT = o.categorieen || {};
  const DIR = o.dir, WACHT = path.join(DIR, 'ml-wacht');
  for (const d of [DIR, WACHT]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch (e) { /* niet van ons */ } }
  const fout = (l, e) => { if (o.fout) o.fout(l, e); };
  // wv2120: Immich-albums per herinnering (alleen met een Immich-client)
  // (ontbreekt memorylane-fotos.js in de release, dan zonder foto's: delen werkt door)
  const F = (function () { if (!o.immich) return null; try { return require('./memorylane-fotos.js').maak({ db, immich: o.immich, nu, fout }); } catch (e) { fout('ml-fotos', e); return null; } })();
  // wv2938: video's afspelen (memorylane-video.js maakt per video één kleine versie op de pod; o.video = { dir, ffmpeg }). Zonder: geen afspelen.
  const VID = (function () { if (!F || !o.video || !o.video.dir) return null; try { return require('./memorylane-video.js').maak({ dir: o.video.dir, ffmpeg: o.video.ffmpeg, spawn: o.video.spawn, immich: o.immich, nu, fout }); } catch (e) { fout('ml-video', e); return null; } })();
  // wv2366: de verteller in Davids eigen stem (ElevenLabs via de Router; alleen met o.eleven; ontbreekt memorylane-verteller.js, dan zonder)
  const V = (function () {
    if (!o.eleven || typeof o.eleven.sleutel !== 'function') return null;
    try {
      return require('./memorylane-verteller.js').maak({ db, dir: DIR, nu, fout, sleutel: o.eleven.sleutel, routerUrl: o.eleven.routerUrl, fetch: o.eleven.fetch,
        geheimRaak: (t) => geheimRaak(t), markerRaak: (l) => markerRaak(l), klaar: o.eleven.klaar, credits: o.eleven.credits });
    } catch (e) { fout('ml-verteller', e); return null; }
  })();
  // wv2484: het vertelscript voor "Als verhaal vertellen" (alleen met o.claude en de verteller; ontbreekt de module, dan zonder)
  const S = (function () {
    if (!V || !o.claude || typeof o.claude.sleutel !== 'function') return null;
    try { return require('./memorylane-vertelscript.js').maak({ dir: DIR, nu, fout, sleutel: o.claude.sleutel, sdk: o.claude.sdk, basisUrl: o.claude.basisUrl }); }
    catch (e) { fout('ml-vertelscript', e); return null; }
  })();
  let bezig = false, laatst = null;

  const q = {
    h: db.prepare('SELECT * FROM ml_herinnering WHERE hid = ?'),
    hRef: db.prepare('SELECT * FROM ml_herinnering WHERE soort = ? AND ref = ?'),
    hNieuw: db.prepare('INSERT INTO ml_herinnering (hid, soort, ref, categorie, gevoelig, status, aangemaakt, gewijzigd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    hAlle: db.prepare("SELECT * FROM ml_herinnering WHERE status <> 'weg' ORDER BY aangemaakt DESC, hid"),
    hStatus: db.prepare('UPDATE ml_herinnering SET status = ?, gewijzigd = ? WHERE hid = ?'),
    hCat: db.prepare('UPDATE ml_herinnering SET categorie = ?, gevoelig = ?, gewijzigd = ? WHERE hid = ?'),
    hKring: db.prepare('UPDATE ml_herinnering SET kring_familie = ?, kring_shizzle = ?, kring_cat = ?, gewijzigd = ? WHERE hid = ?'),
    hKringWis: db.prepare('UPDATE ml_herinnering SET kring_familie = NULL, kring_shizzle = NULL, kring_cat = NULL, gewijzigd = ? WHERE hid = ?'),
    hGewijzigd: db.prepare('UPDATE ml_herinnering SET gewijzigd = ? WHERE hid = ?'),
    // wv2732: samenvoegen en losmaken (alleen vanuit de verwachte status)
    hBij: db.prepare('UPDATE ml_herinnering SET status = ?, bij = ?, gewijzigd = ? WHERE hid = ? AND status = ?'),
    koppel: db.prepare('SELECT * FROM ml_koppel WHERE hid = ?'),
    koppelKand: db.prepare("SELECT * FROM ml_koppel WHERE kandidaat = ? AND uitkomst = 'samengevoegd'"),
    koppelZet: db.prepare('INSERT INTO ml_koppel (hid, sleutel, uitkomst, kandidaat, titel_gezet, album_gezet, op) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (hid) DO UPDATE SET ' +
      'sleutel = excluded.sleutel, uitkomst = excluded.uitkomst, kandidaat = excluded.kandidaat, titel_gezet = excluded.titel_gezet, album_gezet = excluded.album_gezet, op = excluded.op'),
    koppelUitkomst: db.prepare('UPDATE ml_koppel SET uitkomst = ?, op = ? WHERE hid = ?'),
    s: db.prepare('SELECT * FROM ml_stuk WHERE sid = ?'),
    sVan: db.prepare('SELECT * FROM ml_stuk WHERE hid = ? ORDER BY binnen_op, sid'),
    sNieuw: db.prepare('INSERT INTO ml_stuk (sid, hid, wie, kring, vorm, soort, status, marker, sha256, vault, binnen_op, bron_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)'),
    sStatus: db.prepare('UPDATE ml_stuk SET status = ?, besluit_op = ? WHERE sid = ?'),
    sVault: db.prepare('UPDATE ml_stuk SET vault = 1 WHERE sid = ?'),
    sNaarVault: db.prepare("SELECT * FROM ml_stuk WHERE vault = 0 AND status IN ('binnen', 'opgenomen', 'afgewezen') ORDER BY binnen_op"),
    sTel: db.prepare('SELECT status, count(*) n FROM ml_stuk GROUP BY status'),
    // wv2522: de automatische vertelling als verhaal (alleen hid, verhaalhash, tellers)
    autoGet: db.prepare('SELECT * FROM ml_vertel_auto WHERE hid = ?'),
    autoZet: db.prepare('INSERT INTO ml_vertel_auto (hid, hash, pogingen, op, weg, gemeld) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT (hid) DO UPDATE SET ' +
      'hash = excluded.hash, pogingen = excluded.pogingen, op = excluded.op, weg = excluded.weg, gemeld = 0'),
    autoGemeld: db.prepare('UPDATE ml_vertel_auto SET gemeld = 1 WHERE hid = ?'),
    autoWeg: db.prepare('DELETE FROM ml_vertel_auto WHERE hid NOT IN (SELECT hid FROM ml_herinnering)'),
    ramble: db.prepare('SELECT ramble_id, status, categorie, herinnering_gevoelig, notitie, opgenomen_op, aangemaakt, proef FROM ramble WHERE ramble_id = ?'),
    rambles: db.prepare("SELECT ramble_id FROM ramble WHERE status = 'notitie' AND proef = 0 AND notitie IS NOT NULL"),
  };
  function tx(f) { db.exec('BEGIN IMMEDIATE'); try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { /* al weg */ } throw e; } }
  function nieuwHid() { return 'h' + rnd(8).toString('hex'); }
  function nieuwSid() { return 's' + rnd(8).toString('hex'); }

  // ── wachtrij op de pod (0600): tekst die (nog) niet in de vault staat ──
  function wachtPad(sid) { if (!SID_RE.test(sid)) throw new Error('ongeldig stuk'); return path.join(WACHT, sid + '.json'); }
  function wachtZet(sid, x) {
    const tmp = path.join(WACHT, '.' + rnd(8).toString('hex') + '.tmp');
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(x)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, wachtPad(sid));
  }
  function wachtLees(sid) { try { return JSON.parse(fs.readFileSync(wachtPad(sid), 'utf8')); } catch (e) { return null; } }
  function wachtWeg(sid) { try { fs.unlinkSync(wachtPad(sid)); } catch (e) { /* al weg */ } }

  // ── vault-pagina per herinnering ──
  function paginaRel(hid) { return path.join(MAP, hid + '.md'); }
  function paginaLees(hid) {
    try { return o.vv.lees(path.join(o.vault, paginaRel(hid)), 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
  }
  function blokken(tekst) {
    const uit = new Map();
    if (!tekst) return uit;
    const delen = zonderFrontmatter(tekst).split(/^<!-- ml:stuk (s[0-9a-f]{16}) -->\n/m);
    for (let i = 1; i + 1 < delen.length; i += 2) {
      const body = delen[i + 1].replace(/^### [^\n]*\n/, '');
      uit.set(delen[i], body.replace(/\n+$/, '').replace(/^\n+/, ''));
    }
    return uit;
  }
  function stukTekst(s, pagina) {
    if (!s.vault) { const w = wachtLees(s.sid); return w ? w.tekst : null; }
    const b = blokken(pagina === undefined ? paginaLees(s.hid) : pagina).get(s.sid);
    if (b == null) return null;
    return s.wie === 'bezoeker' ? b.split('\n').map((r) => r.replace(/^> ?/, '')).join('\n').trim() : b.trim();
  }
  function stukNaam(s, pagina) {
    if (s.wie === 'david') return 'David';
    if (!s.vault) { const w = wachtLees(s.sid); return w && w.naam ? w.naam : 'Onbekend'; }
    const t = pagina === undefined ? paginaLees(s.hid) : pagina;
    const m = t ? new RegExp('^<!-- ml:stuk ' + s.sid + ' -->\\n### [^·\\n]*· ([^·\\n(]+)', 'm').exec(t) : null;
    return m ? m[1].trim() : 'Onbekend';
  }
  function bronLink(h) {
    if (h.soort === 'opname') { const r = q.ramble.get(h.ref); return r && r.notitie ? '"[[' + r.notitie.replace(/\.md$/, '') + ']]"' : '""'; }
    if (h.soort === 'reis') return '"[[' + h.ref.replace(/\.md$/, '') + ']]"';
    return '""';
  }
  function standaardTitel(h) {
    if (h.soort === 'opname') { const r = q.ramble.get(h.ref); const a = amsDmj(Date.parse((r && (r.opgenomen_op || r.aangemaakt)) || h.aangemaakt)); return 'Opname ' + a.dmj + ' ' + a.klok; }
    if (h.soort === 'reis') return naamVoorReis(h.ref, reisInfo(h.ref), reisTags(h.ref));   // wv2180: vaste naamgeving
    return 'Losse bijdrage';
  }
  function paginaNieuw(h, titel, bron) {
    return ['---', 'type: herinnering-stukken', 'gevoelig: prive', 'access_context: strikt_prive', 'herinnering_id: ' + h.hid, 'soort: ' + h.soort,
      'bron: ' + bronLink(h), 'titel: ' + yaml(titel || standaardTitel(h)), 'titel_bron: ' + (titel ? bron || 'bezoeker' : 'standaard'), 'tags: [herinnering, prive, memorylane]', '---',
      '> **Privé — persoonlijke herinnering.** Alle bijdragen bij deze herinnering, elk als eigen stuk (wie, wanneer, hoe). Een herinnering is geen bron voor feiten.',
      ''].join('\n') + '\n';
  }
  function kanVault() { return !(o.onderhoudAan && o.onderhoudAan()) && !(o.nachtgrendel && o.nachtgrendel()); }
  function zorgMap() { const m = path.join(o.vault, MAP); if (!fs.existsSync(m)) fs.mkdirSync(m, { recursive: true, mode: 0o770 }); }
  function blokTekst(s, w) {
    const a = amsDmj(Date.parse(s.binnen_op));
    const wie = s.wie === 'david' ? 'David' : (w.naam || 'Onbekend') + ' (' + s.kring + ')';
    const kop = '### ' + a.dmj + ' ' + a.klok + ' · ' + wie + ' · ' + s.soort + ' · ' + (s.vorm === 'spraak' ? 'ingesproken' : 'getypt');
    const tekst = s.wie === 'bezoeker' ? w.tekst.split('\n').map((r) => '> ' + r).join('\n') : w.tekst;
    return '<!-- ml:stuk ' + s.sid + ' -->\n' + kop + '\n\n' + tekst + '\n\n';
  }
  // Schrijf de wachtende stukken naar hun pagina (alleen als de vault mag); geeft het aantal.
  function naarVault() {
    if (!kanVault()) return 0;
    let n = 0;
    for (const s of q.sNaarVault.all()) {
      const w = wachtLees(s.sid);
      if (!w) continue;
      const h = q.h.get(s.hid);
      if (!h) continue;
      try {
        zorgMap();
        const pad = path.join(o.vault, paginaRel(h.hid));
        let bestaand = paginaLees(h.hid);
        if (bestaand === null) { o.vv.schrijf(pad, paginaNieuw(h, w.titel_nieuw || null)); bestaand = paginaLees(h.hid); }
        if (!blokken(bestaand).has(s.sid)) o.vv.voegToe(pad, (bestaand.endsWith('\n') ? '' : '\n') + blokTekst(s, w));
        q.sVault.run(s.sid);
        wachtWeg(s.sid);
        n++;
      } catch (e) { fout('ml-vault', e); }
    }
    return n;
  }
  // Frontmatterregels op de MemoryLane-pagina zetten (waarde null = regel weg); de tekst eronder blijft byte voor byte gelijk
  function paginaVelden(h, velden) {
    zorgMap();
    const pad = path.join(o.vault, paginaRel(h.hid));
    if (paginaLees(h.hid) === null) o.vv.schrijf(pad, paginaNieuw(h, null));
    return o.vv.wijzig(pad, function (t) {
      const m = /^---\n([\s\S]*?)\n---/.exec(t);
      if (!m) return null;
      let fm = m[1];
      for (const [k, w] of Object.entries(velden)) {
        const re = new RegExp('^' + k + ':.*$', 'm');
        if (w === null) fm = fm.replace(new RegExp('^' + k + ':.*(\\n|$)', 'm'), '');
        else fm = re.test(fm) ? fm.replace(re, k + ': ' + w) : fm + '\n' + k + ': ' + w;
      }
      fm = fm.replace(/\n+$/, '');
      const n = '---\n' + fm + '\n---' + t.slice(m[0].length);
      return n === t ? null : n;
    });
  }
  function paginaZekerTitel(h, titel, bron) { return paginaVelden(h, { titel: yaml(titel), titel_bron: bron || 'david' }); }

  // ── herinneringen: opnames (notitie) en reizen (type: reis, voorbij) ──
  const reizen = REIZEN.maak({ vault: o.vault, vv: o.vv });   // wv2136: zelfde lezing als hiervoor, nu gedeeld met Tripper
  function reisInfo(rel) { return reizen.reisInfo(rel); }
  function reisTags(rel) {
    let x = null;
    try { x = o.vv.lees(path.join(o.vault, rel), 'utf8'); } catch (e) { return []; }
    const m = /^tags:\s*\[([^\]\n]*)\]/m.exec((/^---\n[\s\S]*?\n---/.exec(x) || [''])[0]);
    return m ? m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')) : [];
  }
  function vandaag() { return typeof o.reisVandaag === 'function' ? o.reisVandaag() : amsDmj(nu()).datum; }
  function bijwerken() {
    const t = iso(nu());
    for (const r of q.rambles.all()) if (!q.hRef.get('opname', r.ramble_id)) q.hNieuw.run(nieuwHid(), 'opname', r.ramble_id, null, null, 'actief', t, t);
    const gezien = new Set();
    for (const rel of reizen.paden()) {
      const i = reisInfo(rel);
      if (!i || !i.tot || i.tot >= vandaag()) continue;
      gezien.add(rel);
      const h = q.hRef.get('reis', rel);
      if (!h) q.hNieuw.run(nieuwHid(), 'reis', rel, 'reizen', 0, 'actief', t, t);
      else if (h.status === 'weg') q.hStatus.run('actief', t, h.hid);
    }
    for (const h of q.hAlle.all()) {
      if (h.status === 'samengevoegd') continue;   // wv2732: blijft samengevoegd, ook als de reispagina verdwijnt (zie hieronder)
      if (h.soort === 'reis' && !gezien.has(h.ref) && !fs.existsSync(path.join(o.vault, h.ref))) q.hStatus.run('weg', t, h.hid);
      if (h.soort === 'opname') { const r = q.ramble.get(h.ref); if (!r || r.status !== 'notitie') q.hStatus.run('weg', t, h.hid); }
    }
    // wv2732: na de ronde hierboven (die een opname weg kan zetten): is de herinnering waarbij een samengevoegde hoort weg, dan weer actief
    for (const h of q.hAlle.all()) {
      if (h.status !== 'samengevoegd') continue;
      const b = h.bij ? q.h.get(h.bij) : null;
      if (b && b.status !== 'weg') continue;
      // review MOET 1: ook het album terug en de koppeling op losgemaakt (zoals losmaken)
      const k = b ? q.koppel.get(b.hid) : null;
      tx(() => {
        q.hBij.run('actief', null, t, h.hid, 'samengevoegd');
        if (k && k.uitkomst === 'samengevoegd' && k.kandidaat === h.hid) { if (k.album_gezet && F) F.terugVerhuis(b.hid, h.hid, h.soort, h.ref); q.koppelUitkomst.run('losgemaakt', t, b.hid); }
      });
    }
  }

  // Categorie en gevoelig zoals ze nu gelden (opname: de ramble-rij is de bron)
  function catVan(h) {
    if (h.soort === 'opname') { const r = q.ramble.get(h.ref); return { categorie: r ? r.categorie || null : null, gevoeligVink: !!(r && r.herinnering_gevoelig) }; }
    return { categorie: h.categorie || null, gevoeligVink: !!h.gevoelig };
  }
  function isGevoelig(h) { const c = catVan(h); return !c.categorie || !CAT[c.categorie] || !!CAT[c.categorie].gevoelig || c.gevoeligVink; }
  // wv2120: herinneringen die een album krijgen. Vanzelf: een reis, of een andere herinnering zodra hij een categorie heeft.
  // wv2225: met het (begin)jaar waar de herinnering over gaat (voor de albumnaam "<jaar> <titel> (ML)"); null = onbekend
  function albumKandidaat(h) {
    const p = paginaLees(h.hid), s = sam(h, p), w = wanneerInfo(h, p, s);
    const c = catVan(h);
    // wv2468: spoor = de sync rekent periode en punt uit de foto's. wv2932: voor elk fotoalbum zonder gevoelig-vinkje (niet alleen Reizen),
    // want koppel() legt de fotodata naast de reizen; fotoReizen kiest zelf nog alleen Reizen.
    return { hid: h.hid, soort: h.soort, ref: h.ref, titel: titelVan(h, p, s), jaar: w.van ? String(w.van).slice(0, 4) : null, auto: h.soort === 'reis' || !!c.categorie,
      spoor: isFotoalbum(h) && !c.gevoeligVink };
  }
  async function fotoSync(dwing) {
    if (!F) return null;
    return F.sync(q.hAlle.all().filter((h) => h.status === 'actief').map(albumKandidaat), dwing);
  }
  // wv2180: Davids eigen stukken (opgenomen) van een herinnering, met de tekst uit de pagina of de wachtrij
  function eigenStukken(h, pagina) {
    const p = pagina === undefined ? paginaLees(h.hid) : pagina;
    return q.sVan.all(h.hid).filter((s) => s.wie === 'david' && s.status === 'opgenomen').map((s) => ({ sid: s.sid, soort: s.soort, tekst: stukTekst(s, p) })).filter((s) => s.tekst);
  }
  function cs(h, pagina) { return correcties(eigenStukken(h, pagina).filter((s) => s.soort === 'correctie').map((s) => s.tekst)); }
  // het verhaal van een opname (herinneringen-verhaal.js), met Davids correcties; null zonder verhaalmodule
  function sam(h, pagina) {
    if (h.soort !== 'opname' || !o.verhaal || typeof o.verhaal.samengesteld !== 'function') return null;
    // wv2322: Davids eigen stukken mee (een bevestiging "X klopt" of correctie haalt de twijfelmarkering weg)
    try { return o.verhaal.samengesteld(h.ref, cs(h, pagina), eigenStukken(h, pagina).map((x) => ({ soort: x.soort, tekst: x.tekst }))); } catch (e) { fout('ml-verhaal', e); return null; }
  }
  // wv2180: titel. David wint altijd; dan de vaste naamgeving; een opname daarna de titel van zijn verhaal; anders de standaardtitel.
  function oudeStandaard(h) {
    if (h.soort === 'reis') { const i = reisInfo(h.ref); return i ? i.titel : path.basename(h.ref, '.md'); }
    return standaardTitel(h);
  }
  // een titel die niet de standaard is (David, vaste naamgeving, bezoeker, of een oude pagina zonder titel_bron met een eigen titel)
  function eigenTitel(h, p) {
    const t = fmVeld(p, 'titel'), b = fmVeld(p, 'titel_bron');
    return t && (b === 'david' || b === 'naamgeving' || b === 'bezoeker' || (!b && t !== oudeStandaard(h) && t !== standaardTitel(h))) ? t : null;
  }
  function titelVan(h, pagina, s) {
    const p = pagina === undefined ? paginaLees(h.hid) : pagina;
    const t = eigenTitel(h, p);
    if (t) return t;
    if (h.soort === 'opname') {
      const x = s === undefined ? sam(h, p) : s;
      const v = x && x.delen.find((d) => d.titel && !/^Herinnering uit de opname van /.test(d.titel));
      if (v) return v.titel;
    }
    return standaardTitel(h);
  }
  // wv2180: wanneer. → { tekst, van, tot, precisie, bron: david|reis|verhaal|null, invoer: {van, tot}|null, verteld }
  function wanneerInfo(h, pagina, s) {
    const p = pagina === undefined ? paginaLees(h.hid) : pagina;
    let verteld = '';
    if (h.soort === 'opname') { const r = q.ramble.get(h.ref); if (r) verteld = 'verteld op ' + amsDmj(Date.parse(r.opgenomen_op || r.aangemaakt)).dmj; }
    const w = wanneerUit(fmVeld(p, 'wanneer'));
    if (w) return { tekst: wanneerTekst(w.a, w.b), van: w.van, tot: w.tot, precisie: w.precisie, bron: 'david', invoer: w.invoer, verteld };
    if (h.soort === 'reis') {
      const i = reisInfo(h.ref);
      const c = i && i.van ? codeWanneer(i.van, i.tot || i.van, 'dag') : null;
      if (c) return { tekst: c.tekst, van: c.van, tot: c.tot, precisie: 'dag', bron: 'reis', invoer: null, verteld };
    }
    if (h.soort === 'opname') {
      const x = s === undefined ? sam(h, p) : s;
      const d = x && x.delen.find((y) => y.datum_precisie && y.datum_precisie !== 'onbekend' && y.datum_van);
      const c = d ? codeWanneer(d.datum_van, d.datum_tot, d.datum_precisie) : null;
      if (c) return { tekst: c.tekst, van: c.van, tot: c.tot, precisie: c.precisie, bron: 'verhaal', invoer: null, verteld };
    }
    return { tekst: '', van: null, tot: null, precisie: null, bron: null, invoer: null, verteld };
  }
  // Volgorde (wv2180): met een datum eerst, nieuwste eerst (de straat loopt van nu naar vroeger); zonder datum achteraan, op opnamedatum.
  function sorteerSleutel(h, w) {
    w = w || wanneerInfo(h);
    if (w.van) return '1|' + w.van + '|' + (w.tot || w.van);
    if (h.soort === 'opname') { const r = q.ramble.get(h.ref); return '0|' + (r ? String(r.opgenomen_op || r.aangemaakt).slice(0, 19) : h.aangemaakt.slice(0, 19)); }
    return '0|' + h.aangemaakt.slice(0, 19);
  }
  function opnameTekst(h) {
    const r = q.ramble.get(h.ref);
    if (!r || !r.notitie) return null;
    let t;
    try { t = o.vv.lees(path.join(o.vault, r.notitie), 'utf8'); } catch (e) { return null; }
    const body = zonderFrontmatter(t).replace(/^> \*\*Privé[^\n]*\n+/, '').replace(/^# Opname[^\n]*\n+/, '');
    return kaleOpname(body);
  }
  // wv2254: een herinnering uit een Google Foto's-album (wv2238: soort 'los', ref google:<16 hex>). De soort blijft 'los' (de albumcode is
  //  sha256(soort|ref)); alleen weergave en verhaal behandelen hem als fotoalbum: Davids eigen aanvullingen tellen mee, zoals bij een reis.
  const GOOGLE_RE = /^google:[0-9a-f]{16}$/;
  function isFotoalbum(h) { return h.soort === 'los' && GOOGLE_RE.test(String(h.ref || '')); }
  // wv2180: het samengestelde verhaal als platte tekst (alinea's), zonder tijdcodes; null = (nog) geen.
  //  opname → het verhaal (concept of goedgekeurd; de feitentoets liet alleen gezegde namen, getallen en datums door); reis → Davids eigen
  //  aanvullingen; los → de bijdrage zelf. Correcties letterlijk.
  //  wv2322: buiten = voor iemand anders (deellink, toonmodus): een deel met open twijfel (een naam, getal of datum die de server niet terugvond
  //  en die David nog niet bevestigde) gaat dan niet mee.
  function verhaalVan(h, pagina, s, buiten) {
    const p = pagina === undefined ? paginaLees(h.hid) : pagina;
    const c = cs(h, p);
    if (h.soort === 'opname') {
      const x = s === undefined ? sam(h, p) : s;
      const dl = x ? x.delen.filter((d) => !(buiten && d.twijfel_open)) : [];
      if (!dl.length) return null;
      return dl.map((d) => (dl.length > 1 && d.titel ? d.titel + '\n\n' : '') + d.alineas.map((a) => a.tekst).join('\n\n')).join('\n\n');
    }
    if (h.soort === 'reis') { const l = eigenStukken(h, p).filter((x) => x.soort === 'aanvulling').map((x) => pasToe(x.tekst, c)); return l.length ? l.join('\n\n') : null; }
    if (isFotoalbum(h)) {
      const l = q.sVan.all(h.hid).filter((x) => x.status === 'opgenomen' && (x.wie === 'david' ? x.soort === 'aanvulling' : x.soort === 'los'))
        .map((x) => stukTekst(x, p)).filter(Boolean).map((x) => pasToe(x, c));
      return l.length ? l.join('\n\n') : null;
    }
    const l = q.sVan.all(h.hid).filter((x) => x.status === 'opgenomen' && x.soort === 'los').map((x) => stukTekst(x, p)).filter(Boolean).map((x) => pasToe(x, c));
    return l.length ? l.join('\n\n') : null;
  }

  // Geheimen: letterlijke pod-geheimen + bekende vormen (zelfde soort als de geheimenpoort op de uitgangen)
  const VORMEN = [/sbp_[0-9a-f]{40}/, /sk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{40,}/, /AKIA[0-9A-Z]{16}/,
    /xox[abpr]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /\b\d{9,10}:AA[A-Za-z0-9_-]{30,}/];
  function geheimRaak(t) {
    if (VORMEN.some((r) => r.test(t))) return true;
    const lijst = typeof o.geheimen === 'function' ? o.geheimen() : [];
    return lijst.some((g) => typeof g === 'string' && g.length >= 12 && t.indexOf(g) >= 0);
  }
  function markerRaak(teksten) {
    if (!o.marker) return false;
    try { return !!o.marker.beoordeel({ teksten }, { eigen: o.marker.maakEigen ? o.marker.maakEigen(null, {}) : undefined }).tegenhouden; }
    catch (e) { fout('ml-marker', e); return true; }   // twijfel = vasthouden
  }
  async function tik() {
    if (bezig) return { bezig: true };
    bezig = true;
    const uit = { vault: 0 };
    try {
      bijwerken();
      try { const k = koppel(false); if (k.samengevoegd) uit.samengevoegd = k.samengevoegd; } catch (e) { fout('ml-koppel', e); }   // wv2732
      if (V) { try { V.opruim((hid) => { const h = q.h.get(hid); return !!h && !vertellerNiet(h); }); } catch (e) { fout('ml-verteller', e); } }   // wv2366 (review MOET 2)
      if (S) { try { S.opruim((hid) => { const h = q.h.get(hid); return !!h && !vertellerNiet(h); }); } catch (e) { fout('ml-vertelscript', e); } }   // wv2484
      if (S) { try { const a = autoVertel(false); if (a && a.gestart) uit.vertelling = 1; } catch (e) { fout('ml-vertel-auto', e); } }   // wv2522
      uit.vault = naarVault();
      if (F) { try { const f = await fotoSync(false); if (f && (f.nieuw || f.overgenomen || f.weg || f.deel)) uit.albums = f.nieuw + f.overgenomen; } catch (e) { fout('ml-immich', e); } }
      return uit;
    } finally { bezig = false; laatst = { op: iso(nu()), ...uit }; }
  }

  // ── voor de app ──
  // ── wv2306 (R3): toonmodus, afspelen, voorstellen, filters ──
  // Toonbaar in de toonmodus (§ 13.2): actief, met een categorie, niet gevoelig; een opname alleen met notitie en geen proef.
  function toonbaar(h) {
    if (!h || h.status !== 'actief' || !catVan(h).categorie || isGevoelig(h)) return false;
    if (h.soort === 'los' && !isFotoalbum(h)) return false;   // review MOET 2: een losse bijdrage van een bezoeker niet in de toonmodus
    if (h.soort === 'opname') { const r = q.ramble.get(h.ref); if (!r || r.status !== 'notitie' || r.proef) return false; }
    return true;
  }
  const AUDIO_RE = /^([1-9][0-9]?)\.wav$/;
  // de minuutstukken (WAV) van een opname in het audio-archief van herinneringen.js → [n, …] oplopend; [] zonder archief
  function audioStukken(h) {
    if (h.soort !== 'opname' || !/^r[0-9]{8}-[0-9a-f]{16}$/.test(String(h.ref || ''))) return [];
    const r = q.ramble.get(h.ref);
    if (!r || r.proef) return [];
    let namen = [];
    try { namen = fs.readdirSync(path.join(DIR, 'audio', h.ref)); } catch (e) { return []; }
    return namen.map((n) => AUDIO_RE.exec(n)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
  }
  // personen, plaatsen en voorvallen uit het verhaal (alleen wat David met Ja koppelde; plaats zoals het verhaal hem noemt)
  function facetten(x) {
    const per = new Set(), pl = new Set(), vv = new Set();
    for (const d of (x && x.delen) || []) {
      for (const p2 of d.personen || []) if (p2 && p2.naam) per.add(p2.naam);
      if (d.plaats) pl.add(d.plaats);
      if (d.voorval && d.voorval.titel) vv.add(d.voorval.titel);
    }
    return { personen: [...per].sort(), plaatsen: [...pl].sort(), voorvallen: [...vv].sort() };
  }
  // Wat de toonmodus van een herinnering geeft: geen log, geen bijdragen, geen deelstand, geen paden of ids van de opname
  function toonKort(k) {
    return { hid: k.hid, soort: k.soort, bron: k.bron, status: k.status, titel: k.titel, wanneer: k.wanneer, wanneer_bron: k.wanneer_bron, datum: k.datum, categorie: k.categorie,
      gevoelig: false, personen: k.personen, plaatsen: k.plaatsen, voorvallen: k.voorvallen, audio: k.audio, binnen: 0, vastgehouden: 0, stukken: 0,
      album: k.album ? { status: k.album.status, aantal: k.album.aantal } : null,
      precisie: k.precisie || null, video: typeof k.video === 'number' ? k.video : null };   // wv3264: geen stem, kring of punt
  }
  // ── wv2636: kringen (MemoryLane delen op memorylane.socev.dev; ontwerp vault 01_Ontwikkeling "MemoryLane op een eigen adres" § 4) ──
  // Basis: actief, geen losse bijdrage van een bezoeker, opname alleen met notitie en geen proef, geen gevoelig-vinkje. Daarbovenop per kring:
  // Davids keuze (kring_*), anders het voorstel. Het voorstel is streng (niet gevoelig: categorie gekozen en niet Privé); Davids keuze mag ook
  // een herinnering zonder categorie of met Privé openzetten (David 8-11-2026: "ALLES mag gelabeld"), zolang de categorie niet veranderde.
  function basisNiet(h) {
    if (!h || h.status !== 'actief') return 'niet actief';
    if (h.soort === 'los' && !isFotoalbum(h)) return 'bijdrage van een bezoeker';
    if (h.soort === 'opname') { const r = q.ramble.get(h.ref); if (!r || r.status !== 'notitie' || r.proef) return 'opname niet beschikbaar'; }
    if (catVan(h).gevoeligVink) return 'gevoelig';
    return null;
  }
  function keuzeGeldt(h) { return h.kring_familie != null && h.kring_shizzle != null && (h.kring_cat || '') === (catVan(h).categorie || ''); }
  function kringVoorstel(h, titel) {
    if (isGevoelig(h)) return { familie: false, shizzle: false };
    const t = ' ' + String(titel || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ') + ' ';
    const sh = catVan(h).categorie === 'shizzle' || t.indexOf(' shizzle ') >= 0 || shizzleWoorden().some((w) => t.indexOf(' ' + w + ' ') >= 0);
    return { familie: true, shizzle: sh };
  }
  let swCache = null;
  // voornamen van de Shizzle-bezoekers (vaultlijst; nooit in code): een titel met zo'n naam stelt ook Shizzle voor
  function shizzleWoorden() {
    if (swCache && nu() - swCache.op < 60000) return swCache.w;
    let w = [];
    try { w = bezoekersLees(o.vault, o.vv).rijen.filter((r) => r.kring === 'shizzle').map((r) => r.naam.split(/\s+/)[0].toLowerCase()).filter((x) => x.length >= 3); }
    catch (e) { fout('ml-bezoekers', e); }
    swCache = { op: nu(), w };
    return w;
  }
  // → { familie, shizzle, bron: 'david'|'voorstel', niet: reden|null } ; familie/shizzle = open in die kring
  function kringVan(h, titel) {
    const niet = basisNiet(h);
    if (keuzeGeldt(h)) return { familie: !niet && !!h.kring_familie, shizzle: !niet && !!h.kring_shizzle, bron: 'david', niet };
    const v = niet ? { familie: false, shizzle: false } : kringVoorstel(h, titel === undefined ? titelVan(h) : titel);
    return { familie: v.familie, shizzle: v.shizzle, bron: 'voorstel', niet: niet || (isGevoelig(h) ? 'gevoelig of zonder categorie' : null) };
  }
  function magKring(h, k) { return !!h && PKRINGEN.indexOf(k) >= 0 && !!kringVan(h)[k]; }
  function magZien(h, opt) { return opt && opt.kring ? magKring(h, opt.kring) : toonbaar(h); }
  // Dicht huis (wel in de straat, deur dicht) = basis in orde en (gevoelig alleen met Davids keuze); anders staat hij niet in de straat van
  // bezoekers (ontwerp § 4, keuze b: gevoelig helemaal weglaten).
  function inStraat(h) { return !basisNiet(h) && (!isGevoelig(h) || keuzeGeldt(h)); }
  // David zet een kring aan of uit voor één herinnering. Aan = naar buiten (server.js eist een verse vingerafdruk); uit mag altijd.
  function kring(hid, d) {
    const h = vind(hid), k = d && d.kring;
    if (!h || h.status === 'weg') return { status: 404, body: { ok: false, fout: 'onbekend' } };
    if (PKRINGEN.indexOf(k) < 0 || typeof d.aan !== 'boolean') return { status: 400, body: { ok: false, fout: 'kring en aan' } };
    const nu0 = kringVan(h);
    if (d.aan && nu0.niet && nu0.niet !== 'gevoelig of zonder categorie') return { status: 409, body: { ok: false, fout: nu0.niet } };
    const n = { familie: nu0.familie, shizzle: nu0.shizzle };
    n[k] = d.aan;
    q.hKring.run(n.familie ? 1 : 0, n.shizzle ? 1 : 0, catVan(h).categorie || '', iso(nu()), h.hid);
    return { status: 200, body: { ok: true, kring: kringRij(q.h.get(h.hid)) } };
  }
  // terug naar het voorstel
  function kringVoorstelTerug(hid) {
    const h = vind(hid);
    if (!h || h.status === 'weg') return { status: 404, body: { ok: false, fout: 'onbekend' } };
    q.hKringWis.run(iso(nu()), h.hid);
    return { status: 200, body: { ok: true, kring: kringRij(q.h.get(h.hid)) } };
  }
  function kringRij(h) {
    const p = paginaLees(h.hid), s = sam(h, p), t = titelVan(h, p, s), w = wanneerInfo(h, p, s), k = kringVan(h, t);
    return { hid: h.hid, titel: t, wanneer: w.tekst || w.verteld, datum: sorteerSleutel(h, w), categorie: catVan(h).categorie, soort: h.soort,
      familie: k.familie, shizzle: k.shizzle, bron: k.bron, niet: k.niet, in_straat: inStraat(h) };
  }
  // Overzicht voor Davids app: per herinnering wie hem ziet; tellingen per kring
  function kringen() {
    bijwerken();
    const rijen = q.hAlle.all().filter((h) => h.status === 'actief').map(kringRij);
    rijen.sort((a, b) => (a.datum < b.datum ? 1 : a.datum > b.datum ? -1 : a.hid < b.hid ? -1 : 1));
    const tel = { familie: rijen.filter((r) => r.familie).length, shizzle: rijen.filter((r) => r.shizzle).length, totaal: rijen.length,
      dicht_familie: rijen.filter((r) => r.in_straat && !r.familie).length, dicht_shizzle: rijen.filter((r) => r.in_straat && !r.shizzle).length,
      weg: rijen.filter((r) => !r.in_straat).length };
    return { status: 200, body: { ok: true, kringen: PKRINGEN, tel, herinneringen: rijen } };
  }
  // Voor memorylane-publiek.js: per kring de straat van een bezoeker. open → het item zoals de toonmodus het geeft; dicht → alleen het jaar.
  function publiekLijst(k) {
    if (PKRINGEN.indexOf(k) < 0) return [];
    bijwerken();
    const uit = [];
    for (const h of q.hAlle.all()) {
      // A25 (Fable-review 19-11, memorylane § 3): één onleesbare pagina = dat huis dicht (fout: true), de rest van de straat gaat door
      try {
        if (h.status !== 'actief' || !inStraat(h)) continue;
        const p = paginaLees(h.hid), s = sam(h, p), t = titelVan(h, p, s);
        if (kringVan(h, t)[k]) uit.push({ hid: h.hid, open: true, item: toonKort(kort(h, p, s)) });
        else { const w = wanneerInfo(h, p, s); uit.push({ hid: h.hid, open: false, jaar: w.van ? String(w.van).slice(0, 4) : null }); }
      } catch (e) { fout('ml-publiek-huis', e); uit.push({ hid: h.hid, open: false, jaar: null, fout: true }); }
    }
    return uit;
  }
  function kort(h, pagina, s) {
    const p = pagina === undefined ? paginaLees(h.hid) : pagina;
    const x = s === undefined ? sam(h, p) : s;
    const st = q.sVan.all(h.hid), c = catVan(h), w = wanneerInfo(h, p, x);
    return { ...facetten(x), audio: audioStukken(h).length, hid: h.hid, soort: h.soort, bron: isFotoalbum(h) ? 'google' : null, status: h.status, titel: titelVan(h, p, x), wanneer: w.tekst || w.verteld, wanneer_bron: w.bron, wanneer_invoer: w.invoer,
      verteld: w.verteld, datum: sorteerSleutel(h, w), categorie: c.categorie, gevoelig: isGevoelig(h), gevoelig_vink: c.gevoeligVink,
      verhaal_stand: h.soort === 'opname' ? (x ? x.stand : null) : null,
      zicht: { familie: false, vrienden: false },   // wv4115 (review MOET 1): vast uit, één release lang voor een app-bundel van vóór wv4115 (leest h.zicht zonder vangnet)
      stukken: st.filter((y) => y.status !== 'weggegooid').length, binnen: st.filter((y) => y.status === 'binnen').length,
      vastgehouden: st.filter((y) => y.status === 'vastgehouden').length, album: F ? F.kort(h.hid) : null,
      // wv3264 (Levenskalender, ontwerp 17-11 § Bouwplan): precisie van de datum (dag|maand|jaar|ongeveer_jaar|decennium|null), het aantal
      // video's in het album (null = onbekend) en of er een vertelling in Davids eigen stem klaarstaat
      precisie: w.precisie || null, video: videoVan(h), stem: stemKlaar(h, p, x) };
  }
  // wv3264: aantal video's uit het fotospoor (alleen fotoalbums; reizen en opnames: null = onbekend)
  function videoVan(h) { const sp = F && typeof F.spoor === 'function' ? F.spoor(h.hid) : null; return sp && typeof sp.videos === 'number' ? sp.videos : null; }
  // wv3264: staat er een vertelling in eigen stem klaar die bij het huidige verhaal hoort? Snel pad: zonder bewaarde vertelling geen tekst rekenen.
  function stemKlaar(h, p, x) {
    if (!V || vertellerNiet(h)) return false;
    const heeft = (vorm) => V.stand(h.hid, null, vorm).stand !== null;
    if (!heeft('voorlezen') && !(S && heeft('verhaal'))) return false;
    try {
      const a = vertellerKort(h, p, x), b = vertelVerhaalKort(h, p, x);
      return !!((a && a.stand === 'klaar' && !a.kan) || (b && b.stand === 'klaar' && !b.kan));
    } catch (e) { fout('ml-stem-lijst', e); return false; }
  }
  // wv4117 (besluitenpagina nr 165 = 2C65, David Ja 25-11): de dagen van de foto's (fotospoor: het drukste venster van ≤ 31 dagen met ≥ 80 % van
  // de foto's met een datum) voor "Vandaag in je leven" en de datumvoorstellen in de app. Alleen bij David: niet in de toonmodus, niet naar bezoekers
  // (toonKort neemt het veld niet over). De app beslist of het bij de datum op de pagina past; de pod schrijft hier niets.
  function fotodagenVan(h) {
    const sp = F && typeof F.spoor === 'function' ? F.spoor(h.hid) : null;
    return sp && sp.van && sp.tot ? { van: sp.van, tot: sp.tot } : null;
  }
  // wv3264: het kaartpunt voor David (nooit in de toonmodus of naar buiten): fotospoor, anders de reispagina (Tripper)
  function puntVan(h) {
    const sp = F && typeof F.spoor === 'function' ? F.spoor(h.hid) : null;
    if (sp && sp.punt) return sp.punt;
    if (h.soort !== 'reis') return null;
    try { const t = o.vv.lees(path.join(o.vault, h.ref), 'utf8'); return REIZEN.kaartPunt(REIZEN.plekkenVan(t)); } catch (e) { return null; }
  }
  // opt.toon (wv2306): de toonmodus van dit apparaat staat aan → alleen toonbare herinneringen, ingekort; geen gevoelige categorie in de lijst
  // wv3264 (risico 6 van het Levenskalender-ontwerp): duur van de lijst-aanroep, zichtbaar in /health (memorylane_delen.lijst_ms)
  const lijstDuur = { laatste: null, max: null, n: 0, op: null };
  function lijst(opt) {
    const t0 = Date.now();
    try { return lijstIn(opt); } finally { const d = Date.now() - t0; lijstDuur.laatste = d; lijstDuur.max = Math.max(lijstDuur.max || 0, d); lijstDuur.n++; lijstDuur.op = iso(nu()); }
  }
  function lijstIn(opt) {
    const toon = !!(opt && opt.toon);
    bijwerken();
    // wv3264: bij David ook de kring (Familie/Shizzle, zoals Delen hem toont) en het kaartpunt; nooit in de toonmodus
    // wv3265 (Levenskalender deel B, blok Nieuw): nieuw_op = wanneer de herinnering erbij kwam (ml_herinnering.aangemaakt); alleen bij David
    const alle = q.hAlle.all().filter((h) => h.status !== 'afgewezen' && h.status !== 'samengevoegd' && (!toon || toonbaar(h))).map((h) => {
      if (toon) return toonKort(kort(h));
      const p = paginaLees(h.hid), x = sam(h, p), k = kort(h, p, x), kr = kringVan(h, k.titel);
      return Object.assign(k, { kring: { familie: !!kr.familie, shizzle: !!kr.shizzle }, punt: puntVan(h), nieuw_op: h.aangemaakt || null, fotodagen: fotodagenVan(h) });
    });
    alle.sort((a, b) => (a.datum < b.datum ? 1 : a.datum > b.datum ? -1 : a.hid < b.hid ? -1 : 1));
    if (toon) {
      return { status: 200, body: { ok: true, toon: true, herinneringen: alle, immich: F ? { aan: true } : { aan: false },
        categorieen: Object.keys(CAT).filter((id) => !CAT[id].gevoelig).map((id) => ({ id, naam: CAT[id].naam, gevoelig: false })), nieuw: 0 } };
    }
    return { status: 200, body: { ok: true, toon: false, herinneringen: alle, immich: F ? { aan: true, sleutel: F.info().sleutel, fout: F.info().fout } : { aan: false }, categorieen: Object.keys(CAT).map((id) => ({ id, naam: CAT[id].naam, gevoelig: !!CAT[id].gevoelig })),
      nieuw: alle.reduce((n, h) => n + h.binnen + h.vastgehouden, 0) } };
  }
  function vind(hid) { return HID_RE.test(String(hid)) ? q.h.get(hid) : null; }
  const NIET_TOON = { status: 403, body: { ok: false, fout: 'niet beschikbaar', toon: true } };
  function detail(hid, opt) {
    const h = vind(hid);
    if (!h || h.status === 'weg') return { status: 404, body: { ok: false, fout: 'onbekend' } };
    const pagina = paginaLees(h.hid), s = sam(h, pagina);
    if (opt && (opt.toon || opt.kring)) {
      if (!magZien(h, opt)) return NIET_TOON;
      // alleen het samengestelde verhaal (zonder tijdcodes en zonder "door jou aangepast"); nooit de log
      const t = toonKort(kort(h, pagina, s));
      t.verhaal = { tekst: verhaalVan(h, pagina, s, true), stand: h.soort === 'opname' ? (s ? s.stand : null) : null,
        delen: s ? s.delen.filter((d) => !d.twijfel_open).map((d) => ({ titel: d.titel, eigen: false, alineas: d.alineas.map((a) => ({ tekst: a.tekst, t_van: null, t_tot: null })) })) : [] };
      t.stukken_lijst = []; t.voorstellen = [];
      return { status: 200, body: { ok: true, toon: true, herinnering: t } };
    }
    const stukken = q.sVan.all(h.hid).filter((x) => x.status !== 'weggegooid').map((x) => ({ sid: x.sid, wie: x.wie, naam: stukNaam(x, pagina), kring: x.kring, vorm: x.vorm,
      soort: x.soort, status: x.status, marker: x.marker, op: x.binnen_op, tekst: stukTekst(x, pagina) }));
    const uit = Object.assign(kort(h, pagina, s), { stukken_lijst: stukken });
    // wv2180: het samengestelde verhaal (standaard in beeld) en de log (alleen in de app; nooit in een deellink)
    const c = cs(h, pagina);
    uit.verhaal = { tekst: verhaalVan(h, pagina, s), stand: h.soort === 'opname' ? (s ? s.stand : null) : null,
      // wv2322: alleen voor David de twijfel (gemarkeerde woorden per alinea en een uitleg per deel)
      delen: s ? s.delen.map((d) => ({ titel: d.titel, eigen: d.eigen, twijfel: d.twijfel || [], letterlijk: !!d.letterlijk,
        alineas: d.alineas.map((a) => ({ tekst: a.tekst, t_van: a.t_van, t_tot: a.t_tot, twijfel: a.twijfel || [] })) })) : [] };
    uit.log = { opname: h.soort === 'opname' ? opnameTekst(h) : null, niet_gelukt: s ? s.niet_gelukt.map((m) => ({ uitleg: m.uitleg, woord: m.woord || null, t_van: m.t_van, t_tot: m.t_tot })) : [],
      correcties: c.map((x) => ({ van: x.van, naar: x.naar })), stukken };
    if (h.soort === 'opname') { uit.opname = uit.log.opname; const r = q.ramble.get(h.ref); uit.ramble_id = h.ref; uit.notitie = r ? r.notitie : null; }
    if (h.soort === 'reis') uit.pagina = h.ref;
    uit.pagina_stukken = paginaRel(h.hid);
    uit.voorstellen = voorstellenVan(s);
    uit.verteller = vertellerKort(h, pagina, s);   // wv2366
    uit.verteller_verhaal = vertelVerhaalKort(h, pagina, s);   // wv2484
    return { status: 200, body: { ok: true, herinnering: uit } };
  }
  function titel(hid, d) {
    const h = vind(hid);
    if (!h) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    const t = schoon(d && d.titel, MAX_TITEL, false);
    if (!t) return { status: 400, body: { ok: false, fout: 'titel 1–' + MAX_TITEL + ' tekens' } };
    if (!kanVault()) return { status: 503, body: { ok: false, fout: 'de Second Brain is even in onderhoud; probeer het zo opnieuw' } };
    paginaZekerTitel(h, t, 'david');
    q.hGewijzigd.run(iso(nu()), h.hid);
    return { status: 200, body: { ok: true, herinnering: kort(q.h.get(h.hid)) } };
  }
  // wv2180: Davids "wanneer" (jaar, of een reeks, optioneel met maand of dag). Leeg = weg (dan weer wat de code afleidt).
  function wanneer(hid, d) {
    const h = vind(hid);
    if (!h || h.status === 'weg') return { status: 404, body: { ok: false, fout: 'onbekend' } };
    const van = String((d && d.van) || '').trim(), tot = String((d && d.tot) || '').trim();
    let waarde = null;
    if (van) {
      const w = datumDeel(van) && (!tot || datumDeel(tot)) ? wanneerUit(van + (tot ? '/' + tot : '')) : null;
      if (!w) return { status: 400, body: { ok: false, fout: 'datum: jaar (JJJJ), of JJJJ-MM of JJJJ-MM-DD; "tot" niet vóór "van"' } };
      if (w.van > amsDmj(nu()).datum) return { status: 400, body: { ok: false, fout: 'een herinnering ligt niet in de toekomst' } };
      waarde = yaml(w.invoer.van + (w.invoer.tot ? '/' + w.invoer.tot : ''));
    }
    if (!kanVault()) return { status: 503, body: { ok: false, fout: 'de Second Brain is even in onderhoud; probeer het zo opnieuw' } };
    paginaVelden(h, { wanneer: waarde });
    q.hGewijzigd.run(iso(nu()), h.hid);
    return { status: 200, body: { ok: true, herinnering: kort(q.h.get(h.hid)) } };
  }
  // wv2180: voor de verhaalmodule — Davids eigen aanvullingen en correcties bij een opname (alleen David; bijdragen van anderen niet)
  function davidStukken(rid) {
    const h = q.hRef.get('opname', String(rid || ''));
    if (!h) return [];
    return eigenStukken(h).map((s) => ({ soort: s.soort, tekst: s.tekst }));
  }
  // wv2180: een titel volgens de vaste naamgeving zetten (machinekamer; een titel van David blijft staan)
  function naamgeving(hid, titel) {
    const h = vind(hid);
    const t = schoon(titel, MAX_TITEL, false);
    if (!h || !t) return { ok: false, fout: 'onbekend of lege titel' };
    const p = paginaLees(h.hid);
    const b = fmVeld(p, 'titel_bron'), oud = fmVeld(p, 'titel');
    if (oud && (b === 'david' || (!b && oud !== oudeStandaard(h) && oud !== standaardTitel(h)))) return { ok: true, al: 'david' };
    if (!kanVault()) return { ok: false, fout: 'onderhoud' };
    paginaZekerTitel(h, t, 'naamgeving');
    q.hGewijzigd.run(iso(nu()), h.hid);
    return { ok: true };
  }
  function tekst(hid, d) {
    const h = vind(hid);
    if (!h || h.status === 'weg') return { status: 404, body: { ok: false, fout: 'onbekend' } };
    const t = schoon(d && d.tekst, MAX_TEKST, true);
    if (!t) return { status: 400, body: { ok: false, fout: 'tekst 1–' + MAX_TEKST + ' tekens' } };
    const soort = d.soort === 'correctie' ? 'correctie' : 'aanvulling';
    const sid = nieuwSid(), nuIso = iso(nu());
    wachtZet(sid, { tekst: t, naam: 'David' });
    q.sNieuw.run(sid, h.hid, 'david', 'eigen', 'tekst', soort, 'opgenomen', 'geen', sha256(t), nuIso, null);
    // wv2536: een correctie naar een bekende naam ("Livia is Lyvia") komt op de namenlijst, zodat hij ook in andere verhalen geldt
    if (soort === 'correctie' && o.verhaal && o.verhaal.namen && typeof o.verhaal.namen.leer === 'function') { try { o.verhaal.namen.leer([t]); } catch (e) { fout('ml-namen', e); } }
    naarVault();
    return { status: 200, body: { ok: true, sid, vault: !!q.s.get(sid).vault } };
  }
  function categorie(hid, d) {
    const h = vind(hid);
    if (!h) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    if (h.soort === 'opname') return { status: 409, body: { ok: false, fout: 'de categorie van een opname kies je bij de opname' } };
    const c = d && d.categorie;
    if (!CAT[c]) return { status: 400, body: { ok: false, fout: 'onbekende categorie' } };
    const gev = CAT[c].gevoelig ? 1 : d.gevoelig ? 1 : 0;
    q.hCat.run(c, gev, iso(nu()), h.hid);
    if (gev) q.hKringWis.run(iso(nu()), h.hid);   // gevoelig = meteen nergens meer zichtbaar (wv2636: ook geen kring)
    return { status: 200, body: { ok: true, herinnering: kort(q.h.get(h.hid)) } };
  }
  function stukBesluit(sid, actie) {
    const s = SID_RE.test(String(sid)) ? q.s.get(sid) : null;
    if (!s) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    const t = iso(nu());
    const mag = { opnemen: ['binnen', 'afgewezen'], afwijzen: ['binnen', 'opgenomen'], bewaren: ['vastgehouden'], weggooien: ['vastgehouden'] };
    if (!mag[actie]) return { status: 400, body: { ok: false, fout: 'onbekende keuze' } };
    if (mag[actie].indexOf(s.status) < 0) return { status: 409, body: { ok: false, fout: 'kan niet bij dit stuk' } };
    // een bijdrage met een sleutel of wachtwoord erin komt nooit in de vault (beveiliging, geen filter op Davids eigen tekst)
    if (actie === 'bewaren' && s.marker === 'geheim') return { status: 409, body: { ok: false, fout: 'hier staat een sleutel of wachtwoord in; alleen weggooien kan' } };
    if (actie === 'weggooien') { wachtWeg(s.sid); q.sStatus.run('weggegooid', t, s.sid); }
    else q.sStatus.run(actie === 'opnemen' ? 'opgenomen' : actie === 'afwijzen' ? 'afgewezen' : 'binnen', t, s.sid);
    const h = q.h.get(s.hid);
    if (h && h.soort === 'los' && !isFotoalbum(h)) {   // wv2254: een fotoalbum blijft actief, ook als een bijdrage wordt afgewezen
      if (actie === 'opnemen' && h.status === 'voorstel') q.hStatus.run('actief', t, h.hid);
      if (actie === 'afwijzen' && q.sVan.all(h.hid).every((x) => x.status !== 'opgenomen')) q.hStatus.run('afgewezen', t, h.hid);
    }
    naarVault();
    return { status: 200, body: { ok: true, status: q.s.get(s.sid).status } };
  }
  // wv2306: open koppelvoorstellen (persoon, voorval) van de verhalen van deze opname; koppelen pas na Davids Ja (besluit)
  function voorstellenVan(s) {
    if (!s || !s.delen.length || !o.verhaal || typeof o.verhaal.voorstellen !== 'function') return [];
    const hids = new Set(s.delen.map((d) => d.herinnering_id));
    let l = [];
    try { l = o.verhaal.voorstellen(); } catch (e) { fout('ml-voorstellen', e); return []; }
    return l.filter((v) => hids.has(v.herinnering_id)).map((v) => ({ id: v.id, soort: v.soort, naam: v.naam, reden: v.reden,
      doel: v.soort === 'persoon' ? path.basename(String(v.doel).replace(/^\[\[|\]\]$/g, '')) : null }));
  }
  function voorstel(id, keuze) {
    if (!o.verhaal || typeof o.verhaal.besluit !== 'function') return { status: 404, body: { ok: false, fout: 'geen verhaalmodule' } };
    return o.verhaal.besluit(id, keuze);
  }
  // Eén minuutstuk van de opname als WAV (base64 in JSON: het doorgeefluik geeft alleen JSON door). Alleen voor een actieve opname;
  // in de toonmodus alleen als hij toonbaar is (anders 403). De route zit onder het app-slot (zonder sessie 401) en het antwoord is no-store.
  function audio(hid, n, opt) {
    const h = vind(hid);
    if (!h || h.status === 'weg' || h.soort !== 'opname') return { status: 404, body: { ok: false, fout: 'onbekend' } };
    if (opt && opt.kring) return NIET_TOON;   // wv2636: de opname zelf (audio) gaat nooit naar bezoekers
    if (opt && opt.toon && !toonbaar(h)) return NIET_TOON;
    if (h.status !== 'actief') return { status: 404, body: { ok: false, fout: 'onbekend' } };   // review MOET 3
    const l = audioStukken(h), k = Number(n);
    if (!Number.isInteger(k) || l.indexOf(k) < 0) return { status: 404, body: { ok: false, fout: 'geen geluid' } };
    let b;
    try { b = fs.readFileSync(path.join(DIR, 'audio', h.ref, k + '.wav')); } catch (e) { return { status: 404, body: { ok: false, fout: 'geen geluid' } }; }
    if (b.length < 44 || b.length > 2.5 * 1024 * 1024 || b.toString('latin1', 0, 4) !== 'RIFF') return { status: 404, body: { ok: false, fout: 'geen geluid' } };
    const i = l.indexOf(k);
    return { status: 200, body: { ok: true, n: k, volgende: i + 1 < l.length ? l[i + 1] : null, stukken: l.length, mime: 'audio/wav', data: b.toString('base64') } };
  }
  // ── wv2120: foto's (Immich) ──
  function metAlbum(hid) { const h = vind(hid); return h && h.status !== 'weg' ? h : null; }
  async function fotos(hid, opt) {
    if (!F) return { status: 404, body: { ok: false, fout: 'geen Immich' } };
    const h = metAlbum(hid);
    if (!h) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    if (opt && (opt.toon || opt.kring)) {
      if (!magZien(h, opt)) return NIET_TOON;
      const u = await F.fotos(hid);
      if (u.status === 200 && u.body && u.body.album) u.body = { ok: true, toon: true, album: { status: u.body.album.status, aantal: u.body.album.aantal, gevel: u.body.album.gevel }, fotos: u.body.fotos };
      return u;
    }
    return F.fotos(hid);
  }
  // in de toonmodus alleen een foto uit het album van een toonbare herinnering
  async function foto(id, maat, opt) {
    if (!F) return { status: 404, body: { ok: false, fout: 'geen Immich' } };
    return F.foto(id, maat, opt && (opt.toon || opt.kring) ? (hid) => magZien(vind(hid), opt) : null);
  }
  // ── wv2938: video's. Alleen een id dat NU als video in een gekoppeld album staat (toonmodus/kring: van een herinnering die mag) ──
  const magVan = (opt) => (opt && (opt.toon || opt.kring) ? (hid) => magZien(vind(hid), opt) : null);
  async function videoMag(id, opt) {
    if (!F || !VID) return { status: 404, body: { ok: false, fout: 'afspelen kan nog niet op deze pod' } };
    let ok;
    try { ok = await F.isVideo(id, magVan(opt)); } catch (e) { return { status: 503, body: { ok: false, fout: 'Immich was niet bereikbaar' } }; }
    return ok ? null : { status: 404, body: { ok: false, fout: 'onbekend' } };
  }
  // stand van de afspeelbare versie (zet hem zo nodig klaar): klaar (grootte, delen) | wacht | bezig | kan-niet (reden)
  async function video(id, opt) { const n = await videoMag(id, opt); return n || { status: 200, body: Object.assign({ ok: true }, VID.stand(id, true)) }; }
  async function videoDeel(id, nr, opt) {
    const n = await videoMag(id, opt); if (n) return n;
    const d = VID.deel(id, nr);
    return d ? { status: 200, body: Object.assign({ ok: true }, d) } : { status: 404, body: { ok: false, fout: 'dit stuk is er (nog) niet' } };
  }
  // voor memorylane-publiek (altijd met kring en hid): → { stand: 'klaar', data, grootte } | { stand, reden? } | null (geen video-module)
  // review bouw ronde 2 MOET 1: alleen het album van DEZE herinnering telt, en die moet nu (nog) voor de kring zichtbaar zijn
  async function videoBestand(id, opt) {
    if (!F || !VID || !opt || !opt.kring || !opt.hid) return null;
    const h = metAlbum(opt.hid);
    if (!h || !magZien(h, opt) || !(await F.isVideo(id, (hid) => hid === opt.hid && magZien(vind(hid), opt)))) return { stand: 'kan-niet', reden: 'onbekend' };
    const s = VID.stand(id, true);
    if (s.stand !== 'klaar') return s;
    const b = VID.bestand(id);
    return b ? { stand: 'klaar', data: b, grootte: b.length } : { stand: 'kan-niet', reden: 'te groot' };
  }
  // wv2314 (R6): de gevel van één huis in de straat; in de toonmodus alleen van een toonbare herinnering (anders 404, zoals f/<id>)
  async function gevelBeeld(hid, opt) {
    const h = metAlbum(hid);
    if (!h || (opt && (opt.toon || opt.kring) && !magZien(h, opt)) || !F) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    return F.gevelBeeld(hid);
  }
  async function gevel(hid, d) { if (!F || !metAlbum(hid)) return { status: 404, body: { ok: false, fout: 'onbekend' } }; return F.gevel(hid, d); }
  async function albumMaken(hid) {
    const h = F && metAlbum(hid);
    if (!h || h.status !== 'actief') return { status: 404, body: { ok: false, fout: 'onbekend' } };
    return F.albumMaken(albumKandidaat(h));
  }
  // ── wv2366: de verteller in Davids eigen stem ──
  // Mag de verteller deze herinnering vertellen? → null of de reden (gewone taal). Actief, categorie gekozen en niet Privé, niet gevoelig,
  // niet in de toonmodus. Zelfde regel bij maken, afspelen en opruimen.
  function vertellerNiet(h, opt) {
    if (!V) return 'de verteller in je eigen stem zit niet in deze versie';
    if (opt && opt.toon) return 'niet in de toonmodus';
    if (!h || h.status !== 'actief') return 'deze herinnering is (nog) niet actief';
    const c = catVan(h);
    if (!c.categorie || c.categorie === 'prive' || isGevoelig(h)) return 'Bij Privé of gevoelig vertelt de verteller niet.';
    return null;
  }
  // de tekst die de verteller voorleest (titel + het volledige samengestelde verhaal, zoals de kamer het toont)
  function vertelTekstVan(h, pagina, s) {
    const p = pagina === undefined ? paginaLees(h.hid) : pagina;
    const x = s === undefined ? sam(h, p) : s;
    return V.tekstVan(titelVan(h, p, x), verhaalVan(h, p, x));
  }
  function vertellerKort(h, pagina, s) {
    if (!V) return null;
    const niet = vertellerNiet(h);
    const vt = niet ? { tekst: '', afgekapt: false } : vertelTekstVan(h, pagina, s);
    const st = V.stand(h.hid, vt.tekst ? V.hashVan(vt.tekst) : null);
    return Object.assign(st, { kan: niet || (vt.tekst ? null : 'er is nog geen verhaal om te vertellen'), afgekapt: vt.afgekapt,
      vooraf: !niet && vt.tekst ? V.vooraf(vt.tekst) : null });
  }
  function vertellerMaken(hid, opt) {
    const h = vind(hid);
    if (!h || h.status === 'weg' || !V) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    if (opt && opt.toon) return NIET_TOON;
    const r = vertellerNiet(h, opt);
    if (r) return { status: 409, body: { ok: false, fout: r } };
    const vt = vertelTekstVan(h);
    if (!vt.tekst) return { status: 409, body: { ok: false, fout: 'er is nog geen verhaal om te vertellen' } };
    return V.maken(h.hid, vt.tekst);
  }
  function vertellerDeel(hid, n, opt) {
    const h = vind(hid);
    if (!h || h.status === 'weg' || !V) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    if (opt && opt.toon) return NIET_TOON;
    const r = vertellerNiet(h, opt);
    if (r) { try { V.weg(h.hid); } catch (e) { fout('ml-verteller', e); } return { status: 409, body: { ok: false, fout: r } }; }   // mag niet meer: meteen weg
    const vt = vertelTekstVan(h);
    return V.deel(h.hid, n, vt.tekst ? V.hashVan(vt.tekst) : null);
  }
  // Weghalen mag altijd (ook als de herinnering intussen gevoelig werd), behalve in de toonmodus
  function vertellerWeg(hid, opt) {
    if (!V || !HID_RE.test(String(hid))) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    if (opt && opt.toon) return NIET_TOON;
    return V.weg(hid);
  }
  // ── wv2484: Als verhaal vertellen (vertelscript met audio-tags, in Davids stem) ──
  const SCHAT_FACTOR = 1.3, VERHAAL_MAX = 12000;
  // De bron van het script: titel + verhaal zoals de kamer ze toont (zonder markering en zonder de uitspraak "Zo Kef"), en de hash daarvan
  // (= de verhaalversie). → { titel, verhaal, bron, hash, afgekapt } (bron '' = niets te vertellen)
  function scriptBron(h, pagina, s) {
    const p = pagina === undefined ? paginaLees(h.hid) : pagina;
    const x = s === undefined ? sam(h, p) : s;
    const titel = titelVan(h, p, x), verhaal = verhaalVan(h, p, x);
    // wv2522: het hele verhaal (tot VERHAAL_MAX tekens), niet alleen de eerste 6.000 zoals bij voorlezen
    const vt = V.tekstVan(titel, verhaal, { uitspraak: false, max: VERHAAL_MAX });
    if (!vt.tekst) return { titel: '', verhaal: '', bron: '', hash: null, afgekapt: false, twijfel: [] };
    // review MOET 1: titel en verhaal precies uit de (afgekapte) bron, zodat wat naar Claude gaat = wat getoetst en gehasht is
    const t1 = V.tekstVan('', titel, { uitspraak: false, max: VERHAAL_MAX }).tekst;
    const metTitel = !!t1 && vt.tekst.startsWith(t1 + '\n\n');
    const tw = h.soort === 'opname' && x ? Array.from(new Set(x.delen.flatMap((d) => d.alineas.flatMap((a) => (a.twijfel || []).map((t) => t.woord))))) : [];
    return { titel: metTitel ? t1 : '', verhaal: metTitel ? vt.tekst.slice(t1.length + 2) : vt.tekst, bron: vt.tekst,
      hash: crypto.createHash('sha256').update('ml-vertelscript-1\n' + vt.tekst).digest('hex'), afgekapt: vt.afgekapt, twijfel: tw };
  }
  // het bewaarde script als het bij deze verhaalversie hoort, anders null
  function scriptActueel(h, b) { const sc = S && b.hash ? S.lees(h.hid) : null; return sc && sc.bron_hash === b.hash ? sc : null; }
  // wat David in de uitklap ziet: de woorden die in het verhaal nog ter controle staan, ook hier gemarkeerd
  function scriptToon(t, tw) {
    let u = String(t || '');
    for (const w of tw || []) { if (!w || w.length > 80) continue; const e = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); u = u.replace(new RegExp('(^|[^\\p{L}\\p{N}=])(' + e + ')(?=$|[^\\p{L}\\p{N}=])', 'gu'), '$1==$2=='); }
    return u;
  }
  function vertelVerhaalKort(h, pagina, s) {
    if (!V || !S) return null;
    const niet = vertellerNiet(h);
    const b = niet ? { bron: '', hash: null } : scriptBron(h, pagina, s);
    const sc = b.bron ? scriptActueel(h, b) : null;
    const tts = sc ? V.uitspraakVan(sc.script) : '';
    const st = V.stand(h.hid, tts ? V.hashVan(tts) : null, 'verhaal');
    const oud = !!b.bron && !sc && !!S.lees(h.hid);
    return Object.assign(st, { kan: niet || (b.bron ? null : 'er is nog geen verhaal om te vertellen'), afgekapt: !!b.afgekapt,
      vooraf: niet || !b.bron ? null : sc ? V.vooraf(tts) : V.vooraf(Math.round(b.bron.length * SCHAT_FACTOR)),
      script: sc ? { tekst: scriptToon(sc.script, b.twijfel), op: sc.op, weggelaten: sc.weggelaten || 0, terugval: !!sc.terugval, tags: sc.tags || 0 } : null,
      script_verouderd: oud,
      // review ZOU 1: wat Nieuw script ongeveer kost (nieuw script + opnieuw inspreken)
      vooraf_opnieuw: sc && !niet ? V.vooraf(Math.round(b.bron.length * SCHAT_FACTOR)) : null });
  }
  // d.opnieuw = true: ook een bewaard script opnieuw laten schrijven (Davids knop)
  function vertelVerhaalMaken(hid, d, opt) {
    const h = vind(hid);
    if (!h || h.status === 'weg' || !V || !S) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    if (opt && opt.toon) return NIET_TOON;
    const r = vertellerNiet(h, opt);
    if (r) return { status: 409, body: { ok: false, fout: r } };
    const b = scriptBron(h);
    if (!b.bron) return { status: 409, body: { ok: false, fout: 'er is nog geen verhaal om te vertellen' } };
    if (geheimRaak(b.bron)) return { status: 409, body: { ok: false, fout: 'er staat iets in dat niet naar buiten mag; de verteller vertelt dit niet' } };
    if (markerRaak([b.bron])) return { status: 409, body: { ok: false, fout: 'er staat iets in dat op een patiëntgegeven lijkt; de verteller vertelt dit niet' } };
    const sc = d && d.opnieuw === true ? null : scriptActueel(h, b);
    if (sc) return V.maken(h.hid, V.uitspraakVan(sc.script), 'verhaal');
    return V.maken(h.hid, '', 'verhaal', { tekens: Math.round(b.bron.length * SCHAT_FACTOR),
      script: async () => {
        const u = await S.schrijf(h.hid, b.titel, b.verhaal, b.hash);
        return u.ok ? { tekst: V.uitspraakVan(u.script) } : { fout: u.fout };
      } });
  }
  // ── wv2522 (David 5-11-2026 21:26, Engineer-knop: "Alles waar wat voor ingesproken wordt moet altijd direct een verhaal op gebouwd worden") ──
  // De vertelling als verhaal (script + Davids stem) komt vanzelf, zonder tik en zonder vingerafdruk. Elke AUTO_ELKE_MS in de tik hooguit één
  // aanvraag, voor een herinnering met iets ingesprokens (een opname, of een ingesproken aanvulling van David) waar de verteller mag vertellen
  // (zelfde poort als de knop: categorie gekozen, niet Privé of gevoelig, geen blok) en waarvan het verhaal af is (opname: verhaalstand klaar;
  // Davids laatste eigen stuk ≥ AUTO_RUST_MS oud). Een nieuwe verhaalversie (aanvulling, correctie) = opnieuw. Grenzen: de credit-rem (wv2751: 5 % van de
  // ElevenLabs-bundel over) en de dag- en tussentijdgrens; past het niet, dan wacht hij tot de nieuwe credits, met één box-rij per periode (nooit stil
  // overslaan). Per verhaalversie hooguit AUTO_POGINGEN aanvragen met AUTO_OPNIEUW_MS ertussen; lukt het dan niet, één box-rij.
  // Weggehaald door David = niet opnieuw tot het verhaal verandert. Uit: bestand <dir>/verteller-auto-uit. Geen tekst in box of register.
  const AUTO_ELKE_MS = 2 * 60000, AUTO_RUST_MS = 10 * 60000, AUTO_OPNIEUW_MS = 3600000, AUTO_POGINGEN = 2;
  const AUTO_UIT = path.join(DIR, 'verteller-auto-uit'), AUTO_PLAFOND = path.join(DIR, 'verteller-auto-plafond');
  let autoVorige = 0, autoLaatst = null;
  function ingesproken(h) {
    if (h.soort === 'opname') return true;
    return q.sVan.all(h.hid).some((x) => x.wie === 'david' && x.vorm === 'spraak' && x.status === 'opgenomen');
  }
  function autoBox(titel, regels) {
    if (!o.box) return;
    const t = new Date(nu()).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }).slice(0, 16);
    try { o.box('\n## [log] ' + t + ' — MemoryLane-verteller: ' + titel + ' (automatisch, wv2522)\n- status: open\n- van: pod:memorylane-delen\n' + regels.map((r) => '- ' + r + '\n').join('')); }
    catch (e) { fout('ml-vertel-auto', e); }
  }
  // review MOET 1: nooit vrije fouttekst in de box, alleen een vaste code
  function foutCode(f) {
    const t = String(f || '');
    if (!t) return 'onbekend (pod herstart?)';
    for (const [re, c] of [[/maandplafond|bundel is bijna op/, 'plafond'], [/sleutel/, 'sleutel'], [/ElevenLabs weigerde \(HTTP (\d{3})\)/, 'elevenlabs-http-$1'], [/ElevenLabs/, 'elevenlabs'],
      [/script|Claude/, 'script'], [/niet naar buiten/, 'geheim'], [/patiëntgegeven/, 'patientmarker'], [/bewaren/, 'bewaren'], [/bezig/, 'bezig']]) {
      const m = re.exec(t);
      if (m) return c.replace('$1', m[1] || '');
    }
    return 'anders';
  }
  function maandNL(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }).slice(0, 7); }
  // → null (niets gedaan) of { gestart: hid | null, wacht_plafond, open }
  function autoVertel(dwing) {
    if (!V || !S || fs.existsSync(AUTO_UIT)) return null;
    const t = nu();
    if (!dwing && t - autoVorige < AUTO_ELKE_MS) return null;
    autoVorige = t;
    const uit = { gestart: null, wacht_plafond: 0, open: 0 };
    let bundel = null;
    for (const h of q.hAlle.all()) {
      if (h.status !== 'actief' || !ingesproken(h) || vertellerNiet(h)) continue;
      const p = paginaLees(h.hid), s = sam(h, p);
      if (h.soort === 'opname' && (!s || s.stand !== 'klaar')) continue;   // het verhaal wordt nog gemaakt of bijgewerkt
      const eigen = q.sVan.all(h.hid).filter((x) => x.wie === 'david' && x.status === 'opgenomen').reduce((m, x) => Math.max(m, Date.parse(x.binnen_op) || 0), 0);
      if (eigen && t - eigen < AUTO_RUST_MS) continue;   // David vult misschien nog aan
      const b = scriptBron(h, p, s);
      if (!b.bron) continue;
      const sc = scriptActueel(h, b);
      const st = V.stand(h.hid, sc ? V.hashVan(V.uitspraakVan(sc.script)) : null, 'verhaal');
      if (st.stand === 'klaar' || st.stand === 'bezig') continue;
      const a = q.autoGet.get(h.hid), zelfde = !!a && a.hash === b.hash;
      if (zelfde && a.weg) continue;
      if (zelfde && a.pogingen >= AUTO_POGINGEN) {
        if (!a.gemeld) { autoBox('vertelling lukte niet', ['gemeten: herinnering ' + h.hid + ': ' + a.pogingen + ' automatische pogingen voor deze verhaalversie; laatste fout: ' + foutCode(st.fout) + '.',
          'voorstel: oorzaak nakijken; opnieuw proberen = rij in intake.sqlite › ml_vertel_auto weghalen (of David tikt op Als verhaal vertellen).']); q.autoGemeld.run(h.hid); }
        continue;
      }
      if (zelfde && t - Date.parse(a.op) < AUTO_OPNIEUW_MS) continue;
      uit.open++;
      if (uit.gestart) continue;
      const vo = V.vooraf(Math.round(b.bron.length * SCHAT_FACTOR));
      if (!vo.past) { uit.wacht_plafond++; bundel = vo.bundel; continue; }
      const r = vertelVerhaalMaken(h.hid, {});
      if (r.status === 202) { q.autoZet.run(h.hid, b.hash, zelfde ? a.pogingen + 1 : 1, iso(t), 0); uit.gestart = h.hid; continue; }
      if (r.body && r.body.plafond) { uit.wacht_plafond++; continue; }
      if (r.status === 429 || /bezig/.test(String(r.body && r.body.fout))) break;   // dag- of tussentijdgrens, of de verteller is bezig: volgende ronde
      // een weigering op de inhoud (geheim, patiëntmarker): niet blijven proberen, wel één box-rij
      q.autoZet.run(h.hid, b.hash, AUTO_POGINGEN, iso(t), 0);
      autoBox('vertelling geweigerd', ['gemeten: herinnering ' + h.hid + ': de pod weigerde automatisch vertellen (HTTP ' + r.status + ', ' + foutCode(r.body && r.body.fout) + ').',
        'voorstel: nakijken; de verteller vertelt deze herinnering pas weer als het verhaal verandert.']);
      q.autoGemeld.run(h.hid);
    }
    if (uit.wacht_plafond) {
      // wv2751: één box-rij per bundelperiode (credits, geen euro's)
      const bd = bundel || V.info().bundel || {};
      const m = String(bd.periode_van || maandNL(t)).slice(0, 10);
      let al = '';
      try { al = fs.readFileSync(AUTO_PLAFOND, 'utf8').trim(); } catch (e) { /* nog nooit */ }
      if (al !== m) {
        autoBox('ElevenLabs-bundel bijna op', ['gemeten: ' + uit.wacht_plafond + ' vertelling(en) als verhaal wachten op nieuwe ElevenLabs-credits (' + (V.info().bundel_tekst || '?') +
          '; de rem staat op ' + (bd.rem_procent == null ? 5 : bd.rem_procent) + ' % over); ze komen vanzelf na ' + String(bd.periode_tot || '?').slice(0, 10) + '.',
          'voorstel: wachten, of langs David de rem (rem_procent in studio/elevenlabs-bundel.json) of de bundel aanpassen.']);
        try { fs.writeFileSync(AUTO_PLAFOND, m + '\n', { mode: 0o600 }); } catch (e) { fout('ml-vertel-auto', e); }
      }
    }
    try { q.autoWeg.run(); } catch (e) { fout('ml-vertel-auto', e); }
    autoLaatst = { op: iso(t), ...uit };
    return uit;
  }
  function vertelVerhaalDeel(hid, n, opt) {
    const h = vind(hid);
    if (!h || h.status === 'weg' || !V || !S) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    if (opt && opt.toon) return NIET_TOON;
    const r = vertellerNiet(h, opt);
    if (r) { try { V.weg(h.hid, 'verhaal'); S.wis(h.hid); } catch (e) { fout('ml-verteller', e); } return { status: 409, body: { ok: false, fout: r } }; }   // mag niet meer: meteen weg
    const sc = scriptActueel(h, scriptBron(h));
    return V.deel(h.hid, n, sc ? V.hashVan(V.uitspraakVan(sc.script)) : null, 'verhaal');
  }
  // Weghalen: de vertelling als verhaal én het script (opnieuw maken = nieuw script)
  function vertelVerhaalWeg(hid, opt) {
    if (!V || !S || !HID_RE.test(String(hid))) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    if (opt && opt.toon) return NIET_TOON;
    // wv2522 (review MOET 2): haalt David de vertelling van de HUIDIGE verhaalversie weg, dan maakt de automatische vertelling hem niet opnieuw
    // tot het verhaal verandert; een verouderde vertelling weghalen houdt de nieuwe niet tegen
    let actueel = null;
    try { const h = vind(hid); const b = h && !vertellerNiet(h) ? scriptBron(h) : null; const sc = b && b.bron ? scriptActueel(h, b) : null;
      if (sc && V.stand(hid, V.hashVan(V.uitspraakVan(sc.script)), 'verhaal').stand === 'klaar') actueel = b.hash; } catch (e) { fout('ml-vertel-auto', e); }
    const u = V.weg(hid, 'verhaal');
    if (u.status === 200 && !S.wis(hid)) return { status: 503, body: { ok: false, fout: 'weghalen lukte niet; probeer het opnieuw' } };
    if (u.status === 200 && actueel) { try { q.autoZet.run(hid, actueel, 0, iso(nu()), 1); } catch (e) { fout('ml-vertel-auto', e); } }
    return u;
  }
  // ── wv2732 (David 8-11-2026, Ja op "een opname voortaan bij de bestaande herinnering zetten"; bouwplan wv2730) ──
  // Een opname over een reis of fotoalbum dat al in MemoryLane staat werd een tweede los huis met een eigen album. Nu: zodra het verhaal van
  // een actieve opname klaar is en een datum op dagniveau heeft, zoekt de pod actieve reis- en fotoalbum-herinneringen waarvan de periode
  // (dagniveau, korter dan KOPPEL_MAX_DAGEN) overlapt, ± 1 dag. Precies één kandidaat zonder stukken, niet zichtbaar gezet en zonder foto's
  // delen: die gaat op 'samengevoegd' met bij = de opname (verborgen zoals 'afgewezen'; nooit in delen, toonmodus, albumsync of vertelronde).
  // De opname krijgt zijn titel als de opname nog de standaardtitel heeft (titel_bron naamgeving; let op: nieuwe titel = nieuwe verhaalhash =
  // de automatische vertelling opnieuw), en zijn album als het album van de opname leeg is (alleen de koppelrij; in Immich verandert niets).
  // Richting: de opname blijft (verhaal, vertelling, transcript en aanvullingen hangen eraan). Twijfel (0, 2+ kandidaten of een kandidaat met
  // stukken of zichtbaar): niets samenvoegen; bij twijfel één box-rij. Per opname één beoordeling per datum (ml_koppel.sleutel); een
  // losgemaakte opname nooit opnieuw. De sleutel is periode#vingerafdruk van de raakkandidaten (hid, periode, stukken, zichtbaar): komt er een
  // reis of album bij (een reis wordt pas een herinnering als hij voorbij is), schuift een periode of verandert een kandidaat, dan opnieuw
  // (review MOET 2). Hooguit elke KOPPEL_ELKE_MS. droog = alleen zeggen wat er zou gebeuren.
  const KOPPEL_MAX_DAGEN = 31, KOPPEL_ELKE_MS = 5 * 60000;
  const KOPPEL_KLAAR = ['samengevoegd', 'losgemaakt', 'wacht'];   // niet opnieuw beoordelen (wacht = wv2932, de machinekamer houdt het paar vast)
  // wv2932 (review MOET 1): de kandidaat van een rij 'wacht' blijft ook voor andere reizen en opnames vast
  function vastgehouden() { return new Set(db.prepare("SELECT kandidaat FROM ml_koppel WHERE uitkomst = 'wacht' AND kandidaat IS NOT NULL").all().map((r) => r.kandidaat)); }
  let koppelVorige = 0;
  function dagNr(d) { return Math.round(Date.parse(String(d) + 'T00:00:00Z') / 86400000); }
  function koppelBox(regels, kop) {
    if (!o.box) return;
    const t = new Date(nu()).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }).slice(0, 16);
    try { o.box('\n## [log] ' + t + ' — MemoryLane: ' + (kop || 'opname niet vanzelf samengevoegd (twijfel, wv2732)') + '\n- status: open\n- van: pod:memorylane-delen\n' + regels.map((r) => '- ' + r + '\n').join('')); }
    catch (e) { fout('ml-koppel', e); }
  }
  function koppel(droog) {
    const uit = { samengevoegd: 0, twijfel: 0, geen: 0, acties: [] };
    if (!droog && (!kanVault() || nu() - koppelVorige < KOPPEL_ELKE_MS)) return uit;
    if (!droog) koppelVorige = nu();
    const t = iso(nu());
    let kands = null;
    const kandidaten = () => kands || (kands = q.hAlle.all().filter((c) => c.status === 'actief' && (c.soort === 'reis' || isFotoalbum(c))).map((c) => {
      const w = wanneerInfo(c, paginaLees(c.hid), null);
      if (!w.van || !w.tot || w.precisie !== 'dag') return null;
      const van = dagNr(w.van), tot = dagNr(w.tot);
      return Number.isFinite(van) && Number.isFinite(tot) && tot - van < KOPPEL_MAX_DAGEN ? { h: c, van, tot } : null;
    }).filter(Boolean));
    for (const h of q.hAlle.all()) {
      if (h.status !== 'actief' || h.soort !== 'opname') continue;
      const r = q.ramble.get(h.ref);
      if (!r || r.status !== 'notitie' || r.proef) continue;
      const k = q.koppel.get(h.hid);
      if (k && KOPPEL_KLAAR.indexOf(k.uitkomst) >= 0) continue;
      const p = paginaLees(h.hid), s = sam(h, p);
      if (!s || s.stand !== 'klaar' || !s.delen || !s.delen.length) continue;   // verhaal nog niet klaar: later opnieuw
      const w = wanneerInfo(h, p, s);
      if (!w.van || !w.tot || w.precisie !== 'dag') continue;                   // geen datum op dagniveau: later opnieuw (David kan er een zetten)
      const ov = dagNr(w.van), ot = dagNr(w.tot);
      if (!Number.isFinite(ov) || !Number.isFinite(ot) || ot - ov >= KOPPEL_MAX_DAGEN) continue;
      const rk = kandidaten().filter((c) => c.van <= ot + 1 && ov <= c.tot + 1), raak = rk.map((c) => c.h);
      const beletsel = (c) => {
        if (q.sVan.all(c.hid).some((x) => x.status !== 'weggegooid')) return 'kandidaat heeft eigen stukken';
        if (c.kring_familie === 1 || c.kring_shizzle === 1) return 'kandidaat staat zichtbaar gezet';
        if (vastgehouden().has(c.hid)) return 'kandidaat wordt vastgehouden';   // wv2932 (review MOET 1): kandidaat van een rij 'wacht'
        const kk = q.koppel.get(c.hid);   // wv2932: een reis met een samengevoegd fotoalbum (album is van dat fotoalbum; losmaken zou het niet terugvinden)
        if (kk && kk.uitkomst === 'samengevoegd') return 'kandidaat heeft al een samengevoegd fotoalbum';
        return '';
      };
      const periode = w.van + '/' + w.tot;
      const sleutel = periode + '#' + sha256(rk.map((c) => c.h.hid + '|' + c.van + '|' + c.tot + '|' + beletsel(c.h)).sort().join(';')).slice(0, 16);
      if (k && k.sleutel === sleutel) continue;                                 // al beoordeeld met deze datum en deze kandidaten
      let uitkomst = raak.length === 1 ? 'samengevoegd' : raak.length ? 'twijfel' : 'geen', reden = raak.length > 1 ? raak.length + ' kandidaten' : '';
      if (raak.length === 1) { const b = beletsel(raak[0]); if (b) { uitkomst = 'twijfel'; reden = b; } }
      uit.acties.push({ opname: h.hid, kandidaten: raak.map((c) => c.hid), uitkomst, reden });
      uit[uitkomst]++;
      if (droog) continue;
      if (uitkomst !== 'samengevoegd') {
        q.koppelZet.run(h.hid, sleutel, uitkomst, raak.length === 1 ? raak[0].hid : null, 0, 0, t);
        if (uitkomst === 'twijfel' && !(k && k.uitkomst === 'twijfel' && String(k.sleutel).split('#')[0] === periode))   // één box-rij per periode
          koppelBox(['opname ' + h.hid + ', kandidaten ' + raak.map((c) => c.hid).join(', ') + ' (' + reden + '); periode ' + periode,
          'niets samengevoegd; met de hand: python3 /opt/data/mk-scripts/wv2732/samengevoegd.py voeg <hid-weg> <hid-blijft>']);
        continue;
      }
      const c = raak[0];
      const titelNieuw = eigenTitel(h, p) ? null : titelVan(c, paginaLees(c.hid), null);
      let album = false;
      tx(() => {
        if (q.hBij.run('samengevoegd', h.hid, t, c.hid, 'actief').changes !== 1) throw new Error('kandidaat niet meer actief');
        album = F ? F.verhuis(c.hid, h.hid) : false;
        q.koppelZet.run(h.hid, sleutel, 'samengevoegd', c.hid, titelNieuw ? 1 : 0, album ? 1 : 0, t);
      });
      if (titelNieuw) {
        try { paginaZekerTitel(h, titelNieuw, 'naamgeving'); }
        catch (e) { fout('ml-koppel-titel', e); db.prepare('UPDATE ml_koppel SET titel_gezet = 0 WHERE hid = ?').run(h.hid); }
      }
      kands = kands.filter((x) => x.h.hid !== c.hid);
    }
    koppelReis(droog, uit, t);
    return uit;
  }
  // ── wv2932 (David 11-11-2026: "Memorylane: Shizzle - Versacer Revisited = Willingen, staat er 2x") ──
  // Een fotoalbum (los, google:…) van een weekend waarvoor ook een reispagina bestaat, stond als tweede huis naast de reis. Nu: valt de
  // periode uit de foto's (fotospoor van de sync: ≥ 80 % van de foto's met een dag binnen een venster van ≤ 31 dagen) binnen de dagen van
  // een voorbije reis (± 1 dag), dan gaat het fotoalbum op 'samengevoegd' met bij = de reis en krijgt de reis zijn album (alleen de koppelrij,
  // F.verhuis; in Immich verandert niets). Richting: de reis blijft (reispagina, deelnemers, Tripper). Alleen bij één duidelijk paar: de reis
  // heeft precies één zo'n fotoalbum en dat album past bij geen andere reis. Twijfel (2+ albums, album bij 2+ reizen, het album heeft eigen
  // stukken, staat zichtbaar gezet of zou zichtbaar worden voor een kring of toonmodus die het album nu niet ziet, de reis heeft al foto's):
  // niets samenvoegen; één box-rij per reisperiode. Register ml_koppel met hid = de reis, kandidaat = het fotoalbum (losmaken(album) zet het
  // album terug; die reis koppelt daarna niet opnieuw). Uitkomst 'wacht' (machinekamer, mk-scripts/wv2932/voeg.py) = niet vanzelf.
  function koppelReis(droog, uit, t) {
    if (!F) return;
    const dagIn = (d) => { const n = dagNr(d); return Number.isFinite(n) ? n : null; };
    const reizen0 = q.hAlle.all().filter((c) => c.status === 'actief' && c.soort === 'reis').map((c) => {
      const w = wanneerInfo(c, paginaLees(c.hid), null);
      if (!w.van || !w.tot || w.precisie !== 'dag') return null;
      const van = dagIn(w.van), tot = dagIn(w.tot);
      return van !== null && tot !== null && tot >= van && tot - van < KOPPEL_MAX_DAGEN ? { h: c, van, tot, periode: w.van + '/' + w.tot } : null;
    }).filter(Boolean);
    const vast = vastgehouden();
    let albums = q.hAlle.all().filter((c) => c.status === 'actief' && isFotoalbum(c) && !vast.has(c.hid)).map((c) => {
      const a = F.kort(c.hid), sp = F.spoor(c.hid);
      if (!a || a.status !== 'actief' || !(a.aantal > 0) || !sp || !sp.van || !sp.tot) return null;
      const van = dagIn(sp.van), tot = dagIn(sp.tot);
      return van !== null && tot !== null ? { h: c, a, van, tot } : null;
    }).filter(Boolean);
    const binnen = (x, r) => x.van >= r.van - 1 && x.tot <= r.tot + 1;
    const beletsel = (x, r) => {
      if (reizen0.filter((y) => binnen(x, y)).length > 1) return 'fotoalbum past bij meer reizen';
      if (q.sVan.all(x.h.hid).some((s) => s.status !== 'weggegooid')) return 'fotoalbum heeft eigen stukken';
      if (x.h.kring_familie === 1 || x.h.kring_shizzle === 1) return 'fotoalbum staat zichtbaar gezet';
      if (PKRINGEN.some((k) => magKring(r.h, k) && !magKring(x.h, k)) || (toonbaar(r.h) && !toonbaar(x.h))) return 'reis is zichtbaar waar het fotoalbum dat niet is';
      const ra = F.kort(r.h.hid);
      if (ra && ra.status === 'actief' && ra.aantal > 0) return 'reis heeft al foto\'s';
      return '';
    };
    for (const r of reizen0) {
      const k = q.koppel.get(r.h.hid);
      if (k && KOPPEL_KLAAR.indexOf(k.uitkomst) >= 0) continue;
      const raak = albums.filter((x) => binnen(x, r));
      if (!raak.length) { if (k && k.uitkomst !== 'geen' && !droog) q.koppelUitkomst.run('geen', t, r.h.hid); continue; }
      const sleutel = 'reis:' + r.periode + '#' + sha256(raak.map((x) => x.h.hid + '|' + x.van + '|' + x.tot + '|' + beletsel(x, r)).sort().join(';')).slice(0, 16);
      if (k && k.sleutel === sleutel) continue;                                 // al beoordeeld met deze periode en deze albums
      let uitkomst = raak.length === 1 ? 'samengevoegd' : 'twijfel', reden = raak.length > 1 ? raak.length + ' fotoalbums' : '';
      if (raak.length === 1) { const b = beletsel(raak[0], r); if (b) { uitkomst = 'twijfel'; reden = b; } }
      uit.acties.push({ reis: r.h.hid, fotoalbums: raak.map((x) => x.h.hid), uitkomst, reden });
      uit[uitkomst]++;
      if (droog) continue;
      if (uitkomst !== 'samengevoegd') {
        q.koppelZet.run(r.h.hid, sleutel, uitkomst, raak.length === 1 ? raak[0].h.hid : null, 0, 0, t);
        if (!(k && k.uitkomst === 'twijfel' && String(k.sleutel).split('#')[0] === sleutel.split('#')[0]))   // één box-rij per reisperiode
          koppelBox(['reis ' + r.h.hid + ', fotoalbums ' + raak.map((x) => x.h.hid).join(', ') + ' (' + reden + '); periode ' + r.periode,
            'niets samengevoegd; met de hand: python3 /opt/data/mk-scripts/wv2932/voeg.py voeg <album-hid> <reis-hid>'], 'fotoalbum niet vanzelf bij de reis gezet (twijfel, wv2932)');
        continue;
      }
      const x = raak[0];
      try {
        tx(() => {
          if (q.hBij.run('samengevoegd', r.h.hid, t, x.h.hid, 'actief').changes !== 1) throw new Error('fotoalbum niet meer actief');
          if (!q.h.get(r.h.hid) || q.h.get(r.h.hid).status !== 'actief') throw new Error('reis niet meer actief');
          if (!F.verhuis(x.h.hid, r.h.hid)) throw new Error('album niet verhuisd');   // zonder album niet samenvoegen: dan zouden de foto's verdwijnen
          q.koppelZet.run(r.h.hid, sleutel, 'samengevoegd', x.h.hid, 0, 1, t);
        });
      } catch (e) { fout('ml-koppel-reis', e); uit.samengevoegd--; uit.acties[uit.acties.length - 1].uitkomst = 'mislukt'; continue; }
      albums = albums.filter((y) => y.h.hid !== x.h.hid);
    }
  }
  // wv2732: een samengevoegde herinnering weer los (status actief, bij leeg). Kwam hij van het vanzelf koppelen, dan ook het album terug naar
  // hem en de titel van de opname terug naar de standaard (alleen als die nog de titel van de kandidaat is); die opname wordt niet opnieuw
  // vanzelf gekoppeld. Ook voor de samenvoegingen met de hand (wv2730/wv2733: alleen de status).
  function losmaken(hid) {
    const c = vind(hid);
    if (!c || c.status !== 'samengevoegd') return { status: 409, body: { ok: false, fout: 'niet samengevoegd' } };
    const h = c.bij ? q.h.get(c.bij) : null;
    const k = h ? q.koppel.get(h.hid) : null;
    const vanKoppel = !!(k && k.uitkomst === 'samengevoegd' && k.kandidaat === c.hid);
    if (vanKoppel && k.titel_gezet && !kanVault()) return { status: 503, body: { ok: false, fout: 'de Second Brain is even in onderhoud; probeer het zo opnieuw' } };
    const t = iso(nu());
    let album = false, titel = false;
    tx(() => {
      if (q.hBij.run('actief', null, t, c.hid, 'samengevoegd').changes !== 1) throw new Error('niet meer samengevoegd');
      if (vanKoppel) { if (k.album_gezet && F) album = F.terugVerhuis(h.hid, c.hid, c.soort, c.ref); q.koppelUitkomst.run('losgemaakt', t, h.hid); }
    });
    if (vanKoppel && k.titel_gezet) {
      const p = paginaLees(h.hid);
      if (fmVeld(p, 'titel_bron') === 'naamgeving' && fmVeld(p, 'titel') === titelVan(c, paginaLees(c.hid), null)) {
        try { paginaVelden(h, { titel: yaml(standaardTitel(h)), titel_bron: 'standaard' }); titel = true; } catch (e) { fout('ml-koppel-titel', e); }
      }
    }
    return { status: 200, body: { ok: true, hid: c.hid, bij: h ? h.hid : null, album, titel } };
  }
  // wv2136 (Tripper): de herinnering bij een reispagina (hid, aantal opgenomen stukken, album als status/aantal); alleen lezen, geen bijwerken()
  function reisKoppeling(rel) {
    let h = q.hRef.get('reis', String(rel));
    if (h && h.status === 'samengevoegd' && h.bij) h = q.h.get(h.bij);   // wv2732: de herinnering waarin de reis nu staat
    if (!h || h.status === 'weg') return null;
    const a = F ? F.kort(h.hid) : null;
    return { hid: h.hid, stukken: q.sVan.all(h.hid).filter((s) => s.status === 'opgenomen').length, album: a ? { status: a.status, aantal: a.aantal } : null };
  }
  // wv2449: de hoofdpersonen voor het notitieboekje (alleen Davids eigen app; in de toonmodus geweigerd)
  function hoofdpersonen(toon) {
    if (toon && toon.toon) return { status: 403, body: { ok: false, fout: 'niet in de toonmodus' } };
    const x = hoofdpersonenLees(o.vault, o.vv);
    return { status: 200, body: { ok: true, pagina: x.pagina, personen: x.personen } };
  }
  // wv2453 (Tripper): de reizen uit Davids foto's — Google-fotoalbums (los, google:…) die in MemoryLane de categorie Reizen hebben en geen
  // reispagina. Tripper toont ze per jaar naast de reispagina's. Alleen lezen (geen bijwerken(), geen album maken); titel en wanneer zoals
  // MemoryLane ze toont (Davids titel wint), album als status/aantal. Gevoelig aangevinkt = weg. Geen paden, geen tekst van de pagina.
  function fotoReizen() {
    const uit = [];
    for (const h of q.hAlle.all()) {
      if (h.status !== 'actief' || !isFotoalbum(h)) continue;
      const c = catVan(h);
      if (c.categorie !== 'reizen' || c.gevoeligVink) continue;
      const p = paginaLees(h.hid), w = wanneerInfo(h, p, null), a = F ? F.kort(h.hid) : null;
      // wv2468: spoor = wat de foto's zelf zeggen (periode en één afgerond punt, uit de foto-sync); reizen.js beslist wat telt
      const sp = F && typeof F.spoor === 'function' ? F.spoor(h.hid) : null;
      uit.push({ hid: h.hid, titel: titelVan(h, p, null), wanneer: w.tekst || '', van: w.van, tot: w.tot, precisie: w.precisie,
        stukken: q.sVan.all(h.hid).filter((s) => s.status === 'opgenomen').length, album: a ? { status: a.status, aantal: a.aantal } : null,
        spoor: sp ? { van: sp.van, tot: sp.tot, punt: sp.punt, fotos: sp.fotos, met_gps: sp.met_gps } : null });
    }
    return uit;
  }
  function info() {
    const st = Object.fromEntries(q.sTel.all().map((r) => [r.status, r.n]));
    const ks = Object.fromEntries(db.prepare('SELECT uitkomst, count(*) n FROM ml_koppel GROUP BY uitkomst').all().map((r) => [r.uitkomst, r.n]));
    return { lijst_ms: Object.assign({}, lijstDuur), herinneringen: q.hAlle.all().length, samengevoegd: q.hAlle.all().filter((h) => h.status === 'samengevoegd').length, koppel: ks, stukken: st, immich: F ? F.info() : null, video: VID ? VID.info() : null, verteller: V ? V.info() : null, vertelscript: S ? S.info() : null,
      vertel_auto: S ? { uit: fs.existsSync(AUTO_UIT), laatst: autoLaatst } : null,
      laatst };
  }
  return { lijst, detail, audio, voorstel, toonbaar: (hid) => toonbaar(vind(hid)), titel, wanneer, davidStukken, naamgeving, tekst, categorie, stukBesluit, tik, info, fotos, foto, video, videoDeel, videoBestand, gevel, gevelBeeld, albumMaken, reisKoppeling, fotoReizen,
    vertellerMaken, vertellerDeel, vertellerWeg, _V: V,
    vertelVerhaalMaken, vertelVerhaalDeel, vertelVerhaalWeg, _S: S, autoVertel,
    fotoSync, koppel, losmaken, hoofdpersonen, kring, kringVoorstelTerug, kringen, publiekLijst, magKring, tekstRaak: (l) => (l.some((t) => geheimRaak(t)) ? 'geheim' : markerRaak(l) ? 'marker' : null), _db: db, _F: F };
}

module.exports = { maak, bezoekersLees, _bezoekersTabel: bezoekersTabel, BEZOEKERS_PAGINA, PKRINGEN, wanneerUit, wanneerTekst, codeWanneer, naamVoorReis, MAP, MAX_TEKST, MAX_TITEL, HID_RE, SID_RE, _kaleOpname: kaleOpname, _schoon: schoon, HOOFD_PAGINA, _hoofdDatum: hoofdDatum, _hoofdTabel: hoofdTabel };
