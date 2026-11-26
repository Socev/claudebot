#!/usr/bin/env bash
# wv4124 (3C70): wachter-kaarten.js met nep-io en verzonnen rijen (geen echte personen, geen databank, geen n8n).
# Gevallen: catalogus (onbekende knop, alleen-rust, dubbel, rust-dag grenzen, volgend jaar), lengtes en verboden tekst, rij niet open,
# één ingang per zaak, kaart 06:52 (te vroeg, plafond 5, in het actielijstje, rij intussen dicht, verlopen na 2 dagen, uiterlijk eerst),
# tik (effect per wachter, merk in de bevinding, optimistisch conflict, hervatten na een mislukte kaartsluiting, andere knop geweigerd),
# ronde (algemene Gedaan/Niet meer nodig/Later na de ↩️-tijd doorgegeven, kaart dicht als de wachter de rij sloot).
set -euo pipefail
cd "$(dirname "$0")/.."
node - <<'JS'
'use strict';
const M = require('./wachter-kaarten.js');
let goed = 0, fout = 0;
function t(naam, ok, info) { if (ok) { goed++; console.log('GROEN ' + naam); } else { fout++; console.log('ROOD  ' + naam + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); } }
const V = '2026-11-26';
// puur
let r = M.toets('correspondentie', [{ rij: 'r1', vraag: 'SOCEV PROEF: Rappel voor de offerte van Proefbedrijf?', knoppen: ['herinnering', 'vallen'] }], V);
t('toets: geldige melding', r.goed.length === 1 && r.goed[0].knoppen[0].tot === '2026-12-01', r);
t('toets: onbekende knop', M.toets('personeel', [{ rij: 'x', vraag: 'Proefvraag van genoeg tekens?', knoppen: ['herinnering', 'vallen'] }], V).fouten.length === 1);
t('toets: alleen rust geweigerd', M.toets('actie', [{ rij: 'x', vraag: 'Proefvraag van genoeg tekens?', knoppen: ['week', 'ander'] }], V).fouten[0].fout.indexOf('sluit') > 0);
t('toets: dubbele knop', M.toets('actie', [{ rij: 'x', vraag: 'Proefvraag van genoeg tekens?', knoppen: ['gedaan', 'gedaan'] }], V).fouten.length === 1);
t('toets: 1 knop te weinig', M.toets('actie', [{ rij: 'x', vraag: 'Proefvraag van genoeg tekens?', knoppen: ['gedaan'] }], V).fouten.length === 1);
t('toets: rust-dag vandaag geweigerd', M.toets('actie', [{ rij: 'x', vraag: 'Proefvraag van genoeg tekens?', knoppen: ['gedaan', { id: 'rust', tot: V }] }], V).fouten.length === 1);
t('toets: rust-dag +61 geweigerd', M.toets('actie', [{ rij: 'x', vraag: 'Proefvraag van genoeg tekens?', knoppen: ['gedaan', { id: 'rust', tot: '2027-01-26' }] }], V).fouten.length === 1);
r = M.toets('actie', [{ rij: 'x', vraag: 'Proefvraag van genoeg tekens?', knoppen: ['gedaan', { id: 'rust', tot: '2026-12-07' }] }], V);
t('toets: rust-dag met tekst', r.goed[0].knoppen[1].tekst === 'Laat rusten tot 7-12', r);
r = M.toets('personeel', [{ rij: 'p', vraag: 'Proef: gesprekkenronde dit jaar of in 2027?', knoppen: ['ditjaar', 'volgendjaar', 'vallen'] }], V);
t('toets: naar volgend jaar = 2 jan', r.goed[0].knoppen[1].tot === '2027-01-02', r);
t('toets: vraag te kort', M.toets('actie', [{ rij: 'x', vraag: 'Kort?', knoppen: ['gedaan', 'vallen'] }], V).fouten.length === 1);
t('toets: link in waarom geweigerd', M.toets('actie', [{ rij: 'x', vraag: 'Proefvraag van genoeg tekens?', waarom: 'zie https://x.nl', knoppen: ['gedaan', 'vallen'] }], V).fouten.length === 1);
t('toets: vaultpad geweigerd', M.toets('actie', [{ rij: 'x', vraag: 'Proefvraag [[00_Systeem/X]]?', knoppen: ['gedaan', 'vallen'] }], V).fouten.length === 1);
t('toets: concept alleen mail', M.toets('actie', [{ rij: 'x', vraag: 'Proefvraag van genoeg tekens?', concept: 'Hoi', knoppen: ['gedaan', 'vallen'] }], V).fouten.length === 1);
const d1 = M.rijData('correspondentie', { status: 'gemeld', bevinding: 'oud' }, { tekst: 'Ik bel zelf', effect: 'rust', tot: '2026-12-03' }, V, '[t:abc123]');
t('rijData rust: status blijft, check verzet, merk', !('status' in d1) && d1.volgende_check === '2026-12-03' && d1.geduld_tot === '2026-12-03' && /oud ‖ 26-11 David \(app\): Ik bel zelf .*\[t:abc123\]$/.test(d1.bevinding), d1);
t('rijData klaar → afgerond', M.rijData('actie', { status: 'open', bevinding: '' }, { tekst: 'Is gedaan', effect: 'klaar' }, V, '[t:1]').status === 'afgerond');
t('rijData vallen → genegeerd', M.rijData('agenda', { status: 'gemeld' }, { tekst: 'x', effect: 'vallen' }, V, '[t:1]').status === 'genegeerd');
const k = M.kaartVoor({ wachter: 'correspondentie', rij: 'abcdef0123456789', vraag: 'SOCEV PROEF: rappel voor de offerte?', waarom: 'w', concept: 'Hoi, hoe staat het met de offerte?', knoppen: [] }, { thread_id: 'abcdef0123456789', uiterlijk: '2026-11-30', bron: 'gmail' }, V);
t('kaart: sleutel, lengtes, concept als kopieerblok, maillink, deadline', M.SLEUTEL_RE.test(k.sleutel) && k.titel.length <= 90 && k.stappen[0].indexOf('`Hoi') > 0 && k.stappen[1].indexOf('https://mail.google.com/mail/u/0/#all/abcdef0123456789') > 0 && k.deadline === '2026-11-30' && k.sleutel.length <= 61 && /^[a-z0-9][a-z0-9-]{1,60}$/.test(k.sleutel), k);
const kd = M.kaartVoor({ wachter: 'correspondentie', rij: 'abcdef0123456789', vraag: 'SOCEV PROEF: rappel voor de offerte?', knoppen: [] }, { thread_id: 'abcdef0123456789', bron: 'doktersmaten id' }, V);
t('kaart: doktersmaten zonder link', kd.stappen.join(' ').indexOf('https://') < 0 && kd.stappen[0].indexOf('doktersmaten') > 0, kd);

