// woning-bron.js — één lezer voor de woningwaarde (taxaties) en de bankstand van de hypotheek, gedeeld door OVIS Financiën
// (financien-overzicht.js, financien-vault.js, financien-vermogen.js) en OVIS Vastgoed (vastgoed.js).
//
// WAAROM (wv3923, besluitenpagina nr 59 = C49, Fable-review financien 19-11 § M2): Financiën rekende het vermogen met de waarde "na verbouwing",
// Vastgoed met de gewone marktwaarde, en de restschuld werd twee keer gelezen (de hypotheek-json in financien-vault en de tabel "Bankstand" op de
// hypotheekpagina in vastgoed.js). David koos op 22-11-2026 18:22: het vermogen rekent met de gewone marktwaarde.
//
// WAT
//   taxaties(md)        de tabel onder "## Taxatiegeschiedenis" van de woningpagina (kolommen op naam: Rapport, Peildatum, Taxateur, Marktwaarde,
//                       Na verbouwing); geen sectie = de eerste tabel met Peildatum en Marktwaarde. Elke rij: { datum, marktwaarde, na_verbouwing,
//                       rapport, taxateur }, oud → nieuw. Een rij zonder datum of zonder enige waarde valt weg.
//   woningWaarde(tax)   de laatste taxatie met een gewone marktwaarde: { waarde, peildatum, na_verbouwing } (na verbouwing is een voorwaardelijke
//                       waarde voor een geplande verbouwing: alleen ter info, telt nooit mee).
//   bankstand(vault)    de nieuwste "Prive - <datum> - Hypotheek bank vs Excel data.json" in 20_Prive/Bronnen/Financien → bankstandUit.
//   bankstandUit(j, d)  { op, totaal, delen: [{ model: 'HypoN', bank_deel, restschuld, rente_pct, rentevast }] } uit een al gelezen json (d = datum
//                       uit de bestandsnaam, als het bankveld geen datum noemt). rentevast = "rentevast_tm_excel_groen" (je Excel; de bank toont
//                       geen rentevaste data), dezelfde datum die Financiën als eerste renteherziening noemt.
//   holdingLening(vault, vandaag)  wv4170 (2C54): de woninglening van de Holding uit de nieuwste "Holding - <datum> - DGA-reconstructie data.json"
//                       (10_Zakelijk/Holding/Bronnen), met de stand zoals Financiën (financien-vermogen.js) hem op die dag rekent: de hoofdsom vanaf de
//                       ingangsdatum, daarna de stand van de laatste jaarrekening (31-12) die al voorbij is. { hoofdsom, ingang, rente_pct, stand,
//                       stand_op, stand_bron, bron } of null.
// Geen adres of bedrag in de code (deze repo is openbaar). Alleen fs en path; schrijft niets; geen netwerk.
'use strict';
const fs = require('fs'), path = require('path');

const D_HYPO = path.join('20_Prive', 'Bronnen', 'Financien'), RE_HYPO = /^Prive - (\d{4}-\d{2}-\d{2}) - Hypotheek bank vs Excel data\.json$/;
const MAX_JSON = 5 * 1024 * 1024;
const MAAND = { januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12 };

