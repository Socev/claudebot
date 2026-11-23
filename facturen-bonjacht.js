'use strict';
/*
 * facturen-bonjacht.js — bonjacht op de lijsten "betaald, bon ontbreekt" van de boekhouder (wv3916, besluit 2C57, David 22-11-2026:
 * "Alleen voor de lijsten die mijn vader stuurt"). Ontwerp + review vooraf: /opt/data/mk-scripts/wv3916/ontwerp.md.
 *
 * WAAROM. De boekhouder stuurt een paar keer per maand een Exact Online-export (Afschriften › Af te handelen, bestand
 * CflStatementsToBeCompleted*.xlsx, soms verpakt in een Outlook-winmail.dat) met zakelijke betalingen waarvan hij de bon mist. Een groot deel
 * van die bonnen staat gewoon in Davids mail (kwitantie, orderbevestiging, factuurmail). Deze module leest zo'n lijst, koppelt elke regel aan
 * de bankregel in de Facturen-app en zoekt de bon in de mail; alleen lezen.
 *
 * VORM. Puur: geen bestand-, netwerk- of procesmodule en geen klok (CI-poort .github/workflows/build.yml). Alleen zlib (uitpakken van het
 * xlsx-zip) en crypto (sleutel). Database en lees-luik komen als functies binnen (q en io); vandaag geeft de aanroeper mee.
 *
 * WAT HIJ NIET DOET. Niets versturen, niets labelen, niets koppelen: hij geeft een uitkomst per regel. Een koppeling of document maakt de
 * aanroeper, en die wordt pas vast na Davids Bevestigen. Mailtekst blijft in het geheugen: in de uitkomst staan alleen Gmail-id, account,
 * datum, afzender, onderwerp en bijlagenamen.
 */
const zlib = require('zlib');
const crypto = require('crypto');

const GRENS = {
  bestandBytes: 5 * 1024 * 1024,   // groter = geen lijst van de boekhouder
  zipItems: 400,
  uitgepakt: 20 * 1024 * 1024,     // zip-bom: werkelijk uitgepakt over het hele bestand
  itemUitgepakt: 8 * 1024 * 1024,  // en per zip-item
  regels: 2000,
  kandidatenPerRegel: 8,           // zoveel mails per account lezen we per regel na
  vensterVoor: 30,                 // dagen vóór de boekdatum
  vensterNa: 10,
  bankMarge: 3,                    // boekdatum in Exact ± zoveel dagen t.o.v. de bank
  hoogBinnen: 3,                   // treffer binnen zoveel dagen van de boekdatum = zekerheid hoog
};
const LIJST_NAAM = /^CflStatementsToBeCompleted/i;

// ───────────────────────────── TNEF (winmail.dat) ─────────────────────────────
// Outlook verpakt bijlagen soms in TNEF. Attribuut = niveau(1) id(4) lengte(4) data checksum(2); 0x00018010 = naam, 0x0006800F = data.
function tnefBijlagen(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 6 || buf.readUInt32LE(0) !== 0x223E9F78) return [];
  const uit = []; let p = 6, naam = null;
  while (p + 9 <= buf.length && uit.length < 50) {
    const id = buf.readUInt32LE(p + 1), len = buf.readUInt32LE(p + 5);
    if (p + 9 + len > buf.length) break;
    const data = buf.subarray(p + 9, p + 9 + len);
    if (id === 0x00018010) naam = data.toString('latin1').replace(/\0+$/, '');
    else if (id === 0x0006800F) { uit.push({ naam: naam || 'bijlage', bytes: Buffer.from(data) }); naam = null; }
    p += 9 + len + 2;
  }
  return uit;
}

