'use strict';
/*
 * facturen-kern.js — de kern van de Facturen-app (wv797, fase F1a, 22-10-2026). Bouwplan: vault 01_Ontwikkeling/Facturen-app - bouwplan
 * (App, 22-10-2026).md § 4.1 en § 7; ontwerp v2 (mk-scripts/facturen/overdracht-2210/bouwplan.md) § 4.4 (status en betaalspoor) en § 4.5
 * (besliskader); contracten/koerier-api.md (vingerafdruk).
 *
 * WAAROM. De beslissing welke entiteit, betaalwijze en controles bij een factuur horen, moet getoetst en puur zijn vóór er routes of
 * schermen op komen (les FV2 7: logica in getoetste code, niet in n8n). Elke stap van het besliskader is een losse functie; de uitkomst
 * is een voorstel + redenen + controles + besluitrijen. Een mens bevestigt altijd (in v1 gaat niets vanzelf door).
 *
 * PUUR. Geen bestand-, netwerk- of procesmodule, geen klok: `vandaag` en `nu` komen in de context (CI-poort in build.yml, zoals
 * bank-archief.js). Opslaan doet facturen-db.js (F1c), routes facturen.js (F2), mail en pdftotext de koerier (F4).
 *
 * NIET ONDERHANDELBAAR (bouwplan § 1). Geen code die betaalt. Privé krijgt nooit een opdracht (maakOpdracht weigert; de database
 * dwingt het in F1c nog eens af). Nieuw IBAN blokkeert Bevestigen tot Nagebeld. Deterministisch eerst: een modelkandidaat is hooguit
 * één stem, vult alleen lege velden en telt niet bij een patiëntkenmerk. De factuurtekst is VLUCHTIG: geen functie geeft hem (of een
 * stuk ervan) terug; redenen en besluiten noemen velden, nooit tekstfragmenten, en een patiëntkenmerk noemt alleen de soort.
 */
const crypto = require('crypto');

class KernFout extends Error {
  constructor(code, melding) { super(melding || code); this.code = code; }
}

// ───────────────────────────── basis: tekst, bedragen, datums ─────────────────────────────

function zonderAccenten(s) { return String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, ''); }
// Onzichtbare opmaaktekens weg, NBSP en smalle spaties gewoon, NFKC (zoals appBsnMasker in server.js). Witruimte ingeklapt (hooguit één
// spatie, hooguit één lege regel) en begrensd op 200.000 tekens (contract koerier-api.md): zo kan geen regex in deze kern op een lange
// reeks spaties of regeleinden blijven hangen (diffreview wv797 #1). Idempotent, dus posities in schoon(x) gelden ook in schoon(schoon(x)).
const MAX_TEKST = 200000;
function schoon(s) {
  return String(s == null ? '' : s).slice(0, MAX_TEKST * 2).replace(/\p{Cf}/gu, '').normalize('NFKC').replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').slice(0, MAX_TEKST);
}
function normNaam(s) {
  return zonderAccenten(s).toLowerCase().replace(/&/g, ' en ')
    .replace(/\b(b\.?\s?v\.?|n\.?\s?v\.?|v\.?\s?o\.?\s?f\.?|c\.?\s?v\.?|ltd|gmbh|inc|bvba|sarl|s\.?a\.?)(?=\s|$|[.,])/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function normNummer(s) { return s == null ? null : String(s).toUpperCase().replace(/[^A-Z0-9]/g, '') || null; }

// Decimaal als tekst ("1234.5", "-0.02") → centen, exact (geen float); > 2 decimalen half van nul af.
function decimaalNaarCenten(s) {
  const m = /^\s*([+-])?(\d+)(?:\.(\d+))?\s*$/.exec(String(s == null ? '' : s));
  if (!m) return null;
  const dec = (m[3] || '');
  let c = Number(m[2]) * 100 + Number((dec + '00').slice(0, 2));
  if (dec.length > 2 && Number(dec[2]) >= 5) c += 1;
  if (!Number.isSafeInteger(c)) return null;
  return m[1] === '-' ? -c : c;
}

// Bedrag zoals op een factuur ("€ 1.234,56", "1,234.56", "-12,50", "12,50-") → centen. Altijd met twee decimalen.
function bedragNaarCenten(s) {
  const t = schoon(s).replace(/\s/g, '').replace(/[€$£]|EUR|USD|GBP|CHF/gi, '').replace(/−/g, '-').replace(/,(?:--?|—)(?=-?$)/, ',00');
  const m = /^(-)?(\d{1,3}(?:\.\d{3})+|\d{1,3}(?:,\d{3})+|\d+)([.,])(\d{2})(-)?$/.exec(t);
  if (!m) return null;
  if (m[2].indexOf(m[3]) >= 0) return null;   // duizendtal en decimaal met hetzelfde teken: geen bedrag
  const heel = Number(m[2].replace(/[.,]/g, ''));
  const c = heel * 100 + Number(m[4]);
  return (m[1] || m[5]) ? -c : c;
}
// Bedrag op een regel: twee decimalen of ",-"; een min telt alleen direct tegen het getal of het valutateken ("oktober - € 12,50" is
// positief); niet gevolgd door een cijfer, procent of ".2026" (datum 22.10.2026 is geen bedrag). Spatie als duizendtal alleen na een
// valutateken ("€ 1 234,56"; "aantal 3 120,00" blijft 120,00).
const BEDRAG_RE = /(?<![\d.,])(?:(-|−)(?=[€$£\d]|EUR))?(?:(?:€|EUR|USD|GBP|CHF|\$|£) ?)?(?:(-|−)(?=\d))?(\d{1,3}(?:\.\d{3})+,\d{2}|\d{1,3}(?:,\d{3})+\.\d{2}|\d+[.,]\d{2}|(?:\d{1,3}(?:\.\d{3})+|\d+),(?:--?|—))(?![\d%]|[.\-/]\d)(-(?! ?\d))?/g;
function bedragenIn(regel) {
  let r = String(regel).replace(/((?:€|EUR) ?-?)(\d{1,3}(?: \d{3})+,\d{2})(?!\d)/g, (_, a, n) => a + n.replace(/ /g, '.'));
  // Op een kortings- of creditregel telt ook "- € 5,00" (min met een spatie) als negatief (natoets #5).
  if (/korting|credit|aftrek|verrekend|retour/i.test(r)) r = r.replace(/(^|\s)[-−] (?=€|EUR|\d)/g, '$1-');
  const uit = []; let m; BEDRAG_RE.lastIndex = 0;
  while ((m = BEDRAG_RE.exec(r))) {
    const c = bedragNaarCenten((m[1] || m[2] ? '-' : '') + m[3] + (m[4] ? '-' : ''));
    if (c != null) uit.push({ c, punt: /^\d+\.\d{2}$/.test(m[3]), komma: /,(\d{2}|--?|—)$/.test(m[3]) });
  }
  // Gemengde notatie op één regel ("€ 121,00 per 01.11"): dan is "01.11" een datum, geen bedrag.
  const nl = uit.some((x) => x.komma);
  return uit.filter((x) => !(nl && x.punt)).map((x) => x.c);
}

function geldigeDatum(j, m, d) {
  if (!(j >= 1900 && j <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const x = new Date(Date.UTC(j, m - 1, d));
  if (x.getUTCFullYear() !== j || x.getUTCMonth() !== m - 1 || x.getUTCDate() !== d) return null;
  return x.toISOString().slice(0, 10);
}
function isIsoDatum(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && geldigeDatum(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10)) === s; }
function dagenTussen(a, b) { return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000); }
function plusDagen(d, n) { const x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n)); return x.toISOString().slice(0, 10); }

const MAANDEN = {
  januari: 1, jan: 1, january: 1, februari: 2, feb: 2, february: 2, maart: 3, mrt: 3, march: 3, mar: 3, april: 4, apr: 4, mei: 5, may: 5,
  juni: 6, jun: 6, june: 6, juli: 7, jul: 7, july: 7, augustus: 8, aug: 8, august: 8, september: 9, sep: 9, sept: 9, oktober: 10, okt: 10,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const DATUM_BRON = '(\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4}|\\d{1,2}\\s+[a-z]{3,9}\\.?\\s+\\d{4})';
function leesDatum(s) {
  const t = zonderAccenten(schoon(s)).toLowerCase().trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return geldigeDatum(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
  if (m) return geldigeDatum(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})\s+([a-z]{3,9})\.?\s+(\d{4})$/.exec(t);
  if (m && MAANDEN[m[2]]) return geldigeDatum(+m[3], MAANDEN[m[2]], +m[1]);
  return null;
}

// ───────────────────────────── IBAN en BSN ─────────────────────────────

// IBAN-lengte per land (SEPA + een paar gangbare andere). Een land dat hier niet staat, is geen IBAN (diffreview wv797 natoets #8).
const IBAN_LENGTE = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GI: 23, GL: 18,
  GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24,
  SE: 24, SI: 19, SK: 24, SM: 27, VA: 22, AE: 23, IL: 23, SA: 24, TR: 26,
};
function ibanNorm(i) { return i == null ? null : String(i).replace(/\s+/g, '').toUpperCase() || null; }
function ibanMod97(i) {
  const s = ibanNorm(i);
  if (!s || !/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(s)) return false;
  if (IBAN_LENGTE[s.slice(0, 2)] !== s.length) return false;
  const r = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const ch of r) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}
function bsnElfproef(c) {
  const s = String(c == null ? '' : c).replace(/\D/g, '');
  if (!/^\d{9}$/.test(s) || /^0+$/.test(s)) return false;
  let som = 0;
  for (let i = 0; i < 8; i++) som += Number(s[i]) * (9 - i);
  return (som - Number(s[8])) % 11 === 0;
}

// IBAN's in een tekst: kandidaat met spaties, dan op de landlengte afknippen (anders slokt "… 00 BIC" het volgende woord op).
// Een kandidaat die na een label "IBAN" staat maar de mod-97 niet haalt, komt mee als ongeldig: een tikfout of vervalsing moet zichtbaar zijn.
function ibansIn(tekst, opties) {
  // Alleen a–z naar hoofdletters (toUpperCase kan de lengte veranderen, ß → SS, en dan kloppen de posities niet meer).
  const t = schoon(tekst).replace(/[a-z]/g, (c) => c.toUpperCase());
  // Begin "NL91" / "NL 91" / "NL-91", daarna stukjes letters/cijfers met hooguit één spatie of streepje ertussen, tot precies de lengte van
  // het land. Een stukje dat over die lengte heen loopt, maakt het geen IBAN: zo wordt "NL833719481B01 KvK 1…" (btw-nummer + woord)
  // nooit aan elkaar geplakt (diffreview wv797 natoets #1). Ook "NL91 ABNA 0417 164 300" en "NL91-ABNA-…" (#3).
  const re = /\b([A-Z]{2})[ -]?(\d{2})/g;
  const uit = []; const gezien = new Set(); let m;
  while ((m = re.exec(t))) {
    const lengte = IBAN_LENGTE[m[1]];
    if (!lengte) continue;
    let comp = m[1] + m[2], k = m.index + m[0].length;
    while (comp.length < lengte) {
      let j = k;
      if (t[j] === ' ' || t[j] === '-') j++;
      const stuk = /^[A-Z0-9]+/.exec(t.slice(j, j + 40));
      if (!stuk || comp.length + stuk[0].length > lengte) break;
      comp += stuk[0]; k = j + stuk[0].length;
    }
    if (comp.length !== lengte || /[A-Z0-9]/.test(t[k] || '')) continue;
    const iban = comp, lengteRuw = k - m.index;
    re.lastIndex = k;
    const voor = t.slice(Math.max(0, m.index - 90), m.index);
    const geldig = ibanMod97(iban);
    if (!geldig && !/IBAN\W{0,12}$/.test(voor) && !/(REKENING|REK\.?|BANK)\W{0,20}$/.test(voor)) continue;
    if (gezien.has(iban) && !(opties && opties.alle)) continue;
    gezien.add(iban);
    // Debiteur-context: "van uw rekening", "afgeschreven van", "machtiging": dit is de rekening van de klant, niet waar je naar betaalt.
    const klant = /(VAN UW (BANK)?REKENING|AFGESCHREVEN|GEINCASSEERD|GEÏNCASSEERD|INCASSO|MACHTIGING|UW REKENING|DEBITEURENREKENING)[^\n]{0,60}$/.test(zonderAccenten(voor).toUpperCase());
    uit.push({ iban, geldig, klant, positie: m.index, lengte: lengteRuw });
  }
  return uit;
}

// ───────────────────────────── stap 3: patiëntkenmerk ─────────────────────────────

