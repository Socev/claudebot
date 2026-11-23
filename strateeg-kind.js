'use strict';
// wv3993 — OVIS Beleggen › Strateeg: rekenkind. Draait los van server.js (child_process.fork), zodat een backtest van ± 1–2 minuten de pod
// niet stilzet. Geen netwerk. Invoer via een JSON-bestand (reeksen, meta, extra, regels), uitvoer via process.send of stdout.
//   taak 'scoor'    : hoofdvariant walk-forward (wekelijks hertrainen) → voorspellingen van de laatste dag + model van deze week
//   taak 'backtest' : alles uit ontwerp § 4: negen varianten, lekproeven, portefeuilleproeven, oordeel volgens § 4.4
const crypto = require('crypto');
const R = require('./strateeg-reken.js');

function bereid(invoer) {
  const extra = { wiki: {}, cijfer: invoer.extra.cijfer || {} };
  for (const [isin, rijen] of Object.entries(invoer.extra.wiki || {})) extra.wiki[isin] = new Map(rijen);
  const data = R.lijnUit(invoer.reeksen);
  return { data, extra, meta: invoer.meta, regels: invoer.regels };
}
function wfOpties(regels, o) { return Object.assign({ h: regels.horizon, set: regels.set, start: regels.test_vanaf, venster: regels.venster, lambdas: regels.lambdas, periode: 'week' }, o || {}); }
function rond(x, n) { return x == null || !isFinite(x) ? null : Math.round(x * Math.pow(10, n)) / Math.pow(10, n); }

function scoor(invoer) {
  const { data, extra, meta, regels } = bereid(invoer);
  const wf = R.walkForward(data, meta, extra, wfOpties(regels));
  const laatste = wf.voorspellingen[wf.voorspellingen.length - 1];
  const model = wf.modellen[wf.modellen.length - 1];
  if (!laatste || !model || !model.w) return { ok: false, fout: 'geen voorspelling' };
  const ds = wf.DS[laatste.t];
  // doorslag per aandeel: het kenmerk met de grootste bijdrage w_k · x_k
  const doorslag = ds.X.map((x) => { const b = x.map((v, k) => [wf.namen[k], v * model.w[k]]).sort((a, c) => Math.abs(c[1]) - Math.abs(a[1])); return b.slice(0, 2).map((y) => [y[0], rond(y[1], 4)]); });
  // gescoorde eerdere voorspellingen (buiten de steekproef) van de laatste 60 beursdagen, voor het scherm
  return {
    ok: true, dag: laatste.dag, model: { periode: model.periode, lambda: model.lambda, helling: rond(model.helling, 6), platt: model.platt, w: model.w.map((x) => rond(x, 5)), namen: wf.namen, train_tot: model.train_tot },
    voorspellingen: laatste.isins.map((isin, k) => ({ isin, score: rond(laatste.score[k], 5), mu: rond(laatste.mu[k], 6), kans: rond(laatste.kans[k], 4), doorslag: doorslag[k] })),
    recent: wf.voorspellingen.slice(-80).map((v) => ({ dag: v.dag, isins: v.isins, score: v.score.map((x) => rond(x, 4)), kans: v.kans.map((x) => rond(x, 4)), meer: v.y ? v.y.meer.map((x) => rond(x, 5)) : null })),
  };
}

