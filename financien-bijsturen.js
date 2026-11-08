// financien-bijsturen.js — OVIS Financiën › Uitgaven, blok "Zelf bij te sturen" (wv2700; ontwerp vault "01_Ontwikkeling/OVIS Financiën 8+
// (ontwerp 7-11-2026)" § 10).
//
// WAAROM. David 8-11-2026: "De financiële situatie: beïnvloedbare categorieen inzichtelijk maken? Denk aan: boodschappen (uitsplitsing?),
// uit eten, stroomverbruik (in kWh), streamingdiensten en andere abonnementen?" Het tabblad Uitgaven zette alle categorieën naast elkaar;
// streaming zat onder "PayPal incasso", de horeca-subcategorieën waren rommelig en de kWh stonden alleen op een vaultpagina.
//
// WAT. Vijf posten waar het gezin zelf aan draait, elk met de laatste volle maand, de lopende maand, het gemiddelde van 12 maanden, de
// reeks van 12 volle maanden, een uitsplitsing en hooguit één advies (rekensom met de aanname in de zin, zekerheid "schatting"):
//   boodschappen   categorie boodschappen, per winkel (vaste lijst ketens, de rest "andere winkels"), bezoeken en gemiddeld per bezoek
//   uit_eten       categorie horeca en uit eten, per soort (vaste regels op subcategorie en tegenpartij); advies bij ≥ 3× afhalen per maand
//   stroom         de tabel van de vaultpagina Energieverbruik (Tibber) uit de facturen: kWh, € en ct/kWh; aandeel auto's en "slim laden"
//                  uit de rijen van die pagina (geen bedrag per auto: niet meetbaar)
//   streaming      streaming, media en apps: PayPal-posten op de dienst van hun ontvangstbewijs (tabel paypal_bewijs, alleen als de post
//                  één deel heeft en precies één bewijs: review wv2700 MOET 1) plus posten met een media-subcategorie; advies bij ≥ 2
//                  videodiensten tegelijk
//   abonnementen   de rest van de categorie abonnementen en communicatie (mobiel, internet en tv, losse PayPal-betalingen …)
// Elke euro van boodschappen, uit eten en (streaming + abonnementen) komt uit dezelfde delen als het blok uitgaven: som per maand gelijk
// aan die categorieën (toets). Alleen lezen: geen netwerk, geen taalmodel, schrijft niets. Namen van winkels en diensten wel, IBAN's niet.
'use strict';
const fs = require('fs'), path = require('path');

const P_ENERGIE = path.join('20_Prive', 'Financien', 'Energieverbruik thuis (Tibber).md');
const AFWIJK_PCT = 0.25, AFWIJK_EUR = 100;
const KLEIN = 15;                 // een boodschappenbezoek onder € 15 telt als klein
const AFHAAL_MIN = 3, AFHAAL_MINDER = 2;   // advies uit eten: vanaf 3× per maand afhalen/bezorgen; rekensom = 2× per maand minder
const CAT_B = 'boodschappen', CAT_H = 'horeca en uit eten', CAT_A = 'abonnementen en communicatie', CAT_V = 'vrije tijd en sport';

// winkels (tegenpartij, hoofdletterongevoelig); volgorde telt
const WINKELS = [['Albert Heijn', /albert ?heijn|\bah to go\b|^ah\b|\bah [0-9]/i], ['Jumbo', /jumbo/i], ['Lidl', /lidl/i], ['Plus', /\bplus\b/i], ['Aldi', /aldi/i],
  ['Dirk', /\bdirk\b/i], ['Picnic', /picnic/i], ['Vomar', /vomar/i], ['Hoogvliet', /hoogvliet/i], ['Spar', /\bspar\b/i], ['Ekoplaza', /ekoplaza/i], ['Crisp', /crisp/i],
  ['Flink', /\bflink\b/i], ['Coop', /\bcoop\b/i], ['DekaMarkt', /dekamarkt/i], ['Marqt', /marqt/i]];
const ANDERE_WINKELS = 'andere winkels (slager, bakker, toko …)';
function winkel(x) { const t = String(x.tegenpartij || '') + ' ' + String(x.omschrijving || ''); for (let i = 0; i < WINKELS.length; i++) if (WINKELS[i][1].test(t)) return WINKELS[i][0]; return ANDERE_WINKELS; }

