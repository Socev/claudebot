'use strict';
// concept-leer.js — Socev leert van wat David aan zijn mailconcepten verandert (wv4107, besluitenpagina nr 406 = 3C106, David Ja 25-11-2026 21:46)
// en de knop "Vervang mijn concept" (nr 473 = 3C173, Ja met vingerafdruk 21:48). Ontwerp + Codex-ontwerpreview: mk-scripts/wv4107/ontwerp.md.
// WAAROM. Het conceptregister bewaart alleen een hash, en Gmail breekt verzonden tekst om op ± 76 tekens: "ongewijzigd" was niet eens te meten
// (gemeten 27-11: hetzelfde concept kwam verzonden terug met een andere hash). Davids aanpassingen zijn de meest directe stijlcorrectie die er is;
// hij hoeft ze dan niet meer te typen. En een nieuwe versie in een draad met een onbewerkt Socev-concept kostte een omweg via Gmail.
// WAT.
// - bewaar(): concepttekst 30 dagen op de pod (sqlite 0600, secure_delete, buiten de vault). Ingangen: het voorwerk in Mail en de chatroute
//   (/smal/mailconcept opdracht register, concepthulp.py).
// - ronde(): per bewaard concept de draad lezen (lees-luik mail_gesprek). Eerste SENT-bericht na het concept → citaat en handtekening eraf →
//   ongewijzigd / aangepast / niet_verstuurd. Uitkomst = één regel in conceptregister-uitkomst.jsonl (naast het register; geen tekst).
// - wijzigingen(): deterministisch (geen model) en tekstvrij (Codex wv4107 MOET 1): aanhef (naam → <naam>), groet (alleen uit een vaste lijst),
//   slotzin_weg, korter, je_u; elk met een sleutel zonder mailtekst.
// - kaart(): hooguit één Voor jou-kaart per ISO-week, alleen als dezelfde sleutel in ≥ 4 verschillende aangepaste concepten (30 dagen) staat en
//   nog niet eerder is voorgelegd. Ja = de pod zet precies de bevroren regel in het correctiebestand (nr 318); Nee = nooit meer deze.
// - vervangKan() / vervangKaart() / vervangKnop(): alleen met registerrij mailconcept-vervang op aan (toestemmingen.json); een eigen, onbewerkt
//   concept (tekst gelijk aan wat de pod bewaarde, precies één concept in de draad) → kaart "weghalen en vervangen?"; Ja met verse
//   vingerafdruk → de pod haalt het oude weg (n8n toetst draad en tekst opnieuw) en zet de nieuwe versie in de draad.
// Nooit mailtekst in logs, box of /health: alleen aantallen. Alles naar buiten (luik, concept, vervang, register, kaarten) komt van server.js (io).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAG = 86400000;
const BEWAAR_MS = 30 * DAG, KAART_GEHEUGEN_MS = 180 * DAG, VERVANG_MS = 3 * DAG;
const RONDE_MAX = 10, OPNIEUW_MS = 6 * 3600000, MIN_LEEFTIJD_MS = 15 * 60000, MARGE_MS = 30000;
const PATROON_MIN = 4, GELIJK_MIN = 0.35, KORTER = 0.7, TEKST_MAX = 20000, REGEL_MAX = 300;
const SLEUTEL_RE = /^mailstem-leer-\d{4}-\d{2}$/;
const VERVANG_RE = /^mailconcept-vervang-[0-9a-f]{12}$/;
const VERVANG_RIJ = 'mailconcept-vervang';
const SOORT_VOLGORDE = ['groet', 'aanhef', 'slotzin_weg', 'je_u', 'korter'];
const sha = function (t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); };
const isObj = function (x) { return !!x && typeof x === 'object' && !Array.isArray(x); };

// ── puur: tekst schoonmaken en vergelijken ──
const AANHEF_RE = /^(ha|hoi|hey|hi|hallo|beste|geachte|goedemorgen|goedemiddag|goedenavond|dag|lieve|lief|dear|hello)\b/i;
const GROET_RE = /^(groet|groeten|groetjes|hartelijke groet|vriendelijke groet|met vriendelijke groet|met hartelijke groet|met collegiale groet|mvg|gr\.?|dank|dank je|dankjewel|bedankt|alvast bedankt|liefs|x|-x-|kus|regards|best|cheers|tot snel|tot dan|fijne dag|fijn weekend)\b[^\n]{0,30}$/i;
const CITAAT_KOP = [/^\s*>/, /^(op|on)\s.{0,200}(schreef|wrote)/i, /^-{3,}\s*(forwarded|doorgestuurd|oorspronkelijk|original)/i, /^-{5,}/, /^_{5,}/,
  /^(van|from)\s*:\s/i, /^verzonden\s*:\s/i];
const HANDTEKENING_RE = /kvk|www\.|https?:\/\/|\btel\b|telefoon|\+31|\b0\d{1,3}[- ]?\d{6,8}\b|huisartsenpraktijk|praktijk[a-z]*\s*:|@/i;