const BSN_KAND = /(?<![\dA-Za-z.,])(\d{9}|\d{4}[ .]\d{2}[ .]\d{3}|\d{3}[ .]\d{3}[ .]\d{3})(?![\dA-Za-z]|[.,]\d)/g;
const BSN_LABEL = /\b(bsn|burgerservicenummer|burger\s?service\s?nummer|sofi(?:nummer)?)\b[^\n]{0,30}$/i;
const ANDER_NUMMER = /\b(factuur|nota|kenmerk|klant|order|debiteur|referentie|contract|relatie|lid|abonnement|polis|invoice|account|rekening|tel|telefoon|fax|kvk|btw|artikel|art|bestel|dossier|ordernr|pakket|zending|transactie)\w*\W{0,15}$/i;
// Ook samenstellingen (patiëntnaam, cliëntnummer) en "geb." met een datum (diffreview wv797 #4).
const PATIENT_WOORD = /\b(pati[eë]nt|cli[eë]nt)/i;
const GEBOORTE = new RegExp('\\b(geboortedatum|geb\\.?\\s?datum|geboren(?:\\s+op)?|geb\\.?)\\s?[:.]?\\s?' + DATUM_BRON, 'i');
const DATUM_IN = new RegExp(DATUM_BRON, 'gi');

function stapPatientkenmerk(teksten, koerierVlag) {
  const soorten = new Set();
  if (koerierVlag) soorten.add('koerier');
  for (const ruw of teksten || []) {
    if (!ruw) continue;
    let tekst = schoon(ruw);
    // IBAN's eerst wegpoetsen: het rekeningdeel van een NL-IBAN haalt per constructie de elfproef.
    for (const i of ibansIn(tekst, { alle: true })) tekst = tekst.slice(0, i.positie) + ' '.repeat(i.lengte) + tekst.slice(i.positie + i.lengte);
    let m; BSN_KAND.lastIndex = 0;
    while ((m = BSN_KAND.exec(tekst))) {
      if (!bsnElfproef(m[1])) continue;
      const regelVoor = tekst.slice(tekst.lastIndexOf('\n', m.index) + 1, m.index);
      if (BSN_LABEL.test(regelVoor)) { soorten.add('bsn'); continue; }
      if (!ANDER_NUMMER.test(regelVoor)) soorten.add('bsn_los');
    }
    if (PATIENT_WOORD.test(tekst) && GEBOORTE.test(zonderAccenten(tekst))) soorten.add('patient_geboortedatum');
    // Patiëntwoord met een datum van vóór 2010 op dezelfde regel ("Patiënt: … (01-02-1950)"): vrijwel altijd een geboortedatum (natoets #7).
    for (const regel of tekst.split('\n')) {
      if (!PATIENT_WOORD.test(regel)) continue;
      let d; DATUM_IN.lastIndex = 0;
      while ((d = DATUM_IN.exec(zonderAccenten(regel)))) { const x = leesDatum(d[1]); if (x && x < '2010-01-01') { soorten.add('patient_datum'); break; } }
    }
  }
  const lijst = [...soorten].sort();
  return {
    kenmerk: lijst.length > 0,
    soorten: lijst,
    besluiten: [besluit('patientkenmerk', 'patientkenmerk', lijst.length > 0 ? 1 : 0, 'regel', lijst.length ? 'soort: ' + lijst.join(', ') : 'geen kenmerk')],
  };
}

// ───────────────────────────── UBL 2.1 / SI-UBL 2.0 ─────────────────────────────

const XML_ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function xmlOntsnap(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
    return XML_ENT[e];
  });
}
function lokaal(n) { const i = n.indexOf(':'); return i >= 0 ? n.slice(i + 1) : n; }
// Kleine, strikte XML-lezer voor UBL: geen DOCTYPE/ENTITY (geen entiteituitbreiding), tags moeten sluiten, alles wat niet past → fout.
function leesXml(xml) {
  const s = String(xml == null ? '' : xml).replace(/^﻿/, '');
  if (s.length > 20 * 1024 * 1024) throw new KernFout('xml_te_groot');
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw new KernFout('xml_doctype', 'XML met DOCTYPE of ENTITY wordt niet gelezen');
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|([^<]+)/y;
  const wortel = { naam: '#doc', attr: {}, kinderen: [], tekst: '' };
  const stapel = [wortel]; let m;
  while (re.lastIndex < s.length) {
    const bij = re.lastIndex;
    m = re.exec(s);
    if (!m || m.index !== bij) throw new KernFout('xml_ongeldig', 'XML niet te lezen bij positie ' + bij);
    const top = stapel[stapel.length - 1];
    if (m[1] !== undefined) top.tekst += m[1];
    else if (m[2]) {
      if (stapel.length < 2 || top.ruw !== m[2]) throw new KernFout('xml_ongeldig', 'sluittag past niet');
      stapel.pop();
    } else if (m[3]) {
      const attr = {}; const ar = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g; let a;
      while ((a = ar.exec(m[4] || ''))) attr[lokaal(a[1])] = xmlOntsnap(a[2] !== undefined ? a[2] : a[3]);
      const el = { naam: lokaal(m[3]), ruw: m[3], attr, kinderen: [], tekst: '' };
      top.kinderen.push(el);
      if (!m[5]) { if (stapel.length > 200) throw new KernFout('xml_te_diep'); stapel.push(el); }
    } else if (m[6] !== undefined) top.tekst += xmlOntsnap(m[6]);
  }
  if (stapel.length !== 1) throw new KernFout('xml_ongeldig', 'niet alle tags gesloten');
  if (wortel.kinderen.length !== 1 || wortel.tekst.trim()) throw new KernFout('xml_ongeldig', 'precies één wortelelement, geen losse tekst');
  return wortel;
}
function kind(el, naam) { return el ? el.kinderen.find((k) => k.naam === naam) || null : null; }
function kinderen(el, naam) { return el ? el.kinderen.filter((k) => k.naam === naam) : []; }
function pad(el, p) { let x = el; for (const n of p.split('/')) { x = kind(x, n); if (!x) return null; } return x; }
function tekstVan(el) { return el ? el.tekst.trim() : null; }
function alleTekst(el, uit) { uit = uit || []; if (el.tekst.trim()) uit.push(el.tekst.trim()); for (const k of el.kinderen) alleTekst(k, uit); return uit; }
function zoek(el, naam) { if (el.naam === naam) return el; for (const k of el.kinderen) { const r = zoek(k, naam); if (r) return r; } return null; }

function partij(p) {
  if (!p) return { naam: null, kvk: null, btw: null };
  const naam = tekstVan(pad(p, 'PartyLegalEntity/RegistrationName')) || tekstVan(pad(p, 'PartyName/Name'));
  let kvk = null;
  const kandidaten = [pad(p, 'PartyLegalEntity/CompanyID'), kind(p, 'EndpointID'), ...kinderen(p, 'PartyIdentification').map((x) => kind(x, 'ID'))];
  for (const k of kandidaten) {
    if (!k) continue;
    const v = tekstVan(k).replace(/\s/g, '');
    if ((k.attr.schemeID === '0106' || !k.attr.schemeID) && /^\d{8}$/.test(v)) { kvk = v; break; }
  }
  const btwEl = kinderen(p, 'PartyTaxScheme').map((x) => kind(x, 'CompanyID')).find(Boolean);
  const btw = btwEl ? tekstVan(btwEl).replace(/\s/g, '').toUpperCase() : null;
  return { naam: naam || null, kvk, btw };
}

