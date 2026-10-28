'use strict';
// Kleine xlsx-schrijver voor Download als… › Excel (wv1854; bouwplan vault 01_Ontwikkeling/Download als - bouwplan (28-10-2026).md § 3.2).
// WAAROM. David wil de tabellen uit wat hij leest als Excel-bestand; in pod en image zit geen xlsx-bibliotheek. Een xlsx is een zip met een
// handvol XML-delen; Node 22 heeft zlib.crc32 en deflateRawSync, dus dit kan zonder nieuwe afhankelijkheid.
//
// schrijf([{naam, rijen: [[tekst, …], …]}]) → Buffer. De eerste rij van elk blad is de kopregel (vet, vastgezet).
// Getallen: alleen wat eenduidig een getal is wordt een getal (NL-notatie 1.234,56 en 12,5; ook 1234.5; € ervoor = valutaopmaak). Al het
// andere blijft tekst, ook nummers met een voorloopnul (telefoon, postcode-achtig) en meer dan 15 cijfers. Formules nooit: dit bestand
// bevat geen enkel <f>-element; een cel die met = + - @ begint en geen getal is, krijgt bovendien quotePrefix (Excel houdt hem ook na
// bewerken als tekst).
const zlib = require('zlib');

const MAX_CEL = 32767;      // Excel: tekens per cel
const MAX_RIJEN = 1048576;
const MAX_KOLOMMEN = 16384;

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // XML 1.0 kent geen stuurtekens; ook geen losse surrogaten
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');

// Tekst → {getal, euro} of null.
function alsGetal(ruw) {
  let t = String(ruw == null ? '' : ruw).trim().replace(/ /g, ' ');
  if (!t || t.length > 40) return null;
  let euro = false;
  const e = /^(-?)\s*€\s*(.+)$/.exec(t) || /^€\s*(-?)\s*(.+)$/.exec(t);
  if (e) { euro = true; t = e[1] + e[2].trim(); }
  let neg = false;
  if (t[0] === '-') { neg = true; t = t.slice(1); }
  let n = null;
  if (/^0\d/.test(t)) return null;                                                  // voorloopnul: geen getal (06…, 0031…)
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) n = Number(t.replace(/\./g, '').replace(',', '.'));   // 1.234 en 1.234,56
  else if (/^\d+,\d+$/.test(t)) n = Number(t.replace(',', '.'));                                   // 12,5
  else if (/^\d{1,3}(,\d{3})+\.\d+$/.test(t)) n = Number(t.replace(/,/g, ''));                    // 1,234.56
  else if (/^\d+(\.\d+)?$/.test(t)) n = Number(t);                                                 // 1234 en 3.5
  else if (euro && /^\d{1,3}(\.\d{3})*,-{1,2}$/.test(t)) n = Number(t.replace(/\./g, '').replace(/,-+$/, ''));   // € 25,-
  if (n === null || !Number.isFinite(n)) return null;
  if (t.replace(/\D/g, '').length > 15) return null;                                 // Excel rekent met 15 cijfers
  return { getal: neg ? -n : n, euro: euro };
}

// Kolomletters: 0 → A, 26 → AA
function kolom(i) { let s = ''; i++; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; }

