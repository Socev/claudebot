'use strict';
// wv3091 (OVIS Mail fase 2): mail-sluit.js met een verzonnen dag, een nep-leesluik, nep-MailMan en de echte patiëntpoort.
// Alle adressen, onderwerpen en ID's zijn verzonnen (de repo is openbaar).
const test = require('node:test');
const assert = require('node:assert/strict');
const MS = require('../mail-sluit.js');
const poort = require('../intake/patientpoort.js');

const DAG = '2026-11-14';                       // gisteren in de kamer (klok 15-11 01:00 Amsterdam)
const KLOK = Date.parse('2026-11-15T00:00:00Z');
const MIDDAG = Date.parse('2026-11-14T11:00:00Z');
let n = 0;
function hex() { n++; return ('abcdef0000000000' + n.toString(16)).slice(-16); }
// Filters zoals Gmail ze geeft (vorm gemeten 15-11; waarden verzonnen)
const FILTERS = [
  { id: 'f1', criteria: { to: 'ik+ai@gmail.com' }, action: { addLabelIds: ['Label_9'], removeLabelIds: ['INBOX'] } },
  { id: 'f2', criteria: { to: 'ik+calls@gmail.com' }, action: { removeLabelIds: ['UNREAD', 'INBOX', 'SPAM'] } },
  { id: 'f3', criteria: { from: 'robot <bot@code.invalid>', subject: 'Run failed: build' }, action: { addLabelIds: ['TRASH'] } },
  { id: 'f4', criteria: { from: '@ziekenhuis.invalid' }, action: { removeLabelIds: ['SPAM'] } },
  { id: 'f5', criteria: { query: 'larger:10M' }, action: { removeLabelIds: ['INBOX'] } },
];
const LABELS = [{ id: 'Label_9', naam: 'AI/SecondBrain/Unprocessed' }];
function ber(o) {
  const id = hex();
  return Object.assign({ id, draad: id, labels: ['UNREAD', 'CATEGORY_UPDATES'], van: 'Iemand <iemand@voorbeeld.invalid>', aan: 'ik@gmail.com', cc: '', bezorgd: 'ik@gmail.com',
    onderwerp: 'Verzonnen', datum: new Date(MIDDAG).toISOString() }, o || {});
}

function kamer(berichten, o) {
  o = o || {};
  let opslag = o.opslag || null, klok = o.klok || KLOK;
  const roepen = [];
  const io = {
    nu: function () { return klok; },
    fout: function () {},
    luik: async function (b) {
      roepen.push(b);
      if (b.actie !== 'mail_dag') throw new Error('onbekend');
      if (o.luikFout && o.luikFout(b)) throw new Error('weg');
      const dag = MS.amsDag(b.van * 1000 + 3600000);
      const alle = (typeof berichten === 'function' ? berichten(dag) : berichten).filter(function (x) { const t = Date.parse(x.datum); return t >= b.van * 1000 - 86400000 && t < b.tot * 1000 + 86400000; });
      const per = o.perPagina || 1000, start = b.pagina ? Number(b.pagina.slice(1)) : 0;
      const j = { berichten: alle.slice(start, start + per), labels: LABELS, aantal: alle.length };
      if (!o.zonderFilters) j.filters = FILTERS;
      if (start + per < alle.length) j.volgende = 'p' + (start + per);
      if (o.melding) j.melding = 'deels mislukt';
      return j;
    },
    mailman: { mailSluitBron: function (ids) { const u = {}; ids.forEach(function (id) { u[id] = (o.mm || {})[id] || { gezien: true }; }); return u; } },
    poort: function (stuk) { return poort.beoordeel(stuk); },
    bekend: async function (a) { return (o.bekend || []).includes(a); },
    lees: function () { return opslag ? JSON.parse(opslag) : null; },
    schrijf: function (s) { opslag = JSON.stringify(s); },
  };
  return { m: MS.maak(io), roepen, opslag: function () { return opslag ? JSON.parse(opslag) : null; }, zetKlok: function (t) { klok = t; } };
}

