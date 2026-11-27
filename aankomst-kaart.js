'use strict';
// wv4207 (besluitenpagina nr 499 = 3C199, David Ja 25-11-2026 22:09): het ochtendbericht in drie momenten. Moment 1 (wakker) is wv4161,
// moment 2 (onderweg) is wv4152; dit is moment 3: bij aankomst op de praktijk één kaart met wat op déze praktijk vandaag speelt en
// wie er werkt. Het vaste bericht van 07:00 blijft het vangnet (de kaart herhaalt alleen wat daarin staat). Ontwerp + Codex-
// ontwerpreview: mk-scripts/wv4207/ontwerp.md (GO-MET-WIJZIGINGEN; MOET 1: eerst 'te bezorgen' vastleggen, pas na succes 'bezorgd').
//
// Wanneer: ma–vr, 07:00–11:59 Nederlandse tijd (stille uren liggen erbuiten), zodra de telefoon (sb_app_locatie) klasse werk + een van de
// twee praktijken meldt (≤ 30 min oud) én de briefing van vandaag (het 07:00-deel) in het hoofdkanaal staat. Eén kaart per dag; de
// eerste praktijk telt. Niets voor die praktijk en geen rooster = geen kaart (stilte), wel vastgelegd als leeg.
// Inhoud zonder taalmodel: rooster uit de agenda-tijdlijn (soort dienst, feed rooster-tg-/rooster-gh-), de rubriek van die praktijk uit
// de briefing, en punten uit De drie / Ook vandaag / Je acties die de praktijk noemen.
//
// maak(o): o.staatPad, o.locatie() → {klasse, plek, leeftijd_s, toekomst}, o.rooster(ymd) → rijen van sb_kalender_tijdlijn,
//          o.briefing() → {dag, tekst, compleet} | null, o.melden(tekst, sleutel) (gooit als niet bezorgd), o.log(o), o.nu() (toets)
const fs = require('fs');

const VAN_UUR = 7, TOT_UUR = 12;          // 07:00–11:59
const LOCATIE_VERS_S = 30 * 60;
const MAX_REGELS = 12, REGEL_MAX = 300;
const POGINGEN_MAX = 6;
const DAGEN = 30;
const SLOT = 'Alles staat ook in je ochtendbericht.';
const PRAKTIJK = {
  Tolgaarde: { plek: /tolgaarde/i, feed: /(^|-)tg(-|$)/i, noem: /\btolgaarde\b/i },
  Groenhouten: { plek: /groenhouten/i, feed: /(^|-)gh(-|$)/i, noem: /\b(groenhouten|hap leusden)\b/i },
};
const TZ = 'Europe/Amsterdam';

