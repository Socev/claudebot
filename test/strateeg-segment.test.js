'use strict';
// wv4002 — Strateeg › boek Segment (fictief). Toetsen op schonen, signaal, rangorde, besluit, kosten, klok en de naspeelproef dat de vier
// boeken van de Strateeg bit-gelijk blijven als Segment meedraait. Draaien: node --test test/strateeg-segment.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DIR = process.env.ST_DIR || path.join(__dirname, '..');
const R = require(path.join(DIR, 'strateeg-reken.js'));
const S = require(path.join(DIR, 'strateeg.js'));
const SR = require(path.join(DIR, 'strateeg-segment-reken.js'));
const G = require(path.join(DIR, 'strateeg-segment.js'));

function zaad(z) { let x = z >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
function reeks(n, z, drift) { const r = zaad(z); let k = 100; const a = []; for (let t = 0; t < n; t++) { k *= Math.exp((drift || 0) + (r() - 0.5) * 0.02); a.push(k); } return a; }

test('schonen: ééndagsfout wordt verdacht, gezamenlijke daling niet, vijf op rij = nieuw niveau, zonder tweede bron de rustregel', () => {
  const n = 120, spdr = {}, ish = {};
  for (let i = 0; i < 6; i++) { spdr['s' + i] = reeks(n, 10 + i); ish['s' + i] = spdr['s' + i].map((x) => x * 1.001); }
  spdr.s0 = spdr.s0.slice(); spdr.s0[60] *= 0.82;                               // −18 % alleen in de SPDR-reeks
  for (const id of Object.keys(spdr)) { spdr[id] = spdr[id].slice(); ish[id] = ish[id].slice(); for (let t = 80; t < n; t++) { spdr[id][t] *= 0.85; ish[id][t] *= 0.85; } }   // echte gezamenlijke daling
  spdr.s1 = spdr.s1.slice(); for (let t = 100; t < n; t++) spdr.s1[t] *= 0.7;     // breuk: blijvend 30 % lager in één bron
  spdr.s2 = spdr.s2.slice(); ish.s2 = spdr.s2.map(() => null); spdr.s2[50] *= 0.8; // geen tweede bron, rustige markt
  const u = SR.schoon({ spdr, ish });
  assert.strictEqual(u.s0.verdacht[60], true); assert.strictEqual(u.s0.k[60], u.s0.k[59], 'verdacht slot telt niet');
  assert.strictEqual(u.s0.verdacht[61], false);
  assert.ok(!Object.values(u).some((s) => s.verdacht[80]), 'gezamenlijke daling is echt');
  assert.deepStrictEqual([100, 101, 102, 103].map((t) => u.s1.verdacht[t]), [true, true, true, true]);
  assert.strictEqual(u.s1.breuk[104], true); assert.strictEqual(u.s1.verdacht[110], false, 'na vijf dagen nieuw niveau');
  assert.strictEqual(u.s2.verdacht[50], true, 'zonder tweede bron: sprong in een rustige markt');
  // afkapproef: schonen op t hangt niet af van latere dagen
  for (const t of [55, 60, 61, 85, 102, 110]) {
    const k = (o) => Object.fromEntries(Object.entries(o).map(([id, a]) => [id, a.slice(0, t + 1)]));
    const v = SR.schoon({ spdr: k(spdr), ish: k(ish) });
    for (const id of Object.keys(spdr)) { assert.strictEqual(v[id].k[t], u[id].k[t]); assert.strictEqual(v[id].verdacht[t], u[id].verdacht[t]); }
  }
});

test('signaal: mom(252, 21) op een handgemaakte reeks; universum pas na 274 goede sloten', () => {
  const n = 300, a = Array.from({ length: n }, (x, t) => 100 + t);
  const s = SR.schoon({ spdr: { x: a, y: a.map((v) => v * 1.1), z: a.map((v) => v * 0.9), p: a.map((v, t) => (t < 40 ? null : v)), q: a, r: a }, ish: {} });
  const sig = SR.signalen(s, n - 1, { signaal: 'mom', a: 252, b: 21, min_sloten: 274 }, {});
  assert.ok(Math.abs(sig.x.x - (a[n - 1 - 21] / a[n - 1 - 252] - 1)) < 1e-12);
  assert.ok(!sig.p, 'te weinig sloten (260) doet niet mee');
  assert.strictEqual(SR.signalen(s, 272, { signaal: 'mom', a: 252, b: 21, min_sloten: 274 }, {}).x, undefined);
});

test('rangorde en doel: buffer (plek 5 blijft, plek 6 gaat), gelijke stand = al in het boek eerst, dan ISIN', () => {
  const sig = {}; ['a', 'b', 'c', 'd', 'e', 'f', 'g'].forEach((id, k) => { sig[id] = { x: 0.7 - k * 0.1, trendOk: true }; });
  const meta = { a: { isin: 'IE1' }, b: { isin: 'IE2' }, c: { isin: 'IE3' }, d: { isin: 'IE4' }, e: { isin: 'IE5' }, f: { isin: 'IE6' }, g: { isin: 'IE7' } };
  const v = { k: 3, buffer: 5 };
  assert.deepStrictEqual(SR.doel(sig, [], v, meta).houd, ['a', 'b', 'c']);
  assert.deepStrictEqual(SR.doel(sig, ['e', 'a', 'f'], v, meta).houd.sort(), ['a', 'b', 'e'], 'e (plek 5) blijft, f (plek 6) gaat, b komt erin');
  const gelijk = { a: { x: 0.1, trendOk: true }, b: { x: 0.1, trendOk: true }, c: { x: 0, trendOk: true }, d: { x: 0, trendOk: true }, e: { x: -1, trendOk: true } };
  assert.deepStrictEqual(SR.rangorde(gelijk, [], meta).lijst.slice(0, 2), ['a', 'b']);
  assert.deepStrictEqual(SR.rangorde(gelijk, ['b'], meta).lijst.slice(0, 2), ['b', 'a']);
  assert.deepStrictEqual(SR.doel(sig, [], { k: 3, buffer: 0 }, meta).houd, ['a', 'b', 'c'], 'zonder buffer precies de top 3');
});

test('plan en uitvoeren: start 3 × 1/3 van 98 %, wissel met de opbrengst, te groot terug, kosten € 1 + 0,10 %, contant nooit negatief', () => {
  const tarief = { vast: 1, halve_spread: 0.001 }, v = { k: 3, max_aandeel: 0.5, contant_min: 0.02 };
  const boek = { contant: 1000, posities: [] }, pr = { a: 10, b: 20, c: 40, d: 5 };
  const p1 = SR.plan(boek, ['a', 'b', 'c'], pr, v);
  assert.strictEqual(p1.length, 3); assert.ok(p1.every((x) => x.kant === 'koop' && Math.abs(x.bedrag - 1000 * 0.98 / 3) < 1e-9 && x.reden === 'start'));
  for (const od of p1) assert.ok(SR.voerUit(boek, od, pr[od.id], tarief));
  assert.ok(boek.contant >= 0 && boek.contant < 30); assert.strictEqual(boek.posities.length, 3);
  const vanaf = boek.contant;
  const p2 = SR.plan(boek, ['a', 'b', 'd'], pr, v);
  assert.deepStrictEqual(p2.map((x) => x.kant + ':' + x.id), ['verkoop:c', 'koop:d']);
  for (const od of p2) SR.voerUit(boek, od, pr[od.id], tarief);
  assert.ok(boek.contant >= 0 && boek.contant < vanaf + 20); assert.ok(boek.posities.some((p) => p.id === 'd'));
  assert.ok(boek.posities.every((p) => Math.abs(p.aantal * 1e4 - Math.round(p.aantal * 1e4)) < 1e-6), 'fracties op 4 decimalen');
  // te groot: a verdrievoudigt → deels verkopen
  const p3 = SR.plan(boek, ['a', 'b', 'd'], { a: 60, b: 20, d: 5 }, v);
  assert.ok(p3.some((x) => x.id === 'a' && x.reden === 'te_groot'));
  // contant nooit negatief: koop groter dan het contant
  const b2 = { contant: 50, posities: [] }; SR.voerUit(b2, { id: 'a', kant: 'koop', bedrag: 500 }, 10, { vast: 4.9, halve_spread: 0.001 });
  assert.ok(b2.contant >= 0);
});

test('backtest-motor: kanarie (opzettelijk lek) wint ruim, nul-boek handelt eens per jaar, herzieningen alleen op maandeinde', () => {
  const n = 900, dagen = []; let d = new Date('2016-01-04T12:00:00Z');
  while (dagen.length < n) { const wd = d.getUTCDay(); if (wd && wd !== 6) dagen.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 864e5); }
  const spdr = {}, ish = {}; for (let i = 0; i < 8; i++) { spdr['s' + i] = reeks(n, 30 + i, (i - 4) * 0.0001); ish['s' + i] = spdr['s' + i]; }
  const D = { dagen, S: SR.schoon({ spdr, ish }), meta: {} };
  const v = { signaal: 'mom', a: 252, b: 21, k: 3, buffer: 5, herzien: 'maand' };
  const u = SR.backtest(D, v, { vast: 1 });
  assert.ok(u.herz.length > 10 && u.herz.every((h) => dagen[h.t].slice(0, 7) !== dagen[h.t + 1].slice(0, 7)));
  const toek = (t) => { let b = null; for (let j = t + 1; j < n - 1; j++) if (SR.isHerzieDag(dagen, j, v)) { b = j + 1; break; } if (!b) return null; const o = {}; for (const id of Object.keys(D.S)) o[id] = D.S[id].k[b] / D.S[id].k[t + 1] - 1; return o; };
  const k = SR.backtest(D, { signaal: 'kanarie', a: 252, b: 21, k: 3, buffer: 0, herzien: 'maand' }, { vast: 1, toekomst: toek });
  const e = (x) => x.lijn[x.lijn.length - 1][1];
  assert.ok(e(k) > e(u) * 1.2, 'een lek zou zichtbaar zijn');
  const nul = SR.nulBoek(D, { vast: 1 }); assert.ok(nul.kosten > 0 && nul.kosten < 60);
});

