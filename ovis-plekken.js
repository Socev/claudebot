'use strict';
// ovis-plekken.js — OVIS-koppelregels plek 9–12 (wv1013, 28-10-2026) en 13–14 gezondheid (wv1774); architectuur "OVIS - architectuur
// (Intake, Brain, Socev)" § 4 rijen 9–14; ontwerp /opt/data/mk-scripts/wv1013/ontwerp.md en wv1774/ontwerp.md.
//
// WAAROM. David 23-10: "Deze aanpassing moet voor alles ontwikkeld en uitgerold … een route naar volwassenheid." Elke opslagplek krijgt
// één bron per veld, een zichtbare koppeling en een Bibliothecaris die een verschil ziet voordat het schade doet. Deze module doet de
// vier kleinere plekken naast de motor van ovis-register.js (zelfde blok, zelfde bevindingen, zelfde nachtvenster), in een eigen bestand
// zodat plek 7 en 8 (tegelijk gebouwd) niet in dezelfde regels schrijven:
//   9  R2 fin-bronnen ⇄ D1 fin.bron ⇄ bronnenregister.md — R2 en D1 zijn bron; het register is een gegenereerd blok (nacht).
//  10  Woordenlijst ⇄ entiteitenregister — het register (secondbrain.knoop) is bron; het blok Entiteiten is weergave (Data Manager, zo).
//  11  Deadlines.md — de pagina is bron; de Bibliothecaris ziet ongeldige en dode regels en wat verlopen is zonder afhandeling.
//  12  90_Cijfermeester ⇄ supabase zorgdata — de databank (bronnen/producten) noemt het bestand; het bestand moet er zijn en andersom.
//  13  D1 knie ⇄ 20_Prive/Gezondheid — de knie-app is bron; een pagina verwijst alleen; de verwijzing moet een rij vinden.
//  14  health-pod ⇄ 20_Prive/Gezondheid — idem, via hp.py; een actuele pagina mag geen vervangen (append-only) rij noemen.
// Alles alleen lezen, behalve het blok op bronnenregister.md (alleen in de nacht, onder de grendel, met de regels van de motor).
// Niet gemeten is niet opgelost: een plek die niet te lezen is, laat haar bevindingen open (zoals plek 4–6).
// Geen sleutels in dit bestand: de aanroeper geeft d1(batch), r2(), kn(batch), hp(pad) en sbRpc mee (server.js en ovis-run.js, elk met
// hun eigen omgeving).
const crypto = require('crypto');
const path = require('path');
const R = require('./ovis-register.js');

const R2B_PAD = '10_Zakelijk/_Gedeeld/Financiele_Datahub/bronnenregister.md';
const R2B_SLEUTELS = ['cloudflare:d1-fin/bron', 'cloudflare:r2-fin-bronnen'];
const R2_PREFIX = 'fin-bronnen/';
const R2B_SQL = [{ sql: 'select id, entiteit, soort, titel, datum, periode_van, periode_tot, r2_sleutel, gecontroleerd, opmerking from bron order by id', params: [] }];
const WL_PAD = '00_Systeem/Woordenlijst.md';
const WL_OUD_DAGEN = 8;   // de Data Manager bouwt het blok elke zondag; ouder dan 8 dagen én achter = er draait niets meer
const DL_PAD = '00_Systeem/Deadlines.md';
const DL_VERLOPEN_DAGEN = 14;
const DL_KLAAR_RE = /\b(AFGEHANDELD|LOSGELATEN|VERVALLEN|GEDAAN|AFGEROND|GESLOTEN|INGEDIEND|VERSTUURD|BETAALD|GETEKEND|BESLOTEN|ACHTERHAALD|VERLOPEN)\b/i;
const CM_MAP = '90_Cijfermeester';
const CM_MAPPEN = ['10_Verwerkt', '20_Producten'];
const CM_BIBLIOTHEEK = '90_Cijfermeester/Bibliotheek.md';
const REST_BEVINDING_RE = /^BB\d-(r2|wl|dl|cm|kn|hp)-/;   // wv1774: + kn (D1 knie), hp (health-pod)
const PLEK_VAN = { r2: 'r2', wl: 'wl', dl: 'dl', cm: 'cm', kn: 'kn', hp: 'hp' };

function h6(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 6); }
function schoon(s, n) { return R.schoon(String(s == null ? '' : s).replace(/\s+/g, ' ').trim(), n || 200); }   // met het sleutelfilter van de motor
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ''); }
function amsDatum(ms) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day;
}
function dagenTussen(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }
function cellen(regel) { return regel.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(function (x) { return x.replace(/\\\|/g, '|').trim(); }); }