// ───────────────────────────── xlsx (zip) ─────────────────────────────
function zipItems(buf) {
  const min = Math.max(0, buf.length - 65557);
  let e = -1;
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('geen zip');
  const n = buf.readUInt16LE(e + 10), cd = buf.readUInt32LE(e + 16);
  if (n > GRENS.zipItems) throw new Error('te veel items');
  const items = {}; let p = cd, totaal = 0;
  for (let k = 0; k < n; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip kapot');
    const methode = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lh = buf.readUInt32LE(p + 42);
    const naam = buf.toString('utf8', p + 46, p + 46 + nl);
    items[naam] = { methode, csize, usize, lh };
    totaal += usize;
    if (totaal > GRENS.uitgepakt) throw new Error('uitgepakt te groot');
    p += 46 + nl + xl + cl;
  }
  let uitgepakt = 0;   // werkelijk uitgepakte bytes over het hele bestand (review MOET 1: de opgegeven groottes zijn niet te vertrouwen)
  return function lees(naam) {
    const it = items[naam]; if (!it) return null;
    const ruimte = GRENS.uitgepakt - uitgepakt;
    if (ruimte <= 0) throw new Error('uitgepakt te groot');
    if (it.lh + 30 > buf.length || buf.readUInt32LE(it.lh) !== 0x04034b50) throw new Error('zip kapot');
    const start = it.lh + 30 + buf.readUInt16LE(it.lh + 26) + buf.readUInt16LE(it.lh + 28);
    const data = buf.subarray(start, start + it.csize);
    // maxOutputLength gooit een RangeError zodra de uitvoer de ruimte overschrijdt: er komt nooit meer dan GRENS.uitgepakt in het geheugen
    const ruw = it.methode === 0 ? data : it.methode === 8 ? zlib.inflateRawSync(data, { maxOutputLength: Math.min(ruimte, GRENS.itemUitgepakt) }) : null;
    if (!ruw) throw new Error('zipmethode ' + it.methode);
    if (ruw.length > ruimte) throw new Error('uitgepakt te groot');
    uitgepakt += ruw.length;
    return ruw.toString('utf8');
  };
}
function xmlTekst(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, function (m, c) {
    const l = c.toLowerCase();
    if (l === 'amp') return '&'; if (l === 'lt') return '<'; if (l === 'gt') return '>'; if (l === 'quot') return '"'; if (l === 'apos') return "'";
    const n = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
  });
}
function tTekst(xml) { let s = ''; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let m; while ((m = re.exec(xml))) s += xmlTekst(m[1]); return s; }
// Eerste werkblad als rijen { A: '…', B: '…' }.
function xlsxRijen(buf) {
  const lees = zipItems(buf);
  const ssXml = lees('xl/sharedStrings.xml') || '';
  const ss = []; const reSi = /<si>([\s\S]*?)<\/si>/g; let m;
  while ((m = reSi.exec(ssXml))) ss.push(tTekst(m[1]));
  const blad = lees('xl/worksheets/sheet1.xml');
  if (!blad) throw new Error('geen werkblad');
  const rijen = []; const reRow = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  while ((m = reRow.exec(blad))) {
    const r = {}; const reC = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let c;
    while ((c = reC.exec(m[1]))) {
      const ref = (/\br="([A-Z]+)\d+"/.exec(c[1]) || [])[1]; if (!ref) continue;
      const t = (/\bt="([a-zA-Z]+)"/.exec(c[1]) || [])[1];
      const binnen = c[2] || '';
      const v = (/<v>([\s\S]*?)<\/v>/.exec(binnen) || [])[1];
      let x = '';
      if (t === 's' && v !== undefined) x = ss[parseInt(v, 10)] || '';
      else if (t === 'inlineStr') x = tTekst(binnen);
      else if (v !== undefined) x = xmlTekst(v);
      r[ref] = x.replace(/\s+/g, ' ').trim();
    }
    rijen.push(r);
  }
  return rijen;
}

