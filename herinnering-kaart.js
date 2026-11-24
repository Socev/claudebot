'use strict';
// ── Herinneringen als Voor jou-kaart (wv3905, besluitenpagina nr 356 = 3C56, David Ja 22-11-2026 18:14) ──
// WAAROM. 11 van de 19 heartbeat-berichten waren een herinnering zonder knop; David typte standen terug ("is gedaan", "kan weg") en wat hij
// afhandelde kwam toch terug. Nu wordt een herinnering die iets van David vraagt een kaart in Voor jou met de uiterste datum en de knoppen die
// Voor jou al heeft: Gedaan, Later, Niet meer nodig. Het heartbeat-bericht noemt alleen nog wat en wanneer en wijst naar de kaart.
// HOE.
//  1. POST /herinnering/kaart (Socev met SOCEV_AGENT_SLEUTEL, of het pod-geheim): { sleutel: 'dl:…' } of { datum, titel } voor een
//     [jij]-regel uit 00_Systeem/Deadlines.md (## Actueel; zoeken zoals deadline-lijstje.js: op sleutel, anders datum + titel bij precies één
//     treffer), of { titel, datum, vrij: true } voor een herinnering zonder registerregel. Eén kaart per regel (sleutel herinnering-dl-<16>).
//     Bestaat de kaart al: niets nieuws (open → 'al open'; Later met de uiterste datum morgen of eerder → weer open; dicht → 'al dicht', dan
//     zwijgt de heartbeat). Een nieuwe kaart is meteen zichtbaar (spoed: de heartbeat koos het moment al) en de registerregel krijgt
//     "**GESEIND d-m HH:MM (in Voor jou).**" (zelfde merkteken als het actielijstje: de heartbeat seint hem dan pas weer de avond vóór de datum).
//  2. De tik gaat terug in het register met de sluitroute van wv3707 (deadline-lijstje.js pasToe/schrijf, plek 'Voor jou'), pas als de
//     ↩️-minuut van Voor jou voorbij is (150 s): Gedaan / Niet meer nodig = regel naar ## Afgehandeld › Afgehandeld via Voor jou; Later =
//     verzet-merkteken. Na een tik (timer) en elke 10 min (primaire pod).
//  3. Andersom: staat de regel niet meer onder ## Actueel maar wel onder ## Afgehandeld (Gedaan in het actielijstje, of met de hand), dan zet
//     de pod de open kaart op gedaan (door agent, met die reden). Alleen bij die zekere treffer; anders blijft de kaart staan.
// Een kaart heeft herkomst.module 'kalender' (OVIS Calendar toont dezelfde deadline): de Voor jou-ronde laat hem ongemoeid (modulekaart).
const crypto = require('crypto');
const DL = require('./deadline-lijstje.js');

const SLEUTEL_RE = /^herinnering-(?:dl|v)-[0-9a-f]{16}$/;
const DL_RE = /^dl:[0-9a-f]{40}$/;
const RUST_MS = DL.TIK_RUST_MS;              // 150 s: Voor jou neemt ↩️ tot 60 s; ruim erna
const TERUG_DAGEN = 4;                       // tikken van hooguit 4 dagen geleden (na een storing inhalen), niet de hele geschiedenis
const WEEKDAG = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];

function dagNr(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null; }
function echteDatum(s) { const n = dagNr(s); return n !== null && /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && new Date(n * 86400000).toISOString().slice(0, 10) === s; }
function plus(iso, n) { return new Date((dagNr(iso) + n) * 86400000).toISOString().slice(0, 10); }
function dm(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? (+m[3]) + '-' + (+m[2]) : '?'; }
function lang(iso) { const n = dagNr(iso); return n === null ? '?' : WEEKDAG[new Date(n * 86400000).getUTCDay()] + ' ' + dm(iso) + '-' + String(iso).slice(0, 4); }
function ymd(ms) { return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' }); }
function klok(ms) { return new Date(ms).toLocaleTimeString('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' }); }
function kort(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }

