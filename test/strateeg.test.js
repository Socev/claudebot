'use strict';
// wv3993 — Strateeg (OVIS Beleggen, fictief geld). Toetsen op rekenen, bronnen, regels, lekproeven en de kwartierlus met nep-bronnen.
// Draaien: node --test test/strateeg.test.js   (ST_DIR=<map> om een kopie te toetsen, voor de kruisproef)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DIR = process.env.ST_DIR || path.join(__dirname, '..');
const R = require(path.join(DIR, 'strateeg-reken.js'));
const B = require(path.join(DIR, 'strateeg-bron.js'));
const S = require(path.join(DIR, 'strateeg.js'));
const FIX = path.join(__dirname, 'fixtures', 'strateeg');

// ── synthetische koersen (vast zaad) ──
function synth(nInst, nDagen, zaad) {
  const rng = R.zaadRng(zaad || 5), dagen = [], P = {}, meta = {};
  let d = new Date('2020-01-01T12:00:00Z');
  while (dagen.length < nDagen) { const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) dagen.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
  for (let i = 0; i < nInst; i++) {
    const isin = 'XX' + String(i).padStart(9, '0') + '0', a = new Float64Array(nDagen); let k = 50 + 50 * rng();
    for (let t = 0; t < nDagen; t++) { const g = (rng() + rng() + rng() - 1.5) * 0.03; k *= Math.exp(g); a[t] = k; }
    P[isin] = a; meta[isin] = { thema: i % 2 ? 'tech' : 'health', laag: 'l' + (i % 5), tarief: 'VS', beurs: 'VS', naam: 'Naam ' + i };
  }
  return { data: { dagen, P }, meta };
}

test('rangZ: gelijke waarden krijgen dezelfde rang, null blijft null, gemiddeld 0', () => {
  const z = R.rangZ([3, 1, 3, null, 2]);
  assert.strictEqual(z[3], null);
  assert.strictEqual(z[0], z[2]);
  assert.ok(Math.abs(R.gem(z.filter((x) => x != null))) < 1e-12);
});
test('spearman: monotoon = 1, omgekeerd = −1', () => {
  assert.ok(Math.abs(R.spearman([1, 2, 3, 4, 5, 6], [10, 20, 30, 40, 50, 60]) - 1) < 1e-12);
  assert.ok(Math.abs(R.spearman([1, 2, 3, 4, 5, 6], [6, 5, 4, 3, 2, 1]) + 1) < 1e-12);
});
test('ridge: lambda 0 = kleinste kwadraten (bekende oplossing)', () => {
  // y = 2 x1 − 3 x2 exact
  const X = [[1, 0], [0, 1], [1, 1], [2, 1], [1, 3]], y = X.map((x) => 2 * x[0] - 3 * x[1]);
  const XtX = [[0, 0], [0, 0]], Xty = [0, 0];
  for (let r = 0; r < X.length; r++) for (let i = 0; i < 2; i++) { Xty[i] += X[r][i] * y[r]; for (let j = 0; j < 2; j++) XtX[i][j] += X[r][i] * X[r][j]; }
  const w = R.ridge(XtX, Xty, 0);
  assert.ok(Math.abs(w[0] - 2) < 1e-9 && Math.abs(w[1] + 3) < 1e-9);
  const w2 = R.ridge(XtX, Xty, 100); assert.ok(Math.abs(w2[0]) < 2 && Math.abs(w2[1]) < 3);   // krimpt
});
test('platt: ijking is monotoon stijgend bij positief verband', () => {
  const s = [], y = []; const rng = R.zaadRng(3);
  for (let i = 0; i < 2000; i++) { const x = rng() * 2 - 1; s.push(x); y.push(rng() < 0.5 + 0.3 * x ? 1 : 0); }
  const p = R.platt(s, y); assert.ok(p.b > 0);
});
test('kosten per tariefklasse (aanname uit de regels)', () => {
  const T = S.REGELS.tarieven;
  assert.strictEqual(R.kosten(T, 'VS', 160, 'koop').totaal, 2 + 0.4);
  assert.strictEqual(R.kosten(T, 'NL', 160, 'koop').totaal, 3);
  assert.ok(Math.abs(R.kosten(T, 'EUVL', 200, 'koop').totaal - (4.9 + 0.5 + 1)) < 1e-9);
  assert.ok(Math.abs(R.kosten(T, 'EUVL', 200, 'verkoop').totaal - (4.9 + 0.5)) < 1e-9);   // zegel alleen bij koop
});

