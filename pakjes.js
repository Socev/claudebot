'use strict';
/*
 * pakjes.js — OVIS Pakjes (wv2593, 6-11-2026; idee 33 op de ideeënbus). Ontwerp in de vault: "01_Ontwikkeling/Pakjes-tracker - ontwerp (6-11-2026).md".
 *
 * WAAROM. David (6-11 16:14): "Pakjes tracker? DHL, PostNL, etc etc"; 23:04: "ga daar nu maar volgas op". Alle lopende zendingen op één
 * plek in de app: per pakje winkel, vervoerder, stand en verwachte bezorgdag; bezorgd na 7 dagen naar Eerder.
 *
 * HOE.
 *  - Bron: de bestel- en bezorgmail in Davids privé-Gmail die MailMan al zag. server.js geeft de kandidaten (gmail_id, ontvangen, afzender,
 *    onderwerp uit mailman.sqlite, alleen lezen) en leest een nieuwe kandidaat via het lees-luik (mail_lezen, alleen lezen). MailMan en de
 *    Gmail-labels blijven onaangeroerd: deze module meet alleen mee.
 *  - herken(mail): vaste regels per vervoerder en afzender (PostNL, DHL eCommerce, DPD, GLS, UPS, Amazon, Dragonfly en winkelmail met een
 *    track-and-trace-code). Geen taalmodel. Mailtekst is gegeven, nooit een opdracht: alleen vaste velden, begrensd in lengte en tekenset.
 *  - Volgen: alleen openbare volgpagina's zonder login of sleutel (gemeten 6-11-2026): DHL eCommerce (code), PostNL (code + postcode),
 *    GLS (code). DPD (verbinding geweigerd), UPS (Access Denied) en Amazon (inlog) niet: daar telt de stand uit de laatste mail.
 *    Deze module bouwt alleen de adressen en leest het antwoord; het ophalen doet server.js (o.haal). Uit het antwoord komen alleen stand,
 *    tijdvak, bezorgmoment en de afzendernaam; adres, naam, hash en handtekening van de ontvanger worden niet gelezen of bewaard.
 *  - Postcode: alleen voor PostNL. Uit de mail zelf (een jouw.postnl.nl-link met code-NL-postcode) of uit config.json (postcodes, 0600, op
 *    de pod). Nooit in een log, in /health of in een foutmelding.
 *  - Opslag: eigen sqlite in o.dir (map 700, bestand 600): tabel zending (één rij per pakje) en mail (gmail_id → zending, alleen het id en de
 *    tijd; geen onderwerp of tekst). Bezorgd en 90 dagen stil: weg; mail-rijen na 60 dagen weg.
 * PRIVACY. Deze module logt niets en praat niet zelf met het netwerk (geen fetch/http); info() geeft alleen aantallen en tijdstippen.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAG = 86400000;
const STANDEN = ['besteld', 'aangemeld', 'onderweg', 'vandaag', 'afhaalpunt', 'bezorgd'];
const VERVOERDERS = { postnl: 'PostNL', dhl: 'DHL', dpd: 'DPD', gls: 'GLS', ups: 'UPS', amazon: 'Amazon', dragonfly: 'Dragonfly', anders: 'Anders', winkel: 'Nog geen bezorger' };
const EERDER_NA = 7 * DAG, STIL_NA = 30 * DAG, STIL_MAIL_NA = 10 * DAG, WEG_NA = 90 * DAG, MAIL_WEG_NA = 60 * DAG;
const MAX_TEKST = 200000;

// ── kleine hulpjes ──
function schoon(x, max) {
  const v = String(x == null ? '' : x).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029​-‏﻿]/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, max) : null;
}
// HOOFDLETTERNAAM → Hoofdletternaam (alleen als er geen kleine letters in staan; "GAMMA" blijft kort en herkenbaar)
function netjes(x) {
  const v = schoon(x, 80);
  if (!v) return null;
  if (/[a-z]/.test(v) || v.length <= 5) return v;
  return v.toLowerCase().replace(/(^|[\s\-(/])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Eu|Bv|Nv|Sarl|Gmbh)\b/g, (w) => w.toUpperCase());
}
function domein(van) {
  const t = String(van || ''), m = /<([^<>\s]+)>\s*$/.exec(t) || /([^\s<>"]+@[^\s<>"]+)/.exec(t);
  const a = (m ? m[1] : t).toLowerCase(), i = a.lastIndexOf('@');
  return i >= 0 ? a.slice(i + 1).replace(/[^a-z0-9.-]/g, '') : '';
}
function weergaveNaam(van) {
  const t = String(van || '').replace(/<[^>]*>/g, '').replace(/"/g, '').trim();
  return t && !/@/.test(t) ? schoon(t, 60) : null;
}
function op(dom, ...stammen) { return stammen.some((s) => dom === s || dom.endsWith('.' + s)); }
function nlDag(ms) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
function dagPlus(dag, n) { const d = new Date(dag + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function geldigeDag(s) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false; const x = new Date(s + 'T12:00:00Z'); return !isNaN(x) && x.toISOString().slice(0, 10) === s; }
function iso(x) { const t = Date.parse(x); return isFinite(t) ? new Date(t).toISOString() : null; }
function idVan(sleutel) { return crypto.createHash('sha256').update(sleutel).digest('hex').slice(0, 12); }
function postcode(x) { const m = /^\s*([1-9]\d{3})\s?([A-Za-z]{2})\s*$/.exec(String(x || '')); return m ? m[1] + m[2].toUpperCase() : null; }

const MAANDEN = { januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12,
  jan: 1, feb: 2, mrt: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, okt: 10, nov: 11, dec: 12 };
const WEEKDAGEN = { zondag: 0, maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6 };
// "donderdag 29 oktober" / "29 oktober" / "vandaag" / "morgen" / "zaterdag" (eerstvolgende) → JJJJ-MM-DD, gerekend vanaf de maildag
function dagUit(t, mailDag) {
  const s = String(t || '').toLowerCase();
  let m = /\b(\d{1,2})\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|jan|feb|mrt|apr|jun|jul|aug|sept?|okt|nov|dec)\b\.?(?:\s+(20\d{2}))?/.exec(s);
  if (m) {
    const mnd = MAANDEN[m[2]], mailJ = Number(mailDag.slice(0, 4)), mailM = Number(mailDag.slice(5, 7));
    let j = m[3] ? Number(m[3]) : mailJ;
    if (!m[3] && mnd < mailM - 6) j++;
    const d = j + '-' + String(mnd).padStart(2, '0') + '-' + String(Number(m[1])).padStart(2, '0');
    return geldigeDag(d) ? d : null;
  }
  if (/\b(vandaag|vanavond|vanmiddag|vanochtend)\b/.test(s)) return mailDag;
  if (/\bmorgen\b/.test(s)) return dagPlus(mailDag, 1);
  m = /\b(zondag|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag)\b/.exec(s);
  if (m) {
    const nu = new Date(mailDag + 'T12:00:00Z').getUTCDay();
    let n = (WEEKDAGEN[m[1]] - nu + 7) % 7;
    return dagPlus(mailDag, n);
  }
  return null;
}
// "tussen 17.00 - 20.00 uur" / "tussen 19:55 en 20:55" → ['17:00', '20:00']
function tijdvakUit(t) {
  const m = /\btussen\s+(\d{1,2})[.:](\d{2})\s*(?:-|–|en|tot)\s*(\d{1,2})[.:](\d{2})/i.exec(String(t || ''));
  if (!m) return null;
  const a = [m[1], m[2], m[3], m[4]].map(Number);
  if (a[0] > 23 || a[2] > 23 || a[1] > 59 || a[3] > 59) return null;
  const f = (h, mi) => String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
  return [f(a[0], a[1]), f(a[2], a[3])];
}

// ── herkennen: welke mail is een pakje? ──
const KANDIDAAT_DOMEINEN = ['postnl.nl', 'dhl.com', 'dhl.nl', 'dhl.de', 'dhlecommerce.nl', 'dhlparcel.nl', 'dpd.nl', 'dpd.com', 'dpd.de', 'dpdgroup.com', 'gls-info.nl',
  'gls-group.eu', 'gls-group.com', 'gls.nl', 'ups.com', 'amazon.nl', 'amazon.com', 'amazon.de', 'dragonflyinternational.com', 'dragonflyshipping.nl', 'bol.com',
  'coolblue.nl', 'shopifyemail.com', 'budbee.com', 'trunkrs.nl', 'homerr.com', 'fedex.com', 'tnt.com'];
const KANDIDAAT_ONDERWERP = /(pakket|pakje|zending|bezorg|verzonden|verstuurd|onderweg|track|shipped|shipment|on (its|the) way|sendung|unterwegs|lieferung|versandt|afgeleverd|delivered|zugestellt)/i;
function isKandidaat(k) {
  const dom = String(k && (k.afzender_domein || domein(k.van)) || '').toLowerCase();
  const ond = String(k && k.onderwerp || '');
  return KANDIDAAT_DOMEINEN.some((s) => op(dom, s)) || KANDIDAAT_ONDERWERP.test(ond) || BESTEL_ONDERWERP.test(ond);
}

// ── wv2743 (8-11-2026, idee 33 einddoel "elk pakje uit de bezorg- én bestelmail"): een bestel- of verzendbevestiging van een webwinkel
// zonder volgcode is een pakje in de stand Besteld (of Onderweg), "Nog geen bezorger". Gemeten 8-11: ReMarkt (7-11) en Lidl (5-11) stonden
// pas in de lijst als de vervoerder mailde. Streng, want een vals Besteld blijft 10 dagen staan: alleen een bevestigingsonderwerp, nooit
// boodschappen, maaltijden, digitaal, tickets of facturen, en de mail moet over een bezorging gaan (bezorgadres, verzendkosten …). De weergave
// laat zo'n rij opgaan in het pakje van dezelfde winkel zodra de vervoerder het meldt (samenWinkel).
const BESTEL_ONDERWERP = /(bestelbevestiging|orderbevestiging|verzendbevestiging|bevestiging van (je|jouw|uw) (bestelling|order)|(je|jouw|uw) bestelling (is )?(ontvangen|bevestigd|geplaatst|verzonden|onderweg)|bedankt voor (je|jouw|uw) (bestelling|aankoop|order)|order confirm|bestellbest[äa]tigung|versandbest[äa]tigung|bestellung[^\n]{0,40}(best[äa]tigt|eingegangen|versandt))/i;
const BESTEL_NIET_DOMEIN = ['ah.nl', 'thuisbezorgd.nl', 'jumbo.com', 'picnic.app', 'crisp.nl', 'flink.com', 'ubereats.com', 'uber.com', 'deliveroo.nl', 'google.com',
  'apple.com', 'microsoft.com', 'steampowered.com', 'gmail.com', 'googlemail.com', 'socev.dev', 'paypal.com', 'paypal.nl', 'booking.com', 'airbnb.com', 'ns.nl'];
const BESTEL_NIET_ONDERWERP = /(factuur|invoice|rechnung|retour|annuler|geannuleerd|storn|minimum|abonnement|lidmaatschap|ticket|reserver|boeking|cadeaukaart|tegoed|download|licentie|domein|hosting|^\s*(fwd?|doorgestuurd|wg)\s*:)/i;
const BESTEL_FYSIEK = /(bezorgadres|afleveradres|verzendadres|leveradres|lieferadresse|versandadresse|shipping address|delivery address|verzendkosten|bezorgkosten|versandkosten|verzendmethode|bezorgmethode|bezorgoptie|verwachte (bezorg|lever)|bezorgmoment|levertijd|lieferzeit|wordt (je|jouw|uw) (bestelling|pakket) (bezorgd|verzonden|geleverd))/i;
const BESTEL_NR = /(?:bestelnummer|ordernummer|bestelnr\.?|ordernr\.?|order\s*(?:number|nr\.?|#)|bestellnummer|bestelling|bestellung|order)\s*[:#]?\s*#?\s*([A-Z0-9][A-Z0-9-]{3,24})\b/i;
function winkelBestelling(ond, tekst, dom, naam, tms, mailDag) {
  if (!dom || !BESTEL_ONDERWERP.test(ond) || BESTEL_NIET_ONDERWERP.test(ond) || BESTEL_NIET_DOMEIN.some((s) => op(dom, s))) return null;
  if (!BESTEL_FYSIEK.test(tekst)) return null;
  // bestelnummer: het eerste na een bestelwoord met een cijfer erin (onderwerp eerst), anders na een dubbele punt of # in het onderwerp, anders
  // een los getal van 6–15 cijfers in het onderwerp; zonder nummer telt de maildag (twee mails van één bestelling worden dan twee rijen)
  let bestelnr = null;
  for (const t of [ond, tekst]) {
    for (const k of t.matchAll(new RegExp(BESTEL_NR.source, 'gi'))) { if (/\d/.test(k[1])) { bestelnr = k[1].toUpperCase(); break; } }
    if (bestelnr) break;
  }
  if (!bestelnr) { const k = /[:#]\s*([A-Z0-9][A-Z0-9-]{3,24})\b/i.exec(ond); if (k && /\d/.test(k[1])) bestelnr = k[1].toUpperCase(); }
  if (!bestelnr) { const k = /\b(\d{6,15})\b/.exec(ond); if (k) bestelnr = k[1]; }
  // winkelnaam: de afzendernaam, tenzij die algemeen is ("Verkoop") of een zin; dan de naam uit het domein, gespeld zoals in het onderwerp
  const delen = dom.split('.'), stam = delen.length >= 2 ? delen[delen.length - 2] : dom;
  const algemeen = !naam || naam.length > 30 || /[:|]/.test(naam) || /^(verkoop|sales|info|klantenservice|customer ?service|service|noreply|no-reply|orders?|bestellingen|webshop|shop|team|support|contact)$/i.test(naam.trim());
  const inOnd = new RegExp('\\b(' + stam.replace(/[^a-z0-9-]/gi, '') + ')\\b', 'i').exec(ond);
  const winkel = netjes(!algemeen ? naam : inOnd ? inOnd[1] : stam.charAt(0).toUpperCase() + stam.slice(1));
  const stand = /(verzend|verzonden|verstuurd|onderweg|shipped|versandt|versandbest)/i.test(ond) ? 'onderweg' : 'besteld';
  return {
    sleutel: 'winkel:' + dom + ':' + (bestelnr || mailDag), vervoerder: 'winkel', code: null, bestelnr, winkel, omschrijving: null, stand,
    verwacht_dag: null, verwacht_van: null, verwacht_tot: null, pc: null, tijd: isFinite(tms) ? new Date(tms).toISOString() : null,
  };
}

// codes per vervoerder. 3S-codes gebruiken PostNL en DHL allebei: de afzender of de link beslist, anders 'onbekend' (beide proberen).
const C = {
  s3: /\b(3S[A-Z]{3,5}\d{6,14})\b/,
  postnlInt: /\b([A-Z]{2}\d{9}NL)\b/,
  dhl: /\b(JJD\d{14,26}|JVGL\d{10,26}|JD\d{18})\b/,
  ups: /\b(1Z[0-9A-Z]{16})\b/,
  dragonfly: /\b(AMZNL\d{9,15})\b/,
  dpd: /\b(0\d{13}|\d{14})\b/,
  gls: /\b(\d{11,12})\b/,
};
const LINK = [
  ['postnl', /jouw\.postnl\.nl\/track-and-trace\/([0-9A-Z]{9,30})-NL-([1-9]\d{3}\s?[A-Z]{2})/i],
  ['postnl', /postnl\.nl\/(?:track-and-trace|tracktrace)[^\s"']*?[?&/](?:barcode=|b=)?(3S[A-Z]{3,5}\d{6,14})/i],
  ['dhl', /(?:dhlecommerce|dhlparcel)\.nl\/[^\s"']*?[?&](?:tc|key|tt)=([0-9A-Z]{10,30})/i],
  ['dhl', /dhl\.com\/[^\s"']*?tracking-id=([0-9A-Z]{10,30})/i],
  ['dpd', /dpd\.(?:de|nl|com)\/[^\s"']*?(?:query=|parcelNumber=|parcelno=|parcel\/)(\d{14})/i],
  ['gls', /gls[^\s"']*?(?:match=|parcelNo=|trackingNumber=)(\d{11,12})/i],
  ['ups', /ups\.com\/[^\s"']*?(?:tracknum|InquiryNumber1)=(1Z[0-9A-Z]{16})/i],
];

// stand uit een tekst (onderwerp eerst; de lijf-tekst alleen bij afzenders waar dat veilig is)
function standUit(t) {
  const s = String(t || '').toLowerCase();
  if (/(^|\s|:)(bezorgd|afgeleverd|geleverd|delivered|zugestellt|opgehaald)(\b|:)/.test(s) && !/\bwordt\b[^.!?]{0,30}\bbezorgd/.test(s)) return 'bezorgd';
  if (/(ligt (voor je )?klaar|afhaalpunt|servicepoint|service point|postnl-punt|pakketpunt|pakketautomaat|parcelshop|abholbereit|ready for pick ?up)/.test(s)) return 'afhaalpunt';
  if (/(vandaag|vanavond|onderweg voor bezorging|out for delivery|in zustellung|wird heute|binnen (een|het komende) uur)/.test(s)) return 'vandaag';
  if (/(onderweg|verzonden|verstuurd|shipped|on (its|the) way|unterwegs|versandt|ontvangen door|hebben je pakket ontvangen|gesorteerd|in transit)/.test(s)) return 'onderweg';
  if (/(nieuw pakket|verwacht|komen we|aangemeld|binnenkort|bezorgmoment|bezorgafspraak)/.test(s)) return 'aangemeld';
  if (/(^besteld\b|besteld:|bestelling (is )?(ontvangen|bevestigd)|bedankt voor je bestelling|order confirm)/.test(s)) return 'besteld';
  return null;
}

/*
 * herken({van, onderwerp, tekst, datum}) → null (geen pakje) of
 *   { sleutel, vervoerder, code, bestelnr, winkel, omschrijving, stand, verwacht_dag, verwacht_van, verwacht_tot, pc }
 * pc (postcode) alleen uit een PostNL-link in de mail; het veld gaat nooit naar de app of een log.
 */
