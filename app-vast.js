'use strict';
// OVIS M1b (wv1051, ontwerplijnen § 2.3, § 4.2, § 4.3; David Ja 24-10 20:51, e1580d70): vastgezette plekken en Apps in het menu.
// Eén lijst voor alle apparaten in vast.json (app-data); alleen het podproces schrijft, via POST /app/vast. Een regel is alleen
// { scherm, focus? } (id's; nooit een naam: de naam komt live uit de module in de app, Fable 24-10 #9). De pod kent geen catalogus
// (§ 4.3): hij toetst alleen de vorm van een id. Hooguit dertien per plek bewaakt de app (die kent de plek van elke module); de pod
// houdt een harde grens op het geheel. Privé-Apps (de ene lijst privé-id's in server.js) en subkaarten (focus) gaan nooit naar een
// apparaat met een vaste plek, en zo'n apparaat zet niets vast (het ziet maar een deel van de lijst; losmaken mag wel).
// Logica zonder opslag of HTTP (drie lagen, § 4.4): server.js leest en schrijft het bestand en stuurt het antwoord.

const STANDAARD = [{ scherm: 'facturen' }, { scherm: 'bestanden' }];   // § 2.3: standaard vast, tot David zelf iets wijzigt
const MAX = 65;                                // vijf plekken × dertien (menu-desktop, David 2-11-2026; was 5 × 5); de grens per plek houdt de app
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

// ── wv2479 (Apps-overzicht, richting 1 "Startscherm"; David Ja 5-11-2026 14:30): eigen volgorde, favorieten en sortering van de Apps
// (apps-volgorde.json naast vast.json, één stand voor telefoon en laptop) en een openingsteller per App per dag (apps-geopend.json,
// alleen aantallen). De weergave raster/lijst is per toestel en staat niet hier. Alleen App-id's uit APP_IDS (= de Apps in de
// catalogus src/modules.ts, plek "apps"; de toets test/apps-volgorde.test.ts in socev-app houdt ze gelijk). Een App die de pod nog
// niet kent, toont de app gewoon onderaan; ordenen en favoriet maken kan pas als hij hier staat.
const APP_IDS = ['praktijken', 'projecten', 'bandjes', 'financien', 'gezondheid', 'facturen', 'docplan', 'bestanden', 'pot',
  'pot-afschriften', 'studio', 'broedstoof', 'memorylane', 'tripper', 'kalender', 'shopper', 'pakjes', 'osint', 'mediatheek', 'harvester', 'ideeen',
  'flock', 'verbruik', 'tokencounter', 'sleutelbos', 'mail', 'mailman', 'cijfer-meester', 'ghawa', 'beleggen'];   // sleutelbos: wv2481; ghawa: wv2877; beleggen: wv2982
const VOLGORDE_MAX = 60;
const SORTERINGEN = ['eigen', 'az', 'meest'];
const TEL_DAGEN = 120;            // zo lang blijven dagtellingen staan
const TEL_DUBBEL_MS = 60 * 1000;  // twee keer dezelfde App binnen een minuut = één opening
const MEEST_NA_DAGEN = 14;        // "Meest gebruikt" pas na 14 dagen tellen
const MEEST_HALF_DAGEN = 30;      // een opening telt na 30 dagen half zo zwaar

