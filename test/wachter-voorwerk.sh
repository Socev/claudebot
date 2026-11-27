#!/usr/bin/env bash
# wv4189 (3C160): voorwerk bij een wachtermelding — wachter-voorwerk.js + de koppeling in wachter-kaarten.js, met nep-io en verzonnen rijen
# (geen echte personen, winkels, agenda of mail). Per soort een proefactie: kaart met resultaat en knoppen; niets gekocht, verstuurd of gepland
# (de nep-io heeft geen route om te kopen, versturen of plannen; de agent wordt niet echt gestart). Tweede nacht geen tweede agent.
set -euo pipefail
cd "$(dirname "$0")/.."
node - <<'JS'
'use strict';
const VW = require('./wachter-voorwerk.js');
const M = require('./wachter-kaarten.js');
let goed = 0, fout = 0;
function t(naam, ok, info) { if (ok) { goed++; console.log('GROEN ' + naam); } else { fout++; console.log('ROOD  ' + naam + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); } }
const V = '2026-11-26';   // donderdag

// ── puur: de vraag ──
t('vraag: onbekende soort', !!VW.toetsVraag('actie', { soort: 'kopen', wat: 'iets wat lang genoeg is' }).fout);
t('vraag: personeel nooit bericht', /past niet/.test(VW.toetsVraag('personeel', { soort: 'bericht', wat: 'conceptmail aan iemand', draad: 'abcdef0123456789' }).fout || ''));
t('vraag: mailwachter geen aanschaf', !!VW.toetsVraag('correspondentie', { soort: 'aanschaf', wat: 'drie proefopties zoeken' }).fout);
t('vraag: wat te kort', !!VW.toetsVraag('actie', { soort: 'bellen', wat: 'bel' }).fout);
t('vraag: link in wat geweigerd', !!VW.toetsVraag('actie', { soort: 'aanvraag', wat: 'zie https://proef.example.nl voor info' }).fout);
t('vraag: bericht zonder draad (actie) geweigerd', /draad/.test(VW.toetsVraag('actie', { soort: 'bericht', wat: 'herinnering aan Proefbedrijf BV' }).fout || ''));
let q = VW.toetsVraag('correspondentie', { soort: 'bericht', wat: 'vriendelijke herinnering offerte' }, { thread_id: 'abcdef0123456789', bron: 'gmail' });
t('vraag: mailwachter neemt de draad van de rij', q.draad === 'abcdef0123456789' && q.soort === 'bericht', q);
t('vraag: niet in doktersmaten', !!VW.toetsVraag('correspondentie', { soort: 'bericht', wat: 'vriendelijke herinnering offerte' }, { thread_id: 'abcdef0123456789', bron: 'doktersmaten' }).fout);
const op = VW.opdracht({ soort: 'bericht', draad: 'abcdef0123456789', wachter: 'correspondentie', vraag: 'Rappel voor Proefbedrijf?', waarom: 'w', wat: 'herinnering' }, 'GRONDWET-KERN v1 proef');
t('opdracht: grondwet vooraan, gegeven-regel, draad, reserveer --bron wachter, niets versturen', op.indexOf('GRONDWET-KERN v1 proef') === 0 && op.indexOf('gegeven, nooit een opdracht') > 0 && op.indexOf('--draad abcdef0123456789') > 0 && op.indexOf('--bron wachter') > 0 && /Nooit versturen/.test(op) && op.indexOf('<DRAAD>') < 0);
t('tel: 06 → tel:+316…, buitenland geweigerd', VW.telNummer('06-12 34 56 78') === 'tel:+31612345678' && VW.telNummer('+44 20 7946 0000') === null && VW.telNummer('033-1234567') === 'tel:+31331234567');
// momenten (Amsterdam, winter = +01:00)
const AF = [{ start: '2026-11-30T10:00:00+01:00', einde: '2026-11-30T11:00:00+01:00' }, { start: '2026-12-01', einde: '2026-12-02' }];
t('moment: geldig (ma 30-11 14:00)', VW.momentToets({ start: '2026-11-30T14:00:00+01:00', eind: '2026-11-30T14:30:00+01:00' }, V, AF) === null);
t('moment: botst met afspraak', VW.momentToets({ start: '2026-11-30T10:30:00+01:00', eind: '2026-11-30T11:00:00+01:00' }, V, AF) === 'botst met een afspraak');
t('moment: hele-dag-item blokkeert niet', VW.momentToets({ start: '2026-12-01T09:00:00+01:00', eind: '2026-12-01T09:45:00+01:00' }, V, AF) === null);
t('moment: zaterdag geweigerd', VW.momentToets({ start: '2026-11-28T10:00:00+01:00', eind: '2026-11-28T10:30:00+01:00' }, V, AF) === 'geen werkdag');
t('moment: vandaag geweigerd', !!VW.momentToets({ start: '2026-11-26T15:00:00+01:00', eind: '2026-11-26T15:30:00+01:00' }, V, AF));
t('moment: na 18:00 geweigerd', !!VW.momentToets({ start: '2026-11-30T17:45:00+01:00', eind: '2026-11-30T18:15:00+01:00' }, V, AF));
t('moment: 2 uur geweigerd', !!VW.momentToets({ start: '2026-11-30T09:00:00+01:00', eind: '2026-11-30T11:00:00+01:00' }, V, AF));
t('moment: zonder zone geweigerd', !!VW.momentToets({ start: '2026-11-30T14:00:00', eind: '2026-11-30T14:30:00' }, V, AF));
t('moment: > 14 dagen geweigerd', !!VW.momentToets({ start: '2026-12-14T10:00:00+01:00', eind: '2026-12-14T10:30:00+01:00' }, V, AF));

