'use strict';
/*
 * pot-afschrift.js — de afschriftmaker van de POT-rekening (wv787, 22-10-2026). Bouwplan: vault 01_Ontwikkeling/POT-afschriften -
 * bouwplan (App, 22-10-2026).md § 3.2; besluit F0 (Facturen-bouwplan § 5): losse module die ook de Facturen-app later aanroept.
 *
 * WAAROM. David 22-10-2026: "een functie … die 1x per maand én op verzoek de transacties in de gewenste formaten naar de boekhouder
 * stuurt per mail (MT940, PDF); Die PDF kunnen we eventueel zelfs verrijken met wat wat is." De POT-rekening is bij ABN een
 * privérekening op Davids naam; André (Acta Synergia) krijgt de afschriften dus niet vanzelf.
 *
 * PUUR. Geen database, geen bestand, geen netwerk, geen proces, geen klok: alles komt in de invoer (ook `gemaakt`), zodat dezelfde
 * invoer byte voor byte hetzelfde afschrift geeft (sha256 vergelijkbaar; Fable wv787 #2). CI-poort zoals bank-archief.js. De invoer
 * verzamelt bank-archief.js (potAfschriftInvoer); versturen zit hier niet in (grondwet regel 1).
 *
 * POT-regels zijn personeelsgegevens (namen, salarissen): fout- en weigerredenen noemen alleen maand, datum en positie, nooit een
 * naam, bedrag of saldo (Fable wv787 #9; toets in test/pot-afschrift.sh).
 */
const crypto = require('crypto');
const { leesMt940, parseAbnDesc } = require('./mt940-lezer.js');

const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const MAX86 = 6, BREED86 = 65;
const DFS_MAX = 200000;

class Weigering extends Error {}
function c(x) { return Math.round(Number(x) * 100); }
function maandNaam(m) { return MAANDEN[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4); }
function laatsteDag(m) { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)); return d.toISOString().slice(0, 10); }
function plusDagen(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function maandPlus(m, n) { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7); }
function dagNL(d) { return Number(d.slice(8, 10)) + '-' + Number(d.slice(5, 7)) + '-' + d.slice(0, 4); }
function eur(cent) {
  const a = Math.abs(cent), e = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (cent < 0 ? '-' : '') + e + ',' + String(a % 100).padStart(2, '0');
}

// ── saldoketen ────────────────────────────────────────────────────────────
// Eind van een dag = het saldo_na dat geen "saldo ervoor" van een andere post van die dag is (multiset-verschil); dat geldt voor elke
// geldige volgorde, dus ook als de volgorde zelf dubbelzinnig is (heen-en-terug op één dag; Fable wv787 #4).
function dagEind(posten) {
  const voor = new Map();
  posten.forEach(function (p) { const k = p.s - p.b; voor.set(k, (voor.get(k) || 0) + 1); });
  const eind = [];
  posten.forEach(function (p) { const n = voor.get(p.s) || 0; if (n > 0) voor.set(p.s, n - 1); else eind.push(p.s); });
  return eind.length === 1 ? eind[0] : null;
}
// Volgorde binnen een dag vanaf saldo `start`: diepte-eerst met terugzetten (geen gulzige keuze). null = sluit niet.
function dagVolgorde(posten, start) {
  let stappen = 0;
  const gebruikt = new Array(posten.length).fill(false), pad = [];
  const zoek = function (saldo) {
    if (pad.length === posten.length) return true;
    for (let i = 0; i < posten.length; i++) {
      if (gebruikt[i] || saldo + posten[i].b !== posten[i].s) continue;
      if (++stappen > DFS_MAX) return false;
      gebruikt[i] = true; pad.push(posten[i]);
      if (zoek(posten[i].s)) return true;
      gebruikt[i] = false; pad.pop();
    }
    return false;
  };
  return zoek(start) ? pad.slice() : null;
}
function perDag(posten) {
  const m = new Map();
  posten.forEach(function (p) { if (!m.has(p.datum)) m.set(p.datum, []); m.get(p.datum).push(p); });
  return Array.from(m.keys()).sort().map(function (d) { return { datum: d, posten: m.get(d).sort(function (a, b) { return b.nr - a.nr; }) }; });
}

