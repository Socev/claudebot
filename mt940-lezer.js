'use strict';
/*
 * mt940-lezer.js — ABN-AMRO-MT940 lezen volgens het contract bankexports (wv787, 22-10-2026). Spec: mk-scripts/facturen/overdracht-2210/
 * contracten/bank-formaten.md § "ABN AMRO — MT940"; ontleding van :86: = parseAbnDesc uit referentie/fv2-bankparser.js (letterlijk
 * overgenomen, zelfde typenlijst). Bouwplan: vault 01_Ontwikkeling/POT-afschriften - bouwplan (App, 22-10-2026).md § 3.2.
 *
 * WAAROM LOS. De afschriftmaker (pot-afschrift.js) toetst elk gemaakt afschrift hiermee (round-trip, besluit F0 punt 5), en de
 * Facturen-app (F1b) neemt dezelfde lezer over voor ABN-MT940-uploads, zodat er niet twee ABN-MT940-lezers ontstaan (Fable wv787 #12).
 * PUUR: geen bestand, geen netwerk, geen proces (CI-poort zoals bank-archief.js). Invoer is tekst, uitvoer een object.
 *
 * Wat hij doet: blokken :20: … '-' ; :25: IBAN of 10 cijfers (IBAN afgeleid, mod-97); :28: en :28C:; :60F:/:60M: begin; per mutatie
 * :61: (JJMMDD valutadatum, optioneel MMDD boekdatum met jaarwissel, C/D/RC/RD, bedrag met komma, transactiecode N…/F…/S…,
 * referentie) gevolgd door :86: (vervolgregels ZONDER tussenteken aaneen, daarna normaliseert parseAbnDesc de witruimte);
 * :62F:/:62M: eind. Teken: C en RD = bij (positief), D en RC = af (negatief).
 */

const ABN_TYPES = [
  'SEPA Incasso algemeen doorlopend', 'SEPA Incasso bedrijven eenmalig',
  'SEPA Incasso', 'SEPA Overboeking', 'SEPA Periodieke overb.',
  'SEPA Batch Salaris', 'SEPA iDEAL', 'SEPA Acceptgirobetaling',
  'BEA, Betaalpas', 'BEA, Apple Pay', 'GEA, Betaalpas', 'ABN AMRO Bank N.V.',
];

// Letterlijk uit referentie/fv2-bankparser.js (contract: "dezelfde ontleding als parseAbnDesc in de referentie").
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

function ibanFromAbnAccount(acct) {
  const bban = 'ABNA' + String(acct).padStart(10, '0');
  const s = bban + 'NL00';
  let num = '';
  for (const c of s) num += /[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c;
  const check = 98n - (BigInt(num) % 97n);
  return 'NL' + String(check).padStart(2, '0') + bban;
}

class Mt940Fout extends Error {}
function datum6(s) { return '20' + s.slice(0, 2) + '-' + s.slice(2, 4) + '-' + s.slice(4, 6); }
// bedrag "1234,56" → centen (geheel getal); zo rekent de toets zonder zwevendekommafouten
function centen(s) {
  const m = /^(\d{1,12}),(\d{0,2})$/.exec(String(s));
  if (!m) throw new Mt940Fout('ongeldig bedrag');
  return Number(m[1]) * 100 + Number((m[2] + '00').slice(0, 2));
}
function saldo(tag, v) {
  const m = /^([CD])(\d{6})([A-Z]{3})(\d{1,12},\d{0,2})$/.exec(v.trim());
  if (!m) throw new Mt940Fout(tag + ': ongeldig saldo');
  return { centen: (m[1] === 'D' ? -1 : 1) * centen(m[4]), datum: datum6(m[2]), valuta: m[3], soort: tag.slice(-1) };
}
function boekdatum(valuta, mmdd) {
  if (!mmdd) return valuta;
  let j = Number(valuta.slice(0, 4));
  const vm = Number(valuta.slice(5, 7)), bm = Number(mmdd.slice(0, 2));
  if (vm === 12 && bm === 1) j++; else if (vm === 1 && bm === 12) j--;
  return j + '-' + mmdd.slice(0, 2) + '-' + mmdd.slice(2, 4);
}
const R61 = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d{1,12},\d{0,2})([NFS][A-Z0-9]{3})(.*)$/;
function regel61(v) {
  const m = R61.exec(v);
  if (!m) throw new Mt940Fout(':61: ongeldig');
  const teken = m[3] === 'C' || m[3] === 'RD' ? 1 : -1;
  const vd = datum6(m[1]);
  return { valutadatum: vd, boekdatum: boekdatum(vd, m[2]), centen: teken * centen(m[5]), storno: m[3][0] === 'R', code: m[6], referentie: m[7].split('//')[0].trim() || null };
}

