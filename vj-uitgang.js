'use strict';
// wv4194 (besluitenpagina nr 317 = 3C17 en nr 384 = 3C84, David Ja 25-11-2026 22:29/22:30): de nieuwe uitgangen van een Voor jou-kaart.
// Puur (geen io): de pod geeft klok, jobs en het bestand mee.
//  - Niet nu › Vanavond: de kaart blijft open en komt om 20:00 terug (na 20:00: een uur later); vanaf 22:00 geen Vanavond meer (dan
//    Morgen), zodat hij nooit in de stille uren 23–07 terugkomt.
//  - Gedaan, met opmerking / Lukt niet / Doe jij het: lopen via POST /app/anders (de beurt die Anders toch al start) met uitgang.
//    Lukt niet: kaart open, stand "Socev kijkt ernaar" zolang die beurt loopt. Doe jij het: kaart uit Davids lijst zolang die beurt
//    loopt; daarna dicht (Socev zette hem dicht) of terug in de lijst met "terug van Socev".
const M = require('./vj-moment.js');

const UITGANGEN = ['opmerking', 'lukt_niet', 'doe_jij'];
const BEWAAR_MS = 2 * 24 * 3600 * 1000;   // daarna vergeten we de uitgang (de kaart is dan allang verder)
const VANAVOND_UUR = 20, VANAVOND_LAATST = 22;   // tikken na 22:00 = geen Vanavond (stille uren vanaf 23:00)
const WACHT_DAGEN = [2, 7, 14];

function nlDelen(t) {
  const d = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(t)).forEach(function (x) { if (x.type !== 'literal') d[x.type] = Number(x.value); });
  return d;
}
// Wanneer komt een kaart met "Vanavond" terug? null = kan niet meer (vanaf 22:00 Nederlandse tijd; vóór 07:00 = vanavond 20:00)
function vanavondTot(nu) {
  const d = nlDelen(nu);
  if (d.hour >= VANAVOND_LAATST) return null;
  const acht = M.nlMs(d.year, d.month, d.day, VANAVOND_UUR, 0);
  if (nu < acht) return acht;
  // tussen 20 en 22 uur: over een uur, op 5 minuten, en uiterlijk 22:45 (ruim vóór de stille uren)
  return Math.min(Math.ceil((nu + 3600000) / 300000) * 300000, M.nlMs(d.year, d.month, d.day, 22, 45));
}
function klokNL(t) { const d = nlDelen(t); return String(d.hour).padStart(2, '0') + ':' + String(d.minute).padStart(2, '0'); }

// Een bewaarde uitgang {soort, t (ms), job} → wat de app ziet: {soort, t (iso), bezig}; null = vergeten of onbekend
function stand(u, jobStatus, nu) {
  if (!u || UITGANGEN.indexOf(u.soort) < 0 || u.soort === 'opmerking' || !(Number(u.t) > 0) || nu - Number(u.t) > BEWAAR_MS) return null;
  const s = typeof jobStatus === 'function' ? jobStatus(u.job) : null;
  return { soort: u.soort, t: new Date(Number(u.t)).toISOString(), bezig: s === 'pending' || s === 'running' };
}
// Doe jij het en de beurt loopt nog: niet in Davids lijst (en niet in de telling)
function verborgen(st) { return !!(st && st.soort === 'doe_jij' && st.bezig); }
// Opruimen: alles ouder dan BEWAAR_MS weg; geeft true als er iets wegging
function ruim(staat, nu) {
  let weg = false;
  Object.keys(staat || {}).forEach(function (k) { const u = staat[k]; if (!u || !(nu - Number(u.t) <= BEWAAR_MS)) { delete staat[k]; weg = true; } });
  return weg;
}
// Mag deze uitgang op deze kaart? (besluit: nooit; proef: geen Doe jij het). Geeft een foutzin of null.
function magOp(uitgang, soort) {
  if (UITGANGEN.indexOf(uitgang) < 0) return 'ongeldige knop';
  if (soort === 'besluit') return 'een besluit beantwoord je met Ja / Nee / Anders';
  if (uitgang === 'doe_jij' && soort === 'proef') return 'een proef kan alleen jij doen';
  return null;
}
// De kop en de uitleg voor de beurt (Socev of de machinekamer). titel/tijd/kaartRegel komen van de pod (al ontmaskerd).
function beurtTekst(uitgang, o) {
  const toel = o.toelichting ? ' — toelichting: ' + o.toelichting : '';
  const naam = { opmerking: 'GEDAAN, MET OPMERKING', lukt_niet: 'LUKT NIET', doe_jij: 'DOE JIJ HET' }[uitgang];
  const kop = '[KNOP] David koos ' + naam + ' bij de Voor jou-kaart ' + JSON.stringify(o.titel) + toel;
  const begin = '(Knopdruk op de Voor jou-kaart in de app (Overzicht, ' + o.kanaalNaam + ') om ' + o.tijd + '. ';
  let wat;
  if (uitgang === 'opmerking') {
    wat = (o.gedaanWaar ? 'David zette de kaart op Gedaan (net vóór deze opmerking); laat hem dicht tenzij de opmerking iets anders zegt. '
      : 'David koos Gedaan met een opmerking, maar de kaart staat niet op gedaan; behandel hem als open. ') +
      'Lees de opmerking als Davids woorden bij precies deze kaart en neem hem mee (een werkvoorraadrij die op deze kaart wacht krijgt de opmerking erbij). ';
  } else if (uitgang === 'lukt_niet') {
    wat = 'David probeerde wat de kaart vraagt en het lukt niet. De kaart blijft open; in de app staat er "Socev kijkt ernaar" zolang deze beurt loopt. ' +
      'Zoek uit waarom (lees de kaart, de stappen en de klus erachter), los op wat je zelf kunt, en zet de kaart goed: nieuwe stappen in gewone taal (een nieuwe kaart met dezelfde sleutel), ' +
      'of dicht als hij niet meer nodig is. Kun je niet afleiden wat er misging, vraag David dan in één zin wat hij zag. ';
  } else {
    wat = 'David geeft deze kaart terug: hij wil dat jij het doet. Zolang deze beurt loopt staat de kaart niet in zijn lijst. ' +
      'Kan het binnen je grenzen (niets naar buiten, geen geld, geen credentials, Grondwet-kern), doe het dan, of zet het als klus in de werkvoorraad (een rij die op deze kaart wacht: geef hem vrij met deze keuze erbij); ' +
      'zet de kaart daarna dicht met bewijs (python3 /opt/data/mk-scripts/voor-jou.py status --sleutel <sleutel> --van open --naar gedaan --door agent --bewijs "<wat je deed of welke klus het oppakt>"). ' +
      'Kan het echt niet zonder David (zijn vingerafdruk, een apparaat, versturen, betalen), laat de kaart dan open en zeg in één zin waarom: hij komt na deze beurt vanzelf terug in zijn lijst. ';
  }
  return { kop: kop, ctx: begin + wat + o.kaartRegel + ' Antwoord David kort in dit gesprek.)' };
}

module.exports = { UITGANGEN: UITGANGEN, BEWAAR_MS: BEWAAR_MS, WACHT_DAGEN: WACHT_DAGEN, VANAVOND_LAATST: VANAVOND_LAATST,
  vanavondTot: vanavondTot, klokNL: klokNL, stand: stand, verborgen: verborgen, ruim: ruim, magOp: magOp, beurtTekst: beurtTekst };
