'use strict';
/*
 * nmbrs-laad.js — thuisladen tegen de laadvergoeding van de Holding (wv3662, David 21-11-2026, app-knop). Puur: geen netwerk, geen bestanden.
 * WAAROM. David wil weten of de vergoeding voor thuisladen van de zakelijke auto's (MINI, XC90) in zijn DGA-salaris klopt met wat het laden
 * thuis echt kost. Het bedrag staat in Nmbrs (looncode 5122 Netto Vergoeding; gemeten 21-11: € 7,44 t/m maart 2026, sinds april € 140,34 =
 * de afspraak met Aurore van 22/25-6-2026), het laden in het uurverbruik van Tibber.
 * HOE. schatting(): dezelfde regel als het eenmalige script van 21-11 (mk-scripts/laad-2111/laad.py): per (maand, uur van de dag) is het
 * 30e percentiel het gewone verbruik; een uur met ≥ 3 kWh daarboven is laden, een buuruur met ≥ 1 kWh erboven ook. Kosten = het meerverbruik
 * × de werkelijke uurprijs van Tibber. Tegen Davids eigen laadpaalstanden (mei/juni) zat dit 5–15 % te hoog; dat staat in het blok.
 * vergelijk(): de laatste drie volle maanden (≥ 25 dagen meetdata en een vergoeding in Nmbrs); signaal als vergoeding en geschatte
 * kosten meer dan 20 % uiteenlopen (verschil gedeeld door de vergoeding).
 */
const LAAD_CODE = 5122;               // Netto Vergoeding (Holding); bevat sinds april 2026 precies de afgesproken laadvergoeding
const DREMPEL_PCT = 20, VENSTER = 3, MIN_DAGEN = 25;
const BLOK_BEGIN = '<!-- nmbrs-laad:begin -->', BLOK_EINDE = '<!-- nmbrs-laad:einde -->';

// rows: [{ van: '2026-06-01T17:00:00.000+02:00' (Nederlandse tijd), kwh, kosten }] → { 'YYYY-MM': { kwh, kosten, dagen, laaddagen } }
function schatting(rows) {
  const r = (Array.isArray(rows) ? rows : []).filter(function (x) { return x && typeof x.van === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}/.test(x.van) && typeof x.kwh === 'number' && isFinite(x.kwh); })
    .sort(function (a, b) { return a.van < b.van ? -1 : a.van > b.van ? 1 : 0; });
  const groep = new Map();
  r.forEach(function (x) { const k = x.van.slice(0, 7) + '|' + x.van.slice(11, 13); if (!groep.has(k)) groep.set(k, []); groep.get(k).push(x.kwh); });
  const basis = new Map();
  groep.forEach(function (l, k) { const s = l.slice().sort(function (a, b) { return a - b; }); basis.set(k, s[Math.floor(s.length * 0.3)]); });
  const extra = r.map(function (x) { return x.kwh - basis.get(x.van.slice(0, 7) + '|' + x.van.slice(11, 13)); });
  const laad = extra.map(function (e) { return e >= 3 ? e : 0; });
  // review wv3662 ronde 2 ZOU 1: een buur telt alleen als hij precies één uur ernaast ligt (ontbrekende meeturen)
  const tijd = r.map(function (x) { return Date.parse(x.van); });
  const buur = function (i, j) { return j >= 0 && j < r.length && Math.abs(tijd[j] - tijd[i]) === 3600000 && extra[j] >= 3; };
  extra.forEach(function (e, i) { if (laad[i] === 0 && e >= 1 && (buur(i, i - 1) || buur(i, i + 1))) laad[i] = e; });
  const uit = {}, dagen = {};
  r.forEach(function (x, i) {
    const m = x.van.slice(0, 7);
    (dagen[m] = dagen[m] || new Set()).add(x.van.slice(0, 10));
    if (!(laad[i] > 0)) return;
    const u = uit[m] || (uit[m] = { kwh: 0, kosten: 0, laaddagen: new Set(), zonder_prijs: 0 });
    u.kwh += laad[i];
    // review wv3662 MOET 3: een laaduur zonder prijs telt niet als gratis; hij wordt geteld en blokkeert de vergelijking van die maand
    if (x.kwh > 0 && typeof x.kosten === 'number' && isFinite(x.kosten)) u.kosten += laad[i] * x.kosten / x.kwh; else u.zonder_prijs++;
    u.laaddagen.add(x.van.slice(0, 10));
  });
  const res = {};
  Object.keys(dagen).sort().forEach(function (m) {
    const u = uit[m] || { kwh: 0, kosten: 0, laaddagen: new Set(), zonder_prijs: 0 };
    res[m] = { kwh: Math.round(u.kwh * 10) / 10, kosten: Math.round(u.kosten * 100) / 100, dagen: dagen[m].size, laaddagen: u.laaddagen.size, zonder_prijs: u.zonder_prijs };
  });
  return res;
}

