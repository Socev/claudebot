'use strict';
/*
 * facturen-specificatie.js — specificatie per SEPA-batch voor de boekhouder (wv2025, David 30-10-2026: "Als we een batch-betaling doen, ziet
 * hij dit als 1 bedrag in Exact Online. Hij wilt dus graag zodra wij een batch-betaling invoeren graag een mail met omschrijving welke
 * facturen er in die batch zitten (Entiteit - factuurnr - totaalbedrag). BTW boeit overigens voor ons nooit ... ook de datum waarop betaling
 * gepland staat in de batch"). Bouwplan vault 01_Ontwikkeling/Facturen-app - SEPA-batch (bouwplan 27-10-2026).md § Log.
 * Puur: alleen crypto, geen klok (de beller geeft de tijd mee). facturen.js leest sepa_batch/sepa_regel/factuur (alleen lezen) en geeft de
 * gegevens; server.js zet er een Gmail-concept van klaar (David verstuurt). Eén PmtInf per uitvoerdatum = één afschrijving op de bank: per
 * datum een blok met subtotaal. Geen btw-uitsplitsing (de entiteiten zijn btw-vrijgesteld), nooit een IBAN van een leverancier; van de eigen
 * rekening alleen de laatste vier cijfers.
 */
const crypto = require('crypto');

class SpecFout extends Error {}
const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const DAGEN = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const MAIL_REGELS = 20;   // meer regels: alleen de blokken in de mail, de regels staan in de PDF

