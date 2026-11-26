'use strict';
// Verbruik vooruit en terug (wv4168, besluitenpagina nr 116 = 2C16 en nr 166 = 2C66; David Ja 25-11-2026 22:28).
// David opent Verbruik bijna dagelijks om te zien of er ruimte blijft liggen en rekende dat zelf uit. Deze module rekent het voor
// hem: waar eindigt de week bij dit tempo, hoeveel vervalt er, hoeveel verviel vorige week, staafjes "benut per week", sprongen in
// de meter (weekreset of daling zonder reset) en wat de vervallende ruimte in agentklussen is. Alles is AFGELEID uit de tankmeting
// (de echte weekteller van Anthropic); de app toont het als "afgeleid", nooit als meting. Geen netwerk, geen bestanden, geen
// sleutels: server.js geeft de getallen (RPC mk_app_verbruik + mk_app_verbruik_weken, tokenteller.verdeling()).
//
// Tempo = gemiddeld sinds de weekreset (of sinds de laatste daling zonder reset). Gekozen op een rekenproef over de zeven volle
// weken 4-10 t/m 21-11-2026 (prognose op dag 2..6 tegen de echte eindstand): sinds-de-reset gaf op dag 4 gemiddeld 5,8 punt
// afwijking (hoogste 15), de laatste 72 uur 5,9 (hoogste 21), de laatste 48 uur 8,3 (hoogste 20). Restrisico: een week waarin
// het tempo halverwege omslaat (16-11 "vol gas") zit er ruim 15 punt naast; daarom altijd "bij dit tempo" en "afgeleid".
const UUR = 3600 * 1000, DAG = 24 * UUR, WEEK = 7 * DAG;
const DALING_MIN = 0.03;          // een daling van minstens 3 punt tussen twee metingen telt als sprong
const BASIS_MIN_MS = 12 * UUR;    // korter dan 12 uur sinds de reset of de daling: nog te vroeg voor een tempo
const WEKEN_MAX = 8;
const ONVOLLEDIG_MS = 6 * UUR;    // laatste meting van een week meer dan 6 uur vóór de reset: eindstand onvolledig gemeten
const KLUS_STARTS_MIN = 10;       // minder starts deze week: geen vertaling naar klussen

const getal = function (v) { const n = Number(v); return v == null || v === '' || !isFinite(n) ? null : n; };
const tijd = function (v) { const t = typeof v === 'string' || typeof v === 'number' ? Date.parse(v) : NaN; return isFinite(t) ? t : null; };
const iso = function (t) { return t == null ? null : new Date(t).toISOString(); };
const rond = function (n, d) { if (n == null) return null; const f = Math.pow(10, d == null ? 3 : d); return Math.round(n * f) / f; };
const klem = function (v) { return Math.max(0, Math.min(1, v)); };

// Reeks [[tijd, vijf_uur, week, verstreken], ...] → punten { t, v } met een weekwaarde, op tijd gesorteerd.
function punten(reeks) {
  return (Array.isArray(reeks) ? reeks : []).map(function (r) { return Array.isArray(r) ? { t: tijd(r[0]), v: getal(r[2]) } : null; })
    .filter(function (p) { return p && p.t != null && p.v != null; }).sort(function (a, b) { return a.t - b.t; });
}

// Weekresets binnen [van, tot]: de bekende reset min een veelvoud van een week.
function resetsTussen(resetT, van, tot) {
  const uit = [];
  if (resetT == null) return uit;
  let r = resetT;
  while (r > tot) r -= WEEK;
  for (let i = 0; r >= van && i < 60; i++, r -= WEEK) uit.push(r);
  return uit.reverse();
}

// Sprongen in de meter: elke daling van ≥ 3 punt tussen twee opeenvolgende metingen. 'reset' als er een weekreset tussen die twee
// metingen lag, anders 'daling' (zonder reset; de oorzaak weet de pod niet). Ook de resets zelf (voor een label in de grafiek).
function sprongen(reeks, resetIso, nuIso) {
  const p = punten(reeks), resetT = tijd(resetIso);
  const uit = [];
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    if (!(b.v <= a.v - DALING_MIN)) continue;
    const reset = resetsTussen(resetT, a.t + 1, b.t).length > 0;
    uit.push({ t: iso(b.t), voor: iso(a.t), van: rond(a.v), naar: rond(b.v), soort: reset ? 'reset' : 'daling' });
  }
  const tot = tijd(nuIso) != null ? tijd(nuIso) : (p.length ? p[p.length - 1].t : Date.now());
  return { sprongen: uit.slice(-10), resets: resetsTussen(resetT, tot - WEEK, tot).map(iso) };
}

