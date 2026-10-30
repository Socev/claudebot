'use strict';
/*
 * Facturen-app — creditcard (ICS) als bron naast de bank (wv2043, 30-10-2026). David: "Hier is de transactielijst van ICS, vanaf 01-01-2026".
 * Op de zakelijke rekening staat per maand één ICS-incasso; dit bestand maakt zichtbaar welke betalingen erin zitten en sluit ze per
 * rekeningoverzicht aan op die incasso. Opslag: migratie 13 in facturen-db.js (kaart, kaart_bestand, kaart_regel, kaart_incasso).
 *
 * Deel 1 is puur (lezen, sleutels, handelaar, herkenning, aansluiting): geen bestand, netwerk, proces of klok. Deel 2 werkt op een open
 * facturen-database (fdb) via facturen-db.js: inlezen (idempotent op regel), koppelen (leverancier, factuur, bankincasso), lezen voor de
 * skill facturen-lezen (/smal/facturen opdracht creditcard) en de betaalwijze per leverancier. Schrijven doet alleen de machinekamer via
 * tools/facturen-creditcard.js; de leesroute schrijft nooit.
 *
 * Het ICS-overzicht (CSV, ;-gescheiden, UTF-8 met BOM): Transactiedatum; Boekingsdatum; Omschrijving; Naam Card-houder; Card nummer
 * (gemaskeerd ****1234); Debit/Credit; Bedrag (komma, in euro, credit met min); Merchant categorie; Land; Valuta; Bedrag in oorspronkelijke
 * valuta; Type transactie (Transaction/Payment/Authorization); WalletProvider; Merchant categorie code; Maand/jaar rekeningoverzicht
 * (JJJJMM). Naam Card-houder wordt niet bewaard. Een volledig kaartnummer komt er nooit in: de lezer weigert het hele bestand bij een
 * kaartnummer dat niet gemaskeerd is of een lange cijferreeks (≥ 13) in een veld.
 *
 * Aansluiting per overzicht M: transacties(M) = som van de transactieregels met overzicht M (+ = uitgave); ICS-betaald(M) = min de som van
 * de betaalregels op overzicht M+1 (GEINCASSEERD VORIG SALDO, GEWEIGERDE INCASSO, HER-INCASSO); bank(M) = min de som van de bankregels die
 * aan M gekoppeld zijn (kaart_incasso). Sluit = transacties(M) = bank(M), tolerantie 0. Het vroegste overzicht kan onvolledig zijn (het
 * bestand begint midden in die periode); een overzicht zonder bankregel is nog niet geïncasseerd.
 */
const crypto = require('crypto');
const K = require('./facturen-kern.js');
const D = require('./facturen-db.js');

class KaartFout extends Error {
  constructor(code, uitleg, extra) { super(uitleg || code); this.code = code; this.uitleg = uitleg || code; Object.assign(this, extra || {}); }
}

// ───────────────────────────── deel 1: puur ─────────────────────────────

const ICS_KOPPEN = ['Transactiedatum', 'Boekingsdatum', 'Omschrijving', 'Naam Card-houder', 'Card nummer', 'Debit/Credit', 'Bedrag',
  'Merchant categorie', 'Land', 'Valuta', 'Bedrag in oorspronkelijke valuta', 'Type transactie', 'WalletProvider', 'Merchant categorie code',
  'Maand/jaar rekeningoverzicht'];
const SOORT = { Transaction: 'transactie', Payment: 'betaling', Authorization: 'autorisatie' };
const LANG_GETAL = /\d{13,}/;   // een kaartnummer (13–19 cijfers), ook als het ergens anders in een veld staat
const MAANDEN = { jan: 1, feb: 2, mrt: 3, maa: 3, apr: 4, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12 };

// Eén regel ;-gescheiden met "…" (verdubbelde " binnen aanhalingstekens).
function splitsRegel(s) {
  const uit = []; let v = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { v += '"'; i++; } else q = false; } else v += c; }
    else if (c === '"') q = true;
    else if (c === ';') { uit.push(v); v = ''; }
    else v += c;
  }
  if (q) return null;
  uit.push(v);
  return uit;
}
function datumNl(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const iso = m[3] + '-' + m[2] + '-' + m[1];
  return K.isIsoDatum(iso) ? iso : null;
}
// "1.234,56" / "-89,99" / "0,00" → centen (exact). Een punt zonder komma is geen ICS-bedrag.
function bedragNl(s) {
  const t = String(s == null ? '' : s).trim();
  if (!/^-?\d{1,3}(\.?\d{3})*,\d{2}$/.test(t)) return null;
  return K.decimaalNaarCenten(t.replace(/\./g, '').replace(',', '.'));
}
function maandUitIcs(s) {
  const m = /^(\d{4})(\d{2})$/.exec(String(s || '').trim());
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return m[1] + '-' + m[2];
}
function volgendeMaand(m) {
  const j = Number(m.slice(0, 4)), n = Number(m.slice(5, 7));
  return n === 12 ? (j + 1) + '-01' : j + '-' + String(n + 1).padStart(2, '0');
}

