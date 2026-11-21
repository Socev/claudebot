'use strict';
// wv3685 (besluitenpagina nr 367 = 3C67, David Ja 21-11 12:41): één tik per punt van het ochtendbericht (Gedaan, Later, Klopt niet, Open).
// Puur (geen I/O): server.js leest de briefing, bewaart de standen en zet de correctierij in ochtend_buffer.
//
// Punt-model (zo gehouden dat het redactie-loket 2C59 het kan hergebruiken voor een avondeditie of een App-regel):
//   editie = '<soort>:<dag>' (nu alleen 'briefing:JJJJ-MM-DD')
//   punt   = { id, tekst, rubriek, bron } ; id = vast uit dag + platte tekst (dezelfde tekst = dezelfde id, ook na herladen)
//   stand  = 'gedaan' | 'later' | 'klopt_niet' (geen stand = open)
// Een punt is een bolletje (•, -, *). Een bolletje dat op ':' eindigt is een tussenkop van een sublijst, geen punt.
// Bron = de eerste [[vaultpad]] of [tekst](link) in het bolletje (de briefingprompt zet hem erachter); een vaultpad dat niet
// bestaat telt niet (geen Open die nergens heen gaat). Een verwijzing aan het eind ("([[pad]])") gaat uit de getoonde tekst.
// Codex-review MOET 1: punten onder een kop van een blok dat n8n er letterlijk, buiten het taalmodel om, onder zet (nu: 💶 Geld deze
// maand, met bankbedragen die nooit naar de briefingsessie mogen) zijn wel aan te tikken, maar gaan nooit mee in de correctierij.
const crypto = require('crypto');

const STANDEN = ['gedaan', 'later', 'klopt_niet'];
const STAND_TEKST = { gedaan: 'Gedaan', later: 'Later', klopt_niet: 'Klopt niet' };
const BOL_RE = /^\s*[•\-*]\s+/;
const WIKI_RE = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/;
const LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/;
// verwijzing aan het eind: ' ([[pad]])', ' — [[pad]]', ' (bron: [[pad|x]])', ' [[pad]].' ; ook een md-link in dezelfde vorm
const STAART_RE = /\s*[—–-]?\s*\(?\s*(?:bron:\s*)?(?:\[\[[^\]\n]+\]\]|\[[^\]\n]+\]\([^)\s]+\))\s*\)?\s*([.;]?)\s*$/i;