// ── met io: de hele weg per soort ──
function wereld() {
  const W = { klok: '04:00', datum: V, nu: Date.parse(V + 'T03:00:00Z'), staat: null, tabel: { actie: {}, correspondentie: {}, agenda: {}, personeel: {} }, lijstje: {}, kaarten: {},
    logs: [], starts: [], startAntwoord: null, agents: {}, winkels: {}, agendaFout: false, concepten: {}, gw: 'GRONDWET-KERN v1 proef' };
  const io = { nu: function () { return W.nu; }, datum: function () { return W.datum; }, klok: function () { return W.klok; },
    lees: function () { return W.staat ? JSON.parse(JSON.stringify(W.staat)) : null; }, schrijf: function (s) { W.staat = JSON.parse(JSON.stringify(s)); },
    rij: async function (w, s) { return W.tabel[w][s] ? Object.assign({}, W.tabel[w][s]) : null; },
    werk: async function (w, s, g, data) { const r = W.tabel[w][s]; if (!r || r.status !== g.status) return { n: 0 }; Object.assign(r, data); return { n: 1 }; },
    inLijstje: async function (w, s, d) { return !!W.lijstje[w + '|' + s + '|' + d]; },
    rpc: async function (naam, a) {
      if (naam === 'mk_voor_jou_zet') { W.kaarten[a.p.sleutel] = Object.assign({ status: 'open' }, a.p); return { sleutel: a.p.sleutel }; }
      if (naam === 'mk_voor_jou_status') { const c = W.kaarten[a.p_sleutel]; if (!c || c.status !== a.p_van) return { ok: false }; c.status = a.p_naar; return { ok: true }; }
      if (naam === 'mk_voor_jou_lijst') return { punten: Object.keys(W.kaarten).map(function (s) { return Object.assign({ sleutel: s }, W.kaarten[s]); }) };
      throw new Error('onbekend ' + naam);
    }, log: function (o) { W.logs.push(o); },
    startAgent: async function (prompt, ref) { if (W.startAntwoord) return W.startAntwoord; const job = 'job' + (W.starts.length + 1); W.starts.push({ prompt: prompt, ref: ref, job: job }); W.agents[job] = 'loopt'; return { ok: true, job_id: job }; },
    agentStand: function (job) { return W.agents[job] || null; },
    grondwet: function () { return W.gw; },
    winkel: async function (url) { return W.winkels[url] || null; },
    agenda: async function () { if (W.agendaFout) throw new Error('luik weg'); return AF; },
    conceptNa: function (draad) { return !!W.concepten[draad]; },
    masker: function (x) { return x; } };
  return { W: W, A: M.maak(io) };
}
function melding(rij, soort, wat, extra) { return Object.assign({ rij: rij, vraag: 'SOCEV PROEF: wat doen we met ' + rij + '?', waarom: 'proef', knoppen: ['gedaan', 'week', 'vallen'], voorwerk: Object.assign({ soort: soort, wat: wat }, extra || {}) }); }
async function afloopVan(W, A, i, inhoud) { const s = W.starts[i]; W.agents[s.job] = 'klaar'; return A.voorwerkAfloop(s.ref, { ok: true, inhoud: JSON.stringify(inhoud) }); }

