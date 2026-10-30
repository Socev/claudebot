'use strict';
/*
 * intake-publicatie.js — publicatieservice van OVIS Intake: bronnotities en het gegenereerde blok in _register.md (wv1869,
 * Second Brain 2.0 fase 3b). Ontwerp: vault "01_Ontwikkeling/Second Brain 2.0 - fase 3 intake, nachtketen en schrijvers (ontwerp
 * 28-10-2026).md" § 3.4 en § 3.4a; databankkant socev-scripts packages/sb2/sql/fase2/0012_publicatie.up.sql.
 *
 * WAAROM. Fase 3a spiegelt elk Intake-stuk naar secondbrain (bron, versie, ontvangst). Elk stuk krijgt nu een vaste, neutrale bronnotitie
 * in <entiteit>/Bronnen/<JJJJ-MM-DD>_<stuk_id>.md (alleen code: ids, hashes, ontvangsten, onderdelen, link naar het origineel; geen
 * AI-samenvatting) en elke Bronnen-map een gegenereerd blok onderaan _register.md (één regel per bronnotitie, uit source_occurrence). Het
 * handgeschreven log van de oude nachtskill (second-brain-verwerk-raw-input) blijft erboven staan tot die met pensioen gaat.
 *
 * HOE. Eén ronde per nacht (nachtketen-stap intake-publicatie; met de hand via mk-scripts/wv1869). Per (pad, blok):
 *   gevonden hash = sha256 van frontmatter + blok (bronnotitie) of van het blok (register); null = er niet.
 *   open outbox-rij of gevonden ≠ nieuw → sb2_publicatie_zet → sb2_outbox_gevonden → 'schrijf': vault-veilig temp → rename met een
 *   inode/mtime-toets vlak voor de rename (iemand schreef intussen = niet schrijven, rij blijft bezig, volgende ronde opnieuw) →
 *   sb2_outbox_klaar. 'al_klaar' (crash ná de rename, proef 7) = niets. 'blokkeer' (met de hand gewijzigd of weggehaald, proef 8) = niets
 *   schrijven; besluit open in secondbrain, één box-rij per ronde via o.meld.
 * Alleen lezen in intake.sqlite (spiegel, stuk, onderdeel, overgang, uitvoering); de waarheid over wat er geschreven is staat in
 * secondbrain.outbox_publication. Wat iemand ná het blok van een bronnotitie zet (het voetblok van de steekwoorden) blijft staan.
 *
 * Privacy: doel_pad is neutraal (de RPC weigert iets anders); naar Supabase gaan alleen paden, hashes, ids en tellingen. In de vault
 * staat het onderwerp van een mail (uit de mailkop, code) behalve bij een stuk met de patiëntmarker; daar ook geen namen van onderdelen
 * (het vaultpad van het origineel staat er wel: dat bestand staat al zo in de vault).
 *
 * VORM. Alleen fs, path en crypto. Database, vault-veilig, RPC, klok en schakelaar komen binnen via maak(o), zodat
 * test/intake-publicatie.sh het met een nep-Supabase (zelfde regels als 0012) en een wegwerpvault kan draaien.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// entiteitcode (knoop, zoals intake-router KENNIS_MAP) → map in de vault; de RPC kent dezelfde vaste lijst (sb2_publicatie_pad_ok)
const ENTITEIT_MAP = { TG: '10_Zakelijk/Tolgaarde', GH: '10_Zakelijk/Groenhouten', HAGRO: '10_Zakelijk/HAGRO', POT: '10_Zakelijk/POT_POH_GGZ',
  HOLD: '10_Zakelijk/Holding', PHBV: '10_Zakelijk/Praktijkhouders_BV', SEL: '10_Zakelijk/SEL', DBH: '10_Zakelijk/DBH', GHAWA: '10_Zakelijk/GHAWA-ECG',
  PRIVE: '20_Prive', INBOX: '_INBOX' };
const STUK_RE = /^stk_[0-9]{8}_[0-9a-f]{8}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const BLOK_EIND = '<!-- ovis:blok eind -->';
const REG_BEGIN_RE = /<!-- ovis:blok begin id="bronregister"[^>]*-->/g;
const NOTITIE_BEGIN_RE = /<!-- ovis:blok begin id="bronnotitie"[^>]*-->/g;
const RPC_BATCH = 200;
const KOP_LEES = 4096;           // zoveel bytes van een .md om ovis_stuk in de frontmatter te vinden
const DIEPTE = 6;                // mapdiepte onder 10_Zakelijk/, 20_Prive/ en _INBOX/ bij het zoeken naar het origineel
const NOTITIE_MAX = 1024 * 1024, REGISTER_MAX = 8 * 1024 * 1024;

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }
// YAML-waarde op één regel, altijd tussen dubbele aanhalingstekens
function yv(s) { return JSON.stringify(String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ')); }
// tabelcel: geen regelovergang, geen pijp
function cel(s) { return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\|/g, '\\|').trim(); }
function dagNl(iso) { const t = Date.parse(iso); return isNaN(t) ? null : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date(t)); }
function klokNl(iso) {
  const t = Date.parse(iso); if (isNaN(t)) return '';
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
}
function grootte(n) { n = Number(n) || 0; return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' kB' : n + ' B'; }
function link(pad) { return '[[' + String(pad).replace(/\.md$/, '') + ']]'; }
// Lezen zonder een symlink te volgen en zonder op een fifo te blijven hangen (Opus-review wv1869 #6): O_NOFOLLOW | O_NONBLOCK, dan fstat
// (gewoon bestand, grootte) en lezen via de descriptor. n = hooguit zoveel bytes (kop); max = groter bestand → null.
function leesVeilig(p, n, max) {
  let fd;
  try { fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (e) { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (max != null && st.size > max)) return null;
    if (n != null) { const b = Buffer.alloc(Math.min(n, st.size)); const k = fs.readSync(fd, b, 0, b.length, 0); return b.slice(0, k); }
    return fs.readFileSync(fd);
  } catch (e) { return null; } finally { fs.closeSync(fd); }
}

// vaultpad dat Intake of de router schreef → entiteitcode (raw_input van een entiteit, 20_Prive/raw_input of _INBOX), anders null
function entiteitVanPad(pad) {
  const p = String(pad || '');
  if (p.startsWith('_INBOX/')) return 'INBOX';
  if (p.startsWith('20_Prive/raw_input/')) return 'PRIVE';
  const m = /^(10_Zakelijk\/[^/]+)\/raw_input\//.exec(p);
  if (!m) return null;
  for (const k of Object.keys(ENTITEIT_MAP)) if (ENTITEIT_MAP[k] === m[1]) return k;
  return null;
}

// Het gegenereerde blok in een tekst: { begin, eind (na de eindmarker), tekst } | null | { kapot: true }
function vindBlok(tekst, beginRe) {
  const t = String(tekst);
  const hits = [];
  beginRe.lastIndex = 0;
  let m; while ((m = beginRe.exec(t))) hits.push(m.index);
  if (!hits.length) return null;
  if (hits.length > 1) return { kapot: true };
  const e = t.indexOf(BLOK_EIND, hits[0]);
  if (e < 0) return { kapot: true };
  const volgende = t.indexOf('<!-- ovis:blok begin', hits[0] + 1);
  if (volgende >= 0 && volgende < e) return { kapot: true };
  return { begin: hits[0], eind: e + BLOK_EIND.length, tekst: t.slice(hits[0], e + BLOK_EIND.length) };
}
function blokMet(id, binnen) {
  return '<!-- ovis:blok begin id="' + id + '" content_hash="' + sha256(binnen).slice(0, 16) + '" -->' + binnen + BLOK_EIND;
}
// gevonden hash van een bronnotitie: frontmatter + blok (vanaf het begin van het bestand tot en met de eindmarker)
function notitieHash(tekst) {
  if (tekst == null) return { hash: null };
  const b = vindBlok(tekst, NOTITIE_BEGIN_RE);
  if (!b || b.kapot) return { hash: sha256('kapot:' + tekst), kapot: true };
  return { hash: sha256(String(tekst).slice(0, b.eind)), staart: String(tekst).slice(b.eind) };
}
function registerHash(tekst) {
  if (tekst == null) return { hash: null, ontbreekt: true };
  const b = vindBlok(tekst, REG_BEGIN_RE);
  if (!b) return { hash: null };
  if (b.kapot) return { hash: sha256('kapot:' + tekst), kapot: true };
  return { hash: sha256(b.tekst), blok: b };
}

/*
 * maak(o) → { ronde, laatste }
 * o = { db (intake.sqlite, node:sqlite; alleen lezen), vault (absoluut), vv ({ lees, schrijf } van vault-veilig), rpc(fn, body) → Promise<json>,
 *       schakelaar() → { aan, entiteiten: [codes] } | null, pauze() → bool (onderhoudsstand of nachtgrendel), nu?() → ms,
 *       versie?() → claudebot-commit, log?(regel), fout?(label, e), meld?(tekst) (box-rij bij geblokkeerd), staatBestand? (laatste ronde,
 *       alleen tellingen), slot? (pad van het slotbestand: één ronde tegelijk, ook tussen de pod en mk-scripts/wv1869/hand.js),
 *       naRename?(pad) (alleen de proef: crash na de rename) }
 */
