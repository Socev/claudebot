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
const VERVOERDERS = { postnl: 'PostNL', dhl: 'DHL', dpd: 'DPD', gls: 'GLS', ups: 'UPS', amazon: 'Amazon', dragonfly: 'Dragonfly', fedex: 'FedEx', gofo: 'GOFO', anders: 'Anders', winkel: 'Nog geen bezorger' };
const EERDER_NA = 7 * DAG, STIL_NA = 30 * DAG, STIL_MAIL_NA = 10 * DAG, WEG_NA = 90 * DAG, MAIL_WEG_NA = 60 * DAG;
// wv4147 (2C89 e): een pakje dat over zijn dag is of te lang niets laat horen, staat onder Vraagt aandacht (in plaats van stil naar Eerder);
// te lang = 5 dagen als alleen de mail iets zegt, 10 dagen als de pod het zelf volgt; na 30 dagen stilte toch naar Eerder. Na een week
// in Vraagt aandacht één kaart in Voor jou (kaartPlan).
const AANDACHT_MAIL_NA = 5 * DAG, AANDACHT_VOLG_NA = 10 * DAG, AANDACHT_KAART_NA = 7 * DAG;
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
/*
 * wv4147 (2C89 a; David 14-11: "waar gaat hij heen?"): thuis of de praktijk. adressen = [{postcode, naam: 'thuis'|'praktijk', plaatsen: []}]
 * uit config.json. Volgorde: (1) de postcode van het pakje (PostNL-volgen of de jouw.postnl.nl-link; een andere geldige = 'ander'),
 * (2) de plaats uit het adres na een adreskop in de mail, (3) precies één van Davids postcodes in de mailtekst, (4) precies één van de
 * plaatsnamen als los woord. Twee namen tegelijk = niets. Alleen het woord wordt bewaard, nooit een postcode uit de tekst.
 */
const BESTEMMING_NAMEN = ['thuis', 'praktijk'];
function bestemmingVanPc(pc, adressen) {
  const q = postcode(pc);
  if (!q || !Array.isArray(adressen) || !adressen.length) return null;
  const a = adressen.find((x) => postcode(x.postcode) === q);
  return a ? a.naam : 'ander';
}
function woordIn(t, w) { return new RegExp('(^|[^a-zà-ÿ])' + w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-zà-ÿ])').test(t); }
function bestemmingUit(o, adressen) {
  if (!Array.isArray(adressen) || !adressen.length) return null;
  const vanPc = o && o.pc ? bestemmingVanPc(o.pc, adressen) : null;
  if (vanPc) return vanPc;
  const een = (namen) => { const u = Array.from(new Set(namen)); return u.length === 1 ? u[0] : null; };
  const plaatsVan = (t) => een(adressen.filter((a) => (a.plaatsen || []).some((p) => woordIn(t, p))).map((a) => a.naam));
  if (o && o.adres) { const r = plaatsVan(String(o.adres).toLowerCase()); if (r) return r; }
  const tekst = String(o && o.tekst || '').slice(0, MAX_TEKST);
  const plat = tekst.replace(/\s+/g, '').toUpperCase();
  const r3 = een(adressen.filter((a) => { const q = postcode(a.postcode); return q && new RegExp('(^|[^0-9])' + q).test(plat); }).map((a) => a.naam));
  if (r3) return r3;
  return plaatsVan(tekst.toLowerCase());
}

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
  // wv3011: "dinsdag, 10/11/2026" (FedEx) / "10-11-2026": dag-maand-jaar; staat er een weekdag bij die niet klopt, dan niet
  m = /\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2})\b/.exec(s);
  if (m) {
    const d = m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
    const wd = /\b(zondag|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag)\b/.exec(s);
    if (geldigeDag(d) && (!wd || new Date(d + 'T12:00:00Z').getUTCDay() === WEEKDAGEN[wd[1]])) return d;
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
  'coolblue.nl', 'shopifyemail.com', 'budbee.com', 'trunkrs.nl', 'homerr.com', 'fedex.com', 'tnt.com',
  'gls-netherlands.com', 'gofo.com', 'gofoexpress.nl', 'intrapost-mailer.nl'];
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
const BESTEL_ONDERWERP = /(bestelbevestiging|orderbevestiging|verzendbevestiging|bevestiging van (je|jouw|uw) (bestelling|order)|(je|jouw|uw) bestelling (bij [^\n]{1,40}? )?(is )?(ontvangen|bevestigd|geplaatst|verzonden|onderweg)|bedankt voor (je|jouw|uw) (bestelling|aankoop|order)|order confirm|bestellbest[äa]tigung|versandbest[äa]tigung|bestellung[^\n]{0,40}(best[äa]tigt|eingegangen|versandt))/i;
const BESTEL_NIET_DOMEIN = ['ah.nl', 'thuisbezorgd.nl', 'jumbo.com', 'picnic.app', 'crisp.nl', 'flink.com', 'ubereats.com', 'uber.com', 'deliveroo.nl', 'google.com',
  'apple.com', 'microsoft.com', 'steampowered.com', 'gmail.com', 'googlemail.com', 'socev.dev', 'paypal.com', 'paypal.nl', 'booking.com', 'airbnb.com', 'ns.nl'];
// wv3011 (weekmeting 13-11: drie pizza-orders bleven 10 dagen als Besteld staan): maaltijd- en boodschappenbezorgers zijn nooit een pakje,
// op domein én op afzendernaam (een bezorger mailt soms via een eigen of gedeeld mailplatform).
const MAALTIJD_DOMEIN = ['newyorkpizza.nl', 'dominos.nl', 'dominos.com', 'burgerking.nl', 'mcdonalds.nl', 'mcdonalds.com', 'takeaway.com', 'just-eat.nl', 'justeat.com',
  'just-eat.com', 'thuisbezorgd.nl', 'hellofresh.nl', 'hellofresh.com', 'marleyspoon.nl', 'marleyspoon.com', 'ekoplaza.nl', 'kfc.nl', 'pizzahut.nl', 'ubereats.com',
  'deliveroo.nl', 'foodora.nl', 'smullers.nl', 'febo.nl', 'crisp.nl', 'picnic.app', 'flink.com', 'getir.com', 'zapp.nl'];
const MAALTIJD_NAAM = /(pizza|domino'?s|burger ?king|mc ?donald'?s|takeaway|just ?eat|thuisbezorgd|hello ?fresh|marley ?spoon|ekoplaza|uber ?eats|deliveroo|foodora|\bkfc\b|smullers|\bfebo\b)/i;
function isMaaltijd(dom, naam) { return MAALTIJD_DOMEIN.some((s) => op(dom, s)) || MAALTIJD_NAAM.test(String(naam || '')) || MAALTIJD_NAAM.test(dom.replace(/[.-]/g, ' ')); }
const BESTEL_NIET_ONDERWERP = /(factuur|invoice|rechnung|retour|annuler|geannuleerd|storn|minimum|abonnement|lidmaatschap|ticket|reserver|boeking|cadeaukaart|tegoed|download|licentie|domein|hosting|^\s*(fwd?|doorgestuurd|wg)\s*:)/i;
const BESTEL_FYSIEK = /(bezorgadres|afleveradres|verzendadres|leveradres|lieferadresse|versandadresse|shipping address|delivery address|verzendkosten|bezorgkosten|versandkosten|verzendmethode|bezorgmethode|bezorgoptie|verwachte (bezorg|lever)|bezorgmoment|levertijd|lieferzeit|wordt (je|jouw|uw) (bestelling|pakket) (bezorgd|verzonden|geleverd)|track\s*(&amp;|&|en|and)\s*trace|sorteercentrum|zodra (je|jouw|uw) (bestelling|pakket|order) (is |wordt )?(verzonden|verstuurd))/i;
const BESTEL_NR = /(?:bestelnummer|ordernummer|bestelnr\.?|ordernr\.?|order\s*(?:number|nr\.?|#)|bestellnummer|bestelling|bestellung|order)(?:\s+is)?\s*[:#]?\s*#?\s*([A-Z0-9][A-Z0-9-]{3,24})\b/i;
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
  if (!bestelnr) { const k = /\b([A-Z]{2,6}-?\d{4,15})\b/.exec(ond); if (k) bestelnr = k[1]; }   // wv3011: "orderbevestiging ORD12345 van …"
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
    adres: adresUit(tekst), detail: detailUit(ond, tekst),   // wv3062
  };
}

