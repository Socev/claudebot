'use strict';
/*
 * facturen-sepa.js — SEPA-batch uit de betaallijst van de Facturen-app (wv1405, 27-10-2026). Bouwplan: vault "01_Ontwikkeling/Facturen-app -
 * SEPA-batch (bouwplan 27-10-2026).md" (waarom, grenzen, metingen per bank en het ontwerp na de Opus-review).
 *
 * WAAROM. David tikt elke betaling van de betaallijst met de hand over in de bank. Eén pain.001-bestand per eigen rekening, dat hij in de
 * zakelijke bankomgeving uploadt en daar zelf ondertekent, vervangt dat overtikken. Dit bestand maakt alleen dat bestand: er is hier niets
 * dat betaalt of verstuurt (grondwet 1 en 6); de routes in facturen.js doen de rechten, de transactie en de audit.
 *
 * PUUR. Geen I/O, geen klok: `vandaag` (JJJJ-MM-DD, Nederlandse tijd) en `nu` komen van de beller. Zo toetst test/facturen-sepa.sh alles
 * zonder database, en valideert hij de gemaakte bestanden tegen het XSD van pain.001.001.09.
 *
 * FORMAAT (gemeten 27-10, bronnen in het bouwplan). pain.001.001.09 (XML 2019) voor ABN AMRO, ING en Triodos; geen adressen (binnen de EER niet
 * verplicht; vanaf 15-11-2026 alleen gestructureerd als je ze meegeeft); BIC van de eigen rekening uit de bankcode (anders NOTPROVIDED, ABN-
 * addendum 2.53); geen BIC van de ontvanger (CdtrAgt weg, addendum 2.114); uitvoerdatum een TARGET2-dag, hooguit 364 dagen vooruit; één
 * PmtInf per uitvoerdatum; tekens uit de basis-Latijnse set van de EPC.
 */
const crypto = require('crypto');

const FORMAAT = 'pain.001.001.09';
const NS = 'urn:iso:std:iso:20022:tech:xsd:' + FORMAAT;
const MAX_VOORUIT = 364;            // ABN-addendum 2.17: "no more than 364 days in the future"
const MAX_REGELS = 500;
// EER: hier is een adres nooit verplicht. SEPA-landen buiten de EER (GB, CH, MC, SM, AD, VA, GI) vragen adres en soms BIC: met de hand.
const EER = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'IS', 'LI', 'NO']);
// BIC van de eigen rekening uit de bankcode van een Nederlands IBAN (de drie banken van de Facturen-app); anders NOTPROVIDED.
const BIC = { ABNA: 'ABNANL2A', INGB: 'INGBNL2A', TRIO: 'TRIONL2U' };
// Elfproef van het Nederlandse betalingskenmerk (16 cijfers; het eerste is het controlecijfer). Gewichten van rechts; getoetst op de 27
// voorbeelden in "Specificatie Betalingskenmerk bepaling 1.5" (Belastingdienst).
const KENMERK_GEWICHT = [2, 4, 8, 5, 10, 9, 7, 3, 6, 1];

// ───────────────────────────── datums ─────────────────────────────

