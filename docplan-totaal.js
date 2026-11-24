'use strict';
/*
 * DocPlan — lopend totaal waarnemers per praktijk in de app (wv2158, 1-11-2026; idee 25; vault "01_Ontwikkeling/OVIS DocPlan - ontwerp
 * (31-10-2026).md" § 9). David 31-10: "Alle waarnemers die gepasseerd zijn moeten we, vanaf 1-1, ook als waarnemer (entiteit) hebben staan,
 * met per praktijk het lopende totaal." GET /app/facturen/waarnemers[/<jaar>] (server.js appFacturen, alleen de eigenaar, Facturen › Waarnemers).
 *
 * Rekenregel = mk-scripts/docplan/entiteiten.py totaal: per persoon, per praktijk, per jaar de som van de AFschrijvingen van de praktijkrekening
 * (Tolgaarde, Groenhouten) aan de IBAN's die docplan.sqlite (tabel rekening, één IBAN hoort bij één persoon) aan hem koppelt; alleen bankregels
 * met verwijderd_op is null; t/m de laatste boekdatum per praktijk. Bijschrijvingen van diezelfde IBAN's worden niet afgetrokken maar apart
 * geteld ("terug ontvangen, te beoordelen"). Niets opgeslagen: elke vraag rekent opnieuw, dus na elke bankronde vanzelf bij.
 * wv4011 (2B43): plus de betalingen uit een betaalbestand zodra de bank de batch heeft afgeschreven (sepaBetalingen hieronder; ook de regel van
 * docplan-jaaropgaaf.js en docplan-controle.js). entiteiten.py totaal (handmatige CLI) kent die batchbetalingen niet.
 *
 * Puur: deze module laadt niets en raakt geen bestanden. server.js geeft twee alleen-lezen verbindingen mee (docplan.sqlite readOnly, facturen.sqlite
 * via facturen-db.open alleenLezen); ze worden na elke vraag gesloten. Namen, IBAN's en bedragen gaan alleen in het antwoord aan Davids app,
 * nooit in een log (de reden noemt alleen het jaar).
 */
const PRAKTIJK = [{ code: 'TG', entiteit: 'tolgaarde', naam: 'Tolgaarde' }, { code: 'GH', entiteit: 'groenhouten', naam: 'Groenhouten' }];
const ZEKERHEID = ['zeker', 'waarschijnlijk', 'david'];
const PAD_RE = /^\/app\/facturen\/waarnemers(?:\/(\d{4}))?$/;
const JAAR_MIN = 2020;

function dagAmsterdam(nu) { return new Date(nu).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
function isoPlus(iso, dagen) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + dagen); return d.toISOString().slice(0, 10); }

/*
 * wv4011 (actieplan 2B43): betalingen uit een betaalbestand (SEPA-batch, pain.001 uit Facturen › Betalen; tabellen sepa_batch en sepa_regel).
 * De bank toont zo'n batch niet per betaling maar per betaalopdracht-blok (PmtInf): één afschrijving zonder tegenrekening, voor precies de som
 * van dat blok, met het blokkenmerk (pmtinf_id) als kenmerk of in de omschrijving (gemeten 25-11-2026: ABN-export en bankluis, 4 van 4 blokken).
 * Een blok met één betaling boekt de bank als gewone overboeking met tegenrekening: die telt al in de gewone rekenregel.
 *
 * Een sepa_regel aan een bekende waarnemersrekening telt mee als
 *   - de batch heel is (aantal en som van zijn regels = sepa_batch.aantal / totaal_centen), en
 *   - er voor zijn blok een batchregel op de bank staat: niet verwijderd, zelfde entiteit en rekening, geen tegenrekening, bedrag = − som van het
 *     blok, kenmerk = pmtinf_id of pmtinf_id in kenmerk/omschrijving (niet gevolgd door een cijfer: "…-1" is geen "…-10"), geboekt op of na de dag
 *     vóór het aanmaken van het bestand; elke batchregel hoort bij hooguit één blok; en
 *   - dezelfde betaling niet al als losse bankregel meetelt (zelfde entiteit, rekening van de waarnemer, bedrag; binnen 5 dagen van de batchregel;
 *     elke losse regel dekt hooguit één sepa_regel).
 * De betaaldatum is de boekdatum van de batchregel (de bank voert een batch soms vóór de gevraagde uitvoerdatum uit: gemeten bij een batch van 30-10).
 * Niet afgeschreven (geen batchregel, of batch niet heel) en ook niet los op de bank (geboekt tussen de dag vóór het aanmaken en 10 dagen na de
 * uitvoerdatum) → "niet geteld" (de teller batch_niet_geteld van de jaaropgaaf, op uitvoerdatum).
 *
 * sepaBetalingen(fac, ibans) → { geteld: [{ entiteit, iban, boekdatum, bedrag_centen (< 0), bank_id, regel_id }], niet: [{ entiteit, iban,
 * uitvoerdatum, centen, regel_id }] } of null als facturen.sqlite (nog) geen sepa-tabellen of batchvelden heeft (niet vast te stellen, geen 0).
 * Puur: alleen SELECT.
 */
