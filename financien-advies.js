// financien-advies.js — OVIS Financiën 8+, stap 4: adviesregels A1–A5 (wv2620; ontwerp vault "01_Ontwikkeling/OVIS Financiën 8+
// (ontwerp 7-11-2026)" § 3.5 en § 8 = verwerkte gpt-5.5-review).
//
// WAAROM. David 6-11-2026: "Echt financieel inzicht, inclusief adviezen." Een advies is hier een VASTE REGEL met invoer (getallen met hun
// bron), een rekensom, de uitkomst in euro per jaar (of een bandbreedte), een zekerheid en een drempel. Geen taalmodel: de zin is een vast
// sjabloon met de getallen uit de rekensom. Niets wordt uitgevoerd; de App toont het advies en David kan het zelf als vraag aan Socev
// sturen ("Ik wil dit" of een concept-vraag aan de adviseur; David verstuurt).
//
// REGELS (REGELS hieronder; reken() is puur: dezelfde invoer + tarieven geeft dezelfde uitkomst, de toets herrekent elk advies)
//   A1  duurste leningdeel aflossen vs geld op lage rente — per € 10.000: bruto (rente − spaarrente laag), na aftrek (rente × (1 − max.
//       aftrektarief) − spaarrente hoog). Alleen een bandbreedte en altijd "laat toetsen" (review MOET 6: aftrekbeperking, resterende
//       aftrektermijn, partnerverdeling, boete en leningvorm zitten niet in het model). Drempel: rente − spaarrente hoog ≥ 1 procentpunt.
//   A2  geld werkeloos op rekeningen zonder rentebijschrijving (12 maanden, gemeten in de bank) boven 2 maanden leven × spaarrente laag;
//       per bank het saldo naast de depositogarantie (review ZOU 3). Schatting.
//   A3  energie in de duurste uren — prijs per uursegment uit de Tibber-pagina; een bedrag pas als David de schuifbare kWh aanwees (tabel
//       "Schuifbaar | kWh per jaar" op die pagina; review ZOU 4): kWh × (duurste − goedkoopste segment), laag = minst gunstige grens.
//       Zonder aanwijzing alleen een signaal zonder bedrag.
//   A4  abonnementen duurder / prijsstap / dubbel / nieuw — de signalen van financien-app.js met hun jaarbedrag (zeker: uit de bank).
//   A5  verzekeringen die per maand betaald worden — alleen een signaal zonder bedrag (review ZOU 5).
// Volgorde (review MOET 9): risico en deadline, dan zekerheid (zeker, schatting, laat toetsen, signaal), dan euro's per jaar. Op het
// startscherm hooguit drie, alleen met een bedrag ≥ € 50 per jaar (bij een bandbreedte de onderkant); de rest staat in de lijst.
// Ontbreekt een tarief of invoer, dan geen advies en een regel in "ontbreekt" (ontwerp § 3.5).
// Alles heet "zichtbare rekeningen" (review MOET 1): geen advies leunt als zekerheid op een huishoudtotaal.
//
// Schrijft niets, geen netwerk. Het antwoord gaat alleen naar Davids eigen App (GET /app/financien, blok overzicht.advies).
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path');

// Tarieven en grenzen, elk met bron en leesdatum. Ontbreekt er een, dan geen advies op die regel.
const TARIEVEN = {
  spaarrente: { laag: 1.25, hoog: 1.51, op: '2026-11-07',
    bron: 'vrij opneembaar sparen: ABN AMRO 1,25 % (raisin.com, okt 2026), bunq basisrente 1,51 % (keuze.nl); niet bij de banken zelf gecontroleerd' },
  aftrek: { 2026: 37.56, op: '2026-11-07', bron: 'maximaal aftrektarief eigen woning 2026 (Kamerantwoord; homefinance.nl, Prinsjesdag 2025); niet bij de Belastingdienst zelf gecontroleerd' },
  depositogarantie: { grens: 100000, op: '2026-11-07', bron: 'depositogarantiestelsel (DNB): € 100.000 per persoon per bank' },
};
const START_MIN = 50, START_MAX = 3, PER_BEDRAG = 10000;
const P_ENERGIE = path.join('20_Prive', 'Financien', 'Energieverbruik thuis (Tibber).md');
const ZEKER = ['zeker', 'schatting', 'laat toetsen', 'signaal'];
const PRIO = ['risico', 'deadline'];

