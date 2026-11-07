// financien-vooruit.js — OVIS Financiën 8+, stap 5 en 6: Vooruit (3 en 12 maanden) en Doelen (wv2621; ontwerp vault
// "01_Ontwikkeling/OVIS Financiën 8+ (ontwerp 7-11-2026)" § 3.4, § 3.6 en § 5).
//
// WAAROM. David 6-11-2026: "Echt financieel inzicht, inclusief adviezen." Na stromen, startscherm, uitgaven en adviezen (stap 1–4) ontbrak
// de vraag "wat komt eraan, en kan dit?": een verwacht saldo per maand met de bekende grote bewegingen, en doelen met voortgang.
//
// VOORUIT (prognose, puur rekenen, niets bewaard):
//   start       = vrij beschikbaar op de rekeningen van David en de gedeelde rekeningen (zelfde getal als de buffer op Overzicht)
//   basis       = per maand wat er gemiddeld overbleef over dezelfde 12 volledige maanden als Overzicht: inkomen zonder eenmalig inkomen,
//                 min leven (ook vakanties en andere eenmalige uitgaven) zonder de jaar- en kwartaalposten, min de verplichte aflossing.
//                 Eenmalig inkomen = een post ≥ € 1.000 van een tegenpartij die in minder dan 6 van de 12 maanden iets bracht of die boven
//                 3× de gewone post van die tegenpartij ligt (dividend naast het loon van de eigen BV, een losse overboeking).
//   kalender    = reeksen jaar/kwartaal (volgende datum en bedrag uit de verrijking), de open regels uit het Holding-plan die privégeld
//                 noemen ("€ X netto naar privé" = erbij, "betalen vanaf privé" = eraf, anders een mijlpaal zonder bedrag), het einde van
//                 de rentevaste periode per leningdeel (mijlpaal), Davids eigen doelen van soort "uitgave" (eraf in hun maand), en eenmalig
//                 inkomen van een jaar eerder: kwam het ook 10–14 maanden daarvoor (het jaardividend), dan "elk jaar" en telt het mee;
//                 anders "misschien" (getoond, telt niet).
//   verwacht(k) = start + Σ_{i≤k} (basis × deel_i + Σ kalender_i)   (deel_0 = het nog resterende deel van de lopende maand, daarna 1)
//   laag(k)     = verwacht(k) − σ × √(Σ_{i≤k} deel_i), σ = de standaardafwijking van "over per maand" in die 12 maanden: een tegenvaller
//                 zoals het afgelopen jaar voorkwam
//   krap        = laag onder nul; de laagste maand (op laag) is gemarkeerd.
// Niet in de prognose (en dat staat erbij): vrijwillig sparen, extra aflossen en geld naar of van de Holding (wat je mét het vrije
// geld doet; gemiddelde ernaast), belastingaanslagen die niet maandelijks lopen, en Cynthia's eigen rekeningen.
// "Kan dit?" rekent de App zelf op deze maanden (bedrag eraf vanaf de gekozen maand); niets bewaard tenzij David het als doel opslaat.
//
// DOELEN: de vaultpagina 20_Prive/Financien/Doelen.md (tabel Doel | Bedrag | Datum | Soort | Rekening | Start | Sinds), zodat David ze
// ook zonder App leest en zelf kan bewerken. Soort sparen: voortgang = saldo van de gekoppelde rekening (naam zoals in Saldi, of
// "vrij beschikbaar" = de buffer), op koers = lineair van Start (saldo bij aanmaken) op Sinds naar Bedrag op Datum; achter als het saldo
// meer dan 5 % van de nog te sparen som (minstens € 50) onder die lijn ligt. Soort uitgave: een geplande grote post (komt in Vooruit).
// doelenZet bewerkt alleen die tabel (puur: tekst in, tekst uit); server.js schrijft via vault-veilig (POST /app/financien/doel).
//
// Geen netwerk, geen taalmodel; schrijft zelf niets. Het antwoord gaat alleen naar Davids eigen App (GET /app/financien, blok
// overzicht.vooruit en overzicht.doelen) en, als korte regel, naar de maandbrief (financien-app.js briefing).
'use strict';
const fs = require('fs'), path = require('path');