// ───────────────────────────── de lijst ─────────────────────────────
function serieelDatum(n) {
  const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
  return d.toISOString().slice(0, 10);
}
function centen(s) {
  if (s === undefined || s === null || s === '') return 0;
  const x = Number(String(s).replace(',', '.'));
  if (!Number.isFinite(x)) throw new Error('bedrag onleesbaar');
  return Math.round(x * 100);
}
function ibanKort(s) { return String(s || '').replace(/\s+/g, '').toUpperCase(); }
/*
 * leesLijst(buf) → { ok: true, administratie, datum_lijst, regels: [{ nr, iban, datum, bedrag_centen, tegen_iban, omschrijving, grootboek, relatie }] }
 * of { ok: false, reden }. Herkent alleen de Exact-kop "Datum | Bankrekening" onder "Afschriftregel"; anders geen lijst (geen gok).
 */
function leesLijst(buf) {
  if (!Buffer.isBuffer(buf) || buf.length > GRENS.bestandBytes) return { ok: false, reden: 'te_groot' };
  let rijen;
  try { rijen = xlsxRijen(buf); } catch (e) { return { ok: false, reden: 'onleesbaar' }; }
  const administratie = ((rijen[0] && rijen[0].A) || '').replace(/^Administratie:\s*/i, '');
  const datum_lijst = ((rijen[1] && rijen[1].A) || '').replace(/^Datum:\s*/i, '');
  let kop = false, iban = null; const regels = [];
  try {
    for (const r of rijen) {
      if (r.A === 'Datum' && r.B === 'Bankrekening') { kop = true; continue; }
      if (!kop) continue;
      const a = r.A || '';
      const rek = /^(NL\d{2}\s?[A-Z]{4}(?:\s?\d{2,4}){2,5})\b/.exec(a);
      if (rek && !r.B) { iban = ibanKort(rek[1]); continue; }
      if (/^\d{5}$/.test(a)) {
        const bedrag = centen(r.D) - centen(r.E);
        regels.push({ nr: regels.length + 1, iban, datum: serieelDatum(parseInt(a, 10)), bedrag_centen: bedrag, tegen_iban: ibanKort(r.B) || null,
          omschrijving: (r.F || '').slice(0, 300), grootboek: (r.H || '').slice(0, 80), relatie: (r.I || '').replace(/^\d+\s*-\s*/, '').slice(0, 80) || null });
        if (regels.length > GRENS.regels) return { ok: false, reden: 'te_veel_regels' };
      }
    }
  } catch (e) { return { ok: false, reden: 'onleesbaar' }; }
  if (!kop) return { ok: false, reden: 'geen_exact_kop' };
  return { ok: true, administratie, datum_lijst, regels };
}
// Bijlagen van één bericht → de lijsten erin (xlsx direct of in winmail.dat), met een sha256 per bestand.
function lijstenUitBijlagen(bijlagen) {
  const uit = [];
  for (const b of bijlagen || []) {
    if (!b || !Buffer.isBuffer(b.bytes)) continue;
    const kandidaten = /\.dat$/i.test(b.naam || '') || (b.bytes.length >= 4 && b.bytes.readUInt32LE(0) === 0x223E9F78) ? tnefBijlagen(b.bytes) : [b];
    for (const k of kandidaten) {
      if (!LIJST_NAAM.test(k.naam || '') || !/\.xlsx$/i.test(k.naam || '')) continue;
      const l = leesLijst(k.bytes);
      uit.push(Object.assign({ naam: k.naam, sha256: crypto.createHash('sha256').update(k.bytes).digest('hex') }, l));
    }
  }
  return uit;
}

// ───────────────────────────── partij en bedrag ─────────────────────────────
const STOP = new Set(('bv b.v nv n.v vof inc ltd limited llc gmbh sa s.a sarl s.a.r.l s.à.r.l sca scs plc co corp company europe european ireland '
  + 'payments payment commerce services service nederland netherlands holding group groep international the van de der het en and '
  + 'bea betaalpas ideal wero sepa incasso algemeen doorlopend overboeking kaartnummer pas nr bank huisartsenpraktijk praktijk eur '
  + 'factuur klantnummer betaling cie').split(/\s+/));
