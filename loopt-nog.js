'use strict';
/*
 * loopt-nog.js — "Loopt nog": alles wat de vier nachtwachters voor David volgen op één scherm (wv4130, besluitenpagina nr 457 = 3C157,
 * David Ja 25-11-2026 22:05; review Een 9 - nachtwachters § F2 en Een 9 - actielijst-deadlines § idee 3 "tik op het getal").
 *
 * WAAROM. Er lopen ± 75 zaken (acties, maildraden, agendapunten, personeelstrajecten); David zag er 2 of 3 per dag in het actielijstje en
 * de rest nergens. Alleen lezen: dit scherm verandert niets in de wachtertabellen (knoppen blijven in Voor jou en het actielijstje).
 *
 * HOE. verdeel() is puur: de rijen van de vier tabellen (zoals de pod ze leest) → drie groepen plus tellingen per wachter en status, zodat
 * de toets "telling scherm = telling tabellen" één optelsom is.
 *   Jij moet           status gemeld (de wachter legde het je voor), of open bij jou: actie met eigenaar "David…", je eigen mailbelofte.
 *   Wacht op anderen   de rest van wat open is: actie bij een ander, mail die op antwoord wacht, agendapunt dat op bevestiging wacht,
 *                      personeelstraject (contract retour, einde, cao, gesprek, onboarding) dat nog niet gemeld is.
 *   Rond               afgerond of losgelaten (genegeerd) met laatst_gecheckt in de laatste RECENT_DAGEN dagen; plus personeel "groen"
 *                      (gecheckt en in orde, de wachter kijkt nog op volgende_check) als kopje "In orde".
 *   Niet als regel     agenda "groen" (elke afspraak die klopt; ± 175 rijen): alleen het aantal met een start vanaf vandaag; de
 *                      personeel-meta-rij (_meta_scan); afgerond/genegeerd ouder dan RECENT_DAGEN. Ze staan wel in de tellingen.
 * Per regel: de laatste afweging (het laatste stuk van bevinding na " | ", " || " of " ‖ "; de wachters schrijven er zo bij) en de dag
 * waarop de wachter weer kijkt (volgende_check). Ontbreekt een van beide, dan zegt de regel dat (geen verzonnen waarde).
 */

const RECENT_DAGEN = 14;
const AFWEGING_MAX = 420;
const HEEL_MAX = 2500;
const WACHTERS = ['actie', 'correspondentie', 'agenda', 'personeel'];
const NAAM = { actie: 'Actie', correspondentie: 'Mail', agenda: 'Agenda', personeel: 'Personeel' };
const OPEN = { actie: ['open', 'gemeld'], correspondentie: ['wacht', 'gemeld'], agenda: ['wacht', 'gemeld'], personeel: ['nieuw', 'wacht', 'gemeld'] };
const DICHT = ['afgerond', 'genegeerd'];
const SLEUTEL = { actie: 'actie_id', correspondentie: 'thread_id', agenda: 'event_id', personeel: 'item_id' };
const PERSONEEL_SOORT = { contract_retour: 'contract retour', contract_einde: 'contract loopt af', cao_trigger: 'cao', gesprek: 'gesprek', onboarding: 'onboarding', vacature: 'vacature' };

function schoon(s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }
function dag(s) { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s == null ? '' : s)); return m ? m[1] : null; }
function dagNr(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null; }
function plus(iso, d) { const n = dagNr(iso); return n === null ? null : new Date((n + d) * 86400000).toISOString().slice(0, 10); }

// Het laatste stuk van een bevinding (de wachters plakken elke ronde " | <datum>: …" of " ‖ " erachter)
function laatsteAfweging(b) {
  const t = String(b == null ? '' : b).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const delen = t.split(/\s+(?:\|\|?|‖)\s+/).map(function (x) { return x.trim(); }).filter(Boolean);
  const l = delen.length ? delen[delen.length - 1] : t;
  return l.length > AFWEGING_MAX ? l.slice(0, AFWEGING_MAX - 1).replace(/\s+\S*$/, '') + ' …' : l;
}
function isDavid(eigenaar) { return /^\s*david\b/i.test(String(eigenaar || '')); }

function titelVan(w, r) {
  if (w === 'actie') return schoon(r.actie, 200);
  if (w === 'correspondentie') return schoon(r.onderwerp || '(geen onderwerp)', 200);
  if (w === 'agenda') return schoon(r.titel || '(afspraak)', 200);
  return schoon(r.omschrijving || r.medewerker || r.item_id, 200);
}
function wieVan(w, r) {
  if (w === 'actie') return schoon(r.eigenaar, 80);
  if (w === 'correspondentie') return schoon(r.tegenpartij, 80);
  if (w === 'agenda') return schoon(r.kalender, 40);
  return schoon([r.medewerker, PERSONEEL_SOORT[r.type] || r.type].filter(Boolean).join(' · '), 80);
}
function soortZin(w, r) {
  if (w === 'correspondentie') return r.type === 'belofte_david' ? 'je belofte' : 'wacht op antwoord';
  if (w === 'agenda') return 'afspraak';
  return null;
}
function groepVan(w, r) {
  const st = String(r.status || '');
  if (DICHT.indexOf(st) >= 0) return 'rond';
  if (w === 'personeel' && st === 'groen') return 'rond';
  if (st === 'gemeld') return 'jij';
  if (w === 'actie') return isDavid(r.eigenaar) ? 'jij' : 'anderen';
  if (w === 'correspondentie') return r.type === 'belofte_david' ? 'jij' : 'anderen';
  return 'anderen';
}