test('middernacht: Amsterdamse dag in winter-, zomer- en wisseltijd', () => {
  assert.equal(new Date(MS.middernacht('2026-11-14')).toISOString(), '2026-11-13T23:00:00.000Z');
  assert.equal(new Date(MS.middernacht('2026-07-01')).toISOString(), '2026-06-30T22:00:00.000Z');
  assert.equal(new Date(MS.middernacht('2026-03-29')).toISOString(), '2026-03-28T23:00:00.000Z');   // de wisseldag begint nog in wintertijd
  assert.equal(new Date(MS.middernacht('2026-10-26')).toISOString(), '2026-10-25T23:00:00.000Z');
  assert.equal(MS.middernacht('2026-10-26') - MS.middernacht('2026-10-25'), 25 * 3600000);
  assert.equal(MS.dagErbij('2026-11-01', -1), '2026-10-31');
});

test('filterPast: van, aan (ook Delivered-To) en onderwerp; andere criteria = niet te beoordelen (null), nooit een gok', () => {
  assert.equal(MS.filterPast(FILTERS[0], { aan: 'Ik <ik+ai@gmail.com>' }), true);
  assert.equal(MS.filterPast(FILTERS[0], { aan: 'ik@gmail.com', bezorgd: 'ik+ai@gmail.com' }), true);
  assert.equal(MS.filterPast(FILTERS[0], { aan: 'ik@gmail.com', bezorgd: 'ik@gmail.com' }), false);
  assert.equal(MS.filterPast(FILTERS[2], { van: 'Robot <bot@code.invalid>', onderwerp: 'Run failed: build (main)' }), true);
  assert.equal(MS.filterPast(FILTERS[2], { van: 'Robot <bot@code.invalid>', onderwerp: 'Run succeeded: build' }), false);
  assert.equal(MS.filterPast(FILTERS[3], { van: 'Poli <poli@ziekenhuis.invalid>' }), true);
  assert.equal(MS.filterPast(FILTERS[4], { van: 'x' }), null);
  assert.equal(MS.filterPast({ criteria: {} }, { van: 'x' }), null);
});