function partijTokens(...namen) {
  const uit = new Set();
  for (const n of namen) {
    for (const w of String(n || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/)) {
      if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w) && !/^[a-z]{2}\d{2}[a-z]{4}/.test(w)) uit.add(w);
    }
  }
  return [...uit].slice(0, 6);
}
// Partij uit een bankomschrijving zonder tegenpartijnaam: "BEA, Betaalpas Kruidvat 2941,PAS075 …" → "Kruidvat".
function partijUitOmschrijving(o) {
  const s = String(o || '');
  const bea = /Betaalpas\s*([^,]+?)(?:\s+\d+)?\s*(?:,|NR:)/i.exec(s);
  if (bea) return bea[1].replace(/^BNG\*/i, '').trim();
  return null;
}
function euroTekst(c) {
  const a = Math.abs(c), e = Math.floor(a / 100), ct = String(a % 100).padStart(2, '0');
  const nlDuizend = String(e).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const enDuizend = String(e).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const v = new Set([`${nlDuizend},${ct}`, `${e},${ct}`, `${e}.${ct}`, `${enDuizend}.${ct}`]);
  if (ct === '00') { v.add(`${nlDuizend},-`); v.add(`${e},-`); }
  return [...v];
}
// Staat het bedrag op de cent in de tekst? Niet als deel van een groter getal (1.144,00 telt niet voor 144,00).
function bedragInTekst(tekst, c) {
  const t = String(tekst || '').replace(/ /g, ' ');
  return euroTekst(c).some(function (v) {
    const re = new RegExp('(^|[^0-9.,])' + v.replace(/[.,\-]/g, function (x) { return '\\' + x; }) + '(?![0-9])');
    return re.test(t);
  });
}

// ───────────────────────────── koppelen aan de bank ─────────────────────────────
function plusDagen(ymd, n) { const d = new Date(Date.parse(ymd + 'T12:00:00Z') + n * 86400000); return d.toISOString().slice(0, 10); }
function dagenTussen(a, b) { return Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 86400000); }
/*
 * koppelBank(lijst, q) → regels met { entiteit, bank: {id, boekdatum, tegenpartij} | null, bank_status, partij, tokens, al_factuur }.
 * q = { rekening(iban) → {entiteit} | null, transacties(entiteit, iban, centen, van, tot) → [{id, boekdatum, tegenpartij_naam, omschrijving}],
 *       achter(transactieId) → { partij, factuur } | null  (PayPal-/kaartregel erachter), factuur(transactieId) → factuur-id | null }
 */
function koppelBank(lijst, q) {
  return lijst.regels.map(function (r) {
    const rek = r.iban ? q.rekening(r.iban) : null;
    const uit = Object.assign({}, r, { entiteit: rek ? rek.entiteit : null, bank: null, bank_status: 'geen_rekening', partij: null, tokens: [], al_factuur: null });
    if (!rek) return uit;
    const tx = q.transacties(rek.entiteit, r.iban, r.bedrag_centen, plusDagen(r.datum, -GRENS.bankMarge), plusDagen(r.datum, GRENS.bankMarge));
    if (tx.length !== 1) { uit.bank_status = tx.length ? 'meerdere' : 'geen'; }
    else {
      const t = tx[0];
      uit.bank = { id: t.id, boekdatum: t.boekdatum, tegenpartij: t.tegenpartij_naam || null };
      uit.bank_status = 'gekoppeld';
      const a = q.achter(t.id);
      uit.al_factuur = q.factuur(t.id) || (a && a.factuur) || null;
      uit.partij = (a && a.partij) || t.tegenpartij_naam || null;
      // betaaldienst (PayPal/kaart) met bekende partij erachter: alleen die naam telt, en zijn datum is het anker. Anders zou "paypal"
      // elke PayPal-kwitantie met hetzelfde bedrag laten tellen (droogproef 23-11: Sony € 7,99 naast Google € 7,99).
      if (a && a.partij) { uit.achter = { partij: a.partij, datum: a.datum || null }; uit.anker = a.datum || null; }
    }
    uit.partij = uit.partij || r.relatie || partijUitOmschrijving(r.omschrijving);
    uit.tokens = uit.achter ? partijTokens(uit.achter.partij)
      : partijTokens(uit.partij, r.relatie, partijUitOmschrijving(r.omschrijving), uit.bank && uit.bank.tegenpartij);
    return uit;
  });
}

