'use strict';
/*
 * weer-ochtend.js — één weerregel in het ochtendbericht, alleen als het weer iets uitmaakt (wv2389, idee 28 meetpunt 3).
 * Ontwerp: vault "01_Ontwikkeling/Weer in het ochtendbericht (ontwerp 4-11-2026).md" (§ 2–6, § 10; OpenAI-review: vier MOET-punten).
 *
 * WAT. Nachtketenstap weer-ochtend (06:40): haalt de verwachting op bij OpenWeatherMap One Call 3.0 voor twee vakken (Thuis en de
 * praktijk; lat/lon op 1 decimaal, elke dag allebei, ook op vrije dagen: geen werkpatroon uit de aanroepen af te lezen), toetst de
 * drempels (§ 3) in de vensters (§ 4) en zet bij een treffer één rij in ochtend_buffer (bron 'weer', datum vandaag). De Dagelijkse
 * briefing zet die regel letterlijk onder de kop (niet via het taalmodel). Geen treffer = geen rij = niets in het ochtendbericht.
 *
 * STIL BIJ FOUT (§ 6). Geen sleutel, 401, time-out, netwerk: geen rij, geen bericht; de stap geeft ok:true met detail.fout. Pas als de
 * tweede dag op rij mislukt (laatste geslaagde ophaling ouder dan 1 dag) één box-rij (#weer-ochtend), daarna niet opnieuw tot er weer
 * een geslaagde dag was. Geen sleutel = altijd stil, ook zonder box-rij.
 *
 * GEHEIM. One Call wil de sleutel als appid in de URL: de URL wordt nooit gelogd of teruggegeven, foutmeldingen alleen als soort en
 * status, en elke tekst die de module teruggeeft gaat door masker(). Rem: hooguit 50 aanroepen per dag (teller in het staatbestand).
 *
 * Puur op de afhankelijkheden na: server.js geeft mee
 *   sleutel()            → Promise<string|null>               (kluis via de Management-API, niet op de witte lijst)
 *   plekken()            → Promise<[{naam, klasse, lat, lon}]> (lat/lon in de databank al op 1 decimaal afgerond)
 *   locatie()            → Promise<{plek, leeftijd_s}>        (sb_app_locatie, geen coördinaten)
 *   kalender(datum)      → Promise<[tijdlijnrij]>             (sb_kalender_tijdlijn van vandaag; titels alleen voor de dienstcode)
 *   ophalen(url)         → Promise<{status, json}>            (fetch; gooit bij netwerk/time-out)
 *   bufferZet(datum, t)  → Promise                             (upsert ochtend_buffer bron 'weer', teruggelezen)
 *   boxRij(tekst)        → bool
 *   log(o)               → void (velden-object, nooit een URL of sleutel)
 *   staatPad             → pad van het staatbestand (600)
 *   nu()                 → ms (toets)
 */
const fs = require('fs');

const BASIS = 'https://api.openweathermap.org/data/3.0/onecall';
const REM_PER_DAG = 50;
const DIENST_CODE = /^DS(\b|$)/;          // Davids roostercode op het artsenrooster (praktijk-werkrooster); geen naam in de code
const LOCATIE_VERS_S = 30 * 60;          // § 4: locatie ≤ 30 min oud
const REGEL_MAX = 160;

