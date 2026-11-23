'use strict';
// wv4002 — OVIS Beleggen › Strateeg › vijfde boek "Segment" (David, app 23-11-2026 14:52: "Probeer dan op basis van marktsegment keuzes te
// maken"). € 1.000 FICTIEF geld in drie van tien Amerikaanse sector-ETF's (SPDR Select Sector UCITS, EUR, L&S-koersen), gekozen op het
// koersverloop van het afgelopen jaar zonder de laatste maand, herzien op de eerste beursdag van de maand om 16:20. Nooit een echte order,
// geen broker. Ontwerp mk-scripts/wv4002/ontwerp-fable.md (Fable 5.2); backtest mk-scripts/wv4002/bt (uitkomst in seg_backtest).
//
// Raakt de vier boeken van de Strateeg niet: eigen regelbestand (strateeg-segment.json, eigen sha), eigen tabellen seg_* voor tik, bron,
// rangorde en backtest; gedeeld zijn alleen boek/positie/opdracht/waarde (boek-id 'segment') en dagkoers/laatst (alleen de 20 ETF-ISIN's,
// die niet in het universum van de vier mogen staan). Leest uit de Strateeg alleen meta 'stand' (pauze geldt ook hier); schrijft daar niets.
// Draait alleen in een minuut waarin de Strateeg niets deed en die 4 t/m 12 minuten na een kwartier ligt, en hooguit 40 s per beurt.
//
//   maak({ db() → DatabaseSync, haal(url, soort) → Promise<tekst>, nu() → ms, log(o), boxRij(t), universumIsins: [..] })
//   → { tik(strateegUitkomst), overzicht(), info() }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('./strateeg-reken.js');
const B = require('./strateeg-bron.js');
const SR = require('./strateeg-segment-reken.js');

const SEG = JSON.parse(fs.readFileSync(path.join(__dirname, 'strateeg-segment.json'), 'utf8'));
const SEG_SHA = crypto.createHash('sha256').update(JSON.stringify(SEG)).digest('hex').slice(0, 16);
const REGELS = JSON.parse(fs.readFileSync(path.join(__dirname, 'strateeg-regels.json'), 'utf8'));   // alleen lezen: beurstijden
const BOEK = 'segment';
const PAUZE_MS = 1200;

