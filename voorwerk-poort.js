'use strict';
/**
 * voorwerk-poort.js — de poorten van OVIS Mail voorwerk-2 (wv2916, 11-11-2026). Puur: geen require, geen netwerk, geen omgeving.
 * Ontwerp: vault "01_Ontwikkeling/Mail-laag stap 4b - voorwerk-2, uitgezocht antwoord (ontwerp 11-11-2026).md" (Davids Ja 11-11 11:58).
 *
 * WAAROM. Voorwerk-2 laat Socev zelf opzoeken (dossier, contract, Nmbrs, eerdere mail). Wat hij in een concept zet, moet kloppen met wat hij
 * echt las, en gevoelige gegevens mogen alleen naar de eigen verwerker. Het taalmodel beslist dat niet zelf: deze module wel.
 * WAT.
 * - scan(tekst): vaste soorten waarden (bedrag, datum, IBAN, BSN-achtig getal met 11-proef, e-mail, telefoon, postcode, uren, dagen).
 * - bevat(waarde, tekst): staat de waarde na vaste normalisatie letterlijk in de tekst (review 1 MOET 1)?
 * - bronbewijs(feiten, stukken): een feit telt alleen als (a) zijn bron in dit run-log staat, (b) de waarde letterlijk in dat stuk staat en
 *   (c) bij een persoonsfeit het stuk persoonsgebonden is voor die persoon (review 2 MOET 2). Persoonsfeit zonder datum, of twee
 *   persoonsgebonden stukken van dezelfde soort (twee contracten) = automatisch een keuze.
 * - onderbouwing(concept, …): elke waarde in het concept staat in de mail, bij een bewezen feit of bij een keuze; anders "niet onderbouwd"
 *   (review 2 MOET 3).
 * - gevoelig(…): de hele tekst op beschermde soorten (review 2 MOET 4). Nooit: BSN, verzuim/medisch, wachtwoorden en codes. Beschermd
 *   (medewerkergegevens): IBAN, e-mail, telefoon, postcode, geboortedatum, bedrag bij een loonwoord, persoonsgegeven uit de feitenlijst:
 *   alleen naar een verwerker op de vaste lijst (exact domein) én alleen als de waarde onderbouwd is. Geen bevestigknop (review 1 MOET 3).
 */

const MAANDEN = { januari: 1, jan: 1, februari: 2, feb: 2, maart: 3, mrt: 3, mar: 3, april: 4, apr: 4, mei: 5, juni: 6, jun: 6, juli: 7, jul: 7,
  augustus: 8, aug: 8, september: 9, sep: 9, sept: 9, oktober: 10, okt: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
  january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, august: 8, october: 10 };
const MAAND_RE = Object.keys(MAANDEN).sort(function (a, b) { return b.length - a.length; }).join('|');

