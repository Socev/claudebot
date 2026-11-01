'use strict';
/*
 * Reizen (wv2136, 1-11-2026): de ene leesroute naar de reispagina's in 20_Prive/Reizen (type: reis), gedeeld door OVIS Tripper (de
 * reizen als lijst en per reis in de Socev-app) en MemoryLane (een voorbije reis wordt een herinnering, memorylane-delen.js).
 * Ontwerp in de vault: "01_Ontwikkeling/OVIS Tripper - reizen in beeld, samen met MemoryLane (ontwerp 31-10-2026).md" § 2, § 4.2.
 *
 * WAAROM. Tripper mag geen tweede reizenlijst of opslag worden (ontwerp § 2 afspraak 1): beide Apps lezen bij elke vraag dezelfde
 * pagina's uit de vault, met dezelfde functie. De pagina blijft de bron; hier wordt niets geschreven.
 *
 * VORM.
 *  - paden(): de .md-bestanden direct in 20_Prive/Reizen (geen submappen, geen verborgen bestanden); welke een reis zijn, beslist de
 *    frontmatter (type: reis).
 *  - reisInfo(rel): titel/periode/van/tot, precies wat MemoryLane al las (geen gedragswijziging).
 *  - ontleed(tekst, rel): de hele reis. Titel uit onderwerp (anders de bestandsnaam), periode "JJJJ-MM-DD – JJJJ-MM-DD", soort uit
 *    trip_soort (frontmatter, T2) of anders uit de tags (SOORT_REGELS, eerste raak wint: gambia vóór vakantie), deelnemers uit
 *    deelnemers (frontmatter, T2) of anders de wikilinks onder "## Gezelschap" / "## Wie & hoe", description, paginatekst.
 *  - T4 (wv2172): stand 'geannuleerd' bij status: geannuleerd (niet komend; reisInfo → null, dus geen MemoryLane-herinnering); bij een
 *    komende reis te_regelen_open (lijst) en te_regelen {kop, tekst, open, klaar, afgekapt} (reis) uit ## Nog te regelen / ## Open…
 *    / ## Nog niet bekend. De periode op de tijdlijn van OVIS Calendar zet socev-sb2 kalender_reizen.py (zelfde id).
 *  - id = de eerste 12 hex van sha256(vaultpad). Een reis opvragen gaat alleen op id: de pod zoekt het pad zelf op in paden(), dus een
 *    pad uit de vraag komt nooit bij het bestandssysteem.
 *  - T2 (wv2152, ontwerp § 4.1): vervoer (vaste woorden, VERVOER) in lijst en reis; alleen in de reis: verblijf [{plaats, naam, van, tot}],
 *    plekken [{naam, rol, lat, lon}] (coördinaten alleen als beide geldig) en kosten {totaal, per_persoon, bron}: een bedrag zonder
 *    kosten_bron valt weg (ontwerp § 6: geen totaal zonder onderbouwing). Lijsten van maps in flow- of blokvorm (fmObjLijst), ≤ 60 items.
 *  - T3 (wv2163): kaart in de reis {punten, lijn, verblijf_zonder_plek} (kaartVan: verblijf op plaatsnaam aan een plek, geen geocoder) en
 *    één punt per reis in de lijst (kaartPunt: bestemming, anders het verste punt) voor de overzichtskaart. Coördinaten alleen uit de pagina.
 *  - Lezen via vault-veilig (o.vv.lees: geen symlink volgen, alleen een gewoon bestand, ≤ 512 kB).
 * PRIVACY. Reispagina's zijn strikt privé (namen, boekingen, bedragen). Deze module logt niets; info() geeft alleen aantallen.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REIS_MAP = '20_Prive/Reizen';
const MAX_TITEL = 120, MAX_BESCHRIJVING = 400, MAX_DEELNEMERS = 40, MAX_PAGINA = 512 * 1024;
const ID_RE = /^[0-9a-f]{12}$/;
const MAX_ITEMS = 60;
const VERVOER = ['auto', 'vliegtuig', 'trein', 'ferry', 'camper', 'fiets', 'te-voet', 'bus'];
const SOORTEN = ['vakantie', 'weekend', 'vrienden', 'carbage-run', 'gambia', 'festival', 'actief'];
// Ontwerp § 3: volgorde telt (Gambia 2023 heeft ook de tag vakantie; een Shizzle-weekend is vrienden, geen stedentrip)
const SOORT_REGELS = [
  ['gambia', ['gambia']],
  ['carbage-run', ['carbage-run', 'carbagerun', 'garbage-run']],
  ['vrienden', ['shizzle', 'vriendenweekend', 'vriendentrip', 'vrienden']],
  ['festival', ['festival']],
  ['actief', ['wandelen', 'huttentocht', 'trektocht', 'fietsen', 'skien', 'actief']],
  ['weekend', ['stedentrip', 'weekend', 'weekendje']],
  ['vakantie', ['vakantie', 'zomer', 'zomervakantie', 'camper', 'camping']],
];
const GEZELSCHAP_RE = /^##[ \t]+(?:Gezelschap|Wie & hoe)\b[^\n]*$/m;

function idVan(rel) { return crypto.createHash('sha256').update(String(rel)).digest('hex').slice(0, 12); }
function frontmatter(t) { const m = /^---\n([\s\S]*?)\n---/.exec(t || ''); return m ? m[1] : null; }
function zonderFrontmatter(t) { const m = /^---\n[\s\S]*?\n---\n?/.exec(t || ''); return m ? t.slice(m[0].length) : String(t || ''); }
// Eén veld als tekst (zelfde lezing als memorylane-delen.js fmVeld tot wv2136)
function fmVeld(t, veld) {
  const fm = frontmatter(t);
  if (fm == null) return null;
  const r = new RegExp('^' + veld + ':\\s*(.*)$', 'm').exec(fm);
  if (!r) return null;
  let v = r[1].trim();
  if (v.startsWith('"')) { try { v = JSON.parse(v); } catch (e) { v = v.replace(/^"|"$/g, ''); } }
  return v;
}
// YAML-commentaar: een # na witruimte (of aan het begin), buiten aanhalingstekens; [[pad#kop]] blijft (review wv2152 MOET 2)
function zonderCommentaar(x) {
  x = String(x == null ? '' : x);
  let aanh = null;
  for (let i = 0; i < x.length; i++) {
    const c = x[i];
    if (aanh) { if (c === aanh && x[i - 1] !== '\\') aanh = null; continue; }
    if (c === '"' || c === "'") aanh = c;
    else if (c === '#' && (i === 0 || /\s/.test(x[i - 1]))) return x.slice(0, i).trimEnd();
  }
  return x;
}
// Een lijstveld: [a, "b"] op één regel of een blok "- a" eronder
function fmLijst(t, veld) {
  const fm = frontmatter(t);
  if (fm == null) return [];
  const r = new RegExp('^' + veld + ':[ \\t]*(.*)$', 'm').exec(fm);
  if (!r) return [];
  const kaal = (x) => { x = x.trim(); if (/^".*"$/.test(x)) { try { return JSON.parse(x); } catch (e) { return x.slice(1, -1); } } return x.replace(/^'(.*)'$/, '$1'); };
  const v = zonderCommentaar(r[1]).trim();
  if (v.startsWith('[')) {
    const binnen = v.replace(/^\[/, '').replace(/\]$/, '');
    // komma's binnen [[...]] of "..." niet splitsen
    const uit = []; let diep = 0, aanh = false, cur = '';
    for (let i = 0; i < binnen.length; i++) {
      const c = binnen[i];
      if (c === '"' && binnen[i - 1] !== '\\') aanh = !aanh;
      if (!aanh && c === '[') diep++;
      if (!aanh && c === ']') diep--;
      if (c === ',' && !aanh && diep <= 0) { uit.push(cur); cur = ''; } else cur += c;
    }
    if (cur.trim()) uit.push(cur);
    return uit.map(kaal).filter(Boolean);
  }
  if (v) return [kaal(v)];
  const rest = fm.slice(r.index + r[0].length).split('\n').slice(1);
  const uit = [];
  for (const regel of rest) { const m = /^[ \t]*-[ \t]+(.*)$/.exec(zonderCommentaar(regel)); if (!m) break; uit.push(kaal(m[1])); }
  return uit.filter(Boolean);
}
function soortVan(tekst) {
  const eigen = String(fmKop(tekst, 'trip_soort') || '').trim().toLowerCase();
  if (SOORTEN.indexOf(eigen) >= 0) return eigen;
  const tags = new Set(fmLijst(tekst, 'tags').map((x) => String(x).trim().toLowerCase().replace(/^#/, '')));
  for (const [soort, woorden] of SOORT_REGELS) if (woorden.some((w) => tags.has(w))) return soort;
  return 'overig';
}
// [[doel|naam]] of [[doel]] (geen ![[insluiting]]); naam = de alias, anders de bestandsnaam zonder map
function wikilinks(s) {
  const uit = [], gezien = new Set();
  const re = /(!?)\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g;
  let m;
  while ((m = re.exec(s)) && uit.length < MAX_DEELNEMERS) {
    if (m[1]) continue;
    const doel = m[2].trim(), naam = (m[3] || path.basename(doel).replace(/\.md$/, '')).trim();
    if (!doel || !naam || gezien.has(doel)) continue;
    gezien.add(doel);
    uit.push(naam.slice(0, 80));
  }
  return uit;
}
function deelnemersVan(tekst) {
  const fm = fmLijst(tekst, 'deelnemers');
  // T2: per item de naam uit de wikilink, anders de tekst zelf (iemand zonder eigen pagina); dubbele namen één keer
  if (fm.length) {
    const uit = [];
    for (const x of fm) { const w = wikilinks(String(x)); const n = w.length ? w[0] : String(x).replace(/\[\[|\]\]/g, '').trim().slice(0, 80); if (n && uit.indexOf(n) < 0) uit.push(n); }
    return uit.slice(0, MAX_DEELNEMERS);
  }
  const lijf = zonderFrontmatter(tekst);
  const k = GEZELSCHAP_RE.exec(lijf);
  if (!k) return [];
  const na = lijf.slice(k.index + k[0].length);
  const eind = /^#{1,2}[ \t]/m.exec(na);
  return wikilinks(eind ? na.slice(0, eind.index) : na);
}
// ── T2 (wv2152): de vaste kop uit ontwerp § 4.1 — vervoer, verblijf, plekken, kosten. Alleen wat er staat; wat niet klopt valt weg. ──
// Eén waarde uit flow-YAML: "tekst" (JSON-escape), 'tekst', getal of kaal woord
function kaalWaarde(x) {
  x = String(x == null ? '' : x).trim();
  if (/^".*"$/.test(x)) { try { return JSON.parse(x); } catch (e) { return x.slice(1, -1); } }
  if (/^'.*'$/.test(x)) return x.slice(1, -1).replace(/''/g, "'");
  return x;
}
// {a: 1, b: "x, y"} → { a: '1', b: 'x, y' } (komma's en dubbele punten binnen aanhalingstekens blijven); null als het geen map is
function flowMap(s) {
  s = String(s || '').trim();
  if (!/^\{[\s\S]*\}$/.test(s)) return null;
  const binnen = s.slice(1, -1), delen = [];
  let aanh = null, cur = '';
  for (let i = 0; i < binnen.length; i++) {
    const c = binnen[i];
    if (aanh) { if (c === aanh && binnen[i - 1] !== '\\') aanh = null; cur += c; continue; }
    if (c === '"' || c === "'") { aanh = c; cur += c; continue; }
    if (c === ',') { delen.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) delen.push(cur);
  const uit = {};
  for (const d of delen) { const m = /^\s*([A-Za-z_][\w-]*)\s*:\s*([\s\S]*)$/.exec(d); if (m) uit[m[1]] = kaalWaarde(m[2]); }
  return uit;
}
// Een lijst van maps onder veld: "- {a: 1, b: 2}" per regel, of in blokvorm "- a: 1" met "  b: 2" eronder
function fmObjLijst(t, veld) {
  const fm = frontmatter(t);
  if (fm == null) return [];
  const r = new RegExp('^' + veld + ':[ \\t]*(?:#.*)?$', 'm').exec(fm);
  if (!r) return [];
  const uit = [];
  let cur = null;
  for (const ruw of fm.slice(r.index + r[0].length).split('\n').slice(1)) {
    if (!/^[ \t]/.test(ruw) && ruw.trim() && !/^#/.test(ruw)) break;          // volgend veld
    const regel = zonderCommentaar(ruw);
    if (/^[ \t]*-[ \t]*$/.test(regel)) { if (cur) uit.push(cur); cur = {}; continue; }   // losse "-", sleutels eronder (review ZOU 1)
    const item = /^[ \t]*-[ \t]+(.*)$/.exec(regel);
    if (item) {
      if (cur) uit.push(cur);
      const fl = flowMap(item[1]);
      if (fl) { uit.push(fl); cur = null; continue; }
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(item[1]);
      cur = kv ? { [kv[1]]: kaalWaarde(kv[2]) } : null;
      continue;
    }
    const kv = /^[ \t]+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(regel);
    if (kv && cur) cur[kv[1]] = kaalWaarde(kv[2]);
  }
  if (cur && Object.keys(cur).length) uit.push(cur);
  return uit.filter((x) => Object.keys(x).length).slice(0, MAX_ITEMS);
}
// Eén veld van de vaste kop: zonder commentaar, dan zonder aanhalingstekens (fmVeld zelf blijft zoals MemoryLane hem kent)
function fmKop(t, veld) {
  const fm = frontmatter(t);
  if (fm == null) return null;
  const r = new RegExp('^' + veld + ':[ \\t]*(.*)$', 'm').exec(fm);
  return r ? kaalWaarde(zonderCommentaar(r[1])) : null;
}
const tekstVeld = (x, max) => { const v = String(x == null ? '' : x).replace(/[\u0000-\u001f]/g, ' ').trim(); return v ? v.slice(0, max || 120) : ''; };
// JJJJ-MM-DD én een bestaande dag (review wv2152 MOET 1: 2025-02-31 of maand 99 valt weg)
function datumVeld(x) {
  const s = String(x || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s ? s : null;
}
function graad(x, max) { const s = String(x == null ? '' : x).trim(); if (!/^-?\d{1,3}(\.\d+)?$/.test(s)) return null; const g = Number(s); return Math.abs(g) <= max ? g : null; }
function vervoerVan(t) {
  const uit = [];
  for (const x of fmLijst(t, 'vervoer')) { const v = String(x).trim().toLowerCase(); if (VERVOER.indexOf(v) >= 0 && uit.indexOf(v) < 0) uit.push(v); }
  return uit;
}
// verblijf: plaats of naam verplicht; van/tot als JJJJ-MM-DD (tot = de ochtend van vertrek), anders null
function verblijfVan(t) {
  const uit = [];
  for (const o of fmObjLijst(t, 'verblijf')) {
    const v = { plaats: tekstVeld(o.plaats, 80), naam: tekstVeld(o.naam, 120), van: datumVeld(o.van), tot: datumVeld(o.tot) };
    if (v.van && v.tot && v.tot < v.van) v.tot = null;
    if (v.plaats || v.naam) uit.push(v);
  }
  return uit;
}
// plekken: naam verplicht; coördinaten alleen als beide geldig zijn (stadsniveau, voor de kaart van T3)
function plekkenVan(t) {
  const uit = [];
  for (const o of fmObjLijst(t, 'plekken')) {
    const naam = tekstVeld(o.naam, 80);
    if (!naam) continue;
    const lat = graad(o.lat, 90), lon = graad(o.lon, 180), ok = lat != null && lon != null;
    uit.push({ naam, rol: tekstVeld(o.rol, 30) || null, lat: ok ? lat : null, lon: ok ? lon : null });
  }
  return uit;
}
// kosten: alleen met een bron (ontwerp § 6: een bedrag zonder onderbouwing tonen we niet); euro, ≥ 0
function bedrag(x) { const s = String(x == null ? '' : x).trim(); if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null; return Number(s); }
function kostenVan(t) {
  const bron = tekstVeld(fmKop(t, 'kosten_bron'), 200);
  const totaal = bedrag(fmKop(t, 'kosten_totaal')), pp = bedrag(fmKop(t, 'kosten_per_persoon'));
  if (!bron || (totaal == null && pp == null)) return null;
  return { totaal, per_persoon: pp, bron };
}

// ── T3 (wv2163, ontwerp § 4.4 keuze a): de kaart. Alleen de plekken met coördinaten uit de vaste kop; een verblijf hangt op plaatsnaam aan
// een plek (geen geocoder): eerst de naam zonder "(…)" ("Zion" = "Zion (Springdale)"), dan wat tussen haakjes staat ("Cavallino-Treporti" =
// "Punta Sabbioni (Cavallino-Treporti)"). Wat geen plek vindt, telt mee als verblijf_zonder_plek. De lijn volgt de volgorde van de pagina
// (geen gereden route).
const sleutel = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
function naamDelen(n) { const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(String(n || '')); return m ? { kern: sleutel(m[1]), binnen: sleutel(m[2]) } : { kern: sleutel(n), binnen: null }; }
const puntSleutel = (p) => p.lat + ',' + p.lon + '|' + sleutel(p.naam);
function plekVoorPlaats(plaats, plekken) {
  const k = naamDelen(plaats).kern;
  if (!k) return null;
  const met = plekken.filter((p) => p.lat != null && p.lon != null);
  return met.find((p) => naamDelen(p.naam).kern === k) || met.find((p) => naamDelen(p.naam).binnen === k) || null;
}
// → { punten: [{naam, rollen, lat, lon, verblijf: [{naam, van, tot}]}], lijn: [[lat, lon]…] (≥ 2 of leeg), verblijf_zonder_plek }
function kaartVan(plekken, verblijf) {
  const punten = [], index = new Map();
  for (const p of plekken || []) {
    if (p.lat == null || p.lon == null) continue;
    const k = puntSleutel(p);
    if (index.has(k)) { const q = punten[index.get(k)]; if (p.rol && q.rollen.indexOf(p.rol) < 0) q.rollen.push(p.rol); continue; }   // start = finish
    index.set(k, punten.length);
    punten.push({ naam: p.naam, rollen: p.rol ? [p.rol] : [], lat: p.lat, lon: p.lon, verblijf: [] });
  }
  let zonder = 0;
  for (const v of verblijf || []) {
    const p = plekVoorPlaats(v.plaats, plekken || []);
    if (!p) { zonder++; continue; }
    punten[index.get(puntSleutel(p))].verblijf.push({ naam: v.naam, van: v.van, tot: v.tot });
  }
  const lijn = [];
  for (const p of plekken || []) {
    if (p.lat == null || p.lon == null) continue;
    const l = lijn[lijn.length - 1];
    if (!l || l[0] !== p.lat || l[1] !== p.lon) lijn.push([p.lat, p.lon]);
  }
  return { punten, lijn: lijn.length >= 2 ? lijn : [], verblijf_zonder_plek: zonder };
}
// Eén punt per reis voor de overzichtskaart: de plek met rol bestemming, anders de plek het verst van de eerste (keerpunt van een rondreis)
function kaartPunt(plekken) {
  const met = (plekken || []).filter((p) => p.lat != null && p.lon != null);
  if (!met.length) return null;
  const b = met.find((p) => p.rol === 'bestemming');
  if (b) return { lat: b.lat, lon: b.lon };
  const a = met[0], cos = Math.cos(a.lat * Math.PI / 180);
  const afst = (p) => Math.pow(p.lat - a.lat, 2) + Math.pow((p.lon - a.lon) * cos, 2);
  const ver = met.reduce((x, p) => (afst(p) > afst(x) ? p : x), a);
  return { lat: ver.lat, lon: ver.lon };
}

function dagen(van, tot) {
  if (!van || !tot) return null;
  const a = Date.parse(van + 'T00:00:00Z'), b = Date.parse(tot + 'T00:00:00Z');
  return isNaN(a) || isNaN(b) || b < a ? null : Math.round((b - a) / 86400000) + 1;
}
function stand(van, tot, vandaag, geannuleerd) {
  if (geannuleerd) return 'geannuleerd';   // wv2172 (T4): status: geannuleerd in de pagina; niet onder Komend
  if (!van) return 'onbekend';
  if (van > vandaag) return 'gepland';
  return (tot || van) >= vandaag ? 'nu' : 'geweest';
}
function reisInfoUit(t, rel) {
  if (fmVeld(t, 'type') !== 'reis') return null;
  const periode = fmVeld(t, 'periode') || '';
  const data = periode.match(/\d{4}-\d{2}-\d{2}/g) || [];
  return { titel: (fmVeld(t, 'onderwerp') || path.basename(rel, '.md')).slice(0, MAX_TITEL), periode, van: data[0] || null, tot: data[data.length - 1] || null };
}
// wv2172 (T4): status: geannuleerd (commentaar erachter mag) — de pagina blijft, de reis telt niet meer als komend
function geannuleerd(t) { return /^geannuleerd$/i.test(zonderCommentaar(fmVeld(t, 'status') || '').replace(/^['"]|['"]$/g, '').trim()); }
// wv2172 (T4): "nog te regelen" = de tekst onder de eerste kop ## Nog te regelen / ## Te regelen / ## Open… / ## Nog niet bekend, tot de
// volgende kop van niveau 1 of 2 (of een gegenereerd blok), hooguit MAX_REGELEN tekens (afgekapt op een regel, met "…"); open/klaar =
// takenlijst-regels "- [ ]" en "- [x]". De pagina blijft de bron; de App toont dit alleen.
const REGELEN_KOP = /^##[ \t]+((?:nog[ \t]+)?te[ \t]+regelen|open|nog[ \t]+niet[ \t]+bekend)\b[^\n]*$/im;
const MAX_REGELEN = 4000;
function teRegelenVan(t) {
  const lijf = zonderFrontmatter(t);
  const m = REGELEN_KOP.exec(lijf);
  if (!m) return null;
  const na = lijf.slice(m.index + m[0].length);
  const eind = /^(?:#{1,2}[ \t]|<!-- sb:generated)/m.exec(na);
  let tekst = (eind ? na.slice(0, eind.index) : na).trim();
  let afgekapt = false;
  if (tekst.length > MAX_REGELEN) { const k = tekst.lastIndexOf('\n', MAX_REGELEN); tekst = tekst.slice(0, k > 0 ? k : MAX_REGELEN).trimEnd() + '\n\n…'; afgekapt = true; }
  const open = (tekst.match(/^[ \t]*[-*+][ \t]+\[ \]/gm) || []).length, klaar = (tekst.match(/^[ \t]*[-*+][ \t]+\[[xX]\]/gm) || []).length;
  return { kop: m[0].replace(/^##[ \t]+/, '').trim().slice(0, 80), tekst, open, klaar, afgekapt };
}
// De hele reis uit een paginatekst (null als het geen reis is). vandaag 'JJJJ-MM-DD' voor gepland/nu/geweest.
function ontleed(t, rel, vandaag) {
  const i = reisInfoUit(t, rel);
  if (!i) return null;
  const besch = fmVeld(t, 'description');
  const st = stand(i.van, i.tot, vandaag || '', geannuleerd(t));
  const komend = st === 'gepland' || st === 'nu', tr = komend ? teRegelenVan(t) : null;
  return Object.assign({ id: idVan(rel) }, i, { dagen: dagen(i.van, i.tot), jaar: i.van ? i.van.slice(0, 4) : null, stand: st,
    te_regelen_open: tr ? tr.open : null,
    soort: soortVan(t), deelnemers: deelnemersVan(t), vervoer: vervoerVan(t), beschrijving: besch ? String(besch).slice(0, MAX_BESCHRIJVING) : '',
    punt: kaartPunt(plekkenVan(t)) });
}

/*
 * maak(o) → { paden, reisInfo, lijst, reis, info }
 * o = { vault, vv (vault-veilig), vandaag?() → 'JJJJ-MM-DD' (standaard Amsterdam), koppel?(rel) → { hid, stukken, album } | null }
 */
