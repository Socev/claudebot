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
 *  (f) factuur_dagen_afwijkend  (wv2297, meetpunt 5; ontwerp § 4.2) een factuur in de Facturen-app (vanaf 2026, niet geen_factuur/dubbel, geen
 *                               creditnota) met een IBAN dat docplan.sqlite aan een persoon koppelt: de werkdagen uit de factuurtekst (pdftotext, regels
 *                               met een datum en een bedrag, reiskosten niet) moeten elk in het rooster van die persoon bij die praktijk staan
 *                               (public.sb_dienst_dagen, 0022). Geen dagen maar wel een maand ("waarneming oktober 2026"): die maand moet dagen
 *                               hebben; niets van beide: de factuurmaand of de maand ervoor (anders "niet te beoordelen", geen signaal).
 *                               Eén signaal per factuur (knop Open factuur in de app). Nooit een blokkade, nooit een bericht aan de waarnemer.
 *
 * Signalen staan in Facturen (tabel signaal, migratie 17; f: migratie 18) in dezelfde vorm als de bankcontrole: alleen de eigenaar, knop "Wegzetten (met reden)".
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
const SOORTEN = ['dienst_zonder_betaling', 'betaling_zonder_dienst', 'roosternaam_zonder_koppeling', 'factuur_dagen_afwijkend'];
const FACTUUR_SOORT = 'factuur_dagen_afwijkend';
const FACTUUR_MAX = 300;      // hooguit zoveel waarnemersfacturen per ronde (pdftotext per stuk)
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

// ───────────────────────────── factuurtoets (f, wv2297) ─────────────────────────────
const MND = { jan: 1, januari: 1, feb: 2, februari: 2, mrt: 3, mar: 3, maart: 3, apr: 4, april: 4, mei: 5, may: 5, jun: 6, juni: 6, jul: 7, juli: 7,
  aug: 8, augustus: 8, sep: 9, sept: 9, september: 9, okt: 10, oct: 10, oktober: 10, nov: 11, november: 11, dec: 12, december: 12 };