test('een verzonnen dag: elk gesprek precies één plek, de som klopt, de lijst draagt een waarom', async () => {
  const B = {
    inbox: ber({ labels: ['INBOX', 'UNREAD'] }),
    jij: ber({ labels: ['CATEGORY_UPDATES'] }),
    eerst: ber({ labels: ['UNREAD'] }),
    socev: ber({ labels: ['Label_5'] }),
    github: ber({ labels: ['TRASH', 'UNREAD'], van: 'Robot <bot@code.invalid>', onderwerp: 'Run failed: build' }),
    weg: ber({ labels: ['TRASH'] }),
    spam: ber({ labels: ['SPAM', 'UNREAD'], van: 'Reclame <win@prijs.invalid>' }),
    spamBekend: ber({ labels: ['SPAM', 'UNREAD'], van: 'Oom <oom@familie.invalid>', onderwerp: 'Foto\'s van zondag' }),
    ai: ber({ labels: ['Label_9', 'UNREAD'], aan: 'ik+ai@gmail.com', onderwerp: 'Notitie voor het brein' }),
    calls: ber({ labels: [], aan: 'ik+calls@gmail.com' }),
    gelezen: ber({ labels: ['CATEGORY_PERSONAL'] }),
    raar: ber({ labels: ['UNREAD', 'CATEGORY_UPDATES'], onderwerp: 'Ongelezen buiten de inbox' }),
    mist: ber({ labels: ['UNREAD'], onderwerp: 'MailMan zag mij niet' }),
    gisterenNacht: ber({ labels: ['UNREAD'], datum: '2026-11-13T22:59:00Z' }),   // 13-11 23:59 Amsterdam: hoort niet bij deze dag
  };
  // één gesprek met twee berichten: de inbox wint van de filter
  const tweede = ber({ draad: B.ai.draad, labels: ['INBOX'], aan: 'ik@gmail.com' });
  const ai2 = ber({ labels: ['Label_9', 'UNREAD'], aan: 'ik+ai@gmail.com' });
  const tweeTweede = ber({ draad: ai2.draad, labels: ['INBOX'] });
  const mm = {};
  mm[B.jij.id] = { gezien: true, jij: true }; mm[B.eerst.id] = { gezien: true, eerst_inbox: true }; mm[B.socev.id] = { gezien: true, socev: true, reden: 'facturen' };
  mm[B.mist.id] = { gezien: false };
  const alle = Object.values(B).concat([tweede, ai2, tweeTweede]);
  const { m } = kamer(alle, { mm, bekend: ['oom@familie.invalid'] });
  const r = await m.sluitDag(DAG);
  assert.ok(r && r.compleet);
  const t = r.tel;
  assert.equal(t.binnen, Object.keys(B).length - 1 + 1, 'gesprekken: 13 losse + het tweede ai-gesprek (de nacht ervoor telt niet)');
  assert.equal(t.inbox + t.jij + t.socev + t.lijst + t.prullenbak_filter + t.spam, t.binnen, 'de som sluit');
  assert.deepEqual(r.uit.jij, { jij: 1, eerst_inbox: 1, verwijderd: 1, gelezen: 1 });
  assert.deepEqual(r.uit.socev, { facturen: 1 });
  assert.deepEqual(r.uit.prullenbak_filter, { filter: 1 });
  assert.deepEqual(r.uit.spam, { spam: 1 });
  assert.equal(t.inbox, 3, 'B.inbox, het B.ai-gesprek en het ai2-gesprek (elk met een inboxbericht)');
  const per = {}; r.lijst.forEach(function (x) { per[x.draad] = x; });
  assert.deepEqual(Object.keys(per).sort(), [B.spamBekend.draad, B.calls.draad, B.raar.draad, B.mist.draad].sort(), 'B.ai (tweede bericht in de inbox) staat niet op de lijst');
  assert.equal(per[B.calls.draad].reden, 'filter'); assert.match(per[B.calls.draad].waarom, /Gmail-filter \(aan \+calls\)/);
  assert.equal(per[B.spamBekend.draad].reden, 'spam_bekend'); assert.equal(per[B.spamBekend.draad].spam, true);
  assert.equal(per[B.mist.draad].reden, 'mailman_mist'); assert.equal(r.mist, 1);
  assert.equal(per[B.raar.draad].reden, 'onbekend'); assert.equal(per[B.raar.draad].onderwerp, 'Ongelezen buiten de inbox');
  // de +ai-filter met label: zonder inboxbericht in het gesprek wel op de lijst, met labelnaam in het waarom
  const r2 = await kamer([ber({ labels: ['Label_9', 'UNREAD'], aan: 'ik+ai@gmail.com' })], {}).m.sluitDag(DAG);
  assert.equal(r2.lijst.length, 1); assert.match(r2.lijst[0].waarom, /zette hem bij AI\/SecondBrain\/Unprocessed, buiten je inbox/);
  assert.doesNotMatch(r2.lijst[0].waarom, /ik\+ai@gmail\.com/, 'Davids adres alleen als +achtervoegsel');
});

test('wv3134: slaat de patiëntpoort aan op onderwerp of afzender (of MailMan zag een slotje), dan slot als teken; onderwerp en afzender blijven', async () => {
  const a = ber({ labels: ['UNREAD'], onderwerp: 'Uitslag lab BSN 111222333 geboortedatum 01-02-1950' });
  const b = ber({ labels: ['UNREAD'], onderwerp: 'Gewoon onderwerp' });
  const mm = {}; mm[b.id] = { gezien: true, slot: true };
  const r = await kamer([a, b], { mm }).m.sluitDag(DAG);
  assert.equal(r.lijst.length, 2);
  for (const x of r.lijst) { assert.equal(x.slot, true); assert.ok(x.van, 'afzender blijft'); }
  assert.deepEqual(r.lijst.map(function (x) { return x.onderwerp; }).sort(), ['Gewoon onderwerp', 'Uitslag lab BSN 111222333 geboortedatum 01-02-1950']);
});

