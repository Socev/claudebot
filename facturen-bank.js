'use strict';
/*
 * facturen-bank.js — de bankkant van de Facturen-app (wv798, fase F1b, 22-10-2026). Bouwplan: vault 01_Ontwikkeling/Facturen-app -
 * bouwplan (App, 22-10-2026).md § 4.2 en § 7; ontwerp v2 (mk-scripts/facturen/overdracht-2210/bouwplan.md) § 4.6 (bankcontrole);
 * contracten/bank-formaten.md (formaten, normalisatie, entry_ref); oracle referentie/fv2-bankparser.js.
 *
 * WAAROM. De bankcontrole sluit de cirkel: wat is betaald zonder factuur, wat is twee keer betaald, welke incasso bleef uit. FV2 bouwde
 * die nooit (0 van 6.963 bankregels gekoppeld). De parsers moeten byte voor byte dezelfde entry_ref geven als FV2, anders stapelt een
 * upload van een periode die al binnen is (toets tegen de referentie in test/facturen-bank.sh).
 *
 * PUUR (zelfde CI-poort als facturen-kern.js): geen bestand-, netwerk- of procesmodule, geen klok. Bestanden komen als tekst of bytes
 * binnen, `vandaag` van de beller. Opslaan doet facturen-db.js (F1c), routes en de bankluis lezen facturen.js (F2).
 *
 * NIET ONDERHANDELBAAR (bouwplan § 1). Niets hier betaalt of mailt: een signaal geeft hooguit een tekst om te kopiëren. Regels van een
 * rekening met controle = 0 (Privé) gaan weg zonder dat er iets van overblijft behalve een aantal. Een onbekende rekening laat het hele
 * bestand weigeren (geen stil dekkingsgat), net als een formaat dat niet bij de rekening hoort. Een nieuw of afwijkend IBAN wordt nooit
 * vanzelf bekend: hooguit een signaal "betaald aan onbekend IBAN"; bekend maken gaat alleen via Nagebeld (kern). Weigerredenen noemen
 * regelnummer, veld en de laatste vier tekens van een rekening, nooit een bedrag, naam of omschrijving uit het bestand.
 */
const crypto = require('crypto');
const { leesMt940, parseAbnDesc, ibanFromAbnAccount, Mt940Fout, ABN_TYPES } = require('./mt940-lezer.js');
const { ibanNorm, normNaam, normNummer, dagenTussen, plusDagen, isIsoDatum } = require('./facturen-kern.js');
const { VERZAMEL_RE } = require('./facturen-validatie.js');

class BankWeigering extends Error {
  constructor(code, uitleg) { super(uitleg || code); this.code = code; this.uitleg = uitleg || code; }
}
const MAX_BESTAND = 20 * 1024 * 1024;
const FORMATEN = ['ing_csv', 'abn_tab', 'abn_mt940', 'triodos_csv', 'bankluis'];
// wv1329: invoerformaten die geen eigen bank_formaat zijn. Het ABN-historiebestand is een overzetting van ABN-afschriften; de regels
// worden opgeslagen onder het formaat van de rekening, zonder schemawijziging. Alleen abn_tab: die neemt net als de historie de
// rentedatum als boekdatum (de MT940-lezer de boekdatum; review wv1329 #4), anders zou het afdekken op de dag niet kloppen.
const HISTORIE_FORMATEN = { abn_historie_csv: ['abn_tab'] };
const OMS_HASH = 500, OMS_OPSLAG = 200, TYPE_OPSLAG = 60;
// controle: 1 = zakelijk (inlezen), 0 = Privé (weggooien). Alles anders (NULL, leeg, onzin) is een onvolledige rekening: weigeren, nooit
// stil als Privé behandelen (diffreview wv798 #5).
function controleVan(rk) {
  const c = rk ? rk.controle : undefined;
  if (c === 1 || c === '1' || c === true) return 1;
  if (c === 0 || c === '0' || c === false) return 0;
  return null;
}
function eind4(iban) { const s = String(iban || ''); return '…' + s.slice(-4); }

// ───────────────────────────── entry_ref (exact zoals FV2) ─────────────────────────────

// Python-weergave van een waarde (referentie: pyStr). Bedragen zijn euro als getal: 100 → "100.0", -12.5 → "-12.5".
function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'number') {
    if (Object.is(v, -0)) return '-0.0';
    if (Number.isInteger(v)) return v.toFixed(1);
    return String(v);
  }
  return String(v);
}
function mkRef(delen) { return crypto.createHash('sha1').update(delen.map(pyStr).join('|'), 'utf8').digest('hex').slice(0, 20); }
// Rijen met { eigen_iban_ruw, boekdatum, bedrag, saldo_na, oms_hash, tegenpartij_iban } → entry_ref; duplicaten binnen één bestand -1, -2, …
function kenEntryRefsToe(rijen) {
  const gezien = new Map();
  for (const r of rijen) {
    const basis = mkRef([r.eigen_iban_ruw, r.boekdatum, r.bedrag, r.saldo_na, r.oms_hash, r.tegenpartij_iban]);
    const n = gezien.get(basis) || 0;
    gezien.set(basis, n + 1);
    r.entry_ref = basis + (n ? '-' + n : '');
  }
  return rijen;
}