const MND_RE = 'januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|jan|feb|mrt|mar|apr|may|jun|jul|aug|sept|sep|okt|oct|nov|dec';
// regels die geen werkdag zijn: kopdatums, betaaltekst, reiskosten
const GEEN_DAGREGEL = /factuurdatum|vervaldatum|uiterlijk|dagtekening|datering|reiskost|kilomet|\bkm\b|betaal|gelieve|kvk|iban|debiteur/i;
const BEDRAG = /€|(^|[^\d])\d{1,5}[.,]\d{2}(?![\d])/;
function geldig(y, m, d) {
  if (!(y >= 2000 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const x = new Date(Date.UTC(y, m - 1, d));
  return x.getUTCMonth() === m - 1 ? x.toISOString().slice(0, 10) : null;
}
const jaar4 = (y) => (y.length === 2 ? 2000 + Number(y) : Number(y));
/*
 * dagenUitTekst(tekst, factuurdatum) → { datums: [iso…], maanden: ['YYYY-MM'…] }. Puur. Werkdag = datum op een regel met een bedrag (€ of 12,50)
 * die geen kop-, betaal- of reiskostenregel is; vormen 22-10-2026, 1/10/26, 22 oktober 2026, 1/nov/26 en (zonder jaar) 5-10, het jaar dan
 * van de factuurdatum (of het jaar ervoor als de dag anders na de factuurdatum + 31 valt). Alleen dagen van factuurdatum − 400 t/m + 31.
 * Maand = "oktober 2026" of "in oktober" zonder dag ervoor, op een regel die geen kop/betaalregel is (alleen gebruikt als er geen dagen zijn).
 */
function dagenUitTekst(tekst, factuurdatum) {
  const uit = { datums: [], maanden: [] };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(factuurdatum || ''))) return uit;
  const fy = Number(factuurdatum.slice(0, 4)), laag = isoPlus(factuurdatum, -400), hoog = isoPlus(factuurdatum, 31);
  const zonderJaar = (m, d) => { let x = geldig(fy, m, d); if (x && x > hoog) x = geldig(fy - 1, m, d); return x; };
  const ds = new Set(), ms = new Set();
  for (const regel of String(tekst || '').split('\n')) {
    if (!regel.trim() || GEEN_DAGREGEL.test(regel)) continue;
    const r = regel.toLowerCase();
    const hier = [];
    let m;
    const vol = /(?<![\d:\/.,-])(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4}|\d{2})(?![\d:\/.,-])/g;
    while ((m = vol.exec(r))) hier.push(geldig(jaar4(m[3]), Number(m[2]), Number(m[1])));
    const tk = new RegExp('(?<![\\d:\\/.,-])(\\d{1,2})[\\s\\/-]+(' + MND_RE + ')\\.?[\\s\\/-]+(\\d{4}|\\d{2})(?![\\d])', 'g');
    while ((m = tk.exec(r))) hier.push(geldig(jaar4(m[3]), MND[m[2]], Number(m[1])));
    if (!hier.length) {
      const kort = /(?<![\d:\/.,-])(\d{1,2})-(\d{1,2})(?![\d:\/.,-])/g;
      while ((m = kort.exec(r))) hier.push(zonderJaar(Number(m[2]), Number(m[1])));
    }
    const goed = hier.filter((x) => x && x >= laag && x <= hoog);
    // review MOET 3: het bedrag zoeken in de regel zónder datums (anders telt "01.10" van 01.10.2026 als bedrag)
    const zonderDatum = r.replace(vol, ' ').replace(tk, ' ').replace(/(?<![\d:\/.,-])\d{1,2}-\d{1,2}(?![\d:\/.,-])/g, ' ');
    if (goed.length && BEDRAG.test(zonderDatum)) { for (const x of goed) ds.add(x); continue; }
    if (hier.some(Boolean)) continue;   // een datumregel zonder bedrag (kop, dagtekening) zegt niets over de periode
    const mm = new RegExp('(?<![\\d]\\s*)\\b(' + MND_RE.split('|').filter((w) => w.length > 3 || w === 'mei').join('|') + ')\\b(?:\\s+(\\d{4}))?', 'g');
    while ((m = mm.exec(r))) {
      const mo = MND[m[1]];
      if (!m[2] && !/waarne|gewerkt|dienst|periode|maand/.test(r)) continue;   // losse maandnaam zonder jaar alleen in een periodezin
      let y = m[2] ? Number(m[2]) : fy;
      if (!m[2] && y + '-' + String(mo).padStart(2, '0') > factuurdatum.slice(0, 7)) y--;
      const k = y + '-' + String(mo).padStart(2, '0');
      if (k + '-01' >= laag.slice(0, 8) + '01' && k + '-01' <= hoog) ms.add(k);
    }
  }
  uit.datums = [...ds].sort();
  uit.maanden = [...ms].sort();
  return uit;
}
function maandTerug(m) { return isoPlus(m + '-01', -1).slice(0, 7); }
/*
 * factuurOordeel({ pr, obj, factuurdatum }, uit, dagSet, maandDagen) → { oordeel: 'klopt'|'afwijkend'|'onbekend', vorm, … }. Puur.
 * dagSet: Map pr|obj → Set(iso); maandDagen: Map pr|obj|maand → dagen.
 */
function factuurOordeel(k, uit, dagSet, maandDagen) {
  const sleutel = k.pr + '|' + k.obj;
  if (uit.datums.length) {
    const r = dagSet.get(sleutel) || new Set();
    const mis = uit.datums.filter((d) => !r.has(d));
    return { oordeel: mis.length ? 'afwijkend' : 'klopt', vorm: 'dagen', aantal: uit.datums.length, mis, maanden: [...new Set(uit.datums.map((d) => d.slice(0, 7)))] };
  }
  const fm = k.factuurdatum.slice(0, 7);
  const vorm = uit.maanden.length ? 'maand' : 'factuurmaand';
  const maanden = uit.maanden.length ? uit.maanden : [maandTerug(fm), fm];
  const n = maanden.reduce((s, m) => s + (maandDagen.get(sleutel + '|' + m) || 0), 0);
  if (!(n > 0)) return { oordeel: 'afwijkend', vorm, maanden, dagen: 0 };
  return { oordeel: vorm === 'maand' ? 'klopt' : 'onbekend', vorm, maanden, dagen: n };
}
/*
 * factuurKandidaten(fac, dp) → [{ id, entiteit, pr, obj, factuurdatum, nummer, incl, sha256, soort }], hooguit FACTUUR_MAX + 1 (meer dan MAX = de
 * lijst is afgekapt: controle beoordeelt dan de nieuwste MAX en laat open signalen van de rest staan). Facturen-app (geen archief: dat heeft
 * geen stuk op de pod), vanaf 2026, echte facturen (niet geen_factuur/dubbel, geen creditnota), IBAN aan een persoon in docplan.sqlite.
 */