// Leest een UBL Invoice of CreditNote (ook binnen een StandardBusinessDocument). Bedragen in centen; creditnota negatief.
function leesUbl(xml) {
  let boom;
  try { boom = leesXml(xml); } catch (e) { return { ok: false, reden: e.code || 'xml_ongeldig' }; }
  const doc = zoek(boom, 'Invoice') || zoek(boom, 'CreditNote');
  if (!doc) return { ok: false, reden: 'geen_ubl_factuur' };
  const isCredit = doc.naam === 'CreditNote';
  const typecode = tekstVan(kind(doc, isCredit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'));
  const valuta = (tekstVan(kind(doc, 'DocumentCurrencyCode')) || 'EUR').toUpperCase();
  const bedrag = (el) => (el ? decimaalNaarCenten(tekstVan(el)) : null);
  const lmt = kind(doc, 'LegalMonetaryTotal') || kind(doc, 'RequestedMonetaryTotal');
  const taxTotals = kinderen(doc, 'TaxTotal');
  const taxEl = (taxTotals.find((t) => (kind(t, 'TaxAmount') || { attr: {} }).attr.currencyID === valuta) || taxTotals[0]);
  let excl = bedrag(kind(lmt, 'TaxExclusiveAmount')), incl = bedrag(kind(lmt, 'TaxInclusiveAmount'));
  const teBetalen = bedrag(kind(lmt, 'PayableAmount')), vooraf = bedrag(kind(lmt, 'PrepaidAmount'));
  let btw = taxEl ? bedrag(kind(taxEl, 'TaxAmount')) : null;
  if (incl == null) incl = teBetalen;
  const soort = (isCredit || typecode === '381' || typecode === '396' || (incl != null && incl < 0)) ? 'creditnota' : 'factuur';
  if (soort === 'creditnota') { const neg = (x) => (x == null ? null : -Math.abs(x)); excl = neg(excl); incl = neg(incl); btw = neg(btw); }
  const lev = partij(pad(doc, 'AccountingSupplierParty/Party')), klant = partij(pad(doc, 'AccountingCustomerParty/Party'));
  const pm = kinderen(doc, 'PaymentMeans');
  const ibans = [], klantIbans = []; let kenmerk = null, hint = null;
  for (const p of pm) {
    const code = tekstVan(kind(p, 'PaymentMeansCode'));
    const iban = ibanNorm(tekstVan(pad(p, 'PayeeFinancialAccount/ID')));
    if (iban && !ibans.includes(iban)) ibans.push(iban);
    const payer = ibanNorm(tekstVan(pad(p, 'PaymentMandate/PayerFinancialAccount/ID')));
    if (payer) klantIbans.push(payer);
    if (!kenmerk && kind(p, 'PaymentID')) kenmerk = tekstVan(kind(p, 'PaymentID'));
    if (!hint) {
      if (code === '49' || code === '59' || kind(p, 'PaymentMandate')) hint = 'incasso';
      else if (['48', '54', '55', '68', '10', '97'].includes(code)) hint = 'betaald';
      else if (['30', '31', '42', '58'].includes(code)) hint = 'zelf';
    }
  }
  if (teBetalen === 0 && vooraf != null && vooraf !== 0) hint = 'betaald';
  const vervaldatum = tekstVan(kind(doc, 'DueDate')) || pm.map((p) => tekstVan(kind(p, 'PaymentDueDate'))).find(Boolean) || null;
  const bijlage = kinderen(doc, 'AdditionalDocumentReference').map((r) => pad(r, 'Attachment/EmbeddedDocumentBinaryObject')).find((b) => b && /pdf/i.test(b.attr.mimeCode || ''));
  const fd = tekstVan(kind(doc, 'IssueDate'));
  return {
    ok: true, soort, typecode: typecode || null,
    profiel: tekstVan(kind(doc, 'CustomizationID')),
    si_ubl: /nlcius/i.test(tekstVan(kind(doc, 'CustomizationID')) || ''),
    nummer: tekstVan(kind(doc, 'ID')),
    factuurdatum: isIsoDatum(fd) ? fd : null,
    vervaldatum: isIsoDatum(vervaldatum) ? vervaldatum : null,
    valuta, excl, btw, incl, te_betalen: teBetalen,
    leverancier: lev, klant,
    iban: ibans[0] || null, ibans, klant_ibans: klantIbans, kenmerk: kenmerk || null,
    betaalwijze_hint: hint,
    heeft_pdf: !!bijlage, pdf_naam: bijlage ? (bijlage.attr.filename || null) : null,
    // VLUCHTIG: alleen voor het patiëntkenmerk; wordt niet teruggegeven door beslisBericht.
    _tekst: alleTekst(doc).filter((t) => t.length < 2000 && !/^[A-Za-z0-9+/=\s]{200,}$/.test(t)).join('\n'),
  };
}

// ───────────────────────────── stap 4: regex-velden uit (vluchtige) PDF-tekst ─────────────────────────────

// Labels in volgorde van zekerheid. `laatste`: tabelregel "Totaal  excl  btw  incl" → het laatste bedrag; anders het eerste na het label.
// "te betalen/voldoen" alleen aan het begin van een regel (anders wint een betaalzin van het echte totaal; diffreview wv797 #9).
const LABEL_INCL = [
  { re: /totaal\s?(?:incl(?:usief|\.)?|inc\.)\s?(?:btw|b\.t\.w\.)?/i },
  { re: /totaal\s+te\s+(?:betalen|voldoen)/i },
  { re: /^(?:te\s+(?:betalen|voldoen)(?:\s+bedrag)?)\b/i },
  { re: /(?:total\s+)?amount\s+due|total\s+due|balance\s+due|total\s+incl\.?\s?vat|grand\s+total/i },
  { re: /eindtotaal|totaalbedrag|totaal\s+bedrag|factuurbedrag/i },
  { re: /^totaal\b(?!.*(excl|btw|vat|netto|sub))/i, laatste: true },
  { re: /^(?:nog|bedrag)\s+te\s+(?:betalen|voldoen)\b/i },   // laatste redmiddel: "nog te betalen" kan een restbedrag zijn
];
const LABEL_EXCL = [
  { re: /(?:totaal|totaalbedrag|totaal\s+bedrag)\s?(?:excl(?:usief|\.)?|ex\.)\s?(?:btw|b\.t\.w\.)?/i },
  { re: /sub-?\s?totaal/i }, { re: /netto\s?(?:bedrag|totaal)/i }, { re: /total\s+excl\.?\s?vat|subtotal|net\s+amount/i },
];
const LABEL_BTW = /\b(btw|b\.t\.w\.|vat|omzetbelasting)\b/i;
const NIET_BTW = /excl|incl|inc\.|nummer|nr\b|nr\.|id\b|number|identificatie|verlegd|vrijgesteld|\bno\b|grondslag|over\b|basis/i;

function bedragNaLabel(regels, labels, nietNa) {
  for (const lab of labels) {
    for (let i = 0; i < regels.length; i++) {
      const r = regels[i], m = lab.re.exec(r);
      if (!m) continue;
      const na = r.slice(m.index + m[0].length).replace(/\([^)]{0,80}\)/g, ' ');   // "(btw € 21,00)" is niet het totaal (natoets #5)
      if (nietNa && nietNa.test(na)) continue;   // "Totaalbedrag excl. btw" is geen incl (diffreview wv797 #5)
      let b = bedragenIn(na);
      // Label aan het eind van de regel (kolomopmaak): dan het eerste bedrag op een van de twee volgende regels.
      if (!b.length && /^[\s:€]*$/.test(na)) for (let j = i + 1; j < Math.min(regels.length, i + 3) && !b.length; j++) if (regels[j].trim()) b = bedragenIn(regels[j]).slice(0, 1);
      if (b.length) return lab.laatste ? b[b.length - 1] : b[0];
    }
  }
  return null;
}
function datumNaLabel(tekst, labels) {
  const t = zonderAccenten(tekst);
  for (const lab of labels) {
    const m = new RegExp(lab + '\\s*[:.]?\\s*' + DATUM_BRON, 'i').exec(t);
    if (m) { const d = leesDatum(m[m.length - 1]); if (d) return d; }
  }
  return null;
}
const VALUTA_RE = /\b(USD|GBP|CHF|SEK|NOK|DKK|PLN|JPY|CAD|AUD)\b|(\$)|(£)/;

// Velden die de app zelf uit de pdftotext-uitvoer haalt. De tekst wordt hier gebruikt en valt weg; de uitkomst bevat alleen velden.
function leesPdfTekst(tekst) {
  const t = schoon(tekst);
  const regels = t.split('\n');
  // Creditnota alleen op een kop (korte regel die ermee begint) of een nummerlabel, niet op een los woord in de voettekst (diffreview #6).
  const CREDIT = /^(?:credit\s?nota|creditfactuur|credit\s?note|credit\s?invoice)\b/i;
  let soort = regels.some((r) => CREDIT.test(r) && r.length <= 40) || /\b(?:credit\s?nota|creditfactuur|credit\s?note)\s?(?:nummer|nr\.?|no\.?|number|#)/i.test(t) ? 'creditnota' : 'factuur';
  let nummer = null;
  const nrRe = [
    /\b(?:factuur|nota|creditnota|creditfactuur|invoice|credit\s?note)\s*(?:nummer|nr\.?|no\.?|number|#)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/.]{0,30})/i,
    /\b(?:factuur|invoice|nota)\s*[:#]?\s+(?!datum|date|nummer|nr|adres)([A-Z]{0,5}[-\/]?\d[A-Z0-9\-\/.]{0,30})/i,
  ];
  for (const re of nrRe) { const m = re.exec(t); if (m && /\d/.test(m[1])) { nummer = m[1].replace(/[.\-\/]+$/, ''); break; } }
  const factuurdatum = datumNaLabel(t, ['factuurdatum', 'datum factuur', 'invoice date', 'notadatum', '\\bdatum', '\\bdate']);
  let vervaldatum = datumNaLabel(t, ['vervaldatum', 'verval datum', 'uiterste betaaldatum', 'te betalen (?:voor|vóór)', 'betalen (?:voor|vóór)', 'due date', 'payment due']);
  if (!vervaldatum && factuurdatum) {
    const m = /betalings?termijn\s*[:.]?\s*(\d{1,3})\s*dagen|binnen\s+(\d{1,3})\s+dagen/i.exec(t);
    if (m) vervaldatum = plusDagen(factuurdatum, Number(m[1] || m[2]));
  }
  let incl = bedragNaLabel(regels, LABEL_INCL, /^\W{0,3}(?:excl|exclusief|ex\.|netto|zonder)/i), excl = bedragNaLabel(regels, LABEL_EXCL, /^\W{0,3}(?:incl|inclusief)/i);
  let btw = null;
  const totBtw = regels.find((r) => /totaal\s+(btw|b\.t\.w\.|vat)|btw[- ]?bedrag|total\s+vat/i.test(r) && !/excl|incl/i.test(r));
  if (totBtw) { const b = bedragenIn(totBtw); if (b.length) btw = b[b.length - 1]; }
  if (btw == null) {
    let som = null;
    for (const r of regels) {
      if (!LABEL_BTW.test(r) || NIET_BTW.test(r)) continue;
      const b = bedragenIn(r); if (!b.length) continue;
      som = (som || 0) + b[b.length - 1];
    }
    btw = som;
  }
  const inclRegel = regels.find((r) => LABEL_INCL.some((l) => l.re.test(r)) && bedragenIn(r).length);
  let valuta = 'EUR';
  const vm = (inclRegel && VALUTA_RE.exec(inclRegel)) || (!/€|\bEUR\b/.test(t) && VALUTA_RE.exec(t));
  if (vm) valuta = vm[1] || (vm[2] ? 'USD' : 'GBP');
  if (soort === 'factuur' && incl != null && incl < 0) soort = 'creditnota';
  if (soort === 'creditnota') { const neg = (x) => (x == null ? null : -Math.abs(x)); incl = neg(incl); excl = neg(excl); btw = neg(btw); }
  const ibans = ibansIn(t);
  let kenmerk = null;
  const km = /(?:betalingskenmerk|betaalkenmerk)\s*[:.]?\s*(\d[\d ]{5,22}\d)/i.exec(t) || /(?:o\.v\.v\.|onder vermelding van)\s*[:.]?\s*(?:(?:het\s+)?factuurnummer\s*)?([A-Z0-9][A-Z0-9\-\/]{2,30})/i.exec(t);
  if (km && /\d/.test(km[1])) kenmerk = km[1].replace(/\s+/g, ' ').trim();   // minstens één cijfer: geen los woord of naam (#12)
  const kvks = []; const kr = /\b(?:kvk|k\.v\.k\.|kamer van koophandel|coc)(?:[\s-]*(?:nr|nummer|no|number)\.?)?\s*[:.]?\s*(\d{8})\b/gi; let k;
  while ((k = kr.exec(t))) if (!kvks.includes(k[1])) kvks.push(k[1]);
  const btwnrs = []; const br = /\b(NL\s?\d{9}\s?B\s?\d{2})\b/gi; let b;
  while ((b = br.exec(t))) { const v = b[1].replace(/\s/g, '').toUpperCase(); if (!btwnrs.includes(v)) btwnrs.push(v); }
  return { soort, nummer, factuurdatum, vervaldatum, excl, btw, incl, valuta, ibans, kenmerk, kvks, btwnrs };
}

// ───────────────────────────── besluitrijen ─────────────────────────────

const BESLUIT_BRONNEN = ['anker', 'leverancier', 'regel', 'bank', 'model', 'mens'];
function besluit(stap, veld, waarde, bron, toelichting) {
  if (!BESLUIT_BRONNEN.includes(bron)) throw new KernFout('besluit_bron', 'onbekende besluitbron ' + bron);
  return { stap, veld, waarde: waarde == null ? null : waarde, bron, toelichting: toelichting || null };
}

// ───────────────────────────── stap 1: dubbel ─────────────────────────────

function stapDubbelBestand(sha256, ctx) {
  const bekend = new Set((ctx && ctx.bekendeSha256) || []);
  const dubbel = bekend.has(sha256);
  return { dubbel, besluiten: [besluit('dubbel', 'sha256', dubbel ? 1 : 0, 'regel', dubbel ? 'zelfde bestand al bekend' : 'nieuw bestand')] };
}
// Sleutel voor "zelfde factuur": leverancier + nummer + bedrag. Leverancier bij voorkeur als id, anders KvK of genormaliseerde naam.
function factuurSleutel(f) {
  const lev = f.leverancier_id ? 'id:' + f.leverancier_id : f.leverancier_kvk ? 'kvk:' + f.leverancier_kvk : f.leverancier_naam ? 'naam:' + normNaam(f.leverancier_naam) : null;
  const nr = normNummer(f.nummer);
  if (!lev || !nr || f.incl == null) return null;
  return lev + '|' + nr + '|' + f.incl;
}
function stapDubbelInhoud(velden, ctx) {
  const sleutel = factuurSleutel(velden);
  if (!sleutel) return { dubbel: false, besluiten: [besluit('dubbel', 'inhoud', 0, 'regel', 'leverancier, nummer of bedrag onbekend: niet te vergelijken')] };
  const treffer = ((ctx && ctx.bestaandeFacturen) || []).find((f) => factuurSleutel(f) === sleutel);
  return {
    dubbel: !!treffer, van: treffer ? treffer.id : null,
    besluiten: [besluit('dubbel', 'inhoud', treffer ? 1 : 0, 'regel', treffer ? 'zelfde leverancier, nummer en bedrag als factuur ' + treffer.id : 'geen eerdere factuur met deze leverancier, dit nummer en bedrag')],
  };
}

// ───────────────────────────── stap 2: soort ─────────────────────────────

function stapSoort(doc) {
  const naam = String(doc.naam || ''), mime = String(doc.mime || '').toLowerCase();
  const isXml = doc.ubl_xml != null || /xml/.test(mime) || /\.xml$/i.test(naam);
  if (isXml) {
    const ubl = leesUbl(doc.ubl_xml != null ? doc.ubl_xml : doc.tekst);
    if (ubl.ok) return { soort: 'ubl', ubl, besluiten: [besluit('soort', 'soort', 'ubl', 'regel', 'UBL ' + (ubl.si_ubl ? 'SI-UBL 2.0 ' : '') + (ubl.soort === 'creditnota' ? 'CreditNote' : 'Invoice'))] };
    return { soort: 'overig', reden: ubl.reden, besluiten: [besluit('soort', 'soort', 'overig', 'regel', 'XML zonder UBL-factuur (' + ubl.reden + ')')] };
  }
  const isPdf = /pdf/.test(mime) || /\.pdf$/i.test(naam);
  const isBeeld = /^image\//.test(mime) || /\.(jpe?g|png|heic|tiff?|webp)$/i.test(naam);
  if (isPdf && doc.tekstlaag !== false && String(doc.tekst || '').trim().length >= 20) return { soort: 'pdf', besluiten: [besluit('soort', 'soort', 'pdf', 'regel', 'PDF met tekstlaag')] };
  if (isPdf || isBeeld) return { soort: 'scan', besluiten: [besluit('soort', 'soort', 'scan', 'regel', (isPdf ? 'PDF' : 'afbeelding') + ' zonder tekstlaag: geen OCR in v1, velden met de hand')] };
  return { soort: 'overig', reden: 'onbekend_bestand', besluiten: [besluit('soort', 'soort', 'overig', 'regel', 'geen PDF, UBL of afbeelding')] };
}

// PDF en UBL uit één bericht met hetzelfde factuurnummer zijn één factuur: de UBL wordt ubl_document en levert de velden.
// Kan het nummer uit de PDF niet gelezen worden, dan koppelt een enkel paar (één PDF, één UBL) ook bij gelijk bedrag of als de
// UBL de PDF zelf bevat met dezelfde bestandsnaam.
function groepeerBericht(docs) {
  const ubls = docs.filter((d) => d.soort === 'ubl'), pdfs = docs.filter((d) => d.soort === 'pdf' || d.soort === 'scan');
  const gebruikt = new Set(), groepen = [];
  for (const u of ubls) {
    const nr = normNummer(u.ubl.nummer);
    let p = pdfs.find((x) => !gebruikt.has(x) && x.velden && nr && normNummer(x.velden.nummer) === nr);
    if (!p && ubls.length === 1 && pdfs.length === 1 && !gebruikt.has(pdfs[0])) {
      const x = pdfs[0];
      const zelfdeNaam = u.ubl.pdf_naam && x.naam && u.ubl.pdf_naam.toLowerCase() === String(x.naam).toLowerCase();
      const zelfdeBedrag = x.velden && x.velden.incl != null && x.velden.incl === u.ubl.incl;
      if ((!x.velden || !x.velden.nummer) && (zelfdeNaam || zelfdeBedrag)) p = x;
    }
    if (p) gebruikt.add(p);
    groepen.push({ pdf: p || null, ubl: u });
  }
  for (const p of pdfs) if (!gebruikt.has(p)) groepen.push({ pdf: p, ubl: null });
  return groepen;
}

// ───────────────────────────── stap 6: geen factuur ─────────────────────────────

const FACTUURWOORD = /\b(factuur|facturen|invoice|nota|creditnota|creditfactuur|credit\s?note|rekening\s?nummer\s+factuur)\b/i;
const GEEN_FACTUURWOORD = /\b(orderbevestiging|opdrachtbevestiging|bestelbevestiging|ontvangstbevestiging|pakbon|paklijst|leveringsbon|afleverbon|offerte|prijsopgave|order\s+confirmation|packing\s+slip|quotation|quote|nieuwsbrief|newsletter)\b/i;
// Zinnen als "dit is geen factuur" en "de factuur volgt" tellen niet als factuurwoord.
const NIET_FACTUUR_ZIN = /\b(?:is|dit\s+is|betreft)\s+geen\s+(?:factuur|nota|invoice)\b|\b(?:de|een|uw)\s+factuur\s+(?:volgt|ontvangt\s+u|wordt\s+(?:apart|later|na\s+\w+)\s+(?:verstuurd|gestuurd|toegezonden))|\bu\s+ontvangt\s+(?:de|een|uw)\s+factuur\b|\bnot\s+an\s+invoice\b|\binvoice\s+will\s+follow\b/gi;

function stapGeenFactuur(tekst, bericht, ctx) {
  const t = schoon(tekst || '');
  const register = ((ctx && ctx.geenFactuur) || []).find((r) => {
    const p = String(r.patroon || '').toLowerCase();
    if (!p) return false;
    if (r.leverancier_id && ctx.leverancier && ctx.leverancier.id !== r.leverancier_id) return false;
    return (bericht && String(bericht.onderwerp || '').toLowerCase().includes(p)) || t.toLowerCase().includes(p);
  });
  if (register) return { geen: true, besluiten: [besluit('geen_factuur', 'is_factuur', 0, 'regel', 'register geen factuur')] };
  const zonderZinnen = t.replace(NIET_FACTUUR_ZIN, ' ');
  const heeftWoord = FACTUURWOORD.test(zonderZinnen);
  const geenWoord = GEEN_FACTUURWOORD.exec(t);
  if (geenWoord && !heeftWoord) return { geen: true, besluiten: [besluit('geen_factuur', 'is_factuur', 0, 'regel', geenWoord[1].toLowerCase() + ' zonder factuurwoord')] };
  return { geen: false, besluiten: [besluit('geen_factuur', 'is_factuur', 1, 'regel', heeftWoord ? 'factuurwoord aanwezig' : 'geen kenmerk van een andere soort stuk')] };
}

// ───────────────────────────── leverancier ─────────────────────────────

function domeinVan(afzender) {
  const m = /<?([^\s<>@]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})>?\s*$/.exec(String(afzender || ''));
  return m ? m[2].toLowerCase() : null;
}
function weergaveNaam(afzender) {
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(String(afzender || ''));
  return m ? m[1].trim() : null;
}
function eigenKvks(ctx) { return new Set(((ctx && ctx.entiteiten) || []).map((e) => e.kvk).filter(Boolean)); }
function eigenIbans(ctx) {
  const m = new Map();
  for (const e of (ctx && ctx.entiteiten) || []) for (const i of e.ibans || []) m.set(ibanNorm(i), e.sleutel);
  return m;
}

// Naamverwantschap en verzamelrekeningnamen (wv1323, verhuisd uit facturen-validatie in wv1360 zodat kern en bankcontrole ze zelf kunnen gebruiken)
const NAAM_MIN = 3;
const VERZAMEL_RE = /derdengeld|\b(mollie|stripe|adyen|paypal|buckaroo|multisafepay|pay\.nl|payvision|worldline|klarna|sumup|tikkie|online payment platform|opp|ccv|ingenico|icepay|targetpay|sisow|paynl|mangopay|betaaldienst|payment ?services?)\b|\bvia\b/i;
function compactNaam(s) { return normNaam(s).replace(/ /g, ''); }
// Voorletters + achternaam ("M. den Uijl") tegen een voluit geschreven naam ("Marijke den Uijl", "Mattijs Volman Waarnemend Huisarts"): de
// rest na de voorletters (≥ 4 tekens) staat erin en de eerste letter klopt (gemeten 26-10: zo spellen bank en waarnemersfactuur dezelfde persoon).
function voorletterVerwant(kort, lang) {
  const w = normNaam(kort).split(' ').filter(Boolean);
  let i = 0;
  while (i < w.length - 1 && w[i].length === 1) i++;
  if (i === 0) return false;
  const rest = w.slice(i).join(''), l = compactNaam(lang);
  return rest.length >= 4 && l.indexOf(rest) > 0 && l[0] === w[0];
}
function naamVerwant(a, b) {
  const x = compactNaam(a), y = compactNaam(b);
  if (x.length < NAAM_MIN || y.length < NAAM_MIN) return false;
  return x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0 || voorletterVerwant(a, b) || voorletterVerwant(b, a);
}
// wv1360: een rekening uit de bankhistorie (bron bankhistorie, l.ibans_naamtoets) herkent alleen met een passende naam op de factuur;
// een nagebelde rekening (een mens belde voor precies deze leverancier) blijft zonder naam herkennen, zoals voorheen.
function ibanNaamPast(naam, l, iban) {
  if (!l) return false;
  if (!(l.ibans_naamtoets || []).map(ibanNorm).includes(iban)) return true;
  if (!naam) return false;
  return [l.naam].concat(l.namen || []).filter(Boolean).some((n) => normNaam(n) === normNaam(naam) || naamVerwant(naam, n));
}
function herkenLeverancier(velden, bericht, ctx) {
  const lijst = (ctx && ctx.leveranciers) || [];
  const eigen = eigenKvks(ctx);
  const kvks = (velden.leverancier_kvk ? [velden.leverancier_kvk] : []).concat(velden.kvks || []).filter((k) => !eigen.has(k));
  for (const k of kvks) { const l = lijst.find((x) => x.kvk === k); if (l) return { leverancier: l, via: 'kvk' }; }
  const btws = (velden.leverancier_btw ? [velden.leverancier_btw] : []).concat(velden.btwnrs || []);
  for (const b of btws) { const l = lijst.find((x) => x.btw && x.btw.toUpperCase() === b); if (l) return { leverancier: l, via: 'btw' }; }
  const dom = domeinVan(bericht && bericht.afzender);
  if (dom) { const l = lijst.find((x) => (x.domeinen || []).some((d) => dom === d.toLowerCase() || dom.endsWith('.' + d.toLowerCase()))); if (l) return { leverancier: l, via: 'domein' }; }
  // wv1360 (diffreview MOET 1): sinds elk al eens betaald rekeningnummer bekend is (ook van medewerkers en zelfstandigen), telt een bekend
  // IBAN alleen als de naam op de factuur bij die leverancier past (zijn naam of een naam waaronder we die rekening betaalden). Anders kon
  // een factuur met andermans naam en het rekeningnummer van een medewerker het nabellen omzeilen.
  const ibans = (velden.ibans_betaal || []).filter((i) => ibanMod97(i));
  for (const i of ibans) { const l = lijst.find((x) => (x.ibans || []).map(ibanNorm).includes(i)); if (l && ibanNaamPast(velden.leverancier_naam, l, i)) return { leverancier: l, via: 'iban' }; }
  const naam = velden.leverancier_naam ? normNaam(velden.leverancier_naam) : null;
  if (naam) { const l = lijst.find((x) => normNaam(x.naam) === naam); if (l) return { leverancier: l, via: 'naam' }; }
  return { leverancier: null, via: null };
}

// ───────────────────────────── stap 4: velden samenvoegen ─────────────────────────────

const VELDEN = ['soort', 'nummer', 'factuurdatum', 'vervaldatum', 'excl', 'btw', 'incl', 'valuta', 'iban', 'kenmerk'];
// UBL wint; lege velden mogen uit de PDF-regex; een modelkandidaat (v1: uit) vult alleen wat daarna nog leeg is.
function stapVelden(groep, ctx, opties) {
  const besluiten = [];
  const ubl = groep.ubl ? groep.ubl.ubl : null, pdf = groep.pdf && groep.pdf.velden ? groep.pdf.velden : null;
  const uit = { leverancier_naam: null, leverancier_kvk: null, leverancier_btw: null, kvks: [], btwnrs: [], ibans_betaal: [], ibans_klant: [], ibans_ongeldig: [] };
  const eigen = eigenIbans(ctx);
  for (const v of VELDEN) uit[v] = null;
  if (ubl) {
    for (const v of VELDEN) if (ubl[v] != null) { uit[v] = ubl[v]; besluiten.push(besluit('velden', v, ubl[v], 'regel', 'uit UBL')); }
    uit.leverancier_naam = ubl.leverancier.naam; uit.leverancier_kvk = ubl.leverancier.kvk; uit.leverancier_btw = ubl.leverancier.btw;
    uit.ubl_klant = ubl.klant;
    uit.betaalwijze_hint = ubl.betaalwijze_hint;
    for (const i of ubl.ibans) (ibanMod97(i) ? uit.ibans_betaal : uit.ibans_ongeldig).push(i);
    uit.ibans_klant.push(...ubl.klant_ibans);
  }
  if (pdf) {
    for (const v of VELDEN) {
      if (v === 'iban' || uit[v] != null || pdf[v] == null) continue;
      if (v === 'valuta' && ubl) continue;
      if (v === 'soort' && ubl) continue;
      uit[v] = pdf[v]; besluiten.push(besluit('velden', v, pdf[v], 'regel', ubl ? 'uit PDF (ontbrak in UBL)' : 'uit PDF-tekst'));
    }
    uit.kvks = pdf.kvks; uit.btwnrs = pdf.btwnrs;
    for (const i of pdf.ibans) {
      if (!i.geldig) { if (!uit.ibans_ongeldig.includes(i.iban)) uit.ibans_ongeldig.push(i.iban); continue; }
      // Klantrekening alleen als het een eigen rekening is; een vreemd IBAN in incassotaal ("wij stoppen met incasso, maak over op …")
      // is juist een betaal-IBAN en moet door de IBAN-poort (diffreview wv797 #3).
      if (eigen.has(i.iban) && (i.klant || uit.ibans_klant.includes(i.iban))) { if (!uit.ibans_klant.includes(i.iban)) uit.ibans_klant.push(i.iban); continue; }
      if (!uit.ibans_betaal.includes(i.iban)) uit.ibans_betaal.push(i.iban);
    }
  }
  // Het betaal-IBAN uit de PDF kiest kiesBetaalIban zodra de leverancier bekend is (beslisBericht).
  if (!uit.leverancier_naam && opties && opties.bericht) uit.leverancier_naam = weergaveNaam(opties.bericht.afzender);
  const mk = opties && opties.model_kandidaat;
  if (mk && !(opties && opties.patientkenmerk)) {
    const kaart = { nummer: 'factuurnummer', factuurdatum: 'factuurdatum', vervaldatum: 'vervaldatum', kenmerk: 'kenmerk', iban: 'iban', valuta: 'valuta' };
    for (const v of Object.keys(kaart)) if (uit[v] == null && mk[kaart[v]] != null) { uit[v] = v === 'iban' ? ibanNorm(mk.iban) : String(mk[kaart[v]]); besluiten.push(besluit('velden', v, uit[v], 'model', 'modelkandidaat (deterministisch leeg)')); }
    for (const [v, k] of [['excl', 'bedrag_excl'], ['btw', 'btw'], ['incl', 'bedrag_incl']]) {
      if (uit[v] == null && mk[k] != null) { const c = decimaalNaarCenten(String(mk[k])); if (c != null) { uit[v] = c; besluiten.push(besluit('velden', v, c, 'model', 'modelkandidaat (deterministisch leeg)')); } }
    }
    if (!uit.leverancier_naam && mk.leverancier_naam) uit.leverancier_naam = String(mk.leverancier_naam);
  }
  if (!uit.soort) uit.soort = 'factuur';
  if (!uit.valuta) uit.valuta = 'EUR';
  return { velden: uit, besluiten };
}

// Betaal-IBAN: een vreemd (niet-eigen) IBAN dat de leverancier nog niet kent gaat voor, want dat moet nagebeld worden ("rekeningnummer
// gewijzigd, maak over naar …"; diffreview wv797 #3); dan een bekend vreemd IBAN; dan een eigen rekening (intern of fout, stap 8); dan een
// ongeldig gelabeld IBAN (stap 8 meldt de mod-97-fout).
function kiesBetaalIban(velden, leverancier, ctx) {
  const eigen = eigenIbans(ctx), bekend = new Set(((leverancier && leverancier.ibans) || []).map(ibanNorm));
  const vreemd = (velden.ibans_betaal || []).filter((i) => !eigen.has(i));
  return vreemd.find((i) => !bekend.has(i)) || vreemd[0] || (velden.ibans_betaal || [])[0] || (velden.ibans_ongeldig || [])[0] || null;
}

// ───────────────────────────── stap 5: entiteit (stemmen) ─────────────────────────────

const GEWICHT = { anker: 3, kvk: 4, naam: 2, ubl_klant_kvk: 5, ubl_klant_naam: 3, klant_iban: 3, leverancier: 2, iban_historie: 1, model: 1 };
function bevat(tekstNorm, frase) {
  const f = zonderAccenten(frase).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!f) return false;
  const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + esc + '($|[^a-z0-9])').test(tekstNorm);
}
function entNaam(ctx, sleutel) { const e = ((ctx && ctx.entiteiten) || []).find((x) => x.sleutel === sleutel); return e ? e.naam_kort || e.naam : sleutel; }

function stapEntiteit(velden, tekst, ctx, opties) {
  const ents = ((ctx && ctx.entiteiten) || []).filter((e) => e.actief !== false);
  const stemmen = [];   // { entiteit, soort: document|leverancier|betaling|model, bron, gewicht, reden }
  const tn = zonderAccenten(schoon(tekst || '')).toLowerCase().replace(/\s+/g, ' ');
  const stem = (entiteit, soort, bron, gewicht, reden) => {
    if (!ents.some((e) => e.sleutel === entiteit)) return;
    if (stemmen.some((s) => s.entiteit === entiteit && s.reden === reden)) return;
    stemmen.push({ entiteit, soort, bron, gewicht, reden });
  };
  for (const a of (ctx && ctx.tekstankers) || []) if (bevat(tn, a.tekst)) stem(a.entiteit, 'document', 'anker', GEWICHT.anker, 'Tekstanker voor ' + entNaam(ctx, a.entiteit) + ' op de factuur');
  for (const e of ents) {
    if (e.kvk && (velden.kvks || []).includes(e.kvk)) stem(e.sleutel, 'document', 'regel', GEWICHT.kvk, 'KvK van ' + entNaam(ctx, e.sleutel) + ' op de factuur');
    const namen = [{ tekst: e.naam }].concat((e.aliassen || []).map((a) => (typeof a === 'string' ? { tekst: a } : a)));
    for (const n of namen) if (n.tekst && bevat(tn, n.tekst)) { stem(e.sleutel, 'document', 'regel', n.gewicht != null ? n.gewicht : GEWICHT.naam, 'Naam ' + entNaam(ctx, e.sleutel) + ' op de factuur'); break; }
  }
  const uk = velden.ubl_klant;
  if (uk) {
    const e1 = uk.kvk && ents.find((e) => e.kvk === uk.kvk);
    if (e1) stem(e1.sleutel, 'document', 'regel', GEWICHT.ubl_klant_kvk, 'KvK van ' + entNaam(ctx, e1.sleutel) + ' als klant in de UBL');
    else if (uk.naam) {
      const n = zonderAccenten(uk.naam).toLowerCase();
      const e2 = ents.find((e) => [e.naam].concat((e.aliassen || []).map((a) => (typeof a === 'string' ? a : a.tekst))).some((x) => x && (n.includes(zonderAccenten(x).toLowerCase()))));
      if (e2) stem(e2.sleutel, 'document', 'regel', GEWICHT.ubl_klant_naam, 'Naam ' + entNaam(ctx, e2.sleutel) + ' als klant in de UBL');
    }
  }
  const eigen = eigenIbans(ctx);
  for (const i of velden.ibans_klant || []) if (eigen.has(i)) stem(eigen.get(i), 'betaling', 'regel', GEWICHT.klant_iban, 'Rekening van ' + entNaam(ctx, eigen.get(i)) + ' staat op de factuur als af te schrijven rekening');
  const lev = opties && opties.leverancier;
  if (lev && lev.standaard_entiteit) stem(lev.standaard_entiteit, 'leverancier', 'leverancier', GEWICHT.leverancier, 'Leverancier factureert eerder aan ' + entNaam(ctx, lev.standaard_entiteit));
  const hist = velden.iban && ctx && ctx.ibanHistorie && ctx.ibanHistorie[velden.iban];
  if (hist) {
    const top = Object.keys(hist).sort((a, b) => hist[b] - hist[a])[0];
    if (top && hist[top] >= 2) stem(top, 'betaling', 'bank', GEWICHT.iban_historie, 'Dit IBAN werd eerder betaald door ' + entNaam(ctx, top));
  }
  const mk = opties && opties.model_kandidaat;
  if (mk && mk.entiteit_hint && !(opties && opties.patientkenmerk)) stem(mk.entiteit_hint, 'model', 'model', GEWICHT.model, 'Modelkandidaat noemt ' + entNaam(ctx, mk.entiteit_hint));
  const score = {};
  for (const s of stemmen) score[s.entiteit] = (score[s.entiteit] || 0) + s.gewicht;
  const volgorde = Object.keys(score).sort((a, b) => score[b] - score[a]);
  const besluiten = stemmen.map((s) => besluit('entiteit', 'entiteit', s.entiteit, s.bron, s.reden + ' (' + s.gewicht + ')'));
  const redenen = [];
  let entiteit = null;
  if (!volgorde.length) redenen.push('Geen aanwijzing voor de entiteit: kies hem met de hand');
  else if (volgorde.length > 1 && score[volgorde[0]] === score[volgorde[1]]) redenen.push('Stemmen staken tussen ' + entNaam(ctx, volgorde[0]) + ' en ' + entNaam(ctx, volgorde[1]) + ': kies met de hand');
  else entiteit = volgorde[0];
  if (entiteit) {
    for (const s of stemmen.filter((x) => x.entiteit === entiteit)) redenen.push(s.reden);
    if (volgorde.length > 1) redenen.push('Let op: ook stemmen voor ' + volgorde.slice(1).map((k) => entNaam(ctx, k)).join(', '));
  }
  besluiten.push(besluit('entiteit', 'voorstel', entiteit, 'regel', volgorde.map((k) => k + '=' + score[k]).join(' · ') || 'geen stemmen'));
  return { entiteit, stemmen, score, redenen, besluiten };
}

// ───────────────────────────── stap 7: betaalwijze ─────────────────────────────

const BETAALWIJZEN = ['zelf', 'incasso', 'betaald', 'onbekend'];
// Tekstpatronen (op tekst zonder accenten). Alleen de STELLENDE vorm telt: staat in hetzelfde zinsdeel ervoor een voorwaarde of
// mogelijkheid ("wanneer … is betaald", "kan worden voldaan via iDEAL", "liever automatische incasso?"), of eindigt de zin op een
// vraagteken, dan telt de treffer niet (diffreview wv797 #2 en #13).
const TEKST_BETAALD = [
  /\b(?:is|werd|zijn|werden)\s+(?:reeds\s+|al\s+)?(?:volledig\s+)?(?:voldaan|betaald)\b/i,
  /\b(?:reeds|al)\s+(?:voldaan|betaald)\b/i,
  /\b(?:voldaan|betaald)\s+(?:op|d\.d\.)\s+\d/i,
  /\b(?:voldaan|betaald)\s+(?:via|met|per)\s+(?:ideal|creditcard|credit\s+card|paypal|pin|bancontact|apple\s+pay)\b/i,
  /\b(?:te\s+betalen|nog\s+te\s+betalen|openstaand(?:\s+bedrag)?|amount\s+due|balance\s+due)\s?:?\s?(?:€|eur)?\s?0[,.]00\b/i,
  /\bpaid\s+in\s+full\b|\bpayment\s+received\b/i,
];
const TEKST_INCASSO = [
  /\bautomatisch\s+(?:ge)?incasseerd\b/i,
  /\b(?:wordt|worden|zal|zullen)\b[^.\n?]{0,60}\b(?:geincasseerd|afgeschreven)\b/i,
  /\bbetaal(?:wijze|methode)\s?:?\s?(?:automatische\s+|sepa[- ])?incasso\b/i,
  /\b(?:via|per|door\s+middel\s+van)\s+(?:automatische\s+|sepa[- ])?incasso\b/i,
  /\b(?:will\s+be|is)\s+(?:collected|debited)\b|\bdirect\s+debit\b/i,
];
const TEKST_INCASSO_ZWAK = [/\b(?:automatische|sepa)[- ]incasso\b|\bmachtiging\b/i];
const TEKST_ZELF = [
  /\b(?:gelieve|verzoeken?\s+(?:u|wij\s+u))\b[^\n]{0,80}\b(?:over\s+te\s+maken|te\s+voldoen|te\s+betalen)\b/i,
  /\bovermaken\s+(?:op|naar)\b|\bovermaken\s+o\.v\.v\./i,
  /\bte\s+(?:betalen|voldoen)\s+(?:voor|binnen)\b/i,
  /\bbinnen\s+\d+\s+dagen\b[^\n]{0,40}\b(?:over\s+te\s+maken|te\s+voldoen|te\s+betalen|betalen)\b/i,
  /\bplease\s+(?:pay|transfer|remit)\b/i,
];
const VOORWAARDE_BETAALD = /\b(wanneer|indien|als|zodra|mocht|niet|tenzij|nadat|voordat|kan|kunt|kunnen|worden|wordt|te|graag|liever|wilt|wil|die|vorige|eerdere|eerder|if|unless|when|can)\b/i;
// "Reeds betaald: € 0,00" is juist níét betaald (diffreview wv797 natoets #2).
const NA_NUL = /^\s?:?\s?(?:€|eur)?\s?0[,.]00\b/i;
// Staat er een openstaand bedrag boven nul, dan is de factuur niet al betaald.
const OPENSTAAND = /\b(?:nog\s+te\s+betalen|openstaand(?:\s+bedrag)?|amount\s+due|balance\s+due)\s?:?\s?(?:€|eur)?\s?(\d[\d.,]*\d)/gi;
const VOORWAARDE_ANDER = /\b(wanneer|indien|als|zodra|mocht|niet|tenzij|liever|wilt|wil|kunt|kunnen|kan|aanvragen|if|unless|can)\b/i;
function stellend(t, patronen, voorwaarde, nietNa) {
  for (const re of patronen) {
    const g = new RegExp(re.source, 'gi'); let m;
    while ((m = g.exec(t))) {
      const begin = Math.max(t.lastIndexOf('.', m.index - 1), t.lastIndexOf('\n', m.index - 1), t.lastIndexOf('?', m.index - 1), t.lastIndexOf('!', m.index - 1), t.lastIndexOf(';', m.index - 1), m.index - 80);
      const eindRe = /[.?!\n;]/g; eindRe.lastIndex = m.index + m[0].length;
      const eind = eindRe.exec(t);
      if (nietNa && nietNa.test(t.slice(m.index + m[0].length, m.index + m[0].length + 20))) continue;
      if (!voorwaarde.test(t.slice(begin + 1, m.index)) && !/\b(niet|niets|nooit|geen|not|no|never)\b/i.test(m[0]) && !(eind && eind[0] === '?')) return true;
    }
  }
  return false;
}

function stapBetaalwijze(tekst, velden, ctx, opties) {
  const t = zonderAccenten(schoon(tekst || ''));
  const lev = opties && opties.leverancier;
  let wijze = null, bron = null, reden = null;
  if (velden.betaalwijze_hint) { wijze = velden.betaalwijze_hint; bron = 'regel'; reden = 'betaalwijze uit de UBL'; }
  else if (t) {
    let open = false, om; OPENSTAAND.lastIndex = 0;
    while ((om = OPENSTAAND.exec(t))) { const c = bedragNaarCenten(om[1]); if (c != null && c > 0) open = true; }
    const B = !open && stellend(t, TEKST_BETAALD, VOORWAARDE_BETAALD, NA_NUL), I = stellend(t, TEKST_INCASSO, VOORWAARDE_ANDER), Z = stellend(t, TEKST_ZELF, VOORWAARDE_ANDER);
    const kandidaten = [B && 'betaald', I && 'incasso', Z && 'zelf'].filter(Boolean);
    if (kandidaten.length > 1) {
      // Tegenstrijdige tekst: de leveranciersstandaard beslist als die een van de kandidaten is, anders kiest een mens.
      if (lev && kandidaten.includes(lev.standaard_betaalwijze)) { wijze = lev.standaard_betaalwijze; bron = 'leverancier'; reden = 'tekst tegenstrijdig (' + kandidaten.join('/') + '); standaard van de leverancier'; }
      else { wijze = 'onbekend'; bron = 'regel'; reden = 'tekst tegenstrijdig (' + kandidaten.join('/') + '): kies met de hand'; }
    } else if (B) { wijze = 'betaald'; bron = 'regel'; reden = 'tekst: al betaald'; }
    else if (I) { wijze = 'incasso'; bron = 'regel'; reden = 'tekst: wordt geïncasseerd'; }
    else if (Z) { wijze = 'zelf'; bron = 'regel'; reden = 'tekst: zelf overmaken'; }
  }
  if (!wijze && lev && lev.standaard_betaalwijze && lev.standaard_betaalwijze !== 'onbekend') { wijze = lev.standaard_betaalwijze; bron = 'leverancier'; reden = 'standaard van de leverancier'; }
  // Een losse vermelding van incasso of een machtiging telt pas na de leveranciersstandaard (natoets #3).
  if (!wijze && t && !velden.betaalwijze_hint && stellend(t, TEKST_INCASSO_ZWAK, VOORWAARDE_ANDER)) { wijze = 'incasso'; bron = 'regel'; reden = 'tekst noemt incasso'; }
  if (!wijze && lev && lev.bankhistorie) {
    const h = lev.bankhistorie, top = ['incasso', 'zelf'].sort((a, b) => (h[b] || 0) - (h[a] || 0))[0];
    if ((h[top] || 0) >= 2 && (h[top] || 0) > (h[top === 'incasso' ? 'zelf' : 'incasso'] || 0)) { wijze = top; bron = 'bank'; reden = 'bankhistorie van de leverancier'; }
  }
  if (!wijze) { wijze = 'onbekend'; bron = 'regel'; reden = 'geen aanwijzing: kies met de hand'; }
  if (!BETAALWIJZEN.includes(wijze)) throw new KernFout('betaalwijze', 'onbekende betaalwijze');
  return { betaalwijze: wijze, reden, besluiten: [besluit('betaalwijze', 'betaalwijze', wijze, bron, reden)] };
}

// ───────────────────────────── stap 8: validators + IBAN-poort ─────────────────────────────

function mediaan(lijst) {
  const a = (lijst || []).filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const h = a.length >> 1;
  return a.length % 2 ? a[h] : Math.round((a[h - 1] + a[h]) / 2);
}

// Elke controle: { naam, ok, ernst: 'info'|'melding'|'fout', reden }. 'fout' bij een IBAN blokkeert Bevestigen als je zelf betaalt.
function valideer(f, ctx, opties) {
  const c = [];
  const voeg = (naam, ok, ernst, reden) => c.push({ naam, ok, ernst: ok ? 'info' : ernst, reden });
  if (f.excl != null && f.btw != null && f.incl != null) voeg('bedragen', Math.abs(f.excl + f.btw - f.incl) <= 2, 'melding', Math.abs(f.excl + f.btw - f.incl) <= 2 ? 'excl + btw = incl' : 'excl + btw wijkt ' + Math.abs(f.excl + f.btw - f.incl) + ' cent af van incl');
  else voeg('bedragen', false, 'melding', f.incl != null ? 'excl of btw niet gevonden: totaal niet na te rekenen' : 'geen totaalbedrag gevonden');
  // Een incl dat kleiner is dan excl of btw is bijna altijd een verkeerd gelezen regel (diffreview wv797 #5).
  if (f.incl != null && ((f.excl != null && Math.abs(f.incl) < Math.abs(f.excl)) || (f.btw != null && Math.abs(f.btw) > Math.abs(f.incl)))) voeg('bedrag_volgorde', false, 'melding', 'totaal kleiner dan excl of btw: bedragen nalopen');
  if (f.incl != null && f.soort === 'creditnota') voeg('teken', f.incl <= 0, 'melding', f.incl <= 0 ? 'creditnota negatief' : 'creditnota met positief bedrag');
  else if (f.incl != null) voeg('teken', f.incl >= 0, 'melding', f.incl >= 0 ? 'factuur positief' : 'factuur met negatief bedrag');
  const vandaag = ctx && isIsoDatum(ctx.vandaag) ? ctx.vandaag : null;
  if (!f.factuurdatum) voeg('datums', false, 'melding', 'geen factuurdatum');
  else {
    let ok = true; const r = [];
    if (vandaag && dagenTussen(vandaag, f.factuurdatum) > 31) { ok = false; r.push('factuurdatum ligt meer dan een maand in de toekomst'); }
    if (vandaag && dagenTussen(f.factuurdatum, vandaag) > 400) { ok = false; r.push('factuurdatum ouder dan 400 dagen'); }
    if (f.vervaldatum && dagenTussen(f.factuurdatum, f.vervaldatum) < 0) { ok = false; r.push('vervaldatum vóór factuurdatum'); }
    if (f.vervaldatum && dagenTussen(f.factuurdatum, f.vervaldatum) > 180) { ok = false; r.push('vervaldatum meer dan 180 dagen na factuurdatum'); }
    voeg('datums', ok, 'melding', ok ? 'datums logisch' : r.join('; '));
  }
  const lev = opties && opties.leverancier;
  const med = lev && lev.mediaan && f.entiteit ? lev.mediaan[f.entiteit] : null;
  if (med && f.incl != null) voeg('drempel', Math.abs(f.incl) <= 3 * Math.abs(med), 'melding', Math.abs(f.incl) <= 3 * Math.abs(med) ? 'bedrag ≤ 3× mediaan van deze leverancier' : 'bedrag ruim boven 3× de mediaan van deze leverancier');
  const drempel = ctx && Number.isSafeInteger(ctx.drempelCenten) ? ctx.drempelCenten : 250000;
  if (f.incl != null && Math.abs(f.incl) > drempel) voeg('drempel_vast', false, 'melding', 'bedrag boven € ' + (drempel / 100).toLocaleString('nl-NL') + ': extra opletten');
  voeg('valuta', f.valuta === 'EUR', 'melding', f.valuta === 'EUR' ? 'euro' : 'valuta ' + f.valuta + ': bedrag en bankmatch met de hand controleren');
  let intern = null;
  if (f.iban) {
    const geldig = ibanMod97(f.iban);
    voeg('iban_mod97', geldig, 'fout', geldig ? 'IBAN geldig (mod-97)' : 'IBAN haalt de mod-97-controle niet');
    const eigen = eigenIbans(ctx);
    if (geldig && eigen.has(f.iban)) {
      const van = eigen.get(f.iban);
      if (f.entiteit && van === f.entiteit) voeg('iban_eigen', false, 'fout', 'IBAN is een eigen rekening van ' + entNaam(ctx, van) + ': betalen aan jezelf');
      else { intern = van; voeg('iban_eigen', true, 'info', 'interne factuur: betaling aan ' + entNaam(ctx, van)); }
    }
  } else if (f.betaalwijze === 'zelf') voeg('iban_mod97', false, 'melding', 'zelf betalen, maar geen IBAN gevonden');
  return { controles: c, intern };
}

// Nieuw of afwijkend IBAN → iban_nieuw; Bevestigen geblokkeerd tot Nagebeld. Getoetst wordt ELK geldig vreemd betaal-IBAN in het stuk,
// niet alleen het gekozen (een tweede IBAN onderaan is de klassieke fraudezin). Een eigen rekening (intern) is bekend. Wijzigt een mens
// het IBAN in Beoordelen, dan roept F2 ibanPoort opnieuw aan.
function ibanPoort(f, leverancier, ctx) {
  const eigen = eigenIbans(ctx), bekend = new Set(((leverancier && leverancier.ibans) || []).map(ibanNorm));
  const alle = [...new Set([f.iban].concat(f.ibans_betaal || []).map(ibanNorm).filter(Boolean))];
  const vreemd = alle.filter((i) => ibanMod97(i) && !eigen.has(i));
  const onbekend = vreemd.filter((i) => !bekend.has(i));
  if (!onbekend.length) return { iban_nieuw: false, onbekend, reden: !f.iban ? 'geen IBAN' : !ibanMod97(f.iban) ? 'IBAN ongeldig (zie controles)' : eigen.has(ibanNorm(f.iban)) ? 'eigen rekening' : 'IBAN bekend bij deze leverancier' };
  const meer = vreemd.length > 1 ? ' (de factuur noemt meer dan één IBAN)' : '';
  return { iban_nieuw: true, onbekend, reden: (leverancier ? 'Nieuw IBAN voor een bekende leverancier: eerst nabellen' : 'Nieuwe leverancier met een nog niet nagebeld IBAN: eerst nabellen') + meer };
}
// Dekt het nabellen de IBAN's die nu op de factuur staan? Nodig = elk onbekend IBAN plus het gekozen IBAN; met `poort` ({ leverancier, ctx })
// rekent hij de IBAN-poort zelf opnieuw uit in plaats van op opgeslagen vlaggen te vertrouwen (diffreview wv797 #10 en natoets #6).
function ibanGeborgd(f, poort) {
  const vers = poort ? ibanPoort(f, poort.leverancier || null, poort.ctx) : null;
  if (!(vers ? vers.iban_nieuw : f.iban_nieuw)) return true;
  const gedekt = new Set(f.nagebeld_ibans || []);
  const nodig = [...new Set((vers ? vers.onbekend : f.ibans_onbekend || []).concat(f.iban ? [ibanNorm(f.iban)] : []))];
  return !!f.nagebeld_op && nodig.every((i) => gedekt.has(i));
}

// Wat houdt Bevestigen tegen (zonder de status)? Gedeeld door magBevestigen, de statusovergang en maakOpdracht (diffreview #10).
// Geef `poort` ({ leverancier, ctx }) mee waar de leverancier bekend is (F2 doet dat altijd): dan telt de verse IBAN-poort.
function bevestigBlokkades(f, poort) {
  const r = [];
  if (!f.entiteit) r.push('geen entiteit');
  if (!f.betaalwijze || f.betaalwijze === 'onbekend') r.push('betaalwijze onbekend');
  if (!ibanGeborgd(f, poort)) r.push('nieuw IBAN: eerst nabellen');
  if (f.betaalwijze === 'zelf') {
    if (!f.iban) r.push('zelf betalen zonder IBAN');
    else if (!ibanMod97(f.iban) || (f.controles || []).some((c) => !c.ok && c.ernst === 'fout' && /^iban/.test(c.naam))) r.push('IBAN-fout bij zelf betalen');
  }
  return r;
}
// Mag deze factuur nu bevestigd worden (status, entiteit, betaalwijze, IBAN-poort, IBAN bij zelf betalen)?
function magBevestigen(f, poort) {
  const r = f.status !== 'te_beoordelen' ? ['status is ' + f.status] : [];
  r.push(...bevestigBlokkades(f, poort));
  return { ok: r.length === 0, redenen: r };
}

// Nagebeld: wie/wanneer vastleggen; het IBAN gaat in leverancier_iban. Geeft de wijzigingen terug (schrijven doet facturen-db.js).
function nagebeld(f, wie, wanneer) {
  if (!f.iban_nieuw) throw new KernFout('niet_nodig', 'factuur heeft geen nieuw IBAN');
  if (!wie || !wanneer) throw new KernFout('wie_wanneer', 'nagebeld vraagt wie en wanneer');
  const ibans = [...new Set((f.ibans_onbekend || []).concat(f.iban ? [ibanNorm(f.iban)] : []))];
  return {
    factuur: { nagebeld_door: wie, nagebeld_op: wanneer, nagebeld_ibans: ibans },
    leverancier_iban: ibans.map((iban) => ({ leverancier_id: f.leverancier_id || null, iban, toegevoegd_door: wie, toegevoegd_op: wanneer })),
    besluit: besluit('iban', 'nagebeld', ibans.join(' '), 'mens', 'IBAN nagebeld en goedgekeurd'),
  };
}

// ───────────────────────────── het besliskader (§ 4.5) ─────────────────────────────

// invoer: { bericht: {message_id, afzender, onderwerp} | null, documenten: [{ sha256, naam, mime, tekst?, tekstlaag?, ubl_xml?,
//           patientkenmerk_koerier? }], model_kandidaat? }
// ctx:    { vandaag, entiteiten, leveranciers, tekstankers, geenFactuur, bekendeSha256, bestaandeFacturen, ibanHistorie }
// uit:    { documenten: [{ sha256, uitkomst, factuur }], facturen: [ … ], signalen: [ … ] } — zonder tekst.
function beslisBericht(invoer, ctx) {
  ctx = ctx || {};
  const bericht = invoer.bericht || null;
  const docs = [], docUit = [], signalen = [], facturen = [];
  for (const d of invoer.documenten || []) {
    if (!/^[0-9a-f]{64}$/.test(String(d.sha256 || ''))) throw new KernFout('sha256', 'document zonder geldige sha256');
    const db = stapDubbelBestand(d.sha256, ctx);
    if (db.dubbel) { docUit.push({ sha256: d.sha256, uitkomst: 'dubbel', reden: 'zelfde bestand al bekend', besluiten: db.besluiten }); signalen.push({ soort: 'dubbele_factuur', sha256: d.sha256, zelfde_bestand: true }); continue; }
    const s = stapSoort(d);
    const doc = { sha256: d.sha256, naam: d.naam || null, soort: s.soort, ubl: s.ubl || null, tekst: s.soort === 'pdf' ? d.tekst : null, koerier: !!d.patientkenmerk_koerier, besluiten: db.besluiten.concat(s.besluiten) };
    if (s.soort === 'pdf') doc.velden = leesPdfTekst(d.tekst);
    if (s.soort === 'overig') { docUit.push({ sha256: d.sha256, uitkomst: 'geen_factuur', reden: s.reden, besluiten: doc.besluiten }); continue; }
    docs.push(doc);
  }
  for (const g of groepeerBericht(docs)) {
    const hoofd = g.pdf || g.ubl;
    const teksten = [g.pdf && g.pdf.tekst, g.ubl && g.ubl.ubl._tekst].filter(Boolean);
    const tekst = teksten.join('\n');
    const besluiten = [].concat(g.pdf ? g.pdf.besluiten : [], g.ubl ? g.ubl.besluiten : []);
    const redenen = [];
    const pk = stapPatientkenmerk(teksten, (g.pdf && g.pdf.koerier) || (g.ubl && g.ubl.koerier));
    besluiten.push(...pk.besluiten);
    if (pk.kenmerk) redenen.push('Kenmerk van patiëntgegevens: alleen de eigenaar ziet deze factuur, geen taalmodel');
    const scan = !!(g.pdf && g.pdf.soort === 'scan' && !g.ubl);
    if (scan) redenen.push('Scan zonder tekstlaag: velden met de hand invullen');
    const sv = stapVelden(g, ctx, { bericht, model_kandidaat: invoer.model_kandidaat, patientkenmerk: pk.kenmerk });
    const v = sv.velden; besluiten.push(...sv.besluiten);
    if (g.pdf && g.ubl) redenen.push('PDF en UBL uit hetzelfde bericht: één factuur, velden uit de UBL');
    const hl = herkenLeverancier(v, bericht, ctx);
    const lev = hl.leverancier;
    besluiten.push(besluit('leverancier', 'leverancier', lev ? lev.id : null, lev ? 'leverancier' : 'regel', lev ? 'herkend via ' + hl.via : 'onbekende leverancier'));
    if (v.iban == null) { v.iban = kiesBetaalIban(v, lev, ctx); if (v.iban) besluiten.push(besluit('velden', 'iban', v.iban, 'regel', g.ubl ? 'uit PDF (ontbrak in UBL)' : 'uit PDF-tekst')); }
    const basis = {
      document: hoofd.sha256, ubl_document: g.pdf && g.ubl ? g.ubl.sha256 : null,
      soort: v.soort, leverancier_id: lev ? lev.id : null, leverancier_naam: lev ? lev.naam : v.leverancier_naam, leverancier_kvk: lev ? lev.kvk || v.leverancier_kvk : v.leverancier_kvk,
      nummer: v.nummer, factuurdatum: v.factuurdatum, vervaldatum: v.vervaldatum, excl: v.excl, btw: v.btw, incl: v.incl, valuta: v.valuta,
      iban: v.iban, ibans_betaal: v.ibans_betaal, kenmerk: v.kenmerk, patientkenmerk: pk.kenmerk, patientkenmerk_soorten: pk.soorten, scan, alleen_eigenaar: pk.kenmerk,
    };
    const di = stapDubbelInhoud(basis, ctx);
    besluiten.push(...di.besluiten);
    const se = stapEntiteit(v, scan ? '' : tekst, ctx, { leverancier: lev, model_kandidaat: invoer.model_kandidaat, patientkenmerk: pk.kenmerk });
    besluiten.push(...se.besluiten);
    let status = 'te_beoordelen';
    if (di.dubbel) { status = 'dubbel'; redenen.unshift('Zelfde leverancier, nummer en bedrag als een bestaande factuur'); signalen.push({ soort: 'dubbele_factuur', factuur_document: hoofd.sha256, van: di.van }); }
    if (status === 'te_beoordelen' && !scan && !g.ubl) {
      const gf = stapGeenFactuur(tekst, bericht, Object.assign({}, ctx, { leverancier: lev }));
      besluiten.push(...gf.besluiten);
      if (gf.geen) { status = 'geen_factuur'; redenen.unshift('Geen factuur: ' + gf.besluiten[0].toelichting); }
    }
    const sb = stapBetaalwijze(scan ? '' : tekst, v, ctx, { leverancier: lev });
    besluiten.push(...sb.besluiten);
    const f = Object.assign(basis, { entiteit: se.entiteit, betaalwijze: sb.betaalwijze, status });
    const va = valideer(f, ctx, { leverancier: lev });
    const ip = ibanPoort(f, lev, ctx);
    f.intern = va.intern; f.iban_nieuw = ip.iban_nieuw; f.ibans_onbekend = ip.onbekend; f.controles = va.controles;
    besluiten.push(besluit('validatie', 'iban_nieuw', ip.iban_nieuw ? 1 : 0, 'regel', ip.reden));
    for (const c of va.controles) besluiten.push(besluit('validatie', c.naam, c.ok ? 1 : 0, 'regel', c.reden));
    if (ip.iban_nieuw) redenen.push(ip.reden);
    if (va.intern) redenen.push('Interne factuur: betaling aan ' + entNaam(ctx, va.intern));
    redenen.push(...se.redenen);
    if (sb.betaalwijze !== 'onbekend') redenen.push('Betaalwijze ' + sb.betaalwijze + ' (' + sb.reden + ')');
    for (const c of va.controles) if (!c.ok) redenen.push(c.reden);
    // Stap 9: in v1 komt elke factuur in Beoordelen; niets gaat vanzelf door.
    f.redenen = redenen;
    f.geslaagd = va.controles.filter((c) => c.ok).map((c) => c.naam);
    f.besluiten = besluiten;
    f.bevestigen = magBevestigen(f, { leverancier: lev, ctx });
    facturen.push(f);
    for (const d of [g.pdf, g.ubl].filter(Boolean)) docUit.push({ sha256: d.sha256, uitkomst: status, factuur: hoofd.sha256, rol: d === hoofd ? 'document' : 'ubl_document' });
  }
  return { documenten: docUit, facturen, signalen };
}

// ───────────────────────────── leren uit een bevestiging ─────────────────────────────

// Wijzigt een mens bij Bevestigen de entiteit of betaalwijze, dan wordt dat de nieuwe standaard van de leverancier. Heeft de
// leverancier nog geen standaard, dan legt de eerste bevestiging hem vast.
function leerUitBevestiging(voorstel, bevestigd, leverancier) {
  const wijzigingen = [], besluiten = [];
  if (!leverancier) return { wijzigingen, besluiten, melding: null };
  for (const [veld, std] of [['entiteit', 'standaard_entiteit'], ['betaalwijze', 'standaard_betaalwijze']]) {
    const nieuw = bevestigd[veld];
    if (nieuw == null || (veld === 'betaalwijze' && nieuw === 'onbekend')) continue;
    const gewijzigd = voorstel[veld] !== nieuw;
    if (gewijzigd || leverancier[std] == null) {
      if (leverancier[std] === nieuw) continue;
      wijzigingen.push({ veld: std, van: leverancier[std] == null ? null : leverancier[std], naar: nieuw, reden: gewijzigd ? 'aangepast bij bevestigen' : 'eerste bevestiging' });
      besluiten.push(besluit('leren', std, nieuw, 'mens', gewijzigd ? 'voorstel ' + (voorstel[veld] || '—') + ' aangepast naar ' + nieuw : 'eerste bevestiging'));
    }
  }
  const aangepast = wijzigingen.some((w) => w.reden === 'aangepast bij bevestigen');
  return { wijzigingen, besluiten, melding: aangepast ? 'Aangepast — wordt onthouden voor ' + leverancier.naam : null };
}

// ───────────────────────────── status, betaalspoor, opdracht ─────────────────────────────

const STATUSSEN = ['te_beoordelen', 'geen_factuur', 'dubbel', 'in_wachtrij', 'prive_archief', 'wordt_verstuurd', 'concept_klaar', 'verstuurd', 'verzending_mislukt'];
const GEBEURTENISSEN = ['aangeboden_factuur', 'aangeboden_geen_factuur', 'aangeboden_dubbel', 'bevestigen', 'geen_factuur', 'terugdraaien', 'koerier_haalt_op', 'gelukt', 'verzonden_gezien', 'mislukt_definitief', 'geweigerd', 'opnieuw_proberen', 'terug_naar_beoordelen', 'toch_factuur'];
// [van, gebeurtenis, naar, voorwaarde(ctx) → null of reden van weigering]. van null = nieuw document.
const STATUS_OVERGANGEN = [
  [null, 'aangeboden_factuur', 'te_beoordelen'],
  [null, 'aangeboden_geen_factuur', 'geen_factuur'],
  [null, 'aangeboden_dubbel', 'dubbel'],
  ['te_beoordelen', 'bevestigen', 'in_wachtrij', (c) => (c.entiteit === 'prive' ? 'privé gaat naar het privé-archief' : bevestigFout(c))],
  ['te_beoordelen', 'bevestigen', 'prive_archief', (c) => (c.entiteit !== 'prive' ? 'alleen privé' : bevestigFout(c))],
  ['te_beoordelen', 'geen_factuur', 'geen_factuur'],
  ['in_wachtrij', 'terugdraaien', 'te_beoordelen', (c) => (c.opdracht_status === 'wacht' ? null : 'opdracht is al opgehaald')],
  ['prive_archief', 'terugdraaien', 'te_beoordelen'],
  ['in_wachtrij', 'koerier_haalt_op', 'wordt_verstuurd'],
  ['wordt_verstuurd', 'gelukt', 'verstuurd', (c) => (c.modus === 'versturen' ? null : 'modus is niet versturen')],
  ['wordt_verstuurd', 'gelukt', 'concept_klaar', (c) => (c.modus === 'concept' ? null : 'modus is niet concept')],
  ['concept_klaar', 'verzonden_gezien', 'verstuurd'],
  ['wordt_verstuurd', 'mislukt_definitief', 'verzending_mislukt'],
  ['wordt_verstuurd', 'geweigerd', 'verzending_mislukt'],
  ['verzending_mislukt', 'opnieuw_proberen', 'in_wachtrij', (c) => (c.entiteit === 'prive' ? 'privé gaat nooit naar de boekhouder' : null)],
  ['verzending_mislukt', 'terug_naar_beoordelen', 'te_beoordelen'],
  ['geen_factuur', 'toch_factuur', 'te_beoordelen'],
  ['dubbel', 'toch_factuur', 'te_beoordelen'],
];
function bevestigFout(c) { return bevestigBlokkades(c, c.poort || null)[0] || null; }
// Eén overgang; geeft { ok, naar } of { ok:false, fout, reden }. Elke combinatie die niet in de tabel staat wordt geweigerd.
function statusOvergang(van, gebeurtenis, ctx) {
  ctx = ctx || {};
  if (van !== null && !STATUSSEN.includes(van)) return { ok: false, fout: 'onbekende_status', reden: String(van) };
  if (!GEBEURTENISSEN.includes(gebeurtenis)) return { ok: false, fout: 'onbekende_gebeurtenis', reden: String(gebeurtenis) };
  const kandidaten = STATUS_OVERGANGEN.filter((o) => o[0] === van && o[1] === gebeurtenis);
  if (!kandidaten.length) return { ok: false, fout: 'ongeldige_overgang', reden: (van || '—') + ' → ' + gebeurtenis };
  const redenen = [];
  for (const o of kandidaten) {
    const r = o[3] ? o[3](ctx) : null;
    if (!r) return { ok: true, naar: o[2] };
    redenen.push(r);
  }
  return { ok: false, fout: 'voorwaarde', reden: redenen.join('; ') };
}

const BETAALSPOREN = ['te_betalen', 'ingevoerd', 'incasso_verwacht', 'betaald_vooraf', 'betaald_gezien'];
const BETAALSPOOR_BEGIN = { zelf: 'te_betalen', incasso: 'incasso_verwacht', betaald: 'betaald_vooraf' };
const BETAALSPOOR_OVERGANGEN = [
  ['te_betalen', 'ingevoerd_in_bank', 'ingevoerd'],
  ['ingevoerd', 'ongedaan', 'te_betalen'],
  ['ingevoerd', 'bankmatch', 'betaald_gezien'],
  ['te_betalen', 'bankmatch', 'betaald_gezien'],          // "Is al betaald (koppelen)" bij signaal te betalen, niet betaald
  ['incasso_verwacht', 'bankmatch', 'betaald_gezien'],
  ['incasso_verwacht', 'toch_zelf_betalen', 'te_betalen'],
  ['betaald_vooraf', 'bankmatch', 'betaald_gezien'],
  // wv1415: de bank boekte een betaling uit een SEPA-batch terug (bijschrijving met de factuur-id als kenmerk): weer te betalen. Uit
  // ingevoerd als de afschrijving zelf nog niet gezien is. "Leverancier incasseert" (knop bij dat signaal): wachten op de incasso.
  ['betaald_gezien', 'teruggeboekt', 'te_betalen'],
  ['ingevoerd', 'teruggeboekt', 'te_betalen'],
  ['te_betalen', 'toch_incasso', 'incasso_verwacht'],
];
// Een creditnota vraagt nooit een betaalhandeling (wv855, overdracht F3 #1; Fable F4 #7): ongeacht de betaalwijze `betaald_vooraf`
// ("niets te betalen"); een terugboeking of verrekening in de bank zet hem via bankmatch op betaald_gezien. Een eigen spoor `geen` zou een
// herbouw van de factuurtabel vragen (CHECK); dit spoor geeft geen signaal (te betalen / incasso niet gezien) en staat niet op de betaallijst.
function isCreditnota(f) { return !!f && (f.soort === 'creditnota' || (Number.isSafeInteger(f.incl) && f.incl < 0)); }
function betaalspoorBegin(betaalwijze, f) {
  const b = BETAALSPOOR_BEGIN[betaalwijze];
  if (!b) throw new KernFout('betaalwijze_onbekend', 'Bevestigen kan niet met betaalwijze ' + betaalwijze);
  return isCreditnota(f) ? 'betaald_vooraf' : b;
}
function betaalspoorOvergang(van, gebeurtenis) {
  if (!BETAALSPOREN.includes(van)) return { ok: false, fout: 'onbekend_betaalspoor', reden: String(van) };
  const o = BETAALSPOOR_OVERGANGEN.find((x) => x[0] === van && x[1] === gebeurtenis);
  return o ? { ok: true, naar: o[2] } : { ok: false, fout: 'ongeldige_overgang', reden: van + ' → ' + gebeurtenis };
}

const OPDRACHT_STATUSSEN = ['wacht', 'opgehaald', 'gelukt', 'mislukt', 'geweigerd', 'teruggedraaid'];
const OPGEHAALD_TIMEOUT_MS = 30 * 60 * 1000, MAX_POGINGEN = 3;
function ms(iso) { const t = Date.parse(iso); if (!Number.isFinite(t)) throw new KernFout('tijd', 'ongeldige tijd'); return t; }
// Mag de koerier deze opdracht nu claimen? { claim, poging } — puur, `nu` in ms van de beller.
function claimbaar(op, nu) {
  if (!Number.isFinite(nu)) throw new KernFout('nu', 'claimbaar vraagt nu (ms)');
  const p = op.poging || 0;
  if (op.status === 'wacht') return ms(op.verstuur_na) <= nu ? { claim: true, poging: p + 1 } : { claim: false, reden: 'verstuur_na nog niet bereikt' };
  if (op.status === 'opgehaald') {
    if (nu - ms(op.opgehaald_op) <= OPGEHAALD_TIMEOUT_MS) return { claim: false, reden: 'nog onderweg' };
    return p < MAX_POGINGEN ? { claim: true, poging: p + 1 } : { claim: false, definitief: true, vastgelopen: true, reden: 'drie pogingen zonder resultaat' };
  }
  if (op.status === 'mislukt') return p < MAX_POGINGEN ? { claim: true, poging: p + 1 } : { claim: false, definitief: true, reden: 'drie pogingen mislukt' };
  return { claim: false, reden: 'status ' + op.status };
}
// Opdrachtovergang; een tweede 'gelukt' verandert niets (idempotent).
function opdrachtOvergang(op, gebeurtenis, nu) {
  const s = op.status;
  if (!OPDRACHT_STATUSSEN.includes(s)) return { ok: false, fout: 'onbekende_status' };
  if (gebeurtenis === 'terugdraaien') return s === 'wacht' ? { ok: true, naar: 'teruggedraaid', factuur: 'terugdraaien' } : { ok: false, fout: 'ongeldige_overgang', reden: 'terugdraaien kan alleen zolang de opdracht wacht' };
  if (gebeurtenis === 'claim') {
    const c = claimbaar(op, nu);
    // Drie keer opgehaald zonder resultaat: definitief mislukt, zodat de factuur naar verzending_mislukt gaat (diffreview wv797 #7).
    if (c.vastgelopen) return { ok: true, naar: 'mislukt', definitief: true, factuur: 'mislukt_definitief', reden: c.reden };
    if (!c.claim) return { ok: false, fout: c.definitief ? 'max_pogingen' : 'niet_claimbaar', reden: c.reden, definitief: !!c.definitief };
    return { ok: true, naar: 'opgehaald', poging: c.poging, opgehaald_op: new Date(nu).toISOString(), factuur: s === 'wacht' ? 'koerier_haalt_op' : null };
  }
  if (gebeurtenis === 'gelukt') {
    if (s === 'gelukt') return { ok: true, naar: 'gelukt', gewijzigd: false };
    return s === 'opgehaald' ? { ok: true, naar: 'gelukt', gewijzigd: true, factuur: 'gelukt' } : { ok: false, fout: 'ongeldige_overgang', reden: s + ' → gelukt' };
  }
  if (gebeurtenis === 'mislukt') {
    if (s !== 'opgehaald') return { ok: false, fout: 'ongeldige_overgang', reden: s + ' → mislukt' };
    const def = (op.poging || 0) >= MAX_POGINGEN;
    return { ok: true, naar: 'mislukt', definitief: def, factuur: def ? 'mislukt_definitief' : null };
  }
  if (gebeurtenis === 'geweigerd') return s === 'opgehaald' ? { ok: true, naar: 'geweigerd', definitief: true, factuur: 'geweigerd' } : { ok: false, fout: 'ongeldige_overgang', reden: s + ' → geweigerd' };
  return { ok: false, fout: 'onbekende_gebeurtenis' };
}

// verstuur_na: het volgende hele uur (standaard) of dagelijks op een vast uur in Nederlandse tijd. Puur: `nu` in ms.
function amsterdamOffsetMs(t) {
  const d = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t));
  const g = (k) => Number(d.find((x) => x.type === k).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(t / 1000) * 1000;
}
function verstuurNa(nu, instelling) {
  if (!Number.isFinite(nu)) throw new KernFout('nu', 'verstuurNa vraagt nu (ms)');
  const ins = instelling || { soort: 'uur' };
  if (ins.soort === 'uur') return new Date((Math.floor(nu / 3600000) + 1) * 3600000).toISOString();
  if (ins.soort === 'dagelijks') {
    const uur = Number(ins.uur);
    if (!(Number.isInteger(uur) && uur >= 0 && uur <= 23)) throw new KernFout('instelling', 'uur 0–23');
    const lok = new Date(nu + amsterdamOffsetMs(nu));
    for (let dag = 0; dag < 3; dag++) {
      const naief = Date.UTC(lok.getUTCFullYear(), lok.getUTCMonth(), lok.getUTCDate() + dag, uur);
      let t = naief - amsterdamOffsetMs(naief - 3600000);
      t = naief - amsterdamOffsetMs(t);
      if (t > nu) return new Date(t).toISOString();
    }
  }
  throw new KernFout('instelling', 'onbekende verzendinstelling');
}

