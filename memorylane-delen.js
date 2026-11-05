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
 *  - Buiten de pod staat alleen wat David zichtbaar zette, in D1 `deel` (ml_item), en alleen voor een link die aan staat. De worker op
 *    deel.socev.dev/h/<slug> (socev-app deel/site/_worker.js) leest dat en schrijft bijdragen VERSLEUTELD met de publieke sleutel van de pod
 *    (ml_sleutel); alleen de pod kan ze lezen (review MOET 1). De pod haalt ze altijd op, ook als de link uit staat (MOET 2).
 *  - Gevoelig (Privé, geen categorie, vinkje) of een vastgehouden opname is nooit zichtbaar; getoetst bij de schakelaar en bij elke publicatie.
 *  - Vóór elke publicatie: geheimenpoort (hard, ook geen "toch delen"; MOET 3) en patiëntmarker (waarschuwen: David kan per inhoudshash
 *    "toch delen").
 *  - Wachtwoorden: kluis memorylane_link_familie / memorylane_link_vrienden (David zet ze in het sleutelportaal), gelezen via o.kluis op het
 *    moment van gebruik; in D1 alleen PBKDF2-SHA256 (100.000 rondes, het maximum van Workers) met eigen zout.
 *  - Haak wv2118: verhaalVoorDelen(hid) geeft nu null; met een goedgekeurd verhaal toont de deling dat in plaats van de letterlijke opname.
 *  - Foto's (wv2120): met o.immich koppelt memorylane-fotos.js elke herinnering aan een Immich-album (ml_album). Een gedeelde herinnering
 *    neemt hooguit 8 miniaturen mee naar D1 ml_foto, alleen als David foto_delen per herinnering aanzette (standaard uit).
 *  - Plaatje maken (wv2325, ontwerp § 12.1): met o.beeld maakt memorylane-plaatje.js voor een herinnering zonder foto een gegenereerd plaatje
 *    als gevel. Alleen niet-gevoelig, met categorie, geen foto, niet in de toonmodus; de pod stelt de beschrijving voor, David past hem aan.
 *  - Verteller in Davids eigen stem (wv2366): met o.eleven maakt memorylane-verteller.js op Davids tik de vertelling (ElevenLabs, eigen
 *    stem, v4) en bewaart hem op de pod. Alleen actief, categorie gekozen en niet Privé, niet gevoelig, geen blok, niet in de toonmodus.
 * PRIVACY. Nooit tekst, titels of namen in logs, box, /health of fouten: alleen ids en aantallen.
 * VORM. Alleen fs, path, crypto en reizen.js (wv2136: de reispagina's, gedeeld met Tripper); D1, kluis, marker, geheimen, vault-veilig, box en ramble-tabel komen via maak({...}).
 *
 * WV2180 (David 1-11-2026 10:02; ontwerp fase R § 16): standaard alleen de SAMENGESTELDE herinnering; de rest staat in de LOG.
 *  - Samengesteld = opname: het verhaal van herinneringen-verhaal.js (o.verhaal.samengesteld; ghostwriter, feitentoets) met Davids correcties
 *    letterlijk toegepast; reis: Davids eigen aanvullingen; los: de bijdrage zelf. Nooit het transcript.
 *  - Log (alleen in de app, alleen David): transcript, tijdcodes, wat niet lukte, correcties, eigen aanvullingen en de bijdragen van familie
 *    en vrienden (opnemen/afwijzen). Een deellink toont nooit de log: ml_item krijgt alleen titel, wanneer en het samengestelde verhaal.
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

const KRINGEN = ['familie', 'vrienden'];
const HID_RE = /^h[0-9a-f]{16}$/, SID_RE = /^s[0-9a-f]{16}$/, PUB_RE = /^[A-Za-z0-9_-]{16}$/, SLUG_RE = /^[A-Za-z0-9_-]{22}$/;
const BIJ_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const MAP = '20_Prive/Herinneringen/MemoryLane';
const ITER = 100000;
const MAX_TEKST = 5000, MAX_TITEL = 120, MAX_NAAM = 60;
const NAAM_RE = /^[\p{L}][\p{L}\p{M} .'’-]{0,59}$/u;
const KLUIS = { familie: 'memorylane_link_familie', vrienden: 'memorylane_link_vrienden' };
const HOST = 'deel.socev.dev';
const WW_ELKE_MS = 10 * 60000, CONTROLE_ELKE_MS = 10 * 60000, OPHAAL_RUST_MS = 10 * 60000, ACTIEF_MS = 3600000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ml_herinnering (hid TEXT PRIMARY KEY, soort TEXT NOT NULL, ref TEXT, categorie TEXT, gevoelig INTEGER,
  zicht_familie INTEGER NOT NULL DEFAULT 0, zicht_vrienden INTEGER NOT NULL DEFAULT 0, toon_opname INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL, aangemaakt TEXT NOT NULL, gewijzigd TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ml_herinnering_ref ON ml_herinnering (soort, ref);
CREATE TABLE IF NOT EXISTS ml_stuk (sid TEXT PRIMARY KEY, hid TEXT NOT NULL, wie TEXT NOT NULL, kring TEXT NOT NULL, vorm TEXT NOT NULL,
  soort TEXT NOT NULL, status TEXT NOT NULL, marker TEXT NOT NULL DEFAULT 'geen', sha256 TEXT NOT NULL, vault INTEGER NOT NULL DEFAULT 0,
  binnen_op TEXT NOT NULL, besluit_op TEXT, bron_id TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS ml_link (kring TEXT PRIMARY KEY, slug TEXT NOT NULL, versie INTEGER NOT NULL, aan INTEGER NOT NULL DEFAULT 0,
  zout TEXT, ww_vinger TEXT, ww_stand TEXT, aan_op TEXT, uit_op TEXT, sync INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ml_pub (kring TEXT NOT NULL, versie INTEGER NOT NULL, hid TEXT NOT NULL, pub TEXT NOT NULL UNIQUE, PRIMARY KEY (kring, versie, hid));
CREATE TABLE IF NOT EXISTS ml_d1 (kring TEXT NOT NULL, pub TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (kring, pub));
CREATE TABLE IF NOT EXISTS ml_blok (hid TEXT NOT NULL, kring TEXT NOT NULL, reden TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (hid, kring));
CREATE TABLE IF NOT EXISTS ml_marker_ok (hid TEXT NOT NULL, kring TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (hid, kring));
`;

function iso(ms) { return new Date(ms).toISOString(); }
function sha256(x) { return crypto.createHash('sha256').update(x).digest('hex'); }
function rnd(n) { return crypto.randomBytes(n); }
function b64u(b) { return Buffer.from(b).toString('base64url'); }
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
function wwNorm(w) { return String(w == null ? '' : w).normalize('NFC').trim().toLowerCase(); }   // zelfde als de worker
// asynchroon: 100.000 rondes duren ± 50–100 ms, dat blokkeert de pod niet
function pbkdf2(ww, zoutB64) {
  return new Promise(function (klaar, mis) { crypto.pbkdf2(Buffer.from(wwNorm(ww), 'utf8'), Buffer.from(zoutB64, 'base64'), ITER, 32, 'sha256', function (e, b) { if (e) mis(e); else klaar(b.toString('base64')); }); });
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
    const c = regel.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
    if (c.length < 3 || /^naam$/i.test(c[0]) || !c[0]) continue;
    const links = [];
    const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
    let m;
    while ((m = re.exec(c.slice(2).join('|'))) && links.length < 3) {
      const rel = m[1].trim().replace(/\.md$/i, '');
      if (!rel || rel.startsWith('/') || rel.split('/').some((d) => d === '..' || d === '.' || d === '')) continue;
      links.push(rel + '.md');
    }
    uit.push({ naam: c[0].slice(0, 60), rol: c[1].slice(0, 60), links });
    if (uit.length >= HOOFD_MAX) break;
  }
  return uit;
}
function hoofdpersonenLees(vault, vv) {
  let t;
  try { t = vv.lees(path.join(vault, HOOFD_PAGINA), 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return { pagina: false, personen: [] }; throw e; }
  const personen = hoofdTabel(t).map((r) => {
    let geboren = null, overleden = null;
    for (const rel of r.links) {
      const abs = path.join(vault, rel);
      if (abs.indexOf(path.join(vault, path.sep)) !== 0) continue;
      let p; try { p = vv.lees(abs, 'utf8'); } catch (e) { continue; }
      const g = hoofdDatum(fmVeld(p, 'geboortedatum')) || hoofdDatum(fmVeld(p, 'geboren'));
      if (!g) continue;
      geboren = g; overleden = hoofdDatum(fmVeld(p, 'overleden')) || hoofdDatum(fmVeld(p, 'overlijdensdatum'));
      break;
    }
    return { naam: r.naam, rol: r.rol, geboren, overleden };
  });
  return { pagina: true, personen };
}

/*
 * maak(o) → { lijst, detail, zicht, titel, tekst, categorie, toonOpname, tochDelen, stukBesluit, delenStand, link, tik, info, _db }.
 * o = { db (intake._db), vault, vv (vault-veilig), dir (/opt/data/herinneringen), d1(sql, params) → Promise<{ok, rijen}>,
 *       kluis(naam) → Promise<string|null>, marker (patientpoort: beoordeel), geheimen() → [string], categorieen (herinneringen CATEGORIEEN),
 *       onderhoudAan() → bool, nachtgrendel() → bool, nu() → ms, box(tekst), fout(label, e), host?, reisVandaag?() → 'JJJJ-MM-DD',
 *       beeld?({prompt}) → Promise<openai-hulp.beeld-uitslag> (wv2325; zonder: geen Plaatje maken) }
 */
function maak(o) {
  const nu = typeof o.nu === 'function' ? o.nu : Date.now;
  const db = o.db;
  db.exec(SCHEMA_SQL);
  const CAT = o.categorieen || {};
  const DIR = o.dir, WACHT = path.join(DIR, 'ml-wacht'), SLEUTEL = path.join(DIR, 'ml-inbox.pem');
  for (const d of [DIR, WACHT]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch (e) { /* niet van ons */ } }
  const host = o.host || HOST;
  const fout = (l, e) => { if (o.fout) o.fout(l, e); };
  // wv2120: Immich-albums per herinnering (alleen met een Immich-client)
  // (ontbreekt memorylane-fotos.js in de release, dan zonder foto's: delen werkt door)
  const F = (function () { if (!o.immich) return null; try { return require('./memorylane-fotos.js').maak({ db, immich: o.immich, nu, fout }); } catch (e) { fout('ml-fotos', e); return null; } })();
  let fotoTabel = false;
  // wv2325: gegenereerde plaatjes als gevel (alleen met o.beeld; ontbreekt memorylane-plaatje.js, dan zonder)
  const P = (function () {
    if (typeof o.beeld !== 'function') return null;
    try { return require('./memorylane-plaatje.js').maak({ db, dir: DIR, nu, fout, beeld: o.beeld, geheimRaak: (t) => geheimRaak(t), markerRaak: (l) => markerRaak(l) }); }
    catch (e) { fout('ml-plaatje', e); return null; }
  })();
  // wv2366: de verteller in Davids eigen stem (ElevenLabs via de Router; alleen met o.eleven; ontbreekt memorylane-verteller.js, dan zonder)
  const V = (function () {
    if (!o.eleven || typeof o.eleven.sleutel !== 'function') return null;
    try {
      return require('./memorylane-verteller.js').maak({ db, dir: DIR, nu, fout, sleutel: o.eleven.sleutel, routerUrl: o.eleven.routerUrl, fetch: o.eleven.fetch,
        geheimRaak: (t) => geheimRaak(t), markerRaak: (l) => markerRaak(l), klaar: o.eleven.klaar });
    } catch (e) { fout('ml-verteller', e); return null; }
  })();
  let laatsteWw = 0, laatsteControle = 0, laatsteOphaal = 0, vuil = new Set(KRINGEN), bezig = false, laatst = null, onleesbaar = 0, d1Fout = false;

  const q = {
    h: db.prepare('SELECT * FROM ml_herinnering WHERE hid = ?'),
    hRef: db.prepare('SELECT * FROM ml_herinnering WHERE soort = ? AND ref = ?'),
    hNieuw: db.prepare('INSERT INTO ml_herinnering (hid, soort, ref, categorie, gevoelig, status, aangemaakt, gewijzigd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    hAlle: db.prepare("SELECT * FROM ml_herinnering WHERE status <> 'weg' ORDER BY aangemaakt DESC, hid"),
    hStatus: db.prepare('UPDATE ml_herinnering SET status = ?, gewijzigd = ? WHERE hid = ?'),
    hZicht: { familie: db.prepare('UPDATE ml_herinnering SET zicht_familie = ?, gewijzigd = ? WHERE hid = ?'), vrienden: db.prepare('UPDATE ml_herinnering SET zicht_vrienden = ?, gewijzigd = ? WHERE hid = ?') },
    hCat: db.prepare('UPDATE ml_herinnering SET categorie = ?, gevoelig = ?, gewijzigd = ? WHERE hid = ?'),
    hToon: db.prepare('UPDATE ml_herinnering SET toon_opname = ?, gewijzigd = ? WHERE hid = ?'),
    hGewijzigd: db.prepare('UPDATE ml_herinnering SET gewijzigd = ? WHERE hid = ?'),
    s: db.prepare('SELECT * FROM ml_stuk WHERE sid = ?'),
    sBron: db.prepare('SELECT * FROM ml_stuk WHERE bron_id = ?'),
    sVan: db.prepare('SELECT * FROM ml_stuk WHERE hid = ? ORDER BY binnen_op, sid'),
    sNieuw: db.prepare('INSERT INTO ml_stuk (sid, hid, wie, kring, vorm, soort, status, marker, sha256, vault, binnen_op, bron_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)'),
    sStatus: db.prepare('UPDATE ml_stuk SET status = ?, besluit_op = ? WHERE sid = ?'),
    sVault: db.prepare('UPDATE ml_stuk SET vault = 1 WHERE sid = ?'),
    sNaarVault: db.prepare("SELECT * FROM ml_stuk WHERE vault = 0 AND status IN ('binnen', 'opgenomen', 'afgewezen') ORDER BY binnen_op"),
    sTel: db.prepare('SELECT status, count(*) n FROM ml_stuk GROUP BY status'),
    link: db.prepare('SELECT * FROM ml_link WHERE kring = ?'),
    linkNieuw: db.prepare('INSERT INTO ml_link (kring, slug, versie, aan) VALUES (?, ?, 1, 0)'),
    linkAan: db.prepare('UPDATE ml_link SET aan = ?, aan_op = CASE WHEN ? = 1 THEN ? ELSE aan_op END, uit_op = CASE WHEN ? = 0 THEN ? ELSE uit_op END WHERE kring = ?'),
    linkVernieuw: db.prepare('UPDATE ml_link SET slug = ?, versie = versie + 1, zout = NULL, ww_vinger = NULL WHERE kring = ?'),
    linkWw: db.prepare('UPDATE ml_link SET zout = ?, ww_vinger = ?, ww_stand = ? WHERE kring = ?'),
    linkWwStand: db.prepare('UPDATE ml_link SET ww_stand = ? WHERE kring = ?'),
    pub: db.prepare('SELECT pub FROM ml_pub WHERE kring = ? AND versie = ? AND hid = ?'),
    pubNieuw: db.prepare('INSERT INTO ml_pub (kring, versie, hid, pub) VALUES (?, ?, ?, ?)'),
    pubHid: db.prepare('SELECT hid FROM ml_pub WHERE kring = ? AND pub = ?'),
    d1: db.prepare('SELECT * FROM ml_d1 WHERE kring = ?'),
    d1Zet: db.prepare('INSERT INTO ml_d1 (kring, pub, hash) VALUES (?, ?, ?) ON CONFLICT (kring, pub) DO UPDATE SET hash = excluded.hash'),
    d1Weg: db.prepare('DELETE FROM ml_d1 WHERE kring = ? AND pub = ?'),
    d1Leeg: db.prepare('DELETE FROM ml_d1 WHERE kring = ?'),
    // review ZOU 1: per kring (de bijdragen die een kring ziet verschillen)
    blok: db.prepare("SELECT * FROM ml_blok WHERE hid = ? ORDER BY CASE reden WHEN 'geheim' THEN 0 ELSE 1 END, kring"),
    blokZet: db.prepare('INSERT INTO ml_blok (hid, kring, reden, hash) VALUES (?, ?, ?, ?) ON CONFLICT (hid, kring) DO UPDATE SET reden = excluded.reden, hash = excluded.hash'),
    blokWeg: db.prepare('DELETE FROM ml_blok WHERE hid = ? AND kring = ?'),
    okGet: db.prepare('SELECT hash FROM ml_marker_ok WHERE hid = ? AND kring = ?'),
    okZet: db.prepare('INSERT INTO ml_marker_ok (hid, kring, hash) VALUES (?, ?, ?) ON CONFLICT (hid, kring) DO UPDATE SET hash = excluded.hash'),
    linkSync: db.prepare('UPDATE ml_link SET sync = ? WHERE kring = ?'),
    ramble: db.prepare('SELECT ramble_id, status, categorie, herinnering_gevoelig, notitie, opgenomen_op, aangemaakt, proef FROM ramble WHERE ramble_id = ?'),
    rambles: db.prepare("SELECT ramble_id FROM ramble WHERE status = 'notitie' AND proef = 0 AND notitie IS NOT NULL"),
  };
  function tx(f) { db.exec('BEGIN IMMEDIATE'); try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { /* al weg */ } throw e; } }
  function nieuwHid() { return 'h' + rnd(8).toString('hex'); }
  function nieuwSid() { return 's' + rnd(8).toString('hex'); }

  // ── sleutelpaar van de inbox (geen toegangssleutel tot een dienst: alleen om bijdragen op Cloudflare onleesbaar te houden) ──
  let sleutel = null;
  function inbox() {
    if (sleutel) return sleutel;
    let pem = null;
    try { pem = fs.readFileSync(SLEUTEL, 'utf8'); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
    if (!pem) {
      const k = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'der' } });
      const tmp = SLEUTEL + '.' + rnd(6).toString('hex') + '.tmp';
      fs.writeFileSync(tmp, k.privateKey, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, SLEUTEL);
      pem = k.privateKey;
    }
    const priv = crypto.createPrivateKey(pem);
    const spki = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' });
    sleutel = { priv, spki: spki.toString('base64'), id: sha256(spki).slice(0, 16) };
    return sleutel;
  }
  function ontsleutel(r) {
    const k = inbox();
    if (r.sleutel_id !== k.id) return null;
    const aes = crypto.privateDecrypt({ key: k.priv, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(String(r.sleutel), 'base64'));
    const ct = Buffer.from(String(r.inhoud), 'base64'), iv = Buffer.from(String(r.iv), 'base64');
    if (aes.length !== 32 || iv.length !== 12 || ct.length < 17) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', aes, iv);
    d.setAAD(Buffer.from(r.id + '|' + r.kring + '|' + r.versie, 'utf8'));
    d.setAuthTag(ct.subarray(ct.length - 16));
    const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    return JSON.parse(pt.toString('utf8'));
  }

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
      if (h.soort === 'reis' && !gezien.has(h.ref) && !fs.existsSync(path.join(o.vault, h.ref))) { q.hStatus.run('weg', t, h.hid); vuilAlle(); }
      if (h.soort === 'opname') { const r = q.ramble.get(h.ref); if (!r || r.status !== 'notitie') { q.hStatus.run('weg', t, h.hid); vuilAlle(); } }
    }
  }
  function vuilAlle() { for (const k of KRINGEN) vuil.add(k); }

  // Categorie en gevoelig zoals ze nu gelden (opname: de ramble-rij is de bron)
  function catVan(h) {
    if (h.soort === 'opname') { const r = q.ramble.get(h.ref); return { categorie: r ? r.categorie || null : null, gevoeligVink: !!(r && r.herinnering_gevoelig) }; }
    return { categorie: h.categorie || null, gevoeligVink: !!h.gevoelig };
  }
  function isGevoelig(h) { const c = catVan(h); return !c.categorie || !CAT[c.categorie] || !!CAT[c.categorie].gevoelig || c.gevoeligVink; }
  // Mag deze herinnering naar buiten? → null of de reden (gewone taal)
  function nietDeelbaar(h) {
    if (!h || h.status !== 'actief') return h && h.status === 'voorstel' ? 'eerst opnemen' : 'niet beschikbaar';
    if (h.soort === 'opname') { const r = q.ramble.get(h.ref); if (!r || r.status !== 'notitie' || r.proef) return 'opname niet beschikbaar'; }
    const c = catVan(h);
    if (!c.categorie) return 'kies eerst een categorie';
    if (isGevoelig(h)) return 'gevoelig: nooit zichtbaar';
    return null;
  }
  // wv2120: herinneringen die een album krijgen. Vanzelf: een reis, of een andere herinnering zodra hij een categorie heeft.
  // wv2225: met het (begin)jaar waar de herinnering over gaat (voor de albumnaam "<jaar> <titel> (ML)"); null = onbekend
  function albumKandidaat(h) {
    const p = paginaLees(h.hid), s = sam(h, p), w = wanneerInfo(h, p, s);
    return { hid: h.hid, soort: h.soort, ref: h.ref, titel: titelVan(h, p, s), jaar: w.van ? String(w.van).slice(0, 4) : null, auto: h.soort === 'reis' || !!catVan(h).categorie };
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
  function titelVan(h, pagina, s) {
    const p = pagina === undefined ? paginaLees(h.hid) : pagina;
    const t = fmVeld(p, 'titel'), b = fmVeld(p, 'titel_bron');
    if (t && (b === 'david' || b === 'naamgeving' || b === 'bezoeker' || (!b && t !== oudeStandaard(h) && t !== standaardTitel(h)))) return t;
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
  function wanneerVan(h, pagina, s) { const w = wanneerInfo(h, pagina, s); return w.tekst || w.verteld; }
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
  // Haak wv2118 (R2): sinds wv2180 het samengestelde verhaal (Davids opdracht: standaard alleen de samengestelde herinnering)
  function verhaalVoorDelen(hid) { const h = vind(hid); return h ? verhaalVan(h, undefined, undefined, true) : null; }

  // Het item zoals een bezoeker van kring k het ziet: titel, wanneer en het samengestelde verhaal. NOOIT de log (transcript, correcties,
  // losse aanvullingen, bijdragen van anderen); wv2180. k telt nog mee in de hash (zelfde vorm als voorheen).
  function itemVoor(h, k) {
    const pagina = paginaLees(h.hid), s = sam(h, pagina);
    const stukken = [];
    const v = h.soort === 'opname' && !h.toon_opname ? null : verhaalVan(h, pagina, s, true);
    if (v) stukken.push({ wie: h.soort === 'los' && !isFotoalbum(h) ? 'Verteld' : 'David', soort: 'verhaal', tekst: v });
    return { titel: titelVan(h, pagina, s), wanneer: wanneerVan(h, pagina, s), stukken, kring: k };
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
  function pubVan(k, versie, hid) {
    const r = q.pub.get(k, versie, hid);
    if (r) return r.pub;
    const p = b64u(rnd(12));
    q.pubNieuw.run(k, versie, hid, p);
    return p;
  }

  async function d1(sql, params) {
    const r = await o.d1(sql, params || []);
    if (!r || !r.ok) { d1Fout = true; throw new Error('d1'); }
    return r.rijen || [];
  }

  // Wat er voor kring k buiten hoort: [{ pub, hash, item, volgorde }], en welke herinneringen geblokkeerd zijn (geheim/marker)
  function setVoor(k) {
    const L = q.link.get(k);
    if (!L || !L.aan || !L.ww_vinger) return [];
    const uit = [];
    for (const h of q.hAlle.all()) {
      if (!h['zicht_' + k] || nietDeelbaar(h)) continue;
      const item = itemVoor(h, k);
      const alle = [item.titel, item.wanneer].concat(item.stukken.map((s) => s.wie + ' ' + s.tekst)).join('\n');
      const ih = sha256(alle);
      if (geheimRaak(alle)) { q.blokZet.run(h.hid, k, 'geheim', ih); continue; }
      const ok = q.okGet.get(h.hid, k);
      if (!(ok && ok.hash === ih) && markerRaak([alle])) { q.blokZet.run(h.hid, k, 'marker', ih); continue; }
      q.blokWeg.run(h.hid, k);
      item.fotos = F ? F.voorDelen(h.hid) : [];   // wv2120: alleen asset-ids; de miniaturen haalt publiceer() op
      delete item.kring;
      uit.push({ hid: h.hid, item, sort: sorteerSleutel(h) });
    }
    uit.sort((a, b) => (a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : a.hid < b.hid ? -1 : 1));
    return uit.map((x, i) => { const pub = pubVan(k, L.versie, x.hid); const json = JSON.stringify(x.item.stukken);
      return { pub, volgorde: i, item: x.item, json, hash: sha256(L.versie + '|' + i + '|' + x.item.titel + '|' + x.item.wanneer + '|' + json + (x.item.fotos.length ? '|f' + x.item.fotos.join(',') : '')) }; });
  }

  // wv2120: D1-tabel voor de miniaturen (bestaat sinds 31-10 ook in deel/schema.sql; hier voor een D1 die hem nog niet had)
  async function zorgFotoTabel() {
    if (!F || fotoTabel) return;
    await d1('CREATE TABLE IF NOT EXISTS ml_foto (kring TEXT NOT NULL, pub TEXT NOT NULL, nr INTEGER NOT NULL, mime TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kring, pub, nr))', []);
    fotoTabel = true;
  }
  async function publiceer(k, volledig) {
    const L = q.link.get(k);
    if (!L) return 0;
    await zorgFotoTabel();
    const set = setVoor(k);
    let n = 0;
    if (L.aan && L.ww_vinger) {
      const had = new Map(q.d1.all(k).map((r) => [r.pub, r.hash]));
      for (const x of set) {
        if (had.get(x.pub) === x.hash) continue;
        await d1('INSERT INTO ml_item (kring, versie, pub, volgorde, titel, wanneer, stukken) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ' +
          'ON CONFLICT (kring, pub) DO UPDATE SET versie = excluded.versie, volgorde = excluded.volgorde, titel = excluded.titel, wanneer = excluded.wanneer, stukken = excluded.stukken',
        [k, L.versie, x.pub, x.volgorde, x.item.titel, x.item.wanneer, x.json]);
        // wv2120: foto's (of geen) bij dit item. Lukt Immich niet, dan blijft de hash staan op de oude: de volgende tik probeert het opnieuw;
        // weghalen hieronder gaat altijd door (ook als Immich weg is).
        if (F && (x.item.fotos.length || had.has(x.pub))) {
          try { await F.naarD1(d1, k, x.pub, x.item.fotos); } catch (e) { if (d1Fout) throw e; n++; continue; }
        }
        q.d1Zet.run(k, x.pub, x.hash); n++;
      }
      const moet = new Set(set.map((x) => x.pub));
      const weg = volledig ? (await d1('SELECT pub, versie FROM ml_item WHERE kring = ?1', [k])).filter((r) => !moet.has(r.pub) || r.versie !== L.versie).map((r) => r.pub)
        : [...had.keys()].filter((p) => !moet.has(p));
      for (const p of weg) { await d1('DELETE FROM ml_item WHERE kring = ?1 AND pub = ?2', [k, p]); if (fotoTabel) await d1('DELETE FROM ml_foto WHERE kring = ?1 AND pub = ?2', [k, p]); q.d1Weg.run(k, p); n++; }
      if (volledig && fotoTabel) await d1('DELETE FROM ml_foto WHERE kring = ?1 AND pub NOT IN (SELECT pub FROM ml_item WHERE kring = ?1)', [k]);
    } else {
      // link uit of geen wachtwoord: van deze kring staat niets buiten
      if (volledig || q.d1.all(k).length) { await d1('DELETE FROM ml_item WHERE kring = ?1', [k]); if (fotoTabel) await d1('DELETE FROM ml_foto WHERE kring = ?1', [k]); q.d1Leeg.run(k); }
    }
    return n;
  }

  // Wachtwoord uit de kluis → PBKDF2 in D1 als het veranderde; zonder wachtwoord blijft de link dicht
  async function wachtwoord(k) {
    const L = q.link.get(k);
    if (!L) return;
    let w = null;
    try { w = await o.kluis(KLUIS[k]); } catch (e) { fout('ml-kluis', e); q.linkWwStand.run('fout', k); return; }
    if (!w || !wwNorm(w)) {
      if (L.ww_vinger || L.ww_stand !== 'leeg') {
        await d1('UPDATE ml_link SET ww_hash = NULL, ww_zout = NULL, aan = 0 WHERE kring = ?1', [k]);
        await d1('DELETE FROM ml_sessie WHERE kring = ?1', [k]);
        q.linkWw.run(null, null, 'leeg', k); vuil.add(k);
      }
      return;
    }
    const zout = L.zout || rnd(16).toString('base64');
    const hash = await pbkdf2(w, zout);
    const vinger = sha256(zout + '|' + hash + '|' + L.versie + '|' + L.slug);
    if (vinger === L.ww_vinger) { if (L.ww_stand !== 'ok') q.linkWwStand.run('ok', k); return; }
    const nieuwZout = L.ww_vinger ? rnd(16).toString('base64') : zout;   // ander wachtwoord: ook een nieuw zout
    const h2 = nieuwZout === zout ? hash : await pbkdf2(w, nieuwZout);
    await d1('DELETE FROM ml_sessie WHERE kring = ?1', [k]);
    await linkNaarD1(k, { zout: nieuwZout, hash: h2 });
    q.linkWw.run(nieuwZout, sha256(nieuwZout + '|' + h2 + '|' + L.versie + '|' + L.slug), 'ok', k);
    vuil.add(k);
  }
  async function linkNaarD1(k, ww) {
    const L = q.link.get(k);
    await d1('INSERT INTO ml_link (kring, slug, versie, aan, ww_zout, ww_hash, ww_iter) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ' +
      'ON CONFLICT (kring) DO UPDATE SET slug = excluded.slug, versie = excluded.versie, aan = excluded.aan, ww_zout = COALESCE(excluded.ww_zout, ml_link.ww_zout), ' +
      'ww_hash = COALESCE(excluded.ww_hash, ml_link.ww_hash), ww_iter = excluded.ww_iter',
    [k, L.slug, L.versie, L.aan ? 1 : 0, ww ? ww.zout : null, ww ? ww.hash : null, ITER]);
  }
  async function sleutelNaarD1() {
    const k = inbox();
    await d1('INSERT INTO ml_sleutel (id, spki) VALUES (?1, ?2) ON CONFLICT (id) DO NOTHING', [k.id, k.spki]);
    await d1('DELETE FROM ml_sleutel WHERE id <> ?1', [k.id]);
  }

  // Bijdragen ophalen: ontsleutelen, toetsen, op de pod vastleggen, dan pas uit D1 wissen
  async function ophalen() {
    const rijen = await d1('SELECT id, kring, versie, sleutel_id, sleutel, iv, inhoud, op FROM ml_bijdrage ORDER BY op LIMIT 50', []);
    let n = 0;
    for (const r of rijen) {
      if (!BIJ_ID_RE.test(String(r.id)) || KRINGEN.indexOf(r.kring) < 0) { await d1('DELETE FROM ml_bijdrage WHERE id = ?1', [r.id]); continue; }
      if (q.sBron.get(r.id)) { await d1('DELETE FROM ml_bijdrage WHERE id = ?1', [r.id]); continue; }   // al binnen (vorige ronde stopte vóór het wissen)
      let x = null;
      try { x = ontsleutel(r); } catch (e) { x = null; }
      if (!x) { onleesbaar++; await d1('DELETE FROM ml_bijdrage WHERE id = ?1', [r.id]); continue; }
      const naam = schoon(x.naam, MAX_NAAM, false), tekst = schoon(x.tekst, MAX_TEKST, true);
      const titel = x.titel == null || x.titel === '' ? '' : schoon(x.titel, MAX_TITEL, false);
      if (!naam || !NAAM_RE.test(naam) || !tekst || titel === null) { onleesbaar++; await d1('DELETE FROM ml_bijdrage WHERE id = ?1', [r.id]); continue; }
      const vorm = x.vorm === 'spraak' ? 'spraak' : 'tekst';
      const ph = PUB_RE.test(String(x.pub || '')) ? q.pubHid.get(r.kring, x.pub) : null;
      const raak = geheimRaak(titel + '\n' + tekst) ? 'geheim' : markerRaak([titel, tekst]) ? 'raak' : 'geen';
      const sid = nieuwSid(), t = iso(nu());
      wachtZet(sid, { tekst, naam, titel_nieuw: ph ? null : (titel || 'Bijdrage van ' + naam) });
      tx(function () {
        let hid = ph ? ph.hid : null;
        if (!hid) { hid = nieuwHid(); q.hNieuw.run(hid, 'los', 'los:' + r.id, null, null, 'voorstel', t, t); }
        q.sNieuw.run(sid, hid, 'bezoeker', r.kring, vorm, ph ? 'aanvulling' : 'los', raak === 'geen' ? 'binnen' : 'vastgehouden', raak, sha256(tekst), t, r.id);
      });
      await d1('DELETE FROM ml_bijdrage WHERE id = ?1', [r.id]);
      n++;
    }
    return n;
  }
  async function telling() {
    const r = await d1("SELECT sleutel, venster, n FROM ml_poging WHERE sleutel LIKE 'link:%'", []);
    const uit = {};
    const uur = Math.floor(nu() / 3600000) * 3600000;   // de worker bewaart het begin van het venster in ms
    for (const x of r) { const k = String(x.sleutel).slice(5); if (KRINGEN.indexOf(k) >= 0 && Number(x.venster) === uur && Number(x.n) >= 20) uit[k] = true; }
    return uit;
  }
  let dicht = {};

  async function tik() {
    if (bezig) return { bezig: true };
    bezig = true;
    const uit = { vault: 0, bijdragen: 0, d1: 0 };
    try {
      bijwerken();
      if (P) { try { P.opruim((hid) => !!q.h.get(hid)); } catch (e) { fout('ml-plaatje', e); } }
      if (V) { try { V.opruim((hid) => { const h = q.h.get(hid); return !!h && !vertellerNiet(h); }); } catch (e) { fout('ml-verteller', e); } }   // wv2366 (review MOET 2)
      uit.vault = naarVault();
      if (F) { try { const f = await fotoSync(false); if (f && (f.nieuw || f.overgenomen || f.weg || f.deel)) { uit.albums = f.nieuw + f.overgenomen; vuilAlle(); } } catch (e) { fout('ml-immich', e); } }
      if (!o.d1) return uit;
      d1Fout = false;
      const t = nu();
      const iemandAan = KRINGEN.some((k) => { const L = q.link.get(k); return L && (L.aan || (L.uit_op && t - Date.parse(L.uit_op) < ACTIEF_MS)); });
      try {
        if (t - laatsteOphaal >= (iemandAan ? 0 : OPHAAL_RUST_MS)) { laatsteOphaal = t; uit.bijdragen = await ophalen(); if (uit.bijdragen) uit.vault += naarVault(); }
        const controle = t - laatsteControle >= CONTROLE_ELKE_MS;
        if (controle) { laatsteControle = t; await sleutelNaarD1(); dicht = await telling(); }
        for (const k of KRINGEN) { const L = q.link.get(k); if (L && !L.sync) await syncLink(k); }
        for (const k of KRINGEN) {
          const L = q.link.get(k);
          if (L && L.aan && (t - laatsteWw >= WW_ELKE_MS || !L.ww_vinger)) await wachtwoord(k);
        }
        if (t - laatsteWw >= WW_ELKE_MS) laatsteWw = t;
        for (const k of KRINGEN) if (controle || vuil.has(k) || (q.link.get(k) || {}).aan) { uit.d1 += await publiceer(k, controle); vuil.delete(k); }
      } catch (e) { if (!d1Fout) fout('ml-tik', e); uit.fout = d1Fout ? 'd1' : 'tik'; }
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
      zicht: { familie: false, vrienden: false }, album: k.album ? { status: k.album.status, aantal: k.album.aantal } : null, plaatje: !!k.plaatje, plaatje_kan: false };
  }
  function kort(h, pagina, s) {
    const p = pagina === undefined ? paginaLees(h.hid) : pagina;
    const x = s === undefined ? sam(h, p) : s;
    const st = q.sVan.all(h.hid), c = catVan(h), b = q.blok.all(h.hid)[0], w = wanneerInfo(h, p, x);
    return { ...facetten(x), audio: audioStukken(h).length, hid: h.hid, soort: h.soort, bron: isFotoalbum(h) ? 'google' : null, status: h.status, titel: titelVan(h, p, x), wanneer: w.tekst || w.verteld, wanneer_bron: w.bron, wanneer_invoer: w.invoer,
      verteld: w.verteld, datum: sorteerSleutel(h, w), categorie: c.categorie, gevoelig: isGevoelig(h), gevoelig_vink: c.gevoeligVink,
      zicht: { familie: !!h.zicht_familie, vrienden: !!h.zicht_vrienden },
      toon_opname: !!h.toon_opname, niet_deelbaar: nietDeelbaar(h), blok: b ? b.reden : null,
      verhaal_stand: h.soort === 'opname' ? (x ? x.stand : null) : null,
      stukken: st.filter((y) => y.status !== 'weggegooid').length, binnen: st.filter((y) => y.status === 'binnen').length,
      vastgehouden: st.filter((y) => y.status === 'vastgehouden').length, album: F ? F.kort(h.hid) : null,
      plaatje: P ? P.heeft(h.hid) : false, plaatje_kan: !plaatjeNiet(h) };
  }
  // opt.toon (wv2306): de toonmodus van dit apparaat staat aan → alleen toonbare herinneringen, ingekort; geen gevoelige categorie in de lijst
  function lijst(opt) {
    const toon = !!(opt && opt.toon);
    bijwerken();
    const alle = q.hAlle.all().filter((h) => h.status !== 'afgewezen' && (!toon || toonbaar(h))).map((h) => (toon ? toonKort(kort(h)) : kort(h)));
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
    if (opt && opt.toon) {
      if (!toonbaar(h)) return NIET_TOON;
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
    return { status: 200, body: { ok: true, herinnering: uit } };
  }
  function zicht(hid, d) {
    const h = vind(hid), k = d && d.kring;
    if (!h) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    if (KRINGEN.indexOf(k) < 0 || typeof d.aan !== 'boolean') return { status: 400, body: { ok: false, fout: 'kring en aan' } };
    if (d.aan) { const r = nietDeelbaar(h); if (r) return { status: 409, body: { ok: false, fout: r } }; }
    q.hZicht[k].run(d.aan ? 1 : 0, iso(nu()), h.hid);
    vuil.add(k);
    return { status: 200, body: { ok: true, herinnering: kort(q.h.get(h.hid)) } };
  }
  function titel(hid, d) {
    const h = vind(hid);
    if (!h) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    const t = schoon(d && d.titel, MAX_TITEL, false);
    if (!t) return { status: 400, body: { ok: false, fout: 'titel 1–' + MAX_TITEL + ' tekens' } };
    if (!kanVault()) return { status: 503, body: { ok: false, fout: 'de Second Brain is even in onderhoud; probeer het zo opnieuw' } };
    paginaZekerTitel(h, t, 'david');
    q.hGewijzigd.run(iso(nu()), h.hid); vuilAlle();
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
    q.hGewijzigd.run(iso(nu()), h.hid); vuilAlle();
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
    q.hGewijzigd.run(iso(nu()), h.hid); vuilAlle();
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
    naarVault(); vuilAlle();
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
    if (gev) for (const k of KRINGEN) q.hZicht[k].run(0, iso(nu()), h.hid);   // gevoelig = meteen nergens meer zichtbaar
    vuilAlle();
    return { status: 200, body: { ok: true, herinnering: kort(q.h.get(h.hid)) } };
  }
  function toonOpname(hid, d) {
    const h = vind(hid);
    if (!h || h.soort !== 'opname') return { status: 404, body: { ok: false, fout: 'onbekend' } };
    q.hToon.run(d && d.aan ? 1 : 0, iso(nu()), h.hid); vuilAlle();
    return { status: 200, body: { ok: true, herinnering: kort(q.h.get(h.hid)) } };
  }
  // David deelt een herinnering waarop de patiëntmarker raak was toch (verse vingerafdruk in server.js); geldt voor precies deze inhoud
  function tochDelen(hid) {
    const h = vind(hid), b = h ? q.blok.all(h.hid) : [];
    if (!h || !b.length) return { status: 404, body: { ok: false, fout: 'niets tegengehouden' } };
    if (b.some((x) => x.reden === 'geheim')) return { status: 409, body: { ok: false, fout: 'er staat een sleutel of wachtwoord in; haal dat eerst weg' } };
    tx(function () { for (const x of b) { q.okZet.run(h.hid, x.kring, x.hash); q.blokWeg.run(h.hid, x.kring); } q.hGewijzigd.run(iso(nu()), h.hid); });
    vuilAlle();
    return { status: 200, body: { ok: true } };
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
    naarVault(); vuilAlle();
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
    if (opt && opt.toon) {
      if (!toonbaar(h)) return NIET_TOON;
      const u = await F.fotos(hid);
      if (u.status === 200 && u.body && u.body.album) u.body = { ok: true, toon: true, album: { status: u.body.album.status, aantal: u.body.album.aantal, gevel: u.body.album.gevel }, fotos: u.body.fotos };
      return u;
    }
    return F.fotos(hid);
  }
  // in de toonmodus alleen een foto uit het album van een toonbare herinnering
  async function foto(id, maat, opt) {
    if (!F) return { status: 404, body: { ok: false, fout: 'geen Immich' } };
    return F.foto(id, maat, opt && opt.toon ? (hid) => toonbaar(vind(hid)) : null);
  }
  // wv2314 (R6): de gevel van één huis in de straat; in de toonmodus alleen van een toonbare herinnering (anders 404, zoals f/<id>)
  // wv2325: zonder foto-gevel het gegenereerde plaatje (in de toonmodus alleen bij een toonbare); heeft het album foto's, dan wint de foto
  async function gevelBeeld(hid, opt) {
    const h = metAlbum(hid);
    if (!h || (opt && opt.toon && !toonbaar(h)) || (!F && !P)) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    const plaatje = () => { const b = P ? P.beeld(h.hid) : null; return b ? { status: 200, body: { ok: true, mime: b.mime, data: b.data, plaatje: true } } : null; };
    if (!F || !heeftFoto(h)) return plaatje() || (F ? F.gevelBeeld(hid) : { status: 404, body: { ok: false, fout: 'geen gevel' } });
    const u = await F.gevelBeeld(hid);
    return u.status === 404 ? plaatje() || u : u;
  }
  async function gevel(hid, d) { if (!F || !metAlbum(hid)) return { status: 404, body: { ok: false, fout: 'onbekend' } }; const u = await F.gevel(hid, d); if (u.status === 200) vuilAlle(); return u; }
  async function fotoDelen(hid, d) {
    const h = F && metAlbum(hid);
    if (!h) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    const u = await F.fotoDelen(hid, d);
    if (u.status === 200) vuilAlle();
    return u;
  }
  async function albumMaken(hid) {
    const h = F && metAlbum(hid);
    if (!h || h.status !== 'actief') return { status: 404, body: { ok: false, fout: 'onbekend' } };
    return F.albumMaken(albumKandidaat(h));
  }
  // ── wv2325: Plaatje maken (ontwerp § 12.1) ──
  // Heeft de herinnering een foto (album met ≥ 1 foto)? Dan geen plaatje: de foto wint.
  function heeftFoto(h) { const a = F ? F.kort(h.hid) : null; return !!(a && a.status === 'actief' && a.aantal > 0); }
  // Mag er een plaatje voor deze herinnering gemaakt worden? → null of de reden (gewone taal). Zelfde regels als delen (actief, categorie,
  // niet gevoelig, opname met notitie en geen proef), plus: geen foto, niet in de toonmodus.
  function plaatjeNiet(h, opt) {
    if (!P) return 'plaatjes maken zit niet in deze versie';
    if (opt && opt.toon) return 'niet in de toonmodus';
    const r = nietDeelbaar(h);
    if (r) return r === 'gevoelig: nooit zichtbaar' ? 'gevoelig: geen plaatje' : r;
    if (heeftFoto(h)) return 'er is al een foto';
    return null;
  }
  function plaatjeVoorstel(hid, opt) {
    const h = vind(hid);
    if (!h || h.status === 'weg') return { status: 404, body: { ok: false, fout: 'onbekend' } };
    if (opt && opt.toon) return NIET_TOON;
    const r = plaatjeNiet(h, opt);
    if (r) return { status: 409, body: { ok: false, fout: r } };
    const p = paginaLees(h.hid), s = sam(h, p), w = wanneerInfo(h, p, s);
    return P.voorstel({ soort: isFotoalbum(h) ? 'fotoalbum' : h.soort, jaar: w.van ? String(w.van).slice(0, 4) : null, titel: titelVan(h, p, s) });
  }
  async function plaatjeMaken(hid, d, opt) {
    const h = vind(hid);
    if (!h || h.status === 'weg') return { status: 404, body: { ok: false, fout: 'onbekend' } };
    if (opt && opt.toon) return NIET_TOON;
    const r = plaatjeNiet(h, opt);
    if (r) return { status: 409, body: { ok: false, fout: r } };
    const u = await P.maak(h.hid, d);
    if (u.status === 200) u.body.herinnering = kort(q.h.get(h.hid));
    return u;
  }
  // Weghalen mag altijd (ook als de herinnering intussen gevoelig werd of een foto kreeg), behalve in de toonmodus
  function plaatjeWeg(hid, opt) {
    const h = vind(hid);
    if (!h || !P) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    if (opt && opt.toon) return NIET_TOON;
    const u = P.weg(h.hid);
    if (u.status === 200 && h.status !== 'weg') u.body.herinnering = kort(q.h.get(h.hid));
    return u;
  }
  // ── wv2366: de verteller in Davids eigen stem ──
  // Mag de verteller deze herinnering vertellen? → null of de reden (gewone taal). Actief, categorie gekozen en niet Privé, niet gevoelig,
  // geen blok (geheim of patiëntmarker gezien), niet in de toonmodus. Zelfde regel bij maken, afspelen en opruimen.
  function vertellerNiet(h, opt) {
    if (!V) return 'de verteller in je eigen stem zit niet in deze versie';
    if (opt && opt.toon) return 'niet in de toonmodus';
    if (!h || h.status !== 'actief') return 'deze herinnering is (nog) niet actief';
    const c = catVan(h);
    if (!c.categorie || c.categorie === 'prive' || isGevoelig(h)) return 'Bij Privé of gevoelig vertelt de verteller niet.';
    if (q.blok.all(h.hid).length) return 'Hier vertelt de verteller niet: er staat iets in dat niet naar buiten mag.';
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
  function zorgLink(k) { if (!q.link.get(k)) q.linkNieuw.run(k, b64u(rnd(16)).slice(0, 22)); return q.link.get(k); }
  function delenStand() {
    const links = KRINGEN.map((k) => {
      const L = zorgLink(k);
      return { kring: k, aan: !!L.aan, url: 'https://' + host + '/h/' + L.slug, wachtwoord: L.ww_stand === 'ok' ? 'gezet' : L.ww_stand === 'fout' ? 'onbekend' : L.aan ? 'ontbreekt' : 'onbekend',
        dicht: !!dicht[k], zichtbaar: q.hAlle.all().filter((h) => h['zicht_' + k] && !nietDeelbaar(h) && !q.blok.all(h.hid).some((b) => b.kring === k)).length, kluisnaam: KLUIS[k],
        buiten_bijgewerkt: !!L.sync };
    });
    return { status: 200, body: { ok: true, links, laatst: laatst ? laatst.op : null, d1_fout: d1Fout } };
  }
  // aan (verse vingerafdruk in server.js), uit, vernieuw. De lokale stand gaat meteen om en krijgt sync = 0; syncLink zet D1 recht. Lukt
  // dat niet (D1 onbereikbaar), dan herhaalt elke tik het tot het lukt en toont de app "buiten nog niet bijgewerkt" (review MOET 4).
  async function link(k, actie) {
    if (KRINGEN.indexOf(k) < 0) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    zorgLink(k);
    const t = iso(nu());
    if (actie === 'aan') q.linkAan.run(1, 1, t, 1, null, k);
    else if (actie === 'uit') q.linkAan.run(0, 0, null, 0, t, k);
    else if (actie === 'vernieuw') q.linkVernieuw.run(b64u(rnd(16)).slice(0, 22), k);
    else return { status: 400, body: { ok: false, fout: 'onbekende keuze' } };
    q.linkSync.run(0, k);
    vuil.add(k);
    if (o.d1) {
      try { await syncLink(k); }
      catch (e) { if (!d1Fout) fout('ml-link', e); return { status: 502, body: { ok: false, fout: 'de deelpagina was niet bereikbaar; de server zet hem zo recht (tot dan staat hij buiten nog in de oude stand)', stand: delenStand().body } }; }
    }
    return delenStand();
  }
  async function syncLink(k) {
    const L = q.link.get(k);
    await zorgFotoTabel();
    if (!L.aan) { if (await ophalen()) naarVault(); }   // MOET 2: eerst leeghalen
    await d1('DELETE FROM ml_sessie WHERE kring = ?1 AND versie <> ?2', [k, L.versie]);
    if (!L.aan) {
      await d1('UPDATE ml_link SET aan = 0 WHERE kring = ?1', [k]);
      await d1('DELETE FROM ml_sessie WHERE kring = ?1', [k]);
      await d1('DELETE FROM ml_item WHERE kring = ?1', [k]); if (fotoTabel) await d1('DELETE FROM ml_foto WHERE kring = ?1', [k]); q.d1Leeg.run(k);
    }
    await linkNaarD1(k, null);
    if (L.aan) { await sleutelNaarD1(); await wachtwoord(k); }
    await publiceer(k, true);
    q.linkSync.run(1, k);
    vuil.delete(k);
  }
  // wv2136 (Tripper): de herinnering bij een reispagina (hid, aantal opgenomen stukken, album als status/aantal); alleen lezen, geen bijwerken()
  function reisKoppeling(rel) {
    const h = q.hRef.get('reis', String(rel));
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
  function info() {
    const st = Object.fromEntries(q.sTel.all().map((r) => [r.status, r.n]));
    return { herinneringen: q.hAlle.all().length, stukken: st, immich: F ? F.info() : null, plaatjes: P ? P.info() : null, verteller: V ? V.info() : null, links: KRINGEN.map((k) => { const L = q.link.get(k); return { kring: k, aan: !!(L && L.aan), wachtwoord: L ? L.ww_stand || null : null }; }),
      laatst, d1_fout: d1Fout, onleesbaar };
  }
  return { lijst, detail, audio, voorstel, toonbaar: (hid) => toonbaar(vind(hid)), zicht, titel, wanneer, davidStukken, naamgeving, tekst, categorie, toonOpname, tochDelen, stukBesluit, delenStand, link, tik, info, fotos, foto, gevel, gevelBeeld, fotoDelen, albumMaken, reisKoppeling,
    plaatjeVoorstel, plaatjeMaken, plaatjeWeg, _P: P, vertellerMaken, vertellerDeel, vertellerWeg, _V: V,
    fotoSync, hoofdpersonen, _db: db, _setVoor: setVoor, _F: F,
    _inbox: inbox, _verhaalVoorDelen: verhaalVoorDelen };
}

module.exports = { maak, wanneerUit, wanneerTekst, codeWanneer, naamVoorReis, KRINGEN, KLUIS, MAP, ITER, MAX_TEKST, MAX_TITEL, MAX_NAAM, HID_RE, SID_RE, _pbkdf2: pbkdf2, _wwNorm: wwNorm, _kaleOpname: kaleOpname, _schoon: schoon, HOOFD_PAGINA, _hoofdDatum: hoofdDatum, _hoofdTabel: hoofdTabel };
