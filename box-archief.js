'use strict';
/**
 * box-archief.js — wekelijkse archiefstap van de machinekamer-box en het register Open vragen aan David (wv2902, 11-11-2026).
 *
 * WAAROM. MrLean (ML7/ML8, weekronde 11-11) mat: box 797 rijen / 1,9 MB, waarvan 546 afgehandeld; register 673 rijen / 515 kB,
 * 653 afgehandeld. Elke agent die de box of het register leest, betaalt voor die ballast. David drukte 11-11 12:00 Ja op het
 * voorstel (kaart wv2902). Tot nu toe archiveerde alleen de droomronde (n8n, taalmodel) boxrijen ouder dan 14 dagen; het register
 * werd nooit opgeruimd. Deze stap doet het voortaan zonder taalmodel, één keer per week, als nachtketen-stap; de droomronde loopt
 * alleen nog na.
 *
 * WAT.
 * - Box (00_Systeem/Meldingen/machinekamer.md): een rij (`## [soort] JJJJ-MM-DD …`) met `- status: afgehandeld|gesloten|klaar|gedaan`
 *   en een datum direct achter dat woord (d-m, d-m-jjjj of jjjj-mm-dd; jaar uit de rijkop) die meer dan `dagen` (7) dagen voor
 *   vandaag ligt, gaat ongewijzigd naar Archief/machinekamer-JJJJ-MM.md (JJJJ-MM = maand van die datum), direct onder de regel
 *   "Ongewijzigd overgenomen …" (nieuwste bovenaan; een identiek blok dat er al staat niet nogmaals). Zelfde formaat als de
 *   droomronde. Nooit in machinekamer-archief-t-m-*.md. Een afgesloten rij zonder datum krijgt de datum van vandaag achter het
 *   statuswoord en blijft staan. Onder `## Archief` staat alleen de verwijzingsregel: een maand komt erbij als die link ontbreekt.
 *   Rijen die een schrijver ónder `## Archief` zette, gaan naar boven (vóór de eerste rij). Het blok "**Formaat van een rij:**"
 *   blijft altijd in de box (een rij die het bevat, wordt vlak ervoor afgeknipt). Regels binnen ``` tellen niet als rijkop.
 * - Register (00_Systeem/Open vragen aan David.md): een tabelrij (6 cellen) met status beantwoord|vervallen|afgehandeld en een datum
 *   (eerste datum in de statuscel, jaar uit Gesteld; zonder datum de Gesteld-datum) ouder dan `dagen` gaat ongewijzigd naar
 *   Archief/open-vragen-JJJJ-MM.md, bovenaan de tabel. Een rij die bij een open of uitgestelde Voor jou-kaart hoort (sleutel,
 *   wvN of herkomst.register), blijft staan: de Voor jou-ronde vergelijkt kaart en rij. Kunnen de kaarten niet gelezen worden,
 *   dan blijft het register ongemoeid en is de stap mislukt (de keten probeert het nog een keer).
 * HOE. Eerst de archiefbestanden (vault-veilig: eigen tmp + rename, geen symlink), dan pas de box/het register met wijzig() op een
 * verse lezing: alleen rijen waarvan het blok aantoonbaar in het archief staat, verdwijnen; een rij die intussen veranderde, blijft.
 * Telling vóór = na + gearchiveerd, anders niets schrijven. Weekstempel in <staatMap>/laatste.json: binnen 7 dagen na de vorige
 * geslaagde ronde doet de stap niets (al_gedaan). Geen netwerk; de kaarten komen als functie binnen.
 *
 * CLI: node box-archief.js [--vault DIR] [--vandaag JJJJ-MM-DD] [--dagen 7] [--staat DIR] [--kaarten bestand.json] [--droog] [--forceer]
 *   --kaarten: uitvoer van `voor-jou.py lijst --json` (zonder dit bestand: register overgeslagen). Uitvoer: JSON met tellingen.
 */
const fs = require('fs');
const path = require('path');