// Slot over processen heen (Opus-review wv1869 #2): O_EXCL-bestand met pid; een slot van een dood proces wordt opgeruimd.
function neemSlot(p) {
  for (let i = 0; i < 2; i++) {
    try { const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return true; }
    catch (e) {
      if (!e || e.code !== 'EEXIST') return false;
      let pid = null; try { pid = Number(String(fs.readFileSync(p, 'utf8')).trim()); } catch (x) { pid = null; }
      let leeft = false; if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, 0); leeft = true; } catch (x) { leeft = !!(x && x.code === 'EPERM'); } }
      if (leeft) return false;
      try { fs.unlinkSync(p); } catch (x) { return false; }
    }
  }
  return false;
}
function laatSlot(p) { try { if (Number(String(fs.readFileSync(p, 'utf8')).trim()) === process.pid) fs.unlinkSync(p); } catch (e) { /* weg */ } }

function maak(o) {
  const db = o.db;
  const nu = o.nu || Date.now;
  const log = o.log || function () {};
  const fout = o.fout || function () {};
  let laatsteRonde = null;
  try { if (o.staatBestand) laatsteRonde = safeJson(fs.readFileSync(o.staatBestand, 'utf8')); } catch (e) { /* nog geen */ }

  function abs(rel) { return path.join(o.vault, rel); }
  function leesVault(rel, max) {
    try { return o.vv.lees(abs(rel), 'utf8', { max: max }); } catch (e) { if (e && (e.code === 'ENOENT')) return null; throw e; }
  }
  function statVault(rel) { try { const st = fs.lstatSync(abs(rel)); return st.isFile() ? st : null; } catch (e) { return null; } }

  // ── kandidaten uit intake.sqlite ──────────────────────────────────────────────────────────────────────────────────────────
  function kandidaten(codes) {
    const rijen = db.prepare("SELECT s.stuk_id, s.profiel, s.bron, s.versie, s.status, s.access_context, s.ontvangen, s.aangemaakt, s.meta, s.marker_patient, " +
      "g.ps, g.ids, g.bronnen FROM spiegel g JOIN stuk s ON s.stuk_id = g.stuk_id WHERE g.stand = 'gespiegeld' AND g.ids IS NOT NULL ORDER BY s.stuk_id").all();
    const uit = [], overgeslagen = { entiteit: 0, status: 0, scope: 0 };
    for (const r of rijen) {
      if (!STUK_RE.test(r.stuk_id)) continue;
      if (/^ramble@/.test(r.profiel)) continue;   // wv1969: herinneringen nooit als bronnotitie (fase R § 3.2)
      const ids = safeJson(r.ids);
      if (!Array.isArray(ids) || !ids.length) continue;
      // map: router (live) eerst, anders het eerste vaultpad dat Intake schreef
      let code = null;
      const u = db.prepare("SELECT doel, pad FROM uitvoering WHERE stuk_id = ? AND lens = 'kennis' AND doel IS NOT NULL ORDER BY id LIMIT 1").get(r.stuk_id);
      if (u && ENTITEIT_MAP[u.doel]) code = u.doel;
      const og = db.prepare("SELECT deel, pad, geschreven_sha FROM overgang WHERE stuk_id = ? AND stand = 'om' AND pad IS NOT NULL ORDER BY id").all(r.stuk_id);
      if (!code && og.length) code = entiteitVanPad(og[0].pad);
      if (!code) { overgeslagen.entiteit++; continue; }
      if (r.ps !== 'registered') { overgeslagen.status++; continue; }
      const scope = codes.indexOf(code) >= 0;
      const paden = og.map(function (x) { return { deel: x.deel, pad: x.pad, sha: x.geschreven_sha }; });
      const uv = db.prepare("SELECT pad, sha256 FROM uitvoering WHERE stuk_id = ? AND pad IS NOT NULL ORDER BY id").all(r.stuk_id);
      for (const x of uv) paden.push({ deel: null, pad: x.pad, sha: x.sha256 });
      const delen = db.prepare('SELECT deel, rol, naam, mime, grootte, sha256 FROM onderdeel WHERE stuk_id = ? ORDER BY deel').all(r.stuk_id);
      uit.push({ r, ids, code, scope, paden, delen });
    }
    return { lijst: uit, overgeslagen };
  }

  // ── index van de vaultbestanden (origineel terugvinden; de oude skill verplaatst en hernoemt, soms naar een andere map, bv.
  // _Gedeeld/CAO_Huisartsenzorg/Bronnen): alle raw_input/- en Bronnen/-mappen van het zakelijke deel (10_Zakelijk) of van 20_Prive, plus _INBOX.
  function bouwIndex(code) {
    const deel = code === 'PRIVE' ? '20_Prive' : '10_Zakelijk';
    const idx = { stuk: new Map(), maat: new Map() };
    function loop(rel, diepte, telt) {
      let namen;
      try { namen = fs.readdirSync(abs(rel), { withFileTypes: true }); } catch (e) { return; }
      for (const d of namen) {
        if (d.name.startsWith('.')) continue;
        const r = rel + '/' + d.name;
        if (d.isDirectory()) { if (diepte < DIEPTE) loop(r, diepte + 1, telt || d.name === 'raw_input' || d.name === 'Bronnen'); continue; }   // Dirent: een symlink is geen map
        if (!d.isFile() || !telt) continue;
        if (/\.md$/i.test(d.name)) {
          const kb = leesVeilig(abs(r), KOP_LEES, null);
          if (!kb) continue;
          const kop = kb.toString('utf8');
          if (!kop.startsWith('---')) continue;
          const m = /^ovis_stuk:\s*"?(stk_[0-9]{8}_[0-9a-f]{8})"?\s*$/m.exec(kop.slice(0, kop.indexOf('\n---', 3) > 0 ? kop.indexOf('\n---', 3) : kop.length));
          if (m && !/^ovis_bronnotitie:/m.test(kop)) { if (!idx.stuk.has(m[1])) idx.stuk.set(m[1], []); idx.stuk.get(m[1]).push(r); }
        } else {
          let st; try { st = fs.lstatSync(abs(r)); } catch (e) { continue; }
          if (!idx.maat.has(st.size)) idx.maat.set(st.size, []);
          idx.maat.get(st.size).push(r);
        }
      }
    }
    // een wortel (of een map erboven) die een symlink is, volgen we niet: alleen lezen binnen de vault (review #6)
    let vw; try { vw = fs.realpathSync(o.vault); } catch (e) { return idx; }
    for (const w of [deel, '_INBOX']) { try { if (fs.realpathSync(abs(w)) !== path.join(vw, w)) continue; } catch (e) { continue; } loop(w, 0, w === '_INBOX'); }
    idx.shaCache = new Map();
    return idx;
  }
  function shaVan(idx, rel) {
    if (idx.shaCache.has(rel)) return idx.shaCache.get(rel);
    const b = leesVeilig(abs(rel), null, 60 * 1048576);
    const h = b ? sha256(b) : null;
    idx.shaCache.set(rel, h);
    return h;
  }
  // waar staan de bestanden van dit stuk nu? → [{ deel, pad, waar: raw_input|Bronnen|_INBOX|elders }]
  function vindOrigineel(k, idx) {
    const uit = [], gezien = new Set();
    function voeg(deel, rel) { if (gezien.has(rel)) return; gezien.add(rel); uit.push({ deel, pad: rel, waar: /\/Bronnen\//.test('/' + rel) ? 'Bronnen' : /\/raw_input\//.test('/' + rel) ? 'raw_input' : rel.startsWith('_INBOX/') ? '_INBOX' : 'elders' }); }
    // 1. het geschreven pad staat er nog met dezelfde bytes
    for (const p of k.paden) {
      if (!p.pad || !statVault(p.pad)) continue;
      if (/\.md$/i.test(p.pad)) { let t = null; try { t = leesVault(p.pad, NOTITIE_MAX * 4); } catch (e) { t = null; } if (t && new RegExp('^ovis_stuk:\\s*"?' + k.r.stuk_id + '"?\\s*$', 'm').test(t.slice(0, KOP_LEES))) voeg(p.deel, p.pad); }
      else if (p.sha && shaVan(idx, p.pad) === p.sha) voeg(p.deel, p.pad);
    }
    // 2. een .md met ovis_stuk in de frontmatter (verplaatst of hernoemd)
    for (const rel of idx.stuk.get(k.r.stuk_id) || []) voeg(null, rel);
    // 3. een bijlage of scan op sha256 (alleen bestanden van dezelfde grootte)
    for (const d of k.delen) {
      if (d.rol === 'origineel' && /^mail/.test(k.r.profiel)) continue;   // het .eml komt niet in de vault
      for (const rel of idx.maat.get(Number(d.grootte)) || []) if (shaVan(idx, rel) === d.sha256) voeg(d.deel, rel);
    }
    return uit.sort(function (a, b) { return a.pad < b.pad ? -1 : a.pad > b.pad ? 1 : 0; });
  }

  // ── inhoud ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  function notitie(k, ont, gevonden) {
    const r = k.r, meta = safeJson(r.meta) || {};
    const hoofd = k.ids.find(function (x) { return !x.bijlage; }) || k.ids[0];
    const bronInfo = ont.get(Number(hoofd.record)) || null;
    const versie = bronInfo ? (bronInfo.versies || []).find(function (v) { return Number(v.revision_id) === Number(hoofd.revisie); }) : null;
    const records = Array.from(new Set(k.ids.map(function (x) { return Number(x.record); })));
    const ontvangsten = [];
    for (const rec of records) { const b = ont.get(rec); if (b) for (const x of b.ontvangsten || []) ontvangsten.push(Object.assign({ record: rec }, x)); }
    const hoofdOnt = ontvangsten.filter(function (x) { return x.record === Number(hoofd.record); });
    const routes = Array.from(new Set(hoofdOnt.map(function (x) { return x.intake_route; }))).sort();
    const ontvangen = hoofdOnt.map(function (x) { return x.received_at; }).sort()[0] || r.ontvangen || r.aangemaakt;
    const gemarkeerd = !!(r.marker_patient && r.marker_patient !== 'geen');
    const onderwerp = !gemarkeerd && typeof meta.onderwerp === 'string' ? meta.onderwerp.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200) : '';
    const hoofdVault = gevonden.find(function (x) { return /\.md$/i.test(x.pad); }) || gevonden[0] || null;
    const fm = ['---', 'type: bron', 'domein: ' + (k.code === 'PRIVE' ? 'Prive' : 'Zakelijk'), 'status: actueel', 'updated: ' + (dagNl(versie && versie.recorded_at) || dagNl(ontvangen) || ''),
      'entiteit_id: ' + (k.code === 'INBOX' ? '' : k.code), 'ovis_bronnotitie: ' + r.stuk_id, 'source_record_id: ' + Number(hoofd.record),
      'revision_id: ' + Number(hoofd.revisie), 'sha256: ' + (versie && HEX64.test(versie.sha256) ? versie.sha256 : ''), 'ontvangen: ' + yv(ontvangen),
      'route: [' + routes.map(yv).join(', ') + ']', 'access_context: ' + (r.access_context || 'zakelijk_intern'),
      'origineel: ' + (hoofdVault ? yv(link(hoofdVault.pad)) : yv('niet gevonden')), 'sb_link: nee', 'gegenereerd_door: ovis-publicatie', '---', ''];
    const regels = ['', '# Bron ' + r.stuk_id, '',
      '_Gegenereerd door de publicatieservice van OVIS Intake uit de databank (alleen code, geen samenvatting). Niet met de hand wijzigen: de volgende ronde blokkeert dan op dit blok._', '',
      '| | |', '|---|---|',
      '| Soort | ' + cel(r.profiel) + ' |'];
    if (onderwerp) regels.push('| Onderwerp | ' + cel(onderwerp) + ' |');
    if (gemarkeerd) regels.push('| Let op | patiëntmarker: onderwerp en bestandsnamen weggelaten |');
    regels.push('| Ontvangen | ' + cel(klokNl(ontvangen)) + ' |', '| Bron / versie | ' + Number(hoofd.record) + ' / ' + Number(hoofd.revisie) + (versie && versie.version_label ? ' (' + cel(versie.version_label) + ')' : '') + ' |');
    regels.push('| Origineel | ' + (gevonden.length ? gevonden.map(function (x) { return cel(link(x.pad)); }).join('<br>') : 'niet gevonden in de raw_input/- en Bronnen/-mappen of _INBOX/') + ' |', '');
    regels.push('## Ontvangsten', '', '| ontvangen | route | toegang | bron |', '|---|---|---|---|');
    for (const x of ontvangsten.sort(function (a, b) { return String(a.received_at).localeCompare(String(b.received_at)) || a.occurrence_id - b.occurrence_id; }))
      regels.push('| ' + cel(klokNl(x.received_at)) + ' | ' + cel(x.intake_route) + ' | ' + cel(x.access_context) + ' | ' + x.record + (x.binnen ? ' (bijlage)' : '') + ' |');
    regels.push('', '## Onderdelen', '', '| deel | rol | naam | soort | grootte | sha256 |', '|---|---|---|---|---|---|');
    for (const d of k.delen) regels.push('| ' + cel(d.deel) + ' | ' + cel(d.rol) + ' | ' + (gemarkeerd ? '—' : cel(d.naam)) + ' | ' + cel(d.mime) + ' | ' + grootte(d.grootte) + ' | `' + String(d.sha256).slice(0, 12) + '` |');
    regels.push('');
    const kop = fm.join('\n');
    const blok = blokMet('bronnotitie', regels.join('\n'));
    const revs = Array.from(new Set(k.ids.map(function (x) { return Number(x.revisie); }))).sort(function (a, b) { return a - b; });
    return { kop, blok, hash: sha256(kop + blok), revs, ontvangen, routes, record: Number(hoofd.record), revisie: Number(hoofd.revisie) };
  }
  function registerBlok(rijen) {
    const regels = ['', '## Bronnotities uit OVIS Intake (gegenereerd)', '',
      '_Gegenereerd door de publicatieservice uit secondbrain.source_occurrence; één regel per bronnotitie, nieuwste eerst. Niet met de hand wijzigen; nieuwe regels van de verwerking horen in de tabel hierboven._', '',
      '| bronnotitie | ontvangen | route | bron / versie |', '|---|---|---|---|'];
    for (const x of rijen.sort(function (a, b) { return String(b.ontvangen).localeCompare(String(a.ontvangen)) || b.pad.localeCompare(a.pad); }))
      regels.push('| ' + cel(link(x.pad)) + ' | ' + cel(klokNl(x.ontvangen)) + ' | ' + cel(x.routes.join(', ')) + ' | ' + x.record + ' / ' + x.revisie + ' |');
    regels.push('');
    return blokMet('bronregister', regels.join('\n'));
  }

  // ── outbox ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  async function rpc(fn, body) {
    const r = await o.rpc(fn, body);
    if (r == null) throw new Error(fn + ': geen antwoord');
    return r;
  }
  // doel = { pad, blok, revs, hash, nieuw(tekstOud) → nieuwe tekst, gevonden(tekst) → { hash, kapot }, max }
  async function publiceer(doel, open, t) {
    const st = statVault(doel.pad);
    const oud = st ? leesVault(doel.pad, doel.max) : null;
    const g = doel.gevonden(oud);
    const o1 = open.get(doel.pad + '|' + doel.blok);
    if (o1 && o1.status === 'geblokkeerd_handmatig') { t.geblokkeerd++; t.blokkades.push(o1.outbox_id); return 'geblokkeerd'; }
    if (!o1 && g.hash === doel.hash) { t.gelijk++; return 'gelijk'; }
    const z = await rpc('sb2_publicatie_zet', { p: { doel_pad: doel.pad, blok_id: doel.blok, nieuwe_hash: doel.hash, gevonden_hash: g.hash, revision_ids: doel.revs || null } });
    if (z.niets) { t.afgerond++; return 'afgerond'; }   // open rij van een gecrashte ronde, bestand stond al goed (proef 7)
    if (z.geblokkeerd) { t.geblokkeerd++; t.blokkades.push(z.outbox_id); return 'geblokkeerd'; }
    if (!z.outbox_id) throw new Error('sb2_publicatie_zet: geen outbox_id');
    const besluit = await rpc('sb2_outbox_gevonden', { p_outbox_id: z.outbox_id, p_gevonden_hash: g.hash });
    if (besluit === 'al_klaar') { t.afgerond++; return 'al_klaar'; }
    if (besluit === 'blokkeer') { t.geblokkeerd++; t.nieuw_geblokkeerd.push(z.outbox_id); return 'blokkeer'; }
    if (besluit !== 'schrijf') { t.overig++; return String(besluit); }
    if (z.nieuwe_inhoud_hash && z.nieuwe_inhoud_hash !== doel.hash) { t.overig++; return 'andere_hash'; }   // hoort niet; volgende ronde opnieuw
    // een kapot blok (twee begin-markers, geen eind) overschrijven we nooit, ook niet na vrijgeven: eerst met de hand herstellen (review #4)
    if (g.kapot) { t.kapot++; return 'kapot'; }
    const tekst = doel.nieuw(oud);
    const ok = o.vv.schrijf(abs(doel.pad), tekst, { alsGelijk: function (nu2) {
      if (!st) return !nu2;
      return !!(nu2 && nu2.ino === st.ino && nu2.size === st.size && nu2.mtimeMs === st.mtimeMs);
    } });
    if (!ok) { t.tussendoor++; return 'tussendoor'; }   // iemand schreef intussen: rij blijft bezig, volgende ronde opnieuw
    if (o.naRename) o.naRename(doel.pad);
    const k = await rpc('sb2_outbox_klaar', { p_outbox_id: z.outbox_id, p_hash: doel.hash });
    if (k !== 'klaar') throw new Error('sb2_outbox_klaar: ' + String(k).slice(0, 40));
    t.geschreven++;
    return 'geschreven';
  }

  // ── de ronde ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  let bezig = false;
  async function ronde(opties) {
    opties = opties || {};
    const s = o.schakelaar ? o.schakelaar() : null;
    if (!s || s.aan !== true) return { uit: true };
    if (o.pauze && o.pauze()) return { wacht: 'onderhoud' };
    if (bezig) return { wacht: 'loopt al' };
    if (o.slot && !neemSlot(o.slot)) return { wacht: 'andere ronde' };
    bezig = true;
    const start = nu();
    const t = { kandidaten: 0, in_scope: 0, geschreven: 0, gelijk: 0, afgerond: 0, geblokkeerd: 0, tussendoor: 0, kapot: 0, geweigerd: 0, overig: 0, fout: 0, blokkades: [], nieuw_geblokkeerd: [], per_entiteit: {} };
    // een blijvende weigering van de databank (http 400: poort, onbekende versie) telt apart, zodat één stuk niet elke nacht de stap rood maakt (review #9)
    function fouteStap(e) { if (/http 400\b/.test(String(e && e.message || ''))) t.geweigerd++; else t.fout++; fout('intake-publicatie', e); }
    try {
      const codes = (Array.isArray(s.entiteiten) ? s.entiteiten : []).filter(function (c) { return ENTITEIT_MAP[c]; });
      const kand = kandidaten(codes);
      t.kandidaten = kand.lijst.length; t.overgeslagen = kand.overgeslagen;
      // ontvangsten uit secondbrain (alleen voor wat in scope is)
      const scope = kand.lijst.filter(function (k) { return k.scope; });
      t.in_scope = scope.length;
      const recs = Array.from(new Set([].concat.apply([], scope.map(function (k) { return k.ids.map(function (x) { return Number(x.record); }); }))));
      const ont = new Map();
      for (let i = 0; i < recs.length; i += RPC_BATCH) {
        const r = await rpc('sb2_bron_ontvangsten', { p_record_ids: recs.slice(i, i + RPC_BATCH) });
        if (!Array.isArray(r)) throw new Error('sb2_bron_ontvangsten: geen lijst');
        for (const b of r) ont.set(Number(b.source_record_id), b);
      }
      const openLijst = scope.length ? await rpc('sb2_publicatie_open', {}) : [];
      const open = new Map((Array.isArray(openLijst) ? openLijst : []).map(function (x) { return [x.doel_pad + '|' + x.blok_id, x]; }));
      // telling per entiteit (ook buiten de scope: de vergelijking met de oude skill), index alleen waar kandidaten zijn
      const perCode = new Map();
      for (const k of kand.lijst) { if (!perCode.has(k.code)) perCode.set(k.code, []); perCode.get(k.code).push(k); }
      const indexen = new Map();
      for (const [code, lijst] of perCode) {
        const sleutel = code === 'PRIVE' ? 'prive' : 'zakelijk';
        if (!indexen.has(sleutel)) indexen.set(sleutel, bouwIndex(code));
        const idx = indexen.get(sleutel);
        const pe = { stukken: lijst.length, in_scope: 0, bronnotities: 0, oud_bronnen: 0, oud_raw_input: 0, gelogd: 0, geblokkeerd: 0, niet_gevonden: 0 };
        let regLog = '';
        const regPad = ENTITEIT_MAP[code] + '/Bronnen/_register.md';
        try { const rt = leesVault(regPad, REGISTER_MAX); if (rt) { const b = vindBlok(rt, REG_BEGIN_RE); regLog = b && !b.kapot ? rt.slice(0, b.begin) + rt.slice(b.eind) : rt; } } catch (e) { regLog = ''; }
        const regRijen = [];
        const bronnenMap = !!(function () { try { return fs.lstatSync(abs(ENTITEIT_MAP[code] + '/Bronnen')).isDirectory(); } catch (e) { return false; } })();
        for (const k of lijst) {
          if (k.scope && o.pauze && o.pauze()) { t.wacht = 'onderhoud'; break; }   // onderhoudsstand of grendel halverwege: stoppen (review #3)
          const gevonden = vindOrigineel(k, idx);
          if (gevonden.some(function (x) { return x.waar === 'Bronnen'; })) pe.oud_bronnen++;
          else if (gevonden.some(function (x) { return x.waar === 'raw_input' || x.waar === '_INBOX'; })) pe.oud_raw_input++;
          else pe.niet_gevonden++;
          if (regLog.indexOf(k.r.stuk_id) >= 0) pe.gelogd++;
          if (!k.scope) continue;
          pe.in_scope++;
          if (!bronnenMap) { t.overig++; continue; }
          const datum = dagNl(k.r.ontvangen || k.r.aangemaakt);
          if (!datum) { t.overig++; continue; }
          const pad = ENTITEIT_MAP[code] + '/Bronnen/' + datum + '_' + k.r.stuk_id + '.md';
          let n = null;
          try { n = notitie(k, ont, gevonden); } catch (e) { t.fout++; fout('intake-publicatie', e); }
          if (n) try {
            const u = await publiceer({ pad, blok: 'bronnotitie', revs: n.revs, hash: n.hash, max: NOTITIE_MAX,
              gevonden: notitieHash, nieuw: function (oud) { const h = oud == null ? null : notitieHash(oud); return n.kop + n.blok + (h && h.staart != null ? h.staart : '\n'); } }, open, t);
            if (u === 'geblokkeerd' || u === 'blokkeer') pe.geblokkeerd++;
          } catch (e) { fouteStap(e); }
          if (statVault(pad)) {   // een bestaande notitie staat altijd in het register, ook als deze ronde voor dat stuk faalde (review #8)
            pe.bronnotities++;
            const hoofd = k.ids.find(function (x) { return !x.bijlage; }) || k.ids[0];
            regRijen.push(n ? { pad, ontvangen: n.ontvangen, routes: n.routes, record: n.record, revisie: n.revisie }
              : { pad, ontvangen: k.r.ontvangen || k.r.aangemaakt, routes: [], record: Number(hoofd.record), revisie: Number(hoofd.revisie) });
          }
        }
        if (regRijen.length && bronnenMap && !t.wacht) {
          const blok = registerBlok(regRijen);
          try {
            await publiceer({ pad: regPad, blok: 'bronregister', revs: null, hash: sha256(blok), max: REGISTER_MAX, gevonden: registerHash,
              nieuw: function (oud) {
                if (oud == null) return '---\ntype: bronnenregister\nentiteit_id: ' + (code === 'INBOX' ? '' : code) + '\n---\n\n# Bronnenregister\n' + blok + '\n';
                const b = vindBlok(oud, REG_BEGIN_RE);
                if (b && !b.kapot) return oud.slice(0, b.begin) + blok + oud.slice(b.eind);
                return oud.replace(/\n*$/, '\n\n') + blok + '\n';
              } }, open, t);
          } catch (e) { fouteStap(e); }
        }
        t.per_entiteit[code] = pe;
        if (t.wacht) break;
      }
      if (t.nieuw_geblokkeerd.length && o.meld) {
        try { o.meld('publicatieservice: ' + t.nieuw_geblokkeerd.length + ' blok(ken) met de hand gewijzigd (outbox ' + t.nieuw_geblokkeerd.slice(0, 10).join(', ') + '); niets geschreven op die plek'); } catch (e) { fout('intake-publicatie', e); }
      }
      if (t.geschreven || t.afgerond || t.nieuw_geblokkeerd.length || t.fout || t.geweigerd) {
        try {
          await rpc('sb2_publicatie_run', { p: { versie: (o.versie && o.versie()) || '', details: { kandidaten: t.kandidaten, in_scope: t.in_scope, geschreven: t.geschreven,
            gelijk: t.gelijk, afgerond: t.afgerond, geblokkeerd: t.geblokkeerd, tussendoor: t.tussendoor, kapot: t.kapot, geweigerd: t.geweigerd, fout: t.fout } } });
        } catch (e) { fout('intake-publicatie', e); }
      }
    } catch (e) {
      t.fout++; t.reden = String(e && e.message || e).slice(0, 120); fout('intake-publicatie', e);
    } finally { bezig = false; if (o.slot) laatSlot(o.slot); }
    t.ms = nu() - start;
    t.op = new Date(nu()).toISOString();
    laatsteRonde = Object.assign({}, t, { blokkades: t.blokkades.length, nieuw_geblokkeerd: t.nieuw_geblokkeerd.length });
    if (o.staatBestand) { try { const tmp = o.staatBestand + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(laatsteRonde), { mode: 0o600 }); fs.renameSync(tmp, o.staatBestand); } catch (e) { fout('intake-publicatie', e); } }
    log('intake-publicatie kandidaten=' + t.kandidaten + ' in_scope=' + t.in_scope + ' geschreven=' + t.geschreven + ' gelijk=' + t.gelijk + ' afgerond=' + t.afgerond + ' geblokkeerd=' + t.geblokkeerd + ' tussendoor=' + t.tussendoor + ' kapot=' + t.kapot + ' geweigerd=' + t.geweigerd + ' fout=' + t.fout + (t.wacht ? ' wacht=' + t.wacht : '') + ' ms=' + t.ms);
    return t;
  }
  function laatste() { return laatsteRonde; }
  return { ronde, laatste };
}

module.exports = { maak, entiteitVanPad, vindBlok, notitieHash, registerHash, blokMet, ENTITEIT_MAP, REG_BEGIN_RE, NOTITIE_BEGIN_RE };