// ── bronnen ──
test('L&S dagreeks: weekend en lopende dag eruit, geen opschoning met toekomstige dagen', () => {
  const t = fs.readFileSync(path.join(FIX, 'ls-dag.json'), 'utf8');
  const r = B.lsDagreeks(t, '2026-11-23');
  assert.ok(r.every((p) => p.d < '2026-11-23'), 'lopende dag telt nooit als slot');
  assert.ok(r.every((p) => { const w = new Date(p.d + 'T12:00:00Z').getUTCDay(); return w !== 0 && w !== 6; }), 'geen weekend');
  assert.ok(r.some((p) => p.d === '2026-11-18'), 'geen opschoning die naar latere dagen kijkt: de uitschieter blijft');
  assert.ok(r.some((p) => p.d === '2026-11-20'));
});
test('L&S minuutreeks + kloktijd-stempel', () => {
  const x = B.lsIntraday(fs.readFileSync(path.join(FIX, 'ls-minuut.json'), 'utf8'));
  assert.strictEqual(x.isin, 'NL0010273215'); assert.ok(x.punten.length > 50); assert.ok(x.vorige > 0);
  // gemeten 23-11: stempel 09:11Z is 08:11 UTC (Duitse kloktijd in wintertijd)
  assert.strictEqual(R.lsEchteMs(Date.UTC(2026, 10, 23, 9, 11)), Date.UTC(2026, 10, 23, 8, 11));
  assert.strictEqual(R.lsEchteMs(Date.UTC(2026, 6, 1, 9, 11)), Date.UTC(2026, 6, 1, 7, 11));   // zomertijd
});
test('Wikipedia, SEC en Nasdaq-kalender ontleden; kapot = null of leeg', () => {
  const w = B.wikiRijen(fs.readFileSync(path.join(FIX, 'wiki.json'), 'utf8'));
  assert.deepStrictEqual(w[0], { d: '2026-11-01', v: 1200 });
  assert.deepStrictEqual(B.secCijferdagen(fs.readFileSync(path.join(FIX, 'sec.json'), 'utf8')), ['2026-05-20', '2026-08-26']);
  assert.deepStrictEqual(B.nasdaqCijfers(fs.readFileSync(path.join(FIX, 'nasdaq-cijfers.json'), 'utf8')).map((x) => x.code), ['DELL', 'NVDA']);
  assert.strictEqual(B.wikiRijen('kapot'), null); assert.strictEqual(B.lsDagreeks('{}'), null); assert.strictEqual(B.lsIntraday('<html>'), null);
  assert.throws(() => B.lsReeksUrl('1; rm', 'intraday')); assert.throws(() => B.wikiUrl('a/b', '20250101', '20250102'));
});