/*
 * Leest een ICS-overzicht (CSV). → { regels: [{ soort, transactiedatum, boekdatum, omschrijving, bedrag_centen, valuta_orig, bedrag_orig_centen,
 * merchant_categorie, mcc, land, overzicht, laatste4 }], periode: { van, tot }, aantallen }. Weigert (KaartFout) het hele bestand bij een
 * andere kop, een onleesbare regel, een onbekende soort of een kaartnummer dat niet gemaskeerd is: niets half.
 */
function leesIcsCsv(bytes) {
  const tekst = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes || '');
  const regels = tekst.replace(/^﻿/, '').split(/\r?\n/).filter((r) => r.trim() !== '');
  if (!regels.length) throw new KaartFout('leeg', 'leeg bestand');
  const kop = splitsRegel(regels[0]);
  if (!kop || kop.length !== ICS_KOPPEN.length || kop.some((k, i) => k.trim() !== ICS_KOPPEN[i])) {
    throw new KaartFout('formaat', 'geen ICS-transactieoverzicht (de kolommen wijken af)');
  }
  const uit = [];
  for (let i = 1; i < regels.length; i++) {
    const v = splitsRegel(regels[i]);
    const nr = i + 1;
    if (!v || v.length !== ICS_KOPPEN.length) throw new KaartFout('regel', 'regel ' + nr + ': aantal kolommen klopt niet', { regel: nr });
    if (v.some((x) => LANG_GETAL.test(x.replace(/[\s.-]/g, '')))) throw new KaartFout('kaartnummer', 'regel ' + nr + ': een lange cijferreeks (kaartnummer?): bestand geweigerd', { regel: nr });
    const kaart = v[4].trim();
    if (kaart !== '' && !/^\*{4,12}\d{4}$/.test(kaart)) throw new KaartFout('kaartnummer', 'regel ' + nr + ': kaartnummer niet gemaskeerd', { regel: nr });
    const soort = SOORT[v[11].trim()];
    if (!soort) throw new KaartFout('regel', 'regel ' + nr + ': onbekende soort', { regel: nr });
    const td = datumNl(v[0]), bd = v[1].trim() ? datumNl(v[1]) : null;
    if (!td || (v[1].trim() && !bd)) throw new KaartFout('regel', 'regel ' + nr + ': datum onleesbaar', { regel: nr });
    const bedrag = bedragNl(v[6]);
    if (bedrag == null) throw new KaartFout('regel', 'regel ' + nr + ': bedrag onleesbaar', { regel: nr });
    const dc = v[5].trim();
    if (!['D', 'C'].includes(dc) || (dc === 'D' && bedrag < 0) || (dc === 'C' && bedrag > 0)) throw new KaartFout('regel', 'regel ' + nr + ': debet/credit past niet bij het bedrag', { regel: nr });
    const valuta = v[9].trim().toUpperCase() || null;
    if (valuta && !/^[A-Z]{3}$/.test(valuta)) throw new KaartFout('regel', 'regel ' + nr + ': valuta onleesbaar', { regel: nr });
    const orig = v[10].trim() ? bedragNl(v[10]) : null;
    if (v[10].trim() && orig == null) throw new KaartFout('regel', 'regel ' + nr + ': oorspronkelijk bedrag onleesbaar', { regel: nr });
    if (valuta === 'EUR' && orig != null && orig !== bedrag) throw new KaartFout('regel', 'regel ' + nr + ': eurobedrag wijkt af van het oorspronkelijke', { regel: nr });
    const overzicht = v[14].trim() ? maandUitIcs(v[14]) : null;
    if (v[14].trim() && !overzicht) throw new KaartFout('regel', 'regel ' + nr + ': maand van het rekeningoverzicht onleesbaar', { regel: nr });
    if (soort !== 'autorisatie' && !overzicht) throw new KaartFout('regel', 'regel ' + nr + ': geboekte regel zonder rekeningoverzicht', { regel: nr });
    const oms = K.schoon(v[2]).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!oms) throw new KaartFout('regel', 'regel ' + nr + ': omschrijving leeg', { regel: nr });
    const mcc = v[13].trim();
    const land = v[8].trim().toUpperCase();
    uit.push({
      soort, transactiedatum: td, boekdatum: bd, omschrijving: oms, bedrag_centen: bedrag, valuta_orig: valuta, bedrag_orig_centen: orig,
      merchant_categorie: v[7].trim().slice(0, 100) || null, mcc: /^\d{4}$/.test(mcc) ? mcc : null, land: /^[A-Z]{2,3}$/.test(land) ? land : null,
      overzicht: soort === 'autorisatie' ? null : overzicht, laatste4: kaart ? kaart.slice(-4) : null,
    });
  }
  const datums = uit.map((r) => r.transactiedatum).sort();
  const aantallen = { transactie: 0, betaling: 0, autorisatie: 0 };
  for (const r of uit) aantallen[r.soort]++;
  return { regels: uit, periode: { van: datums[0] || null, tot: datums[datums.length - 1] || null }, aantallen };
}