// Kaarttekst zonder wat David niet kan openen (de databank weigert wvN, podpaden, vaultpaden en .md-namen in een kaart): wikilinks naar hun
// laatste stuk (kaal), en zulke losse woorden eruit. De echte regel staat ongewijzigd in het register.
function schoon(t, n) {
  let s = DL.kaal(t)
    .replace(/(^|[^a-z0-9_])wv[0-9]+[a-z]?/gi, '$1')
    .replace(/\S*(?:mk-scripts\/|\/opt\/data\/)\S*/gi, '')
    .replace(/(^|[\s("'‘“/])[0-9]{2}_[A-Z][^\s|]*/g, '$1')
    .replace(/[^\s(]*\.md\b/gi, '')
    .replace(/\(\s*\)/g, '').replace(/\s+([,.;:])/g, '$1').replace(/\s+/g, ' ').trim();
  return kort(s, n);
}

function kaartSleutel(dl) { return 'herinnering-dl-' + String(dl).slice(3, 19); }
function vrijSleutel(titel, datum) { return 'herinnering-v-' + crypto.createHash('sha256').update(DL.norm(titel) + '|' + datum).digest('hex').slice(0, 16); }

// De kaart. item = { sleutel (dl:… of leeg), datum, titel, entiteit, actie }; vandaag = JJJJ-MM-DD.
function kaart(item, vandaag) {
  const vrij = !DL_RE.test(String(item.sleutel || ''));
  const wanneer = item.datum < vandaag ? 'was uiterlijk ' + dm(item.datum) : (item.datum === vandaag ? 'vandaag' : 'uiterlijk ' + dm(item.datum));
  const t = schoon(item.titel, 88 - wanneer.length - 3) || 'Herinnering';
  const actie = schoon(item.actie, 240), ent = schoon(item.entiteit, 60);
  const waarom = kort((vrij ? 'Herinnering' : 'Uit je deadlines') + ': uiterste datum ' + lang(item.datum) + (ent ? ' (' + ent + ')' : '') + '.'
    + (actie && DL.norm(actie) !== DL.norm(t) ? ' ' + actie.replace(/^David:\s*/i, '') : ''), 400);
  const stappen = [
    kort((actie ? actie.replace(/^David:\s*/i, '') : t), 200),
    vrij ? 'Geregeld? Tik Gedaan.' : 'Geregeld? Tik Gedaan: hij gaat dan ook uit je deadlines en Socev begint er niet meer over.',
    'Nog niet? Later laat hem terugkomen op de dag die je kiest. Niet meer nodig haalt hem weg' + (vrij ? '.' : ', ook uit je deadlines.'),
  ];
  return {
    sleutel: vrij ? vrijSleutel(item.titel, item.datum) : kaartSleutel(item.sleutel),
    soort: 'doen', titel: t + ' — ' + wanneer, waarom: waarom, stappen: stappen, deadline: item.datum, waar: 'overal',
    prive: /priv|gezin|famil|gezondheid/i.test(String(item.entiteit || '')),
    volgorde: item.datum <= plus(vandaag, 1) ? 5 : 30,
    herkomst: { module: 'kalender', handmatig: 'herinnering', herinnering: vrij ? { vrij: true } : { deadline: item.sleutel, datum: item.datum, titel: String(item.titel).slice(0, 200) } },
    spoed: 'herinnering',
  };
}

// Zoek de [jij]-regel. items = --droog; tekst = de pagina; v = { sleutel } of { datum, titel }. Geeft het item zoals DL.rijp het geeft, of null.
function vind(items, tekst, v) {
  let sl = DL_RE.test(String(v.sleutel || '')) ? v.sleutel : null, datum = v.datum;
  if (sl) { const it = (items || []).find(function (i) { return i && i.sleutel === sl; }); if (!it) return null; datum = it.datum; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(datum || ''))) return null;
  if (!sl) {
    const idx = DL.zoekRegel(String(tekst).split('\n'), items, { sleutel: null, datum: datum, titel: String(v.titel || '') });
    if (idx < 0) return null;
    const it = (items || []).find(function (i) { return i && i.bron && Number(i.bron.regel) === idx + 1 && i.datum === datum; });
    if (!it) return null;
    sl = it.sleutel;
  }
  // DL.rijp op de datum zelf neemt elke [jij]-regel van die datum mee (seinmoment ≤ datum), met de weergavetitel en de actie
  return DL.rijp(items, tekst, datum).find(function (i) { return i.sleutel === sl; }) || null;
}

// Welke kaarten nu een schrijfactie in het register vragen. punten = mk_voor_jou_lijst (p_alles). gedaan = Set van verwerkte merken.
function teDoen(punten, nu, gedaan) {
  const uit = [];
  for (const p of punten || []) {
    const h = p && p.herkomst && p.herkomst.herinnering;
    if (!p || !/^herinnering-dl-/.test(String(p.sleutel)) || !h || !DL_RE.test(String(h.deadline)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(h.datum))) continue;
    let keuze = null, op = null;
    if ((p.status === 'gedaan' || p.status === 'vervallen') && p.gesloten_door === 'david') { keuze = p.status === 'gedaan' ? 'gedaan' : 'laten_vallen'; op = Date.parse(p.gesloten_op || ''); }
    else if (p.status === 'later' && /David tikte Later/.test(String(p.bewijs || '')) && /^\d{4}-\d{2}-\d{2}/.test(String(p.later_tot || ''))) { keuze = 'later'; op = Date.parse(p.bijgewerkt || ''); }
    else continue;
    if (!Number.isFinite(op) || nu - op < RUST_MS || nu - op > TERUG_DAGEN * 86400000) continue;   // ↩️ kan nog, of te oud
    const later = keuze === 'later' ? String(p.later_tot).slice(0, 10) : '';
    const merk = crypto.createHash('sha256').update([p.sleutel, keuze, later, keuze === 'later' ? String(p.bewijs) : String(p.gesloten_op)].join('|')).digest('hex').slice(0, 24);
    if (gedaan && gedaan.has(merk)) continue;
    uit.push({ merk: merk, kaart: p.sleutel, sleutel: h.deadline, datum: h.datum, titel: String(h.titel || ''), keuze: keuze, later_tot: later, vandaag: ymd(op), plek: 'Voor jou' });
  }
  return uit;
}

// Open kaarten (open/later) met een registerregel: kandidaten om dicht te zetten als de regel al afgehandeld is.
function openKaarten(punten) {
  return (punten || []).filter(function (p) {
    const h = p && p.herkomst && p.herkomst.herinnering;
    return p && (p.status === 'open' || p.status === 'later') && /^herinnering-dl-/.test(String(p.sleutel)) && h && DL_RE.test(String(h.deadline)) && /^\d{4}-\d{2}-\d{2}$/.test(String(h.datum));
  });
}
// Staat de regel van kaart p niet meer onder ## Actueel maar wel (zeker: datum + titel in Wat) onder ## Afgehandeld?
function alAfgehandeld(tekst, items, p) {
  const h = p.herkomst.herinnering;
  const u = DL.pasToe(tekst, items, { sleutel: h.deadline, datum: h.datum, titel: String(h.titel || ''), keuze: 'gedaan', vandaag: h.datum, plek: 'Voor jou' });
  return !!(u && u.niets === 'al afgehandeld');
}

// Runner. o = { mag(), droog(), lees(), wijzig(f), lijst(): Promise<punten>, zet(p): Promise, status(body): Promise<{ok}>, log(s), vandaag(), nu() }
function maak(o) {
  const gedaan = new Set(), pogingen = new Map(), dicht = new Set();
  let bezig = null;
  const nu = function () { return o.nu ? o.nu() : Date.now(); };

  async function kaartVoor(v) {
    const vandaag = o.vandaag();
    if (o.mag && !o.mag()) return { ok: false, fout: 'passief' };
    let item = null;
    if (v.sleutel || v.datum) {   // ook bij vrij: staat hij toch in het register, dan de registerkaart (één kaart per regel)
      const tekst = o.lees(), items = (await o.droog()).items;
      item = vind(items, tekst, v);
      if (!item && !v.vrij) return { ok: false, fout: 'geen [jij]-regel onder Actueel gevonden (sleutel, of datum + een letterlijk stuk uit Wat)' };
    }
    if (!item) {
      if (!echteDatum(v.datum) || String(v.titel || '').trim().length < 4) return { ok: false, fout: 'vrije herinnering vraagt titel en een bestaande datum (JJJJ-MM-DD)' };
      // Codex MOET 1: de datum komt van een taalmodel; alleen een bestaande kalenderdag, hooguit 14 dagen terug en een jaar vooruit
      if (dagNr(v.datum) < dagNr(vandaag) - 14 || dagNr(v.datum) > dagNr(vandaag) + 366) return { ok: false, fout: 'uiterste datum ligt te ver weg (14 dagen terug tot een jaar vooruit)' };
      item = { sleutel: '', datum: v.datum, titel: String(v.titel).slice(0, 200), entiteit: String(v.entiteit || '').slice(0, 60), actie: String(v.wat || '').slice(0, 300) };
    }
    const k = kaart(item, vandaag);
    // Merkteken GESEIND … (in Voor jou) in de regel; idempotent ('al gemerkt'). Codex ronde 2 MOET 1: ook bij een bestaande kaart, zodat
    // een eerder mislukte schrijfactie (gelijktijdige wijziging) zich bij de volgende aanvraag herstelt.
    const merkZet = async function () {
      if (!item.sleutel) return null;
      const { u, ok } = await DL.schrijf(o, { sleutel: item.sleutel, datum: item.datum, titel: item.titel, keuze: 'getoond', vandaag: vandaag, tijd: klok(nu()), plek: 'Voor jou' });
      return u && u.tekst && ok ? 'gezet' : (u && u.niets) || 'niet gezet';
    };
    const bestaand = ((await o.lijst()) || []).find(function (p) { return p && p.sleutel === k.sleutel; });
    if (bestaand) {
      if (bestaand.status === 'open') return { ok: true, kaart: k.sleutel, al: 'open', titel: bestaand.titel, merkteken: await merkZet() };
      if (bestaand.status === 'later') {
        if (item.datum <= plus(vandaag, 1)) {
          const r = await o.status({ p_sleutel: k.sleutel, p_van: 'later', p_naar: 'open', p_door: 'agent', p_reden: 'herinnering: uiterste datum ' + item.datum + ' is morgen of eerder' });
          return { ok: true, kaart: k.sleutel, al: r && r.ok === true ? 'weer open' : 'later', later_tot: bestaand.later_tot, titel: bestaand.titel, merkteken: await merkZet() };
        }
        return { ok: true, kaart: k.sleutel, al: 'later', later_tot: bestaand.later_tot, titel: bestaand.titel, merkteken: await merkZet() };
      }
      return { ok: true, kaart: k.sleutel, al: 'dicht', status: bestaand.status, titel: bestaand.titel };
    }
    await o.zet(k);
    const merk = await merkZet();
    o.log('herinnering-kaart nieuw ' + k.sleutel + (item.sleutel ? ' merkteken ' + merk : ' (vrij)'));
    return { ok: true, kaart: k.sleutel, nieuw: true, titel: k.titel, merkteken: merk };
  }

  async function verwerk() {
    if (bezig) return bezig;
    bezig = (async function () {
      const uit = { register: 0, dicht: 0, niets: 0 };
      if (o.mag && !o.mag()) return uit;
      const punten = (await o.lijst()) || [];
      for (const t of teDoen(punten, nu(), gedaan)) {
        if (o.mag && !o.mag()) break;
        const { u, ok } = await DL.schrijf(o, t);
        if (u && u.tekst && ok) { gedaan.add(t.merk); uit.register++; o.log('herinnering-kaart ' + t.keuze + ' ' + t.kaart + ' regel ' + u.regel); }
        else if (u && u.niets && u.niets !== 'regel niet gevonden' && u.niets !== 'pagina veranderde') { gedaan.add(t.merk); uit.niets++; }
        else {
          const n = (pogingen.get(t.merk) || 0) + 1; pogingen.set(t.merk, n);
          if (n >= 3) gedaan.add(t.merk);
          uit.niets++; o.log('herinnering-kaart ' + t.keuze + ' ' + t.kaart + ' niet geschreven (' + n + '/3): ' + (u ? u.niets || 'pagina veranderde' : 'geen uitkomst'));
        }
      }
      const open = openKaarten(punten).filter(function (p) { return !dicht.has(p.sleutel); });
      if (open.length) {
        const tekst = o.lees(), items = (await o.droog()).items;
        for (const p of open) {
          if (o.mag && !o.mag()) break;
          if (!alAfgehandeld(tekst, items, p)) continue;
          const r = await o.status({ p_sleutel: p.sleutel, p_van: p.status, p_naar: 'gedaan', p_door: 'agent', p_bewijs: 'Staat in je deadlines al als afgehandeld.',
            p_reden: 'herinnering: registerregel staat onder Afgehandeld' });
          if (r && r.ok === true) { dicht.add(p.sleutel); uit.dicht++; o.log('herinnering-kaart dicht ' + p.sleutel + ' (regel al afgehandeld)'); }
        }
      }
      return uit;
    })();
    try { return await bezig; } finally { bezig = null; }
  }
  return { kaartVoor: kaartVoor, verwerk: verwerk };
}

module.exports = { kaart, vind, teDoen, openKaarten, alAfgehandeld, schoon, kaartSleutel, vrijSleutel, maak, SLEUTEL_RE, RUST_MS };