// ── vers en beurs ──
test('vers: oud of vlak = niet vers', () => {
  const nu = Date.UTC(2026, 10, 23, 14, 0);
  const p = []; for (let k = 30; k >= 0; k--) p.push([nu - k * 60000, 100 + (k % 4)]);
  assert.ok(R.vers(p, nu).vers);
  assert.strictEqual(R.vers(p.map((x) => [x[0] - 10 * 60000, x[1]]), nu).reden, 'oud');
  assert.strictEqual(R.vers(p.map((x) => [x[0], 100]), nu).reden, 'vlak');
  assert.strictEqual(R.vers(p.map((x) => [x[0] + 60 * 60000, x[1]]), nu).reden, 'klok');
});
test('beursuren: VS via New York (ook rond de zomertijd), sluitingsdag, vroeg dicht', () => {
  const BZ = S.REGELS.beurzen;
  assert.ok(R.beursOpen(BZ, 'VS', Date.UTC(2026, 10, 23, 14, 31)));     // 15:31 NL = 09:31 NY
  assert.ok(!R.beursOpen(BZ, 'VS', Date.UTC(2026, 10, 23, 14, 29)));
  assert.ok(!R.beursOpen(BZ, 'VS', Date.UTC(2026, 10, 26, 16, 0)));     // Thanksgiving
  assert.ok(!R.beursOpen(BZ, 'VS', Date.UTC(2026, 10, 27, 18, 30)));    // vroeg dicht 13:00 NY
  assert.ok(R.beursOpen(BZ, 'VS', Date.UTC(2026, 2, 16, 13, 31)));      // 16-3: NY al zomertijd, NL nog niet → 14:31 NL
  assert.ok(R.beursOpen(BZ, 'EA', Date.UTC(2026, 10, 23, 8, 0)) && !R.beursOpen(BZ, 'EA', Date.UTC(2026, 10, 23, 16, 30)));
  assert.ok(!R.beursOpen(BZ, 'EA', Date.UTC(2026, 10, 21, 10, 0)));     // zaterdag
});

// ── besluit: spreiding, minimum order, houdtijd, één wissel, budget ──
function sBesluit(over) {
  const meta = {}, mu = {}, prijzen = {};
  const lagen = ['chips', 'chips', 'chips', 'platform', 'platform', 'software', 'farma', 'farma', 'farma', 'biotech', 'biotech', 'medtech'];
  lagen.forEach((l, k) => { const i = 'I' + k; meta[i] = { thema: k < 6 ? 'tech' : 'health', laag: l, tarief: 'VS' }; mu[i] = (12 - k) / 100; prijzen[i] = 100; });
  return Object.assign({ regels: S.REGELS, meta, tarieven: S.REGELS.tarieven, prijzen, mu, posities: [], contant: 1000, vandaagIdx: 100, wisselVandaag: false, budgetOver: 30,
    magKopen: () => true, magVerkopen: () => true, stopUit: true, opbouw: true, opbouwMax: 6 }, over);
}
test('opbouw: zes posities, hooguit 2 per laag, 4 per thema, minstens 2 per thema, ≥ € 120, contant ≥ 2 %', () => {
  const s = sBesluit(), r = R.besluit(s);
  const koop = r.orders.filter((x) => x.kant === 'koop');
  assert.strictEqual(koop.length, 6);
  const laag = {}, th = {}; koop.forEach((o) => { const m = s.meta[o.isin]; laag[m.thema + m.laag] = (laag[m.thema + m.laag] || 0) + 1; th[m.thema] = (th[m.thema] || 0) + 1; });
  assert.ok(Object.values(laag).every((n) => n <= 2)); assert.ok(Object.values(th).every((n) => n <= 4 && n >= 2));
  const uit = koop.reduce((a, o) => a + o.aantal * 100 * (1 + S.REGELS.halve_spread) + R.kosten(S.REGELS.tarieven, 'VS', o.aantal * 100, 'koop').totaal, 0);
  assert.ok(1000 - uit >= 0.02 * 1000 - 1e-6, 'contant-ondergrens');
  assert.ok(koop.every((o) => o.aantal * 100 >= S.REGELS.min_order - 3));
});
function belegd(over) {
  const s = sBesluit(), pos = ['I6', 'I7', 'I9', 'I3', 'I5', 'I11'].map((i) => ({ isin: i, aantal: 1.6, aankoop: 100, sinds: 90 }));
  return Object.assign(s, { posities: pos, contant: 40, opbouw: false }, over || {});
}
test('wissel alleen als de voorsprong groter is dan de kosten; houdtijd; één per dag; budget', () => {
  const s = belegd(); s.mu.I0 = 0.30;   // I0 (chips) veel beter dan de slechtste
  let r = R.besluit(s); assert.strictEqual(r.reden_code, 'gewisseld'); assert.strictEqual(r.orders.length, 2);
  const s1 = belegd(); Object.keys(s1.mu).forEach((i) => { s1.mu[i] = 0.01; }); s1.mu.I0 = 0.02; s1.mu.I11 = 0.005;   // voorsprong 1,5 % < ± 3 % kosten
  r = R.besluit(s1); assert.strictEqual(r.reden_code, 'kosten_hoger');
  Object.keys(s1.mu).forEach((i) => { s1.mu[i] = 0.01; }); assert.strictEqual(R.besluit(s1).reden_code, 'geen_voorsprong');
  const s2 = belegd({ vandaagIdx: 92 }); s2.mu.I0 = 0.30; assert.strictEqual(R.besluit(s2).reden_code, 'houdtijd');
  const s3 = belegd({ wisselVandaag: true }); s3.mu.I0 = 0.30; assert.strictEqual(R.besluit(s3).reden_code, 'al_gewisseld');
  const s4 = belegd({ budgetOver: 0.5 }); s4.mu.I0 = 0.30; assert.strictEqual(R.besluit(s4).reden_code, 'budget_op');
  const s5 = belegd({ magKopen: () => false, kopenReden: () => 'cijfers_nabij' }); s5.mu.I0 = 0.30; assert.strictEqual(R.besluit(s5).reden_code, 'cijfers_nabij');
});
test('opbouw die wacht zegt waarom (beurs dicht), niet "geen kandidaat"', () => {
  const r = R.besluit(sBesluit({ magKopen: () => false, kopenReden: () => 'beurs_dicht' }));
  assert.strictEqual(r.orders.length, 0); assert.strictEqual(r.reden_code, 'beurs_dicht');
});
test('voerUit: contant nooit negatief', () => {
  const boek = { contant: 50, posities: [] };
  const g = R.voerUit(boek, { isin: 'I0', kant: 'koop', aantal: 10 }, 100, { I0: { tarief: 'VS' } }, S.REGELS.tarieven, S.REGELS, 1, true);
  assert.ok(g && boek.contant >= -1e-9 && g.aantal < 1);
});