// ── omschrijvingsregels van ABN (vrije tekst, vaste breedte 32) ───────────
// Gemeten 22-10-2026 op de POT-rekening: een vervolgregel volgt alleen op een regel van 31 of 32 tekens en breekt vaak midden in een
// woord; een regel van 32 dus zonder tussenteken aanplakken, een kortere (afgeknipte spatie) met één spatie (Fable wv787 #8).
const SLEUTEL = /^(IBAN|BIC|Naam|Omschrijving|Kenmerk|Betalingskenm\.|Incassant|Machtiging|ID debiteur)\s*:\s?/;
function plak(a, regel, vorige) { return a + (vorige.length >= 32 ? '' : ' ') + regel; }
function velden(regels) {
  const rl = (Array.isArray(regels) ? regels : []).map(function (x) { return String(x == null ? '' : x); });
  const v = { type: rl.length ? rl[0].trim() : '', vrij: rl.length ? rl[0] : '' };
  let k = null;
  for (let i = 1; i < rl.length; i++) {
    const m = SLEUTEL.exec(rl[i]);
    v.vrij = plak(v.vrij, rl[i], rl[i - 1]);
    if (m) { k = m[1]; v[k] = rl[i].slice(m[0].length); }
    else if (k) v[k] = plak(v[k], rl[i], rl[i - 1]);
  }
  Object.keys(v).forEach(function (x) { v[x] = String(v[x]).replace(/\s+/g, ' ').trim(); });
  return v;
}

// SWIFT-X-tekenset: a-z A-Z 0-9 / - ? : ( ) . , ' + spatie. Accenten eraf, & → +, rest → spatie. In een veldwaarde ook / → -, zodat een
// waarde nooit een /SLEUTEL/ van de gestructureerde vorm kan vormen.
function swiftX(s, waarde) {
  let t = String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[€]/g, 'EUR').replace(/&/g, '+')
    .replace(/[ßæœøÆŒØ]/g, function (x) { return { 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'Æ': 'AE', 'Œ': 'OE', 'Ø': 'O' }[x]; })
    .replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, ' ');
  if (waarde) t = t.replace(/\//g, '-');
  // reeksen van streepjes of dubbelepunten (een lijntje in een omschrijving) zijn niet te breken: tot één teken (Fable wv787 diff #8)
  return t.replace(/([-:])[-:\s]*[-:]/g, '$1').replace(/\s+/g, ' ').trim();
}

// ── verrijking: wat is het, en hoort er een stuk bij ──────────────────────
const PRAKTIJK = /huisarts|praktijk|gezondheidscentrum|heelkom/i;
function verrijk(p, v, eigen, stukken) {
  const bij = p.b > 0, cat = String(p.categorie || '');
  let wat, stuk, soort;
  if (p.tegen_iban && eigen.has(p.tegen_iban)) { wat = bij ? 'Van eigen rekening David' : 'Naar eigen rekening David'; stuk = 'niet nodig'; soort = 'eigen'; }
  else if (/^ABN AMRO Bank N\.V\./.test(v.type) && !p.tegen_iban) { wat = 'Bankkosten ABN AMRO'; stuk = 'niet nodig'; soort = 'bankkosten'; }
  else if (bij) { soort = 'ontvangsten'; wat = PRAKTIJK.test(p.naam) ? 'Bijdrage praktijk (voorschot POT)' : 'Ontvangst'; stuk = ''; }
  else if (cat === 'salarissen') { wat = 'Salaris'; stuk = 'loonadministratie'; soort = 'salarissen'; }
  else if (cat === 'loonheffing') { wat = 'Loonheffing'; stuk = 'loonadministratie'; soort = 'loonheffing'; }
  else if (cat === 'pensioen') { wat = 'Pensioenpremie'; stuk = 'loonadministratie'; soort = 'pensioen'; }
  else { wat = 'Overige betaling'; stuk = '?'; soort = 'overig'; }
  const s = stukken && stukken[p.nr];
  if (s && typeof s === 'object') {
    if (s.soort === 'ontbreekt') stuk = 'ontbreekt';
    else if (s.soort === 'factuur' && typeof s.tekst === 'string') stuk = s.tekst.slice(0, 24);
  }
  return { wat: wat, stuk: stuk, soort: soort };
}