// NL-notatie "1.234,56" / "-12,50" → euro als getal (referentie normAmount). Ongeldig → null.
function normBedrag(s) {
  const t = String(s == null ? '' : s);
  if (!/^\s*[+-]?[\d.]*\d(,\d*)?\s*$/.test(t)) return null;
  const v = Number(t.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}
function centenVan(euro) { const c = Math.round(euro * 100); return Object.is(c, -0) ? 0 : c; }

// ───────────────────────────── tekst uit bytes, formaatherkenning ─────────────────────────────

function alsTekst(invoer) {
  if (typeof invoer === 'string') return invoer;
  if (invoer instanceof Uint8Array) {
    if (invoer.length > MAX_BESTAND) throw new BankWeigering('te_groot', 'het bestand is groter dan 20 MB');
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(invoer);   // zoals FV2: UTF-8 met vervangteken
  }
  throw new BankWeigering('geen_bestand', 'geen bestandsinhoud');
}

// → 'ing_csv' | 'abn_tab' | 'abn_mt940' | 'triodos_csv' | 'abn_historie_csv' | 'camt053' | null. Alleen de vorm, nooit de rekening.
function herkenFormaat(invoer) {
  const t = alsTekst(invoer).replace(/^﻿/, '');
  const eerste = t.split('\n', 1)[0];
  if (eerste.replace(/\r$/, '') === ABN_HISTORIE_KOP.join(';')) return 'abn_historie_csv';
  if (eerste.indexOf('"Datum";') !== -1 || eerste.indexOf('"Datum",') !== -1) return 'ing_csv';
  if (/^\s*<\?xml|<BkToCstmrStmt\b/.test(t.slice(0, 2000))) return 'camt053';
  if (/^:20:/m.test(t) && /^:25:/m.test(t) && /^:6[02][FM]:/m.test(t)) return 'abn_mt940';
  if (TRIODOS_REGEL.test(t.split('\n').find((r) => r.trim()) || '')) return 'triodos_csv';
  const regel = t.split('\n').find((r) => r.trim());
  if (regel) {
    const p = regel.split('\t');
    if (p.length >= 8 && /^\d{9,10}$/.test(p[0].trim()) && /^\d{8}$/.test(p[2]) && /^\d{8}$/.test(p[5])) return 'abn_tab';
  }
  return null;
}

// ───────────────────────────── ING-CSV (puntkomma en oude komma-variant) ─────────────────────────────

// CSV zoals de Python csv-module (referentie parseCsvRows), met het scheidingsteken als parameter.
function csvRijen(tekst, scheiding) {
  const rijen = [];
  let veld = '', rij = [], inQuotes = false, i = 0;
  const zetVeld = function () { rij.push(veld); veld = ''; };
  const zetRij = function () { zetVeld(); rijen.push(rij); rij = []; };
  while (i < tekst.length) {
    const ch = tekst[i];
    if (inQuotes) {
      if (ch === '"') {
        if (tekst[i + 1] === '"') { veld += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      veld += ch; i++; continue;
    }
    if (ch === '"' && veld === '') { inQuotes = true; i++; continue; }
    if (ch === scheiding) { zetVeld(); i++; continue; }
    if (ch === '\r') { if (tekst[i + 1] === '\n') i++; zetRij(); i++; continue; }
    if (ch === '\n') { zetRij(); i++; continue; }
    veld += ch; i++;
  }
  if (veld !== '' || rij.length > 0) zetRij();
  return rijen;
}

const ING_NODIG = ['datum', 'naam / omschrijving', 'rekening', 'tegenrekening', 'code', 'af bij', 'bedrag (eur)', 'mutatiesoort', 'mededelingen'];
function leesIng(tekst) {
  if (tekst.charCodeAt(0) === 0xfeff) tekst = tekst.slice(1);
  const eerste = tekst.split('\n', 1)[0];
  const scheiding = eerste.indexOf('"Datum";') !== -1 ? ';' : ',';
  const ruw = csvRijen(tekst, scheiding).filter((r) => r.length > 0 && !(r.length === 1 && r[0] === ''));
  if (!ruw.length) return [];
  // kop hoofdletterongevoelig (de oude export schrijft "MutatieSoort"); eerste voorkomen wint, zoals in de referentie het laatste
  // zou winnen bij een dubbele kolomnaam — die bestaat in geen ING-export, dus een dubbele kop weigeren we.
  const kop = ruw[0].map((k) => String(k).trim().toLowerCase());
  if (new Set(kop).size !== kop.length) throw new BankWeigering('kop_ongeldig', 'ING-CSV: dubbele kolomnaam in de kop');
  const ontbreekt = ING_NODIG.filter((k) => !kop.includes(k));
  if (ontbreekt.length) throw new BankWeigering('kop_ongeldig', 'ING-CSV: kolom ontbreekt (' + ontbreekt.join(', ') + ')');
  const kol = (k) => kop.indexOf(k);
  const iSaldo = kol('saldo na mutatie');
  const uit = [];
  for (let ri = 1; ri < ruw.length; ri++) {
    const v = ruw[ri];
    const veld = (k) => { const i = kol(k); return i >= 0 && i < v.length ? v[i] : null; };
    const dat = veld('datum');
    if (!dat) continue;   // zoals de referentie: rij zonder datum overslaan
    if (!/^\d{8}$/.test(dat)) throw new BankWeigering('regel_ongeldig', 'ING-CSV regel ' + (ri + 1) + ': datum is geen JJJJMMDD');
    const boekdatum = dat.slice(0, 4) + '-' + dat.slice(4, 6) + '-' + dat.slice(6, 8);
    if (!isIsoDatum(boekdatum)) throw new BankWeigering('regel_ongeldig', 'ING-CSV regel ' + (ri + 1) + ': ongeldige datum');
    let bedrag = normBedrag(veld('bedrag (eur)'));
    if (bedrag === null) throw new BankWeigering('regel_ongeldig', 'ING-CSV regel ' + (ri + 1) + ': ongeldig bedrag');
    const afBij = String(veld('af bij')).trim();
    if (afBij !== 'Af' && afBij !== 'Bij') throw new BankWeigering('regel_ongeldig', 'ING-CSV regel ' + (ri + 1) + ': Af Bij is geen Af of Bij');
    if (afBij === 'Af') bedrag = -bedrag;
    const code = String(veld('code')).trim();
    const med = String(veld('mededelingen')).trim();
    const naam = String(veld('naam / omschrijving')).trim();
    const tegen = String(veld('tegenrekening')).trim() || null;
    const km = med.match(/Kenmerk: (\S+)/), inc = med.match(/Incassant ID: (\S+)/), mach = med.match(/Machtiging ID: (\S+)/);
    const eigenRuw = String(veld('rekening')).trim();
    const saldoRuw = iSaldo >= 0 && iSaldo < v.length ? v[iSaldo] : null;
    uit.push({
      eigen_iban_ruw: eigenRuw, boekdatum, tegenpartij_iban: tegen, tegenpartij_naam: naam || null, bedrag, valuta: 'EUR',
      oms_hash: med.slice(0, OMS_HASH) || null, kenmerk: km ? km[1] : null,
      transactietype: 'ING:' + code + ':' + String(veld('mutatiesoort')).trim(), is_incasso: code === 'IC',
      incassant_id: inc ? inc[1] : null, machtiging: mach ? mach[1] : null,
      saldo_na: String(saldoRuw === null || saldoRuw === undefined ? '' : saldoRuw).trim(), regel: ri + 1,
    });
  }
  return uit;
}

// ───────────────────────────── Triodos-CSV (wv1299) ─────────────────────────────

/*
 * Triodos "Download mutaties" als CSV (gemeten 26-10-2026 op Davids export van vier rekeningen): GEEN kop, komma, elk veld tussen
 * aanhalingstekens, CRLF, UTF-8, negen kolommen: datum (DD-MM-JJJJ), eigen IBAN, bedrag (NL-notatie, altijd positief), Debet|Credit,
 * naam tegenpartij, "BIC IBAN" van de tegenpartij (oude mutaties: een oud rekeningnummer met punten; kosten en rente: leeg), code (ET
 * overboeking, EI incasso, ID iDEAL, KN kosten, RE rente, …; storno met ST erachter), omschrijving, saldo na mutatie. Meerdere rekeningen
 * door elkaar in één bestand, per rekening oudste eerst. Geen FV2-referentie: de entry_ref is dezelfde sha1 over dezelfde velden als bij
 * ING en ABN (eigen IBAN, datum, bedrag, saldo na, omschrijving, tegenpartij), dus deterministisch; een tweede export van dezelfde periode
 * geeft dezelfde sleutels. Bij EI staat het incassant-ID vooraan in de omschrijving; een machtigingskenmerk is niet eenduidig te herkennen
 * (niet geraden: leeg).
 */
const TRIODOS_REGEL = /^"\d{2}-\d{2}-\d{4}","[A-Z]{2}\d{2}TRIO\d{10}","[\d.]*\d,\d{2}","(Debet|Credit)",/;
const TRIODOS_KOLOMMEN = 9;
function leesTriodos(tekst) {
  if (tekst.charCodeAt(0) === 0xfeff) tekst = tekst.slice(1);
  const ruw = csvRijen(tekst, ',').filter((r) => r.length > 0 && !(r.length === 1 && r[0] === ''));
  const uit = [];
  ruw.forEach(function (v, ri) {
    const nr = ri + 1;
    if (v.length !== TRIODOS_KOLOMMEN) throw new BankWeigering('regel_ongeldig', 'Triodos-CSV regel ' + nr + ': ' + v.length + ' kolommen in plaats van ' + TRIODOS_KOLOMMEN);
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(v[0]);
    if (!m) throw new BankWeigering('regel_ongeldig', 'Triodos-CSV regel ' + nr + ': datum is geen DD-MM-JJJJ');
    const boekdatum = m[3] + '-' + m[2] + '-' + m[1];
    if (!isIsoDatum(boekdatum)) throw new BankWeigering('regel_ongeldig', 'Triodos-CSV regel ' + nr + ': ongeldige datum');
    const eigenRuw = v[1].trim();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(eigenRuw)) throw new BankWeigering('regel_ongeldig', 'Triodos-CSV regel ' + nr + ': eigen rekening is geen IBAN');
    let bedrag = normBedrag(v[2]);
    if (bedrag === null || bedrag < 0 || /^\s*[+-]/.test(v[2])) throw new BankWeigering('regel_ongeldig', 'Triodos-CSV regel ' + nr + ': ongeldig bedrag');
    if (v[3] === 'Debet') bedrag = bedrag === 0 ? 0 : -bedrag;
    else if (v[3] !== 'Credit') throw new BankWeigering('regel_ongeldig', 'Triodos-CSV regel ' + nr + ': Debet/Credit ontbreekt');
    if (normBedrag(v[8]) === null) throw new BankWeigering('regel_ongeldig', 'Triodos-CSV regel ' + nr + ': ongeldig saldo');
    // tegenpartij: "BIC IBAN" of alleen een IBAN → het IBAN; een oud rekeningnummer (cijfers en punten) blijft zoals het staat; leeg → null
    const tp = v[5].trim();
    const bi = /^(?:[A-Z0-9]{8}(?:[A-Z0-9]{3})? )?([A-Z]{2}\d{2}[A-Z0-9]{11,30})$/.exec(tp);
    let tegen = null;
    if (bi) tegen = bi[1];
    else if (/^\d[\d.]*\d$/.test(tp)) tegen = tp;
    else if (tp) throw new BankWeigering('regel_ongeldig', 'Triodos-CSV regel ' + nr + ': tegenrekening niet herkend');
    const code = v[6].trim();
    if (!/^[A-Z]{1,6}$/.test(code)) throw new BankWeigering('regel_ongeldig', 'Triodos-CSV regel ' + nr + ': code ontbreekt');
    const oms = v[7].trim();
    const inc = code === 'EI' ? /^([A-Z]{2}\d{2}[A-Z0-9]{3}[A-Z0-9]{1,28})(?:\s|$)/.exec(oms) : null;
    uit.push({
      eigen_iban_ruw: eigenRuw, boekdatum, tegenpartij_iban: tegen, tegenpartij_naam: v[4].trim() || null, bedrag, valuta: 'EUR',
      oms_hash: oms.slice(0, OMS_HASH) || null, kenmerk: null, transactietype: 'TRIODOS:' + code, is_incasso: code === 'EI',
      incassant_id: inc ? inc[1] : null, machtiging: null, saldo_na: v[8].trim(), regel: nr,
    });
  });
  return uit;
}

// ───────────────────────────── ABN-historie-CSV (wv1329) ─────────────────────────────

/*
 * De volledige ABN-historie vanaf rekeningstart (David 26-10-2026, via Claude Desktop uit de PDF-afschriften overgezet; per rekening een
 * CSV en een controleverslag). Gemeten op de zes bestanden: vaste kop van 21 kolommen, puntkomma, UTF-8 met BOM, één rekening per bestand,
 * oudste eerst, Bedrag met minteken bij Af (geen duizendtallen), Saldo na mutatie op elke regel (keten sluit per regel), Mutatie-ID
 * <IBAN>-<jaar>-<afschrift>-<regel> uniek. Geen bankexport: alleen de machinekamer leest het in (modus historisch).
 * boekdatum = Rentedatum, zoals de TAB-parser en FV2 (gemeten: met Rentedatum vallen alle bestaande regels van Tolgaarde samen, met
 * Boekdatum één niet). entry_ref = sha1 over 'ABN-HISTORIE' en de Mutatie-ID: een tweede overzetting van dezelfde afschriften geeft
 * dezelfde sleutels. Regels die al binnen zijn (TAB, FV2-archief) krijgen hun sleutel niet: facturen.js dekt ze af (historieDekking).
 */
const ABN_HISTORIE_KOP = ['Mutatie-ID', 'Rekening', 'Boekdatum', 'Rentedatum', 'Bedrag', 'Af Bij', 'Type', 'Tegenrekening', 'BIC', 'Naam', 'Omschrijving',
  'Kenmerk', 'Betalingskenmerk', 'Incassant', 'Machtiging', 'Volledige omschrijving', 'Saldo na mutatie', 'Afschrift datum', 'Afschrift volgnr', 'Pagina', 'Bronbestand'];
const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
// → [{ mutatie_id, rekening, boekdatum, rentedatum, bedrag (euro), type, tegen_iban, naam, omschrijving, kenmerk, betalingskenmerk, incassant,
//      machtiging, volledig, saldo_na (tekst), regel }]; weigert het hele bestand bij één afwijking (regelnummer en veld, nooit een waarde)
function leesAbnHistorie(tekst) {
  tekst = alsTekst(tekst);
  if (tekst.charCodeAt(0) === 0xfeff) tekst = tekst.slice(1);
  const ruw = csvRijen(tekst, ';').filter((r) => r.length > 0 && !(r.length === 1 && r[0] === ''));
  if (!ruw.length || ruw[0].join(';') !== ABN_HISTORIE_KOP.join(';')) throw new BankWeigering('kop_ongeldig', 'ABN-historie: kop wijkt af van de 21 vaste kolommen');
  const uit = [], ids = new Set();
  let rekening = null;
  for (let ri = 1; ri < ruw.length; ri++) {
    const v = ruw[ri], nr = ri + 1;
    const fout = (wat) => { throw new BankWeigering('regel_ongeldig', 'ABN-historie regel ' + nr + ': ' + wat); };
    if (v.length !== ABN_HISTORIE_KOP.length) fout(v.length + ' kolommen in plaats van ' + ABN_HISTORIE_KOP.length);
    const k = (naam) => String(v[ABN_HISTORIE_KOP.indexOf(naam)]).trim();
    const rek = k('Rekening');
    if (!IBAN_RE.test(rek)) fout('rekening is geen IBAN');
    if (rekening === null) rekening = rek; else if (rek !== rekening) fout('meer dan één rekening in het bestand');
    const id = k('Mutatie-ID');
    if (!/^[A-Z0-9]+-\d{4}-\d{3}-\d{3}$/.test(id) || !id.startsWith(rek + '-')) fout('Mutatie-ID ongeldig');
    if (ids.has(id)) fout('Mutatie-ID dubbel');
    ids.add(id);
    const bd = k('Boekdatum'), rd = k('Rentedatum');
    if (!isIsoDatum(bd) || !isIsoDatum(rd)) fout('datum is geen JJJJ-MM-DD');
    const bTekst = k('Bedrag');
    if (!/^-?\d+,\d{2}$/.test(bTekst)) fout('ongeldig bedrag');
    const bedrag = normBedrag(bTekst);
    const afBij = k('Af Bij');
    if (afBij !== 'Af' && afBij !== 'Bij') fout('Af Bij is geen Af of Bij');
    if ((afBij === 'Af') !== bedrag < 0) fout('teken van het bedrag past niet bij Af Bij');
    const saldo = k('Saldo na mutatie');
    if (!/^-?\d+,\d{2}$/.test(saldo)) fout('ongeldig saldo');
    const tegen = k('Tegenrekening');
    if (tegen && !IBAN_RE.test(tegen)) fout('tegenrekening is geen IBAN');
    uit.push({
      mutatie_id: id, rekening: rek, boekdatum: bd, rentedatum: rd, bedrag: bedrag === 0 ? 0 : bedrag, type: k('Type'), tegen_iban: tegen || null,
      naam: k('Naam') || null, omschrijving: k('Omschrijving') || null, kenmerk: k('Kenmerk') || null, betalingskenmerk: k('Betalingskenmerk') || null,
      incassant: k('Incassant') || null, machtiging: k('Machtiging') || null, volledig: k('Volledige omschrijving') || null, saldo_na: saldo, regel: nr,
    });
  }
  return uit;
}
// historieregel → ruwe parserrij zoals de andere formaten (normaliseer). Betalingskenmerk boven het end-to-end-kenmerk: daarop matcht de
// factuurcontrole.
function abnHistorieRij(h) {
  return {
    eigen_iban_ruw: h.rekening, boekdatum: h.rentedatum, tegenpartij_iban: h.tegen_iban, tegenpartij_naam: h.naam, bedrag: h.bedrag, valuta: 'EUR',
    oms_hash: (h.omschrijving || '').slice(0, OMS_HASH) || null, kenmerk: h.betalingskenmerk || h.kenmerk, transactietype: 'ABN:' + (h.type || 'None'),
    is_incasso: /incasso/i.test(h.type || ''), incassant_id: h.incassant, machtiging: h.machtiging, saldo_na: h.saldo_na, regel: h.regel,
    entry_ref: mkRef(['ABN-HISTORIE', h.mutatie_id]),
  };
}

// ───────────────────────────── ABN-TAB en ABN-MT940 ─────────────────────────────

// Incassant-id en machtiging uit een ABN-omschrijving (SEPA-gestructureerd of vrije tekst); parseAbnDesc geeft ze niet.
function abnIncasso(desc) {
  const d = String(desc || '').replace(/\s+/g, ' ').trim();
  if (d.startsWith('/TRTP/')) {
    const csid = d.match(/\/CSID\/([^/]+?)\s*(?=\/[A-Z]{4}\/|$)/), marf = d.match(/\/MARF\/([^/]+?)\s*(?=\/[A-Z]{4}\/|$)/);
    return { incassant_id: csid ? csid[1].trim() || null : null, machtiging: marf ? marf[1].trim() || null : null };
  }
  const inc = d.match(/Incassant: (\S+)/), mach = d.match(/Machtiging: (\S+)/);
  return { incassant_id: inc ? inc[1] : null, machtiging: mach ? mach[1] : null };
}
function abnVelden(desc) {
  const o = parseAbnDesc(desc);
  const x = abnIncasso(desc);
  return { ttype: o[0], tegenpartij_iban: o[1], tegenpartij_naam: o[2], oms: o[3], kenmerk: o[4], is_incasso: o[5], incassant_id: x.incassant_id, machtiging: x.machtiging };
}

function leesAbnTab(tekst) {
  const uit = [];
  tekst.split('\n').forEach(function (regel, i) {
    if (!regel.trim()) return;
    const p = regel.split('\t');
    // de referentie slaat zo'n regel stil over; wij weigeren het bestand (storingen zichtbaar, geen stil gat)
    if (p.length < 8) throw new BankWeigering('regel_ongeldig', 'ABN-TAB regel ' + (i + 1) + ': te weinig kolommen');
    const acct = p[0], d2 = p[5];
    if (!/^\d{9,10}$/.test(acct)) throw new BankWeigering('regel_ongeldig', 'ABN-TAB regel ' + (i + 1) + ': rekeningnummer ongeldig');
    if (!/^\d{8}$/.test(d2)) throw new BankWeigering('regel_ongeldig', 'ABN-TAB regel ' + (i + 1) + ': rentedatum is geen JJJJMMDD');
    const boekdatum = d2.slice(0, 4) + '-' + d2.slice(4, 6) + '-' + d2.slice(6, 8);
    if (!isIsoDatum(boekdatum)) throw new BankWeigering('regel_ongeldig', 'ABN-TAB regel ' + (i + 1) + ': ongeldige datum');
    const bedrag = normBedrag(p[6]);
    if (bedrag === null) throw new BankWeigering('regel_ongeldig', 'ABN-TAB regel ' + (i + 1) + ': ongeldig bedrag');
    const v = abnVelden(p.slice(7).join('\t'));
    uit.push({
      eigen_iban_ruw: ibanFromAbnAccount(acct), boekdatum, tegenpartij_iban: v.tegenpartij_iban, tegenpartij_naam: v.tegenpartij_naam,
      bedrag, valuta: (p[1] || '').trim().toUpperCase() || 'EUR', oms_hash: (v.oms || '').slice(0, OMS_HASH) || null, kenmerk: v.kenmerk,
      transactietype: 'ABN:' + (v.ttype === null ? 'None' : v.ttype), is_incasso: v.is_incasso, incassant_id: v.incassant_id,
      machtiging: v.machtiging, saldo_na: p[4], saldo_begin: p[3], regel: i + 1,
    });
  });
  return uit;
}

function leesAbnMt940(tekst) {
  let r;
  try { r = leesMt940(tekst); } catch (e) {
    if (e instanceof Mt940Fout) throw new BankWeigering('mt940_ongeldig', 'MT940: ' + e.message);
    throw e;
  }
  if (!r.afschriften.length) throw new BankWeigering('leeg', 'MT940 zonder afschrift');
  const uit = [];
  r.afschriften.forEach(function (b, bi) {
    // begin + mutaties ≠ eind: afgekapt of beschadigd bestand → niets inlezen (anders een stil gat in de bankcontrole)
    if (!b.sluit) throw new BankWeigering('saldo_sluit_niet', 'MT940 afschrift ' + (bi + 1) + ' (rekening ' + eind4(b.rekening) + '): beginsaldo + mutaties ≠ eindsaldo');
    b.posten.forEach(function (p) {
      if (!isIsoDatum(p.boekdatum)) throw new BankWeigering('mt940_ongeldig', 'MT940 afschrift ' + (bi + 1) + ': ongeldige boekdatum');
      const v = abnVelden(p.omschrijving86 || '');
      uit.push({
        eigen_iban_ruw: b.rekening, boekdatum: p.boekdatum, tegenpartij_iban: v.tegenpartij_iban, tegenpartij_naam: v.tegenpartij_naam,
        bedrag: p.centen === 0 ? 0 : p.centen / 100, valuta: b.begin.valuta || 'EUR', oms_hash: (v.oms || '').slice(0, OMS_HASH) || null,
        kenmerk: v.kenmerk, transactietype: 'ABN:' + (v.ttype === null ? 'None' : v.ttype), is_incasso: v.is_incasso,
        incassant_id: v.incassant_id, machtiging: v.machtiging, saldo_na: '', storno: !!p.storno,
      });
    });
  });
  return uit;
}

// ───────────────────────────── saldocontrole (wv944) ─────────────────────────────

/*
 * Saldocontrole per rekening over de regels van één bestand (entry_ref verandert er niet door). ABN-TAB: per regel begin + bedrag = eind,
 * en de keten tussen opeenvolgende regels; ING-CSV met "Saldo na mutatie" en Triodos-CSV (wv1299): de keten; ING zonder die kolom: niet te controleren; MT940:
 * de parser weigert al een afschrift dat niet sluit. De keten is richtingloos (oudste of nieuwste eerst): de richting met de minste breuken
 * telt, zonder aanname over gelijke datums (Fable wv944 #9). Een breuk weigert het bestand niet (losse perioden kunnen overlappen of gaten
 * hebben), maar staat in de uitkomst. → { [iban]: { gecontroleerd, sluit, breuken, regels, begin_centen?, eind_centen? } }
 */
function saldoControle(rijen, formaat) {
  const per = new Map();
  for (const r of rijen) { const k = ibanNorm(r.eigen_iban_ruw); if (!per.has(k)) per.set(k, []); per.get(k).push(r); }
  const c = (x) => { const v = normBedrag(x); return v === null ? null : centenVan(v); };
  const uit = {};
  for (const [iban, lijst] of per) {
    const n = lijst.length;
    if (formaat === 'abn_mt940') { uit[iban] = { gecontroleerd: true, sluit: true, breuken: 0, regels: n, per_afschrift: true }; continue; }
    if (formaat === 'abn_tab') {
      const b = lijst.map((r) => c(r.saldo_begin)), e = lijst.map((r) => c(r.saldo_na)), m = lijst.map((r) => centenVan(r.bedrag));
      if (b.some((x) => x === null) || e.some((x) => x === null)) { uit[iban] = { gecontroleerd: false, sluit: null, breuken: null, regels: n, reden: 'saldo ontbreekt' }; continue; }
      let regel = 0;
      for (let i = 0; i < n; i++) if (b[i] + m[i] !== e[i]) regel++;
      let vooruit = 0, achteruit = 0;
      for (let i = 0; i + 1 < n; i++) { if (e[i] !== b[i + 1]) vooruit++; if (b[i] !== e[i + 1]) achteruit++; }
      const v = vooruit <= achteruit;
      const breuken = regel + Math.min(vooruit, achteruit);
      uit[iban] = { gecontroleerd: true, sluit: breuken === 0, breuken, regels: n, begin_centen: v ? b[0] : b[n - 1], eind_centen: v ? e[n - 1] : e[0] };
      continue;
    }
    // ING-CSV en Triodos-CSV (saldo na mutatie per regel)
    const s = lijst.map((r) => (r.saldo_na === '' || r.saldo_na == null ? null : c(r.saldo_na))), m = lijst.map((r) => centenVan(r.bedrag));
    if (s.every((x) => x === null)) { uit[iban] = { gecontroleerd: false, sluit: null, breuken: null, regels: n, reden: 'geen kolom Saldo na mutatie' }; continue; }
    if (s.some((x) => x === null)) { uit[iban] = { gecontroleerd: false, sluit: null, breuken: null, regels: n, reden: 'saldo ontbreekt op een regel' }; continue; }
    let oud = 0, nieuw = 0;   // oud = oudste eerst, nieuw = nieuwste eerst (de gewone ING-export)
    for (let i = 0; i + 1 < n; i++) { if (s[i] + m[i + 1] !== s[i + 1]) oud++; if (s[i] - m[i] !== s[i + 1]) nieuw++; }
    const o = oud < nieuw;
    const breuken = Math.min(oud, nieuw);
    uit[iban] = { gecontroleerd: true, sluit: breuken === 0, breuken, regels: n,
      begin_centen: o ? s[0] - m[0] : s[n - 1] - m[n - 1], eind_centen: o ? s[n - 1] : s[0] };
  }
  return uit;
}
function refBasis(ref) { return String(ref || '').replace(/-\d+$/, ''); }

// ───────────────────────────── bestand → genormaliseerde transacties ─────────────────────────────

// Ruwe parserrij → normalisatie uit het contract. omschrijving pas NA de hash ingekort tot 200.
function normaliseer(r, formaat, rekening) {
  const oms = r.oms_hash === null ? null : r.oms_hash.slice(0, OMS_OPSLAG);
  return {
    eigen_iban: ibanNorm(r.eigen_iban_ruw), entiteit: rekening.entiteit, alleen_eigenaar: !!rekening.alleen_eigenaar, boekdatum: r.boekdatum,
    tegenpartij_iban: r.tegenpartij_iban, tegenpartij_naam: r.tegenpartij_naam, bedrag: r.bedrag, bedrag_centen: centenVan(r.bedrag),
    valuta: r.valuta, omschrijving: oms, kenmerk: r.kenmerk, transactietype: r.transactietype === null ? null : r.transactietype.slice(0, TYPE_OPSLAG),
    is_incasso: !!r.is_incasso, incassant_id: r.incassant_id || null, machtiging: r.machtiging || null, entry_ref: r.entry_ref, formaat,
    ref_basis: refBasis(r.entry_ref),
  };
}

/*
 * Een geüpload bankbestand lezen. opties.rekeningen = [{ iban, entiteit, bank_formaat, controle (0|1), alleen_eigenaar }].
 * → { ok:true, formaat, transacties, prive_weggegooid, per_rekening: { iban: aantal } }
 * of { ok:false, fout, uitleg } — dan wordt NIETS opgeslagen (hele bestand geweigerd).
 */
function leesBankbestand(invoer, opties) {
  try { return leesBestand(invoer, opties || {}); }
  catch (e) {
    if (e instanceof BankWeigering) return { ok: false, fout: e.code, uitleg: e.uitleg };
    // een onverwachte fout kan bestandsinhoud in zijn melding dragen (rekeningnummer, bedrag): nooit doorgeven (diffreview wv798 #11)
    return { ok: false, fout: 'onleesbaar', uitleg: 'het bestand is niet te lezen (' + String(e && e.name || 'fout').slice(0, 40) + ')' };
  }
}
function leesBestand(invoer, opties) {
  const tekst = alsTekst(invoer);
  if (tekst.length > MAX_BESTAND) throw new BankWeigering('te_groot', 'het bestand is groter dan 20 MB');
  const formaat = herkenFormaat(tekst);
  if (formaat === 'camt053') throw new BankWeigering('formaat_onbekend', 'CAMT.053 lezen we nog niet; exporteer als MT940, TAB of CSV');
  if (!formaat) throw new BankWeigering('formaat_onbekend', 'geen ING-CSV, ABN-TAB, ABN-MT940 of Triodos-CSV herkend');
  const rijen = formaat === 'ing_csv' ? leesIng(tekst) : formaat === 'abn_tab' ? leesAbnTab(tekst) : formaat === 'triodos_csv' ? leesTriodos(tekst)
    : formaat === 'abn_historie_csv' ? leesAbnHistorie(tekst).map(abnHistorieRij) : leesAbnMt940(tekst);
  if (!rijen.length) throw new BankWeigering('leeg', 'geen transacties in het bestand');
  const rekeningen = new Map((opties.rekeningen || []).map((r) => [ibanNorm(r.iban), r]));
  // eerst het hele bestand toetsen, dan pas iets teruggeven: één onbekende rekening of één verkeerd formaat weigert alles
  const gezien = new Set(rijen.map((r) => ibanNorm(r.eigen_iban_ruw)));
  for (const iban of gezien) {
    if (!rekeningen.get(iban)) throw new BankWeigering('onbekende_rekening', 'het bestand bevat rekening ' + eind4(iban) + ' die de app niet kent; voeg hem eerst toe in Instellingen (eigenaar)');
    if (controleVan(rekeningen.get(iban)) === null) throw new BankWeigering('rekening_onvolledig', 'rekening ' + eind4(iban) + ' heeft geen geldige controle-instelling (1 of 0); zet die eerst in Instellingen');
  }
  for (const iban of gezien) {
    const rk = rekeningen.get(iban);
    if (controleVan(rk) === 0) continue;   // Privé: formaat doet er niet toe, de regels gaan hieronder weg
    if (rk.bank_formaat === 'bankluis') throw new BankWeigering('verkeerd_formaat', 'rekening ' + eind4(iban) + ' komt via de bankkoppeling binnen; een upload zou dubbel tellen');
    const past = HISTORIE_FORMATEN[formaat] ? HISTORIE_FORMATEN[formaat].includes(rk.bank_formaat) : rk.bank_formaat === formaat;
    if (!past) throw new BankWeigering('verkeerd_formaat', 'rekening ' + eind4(iban) + ' leest de app als ' + rk.bank_formaat + ', dit bestand is ' + formaat + '; exporteer in het vaste formaat van die rekening');
  }
  // over het hele bestand, zoals FV2 (Privé zit in de eigen IBAN van de hash, dus geen verschuiving); de ABN-historie heeft al een sleutel
  if (formaat !== 'abn_historie_csv') kenEntryRefsToe(rijen);
  const transacties = [], per = {};
  let prive = 0;
  for (const r of rijen) {
    const iban = ibanNorm(r.eigen_iban_ruw), rk = rekeningen.get(iban);
    if (controleVan(rk) === 0) { prive++; continue; }   // weg zonder opslag: geen veld, geen hash blijft over
    transacties.push(normaliseer(r, HISTORIE_FORMATEN[formaat] ? rk.bank_formaat : formaat, rk));
    per[iban] = (per[iban] || 0) + 1;
  }
  // wv1329 (review #5): een historiebestand van alleen Privé hoort in de bankluis, niet hier (anders bleef het ruwe bestand als bron staan)
  if (HISTORIE_FORMATEN[formaat] && !transacties.length) throw new BankWeigering('prive_historie', 'dit historiebestand is van een rekening die Facturen niet inleest (Privé); die historie hoort in de bankluis (tools/bank-historie.js)');
  // wv944: saldocontrole en periode alleen over de zakelijke rekeningen (Privé laat geen spoor na, ook geen saldo of datum)
  const zakelijk = rijen.filter((r) => controleVan(rekeningen.get(ibanNorm(r.eigen_iban_ruw))) === 1);
  const saldo = saldoControle(zakelijk, formaat);   // abn_historie_csv: de keten over Saldo na mutatie, oudste eerst (zoals ING/Triodos)
  const datums = transacties.map((t) => t.boekdatum).sort();
  const periode = datums.length ? { van: datums[0], tot: datums[datums.length - 1] } : null;
  // wv1329: een historieformaat wordt opgeslagen als het formaat van de rekening (één per bestand: de parser weigert een tweede rekening)
  const opslag_formaat = HISTORIE_FORMATEN[formaat] ? [...new Set([...gezien].map((i) => rekeningen.get(i).bank_formaat))].join(',') : formaat;
  return { ok: true, formaat, opslag_formaat, transacties, prive_weggegooid: prive, per_rekening: per, saldo, periode };
}

// Bankluis-bron (F2 leest transacties.sqlite read-only): één post naar dezelfde normalisatie. Alleen status 'booked' en niet vervangen;
// pending-posten worden later vervangen door een geboekte met een ander kenmerk. rekening = Facturen-rekening { rek, iban, entiteit,
// bank_formaat: 'bankluis', controle, alleen_eigenaar }. → { ok:true, transactie } of { ok:false, fout }.
function normaliseerBankluis(post, rekening) {
  if (!post || !rekening) return { ok: false, fout: 'geen_invoer' };
  if (rekening.bank_formaat !== 'bankluis') return { ok: false, fout: 'geen_bankluis_rekening' };
  if (controleVan(rekening) !== 1) return { ok: false, fout: controleVan(rekening) === 0 ? 'prive' : 'rekening_onvolledig' };
  if (String(post.rek) !== String(rekening.rek)) return { ok: false, fout: 'andere_rekening' };
  if (post.status !== 'booked') return { ok: false, fout: 'niet_geboekt' };
  if (post.vervangen_door !== null && post.vervangen_door !== undefined) return { ok: false, fout: 'vervangen' };
  if (!post.sleutel || !isIsoDatum(post.datum)) return { ok: false, fout: 'onvolledig' };
  const bedrag = Number(post.bedrag);
  if (!Number.isFinite(bedrag)) return { ok: false, fout: 'onvolledig' };
  let j = null;
  try { j = post.ruwe_json ? JSON.parse(post.ruwe_json) : null; } catch (e) { j = null; }
  const regels = j && Array.isArray(j.remittance_information) ? j.remittance_information.map((x) => String(x == null ? '' : x)) : [];
  // ABN via Enable Banking geeft de omschrijving in vaste-breedteregels; aaneen zonder tussenteken zoals MT940 (contract)
  const ruw = regels.length ? regels.join('') : String(post.omschrijving || '');
  const code = j && j.bank_transaction_code ? [j.bank_transaction_code.description, j.bank_transaction_code.code].filter((x) => typeof x === 'string' && x).join(' ') : '';
  const abn = /^\s*\/TRTP\//.test(ruw) || ABN_TYPES.some((t) => ruw.replace(/\s+/g, ' ').trim().startsWith(t));
  const v = abn ? abnVelden(ruw) : null;
  const oms = (v ? v.oms : ruw.replace(/\s+/g, ' ').trim()) || null;
  const km = !v ? oms && oms.match(/(?:Kenmerk|Betalingskenm\.): (\S+)/) : null;
  const type = 'BANKLUIS:' + (v && v.ttype ? v.ttype : code || 'onbekend');
  return {
    ok: true,
    transactie: {
      eigen_iban: ibanNorm(rekening.iban), entiteit: rekening.entiteit, alleen_eigenaar: !!rekening.alleen_eigenaar, boekdatum: post.datum,
      tegenpartij_iban: ibanNorm(post.tegen_iban) || (v && ibanNorm(v.tegenpartij_iban)) || null,
      tegenpartij_naam: post.tegenpartij || (v && v.tegenpartij_naam) || null, bedrag, bedrag_centen: centenVan(bedrag),
      valuta: String(post.valuta || 'EUR').toUpperCase(), omschrijving: oms ? oms.slice(0, OMS_OPSLAG) : null,
      kenmerk: v ? v.kenmerk : (km ? km[1] : null), transactietype: type.slice(0, TYPE_OPSLAG),
      is_incasso: v ? v.is_incasso : /incasso|direct\s?debit/i.test(code), incassant_id: v ? v.incassant_id : null, machtiging: v ? v.machtiging : null,
      entry_ref: 'bankluis:' + rekening.rek + '|' + post.sleutel, formaat: 'bankluis',
    },
  };
}

// ───────────────────────────── uitzonderingen (stromen zonder factuur) ─────────────────────────────

const CATEGORIEEN = ['loon', 'loonheffing', 'btw', 'belasting', 'declaraties', 'rekening_courant', 'eigen_overboeking', 'bankkosten', 'creditcard',
  'prive_opname', 'abonnement_zonder_factuur', 'subsidie', 'rente', 'overig'];
const RICHTINGEN = ['af', 'bij', 'beide'];
function richtingVan(tx) { return tx.bedrag_centen < 0 ? 'af' : tx.bedrag_centen > 0 ? 'bij' : null; }
function eigenIbanMap(ctx) {
  const m = new Map();
  for (const e of (ctx && ctx.entiteiten) || []) for (const i of e.ibans || []) if (ibanNorm(i)) m.set(ibanNorm(i), e.sleutel);
  for (const r of (ctx && ctx.rekeningen) || []) if (ibanNorm(r.iban) && r.entiteit) m.set(ibanNorm(r.iban), r.entiteit);
  return m;
}
// Patroon = gewone tekst (geen regex: niets uit een instelling kan een regex laten hangen). Een IBAN-patroon vergelijkt het IBAN exact,
// anders hoofdletter- en accentongevoelig een deel van de genormaliseerde tegenpartijnaam (of omschrijving, als dat veld gezet is).
function uitzonderingPast(u, tx) {
  if (u.actief === 0 || u.actief === false) return false;
  const r = richtingVan(tx);
  if (!r || (u.richting && u.richting !== 'beide' && u.richting !== r)) return false;
  if (u.rekening && ibanNorm(u.rekening) !== tx.eigen_iban) return false;
  if (u.tegenpartij) {
    const p = String(u.tegenpartij);
    if (/^[A-Z]{2}\d{2}[A-Z0-9 ]{8,}$/i.test(p.trim())) { if (ibanNorm(p) !== ibanNorm(tx.tegenpartij_iban)) return false; }
    else { const n = normNaam(p); if (!n || normNaam(tx.tegenpartij_naam).indexOf(n) < 0) return false; }
  }
  if (u.omschrijving) { const n = normNaam(u.omschrijving); if (!n || normNaam(tx.omschrijving).indexOf(n) < 0) return false; }
  if (!u.tegenpartij && !u.omschrijving && !u.transactietype) return false;   // een uitzondering zonder patroon zou alles slikken
  if (u.transactietype && String(tx.transactietype || '').toLowerCase().indexOf(String(u.transactietype).toLowerCase()) < 0) return false;
  if (u.bedrag_centen !== undefined && u.bedrag_centen !== null) {
    const doel = Math.abs(Number(u.bedrag_centen)), echt = Math.abs(tx.bedrag_centen);
    const tol = Math.max(Number(u.tolerantie_centen) || 0, Math.round(doel * (Number(u.tolerantie_pct) || 0) / 100));
    if (Math.abs(echt - doel) > tol) return false;
  }
  return true;
}
// → { categorie, uitzondering (id) | ingebouwd: 'eigen_iban' | 'salarisbatch' } of null
function uitzonderingVoor(tx, ctx) {
  const eigen = eigenIbanMap(ctx);
  const tegen = ibanNorm(tx.tegenpartij_iban);
  if (tegen && eigen.has(tegen)) {
    const naar = eigen.get(tegen);
    const categorie = naar === tx.entiteit ? 'eigen_overboeking' : naar === 'prive' ? 'prive_opname' : 'rekening_courant';
    return { categorie, ingebouwd: 'eigen_iban', tegen_entiteit: naar };
  }
  if (richtingVan(tx) === 'af' && /\bSalaris\b/i.test(String(tx.transactietype || ''))) return { categorie: 'loon', ingebouwd: 'salarisbatch' };
  for (const u of (ctx && ctx.uitzonderingen) || []) if (uitzonderingPast(u, tx)) return { categorie: CATEGORIEEN.includes(u.categorie) ? u.categorie : 'overig', uitzondering: u.id };
  return null;
}

// ───────────────────────────── matching afschrijving ↔ factuur (§ 4.6) ─────────────────────────────

const AUTO_ZEKERHEID = 0.8, SUBSET_MAX = 20, SUBSET_AUTO_MAX = 8, VALUTA_MARGE = 0.03;
const INCASSO_TOL_PCT = 5, INCASSO_TOL_MIN = 100;   // incasso: ± max(5 %, € 1) tenzij de leverancier een eigen tolerantie heeft
const NIET_OPEN = ['geen_factuur', 'dubbel'];
function incassoTolerantie(l, centen) {
  const p = l ? l.incasso_tolerantie_pct : null;
  const pct = p !== null && p !== undefined && p !== '' && Number.isFinite(Number(p)) ? Number(p) : INCASSO_TOL_PCT;
  return Math.max(INCASSO_TOL_MIN, Math.round(Math.abs(centen) * pct / 100));
}

// Aflopende zekerheid in plaats van een hard datumvenster: binnen 45 dagen na de vervaldatum telt alles, daarna zakt het lineair tot
// de helft; ruim vóór de factuurdatum betalen zakt sneller (vooruitbetaling kan, maar is zeldzaam).
function datumFactor(tx, f) {
  const ref = f.vervaldatum || f.factuurdatum;
  if (!ref || !isIsoDatum(ref)) return 0.9;
  const na = dagenTussen(ref, tx.boekdatum);
  const voorFactuur = f.factuurdatum && isIsoDatum(f.factuurdatum) ? dagenTussen(tx.boekdatum, f.factuurdatum) : 0;
  let x = 1;
  if (na > 45) x = Math.max(0.5, 1 - (na - 45) / 150);
  if (voorFactuur > 7) x = Math.min(x, Math.max(0.5, 1 - (voorFactuur - 7) / 60));
  return x;
}
// Kan deze betaling redelijkerwijs voor deze factuur zijn? Vervaldatum (anders factuurdatum) hooguit 20 dagen na de boekdatum.
function opeisbaar(tx, f) { const ref = f.vervaldatum || f.factuurdatum; return !ref || !isIsoDatum(ref) || dagenTussen(tx.boekdatum, ref) <= 20; }
function afstand(tx, f) { const ref = f.vervaldatum || f.factuurdatum; return ref && isIsoDatum(ref) ? Math.abs(dagenTussen(ref, tx.boekdatum)) : 9999; }
function rond(x) { return Math.round(x * 1000) / 1000; }

// Wat de factuur van de rekening vraagt, in centen, positief = geld eraf (factuur), negatief = geld erbij (creditnota).
function teBetalen(f) { return Number(f.incl); }
function levVan(id, ctx) { return ((ctx && ctx.leveranciers) || []).find((l) => l.id === id) || null; }
function levIbans(l) { return new Set(((l && l.ibans) || []).map(ibanNorm).filter(Boolean)); }
function leverancierBijTx(tx, ctx) {
  const lijst = (ctx && ctx.leveranciers) || [];
  const tegen = ibanNorm(tx.tegenpartij_iban);
  if (tegen) { const l = lijst.find((x) => levIbans(x).has(tegen)); if (l) return { leverancier: l, via: 'iban' }; }
  if (tx.incassant_id) { const l = lijst.find((x) => (x.incassant_ids || []).includes(tx.incassant_id)); if (l) return { leverancier: l, via: 'incassant' }; }
  const n = normNaam(tx.tegenpartij_naam);
  if (n.length >= 4) {
    // eerst exact; anders een deel van de naam, maar alleen als precies één leverancier past (anders wint de eerste in de lijst)
    const exact = lijst.filter((x) => normNaam(x.naam) === n);
    const deel = exact.length ? exact : lijst.filter((x) => { const m = normNaam(x.naam); return m.length >= 6 && n.length >= 6 && (n.indexOf(m) >= 0 || m.indexOf(n) >= 0); });
    if (deel.length === 1) return { leverancier: deel[0], via: 'naam' };
  }
  return null;
}
// Is de tegenpartij van deze post aantoonbaar de leverancier van de factuur? Alleen via een IBAN dat een mens kende (leverancier_iban,
// pas na Nagebeld) of de incassant-id van die leverancier. f.iban telt niet: dat kan een nog niet nagebeld IBAN van de factuur zijn.
// Zonder borging nooit automatisch koppelen (diffreview wv798 #1).
function tegenpartijGeborgd(tx, f, ctx) {
  const l = levVan(f.leverancier, ctx);
  if (!l) return false;
  const tegen = ibanNorm(tx.tegenpartij_iban);
  if (tegen && levIbans(l).has(tegen)) return true;
  return !!(tx.is_incasso && tx.incassant_id && (l.incassant_ids || []).includes(tx.incassant_id) && (!tegen || !levIbans(l).size));
}
// Stukken van de omschrijving en het kenmerk, elk genormaliseerd (alleen letters en cijfers). Een factuurnummer moet een heel stuk zijn
// (geen deel van een langer getal); een lang betalingskenmerk (≥ 12) mag ook met spaties ertussen staan.
function referentieStukken(tx) {
  const t = [tx.omschrijving, tx.kenmerk].filter(Boolean).join(' ');
  const stukken = new Set(t.split(/[\s,;:/()]+/).map(normNummer).filter(Boolean));
  return { stukken, plat: normNummer(t) || '' };
}
function noemtFactuur(ref, f) {
  for (const w of [f.nummer, f.kenmerk]) {
    const n = normNummer(w);
    if (!n || n.length < 3 || !/\d/.test(n)) continue;
    if (ref.stukken.has(n)) return true;
    if (n.length >= 12 && /^\d+$/.test(n) && ref.plat.indexOf(n) >= 0) return true;
  }
  return false;
}
// wv1317 (David 26-10-2026): een betaling ruim vóór de factuurdatum is geen betaling van die factuur, tenzij de omschrijving het nummer
// noemt (stap 1). Gemeten op 153 zekere paren (kenmerk + bedrag) uit het FV2-archief: 2 vóór de factuurdatum (4 en 6 dagen), 0 meer
// dan 7 dagen. Zo koppelde de huur van september en oktober aan de factuur van november (voorstel 1 en 2, 25-10).
const VOORUIT_MARGE = 7;
function vooruitBetaald(tx, f) { return !!(f.factuurdatum && isIsoDatum(f.factuurdatum) && dagenTussen(tx.boekdatum, f.factuurdatum) > VOORUIT_MARGE); }
// Noemt de betaling een ánder factuurnummer? Bewust smal (diffreview wv1317 MOET 1: een te grove regel liet juiste koppelingen vallen):
// (1) het EERSTE nummerstuk direct na het woord factuur/factuurnummer/invoice/nota (de bank knipt soms met spaties: "53. 73.00303") met
// minstens 3 cijfers, geen datum (01-10-2026, 2026-10, 10-2026) en geen los betalingskenmerk van ≥ 14 cijfers, en dat niet in het
// factuurnummer zit, het factuurnummer niet bevat en ook niet op dezelfde vier cijfers eindigt ("Invoice 12345" ↔ INV-12345, een
// afgeknipt "3.2026.0098" en "factuur 00982" tellen als hetzelfde); (2) een los stuk uit dezelfde nummerreeks (even lang, zelfde eerste
// helft, geen datum), bv. 3.2026.00819 tegen 3.2026.00982.
const FACTUURWOORD = /\b(?:factuur(?:nummer|nr)?|fact(?:uur)?\.?\s*nr|invoice(?:\s*(?:no|nr|number))?|nota(?:nummer)?)\b\.?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9.\-/]{0,30}(?: [0-9][0-9.\-/]{0,20}){0,2})/gi;
const DATUMSTUK = /^(?:\d{1,2}[-./]\d{1,2}[-./]\d{2,4}|\d{4}[-./]\d{1,2}(?:[-./]\d{1,2})?|\d{1,2}[-./]\d{4}|\d{8})$/;
function cijfers(s) { return String(s || '').replace(/\D/g, ''); }
function zelfdeNummer(a, n) {
  if (a.indexOf(n) >= 0 || n.indexOf(a) >= 0) return true;
  const ca = cijfers(a), cn = cijfers(n);
  return ca.length >= 4 && cn.length >= 4 && ca.slice(-4) === cn.slice(-4);
}
function andereFactuurGenoemd(tx, f, ref) {
  const n = normNummer(f.nummer);
  if (!n || n.length < 4 || !/\d/.test(n)) return false;
  ref = ref || referentieStukken(tx);
  if (noemtFactuur(ref, f)) return false;
  const tekst = [tx.omschrijving, tx.kenmerk].filter(Boolean).join(' ').slice(0, 600);
  FACTUURWOORD.lastIndex = 0;
  for (let m = FACTUURWOORD.exec(tekst); m; m = FACTUURWOORD.exec(tekst)) {
    const ruw = m[1].replace(/[.\-/]+$/, '');
    const stuk = normNummer(ruw) || '';
    const eerste = ruw.split(' ')[0];   // "d.d. 01-10-2026": het eerste stuk is een woord, geen nummer
    if (!/\d/.test(eerste) || cijfers(stuk).length < 3 || DATUMSTUK.test(eerste) || DATUMSTUK.test(ruw.replace(/\s+/g, '')) || /^\d{14,}$/.test(stuk)) continue;
    if (!zelfdeNummer(stuk, n)) return true;
  }
  if (n.length >= 6) {
    const helft = n.slice(0, Math.ceil(n.length / 2));
    for (const ruw of tekst.split(/[\s,;:()]+/)) {
      const s2 = normNummer(ruw.replace(/[.\-/]+$/, ''));
      if (!s2 || s2 === n || s2.length !== n.length || !/\d/.test(s2) || DATUMSTUK.test(ruw.replace(/[.\-/]+$/, ''))) continue;
      if (s2.slice(0, helft.length) === helft && !zelfdeNummer(s2, n)) return true;
    }
  }
  return false;
}
// Mag deze factuur zonder genoemd nummer (IBAN + bedrag, incasso, valuta) bij deze betaling horen?
function zonderNummerMogelijk(tx, f, ref) { return !vooruitBetaald(tx, f) && !andereFactuurGenoemd(tx, f, ref); }
function voorstelSleutel(txId, facturen) { return 'voorstel:' + txId + '|' + facturen.slice().sort().join(','); }
function kandidaat(methode, facturen, zekerheid, tx, extra) {
  return Object.assign({ methode, facturen: facturen.map((f) => f.id), zekerheid: rond(zekerheid), ter_bevestiging: zekerheid < AUTO_ZEKERHEID }, extra || {});
}

