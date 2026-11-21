#!/usr/bin/env bash
# Toets wv3741 (besluitenpagina nr 486 = 3C186): agenda-potlood.js met een nep-luik en verzonnen vondsten (geen echte agenda).
#   Nieuw (samenvoegen, filters, bron verplicht), nooit dubbel, plafond per dag en per ronde, weggehaald = klopt niet en komt niet
#   terug, overgenomen alleen bij nu_in agenda (review MOET 2), fail-closed, kaart-herkansing, verlopen, proefmodus, grenzen.
# Kruisproef: AP_MOD=<kopie zonder registercontrole> bash test/agenda-potlood.sh moet rood zijn.
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
node - "$HIER" "$TMP" <<'EINDE'
'use strict';
const path = require('path'), fs = require('fs');
const M = require(process.env.AP_MOD || path.join(process.argv[2], 'agenda-potlood.js'));
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
    if (b.actie === 'david_plaatsen') { if (L.faalKaart > 0) { L.faalKaart--; return { ok: false, knop_verstuurd: false, fout: 'kaart kon niet' }; } return { ok: false, oordeel: 'oranje', kaart: true, knop_verstuurd: true, knop_in: 'app' }; }
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
  // geen titels in de staat
  const st = fs.readFileSync(path.join(TMP, 'p.json'), 'utf8');
  toets('register zonder titels', !/Proefoverleg/.test(st));
  toets('register 0600', (fs.statSync(path.join(TMP, 'p.json')).mode & 0o777) === 0o600);
  console.log('\n' + ok + ' ok, ' + fout + ' fout');
  process.exit(fout ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
EINDE