const LOS_DAGEN = 5, NA_UITVOER = 10;
function refIn(tekst, ref) {
  const s = String(tekst == null ? '' : tekst);
  for (let i = s.indexOf(ref); i >= 0; i = s.indexOf(ref, i + 1)) if (!/[0-9]/.test(s.charAt(i + ref.length))) return true;
  return false;
}
function sepaBetalingen(fac, ibans) {
  const wn = new Set(ibans);
  let regels, banken;
  try {
    regels = fac.prepare("SELECT b.id AS batch, b.rekening AS rekening, b.entiteit AS entiteit, b.aantal AS aantal, b.totaal_centen AS totaal, substr(b.cre_dt_tm, 1, 10) AS cre,"
      + ' r.id AS rid, r.pmtinf_id AS pmt, r.uitvoerdatum AS uitvoer, r.centen AS centen, r.iban AS iban FROM sepa_regel r JOIN sepa_batch b ON b.id = r.batch'
      + " WHERE b.entiteit IN ('tolgaarde', 'groenhouten') ORDER BY b.cre_dt_tm, b.id, r.pmtinf_id, r.positie, r.id").all();
    banken = fac.prepare('SELECT id, entiteit, rekening, boekdatum, bedrag_centen, kenmerk, omschrijving FROM bank_transactie WHERE verwijderd_op IS NULL'
      + " AND entiteit IN ('tolgaarde', 'groenhouten') AND tegenpartij_iban IS NULL AND bedrag_centen < 0 ORDER BY boekdatum, id").all();
  } catch (e) { return null; }   // oud bestand zonder sepa-tabellen of batchvelden
  const uit = { geteld: [], niet: [] };
  if (!regels.length) return uit;
  // losse bankregels aan waarnemersrekeningen: entiteit|iban|centen → [{ id, d }]
  const los = new Map();
  if (wn.size) {
    const l = [...wn];
    for (const t of fac.prepare('SELECT id, entiteit, tegenpartij_iban AS iban, boekdatum, bedrag_centen FROM bank_transactie WHERE verwijderd_op IS NULL'
      + " AND entiteit IN ('tolgaarde', 'groenhouten') AND bedrag_centen < 0 AND tegenpartij_iban IN (" + l.map(() => '?').join(',') + ') ORDER BY boekdatum, id').all(...l)) {
      const k = t.entiteit + '|' + t.iban + '|' + (-Number(t.bedrag_centen));
      if (!los.has(k)) los.set(k, []);
      los.get(k).push({ id: t.id, d: t.boekdatum });
    }
  }
  const losGebruikt = new Set();
  // de ongebruikte losse regel binnen [van, tot] die het dichtst bij ref ligt (review ronde 2: niet de eerste in de lijst)
  const afstand = (a, b) => Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z'));
  const losDekt = (r, van, tot, ref) => {
    let x = null;
    for (const t of los.get(r.entiteit + '|' + r.iban + '|' + Number(r.centen)) || []) {
      if (losGebruikt.has(t.id) || t.d < van || t.d > tot) continue;
      if (!x || afstand(t.d, ref) < afstand(x.d, ref)) x = t;
    }
    if (x) losGebruikt.add(x.id);
    return !!x;
  };
  // batches en blokken
  const batches = new Map();
  for (const r of regels) {
    let b = batches.get(r.batch);
    if (!b) batches.set(r.batch, b = { aantal: Number(r.aantal), totaal: Number(r.totaal), n: 0, som: 0, blokken: new Map() });
    b.n++; b.som += Number(r.centen);
    if (!b.blokken.has(r.pmt)) b.blokken.set(r.pmt, []);
    b.blokken.get(r.pmt).push(r);
  }
  // stap 1: per blok de batchregel op de bank
  const bankGebruikt = new Set(), blokken = [];
  for (const b of batches.values()) {
    const heel = b.n === b.aantal && b.som === b.totaal;   // som-toets per batch
    for (const [pmt, rs] of b.blokken) {
      const eerste = rs[0], som = rs.reduce((s, r) => s + Number(r.centen), 0);
      const vroegst = isoPlus(eerste.cre, -1);
      const bank = heel && banken.find((t) => !bankGebruikt.has(t.id) && t.entiteit === eerste.entiteit && t.rekening === eerste.rekening
        && Number(t.bedrag_centen) === -som && t.boekdatum >= vroegst && (t.kenmerk === pmt || refIn(t.kenmerk, pmt) || refIn(t.omschrijving, pmt)));
      if (bank) bankGebruikt.add(bank.id);
      blokken.push({ rs, bank: bank || null, vroegst });
    }
  }
  // stap 2: eerst de afgeschreven blokken ontdubbelen tegen losse bankregels, pas daarna de niet afgeschreven blokken (review MOET 1: anders kan
  // een oud, niet uitgevoerd bestand de losse regel verbruiken die een later, wél uitgevoerd bestand moet ontdubbelen → dubbel geteld)
  // afgeschreven blokken op volgorde van hun boekdatum (review ronde 2)
  for (const k of blokken.filter((x) => x.bank).sort((a, b) => (a.bank.boekdatum < b.bank.boekdatum ? -1 : a.bank.boekdatum > b.bank.boekdatum ? 1 : 0))) {
    for (const r of k.rs) {
      if (!wn.has(r.iban)) continue;
      if (losDekt(r, isoPlus(k.bank.boekdatum, -LOS_DAGEN), isoPlus(k.bank.boekdatum, LOS_DAGEN), k.bank.boekdatum)) continue;   // telt al als losse bankregel
      uit.geteld.push({ entiteit: r.entiteit, iban: r.iban, boekdatum: k.bank.boekdatum, bedrag_centen: -Number(r.centen), bank_id: k.bank.id, regel_id: r.rid });
    }
  }
  for (const k of blokken) {
    if (k.bank) continue;
    for (const r of k.rs) {
      if (!wn.has(r.iban) || losDekt(r, k.vroegst, isoPlus(r.uitvoer, NA_UITVOER), r.uitvoer)) continue;
      uit.niet.push({ entiteit: r.entiteit, iban: r.iban, uitvoerdatum: r.uitvoer, centen: Number(r.centen), regel_id: r.rid });
    }
  }
  return uit;
}

