// financien-overzicht.js — OVIS Financiën 8+, stap 1 en 2 (wv2596; ontwerp vault "01_Ontwikkeling/OVIS Financiën 8+ (ontwerp 7-11-2026)"
// § 3.1, § 3.2, § 5 en § 8 = verwerkte gpt-5.5-review). David koos 7-11-2026 08:03 versie A (dashboard met tegels en tabbladen).
//
// WAAROM. David 6-11-2026: "OVIS Financiën is nu een 6je qua overzicht. Bedenk hoe we er een 8+ van kunnen maken. Echt financieel
// inzicht, inclusief adviezen." In/uit per maand zei weinig: een aflossing aan de Holding of een creditcardbetaling telde als uitgave,
// en vier getallen die er voor hem toe doen (vermogen, vrij per maand, buffer, spaarquote) stonden nergens.
//
// STAP 1 — STROMEN. Elke privéboeking (zonder POT en externe rekeningen) krijgt bij het lezen één stroom, zonder de verrijking zelf te
// wijzigen (die blijft van bank-archief.js; dit is een leeslaag erbovenop, dus volledig omkeerbaar):
//   leven       wat het gezin uitgeeft (ook belastingen, hypotheekrente, steun en Gambia-hulp die weg is; terugbetalingen tellen negatief)
//   inkomen     wat binnenkomt om van te leven (loon van de Holding, toeslagen, rente, overig); subsoort buiten_zicht = netto van/naar een
//               eigen rekening die niet gekoppeld is (o.a. Cynthia's rekening): zonder die rekeningen is "inkomen" anders te laag
//   verschuiven vermogen dat van plek wisselt (verplicht = het aflossingsdeel van de hypotheektermijn uit Davids hypotheekmodel;
//               vrijwillig = sparen buiten zicht, geld van/naar de eigen BV's: rekening-courant, lening, terugstorting; geoormerkt)
//   intern      tussen twee gekoppelde eigen rekeningen (paar uit de verrijking)
// Een boeking kan in delen vallen (alleen de hypotheektermijn: aflossing + rente); de som van de delen is altijd het bedrag (toets).
// Vlag eenmalig groot: leven, ≥ € 1.000, geen reeks (abonnement_id leeg), geen verzekering/belasting/hypotheek/creditcard.
// Davids eigen keuze per tegenpartij en richting (tabel stroom_regels, CREATE TABLE IF NOT EXISTS = herhaalbare migratie, alleen bij het
// eerste opslaan) wint altijd. Gemengde tegenpartijen (PayPal, Tikkie, bol, Amazon, betaaldiensten) gaan op tegenpartij + omschrijving
// (review ZOU 2), de rest op tegenpartij.
//
// STAP 2 — KERNGETALLEN, elk met peildatum, bron en onderbouwing (regels met een filter waarmee de App de boekingen opvraagt):
//   vrij per maand  = (inkomen − leven − verplichte aflossing) / 12 over de laatste 12 volledige maanden, met en zonder eenmalig groot
//                     (review MOET 3/4; jaarposten tellen via het 12-maandsgemiddelde voor 1/12 per maand mee = de jaarreservering)
//   buffer          = vrij beschikbaar op de rekeningen ÷ leven per maand zonder eenmalig (zonder kinder- en Gambia-rekeningen)
//   spaarquote      = (inkomen − leven) ÷ inkomen, 12 maanden
//   vermogen        = privé en Holding APART, nooit opgeteld (review MOET 2): privé = vrij beschikbaar + woning (laatste taxatie) −
//                     hypotheek (bankstand) − woninglening Holding − rekening-courant met de Holding/Tolgaarde; Holding = eigen vermogen
//                     laatste jaarrekening (boekwaarde) met indicatief "na box 2 bij uitkeren" (tarieven TARIEVEN hieronder, met bron).
// Alles heet "zichtbare rekeningen" (review MOET 1): Cynthia's eigen rekeningen zijn niet gekoppeld.
//
// wv2696 (David 7-11-2026: "Dit kan nooit kloppen, € 91.000 naar Benthe"): (1) de sleutel van een persoon houdt de eerste voorletter
// ("D. Schaap" en "B. Schaap" vielen samen op "schaap"); (2) een overboeking naar of van een eigen zichtbare rekening (tegen-IBAN in
// rekeningen, of een intern paar) is altijd intern, ook bij een keuze van David, behalve de boeking op Davids kant naar of van een
// kinderrekening (eigenaar kind): die volgt zijn keuze (de boeking op de kinderrekening zelf blijft intern); (3) bestaande keuzes met de oude sleutel worden één keer omgezet (regelsHerleiden): één partij = de nieuwe
// sleutel, een samengevoegde sleutel = alleen de partij met de meeste boekingen in die richting (wat David zag), met een notitie in de regel.
// Schrijft niets behalve stroomZet (alleen via bank-lezer.js app-stroom, POST /app/financien/stroom) en die eenmalige omzetting. Geen netwerk, geen taalmodel.
// Het antwoord gaat alleen naar Davids eigen App (GET /app/financien); namen van tegenpartijen wel (wv1957), IBAN's niet.
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path');

const STROMEN = ['leven', 'inkomen', 'verschuiven', 'intern'];
const SUBSOORT = { leven: [], inkomen: ['buiten_zicht'], verschuiven: ['verplicht', 'vrijwillig', 'geoormerkt'], intern: [] };
const EENMALIG_GRENS = 1000;
const GEEN_EENMALIG = ['verzekeringen', 'belastingen', 'creditcard (niet uitgesplitst)'];
// Davids eigen entiteiten (bedrijfsnamen, geen personen): geld van/naar hier is geen leven of inkomen tenzij de categorie dat zegt
const ENTITEIT = /primum non nocere|tolgaarde|groenhouten|praktijkhouders|kostenmaatschap/i;
// gemengde tegenpartijen: één naam, heel verschillende posten (review ZOU 2)
const GEMENGD = /paypal|tikkie|bol\.?com|amazon|amzn|mollie|stripe|klarna|riverty|billink|alipay|buckaroo|adyen|pay\.nl|\bccv\b|sumup|online payment/i;
const CREDITCARD = /\bcreditcard\b|zie rekeningoverzicht/i, CONTANT = /\bcash\b|\bcontant\b/i;
// Box 2 (aanmerkelijk belang) per jaar: schijfgrens per persoon, laag en hoog tarief. Bron: rendement.nl en holdwise.nl, gelezen 7-11-2026
// (de pagina van de Belastingdienst zelf niet); ontbreekt het jaar, dan geen indicatie (ontwerp § 3.5).
const TARIEVEN = { box2: { 2025: { grens: 67804, laag: 0.245, hoog: 0.31 }, 2026: { grens: 68843, laag: 0.245, hoog: 0.31 } },
  box2_bron: 'rendement.nl / holdwise.nl, gelezen 7-11-2026' };
// de woningpagina: de eerste "Woning *.md" in 20_Prive/Huis met een taxatietabel (geen adres in de code: deze repo is openbaar)
const D_WONING = path.join('20_Prive', 'Huis');
const P_HOLD = path.join('10_Zakelijk', 'Holding', 'Financieel', 'Kerncijfers - HOLD.md');

