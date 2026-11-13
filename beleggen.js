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

const SCHEMA_VERSIE = 2;
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

// ── de veertien vragen (plan § 1.7); velden = wat de app narekent ──
const VRAGEN = [
  { nr: 1, vraag: 'Waarvoor is dit geld, en wanneer wil je het op zijn vroegst kunnen gebruiken?' },
  { nr: 2, vraag: 'Beleg je privé, vanuit de Holding, of beide?', hint: 'Leg dit ook aan je accountant voor.' },
  { nr: 3, vraag: 'Welk bedrag blijft buiten de beleggingen als buffer, en zijn er leningen die je liever eerst aflost?' },
  { nr: 4, vraag: 'Leg je één keer in, elke maand een vast bedrag, of allebei?' },
  { nr: 5, vraag: 'Stap je in één keer in of gespreid, en over hoeveel maanden?' },
  { nr: 6, vraag: 'Stel dat alles in een jaar halveert: wat doe je dan? Bijkopen, niets, of verkopen. En bij welk verlies in euro\'s lig je wakker?' },
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
// Bedrag met valuta in twee kolommen: precies één van de twee is een valutacode, de ander het getal (de volgorde verschilt per export).
function leesBedrag(rij, k, dec, regel, naam, leegMag, vasteValuta) {
  const a = (rij[k.i] || '').trim(), b = k.partner == null ? '' : (rij[k.partner] || '').trim();
  if (k.partner == null) {
    const g = leesGetal(a, dec, regel, naam, leegMag);
    return g ? { g, cent: naarCent(g), valuta: vasteValuta || null } : null;
  }
  if (!a && !b) { if (leegMag) return null; throw new LeesFout('leeg bedrag', regel, naam); }
  let valuta, getal;
  if (RE_VALUTA.test(a) && !RE_VALUTA.test(b)) { valuta = a; getal = b; } else if (RE_VALUTA.test(b) && !RE_VALUTA.test(a)) { valuta = b; getal = a; }
  else throw new LeesFout('bedrag zonder herkenbare valuta', regel, naam);
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
  if (soort === 'transacties') {
    const telling = {};
    for (const { rij, regel } of data) {
      const datum = leesDatum(veld(rij, kaart.datum), regel, 'datum'), tijd = leesTijd(veld(rij, kaart.tijd), regel, 'tijd');
      const naam = veld(rij, kaart.product), isin = veld(rij, kaart.isin);
      if (!naam) throw new LeesFout('product ontbreekt', regel, 'product');
      if (!RE_ISIN.test(isin)) throw new LeesFout('geen geldige ISIN', regel, 'isin');
      const aantal = leesGetal(veld(rij, kaart.aantal), dec, regel, 'aantal');
      if (aantal.n === 0) throw new LeesFout('aantal is nul', regel, 'aantal');
      const koers = leesBedrag(rij, kaart.koers, dec, regel, 'koers', false);
      const lokaal = leesBedrag(rij, kaart.lokaal, dec, regel, 'lokale waarde', false);
      const waarde = leesBedrag(rij, kaart.waarde, dec, regel, 'waarde', false, 'EUR');
      const wk = kaart.wisselkoers ? leesGetal(veld(rij, kaart.wisselkoers), dec, regel, 'wisselkoers', true) : null;
      const kosten = kaart.kosten ? leesBedrag(rij, kaart.kosten, dec, regel, 'kosten', true, 'EUR') : null;
      const autofx = kaart.autofx ? leesBedrag(rij, kaart.autofx, dec, regel, 'autofx', true, 'EUR') : null;
      const totaal = leesBedrag(rij, kaart.totaal, dec, regel, 'totaal', false, 'EUR');
      if (waarde.valuta && waarde.valuta !== 'EUR') throw new LeesFout('waarde niet in euro', regel, 'waarde');
      if (totaal.valuta && totaal.valuta !== 'EUR') throw new LeesFout('totaal niet in euro', regel, 'totaal');
      if (koers.valuta && lokaal.valuta && koers.valuta !== lokaal.valuta) throw new LeesFout('koers en lokale waarde in verschillende valuta', regel, 'koers');
      const valuta = lokaal.valuta || koers.valuta;
      if (!valuta) throw new LeesFout('valuta ontbreekt', regel, 'lokale waarde');
      // optellen; tekens (review achteraf MOET 1): koers > 0, erbij (aantal > 0) = geld eruit (lokale waarde en waarde < 0), eraf = geld erin
      if (!(koers.g.n > 0)) throw new LeesFout('koers moet groter dan nul zijn', regel, 'koers');
      if (Math.abs(Math.abs(aantal.n * koers.g.n) - Math.abs(lokaal.g.n)) > tol(lokaal.g.n)) throw new LeesFout('aantal × koers is niet de lokale waarde', regel, 'lokale waarde');
      if (lokaal.g.n === 0 || Math.sign(lokaal.g.n) !== -Math.sign(aantal.n)) throw new LeesFout('teken van de lokale waarde past niet bij het aantal (erbij = negatief, eraf = positief)', regel, 'lokale waarde');
      if (waarde.g.n === 0 || Math.sign(waarde.g.n) !== Math.sign(lokaal.g.n)) throw new LeesFout('lokale waarde en waarde hebben een ander teken', regel, 'waarde');
      if (kosten && kosten.g.n > 0) throw new LeesFout('kosten horen negatief te zijn', regel, 'kosten');
      if (autofx && autofx.g.n > 0) throw new LeesFout('AutoFX-kosten horen negatief te zijn', regel, 'autofx');
      if (valuta === 'EUR') { if (Math.abs(lokaal.g.n - waarde.g.n) > tol(waarde.g.n)) throw new LeesFout('waarde in euro wijkt af van de lokale waarde', regel, 'waarde'); }
      else {
        if (!wk || !(wk.n > 0)) throw new LeesFout('wisselkoers ontbreekt bij een bedrag in ' + valuta, regel, 'wisselkoers');
        const a = Math.abs(lokaal.g.n) / wk.n, b = Math.abs(lokaal.g.n) * wk.n, w = Math.abs(waarde.g.n);
        if (Math.abs(a - w) > tol(w) * 2 && Math.abs(b - w) > tol(w) * 2) throw new LeesFout('lokale waarde en wisselkoers geven niet de waarde in euro', regel, 'wisselkoers');
      }
      const som = waarde.g.n + (kosten ? kosten.g.n : 0) + (autofx ? autofx.g.n : 0);
      if (Math.abs(som - totaal.g.n) > 0.011) throw new LeesFout('totaal is niet waarde + kosten', regel, 'totaal');
      let order = veld(rij, kaart.order);
      if (!order && kaart.order && kaart.order.partner != null) order = String(rij[kaart.order.partner] || '').trim();
      if (!order && kaart.order) { const laatste = String(rij[kop.length] || rij[kop.length - 1] || '').trim(); if (/^[0-9a-f-]{8,}$/i.test(laatste)) order = laatste; }
      const basis = [datum, tijd, isin, canon(aantal.tekst), canon(koers.g.tekst), lokaal.cent, order].join('|');
      telling[basis] = (telling[basis] || 0) + 1;
      uit.push({ sleutel: 'tx:' + sha(basis + '#' + telling[basis]).slice(0, 32), datum, tijd, naam, isin, beurs: veld(rij, kaart.beurs) || null,
        aantal: aantal.tekst, koers: koers.g.tekst, valuta, lokaal_cent: lokaal.cent, waarde_eur_cent: waarde.cent, wisselkoers: wk ? wk.tekst : null,
        kosten_eur_cent: (kosten ? kosten.cent : 0) + (autofx ? autofx.cent : 0), totaal_eur_cent: totaal.cent, order_id: order || null, regel });
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
    for (const { rij, regel } of data) {
      const datum = leesDatum(veld(rij, kaart.datum), regel, 'datum'), tijd = leesTijd(veld(rij, kaart.tijd), regel, 'tijd');
      const valutadatum = leesDatum(veld(rij, kaart.valutadatum), regel, 'valutadatum', true);
      const isin = veld(rij, kaart.isin);
      if (isin && !RE_ISIN.test(isin)) throw new LeesFout('geen geldige ISIN', regel, 'isin');
      const omschrijving = veld(rij, kaart.omschrijving);
      if (!omschrijving) throw new LeesFout('omschrijving ontbreekt', regel, 'omschrijving');
      if (kaart.fx) leesGetal(veld(rij, kaart.fx), dec, regel, 'fx', true);
      const mutatie = leesBedrag(rij, kaart.mutatie, dec, regel, 'mutatie', true);
      const saldo = leesBedrag(rij, kaart.saldo, dec, regel, 'saldo', true);
      if (!!mutatie !== !!saldo) throw new LeesFout(mutatie ? 'mutatie zonder saldo' : 'saldo zonder mutatie', regel, mutatie ? 'saldo' : 'mutatie');   // review achteraf MOET 4
      if (mutatie && saldo && mutatie.valuta !== saldo.valuta) throw new LeesFout('mutatie en saldo in verschillende valuta', regel, 'saldo');
      let order = veld(rij, kaart.order);
      if (!order && kaart.order && kaart.order.partner != null) order = String(rij[kaart.order.partner] || '').trim();
      const basis = [datum, tijd, isin, omschrijving, mutatie ? mutatie.valuta + mutatie.cent : '', saldo ? saldo.valuta + saldo.cent : '', order].join('|');
      telling[basis] = (telling[basis] || 0) + 1;
      const r = { sleutel: 'rk:' + sha(basis + '#' + telling[basis]).slice(0, 32), datum, tijd, valutadatum, naam: veld(rij, kaart.product) || null, isin: isin || null,
        omschrijving, mutatie_cent: mutatie ? mutatie.cent : null, mutatie_valuta: mutatie ? mutatie.valuta : null, saldo_cent: saldo ? saldo.cent : null,
        saldo_valuta: saldo ? saldo.valuta : null, order_id: order || null, regel };
      uit.push(r);
      if (mutatie && saldo) (perValuta[saldo.valuta] = perValuta[saldo.valuta] || []).push(r);
    }
    // MOET 1 (review vooraf): per valuta moet het saldo doorlopen, in één volgorde over het hele bestand (DEGIRO: nieuw → oud).
    for (const [val, rs] of Object.entries(perValuta)) {
      if (rs.length < 2) continue;
      let nieuwOud = true, oudNieuw = true, eerstFout = null;
      for (let i = 0; i + 1 < rs.length; i++) {
        if (rs[i + 1].saldo_cent + rs[i].mutatie_cent !== rs[i].saldo_cent) { if (nieuwOud && !eerstFout) eerstFout = rs[i]; nieuwOud = false; }
        if (rs[i].saldo_cent + rs[i + 1].mutatie_cent !== rs[i + 1].saldo_cent) oudNieuw = false;
      }
      if (!nieuwOud && !oudNieuw) throw new LeesFout('het saldo in ' + val + ' loopt niet door (saldo + mutatie klopt niet met de volgende regel)', (eerstFout || rs[0]).regel, 'saldo');
    }
  }
  return { soort, rijen: uit, decimaal: dec, scheiding: sep };
}

// ── rekenwerk ──
const pct = (a, b) => (b > 0 ? (a / b) * 100 : null);
const rond = (x) => (x == null ? null : Math.round(x * 10) / 10);
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
  const posities = effecten.map((p) => {
    const soort = data.soorten[p.sleutel] || null;
    groep[soort || 'zonder'] += p.waarde_eur_cent;
    return Object.assign({}, p, { soort, aandeel: rond(pct(p.waarde_eur_cent, belegd)), _ruw: pct(p.waarde_eur_cent, belegd) });
  }).sort((a, b) => b.waarde_eur_cent - a.waarde_eur_cent);
  const g = (k) => pct(groep[k], belegd);
  const ruw = { kern: g('kern'), tech: g('tech'), health: g('health'), eigen: pct(groep.tech + groep.health, belegd), leuk: g('leuk') };   // review achteraf ZOU 1
  const verdeling = { belegd_cent: belegd, cash_cent: cash.reduce((s, p) => s + p.waarde_eur_cent, 0), kern: rond(g('kern')), tech: rond(g('tech')), health: rond(g('health')),
    eigen: rond(pct(groep.tech + groep.health, belegd)), leuk: rond(g('leuk')), zonder: rond(g('zonder')), zonder_aantal: posities.filter((p) => !p.soort).length };
  const heeftStand = belegd > 0;
  const volledig = heeftStand && verdeling.zonder_aantal === 0;
  const lampjes = [];
  const lamp = (sleutel, naam, grens, stand, binnen, uitleg) => lampjes.push({ sleutel, naam, grens, stand,
    lamp: binnen === null ? 'grijs' : binnen ? 'groen' : 'oranje', uitleg });
  const band = (sleutel, naam, min, max, waarde) => {
    if (min == null && max == null) return lamp(sleutel, naam, 'nog niet gezet', pctTekst(waarde), null, 'Vraag 7 in je plan.');
    const grens = (min != null ? pctTekst(min) : '0 %') + ' – ' + (max != null ? pctTekst(max) : '100 %');
    if (!volledig) return lamp(sleutel, naam, grens, pctTekst(waarde), null, heeftStand ? 'Eerst bij elke positie de soort kiezen.' : 'Nog geen stand.');
    const r = ruw[sleutel];
    const b = (min == null || r >= min - 1e-9) && (max == null || r <= max + 1e-9);
    lamp(sleutel, naam, grens, pctTekst(waarde), b, b ? 'Binnen je bandbreedte.' : 'Buiten je bandbreedte.');
    return b;
  };
  const kernOk = band('kern', 'Kern (indexfondsen)', R.kern_min, R.kern_max, verdeling.kern);
  const eigenOk = band('eigen', 'Eigen keuzes (tech + health)', R.eigen_min, R.eigen_max, verdeling.eigen);
  const leukOk = R.leuk_max == null ? lamp('leuk', 'Voor de leuk', 'nog niet gezet', pctTekst(verdeling.leuk), null, 'Vraag 7 in je plan.')
    : band('leuk', 'Voor de leuk', null, R.leuk_max, verdeling.leuk);
  const signalen = [];
  const sig = (s) => signalen.push(Object.assign({ keuzes: ['niets', 'dagboek', 'herinner'] }, s));
  const standDatum = data.stand_datum || 'geen';
  const grootste = posities.filter((p) => p.soort && p.soort !== 'kern');
  if (R.max_aandeel == null) lamp('max_aandeel', 'Eén aandeel hoogstens', 'nog niet gezet', null, null, 'Vraag 8 in je plan.');
  else {
    const boven = heeftStand ? grootste.filter((p) => p._ruw > R.max_aandeel + 1e-9) : [];
    lamp('max_aandeel', 'Eén aandeel hoogstens', pctTekst(R.max_aandeel), grootste.length ? pctTekst(Math.max(...grootste.map((p) => p.aandeel))) : '–',
      boven.length ? false : volledig ? true : null, boven.length ? boven.length + ' boven je maximum' : volledig ? 'Geen aandeel boven je maximum (kern telt niet mee).' : heeftStand ? 'Eerst bij elke positie de soort kiezen.' : 'Nog geen stand.');
    for (const p of boven) sig({ sleutel: 'max-aandeel:' + p.sleutel + ':' + standDatum + ':' + R.max_aandeel, soort: 'boven_maximum', titel: p.naam + ' zit boven je maximum per aandeel',
      wat: 'Volgens je stand van ' + standDatum + ' is ' + p.naam + ' ' + pctTekst(p.aandeel) + ' van je beleggingen.', raakt: p.naam + ' (' + SOORT_NAAM[p.soort] + ', ' + pctTekst(p.aandeel) + ' van het geheel)',
      positie: p.sleutel, plan: 'Je maximum voor één aandeel is ' + pctTekst(R.max_aandeel) + '.' });
  }
  if (R.max_thema == null) lamp('max_thema', 'Eén thema hoogstens', 'nog niet gezet', null, null, 'Vraag 8 in je plan.');
  else {
    const b = [];
    for (const t of ['tech', 'health']) if (heeftStand && ruw[t] > R.max_thema + 1e-9) b.push(t);
    lamp('max_thema', 'Eén thema hoogstens', pctTekst(R.max_thema), 'tech ' + pctTekst(verdeling.tech) + ' · health ' + pctTekst(verdeling.health), b.length ? false : volledig ? true : null,
      b.length ? b.map((t) => SOORT_NAAM[t]).join(' en ') + ' boven je maximum' : volledig ? 'Beide thema\'s binnen je maximum.' : heeftStand ? 'Eerst bij elke positie de soort kiezen.' : 'Nog geen stand.');
    for (const t of b) sig({ sleutel: 'max-thema:' + t + ':' + standDatum + ':' + R.max_thema, soort: 'boven_maximum', titel: SOORT_NAAM[t] + ' zit boven je maximum per thema',
      wat: 'Volgens je stand van ' + standDatum + ' is ' + SOORT_NAAM[t] + ' samen ' + pctTekst(verdeling[t]) + ' van je beleggingen.', raakt: 'thema ' + SOORT_NAAM[t], plan: 'Je maximum per thema is ' + pctTekst(R.max_thema) + '.' });
  }
  if (R.leuk_max != null && leukOk === false) sig({ sleutel: 'leuk:' + standDatum + ':' + R.leuk_max, soort: 'potje', titel: 'Voor de leuk zit boven je plafond',
    wat: 'Volgens je stand van ' + standDatum + ' is "voor de leuk" ' + pctTekst(verdeling.leuk) + ' van je beleggingen.', raakt: 'potje voor de leuk', plan: 'Je plafond is ' + pctTekst(R.leuk_max) + '.' });
  // herbalanceren
  const maand = Number(vandaag.slice(5, 7));
  if (!R.herbalans_wijze) lamp('herbalans', 'Herbalanceren', 'nog niet gezet', null, null, 'Vraag 14 in je plan.');
  else if (R.herbalans_wijze === 'momenten') {
    const ms = Array.isArray(R.herbalans_maanden) ? R.herbalans_maanden : [];
    const nu = ms.includes(maand);
    lamp('herbalans', 'Herbalanceren', ms.length ? 'in maand ' + ms.join(', ') : 'maanden nog niet gezet', nu ? 'deze maand' : '–', ms.length ? !nu : null, nu ? 'Het is een herbalansmaand.' : 'Geen herbalansmaand.');
    if (nu) sig({ sleutel: 'herbalans:' + vandaag.slice(0, 7), soort: 'herbalans', titel: 'Herbalansmoment', wat: 'Deze maand staat in je plan als herbalansmoment.',
      raakt: 'de verdeling (kern ' + pctTekst(verdeling.kern) + ', eigen keuzes ' + pctTekst(verdeling.eigen) + ', voor de leuk ' + pctTekst(verdeling.leuk) + ')',
      plan: 'Je herbalanceert in maand ' + ms.join(', ') + '; bij voorkeur met nieuwe inleg.' });
  } else {
    const af = kernOk === false || eigenOk === false;
    lamp('herbalans', 'Herbalanceren', 'als een deel buiten zijn bandbreedte komt', af ? 'buiten' : 'binnen', volledig ? !af : null, af ? 'Een deel staat buiten zijn bandbreedte.' : 'Alles binnen.');
    if (af) sig({ sleutel: 'herbalans:afwijking:' + standDatum, soort: 'herbalans', titel: 'Tijd om te herbalanceren', wat: 'Een deel van je verdeling staat buiten zijn bandbreedte.',
      raakt: 'kern ' + pctTekst(verdeling.kern) + ', eigen keuzes ' + pctTekst(verdeling.eigen), plan: 'Je herbalanceert als een deel buiten zijn bandbreedte komt.' });
  }
  if (R.afkoel_dagen == null) lamp('afkoel', 'Afkoeltijd', 'nog niet gezet', null, null, 'Vraag 13 in je plan.');
  else lamp('afkoel', 'Afkoeltijd', R.afkoel_dagen + ' dagen', null, true, 'Een herinnering na een signaal komt na zoveel dagen terug.');
  // koop ik niet
  const koopNiet = Array.isArray(R.koop_niet) ? R.koop_niet.filter(Boolean) : [];
  const raakNiet = (naam) => koopNiet.find((k) => k.length >= 3 && String(naam || '').toLowerCase().includes(k.toLowerCase()));
  const treffers = [];
  for (const p of posities) { const k = raakNiet(p.naam); if (k) treffers.push({ wat: p.naam, k, s: 'positie:' + p.sleutel }); }
  for (const v of data.volglijst) { const k = raakNiet(v.naam); if (k) treffers.push({ wat: v.naam, k, s: 'volg:' + v.id }); }
  if (!koopNiet.length) lamp('koop_niet', 'Koop ik niet', 'nog niet gezet', null, null, 'Vraag 10 in je plan.');
  else lamp('koop_niet', 'Koop ik niet', koopNiet.length + (koopNiet.length === 1 ? ' bedrijf' : ' bedrijven'), treffers.length ? treffers.length + ' treffer' : 'geen treffer', !treffers.length,
    treffers.length ? 'Iets in je stand of volglijst staat op je lijst.' : 'Niets in je stand of volglijst staat op je lijst.');
  for (const t of treffers) sig({ sleutel: 'koop-niet:' + t.s, soort: 'koop_niet', titel: t.wat + ' staat op je lijst "koop ik niet"', wat: t.wat + ' lijkt op "' + t.k + '" uit je lijst.',
    raakt: t.s.startsWith('volg:') ? 'je volglijst' : 'je stand', plan: 'Vraag 10: bedrijven waar je zakelijk mee te maken hebt.' });
  // dagboek: transactie zonder regel, terugblik
  const metRegel = new Set(data.dagboek.filter((d) => d.transactie_sleutel && (d.waarom || d.blijven || d.verkoop_wanneer)).map((d) => d.transactie_sleutel));
  for (const t of data.transacties) if (!metRegel.has(t.sleutel)) sig({ sleutel: 'dagboek:' + t.sleutel, soort: 'dagboek', titel: 'Transactie zonder dagboekregel: ' + t.naam,
    wat: 'Op ' + t.datum + ' ' + (Number(t.aantal) > 0 ? 'kwam er ' : 'ging er ') + String(Math.abs(Number(t.aantal))).replace('.', ',') + ' ' + t.naam + (Number(t.aantal) > 0 ? ' bij.' : ' af.'),
    raakt: t.naam, transactie: t.sleutel, plan: 'Na een transactie schrijf je één keer waarom, wat waar moet blijven en wanneer je zou verkopen.', keuzes: ['dagboek', 'niets'] });
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
  // Davids keuze bij een signaal
  const zichtbaar = signalen.filter((s) => { const k = data.keuzes[s.sleutel]; if (!k) return true; if (k.keuze === 'niets') return false; return !(k.tot && k.tot > vandaag); });
  // open punten
  const open = [];
  for (const v of VRAGEN) { const a = data.antwoorden[v.nr]; if (!a || a.status === 'overgeslagen') open.push({ soort: 'vraag', vraag: v.nr, tekst: 'Vraag ' + v.nr + (a ? ' overgeslagen' : ' nog niet beantwoord') }); }
  for (const p of posities) if (!p.soort) open.push({ soort: 'positie', sleutel: p.sleutel, tekst: p.naam + ': kies kern, tech, health of voor de leuk' });
  for (const t of data.transacties) if (!metRegel.has(t.sleutel)) open.push({ soort: 'dagboek', transactie: t.sleutel, tekst: t.naam + ' (' + t.datum + '): nog geen dagboekregel' });
  const anthropic = posities.some((p) => ANTHROPIC_RE.test(p.naam)) || data.volglijst.some((v) => ANTHROPIC_RE.test(v.naam + ' ' + (v.code || '')));
  return { verdeling, posities, cash, lampjes, signalen: zichtbaar, signalen_verborgen: signalen.length - zichtbaar.length, open_punten: open,
    belang: anthropic ? ANTHROPIC_ZIN : null, volledig, woorden };
}

// ── plan: waarden controleren en regels afleiden ──
function leesPct(x, naam) {
  if (x === null || x === undefined || x === '') return null;
  const t = String(x).trim().replace(',', '.').replace(/\s*%$/, '');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t) || Number(t) > 100) throw new Fout(400, naam + ': een percentage tussen 0 en 100');
  return Number(t);
}
function regelsUit(vraag, waarden) {
  const v = VRAGEN.find((x) => x.nr === vraag);
  const uit = {};
  for (const f of v.velden || []) {
    const w = waarden ? waarden[f.sleutel] : undefined;
    if (f.soort === 'pct') uit[f.sleutel] = leesPct(w, f.label);
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
    const leeg = { antwoorden: {}, regels: {}, versies: [], posities: [], soorten: {}, transacties: [], dagboek: [], volglijst: [], keuzes: {}, bestanden: [], stand_datum: null, stand_bron: null, rekening_rijen: 0 };
    if (!db) return leeg;
    const d = leeg;
    for (const r of db.prepare('SELECT * FROM plan_antwoord').all()) d.antwoorden[r.vraag] = { tekst: r.tekst, waarden: r.waarden ? JSON.parse(r.waarden) : null, status: r.status, op: r.op };
    for (const r of db.prepare('SELECT sleutel, waarde FROM regel').all()) d.regels[r.sleutel] = JSON.parse(r.waarde);
    d.versies = db.prepare('SELECT versie, op, wat FROM planversie ORDER BY versie DESC LIMIT 20').all().map((r) => Object.assign({}, r));
    d.posities = db.prepare('SELECT sleutel, regelsoort, naam, isin, aantal, koers, valuta, lokaal_cent, waarde_eur_cent, bron FROM positie').all().map((r) => Object.assign({}, r));
    for (const r of db.prepare('SELECT sleutel, soort FROM positie_soort').all()) d.soorten[r.sleutel] = r.soort;
    d.transacties = db.prepare('SELECT sleutel, datum, tijd, naam, isin, aantal, koers, valuta, waarde_eur_cent, kosten_eur_cent, bron FROM transactie ORDER BY datum DESC, tijd DESC').all().map((r) => Object.assign({}, r));
    d.dagboek = db.prepare('SELECT * FROM dagboek ORDER BY datum DESC, id DESC').all().map((r) => Object.assign({}, r));
    d.volglijst = db.prepare('SELECT id, naam, code, thema, waarom, wanneer, op FROM volglijst WHERE weg = 0 ORDER BY id').all().map((r) => Object.assign({}, r));
    for (const r of db.prepare('SELECT sleutel, keuze, tot FROM signaal_keuze').all()) d.keuzes[r.sleutel] = { keuze: r.keuze, tot: r.tot };
    d.bestanden = db.prepare('SELECT id, soort, naam, datum_bestand, op, rijen, nieuw FROM bestand ORDER BY id DESC LIMIT 10').all().map((r) => Object.assign({}, r));
    const m = Object.fromEntries(db.prepare("SELECT sleutel, waarde FROM meta WHERE sleutel IN ('stand_datum', 'stand_bron')").all().map((r) => [r.sleutel, r.waarde]));
    d.stand_datum = m.stand_datum || null; d.stand_bron = m.stand_bron || null;
    d.rekening_rijen = db.prepare('SELECT COUNT(*) AS n FROM rekening').get().n;
    return d;
  }
  function overzicht() {
    return metDb((db) => {
      const d = leesAlles(db);
      const vandaag = vandaagF();
      const k = bereken(d, vandaag);
      const volg = d.volglijst.map((v) => Object.assign({}, v, { vroegst: d.regels.afkoel_dagen != null ? plusDagen(v.op.slice(0, 10), d.regels.afkoel_dagen) : null }));
      const dagboek = d.dagboek.map((x) => Object.assign({}, x, { terugblik6_op: plusMaanden(x.datum, 6), terugblik12_op: plusMaanden(x.datum, 12) }));
      const bedrijven = bedrijvenUit(db, d, k).map((b) => ({ sleutel: b.sleutel, naam: b.naam, bron: b.bron, kaartje: b.kaartje, voorstel: b.voorstel }));
      for (const p of k.posities) delete p._ruw;
      return { ok: true, vandaag, vragen: VRAGEN, antwoorden: d.antwoorden, regels: d.regels, versies: d.versies, stand: { datum: d.stand_datum, bron: d.stand_bron,
        verdeling: k.verdeling, posities: k.posities, cash: k.cash, lampjes: k.lampjes, volledig: k.volledig }, transacties: d.transacties, dagboek, volglijst: volg,
        signalen: k.signalen, signalen_verborgen: k.signalen_verborgen, open_punten: k.open_punten, belang: k.belang, bestanden: d.bestanden, rekening_rijen: d.rekening_rijen,
        soort_namen: SOORT_NAAM, vault: { ok: vaultOk, op: laatsteVault }, bedrijven };
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
      r.push('| ' + f.label + ' (vraag ' + f.vraag + ') | ' + (w == null ? '–' : Array.isArray(w) ? w.join(', ') : f.soort === 'pct' ? pctTekst(w) : f.soort === 'keuze' ? (f.opties.find((o) => o[0] === w) || [w, w])[1] : String(w)) + ' |');
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
  function zetSoort(b) {
    const sl = T(b.sleutel, 200);
    if (!sl || !/^(isin|naam):/.test(sl)) throw new Fout(400, 'onbekende positie');
    if (b.soort !== null && !SOORTEN.includes(b.soort)) throw new Fout(400, 'soort: kern, tech, health of leuk');
    metDb((db) => {
      if (!db.prepare('SELECT 1 FROM positie WHERE sleutel = ?').get(sl)) throw new Fout(404, 'positie niet gevonden');
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
    if (b.actie !== 'zet') throw new Fout(400, 'actie: zet of weg');
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
    return metDb((db) => {
      let nieuw = 0, bekend = 0;
      if (l.soort === 'transacties' || l.soort === 'rekening') {
        const tab = l.soort === 'transacties' ? 'transactie' : 'rekening';
        const st = db.prepare('SELECT 1 FROM ' + tab + ' WHERE sleutel = ?');
        for (const r of l.rijen) { if (st.get(r.sleutel)) bekend++; else nieuw++; }
      } else {
        const vorige = db.prepare("SELECT sha256 FROM bestand WHERE soort = 'portefeuille' ORDER BY id DESC LIMIT 1").get();
        if (vorige && vorige.sha256 === h) bekend = l.rijen.length; else nieuw = l.rijen.length;
      }
      const samen = { ok: true, soort: l.soort, rijen: l.rijen.length, nieuw, al_bekend: bekend, decimaal: l.decimaal, datum: l.soort === 'portefeuille' ? datum : null,
        effecten: l.soort === 'portefeuille' ? l.rijen.filter((r) => r.regelsoort === 'effect').length : undefined, bewaard: false };
      if (b.bewaar !== true) return { status: 200, body: samen, reden: 'beleggen bestand proef ' + l.soort };
      if (!nieuw && l.soort !== 'portefeuille') return { status: 200, body: Object.assign(samen, { bewaard: true, melding: 'niets nieuws: alles stond er al in' }), reden: 'beleggen bestand dubbel ' + l.soort };
      if (!nieuw) return { status: 200, body: Object.assign(samen, { bewaard: true, melding: 'dit bestand was al ingelezen' }), reden: 'beleggen bestand dubbel portefeuille' };
      const op = nuIso();
      const id = Number(db.prepare('INSERT INTO bestand (soort, naam, sha256, datum_bestand, op, rijen, nieuw, inhoud) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(l.soort, naam, h, l.soort === 'portefeuille' ? datum : null, op, l.rijen.length, nieuw, b.tekst).lastInsertRowid);
      if (l.soort === 'transacties') {
        const st = db.prepare('INSERT OR IGNORE INTO transactie (sleutel, datum, tijd, naam, isin, beurs, aantal, koers, valuta, lokaal_cent, waarde_eur_cent, wisselkoers, kosten_eur_cent, totaal_eur_cent, order_id, bron, bestand_id, op) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const r of l.rijen) st.run(r.sleutel, r.datum, r.tijd, r.naam, r.isin, r.beurs, r.aantal, r.koers, r.valuta, r.lokaal_cent, r.waarde_eur_cent, r.wisselkoers, r.kosten_eur_cent, r.totaal_eur_cent, r.order_id, 'bestand', id, op);
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
      return { status: 200, body: Object.assign(samen, { bewaard: true }), reden: 'beleggen bestand ' + l.soort + ' ' + nieuw + ' nieuw' };
    }, true);
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
      id = Number(db.prepare('INSERT INTO dagboek (transactie_sleutel, datum, naam, waarom, blijven, verkoop_wanneer, terugblik6, terugblik12, op, bijgewerkt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(tx ? tx.sleutel : null, datum, naam, velden.waarom, velden.blijven, velden.verkoop_wanneer, velden.terugblik6, velden.terugblik12, op, op).lastInsertRowid);
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
      lijst.push({ sleutel: p.sleutel, naam: p.naam, bron: 'positie', soort: p.soort || null, aandeel: p.aandeel, boven_max: R.max_aandeel != null && p._ruw != null && p._ruw > R.max_aandeel + 1e-9,
        reden: k.woorden[p.sleutel] || null, kaartje: kaartjes[p.sleutel] || null, voorstel: { namen: [kaleNaam(p.naam)], code: null } });
    }
    for (const v of d.volglijst) lijst.push({ sleutel: 'volg:' + v.id, naam: v.naam, bron: 'volglijst', soort: v.thema || null, aandeel: null, boven_max: false,
      reden: v.waarom || null, kaartje: kaartjes['volg:' + v.id] || null, voorstel: { namen: [kaleNaam(v.naam)], code: v.code || null } });
    return lijst;
  }
  // Voor beleggen-nieuws.js: wat er nodig is om op te halen en te wegen (geen bedragen; aandeel in % alleen voor de kaart in de app).
  function nieuwsData() {
    return metDb((db) => {
      const d = leesAlles(db);
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
      else { const r = db.prepare("SELECT naam FROM positie WHERE sleutel = ? AND regelsoort = 'effect'").get(sl); naam = r && r.naam; }
      if (!naam) throw new Fout(404, 'bedrijf niet gevonden in je stand of volglijst');
      if (b.actie === 'weg') { db.prepare('DELETE FROM bedrijf WHERE sleutel = ?').run(sl); return { reden: 'beleggen bedrijf weg' }; }
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

  const SCHRIJF = { '/app/beleggen/plan': zetPlan, '/app/beleggen/soort': zetSoort, '/app/beleggen/positie': zetPositie, '/app/beleggen/transactie': zetTransactie,
    '/app/beleggen/bestand': zetBestand, '/app/beleggen/dagboek': zetDagboek, '/app/beleggen/volglijst': zetVolglijst, '/app/beleggen/signaal': zetSignaal,
    '/app/beleggen/bedrijf': zetBedrijf, '/app/beleggen/week/keuze': zetWeekKeuze };
  function app(v) {
    try {
      if (v.methode === 'GET' && v.pad === '/app/beleggen') return { status: 200, body: overzicht(), reden: 'beleggen' };
      if (v.methode === 'GET' && v.pad === '/app/beleggen/week') return { status: 200, body: leesWeek(), reden: 'beleggen week' };
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
  function info() {
    return metDb((db) => {
      if (!db) return { aan: true, databank: false };
      const n = (t) => db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n;
      return { aan: true, databank: true, posities: n('positie'), transacties: n('transactie'), rekening: n('rekening'), dagboek: n('dagboek'), volglijst: n('volglijst'),
        planversies: n('planversie'), vault_ok: vaultOk, schema: Number((db.prepare("SELECT waarde FROM meta WHERE sleutel = 'schema'").get() || {}).waarde) || null,
        nieuws: { bedrijven: n('bedrijf'), regels: n('nieuws'), weken: n('week'), bronnen_gezakt: db.prepare('SELECT COUNT(*) AS n FROM nieuws_bron WHERE gezakt = 1').get().n } };
    }, false);
  }
  return { app, info, _overzicht: overzicht, nieuwsData, metDb, vandaag: vandaagF };
}

module.exports = { maak, leesBestand, bereken, regelsUit, VRAGEN, LeesFout, ANTHROPIC_ZIN, plusMaanden };