// Subset-som: welke combinatie (≥ 2) van hooguit SUBSET_MAX open facturen telt exact op tot het bedrag? Meet-in-the-middle (2 × 2^10).
// → { subset: [facturen], uniek } of null.
function subsetSom(facturen, doel) {
  const n = facturen.length;
  if (n < 2) return null;
  const h = n >> 1, A = facturen.slice(0, h), B = facturen.slice(h);
  const sommen = function (lijst) {
    const uit = new Map();
    for (let m = 0; m < (1 << lijst.length); m++) {
      let s = 0;
      for (let i = 0; i < lijst.length; i++) if (m & (1 << i)) s += teBetalen(lijst[i]);
      if (!uit.has(s)) uit.set(s, []);
      uit.get(s).push(m);
    }
    return uit;
  };
  const sa = sommen(A), sb = sommen(B);
  const oplossingen = [];
  for (const [s, maskers] of sa) {
    const rest = sb.get(doel - s);
    if (!rest) continue;
    for (const ma of maskers) for (const mb of rest) {
      const keuze = A.filter((_, i) => ma & (1 << i)).concat(B.filter((_, i) => mb & (1 << i)));
      if (keuze.length >= 2) oplossingen.push(keuze);
      if (oplossingen.length > 50) break;
    }
  }
  if (!oplossingen.length) return null;
  oplossingen.sort((x, y) => x.length - y.length);
  return { subset: oplossingen[0], uniek: oplossingen.length === 1 };
}

