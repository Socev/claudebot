// OVIS POT — stukken: pdf (nota's, overzichten) en Excel (.xlsx), zonder bibliotheken, zonder netwerk of klok.
// Dezelfde code in de browser (downloaden), de Functions en de pod (concepten op de notadag, fase 3): één opmaak per entiteit.
// Woorden (David 8-11-2026): POT/KM = BIJDRAGENOTA, SLOEL = NOTA DOORBELASTE HUUR; nooit "factuur", geen btw-regel; bedragen
// zonder min-teken ("af € x", "u krijgt € x terug").
import { euro, entiteitNaam, notaTitel, controleerStukTekst, uitkomstInWoorden, rond2 } from "./pot-kern.mjs";

// ---------- pdf ----------
// Helvetica-breedtes (1/1000 em) voor tekens 32–126; overige tekens (€, ë, é, …) rekenen als 556.
const W_R = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_B = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
export function tekstBreedte(t, maat, vet = false) {
  const w = vet ? W_B : W_R;
  let s = 0;
  for (const ch of String(t)) { const c = ch.codePointAt(0); s += c >= 32 && c <= 126 ? w[c - 32] : 556; }
  return (s * maat) / 1000;
}
// WinAnsi: € = 0x80, Latijn-1 gelijk; alles daarbuiten wordt '?'
function winAnsi(t) {
  const uit = [];
  for (const ch of String(t)) {
    const c = ch.codePointAt(0);
    if (ch === "€") uit.push(0x80);
    else if (ch === "–" || ch === "—" || ch === "−") uit.push(0x96);
    else if (ch === "’") uit.push(0x92);
    else if (c === 0x2009 || c === 0x202f || c === 0xa0) uit.push(0x20);
    else if (c < 256) uit.push(c);
    else uit.push(0x3f);
  }
  return uit;
}
const esc = (bytes) => bytes.map((b) => (b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b < 32 || b > 126 ? `\\${b.toString(8).padStart(3, "0")}` : String.fromCharCode(b))).join("");

