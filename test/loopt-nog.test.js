'use strict';
// wv4130 (3C157): Loopt nog — verdeling in drie groepen, telling scherm = telling tabellen, elke open regel heeft afweging en kijkdag.
// Verzonnen toetsdata (geen echte namen). Gebruik: node test/loopt-nog.test.js [pad/naar/loopt-nog.js]  (kruisproef: een oude kopie)
const path = require('path');
const L = require(process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'loopt-nog.js'));
let goed = 0, fout = 0;
function is(naam, ok) { if (ok) goed++; else { fout++; console.log('ROOD ' + naam); } }
const V = '2026-11-27';
const tab = {
  actie: [
    { actie_id: 'a1', actie: 'Offerte vergelijken', eigenaar: 'David', status: 'open', bevinding: 'eerste ronde 1-11 | 20-11: nog niets gezien. Kijkt 30-11.', volgende_check: '2026-11-30', deadline: '2026-12-05' },
    { actie_id: 'a2', actie: 'Rooster sturen', eigenaar: 'David (als praktijkhouder)', status: 'open', bevinding: 'nog niet gezien', volgende_check: '2026-12-01' },
    { actie_id: 'a3', actie: 'Notulen rondsturen', eigenaar: 'Testpersoon Een', status: 'open', bevinding: 'wacht op notulen', volgende_check: '2026-12-02' },
    { actie_id: 'a4', actie: 'Factuur nakijken', eigenaar: 'Testpersoon Twee', status: 'gemeld', bevinding: 'na geduld niets; gemeld', volgende_check: '2026-11-20', gemeld_op: '2026-11-19' },
    { actie_id: 'a5', actie: 'Oud klusje', eigenaar: 'David', status: 'afgerond', bevinding: 'klaar', laatst_gecheckt: '2026-11-25' },
    { actie_id: 'a6', actie: 'Heel oud', eigenaar: 'David', status: 'afgerond', bevinding: 'klaar', laatst_gecheckt: '2026-10-01' },
    { actie_id: 'a7', actie: 'Losgelaten', eigenaar: 'Davidse', status: 'genegeerd', bevinding: 'hoeft niet', laatst_gecheckt: '2026-11-20' },
    { actie_id: 'a8', actie: 'Rare status', eigenaar: 'David', status: 'groen', bevinding: 'x' }
  ],
  correspondentie: [
    { thread_id: 'abc123def4567890', onderwerp: 'Vraag over huur', tegenpartij: 'Verhuurder Test', type: 'wacht_op_antwoord', status: 'wacht', bevinding: 'verzonden 10-11 || 20-11: nog geen antwoord', volgende_check: '2026-12-01' },
    { thread_id: 'abc123def4567891', onderwerp: 'Ik kom erop terug', tegenpartij: 'Collega Test', type: 'belofte_david', status: 'wacht', bevinding: 'belofte 12-11', volgende_check: '2026-11-28' },
    { thread_id: 'abc123def4567892', onderwerp: 'Rappel', tegenpartij: 'Leverancier Test', type: 'wacht_op_antwoord', status: 'gemeld', bevinding: 'gemeld 20-11', volgende_check: '2026-11-27', bron: 'doktersmaten' }
  ],
  agenda: [
    { event_id: 'e1', titel: 'Etentje', kalender: 'Gezin', start: '2026-12-10T19:00:00', status: 'wacht', bevinding: 'onbevestigd', volgende_check: '2026-12-09' },
    { event_id: 'e2', titel: 'Tandarts', kalender: 'David', start: '2026-12-03', status: 'groen', bevinding: 'ok' },
    { event_id: 'e3', titel: 'Oude afspraak', kalender: 'David', start: '2026-11-01', status: 'groen', bevinding: 'ok' },
    { event_id: 'e4', titel: 'Reis', kalender: 'David', start: '2026-12-20', status: 'gemeld', bevinding: 'geen boeking ‖ 26-11 David (app): Ik kijk er zelf naar', volgende_check: '2026-11-29' }
  ],
  personeel: [
    { item_id: '_meta_scan', type: 'meta', status: 'groen', bevinding: 'scan', volgende_check: '2026-12-01' },
    { item_id: 'test-een-contract_retour-2026-12-01', medewerker: 'Test Een', type: 'contract_retour', omschrijving: 'Contract retour', status: 'wacht', bevinding: 'verzonden 20-11', volgende_check: '2026-12-04', uiterlijk: '2026-11-24' },
    { item_id: 'test-twee-gesprek-2026', medewerker: 'Test Twee', type: 'gesprek', omschrijving: 'Jaargesprek', status: 'gemeld', bevinding: 'gemeld', volgende_check: '2026-12-10' },
    { item_id: 'test-drie-contract_einde-2027', medewerker: 'Test Drie', type: 'contract_einde', omschrijving: 'Contract tot 2027', status: 'groen', bevinding: 'loopt tot 2027', volgende_check: '2026-12-27' }
  ]
};
const u = L.verdeel(tab, V);
const g = u.groepen;
const ids = (l) => l.map((x) => x.sleutel).sort().join(',');
is('jij = David-acties, gemeld, belofte, gemeld agenda/personeel', ids(g.jij) === ['a1', 'a2', 'a4', 'abc123def4567891', 'abc123def4567892', 'e4', 'test-twee-gesprek-2026'].sort().join(','));
is('anderen = actie bij ander, wacht op antwoord, agenda wacht, personeel wacht', ids(g.anderen) === ['a3', 'abc123def4567890', 'e1', 'test-een-contract_retour-2026-12-01'].sort().join(','));
is('rond = afgerond/genegeerd binnen 14 dagen', ids(g.rond) === ['a5', 'a7'].join(','));
is('in orde = personeel groen (geen meta)', ids(g.in_orde) === 'test-drie-contract_einde-2027');
is('agenda groen: alleen het aantal vanaf vandaag', u.agenda_in_orde === 1);
is('Davidse is niet David', !L.isDavid('Davidse') && L.isDavid('David (en X)') && L.isDavid('david'));
is('wv4132: collega die David heet = ander', !L.isDavid('David Jansen') && L.isDavid('David / Ilse') && L.isDavid('David en Karin') && L.isDavid(' David '));
// telling scherm = telling tabellen: per wachter tellen alle rijen precies één keer
for (const w of ['actie', 'correspondentie', 'agenda', 'personeel']) {
  const t = u.tellingen[w];
  is('telling sluit ' + w, t.jij + t.anderen + t.rond + t.in_orde + t.niet_getoond === tab[w].length && t.rijen === tab[w].length);
  const open = tab[w].filter((r) => L.OPEN[w].includes(r.status)).length;
  is('open = jij + anderen ' + w, t.jij + t.anderen === open);
}
is('open totaal', u.open === g.jij.length + g.anderen.length && u.open === 11);
// elke open regel heeft afweging en kijkdag; laatste stuk van de bevinding
for (const x of g.jij.concat(g.anderen, g.in_orde)) is('afweging + kijkdag ' + x.sleutel, !!x.afweging && /^\d{4}-\d{2}-\d{2}$/.test(x.kijkt || ''));
is('laatste afweging na |', g.jij.find((x) => x.sleutel === 'a1').afweging === '20-11: nog niets gezien. Kijkt 30-11.');
is('laatste afweging na ||', g.anderen.find((x) => x.sleutel === 'abc123def4567890').afweging === '20-11: nog geen antwoord');
is('laatste afweging na ‖', g.jij.find((x) => x.sleutel === 'e4').afweging === '26-11 David (app): Ik kijk er zelf naar');
is('kijkdag voorbij gemerkt', g.jij.find((x) => x.sleutel === 'a4').kijkt_voorbij === true && g.jij.find((x) => x.sleutel === 'a1').kijkt_voorbij === false);
is('rond heeft geen kijkdag', g.rond.every((x) => x.kijkt === null));
is('maillink alleen buiten doktersmaten', g.anderen.find((x) => x.sleutel === 'abc123def4567890').link === 'https://mail.google.com/mail/u/0/#all/abc123def4567890' && g.jij.find((x) => x.sleutel === 'abc123def4567892').link === null);
is('volgorde: uiterlijk eerst', g.anderen[0].sleutel === 'test-een-contract_retour-2026-12-01');
const lang = L.laatsteAfweging('x'.repeat(30) + ' ' + 'woord '.repeat(200));
is('lange afweging ingekort', lang.length <= 422 && / …$/.test(lang));
// een tabel die niet te lezen is
const u2 = L.verdeel(Object.assign({}, tab, { agenda: null }), V);
is('fout per tabel', u2.fouten.join() === 'agenda' && u2.tellingen.agenda === null && u2.groepen.jij.every((x) => x.wachter !== 'agenda'));
console.log((fout ? 'ROOD' : 'GROEN') + ' loopt-nog ' + goed + '/' + fout);
process.exit(fout ? 1 : 0);