// ── MT940 ─────────────────────────────────────────────────────────────────
function bedrag940(cent) { const a = Math.abs(cent); return Math.floor(a / 100) + ',' + String(a % 100).padStart(2, '0'); }
function jjmmdd(d) { return d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10); }
function dagVanJaar(d) { return Math.round((Date.parse(d + 'T12:00:00Z') - Date.parse(d.slice(0, 4) + '-01-01T12:00:00Z')) / 86400000) + 1; }
// :86: in de SEPA-vorm van ABN, of de vrije vorm (bankkosten, onbekend type). Velden in volgorde; lege velden weg; EREF zoals ABN.
function veld86(p, v) {
  const sepa = /^SEPA /.test(v.type) && (p.tegen_iban || v.IBAN);
  if (!sepa) return { vorm: 'vrij', delen: [['', swiftX(v.vrij, false)]] };
  const inc = /Incasso/.test(v.type);
  const trtp = { 'SEPA Overboeking': 'SEPA OVERBOEKING', 'SEPA Periodieke overb.': 'SEPA PERIODIEKE OVERB.', 'SEPA iDEAL': 'iDEAL' }[v.type] || v.type;
  const iban = swiftX(p.tegen_iban || v.IBAN, true).replace(/\s+/g, ''), bic = swiftX(v.BIC, true).replace(/\s+/g, '');
  const naam = swiftX(p.naam, true), remi = swiftX(v.Omschrijving, true), eref = swiftX(v.Kenmerk || v['Betalingskenm.'], true) || 'NOTPROVIDED';
  const d = inc
    ? [['TRTP', swiftX(trtp, true)], ['CSID', swiftX(v.Incassant, true)], ['NAME', naam], ['MARF', swiftX(v.Machtiging, true)], ['REMI', remi], ['IBAN', iban], ['BIC', bic], ['EREF', eref]]
    : [['TRTP', swiftX(trtp, true)], ['IBAN', iban], ['BIC', bic], ['NAME', naam], ['REMI', remi], ['EREF', eref]];
  return { vorm: 'sepa', delen: d.filter(function (x) { return x[1] !== '' || x[0] === 'REMI'; }) };
}
function tekst86(d) { return d.vorm === 'vrij' ? d.delen[0][1] : d.delen.map(function (x) { return '/' + x[0] + '/' + x[1]; }).join(''); }
// Breken op 65; een regel eindigt nooit op een spatie en de volgende begint nooit met spatie, ':' of '-' (een lezer die trimt of een
// vervolgregel als veld of afschriftsluiter ziet, verliest anders tekst). De lezer plakt zonder tussenteken: elke breuk is verliesvrij.
function breek(s) {
  const r = [];
  let i = 0;
  while (i < s.length) {
    let k = Math.min(s.length, i + BREED86);
    while (k < s.length && k > i + 1 && (s[k - 1] === ' ' || /[ :\-]/.test(s[k]))) k--;
    if (k < s.length && (s[k - 1] === ' ' || /[ :\-]/.test(s[k]))) return null;   // niet te breken (alleen spaties/streepjes)
    r.push(s.slice(i, k)); i = k;
  }
  return r;
}
function regels86(p, v) {
  const d = veld86(p, v);
  // inkorten: eerst de omschrijving (REMI), dan de naam; de vrije vorm van achteren
  const volgorde = d.vorm === 'vrij' ? [0] : ['REMI', 'NAME'].map(function (n) { return d.delen.findIndex(function (x) { return x[0] === n; }); }).filter(function (i) { return i >= 0; });
  for (let poging = 0; poging < 500; poging++) {
    const t = tekst86(d), l = t.length <= MAX86 * BREED86 ? breek(t) : null;
    if (l && l.length <= MAX86) return { regels: l, ingekort: poging > 0, deel: d };
    const i = volgorde.find(function (j) { return d.delen[j][1].length > 0; });
    if (i === undefined) break;
    const weg = Math.max(1, t.length - MAX86 * BREED86);
    d.delen[i][1] = d.delen[i][1].slice(0, Math.max(0, d.delen[i][1].length - weg)).replace(/\s+$/, '');
  }
  throw new Weigering('omschrijving past niet in :86:');
}

// ── PDF (eigen kleine schrijver: PDF 1.4, Helvetica/WinAnsi, A4 liggend) ──
// Breedtes uit de AFM van Helvetica en Helvetica-Bold (ASCII 32–126); andere tekens: breedte van de letter zonder accent, anders 556.
const BR = {
  F1: [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584],
  F2: [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584],
};
const WIN = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };
function winTeken(ch) {
  const k = ch.codePointAt(0);
  if (k >= 0x20 && k <= 0x7e) return k;
  if (k >= 0xa0 && k <= 0xff) return k;
  if (WIN[ch]) return WIN[ch];
  const b = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return b.length === 1 && b.codePointAt(0) >= 0x20 && b.codePointAt(0) <= 0x7e ? b.codePointAt(0) : 0x3f;
}
function tekenBreedte(f, ch) {
  const k = ch.codePointAt(0);
  if (k >= 32 && k <= 126) return BR[f][k - 32];
  const b = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return b.length === 1 && b.codePointAt(0) >= 32 && b.codePointAt(0) <= 126 ? BR[f][b.codePointAt(0) - 32] : 556;
}
function breedte(f, pt, s) { let w = 0; for (const ch of String(s)) w += tekenBreedte(f, ch); return w * pt / 1000; }
function pas(f, pt, s, max) {
  s = String(s == null ? '' : s).replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (breedte(f, pt, s) <= max) return s;
  while (s.length && breedte(f, pt, s + '…') > max) s = s.slice(0, -1);
  return s.replace(/\s+$/, '') + '…';
}
function hex(s) { let h = ''; for (const ch of String(s)) h += winTeken(ch).toString(16).padStart(2, '0'); return '<' + h.toUpperCase() + '>'; }
function getal(n) { return (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, '') || '0'; }