/*
 * Sleutel per regel: sha256 van de kaart, alle bewaarde velden en het volgnummer onder precies gelijke regels in dit bestand (twee keer
 * € 5 bij dezelfde winkel op dezelfde dag zijn twee regels). Een later overzicht dat dezelfde dagen bevat, geeft dezelfde sleutels zolang
 * het alle regels van die dag bevat (ICS exporteert per hele dag).
 */
function sleutels(kaartId, regels) {
  const tel = new Map();
  return regels.map((r) => {
    const basis = [kaartId, r.soort, r.transactiedatum, r.boekdatum || '', r.omschrijving, r.bedrag_centen, r.valuta_orig || '', r.bedrag_orig_centen == null ? '' : r.bedrag_orig_centen,
      r.overzicht || '', r.laatste4 || ''].join('|');
    const n = (tel.get(basis) || 0) + 1;
    tel.set(basis, n);
    return Object.assign({}, r, { sleutel: crypto.createHash('sha256').update(basis + '|' + n).digest('hex') });
  });
}

// De handelaar uit de ICS-omschrijving ("NAAM PLAATS LND", spaties ingeklapt): wat vóór een * staat ("ANTHROPIC* CLAUDE SUB" → ANTHROPIC),
// anders het eerste woord (met het tweede erbij als het eerste hooguit 3 tekens heeft: "IE TAB", "EV CHARGE"). Plaatsnamen zijn niet
// betrouwbaar af te splitsen; voor de herkenning telt alleen het begin. Betalingen en de jaarbijdrage zijn van ICS zelf.
const ALIAS = { CLAUDE: 'ANTHROPIC' };   // "CLAUDE.AI SUBSCRIPTION" is het abonnement van Anthropic
function handelaar(omschrijving, soort) {
  const s = String(omschrijving || '').replace(/\s+/g, ' ').trim();
  if (soort === 'betaling' || /^JAARBIJDRAGE\b/i.test(s)) return 'ICS';
  const ster = s.indexOf('*');
  let w = (ster > 0 ? s.slice(0, ster) : s.replace(/ [A-Z]{3}$/, '')).trim().split(' ').filter(Boolean);
  if (!w.length) return null;
  w = ster > 0 ? w : w[0].replace(/[^A-Za-z0-9]/g, '').length <= 3 && w.length > 1 ? w.slice(0, 2) : w.slice(0, 1);
  let h = w.join(' ');
  const kop = h.split(/[^A-Za-z0-9]/)[0].toUpperCase();
  if (ALIAS[kop]) h = ALIAS[kop];
  return h.slice(0, 100) || null;
}

const LAND_WOORD = { IRL: 'ireland', GBR: 'uk', NLD: 'nederland', DEU: 'deutschland', USA: null };
function eersteWoord(s) { return K.normNaam(s).split(' ').filter(Boolean)[0] || ''; }
/*
 * Leverancier bij een handelaar. Kandidaten: het eerste woord van de handelaar (≥ 4 tekens, zonder leestekens) is het eerste woord van de
 * leverancier, of de handelaar aaneen ("ELEVENLABS.IO" → elevenlabsio) begint met de eerste twee woorden aaneen (≥ 6 tekens: eleven labs).
 * Meer dan één leverancier: het land beslist (IRL → de naam met "ireland"); blijft het meer dan één, dan geen (onzeker is geen koppeling).
 * leveranciers = [{ id, naam, genormaliseerd }]. → { leverancier, via } of { leverancier: null, kandidaten }.
 */
function zoekLeverancier(hand, land, leveranciers) {
  const h = K.normNaam(hand), w = h.split(' ').filter(Boolean);
  if (!w.length) return { leverancier: null, kandidaten: [] };
  const eerste = w[0].replace(/[^a-z0-9]/g, ''), aaneen = h.replace(/ /g, '');
  const kand = [];
  for (const l of leveranciers || []) {
    const g = String(l.genormaliseerd || K.normNaam(l.naam)).split(' ').filter(Boolean);
    if (!g.length) continue;
    const een = g[0], twee = g.slice(0, 2).join('');
    if ((eerste.length >= 4 && een === eerste) || (g.length >= 2 && twee.length >= 6 && aaneen.startsWith(twee))) kand.push(l);
  }
  if (kand.length === 1) return { leverancier: kand[0], via: 'naam' };
  if (kand.length > 1) {
    const woord = land ? LAND_WOORD[land] : undefined;
    const metLand = woord ? kand.filter((l) => K.normNaam(l.naam).split(' ').includes(woord)) : [];
    if (metLand.length === 1) return { leverancier: metLand[0], via: 'naam+land' };
    const landen = Object.values(LAND_WOORD).filter(Boolean);
    const zonder = kand.filter((l) => !K.normNaam(l.naam).split(' ').some((x) => landen.includes(x)));
    if (woord === null && zonder.length === 1) return { leverancier: zonder[0], via: 'naam+land' };
  }
  return { leverancier: null, kandidaten: kand.map((l) => l.id) };
}

/*
 * Factuur bij een kaartregel: zelfde bedrag (euro, of de oorspronkelijke valuta en dat bedrag), factuurdatum hooguit 10 dagen ervoor of
 * 5 dagen erna, en de leverancier (id) of de naam (het eerste woord van de handelaar staat in de leveranciersnaam van de factuur). Precies
 * één kandidaat, anders geen. facturen = [{ id, bron: 'factuur'|'archief', leverancier, leverancier_naam, factuurdatum, incl, valuta }].
 */