/*
 * Kandidaten voor één transactie, beste eerst. facturen = alle facturen van de entiteit die nog niet (helemaal) betaald gezien zijn.
 * Volgorde (§ 4.6): (1) kenmerk of factuurnummer in de omschrijving, (2) IBAN + exact bedrag, (3) incasso via incassant-id of IBAN met
 * tolerantie, (4) subset-som per IBAN (verzamelbetaling, factuur min creditnota; ≤ 20 open facturen), (5) valuta: tegenpartij + bedrag
 * ± 3 % (altijd ter bevestiging). Handmatig koppelen (6) doet een mens. Geen hard datumvenster: aflopende zekerheid. Zonder genoemd
 * nummer (2, 3, 5) nooit een factuur van ruim ná de betaling of als de betaling een ander factuurnummer noemt (wv1317).
 */
function matchTransactie(tx, facturen, ctx) {
  const r = richtingVan(tx);
  if (!r) return [];
  const bedrag = -tx.bedrag_centen;   // > 0 bij een afschrijving, < 0 bij een bijschrijving (creditnota terug)
  const open = (facturen || []).filter((f) => f.entiteit === tx.entiteit && !NIET_OPEN.includes(f.status) && Number.isFinite(teBetalen(f)) && teBetalen(f) !== 0);
  const eur = open.filter((f) => !f.valuta || f.valuta === tx.valuta);
  const lt = leverancierBijTx(tx, ctx);
  const tegen = ibanNorm(tx.tegenpartij_iban);
  const uit = [];
  const opDatum = (lijst) => lijst.slice().sort((a, b) => afstand(tx, a) - afstand(tx, b) || String(a.id).localeCompare(String(b.id)));

  // (1) kenmerk / factuurnummer
  const ref = referentieStukken(tx);
  const genoemd = eur.filter((f) => noemtFactuur(ref, f));
  if (genoemd.length) {
    const exact = genoemd.filter((f) => teBetalen(f) === bedrag);
    const som = genoemd.reduce((s, f) => s + teBetalen(f), 0);
    if (exact.length === 1) uit.push(kandidaat('kenmerk', exact, 0.98 * datumFactor(tx, exact[0]), tx));
    else if (genoemd.length > 1 && som === bedrag) uit.push(kandidaat('kenmerk', genoemd, 0.95 * Math.min.apply(null, genoemd.map((f) => datumFactor(tx, f))), tx, { verzamel: true }));
    else uit.push(kandidaat('kenmerk', [opDatum(genoemd)[0]], 0.6, tx, { reden: 'kenmerk klopt, bedrag niet' }));
  }
  // (2) IBAN + exact bedrag
  if (tegen) {
    const vanIban = eur.filter((f) => (ibanNorm(f.iban) === tegen || (lt && lt.via === 'iban' && f.leverancier === lt.leverancier.id)) && teBetalen(f) === bedrag &&
      zonderNummerMogelijk(tx, f, ref));
    if (vanIban.length) {
      const g = opDatum(vanIban);
      // meer opeisbare facturen met hetzelfde bedrag: niet gokken welke (abonnement september of oktober?) — een mens kiest (diffreview
      // wv798 #3). Een factuur die pas over weken vervalt (vooruit ingevoerde huur) telt niet als alternatief (natoets #5).
      const alt = g.slice(1).filter((f) => opeisbaar(tx, f));
      const twijfel = alt.length > 0;
      uit.push(kandidaat('iban_bedrag', [g[0]], (twijfel ? 0.6 : 0.95) * datumFactor(tx, g[0]), tx, twijfel ? { alternatieven: alt.slice(0, 3).map((f) => f.id) } : null));
    }
  }
  // (3) incasso met tolerantie
  if (tx.is_incasso && lt && r === 'af') {
    const l = lt.leverancier;
    const vanLev = eur.filter((f) => f.leverancier === l.id && teBetalen(f) > 0 && zonderNummerMogelijk(tx, f, ref));
    const binnen = vanLev.map((f) => ({ f, diff: Math.abs(teBetalen(f) - bedrag), tol: incassoTolerantie(l, teBetalen(f)) }))
      .filter((x) => x.diff <= x.tol).sort((a, b) => a.diff - b.diff || afstand(tx, a.f) - afstand(tx, b.f));
    if (binnen.length) {
      const b = binnen[0];
      const basis = b.diff === 0 ? 0.92 : 0.9 - 0.3 * (b.diff / b.tol);
      const gelijk = binnen.slice(1).filter((x) => x.diff === b.diff && opeisbaar(tx, x.f));
      const twijfel = gelijk.length > 0;
      uit.push(kandidaat('incasso', [b.f], (twijfel ? 0.6 : basis) * datumFactor(tx, b.f), tx, Object.assign({ verschil_centen: teBetalen(b.f) - bedrag },
        twijfel ? { alternatieven: gelijk.slice(0, 3).map((x) => x.f.id) } : null)));
    }
  }
  // (4) subset-som per IBAN (of incassant): verzamelbetaling, factuur min creditnota
  if (lt && (lt.via === 'iban' || lt.via === 'incassant')) {
    const vanLev = opDatum(eur.filter((f) => f.leverancier === lt.leverancier.id && (!vooruitBetaald(tx, f) || noemtFactuur(ref, f)))).slice(0, SUBSET_MAX);
    const s = subsetSom(vanLev, bedrag);
    if (s) {
      const f0 = Math.min.apply(null, s.subset.map((f) => datumFactor(tx, f)));
      // bij veel open facturen is een unieke combinatie vaak toeval (simulatie: 20 → ± 22 %): dan alleen automatisch als de omschrijving
      // minstens één van de facturen noemt (diffreview wv798 #4)
      const zeker = s.uniek && (vanLev.length <= SUBSET_AUTO_MAX || s.subset.some((f) => noemtFactuur(ref, f)));
      uit.push(kandidaat('subset', s.subset, (zeker ? 0.88 : 0.6) * f0, tx, { creditnota: s.subset.some((f) => teBetalen(f) < 0) }));
    }
  }
  // (5) vreemde valuta: alleen met een koers (van de factuur of van de beller), ± 3 %, altijd ter bevestiging
  if (lt && r === 'af') {
    const koersen = (ctx && ctx.koersen) || {};
    for (const f of open.filter((x) => x.valuta && x.valuta !== tx.valuta && x.leverancier === lt.leverancier.id && zonderNummerMogelijk(tx, x, ref))) {
      const verwacht = Number.isFinite(Number(f.incl_eur)) && f.incl_eur ? Number(f.incl_eur) : (koersen[f.valuta] ? Math.round(teBetalen(f) * Number(koersen[f.valuta])) : null);
      if (!verwacht) continue;
      if (Math.abs(bedrag - verwacht) <= Math.round(Math.abs(verwacht) * VALUTA_MARGE)) {
        const k = kandidaat('valuta', [f], Math.min(0.7, 0.7 * datumFactor(tx, f)), tx, { verwacht_centen: verwacht });
        k.ter_bevestiging = true;
        uit.push(k);
      }
    }
  }
  // ontdubbelen (zelfde factuurset) en sorteren
  const gezien = new Set();
  return uit.sort((a, b) => b.zekerheid - a.zekerheid).filter((k) => { const s = k.facturen.slice().sort().join(','); if (gezien.has(s)) return false; gezien.add(s); return true; });
}