function r2(n) { return Math.round(n * 100) / 100; }
function veilig(s, n) { return String(s == null ? '' : s).normalize('NFC').replace(/[^\p{L}\p{N} .,&'()\-/+*—]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 40).trim(); }
// IBAN in een vrije tekst → "IBAN …1234" (review wv2596 MOET 2; zoals elders in de App alleen de laatste vier cijfers)
function zonderIban(s) { return String(s == null ? '' : s).replace(/\b[A-Z]{2}\d{2}\s?(?:[A-Z0-9]{4}\s?){2,7}[A-Z0-9]{1,4}\b/g, function (m) { const k = m.replace(/\s+/g, ''); return 'IBAN …' + k.slice(-4); }); }
function woorden(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ')
    .filter(function (w) { return w.length >= 2; }).slice(0, 4).join(' ');
}
// wv2696: een tegenpartij-naam als woorden, met de eerste voorletter erbij ("D. Schaap" → "d schaap", "D.J. Schaap" → "d schaap");
// verdere losse letters vallen weg zoals vroeger ("Tibber Netherlands B.V." → "tibber netherlands")
function tpWoorden(s) {
  const w = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
  let i = 0; while (i < w.length && w[i].length === 1) i++;
  const rest = w.slice(i).filter(function (x) { return x.length >= 2; });
  return (i > 0 && rest.length ? [w[0]] : []).concat(rest).slice(0, 4).join(' ');
}
function omsKern(oms) { const m = /Omschrijving:\s*([\s\S]*?)(?=\s+(?:Kenmerk|IBAN|BIC|Naam|Machtiging|Incassant)\s*:|$)/i.exec(String(oms || '')); return m ? m[1] : String(oms || ''); }
function maandPlus(m, n) { const j = Number(m.slice(0, 4)), x = Number(m.slice(5, 7)) - 1 + n; return (j + Math.floor(x / 12)) + '-' + String(((x % 12) + 12) % 12 + 1).padStart(2, '0'); }
// sleutel van een tegenpartij (zonder richting) en de id die de App terugstuurt (geen naam of IBAN in de id)
// Gemengd (betaaldienst) en eigen BV: tegenpartij + de categorie van de verrijking (die komt uit de omschrijving: AI-groep per
// tegenpartij + omschrijving), zodat loon en een privéopname van de Holding, of twee soorten PayPal-posten, los te kiezen zijn.
function sleutelVan(t) {
  const tp = tpWoorden(t.tegenpartij);
  if (!tp) return 'o:' + woorden(omsKern(t.omschrijving));
  return GEMENGD.test(String(t.tegenpartij || '')) || ENTITEIT.test(String(t.tegenpartij || '')) ? 'g:' + tp + '|' + (t.categorie || '-') : 't:' + tp;
}
// de sleutel van vóór wv2696 (zonder voorletter): alleen om oude keuzes om te zetten (regelsHerleiden)
function sleutelOud(t) {
  const tp = woorden(t.tegenpartij);
  if (!tp) return 'o:' + woorden(omsKern(t.omschrijving));
  return GEMENGD.test(String(t.tegenpartij || '')) || ENTITEIT.test(String(t.tegenpartij || '')) ? 'g:' + tp + '|' + (t.categorie || '-') : 't:' + tp;
}
function richting(b) { return b < 0 ? 'af' : 'bij'; }
// eigenaar van een boeking (verrijking) in de vier groepen van het ontwerp § 3.3; de rest 'anders'
const EIGENAREN = ['David', 'samen', 'kinderen', 'Gambia', 'anders'];
function eigenaarVan(e) { const x = String(e || '').trim().toLowerCase(); return x === 'david' ? 'David' : x === 'samen' ? 'samen' : x === 'kind' || x === 'kinderen' ? 'kinderen' : /gambia/.test(x) ? 'Gambia' : 'anders'; }
function idVan(sleutel, r) { return crypto.createHash('sha256').update('stroom:' + sleutel + '|' + r).digest('hex').slice(0, 16); }

function regelsLees(a) {
  const m = new Map();
  if (!a.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stroom_regels'").get()) return m;
  // wv2696: een keuze met de oude sleutel (sleutel_v leeg) telt pas na de omzetting; lukt die niet, dan telt hij niet (nooit stil op
  // alle partijen met die achternaam)
  try { regelsHerleiden(a); } catch (e) { /* alleen-lezen of fout: oude keuzes tellen niet */ }
  const v2 = a.db.prepare("SELECT 1 FROM pragma_table_info('stroom_regels') WHERE name = 'sleutel_v'").get();
  if (!v2) return m;
  a.db.prepare('SELECT sleutel, richting, stroom, subsoort, aangemaakt FROM stroom_regels WHERE actief = 1 AND sleutel_v = 2').all().forEach(function (r) {
    if (STROMEN.indexOf(r.stroom) >= 0) m.set(r.sleutel + '|' + r.richting, r);
  });
  return m;
}

// ── stap 1: de indeling van één boeking ──
// geeft { stroom, sub, zeker, waarom, cat } — cat is de categorie in het overzicht (de verrijking, met twee vaste aanvullingen)
function indelen(t, c) {
  const cat0 = t.categorie || null, sub = String(t.subcategorie || '').toLowerCase(), tp = String(t.tegenpartij || '');
  let r = c.regels.get(t._sleutel + '|' + richting(t.bedrag));
  const isBel = /belastingdienst/i.test(tp) && cat0 === 'teruggave en terugbetaling';
  const cat = isBel ? 'belastingen' : CREDITCARD.test(String(t.omschrijving || '')) && t.bedrag < 0 && (!cat0 || cat0 === 'overig') ? 'creditcard (niet uitgesplitst)' : cat0;
  const u = function (stroom, s, zeker, waarom) { return { stroom: stroom, sub: s || null, zeker: zeker, waarom: waarom, cat: cat }; };
  // wv2696: naar of van een eigen zichtbare rekening is nooit uitgegeven of inkomen, ook niet via een keuze; behalve met een kinderrekening
  const eigen = eigenTegen(t, c);
  if (eigen) {
    // alleen de boeking op Davids kant (de andere kant is de kinderrekening): de boeking op de kinderrekening zelf blijft intern, anders telt
    // hetzelfde kleedgeld twee keer (uit bij David, in bij het kind)
    const kind = eigen === 'kind' && String(t.r_eigenaar || '').toLowerCase() !== 'kind';
    if (!(kind && r)) return u('intern', null, true, r ? 'tussen twee eigen rekeningen (je keuze bij deze naam geldt hier niet)' : 'tussen twee eigen rekeningen');
  }
  if (r) return u(r.stroom, r.subsoort, true, 'jouw keuze');
  if (t.type === 'intern') {
    if (t.paar_rek && c.zichtbaar.has(t.paar_rek)) return u('intern', null, true, 'tussen twee eigen rekeningen');
    if (cat === 'sparen en beleggen') return u('verschuiven', 'vrijwillig', false, 'sparen op een eigen rekening die niet gekoppeld is');
    return u('inkomen', 'buiten_zicht', false, 'van of naar een eigen rekening die niet gekoppeld is (bijvoorbeeld van Cynthia)');
  }
  if (/hypotheek/.test(sub) && t.bedrag < 0 && !ENTITEIT.test(tp)) return u('leven', null, true, 'hypotheektermijn (rente; het aflossingsdeel gaat apart)');
  if (ENTITEIT.test(tp)) {
    if (t.bedrag > 0 && cat === 'inkomen') return u('inkomen', null, true, 'loon of vergoeding van je eigen BV');
    if (cat === 'teruggave en terugbetaling') return u('leven', null, true, 'terugbetaling van een uitgave');
    if (t.bedrag < 0 && cat && cat !== 'overig' && c.catUit.has(cat)) return u('leven', null, false, 'betaling aan je eigen BV voor ' + cat);
    return u('verschuiven', 'vrijwillig', false, 'geld van of naar je eigen BV (rekening-courant, lening of terugstorting): geen inkomen of uitgave');
  }
  if (cat === 'sparen en beleggen') return u('verschuiven', 'vrijwillig', true, 'sparen of beleggen');
  if (t.type === 'terugboeking') return u('leven', null, true, 'terugboeking');
  if (t.bedrag > 0) {
    if (cat === 'teruggave en terugbetaling' || cat === 'belastingen') return u('leven', null, true, 'terugbetaling: telt als minder uitgegeven');
    if (!cat) return u('inkomen', null, false, 'binnengekomen, nog niet ingedeeld');
    return u('inkomen', null, true, cat);
  }
  if (cat === 'creditcard (niet uitgesplitst)') return u('leven', null, true, 'afrekening van een creditcard (de posten zelf zijn niet gekoppeld)');
  if (!cat || cat === 'overig') {
    if (CONTANT.test(String(t.omschrijving || ''))) { const x = u('leven', null, true, 'contant geld (omschrijving)'); x.cat = 'contant geld'; return x; }
    // dezelfde tegenpartij heeft andere posten wél in één categorie (niet bij een betaaldienst of eigen BV)
    const k = tpWoorden(tp), cc = !GEMENGD.test(tp) && !ENTITEIT.test(tp) && k ? c.tpCat.get(k) : null;
    if (cc) { const x = u('leven', null, true, 'zoals de andere posten bij deze tegenpartij'); x.cat = cc; return x; }
    return u('leven', null, false, 'uitgegeven, nog niet ingedeeld');
  }
  return u('leven', null, true, cat);
}

// de eigenaar (kleine letters) van de eigen zichtbare rekening aan de andere kant, of null: eerst het intern paar, dan het tegen-IBAN
function eigenTegen(t, c) {
  if (t.paar_rek && c.zichtbaar.has(t.paar_rek)) return c.rekEig.get(t.paar_rek) || 'eigen';
  const ib = String(t.tegen_iban || '').replace(/\s+/g, '').toUpperCase();
  return ib && c.eigenIban.has(ib) ? c.eigenIban.get(ib) || 'eigen' : null;   // review wv2696 MOET 1: eigenaar leeg is ook eigen
}
// Alle privéboekingen van de maanden [van, tot] (JJJJ-MM), elk in delen. aflossing = verplichte aflossing per maand (hypotheekmodel) of null.
function boekingen(a, van, tot, aflossing) {
  const rijen = a.db.prepare("SELECT t.nr, t.rek, t.datum, t.bedrag, t.valuta, t.tegenpartij, t.omschrijving, v.type, v.categorie, v.subcategorie, v.abonnement_id, v.eigenaar AS v_eigenaar, r.eigenaar AS r_eigenaar," +
    // wv2696: bij een deel van de ABN-boekingen is tegen_iban leeg en staat het IBAN alleen in de ruwe bankregel (creditor/debtor_account)
    " coalesce(nullif(trim(t.tegen_iban), ''), CASE WHEN json_valid(t.ruwe_json) THEN json_extract(t.ruwe_json, CASE WHEN t.bedrag < 0 THEN '$.creditor_account.iban' ELSE '$.debtor_account.iban' END) END) AS tegen_iban," +
    ' (SELECT p.rek FROM transacties p WHERE p.nr = v.intern_paar) AS paar_rek, r.label, r.naam, r.weergavenaam FROM transacties t JOIN verrijking v ON v.nr = t.nr JOIN rekeningen r ON r.rek = t.rek' +
    " WHERE t.status IN ('booked', 'pending') AND lower(coalesce(r.eigenaar, '')) NOT IN ('extern', 'pot') AND t.datum >= ? AND t.datum <= ? ORDER BY t.datum, t.nr").all(van + '-01', tot + '-31');
  const zr = a.db.prepare("SELECT rek, iban, lower(coalesce(eigenaar, '')) AS eig FROM rekeningen WHERE lower(coalesce(eigenaar, '')) NOT IN ('extern', 'pot')").all();
  const zichtbaar = new Set(zr.map(function (r) { return r.rek; })), rekEig = new Map(zr.map(function (r) { return [r.rek, r.eig]; }));
  const eigenIban = new Map(zr.filter(function (r) { return r.iban; }).map(function (r) { return [String(r.iban).replace(/\s+/g, '').toUpperCase(), r.eig]; }));
  const catUit = new Set(['wonen', 'verzekeringen', 'boodschappen', 'huishouden', 'vervoer', 'abonnementen en communicatie', 'kinderen', 'gezondheid', 'vrije tijd en sport',
    'horeca en uit eten', 'vakantie en reizen', 'kleding en persoonlijk', 'cadeaus en goede doelen', 'belastingen', 'bankkosten', 'contant geld', 'Gambia-hulp']);
  // per tegenpartij de categorie als al zijn ingedeelde uitgaven (minstens 2) in één categorie staan
  const tel = new Map();
  rijen.forEach(function (t) {
    if (!(t.bedrag < 0) || !t.categorie || t.categorie === 'overig' || t.type === 'intern') return;
    const k = tpWoorden(t.tegenpartij);
    if (!k) return;
    if (!tel.has(k)) tel.set(k, new Map());
    tel.get(k).set(t.categorie, (tel.get(k).get(t.categorie) || 0) + 1);
  });
  const tpCat = new Map();
  tel.forEach(function (m, k) { if (m.size === 1) { const e = Array.from(m.entries())[0]; if (e[1] >= 2) tpCat.set(k, e[0]); } });
  const c = { regels: regelsLees(a), zichtbaar: zichtbaar, rekEig: rekEig, eigenIban: eigenIban, catUit: catUit, tpCat: tpCat };
  const uit = [];
  let anderValuta = 0;
  rijen.forEach(function (t) {
    if (t.valuta && t.valuta !== 'EUR') { anderValuta++; return; }
    t._sleutel = sleutelVan(t);
    const d = indelen(t, c), m = t.datum.slice(0, 7);
    const basis = { nr: t.nr, datum: t.datum, maand: m, rekening: veilig(t.weergavenaam || t.label || t.naam, 30) || 'eigen rekening', tegenpartij: veilig(zonderIban(t.tegenpartij), 40) || null,
      omschrijving: veilig(zonderIban(omsKern(t.omschrijving)), 80) || null, bedrag: t.bedrag, sleutel: t._sleutel, id: idVan(t._sleutel, richting(t.bedrag)), zeker: d.zeker, waarom: d.waarom, cat: d.cat || null, eig: eigenaarVan(t.v_eigenaar), abo: t.abonnement_id || null };
    // hypotheektermijn: het aflossingsdeel (hooguit de verplichte aflossing per maand) is verschuiven/verplicht, de rest leven (rente)
    if (d.waarom.indexOf('hypotheektermijn') === 0 && aflossing > 0) {
      const deel = r2(Math.min(-t.bedrag, aflossing));   // per termijn één maand aflossing (31-12 en 1-12 zijn twee termijnen)
      if (deel > 0) uit.push(Object.assign({}, basis, { stroom: 'verschuiven', sub: 'verplicht', deel: -deel, eenmalig: false, waarom: 'aflossingsdeel van de hypotheektermijn (je hypotheekmodel)' }));
      if (r2(t.bedrag + deel) !== 0) uit.push(Object.assign({}, basis, { stroom: 'leven', sub: null, deel: r2(t.bedrag + deel), eenmalig: false, cat: 'wonen', waarom: 'rentedeel van de hypotheektermijn' }));
      return;
    }
    const eenmalig = d.stroom === 'leven' && t.bedrag <= -EENMALIG_GRENS && !t.abonnement_id && GEEN_EENMALIG.indexOf(d.cat) < 0 && !/hypotheek/i.test(String(t.subcategorie || ''));
    uit.push(Object.assign(basis, { stroom: d.stroom, sub: d.sub, deel: t.bedrag, eenmalig: eenmalig }));
  });
  return { delen: uit, posten: rijen.length - anderValuta, ander_valuta: anderValuta };
}

// som per maand per stroom (en de onderdelen die de kerngetallen nodig hebben)
function perMaand(delen) {
  const m = new Map();
  delen.forEach(function (x) {
    if (!m.has(x.maand)) m.set(x.maand, { maand: x.maand, boekingen: 0, leven: 0, leven_eenmalig: 0, belasting: 0, inkomen: 0, inkomen_buiten_zicht: 0,
      verschuiven: 0, verplicht: 0, vrijwillig: 0, geoormerkt: 0, intern: 0, overig: 0, uitgaven: 0 });
    const s = m.get(x.maand);
    s[x.stroom] += x.deel;
    if (x.stroom === 'leven') {
      if (x.eenmalig) s.leven_eenmalig += x.deel;
      if (x.cat === 'belastingen') s.belasting += x.deel;
      if (x.deel < 0) { s.uitgaven += x.deel; if (!x.zeker && (!x.cat || x.cat === 'overig')) s.overig += x.deel; }
    }
    if (x.stroom === 'inkomen' && x.sub === 'buiten_zicht') s.inkomen_buiten_zicht += x.deel;
    if (x.stroom === 'verschuiven' && x.sub) s[x.sub] += x.deel;
  });
  return m;
}
// ── stap 3: uitgaven die je begrijpt (ontwerp § 3.3) ──
// Alleen de stroom leven, netto (een terugbetaling telt negatief), als positief bedrag = uitgegeven. Per categorie: de laatste volle maand,
// de lopende maand tot nu, het gemiddelde van de 12 volledige maanden en dezelfde maand een jaar eerder (alleen als die in het archief
// staat). Kleur (afwijking) alleen bij > 25 % én > € 100 tegen het gemiddelde. Zonder categorie = sleutel '-' (filter cat '-').
// Uitschieters: een uitgave in de laatste drie maanden boven 3× de gebruikelijke post (mediaan van de andere posten) bij die tegenpartij
// (≥ 3 andere posten) of anders bij die categorie (≥ 10 andere posten), en minstens € 100 erboven. Nieuw terugkerend: een reeks van de
// verrijking (abonnement_id) met ≥ 2 posten waarvan de eerste in de laatste vier maanden valt (alleen als het archief ≥ 6 maanden ouder is).
const AFWIJK_PCT = 0.25, AFWIJK_EUR = 100, UIT_FACTOR = 3, UIT_MIN = 100;
function mediaan(l) { const x = l.slice().sort(function (p, q) { return p - q; }), n = x.length; return n ? (n % 2 ? x[(n - 1) / 2] : (x[n / 2 - 1] + x[n / 2]) / 2) : null; }
function afwijking(nu, gem) { if (nu == null || gem == null) return null; const d = nu - gem; return Math.abs(d) > AFWIJK_EUR && Math.abs(d) > AFWIJK_PCT * Math.abs(gem) ? (d > 0 ? 'hoger' : 'lager') : null; }
function zonderSleutel(g) { const x = Object.assign({}, g); delete x.sleutel; return x; }
function uitgaven(delen, o) {
  const mNu = o.mNu, twaalf = o.twaalf, n12 = twaalf.length, mVol = twaalf[n12 - 1] || null, mVj = mVol ? maandPlus(mVol, -12) : null;
  const vjOk = !!(mVj && (!o.vanaf || mVj >= o.vanaf)), in12 = new Set(twaalf);
  const leven = delen.filter(function (x) { return x.stroom === 'leven'; });
  const groep = function (sleutel) {
    const m = new Map();
    leven.forEach(function (x) {
      const k = sleutel(x);
      if (!m.has(k)) m.set(k, { nu: 0, lopend: 0, twaalf: 0, vj: 0 });
      const g = m.get(k);
      if (x.maand === mVol) g.nu -= x.deel;
      if (x.maand === mNu) g.lopend -= x.deel;
      if (in12.has(x.maand)) g.twaalf -= x.deel;
      if (vjOk && x.maand === mVj) g.vj -= x.deel;
    });
    return Array.from(m.entries()).map(function (e) {
      const g = e[1], gem = n12 ? g.twaalf / n12 : null;
      return { sleutel: e[0], nu: r2(g.nu), lopend: r2(g.lopend), gem12: gem == null ? null : r2(gem), vorig_jaar: vjOk ? r2(g.vj) : null, afwijking: afwijking(g.nu, gem) };
    }).filter(function (g) { return g.nu || g.lopend || g.gem12 || g.vorig_jaar; }).sort(function (p, q) { return (q.gem12 || 0) - (p.gem12 || 0) || q.nu - p.nu; });
  };
  const fl = function (m, extra) { return m ? Object.assign({ van: m, tot: m, stroom: 'leven' }, extra) : null; };
  const f12 = function (extra) { return n12 ? Object.assign({ van: twaalf[0], tot: mVol, stroom: 'leven' }, extra) : null; };
  const cats = groep(function (x) { return x.cat || '-'; }).map(function (g) {
    const e = { cat: g.sleutel }, naam = g.sleutel === '-' ? 'nog niet ingedeeld' : g.sleutel;
    return Object.assign({ categorie: naam, zonder: g.sleutel === '-' || undefined }, zonderSleutel(g), { filter: { nu: fl(mVol, e), lopend: fl(mNu, e), twaalf: f12(e), vorig_jaar: vjOk ? fl(mVj, e) : null } });
  });
  const eig = groep(function (x) { return x.eig || 'anders'; }).map(function (g) {
    const e = { eig: g.sleutel };
    return Object.assign({ eigenaar: g.sleutel }, zonderSleutel(g), { filter: { nu: fl(mVol, e), lopend: fl(mNu, e), twaalf: f12(e), vorig_jaar: vjOk ? fl(mVj, e) : null } });
  }).sort(function (p, q) { return EIGENAREN.indexOf(p.eigenaar) - EIGENAREN.indexOf(q.eigenaar); });
  const som = function (k) { return r2(cats.reduce(function (s, c) { return s + (c[k] || 0); }, 0)); };
  // uitschieters
  const uitg = leven.filter(function (x) { return x.deel < 0 && x.deel === x.bedrag; });   // geen deel van een gesplitste hypotheektermijn
  const perTp = new Map(), perCat = new Map();
  uitg.forEach(function (x) {
    if (!perTp.has(x.sleutel)) perTp.set(x.sleutel, []);
    perTp.get(x.sleutel).push(x);
    if (x.cat) { if (!perCat.has(x.cat)) perCat.set(x.cat, []); perCat.get(x.cat).push(x); }
  });
  const sinds3 = maandPlus(mNu, -2), uitschieters = [];
  uitg.forEach(function (x) {
    if (x.maand < sinds3) return;
    const ander = function (l) { return (l || []).filter(function (y) { return y.nr !== x.nr; }).map(function (y) { return -y.deel; }); };
    let basis = 'tegenpartij', l = ander(perTp.get(x.sleutel));
    if (l.length < 3) { basis = 'categorie'; l = x.cat ? ander(perCat.get(x.cat)) : []; if (l.length < 10) return; }
    const med = mediaan(l);
    if (!(med > 0) || -x.deel <= UIT_FACTOR * med || -x.deel - med < UIT_MIN) return;
    uitschieters.push({ datum: x.datum, naam: x.tegenpartij || x.omschrijving || 'zonder naam', categorie: x.cat, rekening: x.rekening, bedrag: r2(-x.deel), gebruikelijk: r2(med), basis: basis,
      keer: Math.round(-x.deel / med * 10) / 10, filter: { van: x.maand, tot: x.maand, id: x.id } });
  });
  uitschieters.sort(function (p, q) { return q.bedrag - p.bedrag; });
  // nieuwe terugkerende posten
  const nieuw = [], grens = maandPlus(mNu, -3) + '-01';
  if (!o.vanaf || o.vanaf <= maandPlus(mNu, -6)) {
    const abo = new Map();
    uitg.forEach(function (x) { if (!x.abo) return; if (!abo.has(x.abo)) abo.set(x.abo, []); abo.get(x.abo).push(x); });
    abo.forEach(function (l) {
      l.sort(function (p, q) { return p.datum < q.datum ? -1 : 1; });
      if (l.length < 2 || l[0].datum < grens) return;
      const laatst = l[l.length - 1];
      nieuw.push({ naam: laatst.tegenpartij || laatst.omschrijving || 'zonder naam', categorie: laatst.cat, sinds: l[0].datum, aantal: l.length, laatste: r2(-laatst.deel),
        som: r2(-l.reduce(function (s, y) { return s + y.deel; }, 0)), filter: { van: l[0].maand, tot: laatst.maand, id: laatst.id } });
    });
    nieuw.sort(function (p, q) { return q.laatste - p.laatste; });
  }
  return { maand: mVol, lopend: mNu, vorig_jaar: vjOk ? mVj : null, maanden: n12, categorieen: cats, eigenaren: eig,
    totaal: { nu: som('nu'), lopend: som('lopend'), gem12: n12 ? som('gem12') : null, vorig_jaar: vjOk ? som('vorig_jaar') : null },
    uitschieters: uitschieters.slice(0, 10), nieuw: nieuw.slice(0, 10),
    regels: { afwijking: '> ' + Math.round(AFWIJK_PCT * 100) + ' % én > € ' + AFWIJK_EUR + ' tegen het gemiddelde', uitschieter: 'boven ' + UIT_FACTOR + '× de gebruikelijke post en ≥ € ' + UIT_MIN + ' erboven' },
    uitleg: 'Alleen wat het gezin echt uitgaf (stroom leven), terugbetalingen eraf. Sparen, aflossen, geld naar de Holding en tussen eigen rekeningen staan hier niet in.' };
}
// boekingen per maand (zonder delen) voor de somtoets
function somBoekingen(delen) {
  const m = new Map(), gezien = new Set();
  delen.forEach(function (x) { if (gezien.has(x.nr)) return; gezien.add(x.nr); m.set(x.maand, (m.get(x.maand) || 0) + x.bedrag); });
  return m;
}
function aflossingVan(hyp) {
  return hyp && hyp.controle && hyp.controle.aflossing > 0 ? hyp.controle.aflossing : hyp && hyp.excel && hyp.excel.aflossing_som_delen > 0 ? hyp.excel.aflossing_som_delen : null;
}

// ── vault: woning, Holding-eigen vermogen ──
function leesWoning(vault, FV) {
  const namen = fs.readdirSync(path.join(vault, D_WONING)).filter(function (n) { return /^Woning .+\.md$/.test(n); }).sort();
  for (let i = 0; i < namen.length; i++) {
    const rel = path.join(D_WONING, namen[i]), st = fs.statSync(path.join(vault, rel));
    if (!st.isFile() || st.size > 400000) continue;
    const w = woningUit(fs.readFileSync(path.join(vault, rel), 'utf8'), FV);
    if (w) return Object.assign(w, { bron: rel });
  }
  return null;
}
function woningUit(t, FV) {
  const rij = (FV.tabel(FV.tabellen(t), ['peildatum', 'marktwaarde', 'na verbouwing']) || []).map(function (r) {
    const d = FV.datumIso((/(\d{1,2}-\d{1,2}-\d{4})/.exec(r.peildatum) || [])[1]), nv = FV.nlGetal(r['na verbouwing']), mw = FV.nlGetal(r.marktwaarde);
    return { datum: d, waarde: nv != null && nv > 10000 ? nv : mw };
  }).filter(function (r) { return r.datum && r.waarde > 10000; }).sort(function (x, y) { return x.datum < y.datum ? -1 : 1; }).pop();
  return rij ? { waarde: rij.waarde, peildatum: rij.datum } : null;
}
function leesHolding(vault, FV) {
  const t = fs.readFileSync(path.join(vault, P_HOLD), 'utf8');
  const tab = FV.tabellen(t).find(function (x) { return x.rijen.some(function (r) { return /^eigen vermogen$/i.test(FV.schoon(r[0])); }); });
  if (!tab) return null;
  const jaren = tab.kop.map(function (k) { return /^\d{4}$/.test(k) ? Number(k) : null; });
  const ev = tab.rijen.find(function (r) { return /^eigen vermogen$/i.test(FV.schoon(r[0])); }), lm = tab.rijen.find(function (r) { return /^liquide middelen$/i.test(FV.schoon(r[0])); });
  for (let i = jaren.length - 1; i >= 0; i--) {
    if (jaren[i] && FV.nlGetal(ev[i]) != null) return { jaar: jaren[i], eigen_vermogen: FV.nlGetal(ev[i]), liquide: lm ? FV.nlGetal(lm[i]) : null, bron: P_HOLD };
  }
  return null;
}
function box2(bedrag, jaar) {
  const t = TARIEVEN.box2[jaar];
  if (!t || !(bedrag > 0)) return null;
  const bel = Math.min(bedrag, t.grens) * t.laag + Math.max(0, bedrag - t.grens) * t.hoog;
  return { jaar: jaar, belasting: Math.round(bel), netto: Math.round(bedrag - bel), grens: t.grens, laag: t.laag, hoog: t.hoog, bron: TARIEVEN.box2_bron };
}

// ── stap 2: het overzicht ──
// o: { nu (JJJJ-MM-DD), vanaf (eerste volledige maand of null), saldi (blok saldi van financien-app.js), vault (map), fv (financien-vault.js) }
function overzicht(A, a, o) {
  const nu = o.nu, mNu = nu.slice(0, 7), fouten = [];
  const blok = function (n, f) { try { return f(); } catch (e) { fouten.push(n); return null; } };
  const FV = o.fv || require('./financien-vault.js');
  const v = blok('vault', function () { return FV.lees(o.vault); }) || {};
  const hyp = v.hypotheek || null, dga = v.dga || null;
  const aflossing = aflossingVan(hyp);
  const van24 = maandPlus(mNu, -24), tot = mNu;
  const b = boekingen(a, van24, tot, aflossing);
  const pm = perMaand(b.delen), som = somBoekingen(b.delen);
  // de laatste 12 volledige maanden (vóór de lopende, niet vóór de koppeling)
  const vol = [];
  for (let i = 1; i <= 24; i++) { const m = maandPlus(mNu, -i); if (!o.vanaf || m >= o.vanaf) vol.push(m); }
  const twaalf = vol.slice(0, 12).reverse();
  const t12 = function (k) { return twaalf.reduce(function (s, m) { return s + ((pm.get(m) || {})[k] || 0); }, 0); };
  const n12 = twaalf.length;
  const van12 = twaalf[0] || null, tot12 = twaalf[n12 - 1] || null;
  const f = function (x) { return Object.assign({ van: van12, tot: tot12 }, x); };   // filter voor de boekingenlijst
  const per = function (x) { return n12 ? r2(x / n12) : null; };
  const inkomen = t12('inkomen'), leven = -t12('leven'), eenmalig = -t12('leven_eenmalig'), verplicht = -t12('verplicht'), belasting = -t12('belasting');
  const buitenZicht = t12('inkomen_buiten_zicht');
  const uit = { venster: { van: van12, tot: tot12, maanden: n12 }, label: 'zichtbare rekeningen', fouten: fouten };
  uit.vrij = n12 ? {
    per_maand: per(inkomen - leven - verplicht), zonder_eenmalig: per(inkomen - (leven - eenmalig) - verplicht),
    regels: [
      { tekst: 'Inkomen', bedrag: per(inkomen), filter: f({ stroom: 'inkomen' }) },
      buitenZicht ? { tekst: 'waarvan netto van of naar niet-gekoppelde eigen rekeningen (o.a. Cynthia)', bedrag: per(buitenZicht), filter: f({ stroom: 'inkomen', sub: 'buiten_zicht' }), sub: true } : null,
      { tekst: 'Leven (alles wat het gezin uitgaf, terugbetalingen eraf)', bedrag: per(-leven), filter: f({ stroom: 'leven' }) },
      belasting ? { tekst: 'waarvan belastingen', bedrag: per(-belasting), filter: f({ stroom: 'leven', cat: 'belastingen' }), sub: true } : null,
      eenmalig ? { tekst: 'waarvan eenmalig groot (≥ € 1.000, geen vaste post)', bedrag: per(-eenmalig), filter: f({ stroom: 'leven', eenmalig: true }), sub: true } : null,
      aflossing ? { tekst: 'Verplichte aflossing hypotheek', bedrag: per(-verplicht), filter: f({ stroom: 'verschuiven', sub: 'verplicht' }) } : null,
    ].filter(Boolean),
    uitleg: 'Gemiddeld per maand over ' + n12 + ' volledige maanden. Jaarposten (verzekering per jaar) tellen zo voor 1/12 per maand mee. Vrijwillig sparen, extra aflossen en geld naar of van de Holding zijn wat je mét het vrije geld doet; die tellen hier niet.' +
      (aflossing ? '' : ' Het aflossingsdeel van de hypotheek is niet te lezen: de hele termijn telt nu als leven.'),
  } : null;
  uit.spaarquote = n12 && inkomen > 0 ? { pct: Math.round((inkomen - leven) / inkomen * 1000) / 10, zonder_eenmalig: Math.round((inkomen - leven + eenmalig) / inkomen * 1000) / 10,
    regels: [{ tekst: 'Inkomen, ' + n12 + ' maanden', bedrag: r2(inkomen), filter: f({ stroom: 'inkomen' }) }, { tekst: 'Leven, ' + n12 + ' maanden', bedrag: r2(-leven), filter: f({ stroom: 'leven' }) }],
    uitleg: '(inkomen − leven) ÷ inkomen. Aflossen telt hier als sparen: het blijft van jullie.' } : null;
  // liquide uit het blok saldi (financien-app.js blokSaldi): vrij = David + gedeeld; kinderen en Gambia apart, niet in de buffer of het vermogen
  const sal = o.saldi && Array.isArray(o.saldi.rekeningen) ? o.saldi.rekeningen.filter(function (r) { return r.valuta === 'EUR' && typeof r.saldo === 'number'; }) : null;
  const groepVan = function (g) { return g === 'eigen' || g === 'samen' ? 'vrij' : g === 'gambia' ? 'geoormerkt' : g === 'kind' || /^persoon:/.test(g) ? 'kinderen' : 'anders'; };
  const liq = { vrij: 0, geoormerkt: 0, kinderen: 0, anders: 0, rekeningen: { vrij: [], geoormerkt: [], kinderen: [], anders: [] }, stand_van: null };
  (sal || []).forEach(function (r) {
    const g = groepVan(r.groep);
    liq[g] += r.saldo; liq.rekeningen[g].push({ naam: r.naam, saldo: r.saldo, stand_van: r.stand_van || null });
    if (r.stand_van && (!liq.stand_van || r.stand_van < liq.stand_van)) liq.stand_van = r.stand_van;   // de oudste stand telt
  });
  const levenZonder = n12 ? (leven - eenmalig) / n12 : null;
  uit.buffer = sal && levenZonder > 0 ? { maanden: Math.round(liq.vrij / levenZonder * 10) / 10, liquide: r2(liq.vrij), leven_per_maand: r2(levenZonder), stand_van: liq.stand_van,
    rekeningen: liq.rekeningen.vrij.sort(function (x, y) { return y.saldo - x.saldo; }),
    regels: [{ tekst: 'Vrij beschikbaar op ' + liq.rekeningen.vrij.length + ' rekeningen (David en gedeeld)', bedrag: r2(liq.vrij) },
      { tekst: 'Leven per maand zonder eenmalig groot', bedrag: r2(-levenZonder), filter: f({ stroom: 'leven', eenmalig: false }) }],
    niet_meegeteld: [{ tekst: 'Kinderrekeningen', bedrag: r2(liq.kinderen), aantal: liq.rekeningen.kinderen.length }, { tekst: 'Gambia-rekeningen (geoormerkt)', bedrag: r2(liq.geoormerkt), aantal: liq.rekeningen.geoormerkt.length }]
      .concat(liq.anders ? [{ tekst: 'Overige rekeningen (eigenaar onbekend)', bedrag: r2(liq.anders), aantal: liq.rekeningen.anders.length }] : []),
    uitleg: 'Saldo van de rekeningen van David en de gedeelde rekeningen, gedeeld door wat jullie gemiddeld per maand uitgeven zonder de eenmalige grote posten.' } : null;
  // vermogen: privé en Holding apart
  const woning = blok('woning', function () { return leesWoning(o.vault, FV); });
  const hold = blok('holding', function () { return leesHolding(o.vault, FV); });
  const woz = v.belasting && Array.isArray(v.belasting.woning) ? v.belasting.woning.filter(function (r) { return r.woz > 0; }).pop() : null;
  const wl = dga && dga.woninglening && dga.woninglening.jaarrekening && dga.woninglening.jaarrekening.length ? dga.woninglening.jaarrekening[dga.woninglening.jaarrekening.length - 1] : null;
  const rc = dga && dga.rc && dga.rc.totaal != null ? dga.rc.totaal : null;
  const schuld = hyp && hyp.bank && hyp.bank.restschuld != null ? hyp.bank.restschuld : null;
  const delen = [
    sal ? { tekst: 'Vrij beschikbaar op de rekeningen', bedrag: r2(liq.vrij), bron: 'bankstand', op: liq.stand_van ? liq.stand_van.slice(0, 10) : null } : null,
    woning ? { tekst: 'Woning (laatste taxatie, schatting)', bedrag: woning.waarde, bron: woning.bron, op: woning.peildatum } : null,
    schuld != null ? { tekst: 'Hypotheek (bankstand)', bedrag: -schuld, bron: hyp.bron.pagina, op: hyp.bron.bank_op } : null,
    wl ? { tekst: 'Woninglening van de Holding', bedrag: -wl.stand, bron: dga.bron.data || dga.bron.pagina, op: wl.jaar + '-12-31' } : null,
    rc != null ? { tekst: 'Rekening-courant met Holding en Tolgaarde (schuld)', bedrag: -rc, bron: dga.bron.pagina, op: dga.bron.pagina_bijgewerkt || null } : null,
  ].filter(Boolean);
  const mist = [!sal && 'saldi', !woning && 'woning', schuld == null && 'hypotheek', !wl && 'woninglening', rc == null && 'rekening-courant'].filter(Boolean);
  uit.vermogen = {
    prive: { bedrag: mist.length ? null : r2(delen.reduce(function (s, x) { return s + x.bedrag; }, 0)), delen: delen, ontbreekt: mist,
      woz: woz ? { jaar: woz.jaar, waarde: woz.woz } : null,
      niet_meegeteld: sal ? [{ tekst: 'Kinderrekeningen', bedrag: r2(liq.kinderen) }, { tekst: 'Gambia-rekeningen (geoormerkt)', bedrag: r2(liq.geoormerkt) }] : [],
      uitleg: 'Woning op de laatste taxatie (een schatting, geen marktwaarde van nu); de Holding telt hier niet mee.' },
    holding: hold ? { eigen_vermogen: hold.eigen_vermogen, jaar: hold.jaar, liquide: hold.liquide, bron: hold.bron, box2: box2(hold.eigen_vermogen, Math.max(hold.jaar + 1, Number(nu.slice(0, 4)))),
      rc_schuld: rc, uitleg: 'Boekwaarde uit de laatste jaarrekening, geen marktwaarde. "Na box 2" is indicatief: alles in één jaar uitgekeerd, één aanmerkelijk belang, zonder partnerverdeling; laat het toetsen door je adviseur. Je schuld aan de Holding (rekening-courant, woninglening) zit in dit eigen vermogen als vordering.' } : null,
  };
  // trend: 24 maanden vrij per maand (alleen volledige maanden; woning en Holding niet als maandtrend, review ZOU 1)
  uit.trend = vol.slice().reverse().map(function (m) {
    const s = pm.get(m) || {};
    return { maand: m, inkomen: r2(s.inkomen || 0), leven: r2(-(s.leven || 0)), verplicht: r2(-(s.verplicht || 0)), vrij: r2((s.inkomen || 0) + (s.leven || 0) + (s.verplicht || 0)), eenmalig: r2(-(s.leven_eenmalig || 0)) };
  });
  // stap 3: uitgaven per categorie en eigenaar, uitschieters, nieuwe terugkerende posten (een fout maakt alleen dit blok leeg)
  uit.uitgaven = blok('uitgaven', function () { return uitgaven(b.delen, { mNu: mNu, twaalf: twaalf, vanaf: o.vanaf }); });
  // wv2621 (stap 5): de basis van de prognose op dezelfde delen en 12 maanden (financien-vooruit.js; jaar/kwartaalreeksen gaan in de kalender)
  uit.reeksen_jaar = blok('vooruit', function () { return require('./financien-vooruit.js').reeksenJaar(a); });
  uit.basis_vooruit = blok('vooruit', function () { return require('./financien-vooruit.js').basis(b.delen, twaalf, uit.reeksen_jaar || []); });
  // somtoets per maand + het aandeel nog niet ingedeeld
  const uitg = -t12('uitgaven'), ov = -t12('overig');
  uit.controle = { som_klopt: Array.from(pm.keys()).every(function (m) { const s = pm.get(m); return Math.abs(s.leven + s.inkomen + s.verschuiven + s.intern - som.get(m)) < 0.01; }),
    overig_pct: uitg > 0 ? Math.round(ov / uitg * 10000) / 100 : null, overig: r2(ov), uitgaven: r2(uitg), posten: b.posten, ander_valuta: b.ander_valuta || undefined };
  // opruimlijst (onzeker, grootste euro's eerst) en de eenmalige steekproef (top 40 op euro's, review MOET 5)
  const groepen = new Map();
  b.delen.forEach(function (x) {
    if (x.maand < van12 || x.maand > tot12 || x.stroom === 'intern') return;
    const k = x.id;
    if (!groepen.has(k)) groepen.set(k, { id: k, naam: x.tegenpartij || x.omschrijving || 'zonder naam', richting: x.bedrag < 0 ? 'af' : 'bij', aantal: 0, som: 0, stromen: new Map(), zeker: true, waarom: x.waarom, cat: x.cat, gezien: new Set() });
    const g = groepen.get(k);
    if (!g.gezien.has(x.nr)) {
      g.aantal++; g.gezien.add(x.nr);
      // wv2665: de laatste boeking als voorbeeld (het hele bedrag zoals de bank het boekte) en de banktekst die het vaakst voorkomt
      if (!g.voorbeeld || x.datum > g.voorbeeld.datum) g.voorbeeld = { datum: x.datum, rekening: x.rekening, bedrag: r2(x.bedrag), tekst: x.omschrijving || null };
      if (x.omschrijving) { if (!g.teksten) g.teksten = new Map(); g.teksten.set(x.omschrijving, (g.teksten.get(x.omschrijving) || 0) + 1); }
    }
    if (x.stroom === 'verschuiven' && x.sub === 'verplicht' && x.waarom.indexOf('aflossingsdeel') === 0) g.hypotheek = (g.hypotheek || 0) + 1;
    g.som += x.deel; g.zeker = g.zeker && x.zeker;
    const sk = x.stroom + (x.sub ? '/' + x.sub : '');
    g.stromen.set(sk, (g.stromen.get(sk) || 0) + x.deel);
  });
  // wv2665 (David 7-11: "Die lijst is hartstikke cryptisch … Hypotheek is plots gesplitst"): de banktekst, en bij de hypotheek waar de splitsing vandaan komt
  const banktekst = function (g) {
    if (!g.teksten) return undefined;
    const e = Array.from(g.teksten.entries()).sort(function (p, q) { return q[1] - p[1]; })[0];
    // alleen een tekst die terugkomt en niet al in het voorbeeld staat (een unieke tekst per maand zegt niets extra's)
    return e[1] >= 2 && !(g.voorbeeld && g.voorbeeld.tekst === e[0]) ? { tekst: e[0], keer: e[1] } : undefined;
  };
  const splitsing = function (g, ver) {
    if (!g.hypotheek || !(aflossing > 0)) return undefined;
    const afl = ver.filter(function (e) { return e[0] === 'verschuiven/verplicht'; }).reduce(function (s, e) { return s + e[1]; }, 0);
    const rente = ver.filter(function (e) { return e[0] === 'leven'; }).reduce(function (s, e) { return s + e[1]; }, 0);
    const bron = (hyp && hyp.bron ? [hyp.bron.excel, hyp.bron.bank].filter(Boolean).join(' en ') : '') || 'je hypotheekoverzicht';
    return { soort: 'hypotheek', termijnen: g.hypotheek, aflossing_pm: r2(aflossing), aflossing: r2(afl), rente: r2(rente), rente_pm: g.hypotheek ? r2(rente / g.hypotheek) : null, bron: veilig(bron, 120) };
  };
  const regels = regelsLees(a), regelIds = new Set();
  regels.forEach(function (r, k) { const i = k.lastIndexOf('|'); regelIds.add(idVan(k.slice(0, i), k.slice(i + 1))); });
  const gUit = function (g) {
    const ver = Array.from(g.stromen.entries()).sort(function (p, q) { return Math.abs(q[1]) - Math.abs(p[1]); }), st = ver[0][0].split('/');
    return { verdeling: ver.length > 1 ? ver.map(function (e) { const x = e[0].split('/'); return { stroom: x[0], sub: x[1] || null, som: r2(e[1]) }; }) : undefined, id: g.id, naam: g.naam, richting: g.richting, aantal: g.aantal, som: r2(g.som), stroom: st[0], sub: st[1] || null, waarom: g.waarom, categorie: g.cat, gekozen: regelIds.has(g.id) || undefined,
      filter: f({ id: g.id }), voorbeeld: g.voorbeeld || undefined, banktekst: banktekst(g), splitsing: splitsing(g, ver) };
  };
  const alle = Array.from(groepen.values()).sort(function (p, q) { return Math.abs(q.som) - Math.abs(p.som); });
  uit.opruimen = alle.filter(function (g) { return !g.zeker && Math.abs(g.som) >= 50; }).slice(0, 15).map(gUit);
  uit.steekproef = alle.slice(0, 40).map(gUit);
  uit.stromen = STROMEN.map(function (s) { return { stroom: s, subsoorten: SUBSOORT[s] }; });
  return uit;
}

// De boekingen achter een getal (POST /app/financien/boekingen). filter: van, tot (JJJJ-MM), stroom, sub, cat ('-' = zonder categorie), eig
// (eigenaar, wv2620), eenmalig, id; hooguit 300.
// o.vault: voor het aflossingsdeel van de hypotheek (dezelfde splitsing als het overzicht).
function boekingenLijst(A, a, o) {
  const fl = o.filter || {};
  if (!/^\d{4}-\d{2}$/.test(String(fl.van || '')) || !/^\d{4}-\d{2}$/.test(String(fl.tot || '')) || fl.van > fl.tot) throw new Error('filter: van en tot als JJJJ-MM');
  const span = (Number(fl.tot.slice(0, 4)) - Number(fl.van.slice(0, 4))) * 12 + Number(fl.tot.slice(5, 7)) - Number(fl.van.slice(5, 7));
  if (span > 35) throw new Error('filter: hooguit 36 maanden');   // review wv2596 ZOU 1: geen zoektocht door de hele historie
  if (fl.stroom != null && STROMEN.indexOf(fl.stroom) < 0) throw new Error('filter: onbekende stroom');
  if (fl.id != null && !/^[a-f0-9]{16}$/.test(String(fl.id))) throw new Error('filter: onbekende tegenpartij');
  if (fl.eig != null && EIGENAREN.indexOf(fl.eig) < 0) throw new Error('filter: onbekende eigenaar');
  let afl = null;
  try { afl = aflossingVan((o.fv || require('./financien-vault.js')).lees(o.vault).hypotheek); } catch (e) { afl = null; }
  // wv2620: hetzelfde venster als het overzicht (24 maanden terug tot nu), anders erft een post zonder categorie in een korte lijst niet de
  // categorie van de andere posten bij die tegenpartij en klopt een staaf niet met zijn eigen boekingen
  const mNu = String(o.nu || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' })).slice(0, 7);
  // alleen voor een filter binnen dat venster; een oudere lijst laadt alleen zijn eigen maanden (review wv2620 MOET 4: geen omweg om de 36 maanden)
  const v24 = maandPlus(mNu, -24), binnen = fl.van >= v24 && fl.tot <= mNu;
  const lv = binnen ? v24 : fl.van, lt = binnen ? mNu : fl.tot;
  const b = boekingen(a, lv, lt, afl);
  const l = b.delen.filter(function (x) {
    return x.maand >= fl.van && x.maand <= fl.tot && (fl.stroom == null || x.stroom === fl.stroom) && (fl.sub == null || x.sub === fl.sub) && (fl.cat == null || (fl.cat === '-' ? !x.cat : x.cat === fl.cat)) && (fl.eig == null || x.eig === fl.eig) &&
      (fl.eenmalig == null || x.eenmalig === !!fl.eenmalig) && (fl.id == null || x.id === fl.id);
  }).sort(function (p, q) { return Math.abs(q.deel) - Math.abs(p.deel); });
  const max = Math.min(Math.max(parseInt(o.max, 10) || 300, 1), 300);
  return { aantal: l.length, som: r2(l.reduce(function (s, x) { return s + x.deel; }, 0)), getoond: Math.min(l.length, max),
    boekingen: l.slice(0, max).map(function (x) { return { datum: x.datum, rekening: x.rekening, tegenpartij: x.tegenpartij, omschrijving: x.omschrijving, bedrag: r2(x.deel),
      heel: x.deel !== x.bedrag ? r2(x.bedrag) : undefined, stroom: x.stroom, sub: x.sub || undefined, categorie: x.cat, eenmalig: x.eenmalig || undefined, onzeker: x.zeker ? undefined : true, waarom: x.waarom, id: x.id }; }) };
}

// Davids keuze per tegenpartij en richting (alleen via bank-lezer.js app-stroom). stroom null = keuze weg (terug naar de vaste regels).
function stroomZet(A, a, o) {
  if (!/^[a-f0-9]{16}$/.test(String(o.id || ''))) throw new Error('onbekende tegenpartij');
  if (o.stroom !== null && STROMEN.indexOf(o.stroom) < 0) throw new Error('stroom: ' + STROMEN.join(', '));
  if (o.stroom !== null && o.subsoort != null && SUBSOORT[o.stroom].indexOf(o.subsoort) < 0) throw new Error('subsoort past niet bij ' + o.stroom);
  // de id terugvinden: alle sleutels van de laatste 36 maanden
  // dezelfde velden als boekingen(): bij een betaaldienst of eigen BV zit de categorie in de sleutel (review wv2596 MOET 1)
  const rijen = a.db.prepare("SELECT t.tegenpartij, t.omschrijving, t.bedrag, v.categorie FROM transacties t JOIN verrijking v ON v.nr = t.nr JOIN rekeningen r ON r.rek = t.rek WHERE t.status IN ('booked', 'pending')" +
    " AND lower(coalesce(r.eigenaar, '')) NOT IN ('extern', 'pot') AND t.datum >= date('now', '-36 months')").all();
  let hit = null;
  for (let i = 0; i < rijen.length && !hit; i++) { const s = sleutelVan(rijen[i]), r = richting(rijen[i].bedrag); if (idVan(s, r) === o.id) hit = { sleutel: s, richting: r }; }
  if (!hit) throw new Error('onbekende tegenpartij');
  regelsTabel(a);
  try { regelsHerleiden(a); } catch (e) { /* een oude keuze blijft dan buiten beeld */ }
  if (o.stroom === null) { a.db.prepare('DELETE FROM stroom_regels WHERE sleutel = ? AND richting = ?').run(hit.sleutel, hit.richting); return { id: o.id, stroom: null }; }
  a.db.prepare("INSERT INTO stroom_regels (sleutel, richting, stroom, subsoort, herkomst, actief, aangemaakt, sleutel_v) VALUES (?, ?, ?, ?, 'david', 1, ?, 2)" +
    ' ON CONFLICT (sleutel, richting) DO UPDATE SET stroom = excluded.stroom, subsoort = excluded.subsoort, actief = 1, aangemaakt = excluded.aangemaakt, sleutel_v = 2')
    .run(hit.sleutel, hit.richting, o.stroom, o.subsoort || null, new Date().toISOString());
  return { id: o.id, stroom: o.stroom, subsoort: o.subsoort || null };
}

// tabel stroom_regels (herhaalbaar); wv2696: sleutel_v (2 = sleutel met voorletter) en notitie (wat de omzetting deed)
function regelsTabel(a) {
  a.db.exec('CREATE TABLE IF NOT EXISTS stroom_regels (id INTEGER PRIMARY KEY, sleutel TEXT NOT NULL, richting TEXT NOT NULL, stroom TEXT NOT NULL, subsoort TEXT,' +
    ' herkomst TEXT NOT NULL, actief INTEGER NOT NULL DEFAULT 1, aangemaakt TEXT NOT NULL, sleutel_v INTEGER, notitie TEXT, UNIQUE (sleutel, richting))');
  const k = new Set(a.db.prepare("SELECT name FROM pragma_table_info('stroom_regels')").all().map(function (r) { return r.name; }));
  if (!k.has('sleutel_v')) a.db.exec('ALTER TABLE stroom_regels ADD COLUMN sleutel_v INTEGER');
  if (!k.has('notitie')) a.db.exec('ALTER TABLE stroom_regels ADD COLUMN notitie TEXT');
}
// wv2696: zet keuzes met de oude sleutel (zonder voorletter) één keer om. Per keuze de boekingen (laatste 36 maanden, zelfde richting) met
// die oude sleutel: geen = sleutel blijft; één nieuwe sleutel = die; meer (samengevoegde achternaam) = alleen de partij met de meeste
// boekingen, met notitie. Botst de nieuwe sleutel met een nieuwere keuze, dan wint die en gaat de oude uit (actief 0, notitie).
// Geeft de omzettingen terug (voor de toets en het rapport).
function regelsHerleiden(a) {
  if (!a.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stroom_regels'").get()) return [];
  const k = new Set(a.db.prepare("SELECT name FROM pragma_table_info('stroom_regels')").all().map(function (r) { return r.name; }));
  if (k.has('sleutel_v') && !a.db.prepare('SELECT 1 FROM stroom_regels WHERE sleutel_v IS NULL').get()) return [];
  regelsTabel(a);
  const oud = a.db.prepare('SELECT id, sleutel, richting, actief, aangemaakt FROM stroom_regels WHERE sleutel_v IS NULL').all();
  if (!oud.length) return [];
  const rijen = a.db.prepare("SELECT t.tegenpartij, t.omschrijving, t.bedrag, v.categorie FROM transacties t JOIN verrijking v ON v.nr = t.nr JOIN rekeningen r ON r.rek = t.rek WHERE t.status IN ('booked', 'pending')" +
    " AND lower(coalesce(r.eigenaar, '')) NOT IN ('extern', 'pot') AND t.datum >= date('now', '-36 months')").all();
  const tel = new Map();
  rijen.forEach(function (t) {
    const ko = sleutelOud(t) + '|' + richting(t.bedrag), kn = sleutelVan(t);
    if (!tel.has(ko)) tel.set(ko, new Map());
    tel.get(ko).set(kn, (tel.get(ko).get(kn) || 0) + 1);
  });
  const nu = new Date().toISOString().slice(0, 10), uit = [], klaar = new Set();
  a.db.exec('BEGIN IMMEDIATE');
  try {
    oud.forEach(function (r) {
      if (klaar.has(r.id)) return;   // al opzij gezet door een eerdere botsing
      const m = tel.get(r.sleutel + '|' + r.richting);
      const l = m ? Array.from(m.entries()).sort(function (p, q) { return q[1] - p[1] || (p[0] < q[0] ? -1 : 1); }) : [];
      let nieuw = r.sleutel, notitie = null;
      if (!l.length) notitie = 'wv2696 ' + nu + ': geen boekingen bij de omzetting, sleutel ongewijzigd';
      else {
        nieuw = l[0][0];
        if (l.length > 1) notitie = 'wv2696 ' + nu + ': oude sleutel ' + r.sleutel + ' voegde ' + l.length + ' partijen samen (' + l.map(function (e) { return e[0] + ' ' + e[1] + '×'; }).join(', ') +
          '); geldt nu alleen voor ' + nieuw + ' (de meeste boekingen, de naam die je zag)';
        else if (nieuw !== r.sleutel) notitie = 'wv2696 ' + nu + ': sleutel ' + r.sleutel + ' → ' + nieuw + ' (met voorletter)';
      }
      // review wv2696 MOET 3: bij een botsing wint de actieve, en bij twee actieve de jongste keuze; de verliezer gaat opzij (eigen sleutel
      // met #uit, actief 0, notitie), niets wordt gewist
      const bots = nieuw !== r.sleutel ? a.db.prepare('SELECT id, sleutel, actief, aangemaakt FROM stroom_regels WHERE sleutel = ? AND richting = ? AND id != ?').get(nieuw, r.richting, r.id) : null;
      const wint = !bots || (bots.actief !== 1 && r.actief === 1) || (bots.actief === r.actief && String(r.aangemaakt) > String(bots.aangemaakt));
      const opzij = function (x, door) { a.db.prepare('UPDATE stroom_regels SET sleutel = ?, actief = 0, sleutel_v = 2, notitie = ? WHERE id = ?').run(x.sleutel + '#uit' + x.id, 'wv2696 ' + nu + ': uit, regel ' + door + ' geldt voor ' + nieuw, x.id); };
      if (bots && wint) { opzij(bots, r.id); klaar.add(bots.id); }
      if (wint) a.db.prepare('UPDATE stroom_regels SET sleutel = ?, sleutel_v = 2, notitie = ? WHERE id = ?').run(nieuw, notitie, r.id);
      else opzij(r, bots.id);
      uit.push({ id: r.id, van: r.sleutel, naar: wint ? nieuw : null, richting: r.richting, partijen: l.length, uit: bots ? (wint ? bots.id : r.id) : undefined });
    });
    a.db.exec('COMMIT');
  } catch (e) { try { a.db.exec('ROLLBACK'); } catch (e2) { /* niets */ } throw e; }
  return uit;
}

module.exports = { regelsHerleiden: regelsHerleiden, tpWoorden: tpWoorden, zonderIban: zonderIban, overzicht: overzicht, boekingenLijst: boekingenLijst, stroomZet: stroomZet, indelen: indelen, sleutelVan: sleutelVan, idVan: idVan, box2: box2,
  STROMEN: STROMEN, SUBSOORT: SUBSOORT, TARIEVEN: TARIEVEN, EENMALIG_GRENS: EENMALIG_GRENS, EIGENAREN: EIGENAREN, uitgaven: uitgaven, mediaan: mediaan };