function maakPdf(d) {
  const W = 841.89, H = 595.28, M = 36, RIJ = 11, PT = 7.5;
  const kolom = [['Datum', 44, 'l'], ['Tegenpartij', 150, 'l'], ['Omschrijving', 226, 'l'], ['Wat is het', 122, 'l'], ['Stuk', 70, 'l'], ['Af', 52, 'r'], ['Bij', 52, 'r'], ['Saldo', 54, 'r']];
  const kopHoogte = 128, tabelBoven = H - M - kopHoogte, tabelOnder = M + 26;
  const perPagina1 = Math.floor((tabelBoven - tabelOnder) / RIJ) - 1, perPagina = Math.floor((H - M - 30 - tabelOnder) / RIJ) - 1;
  const rijen = d.rijen, paginas = [];
  let i = 0;
  paginas.push(rijen.slice(0, perPagina1)); i = perPagina1;
  while (i < rijen.length) { paginas.push(rijen.slice(i, i + perPagina)); i += perPagina; }
  const sam = d.samenvatting;
  // samenvatting past naast de kop of als eigen blok op de laatste pagina
  const streams = paginas.map(function (rs, pi) {
    const o = [];
    const txt = function (f, pt, x, y, s, rechts) { const w = rechts ? breedte(f, pt, s) : 0; o.push('BT /' + f + ' ' + getal(pt) + ' Tf ' + getal(x - w) + ' ' + getal(y) + ' Td ' + hex(s) + ' Tj ET'); };
    let y = H - M;
    if (pi === 0) {
      txt('F2', 14, M, y - 12, d.titel);
      txt('F1', 9, M, y - 28, d.ondertitel);
      const kv = d.kop;
      kv.forEach(function (r, j) { txt('F1', 8.5, M, y - 48 - j * 12, r[0]); txt('F2', 8.5, M + 110, y - 48 - j * 12, r[1]); });
      // samenvatting per soort, rechts naast de kop
      const sx = M + 360;
      txt('F2', 8.5, sx, y - 48, 'Per soort'); txt('F2', 8.5, sx + 210, y - 48, 'Aantal', true); txt('F2', 8.5, sx + 290, y - 48, 'Af', true); txt('F2', 8.5, sx + 370, y - 48, 'Bij', true);
      sam.forEach(function (r, j) {
        const yy = y - 60 - j * 11;
        txt('F1', 8.5, sx, yy, r.wat); txt('F1', 8.5, sx + 210, yy, String(r.aantal), true);
        txt('F1', 8.5, sx + 290, yy, r.af ? eur(r.af) : '', true); txt('F1', 8.5, sx + 370, yy, r.bij ? eur(r.bij) : '', true);
      });
      y = tabelBoven;
    } else {
      txt('F2', 9, M, y - 10, d.titel);
      y = H - M - 30;
    }
    // kopregel van de tabel
    o.push('0.85 g ' + getal(M) + ' ' + getal(y - RIJ + 2.5) + ' ' + getal(W - 2 * M) + ' ' + getal(RIJ) + ' re f 0 g');
    let x = M;
    kolom.forEach(function (k) { txt('F2', PT, k[2] === 'r' ? x + k[1] - 3 : x + 2, y - RIJ + 5, k[0], k[2] === 'r'); x += k[1]; });
    y -= RIJ;
    rs.forEach(function (r, ri) {
      if (ri % 2 === 1) o.push('0.95 g ' + getal(M) + ' ' + getal(y - RIJ + 2.5) + ' ' + getal(W - 2 * M) + ' ' + getal(RIJ) + ' re f 0 g');
      let xx = M;
      const cel = [r.datum, r.tegenpartij, r.omschrijving, r.wat, r.stuk, r.af, r.bij, r.saldo];
      kolom.forEach(function (k, ki) {
        const f = ki === 4 && (r.stuk === '?' || r.stuk === 'ontbreekt') ? 'F2' : 'F1';
        const s = pas(f, PT, cel[ki], k[1] - 5);
        txt(f, PT, k[2] === 'r' ? xx + k[1] - 3 : xx + 2, y - RIJ + 5, s, k[2] === 'r');
        xx += k[1];
      });
      y -= RIJ;
    });
    if (!rs.length && pi === 0) { txt('F1', 8.5, M + 2, y - RIJ + 4, 'Geen posten in deze maand.'); }
    // voet
    o.push('0.6 G 0.4 w ' + getal(M) + ' ' + getal(M + 18) + ' m ' + getal(W - M) + ' ' + getal(M + 18) + ' l S 0 G');
    txt('F1', 6.5, M, M + 9, pas('F1', 6.5, d.voet[0], W - 2 * M - 70));
    txt('F1', 6.5, M, M + 1, pas('F1', 6.5, d.voet[1], W - 2 * M - 70));
    txt('F1', 7, W - M, M + 9, 'pagina ' + (pi + 1) + ' van ' + paginas.length, true);
    return Buffer.from(o.join('\n') + '\n', 'latin1');
  });
  // objecten: 1 catalogus, 2 pagina's, 3 F1, 4 F2, 5 info, dan per pagina (pagina, inhoud)
  const obj = [];
  const kids = paginas.map(function (_, pi) { return (6 + pi * 2) + ' 0 R'; }).join(' ');
  obj.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'));
  obj.push(Buffer.from('<< /Type /Pages /Kids [' + kids + '] /Count ' + paginas.length + ' >>', 'latin1'));
  obj.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'latin1'));
  obj.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>', 'latin1'));
  obj.push(Buffer.from('<< /Title ' + hex(d.titel.replace(/[—–]/g, '-')) + ' /Producer (Socev) /CreationDate (D:' + d.pdfDatum + ') >>', 'latin1'));
  streams.forEach(function (st, pi) {
    obj.push(Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + (7 + pi * 2) + ' 0 R >>', 'latin1'));
    obj.push(Buffer.concat([Buffer.from('<< /Length ' + st.length + ' >>\nstream\n', 'latin1'), st, Buffer.from('endstream', 'latin1')]));
  });
  const delen = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = delen[0].length;
  const xref = [];
  obj.forEach(function (b, k) {
    const kop = Buffer.from((k + 1) + ' 0 obj\n', 'latin1'), staart = Buffer.from('\nendobj\n', 'latin1');
    xref.push(pos);
    delen.push(kop, b, staart); pos += kop.length + b.length + staart.length;
  });
  const x = ['xref', '0 ' + (obj.length + 1), '0000000000 65535 f '].concat(xref.map(function (p) { return String(p).padStart(10, '0') + ' 00000 n '; }));
  delen.push(Buffer.from(x.join('\n') + '\ntrailer\n<< /Size ' + (obj.length + 1) + ' /Root 1 0 R /Info 5 0 R >>\nstartxref\n' + pos + '\n%%EOF\n', 'latin1'));
  return Buffer.concat(delen);
}