function plat(r) {
  return String(r || '').replace(/\*\*|__|`/g, '').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, '$1')
    .replace(/\s+/g, ' ').trim();
}
function isKop(r) { return /^#/.test(r) || /^\*\*[^*]+\*\*:?$/.test(r); }
const NIET_DOOR_KOP = /geld deze maand/i;

// veilig vaultpad: relatief, geen '..', geen protocol
function vaultPad(p) {
  p = String(p || '').trim().replace(/^\/+/, '').replace(/\.md$/i, '');
  if (!p || p.length > 300 || /(^|\/)\.\.(\/|$)/.test(p) || /^[a-z]+:/i.test(p) || /[\u0000-\u001f]/.test(p)) return null;
  return p;
}
function bronVan(r, bestaat) {
  const w = WIKI_RE.exec(r);
  if (w) {
    const pad = vaultPad(w[1]);
    if (pad && (!bestaat || bestaat(pad))) return { soort: 'pagina', pad: pad, naam: (w[2] || pad.split('/').pop()).trim().slice(0, 120) };
  }
  const l = LINK_RE.exec(r);
  if (l && /^(https:\/\/|\/)/i.test(l[2])) return { soort: 'link', url: l[2].slice(0, 500), naam: plat(l[1]).slice(0, 120) };
  return null;
}
function puntId(dag, tekst) {
  return 'p' + crypto.createHash('sha256').update(String(dag) + '|' + plat(tekst).toLowerCase()).digest('hex').slice(0, 12);
}

// tekst (markdown van de briefing) -> { blokken: [{ md } | { punt }], punten: [...] }
function punten(tekst, dag, o) {
  o = o || {};
  const regels = String(tekst || '').split('\n');
  const blokken = [], uit = [], gezien = {};
  let md = [], rubriek = null, nietDoor = false;
  const sluit = function () { if (md.length) { const s = md.join('\n').replace(/^\n+|\n+$/g, ''); if (s) blokken.push({ md: s }); md = []; } };
  for (const ruw of regels) {
    const r = ruw.trim();
    if (r && isKop(r)) { rubriek = plat(r).replace(/:$/, '').slice(0, 80); nietDoor = NIET_DOOR_KOP.test(rubriek); }
    if (!BOL_RE.test(ruw) || !r) { md.push(ruw); continue; }
    const zin = r.replace(BOL_RE, '');
    const p = plat(zin);
    if (!p || /:$/.test(p)) { md.push(ruw); continue; }   // tussenkop van een sublijst
    const bron = bronVan(zin, o.bestaat);
    const getoond = (bron ? zin.replace(STAART_RE, '$1') : zin).trim() || zin;
    let id = puntId(dag, p);
    gezien[id] = (gezien[id] || 0) + 1;
    if (gezien[id] > 1) id += '-' + gezien[id];
    const punt = { id: id, tekst: getoond.slice(0, 1200), rubriek: rubriek, bron: bron };
    if (nietDoor) punt.niet_door = true;
    sluit();
    blokken.push({ punt: punt });
    uit.push(punt);
  }
  sluit();
  return { blokken: blokken, punten: uit };
}

// standen-opslag: { versie: 1, edities: { 'briefing:JJJJ-MM-DD': { punten: { id: { stand, t, tekst } }, buffer: { ok, t } } } }
function editieSleutel(soort, dag) { return soort + ':' + dag; }
function snoei(m, nuMs, dagen) {
  const grens = new Date(nuMs - (dagen || 14) * 86400000).toISOString().slice(0, 10);
  Object.keys(m.edities || {}).forEach(function (k) { if (String(k.split(':')[1] || '') < grens) delete m.edities[k]; });
  return m;
}
function zetStand(m, sleutel, punt, stand, nuMs) {
  m.edities = m.edities || {};
  const e = m.edities[sleutel] = m.edities[sleutel] || { punten: {} };
  e.punten = e.punten || {};
  const oud = e.punten[punt.id] ? e.punten[punt.id].stand : null;
  // niet_door (MOET 1): de tekst wordt niet eens bewaard, alleen de stand
  if (stand) e.punten[punt.id] = punt.niet_door ? { stand: stand, t: new Date(nuMs).toISOString(), niet_door: true }
    : { stand: stand, t: new Date(nuMs).toISOString(), tekst: plat(punt.tekst).slice(0, 400) };
  else delete e.punten[punt.id];
  return oud;
}
function standenVan(m, sleutel) {
  const e = m && m.edities && m.edities[sleutel];
  const s = {};
  if (e && e.punten) Object.keys(e.punten).forEach(function (id) { if (STANDEN.indexOf(e.punten[id].stand) >= 0) s[id] = e.punten[id].stand; });
  return s;
}
// de rij voor de briefing van de volgende dag: alleen Gedaan en Klopt niet (Later = gewoon open laten); '' = niets door te geven
function correctieTekst(m, sleutel, dag) {
  const e = m && m.edities && m.edities[sleutel];
  if (!e || !e.punten) return '';
  const r = { gedaan: [], klopt_niet: [] };
  Object.keys(e.punten).forEach(function (id) { const x = e.punten[id]; if (r[x.stand] && !x.niet_door && x.tekst) r[x.stand].push(x); });
  if (!r.gedaan.length && !r.klopt_niet.length) return '';
  const regel = function (x) { return '- ' + x.tekst; };
  const delen = ['David tikte in het ochtendbericht van ' + dag + ' (zijn eigen knoppen):'];
  if (r.klopt_niet.length) delen.push('Klopt niet (niet opnieuw zo melden; is de bron vannacht veranderd, zeg dan in een halve zin wat er nieuw is):\n' + r.klopt_niet.map(regel).join('\n'));
  if (r.gedaan.length) delen.push('Gedaan (niet meer als open melden):\n' + r.gedaan.map(regel).join('\n'));
  let t = delen.join('\n\n');
  if (t.length > 3500) t = t.slice(0, 3500) + '\n…';
  return t;
}
function volgendeDag(dag) {
  const d = new Date(Date.parse(dag + 'T12:00:00Z') + 86400000);
  return d.toISOString().slice(0, 10);
}

module.exports = { STANDEN, STAND_TEKST, punten, puntId, plat, vaultPad, bronVan, editieSleutel, snoei, zetStand, standenVan, correctieTekst, volgendeDag };
