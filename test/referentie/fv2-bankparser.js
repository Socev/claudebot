// REFERENTIE — niet importeren. Bankparser uit het vorige systeem (FV2, n8n-Code-knoop 'Parse exports').
// Bewezen: entry_ref byte-identiek met de Python-parser over 6.963 echte transacties (ING-CSV + ABN-TAB).
// Gebruik als specificatie van de formaten en als oracle in de toetsen; schrijf de eigen parser in src/kern/.
// De laatste sectie (hoofdlogica) gebruikt n8n-helpers ($input, this.helpers) en is niet los te draaien.

// FV2 Bankimport — parse ING-CSV / ABN-TAB uploads naar genormaliseerde transacties.
// Parser is 1-op-1 geverifieerd tegen parse_bank.py (entry_ref byte-identiek, 6963/6963).
const CHUNK = 1000;

// ---------- pure-JS SHA-1 over UTF-8 bytes (geen require nodig) ----------
function utf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

function sha1Hex(str) {
  const bytes = utf8Encode(str);
  const ml = bytes.length;
  const p = bytes.slice();
  p.push(0x80);
  while (p.length % 64 !== 56) p.push(0);
  const hi = Math.floor((ml * 8) / 0x100000000);
  const lo = (ml * 8) >>> 0;
  p.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
  p.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Array(80);
  for (let off = 0; off < p.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (p[off + 4 * i] << 24) | (p[off + 4 * i + 1] << 16) | (p[off + 4 * i + 2] << 8) | p[off + 4 * i + 3];
    }
    for (let i = 16; i < 80; i++) {
      const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = ((n << 1) | (n >>> 31)) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = ((((a << 5) | (a >>> 27)) >>> 0) + (f >>> 0) + e + k + (w[i] >>> 0)) >>> 0;
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map(function (x) { return x.toString(16).padStart(8, '0'); }).join('');
}

// ---------- base64 -> bytes (fallback als helpers niet beschikbaar zijn) ----------
function base64ToBytes(b64) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = String(b64).replace(/[^A-Za-z0-9+/]/g, '');
  const out = [];
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const n1 = alpha.indexOf(clean[i]);
    const n2 = alpha.indexOf(clean[i + 1]);
    const n3 = i + 2 < clean.length ? alpha.indexOf(clean[i + 2]) : -1;
    const n4 = i + 3 < clean.length ? alpha.indexOf(clean[i + 3]) : -1;
    out.push((n1 << 2) | (n2 >> 4));
    if (n3 >= 0) out.push(((n2 & 15) << 4) | (n3 >> 2));
    if (n4 >= 0) out.push(((n3 & 3) << 6) | n4);
  }
  return out;
}

// ---------- UTF-8 decode met 'replace' (identiek aan Python errors="replace") ----------
function utf8DecodeReplace(bytes) {
  let out = '';
  let cp = 0, needed = 0, lower = 0x80, upper = 0xbf;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (needed === 0) {
      if (b <= 0x7f) out += String.fromCharCode(b);
      else if (b >= 0xc2 && b <= 0xdf) { needed = 1; cp = b & 0x1f; }
      else if (b >= 0xe0 && b <= 0xef) {
        if (b === 0xe0) lower = 0xa0;
        if (b === 0xed) upper = 0x9f;
        needed = 2; cp = b & 0xf;
      } else if (b >= 0xf0 && b <= 0xf4) {
        if (b === 0xf0) lower = 0x90;
        if (b === 0xf4) upper = 0x8f;
        needed = 3; cp = b & 0x7;
      } else out += '�';
    } else {
      if (b >= lower && b <= upper) {
        lower = 0x80; upper = 0xbf;
        cp = (cp << 6) | (b & 0x3f);
        needed--;
        if (needed === 0) {
          if (cp < 0x10000) out += String.fromCharCode(cp);
          else {
            const v = cp - 0x10000;
            out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
          }
          cp = 0;
        }
      } else {
        cp = 0; needed = 0; lower = 0x80; upper = 0xbf;
        out += '�';
        i--;
      }
    }
  }
  if (needed !== 0) out += '�';
  return out;
}

