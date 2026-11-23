'use strict';
// wv3993 — OVIS Beleggen › Strateeg: puur rekenen (geen klok, geen databank, geen netwerk, geen toeval zonder zaad).
// Ontwerp: mk-scripts/wv3993/ontwerp.md (Fable 5.2, 23-11-2026). Kenmerken alleen uit koersen tot en met dag t; doel = rendement van slot t+1
// tot slot t+1+h min het gelijk gewogen universum; per dag naar rang-z. Ridge op rang-z, ijking (helling + Platt) alleen uit eerdere
// voorspellingen buiten de training. Lekproeven: afkap, kanarie, schud, doeluitlijning.

// ── kleine wiskunde ──
function gem(a) { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : NaN; }
function sd(a) { if (a.length < 2) return NaN; const m = gem(a); let s = 0; for (const x of a) s += (x - m) * (x - m); return Math.sqrt(s / (a.length - 1)); }
function rangen(v) {   // gemiddelde rang bij gelijke waarden, 1-gebaseerd
  const idx = v.map((x, i) => i).sort((a, b) => v[a] - v[b]);
  const r = new Array(v.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++;
    const rr = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k]] = rr; i = j + 1;
  }
  return r;
}
// rang-z: rangen → gemiddeld 0, sd 1 (binnen de doorsnede); null blijft null
function rangZ(v) {
  const pos = [], waarden = [];
  v.forEach((x, i) => { if (x != null && isFinite(x)) { pos.push(i); waarden.push(x); } });
  const uit = v.map(() => null);
  if (waarden.length < 3) { pos.forEach((p) => { uit[p] = 0; }); return uit; }
  const r = rangen(waarden), m = gem(r), s = sd(r) || 1;
  pos.forEach((p, k) => { uit[p] = (r[k] - m) / s; });
  return uit;
}
function spearman(a, b) {
  const pa = [], pb = [];
  for (let i = 0; i < a.length; i++) if (a[i] != null && b[i] != null && isFinite(a[i]) && isFinite(b[i])) { pa.push(a[i]); pb.push(b[i]); }
  if (pa.length < 5) return null;
  const ra = rangen(pa), rb = rangen(pb), ma = gem(ra), mb = gem(rb);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < ra.length; i++) { sab += (ra[i] - ma) * (rb[i] - mb); saa += (ra[i] - ma) ** 2; sbb += (rb[i] - mb) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : null;
}
function cholOplos(A, b) {   // A symmetrisch positief definiet (n×n als array van rijen), los A x = b
  const n = b.length, L = A.map((r) => r.map(() => 0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i][j]; for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    if (i === j) { if (s <= 0) throw new Error('niet positief definiet'); L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
  }
  const y = new Array(n); for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
  const x = new Array(n); for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
  return x;
}
function ridge(XtX, Xty, lambda) {   // (X'X + lambda I) w = X'y
  const A = XtX.map((r, i) => r.map((v, j) => v + (i === j ? lambda : 0)));
  return cholOplos(A, Xty.slice());
}
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
// Platt-ijking: P(y=1) = sigmoid(a + b s); Newton met kleine ridge op b voor stabiliteit
function platt(s, y) {
  let a = 0, b = 0;
  for (let it = 0; it < 30; it++) {
    let ga = 0, gb = 0, haa = 1e-6, hab = 0, hbb = 1e-6;
    for (let i = 0; i < s.length; i++) { const p = sigmoid(a + b * s[i]), w = p * (1 - p), e = p - y[i]; ga += e; gb += e * s[i]; haa += w; hab += w * s[i]; hbb += w * s[i] * s[i]; }
    const det = haa * hbb - hab * hab; if (!(det > 0)) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a -= da; b -= db; if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { a, b };
}
function helling(s, r) { let sxy = 0, sxx = 0; for (let i = 0; i < s.length; i++) { sxy += s[i] * r[i]; sxx += s[i] * s[i]; } return sxx > 0 ? sxy / sxx : 0; }
function zaadRng(zaad) { let x = (zaad >>> 0) || 1; return function () { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }

// ── reeksen uitlijnen ──
// reeksen: { isin: [{d, k}] } → { dagen: [iso], P: { isin: Float64Array|null-waarden als NaN } } — beursdag = dag waarop ≥ 60 % van de
// instrumenten die al bestaan een punt heeft. Ontbrekend binnen de reeks = vorige koers (hooguit 5 dagen), vóór het eerste punt = NaN.
function lijnUit(reeksen) {
  const tel = new Map(), eerste = {};
  for (const [isin, r] of Object.entries(reeksen)) { if (!r || !r.length) continue; eerste[isin] = r[0].d; for (const p of r) tel.set(p.d, (tel.get(p.d) || 0) + 1); }
  const alle = [...tel.keys()].sort();
  const dagen = alle.filter((d) => { const n = Object.values(eerste).filter((e) => e <= d).length; return tel.get(d) >= Math.max(1, 0.6 * n); });
  const P = {};
  for (const [isin, r] of Object.entries(reeksen)) {
    const a = new Float64Array(dagen.length).fill(NaN); if (!r || !r.length) { P[isin] = a; continue; }
    const m = new Map(r.map((p) => [p.d, p.k]));
    let laatst = NaN, oud = 99;
    for (let t = 0; t < dagen.length; t++) {
      const k = m.get(dagen[t]);
      if (k != null) { laatst = k; oud = 0; } else oud++;
      a[t] = dagen[t] >= r[0].d && oud <= 5 ? laatst : NaN;
    }
    P[isin] = a;
  }
  return { dagen, P };
}

// ── kenmerken ──
const KENMERKEN = {
  prijs: ['r1', 'r5', 'r21', 'r63', 'r126', 'm252_21', 'vol21', 'vol63', 'volv', 'top252', 'ma50', 'ma200', 'beta', 'rest21', 'thema21', 'x_mom_vol', 'x_mom_breed'],
  wiki: ['wiki'],
  cijfers: ['cijfer_dagen', 'cijfer_reactie'],
};
const SETS = { prijs: KENMERKEN.prijs, prijs_wiki: KENMERKEN.prijs.concat(KENMERKEN.wiki), volledig: KENMERKEN.prijs.concat(KENMERKEN.wiki, KENMERKEN.cijfers) };
const MIN_HISTORIE = 253;

function ret(a, t, h) { const x = a[t], y = a[t - h]; return t - h >= 0 && x > 0 && y > 0 ? x / y - 1 : null; }
function lr(a, t) { const x = a[t], y = a[t - 1]; return t >= 1 && x > 0 && y > 0 ? Math.log(x / y) : null; }

// Ruwe kenmerken per instrument per dag; leest UITSLUITEND a[0..t] (afkapproef bewaakt dat). extra = { wiki: {isin: Map(dag→views)},
// cijfer: {isin: [iso-dagen, oplopend]} } — wiki gebruikt alleen dagen < dagen[t] (één dag vertraagd), cijfers alleen datums ≤ dagen[t].
function ruweKenmerken(data, isins, t, extra, uni) {
  const { dagen, P } = data, uit = {};
  for (const i of isins) {
    const a = P[i];
    if (!(a[t] > 0) || t < MIN_HISTORIE || !(a[t - MIN_HISTORIE + 1] > 0)) continue;
    const r = [];
    for (let k = t - 62; k <= t; k++) r.push(lr(a, k));
    if (r.some((x) => x == null)) continue;
    const r21 = r.slice(-21);
    let hoog = 0, s50 = 0, s200 = 0;
    for (let k = t - 251; k <= t; k++) { if (a[k] > hoog) hoog = a[k]; }
    for (let k = t - 49; k <= t; k++) s50 += a[k];
    for (let k = t - 199; k <= t; k++) s200 += a[k];
    const f = {
      r1: ret(a, t, 1), r5: ret(a, t, 5), r21: ret(a, t, 21), r63: ret(a, t, 63), r126: ret(a, t, 126),
      m252_21: a[t - 21] > 0 && a[t - 252] > 0 ? a[t - 21] / a[t - 252] - 1 : null,
      vol21: sd(r21), vol63: sd(r), top252: a[t] / hoog - 1, ma50: a[t] / (s50 / 50) - 1, ma200: a[t] / (s200 / 200) - 1,
    };
    f.volv = f.vol21 / f.vol63;
    // bèta en restrendement tegen het universum (126 d)
    if (uni) {
      let sx = 0, sy = 0, sxy = 0, sxx = 0, n = 0;
      for (let k = t - 125; k <= t; k++) { const x = uni.r[k], y = lr(a, k); if (x == null || y == null) continue; sx += x; sy += y; sxy += x * y; sxx += x * x; n++; }
      if (n > 60) { const vx = sxx / n - (sx / n) ** 2; f.beta = vx > 0 ? (sxy / n - (sx / n) * (sy / n)) / vx : null; }
      if (f.beta != null) { let s = 0; for (let k = t - 20; k <= t; k++) { const x = uni.r[k], y = lr(a, k); if (x != null && y != null) s += y - f.beta * x; } f.rest21 = s; }
    }
    if (extra && extra.wiki && extra.wiki[i]) {
      const w = extra.wiki[i]; let s7 = 0, n7 = 0, s90 = 0, n90 = 0;
      const eind = dagen[t];   // strikt eerder dan dag t
      const d0 = new Date(eind + 'T12:00:00Z');
      for (let k = 1; k <= 90; k++) {
        const dd = new Date(d0.getTime() - k * 86400000).toISOString().slice(0, 10);
        const v = w.get(dd); if (v == null) continue;
        if (k <= 7) { s7 += v; n7++; } s90 += v; n90++;
      }
      if (n7 >= 5 && n90 >= 60 && s90 > 0) f.wiki = Math.log(((s7 / n7) + 1) / ((s90 / n90) + 1));
    }
    if (extra && extra.cijfer && extra.cijfer[i]) {
      const c = extra.cijfer[i]; let laatste = null;
      for (const d of c) { if (d <= dagen[t]) laatste = d; else break; }
      if (laatste) {
        let k0 = t; while (k0 > 0 && dagen[k0 - 1] >= laatste) k0--;   // eerste beursdag ≥ indiendatum
        const dagenSinds = t - k0;
        if (dagenSinds <= 130) {
          f.cijfer_dagen = Math.min(dagenSinds, 63);
          const k1 = Math.min(k0 + 1, t);   // indiening vaak na slot → reactie van dag vóór tot dag na
          const ri = ret(a, k1, k1 - (k0 - 1)), ru = uni ? uni.cum(k0 - 1, k1) : 0;
          if (ri != null && ru != null && k0 - 1 >= 0) f.cijfer_reactie = ri - ru;
        }
      }
    }
    uit[i] = f;
  }
  return uit;
}

// Universum-dagrendement (gelijk gewogen gemiddelde van de log-rendementen die er die dag zijn) en hulpfuncties; alleen verleden per index.
function universum(data, isins) {
  const n = data.dagen.length, r = new Array(n).fill(null), breed = new Array(n).fill(null);
  const som200 = {}; for (const i of isins) som200[i] = 0;
  for (let t = 0; t < n; t++) {
    const x = []; let boven = 0, m = 0;
    for (const i of isins) {
      const a = data.P[i];
      // lopende som van 200 dagen (NaN telt als 0; geldig alleen als beide randen bestaan)
      som200[i] += (a[t] > 0 ? a[t] : 0) - (t >= 200 && a[t - 200] > 0 ? a[t - 200] : 0);
      if (t >= 1) { const v = lr(a, t); if (v != null) x.push(v); }
      if (t >= 199 && a[t] > 0 && a[t - 199] > 0) { m++; if (a[t] > som200[i] / 200) boven++; }
    }
    r[t] = t >= 1 && x.length >= 3 ? gem(x) : null;
    breed[t] = m >= 5 ? boven / m : null;
  }
  const vol = new Array(n).fill(null);
  for (let t = 21; t < n; t++) { const w = r.slice(t - 20, t + 1).filter((x) => x != null); if (w.length >= 15) vol[t] = sd(w); }
  // percentiel van de universum-vol21 tegen zijn eigen voorgaande 252 dagen (alleen verleden)
  const volPct = new Array(n).fill(null);
  for (let t = 273; t < n; t++) {
    if (vol[t] == null) continue; let lager = 0, tot = 0;
    for (let k = t - 252; k < t; k++) if (vol[k] != null) { tot++; if (vol[k] < vol[t]) lager++; }
    if (tot > 100) volPct[t] = lager / tot;
  }
  function cum(t0, t1) { if (t0 < 0) return null; let s = 0; for (let k = t0 + 1; k <= t1; k++) { if (r[k] == null) return null; s += r[k]; } return Math.exp(s) - 1; }
  return { r, breed, vol, volPct, cum };
}

// Doorsnede van dag t: rang-z per kenmerk, thema-relatief, wisselwerkingen. → { isins: [...], X: [[...]], namen }
function doorsnede(data, uni, meta, t, extra, set, kanarie) {
  const alle = Object.keys(meta);
  const ruw = ruweKenmerken(data, alle, t, extra, uni);
  const isins = Object.keys(ruw);
  if (isins.length < 8) return null;
  // thema-relatief 21 d
  const perThema = {};
  for (const i of isins) { const th = meta[i].thema; (perThema[th] = perThema[th] || []).push(ruw[i].r21); }
  for (const i of isins) ruw[i].thema21 = ruw[i].r21 - gem(perThema[meta[i].thema]);
  if (kanarie) {   // opzettelijk lek: de eerste helft van het doelvenster (slot t+1 → t+1+h/2); moet de IC laten ontploffen
    const hk = Math.max(1, Math.floor((kanarie === true ? 10 : kanarie) / 2));
    for (const i of isins) { const a = data.P[i]; ruw[i].kanarie = t + 1 + hk < a.length && a[t + 1] > 0 && a[t + 1 + hk] > 0 ? a[t + 1 + hk] / a[t + 1] - 1 : null; }
  }
  const namen = SETS[set].concat(kanarie ? ['kanarie'] : []);
  const z = {};
  for (const k of namen) {
    if (k === 'x_mom_vol' || k === 'x_mom_breed') continue;
    z[k] = rangZ(isins.map((i) => ruw[i][k]));
  }
  const zm = rangZ(isins.map((i) => ruw[i].r126));
  const vp = uni.volPct[t], br = uni.breed[t];
  z.x_mom_vol = zm.map((x) => (x == null || vp == null ? 0 : x * (vp - 0.5)));
  z.x_mom_breed = zm.map((x) => (x == null || br == null ? 0 : x * (br - 0.5)));
  const X = isins.map((_, n) => namen.map((k) => { const v = z[k][n]; return v == null || !isFinite(v) ? 0 : v; }));
  return { t, isins, X, namen, ruw };
}

// Doel van dag t bij horizon h: rendement slot t+1 → t+1+h min het gelijk gewogen gemiddelde van de doorsnede; ook als rang-z.
function doel(data, isins, t, h) {
  const n = data.dagen.length; if (t + 1 + h >= n) return null;
  const raw = isins.map((i) => { const a = data.P[i]; return a[t + 1] > 0 && a[t + 1 + h] > 0 ? a[t + 1 + h] / a[t + 1] - 1 : null; });
  const ok = raw.filter((x) => x != null); if (ok.length < 5) return null;
  const m = gem(ok);
  const meer = raw.map((x) => (x == null ? null : x - m));
  return { meer, z: rangZ(meer) };
}

// Model 0 zonder training: momentum 252−21 (+), rendement 5 d (−), volatiliteit 63 d (−)
function model0(ds) {
  const iM = ds.namen.indexOf('m252_21'), i5 = ds.namen.indexOf('r5'), iV = ds.namen.indexOf('vol63');
  return ds.X.map((x) => (x[iM] - x[i5] - x[iV]) / 3);
}
function scoor(w, X) { return X.map((x) => { let s = 0; for (let k = 0; k < w.length; k++) s += w[k] * x[k]; return s; }); }

// ── walk-forward ──
// periode 'week' (maandag als sleutel; zoals de wekelijkse hertraining in de pod) of 'maand'
function periodeVan(iso, soort) {
  if (soort === 'maand') return iso.slice(0, 7);
  const d = new Date(iso + 'T12:00:00Z'), wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); return d.toISOString().slice(0, 10);
}
// o: { set, h, start (iso eerste testmaand), lambdas, venster (beursdagen), kanarie, schud (zaad) }
// Geeft per testdag de voorspellingen (score, mu, kans) en het doel; ijking alleen uit EERDERE voorspellingen buiten de training.
function walkForward(data, meta, extra, o) {
  const h = o.h || 10, set = o.set || 'volledig', venster = o.venster || 8 * 252, lambdas = o.lambdas || [0.001, 0.01, 0.1, 1, 10];
  const uni = o.uni || universum(data, Object.keys(meta));
  const n = data.dagen.length;
  // doorsneden + doelen één keer
  const DS = new Array(n).fill(null), Y = new Array(n).fill(null);
  const rng = o.schud ? zaadRng(o.schud) : null;
  for (let t = MIN_HISTORIE; t < n; t++) {
    const ds = doorsnede(data, uni, meta, t, extra, set, o.kanarie); if (!ds) continue;
    DS[t] = ds;
    const y = doel(data, ds.isins, t, h);
    if (y && rng) {   // schudproef: doelen binnen de dag door elkaar
      const idx = y.z.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      Y[t] = { meer: idx.map((j) => y.meer[j]), z: idx.map((j) => y.z[j]) };
    } else Y[t] = y;
  }
  const p = DS.find((x) => x) ? DS.find((x) => x).namen.length : 0;
  // per-dag X'X en X'y, als voorvoegsom
  const nul = () => Array.from({ length: p }, () => new Array(p).fill(0));
  const SXX = new Array(n + 1), SXY = new Array(n + 1), SN = new Array(n + 1);
  SXX[0] = nul(); SXY[0] = new Array(p).fill(0); SN[0] = 0;
  for (let t = 0; t < n; t++) {
    const A = SXX[t].map((r) => r.slice()), b = SXY[t].slice(); let m = SN[t];
    if (DS[t] && Y[t]) {
      const { X } = DS[t], z = Y[t].z;
      for (let r = 0; r < X.length; r++) { if (z[r] == null) continue; const x = X[r]; m++; for (let i = 0; i < p; i++) { b[i] += x[i] * z[r]; const xi = x[i]; if (!xi) continue; const Ai = A[i]; for (let j = 0; j < p; j++) Ai[j] += xi * x[j]; } }
    }
    SXX[t + 1] = A; SXY[t + 1] = b; SN[t + 1] = m;
  }
  const venstSom = (t0, t1) => ({ A: SXX[t1].map((r, i) => r.map((v, j) => v - SXX[t0][i][j])), b: SXY[t1].map((v, i) => v - SXY[t0][i]), m: SN[t1] - SN[t0] });   // dagen [t0, t1)
  const uitkomst = [], ijkS = [], ijkR = [], ijkY = [];
  const modellen = [];
  let t = data.dagen.findIndex((d) => d >= o.start); if (t < 0) return { voorspellingen: [], modellen: [] };
  let ijkMaxT = -1;   // laatste dag waarvan een voorspelling in de ijking zit (toets: doel bekend vóór de testperiode)
  let wacht = [];   // buiten-steekproefvoorspellingen waarvan het doel nog niet bekend was
  while (t < n) {
    // ijking groeit alleen met voorspellingen waarvan het doel vóór deze testdag bekend was (s + 1 + h ≤ t − 1)
    const rijp = wacht.filter((x) => x.s + 1 + h <= t - 1); wacht = wacht.filter((x) => x.s + 1 + h > t - 1);
    for (const x of rijp) { ijkS.push(x.x); ijkR.push(x.r); ijkY.push(x.r > 0 ? 1 : 0); if (x.s > ijkMaxT) ijkMaxT = x.s; }
    const periode = periodeVan(data.dagen[t], o.periode);
    let tEind = t; while (tEind < n && periodeVan(data.dagen[tEind], o.periode) === periode) tEind++;
    // trainingsgrens: alleen dagen s met s + 1 + h ≤ t − 1 (doel volledig bekend vóór de eerste testdag)
    const grens = t - 1 - (1 + h) + 1;   // exclusief
    const begin = Math.max(MIN_HISTORIE, grens - venster);
    const valBegin = Math.max(begin, grens - 252);
    let w = null, lam = null;
    if (grens - begin > 252 + 60) {
      // lambda kiezen: train op [begin, valBegin − 1 − h), valideer op [valBegin, grens)
      const tr = venstSom(begin, Math.max(begin, valBegin - 1 - h));
      let beste = -Infinity;
      for (const l of lambdas) {
        let wl; try { wl = ridge(tr.A, tr.b, l * Math.max(1, tr.m)); } catch (e) { continue; }
        const ics = [];
        for (let s = valBegin; s < grens; s++) if (DS[s] && Y[s]) { const ic = spearman(scoor(wl, DS[s].X), Y[s].z); if (ic != null) ics.push(ic); }
        const m = gem(ics); if (m > beste) { beste = m; lam = l; }
      }
      if (lam != null) {
        const vol = venstSom(begin, grens); w = ridge(vol.A, vol.b, lam * Math.max(1, vol.m));
        if (!ijkS.length) {   // nog geen eerdere buiten-steekproef: ijk op de validatieperiode met de trainingsgewichten zonder die periode
          const wv = ridge(tr.A, tr.b, lam * Math.max(1, tr.m));
          for (let s = valBegin; s < grens; s++) if (DS[s] && Y[s]) { const sc = scoor(wv, DS[s].X); sc.forEach((x, k) => { if (Y[s].meer[k] != null) { ijkS.push(x); ijkR.push(Y[s].meer[k]); ijkY.push(Y[s].meer[k] > 0 ? 1 : 0); } }); }
        }
      }
    }
    const hl = ijkS.length ? helling(ijkS, ijkR) : 0, pl = ijkS.length ? platt(ijkS, ijkY) : { a: 0, b: 0 };
    modellen.push({ periode, lambda: lam, w, helling: hl, platt: pl, train_tot: data.dagen[grens - 1] || null, ijk_max_t: ijkMaxT, eerste_t: t });
    for (let s = t; s < tEind; s++) {
      if (!DS[s] || !w) continue;
      const sc = scoor(w, DS[s].X), s0 = model0(DS[s]);
      uitkomst.push({ t: s, dag: data.dagen[s], isins: DS[s].isins, score: sc, score0: s0, mu: sc.map((x) => x * hl), kans: sc.map((x) => sigmoid(pl.a + pl.b * x)), y: Y[s] });
      if (Y[s]) sc.forEach((x, k) => { if (Y[s].meer[k] != null) wacht.push({ s, x, r: Y[s].meer[k] }); });
    }
    t = tEind;
  }
  return { voorspellingen: uitkomst, modellen, namen: DS.find((x) => x) ? DS.find((x) => x).namen : [], uni, DS, Y };
}

// ── maten ──
function maten(vs, o) {
  o = o || {};
  const h = o.h || 10, top = o.top || 6;
  const ics = [], ics0 = [], perJaar = {}, topMeer = [], treffers = { top: [0, 0], alle: [0, 0] }, brier = [], bak = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  for (const v of vs) {
    if (!v.y) continue;
    const ic = spearman(v.score, v.y.meer), ic0 = spearman(v.score0, v.y.meer);
    if (ic == null) continue;
    ics.push({ t: v.t, ic }); if (ic0 != null) ics0.push(ic0);
    const j = v.dag.slice(0, 4); (perJaar[j] = perJaar[j] || []).push(ic);
    const volg = v.score.map((s, k) => [s, k]).filter(([, k]) => v.y.meer[k] != null).sort((a, b) => b[0] - a[0]);
    const tk = volg.slice(0, top).map(([, k]) => k);
    topMeer.push({ t: v.t, m: gem(tk.map((k) => v.y.meer[k])) });
    tk.forEach((k) => { treffers.top[1]++; if (v.y.meer[k] > 0) treffers.top[0]++; });
    v.score.forEach((s, k) => { const y = v.y.meer[k]; if (y == null) return; treffers.alle[1]++; if ((s > 0) === (y > 0)) treffers.alle[0]++;
      const p = v.kans[k], yy = y > 0 ? 1 : 0; brier.push((p - yy) ** 2); const b = Math.min(9, Math.floor(p * 10)); bak[b].n++; bak[b].p += p; bak[b].y += yy; });
  }
  // t-waarde op niet-overlappende blokken van h dagen
  const blokken = []; for (let i = 0; i < ics.length; i += h) blokken.push(gem(ics.slice(i, i + h).map((x) => x.ic)));
  const tw = blokken.length > 2 ? gem(blokken) / (sd(blokken) / Math.sqrt(blokken.length)) : null;
  // bovenste zes min universum, niet-overlappend (elke h-de dag), blok-bootstrap (blokken van 20 waarnemingen = 20 × h dagen)
  const nietOv = topMeer.filter((_, i) => i % h === 0).map((x) => x.m);
  const bs = bootstrap(nietOv, o.zaad || 13, o.trekkingen || 2000, 2);
  const jaren = Object.keys(perJaar).sort().map((j) => ({ jaar: j, ic: gem(perJaar[j]), dagen: perJaar[j].length }));
  return {
    dagen: ics.length, ic: gem(ics.map((x) => x.ic)), ic_t: tw, ic0: gem(ics0), ic_min_ic0: gem(ics.map((x) => x.ic)) - gem(ics0),
    jaren, jaren_pos: jaren.filter((x) => x.ic > 0).length / Math.max(1, jaren.length),
    top_meer: gem(nietOv), top_meer_90: bs, trefkans_top: treffers.top[0] / Math.max(1, treffers.top[1]), trefkans_alle: treffers.alle[0] / Math.max(1, treffers.alle[1]),
    brier: gem(brier), bakjes: bak.filter((b) => b.n).map((b, i) => ({ p: b.p / b.n, y: b.y / b.n, n: b.n })),
  };
}
function bootstrap(x, zaad, n, blok) {
  if (x.length < 10) return null;
  const rng = zaadRng(zaad), m = [];
  for (let k = 0; k < n; k++) {
    const s = []; while (s.length < x.length) { const b = Math.floor(rng() * (x.length - blok + 1)); for (let j = 0; j < blok && s.length < x.length; j++) s.push(x[b + j]); }
    m.push(gem(s));
  }
  m.sort((a, b) => a - b);
  return { onder: m[Math.floor(0.05 * n)], boven: m[Math.floor(0.95 * n)] };
}

// Vooraf vastgelegd oordeel (ontwerp 4.4)
function oordeel(m, lek, grens) {
  grens = grens || { ic: 0.02, t: 2.0, jaren: 0.6, lek_ic: 0.15 };
  const c = [
    { code: 'ic', tekst: 'gemiddelde rang-IC ≥ ' + grens.ic + ' en t-waarde ≥ ' + grens.t, ok: m.ic >= grens.ic && m.ic_t != null && m.ic_t >= grens.t },
    { code: 'jaren', tekst: 'IC positief in minstens ' + Math.round(grens.jaren * 100) + ' % van de jaren', ok: m.jaren_pos >= grens.jaren },
    { code: 'top', tekst: 'bovenste zes beter dan het universum (ondergrens 90 %-interval > 0, vóór kosten)', ok: !!(m.top_meer_90 && m.top_meer_90.onder > 0) },
    { code: 'model0', tekst: 'niet slechter dan het naïeve model zonder training', ok: m.ic_min_ic0 >= 0 },
    { code: 'lek', tekst: 'alle lekproeven groen', ok: !!(lek && lek.ok) },
    { code: 'te_mooi', tekst: 'IC niet onwaarschijnlijk hoog (≤ ' + grens.lek_ic + ')', ok: !(m.ic > grens.lek_ic) },
  ];
  return { voorspelt: c.every((x) => x.ok), criteria: c };
}

// ── lekproeven ──
// afkap: kenmerken op dag t uit de volle reeks = uit de reeks afgekapt op t (zelfde uitkomst bij n willekeurige t)
function afkapProef(data, meta, extra, o) {
  o = o || {}; const rng = zaadRng(o.zaad || 7), n = data.dagen.length, isins = Object.keys(meta);
  const uniVol = universum(data, isins);
  let fout = 0, getest = 0;
  for (let k = 0; k < (o.n || 40); k++) {
    const t = MIN_HISTORIE + 300 + Math.floor(rng() * (n - MIN_HISTORIE - 320));
    const kort = { dagen: data.dagen.slice(0, t + 1), P: {} };
    for (const i of isins) kort.P[i] = data.P[i].slice(0, t + 1);
    const a = doorsnede(data, uniVol, meta, t, extra, o.set || 'volledig', o.kanarie);
    const b = doorsnede(kort, universum(kort, isins), meta, t, extra, o.set || 'volledig', o.kanarie);
    getest++;
    if (!a || !b || JSON.stringify(a.X) !== JSON.stringify(b.X) || a.isins.join() !== b.isins.join()) fout++;
  }
  return { ok: fout === 0, getest, fout };
}
// doeluitlijning: het doel van t mag alleen P[t+1] en P[t+1+h] gebruiken
function doelProef(data, meta, h) {
  const isins = Object.keys(meta), t = Math.floor(data.dagen.length / 2);
  const y = doel(data, isins, t, h);
  const kopie = { dagen: data.dagen, P: {} };
  for (const i of isins) { const a = Float64Array.from(data.P[i]); for (let k = 0; k < a.length; k++) if (k !== t + 1 && k !== t + 1 + h) a[k] = a[k] * (1 + 0.37 * ((k % 7) - 3)); kopie.P[i] = a; }
  const y2 = doel(kopie, isins, t, h);
  return { ok: !!y && !!y2 && JSON.stringify(y.meer) === JSON.stringify(y2.meer) };
}

// ── simulatie: kosten, prijs ──
// tarief: { VS: {vast, valuta}, NL: {...}, EU: {...}, EUV: {..., zegel}, ETF: {...} } in euro en fracties
function kosten(tarieven, tarief, bedrag, kant) {
  const t = tarieven[tarief]; if (!t) throw new Error('tarief ' + tarief);
  const vast = t.vast || 0, valuta = (t.valuta || 0) * bedrag, zegel = kant === 'koop' ? (t.zegel || 0) * bedrag : 0;
  return { vast, valuta, zegel, totaal: vast + valuta + zegel };
}
function uitvoerPrijs(midden, kant, halveSpread) { return kant === 'koop' ? midden * (1 + halveSpread) : midden * (1 - halveSpread); }

// Portefeuillebesluit op één moment (gedeeld door backtest en kwartierlus).
// in: { posities: [{isin, aantal, aankoop, sinds_dag (index)}], contant, prijzen: {isin: midden}, mu: {isin}, meta, regels, vandaagIdx,
//       budgetOver (euro), wisselVandaag (bool), magKopen(isin) → bool, magVerkopen(isin) → bool, stopUit (bool), opbouwMax }
// uit: { orders: [{isin, kant, bedrag|aantal, reden_code, ...}], reden_code (als er niets gebeurt) }
function waardeVan(pos, contant, prijzen) { let w = contant; for (const p of pos) w += p.aantal * (prijzen[p.isin] || p.aankoop); return w; }
function spreidingOk(isins, meta, regels) {
  const th = {}, laag = {};
  for (const i of isins) { const m = meta[i]; th[m.thema] = (th[m.thema] || 0) + 1; laag[m.thema + '/' + m.laag] = (laag[m.thema + '/' + m.laag] || 0) + 1; }
  if (Object.values(laag).some((n) => n > regels.max_per_laag)) return false;
  if (Object.values(th).some((n) => n > regels.max_per_thema)) return false;
  return true;
}
function doelLijst(mu, meta, regels, kandidaten) {   // hoogste mu met spreiding: per thema min 2, max per thema en laag
  const volg = kandidaten.filter((i) => mu[i] != null).sort((a, b) => mu[b] - mu[a]);
  const uit = [];
  const minThema = regels.min_per_thema || 0, themas = [...new Set(volg.map((i) => meta[i].thema))];
  for (const th of themas) { for (const i of volg) { if (uit.filter((x) => meta[x].thema === th).length >= minThema) break; if (meta[i].thema === th && spreidingOk(uit.concat(i), meta, regels)) uit.push(i); } }
  for (const i of volg) { if (uit.length >= regels.posities) break; if (!uit.includes(i) && spreidingOk(uit.concat(i), meta, regels)) uit.push(i); }
  return uit.sort((a, b) => mu[b] - mu[a]);
}
function themaTellingOk(isins, meta, regels) {
  const th = {}; for (const i of isins) th[meta[i].thema] = (th[meta[i].thema] || 0) + 1;
  return Object.keys(regels.themas || {}).every((t) => (th[t] || 0) >= (regels.min_per_thema || 0));
}
function kostPct(tarieven, meta, isin, bedrag, kant, halveSpread) { const k = kosten(tarieven, meta[isin].tarief, bedrag, kant); return (k.totaal / bedrag) + halveSpread; }

function besluit(s) {
  const { regels, meta, tarieven } = s, hs = regels.halve_spread;
  const prijzen = s.prijzen, mu = s.mu || {};
  const pos = s.posities.map((p) => Object.assign({}, p));
  let contant = s.contant;
  const orders = [];
  // waarderen op de laatst bekende koers (ook als de thuisbeurs dicht is); verse koersen alleen voor handelen (Codex-MOET 3)
  const waardering = Object.assign({}, s.waardering || {}, prijzen);
  const waarde = waardeVan(pos, contant, waardering);
  const nooit = new Set(s.geblokkeerd || []);
  // 1. stops
  if (!s.stopUit) for (const p of pos.slice()) {
    const m = prijzen[p.isin]; if (!(m > 0) || !s.magVerkopen(p.isin)) continue;
    if (m / p.aankoop - 1 <= -regels.stop) {
      orders.push({ isin: p.isin, kant: 'verkoop', aantal: p.aantal, reden_code: 'stop', verlies: m / p.aankoop - 1 });
      contant += p.aantal * uitvoerPrijs(m, 'verkoop', hs) - kosten(tarieven, meta[p.isin].tarief, p.aantal * m, 'verkoop').totaal;
      pos.splice(pos.indexOf(p), 1); nooit.add(p.isin);
    }
  }
  if (s.noodrem && waarde < regels.start * (1 - regels.noodrem)) return { orders, reden_code: orders.length ? 'stop' : 'noodrem' };
  // 2. opbouw: lege plekken vullen (op de startdag of na een stop)
  const kandidaten = Object.keys(mu).filter((i) => !nooit.has(i));
  const doel = doelLijst(mu, meta, regels, kandidaten.filter((i) => !pos.some((p) => p.isin === i)).concat(pos.map((p) => p.isin)));
  let gekocht = 0;
  if (pos.length < regels.posities) {
    for (const i of doel) {
      if (pos.length >= regels.posities || gekocht >= (s.opbouwMax || 6)) break;
      if (pos.some((p) => p.isin === i) || !(prijzen[i] > 0) || !s.magKopen(i)) continue;
      if (!spreidingOk(pos.map((p) => p.isin).concat(i), meta, regels)) continue;
      const open = regels.posities - pos.length;
      let bedrag = Math.min(regels.per_aandeel * waarde, (contant - regels.contant_min * waarde) / open * 1.0);
      if (bedrag < regels.min_order) continue;
      const k = kosten(tarieven, meta[i].tarief, bedrag, 'koop');
      const px = uitvoerPrijs(prijzen[i], 'koop', hs), aantal = Math.floor(((bedrag - k.totaal) / px) * 1e4) / 1e4;
      if (!(aantal > 0)) continue;
      orders.push({ isin: i, kant: 'koop', aantal, reden_code: s.opbouw ? 'opbouw' : 'aanvullen' });
      contant -= aantal * px + k.totaal; pos.push({ isin: i, aantal, aankoop: prijzen[i], sinds: s.vandaagIdx }); gekocht++;
    }
    if (gekocht) return { orders, reden_code: orders[orders.length - 1].reden_code };
    if (!pos.length) { const eerste = doel.find((i) => !pos.some((p) => p.isin === i)); return { orders, reden_code: eerste && s.kopenReden ? s.kopenReden(eerste) : 'beurs_dicht' }; }   // opbouw wacht: zeg waarom
  }
  // 3. te groot geworden → terug naar max_terug
  for (const p of pos) {
    const m = prijzen[p.isin]; if (!(m > 0) || !s.magVerkopen(p.isin)) continue;
    const w = p.aantal * m / waarde;   // m is vers; waarde op de laatst bekende koersen
    if (w > regels.max_aandeel) {
      const verkoopW = (w - regels.max_terug) * waarde, aantal = Math.floor((verkoopW / m) * 1e4) / 1e4;
      if (verkoopW >= regels.min_order && aantal > 0) { orders.push({ isin: p.isin, kant: 'verkoop', aantal, reden_code: 'te_groot', gewicht: w }); return { orders, reden_code: 'te_groot' }; }
    }
  }
  if (orders.length) return { orders, reden_code: 'stop' };
  // 4. één wissel per dag
  if (s.wisselVandaag) return { orders, reden_code: 'al_gewisseld' };
  const houd = pos.filter((p) => s.vandaagIdx - p.sinds >= regels.houdtijd && mu[p.isin] != null && prijzen[p.isin] > 0 && s.magVerkopen(p.isin));
  if (!houd.length) return { orders, reden_code: pos.length ? 'houdtijd' : 'geen_kandidaat' };
  const slechtste = houd.sort((a, b) => mu[a.isin] - mu[b.isin])[0];
  const rest = pos.filter((p) => p !== slechtste).map((p) => p.isin);
  const kand = kandidaten.filter((i) => !pos.some((p) => p.isin === i) && prijzen[i] > 0 && spreidingOk(rest.concat(i), meta, regels) && themaTellingOk(rest.concat(i), meta, regels))
    .sort((a, b) => mu[b] - mu[a]);
  if (!kand.length) return { orders, reden_code: 'geen_kandidaat' };
  const beste = kand.find((i) => s.magKopen(i));
  if (!beste) return { orders, reden_code: s.kopenReden ? s.kopenReden(kand[0]) : 'beurs_dicht' };
  const bedrag = slechtste.aantal * prijzen[slechtste.isin];
  const voorsprong = mu[beste] - mu[slechtste.isin];
  const kost = kostPct(tarieven, meta, slechtste.isin, bedrag, 'verkoop', hs) + kostPct(tarieven, meta, beste, bedrag, 'koop', hs);
  if (!(voorsprong > 0)) return { orders, reden_code: 'geen_voorsprong', voorsprong, kost };
  if (voorsprong <= kost) return { orders, reden_code: 'kosten_hoger', voorsprong, kost };
  const kostEuro = kost * bedrag;
  if (s.budgetOver != null && kostEuro > s.budgetOver) return { orders, reden_code: 'budget_op', voorsprong, kost };
  const opbrengst = slechtste.aantal * uitvoerPrijs(prijzen[slechtste.isin], 'verkoop', hs) - kosten(tarieven, meta[slechtste.isin].tarief, bedrag, 'verkoop').totaal;
  const kb = kosten(tarieven, meta[beste].tarief, opbrengst, 'koop');
  const px = uitvoerPrijs(prijzen[beste], 'koop', hs), aantal = Math.floor(((opbrengst - kb.totaal) / px) * 1e4) / 1e4;
  orders.push({ isin: slechtste.isin, kant: 'verkoop', aantal: slechtste.aantal, reden_code: 'gewisseld_uit', voorsprong, kost, naar: beste });
  orders.push({ isin: beste, kant: 'koop', aantal, reden_code: 'gewisseld_in', voorsprong, kost, van: slechtste.isin });
  return { orders, reden_code: 'gewisseld', voorsprong, kost };
}

// Order uitvoeren op een boek (muteert boek) → geboekte regel met kosten in centen
function voerUit(boek, order, midden, meta, tarieven, regels, dagIdx, metKosten) {
  const hs = metKosten ? regels.halve_spread : 0;
  const px = uitvoerPrijs(midden, order.kant, hs);
  if (order.kant === 'koop') {
    let aantal = order.aantal;
    let k = metKosten ? kosten(tarieven, meta[order.isin].tarief, aantal * px, 'koop') : { vast: 0, valuta: 0, zegel: 0, totaal: 0 };
    if (aantal * px + k.totaal > boek.contant) {   // contant nooit negatief: verkleinen
      aantal = Math.floor(((boek.contant - k.vast) / (px * (1 + ((k.valuta + k.zegel) / Math.max(1e-9, aantal * px))))) * 1e4) / 1e4;
      if (!(aantal > 0)) return null;
      k = metKosten ? kosten(tarieven, meta[order.isin].tarief, aantal * px, 'koop') : k;
    }
    boek.contant -= aantal * px + k.totaal;
    const p = boek.posities.find((x) => x.isin === order.isin);
    if (p) { p.aankoop = (p.aankoop * p.aantal + midden * aantal) / (p.aantal + aantal); p.aantal += aantal; }
    else boek.posities.push({ isin: order.isin, aantal, aankoop: midden, sinds: dagIdx });
    return { isin: order.isin, kant: 'koop', aantal, midden, prijs: px, kosten: k };
  }
  const p = boek.posities.find((x) => x.isin === order.isin); if (!p) return null;
  const aantal = Math.min(order.aantal, p.aantal);
  const k = metKosten ? kosten(tarieven, meta[order.isin].tarief, aantal * px, 'verkoop') : { vast: 0, valuta: 0, zegel: 0, totaal: 0 };
  boek.contant += aantal * px - k.totaal;
  p.aantal = Math.round((p.aantal - aantal) * 1e4) / 1e4;
  if (p.aantal <= 0) boek.posities.splice(boek.posities.indexOf(p), 1);
  return { isin: order.isin, kant: 'verkoop', aantal, midden, prijs: px, kosten: k };
}

// ── portefeuilleproef op dagdata (uitvoering op slot t+1 met het signaal van t) ──
// soort: 'echt' (regels + kosten), 'signaal' (geen kosten, elke dag naar de doellijst), 'terugval' (sterkste zes halfjaar, maandelijks),
// 'vasthouden' (gelijk gewogen op de eerste dag), 'index' (één ISIN)
function portefeuilleProef(data, meta, vs, o) {
  const regels = Object.assign({}, o.regels, { start: o.start || o.regels.start });
  const tarieven = o.tarieven, metKosten = o.kosten !== false;
  const boek = { contant: regels.start, posities: [] };
  let wissels = 0, kostTot = 0, piek = regels.start, terugval = 0, maandKost = 0, maand = null, budgetMaand = 0, dagWissel = -1;
  const lijn = [];
  const isins = Object.keys(meta);
  for (let n = 0; n < vs.length; n++) {
    const v = vs[n], t = v.t; if (t + 1 >= data.dagen.length) break;
    const prijzen = {}; for (const i of isins) { const k = data.P[i][t + 1]; if (k > 0) prijzen[i] = k; }
    const mu = {}; v.isins.forEach((i, k) => { mu[i] = o.soort === 'terugval' ? null : v.mu[k]; });
    const m = data.dagen[t + 1].slice(0, 7);
    if (m !== maand) { maand = m; maandKost = 0; budgetMaand = (regels.kostenbudget || 0.03) * waardeVan(boek.posities, boek.contant, prijzen); }
    let orders = [];
    if (o.soort === 'vasthouden') {
      if (n === 0) { const per = boek.contant / isins.filter((i) => prijzen[i]).length; for (const i of isins) if (prijzen[i]) orders.push({ isin: i, kant: 'koop', aantal: Math.floor(((per - (metKosten ? kosten(tarieven, meta[i].tarief, per, 'koop').totaal : 0)) / prijzen[i]) * 1e4) / 1e4 }); }
    } else if (o.soort === 'index') {
      if (n === 0 && prijzen[o.index]) orders.push({ isin: o.index, kant: 'koop', aantal: Math.floor(((boek.contant - 1) / prijzen[o.index]) * 1e4) / 1e4 });
    } else if (o.soort === 'signaal' || o.soort === 'terugval') {
      let doelL;
      if (o.soort === 'terugval') {
        const eersteVanMaand = n === 0 || data.dagen[vs[n - 1].t + 1].slice(0, 7) !== m;
        if (eersteVanMaand) { const mom = {}; v.isins.forEach((i) => { const a = data.P[i]; mom[i] = a[t - 5] > 0 && a[t - 126] > 0 ? a[t - 5] / a[t - 126] - 1 : null; }); doelL = terugvalLijst(mom, meta, regels); }
      } else doelL = doelLijst(mu, meta, regels, v.isins);
      if (doelL) {
        const w = waardeVan(boek.posities, boek.contant, prijzen);
        for (const p of boek.posities.slice()) if (!doelL.includes(p.isin) && prijzen[p.isin]) orders.push({ isin: p.isin, kant: 'verkoop', aantal: p.aantal });
        const per = w * (1 - regels.contant_min) / regels.posities;
        for (const i of doelL) { if (!boek.posities.some((p) => p.isin === i) && prijzen[i]) orders.push({ isin: i, kant: 'koop', aantal: Math.floor((per / prijzen[i]) * 1e4) / 1e4, uitstel: true }); }
      }
    } else {
      const r = besluit({ regels, meta, tarieven, prijzen, mu, posities: boek.posities, contant: boek.contant, vandaagIdx: n, wisselVandaag: dagWissel === n,
        budgetOver: n === 0 ? null : budgetMaand - maandKost, magKopen: () => true, magVerkopen: () => true, stopUit: o.stopUit, opbouw: n === 0, noodrem: false });
      orders = r.orders;
      if (r.reden_code === 'gewisseld') { wissels++; dagWissel = n; }
    }
    // verkopen eerst, dan kopen (kopen naar rato van het contant)
    for (const od of orders.filter((x) => x.kant === 'verkoop')) { const g = voerUit(boek, od, prijzen[od.isin], meta, tarieven, regels, n, metKosten); if (g) { kostTot += g.kosten.totaal + (metKosten ? regels.halve_spread * g.aantal * g.midden : 0); maandKost += g.kosten.totaal; } }
    const kopen = orders.filter((x) => x.kant === 'koop');
    if (o.soort === 'signaal' || o.soort === 'terugval') {   // verdeel het beschikbare contant gelijk
      const vrij = boek.contant - regels.contant_min * waardeVan(boek.posities, boek.contant, prijzen);
      kopen.forEach((od) => { od.aantal = Math.floor(((vrij / kopen.length) / (prijzen[od.isin] * (1 + (metKosten ? regels.halve_spread : 0)) * 1.003)) * 1e4) / 1e4; });
    }
    for (const od of kopen) { const g = voerUit(boek, od, prijzen[od.isin], meta, tarieven, regels, n, metKosten); if (g) { kostTot += g.kosten.totaal + (metKosten ? regels.halve_spread * g.aantal * g.midden : 0); maandKost += g.kosten.totaal; } }
    const w = waardeVan(boek.posities, boek.contant, prijzen);
    if (w > piek) piek = w; terugval = Math.max(terugval, 1 - w / piek);
    lijn.push({ dag: data.dagen[t + 1], w });
  }
  const eind = lijn.length ? lijn[lijn.length - 1].w : regels.start;
  const jaren = lijn.length / 252;
  return { eind, rendement: eind / regels.start - 1, per_jaar: jaren > 0 ? Math.pow(eind / regels.start, 1 / jaren) - 1 : null, terugval, wissels, kosten: kostTot, kosten_pct: kostTot / regels.start, lijn };
}
function terugvalLijst(mom, meta, regels) {
  const volg = Object.keys(mom).filter((i) => mom[i] != null).sort((a, b) => mom[b] - mom[a]);
  const uit = [], per = {};
  const doelPerThema = Math.floor(regels.posities / Object.keys(regels.themas || { tech: 1, health: 1 }).length);
  for (const i of volg) {
    const th = meta[i].thema; if ((per[th] || 0) >= doelPerThema) continue;
    if (!spreidingOk(uit.concat(i), meta, regels)) continue;
    uit.push(i); per[th] = (per[th] || 0) + 1; if (uit.length >= regels.posities) break;
  }
  return uit;
}

// ── klok en beurs ──
const TZ_DEEL = {};
function deelIn(ms, tz) {
  const f = TZ_DEEL[tz] || (TZ_DEEL[tz] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }));
  const o = {}; for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { dag: o.year + '-' + o.month + '-' + o.day, min: Number(o.hour) * 60 + Number(o.minute), wd: o.weekday };
}
// beurzen: { code: { tz, open: 'hh:mm', dicht: 'hh:mm', vroeg?: 'hh:mm', gesloten: [iso], vroeg_dagen: [iso] } }
function beursOpen(beurzen, code, ms) {
  const b = beurzen[code]; if (!b) return false;
  const d = deelIn(ms, b.tz);
  if (d.wd === 'Sat' || d.wd === 'Sun' || (b.gesloten || []).includes(d.dag)) return false;
  const hm = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const dicht = (b.vroeg_dagen || []).includes(d.dag) && b.vroeg ? hm(b.vroeg) : hm(b.dicht);
  return d.min >= hm(b.open) && d.min < dicht;
}
function minutenSindsOpen(beurzen, code, ms) { const b = beurzen[code], d = deelIn(ms, b.tz); return d.min - (Number(b.open.slice(0, 2)) * 60 + Number(b.open.slice(3, 5))); }
// L&S-minuutstempels: Duitse kloktijd gecodeerd als UTC (gemeten 23-11) → echte ms
function lsEchteMs(stempel) {
  const d = new Date(stempel);
  // zoek de offset van Europe/Berlin op dat moment (kloktijd − UTC)
  const probe = deelIn(stempel, 'Europe/Berlin');
  const klok = Date.UTC(Number(probe.dag.slice(0, 4)), Number(probe.dag.slice(5, 7)) - 1, Number(probe.dag.slice(8, 10)), Math.floor(probe.min / 60), probe.min % 60);
  const off = klok - Math.floor(stempel / 60000) * 60000;   // ≈ +1 u (winter) of +2 u (zomer)
  return d.getTime() - off;
}
// Vers: laatste punt ≤ 5 min oud, ≥ 3 verschillende koersen in het laatste halfuur
function vers(punten, nuMs, o) {
  o = o || {}; if (!punten || !punten.length) return { vers: false, reden: 'geen' };
  const laatste = punten[punten.length - 1];
  if (laatste[0] - nuMs > 2 * 60000) return { vers: false, reden: 'klok' };   // stempel in de toekomst: tijdzone van de bron verschoven (ontwerp 5.3)
  if (nuMs - laatste[0] > (o.max_oud_ms || 5 * 60000)) return { vers: false, reden: 'oud' };
  const half = new Set(punten.filter((p) => nuMs - p[0] <= 30 * 60000).map((p) => p[1]));
  if (half.size < (o.min_koersen || 3)) return { vers: false, reden: 'vlak' };
  return { vers: true, k: laatste[1] };
}

module.exports = {
  gem, sd, rangen, rangZ, spearman, cholOplos, ridge, platt, helling, sigmoid, zaadRng, lijnUit, KENMERKEN, SETS, MIN_HISTORIE,
  ruweKenmerken, universum, doorsnede, doel, model0, scoor, walkForward, periodeVan, maten, bootstrap, oordeel, afkapProef, doelProef,
  kosten, uitvoerPrijs, besluit, voerUit, waardeVan, spreidingOk, doelLijst, terugvalLijst, portefeuilleProef,
  deelIn, beursOpen, minutenSindsOpen, lsEchteMs, vers,
};
