'use strict';
// wv4121 (besluitenpagina nr 316 = 3C16, David Ja 25-11-2026 22:00): het seintje op het vergrendelscherm zegt wat voor soort het
// is, nog steeds zonder inhoud. De push zelf blijft leeg (bouwplan § 4.6); de pod onthoudt per apparaat welk soort hij net stuurde,
// en de service worker haalt dat op bij de stand die hij toch al vraagt (GET /app/seintje-stand, 4 s). Alleen een vast woord uit
// SOORTEN gaat over de lijn; de tekst bij elk woord staat in de service worker. Lukt het ophalen niet, dan de zin van vroeger.
//
// Waarom alle soorten en niet alleen het laatste: alle pushes hebben Topic socev, dus de pushdienst vervangt een nog niet
// bezorgde push door de volgende. Een vraag en daarna een rapport kunnen zo als één push binnenkomen; dan moet de service worker
// beide soorten horen, anders overschrijft het rapport de vraag alsnog.

const SOORTEN = ['vraag', 'storing', 'machinekamer', 'antwoord'];   // volgorde = voorrang bij tonen
const BEWAAR_MS = 6 * 3600 * 1000;   // = APP_PUSH_TTL_S: langer houdt de pushdienst een seintje ook niet vast

function geldig(s) { return SOORTEN.indexOf(s) >= 0; }

// Een antwoord op Davids eigen beurt (appPushNaBeurt): machinekamer en OVIS Code = "Machinekamer klaar" (bouwwerk), een vraag
// in het hoofdkanaal = "Vraag voor je" (machinekamervragen zoemen niet, bouwplan § 7-3), al het andere = "Antwoord van Socev klaar".
function soortVanBeurt(kanaal, vraag) {
  const k = String(kanaal || '');
  if (k === 'machinekamer' || /^code-/.test(k)) return 'machinekamer';
  if (vraag && k === 'hoofd') return 'vraag';
  return 'antwoord';
}

// Een bundel berichten via /bericht (berichtPushNu): rijen uit de berichtenindex ({soort, klasse, bron}). Een vraag of agendaknop
// gaat voor; een dringend bericht dat geen vraag is (de tussenregel van meldSoort: storingsalarm) of de Stiltewachter = storing.
function soortVanBerichten(kanaal, rijen) {
  const k = String(kanaal || '');
  if (k === 'machinekamer' || /^code-/.test(k)) return 'machinekamer';
  const r = (rijen || []).filter(Boolean);
  if (r.some(function (x) { return x.soort === 'vraag'; })) return k === 'hoofd' ? 'vraag' : 'antwoord';
  if (r.some(function (x) { return x.klasse === 'dringend' || x.bron === 'stiltewachter-david'; })) return 'storing';
  return 'antwoord';
}

// Vlak vóór de push: het soort onthouden (vóór de fetch, want de service worker kan de stand al vragen voordat de pushdienst
// antwoordt). Eén registratie per soort (Codex MOET 1: twintig antwoorden verdringen een vraag niet) met een oplopend volgnummer
// als cursor (Codex MOET 2: geen gelijke milliseconden). st = { n, gehaald, jongste, per: { soort: { op, n } } }; geeft st terug.
function noteer(st, soort, nu) {
  st = st && typeof st === 'object' ? st : {};
  if (!st.per || typeof st.per !== 'object') st.per = {};
  if (typeof st.n !== 'number') st.n = 0;
  if (typeof st.gehaald !== 'number') st.gehaald = 0;
  if (geldig(soort)) { st.n += 1; st.per[soort] = { op: nu, n: st.n }; st.jongste = soort; }
  return st;
}

// De service worker vraagt de stand: alle soorten die sinds zijn vorige vraag zijn verstuurd (op voorrang, elk één keer). Niets
// nieuws (dezelfde push nog eens, of een poets-push terwijl er nog iets ongezien is) = het jongste soort met herhaal (zonder zoem).
// Niets bekend (pod herstart, alleen een proef) = lege lijst: de service worker toont dan de zin van vroeger.
function haal(st, nu) {
  if (!st || !st.per || typeof st.per !== 'object') return { soorten: [], herhaal: false };
  const vers = SOORTEN.filter(function (s) { const x = st.per[s]; return x && typeof x.op === 'number' && nu - x.op < BEWAAR_MS; });
  const nieuw = vers.filter(function (s) { return st.per[s].n > (st.gehaald || 0); });
  st.gehaald = typeof st.n === 'number' ? st.n : 0;
  if (nieuw.length) return { soorten: nieuw, herhaal: false };
  if (vers.indexOf(st.jongste) >= 0) return { soorten: [st.jongste], herhaal: true };
  return { soorten: [], herhaal: false };
}

module.exports = { SOORTEN, BEWAAR_MS, geldig, soortVanBeurt, soortVanBerichten, noteer, haal };
