'use strict';
// wv3742: toets voor zoek-overal.js met nep-bronnen (verzonnen data). node test/zoek-overal.js
const path = require('path');
const ZO = require(path.join(__dirname, '..', 'zoek-overal.js'));
let goed = 0, fout = 0;
const ok = function (c, t) { if (c) goed++; else { fout++; console.log('ROOD: ' + t); } };
const NU = Date.parse('2026-11-21T12:00:00Z');

const bronnen = {
  contacten: async function (q) { return { ok: true, treffers: [
    { weergavenaam: 'Kees Proefmans', organisatie: 'Proefbouw BV', telefoon_primair: '+31 6 12345678', email_primair: 'kees@proefbouw.example', resource_name: 'people/c123' },
    { weergavenaam: 'Anja Ander', telefoon_primair: '+31 6 87654321' }] }; },
  agenda: async function () { return [
    { event_id: 1, titel: 'Overleg Proefbouw', begin_datum: '2026-11-25', begin_tijd: '2026-11-25T09:00:00Z', eind_tijd: '2026-11-25T10:00:00Z', hele_dag: false, voor_wie: 'david' },
    { event_id: 2, titel: 'Overleg Proefbouw', begin_datum: '2026-10-01', begin_tijd: '2026-10-01T07:00:00Z', eind_tijd: '2026-10-01T08:00:00Z', hele_dag: false, voor_wie: 'david' },
    { event_id: 3, titel: 'Tandarts', begin_datum: '2026-12-01', voor_wie: 'gezin', entiteiten: [{ naam: 'Proefbouw BV' }] }]; },
  gesprekken: async function (term) {
    if (term === 'proefbouw') return { totaal: 2, treffers: [
      { kanaal: 'hoofd', t: '2026-11-20T10:00:00Z', job_id: 'abc123def4567890', bel: 'socev', fragment: { voor: 'over ', treffer: 'Proefbouw', na: ' gesproken' } },
      { kanaal: 'machinekamer', t: '2026-11-21T09:00:00Z', job_id: '0123456789abcdef', bel: 'david', fragment: { voor: '', treffer: 'Proefbouw', na: ' nieuw' } }] };
    return { totaal: 0, treffers: [] };
  },
  facturen: function (w) { return [
    { id: 'f1', leverancier_naam: 'Proefbouw BV', nummer: 'PB-2026-01', factuurdatum: '2026-10-01', incl_eur: 12100, soort: 'factuur' },
    { id: 'f2', leverancier_naam: 'Proefbouw BV', nummer: 'PB-2026-02', factuurdatum: '2026-11-01', incl_eur: 5495, soort: 'factuur' },
    { id: 'f3', leverancier_naam: 'Iets Anders', nummer: 'X', factuurdatum: '2026-11-10', incl_eur: 100 }]; },
  bank: async function () { return { ok: true, posten: [
    { datum: '2026-11-02', bedrag: -54.95, tegenpartij: 'Proefbouw BV', omschrijving: 'factuur PB-2026-02', rekening: 'ABN' },
    { datum: '2026-10-02', bedrag: -121, tegenpartij: 'Proefbouw BV', omschrijving: '', rekening: 'ABN' }] }; },
  pakjes: function () { return { status: 200, body: { ok: true, lopend: [], eerder: [] } }; },
};
const z = ZO.maak({ bronnen: bronnen, nu: function () { return NU; } });

(async function () {
  // kernwoorden: bron- en vraagwoorden eruit
  ok(JSON.stringify(ZO.kernwoorden('wat is het telefoonnummer van Kees Proefmans')) === '["kees","proefmans"]', 'kernwoorden telefoonvraag');
  ok(JSON.stringify(ZO.kernwoorden('factuur van Proefbouw')) === '["proefbouw"]', 'kernwoorden factuurvraag');
  ok(ZO.kernwoorden('wanneer is de volgende afspraak').length === 0, 'te algemeen: geen kernwoord');

  const r = await z.zoek('Proefbouw', {});
  const per = {}; r.bronnen.forEach(function (x) { per[x.bron] = x; });
  ok(r.bronnen.length === 7 && ZO.BRONNEN.every(function (b) { return per[b]; }), 'alle zeven bronnen genoemd');
  ok(per.contacten.stand === 'gevonden' && /Kees Proefmans/.test(per.contacten.kaart.titel) && per.contacten.kaart.doel.url === 'https://contacts.google.com/person/c123', 'contacten: kaart + link (organisatie telt)');
  ok(per.agenda.stand === 'gevonden' && per.agenda.aantal === 3 && /25-11-2026 10:00/.test(per.agenda.kaart.regel) && per.agenda.kaart.doel.app === 'kalender', 'agenda: eerstvolgende');
  ok(per.gesprekken.stand === 'gevonden' && per.gesprekken.kaart.doel.job_id === '0123456789abcdef' && per.gesprekken.kaart.doel.kanaal === 'machinekamer', 'gesprekken: nieuwste');
  ok(per.facturen.stand === 'gevonden' && per.facturen.aantal === 2 && per.facturen.kaart.doel.id === 'f2' && /54,95/.test(per.facturen.kaart.regel), 'facturen: nieuwste + bedrag');
  ok(per.bank.stand === 'gevonden' && /− € 54,95/.test(per.bank.kaart.regel) && per.bank.kaart.doel.app === 'financien', 'bank: nieuwste + bedrag');
  ok(per.pakjes.stand === 'niets', 'pakjes: niets');
  ok(per.mail.stand === 'op_tik' && per.mail.kaart.doel.soort === 'mail' && per.mail.kaart.doel.q === 'proefbouw', 'mail: pas op tik, met kernwoorden');

  // uitgezet, kapot, traag
  const z2 = ZO.maak({ nu: Date.now, bronnen: Object.assign({}, bronnen, {
    bank: async function () { throw new Error('kapot'); },
    facturen: function () { return new Promise(function (k) { setTimeout(function () { k([]); }, 400); }); },
    pakjes: null }) });
  const t0 = Date.now();
  const r2 = await z2.zoek('Proefbouw', { uit: ['contacten'], ms: { facturen: 100 } });
  const p2 = {}; r2.bronnen.forEach(function (x) { p2[x.bron] = x; });
  ok(p2.contacten.stand === 'uit', 'uitgezette bron = uit, bij naam');
  ok(p2.bank.stand === 'niet_bereikt', 'storing = niet bereikt');
  ok(p2.facturen.stand === 'niet_bereikt' && Date.now() - t0 < 350, 'time-out = niet bereikt, wacht niet');
  ok(p2.pakjes.stand === 'uit', 'niet ingerichte bron = uit');

  // tweede woord moet ook passen
  const r3 = await z.zoek('Proefbouw Ander', {});
  const p3 = {}; r3.bronnen.forEach(function (x) { p3[x.bron] = x; });
  ok(p3.facturen.stand === 'niets' && p3.bank.stand === 'niets', 'alle kernwoorden moeten passen');
  ok(p3.gesprekken.stand === 'gevonden' && /op "proefbouw"/.test(p3.gesprekken.kaart.regel), 'gesprekken: terugval op het langste woord, gezegd');

  const r4 = await z.zoek('wanneer is de volgende afspraak', {});
  ok(r4.bronnen.every(function (x) { return x.stand === 'te_algemeen'; }), 'te algemeen: geen bron bevraagd');

  console.log('zoek-overal: ' + goed + ' goed, ' + fout + ' rood');
  process.exit(fout ? 1 : 0);
})();