function s(x) { return typeof x === 'string' ? x : x == null ? '' : String(x); }
// Woordvorm: kleine letters, diakrieten weg, alles behalve letters/cijfers/@ wordt spatie
function woorden(x) {
  return s(x).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9@]+/g, ' ').trim();
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function geldigeDatum(j, m, d) { return m >= 1 && m <= 12 && d >= 1 && d <= 31 && (j == null || (j >= 1900 && j <= 2100)); }
function elfproef(n) {
  if (!/^\d{9}$/.test(n) || /^0{9}$/.test(n)) return false;
  let t = 0;
  for (let i = 0; i < 8; i++) t += Number(n[i]) * (9 - i);
  t -= Number(n[8]);
  return t % 11 === 0;
}
function mod97(iban) {
  const r = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of r) { const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch; for (const c of v) rest = (rest * 10 + Number(c)) % 97; }
  return rest === 1;
}
function centen(ruw) {
  let x = s(ruw).toLowerCase().replace(/€|eur(o|\b)|\s/g, '').replace(/,-+$/, '');
  if (!/\d/.test(x)) return null;
  // 1.234,56 / 1234,56 / 1,234.56 / 1234.56 / 1.234
  if (/,\d{1,2}$/.test(x)) x = x.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{1,2}$/.test(x) && !/\.\d{3}$/.test(x)) x = x.replace(/,/g, '');
  else x = x.replace(/[.,]/g, '');
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// Vaste soorten waarden in een tekst. → [{ soort, ruw, sleutel, i, j }] (i/j = plek in de tekst)
function scan(tekst) {
  const t = s(tekst), uit = [], bezet = [];
  function vrij(i, j) { return !bezet.some(function (b) { return i < b[1] && j > b[0]; }); }
  function zoek(re, f) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      const i = m.index, j = i + m[0].length;
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (!vrij(i, j)) continue;
      const r = f(m);
      if (!r) continue;
      bezet.push([i, j]);
      uit.push({ soort: r.soort, ruw: m[0].trim(), sleutel: r.sleutel, i: i, j: j });
    }
  }
  zoek(/\b[a-z]{2}\d{2}(?:[ ]?[a-z0-9]{4}){2,7}(?:[ ]?[a-z0-9]{1,3})?\b/gi, function (m) {
    const k = m[0].replace(/\s/g, '').toUpperCase();
    return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(k) && mod97(k) ? { soort: 'iban', sleutel: 'iban:' + k } : null;
  });
  zoek(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, function (m) { return { soort: 'email', sleutel: 'email:' + m[0].toLowerCase() }; });
  zoek(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g, function (m) {
    const j = +m[1], mm = +m[2], d = +m[3];
    return geldigeDatum(j, mm, d) ? { soort: 'datum', sleutel: 'datum:' + j + '-' + pad2(mm) + '-' + pad2(d) } : null;
  });
  zoek(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b(?![-/.]\d)/g, function (m) {
    const d = +m[1], mm = +m[2], j = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return geldigeDatum(j, mm, d) ? { soort: 'datum', sleutel: 'datum:' + j + '-' + pad2(mm) + '-' + pad2(d) } : null;
  });
  zoek(new RegExp('\\b(\\d{1,2})\\s+(' + MAAND_RE + ')\\.?(?:\\s+(\\d{4}))?\\b', 'gi'), function (m) {
    const d = +m[1], mm = MAANDEN[m[2].toLowerCase()], j = m[3] ? +m[3] : null;
    return geldigeDatum(j, mm, d) ? { soort: 'datum', sleutel: 'datum:' + (j || '*') + '-' + pad2(mm) + '-' + pad2(d) } : null;
  });
  zoek(/\b\d(?:[ .-]?\d){8}\b/g, function (m) {
    const k = m[0].replace(/\D/g, '');
    return elfproef(k) ? { soort: 'bsn', sleutel: 'bsn:' + k } : null;
  });
  zoek(/(?:\+\d{2}|\b00\d{2}|\(0\d{1,3}\)|\b0)(?:[ .()-]{0,3}\d){8,11}\b/g, function (m) {
    let k = m[0].replace(/\D/g, '');
    if (/^\+/.test(m[0]) || /^00/.test(k)) {
      k = k.replace(/^00/, '');
      if (k.indexOf('31') === 0) { k = '0' + k.slice(2).replace(/^0/, ''); return /^0\d{9}$/.test(k) ? { soort: 'telefoon', sleutel: 'tel:' + k } : null; }
      return /^\d{9,13}$/.test(k) ? { soort: 'telefoon', sleutel: 'tel:+' + k } : null;
    }
    return /^0\d{9}$/.test(k) ? { soort: 'telefoon', sleutel: 'tel:' + k } : null;
  });
  // postcode alleen met hoofdletters ("2026 op" is geen postcode; review Fable ZOU 5)
  zoek(/\b[1-9]\d{3}[ ]?[A-Z]{2}\b/g, function (m) {
    const k = m[0].replace(/\s/g, '').toUpperCase();
    return /^(SA|SD|SS)$/.test(k.slice(4)) ? null : { soort: 'postcode', sleutel: 'pc:' + k };
  });
  zoek(/(?:€|\beur(?:o)?\b)[ ]?(?:\d{1,3}(?:[. ]\d{3})+|\d+)(?:[.,]\d{1,2}|,-)?(?!\d)|\b\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?\b|\b\d+,\d{2}\b|\b\d+(?:[.,]\d{1,2})?[ ]?(?:euro|eur)\b/gi, function (m) {
    const c = centen(m[0]);
    return c == null ? null : { soort: 'bedrag', sleutel: 'bedrag:' + c };
  });
  zoek(/\b(\d{1,3}(?:[.,]\d{1,2})?)[ ]?(?:uur|uren)\b/gi, function (m) { return { soort: 'uren', sleutel: 'uren:' + Number(m[1].replace(',', '.')) }; });
  zoek(/\b(\d{1,2})[ ]?(?:dag|dagen)\b/gi, function (m) { return { soort: 'dagen', sleutel: 'dagen:' + Number(m[1]) }; });
  return uit.sort(function (a, b) { return a.i - b.i; });
}
// Past sleutel a (uit de waarde) op sleutel b (uit de bron)? Een datum zonder jaar past op elke datum met die dag en maand.
function sleutelPast(a, b) {
  if (a === b) return true;
  const ma = /^datum:\*-(\d\d-\d\d)$/.exec(a);
  return !!ma && /^datum:/.test(b) && b.slice(-5) === ma[1];
}
function sleutelIn(k, lijst) { return lijst.some(function (x) { return sleutelPast(k, x); }); }