// ───────────────────────────── signalen (§ 4.6) ─────────────────────────────

const LES_MAX = 300;
function naamVan(s) { return String(s.naam || 'de tegenpartij').slice(0, 80); }
function eurTekst(c) {
  const a = Math.abs(Number(c) || 0), e = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return '€ ' + (c < 0 ? '-' : '') + e + ',' + String(a % 100).padStart(2, '0');
}
function dagNL(d) { return d && isIsoDatum(d) ? Number(d.slice(8, 10)) + '-' + Number(d.slice(5, 7)) + '-' + d.slice(0, 4) : '?'; }

// Per soort: titel en knoppen. Elke knop: wat hij vraagt (vereist), welke gevolgen F2 uitvoert (declaratief: de kern voert niets uit),
// de les die bij "wat we leerden" verschijnt, en eventueel een sluimertijd (signaal komt dan terug als het probleem blijft).
const SIGNALEN = {
  geen_factuur: {
    titel: 'Afschrijving zonder factuur',
    knoppen: {
      factuur_uploaden: { label: 'Factuur uploaden', vereist: [], gevolgen: (s) => [{ actie: 'upload_openen', transactie: s.transacties[0] }],
        les: (s) => 'Afschrijving aan ' + naamVan(s) + ' had wel een factuur; die is alsnog geüpload.' },
      is_uitzondering: { label: 'Is een uitzondering', vereist: ['categorie'],
        gevolgen: (s, o) => [{ actie: 'uitzondering_maken', uitzondering: { richting: 'af', rekening: s.eigen_iban, tegenpartij: s.tegenpartij_iban || s.naam, categorie: o.categorie } }],
        les: (s, o) => naamVan(s) + ' is een stroom zonder factuur (' + o.categorie.replace(/_/g, ' ') + '); voortaan geen signaal meer.' },
      alleen_portaal: { label: 'Leverancier "alleen portaal"', vereist: ['leverancier'],
        gevolgen: (s, o) => [{ actie: 'leverancier_bijwerken', leverancier: o.leverancier, veld: 'alleen_portaal', waarde: 1 }],
        les: (s) => naamVan(s) + ' zet facturen alleen in een portaal; daar voortaan zelf ophalen.' },
    },
  },
  dubbel_betaald: {
    titel: 'Dubbel betaald',
    knoppen: {
      zet_op_incasso: { label: 'Zet leverancier op incasso', vereist: [],
        gevolgen: (s) => [{ actie: 'leverancier_bijwerken', leverancier: s.leverancier, veld: 'standaard_betaalwijze', waarde: 'incasso' }],
        les: (s) => naamVan(s) + ' incasseert zelf: voortaan op incasso, niet meer met de hand betalen.' },
      terugvraagtekst: { label: 'Terugvraagtekst kopiëren', vereist: [], gevolgen: (s) => [{ actie: 'tekst_tonen', tekst: terugvraagTekst(s) }],
        les: (s) => 'Dubbele betaling aan ' + naamVan(s) + ' teruggevraagd (tekst gekopieerd; de app mailt niet zelf).' },
      geen_dubbel: { label: 'Geen dubbel', vereist: [], gevolgen: () => [],
        les: (s) => 'Twee betalingen aan ' + naamVan(s) + ' waren geen dubbele betaling.' },
    },
  },
  dubbele_factuur: {
    titel: 'Dubbele factuur',
    knoppen: {
      is_dubbel: { label: 'Is dubbel (archiveren)', vereist: [], gevolgen: () => [],
        les: (s) => naamVan(s) + ' stuurde dezelfde factuur twee keer; de tweede is gearchiveerd.' },
      toch_factuur: { label: 'Toch een factuur', vereist: [], gevolgen: (s) => [{ actie: 'factuur_status', factuur: s.facturen[0], gebeurtenis: 'toch_factuur' }],
        les: (s) => 'Twee facturen van ' + naamVan(s) + ' met zelfde nummer en bedrag waren toch twee facturen.' },
    },
  },
  verzending_mislukt: {
    titel: 'Verzending mislukt',
    knoppen: {
      opnieuw_proberen: { label: 'Opnieuw proberen', vereist: [], gevolgen: (s) => [{ actie: 'factuur_status', factuur: s.facturen[0], gebeurtenis: 'opnieuw_proberen' }],
        les: (s) => 'Verzending van een factuur van ' + naamVan(s) + ' opnieuw gestart.' },
      terug_naar_beoordelen: { label: 'Terug naar Beoordelen', vereist: [], gevolgen: (s) => [{ actie: 'factuur_status', factuur: s.facturen[0], gebeurtenis: 'terug_naar_beoordelen' }],
        les: (s) => 'Factuur van ' + naamVan(s) + ' terug naar Beoordelen na een mislukte verzending.' },
    },
  },
  incasso_niet_gezien: {
    titel: 'Incasso niet gezien',
    knoppen: {
      toch_zelf_betalen: { label: 'Toch zelf betalen', vereist: [], gevolgen: (s) => [{ actie: 'betaalspoor', factuur: s.facturen[0], gebeurtenis: 'toch_zelf_betalen' }],
        les: (s) => naamVan(s) + ' incasseerde niet; deze factuur zelf betaald.' },
      afwachten: { label: 'Afwachten', vereist: [], sluimer_dagen: 14, gevolgen: () => [],
        les: (s) => 'Incasso van ' + naamVan(s) + ' komt later; over twee weken opnieuw kijken.' },
    },
  },
  te_betalen_niet_betaald: {
    titel: 'Te betalen, niet betaald',
    knoppen: {
      naar_betaallijst: { label: 'Naar betaallijst', vereist: [], gevolgen: (s) => [{ actie: 'betaallijst', factuur: s.facturen[0] }],
        les: (s) => 'Factuur van ' + naamVan(s) + ' voorbij de vervaldatum; op de betaallijst gezet.' },
      is_al_betaald: { label: 'Is al betaald (koppelen)', vereist: ['transactie'],
        gevolgen: (s, o) => [{ actie: 'koppelen', factuur: s.facturen[0], transactie: o.transactie }, { actie: 'betaalspoor', factuur: s.facturen[0], gebeurtenis: 'bankmatch' }],
        les: (s) => 'Betaling aan ' + naamVan(s) + ' was er al maar werd niet herkend; met de hand gekoppeld.' },
    },
  },
  ingevoerd_niet_gezien: {
    titel: 'Ingevoerd, niet gezien',
    knoppen: {
      opnieuw_kijken: { label: 'Opnieuw kijken', vereist: [], sluimer_dagen: 3, gevolgen: () => [],
        les: (s) => 'Betaling aan ' + naamVan(s) + ' nog niet op de bank; over drie dagen opnieuw kijken.' },
      koppelen: { label: 'Koppelen', vereist: ['transactie'],
        gevolgen: (s, o) => [{ actie: 'koppelen', factuur: s.facturen[0], transactie: o.transactie }, { actie: 'betaalspoor', factuur: s.facturen[0], gebeurtenis: 'bankmatch' }],
        les: (s) => 'Betaling aan ' + naamVan(s) + ' stond er wel maar werd niet herkend; met de hand gekoppeld.' },
    },
  },
  onbekend_iban: {
    titel: 'Betaald aan onbekend IBAN',
    // fraudesignaal: één knop, met verplichte toelichting; het IBAN wordt hier NOOIT bekend gemaakt (dat gaat alleen via Nagebeld)
    knoppen: {
      uitzoeken: { label: 'Uitzoeken (fraudesignaal)', vereist: ['toelichting'], gevolgen: () => [],
        les: (s, o) => 'Betaling aan ' + naamVan(s) + ' op een onbekend IBAN uitgezocht: ' + String(o.toelichting).slice(0, 160) },
    },
  },
  mogelijk_dubbel_geupload: {
    titel: 'Mogelijk dubbel geüpload',
    knoppen: {
      is_hetzelfde: { label: 'Is hetzelfde', vereist: [], voorwaarde: (s) => (s.details && s.details.te_verwijderen ? null : 'beide posten zijn al gekoppeld; ontkoppel er eerst één'),
        gevolgen: (s) => [{ actie: 'transactie_verwijderen', transactie: s.details.te_verwijderen }],
        les: (s) => 'Dezelfde betaling aan ' + naamVan(s) + ' kwam via twee bestanden binnen; de tweede is weggehaald. Upload per rekening één soort export.' },
      zijn_er_twee: { label: 'Zijn er echt twee', vereist: [], gevolgen: () => [],
        les: (s) => 'Twee gelijke betalingen aan ' + naamVan(s) + ' op één dag waren echt twee betalingen.' },
    },
  },
};
const SIGNAAL_SOORTEN = Object.keys(SIGNALEN);