// ───────────────────────────── zoeken in de mail ─────────────────────────────
function gmailDatum(ymd) { return ymd.replace(/-/g, '/'); }
function ankerDatum(regel) { return regel.anker || (regel.bank && regel.bank.boekdatum) || regel.datum; }
function zoekvraag(regel) {
  const d = ankerDatum(regel);
  const v = euroTekst(regel.bedrag_centen).filter(function (x) { return !/-$/.test(x); }).map(function (x) { return '"' + x + '"'; });
  return '(' + v.join(' OR ') + ') after:' + gmailDatum(plusDagen(d, -GRENS.vensterVoor)) + ' before:' + gmailDatum(plusDagen(d, GRENS.vensterNa));
}
/*
 * beoordeel(regel, mails, o) → { status: 'gevonden'|'kandidaten'|'niet_gevonden', zekerheid, treffers: [...] }.
 * mails = [{ id, account, dag, van, onderwerp, tekst, bijlagen: [naam] }]. Treffer = bedrag op de cent in tekst/onderwerp én een partijtoken
 * in afzender, onderwerp of tekst. o.afzenders: adressen van de boekhouder (die mails tellen nooit).
 */
function beoordeel(regel, mails, o) {
  const afz = (o && o.afzenders || []).map(function (a) { return String(a).toLowerCase(); });
  const d = ankerDatum(regel);
  const treffers = [];
  for (const m of mails || []) {
    const van = String(m.van || '').toLowerCase();
    if (afz.some(function (a) { return a && van.includes(a); })) continue;
    if ((m.bijlagen || []).some(function (b) { return LIJST_NAAM.test(b); })) continue;
    const tekst = (m.onderwerp || '') + '\n' + (m.tekst || '');
    if (!bedragInTekst(tekst, regel.bedrag_centen)) continue;
    const hooi = (van + ' ' + tekst).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
    const tok = regel.tokens.filter(function (t) { return new RegExp('(^|[^a-z0-9])' + t + '([^a-z0-9]|$)').test(hooi); });
    if (!tok.length) continue;
    const afstand = m.dag ? Math.abs(dagenTussen(m.dag, d)) : 99;
    treffers.push({ id: m.id, account: m.account, dag: m.dag || null, van: String(m.van || '').slice(0, 120), onderwerp: String(m.onderwerp || '').slice(0, 160),
      bijlagen: (m.bijlagen || []).slice(0, 10), pdf: (m.bijlagen || []).some(function (b) { return /\.(pdf|xml)$/i.test(b); }), afstand, tokens: tok });
  }
  // één bericht per draad telt: een doorgestuurde kopie van dezelfde bon is geen tweede kandidaat
  const uniek = []; const gezien = new Set();
  treffers.sort(function (a, b) { return (b.pdf - a.pdf) || (a.afstand - b.afstand); });
  for (const t of treffers) { const k = (t.onderwerp || '').replace(/^((fwd?|fw|doorst|re):\s*)+/i, '').toLowerCase() + '|' + (t.dag || ''); if (!gezien.has(k)) { gezien.add(k); uniek.push(t); } }
  if (!uniek.length) return { status: 'niet_gevonden', zekerheid: null, treffers: [] };
  if (uniek.length === 1) return { status: 'gevonden', zekerheid: uniek[0].afstand <= GRENS.hoogBinnen ? 'hoog' : 'middel', treffers: uniek };
  // Eén aankoop geeft vaak twee mails op één dag (kwitantie van de betaaldienst + orderbevestiging). Liggen alle treffers binnen een dag
  // van het anker op dezelfde dag, en is er geen andere treffer binnen GRENS.hoogBinnen, dan is dat één aankoop: gevonden, de rest erbij.
  const dichtbij = uniek.filter(function (t) { return t.afstand <= 1; });
  const dagen = new Set(dichtbij.map(function (t) { return t.dag; }));
  const andereDichtbij = uniek.filter(function (t) { return t.afstand > 1 && t.afstand <= GRENS.hoogBinnen; });
  if (dichtbij.length && dagen.size === 1 && !andereDichtbij.length) {
    return { status: 'gevonden', zekerheid: 'hoog', treffers: dichtbij, ook: uniek.filter(function (t) { return t.afstand > 1; }).slice(0, 3) };
  }
  return { status: 'kandidaten', zekerheid: 'middel', treffers: uniek.slice(0, 5) };
}
// Waarom niet te vinden, in gewone taal (voor het blok in de app).
function redenNiet(regel) {
  const o = String(regel.omschrijving || '');
  if (/Betaalpas|BEA,/i.test(o)) return 'pinbetaling: bonnetje van wie betaalde';
  if (/SEPA Incasso/i.test(o)) return 'incasso: factuur meestal in het portaal van de leverancier';
  if (/iDEAL/i.test(o)) return 'online betaald: bevestiging niet in de mail gevonden';
  return 'niet in de mail gevonden';
}
/*
 * zoekRegel(regel, io, o) → beoordeel-uitkomst. io.luik(body) = lees-luik (mail_zoeken / mail_lezen). Accounts uit o.accounts (standaard
 * prive en dm). Leest per regel hooguit GRENS.kandidatenPerRegel mails na. Een zoekfout is nooit "niet gevonden": dan status 'fout'.
 */