test('backtest (Codex-MOET 3/4): geen order op een doorgeschoven koers; een mislukte start wordt bij de volgende herziening opnieuw geprobeerd', () => {
  const n = 700, dagen = []; let d = new Date('2016-01-04T12:00:00Z');
  while (dagen.length < n) { const wd = d.getUTCDay(); if (wd && wd !== 6) dagen.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 864e5); }
  const spdr = {}; for (let i = 0; i < 6; i++) spdr['s' + i] = reeks(n, 50 + i, (i - 3) * 0.0003);
  const v = { signaal: 'mom', a: 252, b: 21, k: 3, buffer: 5, herzien: 'maand' };
  const hz = []; for (let t = 300; t < n - 1; t++) if (SR.isHerzieDag(dagen, t, v)) hz.push(t);
  // alle reeksen missen 5 dagen na de eerste herziening: start vervalt (3 pogingen), volgende herziening start alsnog
  const gat = new Set([1, 2, 3, 4, 5].map((k) => hz[0] + k));
  for (const id of Object.keys(spdr)) spdr[id] = spdr[id].map((x, t) => (gat.has(t) ? null : x));
  const D = { dagen, S: SR.schoon({ spdr, ish: {} }), meta: {} };
  const u = SR.backtest(D, v, { vast: 1, test_vanaf: dagen[hz[0] - 5] });
  assert.ok(u.lijn.length > 0, 'het boek is gestart');
  assert.ok(u.lijn[0][0] > dagen[hz[1]], 'start pas na de tweede herziening');
});