const isAppId = function (x) { return typeof x === 'string' && APP_IDS.indexOf(x) >= 0; };
function idLijst(l) {   // van schijf: alleen bekende id's, zonder dubbele, hooguit VOLGORDE_MAX
  const uit = [];
  (Array.isArray(l) ? l : []).forEach(function (x) { if (isAppId(x) && uit.indexOf(x) < 0 && uit.length < VOLGORDE_MAX) uit.push(x); });
  return uit;
}
// Begin-favorieten = de Apps die in vast.json vastgezet zijn (zonder subkaarten), in die volgorde
function beginFavorieten(vastLijst) {
  return idLijst((Array.isArray(vastLijst) ? vastLijst : []).filter(function (r) { return r && !r.focus; }).map(function (r) { return r.scherm; }));
}
// Geen bestand = nog niets gekozen: volgorde leeg (= de catalogus), favorieten uit vast.json, sortering eigen, versie 0
function volgordeUitBestand(j, vastLijst) {
  if (!j) return { versie: 0, volgorde: [], favorieten: beginFavorieten(vastLijst), sortering: 'eigen', standaard: true };
  const v = Number(j.versie);
  return { versie: Number.isSafeInteger(v) && v > 0 ? v : 1, volgorde: idLijst(j.volgorde), favorieten: idLijst(j.favorieten),
    sortering: SORTERINGEN.indexOf(j.sortering) >= 0 ? j.sortering : 'eigen', standaard: false };
}
function strengeLijst(l, wat) {   // van de app: elk id moet bekend zijn, geen dubbele, hooguit VOLGORDE_MAX
  if (!Array.isArray(l)) return { fout: wat + ' ontbreekt', reden: 'volgorde ' + wat + ' vorm' };
  if (l.length > VOLGORDE_MAX) return { fout: 'te veel Apps in ' + wat, reden: 'volgorde ' + wat + ' te lang' };
  for (let i = 0; i < l.length; i++) {
    if (!isAppId(l[i])) return { fout: 'onbekende App in ' + wat, reden: 'volgorde ' + wat + ' onbekend' };
    if (l.indexOf(l[i]) !== i) return { fout: 'een App staat dubbel in ' + wat, reden: 'volgorde ' + wat + ' dubbel' };
  }
  return { lijst: l.slice() };
}
// Eén wijziging: d = { versie, volgorde, favorieten, sortering } (de hele stand). versie = de versie die de app had; is die intussen
// veranderd (ander toestel), dan 409 met de stand van nu (de app neemt die over). Uitkomst { ok, stand, veranderd } of { ok: false, status, fout, reden }.
function volgordePas(nu, d, vastePlek) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, status: 400, fout: 'ongeldige vraag', reden: 'volgorde vorm' };
  if (vastePlek) return { ok: false, status: 403, fout: 'Rangschikken doe je op je telefoon of een meereizend apparaat.', reden: 'volgorde vaste plek' };
  if (!Number.isSafeInteger(d.versie) || d.versie < 0) return { ok: false, status: 400, fout: 'versie ontbreekt', reden: 'volgorde versie vorm' };
  if (d.versie !== nu.versie) return { ok: false, status: 409, fout: 'de volgorde is intussen op een ander apparaat gewijzigd', reden: 'volgorde versie oud' };
  const v = strengeLijst(d.volgorde, 'volgorde'); if (v.fout) return { ok: false, status: 400, fout: v.fout, reden: v.reden };
  const f = strengeLijst(d.favorieten, 'favorieten'); if (f.fout) return { ok: false, status: 400, fout: f.fout, reden: f.reden };
  if (SORTERINGEN.indexOf(d.sortering) < 0) return { ok: false, status: 400, fout: 'onbekende sortering', reden: 'volgorde sortering' };
  const veranderd = nu.standaard || v.lijst.join() !== nu.volgorde.join() || f.lijst.join() !== nu.favorieten.join() || d.sortering !== nu.sortering;
  if (!veranderd) return { ok: true, stand: nu, veranderd: false };
  return { ok: true, veranderd: true, stand: { versie: nu.versie + 1, volgorde: v.lijst, favorieten: f.lijst, sortering: d.sortering, standaard: false } };
}
function naarBestand(stand, nuIso) {
  return { versie: stand.versie, bijgewerkt: nuIso, volgorde: stand.volgorde, favorieten: stand.favorieten, sortering: stand.sortering };
}
// Wat een apparaat ziet; vaste plek die afschermt: zonder privé-App (zoals vast.json)
function volgordeVoorApparaat(stand, vastePlek, prive) {
  const weg = function (l) { return vastePlek ? l.filter(function (x) { return prive.indexOf(x) < 0; }) : l.slice(); };
  return { versie: stand.versie, volgorde: weg(stand.volgorde), favorieten: weg(stand.favorieten), sortering: stand.sortering, standaard: !!stand.standaard };
}