// Bladnamen: ≤ 31 tekens, zonder []:*?/\ , niet leeg, uniek (hoofdletterongevoelig), niet "History".
function bladNamen(namen) {
  const gezien = new Set();
  return namen.map(function (n, i) {
    let b = String(n == null ? '' : n).replace(/[\[\]:*?\/\\\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31).trim();
    if (!b || /^history$/i.test(b)) b = 'Tabel ' + (i + 1);
    let kand = b, k = 2;
    while (gezien.has(kand.toLowerCase())) { const achter = ' (' + k++ + ')'; kand = b.slice(0, 31 - achter.length).trim() + achter; }
    gezien.add(kand.toLowerCase());
    return kand;
  });
}

// ── zip (alleen schrijven; deflate) ──
function zip(bestanden) {
  const lokaal = [], centraal = [];
  let ofs = 0;
  const DOS_TIJD = 0, DOS_DATUM = ((2026 - 1980) << 9) | (10 << 5) | 28;   // vaste datum: dezelfde invoer geeft dezelfde bytes
  for (const b of bestanden) {
    const naam = Buffer.from(b.naam, 'utf8');
    const data = Buffer.isBuffer(b.data) ? b.data : Buffer.from(b.data, 'utf8');
    const dicht = zlib.deflateRawSync(data, { level: 6 });
    const crc = zlib.crc32(data) >>> 0;
    const kop = Buffer.alloc(30);
    kop.writeUInt32LE(0x04034b50, 0); kop.writeUInt16LE(20, 4); kop.writeUInt16LE(0x0800, 6); kop.writeUInt16LE(8, 8);
    kop.writeUInt16LE(DOS_TIJD, 10); kop.writeUInt16LE(DOS_DATUM, 12); kop.writeUInt32LE(crc, 14);
    kop.writeUInt32LE(dicht.length, 18); kop.writeUInt32LE(data.length, 22); kop.writeUInt16LE(naam.length, 26); kop.writeUInt16LE(0, 28);
    lokaal.push(kop, naam, dicht);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(DOS_TIJD, 12); c.writeUInt16LE(DOS_DATUM, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(dicht.length, 20);
    c.writeUInt32LE(data.length, 24); c.writeUInt16LE(naam.length, 28); c.writeUInt32LE(ofs, 42);
    centraal.push(c, naam);
    ofs += 30 + naam.length + dicht.length;
  }
  if (ofs > 0xfffffff0) throw new Error('xlsx te groot voor een zip zonder zip64');
  const cd = Buffer.concat(centraal);
  const eind = Buffer.alloc(22);
  eind.writeUInt32LE(0x06054b50, 0); eind.writeUInt16LE(bestanden.length, 8); eind.writeUInt16LE(bestanden.length, 10);
  eind.writeUInt32LE(cd.length, 12); eind.writeUInt32LE(ofs, 16);
  return Buffer.concat(lokaal.concat([cd, eind]));
}

// Stijlen: 0 gewoon, 1 kop (vet, lichte achtergrond), 2 euro, 3 tekst met quotePrefix, 4 tekst met terugloop
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;€&quot;\\ #,##0.00"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF1F1EE"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" quotePrefix="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" quotePrefix="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

function schrijf(bladen) {
  if (!Array.isArray(bladen) || !bladen.length) throw new Error('geen tabellen');
  const namen = bladNamen(bladen.map(function (b) { return b.naam; }));
  const strings = [], index = new Map();
  const sIdx = function (t) { if (!index.has(t)) { index.set(t, strings.length); strings.push(t); } return index.get(t); };
  let aantalS = 0;
  const bladXml = bladen.map(function (b) {
    const rijen = (b.rijen || []).slice(0, MAX_RIJEN);
    const breed = [];
    const rx = rijen.map(function (rij, r) {
      const cellen = (rij || []).slice(0, MAX_KOLOMMEN).map(function (waarde, c) {
        let t = String(waarde == null ? '' : waarde);
        if (t.length > MAX_CEL) t = t.slice(0, MAX_CEL - 1) + '…';
        if (t === '') return '';
        const ref = kolom(c) + (r + 1);
        const lengte = Math.min(60, Math.max.apply(null, t.split('\n').map(function (x) { return x.length; })));
        breed[c] = Math.max(breed[c] || 0, lengte);
        const g = r > 0 ? alsGetal(t) : null;
        if (g) return '<c r="' + ref + '"' + (g.euro ? ' s="2"' : '') + '><v>' + g.getal + '</v></c>';
        aantalS++;
        const stijl = r === 0 ? 1 : /^[=+\-@\t\r]/.test(t) ? 3 : t.indexOf('\n') >= 0 ? 4 : 0;
        return '<c r="' + ref + '" t="s"' + (stijl ? ' s="' + stijl + '"' : '') + '><v>' + sIdx(t) + '</v></c>';
      }).join('');
      return '<row r="' + (r + 1) + '">' + cellen + '</row>';
    }).join('');
    const cols = breed.length ? '<cols>' + breed.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + Math.max(8, Math.round((w || 0) * 1.1 + 2)) + '" customWidth="1"/>'; }).join('') + '</cols>' : '';
    const vast = rijen.length > 1 ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      vast + '<sheetFormatPr defaultRowHeight="15"/>' + cols + '<sheetData>' + rx + '</sheetData></worksheet>';
  });
  const sst = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + aantalS +
    '" uniqueCount="' + strings.length + '">' + strings.map(function (t) { return '<si><t xml:space="preserve">' + xmlEsc(t) + '</t></si>'; }).join('') + '</sst>';
  const wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>' +
    namen.map(function (n, i) { return '<sheet name="' + xmlEsc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') + '</sheets></workbook>';
  const n = bladen.length;
  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    namen.map(function (x, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
    '<Relationship Id="rId' + (n + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId' + (n + 2) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>';
  const typen = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    namen.map(function (x, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  return zip([{ naam: '[Content_Types].xml', data: typen }, { naam: '_rels/.rels', data: rels }, { naam: 'xl/workbook.xml', data: wb },
    { naam: 'xl/_rels/workbook.xml.rels', data: wbRels }, { naam: 'xl/styles.xml', data: STYLES }, { naam: 'xl/sharedStrings.xml', data: sst }]
    .concat(bladXml.map(function (x, i) { return { naam: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: x }; })));
}

module.exports = { schrijf: schrijf, alsGetal: alsGetal, bladNamen: bladNamen, kolom: kolom, zip: zip };