// Staat de waarde letterlijk (na vaste normalisatie) in de tekst?
function bevat(waarde, tekst) {
  const w = woorden(waarde), t = ' ' + woorden(tekst) + ' ';
  if (!w) return false;
  const wv = scan(waarde);
  // Alleen een los getal van ≤ 3 cijfers ("5") bewijst niets: dat staat overal
  if (!wv.length) return !/^\d{1,3}$/.test(w) && t.indexOf(' ' + w + ' ') >= 0;
  // Met gescande waarden (bedrag, datum, IBAN, …): die alleen via hun sleutel (geen voorvoegsel van een langer getal of adres), en elk stuk
  // tekst ertussen als frase in de bron (geen losse woorden: "schaal 5 trede 3" ≠ "schaal 7 trede 9")
  const tk = scan(tekst).map(function (x) { return x.sleutel; });
  if (!wv.every(function (x) { return sleutelIn(x.sleutel, tk); })) return false;
  const delen = [];
  let i = 0;
  wv.forEach(function (x) { delen.push(s(waarde).slice(i, x.i)); i = x.j; });
  delen.push(s(waarde).slice(i));
  return delen.map(woorden).filter(Boolean).every(function (d) { return t.indexOf(' ' + d + ' ') >= 0; });
}

// Hoort de persoon bij de naam waaraan het stuk gebonden is? Alle woorden (≥ 2 tekens) van de kortste naam staan in de langste.
const TUSSEN = new Set(['van', 'de', 'der', 'den', 'het', 'ten', 'ter', 'te', 'la', 'le', 'du', 'di', 'da', 'op', 'in', 'aan', 'bij', 'uit', 'von', 'zu', 't']);
function naamPast(persoon, gebonden) {
  const nw = function (x) { return woorden(x).split(' ').filter(function (y) { return y.length >= 2 && !TUSSEN.has(y) && !/^\d+$/.test(y); }); };
  const a = nw(persoon), b = nw(gebonden);
  if (a.length < 2 || b.length < 2) return false;   // één voornaam of achternaam bewijst geen persoon
  const kort = a.length <= b.length ? a : b, lang = new Set(a.length <= b.length ? b : a);
  return kort.every(function (x) { return lang.has(x); });
}

const FEIT_MAX = 30;
/*
 * feiten: [{ persoon, waarde, bron, datum_stuk, soort }] van het model. stukken: Map of object id → { id, soort, label, tekst, gebonden, datum }
 * (uit het run-log van het luik; soort van het stuk: nmbrs | dossier | contract | vault | mail | agenda | contact | facturen | lijst).
 * → { bewezen: [{ persoon, waarde, soort, bron, vindplaats, datum }], niet_bewezen: [{ persoon, waarde, bron, reden }], keuzes: [{ voorstel, anders, reden }] }
 */