function zoekFactuur(r, levId, facturen) {
  if (r.soort !== 'transactie' || !(r.bedrag_centen > 0)) return null;
  const woord = eersteWoord(r.handelaar).replace(/[^a-z0-9]/g, '');
  const kand = (facturen || []).filter((f) => {
    if (!f.factuurdatum || f.incl == null) return false;
    const d = K.dagenTussen(f.factuurdatum, r.transactiedatum);
    if (d == null || d < -5 || d > 10) return false;
    // het FV2-archief zette bij een buitenlandse factuur soms EUR bij het dollarbedrag (gemeten 30-10: Supabase 39,70 'EUR' = 39,70 USD op de kaart)
    const bedrag = (f.valuta || 'EUR') === 'EUR' ? (f.incl === r.bedrag_centen || (f.bron === 'archief' && r.valuta_orig && r.valuta_orig !== 'EUR' && f.incl === r.bedrag_orig_centen))
      : (f.valuta === r.valuta_orig && f.incl === r.bedrag_orig_centen);
    if (!bedrag) return false;
    if (levId && f.leverancier === levId) return true;
    return woord.length >= 4 && K.compactNaam(f.leverancier_naam || '').indexOf(woord) >= 0;
  });
  return kand.length === 1 ? kand[0] : null;
}

// Het overzicht dat een bankregel betaalt, uit de omschrijving ("Incasso okt 2026 betreffende uw creditcard ICS-klantnummer …", ook in
// de correctieboeking na /REMI/). Alleen als het klantnummer van de kaart erin staat. → 'JJJJ-MM' of null.
function incassoOverzicht(omschrijving, klantnummer) {
  const s = String(omschrijving || '');
  if (!klantnummer || s.indexOf('ICS-klantnummer ' + klantnummer) < 0) return null;
  const m = /Incasso\s+([a-z]{3})[a-z]*\s+(\d{4})/i.exec(s);
  if (!m || !MAANDEN[m[1].toLowerCase()]) return null;
  return m[2] + '-' + String(MAANDEN[m[1].toLowerCase()]).padStart(2, '0');
}
function isKaartBankregel(omschrijving, klantnummer) {
  return !!klantnummer && String(omschrijving || '').indexOf('ICS-klantnummer ' + klantnummer) >= 0;
}

/*
 * Aansluiting per overzicht. regels = kaartregels (soort, overzicht, bedrag_centen); bank = [{ overzicht, bedrag_centen }] (bankteken:
 * - = afschrijving). → [{ overzicht, transacties_centen, regels, ics_betaald_centen, bank_centen, bankregels, status, verschil_centen }]
 * status: sluit · verschil · onvolledig_begin (het vroegste overzicht; het bestand begint in die periode) · nog_niet_geincasseerd ·
 * buiten_bestand (wel een bankregel, geen kaartregels: vóór het bestand).
 */
function aansluiting(regels, bank) {
  const per = new Map();
  const m = (o) => { if (!per.has(o)) per.set(o, { overzicht: o, transacties_centen: 0, regels: 0, ics_betaling: null, bank_centen: 0, bankregels: 0 }); return per.get(o); };
  const betalingen = new Map();
  for (const r of regels) {
    if (r.soort === 'transactie') { const x = m(r.overzicht); x.transacties_centen += r.bedrag_centen; x.regels++; }
    else if (r.soort === 'betaling') betalingen.set(r.overzicht, (betalingen.get(r.overzicht) || 0) + r.bedrag_centen);
  }
  const metRegels = new Set(per.keys());
  for (const b of bank) { const x = m(b.overzicht); x.bank_centen -= b.bedrag_centen; x.bankregels++; }
  const vroegste = Array.from(metRegels).sort()[0] || null;
  const uit = [];
  for (const x of Array.from(per.values()).sort((a, b) => (a.overzicht < b.overzicht ? -1 : 1))) {
    const volgende = volgendeMaand(x.overzicht);
    const ics = betalingen.has(volgende) ? -betalingen.get(volgende) : null;
    let status;
    if (!metRegels.has(x.overzicht)) status = 'buiten_bestand';
    else if (!x.bankregels) status = 'nog_niet_geincasseerd';
    else if (x.transacties_centen === x.bank_centen) status = 'sluit';
    else status = x.overzicht === vroegste ? 'onvolledig_begin' : 'verschil';
    uit.push({ overzicht: x.overzicht, transacties_centen: x.transacties_centen, regels: x.regels, ics_betaald_centen: ics, bank_centen: x.bankregels ? x.bank_centen : null,
      bankregels: x.bankregels, status, verschil_centen: x.bankregels && metRegels.has(x.overzicht) ? x.bank_centen - x.transacties_centen : null,
      ics_bank_gelijk: ics == null || !x.bankregels ? null : ics === x.bank_centen });
  }
  return uit;
}

// ───────────────────────────── deel 2: op de database ─────────────────────────────