// codes per vervoerder. 3S-codes gebruiken PostNL en DHL allebei: de afzender of de link beslist, anders 'onbekend' (beide proberen).
const C = {
  s3: /\b(3S[A-Z]{3,5}\d{6,14})\b/,
  postnlInt: /\b([A-Z]{2}\d{9}NL)\b/,
  dhl: /\b(JJD\d{14,26}|JVGL\d{10,26}|JD\d{18})\b/,
  ups: /\b(1Z[0-9A-Z]{16})\b/,
  dragonfly: /\b(AMZNL\d{9,15}|INTRA\d{9,16}DFY)\b/,   // wv3535: INTRA…DFY = zending van Intrapost die Dragonfly bezorgt
  dpd: /\b(0\d{13}|\d{14})\b/,
  gls: /\b(\d{11,12})\b/,
};
const LINK = [
  ['postnl', /jouw\.postnl\.nl\/track-and-trace\/([0-9A-Z]{9,30})-NL-([1-9]\d{3}\s?[A-Z]{2})/i],
  ['postnl', /postnl\.nl\/(?:track-and-trace|tracktrace)[^\s"']*?[?&/](?:barcode=|b=)?(3S[A-Z]{3,5}\d{6,14})/i],
  ['dhl', /(?:dhlecommerce|dhlparcel)\.nl\/[^\s"']*?[?&](?:tc|key|tt)=([0-9A-Z]{10,30})/i],
  ['dhl', /dhl\.com\/[^\s"']*?tracking-id=([0-9A-Z]{10,30})/i],
  ['dpd', /dpd\.(?:de|nl|com)\/[^\s"']*?(?:query=|parcelNumber=|parcelno=|parcel\/)(\d{14})/i],
  ['gls', /gls[^\s"']*?(?:match=|parcelNo=|trackingNumber=)(\d{11,14})\b/i],
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

// wv3062 (David 14-11: "specifiekere status-meldingen per pakje"): een tussenstand in gewone taal, alleen als de mail het zelf zegt. Het onderwerp
// telt altijd; uit de lijf-tekst alleen de zinnen die gemeten zijn (14-11: GOFO sorteercentrum, Amazon brievenbus, winkel "door onze bezorgdienst
// opgehaald"); de rest van de lijf-tekst is standaardtekst ("Niet thuis? … bij de buren") en zegt niets over dit pakje.
const DETAIL_ONDERWERP = [
  [/(retour (naar|aan) (de )?afzender|teruggestuurd naar (de )?afzender|return(ed)? to sender|zur[üu]ck an (den )?absender)/i, 'Gaat terug naar de afzender'],
  [/(ingeklaard|customs cleared|verzollt)/i, 'Ingeklaard bij de douane'],
  [/(\bdouane\b|\bcustoms\b|\bzoll\b)/i, 'Bij de douane'],
  [/(bezorgpoging|niet (thuis )?(aan)?getroffen|konden (je|jouw|uw) (pakket|zending) niet (af)?leveren|delivery attempt|zustellversuch)/i, 'Bezorgpoging mislukt'],
  [/(vertraagd|vertraging|delayed|versp[äa]tet|verz[öo]gert)/i, 'Vertraagd'],
  [/(sorteercentrum|sorting cent(er|re)|sortierzentrum|verteilzentrum|distributiecentrum)/i, 'Bij het sorteercentrum'],
  [/(hebben (je|jouw|uw) (pakket|zending) ontvangen|opgehaald door (de )?(bezorger|vervoerder))/i, 'Bij de bezorger'],
  [/(klaar voor verzending|ready to ship)/i, 'Klaar voor verzending'],
  [/(bij (de |je |jouw |uw )?buren|neighbou?rs?\b|nachbar)/i, 'Bij de buren'],   // wv3535: ook "bij uw buren" (Dragonfly)
  [/(brievenbus|letterbox|briefkasten)/i, 'In de brievenbus'],
];
const DETAIL_TEKST = [
  [/aangekomen in ons sorteercentrum/i, 'Bij het sorteercentrum'],
  [/pakket is achtergelaten in (de |je |jouw )?brievenbus/i, 'In de brievenbus'],
  [/door onze bezorgdienst opgehaald/i, 'Bij de bezorger'],
];
const DETAIL_BEZORGD = ['Bij de buren', 'In de brievenbus'];   // hoort bij Bezorgd; de andere alleen zolang het pakje niet bezorgd is
function detailUit(ond, tekst) {
  for (const [re, w] of DETAIL_ONDERWERP) if (re.test(ond)) return w;
  for (const [re, w] of DETAIL_TEKST) if (re.test(tekst)) return w;
  return null;
}
// wv3062 (David 14-11: "afleveradres: waar gaat hij heen"): straat + huisnummer en plaats na een adreskop in de mail (gemeten 14-11 bij DPD, GLS,
// UPS, FedEx, Sendcloud, Intrapost en webwinkels). Geen naam en geen postcode: de postcode gaat nooit naar de app (zie pc). Alleen op het scherm.
const ADRES_KOP = /(bezorgadres|afleveradres|leveradres|leveringsadres|verzendadres|lieferadresse|versandadresse|shipping address|delivery address|ship to|afgeleverd aan|verzonden naar|naar het volgende adres)\s*:?/gi;
const STRAAT = /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.'’ -]{1,50}?)\s+(\d{1,5}(?:\s?[a-zA-Z]{1,2}\b|[- ]\d{1,4})?)$/;
const PLAATS = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’ -]{1,29}$/;
function adresUit(tekst) {
  const t = String(tekst || '').slice(0, MAX_TEKST).replace(/\r/g, '').replace(/&nbsp;|\u00a0/g, ' ').replace(/[*_]/g, '');
  const re = new RegExp(ADRES_KOP.source, 'gi');
  let m, beste = null;
  while ((m = re.exec(t)) && !beste) {
    const delen = t.slice(re.lastIndex, re.lastIndex + 240).split(/\n|\s{3,}|,\s*|\s+-\s+/).map((x) => x.trim()).filter(Boolean).slice(0, 6);
    let straat = null, plaats = null, pcGezien = false;
    for (let i = 0; i < delen.length && !plaats; i++) {
      const d = delen[i];
      if (/^https?:|@|\[|^\(?https?/i.test(d)) break;
      const p = /\b[1-9]\d{3}\s?[A-Z]{2}\b/.exec(d);
      if (p) {
        pcGezien = true;
        const voor = d.slice(0, p.index).trim(), na = d.slice(p.index + p[0].length).replace(/^[\s(]+|[\s)]+$/g, '').trim();
        if (!straat && STRAAT.test(voor)) straat = voor;
        if (PLAATS.test(na)) plaats = na;
        else if (i > 0 && delen[i - 1] !== straat && PLAATS.test(delen[i - 1]) && straat) plaats = delen[i - 1];
        else if (delen[i + 1] && /^[A-ZÀ-Ý][A-ZÀ-Ý' -]{1,29}$/.test(delen[i + 1])) plaats = delen[i + 1];
        break;
      }
      const q = /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’ -]{1,29})\s+[1-9]\d{3}$/.exec(d);   // FedEx: "Plaats 1234"
      if (q && straat) { plaats = q[1]; break; }
      if (!straat && STRAAT.test(d)) straat = d;
    }
    if (straat || (plaats && pcGezien)) beste = [straat ? netjes(straat) : null, plaats ? netjes(plaats) : null].filter(Boolean).join(', ');
  }
  return beste ? schoon(beste, 120) : null;
}

// wv3535 (meting 20-11): de Dragonfly-mail "bij je buren afgeleverd" noemt de code nergens leesbaar; hij staat alleen als "sub" in het token van de
// links (context=<kop>.<inhoud>.<handtekening>, inhoud = base64url-json). Alleen een geldige Dragonfly-code komt eruit; het token wordt niet bewaard.
function dragonflyTokenCode(tekst) {
  const re = /context=eyJ[A-Za-z0-9_-]{5,400}\.(eyJ[A-Za-z0-9_-]{5,2000})/g;
  let m, n = 0;
  while ((m = re.exec(String(tekst || ''))) && n++ < 10) {
    try { const sub = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')).sub; if (typeof sub === 'string' && DRAGONFLY_CODE.test(sub)) return sub; } catch (e) { /* geen json */ }
  }
  return null;
}
// woorden van een winkelnaam om rijen van dezelfde winkel te herkennen (samenWinkel, Intrapost-mail in de winkelrij)
function winkelWoorden(s) {
  return String(s || '').toLowerCase().replace(/\.(nl|com|de|be|eu)\b/g, '').split(/[^a-z0-9à-ÿ]+/)
    .filter((w) => w.length >= 3 && !['www', 'shop', 'the', 'van', 'b.v', 'bv', 'store', 'online', 'webshop', 'nederland'].includes(w));
}

/*
 * herken({van, onderwerp, tekst, datum}) → null (geen pakje) of
 *   { sleutel, vervoerder, code, bestelnr, winkel, omschrijving, stand, verwacht_dag, verwacht_van, verwacht_tot, pc, adres, detail }
 * pc (postcode) alleen uit een PostNL-link in de mail; het veld gaat nooit naar de app of een log.
 */
function herken(m) {
  if (!m || typeof m !== 'object') return null;
  const ond = schoon(m.onderwerp, 300) || '', tekst = String(m.tekst || '').slice(0, MAX_TEKST);
  const dom = domein(m.van), naam = weergaveNaam(m.van);
  const tms = Date.parse(m.datum);
  const mailDag = isFinite(tms) ? nlDag(tms) : nlDag(Date.now());
  const alles = ond + '\n' + tekst;
  if (dom && isMaaltijd(dom, naam)) return null;
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
    // wv3535 (meting 20-11): DHL Paket (dhl.de) mailt in het Engels zonder code in het onderwerp; de code staat in de volglink (piececode= of pid=)
    const k = /\(([0-9A-Z]{10,30})\)\s*$/.exec(ond) || C.dhl.exec(alles) || C.s3.exec(alles) || /[?&](?:piececode|pid)=([0-9A-Z]{10,30})\b/i.exec(tekst);
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
  } else if (op(dom, 'gls-info.nl', 'gls-group.eu', 'gls-group.com', 'gls.nl', 'gls-netherlands.com')) {
    // wv3011: GLS Nederland mailt van gls-netherlands.com met een pakketnummer van 14 cijfers in de link (parcelNo=); de stand staat dan
    // vaak alleen in de tekst ("Je pakket is bezorgd!") en de winkel als "pakket van <winkel> bezorgd"
    vervoerder = 'gls';
    const k = /parcelNo=(\d{11,14})\b/i.exec(tekst) || /(?:pakketnummer|parcel number|paketnummer|track(?:ing)?[- ]?(?:nummer|number|code)|zending)\D{0,20}(\d{11,14})\b/i.exec(alles);
    code = k ? k[1] : null;
    stand = standUit(ond);
    if (!stand && /(je pakket is bezorgd|hebben (vandaag )?(jouw|je) pakket[^.\n]{0,80}\bbezorgd\b)/i.test(tekst)) stand = 'bezorgd';
    const w = /pakket van\s+([^.\n]{2,60}?)\s+(?:bezorgd|afgeleverd)\b/i.exec(tekst);
    winkel = w ? w[1] : null;
    dagTekst = ond + ' ' + ((/(?:\bop\s+[a-z]+dag\s+\d{1,2}\s+[a-z]+(?:\s+20\d{2})?|verwacht|bezorg)[^\n]{0,80}/i.exec(tekst) || [])[0] || '');
  } else if (op(dom, 'ups.com')) {
    vervoerder = 'ups';
    const k = C.ups.exec(alles);
    code = k ? k[1] : null;
    stand = standUit(ond);
    dagTekst = ond + ' ' + ((/(?:verwacht|scheduled delivery|geplande levering)[^\n]{0,80}/i.exec(tekst) || [])[0] || '');
  } else if (op(dom, 'dragonflyinternational.com', 'dragonflyshipping.nl')) {
    vervoerder = 'dragonfly';
    const k = C.dragonfly.exec(alles);
    code = k ? k[1] : (dragonflyTokenCode(tekst) || null);
    winkel = code && /^INTRA/.test(code) ? null : 'Amazon';   // wv3535: INTRA = Intrapost (afzender uit de Intrapost-mail, zie koppelIntra)
    stand = standUit(ond);
    dagTekst = stand === 'vandaag' ? 'vandaag' : null;
  } else if (op(dom, 'fedex.com')) {
    // wv3011 (weekmeting 13-11: FedEx-mails stonden er niet in): code uit de volglink, "Tracking-id" of het onderwerp; winkel uit
    // "zending van <winkel> is …"; dag uit "Geplande leverdatum". FedEx heeft geen openbare volgvraag zonder sleutel: stand uit de mail.
    vervoerder = 'fedex';
    const k = /fedextrack\/?\?(?:[^\s"'\]]*?&)?(?:t|trknbr|tracknumbers)=(\d{12,15})\b/i.exec(tekst) || /tracking[- ]?(?:id|nummer|number)\s*[:\n]?\s*(\d{12,15})\b/i.exec(tekst) || /\b(\d{12}|\d{15})\b/.exec(ond);
    code = k ? k[1] : null;
    const w = /(?:zending van|shipment from)\s+([^\n]{2,60}?)\s+is\b/i.exec(tekst);
    winkel = w ? w[1] : null;
    stand = standUit(ond);
    dagTekst = stand === 'vandaag' ? 'vandaag' : ((/(?:geplande leverdatum|verwachte leverdatum|scheduled delivery date)\s*\n?\s*([^\n]{0,40})/i.exec(tekst) || [])[1] || null);
  } else if (op(dom, 'gofo.com', 'gofoexpress.nl')) {
    // wv3011: GOFO (pakketdienst, sinds 11-2026 in de mail); code GF..+cijfers, stand uit de mail ("aangekomen in ons sorteercentrum" = onderweg)
    vervoerder = 'gofo';
    const k = /\b(GF[A-Z]{2}\d{10,20})\b/.exec(alles);
    code = k ? k[1] : null;
    stand = standUit(ond);
    if ((!stand || stand === 'aangemeld') && /sorteercentrum/i.test(tekst)) stand = 'onderweg';
    dagTekst = ond + ' ' + ((/(?:verwacht|bezorgmoment|bezorgdag)[^\n]{0,80}/i.exec(tekst) || [])[0] || '');
  } else if (op(dom, 'intrapost-mailer.nl')) {
    // wv3011: Intrapost stuurt namens de afzender (zoals een zorgleverancier) een volgbericht met een eigen zendingnummer (jaar/nummer); de
    // bezorging gaat via een vervoerder (gemeten 9-11: GLS, mailde een dag later). Dus een winkelrij "onderweg" met de afzender als winkel,
    // die opgaat in het pakje van de vervoerder zodra die mailt (samenWinkel). Postcode en adres uit het onderwerp worden niet bewaard.
    // wv3535 (meting 20-11): sinds 11-2026 ook het bestelnummer van de winkel ("Track & Trace ORD12345 <postcode> <plaats> (Winkel)"); dat
    // nummer is gelijk aan dat in de bestelmail, zodat de Intrapost-mail in die winkelrij opgaat (verwerkMail, zelfde bestelnr en winkel).
    const n = /track\s*&(?:amp;)?\s*trace\s+(\d{4})\/(\d{3,10})\b/i.exec(ond) || /zending\s+(\d{4})\/(\d{3,10})\b/i.exec(tekst);
    const o = n ? null : /track\s*&(?:amp;)?\s*trace\s+([A-Z]{0,5}\d{3,12})\b/i.exec(ond) || /zending\s+([A-Z]{1,5}\d{3,12})\b/i.exec(tekst);
    if (!n && !o) return null;
    const nr = n ? n[1] + '-' + n[2] : o[1].toUpperCase();
    const w = /\(([^()]{2,80})\)\s*$/.exec(ond);
    const afz = w ? w[1].replace(/[\s.,]*\b(B\.?\s?V|N\.?\s?V)\b[\s.]*$/i, '').trim() : '';
    return {
      sleutel: 'winkel:' + dom + ':' + nr, vervoerder: 'winkel', code: null, bestelnr: nr, winkel: netjes(afz) || 'Intrapost', omschrijving: null, via: 'intrapost',
      stand: 'onderweg', verwacht_dag: null, verwacht_van: null, verwacht_tot: null, pc: null, tijd: isFinite(tms) ? new Date(tms).toISOString() : null,
      adres: adresUit(tekst), detail: detailUit(ond, tekst),   // wv3062
    };
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
      if (k) { code = k[1]; vervoerder = /^1Z/.test(code) ? 'ups' : /^(AMZNL|INTRA)/.test(code) ? 'dragonfly' : 'dhl'; }
    }
    if (!code) {
      const k = C.s3.exec(alles) || C.postnlInt.exec(alles);
      if (k) { code = k[1]; vervoerder = /NL$/.test(code) ? 'postnl' : (vervoerder || 'onbekend'); }
    }
    if (!code) {
      // wv3011: ook "Verzendnummer: …" met "Vervoerder: DPD" (verzendmail van een webwinkel, zoals een medische groothandel)
      const k = /(?:track(?:ing)?[- ]?(?:nummer|number|code)|track\s*&\s*trace(?:-?code)?|sendungsnummer|zendingsnummer|zendingnummer|verzendnummer|pakketnummer|parcel number)\s*[:#]?\s*([0-9A-Z]{8,30})\b/i.exec(tekst);
      const v = /\bvervoerder\s*:?\s*(postnl|dhl|dpd|gls|ups|fedex|gofo)\b/i.exec(tekst);
      if (k && /\d/.test(k[1])) { code = k[1].toUpperCase(); vervoerder = vervoerder || (v ? v[1].toLowerCase() : 'anders'); }
    }
    if (!code) return vervoerder ? null : winkelBestelling(ond, tekst, dom, naam, tms, mailDag);
    if (!['postnl', 'dhl', 'dpd', 'gls', 'ups', 'dragonfly', 'fedex', 'gofo'].includes(vervoerder) || !winkel) {
      const stam = dom ? dom.split('.').slice(-2, -1)[0] || '' : '', inOnd = stam.length >= 3 ? new RegExp('\\b(' + stam.replace(/[^a-z0-9-]/gi, '') + ')\\b', 'i').exec(ond) : null;
      winkel = winkel || naam || (inOnd ? inOnd[1] : null) || (dom ? dom.replace(/^(e?mail|t|m|nl|info|noreply|news|edm)\./, '') : null);
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
    adres: adresUit(tekst), detail: detailUit(ond, tekst),   // wv3062
  };
}

// ── volgen bij de vervoerder (alleen openbare pagina's, gemeten 6-11-2026; GOFO en Dragonfly 14-11-2026, wv3078) ──
const GOFO_CODE = /^GF[A-Z]{2}\d{10,20}$/, DRAGONFLY_CODE = /^(?:AMZNL\d{9,15}|INTRA\d{9,16}DFY)$/;   // wv3535: INTRA gemeten 20-11 (zelfde volgvraag)
function volgAdressen(z, postcodes) {
  const c = encodeURIComponent(z.code || '');
  if (!z.code) return [];
  const dhl = { soort: 'dhl', url: 'https://my.dhlecommerce.nl/receiver-parcel-api/track-trace?key=' + c };
  const pnl = (pcs) => pcs.map((pc) => ({ soort: 'postnl', pc, url: 'https://jouw.postnl.nl/track-and-trace/api/trackAndTrace/' + c + '-NL-' + pc + '?language=nl' }));
  const pcs = [];
  [z.pc].concat(postcodes || []).forEach((p) => { const q = postcode(p); if (q && !pcs.includes(q)) pcs.push(q); });
  if (z.vervoerder === 'dhl') return [dhl];
  if (z.vervoerder === 'postnl') return /NL$/.test(z.code) ? pnl(pcs) : pnl(pcs);
  if (z.vervoerder === 'gls' && !/^\d{11,12}$/.test(z.code)) return [];   // wv3011: GLS NL (14 cijfers) kent rstt029 niet (404, gemeten 13-11)
  if (z.vervoerder === 'gls') return [{ soort: 'gls', url: 'https://gls-group.com/app/service/open/rest/NL/nl/rstt029?match=' + c }];
  // wv3078 (gemeten 14-11-2026 met echte codes): GOFO en Dragonfly hebben een openbare json-volgvraag zonder login of sleutel. GOFO wil een POST met
  // de code in de body (de enige POST; server.js pakjesHaal stuurt body als json). DPD (geen verbinding vanaf de pod), UPS en FedEx (403) niet.
  if (z.vervoerder === 'gofo') return GOFO_CODE.test(z.code) ? [{ soort: 'gofo', url: 'https://www.gofo.com/nl/open-api/official/track/queryTrackV2', body: { numberList: [z.code] } }] : [];
  if (z.vervoerder === 'dragonfly') return DRAGONFLY_CODE.test(z.code) ? [{ soort: 'dragonfly', url: 'https://dragonflyshipping.nl/cfworker/v3/tracking/' + c + '/' }] : [];
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
  if (v === 'gls') return /^\d{13,14}$/.test(z.code) ? 'https://www.gls-info.nl/tracking/ttlink?parcelNo=' + c + '&lang=NL' : 'https://gls-group.com/NL/nl/pakket-volgen?match=' + c;
  if (v === 'fedex') return 'https://www.fedex.com/fedextrack/?trknbr=' + c;
  if (v === 'gofo') return 'https://www.gofoexpress.nl/tracking-results/?id=' + c;
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
// wv3078: de jongste gebeurtenis geeft een preciezere tussenstand (sleutels gemeten 14-11 in echte antwoorden; andere sleutels = de fasetekst)
const DHL_STAP = { PARCEL_SORTED_AT_HUB: 'Bij het sorteercentrum', PARCEL_ARRIVED_AT_LOCAL_DEPOT: 'Bij het bezorgdepot', OUT_FOR_DELIVERY: 'Bezorger is onderweg' };
function leesDhl(j) {
  const r = Array.isArray(j) ? j[0] : null, v = r && r.view;
  if (!v || typeof v !== 'object') return { gevonden: false };
  let fase = null;
  (Array.isArray(v.phaseDisplay) ? v.phaseDisplay : []).forEach((p) => { if (p && p.completed && DHL_FASE[p.phase]) fase = p.phase; });
  const sleutels = [];
  let bezorgdOp = null, jongste = null, jongsteT = -Infinity;
  (Array.isArray(v.phases) ? v.phases : []).forEach((p) => (Array.isArray(p && p.events) ? p.events : []).forEach((e) => {
    if (e && typeof e.key === 'string') sleutels.push(e.key);
    const t = e ? Date.parse(e.timestamp) : NaN;
    if (e && typeof e.key === 'string' && isFinite(t) && t > jongsteT) { jongsteT = t; jongste = e.key; }
    if (p.phase === 'DELIVERED' && e && e.timestamp && !bezorgdOp) bezorgdOp = iso(e.timestamp);
  }));
  let stand = fase ? DHL_FASE[fase] : null, tekst = fase ? DHL_TEKST[fase] : null;
  const ps = sleutels.concat([String(v.message || '')]).join(' ');
  if (stand !== 'bezorgd' && /(PARCELSHOP|SERVICEPOINT|SERVICE_POINT|LOCKER|PARCEL_STATION|PICKUP_POINT)/.test(ps) && !/PICKED_UP|COLLECTED/.test(ps)) { stand = 'afhaalpunt'; tekst = 'Ligt klaar bij een DHL-punt'; }
  if (stand === 'bezorgd' && /MAILBOX/.test(ps)) tekst = 'Bezorgd in de brievenbus';
  if ((stand === 'onderweg' || stand === 'vandaag') && jongste && DHL_STAP[jongste]) tekst = DHL_STAP[jongste];   // wv3078
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
  const stand = x.isDelivered || x.isPickedUpAtRetailLocation ? 'bezorgd' : x.isAtRetailLocation ? 'afhaalpunt'
    : idx >= 4 ? 'bezorgd' : idx === 3 ? 'vandaag' : idx === 2 ? 'onderweg' : 'aangemeld';
  // wv3078: zolang het pakje niet bezorgd is, zegt de jongste waarneming meer ("Zending is gesorteerd") dan de fasetekst (observations: jongste eerst, gemeten 14-11)
  const obs = Array.isArray(x.observations) && x.observations[0] && typeof x.observations[0].description === 'string' ? schoon(x.observations[0].description, 120) : null;
  const tekst = (stand !== 'bezorgd' && stand !== 'afhaalpunt' && obs) || schoon(x.statusPhase && x.statusPhase.message, 120);
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
// wv3078 GOFO queryTrackV2: {code, data: [{trackingNumber, status, trackStatus?, lastTrackEvent: {processCode, processDate, trackStatus}, trackEventList}]}.
// processCode-waarden gemeten 14-11-2026 in een echt antwoord (eventnamen tussen haakjes); trackStatus 2 = onderweg, 6 = bezorgd. Andere codes:
// alleen de grove stand uit trackStatus, zonder tekst; is ook die onbekend, dan niets (de mail blijft dan de bron).
const GOFO_STAP = {
  100: ['aangemeld', 'Aangemeld bij GOFO'],                    // Shipment not yet received or processed
  202: ['onderweg', 'Bij het sorteercentrum'],                 // Arrived at the sorting center
  200: ['onderweg', 'Vertrokken uit het sorteercentrum'],      // Departed from the sorting center
  201: ['onderweg', 'Aangekomen in de regio'],                 // Arrived in your region
  203: ['onderweg', 'Wordt klaargemaakt voor bezorging'],      // Preparing for delivery
  208: ['vandaag', 'Bezorger is onderweg'],                    // Out for delivery with the courier
  205: ['bezorgd', 'Bezorgd'],                                 // Delivered at the delivery address
};
const GOFO_GROF = { 2: 'onderweg', 6: 'bezorgd' };
function leesGofo(j, code) {
  const l = j && Array.isArray(j.data) ? j.data : [];
  const x = l.find((d) => d && (d.trackingNumber === code || d.waybillNo === code || d.number === code));   // review Codex MOET 1: alleen exact dit pakje
  if (!x || typeof x !== 'object') return { gevonden: false };
  const e = x.lastTrackEvent && typeof x.lastTrackEvent === 'object' ? x.lastTrackEvent : Array.isArray(x.trackEventList) ? x.trackEventList[0] : null;
  if (!e || typeof e !== 'object') return { gevonden: false };
  const stap = GOFO_STAP[Number(e.processCode)];
  const stand = stap ? stap[0] : GOFO_GROF[Number(e.trackStatus)];
  if (!stand) return { gevonden: false };
  return { gevonden: true, stand, tekst: stap ? stap[1] : null, bezorgd_op: stand === 'bezorgd' ? iso(e.processDate) : null };
}
// wv3078 Dragonfly (Amazon-bezorger) cfworker/v3/tracking: {success, data: {code: 'found'|'not_found', result: {last_status: {status, step, isDelivered,
// timestamp (ms), etaType}, public_eta: {from, to}}}}. Statuscodes gemeten 14-11-2026: 0 Data received, 105 Received, 300 Loaded, 601 Delivered;
// een andere code telt alleen via step 1–2 (aangemeld/onderweg) of isDelivered, zonder tekst.
const DRAGONFLY_STAP = { 0: ['aangemeld', 'Aangemeld bij Dragonfly'], 105: ['onderweg', 'Ontvangen door Dragonfly'], 300: ['vandaag', 'Bezorger is onderweg'], 601: ['bezorgd', 'Bezorgd'] };
function leesDragonfly(j, code) {
  const d0 = j && j.success === true && j.data && j.data.code === 'found' ? j.data.result : null;
  const d = d0 && (code === undefined || String(d0.tracking_id || '').toUpperCase() === String(code).toUpperCase()) ? d0 : null;   // alleen exact dit pakje
  const s = d && d.last_status && typeof d.last_status === 'object' ? d.last_status : null;
  if (!s) return { gevonden: false };
  const stap = DRAGONFLY_STAP[Number(s.status)];
  let stand = s.isDelivered === true ? 'bezorgd' : stap ? stap[0] : s.step === 1 ? 'aangemeld' : s.step === 2 ? 'onderweg' : null;
  if (!stand) return { gevonden: false };
  const tekst = stand === 'bezorgd' ? 'Bezorgd' : stap && stap[0] === stand ? stap[1] : null;
  let vak = {};
  const pe = d.public_eta;
  if (stand !== 'bezorgd' && s.etaType && s.etaType !== 'none' && pe && typeof pe.from === 'string' && typeof pe.to === 'string') vak = vakUit(pe.from, pe.to, false);
  const ts = Number(s.timestamp);
  return Object.assign({ gevonden: true, stand, tekst, bezorgd_op: stand === 'bezorgd' && isFinite(ts) && ts > 1e12 ? new Date(ts).toISOString() : null }, vak);
}
function leesAntwoord(soort, j, code) {
  try {
    if (soort === 'dhl') return leesDhl(j);
    if (soort === 'postnl') return leesPostnl(j, code);
    if (soort === 'gls') return leesGls(j);
    if (soort === 'gofo') return leesGofo(j, code);
    if (soort === 'dragonfly') return leesDragonfly(j, code);
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
CREATE TABLE IF NOT EXISTS meta (sleutel TEXT PRIMARY KEY, waarde TEXT NOT NULL);
`;
// wv3011: verandert de herkenning, verhoog dan dit getal. Bij de eerste opening daarna vergeet de module welke mails "geen pakje" waren,
// zodat de ronden ze (binnen de 21 dagen van de kandidaten, 20 per ronde) één keer opnieuw lezen; herkende mails blijven staan.
const HERKEN_VERSIE = '4';   // wv3062: adres en tussenstand uit de mail; wv3535: DHL Paket (dhl.de), Intrapost ORD-nummer, Dragonfly INTRA en code uit het token
// wv3062: kolommen die er later bij kwamen (bestaande banken krijgen ze bij open() via ALTER TABLE). adres = straat + plaats uit de mail (alleen
// voor het scherm), stand_detail = tussenstand uit de jongste mail, geleverd_hand = David tikte "Is geleverd" (tijd; NULL = teruggedraaid),
// aanvul = versie waarmee de open pakjes van vóór deze kolommen één keer hun jongste mails opnieuw lieten lezen.
// wv3535: via = 'intrapost' als een Intrapost-mail in deze rij kwam (koppelt het Dragonfly-pakje met een INTRA-code aan de winkel)
const EXTRA_KOLOMMEN = ['adres TEXT', 'stand_detail TEXT', 'geleverd_hand TEXT', 'aanvul TEXT', 'via TEXT', 'bestemming TEXT', 'concept_op TEXT'];   // wv4147: bestemming (thuis/praktijk/ander), concept_op (mailconcept aan de winkel)
const AANVUL_VERSIE = '2';   // wv4147: de open pakjes lezen hun jongste mails nog één keer, nu ook voor de bestemming
const VERVOERDER_DOMEINEN = ['postnl.nl', 'dhl.com', 'dhl.nl', 'dhl.de', 'dhlecommerce.nl', 'dhlparcel.nl', 'dpd.nl', 'dpd.com', 'dpd.de', 'dpdgroup.com', 'gls-info.nl',
  'gls-group.eu', 'gls-group.com', 'gls.nl', 'gls-netherlands.com', 'ups.com', 'dragonflyinternational.com', 'dragonflyshipping.nl', 'fedex.com', 'gofo.com', 'gofoexpress.nl'];
// wv3062: het mailonderwerp voor op de kaart (platte tekst): Fwd:/RE: eraf, witruimte samen, hooguit 120 tekens
function onderwerpSchoon(x) {
  let v = schoon(x, 2000);
  if (!v) return null;
  let oud;
  do { oud = v; v = v.replace(/^\s*(?:fwd?|fw|re|aw|wg|sv|antw|doorgestuurd)\s*:\s*/i, ''); } while (v !== oud);
  v = v.replace(/\s+/g, ' ').trim();
  if (!v) return null;
  if (v.length > 120) { const k = v.slice(0, 119), i = k.lastIndexOf(' '); v = (i > 80 ? k.slice(0, i) : k) + '…'; }
  return v;
}
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
    const kol = new Set(db.prepare('PRAGMA table_info(zending)').all().map((k) => k.name));
    EXTRA_KOLOMMEN.forEach((k) => { if (!kol.has(k.split(' ')[0])) db.exec('ALTER TABLE zending ADD COLUMN ' + k); });
    // wv3535: tot 20-11 kreeg elk Dragonfly-pakje de winkel Amazon, ook een INTRA-zending van Intrapost (die kwam zo ten onrechte bij een Amazon-bestelling)
    db.exec("UPDATE zending SET winkel = NULL WHERE vervoerder = 'dragonfly' AND code LIKE 'INTRA%' AND winkel = 'Amazon'");
    const hv = db.prepare("SELECT waarde FROM meta WHERE sleutel = 'herken_versie'").get();
    if (!hv || hv.waarde !== HERKEN_VERSIE) {
      db.exec('DELETE FROM mail WHERE zending_id IS NULL');
      db.prepare("INSERT OR REPLACE INTO meta (sleutel, waarde) VALUES ('herken_versie', ?)").run(HERKEN_VERSIE);
    }
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
  // wv4147: [{postcode, naam: 'thuis'|'praktijk', plaatsen: [..]}] uit config.json (adressen); zonder = geen bestemming
  function adressen() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
      return (Array.isArray(j.adressen) ? j.adressen : []).filter((a) => a && postcode(a.postcode) && BESTEMMING_NAMEN.includes(a.naam)).slice(0, 5)
        .map((a) => ({ postcode: postcode(a.postcode), naam: a.naam, plaatsen: (Array.isArray(a.plaatsen) ? a.plaatsen : []).map((x) => schoon(x, 40)).filter(Boolean).slice(0, 5) }));
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
    // een 3S-code die eerst als 'onbekend' binnenkwam en nu bij een vervoerder hoort (of andersom): dezelfde rij. wv3011: ook 'anders' (code uit
    // de winkelmail zonder vervoerder; gemeten 13-11: winkelmail en FedEx-mail van één zending werden twee rijen)
    if (!z && h.code) z = d.prepare("SELECT * FROM zending WHERE code = ? AND (vervoerder IN ('onbekend', 'anders') OR ? IN ('onbekend', 'anders'))").get(h.code, h.vervoerder);
    // wv3535: de Intrapost-mail noemt het bestelnummer van de winkel: dan gaat hij op in de winkelrij met dat nummer (en een woord van de winkelnaam gelijk)
    if (!z && h.via === 'intrapost' && h.bestelnr) {
      const ww = winkelWoorden(h.winkel);
      z = d.prepare("SELECT * FROM zending WHERE vervoerder = 'winkel' AND bestelnr = ? AND sleutel <> ?").all(h.bestelnr, h.sleutel)
        .find((r) => winkelWoorden(r.winkel).some((x) => ww.includes(x))) || null;
    }
    const tijd = h.tijd || nu;
    const best = bestemmingUit({ pc: h.pc, adres: h.adres, tekst: m.tekst }, adressen());   // wv4147
    // wv3535: een Dragonfly-pakje met een INTRA-code komt van Intrapost; de winkel staat in de Intrapost-mail van 4 dagen ervoor tot 1 dag erna (alleen
    // als dat er precies één is). Zo gaat de bestelling van die winkel in dit pakje op (samenWinkel). De andere richting: koppelIntra hieronder.
    const intraWinkel = (t) => {
      const van = new Date(Date.parse(t) - 5 * DAG).toISOString(), tot = new Date(Date.parse(t) + 5 * DAG).toISOString();
      // een winkel die al bij een ander INTRA-pakje uit dezelfde dagen hoort, telt niet mee
      const al = new Set(d.prepare("SELECT winkel FROM zending WHERE vervoerder = 'dragonfly' AND code LIKE 'INTRA%' AND code <> ? AND winkel IS NOT NULL AND eerste >= ? AND eerste <= ?")
        .all(String(h.code), van, tot).map((x) => String(x.winkel).toLowerCase()));
      const r = d.prepare("SELECT winkel FROM zending WHERE via = 'intrapost' AND verborgen IS NULL AND winkel IS NOT NULL AND mail_tijd >= ? AND mail_tijd <= ?").all(
        new Date(Date.parse(t) - 4 * DAG).toISOString(), new Date(Date.parse(t) + DAG).toISOString()).filter((x) => !al.has(String(x.winkel).toLowerCase()));
      return r.length === 1 ? r[0].winkel : null;
    };
    if (h.vervoerder === 'dragonfly' && /^INTRA/.test(String(h.code)) && !h.winkel && !(z && z.winkel)) h.winkel = intraWinkel(z && z.eerste < tijd ? z.eerste : tijd);
    if (!z) {
      const id = idVan(h.sleutel);
      d.prepare(`INSERT INTO zending (id, sleutel, vervoerder, code, bestelnr, winkel, omschrijving, pc, stand_mail, mail_tijd, verwacht_dag, verwacht_van, verwacht_tot, eerste, bijgewerkt,
        adres, stand_detail, aanvul, via, bestemming) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, h.sleutel, h.vervoerder, h.code, h.bestelnr, h.winkel, h.omschrijving, h.pc, h.stand, tijd,
        h.verwacht_dag, h.verwacht_van, h.verwacht_tot, tijd, nu, h.adres || null, h.detail || null, AANVUL_VERSIE, h.via || null, best);
      z = { id };
    } else {
      const nieuwer = !z.mail_tijd || tijd >= z.mail_tijd;
      const vaag = (v) => v === 'onbekend' || v === 'anders';
      const vervoerder = vaag(z.vervoerder) && !vaag(h.vervoerder) ? h.vervoerder : z.vervoerder === 'anders' && h.vervoerder === 'onbekend' ? 'onbekend' : z.vervoerder;
      const sleutel = vervoerder !== z.vervoerder ? (vervoerder === 'onbekend' ? 'code' : vervoerder) + ':' + z.code : z.sleutel;
      // bezorgd blijft bezorgd: een oudere mail die later binnenkomt zet de stand niet terug
      const stand = nieuwer && !(z.stand_mail === 'bezorgd' && RANG[h.stand] < RANG.bezorgd) ? h.stand : z.stand_mail;
      d.prepare(`UPDATE zending SET sleutel = ?, vervoerder = ?, winkel = COALESCE(winkel, ?), omschrijving = COALESCE(omschrijving, ?), pc = COALESCE(pc, ?),
        stand_mail = ?, mail_tijd = ?, verwacht_dag = ?, verwacht_van = ?, verwacht_tot = ?, eerste = MIN(eerste, ?), bijgewerkt = ?, adres = ?, stand_detail = ?, via = COALESCE(via, ?), bestemming = ? WHERE id = ?`).run(
        sleutel, vervoerder, h.winkel, h.omschrijving, h.pc, stand, nieuwer ? tijd : z.mail_tijd,
        nieuwer && h.verwacht_dag ? h.verwacht_dag : z.verwacht_dag, nieuwer && h.verwacht_dag ? h.verwacht_van : z.verwacht_van, nieuwer && h.verwacht_dag ? h.verwacht_tot : z.verwacht_tot,
        tijd, nu, (nieuwer ? h.adres || z.adres : z.adres || h.adres) || null, (nieuwer ? h.detail : z.stand_detail) || null, h.via || null,
        (nieuwer ? best || z.bestemming : z.bestemming || best) || null, z.id);
    }
    // wv3535 koppelIntra: kwam de Intrapost-mail ná het Dragonfly-pakje binnen, dan krijgt dat pakje alsnog de winkel (precies één INTRA-pakje zonder
    // winkel, eerste mail van 1 dag vóór tot 4 dagen na deze mail)
    if (h.via === 'intrapost' && h.winkel) {
      const r = d.prepare("SELECT id FROM zending WHERE vervoerder = 'dragonfly' AND code LIKE 'INTRA%' AND winkel IS NULL AND verborgen IS NULL AND eerste >= ? AND eerste <= ?").all(
        new Date(Date.parse(tijd) - DAG).toISOString(), new Date(Date.parse(tijd) + 4 * DAG).toISOString());
      const ww = d.prepare('SELECT winkel FROM zending WHERE id = ?').get(z.id);
      if (r.length === 1 && ww && ww.winkel) d.prepare('UPDATE zending SET winkel = ? WHERE id = ?').run(ww.winkel, r[0].id);
    }
    d.prepare('INSERT OR REPLACE INTO mail (gmail_id, zending_id, tijd, gezien) VALUES (?, ?, ?, ?)').run(String(m.gmail_id), z.id, iso(m.datum), nu);
    return z.id;
  }
  // welke pakjes nu bij de vervoerder te verversen zijn (niet bezorgd, niet verborgen, ≤ 30 dagen, wachttijd voorbij)
  function teVolgen(dwing) {
    const d = open(), nu = klok();
    return d.prepare("SELECT * FROM zending WHERE code IS NOT NULL AND vervoerder IN ('postnl','dhl','gls','gofo','dragonfly','onbekend') AND verborgen IS NULL").all().filter((z) => {
      if (z.stand_volg === 'bezorgd' || z.bezorgd_op || z.geleverd_hand) return false;
      if (z.vervoerder === 'gls' && !/^\d{11,12}$/.test(String(z.code))) return false;   // wv3011: geen openbare volgvraag (zie volgAdressen)
      if ((z.vervoerder === 'gofo' && !GOFO_CODE.test(String(z.code))) || (z.vervoerder === 'dragonfly' && !DRAGONFLY_CODE.test(String(z.code)))) return false;   // wv3078
      if (Date.parse(z.eerste) < nu - STIL_NA) return false;
      if (z.stand_mail === 'bezorgd' && z.ververst) return false;
      if (dwing) return !z.ververst || Date.parse(z.ververst) < nu - 5 * 60000;
      const wacht = (z.stand_volg === 'vandaag' || z.stand_mail === 'vandaag') ? 20 * 60000 : 60 * 60000;
      const extra = Math.min(z.ververs_pogingen || 0, 6) * 60 * 60000;   // blijft het misgaan: steeds later opnieuw
      return !z.ververst || Date.parse(z.ververst) < nu - wacht - extra;
    });
  }
  // één pakje bij de vervoerder nalezen; haal(url[, body]) → {status, json} (server.js; body = json voor een POST, alleen GOFO). Geeft 'ok' | 'onbekend' | 'fout'.
  async function volg(z, haal) {
    const d = open(), nu = nuIso();
    let uit = 'onbekend', r = null, soort = null, pcGebruikt = null;
    for (const a of volgAdressen(z, postcodes())) {
      let antw = null;
      try { antw = await (a.body ? haal(a.url, a.body) : haal(a.url)); } catch (e) { antw = null; }
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
      // wv3062: open pakjes van vóór de kolommen adres/stand_detail lezen hun jongste mails één keer opnieuw (hooguit 5 pakjes en 3 mails per pakje
      // per ronde); alleen adres en tussenstand worden bijgezet, de rest van de rij blijft zoals hij was
      // review Codex MOET 1: alleen af als er iets gelezen is (of er geen mail meer is); mislukt het lezen, dan een volgende ronde opnieuw, hooguit 3 keer
      // wv4147: ook de pakjes die de laatste week bezorgd zijn (die staan nog in de lijst; de bestemming hoort ook op hun kaart)
      const aanvul = d.prepare(`SELECT id, aanvul FROM zending WHERE (aanvul IS NULL OR aanvul <> ?) AND verborgen IS NULL
        AND ((geleverd_hand IS NULL AND bezorgd_op IS NULL AND COALESCE(stand_volg, stand_mail) <> 'bezorgd') OR bijgewerkt >= ?) AND eerste >= ? ORDER BY eerste DESC LIMIT 5`).all(
        AANVUL_VERSIE, new Date(nuMs - EERDER_NA).toISOString(), new Date(nuMs - STIL_NA).toISOString());
      for (const z of aanvul) {
        const ms = d.prepare('SELECT gmail_id FROM mail WHERE zending_id = ? ORDER BY tijd DESC LIMIT 3').all(z.id);
        let adres = null, detail = null, eerst = true, gelezen = 0, best = null;
        for (const x of ms) {
          let m = null;
          try { m = await r.lees(x.gmail_id); } catch (e) { m = null; }
          const h = m && typeof m.tekst === 'string' ? herken({ van: m.van, onderwerp: m.onderwerp, tekst: m.tekst, datum: m.datum }) : null;
          if (h && eerst) detail = h.detail || null;
          if (m && typeof m.tekst === 'string') { eerst = false; gelezen++; }
          if (h && h.adres && !adres) adres = h.adres;
          if (h && !best) best = bestemmingUit({ pc: h.pc, adres: h.adres, tekst: m.tekst }, adressen());   // wv4147
          if (adres && best && !eerst) break;
        }
        const poging = (/^poging:(\d+)$/.exec(String(z.aanvul || '')) || [0, 0])[1] * 1 + 1;
        const klaar = gelezen > 0 || !ms.length || poging >= 3;
        d.prepare('UPDATE zending SET adres = COALESCE(adres, ?), stand_detail = COALESCE(stand_detail, ?), bestemming = COALESCE(bestemming, ?), aanvul = ? WHERE id = ?').run(adres, detail, best, klaar ? AANVUL_VERSIE : 'poging:' + poging, z.id);
        uit.aangevuld = (uit.aangevuld || 0) + 1;
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
    d.prepare('DELETE FROM zending WHERE bijgewerkt < ? AND (bezorgd_op IS NOT NULL OR geleverd_hand IS NOT NULL OR stand_mail = ? OR verborgen IS NOT NULL OR eerste < ?)').run(
      new Date(nu - WEG_NA).toISOString(), 'bezorgd', new Date(nu - WEG_NA).toISOString());
    d.prepare('DELETE FROM mail WHERE gezien < ?').run(new Date(nu - MAIL_WEG_NA).toISOString());
    d.prepare('DELETE FROM lees_fout WHERE laatst < ?').run(new Date(nu - MAIL_WEG_NA).toISOString());
  }
  // De stand die David ziet: de vervoerder wint als die iets weet, anders de mail. 'vandaag' alleen op de dag zelf.
  function weergave(z, vandaag, pcs, adr) {
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
    // wv3062: David tikte "Is geleverd": dan is het bezorgd op dat moment, wat de mail of de vervoerder ook zegt (terug te draaien)
    const hand = !!z.geleverd_hand && stand !== 'bezorgd';
    if (hand) { stand = 'bezorgd'; dag = null; van = null; tot = null; }
    const bezorgd = stand === 'bezorgd' ? (hand ? z.geleverd_hand : (z.bezorgd_op || z.mail_tijd || z.bijgewerkt)) : null;
    // tussenstand uit de mail: niet als de vervoerder zelf een standtekst gaf; Bij de buren / In de brievenbus alleen bij Bezorgd, de rest alleen ervoor
    const det = z.stand_detail && !(volgt && z.volg_tekst) && !hand && (stand === 'bezorgd') === DETAIL_BEZORGD.includes(z.stand_detail) ? z.stand_detail : null;
    const laatstT = [z.mail_tijd, z.ververst && !z.ververs_fout ? z.ververst : null, z.bezorgd_op].filter(Boolean).sort().pop() || z.eerste;
    return {
      id: z.id, winkel: z.winkel || null, omschrijving: z.omschrijving || null,
      vervoerder: VERVOERDERS[z.gevolgd || z.vervoerder] || (z.vervoerder === 'onbekend' ? 'PostNL of DHL' : 'Anders'),
      code: z.code || null, bestelnr: z.bestelnr || null, stand, stand_tekst: volgt ? (z.volg_tekst || null) : null,
      verwacht_dag: dag || null, verwacht_van: van || null, verwacht_tot: tot || null, bezorgd_op: bezorgd,
      bron: volgt ? 'vervoerder' : 'mail', ververst: z.ververst && !z.ververs_fout ? z.ververst : null,
      laatst: laatstT, eerste: z.eerste, link: volgLink(z, pcs), verborgen: !!z.verborgen,
      adres: z.adres || null, stand_detail: det, handmatig: !!z.geleverd_hand, onderwerp: null,   // wv3062
      bestemming: bestemmingVanPc(z.pc, adr) || z.bestemming || null,   // wv4147: thuis | praktijk | ander
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
      if (past) { past.shopper = schoon(g.wens, 160); past.shopper_id = g.id || null; }   // wv4147 (2C89 d): tik = naar Shopper
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
      o._groep = (o._groep || [o.id]).concat(w._groep || [w.id]);   // wv3062: voor het mailonderwerp van de hele groep
      o.adres = o.adres || w.adres;
      o.bestemming = o.bestemming || w.bestemming;   // wv4147
      if (o.handmatig && o.stand === 'bezorgd') { /* wv3062: David tikte Is geleverd op de Amazon-rij: die wint */ }
      else if (w.handmatig && w.stand === 'bezorgd') { o.stand = 'bezorgd'; o.handmatig = true; o.bezorgd_op = w.bezorgd_op; o.stand_detail = null; o.verwacht_dag = null; o.verwacht_van = null; o.verwacht_tot = null; }
      else if (w.bron === 'vervoerder' || RANG[w.stand] > RANG[o.stand]) {
        o.stand = w.stand; o.stand_tekst = w.stand_tekst; o.bron = w.bron; o.ververst = w.ververst; o.link = w.link || o.link;
        o.bezorgd_op = w.bezorgd_op || o.bezorgd_op; o.stand_detail = w.stand_detail;
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
    const woorden = winkelWoorden;
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
      o._groep = (o._groep || [o.id]).concat(w._groep || [w.id]);   // wv3062
      o.adres = o.adres || w.adres;
      o.bestemming = o.bestemming || w.bestemming;   // wv4147
      if (!o.bestelnr) o.bestelnr = w.bestelnr;
    });
    return ws.filter((w) => !weg.has(w.id));
  }
  /*
   * wv3062 (David 14-11, advies Pakjes 1): een pakje zonder omschrijving krijgt het onderwerp van een van zijn mails (ook die van een samengevoegde
   * rij). onderwerpen(gmail_ids) → Map gmail_id → {onderwerp, domein} (server.js leest mailman.sqlite alleen lezend; er wordt niets bewaard).
   * Keuze: de jongste mail van de winkel (die noemt bestelling of product), anders de jongste van de vervoerder. Fout of geen bron = geen onderwerp.
   */
  function vulOnderwerp(d, ws, onderwerpen) {
    const zonder = ws.filter((w) => !w.omschrijving);
    if (typeof onderwerpen === 'function' && zonder.length) {
      const q = d.prepare('SELECT gmail_id, tijd FROM mail WHERE zending_id = ?'), per = new Map(), alle = [];
      zonder.forEach((w) => {
        const ms = [];
        (w._groep || [w.id]).forEach((id) => q.all(id).forEach((r) => { ms.push(r); alle.push(String(r.gmail_id)); }));
        per.set(w, ms);
      });
      let kop = null;
      try { kop = alle.length ? onderwerpen(alle) : null; } catch (e) { kop = null; }
      if (kop && typeof kop.get === 'function') zonder.forEach((w) => {   // geen instanceof: een Map uit een ander vm-domein (UI-toets) telt ook
        const ms = per.get(w).map((r) => ({ tijd: String(r.tijd || ''), k: kop.get(String(r.gmail_id)) })).filter((x) => x.k && onderwerpSchoon(x.k.onderwerp))
          .sort((a, b) => (a.tijd < b.tijd ? 1 : a.tijd > b.tijd ? -1 : 0));
        const kies = ms.find((x) => !VERVOERDER_DOMEINEN.some((v) => op(String(x.k.domein || '').toLowerCase(), v))) || ms[0];
        w.onderwerp = kies ? onderwerpSchoon(kies.k.onderwerp) : null;
      });
    }
    ws.forEach((w) => { delete w._groep; });
    return ws;
  }
  // wv4147 (2C89 e): waarom dit pakje aandacht vraagt, of null. Niet bezorgd, niet zelf naar Eerder, niet zelf op geleverd gezet; (1) de
  // verwachte dag is voorbij, of (2) het laatste teken is ouder dan 5 dagen (alleen mail) of 10 dagen (de pod volgt het zelf). sinds = het
  // moment waarop de eerste reden begon (dag na de verwachte dag, of laatste teken + grens); berekend, niet bewaard.
  function aandachtVan(w, nu, vandaag, volgbaar) {
    if (w.stand === 'bezorgd' || w.verborgen || w.handmatig) return null;
    const laatst = Date.parse(w.laatst), grens = volgbaar ? AANDACHT_VOLG_NA : AANDACHT_MAIL_NA;
    const over = !!(w.verwacht_dag && w.verwacht_dag < vandaag);
    const stil = isFinite(laatst) && laatst < nu - grens;
    if (!over && !stil) return null;
    const t = [];
    if (over) t.push(Date.parse(dagPlus(w.verwacht_dag, 1) + 'T00:00:00+01:00'));
    if (stil) t.push(laatst + grens);
    return { reden: over ? 'over_dag' : 'stil', sinds: new Date(Math.min(...t)).toISOString(), dagen_stil: isFinite(laatst) ? Math.max(0, Math.floor((nu - laatst) / DAG)) : null,
      was_dag: over ? w.verwacht_dag : null };
  }
  function lijst(gekocht, onderwerpen) {
    const d = open(), nu = klok(), vandaag = nlDag(nu), pcs = postcodes(), adr = adressen();
    const lopend = [], eerder = [], aandacht = [];
    const rijen = d.prepare('SELECT * FROM zending').all(), wn = new Set(rijen.filter((z) => z.vervoerder === 'winkel').map((z) => z.id));
    const groep = new Map();   // wv4147: welke rijen bij een kaart horen (voor de winkelmail van het mailconcept)
    const ws = samenWinkel(samenAmazon(rijen.map((z) => weergave(z, vandaag, pcs, adr))), wn);
    ws.forEach((w) => groep.set(w.id, (w._groep || [w.id]).slice()));
    for (const w of vulOnderwerp(d, ws, onderwerpen)) {
      // bezorgd: 7 dagen in de lijst; niet bezorgd en 30 dagen stil: naar Eerder. wv4147: wat over zijn dag is of 5/10 dagen stil, staat
      // daarvoor onder Vraagt aandacht (vroeger ging een pakje dat alleen uit de mail kwam na 10 dagen stil naar Eerder)
      // wv4147 (review 20-11 los 2): GLS NL is niet te volgen (gemeten 13-11); GOFO en Dragonfly wel
      const volgbaar = ['PostNL', 'DHL', 'GOFO', 'Dragonfly', 'PostNL of DHL'].includes(w.vervoerder) || w.bron === 'vervoerder';
      const oud = w.stand === 'bezorgd' ? Date.parse(w.bezorgd_op) < nu - EERDER_NA : Date.parse(w.laatst) < nu - STIL_NA;
      if (w.verborgen || oud) { eerder.push(w); continue; }
      const a = aandachtVan(w, nu, vandaag, volgbaar);
      if (a) { w.aandacht = a; aandacht.push(w); } else lopend.push(w);
    }
    // wv4147: kan er een mailconcept aan de winkel? Alleen als er bij het pakje een mail is van een afzender die geen vervoerder is
    if (aandacht.length && typeof onderwerpen === 'function') {
      const q = d.prepare('SELECT gmail_id FROM mail WHERE zending_id = ?');
      const ids = new Map();
      aandacht.forEach((w) => ids.set(w, (groep.get(w.id) || [w.id]).flatMap((z) => q.all(z).map((r) => String(r.gmail_id)))));
      let kop = null;
      try { kop = onderwerpen(Array.from(ids.values()).flat()); } catch (e) { kop = null; }
      aandacht.forEach((w) => {
        w.kan_mail = !!(kop && typeof kop.get === 'function') && ids.get(w).some((g) => { const k = kop.get(g); return k && k.domein && !VERVOERDER_DOMEINEN.some((v) => op(String(k.domein).toLowerCase(), v)); });
      });
    }
    aandacht.sort((a, b) => String(a.aandacht.sinds) < String(b.aandacht.sinds) ? -1 : 1);
    lopend.sort(sorteer);
    eerder.sort((a, b) => String(b.laatst) < String(a.laatst) ? -1 : 1);
    const verwacht = koppel(lopend.concat(aandacht), eerder, gekocht, vandaag);
    const r = d.prepare('SELECT start, eind, fout FROM ronde ORDER BY id DESC LIMIT 1').get();
    return { status: 200, body: { ok: true, lopend, aandacht, eerder: eerder.slice(0, 60), verwacht, laatste_ronde: r ? (r.eind || r.start) : null, ronde_fout: r && r.fout ? true : false } };
  }
  /*
   * wv4147 (2C89 e): de bron voor het mailconcept aan de winkel: de gmail-id's van het pakje (en de samengevoegde rij), met winkel,
   * bestelnummer, eerste mail en verwachte dag. server.js zoekt daarbij de jongste mail van de winkel (mailman.sqlite) en zet het concept
   * via het mailluik; conceptGezet onthoudt het tijdstip (één per pakje per 24 uur).
   */
  function conceptBron(id, samen) {
    if (!/^[0-9a-f]{12}$/.test(String(id))) return { status: 400, body: { ok: false, fout: 'ongeldig pakje' } };
    const d = open(), z = d.prepare('SELECT * FROM zending WHERE id = ?').get(id);
    if (!z) return { status: 404, body: { ok: false, fout: 'pakje niet gevonden' } };
    const s = typeof samen === 'string' && /^[0-9a-f]{12}$/.test(samen) && samen !== id ? d.prepare('SELECT * FROM zending WHERE id = ?').get(samen) : null;
    const rij = [z].concat(s ? [s] : []);
    const nu = klok();
    const laatst = rij.map((x) => x.concept_op).filter(Boolean).sort().pop();
    if (laatst && Date.parse(laatst) > nu - DAG) return { status: 409, body: { ok: false, al: true, fout: 'Voor dit pakje staat vandaag al een mailconcept klaar in Gmail (bij Concepten).' } };
    const q = d.prepare('SELECT gmail_id, tijd FROM mail WHERE zending_id = ? ORDER BY tijd DESC');
    const mails = rij.flatMap((x) => q.all(x.id).map((r) => ({ gmail_id: String(r.gmail_id), tijd: r.tijd || '' }))).sort((a, b) => (a.tijd < b.tijd ? 1 : -1));
    const w = (veld) => rij.map((x) => x[veld]).find(Boolean) || null;
    const verwacht = w('volg_dag') || w('verwacht_dag');
    return { status: 200, bron: { ids: rij.map((x) => x.id), mails, winkel: w('winkel'), bestelnr: w('bestelnr'), code: w('code'),
      vervoerder: VERVOERDERS[w('gevolgd') || z.vervoerder] || null, eerste: rij.map((x) => x.eerste).sort()[0], verwacht_dag: verwacht } };
  }
  function conceptGezet(ids) {
    const d = open(), nu = nuIso();
    (ids || []).filter((x) => /^[0-9a-f]{12}$/.test(String(x))).forEach((x) => d.prepare('UPDATE zending SET concept_op = ? WHERE id = ?').run(nu, x));
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
  // wv3062 (David 14-11: "een knop om 'Is geleverd' te klikken"): handmatig afsluiten en terugdraaien; samen = de samengevoegde rij gaat mee
  function geleverd(id, dat) {
    if (!/^[0-9a-f]{12}$/.test(String(id))) return { status: 400, body: { ok: false, fout: 'ongeldig pakje' } };
    if (!dat || typeof dat.geleverd !== 'boolean') return { status: 400, body: { ok: false, fout: 'geleverd moet true of false zijn' } };
    const d = open(), nu = nuIso();
    if (!d.prepare('SELECT id FROM zending WHERE id = ?').get(id)) return { status: 404, body: { ok: false, fout: 'pakje niet gevonden' } };
    const zet = d.prepare('UPDATE zending SET geleverd_hand = ?, bijgewerkt = ? WHERE id = ?');
    zet.run(dat.geleverd ? nu : null, nu, id);
    if (typeof dat.samen === 'string' && /^[0-9a-f]{12}$/.test(dat.samen) && dat.samen !== id) zet.run(dat.geleverd ? nu : null, nu, dat.samen);
    return { status: 200, body: { ok: true, id, geleverd: dat.geleverd } };
  }
  function info() {
    try {
      const d = open(), n = (q, ...a) => d.prepare(q).get(...a).n;
      const r = d.prepare('SELECT start, eind, mails, herkend, gevolgd, volg_fout, fout FROM ronde ORDER BY id DESC LIMIT 1').get();
      return { aan: true, pakjes: n('SELECT COUNT(*) AS n FROM zending'), niet_bezorgd: n("SELECT COUNT(*) AS n FROM zending WHERE bezorgd_op IS NULL AND geleverd_hand IS NULL AND COALESCE(stand_volg, stand_mail) <> 'bezorgd' AND verborgen IS NULL"),
        mails: n('SELECT COUNT(*) AS n FROM mail'), postcodes: postcodes().length,
        laatste_ronde: r ? { op: r.eind || r.start, mails: r.mails, herkend: r.herkend, gevolgd: r.gevolgd, volg_fout: r.volg_fout, fout: !!r.fout } : null };
    } catch (e) { return { aan: true, fout: true }; }
  }
  // wv4183 (2C70 stap 1): de bestellingen voor Shopper ("was dit hem?"): per rij met een winkel alleen id, winkel, de NL-dag van de eerste mail en
  // het tijdstip ervan (review ZOU 1: Shopper vergelijkt met het begin van de zoektocht) en het afzenderdomein van een winkelrij (sleutel winkel:<domein>:…). Alleen lezen; verborgen rijen tellen niet; hooguit 45 dagen terug en 300 rijen.
  function bestellingen(sinds) {
    const grens = Math.max(Date.parse(sinds) || 0, klok() - 45 * DAG);
    return open().prepare('SELECT id, sleutel, winkel, eerste FROM zending WHERE winkel IS NOT NULL AND verborgen IS NULL AND eerste >= ? ORDER BY eerste DESC LIMIT 300')
      .all(new Date(grens).toISOString()).map((z) => {
        const m = /^winkel:([a-z0-9.-]{3,100}):/.exec(String(z.sleutel || ''));
        const t = Date.parse(z.eerste);
        return isFinite(t) ? { id: String(z.id), winkel: schoon(z.winkel, 80), dag: nlDag(t), eerste: new Date(t).toISOString(), domein: m ? m[1] : null } : null;
      }).filter((x) => x && x.winkel);
  }
  function sluit() { if (db) { try { db.close(); } catch (e) { /* niets */ } db = null; } }
  return { herken, isKandidaat, ronde, lijst, verberg, geleverd, info, sluit, verwerkMail, teVolgen, volg, conceptBron, conceptGezet, bestellingen, _laatst: () => laatst };
}

/*
 * wv4147 (2C89 e): Voor jou-kaarten voor pakjes die een week onder Vraagt aandacht staan. Puur: server.js leest de lijst (lijst().body.aandacht)
 * en de kaarten (mk_voor_jou_lijst, ook gesloten) en voert het plan uit (mk_voor_jou_zet / mk_voor_jou_status door agent).
 *  - zet: per pakje met aandacht.sinds ≥ 7 dagen geleden één kaart, sleutel pakjes-aandacht-<id>, nooit opnieuw als die sleutel al bestaat
 *    (ook gesloten); hooguit 3 nieuwe per ronde; alleen tussen 07 en 22 uur.
 *  - dicht: een open of uitgestelde kaart (status open/later) van een pakje dat niet meer onder Vraagt aandacht staat (bezorgd, geleverd,
 *    naar Eerder, weg), alleen als de lijst gelezen kon worden; door agent, met bewijs.
 */
const KAART_PREFIX = 'pakjes-aandacht-';
const KAART_RE = /^pakjes-aandacht-([0-9a-f]{12})$/;
function kortTekst(t, n) { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t; }
function dagKort(dag) { const d = new Date(dag + 'T12:00:00Z'); return isNaN(d) ? dag : new Intl.DateTimeFormat('nl-NL', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(d).replace(/\./g, ''); }
function aandachtZin(p) {
  const a = p.aandacht || {};
  if (a.reden === 'over_dag' && a.was_dag) return 'Verwacht was ' + dagKort(a.was_dag) + (a.dagen_stil != null ? '; het laatste nieuws is van ' + a.dagen_stil + ' dagen geleden' : '') + '.';
  return 'Al ' + (a.dagen_stil != null ? a.dagen_stil : 'een aantal') + ' dagen geen nieuws van de winkel of de bezorger.';
}
function kaartVan(p, nuKort) {
  const naam = p.winkel || p.omschrijving ? kortTekst(p.winkel || p.omschrijving, 50) : 'van ' + kortTekst(p.vervoerder, 30);
  return { sleutel: KAART_PREFIX + p.id, soort: 'doen', waar: 'overal', prive: true, duur_min: 3, volgorde: 55,
    titel: kortTekst('Pakje ' + naam + ' — kijken of het binnen is', 90),
    waarom: kortTekst(aandachtZin(p) + ' Pakjes weet niet of het er is; het staat al een week bovenaan onder Vraagt aandacht.', 400),
    stappen: ['Tik op deze kaart: je komt in Pakjes, bovenaan bij Vraagt aandacht.',
      'Is het binnen: tik Is geleverd.',
      p.kan_mail ? 'Is het er niet: tik Mailconcept aan de winkel; het concept staat dan in Gmail bij Concepten, jij kijkt het na en verstuurt.' : 'Is het er niet: tik de volglink of neem contact op met de winkel.',
      'Hoeft het niet meer: tik Naar Eerder. Deze kaart gaat dan vanzelf dicht.'],
    meting: kortTekst((nuKort ? nuKort + ': ' : '') + 'onder Vraagt aandacht sinds ' + String(p.aandacht && p.aandacht.sinds || '').slice(0, 10) + '.', 300),
    herkomst: { module: 'pakjes', handmatig: 'pakjes', doel: { scherm: 'pakjes' } } };
}
function nlUur(ms) { return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms))); }
function kaartPlan(x) {
  const uit = { zet: [], dicht: [] };
  const nu = x.nu, punten = Array.isArray(x.punten) ? x.punten : [], aandacht = Array.isArray(x.aandacht) ? x.aandacht : [];
  const bestaat = new Map(punten.filter((p) => p && KAART_RE.test(String(p.sleutel))).map((p) => [p.sleutel, p]));
  const nog = new Set(aandacht.map((p) => KAART_PREFIX + p.id));
  bestaat.forEach((p, s) => { if (!nog.has(s) && (p.status === 'open' || p.status === 'later')) uit.dicht.push({ sleutel: s, van: p.status, bewijs: 'het pakje staat niet meer onder Vraagt aandacht in Pakjes (bezorgd, geleverd of naar Eerder)' }); });
  const uur = nlUur(nu);
  if (uur < 7 || uur >= 22) return uit;
  aandacht.filter((p) => p && /^[0-9a-f]{12}$/.test(String(p.id)) && p.aandacht && Date.parse(p.aandacht.sinds) <= nu - AANDACHT_KAART_NA && !bestaat.has(KAART_PREFIX + p.id))
    .slice(0, 3).forEach((p) => uit.zet.push(kaartVan(p, x.nuKort)));
  return uit;
}

// wv4125 (besluit nr 419 / 3C119): de lijst voor POST /smal/pakjes (Actie-Bewaker, skill actie-bewaker aankoop.py): alleen wat nodig is om
// "is X al besteld of bezorgd?" te beoordelen. Geen adres, volgcode, volglink of bestelnummer; Shopper-verwachtingen zonder id.
function kaal(body) {
  const b = body && typeof body === 'object' ? body : {};
  // Vrije tekst (winkel, omschrijving, onderwerp) kan een bestelnummer, postcode of adres bevatten (Codex MOET 3, ronde 2): nummers vanaf
  // 5 cijfers en mailadressen eruit; ruikt de tekst naar een adres (postcode, of een straatwoord met binnen vier woorden een getal), dan
  // valt het hele veld weg (null = inhoud onbekend; de Actie-Bewaker sluit dan niet). Hooguit 120 tekens.
  const ADRES = [/\b[1-9]\d{3}\s?[A-Za-z]{2}\b/, /(straat|laan|weg|plein|singel|gracht|kade|dreef|hof|pad|steeg|park|dijk|markt|baan|ring|erf|veld)\b(\s+[^\s\d]+){0,4}\s+\d+/i];
  const schoon = (t) => {
    if (typeof t !== 'string' || !t.trim() || ADRES.some((r) => r.test(t))) return null;
    const u = t.replace(/\S+@\S+/g, '…').replace(/[A-Za-z]*\d[\dA-Za-z-]{4,}/g, (m) => ((m.match(/\d/g) || []).length >= 5 ? '…' : m)).replace(/\s+/g, ' ').trim();
    return u ? u.slice(0, 120) : null;
  };
  // Het onderwerp is vrije mailtekst (Codex ronde 3 MOET 2: "Bezorgd op Dam 12, Amsterdam"): met een los getal van 1-4 cijfers valt het
  // helemaal weg. De omschrijving is de producttitel die herken() uit een vaste vorm haalt (Amazon "Besteld: ‘…’") en houdt zijn getallen.
  const onderwerp = (t) => (typeof t === 'string' && /(^|[^\p{L}\d])\d{1,4}[a-zA-Z]?([^\p{L}\d]|$)/u.test(t) ? null : schoon(t));
  const rij = (w) => ({ winkel: schoon(w.winkel), omschrijving: schoon(w.omschrijving), onderwerp: onderwerp(w.onderwerp), vervoerder: w.vervoerder || null,
    stand: w.stand || null, eerste: w.eerste || null, laatst: w.laatst || null, bezorgd_op: w.bezorgd_op || null, verwacht_dag: w.verwacht_dag || null, verborgen: !!w.verborgen });
  const lijst = (x) => (Array.isArray(x) ? x : []).filter((w) => w && typeof w === 'object').map(rij);
  return { ok: true, lopend: lijst((Array.isArray(b.lopend) ? b.lopend : []).concat(Array.isArray(b.aandacht) ? b.aandacht : [])), eerder: lijst(b.eerder), laatste_ronde: b.laatste_ronde || null, ronde_fout: !!b.ronde_fout };   // wv4147: Vraagt aandacht telt als lopend
}

function isVervoerderDomein(dom) { return VERVOERDER_DOMEINEN.some((v) => op(String(dom || '').toLowerCase(), v)); }   // wv4147
module.exports = { kaal, kaartPlan, KAART_PREFIX, isVervoerderDomein, bestemmingUit, bestemmingVanPc, maak, herken, adresUit, detailUit, onderwerpSchoon, isKandidaat, leesDhl, leesPostnl, leesGls, leesGofo, leesDragonfly, volgAdressen, volgLink, dagUit, tijdvakUit, standUit, STANDEN };
