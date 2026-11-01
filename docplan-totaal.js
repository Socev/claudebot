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

/* totaal(dp, fac, jaar, nu) → { jaar, berekend_op, praktijken: [...], jaren }. dp/fac = node:sqlite-verbindingen (prepare().all()). */
function totaal(dp, fac, jaar, nu) {
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
    for (const t of fac.prepare(q).all(jaar + '-01-01', (Number(jaar) + 1) + '-01-01', ...ibans)) {
      const k = rek.get(t.iban);
      const code = t.entiteit === 'tolgaarde' ? 'TG' : 'GH';
      const sl = k.oid + '|' + code;
      let r = uit.get(sl);
      if (!r) uit.set(sl, r = { oid: k.oid, code, af_centen: 0, af_n: 0, terug_centen: 0, terug_n: 0, laatste: null, rekeningen: new Map(), betalingen: [] });
      const cent = Number(t.bedrag_centen);
      if (cent < 0) { r.af_centen -= cent; r.af_n++; if (!r.laatste || t.boekdatum > r.laatste) r.laatste = t.boekdatum; }
      else { r.terug_centen += cent; r.terug_n++; }
      r.rekeningen.set(t.iban, k.zekerheid);
      r.betalingen.push({ datum: t.boekdatum, bedrag_centen: cent, iban: t.iban });
    }
  }
  const praktijken = PRAKTIJK.map((p) => {
    const rijen = [...uit.values()].filter((r) => r.code === p.code).sort((a, b) => b.af_centen - a.af_centen || String(personen.get(a.oid).naam).localeCompare(personen.get(b.oid).naam, 'nl'))
      .map((r) => {
        const rekeningen = [...r.rekeningen].map(([iban, z]) => ({ iban, zekerheid: ZEKERHEID.includes(z) ? z : 'waarschijnlijk' }));
        // de zwakste koppeling telt voor de persoon (waarschijnlijk < zeker < david = door David bevestigd)
        const koppeling = rekeningen.some((x) => x.zekerheid === 'waarschijnlijk') ? 'waarschijnlijk' : rekeningen.some((x) => x.zekerheid === 'zeker') ? 'zeker' : 'david';
        return { object_id: r.oid, naam: personen.get(r.oid).naam, af_n: r.af_n, af_centen: r.af_centen, laatste: r.laatste, terug_n: r.terug_n, terug_centen: r.terug_centen,
          koppeling, rekeningen, rol: rollen.has(r.oid + '|' + p.code), betalingen: r.betalingen };
      });
    return { code: p.code, entiteit: p.entiteit, naam: p.naam, tm_bankdag: tm.get(p.entiteit) || null, personen: rijen, n_personen: rijen.length,
      som_centen: rijen.reduce((s, r) => s + r.af_centen, 0), af_n: rijen.reduce((s, r) => s + r.af_n, 0),
      terug_centen: rijen.reduce((s, r) => s + r.terug_centen, 0), terug_n: rijen.reduce((s, r) => s + r.terug_n, 0) };
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

module.exports = { maak, totaal, PAD_RE };