function nuIso(nu) { return new Date(nu).toISOString(); }
function kaartVan(fdb, wie) {
  const s = String(wie == null ? '' : wie).trim();
  const lijst = fdb.db.prepare('SELECT * FROM kaart').all();
  const k = s ? lijst.filter((x) => x.id === s || x.laatste4 === s) : lijst;
  if (k.length !== 1) throw new KaartFout(k.length ? 'kaart_meer' : 'kaart_onbekend', k.length ? 'meer dan één kaart: noem de laatste 4 cijfers' : 'geen kaart gevonden');
  return k[0];
}
// Een kaart vastleggen (machinekamer). invoer = { klantnummer, laatste4, rekening (id of laatste 4 van het IBAN), naam?, wie, nu }.
function kaartZet(fdb, o) {
  const rek = fdb.db.prepare('SELECT id, entiteit, iban FROM rekening').all().filter((r) => r.id === o.rekening || r.iban.slice(-4) === String(o.rekening || ''));
  if (rek.length !== 1) throw new KaartFout('rekening', 'rekening niet (eenduidig) gevonden');
  return D.transactie(fdb, () => {
    const b = fdb.db.prepare('SELECT * FROM kaart WHERE klantnummer = ?').get(String(o.klantnummer));
    if (b) return { id: b.id, al_bekend: true };
    const id = D.nieuwId(), wanneer = nuIso(o.nu);
    D.voegToe(fdb, 'kaart', { id, uitgever: 'ICS', klantnummer: String(o.klantnummer), laatste4: String(o.laatste4), entiteit: rek[0].entiteit, rekening: rek[0].id,
      naam: o.naam ? String(o.naam).slice(0, 100) : null, aangemaakt_door: o.wie, aangemaakt_op: wanneer });
    D.audit(fdb, { wie: o.wie, wat: 'kaart_maken', object_soort: 'kaart', object_id: id, entiteit: rek[0].entiteit, na: { uitgever: 'ICS', laatste4: String(o.laatste4) }, wanneer });
    return { id, al_bekend: false };
  });
}

/*
 * Een ICS-overzicht inlezen voor een kaart. opties = { droog, wie, herkomst, nu, naam }. Hetzelfde bestand (sha256) → al_bekend; een regel
 * die al binnen is (sleutel) → overgeslagen. Het ruwe bestand gaat naar bankbron/ (offsite versleuteld met de bankexports). Daarna koppelen.
 * → { al_bekend, droog, periode, aantallen, nieuw, al_bekend_regels, bestand, koppeling }.
 */
function inlezen(fdb, kaartWie, bytes, opties) {
  const o = opties || {};
  const nu = Number.isFinite(o.nu) ? o.nu : Date.now();
  const kaart = kaartVan(fdb, kaartWie);
  const g = leesIcsCsv(bytes);
  const anders = g.regels.filter((r) => r.laatste4 && r.laatste4 !== kaart.laatste4).length;
  if (anders) throw new KaartFout('andere_kaart', anders + ' regel(s) van een andere kaart dan …' + kaart.laatste4 + ': bestand geweigerd');
  const regels = sleutels(kaart.id, g.regels);
  const sha = D.sha256(bytes);
  const bekend = fdb.db.prepare('SELECT 1 FROM kaart_regel WHERE sleutel = ?');
  const nieuw = regels.filter((r) => !bekend.get(r.sleutel));
  const uit = { droog: !!o.droog, periode: g.periode, aantallen: g.aantallen, regels: regels.length, nieuw: nieuw.length, al_bekend_regels: regels.length - nieuw.length };
  const best = fdb.db.prepare('SELECT id FROM kaart_bestand WHERE sha256 = ?').get(sha);
  if (best) return Object.assign(uit, { al_bekend: true, bestand: best.id, nieuw: 0, al_bekend_regels: regels.length });
  if (o.droog) return Object.assign(uit, { al_bekend: false });
  const bron = D.bronSchrijf(fdb, bytes);
  const wanneer = nuIso(nu), id = D.nieuwId();
  D.transactie(fdb, () => {
    D.voegToe(fdb, 'kaart_bestand', { id, kaart: kaart.id, sha256: sha, formaat: 'ics_csv', naam: o.naam ? String(o.naam).slice(0, 255) : null,
      periode_van: g.periode.van, periode_tot: g.periode.tot, aantal: regels.length, nieuw: nieuw.length, bron_bewaard: bron && bron.sha256 === sha ? 1 : 0,
      herkomst: o.herkomst ? String(o.herkomst).slice(0, 300) : null, geupload_door: o.wie, geupload_op: wanneer });
    for (const r of nieuw) {
      D.voegToe(fdb, 'kaart_regel', { id: D.nieuwId(), kaart: kaart.id, bestand: id, sleutel: r.sleutel, soort: r.soort, transactiedatum: r.transactiedatum,
        boekdatum: r.boekdatum, omschrijving: r.omschrijving, bedrag_centen: r.bedrag_centen, valuta_orig: r.valuta_orig, bedrag_orig_centen: r.bedrag_orig_centen,
        merchant_categorie: r.merchant_categorie, mcc: r.mcc, land: r.land, overzicht: r.overzicht, laatste4: r.laatste4, handelaar: handelaar(r.omschrijving, r.soort),
        aangemaakt_op: wanneer });
    }
    D.audit(fdb, { wie: o.wie, wat: 'kaart_inlezen', object_soort: 'kaart_bestand', object_id: id, entiteit: kaart.entiteit,
      na: { regels: regels.length, nieuw: nieuw.length, periode: g.periode, aantallen: g.aantallen, bron_bewaard: true }, wanneer });
  });
  const koppeling = koppel(fdb, kaart.id, { nu, wie: o.wie });
  return Object.assign(uit, { al_bekend: false, bestand: id, koppeling });
}