// ───────────────────────────── vingerafdruk (contracten/koerier-api.md) ─────────────────────────────

function isSha(s) { return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s); }
// Canonieke vorm: JSON zonder spaties, sleutels exact in deze volgorde, getallen geheel, niet-ASCII niet ge-escaped (JSON.stringify doet dat
// al zo). bijlagen = lijst sha256's in de volgorde van het veld `bijlagen` (objecten met .sha256 of kale strings).
function vingerafdrukCanoniek(op) {
  if (!op || typeof op.id !== 'string' || !op.id) throw new KernFout('vingerafdruk', 'id ontbreekt');
  if (op.soort !== 'boekhouder_factuur' && op.soort !== 'boekhouder_afschrift') throw new KernFout('vingerafdruk', 'onbekende soort');
  if (typeof op.doeladres !== 'string' || !op.doeladres) throw new KernFout('vingerafdruk', 'doeladres ontbreekt');
  const r = op.regel || {};
  let regel;
  if (op.soort === 'boekhouder_factuur') {
    if (!Number.isSafeInteger(r.bedrag_centen)) throw new KernFout('vingerafdruk', 'bedrag_centen moet een geheel getal zijn');
    regel = { factuur_id: String(r.factuur_id), entiteit: String(r.entiteit), bedrag_centen: r.bedrag_centen, doeladres: String(r.doeladres) };
  } else regel = { afschrift_id: String(r.afschrift_id), entiteit: String(r.entiteit), periode: String(r.periode), doeladres: String(r.doeladres) };
  for (const k of Object.keys(regel)) if (regel[k] === 'undefined' || regel[k] === 'null' || regel[k] === '') throw new KernFout('vingerafdruk', 'regel.' + k + ' ontbreekt');
  if (regel.entiteit === 'prive') throw new KernFout('prive', 'privé gaat nooit naar de boekhouder');
  const bijlagen = (op.bijlagen || []).map((b) => (typeof b === 'string' ? b : b && b.sha256));
  if (!bijlagen.length || !bijlagen.every(isSha)) throw new KernFout('vingerafdruk', 'bijlagen moeten sha256 (64 hex, kleine letters) zijn');
  return JSON.stringify({ id: op.id, soort: op.soort, doeladres: op.doeladres, regel, bijlagen });
}
function vingerafdruk(op) { return crypto.createHash('sha256').update(vingerafdrukCanoniek(op), 'utf8').digest('hex'); }