function backtest(invoer) {
  const t0 = Date.now();
  const { data, extra, meta, regels } = bereid(invoer);
  const sha = crypto.createHash('sha256').update(JSON.stringify(regels)).digest('hex').slice(0, 16);
  const hoofd = R.walkForward(data, meta, extra, wfOpties(regels));
  const m = R.maten(hoofd.voorspellingen, { h: regels.horizon });
  // lekproeven
  const afkap = R.afkapProef(data, meta, extra, { n: 25, set: regels.set });
  const kanWf = R.walkForward(data, meta, extra, wfOpties(regels, { kanarie: regels.horizon }));
  const kanM = R.maten(kanWf.voorspellingen, { h: regels.horizon, trekkingen: 200 });
  const kanAfkap = R.afkapProef(data, meta, extra, { n: 8, set: regels.set, kanarie: regels.horizon });
  const schudWf = R.walkForward(data, meta, extra, wfOpties(regels, { schud: 99 }));
  const schudM = R.maten(schudWf.voorspellingen, { h: regels.horizon, trekkingen: 200 });
  const doelOk = R.doelProef(data, meta, regels.horizon);
  const lek = {
    afkap, kanarie: { ic: rond(kanM.ic, 4), ontploft: kanM.ic > 0.3, afkap_rood: !kanAfkap.ok }, schud: { ic: rond(schudM.ic, 4), ok: Math.abs(schudM.ic) <= 0.01 }, doel: doelOk,
  };
  lek.ok = afkap.ok && lek.kanarie.ontploft && lek.kanarie.afkap_rood && lek.schud.ok && doelOk.ok;
  const ord = R.oordeel(m, lek, regels.oordeel);
  // ── robuustheid (Fable-review MOET 1, 23-11): rust het oordeel op de keuze van het universum? ──
  const kort = (x) => ({ ic: rond(x.ic, 4), ic_t: rond(x.ic_t, 2), top_meer: rond(x.top_meer, 5), top_meer_90: x.top_meer_90 ? { onder: rond(x.top_meer_90.onder, 5), boven: rond(x.top_meer_90.boven, 5) } : null, ic0: rond(x.ic0, 4) });
  const vsH = hoofd.voorspellingen;
  // (a) score min het eigen lopende gemiddelde per aandeel (alleen eerdere dagen): haalt het vaste voorkeursaandeel eruit
  const verleden = {};
  const ontdaan = vsH.map((v) => { const sc = v.score.map((x, k) => { const l = verleden[v.isins[k]] || (verleden[v.isins[k]] = []); const g = l.length ? R.gem(l.slice(-252)) : 0; return x - g; }); v.score.forEach((x, k) => verleden[v.isins[k]].push(x)); return Object.assign({}, v, { score: sc }); });
  // (b) zonder de vijf aandelen met het hoogste rendement over de toetsperiode (achteraf gekozen: juist dat is de vraag)
  const tA = vsH.length ? vsH[0].t : 0, tB = vsH.length ? vsH[vsH.length - 1].t : 0;
  const rend = Object.keys(meta).map((i) => { const a = data.P[i]; let s0 = tA; while (s0 < tB && !(a[s0] > 0)) s0++; return [i, a[tB] > 0 && a[s0] > 0 ? a[tB] / a[s0] : 0]; }).sort((x, y) => y[1] - x[1]);
  const weg = new Set(rend.slice(0, 5).map((x) => x[0]));
  const zonder = vsH.map((v) => { const k = v.isins.map((i, j) => (weg.has(i) ? -1 : j)).filter((j) => j >= 0); const pak = (a) => k.map((j) => a[j]); return Object.assign({}, v, { isins: pak(v.isins), score: pak(v.score), score0: pak(v.score0), mu: pak(v.mu), kans: pak(v.kans), y: v.y ? { meer: pak(v.y.meer), z: pak(v.y.z) } : null }); });
  // (c) alleen de rang op bèta (meebewegen met de markt), zonder model
  const ib = hoofd.namen.indexOf('beta');
  const beta = ib < 0 ? [] : vsH.map((v) => Object.assign({}, v, { score: hoofd.DS[v.t].X.map((x) => x[ib]) }));
  const robuust = { per_aandeel_ontdaan: kort(R.maten(ontdaan, { h: regels.horizon, trekkingen: 500 })), zonder_winnaars: Object.assign({ weg: [...weg].map((i) => meta[i].naam) }, kort(R.maten(zonder, { h: regels.horizon, trekkingen: 500 }))),
    alleen_beta: ib < 0 ? null : kort(R.maten(beta, { h: regels.horizon, trekkingen: 200 })) };
  const g = regels.oordeel;
  ord.robuust = !!(robuust.zonder_winnaars.ic >= g.ic && robuust.zonder_winnaars.ic_t >= g.t && robuust.zonder_winnaars.top_meer_90 && robuust.zonder_winnaars.top_meer_90.onder > 0
    && robuust.per_aandeel_ontdaan.ic >= g.ic && robuust.per_aandeel_ontdaan.ic_t >= g.t);
  // varianten (beschrijvend; alleen de hoofdvariant beslist)
  const varianten = [];
  for (const h of [5, 10, 20]) for (const set of ['prijs', 'prijs_wiki', 'volledig']) {
    const vm = h === regels.horizon && set === regels.set ? m : R.maten(R.walkForward(data, meta, extra, wfOpties(regels, { h, set })).voorspellingen, { h, trekkingen: 300 });
    varianten.push({ h, set, hoofd: h === regels.horizon && set === regels.set, ic: rond(vm.ic, 4), ic_t: rond(vm.ic_t, 2), top_meer: rond(vm.top_meer, 5), jaren_pos: rond(vm.jaren_pos, 2) });
  }
  // portefeuilleproeven op de buiten-steekproef van de hoofdvariant
  const vs = hoofd.voorspellingen.filter((v) => v.t + 1 < data.dagen.length);
  const pp = (o) => { const r = R.portefeuilleProef(data, meta, vs, Object.assign({ regels, tarieven: regels.tarieven }, o)); return { eind: rond(r.eind, 2), rendement: rond(r.rendement, 4), per_jaar: rond(r.per_jaar, 4), terugval: rond(r.terugval, 4), wissels: r.wissels, kosten_pct: rond(r.kosten_pct, 4), lijn: maandLijn(r.lijn, o.start || regels.start) }; };
  const metaIdx = Object.assign({}, meta, { [invoer.index]: { thema: 'index', laag: 'index', tarief: 'ETF' } });
  const portefeuille = {
    echt: pp({ soort: 'echt', stopUit: !regels.stop_aan }), echt_10000: pp({ soort: 'echt', start: 10000, stopUit: !regels.stop_aan }),
    echt_met_stop: pp({ soort: 'echt', stopUit: false }), echt_zonder_stop: pp({ soort: 'echt', stopUit: true }),
    zonder_kosten: pp({ soort: 'echt', kosten: false, stopUit: !regels.stop_aan }), signaal: pp({ soort: 'signaal', kosten: false }), terugval: pp({ soort: 'terugval' }),
    vasthouden: pp({ soort: 'vasthouden', kosten: false }),   // zuivere maatstaf: 40 orders van € 25 kosten anders ± 9–12 %
    index: (function () { const r = R.portefeuilleProef(data, metaIdx, vs, { regels, tarieven: regels.tarieven, soort: 'index', index: invoer.index }); return { eind: rond(r.eind, 2), rendement: rond(r.rendement, 4), per_jaar: rond(r.per_jaar, 4), terugval: rond(r.terugval, 4), lijn: maandLijn(r.lijn, regels.start) }; })(),
  };
  return {
    ok: true, gemaakt_ms: Date.now() - t0, instellingen_sha: sha,
    data: { van: data.dagen[0], tot: data.dagen[data.dagen.length - 1], beursdagen: data.dagen.length, instrumenten: Object.keys(meta).length, test_van: vs.length ? vs[0].dag : null, test_dagen: m.dagen },
    hoofd: { h: regels.horizon, set: regels.set, ic: rond(m.ic, 4), ic_t: rond(m.ic_t, 2), ic0: rond(m.ic0, 4), ic_min_ic0: rond(m.ic_min_ic0, 4), jaren: m.jaren.map((j) => ({ jaar: j.jaar, ic: rond(j.ic, 4), dagen: j.dagen })), jaren_pos: rond(m.jaren_pos, 2),
      top_meer: rond(m.top_meer, 5), top_meer_90: m.top_meer_90 ? { onder: rond(m.top_meer_90.onder, 5), boven: rond(m.top_meer_90.boven, 5) } : null,
      trefkans_top: rond(m.trefkans_top, 4), trefkans_alle: rond(m.trefkans_alle, 4), brier: rond(m.brier, 5), bakjes: m.bakjes.map((b) => ({ p: rond(b.p, 3), y: rond(b.y, 3), n: b.n })) },
    oordeel: ord, robuust, lek, varianten, portefeuille,
    model: (function () { const md = hoofd.modellen[hoofd.modellen.length - 1]; return md && md.w ? { namen: hoofd.namen, w: md.w.map((x) => rond(x, 5)), lambda: md.lambda, helling: rond(md.helling, 6) } : null; })(),
  };
}
function maandLijn(lijn, start) {   // één punt per maandeinde, als index (start = 100)
  const uit = []; for (let i = 0; i < lijn.length; i++) { const m = lijn[i].dag.slice(0, 7); if (i === lijn.length - 1 || lijn[i + 1].dag.slice(0, 7) !== m) uit.push([lijn[i].dag, rond(lijn[i].w / start * 100, 2)]); }
  return uit;
}

module.exports = { scoor, backtest };

if (require.main === module) {
  // gebruik: node strateeg-kind.js <taak> <invoer.json>   (uitvoer: JSON op stdout, of via process.send bij fork)
  const fs = require('fs');
  let uit;
  try {
    const invoer = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    uit = process.argv[2] === 'backtest' ? backtest(invoer) : scoor(invoer);
  } catch (e) { uit = { ok: false, fout: String(e && e.message || e).slice(0, 200) }; }
  if (process.send) process.send(uit, () => process.exit(0)); else { process.stdout.write(JSON.stringify(uit)); }
}