/*
 * Koppelen (herhaalbaar): (1) bankregels met het klantnummer van de kaart op de rekening van de kaart → kaart_incasso met het overzicht
 * uit de omschrijving, of anders het overzicht van de dichtstbijzijnde betaalregel (± 5 dagen, overzicht min 1); (2) per transactieregel
 * zonder leverancier of factuur: herkennen. Bestaande koppelingen blijven staan. → aantallen.
 */
function koppel(fdb, kaartId, opties) {
  const o = opties || {};
  const nu = Number.isFinite(o.nu) ? o.nu : Date.now();
  const wanneer = nuIso(nu);
  const kaart = fdb.db.prepare('SELECT * FROM kaart WHERE id = ?').get(kaartId);
  if (!kaart) throw new KaartFout('kaart_onbekend', 'kaart niet gevonden');
  const uit = { incasso_nieuw: 0, incasso_onbekend: 0, leverancier_nieuw: 0, factuur_nieuw: 0 };
  const levs = fdb.db.prepare('SELECT id, naam, genormaliseerd FROM leverancier').all();
  const facturen = fdb.db.prepare("SELECT id, 'factuur' AS bron, leverancier, leverancier_naam, factuurdatum, incl, valuta FROM factuur WHERE soort = 'factuur'").all()
    .concat(fdb.db.prepare("SELECT id, 'archief' AS bron, NULL AS leverancier, leverancier_naam, factuurdatum, incl, valuta FROM factuur_archief").all());
  D.transactie(fdb, () => {
    const betaal = fdb.db.prepare("SELECT transactiedatum, overzicht FROM kaart_regel WHERE kaart = ? AND soort = 'betaling'").all(kaart.id);
    const bank = fdb.db.prepare("SELECT t.id, t.boekdatum, t.omschrijving FROM bank_transactie t WHERE t.rekening = ? AND t.verwijderd_op IS NULL AND instr(t.omschrijving, ?) > 0 AND NOT EXISTS (SELECT 1 FROM kaart_incasso k WHERE k.transactie = t.id)")
      .all(kaart.rekening, 'ICS-klantnummer ' + kaart.klantnummer);
    const zet = fdb.db.prepare('INSERT INTO kaart_incasso (transactie, kaart, overzicht, methode, wie, wanneer) VALUES (?, ?, ?, ?, ?, ?)');
    for (const t of bank) {
      let ov = incassoOverzicht(t.omschrijving, kaart.klantnummer), methode = 'omschrijving';
      if (!ov) {
        const dicht = betaal.map((b) => ({ b, d: Math.abs(K.dagenTussen(t.boekdatum, b.transactiedatum)) })).filter((x) => x.d <= 5).sort((a, b) => a.d - b.d);
        const ovs = new Set(dicht.filter((x) => x.d === (dicht[0] || {}).d).map((x) => x.b.overzicht));
        if (ovs.size === 1) { const v = Array.from(ovs)[0]; ov = vorigeMaand(v); methode = 'datum'; }
      }
      if (!ov) { uit.incasso_onbekend++; continue; }
      zet.run(t.id, kaart.id, ov, methode, o.wie, wanneer);
      uit.incasso_nieuw++;
    }
    const open = fdb.db.prepare("SELECT * FROM kaart_regel WHERE kaart = ? AND soort = 'transactie' AND (leverancier IS NULL OR (factuur IS NULL AND factuur_archief IS NULL))").all(kaart.id);
    const bezet = new Set(fdb.db.prepare('SELECT factuur AS f FROM kaart_regel WHERE factuur IS NOT NULL UNION SELECT factuur_archief FROM kaart_regel WHERE factuur_archief IS NOT NULL').all().map((x) => x.f));
    const upd = fdb.db.prepare('UPDATE kaart_regel SET leverancier = ?, factuur = ?, factuur_archief = ?, koppeling_op = ? WHERE id = ?');
    for (const r of open) {
      let lev = r.leverancier;
      if (!lev) { const z = zoekLeverancier(r.handelaar, r.land, levs); if (z.leverancier) { lev = z.leverancier.id; uit.leverancier_nieuw++; } }
      let fac = r.factuur, arch = r.factuur_archief;
      if (!fac && !arch) {
        const f = zoekFactuur(r, lev, facturen.filter((x) => !bezet.has(x.id)));
        if (f) {
          if (f.bron === 'factuur') fac = f.id; else arch = f.id;
          bezet.add(f.id); uit.factuur_nieuw++;
          if (!lev && f.leverancier) { lev = f.leverancier; uit.leverancier_nieuw++; }
        }
      }
      if (lev !== r.leverancier || fac !== r.factuur || arch !== r.factuur_archief) upd.run(lev, fac, arch, wanneer, r.id);
    }
    if (uit.incasso_nieuw || uit.leverancier_nieuw || uit.factuur_nieuw) {
      D.audit(fdb, { wie: o.wie, wat: 'kaart_koppelen', object_soort: 'kaart', object_id: kaart.id, entiteit: kaart.entiteit, na: uit, wanneer });
    }
  });
  return uit;
}
function vorigeMaand(m) {
  const j = Number(m.slice(0, 4)), n = Number(m.slice(5, 7));
  return n === 1 ? (j - 1) + '-12' : j + '-' + String(n - 1).padStart(2, '0');
}