function bronbewijs(feiten, stukken) {
  const get = function (id) { return stukken instanceof Map ? stukken.get(id) : (stukken && Object.prototype.hasOwnProperty.call(stukken, id) ? stukken[id] : undefined); };
  const alle = stukken instanceof Map ? Array.from(stukken.values()) : Object.keys(stukken || {}).map(function (k) { return stukken[k]; });
  const uit = { bewezen: [], niet_bewezen: [], keuzes: [] };
  const gezienKeuze = new Set();
  (Array.isArray(feiten) ? feiten : []).slice(0, FEIT_MAX).forEach(function (f) {
    if (!f || typeof f !== 'object') return;
    const persoon = s(f.persoon).trim().slice(0, 120), waarde = s(f.waarde).trim().slice(0, 300), bron = s(f.bron).trim().slice(0, 20);
    if (!waarde) return;
    const nb = function (reden) { uit.niet_bewezen.push({ persoon: persoon, waarde: waarde, soort: s(f.soort).slice(0, 30) || 'overig', bron: bron, reden: reden }); };
    const st = get(bron);
    if (!st) return nb('bron_niet_gelezen');
    if (!bevat(waarde, st.tekst)) return nb('waarde_niet_in_bron');
    // Review Fable MOET 1: een persoonsgegeven (of een waarde van een beschermde soort) zonder persoon slaat de persoonsbinding niet over
    if (!persoon && (s(f.soort) === 'persoonsgegeven' || scan(waarde).some(function (x) { return BESCHERMD_SCAN.has(x.soort); }))) return nb('persoon_ontbreekt');
    if (persoon) {
      if (!st.gebonden || !naamPast(persoon, st.gebonden)) return nb('niet_persoonsgebonden');
    }
    // Review Fable ZOU 2: datum_stuk telt alleen als het een datum is die in het stuk staat (of de datum van het stuk zelf)
    const ds = s(f.datum_stuk).trim().slice(0, 40), dsk = scan(ds).filter(function (x) { return x.soort === 'datum'; });
    const stk = scan(s(st.datum)).map(function (x) { return x.sleutel; });
    const dsOk = dsk.length === 1 && (bevat(ds, st.tekst) || sleutelIn(dsk[0].sleutel, stk));
    const datum = dsOk ? ds : s(st.datum).trim();
    uit.bewezen.push({ persoon: persoon, waarde: waarde, soort: s(f.soort).slice(0, 30) || 'overig', bron: bron, vindplaats: s(st.label).slice(0, 200), datum: datum || null });
    if (persoon) {
      // Geldigheid: zonder datum, of met twee persoonsgebonden stukken van dezelfde soort in het run-log = keuze voor David
      const zelfde = alle.filter(function (x) { return x && x.soort === st.soort && x.gebonden && naamPast(persoon, x.gebonden) && x.id !== st.id && (x.soort === 'contract' || x.soort === 'dossier'); });
      if (zelfde.length) {
        const k = 'twee|' + st.soort + '|' + woorden(persoon);
        if (!gezienKeuze.has(k)) {
          gezienKeuze.add(k);
          uit.keuzes.push({ voorstel: 'Ik ging uit van ' + s(st.label).slice(0, 120), anders: zelfde.slice(0, 2).map(function (x) { return s(x.label).slice(0, 120); }).join(' of '), reden: 'twee_stukken' });
        }
      } else if (!datum) {
        const k = 'datum|' + st.id;
        if (!gezienKeuze.has(k)) {
          gezienKeuze.add(k);
          uit.keuzes.push({ voorstel: 'Ik ging uit van ' + s(st.label).slice(0, 120) + ' (zonder datum: geldt het nog?)', anders: 'een nieuwer stuk', reden: 'geen_datum' });
        }
      }
    }
  });
  return uit;
}