// met io
function wereld() {
  const W = { klok: '07:00', datum: V, nu: Date.parse(V + 'T06:00:00Z'), staat: null, tabel: { actie: {}, correspondentie: {}, agenda: {}, personeel: {} }, lijstje: {}, kaarten: {}, logs: [], kaartFaalt: 0, werkFaalt: 0 };
  const io = { nu: function () { return W.nu; }, datum: function () { return W.datum; }, klok: function () { return W.klok; },
    lees: function () { return W.staat ? JSON.parse(JSON.stringify(W.staat)) : null; }, schrijf: function (s) { W.staat = JSON.parse(JSON.stringify(s)); },
    rij: async function (w, s) { return W.tabel[w][s] ? Object.assign({}, W.tabel[w][s]) : null; },
    werk: async function (w, s, g, data) { if (W.werkFaalt-- > 0) throw new Error('n8n weg'); const r = W.tabel[w][s]; if (!r || r.status !== g.status || (r.bevinding || '') !== (g.bevinding || '')) return { n: 0 }; Object.assign(r, data); return { n: 1 }; },
    inLijstje: async function (w, s, d) { return !!W.lijstje[w + '|' + s + '|' + d]; },
    rpc: async function (naam, a) {
      if (naam === 'mk_voor_jou_zet') { W.kaarten[a.p.sleutel] = Object.assign({ status: 'open' }, a.p); return { sleutel: a.p.sleutel }; }
      if (naam === 'mk_voor_jou_status') { if (W.kaartFaalt-- > 0) throw new Error('db weg'); const c = W.kaarten[a.p_sleutel]; if (!c || c.status !== a.p_van) return { ok: false }; c.status = a.p_naar; c.gesloten_door = a.p_door; c.bijgewerkt = new Date(W.nu).toISOString(); return { ok: true }; }
      if (naam === 'mk_voor_jou_lijst') return { punten: Object.keys(W.kaarten).map(function (s) { return Object.assign({ sleutel: s }, W.kaarten[s]); }) };
      throw new Error('onbekend ' + naam);
    }, log: function (o) { W.logs.push(o); } };
  return { W: W, A: M.maak(io) };
}
(async function () {
  let { W, A } = wereld();
  W.tabel.correspondentie.c1 = { thread_id: 'c1', status: 'gemeld', bevinding: 'b1', bron: 'gmail' };
  W.tabel.correspondentie.c2 = { thread_id: 'c2', status: 'afgerond', bevinding: 'b2' };
  W.tabel.personeel.p1 = { item_id: 'p1', status: 'gemeld', bevinding: 'pb' };
  for (let i = 1; i <= 7; i++) W.tabel.actie['a' + i] = { actie_id: 'a' + i, status: 'open', bevinding: 'x' + i, uiterlijk: i === 7 ? '2026-11-28' : '' };
  let z = await A.zet('correspondentie', [{ rij: 'c1', vraag: 'SOCEV PROEF: rappel voor Proefbedrijf?', knoppen: ['herinnering', 'bellen', 'vallen'], concept: 'Hoi, staat de offerte al klaar?' },
    { rij: 'c2', vraag: 'SOCEV PROEF: rappel voor iets dichts?', knoppen: ['herinnering', 'vallen'] }, { rij: 'c9', vraag: 'SOCEV PROEF: bestaat niet hoor?', knoppen: ['herinnering', 'vallen'] }]);
  t('zet: open rij gezet, dichte en onbekende geweigerd', z.gezet.length === 1 && z.fouten.length === 2, z);
  await A.zet('personeel', [{ rij: 'p1', vraag: 'SOCEV PROEF: gesprekkenronde dit jaar of volgend jaar?', knoppen: ['ditjaar', 'volgendjaar', 'geregeld'] }]);
  await A.zet('actie', [1, 2, 3, 4, 5, 6, 7].map(function (i) { return { rij: 'a' + i, vraag: 'SOCEV PROEF: actie nummer ' + i + ' nog open?', knoppen: ['gedaan', 'week', 'vallen'] }; }));
  W.lijstje['actie|a1|' + V] = true;
  W.klok = '06:40';
  let s = await A.kaartStap();
  t('kaart: vóór 06:52 niets', s.te_vroeg === true && !Object.keys(W.kaarten).length, s);
  W.klok = '06:53';
  s = await A.kaartStap();
  t('kaart: plafond 5, actie uit het lijstje overgeslagen, rest door', s.kaarten === 5 && s.in_lijstje === 1 && s.door === 3, s);
  const a7 = M.sleutelVoor('actie', 'a7', V.replace(/-/g, '') === '' ? V : V);
  t('kaart: uiterlijk eerst (a7 kreeg een kaart)', Object.keys(W.kaarten).some(function (x) { return x.indexOf('wk-actie-') === 0 && W.kaarten[x].deadline === '2026-11-28'; }));
  t('kaart: tweede keer dezelfde dag niets', (await A.kaartStap()).al_gedaan === true);
  // tik op de mailkaart
  const kc = Object.keys(W.kaarten).find(function (x) { return x.indexOf('wk-correspondentie-') === 0; });
  if (!kc) { t('mailkaart gemaakt', false, Object.keys(W.kaarten)); }
  const punt = function (sl) { return Object.assign({ sleutel: sl }, W.kaarten[sl]); };
  const dt = A.detail(punt(kc));
  t('detail: drie knoppen zonder effect', dt && dt.knoppen.length === 3 && !('effect' in dt.knoppen[0]) && dt.knoppen[0].tekst === 'Ik stuur een herinnering', dt);
  W.kaartFaalt = 1;
  let u = await A.tik(punt(kc), 'bellen');
  t('tik: rij geschreven, kaartsluiting mislukt → nette fout', !u.ok && W.tabel.correspondentie.c1.volgende_check === '2026-12-03' && W.kaarten[kc].status === 'open', { u: u, r: W.tabel.correspondentie.c1 });
  t('tik: andere knop terwijl de eerste loopt geweigerd', (await A.tik(punt(kc), 'vallen')).status === 409);
  u = await A.tik(punt(kc), 'bellen');
  t('tik: opnieuw = hervat, rij niet dubbel', u.ok && W.kaarten[kc].status === 'gedaan' && (W.tabel.correspondentie.c1.bevinding.match(/David \(app\)/g) || []).length === 1, { u: u, r: W.tabel.correspondentie.c1 });
  t('tik: daarna "al vastgelegd"', (await A.tik(punt(kc), 'bellen')).ok === true && A.detail(punt(kc)).gekozen === 'Ik bel zelf');
  // optimistisch conflict
  const kp = Object.keys(W.kaarten).find(function (x) { return x.indexOf('wk-personeel-') === 0; });
  W.tabel.personeel.p1.bevinding = 'gewijzigd door de wachter';
  // detail las de rij bij de tik zelf, dus geen conflict; simuleer conflict via werk die faalt
  W.werkFaalt = 1;
  u = await A.tik(punt(kp), 'volgendjaar');
  t('tik: schrijffout → kaart blijft open', !u.ok && W.kaarten[kp].status === 'open' && W.tabel.personeel.p1.volgende_check === undefined, u);
  u = await A.tik(punt(kp), 'volgendjaar');
  t('tik: personeel volgend jaar', u.ok && W.tabel.personeel.p1.volgende_check === '2027-01-02' && W.tabel.personeel.p1.status === 'gemeld', W.tabel.personeel.p1);
  // ronde: algemene knoppen
  const ka = Object.keys(W.kaarten).filter(function (x) { return x.indexOf('wk-actie-') === 0 && W.kaarten[x].status === 'open'; });
  W.kaarten[ka[0]].status = 'gedaan'; W.kaarten[ka[0]].gesloten_door = 'david'; W.kaarten[ka[0]].bijgewerkt = new Date(W.nu).toISOString();
  W.kaarten[ka[1]].status = 'vervallen'; W.kaarten[ka[1]].gesloten_door = 'david'; W.kaarten[ka[1]].bijgewerkt = new Date(W.nu - 5 * 60000).toISOString();
  W.kaarten[ka[2]].status = 'later'; W.kaarten[ka[2]].later_tot = '2026-12-02'; W.kaarten[ka[2]].bijgewerkt = new Date(W.nu - 5 * 60000).toISOString();
  const rijVan = function (sl) { return Object.keys(W.staat.ingangen).map(function (x) { return W.staat.ingangen[x]; }).find(function (g) { return g.kaart === sl; }).rij; };
  let o = await A.ronde();
  t('ronde: Gedaan binnen de ↩️-tijd nog niet doorgegeven', W.tabel.actie[rijVan(ka[0])].status === 'open', o);
  t('ronde: Niet meer nodig → genegeerd', W.tabel.actie[rijVan(ka[1])].status === 'genegeerd', W.tabel.actie[rijVan(ka[1])]);
  t('ronde: Later → rust tot die dag', W.tabel.actie[rijVan(ka[2])].volgende_check === '2026-12-02' && W.tabel.actie[rijVan(ka[2])].status === 'open', W.tabel.actie[rijVan(ka[2])]);
  W.nu += 3 * 60000;
  o = await A.ronde();
  t('ronde: Gedaan na de ↩️-tijd → afgerond', W.tabel.actie[rijVan(ka[0])].status === 'afgerond', o);
  const ok2 = (W.tabel.actie[rijVan(ka[2])].bevinding.match(/David \(app\)/g) || []).length === 1;
  t('ronde: Later maar één keer doorgegeven', ok2, W.tabel.actie[rijVan(ka[2])]);
  // zet terwijl een kaart open staat: niets nieuws
  z = await A.zet('actie', [{ rij: rijVan(ka[2]), vraag: 'SOCEV PROEF: nog steeds open zeker?', knoppen: ['gedaan', 'vallen'] }]);
  t('zet: open kaart voor dezelfde zaak → al_kaart', z.al_kaart.length === 1, z);
  // volgende dag: door-ingangen, en verlopen na 2 dagen
  W.datum = '2026-11-27'; W.klok = '06:55';
  s = await A.kaartStap();
  t('volgende ochtend: doorgeschoven ingangen krijgen een kaart', s.kaarten === 3, s);
  // de wachter sluit rijen zelf → kaarten dicht (ook een kaart op Later die al doorgegeven is)
  W.tabel.actie[rijVan(ka[2])].status = 'afgerond';
  const nieuw = Object.keys(W.kaarten).find(function (x) { return x.indexOf('wk-actie-') === 0 && x.slice(-8) === '20261127'; });
  W.tabel.actie[rijVan(nieuw)].status = 'afgerond';
  o = await A.ronde();
  t('ronde: rij dicht → kaart vervallen door agent (open en later)', W.kaarten[nieuw].status === 'vervallen' && W.kaarten[nieuw].gesloten_door === 'agent' && W.kaarten[ka[2]].status === 'vervallen', o);
  W.datum = '2026-11-30';
  await A.zet('agenda', []);
  W.staat.ingangen['agenda|e1'] = { wachter: 'agenda', rij: 'e1', vraag: 'x', knoppen: [], status: 'klaar', dag: '2026-11-26', gezet_op: W.nu };
  s = await A.kaartStap();
  t('ingang ouder dan 2 dagen verloopt', W.staat.ingangen['agenda|e1'].status === 'verlopen', s);
  t('info telt zonder namen', JSON.stringify(A.info()).indexOf('SOCEV') < 0);
  console.log(goed + ' groen, ' + fout + ' rood');
  process.exit(fout ? 1 : 0);
})().catch(function (e) { console.log('ROOD  crash ' + (e && e.stack)); process.exit(1); });
JS