function iso(d, m, j) {
  const s = j + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  const t = new Date(s + 'T12:00:00Z');
  return !isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : null;
}
function datumUit(t) {   // "18-12-2014", "18 augustus 2026", "2026-08-18"
  const s = String(t || '');
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/); if (m) return iso(m[3], m[2], m[1]);
  m = s.match(/(\d{1,2})-(\d{1,2})-(\d{4})/); if (m) return iso(m[1], m[2], m[3]);
  m = s.match(/(\d{1,2}) (januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december) (\d{4})/i);
  return m ? iso(m[1], MAAND[m[2].toLowerCase()], m[3]) : null;
}
function euroUit(t) {   // "€ 1.234.567" / "€ 45.678,90" → 1234567 / 45678.9; zonder €-teken of met k/mln geen getal
  // review MOET 2: het hele bedrag of niets (geen terugloop naar een deel: "€ 450k" is geen 45)
  // review ronde 2 MOET 2: alleen gehele cijfers of nette duizendtalgroepen ("€ 450000.00" is geen 45 miljoen)
  const m = String(t || '').match(/€\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?(?![\d.,]|\s*(?:k\b|mln|miljoen))/i);
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, '') + (m[2] ? '.' + m[2] : ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}
function getal(v) { const n = typeof v === 'string' ? (v.trim() === '' ? NaN : Number(v)) : v;   // review ronde 2 MOET 1: leeg is geen 0
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }
function kop(s) { return String(s || '').replace(/[*_`]/g, '').trim().toLowerCase(); }
function cellen(r) { return r.split('|').slice(1, -1).map(function (x) { return x.trim(); }); }

// ── taxaties ──
function sectie(md, naam) {
  const r = String(md || '').split('\n');
  const i = r.findIndex(function (x) { return /^##\s/.test(x) && kop(x.replace(/^##\s+/, '')).indexOf(naam) === 0; });
  if (i < 0) return null;
  let j = i + 1; while (j < r.length && !/^#{1,2}\s/.test(r[j])) j++;
  return r.slice(i + 1, j).join('\n');
}
function taxaties(md) {
  const tekst = sectie(md, 'taxatiegeschiedenis');
  const r = (tekst != null ? tekst : String(md || '')).split('\n');
  for (let i = 0; i < r.length; i++) {
    if (!/^\|/.test(r[i])) continue;
    const k = cellen(r[i]).map(kop);
    const iP = k.indexOf('peildatum'), iM = k.indexOf('marktwaarde');
    if (iP < 0 || iM < 0) continue;
    const iN = k.findIndex(function (x) { return /^na verbouwing/.test(x); }), iR = k.indexOf('rapport'), iT = k.findIndex(function (x) { return /^taxateur/.test(x); });
    const uit = [];
    for (let j = i + 1; j < r.length && /^\|/.test(r[j]); j++) {
      if (/^\|[\s|:-]+\|$/.test(r[j])) continue;
      const c = cellen(r[j]);
      const datum = datumUit(c[iP]) || (iR >= 0 ? datumUit(c[iR]) : null);
      const mw = euroUit(c[iM]), nv = iN >= 0 ? euroUit(c[iN]) : null;
      if (!datum || !(mw || nv)) continue;
      uit.push({ datum: datum, marktwaarde: mw, na_verbouwing: nv, rapport: iR >= 0 ? c[iR] || '' : '', taxateur: iT >= 0 ? c[iT] || '' : '' });
    }
    return uit.sort(function (a, b) { return a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : 0; });
  }
  return [];
}
// C49 (David 22-11-2026): de gewone marktwaarde telt; "na verbouwing" alleen ter info bij dezelfde taxatie
function woningWaarde(tax) {
  const mw = (tax || []).filter(function (r) { return r.marktwaarde > 10000; });
  const r = mw[mw.length - 1];
  return r ? { waarde: r.marktwaarde, peildatum: r.datum, na_verbouwing: r.na_verbouwing > 10000 ? r.na_verbouwing : null } : null;
}

// ── bankstand van de hypotheek ──
function bankstandUit(j, datum) {
  if (!j || typeof j !== 'object') return null;
  const op = datumUit((/(\d{1,2}-\d{1,2}-\d{4})/.exec(String(j.bron_bank || '')) || [])[1]) || datumUit(datum) || null;
  const delen = (Array.isArray(j.leningdelen) ? j.leningdelen : []).slice(0, 20).map(function (d) {
    return { model: /^Hypo\d{1,2}$/.test(String(d && d.excel_deel)) ? d.excel_deel : null, bank_deel: /^\d{1,4}$/.test(String(d && d.bank_leningdeel)) ? String(d.bank_leningdeel) : null,
      restschuld: getal(d && d.bank_restschuld), rente_pct: getal(d && d.bank_rente_pct), rentevast: datumUit(d && d.rentevast_tm_excel_groen) };
  });
  return { op: op, totaal: getal(j.bank_totaal_restschuld), delen: delen };
}
function bankstand(vault) {
  let namen = [];
  try { namen = fs.readdirSync(path.join(vault, D_HYPO)); } catch (e) { return null; }
  const hit = namen.map(function (n) { const m = RE_HYPO.exec(n); return m ? { n: n, d: m[1] } : null; }).filter(Boolean).sort(function (a, b) { return a.d < b.d ? 1 : a.d > b.d ? -1 : 0; })[0];
  if (!hit) return null;
  const p = path.join(vault, D_HYPO, hit.n), st = fs.statSync(p);
  if (!st.isFile() || st.size > MAX_JSON) return null;
  const b = bankstandUit(JSON.parse(fs.readFileSync(p, 'utf8')), hit.d);
  return b ? Object.assign(b, { bron: path.join(D_HYPO, hit.n) }) : null;
}

// ── woninglening van de Holding (wv4170) ──
const D_DGA = path.join('10_Zakelijk', 'Holding', 'Bronnen'), RE_DGA = /^Holding - (\d{4}-\d{2}-\d{2}) - DGA-reconstructie data\.json$/;
function holdingLeningUit(j, vandaag) {
  const c = j && j.contracten && j.contracten.woninglening;
  if (!c || typeof c !== 'object') return null;
  const s = j.woninglening_verloop && j.woninglening_verloop.samenvatting || {};
  const jr = s.jaarrekening && typeof s.jaarrekening === 'object' ? s.jaarrekening : {};
  const dag = String(vandaag || new Date().toISOString()).slice(0, 10);
  const hoofdsom = getal(c.hoofdsom), ingang = datumUit(c.ingangsdatum);
  // dezelfde trap als financien-vermogen.js: € 0 vóór de ingang, dan de hoofdsom, dan elke jaarrekeningstand vanaf 31-12 van dat jaar
  const standen = [].concat(ingang && hoofdsom !== null ? [{ op: ingang, stand: hoofdsom, bron: 'contract' }] : [],
    Object.keys(jr).filter(function (k) { return /^\d{4}$/.test(k) && getal(jr[k]) !== null; }).sort().map(function (k) { return { op: k + '-12-31', stand: getal(jr[k]), bron: 'jaarrekening ' + k }; }))
    .filter(function (x) { return x.op <= dag; }).sort(function (a, b) { return a.op < b.op ? -1 : a.op > b.op ? 1 : 0; });
  const t = standen[standen.length - 1] || null;
  if (!t && !(ingang && ingang > dag)) return null;
  return { hoofdsom: hoofdsom, ingang: ingang, rente_pct: getal(c.rente_pct), stand: t ? t.stand : 0, stand_op: t ? t.op : null, stand_bron: t ? t.bron : 'nog niet ingegaan' };
}
function holdingLening(vault, vandaag) {
  let namen = [];
  try { namen = fs.readdirSync(path.join(vault, D_DGA)); } catch (e) { return null; }
  const hit = namen.map(function (n) { const m = RE_DGA.exec(n); return m ? { n: n, d: m[1] } : null; }).filter(Boolean).sort(function (a, b) { return a.d < b.d ? 1 : a.d > b.d ? -1 : 0; })[0];
  if (!hit) return null;
  const p = path.join(vault, D_DGA, hit.n), st = fs.statSync(p);
  if (!st.isFile() || st.size > MAX_JSON) return null;
  const h = holdingLeningUit(JSON.parse(fs.readFileSync(p, 'utf8')), vandaag);
  return h ? Object.assign(h, { bron: path.join(D_DGA, hit.n) }) : null;
}

module.exports = { holdingLening: holdingLening, holdingLeningUit: holdingLeningUit, taxaties: taxaties, woningWaarde: woningWaarde, bankstand: bankstand, bankstandUit: bankstandUit, datumUit: datumUit, euroUit: euroUit, D_HYPO: D_HYPO, RE_HYPO: RE_HYPO };