function regels(t) { return String(t == null ? '' : t).replace(/\r\n?/g, '\n').split('\n'); }
// Citaat eraf: vanaf de eerste citaatkop, ook "Op do 26 nov 2026 om 08:36 schreef X" afgebroken over twee regels (Gmail breekt op ± 76).
function zonderCitaat(t) {
  const r = regels(t);
  for (let i = 0; i < r.length; i++) {
    const a = r[i].trim(), ab = (a + ' ' + (r[i + 1] || '').trim()).trim();
    if (CITAAT_KOP.some(function (re) { return re.test(a); })) return r.slice(0, i).join('\n');
    if (/^(op|on)\s/i.test(a) && /(schreef|wrote)[^\n]*:\s*$/i.test(ab) && !/(schreef|wrote)/i.test(a)) return r.slice(0, i).join('\n');
  }
  return r.join('\n');
}
// Handtekening eraf: vanaf een "-- "-regel; en (alleen als `concept` gegeven is) een slotalinea met KvK/www/telefoon die niet in het concept staat.
function zonderHandtekening(t, concept) {
  let r = regels(t);
  const sd = r.findIndex(function (x) { return x === '-- ' || x === '--'; });
  if (sd >= 0) r = r.slice(0, sd);
  let s = r.join('\n').replace(/\s+$/, '');
  if (concept != null) {
    const alineas = s.split(/\n\s*\n/), cn = plat(concept);
    while (alineas.length > 1) {
      const laatste = alineas[alineas.length - 1];
      if (HANDTEKENING_RE.test(laatste) && cn.indexOf(plat(laatste)) < 0) alineas.pop(); else break;
    }
    s = alineas.join('\n\n');
  }
  return s;
}
function adressen(t) { return Array.from(new Set((String(t || '').toLowerCase().match(/[^\s<>",;:()]+@[^\s<>",;:()]+\.[a-z]{2,}/g) || []))).sort(); }
function plat(t) { return String(t == null ? '' : t).replace(/\s+/g, ' ').trim(); }
function schoon(t, concept) { return zonderHandtekening(zonderCitaat(t), concept); }
function woorden(t) { return plat(t).toLowerCase().split(' ').filter(Boolean); }
// LCS-ratio op woorden (2·lcs / (a+b)); begrensd op 1500 woorden per kant.
function gelijkenis(a, b) {
  const x = woorden(a).slice(0, 1500), y = woorden(b).slice(0, 1500);
  if (!x.length && !y.length) return 1;
  if (!x.length || !y.length) return 0;
  let vorige = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const nu = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) nu[j] = x[i - 1] === y[j - 1] ? vorige[j - 1] + 1 : Math.max(vorige[j], nu[j - 1]);
    vorige = nu;
  }
  return Math.round((2 * vorige[y.length] / (x.length + y.length)) * 1000) / 1000;
}
// Opbouw van een mail: aanhef (eerste regel als die zo begint), groet (slotregel, eventueel gevolgd door één naamregel), romp ertussen.
function opbouw(t) {
  const r = regels(t).map(function (x) { return x.trim(); }).filter(function (x, i, a) { return x || (i > 0 && a[i - 1]); });
  while (r.length && !r[r.length - 1]) r.pop();
  while (r.length && !r[0]) r.shift();
  let aanhef = '', groet = '', b = 0, e = r.length;
  if (r.length && AANHEF_RE.test(r[0]) && r[0].length <= 60) { aanhef = r[0]; b = 1; }
  for (let i = e - 1; i >= Math.max(b, e - 3); i--) {
    if (GROET_RE.test(r[i]) && r[i].length <= 40) { groet = r[i]; e = i; break; }
  }
  return { aanhef, groet, romp: r.slice(b, e).join('\n').trim() };
}
function aanhefVorm(a) {
  const m = AANHEF_RE.exec(a);
  if (!m) return '';
  const rest = a.slice(m[0].length).trim(), slot = /[,!:.]$/.test(rest) ? rest.slice(-1) : '';
  return m[0].toLowerCase() + (rest.replace(/[,!:.]$/, '').trim() ? ' <naam>' : '') + slot;
}
// Codex wv4107 MOET 1: alleen tekstvrije stijlsoorten; een groet telt alleen als hij precies in deze vaste lijst staat (nooit een naam of zin)
const GROETEN = new Set(['groet', 'groeten', 'groetjes', 'hartelijke groet', 'hartelijke groeten', 'vriendelijke groet', 'vriendelijke groeten',
  'met vriendelijke groet', 'met vriendelijke groeten', 'met hartelijke groet', 'met hartelijke groeten', 'met collegiale groet', 'mvg', 'gr', 'dank',
  'dank je', 'dank je wel', 'dankjewel', 'bedankt', 'alvast bedankt', 'liefs', 'x', '-x-', 'kus', 'regards', 'best', 'cheers', 'tot snel', 'tot dan',
  'fijne dag', 'fijn weekend', 'hgr', 'groetjes en fijn weekend', 'fijne avond']);
