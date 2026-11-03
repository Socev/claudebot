'use strict';
/*
 * DocPlan — vaste controle rooster ↔ betaling (wv2293, 3-11-2026; idee 25 meetpunt 4; vault "01_Ontwikkeling/OVIS DocPlan - ontwerp
 * (31-10-2026).md" § 8.1). David 31-10 ± 22:55: "Alle vermeldingen in de planningsagenda's van Groenhouten en Tolgaarde moeten koppelbaar zijn
 * uiteindelijk aan een factuur, meteen mooie check." Draait na elke bankronde (server.js bankRonde → docplanControleRonde) en zet per praktijk:
 *
 *  (a) dienst_zonder_betaling   een waarnemer (waarneemrol bij die praktijk in docplan.sqlite) heeft dagen in maand M (vanaf 2026) en tussen
 *                               1 M en einde M + 75 dagen staat er geen afschrijving van die praktijk aan zijn rekening(en) en geen factuur
 *                               (Facturen-app: status niet geen_factuur/dubbel; FV2-archief: niet geen_factuur/genegeerd) met zijn IBAN; alleen als de bank van die
 *                               praktijk al voorbij einde M + 75 is. Eén signaal per (persoon, praktijk, maand).
 *  (b) betaling_zonder_dienst   een afschrijving (vanaf 2026) van de praktijk aan een rekening die docplan.sqlite aan een persoon koppelt,
 *                               zonder dag van die persoon in het rooster van die praktijk in de maanden van (boekdatum − 120 d) t/m de
 *                               boekdatum. Eén signaal per bankregel. Facturen zonder betaling tellen hier niet (komt met de factuurtoets).
 *  (c) roosternaam_zonder_koppeling  een roosternaam met dagen in het jaar (2026 t/m dit jaar) zonder alias of met status nieuw. Eén per
 *                               (praktijk, naam, jaar).
 *
 * Signalen staan in Facturen (tabel signaal, migratie 17) in dezelfde vorm als de bankcontrole: alleen de eigenaar, knop "Wegzetten (met reden)".
 * Zelfde sleutel = nooit twee keer (ON CONFLICT DO NOTHING). Is de oorzaak weg (betaling binnen, naam gekoppeld), dan sluit deze controle het
 * open signaal zelf (afhandeling vanzelf_opgelost, wie docplan-controle, auditrij); komt de oorzaak terug, dan gaat alleen zo'n vanzelf gesloten
 * signaal weer open, nooit een signaal dat David wegzette. Nooit een bericht aan een waarnemer; geen naam, IBAN of bedrag in een log.
 *
 * Puur waar het kan: controle() rekent alleen; schrijf() krijgt de facturendatabase mee. Invoer: maanden = public.sb_dienst_maanden(van)
 * (0021), lijsten = public.sb_dienst_alias_lijst(jaar) per jaar, dp = docplan.sqlite (readOnly), fac = facturen.sqlite.
 */
const crypto = require('crypto');
const B = require('./facturen-bank');

const PRAKTIJK = { TG: { entiteit: 'tolgaarde', naam: 'Tolgaarde' }, GH: { entiteit: 'groenhouten', naam: 'Groenhouten' } };
const SOORTEN = ['dienst_zonder_betaling', 'betaling_zonder_dienst', 'roosternaam_zonder_koppeling'];
const VAN_JAAR = 2026;        // de controle begint bij 1-1-2026 (ontwerp § 8.1; 2025 is de leesproef)
const NA_DAGEN = 75;          // (a) betaling verwacht binnen de maand + 75 dagen
const TERUG_DAGEN = 120;      // (b) dienst in de vier maanden vóór de betaling
const WIE = 'docplan-controle';