function maak(o) {
  const vandaag = typeof o.vandaag === 'function' ? o.vandaag
    : function () { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); };
  let laatst = null;
  function paden() {
    let n = [];
    try { n = fs.readdirSync(path.join(o.vault, REIS_MAP)).filter((x) => /\.md$/.test(x) && !x.startsWith('.')); } catch (e) { n = []; }
    return n.sort().map((x) => path.join(REIS_MAP, x));
  }
  function lees(rel) { try { return o.vv.lees(path.join(o.vault, rel), 'utf8', { max: MAX_PAGINA }); } catch (e) { return null; } }
  // wv2172: een geannuleerde reis is voor MemoryLane geen reis (wordt na de datum geen herinnering); Tripper toont hem wel
  function reisInfo(rel) { const t = lees(rel); return t == null || geannuleerd(t) ? null : reisInfoUit(t, rel); }
  function koppeling(rel) {
    if (typeof o.koppel !== 'function') return null;
    try { return o.koppel(rel) || null; } catch (e) { return null; }
  }
  function alle() {
    const v = vandaag(), uit = [];
    let onleesbaar = 0;
    for (const rel of paden()) {
      const t = lees(rel);
      if (t == null) { onleesbaar++; continue; }
      const r = ontleed(t, rel, v);
      if (r) uit.push({ rel, r, t });
    }
    return { v, uit, onleesbaar };
  }
  // Komend (gepland en nu) bovenaan, eerstvolgende eerst; daarna de rest, nieuwste eerst
  function sorteer(a, b) {
    const ka = a.stand === 'gepland' || a.stand === 'nu', kb = b.stand === 'gepland' || b.stand === 'nu';
    if (ka !== kb) return ka ? -1 : 1;
    const x = a.van || '', y = b.van || '';
    if (x === y) return a.titel < b.titel ? -1 : 1;
    return ka ? (x < y ? -1 : 1) : (x < y ? 1 : -1);
  }
  function lijst() {
    const { v, uit, onleesbaar } = alle();
    const reizen = uit.map(({ rel, r }) => Object.assign({}, r, { memorylane: koppeling(rel) })).sort(sorteer);
    laatst = { op: new Date().toISOString(), reizen: reizen.length, komend: reizen.filter((r) => r.stand === 'gepland' || r.stand === 'nu').length, onleesbaar };
    return { status: 200, body: { ok: true, vandaag: v, soorten: SOORTEN, reizen } };
  }
  function reis(id) {
    if (!ID_RE.test(String(id))) return { status: 400, body: { ok: false, fout: 'ongeldige reis' } };
    const rel = paden().find((p) => idVan(p) === id);
    if (!rel) return { status: 404, body: { ok: false, fout: 'onbekende reis' } };
    const t = lees(rel);
    const r = t == null ? null : ontleed(t, rel, vandaag());
    if (!r) return { status: 404, body: { ok: false, fout: 'onbekende reis' } };
    const verblijf = verblijfVan(t), plekken = plekkenVan(t);
    const komend = r.stand === 'gepland' || r.stand === 'nu';
    return { status: 200, body: { ok: true, reis: Object.assign(r, { verblijf, plekken, kosten: kostenVan(t), kaart: kaartVan(plekken, verblijf),
      te_regelen: komend ? teRegelenVan(t) : null,
      pad: rel, tekst: zonderFrontmatter(t), memorylane: koppeling(rel) }) } };
  }
  function info() { return Object.assign({ aan: true }, laatst || { op: null, reizen: null, komend: null, onleesbaar: null }); }
  return { paden, reisInfo, lijst, reis, info };
}

module.exports = { maak, ontleed, idVan, teRegelenVan, geannuleerd, soortVan, deelnemersVan, vervoerVan, verblijfVan, plekkenVan, kostenVan, kaartVan, kaartPunt, fmObjLijst, flowMap, fmVeld, fmLijst, VERVOER, REIS_MAP, SOORTEN, SOORT_REGELS, ID_RE, MAX_TITEL };