function vorigeMaand(m) { const j = Number(m.slice(0, 4)), n = Number(m.slice(5, 7)); return n === 1 ? (j - 1) + '-12' : j + '-' + String(n - 1).padStart(2, '0'); }
// maanden: uit schatting(); vergoed: { 'YYYY-MM': centen }; nuMaand: 'YYYY-MM' (lopende maand, telt niet mee)
function vergelijk(maanden, vergoed, nuMaand) {
  const venster = [];
  let m = vorigeMaand(nuMaand);
  for (let i = 0; i < VENSTER; i++) { venster.unshift(m); m = vorigeMaand(m); }
  const compleet = venster.every(function (x) { return maanden[x] && maanden[x].dagen >= MIN_DAGEN && !maanden[x].zonder_prijs && Number.isSafeInteger(vergoed[x]); });
  if (!compleet) return { venster: venster, compleet: false, signaal: false };
  const v = venster.reduce(function (a, x) { return a + vergoed[x]; }, 0) / 100;
  const g = Math.round(venster.reduce(function (a, x) { return a + maanden[x].kosten; }, 0) * 100) / 100;
  const pct = v > 0 ? Math.round((g - v) / v * 1000) / 10 : null;
  return { venster: venster, compleet: true, vergoed: Math.round(v * 100) / 100, geschat: g, afwijking_pct: pct, signaal: pct === null ? g > 0 : Math.abs(pct) > DREMPEL_PCT };
}

const MND = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
function mndTekst(m) { return MND[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4); }
function euro(x) { return x == null ? '–' : (x < 0 ? '−' : '') + '€ ' + Math.abs(Math.round(x * 100) / 100).toFixed(2).replace('.', ','); }
// Het blok voor de energiepagina. Alleen Davids eigen vergoeding en het laden thuis; geen andere looncomponenten.
function blok(o) {
  const maanden = o.maanden || {}, vergoed = o.vergoed || {}, v = o.vergelijk || {};
  const lijst = Object.keys(maanden).filter(function (m) { return m < o.nuMaand || m === o.nuMaand; }).sort().slice(-7);
  const regels = [BLOK_BEGIN,
    'Bron: Nmbrs (looncode ' + LAAD_CODE + ' Netto Vergoeding van de Holding, per loonperiode inclusief latere correcties) en het uurverbruik van Tibber',
    '(schatting zoals hierboven, zit 5–15 % te hoog). Socev werkt dit na de dagelijkse Nmbrs-ronde bij. Bijgewerkt ' + String(o.tijd || '').slice(0, 16).replace('T', ' ') + '.',
    '',
    '| Maand | Vergoed (Nmbrs) | Geladen (schatting) | Laadkosten (schatting) | Kosten − vergoed |',
    '|---|--:|--:|--:|--:|'];
  lijst.forEach(function (m) {
    const x = maanden[m], ve = Number.isSafeInteger(vergoed[m]) ? vergoed[m] / 100 : null, lopend = m === o.nuMaand;
    // review wv3662 ronde 2 MOET 1: met laaduren zonder prijs geen (te laag) kostenbedrag en geen verschil
    const kost = x.zonder_prijs ? 'onvolledig (' + x.zonder_prijs + ' uur zonder prijs)' : euro(x.kosten);
    regels.push('| ' + mndTekst(m) + (lopend ? ' (t/m ' + x.dagen + 'e)' : '') + ' | ' + euro(ve) + ' | ' + Math.round(x.kwh) + ' kWh | ' + kost + ' | ' +
      (ve == null || lopend || x.zonder_prijs ? '–' : euro(x.kosten - ve)) + ' |');
  });
  regels.push('');
  if (v.compleet) {
    regels.push('Laatste drie volle maanden (' + mndTekst(v.venster[0]) + ' – ' + mndTekst(v.venster[2]) + '): vergoed ' + euro(v.vergoed) + ', geschat ' + euro(v.geschat) +
      (v.afwijking_pct == null ? '' : ' (' + (v.afwijking_pct > 0 ? '+' : '') + String(v.afwijking_pct).replace('.', ',') + ' %)') + '. ' +
      (v.signaal ? '**Signaal: meer dan ' + DREMPEL_PCT + ' % verschil.**' : 'Binnen ' + DREMPEL_PCT + ' %.'));
  } else regels.push('Nog geen drie volle maanden met meetdata, prijzen en vergoeding om te vergelijken.');
  regels.push(BLOK_EINDE);
  return regels.join('\n');
}
// Alleen tussen bestaande markeringen (de pagina maakt de machinekamer, niet de pod); null = niets te doen of geen markeringen.
function blokZet(pagina, b) {
  const t = String(pagina), i = t.indexOf(BLOK_BEGIN), e = t.indexOf(BLOK_EINDE);
  if (i < 0 || e < i || t.indexOf(BLOK_BEGIN, i + 1) >= 0) return null;
  const n = t.slice(0, i) + b + t.slice(e + BLOK_EINDE.length);
  const zonderTijd = function (s) { return s.replace(/Bijgewerkt [0-9: -]+\./, ''); };
  return zonderTijd(n) === zonderTijd(t) ? null : n;
}

module.exports = { LAAD_CODE, DREMPEL_PCT, BLOK_BEGIN, BLOK_EINDE, schatting, vergelijk, blok, blokZet, mndTekst };