const BOX_REL = path.join('00_Systeem', 'Meldingen', 'machinekamer.md');
const REG_REL = path.join('00_Systeem', 'Open vragen aan David.md');
const ARCH_REL = path.join('00_Systeem', 'Meldingen', 'Archief');
const BOX_SLOT = /^\**(afgehandeld|gesloten|klaar|gedaan)\b/;
const REG_SLOT = /^[*\[\s]*(beantwoord|vervallen|afgehandeld)\b/i;
const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const INLEIDING = 'Ongewijzigd overgenomen';

function iso(j, m, d) { return j + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
function geldig(j, m, d) { const t = new Date(Date.UTC(j, m - 1, d)); return t.getUTCFullYear() === j && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; }
function dagen(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }   // b - a
function amsVandaag() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function dm(vandaag) { const p = vandaag.split('-').map(Number); return p[2] + '-' + p[1]; }

// Datum aan het begin van `rest` (na scheidingstekens): jjjj-mm-dd of d-m[-jjjj]. jaar = rijkop/Gesteld; ligt d-m vóór `basis`, dan jaar+1.
function datumVooraan(rest, jaar, basis) {
  let m = /^[\s*:—–\-(]*(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(rest);
  if (m) return geldig(+m[1], +m[2], +m[3]) ? iso(+m[1], +m[2], +m[3]) : null;
  m = /^[\s*:—–\-(]*(\d{1,2})-(\d{1,2})(?:-(\d{4}))?(?![\d-])/.exec(rest);
  if (!m) return null;
  return datumDm(+m[1], +m[2], m[3] ? +m[3] : null, jaar, basis);
}
function datumDm(d, mnd, j, jaar, basis) {
  let y = j || jaar;
  if (!y || !geldig(y, mnd, d)) return null;
  let s = iso(y, mnd, d);
  if (!j && basis && s < basis && dagen(s, basis) > 2) { if (!geldig(y + 1, mnd, d)) return null; s = iso(y + 1, mnd, d); }
  return s;
}

// ── Box ──
// Rijkoppen (regels die met '## ' beginnen, buiten ```-blokken) → segmenten { s, e, kop }.
function segmenten(L) {
  const heads = []; let fence = false;
  L.forEach(function (l, i) { if (/^\s*```/.test(l)) fence = !fence; else if (!fence && l.startsWith('## ')) heads.push(i); });
  return heads.map(function (s, n) { return { s: s, e: n + 1 < heads.length ? heads[n + 1] : L.length, kop: L[s] }; });
}
function boxRij(L, g) {
  const m = /^## \[[^\]]*\] (\d{4})-(\d{2})-(\d{2})/.exec(g.kop);
  const r = { s: g.s, e: g.e, kop: g.kop, rij: !!m, jaar: m ? +m[1] : null, kopdatum: m ? iso(+m[1], +m[2], +m[3]) : null, cut: g.e, stj: null, woord: null, datum: null };
  for (let j = g.s + 1; j < g.e; j++) if (L[j].startsWith('**Formaat van een rij')) { r.cut = j; break; }
  let fence = false;   // review wv2902 MOET 1: een voorbeeld-statusregel in een ```-blok telt niet
  for (let j = g.s + 1; j < r.cut; j++) { if (/^\s*```/.test(L[j])) fence = !fence; else if (!fence && L[j].startsWith('- status:')) { r.stj = j; break; } }
  if (!r.rij || r.stj === null) return r;
  const s = L[r.stj].slice('- status:'.length).trim();
  const w = BOX_SLOT.exec(s);
  if (!w) return r;
  r.woord = w[1];
  r.datum = datumVooraan(s.slice(w[0].length), r.jaar, r.kopdatum);
  return r;
}
function blokTekst(L, r) {
  const b = L.slice(r.s, r.cut);
  while (b.length && b[b.length - 1].trim() === '') b.pop();
  return b.join('\n');
}
function maandVan(datum) { return datum.slice(0, 7); }

// Plan op een boxtekst: { archief: { 'JJJJ-MM': [blok…] }, stempels, rijen }
function boxPlan(tekst, vandaag, grens) {
  const L = tekst.split('\n');
  const R = segmenten(L).map(function (g) { return boxRij(L, g); });
  const archief = {}; let stempels = 0;
  R.forEach(function (r) {
    if (!r.woord) return;
    if (!r.datum) { stempels++; return; }
    if (dagen(r.datum, vandaag) > grens) (archief[maandVan(r.datum)] = archief[maandVan(r.datum)] || []).push(blokTekst(L, r));
  });
  return { archief: archief, stempels: stempels, rijen: R.filter(function (r) { return r.rij; }).length };
}

// Nieuwe boxtekst: rijen waarvan het blok in `bewaard` (Set) staat weg, datumloze afgesloten rijen krijgen vandaag, rijen onder
// ## Archief naar boven, maandlinks erbij. Geeft { tekst, weg, omhoog, gestempeld } of gooit bij een telfout.
function boxNieuw(tekst, vandaag, grens, bewaard, maanden) {
  const L = tekst.split('\n');
  const G = segmenten(L), R = G.map(function (g) { return boxRij(L, g); });
  const ai = R.findIndex(function (r) { return r.kop.trim() === '## Archief'; });
  if (ai < 0) throw new Error('box: kop ## Archief niet gevonden');
  if (R.filter(function (r) { return r.kop.trim() === '## Archief'; }).length !== 1) throw new Error('box: ## Archief staat er meer dan één keer');
  let weg = 0, gestempeld = 0;
  const stuk = function (r) {   // regels die in de box blijven voor segment r ([] = rij weg; bij een afgeknipte rij alleen het formaatblok)
    if (r.woord && r.datum && dagen(r.datum, vandaag) > grens && bewaard.has(blokTekst(L, r))) { weg++; return L.slice(r.cut, r.e); }
    const b = L.slice(r.s, r.e);
    if (r.woord && !r.datum && r.stj !== null) {
      const i = r.stj - r.s;
      // review wv2902 MOET 2: valt vandaag in een ander jaar dan de rijkop, dan het jaar erbij (d-m-jjjj), anders leest de parser rijkop-jaar
      const stempel = dm(vandaag) + (r.jaar && String(r.jaar) !== vandaag.slice(0, 4) ? '-' + vandaag.slice(0, 4) : '');
      const n = b[i].replace(new RegExp('^(- status:\\s*\\**' + r.woord + ')'), '$1 ' + stempel);
      if (n !== b[i]) { b[i] = n; gestempeld++; }
    }
    return b;
  };
  const kop = L.slice(0, G.length ? G[0].s : L.length);
  const voor = [], omhoog = []; let nOmhoog = 0;
  R.forEach(function (r, i) {
    if (i === ai) return;
    const b = stuk(r);
    if (i < ai) { voor.push(b); return; }
    if (!b.length) return;
    if (r.rij && b.length && b[0] === r.kop) nOmhoog++;
    if (b[b.length - 1].trim() !== '') b.push('');
    omhoog.push(b);
  });
  // Archief-segment: kop + verwijzingsregel (+ wat er verder stond, ongemoeid)
  const A = L.slice(R[ai].s, R[ai].e);
  const li = A.findIndex(function (l) { return l.startsWith('Gearchiveerd:'); });
  if (li < 0) throw new Error('box: verwijzingsregel "Gearchiveerd:" onder ## Archief ontbreekt');
  A[li] = linkRegel(A[li], maanden);
  while (A.length && A[A.length - 1].trim() === '') A.pop();
  const N = kop.concat([].concat.apply([], omhoog), [].concat.apply([], voor));
  if (N.length && N[N.length - 1].trim() !== '') N.push('');
  return { tekst: N.concat(A).join('\n') + '\n', weg: weg, omhoog: nOmhoog, gestempeld: gestempeld };
}
function linkRegel(regel, maanden) {
  let r = regel;
  maanden.slice().sort().forEach(function (mnd) {
    if (r.indexOf('Archief/machinekamer-' + mnd + '|') >= 0 || r.indexOf('Archief/machinekamer-' + mnd + ']]') >= 0) return;
    const p = mnd.split('-').map(Number);
    const link = '[[00_Systeem/Meldingen/Archief/machinekamer-' + mnd + '|' + MAANDEN[p[1] - 1] + ' ' + p[0] + ']]';
    // nieuwste eerst: vóór de eerste maandlink die ouder is; geen oudere maar wel maandlinks: achteraan; geen maandlinks: vooraan
    const re = /\[\[00_Systeem\/Meldingen\/Archief\/machinekamer-(\d{4}-\d{2})[|\]]/g; let m, plek = -1, eerder = false;
    while ((m = re.exec(r))) { eerder = true; if (m[1] < mnd) { plek = m.index; break; } }
    if (plek >= 0) r = r.slice(0, plek) + link + ' · ' + r.slice(plek);
    else if (eerder) r = r.replace(/\s*$/, '') + ' · ' + link;
    else r = r.replace(/^Gearchiveerd:\s*/, function (k) { return k + link + ' · '; });
  });
  return r;
}

// ── Register ──
function cellen(regel) { return regel.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(function (x) { return x.trim(); }); }
function regRij(regel) {
  if (regel.indexOf('| 20') !== 0) return null;
  const k = cellen(regel);
  if (k.length !== 6) return null;
  const g = /^(\d{4})-(\d{2})-(\d{2})/.exec(k[0]);
  if (!g) return null;
  const gesteld = iso(+g[1], +g[2], +g[3]);
  const st = k[4].replace(/\*/g, '');
  const w = REG_SLOT.exec(st);
  if (!w) return { regel: regel, k: k, gesteld: gesteld, woord: null };
  let datum = null;
  const re = /(?<![\d-])(?:(\d{4})-(\d{2})-(\d{2})|(\d{1,2})-(\d{1,2})(?:-(\d{4}))?)(?![\d-])/g; let m;
  while (!datum && (m = re.exec(st))) {
    datum = m[1] ? (geldig(+m[1], +m[2], +m[3]) ? iso(+m[1], +m[2], +m[3]) : null) : datumDm(+m[4], +m[5], m[6] ? +m[6] : null, +g[1], gesteld);
  }
  return { regel: regel, k: k, gesteld: gesteld, woord: w[1].toLowerCase(), datum: datum || gesteld };
}
// Open/uitgestelde kaarten → toets of een registerrij erbij hoort (zelfde regels als de koppelregel van plek 5, ruim genomen)
function kaartToets(kaarten) {
  const open = (kaarten || []).filter(function (p) { return p && /^(open|later)$/.test(String(p.status || '')); });
  const woorden = new Set(), plekken = [];
  open.forEach(function (p) {
    if (p.sleutel) woorden.add(String(p.sleutel).toLowerCase());
    const h = p.herkomst && typeof p.herkomst === 'object' ? p.herkomst : {};
    (Array.isArray(h.wv) ? h.wv : []).forEach(function (n) { woorden.add('wv' + n); });
    (Array.isArray(h.register) ? h.register : []).forEach(function (sl) {
      const i = String(sl).indexOf('#');
      plekken.push({ g: i < 0 ? String(sl) : String(sl).slice(0, i), k: i < 0 ? '' : String(sl).slice(i + 1).toLowerCase() });
    });
  });
  return function (r) {
    const t = (r.k[1] + ' ' + r.k[2]).toLowerCase();
    if (plekken.some(function (p) { return r.k[0] === p.g && (!p.k || t.indexOf(p.k) >= 0); })) return true;
    const re = /[a-z0-9][a-z0-9-]*/g; let m;
    while ((m = re.exec(t))) { if (woorden.has(m[0]) || m[0].split('-').some(function (x) { return woorden.has(x); })) return true; }
    return false;
  };
}
function regPlan(tekst, vandaag, grens, hoortBijKaart) {
  const archief = {}; let bijKaart = 0, rijen = 0;
  tekst.split('\n').forEach(function (l) {
    const r = regRij(l); if (!r) return; rijen++;
    if (!r.woord || dagen(r.datum, vandaag) <= grens) return;
    if (hoortBijKaart(r)) { bijKaart++; return; }
    (archief[maandVan(r.datum)] = archief[maandVan(r.datum)] || []).push(l);
  });
  return { archief: archief, bijKaart: bijKaart, rijen: rijen };
}
function regNieuw(tekst, vandaag, grens, hoortBijKaart, bewaard) {
  let weg = 0;
  const uit = tekst.split('\n').filter(function (l) {
    const r = regRij(l);
    if (!r || !r.woord || dagen(r.datum, vandaag) <= grens || hoortBijKaart(r) || !bewaard.has(l)) return true;
    weg++; return false;
  });
  return { tekst: uit.join('\n'), weg: weg };
}

// ── Archiefbestanden ──
function nieuwBoxArchief(mnd, vandaag) {
  const p = mnd.split('-').map(Number);
  return ['---', 'type: meldingenarchief', 'onderwerp: machinekamer-box — rijen afgesloten in ' + MAANDEN[p[1] - 1] + ' ' + p[0] + ', verplaatst uit de box',
    'status: archief', 'bron: 00_Systeem/Meldingen/machinekamer.md (wekelijkse archiefstap van de pod, wv2902)', 'updated: ' + vandaag, '---', '',
    '# Machinekamer-box — archief ' + mnd, '', INLEIDING + ' uit [[00_Systeem/Meldingen/machinekamer|de box]], nieuwste bovenaan.', ''].join('\n');
}
function nieuwRegArchief(mnd, vandaag, kopRegels) {
  const p = mnd.split('-').map(Number);
  return ['---', 'type: registerarchief', 'onderwerp: Open vragen aan David — rijen afgesloten in ' + MAANDEN[p[1] - 1] + ' ' + p[0] + ', verplaatst uit het register',
    'status: archief', 'bron: 00_Systeem/Open vragen aan David.md (wekelijkse archiefstap van de pod, wv2902)', 'updated: ' + vandaag, '---', '',
    '# Open vragen aan David — archief ' + mnd, '', INLEIDING + ' uit [[00_Systeem/Open vragen aan David|het register]], nieuwste bovenaan.', '']
    .concat(kopRegels, ['']).join('\n');
}
function zetUpdated(t, vandaag) { return t.replace(/^updated: .*$/m, 'updated: ' + vandaag); }
// Blokken direct onder de inleidende regel (box) — identieke blokken niet nogmaals
function voegBoxBlokkenIn(t, blokken, vandaag) {
  const nieuw = blokken.filter(function (b) { return t.indexOf(b + '\n') < 0; });
  if (!nieuw.length) return null;
  const A = t.split('\n');
  const i = A.findIndex(function (l) { return l.startsWith(INLEIDING); });
  if (i < 0) throw new Error('archief: inleidende regel ontbreekt');
  const tussen = [];
  nieuw.forEach(function (b) { tussen.push(b, ''); });
  let rest = A.slice(i + 1); while (rest.length && rest[0].trim() === '') rest.shift();
  return zetUpdated(A.slice(0, i + 1).concat([''], tussen, rest).join('\n'), vandaag);
}
function voegRegRijenIn(t, rijen, vandaag) {
  const A = t.split('\n');
  const have = new Set(A);
  const nieuw = rijen.filter(function (r) { return !have.has(r); });
  if (!nieuw.length) return null;
  const i = A.findIndex(function (l) { return /^\|(\s*-+\s*\|)+\s*$/.test(l); });
  if (i < 0) throw new Error('registerarchief: tabelkop ontbreekt');
  return zetUpdated(A.slice(0, i + 1).concat(nieuw, A.slice(i + 1)).join('\n'), vandaag);
}

// Schrijf blokken naar een archiefbestand (maken als het ontbreekt); geeft de set blokken die er daarna aantoonbaar in staan.
function schrijfArchief(VV, pad, maak, voegIn, items, vandaag, droog, isIn) {
  let t = null;
  try { t = VV.lees(pad); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (droog) return new Set(items);
  if (t === null) {
    const n = voegIn(maak(), items, vandaag);
    const ok = VV.schrijf(pad, n, { modus: 0o660, alsGelijk: function (st) { return !st; } });
    if (!ok) VV.wijzig(pad, function (x) { return voegIn(x, items, vandaag); });   // intussen gemaakt: gewoon invoegen
  } else {
    VV.wijzig(pad, function (x) { return voegIn(x, items, vandaag); });
  }
  const na = VV.lees(pad);
  return new Set(items.filter(function (b) { return isIn(na, b); }));
}

// ── De ronde ──
// o: { vault, VV, vandaag, dagen (7), staatMap, kaarten: async () => [...] | null (null = register overslaan), droog, forceer, log }
async function ronde(o) {
  const VV = o.VV, vandaag = o.vandaag || amsVandaag(), grens = o.dagen == null ? 7 : o.dagen;
  const stPad = o.staatMap ? path.join(o.staatMap, 'laatste.json') : null;
  if (stPad && !o.forceer) {
    try { const s = JSON.parse(fs.readFileSync(stPad, 'utf8')); if (s && s.ok && s.datum && dagen(s.datum, vandaag) < 7 && dagen(s.datum, vandaag) >= 0) return { ok: true, al_gedaan: true, detail: { vorige: s.datum } }; } catch (e) { /* geen stempel */ }
  }
  const boxPad = path.join(o.vault, BOX_REL), regPad = path.join(o.vault, REG_REL), arch = path.join(o.vault, ARCH_REL);
  const detail = { vandaag: vandaag, dagen: grens, droog: !!o.droog };
  // Box
  const b0 = VV.lees(boxPad);
  const bp = boxPlan(b0, vandaag, grens);
  const bewaard = new Set(), maanden = Object.keys(bp.archief);
  maanden.forEach(function (mnd) {
    const pad = path.join(arch, 'machinekamer-' + mnd + '.md');
    schrijfArchief(VV, pad, function () { return nieuwBoxArchief(mnd, vandaag); }, voegBoxBlokkenIn, bp.archief[mnd], vandaag, o.droog,
      function (t, b) { return t.indexOf(b + '\n') >= 0; }).forEach(function (b) { bewaard.add(b); });
  });
  let bx = null;
  const boxFn = function (t) {
    const voor = boxPlan(t, vandaag, grens).rijen;
    bx = boxNieuw(t, vandaag, grens, bewaard, maanden);
    const na = boxPlan(bx.tekst, vandaag, grens).rijen;
    if (voor !== na + bx.weg) throw new Error('box: telling klopt niet (voor ' + voor + ', na ' + na + ', weg ' + bx.weg + ')');
    return bx.tekst === t ? null : bx.tekst;
  };
  if (o.droog) boxFn(b0); else VV.wijzig(boxPad, boxFn, { krimpOk: true });
  const b1 = o.droog ? (bx ? bx.tekst : b0) : VV.lees(boxPad);
  detail.box = { rijen_voor: bp.rijen, archief: bx ? bx.weg : 0, gestempeld: bx ? bx.gestempeld : 0, maanden: maanden.sort(),
    bytes_voor: Buffer.byteLength(b0), bytes_na: Buffer.byteLength(b1), rijen_na: boxPlan(b1, vandaag, grens).rijen };
  // Register
  let kaarten = null, kaartFout = null;
  try { kaarten = o.kaarten ? await o.kaarten() : null; } catch (e) { kaartFout = String(e && e.message || e).slice(0, 120); }
  if (!Array.isArray(kaarten)) {
    detail.register = { overgeslagen: kaartFout || 'geen kaartenlijst' };
    if (o.log) o.log({ stap: 'box-archief', box: detail.box, register: 'overgeslagen' });
    return { ok: false, reden: 'register overgeslagen: ' + (kaartFout || 'geen kaartenlijst'), detail: detail };
  }
  const hoort = kaartToets(kaarten);
  const r0 = VV.lees(regPad);
  const rp = regPlan(r0, vandaag, grens, hoort);
  const kopRegels = (function () { const A = r0.split('\n'); const i = A.findIndex(function (l) { return /^\|(\s*-+\s*\|)+\s*$/.test(l); }); return i > 0 ? [A[i - 1], A[i]] : ['| Gesteld | Kanaal | Vraag | Aanname | Status | Bewijs |', '|---|---|---|---|---|---|']; })();
  const rBewaard = new Set();
  Object.keys(rp.archief).forEach(function (mnd) {
    const pad = path.join(arch, 'open-vragen-' + mnd + '.md');
    schrijfArchief(VV, pad, function () { return nieuwRegArchief(mnd, vandaag, kopRegels); }, voegRegRijenIn, rp.archief[mnd], vandaag, o.droog,
      function (t, l) { return t.split('\n').indexOf(l) >= 0; }).forEach(function (l) { rBewaard.add(l); });
  });
  let rx = null;
  const regFn = function (t) {
    const voor = regPlan(t, vandaag, -1e9, function () { return true; }).rijen;
    rx = regNieuw(t, vandaag, grens, hoort, rBewaard);
    const na = regPlan(rx.tekst, vandaag, -1e9, function () { return true; }).rijen;
    if (voor !== na + rx.weg) throw new Error('register: telling klopt niet');
    return rx.weg ? rx.tekst : null;
  };
  if (o.droog) regFn(r0); else VV.wijzig(regPad, regFn, { krimpOk: true });
  const r1 = o.droog ? (rx ? rx.tekst : r0) : VV.lees(regPad);
  detail.register = { rijen_voor: rp.rijen, archief: rx ? rx.weg : 0, bij_open_kaart: rp.bijKaart, maanden: Object.keys(rp.archief).sort(),
    bytes_voor: Buffer.byteLength(r0), bytes_na: Buffer.byteLength(r1) };
  if (stPad && !o.droog) {
    fs.mkdirSync(o.staatMap, { recursive: true, mode: 0o700 });
    const tmp = stPad + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.assign({ ok: true, datum: vandaag }, detail)) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, stPad);
  }
  if (o.log) o.log({ stap: 'box-archief', box: detail.box, register: detail.register });
  return { ok: true, detail: detail };
}

module.exports = { ronde, boxPlan, boxNieuw, regPlan, regNieuw, regRij, kaartToets, linkRegel, voegBoxBlokkenIn, voegRegRijenIn, segmenten, datumVooraan };

if (require.main === module) {
  const a = process.argv.slice(2), arg = function (n) { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
  const kaartBestand = arg('--kaarten');
  ronde({
    vault: arg('--vault') || '/opt/data/AI_SecondBrain', VV: require(path.join(__dirname, 'vault-veilig.js')),
    vandaag: arg('--vandaag') || null, dagen: arg('--dagen') != null ? Number(arg('--dagen')) : 7, staatMap: arg('--staat'),
    droog: a.indexOf('--droog') >= 0, forceer: a.indexOf('--forceer') >= 0,
    kaarten: kaartBestand ? async function () { const j = JSON.parse(fs.readFileSync(kaartBestand, 'utf8')); return Array.isArray(j) ? j : j.punten; } : null,
  }).then(function (r) { console.log(JSON.stringify(r, null, 1)); process.exit(r.ok ? 0 : 1); },
    function (e) { console.error('box-archief: ' + (e && e.stack || e)); process.exit(2); });
}
