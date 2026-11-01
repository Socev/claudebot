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
 *  - id = de eerste 12 hex van sha256(vaultpad). Een reis opvragen gaat alleen op id: de pod zoekt het pad zelf op in paden(), dus een
 *    pad uit de vraag komt nooit bij het bestandssysteem.
 *  - Lezen via vault-veilig (o.vv.lees: geen symlink volgen, alleen een gewoon bestand, ≤ 512 kB).
 * PRIVACY. Reispagina's zijn strikt privé (namen, boekingen, bedragen). Deze module logt niets; info() geeft alleen aantallen.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REIS_MAP = '20_Prive/Reizen';
const MAX_TITEL = 120, MAX_BESCHRIJVING = 400, MAX_DEELNEMERS = 40, MAX_PAGINA = 512 * 1024;
const ID_RE = /^[0-9a-f]{12}$/;
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
// Een lijstveld: [a, "b"] op één regel of een blok "- a" eronder
function fmLijst(t, veld) {
  const fm = frontmatter(t);
  if (fm == null) return [];
  const r = new RegExp('^' + veld + ':[ \\t]*(.*)$', 'm').exec(fm);
  if (!r) return [];
  const kaal = (x) => { x = x.trim(); if (/^".*"$/.test(x)) { try { return JSON.parse(x); } catch (e) { return x.slice(1, -1); } } return x.replace(/^'(.*)'$/, '$1'); };
  const v = r[1].trim();
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
  for (const regel of rest) { const m = /^[ \t]*-[ \t]+(.*)$/.exec(regel); if (!m) break; uit.push(kaal(m[1])); }
  return uit.filter(Boolean);
}
function soortVan(tekst) {
  const eigen = String(fmVeld(tekst, 'trip_soort') || '').trim().toLowerCase();
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
  if (fm.length) { const w = wikilinks(fm.join('\n')); return w.length ? w : fm.map((x) => String(x).slice(0, 80)).slice(0, MAX_DEELNEMERS); }
  const lijf = zonderFrontmatter(tekst);
  const k = GEZELSCHAP_RE.exec(lijf);
  if (!k) return [];
  const na = lijf.slice(k.index + k[0].length);
  const eind = /^#{1,2}[ \t]/m.exec(na);
  return wikilinks(eind ? na.slice(0, eind.index) : na);
}
function dagen(van, tot) {
  if (!van || !tot) return null;
  const a = Date.parse(van + 'T00:00:00Z'), b = Date.parse(tot + 'T00:00:00Z');
  return isNaN(a) || isNaN(b) || b < a ? null : Math.round((b - a) / 86400000) + 1;
}
function stand(van, tot, vandaag) {
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
// De hele reis uit een paginatekst (null als het geen reis is). vandaag 'JJJJ-MM-DD' voor gepland/nu/geweest.
function ontleed(t, rel, vandaag) {
  const i = reisInfoUit(t, rel);
  if (!i) return null;
  const besch = fmVeld(t, 'description');
  return Object.assign({ id: idVan(rel) }, i, { dagen: dagen(i.van, i.tot), jaar: i.van ? i.van.slice(0, 4) : null, stand: stand(i.van, i.tot, vandaag || ''),
    soort: soortVan(t), deelnemers: deelnemersVan(t), beschrijving: besch ? String(besch).slice(0, MAX_BESCHRIJVING) : '' });
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
  function reisInfo(rel) { const t = lees(rel); return t == null ? null : reisInfoUit(t, rel); }
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
    laatst = { op: new Date().toISOString(), reizen: reizen.length, komend: reizen.filter((r) => r.stand !== 'geweest' && r.stand !== 'onbekend').length, onleesbaar };
    return { status: 200, body: { ok: true, vandaag: v, soorten: SOORTEN, reizen } };
  }
  function reis(id) {
    if (!ID_RE.test(String(id))) return { status: 400, body: { ok: false, fout: 'ongeldige reis' } };
    const rel = paden().find((p) => idVan(p) === id);
    if (!rel) return { status: 404, body: { ok: false, fout: 'onbekende reis' } };
    const t = lees(rel);
    const r = t == null ? null : ontleed(t, rel, vandaag());
    if (!r) return { status: 404, body: { ok: false, fout: 'onbekende reis' } };
    return { status: 200, body: { ok: true, reis: Object.assign(r, { pad: rel, tekst: zonderFrontmatter(t), memorylane: koppeling(rel) }) } };
  }
  function info() { return Object.assign({ aan: true }, laatst || { op: null, reizen: null, komend: null, onleesbaar: null }); }
  return { paden, reisInfo, lijst, reis, info };
}

module.exports = { maak, ontleed, idVan, soortVan, deelnemersVan, fmVeld, fmLijst, REIS_MAP, SOORTEN, SOORT_REGELS, ID_RE, MAX_TITEL };