test('onvolledig: luikfout = geen uitkomst; zonder filters = geen uitkomst; melding of te veel pagina\'s = compleet false; pagina\'s worden gevolgd', async () => {
  assert.equal(await kamer([ber()], { luikFout: function () { return true; } }).m.sluitDag(DAG), null);
  assert.equal(await kamer([ber()], { zonderFilters: true }).m.sluitDag(DAG), null);
  assert.equal((await kamer([ber()], { melding: true }).m.sluitDag(DAG)).compleet, false);
  const veel = []; for (let i = 0; i < 7; i++) veel.push(ber({ labels: ['INBOX'] }));
  const k = kamer(veel, { perPagina: 3 });
  const r = await k.m.sluitDag(DAG);
  assert.equal(r.tel.inbox, 7); assert.equal(k.roepen.length, 3); assert.equal(r.compleet, true);
  assert.deepEqual(k.roepen.map(function (x) { return x.pagina; }), [undefined, 'p3', 'p6']);
  assert.equal(k.roepen[0].tot - k.roepen[0].van, 86400, 'één hele dag in epoch-seconden');
});

test('nachtronde: drie dagen, ochtendregel alleen voor nieuwe gesprekken, nooit twee keer; Laat zo en terugzetten halen van de lijst', async () => {
  const per = { '2026-11-12': [ber({ labels: ['UNREAD'], datum: '2026-11-12T10:00:00Z' })], '2026-11-13': [ber({ labels: ['INBOX'], datum: '2026-11-13T10:00:00Z' })],
    '2026-11-14': [ber({ labels: ['UNREAD'] }), ber({ labels: ['UNREAD'], aan: 'ik+calls@gmail.com' })] };
  const k = kamer(function (dag) { return per[dag] || []; });
  let r = await k.m.ronde();
  assert.equal(r.ok, true);
  assert.deepEqual(r.dagen.map(function (d) { return d.dag; }), ['2026-11-12', '2026-11-13', '2026-11-14']);
  assert.equal(r.nieuw.length, 3);
  assert.match(r.ochtend, /^3 mails van de afgelopen dagen kwamen niet in je inbox; in de App onder Mail › Niet in je inbox gekomen/);
  let l = k.m.lijst().j;
  assert.equal(l.items.length, 3); assert.equal(l.gisteren.dag, '2026-11-14'); assert.equal(l.gisteren.tel.lijst, 2);
  // na een gelukte ochtendregel: dezelfde gesprekken nooit opnieuw (review MOET 4: tot dan blijft hij open)
  assert.deepEqual(k.m.ochtendOpen().draden, r.nieuw);
  k.m.ochtendGezet();
  assert.equal(k.m.ochtendOpen(), null);
  r = await k.m.ronde();
  assert.equal(r.nieuw.length, 0); assert.equal(r.ochtend, null);
  // Laat zo en terug
  const [x, y] = l.items;
  assert.equal(k.m.klaar({ draad: x.draad, hoe: 'gezien' }).status, 200);
  assert.equal(k.m.klaar({ draad: y.draad, hoe: 'terug' }).status, 200);
  assert.equal(k.m.klaar({ draad: 'ffffffffffff0000', hoe: 'gezien' }).status, 404, 'alleen gesprekken van de lijst');
  assert.equal(k.m.klaar({ draad: x.draad, hoe: 'verwijder' }).status, 400);
  l = k.m.lijst().j;
  assert.equal(l.items.length, 1);
  // de volgende nacht: een nieuw gesprek op 15-11 → één regel, enkelvoud
  per['2026-11-15'] = [ber({ labels: ['UNREAD'], datum: '2026-11-15T10:00:00Z' })];
  k.zetKlok(Date.parse('2026-11-16T00:00:00Z'));
  r = await k.m.ronde();
  assert.equal(r.nieuw.length, 1); assert.match(r.ochtend, /^1 mail van de afgelopen dagen kwam niet in je inbox;/);
  // na 14 dagen weg (dagen, klaar en gemeld)
  k.zetKlok(Date.parse('2026-12-01T00:00:00Z'));
  per['2026-11-28'] = []; per['2026-11-29'] = []; per['2026-11-30'] = [];
  r = await k.m.ronde();
  const s = k.opslag();
  assert.deepEqual(Object.keys(s.dagen).sort(), ['2026-11-28', '2026-11-29', '2026-11-30']);
  assert.deepEqual([Object.keys(s.klaar).length, Object.keys(s.gemeld).length], [0, 0]);
  assert.equal(k.m.lijst().j.items.length, 0);
});

