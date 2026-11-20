'use strict';
/*
 * nmbrs-betaal.js — betaallijst van een POT-loonrun uit Nmbrs (wv3208, 16-11-2026). PUUR: geen netwerk, geen bestanden, geen klok.
 *
 * WAAROM. David (16-11-2026, knop-Ja 8c6dd086): "Socev ziet een nieuwe POT-loonrun zelf in Nmbrs en zet hem als betaallijst klaar voor de
 * klikrobot, met Davids betaaldatum." De POT-rekening is bij ABN een privérekening: geen batchupload, dus zet de Chrome-extensie POT-invoer
 * elke betaling los in de ABN-takenlijst. wv3208–3229 haalden daarvoor het SEPA-document van Nmbrs op; dat is voor de POT leeg (0 bytes).
 * David 16-11 17:59: "Nmbrs levert geen SEPA voor de POT, maar een CSV … daarom hadden we afgesproken dat jij hem maakt." Sinds wv3232
 * maakt Socev de lijst dus zelf: netto per medewerker uit de run output (looncode 9880 Per Bank; 9900 Totaal netto ter controle), IBAN uit
 * employees/bankaccounts, naam en personeelsnummer uit de eigen Nmbrs-kopie. Download als CSV in het formaat van de Nmbrs-betaallijst
 * (dat de extensie al leest, plus kolom Betaaldatum) of als pain.001.001.09 (facturen-sepa.js) met de POT-rekening uit de Facturen-app.
 *
 * GRENS. Hier wordt niets betaald of verstuurd. Het bestand gaat alleen als download naar Davids app; hij zet het met de extensie in de
 * ABN-takenlijst en ondertekent daar zelf (grondwet 1 en 6).
 *
 * CONTROLES (hard = geen bestand): run output leesbaar, minstens één betaling, elk IBAN haalt mod-97, geen bedrag ≤ 0, elke betaalde
 * medewerker bekend (naam + personeelsnummer), geen dubbel IBAN, hooguit 500 regels. Zacht (David ziet het en vinkt het bewust aan): aantal
 * betalingen ≠ aantal medewerkers in de loonrun, netto niet helemaal per bank (som 9880 ≠ som 9900), IBAN kort geleden gewijzigd, de run
 * is in Nmbrs nog niet vergrendeld (voorlopig), of de lijst wijzigde na de download.
 */
const S = require('./facturen-sepa.js');

const MAX_REGELS = 500;
const MAAND = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