function r0(n) { return Math.round(n); }
function r2(n) { return Math.round(n * 100) / 100; }
function eur(n) { const v = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); return (n < 0 ? '− ' : '') + '€ ' + v; }
function pct(n) { return String(r2(n)).replace('.', ',') + ' %'; }
function plusMaanden(d, n) { const j = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1 + n; return (j + Math.floor(m / 12)) + '-' + String(((m % 12) + 12) % 12 + 1).padStart(2, '0') + d.slice(7); }
function hid(s) { return crypto.createHash('sha256').update('advies:' + s).digest('hex').slice(0, 12); }

// ── de regels: reken(invoer, tarieven) → { euro_jaar, band } of null (drempel niet gehaald) ──
const REGELS = {
  A1: { titel: 'Duurste leningdeel aflossen of geld laten staan?', zekerheid: 'laat toetsen', actie: 'adviseur',
    rekensom: 'per € 10.000 (of de restschuld als die kleiner is): bruto (rente − spaarrente laag) × bedrag; na aftrek (rente × (1 − aftrektarief) − spaarrente hoog) × bedrag',
    drempel: 'rente duurste deel − spaarrente hoog ≥ 1 procentpunt',
    reken: function (i) {
      if (!(i.rente > 0) || i.spaar_laag == null || i.spaar_hoog == null || i.aftrek == null) return null;
      if (i.rente - i.spaar_hoog < 1) return null;
      const hoog = r0((i.rente - i.spaar_laag) / 100 * i.bedrag), laag = r0(Math.max(0, i.rente * (1 - i.aftrek / 100) - i.spaar_hoog) / 100 * i.bedrag);
      return { euro_jaar: null, band: { laag: laag, hoog: hoog } };
    } },
  A2: { titel: 'Geld dat niets oplevert', zekerheid: 'schatting', actie: 'zelf',
    rekensom: '(saldo op rekeningen zonder rente − 2 × leven per maand) × spaarrente laag', drempel: 'overschot > 0',
    reken: function (i) {
      if (i.spaar_laag == null || !(i.leven_pm > 0) || i.saldo == null) return null;
      const over = i.saldo - i.maanden * i.leven_pm;
      if (!(over > 0)) return null;
      return { euro_jaar: r0(over * i.spaar_laag / 100), band: null };
    } },
  A3: { titel: 'Stroom in de duurste uren', zekerheid: 'schatting', actie: 'zelf',
    rekensom: 'schuifbare kWh per jaar × (prijs duurste uren − prijs goedkoopste uren); laag = minst gunstige grens van beide', drempel: 'jij wees de schuifbare kWh aan',
    reken: function (i) {
      if (!(i.kwh > 0) || ![i.duur_min, i.duur_max, i.goed_min, i.goed_max].every(function (x) { return typeof x === 'number' && Number.isFinite(x); })) return null;
      const laag = r0(Math.max(0, i.duur_min - i.goed_max) / 100 * i.kwh), hoog = r0(Math.max(0, i.duur_max - i.goed_min) / 100 * i.kwh);
      return { euro_jaar: laag, band: { laag: laag, hoog: hoog } };
    } },
  A4: { titel: 'Abonnement', zekerheid: 'zeker', actie: 'zelf', rekensom: 'verschil (of kosten) per maand × 12, uit de bank', drempel: 'een signaal met bedrag',
    reken: function (i) { return i.per_jaar > 0 ? { euro_jaar: r0(i.per_jaar), band: null } : null; } },
  A5: { titel: 'Verzekeringen per maand betaald', zekerheid: 'signaal', actie: 'adviseur', rekensom: 'geen bedrag (de toeslag voor maandbetaling staat niet in de bank)',
    drempel: 'minstens één verzekering met ritme maand', reken: function (i) { return i.aantal > 0 ? { euro_jaar: null, band: null } : null; } },
};