function signaalSleutel(soort, transacties, facturen, extra) {
  return soort + ':' + (transacties || []).slice().sort().join(',') + '|' + (facturen || []).slice().sort().join(',') + (extra ? '|' + extra : '');
}
function maakSignaal(soort, o) {
  const s = Object.assign({ soort, titel: SIGNALEN[soort].titel, transacties: [], facturen: [], status: 'open' }, o);
  s.sleutel = signaalSleutel(soort, s.transacties, s.facturen, s.sleutel_extra);
  delete s.sleutel_extra;
  s.knoppen = Object.keys(SIGNALEN[soort].knoppen);
  s.alleen_eigenaar = !!s.alleen_eigenaar;
  return s;
}
// Tekst om te kopiëren (de app mailt zelf niet; David of Cynthia verstuurt).
function terugvraagTekst(s) {
  const d = s.details || {};
  return 'Beste ' + naamVan(s) + ',\n\nFactuur ' + (d.nummer || '') + ' van ' + eurTekst(s.bedrag_centen) + ' is twee keer betaald: op ' + dagNL(d.datums && d.datums[0]) +
    ' en op ' + dagNL(d.datums && d.datums[1]) + '. Wilt u het dubbel betaalde bedrag van ' + eurTekst(s.bedrag_centen) + ' terugstorten op de rekening waarvan het is afgeschreven' +
    (s.eigen_iban ? ' (' + s.eigen_iban + ')' : '') + '?\n\nMet vriendelijke groet,';
}

/*
 * Een signaal afhandelen met één van zijn knoppen. → { ok:true, signaal (afgehandeld, met les), gevolgen: [...] } of { ok:false, fout }.
 * De kern voert niets uit: F2 voert de gevolgen uit in dezelfde transactie als het afsluiten. opties: { wie, nu, categorie, leverancier,
 * transactie, toelichting }.
 */
function afhandelSignaal(signaal, knop, opties) {
  opties = opties || {};
  if (!signaal || !SIGNALEN[signaal.soort]) return { ok: false, fout: 'onbekend_signaal' };
  if (signaal.status !== 'open') return { ok: false, fout: 'niet_open' };
  const k = SIGNALEN[signaal.soort].knoppen[knop];
  if (!k) return { ok: false, fout: 'onbekende_knop', reden: signaal.soort + ' kent ' + Object.keys(SIGNALEN[signaal.soort].knoppen).join(', ') };
  if (!opties.wie) return { ok: false, fout: 'wie_ontbreekt' };
  if (typeof opties.nu !== 'string' || !isIsoDatum(opties.nu.slice(0, 10))) return { ok: false, fout: 'nu_ontbreekt' };
  for (const v of k.vereist) if (opties[v] === undefined || opties[v] === null || opties[v] === '') return { ok: false, fout: 'vereist', reden: v };
  if (k.vereist.includes('categorie') && !CATEGORIEEN.includes(opties.categorie)) return { ok: false, fout: 'onbekende_categorie', reden: CATEGORIEEN.join(', ') };
  if (k.vereist.includes('toelichting') && String(opties.toelichting).trim().length < 5) return { ok: false, fout: 'vereist', reden: 'toelichting' };
  const vw = k.voorwaarde ? k.voorwaarde(signaal) : null;
  if (vw) return { ok: false, fout: 'voorwaarde', reden: vw };
  const af = Object.assign({}, signaal, { status: 'afgehandeld', afhandeling: knop, les: k.les(signaal, opties).slice(0, LES_MAX), wie: opties.wie, wanneer: opties.nu });
  if (k.sluimer_dagen) af.sluimer_tot = plusDagen(opties.nu.slice(0, 10), k.sluimer_dagen);
  return { ok: true, signaal: af, gevolgen: k.gevolgen(signaal, opties) };
}

// Werkdagen (ma–vr) ná a tot en met b.
function werkdagenTussen(a, b) {
  const n = dagenTussen(a, b);
  if (n <= 0) return 0;
  let w = 0;
  for (let i = 1; i <= n; i++) { const dag = new Date(Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10) + i)).getUTCDay(); if (dag !== 0 && dag !== 6) w++; }
  return w;
}

// Mogelijk dubbel geüpload: zelfde rekening + datum + bedrag + tegenpartij, andere entry_ref, uit verschillende bestanden.
function dubbelGeupload(transacties) {
  const groepen = new Map();
  for (const t of transacties || []) {
    const tp = ibanNorm(t.tegenpartij_iban) || normNaam(t.tegenpartij_naam);
    const k = [t.eigen_iban, t.boekdatum, t.bedrag_centen, tp].join('|');
    if (!groepen.has(k)) groepen.set(k, []);
    groepen.get(k).push(t);
  }
  const paren = [];
  for (const g of groepen.values()) {
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const a = g[i], b = g[j];
      if (a.entry_ref !== b.entry_ref && a.bestand && b.bestand && a.bestand !== b.bestand) paren.push([a, b]);
    }
  }
  return paren;
}

/*
 * De bankcontrole over de hele stand (puur; F2 roept hem na elke upload en bankluis-ronde aan).
 * inv = { vandaag, transacties, facturen, leveranciers, uitzonderingen, entiteiten, rekeningen, koppelingen, opdrachten, bestaandeSignalen,
 *         afgewezenVoorstellen, koersen }.
 *   transacties: genormaliseerd + { id, bestand, bestand_op? }; facturen: { id, entiteit, leverancier, nummer, kenmerk, incl (centen,
 *   creditnota negatief), valuta, incl_eur?, iban, factuurdatum, vervaldatum, betaalwijze, betaalspoor, status, ingevoerd_op, dubbel_van?,
 *   patientkenmerk?, alleen_eigenaar? }; koppelingen: { transactie, factuur, bron ('auto'|'mens'), methode? }.
 * → { koppelingen (nieuw, bron 'auto'), voorstellen (ter bevestiging, met sleutel), uitzonderingen (toegepast), betaalspoor ('bankmatch'),
 *     signalen (nieuw), heropenen (sleutels van gesluimerde signalen waarvan de sluimer voorbij is en het probleem blijft) }.
 * Automatisch koppelen alleen als de tegenpartij geborgd is (bekend IBAN of incassant van die leverancier) én de zekerheid ≥ 0,8 én er
 * geen gelijkwaardig alternatief is; al het andere wordt een voorstel dat een mens bevestigt.
 */