// Opdracht voor de koerier bij Bevestigen. Privé of een entiteit zonder boekhoud_doel → weigeren (de database dwingt het in F1c ook af).
// Het doeladres komt uit de entiteitentabel, nooit uit factuur- of mailtekst.
function maakOpdracht(f, entiteit, o) {
  if (!f || !entiteit) throw new KernFout('opdracht', 'factuur en entiteit nodig');
  if (f.entiteit === 'prive' || entiteit.sleutel === 'prive') throw new KernFout('prive', 'privé gaat nooit naar de boekhouder');
  if (f.entiteit !== entiteit.sleutel) throw new KernFout('opdracht_entiteit', 'entiteit van de opdracht wijkt af van de factuur');
  if (!entiteit.boekhoud_doel) throw new KernFout('geen_doel', 'entiteit heeft geen boekhoudadres');
  if (!/^[0-9a-f]{16}$/.test(String(o.id || '')) || !/^[0-9a-f]{16}$/.test(String(f.id || ''))) throw new KernFout('id', 'id is 16 hex kleine letters');
  const blok = bevestigBlokkades(f, o.poort || null);
  if (blok.length) throw new KernFout('niet_bevestigbaar', blok.join('; '));
  const shas = (o.bijlagen || []).map((b) => (typeof b === 'string' ? b : b && b.sha256));
  if (f.document && !shas.includes(f.document)) throw new KernFout('bijlagen', 'het stuk van de factuur zit niet in de bijlagen');
  if (f.ubl_document && !shas.includes(f.ubl_document)) throw new KernFout('bijlagen', 'de UBL van de factuur zit niet in de bijlagen');
  const op = {
    id: o.id, soort: 'boekhouder_factuur', entiteit: entiteit.sleutel, doeladres: entiteit.boekhoud_doel,
    regel: { factuur_id: f.id, entiteit: entiteit.sleutel, bedrag_centen: f.incl, doeladres: entiteit.boekhoud_doel },
    bijlagen: o.bijlagen, verstuur_na: o.verstuur_na, idempotentiesleutel: f.id + ':' + o.id, status: 'wacht', poging: 0,
  };
  op.vingerafdruk = vingerafdruk(op);
  return op;
}