// ── invoer verzamelen ──
function renteRekeningen(A, a, nu) {
  // rekeningen met een rentebijschrijving in de laatste 12 maanden (omschrijving of indeling noemt rente/interest; bedrag > 0)
  const l = a.db.prepare("SELECT DISTINCT t.rek FROM transacties t JOIN verrijking v ON v.nr = t.nr WHERE t.status IN ('booked', 'pending') AND t.bedrag > 0 AND t.datum >= ?" +
    " AND (lower(coalesce(v.subcategorie, '')) LIKE '%rente%' OR lower(coalesce(t.omschrijving, '')) LIKE '%rente%' OR lower(coalesce(t.omschrijving, '')) LIKE '%interest%')").all(plusMaanden(nu, -12));
  return new Set(l.map(function (r) { return A.rekId(r.rek); }));
}
function bereik(s, FV) {
  const d = String(s || '').split(/\s*–\s*/).map(function (x) { return FV.nlGetal(x); }).filter(function (x) { return x != null; });
  return d.length ? { min: Math.min.apply(null, d), max: Math.max.apply(null, d) } : null;
}
function leesEnergie(vault, FV) {
  const p = path.join(vault, P_ENERGIE), st = fs.statSync(p);
  if (!st.isFile() || st.size > 400000) return null;
  const t = fs.readFileSync(p, 'utf8'), ts = FV.tabellen(t);
  const tab = ts.find(function (x) { return x.kop[0] === 'uur' && x.rijen.some(function (r) { return /^prijs/i.test(FV.schoon(r[0])); }); });
  if (!tab) return null;
  const rij = tab.rijen.find(function (r) { return /^prijs/i.test(FV.schoon(r[0])); });
  const seg = tab.kop.slice(1).map(function (k, i) { return { uur: k, prijs: bereik(rij[i + 1], FV) }; }).filter(function (x) { return x.prijs; });
  if (seg.length < 2) return null;
  const duur = seg.slice().sort(function (x, y) { return y.prijs.max - x.prijs.max; })[0], goed = seg.slice().sort(function (x, y) { return x.prijs.min - y.prijs.min; })[0];
  const sch = FV.tabel(ts, ['schuifbaar', 'kwh per jaar']);
  const kwh = sch ? sch.reduce(function (s, r) { const n = FV.nlGetal(r['kwh per jaar']); return s + (n > 0 ? n : 0); }, 0) : null;
  return { duur: duur, goed: goed, kwh: kwh, bron: P_ENERGIE };
}