// Openingsteller. t = { versie: 1, sinds: 'JJJJ-MM-DD', dagen: { 'JJJJ-MM-DD': { <id>: n } } }; laatst = Map id → ms (in het geheugen
// van het podproces: dubbel binnen een minuut telt één keer, ook van twee apparaten).
const DAG_RE = /^\d{4}-\d{2}-\d{2}$/;
const dagNr = function (d) { return Math.floor(Date.parse(d + 'T00:00:00Z') / 86400000); };
function tellingUitBestand(j) {
  const uit = { versie: 1, sinds: null, dagen: {} };
  if (!j || typeof j !== 'object') return uit;
  if (typeof j.sinds === 'string' && DAG_RE.test(j.sinds)) uit.sinds = j.sinds;
  const d = j.dagen && typeof j.dagen === 'object' ? j.dagen : {};
  Object.keys(d).forEach(function (dag) {
    if (!DAG_RE.test(dag) || !d[dag] || typeof d[dag] !== 'object') return;
    const r = {};
    Object.keys(d[dag]).forEach(function (id) { const n = Number(d[dag][id]); if (isAppId(id) && Number.isSafeInteger(n) && n > 0) r[id] = n; });
    if (Object.keys(r).length) uit.dagen[dag] = r;
  });
  return uit;
}
function telOpen(t, id, vandaag, nuMs, laatst) {
  if (!isAppId(id)) return { ok: false, status: 400, fout: 'onbekende App', reden: 'geopend onbekend' };
  if (!DAG_RE.test(String(vandaag))) return { ok: false, status: 500, fout: 'datum', reden: 'geopend datum' };
  const v = laatst.get(id);
  if (typeof v === 'number' && nuMs - v >= 0 && nuMs - v < TEL_DUBBEL_MS) return { ok: true, geteld: false, t: t };
  laatst.set(id, nuMs);
  const n = { versie: 1, sinds: t.sinds || vandaag, dagen: {} };
  const grens = dagNr(vandaag) - TEL_DAGEN;
  Object.keys(t.dagen).forEach(function (dag) { if (dagNr(dag) > grens) n.dagen[dag] = Object.assign({}, t.dagen[dag]); });
  n.dagen[vandaag] = n.dagen[vandaag] || {};
  n.dagen[vandaag][id] = (n.dagen[vandaag][id] || 0) + 1;
  return { ok: true, geteld: true, t: n };
}
// "Meest gebruikt": score per App (openingen, halveren per 30 dagen); klaar = er wordt al 14 dagen geteld
function meest(t, vandaag) {
  const nu = dagNr(vandaag);
  const dagen = t.sinds ? Math.max(0, nu - dagNr(t.sinds)) : 0;
  const score = {};
  Object.keys(t.dagen).forEach(function (dag) {
    const oud = nu - dagNr(dag);
    if (oud < 0) return;
    const w = Math.pow(0.5, oud / MEEST_HALF_DAGEN);
    Object.keys(t.dagen[dag]).forEach(function (id) { score[id] = Math.round(((score[id] || 0) + t.dagen[dag][id] * w) * 1000) / 1000; });
  });
  return { klaar: dagen >= MEEST_NA_DAGEN, dagen: dagen, na_dagen: MEEST_NA_DAGEN, score: score };
}