function factuurKandidaten(fac, dp) {
  const ibanVan = new Map(dp.prepare('SELECT iban, object_id FROM rekening').all().map((r) => [r.iban, r.object_id]));
  if (!ibanVan.size) return [];
  const ibans = [...ibanVan.keys()];
  return fac.prepare("SELECT f.id, f.entiteit, f.iban, f.factuurdatum, f.nummer, f.incl, d.sha256, d.soort FROM factuur f JOIN document d ON d.id = f.document" +
    " WHERE f.entiteit IN ('tolgaarde', 'groenhouten') AND f.status NOT IN ('geen_factuur', 'dubbel') AND f.soort = 'factuur' AND f.factuurdatum >= ?" +
    ' AND f.iban IN (' + ibans.map(() => '?').join(',') + ') ORDER BY f.factuurdatum DESC, f.id LIMIT ' + (FACTUUR_MAX + 1)).all(VAN_JAAR + '-01-01', ...ibans)
    .map((f) => ({ id: f.id, entiteit: f.entiteit, pr: f.entiteit === 'tolgaarde' ? 'TG' : 'GH', obj: ibanVan.get(f.iban), factuurdatum: f.factuurdatum,
      nummer: f.nummer || null, incl: f.incl == null ? null : Number(f.incl), sha256: f.sha256, soort: f.soort }));
}

/*
 * controle({ maanden, lijsten, dp, fac, nu[, dagen, facturen] }) → { signalen, tel, behoud }. Gooit bij ontbrekende invoer (dan schrijft de ronde niets en sluit niets).
 * maanden: [{pr, obj, maand, dagen}]; lijsten: [{jaar, praktijken:[{code, namen:[{naam, dagen, status}]}]}].
 * dagen (f): [{pr, obj, datum, dagen}] uit sb_dienst_dagen, of null (RPC ontbreekt: dan geen factuurtoets en blijven open f-signalen staan).
 * facturen (f): factuurKandidaten() met tekst (string; '' = geen tekstlaag) of tekst null (pdftotext mislukt: dan blijft een open signaal staan).
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
  const tel = { TG: { a: 0, b: 0, c: 0, beoordeeld: 0, f_klopt: 0, f_afwijkend: 0, f_onbekend: 0, f_overgeslagen: 0 },
    GH: { a: 0, b: 0, c: 0, beoordeeld: 0, f_klopt: 0, f_afwijkend: 0, f_onbekend: 0, f_overgeslagen: 0 } };
  const behoud = [];   // sleutels van f-signalen die deze ronde niet beoordeeld konden worden: niet sluiten
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
  // (f) factuurtoets: werkdagen op een waarnemersfactuur ↔ rooster van die persoon bij die praktijk
  // review MOET 1/2: f-signalen sluiten alleen als de toets echt draaide (dagen én facturenlijst aanwezig) en de factuur beoordeeld is of
  // de lijst compleet was; anders blijven open f-signalen staan (schrijf kijkt naar f.klaar, f.afgekapt en f.beoordeeld)
  const fAlle = Array.isArray(o.facturen) ? o.facturen : [];
  const fl = fAlle.slice(0, FACTUUR_MAX);
  const f = { klaar: Array.isArray(o.dagen) && Array.isArray(o.facturen), afgekapt: fAlle.length > FACTUUR_MAX, beoordeeld: [] };
  if (!Array.isArray(o.dagen)) {
    for (const k of fl) { behoud.push(FACTUUR_SOORT + ':' + k.id); if (tel[k.pr]) tel[k.pr].f_overgeslagen++; }
  } else {
    const dagSet = new Map();
    for (const r of o.dagen) {
      if (!PRAKTIJK[r.pr] || !(Number(r.dagen) > 0)) continue;
      const k = r.pr + '|' + r.obj;
      if (!dagSet.has(k)) dagSet.set(k, new Set());
      dagSet.get(k).add(String(r.datum).slice(0, 10));
    }
    for (const k of fl) {
      if (!PRAKTIJK[k.pr]) continue;
      if (k.tekst == null) { behoud.push(FACTUUR_SOORT + ':' + k.id); tel[k.pr].f_overgeslagen++; continue; }
      f.beoordeeld.push(k.id);
      const uit = dagenUitTekst(k.tekst, k.factuurdatum);
      const u = factuurOordeel(k, uit, dagSet, dagen);
      tel[k.pr]['f_' + u.oordeel]++;
      if (u.oordeel !== 'afwijkend') continue;
      signalen.push(B.maakSignaal(FACTUUR_SOORT, { entiteit: k.entiteit, naam: naam.get(k.obj) || 'onbekende persoon', alleen_eigenaar: true,
        facturen: [k.id], bedrag_centen: k.incl, sleutel_vast: k.id,
        details: { regel: 'f', persoon: k.obj, praktijk: k.pr, praktijk_naam: PRAKTIJK[k.pr].naam, factuurdatum: k.factuurdatum, nummer: k.nummer ? String(k.nummer).slice(0, 60) : null,
          vorm: u.vorm, aantal: u.aantal || 0, mis: (u.mis || []).slice(0, 31), maanden: u.maanden, dagen_rooster: u.dagen == null ? null : u.dagen } }));
    }
  }
  return { signalen, tel, vandaag, behoud, f };
}

/*
 * schrijf(fdb, D, uitkomst, wanneer) → { nieuw, vanzelf_dicht, heropend, open }. Eén transactie (D.transactie). fdb = facturen-db-verbinding.
 */