function bankcontrole(inv) {
  const vandaag = inv && inv.vandaag;
  if (!isIsoDatum(vandaag)) throw new BankWeigering('vandaag', 'vandaag ontbreekt');
  const ctx = { leveranciers: inv.leveranciers || [], uitzonderingen: inv.uitzonderingen || [], entiteiten: inv.entiteiten || [], rekeningen: inv.rekeningen || [], koersen: inv.koersen || {} };
  // wv1360: rekeningen van betaaldiensten en derdengelden (de beller bepaalt ze uit de hele bankhistorie): daar betalen we veel partijen op
  const verzamel = new Set((inv.verzamelIbans || []).map(ibanNorm));
  const txs = (inv.transacties || []).slice().sort((a, b) => (a.boekdatum < b.boekdatum ? -1 : a.boekdatum > b.boekdatum ? 1 : String(a.entry_ref).localeCompare(String(b.entry_ref))));
  const facturen = inv.facturen || [];
  const fMap = new Map(facturen.map((f) => [f.id, f]));
  const fPerEnt = new Map();
  for (const f of facturen) { if (!fPerEnt.has(f.entiteit)) fPerEnt.set(f.entiteit, []); fPerEnt.get(f.entiteit).push(f); }
  const txMap = new Map(txs.map((t) => [t.id, t]));
  const betaald = new Map();   // factuur → [{ tx, methode, bron }]
  const txFacturen = new Map();   // tx → [factuur-id's]
  const koppel = (txId, fId, methode, bron) => {
    if (!betaald.has(fId)) betaald.set(fId, []);
    betaald.get(fId).push({ tx: txId, methode: methode || null, bron: bron || null });
    if (!txFacturen.has(txId)) txFacturen.set(txId, []);
    txFacturen.get(txId).push(fId);
  };
  for (const k of inv.koppelingen || []) { koppel(k.transactie, k.factuur, k.methode, k.bron); if (k.volledig === true) betaald.get(k.factuur)[betaald.get(k.factuur).length - 1].volledig = true; }
  // voldaan: de gekoppelde betalingen dekken het bedrag; of een mens koppelde; of de koppeling was een incasso binnen de tolerantie of
  // een valutabetaling (euro tegen vreemde valuta is niet op te tellen); of de factuur zit in een verzamelbetaling (één post voor meer
  // facturen, ook factuur min creditnota: de post dekt dan de groep, niet de factuur los) (diffreview wv798 #2)
  const voldaan = (f) => {
    const ks = betaald.get(f.id) || [];
    if (!ks.length) return false;
    // een mens-koppeling telt alleen als volledig als hij dat zegt (termijnbetalingen: de eerste termijn dekt de factuur niet; natoets #3)
    if (ks.some((k) => k.volledig === true || k.methode === 'incasso' || k.methode === 'valuta' || (txFacturen.get(k.tx) || []).length > 1)) return true;
    const som = ks.reduce((s, k) => s + (txMap.has(k.tx) ? -txMap.get(k.tx).bedrag_centen : 0), 0);
    return teBetalen(f) > 0 ? som >= teBetalen(f) : som <= teBetalen(f);
  };
  const isPrive = (f) => !!f && (f.entiteit === 'prive' || !!f.prive || !!f.alleen_eigenaar || !!f.patientkenmerk);
  const eigenaarVan = (tx, fids) => !!(tx && tx.alleen_eigenaar) || (fids || []).some((id) => isPrive(fMap.get(id)));
  const afgewezen = new Set(inv.afgewezenVoorstellen || []);
  const uit = { koppelingen: [], voorstellen: [], uitzonderingen: [], betaalspoor: [], signalen: [], heropenen: [] };
  const signalen = [];
  const voorgesteld = new Set();
  const wensen = [];

  // Ronde 1: alleen de zekere koppelingen (geborgde tegenpartij, ≥ 0,8, geen gelijkwaardig alternatief). Zo hangt "dubbel betaald" niet
  // af van de volgorde in het bestand: een incasso die maar net binnen de tolerantie valt, ziet in ronde 2 de exacte handbetaling al
  // gekoppeld staan (natoets wv798 #1).
  const ronde1 = (tx) => {
    if (txFacturen.has(tx.id) || uitzonderingVoor(tx, ctx)) return;
    const kand = matchTransactie(tx, (fPerEnt.get(tx.entiteit) || []).filter((f) => !voldaan(f)), ctx);
    const k = kand[0];
    if (!k || k.ter_bevestiging) return;
    if (!k.facturen.every((fid) => fMap.has(fid) && tegenpartijGeborgd(tx, fMap.get(fid), ctx))) return;
    if (kand[1] && kand[1].zekerheid >= k.zekerheid - 0.05 && kand[1].facturen.join() !== k.facturen.join()) return;
    const eigenaar = eigenaarVan(tx, k.facturen);
    for (const fid of k.facturen) {
      uit.koppelingen.push({ transactie: tx.id, factuur: fid, bron: 'auto', methode: k.methode, zekerheid: k.zekerheid, alleen_eigenaar: eigenaar });
      koppel(tx.id, fid, k.methode, 'auto');
      const f = fMap.get(fid);
      if (f && f.betaalspoor && f.betaalspoor !== 'betaald_gezien') uit.betaalspoor.push({ factuur: fid, gebeurtenis: 'bankmatch', van: f.betaalspoor, naar: 'betaald_gezien' });
    }
  };
  txs.forEach(ronde1);

  // Dubbel geüpload: welke post gaat bij "Is hetzelfde" weg? Die krijgt in ronde 2 geen eigen voorstel of signaal ernaast (natoets #7).
  // F2 sluit bij transactie_verwijderen ook de open signalen en voorstellen van die post.
  const getal = (x) => (x !== undefined && x !== null && /^\d+$/.test(String(x)) ? Number(x) : null);
  const jonger = (x, y) => {
    if (x.bestand_op && y.bestand_op) return String(x.bestand_op) > String(y.bestand_op);
    const gx = getal(x.bestand), gy = getal(y.bestand);
    if (gx !== null && gy !== null) return gx > gy;   // "10" is jonger dan "9" (natoets #6)
    return String(x.bestand) > String(y.bestand);
  };
  const dubbelParen = dubbelGeupload(txs).map(([a, b]) => {
    const volgorde = jonger(a, b) ? [a, b] : [b, a];
    const weg = volgorde.find((t) => !txFacturen.has(t.id)) || null;
    return { a, b, weg };
  });
  const overslaan = new Set(dubbelParen.map((p) => p.weg && p.weg.id).filter(Boolean));

  // Ronde 2: wat over is → fraudesignaal, uitzondering, voorstel, dubbel betaald of geen factuur
  for (const tx of txs) {
    if (txFacturen.has(tx.id) || overslaan.has(tx.id)) continue;
    const lt = leverancierBijTx(tx, ctx);
    const tegen = ibanNorm(tx.tegenpartij_iban);
    const basis = { transacties: [tx.id], eigen_iban: tx.eigen_iban, entiteit: tx.entiteit, naam: lt ? lt.leverancier.naam : tx.tegenpartij_naam,
      tegenpartij_iban: tx.tegenpartij_iban, bedrag_centen: tx.bedrag_centen, datum: tx.boekdatum, alleen_eigenaar: !!tx.alleen_eigenaar, leverancier: lt ? lt.leverancier.id : null };
    // betaald aan onbekend IBAN: de tegenpartij is een bekende leverancier (incassant of naam), het IBAN niet. Vóór de uitzonderingen,
    // zodat een uitzondering op naam het fraudesignaal nooit uitzet (diffreview wv798 #13). wv1360: niet als het geld via een betaaldienst
    // of derdengeldenrekening ging ("X via Mollie", PayPal, Amazon Payments …): dat rekeningnummer is niet van X, en sinds de bekende
    // rekeningen uit de bankhistorie gaf dat op de archieftoets ± 8 loze meldingen per maand.
    if (richtingVan(tx) === 'af' && tegen && lt && lt.via !== 'iban' && levIbans(lt.leverancier).size && !eigenIbanMap(ctx).has(tegen)
      && !verzamel.has(tegen) && !VERZAMEL_RE.test(String(tx.tegenpartij_naam || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, ''))) {
      signalen.push(maakSignaal('onbekend_iban', Object.assign({}, basis, { details: { via: lt.via } })));
    }
    const u = uitzonderingVoor(tx, ctx);
    if (u) { uit.uitzonderingen.push(Object.assign({ transactie: tx.id, alleen_eigenaar: !!tx.alleen_eigenaar }, u)); continue; }
    // eerst: is dit een tweede betaling van een al voldane factuur? (zelf betaald én geïncasseerd, of hetzelfde factuurnummer opnieuw)
    if (richtingVan(tx) === 'af') {
      const ref = referentieStukken(tx);
      const bedrag = -tx.bedrag_centen;
      const al = (fPerEnt.get(tx.entiteit) || []).filter((f) => {
        if (!voldaan(f) || NIET_OPEN.includes(f.status) || !(teBetalen(f) > 0)) return false;
        const incassoSpel = tx.is_incasso || (betaald.get(f.id) || []).some((k) => k.methode === 'incasso');
        const tol = incassoSpel ? incassoTolerantie(levVan(f.leverancier, ctx), teBetalen(f)) : 0;   // incasso: binnen de tolerantie (natoets #1)
        return Math.abs(teBetalen(f) - bedrag) <= tol;
      });
      const dubbel = al.find((f) => {
        const l = levVan(f.leverancier, ctx);
        const zelfdeLev = !!(l && ((lt && lt.leverancier.id === l.id) || (tegen && levIbans(l).has(tegen))));
        if (!zelfdeLev) return false;   // een factuurnummer alleen is niet genoeg: "1001" komt bij veel leveranciers voor (diffreview wv798 #1)
        if (noemtFactuur(ref, f)) return true;
        const eerdere = (betaald.get(f.id) || []).map((k) => txMap.get(k.tx)).filter(Boolean);
        // ander soort betaling (handmatig vs incasso) aan dezelfde leverancier binnen 60 dagen: het klassieke "zelf betaald én geïncasseerd"
        return eerdere.some((e) => e.is_incasso !== tx.is_incasso && Math.abs(dagenTussen(e.boekdatum, tx.boekdatum)) <= 60);
      });
      if (dubbel) {
        const eerdere = (betaald.get(dubbel.id) || []).map((k) => txMap.get(k.tx)).filter(Boolean);
        signalen.push(maakSignaal('dubbel_betaald', Object.assign({}, basis, {
          transacties: eerdere.map((e) => e.id).concat([tx.id]), facturen: [dubbel.id], leverancier: dubbel.leverancier || basis.leverancier,
          naam: (levVan(dubbel.leverancier, ctx) || {}).naam || basis.naam, bedrag_centen: teBetalen(dubbel),
          alleen_eigenaar: basis.alleen_eigenaar || isPrive(dubbel), details: { nummer: dubbel.nummer, datums: eerdere.map((e) => e.boekdatum).concat([tx.boekdatum]) },
        })));
        continue;
      }
    }
    // wv1317: eerst alle wensen verzamelen; daarna krijgt elke factuur hooguit één open voorstel (de beste betaling, dan de dichtstbijzijnde)
    const kand = matchTransactie(tx, (fPerEnt.get(tx.entiteit) || []).filter((f) => !voldaan(f)), ctx)
      .map((k) => Object.assign({ sleutel: voorstelSleutel(tx.id, k.facturen) }, k)).filter((k) => !afgewezen.has(k.sleutel));
    if (kand.length) { wensen.push({ tx, kand, basis }); continue; }
    if (richtingVan(tx) === 'af' && dagenTussen(tx.boekdatum, vandaag) > 7) signalen.push(maakSignaal('geen_factuur', basis));
  }
  // afstand tot de periode van de factuur: 0 tussen factuur- en vervaldatum, anders tot de dichtstbijzijnde grens (diffreview wv1317 ZOU 4)
  const afstandVan = (w) => {
    const f = fMap.get(w.kand[0].facturen[0]) || {}, d = w.tx.boekdatum;
    const van = isIsoDatum(f.factuurdatum) ? f.factuurdatum : null, tot = isIsoDatum(f.vervaldatum) ? f.vervaldatum : van;
    if (!van && !tot) return 9999;
    if (van && d < van) return dagenTussen(d, van);
    if (tot && d > tot) return dagenTussen(tot, d);
    return 0;
  };
  wensen.sort((a, b) => b.kand[0].zekerheid - a.kand[0].zekerheid || afstandVan(a) - afstandVan(b) || (a.tx.boekdatum < b.tx.boekdatum ? -1 : a.tx.boekdatum > b.tx.boekdatum ? 1 : 0) ||
    String(a.tx.id).localeCompare(String(b.tx.id)));
  const bezet = new Set();
  for (const { tx, kand, basis } of wensen) {
    const k = kand.find((x) => x.facturen.every((fid) => !bezet.has(fid)));
    if (k) {
      const geborgd = k.facturen.every((fid) => fMap.has(fid) && tegenpartijGeborgd(tx, fMap.get(fid), ctx));
      const alt = (k.alternatieven || []).filter((fid) => !bezet.has(fid) && !k.facturen.includes(fid));
      const alle = k.facturen.concat(alt);
      uit.voorstellen.push(Object.assign({ transactie: tx.id }, k, { alternatieven: alt.length ? alt : undefined, ter_bevestiging: true, tegenpartij_geborgd: geborgd,
        alleen_eigenaar: eigenaarVan(tx, alle) }));
      k.facturen.forEach((f) => bezet.add(f));
      alle.forEach((f) => voorgesteld.add(f));   // ook de alternatieven: een mens kiest, geen vals signaal ernaast
      continue;
    }
    // elke kandidaat-factuur is al voorgesteld bij een betere betaling: geen voorstel en ook (nog) geen "geen factuur" — wijst David de
    // winnaar af, dan krijgt deze betaling bij de volgende controle het voorstel; bevestigt hij, dan volgt het signaal vanzelf (ZOU 4)
  }

  // signalen per factuur — alleen voor entiteiten waarvan de app een bank ziet (rekening met controle 1); Privé-regels worden niet
  // opgeslagen, dus daar zou elk signaal vals zijn (diffreview wv798 #12)
  const zichtbaar = new Set((ctx.rekeningen || []).filter((r) => controleVan(r) === 1).map((r) => r.entiteit));
  const gekoppeld = (f) => (betaald.get(f.id) || []).length > 0 || voorgesteld.has(f.id);
  for (const f of facturen) {
    if (NIET_OPEN.includes(f.status) || gekoppeld(f) || f.entiteit === 'prive' || !zichtbaar.has(f.entiteit)) continue;
    // een creditnota vraagt geen betaling: nooit "te betalen, niet betaald" of "incasso niet gezien" (wv855, overdracht F3 #1)
    if (f.soort === 'creditnota' || (Number.isSafeInteger(Number(f.incl)) && Number(f.incl) < 0)) continue;
    const l = levVan(f.leverancier, ctx);
    const basis = { facturen: [f.id], entiteit: f.entiteit, naam: l ? l.naam : null, leverancier: f.leverancier || null, bedrag_centen: teBetalen(f),
      datum: f.vervaldatum || null, alleen_eigenaar: isPrive(f) };
    const verval = f.vervaldatum && isIsoDatum(f.vervaldatum) ? f.vervaldatum : (f.factuurdatum && isIsoDatum(f.factuurdatum) ? plusDagen(f.factuurdatum, 14) : null);
    if (f.betaalspoor === 'incasso_verwacht' && verval && dagenTussen(verval, vandaag) > 14) signalen.push(maakSignaal('incasso_niet_gezien', basis));
    else if (f.betaalspoor === 'te_betalen' && verval && vandaag > verval) signalen.push(maakSignaal('te_betalen_niet_betaald', basis));
    else if (f.betaalspoor === 'ingevoerd' && f.ingevoerd_op && isIsoDatum(String(f.ingevoerd_op).slice(0, 10)) && werkdagenTussen(String(f.ingevoerd_op).slice(0, 10), vandaag) > 5)
      signalen.push(maakSignaal('ingevoerd_niet_gezien', basis));
  }
  for (const f of facturen) {
    if (f.status === 'dubbel' && f.dubbel_van) {
      const l = levVan(f.leverancier, ctx);
      signalen.push(maakSignaal('dubbele_factuur', { facturen: [f.id, f.dubbel_van], entiteit: f.entiteit, naam: l ? l.naam : null, leverancier: f.leverancier || null,
        bedrag_centen: teBetalen(f), alleen_eigenaar: isPrive(f) || isPrive(fMap.get(f.dubbel_van)) }));
    }
  }
  for (const op of inv.opdrachten || []) {
    if (op.status === 'geweigerd' || (op.status === 'mislukt' && Number(op.poging) >= 3)) {
      const f = fMap.get(op.factuur) || {};
      const l = levVan(f.leverancier, ctx);
      // de opdracht hoort in de sleutel: na "Opnieuw proberen" is een tweede mislukking een nieuw signaal (diffreview wv798 #7)
      signalen.push(maakSignaal('verzending_mislukt', { facturen: [op.factuur], entiteit: op.entiteit, naam: l ? l.naam : null, leverancier: f.leverancier || null,
        details: { opdracht: op.id, status: op.status }, sleutel_extra: 'op=' + op.id, alleen_eigenaar: isPrive(f) }));
    }
  }
  for (const { a, b, weg } of dubbelParen) {
    // "Is hetzelfde" haalt de post uit het jongste bestand weg, nooit een gekoppelde (diffreview wv798 #14)
    signalen.push(maakSignaal('mogelijk_dubbel_geupload', { transacties: [a.id, b.id], eigen_iban: a.eigen_iban, entiteit: a.entiteit, naam: a.tegenpartij_naam,
      bedrag_centen: a.bedrag_centen, datum: a.boekdatum, alleen_eigenaar: !!(a.alleen_eigenaar || b.alleen_eigenaar), details: { te_verwijderen: weg ? weg.id : null } }));
  }

  // nooit twee keer dezelfde melding (grondwet 10). Bestaande sleutel → niet opnieuw. Een gesluimerd signaal waarvan de sluimer voorbij is
  // en waarvan het probleem blijft, gaat naar `heropenen` (zelfde rij weer open; geen tweede rij met dezelfde sleutel). Staat dezelfde
  // sleutel er zowel open als afgehandeld, dan wint open (diffreview wv798 #8).
  const bestaand = new Map();
  for (const s of inv.bestaandeSignalen || []) {
    const b = bestaand.get(s.sleutel);
    if (!b || s.status === 'open') bestaand.set(s.sleutel, s);
  }
  const gezien = new Set();
  for (const s of signalen) {
    if (gezien.has(s.sleutel)) continue;
    gezien.add(s.sleutel);
    const b = bestaand.get(s.sleutel);
    if (!b) { uit.signalen.push(s); continue; }
    if (b.status === 'afgehandeld' && b.sluimer_tot && b.sluimer_tot <= vandaag) uit.heropenen.push({ sleutel: s.sleutel, soort: s.soort });
  }
  return uit;
}