// Tekst → { afschriften: [{ referentie, rekening, volgnummer, begin, eind, posten: [...], sluit }] }. Fout = Mt940Fout met reden
// (zonder inhoud uit het bestand: alleen het veld en het regelnummer).
function leesMt940(tekst) {
  const regels = String(tekst).replace(/^\uFEFF/, '').split(/\r?\n/);
  const afschriften = [];
  let blok = null, tag = null, post = null;
  const sluitTag = function () {
    if (!blok || !tag) return;
    const v = tag.waarde;
    if (tag.naam === '20') blok.referentie = v.trim();
    else if (tag.naam === '25') {
      const r = v.replace(/\s+/g, '').toUpperCase();
      blok.rekening = /^\d{9,10}$/.test(r) ? ibanFromAbnAccount(r) : r;
    } else if (tag.naam === '28' || tag.naam === '28C') blok.volgnummer = v.trim();
    else if (tag.naam === '60F' || tag.naam === '60M') blok.begin = saldo(tag.naam, v);
    else if (tag.naam === '62F' || tag.naam === '62M') blok.eind = saldo(tag.naam, v);
    else if (tag.naam === '64') blok.beschikbaar = saldo('64', v);
    // :61: met trimEnd(): /\s+$/ is kwadratisch op een lange reeks spaties in een upload (diffreview wv798 #10)
    else if (tag.naam === '61') { post = regel61(v.trimEnd()); post.omschrijving86 = null; blok.posten.push(post); }
    else if (tag.naam === '86') {
      if (post && post.omschrijving86 === null) {
        post.omschrijving86 = v;
        const o = parseAbnDesc(v);
        post.ontleed = { transactietype: o[0], tegen_iban: o[1], naam: o[2], omschrijving: o[3], kenmerk: o[4], is_incasso: o[5] };
      } else blok.info86 = (blok.info86 || '') + v;   // :86: op afschriftniveau (na :62F:)
    }
    tag = null;
  };
  regels.forEach(function (r, i) {
    const t = /^:(\d{2}[A-Z]?):(.*)$/.exec(r);
    if (t) {
      sluitTag();
      if (t[1] === '20') { blok = { referentie: null, rekening: null, volgnummer: null, begin: null, eind: null, posten: [] }; afschriften.push(blok); post = null; }
      if (!blok) throw new Mt940Fout('regel ' + (i + 1) + ': veld vóór :20:');
      tag = { naam: t[1], waarde: t[2] };
    } else if (/^-\s*$/.test(r)) { sluitTag(); blok = null; post = null; }
    else if (tag) tag.waarde += r;   // vervolgregel: zonder tussenteken aaneen (contract)
    // regels buiten een blok (kop ABNANL2A / 940) negeren
  });
  sluitTag();
  afschriften.forEach(function (b, i) {
    if (!b.rekening || !b.begin || !b.eind) throw new Mt940Fout('afschrift ' + (i + 1) + ': :25:, :60F: of :62F: ontbreekt');
    const som = b.posten.reduce(function (s, p) { return s + p.centen; }, 0);
    b.sluit = b.begin.centen + som === b.eind.centen;
  });
  return { afschriften: afschriften };
}

module.exports = { leesMt940, parseAbnDesc, ibanFromAbnAccount, Mt940Fout, ABN_TYPES };