const HORIZON = 12, EENMALIG_INKOMEN = 1000, REGELMATIG_MAANDEN = 6;
const P_DOELEN = path.join('20_Prive', 'Financien', 'Doelen.md');
const DOEL_KOP = ['Doel', 'Bedrag', 'Datum', 'Soort', 'Rekening', 'Start', 'Sinds'];
const SOORTEN = ['sparen', 'uitgave'], VRIJ = 'vrij beschikbaar';
const MND = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const MND_RE = /\b(jan|feb|mrt|maart|apr|mei|jun|jul|aug|sep|okt|nov|dec)[a-z]*\.?\s+(\d{4})\b/i;
const MND_KORT = { jan: 1, feb: 2, mrt: 3, maart: 3, apr: 4, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12 };

function r2(n) { return Math.round(n * 100) / 100; }
function maandPlus(m, n) { const j = Number(m.slice(0, 4)), x = Number(m.slice(5, 7)) - 1 + n; return (j + Math.floor(x / 12)) + '-' + String(((x % 12) + 12) % 12 + 1).padStart(2, '0'); }
function dagenIn(m) { return new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate(); }
function dagVerschil(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }
function mndNaam(m) { return MND[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4); }
function nlDatum(d) { return Number(d.slice(8, 10)) + '-' + Number(d.slice(5, 7)) + '-' + d.slice(0, 4); }
function eur(n) { const v = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); return (n < 0 ? '− ' : '') + '€ ' + v; }
// "€ 15.776,25" → 15776.25; "15.774" → 15774 (een punt is hier altijd duizendtal)
function bedragUit(s) { const m = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/.exec(String(s || '')); return m ? Number(m[1].replace(/\./g, '') + (m[2] ? '.' + m[2] : '')) : null; }
function zonderAccent(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, ''); }