// ── hoofdfunctie ──────────────────────────────────────────────────────────
// inv = { rekening: {iban, valuta?}, maand: 'JJJJ-MM', posten: [...booked posten van de maand...], voorDag: [...booked posten van de
// laatste dag vóór de maand...], eersteMaand: 'JJJJ-MM' (eerste maand in het archief), laatstGezien: ISO (rekening laatst gelezen),
// vandaag: 'JJJJ-MM-DD', eigenIbans: [...], stukken: {nr: {soort, tekst}}, vorigEind: centen|null (eindsaldo van het gemaakte
// afschrift van de maand ervoor), gemaakt: ISO }.
// Post = { nr, datum, bedrag, saldo_na, tegenpartij, tegen_iban, regels: [...], code, categorie }.
function maakAfschrift(inv) {
  try { return maak(inv); }
  catch (e) { if (e instanceof Weigering) return { ok: false, reden: e.message }; throw e; }
}
function maak(inv) {
  const maand = String(inv && inv.maand || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(maand)) throw new Weigering('maand als JJJJ-MM');
  const iban = String(inv.rekening && inv.rekening.iban || '').replace(/\s+/g, '').toUpperCase();
  if (!/^NL\d{2}[A-Z]{4}\d{10}$/.test(iban)) throw new Weigering('rekening zonder geldige IBAN');
  const valuta = (inv.rekening && inv.rekening.valuta) || 'EUR';
  if (!/^\d{4}-\d{2}-\d{2}T/.test(String(inv.gemaakt || ''))) throw new Weigering('gemaakt ontbreekt');
  const eind = laatsteDag(maand), vandaag = String(inv.vandaag || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(vandaag) || vandaag <= eind) throw new Weigering('de maand ' + maandNaam(maand) + ' loopt nog; het afschrift kan vanaf de 3e van de maand erna');
  // compleet: de rekening is na de 2e van de maand erna gelezen én er staat al een geboekte post van ná de maand (bewijs van de bank zelf,
  // niet van de podklok), of het is minstens de 10e (een maandbegin zonder posten)
  if (!inv.laatstGezien || String(inv.laatstGezien).slice(0, 10) < plusDagen(eind, 2) || !(String(inv.nieuwstePost || '') > eind || vandaag >= plusDagen(eind, 10)))
    throw new Weigering('de bank is na ' + dagNL(eind) + ' nog niet (genoeg) gelezen; late boekingen kunnen nog ontbreken');
  if (!inv.eersteMaand || maand <= inv.eersteMaand) throw new Weigering('de maand ' + maandNaam(maand) + ' valt (deels) vóór het begin van de bankhistorie; het beginsaldo is niet te bewijzen');

  const naarIntern = function (p, waar) {
    if (!p || typeof p.datum !== 'string' || !Number.isFinite(Number(p.bedrag)) || !Number.isFinite(Number(p.saldo_na))) throw new Weigering(waar + ': post zonder datum, bedrag of saldo');
    return Object.assign({}, p, { b: c(p.bedrag), s: c(p.saldo_na), tegen_iban: p.tegen_iban ? String(p.tegen_iban).replace(/\s+/g, '').toUpperCase() : null });
  };
  const posten = (inv.posten || []).map(function (p) { return naarIntern(p, 'maand'); });
  posten.forEach(function (p) { if (p.datum.slice(0, 7) !== maand) throw new Weigering('post buiten de maand in de invoer'); });
  const voorDag = (inv.voorDag || []).map(function (p) { return naarIntern(p, 'dag ervoor'); });
  if (!voorDag.length) throw new Weigering('geen post vóór ' + maandNaam(maand) + '; beginsaldo niet te bepalen');
  if (voorDag.some(function (p) { return p.datum !== voorDag[0].datum; }) || voorDag[0].datum >= maand + '-01') throw new Weigering('dag ervoor: ongeldige invoer');
  // beginsaldo = eind van de laatste dag ervoor (multiset; geldt voor elke geldige volgorde). Ontbreekt er een post tussen die dag en de
  // maand, dan sluit de keten van de eerste maanddag hieronder niet (Fable wv787 #5: gaten vallen zo op).
  const begin = dagEind(voorDag);
  if (begin === null) throw new Weigering('saldi sluiten niet op ' + dagNL(voorDag[0].datum));
  if (inv.vorigEind != null && Number(inv.vorigEind) !== begin)
    throw new Weigering('het eindsaldo van ' + maandNaam(maandPlus(maand, -1)) + ' is veranderd sinds dat afschrift gemaakt is (late boeking); maak dat afschrift opnieuw en stuur het André als correctie, daarna kan ' + maandNaam(maand));

  // keten door de maand
  const volgorde = [];
  let saldo = begin;
  perDag(posten).forEach(function (dg) {
    const l = dagVolgorde(dg.posten, saldo);
    if (!l) throw new Weigering('saldi sluiten niet op ' + dagNL(dg.datum) + ' (ontbreekt er een post?)');
    l.forEach(function (p) { volgorde.push(p); });
    saldo = l[l.length - 1].s;
  });
  const eindSaldo = saldo;

  // regels en verrijking
  const eigen = new Set((inv.eigenIbans || []).map(function (x) { return String(x).replace(/\s+/g, '').toUpperCase(); }));
  const rijen = volgorde.map(function (p, idx) {
    const v = velden(p.regels);
    const naam = String(v.Naam || p.tegenpartij || '').replace(/\s+/g, ' ').trim();
    const q = Object.assign({}, p, { naam: naam });
    let r86;
    try { r86 = regels86(q, v); } catch (e) { if (e instanceof Weigering) throw new Weigering(e.message + ' (post ' + (idx + 1) + ' op ' + dagNL(p.datum) + ')'); throw e; }
    const vr = verrijk(q, v, eigen, inv.stukken);
    return { idx: idx, p: q, v: v, r86: r86, vr: vr };
  });

  // MT940 (ABN-vorm: kop, :20:ABN AMRO BANK NV, :28:<JJ><dag van het jaar>/1, :60F: op de laatste dag van de maand ervoor, geen :64:)
  const L = ['ABNANL2A', '940', 'ABNANL2A', ':20:ABN AMRO BANK NV', ':25:' + iban,
    ':28:' + eind.slice(2, 4) + String(dagVanJaar(eind)).padStart(3, '0') + '/1',
    ':60F:' + (begin < 0 ? 'D' : 'C') + jjmmdd(plusDagen(maand + '-01', -1)) + valuta + bedrag940(begin)];
  rijen.forEach(function (r) {
    const code = /^\d{3}$/.test(String(r.p.code || '')) ? 'N' + r.p.code : 'NMSC';
    L.push(':61:' + jjmmdd(r.p.datum) + r.p.datum.slice(5, 7) + r.p.datum.slice(8, 10) + (r.p.b < 0 ? 'D' : 'C') + bedrag940(r.p.b) + code + 'NONREF');
    r.r86.regels.forEach(function (x, k) { L.push((k === 0 ? ':86:' : '') + x); });
  });
  L.push(':62F:' + (eindSaldo < 0 ? 'D' : 'C') + jjmmdd(eind) + valuta + bedrag940(eindSaldo));
  L.push('-');
  const mt940 = L.join('\r\n') + '\r\n';
  if (/[^\x20-\x7e\r\n]/.test(mt940)) throw new Weigering('zelfcontrole MT940: teken buiten de tekenset');

  // zelfcontrole: terug door de lezer volgens het contract (besluit F0 punt 5)
  zelfcontrole(mt940, { iban: iban, begin: begin, eind: eindSaldo, rijen: rijen });

  // telling en PDF
  const telling = { aantal: rijen.length, begin: begin, eind: eindSaldo, bij: 0, af: 0, stuk_open: 0, ingekort86: 0, per_soort: {} };
  const SOORT_NAAM = { salarissen: 'Salarissen', loonheffing: 'Loonheffing', pensioen: 'Pensioenpremie', overig: 'Overige betalingen',
    bankkosten: 'Bankkosten', eigen: 'Eigen rekening David', ontvangsten: 'Ontvangsten' };
  rijen.forEach(function (r) {
    if (r.p.b > 0) telling.bij += r.p.b; else telling.af -= r.p.b;
    if (r.vr.stuk === '?' || r.vr.stuk === 'ontbreekt') telling.stuk_open++;
    if (r.r86.ingekort) telling.ingekort86++;
    const s = telling.per_soort[r.vr.soort] || (telling.per_soort[r.vr.soort] = { aantal: 0, af: 0, bij: 0 });
    s.aantal++; if (r.p.b > 0) s.bij += r.p.b; else s.af -= r.p.b;
  });
  const shaMt = crypto.createHash('sha256').update(mt940, 'latin1').digest('hex');
  const g = String(inv.gemaakt);
  const pdf = maakPdf({
    titel: 'POT POH-GGZ — rekeningafschrift ' + maandNaam(maand),
    ondertitel: 'ABN AMRO-rekening ' + iban.replace(/(.{4})(?=.)/g, '$1 ') + ' · ' + dagNL(maand + '-01') + ' t/m ' + dagNL(eind),
    kop: [['Beginsaldo ' + dagNL(plusDagen(maand + '-01', -1)), '€ ' + eur(begin)], ['Eindsaldo ' + dagNL(eind), '€ ' + eur(eindSaldo)],
      ['Totaal bij', '€ ' + eur(telling.bij)], ['Totaal af', '€ ' + eur(telling.af)], ['Aantal posten', String(telling.aantal)],
      ['Stuk nodig (?)', String(telling.stuk_open)]],
    samenvatting: ['salarissen', 'loonheffing', 'pensioen', 'overig', 'bankkosten', 'eigen', 'ontvangsten'].filter(function (k) { return telling.per_soort[k]; })
      .map(function (k) { return { wat: SOORT_NAAM[k], aantal: telling.per_soort[k].aantal, af: telling.per_soort[k].af, bij: telling.per_soort[k].bij }; }),
    rijen: rijen.map(function (r) {
      return { datum: dagNL(r.p.datum).replace(/-\d{4}$/, ''), tegenpartij: r.p.naam || (r.vr.soort === 'bankkosten' ? 'ABN AMRO Bank N.V.' : ''),
        omschrijving: r.v.Omschrijving || (r.vr.soort === 'bankkosten' ? r.v.vrij.replace(/^ABN AMRO Bank N\.V\.\s*/, '') : ''), wat: r.vr.wat, stuk: r.vr.stuk,
        af: r.p.b < 0 ? eur(-r.p.b) : '', bij: r.p.b > 0 ? eur(r.p.b) : '', saldo: eur(r.p.s) };
    }),
    voet: ['Gemaakt door Socev op ' + dagNL(g.slice(0, 10)) + ' uit de bankkoppeling (ABN AMRO via Enable Banking); geen officieel bankafschrift. Stuk: loonadministratie = komt uit de salarisadministratie; niet nodig = geen bon nodig;',
      '? = hier hoort een bon of factuur bij, Socev ziet nog niet of die er is; ontbreekt = bekend dat het stuk ontbreekt. MT940 (zelfde posten) sha256 ' + shaMt.slice(0, 16) + '…'],
    pdfDatum: g.slice(0, 4) + g.slice(5, 7) + g.slice(8, 10) + g.slice(11, 13) + g.slice(14, 16) + g.slice(17, 19) + 'Z',
  });
  const shaPdf = crypto.createHash('sha256').update(pdf).digest('hex');
  return {
    ok: true, maand: maand, mt940: mt940, pdf: pdf, sha256: { mt940: shaMt, pdf: shaPdf }, telling: telling,
    bestandsnamen: { mt940: 'POT-' + maand + '.sta', pdf: 'POT-afschrift ' + maand + '.pdf' },
  };
}
function zelfcontrole(mt940, verwacht) {
  let a;
  try { a = leesMt940(mt940).afschriften; } catch (e) { throw new Weigering('zelfcontrole MT940: lezer weigert (' + String(e.message).slice(0, 60) + ')'); }
  const f = function (wat, i) { throw new Weigering('zelfcontrole MT940 faalde: ' + wat + (i != null ? ' bij post ' + (i + 1) : '')); };
  if (a.length !== 1) f('aantal afschriften');
  const b = a[0];
  if (b.rekening !== verwacht.iban) f('rekening');
  if (b.begin.centen !== verwacht.begin) f('beginsaldo');
  if (b.eind.centen !== verwacht.eind) f('eindsaldo');
  if (!b.sluit) f('som van de posten');
  if (b.posten.length !== verwacht.rijen.length) f('aantal posten');
  b.posten.forEach(function (q, i) {
    const r = verwacht.rijen[i];
    if (q.boekdatum !== r.p.datum || q.valutadatum !== r.p.datum) f('datum', i);
    if (q.centen !== r.p.b) f('bedrag', i);
    const o = q.ontleed || {};
    if (r.r86.deel.vorm === 'sepa') {
      const iban = (r.r86.deel.delen.find(function (x) { return x[0] === 'IBAN'; }) || [])[1];
      if (o.tegen_iban !== iban || (r.p.tegen_iban && iban !== r.p.tegen_iban)) f('tegenrekening', i);
      const naam = (r.r86.deel.delen.find(function (x) { return x[0] === 'NAME'; }) || [])[1];
      if ((o.naam || '') !== (naam || '')) f('naam', i);
      if (o.is_incasso !== /Incasso/.test(r.v.type)) f('incasso', i);
    } else if ((q.omschrijving86 || '').replace(/\s+/g, ' ').trim() !== r.r86.deel.delen[0][1]) f('omschrijving', i);
  });
}