// Welke niet-bewezen waarden staan toch in de tekst? → [waarde]. Review Fable ZOU 1: ook als alleen een gescande waarde (bedrag, datum,
// IBAN, …) uit dat feit in de tekst staat (parafrase), behalve als die waarde ook in de mail of bij een bewezen feit staat (bekend).
function nietBewezenInTekst(tekst, nietBewezen, bekendeTeksten) {
  const tk = scan(tekst).map(function (x) { return x.sleutel; });
  const bk = bekend(Array.isArray(bekendeTeksten) ? bekendeTeksten : []);
  return (Array.isArray(nietBewezen) ? nietBewezen : []).filter(function (f) {
    if (!f || !f.waarde) return false;
    if (bevat(f.waarde, tekst)) return true;
    return scan(f.waarde).some(function (x) { return sleutelIn(x.sleutel, tk) && !sleutelIn(x.sleutel, bk); });
  }).map(function (f) { return f.waarde; });
}

// Sleutels die al "bekend" zijn: uit de mail, de bewezen feiten, de keuzes en Davids eigen mailstem
function bekend(bronnen) {
  const k = [];
  (Array.isArray(bronnen) ? bronnen : []).forEach(function (b) { scan(b).forEach(function (x) { k.push(x.sleutel); }); });
  return k;
}
/*
 * Elke waarde in het concept onderbouwd? o = { mail, bewezen: [feit], keuzes: [{voorstel, anders}], stem }
 * → [{ soort, ruw }] = niet onderbouwd (in de app geel)
 */
function onderbouwing(concept, o) {
  o = o || {};
  const bewezen = (o.bewezen || []).map(function (f) { return s(f && f.waarde); });
  const keuzes = (o.keuzes || []).map(function (k) { return s(k && k.voorstel) + ' ' + s(k && k.anders); });
  const k = bekend([o.mail].concat(bewezen, keuzes, [o.stem]));
  const uit = [], gezien = new Set();
  scan(concept).forEach(function (x) {
    if (x.soort === 'datum' && sleutelIn(x.sleutel, k)) return;
    if (sleutelIn(x.sleutel, k) || gezien.has(x.sleutel)) return;
    gezien.add(x.sleutel);
    uit.push({ soort: x.soort, ruw: x.ruw });
  });
  return uit;
}

// Review Fable MOET 3: op genormaliseerde tekst (kleine letters, zonder trema's) en zonder woordgrens vooraan ("ziekteverzuim", "reïntegratie")
const NOOIT = [
  { soort: 'verzuim_medisch', re: /(verzuim|(?<![a-z])ziek|arbeidsongeschikt|zwanger|bedrijfsarts|arbo ?arts|arbodienst|diagnose|burn ?out|re ?integratie|ziektewet|medisch|medicatie|medicijn|herstelmelding|betermelding|hersteld gemeld|\bwia\b|\bwga\b|\bwao\b|\bpoortwachter)/ },
  { soort: 'wachtwoord_code', re: /(wachtwoord|password|passwd|pincode|pin code|inlogcode|inloggegevens|inlognaam|toegangscode|verificatiecode|beveiligingscode|herstelcode|tan ?code|2fa|tweestaps)/ }
];
function normaal(t) { return s(t).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[-_]+/g, ' '); }
// Review Fable MOET 4: ook "verdient", "inkomen" en "per maand"; en elk getal van ≥ 3 cijfers naast zo'n woord telt als loonbedrag
const LOONWOORD = /(salaris|loon|bruto|netto|uurloon|maandloon|jaarloon|uurtarief|vakantiegeld|eindejaarsuitkering|toelage|verdien|inkomen|beloning|per maand|per uur|p\.m\.|\bpm\b)/i;
const GEBOORTE = /(geboren|geboorte|geb\.|date of birth|\bdob\b|birth)/i;
const BESCHERMD_SCAN = new Set(['iban', 'email', 'telefoon', 'postcode', 'bsn']);

// Is het adres van een verwerker op de vaste lijst? Exact domein (geen subdomein, geen lijkend domein).
function verwerkerVan(aan, verwerkers) {
  const m = /@([a-z0-9.-]+)$/i.exec(s(aan).trim().toLowerCase());
  if (!m) return null;
  return (Array.isArray(verwerkers) ? verwerkers : []).find(function (v) { return v && typeof v.domein === 'string' && v.domein.toLowerCase() === m[1]; }) || null;
}