(async function () {
  let { W, A } = wereld();
  ['a1', 'a2', 'a3', 'a4'].forEach(function (r) { W.tabel.actie[r] = { actie_id: r, status: 'gemeld', bevinding: '' }; });
  W.tabel.correspondentie.abcdef0123456789 = { thread_id: 'abcdef0123456789', status: 'gemeld', bevinding: '', bron: 'gmail' };
  W.tabel.agenda.g1 = { event_id: 'g1', status: 'gemeld', bevinding: '' };
  W.tabel.personeel.p1 = { item_id: 'p1', status: 'gemeld', bevinding: '' };
  // nacht 1: actie-bewaker vraagt drie keer voorwerk, de vierde valt boven het plafond
  let z = await A.zet('actie', [melding('a1', 'aanschaf', 'drie opties voor een proefstoel'), melding('a2', 'bellen', 'nummer van Proefbedrijf BV'),
    melding('a3', 'aanvraag', 'portaal voor een proefvergunning')]);
  t('zet: drie keer voorwerk komt', z.gezet.length === 3 && z.voorwerk.length === 3 && z.voorwerk.every(function (x) { return x.uitkomst === 'komt'; }), z);
  z = await A.zet('correspondentie', [Object.assign(melding('abcdef0123456789', 'bericht', 'vriendelijke herinnering offerte'), { knoppen: ['herinnering', 'vallen'] })]);
  t('zet: vierde in dezelfde nacht = vol (melding zelf gaat door)', z.gezet.length === 1 && z.voorwerk[0].uitkomst === 'vol', z);
  z = await A.zet('personeel', [Object.assign(melding('p1', 'bericht', 'conceptmail aan een proefmedewerker'), { knoppen: ['geregeld', 'vallen'] })]);
  t('zet: personeel bericht = fout op het voorwerk, melding gaat door', z.gezet.length === 1 && /past niet/.test(z.voorwerk[0].fout || ''), z);
  t('staat: voorwerk_vraag niet in de ingang', W.staat.ingangen['actie|a1'] && !('voorwerk_vraag' in W.staat.ingangen['actie|a1']));
  // starten: één per tik, hooguit twee tegelijk
  let u = await A.voorwerkStap();
  t('stap: één start per tik', u.gestart === 1 && W.starts.length === 1);
  await A.voorwerkStap(); u = await A.voorwerkStap();
  t('stap: hooguit twee tegelijk', W.starts.length === 2 && u.gestart === 0, u);
  t('opdracht: aanschaf noemt ovis-shopper en geen prijzen overnemen', /ovis-shopper/.test(W.starts[0].prompt) && /Prijzen, verzending en levertijd leest de pod zelf/.test(W.starts[0].prompt));
  // aanschaf: prijzen alleen van de winkelpagina
  W.winkels['https://proefwinkel-a.example/stoel-1'] = { prijs_eur: 149.95, verzending_eur: 0, levertijd: 'morgen in huis' };
  W.winkels['https://proefwinkel-b.example/stoel-2'] = { blokkade: 'robots' };
  let a = await afloopVan(W, A, 0, { lukte: true, opties: [{ winkel: 'Proefwinkel A', product: 'Proefstoel 1', url: 'https://proefwinkel-a.example/stoel-1', prijs: '€ 1,00' },
    { winkel: 'Proefwinkel B', product: 'Proefstoel 2', url: 'https://proefwinkel-b.example/stoel-2' }, { winkel: 'Nep', product: 'x', url: 'http://onveilig.example/x' }] });
  let vw = W.staat.voorwerk['actie|a1'];
  t('aanschaf: prijs van de pagina, modelprijs genegeerd, http-link weg, blokkade = niet te lezen', a.ok && vw.status === 'klaar' && vw.regels.length === 3 &&
    /€ 149,95, gratis verzending, morgen in huis/.test(vw.regels[1]) && vw.regels.join(' ').indexOf('1,00') < 0 && /prijs niet te lezen/.test(vw.regels[2]) && vw.regels.join(' ').indexOf('onveilig') < 0, vw);
  t('afloop: tweede keer dezelfde ref doet niets', (await afloopVan(W, A, 0, { lukte: true })).ok === false);
  t('afloop: onbekende ref', (await A.voorwerkAfloop('000000000000', { ok: true, inhoud: '{}' })).ok === false);
  // bellen
  await A.voorwerkStap();
  await afloopVan(W, A, 1, { lukte: true, naam: 'Proefbedrijf BV', nummer: '033 123 45 67' });
  t('bellen: tiklink tel:+31', /Bellen met Proefbedrijf BV: tel:\+31331234567/.test((W.staat.voorwerk['actie|a2'].regels || [])[0] || ''), W.staat.voorwerk['actie|a2']);
  await A.voorwerkStap();
  t('stap: derde start na een afloop', W.starts.length === 3);
  // aanvraag
  await afloopVan(W, A, 2, { lukte: true, link: { tekst: 'Proefportaal', url: 'https://portaal.proef.example/aanvraag' }, nodig: ['DigiD', 'kopie proefdocument'] });
  vw = W.staat.voorwerk['actie|a3'];
  t('aanvraag: link + nodig', vw.status === 'klaar' && /Proefportaal: https:\/\/portaal\.proef\.example\/aanvraag/.test(vw.regels[0]) && /Nodig: DigiD; kopie proefdocument/.test(vw.regels[1]), vw);
  // kaart om 06:52: a1 staat ook in het actielijstje, maar heeft voorwerk → toch een kaart; knoppen blijven
  W.lijstje['actie|a1|' + V] = true;
  W.klok = '06:53';
  const ks = await A.kaartStap();
  const ka = Object.keys(W.kaarten).map(function (k) { return W.kaarten[k]; }).find(function (k) { return k.stappen && /^Alvast klaargezet: Koopopties/.test(k.stappen[0]); });
  t('kaart: aanschaf-kaart ondanks actielijstje, voorwerk bovenaan, link in de stap', !!ka && ks.met_voorwerk === 3 && ks.in_lijstje === 0 && ka.stappen.some(function (x) { return x.indexOf('https://proefwinkel-a.example/stoel-1') >= 0; }), { ks: ks, ka: ka });
  const det = A.detail({ sleutel: ka.sleutel });
  t('kaart: knoppen van de wachter erbij', det && det.knoppen.length === 3 && det.knoppen[0].tekst === 'Is gedaan', det);
  t('kaart: lengtes binnen de kaartgrenzen', Object.keys(W.kaarten).every(function (k) { const c = W.kaarten[k]; return c.stappen.length <= 12 && c.stappen.every(function (x) { return x.length <= 400; }); }));
  // tik op de aanschafkaart: wachtertabel bijgewerkt
  const tk = await A.tik(Object.assign({ status: 'open' }, W.kaarten[ka.sleutel], { sleutel: ka.sleutel }), 'week');
  t('tik: werkt zoals zonder voorwerk', tk.ok && W.tabel.actie.a1.volgende_check === '2026-12-03', tk);
  // nacht 2: dezelfde klus vraagt opnieuw → geen tweede agent
  W.datum = '2026-11-27'; W.klok = '04:30'; W.nu += 86400000;
  z = await A.zet('actie', [melding('a1', 'aanschaf', 'drie opties voor een proefstoel')]);   // a1: kaart getikt, rij weer gemeld
  const n0 = W.starts.length;
  await A.voorwerkStap(); await A.voorwerkStap();
  t('nacht 2: zelfde klus = al eerder, geen tweede agent', z.voorwerk[0].uitkomst === 'al eerder' && W.starts.length === n0, { z: z, n: W.starts.length });
  // te laat
  W.klok = '06:20';
  z = await A.zet('agenda', [Object.assign(melding('g1', 'gesprek', 'twee momenten voor een proefoverleg'), { knoppen: ['geregeld', 'zelf'] })]);
  t('zet na 06:10: voorwerk te laat', z.voorwerk[0].uitkomst === 'te laat', z);

  // gesprek + bericht in een eigen wereld
  ({ W, A } = wereld());
  W.tabel.agenda.g1 = { event_id: 'g1', status: 'gemeld', bevinding: '' };
  W.tabel.correspondentie.abcdef0123456789 = { thread_id: 'abcdef0123456789', status: 'gemeld', bevinding: '', bron: 'gmail' };
  W.tabel.personeel.p1 = { item_id: 'p1', status: 'gemeld', bevinding: '' };
  await A.zet('agenda', [Object.assign(melding('g1', 'gesprek', 'twee momenten voor een proefoverleg'), { knoppen: ['geregeld', 'zelf'] })]);
  await A.zet('correspondentie', [Object.assign(melding('abcdef0123456789', 'bericht', 'vriendelijke herinnering offerte'), { knoppen: ['herinnering', 'binnen', 'vallen'] })]);
  await A.voorwerkStap(); await A.voorwerkStap();
  await afloopVan(W, A, 0, { lukte: true, momenten: [{ start: '2026-11-28T10:00:00+01:00', eind: '2026-11-28T10:30:00+01:00' },
    { start: '2026-11-30T10:30:00+01:00', eind: '2026-11-30T11:00:00+01:00' }, { start: '2026-11-30T14:00:00+01:00', eind: '2026-11-30T14:30:00+01:00' },
    { start: '2026-12-02T09:00:00+01:00', eind: '2026-12-02T10:00:00+01:00' }] });
  vw = W.staat.voorwerk['agenda|g1'];
  t('gesprek: weekend en botsing eruit, twee goede over', vw.status === 'klaar' && vw.regels[0] === 'Vrij in je agenda (nog niets gepland): ma 30-11 14:00–14:30 of wo 2-12 09:00–10:00', vw);
  // bericht zonder concept in het register → leeg; met → klaar
  await afloopVan(W, A, 1, { lukte: true });
  t('bericht: geen concept in het register = niets op de kaart', W.staat.voorwerk['correspondentie|abcdef0123456789'].status === 'leeg');
  ({ W, A } = wereld());
  W.tabel.correspondentie.abcdef0123456789 = { thread_id: 'abcdef0123456789', status: 'gemeld', bevinding: '', bron: 'gmail' };
  await A.zet('correspondentie', [Object.assign(melding('abcdef0123456789', 'bericht', 'vriendelijke herinnering offerte'), { knoppen: ['herinnering', 'binnen', 'vallen'] })]);
  await A.voorwerkStap();
  W.concepten.abcdef0123456789 = true;
  await afloopVan(W, A, 0, { lukte: true });
  vw = W.staat.voorwerk['correspondentie|abcdef0123456789'];
  t('bericht: concept in het register = link naar de draad', vw.status === 'klaar' && /Conceptantwoord staat klaar in Gmail \(niet verstuurd\): https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/abcdef0123456789/.test(vw.regels[0]), vw);
  W.klok = '06:53';
  await A.kaartStap();
  const kb = Object.keys(W.kaarten).map(function (k) { return W.kaarten[k]; })[0];
  t('bericht-kaart: voorwerk bovenaan, knoppen herinnering/binnen/vallen', kb && /^Alvast klaargezet: Conceptantwoord/.test(kb.stappen[0]) && A.detail({ sleutel: kb.sleutel }).knoppen.length === 3, kb);
  // agenda onleesbaar → geen momenten
  ({ W, A } = wereld());
  W.tabel.agenda.g1 = { event_id: 'g1', status: 'gemeld', bevinding: '' };
  await A.zet('agenda', [Object.assign(melding('g1', 'gesprek', 'twee momenten voor een proefoverleg'), { knoppen: ['geregeld', 'zelf'] })]);
  await A.voorwerkStap();
  W.agendaFout = true;
  await afloopVan(W, A, 0, { lukte: true, momenten: [{ start: '2026-11-30T14:00:00+01:00', eind: '2026-11-30T14:30:00+01:00' }] });
  t('gesprek: agenda onleesbaar = niets op de kaart', W.staat.voorwerk['agenda|g1'].status === 'leeg');
  // geen plek (429) → blijft wachten, daarna verlopen; geen grondwet → geen start
  ({ W, A } = wereld());
  W.tabel.actie.a1 = { actie_id: 'a1', status: 'gemeld', bevinding: '' };
  await A.zet('actie', [melding('a1', 'bellen', 'nummer van Proefbedrijf BV')]);
  W.gw = null; await A.voorwerkStap();
  t('geen grondwet: geen start', W.starts.length === 0 && W.staat.voorwerk['actie|a1'].status === 'wacht');
  W.gw = 'GRONDWET'; W.startAntwoord = { ok: false, status: 429 }; await A.voorwerkStap();
  t('429: blijft wachten', W.staat.voorwerk['actie|a1'].status === 'wacht');
  W.klok = '06:11'; await A.voorwerkStap();
  t('na 06:10: verlopen (komt niet terug)', W.staat.voorwerk['actie|a1'].status === 'verlopen');
  // agent zonder afloop na 2 uur → mislukt
  ({ W, A } = wereld());
  W.tabel.actie.a1 = { actie_id: 'a1', status: 'gemeld', bevinding: '' };
  await A.zet('actie', [melding('a1', 'bellen', 'nummer van Proefbedrijf BV')]);
  await A.voorwerkStap();
  W.agents.job1 = 'mislukt'; W.nu += 3 * 3600000; await A.voorwerkStap();
  t('kwijt: mislukt na 2 uur zonder afloop', W.staat.voorwerk['actie|a1'].status === 'mislukt');
  t('info: voorwerk-telling', JSON.stringify(A.info().voorwerk) === '{"mislukt":1}', A.info());
  console.log(goed + ' groen, ' + fout + ' rood');
  process.exit(fout ? 1 : 0);
})().catch(function (e) { console.log('ROOD  crash ' + (e && e.stack || e)); process.exit(1); });
JS