function herken(m) {
  if (!m || typeof m !== 'object') return null;
  const ond = schoon(m.onderwerp, 300) || '', tekst = String(m.tekst || '').slice(0, MAX_TEKST);
  const dom = domein(m.van), naam = weergaveNaam(m.van);
  const tms = Date.parse(m.datum);
  const mailDag = isFinite(tms) ? nlDag(tms) : nlDag(Date.now());
  const alles = ond + '\n' + tekst;
  let vervoerder = null, code = null, pc = null, bestelnr = null, winkel = null, omschrijving = null, stand = null;
  let dagTekst = null;

  // 1. vaste afzenders
  if (op(dom, 'postnl.nl')) {
    vervoerder = 'postnl';
    const k = /track\s*&\s*trace-?code\s*[:\s]\s*([0-9A-Z]{9,30})/i.exec(tekst) || C.s3.exec(alles) || C.postnlInt.exec(alles);
    code = k ? k[1].toUpperCase() : null;
    const w = /pakket van\s+(.+?)\s*$/i.exec(ond);
    winkel = w ? w[1] : null;
    stand = standUit(ond);
    if (stand !== 'bezorgd' && stand !== 'afhaalpunt' && /(staan vandaag voor de deur|bezorgen (je pakket )?vandaag)/i.test(tekst)) stand = 'vandaag';
    dagTekst = stand === 'vandaag' ? 'vandaag' : (/(?:verwacht|bezorgmoment)[^\n]{0,40}\n?\s*([^\n]{0,60})/i.exec(tekst) || [])[1] || null;
  } else if (op(dom, 'dhlecommerce.nl', 'dhlparcel.nl', 'dhl.com', 'dhl.nl', 'dhl.de')) {
    vervoerder = 'dhl';
    const k = /\(([0-9A-Z]{10,30})\)\s*$/.exec(ond) || C.dhl.exec(alles) || C.s3.exec(alles);
    code = k ? k[1].toUpperCase() : null;
    const w = /pakket\s+[0-9A-Z]{10,30}\s+van\s+(.+?)\s+(?:op de stoep|bij je|aan|naar)\b/i.exec(tekst);
    winkel = w ? w[1] : null;
    stand = standUit(ond.replace(/\([^)]*\)\s*$/, ''));
    const mo = /verwacht bezorgmoment\s*\n?\s*([^\n]{0,60})/i.exec(tekst);
    dagTekst = mo ? mo[1] : ond;
  } else if (op(dom, 'dpd.nl', 'dpd.com', 'dpd.de', 'dpdgroup.com')) {
    vervoerder = 'dpd';
    const k = /(?:pakketnummer|parcel number|paketnummer|zendingnummer|track(?:ing)?[- ]?(?:nummer|number|code))\D{0,20}(\d{14})/i.exec(alles) || C.dpd.exec(ond);
    code = k ? k[1] : null;
    stand = standUit(ond);
    dagTekst = ond + ' ' + ((/(?:verwacht|bezorg)[^\n]{0,80}/i.exec(tekst) || [])[0] || '');
  } else if (op(dom, 'gls-info.nl', 'gls-group.eu', 'gls-group.com', 'gls.nl')) {
    vervoerder = 'gls';
    const k = /(?:pakketnummer|parcel number|paketnummer|track(?:ing)?[- ]?(?:nummer|number|code)|zending)\D{0,20}(\d{11,12})/i.exec(alles);
    code = k ? k[1] : null;
    stand = standUit(ond);
    dagTekst = ond + ' ' + ((/(?:verwacht|bezorg)[^\n]{0,80}/i.exec(tekst) || [])[0] || '');
  } else if (op(dom, 'ups.com')) {
    vervoerder = 'ups';
    const k = C.ups.exec(alles);
    code = k ? k[1] : null;
    stand = standUit(ond);
    dagTekst = ond + ' ' + ((/(?:verwacht|scheduled delivery|geplande levering)[^\n]{0,80}/i.exec(tekst) || [])[0] || '');
  } else if (op(dom, 'dragonflyinternational.com', 'dragonflyshipping.nl')) {
    vervoerder = 'dragonfly';
    const k = C.dragonfly.exec(alles);
    code = k ? k[1] : null;
    winkel = 'Amazon';
    stand = standUit(ond);
    dagTekst = stand === 'vandaag' ? 'vandaag' : null;
  } else if (op(dom, 'amazon.nl', 'amazon.com', 'amazon.de', 'amazon.fr', 'amazon.co.uk')) {
    // Amazon-eigen bezorging: geen openbare volgcode; het bestelnummer houdt de mails van één bestelling bij elkaar
    const b = /\b(\d{3}-\d{7}-\d{7})\b/.exec(alles);
    if (!b) return null;
    const pre = /^(besteld|verzonden|onderweg voor bezorging|bezorgd|vertraagd|geannuleerd)\b/i.exec(ond);
    if (!pre) return null;
    if (/geannuleerd/i.test(pre[1])) return null;
    vervoerder = 'amazon'; bestelnr = b[1]; winkel = 'Amazon';
    const q = /[‘'"“]([^’‘'"”]{2,120})[’‘'"”]/.exec(ond);
    omschrijving = q ? q[1].replace(/\.{2,}$|…$/, '').trim() : null;
    stand = /bezorgd/i.test(pre[1]) ? 'bezorgd' : /onderweg/i.test(pre[1]) ? 'vandaag' : /verzonden|vertraagd/i.test(pre[1]) ? 'onderweg' : 'besteld';
    const w = /wordt\s+([^\n]{2,40}?)\s+bezorgd/i.exec(tekst) || /verwachte? (?:bezorging|levering)[:\s]+([^\n]{2,40})/i.exec(tekst);
    dagTekst = stand === 'vandaag' ? 'vandaag' : (w ? w[1] : null);
  }

  // 2. winkelmail (of een vervoerder zonder code in de vaste regels): een code via een volglink of een bekend codeformaat
  if (!code && !bestelnr) {
    for (const [v, re] of LINK) {
      const k = re.exec(tekst);
      if (k) { vervoerder = v; code = k[1].toUpperCase(); if (v === 'postnl' && k[2]) pc = postcode(k[2]); break; }
    }
    if (!code) {
      const k = C.dhl.exec(alles) || C.ups.exec(alles) || C.dragonfly.exec(alles);
      if (k) { code = k[1]; vervoerder = /^1Z/.test(code) ? 'ups' : /^AMZNL/.test(code) ? 'dragonfly' : 'dhl'; }
    }
    if (!code) {
      const k = C.s3.exec(alles) || C.postnlInt.exec(alles);
      if (k) { code = k[1]; vervoerder = /NL$/.test(code) ? 'postnl' : (vervoerder || 'onbekend'); }
    }
    if (!code) {
      const k = /(?:track(?:ing)?[- ]?(?:nummer|number|code)|track\s*&\s*trace(?:-?code)?|sendungsnummer|zendingsnummer)\s*[:#]?\s*([0-9A-Z]{8,30})\b/i.exec(tekst);
      if (k && /\d/.test(k[1])) { code = k[1].toUpperCase(); vervoerder = vervoerder || 'anders'; }
    }
    if (!code) return vervoerder ? null : winkelBestelling(ond, tekst, dom, naam, tms, mailDag);
    if (!['postnl', 'dhl', 'dpd', 'gls', 'ups', 'dragonfly'].includes(vervoerder) || !winkel) {
      winkel = winkel || naam || (dom ? dom.replace(/^(e?mail|t|m|nl|info|noreply|news|edm)\./, '') : null);
    }
    stand = stand || standUit(ond) || 'onderweg';
    dagTekst = dagTekst || ((/(?:verwacht|bezorg|levering)[^\n]{0,60}/i.exec(tekst) || [])[0] || null);
  } else if (!pc && vervoerder === 'postnl') {
    const k = LINK[0][1].exec(tekst);
    if (k && k[1].toUpperCase() === code) pc = postcode(k[2]);
  }
  if (!code && !bestelnr) return null;
  if (code && !/^[0-9A-Z]{8,30}$/.test(code)) return null;
  stand = stand || 'aangemeld';
  let verwacht_dag = stand === 'bezorgd' ? null : dagUit(dagTekst, mailDag);
  if (verwacht_dag && (verwacht_dag < dagPlus(mailDag, -1) || verwacht_dag > dagPlus(mailDag, 30))) verwacht_dag = null;
  const tv = stand === 'bezorgd' ? null : tijdvakUit(alles);
  if (stand === 'vandaag' && !verwacht_dag) verwacht_dag = mailDag;
  return {
    sleutel: code ? (vervoerder === 'onbekend' ? 'code' : vervoerder) + ':' + code : 'amazon:' + bestelnr,
    vervoerder, code, bestelnr, winkel: netjes(winkel), omschrijving: schoon(omschrijving, 120), stand,
    verwacht_dag, verwacht_van: verwacht_dag && tv ? tv[0] : null, verwacht_tot: verwacht_dag && tv ? tv[1] : null, pc,
    tijd: isFinite(tms) ? new Date(tms).toISOString() : null,
  };
}