function isIso(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)));
  return x.toISOString().slice(0, 10) === d;
}
function plus(d, n) { const x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n)); return x.toISOString().slice(0, 10); }
// Paaszondag (anonieme gregoriaanse berekening, Meeus/Jones/Butcher)
function pasen(j) {
  const a = j % 19, b = Math.floor(j / 100), c = j % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const maand = Math.floor((h + l - 7 * m + 114) / 31), dag = ((h + l - 7 * m + 114) % 31) + 1;
  return j + '-' + String(maand).padStart(2, '0') + '-' + String(dag).padStart(2, '0');
}
// TARGET2-dag: maandag t/m vrijdag, niet 1-1, Goede Vrijdag, Paasmaandag, 1-5, 25-12, 26-12 (ECB-kalender; ABN schuift anders naar de volgende).
function isWerkdag(d) {
  if (!isIso(d)) return false;
  const wd = new Date(d + 'T12:00:00Z').getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const md = d.slice(5);
  if (md === '01-01' || md === '05-01' || md === '12-25' || md === '12-26') return false;
  const p = pasen(+d.slice(0, 4));
  return d !== plus(p, -2) && d !== plus(p, 1);
}
function werkdagVanaf(d) { let x = d; for (let i = 0; i < 10 && !isWerkdag(x); i++) x = plus(x, 1); return x; }
function werkdagTot(d) { let x = d; for (let i = 0; i < 10 && !isWerkdag(x); i++) x = plus(x, -1); return x; }
function grenzen(vandaag) {
  if (!isIso(vandaag)) throw new Error('sepa: vandaag ontbreekt');
  return { vroegst: werkdagVanaf(vandaag), uiterst: plus(vandaag, MAX_VOORUIT) };
}
// Belastingdienst herkennen: vaste ontvangrekening, de naam op de factuur of (lev_naam) de naam van de gekoppelde leverancier.
// BD_MARGE = bankwerkdagen vóór de vervaldatum.
const BD_IBAN = new Set(['NL86INGB0002445588']);
const BD_MARGE = 3;
function isBelastingdienst(f) {
  if (!f) return false;
  const iban = String(f.iban || '').replace(/\s+/g, '').toUpperCase();
  return BD_IBAN.has(iban) || /belastingdienst/i.test([f.leverancier_naam, f.lev_naam].filter(Boolean).join(' '));
}
/*
 * De uitvoerdatum die in het bestand komt. Zelf gekozen (betaal_op) wint, maar nooit vóór `vroegst` (een gekozen datum die voorbij is, wordt
 * de eerstvolgende werkdag). Anders `vroegst`: de dag van de batch, of de eerstvolgende bankwerkdag (David 30-10-2026). Alleen de
 * Belastingdienst gaat standaard laat: BD_MARGE bankwerkdagen vóór de vervaldatum, nooit vóór vroegst.
 * → { datum, bron: 'gekozen'|'gekozen_voorbij'|'belastingdienst_marge'|'eerstvolgende_werkdag', te_ver: bool }
 */
function uitvoerVoor(f, vandaag) {
  const g = grenzen(vandaag);
  let datum, bron;
  if (isIso(f.betaal_op)) {
    if (f.betaal_op < g.vroegst) { datum = g.vroegst; bron = 'gekozen_voorbij'; } else { datum = f.betaal_op; bron = 'gekozen'; }
  } else if (isBelastingdienst(f) && isIso(f.vervaldatum)) {
    // David 30-10-2026: alleen de Belastingdienst standaard laat, met BD_MARGE bankwerkdagen marge vóór de vervaldatum (boete bij te laat;
    // onvoldoende saldo of een feestdag mag het niet doen mislukken).
    let w = werkdagTot(f.vervaldatum);
    for (let i = 0; i < BD_MARGE; i++) w = werkdagTot(plus(w, -1));
    if (w < g.vroegst) { datum = g.vroegst; bron = 'eerstvolgende_werkdag'; } else { datum = w; bron = 'belastingdienst_marge'; }
  } else { datum = g.vroegst; bron = 'eerstvolgende_werkdag'; }   // David 30-10-2026: standaard de dag van de batch, niet de uiterste betaaldatum
  return { datum, bron, te_ver: datum > g.uiterst };
}
// Een zelf gekozen datum: → null (goed) of een reden in gewone taal.
function datumFout(d, vandaag) {
  if (!isIso(d)) return 'datum als JJJJ-MM-DD';
  const g = grenzen(vandaag);
  if (d < g.vroegst) return 'die datum is voorbij; de eerste mogelijke is ' + g.vroegst;
  if (d > g.uiterst) return 'de bank neemt hooguit 364 dagen vooruit (tot ' + g.uiterst + ')';
  if (!isWerkdag(d)) return 'geen bankwerkdag (weekend of feestdag); kies bijvoorbeeld ' + werkdagVanaf(d);
  return null;
}

// ───────────────────────────── IBAN, kenmerk, tekst ─────────────────────────────