// ── lekproeven en walk-forward op synthetische ruis ──
test('lekproeven: afkap groen, kanarie ontploft, schud ≈ 0, doeluitlijning', () => {
  const { data, meta } = synth(30, 900, 11);
  const o = { h: 10, set: 'prijs', start: data.dagen[700].slice(0, 7), venster: 600, lambdas: [0.01, 1], periode: 'maand' };
  assert.ok(R.afkapProef(data, meta, {}, { n: 6, set: 'prijs' }).ok, 'afkap');
  assert.ok(!R.afkapProef(data, meta, {}, { n: 4, set: 'prijs', kanarie: 10 }).ok, 'kanarie maakt de afkapproef rood');
  const kan = R.maten(R.walkForward(data, meta, {}, Object.assign({ kanarie: 10 }, o)).voorspellingen, { h: 10, trekkingen: 50 });
  assert.ok(kan.ic > 0.3, 'kanarie-IC ' + kan.ic);
  const sch = R.maten(R.walkForward(data, meta, {}, Object.assign({ schud: 4 }, o)).voorspellingen, { h: 10, trekkingen: 50 });
  assert.ok(Math.abs(sch.ic) < 0.03, 'schud-IC ' + sch.ic);
  assert.ok(R.doelProef(data, meta, 10).ok, 'doel gebruikt alleen t+1 en t+1+h');
});
test('walk-forward: geen voorspelling vóór de start, training alleen op bekende doelen', () => {
  const { data, meta } = synth(20, 800, 2);
  const wf = R.walkForward(data, meta, {}, { h: 10, set: 'prijs', start: data.dagen[650].slice(0, 7), venster: 500, lambdas: [1], periode: 'week' });
  assert.ok(wf.voorspellingen.length > 50);
  assert.ok(wf.voorspellingen.every((v) => v.dag >= data.dagen[600]));
  for (const m of wf.modellen) assert.ok(m.ijk_max_t + 1 + 10 <= m.eerste_t - 1, 'ijking alleen uit voorspellingen waarvan het doel al bekend was');
  for (const m of wf.modellen) if (m.train_tot) { const eerste = wf.voorspellingen.find((v) => R.periodeVan(v.dag, 'week') === m.periode); if (eerste) { const iT = data.dagen.indexOf(m.train_tot); assert.ok(iT + 1 + 10 <= eerste.t - 1, 'doel van de laatste trainingsdag was bekend vóór de eerste testdag'); } }
});
test('oordeel: IC te mooi of een rode lekproef = voorspelt niet', () => {
  const m = { ic: 0.05, ic_t: 3, jaren_pos: 0.8, top_meer_90: { onder: 0.001 }, ic_min_ic0: 0.01 };
  assert.ok(R.oordeel(m, { ok: true }).voorspelt);
  assert.ok(!R.oordeel(m, { ok: false }).voorspelt);
  assert.ok(!R.oordeel(Object.assign({}, m, { ic: 0.3 }), { ok: true }).voorspelt);
});