function aansluitingDb(fdb, kaart) {
  const regels = fdb.db.prepare("SELECT soort, overzicht, bedrag_centen FROM kaart_regel WHERE kaart = ? AND soort <> 'autorisatie'").all(kaart.id);
  const bank = fdb.db.prepare('SELECT k.overzicht, t.bedrag_centen FROM kaart_incasso k JOIN bank_transactie t ON t.id = k.transactie WHERE k.kaart = ? AND t.verwijderd_op IS NULL').all(kaart.id);
  return aansluiting(regels, bank);
}

/*
 * Betaalwijze per leverancier (voor de regels van wv2031: "altijd creditcard = niets te betalen"). Per leverancier met kaartregels: aantal en
 * totaal op de kaart, afschrijvingen op de zakelijke rekeningen in de laatste 365 dagen met een verwante naam (ICS zelf niet), en de huidige
 * standaard. voorstel 'betaald' (= in de Facturen-app: al betaald, bijv. creditcard) alleen als er geen bankbetaling is en er nog geen
 * standaard staat; met een bankbetaling 'wisselend'. opties.zet: het voorstel vastleggen (alleen waar standaard leeg is; auditrij).
 */
function betaalwijze(fdb, kaart, opties) {
  const o = opties || {};
  const nu = Number.isFinite(o.nu) ? o.nu : Date.now();
  const vanaf = K.plusDagen(new Date(nu).toISOString().slice(0, 10), -365);
  const per = fdb.db.prepare("SELECT r.leverancier, l.naam, l.standaard_betaalwijze, count(*) AS n, sum(r.bedrag_centen) AS totaal, max(r.transactiedatum) AS laatste FROM kaart_regel r JOIN leverancier l ON l.id = r.leverancier WHERE r.kaart = ? AND r.soort = 'transactie' GROUP BY r.leverancier ORDER BY totaal DESC").all(kaart.id);
  const bank = fdb.db.prepare("SELECT tegenpartij_naam, omschrijving FROM bank_transactie WHERE bedrag_centen < 0 AND boekdatum >= ? AND verwijderd_op IS NULL AND entiteit <> 'prive'").all(vanaf)
    .filter((t) => !isKaartBankregel(t.omschrijving, kaart.klantnummer));
  const uit = per.map((p) => {
    const eerste = K.normNaam(p.naam).split(' ')[0] || '';
    const n = eerste.length >= 4 ? bank.filter((t) => K.normNaam(t.tegenpartij_naam || '').split(' ')[0] === eerste).length : 0;
    const voorstel = p.standaard_betaalwijze ? (p.standaard_betaalwijze === 'betaald' ? 'staat_al' : 'andere_standaard') : (n ? 'wisselend' : 'betaald');
    return { leverancier: p.leverancier, naam: p.naam, kaartregels: p.n, totaal_centen: p.totaal, laatste: p.laatste, bank_365: n, standaard: p.standaard_betaalwijze, voorstel };
  });
  if (o.zet) {
    const wanneer = nuIso(nu);
    D.transactie(fdb, () => {
      const upd = fdb.db.prepare("UPDATE leverancier SET standaard_betaalwijze = 'betaald', bijgewerkt_op = ? WHERE id = ? AND standaard_betaalwijze IS NULL");
      for (const x of uit.filter((x) => x.voorstel === 'betaald')) {
        if (upd.run(wanneer, x.leverancier).changes !== 1) continue;
        x.gezet = true;
        D.audit(fdb, { wie: o.wie, wat: 'leverancier_bijwerken', object_soort: 'leverancier', object_id: x.leverancier, voor: { standaard_betaalwijze: null },
          na: { standaard_betaalwijze: 'betaald', reden: 'creditcard …' + kaart.laatste4 + ' (' + x.kaartregels + ' regels, geen bankbetaling in 365 dagen)' }, wanneer });
      }
    });
  }
  return uit;
}

/*
 * Lezen voor de skill facturen-lezen (/smal/facturen, opdracht creditcard). d = { weergave: 'aansluiting'|'regels'|'leveranciers' (standaard
 * aansluiting), maand (JJJJ-MM, overzicht), sinds, tot (transactiedatum), tekst (handelaar of leverancier), kaart (laatste 4), max }.
 * Alleen lezen; geen klantnummer of kaartnummer in de uitvoer (alleen de laatste 4).
 */