// Mailconcept aan de boekhouder (de tekst; de MT940 en de PDF hangt server.js appPotConcept er sinds wv835 aan; versturen doet David).
// Davids stem voor iemand die hij goed kent (skill mijn-mailstem).
// o.correctie: er ging al een afschrift van deze maand naar André en er kwam daarna een boeking bij (Fable wv787 diff #3).
function mailConcept(maand, telling, o) {
  const m = maandNaam(maand);
  const regels = ['Hoi André,', '', o && o.correctie
    ? 'Hierbij opnieuw het afschrift van de POT-rekening over ' + m + ': er is na mijn vorige mail nog een boeking bij gekomen. Dit vervangt het afschrift dat ik je eerder stuurde (MT940 om in te lezen en de PDF met per regel wat het is).'
    : 'Hierbij het afschrift van de POT-rekening over ' + m + ': het MT940-bestand om in te lezen en een PDF met per regel wat het is.'];
  if (telling && telling.stuk_open > 0) regels.push('', 'Bij ' + (telling.stuk_open === 1 ? 'één betaling staat' : telling.stuk_open + ' betalingen staat') + ' een vraagteken: daar hoort een bon of factuur bij. Laat maar weten welke je nog mist.');
  regels.push('', 'Groet,', 'David');
  return { onderwerp: 'POT POH-GGZ: afschrift ' + m + (o && o.correctie ? ' (correctie)' : ''), bericht: regels.join('\n') };
}

module.exports = { maakAfschrift, mailConcept, maandNaam, laatsteDag, velden, swiftX, breek, dagEind, dagVolgorde, maakPdf, Weigering, MAANDEN };