test('live (Codex-MOET 1/2): een afgewezen koers telt niet voor de waardering; zonder koers voor een gehouden positie geen plan (ook geen "te groot")', async () => {
  const X = maakBeide(true);
  const echt = X.N.haal; let sprongId = null;
  X.g = G.maak({ db: X.m._db, nu: X.N.nu, pauzeMs: 0, universumIsins: [], strateegStand: () => 'aan', wereldIsin: S.UNIVERSUM.index.isin,
    haal: async (url) => { const t = await echt(url); if (sprongId && /series=intraday/.test(url) && url.includes('instrumentId=' + sprongId + '&')) { const j = JSON.parse(t); j.series.intraday.data = j.series.intraday.data.map(([a, b]) => [a, b * 1.3]); return JSON.stringify(j); } return t; } });
  X.N.zet(Date.UTC(2026, 11, 1, 6, 35)); await X.g.tik({ gedaan: 'niets' }); X.N.zet(Date.UTC(2026, 11, 1, 6, 36)); await X.g.tik({ gedaan: 'niets' });
  const db = X.m._db();
  const top = db.prepare("SELECT id FROM seg_rang WHERE dag = '2026-12-01' AND rang IS NOT NULL ORDER BY rang LIMIT 3").all().map((r) => G.SEG.etf.find((e) => e.id === r.id));
  const slot = (isin) => db.prepare('SELECT slot FROM dagkoers WHERE isin = ? ORDER BY dag DESC LIMIT 1').get(isin).slot;
  // het boek houdt de top 3; de eerste is veruit het grootst, de tweede is > 50 % van (tweede + derde + contant): telt de eerste als nul, dan lijkt de tweede "te groot"
  db.prepare("INSERT OR REPLACE INTO boek (id, start, contant, opgezet) VALUES ('segment', 1000, 10, 1)").run();
  const w = [800, 150, 40];
  top.forEach((e, k) => db.prepare("INSERT OR REPLACE INTO positie (boek, isin, aantal, aankoop, sinds) VALUES ('segment', ?, ?, ?, '2026-11-24')").run(e.isin, Math.round((w[k] / slot(e.isin)) * 1e4) / 1e4, slot(e.isin)));
  X.g._M.zet('seg_startdag', '2026-11-24'); X.g._M.zet('seg_herz_maand', '2026-11');
  sprongId = top[0].ls_id;   // +30 % zonder bevestiging van de tweeling → afgewezen
  X.N.zet(Date.UTC(2026, 11, 1, 15, 20)); assert.strictEqual((await X.g.tik({ gedaan: 'niets' })).gedaan, 'herziening');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM opdracht WHERE boek = 'segment'").get().n, 0, 'geen orders zonder koers voor elke gehouden positie');
  assert.ok(!db.prepare('SELECT 1 FROM laatst WHERE isin = ?').get(top[0].isin), 'afgewezen sprongkoers niet in laatst');
  assert.ok(db.prepare('SELECT 1 FROM laatst WHERE isin = ?').get(top[1].isin), 'goedgekeurde koers wel in laatst');
  assert.match(X.g.overzicht().herziening.zin, /uitgesteld/);
});