test('nachtronde met één mislukte dag: ok false, de andere dagen wel bewaard, geen ochtendregel zonder gisteren', async () => {
  const k = kamer(function () { return [ber({ labels: ['UNREAD'], datum: '2026-11-12T10:00:00Z' })]; }, { luikFout: function (b) { return MS.amsDag(b.van * 1000 + 3600000) === '2026-11-14'; } });
  const r = await k.m.ronde();
  assert.equal(r.ok, false);
  assert.equal(r.ochtend, null, 'zonder gisteren geen regel');
  assert.ok(k.opslag().dagen['2026-11-12']);
  assert.equal(k.opslag().laatste.ok, false);
  assert.equal(k.m.boxNieuw('fout-x'), true); assert.equal(k.m.boxNieuw('fout-x'), false);
});

test('mail-app wijzig terug meldt de terugzetting aan de sluitcontrole; archiveren niet', async () => {
  const MA = require('../mail-app.js');
  const klaar = [];
  const m = MA.maak({ luik: async function (b) { return { ok: true, draad: b.draad }; }, mailman: { mailLaag: function () { return {}; }, mailTik: function () { return true; } },
    labelIds: function () { return {}; }, toestemming: function () { return true; }, pas: function () { return 'ab'.repeat(16); }, poort: function () { return { tegenhouden: false }; },
    sluitKlaar: function (t) { klaar.push(t); } });
  await m.wijzig({ draad: 'cccccccccccc0001', wat: 'terug' });
  await m.wijzig({ draad: 'cccccccccccc0002', wat: 'archiveer' });
  assert.deepEqual(klaar, ['cccccccccccc0001']);
});

test('review r1 MOET 1, r3 MOET 1: een onvolledige hercontrole = ok false, bewaard als niet compleet; nieuwe vondsten blijven, eerdere lijstgesprekken die hij niet zag ook', async () => {
  const a = ber({ labels: ['UNREAD'], onderwerp: 'Eerste' }), b = ber({ labels: ['UNREAD'], onderwerp: 'Later erbij' });
  let alle = [a];
  const k = kamer(function () { return alle; });
  let r = await k.m.ronde();
  assert.equal(r.ok, true);
  const k2 = kamer(function () { return alle; }, { opslag: JSON.stringify(k.opslag()), melding: true });
  alle = [b];
  r = await k2.m.ronde();
  assert.equal(r.ok, false, 'onvolledig is geen geslaagde controle');
  const s = k2.opslag();
  assert.equal(s.dagen[DAG].compleet, false, 'zichtbaar niet compleet');
  assert.deepEqual(s.dagen[DAG].lijst.map(function (x) { return x.onderwerp; }), ['Later erbij', 'Eerste'], 'nieuwe vondst + het eerdere gesprek dat deze poging niet zag');
  assert.equal(s.dagen[DAG].tel.lijst, 1, 'de som is van deze poging');
  assert.equal(s.dagen[DAG].aangevuld, 1);
  assert.equal(s.laatste.ok, false);
});

test('wv3134 (was review MOET 2): filtertekst met een patiëntkenmerk = slot als teken; het echte waarom blijft staan', async () => {
  const F = [{ id: 'fp', criteria: { subject: 'BSN 111222333 geboortedatum 01-02-1950' }, action: { removeLabelIds: ['INBOX'] } }];
  const m = ber({ labels: ['UNREAD'], onderwerp: 'BSN 111222333 geboortedatum 01-02-1950 gewoon' });
  // eigen kamer met deze filter
  const MSx = require('../mail-sluit.js');
  let opslag = null;
  const k = MSx.maak({ nu: function () { return KLOK; }, luik: async function () { return { berichten: [m], filters: F, labels: [] }; },
    mailman: { mailSluitBron: function (ids) { const u = {}; ids.forEach(function (i) { u[i] = { gezien: true }; }); return u; } },
    poort: function (stuk) { return poort.beoordeel(stuk); }, bekend: async function () { return false; },
    lees: function () { return opslag ? JSON.parse(opslag) : null; }, schrijf: function (x) { opslag = JSON.stringify(x); } });
  const r = await k.sluitDag(DAG);
  assert.equal(r.lijst.length, 1);
  assert.equal(r.lijst[0].slot, true);
  assert.match(r.lijst[0].waarom, /111222333/, 'het waarom wordt niet meer vervangen door een algemene reden');
  assert.equal(r.lijst[0].onderwerp, 'BSN 111222333 geboortedatum 01-02-1950 gewoon');
});