function ibanNorm(i) { return S.tekst(String(i == null ? '' : i).replace(/\s+/g, '').toUpperCase(), 34).replace(/\s+/g, ''); }
function mod97(iban) {
  const s = ibanNorm(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const r = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const ch of r) { const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch; for (const c of v) rest = (rest * 10 + Number(c)) % 97; }
  return rest === 1;
}
// "1234.5" of "1234.56" → centen (geheel getal); anders null. Komma's (Nmbrs NL) ook.
function centen(s) {
  const t = String(s == null ? '' : s).trim().replace(',', '.');
  if (!/^-?\d{1,11}(\.\d{1,2})?$/.test(t)) return null;
  const neg = t[0] === '-', [h, d] = t.replace('-', '').split('.');
  const c = Number(h) * 100 + Number((d || '').padEnd(2, '0'));
  return neg ? -c : c;
}
// actieplan 2B13 (Fable-review R2-46): een tekenverwijzing buiten Unicode (&#x110000;), 0 of een surrogaat wordt het vervangteken (U+FFFD);
// String.fromCodePoint gooide daar een RangeError die de hele Nmbrs-ronde afbrak. Staat het in een veld dat telt (employeeid, code, bedrag),
// dan keurt leesRunOutput de lijst af als onleesbaar; de rest van de ronde loopt door.
function teken(n) { return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\uFFFD'; }
function ont(s) {
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#x([0-9a-f]+);/gi, (m, h) => teken(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => teken(Number(d))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}
// Eerste element met deze lokale naam (zonder namespace-voorvoegsel), of null. pad = ['Cdtr','Nm'] zoekt Nm binnen Cdtr.
function el(xml, pad) {
  let t = xml;
  for (const n of pad) {
    const re = new RegExp('<(?:[A-Za-z0-9_]+:)?' + n + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?' + n + '>');
    const m = re.exec(t);
    if (!m) return null;
    t = m[1];
  }
  return t;
}
function alle(xml, n) {
  const re = new RegExp('<(?:[A-Za-z0-9_]+:)?' + n + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?' + n + '>', 'g');
  const uit = []; let m;
  while ((m = re.exec(xml)) && uit.length <= MAX_REGELS + 1) uit.push(m[1]);
  return uit;
}

/*
 * wv3228 (16-11-2026): het document van Nmbrs (GET /api/documents/{taak}) als bytes uitpakken tot XML-tekst, en een VINGERAFDRUK van de
 * vorm geven. De eerste echte lijst (R11) was "onleesbaar": utf8-decodering leverde geen pain.001 op, en welke vorm het wel was, was niet
 * te zien (alleen een sha). De vingerafdruk bevat nooit tekens uit de inhoud: bytes, content-type, begin-soort, de lagen die zijn
 * uitgepakt, bij XML de naam van het wortelelement en de namespace-URN, bij JSON alleen de sleutelnamen op topniveau (≤ 10, alleen als
 * ze op een veldnaam lijken). Geen namen, IBAN's of bedragen.
 * Uitgepakt (hooguit 4 lagen): utf-16 met BOM (of zonder BOM maar met "<\0"), utf-8 met BOM, base64, een JSON-omhulsel met een
 * base64-veld, en een zip met precies één .xml (alleen opslaan/deflate, geen versleuteling, geen zip64, ≤ 20 bestanden, ≤ 8 MB uitgepakt).
 * → { tekst: string|null, vorm: {...} }
 */
const MAX_DOC_BYTES = 8 * 1024 * 1024, MAX_ZIP_BESTANDEN = 20, MAX_LAGEN = 4;
const JSON_VELDEN = ['content', 'fileContent', 'filecontent', 'file', 'data', 'document', 'documentContent', 'bytes', 'base64', 'body', 'value'];
// review wv3228 MOET 1: de vingerafdruk neemt alleen waarden van VASTE lijsten over; al het andere wordt '?' / 'anders' (een sleutel,
// wortel of content-type kan anders een naam bevatten).
const VORM_SLEUTELS = new Set(JSON_VELDEN.concat(['fileName', 'filename', 'name', 'contentType', 'mimeType', 'mediaType', 'type', 'documentId', 'taskId',
  'id', 'status', 'size', 'length', 'encoding', 'format', 'extension', 'createdAt', 'error', 'errors', 'message', 'title', 'detail', 'traceId',
  'success', 'ok', 'result', 'payload', 'pagination', 'links', 'metadata']));
const VORM_WORTELS = new Set(['Document', 'CstmrCdtTrfInitn', 'transactions', 'Envelope', 'html', 'Error', 'error', 'root', 'Root', 'Payments', 'payments', 'SEPA', 'Sepa']);
const VORM_CT = new Set(['application/xml', 'text/xml', 'application/json', 'application/octet-stream', 'application/zip', 'application/x-zip-compressed',
  'text/plain', 'application/pdf', 'text/csv', 'text/html', 'application/base64', 'application/problem+json']);
const VORM_NS = new Set(['http://www.w3.org/1999/xhtml', 'http://schemas.xmlsoap.org/soap/envelope/', 'http://www.w3.org/2003/05/soap-envelope']);
function veldNaam(k) { return VORM_SLEUTELS.has(k) ? k : '?'; }
function nsVorm(u) {
  if (/^urn:iso:std:iso:20022:tech:xsd:(pain|camt)\.\d{3}\.\d{3}\.\d{2}$/.test(u)) return u;
  if (VORM_NS.has(u)) return u;
  return 'anders';
}
function beginSoort(b) {
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return 'utf16-bom';
  if (b.length >= 4 && ((b[0] === 0x3c && b[1] === 0 && b[2] !== 0) || (b[0] === 0 && b[1] === 0x3c))) return 'utf16';
  let i = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  while (i < b.length && i < 4096 && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  if (i >= b.length) return 'leeg';
  if (b[i] === 0x3c) return 'xml';
  if (b[i] === 0x7b || b[i] === 0x5b || b[i] === 0x22) return 'json';
  const kop = b.subarray(i, Math.min(b.length, i + 4096)).toString('latin1');
  if (/^[A-Za-z0-9+/=\r\n]{40,}$/.test(kop) || /^[A-Za-z0-9+/=\r\n]{40,}$/.test(b.subarray(i).toString('latin1').trim())) return 'base64';
  return 'anders';
}
function utf16(b) {
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b[0] === 0xfe && b[1] === 0xff) { const c = Buffer.from(b.subarray(2, b.length - (b.length % 2))); c.swap16(); return c.toString('utf16le'); }
  if (b[0] === 0 && b[1] === 0x3c) { const c = Buffer.from(b.subarray(0, b.length - (b.length % 2))); c.swap16(); return c.toString('utf16le'); }
  return b.subarray(0, b.length - (b.length % 2)).toString('utf16le');
}
function b64(s) {
  const t = String(s).replace(/\s+/g, '');
  if (t.length < 40 || t.length > MAX_DOC_BYTES * 1.4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return null;
  return Buffer.from(t, 'base64');
}
// zip: centrale map lezen (grootte staat daar, ook bij een data descriptor); precies één .xml (of precies één bestand) uitpakken.
function zipEen(b, vorm) {
  const zlib = require('zlib');
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) { vorm.zip = 'geen_centrale_map'; return null; }
  const n = b.readUInt16LE(eocd + 10), cdOff = b.readUInt32LE(eocd + 16);
  if (n === 0xffff || cdOff === 0xffffffff) { vorm.zip = 'zip64'; return null; }
  if (n > MAX_ZIP_BESTANDEN) { vorm.zip = 'te_veel_bestanden'; vorm.zip_bestanden = n; return null; }
  const ent = [];
  let o = cdOff;
  for (let k = 0; k < n; k++) {
    if (o + 46 > b.length || b.readUInt32LE(o) !== 0x02014b50) { vorm.zip = 'centrale_map_kapot'; return null; }
    const vlag = b.readUInt16LE(o + 8), meth = b.readUInt16LE(o + 10), csz = b.readUInt32LE(o + 20), usz = b.readUInt32LE(o + 24);
    const nl = b.readUInt16LE(o + 28), xl = b.readUInt16LE(o + 30), cl = b.readUInt16LE(o + 32), loh = b.readUInt32LE(o + 42);
    const naam = b.subarray(o + 46, o + 46 + nl).toString('utf8');
    ent.push({ vlag, meth, csz, usz, loh, xml: /\.xml$/i.test(naam), map: /\/$/.test(naam) });
    o += 46 + nl + xl + cl;
  }
  const bestanden = ent.filter((e) => !e.map);
  vorm.zip_bestanden = bestanden.length;
  vorm.zip_xml = bestanden.filter((e) => e.xml).length;   // aantallen, nooit bestandsnamen (die kunnen een naam bevatten)
  const xml = bestanden.filter((e) => e.xml);
  const e = xml.length === 1 ? xml[0] : bestanden.length === 1 ? bestanden[0] : null;
  if (!e) { vorm.zip = 'niet_precies_een_xml'; return null; }
  if (e.vlag & 1) { vorm.zip = 'versleuteld'; return null; }
  if (e.usz > MAX_DOC_BYTES || e.csz > b.length) { vorm.zip = 'te_groot'; return null; }
  if (e.loh + 30 > b.length || b.readUInt32LE(e.loh) !== 0x04034b50) { vorm.zip = 'lokale_kop_kapot'; return null; }
  const start = e.loh + 30 + b.readUInt16LE(e.loh + 26) + b.readUInt16LE(e.loh + 28);
  const ruw = b.subarray(start, start + e.csz);
  if (ruw.length !== e.csz) { vorm.zip = 'afgekapt'; return null; }
  try {
    if (e.meth === 0) return Buffer.from(ruw);
    if (e.meth === 8) { const u = zlib.inflateRawSync(ruw, { maxOutputLength: MAX_DOC_BYTES }); if (u.length !== e.usz) { vorm.zip = 'grootte_wijkt_af'; return null; } return u; }
  } catch (x) { vorm.zip = x && x.code === 'ERR_BUFFER_TOO_LARGE' ? 'te_groot' : 'inflate_fout'; return null; }
  vorm.zip = 'methode_' + e.meth; return null;
}
function xmlVorm(t, vorm) {
  const z = t.replace(/^\uFEFF/, '').replace(/^\s*(<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*)*/, '');
  const m = /^<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]{0,60})([^>]*)>/.exec(z);
  if (!m) { vorm.wortel = null; return; }
  vorm.wortel = VORM_WORTELS.has(m[2]) ? m[2] : 'anders';
  const pre = m[1] ? m[1].slice(0, -1) : '';
  const nsRe = new RegExp('xmlns' + (pre ? ':' + pre.replace(/[.-]/g, '\\$&') : '') + '\\s*=\\s*(["\'])([^"\']{0,200})\\1');
  const ns = nsRe.exec(m[3]);
  vorm.ns = ns ? nsVorm(ns[2]) : null;
}
function ontpak(buf, ct) {
  const b0 = Buffer.isBuffer(buf) ? buf : Buffer.from(typeof buf === 'string' ? buf : '', 'utf8');
  const ctK = ct ? String(ct).split(';')[0].trim().toLowerCase() : '';
  const vorm = { bytes: b0.length, ct: ctK ? (VORM_CT.has(ctK) ? ctK : 'anders') : null, begin: beginSoort(b0), lagen: [] };
  if (b0.length > MAX_DOC_BYTES) { vorm.lagen.push('te_groot'); return { tekst: null, vorm }; }
  let b = b0;
  for (let laag = 0; laag < MAX_LAGEN; laag++) {
    const s = beginSoort(b);
    vorm.lagen.push(s);
    if (s === 'xml') { const t = b.toString('utf8').replace(/^\uFEFF/, ''); xmlVorm(t, vorm); return { tekst: t, vorm }; }
    if (s === 'utf16-bom' || s === 'utf16') { const t = utf16(b).replace(/^\uFEFF/, ''); if (!/^\s*</.test(t)) break; xmlVorm(t, vorm); return { tekst: t, vorm }; }
    if (s === 'zip') { const u = zipEen(b, vorm); if (!u) break; b = u; continue; }
    if (s === 'base64') { const u = b64(b.toString('latin1')); if (!u) break; b = u; continue; }
    if (s === 'json') {
      let j; try { j = JSON.parse(b.toString('utf8').replace(/^\uFEFF/, '')); } catch (x) { vorm.json = 'onleesbaar'; break; }
      if (typeof j === 'string') { const u = b64(j); if (u) { b = u; continue; } if (/^\s*</.test(j)) { b = Buffer.from(j, 'utf8'); continue; } break; }
      if (!j || typeof j !== 'object' || Array.isArray(j)) { vorm.json = Array.isArray(j) ? 'lijst' : typeof j; break; }
      vorm.json_sleutels = Object.keys(j).slice(0, 10).map(veldNaam); vorm.json_aantal = Object.keys(j).length;
      // het base64-veld: eerst bekende namen, dan één niveau dieper onder data/document, dan elk lang base64-veld op topniveau
      let w = null;
      const zoek = (o) => { for (const k of JSON_VELDEN) if (o && typeof o[k] === 'string' && (b64(o[k]) || /^\s*</.test(o[k]))) return o[k]; return null; };
      w = zoek(j) || zoek(j.data && typeof j.data === 'object' ? j.data : null) || zoek(j.document && typeof j.document === 'object' ? j.document : null);
      if (!w) for (const k of Object.keys(j).slice(0, 50)) if (typeof j[k] === 'string' && j[k].length >= 200 && b64(j[k])) { w = j[k]; break; }
      if (!w) { vorm.json = 'geen_inhoudsveld'; break; }
      if (/^\s*</.test(w)) { b = Buffer.from(w, 'utf8'); continue; }
      b = b64(w); continue;
    }
    break;
  }
  return { tekst: null, vorm };
}

/*
 * wv3232: de run output van Nmbrs lezen (GET runs/{id}/wagecodes/xml?year=&wageCodes=9880&wageCodes=9900 → taak → document; gemeten 16-11:
 * <reports><report><employeeid/><period/><year/><runnumber/><lines><line><code/><description/><value>1234.56</value></line>…).
 * Een run over meer periodes heeft meer reports per medewerker: optellen. Andere looncodes worden genegeerd (de pod vraagt ze ook niet).
 * → { ok, fout?, rapporten, per: { employeeId: { bank, netto } } (centen), onleesbaar (een regel of id niet te lezen) }
 */
const CODE_BANK = 9880, CODE_NETTO = 9900;
function leesRunOutput(tekst) {
  if (typeof tekst !== 'string' || !tekst.trim() || tekst.length > MAX_DOC_BYTES) return { ok: false, fout: 'leeg of te groot' };
  if (/<!DOCTYPE|<!ENTITY/i.test(tekst)) return { ok: false, fout: 'DOCTYPE/ENTITY in het bestand' };
  if (!/^\s*(<\?[\s\S]*?\?>\s*)?<reports[\s>]/.test(tekst.replace(/^\uFEFF/, ''))) return { ok: false, fout: 'geen run output (reports)' };
  // review wv3232 ronde 2 MOET 1: een afgekapt of half document nooit als (gedeeltelijke) lijst: sluittag aan het eind en elk element dicht
  const tel = (re) => (tekst.match(re) || []).length;
  if (!/<\/reports>\s*$/.test(tekst) || tel(/<reports[\s>]/g) !== 1 || tel(/<report[\s>]/g) !== tel(/<\/report>/g) || tel(/<line[\s>]/g) !== tel(/<\/line>/g) ||
    tel(/<lines[\s>]/g) !== tel(/<\/lines>/g)) return { ok: false, fout: 'run output onvolledig' };
  const reps = alle(tekst, 'report');
  if (reps.length !== tel(/<report[\s>]/g) && reps.length <= MAX_REGELS) return { ok: false, fout: 'run output onvolledig' };
  const per = Object.create(null), sleutels = new Set();
  let onleesbaar = false, dubbel = false;
  for (const r of reps) {
    const e = el(r, ['employeeid']), id = e == null ? '' : ont(e);
    if (!/^[0-9A-Za-z-]{1,64}$/.test(id)) { onleesbaar = true; continue; }
    // review wv3232 MOET 2: twee reports voor dezelfde medewerker, periode, jaar en run = dubbel salaris; hard
    const k = id + '|' + ['year', 'period', 'runnumber'].map((n) => ont(el(r, [n]) || '')).join('|');
    // 2B13: een kapotte tekenverwijzing in jaar/periode/run zou de dubbel-controle hieronder kunnen omzeilen (andere sleutel): onleesbaar
    if (k.includes('\uFFFD')) { onleesbaar = true; continue; }
    if (sleutels.has(k)) dubbel = true;
    sleutels.add(k);
    for (const l of alle(r, 'line')) {
      const c = el(l, ['code']), v = el(l, ['value']);
      // review wv3232 ronde 3 MOET 1: een regel zonder (leesbare) code kan een 9880 zijn: hard onleesbaar, niet stil overslaan
      const code = c == null || !/^\s*\d{1,6}\s*$/.test(ont(c)) ? null : Number(ont(c));
      if (code === null) { onleesbaar = true; continue; }
      if (code !== CODE_BANK && code !== CODE_NETTO) continue;
      const cent = v == null ? null : centen(ont(v));
      if (!Number.isSafeInteger(cent)) { onleesbaar = true; continue; }
      const p = per[id] || (per[id] = { bank: 0, netto: 0 });
      if (code === CODE_BANK) p.bank += cent; else p.netto += cent;
    }
  }
  return { ok: true, rapporten: reps.length, te_veel: reps.length > MAX_REGELS, per, onleesbaar, dubbel };
}
/*
 * Regels maken. o = { medewerkers: { id: { persnr, naam } }, ibans: { id: { iban, recent } } of null (geen bankrecht) }.
 * Eén regel per medewerker met Per Bank ≠ 0 (ook negatief: dat keurt de controle af). → { regels: [{ mw, persnr, naam, iban, centen, netto, recent }] }
 */
function regelsUitRun(ro, o) {
  o = o || {};
  const regels = [];
  if (!ro || !ro.ok) return { regels };
  for (const id of Object.keys(ro.per)) {
    const p = ro.per[id];
    if (p.bank === 0) continue;
    const m = (o.medewerkers || {})[id] || null, b = o.ibans ? o.ibans[id] || null : null;
    regels.push({ mw: id, persnr: m ? m.persnr : null, naam: m ? m.naam : null, iban: b && b.iban ? ibanNorm(b.iban) : null, centen: p.bank, netto: p.netto, recent: !!(b && b.recent) });
  }
  regels.sort((a, c) => String(a.naam || '').localeCompare(String(c.naam || ''), 'nl') || String(a.persnr).localeCompare(String(c.persnr)));
  return { regels };
}
// Controles op de regels zelf (ook bij lijst en download opnieuw, op de bewaarde regels). metIban: false = nog geen bankrecht.
function controleRegels(r, metIban) {
  const hard = [];
  if (!r.length) hard.push('leeg');
  if (r.length > MAX_REGELS) hard.push('te_veel_regels');
  if (r.some((x) => !Number.isSafeInteger(x.centen))) hard.push('bedrag_onleesbaar');
  else if (r.some((x) => x.centen <= 0)) hard.push('bedrag_niet_positief');
  if (r.some((x) => !x.naam || !S.tekst(x.naam, 70) || !x.persnr)) hard.push('medewerker_onbekend');
  if (metIban) {
    if (r.some((x) => !x.iban)) hard.push('iban_ontbreekt');
    else if (r.some((x) => !mod97(x.iban))) hard.push('iban_mod97');
    const gezien = new Set();
    for (const x of r) { if (!x.iban) continue; if (gezien.has(x.iban)) { hard.push('dubbel'); break; } gezien.add(x.iban); }
  }
  return hard;
}
/*
 * o = { in_run: [employeeId] of null, definitief: run vergrendeld, met_iban: bankrecht (anders geen IBAN-controles; status wacht_iban) }. → { hard, zacht, aantal, totaal_centen, netto_centen }.
 * Codes, geen namen of bedragen (ze gaan naar de app en de melding).
 */
function controleRun(ro, sam, o) {
  o = o || {};
  const r = (sam && sam.regels) || [], hard = [], zacht = [];
  if (!ro || !ro.ok || ro.onleesbaar) hard.push('onleesbaar');
  if (ro && ro.te_veel) hard.push('te_veel_regels');
  if (ro && ro.dubbel) hard.push('dubbel_rapport');
  hard.push(...controleRegels(r, o.met_iban === true));
  const totaal = r.reduce((s, x) => s + (Number.isSafeInteger(x.centen) ? x.centen : 0), 0);
  const netto = ro && ro.ok ? Object.keys(ro.per).reduce((s, k) => s + ro.per[k].netto, 0) : 0;
  if (ro && ro.ok && (netto !== totaal || Object.keys(ro.per).some((k) => ro.per[k].netto !== ro.per[k].bank))) zacht.push('netto_niet_alles_per_bank');
  if (!Array.isArray(o.in_run)) zacht.push('medewerkers_run_onbekend');
  else {
    if (o.in_run.length !== r.length) zacht.push('aantal_medewerkers');
    const set = new Set(o.in_run);
    if (r.some((x) => !set.has(x.mw))) zacht.push('niet_in_run');
  }
  if (r.some((x) => x.recent)) zacht.push('iban_recent_gewijzigd');
  if (o.definitief !== true) zacht.push('voorlopig');
  return { hard: [...new Set(hard)], zacht: [...new Set(zacht)], aantal: r.length, totaal_centen: totaal, netto_centen: netto };
}
const UITLEG = {
  onleesbaar: 'de run output van Nmbrs is niet (helemaal) te lezen', leeg: 'er staan geen betalingen in', te_veel_regels: 'meer dan 500 betalingen',
  iban_mod97: 'een rekeningnummer haalt de controle (mod-97) niet', iban_ontbreekt: 'van een medewerker staat geen rekeningnummer in Nmbrs',
  bedrag_onleesbaar: 'een bedrag is niet te lezen', bedrag_niet_positief: 'een bedrag is nul of negatief',
  medewerker_onbekend: 'een betaalde medewerker staat (nog) niet in de kopie van Nmbrs (naam of personeelsnummer ontbreekt)',
  dubbel: 'twee betalingen naar hetzelfde rekeningnummer', dubbel_rapport: 'Nmbrs noemt dezelfde medewerker twee keer voor dezelfde periode in deze loonrun', pot_rekening_onbekend: 'de POT-rekening staat niet (geldig) in de Facturen-app',
  medewerkers_run_onbekend: 'het aantal medewerkers in de loonrun is niet bekend', aantal_medewerkers: 'het aantal betalingen is anders dan het aantal medewerkers in de loonrun',
  niet_in_run: 'een betaling is voor iemand die Nmbrs niet bij deze loonrun noemt',
  netto_niet_alles_per_bank: 'niet het hele netto gaat per bank (Per Bank wijkt af van Totaal netto)',
  iban_recent_gewijzigd: 'een rekeningnummer is de laatste 45 dagen in Nmbrs gewijzigd; controleer dat even',
  voorlopig: 'de loonrun is in Nmbrs nog niet vergrendeld; bedragen kunnen nog wijzigen', gewijzigd_na_download: 'de lijst is gewijzigd sinds je vorige download',
  regels_gewist: 'de regels zijn na 60 dagen gewist',
  verouderd: 'de lijst is meer dan 2 dagen niet bij Nmbrs nagekeken (bedragen en rekeningnummers); wacht op de ochtendronde of gebruik de lijst van Aurore',
};

function maandTekst(run, periodeSoort) {
  const p = Number(run && run.periodEnd), j = Number(run && run.year);
  if (periodeSoort === 'month' && p >= 1 && p <= 12) return MAAND[p - 1] + ' ' + j;
  return 'periode ' + (Number.isInteger(p) ? p : '?') + ' ' + j;
}
// Bestandsnaam zonder namen: POT-salarissen-2026-R12-betaal-2026-11-25.csv / .xml
function bestandNaam(run, datum, ext) {
  return 'POT-salarissen-' + Number(run.year) + '-R' + Number(run.number) + '-betaal-' + datum + '.' + (ext || 'xml');
}
// "Achternaam, Voornaam tussenvoegsel" → "Voornaam tussenvoegsel Achternaam" (voor het SEPA-bestand; de extensie draait CSV-namen zelf om)
function naamGewoon(n) { const m = /^([^,]+),\s*(.+)$/.exec(String(n || '')); return m ? m[2].trim() + ' ' + m[1].trim() : String(n || '').trim(); }
function vooraf(a) {
  const c = a.controle || {};
  if ((c.hard || []).length) return { ok: false, code: 'controle', fout: 'niet te maken: ' + c.hard.map((h) => UITLEG[h] || h).join('; ') };
  if ((c.zacht || []).length && a.bewust !== true) return { ok: false, code: 'bewust', fout: 'bevestig eerst dat je dit gezien hebt: ' + c.zacht.map((h) => UITLEG[h] || h).join('; ') };
  const df = S.datumFout(a.datum, a.vandaag);
  if (df) return { ok: false, code: 'datum', fout: df };
  return null;
}

/*
 * pain.001.001.09 voor de extensie. a = { run: {year, number, periodEnd}, periode_soort, regels: [{persnr, naam, iban, centen}], controle,
 * pot: {iban, naam}, datum, vandaag, msg_hex (8 hex, van de beller), cre_dt_tm, bewust (zachte punten gezien) }.
 * → { ok:true, naam, tekst, type, aantal, totaal_centen, sha256 } of { ok:false, fout, code }
 */
function bestand(a) {
  const v = vooraf(a); if (v) return v;
  if (!a.pot || !a.pot.iban || !mod97(a.pot.iban)) return { ok: false, code: 'controle', fout: 'niet te maken: ' + UITLEG.pot_rekening_onbekend + ' (de CSV kan wel)' };
  const oms = 'Salaris ' + maandTekst(a.run, a.periode_soort);
  const regels = a.regels.map((x, i) => ({
    factuur: S.id('POT-' + a.run.year + '-R' + a.run.number + '-' + (x.persnr || i + 1), 35) || ('POT-R' + a.run.number + '-' + (i + 1)),
    datum: a.datum, centen: x.centen, iban: x.iban, naam: naamGewoon(x.naam), rmt: { ustrd: oms },
  }));
  const kop = { msg_id: S.nieuwMsgId(a.vandaag, a.msg_hex), cre_dt_tm: a.cre_dt_tm, initg_naam: a.pot.naam, dbtr_naam: a.pot.naam,
    dbtr_iban: ibanNorm(a.pot.iban), dbtr_bic: S.bicVoor(a.pot.iban) };
  const x = S.xml(kop, regels);
  return { ok: true, naam: bestandNaam(a.run, a.datum, 'xml'), tekst: x.tekst, type: 'application/xml', aantal: regels.length, totaal_centen: regels.reduce((s, r) => s + r.centen, 0), sha256: S.sha256(x.tekst) };
}
/*
 * CSV in het formaat van de Nmbrs-betaallijst die de extensie POT-invoer leest (bouwplan POT-invoer, gemeten op Aurores R11-lijst):
 * Type;Persnr;Naam;Rekeningnr;BIC;IBAN;Bedrag pos.;Bedrag neg.;Periode;Betaaldatum;  — puntkomma ook aan het eind, Type Bankrekening,
 * bedragen in NL-notatie, periode 2026-11-M, betaaldatum JJJJ-MM-DD (de extensie neemt die over en zet het datumveld vast).
 * UTF-8 met BOM (de extensie respecteert een BOM), regeleinde CRLF. Velden zonder ; " of regeleinde; geen = + - @ vooraan.
 */
function csvVeld(t) { return String(t == null ? '' : t).replace(/[;"\r\n\t]/g, ' ').replace(/^[=+\-@\s]+/, '').trim(); }
function csvBedrag(c) { return Math.floor(c / 100) + ',' + String(c % 100).padStart(2, '0'); }
function csvBestand(a) {
  const v = vooraf(a); if (v) return v;
  const per = Number(a.run.year) + '-' + String(Number(a.run.periodEnd)).padStart(2, '0') + '-' + (a.periode_soort === 'month' ? 'M' : a.periode_soort === '4-weeks' ? '4W' : 'W');
  const kop = 'Type;Persnr;Naam;Rekeningnr;BIC;IBAN;Bedrag pos.;Bedrag neg.;Periode;Betaaldatum;';
  const rijen = a.regels.map((x) => ['Bankrekening', csvVeld(x.persnr), csvVeld(x.naam), ibanNorm(x.iban), S.bicVoor(x.iban) || '', ibanNorm(x.iban), csvBedrag(x.centen), '0,00', per, a.datum].join(';') + ';');
  const tekst = '\uFEFF' + [kop].concat(rijen).join('\r\n') + '\r\n';
  return { ok: true, naam: bestandNaam(a.run, a.datum, 'csv'), tekst, type: 'text/csv', aantal: rijen.length, totaal_centen: a.regels.reduce((s, r) => s + r.centen, 0), sha256: S.sha256(tekst) };
}

module.exports = { ontpak, leesRunOutput, regelsUitRun, controleRegels, controleRun, bestand, csvBestand, naamGewoon, mod97, centen, ibanNorm, maandTekst, bestandNaam, UITLEG,
  MAX_REGELS, CODE_BANK, CODE_NETTO };