function isoDag(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
// '2026-11-05' → 'donderdag 5 november 2026' (of zonder dag)
function datumNl(s, metDag) {
  if (!isoDag(s)) return String(s || '');
  const [j, m, d] = s.split('-').map(Number);
  const dag = DAGEN[new Date(Date.UTC(j, m - 1, d)).getUTCDay()];
  return (metDag ? dag + ' ' : '') + d + ' ' + MAANDEN[m - 1] + ' ' + j;
}
// centen → '€ 1.234,56' (negatief komt in een batch niet voor)
function eur(c) {
  const n = Math.abs(Math.round(Number(c) || 0));
  const heel = String(Math.floor(n / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (c < 0 ? '-' : '') + '€ ' + heel + ',' + String(n % 100).padStart(2, '0');
}
function schoon(s, max) {
  const t = String(s == null ? '' : s).replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return max && t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/*
 * opbouw(batch, regels) → de specificatie. batch = { id, msg_id, wanneer (ISO), dag (Amsterdamse datum van wanneer), entiteit, entiteit_naam, entiteit_kort, rekening_eind,
 * aantal, totaal_centen }; regels = [{ positie, uitvoerdatum, leverancier, nummer, centen }]. Telt na: aantal en totaal moeten met de batch
 * kloppen (anders SpecFout: liever geen specificatie dan een verkeerde).
 */
function opbouw(batch, regels) {
  if (!batch || !Array.isArray(regels) || !regels.length) throw new SpecFout('batch zonder regels');
  const per = new Map();
  for (const r of regels.slice().sort((a, b) => (a.uitvoerdatum < b.uitvoerdatum ? -1 : a.uitvoerdatum > b.uitvoerdatum ? 1 : 0) || a.positie - b.positie)) {
    if (!isoDag(r.uitvoerdatum) || !Number.isSafeInteger(r.centen) || r.centen <= 0) throw new SpecFout('regel ongeldig');
    const b = per.get(r.uitvoerdatum) || { datum: r.uitvoerdatum, aantal: 0, totaal_centen: 0, regels: [] };
    b.aantal++; b.totaal_centen += r.centen;
    b.regels.push({ leverancier: schoon(r.leverancier, 120) || 'onbekend', nummer: schoon(r.nummer, 100) || 'zonder nummer', centen: r.centen });
    per.set(r.uitvoerdatum, b);
  }
  const blokken = [...per.values()];
  const aantal = blokken.reduce((s, b) => s + b.aantal, 0), totaal = blokken.reduce((s, b) => s + b.totaal_centen, 0);
  if (aantal !== batch.aantal || totaal !== batch.totaal_centen) throw new SpecFout('aantal of totaal klopt niet met de batch');
  return {
    batch: batch.id, msg_id: String(batch.msg_id), wanneer: String(batch.wanneer), dag: isoDag(batch.dag) ? batch.dag : String(batch.wanneer).slice(0, 10), entiteit: batch.entiteit,
    entiteit_naam: schoon(batch.entiteit_naam, 120) || batch.entiteit, entiteit_kort: schoon(batch.entiteit_kort, 40) || schoon(batch.entiteit_naam, 40) || batch.entiteit,
    rekening_eind: String(batch.rekening_eind || ''), aantal, totaal_centen: totaal, blokken,
  };
}

// ── mail (Davids stem, aan zijn vader: kort, "Ha pa"; skill mijn-mailstem categorie 4, zakelijk genoeg om in de administratie te passen) ──
function mail(g) {
  const een = g.blokken.length === 1;
  const onderwerp = 'Specificatie SEPA-batch ' + g.entiteit_kort + ' (' + (een ? 'uitvoer ' + datumNl(g.blokken[0].datum) : g.blokken.length + ' uitvoerdatums') + ', ' + eur(g.totaal_centen) + ')';
  const r = ['Ha pa,', '',
    'Ik heb een SEPA-batch gemaakt voor ' + g.entiteit_naam + ' (rekening …' + g.rekening_eind + '). In Exact zie je ' +
    (een ? 'die als één afschrijving' : 'per uitvoerdatum één afschrijving') + '; hieronder en in de PDF staat welke facturen erin zitten.', ''];
  const lijst = g.aantal <= MAIL_REGELS;
  for (const b of g.blokken) {
    r.push('Uitvoerdatum ' + datumNl(b.datum, true) + ': ' + eur(b.totaal_centen) + ' (' + b.aantal + (b.aantal === 1 ? ' factuur' : ' facturen') + ')');
    if (lijst) for (const x of b.regels) r.push('- ' + x.leverancier + ' - ' + x.nummer + ' - ' + eur(x.centen));
    if (lijst) r.push('');
  }
  if (!lijst) r.push('', 'De facturen per afschrijving staan in de PDF.', '');
  r.push('Totaal ' + eur(g.totaal_centen) + ', batchkenmerk ' + g.msg_id + '.', '', 'Groet,', 'David');
  return { onderwerp: onderwerp.slice(0, 150), bericht: r.join('\n') };
}
function bestandsnaam(g) {
  return ('Specificatie SEPA-batch ' + g.entiteit_kort + ' ' + g.dag + ' ' + g.msg_id.slice(-8)).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() + '.pdf';
}

// ── PDF (eigen kleine schrijver zoals pot-afschrift.js: PDF 1.4, Helvetica/WinAnsi, A4 staand) ──
// Breedtes uit de AFM van Helvetica en Helvetica-Bold (ASCII 32–126); andere tekens: breedte van de letter zonder accent, anders 556.
const BR = {
  F1: [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584],
  F2: [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584],
};
const WIN = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
// breedtes (Helvetica-AFM) van de tekens buiten ASCII die geen gewone letter met accent zijn
const WIN_BREEDTE = { '€': 556, '‚': 222, 'ƒ': 556, '„': 333, '…': 1000, '†': 556, '‡': 556, 'ˆ': 333, '‰': 1000, '‹': 333, 'Œ': 1000, '‘': 222, '’': 222, '“': 333,
  '”': 333, '•': 350, '–': 556, '—': 1000, '˜': 333, '™': 1000, '›': 333, 'œ': 944, '·': 278, '«': 556, '»': 556, '°': 400, '×': 584, '§': 556, '©': 737, '®': 737,
  'ß': 611, 'Æ': 1000, 'æ': 889, 'Ø': 778, 'ø': 611, 'Ð': 722, 'ð': 556, 'Þ': 667, 'þ': 556 };
function zonderAccent(ch) { const b = ch.normalize('NFD').replace(/[̀-ͯ]/g, ''); return b.length === 1 && b.codePointAt(0) >= 0x20 && b.codePointAt(0) <= 0x7e ? b : null; }
function winTeken(ch) {
  const k = ch.codePointAt(0);
  if (k >= 0x20 && k <= 0x7e) return k;
  if (k >= 0xa0 && k <= 0xff) return k;
  if (WIN[ch]) return WIN[ch];
  const b = zonderAccent(ch);   // ł, ő, č … → l, o, c
  return b ? b.codePointAt(0) : ch === 'ł' ? 0x6c : ch === 'Ł' ? 0x4c : 0x3f;
}
function tekenBreedte(f, ch) {
  const k = ch.codePointAt(0);
  if (k >= 32 && k <= 126) return BR[f][k - 32];
  if (WIN_BREEDTE[ch]) return WIN_BREEDTE[ch];
  const b = zonderAccent(ch);
  return b ? BR[f][b.codePointAt(0) - 32] : 556;
}
function breedte(f, pt, s) { let w = 0; for (const ch of String(s)) w += tekenBreedte(f, ch); return w * pt / 1000; }
function pas(f, pt, s, max) {
  s = schoon(s);
  if (breedte(f, pt, s) <= max) return s;
  while (s.length && breedte(f, pt, s + '…') > max) s = s.slice(0, -1);
  return s.replace(/\s+$/, '') + '…';
}
function hex(s) { let h = ''; for (const ch of String(s)) h += winTeken(ch).toString(16).padStart(2, '0'); return '<' + h.toUpperCase() + '>'; }
function getal(n) { return (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, '') || '0'; }
function kleur(h, standaard) {
  const m = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(h || ''));
  const x = m ? [m[1], m[2], m[3]].map((v) => parseInt(v, 16) / 255) : standaard;
  return x.map((v) => getal(v)).join(' ');
}

/*
 * maakPdf(g, o) → Buffer. o = { stijl: { naam, caps, briefnaam, ondertitel, kleuren: { titel, caps, lijn, accent } } | null (sober), gemaakt: ISO (UTC),
 * gemaakt_dag: Amsterdamse datum }.
 * Briefhoofd van de entiteit (tekst en kleuren uit omzet-huisstijl.js, zonder logo), de kop van de batch, per uitvoerdatum een blok met de
 * regels (leverancier, factuurnummer, bedrag) en het subtotaal (= de afschrijving op de bank), onderaan het totaal.
 */
function maakPdf(g, o) {
  o = o || {};
  const st = o.stijl || null;
  const W = 595.28, H = 841.89, M = 50, RIJ = 15, PT = 9;
  const kol = [['Leverancier', 250, 'l'], ['Factuurnummer', 165, 'l'], ['Bedrag', W - 2 * M - 415, 'r']];
  const kTitel = kleur(st && st.kleuren && st.kleuren.titel, [0.17, 0.17, 0.17]);
  const kCaps = kleur(st && st.kleuren && st.kleuren.caps, [0.36, 0.4, 0.44]);
  const kLijn = kleur(st && st.kleuren && st.kleuren.lijn, [0.6, 0.65, 0.68]);
  const kAccent = kleur(st && st.kleuren && st.kleuren.accent, [0.17, 0.17, 0.17]);
  const paginas = [];
  let o2 = null, y = 0;
  const txt = (f, pt, x, yy, s, rechts, k) => {
    const w = rechts ? breedte(f, pt, s) : 0;
    o2.push((k ? k + ' rg ' : '') + 'BT /' + f + ' ' + getal(pt) + ' Tf ' + getal(x - w) + ' ' + getal(yy) + ' Td ' + hex(s) + ' Tj ET' + (k ? ' 0 g' : ''));
  };
  const lijn = (yy, k, dik) => o2.push(k + ' RG ' + getal(dik || 0.5) + ' w ' + getal(M) + ' ' + getal(yy) + ' m ' + getal(W - M) + ' ' + getal(yy) + ' l S 0 G');
  const nieuwePagina = () => {
    o2 = []; paginas.push(o2);
    y = H - M;
    if (paginas.length > 1) { txt('F2', 9, M, y - 10, 'Specificatie SEPA-batch ' + g.entiteit_kort + ' · kenmerk ' + g.msg_id + ' (vervolg)'); y -= 28; }
  };
  nieuwePagina();
  // briefhoofd
  const naam = (st && st.naam) || g.entiteit_naam;
  if (st && st.caps) { txt('F1', 7.5, M, y - 8, st.caps, false, kCaps); y -= 12; }
  txt('F2', 15, M, y - 14, pas('F2', 15, (st && st.briefnaam) || naam, W - 2 * M), false, kTitel); y -= 20;
  if (st && st.ondertitel) { txt('F1', 8.5, M, y - 9, pas('F1', 8.5, st.ondertitel, W - 2 * M), false, kCaps); y -= 13; }
  y -= 6; lijn(y, kAccent, 1.2); y -= 26;
  txt('F2', 13, M, y, 'Specificatie SEPA-batch'); y -= 18;
  txt('F1', 9, M, y, 'Per uitvoerdatum één afschrijving op de bank; hieronder welke facturen daarin zitten.', false, kCaps); y -= 20;
  const kv = [['Entiteit', g.entiteit_naam], ['Van rekening', '…' + g.rekening_eind], ['Batchkenmerk', g.msg_id], ['Aangemaakt op', datumNl(g.dag)],
    ['Aantal betalingen', String(g.aantal)], ['Totaal', eur(g.totaal_centen)]];
  for (const [k, v] of kv) { txt('F1', 9, M, y, k); txt('F2', 9, M + 110, y, pas('F2', 9, v, W - 2 * M - 110)); y -= 13; }
  y -= 10;
  const onder = M + 34;
  const kopRegel = () => {
    o2.push('0.93 g ' + getal(M) + ' ' + getal(y - 4) + ' ' + getal(W - 2 * M) + ' ' + getal(RIJ) + ' re f 0 g');
    let x = M;
    for (const k of kol) { txt('F2', 8, k[2] === 'r' ? x + k[1] - 4 : x + 4, y + 1, k[0], k[2] === 'r'); x += k[1]; }
    y -= RIJ;
  };
  for (const b of g.blokken) {
    // kop van het blok + kopregel + minstens één regel en het subtotaal op dezelfde pagina
    if (y - (22 + RIJ * 3) < onder) nieuwePagina();
    txt('F2', 10, M, y, 'Uitvoerdatum ' + datumNl(b.datum, true), false, kTitel);
    txt('F1', 9, W - M, y, b.aantal + (b.aantal === 1 ? ' factuur' : ' facturen') + ' · afschrijving ' + eur(b.totaal_centen), true);
    y -= 16;
    kopRegel();
    b.regels.forEach((r, i) => {
      if (y - RIJ < onder) { nieuwePagina(); txt('F2', 10, M, y, 'Uitvoerdatum ' + datumNl(b.datum, true) + ' (vervolg)', false, kTitel); y -= 16; kopRegel(); }
      if (i % 2 === 1) o2.push('0.97 g ' + getal(M) + ' ' + getal(y - 4) + ' ' + getal(W - 2 * M) + ' ' + getal(RIJ) + ' re f 0 g');
      let x = M;
      const cel = [r.leverancier, r.nummer, eur(r.centen)];
      kol.forEach((k, ki) => { txt('F1', PT, k[2] === 'r' ? x + k[1] - 4 : x + 4, y + 1, pas('F1', PT, cel[ki], k[1] - 8), k[2] === 'r'); x += k[1]; });
      y -= RIJ;
    });
    if (y - RIJ < onder) nieuwePagina();
    lijn(y + RIJ - 3.5, kLijn, 0.5);
    txt('F2', PT, M + 4, y + 1, 'Subtotaal ' + datumNl(b.datum));
    txt('F2', PT, W - M - 4, y + 1, eur(b.totaal_centen), true);
    y -= RIJ + 14;
  }
  if (y - 20 < onder) nieuwePagina();
  lijn(y + 10, kAccent, 1);
  txt('F2', 10, M + 4, y - 4, 'Totaal batch (' + g.aantal + (g.aantal === 1 ? ' factuur' : ' facturen') + ')');
  txt('F2', 10, W - M - 4, y - 4, eur(g.totaal_centen), true);
  // voet op elke pagina
  const voet = ['Bedragen zijn de totaalbedragen van de facturen, zonder btw-uitsplitsing. Rekeningnummers van leveranciers staan niet in deze specificatie.',
    'Gemaakt door Socev op ' + datumNl(isoDag(o.gemaakt_dag) ? o.gemaakt_dag : g.dag) + ' uit de SEPA-batch van de Facturen-app.'];
  paginas.forEach((p, pi) => {
    o2 = p;
    lijn(M + 20, kLijn, 0.4);
    txt('F1', 6.5, M, M + 10, pas('F1', 6.5, voet[0], W - 2 * M - 60), false, kCaps);
    txt('F1', 6.5, M, M + 2, pas('F1', 6.5, voet[1], W - 2 * M - 60), false, kCaps);
    txt('F1', 7, W - M, M + 10, 'pagina ' + (pi + 1) + ' van ' + paginas.length, true);
  });
  const asciiTitel = ('Specificatie SEPA-batch ' + g.entiteit_kort + ' ' + g.msg_id).normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/[()\\]/g, '');
  return pdfBestand(paginas, { titel: asciiTitel, gemaakt: o.gemaakt || g.wanneer, W, H });
}

// De pagina's (lijsten met PDF-opdrachten) → het PDF-bestand: catalogus, pagina's, Helvetica en Helvetica-Bold (WinAnsi), documentinfo.
// Ook voor facturen-maandspec.js (wv2060). o = { titel (ASCII), gemaakt (ISO, UTC), W, H }.
function pdfBestand(paginas, o) {
  const W = o.W || 595.28, H = o.H || 841.89;
  const streams = paginas.map((p) => Buffer.from(p.join('\n') + '\n', 'latin1'));
  // objecten: 1 catalogus, 2 pagina's, 3 F1, 4 F2, 5 info, dan per pagina (pagina, inhoud)
  const obj = [];
  const kids = streams.map((_, pi) => (6 + pi * 2) + ' 0 R').join(' ');
  const pdfDatum = String(o.gemaakt || '').replace(/[-:T]/g, '').slice(0, 14) + 'Z';   // ISO in UTC
  const asciiTitel = String(o.titel || '').normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/[()\\]/g, '');
  obj.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'));
  obj.push(Buffer.from('<< /Type /Pages /Kids [' + kids + '] /Count ' + streams.length + ' >>', 'latin1'));
  obj.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'latin1'));
  obj.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>', 'latin1'));
  obj.push(Buffer.from('<< /Title (' + asciiTitel + ') /Producer (Socev) /CreationDate (D:' + pdfDatum + ') >>', 'latin1'));   // documentinfo: geen WinAnsi
  streams.forEach((s, pi) => {
    obj.push(Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + (7 + pi * 2) + ' 0 R >>', 'latin1'));
    obj.push(Buffer.concat([Buffer.from('<< /Length ' + s.length + ' >>\nstream\n', 'latin1'), s, Buffer.from('endstream', 'latin1')]));
  });
  const delen = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = delen[0].length;
  const xref = [];
  obj.forEach((b, k) => {
    const kop = Buffer.from((k + 1) + ' 0 obj\n', 'latin1'), staart = Buffer.from('\nendobj\n', 'latin1');
    xref.push(pos);
    delen.push(kop, b, staart); pos += kop.length + b.length + staart.length;
  });
  const x = ['xref', '0 ' + (obj.length + 1), '0000000000 65535 f '].concat(xref.map((p) => String(p).padStart(10, '0') + ' 00000 n '));
  delen.push(Buffer.from(x.join('\n') + '\ntrailer\n<< /Size ' + (obj.length + 1) + ' /Root 1 0 R /Info 5 0 R >>\nstartxref\n' + pos + '\n%%EOF\n', 'latin1'));
  return Buffer.concat(delen);
}

// Alles in één: de PDF (bytes + sha256), de bestandsnaam en de mailtekst.
function maak(batch, regels, o) {
  const g = opbouw(batch, regels);
  const pdf = maakPdf(g, o);
  return { g, pdf, sha256: crypto.createHash('sha256').update(pdf).digest('hex'), naam: bestandsnaam(g), mail: mail(g) };
}

module.exports = { maak, opbouw, mail, maakPdf, bestandsnaam, datumNl, eur, SpecFout, MAIL_REGELS,
  // wv2060: de PDF-bouwstenen voor facturen-maandspec.js
  pdf: { breedte, pas, hex, getal, kleur, schoon, isoDag, pdfBestand } };