// ── volgen bij de vervoerder (alleen openbare pagina's, gemeten 6-11-2026) ──
function volgAdressen(z, postcodes) {
  const c = encodeURIComponent(z.code || '');
  if (!z.code) return [];
  const dhl = { soort: 'dhl', url: 'https://my.dhlecommerce.nl/receiver-parcel-api/track-trace?key=' + c };
  const pnl = (pcs) => pcs.map((pc) => ({ soort: 'postnl', pc, url: 'https://jouw.postnl.nl/track-and-trace/api/trackAndTrace/' + c + '-NL-' + pc + '?language=nl' }));
  const pcs = [];
  [z.pc].concat(postcodes || []).forEach((p) => { const q = postcode(p); if (q && !pcs.includes(q)) pcs.push(q); });
  if (z.vervoerder === 'dhl') return [dhl];
  if (z.vervoerder === 'postnl') return /NL$/.test(z.code) ? pnl(pcs) : pnl(pcs);
  if (z.vervoerder === 'gls') return [{ soort: 'gls', url: 'https://gls-group.com/app/service/open/rest/NL/nl/rstt029?match=' + c }];
  if (z.vervoerder === 'onbekend') return [dhl].concat(pnl(pcs));
  return [];
}
// De link voor David (opent de volgpagina van de vervoerder); alleen https en vaste hosts
function volgLink(z, postcodes) {
  const c = encodeURIComponent(z.code || '');
  if (z.vervoerder === 'amazon' && z.bestelnr) return 'https://www.amazon.nl/gp/your-account/order-details?orderID=' + encodeURIComponent(z.bestelnr);
  if (!z.code) return null;
  const v = z.gevolgd || z.vervoerder;
  if (v === 'dhl') return 'https://my.dhlecommerce.nl/go-track-trace?tc=' + c;
  if (v === 'postnl') { const pc = postcode(z.pc) || postcode((postcodes || [])[0]); return 'https://jouw.postnl.nl/track-and-trace/' + c + (pc ? '-NL-' + pc : ''); }
  if (v === 'dpd') return 'https://tracking.dpd.de/status/nl_NL/parcel/' + c;
  if (v === 'gls') return 'https://gls-group.com/NL/nl/pakket-volgen?match=' + c;
  if (v === 'ups') return 'https://www.ups.com/track?loc=nl_NL&tracknum=' + c;
  if (v === 'dragonfly') return 'https://dragonflyshipping.nl/nl/volg-je-pakket/?tracking-id=' + c;
  return null;
}
// antwoord → { gevonden, stand, tekst, verwacht_dag, verwacht_van, verwacht_tot, bezorgd_op, winkel } (alleen deze velden)
function tijdNl(isoT) { const t = Date.parse(isoT); if (!isFinite(t)) return null; return new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t)); }
function vakUit(start, eind, heleDag) {
  const a = Date.parse(start), b = Date.parse(eind);
  if (!isFinite(a)) return {};
  return { verwacht_dag: nlDag(a), verwacht_van: heleDag ? null : tijdNl(start), verwacht_tot: heleDag || !isFinite(b) ? null : tijdNl(eind) };
}
const DHL_FASE = { DATA_RECEIVED: 'aangemeld', UNDERWAY: 'onderweg', IN_DELIVERY: 'vandaag', DELIVERED: 'bezorgd' };
const DHL_TEKST = { DATA_RECEIVED: 'Aangemeld bij DHL', UNDERWAY: 'Onderweg', IN_DELIVERY: 'Bezorger is onderweg', DELIVERED: 'Bezorgd' };
function leesDhl(j) {
  const r = Array.isArray(j) ? j[0] : null, v = r && r.view;
  if (!v || typeof v !== 'object') return { gevonden: false };
  let fase = null;
  (Array.isArray(v.phaseDisplay) ? v.phaseDisplay : []).forEach((p) => { if (p && p.completed && DHL_FASE[p.phase]) fase = p.phase; });
  const sleutels = [];
  let bezorgdOp = null;
  (Array.isArray(v.phases) ? v.phases : []).forEach((p) => (Array.isArray(p && p.events) ? p.events : []).forEach((e) => {
    if (e && typeof e.key === 'string') sleutels.push(e.key);
    if (p.phase === 'DELIVERED' && e && e.timestamp && !bezorgdOp) bezorgdOp = iso(e.timestamp);
  }));
  let stand = fase ? DHL_FASE[fase] : null, tekst = fase ? DHL_TEKST[fase] : null;
  const ps = sleutels.concat([String(v.message || '')]).join(' ');
  if (stand !== 'bezorgd' && /(PARCELSHOP|SERVICEPOINT|SERVICE_POINT|LOCKER|PARCEL_STATION|PICKUP_POINT)/.test(ps) && !/PICKED_UP|COLLECTED/.test(ps)) { stand = 'afhaalpunt'; tekst = 'Ligt klaar bij een DHL-punt'; }
  if (stand === 'bezorgd' && /MAILBOX/.test(ps)) tekst = 'Bezorgd in de brievenbus';
  if (!stand) return { gevonden: false };
  let vak = {};
  if (typeof v.interval === 'string' && v.interval.indexOf('/') > 0 && stand !== 'bezorgd') { const d = v.interval.split('/'); vak = vakUit(d[0], d[1], false); }
  return Object.assign({ gevonden: true, stand, tekst, bezorgd_op: stand === 'bezorgd' ? bezorgdOp : null }, vak);
}
function leesPostnl(j, code) {
  const colli = j && j.colli && typeof j.colli === 'object' ? j.colli : null;
  const x = colli ? (colli[code] || colli[Object.keys(colli)[0]]) : null;
  if (!x || typeof x !== 'object') return { gevonden: false };
  const idx = x.statusPhase && Number(x.statusPhase.index);
  let stand = x.isDelivered || x.isPickedUpAtRetailLocation ? 'bezorgd' : x.isAtRetailLocation ? 'afhaalpunt'
    : idx >= 4 ? 'bezorgd' : idx === 3 ? 'vandaag' : idx === 2 ? 'onderweg' : 'aangemeld';
  const tekst = schoon(x.statusPhase && x.statusPhase.message, 120);
  let vak = {};
  if (stand !== 'bezorgd' && x.eta && x.eta.start) vak = vakUit(x.eta.start, x.eta.end, x.eta.type === 'WholeDay');
  const winkel = x.sender && x.sender.names ? netjes(x.sender.names.companyName || x.sender.names.personName) : null;
  return Object.assign({ gevonden: true, stand, tekst, bezorgd_op: stand === 'bezorgd' ? iso(x.deliveryDate) : null, winkel }, vak);
}
// GLS rstt029: alleen statusInfo en de datum van de laatste gebeurtenis; niet bewezen met een echt pakket (6-11-2026 geen GLS-mail in 21 dagen)
const GLS_STAND = { PREADVICE: 'aangemeld', INTRANSIT: 'onderweg', INWAREHOUSE: 'onderweg', INDELIVERY: 'vandaag', DELIVERED: 'bezorgd', DELIVEREDPS: 'afhaalpunt', NOTDELIVERED: 'onderweg' };
function leesGls(j) {
  const t = j && Array.isArray(j.tuStatus) ? j.tuStatus[0] : null;
  const si = t && t.progressBar && String(t.progressBar.statusInfo || '').toUpperCase();
  if (!si || !GLS_STAND[si]) return { gevonden: false };
  const h = Array.isArray(t.history) ? t.history[0] : null;
  const op = h && /^\d{4}-\d{2}-\d{2}$/.test(String(h.date || '')) ? iso(h.date + 'T' + (/^\d{2}:\d{2}/.test(String(h.time || '')) ? String(h.time).slice(0, 5) : '12:00') + ':00+01:00') : null;
  return { gevonden: true, stand: GLS_STAND[si], tekst: GLS_STAND[si] === 'bezorgd' ? 'Bezorgd' : null, bezorgd_op: GLS_STAND[si] === 'bezorgd' ? op : null };
}
function leesAntwoord(soort, j, code) {
  try {
    if (soort === 'dhl') return leesDhl(j);
    if (soort === 'postnl') return leesPostnl(j, code);
    if (soort === 'gls') return leesGls(j);
  } catch (e) { /* vorm onbekend: niets */ }
  return { gevonden: false };
}