function lees(fdb, d) {
  d = d || {};
  const kaarten = fdb.db.prepare('SELECT k.*, r.iban FROM kaart k JOIN rekening r ON r.id = k.rekening').all();
  if (!kaarten.length) return { kaarten: [], uitleg: 'nog geen creditcard ingelezen' };
  const kaart = d.kaart ? kaarten.find((k) => k.laatste4 === String(d.kaart)) : kaarten.length === 1 ? kaarten[0] : null;
  if (!kaart) throw new KaartFout('kaart', 'noem de kaart (laatste 4 cijfers): ' + kaarten.map((k) => k.laatste4).join(', '));
  const best = fdb.db.prepare('SELECT min(periode_van) AS van, max(periode_tot) AS tot, count(*) AS n, max(geupload_op) AS laatste FROM kaart_bestand WHERE kaart = ?').get(kaart.id);
  const kop = { kaart: { uitgever: kaart.uitgever, laatste4: kaart.laatste4, entiteit: kaart.entiteit, rekening: '…' + kaart.iban.slice(-4) },
    bestanden: { aantal: best.n, van: best.van, tot: best.tot, laatst_ingelezen: best.laatste } };
  const weergave = ['aansluiting', 'regels', 'leveranciers'].includes(d.weergave) ? d.weergave : 'aansluiting';
  const max = Math.min(Math.max(Number(d.max) || 100, 1), 500);
  if (weergave === 'aansluiting') {
    const alle = aansluitingDb(fdb, kaart);
    const buiten = alle.filter((x) => x.status === 'buiten_bestand');
    let a = alle.filter((x) => x.status !== 'buiten_bestand');
    if (d.maand) a = a.filter((x) => x.overzicht === String(d.maand));
    return Object.assign(kop, { weergave, aansluiting: a,
      buiten_bestand: buiten.length ? { overzichten: buiten.length, van: buiten[0].overzicht, tot: buiten[buiten.length - 1].overzicht,
        bank_centen: buiten.reduce((s, x) => s + x.bank_centen, 0), uitleg: 'incasso\'s op de bank van vóór het eerste ingelezen overzicht (geen kaartregels)' } : null,
      uitleg: 'per rekeningoverzicht: transacties = som van de kaartregels (euro); bank = de ICS-incasso(s) op de rekening voor dat overzicht; ics_betaald = wat ICS op het volgende overzicht als betaald boekt. sluit = transacties en bank gelijk (op de cent).' });
  }
  if (weergave === 'leveranciers') return Object.assign(kop, { weergave, leveranciers: betaalwijze(fdb, kaart, {}).slice(0, max) });
  const w = ['r.kaart = ?'], p = [kaart.id];
  if (d.maand) { w.push('r.overzicht = ?'); p.push(String(d.maand)); }
  if (d.sinds && K.isIsoDatum(d.sinds)) { w.push('r.transactiedatum >= ?'); p.push(d.sinds); }
  if (d.tot && K.isIsoDatum(d.tot)) { w.push('r.transactiedatum <= ?'); p.push(d.tot); }
  if (d.soort && ['transactie', 'betaling', 'autorisatie'].includes(d.soort)) { w.push('r.soort = ?'); p.push(d.soort); }
  else w.push("(r.soort <> 'autorisatie' OR r.bestand = (SELECT id FROM kaart_bestand WHERE kaart = r.kaart ORDER BY geupload_op DESC, id DESC LIMIT 1))");
  let rij = fdb.db.prepare('SELECT r.soort, r.transactiedatum, r.boekdatum, r.omschrijving, r.handelaar, r.bedrag_centen, r.valuta_orig, r.bedrag_orig_centen, r.land, r.merchant_categorie, r.overzicht, ' +
    'l.naam AS leverancier, r.factuur, r.factuur_archief FROM kaart_regel r LEFT JOIN leverancier l ON l.id = r.leverancier WHERE ' + w.join(' AND ') + ' ORDER BY r.transactiedatum DESC, r.id').all(...p);
  if (d.tekst) { const t = K.normNaam(d.tekst); rij = rij.filter((x) => K.normNaam([x.handelaar, x.leverancier, x.omschrijving].join(' ')).indexOf(t) >= 0); }
  const tr = rij.filter((x) => x.soort === 'transactie');
  return Object.assign(kop, { weergave, aantal: rij.length, totaal_transacties_centen: tr.reduce((s, x) => s + x.bedrag_centen, 0),
    regels: rij.slice(0, max).map((x) => Object.assign(x, { valuta_orig: x.valuta_orig === 'EUR' ? undefined : x.valuta_orig, bedrag_orig_centen: x.valuta_orig === 'EUR' ? undefined : x.bedrag_orig_centen })),
    uitleg: 'bedrag_centen in euro (+ = uitgave op de kaart, - = tegoed of betaling); autorisatie = nog niet geboekt (telt niet).' });
}

module.exports = {
  KaartFout, ICS_KOPPEN, leesIcsCsv, sleutels, handelaar, zoekLeverancier, zoekFactuur, incassoOverzicht, isKaartBankregel, aansluiting, volgendeMaand, vorigeMaand,
  kaartVan, kaartZet, inlezen, koppel, aansluitingDb, betaalwijze, lees,
};