function groetVorm(g) { const k = plat(g).toLowerCase().replace(/[,.!]+$/, '').trim(); return GROETEN.has(k) ? plat(g).replace(/\s*$/, '') : ''; }
function zinnen(t) {
  return plat(t).split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý0-9"'(])/).map(function (z) { return z.trim(); }).filter(Boolean);
}
function zinSleutel(z) { return plat(z).toLowerCase().replace(/[“”"']/g, '').replace(/\s*[.!?]+$/, ''); }
function jeU(t) {
  const w = woorden(t).map(function (x) { return x.replace(/[^a-zà-ÿ]/g, ''); });
  const u = w.filter(function (x) { return x === 'u' || x === 'uw'; }).length, je = w.filter(function (x) { return ['je', 'jij', 'jou', 'jouw', 'jullie'].indexOf(x) >= 0; }).length;
  return u > je ? 'u' : je > u ? 'je' : '';
}
// → [{ soort, sleutel, oud?, nieuw? }] (alleen bij aangepast). oud/nieuw = korte vorm voor de kaart (aanhef/groet/zin), nooit een hele mail.
function wijzigingen(concept, verzonden) {
  const c = opbouw(concept), v = opbouw(verzonden), uit = [];
  const ca = aanhefVorm(c.aanhef), va = aanhefVorm(v.aanhef);
  if (ca && va && ca !== va) uit.push({ soort: 'aanhef', sleutel: 'aanhef:' + ca + '→' + va, oud: ca, nieuw: va });
  const cg = groetVorm(c.groet), vg = groetVorm(v.groet);
  if (cg && vg && cg.toLowerCase() !== vg.toLowerCase()) uit.push({ soort: 'groet', sleutel: 'groet:' + cg.toLowerCase() + '→' + vg.toLowerCase(), oud: cg, nieuw: vg });
  const cz = zinnen(c.romp), vz = zinnen(v.romp);
  const vSet = new Set(vz.map(zinSleutel)), cSet = new Set(cz.map(zinSleutel));
  if (cz.length >= 2 && !vSet.has(zinSleutel(cz[cz.length - 1]))) {
    const laatsteV = vz.length ? zinSleutel(vz[vz.length - 1]) : '';
    if (cSet.has(laatsteV) || !laatsteV) uit.push({ soort: 'slotzin_weg', sleutel: 'slotzin_weg' });
  }
  const cw = woorden(c.romp).length, vw = woorden(v.romp).length;
  if (cw >= 20 && vw <= KORTER * cw) uit.push({ soort: 'korter', sleutel: 'korter', pct: Math.round((1 - vw / cw) * 100) });
  const cu = jeU(c.romp), vu = jeU(v.romp);
  if (cu && vu && cu !== vu) uit.push({ soort: 'je_u', sleutel: 'je_u:' + cu + '→' + vu, oud: cu, nieuw: vu });
  // dubbele sleutels binnen één concept tellen één keer
  const gezien = new Set();
  return uit.filter(function (w) { if (gezien.has(w.sleutel)) return false; gezien.add(w.sleutel); return true; });
}
// → { uitkomst, gelijkenis, wijzigingen }
function vergelijk(concept, verzondenRuw) {
  const c = schoon(concept), v = schoon(verzondenRuw, c);
  if (plat(c) === plat(v)) return { uitkomst: 'ongewijzigd', gelijkenis: 1, wijzigingen: [] };
  const g = gelijkenis(c, v);
  if (g < GELIJK_MIN) return { uitkomst: 'niet_verstuurd', reden: 'eigen_tekst', gelijkenis: g, wijzigingen: [] };
  return { uitkomst: 'aangepast', gelijkenis: g, wijzigingen: wijzigingen(c, v) };
}
// Voorstelregel voor het correctiebestand (zonder datumkop), uit de wijzigingen van één sleutel.
function voorstelRegel(soort, voorbeelden, n) {
  const w = voorbeelden[0] || {};
  const q = function (s) { return '"' + String(s).replace(/"/g, "'").slice(0, 120) + '"'; };
  if (soort === 'groet') return 'Sluit af met ' + q(w.nieuw) + ', niet met ' + q(w.oud) + '.';
  if (soort === 'aanhef') return 'Begin met ' + q(w.nieuw) + ', niet met ' + q(w.oud) + '.';
  if (soort === 'slotzin_weg') return 'Geen afsluitende beleefdheidszin vlak voor de groet; stop na de laatste inhoudszin.';
  if (soort === 'je_u') return w.nieuw === 'je' ? 'Spreek met "je" aan, niet met "u", tenzij de ontvanger zelf "u" schrijft.' : 'Spreek met "u" aan, niet met "je", tenzij de ontvanger zelf "je" schrijft.';
  if (soort === 'korter') {
    const p = Math.round(voorbeelden.reduce(function (a, x) { return a + (x.pct || 0); }, 0) / Math.max(1, voorbeelden.length));
    return 'Schrijf korter: je kortte ' + n + ' concepten gemiddeld met ' + p + ' % in.';
  }
  return '';
}
function isoWeekLokaal(ms) {
  const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dag = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dag);
  const j = t.getUTCFullYear(), w = Math.ceil(((t - Date.UTC(j, 0, 1)) / DAG + 1) / 7);
  return j + '-' + String(w).padStart(2, '0');
}
function amsDag(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
function amsUur(ms) { return Number(new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false })) % 24; }
// Regel in het correctiebestand: bovenaan onder "## Correcties". null = niet gevonden of al aanwezig.
function regelErin(tekst, regel) {
  const t = String(tekst || '');
  if (t.indexOf(regel) >= 0) return null;
  const m = /^## Correcties[^\n]*\n/m.exec(t);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (t[i] === '\n') i++;
  return t.slice(0, i) + regel + '\n' + t.slice(i);
}
function regelEruit(tekst, regel) {
  const t = String(tekst || ''), i = t.indexOf(regel + '\n');
  return i < 0 ? null : t.slice(0, i) + t.slice(i + regel.length + 1);
}

// io: { dir, nu(), fout(label,e), log(r), gesprek(draad) → {berichten}, uitkomst(regel) (append), register(regel) (append),
//       correcties: { pad, wijzig(fn) → bool }, registerAan() → bool (rij mailconcept-vervang aan), concept(body) → {status,j},
//       vervang(body) → {status,j} }
function maak(io) {
  const nu = typeof io.nu === 'function' ? io.nu : Date.now;
  const fout = typeof io.fout === 'function' ? io.fout : function () {};
  let db = null, bezig = false;
  function open() {
    if (db) return db;
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(io.dir, { recursive: true, mode: 0o700 });
    const f = path.join(io.dir, 'concepten.sqlite'), nieuw = !fs.existsSync(f);
    db = new DatabaseSync(f);
    if (nieuw) { try { fs.chmodSync(f, 0o600); } catch (e) { /* ander bestandssysteem */ } }
    db.exec('PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000;');
    db.exec(`CREATE TABLE IF NOT EXISTS concept (concept_id TEXT PRIMARY KEY, draad TEXT NOT NULL, aangemaakt TEXT NOT NULL, aan TEXT, cc TEXT, onderwerp TEXT,
      tekst TEXT NOT NULL, bron TEXT NOT NULL, bijlagen INTEGER NOT NULL DEFAULT 0, uitkomst TEXT, reden TEXT, uitkomst_op TEXT, gelijkenis REAL,
      wijzigingen TEXT, gekeken TEXT, pogingen INTEGER NOT NULL DEFAULT 0, vervangen_door TEXT);
      CREATE INDEX IF NOT EXISTS concept_draad ON concept (draad, aangemaakt);
      CREATE TABLE IF NOT EXISTS kaart (sleutel TEXT PRIMARY KEY, gezet TEXT NOT NULL, patroon TEXT NOT NULL, regel TEXT NOT NULL, sha TEXT NOT NULL,
        aantal INTEGER NOT NULL, keuze TEXT, keuze_op TEXT);
      CREATE TABLE IF NOT EXISTS patroon (patroon TEXT PRIMARY KEY, voorgesteld TEXT NOT NULL, kaart TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vervang (sleutel TEXT PRIMARY KEY, draad TEXT NOT NULL, oud_id TEXT NOT NULL, verwacht_sha TEXT NOT NULL, body TEXT NOT NULL,
        gezet TEXT NOT NULL, status TEXT NOT NULL, fout TEXT, nieuw_id TEXT, klaar_op TEXT);`);
    return db;
  }
  function str(x, n) { return typeof x === 'string' ? x.replace(/\r\n?/g, '\n').slice(0, n) : ''; }

  // ── bewaren ──
  function bewaar(d) {
    d = isObj(d) ? d : {};
    const id = String(d.concept_id || ''), draad = String(d.draad || '');
    if (!/^r-?[0-9]{5,25}$/.test(id)) return { ok: false, fout: 'concept_id = Gmail-concept-id (r…)' };
    if (!/^[0-9a-f]{12,24}$/.test(draad)) return { ok: false, fout: 'draad = Gmail-threadId (hex)' };
    const tekst = typeof d.tekst === 'string' ? d.tekst.replace(/\r\n?/g, '\n') : '';
    if (tekst.trim().length < 5) return { ok: false, fout: 'tekst ontbreekt' };
    if (tekst.length > TEKST_MAX) return { ok: false, fout: 'tekst langer dan 20.000 tekens' };
    const t = new Date(nu()).toISOString();
    open().prepare(`INSERT OR REPLACE INTO concept (concept_id, draad, aangemaakt, aan, cc, onderwerp, tekst, bron, bijlagen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, draad, t, str(d.aan, 500), str(d.cc, 1000), str(d.onderwerp, 300), tekst, /^[a-z-]{2,30}$/.test(String(d.bron || '')) ? d.bron : 'chat', Math.max(0, Math.min(10, Number(d.bijlagen) | 0)));
    return { ok: true, bewaard_tot: new Date(nu() + BEWAAR_MS).toISOString().slice(0, 10) };
  }
  function opruim() {
    try {
      const d = open(), grens = new Date(nu() - BEWAAR_MS).toISOString();
      const n = Number(d.prepare('DELETE FROM concept WHERE aangemaakt < ?').run(grens).changes) || 0;
      d.prepare('DELETE FROM kaart WHERE gezet < ?').run(new Date(nu() - KAART_GEHEUGEN_MS).toISOString());
      d.prepare('DELETE FROM patroon WHERE voorgesteld < ?').run(new Date(nu() - KAART_GEHEUGEN_MS).toISOString());
      d.prepare("DELETE FROM vervang WHERE gezet < ?").run(new Date(nu() - BEWAAR_MS).toISOString());
      return n;
    } catch (e) { fout('concept-leer-opruim', e); return 0; }
  }

  // ── vergelijkronde ──
  const heeftLabel = function (b, l) { return b && Array.isArray(b.labels) && b.labels.indexOf(l) >= 0; };
  function uitkomstZet(r, u) {
    const t = new Date(nu()).toISOString();
    open().prepare('UPDATE concept SET uitkomst = ?, reden = ?, uitkomst_op = ?, gelijkenis = ?, wijzigingen = ? WHERE concept_id = ?')
      .run(u.uitkomst, u.reden || null, t, u.gelijkenis == null ? null : u.gelijkenis, JSON.stringify(u.wijzigingen || []), r.concept_id);
    try {
      io.uitkomst({ gemeten: t, concept_id: r.concept_id, thread_id: r.draad, bron: r.bron, uitkomst: u.uitkomst, reden: u.reden || undefined,
        gelijkenis: u.gelijkenis == null ? undefined : u.gelijkenis, wijzigingen: (u.wijzigingen || []).map(function (w) { return w.soort; }) });
    } catch (e) { fout('concept-leer-uitkomst', e); }
  }
  async function ronde() {
    if (bezig) return { bezig: true };
    bezig = true;
    const tel = { gekeken: 0, ongewijzigd: 0, aangepast: 0, niet_verstuurd: 0, onbekend: 0, wacht: 0, fout: 0 };
    try {
      opruim();
      const t = nu();
      const rijen = open().prepare('SELECT * FROM concept WHERE uitkomst IS NULL AND aangemaakt <= ? AND (gekeken IS NULL OR gekeken <= ?) ORDER BY aangemaakt LIMIT ?')
        .all(new Date(t - MIN_LEEFTIJD_MS).toISOString(), new Date(t - OPNIEUW_MS).toISOString(), RONDE_MAX);
      for (const r of rijen) {
        tel.gekeken++;
        open().prepare('UPDATE concept SET gekeken = ?, pogingen = pogingen + 1 WHERE concept_id = ?').run(new Date(nu()).toISOString(), r.concept_id);
        const oud = nu() - Date.parse(r.aangemaakt) > BEWAAR_MS - DAG;   // laatste dag: wat dan nog open is, krijgt een eindstand
        let g = null;
        try { g = await io.gesprek(r.draad); } catch (e) { g = null; }
        if (!g || !Array.isArray(g.berichten)) {
          if (oud) { uitkomstZet(r, { uitkomst: 'onbekend', reden: 'draad_onleesbaar' }); tel.onbekend++; } else tel.fout++;
          continue;
        }
        const grens = Date.parse(r.aangemaakt) - MARGE_MS;
        // Codex wv4107 ZOU 1: staat ons eigen concept (zelfde tekst) nog in de draad, dan is een SENT-bericht niet ons concept → wachten
        const eigenNog = g.berichten.some(function (b) { return heeftLabel(b, 'DRAFT') && typeof b.tekst === 'string' && plat(b.tekst) === plat(r.tekst); });
        if (eigenNog && !oud) { tel.wacht++; continue; }
        const sent = g.berichten.filter(function (b) { return heeftLabel(b, 'SENT') && !heeftLabel(b, 'DRAFT') && Date.parse(b.datum) >= grens; })
          .sort(function (a, b) { return Date.parse(a.datum) - Date.parse(b.datum); })[0];
        if (sent && !eigenNog && typeof sent.tekst === 'string' && !sent.tekst_afgekapt) {
          const u = vergelijk(r.tekst, sent.tekst);
          uitkomstZet(r, u); tel[u.uitkomst]++;
          continue;
        }
        if (sent && !eigenNog) { uitkomstZet(r, { uitkomst: 'onbekend', reden: 'verzonden_tekst_onvolledig' }); tel.onbekend++; continue; }
        const concept = g.berichten.some(function (b) { return heeftLabel(b, 'DRAFT'); });
        if (!concept && !r.vervangen_door) { uitkomstZet(r, { uitkomst: 'niet_verstuurd', reden: 'weggegooid' }); tel.niet_verstuurd++; continue; }
        if (oud) { uitkomstZet(r, { uitkomst: 'niet_verstuurd', reden: 'blijft_liggen' }); tel.niet_verstuurd++; continue; }
        tel.wacht++;
      }
    } catch (e) { fout('concept-leer-ronde', e); tel.fout++; }
    finally { bezig = false; }
    return tel;
  }

  // ── patronen en weekkaart ──
  function patronen() {
    const grens = new Date(nu() - BEWAAR_MS).toISOString();
    const per = new Map();
    open().prepare("SELECT concept_id, wijzigingen FROM concept WHERE uitkomst = 'aangepast' AND aangemaakt >= ?").all(grens).forEach(function (r) {
      let w = [];
      try { w = JSON.parse(r.wijzigingen || '[]'); } catch (e) { w = []; }
      (Array.isArray(w) ? w : []).forEach(function (x) {
        if (!x || typeof x.sleutel !== 'string') return;
        const p = per.get(x.sleutel) || { sleutel: x.sleutel, soort: x.soort, concepten: new Set(), voorbeelden: [] };
        p.concepten.add(r.concept_id); p.voorbeelden.push(x); per.set(x.sleutel, p);
      });
    });
    const al = new Set(open().prepare('SELECT patroon FROM patroon').all().map(function (r) { return r.patroon; }));
    return Array.from(per.values()).filter(function (p) { return p.concepten.size >= PATROON_MIN && !al.has(p.sleutel); })
      .sort(function (a, b) { return b.concepten.size - a.concepten.size || SOORT_VOLGORDE.indexOf(a.soort) - SOORT_VOLGORDE.indexOf(b.soort) || (a.sleutel < b.sleutel ? -1 : 1); });
  }
  // status: { sleutel: 'open'|'later'|… } uit Voor jou. → { kaart, bevries } of { reden }
  function kaart(status) {
    const t = nu(), sleutel = 'mailstem-leer-' + isoWeekLokaal(t);
    if (amsUur(t) < 9) return { reden: 'voor 09:00' };
    if (open().prepare('SELECT 1 FROM kaart WHERE sleutel = ?').get(sleutel)) return { reden: 'deze week al een kaart' };
    const openK = open().prepare('SELECT sleutel FROM kaart WHERE keuze IS NULL').all().filter(function (r) { const s = status && status[r.sleutel]; return s === 'open' || s === 'later'; });
    if (openK.length) return { reden: 'er staat nog een mailstem-kaart open' };
    const p = patronen()[0];
    if (!p) return { reden: 'geen patroon' };
    const n = p.concepten.size, voorstel = voorstelRegel(p.soort, p.voorbeelden, n);
    if (!voorstel) return { reden: 'geen voorstel' };
    const regel = ('- ' + amsDag(t) + ' — Alle mailconcepten: ' + voorstel + ' (David: Ja op het weekvoorstel; ' + n + ' keer zo aangepast)').slice(0, REGEL_MAX);
    const titel = ('Mailconcepten — voortaan zo: ' + voorstel.replace(/\.$/, '')).slice(0, 88).replace(/\s+\S*$/, function (m) { return voorstel.length > 75 ? ' …' : m; }) + '?';
    const deadline = new Date(t + 7 * DAG).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    const k = {
      sleutel, soort: 'besluit', waar: 'overal', prive: true, duur_min: 1, volgorde: 45, deadline,
      titel: titel.length > 90 ? titel.slice(0, 89) + '?' : titel,
      waarom: 'Je paste de afgelopen 30 dagen ' + n + ' van mijn mailconcepten op dezelfde manier aan. Met Ja schrijf ik ze ' +
        'voortaan zo; dan hoef je het niet meer zelf te verbeteren.',
      stappen: ['Wat erbij komt in je mailstem: ' + voorstel, 'Ja: zo schrijf ik je concepten voortaan.', 'Nee: niets verandert, en dit voorstel komt niet terug.',
        'Anders: zeg hoe het wel moet (bijvoorbeeld "alleen aan collega\'s").'],
      herkomst: { handmatig: 'mailstem-leer' } };
    return { kaart: k, bevries: { sleutel, patroon: p.sleutel, regel, sha: sha(regel), aantal: n } };
  }
  function kaartGezet(b) {
    const t = new Date(nu()).toISOString();
    open().prepare('INSERT OR REPLACE INTO kaart (sleutel, gezet, patroon, regel, sha, aantal) VALUES (?, ?, ?, ?, ?, ?)').run(b.sleutel, t, b.patroon, b.regel, b.sha, b.aantal);
    open().prepare('INSERT OR REPLACE INTO patroon (patroon, voorgesteld, kaart) VALUES (?, ?, ?)').run(b.patroon, t, b.sleutel);
  }
  // Knop op de weekkaart (appVoorJouKnop). null = niet van ons. Ja: de pod zet precies de bevroren regel in het correctiebestand bij de start
  // van de knopbeurt (bijStart) en haalt hem weg als de druk vervalt (bijVerval).
  function knop(sleutel, keuze, toelichting) {
    if (!SLEUTEL_RE.test(String(sleutel || ''))) return null;
    let k;
    try { k = open().prepare('SELECT * FROM kaart WHERE sleutel = ?').get(sleutel); } catch (e) { fout('concept-leer-knop', e); return null; }
    if (!k) return null;
    const kz = keuze === 'ja' ? 'ja' : keuze === 'nee' ? 'nee' : 'anders';
    const context = k.keuze ? ' (Mailstem-kaart: al afgehandeld op ' + String(k.keuze_op || '').slice(0, 16) + '; de pod doet niets meer. Zeg dat kort.)'
      : kz === 'ja' ? ' (Mailstem-kaart: David zei Ja. De pod zet de regel zelf bovenaan in 00_Systeem/Mailstem - correcties van David.md; vanaf nu volg je hem bij elk mailconcept. Jij schrijft niets in dat bestand; bevestig in één zin.)'
        : kz === 'nee' ? ' (Mailstem-kaart: Nee, de pod schrijft niets en legt dit voorstel niet opnieuw voor. Zeg dat kort.)'
          : ' (Mailstem-kaart: Anders; de pod schrijft niets. Lees Davids toelichting; is het een duidelijke correctie op zijn mailstem, schrijf die dan zelf als regel in het correctiebestand zoals de skill mijn-mailstem voorschrijft, anders vraag kort wat hij bedoelt.)';
    let gezet = false;
    return {
      context,
      bijStart: function () {
        try {
          const k2 = open().prepare('SELECT * FROM kaart WHERE sleutel = ?').get(sleutel);
          if (!k2 || k2.keuze) return;
          if (kz === 'ja') {
            if (sha(k2.regel) !== k2.sha) { fout('concept-leer-knop', new Error('regel gewijzigd na de kaart')); return; }
            gezet = io.correcties.wijzig(function (oud) { return regelErin(oud, k2.regel); }) === true;
            if (!gezet) fout('concept-leer-knop', new Error('regel niet in het correctiebestand gezet (kop ontbreekt of al aanwezig)'));
          }
          open().prepare('UPDATE kaart SET keuze = ?, keuze_op = ? WHERE sleutel = ?').run(kz, new Date(nu()).toISOString(), sleutel);
          if (io.log) io.log('mailstem-leer knop ' + kz + (kz === 'ja' ? (gezet ? ' regel gezet' : ' regel NIET gezet') : ''));
        } catch (e) { fout('concept-leer-knop', e); }
      },
      bijVerval: function () {
        try {
          const k2 = open().prepare('SELECT * FROM kaart WHERE sleutel = ?').get(sleutel);
          if (!k2) return;
          if (gezet) { io.correcties.wijzig(function (oud) { return regelEruit(oud, k2.regel); }); gezet = false; }
          open().prepare('UPDATE kaart SET keuze = NULL, keuze_op = NULL WHERE sleutel = ?').run(sleutel);
        } catch (e) { fout('concept-leer-knop', e); }
      },
    };
  }

  // ── vervangen (3C173) ──
  function vervangAan() { try { return io.registerAan() === true; } catch (e) { return false; } }
  // → { kan, reden, concept_id? }. reden: uit | geen_eigen | onleesbaar | geen_concept | meer_concepten | bewerkt | bijlagen | onbewerkt
  async function vervangKan(draad) {
    if (!/^[0-9a-f]{12,24}$/.test(String(draad || ''))) return { kan: false, reden: 'geen_draad' };
    if (!vervangAan()) return { kan: false, reden: 'uit' };
    const r = open().prepare("SELECT * FROM concept WHERE draad = ? AND aangemaakt >= ? AND vervangen_door IS NULL ORDER BY aangemaakt DESC LIMIT 1")
      .get(String(draad), new Date(nu() - BEWAAR_MS).toISOString());
    if (!r) return { kan: false, reden: 'geen_eigen' };
    if (r.bijlagen > 0) return { kan: false, reden: 'bijlagen' };
    let g = null;
    try { g = await io.gesprek(draad); } catch (e) { g = null; }
    if (!g || !Array.isArray(g.berichten)) return { kan: false, reden: 'onleesbaar' };
    const concepten = g.berichten.filter(function (b) { return heeftLabel(b, 'DRAFT'); });
    if (!concepten.length) return { kan: false, reden: 'geen_concept' };
    if (concepten.length > 1) return { kan: false, reden: 'meer_concepten' };
    const c = concepten[0];
    if ((Array.isArray(c.bijlagen) && c.bijlagen.length) || c.tekst_afgekapt || typeof c.tekst !== 'string') return { kan: false, reden: 'bijlagen' };
    if (plat(c.tekst) !== plat(r.tekst)) return { kan: false, reden: 'bewerkt' };
    // Codex wv4107 MOET 3: ook ontvangers en onderwerp moeten nog zijn wat Socev zette (luik: aan als tekst, adressen eruit vergelijken)
    if (adressen(c.aan).join(',') !== adressen(r.aan).join(',') || adressen(c.cc).join(',') !== adressen(r.cc).join(',')) return { kan: false, reden: 'bewerkt' };
    if (r.onderwerp && typeof c.onderwerp === 'string' && plat(c.onderwerp).toLowerCase() !== plat(r.onderwerp).toLowerCase()) return { kan: false, reden: 'bewerkt' };
    return { kan: true, reden: 'onbewerkt', concept_id: r.concept_id, onderwerp: r.onderwerp || '', rij: r };
  }
  // Nieuwe versie bevriezen + kaart. body = { aan, cc?, van?, onderwerp, bericht }. → { ok, kaart?, reden }
  async function vervangKaart(draad, body) {
    body = isObj(body) ? body : {};
    const bericht = typeof body.bericht === 'string' ? body.bericht.replace(/\r\n?/g, '\n') : '';
    if (bericht.trim().length < 5 || bericht.length > TEKST_MAX) return { ok: false, reden: 'tekst' };
    if (typeof body.aan !== 'string' || !body.aan.trim() || typeof body.onderwerp !== 'string' || !body.onderwerp.trim()) return { ok: false, reden: 'velden' };
    const k = await vervangKan(draad);
    if (!k.kan) return { ok: false, reden: k.reden };
    const sleutel = 'mailconcept-vervang-' + sha(draad + '|' + k.concept_id + '|' + bericht).slice(0, 12);
    const vrij = { aan: body.aan.slice(0, 1000), onderwerp: body.onderwerp.slice(0, 300), bericht, thread_id: String(draad) };
    if (typeof body.cc === 'string' && body.cc.trim()) vrij.cc = body.cc.slice(0, 1000);
    if (typeof body.van === 'string' && body.van.trim()) vrij.van = body.van.slice(0, 200);
    open().prepare("INSERT OR REPLACE INTO vervang (sleutel, draad, oud_id, verwacht_sha, body, gezet, status) VALUES (?, ?, ?, ?, ?, ?, 'open')")
      .run(sleutel, String(draad), k.concept_id, sha(plat(k.rij.tekst)), JSON.stringify(vrij), new Date(nu()).toISOString());
    const ond = (k.onderwerp || vrij.onderwerp).replace(/^(re|fw|fwd|antw)\s*:\s*/i, '').slice(0, 40);
    const kaartP = {
      sleutel, soort: 'besluit', waar: 'overal', prive: true, duur_min: 1, volgorde: 15,
      deadline: amsDag(nu() + VERVANG_MS), spoed: 'David vroeg net om een nieuwe versie van dit mailconcept',
      titel: ('Concept «' + ond + '» — oude verwijderen en vervangen?').slice(0, 90),
      waarom: 'Je vroeg om een nieuwe versie, maar in deze Gmail-draad staat nog mijn vorige concept. Dat is nog precies zoals ik het maakte (jij hebt er niets aan veranderd). ' +
        'Met Ja verwijder ik dat oude concept en zet ik de nieuwe versie in dezelfde draad. Versturen doe je zelf.',
      stappen: ['Begin van de nieuwe versie: ' + plat(bericht).slice(0, 220) + (plat(bericht).length > 220 ? ' …' : ''),
        'Ja (met vingerafdruk): oud concept weg, nieuw concept erin.', 'Nee: niets verandert; de nieuwe tekst staat in de chat.'],
      herkomst: { handmatig: 'mailconcept-vervang' } };
    return { ok: true, kaart: kaartP, sleutel };
  }
  // Knop op de vervangkaart. Alleen een Ja met verse vingerafdruk (gevoeligJa) doet iets; de pod, nooit het model.
  function vervangKnop(sleutel, keuze) {
    if (!VERVANG_RE.test(String(sleutel || ''))) return null;
    let v;
    try { v = open().prepare('SELECT * FROM vervang WHERE sleutel = ?').get(sleutel); } catch (e) { fout('concept-vervang-knop', e); return null; }
    if (!v) return null;
    const context = v.status !== 'open' ? ' (Vervangkaart: al afgehandeld (' + v.status + '); de pod doet niets meer. Zeg dat kort.)'
      : keuze === 'ja' ? ' (Vervangkaart: bij een Ja met verse vingerafdruk haalt de pod zelf het oude concept weg en zet de nieuwe versie in dezelfde Gmail-draad. Jij maakt geen concept en haalt niets weg. Kijk over een minuut met concepthulp.py vervang-stand <draad> wat er gebeurde en zeg het David in één zin; zonder vingerafdruk gebeurt er niets en zeg je dat.)'
        : ' (Vervangkaart: geen Ja, de pod verandert niets in Gmail. De nieuwe tekst staat al in de chat; zeg dat kort.)';
    return {
      context,
      bijStart: function (kz, gevoeligJa) {
        const v2 = open().prepare('SELECT * FROM vervang WHERE sleutel = ?').get(sleutel);
        if (!v2 || v2.status !== 'open') return;
        if (kz !== 'ja') { open().prepare("UPDATE vervang SET status = 'nee', klaar_op = ? WHERE sleutel = ?").run(new Date(nu()).toISOString(), sleutel); return; }
        if (gevoeligJa !== true) { open().prepare("UPDATE vervang SET status = 'geen_vingerafdruk', klaar_op = ? WHERE sleutel = ?").run(new Date(nu()).toISOString(), sleutel); return; }
        open().prepare("UPDATE vervang SET status = 'bezig' WHERE sleutel = ? AND status = 'open'").run(sleutel);
        vervangVoer(sleutel).catch(function (e) { fout('concept-vervang', e); });
      },
      bijVerval: function () {
        try { open().prepare("UPDATE vervang SET status = 'open', klaar_op = NULL WHERE sleutel = ? AND status IN ('nee', 'geen_vingerafdruk')").run(sleutel); } catch (e) { fout('concept-vervang-knop', e); }
      },
    };
  }
  async function vervangVoer(sleutel) {
    const v = open().prepare('SELECT * FROM vervang WHERE sleutel = ?').get(sleutel);
    const klaar = function (status, foutTekst, nieuwId) {
      open().prepare('UPDATE vervang SET status = ?, fout = ?, nieuw_id = ?, klaar_op = ? WHERE sleutel = ?').run(status, foutTekst || null, nieuwId || null, new Date(nu()).toISOString(), sleutel);
      if (io.log) io.log('mailconcept-vervang ' + status + (foutTekst ? ' ' + String(foutTekst).slice(0, 80) : ''));
      return status;
    };
    if (!v || v.status !== 'bezig') return 'niet';
    if (!vervangAan()) return klaar('uit', 'registerrij uit');
    const oud = open().prepare('SELECT * FROM concept WHERE concept_id = ?').get(v.oud_id);
    if (!oud || sha(plat(oud.tekst)) !== v.verwacht_sha) return klaar('mislukt', 'bewaarde tekst weg of anders');
    // de pod toetst vlak vóór het weghalen opnieuw (bewerkt intussen?), n8n daarna nog eens op het concept-id zelf
    const k = await vervangKan(v.draad);
    if (!k.kan || k.concept_id !== v.oud_id) return klaar('niet_weg', k.reden || 'ander concept');
    // Codex wv4107 MOET 2/3: één n8n-stap (AI - Mailconcept vervangen). Eerst nieuw-dan-oud-weg kan niet: een tweede concept in een draad blijft
    // na het weggooien van het eerste een onzichtbaar spook (gemeten wv2728). Dus: n8n toetst vlak vóór het weghalen draad, tekst, geen bijlage,
    // ontvangers en onderwerp van het oude concept, leest het als ruwe kopie, haalt het weg, maakt het nieuwe, en zet bij mislukken de ruwe
    // kopie byte-gelijk terug in de draad (Codex' tweede optie: volledig automatisch herstel).
    const body = JSON.parse(v.body);
    let a;
    try {
      a = await io.vervang({ oud_concept_id: v.oud_id, thread_id: v.draad, verwacht_tekst: oud.tekst, verwacht_aan: oud.aan || '', verwacht_cc: oud.cc || '', verwacht_onderwerp: oud.onderwerp || '',
        aan: body.aan, cc: body.cc || '', van: body.van || '', onderwerp: body.onderwerp, bericht: body.bericht });
    } catch (e) { return klaar('mislukt', 'vervangluik: ' + String(e && e.message || e)); }
    const j = a && a.j;
    if (!a || a.status !== 200 || !isObj(j) || j.ok !== true || typeof j.concept_id !== 'string') return klaar('niet_weg', 'n8n: ' + (a ? a.status + ' ' + String(j && j.fout || '').slice(0, 80) : 'geen antwoord'));
    open().prepare('UPDATE concept SET vervangen_door = ?, uitkomst = ?, reden = ?, uitkomst_op = ? WHERE concept_id = ?').run(j.concept_id, 'niet_verstuurd', 'vervangen', new Date(nu()).toISOString(), v.oud_id);
    try { io.uitkomst({ gemeten: new Date(nu()).toISOString(), concept_id: v.oud_id, thread_id: v.draad, bron: oud.bron, uitkomst: 'niet_verstuurd', reden: 'vervangen', wijzigingen: [] }); } catch (e) { fout('concept-leer-uitkomst', e); }
    bewaar({ concept_id: j.concept_id, draad: typeof j.thread_id === 'string' && j.thread_id ? j.thread_id : v.draad, aan: body.aan, cc: body.cc || '', onderwerp: body.onderwerp, tekst: body.bericht, bron: 'vervang' });
    try {
      io.register({ aangemaakt: new Date(nu()).toISOString(), concept_id: j.concept_id, thread_id: j.thread_id || v.draad, aan: body.aan, onderwerp: body.onderwerp,
        hash: sha(body.bericht), tekens: body.bericht.length, bron: 'vervang', vervangt: v.oud_id });
    } catch (e) { fout('concept-leer-register', e); }
    return klaar(j.thread_id === v.draad ? 'vervangen' : 'vervangen_los', null, j.concept_id);
  }
  function vervangStand(draad) {
    const r = open().prepare('SELECT status, fout, gezet, klaar_op FROM vervang WHERE draad = ? ORDER BY gezet DESC LIMIT 1').get(String(draad || ''));
    return r ? { status: r.status, fout: r.fout || '', gezet: r.gezet, klaar_op: r.klaar_op || '' } : { status: 'geen' };
  }

  function health() {
    try {
      const d = open(), per = {};
      d.prepare('SELECT coalesce(uitkomst, \'open\') u, count(*) n FROM concept GROUP BY 1').all().forEach(function (r) { per[r.u] = r.n; });
      const vv = {}; d.prepare('SELECT status, count(*) n FROM vervang GROUP BY 1').all().forEach(function (r) { vv[r.status] = r.n; });
      return { bewaard: Object.values(per).reduce(function (a, b) { return a + b; }, 0), per_uitkomst: per, kaarten: d.prepare('SELECT count(*) n FROM kaart').get().n,
        patronen_klaar: patronen().length, vervang_aan: vervangAan(), vervang: vv };
    } catch (e) { return { fout: true }; }
  }
  return { bewaar, ronde, opruim, patronen, kaart, kaartGezet, knop, vervangKan, vervangKaart, vervangKnop, vervangVoer, vervangStand, health, _db: open };
}

module.exports = { maak, adressen, vergelijk, wijzigingen, schoon, zonderCitaat, zonderHandtekening, opbouw, gelijkenis, voorstelRegel, regelErin, regelEruit,
  isoWeekLokaal, SLEUTEL_RE, VERVANG_RE, VERVANG_RIJ, _grenzen: { BEWAAR_MS, PATROON_MIN, GELIJK_MIN, RONDE_MAX } };