// uit eten: soort uit subcategorie en tegenpartij
const H_SOORT = [['afhalen en bezorgen', /afhaal|bezorg|maaltijd|thuisbezorgd|takeaway|uber ?eats|deliveroo|just eat/i],
  ['fastfood en snacks', /fast ?food|snack|cafetaria|frituur|mcdonald|burger king|kfc|febo|domino|new york pizza/i],
  ['restaurant', /restaurant|diner|eetcaf|gastrobar|etentje|lounge|brouwerij|foodhal|bistro|brasserie|catering/i],
  ['café, lunch en koffie', /caf[eé]|koffie|lunch|drink|drank|theetuin|bakker|starbucks|kantine|bar\b/i],
  ['ijs en zoet', /\bijs|poffertje|wafel|pannenko/i]];
function horecaSoort(x, sub) {
  const s = String(sub || ''), t = String(x.tegenpartij || '');
  for (let i = 0; i < H_SOORT.length; i++) if (H_SOORT[i][1].test(s)) return H_SOORT[i][0];
  for (let i = 0; i < H_SOORT.length; i++) if (H_SOORT[i][1].test(t)) return H_SOORT[i][0];
  return 'overig';
}

// media: dienst (PayPal-bewijs of tegenpartij) → soort; subcategorie als terugval
const MEDIA = [['video', /netflix|disney|\bhbo|skyshowtime|videoland|viaplay|\bnpo\b|prime ?video|amazon prime|paramount|discovery|ziggo go/i],
  ['muziek', /spotify|deezer|tidal|youtube music/i], ['gaming', /\bsony\b|playstation|xbox|nintendo|steam|epic games|game/i],
  ['boeken', /kobo|storytel|bookbeat|e-?book|luisterboek/i], ['apps en opslag', /apple|icloud|google|samsung|microsoft|dropbox|software|\bapps?\b|office/i]];
const MEDIA_SUB = /^(streaming|omroep|gaming|games|apps|software|e-books|google|bol select)$/i;
function mediaSoort(t) { const s = String(t || ''); for (let i = 0; i < MEDIA.length; i++) if (MEDIA[i][1].test(s)) return MEDIA[i][0]; return null; }
function subSoort(sub) { const s = String(sub || '').toLowerCase(); return s === 'omroep' ? 'video' : s === 'gaming' || s === 'games' ? 'gaming' : s === 'e-books' ? 'boeken' : s === 'streaming' ? null : 'apps en opslag'; }
const NETJES = { netflix: 'Netflix', disney: 'Disney+', hbo: 'HBO Max', skyshowtime: 'SkyShowtime', sony: 'PlayStation', apple: 'Apple', google: 'Google', samsung: 'Samsung',
  steampowered: 'Steam', microsoft: 'Microsoft', videoland: 'Videoland', spotify: 'Spotify', npo: 'NPO', kobo: 'Kobo' };