/* totaal(dp, fac, jaar, nu[, sepa]) → { jaar, berekend_op, praktijken: [...], jaren }. dp/fac = node:sqlite-verbindingen (prepare().all()).
 * wv4011: betalingen uit een betaalbestand tellen mee (sepaBetalingen; sepa = al berekende uitkomst, anders hier berekend); per betaling
 * bron 'bank' of 'betaalbestand', per praktijk batch_n (zoveel betalingen uit een betaalbestand tellen mee). */
function totaal(dp, fac, jaar, nu, sepa) {
  const rek = new Map();
  for (const r of dp.prepare('SELECT iban, object_id, zekerheid FROM rekening').all()) rek.set(r.iban, { oid: r.object_id, zekerheid: r.zekerheid });
  const personen = new Map(dp.prepare('SELECT object_id, naam, per_id FROM persoon').all().map((r) => [r.object_id, r]));
  const rollen = new Set(dp.prepare('SELECT object_id, praktijk FROM rol').all().map((r) => r.object_id + '|' + r.praktijk));
  const tm = new Map(fac.prepare("SELECT entiteit, max(boekdatum) AS d FROM bank_transactie WHERE verwijderd_op IS NULL AND entiteit IN ('tolgaarde', 'groenhouten') GROUP BY entiteit").all()
    .map((r) => [r.entiteit, r.d]));
  const ibans = [...rek.keys()];
  const uit = new Map();
  if (ibans.length) {
    const q = 'SELECT entiteit, tegenpartij_iban AS iban, boekdatum, bedrag_centen FROM bank_transactie WHERE verwijderd_op IS NULL'
      + " AND entiteit IN ('tolgaarde', 'groenhouten') AND boekdatum >= ? AND boekdatum < ? AND tegenpartij_iban IN (" + ibans.map(() => '?').join(',') + ')'
      + ' ORDER BY boekdatum DESC, id';
    const van = jaar + '-01-01', tot = (Number(jaar) + 1) + '-01-01';
    if (sepa === undefined) sepa = sepaBetalingen(fac, ibans);
    const extra = (sepa ? sepa.geteld : []).filter((x) => x.boekdatum >= van && x.boekdatum < tot)
      .map((x) => ({ entiteit: x.entiteit, iban: x.iban, boekdatum: x.boekdatum, bedrag_centen: x.bedrag_centen, bron: 'betaalbestand' }));
    for (const t of fac.prepare(q).all(van, tot, ...ibans).concat(extra)) {
      const k = rek.get(t.iban);
      const code = t.entiteit === 'tolgaarde' ? 'TG' : 'GH';
      const sl = k.oid + '|' + code;
      let r = uit.get(sl);
      if (!r) uit.set(sl, r = { oid: k.oid, code, af_centen: 0, af_n: 0, terug_centen: 0, terug_n: 0, laatste: null, batch_n: 0, rekeningen: new Map(), betalingen: [] });
      const cent = Number(t.bedrag_centen);
      if (cent < 0) { r.af_centen -= cent; r.af_n++; if (!r.laatste || t.boekdatum > r.laatste) r.laatste = t.boekdatum; }
      else { r.terug_centen += cent; r.terug_n++; }
      if (t.bron === 'betaalbestand') r.batch_n++;
      r.rekeningen.set(t.iban, k.zekerheid);
      r.betalingen.push({ datum: t.boekdatum, bedrag_centen: cent, iban: t.iban, bron: t.bron || 'bank' });
    }
  }
  const praktijken = PRAKTIJK.map((p) => {
    const rijen = [...uit.values()].filter((r) => r.code === p.code).sort((a, b) => b.af_centen - a.af_centen || String(personen.get(a.oid).naam).localeCompare(personen.get(b.oid).naam, 'nl'))
      .map((r) => {
        const rekeningen = [...r.rekeningen].map(([iban, z]) => ({ iban, zekerheid: ZEKERHEID.includes(z) ? z : 'waarschijnlijk' }));
        // de zwakste koppeling telt voor de persoon (waarschijnlijk < zeker < david = door David bevestigd)
        const koppeling = rekeningen.some((x) => x.zekerheid === 'waarschijnlijk') ? 'waarschijnlijk' : rekeningen.some((x) => x.zekerheid === 'zeker') ? 'zeker' : 'david';
        r.betalingen.sort((a, b) => (a.datum < b.datum ? 1 : a.datum > b.datum ? -1 : 0));   // nieuwste eerst, zoals de bankvraag
        return { object_id: r.oid, naam: personen.get(r.oid).naam, af_n: r.af_n, af_centen: r.af_centen, laatste: r.laatste, terug_n: r.terug_n, terug_centen: r.terug_centen,
          koppeling, rekeningen, rol: rollen.has(r.oid + '|' + p.code), betalingen: r.betalingen, batch_n: r.batch_n };
      });
    return { code: p.code, entiteit: p.entiteit, naam: p.naam, tm_bankdag: tm.get(p.entiteit) || null, personen: rijen, n_personen: rijen.length,
      som_centen: rijen.reduce((s, r) => s + r.af_centen, 0), af_n: rijen.reduce((s, r) => s + r.af_n, 0),
      terug_centen: rijen.reduce((s, r) => s + r.terug_centen, 0), terug_n: rijen.reduce((s, r) => s + r.terug_n, 0),
      batch_n: rijen.reduce((s, r) => s + r.batch_n, 0) };
  });
  const dit = Number(dagAmsterdam(nu).slice(0, 4));
  const jaren = [];
  for (let j = Math.max(2026, JAAR_MIN); j <= dit; j++) jaren.push(String(j));
  return { jaar: String(jaar), berekend_op: new Date(nu).toISOString(), praktijken, jaren, n_rekeningen: ibans.length };
}

