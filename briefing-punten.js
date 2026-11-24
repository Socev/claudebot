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
// wv3940 (besluitenpagina nr 346 = 3C46, David Ja 22-11 18:22): bolletjes onder de kop "Gambia-weekreview" (n8n zet dat blok op
// zaterdag letterlijk onder het ochtendbericht) zijn Gambia-punten: punt.gambia = { contact } (de vette naam vooraan). Hun knoppen in
// de app: Gedaan / Laat rusten / Schrijf antwoord. Extra stand 'laat_rusten' (alleen voor Gambia-punten): sluit dat contact voor die
// week; de correctierij geeft het 6 dagen door (t/m de vrijdag erna), Gambia-punten alleen met de naam (geen bedragen of medische
// inhoud naar de briefingsessie, die 's nachts in de vault wordt samengevat).
const crypto = require('crypto');

const STANDEN = ['gedaan', 'later', 'klopt_niet', 'laat_rusten'];
const STAND_TEKST = { gedaan: 'Gedaan', later: 'Later', klopt_niet: 'Klopt niet', laat_rusten: 'Laat rusten' };
const GAMBIA_KOP = /gambia-weekreview/i;
const RUST_DAGEN = 6;   // editie van dag D telt mee in de correctierij voor D+1 .. D+6 (zaterdag -> t/m vrijdag)
const CONTACT_RE = /^\*\*([^*\n]{1,60})\*\*/;
// wv3949 (3C99): het antwoord in Davids Engels als `…` achter ✍️ aan het eind van een Gambia-regel → punt.gambia.antwoord (kopieerblok in
// de app); uit de getoonde tekst gehaald zodat het er niet dubbel staat. Nooit in de correctierij (die bewaart alleen de naam).
const ANTWOORD_RE = /\s*✍️\s*(?:Antwoord:\s*)?`([^`\n]{1,800})`\s*$/u;
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
  let md = [], rubriek = null, nietDoor = false, gambia = false;
  const sluit = function () { if (md.length) { const s = md.join('\n').replace(/^\n+|\n+$/g, ''); if (s) blokken.push({ md: s }); md = []; } };
  for (const ruw of regels) {
    const r = ruw.trim();
    if (r && isKop(r)) { rubriek = plat(r).replace(/:$/, '').slice(0, 80); nietDoor = NIET_DOOR_KOP.test(rubriek); gambia = GAMBIA_KOP.test(rubriek); }
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
    if (gambia) {
      // Codex MOET 2: alleen een vette naam vooraan telt als contact; anders naamloos ('') - nooit vrije berichttekst als naam
      // (die zou na een tik alsnog in de correctierij naar de briefingsessie gaan)
      const c = CONTACT_RE.exec(zin), naam = c ? plat(c[1]).replace(/[\s:—–-]+$/, '') : '';
      punt.gambia = { contact: naam && naam.length <= 60 ? naam : '' };
      const a = ANTWOORD_RE.exec(punt.tekst);
      if (a) { punt.gambia.antwoord = a[1].trim(); punt.tekst = punt.tekst.slice(0, a.index).trim() || punt.tekst; }
    }
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
  // niet_door (MOET 1): de tekst wordt niet eens bewaard, alleen de stand; Gambia-punt (wv3940): alleen de naam
  if (stand) e.punten[punt.id] = punt.niet_door ? { stand: stand, t: new Date(nuMs).toISOString(), niet_door: true }
    : punt.gambia ? { stand: stand, t: new Date(nuMs).toISOString(), gambia: String(punt.gambia.contact || '').slice(0, 80) }
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
function dagPlus(dag, n) {
  const d = new Date(Date.parse(dag + 'T12:00:00Z') + n * 86400000);
  return d.toISOString().slice(0, 10);
}
// wv3940: lopende Laat rusten (Gambia) uit de edities van de laatste RUST_DAGEN dagen t/m dag; [{ contact, tot }] (tot = laatste dag
// waarop de briefing hem nog kent), per contact de laatste
function rustLopend(m, dag) {
  const uit = {}, grens = dagPlus(dag, -(RUST_DAGEN - 1));
  Object.keys((m && m.edities) || {}).forEach(function (k) {
    const kd = String(k.split(':')[1] || '');
    if (k.split(':')[0] !== 'briefing' || kd < grens || kd > dag) return;
    const pt = (m.edities[k] && m.edities[k].punten) || {};
    Object.keys(pt).forEach(function (id) {
      const x = pt[id];
      if (x && x.stand === 'laat_rusten' && x.gambia) {
        const tot = dagPlus(kd, RUST_DAGEN);
        if (!uit[x.gambia] || uit[x.gambia].tot < tot) uit[x.gambia] = { contact: x.gambia, tot: tot };
      }
    });
  });
  return Object.keys(uit).sort().map(function (c) { return uit[c]; });
}
// de rij voor de briefing van de volgende dag: alleen Gedaan en Klopt niet (Later = gewoon open laten), plus (wv3940) Gambia-contacten
// met Gedaan van die dag en lopende Laat rusten van de laatste 6 dagen, alleen met naam; '' = niets door te geven
function correctieTekst(m, sleutel, dag) {
  const e = m && m.edities && m.edities[sleutel];
  const r = { gedaan: [], klopt_niet: [] }, gGedaan = [];
  if (e && e.punten) Object.keys(e.punten).forEach(function (id) {
    const x = e.punten[id];
    if ('gambia' in x) { if (x.stand === 'gedaan' && x.gambia) gGedaan.push(x.gambia); return; }
    if (r[x.stand] && !x.niet_door && x.tekst) r[x.stand].push(x);
  });
  const rust = rustLopend(m, dag);
  if (!r.gedaan.length && !r.klopt_niet.length && !gGedaan.length && !rust.length) return '';
  const regel = function (x) { return '- ' + x.tekst; };
  const delen = ['David tikte in het ochtendbericht van ' + dag + ' (zijn eigen knoppen):'];
  // Codex ZOU (ronde 2): Gambia vooraan, zodat de afkap op 3500 tekens nooit een lopende Laat rusten wegknipt
  if (gGedaan.length) delen.push('Gambia-weekreview, afgehandeld (niet meer als open melden):\n' + gGedaan.map(function (c) { return '- ' + c; }).join('\n'));
  if (rust.length) delen.push('Gambia, laat rusten (David sloot dit contact voor deze week: begin niet opnieuw over wat in de review stond en vraag er niet naar; komt er iets wezenlijk nieuws, zoals een noodgeval, noem dat in een halve zin):\n' + rust.map(function (x) { return '- ' + x.contact + ' (t/m ' + x.tot + ')'; }).join('\n'));
  if (r.klopt_niet.length) delen.push('Klopt niet (niet opnieuw zo melden; is de bron vannacht veranderd, zeg dan in een halve zin wat er nieuw is):\n' + r.klopt_niet.map(regel).join('\n'));
  if (r.gedaan.length) delen.push('Gedaan (niet meer als open melden):\n' + r.gedaan.map(regel).join('\n'));
  let t = delen.join('\n\n');
  if (t.length > 3500) t = t.slice(0, 3500) + '\n…';
  return t;
}
function volgendeDag(dag) { return dagPlus(dag, 1); }

// ── wv4016 (Onderweg — dagbriefing als gesprek, fase 1; David Ja 22-11 22:33, vraag-id c4d5ba57) ──
// 1. autovragen(tekst): het verborgen blok ```socev-autovragen (JSON-lijst, hooguit AV_MAX) uit de briefingtekst. Geeft altijd de tekst
//    zonder elk zo'n blok terug (ook een kapot blok gaat eruit: David ziet nooit JSON) en de geldige vragen. n8n (Opmaak/Briefing sturen)
//    zet het blok onderaan met de taal erbij; de oude omzetting (<pre> terug naar ```) gaf "```\nsocev-autovragen\n…": beide vormen tellen.
//    Een vraag = { punt, vraag, uitleg, gevoelig }; vraag eindigt op ?, gevoelig = '-' | agenda | versturen | geld (onbekend = versturen).
// 2. gesprek(model, vragen, o): de briefing als reeks stukken voor Onderweg (lijst=gesprek): tekstblokken en punten in volgorde, met
//    direct na het punt waar een vraag bij hoort die vraag (o.kaart(v) geeft de Voor jou-kaart of null = geen knop meer). Vragen zonder
//    passend punt komen na het laatste punt. Wat n8n letterlijk onder het bericht zet (Geld deze maand, Uit je Apps, Gambia-weekreview)
//    staat ook niet in de gesproken briefing van nu (Spreektekst leest alleen de pod-uitvoer): hier ook niet. o.spreek = appSpreektekst.
const AV_MAX = 3;
const AV_GEVOELIG = ['-', 'agenda', 'versturen', 'geld'];
const AV_BLOK_RE = /```[ \t]*(?:socev-autovragen[ \t]*\n|\n[ \t]*socev-autovragen[ \t]*\n)([\s\S]*?)(?:```|$)/g;
function autovragen(tekst) {
  const vragen = [], fouten = [];
  let n = 0;
  const schoon = String(tekst || '').replace(AV_BLOK_RE, function (m, inhoud) {
    n++;
    let j = null;
    try { j = JSON.parse(String(inhoud).trim()); } catch (e) { fouten.push('geen json'); return ''; }
    if (!Array.isArray(j)) { fouten.push('geen lijst'); return ''; }
    j.forEach(function (x) {
      if (vragen.length >= AV_MAX) { fouten.push('meer dan ' + AV_MAX); return; }
      if (!x || typeof x !== 'object') { fouten.push('geen object'); return; }
      const vraag = plat(x.vraag).slice(0, 300), uitleg = plat(x.uitleg).slice(0, 900), punt = plat(x.punt).slice(0, 300);
      if (vraag.length < 8 || !/\?$/.test(vraag)) { fouten.push('vraag zonder ?'); return; }
      if (uitleg.length < 20) { fouten.push('uitleg te kort'); return; }
      const g = String(x.gevoelig == null ? '-' : x.gevoelig).trim().toLowerCase() || '-';
      vragen.push({ punt: punt, vraag: vraag, uitleg: uitleg, gevoelig: AV_GEVOELIG.indexOf(g) >= 0 ? g : 'versturen' });   // onbekend label = streng
    });
    return '';
  }).replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  return { tekst: n ? schoon : String(tekst || ''), vragen: vragen, blokken: n, fouten: fouten };
}
// Bij welk punt hoort de vraag: het punt waarvan de platte tekst begint met (of bevat) het opgegeven begin (hoofdletterongevoelig, de
// eerste 60 tekens); anders het punt met de meeste gedeelde woorden (>= 3, woorden van 4+ letters). null = geen.
function norm(s) { return plat(s).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim(); }
function puntBij(model, begin) {
  const b = norm(begin).slice(0, 60);
  if (!b || !model || !Array.isArray(model.punten)) return null;
  const pp = model.punten.filter(function (p) { return !p.niet_door && !p.gambia; });
  const raak = pp.find(function (p) { return norm(p.tekst).indexOf(b) === 0; }) || pp.find(function (p) { return norm(p.tekst).indexOf(b) >= 0; });
  if (raak) return raak.id;
  const w = new Set(b.split(' ').filter(function (x) { return x.length >= 4; }));
  let best = null, bestN = 2;
  pp.forEach(function (p) { const n = norm(p.tekst).split(' ').filter(function (x) { return w.has(x); }).length; if (n > bestN) { best = p.id; bestN = n; } });
  return best;
}
const GESPREK_NIET = /geld deze maand|uit je apps|gambia-weekreview/i;
const GESPREK_MAX = 40;
function gesprek(model, vragen, o) {
  o = o || {};
  const spreek = o.spreek || plat, kaart = o.kaart || function () { return null; };
  if (!model || !Array.isArray(model.blokken) || !model.blokken.length) return null;
  const stukken = [], bij = {}, los = [];
  (vragen || []).forEach(function (v) { const id = v.punt_id; if (id && model.punten.some(function (p) { return p.id === id; })) (bij[id] = bij[id] || []).push(v); else los.push(v); });
  const vraagStuk = function (v) {
    const k = kaart(v);
    if (!k) return;
    stukken.push({ soort: 'vraag', punt_id: v.punt_id || null, tekst: v.vraag, uitleg: v.uitleg, spreek: spreek(v.uitleg + '\n' + v.vraag), kaart: k });
  };
  let weg = false, laatstePunt = -1;
  model.blokken.forEach(function (b) {
    if (b.md != null) {
      const koppen = String(b.md).split('\n').map(function (r) { return r.trim(); }).filter(function (r) { return r && isKop(r); });
      if (koppen.length) weg = GESPREK_NIET.test(plat(koppen[koppen.length - 1]));
      // een blok dat begint met een kop van n8n slaat alleen dat blok over; een gewone kop daarna zet het weer aan
      if (weg || GESPREK_NIET.test(b.md)) return;
      const z = spreek(b.md).trim();
      if (z) stukken.push({ soort: 'tekst', tekst: plat(b.md).slice(0, 1500), spreek: z });
      return;
    }
    const p = b.punt;
    if (!p || p.niet_door || p.gambia || GESPREK_NIET.test(String(p.rubriek || ''))) return;
    stukken.push({ soort: 'punt', punt_id: p.id, tekst: plat(p.tekst).slice(0, 1200), rubriek: p.rubriek || null, spreek: spreek(p.tekst) });
    (bij[p.id] || []).forEach(vraagStuk);
    laatstePunt = stukken.length - 1;   // ná de eigen vragen van dit punt
  });
  // vragen zonder punt: na het laatste punt (vóór een slotzin), anders achteraan
  if (los.length) {
    const rest = laatstePunt >= 0 ? stukken.splice(laatstePunt + 1) : [];
    los.forEach(vraagStuk);
    rest.forEach(function (s) { stukken.push(s); });
  }
  return stukken.filter(function (s) { return s.spreek; }).slice(0, GESPREK_MAX).map(function (s, i) {
    return Object.assign({ i: i, stem: crypto.createHash('sha256').update(s.spreek).digest('hex').slice(0, 12) }, s);
  });
}

module.exports = { STANDEN, STAND_TEKST, RUST_DAGEN, punten, puntId, plat, vaultPad, bronVan, editieSleutel, snoei, zetStand, standenVan, correctieTekst, rustLopend, volgendeDag,
  AV_MAX, AV_GEVOELIG, autovragen, puntBij, gesprek };