test('harde deadline per beurt (Codex ronde 2): een hangend verzoek houdt Segment niet langer op dan de grens', async () => {
  const X = maakBeide(true);
  const g = G.maak({ db: X.m._db, nu: X.N.nu, pauzeMs: 0, maxBeurtMs: 300, universumIsins: [], strateegStand: () => 'aan', haal: () => new Promise(() => {}) });
  X.N.zet(Date.UTC(2026, 11, 1, 6, 35));
  const t0 = Date.now(); const u = await g.tik({ gedaan: 'niets' });
  assert.strictEqual(u.gedaan, 'tijd'); assert.ok(Date.now() - t0 < 2000, 'binnen de grens terug');
  assert.strictEqual(X.m._db().prepare("SELECT status FROM seg_tik ORDER BY tijd DESC LIMIT 1").get().status, 'tijd');
});

// ── nep-bronnen, per ISIN eigen vast zaad (onafhankelijk van de volgorde van de verzoeken) ──
function nepBronnen() {
  let klok = 0; const urls = [];
  const idNaarIsin = {}; for (const i of S.UNIVERSUM.instrumenten.concat([S.UNIVERSUM.index])) idNaarIsin[i.ls_id] = i.isin;
  for (const e of G.SEG.etf) { idNaarIsin[e.ls_id] = e.isin; idNaarIsin[e.tweeling_ls] = e.tweeling_isin; }
  const hist = {};
  const haal = async (url) => {
    urls.push(url);
    const id = Number((/instrumentId=(\d+)/.exec(url) || [])[1]);
    if (/series=history/.test(url)) {
      if (!hist[id]) { const r = zaad(id); const d = []; let k = 50 + 100 * r(); const t0 = Date.UTC(2023, 0, 2); for (let n = 0; n < 1450; n++) { const ms = t0 + n * 864e5; const wd = new Date(ms).getUTCDay(); if (wd === 0 || wd === 6) continue; k *= Math.exp((r() - 0.5) * 0.03 + (id % 7) * 0.0002); d.push([ms, k]); } hist[id] = d; }
      return JSON.stringify({ series: { history: { data: hist[id].filter((p) => p[0] < klok - 864e5) } } });
    }
    if (/series=intraday/.test(url)) {
      const isin = idNaarIsin[id]; const h = (hist[id] || []).filter((p) => p[0] < klok - 864e5); const laatst = h.length ? h[h.length - 1][1] : 100;
      const pnt = []; for (let t = klok - 90 * 60000; t <= klok - 60000; t += 60000) pnt.push([t + 3600000, laatst * (1 + 0.004 * Math.sin(t / 600000 + id))]);
      return JSON.stringify({ info: { isin, plotlines: [{ id: 'previousDay', value: laatst }] }, series: { intraday: { data: pnt } } });
    }
    if (/wikimedia/.test(url)) return JSON.stringify({ items: [] });
    if (/data\.sec\.gov/.test(url)) return JSON.stringify({ filings: { recent: { form: [], filingDate: [], items: [] }, files: [] } });
    if (/calendar\/earnings/.test(url)) return JSON.stringify({ data: { rows: [] } });
    throw new Error('onbekend adres');
  };
  const kind = async (taak, invoer) => {
    const isins = Object.keys(invoer.meta); const dag = Object.values(invoer.reeksen)[0].slice(-1)[0].d;
    if (taak === 'backtest') return { ok: true, instellingen_sha: 'x', gemaakt_ms: 1, oordeel: { voorspelt: true, criteria: [] }, portefeuille: {}, data: {}, hoofd: {}, lek: { ok: true }, varianten: [] };
    return { ok: true, dag, model: { periode: 'p', w: [], namen: [] }, voorspellingen: isins.map((isin, k) => ({ isin, score: (isins.length - k) / 10, mu: (isins.length - k) / 1000, kans: 0.5, doorslag: [['r126', 0.1]] })), recent: [] };
  };
  return { haal, kind, urls, zet: (ms) => { klok = ms; }, nu: () => klok };
}
function maakBeide(metSegment, o) {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'strateeg-seg-'));
  const N = nepBronnen();
  const m = S.maak({ dbPad: path.join(map, 'strateeg.sqlite'), haal: N.haal, nu: N.nu, kind: N.kind, log: () => {}, pauzeMs: 0, boxRij: () => {} });
  const logs = [];
  const g = metSegment ? G.maak(Object.assign({ db: m._db, haal: N.haal, nu: N.nu, pauzeMs: 0, log: (x) => logs.push(x), universumIsins: S.UNIVERSUM.instrumenten.map((i) => i.isin).concat([S.UNIVERSUM.index.isin]), wereldIsin: S.UNIVERSUM.index.isin, strateegStand: () => m._M.get('stand') }, o || {})) : null;
  return { m, g, N, logs, map };
}
async function speelDag(X, y, mo, d, van, tot) {   // elke minuut één tik (NL = UTC+1 in november/december)
  const uit = [];
  for (let min = van; min <= tot; min++) {
    X.N.zet(Date.UTC(y, mo, d, Math.floor(min / 60) - 1, min % 60));
    if (X.spoor) X.spoor.push(min + ' vooraf ' + JSON.stringify(X.m._db().prepare("SELECT sleutel, waarde FROM meta WHERE sleutel NOT LIKE 'seg\\_%' ESCAPE '\\' ORDER BY sleutel").all()));
    const u = await X.m.tik();
    if (X.spoor) X.spoor.push(min + ' ' + JSON.stringify(X.m._db().prepare("SELECT sleutel, waarde FROM meta WHERE sleutel NOT LIKE 'seg\\_%' ESCAPE '\\' ORDER BY sleutel").all()));   // na de Strateeg, vóór Segment
    if (X.g) { const s = await X.g.tik(u); if (s.gedaan !== 'niets' && s.gedaan !== 'wacht_strateeg') uit.push([min, s.gedaan]); }
  }
  return uit;
}
function dump(m) {
  const d = m._db(); const BO = "('echt','signaal','vasthouden','wereld')"; const isins = S.UNIVERSUM.instrumenten.map((i) => i.isin).concat([S.UNIVERSUM.index.isin]);
  const q = (s, ...a) => JSON.stringify(d.prepare(s).all(...a));
  const ph = isins.map(() => '?').join(',');
  return {
    boek: q(`SELECT * FROM boek WHERE id IN ${BO} ORDER BY id`), positie: q(`SELECT * FROM positie WHERE boek IN ${BO} ORDER BY boek, isin`),
    waarde: q(`SELECT * FROM waarde WHERE boek IN ${BO} ORDER BY boek, tijd`), opdracht: q(`SELECT boek, tijd, dag, isin, kant, aantal, midden, prijs, kosten, kosten_uit, reden_code, reden_zin, scores FROM opdracht WHERE boek IN ${BO} ORDER BY id`),
    tik: q('SELECT * FROM tik ORDER BY tijd'), voorspelling: q('SELECT * FROM voorspelling ORDER BY dag, isin'), model: q('SELECT gemaakt, periode, inhoud FROM model ORDER BY id'), backtest: q('SELECT gemaakt, sha, voorspelt, uitkomst FROM backtest ORDER BY id'),
    bron: q('SELECT * FROM bron_stand ORDER BY bron, dag'), kwartier: q('SELECT * FROM kwartier ORDER BY isin, tijd'),
    dagkoers: q(`SELECT * FROM dagkoers WHERE isin IN (${ph}) ORDER BY isin, dag`, ...isins), laatst: q(`SELECT * FROM laatst WHERE isin IN (${ph}) ORDER BY isin`, ...isins),
    meta: q("SELECT * FROM meta WHERE sleutel NOT LIKE 'seg\\_%' ESCAPE '\\' ORDER BY sleutel"),
    route: JSON.stringify(m.app({ methode: 'GET', pad: '/app/beleggen/strateeg' }).body),
  };
}