test('review MOET 3: een tik van David tijdens de ronde (Laat zo) blijft staan', async () => {
  const a = ber({ labels: ['UNREAD'] });
  let opslag = null, tijdensRonde = null;
  const MSx = require('../mail-sluit.js');
  const k = MSx.maak({ nu: function () { return KLOK; },
    luik: async function () { if (tijdensRonde) { const f = tijdensRonde; tijdensRonde = null; f(); } return { berichten: [a], filters: [], labels: [] }; },
    mailman: { mailSluitBron: function (ids) { const u = {}; ids.forEach(function (i) { u[i] = { gezien: true }; }); return u; } },
    poort: function (stuk) { return poort.beoordeel(stuk); }, bekend: async function () { return false; },
    lees: function () { return opslag ? JSON.parse(opslag) : null; }, schrijf: function (x) { opslag = JSON.stringify(x); } });
  await k.ronde();
  assert.equal(k.lijst().j.items.length, 1);
  tijdensRonde = function () { assert.equal(k.klaar({ draad: a.draad, hoe: 'gezien' }).status, 200); };
  await k.ronde();
  assert.equal(k.lijst().j.items.length, 0, 'Laat zo van tijdens de ronde is niet overschreven');
  assert.ok(JSON.parse(opslag).klaar[a.draad]);
});

test('review MOET 4: de ochtendregel blijft open tot hij gezet is, alleen voor vandaag', async () => {
  const k = kamer([ber({ labels: ['UNREAD'] })]);
  const r = await k.m.ronde();
  assert.ok(r.ochtend);
  assert.equal(k.m.ochtendOpen().tekst, r.ochtend);
  assert.equal(k.m.ochtendOpen().dag, '2026-11-15');
  k.zetKlok(Date.parse('2026-11-16T00:30:00Z'));
  assert.equal(k.m.ochtendOpen(), null, 'een regel van gisteren wordt niet meer bezorgd');
});

test('review ronde 2 MOET 1: twee onvolledige pogingen na elkaar — beide lijstgesprekken blijven, gemarkeerd als aangevuld en niet compleet', async () => {
  const a = ber({ labels: ['UNREAD'], onderwerp: 'Poging een' }), b = ber({ labels: ['UNREAD'], onderwerp: 'Poging twee' });
  let alle = [a];
  const k = kamer(function () { return alle; }, { melding: true });
  let r = await k.m.ronde();
  assert.equal(r.ok, false);
  alle = [b];
  r = await k.m.ronde();
  const d = k.opslag().dagen[DAG];
  assert.equal(d.compleet, false);
  assert.deepEqual(d.lijst.map(function (x) { return x.onderwerp; }).sort(), ['Poging een', 'Poging twee']);
  assert.equal(d.aangevuld, 1);
  assert.equal(k.m.lijst().j.gisteren.aangevuld, 1);
  assert.equal(k.m.lijst().j.items.length, 2);
});

test('review ronde 2 MOET 2: vindt een herkansing er later nog bij, dan telt de ochtendregel het totaal van de nacht en gaat hij opnieuw de buffer in', async () => {
  const a = ber({ labels: ['UNREAD'] }), b = ber({ labels: ['UNREAD'] });
  let alle = [a];
  const k = kamer(function () { return alle; }, { melding: true });
  await k.m.ronde();
  assert.match(k.m.ochtendOpen().tekst, /^1 mail /);
  k.m.ochtendGezet();
  assert.equal(k.m.ochtendOpen(), null);
  alle = [a, b];
  await k.m.ronde();
  const o = k.m.ochtendOpen();
  assert.ok(o, 'opnieuw open na een extra vondst');
  assert.match(o.tekst, /^2 mails /, 'het totaal van de nacht, niet alleen de nieuwe');
  assert.equal(o.draden.length, 2);
  k.m.ochtendGezet();
  await k.m.ronde();
  assert.equal(k.m.ochtendOpen(), null, 'niets nieuws = geen nieuwe regel');
});

