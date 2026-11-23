'use strict';
// financien-teller.js — wv3925 (besluitenpagina nr 178 = 2C78 b + d, David Ja 22-11-2026 18:22; Fable "Een 9 - financien" S2 en S4). Puur:
// geen bestanden, geen klok, geen databank; server.js geeft de stand (blok signalen + overzicht.nu van GET /app/financien) en bewaart.
//
// TELLER (S2): het bolletje op de tegel Financiën telt wat aandacht vraagt en nog niet gezien is: elk signaal onder "Om naar te kijken" (prijsstap,
// nieuw, weg, dubbel, buffer, dekking, energie …) plus een tekort op de vaste-lastenrekening in de komende 14 dagen (Nu en straks). Een signaal
// heeft een vaste herkenning (soort + post), geen bedrag: een prijsstap die blijft staan telt één keer. Opent David Financiën, dan is alles wat
// er op dat moment stond gezien (POST /app/financien/gezien) en staat het bolletje op nul tot er iets nieuws bijkomt (risico uit de review: een
// teller die nooit op nul komt wordt ruis). "Boekingen waar Socev twijfelt" telt bewust niet mee: dat is opruimwerk (review: David haakte daarop af).
//
// IK WIL DIT (S4): één tik bij een advies zet het als punt in Voor jou (mk_voor_jou_zet, idempotent op de sleutel: een tweede tik maakt geen
// tweede punt). De sleutel hangt aan het advies-id, zodat hetzelfde advies volgende week niet opnieuw als nieuw verschijnt. Geen bedrag in de
// sleutel; de kaart zelf is privé (prive: true) en staat alleen in Davids eigen lijst.
const crypto = require('crypto');

const MAX_SLEUTELS = 60;
function h12(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12); }
function kaal(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }

// herkenning van één signaal: soort + post (titel), anders de zin zonder cijfers (een signaal zonder titel verandert niet van herkenning
// als alleen het bedrag schuift)
function signaalSleutel(s) {
  const soort = kaal(s && s.soort) || 'signaal';
  const wie = kaal(s && s.titel) || kaal(s && s.zin).replace(/[0-9.,€−-]+/g, '#');
  return 's' + h12(soort + '|' + wie);
}
// alle herkenningen die nu aandacht vragen (volgorde: signalen, dan het tekort)
function sleutels(stand) {
  const uit = [];
  const sig = stand && Array.isArray(stand.signalen) ? stand.signalen : [];
  sig.forEach(function (s) { if (s && typeof s === 'object') { const k = signaalSleutel(s); if (uit.indexOf(k) < 0) uit.push(k); } });
  const k = stand && stand.overzicht && stand.overzicht.nu && stand.overzicht.nu.komende;
  if (k && k.toon === 'fout') uit.push('t' + h12('tekort|' + String(k.tot || '').slice(0, 7)));   // één keer per maand (tot schuift elke dag mee)
  return uit.slice(0, MAX_SLEUTELS);
}
function geldigeLijst(l) { return Array.isArray(l) ? l.filter(function (x) { return typeof x === 'string' && /^[st][0-9a-f]{12}$/.test(x); }).slice(0, MAX_SLEUTELS) : []; }
// het getal op de tegel: wat er nu staat en niet bij het laatste bezoek stond
function tel(nu, gezien) {
  const g = new Set(geldigeLijst(gezien));
  const l = geldigeLijst(nu).filter(function (k) { return !g.has(k); });
  return { totaal: l.length, signalen: l.filter(function (k) { return k[0] === 's'; }).length, tekort: l.filter(function (k) { return k[0] === 't'; }).length };
}

// ── Ik wil dit ──
const ID_RE = /^A[0-9]{1,2}:[A-Za-z0-9_-]{1,40}$/;
function oppakSleutel(id) { return 'fin-advies-' + h12(String(id)); }
function kort(s, n) { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t; }
// de kaart voor Voor jou. Geen paden, wv-nummers of verwijzingen (mk_voor_jou_zet weigert die); de stappen staan in de kaart zelf.
function oppakKaart(a) {
  if (!a || typeof a !== 'object' || !ID_RE.test(String(a.id || ''))) throw new Error('onbekend advies');
  const titel = 'Financiën — ' + kort(String(a.titel || 'advies').replace(/\?\s*$/, ''), 60) + ': oppakken';
  const adviseur = a.actie === 'adviseur' || a.zekerheid === 'laat toetsen';
  const p = { sleutel: oppakSleutel(a.id), soort: 'doen', titel: titel, waar: 'overal', prive: true, duur_min: 15, volgorde: 60, door: 'david',
    waarom: kort(String(a.zin || ''), 300) + ' Je tikte "Ik wil dit" bij dit advies in Financiën.',
    stappen: ['Open in de Socev-app Apps › Financiën › Advies en lees bij dit advies "Hoe gerekend".',
      adviseur ? 'Laat het toetsen door je adviseur; de knop "Vraag de adviseur" zet daar een conceptmail voor klaar die je zelf verstuurt.'
        : 'Regel het zelf bij de bank of de aanbieder; Socev betaalt, verplaatst en zegt niets op.',
      'Klaar of besloten het niet te doen: zet deze kaart op gedaan.'],
    herkomst: { handmatig: 'financien-advies', module: 'financien', advies: String(a.id), doel: { scherm: 'financien', focus: 'tab:advies' } } };
  if (typeof a.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.deadline)) p.deadline = a.deadline;
  return p;
}
// per advies-id de stand op Davids lijst, uit de open/onlangs gesloten punten (mk_voor_jou_lijst) en het eigen geheugen van de tikken
// (bewaard = { id: { op } }). Een tik zonder punt in de lijst (nog niet gelezen, of ouder dan 7 dagen gesloten): 'gezet'.
function opLijst(bewaard, punten) {
  const uit = {};
  const per = new Map();
  (Array.isArray(punten) ? punten : []).forEach(function (p) { if (p && typeof p.sleutel === 'string') per.set(p.sleutel, p); });
  Object.keys(bewaard && typeof bewaard === 'object' ? bewaard : {}).forEach(function (id) {
    if (!ID_RE.test(id)) return;
    const p = per.get(oppakSleutel(id));
    const st = p ? (p.status === 'open' || p.status === 'later' ? 'open' : 'gedaan') : 'gezet';
    uit[id] = { stand: st, vanaf: p && typeof p.toon_vanaf === 'string' ? p.toon_vanaf : null };
  });
  return uit;
}

module.exports = { sleutels: sleutels, signaalSleutel: signaalSleutel, tel: tel, geldigeLijst: geldigeLijst, oppakSleutel: oppakSleutel, oppakKaart: oppakKaart, opLijst: opLijst, ID_RE: ID_RE };