// ---------- helpers identiek aan parse_bank.py ----------
function ibanFromAbnAccount(acct) {
  const bban = 'ABNA' + String(acct).padStart(10, '0');
  const s = bban + 'NL00';
  let num = '';
  for (const c of s) num += /[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c;
  const check = 98n - (BigInt(num) % 97n);
  return 'NL' + String(check).padStart(2, '0') + bban;
}

function normAmount(s) {
  const v = Number(String(s).replace(/\./g, '').replace(',', '.'));
  if (Number.isNaN(v)) throw new Error('Ongeldig bedrag: ' + s);
  return v;
}

function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'number') {
    if (Object.is(v, -0)) return '-0.0';
    if (Number.isInteger(v)) return v.toFixed(1);
    return String(v);
  }
  return String(v);
}

function mkRef(parts) {
  return sha1Hex(parts.map(pyStr).join('|')).slice(0, 20);
}

// ---------- ING CSV (puntkomma, quotes zoals Python csv-module) ----------
function parseCsvRows(text, delim) {
  const rows = [];
  let field = '', row = [], inQuotes = false, i = 0;
  const pushField = function () { row.push(field); field = ''; };
  const pushRow = function () { pushField(); rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
    if (ch === delim) { pushField(); i++; continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i++; pushRow(); i++; continue; }
    if (ch === '\n') { pushRow(); i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

function parseIng(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const raw = parseCsvRows(text, ';');
  const nonEmpty = raw.filter(function (r) { return !(r.length === 1 && r[0] === '') && r.length > 0; });
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0];
  const rows = [];
  for (let ri = 1; ri < nonEmpty.length; ri++) {
    const vals = nonEmpty[ri];
    const r = {};
    for (let ci = 0; ci < header.length; ci++) r[header[ci]] = ci < vals.length ? vals[ci] : null;
    if (!r['Datum']) continue;
    let bedrag = normAmount(r['Bedrag (EUR)']);
    if (String(r['Af Bij']).trim() === 'Af') bedrag = -bedrag;
    const code = String(r['Code']).trim();
    const med = String(r['Mededelingen']).trim();
    const naam = String(r['Naam / Omschrijving']).trim();
    const iban = String(r['Tegenrekening']).trim() || null;
    let kenmerk = null;
    const m = med.match(/Kenmerk: (\S+)/);
    if (m) kenmerk = m[1];
    const dat = r['Datum'];
    rows.push({
      eigen_iban: String(r['Rekening']).trim(),
      boekdatum: dat.slice(0, 4) + '-' + dat.slice(4, 6) + '-' + dat.slice(6, 8),
      tegenpartij_iban: iban,
      tegenpartij_naam: naam || null,
      bedrag: bedrag,
      omschrijving: med.slice(0, 500) || null,
      betalingskenmerk: kenmerk,
      transactietype: 'ING:' + code + ':' + String(r['Mutatiesoort']).trim(),
      is_incasso: code === 'IC',
      saldo_na: String(r['Saldo na mutatie'] === null || r['Saldo na mutatie'] === undefined ? '' : r['Saldo na mutatie']).trim(),
    });
  }
  return rows;
}

// ---------- ABN ----------
const ABN_TYPES = [
  'SEPA Incasso algemeen doorlopend', 'SEPA Incasso bedrijven eenmalig',
  'SEPA Incasso', 'SEPA Overboeking', 'SEPA Periodieke overb.',
  'SEPA Batch Salaris', 'SEPA iDEAL', 'SEPA Acceptgirobetaling',
  'BEA, Betaalpas', 'BEA, Apple Pay', 'GEA, Betaalpas', 'ABN AMRO Bank N.V.',
];

function parseAbnDesc(desc) {
  const d = desc.replace(/\s+/g, ' ').trim();
  let ttype = null, iban = null, naam = null, oms = null, kenmerk = null;
  if (d.startsWith('/TRTP/')) {
    const fields = {};
    const parts = ('/' + d.slice(1)).split(/\/(TRTP|CSID|NAME|MARF|REMI|IBAN|BIC|EREF|ORDP|BENM|ULTB|PREF|NRTX)\//);
    for (let i = 1; i + 1 < parts.length; i += 2) fields[parts[i]] = parts[i + 1].trim();
    ttype = fields['TRTP'] !== undefined ? fields['TRTP'] : null;
    iban = fields['IBAN'] !== undefined ? fields['IBAN'] : null;
    naam = fields['NAME'] !== undefined ? fields['NAME'] : null;
    oms = fields['REMI'] !== undefined ? fields['REMI'] : null;
    kenmerk = fields['EREF'] !== undefined ? fields['EREF'] : null;
  } else {
    for (const t of ABN_TYPES) {
      if (d.startsWith(t)) { ttype = t; break; }
    }
    if (ttype === null) ttype = d.slice(0, 32).trim();
    let m = d.match(/IBAN: (\S+)/);
    if (m) iban = m[1];
    m = d.match(/Naam: (.*?)(?= Omschrijving:| Machtiging:| Kenmerk:| IBAN:| Betalingskenm\.:|$)/);
    if (m) naam = m[1].trim();
    m = d.match(/Omschrijving: (.*?)(?= IBAN:| Kenmerk:| Machtiging:|$)/);
    if (m) oms = m[1].trim();
    m = d.match(/(?:Kenmerk|Betalingskenm\.): (\S+)/);
    if (m) kenmerk = m[1];
    if (oms === null && naam === null) oms = d.slice(0, 200);
  }
  const isIncasso = Boolean(ttype && ttype.includes('Incasso'));
  return [ttype, iban, naam, oms, kenmerk, isIncasso];
}

function parseAbn(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 8) continue;
    const acct = parts[0], saldoNa = parts[4], d2 = parts[5], bedrag = parts[6];
    const desc = parts.slice(7).join('\t');
    const res = parseAbnDesc(desc);
    const ttype = res[0], iban = res[1], naam = res[2], oms = res[3], kenmerk = res[4], isInc = res[5];
    rows.push({
      eigen_iban: ibanFromAbnAccount(acct),
      boekdatum: d2.slice(0, 4) + '-' + d2.slice(4, 6) + '-' + d2.slice(6, 8),
      tegenpartij_iban: iban,
      tegenpartij_naam: naam,
      bedrag: normAmount(bedrag),
      omschrijving: (oms || '').slice(0, 500) || null,
      betalingskenmerk: kenmerk,
      transactietype: 'ABN:' + (ttype === null ? 'None' : ttype),
      is_incasso: isInc,
      saldo_na: saldoNa,
    });
  }
  return rows;
}

function assignEntryRefs(rows, batchName) {
  const seen = {};
  for (const r of rows) {
    const base = mkRef([r.eigen_iban, r.boekdatum, r.bedrag, r.saldo_na, r.omschrijving, r.tegenpartij_iban]);
    const n = Object.prototype.hasOwnProperty.call(seen, base) ? seen[base] : 0;
    seen[base] = n + 1;
    r.entry_ref = base + (n ? '-' + n : '');
    r.import_batch = batchName;
    delete r.saldo_na;
  }
  return rows;
}

// ---------- hoofdlogica: lees alle geüploade bestanden ----------
const allRows = [];
const fileNames = [];
const items = $input.all();
for (let idx = 0; idx < items.length; idx++) {
  const bin = items[idx].binary || {};
  for (const key of Object.keys(bin)) {
    const meta = bin[key] || {};
    const fileName = meta.fileName || key;
    let bytes = null;
    try {
      const buf = await this.helpers.getBinaryDataBuffer(idx, key);
      bytes = Array.from(buf);
    } catch (e) {
      bytes = null;
    }
    if (bytes === null) {
      if (!meta.data) throw new Error('Kan bestandsinhoud niet lezen voor ' + fileName);
      bytes = base64ToBytes(meta.data);
    }
    const text = utf8DecodeReplace(bytes);
    const firstLine = text.split('\n', 1)[0];
    const isIng = firstLine.indexOf('"Datum";') !== -1;
    const parsed = isIng ? parseIng(text) : parseAbn(text);
    assignEntryRefs(parsed, fileName);
    for (const r of parsed) {
      r.omschrijving = r.omschrijving === null ? null : r.omschrijving.slice(0, 200);
      r.transactietype = r.transactietype === null ? null : r.transactietype.slice(0, 60);
    }
    fileNames.push(fileName + ' (' + parsed.length + ')');
    allRows.push.apply(allRows, parsed);
  }
}
if (allRows.length === 0) {
  throw new Error('Geen transacties gevonden in de upload. Verwacht: ING-CSV of ABN-TAB bankexport.');
}
const out = [];
for (let i = 0; i < allRows.length; i += CHUNK) {
  out.push({ json: { rows: allRows.slice(i, i + CHUNK), bestanden: fileNames.join(', '), totaal_rijen: allRows.length } });
}
return out;