// De prognose voor één abonnement. o: { laatste: {gemeten_op, zeven_dagen, zeven_dagen_reset}, reeks, einde (ISO, optioneel: einde
// van het abonnement; het vroegste van reset en einde telt) }.
function prognose(o) {
  const l = o && o.laatste;
  if (!l) return null;
  const t1 = tijd(l.gemeten_op), v1 = getal(l.zeven_dagen), resetT = tijd(l.zeven_dagen_reset);
  if (t1 == null || v1 == null || resetT == null || !(resetT > t1)) return null;
  const nuT = tijd(o.nu);
  if (nuT != null && resetT <= nuT) return null;   // Codex MOET 1: oude meting van een week die al voorbij is
  const startT = resetT - WEEK;
  const eindeT = tijd(o.einde);
  const eind = eindeT != null && eindeT > t1 && eindeT < resetT ? eindeT : resetT;
  // basis: de reset (stand 0) of, als de meter deze week zonder reset zakte, het punt na de laatste daling
  let t0 = startT, v0 = 0, basis = 'reset';
  const p = punten(o.reeks).filter(function (x) { return x.t > startT && x.t <= t1; });
  for (let i = 1; i < p.length; i++) if (p[i].v <= p[i - 1].v - DALING_MIN) { t0 = p[i].t; v0 = p[i].v; basis = 'daling'; }
  const uitkomst = { gemeten_op: iso(t1), nu: rond(v1), eind_op: iso(eind), einde_bron: eind === resetT ? 'reset' : 'abonnement',
    basis: basis, basis_op: iso(t0), afgeleid: true };
  if (t1 - t0 < BASIS_MIN_MS) return Object.assign(uitkomst, { te_vroeg: true, eind_pct: null, vervalt: null, tempo_dag: null, vol_op: null });
  const helling = Math.max(0, (v1 - v0) / (t1 - t0));
  let eindPct = v1 + helling * (eind - t1), volOp = null;
  if (eindPct >= 1) { volOp = helling > 0 ? t1 + (1 - v1) / helling : null; eindPct = 1; }
  eindPct = klem(Math.max(eindPct, v1));
  return Object.assign(uitkomst, { te_vroeg: false, eind_pct: rond(eindPct), vervalt: rond(1 - eindPct), tempo_dag: rond(helling * DAG), vol_op: iso(volOp) });
}

// Volle weken uit mk_app_verbruik_weken (rijen { reset, eind, hoogste, laatste_op, metingen }): de laatste WEKEN_MAX vóór nu,
// plus de lopende week. vervallen = 1 - eindstand. onvolledig = de laatste meting lag > 6 uur vóór de reset.
function weken(rijen, nuIso) {
  const nu = tijd(nuIso) != null ? tijd(nuIso) : Date.now();
  const l = (Array.isArray(rijen) ? rijen : []).map(function (r) {
    const reset = tijd(r && r.reset), eind = getal(r && r.eind), op = tijd(r && r.laatste_op);
    if (reset == null || eind == null) return null;
    return { reset: iso(reset), eind_pct: rond(klem(eind)), hoogste: rond(getal(r.hoogste)), laatste_op: iso(op), metingen: getal(r.metingen) || 0,
      lopend: reset > nu, onvolledig: reset <= nu && op != null && reset - op > ONVOLLEDIG_MS, _t: reset };
  }).filter(Boolean).sort(function (a, b) { return a._t - b._t; });
  const vol = l.filter(function (w) { return !w.lopend && w.metingen >= 12; }).slice(-WEKEN_MAX);
  const lopend = l.filter(function (w) { return w.lopend; }).slice(-1);
  // Codex MOET 2: vorige = de week die direct vóór nu eindigde (reset in de laatste 7 dagen); ontbreekt die of telde hij te
  // weinig metingen, dan null (nooit een oudere week als "vorige week")
  const vorigeW = l.filter(function (w) { return !w.lopend && w._t <= nu && w._t > nu - WEEK; }).slice(-1)[0] || null;
  const vorige = vorigeW && vorigeW.metingen >= 12 ? vorigeW : null;
  const uit = vol.concat(lopend).map(function (w) { delete w._t; return w; });
  return { weken: uit, vorige: vorige ? { reset: vorige.reset, eind_pct: vorige.eind_pct, vervallen: rond(1 - vorige.eind_pct), onvolledig: vorige.onvolledig, laatste_op: vorige.laatste_op } : null };
}

// Vervallende ruimte in agentklussen: punten per klus = (deze week gebruikt × deel van de agents) / starts deze week. Alleen als de
// agents op dit abonnement draaien en er genoeg starts zijn; afgeleid.
function klussen(o) {
  const vervalt = getal(o && o.vervalt), nu = getal(o && o.nu), deel = getal(o && o.agent_deel), starts = getal(o && o.starts);
  if (vervalt == null || nu == null || deel == null || starts == null || starts < KLUS_STARTS_MIN || !(nu > 0) || !(deel > 0)) return null;
  const perKlus = (nu * deel) / starts;
  if (!(perKlus > 0)) return null;
  return { per_klus: rond(perKlus, 4), klussen: Math.round(vervalt / perKlus), starts: starts, agent_deel: rond(deel, 2) };
}

// Agents die nu draaien, zoals het Agents-scherm (status running uit het register; plekken = maxAgents(); wachten = open rijen).
function agentsNu(reg, max, openRijen) {
  const lopend = Object.keys(reg || {}).filter(function (k) { return reg[k] && reg[k].status === 'running'; }).length;
  return { loopt: lopend, max: getal(max), wachten: getal(openRijen) };
}

module.exports = { prognose: prognose, sprongen: sprongen, weken: weken, klussen: klussen, agentsNu: agentsNu, resetsTussen: resetsTussen,
  _c: { DALING_MIN: DALING_MIN, BASIS_MIN_MS: BASIS_MIN_MS, WEKEN_MAX: WEKEN_MAX } };