// ───────────────────────────── uitleg in gewone taal (wv1317) ─────────────────────────────

/*
 * Wat David akkordeert als hij op "Ja, koppel" drukt, in één zin, met het waarom en de zekerheid in woorden (David 26-10-2026: "Als ik ja
 * geef op een koppeling, moet heel duidelijk zijn wat ik akkordeer"). v = { methode, zekerheid, tegenpartij_geborgd, verschil_centen?,
 * verwacht_centen? }; tx = bankregel; facturen = [{ nummer, factuurdatum, vervaldatum, incl, valuta, leverancier_naam, iban }];
 * alternatieven = idem; patroon = uitkomst van facturen-validatie.bedragPatroon (of null).
 * → { zin, waarom: [..], let_op: [..], zekerheid_tekst }. Geen bedragen of namen buiten wat David in de App al ziet.
 */
function zekerheidTekst(z) {
  return z >= 0.9 ? 'vrijwel zeker' : z >= 0.75 ? 'waarschijnlijk' : z >= 0.55 ? 'mogelijk: kijk even na' : 'twijfelachtig: kijk goed na';
}
function datumZin(tx, f) {
  if (!f || !isIsoDatum(f.factuurdatum)) return null;
  const d = dagenTussen(f.factuurdatum, tx.boekdatum);
  if (d === 0) return 'betaald op de factuurdatum';
  if (d > 0) return 'betaald ' + d + (d === 1 ? ' dag' : ' dagen') + ' na de factuurdatum';
  return 'betaald ' + -d + (d === -1 ? ' dag' : ' dagen') + ' vóór de factuurdatum';
}
function voorstelUitleg(v, tx, facturen, alternatieven, patroon) {
  facturen = (facturen || []).filter(Boolean);
  const af = tx.bedrag_centen < 0;
  const rek = tx.tegenpartij_iban ? ' (rekening ' + eind4(tx.tegenpartij_iban) + ')' : '';
  const wie = (tx.tegenpartij_naam || 'een onbekende tegenpartij') + rek;
  const levNaam = (f) => (f.leverancier_naam ? 'van ' + f.leverancier_naam : 'leverancier nog niet bekend');
  const credit = (f) => f.soort === 'creditnota' || teBetalen(f) < 0;
  const fTekst = (f) => (credit(f) ? 'creditnota ' : 'factuur ') + (f.nummer || 'zonder nummer') + ' (' + levNaam(f) + ', factuurdatum ' + dagNL(f.factuurdatum) + ', ' +
    eurTekst(Math.abs(teBetalen(f))) + ')';
  const wat = facturen.length > 1 ? 'betaling van ' + facturen.length + ' stukken samen: ' + facturen.map(fTekst).join('; ')
    : facturen.length ? (credit(facturen[0]) ? 'terugbetaling van ' : 'betaling van ') + fTekst(facturen[0]) : 'een factuur';
  const zin = (af ? 'Afschrijving van ' + dagNL(tx.boekdatum) + ' van ' + eurTekst(-tx.bedrag_centen) + ' aan ' : 'Bijschrijving van ' + dagNL(tx.boekdatum) + ' van ' +
    eurTekst(tx.bedrag_centen) + ' van ') + wie + ' = ' + wat + '.';
  const waarom = [];
  const f0 = facturen[0] || {};
  const zelfdeIban = !!(tx.tegenpartij_iban && f0.iban && ibanNorm(tx.tegenpartij_iban) === ibanNorm(f0.iban));
  // bedrag en verschil zelf uitrekenen, niet uit opgeslagen details (een voorstel van vóór wv1317 of een heropend voorstel heeft ze niet;
  // diffreview wv1317 MOET 2): wat hier staat is wat David akkordeert
  const betaald = -tx.bedrag_centen, som = facturen.reduce((x, f) => x + teBetalen(f), 0), verschil = som - betaald;
  const verschilTekst = (vs) => 'bedrag ' + eurTekst(Math.abs(vs)) + ' ' + (vs > 0 ? 'lager' : 'hoger') + ' dan ' + (facturen.length > 1 ? 'de facturen samen' : 'de factuur');
  switch (v.methode) {
    case 'kenmerk': waarom.push('het factuurnummer staat in de omschrijving van de betaling' + (verschil ? '; ' + verschilTekst(verschil) :
      facturen.length > 1 ? ' en de facturen tellen precies op tot het bedrag' : ' en het bedrag klopt precies')); break;
    case 'iban_bedrag': waarom.push((zelfdeIban ? 'zelfde rekeningnummer als op de factuur' : 'rekening van deze leverancier') + (verschil ? '; ' + verschilTekst(verschil) : ' en precies hetzelfde bedrag')); break;
    case 'incasso': waarom.push('incasso van deze leverancier' + (verschil ? ', ' + verschilTekst(verschil) + ' (binnen de marge)' : ', zelfde bedrag')); break;
    case 'subset': waarom.push('één betaling voor ' + facturen.length + ' facturen van deze leverancier; ' + (verschil ? verschilTekst(verschil) : 'samen precies het bedrag') +
      (facturen.some(credit) ? ' (een creditnota is verrekend)' : '')); break;
    case 'valuta': waarom.push('factuur in vreemde valuta; omgerekend bedrag binnen 3 %'); break;
    default: break;
  }
  const dz = datumZin(tx, f0);
  if (dz) waarom.push(dz);
  const let_op = [];
  if ((alternatieven || []).length) let_op.push('er staat nog ' + (alternatieven.length === 1 ? 'een factuur' : alternatieven.length + ' facturen') + ' met hetzelfde bedrag open (' +
    alternatieven.map((f) => f.nummer || 'zonder nummer').join(', ') + '); kies je Ja, dan hoort deze betaling bij ' + (f0.nummer || 'de eerste'));
  if (!v.tegenpartij_geborgd && af) let_op.push(f0.leverancier_naam ? (tx.tegenpartij_iban ? 'rekening ' + eind4(tx.tegenpartij_iban) : 'deze tegenpartij') + ' is nog niet als ' +
    (tx.tegenpartij_iban ? 'rekening' : 'incassant') + ' van ' + f0.leverancier_naam + ' bevestigd'
    : 'de leverancier van deze factuur is nog niet bekend; Ja koppelt alleen deze betaling aan deze factuur');
  if (patroon && patroon.aantal) {
    const band = eurTekst(patroon.laag_centen) + (patroon.hoog_centen !== patroon.laag_centen ? ' – ' + eurTekst(patroon.hoog_centen) : '');
    const per = patroon.frequentie && FREQ_TEKST[patroon.frequentie] ? ' ' + FREQ_TEKST[patroon.frequentie] : '';
    waarom.push('gebruikelijk aan deze rekening: ' + band + per + ' (' + patroon.aantal + ' betalingen in 12 maanden)');
    if (patroon.oordeel === 'boven' || patroon.oordeel === 'onder') let_op.push('bedrag ligt ' + (patroon.oordeel === 'boven' ? 'boven' : 'onder') + ' het gebruikelijke (' + band + ')');
  }
  return { zin, waarom, let_op, zekerheid_tekst: zekerheidTekst(Number(v.zekerheid) || 0) };
}
const FREQ_TEKST = { week: 'per week', twee_weken: 'per twee weken', maand: 'per maand', twee_maanden: 'per twee maanden', kwartaal: 'per kwartaal', halfjaar: 'per half jaar', jaar: 'per jaar' };

/*
 * "Wat we deze maand leerden" gegroepeerd en in gewone taal (wv1317: 200 losse regels "Afschrijving zonder factuur: historie_voor_start").
 * groep = { soort, titel, afhandeling, les, aantal }. Interne codes komen nooit in de tekst.
 */
const AFHANDELING_TEKST = {
  historie_voor_start: (n) => n + (n === 1 ? ' afschrijving' : ' afschrijvingen') + ' van vóór de start van de App zonder factuur: genegeerd (oude historie).',
  transactie_verwijderd: (n) => n + (n === 1 ? ' melding verviel' : ' meldingen vervielen') + ': de bankregel was dubbel binnengekomen en is weggehaald.',
};
function leerRegel(g) {
  const n = Number(g.aantal) || 1;
  if (g.les) return n > 1 ? g.les + ' (' + n + '×)' : g.les;
  if (AFHANDELING_TEKST[g.afhandeling]) return AFHANDELING_TEKST[g.afhandeling](n);
  const knop = g.soort && SIGNALEN[g.soort] && SIGNALEN[g.soort].knoppen[g.afhandeling];
  return (g.titel || 'Melding') + ': ' + (knop ? '"' + knop.label + '"' : 'afgehandeld') + (n > 1 ? ' (' + n + '×)' : '') + '.';
}
const VERVAL_TEKST = {
  vooruit: 'de betaling lag ruim vóór de factuurdatum',
  ander_nummer: 'de betaling noemt een ander factuurnummer',
  al_betaald: 'de factuur is al aan een andere betaling gekoppeld',
  andere_betaling: 'een betere betaling kreeg deze factuur',
  weg: 'de bankregel of factuur is er niet meer',
  geen_match: 'bij herbeoordeling past de betaling niet meer bij de factuur',
};
function vervalRegel(reden, n) {
  return n + (n === 1 ? ' koppelvoorstel verviel' : ' koppelvoorstellen vervielen') + ': ' + (VERVAL_TEKST[reden] || VERVAL_TEKST.geen_match) + '.';
}

/*
 * wv1323: feitkaart "rekening …1234 is van <naam>" in gewone taal (David 26-10-2026: "moet heel duidelijk zijn wat ik akkordeer"). k =
 * { iban, naam (wordt de leverancier), bank_naam, namen: [{ naam, aantal }], aantal, eerste, laatste, entiteiten: [naam], facturen:
 * [{ nummer, leverancier_naam, incl, valuta }], leverancier_bestaat (naam of null) }. → { zin, bron, aanleiding, ja, nee }.
 */
function feitUitleg(k) {
  const rek = 'Rekening ' + eind4(k.iban);
  const andere = (k.namen || []).map((n) => n.naam).filter((n) => n !== k.bank_naam);
  const ents = (k.entiteiten || []).filter(Boolean);
  const entTekst = ents.length ? ' vanaf ' + (ents.length > 1 ? ents.slice(0, -1).join(', ') + ' en ' + ents[ents.length - 1] : ents[0]) : '';
  const bron = k.aantal + ' betalingen sinds ' + dagNL(k.eerste) + ' (laatste ' + dagNL(k.laatste) + ')' + entTekst + ', steeds aan ' + k.bank_naam +
    (andere.length ? ' (ook gespeld als ' + andere.slice(0, 3).join(', ') + ')' : '') + '.';
  const fs = (k.facturen || []).filter(Boolean);
  const fTekst = (f) => (f.nummer || 'zonder nummer') + (f.leverancier_naam ? ' van ' + f.leverancier_naam : '') + (Number.isSafeInteger(f.incl) ? ' (' + eurTekst(Math.abs(f.incl)) + ')' : '');
  const aanleiding = (fs.length === 1 ? 'Factuur ' + fTekst(fs[0]) + ' noemt deze rekening; die moet nu eerst nagebeld worden.'
    : fs.length + ' facturen noemen deze rekening (' + fs.slice(0, 3).map(fTekst).join('; ') + (fs.length > 3 ? '; …' : '') + '); die moeten nu eerst nagebeld worden.') +
    (k.zonder_naam ? ' Let op: op ' + (fs.length === 1 ? 'de factuur' : 'een van de facturen') + ' is geen leveranciersnaam herkend; kijk op het stuk of hij van ' + k.naam +
      ' komt. Ja maakt ' + k.naam + ' de leverancier.' : '') +
    (k.nog_onbekend ? ' Let op: er staat nog een andere onbekende rekening op; die blijft nabellen.' : '');
  return {
    zin: rek + ' is van ' + k.naam + '.',
    bron,
    aanleiding,
    ja: 'Ja: ' + (k.leverancier_bestaat ? k.naam + ' krijgt deze rekening erbij' : k.naam + ' wordt een bekende leverancier met deze rekening') +
      '. Facturen met deze rekening hoeven dan niet meer nagebeld te worden, en betalingen eraan worden aan hun factuur gekoppeld. Een betaling onder deze naam aan een ander rekeningnummer wordt voortaan gemeld als mogelijke fraude.',
    nee: 'Nee: er wordt niets vastgelegd en deze kaart komt niet terug; nabellen blijft nodig.',
  };
}

module.exports = {
  BankWeigering, FORMATEN, HISTORIE_FORMATEN, ABN_HISTORIE_KOP, leesAbnHistorie, CATEGORIEEN, RICHTINGEN, SIGNALEN, SIGNAAL_SOORTEN, AUTO_ZEKERHEID, SUBSET_MAX, SUBSET_AUTO_MAX,
  // parsers
  pyStr, mkRef, kenEntryRefsToe, refBasis, saldoControle, normBedrag, herkenFormaat, csvRijen, leesIng, leesTriodos, leesAbnTab, leesAbnMt940, abnIncasso, leesBankbestand, normaliseerBankluis,
  // controle
  uitzonderingVoor, uitzonderingPast, leverancierBijTx, tegenpartijGeborgd, controleVan, matchTransactie, subsetSom, datumFactor, bankcontrole, dubbelGeupload, werkdagenTussen,
  // signalen
  maakSignaal, signaalSleutel, afhandelSignaal, terugvraagTekst,
  // uitleg (wv1317)
  VOORUIT_MARGE, vooruitBetaald, andereFactuurGenoemd, referentieStukken, voorstelSleutel, voorstelUitleg, zekerheidTekst, leerRegel, vervalRegel, VERVAL_TEKST,
  // feitkaarten (wv1323)
  feitUitleg,
};