function schema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS meta (sleutel TEXT PRIMARY KEY, waarde TEXT);
    CREATE TABLE IF NOT EXISTS dagkoers (isin TEXT, dag TEXT, slot REAL, PRIMARY KEY (isin, dag));
    CREATE TABLE IF NOT EXISTS laatst (isin TEXT PRIMARY KEY, ms INTEGER, k REAL, vorige REAL);
    CREATE TABLE IF NOT EXISTS boek (id TEXT PRIMARY KEY, start REAL, contant REAL, opgezet INTEGER);
    CREATE TABLE IF NOT EXISTS positie (boek TEXT, isin TEXT, aantal REAL, aankoop REAL, sinds TEXT, PRIMARY KEY (boek, isin));
    CREATE TABLE IF NOT EXISTS opdracht (id INTEGER PRIMARY KEY, boek TEXT, tijd INTEGER, dag TEXT, isin TEXT, kant TEXT, aantal REAL, midden REAL, prijs REAL,
      kosten REAL, kosten_uit TEXT, reden_code TEXT, reden_zin TEXT, scores TEXT);
    CREATE TABLE IF NOT EXISTS waarde (boek TEXT, tijd INTEGER, dag TEXT, waarde REAL, contant REAL, PRIMARY KEY (boek, tijd));
    CREATE TABLE IF NOT EXISTS seg_tik (tijd INTEGER PRIMARY KEY, dag TEXT, soort TEXT, status TEXT, reden TEXT, duur_ms INTEGER);
    CREATE TABLE IF NOT EXISTS seg_bron (bron TEXT, dag TEXT, verzoeken INTEGER, ok INTEGER, fout INTEGER, laatst_ok INTEGER, PRIMARY KEY (bron, dag));
    CREATE TABLE IF NOT EXISTS seg_rang (dag TEXT, id TEXT, signaal REAL, rang INTEGER, verdacht INTEGER, signaal_dag TEXT, PRIMARY KEY (dag, id));
    CREATE TABLE IF NOT EXISTS seg_backtest (id INTEGER PRIMARY KEY, gemaakt INTEGER, sha TEXT, uitkomst TEXT);
  `);
}

function maak(o) {
  const nu = o.nu || Date.now;
  const log = o.log || function () {};
  const ETF = SEG.etf, PER_ID = {}, PER_ISIN = {};
  for (const e of ETF) { PER_ID[e.id] = e; PER_ISIN[e.isin] = e; PER_ISIN[e.tweeling_isin] = e; }
  const eigen = ETF.flatMap((e) => [e.isin, e.tweeling_isin]);
  // Harde eis (ontwerp 6.2): geen overlap met het universum van de vier boeken
  if ((o.universumIsins || []).some((i) => eigen.includes(i))) throw new Error('segment-ISIN zit in het universum van de Strateeg');
  let klaarSchema = false;
  function db() { const d = o.db(); if (!klaarSchema) { schema(d); klaarSchema = true; } return d; }
  const M = {
    get(k) { const r = db().prepare('SELECT waarde FROM meta WHERE sleutel = ?').get(k); return r ? r.waarde : null; },
    zet(k, v) { if (!/^seg_/.test(k)) throw new Error('alleen seg_-sleutels'); db().prepare('INSERT INTO meta (sleutel, waarde) VALUES (?, ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde').run(k, v == null ? null : String(v)); },
  };
  const nlNu = (ms) => R.deelIn(ms == null ? nu() : ms, 'Europe/Amsterdam');
  const hm = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const wacht = (ms) => binnenTijd(new Promise((r) => setTimeout(r, o.pauzeMs != null ? o.pauzeMs : ms)));
  function tel(bron, dag, ok) {
    db().prepare(`INSERT INTO seg_bron (bron, dag, verzoeken, ok, fout, laatst_ok) VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(bron, dag) DO UPDATE SET verzoeken = verzoeken + 1, ok = ok + excluded.ok, fout = fout + excluded.fout, laatst_ok = COALESCE(excluded.laatst_ok, laatst_ok)`)
      .run(bron, dag, ok ? 1 : 0, ok ? 0 : 1, ok ? nu() : null);
  }
  // Codex-MOET 3 (ronde 2): één harde deadline per beurt (echte klok), ook voor een lopend verzoek: daarna wacht Segment niet langer
  // (het verzoek mag op de achtergrond aflopen), zodat een trage bron de volgende tik van de Strateeg nooit ophoudt.
  let deadline = Infinity;
  function binnenTijd(p) {
    const rest = deadline - Date.now();
    if (rest <= 0) return Promise.reject(Object.assign(new Error('tijd'), { tijd: true }));
    let tm; const t = new Promise((_, nee) => { tm = setTimeout(() => nee(Object.assign(new Error('tijd'), { tijd: true })), rest); });
    return Promise.race([p, t]).finally(() => clearTimeout(tm));
  }
  async function haal(bron, url) {
    const dag = nlNu().dag;
    try { const t = await binnenTijd(Promise.resolve().then(() => o.haal(url, 'ls'))); tel(bron, dag, true); return t; }
    catch (e) { if (e && e.tijd) throw e; tel(bron, dag, false); if (e && /\b(403|429)\b/.test(String(e.message || e))) { M.zet('seg_dicht', dag); const f = new Error('bron_dicht'); f.dicht = true; throw f; } return null; }
  }
  function schrijfTik(ms, dag, soort, status, reden, duur) { db().prepare('INSERT OR REPLACE INTO seg_tik (tijd, dag, soort, status, reden, duur_ms) VALUES (?, ?, ?, ?, ?, ?)').run(ms, dag, soort, status, reden || '', duur || 0); }

  // ── stand ──
  function proefStand(dag) {
    if (o.strateegStand && o.strateegStand() === 'pauze') return 'pauze';
    if (dag > SEG.einddag) return 'klaar';
    if (!M.get('seg_startdag')) return 'wacht';
    return 'aan';
  }
  function beideOpen(ms) { return SEG.tijd.beurzen.every((b) => R.beursOpen(REGELS.beurzen, b, ms)); }

  // ── dagronde: 20 dagreeksen → dagkoers, schonen, rangorde (in stukken van hooguit 40 s) ──
  async function dagronde(vandaag, t0) {
    let i = Number(M.get('seg_dr_dag') === vandaag ? M.get('seg_dr_i') || 0 : 0);
    if (M.get('seg_dr_dag') !== vandaag) { M.zet('seg_dr_dag', vandaag); M.zet('seg_dr_i', 0); M.zet('seg_dr_ok', 0); }
    const lijst = ETF.flatMap((e) => [[e.isin, e.ls_id], [e.tweeling_isin, e.tweeling_ls]]);
    let ok = Number(M.get('seg_dr_ok') || 0);
    for (; i < lijst.length; i++) {
      if (nu() - t0 > SEG.tijd.max_beurt_ms) { M.zet('seg_dr_i', i); M.zet('seg_dr_ok', ok); return 'deels'; }
      const [isin, id] = lijst[i];
      const t = await haal('ls_dag', B.lsReeksUrl(id, 'history'));
      const rij = t ? B.lsDagreeks(t, vandaag) : null;
      if (rij && rij.length) {
        const st = db().prepare('INSERT INTO dagkoers (isin, dag, slot) VALUES (?, ?, ?) ON CONFLICT(isin, dag) DO UPDATE SET slot = excluded.slot');
        db().exec('BEGIN'); try { for (const p of rij) st.run(isin, p.d, p.k); db().exec('COMMIT'); } catch (e) { db().exec('ROLLBACK'); throw e; }
        ok++;
      }
      M.zet('seg_dr_i', i + 1); M.zet('seg_dr_ok', ok);   // voortgang per reeks: een afgebroken beurt gaat verder waar hij was
      await wacht(PAUZE_MS);
    }
    M.zet('seg_dr_i', i); M.zet('seg_dr_ok', ok);
    const n = rangVastleggen(vandaag);
    if (n < 5) return 'fout';
    M.zet('seg_dagronde', vandaag);
    log({ stap: 'segment-dagronde', reeksen: ok, sectoren: n });
    return 'klaar';
  }
  // reeksen op één kalender uit dagkoers (alleen dagen vóór vandaag), geschoond
  function reeksen(vandaag) {
    const ruw = {}; for (const isin of eigen) ruw[isin] = new Map(db().prepare('SELECT dag, slot FROM dagkoers WHERE isin = ? AND dag < ? ORDER BY dag').all(isin, vandaag).map((r) => [r.dag, r.slot]));
    const telD = new Map(); for (const e of ETF) for (const d of ruw[e.isin].keys()) telD.set(d, (telD.get(d) || 0) + 1);
    const dagen = [...telD.entries()].filter(([d, n]) => n >= 7 && d >= '2016-01-26').map(([d]) => d).sort();
    const spdr = {}, ish = {};
    for (const e of ETF) { spdr[e.id] = dagen.map((d) => ruw[e.isin].get(d) || null); ish[e.id] = dagen.map((d) => ruw[e.tweeling_isin].get(d) || null); }
    return { dagen, S: SR.schoon({ spdr, ish }, SEG.schoon), spdr };
  }
  function metaIds() { const m = {}; for (const e of ETF) m[e.id] = { isin: e.isin, naam: e.naam }; return m; }
  function rangVastleggen(vandaag) {
    const D = reeksen(vandaag); const t = D.dagen.length - 1; if (t < 0) return 0;
    const sig = SR.signalen(D.S, t, SEG.regels, {});
    const geh = boekLees().posities.map((p) => p.id);
    const { rang } = SR.rangorde(sig, geh, metaIds());
    const st = db().prepare('INSERT OR REPLACE INTO seg_rang (dag, id, signaal, rang, verdacht, signaal_dag) VALUES (?, ?, ?, ?, ?, ?)');
    db().prepare('DELETE FROM seg_rang WHERE dag = ?').run(vandaag);
    for (const e of ETF) st.run(vandaag, e.id, sig[e.id] ? sig[e.id].x : null, rang[e.id] || null, D.S[e.id].verdacht[t] ? 1 : 0, D.dagen[t]);
    return Object.keys(sig).length;
  }
  function rangVan(dag) {
    const r = db().prepare('SELECT * FROM seg_rang WHERE dag = ? ORDER BY rang IS NULL, rang').all(dag);
    const sig = {}; for (const x of r) if (x.signaal != null) sig[x.id] = { x: x.signaal, trendOk: true };
    return { rijen: r, sig };
  }

  // ── boek ──
  function boekZeker() { db().prepare('INSERT OR IGNORE INTO boek (id, start, contant, opgezet) VALUES (?, ?, ?, 0)').run(BOEK, SEG.start, SEG.start); }
  function boekLees() {
    boekZeker();
    const b = db().prepare('SELECT * FROM boek WHERE id = ?').get(BOEK);
    return { contant: b.contant, opgezet: b.opgezet, posities: db().prepare('SELECT isin, aantal, aankoop, sinds FROM positie WHERE boek = ?').all(BOEK).map((p) => ({ id: (PER_ISIN[p.isin] || {}).id, isin: p.isin, aantal: p.aantal, aankoop: p.aankoop, sinds: p.sinds })) };
  }
  function boekSchrijf(b) {
    db().prepare('UPDATE boek SET contant = ?, opgezet = ? WHERE id = ?').run(b.contant, b.opgezet || 0, BOEK);
    db().prepare('DELETE FROM positie WHERE boek = ?').run(BOEK);
    const st = db().prepare('INSERT INTO positie (boek, isin, aantal, aankoop, sinds) VALUES (?, ?, ?, ?, ?)');
    for (const p of b.posities) st.run(BOEK, PER_ID[p.id].isin, p.aantal, p.aankoop, String(p.sinds || nlNu().dag));
  }
  function laatsteKoers(isin) {
    const l = db().prepare('SELECT k FROM laatst WHERE isin = ?').get(isin); if (l) return l.k;
    const d = db().prepare('SELECT slot FROM dagkoers WHERE isin = ? ORDER BY dag DESC LIMIT 1').get(isin); return d ? d.slot : null;
  }
  function boekWaarde(b) { let w = b.contant; for (const p of b.posities) w += p.aantal * (laatsteKoers(PER_ID[p.id].isin) || p.aankoop); return w; }
  function waardeVastleggen(ms, dag) { const b = boekLees(); db().prepare('INSERT OR REPLACE INTO waarde (boek, tijd, dag, waarde, contant) VALUES (?, ?, ?, ?, ?)').run(BOEK, ms, dag, boekWaarde(b), b.contant); }

  // ── minuutkoersen: vers, en een sprong > 8 % tegen het laatste slot alleen als de tweeling hem bevestigt ──
  async function goedeKoers(id, ms) {
    const e = PER_ID[id];
    const t = await haal('ls_minuut', B.lsReeksUrl(e.ls_id, 'intraday')); await wacht(PAUZE_MS);
    const x = t ? B.lsIntraday(t) : null;
    if (!x || x.isin !== e.isin) return { ok: false, reden: 'geen' };
    const punten = x.punten.map((p) => [R.lsEchteMs(p[0]), p[1]]);
    const v = R.vers(punten, ms, { max_oud_ms: SEG.vers.max_oud_min * 60000, min_koersen: SEG.vers.min_koersen });
    if (!v.vers) return { ok: false, reden: v.reden };
    const slot = (db().prepare('SELECT slot FROM dagkoers WHERE isin = ? ORDER BY dag DESC LIMIT 1').get(e.isin) || {}).slot;
    if (slot > 0 && Math.abs(v.k / slot - 1) > SEG.vers.sprong) {
      const t2 = await haal('ls_minuut', B.lsReeksUrl(e.tweeling_ls, 'intraday')); await wacht(PAUZE_MS);
      const y = t2 ? B.lsIntraday(t2) : null;
      const s2 = (db().prepare('SELECT slot FROM dagkoers WHERE isin = ? ORDER BY dag DESC LIMIT 1').get(e.tweeling_isin) || {}).slot;
      const k2 = y && y.isin === e.tweeling_isin && y.punten.length ? y.punten[y.punten.length - 1][1] : null;
      if (!(k2 > 0 && s2 > 0) || Math.abs(Math.log(v.k / slot) - Math.log(k2 / s2)) > SEG.vers.sprong) return { ok: false, reden: 'sprong' };
    }
    // Codex-MOET 2: alleen een goedgekeurde koers telt voor de waardering
    db().prepare('INSERT INTO laatst (isin, ms, k, vorige) VALUES (?, ?, ?, ?) ON CONFLICT(isin) DO UPDATE SET ms = excluded.ms, k = excluded.k, vorige = excluded.vorige').run(e.isin, punten[punten.length - 1][0], v.k, x.vorige);
    return { ok: true, k: v.k };
  }

  // ── herziening ──
  const pct = (x, n) => (Math.round(x * 100 * Math.pow(10, n == null ? 0 : n)) / Math.pow(10, n == null ? 0 : n)).toLocaleString('nl-NL');
  const naam = (id) => (PER_ID[id] || {}).naam || id;
  function redenZin(od, rang, sig, mid, n) {
    const r = rang[od.id], s = sig[od.id];
    switch (od.reden) {
      case 'start': return 'Gekocht bij de start: ' + naam(od.id) + ' staat ' + r + 'e van ' + n + ' sectoren over het afgelopen jaar zonder de laatste maand (' + (s ? (s.x > 0 ? '+' : '') + pct(s.x) : '?') + ' %; middelste sector ' + (mid > 0 ? '+' : '') + pct(mid) + ' %).';
      case 'uit': return 'Verkocht: ' + naam(od.id) + ' is gezakt naar plek ' + (r || '?') + ' van ' + n + ' (grens om te blijven: plek ' + SEG.regels.buffer + ').';
      case 'in': return 'Gekocht in de plaats van ' + (od.van ? naam(od.van) : 'een verkochte sector') + ': ' + naam(od.id) + ' is de hoogste sector die nog niet in het boek zat (plek ' + r + ', ' + (s ? (s.x > 0 ? '+' : '') + pct(s.x) : '?') + ' %).';
      case 'aanvul': return 'Gekocht om een lege plek te vullen: ' + naam(od.id) + ' (plek ' + r + ').';
      case 'te_groot': return 'Deels verkocht: ' + naam(od.id) + ' was gegroeid tot boven ' + pct(SEG.regels.max_aandeel) + ' % van het boek.';
      default: return '';
    }
  }
  async function herziening(ms, nl) {
    const dag = nl.dag, maand = dag.slice(0, 7), t0 = nu();
    const { rijen, sig } = rangVan(dag);
    if (Object.keys(sig).length < 5) { schrijfTik(ms, dag, 'herziening', 'uitgesteld', 'geen_rangorde', nu() - t0); return; }
    const b = boekLees();
    const geh = b.posities.map((p) => p.id);
    const d = SR.doel(sig, geh, SEG.regels, metaIds());
    const n = Object.keys(sig).length, mid = SR.mediaan(Object.values(sig).map((x) => x.x));
    // koersen: alle sectoren die in het plan voorkomen (gehouden + doel)
    const ids = [...new Set(geh.concat(d.houd))];
    const prijzen = {}, slecht = [];
    for (const id of ids) {
      if (nu() - t0 > SEG.tijd.max_beurt_ms) { slecht.push(id); continue; }
      const g = await goedeKoers(id, nu()); if (g.ok) prijzen[id] = g.k; else slecht.push(id);
    }
    const start = b.posities.length === 0;
    // Codex-MOET 1: zonder goede koers voor élke gehouden positie geen plan (een positie zonder koers telt anders als nul → onterecht 'te groot')
    const plan = start || geh.every((id) => prijzen[id] > 0) ? SR.plan({ contant: b.contant, posities: b.posities.map((p) => ({ id: p.id, aantal: p.aantal, aankoop: p.aankoop })) }, d.houd, Object.assign({}, prijzen), SEG.regels) : [];
    if (!start && !plan.length && slecht.length) slecht.push(...geh.filter((id) => !(prijzen[id] > 0) && !slecht.includes(id)));
    // een wissel gaat alleen door als elk been een goede koers heeft; bij de start per positie (wat geen koers heeft volgt later)
    const uitvoerbaar = start ? plan.filter((x) => prijzen[x.id] > 0) : (plan.every((x) => prijzen[x.id] > 0) ? plan : []);
    const bk = { contant: b.contant, posities: b.posities.map((p) => ({ id: p.id, aantal: p.aantal, aankoop: p.aankoop, sinds: p.sinds })) };
    let orders = 0; const verkocht = [];
    db().exec('BEGIN');
    try {
      for (const od of uitvoerbaar.filter((x) => x.kant === 'verkoop').concat(uitvoerbaar.filter((x) => x.kant === 'koop'))) {
        if (od.kant === 'koop' && od.reden === 'in') od.van = verkocht.shift();
        const g = SR.voerUit(bk, od, prijzen[od.id], SEG.tarief);
        if (!g) continue;
        if (od.kant === 'verkoop' && od.reden === 'uit') verkocht.push(od.id);
        const p = bk.posities.find((x) => x.id === od.id); if (p && !p.sinds) p.sinds = dag;
        const kostenUit = { vast: SEG.tarief.vast, spread: g.aantal * g.midden * SEG.tarief.halve_spread, bij_4_90: SEG.tarief.vast_alt + g.aantal * g.midden * SEG.tarief.halve_spread };
        db().prepare(`INSERT INTO opdracht (boek, tijd, dag, isin, kant, aantal, midden, prijs, kosten, kosten_uit, reden_code, reden_zin, scores) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(BOEK, nu(), dag, PER_ID[od.id].isin, g.kant, g.aantal, g.midden, g.prijs, g.kosten, JSON.stringify(kostenUit), 'seg_' + od.reden, redenZin(od, d.rang, sig, mid, n),
            JSON.stringify({ rang: d.rang[od.id] || null, signaal: sig[od.id] ? sig[od.id].x : null }));
        orders++;
      }
      if (bk.posities.length >= SEG.regels.k) bk.opgezet = 1; else bk.opgezet = b.opgezet;
      boekSchrijf(bk);
      waardeVastleggen(nu(), dag);
      // af = alle gehouden posities hadden een goede koers, elk geplande order ging door en het boek houdt precies het doel
      const geblokkeerd = !start && !geh.every((id) => prijzen[id] > 0);
      const af = !geblokkeerd && uitvoerbaar.length === plan.length && orders === uitvoerbaar.length && d.houd.every((id) => bk.posities.some((p) => p.id === id)) && !bk.posities.some((p) => !d.houd.includes(p.id));
      if (af) {
        M.zet('seg_herz_maand', maand);
        if (!M.get('seg_startdag') && bk.posities.length) M.zet('seg_startdag', dag);
        const zin = orders ? null : 'Herzien op ' + Number(dag.slice(8, 10)) + '-' + Number(dag.slice(5, 7)) + ': ' + (d.houd.map((id) => naam(id) + ' (plek ' + d.rang[id] + ')').join(', ')) + ' staan nog bij de beste ' + SEG.regels.buffer + '; niets gedaan, geen kosten.';
        M.zet('seg_herz_zin', zin || 'Herzien op ' + Number(dag.slice(8, 10)) + '-' + Number(dag.slice(5, 7)) + ': ' + orders + ' order' + (orders === 1 ? '' : 's') + '.');
        M.zet('seg_herz_laatste', dag);
      } else {
        if (!M.get('seg_startdag') && bk.posities.length) M.zet('seg_startdag', dag);
        M.zet('seg_herz_zin', 'Herziening ' + (orders ? 'deels gedaan' : 'uitgesteld') + ': geen verse koers voor ' + slecht.filter((x) => d.houd.includes(x) || geh.includes(x)).map(naam).join(', ') + '; volgende poging ' + volgendePoging(nl) + '.');
      }
      db().exec('COMMIT');
    } catch (e) { db().exec('ROLLBACK'); throw e; }
    schrijfTik(ms, dag, 'herziening', orders ? 'order' : 'niets', slecht.length ? 'koers_oud' : (orders ? 'gewisseld' : 'geen_wissel'), nu() - t0);
    log({ stap: 'segment-herziening', orders, slecht: slecht.length, ms: nu() - t0 });
  }
  function volgendePoging(nl) { const m = SEG.tijd.herzien.map(hm).find((x) => x > nl.min); return m != null ? 'vandaag ' + String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') : 'de volgende beursdag om ' + SEG.tijd.herzien[0]; }

  async function waardeer(ms, nl) {
    const t0 = nu(); const b = boekLees(); let n = 0;
    for (const p of b.posities) { if (nu() - t0 > SEG.tijd.max_beurt_ms) break; const g = await goedeKoers(p.id, nu()); if (g.ok) n++; }
    waardeVastleggen(nu(), nl.dag);
    schrijfTik(ms, nl.dag, 'waardering', 'ok', n + '/' + b.posities.length, nu() - t0);
  }

  // ── klok ──
  function slotVan(lijst, nl, marge) { for (let m = nl.min; m >= nl.min - marge; m--) if (lijst.map(hm).includes(m)) return m; return null; }
  async function tik(strateegUit) {
    const ms = nu(), nl = nlNu(ms), dag = nl.dag;
    // alleen als de Strateeg in deze minuut niets deed en de minuut 4–12 na een kwartier (1/16/31/46) ligt (ontwerp 6.3)
    if (strateegUit && strateegUit.gedaan !== 'niets') return { gedaan: 'wacht_strateeg' };
    const na = (((nl.min - 1) % 15) + 15) % 15;
    if (na < SEG.tijd.kwartier_marge[0] || na > SEG.tijd.kwartier_marge[1]) return { gedaan: 'niets' };
    const wd = new Date(dag + 'T12:00:00Z').getUTCDay(); if (wd === 0 || wd === 6) return { gedaan: 'niets' };
    const stand = proefStand(dag);
    if (stand === 'klaar' || stand === 'pauze') return { gedaan: 'niets' };
    if (dag < SEG.startdag_vanaf) return { gedaan: 'niets' };
    if (M.get('seg_dicht') === dag) return { gedaan: 'niets' };
    deadline = Date.now() + (o.maxBeurtMs || SEG.tijd.max_beurt_ms + 5000);
    try {
      // dagronde vanaf 07:30 (bij een fout elke 20 minuten opnieuw, tot 22:00)
      if (M.get('seg_dagronde') !== dag && nl.min >= hm(SEG.tijd.dagronde_van) && nl.min < 22 * 60) {
        const p = Number(M.get('seg_dr_poging') || 0);
        if (M.get('seg_dr_dag') === dag && Number(M.get('seg_dr_i') || 0) > 0 && Number(M.get('seg_dr_i')) < 20) { /* doorgaan met het volgende stuk */ }
        else if (ms - p < 20 * 60000) return { gedaan: 'niets' };
        else M.zet('seg_dr_poging', ms);
        const u = await dagronde(dag, ms);
        schrijfTik(ms, dag, 'dagronde', u, '', nu() - ms);
        if (u === 'fout') { M.zet('seg_dr_i', 0); M.zet('seg_dr_dag', null); }
        return { gedaan: 'dagronde' };
      }
      if (M.get('seg_dagronde') !== dag) return { gedaan: 'niets' };
      // herziening: eerste beursdag van de maand waarop Xetra én New York open zijn (en bij de start), 16:20 … 17:20
      const hz = slotVan(SEG.tijd.herzien, nl, 8);
      if (hz != null && M.get('seg_herz_maand') !== dag.slice(0, 7) && M.get('seg_herz_slot') !== dag + ' ' + hz) {
        M.zet('seg_herz_slot', dag + ' ' + hz);
        if (!beideOpen(ms)) { schrijfTik(ms, dag, 'herziening', 'niets', 'beurs_dicht', 0); return { gedaan: 'niets' }; }
        // te lang uitgesteld: na de start vervalt de herziening van deze maand als hij op 3 beursdagen niet lukte (ontwerp 5)
        if (M.get('seg_herz_poging_dag') !== dag) { M.zet('seg_herz_poging_dag', dag); M.zet('seg_herz_dagen', Number(M.get('seg_herz_dagen') || 0) + 1); }
        if (M.get('seg_startdag') && Number(M.get('seg_herz_dagen')) > SEG.tijd.max_uitstel_dagen) {
          M.zet('seg_herz_maand', dag.slice(0, 7)); M.zet('seg_herz_dagen', 0);
          M.zet('seg_herz_zin', 'Herziening van ' + Number(dag.slice(5, 7)) + '-' + dag.slice(0, 4) + ' overgeslagen: drie beursdagen geen betrouwbare koers.');
          schrijfTik(ms, dag, 'herziening', 'niets', 'overgeslagen', 0); return { gedaan: 'niets' };
        }
        await herziening(ms, nl);
        if (M.get('seg_herz_maand') === dag.slice(0, 7)) M.zet('seg_herz_dagen', 0);
        return { gedaan: 'herziening' };
      }
      // waarderen 09:20, 12:20, 16:20, 22:10
      const wz = slotVan(SEG.tijd.waardeer, nl, 8);
      if (wz != null && M.get('seg_startdag') && M.get('seg_waardeer') !== dag + ' ' + wz) { M.zet('seg_waardeer', dag + ' ' + wz); await waardeer(ms, nl); return { gedaan: 'waardering' }; }
      return { gedaan: 'niets' };
    } catch (e) {
      if (e && e.dicht) { schrijfTik(ms, dag, 'bron', 'bron_dicht', 'bron_dicht', nu() - ms); return { gedaan: 'bron_dicht' }; }
      if (e && e.tijd) { try { db().exec('ROLLBACK'); } catch (x) { /* geen open transactie */ } schrijfTik(ms, dag, 'beurt', 'tijd', 'tijd', nu() - ms); return { gedaan: 'tijd' }; }
      throw e;
    } finally { deadline = Infinity; }
  }

  // ── scherm ──
  function backtestKort() {
    const r = db().prepare('SELECT * FROM seg_backtest ORDER BY id DESC LIMIT 1').get(); if (!r) return null;
    let u; try { u = JSON.parse(r.uitkomst); } catch (e) { return null; }
    const tekst = (x, n) => (typeof x === 'string' ? x.slice(0, n) : null);
    const getal = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
    const OORDEEL = ['helpt', 'twijfel', 'helpt niet'];
    return { gemaakt: r.gemaakt, sha: tekst(r.sha, 20), oordeel: OORDEEL.includes(u.oordeel) ? u.oordeel : 'helpt niet', zinnen: (Array.isArray(u.zinnen) ? u.zinnen : []).slice(0, 5).map((x) => tekst(x, 400)).filter(Boolean),
      tabel: (Array.isArray(u.tabel) ? u.tabel : []).slice(0, 10).map((x) => ({ variant: tekst(x.variant, 4), naam: tekst(x.naam, 80), per_jaar: getal(x.per_jaar), daling: getal(x.daling), meer_per_jaar: getal(x.meer_per_jaar), t: getal(x.t), holm: !!x.holm, boek: !!x.boek })),
      nul: u.nul ? { per_jaar: getal(u.nul.per_jaar), daling: getal(u.nul.daling) } : null, wereld: u.wereld ? { per_jaar: getal(u.wereld.per_jaar), daling: getal(u.wereld.daling) } : null, periode: tekst(u.periode, 40) };
  }
  // boek, alle tien gelijk en de wereld-ETF op dezelfde dagsloten vanaf het slot van de startdag
  function maatstaf(startdag) {
    if (!startdag) return null;
    const isins = ETF.map((e) => e.isin), wereld = o.wereldIsin;
    const dagen = db().prepare(`SELECT dag FROM dagkoers WHERE isin = ? AND dag >= ? ORDER BY dag`).all(ETF[0].isin, startdag).map((r) => r.dag);
    if (!dagen.length) return null;
    const slot = (isin, dag) => (db().prepare('SELECT slot FROM dagkoers WHERE isin = ? AND dag = ?').get(isin, dag) || {}).slot;
    const ord = db().prepare('SELECT dag, isin, kant, aantal, prijs, kosten FROM opdracht WHERE boek = ? ORDER BY id').all(BOEK);
    let laatste = null;
    for (const dg of dagen) {
      let contant = SEG.start; const pos = {};
      // prijs bevat de halve spread al; de vaste kosten gaan er per order af (zelfde rekensom als SR.voerUit)
      for (const x of ord) { if (x.dag > dg) break; if (x.kant === 'koop') { contant -= x.aantal * x.prijs + SEG.tarief.vast; pos[x.isin] = (pos[x.isin] || 0) + x.aantal; } else { contant += x.aantal * x.prijs - SEG.tarief.vast; pos[x.isin] = (pos[x.isin] || 0) - x.aantal; } }
      let w = contant, ok = true; for (const [i, n] of Object.entries(pos)) { if (n <= 1e-9) continue; const k = slot(i, dg); if (!(k > 0)) { ok = false; break; } w += n * k; }
      const tien = isins.map((i) => [slot(i, startdag), slot(i, dg)]); const wr = wereld ? [slot(wereld, startdag), slot(wereld, dg)] : [null, null];
      if (!ok || tien.some(([a, b]) => !(a > 0 && b > 0))) continue;
      laatste = { dag: dg, segment: w / SEG.start - 1, alle_tien: SR.gem(tien.map(([a, b]) => b / a - 1)), wereld: wr[0] > 0 && wr[1] > 0 ? wr[1] / wr[0] - 1 : null };
    }
    return laatste;
  }
  function overzicht() {
    const dag = nlNu().dag; const b = boekLees(); const w = boekWaarde(b);
    const startdag = M.get('seg_startdag');
    const rang = db().prepare('SELECT * FROM seg_rang WHERE dag = (SELECT MAX(dag) FROM seg_rang) ORDER BY rang IS NULL, rang').all();
    const orders = db().prepare('SELECT tijd, dag, isin, kant, aantal, prijs, kosten, kosten_uit, reden_zin FROM opdracht WHERE boek = ? ORDER BY id DESC LIMIT 20').all(BOEK)
      .map((x) => ({ tijd: x.tijd, dag: x.dag, sector: naam((PER_ISIN[x.isin] || {}).id), kant: x.kant, aantal: x.aantal, prijs: x.prijs, kosten: Math.round(x.kosten * 100) / 100, reden_zin: x.reden_zin }));
    let kost = 0, kostAlt = 0, n = 0; for (const x of db().prepare('SELECT kosten, kosten_uit FROM opdracht WHERE boek = ?').all(BOEK)) { kost += x.kosten; n++; try { kostAlt += JSON.parse(x.kosten_uit).bij_4_90 || 0; } catch (e) { /* */ } }
    const reeks = db().prepare('SELECT dag, waarde FROM waarde WHERE boek = ? AND tijd IN (SELECT MAX(tijd) FROM waarde WHERE boek = ? GROUP BY dag) ORDER BY dag').all(BOEK, BOEK).map((x) => [x.dag, Math.round(x.waarde * 100) / 100]);
    const bron = db().prepare('SELECT SUM(CASE WHEN dag = ? THEN verzoeken ELSE 0 END) AS vandaag, SUM(CASE WHEN dag = ? THEN fout ELSE 0 END) AS fout_vandaag, MAX(laatst_ok) AS laatst_ok FROM seg_bron').get(dag, dag) || {};
    const lt = db().prepare('SELECT tijd, soort, status, reden FROM seg_tik ORDER BY tijd DESC LIMIT 1').get() || null;
    return {
      fictief: true, stand: proefStand(dag), startdag, startdag_vanaf: SEG.startdag_vanaf, einddag: SEG.einddag, variant: SEG.variant, variant_uitleg: SEG.variant_uitleg, regels_sha: SEG_SHA,
      boek: { start: SEG.start, waarde: Math.round(w * 100) / 100, contant: Math.round(b.contant * 100) / 100,
        posities: b.posities.map((p) => { const k = laatsteKoers(p.isin); const r = rang.find((x) => x.id === p.id); return { isin: p.isin, sector: naam(p.id), aantal: p.aantal, aankoop: p.aankoop, koers: k, waarde: Math.round(p.aantal * (k || p.aankoop) * 100) / 100, resultaat: k ? k / p.aankoop - 1 : null, rang: r ? r.rang : null }; }) },
      maatstaf: maatstaf(startdag),
      rangorde: { dag: rang.length ? rang[0].signaal_dag : null, lijst: rang.map((x) => ({ sector: naam(x.id), signaal: x.signaal, rang: x.rang, in_boek: b.posities.some((p) => p.id === x.id), verdacht: !!x.verdacht })) },
      orders, herziening: { laatste: M.get('seg_herz_laatste'), zin: M.get('seg_herz_zin') }, kosten: { totaal: Math.round(kost * 100) / 100, orders: n, bij_4_90: Math.round(kostAlt * 100) / 100 },
      backtest: backtestKort(), reeks, bronnen: { vandaag: bron.vandaag || 0, fout_vandaag: bron.fout_vandaag || 0, laatst_ok: bron.laatst_ok || null }, laatste_tik: lt,
    };
  }
  function info() {
    try { const dag = nlNu().dag; const l = db().prepare('SELECT tijd FROM seg_tik ORDER BY tijd DESC LIMIT 1').get(); return { aan: true, stand: proefStand(dag), startdag: M.get('seg_startdag'), dagronde: M.get('seg_dagronde'), laatste_tik: l ? l.tijd : null, orders: db().prepare('SELECT COUNT(*) AS n FROM opdracht WHERE boek = ?').get(BOEK).n, sha: SEG_SHA }; }
    catch (e) { return { aan: true, fout: true }; }
  }
  return { tik, overzicht, info, _M: M };
}

module.exports = { maak, schema, SEG, SEG_SHA };
