'use strict';
// wv4002 — Strateeg › boek Segment: puur rekenwerk (geen netwerk, geen databank), gedeeld door de backtest (mk-scripts/wv4002) en het live
// boek (strateeg-segment.js). Ontwerp mk-scripts/wv4002/ontwerp-fable.md (Fable 5.2, 23-11-2026). Elke functie leest alleen gegevens ≤ t.
//
// Reeksen zijn arrays op één kalender (dagen[]), null = geen slot die dag.

function gem(a) { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : NaN; }
function sd(a) { if (a.length < 2) return NaN; const m = gem(a); let s = 0; for (const x of a) s += (x - m) * (x - m); return Math.sqrt(s / (a.length - 1)); }
function mediaan(a) { const b = a.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
function rangen(v) { const ix = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = new Array(v.length); for (let i = 0; i < ix.length;) { let j = i; while (j + 1 < ix.length && ix[j + 1][0] === ix[i][0]) j++; for (let k = i; k <= j; k++) r[ix[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; }
function spearman(a, b) { if (a.length < 3) return null; const ra = rangen(a), rb = rangen(b); const ma = gem(ra), mb = gem(rb); let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < a.length; i++) { sab += (ra[i] - ma) * (rb[i] - mb); saa += (ra[i] - ma) ** 2; sbb += (rb[i] - mb) ** 2; } return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null; }

// ── schonen (ontwerp 3.4) ──
// in: { spdr: {id: [..]}, ish: {id: [..]} } op dezelfde kalender; uit: {id: { k: [schoon slot of null], verdacht: [bool], breuk: [bool] }}
// Dag t voor sector s is verdacht als ln(SPDR/iShares) op t meer dan grens afwijkt van de mediaan van die verhouding over de vorige 21
// gezamenlijke dagen; zonder tweede bron: |dag-logrendement| > los_grens terwijl de mediaan van |rendement| van de andere sectoren < rust.
// Verdacht slot telt niet: het schone slot blijft het laatste goede. Vijf verdachte dagen op rij = nieuw niveau (breuk) aanvaarden.
function schoon(r, o) {
  o = o || {};
  const grens = o.grens || 0.08, losGrens = o.los_grens || 0.12, rust = o.rust || 0.04, venster = o.venster || 21, breukN = o.breuk || 5;
  const ids = Object.keys(r.spdr); const n = ids.length ? r.spdr[ids[0]].length : 0;
  // ruwe dagrendementen (tov het vorige ruwe slot) voor de regel zonder tweede bron
  const ruwRet = {};
  for (const id of ids) { const a = r.spdr[id], u = new Array(n).fill(null); let v = null; for (let t = 0; t < n; t++) { if (a[t] > 0) { if (v > 0) u[t] = Math.log(a[t] / v); v = a[t]; } } ruwRet[id] = u; }
  const uit = {};
  for (const id of ids) {
    const a = r.spdr[id], b = (r.ish || {})[id] || [];
    const k = new Array(n).fill(null), verd = new Array(n).fill(false), breuk = new Array(n).fill(false), goed = new Array(n).fill(false);
    let laatstGoed = null, hist = [], rij = 0, laatsteGoedeRuw = null;
    for (let t = 0; t < n; t++) {
      if (!(a[t] > 0)) { k[t] = laatstGoed; continue; }
      let v = false;
      if (b[t] > 0 && hist.length >= 5) {
        const ref = mediaan(hist.slice(-venster));
        v = Math.abs(Math.log(a[t] / b[t]) - ref) > grens;
      } else if (!(b[t] > 0) && laatsteGoedeRuw > 0) {
        const x = Math.log(a[t] / laatsteGoedeRuw);
        const m = mediaan(ids.filter((j) => j !== id).map((j) => (ruwRet[j][t] == null ? null : Math.abs(ruwRet[j][t]))));
        v = Math.abs(x) > losGrens && m != null && m < rust;
      }
      if (v) { rij++; if (rij >= breukN) { v = false; breuk[t] = true; hist = []; } }
      if (v) { verd[t] = true; k[t] = laatstGoed; continue; }
      rij = 0; laatstGoed = a[t]; laatsteGoedeRuw = a[t]; k[t] = a[t]; goed[t] = true;
      if (b[t] > 0) hist.push(Math.log(a[t] / b[t]));
      if (hist.length > 200) hist = hist.slice(-venster);
    }
    uit[id] = { k, verdacht: verd, breuk, goed };
  }
  return uit;
}

// ── signaal (ontwerp 2) ──
function mom(k, t, a, b) { const x = k[t - b], y = k[t - a]; return t - a >= 0 && x > 0 && y > 0 ? x / y - 1 : null; }
function sdLog(k, van, tot) { const l = []; for (let j = van + 1; j <= tot; j++) if (k[j] > 0 && k[j - 1] > 0) l.push(Math.log(k[j] / k[j - 1])); return l.length > 20 ? sd(l) : null; }
// signaal per sector op t. variant: { signaal: 'mom'|'mom_vol', a, b, min_sloten, trend, onrust } ; extra.vix21: gemiddelde VIX t/m t-1 (V5)
function signalen(S, t, v, extra) {
  const uit = {};
  const onrust = v.onrust && extra && extra.vix21 != null && extra.vix21 > v.onrust;
  for (const id of Object.keys(S)) {
    const s = S[id];
    if (!(s.k[t] > 0)) continue;
    if (telGoed(s, t) < (v.min_sloten || 274)) continue;
    let x = null;
    if (onrust) { const q = sdLog(s.k, t - 63, t); x = q == null ? null : -q; }
    else if (v.signaal === 'mom') x = mom(s.k, t, v.a, v.b);
    else if (v.signaal === 'mom_vol') { const m = mom(s.k, t, v.a, v.b), q = sdLog(s.k, t - v.a, t - v.b); x = m != null && q ? m / q : null; }
    else if (v.signaal === 'kanarie') x = extra && extra.toekomst ? extra.toekomst[id] : null;   // alleen voor de lekproef
    if (x == null || !isFinite(x)) continue;
    let trendOk = true;
    if (v.trend) { let som = 0, m = 0; for (let j = t - 199; j <= t; j++) if (j >= 0 && s.k[j] > 0) { som += s.k[j]; m++; } trendOk = m >= 180 && s.k[t] > som / m; }
    uit[id] = { x, trendOk, mom: mom(s.k, t, v.a || 252, v.b == null ? 21 : v.b), onrust };
  }
  return uit;
}
// tel goede sloten (echt slot, niet verdacht) t/m t, met een cache per reeks (een geschoonde reeks verandert niet meer)
function telGoed(s, t) {
  if (!s._tel || s._tel.length !== s.k.length) { const c = new Int32Array(s.k.length); let n = 0; for (let j = 0; j < s.k.length; j++) { if (s.goed[j]) n++; c[j] = n; } Object.defineProperty(s, '_tel', { value: c, enumerable: false, writable: true }); }
  return t >= 0 && t < s._tel.length ? s._tel[t] : 0;
}
// rangorde: hoogste x = rang 1; gelijke stand: al in het boek eerst, dan alfabetisch op isin (meta[id].isin)
function rangorde(sig, gehouden, meta) {
  const ids = Object.keys(sig);
  ids.sort((p, q) => (sig[q].x - sig[p].x) || ((gehouden.includes(q) ? 1 : 0) - (gehouden.includes(p) ? 1 : 0)) || (String((meta[p] || {}).isin || p) < String((meta[q] || {}).isin || q) ? -1 : 1));
  const r = {}; ids.forEach((id, k) => { r[id] = k + 1; });
  return { lijst: ids, rang: r };
}
// doel: welke sectoren het boek na de herziening houdt (ontwerp 2: top k met buffer; trendfilter → lege plek contant)
function doel(sig, gehouden, v, meta) {
  const { lijst, rang } = rangorde(sig, gehouden, meta);
  const ok = (id) => sig[id] && sig[id].trendOk;
  let houd = v.buffer ? gehouden.filter((id) => rang[id] != null && rang[id] <= v.buffer && ok(id)) : [];
  houd.sort((p, q) => rang[p] - rang[q]); houd = houd.slice(0, v.k);
  for (const id of lijst) { if (houd.length >= v.k) break; if (!houd.includes(id) && ok(id) && (v.buffer || rang[id] <= v.k)) houd.push(id); }
  if (!v.buffer) houd = lijst.filter((id) => rang[id] <= v.k && ok(id));
  return { houd, rang, lijst };
}
function isHerzieDag(dagen, t, v) {   // t = laatste beursdag van de maand (of van het kwartaal bij V6) in de kalender
  if (t + 1 >= dagen.length) return false;
  const a = dagen[t].slice(0, 7), b = dagen[t + 1].slice(0, 7);
  if (a === b) return false;
  return v.herzien === 'kwartaal' ? ['03', '06', '09', '12'].includes(dagen[t].slice(5, 7)) : true;
}

// ── portefeuille (backtest en live delen de orderlogica) ──
function kostenVan(bedrag, tarief) { return (tarief.vast || 0) + bedrag * (tarief.halve_spread || 0); }
// wissels berekenen: boek { contant, posities: [{id, aantal}] }, houd[], prijzen{id}, gewichtStart (1/k van 98 %)
// uit: orders [{id, kant, aantal|bedrag, reden}] — verkoop eerst, dan koop; opbrengst van verkochte naar de nieuwe
function plan(boek, houd, prijzen, v, o) {
  o = o || {};
  const orders = [];
  const waarde = boek.contant + boek.posities.reduce((s, p) => s + p.aantal * (prijzen[p.id] || 0), 0);
  const weg = boek.posities.filter((p) => !houd.includes(p.id));
  const nieuw = houd.filter((id) => !boek.posities.some((p) => p.id === id));
  for (const p of weg) orders.push({ id: p.id, kant: 'verkoop', aantal: p.aantal, reden: 'uit' });
  // te groot: > max_aandeel van het boek → terug naar 1/k
  for (const p of boek.posities) if (houd.includes(p.id) && prijzen[p.id] > 0 && p.aantal * prijzen[p.id] > (v.max_aandeel || 0.5) * waarde) {
    const doelW = waarde * (1 - (v.contant_min || 0.02)) / v.k;
    orders.push({ id: p.id, kant: 'verkoop', aantal: Math.floor(((p.aantal * prijzen[p.id] - doelW) / prijzen[p.id]) * 1e4) / 1e4, reden: 'te_groot' });
  }
  if (nieuw.length) {
    // contant na verkopen (schatting zonder spread) verdelen over de nieuwe; bij de start: elk 1/k van 98 %
    let vrij = boek.contant; for (const x of orders) vrij += x.aantal * (prijzen[x.id] || 0);
    const reserve = waarde * (v.contant_min || 0.02);
    const per = boek.posities.length === 0 ? waarde * (1 - (v.contant_min || 0.02)) / v.k : Math.max(0, (vrij - reserve)) / nieuw.length;
    for (const id of nieuw) orders.push({ id, kant: 'koop', bedrag: per, reden: boek.posities.length === 0 ? 'start' : 'in' });
  }
  return orders;
}
// order uitvoeren tegen midden met halve spread en vaste kosten; contant nooit negatief; fracties 4 decimalen
function voerUit(boek, od, midden, tarief) {
  const hs = tarief.halve_spread || 0, vast = tarief.vast || 0;
  if (!(midden > 0)) return null;
  if (od.kant === 'verkoop') {
    const p = boek.posities.find((x) => x.id === od.id); if (!p) return null;
    const aantal = Math.min(od.aantal, p.aantal); if (!(aantal > 0)) return null;
    const px = midden * (1 - hs), bruto = aantal * px;
    boek.contant += bruto - vast;
    p.aantal = Math.round((p.aantal - aantal) * 1e4) / 1e4; if (p.aantal <= 0) boek.posities.splice(boek.posities.indexOf(p), 1);
    return { id: od.id, kant: 'verkoop', aantal, midden, prijs: px, kosten: vast + aantal * midden * hs };
  }
  const px = midden * (1 + hs);
  let bedrag = Math.min(od.bedrag, boek.contant - vast); if (!(bedrag > 5)) return null;
  const aantal = Math.floor((bedrag / px) * 1e4) / 1e4; if (!(aantal > 0)) return null;
  boek.contant -= aantal * px + vast;
  const p = boek.posities.find((x) => x.id === od.id);
  if (p) { p.aankoop = (p.aankoop * p.aantal + midden * aantal) / (p.aantal + aantal); p.aantal += aantal; } else boek.posities.push({ id: od.id, aantal, aankoop: midden });
  return { id: od.id, kant: 'koop', aantal, midden, prijs: px, kosten: vast + aantal * midden * hs };
}
function waardeVan(boek, prijzen) { return boek.contant + boek.posities.reduce((s, p) => s + p.aantal * (prijzen[p.id] || p.aankoop || 0), 0); }

// Backtest van één variant op geschoonde reeksen. D = { dagen, S: schoon(), meta, vix21?: [..] }
// uit: { lijn: [[dag, waarde]], maand: [{ dag, r }], ic: [..], wissels, kosten, perHerz: [...] }
function backtest(D, v, o) {
  o = o || {};
  const tarief = { vast: o.vast != null ? o.vast : 1, halve_spread: o.halve_spread != null ? o.halve_spread : 0.001 };
  const start = o.start || 1000, n = D.dagen.length;
  const boek = { contant: start, posities: [] };
  const prijsOp = (t) => { const p = {}; for (const id of Object.keys(D.S)) if (D.S[id].k[t] > 0) p[id] = D.S[id].k[t]; return p; };
  const lijn = [], herz = []; let kosten = 0, orders = 0, wissels = 0, gestart = false, wacht = null;
  const vanaf = D.dagen.findIndex((d) => d >= (o.test_vanaf || '2017-01-01'));
  for (let t = Math.max(1, vanaf); t < n; t++) {
    if (wacht) {
      // uitvoeren op t (= slot na de signaaldag); een been met een verdacht slot schuift (hooguit 3 dagen), beide benen samen
      const ids = wacht.orders.map((x) => x.id);
      const slecht = ids.some((id) => !D.S[id].goed[t]);   // Codex-MOET 3: een echt, goedgekeurd slot (geen doorgeschoven koers)
      if (slecht) { wacht.pogingen++; if (wacht.pogingen >= 3) wacht = null; }   // hooguit 3 beursdagen proberen, zoals live (Codex ronde 3)
      else {
        const pr = prijsOp(t);
        for (const od of wacht.orders.filter((x) => x.kant === 'verkoop')) { const g = voerUit(boek, od, pr[od.id], tarief); if (g) { kosten += g.kosten; orders++; } }
        for (const od of wacht.orders.filter((x) => x.kant === 'koop')) { const g = voerUit(boek, od, pr[od.id], tarief); if (g) { kosten += g.kosten; orders++; if (od.reden === 'in') wissels++; } }
        gestart = true; wacht = null;
      }
    }
    if (gestart) lijn.push([D.dagen[t], waardeVan(boek, prijsOp(t))]);
    if (isHerzieDag(D.dagen, t, v)) {
      const extra = { vix21: D.vix21 ? D.vix21[t] : null, toekomst: o.toekomst ? o.toekomst(t) : null };
      let sig = signalen(D.S, t, v, extra);
      if (Object.keys(sig).length < 5) continue;
      if (o.schud) { const ids = Object.keys(sig), xs = ids.map((id) => sig[id]); for (let j = xs.length - 1; j > 0; j--) { const q = Math.floor(o.schud() * (j + 1)); [xs[j], xs[q]] = [xs[q], xs[j]]; } sig = Object.fromEntries(ids.map((id, j) => [id, xs[j]])); }
      const geh = boek.posities.map((p) => p.id);
      const d = doel(sig, geh, v, D.meta || {});
      herz.push({ t, dag: D.dagen[t], houd: d.houd.slice(), sig });
      if (!gestart) { wacht = { orders: plan(boek, d.houd, prijsOp(t), v), pogingen: 0 }; continue; }   // Codex-MOET 4: elke herziening mag de start opnieuw proberen
      const ord = plan(boek, d.houd, prijsOp(t), v);
      if (ord.length) wacht = { orders: ord, pogingen: 0 };
    }
  }
  return { lijn, herz, kosten, orders, wissels, eind: boek };
}
// nulhypothese N0: alle sectoren van het universum gelijk, eens per jaar (januari-herziening) herwogen; zelfde kosten
function nulBoek(D, o) {
  o = o || {};
  const tarief = { vast: o.vast != null ? o.vast : 1, halve_spread: o.halve_spread != null ? o.halve_spread : 0.001 };
  const n = D.dagen.length; const boek = { contant: o.start || 1000, posities: [] }; const lijn = []; let kosten = 0, gestart = false, wacht = null;
  const prijsOp = (t) => { const p = {}; for (const id of Object.keys(D.S)) if (D.S[id].k[t] > 0) p[id] = D.S[id].k[t]; return p; };
  const vanaf = D.dagen.findIndex((d) => d >= (o.test_vanaf || '2017-01-01'));
  let eerste = true;
  for (let t = Math.max(1, vanaf); t < n; t++) {
    if (wacht && wacht.ids.concat(boek.posities.map((p) => p.id)).some((id) => !D.S[id].goed[t])) { wacht.pogingen++; if (wacht.pogingen >= 3) wacht = null; }   // zelfde uitstelregel als de varianten: na 3 dagen vervalt hij (Codex ronde 2)
    else if (wacht) {
      const pr = prijsOp(t); const w = waardeVan(boek, pr); const per = w * 0.98 / wacht.ids.length;
      const doelIds = wacht.ids;
      for (const p of boek.posities.slice()) { const nu = p.aantal * pr[p.id]; if (nu > per + 1 || !doelIds.includes(p.id)) { const g = voerUit(boek, { id: p.id, kant: 'verkoop', aantal: doelIds.includes(p.id) ? (nu - per) / pr[p.id] : p.aantal }, pr[p.id], tarief); if (g) kosten += g.kosten; } }
      for (const id of doelIds) { const p = boek.posities.find((x) => x.id === id); const nu = p ? p.aantal * pr[id] : 0; if (nu < per - 1) { const g = voerUit(boek, { id, kant: 'koop', bedrag: per - nu }, pr[id], tarief); if (g) kosten += g.kosten; } }
      gestart = true; wacht = null; eerste = false;
    }
    if (gestart) lijn.push([D.dagen[t], waardeVan(boek, prijsOp(t))]);
    if (isHerzieDag(D.dagen, t, { herzien: 'maand' }) && (eerste || D.dagen[t].slice(5, 7) === '12')) {
      const sig = signalen(D.S, t, { signaal: 'mom', a: 252, b: 21 }, {});
      if (Object.keys(sig).length < 5) continue;
      wacht = { ids: Object.keys(sig), pogingen: 0 };
    }
  }
  return { lijn, kosten };
}

module.exports = { gem, sd, mediaan, spearman, schoon, signalen, rangorde, doel, isHerzieDag, plan, voerUit, waardeVan, kostenVan, backtest, nulBoek, mom, sdLog, telGoed };
