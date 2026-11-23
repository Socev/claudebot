#!/usr/bin/env bash
# Toets wv3741 (besluitenpagina nr 486 = 3C186): agenda-potlood.js met een nep-luik en verzonnen vondsten (geen echte agenda).
#   Nieuw (samenvoegen, filters, bron verplicht), nooit dubbel, plafond per dag en per ronde, weggehaald = klopt niet en komt niet
#   terug, overgenomen alleen bij nu_in agenda (review MOET 2), fail-closed, kaart-herkansing, verlopen, proefmodus, grenzen.
# Kruisproef: AP_MOD=<kopie zonder registercontrole> bash test/agenda-potlood.sh moet rood zijn.
# wv3813 (v2): ❌ = klopt niet via correlatie_id (verzonnen logrij), vertrek- en voorbereidblokken uit een nep-agenda (verzonnen afspraken):
#   juiste tijd, geen dubbel, weg als de afspraak weg/verplaatst is, weggehaald komt niet terug, geen David/Werk-titel in een blok,
#   fail-closed, eigen registerrij, gedeeld plafond. Kruisproef: AP_MOD=<kopie zonder ❌-stap of zonder blokregister> → rood.
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
node - "$HIER" "$TMP" <<'EINDE'
'use strict';
const path = require('path'), fs = require('fs');
const M0 = require(process.env.AP_MOD || path.join(process.argv[2], 'agenda-potlood.js'));
// wv3978: standaard een nep-stuk en een nep-model dat "ja" zegt (titel = onderwerp van de detector), zodat de v1/v2-gevallen blijven gelden
const NEPSTUK = '---\novis_stuk: stk_proef\nafzender: "Proefsecretariaat <info@proef.invalid>"\n---\n\n# Proef\n\nGraag zien we je dan.\n';
const MODELVRAGEN = [];
const NEP = { lees: () => NEPSTUK, model: async (sys, pr, sc) => { MODELVRAGEN.push({ sys, pr, sc }); const m = /Onderwerp volgens de detector: (.*)/.exec(pr);
  return { ok: true, data: { oordeel: 'ja', wat: 'Proefoverleg met het bestuur over de begroting, in het proefgebouw.', titel: m ? m[1] : 'Proef' } }; } };
const M = Object.assign({}, M0, { maak: (o) => M0.maak(Object.assign({}, NEP, o)) });
const TMP = process.argv[3];
let ok = 0, fout = 0;
function toets(naam, waar, x) { if (waar) { ok++; console.log('ok   ' + naam); } else { fout++; console.log('FOUT ' + naam + ' ' + JSON.stringify(x)); } }
const NU = Date.UTC(2026, 10, 23, 7, 30);   // ma 23-11-2026 08:30 lokaal
const UUR = 3600000;
const r = (id, van, extra) => Object.assign({ id, van, tot: van, hele_dag: true, begin: null, eind: null, onderwerp: 'Proefoverleg ' + id, titel: 'Afspraak uit: Proefoverleg ' + id,
  soort: 'afspraak', precisie: 'dag', nu_in: null, stuk_pad: '20_Prive/Proef/stuk ' + id + '.md' }, extra || {});
function nepLuik() {
  const L = { events: new Map(), log: [], n: 0, faalKaart: 0, faalLijst: false };
  L.f = async function (b) {
    L.log.push(JSON.parse(JSON.stringify(b)));
    if (b.actie === 'socev_lijst') { if (L.faalLijst) throw new Error('weg'); return { ok: true, events: Array.from(L.events.values()) }; }
    if (b.actie === 'socev_plaatsen') { const id = 'ev' + (++L.n); L.events.set(id, { event_id: id, titel: b.titel, start: b.start }); return { ok: true, event_id: id }; }
    if (b.actie === 'socev_verwijderen') { const had = L.events.delete(b.event_id); return { ok: had }; }
    if (b.actie === 'david_plaatsen') { if (L.faalKaart > 0) { L.faalKaart--; return { ok: false, knop_verstuurd: false, fout: 'kaart kon niet' }; } L.kn = (L.kn || 900) + 1; return { ok: false, oordeel: 'oranje', kaart: true, knop_verstuurd: true, knop_in: 'app', correlatie_id: 'ag-' + L.kn }; }
    return { ok: false };
  };
  return L;
}
function maak(regels, L, extra) {
  const oordelen = [];
  const m = M.maak(Object.assign({ registerPad: REG, gevonden: async () => ({ ok: true, regels: regels() }), luik: L.f, oordeel: async (id, o) => { oordelen.push([id, o]); return { status: 200 }; },
    staatPad: path.join(TMP, (extra && extra.naam || 'p') + '.json') }, extra || {}));
  m.oordelen = oordelen; return m;
}
const acties = (L, a) => L.log.filter((x) => x.actie === a);
const REG = path.join(TMP, 'register.json');
fs.writeFileSync(REG, JSON.stringify({ rijen: [{ id: 'agenda-socev-potlood', status: 'aan' }] }));