function isoPlus(iso, dagen) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + dagen); return d.toISOString().slice(0, 10); }
function maandEinde(m) { const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7)); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); }
function hash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }
function dagAmsterdam(nu) { return new Date(nu).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
/* Vroegste dag waarvoor de maanden nodig zijn: (b) kijkt 120 dagen terug vanaf 1-1 van het eerste jaar. */
function maandenVanaf() { return isoPlus(VAN_JAAR + '-01-01', -TERUG_DAGEN).slice(0, 8) + '01'; }

/*
 * controle({ maanden, lijsten, dp, fac, nu }) → { signalen, tel }. Gooit bij ontbrekende invoer (dan schrijft de ronde niets en sluit niets).
 * maanden: [{pr, obj, maand, dagen}]; lijsten: [{jaar, praktijken:[{code, namen:[{naam, dagen, status}]}]}].
 */
function controle(o) {
  if (!Array.isArray(o.maanden) || !o.maanden.length) throw new Error('geen roostermaanden');
  if (!Array.isArray(o.lijsten) || !o.lijsten.length || o.lijsten.some((l) => !l || !Array.isArray(l.praktijken) || !l.praktijken.length)) throw new Error('geen roosternamenlijst');
  const { dp, fac } = o;
  const vandaag = dagAmsterdam(o.nu);
  const dagen = new Map();   // pr|obj|maand → dagen
  for (const r of o.maanden) {
    if (!PRAKTIJK[r.pr]) continue;
    const k = r.pr + '|' + r.obj + '|' + r.maand;
    dagen.set(k, (dagen.get(k) || 0) + Number(r.dagen || 0));
  }
  const naam = new Map(dp.prepare('SELECT object_id, naam FROM persoon').all().map((r) => [r.object_id, r.naam]));
  const rol = new Set(dp.prepare('SELECT object_id, praktijk FROM rol').all().map((r) => r.object_id + '|' + r.praktijk));
  const ibanVan = new Map(dp.prepare('SELECT iban, object_id FROM rekening').all().map((r) => [r.iban, r.object_id]));
  const ibans = [...ibanVan.keys()];
  const tm = new Map(fac.prepare("SELECT entiteit, max(boekdatum) AS d FROM bank_transactie WHERE verwijderd_op IS NULL AND entiteit IN ('tolgaarde', 'groenhouten') GROUP BY entiteit").all()
    .map((r) => [r.entiteit, r.d]));
  const codeVan = (ent) => (ent === 'tolgaarde' ? 'TG' : 'GH');
  const bet = new Map();   // pr|obj → [{datum, id, centen}]
  const fd = new Map();    // pr|obj → [factuurdatum]
  const zet = (m, k, v) => { let l = m.get(k); if (!l) m.set(k, l = []); l.push(v); };
  if (ibans.length) {
    const ph = ibans.map(() => '?').join(',');
    for (const t of fac.prepare("SELECT id, entiteit, tegenpartij_iban AS iban, boekdatum, bedrag_centen FROM bank_transactie WHERE verwijderd_op IS NULL AND bedrag_centen < 0" +
      " AND entiteit IN ('tolgaarde', 'groenhouten') AND boekdatum >= ? AND tegenpartij_iban IN (" + ph + ')').all(VAN_JAAR + '-01-01', ...ibans)) {
      zet(bet, codeVan(t.entiteit) + '|' + ibanVan.get(t.iban), { datum: t.boekdatum, id: t.id, centen: Number(t.bedrag_centen) });
    }
    const fq = (tabel, extra) => fac.prepare('SELECT entiteit, iban, factuurdatum FROM ' + tabel + " WHERE entiteit IN ('tolgaarde', 'groenhouten') AND factuurdatum IS NOT NULL" +
      extra + ' AND iban IN (' + ph + ')').all(...ibans);
    // review MOET 2: alleen echte facturen; archief (FV2) kent beslist / geen_factuur / genegeerd (gemeten 3-11-2026)
    for (const f of fq('factuur', " AND status NOT IN ('geen_factuur', 'dubbel')").concat(fq('factuur_archief', " AND status NOT IN ('geen_factuur', 'genegeerd')"))) {
      zet(fd, codeVan(f.entiteit) + '|' + ibanVan.get(f.iban), String(f.factuurdatum).slice(0, 10));
    }
  }
  const signalen = [];
  const tel = { TG: { a: 0, b: 0, c: 0, beoordeeld: 0 }, GH: { a: 0, b: 0, c: 0, beoordeeld: 0 } };
  // (a) dienst zonder betaling of factuur
  for (const [k, n] of dagen) {
    const [pr, obj, m] = k.split('|');
    if (n <= 0 || Number(m.slice(0, 4)) < VAN_JAAR || !rol.has(obj + '|' + pr)) continue;
    const bankTm = tm.get(PRAKTIJK[pr].entiteit);
    const tot = isoPlus(maandEinde(m), NA_DAGEN);
    if (!bankTm || tot > bankTm) continue;
    tel[pr].beoordeeld++;
    const van = m + '-01';
    const binnen = (d) => d >= van && d <= tot;
    if ((bet.get(pr + '|' + obj) || []).some((x) => binnen(x.datum)) || (fd.get(pr + '|' + obj) || []).some(binnen)) continue;
    tel[pr].a++;
    signalen.push(B.maakSignaal('dienst_zonder_betaling', { entiteit: PRAKTIJK[pr].entiteit, naam: naam.get(obj) || 'onbekende persoon', alleen_eigenaar: true,
      sleutel_vast: obj + '|' + pr + '|' + m,
      details: { regel: 'a', persoon: obj, praktijk: pr, praktijk_naam: PRAKTIJK[pr].naam, maand: m, dagen: n, venster_tot: tot, bank_tm: bankTm } }));
  }
  // (b) betaling zonder dienst in de 120 dagen ervoor (op maandniveau: de maanden van boekdatum − 120 t/m de boekdatum)
  for (const [k, l] of bet) {
    const [pr, obj] = k.split('|');
    for (const x of l) {
      const van = isoPlus(x.datum, -TERUG_DAGEN);
      let m = van.slice(0, 7), dienst = false;
      while (m <= x.datum.slice(0, 7)) {
        if ((dagen.get(pr + '|' + obj + '|' + m) || 0) > 0) { dienst = true; break; }
        m = isoPlus(m + '-01', 32).slice(0, 7);
      }
      if (dienst) continue;
      tel[pr].b++;
      signalen.push(B.maakSignaal('betaling_zonder_dienst', { entiteit: PRAKTIJK[pr].entiteit, naam: naam.get(obj) || 'onbekende persoon', alleen_eigenaar: true,
        transacties: [x.id], bedrag_centen: x.centen,
        details: { regel: 'b', persoon: obj, praktijk: pr, praktijk_naam: PRAKTIJK[pr].naam, datum: x.datum, venster_van: van } }));
    }
  }
  // (c) roosternaam zonder koppeling (geen alias, of David vroeg een nieuwe persoon die er nog niet is)
  for (const l of o.lijsten) {
    for (const p of l.praktijken) {
      if (!PRAKTIJK[p.code]) continue;
      for (const n of Array.isArray(p.namen) ? p.namen : []) {
        if (!(Number(n.dagen) > 0) || (n.status != null && n.status !== 'nieuw')) continue;
        tel[p.code].c++;
        signalen.push(B.maakSignaal('roosternaam_zonder_koppeling', { entiteit: PRAKTIJK[p.code].entiteit, naam: String(n.naam).slice(0, 200), alleen_eigenaar: true,
          sleutel_vast: p.code + '|' + hash(n.naam) + '|' + l.jaar,
          details: { regel: 'c', praktijk: p.code, praktijk_naam: PRAKTIJK[p.code].naam, roosternaam: String(n.naam).slice(0, 200), dagen: Number(n.dagen),
            jaar: Number(l.jaar), status: n.status || null } }));
      }
    }
  }
  return { signalen, tel, vandaag };
}

/*
 * schrijf(fdb, D, uitkomst, wanneer) → { nieuw, vanzelf_dicht, heropend, open }. Eén transactie (D.transactie). fdb = facturen-db-verbinding.
 */
function schrijf(fdb, D, u, wanneer) {
  return D.transactie(fdb, () => {
    const t = { nieuw: 0, vanzelf_dicht: 0, heropend: 0, open: 0 };
    const nu = new Set(u.signalen.map((s) => s.sleutel));
    const ins = fdb.db.prepare('INSERT INTO signaal (id, sleutel, soort, titel, entiteit, leverancier, transacties, facturen, bedrag_centen, details, alleen_eigenaar, aangemaakt_op) ' +
      'VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1, ?) ON CONFLICT (sleutel) DO NOTHING');
    const heropen = fdb.db.prepare("UPDATE signaal SET status = 'open', afhandeling = NULL, les = NULL, wie = NULL, wanneer = NULL, details = ? " +
      "WHERE sleutel = ? AND status = 'afgehandeld' AND afhandeling = 'vanzelf_opgelost'");
    for (const s of u.signalen) {
      const details = JSON.stringify(Object.assign({ naam: s.naam }, s.details));
      const n = ins.run(D.nieuwId(), s.sleutel, s.soort, s.titel, s.entiteit, JSON.stringify(s.transacties || []), JSON.stringify(s.facturen || []),
        s.bedrag_centen == null ? null : s.bedrag_centen, details, wanneer).changes;
      if (n) { t.nieuw += n; continue; }
      const h = heropen.run(details, s.sleutel).changes;
      if (h) {
        t.heropend += h;
        const r = fdb.db.prepare('SELECT id, entiteit FROM signaal WHERE sleutel = ?').get(s.sleutel);
        D.audit(fdb, { wie: WIE, wat: 'signaal_heropend', object_soort: 'signaal', object_id: r.id, entiteit: r.entiteit, voor: { status: 'afgehandeld' },
          na: { status: 'open', soort: s.soort }, wanneer });
      }
    }
    const dicht = fdb.db.prepare("UPDATE signaal SET status = 'afgehandeld', afhandeling = 'vanzelf_opgelost', wie = ?, wanneer = ?, sluimer_tot = NULL WHERE id = ? AND status = 'open'");
    for (const s of fdb.db.prepare("SELECT id, sleutel, soort, entiteit FROM signaal WHERE status = 'open' AND soort IN (" + SOORTEN.map(() => '?').join(',') + ')').all(...SOORTEN)) {
      if (nu.has(s.sleutel)) { t.open++; continue; }
      if (!dicht.run(WIE, wanneer, s.id).changes) continue;
      t.vanzelf_dicht++;
      D.audit(fdb, { wie: WIE, wat: 'signaal_vanzelf_opgelost', object_soort: 'signaal', object_id: s.id, entiteit: s.entiteit, voor: { status: 'open' },
        na: { status: 'afgehandeld', soort: s.soort }, wanneer });
    }
    return t;
  });
}

/* jaren(nu) → de jaren waarvoor (c) de roosternamenlijst vraagt: 2026 t/m dit jaar. */
function jaren(nu) { const j = []; for (let x = VAN_JAAR; x <= Number(dagAmsterdam(nu).slice(0, 4)); x++) j.push(x); return j; }

module.exports = { controle, schrijf, jaren, maandenVanaf, SOORTEN, VAN_JAAR, NA_DAGEN, TERUG_DAGEN };