// ───────────────────────────── rollen ─────────────────────────────

// eigenaar ziet alles; praktijkmanager (F6) alleen facturen met een entiteit anders dan Privé en zonder patiëntkenmerk. Onbekende rol ziet niets.
function zichtbaarVoor(rol, f) {
  if (rol === 'eigenaar') return true;
  if (rol === 'praktijkmanager') return !!f.entiteit && f.entiteit !== 'prive' && !f.patientkenmerk && !f.alleen_eigenaar;   // zonder entiteit: kan Privé zijn
  return false;
}

module.exports = {
  KernFout,
  // basis
  schoon, normNaam, normNummer, decimaalNaarCenten, bedragNaarCenten, bedragenIn, leesDatum, isIsoDatum, plusDagen, dagenTussen,
  ibanNorm, ibanMod97, ibansIn, bsnElfproef, mediaan,
  // lezers
  leesXml, leesUbl, leesPdfTekst,
  // besliskader per stap (§ 4.5)
  stapDubbelBestand, stapDubbelInhoud, factuurSleutel, stapSoort, groepeerBericht, stapPatientkenmerk, stapVelden, herkenLeverancier, compactNaam, naamVerwant, ibanNaamPast, VERZAMEL_RE,
  stapEntiteit, stapGeenFactuur, stapBetaalwijze, valideer, ibanPoort, magBevestigen, nagebeld, beslisBericht, besluit, BESLUIT_BRONNEN,
  // leren
  leerUitBevestiging,
  // overgangen (§ 4.4)
  STATUSSEN, GEBEURTENISSEN, STATUS_OVERGANGEN, statusOvergang, BETAALSPOREN, BETAALSPOOR_OVERGANGEN, betaalspoorBegin, betaalspoorOvergang, isCreditnota,
  OPDRACHT_STATUSSEN, claimbaar, opdrachtOvergang, verstuurNa, MAX_POGINGEN, OPGEHAALD_TIMEOUT_MS,
  // opdracht + vingerafdruk
  vingerafdrukCanoniek, vingerafdruk, maakOpdracht,
  // rollen
  zichtbaarVoor,
};