// ── wv2929 (OVIS als besturingssysteem, fase 4; David Ja 11-11-2026 16:24): eigen werkruimtes (werkruimtes.json naast apps-volgorde.json, één
// stand voor telefoon en laptop). Een werkruimte = een set tabs met hun indeling naast elkaar. De vijf standaardsets staan in de app
// (socev-app src/werkruimtes.ts); hier staat alleen wat David zelf bewaarde. Alleen vaste id's: de werkruimte uit WERKRUIMTE_IDS, de tabs als
// App-id (APP_IDS) of plek (intake, brain); geen namen, geen inhoud, geen apparaat. set null = terug naar de standaard.
const WERKRUIMTE_IDS = ['geld', 'praktijk', 'post', 'prive', 'brein', 'eigen'];
const WERKRUIMTE_PLEKKEN = ['intake', 'brain'];
const WERKRUIMTE_MAX = 8;   // = de grens van levende tabs op de pc
const isWrToken = function (x) { return isAppId(x) || (typeof x === 'string' && WERKRUIMTE_PLEKKEN.indexOf(x) >= 0); };
// Eén set: { tabs: [token], naast: [token] | null }. streng = van de app (fout bij elk afwijkend id); anders van schijf (stil opschonen).
function wrSet(x, streng) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return streng ? { fout: 'ongeldige werkruimte' } : null;
  if (!Array.isArray(x.tabs)) return streng ? { fout: 'tabs ontbreken' } : null;
  if (streng) {
    if (!x.tabs.length) return { fout: 'een werkruimte zonder tabs' };
    if (x.tabs.length > WERKRUIMTE_MAX) return { fout: 'te veel tabs (hooguit ' + WERKRUIMTE_MAX + ')' };
    for (let i = 0; i < x.tabs.length; i++) {
      if (!isWrToken(x.tabs[i])) return { fout: 'onbekende tab' };
      if (x.tabs.indexOf(x.tabs[i]) !== i) return { fout: 'een tab staat dubbel' };
    }
  }
  const tabs = [];
  x.tabs.forEach(function (t) { if (isWrToken(t) && tabs.indexOf(t) < 0 && tabs.length < WERKRUIMTE_MAX) tabs.push(t); });
  if (!tabs.length) return streng ? { fout: 'een werkruimte zonder tabs' } : null;
  let naast = null;
  if (x.naast !== undefined && x.naast !== null) {
    const ok = Array.isArray(x.naast) && x.naast.length >= 2 && x.naast.length <= 3
      && x.naast.every(function (t, i) { return tabs.indexOf(t) >= 0 && x.naast.indexOf(t) === i; });
    if (!ok && streng) return { fout: 'ongeldige indeling naast elkaar' };
    naast = ok ? x.naast.slice() : null;
  }
  return { tabs: tabs, naast: naast };
}
// Van schijf; geen bestand = alleen de standaard (versie 0)
function werkruimtesUitBestand(j) {
  const sets = {};
  if (j && j.sets && typeof j.sets === 'object') WERKRUIMTE_IDS.forEach(function (id) { const s = wrSet(j.sets[id], false); if (s) sets[id] = s; });
  const v = Number(j && j.versie);
  return { versie: j ? (Number.isSafeInteger(v) && v > 0 ? v : 1) : 0, sets: sets };
}
// Eén wijziging: d = { versie, id, set } (set null = standaard terug). Andere versie = 409 (ander apparaat); vaste plek = 403.
function werkruimtePas(nu, d, vastePlek) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, status: 400, fout: 'ongeldige vraag', reden: 'werkruimte vorm' };
  if (vastePlek) return { ok: false, status: 403, fout: 'Een werkruimte bewaren doe je op je telefoon of laptop.', reden: 'werkruimte vaste plek' };
  if (!Number.isSafeInteger(d.versie) || d.versie < 0) return { ok: false, status: 400, fout: 'versie ontbreekt', reden: 'werkruimte versie vorm' };
  if (d.versie !== nu.versie) return { ok: false, status: 409, fout: 'de werkruimtes zijn intussen op een ander apparaat gewijzigd', reden: 'werkruimte versie oud' };
  if (WERKRUIMTE_IDS.indexOf(d.id) < 0) return { ok: false, status: 400, fout: 'onbekende werkruimte', reden: 'werkruimte id' };
  const sets = Object.assign({}, nu.sets);
  if (d.set === null) {
    if (!sets[d.id]) return { ok: true, stand: nu, veranderd: false };
    delete sets[d.id];
  } else {
    const s = wrSet(d.set, true);
    if (s.fout) return { ok: false, status: 400, fout: s.fout, reden: 'werkruimte set' };
    const oud = sets[d.id];
    if (oud && oud.tabs.join() === s.tabs.join() && String(oud.naast) === String(s.naast)) return { ok: true, stand: nu, veranderd: false };
    sets[d.id] = s;
  }
  return { ok: true, veranderd: true, stand: { versie: nu.versie + 1, sets: sets } };
}
function werkruimtesNaarBestand(stand, nuIso) { return { versie: stand.versie, bijgewerkt: nuIso, sets: stand.sets }; }
// Wat een apparaat ziet; op een vaste plek zonder privé-App (zoals de Apps-volgorde); een indeling met minder dan twee over vervalt
function werkruimtesVoorApparaat(stand, vastePlek, prive) {
  const sets = {};
  Object.keys(stand.sets).forEach(function (id) {
    const s = stand.sets[id];
    const weg = function (l) { return vastePlek ? l.filter(function (x) { return prive.indexOf(x) < 0; }) : l.slice(); };
    const tabs = weg(s.tabs);
    const naast = s.naast ? weg(s.naast) : null;
    sets[id] = { tabs: tabs, naast: naast && naast.length >= 2 ? naast : null };
  });
  return { versie: stand.versie, sets: sets, ids: WERKRUIMTE_IDS, max: WERKRUIMTE_MAX };
}

module.exports = { STANDAARD, MAX, regel, schoon, uitBestand, voorApparaat, pas,
  APP_IDS, VOLGORDE_MAX, SORTERINGEN, beginFavorieten, volgordeUitBestand, volgordePas, naarBestand, volgordeVoorApparaat,
  tellingUitBestand, telOpen, meest, TEL_DUBBEL_MS, MEEST_NA_DAGEN,
  WERKRUIMTE_IDS, WERKRUIMTE_PLEKKEN, WERKRUIMTE_MAX, werkruimtesUitBestand, werkruimtePas, werkruimtesNaarBestand, werkruimtesVoorApparaat };   // wv2929