// ── universum ──
test('universum: Anthropic er niet in; elke regel compleet; geen dubbele', () => {
  const U = S.UNIVERSUM;
  assert.ok(!U.instrumenten.some((i) => i.isin === 'US03703U1079'));
  assert.ok(U.nooit.includes('US03703U1079'));
  assert.strictEqual(new Set(U.instrumenten.map((i) => i.isin)).size, U.instrumenten.length);
  for (const i of U.instrumenten) { assert.ok(i.thema && i.laag && i.beurs && i.tarief && i.ls_id, i.isin); assert.ok(S.REGELS.tarieven[i.tarief] && S.REGELS.beurzen[i.beurs]); }
});

// ── de module met nep-bronnen: opzet, dagronde, start, kwartieren, avond ──
function nepModule(o) {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'strateeg-'));
  let klok = o.start;
  const logs = [], urls = [];
  const idNaarIsin = {}; for (const i of S.UNIVERSUM.instrumenten.concat([S.UNIVERSUM.index])) idNaarIsin[i.ls_id] = i.isin;
  const rng = R.zaadRng(9);
  const hist = {};
  const haal = async (url) => {
    urls.push(url);
    const id = (/instrumentId=(\d+)/.exec(url) || [])[1];
    if (/series=history/.test(url)) {
      if (!hist[id]) { const d = []; let k = 100 + 100 * rng(); const t0 = Date.UTC(2023, 0, 2); for (let n = 0; n < 1400; n++) { const ms = t0 + n * 86400000; const wd = new Date(ms).getUTCDay(); if (wd === 0 || wd === 6) continue; k *= Math.exp((rng() - 0.5) * 0.03); if (ms < klok - 86400000) d.push([ms, k]); } hist[id] = d; }
      return JSON.stringify({ series: { history: { data: hist[id] } } });
    }
    if (/series=intraday/.test(url)) {
      const isin = idNaarIsin[id]; const laatst = hist[id] ? hist[id][hist[id].length - 1][1] : 100;
      const pnt = []; const nuMs = klok; const begin = nuMs - 90 * 60000;
      const vlak = o.vlak && o.vlak(isin, klok);
      for (let t = begin; t <= nuMs - 60000; t += 60000) { const klokMs = t + 3600000; pnt.push([klokMs, vlak ? laatst : laatst * (1 + 0.01 * Math.sin(t / 600000 + Number(id)))]); }
      return JSON.stringify({ info: { isin, plotlines: [{ id: 'previousDay', value: laatst }] }, series: { intraday: { data: pnt } } });
    }
    if (/wikimedia/.test(url)) { if (o.wiki403) throw new Error('http 403'); return JSON.stringify({ items: [] }); }
    if (/data\.sec\.gov/.test(url)) return JSON.stringify({ filings: { recent: { form: [], filingDate: [], items: [] }, files: [] } });
    if (/calendar\/earnings/.test(url)) return JSON.stringify({ data: { rows: [] } });
    throw new Error('onbekend adres');
  };
  const kind = async (taak, invoer) => {
    const isins = o.volgorde ? o.volgorde(Object.keys(invoer.meta)) : Object.keys(invoer.meta);
    const dag = Object.values(invoer.reeksen)[0].slice(-1)[0].d;
    if (taak === 'scoor' && o.kindFaal > 0) { o.kindFaal--; return { ok: false, fout: 'nep' }; }
    if (taak === 'backtest') return { ok: true, instellingen_sha: 'x', gemaakt_ms: 1, oordeel: { voorspelt: o.voorspelt !== false, criteria: [] }, portefeuille: {}, data: {}, hoofd: {}, lek: { ok: true }, varianten: [] };
    return { ok: true, dag, model: { periode: 'p', w: [], namen: [] }, voorspellingen: isins.map((isin, k) => ({ isin, score: (isins.length - k) / 10, mu: (isins.length - k) / 1000, kans: 0.5, doorslag: [['r126', 0.1]] })), recent: [] };
  };
  const m = S.maak({ dbPad: path.join(map, 'strateeg.sqlite'), haal, nu: () => klok, kind, log: (x) => logs.push(x), pauzeMs: 0, boxRij: () => {} });
  return { m, zet: (ms) => { klok = ms; }, logs, urls, map };
}
test('kwartierlus: opzet → dagronde → start → opbouw binnen de regels → avond; log zonder namen of bedragen', async () => {
  // maandag 30-11-2026 (winter: NL = UTC+1)
  const N = nepModule({ start: Date.UTC(2026, 10, 30, 5, 0) });
  assert.strictEqual((await N.m.tik()).gedaan, 'opzet');
  N.zet(Date.UTC(2026, 10, 30, 6, 0)); assert.strictEqual((await N.m.tik()).gedaan, 'dagronde');
  const o1 = N.m.app({ methode: 'GET', pad: '/app/beleggen/strateeg' }).body;
  assert.strictEqual(o1.stand, 'aan'); assert.strictEqual(o1.startdag, '2026-11-30'); assert.strictEqual(o1.modus, 'engine'); assert.ok(o1.fictief);
  let kw = 0;
  for (let min = 9 * 60 + 1; min <= 22 * 60 + 1; min += 15) { N.zet(Date.UTC(2026, 10, 30, Math.floor(min / 60) - 1, min % 60)); const r = await N.m.tik(); if (r.gedaan === 'kwartier') kw++; }
  assert.strictEqual(kw, 53);
  // zelfde minuut twee keer = één tik
  N.zet(Date.UTC(2026, 10, 30, 21, 1)); assert.notStrictEqual((await N.m.tik()).gedaan, 'kwartier');
  N.zet(Date.UTC(2026, 10, 30, 21, 6)); assert.strictEqual((await N.m.tik()).gedaan, 'avond');
  const o = N.m.app({ methode: 'GET', pad: '/app/beleggen/strateeg' }).body;
  const echt = o.boeken.echt;
  assert.strictEqual(echt.posities.length, 6, 'zes posities na de opbouw');
  assert.ok(echt.contant >= 0);
  const th = {}; echt.posities.forEach((p) => { th[p.thema] = (th[p.thema] || 0) + 1; }); assert.ok(th.tech >= 2 && th.health >= 2);
  assert.ok(o.boeken.vasthouden.posities.length >= 38, 'maatstaf gekocht');
  assert.strictEqual(o.boeken.wereld.posities.length, 1);
  assert.ok(o.boeken.signaal.posities.length === 6);
  assert.ok(o.orders.every((x) => x.reden_zin && x.reden_zin.length > 20), 'elke order heeft een reden-zin');
  assert.ok(o.tikken_vandaag.reduce((a, x) => a + x.n, 0) >= 53);
  assert.ok(o.reeks.echt.length === 1 && o.vandaag_reeks.echt.length >= 24, 'waarde per kwartier vanaf 16:16 op de startdag');
  assert.ok(o.orders.filter((x) => x.boek === 'echt').every((x) => x.tijd >= Date.UTC(2026, 10, 30, 15, 16)), 'op de startdag begint Echt pas samen met de maatstaven (16:16)');
  // geen order binnen 15 minuten na opening van de thuisbeurs (eerste kwartier 09:01 voor Europa)
  const db = N.m._db();
  for (const x of db.prepare("SELECT tijd, isin FROM opdracht WHERE boek = 'echt'").all()) {
    const beurs = S.UNIVERSUM.instrumenten.find((i) => i.isin === x.isin).beurs;
    assert.ok(R.minutenSindsOpen(S.REGELS.beurzen, beurs, x.tijd) >= S.REGELS.niet_eerste_minuten, 'geen order in het eerste kwartier na opening');
    assert.ok(R.beursOpen(S.REGELS.beurzen, beurs, x.tijd), 'alleen als de thuisbeurs open is');
  }
  // log: alleen aantallen
  const tekst = JSON.stringify(N.logs);
  assert.ok(!/[A-Z]{2}[A-Z0-9]{9}\d/.test(tekst), 'geen ISIN in de log');
  assert.ok(!S.UNIVERSUM.instrumenten.some((i) => tekst.includes(i.naam)), 'geen namen in de log');
  // alleen L&S, Wikipedia, SEC en Nasdaq als bestemming; nooit een broker
  assert.ok(N.urls.every((u) => /^https:\/\/(www\.ls-tc\.de|wikimedia\.org|data\.sec\.gov|api\.nasdaq\.com)\//.test(u)), 'bestemmingen');
  assert.ok(!N.urls.some((u) => /degiro|broker/i.test(u)));
  // de module raakt beleggen.sqlite niet en kent alleen drie routes
  assert.ok(!fs.readdirSync(N.map).some((f) => /beleggen/.test(f)));
  assert.strictEqual(N.m.app({ methode: 'POST', pad: '/app/beleggen/strateeg/stand', body: { stand: 'verkoop' } }).status, 400);
  assert.strictEqual(N.m.app({ methode: 'POST', pad: '/app/beleggen/strateeg/order', body: {} }).status, 404);
  assert.strictEqual(N.m.app({ methode: 'POST', pad: '/app/beleggen/strateeg/stand', body: { stand: 'pauze' } }).body.stand, 'pauze');
  N.zet(Date.UTC(2026, 11, 1, 8, 16)); const p = await N.m.tik(); assert.notStrictEqual(p.gedaan, 'kwartier', 'pauze = geen kwartier');
});
test('kwartierlus: proef stopt na de einddag; modus terugval als de backtest niets voorspelt', async () => {
  const N = nepModule({ start: Date.UTC(2026, 10, 30, 5, 0), voorspelt: false });
  await N.m.tik(); N.zet(Date.UTC(2026, 10, 30, 6, 0)); await N.m.tik();
  const o = N.m.app({ methode: 'GET', pad: '/app/beleggen/strateeg' }).body;
  assert.strictEqual(o.modus, 'terugval'); assert.strictEqual(o.einddag, '2026-12-30');
  N.zet(Date.UTC(2026, 11, 31, 9, 1)); await N.m.tik();   // 31-12 10:01 NL: na de einddag
  assert.strictEqual(N.m.app({ methode: 'GET', pad: '/app/beleggen/strateeg' }).body.stand, 'klaar');
});

test('start nooit midden op de dag; dagronde herkanst; 403 van Wikipedia breekt niets; signaal niet aan één minuut', async () => {
  const N = nepModule({ start: Date.UTC(2026, 10, 30, 8, 30), wiki403: true, kindFaal: 1 });   // 09:30 NL
  assert.strictEqual((await N.m.tik()).gedaan, 'opzet');
  N.zet(Date.UTC(2026, 10, 30, 8, 31)); assert.strictEqual((await N.m.tik()).gedaan, 'dagronde');   // kind faalt
  let o = N.m.app({ methode: 'GET', pad: '/app/beleggen/strateeg' }).body;
  assert.strictEqual(o.startdag, null);
  N.zet(Date.UTC(2026, 10, 30, 8, 40)); assert.notStrictEqual((await N.m.tik()).gedaan, 'dagronde', 'niet binnen 20 minuten opnieuw');
  N.zet(Date.UTC(2026, 10, 30, 8, 52)); assert.strictEqual((await N.m.tik()).gedaan, 'dagronde', 'herkansing na 20 minuten');
  o = N.m.app({ methode: 'GET', pad: '/app/beleggen/strateeg' }).body;
  assert.strictEqual(o.startdag, null, 'na 09:00 geslaagd = vandaag geen start');
  assert.ok(o.voorspellingen.lijst.length > 30, 'scores er wel, ondanks 403 van Wikipedia');
  N.zet(Date.UTC(2026, 11, 1, 6, 0)); assert.strictEqual((await N.m.tik()).gedaan, 'dagronde');
  assert.strictEqual(N.m.app({ methode: 'GET', pad: '/app/beleggen/strateeg' }).body.startdag, '2026-12-01');
  // 16:16 gemist (herstart); 16:20 pakt het slot 16:16 op en start signaal + maatstaven
  N.zet(Date.UTC(2026, 11, 1, 15, 20)); assert.strictEqual((await N.m.tik()).gedaan, 'kwartier');
  o = N.m.app({ methode: 'GET', pad: '/app/beleggen/strateeg' }).body;
  assert.strictEqual(o.boeken.signaal.posities.length, 6); assert.ok(o.boeken.vasthouden.posities.length >= 38);
  const sig = o.boeken.signaal.posities.map((p) => p.waarde); assert.ok(Math.max(...sig) / Math.min(...sig) < 1.05, 'Signaal per naam het doelgewicht');
  assert.strictEqual(N.m._M.get('signaal_dag'), '2026-12-01', 'signaal compleet → klaar voor vandaag');
  // een kwartier ouder dan 10 minuten wordt niet ingehaald
  N.zet(Date.UTC(2026, 11, 1, 15, 45)); assert.notStrictEqual((await N.m.tik()).gedaan, 'kwartier');
});

test('geen aankoop in het eerste kwartier na opening van de thuisbeurs (ook niet op dag 2 om 09:01)', async () => {
  const ASML = 'NL0010273215';
  // ASML bovenaan de voorspelling; op dag 1 een vlakke koers (niet vers) → niet gekocht; op dag 2 vers vanaf opening
  const N = nepModule({ start: Date.UTC(2026, 10, 30, 5, 0), volgorde: (l) => [ASML].concat(l.filter((x) => x !== ASML)),
    vlak: (isin, klok) => isin === ASML && klok < Date.UTC(2026, 11, 1, 0, 0) });
  await N.m.tik(); N.zet(Date.UTC(2026, 10, 30, 6, 0)); await N.m.tik();
  for (let min = 16 * 60 + 16; min <= 22 * 60 + 1; min += 15) { N.zet(Date.UTC(2026, 10, 30, Math.floor(min / 60) - 1, min % 60)); await N.m.tik(); }
  const db = N.m._db();
  assert.ok(!db.prepare("SELECT 1 FROM positie WHERE boek = 'echt' AND isin = ?").get(ASML), 'dag 1: niet vers = niet gekocht');
  N.zet(Date.UTC(2026, 11, 1, 6, 0)); await N.m.tik();
  for (let min = 9 * 60 + 1; min <= 10 * 60 + 1; min += 15) { N.zet(Date.UTC(2026, 11, 1, Math.floor(min / 60) - 1, min % 60)); await N.m.tik(); }
  const k = db.prepare("SELECT tijd FROM opdracht WHERE boek = 'echt' AND isin = ? AND kant = 'koop'").get(ASML);
  assert.ok(k, 'dag 2: ASML gekocht');
  assert.ok(R.minutenSindsOpen(S.REGELS.beurzen, 'EA', k.tijd) >= S.REGELS.niet_eerste_minuten, 'niet in het eerste kwartier na opening');
});