function ams(ms) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
  return { datum: p.year + '-' + p.month + '-' + p.day, uur: Number(p.hour), min: Number(p.minute) };
}
function minVan(ms) { const a = ams(ms); return a.uur * 60 + a.min; }   // minuut van de dag in NL-tijd
function hhmm(m) { return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); }
function eenDec(x) { return Math.round(Number(x) * 10) / 10; }
function getal(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function mmTekst(x) { const r = Math.max(0.5, Math.round(x * 2) / 2); return (Number.isInteger(r) ? String(r) : r.toFixed(1)).replace('.', ','); }

// § 3: één uur uit de verwachting; dt = begin van het uur (unix s)
function uurRegen(u) { return getal(u.pop) >= 0.6 && getal(u.rain && u.rain['1h']) >= 0.5; }
function uurNeerslag(u) { return getal(u.rain && u.rain['1h']) > 0 || getal(u.snow && u.snow['1h']) > 0; }
function uurId(u) { return u && Array.isArray(u.weather) && u.weather[0] ? Number(u.weather[0].id) : 0; }
function uurOnweer(u) { const id = uurId(u); return id >= 200 && id <= 232; }
function uurStorm(u) { return getal(u.wind_gust) >= 20; }
function uurGlad(u, vorig) {
  if (!(u.temp != null && Number(u.temp) <= 1)) return false;
  const id = uurId(u);
  return (id >= 600 && id <= 622) || id === 511 || uurNeerslag(u) || (!!vorig && uurNeerslag(vorig));
}

// uren van vandaag (NL) die een venster [van, tot) in minuten raken; met het vorige uur erbij (voor gladheid)
function urenIn(j, datum, van, tot) {
  const h = Array.isArray(j && j.hourly) ? j.hourly : [];
  const uit = [];
  for (let i = 0; i < h.length; i++) {
    const u = h[i], ms = Number(u && u.dt) * 1000;
    if (!Number.isFinite(ms)) continue;
    const a = ams(ms);
    if (a.datum !== datum) continue;
    const m = a.uur * 60 + a.min;
    if (m < tot && m + 60 > van) uit.push({ u: u, m: m, vorig: i > 0 ? h[i - 1] : null });
  }
  return uit;
}

// § 4: werkdag, vensters en de praktijk uit de tijdlijn van vandaag
function dagBeeld(rijen, datum) {
  const l = (Array.isArray(rijen) ? rijen : []).map(function (x) { return x && typeof x === 'object' && x.sb_kalender_tijdlijn && !x.soort ? x.sb_kalender_tijdlijn : x; }).filter(Boolean);
  let dienst = null;
  for (const x of l) {
    if (x.soort !== 'dienst' || x.status === 'geannuleerd') continue;
    if (x.begin_datum && x.begin_datum > datum) continue;
    if (x.eind_datum && x.eind_datum < datum) continue;
    if (!DIENST_CODE.test(String(x.titel || '').trim())) continue;
    dienst = /(^|-)gh(-|$)/i.test(String(x.feed || '')) ? 'Groenhouten' : 'Tolgaarde';
    if (dienst === 'Groenhouten') break;
  }
  const getimed = function (agenda) {
    return l.filter(function (x) { return x.soort === 'afspraak' && x.sync_agenda === agenda && x.begin_tijd && x.status !== 'geannuleerd'; })
      .map(function (x) { const b = Date.parse(x.begin_tijd), e = Date.parse(x.eind_tijd || x.begin_tijd); return { b: b, e: Number.isFinite(e) ? e : b }; })
      .filter(function (x) { return Number.isFinite(x.b) && ams(x.b).datum === datum; });
  };
  const werk = getimed('werk'), eigen = getimed('david').concat(werk);
  const werkdag = !!dienst || werk.length > 0;
  // vertrekvenster: 07:00 tot de eerste getimede afspraak (eigen of Werk) als die vóór 10:00 begint, anders 07:00–09:00. Begint de
  // eerste afspraak om of vóór 07:00, dan is hij al onderweg: geen vertrekvenster (OpenAI-diffreview wv2389 MOET 1).
  const eerste = eigen.map(function (x) { return minVan(x.b); }).sort(function (a, b) { return a - b; })[0];
  const vertrek = eerste != null && eerste <= 7 * 60 ? null : { van: 7 * 60, tot: eerste != null && eerste <= 10 * 60 ? eerste : 9 * 60 };
  // terugvenster: einde van de laatste getimede Werk-afspraak tot + 60 min, anders 16:30–19:00
  const laatste = werk.map(function (x) { return x.e; }).sort(function (a, b) { return b - a; })[0];
  const terug = laatste && ams(laatste).datum === datum ? { van: minVan(laatste), tot: Math.min(24 * 60, minVan(laatste) + 60) } : { van: 16 * 60 + 30, tot: 19 * 60 };
  return { werkdag: werkdag, praktijk: dienst || 'Tolgaarde', vertrek: vertrek, terug: terug };
}

// § 3: de treffers van vandaag, in volgorde van gewicht (waarschuwing eerst); elk deel is een korte zin zonder "Weer:"
function treffers(thuis, praktijk, beeld, datum, thuisOm0640) {
  const delen = [];
  // KNMI-waarschuwing (ontdubbeld): geldt vandaag tussen 06:00 en 22:00. Het praktijkvak telt alleen op een werkdag (diffreview MOET 2);
  // opgehaald wordt het wel elke dag (geen werkpatroon in de aanroepen).
  const gezien = {};
  (beeld.werkdag ? [thuis, praktijk] : [thuis]).forEach(function (j) {
    (Array.isArray(j && j.alerts) ? j.alerts : []).forEach(function (a) {
      const s = Number(a.start) * 1000, e = Number(a.end) * 1000;
      if (!Number.isFinite(s) || !Number.isFinite(e)) return;
      const sd = ams(s), ed = ams(e);
      const sMin = sd.datum < datum ? 0 : sd.datum > datum ? 24 * 60 : sd.uur * 60 + sd.min;
      const eMin = ed.datum > datum ? 24 * 60 : ed.datum < datum ? 0 : ed.uur * 60 + ed.min;
      if (!(sMin < 22 * 60 && eMin > 6 * 60)) return;
      const naam = String(a.event || 'waarschuwing').replace(/\s+/g, ' ').trim().slice(0, 50);
      const k = naam.toLowerCase() + '|' + e;
      if (gezien[k]) return;
      gezien[k] = true;
      const knmi = /knmi/i.test(naam) || !/knmi/i.test(String(a.sender_name || '')) ? '' : 'KNMI ';
      const tot = ed.datum === datum ? ' tot ' + hhmm(ed.uur * 60 + ed.min) : ed.datum > datum ? ' tot morgen ' + hhmm(ed.uur * 60 + ed.min) : '';
      delen.push({ soort: 'waarschuwing', zin: knmi + naam + tot });
    });
  });
  // gladheid 06:00–10:00 (Thuis) en in het terugvenster (praktijk, op een werkdag)
  const glad = urenIn(thuis, datum, 6 * 60, 10 * 60).filter(function (x) { return uurGlad(x.u, x.vorig); });
  if (glad.length) delen.push({ soort: 'gladheid', zin: 'vanochtend tot ' + hhmm(glad[glad.length - 1].m + 60) + ' kans op gladheid' });
  if (beeld.werkdag) {
    const g2 = urenIn(praktijk, datum, beeld.terug.van, beeld.terug.tot).filter(function (x) { return uurGlad(x.u, x.vorig); });
    if (g2.length) delen.push({ soort: 'gladheid', zin: 'rond ' + hhmm(g2[0].m) + ' kans op gladheid op je terugrit' });
  }
  // storm 07:00–21:00 (Thuis)
  const storm = urenIn(thuis, datum, 7 * 60, 21 * 60).filter(function (x) { return uurStorm(x.u); });
  if (storm.length) {
    const max = storm.reduce(function (a, x) { return Math.max(a, getal(x.u.wind_gust)); }, 0);
    delen.push({ soort: 'storm', zin: 'windstoten tot ' + Math.round(max * 3.6 / 5) * 5 + ' km/u (vanaf ' + hhmm(storm[0].m) + ')' });
  }
  // onweer 07:00–21:00 (Thuis)
  const onw = urenIn(thuis, datum, 7 * 60, 21 * 60).filter(function (x) { return uurOnweer(x.u); });
  if (onw.length) delen.push({ soort: 'onweer', zin: onw.length > 1 ? 'kans op onweer tussen ' + hhmm(onw[0].m) + ' en ' + hhmm(onw[onw.length - 1].m + 60) : 'kans op onweer rond ' + hhmm(onw[0].m) });
  // regen bij vertrek (werkdag, alleen als David om 06:40 nog thuis is) en op de terugrit (praktijk)
  if (beeld.werkdag && thuisOm0640 && beeld.vertrek) {
    const r = urenIn(thuis, datum, beeld.vertrek.van, beeld.vertrek.tot).filter(function (x) { return uurRegen(x.u); });
    if (r.length) delen.push({ soort: 'regen_vertrek', zin: 'rond ' + hhmm(r[0].m) + ' regen als je vertrekt (± ' + mmTekst(r.reduce(function (a, x) { return a + getal(x.u.rain['1h']); }, 0)) + ' mm)' });
  }
  if (beeld.werkdag) {
    const r = urenIn(praktijk, datum, beeld.terug.van, beeld.terug.tot).filter(function (x) { return uurRegen(x.u); });
    if (r.length) delen.push({ soort: 'regen_terug', zin: 'rond ' + hhmm(r[0].m) + ' regen op je terugrit (± ' + mmTekst(r.reduce(function (a, x) { return a + getal(x.u.rain['1h']); }, 0)) + ' mm)' });
  }
  // hitte: dagmaximum ≥ 30 °C (Thuis)
  const dg = Array.isArray(thuis && thuis.daily) ? thuis.daily.find(function (d) { return ams(Number(d.dt) * 1000).datum === datum; }) : null;
  const tmax = dg && dg.temp ? Number(dg.temp.max) : NaN;
  if (Number.isFinite(tmax) && tmax >= 30) delen.push({ soort: 'hitte', zin: 'warm, tot ' + Math.round(tmax) + ' °C' });
  return delen;
}

// één regel, hooguit ± 160 tekens; delen die niet passen vallen weg (de zwaarste staan vooraan)
function regel(delen) {
  if (!delen.length) return '';
  let t = 'Weer: ';
  let n = 0;
  for (const d of delen) {
    const z = (n === 0 ? d.zin.charAt(0).toUpperCase() + d.zin.slice(1) : d.zin);
    const bij = (n ? '; ' : '') + z;
    if (n && (t + bij + '.').length > REGEL_MAX) continue;
    t += bij; n++;
  }
  if (t.length + 1 > REGEL_MAX) t = t.slice(0, REGEL_MAX - 2).replace(/\s+\S*$/, '') + '…';
  return t + '.';
}

function maak(o) {
  let laatst = null;
  let sleutelNu = null;
  const masker = function (s) { s = String(s == null ? '' : s); if (sleutelNu && sleutelNu.length >= 8) s = s.split(sleutelNu).join('[sleutel]'); return s.replace(/appid=[^&\s]*/gi, 'appid=[sleutel]'); };
  const nu = function () { return o.nu ? o.nu() : Date.now(); };
  function staatLees() {
    try { const s = JSON.parse(fs.readFileSync(o.staatPad, 'utf8')); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; }
    catch (e) { return {}; }
  }
  function staatZet(s) {
    const tmp = o.staatPad + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(tmp, o.staatPad);
  }
  function vak(p) { return { lat: eenDec(p.lat), lon: eenDec(p.lon) }; }
  async function eenAanroep(s, v, datum, sl) {
    if (s.teller_datum !== datum) { s.teller_datum = datum; s.teller = 0; }
    if ((s.teller | 0) >= REM_PER_DAG) return { fout: 'rem ' + REM_PER_DAG + ' per dag' };
    s.teller = (s.teller | 0) + 1;
    try { staatZet(s); } catch (e) { /* teller in het geheugen houdt het deze ronde bij */ }
    const url = BASIS + '?lat=' + v.lat.toFixed(1) + '&lon=' + v.lon.toFixed(1) + '&units=metric&lang=nl&exclude=minutely,current&appid=' + encodeURIComponent(sl);
    let r;
    try { r = await o.ophalen(url); }
    catch (e) { return { fout: e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'time-out' : 'netwerk' }; }
    if (!r || r.status !== 200) return { fout: 'http ' + (r ? r.status : '?') };
    if (!r.json || typeof r.json !== 'object' || !Array.isArray(r.json.hourly)) return { fout: 'antwoord zonder uurverwachting' };
    return { j: r.json };
  }
  async function haal(s, v, datum, sl) {   // één herkansing per plek (§ 2), niet bij de rem of een 401
    let r = await eenAanroep(s, v, datum, sl);
    if (r.fout && !/^rem|^http 401/.test(r.fout)) r = await eenAanroep(s, v, datum, sl);
    return r;
  }

  // a = { datum, uur, min } (NL-tijd, van de nachtketen); droog = rekenen en tonen, niets in de buffer en geen box-rij
  async function doe(opt) {
    opt = opt || {};
    const a = opt.ams || ams(nu());
    const datum = a.datum, droog = !!opt.droog;
    const s = staatLees();
    if (!droog && s.klaar_datum === datum) return { ok: true, al_gedaan: true };
    if (!droog && a.uur * 60 + a.min >= 7 * 60) {   // na 07:00 is de briefing al weg: geen aanroepen verspillen
      return { ok: true, al_gedaan: true, detail: { te_laat: true } };
    }
    const mislukt = function (soort) {
      soort = masker(soort).slice(0, 80);
      const uit = { ok: true, detail: { fout: soort } };
      laatst = { op: new Date(nu()).toISOString(), fout: soort };
      if (droog) return Object.assign(uit, { droog: true });
      if (!s.fout_sinds) s.fout_sinds = datum;
      s.klaar_datum = datum;
      s.laatste_fout = soort;
      if (s.fout_sinds < datum && !s.box_gemeld && soort !== 'geen sleutel') {
        const ok = o.boxRij('\n## [log] ' + datum + ' ' + hhmm(a.uur * 60 + a.min) + ' — Weer in het ochtendbericht: tweede dag op rij geen verwachting opgehaald #weer-ochtend\n' +
          '- status: open\n- van: pod (nachtketenstap weer-ochtend, weer-ochtend.js; wv2389)\n' +
          '- gemeten: laatste geslaagde ophaling ' + (s.laatste_ok || 'nooit') + '; mislukt sinds ' + s.fout_sinds + '; vandaag: ' + soort + '; aanroepen vandaag ' + (s.teller | 0) + ' (rem ' + REM_PER_DAG + ').\n' +
          '- gevolg als er niets gebeurt: geen weerregel in het ochtendbericht, ook niet bij gladheid, storm of een KNMI-waarschuwing. David merkt het niet (stil).\n' +
          '- voorstel: soort fout nalopen (http 401 = sleutel ingetrokken of abonnement One Call 3.0 uit; rem = te veel aanroepen; time-out/netwerk = OpenWeatherMap of uitgaand verkeer). Staat in /opt/data/scripts-staat/klokken/weer-ochtend.json; deze melding komt pas terug na een geslaagde dag.\n');
        if (ok) s.box_gemeld = true;
      }
      try { staatZet(s); } catch (e) { /* stil */ }
      if (o.log) o.log({ opdracht: 'weer-ochtend', ok: false, fout: soort, aanroepen: s.teller | 0 });
      return uit;
    };
    let sl;
    try { sl = await o.sleutel(); } catch (e) { return mislukt('kluis niet leesbaar'); }
    if (!sl) return mislukt('geen sleutel');
    sleutelNu = String(sl);
    let pl, loc, kal;
    try { pl = await o.plekken(); } catch (e) { return mislukt('plekken niet leesbaar'); }
    const plek = function (naam) { return (pl || []).find(function (p) { return p && (p.naam === naam || (naam === 'Thuis' && p.klasse === 'thuis') || String(p.naam || '').indexOf(naam) >= 0) && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)); }); };
    try { kal = await o.kalender(datum); } catch (e) { kal = null; }
    try { loc = await o.locatie(); } catch (e) { loc = null; }
    const beeld = dagBeeld(kal || [], datum);
    const pThuis = plek('Thuis'), pPraktijk = plek(beeld.praktijk) || plek('Tolgaarde');
    if (!pThuis || !pPraktijk) return mislukt('plek Thuis of praktijk ontbreekt');
    const thuisOm0640 = !!(loc && loc.plek === 'Thuis' && Number.isFinite(Number(loc.leeftijd_s)) && Number(loc.leeftijd_s) <= LOCATIE_VERS_S);
    const vT = vak(pThuis), vP = vak(pPraktijk);
    const rT = await haal(s, vT, datum, sl);
    if (rT.fout) return mislukt('thuis: ' + rT.fout);
    const zelfdeVak = vP.lat === vT.lat && vP.lon === vT.lon;
    const rP = zelfdeVak ? rT : await haal(s, vP, datum, sl);
    if (rP.fout) return mislukt('praktijk: ' + rP.fout);
    const delen = treffers(rT.j, rP.j, beeld, datum, thuisOm0640);
    const tekst = masker(regel(delen));
    const detail = { treffers: delen.map(function (d) { return d.soort; }), werkdag: beeld.werkdag, praktijk: beeld.praktijk, thuis_0640: thuisOm0640,
      kalender: kal ? 'gelezen' : 'niet leesbaar', aanroepen: s.teller | 0, waarschuwingen: ((rT.j.alerts || []).length) + '/' + ((rP.j.alerts || []).length) };
    if (droog) { laatst = { op: new Date(nu()).toISOString(), droog: true, treffers: delen.length }; return { ok: true, droog: true, regel: tekst, detail: detail }; }
    if (tekst) {
      try { await o.bufferZet(datum, tekst); } catch (e) { return mislukt('buffer niet gezet (' + masker(String(e && e.message || e)).replace(/https?:\S+/g, '[url]').slice(0, 40) + ')'); }
    }
    Object.assign(s, { klaar_datum: datum, laatste_ok: datum, regel_datum: tekst ? datum : s.regel_datum || null });
    delete s.fout_sinds; delete s.box_gemeld; delete s.laatste_fout;
    try { staatZet(s); } catch (e) { /* stil; morgen opnieuw */ }
    laatst = { op: new Date(nu()).toISOString(), treffers: delen.length };
    if (o.log) o.log({ opdracht: 'weer-ochtend', ok: true, treffers: delen.map(function (d) { return d.soort; }).join(',') || 'geen', aanroepen: s.teller | 0, werkdag: beeld.werkdag ? 1 : 0 });
    return { ok: true, detail: detail };
  }
  function info() { const s = staatLees(); return { aan: true, laatste: laatst, laatste_ok: s.laatste_ok || null, fout_sinds: s.fout_sinds || null, aanroepen_vandaag: s.teller_datum === ams(nu()).datum ? s.teller | 0 : 0 }; }
  return { doe: doe, info: info };
}

module.exports = { maak: maak, _intern: { dagBeeld: dagBeeld, treffers: treffers, regel: regel, urenIn: urenIn, ams: ams } };
