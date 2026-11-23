'use strict';
// ── OVIS Beleggen fase 1 (wv2982, 12-11-2026; plan vault "01_Ontwikkeling/OVIS Beleggen - plan (Fable 5.2, 12-11-2026)" § 1, § 2, § 3.5) ──
// Davids beleggingsplan (veertien vragen → regels), zijn stand (uit zijn eigen DEGIRO-export of met de hand), een dagboek per transactie,
// een volglijst en signalen die ALLEEN rekenen tegen zijn eigen regels. Eigen databank beleggen.sqlite op de pod (map 700, bestand 600).
//
// Harde grenzen (grondwet 1 en 6): geen koppeling met DEGIRO, geen inlog, geen uitgaand verzoek (deze module laadt alleen fs, path,
// crypto en node:sqlite); geen knop of tekst die tot kopen of verkopen aanzet, geen koersdoel; geen bedrag in een log, /health of reden.
//
// Bestandslezer (leesBestand): strikt, nooit gokken. Alleen bekende kolommen (NL en EN, oud en nieuw formaat), één decimaalteken per
// bestand, datum dd-mm-jjjj, elke rij moet optellen (aantal × koers = lokale waarde, lokale waarde ↔ waarde in EUR via de wisselkoers,
// totaal = waarde + kosten; rekening: saldo loopt door per valuta). Anders weigeren met regel en kolom.
// Review vooraf (Codex 12-11, NO-GO → verwerkt): MOET 1 saldo per valuta in beide volgordes (één moet over het hele bestand kloppen);
// MOET 2 dubbelsleutel = inhoud + n-de gelijke rij binnen dezelfde dag (een DEGIRO-export loopt per hele dag, dus elke export met die
// dag bevat alle gelijke rijen van die dag en geeft dezelfde n); MOET 3 positie.regelsoort 'effect'|'cash' (cash telt niet mee).
//
// Gebruik vanuit server.js: require('./beleggen.js').maak({ dbPad, vaultSchrijf(relPad, tekst) }) → { app({ pad, methode, body }), info() }.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSIE = 4;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (sleutel TEXT PRIMARY KEY, waarde TEXT);
CREATE TABLE IF NOT EXISTS plan_antwoord (vraag INTEGER PRIMARY KEY CHECK (vraag BETWEEN 1 AND 14), tekst TEXT, waarden TEXT,
  status TEXT NOT NULL CHECK (status IN ('beantwoord','overgeslagen')), op TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS regel (sleutel TEXT PRIMARY KEY, waarde TEXT NOT NULL, op TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS planversie (versie INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, wat TEXT NOT NULL, momentopname TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bestand (id INTEGER PRIMARY KEY AUTOINCREMENT, soort TEXT NOT NULL, naam TEXT, sha256 TEXT NOT NULL, datum_bestand TEXT,
  op TEXT NOT NULL, rijen INTEGER NOT NULL, nieuw INTEGER NOT NULL, inhoud TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS positie (sleutel TEXT PRIMARY KEY, regelsoort TEXT NOT NULL CHECK (regelsoort IN ('effect','cash')), naam TEXT NOT NULL,
  isin TEXT, aantal TEXT, koers TEXT, valuta TEXT, lokaal_cent INTEGER, waarde_eur_cent INTEGER NOT NULL,
  bron TEXT NOT NULL CHECK (bron IN ('bestand','hand')), bestand_id INTEGER, op TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS positie_soort (sleutel TEXT PRIMARY KEY, soort TEXT NOT NULL CHECK (soort IN ('kern','tech','health','leuk')), op TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS transactie (sleutel TEXT PRIMARY KEY, datum TEXT NOT NULL, tijd TEXT, naam TEXT NOT NULL, isin TEXT, beurs TEXT,
  aantal TEXT NOT NULL, koers TEXT, valuta TEXT, lokaal_cent INTEGER, waarde_eur_cent INTEGER, wisselkoers TEXT, kosten_eur_cent INTEGER,
  totaal_eur_cent INTEGER, order_id TEXT, bron TEXT NOT NULL CHECK (bron IN ('bestand','hand')), bestand_id INTEGER, op TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rekening (sleutel TEXT PRIMARY KEY, datum TEXT NOT NULL, tijd TEXT, valutadatum TEXT, naam TEXT, isin TEXT, omschrijving TEXT,
  mutatie_cent INTEGER, mutatie_valuta TEXT, saldo_cent INTEGER, saldo_valuta TEXT, order_id TEXT, bestand_id INTEGER, op TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dagboek (id INTEGER PRIMARY KEY AUTOINCREMENT, transactie_sleutel TEXT UNIQUE, datum TEXT NOT NULL, naam TEXT NOT NULL,
  waarom TEXT, blijven TEXT, verkoop_wanneer TEXT, terugblik6 TEXT, terugblik12 TEXT, op TEXT NOT NULL, bijgewerkt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS volglijst (id INTEGER PRIMARY KEY AUTOINCREMENT, naam TEXT NOT NULL, code TEXT, thema TEXT, waarom TEXT, wanneer TEXT,
  op TEXT NOT NULL, weg INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS signaal_keuze (sleutel TEXT PRIMARY KEY, keuze TEXT NOT NULL CHECK (keuze IN ('niets','herinner')), tot TEXT, op TEXT NOT NULL);
`;
// Schemaversie 2 (wv2993, fase 2 weekbericht; ontwerp mk-scripts/ovis-beleggen/fase2/ontwerp-fase2.md § 2.2). Alleen nieuwe tabellen (CREATE IF NOT
// EXISTS = de migratie); fase-1-tabellen blijven gelijk. bedrijf = het kaartje per positie ('isin:…'/'naam:…') of volglijstregel ('volg:<id>');
// nieuws = alleen kop, link, datum en bron (geen artikeltekst), 120 dagen; week = één rij per ISO-week; week_keuze = Davids keuze per kaart.
const SCHEMA_2 = `
CREATE TABLE IF NOT EXISTS bedrijf (sleutel TEXT PRIMARY KEY, naam TEXT NOT NULL, namen TEXT NOT NULL, code TEXT, cik TEXT, sponsor TEXT,
  producten TEXT NOT NULL DEFAULT '[]', belang INTEGER NOT NULL DEFAULT 0 CHECK (belang IN (0,1)), op TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nieuws (sleutel TEXT PRIMARY KEY, bedrijf TEXT NOT NULL, bron TEXT NOT NULL, bronsleutel TEXT NOT NULL, hard INTEGER NOT NULL CHECK (hard IN (0,1)),
  koppeling TEXT NOT NULL CHECK (koppeling IN ('cik','sponsor','product','naam')), soort TEXT, achtergrond INTEGER NOT NULL DEFAULT 0, datum TEXT NOT NULL,
  titel TEXT NOT NULL, link TEXT, eerst_gezien TEXT NOT NULL, week_getoond TEXT);
CREATE INDEX IF NOT EXISTS nieuws_bedrijf ON nieuws (bedrijf, datum);
CREATE TABLE IF NOT EXISTS nieuws_bron (bron TEXT PRIMARY KEY, laatst_ok TEXT, fouten_op_rij INTEGER NOT NULL DEFAULT 0, laatste_fout TEXT, ruis_teller INTEGER NOT NULL DEFAULT 0,
  gezakt INTEGER NOT NULL DEFAULT 0, gemeld_week TEXT);
CREATE TABLE IF NOT EXISTS week (iso_week TEXT PRIMARY KEY, van TEXT NOT NULL, tot TEXT NOT NULL, gemaakt_op TEXT NOT NULL, invoer_hash TEXT, kaarten TEXT NOT NULL,
  verder TEXT NOT NULL, belang TEXT NOT NULL, model TEXT NOT NULL, gemeld_op TEXT, bericht_id TEXT);
CREATE TABLE IF NOT EXISTS week_keuze (iso_week TEXT NOT NULL, bedrijf TEXT NOT NULL, keuze TEXT NOT NULL CHECK (keuze IN ('niets','dagboek','herinner','ruis','nuttig')),
  tot TEXT, op TEXT NOT NULL, PRIMARY KEY (iso_week, bedrijf));
`;

// Schemaversie 3 (wv3728, besluit nr 138 / 2C38, David Ja 21-11 13:18): dagkoersen. koers = slotkoers per ISIN per beursdag (tekst, punt als
// decimaalteken) met de valuta van de bron; wissel = ECB-referentiekoers (vreemde valuta per euro) per dag; koerscode = de beurscode en het
// SEC-nummer die de ochtendronde zelf opzocht (per bedrijfsleutel, ook een mislukte zoektocht met datum); bedrijf_uit = Davids "Geen nieuws meer"
// (dan zet de ochtendronde het kaartje niet opnieuw vanzelf aan). Alleen nieuwe tabellen: CREATE IF NOT EXISTS = de migratie.
const SCHEMA_3 = `
CREATE TABLE IF NOT EXISTS koers (isin TEXT NOT NULL, datum TEXT NOT NULL, slot TEXT NOT NULL, valuta TEXT NOT NULL, bron TEXT NOT NULL, op TEXT NOT NULL, PRIMARY KEY (isin, datum));
CREATE TABLE IF NOT EXISTS wissel (valuta TEXT NOT NULL, datum TEXT NOT NULL, per_eur TEXT NOT NULL, op TEXT NOT NULL, PRIMARY KEY (valuta, datum));
CREATE TABLE IF NOT EXISTS koerscode (sleutel TEXT PRIMARY KEY, code TEXT, cik TEXT, naam_bron TEXT, op TEXT NOT NULL, fout TEXT);
CREATE TABLE IF NOT EXISTS bedrijf_uit (sleutel TEXT PRIMARY KEY, op TEXT NOT NULL);
`;

// Schemaversie 4 (wv3757, besluit nr 910 / L10, David Ja 21-11 13:19 met vingerafdruk): de peilwaarde op 1 januari voor de aangifte. Eén rij per
// peildatum, één keer vastgelegd en nooit overschreven (INSERT … ON CONFLICT DO NOTHING); inhoud = de hele berekening (posities, koersdatum per
// positie, markeringen, dividend en kosten van het jaar ervóór) als JSON. Eigen registratie voor David: niets gaat naar de Belastingdienst of een broker.
const SCHEMA_4 = `
CREATE TABLE IF NOT EXISTS peil (peildatum TEXT PRIMARY KEY, waarde_cent INTEGER, effecten_cent INTEGER, cash_cent INTEGER, volledig INTEGER NOT NULL CHECK (volledig IN (0,1)),
  markering TEXT NOT NULL, inhoud TEXT NOT NULL, bron TEXT NOT NULL, op TEXT NOT NULL);
`;

// ── de veertien vragen (plan § 1.7); velden = wat de app narekent ──
const VRAGEN = [
  { nr: 1, vraag: 'Waarvoor is dit geld, en wanneer wil je het op zijn vroegst kunnen gebruiken?' },
  { nr: 2, vraag: 'Beleg je privé, vanuit de Holding, of beide?', hint: 'Leg dit ook aan je accountant voor.' },
  { nr: 3, vraag: 'Welk bedrag blijft buiten de beleggingen als buffer, en zijn er leningen die je liever eerst aflost?' },
  { nr: 4, vraag: 'Leg je één keer in, elke maand een vast bedrag, of allebei?',
    // wv3755 (besluit nr 907 / L07, David Ja 21-11 13:18): opbouwfase. Zolang wat er belegd staat onder dit doel zit, meten "één aandeel hoogstens"
    // en "één thema hoogstens" tegen het doel in plaats van tegen wat er nu staat (met één positie zit je anders altijd op 100 %).
    velden: [{ sleutel: 'doel_euro', label: 'Ik bouw op tot', soort: 'euro', leeg: 'geen opbouwfase: je maxima meten tegen wat er nu staat' }] },
  { nr: 5, vraag: 'Stap je in één keer in of gespreid, en over hoeveel maanden?' },
  { nr: 6, vraag: 'Stel dat alles in een jaar halveert: wat doe je dan? Bijkopen, niets, of verkopen. En bij welk verlies in euro\'s lig je wakker?',
    // wv3755 (besluit nr 911 / L11, David Ja 21-11 13:19): zakt een positie zoveel sinds aankoop, dan toont de app dit antwoord en je dagboekregel
    // "wanneer verkoop ik" (signaal daling). Leeg = de standaard van 30 %.
    velden: [{ sleutel: 'daling_pct', label: 'Toon mijn eigen woorden als een positie zoveel lager staat dan bij aankoop', soort: 'pct', leeg: 'standaard 30 %' }] },
  { nr: 7, vraag: 'Welk deel gaat naar brede indexfondsen, welk deel naar eigen keuzes in tech en health, en wat is het plafond voor "voor de leuk"?',
    velden: [{ sleutel: 'kern_min', label: 'Kern (indexfondsen) minstens', soort: 'pct' }, { sleutel: 'kern_max', label: 'Kern hoogstens', soort: 'pct' },
      { sleutel: 'eigen_min', label: 'Eigen keuzes (tech + health) minstens', soort: 'pct' }, { sleutel: 'eigen_max', label: 'Eigen keuzes hoogstens', soort: 'pct' },
      { sleutel: 'leuk_max', label: 'Voor de leuk hoogstens', soort: 'pct' }] },
  { nr: 8, vraag: 'Wat is het maximum voor één aandeel, en voor één thema?',
    velden: [{ sleutel: 'max_aandeel', label: 'Eén aandeel hoogstens', soort: 'pct' }, { sleutel: 'max_thema', label: 'Eén thema (tech of health) hoogstens', soort: 'pct' }] },
  { nr: 9, vraag: 'In welke lagen van tech en health wil je zitten, en welke bewust niet?' },
  { nr: 10, vraag: 'Welke bedrijven koop je niet, omdat je er zakelijk mee te maken hebt?',
    velden: [{ sleutel: 'koop_niet', label: 'Eén bedrijf per regel', soort: 'lijst' }] },
  { nr: 11, vraag: 'Wat doe je niet: geleend geld, opties, short, crypto?' },
  { nr: 12, vraag: 'Hoe vaak wil je iets horen: één keer per week, alleen bij een harde gebeurtenis (uitslag, cijfers), of ook dan niet?',
    hint: 'Pas vanaf fase 2 (weekbericht); in fase 1 staan de signalen alleen in de app.' },
  { nr: 13, vraag: 'Hoe lang wacht je tussen een idee en een order (afkoeltijd)?',
    velden: [{ sleutel: 'afkoel_dagen', label: 'Afkoeltijd in dagen', soort: 'dagen' }] },
  { nr: 14, vraag: 'Wanneer herbalanceer je: op vaste momenten of als een deel te ver afwijkt?',
    velden: [{ sleutel: 'herbalans_wijze', label: 'Wanneer', soort: 'keuze', opties: [['momenten', 'Op vaste momenten'], ['afwijking', 'Als een deel buiten zijn bandbreedte komt']] },
      { sleutel: 'herbalans_maanden', label: 'In welke maanden (1–12, bij vaste momenten)', soort: 'maanden' }] },
];
const VELDEN = {};
for (const v of VRAGEN) for (const f of v.velden || []) VELDEN[f.sleutel] = Object.assign({ vraag: v.nr }, f);
const SOORTEN = ['kern', 'tech', 'health', 'leuk'];
const SOORT_NAAM = { kern: 'Kern', tech: 'Tech (AI)', health: 'Health', leuk: 'Voor de leuk' };
const ANTHROPIC_ZIN = 'Socev draait op modellen van Anthropic; daarom toont de app hierover alleen feiten met bron, zonder oordeel.';

class LeesFout extends Error { constructor(tekst, regel, kolom) { super(tekst); this.regel = regel || null; this.kolom = kolom || null; } }
class Fout extends Error { constructor(status, tekst) { super(tekst); this.status = status; } }

// ── CSV ──
function splitsCsv(tekst, sep) {
  const rijen = []; let rij = [], veld = '', q = false, i = 0, regel = 1; const regels = [1];
  while (i < tekst.length) {
    const c = tekst[i];
    if (q) {
      if (c === '"') { if (tekst[i + 1] === '"') { veld += '"'; i += 2; continue; } q = false; i++; continue; }
      if (c === '\n') regel++;
      veld += c; i++; continue;
    }
    if (c === '"') { if (veld !== '') throw new LeesFout('aanhalingsteken midden in een veld', regel); q = true; i++; continue; }
    if (c === sep) { rij.push(veld); veld = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { rij.push(veld); rijen.push(rij); rij = []; veld = ''; i++; regel++; regels.push(regel); continue; }
    veld += c; i++;
  }
  if (q) throw new LeesFout('aanhalingsteken niet gesloten', regel);
  if (veld !== '' || rij.length) { rij.push(veld); rijen.push(rij); } else regels.pop();
  return { rijen, regels };
}

// Kolomnamen per soort (kleine letters, spaties samengevoegd). Lege kolomnaam = tweede helft van de kolom ervoor (valuta of bedrag).
const KOLOMMEN = {
  transacties: {
    datum: ['datum', 'date'], tijd: ['tijd', 'time'], product: ['product'], isin: ['isin'],
    beurs: ['beurs', 'reference exchange', 'referentiebeurs'], plaats: ['uitvoeringsplaats', 'venue', 'handelsplaats'],
    aantal: ['aantal', 'quantity'], koers: ['koers', 'price'], lokaal: ['lokale waarde', 'local value'],
    waarde: ['waarde', 'value', 'waarde eur', 'value eur'], wisselkoers: ['wisselkoers', 'exchange rate'], autofx: ['autofx kosten', 'autofx fee'],
    kosten: ['transactiekosten en/of kosten van derden eur', 'transactiekosten en/of kosten van derden', 'transactiekosten en/of', 'transactiekosten',
      'transaction and/or third party fees eur', 'transaction and/or third party fees', 'transaction and/or third', 'transactie- en/of derde kosten'],
    totaal: ['totaal', 'total', 'totaal eur', 'total eur'], order: ['order id'],
    _nodig: ['datum', 'tijd', 'product', 'isin', 'aantal', 'koers', 'lokaal', 'waarde', 'totaal'],
  },
  portefeuille: {
    product: ['product'], isin: ['symbool/isin', 'symbol/isin', 'isin'], aantal: ['aantal', 'amount', 'quantity'],
    koers: ['slotkoers', 'closing', 'closing price'], lokaal: ['lokale waarde', 'local value'], waarde: ['waarde in eur', 'value in eur'],
    _nodig: ['product', 'isin', 'aantal', 'koers', 'lokaal', 'waarde'],
  },
  rekening: {
    datum: ['datum', 'date'], tijd: ['tijd', 'time'], valutadatum: ['valutadatum', 'value date'], product: ['product'], isin: ['isin'],
    omschrijving: ['omschrijving', 'description'], fx: ['fx'], mutatie: ['mutatie', 'change'], saldo: ['saldo', 'balance'], order: ['order id'],
    _nodig: ['datum', 'tijd', 'valutadatum', 'product', 'isin', 'omschrijving', 'mutatie', 'saldo'],
  },
};
const norm = (s) => String(s || '').replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, ' ');

function kolomKaart(kop) {
  const namen = kop.map(norm);
  const pogingen = [];
  for (const soort of Object.keys(KOLOMMEN)) {
    const K = KOLOMMEN[soort], kaart = {}, onbekend = [];
    let vorige = null;
    namen.forEach((n, i) => {
      if (n === '') { if (vorige) kaart[vorige].partner = kaart[vorige].partner == null ? i : kaart[vorige].partner; return; }
      const veld = Object.keys(K).find((k) => k[0] !== '_' && K[k].includes(n));
      if (!veld) { onbekend.push(kop[i].trim()); vorige = null; return; }
      if (kaart[veld]) { onbekend.push(kop[i].trim() + ' (dubbel)'); vorige = null; return; }
      kaart[veld] = { i, partner: null }; vorige = veld;
    });
    const mist = K._nodig.filter((k) => !kaart[k]);
    pogingen.push({ soort, kaart, onbekend, mist });
  }
  const goed = pogingen.filter((p) => !p.onbekend.length && !p.mist.length);
  if (goed.length === 1) return goed[0];
  const beste = pogingen.slice().sort((a, b) => (a.onbekend.length + a.mist.length) - (b.onbekend.length + b.mist.length))[0];
  const deel = [];
  if (beste.onbekend.length) deel.push('onbekende kolommen: ' + beste.onbekend.slice(0, 6).join(', '));
  if (beste.mist.length) deel.push('ontbrekende kolommen: ' + beste.mist.join(', '));
  throw new LeesFout('Dit is geen bekend DEGIRO-bestand (portefeuille, transacties of rekeningoverzicht). ' + deel.join('; ') + '.', 1);
}

const RE_KOMMA = /^[-+]?\d+(,\d+)?$/, RE_PUNT = /^[-+]?\d+(\.\d+)?$/;
function getalTekst(s) { return String(s == null ? '' : s).trim(); }
// Eén decimaalteken per bestand: telt een getal met komma én een met punt, dan weigeren (ook duizendtallen 1.234,56 en 1,234.56).
function decimaalteken(velden) {
  let komma = null, punt = null;
  for (const v of velden) {
    const t = getalTekst(v.t);
    if (!t) continue;
    if (t.includes(',') && t.includes('.')) throw new LeesFout('getal met punt én komma (duizendtallen?): zet de export zonder duizendtalscheiding', v.regel, v.kolom);
    if (t.includes(',') && !komma) komma = v;
    if (t.includes('.') && !punt) punt = v;
  }
  if (komma && punt) throw new LeesFout('het bestand mengt komma en punt als decimaalteken (regel ' + komma.regel + ' en ' + punt.regel + ')', punt.regel, punt.kolom);
  return komma ? ',' : '.';
}
function leesGetal(s, dec, regel, kolom, leegMag) {
  const t = getalTekst(s);
  if (!t) { if (leegMag) return null; throw new LeesFout('leeg getal', regel, kolom); }
  if (!(dec === ',' ? RE_KOMMA : RE_PUNT).test(t)) throw new LeesFout('geen getal of verkeerd decimaalteken', regel, kolom);
  return { tekst: t.replace(',', '.').replace(/^\+/, ''), n: Number(t.replace(',', '.')) };
}
function naarCent(g) {   // decimale tekst → gehele centen, afgerond (half van nul af)
  if (!g) return null;
  const neg = g.tekst.startsWith('-');
  const [h, f = ''] = g.tekst.replace('-', '').split('.');
  let c = BigInt(h) * 100n + BigInt((f + '00').slice(0, 2));
  if (f.length > 2 && Number(f[2]) >= 5) c += 1n;
  return Number(neg ? -c : c);
}
function leesDatum(s, regel, kolom, leegMag) {
  const t = String(s || '').trim();
  if (!t && leegMag) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(t);
  if (!m) throw new LeesFout('datum niet als dd-mm-jjjj', regel, kolom);
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  if (d.getUTCDate() !== +m[1] || d.getUTCMonth() !== +m[2] - 1) throw new LeesFout('datum bestaat niet', regel, kolom);
  return m[3] + '-' + m[2] + '-' + m[1];
}
function leesTijd(s, regel, kolom) {
  const t = String(s || '').trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new LeesFout('tijd niet als uu:mm', regel, kolom);
  return t;
}
const RE_VALUTA = /^[A-Z]{3}$/;
// Bedrag met valuta in twee kolommen: precies één van de twee is een valutacode, de ander het getal. wv2985 (Davids echte NL-export 13-11):
// transacties = getal, valuta ("Koers,," → 162,83 | USD); rekeningoverzicht = valuta, getal ("Mutatie,," → USD | 488,49). volgorde 'gv' of 'vg'
// eist die vorm; null (portefeuille) accepteert beide. wv3927 (Davids echte NL-portefeuille 23-11): "Lokale waarde,," = valuta, getal
// (EUR | 255,87; USD | 627,65), Slotkoers en Waarde in EUR één kolom zonder valuta, komma als decimaalteken; CASH-regel zonder ISIN/aantal/koers.
function leesBedrag(rij, k, dec, regel, naam, leegMag, vasteValuta, volgorde) {
  const a = (rij[k.i] || '').trim(), b = k.partner == null ? '' : (rij[k.partner] || '').trim();
  if (k.partner == null) {
    const g = leesGetal(a, dec, regel, naam, leegMag);
    return g ? { g, cent: naarCent(g), valuta: vasteValuta || null } : null;
  }
  if (!a && !b) { if (leegMag) return null; throw new LeesFout('leeg bedrag', regel, naam); }
  let valuta, getal;
  if (RE_VALUTA.test(a) && !RE_VALUTA.test(b)) { valuta = a; getal = b; } else if (RE_VALUTA.test(b) && !RE_VALUTA.test(a)) { valuta = b; getal = a; }
  else throw new LeesFout('bedrag zonder herkenbare valuta', regel, naam);
  if (volgorde && (volgorde === 'gv') !== (valuta === b)) throw new LeesFout(naam + ': ' + (volgorde === 'gv' ? 'eerst het getal, dan de valuta' : 'eerst de valuta, dan het getal') + ' (zoals in de DEGIRO-export)', regel, naam);
  if (vasteValuta && valuta !== vasteValuta) throw new LeesFout(naam + ' moet in ' + vasteValuta + ' staan, niet in ' + valuta, regel, naam);   // review achteraf MOET 2
  const g = leesGetal(getal, dec, regel, naam, false);
  return { g, cent: naarCent(g), valuta };
}
// review achteraf MOET 5: getaltekst zonder overbodige nullen voor de dubbelsleutel ('1.0' = '1', '0100.50' = '100.5')
function canon(t) {
  let x = String(t).replace(/^\+/, ''); const neg = x.startsWith('-'); if (neg) x = x.slice(1);
  let [h, f = ''] = x.split('.'); h = h.replace(/^0+(?=\d)/, ''); f = f.replace(/0+$/, '');
  const u = f ? h + '.' + f : h; return neg && u !== '0' ? '-' + u : u;
}
const veld = (rij, k) => (k ? String(rij[k.i] || '').trim() : '');
const RE_ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const RE_ORDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;   // wv2985: DEGIRO-order-id (uuid, kleine letters; review ronde 4), in transacties en rekeningoverzicht
// review wv2985 ronde 4: marge van een omrekening = afronding van de koers (half van de laatste decimaal) + een halve cent aan beide kanten
function wisselTol(euro, koers) { const d = (koers.tekst.split('.')[1] || '').length; return euro * (0.5 * Math.pow(10, -d)) / koers.n + 0.005 / koers.n + 0.005 + 0.002; }
const tol = (x) => 0.011 + Math.abs(x) * 0.0005;   // 1 cent + afronding van koers/wisselkoers

function sha(t) { return crypto.createHash('sha256').update(t).digest('hex'); }

// leesBestand(tekst) → { soort, rijen: [...], decimaal } of LeesFout. Pure functie: schrijft niets.
function leesBestand(tekst) {
  if (typeof tekst !== 'string') throw new LeesFout('geen tekst');
  if (tekst.length > 2 * 1024 * 1024) throw new LeesFout('bestand te groot (hooguit 2 MB)');
  tekst = tekst.replace(/^﻿/, '');
  if (!tekst.trim()) throw new LeesFout('leeg bestand');
  const eerste = tekst.split('\n', 1)[0];
  const sep = (eerste.match(/;/g) || []).length > (eerste.match(/,/g) || []).length ? ';' : ',';
  const { rijen: alle, regels } = splitsCsv(tekst, sep);
  const kop = alle[0];
  const data = [];
  for (let r = 1; r < alle.length; r++) if (alle[r].some((v) => String(v).trim() !== '')) data.push({ rij: alle[r], regel: regels[r] });
  const { soort, kaart } = kolomKaart(kop);
  if (!data.length) throw new LeesFout('alleen een kopregel, geen rijen');
  for (const d of data) if (d.rij.length !== kop.length && !(d.rij.length === kop.length + 1 && d.rij[kop.length] === '')) throw new LeesFout('rij heeft ' + d.rij.length + ' velden, de kopregel ' + kop.length, d.regel);
  // decimaalteken over alle getalkolommen (ook de partnerkolom)
  const getalVelden = { transacties: ['aantal', 'koers', 'lokaal', 'waarde', 'wisselkoers', 'autofx', 'kosten', 'totaal'], portefeuille: ['aantal', 'koers', 'lokaal', 'waarde'], rekening: ['fx', 'mutatie', 'saldo'] }[soort];
  const lijst = [];
  for (const d of data) for (const v of getalVelden) { const k = kaart[v]; if (!k) continue; for (const i of [k.i, k.partner]) if (i != null && !RE_VALUTA.test(String(d.rij[i] || '').trim())) lijst.push({ t: d.rij[i], regel: d.regel, kolom: v }); }
  const dec = decimaalteken(lijst);
  const uit = [];
  // wv3927 (Fable-review financien M5 / C50): twee soorten regels slaat de lezer over in plaats van het hele bestand te weigeren, met een
  // telling 'n regels niet meegenomen': een transactie met koers nul en verder alleen nullen (claim, omwisseling: geen geld) en een vervolgregel
  // in het rekeningoverzicht zonder datum, tijd, mutatie, saldo en FX (alleen tekst). Al het andere blijft strikt: zodra er geld in staat, weigeren.
  const overgeslagen = [];
  if (soort === 'transacties') {
    const telling = {};
    for (const { rij, regel } of data) {
      const datum = leesDatum(veld(rij, kaart.datum), regel, 'datum'), tijd = leesTijd(veld(rij, kaart.tijd), regel, 'tijd');
      const naam = veld(rij, kaart.product), isin = veld(rij, kaart.isin);
      if (!naam) throw new LeesFout('product ontbreekt', regel, 'product');
      if (!RE_ISIN.test(isin)) throw new LeesFout('geen geldige ISIN', regel, 'isin');
      const aantal = leesGetal(veld(rij, kaart.aantal), dec, regel, 'aantal');
      if (aantal.n === 0) throw new LeesFout('aantal is nul', regel, 'aantal');
      const koers = leesBedrag(rij, kaart.koers, dec, regel, 'koers', false, null, 'gv');
      const lokaal = leesBedrag(rij, kaart.lokaal, dec, regel, 'lokale waarde', false, null, 'gv');
      const waarde = leesBedrag(rij, kaart.waarde, dec, regel, 'waarde', false, 'EUR', 'gv');
      const wk = kaart.wisselkoers ? leesGetal(veld(rij, kaart.wisselkoers), dec, regel, 'wisselkoers', true) : null;
      const kosten = kaart.kosten ? leesBedrag(rij, kaart.kosten, dec, regel, 'kosten', true, 'EUR', 'gv') : null;
      const autofx = kaart.autofx ? leesBedrag(rij, kaart.autofx, dec, regel, 'autofx', true, 'EUR', 'gv') : null;
      const totaal = leesBedrag(rij, kaart.totaal, dec, regel, 'totaal', false, 'EUR', 'gv');
      if (waarde.valuta && waarde.valuta !== 'EUR') throw new LeesFout('waarde niet in euro', regel, 'waarde');
      if (totaal.valuta && totaal.valuta !== 'EUR') throw new LeesFout('totaal niet in euro', regel, 'totaal');
      if (koers.valuta && lokaal.valuta && koers.valuta !== lokaal.valuta) throw new LeesFout('koers en lokale waarde in verschillende valuta', regel, 'koers');
      const valuta = lokaal.valuta || koers.valuta;
      if (!valuta) throw new LeesFout('valuta ontbreekt', regel, 'lokale waarde');
      // wv3927: koers nul met lokale waarde, waarde, kosten en totaal nul = geen geld (claim, omwisseling) → overslaan en tellen
      if (koers.g.n === 0 && lokaal.g.n === 0 && waarde.g.n === 0 && totaal.g.n === 0 && !(kosten && kosten.g.n !== 0) && !(autofx && autofx.g.n !== 0)) { overgeslagen.push({ regel, reden: 'koers nul' }); continue; }
      // optellen; tekens (review achteraf MOET 1): koers > 0, erbij (aantal > 0) = geld eruit (lokale waarde en waarde < 0), eraf = geld erin
      if (!(koers.g.n > 0)) throw new LeesFout('koers moet groter dan nul zijn', regel, 'koers');
      if (Math.abs(Math.abs(aantal.n * koers.g.n) - Math.abs(lokaal.g.n)) > tol(lokaal.g.n)) throw new LeesFout('aantal × koers is niet de lokale waarde', regel, 'lokale waarde');
      if (lokaal.g.n === 0 || Math.sign(lokaal.g.n) !== -Math.sign(aantal.n)) throw new LeesFout('teken van de lokale waarde past niet bij het aantal (erbij = negatief, eraf = positief)', regel, 'lokale waarde');
      if (waarde.g.n === 0 || Math.sign(waarde.g.n) !== Math.sign(lokaal.g.n)) throw new LeesFout('lokale waarde en waarde hebben een ander teken', regel, 'waarde');
      if (kosten && kosten.g.n > 0) throw new LeesFout('kosten horen negatief te zijn', regel, 'kosten');
      if (autofx && autofx.g.n > 0) throw new LeesFout('AutoFX-kosten horen negatief te zijn', regel, 'autofx');
      if (valuta === 'EUR') {
        if (Math.abs(lokaal.g.n - waarde.g.n) > tol(waarde.g.n)) throw new LeesFout('waarde in euro wijkt af van de lokale waarde', regel, 'waarde');
        if (wk && wk.n !== 1) throw new LeesFout('wisselkoers bij een bedrag in euro', regel, 'wisselkoers');   // wv2985: leeg of 1
      } else {
        if (!wk || !(wk.n > 0)) throw new LeesFout('wisselkoers ontbreekt bij een bedrag in ' + valuta, regel, 'wisselkoers');
        // wv2985 (gemeten op Davids export): de wisselkoers is vreemde valuta per euro, dus waarde in euro = lokale waarde / wisselkoers
        const a = Math.abs(lokaal.g.n) / wk.n, w = Math.abs(waarde.g.n);
        if (Math.abs(a - w) > wisselTol(w, wk)) throw new LeesFout('lokale waarde / wisselkoers geeft niet de waarde in euro (DEGIRO: ' + valuta + ' per euro)', regel, 'wisselkoers');
      }
      const som = waarde.g.n + (kosten ? kosten.g.n : 0) + (autofx ? autofx.g.n : 0);
      if (Math.abs(som - totaal.g.n) > 0.011) throw new LeesFout('totaal is niet waarde + kosten', regel, 'totaal');
      let order = veld(rij, kaart.order);
      if (!order && kaart.order && kaart.order.partner != null) order = String(rij[kaart.order.partner] || '').trim();
      if (!order && kaart.order) { const laatste = String(rij[kop.length] || rij[kop.length - 1] || '').trim(); if (/^[0-9a-f-]{8,}$/i.test(laatste)) order = laatste; }
      if (order && !RE_ORDER.test(order)) throw new LeesFout('order-id heeft niet de vorm van DEGIRO', regel, 'order id');
      const basis = [datum, tijd, isin, canon(aantal.tekst), canon(koers.g.tekst), lokaal.cent, order].join('|');
      telling[basis] = (telling[basis] || 0) + 1;
      uit.push({ sleutel: 'tx:' + sha(basis + '#' + telling[basis]).slice(0, 32), datum, tijd, naam, isin, beurs: veld(rij, kaart.beurs) || null,
        aantal: aantal.tekst, koers: koers.g.tekst, valuta, lokaal_cent: lokaal.cent, waarde_eur_cent: waarde.cent, wisselkoers: wk ? wk.tekst : null,
        kosten_eur_cent: (kosten ? kosten.cent : 0) + (autofx ? autofx.cent : 0), autofx_eur_cent: autofx ? autofx.cent : (kaart.autofx ? 0 : null), totaal_eur_cent: totaal.cent, order_id: order || null, regel });
    }
  } else if (soort === 'portefeuille') {
    const gezien = new Set();
    for (const { rij, regel } of data) {
      const naam = veld(rij, kaart.product), isin = veld(rij, kaart.isin);
      if (!naam) throw new LeesFout('product ontbreekt', regel, 'product');
      const aantalT = veld(rij, kaart.aantal);
      const waarde = leesBedrag(rij, kaart.waarde, dec, regel, 'waarde in EUR', false, 'EUR');
      const lokaal = leesBedrag(rij, kaart.lokaal, dec, regel, 'lokale waarde', false);
      if (!aantalT && !isin && !veld(rij, kaart.koers) && /\bCASH\b/i.test(naam)) {   // contant geld (CASH & CASH FUND & FTX CASH (EUR)): telt niet mee; review achteraf MOET 3: alleen een regel met CASH in de naam
        if (lokaal.g.n < 0 || waarde.g.n < 0) throw new LeesFout('negatief contant geld', regel, 'waarde in EUR');
        if (lokaal.valuta === 'EUR' && Math.abs(lokaal.g.n - waarde.g.n) > tol(waarde.g.n)) throw new LeesFout('waarde in euro wijkt af van de lokale waarde', regel, 'waarde in EUR');
        const sl = 'cash:' + (lokaal.valuta || 'EUR');
        if (gezien.has(sl)) throw new LeesFout('twee regels contant geld in dezelfde valuta', regel, 'product');
        gezien.add(sl);
        uit.push({ sleutel: sl, regelsoort: 'cash', naam, isin: null, aantal: null, koers: null, valuta: lokaal.valuta, lokaal_cent: lokaal.cent, waarde_eur_cent: waarde.cent, regel });
        continue;
      }
      if (!aantalT || !isin) throw new LeesFout('regel zonder aantal of ISIN (alleen contant geld mag dat)', regel, !aantalT ? 'aantal' : 'isin');
      if (!RE_ISIN.test(isin)) throw new LeesFout('geen geldige ISIN', regel, 'isin');
      const aantal = leesGetal(aantalT, dec, regel, 'aantal');
      const koers = leesBedrag(rij, kaart.koers, dec, regel, 'slotkoers', false);
      if (!(aantal.n > 0)) throw new LeesFout('aantal moet groter dan nul zijn', regel, 'aantal');
      if (koers.g.n < 0 || lokaal.g.n < 0 || waarde.g.n < 0) throw new LeesFout('negatieve koers of waarde in de portefeuille', regel, 'lokale waarde');
      if (koers.valuta && lokaal.valuta && koers.valuta !== lokaal.valuta) throw new LeesFout('slotkoers en lokale waarde in verschillende valuta', regel, 'slotkoers');
      if (Math.abs(Math.abs(aantal.n * koers.g.n) - Math.abs(lokaal.g.n)) > tol(lokaal.g.n)) throw new LeesFout('aantal × slotkoers is niet de lokale waarde', regel, 'lokale waarde');
      if (lokaal.valuta === 'EUR' && Math.abs(lokaal.g.n - waarde.g.n) > tol(waarde.g.n)) throw new LeesFout('waarde in euro wijkt af van de lokale waarde', regel, 'waarde in EUR');
      const sl = 'isin:' + isin;
      if (gezien.has(sl)) throw new LeesFout('dezelfde ISIN twee keer', regel, 'isin');
      gezien.add(sl);
      uit.push({ sleutel: sl, regelsoort: 'effect', naam, isin, aantal: aantal.tekst, koers: koers.g.tekst, valuta: lokaal.valuta || koers.valuta, lokaal_cent: lokaal.cent, waarde_eur_cent: waarde.cent, regel });
    }
  } else {
    const telling = {}, perValuta = {};
    const leegIn = (rij, k) => !k || (!String(rij[k.i] || '').trim() && (k.partner == null || !String(rij[k.partner] || '').trim()));
    for (const { rij, regel } of data) {
      // wv3927: vervolgregel zonder datum en tijd en zonder geld (mutatie, saldo en FX leeg) → overslaan en tellen; met geld blijft het weigeren
      if (leegIn(rij, kaart.datum) && leegIn(rij, kaart.tijd) && leegIn(rij, kaart.mutatie) && leegIn(rij, kaart.saldo) && leegIn(rij, kaart.fx)) { overgeslagen.push({ regel, reden: 'vervolgregel' }); continue; }
      const datum = leesDatum(veld(rij, kaart.datum), regel, 'datum'), tijd = leesTijd(veld(rij, kaart.tijd), regel, 'tijd');
      const valutadatum = leesDatum(veld(rij, kaart.valutadatum), regel, 'valutadatum', true);
      const isin = veld(rij, kaart.isin);
      if (isin && !RE_ISIN.test(isin)) throw new LeesFout('geen geldige ISIN', regel, 'isin');
      const omschrijving = veld(rij, kaart.omschrijving);
      if (!omschrijving) throw new LeesFout('omschrijving ontbreekt', regel, 'omschrijving');
      const fx = kaart.fx ? leesGetal(veld(rij, kaart.fx), dec, regel, 'fx', true) : null;
      const mutatie = leesBedrag(rij, kaart.mutatie, dec, regel, 'mutatie', true, null, 'vg');
      const saldo = leesBedrag(rij, kaart.saldo, dec, regel, 'saldo', true, null, 'vg');
      if (!!mutatie !== !!saldo) throw new LeesFout(mutatie ? 'mutatie zonder saldo' : 'saldo zonder mutatie', regel, mutatie ? 'saldo' : 'mutatie');   // review achteraf MOET 4
      if (mutatie && saldo && mutatie.valuta !== saldo.valuta) throw new LeesFout('mutatie en saldo in verschillende valuta', regel, 'saldo');
      let order = veld(rij, kaart.order);
      if (!order && kaart.order && kaart.order.partner != null) order = String(rij[kaart.order.partner] || '').trim();
      if (order && !RE_ORDER.test(order)) throw new LeesFout('order-id heeft niet de vorm van DEGIRO', regel, 'order id');
      if (!order && /^valuta (creditering|debitering)$/i.test(omschrijving)) throw new LeesFout('valutawissel zonder order-id', regel, 'order id');   // review wv2985 ronde 2
      if (!mutatie && /^valuta (creditering|debitering)$/i.test(omschrijving)) throw new LeesFout('valutawissel zonder mutatie', regel, 'mutatie');   // review wv2985 ronde 5
      // wv2985: FX staat alleen bij de valutawissel aan de kant van de vreemde valuta (Valuta Creditering/Debitering in USD), vreemde valuta per euro
      if (fx) {
        if (!(fx.n > 0)) throw new LeesFout('FX moet groter dan nul zijn', regel, 'fx');
        if (!mutatie || mutatie.valuta === 'EUR' || !/^valuta (creditering|debitering)$/i.test(omschrijving)) throw new LeesFout('FX hoort alleen bij een valutawissel in vreemde valuta', regel, 'fx');
      } else if (mutatie && mutatie.valuta !== 'EUR' && /^valuta (creditering|debitering)$/i.test(omschrijving)) throw new LeesFout('FX ontbreekt bij een valutawissel in ' + mutatie.valuta, regel, 'fx');   // review wv2985 MOET 1
      const basis = [datum, tijd, isin, omschrijving, mutatie ? mutatie.valuta + mutatie.cent : '', saldo ? saldo.valuta + saldo.cent : '', order].join('|');
      telling[basis] = (telling[basis] || 0) + 1;
      const r = { sleutel: 'rk:' + sha(basis + '#' + telling[basis]).slice(0, 32), datum, tijd, valutadatum, naam: veld(rij, kaart.product) || null, isin: isin || null,
        omschrijving, mutatie_cent: mutatie ? mutatie.cent : null, mutatie_valuta: mutatie ? mutatie.valuta : null, saldo_cent: saldo ? saldo.cent : null,
        saldo_valuta: saldo ? saldo.valuta : null, order_id: order || null, regel };
      if (fx) Object.defineProperty(r, '_fx', { value: fx, enumerable: false });
      uit.push(r);
      if (mutatie && saldo) (perValuta[saldo.valuta] = perValuta[saldo.valuta] || []).push(r);
    }
    // MOET 1 (review vooraf): per valuta moet het saldo doorlopen. wv2985 (Davids export): altijd nieuw → oud, ook binnen één minuut; oud → nieuw = weigeren.
    for (const [val, rs] of Object.entries(perValuta)) {
      for (let i = 0; i + 1 < rs.length; i++) {
        if (rs[i + 1].saldo_cent + rs[i].mutatie_cent !== rs[i].saldo_cent) throw new LeesFout('het saldo in ' + val + ' loopt niet door van onder naar boven (DEGIRO zet de nieuwste regel bovenaan)', rs[i].regel, 'saldo');
      }
    }
    // datum en tijd lopen van nieuw (boven) naar oud (onder)
    for (let i = 0; i + 1 < uit.length; i++) if (uit[i].datum + uit[i].tijd < uit[i + 1].datum + uit[i + 1].tijd) throw new LeesFout('regels staan niet van nieuw naar oud', uit[i + 1].regel, 'datum');
    // wv2985: bij een valutawissel met FX moet de euroregel van dezelfde order het bedrag / FX zijn (tegengesteld teken); staat die er niet in, dan niet te toetsen
    const vreemd = {};   // review wv2985 ronde 3: één wissel in vreemde valuta per order (gemeten), anders telt de euroregel dubbel
    for (const r of uit) if (r._fx != null) { if (vreemd[r.order_id]) throw new LeesFout('twee valutawissels in vreemde valuta bij één order', r.regel, 'mutatie'); vreemd[r.order_id] = true; }
    for (const r of uit) {
      if (r._fx == null || !r.order_id) continue;
      const eur = uit.filter((x) => x.order_id === r.order_id && x.mutatie_valuta === 'EUR' && /^valuta (creditering|debitering)$/i.test(x.omschrijving));
      if (eur.length > 1) throw new LeesFout('twee eurowissels bij één order', eur[1].regel, 'mutatie');
      if (!eur.length) continue;
      const e = eur[0], v = Math.abs(r.mutatie_cent) / 100 / r._fx.n, w = Math.abs(e.mutatie_cent) / 100;
      if (Math.sign(e.mutatie_cent) === Math.sign(r.mutatie_cent) || Math.abs(v - w) > wisselTol(w, r._fx)) throw new LeesFout('valutawissel klopt niet: bedrag / FX is niet de euroregel van dezelfde order', r.regel, 'fx');
    }
  }
  return { soort, rijen: uit, decimaal: dec, scheiding: sep, overgeslagen };
}

// ── rekenwerk ──
const pct = (a, b) => (b > 0 ? (a / b) * 100 : null);
const rond = (x) => (x == null ? null : Math.round(x * 10) / 10);
const HISTORIE_MAX = 60;   // wv3006: hooguit zoveel standen op het dashboard
function plusDagen(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function plusMaanden(iso, n) { const d = new Date(iso + 'T12:00:00Z'); const dag = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); const max = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(dag, max)); return d.toISOString().slice(0, 10); }
const pctTekst = (x) => (x == null ? '–' : String(rond(x)).replace('.', ',') + ' %');
const ANTHROPIC_RE = /anthropic/i;

// bereken(data, vandaag) → { verdeling, posities, lampjes, signalen, open_punten }. data = uit leesAlles(); vandaag = 'jjjj-mm-dd'.
function bereken(data, vandaag) {
  const R = data.regels || {};
  const effecten = data.posities.filter((p) => p.regelsoort === 'effect');
  const cash = data.posities.filter((p) => p.regelsoort === 'cash');
  const belegd = effecten.reduce((s, p) => s + p.waarde_eur_cent, 0);
  const groep = { kern: 0, tech: 0, health: 0, leuk: 0, zonder: 0 };
  // wv3755 (nr 907 / L07): opbouwfase. Met een doel (vraag 4) en minder belegd dan dat doel meten de maxima per aandeel en per thema tegen het doel;
  // _maat = aandeel van de maatstaf (doel of wat er staat), _ruw = aandeel van wat er staat (de verdeling blijft altijd op wat er staat).
  const doelCent = R.doel_euro != null && Number(R.doel_euro) > 0 ? Math.round(Number(R.doel_euro) * 100) : null;
  const opbouwActief = doelCent != null && belegd > 0 && belegd < doelCent;
  const maatstaf = opbouwActief ? doelCent : belegd;
  const posities = effecten.map((p) => {
    const soort = data.soorten[p.sleutel] || null;
    groep[soort || 'zonder'] += p.waarde_eur_cent;
    return Object.assign({}, p, { soort, aandeel: rond(pct(p.waarde_eur_cent, belegd)), _ruw: pct(p.waarde_eur_cent, belegd), _maat: pct(p.waarde_eur_cent, maatstaf) });
  }).sort((a, b) => b.waarde_eur_cent - a.waarde_eur_cent);
  const g = (k) => pct(groep[k], belegd);
  const ruw = { kern: g('kern'), tech: g('tech'), health: g('health'), eigen: pct(groep.tech + groep.health, belegd), leuk: g('leuk') };   // review achteraf ZOU 1
  const maatThema = { tech: pct(groep.tech, maatstaf), health: pct(groep.health, maatstaf) };   // wv3755: thema tegen de maatstaf
  const opbouw = doelCent == null ? null : { doel_cent: doelCent, belegd_cent: belegd, pct: rond(pct(belegd, doelCent)), actief: opbouwActief };
  const tegenDoel = opbouwActief ? ' van je doel' : '';
  const opbouwZin = opbouwActief ? 'Opbouwfase: je hebt ' + pctTekst(opbouw.pct) + ' van je doel van ' + euroCent(doelCent) + ' belegd; dit maximum meet tegen je doel. ' : '';
  const verdeling = { belegd_cent: belegd, cash_cent: cash.reduce((s, p) => s + p.waarde_eur_cent, 0), kern: rond(g('kern')), tech: rond(g('tech')), health: rond(g('health')),
    eigen: rond(pct(groep.tech + groep.health, belegd)), leuk: rond(g('leuk')), zonder: rond(g('zonder')), zonder_aantal: posities.filter((p) => !p.soort).length };
  const heeftStand = belegd > 0;
  const onvolledig = !!data.aankoop_onvolledig;   // wv3030: stand uit transacties die niet compleet zijn → niets beoordelen, geen signalen op de verdeling
  const volledig = heeftStand && verdeling.zonder_aantal === 0 && !onvolledig;
  const beoordeel = heeftStand && !onvolledig;
  const waarom = !heeftStand ? 'Nog geen stand.' : onvolledig ? 'Je transacties zijn niet compleet; lees je portefeuille in.' : 'Eerst bij elke positie de soort kiezen.';
  const lampjes = [];
  const VRAAG_VAN = { kern: 7, eigen: 7, leuk: 7, max_aandeel: 8, max_thema: 8, herbalans: 14, afkoel: 13, koop_niet: 10 };
  const lamp = (sleutel, naam, grens, stand, binnen, uitleg) => lampjes.push({ sleutel, naam, grens, stand,
    lamp: binnen === null ? 'grijs' : binnen ? 'groen' : 'oranje', uitleg, vraag: VRAAG_VAN[sleutel] || null });
  // wv3030: een regel zonder getal heet alleen "nog niet gezet" zolang zijn vraag open is; is de vraag beantwoord (in woorden), dan "geen getal"
  const beantwoord = (nr) => !!(data.antwoorden && data.antwoorden[nr] && data.antwoorden[nr].status === 'beantwoord');
  const zonderGetal = (sleutel, naam, stand) => { const nr = VRAAG_VAN[sleutel];
    return beantwoord(nr) ? lamp(sleutel, naam, 'geen getal', stand, null, 'Vraag ' + nr + ' beantwoord zonder getal: de app rekent dit niet na.')
      : lamp(sleutel, naam, 'nog niet gezet', stand, null, 'Vraag ' + nr + ' in je plan.'); };
  const band = (sleutel, naam, min, max, waarde) => {
    if (min == null && max == null) return zonderGetal(sleutel, naam, pctTekst(waarde));
    const grens = (min != null ? pctTekst(min) : '0 %') + ' – ' + (max != null ? pctTekst(max) : '100 %');
    if (!volledig) return lamp(sleutel, naam, grens, pctTekst(waarde), null, waarom);
    const r = ruw[sleutel];
    const b = (min == null || r >= min - 1e-9) && (max == null || r <= max + 1e-9);
    lamp(sleutel, naam, grens, pctTekst(waarde), b, b ? 'Binnen je bandbreedte.' : 'Buiten je bandbreedte.');
    return b;
  };
  const kernOk = band('kern', 'Kern (indexfondsen)', R.kern_min, R.kern_max, verdeling.kern);
  const eigenOk = band('eigen', 'Eigen keuzes (tech + health)', R.eigen_min, R.eigen_max, verdeling.eigen);
  const leukOk = R.leuk_max == null ? zonderGetal('leuk', 'Voor de leuk', pctTekst(verdeling.leuk))
    : band('leuk', 'Voor de leuk', null, R.leuk_max, verdeling.leuk);
  const signalen = [];
  const sig = (s) => signalen.push(Object.assign({ keuzes: ['niets', 'dagboek', 'herinner'] }, s));
  const standDatum = data.stand_datum || 'geen';
  // wv3030: stand uit transacties = aankoopwaarde (geen koersen); dat staat dan ook in de signaaltekst
  const volgens = data.stand_bron === 'aankoop' ? 'Op aankoopwaarde (je transacties tot en met ' + standDatum + ')' : 'Volgens je stand van ' + standDatum;
  const grootste = posities.filter((p) => p.soort && p.soort !== 'kern');
  if (R.max_aandeel == null) zonderGetal('max_aandeel', 'Eén aandeel hoogstens', null);
  else {
    const boven = beoordeel ? grootste.filter((p) => p._maat > R.max_aandeel + 1e-9) : [];
    lamp('max_aandeel', 'Eén aandeel hoogstens', pctTekst(R.max_aandeel) + tegenDoel, grootste.length ? pctTekst(Math.max(...grootste.map((p) => p._maat))) + tegenDoel : '–',
      boven.length ? false : volledig ? true : null, opbouwZin + (boven.length ? boven.length + ' boven je maximum' : volledig ? 'Geen aandeel boven je maximum (kern telt niet mee).' : waarom));
    for (const p of boven) sig({ sleutel: 'max-aandeel:' + p.sleutel + ':' + standDatum + ':' + R.max_aandeel + (opbouwActief ? ':doel' + doelCent : ''), soort: 'boven_maximum', titel: p.naam + ' zit boven je maximum per aandeel',
      wat: volgens + ' is ' + p.naam + ' ' + (opbouwActief ? pctTekst(p._maat) + ' van je doel van ' + euroCent(doelCent) + '.' : pctTekst(p.aandeel) + ' van je beleggingen.'),
      raakt: p.naam + ' (' + SOORT_NAAM[p.soort] + ', ' + pctTekst(p.aandeel) + ' van het geheel)',
      positie: p.sleutel, plan: 'Je maximum voor één aandeel is ' + pctTekst(R.max_aandeel) + (opbouwActief ? ', in je opbouwfase gemeten tegen je doel.' : '.') });
  }
  if (R.max_thema == null) zonderGetal('max_thema', 'Eén thema hoogstens', null);
  else {
    const b = [];
    for (const t of ['tech', 'health']) if (beoordeel && maatThema[t] > R.max_thema + 1e-9) b.push(t);
    lamp('max_thema', 'Eén thema hoogstens', pctTekst(R.max_thema) + tegenDoel, 'tech ' + pctTekst(rond(maatThema.tech)) + ' · health ' + pctTekst(rond(maatThema.health)) + tegenDoel, b.length ? false : volledig ? true : null,
      opbouwZin + (b.length ? b.map((t) => SOORT_NAAM[t]).join(' en ') + ' boven je maximum' : volledig ? 'Beide thema\'s binnen je maximum.' : waarom));
    for (const t of b) sig({ sleutel: 'max-thema:' + t + ':' + standDatum + ':' + R.max_thema + (opbouwActief ? ':doel' + doelCent : ''), soort: 'boven_maximum', titel: SOORT_NAAM[t] + ' zit boven je maximum per thema',
      wat: volgens + ' is ' + SOORT_NAAM[t] + ' samen ' + (opbouwActief ? pctTekst(rond(maatThema[t])) + ' van je doel van ' + euroCent(doelCent) + '.' : pctTekst(verdeling[t]) + ' van je beleggingen.'),
      raakt: 'thema ' + SOORT_NAAM[t], plan: 'Je maximum per thema is ' + pctTekst(R.max_thema) + (opbouwActief ? ', in je opbouwfase gemeten tegen je doel.' : '.') });
  }
  if (R.leuk_max != null && leukOk === false) sig({ sleutel: 'leuk:' + standDatum + ':' + R.leuk_max, soort: 'potje', titel: 'Voor de leuk zit boven je plafond',
    wat: volgens + ' is "voor de leuk" ' + pctTekst(verdeling.leuk) + ' van je beleggingen.', raakt: 'potje voor de leuk', plan: 'Je plafond is ' + pctTekst(R.leuk_max) + '.' });
  // herbalanceren
  const maand = Number(vandaag.slice(5, 7));
  if (!R.herbalans_wijze) zonderGetal('herbalans', 'Herbalanceren', null);
  else if (R.herbalans_wijze === 'momenten') {
    const ms = Array.isArray(R.herbalans_maanden) ? R.herbalans_maanden : [];
    const nu = ms.includes(maand);
    lamp('herbalans', 'Herbalanceren', ms.length ? 'in maand ' + ms.join(', ') : 'geen maanden ingevuld', nu ? 'deze maand' : '–', ms.length ? !nu : null, nu ? 'Het is een herbalansmaand.' : 'Geen herbalansmaand.');
    if (nu) sig({ sleutel: 'herbalans:' + vandaag.slice(0, 7), soort: 'herbalans', titel: 'Herbalansmoment', wat: 'Deze maand staat in je plan als herbalansmoment.',
      raakt: 'de verdeling (kern ' + pctTekst(verdeling.kern) + ', eigen keuzes ' + pctTekst(verdeling.eigen) + ', voor de leuk ' + pctTekst(verdeling.leuk) + ')',
      plan: 'Je herbalanceert in maand ' + ms.join(', ') + '; bij voorkeur met nieuwe inleg.' });
  } else {
    const af = kernOk === false || eigenOk === false;
    lamp('herbalans', 'Herbalanceren', 'als een deel buiten zijn bandbreedte komt', af ? 'buiten' : 'binnen', volledig ? !af : null, af ? 'Een deel staat buiten zijn bandbreedte.' : 'Alles binnen.');
    if (af) sig({ sleutel: 'herbalans:afwijking:' + standDatum, soort: 'herbalans', titel: 'Tijd om te herbalanceren', wat: 'Een deel van je verdeling staat buiten zijn bandbreedte.',
      raakt: 'kern ' + pctTekst(verdeling.kern) + ', eigen keuzes ' + pctTekst(verdeling.eigen), plan: 'Je herbalanceert als een deel buiten zijn bandbreedte komt.' });
  }
  if (R.afkoel_dagen == null) zonderGetal('afkoel', 'Afkoeltijd', null);
  else lamp('afkoel', 'Afkoeltijd', R.afkoel_dagen + ' dagen', null, true, 'Een herinnering na een signaal komt na zoveel dagen terug.');
  // koop ik niet
  const koopNiet = Array.isArray(R.koop_niet) ? R.koop_niet.filter(Boolean) : [];
  const raakNiet = (naam) => koopNiet.find((k) => k.length >= 3 && String(naam || '').toLowerCase().includes(k.toLowerCase()));
  const treffers = [];
  for (const p of posities) { const k = raakNiet(p.naam); if (k) treffers.push({ wat: p.naam, k, s: 'positie:' + p.sleutel }); }
  for (const v of data.volglijst) { const k = raakNiet(v.naam); if (k) treffers.push({ wat: v.naam, k, s: 'volg:' + v.id }); }
  if (!koopNiet.length) zonderGetal('koop_niet', 'Koop ik niet', null);
  else lamp('koop_niet', 'Koop ik niet', koopNiet.length + (koopNiet.length === 1 ? ' bedrijf' : ' bedrijven'), treffers.length ? treffers.length + ' treffer' : 'geen treffer', !treffers.length,
    treffers.length ? 'Iets in je stand of volglijst staat op je lijst.' : 'Niets in je stand of volglijst staat op je lijst.');
  for (const t of treffers) sig({ sleutel: 'koop-niet:' + t.s, soort: 'koop_niet', titel: t.wat + ' staat op je lijst "koop ik niet"', wat: t.wat + ' lijkt op "' + t.k + '" uit je lijst.',
    raakt: t.s.startsWith('volg:') ? 'je volglijst' : 'je stand', plan: 'Vraag 10: bedrijven waar je zakelijk mee te maken hebt.' });
  // dagboek: transactie zonder regel, terugblik. wv3727 (David Ja 21-11, nr 160): één vraag per aandeel per dag en richting; twee orders van
  // hetzelfde aandeel op één dag zijn één aankoop. De groep hangt aan zijn eerste transactie (sleutel 'dagboek:<eerste>'): een regel of "Niets doen"
  // bij één van de orders geldt voor de hele groep (ook de keuzes van vóór wv3727, die per order werden gezet).
  const metRegel = new Set(data.dagboek.filter((d) => d.transactie_sleutel && (d.waarom || d.blijven || d.verkoop_wanneer)).map((d) => d.transactie_sleutel));
  const groepen = dagboekGroepen(data.transacties);
  const groepMetRegel = (g) => g.leden.some((x) => metRegel.has(x));
  const groepNiets = (g) => g.leden.some((x) => { const k = data.keuzes['dagboek:' + x]; return !!(k && k.keuze === 'niets'); });
  for (const g of groepen) if (!groepMetRegel(g)) sig({ sleutel: 'dagboek:' + g.eerste, soort: 'dagboek', titel: 'Transactie zonder dagboekregel: ' + g.naam,
    wat: 'Op ' + g.datum + ' ' + (g.erbij ? 'kwam er ' : 'ging er ') + g.aantal.replace('.', ',') + ' ' + g.naam + (g.erbij ? ' bij' : ' af') + (g.leden.length > 1 ? ' (' + g.leden.length + ' orders).' : '.'),
    raakt: g.naam, transactie: g.eerste, transacties: g.leden, plan: 'Na een transactie schrijf je één keer waarom.', keuzes: ['dagboek', 'niets'] });
  // wv3758: een aankoopmail van DEGIRO die de mailronde niet kon lezen (nooit geraden); de export vult het gat
  for (const t of data.mail_verschil || []) sig({ sleutel: 'mailverschil:' + t.sleutel, soort: 'mail', titel: 'Aankoop uit je mail staat niet in je export: ' + t.naam,
    wat: 'Op ' + t.datum + ' las ik deze transactie uit je DEGIRO-mail, maar je Transacties-export over die dagen heeft hem niet. Kijk in DEGIRO welke klopt.',
    raakt: t.naam, transactie: t.sleutel, plan: 'De export per kwartaal is de controle op wat uit je mail kwam.', keuzes: ['niets'] });
  for (const m of data.mail_fout || []) sig({ sleutel: 'mailfout:' + m.gmail_id, soort: 'mail', titel: 'Een aankoopmail van DEGIRO kon ik niet lezen',
    wat: 'Mail van ' + (m.mail_datum || 'onbekende datum') + '. Lees je Transacties-export van DEGIRO in, dan staat de aankoop er alsnog in.', plan: 'Aankopen komen vanzelf uit je DEGIRO-mail; de export is de controle.', keuzes: ['niets'] });
  for (const d of data.dagboek) {
    for (const [m, veldNaam] of [[6, 'terugblik6'], [12, 'terugblik12']]) {
      const op = plusMaanden(d.datum, m);
      if (op <= vandaag && !d[veldNaam]) sig({ sleutel: 'terugblik' + m + ':' + d.id, soort: 'terugblik', titel: 'Terugblik na ' + m + ' maanden: ' + d.naam,
        wat: 'Op ' + d.datum + ' schreef je over ' + d.naam + '. Dat is nu ' + m + ' maanden geleden.', raakt: d.naam, schreef: d.waarom || null, dagboek: d.id,
        plan: 'Lees terug wat je schreef: klopt de reden nog?', keuzes: ['dagboek', 'niets'] });
    }
  }
  // Davids eigen woorden bij een positie (dagboek, nieuwste eerst)
  const woorden = {};
  for (const d of data.dagboek.slice().sort((a, b) => (a.datum < b.datum ? 1 : -1))) {
    const tx = data.transacties.find((t) => t.sleutel === d.transactie_sleutel);
    const sl = tx && tx.isin ? 'isin:' + tx.isin : 'naam:' + String(d.naam).toLowerCase();
    if (!woorden[sl] && d.waarom) woorden[sl] = d.waarom;
  }
  for (const s of signalen) if (!s.schreef && s.positie && woorden[s.positie]) s.schreef = woorden[s.positie];
  // wv3755 (nr 911 / L11, David Ja 21-11 13:19): je eigen woorden bij een flinke daling. data.daling (uit overzicht) = per positie de waarde nu en
  // bij aankoop (alleen als beide bekend zijn). Zakt een positie minstens de drempel (vraag 6, anders 30 %) onder de aankoopwaarde, dan een signaal
  // met je antwoord op vraag 6 en je nieuwste dagboekregel "wanneer verkoop ik"; "Niets doen" voorop. Alleen in de app (zoals elk signaal).
  const drempel = R.daling_pct != null ? Number(R.daling_pct) : DALING_STANDAARD;
  const verkoopWoorden = eigenVerkoop(data);
  const a6 = data.antwoorden && data.antwoorden[6] && data.antwoorden[6].status === 'beantwoord' ? data.antwoorden[6].tekst || null : null;
  const dalingen = [];
  for (const p of posities) {
    const x = data.daling && data.daling[p.sleutel];
    if (!x || !(x.aankoop_cent > 0) || x.waarde_cent == null || drempel <= 0) continue;
    const daling = (x.aankoop_cent - x.waarde_cent) / x.aankoop_cent * 100;
    if (daling < drempel - 1e-9) continue;
    const vw = verkoopWoorden[p.sleutel] || null;
    dalingen.push(p.sleutel);
    sig({ sleutel: 'daling:' + p.sleutel + ':' + drempel + ':' + x.aankoop_cent, soort: 'daling', titel: p.naam + ' staat ' + pctTekst(daling) + ' lager dan bij aankoop',
      wat: (x.bron === 'koers' ? 'Volgens de slotkoers van ' + x.datum : 'Volgens je stand van ' + x.datum) + ' is ' + p.naam + ' ' + euroCent(x.waarde_cent) + ' waard; bij aankoop was dat ' +
        euroCent(x.aankoop_cent) + ' (met kosten).', raakt: p.naam + (p.soort ? ' (' + SOORT_NAAM[p.soort] + ')' : ''), positie: p.sleutel, daling: rond(daling), schreef: woorden[p.sleutel] || null,
      eigen: { plan6: a6, verkoop_wanneer: vw ? vw.tekst : null, verkoop_datum: vw ? vw.datum : null },
      plan: R.daling_pct != null ? 'Je liet je eigen woorden terugzien vanaf ' + pctTekst(drempel) + ' daling (vraag 6).' : 'De app toont je eigen woorden vanaf ' + pctTekst(drempel) + ' daling; dat is de standaard, zelf in te stellen bij vraag 6.',
      keuzes: ['niets', 'dagboek', 'herinner'] });
  }
  // Davids keuze bij een signaal
  const keuzeVan = (s) => data.keuzes[s.sleutel] || (s.transacties || []).map((x) => data.keuzes['dagboek:' + x]).find((k) => k && k.keuze === 'niets');   // wv3727: groep
  const zichtbaar = signalen.filter((s) => { const k = keuzeVan(s); if (!k) return true; if (k.keuze === 'niets') return false; return !(k.tot && k.tot > vandaag); });
  // open punten
  const open = [];
  for (const v of VRAGEN) { const a = data.antwoorden[v.nr]; if (!a || a.status === 'overgeslagen') open.push({ soort: 'vraag', vraag: v.nr, tekst: 'Vraag ' + v.nr + (a ? ' overgeslagen' : ' nog niet beantwoord') }); }
  for (const p of posities) if (!p.soort) open.push({ soort: 'positie', sleutel: p.sleutel, tekst: p.naam + ': kies kern, tech, health of voor de leuk' });
  // wv3030: Niets doen = geen open punt meer; wv3727: één open punt per groep (transacties = alle orders van die dag)
  for (const g of groepen) if (!groepMetRegel(g) && !groepNiets(g)) open.push({ soort: 'dagboek', transactie: g.eerste, transacties: g.leden, tekst: g.naam + ' (' + g.datum + '): nog geen dagboekregel' });
  const anthropic = posities.some((p) => ANTHROPIC_RE.test(p.naam)) || data.volglijst.some((v) => ANTHROPIC_RE.test(v.naam + ' ' + (v.code || '')));
  zichtbaar.sort((a, b) => (a.soort === 'daling' ? 0 : 1) - (b.soort === 'daling' ? 0 : 1));   // wv3755: een flinke daling staat bovenaan (Aandacht-tegel)
  return { verdeling, posities, cash, lampjes, signalen: zichtbaar, signalen_verborgen: signalen.length - zichtbaar.length, open_punten: open,
    belang: anthropic ? ANTHROPIC_ZIN : null, volledig, woorden, opbouw, daling_drempel: drempel, daling_standaard: R.daling_pct == null };
}

// wv3755: standaarddrempel voor "je eigen woorden bij een flinke daling" zolang vraag 6 geen getal heeft
const DALING_STANDAARD = 30;
// wv3755: per positie de nieuwste dagboekregel met "wanneer verkoop ik" (positiesleutel via de transactie, anders de naam)
function eigenVerkoop(data) {
  const uit = {};
  for (const d of data.dagboek.slice().sort((a, b) => (a.datum < b.datum ? 1 : a.datum > b.datum ? -1 : (b.id || 0) - (a.id || 0)))) {
    if (!d.verkoop_wanneer) continue;
    const tx = data.transacties.find((t) => t.sleutel === d.transactie_sleutel);
    const sl = tx ? (tx.isin ? 'isin:' + tx.isin : 'naam:' + String(tx.naam).toLowerCase()) : 'naam:' + String(d.naam).toLowerCase();
    if (!uit[sl]) uit[sl] = { tekst: d.verkoop_wanneer, datum: d.datum };
    if (!tx) {   // losse regel (zonder transactie): ook op ISIN-posities met dezelfde naam
      for (const p of data.posities) if (p.isin && String(p.naam).toLowerCase() === String(d.naam).toLowerCase() && !uit[p.sleutel]) uit[p.sleutel] = { tekst: d.verkoop_wanneer, datum: d.datum };
    }
  }
  return uit;
}
// wv3727: transacties gegroepeerd per dag, aandeel (ISIN, anders naam) en richting; eerste = vroegste order (tijd, dan sleutel). aantal = som als tekst.
function dagboekGroepen(transacties) {
  const per = new Map();
  for (const t of transacties) {
    const erbij = Number(t.aantal) > 0;
    const k = t.datum + '|' + (t.isin ? 'isin:' + t.isin : 'naam:' + String(t.naam).toLowerCase()) + '|' + (erbij ? '+' : '-');
    if (!per.has(k)) per.set(k, { datum: t.datum, naam: t.naam, erbij, tx: [] });
    per.get(k).tx.push(t);
  }
  const uit = [];
  for (const g of per.values()) {
    g.tx.sort((a, b) => ((a.tijd || '') + a.sleutel < (b.tijd || '') + b.sleutel ? -1 : 1));
    const dec = Math.max(0, ...g.tx.map((t) => (String(t.aantal).split('.')[1] || '').length));
    const som = g.tx.reduce((n, t) => n + Math.abs(Number(t.aantal)), 0);
    uit.push({ datum: g.datum, naam: g.naam, erbij: g.erbij, eerste: g.tx[0].sleutel, leden: g.tx.map((t) => t.sleutel), aantal: String(Number(som.toFixed(dec))) });
  }
  return uit.sort((a, b) => (a.datum < b.datum ? 1 : a.datum > b.datum ? -1 : 0));
}

// wv3756 (nr 908 / L08, David Ja 21-11): naam zoals David hem zegt ("Nvidia", "NVDA") tegen de naam in de export ("NVIDIA CORP"). Kleine letters,
// zonder rechtsvorm/aandelenklasse en leestekens; past als de ene vorm als heel woord(groep) in de andere staat ("arm" past niet in "pharma").
function zoekVorm(n) {
  return ' ' + String(n || '').toLowerCase().replace(/[,.]/g, ' ').replace(/\b(inc|incorporated|corp|corporation|co|company|nv|n v|sa|se|ag|plc|ltd|limited|holdings?|group|a\/s|as|asa|ab|spa|bv|class [a-c]|cl [a-c]|adr|ord|reg|shs)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
}
function pastNaam(gezegd, naam) { const a = zoekVorm(gezegd), b = zoekVorm(naam); return a.trim().length >= 2 && b.trim().length >= 2 && (b.includes(a) || a.includes(b)); }

// wv3728 (nr 138 / 2C38): waarde van vandaag uit de dagkoersen die de ochtendronde ophaalt. Per positie: aantal × laatste slotkoers, omgerekend met
// de ECB-koers van die dag (of de laatste ervóór); de vorige beursdag op dezelfde manier ("sinds gisteren"); aankoopwaarde uit de transacties.
// Geen koers, een koers in een andere valuta dan de positie, of geen wisselkoers = die positie "zonder koers" (niet raden); het totaal staat er
// alleen als elke positie een koers heeft. Valt de bron weg, dan blijft de laatst bekende koers staan met zijn datum (oud = ouder dan 4 dagen).
// koersen: { isin: [{ datum, slot, valuta }] nieuwste eerst }; wissels: { valuta: [{ datum, per_eur }] nieuwste eerst }; aankoop: { sleutel: cent }.
const KOERS_OUD_DAGEN = 4;
function wisselOp(wissels, valuta, datum) {
  if (valuta === 'EUR') return 1;
  const r = (wissels[valuta] || []).find((x) => x.datum <= datum);
  const n = r ? Number(r.per_eur) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
function waardeVandaag(posities, koersen, wissels, aankoop, vandaag) {
  const effect = posities.filter((p) => p.regelsoort === 'effect');
  if (!effect.length) return null;
  const per = {};
  let totaal = 0, vorig = 0, kost = 0, zonder = 0, zonderVorig = 0, zonderKost = 0, oudste = null, nieuwste = null, wisselDatum = null;
  for (const p of effect) {
    const n = Number(p.aantal);
    const ks = (p.isin && koersen[p.isin]) || [];
    const k0 = ks[0];
    const reden = !p.isin ? 'geen ISIN' : !k0 ? 'nog geen koers' : !Number.isFinite(n) || n <= 0 ? 'geen aantal' : p.valuta && k0.valuta !== p.valuta ? 'koers in ' + k0.valuta + ', positie in ' + p.valuta : null;
    const fx0 = reden ? null : wisselOp(wissels, k0.valuta, k0.datum);
    if (reden || fx0 == null) { zonder++; zonderVorig++; per[p.sleutel] = { reden: reden || 'geen wisselkoers' }; continue; }
    const w0 = Math.round((n * Number(k0.slot) / fx0) * 100);
    const k1 = ks[1], fx1 = k1 ? wisselOp(wissels, k1.valuta, k1.datum) : null;
    const w1 = k1 && fx1 != null && k1.valuta === k0.valuta ? Math.round((n * Number(k1.slot) / fx1) * 100) : null;
    const a = aankoop[p.sleutel] != null ? aankoop[p.sleutel] : null;
    per[p.sleutel] = { koers: k0.slot, valuta: k0.valuta, datum: k0.datum, waarde_cent: w0, vorige_datum: k1 ? k1.datum : null, vorige_cent: w1, aankoop_cent: a };
    totaal += w0;
    if (w1 == null) zonderVorig++; else vorig += w1;
    if (a == null) zonderKost++; else kost += a;
    if (!oudste || k0.datum < oudste) oudste = k0.datum;
    if (!nieuwste || k0.datum > nieuwste) nieuwste = k0.datum;
    if (k0.valuta !== 'EUR') { const r = (wissels[k0.valuta] || []).find((x) => x.datum <= k0.datum); if (r && (!wisselDatum || r.datum < wisselDatum)) wisselDatum = r.datum; }
  }
  const alle = zonder === 0;
  return { volledig: alle, zonder_koers: zonder, koers_datum: oudste, koers_datum_nieuwste: nieuwste, wissel_datum: wisselDatum,
    oud: !!(oudste && vandaag && oudste < plusDagen(vandaag, -KOERS_OUD_DAGEN)),
    waarde_cent: alle ? totaal : null, gisteren_cent: alle && zonderVorig === 0 ? vorig : null, verschil_dag_cent: alle && zonderVorig === 0 ? totaal - vorig : null,
    aankoop_cent: alle && zonderKost === 0 ? kost : null, verschil_aankoop_cent: alle && zonderKost === 0 ? totaal - kost : null, posities: per };
}
// Aankoopwaarde per positie uit de transacties, alleen als het aantal uit de transacties gelijk is aan het aantal in de stand (anders onbekend).
function aankoopPer(posities, transacties) {
  const a = aankoopStand(transacties);
  const uit = {};
  for (const p of posities) {
    if (p.regelsoort !== 'effect') continue;
    if (p.bron === 'aankoop') { if (!p.onvolledig) uit[p.sleutel] = p.waarde_eur_cent; continue; }
    const x = a.posities.find((y) => y.sleutel === p.sleutel);
    if (x && !x.onvolledig && Math.abs(Number(x.aantal) - Number(p.aantal)) < 1e-6) uit[p.sleutel] = x.waarde_eur_cent;
  }
  return uit;
}

// ── wv3754 (besluiten nr 905 = L05 en nr 909 = L09, David Ja 21-11 13:18/13:19): levend dashboard en geld-tegels ──
// Daglijn: de waarde van je posities per beursdag uit de dagkoersen (ochtendronde) en de ECB-koers van die dag. Aantal per dag = het aantal nu
// min wat er daarna gekocht is (plus wat er daarna verkocht is), uit je eigen transacties; komt dat onder nul, dan dekken je transacties de stand
// niet en telt die positie op die dag als 0 (onvolledig). Een positie zonder enige dagkoers doet niet mee (posities_zonder). Een dag zonder koers
// (feestdag) neemt de vorige slotkoers tot 4 dagen terug; ontbreekt een koers of wisselkoers langer, dan valt die dag weg (niet raden).
// Vergelijking: rendement per dag op de posities van de dag ervoor (koers en wisselkoers, zonder bijstorten), naast het wereldindexfonds in euro,
// beide 100 op de eerste gezamenlijke dag. Eigen keuzes = soort tech of health; zonder die soort: al je aandelen (en dat staat in de naam).
const WERELD = { sleutel: 'IDX:URTH', code: 'URTH', naam: 'Wereldindex (MSCI World)' };
const RE_INDEX = /^IDX:[A-Z]{1,6}$/;
const LIJN_MAX = 260;
function koersOp(rij, datum) {   // rij oplopend; laatste slot op of vóór datum, hooguit 4 dagen oud
  let k = null;
  for (const x of rij) { if (x.datum > datum) break; k = x; }
  return k && k.datum >= plusDagen(datum, -KOERS_OUD_DAGEN) ? k : null;
}
function wisselRecent(wissels, valuta, datum) {   // wissels aflopend; hooguit 7 dagen oud
  if (valuta === 'EUR') return 1;
  const r = (wissels[valuta] || []).find((w) => w.datum <= datum && w.datum >= plusDagen(datum, -7));
  const n = r ? Number(r.per_eur) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
function daglijn(posities, transacties, reeks, wissels, soorten, vandaag) {
  const effect = posities.filter((p) => p.regelsoort === 'effect');
  const mee = effect.filter((p) => p.isin && (reeks[p.isin] || []).length && Number(p.aantal) > 0);
  const uit = { punten: [], posities_in: mee.length, posities_zonder: effect.length - mee.length, onvolledig: false, vergelijk: null };
  if (!mee.length) return uit;
  const txVan = {};
  for (const t of transacties) if (t.isin && Number.isFinite(Number(t.aantal))) (txVan[t.isin] || (txVan[t.isin] = [])).push(t);
  const aantalOp = (p, d) => {
    let a = Number(p.aantal);
    for (const t of txVan[p.isin] || []) if (t.datum > d) a -= Number(t.aantal);
    if (a < -1e-6) { uit.onvolledig = true; return 0; }
    return a < 1e-9 ? 0 : a;
  };
  const dagen = [...new Set(mee.flatMap((p) => reeks[p.isin].map((x) => x.datum)))].filter((d) => d < vandaag).sort();
  const eigenSoort = mee.some((p) => soorten[p.sleutel] === 'tech' || soorten[p.sleutel] === 'health');
  const inEigen = (p) => !eigenSoort || soorten[p.sleutel] === 'tech' || soorten[p.sleutel] === 'health';
  const prijs = (p, d) => { const k = koersOp(reeks[p.isin], d); if (!k) return null; const fx = wisselRecent(wissels, k.valuta, d); return fx == null ? null : Number(k.slot) / fx; };
  const rij = [];
  for (const d of dagen) {
    let w = 0, ok = true, iets = false;
    const a = {}, pr = {};
    for (const p of mee) {
      a[p.sleutel] = aantalOp(p, d);
      if (!a[p.sleutel]) continue;
      pr[p.sleutel] = prijs(p, d);
      if (pr[p.sleutel] == null) { ok = false; break; }
      w += a[p.sleutel] * pr[p.sleutel]; iets = true;
    }
    if (ok && iets) rij.push({ datum: d, waarde_cent: Math.round(w * 100), a, pr });
  }
  const laatste = rij.slice(-LIJN_MAX);
  uit.punten = laatste.map((x) => ({ datum: x.datum, waarde_cent: x.waarde_cent }));
  // vergelijking (review wv3754 ronde 2): eerst een eigen keten per beursdag van de daglijn (rendement op de stukken van de dag ervoor; zonder
  // eigen stukken op de dag ervoor of zonder prijs schuift de keten door met behoud van het opgebouwde rendement), daarna alleen de dagen waarop
  // ook het wereldindexfonds een koers heeft, beide 100 op de eerste gezamenlijke dag.
  const idx = reeks[WERELD.sleutel] || [];
  if (laatste.length >= 2 && idx.length) {
    const keten = [];
    let e = null;
    for (let i = 0; i < laatste.length; i++) {
      const x = laatste[i], g = i ? laatste[i - 1] : null;
      if (e == null) { if (mee.some((p) => inEigen(p) && x.a[p.sleutel])) e = 1; else continue; keten.push({ x, e }); continue; }
      let oud = 0, nieuw = 0, ok = true;
      for (const p of mee) {
        if (!inEigen(p) || !g.a[p.sleutel]) continue;
        const pn = x.pr[p.sleutel] != null ? x.pr[p.sleutel] : prijs(p, x.datum);
        if (pn == null || g.pr[p.sleutel] == null) { ok = false; break; }
        oud += g.a[p.sleutel] * g.pr[p.sleutel]; nieuw += g.a[p.sleutel] * pn;
      }
      if (ok && oud > 0) e *= nieuw / oud;
      keten.push({ x, e });
    }
    const punten = [];
    let e0 = null, i0 = null;
    for (const { x, e: ex } of keten) {
      const ki = koersOp(idx, x.datum), fx = ki ? wisselRecent(wissels, ki.valuta, x.datum) : null;
      const iw = ki && fx != null ? Number(ki.slot) / fx : null;
      if (iw == null) continue;
      if (e0 == null) { e0 = ex; i0 = iw; }
      punten.push({ datum: x.datum, eigen: Math.round((ex / e0) * 10000) / 100, index: Math.round((iw / i0) * 10000) / 100 });
    }
    if (punten.length >= 2) uit.vergelijk = { eigen_naam: eigenSoort ? 'Je eigen keuzes' : 'Je aandelen', index_naam: WERELD.naam, index_code: WERELD.code, punten };
  }
  return uit;
}

// Geld-tegels (L09): alleen uit Davids eigen exports. Ingelegd = stortingen min opnames in het rekeningoverzicht (euro; de reservering van een
// iDEAL-storting en het terugdraaien ervan heffen elkaar op). Kosten = transactiekosten en AutoFX-kosten uit de transacties + overige kosten uit het
// rekeningoverzicht (aansluiting e.d.; de transactiekosten staan daar ook, die tellen niet nog eens). Resultaat na kosten = waarde vandaag min de
// aankoopwaarde incl. kosten, plus wat verkopen opleverden na kosten, plus dividend na dividendbelasting, min overige kosten. Ontbreekt een post,
// dan staat dat erbij (nooit raden). Bedragen in centen; kosten positief.
const GELD_RE = /storting|deposit|ideal|opname|withdrawal/i;
const OVERIG_KOSTEN_RE = /kosten|fee|aansluit|connection/i;
const GEEN_OVERIG_RE = /transactiekosten|transaction|autofx|valuta|currency/i;
function geldOverzicht(x) {
  const reken = x.rekening || [], tx = x.transacties || [], vw = x.vandaag || null;
  const u = { ingelegd_cent: null, ingelegd_van: null, ingelegd_tot: null, ingelegd_zonder: 0, rekening: reken.length > 0, transacties: tx.length,
    kosten_cent: null, kosten_transactie_cent: 0, kosten_valuta_cent: 0, kosten_overig_cent: 0, kosten_splits_onbekend: 0, kosten_zonder: 0,
    dividend_cent: 0, dividend_zonder: 0, gerealiseerd_cent: x.gerealiseerd ? x.gerealiseerd.cent : 0, gerealiseerd_onbekend: x.gerealiseerd ? x.gerealiseerd.onbekend : 0,
    resultaat_cent: null, resultaat_reden: null };
  if (reken.length) {
    let som = 0, stort = 0;
    for (const r of reken) {
      if (!r.datum) continue;
      if (!u.ingelegd_van || r.datum < u.ingelegd_van) u.ingelegd_van = r.datum;
      if (!u.ingelegd_tot || r.datum > u.ingelegd_tot) u.ingelegd_tot = r.datum;
      const o = String(r.omschrijving || ''), m = r.mutatie_cent;
      if (m == null) continue;
      const eur = (r.mutatie_valuta || 'EUR') === 'EUR';
      if (GELD_RE.test(o) && !/valuta/i.test(o)) { stort++; if (eur) som += m; else u.ingelegd_zonder++; }
      else if (/dividend/i.test(o)) {
        const fx = eur ? 1 : wisselOp(x.wissels || {}, r.mutatie_valuta, r.datum);
        if (fx == null) u.dividend_zonder++; else u.dividend_cent += Math.round(m / fx);
      } else if (OVERIG_KOSTEN_RE.test(o) && !GEEN_OVERIG_RE.test(o)) { if (eur) u.kosten_overig_cent += -m; else u.kosten_zonder++; }
    }
    u.ingelegd_cent = stort ? som : null;   // geen enkele storting in het overzicht = niet vast te stellen (export begint later dan je eerste storting)
    if (stort) u.ingelegd_bron = 'export';
  }
  // wv3758 (L12): stortingen en opnames uit de bank-lezer (storting = negatieve bankpost). Review MOET 2: de bank vervangt het rekeningoverzicht
  // nooit; met een overzicht tellen alleen bankposten NA zijn laatste dag mee (aansluiten op het overzicht), zonder overzicht de bank vanaf zijn
  // eerste post (de tegel zegt "sinds <datum>"). Een overzicht zonder storting blijft "niet vast te stellen".
  const bank = Array.isArray(x.bank) ? x.bank.filter((b) => b && b.datum && Number.isInteger(b.cent)) : [];
  if (bank.length && (!reken.length || u.ingelegd_cent != null)) {
    const na = reken.length ? bank.filter((b) => b.datum > u.ingelegd_tot) : bank;
    if (na.length) {
      u.ingelegd_cent = (u.ingelegd_cent || 0) + na.reduce((s, b) => s - b.cent, 0);
      u.ingelegd_bank = na.length;
      u.ingelegd_bron = reken.length ? 'export+bank' : 'bank';
      for (const b of na) { if (!u.ingelegd_van || b.datum < u.ingelegd_van) u.ingelegd_van = b.datum; if (!u.ingelegd_tot || b.datum > u.ingelegd_tot) u.ingelegd_tot = b.datum; }
    }
  }
  if (tx.length) {
    const fx = x.autofx || new Map();
    for (const t of tx) {
      const k = -(t.kosten_eur_cent || 0);
      const a = t.bron === 'hand' ? 0 : fx.has(t.sleutel) ? fx.get(t.sleutel) : null;
      if (a == null) { u.kosten_splits_onbekend++; u.kosten_transactie_cent += k; continue; }
      u.kosten_valuta_cent += -a; u.kosten_transactie_cent += k + a;
    }
  }
  // review MOET 3: zonder Transacties geen totaal (de transactiekosten zouden als 0 meetellen); de tegel zegt dan "Lees je Transacties in"
  if (tx.length) u.kosten_cent = u.kosten_transactie_cent + u.kosten_valuta_cent + u.kosten_overig_cent;
  if (!vw || vw.waarde_cent == null) u.resultaat_reden = 'koers';
  else if (vw.verschil_aankoop_cent == null) u.resultaat_reden = 'aankoop';
  else u.resultaat_cent = vw.verschil_aankoop_cent + u.gerealiseerd_cent + u.dividend_cent - u.kosten_overig_cent;
  return u;
}

// wv3757 (besluit nr 910 / L10, David Ja 21-11 13:19 met vingerafdruk): waarde op een datum, voor Financiën › Vermogen en de peilwaarde op
// 1 januari. Aantal per positie: met een ingelezen portefeuille (of handstand) de stand van die dag, teruggerekend of doorgerekend met de
// transacties ertussen; zonder portefeuille de som van de transacties tot en met de datum. Koers: de laatst bekende vóór of op de datum, de
// nieuwste van drie bronnen (dagkoers uit de ochtendronde; de koers van de portefeuille; de koers van een eigen transactie), alleen in de valuta
// van de positie; wisselkoers ECB op de koersdatum of ervóór, anders die van de portefeuille of de transactie. Elke koers die geen dagkoers is
// of ouder dan 4 dagen krijgt een markering met zijn datum (valt de koersbron uit, dan blijft de laatst bekende staan, zichtbaar). Geen koers
// = die positie "zonder koers" (niet raden); contant bij DEGIRO alleen uit de portefeuille of handstand (uit het rekeningoverzicht is de
// volgorde binnen een tijdstip niet vast). kAt(isin, datum) → { datum, slot, valuta } | null; wAt(valuta, datum) → { datum, per_eur } | null.
const PEIL_OUD_DAGEN = 4;
const nlDag = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? Number(d.slice(8, 10)) + '-' + Number(d.slice(5, 7)) + '-' + d.slice(0, 4) : String(d));   // tekst voor David: d-m-jjjj
const txSleutel = (t) => (t.isin ? 'isin:' + t.isin : 'naam:' + String(t.naam).toLowerCase());
function waardeOp(d, kAt, wAt, datum) {
  const portef = (d.stand_bron === 'bestand' || d.stand_bron === 'hand') && !!d.stand_datum;
  const per = new Map(), markering = [], zonder = [];
  const pos = (sl, x) => { let p = per.get(sl); if (!p) { p = { sleutel: sl, naam: x.naam, isin: x.isin || null, valuta: x.valuta || null, aantal: 0, hand: null, port: null }; per.set(sl, p); } return p; };
  let txOnvolledig = false;
  if (portef) {
    for (const p of d.posities) {
      if (p.regelsoort !== 'effect') continue;
      const n = Number(p.aantal), q = pos(p.sleutel, p);
      if (p.aantal != null && Number.isFinite(n) && n > 0) { q.aantal += n; if (Number(p.koers) > 0) q.port = p; }
      else q.hand = p;   // handpositie zonder aantal: alleen de ingevoerde waarde
    }
    for (const t of d.transacties) {
      const n = Number(t.aantal);
      if (!Number.isFinite(n) || !n) continue;
      if (t.datum > d.stand_datum && t.datum <= datum) pos(txSleutel(t), t).aantal += n;
      else if (t.datum > datum && t.datum <= d.stand_datum) pos(txSleutel(t), t).aantal -= n;
    }
  } else {
    const a = aankoopStand(d.transacties.filter((t) => t.datum <= datum));
    txOnvolledig = a.onvolledig;
    for (const p of a.posities) pos(p.sleutel, p).aantal = Number(p.aantal);
  }
  if (txOnvolledig) markering.push('transacties onvolledig (een verkoop zonder bekende aankoop of een rij zonder totaal)');
  const posities = [];
  let effecten = 0, oudste = null;
  for (const p of per.values()) {
    if (p.hand && !p.aantal) {
      if (d.stand_datum <= datum) { posities.push({ sleutel: p.sleutel, naam: p.naam, isin: p.isin, aantal: null, koers: null, valuta: 'EUR', koers_datum: d.stand_datum, koers_bron: 'handinvoer', wissel: 1, waarde_cent: p.hand.waarde_eur_cent, markering: ['eigen invoer van ' + nlDag(d.stand_datum)] }); effecten += p.hand.waarde_eur_cent; }
      else zonder.push({ naam: p.naam, reden: 'eigen invoer van na de datum' });
      continue;
    }
    if (p.aantal < -1e-9) { zonder.push({ naam: p.naam, reden: 'aantal klopt niet (meer verkocht dan bekend)' }); continue; }
    if (Math.abs(p.aantal) < 1e-9) continue;
    const kand = [];
    const k = p.isin ? kAt(p.isin, datum) : null;
    if (k) kand.push({ datum: k.datum, slot: k.slot, valuta: k.valuta, bron: 'dagkoers', fx: null });
    if (p.port && d.stand_datum <= datum) kand.push({ datum: d.stand_datum, slot: p.port.koers, valuta: p.port.valuta, bron: 'portefeuille', fx: p.port.lokaal_cent && p.port.waarde_eur_cent ? p.port.lokaal_cent / p.port.waarde_eur_cent : null });
    const t = d.transacties.filter((x) => txSleutel(x) === p.sleutel && x.datum <= datum && Number(x.koers) > 0).sort((a, b) => (a.datum + (a.tijd || '') < b.datum + (b.tijd || '') ? 1 : -1))[0];
    if (t) kand.push({ datum: t.datum, slot: t.koers, valuta: t.valuta, bron: 'transactie', fx: Number(t.wisselkoers) > 0 ? Number(t.wisselkoers) : null });
    const goed = kand.filter((x) => Number(x.slot) > 0 && (!p.valuta || !x.valuta || x.valuta === p.valuta));
    goed.sort((a, b) => (a.datum < b.datum ? 1 : a.datum > b.datum ? -1 : 0));   // stabiel: bij gelijke datum gaat de dagkoers voor
    const c = goed[0];
    if (!c) { zonder.push({ naam: p.naam, reden: kand.length ? 'koers in een andere valuta' : 'geen koers bekend' }); continue; }
    const val = c.valuta || p.valuta || 'EUR';
    let fx = null, wd = null;
    if (val === 'EUR') fx = 1;
    else { const w = wAt(val, c.datum); if (w && Number(w.per_eur) > 0) { fx = Number(w.per_eur); wd = w.datum; } else if (c.fx > 0) { fx = c.fx; wd = c.datum; } }
    if (fx == null) { zonder.push({ naam: p.naam, reden: 'geen wisselkoers' }); continue; }
    const w = Math.round((p.aantal * Number(c.slot) / fx) * 100);
    const m = [];
    if (c.bron !== 'dagkoers') m.push('geen dagkoers: koers uit ' + (c.bron === 'transactie' ? 'je eigen transactie' : 'je portefeuille') + ' van ' + nlDag(c.datum));
    else if (c.datum < plusDagen(datum, -PEIL_OUD_DAGEN)) m.push('laatst bekende koers is van ' + nlDag(c.datum));
    posities.push({ sleutel: p.sleutel, naam: p.naam, isin: p.isin, aantal: String(Number(p.aantal.toFixed(6))), koers: String(c.slot), valuta: val, koers_datum: c.datum, koers_bron: c.bron,
      wissel: fx, wissel_datum: wd, waarde_cent: w, markering: m });
    effecten += w;
    if (!oudste || c.datum < oudste) oudste = c.datum;
  }
  let cash = null, cashDatum = null;
  let cashOnzeker = false;
  if (portef && d.stand_datum <= datum) {
    cash = d.posities.filter((p) => p.regelsoort === 'cash').reduce((s, p) => s + (p.waarde_eur_cent || 0), 0); cashDatum = d.stand_datum;
    // review MOET 1: na de portefeuille-datum kan contant veranderd zijn (aankoop, verkoop, storting, dividend); niet bijrekenen, wel zeggen
    const na = (x) => x > d.stand_datum && x <= datum;
    cashOnzeker = d.transacties.some((t) => na(t.datum)) || (d.rekening_datums || []).some(na);
    if (cashOnzeker) markering.push('contant bij DEGIRO kan veranderd zijn: je portefeuille is van ' + nlDag(d.stand_datum) + ', daarna zijn er nog mutaties');
    else if (d.stand_datum < plusDagen(datum, -PEIL_OUD_DAGEN)) markering.push('contant bij DEGIRO volgens je portefeuille van ' + nlDag(d.stand_datum));
  } else if (posities.length || zonder.length) markering.push(portef ? 'contant bij DEGIRO op deze datum niet bekend (je portefeuille is van later)' : 'contant bij DEGIRO niet bekend (lees je portefeuille-export in)');
  for (const p of posities) for (const x of p.markering) markering.push(p.naam + ': ' + x);
  for (const z of zonder) markering.push(z.naam + ': ' + z.reden + ', niet meegeteld');
  return { datum, aantal_bron: portef ? (d.stand_bron === 'hand' ? 'handstand' : 'portefeuille') + ' van ' + nlDag(d.stand_datum) : 'transacties', posities, zonder,
    effecten_cent: effecten, cash_cent: cash, cash_datum: cashDatum, waarde_cent: effecten + (cash || 0), koers_datum: oudste,
    volledig: !zonder.length && !txOnvolledig && !cashOnzeker && (cash != null || (!posities.length && !portef)), markering };
}
// Dividend en kosten van een kalenderjaar (voor de peilwaarde): dividend en dividendbelasting uit het rekeningoverzicht (per valuta en in euro
// met de ECB-koers van die dag); kosten = transactiekosten uit de transacties + overige kosten uit het rekeningoverzicht (aansluitingskosten e.d.;
// transactiekosten daar niet nog eens). rekening_tot = de laatste dag in het rekeningoverzicht (wat daarna kwam, staat er niet in).
function jaarGeld(rekening, transacties, jaar, wAt) {
  const j = String(jaar), inJaar = (x) => String(x.datum).slice(0, 4) === j;
  const uit = { jaar: Number(jaar), dividend_cent: 0, dividendbelasting_cent: 0, kosten_transacties_cent: 0, kosten_overig_cent: 0, per_valuta: {}, zonder_wissel: 0,
    rekening_tot: rekening.reduce((m, r) => (r.datum > m ? r.datum : m), '') || null };
  const tel = (soort, r) => {
    const v = r.mutatie_valuta || 'EUR';
    const pv = uit.per_valuta[v] || (uit.per_valuta[v] = { dividend_cent: 0, dividendbelasting_cent: 0, kosten_overig_cent: 0 });
    pv[soort] += r.mutatie_cent;
    if (v === 'EUR') { uit[soort] += r.mutatie_cent; return; }
    const w = wAt(v, r.datum);
    if (w && Number(w.per_eur) > 0) uit[soort] += Math.round(r.mutatie_cent / Number(w.per_eur)); else uit.zonder_wissel++;
  };
  for (const r of rekening) {
    if (!inJaar(r) || typeof r.mutatie_cent !== 'number') continue;
    const o = String(r.omschrijving || '').toLowerCase();
    if (/dividendbelasting|dividend tax|withholding/.test(o)) tel('dividendbelasting_cent', r);
    else if (/dividend/.test(o)) tel('dividend_cent', r);
    else if (/kosten|fee|aansluit|connection/.test(o) && !/transactiekosten|transaction|autofx/.test(o)) tel('kosten_overig_cent', r);   // review ronde 2: AutoFX zit al in de transactiekosten
  }
  for (const t of transacties) if (inJaar(t) && typeof t.kosten_eur_cent === 'number') uit.kosten_transacties_cent += t.kosten_eur_cent;
  return uit;
}
// wv3030: stand uit transacties zolang er geen portefeuille en geen handpositie is (een ingelezen portefeuille of handpositie gaat altijd voor).
// Per ISIN (anders naam): aantal en aankoopwaarde incl. kosten; een verkoop haalt naar rato aankoopwaarde weg (gemiddelde kostprijs). Geen koersen:
// dit is de waarde bij aankoop, niet de huidige waarde. Ontbreekt een totaal of verkoopt een rij meer dan er was, dan 'onvolledig' (niet raden).
function aankoopStand(transacties) {
  const per = new Map();
  let gerealiseerd = 0, gerealiseerdOnbekend = 0;
  const tijd = (t) => t.datum + ' ' + (t.tijd || '');
  for (const t of transacties.slice().sort((a, b) => (tijd(a) < tijd(b) ? -1 : tijd(a) > tijd(b) ? 1 : 0))) {
    const n = Number(t.aantal);
    if (!Number.isFinite(n) || n === 0) continue;
    const sl = t.isin ? 'isin:' + t.isin : 'naam:' + String(t.naam).toLowerCase();
    const p = per.get(sl) || { sleutel: sl, naam: t.naam, isin: t.isin || null, valuta: t.valuta || null, aantal: 0, kost: 0, transacties: 0, onvolledig: false, ger: 0, gerOnbekend: 0 };
    p.transacties++; p.naam = t.naam;
    if (n > 0) {
      const tot = t.totaal_eur_cent != null ? t.totaal_eur_cent : t.waarde_eur_cent != null ? t.waarde_eur_cent + (t.kosten_eur_cent || 0) : null;
      if (tot == null || tot > 0) p.onvolledig = true; else p.kost += -tot;
      p.aantal += n;
    } else if (-n > p.aantal + 1e-9) { p.onvolledig = true; p.aantal = 0; p.kost = 0; p.gerOnbekend++; }
    else {
      // wv3754 (L09): gerealiseerd bij verkoop = opbrengst na kosten (totaal) min het deel van de aankoopwaarde (incl. kosten) dat weggaat
      const rest = Math.round(p.kost * (1 + n / p.aantal)), deel = p.kost - rest;
      const opbrengst = t.totaal_eur_cent != null ? t.totaal_eur_cent : t.waarde_eur_cent != null ? t.waarde_eur_cent + (t.kosten_eur_cent || 0) : null;
      if (opbrengst == null || opbrengst < 0) p.gerOnbekend++; else p.ger += opbrengst - deel;
      p.kost = rest; p.aantal += n;
    }
    if (Math.abs(p.aantal) < 1e-9) { p.aantal = 0; p.kost = 0; }
    per.set(sl, p);
  }
  // review wv3030 MOET 2: onvolledig ook op standniveau (een verkoop zonder bekende aankoop laat de positie weg, maar de stand is dan niet compleet)
  const alle = Array.from(per.values());
  // review wv3754 MOET 2: gerealiseerd per positie; een positie met onvolledige transacties telt niet mee (en wordt geteld), de rest wel
  for (const p of alle) { if (p.onvolledig) { if (p.ger || p.gerOnbekend) gerealiseerdOnbekend++; } else { gerealiseerd += p.ger; gerealiseerdOnbekend += p.gerOnbekend; } }
  return { onvolledig: alle.some((p) => p.onvolledig), gerealiseerd_cent: gerealiseerd, gerealiseerd_onbekend: gerealiseerdOnbekend, posities: alle.filter((p) => p.aantal > 0).map((p) => ({ sleutel: p.sleutel, regelsoort: 'effect', naam: p.naam, isin: p.isin,
    aantal: String(Number(p.aantal.toFixed(6))), koers: null, valuta: p.valuta, lokaal_cent: null, waarde_eur_cent: p.kost, bron: 'aankoop', transacties: p.transacties, onvolledig: p.onvolledig })) };
}
// wv3755 (L11): per positie de waarde nu en bij aankoop. Eerst de dagkoers (waarde van vandaag); anders, bij een ingelezen portefeuille of
// handstand, de waarde uit die stand tegen de aankoopwaarde uit de transacties (alleen als het aantal klopt, zie aankoopPer). Stand op
// aankoopwaarde = geen daling te meten.
function dalingUit(d, vw) {
  const ap = aankoopPer(d.posities, d.transacties);
  const uit = {};
  for (const p of d.posities) {
    if (p.regelsoort !== 'effect') continue;
    const x = vw && vw.posities ? vw.posities[p.sleutel] : null;
    if (x && x.waarde_cent != null && x.aankoop_cent != null) uit[p.sleutel] = { waarde_cent: x.waarde_cent, aankoop_cent: x.aankoop_cent, datum: x.datum, bron: 'koers' };
    else if ((d.stand_bron === 'bestand' || d.stand_bron === 'hand') && p.bron !== 'aankoop' && ap[p.sleutel] != null) uit[p.sleutel] = { waarde_cent: p.waarde_eur_cent, aankoop_cent: ap[p.sleutel], datum: d.stand_datum, bron: 'stand' };
  }
  return uit;
}
function metAankoop(d) {
  // review wv3030 MOET 1: een ingelezen portefeuille gaat altijd voor, ook als die alleen contant bevat (alles verkocht)
  if (d.stand_bron === 'bestand' || d.posities.some((p) => p.regelsoort === 'effect') || !d.transacties.length) return d;
  const a = aankoopStand(d.transacties);
  if (!a.posities.length && !a.onvolledig) return d;
  return Object.assign({}, d, { posities: d.posities.concat(a.posities), stand_datum: d.transacties.reduce((m, t) => (t.datum > m ? t.datum : m), ''), stand_bron: 'aankoop',
    aankoop_onvolledig: a.onvolledig });
}

// ── plan: waarden controleren en regels afleiden ──
function leesPct(x, naam) {
  if (x === null || x === undefined || x === '') return null;
  const t = String(x).trim().replace(',', '.').replace(/\s*%$/, '');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t) || Number(t) > 100) throw new Fout(400, naam + ': een percentage tussen 0 en 100');
  return Number(t);
}
// wv3755: een bedrag uit Davids invoer in centen ("50000", "50.000", "€ 50.000,00", "100,49"); leeg = null
function leesCent(x, naam) {
  if (x === null || x === undefined || x === '') return null;
  let t = String(x).trim().replace(/^€\s*/, '').replace(/\s+/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) t = t.replace(/\./g, '');
  t = t.replace(',', '.');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) throw new Fout(400, naam + ': een bedrag in euro (bijvoorbeeld 50.000)');
  const [heel, deel] = t.split('.');
  const c = Number(heel) * 100 + Number(((deel || '') + '00').slice(0, 2));
  if (c < 1) throw new Fout(400, naam + ': een bedrag in euro (bijvoorbeeld 50.000)');
  return c;
}
// doelbedrag: hele euro's (afgerond)
function leesEuro(x, naam) {
  const c = leesCent(x, naam);
  if (c == null) return null;
  if (c < 100) throw new Fout(400, naam + ': een bedrag in euro (bijvoorbeeld 50.000)');
  return Math.round(c / 100);
}
const euroTekst = (e) => '€ ' + String(Math.round(e)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const euroCent = (c) => euroTekst(Math.round(c / 100));
function regelsUit(vraag, waarden) {
  const v = VRAGEN.find((x) => x.nr === vraag);
  const uit = {};
  for (const f of v.velden || []) {
    const w = waarden ? waarden[f.sleutel] : undefined;
    if (f.soort === 'pct') uit[f.sleutel] = leesPct(w, f.label);
    else if (f.soort === 'euro') uit[f.sleutel] = leesEuro(w, f.label);
    else if (f.soort === 'dagen') {
      if (w === null || w === undefined || w === '') uit[f.sleutel] = null;
      else { const t = String(w).trim(); if (!/^\d{1,3}$/.test(t) || Number(t) > 365) throw new Fout(400, f.label + ': 0 tot 365 dagen'); uit[f.sleutel] = Number(t); }
    } else if (f.soort === 'lijst') {
      const l = (Array.isArray(w) ? w : String(w || '').split('\n')).map((s) => String(s).trim()).filter(Boolean);
      if (l.length > 100 || l.some((s) => s.length > 120)) throw new Fout(400, f.label + ': hooguit 100 namen van 120 tekens');
      uit[f.sleutel] = l.length ? l : null;
    } else if (f.soort === 'maanden') {
      const l = (Array.isArray(w) ? w : String(w || '').split(/[\s,;]+/)).map((s) => String(s).trim()).filter(Boolean);
      for (const m of l) if (!/^\d{1,2}$/.test(m) || +m < 1 || +m > 12) throw new Fout(400, f.label + ': maanden 1 tot 12');
      uit[f.sleutel] = l.length ? [...new Set(l.map(Number))].sort((a, b) => a - b) : null;
    } else if (f.soort === 'keuze') {
      if (w === null || w === undefined || w === '') uit[f.sleutel] = null;
      else if (!f.opties.some((o) => o[0] === w)) throw new Fout(400, f.label + ': onbekende keuze'); else uit[f.sleutel] = w;
    }
  }
  if (uit.daling_pct != null && uit.daling_pct < 1) throw new Fout(400, 'Dalingsdrempel: minstens 1 % (leeg = standaard 30 %)');   // wv3755 review MOET 2
  for (const [a, b, n] of [['kern_min', 'kern_max', 'kern'], ['eigen_min', 'eigen_max', 'eigen keuzes']])
    if (uit[a] != null && uit[b] != null && uit[a] > uit[b]) throw new Fout(400, n + ': minstens is groter dan hoogstens');
  return uit;
}

// ── databank ──
function nuIso() { return new Date().toISOString(); }
function vandaagNl() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
const T = (x, max) => { if (x === null || x === undefined) return null; const t = String(x).trim(); if (t.length > (max || 2000)) throw new Fout(400, 'tekst te lang (hooguit ' + (max || 2000) + ' tekens)'); return t || null; };

function maak(o) {
  const dbPad = o.dbPad;
  const vaultSchrijf = typeof o.vaultSchrijf === 'function' ? o.vaultSchrijf : null;
  const vandaagF = o.vandaag || vandaagNl;
  let vaultOk = null, laatsteVault = null, gemigreerd = false;
  // wv3758: stortingen naar DEGIRO uit de bank-lezer (server.js leest de bankdatabank alleen-lezen); een fout = geen bankposten (nooit raden)
  function bankStortingen() { if (typeof o.bankStortingen !== 'function') return null; try { return o.bankStortingen(); } catch (e) { return null; } }
  function open(alleenLezen) {
    const { DatabaseSync } = require('node:sqlite');
    const map = path.dirname(dbPad);
    if (!fs.existsSync(map)) fs.mkdirSync(map, { recursive: true, mode: 0o700 });
    const nieuw = !fs.existsSync(dbPad);
    if (alleenLezen && nieuw) return null;
    if (alleenLezen && !gemigreerd) open(false).close();   // wv2993: een databank van fase 1 krijgt de tabellen van versie 2 vóór de eerste lezing
    const db = new DatabaseSync(dbPad, alleenLezen ? { readOnly: true } : {});
    if (!alleenLezen) {
      if (nieuw) { try { fs.chmodSync(dbPad, 0o600); } catch (e) { /* bestaat al */ } }
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec(SCHEMA);
      db.exec(SCHEMA_2);
      db.exec(SCHEMA_3);
      // wv3756 (review MOET 1): richting (koop/verkoop) bij een dagboekregel zonder transactie, zodat hij later alleen aan die richting hangt
      if (!db.prepare("SELECT 1 FROM pragma_table_info('dagboek') WHERE name = 'richting'").get()) db.exec('ALTER TABLE dagboek ADD COLUMN richting TEXT');
      db.exec(SCHEMA_4);
      db.prepare("INSERT INTO meta (sleutel, waarde) VALUES ('schema', ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde WHERE CAST(meta.waarde AS INTEGER) < CAST(excluded.waarde AS INTEGER)").run(String(SCHEMA_VERSIE));
      gemigreerd = true;
    }
    return db;
  }
  function metDb(f, schrijf) {
    const db = open(!schrijf);
    if (!db) return f(null);
    try {
      if (!schrijf) return f(db);
      db.exec('BEGIN IMMEDIATE');
      try { const u = f(db); db.exec('COMMIT'); return u; } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { /* al weg */ } throw e; }
    } finally { db.close(); }
  }
  function leesAlles(db) {
    const leeg = { antwoorden: {}, regels: {}, versies: [], posities: [], soorten: {}, transacties: [], dagboek: [], volglijst: [], keuzes: {}, bestanden: [], exports: { portefeuille: null, transacties: null, rekening: null }, stand_datum: null, stand_bron: null, rekening_rijen: 0, stortingen: 0 };
    if (!db) return leeg;
    const d = leeg;
    for (const r of db.prepare('SELECT * FROM plan_antwoord').all()) d.antwoorden[r.vraag] = { tekst: r.tekst, waarden: r.waarden ? JSON.parse(r.waarden) : null, status: r.status, op: r.op };
    for (const r of db.prepare('SELECT sleutel, waarde FROM regel').all()) d.regels[r.sleutel] = JSON.parse(r.waarde);
    d.versies = db.prepare('SELECT versie, op, wat FROM planversie ORDER BY versie DESC LIMIT 20').all().map((r) => Object.assign({}, r));
    d.posities = db.prepare('SELECT sleutel, regelsoort, naam, isin, aantal, koers, valuta, lokaal_cent, waarde_eur_cent, bron FROM positie').all().map((r) => Object.assign({}, r));
    for (const r of db.prepare('SELECT sleutel, soort FROM positie_soort').all()) d.soorten[r.sleutel] = r.soort;
    // wv3783: herkomst voor het scherm ("uit je mail"): de eerste bron wint (INSERT OR IGNORE), dus een mailtransactie blijft 'mail' ook na de export
    d.transacties = db.prepare("SELECT t.sleutel, t.datum, t.tijd, t.naam, t.isin, t.aantal, t.koers, t.valuta, t.waarde_eur_cent, t.wisselkoers, t.kosten_eur_cent, t.totaal_eur_cent, t.bron, " +
      "CASE WHEN t.bron = 'hand' THEN 'hand' WHEN coalesce(b.naam, '') LIKE 'mail:%' THEN 'mail' ELSE 'export' END AS herkomst " +
      'FROM transactie t LEFT JOIN bestand b ON b.id = t.bestand_id ORDER BY t.datum DESC, t.tijd DESC').all().map((r) => Object.assign({}, r));
    d.dagboek = db.prepare('SELECT * FROM dagboek ORDER BY datum DESC, id DESC').all().map((r) => Object.assign({}, r));
    d.volglijst = db.prepare('SELECT id, naam, code, thema, waarom, wanneer, op FROM volglijst WHERE weg = 0 ORDER BY id').all().map((r) => Object.assign({}, r));
    for (const r of db.prepare('SELECT sleutel, keuze, tot FROM signaal_keuze').all()) d.keuzes[r.sleutel] = { keuze: r.keuze, tot: r.tot };
    // wv3758: een transactie uit Davids DEGIRO-mail is intern ook een 'bestand' (naam mail:<id>); het vak "Je bestanden uit DEGIRO" toont alleen exports
    d.bestanden = db.prepare("SELECT id, soort, naam, datum_bestand, op, rijen, nieuw FROM bestand WHERE coalesce(naam, '') NOT LIKE 'mail:%' ORDER BY id DESC LIMIT 10").all().map((r) => Object.assign({}, r));
    d.uit_mail = db.prepare("SELECT COUNT(*) AS n, MAX(op) AS op FROM bestand WHERE naam LIKE 'mail:%'").get();
    d.uit_mail = { aantal: d.uit_mail.n, op: d.uit_mail.op || null };
    d.mail_verschil = mailVerschil(db);
    d.mail_fout = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mailtx'").get()
      ? db.prepare("SELECT gmail_id, mail_datum FROM mailtx WHERE uitkomst = 'fout' ORDER BY op DESC LIMIT 5").all().map((r) => Object.assign({}, r)) : [];
    // wv3031: per DEGIRO-export (portefeuille, transacties, rekening) het laatst ingelezen bestand, los van de 10 hierboven (geen bedragen)
    d.exports = { portefeuille: null, transacties: null, rekening: null };
    for (const r of db.prepare("SELECT soort, MAX(op) AS op, COUNT(*) AS n FROM bestand WHERE coalesce(naam, '') NOT LIKE 'mail:%' GROUP BY soort").all()) {
      if (r.soort in d.exports) d.exports[r.soort] = { op: r.op, aantal: r.n, datum_bestand: (db.prepare("SELECT datum_bestand FROM bestand WHERE soort = ? AND coalesce(naam, '') NOT LIKE 'mail:%' ORDER BY op DESC, id DESC LIMIT 1").get(r.soort) || {}).datum_bestand || null };
    }
    const m = Object.fromEntries(db.prepare("SELECT sleutel, waarde FROM meta WHERE sleutel IN ('stand_datum', 'stand_bron')").all().map((r) => [r.sleutel, r.waarde]));
    d.stand_datum = m.stand_datum || null; d.stand_bron = m.stand_bron || null;
    d.rekening_rijen = db.prepare('SELECT COUNT(*) AS n FROM rekening').get().n;
    // wv3030: een storting in het rekeningoverzicht (DEGIRO: "Reservation iDEAL", "iDEAL storting", "flatex Storting", "Deposit") = stap storten gedaan
    d.stortingen = db.prepare("SELECT COUNT(*) AS n FROM rekening WHERE mutatie_cent > 0 AND (lower(omschrijving) LIKE '%storting%' OR lower(omschrijving) LIKE '%deposit%' OR lower(omschrijving) LIKE '%ideal%')").get().n;
    return d;
  }
  // wv3006 (dashboard): de waarde per ingelezen portefeuille, één punt per standdatum (het laatst ingelezen bestand van die dag telt), voor
  // "verschil met je vorige stand" en de lijn op het dashboard. Geen dagkoersen: alleen Davids eigen standen, opnieuw gelezen uit de bewaarde
  // bestanden (een bestand dat de lezer nu weigert, telt niet mee). Cache op de sha256 van de inhoud: een bewaard bestand verandert niet.
  const historieCache = new Map();
  function historieUit(db) {
    if (!db) return [];
    const per = new Map();
    for (const r of db.prepare("SELECT id, datum_bestand, sha256 FROM bestand WHERE soort = 'portefeuille' AND datum_bestand IS NOT NULL ORDER BY datum_bestand, id").all()) per.set(r.datum_bestand, r);
    const uit = [];
    for (const [datum, r] of Array.from(per).slice(-HISTORIE_MAX)) {
      let w = historieCache.get(r.sha256);
      if (!w) {
        try {
          const l = leesBestand(db.prepare('SELECT inhoud FROM bestand WHERE id = ?').get(r.id).inhoud);
          if (l.soort !== 'portefeuille') continue;
          w = { belegd_cent: 0, cash_cent: 0 };
          for (const x of l.rijen) w[x.regelsoort === 'cash' ? 'cash_cent' : 'belegd_cent'] += x.waarde_eur_cent;
        } catch (e) { continue; }
        if (historieCache.size >= 4 * HISTORIE_MAX) historieCache.clear();
        historieCache.set(r.sha256, w);
      }
      uit.push({ datum, belegd_cent: w.belegd_cent, cash_cent: w.cash_cent });
    }
    return uit;
  }
  // ── wv3728: dagkoersen (de ochtendronde in beleggen-nieuws.js haalt op; hier alleen lezen en schrijven) ──
  function koersenUit(db) {
    const koersen = {}, wissels = {};
    if (!db) return { koersen, wissels };
    for (const r of db.prepare('SELECT isin, datum, slot, valuta FROM koers ORDER BY isin, datum DESC').all()) {
      const l = koersen[r.isin] || (koersen[r.isin] = []);
      if (l.length < 10) l.push({ datum: r.datum, slot: r.slot, valuta: r.valuta });
    }
    for (const r of db.prepare('SELECT valuta, datum, per_eur FROM wissel ORDER BY valuta, datum DESC').all()) {
      const l = wissels[r.valuta] || (wissels[r.valuta] = []);
      if (l.length < 40) l.push({ datum: r.datum, per_eur: r.per_eur });
    }
    return { koersen, wissels };
  }
  // wv3754: alle dagkoersen (≤ 400 dagen, oplopend) en wisselkoersen (aflopend) voor de daglijn en de koerslijntjes
  function reeksUit(db) {
    const reeks = {}, wissels = {};
    if (!db) return { reeks, wissels };
    for (const r of db.prepare('SELECT isin, datum, slot, valuta FROM koers ORDER BY isin, datum').all()) (reeks[r.isin] || (reeks[r.isin] = [])).push({ datum: r.datum, slot: r.slot, valuta: r.valuta });
    for (const r of db.prepare('SELECT valuta, datum, per_eur FROM wissel ORDER BY valuta, datum DESC').all()) (wissels[r.valuta] || (wissels[r.valuta] = [])).push({ datum: r.datum, per_eur: r.per_eur });
    return { reeks, wissels };
  }
  // wv3754: AutoFX-kosten per transactie (de tabel bewaart transactie- en AutoFX-kosten samen); opnieuw gelezen uit de bewaarde bestanden, cache op sha256
  const autofxCache = new Map();
  function autofxUit(db) {
    const m = new Map();
    if (!db) return m;
    for (const r of db.prepare("SELECT id, sha256 FROM bestand WHERE soort = 'transacties' ORDER BY id").all()) {
      let l = autofxCache.get(r.sha256);
      if (!l) {
        try { const x = leesBestand(db.prepare('SELECT inhoud FROM bestand WHERE id = ?').get(r.id).inhoud); if (x.soort !== 'transacties') continue; l = x.rijen.map((y) => [y.sleutel, y.autofx_eur_cent]); }
        catch (e) { continue; }
        if (autofxCache.size >= 200) autofxCache.clear();
        autofxCache.set(r.sha256, l);
      }
      for (const [k, v] of l) if (v != null && !m.has(k)) m.set(k, v);
    }
    return m;
  }
  // wv3758 kwartaalcontrole: een transactie die uit Davids DEGIRO-mail kwam en binnen de datums van een later ingelezen transacties-export valt,
  // maar daar niet in staat = verschil (zichtbaar als signaal; niets gewist). Exports opnieuw gelezen met dezelfde cache op sha256.
  const exportCache = new Map();
  function mailVerschil(db) {
    const mailTx = db.prepare("SELECT t.sleutel, t.datum, t.naam FROM transactie t JOIN bestand b ON b.id = t.bestand_id WHERE b.naam LIKE 'mail:%'").all();
    if (!mailTx.length) return [];
    const exps = [];
    for (const r of db.prepare("SELECT id, sha256 FROM bestand WHERE soort = 'transacties' AND coalesce(naam, '') NOT LIKE 'mail:%' ORDER BY id").all()) {
      let e = exportCache.get(r.sha256);
      if (!e) {
        try { const x = leesBestand(db.prepare('SELECT inhoud FROM bestand WHERE id = ?').get(r.id).inhoud); if (x.soort !== 'transacties' || !x.rijen.length) continue;
          const ds = x.rijen.map((y) => y.datum).sort(); e = { van: ds[0], tot: ds[ds.length - 1], sl: new Set(x.rijen.map((y) => y.sleutel)) }; }
        catch (err) { continue; }
        if (exportCache.size >= 200) exportCache.clear();
        exportCache.set(r.sha256, e);
      }
      exps.push(e);
    }
    return mailTx.filter((t) => { const binnen = exps.filter((e) => t.datum >= e.van && t.datum <= e.tot); return binnen.length && !binnen.some((e) => e.sl.has(t.sleutel)); })
      .map((t) => ({ sleutel: t.sleutel, datum: t.datum, naam: t.naam }));
  }
  // Wat de ochtendronde nodig heeft: posities (ISIN, naam, valuta; geen aantallen of bedragen), bedrijven om vanzelf een kaartje voor te maken
  // (geen kaartje en niet door David uitgezet), en de codes die al gevonden zijn.
  function koersData() {
    return metDb((db) => {
      const d = metAankoop(leesAlles(db));
      const k = bereken(d, vandaagF());
      // wv3777: de beurs waar David het laatst handelde (DEGIRO-code uit de transacties, bv. EAM) → welke Euronext-beurs de koers geeft
      const beurs = {};
      if (db) for (const r of db.prepare("SELECT isin, beurs FROM transactie WHERE isin IS NOT NULL AND beurs IS NOT NULL AND beurs <> '' ORDER BY datum DESC, tijd DESC").all()) if (!beurs[r.isin]) beurs[r.isin] = String(r.beurs).toUpperCase().slice(0, 8);
      const posities = k.posities.filter((p) => p.isin).map((p) => ({ sleutel: p.sleutel, isin: p.isin, naam: p.naam, zoeknaam: kaleNaam(p.naam), valuta: p.valuta || null, beurs: beurs[p.isin] || null }));
      const uit = db ? new Set(db.prepare('SELECT sleutel FROM bedrijf_uit').all().map((r) => r.sleutel)) : new Set();
      const bedrijven = bedrijvenUit(db, d, k).filter((b) => !b.kaartje && !uit.has(b.sleutel))
        .map((b) => ({ sleutel: b.sleutel, naam: b.naam, bron: b.bron, code: b.voorstel.code, namen: b.voorstel.namen }));
      const codes = {};
      if (db) for (const r of db.prepare('SELECT sleutel, code, cik, op, fout FROM koerscode').all()) codes[r.sleutel] = { code: r.code, cik: r.cik, op: r.op, fout: r.fout };
      // ook voor posities mét kaartje (door David ingesteld) is een beurscode nodig voor de koers: neem die van het kaartje als er nog geen is
      if (db) for (const r of db.prepare('SELECT sleutel, code, cik FROM bedrijf').all()) if (!codes[r.sleutel] && r.code) codes[r.sleutel] = { code: r.code, cik: r.cik, op: null, fout: null, kaartje: true };
      // review ZOU 2: kaartjes zonder SEC-nummer of zonder beurscode (eerdere zoektocht faalde, of David vulde ze niet in) worden opnieuw gezocht
      const aanvullen = db ? db.prepare('SELECT sleutel, naam, namen, code FROM bedrijf WHERE cik IS NULL OR code IS NULL').all().map((r) => ({ sleutel: r.sleutel, naam: r.naam, namen: JSON.parse(r.namen), code: r.code })) : [];
      // wv3754: hoeveel dagkoersen er per ISIN al zijn (de eerste keer haalt de ronde ± 2 maanden op voor de koerslijntjes) en het wereldindexfonds
      const aantal = {};
      if (db) for (const r of db.prepare('SELECT isin, COUNT(*) AS n FROM koers GROUP BY isin').all()) aantal[r.isin] = r.n;
      if (db) for (const r of db.prepare('SELECT valuta, COUNT(*) AS n FROM wissel GROUP BY valuta').all()) aantal['wissel:' + r.valuta] = r.n;
      return { posities, bedrijven, aanvullen, codes, valuta: [...new Set(posities.map((p) => p.valuta).filter((v) => v && v !== 'EUR'))], aantal_koersen: aantal,
        index: { sleutel: WERELD.sleutel, code: WERELD.code } };
    }, false) || { posities: [], bedrijven: [], aanvullen: [], codes: {}, valuta: [], aantal_koersen: {}, index: null };
  }
  const RE_SLOT = /^\d{1,9}(\.\d{1,8})?$/;
  const RE_DAG = /^\d{4}-\d{2}-\d{2}$/;
  // { codes: [{ sleutel, code, cik, naam_bron, fout }], koersen: [{ isin, datum, slot, valuta, bron }], wissels: [{ valuta, datum, per_eur }] }
  function zetKoersen(x) {
    const op = nuIso();
    const tel = { codes: 0, koersen: 0, wissels: 0, geweigerd: 0 };
    metDb((db) => {
      const sc = db.prepare('INSERT INTO koerscode (sleutel, code, cik, naam_bron, op, fout) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(sleutel) DO UPDATE SET code = excluded.code, cik = excluded.cik, naam_bron = excluded.naam_bron, op = excluded.op, fout = excluded.fout');
      for (const c of x.codes || []) {
        if (!/^(isin|naam):|^volg:\d+$/.test(String(c.sleutel || ''))) { tel.geweigerd++; continue; }
        const code = c.code && /^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(c.code) ? c.code : null, cik = c.cik && /^\d{10}$/.test(c.cik) ? c.cik : null;
        sc.run(c.sleutel, code, cik, c.naam_bron ? String(c.naam_bron).slice(0, 120) : null, op, c.fout ? String(c.fout).slice(0, 80) : null); tel.codes++;
      }
      const sk = db.prepare('INSERT INTO koers (isin, datum, slot, valuta, bron, op) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(isin, datum) DO UPDATE SET slot = excluded.slot, valuta = excluded.valuta, bron = excluded.bron, op = excluded.op');
      const vorige = db.prepare('SELECT slot, valuta FROM koers WHERE isin = ? AND datum < ? ORDER BY datum DESC LIMIT 1');
      for (const k of (x.koersen || []).slice().sort((a, b) => (a.datum < b.datum ? -1 : 1))) {
        if (!(RE_ISIN.test(String(k.isin)) || RE_INDEX.test(String(k.isin))) || !RE_DAG.test(String(k.datum)) || !RE_SLOT.test(String(k.slot)) || !(Number(k.slot) > 0) || !RE_VALUTA.test(String(k.valuta))) { tel.geweigerd++; continue; }
        // vangnet tegen een verkeerde koers (andere aandelenklasse, splitsing, fout in de bron): meer dan een factor 2 t.o.v. de vorige dag = weigeren
        const v = vorige.get(k.isin, k.datum);
        if (v && (v.valuta !== k.valuta || Number(k.slot) > 2 * Number(v.slot) || Number(k.slot) < Number(v.slot) / 2)) { tel.geweigerd++; continue; }
        sk.run(k.isin, k.datum, String(k.slot), k.valuta, String(k.bron || 'onbekend').slice(0, 20), op); tel.koersen++;
      }
      const sw = db.prepare('INSERT INTO wissel (valuta, datum, per_eur, op) VALUES (?, ?, ?, ?) ON CONFLICT(valuta, datum) DO UPDATE SET per_eur = excluded.per_eur, op = excluded.op');
      for (const w of x.wissels || []) {
        if (!RE_VALUTA.test(String(w.valuta)) || w.valuta === 'EUR' || !RE_DAG.test(String(w.datum)) || !RE_SLOT.test(String(w.per_eur)) || !(Number(w.per_eur) > 0)) { tel.geweigerd++; continue; }
        sw.run(w.valuta, w.datum, String(w.per_eur), op); tel.wissels++;
      }
      // bewaren: koersen en wisselkoersen 400 dagen
      db.prepare('DELETE FROM koers WHERE datum < ?').run(plusDagen(vandaagF(), -400));
      db.prepare('DELETE FROM wissel WHERE datum < ?').run(plusDagen(vandaagF(), -400));
    }, true);
    return tel;
  }
  function vulBedrijfAan(sl, x) {
    const code = x.code && /^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(x.code) ? x.code : null, cik = x.cik && /^\d{10}$/.test(x.cik) ? x.cik : null;
    return metDb((db) => db.prepare('UPDATE bedrijf SET code = COALESCE(code, ?), cik = COALESCE(cik, ?) WHERE sleutel = ?').run(code, cik, String(sl)).changes, true);
  }
  // Kaartje "Nieuws over dit bedrijf" vanzelf aan (wv3728): alleen voor een bedrijf zonder kaartje dat David niet uitzette; namen = het voorstel
  // van de app, beurscode en SEC-nummer uit de zoektocht (mag leeg). Een bestaand kaartje (door David ingesteld) blijft onaangeroerd.
  function zetAutoBedrijven(lijst) {
    let n = 0;
    metDb((db) => {
      const uit = new Set(db.prepare('SELECT sleutel FROM bedrijf_uit').all().map((r) => r.sleutel));
      for (const b of lijst || []) {
        const sl = String(b.sleutel || '');
        if (!/^(isin|naam):|^volg:\d+$/.test(sl) || uit.has(sl) || db.prepare('SELECT 1 FROM bedrijf WHERE sleutel = ?').get(sl)) continue;
        let naam = null;
        if (sl.startsWith('volg:')) { const r = db.prepare('SELECT naam FROM volglijst WHERE id = ? AND weg = 0').get(Number(sl.slice(5))); naam = r && r.naam; }
        else naam = naamVan(db, sl);
        if (!naam) continue;
        const namen = [...new Set((b.namen || []).map((x) => String(x).trim()).filter((x) => x.length >= 2 && x.length <= 60))].slice(0, 8);
        if (!namen.length) continue;
        const code = b.code && /^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(b.code) ? b.code : null, cik = b.cik && /^\d{10}$/.test(b.cik) ? b.cik : null;
        const belang = BELANG_RE.test(namen.join(' ') + ' ' + naam) ? 1 : 0;
        db.prepare('INSERT INTO bedrijf (sleutel, naam, namen, code, cik, sponsor, producten, belang, op) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)').run(sl, naam, JSON.stringify(namen), code, cik, '[]', belang, nuIso());
        n++;
      }
    }, true);
    return n;
  }
  function overzicht() {
    return metDb((db) => {
      const d = metAankoop(leesAlles(db));
      const vandaag = vandaagF();
      const kd = koersenUit(db);
      const vandaagW = waardeVandaag(d.posities, kd.koersen, kd.wissels, aankoopPer(d.posities, d.transacties), vandaag);   // wv3728: waarde van vandaag
      d.daling = dalingUit(d, vandaagW);   // wv3755 (L11): waarde nu en bij aankoop per positie, voor het signaal daling
      const k = bereken(d, vandaag);
      const volg = d.volglijst.map((v) => Object.assign({}, v, { vroegst: d.regels.afkoel_dagen != null ? plusDagen(v.op.slice(0, 10), d.regels.afkoel_dagen) : null }));
      const dagboek = d.dagboek.map((x) => Object.assign({}, x, { terugblik6_op: plusMaanden(x.datum, 6), terugblik12_op: plusMaanden(x.datum, 12) }));
      const uitSet = db ? new Set(db.prepare('SELECT sleutel FROM bedrijf_uit').all().map((r) => r.sleutel)) : new Set();
      const bedrijven = bedrijvenUit(db, d, k).map((b) => ({ sleutel: b.sleutel, naam: b.naam, bron: b.bron, kaartje: b.kaartje, voorstel: b.voorstel, uit: uitSet.has(b.sleutel) }));   // wv3728: uit = Davids "Geen nieuws meer"
      // wv3754: daglijn, koerslijntjes per positie (± 30 beursdagen, eigen valuta), wereldindex ernaast en de geld-tegels
      const rk = reeksUit(db);
      const lijn = daglijn(k.posities, d.transacties, rk.reeks, rk.wissels, d.soorten, vandaag);
      if (vandaagW) for (const p of k.posities) { const x = vandaagW.posities[p.sleutel]; const r = p.isin && rk.reeks[p.isin]; if (x && x.koers && r) x.reeks = r.filter((y) => y.valuta === x.valuta && y.datum < vandaag).slice(-30).map((y) => ({ datum: y.datum, slot: y.slot })); }
      const as = aankoopStand(d.transacties);
      const geld = geldOverzicht({ rekening: db ? db.prepare('SELECT datum, omschrijving, mutatie_cent, mutatie_valuta FROM rekening').all() : [], transacties: d.transacties,
        bank: bankStortingen(), autofx: autofxUit(db), vandaag: vandaagW, wissels: rk.wissels, gerealiseerd: { cent: as.gerealiseerd_cent, onbekend: as.gerealiseerd_onbekend } });
      for (const p of k.posities) { delete p._ruw; delete p._maat; }
      return { ok: true, vandaag, vragen: VRAGEN, antwoorden: d.antwoorden, regels: d.regels, versies: d.versies, stand: { datum: d.stand_datum, bron: d.stand_bron,
        verdeling: k.verdeling, posities: k.posities, cash: k.cash, lampjes: k.lampjes, volledig: k.volledig, opbouw: k.opbouw, daling_drempel: k.daling_drempel, daling_standaard: k.daling_standaard, historie: historieUit(db), onvolledig: !!d.aankoop_onvolledig, vandaag: vandaagW, daglijn: lijn }, geld, transacties: d.transacties, dagboek, volglijst: volg,
        signalen: k.signalen, signalen_verborgen: k.signalen_verborgen, open_punten: k.open_punten, belang: k.belang, bestanden: d.bestanden, exports: d.exports, rekening_rijen: d.rekening_rijen, stortingen: d.stortingen, uit_mail: d.uit_mail || { aantal: 0, op: null },
        soort_namen: SOORT_NAAM, vault: { ok: vaultOk, op: laatsteVault }, bedrijven,
        beursgang_klaar: Object.keys(d.keuzes).filter((x) => x.startsWith('beursgang:')).map((x) => x.slice(10)) };   // wv3727: afgeronde beursgangen (code)
    }, false);
  }
  function snapshot(db) {
    const d = leesAlles(db);
    return JSON.stringify({ antwoorden: d.antwoorden, regels: d.regels });
  }
  // ── vaultpagina's (leesbaar; de databank is de bron) ──
  function planPagina(d, versie) {
    const r = [];
    r.push('---', 'type: beleggingsplan', 'bron: pod /opt/data/beleggen/beleggen.sqlite (tabellen plan_antwoord, regel, planversie)', 'db_sleutel: planversie ' + versie,
      'bijgewerkt: ' + nuIso().slice(0, 16).replace('T', ' '), 'schrijver: OVIS Beleggen (app, wv2982); wijzigen in de app, niet hier', '---', '', '# Beleggingsplan', '',
      'Deze pagina schrijft OVIS Beleggen na elke wijziging in de app (planversie ' + versie + '). De waarden zet David; de app rekent ze na. ' +
      'Raamwerk en uitleg: [[01_Ontwikkeling/OVIS Beleggen - plan (Fable 5.2, 12-11-2026)]].', '', '## Antwoorden', '');
    for (const v of VRAGEN) {
      const a = d.antwoorden[v.nr];
      r.push('### ' + v.nr + '. ' + v.vraag, '', a && a.status === 'beantwoord' ? (a.tekst || '_(alleen waarden, zie Regels)_') : a ? '_Open punt: overgeslagen._' : '_Open punt: nog niet beantwoord._', '');
    }
    r.push('## Regels die de app narekent', '', '| Regel | Davids waarde |', '|---|---|');
    for (const [k, f] of Object.entries(VELDEN)) {
      const w = d.regels[k];
      r.push('| ' + f.label + ' (vraag ' + f.vraag + ') | ' + (w == null ? (f.leeg ? '– (' + f.leeg + ')' : '–') : Array.isArray(w) ? w.join(', ') : f.soort === 'pct' ? pctTekst(w) : f.soort === 'euro' ? euroTekst(w) : f.soort === 'keuze' ? (f.opties.find((o) => o[0] === w) || [w, w])[1] : String(w)) + ' |');
    }
    r.push('', '## Versies', '');
    for (const x of d.versies) r.push('- versie ' + x.versie + ' — ' + x.op.slice(0, 16).replace('T', ' ') + ' — ' + x.wat);
    r.push('');
    return r.join('\n');
  }
  function dagboekPagina(d) {
    const r = ['---', 'type: beleggingsdagboek', 'bron: pod /opt/data/beleggen/beleggen.sqlite (tabel dagboek; sleutel = dagboek-id, transactie = transactiesleutel)',
      'bijgewerkt: ' + nuIso().slice(0, 16).replace('T', ' '), 'schrijver: OVIS Beleggen (app, wv2982); wijzigen in de app, niet hier', '---', '', '# Beleggingsdagboek', '',
      'Per aankoop of verkoop: waarom, wat moet waar blijven, wanneer verkoop ik; met terugblik na 6 en 12 maanden. Geen bedragen. Plan: [[20_Prive/Financien/Beleggen/Beleggingsplan]].', ''];
    if (!d.dagboek.length) r.push('_Nog geen regels._', '');
    for (const x of d.dagboek) {
      r.push('## ' + x.datum + ' — ' + x.naam, '', '- dagboek-id: ' + x.id + (x.transactie_sleutel ? ' · transactie: `' + x.transactie_sleutel + '`' : ' · zonder transactie'));
      for (const [k, n] of [['waarom', 'Waarom'], ['blijven', 'Wat moet waar blijven'], ['verkoop_wanneer', 'Wanneer verkoop ik'], ['terugblik6', 'Terugblik na 6 maanden'], ['terugblik12', 'Terugblik na 12 maanden']])
        if (x[k]) r.push('- **' + n + ':** ' + String(x[k]).replace(/\n+/g, ' '));
      r.push('');
    }
    return r.join('\n');
  }
  function schrijfVault(welk) {
    if (!vaultSchrijf) return;
    try {
      metDb((db) => {
        const d = leesAlles(db);
        if (welk.plan) { const v = d.versies.length ? d.versies[0].versie : 0; vaultSchrijf('20_Prive/Financien/Beleggen/Beleggingsplan.md', planPagina(d, v)); }
        if (welk.dagboek) vaultSchrijf('20_Prive/Financien/Beleggen/Dagboek.md', dagboekPagina(d));
      }, false);
      vaultOk = true; laatsteVault = nuIso();
    } catch (e) { vaultOk = false; }
  }

  // ── schrijfacties ──
  function zetPlan(b) {
    const vraag = Number(b.vraag);
    if (!Number.isInteger(vraag) || vraag < 1 || vraag > 14) throw new Fout(400, 'onbekende vraag');
    const overslaan = b.overslaan === true;
    const tekst = overslaan ? null : T(b.tekst, 4000);
    const regels = overslaan ? null : regelsUit(vraag, b.waarden || {});
    metDb((db) => {
      const op = nuIso();
      db.prepare('INSERT INTO plan_antwoord (vraag, tekst, waarden, status, op) VALUES (?, ?, ?, ?, ?) ON CONFLICT(vraag) DO UPDATE SET tekst = excluded.tekst, waarden = excluded.waarden, status = excluded.status, op = excluded.op')
        .run(vraag, tekst, regels ? JSON.stringify(regels) : null, overslaan ? 'overgeslagen' : 'beantwoord', op);
      if (overslaan) for (const f of VRAGEN.find((x) => x.nr === vraag).velden || []) db.prepare('DELETE FROM regel WHERE sleutel = ?').run(f.sleutel);   // review achteraf MOET 6
      if (regels) for (const [k, w] of Object.entries(regels)) {
        if (w === null) db.prepare('DELETE FROM regel WHERE sleutel = ?').run(k);
        else db.prepare('INSERT INTO regel (sleutel, waarde, op) VALUES (?, ?, ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde, op = excluded.op').run(k, JSON.stringify(w), op);
      }
      db.prepare('INSERT INTO planversie (op, wat, momentopname) VALUES (?, ?, ?)').run(op, 'vraag ' + vraag + (overslaan ? ' overgeslagen' : ' beantwoord'), snapshot(db));
    }, true);
    schrijfVault({ plan: true });
    return { reden: 'beleggen plan vraag ' + vraag };
  }
  // wv3030: naam van een belegde positie, ook als die (nog) alleen uit transacties komt; null = onbekend
  function naamVan(db, sl) {
    const r = db.prepare("SELECT naam FROM positie WHERE sleutel = ? AND regelsoort = 'effect'").get(sl);
    if (r) return r.naam;
    const t = sl.startsWith('isin:') ? db.prepare('SELECT naam FROM transactie WHERE isin = ? ORDER BY datum DESC LIMIT 1').get(sl.slice(5))
      : db.prepare('SELECT naam FROM transactie WHERE isin IS NULL AND lower(naam) = ? ORDER BY datum DESC LIMIT 1').get(sl.slice(5));
    return t ? t.naam : null;
  }
  function zetSoort(b) {
    const sl = T(b.sleutel, 200);
    if (!sl || !/^(isin|naam):/.test(sl)) throw new Fout(400, 'onbekende positie');
    if (b.soort !== null && !SOORTEN.includes(b.soort)) throw new Fout(400, 'soort: kern, tech, health of leuk');
    metDb((db) => {
      if (!naamVan(db, sl)) throw new Fout(404, 'positie niet gevonden');
      if (b.soort === null) db.prepare('DELETE FROM positie_soort WHERE sleutel = ?').run(sl);
      else db.prepare('INSERT INTO positie_soort (sleutel, soort, op) VALUES (?, ?, ?) ON CONFLICT(sleutel) DO UPDATE SET soort = excluded.soort, op = excluded.op').run(sl, b.soort, nuIso());
    }, true);
    return { reden: 'beleggen soort' };
  }
  // handinvoer: bedragen als tekst met komma of punt
  function handGetal(x, naam, leegMag) {
    if ((x === null || x === undefined || String(x).trim() === '') && leegMag) return null;
    const t = String(x == null ? '' : x).trim();
    if (!/^[-+]?\d+([.,]\d+)?$/.test(t)) throw new Fout(400, naam + ': een getal (zonder duizendtallen)');
    return { tekst: t.replace(',', '.').replace(/^\+/, ''), n: Number(t.replace(',', '.')) };
  }
  function handDatum(x) { const t = String(x || '').trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || isNaN(Date.parse(t + 'T12:00:00Z'))) throw new Fout(400, 'datum als jjjj-mm-dd'); return t; }
  function handIsin(x) { const t = String(x || '').trim().toUpperCase(); if (!t) return null; if (!RE_ISIN.test(t)) throw new Fout(400, 'geen geldige ISIN'); return t; }
  function handValuta(x) { const t = String(x || 'EUR').trim().toUpperCase(); if (!RE_VALUTA.test(t)) throw new Fout(400, 'valuta: drie letters'); return t; }
  function zetPositie(b) {
    if (b.actie === 'weg') {
      const sl = T(b.sleutel, 200);
      metDb((db) => { const r = db.prepare('DELETE FROM positie WHERE sleutel = ? AND bron = ?').run(sl, 'hand'); if (!r.changes) throw new Fout(404, 'alleen een positie die je met de hand invoerde kan weg'); }, true);
      return { reden: 'beleggen positie weg' };
    }
    if (b.actie === 'contant') {   // wv3008 (startfase): een storting met de hand = één contantregel (cash telt niet mee in de verdeling); een ingelezen portefeuille vervangt hem
      const w = handGetal(b.waarde_eur, 'bedrag in euro');
      if (w.n < 0) throw new Fout(400, 'bedrag in euro kan niet negatief zijn');
      metDb((db) => {
        const oud = db.prepare('SELECT bron FROM positie WHERE regelsoort = ? AND bron = ? LIMIT 1').get('cash', 'bestand');
        if (oud) throw new Fout(409, 'je contant geld komt uit je bestand; zet een nieuw bestand in de app om het te wijzigen');
        db.prepare("INSERT INTO positie (sleutel, regelsoort, naam, isin, aantal, koers, valuta, lokaal_cent, waarde_eur_cent, bron, bestand_id, op) VALUES ('cash:hand', 'cash', 'Contant (met de hand)', NULL, NULL, NULL, 'EUR', NULL, ?, 'hand', NULL, ?) " +
          'ON CONFLICT(sleutel) DO UPDATE SET waarde_eur_cent = excluded.waarde_eur_cent, op = excluded.op').run(naarCent(w), nuIso());
        zetStand(db, vandaagF(), 'hand');
      }, true);
      return { reden: 'beleggen contant hand' };
    }
    if (b.actie !== 'zet') throw new Fout(400, 'actie: zet, contant of weg');
    const naam = T(b.naam, 120); if (!naam) throw new Fout(400, 'naam ontbreekt');
    const isin = handIsin(b.isin), aantal = handGetal(b.aantal, 'aantal'), koers = handGetal(b.koers, 'koers', true), valuta = handValuta(b.valuta);
    const waarde = handGetal(b.waarde_eur, 'waarde in euro');
    if (waarde.n < 0) throw new Fout(400, 'waarde in euro kan niet negatief zijn');
    const sl = isin ? 'isin:' + isin : 'naam:' + naam.toLowerCase();
    metDb((db) => {
      const oud = db.prepare('SELECT bron FROM positie WHERE sleutel = ?').get(sl);
      if (oud && oud.bron === 'bestand') throw new Fout(409, 'deze positie komt uit je bestand; zet een nieuw bestand in de app om hem te wijzigen');
      db.prepare('INSERT INTO positie (sleutel, regelsoort, naam, isin, aantal, koers, valuta, lokaal_cent, waarde_eur_cent, bron, bestand_id, op) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?) ' +
        'ON CONFLICT(sleutel) DO UPDATE SET naam = excluded.naam, aantal = excluded.aantal, koers = excluded.koers, valuta = excluded.valuta, waarde_eur_cent = excluded.waarde_eur_cent, op = excluded.op')
        .run(sl, 'effect', naam, isin, aantal.tekst, koers ? koers.tekst : null, valuta, naarCent(waarde), 'hand', nuIso());
      if (SOORTEN.includes(b.soort)) db.prepare('INSERT INTO positie_soort (sleutel, soort, op) VALUES (?, ?, ?) ON CONFLICT(sleutel) DO UPDATE SET soort = excluded.soort, op = excluded.op').run(sl, b.soort, nuIso());
      zetStand(db, vandaagF(), 'hand');
    }, true);
    return { reden: 'beleggen positie hand' };
  }
  function zetStand(db, datum, bron) {
    db.prepare("INSERT INTO meta (sleutel, waarde) VALUES ('stand_datum', ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde").run(datum);
    db.prepare("INSERT INTO meta (sleutel, waarde) VALUES ('stand_bron', ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde").run(bron);
  }
  function zetTransactie(b) {
    if (b.actie === 'weg') {
      const sl = T(b.sleutel, 200);
      metDb((db) => { const r = db.prepare('DELETE FROM transactie WHERE sleutel = ? AND bron = ?').run(sl, 'hand'); if (!r.changes) throw new Fout(404, 'alleen een transactie die je met de hand invoerde kan weg'); }, true);
      return { reden: 'beleggen transactie weg' };
    }
    if (b.actie !== 'zet') throw new Fout(400, 'actie: zet of weg');
    const naam = T(b.naam, 120); if (!naam) throw new Fout(400, 'naam ontbreekt');
    if (b.richting !== 'erbij' && b.richting !== 'eraf') throw new Fout(400, 'richting: erbij of eraf');
    const datum = handDatum(b.datum), isin = handIsin(b.isin), aantal = handGetal(b.aantal, 'aantal'), koers = handGetal(b.koers, 'koers'), valuta = handValuta(b.valuta);
    if (!(aantal.n > 0)) throw new Fout(400, 'aantal groter dan nul');
    const waarde = handGetal(b.waarde_eur, 'waarde in euro', valuta === 'EUR'), kosten = handGetal(b.kosten_eur, 'kosten in euro', true);
    const lokaal = Math.round(aantal.n * koers.n * 100);
    const weur = waarde ? naarCent(waarde) : lokaal;
    const teken = b.richting === 'erbij' ? 1 : -1;
    const sl = 'hand:' + crypto.randomBytes(8).toString('hex');
    metDb((db) => {
      db.prepare('INSERT INTO transactie (sleutel, datum, tijd, naam, isin, beurs, aantal, koers, valuta, lokaal_cent, waarde_eur_cent, wisselkoers, kosten_eur_cent, totaal_eur_cent, order_id, bron, bestand_id, op) ' +
        'VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, NULL, ?)')
        .run(sl, datum, naam, isin, (teken < 0 ? '-' : '') + aantal.tekst, koers.tekst, valuta, -teken * lokaal, -teken * Math.abs(weur), kosten ? -Math.abs(naarCent(kosten)) : 0,
          -teken * Math.abs(weur) - (kosten ? Math.abs(naarCent(kosten)) : 0), 'hand', nuIso());
    }, true);
    return { reden: 'beleggen transactie hand', sleutel: sl };
  }
  function zetBestand(b) {
    const naam = T(b.naam, 200) || 'bestand.csv';
    if (typeof b.tekst !== 'string') throw new Fout(400, 'bestandsinhoud ontbreekt');
    const datum = b.datum ? handDatum(b.datum) : vandaagF();
    let l;
    try { l = leesBestand(b.tekst); } catch (e) {
      if (e instanceof LeesFout) return { status: 422, body: { ok: false, fout: e.message, regel: e.regel, kolom: e.kolom }, reden: 'beleggen bestand geweigerd' };
      throw e;
    }
    const h = sha(b.tekst);
    const uit = metDb((db) => {
      let nieuw = 0, bekend = 0;
      if (l.soort === 'transacties' || l.soort === 'rekening') {
        const tab = l.soort === 'transacties' ? 'transactie' : 'rekening';
        const st = db.prepare('SELECT 1 FROM ' + tab + ' WHERE sleutel = ?');
        for (const r of l.rijen) { if (st.get(r.sleutel)) bekend++; else nieuw++; }
      } else {
        const vorige = db.prepare("SELECT sha256 FROM bestand WHERE soort = 'portefeuille' ORDER BY id DESC LIMIT 1").get();
        if (vorige && vorige.sha256 === h) bekend = l.rijen.length; else nieuw = l.rijen.length;
      }
      const samen = { ok: true, soort: l.soort, rijen: l.rijen.length, nieuw, al_bekend: bekend, decimaal: l.decimaal,
        niet_meegenomen: l.overgeslagen.length, niet_meegenomen_regels: l.overgeslagen.slice(0, 20).map((x) => x.regel), datum: l.soort === 'portefeuille' ? datum : null,
        effecten: l.soort === 'portefeuille' ? l.rijen.filter((r) => r.regelsoort === 'effect').length : undefined, bewaard: false };
      if (b.bewaar !== true) return { status: 200, body: samen, reden: 'beleggen bestand proef ' + l.soort };
      if (!nieuw && l.soort !== 'portefeuille') return { status: 200, body: Object.assign(samen, { bewaard: true, melding: 'niets nieuws: alles stond er al in' }), reden: 'beleggen bestand dubbel ' + l.soort };
      if (!nieuw) return { status: 200, body: Object.assign(samen, { bewaard: true, melding: 'dit bestand was al ingelezen' }), reden: 'beleggen bestand dubbel portefeuille' };
      const op = nuIso();
      let koppeld = 0;
      const id = Number(db.prepare('INSERT INTO bestand (soort, naam, sha256, datum_bestand, op, rijen, nieuw, inhoud) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(l.soort, naam, h, l.soort === 'portefeuille' ? datum : null, op, l.rijen.length, nieuw, b.tekst).lastInsertRowid);
      if (l.soort === 'transacties') {
        const st = db.prepare('INSERT OR IGNORE INTO transactie (sleutel, datum, tijd, naam, isin, beurs, aantal, koers, valuta, lokaal_cent, waarde_eur_cent, wisselkoers, kosten_eur_cent, totaal_eur_cent, order_id, bron, bestand_id, op) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const r of l.rijen) st.run(r.sleutel, r.datum, r.tijd, r.naam, r.isin, r.beurs, r.aantal, r.koers, r.valuta, r.lokaal_cent, r.waarde_eur_cent, r.wisselkoers, r.kosten_eur_cent, r.totaal_eur_cent, r.order_id, 'bestand', id, op);
        koppeld = koppelHandregels(db);   // wv3756: een dagboekzin uit het gesprek hangt nu aan zijn aankoop
      } else if (l.soort === 'rekening') {
        const st = db.prepare('INSERT OR IGNORE INTO rekening (sleutel, datum, tijd, valutadatum, naam, isin, omschrijving, mutatie_cent, mutatie_valuta, saldo_cent, saldo_valuta, order_id, bestand_id, op) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const r of l.rijen) st.run(r.sleutel, r.datum, r.tijd, r.valutadatum, r.naam, r.isin, r.omschrijving, r.mutatie_cent, r.mutatie_valuta, r.saldo_cent, r.saldo_valuta, r.order_id, id, op);
      } else {
        // de stand uit het bestand vervangt alle posities uit een eerder bestand en een handpositie met dezelfde ISIN; Davids soortkeuze blijft
        db.prepare("DELETE FROM positie WHERE bron = 'bestand' OR regelsoort = 'cash'").run();
        const st = db.prepare('INSERT OR REPLACE INTO positie (sleutel, regelsoort, naam, isin, aantal, koers, valuta, lokaal_cent, waarde_eur_cent, bron, bestand_id, op) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const r of l.rijen) st.run(r.sleutel, r.regelsoort, r.naam, r.isin, r.aantal, r.koers, r.valuta, r.lokaal_cent, r.waarde_eur_cent, 'bestand', id, op);
        zetStand(db, datum, 'bestand');
      }
      return { status: 200, body: Object.assign(samen, { bewaard: true }, koppeld ? { dagboek_gekoppeld: koppeld } : {}), reden: 'beleggen bestand ' + l.soort + ' ' + nieuw + ' nieuw' };
    }, true);
    if (uit && uit.body && uit.body.dagboek_gekoppeld) schrijfVault({ dagboek: true });   // wv3756: de vaultpagina toont nu de transactie
    return uit;
  }
  function zetDagboek(b) {
    const velden = { waarom: T(b.waarom), blijven: T(b.blijven), verkoop_wanneer: T(b.verkoop_wanneer), terugblik6: T(b.terugblik6), terugblik12: T(b.terugblik12) };
    let id;
    metDb((db) => {
      const op = nuIso();
      if (b.id != null) {
        const r = db.prepare('SELECT id FROM dagboek WHERE id = ?').get(Number(b.id));
        if (!r) throw new Fout(404, 'dagboekregel niet gevonden');
        db.prepare('UPDATE dagboek SET waarom = ?, blijven = ?, verkoop_wanneer = ?, terugblik6 = ?, terugblik12 = ?, bijgewerkt = ? WHERE id = ?')
          .run(velden.waarom, velden.blijven, velden.verkoop_wanneer, velden.terugblik6, velden.terugblik12, op, r.id);
        id = r.id;
        return;
      }
      let datum, naam, tx = null;
      if (b.transactie) {
        tx = db.prepare('SELECT sleutel, datum, naam FROM transactie WHERE sleutel = ?').get(String(b.transactie));
        if (!tx) throw new Fout(404, 'transactie niet gevonden');
        if (db.prepare('SELECT 1 FROM dagboek WHERE transactie_sleutel = ?').get(tx.sleutel)) throw new Fout(409, 'bij deze transactie staat al een dagboekregel');
        datum = tx.datum; naam = tx.naam;
      } else { datum = handDatum(b.datum || vandaagF()); naam = T(b.naam, 120); if (!naam) throw new Fout(400, 'naam ontbreekt'); }
      if (!velden.waarom && !velden.blijven && !velden.verkoop_wanneer) throw new Fout(400, 'schrijf minstens één van: waarom, wat moet waar blijven, wanneer verkoop ik');
      const richting = !tx && (b.richting === 'koop' || b.richting === 'verkoop') ? b.richting : null;   // wv3756: alleen bij een regel zonder transactie
      id = Number(db.prepare('INSERT INTO dagboek (transactie_sleutel, datum, naam, waarom, blijven, verkoop_wanneer, terugblik6, terugblik12, op, bijgewerkt, richting) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(tx ? tx.sleutel : null, datum, naam, velden.waarom, velden.blijven, velden.verkoop_wanneer, velden.terugblik6, velden.terugblik12, op, op, richting).lastInsertRowid);
    }, true);
    schrijfVault({ dagboek: true });
    return { reden: 'beleggen dagboek', id };
  }
  function zetVolglijst(b) {
    if (b.actie === 'weg') {
      metDb((db) => { const r = db.prepare('UPDATE volglijst SET weg = 1 WHERE id = ? AND weg = 0').run(Number(b.id)); if (!r.changes) throw new Fout(404, 'niet gevonden'); }, true);
      return { reden: 'beleggen volglijst weg' };
    }
    if (b.actie !== 'zet') throw new Fout(400, 'actie: zet of weg');
    const naam = T(b.naam, 120); if (!naam) throw new Fout(400, 'naam ontbreekt');
    const v = { code: T(b.code, 40), thema: b.thema && SOORTEN.includes(b.thema) ? b.thema : null, waarom: T(b.waarom), wanneer: T(b.wanneer) };
    let id;
    metDb((db) => {
      if (b.id != null) {
        const r = db.prepare('UPDATE volglijst SET naam = ?, code = ?, thema = ?, waarom = ?, wanneer = ? WHERE id = ? AND weg = 0').run(naam, v.code, v.thema, v.waarom, v.wanneer, Number(b.id));
        if (!r.changes) throw new Fout(404, 'niet gevonden'); id = Number(b.id);
      } else id = Number(db.prepare('INSERT INTO volglijst (naam, code, thema, waarom, wanneer, op) VALUES (?, ?, ?, ?, ?, ?)').run(naam, v.code, v.thema, v.waarom, v.wanneer, nuIso()).lastInsertRowid);
    }, true);
    return { reden: 'beleggen volglijst', id };
  }
  function zetSignaal(b) {
    const sl = T(b.sleutel, 300);
    if (!sl) throw new Fout(400, 'signaal ontbreekt');
    if (b.keuze !== 'niets' && b.keuze !== 'herinner') throw new Fout(400, 'keuze: niets of herinner');
    metDb((db) => {
      let tot = null;
      if (b.keuze === 'herinner') {
        const r = db.prepare("SELECT waarde FROM regel WHERE sleutel = 'afkoel_dagen'").get();
        tot = plusDagen(vandaagF(), r ? JSON.parse(r.waarde) : 7);
      }
      db.prepare('INSERT INTO signaal_keuze (sleutel, keuze, tot, op) VALUES (?, ?, ?, ?) ON CONFLICT(sleutel) DO UPDATE SET keuze = excluded.keuze, tot = excluded.tot, op = excluded.op').run(sl, b.keuze, tot, nuIso());
    }, true);
    return { reden: 'beleggen signaal ' + b.keuze };
  }

  // ── fase 2 (wv2993): kaartje "Nieuws over dit bedrijf", weekbericht lezen, keuze per kaart ──
  // Het ophalen en de weekronde staan in beleggen-nieuws.js (die doet de verzoeken); hier alleen de databank en Davids invoer.
  const BELANG_RE = /\b(anthropic|claude)\b/i;
  // voorstel voor de schrijfwijze: de naam uit het bestand zonder rechtsvorm of aandelenklasse ("VOORBEELD CHIPS INC" → "VOORBEELD CHIPS")
  const kaleNaam = (n) => String(n || '').replace(/[,.]/g, ' ').replace(/\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|NV|N V|SA|SE|AG|PLC|LTD|LIMITED|HOLDINGS?|GROUP|A\/S|AS|ASA|AB|SPA|BV|CLASS [A-C]|CL [A-C]|ADR|ORD|REG|SHS)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim() || String(n || '').trim();
  function leesBedrijven(db) {
    const uit = {};
    for (const r of db.prepare('SELECT * FROM bedrijf').all()) uit[r.sleutel] = { sleutel: r.sleutel, naam: r.naam, namen: JSON.parse(r.namen), code: r.code, cik: r.cik,
      sponsor: r.sponsor, producten: JSON.parse(r.producten || '[]'), belang: !!r.belang, op: r.op };
    return uit;
  }
  // Alle bedrijven die nieuws kunnen krijgen: posities (geen kern/indexfonds, geen contant) + volglijst. Met Davids reden (dagboek of volglijst).
  function bedrijvenUit(db, d, k) {
    const kaartjes = db ? leesBedrijven(db) : {};
    const R = d.regels || {};
    const lijst = [];
    for (const p of k.posities) {
      if (p.soort === 'kern') continue;
      lijst.push({ sleutel: p.sleutel, naam: p.naam, bron: 'positie', soort: p.soort || null, aandeel: p.aandeel, boven_max: R.max_aandeel != null && p._maat != null && p._maat > R.max_aandeel + 1e-9,   // wv3755: opbouwfase
        reden: k.woorden[p.sleutel] || null, kaartje: kaartjes[p.sleutel] || null, voorstel: { namen: [kaleNaam(p.naam)], code: null } });
    }
    for (const v of d.volglijst) lijst.push({ sleutel: 'volg:' + v.id, naam: v.naam, bron: 'volglijst', soort: v.thema || null, aandeel: null, boven_max: false,
      reden: v.waarom || null, kaartje: kaartjes['volg:' + v.id] || null, voorstel: { namen: [kaleNaam(v.naam)], code: v.code || null } });
    return lijst;
  }
  // Voor beleggen-nieuws.js: wat er nodig is om op te halen en te wegen (geen bedragen; aandeel in % alleen voor de kaart in de app).
  function nieuwsData() {
    return metDb((db) => {
      const d = metAankoop(leesAlles(db));
      const vandaag = vandaagF();
      const k = bereken(d, vandaag);
      const bedrijven = bedrijvenUit(db, d, k).map((b) => { const x = Object.assign({}, b); delete x.voorstel; return x; });
      return { vandaag, regels: { max_aandeel: d.regels.max_aandeel == null ? null : d.regels.max_aandeel, afkoel_dagen: d.regels.afkoel_dagen == null ? null : d.regels.afkoel_dagen }, bedrijven };
    }, false);
  }
  const lijstVan = (x) => (Array.isArray(x) ? x : String(x == null ? '' : x).split('\n')).map((s) => String(s).trim()).filter(Boolean);
  function zetBedrijf(b) {
    const sl = T(b.sleutel, 200);
    if (!sl || !/^(isin|naam):|^volg:\d+$/.test(sl)) throw new Fout(400, 'onbekend bedrijf');
    return metDb((db) => {
      let naam = null;
      if (sl.startsWith('volg:')) { const r = db.prepare('SELECT naam FROM volglijst WHERE id = ? AND weg = 0').get(Number(sl.slice(5))); naam = r && r.naam; }
      else naam = naamVan(db, sl);
      if (!naam) throw new Fout(404, 'bedrijf niet gevonden in je stand of volglijst');
      if (b.actie === 'weg') {   // wv3728: uit blijft uit (de ochtendronde zet het kaartje niet opnieuw vanzelf aan)
        db.prepare('DELETE FROM bedrijf WHERE sleutel = ?').run(sl);
        db.prepare('INSERT INTO bedrijf_uit (sleutel, op) VALUES (?, ?) ON CONFLICT(sleutel) DO UPDATE SET op = excluded.op').run(sl, nuIso());
        return { reden: 'beleggen bedrijf weg' };
      }
      if (b.actie !== 'zet') throw new Fout(400, 'actie: zet of weg');
      const namen = [...new Set(lijstVan(b.namen))];
      if (!namen.length) throw new Fout(400, 'minstens één schrijfwijze van de naam');
      if (namen.length > 8 || namen.some((n) => n.length < 2 || n.length > 60)) throw new Fout(400, 'schrijfwijzen: hooguit 8, elk 2 tot 60 tekens');
      const producten = [...new Set(lijstVan(b.producten))];
      if (producten.length > 10 || producten.some((n) => n.length < 2 || n.length > 60)) throw new Fout(400, 'productnamen: hooguit 10, elk 2 tot 60 tekens');
      const code = b.code == null || String(b.code).trim() === '' ? null : String(b.code).trim().toUpperCase();
      if (code && !/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(code)) throw new Fout(400, 'beurscode: letters en cijfers, hooguit 12');
      const cikRuw = b.cik == null ? '' : String(b.cik).trim().replace(/^0+/, '');
      if (cikRuw && !/^\d{1,10}$/.test(cikRuw)) throw new Fout(400, 'SEC-nummer (CIK): alleen cijfers, hooguit 10');
      const cik = cikRuw ? cikRuw.padStart(10, '0') : null;
      const sponsor = T(b.sponsor, 120);
      const belang = b.belang === true || BELANG_RE.test(namen.join(' ') + ' ' + naam) ? 1 : 0;
      db.prepare('INSERT INTO bedrijf (sleutel, naam, namen, code, cik, sponsor, producten, belang, op) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sleutel) DO UPDATE SET ' +
        'naam = excluded.naam, namen = excluded.namen, code = excluded.code, cik = excluded.cik, sponsor = excluded.sponsor, producten = excluded.producten, belang = excluded.belang, op = excluded.op')
        .run(sl, naam, JSON.stringify(namen), code, cik, sponsor, JSON.stringify(producten), belang, nuIso());
      db.prepare('DELETE FROM bedrijf_uit WHERE sleutel = ?').run(sl);   // wv3728: weer aan
      // review wv3728 MOET 2: een beurscode die David zelf zet gaat voor op de gevonden code; bij een andere code vervallen de oude koersen
      if (code && sl.startsWith('isin:')) {
        const oud = db.prepare('SELECT code FROM koerscode WHERE sleutel = ?').get(sl);
        if (oud && oud.code && oud.code !== code) db.prepare('DELETE FROM koers WHERE isin = ?').run(sl.slice(5));
        db.prepare('INSERT INTO koerscode (sleutel, code, cik, naam_bron, op, fout) VALUES (?, ?, ?, NULL, ?, NULL) ON CONFLICT(sleutel) DO UPDATE SET code = excluded.code, cik = COALESCE(excluded.cik, koerscode.cik), fout = NULL, op = excluded.op')
          .run(sl, code, cik, nuIso());
      }
      return { reden: 'beleggen bedrijf' };
    }, true);
  }
  const WEEK_KEUZES = ['niets', 'dagboek', 'herinner', 'ruis', 'nuttig'];
  function leesWeek() {
    return metDb((db) => {
      const vandaag = vandaagF();
      const leeg = { ok: true, vandaag, weken: [], keuzes: {}, herinneringen: [], gezakt: [], ingesteld: 0, afkoel_dagen: null };
      if (!db) return leeg;
      const r = db.prepare("SELECT waarde FROM regel WHERE sleutel = 'afkoel_dagen'").get();
      leeg.afkoel_dagen = r ? JSON.parse(r.waarde) : null;
      leeg.ingesteld = db.prepare('SELECT COUNT(*) AS n FROM bedrijf').get().n;
      leeg.weken = db.prepare('SELECT iso_week, van, tot, gemaakt_op, kaarten, verder, belang, model, gemeld_op FROM week ORDER BY iso_week DESC LIMIT 12').all().map((w) => {
        const m = JSON.parse(w.model || '{}');
        return { iso_week: w.iso_week, van: w.van, tot: w.tot, gemaakt_op: w.gemaakt_op, kaarten: JSON.parse(w.kaarten), verder: JSON.parse(w.verder), belang: JSON.parse(w.belang),
          gewogen: m.ok === true, gemeld: !!w.gemeld_op };
      });
      for (const k of db.prepare('SELECT iso_week, bedrijf, keuze, tot FROM week_keuze').all()) (leeg.keuzes[k.iso_week] = leeg.keuzes[k.iso_week] || {})[k.bedrijf] = { keuze: k.keuze, tot: k.tot };
      // herinnering: een kaart uit een eerdere week waarvan de afkoeltijd om is, staat bovenaan tot David een andere keuze maakt
      for (const w of leeg.weken.slice(1)) for (const kaart of w.kaarten) {
        const k = (leeg.keuzes[w.iso_week] || {})[kaart.bedrijf];
        if (k && k.keuze === 'herinner' && k.tot && k.tot <= vandaag) leeg.herinneringen.push({ iso_week: w.iso_week, kaart });
      }
      leeg.gezakt = db.prepare('SELECT bron FROM nieuws_bron WHERE gezakt = 1 ORDER BY bron').all().map((x) => x.bron);
      return leeg;
    }, false);
  }
  function zetWeekKeuze(b) {
    if (b.actie === 'terug') {
      const bron = T(b.bron, 120); if (!bron) throw new Fout(400, 'bron ontbreekt');
      metDb((db) => { const r = db.prepare('UPDATE nieuws_bron SET gezakt = 0, ruis_teller = 0 WHERE bron = ? AND gezakt = 1').run(bron); if (!r.changes) throw new Fout(404, 'bron niet gevonden'); }, true);
      return { reden: 'beleggen bron terug' };
    }
    const week = T(b.week, 10), bedrijf = T(b.bedrijf, 200);
    if (!week || !/^\d{4}-W\d{2}$/.test(week) || !bedrijf) throw new Fout(400, 'week en bedrijf nodig');
    if (!WEEK_KEUZES.includes(b.keuze)) throw new Fout(400, 'keuze: niets, dagboek, herinner, ruis of nuttig');
    let tot = null;
    metDb((db) => {
      const w = db.prepare('SELECT kaarten FROM week WHERE iso_week = ?').get(week);
      const kaart = w && JSON.parse(w.kaarten).find((k) => k.bedrijf === bedrijf);
      if (!kaart) throw new Fout(404, 'kaart niet gevonden');
      const oud = db.prepare('SELECT keuze FROM week_keuze WHERE iso_week = ? AND bedrijf = ?').get(week, bedrijf);
      if (b.keuze === 'herinner') {
        const r = db.prepare("SELECT waarde FROM regel WHERE sleutel = 'afkoel_dagen'").get();
        tot = plusDagen(vandaagF(), r ? JSON.parse(r.waarde) : 7);
      }
      db.prepare('INSERT INTO week_keuze (iso_week, bedrijf, keuze, tot, op) VALUES (?, ?, ?, ?, ?) ON CONFLICT(iso_week, bedrijf) DO UPDATE SET keuze = excluded.keuze, tot = excluded.tot, op = excluded.op')
        .run(week, bedrijf, b.keuze, tot, nuIso());
      // Ruis telt één keer per kaart op bij elke bron op die kaart; na drie keer zakt de bron naar Verder gezien (terug te zetten)
      const telt = (b.keuze === 'ruis') - (!!oud && oud.keuze === 'ruis');
      if (telt) for (const bron of [...new Set((kaart.gebeurd || []).map((g) => g.bronsleutel).filter(Boolean))]) {
        db.prepare('INSERT INTO nieuws_bron (bron) VALUES (?) ON CONFLICT(bron) DO NOTHING').run(bron);
        db.prepare('UPDATE nieuws_bron SET ruis_teller = MAX(0, ruis_teller + ?) WHERE bron = ?').run(telt, bron);
        db.prepare('UPDATE nieuws_bron SET gezakt = CASE WHEN ruis_teller >= 3 THEN 1 ELSE gezakt END WHERE bron = ?').run(bron);
      }
    }, true);
    return { reden: 'beleggen week ' + b.keuze };
  }

  // ── wv3756 (nr 908 / L08, David Ja 21-11): Socev in het gewone gesprek (skill beleggen, pod-route POST /smal/beleggen) ──
  // "Hoe sta ik ervoor?" → gesprekStand (stand, vandaag, wat aandacht vraagt; dezelfde berekening als het scherm). "X gekocht omdat …" →
  // gesprekDagboek: koppelt de zin aan de ene open aankoop van dat aandeel (dagboekvraag van de app is dan weg), anders een regel zonder transactie
  // die bij het inlezen van de transacties vanzelf aan die aankoop hangt (koppelHandregels). Alleen lezen en een dagboekregel; nooit handelen.
  const euro = (c) => (c == null ? null : Math.round(c) / 100);
  function gesprekStand() {
    const o = overzicht();
    const s = o.stand, v = s.vandaag || null;
    const bronUitleg = { bestand: 'uit je ingelezen portefeuille van DEGIRO', hand: 'met de hand ingevuld', aankoop: 'op aankoopwaarde uit je transacties (geen portefeuille ingelezen)' };
    const laatste = o.dagboek.slice(0, 3).map((d) => ({ datum: d.datum, naam: d.naam, waarom: d.waarom }));
    return { status: 200, body: { ok: true, vandaag: o.vandaag,
      stand: { datum: s.datum, bron: s.bron, bron_uitleg: bronUitleg[s.bron] || null, belegd_eur: euro(s.verdeling.belegd_cent), contant_eur: euro(s.verdeling.cash_cent),
        verdeling_pct: { kern: s.verdeling.kern, tech: s.verdeling.tech, health: s.verdeling.health, leuk: s.verdeling.leuk, zonder_soort: s.verdeling.zonder },
        onvolledig: s.onvolledig, volledig: s.volledig,
        posities: s.posities.map((p) => { const w = v && v.posities ? v.posities[p.sleutel] : null;
          return { naam: p.naam, soort: o.soort_namen[p.soort] || null, aandeel_pct: p.aandeel, aantal: p.aantal, waarde_eur: euro(p.waarde_eur_cent),
            koers: w && w.koers ? { slot: w.koers, valuta: w.valuta, datum: w.datum, waarde_eur: euro(w.waarde_cent), vorige_datum: w.vorige_datum, vorige_waarde_eur: euro(w.vorige_cent), aankoop_eur: euro(w.aankoop_cent) }
              : w && w.reden ? { zonder: w.reden } : null }; }) },
      waarde_vandaag: v ? { volledig: v.volledig, waarde_eur: euro(v.waarde_cent), sinds_vorige_beursdag_eur: euro(v.verschil_dag_cent), sinds_aankoop_eur: euro(v.verschil_aankoop_cent),
        koers_datum: v.koers_datum, oud: v.oud, zonder_koers: v.zonder_koers } : null,
      lampjes: s.lampjes.map((l) => ({ naam: l.naam, grens: l.grens, stand: l.stand, lamp: l.lamp, uitleg: l.uitleg })),
      aandacht: o.signalen.slice(0, 5).map((x) => Object.assign({ soort: x.soort, titel: x.titel, wat: x.wat || null, plan: x.plan || null }, x.eigen ? { eigen_woorden: x.eigen } : {})),   // wv3755: bij een daling Davids eigen woorden
      aandacht_meer: Math.max(0, o.signalen.length - 5),
      open_punten: { aantal: o.open_punten.length, eerste: o.open_punten.slice(0, 5).map((x) => x.tekst) },
      dagboek: { regels: o.dagboek.length, laatste }, volglijst: o.volglijst.map((x) => x.naam), belang: o.belang } };
  }
  // open aankopen/verkopen zonder dagboekregel en zonder "Niets doen" (zelfde groepen als het scherm)
  function openDagboek(o) {
    o = o || overzicht();
    const open = new Set(o.open_punten.filter((x) => x.soort === 'dagboek').map((x) => x.transactie));
    return dagboekGroepen(o.transacties).filter((g) => open.has(g.eerste))
      .map((g) => { const t = o.transacties.find((x) => x.sleutel === g.eerste) || {}; return { transactie: g.eerste, datum: g.datum, naam: g.naam, isin: t.isin || null, richting: g.erbij ? 'koop' : 'verkoop', aantal: g.aantal, orders: g.leden.length }; });
  }
  // wat David zegt ("NVDA", "Nvidia") → past bij een groep op naam, ISIN of de beurscode uit het nieuwskaartje of de koersronde
  function codesNaarIsin() {
    return metDb((db) => {
      const m = {};
      if (!db) return m;
      for (const r of db.prepare("SELECT sleutel, code FROM bedrijf WHERE code IS NOT NULL AND sleutel LIKE 'isin:%'").all()) m[String(r.code).toUpperCase()] = r.sleutel.slice(5);
      for (const r of db.prepare("SELECT sleutel, code FROM koerscode WHERE code IS NOT NULL AND sleutel LIKE 'isin:%'").all()) if (!m[String(r.code).toUpperCase()]) m[String(r.code).toUpperCase()] = r.sleutel.slice(5);
      return m;
    }, false);
  }
  function pastBij(gezegd, g, codes) {
    const t = String(gezegd || '').trim(), T2 = t.toUpperCase();
    if (g.isin && (T2 === g.isin || codes[T2] === g.isin)) return true;
    return pastNaam(t, g.naam);
  }
  function gesprekDagboek(b) {
    const waarom = T(b.waarom);
    if (!waarom) throw new Fout(400, 'waarom ontbreekt: de reden in Davids eigen woorden');
    const extra = { blijven: T(b.blijven), verkoop_wanneer: T(b.verkoop_wanneer) };
    const richting = b.richting == null || b.richting === '' ? null : String(b.richting);
    if (richting && richting !== 'koop' && richting !== 'verkoop') throw new Fout(400, 'richting: koop of verkoop');
    const o = overzicht();
    const zet = (tx) => {
      const u = zetDagboek(Object.assign({ transactie: tx.transactie, waarom }, extra));
      return { status: 200, body: { ok: true, id: u.id, gekoppeld: tx } };
    };
    if (b.transactie) {
      const tx = openDagboek(o).find((g) => g.transactie === String(b.transactie));
      if (!tx) {
        const bestaat = o.dagboek.find((d) => d.transactie_sleutel === String(b.transactie));
        if (bestaat) return { status: 409, body: { ok: false, fout: 'bij deze transactie staat al een dagboekregel', dubbel: true, regel: { id: bestaat.id, datum: bestaat.datum, naam: bestaat.naam, waarom: bestaat.waarom } } };
        throw new Fout(404, 'geen open transactie met deze sleutel (zie dagboek-open)');
      }
      return zet(tx);
    }
    const naam = T(b.naam, 120);
    if (!naam) throw new Fout(400, 'naam ontbreekt: welk aandeel of fonds');
    const datum = b.datum ? handDatum(b.datum) : vandaagF();
    const codes = codesNaarIsin();
    const venster = (g) => g.datum <= datum && g.datum >= plusDagen(datum, -14);
    const kand = openDagboek(o).filter((g) => venster(g) && (!richting || g.richting === richting) && pastBij(naam, g, codes));
    if (kand.length === 1) return zet(kand[0]);
    if (kand.length > 1) return { status: 409, body: { ok: false, fout: 'meer dan één transactie past; kies er één en stuur transactie mee', keuzes: kand } };
    // geen open aankoop: staat er al een regel bij een aankoop van dit aandeel in dit venster, of dezelfde zin al zonder transactie?
    const ruim = (g) => g.datum <= plusDagen(datum, 5) && g.datum >= plusDagen(datum, -14);   // review MOET 2: zelfde venster als koppelHandregels
    const metRegel = dagboekGroepen(o.transacties).filter((g) => ruim(g) && (!richting || (g.erbij ? 'koop' : 'verkoop') === richting) && pastBij(naam, Object.assign({ isin: (o.transacties.find((x) => x.sleutel === g.eerste) || {}).isin }, g), codes))
      .map((g) => o.dagboek.find((d) => g.leden.includes(d.transactie_sleutel))).filter(Boolean);
    if (metRegel.length) { const d = metRegel[0]; return { status: 409, body: { ok: false, fout: 'bij die transactie staat al een dagboekregel', dubbel: true, regel: { id: d.id, datum: d.datum, naam: d.naam, waarom: d.waarom } } }; }
    const zelfde = o.dagboek.find((d) => !d.transactie_sleutel && d.datum === datum && zoekVorm(d.naam) === zoekVorm(naam) && String(d.waarom || '').trim() === waarom && (d.richting || null) === richting);
    if (zelfde) return { status: 200, body: { ok: true, id: zelfde.id, dubbel: true, zonder_transactie: true } };
    const u = zetDagboek(Object.assign({ naam, datum, waarom, richting }, extra));
    return { status: 200, body: { ok: true, id: u.id, zonder_transactie: true } };
  }
  // Een dagboekregel zonder transactie (uit het gesprek of de app) hangt na het inlezen van de transacties aan de ene aankoop/verkoop van dat
  // aandeel van hooguit 14 dagen ervóór tot 5 dagen erna (order die pas later uitgevoerd werd). Alleen als precies één groep zonder regel past én
  // die groep maar bij één losse regel past: anders blijft alles zoals het was (niet raden).
  function koppelHandregels(db) {
    const los = db.prepare('SELECT id, datum, naam, richting FROM dagboek WHERE transactie_sleutel IS NULL').all();
    if (!los.length) return 0;
    const tx = db.prepare('SELECT sleutel, datum, tijd, naam, isin, aantal FROM transactie').all();
    const metRegel = new Set(db.prepare('SELECT transactie_sleutel AS s FROM dagboek WHERE transactie_sleutel IS NOT NULL').all().map((r) => r.s));
    const groepen = dagboekGroepen(tx).filter((g) => !g.leden.some((x) => metRegel.has(x)))
      .map((g) => Object.assign({ isin: (tx.find((x) => x.sleutel === g.eerste) || {}).isin || null }, g));
    const codes = {};
    for (const r of db.prepare("SELECT sleutel, code FROM bedrijf WHERE code IS NOT NULL AND sleutel LIKE 'isin:%'").all()) codes[String(r.code).toUpperCase()] = r.sleutel.slice(5);
    const paren = los.map((d) => ({ d, gs: groepen.filter((g) => g.datum >= plusDagen(d.datum, -14) && g.datum <= plusDagen(d.datum, 5) && pastBij(d.naam, g, codes)
      && (!d.richting || (g.erbij ? 'koop' : 'verkoop') === d.richting)) }));   // review MOET 1: een verkoopreden hangt nooit aan een aankoop
    let n = 0;
    const st = db.prepare('UPDATE dagboek SET transactie_sleutel = ?, bijgewerkt = ? WHERE id = ? AND transactie_sleutel IS NULL');
    for (const p of paren) {
      if (p.gs.length !== 1) continue;
      const g = p.gs[0];
      if (paren.filter((q) => q.gs.some((x) => x.eerste === g.eerste)).length !== 1) continue;
      st.run(g.eerste, nuIso(), p.d.id); n++;
    }
    return n;
  }
  function gesprek(b) {
    b = b && typeof b === 'object' ? b : {};
    try {
      if (b.opdracht === 'stand') return gesprekStand();
      if (b.opdracht === 'dagboek-open') return { status: 200, body: { ok: true, open: openDagboek() } };
      if (b.opdracht === 'dagboek') return gesprekDagboek(b);
      return { status: 400, body: { ok: false, fout: 'opdracht: stand, dagboek-open of dagboek' } };
    } catch (e) {
      if (e instanceof Fout) return { status: e.status, body: { ok: false, fout: e.message } };
      throw e;
    }
  }

  const SCHRIJF = { '/app/beleggen/plan': zetPlan, '/app/beleggen/soort': zetSoort, '/app/beleggen/positie': zetPositie, '/app/beleggen/transactie': zetTransactie,
    '/app/beleggen/bestand': zetBestand, '/app/beleggen/dagboek': zetDagboek, '/app/beleggen/volglijst': zetVolglijst, '/app/beleggen/signaal': zetSignaal,
    '/app/beleggen/bedrijf': zetBedrijf, '/app/beleggen/week/keuze': zetWeekKeuze };
  function app(v) {
    try {
      if (v.methode === 'GET' && v.pad === '/app/beleggen') return { status: 200, body: overzicht(), reden: 'beleggen' };
      if (v.methode === 'GET' && v.pad === '/app/beleggen/week') return { status: 200, body: leesWeek(), reden: 'beleggen week' };
      if (v.methode === 'GET' && v.pad === '/app/beleggen/teller') return { status: 200, body: teller(), reden: 'beleggen teller' };   // wv3727
      if (v.methode === 'POST' && v.pad === '/app/beleggen/past') return { status: 200, body: pastDit(v.body && typeof v.body === 'object' ? v.body : {}), reden: 'beleggen past' };   // wv3755: leest alleen
      const f = v.methode === 'POST' ? SCHRIJF[v.pad] : null;
      if (!f) return { status: 404, body: { ok: false, fout: 'onbekend' }, reden: 'beleggen onbekend' };
      const u = f(v.body && typeof v.body === 'object' ? v.body : {});
      if (u && u.status) return u;
      return { status: 200, body: Object.assign({ ok: true }, u && u.id != null ? { id: u.id } : {}, u && u.sleutel ? { sleutel: u.sleutel } : {}), reden: (u && u.reden) || 'beleggen' };
    } catch (e) {
      if (e instanceof Fout) return { status: e.status, body: { ok: false, fout: e.message }, reden: 'beleggen ' + e.status };
      throw e;
    }
  }
  // ── wv3755 (besluit nr 906 / L06, David Ja 21-11 13:18): "Past dit?" vóór een aankoop. Naam + bedrag (+ soort) → dezelfde berekening als het
  // scherm, één keer zonder en één keer mét dit bedrag erbij: de nieuwe verdeling en de lampjes, staat het op "koop ik niet", is de afkoeltijd
  // voorbij (vanaf de dag dat het op je volglijst kwam), en wat je er zelf over schreef (volglijst, dagboek). Een spiegel van je eigen plan:
  // geen advies, geen order; er wordt niets bewaard en niets verstuurd.
  const gelijkNaam = (a, b) => { const x = String(a || '').toLowerCase().trim(), y = String(b || '').toLowerCase().trim(); return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x)))); };
  function pastDit(b) {
    const naam = T(b.naam, 120);
    if (!naam) throw new Fout(400, 'naam ontbreekt');
    const cent = leesCent(b.bedrag, 'Bedrag');   // review MOET 1: in centen, niet afgerond op hele euro's
    if (cent == null) throw new Fout(400, 'bedrag ontbreekt');
    if (cent > 1000000000) throw new Fout(400, 'Bedrag: hooguit 10 miljoen');
    if (b.soort != null && b.soort !== '' && !SOORTEN.includes(b.soort)) throw new Fout(400, 'soort: kern, tech, health of leuk');
    return metDb((db) => {
      const d = metAankoop(leesAlles(db));
      const vandaag = vandaagF();
      const R = d.regels || {};
      const code = naam.toUpperCase();
      const pos = d.posities.find((p) => p.regelsoort === 'effect' && (gelijkNaam(p.naam, naam) || p.isin === code));
      const volg = d.volglijst.find((v) => gelijkNaam(v.naam, naam) || (v.code && String(v.code).toUpperCase() === code)) || null;
      const soort = b.soort || (pos && d.soorten[pos.sleutel]) || (volg && volg.thema) || null;
      const sl = pos ? pos.sleutel : 'past:nieuw';
      const naData = Object.assign({}, d, { soorten: Object.assign({}, d.soorten), keuzes: {},
        posities: pos ? d.posities.map((p) => (p === pos ? Object.assign({}, p, { waarde_eur_cent: p.waarde_eur_cent + cent }) : p))
          : d.posities.concat([{ sleutel: sl, regelsoort: 'effect', naam, isin: null, aantal: null, koers: null, valuta: 'EUR', lokaal_cent: null, waarde_eur_cent: cent, bron: 'hand' }]) });
      if (soort) naData.soorten[sl] = soort;
      const voor = bereken(Object.assign({}, d, { keuzes: {} }), vandaag), na = bereken(naData, vandaag);
      const punten = [];
      const p = (lamp, tekst) => punten.push({ lamp, tekst });
      // 1. lampjes van de verdeling en de maxima (de regels die een aankoop kan raken)
      const regels = [];
      for (const l of na.lampjes) {
        if (!['kern', 'eigen', 'leuk', 'max_aandeel', 'max_thema'].includes(l.sleutel)) continue;
        const v = voor.lampjes.find((x) => x.sleutel === l.sleutel) || null;
        regels.push({ sleutel: l.sleutel, naam: l.naam, grens: l.grens, voor: v ? { lamp: v.lamp, stand: v.stand } : null, na: { lamp: l.lamp, stand: l.stand }, uitleg: l.uitleg });
        if (l.lamp === 'oranje') p('oranje', l.naam + ': wordt ' + (l.stand || '–') + ' (je grens: ' + l.grens + ').');
      }
      const deze = na.posities.find((x) => x.sleutel === sl) || null;
      if (!soort) p('grijs', 'Kies een soort (kern, tech, health of voor de leuk); zonder soort kan de app je verdeling niet narekenen.');
      else if (!na.volledig) p('grijs', 'Je verdeling is nog niet helemaal na te rekenen: geef eerst al je posities een soort, of lees je portefeuille in.');
      else if (R.max_aandeel != null && soort !== 'kern' && deze && deze._maat <= R.max_aandeel + 1e-9 && na.volledig) p('groen', naam + ' wordt ' + pctTekst(deze._maat) + (na.opbouw && na.opbouw.actief ? ' van je doel' : ' van je beleggingen') + '; je maximum per aandeel is ' + pctTekst(R.max_aandeel) + '.');
      // 2. koop ik niet
      const koopNiet = Array.isArray(R.koop_niet) ? R.koop_niet.filter(Boolean) : [];
      const kn = koopNiet.find((k) => k.length >= 3 && (naam.toLowerCase().includes(k.toLowerCase()) || (k.length >= 4 && k.toLowerCase().includes(naam.toLowerCase()))));
      if (kn) p('oranje', 'Staat op je lijst "koop ik niet": lijkt op "' + kn + '" (vraag 10, bedrijven waar je zakelijk mee te maken hebt).');
      else if (koopNiet.length) p('groen', 'Staat niet op je lijst "koop ik niet".');
      else p('grijs', 'Je lijst "koop ik niet" is nog leeg (vraag 10).');
      // 3. afkoeltijd: vanaf de dag dat het idee op je volglijst kwam
      const afkoel = R.afkoel_dagen != null ? Number(R.afkoel_dagen) : null;
      let afkoelUit = null;
      if (afkoel == null) p('grijs', 'Je afkoeltijd is nog niet gezet (vraag 13).');
      else if (volg) {
        const vroegst = plusDagen(String(volg.op).slice(0, 10), afkoel);
        afkoelUit = { sinds: String(volg.op).slice(0, 10), vroegst, voorbij: vroegst <= vandaag };
        p(afkoelUit.voorbij ? 'groen' : 'oranje', afkoelUit.voorbij ? 'Je afkoeltijd van ' + afkoel + ' dagen is voorbij (op je volglijst sinds ' + afkoelUit.sinds + ').'
          : 'Je afkoeltijd van ' + afkoel + ' dagen loopt nog tot ' + vroegst + ' (op je volglijst sinds ' + afkoelUit.sinds + ').');
      } else if (pos) p('grijs', 'Je hebt ' + pos.naam + ' al; bijkopen staat niet op je volglijst, dus de app kent geen startdag voor je afkoeltijd.');
      else p('oranje', 'Niet op je volglijst: je afkoeltijd van ' + afkoel + ' dagen is nog niet begonnen. Zet je het er vandaag op, dan is het op zijn vroegst ' + plusDagen(vandaag, afkoel) + '.');
      // 4. wat je er zelf over schreef
      const schreef = [];
      if (volg && volg.waarom) schreef.push({ waar: 'volglijst', wat: 'Waarom', tekst: volg.waarom, datum: String(volg.op).slice(0, 10) });
      if (volg && volg.wanneer) schreef.push({ waar: 'volglijst', wat: 'Wanneer interessant', tekst: volg.wanneer, datum: String(volg.op).slice(0, 10) });
      const txSl = new Set(d.transacties.filter((t) => (pos && pos.isin && t.isin === pos.isin) || gelijkNaam(t.naam, naam)).map((t) => t.sleutel));
      for (const x of d.dagboek.filter((x) => txSl.has(x.transactie_sleutel) || gelijkNaam(x.naam, naam)).slice(0, 3)) {
        for (const [k, w] of [['waarom', 'Waarom'], ['blijven', 'Wat moet waar blijven'], ['verkoop_wanneer', 'Wanneer verkoop ik']]) if (x[k]) schreef.push({ waar: 'dagboek', wat: w, tekst: x[k], datum: x.datum });
      }
      // contant: wat er na dit bedrag over is (alleen als er contant bekend is)
      // review MOET 3: contant is bekend zodra er een contantregel is (ook € 0); zonder contantregel weet de app het niet
      const cash = voor.verdeling.cash_cent;
      const contant = voor.cash.length ? { voor_cent: cash, na_cent: cash - cent, genoeg: cash >= cent } : null;
      if (contant && !contant.genoeg) p('oranje', 'Meer dan je contant bij DEGIRO (' + euroCent(cash) + ').');
      const let_op = punten.filter((x) => x.lamp === 'oranje').length;
      // review MOET 2: "past" alleen als alles na te rekenen is: soort bekend, alle posities met soort, en minstens één grens voor verdeling of maxima
      const metGrens = regels.some((x) => x.na.lamp !== 'grijs');
      if (soort && na.volledig && !metGrens) p('grijs', 'Je plan heeft nog geen getal voor je verdeling of je maxima (vraag 7 en 8); daar kan de app dit nog niet aan toetsen.');
      return { ok: true, vandaag, naam, bedrag_cent: cent, soort, soort_bron: b.soort ? 'gekozen' : pos && d.soorten[pos.sleutel] ? 'positie' : volg && volg.thema ? 'volglijst' : null,
        bestaand: pos ? { sleutel: pos.sleutel, naam: pos.naam } : null, volglijst: volg ? { id: volg.id, naam: volg.naam } : null,
        oordeel: let_op ? 'let_op' : !soort || !na.volledig || !metGrens ? 'onvolledig' : 'past', let_op, punten, regels,
        verdeling: { voor: voor.verdeling, na: Object.assign({}, na.verdeling, contant ? { cash_cent: contant.na_cent } : {}) } /* review ronde 2 MOET 1: contant erna */, aandeel_na: deze ? rond(deze._ruw) : null, aandeel_maat_na: deze ? rond(deze._maat) : null,
        opbouw: na.opbouw, afkoel: afkoelUit, schreef, contant,
        zin: 'Een spiegel van je eigen plan, geen advies en geen order. Er is niets bewaard of verstuurd.' };
    }, false);
  }
  // wv3727 (David Ja 21-11, nr 160): het getal op de tegel Beleggen = open signalen + weekkaarten zonder keuze uit het weekbericht van de laatste
  // 8 dagen + herinneringen die vandaag terug zijn. Alleen aantallen; geen databank = 0.
  function teller() {
    const o = overzicht();
    const w = leesWeek();
    const vandaag = vandaagF();
    let week = 0;
    const nieuwste = w.weken[0];
    if (nieuwste && plusDagen(String(nieuwste.gemaakt_op).slice(0, 10), 8) >= vandaag) week = nieuwste.kaarten.filter((k) => !(w.keuzes[nieuwste.iso_week] || {})[k.bedrijf]).length;
    week += w.herinneringen.length;
    return { ok: true, signalen: o.signalen.length, week, totaal: o.signalen.length + week };
  }
  function info() {
    return metDb((db) => {
      if (!db) return { aan: true, databank: false };
      const n = (t) => db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n;
      return { aan: true, databank: true, posities: n('positie'), transacties: n('transactie'), rekening: n('rekening'), dagboek: n('dagboek'), volglijst: n('volglijst'),
        planversies: n('planversie'), vault_ok: vaultOk, schema: Number((db.prepare("SELECT waarde FROM meta WHERE sleutel = 'schema'").get() || {}).waarde) || null,
        nieuws: { bedrijven: n('bedrijf'), regels: n('nieuws'), weken: n('week'), bronnen_gezakt: db.prepare('SELECT COUNT(*) AS n FROM nieuws_bron WHERE gezakt = 1').get().n },
        koersen: { regels: n('koers'), wissels: n('wissel'), codes: n('koerscode'), uit: n('bedrijf_uit'),
          laatste: (db.prepare('SELECT MAX(datum) AS d FROM koers').get() || {}).d || null },   // wv3728: alleen aantallen en een datum
        peil: { aantal: n('peil'), laatste: (db.prepare('SELECT MAX(peildatum) AS d FROM peil').get() || {}).d || null } };   // wv3757
    }, false);
  }
  // ── wv3757 (nr 910 / L10): waarde op een datum (Financiën › Vermogen) en de peilwaarde op 1 januari (alleen lezen, behalve de peil-rij) ──
  function opDatum(db, datum) {
    const d = leesAlles(db);
    d.rekening_datums = db.prepare('SELECT DISTINCT datum FROM rekening').all().map((r) => r.datum);   // review MOET 1: mutaties na de portefeuille
    const kq = db.prepare('SELECT datum, slot, valuta FROM koers WHERE isin = ? AND datum <= ? ORDER BY datum DESC LIMIT 1');
    const wq = db.prepare('SELECT datum, per_eur FROM wissel WHERE valuta = ? AND datum <= ? ORDER BY datum DESC LIMIT 1');
    const kAt = (i, x) => kq.get(i, x) || null, wAt = (v, x) => wq.get(v, x) || null;
    return { d, kAt, wAt, w: waardeOp(d, kAt, wAt, datum) };
  }
  function waardeOpDatum(datum) {
    if (!RE_DAG.test(String(datum))) throw new Error('datum als jjjj-mm-dd');
    if (!fs.existsSync(dbPad)) return null;
    return metDb((db) => (db ? opDatum(db, datum).w : null), false);
  }
  const PEIL_VELDEN = 'peildatum, waarde_cent, effecten_cent, cash_cent, volledig, markering, bron, op';
  function peilRij(r) {
    let m = []; try { m = JSON.parse(r.markering); } catch (e) { m = []; }
    return { peildatum: r.peildatum, waarde_cent: r.waarde_cent, effecten_cent: r.effecten_cent, cash_cent: r.cash_cent, volledig: r.volledig === 1, markering: m, bron: r.bron, op: r.op };
  }
  // Eén keer vastleggen, nooit overschrijven. bron: 'januari' (de stap in de ochtendtik) of 'proef'. Dividend en kosten van het jaar vóór de peildatum.
  function peilVastleggen(peildatum, bron) {
    if (!RE_DAG.test(String(peildatum))) throw new Error('peildatum als jjjj-mm-dd');
    return metDb((db) => {
      const al = db.prepare('SELECT ' + PEIL_VELDEN + ' FROM peil WHERE peildatum = ?').get(peildatum);
      if (al) return { nieuw: false, peil: peilRij(al) };
      const x = opDatum(db, peildatum);
      const rek = db.prepare('SELECT datum, omschrijving, mutatie_cent, mutatie_valuta FROM rekening').all();
      const geld = jaarGeld(rek, x.d.transacties, Number(peildatum.slice(0, 4)) - 1, x.wAt);
      const inhoud = { waarde: x.w, jaar: geld, transacties_tot: x.d.transacties.reduce((m, t) => (t.datum > m ? t.datum : m), '') || null,
        uitleg: 'Waarde bij DEGIRO op ' + peildatum + ': aantal × de laatst bekende slotkoers vóór of op die dag, in euro met de ECB-wisselkoers van de koersdatum. ' +
          'Dividend en kosten van ' + geld.jaar + ' uit je eigen exports. Eigen registratie; laat de aangifte door je adviseur toetsen.' };
      const r = db.prepare('INSERT INTO peil (peildatum, waarde_cent, effecten_cent, cash_cent, volledig, markering, inhoud, bron, op) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(peildatum) DO NOTHING')
        .run(peildatum, x.w.waarde_cent, x.w.effecten_cent, x.w.cash_cent, x.w.volledig ? 1 : 0, JSON.stringify(x.w.markering), JSON.stringify(inhoud), String(bron || 'januari').slice(0, 20), nuIso());
      return { nieuw: r.changes === 1, peil: peilRij(db.prepare('SELECT ' + PEIL_VELDEN + ' FROM peil WHERE peildatum = ?').get(peildatum)) };
    }, true);
  }
  function peilen(db) { return db ? db.prepare('SELECT ' + PEIL_VELDEN + ' FROM peil ORDER BY peildatum DESC LIMIT 20').all().map(peilRij) : []; }
  function peilInhoud(peildatum) {
    if (!fs.existsSync(dbPad)) return null;
    return metDb((db) => { const r = db && db.prepare('SELECT inhoud FROM peil WHERE peildatum = ?').get(String(peildatum)); return r ? JSON.parse(r.inhoud) : null; }, false);
  }
  // De stap in de ochtendtik (server.js, na de koersronde): van 1 t/m 15 januari, zolang de peilwaarde van dit jaar er nog niet is (een pod die op
  // 1 januari uit stond, haalt hem in; de koers blijft die van vóór of op 1 januari). Zonder databank niets (geen lege databank maken).
  function peilTik(vandaag) {
    const v = vandaag || vandaagF(), pd = v.slice(0, 4) + '-01-01';
    if (v > v.slice(0, 4) + '-01-15' || !fs.existsSync(dbPad)) return { niets: true };
    if (metDb((db) => !!(db && db.prepare('SELECT 1 FROM peil WHERE peildatum = ?').get(pd)), false)) return { al: true };
    return peilVastleggen(pd, 'januari');
  }
  // Voor Financiën (bank-lezer via server.js): de waarde van vandaag, per maandeinde sinds de eerste transactie of stand, en de peilwaarden. Euro's.
  function voorFinancien(o) {
    const vandaag = (o && o.vandaag) || vandaagF();
    if (!fs.existsSync(dbPad)) return null;
    return metDb((db) => {
      if (!db) return null;
      const e = (c) => (c == null ? null : Math.round(c) / 100);
      const nu = opDatum(db, vandaag), w = nu.w;
      const volgende = (Number(vandaag.slice(0, 4)) + 1) + '-01-01';
      // review ZOU 1 (ronde 2): dividend en kosten van het jaar vóór de peildatum telkens opnieuw uit de exports van nu (een later ingelezen
      // rekeningoverzicht telt dan mee); de waarde op de peildatum blijft de bevroren rij. rekening_tot zegt tot wanneer het overzicht loopt.
      const rek = db.prepare('SELECT datum, omschrijving, mutatie_cent, mutatie_valuta FROM rekening').all();
      const jaarVan = (pd) => { const j = jaarGeld(rek, nu.d.transacties, Number(pd.slice(0, 4)) - 1, nu.wAt);
        return { jaar: j.jaar, dividend: e(j.dividend_cent), dividendbelasting: e(j.dividendbelasting_cent), kosten: e(j.kosten_transacties_cent + j.kosten_overig_cent), zonder_wissel: j.zonder_wissel, rekening_tot: j.rekening_tot }; };
      const uit = { vandaag, peilen: peilen(db).map((p) => ({ peildatum: p.peildatum, bedrag: e(p.waarde_cent), effecten: e(p.effecten_cent), cash: e(p.cash_cent), volledig: p.volledig, markering: p.markering, op: p.op, jaar: jaarVan(p.peildatum) })),
        volgende_peil: volgende, punt: null, maanden: {} };
      const eerste = [nu.d.stand_datum].concat(nu.d.transacties.map((t) => t.datum)).filter(Boolean).sort()[0] || null;
      if (!eerste) return uit;
      uit.eerste = eerste;
      uit.punt = { bedrag: e(w.waarde_cent), effecten: e(w.effecten_cent), cash: e(w.cash_cent), cash_datum: w.cash_datum, koers_datum: w.koers_datum, volledig: w.volledig,
        posities: w.posities.length, zonder_koers: w.zonder.length, markering: w.markering.slice(0, 20), aantal_bron: w.aantal_bron };
      for (let m = eerste.slice(0, 7); m < vandaag.slice(0, 7); ) {
        const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
        const x = waardeOp(nu.d, nu.kAt, nu.wAt, d);
        uit.maanden[m] = { bedrag: x.posities.length || x.cash_cent != null ? e(x.waarde_cent) : (x.zonder.length ? null : 0), volledig: x.volledig, gemarkeerd: x.markering.length > 0 };
        const n = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString().slice(0, 7); m = n;
      }
      return uit;
    }, false);
  }
  return { app, gesprek, info, _overzicht: overzicht, nieuwsData, koersData, zetKoersen, zetAutoBedrijven, vulBedrijfAan, metDb, vandaag: vandaagF, waardeOpDatum, peilVastleggen, peilTik, peilInhoud, voorFinancien };
}

module.exports = { maak, leesBestand, bereken, zoekVorm, pastNaam, aankoopStand, waardeVandaag, aankoopPer, daglijn, geldOverzicht, WERELD, waardeOp, jaarGeld, regelsUit, VRAGEN, LeesFout, ANTHROPIC_ZIN, plusMaanden };