// ── basis (aangeroepen door financien-overzicht.js op zijn eigen delen; puur) ──
// Actieve reeksen met ritme jaar of kwartaal op de zichtbare rekeningen (niet POT, niet extern), met hun volgende verwachte datum.
function reeksenJaar(a) {
  if (!a.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'abonnementen'").get()) return [];
  const kol = new Set(a.db.prepare('PRAGMA table_info(abonnementen)').all().map(function (c) { return c.name; }));
  if (!kol.has('verwacht_volgende')) return [];
  return a.db.prepare("SELECT a.id, a.naam, a.ritme, a.bedrag_typisch AS bedrag, a.laatste, a.verwacht_volgende AS volgende" + (kol.has('categorie') ? ', a.categorie' : ', NULL AS categorie') +
    " FROM abonnementen a JOIN rekeningen r ON r.rek = a.rek WHERE a.actief = 1 AND a.ritme IN ('jaar', 'kwartaal') AND lower(coalesce(r.eigenaar, '')) NOT IN ('extern', 'pot')").all()
    .filter(function (r) { return r.bedrag > 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(r.volgende || '')); })
    .map(function (r) { return { id: r.id, naam: String(r.naam || '').replace(/[^\p{L}\p{N} .,&'()\-/+]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'vaste post', ritme: r.ritme, bedrag: r2(r.bedrag), volgende: r.volgende, categorie: r.categorie || null }; });
}
// delen = de delen van financien-overzicht.js boekingen() (stroom, sub, deel, maand, id, abo, eenmalig); twaalf = de 12 volledige maanden
function basis(delen, twaalf, reeksen) {
  const n = twaalf.length, in12 = new Set(twaalf), ids = new Set((reeksen || []).map(function (r) { return r.id; }));
  if (!n) return null;
  const s = { inkomen: 0, inkomen_eenmalig: 0, leven: 0, leven_eenmalig: 0, jaarposten: 0, verplicht: 0, vrijwillig: 0 };
  // per tegenpartij (id) de maanden en de mediaan van de posten: loon en dividend van de eigen BV delen één id, dus ook > 3× de mediaan = eenmalig
  const maandenVan = new Map(), postenVan = new Map();
  delen.forEach(function (x) {
    if (!in12.has(x.maand) || x.stroom !== 'inkomen') return;
    if (!maandenVan.has(x.id)) { maandenVan.set(x.id, new Set()); postenVan.set(x.id, []); }
    maandenVan.get(x.id).add(x.maand); postenVan.get(x.id).push(Math.abs(x.deel));
  });
  const med = new Map();
  postenVan.forEach(function (l, id) { const y = l.slice().sort(function (p, q) { return p - q; }), k = y.length; med.set(id, k % 2 ? y[(k - 1) / 2] : (y[k / 2 - 1] + y[k / 2]) / 2); });
  const isEenmalig = function (x) { return Math.abs(x.deel) >= EENMALIG_INKOMEN && ((maandenVan.get(x.id) || new Set()).size < REGELMATIG_MAANDEN || Math.abs(x.deel) > 3 * (med.get(x.id) || 0)); };
  const eenmaligInkomen = [], net = new Map(twaalf.map(function (m) { return [m, 0]; }));
  delen.forEach(function (x) {
    if (!in12.has(x.maand)) return;
    if (x.stroom === 'inkomen') {
      s.inkomen += x.deel;
      if (isEenmalig(x)) { s.inkomen_eenmalig += x.deel; eenmaligInkomen.push(x); } else net.set(x.maand, net.get(x.maand) + x.deel);
    } else if (x.stroom === 'leven') {
      s.leven -= x.deel;
      if (x.eenmalig) s.leven_eenmalig -= x.deel;
      if (!x.eenmalig && x.abo != null && ids.has(x.abo)) s.jaarposten -= x.deel; else net.set(x.maand, net.get(x.maand) + x.deel);
    } else if (x.stroom === 'verschuiven') {
      if (x.sub === 'verplicht') { s.verplicht -= x.deel; net.set(x.maand, net.get(x.maand) + x.deel); } else s.vrijwillig -= x.deel;
    }
  });
  // komt het eenmalig inkomen elk jaar terug? Ja als dezelfde tegenpartij 10–14 maanden eerder ook een post ≥ € 1.000 bracht (24 maanden in de delen)
  const jaarlijks = function (x) {
    const van = maandPlusDatum(x.datum, -14), tot = maandPlusDatum(x.datum, -10);
    const doel = maandPlusDatum(x.datum, -12);
    // minstens de helft van het bedrag (geen loonstrook van dezelfde BV), de post het dichtst bij precies een jaar eerder
    return delen.filter(function (y) { return y.stroom === 'inkomen' && y.id === x.id && y.deel >= Math.max(EENMALIG_INKOMEN, 0.5 * x.deel) && y.datum >= van && y.datum <= tot; })
      .sort(function (p, q) { return Math.abs(dagVerschil(doel, p.datum)) - Math.abs(dagVerschil(doel, q.datum)); })[0] || null;
  };
  // gemiddelde en schommeling per maand van wat er overbleef (zonder eenmalig inkomen en jaarposten; mét eenmalige uitgaven)
  const reeks = twaalf.map(function (m) { return net.get(m); }), gem = reeks.reduce(function (a, b) { return a + b; }, 0) / n;
  const sigma = n > 1 ? Math.sqrt(reeks.reduce(function (a, b) { return a + (b - gem) * (b - gem); }, 0) / (n - 1)) : 0;
  const pm = function (v) { return r2(v / n); };
  return { maanden: n, van: twaalf[0], tot: twaalf[n - 1],
    per_maand: r2(gem), schommeling: r2(sigma), zonder_eenmalig_pm: pm(s.inkomen - s.inkomen_eenmalig - (s.leven - s.leven_eenmalig - s.jaarposten) - s.verplicht),
    eenmalig_pm: pm(s.leven_eenmalig), leven_pm: pm(s.leven - s.leven_eenmalig), vrijwillig_pm: pm(s.vrijwillig),
    per_maand_reeks: twaalf.map(function (m) { return { maand: m, over: r2(net.get(m)) }; }),
    delen: { inkomen: pm(s.inkomen), inkomen_eenmalig: pm(s.inkomen_eenmalig), leven: pm(s.leven), leven_eenmalig: pm(s.leven_eenmalig), jaarposten: pm(s.jaarposten), verplicht: pm(s.verplicht) },
    eenmalig_inkomen: eenmaligInkomen.sort(function (p, q) { return Math.abs(q.deel) - Math.abs(p.deel); }).slice(0, 20)
      .map(function (x) { const j = x.deel > 0 ? jaarlijks(x) : null; return { datum: x.datum, naam: x.tegenpartij || x.omschrijving || 'zonder naam', bedrag: r2(x.deel), jaar_eerder: j ? j.datum : null }; }) };
}
function maandPlusDatum(d, n) { const m = maandPlus(d.slice(0, 7), n), dag = Math.min(Number(d.slice(8, 10)), dagenIn(m)); return m + '-' + String(dag).padStart(2, '0'); }

// ── kalender ──
function maandVan(wanneer) {
  const t = zonderAccent(wanneer);
  let m = /\b(\d{1,2})-(\d{1,2})-(\d{4})\b/.exec(t);
  if (m) return m[3] + '-' + String(m[2]).padStart(2, '0');
  m = MND_RE.exec(t);
  if (m) return m[2] + '-' + String(MND_KORT[m[1].toLowerCase()]).padStart(2, '0');
  return null;
}
// open regels uit het Holding-plan (financien-vault dga.planning) die privégeld noemen
function uitPlanning(planning) {
  const uit = [];
  (planning || []).forEach(function (p) {
    if (!p || p.klaar) return;
    const actie = String(p.actie || ''), a = zonderAccent(actie).toLowerCase();
    if (!/\bprive\b/.test(a)) return;
    const maand = maandVan(p.wanneer);
    let bedrag = null, m;
    if ((m = /€\s*([\d.]+(?:,\d{1,2})?)\s*(?:netto\s+)?naar\s+priv/i.exec(zonderAccent(actie)))) bedrag = bedragUit(m[1]);
    else if (/(betalen|betaling|betaald)\b[^.;]*\bvanaf\s+prive\b/.test(a)) { const b = bedragUit((/€\s*([\d.]+(?:,\d{1,2})?)/.exec(actie) || [])[1]); bedrag = b != null ? -b : null; }
    uit.push({ maand: maand, wanneer: String(p.wanneer || '').slice(0, 30), soort: bedrag == null ? 'mijlpaal' : 'holding', tekst: actie.slice(0, 200), bedrag: bedrag != null ? r2(bedrag) : null, bron: 'Holding-plan (besluitpagina)' });
  });
  return uit;
}
function kalender(o) {
  const mNu = o.nu.slice(0, 7), eind = maandPlus(mNu, HORIZON), uit = [], later = [];
  const zet = function (x) { if (x.maand && x.maand >= mNu && x.maand <= eind) uit.push(x); else if (!x.maand || x.maand > eind) later.push(x); };
  (o.reeksen || []).forEach(function (r) {
    const stap = r.ritme === 'kwartaal' ? 3 : 12;
    let d = r.volgende;
    for (let i = 0; i < 8 && d.slice(0, 7) <= eind; i++) {
      if (d > o.nu) uit.push({ maand: d.slice(0, 7), datum: d, soort: 'vaste post', tekst: r.naam + ' (per ' + r.ritme + ')', bedrag: -r.bedrag, bron: 'bank (reeks in de verrijking)' });
      d = plusMaandenDatum(d, stap);
    }
  });
  uitPlanning(o.planning).forEach(zet);
  // einde rentevast: één mijlpaal per datum (de delen met hun rente)
  const rv = new Map();
  (o.delen_hyp || []).forEach(function (d) { if (!d.rentevast_tm) return; if (!rv.has(d.rentevast_tm)) rv.set(d.rentevast_tm, []); rv.get(d.rentevast_tm).push((d.deel || '?') + (d.rente_bank ? ' (' + String(d.rente_bank).replace('.', ',') + ' %)' : '')); });
  rv.forEach(function (l, d) {
    zet({ maand: d.slice(0, 7), datum: d, soort: 'mijlpaal', tekst: 'Rente vast tot ' + nlDatum(d) + ' voor leningde' + (l.length > 1 ? 'len ' : 'el ') + l.join(', ') + '; daarna een nieuwe rente', bedrag: null, bron: 'hypotheek (je Excel)' });
  });
  (o.doelen || []).forEach(function (d) {
    if (d.soort !== 'uitgave' || !d.datum || d.datum < o.nu) return;
    zet({ maand: d.datum.slice(0, 7), datum: d.datum, soort: 'doel', tekst: d.naam, bedrag: -d.bedrag, bron: 'je doelen' });
  });
  // eenmalig inkomen van een jaar eerder: kwam het ook het jaar daarvoor (jaardividend), dan telt het mee; anders alleen "misschien" (telt niet)
  (o.herhaal || []).forEach(function (x) {
    if (!(x.bedrag > 0)) return;
    const d = plusMaandenDatum(x.datum, 12);
    if (d <= o.nu || d.slice(0, 7) > eind) return;
    if (x.jaar_eerder) uit.push({ maand: d.slice(0, 7), datum: d, soort: 'elk jaar', tekst: x.naam + ': elk jaar rond deze tijd (' + nlDatum(x.jaar_eerder) + ' en ' + nlDatum(x.datum) + '); bedrag van de laatste keer', bedrag: x.bedrag, bron: 'bank, 24 maanden terug' });
    else uit.push({ maand: d.slice(0, 7), datum: d, soort: 'misschien', telt: false, tekst: x.naam + ' bracht een jaar eerder ' + eur(x.bedrag) + ' (' + nlDatum(x.datum) + '); eenmalig, telt niet mee', bedrag: x.bedrag, bron: 'bank, 12 maanden terug' });
  });
  uit.sort(function (p, q) { return p.maand < q.maand ? -1 : p.maand > q.maand ? 1 : Math.abs(q.bedrag || 0) - Math.abs(p.bedrag || 0); });
  later.sort(function (p, q) { return String(p.maand || '9999') < String(q.maand || '9999') ? -1 : 1; });
  return { posten: uit, later: later.slice(0, 10) };
}
function plusMaandenDatum(d, n) {
  const m = maandPlus(d.slice(0, 7), n), dag = Math.min(Number(d.slice(8, 10)), dagenIn(m));
  return m + '-' + String(dag).padStart(2, '0');
}
// de prognose zelf (puur): start, gemiddeld over per maand, schommeling per maand, leven per maand, kalenderposten (telt: false = alleen tonen)
function prognose(p) {
  const mNu = p.nu.slice(0, 7), dag = Number(p.nu.slice(8, 10)), rest = Math.max(0, (dagenIn(mNu) - dag) / dagenIn(mNu));
  let verwacht = p.start, tijd = 0;
  const maanden = [];
  for (let k = 0; k <= HORIZON; k++) {
    const m = maandPlus(mNu, k), deel = k === 0 ? rest : 1;
    const som = r2(p.posten.filter(function (x) { return x.maand === m && x.bedrag != null && x.telt !== false; }).reduce(function (s, x) { return s + x.bedrag; }, 0));
    tijd += deel;
    verwacht = r2(verwacht + p.basis * deel + som);
    const laag = r2(verwacht - p.schommeling * Math.sqrt(tijd));
    maanden.push({ maand: m, deel: Math.round(deel * 1000) / 1000, basis: r2(p.basis * deel), posten: som, verwacht: verwacht, laag: laag,
      buffer: p.leven_pm > 0 ? Math.round(verwacht / p.leven_pm * 10) / 10 : null, buffer_laag: p.leven_pm > 0 ? Math.round(laag / p.leven_pm * 10) / 10 : null, krap: laag < 0 });
  }
  let i = 0;
  maanden.forEach(function (x, j) { if (x.laag < maanden[i].laag) i = j; });
  maanden[i].laagste = true;
  return maanden;
}
// o: { ov (blok overzicht met basis_vooruit en buffer), vault, nu, fv, doelen (blok doelen), reeksen }
function vooruit(o) {
  const ov = o.ov || {}, b = ov.basis_vooruit, buf = ov.buffer;
  if (!b) return { ok: false, waarom: 'geen 12 maanden boekingen om op te rekenen' };
  if (!buf) return { ok: false, waarom: 'geen saldi of leven per maand: geen startpunt' };
  const FV = o.fv || require('./financien-vault.js');
  let v = {};
  try { v = FV.lees(o.vault) || {}; } catch (e) { v = {}; }
  const delenHyp = v.hypotheek && Array.isArray(v.hypotheek.delen) ? v.hypotheek.delen : [];
  const k = kalender({ nu: o.nu, reeksen: o.reeksen || [], planning: v.dga ? v.dga.planning : [], delen_hyp: delenHyp, doelen: o.doelen && o.doelen.doelen, herhaal: b.eenmalig_inkomen });
  const maanden = prognose({ nu: o.nu, start: buf.liquide, basis: b.per_maand, schommeling: b.schommeling, leven_pm: b.leven_pm, posten: k.posten });
  const laagst = maanden.find(function (x) { return x.laagste; });
  return { ok: true, start: { bedrag: r2(buf.liquide), stand_van: buf.stand_van || null, tekst: 'Vrij beschikbaar nu (David en gedeeld)' },
    basis: b.per_maand, schommeling: b.schommeling, eenmalig_pm: b.eenmalig_pm, leven_pm: b.leven_pm, vrijwillig_pm: b.vrijwillig_pm, horizon: HORIZON,
    maanden: maanden, posten: k.posten, later: k.later, laagste: laagst ? { maand: laagst.maand, verwacht: laagst.verwacht, laag: laagst.laag, krap: laagst.krap } : null,
    regels: [
      { tekst: 'Inkomen per maand (' + b.maanden + ' maanden)', bedrag: b.delen.inkomen },
      b.delen.inkomen_eenmalig ? { tekst: 'zonder eenmalig inkomen (≥ € 1.000, niet elke maand of ver boven de gewone post; het jaardividend staat in de kalender)', bedrag: -b.delen.inkomen_eenmalig, sub: true } : null,
      { tekst: 'Leven per maand, ook eenmalige grote uitgaven', bedrag: -b.delen.leven },
      b.delen.jaarposten ? { tekst: 'zonder jaar- en kwartaalposten (staan in de kalender op hun eigen maand)', bedrag: b.delen.jaarposten, sub: true } : null,
      b.delen.verplicht ? { tekst: 'Verplichte aflossing hypotheek', bedrag: -b.delen.verplicht } : null,
      { tekst: 'Gemiddeld over per maand (de basis)', bedrag: b.per_maand },
      { tekst: 'Schommeling per maand (standaardafwijking, 12 maanden)', bedrag: b.schommeling },
    ].filter(Boolean),
    reeks: b.per_maand_reeks, eenmalig_inkomen: b.eenmalig_inkomen,
    niet_mee: ['geld naar of van de Holding, sparen en extra aflossen (het afgelopen jaar gemiddeld ' + eur(Math.abs(b.vrijwillig_pm)) + ' per maand ' + (b.vrijwillig_pm < 0 ? 'erbij' : 'eraf') + ')',
      'eenmalig inkomen dat niet elk jaar terugkomt', 'belastingaanslagen die niet maandelijks lopen', 'Cynthia\'s eigen rekeningen'],
    uitleg: 'Verwacht = het saldo nu, plus elke maand wat er het afgelopen jaar gemiddeld overbleef (vakanties en andere eenmalige uitgaven meegerekend, eenmalig inkomen niet), plus de bekende posten in de kalender. ' +
      'Laag = verwacht min een tegenvaller zoals die het afgelopen jaar voorkwam (de schommeling per maand, ' + eur(b.schommeling) + ', groeit met de wortel van het aantal maanden). Krap = laag onder nul.' };
}

// ── doelen ──
function cel(s, n) { return String(s == null ? '' : s).replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 60); }
function datumUit(s, FV) {
  const t = String(s || '').trim();
  const m = /^(\d{1,2})-(\d{4})$/.exec(t);   // "3-2027" = de 1e van die maand
  if (m) return m[2] + '-' + m[1].padStart(2, '0') + '-01';
  const d = FV.datumIso(t);
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}
function doelenLees(vault, FV) {
  const p = path.join(vault, P_DOELEN);
  let st;
  try { st = fs.statSync(p); } catch (e) { if (e.code === 'ENOENT') return { pagina: null, doelen: [] }; throw e; }
  if (!st.isFile() || st.size > 200000) throw new Error('doelenpagina geen gewoon bestand');
  const rijen = FV.tabel(FV.tabellen(fs.readFileSync(p, 'utf8')), ['doel', 'bedrag', 'datum']) || [];
  const doelen = rijen.map(function (r) {
    const naam = FV.schoon(r.doel, 60), bedrag = FV.nlGetal(r.bedrag), datum = datumUit(FV.schoon(r.datum), FV);
    const soort = /uitgave/i.test(r.soort || '') ? 'uitgave' : 'sparen';
    const start = FV.nlGetal(r.start), sinds = datumUit(FV.schoon(r.sinds), FV);
    return { naam: naam, bedrag: bedrag, datum: datum, soort: soort, rekening: FV.schoon(r.rekening, 60).replace(/^[-–—]$/, '') || null, start: start != null ? start : 0, sinds: sinds };
  }).filter(function (d) { return d.naam && d.bedrag > 0 && d.datum; });
  return { pagina: P_DOELEN, doelen: doelen };
}
// stand per doel; saldi = blok saldi van financien-app.js; ov = overzicht (buffer = "vrij beschikbaar")
function doelStand(d, o) {
  const nu = o.nu, uit = Object.assign({}, d, { saldo: null, status: null, nodig_pm: null, verwacht_nu: null, pct: null });
  const maandenTot = Math.max(0, (Number(d.datum.slice(0, 4)) - Number(nu.slice(0, 4))) * 12 + Number(d.datum.slice(5, 7)) - Number(nu.slice(5, 7)));
  if (d.soort === 'uitgave') { uit.status = d.datum < nu ? 'voorbij' : 'gepland'; return uit; }
  let saldo = null;
  if (d.rekening && d.rekening.toLowerCase() === VRIJ) saldo = o.ov && o.ov.buffer ? o.ov.buffer.liquide : null;
  else if (d.rekening) {
    const rek = (o.saldi && Array.isArray(o.saldi.rekeningen) ? o.saldi.rekeningen : []).filter(function (r) { return r.valuta === 'EUR' && typeof r.saldo === 'number' && String(r.naam || '').toLowerCase() === d.rekening.toLowerCase(); });
    if (rek.length === 1) saldo = rek[0].saldo;
    else { uit.status = rek.length ? 'rekening dubbel' : 'rekening niet gevonden'; return uit; }
  } else { uit.status = 'geen telling'; return uit; }
  if (saldo == null) { uit.status = 'geen telling'; return uit; }
  uit.saldo = r2(saldo);
  uit.pct = Math.max(0, Math.min(100, Math.round(saldo / d.bedrag * 100)));
  if (saldo >= d.bedrag) { uit.status = 'behaald'; return uit; }
  if (d.datum < nu) { uit.status = 'verlopen'; return uit; }
  uit.nodig_pm = r2((d.bedrag - saldo) / Math.max(1, maandenTot));
  const sinds = d.sinds && d.sinds < d.datum ? d.sinds : null;
  if (!sinds) { uit.status = 'op koers?'; return uit; }
  const frac = Math.max(0, Math.min(1, dagVerschil(sinds, nu) / Math.max(1, dagVerschil(sinds, d.datum))));
  uit.verwacht_nu = r2(d.start + (d.bedrag - d.start) * frac);
  const marge = Math.max(50, 0.05 * Math.max(0, d.bedrag - d.start));
  uit.status = saldo < uit.verwacht_nu - marge ? 'achter' : 'op koers';
  uit.achter = uit.status === 'achter' ? r2(uit.verwacht_nu - saldo) : undefined;
  return uit;
}
function doelen(o) {
  const FV = o.fv || require('./financien-vault.js');
  const l = doelenLees(o.vault, FV);
  return { pagina: l.pagina, doelen: l.doelen.map(function (d) { return doelStand(d, o); }).sort(function (p, q) { return p.datum < q.datum ? -1 : 1; }),
    soorten: SOORTEN, vrij: VRIJ,
    uitleg: 'Sparen: de voortgang is het saldo van de gekoppelde rekening (of "vrij beschikbaar"); op koers = een rechte lijn van het saldo bij het aanmaken naar het bedrag op de datum. Uitgave: een geplande grote post; die staat ook in Vooruit.' };
}

// ── doelen schrijven (puur; server.js leest en schrijft via vault-veilig) ──
const SJABLOON = '---\ntype: overzicht\ndomein: Privé\nonderwerp: Financiële doelen (OVIS Financiën › Doelen)\ntags: [prive, financien, doelen]\nupdated: {datum}\n---\n\n' +
  '# Financiële doelen\n\nDe App Financiën › Doelen leest en schrijft de tabel hieronder; je kunt hem ook hier zelf bewerken. Soort **sparen**: de voortgang is het saldo van ' +
  'de rekening in de kolom Rekening (de naam zoals in Saldi, of "vrij beschikbaar" voor de buffer); Start is het saldo toen het doel erbij kwam. Soort **uitgave**: een ' +
  'geplande grote post; die telt mee in Financiën › Vooruit. Datum als dd-mm-jjjj.\n\n## Doelen\n\n';
function tabelRegel(c) { return '| ' + c.join(' | ') + ' |'; }
function nlBedrag(n) { const v = Math.abs(r2(n)), [h, c] = v.toFixed(2).split('.'); return '€ ' + h.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (c !== '00' ? ',' + c : ''); }
// op: { actie: 'nieuw', doel: { naam, bedrag, datum (JJJJ-MM-DD), soort, rekening, start, sinds } } of { actie: 'weg', naam }
function doelenZet(tekst, op, nu) {
  const vandaag = nu || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  let t = tekst == null || tekst === '' ? SJABLOON.replace('{datum}', vandaag) : String(tekst);
  const regels = t.split('\n');
  let k = regels.findIndex(function (r) { const c = r.trim().replace(/^\||\|$/g, '').split('|').map(function (x) { return x.trim().toLowerCase(); }); return c[0] === 'doel' && c[1] === 'bedrag' && c[2] === 'datum'; });
  if (k < 0) {
    if (!/\n## Doelen\s*\n/.test('\n' + t)) t = t.replace(/\s*$/, '\n\n## Doelen\n\n');
    else t = t.replace(/\s*$/, '\n\n');
    t += tabelRegel(DOEL_KOP) + '\n' + tabelRegel(DOEL_KOP.map(function () { return '---'; })) + '\n';
    return doelenZet(t, op, vandaag);
  }
  let eind = k + 2;
  while (eind < regels.length && /^\s*\|/.test(regels[eind])) eind++;
  const rijen = regels.slice(k + 2, eind);
  const naamVan = function (r) { return r.trim().replace(/^\|/, '').split('|')[0].replace(/\*\*/g, '').trim().toLowerCase(); };
  let nieuw;
  if (op.actie === 'weg') {
    const n = cel(op.naam, 60).toLowerCase();
    nieuw = rijen.filter(function (r) { return naamVan(r) !== n; });
    if (nieuw.length === rijen.length) throw new Error('doel niet gevonden');
  } else if (op.actie === 'nieuw') {
    const d = op.doel || {};
    if (!cel(d.naam, 60)) throw new Error('naam ontbreekt');
    if (rijen.some(function (r) { return naamVan(r) === cel(d.naam, 60).toLowerCase(); })) throw new Error('er is al een doel met die naam');
    if (rijen.length >= 40) throw new Error('hooguit 40 doelen');
    nieuw = rijen.concat([tabelRegel([cel(d.naam, 60), nlBedrag(d.bedrag), nlDatum(d.datum), d.soort, cel(d.rekening, 60) || '—', nlBedrag(d.start || 0), nlDatum(d.sinds || vandaag)])]);
  } else throw new Error('onbekende actie');
  const uit = regels.slice(0, k + 2).concat(nieuw, regels.slice(eind)).join('\n');
  return /^---\n[\s\S]*?\nupdated:/.test(uit) ? uit.replace(/(^---\n[\s\S]*?\nupdated:)[^\n]*/, '$1 ' + vandaag) : uit;
}
// lege pagina (sjabloon + kop van de tabel)
function doelenLeeg(datum) { return SJABLOON.replace('{datum}', datum) + tabelRegel(DOEL_KOP) + '\n' + tabelRegel(DOEL_KOP.map(function () { return '---'; })) + '\n'; }
// invoer uit de App op vorm (server.js gebruikt dit vóór het schrijven)
function doelInvoer(d, nu) {
  if (!d || typeof d !== 'object') throw new Error('geen doel');
  const naam = cel(d.naam, 60);
  if (!naam || /[[\]{}<>`]/.test(naam)) throw new Error('naam: 1–60 tekens, zonder haken');
  const bedrag = Number(d.bedrag);
  if (!(bedrag >= 1 && bedrag <= 10000000)) throw new Error('bedrag: € 1 tot € 10 miljoen');
  let datum = String(d.datum || '');
  if (/^\d{4}-\d{2}$/.test(datum)) datum += '-01';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum) || isNaN(Date.parse(datum + 'T12:00:00Z')) || datum < nu || datum > maandPlus(nu.slice(0, 7), 240) + '-28') throw new Error('datum: vanaf vandaag, hooguit 20 jaar vooruit');
  const soort = SOORTEN.indexOf(d.soort) >= 0 ? d.soort : null;
  if (!soort) throw new Error('soort: sparen of uitgave');
  const rekening = d.rekening == null || d.rekening === '' ? null : cel(d.rekening, 60);
  if (rekening && /[[\]{}<>`]/.test(rekening)) throw new Error('rekening: zonder haken');
  const start = d.start == null || d.start === '' ? 0 : Number(d.start);
  if (!(Number.isFinite(start) && Math.abs(start) <= 10000000)) throw new Error('start: een bedrag');
  return { naam: naam, bedrag: r2(bedrag), datum: datum, soort: soort, rekening: soort === 'sparen' ? rekening : null, start: soort === 'sparen' ? r2(start) : 0, sinds: nu };
}

module.exports = { vooruit: vooruit, prognose: prognose, kalender: kalender, uitPlanning: uitPlanning, maandVan: maandVan, basis: basis, reeksenJaar: reeksenJaar,
  doelen: doelen, doelenLees: doelenLees, doelStand: doelStand, doelenZet: doelenZet, doelenLeeg: doelenLeeg, doelInvoer: doelInvoer, P_DOELEN: P_DOELEN, HORIZON: HORIZON, mndNaam: mndNaam, eur: eur };