async function zoekRegel(regel, io, o) {
  const accounts = (o && o.accounts) || ['', 'dm'];
  const mails = []; let gelezen = 0, volledig = true;
  for (const account of accounts) {
    let z;
    try { z = await io.luik({ actie: 'mail_zoeken', query: zoekvraag(regel), account, max: 25 }); }
    catch (e) { return { status: 'fout', fout: 'zoeken', treffers: [] }; }
    if (!z || !Array.isArray(z.mails) || (z.melding && /fout/i.test(z.melding))) return { status: 'fout', fout: 'zoeken', treffers: [] };
    if (z.mails.length >= 25) volledig = false;          // het luik kapt af op 25: er kan meer zijn
    for (const m of z.mails) {
      if (gelezen >= GRENS.kandidatenPerRegel * accounts.length) { volledig = false; break; }
      const afz = String(m.van || '').toLowerCase();
      if (((o && o.afzenders) || []).some(function (a) { return afz.includes(String(a).toLowerCase()); })) continue;
      gelezen++;
      let l = null, b = null;
      try { l = await io.luik({ actie: 'mail_lezen', id: m.id, account }); } catch (e) { l = null; }
      if (!l || l.fout) { volledig = false; continue; }
      try { b = await io.luik({ actie: 'mail_bijlage', id: m.id, account }); } catch (e) { b = null; }
      mails.push({ id: m.id, account: account || 'prive', dag: m.dag_lokaal || String(l.datum_lokaal || '').slice(0, 10) || null, van: m.van || l.van,
        onderwerp: m.onderwerp || l.onderwerp, tekst: l.tekst || '', bijlagen: ((b && b.bijlagen) || []).map(function (x) { return x.naam; }) });
    }
  }
  const u = beoordeel(regel, mails, o);
  // review ZOU 1: niet alles nagelezen → één treffer bewijst geen uniciteit; David kiest
  if (!volledig && u.status === 'gevonden') { u.status = 'kandidaten'; u.zekerheid = 'middel'; }
  u.volledig = volledig;
  return u;
}

module.exports = { GRENS, tnefBijlagen, xlsxRijen, leesLijst, lijstenUitBijlagen, partijTokens, partijUitOmschrijving, euroTekst, bedragInTekst,
  koppelBank, zoekvraag, beoordeel, redenNiet, zoekRegel, _intern: { zipItems, serieelDatum, plusDagen } };