function regel(w, r, vandaag) {
  const st = String(r.status || '');
  const kijkt = dag(r.volgende_check);
  const uiterlijk = dag(r.deadline) || dag(r.uiterlijk);
  const x = {
    wachter: w, naam: NAAM[w], sleutel: schoon(r[SLEUTEL[w]], 120), titel: titelVan(w, r), wie: wieVan(w, r) || null, soort: soortZin(w, r),
    status: st, entiteit: schoon(r.entiteit, 40) || null,
    afweging: laatsteAfweging(r.bevinding) || null,
    heel: String(r.bevinding || '').length > AFWEGING_MAX ? String(r.bevinding).replace(/\s+/g, ' ').trim().slice(-HEEL_MAX) : null,
    kijkt: DICHT.indexOf(st) >= 0 ? null : kijkt, kijkt_voorbij: !!(kijkt && DICHT.indexOf(st) < 0 && kijkt < vandaag),
    uiterlijk: uiterlijk, gemeld_op: dag(r.gemeld_op), gecheckt: dag(r.laatst_gecheckt),
    start: w === 'agenda' ? dag(r.start) : null,
    link: null
  };
  // de mailwisseling (zoals wachter-kaarten.js; doktersmaten staat in een ander postvak)
  if (w === 'correspondentie' && /^[0-9a-f]{10,24}$/.test(String(r.thread_id || '')) && !/doktersmaten/i.test(String(r.bron || '')))
    x.link = 'https://mail.google.com/mail/u/0/#all/' + r.thread_id;
  return x;
}
// eerst wat een uiterste datum heeft (vroegste eerst), dan wat de wachter het eerst weer bekijkt
function volgorde(a, b) {
  const ua = a.uiterlijk || '9999', ub = b.uiterlijk || '9999';
  if (ua !== ub) return ua < ub ? -1 : 1;
  const ka = a.kijkt || '9999', kb = b.kijkt || '9999';
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.titel.localeCompare(b.titel);
}

// tabellen: { actie: [rij] | null, correspondentie, agenda, personeel } (null = niet te lezen); vandaag = NL-kalenderdag JJJJ-MM-DD
function verdeel(tabellen, vandaag) {
  const sinds = plus(vandaag, -RECENT_DAGEN);
  const g = { jij: [], anderen: [], rond: [], in_orde: [] };
  const tel = {}, fouten = [];
  let agendaInOrde = 0;
  WACHTERS.forEach(function (w) {
    const rijen = tabellen[w];
    if (!Array.isArray(rijen)) { fouten.push(w); tel[w] = null; return; }
    const t = { rijen: rijen.length, per_status: {}, jij: 0, anderen: 0, rond: 0, in_orde: 0, niet_getoond: 0 };
    rijen.forEach(function (r) {
      if (!r || typeof r !== 'object') { t.niet_getoond++; return; }
      const st = String(r.status || '');
      t.per_status[st] = (t.per_status[st] || 0) + 1;
      if (w === 'personeel' && (r.type === 'meta' || /^_meta/.test(String(r.item_id || '')))) { t.niet_getoond++; return; }
      if (w === 'agenda' && st === 'groen') { if ((dag(r.start) || '') >= vandaag) agendaInOrde++; t.niet_getoond++; return; }
      const groep = groepVan(w, r);
      if (groep === 'rond' && DICHT.indexOf(st) >= 0 && !((dag(r.laatst_gecheckt) || dag(r.updatedAt) || dag(r.bijgewerkt) || '') >= sinds)) { t.niet_getoond++; return; }
      if (groep === 'rond' && OPEN[w].indexOf(st) < 0 && DICHT.indexOf(st) < 0) { g.in_orde.push(regel(w, r, vandaag)); t.in_orde++; return; }
      if (groep !== 'rond' && OPEN[w].indexOf(st) < 0) { t.niet_getoond++; return; }   // onbekende status: niet raden
      g[groep].push(regel(w, r, vandaag)); t[groep]++;
    });
    tel[w] = t;
  });
  g.jij.sort(volgorde); g.anderen.sort(volgorde); g.in_orde.sort(volgorde);
  g.rond.sort(function (a, b) { return (b.gecheckt || '').localeCompare(a.gecheckt || '') || a.titel.localeCompare(b.titel); });
  const open = g.jij.length + g.anderen.length;
  return { vandaag: vandaag, sinds: sinds, recent_dagen: RECENT_DAGEN, groepen: g, open: open, agenda_in_orde: agendaInOrde, tellingen: tel, fouten: fouten };
}

module.exports = { verdeel: verdeel, laatsteAfweging: laatsteAfweging, groepVan: groepVan, isDavid: isDavid, RECENT_DAGEN: RECENT_DAGEN, OPEN: OPEN };