function ibanNorm(i) { return i == null ? '' : String(i).replace(/\s+/g, '').toUpperCase(); }
function isEer(iban) { return EER.has(ibanNorm(iban).slice(0, 2)); }
function bicVoor(iban) { const s = ibanNorm(iban); return s.slice(0, 2) === 'NL' ? BIC[s.slice(4, 8)] || null : null; }
function kenmerkOk(k) {
  if (!/^\d{16}$/.test(k)) return false;
  const d = k.slice(1).split('').reverse();
  let s = 0;
  d.forEach((c, i) => { s += Number(c) * KENMERK_GEWICHT[i % 10]; });
  let c = 11 - (s % 11);
  if (c === 10) c = 1; else if (c === 11) c = 0;
  return c === Number(k[0]);
}
// RF-referentie (ISO 11649): RF + 2 controlecijfers + 1–21 tekens, mod-97 = 1
function rfOk(r) {
  if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(r)) return false;
  const s = r.slice(4) + r.slice(0, 4);
  let rest = 0;
  for (const ch of s) { const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch; for (const x of v) rest = (rest * 10 + Number(x)) % 97; }
  return rest === 1;
}
// Letters die NFKD niet opsplitst (diffreview wv1405 #11: anders werd "Łódź" "odz")
const LETTER = { ß: 'ss', Æ: 'AE', æ: 'ae', Ø: 'O', ø: 'o', Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', Þ: 'TH', þ: 'th', Œ: 'OE', œ: 'oe', ı: 'i' };
// Basis-Latijnse set van de EPC: a-z A-Z 0-9 / - ? : ( ) . , ' + spatie. Accenten weg, ß → ss, & → en, de rest een spatie.
function tekst(s, max) {
  let t = String(s == null ? '' : s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[ßÆæØøŁłĐđÞþŒœı]/g, (x) => LETTER[x])
    .replace(/&/g, ' en ').replace(/[\u2018\u2019`\u00b4]/g, "'");
  t = t.replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.slice(0, max).trim();
}
// Referentie/id: dezelfde set, niet beginnen of eindigen met '/', geen '//' (ABN-addendum 1.2).
function id(s, max) {
  let t = tekst(s, max).replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  return t.slice(0, max);
}
/*
 * Omschrijving voor de ontvanger. Een geldig betalingskenmerk (16 cijfers, elfproef) → gestructureerd (SCOR, Issr CUR; Betaalvereniging NL IG
 * Annex A); een geldige RF-referentie → gestructureerd (SCOR, Issr ISO); anders vrije tekst = factuurnummer + kenmerk (140). Een kenmerk van 16
 * cijfers dat de elfproef niet haalt, is vermoedelijk een lees- of tikfout: dan vrije tekst met waarschuwing `kenmerk_fout` (de route laat hem
 * alleen mee met een uitdrukkelijke keuze; review wv1405 #9).
 */
function omschrijving(f) {
  const k = String(f.kenmerk || '').replace(/[\s.]/g, '');
  if (/^\d{16}$/.test(k) && kenmerkOk(k)) return { strd: { ref: k, issr: 'CUR' } };
  const rf = k.toUpperCase();
  if (/^RF/.test(rf) && rfOk(rf)) return { strd: { ref: rf, issr: 'ISO' } };
  const u = tekst([f.nummer, f.kenmerk].filter(Boolean).join(' '), 140);
  const uit = { ustrd: u || null };
  if (/^\d{16}$/.test(k)) uit.waarschuwing = 'kenmerk_fout';
  return uit;
}
function bedrag(centen) {
  if (!Number.isSafeInteger(centen) || centen <= 0 || centen > 99999999999) throw new Error('sepa: bedrag');
  return Math.floor(centen / 100) + '.' + String(centen % 100).padStart(2, '0');
}

// ───────────────────────────── het bestand ─────────────────────────────

function x(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
/*
 * Blokken uit regels: één PmtInf per uitvoerdatum, oplopend; binnen een blok de volgorde van de regels. PmtInfId = MsgId + '-' + volgnummer.
 * regels = [{ factuur, datum, centen, iban, naam, rmt }] → [{ pmtinf_id, volgnr, datum, regels }]
 */
function blokken(msgId, regels) {
  const per = new Map();
  for (const r of regels) { if (!per.has(r.datum)) per.set(r.datum, []); per.get(r.datum).push(r); }
  return [...per.keys()].sort().map((d, i) => ({ pmtinf_id: msgId + '-' + (i + 1), volgnr: i + 1, datum: d, regels: per.get(d) }));
}
/*
 * Het pain.001.001.09-bestand, deterministisch uit (kop, regels): dezelfde invoer geeft byte voor byte hetzelfde bestand (opnieuw downloaden
 * met dezelfde MsgId; review wv1405 #2). kop = { msg_id, cre_dt_tm, initg_naam, dbtr_naam, dbtr_iban, dbtr_bic }.
 */
function xml(kop, regels) {
  if (!regels.length || regels.length > MAX_REGELS) throw new Error('sepa: aantal regels');
  const bl = blokken(kop.msg_id, regels);
  const som = (l) => l.reduce((s, r) => s + r.centen, 0);
  const o = [];
  const r = (n, s) => o.push('  '.repeat(n) + s);
  o.push('<?xml version="1.0" encoding="UTF-8"?>');
  o.push('<Document xmlns="' + NS + '" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">');
  r(1, '<CstmrCdtTrfInitn>');
  r(2, '<GrpHdr>');
  r(3, '<MsgId>' + x(kop.msg_id) + '</MsgId>');
  r(3, '<CreDtTm>' + x(kop.cre_dt_tm) + '</CreDtTm>');
  r(3, '<NbOfTxs>' + regels.length + '</NbOfTxs>');
  r(3, '<CtrlSum>' + bedrag(som(regels)) + '</CtrlSum>');
  r(3, '<InitgPty><Nm>' + x(tekst(kop.initg_naam, 70)) + '</Nm></InitgPty>');
  r(2, '</GrpHdr>');
  for (const b of bl) {
    r(2, '<PmtInf>');
    r(3, '<PmtInfId>' + x(b.pmtinf_id) + '</PmtInfId>');
    r(3, '<PmtMtd>TRF</PmtMtd>');
    r(3, '<NbOfTxs>' + b.regels.length + '</NbOfTxs>');
    r(3, '<CtrlSum>' + bedrag(som(b.regels)) + '</CtrlSum>');
    r(3, '<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>');
    r(3, '<ReqdExctnDt><Dt>' + b.datum + '</Dt></ReqdExctnDt>');
    r(3, '<Dbtr><Nm>' + x(tekst(kop.dbtr_naam, 70)) + '</Nm></Dbtr>');
    r(3, '<DbtrAcct><Id><IBAN>' + x(kop.dbtr_iban) + '</IBAN></Id></DbtrAcct>');
    r(3, kop.dbtr_bic ? '<DbtrAgt><FinInstnId><BICFI>' + x(kop.dbtr_bic) + '</BICFI></FinInstnId></DbtrAgt>'
      : '<DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>');
    r(3, '<ChrgBr>SLEV</ChrgBr>');
    for (const t of b.regels) {
      r(3, '<CdtTrfTxInf>');
      r(4, '<PmtId><EndToEndId>' + x(id(t.factuur, 35)) + '</EndToEndId></PmtId>');
      r(4, '<Amt><InstdAmt Ccy="EUR">' + bedrag(t.centen) + '</InstdAmt></Amt>');
      r(4, '<Cdtr><Nm>' + x(tekst(t.naam, 70)) + '</Nm></Cdtr>');
      r(4, '<CdtrAcct><Id><IBAN>' + x(ibanNorm(t.iban)) + '</IBAN></Id></CdtrAcct>');
      if (t.rmt && t.rmt.strd) {
        r(4, '<RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry><Issr>' + x(t.rmt.strd.issr) + '</Issr></Tp><Ref>' + x(t.rmt.strd.ref) +
          '</Ref></CdtrRefInf></Strd></RmtInf>');
      } else if (t.rmt && t.rmt.ustrd) r(4, '<RmtInf><Ustrd>' + x(t.rmt.ustrd) + '</Ustrd></RmtInf>');
      r(3, '</CdtTrfTxInf>');
    }
    r(2, '</PmtInf>');
  }
  r(1, '</CstmrCdtTrfInitn>');
  o.push('</Document>');
  return { tekst: o.join('\n') + '\n', blokken: bl };
}
// Vingerafdruk van de inhoud zonder MsgId en tijd (die zijn per bestand nieuw): de controle tussen voorbeeld en download (review wv1405 #3).
function inhoudSleutel(kop, regels) {
  const c = { rek: ibanNorm(kop.dbtr_iban), bic: kop.dbtr_bic || null, dbtr: tekst(kop.dbtr_naam, 70),
    r: regels.map((t) => [t.factuur, t.datum, t.centen, ibanNorm(t.iban), tekst(t.naam, 70), t.rmt || null]) };
  return crypto.createHash('sha256').update(JSON.stringify(c), 'utf8').digest('hex');
}
function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
// MsgId: "SOCEV-JJJJMMDD-<8 hex>" (23 tekens; ABN: een jaar uniek; ING: nieuw MsgId = nieuw bestand). Het toeval komt van de beller (puur).
function nieuwMsgId(vandaag, hex8) {
  if (!isIso(vandaag) || !/^[0-9a-f]{8}$/.test(String(hex8))) throw new Error('sepa: msgid');
  return 'SOCEV-' + vandaag.replace(/-/g, '') + '-' + hex8;
}
module.exports = {
  isBelastingdienst, BD_MARGE,
  FORMAAT, NS, MAX_VOORUIT, MAX_REGELS, EER, BIC, isWerkdag, werkdagVanaf, werkdagTot, pasen, grenzen, uitvoerVoor, datumFout, isEer, bicVoor,
  kenmerkOk, rfOk, tekst, id, omschrijving, bedrag, blokken, xml, inhoudSleutel, sha256, nieuwMsgId,
};