test('review r3 ZOU 1: aangevuld telt per uitkomst (niet opgeteld); een gesprek dat de poging nu in de inbox ziet, komt niet terug op de lijst', async () => {
  const a = ber({ labels: ['UNREAD'], onderwerp: 'Steeds gemist' }), b = ber({ labels: ['UNREAD'], onderwerp: 'Wel gezien' });
  let alle = [a, b];
  const k = kamer(function () { return alle; });
  await k.m.ronde();
  const k2 = kamer(function () { return alle; }, { opslag: JSON.stringify(k.opslag()), melding: true });
  alle = [b];
  for (let i = 0; i < 3; i++) await k2.m.ronde();
  let d = k2.opslag().dagen[DAG];
  assert.equal(d.aangevuld, 1, 'na drie onvolledige pogingen nog steeds 1');
  assert.equal(d.lijst.length, 2);
  alle = [Object.assign({}, b, { labels: ['INBOX'] })];   // b staat nu in de inbox, a nog steeds niet gezien
  await k2.m.ronde();
  d = k2.opslag().dagen[DAG];
  assert.deepEqual(d.lijst.map(function (x) { return x.onderwerp; }), ['Steeds gemist'], 'b kreeg zijn nieuwe plek (inbox), a blijft');
  assert.equal(d.tel.inbox, 1);
});

test('review r4 MOET 1: een mislukte contactencontrole laat een eerder vermeld spamgesprek van een bekende niet stil van de lijst vallen', async () => {
  const sp = ber({ labels: ['SPAM', 'UNREAD'], van: 'Oom <oom@familie.invalid>', onderwerp: 'Spam van oom' });
  const k = kamer([sp], { bekend: ['oom@familie.invalid'] });
  await k.m.ronde();
  assert.equal(k.m.lijst().j.items.length, 1);
  const MSx = require('../mail-sluit.js');
  let opslag = JSON.stringify(k.opslag());
  const k2 = MSx.maak({ nu: function () { return KLOK; }, luik: async function () { return { berichten: [sp], filters: [], labels: [] }; },
    mailman: { mailSluitBron: function (ids) { const u = {}; ids.forEach(function (i) { u[i] = { gezien: true }; }); return u; } },
    poort: function (stuk) { return poort.beoordeel(stuk); }, bekend: async function () { throw new Error('contacten even weg'); },
    lees: function () { return JSON.parse(opslag); }, schrijf: function (x) { opslag = JSON.stringify(x); } });
  const r = await k2.ronde();
  assert.equal(r.ok, false);
  assert.equal(k2.lijst().j.items.length, 1, 'het spamgesprek van oom blijft op de lijst');
  assert.equal(JSON.parse(opslag).dagen[DAG].compleet, false);
});

test('review r5 ZOU 1: staat een gesprek al op de nieuwe lijst, dan komt de oude vermelding er niet dubbel bij', async () => {
  const sp = ber({ labels: ['SPAM', 'UNREAD'], van: 'Oom <oom@familie.invalid>' });
  const ander = ber({ draad: sp.draad, labels: ['UNREAD'], onderwerp: 'Gewoon ander bericht' });
  const k = kamer([sp], { bekend: ['oom@familie.invalid'] });
  await k.m.ronde();
  const MSx = require('../mail-sluit.js');
  let opslag = JSON.stringify(k.opslag());
  const k2 = MSx.maak({ nu: function () { return KLOK; }, luik: async function () { return { berichten: [sp, ander], filters: [], labels: [] }; },
    mailman: { mailSluitBron: function (ids) { const u = {}; ids.forEach(function (i) { u[i] = { gezien: true }; }); return u; } },
    poort: function (stuk) { return poort.beoordeel(stuk); }, bekend: async function () { throw new Error('weg'); },
    lees: function () { return JSON.parse(opslag); }, schrijf: function (x) { opslag = JSON.stringify(x); } });
  for (let i = 0; i < 3; i++) await k2.ronde();
  const d = JSON.parse(opslag).dagen[DAG];
  assert.equal(d.lijst.filter(function (x) { return x.draad === sp.draad; }).length, 1);
  assert.equal(d.aangevuld, 0);
});