test('naspeelproef: de vier boeken zijn bit-gelijk met en zonder Segment (twee beursdagen, elke minuut)', async () => {
  const A = maakBeide(false), Bm = maakBeide(true);
  A.spoor = []; Bm.spoor = [];
  for (const X of [A, Bm]) { X.N.zet(Date.UTC(2026, 10, 30, 5, 0)); await X.m.tik(); }   // opzet maandag 30-11 06:00
  await speelDag(A, 2026, 10, 30, 7 * 60, 22 * 60 + 30); const uitB = await speelDag(Bm, 2026, 10, 30, 7 * 60, 22 * 60 + 30);
  await speelDag(A, 2026, 11, 1, 7 * 60, 17 * 60 + 30); const uitB2 = await speelDag(Bm, 2026, 11, 1, 7 * 60, 17 * 60 + 30);
  const a = dump(A.m), b = dump(Bm.m);
  for (const k of Object.keys(a)) assert.strictEqual(b[k], a[k], 'verschil in ' + k);
  assert.ok(A.spoor.length > 1000 && A.spoor.every((x, i) => x === Bm.spoor[i]), 'meta van de Strateeg elke minuut gelijk (ook vóór elke tik)');
  // de L&S-verzoeken voor de 41 van de Strateeg: zelfde aantal en volgorde
  const eigen = new Set(S.UNIVERSUM.instrumenten.concat([S.UNIVERSUM.index]).map((i) => String(i.ls_id)));
  const van41 = (urls) => urls.filter((u) => { const id = (/instrumentId=(\d+)/.exec(u) || [])[1]; return !id || eigen.has(id); });
  assert.deepStrictEqual(van41(Bm.N.urls), van41(A.N.urls));
  // Segment deed wel iets: dagronde, start op 30-11 om 16:20, herziening 1-12, waarderingen
  const o = Bm.g.overzicht();
  assert.strictEqual(o.startdag, '2026-11-30'); assert.strictEqual(o.boek.posities.length, 3);
  assert.ok(uitB.some(([m, s]) => s === 'dagronde' && m >= 7 * 60 + 30));
  assert.ok(uitB.some(([m, s]) => s === 'herziening' && m === 16 * 60 + 20));
  assert.ok(uitB2.some(([m, s]) => s === 'herziening' && m === 16 * 60 + 20), 'herziening op de eerste beursdag van december');
  assert.ok(uitB.concat(uitB2).every(([m]) => { const na = (((m - 1) % 15) + 15) % 15; return na >= 4 && na <= 12; }), 'nooit in een kwartierminuut');
  assert.ok(o.orders.length >= 3 && o.orders.every((x) => x.reden_zin && x.reden_zin.length > 20));
  assert.ok(o.boek.contant >= 0 && o.boek.contant < 40);
  assert.ok(o.rangorde.lijst.length === 10 && o.rangorde.lijst.filter((x) => x.in_boek).length === 3);
  assert.ok(o.maatstaf == null || typeof o.maatstaf.alle_tien === 'number');
  // log zonder namen of ISIN's; segment-bestemmingen alleen L&S
  const tekst = JSON.stringify(Bm.logs); assert.ok(!/[A-Z]{2}[A-Z0-9]{9}\d/.test(tekst)); assert.ok(!G.SEG.etf.some((e) => tekst.includes(e.naam)));
  assert.ok(Bm.N.urls.every((u) => /^https:\/\/(www\.ls-tc\.de|wikimedia\.org|data\.sec\.gov|api\.nasdaq\.com)\//.test(u)));
  // een tweede tik in dezelfde minuut doet niets dubbel
  Bm.N.zet(Date.UTC(2026, 11, 1, 15, 20)); assert.strictEqual((await Bm.g.tik({ gedaan: 'niets' })).gedaan, 'niets');
});

test('klok: niets vóór de startdag, niet als de Strateeg iets deed, niet op Thanksgiving, niets na de einddag, pauze geldt ook hier', async () => {
  const X = maakBeide(true);
  X.N.zet(Date.UTC(2026, 10, 23, 15, 20)); assert.strictEqual((await X.g.tik({ gedaan: 'niets' })).gedaan, 'niets', 'vóór 24-11');
  X.N.zet(Date.UTC(2026, 10, 24, 6, 35)); assert.strictEqual((await X.g.tik({ gedaan: 'kwartier' })).gedaan, 'wacht_strateeg');
  X.N.zet(Date.UTC(2026, 10, 24, 6, 31)); assert.strictEqual((await X.g.tik({ gedaan: 'niets' })).gedaan, 'niets', 'kwartierminuut 07:31');
  X.N.zet(Date.UTC(2026, 10, 26, 7, 35)); assert.strictEqual((await X.g.tik({ gedaan: 'niets' })).gedaan, 'dagronde');
  X.N.zet(Date.UTC(2026, 10, 26, 15, 20)); assert.strictEqual((await X.g.tik({ gedaan: 'niets' })).gedaan, 'niets', 'Thanksgiving: New York dicht');
  assert.strictEqual(X.g.overzicht().boek.posities.length, 0);
  X.m._M.zet('stand', 'pauze'); X.N.zet(Date.UTC(2026, 10, 27, 15, 20)); assert.strictEqual((await X.g.tik({ gedaan: 'niets' })).gedaan, 'niets', 'pauze');
  X.m._M.zet('stand', 'aan');
  X.N.zet(Date.UTC(2026, 11, 28, 7, 35)); assert.strictEqual((await X.g.tik({ gedaan: 'niets' })).gedaan, 'niets', 'na 23-12');
  assert.strictEqual(X.g.overzicht().stand, 'klaar');
  assert.throws(() => G.maak({ db: X.m._db, haal: X.N.haal, universumIsins: [G.SEG.etf[0].isin] }), /universum/);
});

test('regelbestand: tien sectoren, eigen ISIN en tweeling, geen overlap met de vier, bevroren regels van de vier ongewijzigd', () => {
  assert.strictEqual(G.SEG.etf.length, 10);
  const alle = G.SEG.etf.flatMap((e) => [e.isin, e.tweeling_isin]); assert.strictEqual(new Set(alle).size, 20);
  const vier = new Set(S.UNIVERSUM.instrumenten.map((i) => i.isin).concat([S.UNIVERSUM.index.isin])); assert.ok(!alle.some((i) => vier.has(i)));
  assert.strictEqual(S.REGELS_SHA, '6abb3ae3005690b4');
  assert.ok(G.SEG.einddag === '2026-12-23' && G.SEG.regels.k === 3 && G.SEG.tarief.vast === 1);
  for (const t of G.SEG.tijd.herzien.concat(G.SEG.tijd.waardeer)) { const m = Number(t.slice(0, 2)) * 60 + Number(t.slice(3)); const na = (((m - 1) % 15) + 15) % 15; assert.ok(na >= 4 && na <= 12, t); }
});