// ── opslag en lijst ──
const SCHEMA = `
CREATE TABLE IF NOT EXISTS zending (id TEXT PRIMARY KEY, sleutel TEXT NOT NULL UNIQUE, vervoerder TEXT NOT NULL, code TEXT, bestelnr TEXT, winkel TEXT, omschrijving TEXT,
  pc TEXT, stand_mail TEXT, mail_tijd TEXT, verwacht_dag TEXT, verwacht_van TEXT, verwacht_tot TEXT,
  stand_volg TEXT, volg_tekst TEXT, volg_dag TEXT, volg_van TEXT, volg_tot TEXT, gevolgd TEXT, bezorgd_op TEXT,
  ververst TEXT, ververs_fout TEXT, ververs_pogingen INTEGER NOT NULL DEFAULT 0, verborgen TEXT, eerste TEXT NOT NULL, bijgewerkt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mail (gmail_id TEXT PRIMARY KEY, zending_id TEXT, tijd TEXT, gezien TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lees_fout (gmail_id TEXT PRIMARY KEY, pogingen INTEGER NOT NULL, laatst TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ronde (id INTEGER PRIMARY KEY, start TEXT NOT NULL, eind TEXT, mails INTEGER, herkend INTEGER, gevolgd INTEGER, volg_fout INTEGER, fout TEXT);
`;
const RANG = { besteld: 0, aangemeld: 1, onderweg: 2, vandaag: 3, afhaalpunt: 4, bezorgd: 5 };