function schrijf(fdb, D, u, wanneer) {
  return D.transactie(fdb, () => {
    const t = { nieuw: 0, vanzelf_dicht: 0, heropend: 0, open: 0 };
    const nu = new Set(u.signalen.map((s) => s.sleutel).concat(u.behoud || []));
    // (f) een open factuursignaal krijgt de nieuwe uitkomst (welke dagen ontbreken kan veranderen als het rooster verandert)
    const bij = fdb.db.prepare("UPDATE signaal SET details = ? WHERE sleutel = ? AND status = 'open' AND soort = '" + FACTUUR_SOORT + "' AND details IS NOT ?");
    const ins = fdb.db.prepare('INSERT INTO signaal (id, sleutel, soort, titel, entiteit, leverancier, transacties, facturen, bedrag_centen, details, alleen_eigenaar, aangemaakt_op) ' +
      'VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1, ?) ON CONFLICT (sleutel) DO NOTHING');
    const heropen = fdb.db.prepare("UPDATE signaal SET status = 'open', afhandeling = NULL, les = NULL, wie = NULL, wanneer = NULL, details = ? " +
      "WHERE sleutel = ? AND status = 'afgehandeld' AND afhandeling = 'vanzelf_opgelost'");
    for (const s of u.signalen) {
      const details = JSON.stringify(Object.assign({ naam: s.naam }, s.details));
      const n = ins.run(D.nieuwId(), s.sleutel, s.soort, s.titel, s.entiteit, JSON.stringify(s.transacties || []), JSON.stringify(s.facturen || []),
        s.bedrag_centen == null ? null : s.bedrag_centen, details, wanneer).changes;
      if (n) { t.nieuw += n; continue; }
      if (s.soort === FACTUUR_SOORT && bij.run(details, s.sleutel, details).changes) { t.bijgewerkt = (t.bijgewerkt || 0) + 1; continue; }
      const h = heropen.run(details, s.sleutel).changes;
      if (h) {
        t.heropend += h;
        const r = fdb.db.prepare('SELECT id, entiteit FROM signaal WHERE sleutel = ?').get(s.sleutel);
        D.audit(fdb, { wie: WIE, wat: 'signaal_heropend', object_soort: 'signaal', object_id: r.id, entiteit: r.entiteit, voor: { status: 'afgehandeld' },
          na: { status: 'open', soort: s.soort }, wanneer });
      }
    }
    const dicht = fdb.db.prepare("UPDATE signaal SET status = 'afgehandeld', afhandeling = 'vanzelf_opgelost', wie = ?, wanneer = ?, sluimer_tot = NULL WHERE id = ? AND status = 'open'");
    const fu = u.f || { klaar: false };
    for (const s of fdb.db.prepare("SELECT id, sleutel, soort, entiteit FROM signaal WHERE status = 'open' AND soort IN (" + SOORTEN.map(() => '?').join(',') + ')').all(...SOORTEN)) {
      if (nu.has(s.sleutel)) { t.open++; continue; }
      // review MOET 1/2: een f-signaal alleen sluiten na een echte toets van die factuur (of als hij niet meer in een complete lijst staat)
      if (s.soort === FACTUUR_SOORT && (!fu.klaar || (fu.afgekapt && !fu.beoordeeld.includes(s.sleutel.slice(FACTUUR_SOORT.length + 1))))) { t.open++; continue; }
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

module.exports = { controle, schrijf, jaren, maandenVanaf, factuurKandidaten, dagenUitTekst, factuurOordeel, SOORTEN, FACTUUR_SOORT, VAN_JAAR, NA_DAGEN, TERUG_DAGEN };