/*
 * maak({ openDocplan() → db | null (geen bestand), openFacturen() → { db, sluit() } }) → { app(verzoek) }.
 * verzoek = { methode, pad, rol, primair, nu } → { status, j, reden }. Alleen GET, alleen de eigenaar, alleen op de primaire kant.
 */
function maak(o) {
  o = o || {};
  function app(v) {
    const nu = Number.isFinite(v.nu) ? v.nu : Date.now();
    const m = v.methode === 'GET' ? PAD_RE.exec(String(v.pad || '')) : null;
    if (!m) return { status: 404, j: { ok: false, fout: 'onbekend' }, reden: 'waarnemers onbekend' };
    if (!v.rol || v.rol.soort !== 'eigenaar' || v.rol.ingang !== 'app') return { status: 403, j: { ok: false, fout: 'alleen de eigenaar' }, reden: 'waarnemers geweigerd' };
    if (v.primair !== true) return { status: 409, j: { ok: false, fout: 'Facturen draait alleen op de primaire kant' }, reden: 'waarnemers niet primair' };
    const jaar = m[1] || dagAmsterdam(nu).slice(0, 4);
    if (Number(jaar) < JAAR_MIN || Number(jaar) > Number(dagAmsterdam(nu).slice(0, 4))) return { status: 400, j: { ok: false, fout: 'jaar buiten bereik' }, reden: 'waarnemers jaar' };
    let dp = null, fac = null;
    try {
      dp = o.openDocplan();
      if (!dp) return { status: 200, j: { ok: true, leeg: true, jaar, praktijken: [], jaren: [jaar] }, reden: 'waarnemers leeg' };
      fac = o.openFacturen();
      if (!fac) return { status: 503, j: { ok: false, fout: 'de facturendatabase is nu niet te openen' }, reden: 'waarnemers facturen dicht' };
      return { status: 200, j: Object.assign({ ok: true }, totaal(dp, fac.db, jaar, nu)), reden: 'waarnemers ' + jaar };
    } catch (e) {
      if (typeof o.fout === 'function') o.fout('waarnemers', e);
      return { status: 503, j: { ok: false, fout: 'de waarnemerslijst is nu niet te lezen' }, reden: 'waarnemers fout' };
    } finally {
      try { if (dp) dp.close(); } catch (e) { /* al dicht */ }
      try { if (fac) fac.sluit(); } catch (e) { /* al dicht */ }
    }
  }
  return { app };
}

module.exports = { maak, totaal, sepaBetalingen, PAD_RE };
