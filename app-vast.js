'use strict';
// OVIS M1b (wv1051, ontwerplijnen § 2.3, § 4.2, § 4.3; David Ja 24-10 20:51, e1580d70): vastgezette plekken en Apps in het menu.
// Eén lijst voor alle apparaten in vast.json (app-data); alleen het podproces schrijft, via POST /app/vast. Een regel is alleen
// { scherm, focus? } (id's; nooit een naam: de naam komt live uit de module in de app, Fable 24-10 #9). De pod kent geen catalogus
// (§ 4.3): hij toetst alleen de vorm van een id. Hooguit vijf per plek bewaakt de app (die kent de plek van elke module); de pod
// houdt een harde grens op het geheel. Privé-Apps (de ene lijst privé-id's in server.js) en subkaarten (focus) gaan nooit naar een
// apparaat met een vaste plek, en zo'n apparaat zet niets vast (het ziet maar een deel van de lijst; losmaken mag wel).
// Logica zonder opslag of HTTP (drie lagen, § 4.4): server.js leest en schrijft het bestand en stuurt het antwoord.

const STANDAARD = [{ scherm: 'facturen' }, { scherm: 'bestanden' }];   // § 2.3: standaard vast, tot David zelf iets wijzigt
const MAX = 25;                                // vijf plekken × vijf; de grens per plek houdt de app
const SCHERM_RE = /^[a-z][a-z0-9-]{1,39}$/;    // module-id uit de catalogus (src/modules.ts)
const FOCUS_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,119}$/;   // subkaart-id (M2d); geen pad, geen spatie, geen naam

function regel(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const s = String(x.scherm || '');
  if (!SCHERM_RE.test(s)) return null;
  if (x.focus === undefined || x.focus === null || x.focus === '') return { scherm: s };
  const f = typeof x.focus === 'string' ? x.focus : '';
  return FOCUS_RE.test(f) ? { scherm: s, focus: f } : null;
}
const zelfde = (a, b) => a.scherm === b.scherm && (a.focus || '') === (b.focus || '');

// Van schijf: onbekende velden weg, dubbele en ongeldige regels weg, hooguit MAX. Geen bestand = de standaard.
function schoon(lijst) {
  const uit = [];
  (Array.isArray(lijst) ? lijst : []).forEach(function (x) {
    const r = regel(x);
    if (r && !uit.some(function (y) { return zelfde(y, r); }) && uit.length < MAX) uit.push(r);
  });
  return uit;
}
function uitBestand(j) {
  if (!j) return { lijst: STANDAARD.map(function (x) { return Object.assign({}, x); }), standaard: true };
  return { lijst: schoon(j.vast), standaard: false };
}

// Wat een apparaat te zien krijgt. Vaste plek: geen privé-App en geen subkaart (§ 2.3); de pod filtert vóór het uitleveren.
function voorApparaat(lijst, vastePlek, prive) {
  if (!vastePlek) return lijst.slice();
  return lijst.filter(function (x) { return !x.focus && prive.indexOf(x.scherm) < 0; });
}

// Eén wijziging. d = { actie: 'zet' | 'los', scherm, focus?, vervang?: { scherm, focus? } }.
// Uitkomst { ok: true, lijst, veranderd } of { ok: false, status, fout, reden }.
function pas(lijst, d, vastePlek) {
  const actie = d && d.actie;
  if (actie !== 'zet' && actie !== 'los') return { ok: false, status: 400, fout: 'onbekende actie', reden: 'vast actie' };
  const r = regel(d);
  if (!r) return { ok: false, status: 400, fout: 'ongeldig scherm', reden: 'vast scherm' };
  const nieuw = lijst.slice();
  const i = nieuw.findIndex(function (y) { return zelfde(y, r); });
  if (actie === 'los') {
    if (i < 0) return { ok: true, lijst: nieuw, veranderd: false };
    nieuw.splice(i, 1);
    return { ok: true, lijst: nieuw, veranderd: true };
  }
  if (vastePlek) return { ok: false, status: 403, fout: 'Vastzetten doe je op je telefoon of een meereizend apparaat; hier zie je maar een deel van de lijst.', reden: 'vast zet vanaf vaste plek' };
  if (d.vervang !== undefined) {   // vóór "al zo" (Fable diff #2): na een race tussen twee apparaten kan r al (onzichtbaar) vast staan
    const v = regel(d.vervang);
    const j = v ? nieuw.findIndex(function (y) { return zelfde(y, v); }) : -1;
    if (j < 0) return { ok: false, status: 409, fout: 'die regel staat niet (meer) vast; probeer het opnieuw', reden: 'vast vervang weg' };
    if (i >= 0) { nieuw.splice(j, 1); return { ok: true, lijst: nieuw, veranderd: true }; }
    nieuw.splice(j, 1, r);   // op de plek van de oude: de volgorde in het menu blijft
    return { ok: true, lijst: nieuw, veranderd: true };
  }
  if (i >= 0) return { ok: true, lijst: nieuw, veranderd: false };
  if (nieuw.length >= MAX) return { ok: false, status: 409, fout: 'er staat al te veel vast', reden: 'vast vol' };
  nieuw.push(r);
  return { ok: true, lijst: nieuw, veranderd: true };
}

module.exports = { STANDAARD, MAX, regel, schoon, uitBestand, voorApparaat, pas };