// o: { ov (blok overzicht), saldi (blok saldi), signalen (financien-app, met per_jaar), vaste (blok vaste_lasten), nu, vault, fv, tarieven }
function advies(A, a, o) {
  const T = o.tarieven || TARIEVEN, FV = o.fv || require('./financien-vault.js'), nu = o.nu, uit = [], ontbreekt = [], fouten = [];
  const blok = function (n, f) { try { return f(); } catch (e) { fouten.push(n); return null; } };
  const mist = function (regel, waarom) { ontbreekt.push({ regel: regel, waarom: waarom }); };
  const sp = T.spaarrente && typeof T.spaarrente.laag === 'number' && typeof T.spaarrente.hoog === 'number' ? T.spaarrente : null;
  const jaar = Number(nu.slice(0, 4)), aftrek = T.aftrek && typeof T.aftrek[jaar] === 'number' ? T.aftrek[jaar] : null;
  const zet = function (regel, sleutel, invoer, x) {
    const R = REGELS[regel], u = R.reken(invoer, T);
    if (!u) return false;
    uit.push(Object.assign({ id: regel + ':' + hid(sleutel), regel: regel, titel: x.titel || R.titel, zekerheid: R.zekerheid, actie: R.actie, prioriteit: x.prioriteit || null,
      deadline: x.deadline || null, invoer: invoer, bronnen: x.bronnen, rekensom: R.rekensom, drempel: R.drempel }, u, { zin: x.zin(u) }));
    return true;
  };
  // A1
  blok('A1', function () {
    const v = FV.lees(o.vault), hyp = v && v.hypotheek;
    const delen = hyp && Array.isArray(hyp.delen) ? hyp.delen.filter(function (d) { return d.rente_bank > 0 && d.restschuld_bank > 0; }) : [];
    if (!delen.length) return mist('A1', 'geen leningdelen met rente en restschuld te lezen');
    if (!sp) return mist('A1', 'geen spaarrente in de tarieven');
    if (aftrek == null) return mist('A1', 'geen aftrektarief voor ' + jaar);
    const d = delen.slice().sort(function (x, y) { return y.rente_bank - x.rente_bank; })[0];
    const naam = 'leningdeel ' + (d.deel || '?') + (d.doel ? ' (' + d.doel + ')' : '');
    const rv = d.rentevast_tm || null, binnen = rv && rv <= plusMaanden(nu, 24);
    const ruimte = o.ov && o.ov.buffer ? r0(o.ov.buffer.liquide - 3 * o.ov.buffer.leven_per_maand) : null;
    // per € 10.000, of de restschuld als die kleiner is (review wv2620 MOET 3)
    const per = Math.min(PER_BEDRAG, Math.round(d.restschuld_bank)), perTxt = per === PER_BEDRAG ? 'Elke € 10.000' : 'De resterende ' + eur(per);
    const ok = zet('A1', 'A1|' + (d.deel || d.doel || ''), { rente: d.rente_bank, spaar_laag: sp.laag, spaar_hoog: sp.hoog, aftrek: aftrek, bedrag: per }, {
      prioriteit: binnen ? 'deadline' : null, deadline: binnen ? rv : null,
      bronnen: [{ tekst: 'Rente ' + naam + ', ' + (d.soort || 'soort onbekend'), waarde: pct(d.rente_bank), bron: hyp.bron && hyp.bron.bank ? hyp.bron.bank : 'hypotheek-json' },
        { tekst: 'Restschuld ' + naam, waarde: eur(d.restschuld_bank), bron: hyp.bron && hyp.bron.bank ? hyp.bron.bank : 'hypotheek-json' },
        rv ? { tekst: 'Rentevast tot', waarde: rv.split('-').reverse().map(Number).join('-'), bron: hyp.bron && hyp.bron.rentevast ? hyp.bron.rentevast : 'je Excel' } : null,
        { tekst: 'Spaarrente', waarde: pct(sp.laag) + ' – ' + pct(sp.hoog), bron: sp.bron + ' (' + sp.op + ')' },
        { tekst: 'Maximaal aftrektarief ' + jaar, waarde: pct(aftrek), bron: T.aftrek.bron },
        ruimte != null ? { tekst: 'Vrij beschikbaar boven 3 maanden leven (zichtbare rekeningen)', waarde: eur(Math.max(0, ruimte)), bron: 'bankstand en overzicht' } : null].filter(Boolean),
      zin: function (u) { return perTxt + ' extra aflossen op ' + naam + ' (' + pct(d.rente_bank) + ') scheelt ' + eur(u.band.laag) + ' tot ' + eur(u.band.hoog) + ' per jaar tegenover sparen. ' +
        (rv ? 'De rente staat vast tot ' + rv.split('-').reverse().map(Number).join('-') + '. ' : '') + 'Boete, aftrek en partnerverdeling zitten niet in deze som: laat het toetsen door je adviseur.' + (ruimte != null && ruimte <= 0 ? ' Er staat nu niet meer dan 3 maanden leven op de rekeningen.' : ''); },
    });
    if (!ok) mist('A1', 'het rentevoordeel is kleiner dan 1 procentpunt');
  });
  // A2
  blok('A2', function () {
    const sal = o.saldi && Array.isArray(o.saldi.rekeningen) ? o.saldi.rekeningen.filter(function (r) { return r.valuta === 'EUR' && typeof r.saldo === 'number' && (r.groep === 'eigen' || r.groep === 'samen'); }) : null;
    const lpm = o.ov && o.ov.buffer ? o.ov.buffer.leven_per_maand : null;
    if (!sal) return mist('A2', 'geen saldi gelezen');
    if (!(lpm > 0)) return mist('A2', 'leven per maand niet te berekenen');
    if (!sp) return mist('A2', 'geen spaarrente in de tarieven');
    const rente = renteRekeningen(A, a, nu);
    // netto (review wv2620 MOET 2): een rekening in de min telt mee, anders lijkt geld werkeloos dat er netto niet is
    const zonder = sal.filter(function (r) { return !rente.has(r.id); }), saldo = r2(zonder.reduce(function (s, r) { return s + r.saldo; }, 0));
    const perBank = new Map();
    sal.forEach(function (r) { perBank.set(r.bank, (perBank.get(r.bank) || 0) + r.saldo); });
    const dg = T.depositogarantie && T.depositogarantie.grens > 0 ? T.depositogarantie : null;
    const banken = Array.from(perBank.entries()).map(function (e) { return { bank: e[0], saldo: r2(e[1]), boven_garantie: dg ? e[1] > dg.grens : null }; });
    const ok = zet('A2', 'A2', { saldo: saldo, leven_pm: r2(lpm), maanden: 2, spaar_laag: sp.laag }, {
      prioriteit: banken.some(function (b) { return b.boven_garantie; }) ? 'risico' : null,
      bronnen: [{ tekst: 'Saldo op ' + zonder.length + ' rekeningen zonder rentebijschrijving in 12 maanden (David en gedeeld)', waarde: eur(saldo), bron: 'bankstand; rente gezocht in de boekingen' },
        { tekst: 'Leven per maand zonder eenmalig groot', waarde: eur(lpm), bron: 'overzicht, 12 maanden' },
        { tekst: 'Spaarrente (laag)', waarde: pct(sp.laag), bron: sp.bron + ' (' + sp.op + ')' }]
        .concat(banken.map(function (b) { return { tekst: 'Saldo bij ' + b.bank + (b.boven_garantie ? ' — boven de depositogarantie van ' + eur(dg.grens) + ' per persoon' : ''), waarde: eur(b.saldo), bron: dg ? dg.bron : 'bankstand' }; })),
      zin: function (u) { return 'Er staat ' + eur(saldo - 2 * lpm) + ' meer dan 2 maanden leven op rekeningen zonder rente. Op een spaarrekening (' + pct(sp.laag) + ') is dat ± ' + eur(u.euro_jaar) + ' per jaar.'; },
    });
    if (!ok) mist('A2', 'niet meer dan 2 maanden leven op rekeningen zonder rente');
  });
  // A3
  blok('A3', function () {
    const e = leesEnergie(o.vault, FV);
    if (!e) return mist('A3', 'geen prijzen per uur op de energiepagina');
    const inv = { kwh: e.kwh || 0, duur_min: e.duur.prijs.min, duur_max: e.duur.prijs.max, goed_min: e.goed.prijs.min, goed_max: e.goed.prijs.max };
    const br = [{ tekst: 'Prijs ' + e.duur.uur + ' uur (duurst)', waarde: String(e.duur.prijs.min).replace('.', ',') + '–' + String(e.duur.prijs.max).replace('.', ',') + ' ct/kWh', bron: e.bron },
      { tekst: 'Prijs ' + e.goed.uur + ' uur (goedkoopst)', waarde: String(e.goed.prijs.min).replace('.', ',') + '–' + String(e.goed.prijs.max).replace('.', ',') + ' ct/kWh', bron: e.bron }];
    if (e.kwh > 0) {
      br.push({ tekst: 'Schuifbaar per jaar (jouw aanwijzing)', waarde: Math.round(e.kwh).toLocaleString('nl-NL') + ' kWh', bron: e.bron });
      zet('A3', 'A3', inv, { bronnen: br, zin: function (u) { return 'Wat jij als schuifbaar aanwees (' + Math.round(e.kwh) + ' kWh per jaar) van ' + e.duur.uur + ' uur naar ' + e.goed.uur + ' uur schuiven: ± ' + eur(u.band.laag) + ' tot ' + eur(u.band.hoog) + ' per jaar.'; } });
      return;
    }
    // zonder aanwijzing: signaal zonder bedrag (review ZOU 4)
    uit.push({ id: 'A3:' + hid('A3s'), regel: 'A3', titel: REGELS.A3.titel, zekerheid: 'signaal', actie: 'zelf', prioriteit: null, deadline: null, invoer: inv, bronnen: br, rekensom: REGELS.A3.rekensom,
      drempel: REGELS.A3.drempel, euro_jaar: null, band: null,
      zin: 'Stroom kost ' + e.duur.uur + ' uur ' + br[0].waarde + ', ' + e.goed.uur + ' uur ' + br[1].waarde + '. Zeg welke apparaten je kunt verschuiven (bijvoorbeeld het laden van de auto); dan rekent Socev het bedrag uit.' });
  });
  // A4
  blok('A4', function () {
    const s = (o.signalen || []).filter(function (x) { return ['duurder', 'prijsstap', 'dubbel', 'nieuw'].indexOf(x.soort) >= 0 && x.per_jaar > 0; });
    if (!s.length) mist('A4', 'geen abonnementsignaal met bedrag');
    s.forEach(function (x) {
      const t = x.titel || 'Abonnement', w = { duurder: 'duurder dan een jaar geleden', prijsstap: 'duurder sinds kort', dubbel: 'mogelijk dubbel', nieuw: 'nieuw' }[x.soort];
      zet('A4', 'A4|' + x.soort + '|' + t, { per_jaar: x.per_jaar, soort: x.soort }, { titel: t + ': ' + w, bronnen: [{ tekst: x.zin, waarde: eur(x.per_jaar) + ' per jaar', bron: 'bank (vaste lasten en PayPal)' }],
        zin: function (u) { return x.soort === 'nieuw' ? t + ' kost ' + eur(u.euro_jaar) + ' per jaar. Nog nodig?' : x.soort === 'dubbel' ? 'Als één van de twee weg kan, scheelt dat ' + eur(u.euro_jaar) + ' per jaar.' :
          t + ' is ' + eur(u.euro_jaar) + ' per jaar duurder geworden. Klopt dat, en kan het goedkoper of weg?'; } });
    });
  });
  // A5
  blok('A5', function () {
    const r = o.vaste && Array.isArray(o.vaste.rijen) ? o.vaste.rijen.filter(function (x) { return x.ritme === 'maand' && /verzeker/i.test(String(x.categorie || '')) && x.per_maand > 0; }) : null;
    if (!r) return mist('A5', 'geen vaste lasten gelezen');
    const som = r2(r.reduce(function (s, x) { return s + x.per_maand; }, 0));
    const ok = zet('A5', 'A5', { aantal: r.length, per_maand: som }, { bronnen: r.slice(0, 12).map(function (x) { return { tekst: x.naam, waarde: eur(x.per_maand) + ' per maand', bron: 'bank (vaste lasten)' }; }),
      zin: function () { return r.length + (r.length === 1 ? ' verzekering betaal' : ' verzekeringen betaal') + ' je per maand (samen ' + eur(som) + '). Vraag na of per jaar betalen goedkoper is; de bank laat de toeslag niet zien.'; } });
    if (!ok) mist('A5', 'geen verzekering met maandbetaling');
  });
  // volgorde: risico/deadline → zekerheid → euro's
  const waarde = function (x) { return x.euro_jaar != null ? x.euro_jaar : x.band ? x.band.laag : null; };
  const rang = function (x) { const p = PRIO.indexOf(x.prioriteit); return p < 0 ? PRIO.length : p; };
  uit.sort(function (x, y) { return rang(x) - rang(y) || ZEKER.indexOf(x.zekerheid) - ZEKER.indexOf(y.zekerheid) || (waarde(y) || 0) - (waarde(x) || 0); });
  const start = uit.filter(function (x) { const w = waarde(x); return w != null && w >= START_MIN; }).slice(0, START_MAX).map(function (x) { return x.id; });
  uit.forEach(function (x) { x.op_start = start.indexOf(x.id) >= 0; x.waarde = waarde(x); });
  return { adviezen: uit, start: start, ontbreekt: ontbreekt, fouten: fouten, label: 'zichtbare rekeningen',
    tarieven: Object.keys(T).map(function (k) { return { naam: k, bron: T[k].bron, op: T[k].op }; }),
    regels: Object.keys(REGELS).map(function (k) { return { regel: k, titel: REGELS[k].titel, zekerheid: REGELS[k].zekerheid, rekensom: REGELS[k].rekensom, drempel: REGELS[k].drempel }; }),
    uitleg: 'Vaste rekenregels met hun invoer en bron; Socev voert niets uit. Fiscaal en hypotheek: altijd laten toetsen door je adviseur. Volgorde: risico en deadline, dan zekerheid, dan euro\'s per jaar.' };
}

module.exports = { advies: advies, REGELS: REGELS, TARIEVEN: TARIEVEN, START_MIN: START_MIN, START_MAX: START_MAX, leesEnergie: leesEnergie };