/*
 * De gevoeligheidspoort op een (definitieve) tekst. o = { mail, aan, verwerkers: [{naam, domein}], bewezen: [feit], keuzes, stem, feiten (alle, voor soort persoonsgegeven) }
 * → { dicht, redenen: [{ soort, ruw, reden }] } — reden: nooit | geen_verwerker | niet_onderbouwd
 */
function gevoelig(tekst, o) {
  o = o || {};
  const t = s(tekst), redenen = [];
  const vals = scan(t);
  // nooit-soorten zonder de waarde zelf in de reden (review Fable ZOU 6: geen BSN bewaren of tonen)
  vals.filter(function (x) { return x.soort === 'bsn'; }).forEach(function () { redenen.push({ soort: 'bsn', ruw: '', reden: 'nooit' }); });
  const tn = normaal(t);
  NOOIT.forEach(function (n) { if (n.re.test(tn)) redenen.push({ soort: n.soort, ruw: '', reden: 'nooit' }); });
  // Beschermd: wat niet al in de binnengekomen mail (of Davids eigen mailstem/ondertekening) stond
  const inMail = bekend([o.mail, o.stem, s(o.aan)]);
  const bewezenK = bekend((o.bewezen || []).map(function (f) { return s(f && f.waarde); }));
  const beschermd = [];
  vals.forEach(function (x) {
    let soort = null;
    if (x.soort === 'iban' || x.soort === 'email' || x.soort === 'telefoon' || x.soort === 'postcode') soort = x.soort;
    else if (x.soort === 'datum' && GEBOORTE.test(t.slice(Math.max(0, x.i - 40), Math.min(t.length, x.j + 25)))) soort = 'geboortedatum';
    else if (x.soort === 'bedrag' && LOONWOORD.test(t.slice(Math.max(0, x.i - 60), Math.min(t.length, x.j + 30)))) soort = 'loonbedrag';
    if (!soort || sleutelIn(x.sleutel, inMail)) return;
    beschermd.push({ soort: soort, ruw: x.ruw, sleutel: x.sleutel });
  });
  // Losse getallen van ≥ 3 cijfers naast een loonwoord ("3200 bruto", "3200,- per maand") die de scan niet als bedrag zag
  const re = /\d{1,3}(?:\.\d{3})+(?:,\d{1,2}|,-)?|\d{3,}(?:,\d{1,2}|,-)?/g;
  let m;
  while ((m = re.exec(t))) {
    const i = m.index, j = i + m[0].length;
    if ((i > 0 && /[\d.,]/.test(t[i - 1])) || vals.some(function (x) { return i < x.j && j > x.i; })) continue;
    if (!LOONWOORD.test(t.slice(Math.max(0, i - 60), Math.min(t.length, j + 30)))) continue;
    const k = 'bedrag:' + centen(m[0]);
    if (sleutelIn(k, inMail)) continue;
    beschermd.push({ soort: 'loonbedrag', ruw: m[0], sleutel: k });
  }
  (o.feiten || []).forEach(function (f) {
    if (!f || s(f.soort) !== 'persoonsgegeven' || !s(f.waarde).trim()) return;
    if (bevat(f.waarde, t) && !bevat(f.waarde, s(o.mail))) beschermd.push({ soort: 'persoonsgegeven', ruw: s(f.waarde).slice(0, 120), sleutel: null });
  });
  if (beschermd.length) {
    const v = verwerkerVan(o.aan, o.verwerkers);
    beschermd.forEach(function (b) {
      if (!v) return redenen.push({ soort: b.soort, ruw: b.ruw, reden: 'geen_verwerker' });
      const onderbouwd = b.sleutel ? sleutelIn(b.sleutel, bewezenK) : (o.bewezen || []).some(function (f) { return f && woorden(f.waarde) === woorden(b.ruw); });
      if (!onderbouwd) redenen.push({ soort: b.soort, ruw: b.ruw, reden: 'niet_onderbouwd' });
    });
  }
  return { dicht: redenen.length > 0, redenen: redenen.slice(0, 20) };
}

module.exports = { scan, bevat, naamPast, bronbewijs, nietBewezenInTekst, onderbouwing, gevoelig, verwerkerVan, woorden, _intern: { elfproef, centen, sleutelPast } };