function r2(n) { return Math.round(n * 100) / 100; }
function afwijking(nu, gem) { if (nu == null || gem == null) return null; const d = nu - gem; return Math.abs(d) > AFWIJK_EUR && Math.abs(d) > AFWIJK_PCT * Math.abs(gem) ? (d > 0 ? 'hoger' : 'lager') : null; }
function veilig(s, n) { return String(s == null ? '' : s).normalize('NFC').replace(/[^\p{L}\p{N} .,&'()\-/+*—]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 40).trim(); }

// nr → subcategorie en nr → PayPal-bewijzen (alleen de posten in de delen)
function kaarten(a, nrs) {
  const sub = new Map(), pp = new Map();
  if (!nrs.length) return { sub: sub, pp: pp };
  const lijst = Array.from(new Set(nrs));
  for (let i = 0; i < lijst.length; i += 500) {
    const stuk = lijst.slice(i, i + 500), q = stuk.map(function () { return '?'; }).join(',');
    a.db.prepare('SELECT nr, subcategorie FROM verrijking WHERE nr IN (' + q + ')').all(...stuk).forEach(function (r) { sub.set(r.nr, r.subcategorie); });
    let rij = [];
    try { rij = a.db.prepare('SELECT nr, dienst, ontvanger FROM paypal_bewijs WHERE nr IN (' + q + ')').all(...stuk); } catch (e) { rij = []; }   // oud archief zonder PayPal-laag
    rij.forEach(function (r) { if (!pp.has(r.nr)) pp.set(r.nr, []); pp.get(r.nr).push(r); });
  }
  return { sub: sub, pp: pp };
}

// in welke post (en welk onderdeel) valt een deel van de stroom leven; null = geen beïnvloedbare post
function indeling(x, k) {
  const sub = k.sub.get(x.nr);
  if (x.cat === CAT_B) return { post: 'boodschappen', deel: winkel(x) };
  if (x.cat === CAT_H) return { post: 'uit_eten', deel: horecaSoort(x, sub) };
  if (x.cat !== CAT_A && x.cat !== CAT_V) return null;
  // PayPal: alleen een hele post (één deel) met precies één ontvangstbewijs krijgt de dienst van dat bewijs (review MOET 1)
  const bw = k.pp.get(x.nr);
  const dienst = bw && bw.length === 1 && x.deel === x.bedrag ? bw[0].dienst : null;
  if (dienst) {
    const s = mediaSoort(dienst) || mediaSoort(bw[0].ontvanger);
    const naam = NETJES[dienst] || veilig(dienst, 24);
    if (s) return { post: 'streaming', deel: s, dienst: naam };
    return x.cat === CAT_A ? { post: 'abonnementen', deel: 'losse PayPal-betalingen' } : null;
  }
  if (MEDIA_SUB.test(String(sub || '').trim())) {
    const s = mediaSoort(x.tegenpartij) || subSoort(sub) || 'video';
    return { post: 'streaming', deel: s };
  }
  if (x.cat !== CAT_A) return null;
  const s = String(sub || '').toLowerCase();
  return { post: 'abonnementen', deel: /mobiel/.test(s) ? 'mobiel' : /internet|tv/.test(s) ? 'internet en tv' : /paypal/.test(s) ? 'losse PayPal-betalingen' : 'overig' };
}

// ── stroom: de tabel van de energiepagina ──
const MND = { jan: 1, feb: 2, mrt: 3, apr: 4, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12 };
function getalNl(s) { const t = String(s || '').replace(/[€\s]/g, '').replace(/\./g, '').replace(',', '.'); return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null; }
function stroomUit(tekst) {
  const regels = String(tekst).split('\n');
  let i = regels.findIndex(function (r) { return /^\|\s*Maand\s*\|/i.test(r) && /kWh/i.test(r) && /alles-in/i.test(r); });
  if (i < 0) return null;
  const kop = regels[i].split('|').slice(1, -1).map(function (c) { return c.trim().toLowerCase(); });
  const kK = kop.findIndex(function (c) { return /verbruik/.test(c); }), kE = kop.findIndex(function (c) { return /factuur/.test(c); }),
    kA = kop.findIndex(function (c) { return /alles-in/.test(c); }), kP = kop.findIndex(function (c) { return /kale/.test(c); });
  if (kK < 0 || kE < 0) return null;
  const rijen = [];
  for (i = i + 2; i < regels.length && /^\|/.test(regels[i]); i++) {
    const c = regels[i].split('|').slice(1, -1).map(function (x) { return x.trim(); });
    const m = /^([a-z]{3})\w*\s+(\d{4})$/i.exec(c[0] || '');
    if (!m || !MND[m[1].toLowerCase()]) continue;
    const kwh = getalNl(c[kK]), eur = getalNl(c[kE]);
    if (kwh == null || eur == null || kwh <= 0) continue;
    rijen.push({ maand: m[2] + '-' + String(MND[m[1].toLowerCase()]).padStart(2, '0'), kwh: kwh, eur: eur, ct: kA >= 0 ? getalNl(c[kA]) : r2(eur / kwh * 100), kaal: kP >= 0 ? getalNl(c[kP]) : null });
  }
  rijen.sort(function (p, q) { return p.maand < q.maand ? -1 : 1; });
  const laad = /Geladen per jaar\s*\|\s*([\d.]+)\s*kWh\s*\((\d+)\s*%/i.exec(tekst);
  const slim = /goedkoopste[^|\n]*\|\s*±?\s*€\s*([\d.]+)\s*per jaar/i.exec(tekst);
  return { rijen: rijen, laad: laad ? { kwh_jaar: getalNl(laad[1]), pct: Number(laad[2]) } : null, slim: slim ? getalNl(slim[1]) : null };
}
// wv2707: lopende maand uit de Tibber-uurdata (TIBBER_DIR/uur.json, door server.js na de bankronde). Alleen kWh; het bedrag komt met de factuur.
const MND_NAAM = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
function stroomLopend(o) {
  let u = o && o.tibberUur;
  if (u === undefined) { try { u = JSON.parse(fs.readFileSync(path.join(process.env.TIBBER_DIR || '/opt/data/tibber', 'uur.json'), 'utf8')); } catch (e) { u = null; } }
  const m = u && u.maand;
  if (!m || !/^\d{4}-\d{2}$/.test(m.maand || '') || !/^\d{4}-\d{2}-\d{2}$/.test(m.t_m || '') || m.t_m.slice(0, 7) !== m.maand) return null;
  if (typeof m.kwh !== 'number' || !isFinite(m.kwh) || m.kwh < 0 || !(m.uren > 0) || !(m.verwacht > 0)) return null;
  return { maand: m.maand, t_m: m.t_m, kwh: m.kwh, mist: Math.max(0, Math.round(m.verwacht - m.uren)) };
}
function lopendZin(l) {
  const mn = MND_NAAM[Number(l.maand.slice(5)) - 1];
  return mn[0].toUpperCase() + mn.slice(1) + ' t/m ' + Number(l.t_m.slice(8)) + ' ' + mn.slice(0, 3) + ': ' + Math.round(l.kwh).toLocaleString('nl-NL') + ' kWh' +
    (l.mist ? ' (' + l.mist + ' uur ontbreekt nog)' : '') + ', uit de uurdata van Tibber; het bedrag komt met de factuur.';
}
function stroomPost(vault, twaalf, mNu, lopend) {
  const p = path.join(vault, P_ENERGIE);
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return { id: 'stroom', naam: 'Stroom', niet: 'de energiepagina is er niet' }; }
  if (!st.isFile() || st.size > 400000) return { id: 'stroom', naam: 'Stroom', niet: 'de energiepagina is niet te lezen' };
  const s = stroomUit(fs.readFileSync(p, 'utf8'));
  if (!s || !s.rijen.length) return { id: 'stroom', naam: 'Stroom', niet: 'geen maandtabel op de energiepagina', bron: P_ENERGIE };
  const laatste = s.rijen.slice(-12), nu = laatste[laatste.length - 1];
  const sk = laatste.reduce(function (t, r) { return t + r.kwh; }, 0), se = laatste.reduce(function (t, r) { return t + r.eur; }, 0), n = laatste.length;
  return { id: 'stroom', naam: 'Stroom', eenheid: 'kWh', t_m: nu.maand, achter: nu.maand < (twaalf[twaalf.length - 1] || mNu),
    nu: r2(nu.eur), kwh: nu.kwh, ct: nu.ct, kaal: nu.kaal, gem12: r2(se / n), gem_kwh: Math.round(sk / n), ct_gem: Math.round(se / sk * 1000) / 10, maanden_tabel: n,
    reeks: laatste.map(function (r) { return { maand: r.maand, waarde: r.kwh, eur: r.eur, ct: r.ct }; }),
    inzicht: (lopend && lopend.maand > nu.maand ? [lopendZin(lopend)] : []).concat(s.laad && s.laad.pct > 0 ? ['De auto\'s laden: ± ' + s.laad.pct + ' % van de stroom (± ' + Math.round(s.laad.kwh_jaar).toLocaleString('nl-NL') + ' kWh per jaar; ondergrens uit de uurdata). Per auto is niet te zien.'] : []),
    advies: s.slim > 0 ? { per_jaar: Math.round(s.slim), zekerheid: 'schatting', zin: 'Slim laden in de Tibber-app: dezelfde kWh voor de auto in de goedkoopste uren.' } : null,
    lopend: lopend && lopend.maand > nu.maand ? lopend : undefined,
    bron: P_ENERGIE, uitleg: 'Uit de maandfacturen van Tibber (alles-in = alle kosten incl. btw en energiebelasting gedeeld door de kWh).' };
}

// ── het blok ──
// delen = boekingen().delen van financien-overzicht.js; o = { mNu, twaalf (12 volle maanden, oud → nieuw), vault }
function bijsturen(a, delen, o) {
  const mNu = o.mNu, twaalf = o.twaalf || [], n12 = twaalf.length, mVol = twaalf[n12 - 1] || null, in12 = new Set(twaalf);
  const leven = delen.filter(function (x) { return x.stroom === 'leven' && (in12.has(x.maand) || x.maand === mNu); });
  const k = kaarten(a, leven.map(function (x) { return x.nr; }));
  const P = {};
  ['boodschappen', 'uit_eten', 'streaming', 'abonnementen'].forEach(function (id) { P[id] = { maand: new Map(), deel: new Map(), diensten: new Map(), nrs: new Set() }; });
  leven.forEach(function (x) {
    const d = indeling(x, k);
    if (!d) return;
    const p = P[d.post], bedrag = -x.deel;
    p.maand.set(x.maand, (p.maand.get(x.maand) || 0) + bedrag);
    if (!in12.has(x.maand)) return;
    if (!p.deel.has(d.deel)) p.deel.set(d.deel, { som: 0, keer: 0, klein: 0, klein_som: 0 });
    const g = p.deel.get(d.deel);
    g.som += bedrag;
    if (x.deel < 0) { g.keer++; if (bedrag < KLEIN) { g.klein++; g.klein_som += bedrag; } }
    if (d.dienst) p.diensten.set(d.dienst, d.deel);
  });
  const fl = function (m, cat) { return m && cat ? { van: m, tot: m, stroom: 'leven', cat: cat } : null; };
  const post = function (id, naam, cat, deelNaam) {
    const p = P[id];
    const reeks = twaalf.map(function (m) { return { maand: m, waarde: r2(p.maand.get(m) || 0) }; });
    const som12 = reeks.reduce(function (t, r) { return t + r.waarde; }, 0), gem = n12 ? r2(som12 / n12) : null, nu = r2(p.maand.get(mVol) || 0);
    const delenL = Array.from(p.deel.entries()).map(function (e) {
      const g = e[1];
      return { naam: e[0], per_maand: n12 ? r2(g.som / n12) : null, keer_pm: n12 ? Math.round(g.keer / n12 * 10) / 10 : null, per_keer: g.keer ? r2(g.som / g.keer) : null, _klein: g.klein, _klein_som: g.klein_som };
    }).filter(function (g) { return Math.abs(g.per_maand || 0) >= 0.5; }).sort(function (p1, q1) { return (q1.per_maand || 0) - (p1.per_maand || 0); });
    return { id: id, naam: naam, nu: nu, lopend: r2(p.maand.get(mNu) || 0), gem12: gem, afwijking: afwijking(nu, gem), reeks: reeks, deel_naam: deelNaam,
      delen: delenL, filter: cat ? { nu: fl(mVol, cat), twaalf: n12 ? { van: twaalf[0], tot: mVol, stroom: 'leven', cat: cat } : null } : null, inzicht: [], advies: null };
  };
  const B = post('boodschappen', 'Boodschappen', CAT_B, 'winkel');
  const kl = B.delen.reduce(function (t, g) { return { n: t.n + g._klein, s: t.s + g._klein_som }; }, { n: 0, s: 0 });
  if (n12 && kl.n) B.inzicht.push('Kleine bezoeken onder € ' + KLEIN + ': ± ' + Math.round(kl.n / n12) + ' per maand, samen € ' + Math.round(kl.s / n12) + ' per maand.');
  B.inzicht.push('Per product: nog niet. De kassabonnen van Albert Heijn zijn niet gekoppeld; de bank ziet alleen het bedrag per bezoek.');
  const H = post('uit_eten', 'Uit eten en afhalen', CAT_H, 'soort');
  const af = H.delen.find(function (g) { return g.naam === 'afhalen en bezorgen'; });
  if (af && af.keer_pm >= AFHAAL_MIN && af.per_keer > 0) {
    H.advies = { per_jaar: Math.round(AFHAAL_MINDER * 12 * af.per_keer), zekerheid: 'schatting',
      zin: AFHAAL_MINDER + ' keer per maand minder afhalen of laten bezorgen (nu ± ' + af.keer_pm.toLocaleString('nl-NL') + ' keer, gemiddeld € ' + Math.round(af.per_keer) + ' per keer). Wat je dan zelf kookt gaat er nog af.' };
  }
  const S = post('streaming', 'Streaming, media en apps', null, 'soort');
  const A = post('abonnementen', 'Andere abonnementen', null, 'soort');
  // actieve diensten uit de abonnementen (per maand, per jaar); welke media zijn ziet de tabel aan naam en subcategorie
  let abo = [];
  try { abo = a.db.prepare('SELECT naam, categorie, subcategorie, ritme, per_maand FROM abonnementen WHERE actief = 1 AND per_maand > 0').all(); } catch (e) { abo = []; }
  const lijstS = [], lijstA = [];
  abo.forEach(function (r) {
    if (r.categorie !== CAT_A && r.categorie !== CAT_V) return;
    const naam = veilig(String(r.naam || '').replace(/^PayPal\s*—\s*/i, ''), 30) || 'zonder naam';
    const pp = /^PayPal\s*—/i.test(String(r.naam || ''));
    const s = pp ? mediaSoort(r.naam) : MEDIA_SUB.test(String(r.subcategorie || '').trim()) ? (mediaSoort(r.naam) || subSoort(r.subcategorie) || 'video') : null;
    const rij = { naam: naam, soort: s || veilig(r.subcategorie, 24) || null, ritme: r.ritme || null, per_maand: r2(r.per_maand), per_jaar: Math.round(r.per_maand * 12) };
    if (s) lijstS.push(rij); else if (r.categorie === CAT_A) lijstA.push(rij);
  });
  const sorteer = function (l) { return l.sort(function (p1, q1) { return q1.per_maand - p1.per_maand; }); };
  S.lijst = sorteer(lijstS); A.lijst = sorteer(lijstA);
  const video = S.lijst.filter(function (r) { return r.soort === 'video'; });
  if (video.length >= 2) {
    const som = video.reduce(function (t, r) { return t + r.per_maand; }, 0), duurst = Math.max.apply(null, video.map(function (r) { return r.per_maand; }));
    S.advies = { per_jaar: Math.round((som - duurst) * 12), zekerheid: 'schatting', minstens: true,
      zin: video.length + ' videodiensten tegelijk (€ ' + r2(som).toLocaleString('nl-NL', { minimumFractionDigits: 2 }) + ' per maand). Steeds één houden en wisselen; de duurste houden is gerekend.' };
  }
  S.inzicht.push('Of en hoe vaak je een dienst gebruikt, ziet Socev niet.');
  [B, H, S, A].forEach(function (x) { x.delen.forEach(function (g) { delete g._klein; delete g._klein_som; }); });
  let St;
  try { St = stroomPost(o.vault, twaalf, mNu, stroomLopend(o)); } catch (e) { St = { id: 'stroom', naam: 'Stroom', niet: 'de energiepagina is niet te lezen' }; }
  const posten = [B, H, St, S, A];
  const gem = r2(posten.reduce(function (t, x) { return t + (x.niet ? 0 : x.gem12 || 0); }, 0));
  return { maand: mVol, lopend: mNu, maanden: n12, posten: posten, gem12: gem,
    regels: { afwijking: '> ' + Math.round(AFWIJK_PCT * 100) + ' % én > € ' + AFWIJK_EUR + ' tegen het gemiddelde' },
    uitleg: 'Wat jullie zelf kunnen bijsturen, uit dezelfde boekingen als hieronder (stroom uit de facturen). Adviezen zijn schattingen met de aanname erbij; Socev doet zelf niets.' };
}

module.exports = { NETJES: NETJES, bijsturen: bijsturen, indeling: indeling, winkel: winkel, horecaSoort: horecaSoort, mediaSoort: mediaSoort, stroomUit: stroomUit, stroomLopend: stroomLopend, lopendZin: lopendZin, stroomPost: stroomPost, P_ENERGIE: P_ENERGIE };
