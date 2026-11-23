'use strict';
// wv3993 — OVIS Beleggen › Strateeg: een maand droog oefenen met € 1.000 FICTIEF geld (David, app 23-11-2026 09:04). Elk kwartier een besluit
// op echte L&S-koersen, een voorspellingsengine die eerst eerlijk getoetst is, en alles zichtbaar in de tab Strateeg. Nooit een echte order,
// geen broker, geen koppeling met beleggen.sqlite (Davids echte beleggingen). Ontwerp: mk-scripts/wv3993/ontwerp.md (Fable 5.2).
//
//   maak({ dbPad, haal(url, soort) → Promise<tekst>, nu() → ms, kind(taak, invoer) → Promise<uit>, log(o), hartslag(n, b), boxRij(t) })
//   → { tik(), app({ pad, methode, body }), info() }
//
// tik() wordt elke minuut aangeroepen; de module beslist zelf wat er nu moet (opzet, dagronde 07:00, kwartier op minuut 1/16/31/46 tussen
// 09:01 en 22:01, avondronde 22:05) en houdt in meta bij wat al liep, zodat een herstart niets dubbel doet. Gemiste kwartieren: niet ingehaald.
// Log: alleen aantallen (geen namen, ISIN's, koersen of bedragen).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('./strateeg-reken.js');
const B = require('./strateeg-bron.js');

const UNIVERSUM = JSON.parse(fs.readFileSync(path.join(__dirname, 'strateeg-universum.json'), 'utf8'));
const REGELS = JSON.parse(fs.readFileSync(path.join(__dirname, 'strateeg-regels.json'), 'utf8'));
const REGELS_SHA = crypto.createHash('sha256').update(JSON.stringify(REGELS)).digest('hex').slice(0, 16);
const BOEKEN = ['echt', 'signaal', 'vasthouden', 'wereld'];
const PAUZE_MS = 1200;   // beleefd naar L&S en de rest: één verzoek per 1,2 s
const KENMERK_NAAM = {
  r1: 'de koers van gisteren', r5: 'het verloop van de week', r21: 'het verloop van de maand', r63: 'het verloop van het kwartaal', r126: 'het halfjaarsverloop',
  m252_21: 'het jaarverloop', vol21: 'de beweeglijkheid van de maand', vol63: 'de beweeglijkheid van het kwartaal', volv: 'de verandering in beweeglijkheid',
  top252: 'de afstand tot de jaartop', ma50: 'de afstand tot het 50-daags gemiddelde', ma200: 'de afstand tot het 200-daags gemiddelde', beta: 'het meebewegen met de markt',
  rest21: 'de eigen beweging van de maand', thema21: 'het verloop tegen het eigen thema', x_mom_vol: 'het halfjaarsverloop in een onrustige markt',
  x_mom_breed: 'het halfjaarsverloop in een brede markt', wiki: 'de aandacht op Wikipedia', cijfer_dagen: 'de dagen sinds de kwartaalcijfers', cijfer_reactie: 'de koersreactie op de cijfers',
};
const REDEN_NAAM = {
  geen_voorsprong: 'geen beter aandeel', kosten_hoger: 'voorsprong kleiner dan de kosten', houdtijd: 'nog binnen de houdtijd', budget_op: 'kostenbudget van de maand op',
  koers_oud: 'geen verse koers', beurs_dicht: 'beurs dicht', cijfers_nabij: 'cijfers op komst', koers_loopt_weg: 'koers loopt weg', al_gewisseld: 'vandaag al gewisseld',
  geen_kandidaat: 'geen kandidaat binnen de spreiding', geen_voorspelling: 'nog geen voorspelling van vandaag', opbouw: 'opbouw', aanvullen: 'aangevuld', gewisseld: 'gewisseld',
  te_groot: 'positie te groot', bron_dicht: 'koersbron weigert', noodrem: 'noodrem', pauze: 'gepauzeerd', klaar: 'proef afgelopen', wacht: 'wacht op de start',
};