// ── plek 9: R2 fin-bronnen ⇄ D1 bron ⇄ bronnenregister.md ──
// R2-lijst met de jurisdictiekop (de bucket staat in de EU; zonder kop 404). fetchFn en token van de aanroeper; hooguit 10 pagina's.
async function r2Lijst(fetchFn, tok, acc, bucket) {
  if (!tok) throw new Error('geen Cloudflare-sleutel');
  const uit = []; let cur = null;
  for (let i = 0; i < 10; i++) {
    const url = 'https://api.cloudflare.com/client/v4/accounts/' + acc + '/r2/buckets/' + encodeURIComponent(bucket) + '/objects?per_page=1000' + (cur ? '&cursor=' + encodeURIComponent(cur) : '');
    const r = await fetchFn(url, { headers: { Authorization: 'Bearer ' + tok, 'cf-r2-jurisdiction': 'eu' }, signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(function () { return null; });
    if (!r.ok || !j || j.success !== true || !Array.isArray(j.result)) throw new Error('R2 http ' + r.status);
    j.result.forEach(function (o) { if (o && typeof o.key === 'string') uit.push({ key: o.key, size: Number(o.size) || 0 }); });
    const ri = j.result_info || {};
    if (!ri.is_truncated || !ri.cursor) return uit;
    cur = ri.cursor;
  }
  throw new Error('R2: meer dan 10 pagina\'s');
}
// io: { d1(batch) → [{ results }], r2() → [{ key, size }] } → { bron, r2 } of { fout }
async function r2bMeting(io) {
  try {
    if (!io || typeof io.d1 !== 'function' || typeof io.r2 !== 'function') return { fout: 'geen lezer voor D1/R2' };
    const d = await io.d1(R2B_SQL);
    const bron = d && d[0] && Array.isArray(d[0].results) ? d[0].results : null;
    if (!bron || !bron.length) return { fout: 'D1 bron leeg of niet te lezen' };
    const r2 = await io.r2();
    if (!Array.isArray(r2) || !r2.length) return { fout: 'R2 fin-bronnen leeg of niet te lezen' };
    return { bron: bron, r2: r2 };
  } catch (e) { return { fout: String(e && e.message || e).slice(0, 120) }; }
}
function cel(s) { const t = String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').trim(); return t || '—'; }
// Het blok: de tabel zoals het handwerk-register hem had, nu uit D1. Geen datum erin (alleen schrijven als er echt iets veranderde).
function r2bBlokTekst(bron) {
  const rijen = bron.slice().sort(function (a, b) {
    return String(a.entiteit || '').localeCompare(String(b.entiteit || '')) || String(a.soort || '').localeCompare(String(b.soort || '')) ||
      String(a.titel || '').localeCompare(String(b.titel || '')) || (Number(a.id) - Number(b.id));
  });
  const binnen = '\n' + ['## Bronnen in de datahub', '',
    '*Gegenereerd door de OVIS-compiler (nacht) uit D1 `fin.bron`; niet met de hand bewerken. Een nieuwe bron staat hier de nacht na het laden (`intake.py`). ' +
    'Laadcontrole = D1 `gecontroleerd`: de controle bij het laden sloot (balans, totaal); dat zegt niet dat David het document nakeek. Controle = D1 `opmerking`.*', '',
    '| # | Entiteit | Soort | Titel | Datum | Periode | R2-sleutel | Laadcontrole | Controle |', '|---|---|---|---|---|---|---|---|---|']
    .concat(rijen.map(function (r) {
      const per = (r.periode_van || r.periode_tot) ? (r.periode_van || '') + ' – ' + (r.periode_tot || '') : '—';
      return '| ' + [r.id, cel(r.entiteit), cel(r.soort), cel(r.titel), cel(r.datum), cel(per), r.r2_sleutel ? '`' + String(r.r2_sleutel).replace(/`/g, '') + '`' : '—',
        Number(r.gecontroleerd) ? 'ja' : '—', cel(r.opmerking)].join(' | ') + ' |';
    })).join('\n') + '\n';
  return '<!-- ovis:blok begin id="fin-bronnen" content_hash="' + R.blokHash(binnen) + '" -->' + binnen + R.BLOK_EIND;
}
function leesR2bPagina(tekst) {
  const uit = { pad: R2B_PAD, fouten: [] };
  if (tekst === null || tekst === undefined) { uit.fouten.push('pagina ontbreekt'); return uit; }
  const fm = R.frontmatter(tekst);
  if (fm.fout) { uit.fouten.push(fm.fout); return uit; }
  const va = R.vingerafdruk(tekst);
  if (va.fout) { uit.fouten.push(va.fout); return uit; }
  uit.sha = va.sha; uit.tekst = tekst;
  const ov = fm.velden.ovis && typeof fm.velden.ovis === 'object' && !Array.isArray(fm.velden.ovis) ? fm.velden.ovis : {};
  const db = Array.isArray(ov.db) ? ov.db.map(String) : ov.db ? [String(ov.db)] : [];
  R2B_SLEUTELS.forEach(function (s) { if (db.indexOf(s) < 0) uit.fouten.push('ovis.db noemt ' + s + ' niet'); });
  return uit;
}
function r2bChecks(m, pagina, bev, tel) {
  tel.r2_bronnen = 0; tel.r2_objecten = 0; tel.r2_verschil = 0; tel.r2_verouderd = 0;
  const r2 = {}; m.r2.forEach(function (o) { r2[o.key] = o; });
  tel.r2_objecten = m.r2.length; tel.r2_bronnen = m.bron.length;
  const perSleutel = {};
  m.bron.forEach(function (r) {
    if (!r.r2_sleutel) return;
    const s = String(r.r2_sleutel);
    if (s.indexOf(R2_PREFIX) !== 0) { bev('BB6', 'r2-sleutel-' + r.id, 'bronrij #' + r.id + ' in de datahub heeft een R2-sleutel die niet met fin-bronnen/ begint', 'D1 fin.bron #' + r.id + ': r2_sleutel moet de vorm fin-bronnen/<pad> hebben. Voorstel: de sleutel in D1 rechtzetten (machinekamer, migratie).'); return; }
    (perSleutel[s.slice(R2_PREFIX.length)] = perSleutel[s.slice(R2_PREFIX.length)] || []).push(r.id);
  });
  Object.keys(perSleutel).sort().forEach(function (k) {
    if (perSleutel[k].length > 1) bev('BB5', 'r2-' + h6(k) + '-dubbel', 'twee bronrijen in de datahub noemen hetzelfde R2-bestand', 'D1 fin.bron #' + perSleutel[k].join(', #') + ' noemen allebei ' + schoon(k, 160) + '. Voorstel: nagaan of het een herlaad was; de oude rij weg (machinekamer).');
    if (!r2[k]) bev('BB1', 'r2-' + h6(k) + '-geen-bestand', 'bronrij #' + perSleutel[k][0] + ' verwijst naar een bestand dat niet in R2 staat', 'D1 fin.bron #' + perSleutel[k].join(', #') + ' noemt ' + schoon(k, 160) + ', maar R2 fin-bronnen heeft dat object niet. Voorstel: het origineel opnieuw uploaden (intake.py) of de sleutel leegmaken.', 'serious');
  });
  m.r2.forEach(function (o) {
    if (!perSleutel[o.key]) bev('BB2', 'r2-' + h6(o.key) + '-geen-rij', 'bestand in R2 fin-bronnen zonder bronrij in de datahub', 'R2 fin-bronnen/' + schoon(o.key, 160) + ' staat in geen enkele rij van D1 fin.bron. Voorstel: de rij alsnog laden (intake.py) of het object weghalen na Davids Ja.');
  });
  if (pagina.fouten.length) { tel.r2_half = true; bev('BB6', 'r2-pagina', 'bronnenregister van de datahub niet te koppelen: ' + pagina.fouten[0], R2B_PAD + ': ' + pagina.fouten.join('; ') + '. Voorstel: frontmatter herstellen (ovis.db met ' + R2B_SLEUTELS.join(' en ') + ').'); }
  else if (R.blokHandwerk(pagina.tekst)) bev('BB6', 'r2-blok', 'in het gegenereerde blok van het bronnenregister is met de hand iets veranderd', R2B_PAD + ': de tekst binnen het OVIS-blok is niet meer wat de compiler schreef; hij overschrijft het niet. Voorstel: wat erin getypt is naar D1 (opmerking/gecontroleerd), daarna het blok laten vernieuwen.');
  else if (R.huidigBlok(pagina.tekst) !== r2bBlokTekst(m.bron)) tel.r2_verouderd = 1;   // BB4: alleen telling; de nacht vernieuwt
}

// ── plek 10: Woordenlijst ⇄ entiteitenregister ──
// Regel: "- var · var [knoop:XX] — [[pad]]". Alleen het blok Entiteiten is weergave van het register; [knoop:XX] elders is een verwijzing.
const WL_KNOOP_RE = /\[knoop:([A-Za-z0-9:_-]+)\]/;
function leesWoordenlijst(tekst) {
  const uit = { fouten: [], blok: null, datum: null, verwijzingen: [] };
  if (tekst === null || tekst === undefined) { uit.fouten.push('pagina ontbreekt'); return uit; }
  const t = String(tekst).replace(/\r\n?/g, '\n');
  const b = t.indexOf('<!-- GEGENEREERD:entiteiten BEGIN -->'), e = t.indexOf('<!-- GEGENEREERD:entiteiten EIND -->');
  if (b < 0 || e < b) { uit.fouten.push('blok Entiteiten ontbreekt of is half'); return uit; }
  const binnen = t.slice(b, e);
  const md = /Gegenereerd (\d{4}-\d{2}-\d{2})/.exec(binnen);
  uit.datum = md ? md[1] : null;
  uit.blok = {};
  binnen.split('\n').forEach(function (r) {
    if (!/^- /.test(r)) return;
    const m = WL_KNOOP_RE.exec(r);
    if (!m) return;
    const voor = r.slice(2, r.indexOf(' — ') > 0 ? r.indexOf(' — ') : r.length).replace(WL_KNOOP_RE, '');
    uit.blok[m[1]] = new Set(voor.split(' · ').map(function (v) { return norm(v.replace(/\*\*/g, '')); }).filter(Boolean));
  });
  const buiten = t.slice(0, b) + t.slice(e);
  buiten.split('\n').forEach(function (r) { const m = /^- (?!\?)/.test(r) && WL_KNOOP_RE.exec(r); if (m) uit.verwijzingen.push(m[1]); });
  return uit;
}
function wlChecks(wl, knopen, vandaag, bev, tel) {
  tel.wl_regels = 0; tel.wl_verouderd = 0;
  if (wl.fouten.length) { bev('BB6', 'wl-blok', 'Woordenlijst: ' + wl.fouten[0], WL_PAD + ': ' + wl.fouten.join('; ') + '. Voorstel: `woordenlijst.py bouw` (machinekamer) zet het blok terug.'); return { half: true }; }
  const reg = {}; knopen.forEach(function (k) { reg[k.id] = k; });
  tel.wl_regels = Object.keys(wl.blok).length;
  Array.from(new Set(wl.verwijzingen)).sort().forEach(function (id) {
    if (!reg[id]) bev('BB1', 'wl-knoop-' + h6(id), 'Woordenlijst noemt een knoop die niet in het register staat', WL_PAD + ': een handmatige regel hangt aan [knoop:' + (/^per:/.test(id) ? 'per:…' : schoon(id, 40)) + '], die het entiteitenregister niet kent. Voorstel: de verwijzing goedzetten of weghalen (machinekamer).');
  });
  let achter = 0;
  Object.keys(reg).forEach(function (id) {
    const v = wl.blok[id];
    if (!v) { achter++; return; }
    const k = reg[id];
    const moet = [k.naam].concat(Array.isArray(k.aliassen) ? k.aliassen : []).filter(function (x) { return x && String(x).length <= 60; }).map(norm).filter(Boolean);
    if (moet.some(function (x) { return !v.has(x); })) achter++;
  });
  Object.keys(wl.blok).forEach(function (id) { if (!reg[id]) achter++; });
  tel.wl_verouderd = achter;
  if (achter && (!wl.datum || dagenTussen(wl.datum, vandaag) > WL_OUD_DAGEN))
    bev('BB4', 'wl-oud', 'Woordenlijst loopt achter op het entiteitenregister (' + achter + ' regel(s), blok van ' + (wl.datum || '?') + ')',
      WL_PAD + ': het blok Entiteiten is meer dan ' + WL_OUD_DAGEN + ' dagen oud en wijkt af van secondbrain.knoop (naam, actieve aliassen, ontbrekende of vervallen knopen). De Data Manager bouwt het elke zondag uit register.json (nacht-export). Voorstel: `woordenlijst.py bouw` en nagaan waarom de zondagsronde het niet deed.');
}

// ── plek 11: Deadlines.md ──
function leesDeadlines(tekst) {
  const uit = { fouten: [], rijen: [] };
  if (tekst === null || tekst === undefined) { uit.fouten.push('pagina ontbreekt'); return uit; }
  let sectie = null, kop = null, gevonden = false;
  String(tekst).replace(/\r\n?/g, '\n').split('\n').forEach(function (r) {
    if (/^## /.test(r)) { sectie = r.slice(3).trim(); kop = null; return; }
    if (sectie !== 'Actueel' || !/^\|/.test(r)) return;
    const c = cellen(r);
    if (!kop) { kop = c; gevonden = true; return; }
    if (/^-+$/.test(c[0].replace(/[:\s]/g, ''))) return;
    uit.rijen.push(c);
  });
  if (!gevonden) uit.fouten.push('tabel Actueel ontbreekt');
  return uit;
}
function linkDoel(l) { return String(l).replace(/\\$/, '').split('|')[0].split('#')[0].trim(); }
function dlChecks(dl, vandaag, bestaat, bev, tel, paden) {
  tel.dl_rijen = 0; tel.dl_verlopen = 0; tel.dl_links = 0;
  if (dl.fouten.length) { bev('BB6', 'dl-pagina', 'deadline-register niet te lezen: ' + dl.fouten[0], DL_PAD + ': ' + dl.fouten.join('; ') + '. Voorstel: de tabel onder ## Actueel herstellen.'); return { half: true }; }
  const verlopen = [];
  dl.rijen.forEach(function (c) {
    tel.dl_rijen++;
    const datum = c[0] || '', ent = schoon(c[1] || '', 30), tekst = (c[2] || '') + ' ' + (c[3] || '');
    const links = []; let m; const re = /\[\[([^\]]+)\]\]/g;
    while ((m = re.exec(c.join(' | '))) !== null) links.push(linkDoel(m[1]));
    const sleutel = h6(datum + '|' + (c[1] || '') + '|' + (links[0] || ''));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) { bev('BB6', 'dl-datum-' + sleutel, 'deadline zonder geldige datum (' + schoon(datum, 20) + ', ' + ent + ')', DL_PAD + ', Actueel: de kolom Datum moet JJJJ-MM-DD zijn (' + schoon(datum, 20) + ', entiteit ' + ent + '). Voorstel: de juiste dag invullen of de regel naar Kandidaten.'); return; }
    links.forEach(function (l) {
      if (l.indexOf('/') < 0 || l.indexOf('..') >= 0 || l.charAt(0) === '/') return;   // alleen volledige vaultpaden zijn te toetsen (wikilink-conventie)
      tel.dl_links++;
      // alleen de map in de bevinding (een bestandsnaam kan een persoon noemen); het volle pad staat in de machinekamer-uitvoer (paden)
      if (!bestaat(l) && !bestaat(l + '.md')) { if (paden) paden['BB6-dl-link-' + h6(l)] = l; bev('BB6', 'dl-link-' + h6(l), 'deadline verwijst naar een pagina die er niet (meer) is (' + datum + ', ' + ent + ')', DL_PAD + ', Actueel: de bronlink van de deadline van ' + datum + ' (' + ent + ') wijst naar een pagina onder ' + schoon(l.split('/').slice(0, 2).join('/'), 60) + '/… die niet bestaat. Voorstel: de verhuisde pagina zoeken en de link goedzetten.'); }
    });
    if (dagenTussen(datum, vandaag) > DL_VERLOPEN_DAGEN && !DL_KLAAR_RE.test(tekst)) verlopen.push(datum);
  });
  tel.dl_verlopen = verlopen.length;
  tel.dl_intake = 'nog geen deadlines uit Intake';   // Intake stap 3: dan eist de Bibliothecaris per Intake-deadline een rij met bron-stuk
  if (verlopen.length) bev('BB6', 'dl-verlopen', verlopen.length + ' deadline(s) in Actueel meer dan ' + DL_VERLOPEN_DAGEN + ' dagen verlopen zonder afhandeling',
    DL_PAD + ': ' + verlopen.length + ' regel(s) onder Actueel met een datum van meer dan ' + DL_VERLOPEN_DAGEN + ' dagen geleden en geen afhandelwoord (oudste ' + verlopen.slice().sort()[0] + '). Niemand verplaatst ze; de heartbeat leest ze elke keer. Voorstel: per regel nagaan of het gedaan is en naar ## Afgehandeld (machinekamer of nachtconsolidatie), of de datum bijwerken.');
}

// ── plek 12: 90_Cijfermeester ⇄ zorgdata ──
// io.sbRpc('ovis_zorgdata_paden') → { bronnen: [{ id, bestandspad, in_bibliotheek }], producten: [{ id, bestandspad }] }
async function cmMeting(io) {
  try {
    if (!io || typeof io.sbRpc !== 'function') return { fout: 'geen databanklezer' };
    const j = await io.sbRpc('ovis_zorgdata_paden', {});
    if (!j || !Array.isArray(j.bronnen) || !Array.isArray(j.producten) || !j.bronnen.length) return { fout: 'zorgdata leeg of niet te lezen' };
    return { bronnen: j.bronnen, producten: j.producten };
  } catch (e) { return { fout: String(e && e.message || e).slice(0, 120) }; }
}
// "10_Verwerkt/X <jaar> - y.csv (14 jaargangen)" → patroon; anders het pad zelf
function cmPatroon(p) {
  const s = String(p).replace(/\s+\([^()]*\)\s*$/, '').trim();
  if (s.indexOf('<') < 0) return { pad: s };
  return { re: new RegExp('^' + s.split(/<[^<>]+>/).map(function (x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('[^/]+') + '$'), pad: s };
}
function cmChecks(m, bestanden, bibliotheek, bev, tel, bestaat) {
  tel.cm_bronnen = m.bronnen.length; tel.cm_producten = m.producten.length; tel.cm_bestanden = bestanden.length; tel.cm_verouderd = 0;
  const gedekt = new Set(), alle = new Set(bestanden);
  function toets(soort, r) {
    if (!r.bestandspad) return;
    const p = cmPatroon(r.bestandspad);
    // een pad buiten 10_Verwerkt/20_Producten (bv. in de hoofdmap) telt als het bestand bestaat; BB2 kijkt alleen in die twee mappen
    const treffers = p.re ? bestanden.filter(function (b) { return p.re.test(b); }) : alle.has(p.pad) || (bestaat && p.pad.indexOf('..') < 0 && bestaat(CM_MAP + '/' + p.pad)) ? [p.pad] : [];
    treffers.forEach(function (b) { gedekt.add(b); });
    if (!treffers.length) bev('BB1', 'cm-' + soort + r.id + '-geen-bestand', 'Cijfer-Meester: ' + (soort === 'b' ? 'bron' : 'product') + ' #' + r.id + ' verwijst naar een bestand dat er niet is',
      'zorgdata.' + (soort === 'b' ? 'bronnen' : 'producten') + ' #' + r.id + ' noemt ' + schoon(p.pad, 160) + ' (onder ' + CM_MAP + '/), maar dat bestand bestaat niet. Voorstel: bestandspad in de databank gelijkzetten aan de echte naam (machinekamer), of het bestand terugzetten.');
  }
  m.bronnen.forEach(function (r) { toets('b', r); });
  m.producten.forEach(function (r) { toets('p', r); });
  bestanden.forEach(function (b) {
    if (gedekt.has(b)) return;
    bev('BB2', 'cm-' + h6(b) + '-geen-rij', 'Cijfer-Meester: bestand zonder rij in zorgdata', CM_MAP + '/' + schoon(b, 160) + ' staat in geen rij van zorgdata.bronnen of .producten. Voorstel: de Cijfer-Meester registreert het (bron of product), of het gaat naar het archief.');
  });
  if (bibliotheek === null) return { deels: ['BB4-cm-bibliotheek'] };
  if (bibliotheek) {
    const nb = m.bronnen.filter(function (r) { return r.in_bibliotheek === true; }).length;
    if (bibliotheek.bronnen !== nb || bibliotheek.producten !== m.producten.length) {
      tel.cm_verouderd = 1;
      bev('BB4', 'cm-bibliotheek', 'Bibliotheek van de Cijfer-Meester loopt achter op de databank', CM_BIBLIOTHEEK + ' zegt ' + bibliotheek.bronnen + ' bronnen en ' + bibliotheek.producten + ' producten; zorgdata heeft er ' + nb + ' (in de bibliotheek) en ' + m.producten.length + '. Niemand draait de generator vanzelf. Voorstel: `node 90_Cijfermeester/genereer_bibliotheek.js` (Cijfer-Meester of machinekamer).');
    }
  }
}
function leesBibliotheek(tekst) {
  if (!tekst) return null;
  const fm = R.frontmatter(tekst);
  if (fm.fout) return null;
  const b = Number(fm.velden.bronnen), p = Number(fm.velden.producten);
  return Number.isInteger(b) && Number.isInteger(p) ? { bronnen: b, producten: p } : null;
}

// ── plek 13–14: gezondheid (wv1774; architectuur § 2.4 en § 4 rijen 13–14) ──
// D1 knie en de health-pod zijn de bron; een pagina in 20_Prive/Gezondheid verwijst alleen (`cloudflare:d1-knie/<tabel>#<id>`,
// `olares:health-pod/<tabel>#<id>`, in ovis.db of in de tekst). Geen gegenereerd blok, geen waarden buiten de bron: de lezers vragen
// alleen sleutels op (D1: alleen de sleutelkolom; health-pod: id en vervangt_id). In bevinding, box en databank alleen de tabel, een
// korte hash en de map; een paginanaam kan medisch zijn, dus het volle pad en de verwijzing staan alleen in de machinekamer-uitvoer (paden).
const GZ_MAP = '20_Prive/Gezondheid';
const GZ_DIEPTE = 3;
const GZ_REF_RE = /\b(cloudflare:d1-knie|olares:health-pod)(?:\/([A-Za-z0-9_-]+))?(?:#([^\s`'"<>()[\]{},|]+))?/g;
// sleutel per tabel; andere tabellen (push_*, snooze, instellingen …) zijn machinestaat en niet te koppelen
const KN_TABELLEN = { mijlpalen: 'id', fases: 'id', compex: 'id', medicatie: 'id', dagen: 'datum', dagplan: 'datum', rondes: 'datum/slot' };
const KN_ID_RE = { id: /^[A-Za-z0-9_-]{1,64}$/, datum: /^\d{4}-\d{2}-\d{2}$/, 'datum/slot': /^\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_:-]{1,32}$/ };
// health-pod: alleen vaste GET-paden (de aanroeper toetst ze ook met HP_PAD_RE); lijsten met historie, zodat vervangen rijen zichtbaar zijn
const HP_LIJSTEN = ['diagnoses', 'gebeurtenissen', 'medicatie', 'kenmerken', 'bronnen'];
const HP_LIMIET = 1000;
const HP_PAD_RE = /^\/(?:(?:diagnoses|gebeurtenissen|medicatie|kenmerken|bronnen)\?historie=true&limiet=1000|rapporten\/\d{1,9}|metingen\/soorten)$/;
const GZ_ACTUEEL_RE = /^\s*(actueel|actief)\b/i;

function gzPagina(pad, tekst) {
  const fm = R.frontmatter(tekst);
  const status = fm.fout ? '' : String(fm.velden.status == null ? '' : fm.velden.status);
  const refs = new Set(); let m; GZ_REF_RE.lastIndex = 0;
  while ((m = GZ_REF_RE.exec(String(tekst))) !== null) refs.add(m[0].replace(/[.:;]+$/, ''));
  return { pad: pad, actueel: GZ_ACTUEEL_RE.test(status), refs: Array.from(refs).sort().map(function (r) {
    const x = /^(cloudflare:d1-knie|olares:health-pod)(?:\/([A-Za-z0-9_-]+))?(?:#(.+))?$/.exec(r);
    return { ref: r, plek: x[1] === 'cloudflare:d1-knie' ? 'kn' : 'hp', tabel: x[2] || null, id: x[3] == null ? null : x[3] };
  }) };
}
// alle pagina's onder 20_Prive/Gezondheid (hooguit 3 mappen diep, geen . of _); een map of pagina die niet te lezen is = niet gemeten
function gzLees(ctx, lees) {
  const paginas = [];
  function loop(rel, diepte) {
    const l = ctx.lijst(rel);
    l.slice().sort(function (a, b) { return a.naam.localeCompare(b.naam); }).forEach(function (x) {
      if (x.naam.startsWith('.') || x.naam.startsWith('_')) return;
      const r = rel + '/' + x.naam;
      if (x.map && diepte < GZ_DIEPTE) loop(r, diepte + 1);
      else if (x.bestand && /\.md$/i.test(x.naam)) {
        const t = lees(r);
        if (t === null) throw new Error('een gezondheidspagina is niet te lezen');
        paginas.push(gzPagina(r, t));
      }
    });
  }
  try { loop(GZ_MAP, 1); } catch (e) { return { fout: /niet te lezen/.test(e.message) ? e.message : GZ_MAP + ' niet te lezen' }; }
  return { paginas: paginas };
}
function gzBev(bev, paden, check, plek, p, r, soort, samenvatting, detail, ernst) {
  const sleutel = plek + '-' + h6(p.pad + '|' + r.ref) + '-' + soort;
  if (paden) paden[check + '-' + sleutel] = p.pad + ' → ' + r.ref;
  bev(check, sleutel, samenvatting, GZ_MAP + '/… (pagina ' + h6(p.pad) + '): ' + detail + ' Pagina en verwijzing staan in de droge uitvoer (`ovis-run.js bibliothecaris --afroep --droog`, paden).', ernst);
}
// plek 13: io.kn(batch) = D1 knie, alleen SELECT. Eerst de tabellen (bereikbaarheid), dan per tabel alleen de genoemde sleutels.
async function knMeting(io, paginas) {
  try {
    if (!io || typeof io.kn !== 'function') return { fout: 'geen lezer voor D1 knie' };
    const t = await io.kn([{ sql: "select name from sqlite_master where type = 'table'", params: [] }]);
    const tabellen = new Set((t && t[0] && Array.isArray(t[0].results) ? t[0].results : []).map(function (x) { return String(x.name); }));
    if (!tabellen.size) return { fout: 'D1 knie leeg of niet te lezen' };
    const vraag = {};
    paginas.forEach(function (p) { p.refs.forEach(function (r) {
      if (r.plek !== 'kn' || !r.tabel || r.id == null || !KN_TABELLEN[r.tabel] || !tabellen.has(r.tabel) || !KN_ID_RE[KN_TABELLEN[r.tabel]].test(r.id)) return;
      (vraag[r.tabel] = vraag[r.tabel] || new Set()).add(r.id);
    }); });
    const gevonden = {};
    for (const tab of Object.keys(vraag).sort()) {
      const ids = Array.from(vraag[tab]); gevonden[tab] = new Set();
      const kol = KN_TABELLEN[tab] === 'datum/slot' ? "datum || '/' || slot" : KN_TABELLEN[tab];
      for (let i = 0; i < ids.length; i += 50) {
        const deel = ids.slice(i, i + 50);
        const r = await io.kn([{ sql: 'select ' + kol + ' as k from ' + tab + ' where ' + kol + ' in (' + deel.map(function () { return '?'; }).join(', ') + ')', params: deel }]);
        if (!r || !r[0] || !Array.isArray(r[0].results)) return { fout: 'D1 knie: ' + tab + ' niet te lezen' };
        r[0].results.forEach(function (x) { gevonden[tab].add(String(x.k)); });
      }
    }
    return { tabellen: tabellen, gevonden: gevonden };
  } catch (e) { return { fout: String(e && e.message || e).slice(0, 120) }; }
}
function knChecks(m, paginas, bev, tel, paden) {
  tel.kn_paginas = 0; tel.kn_verwijzingen = 0; tel.kn_tabellen = m.tabellen.size;
  paginas.forEach(function (p) {
    const eigen = p.refs.filter(function (r) { return r.plek === 'kn'; });
    if (eigen.length) tel.kn_paginas++;
    eigen.forEach(function (r) {
      tel.kn_verwijzingen++;
      if (!r.tabel) { if (r.id != null) gzBev(bev, paden, 'BB6', 'kn', p, r, 'vorm', 'gezondheidspagina: verwijzing naar de knie-app zonder tabel', 'een verwijzing cloudflare:d1-knie#… noemt geen tabel. Voorstel: cloudflare:d1-knie/<tabel>#<sleutel> (machinekamer).'); return; }
      const t = schoon(r.tabel, 30);
      if (!KN_TABELLEN[r.tabel]) { gzBev(bev, paden, 'BB6', 'kn', p, r, 'vorm', 'gezondheidspagina verwijst naar een knie-tabel die niet te koppelen is (' + t + ')', 'cloudflare:d1-knie/' + t + ' is geen koppelbare tabel (wel: ' + Object.keys(KN_TABELLEN).join(', ') + '). Voorstel: de verwijzing goedzetten of weghalen (machinekamer).'); return; }
      if (!m.tabellen.has(r.tabel)) { gzBev(bev, paden, 'BB1', 'kn', p, r, 'geen-tabel', 'gezondheidspagina verwijst naar een knie-tabel die er niet (meer) is (' + t + ')', 'D1 knie heeft geen tabel ' + t + '. Voorstel: nagaan of de knie-app een migratie kreeg; de verwijzing bijwerken (machinekamer).'); return; }
      if (r.id == null) return;   // verwijzing naar de tabel als geheel: bestaat
      if (!KN_ID_RE[KN_TABELLEN[r.tabel]].test(r.id)) { gzBev(bev, paden, 'BB6', 'kn', p, r, 'vorm', 'gezondheidspagina: knie-verwijzing met een sleutel in de verkeerde vorm (' + t + ')', 'cloudflare:d1-knie/' + t + '#… moet de sleutel ' + KN_TABELLEN[r.tabel] + ' hebben. Voorstel: de verwijzing goedzetten (machinekamer).'); return; }
      if (!(m.gevonden[r.tabel] && m.gevonden[r.tabel].has(r.id))) gzBev(bev, paden, 'BB1', 'kn', p, r, 'geen-rij', 'gezondheidspagina verwijst naar een rij in de knie-app die niet bestaat (' + t + ')', 'de verwijzing cloudflare:d1-knie/' + t + '#… vindt geen rij in D1 knie. Voorstel: de verwijzing goedzetten of weghalen (machinekamer); de knie-app blijft de bron.');
    });
  });
}
// io.hp(pad) → { j } of { weigert: <http> }; gooit als de health-pod niet bereikbaar is. Uitslag van hp.py omzetten: zie hpUitslag.
function hpUitslag(r) {
  if (r && r.code === 0) {
    let j; try { j = JSON.parse(r.stdout); } catch (e) { throw new Error('health-pod: geen JSON'); }
    if (j && typeof j === 'object' && j._INGEKORT) throw new Error('health-pod: antwoord ingekort');
    return { j: j };
  }
  const m = r && r.code === 3 && /^POD WEIGERT: HTTP (\d{3})\b/.exec(String(r.stdout || ''));
  if (m) return { weigert: Number(m[1]) };
  throw new Error(r && r.signaal ? 'health-pod: tijdgrens' : 'health-pod niet bereikbaar (exit ' + (r ? r.code : '?') + ')');
}
async function hpMeting(io, paginas) {
  try {
    if (!io || typeof io.hp !== 'function') return { fout: 'geen lezer voor de health-pod' };
    const nodig = new Set(), rapporten = new Set();
    paginas.forEach(function (p) { p.refs.forEach(function (r) {
      if (r.plek !== 'hp' || !r.tabel) return;
      if (HP_LIJSTEN.indexOf(r.tabel) >= 0 || r.tabel === 'metingen') nodig.add(r.tabel);
      if (r.tabel === 'rapporten' && r.id != null && /^\d{1,9}$/.test(r.id)) rapporten.add(r.id);
    }); });
    const uit = { lijst: {}, soorten: null, rapporten: {} };
    for (const tab of Array.from(nodig).sort()) {
      if (tab === 'metingen') {
        const s = await io.hp('/metingen/soorten');
        if (!s.j || !Array.isArray(s.j.rijen)) return { fout: 'health-pod: meetsoorten niet te lezen' };
        uit.soorten = new Set(s.j.rijen.map(function (x) { return String(x.soort); }));
        continue;
      }
      const a = await io.hp('/' + tab + '?historie=true&limiet=' + HP_LIMIET);
      if (!a.j || !Array.isArray(a.j.rijen)) return { fout: 'health-pod: ' + tab + ' niet te lezen' };
      // een halve lijst is geen meting: dan zou elke ontbrekende rij als "bestaat niet" tellen
      if (a.j.rijen.length >= HP_LIMIET || (Number.isInteger(a.j.aantal) && a.j.aantal !== a.j.rijen.length)) return { fout: 'health-pod: ' + tab + ' niet volledig' };
      const ids = new Set(), vervangen = new Set();
      a.j.rijen.forEach(function (x) { ids.add(String(x.id)); if (x.vervangt_id != null) vervangen.add(String(x.vervangt_id)); });
      uit.lijst[tab] = { ids: ids, vervangen: vervangen };
    }
    for (const id of Array.from(rapporten).sort()) {
      const a = await io.hp('/rapporten/' + id);
      if (a.weigert === 404) uit.rapporten[id] = false;
      else if (a.j && String(a.j.id) === id) uit.rapporten[id] = true;
      else return { fout: 'health-pod: rapport niet te lezen' };
    }
    return uit;
  } catch (e) { return { fout: String(e && e.message || e).slice(0, 120) }; }
}
function hpChecks(m, paginas, bev, tel, paden) {
  tel.hp_paginas = 0; tel.hp_verwijzingen = 0;
  paginas.forEach(function (p) {
    const eigen = p.refs.filter(function (r) { return r.plek === 'hp'; });
    if (eigen.length) tel.hp_paginas++;
    eigen.forEach(function (r) {
      tel.hp_verwijzingen++;
      if (!r.tabel) { if (r.id != null) gzBev(bev, paden, 'BB6', 'hp', p, r, 'vorm', 'gezondheidspagina: verwijzing naar de health-pod zonder tabel', 'een verwijzing olares:health-pod#… noemt geen tabel. Voorstel: olares:health-pod/<tabel>#<id> (machinekamer).'); return; }
      const t = schoon(r.tabel, 30);
      const lijst = HP_LIJSTEN.indexOf(r.tabel) >= 0;
      if (!lijst && r.tabel !== 'rapporten' && r.tabel !== 'metingen') { gzBev(bev, paden, 'BB6', 'hp', p, r, 'vorm', 'gezondheidspagina verwijst naar een health-pod-tabel die niet te toetsen is (' + t + ')', 'olares:health-pod/' + t + ' is niet te toetsen (wel: ' + HP_LIJSTEN.concat(['rapporten', 'metingen#<soort>']).join(', ') + '). Voorstel: de verwijzing goedzetten of weghalen (machinekamer).'); return; }
      if (r.id == null) return;
      if (r.tabel === 'metingen') {   // een meting is niet per id op te vragen; de pagina noemt de reeks (soort)
        if (!/^[a-z0-9_]{1,40}$/.test(r.id)) { gzBev(bev, paden, 'BB6', 'hp', p, r, 'vorm', 'gezondheidspagina: verwijzing naar een meting in de verkeerde vorm', 'olares:health-pod/metingen#… noemt een meetsoort (bijv. #gewicht), geen meting-id. Voorstel: de verwijzing goedzetten (machinekamer).'); return; }
        if (!m.soorten.has(r.id)) gzBev(bev, paden, 'BB1', 'hp', p, r, 'geen-soort', 'gezondheidspagina verwijst naar een meetsoort die de health-pod niet kent', 'olares:health-pod/metingen#… is geen meetsoort in de health-pod. Voorstel: de verwijzing goedzetten of weghalen (machinekamer).');
        return;
      }
      if (!/^\d{1,9}$/.test(r.id)) { gzBev(bev, paden, 'BB6', 'hp', p, r, 'vorm', 'gezondheidspagina: health-pod-verwijzing zonder geldig id (' + t + ')', 'olares:health-pod/' + t + '#… moet een rijnummer hebben. Voorstel: de verwijzing goedzetten (machinekamer).'); return; }
      const bestaat = lijst ? m.lijst[r.tabel].ids.has(r.id) : m.rapporten[r.id] === true;
      if (!bestaat) { gzBev(bev, paden, 'BB1', 'hp', p, r, 'geen-rij', 'gezondheidspagina verwijst naar een rij in de health-pod die niet bestaat (' + t + ')', 'de verwijzing olares:health-pod/' + t + '#… vindt geen rij. Voorstel: de verwijzing goedzetten of weghalen (machinekamer); de health-pod blijft de bron.'); return; }
      // append-only: een nieuwere rij vervangt deze; een pagina met status actueel noemt dan een verouderde rij als actueel
      if (lijst && p.actueel && m.lijst[r.tabel].vervangen.has(r.id)) gzBev(bev, paden, 'BB6', 'hp', p, r, 'vervangen', 'actuele gezondheidspagina noemt een health-pod-rij die vervangen is (' + t + ')', 'de pagina heeft status actueel, maar de health-pod heeft een nieuwere rij die olares:health-pod/' + t + '#… vervangt. Voorstel: de verwijzing naar de nieuwe rij zetten (machinekamer); de health-pod blijft de bron, geen waarde op de pagina overnemen.');
    });
  });
}

// ── de ronde: elke plek los; een fout in de ene raakt de andere niet ──
// ctx: { vault, lees(volPad) → tekst (gooit als weg), lijst(rel) → [{ naam, map, bestand }], bestaat(rel), knopen, nu, io: { d1, r2, sbRpc } }
async function bibliothecaris(ctx) {
  const bevindingen = [], plekken = {}, tel = {}, paden = {};
  function lees(rel) { try { return ctx.lees(path.join(ctx.vault, rel)); } catch (e) { return null; } }
  const vandaag = amsDatum(ctx.nu || Date.now());
  async function plek(code, f) {
    const eigen = [];
    function bev(check, sleutel, samenvatting, detail, ernst) { eigen.push({ bevinding_id: check + '-' + sleutel, check_id: check, samenvatting: schoon(samenvatting, 200), detail: schoon(detail, 600), ernst: ernst || 'warning' }); }
    try {
      const r = await f(bev);
      if (r && r.fout) { plekken[code] = { gemeten: false, reden: r.fout }; return; }
      // half: de pagina zelf is stuk; die bevinding komt erbij, maar wat van deze plek al open stond, blijft open (niet gemeten ≠ opgelost)
      plekken[code] = { gemeten: !(r && r.half), half: !!(r && r.half), reden: r && r.half ? 'pagina half of niet te ontleden' : undefined, verschil: eigen.length, niet_gemeten_ids: r && r.deels ? r.deels : [] };
      eigen.forEach(function (x) { bevindingen.push(x); });
    } catch (e) { plekken[code] = { gemeten: false, reden: 'vergelijking faalde: ' + String(e && e.message || e).slice(0, 80) }; }
  }
  const io = ctx.io || {};
  await plek('r2', async function (bev) {
    const m = await r2bMeting(io);
    if (m.fout) return m;
    r2bChecks(m, leesR2bPagina(lees(R2B_PAD)), bev, tel);
    if (tel.r2_half) { delete tel.r2_half; return { half: true }; }
  });
  await plek('wl', async function (bev) {
    if (!Array.isArray(ctx.knopen) || !ctx.knopen.length) return { fout: 'register leeg' };
    const t = lees(WL_PAD);
    if (t === null) return { fout: 'Woordenlijst niet te lezen' };   // weg of onleesbaar: niet gemeten (de Vault-Conciërge ziet een verdwenen pagina)
    return wlChecks(leesWoordenlijst(t), ctx.knopen, vandaag, bev, tel);
  });
  await plek('dl', async function (bev) {
    const t = lees(DL_PAD);
    if (t === null) return { fout: 'Deadlines niet te lezen' };
    return dlChecks(leesDeadlines(t), vandaag, ctx.bestaat, bev, tel, paden);
  });
  await plek('cm', async function (bev) {
    const bestanden = [];   // eerst de mappen: geen 90_Cijfermeester (proefvault, uitwijk) = niet gemeten, zonder databankvraag
    for (const map of CM_MAPPEN) {
      let l; try { l = ctx.lijst(CM_MAP + '/' + map); } catch (e) { return { fout: CM_MAP + '/' + map + ' niet te lezen' }; }
      l.forEach(function (x) { if (x.bestand && !x.naam.startsWith('.') && !x.naam.startsWith('_')) bestanden.push(map + '/' + x.naam); });
    }
    const m = await cmMeting(io);
    if (m.fout) return m;
    const dr = cmChecks(m, bestanden, leesBibliotheek(lees(CM_BIBLIOTHEEK)), bev, tel, ctx.bestaat);
    if (dr && dr.deels) return dr;
  });
  // wv1774: plek 13–14 — de pagina's één keer lezen; niet te lezen = beide niet gemeten (hun open bevindingen blijven open)
  const gz = typeof ctx.lijst === 'function' ? gzLees(ctx, lees) : { fout: 'geen maplezer' };
  await plek('kn', async function (bev) {
    if (gz.fout) return gz;
    const m = await knMeting(io, gz.paginas);
    if (m.fout) return m;
    knChecks(m, gz.paginas, bev, tel, paden);
  });
  await plek('hp', async function (bev) {
    if (gz.fout) return gz;
    const m = await hpMeting(io, gz.paginas);
    if (m.fout) return m;
    hpChecks(m, gz.paginas, bev, tel, paden);
  });
  return { plekken: plekken, tel: tel, bevindingen: bevindingen, paden: paden };
}
// Een open bevinding van een plek die nu niet gemeten is, blijft open (niet gemeten ≠ opgelost).
function magOplossen(rest, id) {
  const m = REST_BEVINDING_RE.exec(id);
  if (!m) return true;
  const p = rest && rest.plekken && rest.plekken[PLEK_VAN[m[1]]];
  return !!(p && p.gemeten && (p.niet_gemeten_ids || []).indexOf(id) < 0);
}
function zin(rest) {
  const p = rest && rest.plekken || {}, t = rest && rest.tel || {};
  function z(code, wat, tekst) { const x = p[code]; return x && x.gemeten ? wat + ': ' + tekst() : wat + ' niet gemeten (' + schoon(x ? x.reden : 'module ontbreekt', 60) + ')'; }
  return '; ' + [
    z('r2', 'R2-bronnen', function () { return t.r2_objecten + ' bestanden, ' + t.r2_bronnen + ' bronrijen, ' + p.r2.verschil + ' verschil(len)' + (t.r2_verouderd ? ', register vernieuwt vannacht' : ''); }),
    z('wl', 'Woordenlijst', function () { return t.wl_regels + ' entiteitregels' + (t.wl_verouderd ? ', ' + t.wl_verouderd + ' achter op het register (zondag bij)' : '') + ', ' + p.wl.verschil + ' verschil(len)'; }),
    z('dl', 'Deadlines', function () { return t.dl_rijen + ' rijen, ' + t.dl_verlopen + ' verlopen zonder afhandeling, ' + p.dl.verschil + ' verschil(len)'; }),
    z('cm', 'Cijfer-Meester', function () { return t.cm_bestanden + ' bestanden, ' + t.cm_bronnen + ' bronnen, ' + t.cm_producten + ' producten, ' + p.cm.verschil + ' verschil(len)'; }),
    // wv1774: alleen aantallen (gezondheid)
    z('kn', 'Knie-app', function () { return t.kn_verwijzingen + ' verwijzing(en) op ' + t.kn_paginas + ' pagina(\'s), ' + p.kn.verschil + ' verschil(len)'; }),
    z('hp', 'Health-pod', function () { return t.hp_verwijzingen + ' verwijzing(en) op ' + t.hp_paginas + ' pagina(\'s), ' + p.hp.verschil + ' verschil(len)'; }),
  ].join('; ');
}

// ── nacht: het blok op het bronnenregister (zelfde regels als de bankblokken: handwerk niet overschrijven, opnieuw lezen vlak voor het schrijven) ──
// o: { vault, lees, schrijf, io, droog } → { blokken, handwerk, fouten: [{ pad, fout }] }. D1 niet te lezen: niets aanraken.
async function nacht(o) {
  const uit = { blokken: 0, handwerk: 0, fouten: [] };
  const io = o.io || {};
  if (typeof io.d1 !== 'function') return uit;
  let bron;
  try { const d = await io.d1(R2B_SQL); bron = d && d[0] && Array.isArray(d[0].results) ? d[0].results : null; }
  catch (e) { uit.fouten.push({ pad: '(D1 fin)', fout: 'bron niet te lezen: ' + String(e && e.message || e).slice(0, 80) }); return uit; }
  if (!bron || !bron.length) return uit;
  const vol = path.join(o.vault, R2B_PAD);
  let t; try { t = o.lees(vol); } catch (e) { return uit; }   // geen pagina: de Bibliothecaris meldt het (BB6)
  const p = leesR2bPagina(t);
  if (p.fouten.length) return uit;
  const blok = r2bBlokTekst(bron);
  if (R.huidigBlok(t) === blok) return uit;
  if (R.blokHandwerk(t)) { uit.handwerk++; return uit; }
  if (o.droog) { uit.blokken++; return uit; }
  try {
    const vers = o.lees(vol);
    if (R.vingerafdruk(vers).sha !== p.sha) { uit.fouten.push({ pad: R2B_PAD, fout: 'pagina veranderde tijdens de ronde; blok volgende nacht' }); return uit; }
    if (R.blokHandwerk(vers)) { uit.handwerk++; return uit; }
    o.schrijf(vol, R.zetBlok(vers, blok));
    uit.blokken++;
  } catch (e) { uit.fouten.push({ pad: R2B_PAD, fout: 'blok: ' + String(e && e.code || e && e.message || e).slice(0, 80) }); }
  return uit;
}

module.exports = { bibliothecaris: bibliothecaris, nacht: nacht, magOplossen: magOplossen, zin: zin, r2Lijst: r2Lijst, r2bMeting: r2bMeting, r2bChecks: r2bChecks,
  r2bBlokTekst: r2bBlokTekst, leesR2bPagina: leesR2bPagina, leesWoordenlijst: leesWoordenlijst, wlChecks: wlChecks, leesDeadlines: leesDeadlines, dlChecks: dlChecks,
  cmMeting: cmMeting, cmChecks: cmChecks, cmPatroon: cmPatroon, leesBibliotheek: leesBibliotheek, amsDatum: amsDatum,
  gzPagina: gzPagina, gzLees: gzLees, knMeting: knMeting, knChecks: knChecks, hpUitslag: hpUitslag, hpMeting: hpMeting, hpChecks: hpChecks,
  REST_BEVINDING_RE: REST_BEVINDING_RE, HP_PAD_RE: HP_PAD_RE, KN_TABELLEN: KN_TABELLEN, GZ_MAP: GZ_MAP, R2B_PAD: R2B_PAD, R2B_SQL: R2B_SQL, WL_PAD: WL_PAD, DL_PAD: DL_PAD };