/** Eenvoudige pagina-opbouw: tekst (links/rechts), lijnen, vlakken. A4 staand (595 × 842 pt) of liggend. */
export class PdfDoc {
  constructor({ liggend = false } = {}) { this.b = liggend ? 842 : 595; this.h = liggend ? 595 : 842; this.paginas = []; this.nieuw(); }
  nieuw() { this.ops = []; this.paginas.push(this.ops); this.y = this.h - 50; return this; }
  tekst(x, y, t, { maat = 10, vet = false, rechts = false, kleur = null } = {}) {
    const xx = rechts ? x - tekstBreedte(t, maat, vet) : x;
    this.ops.push(`${kleur ? kleur + " rg " : ""}BT /${vet ? "F2" : "F1"} ${maat} Tf ${xx.toFixed(2)} ${y.toFixed(2)} Td (${esc(winAnsi(t))}) Tj ET${kleur ? " 0 0 0 rg" : ""}`);
  }
  lijn(x1, y1, x2, y2, dikte = 0.5) { this.ops.push(`${dikte} w ${x1} ${y1} m ${x2} ${y2} l S`); }
  vlak(x, y, w, h, grijs = 0.94) { this.ops.push(`${grijs} g ${x} ${y} ${w} ${h} re f 0 g`); }
  /** Tekst die over regels doorloopt binnen een breedte; geeft de nieuwe y terug. */
  alinea(x, y, t, breedte, { maat = 9, vet = false, regel = 12 } = {}) {
    const woorden = String(t).split(/\s+/);
    let r = "";
    for (const w of woorden) {
      const p = r ? `${r} ${w}` : w;
      if (tekstBreedte(p, maat, vet) > breedte && r) { this.tekst(x, y, r, { maat, vet }); y -= regel; r = w; } else r = p;
    }
    if (r) { this.tekst(x, y, r, { maat, vet }); y -= regel; }
    return y;
  }
  bytes() {
    const obj = [];
    obj.push("<< /Type /Catalog /Pages 2 0 R >>");
    const kids = this.paginas.map((_, i) => `${5 + i * 2} 0 R`).join(" ");
    obj.push(`<< /Type /Pages /Kids [${kids}] /Count ${this.paginas.length} >>`);
    obj.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    obj.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    this.paginas.forEach((ops, i) => {
      const inhoud = ops.join("\n");
      obj.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.b} ${this.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
      obj.push(`<< /Length ${inhoud.length} >>\nstream\n${inhoud}\nendstream`);
    });
    let s = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    const off = [];
    obj.forEach((o, i) => { off.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const x = s.length;
    s += `xref\n0 ${obj.length + 1}\n0000000000 65535 f \n${off.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    s += `trailer\n<< /Size ${obj.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
    return u;
  }
}

const datumNl = (d) => (d ? `${Number(d.slice(8, 10))}-${Number(d.slice(5, 7))}-${d.slice(0, 4)}` : "");
/** Bedrag op een regel: positief "€ x", negatief "af € x" (nooit een min-teken). */
export const regelBedrag = (x) => (rond2(x) < 0 ? `af ${euro(x)}` : euro(x));

/**
 * Nota als pdf, vaste opmaak per entiteit: afzender (naam, adres, IBAN, KvK), debiteur zoals vastgelegd op de nota, titel
 * (BIJDRAGENOTA / NOTA DOORBELASTE HUUR), nummer = betalingskenmerk, datum en vervaldag, regels, één eindbedrag in woorden.
 * @param {{ nota:any, afzender:{naam:string, naam_document?:string, adres?:string, postcode_plaats?:string, iban?:string, kvk?:string} }} a
 */
export function notaPdf({ nota, afzender }) {
  const d = new PdfDoc();
  const L = 56, R = 539;
  const deb = typeof nota.debiteur === "string" ? JSON.parse(nota.debiteur) : nota.debiteur || {};
  const regels = typeof nota.regels === "string" ? JSON.parse(nota.regels) : nota.regels || [];
  let y = 790;
  d.tekst(L, y, afzender.naam_document || afzender.naam || entiteitNaam(nota.entiteit), { maat: 14, vet: true });
  y -= 15;
  for (const r of [afzender.adres, afzender.postcode_plaats, afzender.kvk ? `KvK ${afzender.kvk}` : null].filter(Boolean)) { d.tekst(L, y, r, { maat: 9 }); y -= 11; }
  y = 700;
  for (const r of [deb.naam, deb.houder && deb.houder !== deb.naam ? deb.houder : null, deb.tav ? (/^t\.?a\.?v\.?\s/i.test(deb.tav) ? deb.tav : `t.a.v. ${deb.tav}`) : null, deb.adres, deb.postcode_plaats].filter(Boolean)) { d.tekst(L, y, r, { maat: 10 }); y -= 13; }
  y = 610;
  d.tekst(L, y, nota.titel || notaTitel(nota.entiteit), { maat: 16, vet: true });
  y -= 24;
  const kv = [["Nummer (betalingskenmerk)", String(nota.nummer)], ["Datum", datumNl(nota.datum)], [rond2(nota.bedrag) < 0 ? "Vervaldag" : "Uiterlijk bijgeschreven", datumNl(nota.vervaldag)], ["Periode", nota.periode || ""]];
  for (const [k, v] of kv) { if (!v) continue; d.tekst(L, y, k, { maat: 9 }); d.tekst(L + 150, y, v, { maat: 9, vet: true }); y -= 13; }
  y -= 12;
  d.vlak(L - 4, y - 4, R - L + 8, 16);
  d.tekst(L, y, "Omschrijving", { maat: 9, vet: true });
  d.tekst(R, y, "Bedrag", { maat: 9, vet: true, rechts: true });
  y -= 20;
  for (const r of regels) {
    if (r.tekst) { y = d.alinea(L, y, r.omschrijving, R - L, { maat: 8 }); continue; }
    d.tekst(L, y, r.omschrijving, { maat: 10 });
    d.tekst(R, y, regelBedrag(r.bedrag), { maat: 10, rechts: true });
    y -= 13;
    if (r.toelichting) { y = d.alinea(L + 10, y, String(r.toelichting).replace(/\n/g, "; "), R - L - 120, { maat: 7.5, regel: 10 }); }
    y -= 4;
  }
  d.lijn(L, y + 6, R, y + 6);
  y -= 10;
  const totaal = rond2(nota.bedrag);
  d.tekst(L, y, totaal < 0 ? "U krijgt terug" : "Te betalen", { maat: 11, vet: true });
  d.tekst(R, y, euro(totaal), { maat: 11, vet: true, rechts: true });
  y -= 22;
  if (nota.toelichting) y = d.alinea(L, y, nota.toelichting, R - L, { maat: 9 });
  y -= 6;
  const betaal = totaal < 0
    ? "Dit bedrag wordt verrekend met uw volgende nota."
    : `Graag na binnenkomst meteen inboeken en overmaken naar ${afzender.iban || "(IBAN)"} t.n.v. ${afzender.naam_document || afzender.naam}, onder vermelding van ${nota.nummer}, zodat het bedrag uiterlijk ${datumNl(nota.vervaldag)} bijgeschreven is.`;
  y = d.alinea(L, y, betaal, R - L, { maat: 9 });
  if (nota.entiteit !== "SLOEL") {
    y -= 4;
    d.alinea(L, y, "Dit is uw bijdrage in de gezamenlijke kosten van de samenwerking (kostendeling), geen vergoeding voor een dienst.", R - L, { maat: 8 });
  }
  d.tekst(L, 40, `${entiteitNaam(nota.entiteit)} · ${nota.titel || notaTitel(nota.entiteit)} ${nota.nummer}`, { maat: 7 });
  const tekst = [nota.titel, ...regels.map((r) => r.omschrijving), nota.toelichting || "", betaal].join(" ");
  const fouten = controleerStukTekst(tekst);
  if (fouten.length) throw new Error(`stuk ${nota.nummer} geweigerd: ${fouten.join(", ")}`);
  return d.bytes();
}

/**
 * Overzicht als pdf: titel, ondertitel en secties met tabellen ({kop, kolommen:[{kop, getal?}], rijen:[[...]], voet?}).
 * Getallen worden als euro of aantal opgemaakt door de aanroeper (tekst in), zodat pdf en Excel dezelfde rijen tonen.
 */
export function overzichtPdf({ titel, sub, secties, liggend = true }) {
  const d = new PdfDoc({ liggend });
  const L = 40, R = d.b - 40;
  let y = d.h - 50;
  const kop = () => { d.tekst(L, y, titel, { maat: 14, vet: true }); y -= 14; if (sub) { d.tekst(L, y, sub, { maat: 8 }); y -= 10; } y -= 8; };
  kop();
  for (const s of secties) {
    const n = s.kolommen.length;
    const eerste = Math.min(n > 5 ? 130 : 200, (R - L) * 0.3);
    const rest = (R - L - eerste) / Math.max(1, n - 1);
    const xs = s.kolommen.map((_, i) => (i === 0 ? L : L + eerste + rest * (i - 1)));   // Codex M11
    const kopRij = () => {
      d.vlak(L - 3, y - 3, R - L + 6, 13);
      s.kolommen.forEach((k, i) => {
        let t = k.kop;   // kop inkorten tot de kolombreedte (nooit over de buurkolom heen)
        while (t.length > 1 && tekstBreedte(t, 7, true) > (i === 0 ? eerste : rest) - 6) t = t.slice(0, -2) + "…";
        if (k.getal) d.tekst(xs[i] + (i === 0 ? eerste : rest) - 4, y, t, { maat: 7, vet: true, rechts: true }); else d.tekst(xs[i], y, t, { maat: 7, vet: true });
      });
      y -= 13;
    };
    if (y < 120) { d.nieuw(); y = d.h - 50; kop(); }
    if (s.kop) { d.tekst(L, y, s.kop, { maat: 10, vet: true }); y -= 14; }
    kopRij();
    const rijen = [...s.rijen, ...(s.voet ? [s.voet] : [])];
    rijen.forEach((r, j) => {
      if (y < 50) { d.nieuw(); y = d.h - 50; kop(); kopRij(); }
      const vet = s.voet && j === rijen.length - 1;
      r.forEach((c, i) => {
        const t = String(c ?? "");
        const maxB = (i === 0 ? eerste : rest) - 6;
        let tt = t;
        while (tt.length > 1 && tekstBreedte(tt, 7.5, vet) > maxB) tt = tt.slice(0, -2) + "…";
        if (s.kolommen[i]?.getal) d.tekst(xs[i] + (i === 0 ? eerste : rest) - 4, y, tt, { maat: 7.5, vet, rechts: true });
        else d.tekst(xs[i], y, tt, { maat: 7.5, vet });
      });
      y -= 11;
    });
    if (s.noot) { y -= 2; y = d.alinea(L, y, s.noot, R - L, { maat: 7, regel: 9 }); }
    y -= 12;
  }
  const alle = [titel, sub || "", ...secties.flatMap((s) => [s.kop || "", s.noot || "", ...s.kolommen.map((k) => k.kop), ...s.rijen.flat(), ...(s.voet || [])])].join(" ");
  const fouten = controleerStukTekst(alle);
  if (fouten.length) throw new Error(`overzicht geweigerd: ${fouten.join(", ")}`);
  return d.bytes();
}

// ---------- xlsx (zip zonder compressie) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const utf8 = (s) => new TextEncoder().encode(s);
function zip(bestanden) {
  const delen = [], centraal = [];
  let off = 0;
  for (const { naam, data } of bestanden) {
    const n = utf8(naam), c = crc32(data);
    const kop = new DataView(new ArrayBuffer(30));
    kop.setUint32(0, 0x04034b50, true); kop.setUint16(4, 20, true); kop.setUint16(6, 0x0800, true); kop.setUint16(8, 0, true);
    kop.setUint16(10, 0, true); kop.setUint16(12, 0x21, true); kop.setUint32(14, c, true); kop.setUint32(18, data.length, true);
    kop.setUint32(22, data.length, true); kop.setUint16(26, n.length, true); kop.setUint16(28, 0, true);
    delen.push(new Uint8Array(kop.buffer), n, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true); cd.setUint16(14, 0x21, true); cd.setUint32(16, c, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, n.length, true); cd.setUint32(42, off, true);
    centraal.push(new Uint8Array(cd.buffer), n);
    off += 30 + n.length + data.length;
  }
  const cdLen = centraal.reduce((s, x) => s + x.length, 0);
  const eind = new DataView(new ArrayBuffer(22));
  eind.setUint32(0, 0x06054b50, true); eind.setUint16(8, bestanden.length, true); eind.setUint16(10, bestanden.length, true);
  eind.setUint32(12, cdLen, true); eind.setUint32(16, off, true);
  const alles = [...delen, ...centraal, new Uint8Array(eind.buffer)];
  const u = new Uint8Array(alles.reduce((s, x) => s + x.length, 0));
  let p = 0;
  for (const x of alles) { u.set(x, p); p += x.length; }
  return u;
}
const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const kolLetter = (i) => { let s = ""; i++; while (i) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
/**
 * Werkmap met bladen: [{naam, rijen:[[...]]}]; getallen als getal (rekenbaar in Excel), de rest als tekst. Eerste rij vet (kop).
 */
export function xlsx(bladen) {
  const namen = bladen.map((b, i) => String(b.naam || `Blad${i + 1}`).replace(/[\\/?*[\]:]/g, " ").slice(0, 31));
  const blad = (b) => {
    const rijen = b.rijen.map((r, j) => `<row r="${j + 1}">${r.map((c, i) => {
      const ref = `${kolLetter(i)}${j + 1}`;
      const st = j === 0 ? ' s="1"' : typeof c === "number" ? ' s="2"' : "";
      if (c == null || c === "") return "";
      if (typeof c === "number" && Number.isFinite(c)) return `<c r="${ref}"${st}><v>${c}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${xmlEsc(c)}</t></is></c>`;
    }).join("")}</row>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rijen}</sheetData></worksheet>`;
  };
  const f = [
    { naam: "[Content_Types].xml", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${namen.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`) },
    { naam: "_rels/.rels", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { naam: "xl/workbook.xml", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${namen.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`) },
    { naam: "xl/_rels/workbook.xml.rels", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${namen.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${namen.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { naam: "xl/styles.xml", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" applyFont="1"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`) },
    ...bladen.map((b, i) => ({ naam: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(blad(b)) })),
  ];
  return zip(f);
}

export { uitkomstInWoorden };