function maak(o) {
  const nu = o.nu || Date.now;
  const log = o.log || function () {};
  const meta = {}, metaIdx = {};
  for (const i of UNIVERSUM.instrumenten) meta[i.isin] = { thema: i.thema, laag: i.laag, tarief: i.tarief, beurs: i.beurs, naam: i.naam };
  if (UNIVERSUM.instrumenten.some((i) => UNIVERSUM.nooit.includes(i.isin))) throw new Error('universum bevat een uitgesloten ISIN');
  Object.assign(metaIdx, meta, { [UNIVERSUM.index.isin]: { thema: 'index', laag: 'index', tarief: 'ETF', beurs: UNIVERSUM.index.beurs, naam: UNIVERSUM.index.naam } });
  const ALLE = UNIVERSUM.instrumenten.concat([UNIVERSUM.index]);
  const LS_ID = {}; for (const i of ALLE) LS_ID[i.isin] = i.ls_id;

  let dbC = null;
  function db() {
    if (dbC) return dbC;
    const { DatabaseSync } = require('node:sqlite');
    const map = path.dirname(o.dbPad);
    if (!fs.existsSync(map)) fs.mkdirSync(map, { recursive: true, mode: 0o700 });
    const nieuw = !fs.existsSync(o.dbPad);
    const d = new DatabaseSync(o.dbPad);
    if (nieuw) { try { fs.chmodSync(o.dbPad, 0o600); } catch (e) { /* bestaat al */ } }
    d.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    d.exec(`
      CREATE TABLE IF NOT EXISTS meta (sleutel TEXT PRIMARY KEY, waarde TEXT);
      CREATE TABLE IF NOT EXISTS dagkoers (isin TEXT, dag TEXT, slot REAL, PRIMARY KEY (isin, dag));
      CREATE TABLE IF NOT EXISTS aandacht (bron TEXT, isin TEXT, dag TEXT, waarde REAL, PRIMARY KEY (bron, isin, dag));
      CREATE TABLE IF NOT EXISTS cijferdag (isin TEXT, dag TEXT, bron TEXT, PRIMARY KEY (isin, dag, bron));
      CREATE TABLE IF NOT EXISTS kwartier (isin TEXT, tijd INTEGER, open REAL, hoog REAL, laag REAL, slot REAL, punten INTEGER, PRIMARY KEY (isin, tijd));
      CREATE TABLE IF NOT EXISTS laatst (isin TEXT PRIMARY KEY, ms INTEGER, k REAL, vorige REAL);
      CREATE TABLE IF NOT EXISTS voorspelling (dag TEXT, isin TEXT, score REAL, mu REAL, kans REAL, rang INTEGER, doorslag TEXT, meer REAL, gescoord_op TEXT, PRIMARY KEY (dag, isin));
      CREATE TABLE IF NOT EXISTS model (id INTEGER PRIMARY KEY, gemaakt INTEGER, periode TEXT, inhoud TEXT);
      CREATE TABLE IF NOT EXISTS backtest (id INTEGER PRIMARY KEY, gemaakt INTEGER, sha TEXT, voorspelt INTEGER, uitkomst TEXT);
      CREATE TABLE IF NOT EXISTS boek (id TEXT PRIMARY KEY, start REAL, contant REAL, opgezet INTEGER);
      CREATE TABLE IF NOT EXISTS positie (boek TEXT, isin TEXT, aantal REAL, aankoop REAL, sinds TEXT, PRIMARY KEY (boek, isin));
      CREATE TABLE IF NOT EXISTS opdracht (id INTEGER PRIMARY KEY, boek TEXT, tijd INTEGER, dag TEXT, isin TEXT, kant TEXT, aantal REAL, midden REAL, prijs REAL,
        kosten REAL, kosten_uit TEXT, reden_code TEXT, reden_zin TEXT, scores TEXT);
      CREATE TABLE IF NOT EXISTS tik (tijd INTEGER PRIMARY KEY, dag TEXT, status TEXT, vers INTEGER, oud INTEGER, besluit TEXT, reden_code TEXT, duur_ms INTEGER);
      CREATE TABLE IF NOT EXISTS waarde (boek TEXT, tijd INTEGER, dag TEXT, waarde REAL, contant REAL, PRIMARY KEY (boek, tijd));
      CREATE TABLE IF NOT EXISTS bron_stand (bron TEXT, dag TEXT, verzoeken INTEGER, ok INTEGER, fout INTEGER, laatst_ok INTEGER, PRIMARY KEY (bron, dag));
    `);
    dbC = d;
    return d;
  }
  const M = {
    get(k) { const r = db().prepare('SELECT waarde FROM meta WHERE sleutel = ?').get(k); return r ? r.waarde : null; },
    zet(k, v) { db().prepare('INSERT INTO meta (sleutel, waarde) VALUES (?, ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde').run(k, v == null ? null : String(v)); },
  };
  function tel(bron, dag, ok) {
    db().prepare(`INSERT INTO bron_stand (bron, dag, verzoeken, ok, fout, laatst_ok) VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(bron, dag) DO UPDATE SET verzoeken = verzoeken + 1, ok = ok + excluded.ok, fout = fout + excluded.fout, laatst_ok = COALESCE(excluded.laatst_ok, laatst_ok)`)
      .run(bron, dag, ok ? 1 : 0, ok ? 0 : 1, ok ? nu() : null);
  }
  const wacht = (ms) => new Promise((r) => setTimeout(r, o.pauzeMs != null ? o.pauzeMs : ms));
  async function haal(bron, url, soort) {
    const dag = nlNu().dag;
    try { const t = await o.haal(url, soort || 'ls'); tel(bron, dag, true); return t; }
    catch (e) { tel(bron, dag, false); if (e && /\b(403|429)\b/.test(String(e.message || e))) { const f = new Error('bron_dicht'); f.dicht = true; throw f; } return null; }
  }
  function nlNu(ms) { return R.deelIn(ms == null ? nu() : ms, 'Europe/Amsterdam'); }
  const hm = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  function beursdag(dag) {   // dag waarop minstens één beurs van het universum open is (doordeweeks en niet overal dicht)
    const wd = new Date(dag + 'T12:00:00Z').getUTCDay(); if (wd === 0 || wd === 6) return false;
    return Object.values(REGELS.beurzen).some((b) => !(b.gesloten || []).includes(dag));
  }

  // ── opzet en dagronde: koersen, aandacht, cijferdata ──
  async function haalDagkoersen(isins, vandaag) {
    let n = 0;
    for (const isin of isins) {
      const t = await haal('ls_dag', B.lsReeksUrl(LS_ID[isin], 'history'));
      const rij = t ? B.lsDagreeks(t, vandaag) : null;
      if (rij && rij.length) {
        const st = db().prepare('INSERT INTO dagkoers (isin, dag, slot) VALUES (?, ?, ?) ON CONFLICT(isin, dag) DO UPDATE SET slot = excluded.slot');
        db().exec('BEGIN'); try { for (const p of rij) st.run(isin, p.d, p.k); db().exec('COMMIT'); } catch (e) { db().exec('ROLLBACK'); throw e; }
        n++;
      }
      await wacht(PAUZE_MS);
    }
    return n;
  }
  function isoMin(dag, n) { const d = new Date(dag + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }
  async function haalWiki(vandaag, volledig) {
    const van = (volledig ? '2015-07-01' : isoMin(vandaag, 100)).replace(/-/g, ''), tot = isoMin(vandaag, 1).replace(/-/g, '');
    let n = 0;
    for (const i of UNIVERSUM.instrumenten) {
      const som = new Map();
      for (const titel of i.wiki || []) {
        const t = await haal('wiki', B.wikiUrl(titel, van, tot), 'web');
        for (const r of (t && B.wikiRijen(t)) || []) som.set(r.d, (som.get(r.d) || 0) + r.v);
        await wacht(400);
      }
      if (som.size) {
        const st = db().prepare('INSERT INTO aandacht (bron, isin, dag, waarde) VALUES (\'wiki\', ?, ?, ?) ON CONFLICT(bron, isin, dag) DO UPDATE SET waarde = excluded.waarde');
        db().exec('BEGIN'); try { for (const [d, v] of som) st.run(i.isin, d, v); db().exec('COMMIT'); } catch (e) { db().exec('ROLLBACK'); throw e; }
        n++;
      }
    }
    return n;
  }
  async function haalSec(volledig) {
    let n = 0;
    for (const i of UNIVERSUM.instrumenten) {
      if (!i.cik) continue;
      const t = await haal('sec', B.secUrl(i.cik), 'web'); await wacht(400);
      if (!t) continue;
      let dagen = B.secCijferdagen(t) || [];
      if (volledig) for (const deel of B.secDelen(t)) { const x = await haal('sec', B.secDeelUrl(deel), 'web'); await wacht(400); if (x) dagen = dagen.concat(B.secCijferdagen(x) || []); }
      const st = db().prepare('INSERT OR IGNORE INTO cijferdag (isin, dag, bron) VALUES (?, ?, \'sec\')');
      for (const d of dagen) st.run(i.isin, d);
      n++;
    }
    return n;
  }
  async function haalCijferkalender(vandaag) {
    const codes = {}; for (const i of UNIVERSUM.instrumenten) if (i.nasdaq) codes[i.nasdaq] = i.isin;
    let dag = vandaag, n = 0, gedaan = 0;
    while (gedaan < 4 && n < 8) {
      n++;
      if (beursdag(dag)) {
        const t = await haal('nasdaq_cijfers', B.nasdaqCijferUrl(dag), 'ls'); await wacht(PAUZE_MS);
        const rij = t ? B.nasdaqCijfers(t) : null;
        if (rij) { db().prepare('DELETE FROM cijferdag WHERE dag = ? AND bron = \'nasdaq\'').run(dag); for (const r of rij) if (codes[r.code]) db().prepare('INSERT OR IGNORE INTO cijferdag (isin, dag, bron) VALUES (?, ?, \'nasdaq\')').run(codes[r.code], dag); }
        gedaan++;
      }
      const d = new Date(dag + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); dag = d.toISOString().slice(0, 10);
    }
  }

  // invoer voor het rekenkind uit de databank
  function kindInvoer() {
    const reeksen = {};
    for (const i of ALLE) reeksen[i.isin] = db().prepare('SELECT dag AS d, slot AS k FROM dagkoers WHERE isin = ? ORDER BY dag').all(i.isin).map((r) => ({ d: r.d, k: r.k }));
    const wiki = {}, cijfer = {};
    for (const i of UNIVERSUM.instrumenten) {
      const w = db().prepare('SELECT dag, waarde FROM aandacht WHERE bron = \'wiki\' AND isin = ? ORDER BY dag').all(i.isin).map((r) => [r.dag, r.waarde]);
      if (w.length) wiki[i.isin] = w;
      const c = db().prepare('SELECT DISTINCT dag FROM cijferdag WHERE isin = ? AND bron = \'sec\' ORDER BY dag').all(i.isin).map((r) => r.dag);
      if (c.length) cijfer[i.isin] = c;
    }
    return { reeksen, meta, extra: { wiki, cijfer }, regels: REGELS, index: UNIVERSUM.index.isin };
  }
  function bewaarScores(u) {
    const volg = u.voorspellingen.slice().sort((a, b) => b.mu - a.mu);
    const st = db().prepare(`INSERT INTO voorspelling (dag, isin, score, mu, kans, rang, doorslag) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dag, isin) DO UPDATE SET score = excluded.score, mu = excluded.mu, kans = excluded.kans, rang = excluded.rang, doorslag = excluded.doorslag`);
    volg.forEach((v, k) => st.run(u.dag, v.isin, v.score, v.mu, v.kans, k + 1, JSON.stringify(v.doorslag || [])));
    db().prepare('INSERT INTO model (gemaakt, periode, inhoud) VALUES (?, ?, ?)').run(nu(), u.model.periode, JSON.stringify(u.model));
    // eigen voorspellingen van vóór vandaag die nu een uitkomst hebben (uit dezelfde reeks als de backtest)
    let gescoord = 0;
    for (const r of u.recent || []) {
      if (!r.meer) continue;
      r.isins.forEach((isin, k) => {
        if (r.meer[k] == null) return;
        const x = db().prepare('UPDATE voorspelling SET meer = ?, gescoord_op = ? WHERE dag = ? AND isin = ? AND meer IS NULL').run(r.meer[k], nlNu().dag, r.dag, isin);
        gescoord += Number(x.changes || 0);
      });
    }
    return gescoord;
  }

  async function opzet(vandaag) {
    M.zet('opzet_begin', nu());
    const nk = await haalDagkoersen(ALLE.map((i) => i.isin), vandaag);
    const nw = await haalWiki(vandaag, true);
    const ns = await haalSec(true);
    log({ stap: 'opzet', koersen: nk, wiki: nw, sec: ns });
    if (nk < 30) { M.zet('opzet_fout', 'te weinig koersreeksen (' + nk + ')'); return false; }
    const bt = await o.kind('backtest', kindInvoer());
    if (!bt || !bt.ok) { M.zet('opzet_fout', 'backtest faalde'); log({ stap: 'backtest', ok: 0 }); return false; }
    bewaarBacktest(bt);
    M.zet('opzet', vandaag); M.zet('opzet_fout', null);
    return true;
  }
  function bewaarBacktest(bt) {
    db().prepare('INSERT INTO backtest (gemaakt, sha, voorspelt, uitkomst) VALUES (?, ?, ?, ?)').run(nu(), bt.instellingen_sha, bt.oordeel && bt.oordeel.voorspelt ? 1 : 0, JSON.stringify(bt));
    if (!M.get('modus')) M.zet('modus', bt.oordeel && bt.oordeel.voorspelt ? 'engine' : 'terugval');   // één keer vóór de start, daarna vast
    log({ stap: 'backtest', ok: 1, voorspelt: bt.oordeel && bt.oordeel.voorspelt ? 1 : 0, ms: bt.gemaakt_ms });
  }
  async function dagronde(vandaag) {
    const t0 = nu();
    const nk = await haalDagkoersen(ALLE.map((i) => i.isin), vandaag);
    const nw = await haalWiki(vandaag, false);
    const maandag = new Date(vandaag + 'T12:00:00Z').getUTCDay() === 1;
    if (maandag || !M.get('sec_dag')) { await haalSec(false); M.zet('sec_dag', vandaag); }
    await haalCijferkalender(vandaag);
    const u = await o.kind('scoor', kindInvoer());
    let gescoord = 0;
    if (u && u.ok) { gescoord = bewaarScores(u); M.zet('score_dag', u.dag); M.zet('score_voor', vandaag); }
    // wekelijkse backtest (maandag, of als de laatste > 7 dagen oud is); verandert de modus niet meer na de start
    const lb = db().prepare('SELECT MAX(gemaakt) AS g FROM backtest').get();
    if (maandag && (!lb.g || nu() - lb.g > 6 * 86400000)) { const bt = await o.kind('backtest', kindInvoer()); if (bt && bt.ok) bewaarBacktest(bt); }
    log({ stap: 'dagronde', koersen: nk, wiki: nw, voorspellingen: u && u.ok ? u.voorspellingen.length : 0, gescoord, ms: nu() - t0 });
    return !!(u && u.ok);
  }

  // ── boeken ──
  function boekLees(id) {
    const b = db().prepare('SELECT * FROM boek WHERE id = ?').get(id);
    if (!b) return null;
    return { id, start: b.start, contant: b.contant, opgezet: b.opgezet, posities: db().prepare('SELECT isin, aantal, aankoop, sinds FROM positie WHERE boek = ?').all(id).map((p) => Object.assign({}, p)) };
  }
  function boekenZeker() { for (const id of BOEKEN) db().prepare('INSERT OR IGNORE INTO boek (id, start, contant, opgezet) VALUES (?, ?, ?, 0)').run(id, REGELS.start, REGELS.start); }
  function boekSchrijf(b) {
    db().prepare('UPDATE boek SET contant = ?, opgezet = ? WHERE id = ?').run(b.contant, b.opgezet || 0, b.id);
    db().prepare('DELETE FROM positie WHERE boek = ?').run(b.id);
    const st = db().prepare('INSERT INTO positie (boek, isin, aantal, aankoop, sinds) VALUES (?, ?, ?, ?, ?)');
    for (const p of b.posities) st.run(b.id, p.isin, p.aantal, p.aankoop, String(p.sinds));
  }
  function laatsteKoers(isin) {
    const l = db().prepare('SELECT k FROM laatst WHERE isin = ?').get(isin); if (l) return l.k;
    const d = db().prepare('SELECT slot FROM dagkoers WHERE isin = ? ORDER BY dag DESC LIMIT 1').get(isin); return d ? d.slot : null;
  }
  function boekWaarde(b) { let w = b.contant; for (const p of b.posities) w += p.aantal * (laatsteKoers(p.isin) || p.aankoop); return w; }

  // ── kwartier ──
  function beursdagIndex(dag) { return db().prepare('SELECT COUNT(DISTINCT dag) AS n FROM dagkoers WHERE isin = ? AND dag < ?').get(UNIVERSUM.index.isin, dag).n; }
  function voorspellingenVan(dag) {
    const v = db().prepare('SELECT * FROM voorspelling WHERE dag = (SELECT MAX(dag) FROM voorspelling WHERE dag < ?)').all(dag);
    const mu = {}, rij = {}; for (const x of v) { mu[x.isin] = x.mu; rij[x.isin] = x; }
    return { mu, rij, dag: v.length ? v[0].dag : null };
  }
  function cijfersNabij(isin, dag) {
    const tot = new Date(dag + 'T12:00:00Z'); tot.setUTCDate(tot.getUTCDate() + 4);
    return !!db().prepare('SELECT 1 FROM cijferdag WHERE isin = ? AND bron = \'nasdaq\' AND dag >= ? AND dag <= ? LIMIT 1').get(isin, dag, tot.toISOString().slice(0, 10));
  }
  async function haalMinuten(isins, ms) {
    const uit = {};
    for (const isin of isins) {
      const t = await haal('ls_minuut', B.lsReeksUrl(LS_ID[isin], 'intraday'));
      const x = t ? B.lsIntraday(t) : null;
      if (x && x.isin === isin) {
        const punten = x.punten.map((p) => [R.lsEchteMs(p[0]), p[1]]);
        uit[isin] = { punten, vorige: x.vorige };
        if (punten.length) db().prepare('INSERT INTO laatst (isin, ms, k, vorige) VALUES (?, ?, ?, ?) ON CONFLICT(isin) DO UPDATE SET ms = excluded.ms, k = excluded.k, vorige = excluded.vorige')
          .run(isin, punten[punten.length - 1][0], punten[punten.length - 1][1], x.vorige);
      }
      await wacht(PAUZE_MS);
    }
    return uit;
  }
  function pct(x, n) { return (Math.round(x * 100 * Math.pow(10, n == null ? 1 : n)) / Math.pow(10, n == null ? 1 : n)).toLocaleString('nl-NL'); }
  function naam(isin) { return (metaIdx[isin] || {}).naam || isin; }
  function doorslagZin(rij) { try { const d = JSON.parse(rij.doorslag || '[]'); return d.length ? KENMERK_NAAM[d[0][0]] || d[0][0] : null; } catch (e) { return null; } }
  function redenZin(od, vs, extra) {
    const r = vs.rij[od.isin];
    const ds = r ? doorslagZin(r) : null;
    switch (od.reden_code) {
      case 'opbouw': case 'aanvullen':
        return (od.reden_code === 'opbouw' ? 'Gekocht bij de opbouw' : 'Gekocht om een lege plek te vullen') + ': nummer ' + (r ? r.rang : '?') + ' van de voorspelling, verwachte voorsprong ' + pct(r ? r.mu : 0, 2) + ' % in tien beursdagen' + (ds ? '; doorslag: ' + ds : '') + '.';
      case 'gewisseld_uit': return 'Verkocht voor de wissel naar ' + naam(od.naar) + ': die verwacht ' + pct(od.voorsprong, 2) + ' % meer in tien beursdagen, de kosten zijn ' + pct(od.kost, 2) + ' %.';
      case 'gewisseld_in': return 'Gekocht in de wissel voor ' + naam(od.van) + ': verwachte voorsprong ' + pct(od.voorsprong, 2) + ' % tegen ' + pct(od.kost, 2) + ' % kosten' + (ds ? '; doorslag: ' + ds : '') + '.';
      case 'te_groot': return 'Deels verkocht: de positie was gegroeid tot ' + pct(od.gewicht, 0) + ' % van het boek (grens ' + pct(REGELS.max_aandeel, 0) + ' %).';
      case 'stop': return 'Verkocht omdat de koers ' + pct(-od.verlies, 0) + ' % onder de aankoopprijs kwam (stop).';
      case 'signaal_uit': return 'Boek Signaal: uit de zes hoogste scores gevallen (dagelijkse wissel, geen kosten).';
      case 'signaal_in': return 'Boek Signaal: nummer ' + (r ? r.rang : '?') + ' van de voorspelling (dagelijkse wissel, geen kosten).';
      case 'maatstaf': return extra || 'Maatstaf gekocht op de startdag.';
      default: return '';
    }
  }
  function boekOrder(boek, od, midden, ms, dag, metKosten, vs, extraZin) {
    const g = R.voerUit(boek, od, midden, metaIdx, REGELS.tarieven, REGELS, beursdagIndex(dag), metKosten);
    if (!g) return null;
    const r = vs && vs.rij[od.isin];
    db().prepare(`INSERT INTO opdracht (boek, tijd, dag, isin, kant, aantal, midden, prijs, kosten, kosten_uit, reden_code, reden_zin, scores) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(boek.id, ms, dag, od.isin, g.kant, g.aantal, g.midden, g.prijs, g.kosten.totaal, JSON.stringify(g.kosten), od.reden_code || '', redenZin(od, vs || { rij: {} }, extraZin),
        JSON.stringify(r ? { rang: r.rang, mu: r.mu, kans: r.kans } : {}));
    return g;
  }
  function kostenDezeMaand(dag) {
    const r = db().prepare("SELECT COALESCE(SUM(kosten), 0) AS k FROM opdracht WHERE boek = 'echt' AND substr(dag, 1, 7) = ? AND reden_code NOT IN ('opbouw')").get(dag.slice(0, 7));
    return r.k;
  }

  async function kwartier(ms, nl) {
    const t0 = nu(), dag = nl.dag;
    const vs = voorspellingenVan(dag);
    const echt = boekLees('echt'), sign = boekLees('signaal');
    const modus = M.get('modus') || 'engine';
    let mu = vs.mu;
    if (modus === 'terugval') mu = terugvalMu(dag);
    if (!vs.dag) { schrijfTik(ms, dag, 'geen_voorspelling', 0, 0, 'niets', 'geen_voorspelling', nu() - t0); return; }
    // welke koersen: posities van beide boeken, de vier beste kandidaten, de wereld-ETF; op het signaalkwartier ook de doellijst
    const signaalKwartier = nl.min === hm(REGELS.signaal_kwartier);
    const isMaatstafStart = signaalKwartier && !boekLees('vasthouden').opgezet;
    const kand = Object.keys(mu).filter((i) => !echt.posities.some((p) => p.isin === i)).sort((a, b) => mu[b] - mu[a]).slice(0, 4);
    const doel = signaalKwartier ? R.doelLijst(mu, meta, REGELS, Object.keys(mu)) : [];
    let isins = [...new Set(echt.posities.map((p) => p.isin).concat(kand, sign.posities.map((p) => p.isin), doel, [UNIVERSUM.index.isin]))];
    if (isMaatstafStart) isins = ALLE.map((i) => i.isin);
    let min;
    try { min = await haalMinuten(isins, ms); }
    catch (e) { if (e.dicht) { schrijfTik(ms, dag, 'bron_dicht', 0, isins.length, 'niets', 'bron_dicht', nu() - t0); return; } throw e; }
    const prijzen = {}, versheid = {}, beweging = {};
    let nVers = 0;
    const msNu = nu();
    for (const isin of isins) {
      const m = min[isin]; const v = m ? R.vers(m.punten, msNu) : { vers: false, reden: 'geen' };
      const open = R.beursOpen(REGELS.beurzen, metaIdx[isin].beurs, msNu);
      versheid[isin] = { vers: v.vers, open };
      if (v.vers) { nVers++; if (open) prijzen[isin] = v.k; if (m.vorige) beweging[isin] = v.k / m.vorige - 1; }
    }
    const bewU = R.gem(Object.values(beweging));
    const dagSd = (isin) => { const r = db().prepare('SELECT slot FROM dagkoers WHERE isin = ? ORDER BY dag DESC LIMIT 22').all(isin).map((x) => x.slot).reverse(); const l = []; for (let k = 1; k < r.length; k++) l.push(Math.log(r[k] / r[k - 1])); return R.sd(l) || 0.02; };
    const telReden = {};
    const magKopen = (isin) => {
      if (!(prijzen[isin] > 0)) { telReden[isin] = versheid[isin] && !versheid[isin].open ? 'beurs_dicht' : 'koers_oud'; return false; }
      if (R.minutenSindsOpen(REGELS.beurzen, metaIdx[isin].beurs, msNu) < REGELS.niet_eerste_minuten) { telReden[isin] = 'beurs_dicht'; return false; }
      if (cijfersNabij(isin, dag)) { telReden[isin] = 'cijfers_nabij'; return false; }
      if (beweging[isin] != null && isFinite(bewU)) { const z = (beweging[isin] - bewU) / dagSd(isin); if (z > REGELS.achter_koers_sd) { telReden[isin] = 'koers_loopt_weg'; return false; } }
      return true;
    };
    const magVerkopen = (isin) => {
      if (!(prijzen[isin] > 0)) return false;
      if (R.minutenSindsOpen(REGELS.beurzen, metaIdx[isin].beurs, msNu) < REGELS.niet_eerste_minuten) return false;
      if (beweging[isin] != null && isFinite(bewU)) { const z = (beweging[isin] - bewU) / dagSd(isin); if (z < -REGELS.achter_koers_sd) return false; }
      return true;
    };
    const dagIdx = beursdagIndex(dag);
    const echtB = Object.assign({}, echt, { posities: echt.posities.map((p) => Object.assign({}, p, { sinds: Number(p.sinds) })) });
    const vandaagGewisseld = !!db().prepare("SELECT 1 FROM opdracht WHERE boek = 'echt' AND dag = ? AND reden_code = 'gewisseld_in' LIMIT 1").get(dag);
    const eersteVanMaand = modus !== 'terugval' || eersteBeursdagVanMaand(dag);
    const r = R.besluit({ regels: REGELS, meta, tarieven: REGELS.tarieven, prijzen, mu, posities: echtB.posities, contant: echtB.contant, vandaagIdx: dagIdx,
      wisselVandaag: vandaagGewisseld || !eersteVanMaand, budgetOver: REGELS.kostenbudget * REGELS.start - kostenDezeMaand(dag), magKopen, magVerkopen,
      stopUit: !REGELS.stop_aan, opbouw: !echt.opgezet, opbouwMax: 3, noodrem: true, kopenReden: (i) => telReden[i] || 'beurs_dicht' });
    let orders = 0;
    db().exec('BEGIN');
    try {
      for (const od of r.orders.filter((x) => x.kant === 'verkoop').concat(r.orders.filter((x) => x.kant === 'koop'))) {
        const g = boekOrder(echtB, od, prijzen[od.isin], msNu, dag, true, vs);
        if (g) orders++;
      }
      if (echtB.posities.length >= REGELS.posities) echtB.opgezet = 1;
      boekSchrijf(echtB);
      // Boek Signaal: één keer per dag op het signaalkwartier naar de doellijst, zonder kosten
      if (signaalKwartier) {
        const sb = Object.assign({}, sign, { posities: sign.posities.map((p) => Object.assign({}, p)) });
        for (const p of sb.posities.slice()) if (!doel.includes(p.isin) && prijzen[p.isin] > 0) { if (boekOrder(sb, { isin: p.isin, kant: 'verkoop', aantal: p.aantal, reden_code: 'signaal_uit' }, prijzen[p.isin], msNu, dag, false, vs)) orders++; }
        const erbij = doel.filter((i) => !sb.posities.some((p) => p.isin === i) && prijzen[i] > 0);
        const w = boekWaarde(sb), vrij = sb.contant - REGELS.contant_min * w;
        for (const i of erbij) { const bedrag = Math.min(vrij / erbij.length, sb.contant); const aantal = Math.floor((bedrag / prijzen[i]) * 1e4) / 1e4; if (aantal > 0 && boekOrder(sb, { isin: i, kant: 'koop', aantal, reden_code: 'signaal_in' }, prijzen[i], msNu, dag, false, vs)) orders++; }
        sb.opgezet = 1; boekSchrijf(sb);
      }
      // maatstaven op de startdag (signaalkwartier): gelijk gewogen alle 40 en de wereld-ETF; geen verse koers = laatste slot
      if (isMaatstafStart) {
        const vh = boekLees('vasthouden'), per = vh.contant / UNIVERSUM.instrumenten.length;
        for (const i of UNIVERSUM.instrumenten) {
          const k = prijzen[i.isin] || (versheid[i.isin] && versheid[i.isin].vers ? min[i.isin].punten[min[i.isin].punten.length - 1][1] : laatsteKoers(i.isin));
          if (!(k > 0)) continue;
          // zonder kosten: 40 orders van € 25 zouden ± 12 % kosten en de maatstaf onbruikbaar maken (gemeten in de proefdag, 23-11)
          const aantal = Math.floor((per / k) * 1e4) / 1e4;
          if (aantal > 0) boekOrder(vh, { isin: i.isin, kant: 'koop', aantal, reden_code: 'maatstaf' }, k, msNu, dag, false, null, 'Maatstaf kopen-en-vasthouden: één keer gelijk verdeeld over alle 40 (zonder kosten), daarna niets doen.');
        }
        vh.opgezet = 1; boekSchrijf(vh);
        const wb = boekLees('wereld'), ix = UNIVERSUM.index.isin, k = prijzen[ix] || laatsteKoers(ix);
        if (k > 0) { const aantal = Math.floor(((wb.contant - 1) / R.uitvoerPrijs(k, 'koop', REGELS.halve_spread)) * 1e4) / 1e4; boekOrder(wb, { isin: ix, kant: 'koop', aantal, reden_code: 'maatstaf' }, k, msNu, dag, true, null, 'Maatstaf wereldindex: alles in iShares Core MSCI World op de startdag.'); }
        wb.opgezet = 1; boekSchrijf(wb);
      }
      waardenVastleggen(msNu, dag);
      db().exec('COMMIT');
    } catch (e) { db().exec('ROLLBACK'); throw e; }
    const code = r.orders.length ? r.reden_code : (r.reden_code || 'geen_voorsprong');
    schrijfTik(ms, dag, 'ok', nVers, isins.length - nVers, orders ? 'order' : 'niets', code, nu() - t0);
    log({ stap: 'kwartier', vers: nVers, oud: isins.length - nVers, orders, ms: nu() - t0 });
    // drie kwartieren op rij geen enkele verse koers tijdens beursuren → één box-rij per dag
    const laatste3 = db().prepare('SELECT vers FROM tik WHERE dag = ? AND status = \'ok\' ORDER BY tijd DESC LIMIT 3').all(dag);
    const ietsOpen = Object.keys(REGELS.beurzen).some((b) => R.beursOpen(REGELS.beurzen, b, msNu));
    if (ietsOpen && laatste3.length === 3 && laatste3.every((x) => x.vers === 0) && M.get('box_oud') !== dag && o.boxRij) {
      M.zet('box_oud', dag);
      try { o.boxRij('Strateeg (OVIS Beleggen, fictief): drie kwartieren op rij geen enkele verse koers van L&S tijdens beursuren; er wordt niet gehandeld tot de bron weer vers is. #beleggen-strateeg'); } catch (e) { /* */ }
    }
  }
  function eersteBeursdagVanMaand(dag) { const r = db().prepare('SELECT COUNT(*) AS n FROM tik WHERE substr(dag, 1, 7) = ? AND dag < ?').get(dag.slice(0, 7), dag); return r.n === 0; }
  function terugvalMu(dag) {   // sterkste zes van het halfjaar (laatste week niet), als pseudo-verwachting
    const mu = {};
    for (const i of UNIVERSUM.instrumenten) {
      const r = db().prepare('SELECT slot FROM dagkoers WHERE isin = ? AND dag < ? ORDER BY dag DESC LIMIT 127').all(i.isin, dag).map((x) => x.slot);
      if (r.length >= 127) mu[i.isin] = r[5] / r[126] - 1;
    }
    return mu;
  }
  function waardenVastleggen(ms, dag) {
    const st = db().prepare('INSERT INTO waarde (boek, tijd, dag, waarde, contant) VALUES (?, ?, ?, ?, ?) ON CONFLICT(boek, tijd) DO UPDATE SET waarde = excluded.waarde, contant = excluded.contant');
    for (const id of BOEKEN) { const b = boekLees(id); st.run(id, ms, dag, boekWaarde(b), b.contant); }
  }
  function schrijfTik(ms, dag, status, nVers, nOud, besluit, code, duur) {
    db().prepare('INSERT OR REPLACE INTO tik (tijd, dag, status, vers, oud, besluit, reden_code, duur_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(ms, dag, status, nVers, nOud, besluit, code, duur);
  }

  async function avondronde(dag) {
    const min = await haalMinuten(ALLE.map((i) => i.isin), nu());
    const st = db().prepare('INSERT OR REPLACE INTO kwartier (isin, tijd, open, hoog, laag, slot, punten) VALUES (?, ?, ?, ?, ?, ?, ?)');
    let n = 0;
    db().exec('BEGIN');
    try {
      for (const [isin, m] of Object.entries(min)) {
        const balk = new Map();
        for (const [t, k] of m.punten) { if (R.deelIn(t, 'Europe/Amsterdam').dag !== dag) continue; const kw = Math.floor(t / 900000) * 900000; const b = balk.get(kw); if (!b) balk.set(kw, { o: k, h: k, l: k, c: k, n: 1 }); else { b.h = Math.max(b.h, k); b.l = Math.min(b.l, k); b.c = k; b.n++; } }
        for (const [kw, b] of balk) st.run(isin, kw, b.o, b.h, b.l, b.c, b.n);
        if (balk.size) n++;
      }
      waardenVastleggen(nu(), dag);
      db().exec('COMMIT');
    } catch (e) { db().exec('ROLLBACK'); throw e; }
    // opruimen: tik/kwartier ouder dan een jaar
    const jaar = nu() - 366 * 86400000;
    db().prepare('DELETE FROM kwartier WHERE tijd < ?').run(jaar); db().prepare('DELETE FROM tik WHERE tijd < ?').run(jaar);
    log({ stap: 'avond', reeksen: n });
    if (o.hartslag) { try { await o.hartslag(n, 0); } catch (e) { /* */ } }
  }

  // ── stand van de proef ──
  function proefStand(dag) {
    const st = M.get('stand');
    const start = M.get('startdag');
    if (st === 'pauze') return 'pauze';
    if (!start) return 'wacht';
    const eind = M.get('einddag');
    if (eind && dag > eind) return 'klaar';
    return 'aan';
  }

  let bezig = false;
  async function tik() {
    if (bezig) return { gedaan: 'bezig' };
    bezig = true;
    try {
      const ms = nu(), nl = nlNu(ms), dag = nl.dag;
      boekenZeker();
      if (!M.get('opzet')) {
        if (M.get('opzet_poging') === dag + ':' + Math.floor(nl.min / 60)) return { gedaan: 'niets' };   // hooguit één poging per uur
        M.zet('opzet_poging', dag + ':' + Math.floor(nl.min / 60));
        await opzet(dag); return { gedaan: 'opzet' };
      }
      if (!beursdag(dag)) return { gedaan: 'niets' };
      if (nl.min >= 7 * 60 && M.get('dagronde') !== dag && nl.min < 22 * 60) {
        M.zet('dagronde', dag);
        const ok = await dagronde(dag);
        // start van de proef: de eerste beursdag waarop de backtest in de app staat en de voorspellingen van vandaag er zijn
        if (ok && !M.get('startdag') && M.get('stand') !== 'pauze') {
          const ein = new Date(dag + 'T12:00:00Z'); ein.setUTCDate(ein.getUTCDate() + REGELS.proef_dagen - 1);
          M.zet('startdag', dag); M.zet('einddag', ein.toISOString().slice(0, 10)); M.zet('regels_sha', REGELS_SHA);
          log({ stap: 'start' });
        }
        return { gedaan: 'dagronde' };
      }
      const stand = proefStand(dag);
      const kwMin = REGELS.kwartier_minuten.includes(nl.min % 60) && nl.min >= hm(REGELS.kwartier_van) && nl.min <= hm(REGELS.kwartier_tot);
      if (kwMin && stand === 'aan') {
        const sleutel = dag + ' ' + nl.min;
        if (M.get('kwartier') === sleutel) return { gedaan: 'niets' };
        M.zet('kwartier', sleutel);
        await kwartier(ms, nl); return { gedaan: 'kwartier' };
      }
      if (kwMin && stand !== 'aan' && stand !== 'wacht' && M.get('kwartier') !== dag + ' ' + nl.min) { M.zet('kwartier', dag + ' ' + nl.min); schrijfTik(ms, dag, stand, 0, 0, 'niets', stand, 0); }
      if (nl.min >= 22 * 60 + 5 && M.get('avond') !== dag && (stand === 'aan' || stand === 'pauze')) { M.zet('avond', dag); await avondronde(dag); return { gedaan: 'avond' }; }
      return { gedaan: 'niets' };
    } finally { bezig = false; }
  }

  // ── scherm ──
  function laatsteBacktest(vol) {
    const r = db().prepare('SELECT * FROM backtest ORDER BY id DESC LIMIT 1').get();
    if (!r) return null;
    const u = JSON.parse(r.uitkomst);
    if (vol) return u;
    const pf = {}; for (const [k, v] of Object.entries(u.portefeuille || {})) pf[k] = Object.assign({}, v, { lijn: undefined });
    return { gemaakt: r.gemaakt, sha: r.sha, voorspelt: !!r.voorspelt, data: u.data, hoofd: u.hoofd, oordeel: u.oordeel, lek: u.lek, varianten: u.varianten, portefeuille: pf,
      lijnen: { echt: (u.portefeuille.echt || {}).lijn, signaal: (u.portefeuille.signaal || {}).lijn, vasthouden: (u.portefeuille.vasthouden || {}).lijn, index: (u.portefeuille.index || {}).lijn, terugval: (u.portefeuille.terugval || {}).lijn },
      model: u.model ? { gewichten: u.model.namen.map((n, k) => ({ kenmerk: n, naam: KENMERK_NAAM[n] || n, w: u.model.w[k] })) } : null };
  }
  function overzicht() {
    boekenZeker();
    const dag = nlNu().dag;
    const startdag = M.get('startdag'), einddag = M.get('einddag');
    const boeken = {};
    for (const id of BOEKEN) {
      const b = boekLees(id), w = boekWaarde(b);
      boeken[id] = { start: b.start, waarde: Math.round(w * 100) / 100, contant: Math.round(b.contant * 100) / 100,
        posities: b.posities.map((p) => { const k = laatsteKoers(p.isin); const mm = metaIdx[p.isin] || {}; return { isin: p.isin, naam: mm.naam, thema: mm.thema, laag: mm.laag, aantal: p.aantal, aankoop: p.aankoop, koers: k, waarde: Math.round(p.aantal * (k || p.aankoop) * 100) / 100, resultaat: k ? k / p.aankoop - 1 : null, fractie: Math.abs(p.aantal - Math.round(p.aantal)) > 1e-6 }; }) };
    }
    const kosten = db().prepare("SELECT COALESCE(SUM(kosten), 0) AS k, COUNT(*) AS n FROM opdracht WHERE boek = 'echt'").get();
    const orders = db().prepare("SELECT boek, tijd, dag, isin, kant, aantal, midden, prijs, kosten, reden_code, reden_zin FROM opdracht WHERE boek IN ('echt', 'signaal') ORDER BY id DESC LIMIT 40").all()
      .map((x) => Object.assign({}, x, { naam: naam(x.isin) }));
    const vandaagTik = db().prepare('SELECT reden_code, besluit, COUNT(*) AS n FROM tik WHERE dag = ? GROUP BY reden_code, besluit').all(dag);
    const laatsteTik = db().prepare('SELECT tijd, status, vers, oud, besluit, reden_code FROM tik ORDER BY tijd DESC LIMIT 1').get() || null;
    const vsDag = (db().prepare('SELECT MAX(dag) AS d FROM voorspelling').get() || {}).d;
    const vp = vsDag ? db().prepare('SELECT isin, score, mu, kans, rang, doorslag FROM voorspelling WHERE dag = ? ORDER BY rang').all(vsDag).map((x) => ({ isin: x.isin, naam: naam(x.isin), thema: (meta[x.isin] || {}).thema, mu: x.mu, kans: x.kans, rang: x.rang, doorslag: doorslagZin(x) })) : [];
    // uitgekomen sinds de start: alleen eigen voorspellingen vanaf de startdag
    const gesc = startdag ? db().prepare('SELECT dag, isin, score, kans, meer FROM voorspelling WHERE dag >= ? AND meer IS NOT NULL').all(isoMin(startdag, 1)) : [];
    const perDag = {}; for (const g of gesc) (perDag[g.dag] = perDag[g.dag] || []).push(g);
    const ics = Object.values(perDag).map((l) => R.spearman(l.map((x) => x.score), l.map((x) => x.meer))).filter((x) => x != null);
    const tref = gesc.filter((g) => (g.score > 0) === (g.meer > 0)).length;
    const brier = gesc.length ? R.gem(gesc.map((g) => (g.kans - (g.meer > 0 ? 1 : 0)) ** 2)) : null;
    const reeks = {};
    for (const id of BOEKEN) {
      reeks[id] = db().prepare('SELECT dag, waarde FROM waarde WHERE boek = ? AND tijd IN (SELECT MAX(tijd) FROM waarde WHERE boek = ? GROUP BY dag) ORDER BY dag').all(id, id).map((x) => [x.dag, Math.round(x.waarde * 100) / 100]);
    }
    const vandaagReeks = {};
    for (const id of BOEKEN) vandaagReeks[id] = db().prepare('SELECT tijd, waarde FROM waarde WHERE boek = ? AND dag = ? ORDER BY tijd').all(id, dag).map((x) => [x.tijd, Math.round(x.waarde * 100) / 100]);
    const bronnen = db().prepare('SELECT bron, SUM(CASE WHEN dag = ? THEN verzoeken ELSE 0 END) AS vandaag, SUM(CASE WHEN dag = ? THEN fout ELSE 0 END) AS fout_vandaag, MAX(laatst_ok) AS laatst_ok FROM bron_stand GROUP BY bron').all(dag, dag)
      .map((x) => Object.assign({}, x));
    const dagN = startdag ? db().prepare('SELECT COUNT(DISTINCT dag) AS n FROM tik WHERE dag >= ? AND status = \'ok\'').get(startdag).n : 0;
    return {
      ok: true, fictief: true, vandaag: dag, stand: proefStand(dag), startdag, einddag, proef_dagen: REGELS.proef_dagen, beursdagen_gedaan: dagN,
      modus: M.get('modus'), regels_sha: M.get('regels_sha') || REGELS_SHA, opzet: M.get('opzet'), opzet_fout: M.get('opzet_fout'),
      regels: { posities: REGELS.posities, per_aandeel: REGELS.per_aandeel, max_aandeel: REGELS.max_aandeel, max_per_thema: REGELS.max_per_thema, min_per_thema: REGELS.min_per_thema, max_per_laag: REGELS.max_per_laag, contant_min: REGELS.contant_min, min_order: REGELS.min_order, houdtijd: REGELS.houdtijd, kostenbudget: REGELS.kostenbudget, stop_aan: !!REGELS.stop_aan, horizon: REGELS.horizon, tarieven: Object.fromEntries(Object.entries(REGELS.tarieven).map(([k, v]) => [k, v.uitleg])) },
      boeken, kosten_echt: { totaal: Math.round(kosten.k * 100) / 100, orders: kosten.n, maand: Math.round(kostenDezeMaand(dag) * 100) / 100, budget: REGELS.kostenbudget * REGELS.start },
      orders, laatste_tik: laatsteTik, tikken_vandaag: vandaagTik.map((x) => ({ reden: x.reden_code, naam: REDEN_NAAM[x.reden_code] || x.reden_code, besluit: x.besluit, n: x.n })),
      voorspellingen: { dag: vsDag, lijst: vp }, uitgekomen: { dagen: ics.length, gescoord: gesc.length, ic: ics.length ? R.gem(ics) : null, trefkans: gesc.length ? tref / gesc.length : null, brier },
      reeks, vandaag_reeks: vandaagReeks, backtest: laatsteBacktest(false), bronnen, universum: UNIVERSUM.instrumenten.length, index: UNIVERSUM.index.naam,
    };
  }
  function app(v) {
    if (v.methode === 'GET' && v.pad === '/app/beleggen/strateeg') return { status: 200, body: overzicht(), reden: 'strateeg' };
    if (v.methode === 'GET' && v.pad === '/app/beleggen/strateeg/backtest') { const b = laatsteBacktest(true); return { status: 200, body: { ok: true, backtest: b }, reden: 'strateeg backtest' }; }
    if (v.methode === 'POST' && v.pad === '/app/beleggen/strateeg/stand') {
      const s = v.body && v.body.stand;
      if (s !== 'pauze' && s !== 'aan') return { status: 400, body: { ok: false, fout: 'stand is pauze of aan' }, reden: 'strateeg stand 400' };
      M.zet('stand', s); return { status: 200, body: { ok: true, stand: s }, reden: 'strateeg stand' };
    }
    return { status: 404, body: { ok: false, fout: 'onbekend' }, reden: 'strateeg onbekend' };
  }
  function info() {
    try {
      const dag = nlNu().dag, l = db().prepare('SELECT tijd, status FROM tik ORDER BY tijd DESC LIMIT 1').get();
      return { aan: true, stand: proefStand(dag), opzet: !!M.get('opzet'), modus: M.get('modus'), startdag: M.get('startdag'), laatste_tik: l ? l.tijd : null,
        tikken_vandaag: db().prepare('SELECT COUNT(*) AS n FROM tik WHERE dag = ?').get(dag).n, orders: db().prepare("SELECT COUNT(*) AS n FROM opdracht WHERE boek = 'echt'").get().n };
    } catch (e) { return { aan: true, fout: true }; }
  }
  return { tik, app, info, _db: db, _M: M };
}

// Rekenkind starten (fork) met een invoerbestand in een eigen map (0700/0600); hooguit 6 minuten.
function forkKind(map) {
  return function (taak, invoer) {
    const cp = require('child_process');
    return new Promise((klaar) => {
      let pad;
      try {
        if (!fs.existsSync(map)) fs.mkdirSync(map, { recursive: true, mode: 0o700 });
        pad = path.join(map, 'kind-' + taak + '-' + process.pid + '.json');
        fs.writeFileSync(pad, JSON.stringify(invoer), { mode: 0o600 });
      } catch (e) { return klaar({ ok: false, fout: 'invoer' }); }
      let k, gedaan = false;
      const eind = (u) => { if (gedaan) return; gedaan = true; try { fs.unlinkSync(pad); } catch (e) { /* */ } klaar(u); };
      try { k = cp.fork(path.join(__dirname, 'strateeg-kind.js'), [taak, pad], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: ['--max-old-space-size=1024'] }); }
      catch (e) { return eind({ ok: false, fout: 'start' }); }
      const tm = setTimeout(() => { try { k.kill('SIGKILL'); } catch (e) { /* */ } eind({ ok: false, fout: 'tijd' }); }, 6 * 60000);
      k.on('message', (u) => { clearTimeout(tm); eind(u); });
      k.on('exit', () => { clearTimeout(tm); eind({ ok: false, fout: 'gestopt' }); });
      k.on('error', () => { clearTimeout(tm); eind({ ok: false, fout: 'fout' }); });
    });
  };
}

module.exports = { maak, forkKind, UNIVERSUM, REGELS, REGELS_SHA, KENMERK_NAAM, REDEN_NAAM };