function maak(o) {
  o = o || {};
  const dir = o.dir;
  const klok = typeof o.nu === 'function' ? o.nu : () => Date.now();
  let db = null, laatst = null;
  function open() {
    if (db) return db;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = path.join(dir, 'pakjes.' + 'sqlite');
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(f);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
    db.exec(SCHEMA);
    // review gpt-5.5 ZOU 1: rechten bij elke opening afdwingen (map 700; database en WAL/SHM 600), ook als de map al bestond
    try { fs.chmodSync(dir, 0o700); } catch (e) { /* niets */ }
    ['', '-wal', '-shm'].forEach((x) => { try { if (fs.existsSync(f + x)) fs.chmodSync(f + x, 0o600); } catch (e) { /* niets */ } });
    return db;
  }
  function postcodes() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
      return (Array.isArray(j.postcodes) ? j.postcodes : []).map(postcode).filter(Boolean).slice(0, 5);
    } catch (e) { return []; }
  }
  function nuIso() { return new Date(klok()).toISOString(); }

  // bekende mail-id's (om niet opnieuw te lezen)
  function bekend(ids) {
    const d = open(), q = d.prepare('SELECT 1 FROM mail WHERE gmail_id = ?');
    return new Set((ids || []).filter((i) => q.get(String(i))));
  }
  // één gelezen mail verwerken; m = {gmail_id, van, onderwerp, tekst, datum}
  function verwerkMail(m) {
    const d = open(), nu = nuIso();
    const h = herken(m);
    if (!h) { d.prepare('INSERT OR IGNORE INTO mail (gmail_id, zending_id, tijd, gezien) VALUES (?, NULL, ?, ?)').run(String(m.gmail_id), iso(m.datum), nu); return null; }
    let z = d.prepare('SELECT * FROM zending WHERE sleutel = ?').get(h.sleutel);
    // een 3S-code die eerst als 'onbekend' binnenkwam en nu bij een vervoerder hoort (of andersom): dezelfde rij
    if (!z && h.code) z = d.prepare("SELECT * FROM zending WHERE code = ? AND (vervoerder = 'onbekend' OR ? = 'onbekend')").get(h.code, h.vervoerder);
    const tijd = h.tijd || nu;
    if (!z) {
      const id = idVan(h.sleutel);
      d.prepare(`INSERT INTO zending (id, sleutel, vervoerder, code, bestelnr, winkel, omschrijving, pc, stand_mail, mail_tijd, verwacht_dag, verwacht_van, verwacht_tot, eerste, bijgewerkt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, h.sleutel, h.vervoerder, h.code, h.bestelnr, h.winkel, h.omschrijving, h.pc, h.stand, tijd,
        h.verwacht_dag, h.verwacht_van, h.verwacht_tot, tijd, nu);
      z = { id };
    } else {
      const nieuwer = !z.mail_tijd || tijd >= z.mail_tijd;
      const vervoerder = z.vervoerder === 'onbekend' && h.vervoerder !== 'onbekend' ? h.vervoerder : z.vervoerder;
      const sleutel = vervoerder !== z.vervoerder ? vervoerder + ':' + z.code : z.sleutel;
      // bezorgd blijft bezorgd: een oudere mail die later binnenkomt zet de stand niet terug
      const stand = nieuwer && !(z.stand_mail === 'bezorgd' && RANG[h.stand] < RANG.bezorgd) ? h.stand : z.stand_mail;
      d.prepare(`UPDATE zending SET sleutel = ?, vervoerder = ?, winkel = COALESCE(winkel, ?), omschrijving = COALESCE(omschrijving, ?), pc = COALESCE(pc, ?),
        stand_mail = ?, mail_tijd = ?, verwacht_dag = ?, verwacht_van = ?, verwacht_tot = ?, eerste = MIN(eerste, ?), bijgewerkt = ? WHERE id = ?`).run(
        sleutel, vervoerder, h.winkel, h.omschrijving, h.pc, stand, nieuwer ? tijd : z.mail_tijd,
        nieuwer && h.verwacht_dag ? h.verwacht_dag : z.verwacht_dag, nieuwer && h.verwacht_dag ? h.verwacht_van : z.verwacht_van, nieuwer && h.verwacht_dag ? h.verwacht_tot : z.verwacht_tot,
        tijd, nu, z.id);
    }
    d.prepare('INSERT OR REPLACE INTO mail (gmail_id, zending_id, tijd, gezien) VALUES (?, ?, ?, ?)').run(String(m.gmail_id), z.id, iso(m.datum), nu);
    return z.id;
  }
  // welke pakjes nu bij de vervoerder te verversen zijn (niet bezorgd, niet verborgen, ≤ 30 dagen, wachttijd voorbij)
  function teVolgen(dwing) {
    const d = open(), nu = klok();
    return d.prepare("SELECT * FROM zending WHERE code IS NOT NULL AND vervoerder IN ('postnl','dhl','gls','onbekend') AND verborgen IS NULL").all().filter((z) => {
      if (z.stand_volg === 'bezorgd' || z.bezorgd_op) return false;
      if (Date.parse(z.eerste) < nu - STIL_NA) return false;
      if (z.stand_mail === 'bezorgd' && z.ververst) return false;
      if (dwing) return !z.ververst || Date.parse(z.ververst) < nu - 5 * 60000;
      const wacht = (z.stand_volg === 'vandaag' || z.stand_mail === 'vandaag') ? 20 * 60000 : 60 * 60000;
      const extra = Math.min(z.ververs_pogingen || 0, 6) * 60 * 60000;   // blijft het misgaan: steeds later opnieuw
      return !z.ververst || Date.parse(z.ververst) < nu - wacht - extra;
    });
  }
  // één pakje bij de vervoerder nalezen; haal(url) → {status, json} (server.js). Geeft 'ok' | 'onbekend' | 'fout'.
  async function volg(z, haal) {
    const d = open(), nu = nuIso();
    let uit = 'onbekend', r = null, soort = null, pcGebruikt = null;
    for (const a of volgAdressen(z, postcodes())) {
      let antw = null;
      try { antw = await haal(a.url); } catch (e) { antw = null; }
      if (!antw || (antw.status >= 500 && a.soort !== 'postnl') || antw.status === 429 || antw.status === 403) { uit = 'fout'; continue; }
      const l = leesAntwoord(a.soort, antw.json, z.code);
      if (l.gevonden) { r = l; soort = a.soort; pcGebruikt = a.pc || null; uit = 'ok'; break; }
    }
    if (r) {
      const vervoerder = z.vervoerder === 'onbekend' ? soort : z.vervoerder;
      d.prepare(`UPDATE zending SET vervoerder = ?, sleutel = ?, gevolgd = ?, stand_volg = ?, volg_tekst = ?, volg_dag = ?, volg_van = ?, volg_tot = ?, bezorgd_op = ?,
        winkel = COALESCE(winkel, ?), pc = COALESCE(pc, ?), ververst = ?, ververs_fout = NULL, ververs_pogingen = 0, bijgewerkt = ? WHERE id = ?`).run(
        vervoerder, vervoerder !== z.vervoerder ? vervoerder + ':' + z.code : z.sleutel, soort, r.stand, r.tekst || null, r.verwacht_dag || null, r.verwacht_van || null,
        r.verwacht_tot || null, r.bezorgd_op || (r.stand === 'bezorgd' ? nu : null), r.winkel || null, pcGebruikt, nu, nu, z.id);
    } else {
      d.prepare('UPDATE zending SET ververst = ?, ververs_fout = ?, ververs_pogingen = ververs_pogingen + 1 WHERE id = ?').run(nu, uit, z.id);
    }
    return uit;
  }
  /*
   * ronde({kandidaten, lees, haal, dwing, max}) — kandidaten: [{gmail_id, ontvangen, afzender_domein, onderwerp}] (uit mailman.sqlite);
   * lees(gmail_id) → {van, onderwerp, tekst, datum} of null; haal(url) → {status, json}. Geeft alleen aantallen terug.
   */
  async function ronde(r) {
    const d = open(), start = nuIso();
    const uit = { kandidaten: 0, gelezen: 0, herkend: 0, lees_fout: 0, gevolgd: 0, volg_onbekend: 0, volg_fout: 0 };
    try {
      const k = (r.kandidaten || []).filter(isKandidaat);
      const ken = bekend(k.map((x) => x.gmail_id));
      // review gpt-5.5 MOET 2: een mail die niet te lezen is, komt pas na 30 min × pogingen terug en na 4 pogingen niet meer (anders vult hij elke ronde de 20)
      const nuMs = klok(), lf = d.prepare('SELECT pogingen, laatst FROM lees_fout WHERE gmail_id = ?');
      const wacht = (id) => { const f = lf.get(String(id)); return f && (f.pogingen >= 4 || Date.parse(f.laatst) > nuMs - f.pogingen * 30 * 60000); };
      const nieuw = k.filter((x) => !ken.has(String(x.gmail_id)) && !wacht(x.gmail_id)).sort((a, b) => String(a.ontvangen || '') < String(b.ontvangen || '') ? -1 : 1).slice(0, r.max || 20);
      uit.kandidaten = nieuw.length;
      for (const x of nieuw) {
        let m = null;
        try { m = await r.lees(x.gmail_id); } catch (e) { m = null; }
        if (!m || typeof m.tekst !== 'string') {
          uit.lees_fout++;
          d.prepare('INSERT INTO lees_fout (gmail_id, pogingen, laatst) VALUES (?, 1, ?) ON CONFLICT(gmail_id) DO UPDATE SET pogingen = pogingen + 1, laatst = excluded.laatst').run(String(x.gmail_id), nuIso());
          continue;
        }
        d.prepare('DELETE FROM lees_fout WHERE gmail_id = ?').run(String(x.gmail_id));
        uit.gelezen++;
        if (verwerkMail({ gmail_id: x.gmail_id, van: m.van, onderwerp: m.onderwerp || x.onderwerp, tekst: m.tekst, datum: m.datum || x.ontvangen })) uit.herkend++;
      }
      if (r.haal) {
        for (const z of teVolgen(r.dwing).slice(0, 25)) {
          const v = await volg(z, r.haal);
          if (v === 'ok') uit.gevolgd++; else if (v === 'onbekend') uit.volg_onbekend++; else uit.volg_fout++;
        }
      }
      opruimen();
      d.prepare('INSERT INTO ronde (start, eind, mails, herkend, gevolgd, volg_fout) VALUES (?, ?, ?, ?, ?, ?)').run(start, nuIso(), uit.gelezen, uit.herkend, uit.gevolgd, uit.volg_fout);
      d.prepare('DELETE FROM ronde WHERE id NOT IN (SELECT id FROM ronde ORDER BY id DESC LIMIT 200)').run();
      laatst = Object.assign({ op: nuIso() }, uit);
      return Object.assign({ ok: true }, uit);
    } catch (e) {
      try { d.prepare('INSERT INTO ronde (start, eind, fout) VALUES (?, ?, ?)').run(start, nuIso(), String(e && e.message || e).replace(/\d{4}\s?[A-Z]{2}\b/g, '#').slice(0, 120)); } catch (e2) { /* niets */ }
      return Object.assign({ ok: false, fout: 'ronde faalde' }, uit);
    }
  }
  function opruimen() {
    const d = open(), nu = klok();
    d.prepare('DELETE FROM zending WHERE bijgewerkt < ? AND (bezorgd_op IS NOT NULL OR stand_mail = ? OR verborgen IS NOT NULL OR eerste < ?)').run(
      new Date(nu - WEG_NA).toISOString(), 'bezorgd', new Date(nu - WEG_NA).toISOString());
    d.prepare('DELETE FROM mail WHERE gezien < ?').run(new Date(nu - MAIL_WEG_NA).toISOString());
    d.prepare('DELETE FROM lees_fout WHERE laatst < ?').run(new Date(nu - MAIL_WEG_NA).toISOString());
  }
  // De stand die David ziet: de vervoerder wint als die iets weet, anders de mail. 'vandaag' alleen op de dag zelf.
  function weergave(z, vandaag, pcs) {
    const volgt = !!z.stand_volg;
    let stand = volgt ? z.stand_volg : z.stand_mail;
    if (!volgt && z.stand_mail !== 'bezorgd' && z.bezorgd_op) stand = 'bezorgd';
    if (z.stand_mail === 'bezorgd' && RANG[stand] < RANG.bezorgd && !(volgt && z.ververst && z.mail_tijd && z.ververst > z.mail_tijd)) stand = 'bezorgd';
    let dag = volgt && z.volg_dag ? z.volg_dag : z.verwacht_dag, van = volgt && z.volg_dag ? z.volg_van : z.verwacht_van, tot = volgt && z.volg_dag ? z.volg_tot : z.verwacht_tot;
    if (stand === 'bezorgd') { dag = null; van = null; tot = null; }
    if (stand !== 'bezorgd' && stand !== 'afhaalpunt' && dag === vandaag) stand = 'vandaag';
    else if (stand === 'vandaag' && dag && dag < vandaag) stand = 'onderweg';
    else if (stand === 'vandaag' && !dag) {
      // review gpt-5.5 ZOU 2: "vandaag" zonder dag geldt op de dag van de bron (de volgvraag als de vervoerder de stand gaf, anders de mail)
      const ref = Date.parse((volgt ? z.ververst : z.mail_tijd) || '');
      if (!isFinite(ref) || nlDag(ref) < vandaag) stand = 'onderweg';
    }
    const bezorgd = stand === 'bezorgd' ? (z.bezorgd_op || z.mail_tijd || z.bijgewerkt) : null;
    const laatstT = [z.mail_tijd, z.ververst && !z.ververs_fout ? z.ververst : null, z.bezorgd_op].filter(Boolean).sort().pop() || z.eerste;
    return {
      id: z.id, winkel: z.winkel || null, omschrijving: z.omschrijving || null,
      vervoerder: VERVOERDERS[z.gevolgd || z.vervoerder] || (z.vervoerder === 'onbekend' ? 'PostNL of DHL' : 'Anders'),
      code: z.code || null, bestelnr: z.bestelnr || null, stand, stand_tekst: volgt ? (z.volg_tekst || null) : null,
      verwacht_dag: dag || null, verwacht_van: van || null, verwacht_tot: tot || null, bezorgd_op: bezorgd,
      bron: volgt ? 'vervoerder' : 'mail', ververst: z.ververst && !z.ververs_fout ? z.ververst : null,
      laatst: laatstT, eerste: z.eerste, link: volgLink(z, pcs), verborgen: !!z.verborgen,
    };
  }
  function sorteer(a, b) {
    const r = (x) => x.stand === 'vandaag' ? 0 : x.stand === 'afhaalpunt' ? 1 : x.stand === 'bezorgd' ? 3 : 2;
    if (r(a) !== r(b)) return r(a) - r(b);
    if (a.stand === 'bezorgd') return String(b.bezorgd_op) < String(a.bezorgd_op) ? -1 : 1;
    const da = a.verwacht_dag || '9999', dbb = b.verwacht_dag || '9999';
    if (da !== dbb) return da < dbb ? -1 : 1;
    return String(b.laatst) < String(a.laatst) ? -1 : 1;
  }
  // gekocht = [{id, wens, winkel, datum}] uit Shopper (gekochte zoektochten); koppeling op winkelnaam en datum, geen schrijfactie
  function koppel(lopend, eerder, gekocht, vandaag) {
    const woorden = (s) => String(s || '').toLowerCase().replace(/\.(nl|com|de|be)\b/g, '').split(/[^a-z0-9à-ÿ]+/).filter((w) => w.length >= 3 && !['www', 'shop', 'the', 'van', 'b.v', 'bv'].includes(w));
    const verwacht = [];
    (gekocht || []).forEach((g) => {
      if (!g || !geldigeDag(g.datum) || g.datum < dagPlus(vandaag, -21)) return;
      const gw = woorden(g.winkel);
      const past = lopend.concat(eerder).find((p) => !p.shopper && p.eerste && nlDag(Date.parse(p.eerste)) >= dagPlus(g.datum, -1)
        && gw.length && woorden(p.winkel).some((w) => gw.includes(w)));
      if (past) past.shopper = schoon(g.wens, 160);
      else verwacht.push({ shopper_id: g.id || null, wens: schoon(g.wens, 160), winkel: schoon(g.winkel, 80), gekocht_op: g.datum });
    });
    return verwacht;
  }
  // Amazon laat een deel van de pakjes bezorgen door DHL of Dragonfly: dan bestaan er twee rijen (bestelnummer en volgcode) zonder gedeeld
  // kenmerk (gemeten 6-11: geen bestelnummer in de mail van de vervoerder). Alleen in de weergave samenvoegen: zelfde dag (bezorgd, verwacht
  // of laatste mail) en hooguit 5 dagen verschil in eerste mail; de rij van de vervoerder gaat in die van Amazon op.
  function samenAmazon(ws) {
    const dagVan = (w) => w.bezorgd_op ? nlDag(Date.parse(w.bezorgd_op)) : (w.verwacht_dag || nlDag(Date.parse(w.laatst)));
    const orders = ws.filter((w) => w.vervoerder === 'Amazon' && w.bestelnr);
    const weg = new Set();
    ws.forEach((w) => {
      if (w.vervoerder === 'Amazon' || !/^amazon\b/i.test(String(w.winkel || ''))) return;
      const kand = orders.filter((o) => !o._samen && dagVan(o) === dagVan(w) && Math.abs(Date.parse(o.eerste) - Date.parse(w.eerste)) <= 5 * DAG);
      if (kand.length !== 1) return;
      const o = kand[0];
      o._samen = true; weg.add(w.id);
      o.vervoerder = 'Amazon via ' + w.vervoerder; o.code = w.code; o.samen_id = w.id;
      if (w.bron === 'vervoerder' || RANG[w.stand] > RANG[o.stand]) {
        o.stand = w.stand; o.stand_tekst = w.stand_tekst; o.bron = w.bron; o.ververst = w.ververst; o.link = w.link || o.link;
        o.bezorgd_op = w.bezorgd_op || o.bezorgd_op;
        if (w.verwacht_dag) { o.verwacht_dag = w.verwacht_dag; o.verwacht_van = w.verwacht_van; o.verwacht_tot = w.verwacht_tot; }
      } else if (!o.verwacht_van && w.verwacht_dag === o.verwacht_dag) { o.verwacht_van = w.verwacht_van; o.verwacht_tot = w.verwacht_tot; }
      if (String(w.laatst) > String(o.laatst)) o.laatst = w.laatst;
      o.verborgen = o.verborgen || w.verborgen;
    });
    return ws.filter((w) => !weg.has(w.id)).map((w) => { delete w._samen; return w; });
  }
  // wv2743: een Besteld-rij uit de winkelmail gaat op in het pakje van dezelfde winkel (een woord van de winkelnaam gelijk) dat de vervoerder
  // daarna meldt: eerste mail van de vervoerder tussen 1 dag vóór en 14 dagen na de bestelmail; bij meer pakjes het eerste. Elk pakje neemt
  // hooguit één bestelling op (review Codex MOET 1: anders verdwijnen losse bestellingen van één winkel in één pakje). Alleen weergave.
  function samenWinkel(ws, wn) {
    const woorden = (s) => String(s || '').toLowerCase().replace(/\.(nl|com|de|be|eu)\b/g, '').split(/[^a-z0-9à-ÿ]+/)
      .filter((w) => w.length >= 3 && !['www', 'shop', 'the', 'van', 'b.v', 'bv', 'store', 'online', 'webshop', 'nederland'].includes(w));
    const weg = new Set(), bezet = new Set();
    ws.filter((w) => wn.has(w.id)).sort((a, b) => String(a.eerste) < String(b.eerste) ? -1 : 1).forEach((w) => {
      const ww = woorden(w.winkel), t = Date.parse(w.eerste);
      if (!ww.length || !isFinite(t)) return;
      const kand = ws.filter((p) => !wn.has(p.id) && !bezet.has(p.id) && !(p.vervoerder === 'Amazon' && p.bestelnr) && woorden(p.winkel).some((x) => ww.includes(x))
        && Date.parse(p.eerste) >= t - DAG && Date.parse(p.eerste) <= t + 14 * DAG).sort((a, b) => String(a.eerste) < String(b.eerste) ? -1 : 1);
      if (!kand.length) return;
      const o = kand[0];
      weg.add(w.id); bezet.add(o.id);
      if (!o.samen_id) o.samen_id = w.id;
      if (!o.bestelnr) o.bestelnr = w.bestelnr;
    });
    return ws.filter((w) => !weg.has(w.id));
  }
  function lijst(gekocht) {
    const d = open(), nu = klok(), vandaag = nlDag(nu), pcs = postcodes();
    const lopend = [], eerder = [];
    const rijen = d.prepare('SELECT * FROM zending').all(), wn = new Set(rijen.filter((z) => z.vervoerder === 'winkel').map((z) => z.id));
    for (const w of samenWinkel(samenAmazon(rijen.map((z) => weergave(z, vandaag, pcs))), wn)) {
      // bezorgd: 7 dagen in de lijst; niet bezorgd en 30 dagen stil (bij een vervoerder die we volgen) of 10 dagen stil (alleen mail): naar Eerder
      const volgbaar = ['PostNL', 'DHL', 'GLS', 'PostNL of DHL'].includes(w.vervoerder) || w.bron === 'vervoerder';
      const oud = w.stand === 'bezorgd' ? Date.parse(w.bezorgd_op) < nu - EERDER_NA : Date.parse(w.laatst) < nu - (volgbaar ? STIL_NA : STIL_MAIL_NA);
      (w.verborgen || oud ? eerder : lopend).push(w);
    }
    lopend.sort(sorteer);
    eerder.sort((a, b) => String(b.laatst) < String(a.laatst) ? -1 : 1);
    const verwacht = koppel(lopend, eerder, gekocht, vandaag);
    const r = d.prepare('SELECT start, eind, fout FROM ronde ORDER BY id DESC LIMIT 1').get();
    return { status: 200, body: { ok: true, lopend, eerder: eerder.slice(0, 60), verwacht, laatste_ronde: r ? (r.eind || r.start) : null, ronde_fout: r && r.fout ? true : false } };
  }
  function verberg(id, dat) {
    if (!/^[0-9a-f]{12}$/.test(String(id))) return { status: 400, body: { ok: false, fout: 'ongeldig pakje' } };
    if (!dat || typeof dat.verborgen !== 'boolean') return { status: 400, body: { ok: false, fout: 'verborgen moet true of false zijn' } };
    const d = open(), nu = nuIso();
    const z = d.prepare('SELECT id FROM zending WHERE id = ?').get(id);
    if (!z) return { status: 404, body: { ok: false, fout: 'pakje niet gevonden' } };
    d.prepare('UPDATE zending SET verborgen = ?, bijgewerkt = ? WHERE id = ?').run(dat.verborgen ? nu : null, nu, id);
    if (typeof dat.samen === 'string' && /^[0-9a-f]{12}$/.test(dat.samen)) d.prepare('UPDATE zending SET verborgen = ?, bijgewerkt = ? WHERE id = ?').run(dat.verborgen ? nu : null, nu, dat.samen);
    return { status: 200, body: { ok: true, id, verborgen: dat.verborgen } };
  }
  function info() {
    try {
      const d = open(), n = (q, ...a) => d.prepare(q).get(...a).n;
      const r = d.prepare('SELECT start, eind, mails, herkend, gevolgd, volg_fout, fout FROM ronde ORDER BY id DESC LIMIT 1').get();
      return { aan: true, pakjes: n('SELECT COUNT(*) AS n FROM zending'), niet_bezorgd: n("SELECT COUNT(*) AS n FROM zending WHERE bezorgd_op IS NULL AND COALESCE(stand_volg, stand_mail) <> 'bezorgd' AND verborgen IS NULL"),
        mails: n('SELECT COUNT(*) AS n FROM mail'), postcodes: postcodes().length,
        laatste_ronde: r ? { op: r.eind || r.start, mails: r.mails, herkend: r.herkend, gevolgd: r.gevolgd, volg_fout: r.volg_fout, fout: !!r.fout } : null };
    } catch (e) { return { aan: true, fout: true }; }
  }
  function sluit() { if (db) { try { db.close(); } catch (e) { /* niets */ } db = null; } }
  return { herken, isKandidaat, ronde, lijst, verberg, info, sluit, verwerkMail, teVolgen, volg, _laatst: () => laatst };
}

module.exports = { maak, herken, isKandidaat, leesDhl, leesPostnl, leesGls, volgAdressen, volgLink, dagUit, tijdvakUit, standUit, STANDEN };