function ams(ms) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
  return { ymd: p.year + '-' + p.month + '-' + p.day, uur: Number(p.hour), werkdag: ['Sat', 'Sun'].indexOf(p.weekday) < 0 };
}
function datumTekst(ymd) {
  const d = new Date(ymd + 'T12:00:00Z');
  return d.toLocaleDateString('nl-NL', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
}
function praktijkVan(plek) {
  const s = String(plek || '');
  return Object.keys(PRAKTIJK).find(function (k) { return PRAKTIJK[k].plek.test(s); }) || null;
}
// rooster: titels (initialen zoals in de agenda) van de diensten van vandaag op die praktijk, op volgorde, ontdubbeld
function roosterVoor(rijen, praktijk, ymd) {
  const P = PRAKTIJK[praktijk];
  if (!P) return [];
  const uit = [];
  (Array.isArray(rijen) ? rijen : []).map(function (x) { return x && typeof x === 'object' && x.sb_kalender_tijdlijn && !x.soort ? x.sb_kalender_tijdlijn : x; })
    .forEach(function (x) {
      if (!x || x.soort !== 'dienst' || x.status === 'geannuleerd' || !P.feed.test(String(x.feed || ''))) return;
      if (x.begin_datum && x.begin_datum > ymd) return;
      if (x.eind_datum && x.eind_datum < ymd) return;
      const t = String(x.titel || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (t && uit.indexOf(t) < 0) uit.push(t);
    });
  return uit;
}
const isKop = function (r) { return /^\s*\*\*[^*]+\*\*:?\s*$/.test(r) || /^\s*#/.test(r); };
const kopNaam = function (r) { return String(r).replace(/[*#_]/g, '').replace(/:\s*$/, '').trim().toLowerCase(); };
const isPunt = function (r) { return /^\s*(•|-|\*(?!\*)|\d+\.)\s+/.test(r); };
const alsPunt = function (r) { return '• ' + String(r).replace(/^\s*(•|-|\*|\d+\.)\s+/, '').trim(); };
const kort = function (r) { r = String(r).trim(); return r.length > REGEL_MAX ? r.slice(0, REGEL_MAX - 1) + '…' : r; };
// de briefing in stukken: [{kop, regels}] (kop null = vóór de eerste kop)
function stukken(tekst) {
  const uit = [{ kop: null, regels: [] }];
  String(tekst || '').split('\n').forEach(function (r) {
    if (!r.trim()) return;
    if (isKop(r)) uit.push({ kop: kopNaam(r), regels: [] });
    else uit[uit.length - 1].regels.push(r.trim());
  });
  return uit;
}
// puur: de kaart. Geeft {tekst, regels (inhoudsregels), uit_rubriek, uit_noem, punten_briefing, leeg}
function kaart(inv) {
  const praktijk = inv.praktijk, P = PRAKTIJK[praktijk];
  const st = stukken(inv.briefing);
  const rubriek = [], noem = [], gezien = new Set();
  const sleutel = function (r) { return alsPunt(r).toLowerCase().replace(/[^a-z0-9à-ü]+/g, ' ').trim(); };
  let puntenBriefing = 0;
  st.forEach(function (s) {
    s.regels.forEach(function (r) { if (isPunt(r)) puntenBriefing++; });
    if (s.kop === praktijk.toLowerCase()) {
      s.regels.forEach(function (r) {
        if (!isPunt(r) && !/^_[^_]+_$/.test(r)) return;   // alleen punten en tussenkopjes zoals _Wacht op jou_
        if (isPunt(r)) { const k = sleutel(r); if (gezien.has(k)) return; gezien.add(k); }
        rubriek.push(isPunt(r) ? alsPunt(r) : r);
      });
    } else if (s.kop && (/^de drie van vandaag$/.test(s.kop) || /^ook vandaag$/.test(s.kop) || /je acties van vandaag/.test(s.kop))) {
      s.regels.forEach(function (r) {
        if (!isPunt(r) || !P.noem.test(r)) return;
        const k = sleutel(r); if (gezien.has(k)) return; gezien.add(k);
        noem.push(alsPunt(r));
      });
    }
  });
  // lege tussenkopjes (geen punt eronder) weg
  const rub = rubriek.filter(function (r, i) { return !/^_[^_]+_$/.test(r) || (rubriek[i + 1] && !/^_[^_]+_$/.test(rubriek[i + 1])); });
  const rooster = Array.isArray(inv.rooster) ? inv.rooster : [];
  const inhoud = rub.filter(function (r) { return !/^_[^_]+_$/.test(r); }).length + noem.length;
  const leeg = !inhoud && !rooster.length;
  const l = ['**📍 Op ' + praktijk + ' — ' + datumTekst(inv.ymd) + '**'];
  if (rooster.length) l.push('Artsen vandaag: ' + rooster.join(', '));
  let n = 0, over = 0;
  const zet = function (r) { if (/^_[^_]+_$/.test(r)) { l.push(r); return; } if (n >= MAX_REGELS) { over++; return; } l.push(kort(r)); n++; };
  if (noem.length) { l.push(''); l.push('_Vandaag eerst_'); noem.forEach(zet); }   // uit De drie en je acties: het dringendst, dus bovenaan
  if (rub.length) { l.push(''); rub.forEach(zet); }
  if (!inhoud && rooster.length) { l.push(''); l.push('Voor ' + praktijk + ' staat er vandaag niets apart in je ochtendbericht.'); }
  if (over) l.push('… en nog ' + over + ' in je ochtendbericht.');
  // een tussenkopje zonder punt eronder (door de afkap) weg
  for (let i = l.length - 1; i >= 0; i--) if (/^_[^_]+_$/.test(l[i]) && (!l[i + 1] || !l[i + 1].trim() || /^_[^_]+_$/.test(l[i + 1]) || /^… en nog/.test(l[i + 1]))) l.splice(i, 1);
  l.push(''); l.push('_' + SLOT + '_');
  return { tekst: l.join('\n').replace(/\n{3,}/g, '\n\n'), regels: n, uit_rubriek: rub.filter(function (r) { return !/^_[^_]+_$/.test(r); }).length, uit_noem: noem.length,
    rooster: rooster.length, punten_briefing: puntenBriefing, leeg: leeg };
}

function maak(o) {
  const nu = o.nu || function () { return Date.now(); };
  const log = function (x) { try { if (o.log) o.log(x); } catch (e) {} };
  let laatste = null, wachtGelogd = null;
  function lees() {
    let j;
    try { j = JSON.parse(fs.readFileSync(o.staatPad, 'utf8')); }
    catch (e) { if (e && e.code === 'ENOENT') return { versie: 1, dagen: {} }; return null; }   // onleesbaar = niets doen (nooit dubbel)
    if (!j || typeof j !== 'object' || !j.dagen || typeof j.dagen !== 'object') return null;
    return j;
  }
  function schrijf(j) {
    const grens = Object.keys(j.dagen).sort().slice(0, Math.max(0, Object.keys(j.dagen).length - DAGEN));
    grens.forEach(function (d) { delete j.dagen[d]; });
    const t = o.staatPad + '.tmp';
    fs.writeFileSync(t, JSON.stringify(j, null, 1), { mode: 0o600 });
    fs.renameSync(t, o.staatPad);
  }
  async function bezorg(j, ymd) {
    const d = j.dagen[ymd];
    d.pogingen = (d.pogingen || 0) + 1;
    schrijf(j);
    try {
      await o.melden(d.tekst, 'aankomst:' + ymd);
      d.bezorgd = new Date(nu()).toISOString();
      delete d.tekst;   // na bezorging staat de tekst in het hoofdkanaal; hier alleen tellingen
      schrijf(j);
      log({ stap: 'bezorgd', praktijk: d.praktijk, regels: d.regels, poging: d.pogingen });
      return true;
    } catch (e) {
      log({ stap: 'bezorgen mislukt', poging: d.pogingen, fout: String(e && e.message || e).slice(0, 80) });
      return false;
    }
  }
  async function tik() {
    const k = ams(nu());
    if (!k.werkdag || k.uur < VAN_UUR || k.uur >= TOT_UUR) return { stap: 'buiten venster' };
    const j = lees();
    if (!j) return { stap: 'staat onleesbaar' };
    if (j.uit === true) return { stap: 'uit' };
    const d = j.dagen[k.ymd];
    if (d && (d.bezorgd || d.leeg)) return { stap: 'al gedaan' };
    if (d && d.tekst) {   // Codex MOET 1: vastgelegd maar (nog) niet bezorgd → opnieuw, met dezelfde sleutel
      if ((d.pogingen || 0) >= POGINGEN_MAX) return { stap: 'opgegeven' };
      return { stap: (await bezorg(j, k.ymd)) ? 'bezorgd' : 'mislukt' };
    }
    const loc = await o.locatie();
    const praktijk = loc && loc.klasse === 'werk' && !loc.toekomst && Number.isFinite(Number(loc.leeftijd_s)) && loc.leeftijd_s !== null &&
      Number(loc.leeftijd_s) <= LOCATIE_VERS_S ? praktijkVan(loc.plek) : null;
    if (!praktijk) return { stap: 'niet op de praktijk' };
    const b = await o.briefing();
    if (!b || b.dag !== k.ymd || !b.compleet) {
      if (wachtGelogd !== k.ymd) { wachtGelogd = k.ymd; log({ stap: 'wacht op briefing', praktijk: praktijk }); }
      return { stap: 'wacht op briefing' };
    }
    let rooster = [], roosterOk = true;
    try { rooster = roosterVoor(await o.rooster(k.ymd), praktijk, k.ymd); } catch (e) { roosterOk = false; log({ stap: 'rooster niet te lezen' }); }
    const kk = kaart({ praktijk: praktijk, ymd: k.ymd, briefing: b.tekst, rooster: rooster });
    const j2 = lees();   // vers: tussen de awaits door kan een andere tik geweest zijn
    if (!j2 || j2.uit === true || (j2.dagen[k.ymd] && (j2.dagen[k.ymd].bezorgd || j2.dagen[k.ymd].leeg || j2.dagen[k.ymd].tekst))) return { stap: 'al gedaan' };
    const rij = { praktijk: praktijk, t: new Date(nu()).toISOString(), regels: kk.regels, uit_rubriek: kk.uit_rubriek, uit_noem: kk.uit_noem,
      rooster: kk.rooster, rooster_ok: roosterOk, punten_briefing: kk.punten_briefing };
    if (kk.leeg) { rij.leeg = true; j2.dagen[k.ymd] = rij; schrijf(j2); laatste = Object.assign({ dag: k.ymd }, rij); log({ stap: 'leeg', praktijk: praktijk }); return { stap: 'leeg' }; }
    rij.tekst = kk.tekst; rij.pogingen = 0;
    j2.dagen[k.ymd] = rij;
    schrijf(j2);   // eerst vastleggen ('te bezorgen'), dan bezorgen
    const ok = await bezorg(j2, k.ymd);
    laatste = Object.assign({ dag: k.ymd }, rij, { tekst: undefined });
    return { stap: ok ? 'bezorgd' : 'mislukt' };
  }
  function info() {
    const j = lees();
    if (!j) return { aan: true, fout: 'staat onleesbaar' };
    const dagen = Object.keys(j.dagen).sort();
    const d = dagen.length ? j.dagen[dagen[dagen.length - 1]] : null;
    return { aan: j.uit !== true, laatste: d ? { dag: dagen[dagen.length - 1], praktijk: d.praktijk, regels: d.regels, leeg: !!d.leeg,
      bezorgd: !!d.bezorgd, pogingen: d.pogingen || 0 } : null, dagen_met_kaart: dagen.filter(function (x) { return j.dagen[x].bezorgd; }).length };
  }
  return { tik: tik, info: info, laatste: function () { return laatste; } };
}

module.exports = { maak: maak, kaart: kaart, roosterVoor: roosterVoor, praktijkVan: praktijkVan, ams: ams, SLOT: SLOT };