(async function () {
  // 1. nieuw: samenvoegen, filters, bron verplicht
  let R = [
    r(1, '2026-11-25', { hele_dag: false, begin: '19:30', eind: '21:00', precisie: 'minuut' }),
    r(2, '2026-11-25', { hele_dag: false, begin: '19:30', eind: '21:00', precisie: 'minuut', onderwerp: 'Proefoverleg 1', stuk_pad: '20_Prive/Proef/ander.md' }),  // zelfde vondst, ander stuk
    r(3, '2026-11-26', { soort: 'deadline', stuk_pad: '10_Zakelijk/HAGRO/notulen proef.md' }),
    r(4, '2026-11-27', { nu_in: 'agenda' }),
    r(5, '2026-11-28', { precisie: 'maand' }),
    r(6, '2026-11-29', { stuk_pad: null }),
    r(7, '2026-11-23'),                                   // vandaag: niet
    r(8, '2027-02-01'),                                   // > 45 dagen
    r(9, '2026-11-30', { hele_dag: false, begin: '10:00', eind: null, precisie: 'minuut' }),
  ];
  let L = nepLuik(); let m = maak(() => R, L, { mutatiesRonde: 6 });
  let u = await m.ronde({ nu: NU });
  toets('3 nieuwe potloden', u.nieuw === 3 && acties(L, 'socev_plaatsen').length === 3, u);
  toets('3 kaarten', u.kaart === 3 && acties(L, 'david_plaatsen').length === 3, u);
  const p = acties(L, 'socev_plaatsen'), k = acties(L, 'david_plaatsen');
  toets('titel met potloodmarkering', p.every((x) => x.titel.indexOf('✏️ ') === 0), p.map((x) => x.titel));
  toets('deadline herkenbaar', p.some((x) => x.titel === '✏️ Deadline: Proefoverleg 3'), p.map((x) => x.titel));
  toets('bron in omschrijving', p.every((x) => /\nStuk: https:\/\/app\.socev\.dev\//.test(x.omschrijving)), p.map((x) => x.omschrijving));
  toets('samengevoegd: id 1+2 één potlood', p.filter((x) => x.start === '2026-11-25T19:30').length === 1);
  toets('eind ontbreekt: +1 uur en gezegd', p.some((x) => x.start === '2026-11-30T10:00' && x.eind === '2026-11-30T11:00' && /1 uur aangenomen/.test(x.omschrijving)), p);
  toets('hele dag: eind = volgende dag', p.some((x) => x.start === '2026-11-26' && x.eind === '2026-11-27'));
  toets('kaarten altijd kaart:true, geen test', k.every((x) => x.kaart === true && x.test === undefined));
  toets('HAGRO-stuk → hagro-agenda, rest hoofd', k.filter((x) => x.agenda === 'hagro').length === 1 && k.filter((x) => x.agenda === 'hoofd').length === 2, k.map((x) => x.agenda));
  toets('kaarttitel zonder potloodmarkering', k.every((x) => x.titel.indexOf('✏️') < 0));
  toets('nooit deelnemers of herhaling', L.log.every((x) => x.attendees === undefined && x.recurrence === undefined && x.genodigden === undefined && x.rrule === undefined));
  // 2. tweede ronde zelfde dag: niets dubbel
  u = await m.ronde({ nu: NU + UUR });
  toets('tweede ronde: 0 nieuw', u.nieuw === 0 && acties(L, 'socev_plaatsen').length === 3, u);
  // 3. weggehaald in Google = klopt niet, komt niet terug
  const ev1 = Array.from(L.events.values()).find((e) => /Proefoverleg 1$/.test(e.titel));
  L.events.delete(ev1.event_id);
  u = await m.ronde({ nu: NU + 24 * UUR });
  toets('weggehaald → weg', u.weg === 1 && u.stand.weg === 1, u);
  toets('klopt niet voor beide vondsten', JSON.stringify(m.oordelen.sort()) === JSON.stringify([[1, 'klopt_niet'], [2, 'klopt_niet']]), m.oordelen);
  u = await m.ronde({ nu: NU + 25 * UUR });
  toets('weggehaald komt niet terug', !Array.from(L.events.values()).some((e) => /Proefoverleg 1$/.test(e.titel)) && u.nieuw === 0, u);
  // 4. MOET 2: vondst verdwenen uit de lijst = niets weghalen; nu_in agenda = weghalen
  const voor = acties(L, 'socev_verwijderen').length;
  R = R.filter((x) => x.id !== 9);
  u = await m.ronde({ nu: NU + 26 * UUR });
  toets('verdwenen vondst: potlood blijft', acties(L, 'socev_verwijderen').length === voor && u.overgenomen === 0, u);
  R = R.map((x) => (x.id === 3 ? Object.assign({}, x, { nu_in: 'agenda' }) : x));
  u = await m.ronde({ nu: NU + 27 * UUR });
  const del = acties(L, 'socev_verwijderen');
  toets('in je agenda → potlood weg (overgenomen)', u.overgenomen === 1 && del.length === voor + 1, u);
  toets('verwijderen alleen eigen event uit het register', del.every((x) => /^ev\d+$/.test(x.event_id)));
  // 5. verlopen
  u = await m.ronde({ nu: Date.UTC(2026, 11, 5, 8, 0) });
  toets('dag voorbij → verlopen, geen schrijfactie', u.verlopen >= 1 && u.mutaties === 0, u);

  // 6. plafond per ronde en per dag
  const veel = []; for (let i = 0; i < 9; i++) veel.push(r(100 + i, '2026-12-0' + (i + 1)));
  L = nepLuik(); m = maak(() => veel, L, { naam: 'plafond' });
  const a1 = await m.ronde({ nu: NU }), a2 = await m.ronde({ nu: NU + UUR }), a3 = await m.ronde({ nu: NU + 2 * UUR }), a3b = await m.ronde({ nu: NU + 3 * UUR });
  toets('ronde ≤ 4 mutaties (2 potloden; rem 10/uur blijft ruim voor David)', a1.nieuw === 2 && a1.mutaties <= 4, a1);
  toets('dagplafond 5', a2.nieuw === 2 && a3.nieuw === 1 && a3b.nieuw === 0 && acties(L, 'socev_plaatsen').length === 5, [a2, a3, a3b]);
  toets('vandaagVol', m.vandaagVol(NU) === true);
  const a4 = await m.ronde({ nu: NU + 24 * UUR });
  toets('volgende dag weer ruimte', a4.nieuw === 2, a4);

  // 0. registerpoort: zonder rij aan (of onleesbaar) niets, ook niet lezen; proefmodus mag
  for (const [naam, inhoud] of [['rij ontbreekt', { rijen: [] }], ['rij uit', { rijen: [{ id: 'agenda-socev-potlood', status: 'uit' }] }], ['onleesbaar', null]]) {
    const rp = path.join(TMP, 'reg-' + naam.replace(/ /g, '') + '.json');
    if (inhoud) fs.writeFileSync(rp, JSON.stringify(inhoud));
    L = nepLuik(); m = M.maak({ registerPad: rp, gevonden: async () => ({ ok: true, regels: [r(1, '2026-11-25')] }), luik: L.f, oordeel: async () => ({}), staatPad: path.join(TMP, 'r0.json') });
    u = await m.ronde({ nu: NU });
    toets('register ' + naam + ' → niets', u.register === 'uit' && L.log.length === 0, u);
  }
  L = nepLuik(); m = M.maak({ proef: true, registerPad: path.join(TMP, 'bestaat-niet.json'), gevonden: async () => ({ ok: true, regels: [r(1, '2026-11-25')] }), luik: L.f, oordeel: async () => ({}), staatPad: path.join(TMP, 'r1.json') });
  u = await m.ronde({ nu: NU });
  toets('proefmodus zonder registerrij mag', u.nieuw === 1, u);
  // 7. fail-closed
  L = nepLuik(); m = M.maak({ registerPad: REG, gevonden: async () => { throw new Error('x'); }, luik: L.f, oordeel: async () => ({}), staatPad: path.join(TMP, 'f.json') });
  u = await m.ronde({ nu: NU });
  toets('vondsten onleesbaar → niets', u.ok === false && L.log.length === 0, u);
  L = nepLuik(); L.faalLijst = true; m = maak(() => [r(1, '2026-11-25')], L, { naam: 'f2' });
  u = await m.ronde({ nu: NU });
  toets('socev-kalender onleesbaar → niets geschreven', u.ok === false && L.log.every((x) => x.actie === 'socev_lijst'), u);
  m = M.maak({ registerPad: REG, gevonden: async () => ({ ok: false }), luik: L.f, oordeel: async () => ({}), staatPad: path.join(TMP, 'f3.json') });
  u = await m.ronde({ nu: NU });
  toets('vondsten ok:false → niets', u.ok === false, u);

  // 8. kaart mislukt → herkansing, hooguit kaartPogingen
  L = nepLuik(); L.faalKaart = 5; m = maak(() => [r(1, '2026-11-25')], L, { naam: 'kaart' });
  u = await m.ronde({ nu: NU });
  toets('kaart mislukt: potlood staat, kaart_fout', u.nieuw === 1 && u.kaart_fout === 1, u);
  u = await m.ronde({ nu: NU + UUR }); await m.ronde({ nu: NU + 2 * UUR });
  toets('herkansing hooguit 1 extra', acties(L, 'david_plaatsen').length === 2, acties(L, 'david_plaatsen').length);
  L.faalKaart = 0; m = maak(() => [r(1, '2026-11-25')], nepLuik(), { naam: 'kaart2' });
  const L2 = nepLuik(); L2.faalKaart = 1; m = maak(() => [r(1, '2026-11-25')], L2, { naam: 'kaart3' });
  await m.ronde({ nu: NU }); u = await m.ronde({ nu: NU + UUR });
  toets('herkansing lukt', u.kaart === 1 && acties(L2, 'david_plaatsen').length === 2, u);

  // 9. proefmodus
  L = nepLuik(); m = maak(() => [r(1, '2026-11-25'), r(3, '2026-11-26', { stuk_pad: '10_Zakelijk/HAGRO/x.md' })], L, { naam: 'proef', proef: true });
  u = await m.ronde({ nu: NU });
  const pk = acties(L, 'david_plaatsen');
  toets('proef: potlood SOCEV PROEF ✏️', acties(L, 'socev_plaatsen').every((x) => x.titel.indexOf('SOCEV PROEF ✏️ ') === 0));
  toets('proef: kaart test + proefagenda + SOCEV PROEF', pk.length === 2 && pk.every((x) => x.test === true && x.agenda === 'proef' && x.titel.indexOf('SOCEV PROEF') === 0), pk);
  // potlood zonder markering wordt nooit verwijderd
  L = nepLuik(); m = maak(() => [r(1, '2026-11-25')], L, { naam: 'mark' });
  await m.ronde({ nu: NU });
  for (const e of L.events.values()) e.titel = 'Iets van David';
  R = [r(1, '2026-11-25', { nu_in: 'agenda' })]; m = maak(() => R, L, { naam: 'mark' });
  u = await m.ronde({ nu: NU + 24 * UUR });
  toets('zonder markering nooit verwijderen', acties(L, 'socev_verwijderen').length === 0, u);

  // ── wv3813: ❌ = klopt niet ──
  const REG2 = path.join(TMP, 'register2.json');
  fs.writeFileSync(REG2, JSON.stringify({ rijen: [{ id: 'agenda-socev-potlood', status: 'aan' }, { id: 'agenda-socev-blokken', status: 'aan' }] }));
  {
    const L = nepLuik(); let afw = new Set(); let gevraagd = [];
    const RR = [r(1, '2026-11-25'), r(2, '2026-11-26')];
    const m = maak(() => RR, L, { naam: 'afw', mutatiesRonde: 6, afwijzingen: async (f) => { gevraagd.push(f); if (afw === 'faal') throw new Error('n8n weg'); return afw; } });
    let u = await m.ronde({ nu: NU });
    const st = JSON.parse(fs.readFileSync(path.join(TMP, 'afw.json'), 'utf8'));
    const kcs = Object.values(st.items).map((x) => (x.kc || [])[0]);
    toets('❌: correlatie_id van de kaart in het register', kcs.length === 2 && kcs.every((c) => /^ag-\d+$/.test(c)), st.items);
    afw = 'faal'; u = await m.ronde({ nu: NU + UUR });
    toets('❌: leesfout → niets weg, afwijs_fout', u.afwijs_fout === 1 && acties(L, 'socev_verwijderen').length === 0 && u.stand.potlood === 2, u);
    const ev2 = Object.values(st.items).find((x) => x.ids[0] === 2);
    afw = new Set([ev2.kc[0], 'ag-12345']); gevraagd = [];
    u = await m.ronde({ nu: NU + 2 * UUR });
    toets('❌: gericht gezocht op de open correlatie-id\'s', gevraagd.length === 1 && gevraagd[0][0].type === 'or' && gevraagd[0][0].filters.length === 2 && gevraagd[0][0].filters.every((x) => x.columnName === 'correlatie_id'), gevraagd);
    toets('❌: potlood weg + klopt_niet', u.afgewezen === 1 && acties(L, 'socev_verwijderen').length === 1 && acties(L, 'socev_verwijderen')[0].event_id === ev2.ev
      && JSON.stringify(m.oordelen) === JSON.stringify([[2, 'klopt_niet']]) && u.stand.afgewezen === 1, [u, m.oordelen]);
    u = await m.ronde({ nu: NU + 24 * UUR });
    toets('❌: komt niet terug, geen dubbel klopt_niet', u.nieuw === 0 && m.oordelen.length === 1 && acties(L, 'socev_verwijderen').length === 1 && u.stand.potlood === 1, [u, m.oordelen]);
    toets('❌: zonder afwijzing blijft het andere potlood', Array.from(L.events.values()).some((e) => /Proefoverleg 1$/.test(e.titel)));
    // filters: hooguit 20 per filter, alleen geldige id's
    const F = M.afwijsFilters(Array.from({ length: 45 }, (_, i) => 'ag-' + i).concat(['x', 'ag-1']));
    toets('❌: filters per 20, dubbel en ongeldig eruit', F.length === 3 && F[0].filters.length === 20 && F[2].filters.length === 5, F.map((f) => f.filters.length));
  }

  // ── wv3813: blokken ──
  const N = require(path.join(process.argv[2], 'agenda-narekenen.js'));
  const e = (id, kal, start, eind, extra) => Object.assign({ event_id: id, kalender: kal, start, einde: eind, hele_dag: false, status: 'confirmed', titel: 'Geheim ' + id, locatie: '', omschrijving: '' }, extra || {});
  // verzonnen afspraken (geen echte agenda); NU = ma 23-11-2026
  const AG = () => [
    e('h1', 'HAGRO', '2026-11-25T19:30:00+01:00', '2026-11-25T21:00:00+01:00', { titel: 'HAGRO proefvergadering', locatie: 'Proefplein 1, Amersfoort' }),
    e('w0', 'Werk', '2026-11-27T08:00:00+01:00', '2026-11-27T09:00:00+01:00', { locatie: 'Proefweg 2, Leusden' }),
    e('w1', 'Werk', '2026-11-27T10:00:00+01:00', '2026-11-27T11:00:00+01:00', { titel: 'Geheim werkoverleg Jansen', locatie: 'Utrecht' }),
    e('d1', 'David', '2026-11-30T14:00:00+01:00', '2026-11-30T15:00:00+01:00', { titel: 'Geheim met stuk', omschrijving: 'Stuk: https://app.socev.dev/10_Zakelijk/Proef/stuk%20a.md' }),
    e('g1', 'Gezin', '2026-11-26T10:00:00+01:00', '2026-11-26T11:00:00+01:00', { locatie: 'Rotterdam' }),
    e('d2', 'David', '2026-11-26T10:00:00+01:00', '2026-11-26T11:00:00+01:00', { locatie: 'Blaricum' }),
    e('d3', 'David', '2026-11-26T13:00:00+01:00', '2026-11-26T14:00:00+01:00', { locatie: 'Kerkstraat 5' }),
    e('d4', 'David', '2026-12-20T13:00:00+01:00', '2026-12-20T14:00:00+01:00', { locatie: 'Utrecht' }),
    e('d5', 'David', '2026-11-26T16:00:00+01:00', '2026-11-26T17:00:00+01:00', { locatie: 'Utrecht', status: 'cancelled' }),
    e('d6', 'David', '2026-11-28', '2026-11-29', { hele_dag: true, locatie: 'Utrecht' }),
  ];
  const blokAct = (L, a) => acties(L, a).filter((x) => /wv3813/.test(x.aanleiding || ''));
  {
    let agenda = AG(); let faal = false; let vraag = [];
    const L = nepLuik();
    const m = maak(() => [], L, { naam: 'blok', registerPad: REG2, mutatiesRonde: 10, plafondDag: 10, agenda: async (b) => { vraag.push(b); if (faal) throw new Error('x'); return { events: agenda }; } });
    let u = await m.ronde({ nu: NU });
    const pl = blokAct(L, 'socev_plaatsen');
    const rmA = N.reisMin('blaricum', 'amersfoort'), rmU = N.reisMin('leusden', 'utrecht');
    const hhmm = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
    const vA = Math.floor((19 * 60 + 30 - rmA) / 5) * 5, vU = Math.floor((10 * 60 - rmU) / 5) * 5;
    toets('blok: agenda gelezen morgen t/m +14 d met HAGRO', vraag.length === 1 && vraag[0].actie === 'agenda' && vraag[0].met_hagro === true && vraag[0].start === '2026-11-23', vraag);
    toets('blok: 5 blokken (3 vertrek, 2 voorbereiden)', u.blok_nieuw === 5 && pl.length === 5 && pl.some((x) => x.titel === '✏️ Vertrek naar Leusden (± ' + N.reisMin('blaricum', 'leusden') + ' min)' && x.eind === '2026-11-27T08:00'), pl.map((x) => x.titel));
    toets('vertrek Amersfoort vanaf thuis op de juiste tijd', pl.some((x) => x.titel === '✏️ Vertrek naar Amersfoort (± ' + rmA + ' min)' && x.start === '2026-11-25T' + hhmm(vA) && x.eind === '2026-11-25T19:30' && /thuis \(Blaricum\)/.test(x.omschrijving)), [rmA, pl]);
    toets('vertrek Utrecht vanaf de vorige afspraak (Leusden)', pl.some((x) => x.titel === '✏️ Vertrek naar Utrecht (± ' + rmU + ' min)' && x.start === '2026-11-27T' + hhmm(vU) && /vorige afspraak in Leusden/.test(x.omschrijving)), [rmU, pl]);
    toets('voorbereiden HAGRO: hele dag op de werkdag ervoor, met titel', pl.some((x) => x.start === '2026-11-24' && x.eind === '2026-11-25' && x.titel === '✏️ Voorbereiden: HAGRO proefvergadering (wo 19:30)'), pl);
    toets('voorbereiden met stuk: vrijdag vóór maandag, neutrale titel, stuklink', pl.some((x) => x.start === '2026-11-27' && x.titel === '✏️ Voorbereiden: afspraak van ma 30-11 14:00' && /\nStuk: https:\/\/app\.socev\.dev\/10_Zakelijk\/Proef\/stuk%20a\.md\n/.test(x.omschrijving)), pl);
    toets('MOET 1: geen David/Werk-titel in een blok', L.log.every((x) => !/Geheim/.test(JSON.stringify(x))), pl);
    toets('geen blok: Gezin, thuisplaats, onbekende plaats, > 14 d, geannuleerd, hele dag', !pl.some((x) => /Rotterdam|Blaricum\b.*min|2026-12-20|2026-11-26T1[0-6]|2026-11-28/.test(x.titel + x.start)), pl);
    toets('blokken zonder kaart, nooit deelnemers', acties(L, 'david_plaatsen').length === 0 && L.log.every((x) => x.attendees === undefined && x.recurrence === undefined));
    u = await m.ronde({ nu: NU + UUR });
    toets('blok: tweede ronde niets dubbel', u.blok_nieuw === 0 && blokAct(L, 'socev_plaatsen').length === 5 && blokAct(L, 'socev_verwijderen').length === 0, u);
    // afspraak weg → vertrekblok weg
    agenda = AG().filter((x) => x.event_id !== 'w1');
    u = await m.ronde({ nu: NU + 2 * UUR });
    const wegU = blokAct(L, 'socev_verwijderen');
    toets('afspraak weg → vertrekblok weg (vervallen)', u.blok_vervallen === 1 && wegU.length === 1 && !Array.from(L.events.values()).some((x) => /Utrecht/.test(x.titel)), u);
    // afspraak verplaatst → oud blok weg, nieuw blok
    agenda = AG().filter((x) => x.event_id !== 'w1').map((x) => (x.event_id === 'h1' ? Object.assign({}, x, { start: '2026-11-25T20:00:00+01:00' }) : x));
    u = await m.ronde({ nu: NU + 3 * UUR });
    const ams = Array.from(L.events.values()).filter((x) => /Amersfoort/.test(x.titel));
    toets('afspraak verplaatst → één vertrekblok op de nieuwe tijd', ams.length === 1 && ams[0].start === '2026-11-25T' + hhmm(Math.floor((20 * 60 - rmA) / 5) * 5), [u, ams]);
    // David haalt een blok weg → komt niet terug
    const vb = Array.from(L.events.values()).find((x) => /afspraak van ma 30-11/.test(x.titel));
    L.events.delete(vb.event_id);
    u = await m.ronde({ nu: NU + 4 * UUR });
    const u2 = await m.ronde({ nu: NU + 5 * UUR });
    toets('weggehaald blok → weg, komt niet terug', u.blok_weg === 1 && u2.blok_nieuw === 0 && !Array.from(L.events.values()).some((x) => /afspraak van ma 30-11/.test(x.titel)), [u, u2]);
    // fail-closed: agenda onleesbaar of met fouten → geen blokactie
    const voorN = blokAct(L, 'socev_plaatsen').length + blokAct(L, 'socev_verwijderen').length;
    faal = true; agenda = [];
    u = await m.ronde({ nu: NU + 6 * UUR });
    toets('agenda onleesbaar → geen blokactie', u.agenda_fout === 1 && blokAct(L, 'socev_plaatsen').length + blokAct(L, 'socev_verwijderen').length === voorN, u);
    faal = false;
    const m2 = maak(() => [], L, { naam: 'blok', registerPad: REG2, agenda: async () => ({ events: [], fouten: ['HAGRO'] }) });
    u = await m2.ronde({ nu: NU + 7 * UUR });
    toets('agenda met fouten → geen blokactie (niets weg)', u.agenda_fout === 1 && blokAct(L, 'socev_plaatsen').length + blokAct(L, 'socev_verwijderen').length === voorN, u);
    // verlopen
    agenda = AG();
    u = await m.ronde({ nu: Date.UTC(2026, 11, 2, 8, 0) });
    toets('blok na de afspraakdag → verlopen, geen schrijfactie', u.verlopen >= 2 && u.mutaties === 0, u);
    const stB = fs.readFileSync(path.join(TMP, 'blok.json'), 'utf8');
    toets('blokregister zonder titels of plaatsen', !/Geheim|HAGRO|Amersfoort|Utrecht/.test(stB));
  }
  {
    // registerpoort: zonder rij agenda-socev-blokken wordt de agenda niet eens gelezen
    const L = nepLuik(); let gelezen = 0;
    const m = maak(() => [], L, { naam: 'blokreg', agenda: async () => { gelezen++; return { events: AG() }; } });
    const u = await m.ronde({ nu: NU });
    toets('blokken zonder eigen registerrij → agenda niet gelezen, niets', gelezen === 0 && u.blok_nieuw === 0 && L.log.every((x) => x.actie === 'socev_lijst'), u);
    toets('info: blokken uit', m.info().blokken === false);
  }
  {
    // vergader-potlood met stuk onder 10_Zakelijk → voorbereidblok; ander potlood niet; gedeeld plafond en rem
    const L = nepLuik();
    const RR = [r(201, '2026-11-26', { hele_dag: false, begin: '19:30', precisie: 'minuut', onderwerp: 'Proef-ALV praktijk', stuk_pad: '10_Zakelijk/Proef/agenda alv.md' }),
      r(202, '2026-11-27', { hele_dag: false, begin: '12:00', precisie: 'minuut', onderwerp: 'Proeflunch', stuk_pad: '10_Zakelijk/Proef/lunch.md' }),
      r(203, '2026-11-30', { hele_dag: false, begin: '09:00', precisie: 'minuut', onderwerp: 'Proefoverleg prive', stuk_pad: '20_Prive/Proef/x.md' })];
    const m = maak(() => RR, L, { naam: 'blokpot', registerPad: REG2, agenda: async () => ({ events: AG() }) });
    const u1 = await m.ronde({ nu: NU });
    toets('gedeelde rem: 2 potloden (4 schrijfacties), nog geen blok', u1.nieuw === 2 && u1.blok_nieuw === 0 && u1.mutaties === 4, u1);
    const u2 = await m.ronde({ nu: NU + UUR });
    const u3 = await m.ronde({ nu: NU + 2 * UUR });
    const vandaagTotaal = acties(L, 'socev_plaatsen').length;
    toets('gedeeld dagplafond 5 (potloden + blokken)', vandaagTotaal === 5 && m.vandaagVol(NU), [u1, u2, u3, vandaagTotaal]);
    const u4 = await m.ronde({ nu: NU + 24 * UUR });
    const pl = acties(L, 'socev_plaatsen').map((x) => x.titel);
    toets('vergader-potlood met stuk → voorbereidblok met onderwerp', pl.indexOf('✏️ Voorbereiden: Proef-ALV praktijk (do 19:30)') >= 0, pl);
    toets('geen voorbereidblok voor lunch of privé-overleg', !pl.some((x) => /Voorbereiden: (Proeflunch|Proefoverleg prive)/.test(x)), pl);
  }
  {
    // proefmodus: blokken met SOCEV PROEF, ook zonder registerrij
    const L = nepLuik();
    const m = M.maak({ proef: true, registerPad: path.join(TMP, 'bestaat-niet.json'), gevonden: async () => ({ ok: true, regels: [] }), luik: L.f, oordeel: async () => ({}),
      staatPad: path.join(TMP, 'blokproef.json'), agenda: async () => ({ events: AG().filter((x) => x.event_id === 'h1') }) });
    const u = await m.ronde({ nu: NU });
    const pl = acties(L, 'socev_plaatsen');
    toets('proef: blokken SOCEV PROEF ✏️', u.blok_nieuw === 2 && pl.every((x) => x.titel.indexOf('SOCEV PROEF ✏️ ') === 0), pl.map((x) => x.titel));
  }

  // ── wv3978: alleen afspraken waar David zelf bij moet zijn (verzonnen namen en stukken) ──────────────────────────────────────
  {
    const ROOSTER = '---\novis_stuk: stk_r\nonderwerp: "RE: Nieuwe medewerker: Fenna Proefmans per 1-12-2026"\nafzender: "David Schaap <d.schaap@gmail.com>"\n---\n\n# RE\n\n## Mailtekst\n\nHoi Mirte,\n\nFenna werkt op dinsdag, woensdag en\ndonderdag, van 8 tot 17 uur (3 x 8,5 uur).\n\nMet vriendelijke groet,\nDavid\n';
    const ARBO = '---\novis_stuk: stk_a\nonderwerp: "Uitnodiging online spreekuur"\nafzender: "Arbodienst Proef <noreply@arbo.invalid>"\n---\n\n# Uitnodiging online spreekuur\n\nBeste mevrouw Proefstra,\n\nIn verband met uw ziekmelding nodigen wij u uit voor een online spreekuur.\nDatum en tijd: 25-11-2026 om 13:00 uur\n';
    const ECHT = '---\novis_stuk: stk_e\nonderwerp: "Uitnodiging overleg zorggroep"\nafzender: "Zorggroep Proef <secretariaat@zorggroep.invalid>"\n---\n\n# Uitnodiging\n\nBeste David,\n\nGraag nodigen we je uit voor een gesprek over de nieuwe contracten op 1-12-2026 om 14:00 uur, bij ons kantoor in Proefstad.\n';
    const STUK = { 'r.md': ROOSTER, 'a.md': ARBO, 'e.md': ECHT };
    const RR = [
      r(201, '2026-11-26', { hele_dag: false, begin: '08:00', eind: '17:00', precisie: 'minuut', onderwerp: 'RE: Nieuwe medewerker: Fenna Proefmans per 1-12-2026', regel: 'rel.weekdag@1+rol.toekomst_met_tijd',
        stuk_pad: '10_Zakelijk/Proef/Bronnen/r.md', zin: { voor: 'Fenna werkt op dinsdag, woensdag en ', treffer: 'donderdag, van 8 tot 17 uur', na: ' (3 x 8,5 uur).' } }),
      r(202, '2026-11-25', { hele_dag: false, begin: '13:00', eind: null, precisie: 'minuut', onderwerp: 'Uitnodiging online spreekuur', regel: 'num.d_m_jjjj@1+rol.toekomst_met_tijd',
        stuk_pad: '10_Zakelijk/Proef/Bronnen/Medewerkers/a.md', zin: { voor: 'Datum en tijd: ', treffer: '25-11-2026 om 13:00 uur', na: '' } }),
      r(203, '2026-12-01', { hele_dag: false, begin: '14:00', eind: null, precisie: 'minuut', onderwerp: 'RE: Uitnodiging overleg zorggroep', regel: 'num.d_m_jjjj@1+rol.toekomst_met_tijd',
        stuk_pad: '10_Zakelijk/Proef/Bronnen/e.md', zin: { voor: 'Graag nodigen we je uit voor een gesprek over de nieuwe contracten op ', treffer: '1-12-2026 om 14:00 uur', na: ', bij ons kantoor in Proefstad.' } }),
    ];
    // nietVoorDavid, puur
    const k = M.kandidaten(RR, '2026-11-23');
    const kk = (id) => k.find((x) => x.ids.indexOf(id) >= 0);
    toets('rooster/weekdag: geen afspraak van David', M.nietVoorDavid(kk(201), ROOSTER) === 'weekdag', M.nietVoorDavid(kk(201), ROOSTER));
    toets('weekdag zonder detectorregel: treffer zonder datum', M.nietVoorDavid(Object.assign({}, kk(201), { bronregels: [] }), ROOSTER) === 'weekdag');
    toets('rooster: "elke dinsdag" ook mét datum', M.nietVoorDavid({ bronregels: [], zin: { voor: 'Vanaf 1-12 elke dinsdag ', treffer: '1-12-2026 om 9:00', na: '' } }, null) === 'rooster');
    toets('rooster: "maandagen"', M.nietVoorDavid({ bronregels: [], zin: { voor: 'Zij werkt op maandagen en ', treffer: '2-12 om 9:00', na: '' } }, null) === 'rooster');
    toets('brief aan medewerker: map Medewerkers', M.nietVoorDavid(kk(202), ARBO) === 'medewerker', M.nietVoorDavid(kk(202), ARBO));
    toets('brief aan ander: aanhef "Beste mevrouw X" (ook buiten Medewerkers)', M.nietVoorDavid(Object.assign({}, kk(202), { stuk_pad: '10_Zakelijk/Proef/a.md' }), ARBO) === 'aan_ander');
    toets('echte uitnodiging aan David: geen harde nee', M.nietVoorDavid(kk(203), ECHT) === null, M.nietVoorDavid(kk(203), ECHT));
    toets('Davids eigen mail met aanhef aan ander: harde regel laat het aan het model', M.nietVoorDavid({ bronregels: [], zin: { voor: 'Zullen we ', treffer: '2-12-2026 om 10:00', na: ' afspreken?' } },
      '---\nafzender: "David Schaap <d.schaap@gmail.com>"\n---\n\nHoi Mirte,\n\nZullen we 2-12-2026 om 10:00 afspreken?\n') === null);
    toets('aanhef "Beste klant"/"Beste HCE-leden"/voornaam: geen harde nee', ['klant', 'HCE-leden', 'contactpersoon', 'Mirte', 'heer/mevrouw'].every((n) => M.nietVoorDavid({ bronregels: [] }, '---\nafzender: "x"\n---\n\nBeste ' + n + ',\n\nOverleg 2-12.\n') === null));
    toets('aanhef "Geachte heer Proef": harde nee', M.nietVoorDavid({ bronregels: [] }, '---\nafzender: "x"\n---\n\nGeachte heer Proef,\n\nOverleg 2-12.\n') === 'aan_ander');
    toets('groepsaanhef "Beste collega\'s": geen harde nee', M.nietVoorDavid({ bronregels: [] }, '---\nafzender: "x"\n---\n\nBeste collega\'s,\n\nOverleg 2-12.\n') === null);
    toets('zonderRe', M.zonderRe('RE: Fwd: AW: Overleg') === 'Overleg' && M.zonderRe('Antw: Re[2]: x') === 'x');
    toets('modelUit fail-closed', M.modelUit(null) === null && M.modelUit({ ok: false }) === null && M.modelUit({ ok: true, data: { oordeel: 'misschien' } }) === null
      && M.modelUit({ ok: true, data: { oordeel: 'twijfel', wat: 'x', titel: 'y' } }).v === 'nee' && M.modelUit({ ok: true, data: { oordeel: 'ja', wat: '', titel: 'Overleg' } }).v === 'nee'
      && M.modelUit({ ok: true, data: { oordeel: 'ja', wat: 'Gesprek met de zorggroep.', titel: 'RE: Gesprek zorggroep' } }).titel === 'Gesprek zorggroep');

    // ronde: rooster en arbobrief → geen kaart, geen modelvraag; echte uitnodiging → kaart met wat-zin
    const vragen = [];
    const model = async (sys, pr, sc) => { vragen.push(pr); return /zorggroep/.test(pr) ? { ok: true, data: { oordeel: 'ja', wat: 'Gesprek met de zorggroep over de nieuwe contracten, op hun kantoor in Proefstad.', titel: 'Gesprek zorggroep over contracten' } }
      : { ok: true, data: { oordeel: 'nee', wat: 'niet voor David', titel: 'x' } }; };
    let L = nepLuik();
    let m = maak(() => RR, L, { naam: 'david', mutatiesRonde: 10, lees: (p) => STUK[path.basename(p)] || null, model });
    let u = await m.ronde({ nu: NU });
    let pl = acties(L, 'socev_plaatsen'), kd = acties(L, 'david_plaatsen');
    toets('alleen de echte uitnodiging wordt potlood + kaart', u.nieuw === 1 && pl.length === 1 && kd.length === 1 && u.niet_david === 2, u);
    toets('rooster en arbobrief: geen modelvraag (harde regel)', vragen.length === 1 && /zorggroep/.test(vragen[0]), vragen.length);
    toets('kaart: titel van het model, zonder RE:', kd[0] && kd[0].titel === 'Gesprek zorggroep over contracten', kd[0] && kd[0].titel);
    toets('kaart: wat-zin in de omschrijving, dan het stuk', kd[0] && /^Gesprek met de zorggroep over de nieuwe contracten, op hun kantoor in Proefstad\.\nStuk: https:\/\/app\.socev\.dev\//.test(kd[0].omschrijving), kd[0] && kd[0].omschrijving);
    toets('potlood: wat-zin bovenaan, titel met ✏️', pl[0] && pl[0].titel === '✏️ Gesprek zorggroep over contracten' && /^Gesprek met de zorggroep/.test(pl[0].omschrijving), pl[0]);
    toets('modelvraag noemt datum, tijd en zin', /dinsdag 1-12-2026 om 14:00/.test(vragen[0]) && /\[1-12-2026 om 14:00 uur\]/.test(vragen[0]), vragen[0].slice(0, 300));
    u = await m.ronde({ nu: NU + UUR });
    toets('tweede ronde: nee onthouden, niets opnieuw gevraagd of gezet', u.nieuw === 0 && vragen.length === 1 && acties(L, 'david_plaatsen').length === 1, { u, n: vragen.length });
    const st2 = fs.readFileSync(path.join(TMP, 'david.json'), 'utf8');
    toets('oordelen in het register zonder titels of namen', !/zorggroep|Fenna|Proefstra|spreekuur/i.test(st2) && /"weekdag"/.test(st2) && /"medewerker"/.test(st2), st2.slice(0, 300));

    // model zegt nee / twijfel → geen kaart; modelfout → nu niet, na 3 fouten nee; geen model → fail-closed
    L = nepLuik(); vragen.length = 0;
    m = maak(() => [RR[2]], L, { naam: 'david-nee', lees: () => ECHT, model: async (s2, pr) => { vragen.push(pr); return { ok: true, data: { oordeel: 'twijfel', wat: 'onduidelijk', titel: 'x' } }; } });
    u = await m.ronde({ nu: NU });
    toets('model twijfel → geen potlood', u.nieuw === 0 && acties(L, 'socev_plaatsen').length === 0 && u.niet_david === 1, u);
    L = nepLuik(); let n = 0;
    m = maak(() => [RR[2]], L, { naam: 'david-fout', lees: () => ECHT, model: async () => { n++; return { ok: false, fout: 'claude weg' }; } });
    u = await m.ronde({ nu: NU });
    toets('modelfout → geen potlood, model_fout geteld', u.nieuw === 0 && u.model_fout === 1 && acties(L, 'socev_plaatsen').length === 0, u);
    await m.ronde({ nu: NU + UUR }); await m.ronde({ nu: NU + 2 * UUR }); u = await m.ronde({ nu: NU + 3 * UUR });
    toets('na 3 modelfouten: nee, niet meer gevraagd', n === 3 && u.model === 0 && acties(L, 'socev_plaatsen').length === 0, { n, u });
    L = nepLuik(); n = 0;
    m = maak(() => [RR[2], Object.assign({}, RR[2], { id: 204, van: '2026-12-02', onderwerp: 'Tweede uitnodiging' })], L, { naam: 'david-storing', mutatiesRonde: 10, lees: () => ECHT, model: async () => { n++; return { ok: false, fout: 'geen ruimte' }; } });
    u = await m.ronde({ nu: NU });
    toets('storing: na de eerste modelfout geen vragen meer deze ronde', n === 1 && u.model === 1, { n, u });
    L = nepLuik();
    m = M0.maak({ registerPad: REG, gevonden: async () => ({ ok: true, regels: [RR[2]] }), luik: L.f, oordeel: async () => ({}), staatPad: path.join(TMP, 'david-geen.json'), lees: () => ECHT });
    u = await m.ronde({ nu: NU });
    toets('zonder model: fail-closed, geen potlood', u.nieuw === 0 && acties(L, 'socev_plaatsen').length === 0 && u.model_fout === 1, u);
    L = nepLuik();
    m = maak(() => [RR[2]], L, { naam: 'david-geenstuk', lees: () => { throw new Error('weg'); } });
    u = await m.ronde({ nu: NU });
    toets('stuk onleesbaar: fail-closed', u.nieuw === 0 && acties(L, 'socev_plaatsen').length === 0, u);
    // HAGRO: wat-zin niet in de omschrijving (gedeelde agenda), wel in de titel van het model
    L = nepLuik();
    m = maak(() => [Object.assign({}, RR[2], { stuk_pad: '10_Zakelijk/HAGRO/e.md' })], L, { naam: 'david-hagro', lees: () => ECHT, model });
    u = await m.ronde({ nu: NU });
    kd = acties(L, 'david_plaatsen');
    toets('HAGRO-kaart: alleen stuklink in de omschrijving', kd.length === 1 && kd[0].agenda === 'hagro' && /^Stuk: https:\/\/app\.socev\.dev\/10_Zakelijk\/HAGRO\//.test(kd[0].omschrijving) && !/zorggroep over de nieuwe/.test(kd[0].omschrijving), kd[0]);
    // modelaantal per ronde begrensd
    L = nepLuik(); let nm = 0;
    const veel2 = Array.from({ length: 12 }, (_, i) => r(300 + i, '2026-12-0' + (1 + (i % 8)), { onderwerp: 'Vraag ' + i }));
    m = maak(() => veel2, L, { naam: 'david-max', mutatiesRonde: 40, plafondDag: 40, model: async () => { nm++; return { ok: true, data: { oordeel: 'nee', wat: 'x', titel: 'x' } }; } });
    u = await m.ronde({ nu: NU });
    toets('hooguit 6 modelvragen per ronde', nm === 6 && u.model === 6, { nm, u });
  }
  // geen titels in de staat
  const st = fs.readFileSync(path.join(TMP, 'p.json'), 'utf8');
  toets('register zonder titels', !/Proefoverleg/.test(st));
  toets('register 0600', (fs.statSync(path.join(TMP, 'p.json')).mode & 0o777) === 0o600);
  console.log('\n' + ok + ' ok, ' + fout + ' fout');
  process.exit(fout ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
EINDE
