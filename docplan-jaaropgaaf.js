'use strict';
/*
 * DocPlan — jaaropgaaf per waarnemer voor de renseignering (wv2304, 3-11-2026; idee 25 meetpunt 6; vault "01_Ontwikkeling/OVIS DocPlan - ontwerp
 * (31-10-2026).md" § 4.3). David 26-10: "aan het einde van een jaar moet ik aanleveren aan de belastingdienst aan welke waarnemers ik heb uitbetaald,
 * en welk bedrag dan precies, met alle NAW gegevens". Keuze 4 (Ja 31-10 22:20): een EXPORT voor de administrateur, DocPlan dient niets in; 2026
 * zónder BSN en geboortedatum.
 *
 *  GET  /app/facturen/jaaropgaaf[/<jaar>]  → per praktijk (Tolgaarde, Groenhouten) per waarnemer: betaald in het jaar (uit de bank, zelfde
 *                                           rekenregel als Facturen › Waarnemers: docplan-totaal.js), NAW compleet ja/nee met vindplaats en wat
 *                                           ontbreekt, en de controle tegen het rooster (vragen, geen oordeel):
 *                                             betaald_zonder_rooster   betaald in het jaar, maar geen dag in het rooster van die praktijk van
 *                                                                      1 november het jaar ervoor t/m eind van het jaar;
 *                                             rooster_zonder_betaling  waarneemrol bij die praktijk en dagen in een maand van het jaar waarvan de
 *                                                                      betaaltermijn (einde maand + 75 dagen) voorbij de laatste bankdag is, maar
 *                                                                      geen enkele betaling in het jaar.
 *  POST /app/facturen/jaaropgaaf {jaar}    → het exportbestand (xlsx, base64) op Davids knop: één blad per praktijk met alleen de waarnemers met een
 *                                           betaling, kolommen zoals Davids eigen lijst van 2025; Geboortedatum en BSN leeg (vult de administrateur
 *                                           in); een blad Toelichting. Niets bewaard op de pod, niets verstuurd.
 *
 * Bronnen (alle alleen-lezend, per vraag geopend en weer gesloten): docplan.sqlite (persoon, rekening, rol, naw — naw is de tabel van
 * mk-scripts/docplan/naw.py; ontbreekt hij in een oud bestand, dan is NAW overal "ontbreekt"), facturen.sqlite (bank_transactie) en
 * public.sb_dienst_maanden (rooster per persoon per maand, 0021). Faalt het rooster, dan blijven bedragen en NAW staan en staat de controle op
 * "niet te lezen" (geen vragen verzonnen). Namen, adressen en bedragen alleen in het antwoord aan Davids app, nooit in een log (de reden noemt
 * alleen het jaar en aantallen).
 */
const T = require('./docplan-totaal.js');

const PAD_RE = /^\/app\/facturen\/jaaropgaaf(?:\/(\d{4}))?$/;
const JAAR_MIN = 2026;        // DocPlan kent de waarnemers vanaf 1-1-2026 (§ 9); 2025 ging nog met de hand
const NA_DAGEN = 75;          // zelfde betaaltermijn als de vaste controle (docplan-controle.js regel a)
const NAW_VELDEN = ['achternaam', 'voorletters', 'straat', 'huisnummer', 'postcode', 'plaats'];
const NAW_NAAM = { achternaam: 'achternaam', voorletters: 'voorletters', straat: 'straat', huisnummer: 'huisnummer', postcode: 'postcode', plaats: 'woonplaats' };

function dagAmsterdam(nu) { return new Date(nu).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
function isoPlus(iso, dagen) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + dagen); return d.toISOString().slice(0, 10); }
function maandEinde(m) { const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7)); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); }
const leeg = (v) => v === null || v === undefined || String(v).trim() === '';

/* NAW per object_id uit docplan.sqlite; een oud bestand zonder tabel naw → lege Map (alles "ontbreekt"). */
function nawLees(dp) {
  const heeft = dp.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'naw'").get();
  if (!heeft || !Number(heeft.n)) return new Map();
  const kol = new Set(dp.prepare('PRAGMA table_info(naw)').all().map((r) => r.name));
  const vind = kol.has('vindplaats') ? 'vindplaats' : 'NULL AS vindplaats';
  return new Map(dp.prepare('SELECT object_id, bedrijfsnaam, achternaam, voorvoegsels, voorletters, straat, huisnummer, toevoeging, postcode, plaats, land, bron, opmerking, '
    + vind + ' FROM naw').all().map((r) => [r.object_id, r]));
}
function nawStand(r) {
  if (!r) return { stand: 'ontbreekt', ontbreekt: NAW_VELDEN.map((v) => NAW_NAAM[v]), vindplaats: null };
  const mis = NAW_VELDEN.filter((v) => leeg(r[v])).map((v) => NAW_NAAM[v]);
  const velden = {};
  for (const k of ['bedrijfsnaam', 'achternaam', 'voorvoegsels', 'voorletters', 'straat', 'huisnummer', 'toevoeging', 'postcode', 'plaats', 'land']) velden[k] = leeg(r[k]) ? null : String(r[k]);
  return { stand: mis.length ? 'onvolledig' : 'compleet', ontbreekt: mis, vindplaats: r.vindplaats || r.bron || null, opmerking: r.opmerking || null, velden };
}

/*
 * opgaaf(dp, fac, jaar, nu, maanden) → { jaar, praktijken, jaren, rooster }. maanden = rijen van sb_dienst_maanden [{pr, obj, maand, dagen}] of
 * null (rooster niet te lezen). Puur: alleen SELECT op de twee verbindingen.
 */
function opgaaf(dp, fac, jaar, nu, maanden) {
  const t = T.totaal(dp, fac, jaar, nu);
  const naw = nawLees(dp);
  const personen = new Map(dp.prepare('SELECT object_id, naam FROM persoon').all().map((r) => [r.object_id, r.naam]));
  const rollen = new Set(dp.prepare('SELECT object_id, praktijk FROM rol').all().map((r) => r.object_id + '|' + r.praktijk));
  const roosterOk = Array.isArray(maanden);
  // dagen per (persoon, praktijk): in het jaar, in de controleperiode (1-11 vorig jaar t/m 31-12), en per maand van het jaar
  const dagJaar = new Map(), dagRuim = new Map(), perMaand = new Map();
  const vanRuim = (Number(jaar) - 1) + '-11';
  if (roosterOk) {
    for (const r of maanden) {
      const m = String(r.maand || '').slice(0, 7), sl = r.obj + '|' + r.pr, n = Number(r.dagen || 0);
      if (!(n > 0) || !/^\d{4}-\d{2}$/.test(m)) continue;
      if (m >= vanRuim && m <= jaar + '-12') dagRuim.set(sl, (dagRuim.get(sl) || 0) + n);
      if (m.slice(0, 4) === String(jaar)) {
        dagJaar.set(sl, (dagJaar.get(sl) || 0) + n);
        if (!perMaand.has(sl)) perMaand.set(sl, []);
        perMaand.get(sl).push([m, n]);
      }
    }
  }
  const praktijken = t.praktijken.map((p) => {
    const tm = p.tm_bankdag;
    const rijen = p.personen.map((x) => {
      const sl = x.object_id + '|' + p.code;
      const vraag = roosterOk && x.af_centen > 0 && !(dagRuim.get(sl) > 0) ? 'betaald_zonder_rooster' : null;
      return { object_id: x.object_id, naam: x.naam, af_n: x.af_n, af_centen: x.af_centen, eerste: x.betalingen.filter((b) => b.bedrag_centen < 0).map((b) => b.datum).sort()[0] || null,
        laatste: x.laatste, terug_n: x.terug_n, terug_centen: x.terug_centen, koppeling: x.koppeling, rol: x.rol,
        rooster_dagen: roosterOk ? (dagJaar.get(sl) || 0) : null, naw: nawStand(naw.get(x.object_id)), vraag };
    });
    // waarnemers met een rol en dagen waarvan de betaaltermijn voorbij is, zonder één betaling in het jaar
    const echt = rijen.filter((r) => r.af_centen > 0);   // review ZOU 2: alleen echte afschrijvingen tellen als betaald (niet alleen terug ontvangen)
    const betaald = new Set(echt.map((r) => r.object_id));
    const zonder = [];
    if (roosterOk && tm) {
      for (const [sl, ms] of perMaand) {
        const [oid, pr] = sl.split('|');
        if (pr !== p.code || betaald.has(oid) || !rollen.has(sl) || !personen.has(oid)) continue;
        const verlopen = ms.filter(([m]) => isoPlus(maandEinde(m), NA_DAGEN) <= tm);
        const n = verlopen.reduce((s, [, d]) => s + d, 0);
        if (n > 0) zonder.push({ object_id: oid, naam: personen.get(oid), af_n: 0, af_centen: 0, eerste: null, laatste: null, terug_n: 0, terug_centen: 0, koppeling: null, rol: true,
          rooster_dagen: dagJaar.get(sl) || 0, naw: nawStand(naw.get(oid)), vraag: 'rooster_zonder_betaling', dagen_verlopen: n });
      }
      zonder.sort((a, b) => b.dagen_verlopen - a.dagen_verlopen || String(a.naam).localeCompare(b.naam, 'nl'));
    }
    const alle = rijen.concat(zonder);
    return { code: p.code, entiteit: p.entiteit, naam: p.naam, tm_bankdag: tm, jaar_compleet: !!tm && tm >= jaar + '-12-31',
      personen: alle, n_betaald: echt.length, som_centen: p.som_centen, af_n: p.af_n, terug_n: p.terug_n, terug_centen: p.terug_centen,
      naw_compleet: echt.filter((r) => r.naw.stand === 'compleet').length, naw_onvolledig: echt.filter((r) => r.naw.stand !== 'compleet').length,
      vragen: alle.filter((r) => r.vraag).length };
  });
  const dit = Number(dagAmsterdam(nu).slice(0, 4));
  const jaren = [];
  for (let j = JAAR_MIN; j <= dit; j++) jaren.push(String(j));
  return { jaar: String(jaar), berekend_op: new Date(nu).toISOString(), praktijken, jaren, rooster: roosterOk ? 'ok' : 'niet te lezen', naw_tabel: naw.size > 0 };
}

const euroTekst = (c) => '€ ' + (c / 100).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nlDatum = (iso) => iso ? iso.slice(8, 10) + '-' + iso.slice(5, 7) + '-' + iso.slice(0, 4) : '';
const VRAAG_TEKST = { betaald_zonder_rooster: 'betaald, maar niet in het rooster van deze praktijk gevonden', rooster_zonder_betaling: 'in het rooster, maar geen betaling in het jaar' };
const KOP = ['Bedrijfsnaam', 'Achternaam', 'Voorvoegsels', 'Voorletters', 'Geboortedatum', 'BSN', 'Bedrag', 'Aantal betalingen', 'Eerste betaling', 'Laatste betaling',
  'Adres', 'Huisnummer', 'Toevoeging', 'Postcode', 'Plaats', 'Land', 'NAW compleet', 'Vindplaats NAW', 'Opmerking'];

/* bladen(o) → [{naam, rijen}] voor xlsx-schrijver: één blad per praktijk (alleen waarnemers met een betaling) + Toelichting. Geboortedatum en BSN
 * blijven altijd leeg: DocPlan slaat ze niet op (ontwerp § 4.3, keuze 4). */
function bladen(o) {
  const uit = [];
  for (const p of o.praktijken) {
    const rijen = [KOP];
    for (const r of p.personen.filter((x) => x.af_centen > 0)) {
      const v = (r.naw && r.naw.velden) || {};
      const opm = [];
      if (r.naw.stand !== 'compleet') opm.push('NAW onvolledig: ' + r.naw.ontbreekt.join(', ') + ' ontbreekt');
      if (r.naw.opmerking) opm.push(r.naw.opmerking);
      if (r.vraag) opm.push(VRAAG_TEKST[r.vraag]);
      if (!r.rol) opm.push('geen waarneemrol bij deze praktijk in het register');
      if (r.terug_n > 0) opm.push(r.terug_n + '× terug ontvangen (' + euroTekst(r.terug_centen) + '), niet afgetrokken');
      if (r.koppeling === 'waarschijnlijk') opm.push('rekening hoort waarschijnlijk bij deze persoon (niet zeker)');
      rijen.push([v.bedrijfsnaam || '', v.achternaam || r.naam, v.voorvoegsels || '', v.voorletters || '', '', '', euroTekst(r.af_centen), String(r.af_n),
        nlDatum(r.eerste), nlDatum(r.laatste), v.straat || '', v.huisnummer || '', v.toevoeging || '', v.postcode || '', v.plaats || '', v.land || '',
        r.naw.stand === 'compleet' ? 'ja' : 'nee', r.naw.vindplaats || '', opm.join('; ')]);
    }
    rijen.push([]);
    rijen.push(['Totaal', '', '', '', '', '', euroTekst(p.som_centen), String(p.af_n)]);
    uit.push({ naam: p.naam + ' ' + o.jaar, rijen });
  }
  const t = [['Jaaropgaaf waarnemers ' + o.jaar + ' — voor de administrateur (renseignering, opgaaf betalingen aan derden)'], [],
    ['Gemaakt', nlDatum(o.berekend_op.slice(0, 10)) + ' (DocPlan, Socev)']];
  for (const p of o.praktijken) {
    t.push([p.naam, p.n_betaald + ' waarnemers, totaal ' + euroTekst(p.som_centen) + '; bank t/m ' + (nlDatum(p.tm_bankdag) || 'onbekend')
      + (p.jaar_compleet ? '' : ' — LET OP: het jaar is nog niet compleet in de bank'), 'NAW compleet bij ' + p.naw_compleet + ' van ' + p.n_betaald]);
  }
  t.push([]);
  t.push(['Bedrag', 'Som van de afschrijvingen van de praktijkrekening in het kalenderjaar (op boekdatum) aan de rekeningen die bij de waarnemer horen, inclusief vergoedingen. Terugbetalingen zijn niet afgetrokken; ze staan in de opmerking.']);
  t.push(['NAW', 'Uit de waarnemerslijst van 2025 (vindplaats per regel). Een adres kan sindsdien veranderd zijn. Ontbreekt iets, dan staat er "NAW onvolledig".']);
  t.push(['Geboortedatum en BSN', 'Bewust leeg: DocPlan slaat ze niet op. Vul ze aan zoals vorig jaar.']);
  t.push(['Wie telt', 'Alleen waarnemers (niet in loondienst) met een betaling in het jaar. Bij een waarnemer die via een eigen BV factureert, vervalt de opgaaf meestal: graag nakijken.']);
  uit.push({ naam: 'Toelichting', rijen: t });
  return uit;
}

/*
 * maak({ openDocplan() → db|null, openFacturen() → {db, sluit()}|null, rpc(fn, body) → Promise, xlsx: { schrijf(bladen) → Buffer }, fout }) → { app(verzoek) }.
 * verzoek = { methode, pad, d, rol, primair, nu } → Promise<{ status, j, reden }>. Alleen de eigenaar op de primaire kant.
 */
function maak(o) {
  o = o || {};
  async function app(v) {
    const nu = Number.isFinite(v.nu) ? v.nu : Date.now();
    const m = (v.methode === 'GET' || v.methode === 'POST') ? PAD_RE.exec(String(v.pad || '')) : null;
    if (!m || (v.methode === 'POST' && m[1])) return { status: 404, j: { ok: false, fout: 'onbekend' }, reden: 'jaaropgaaf onbekend' };
    if (!v.rol || v.rol.soort !== 'eigenaar' || v.rol.ingang !== 'app') return { status: 403, j: { ok: false, fout: 'alleen de eigenaar' }, reden: 'jaaropgaaf geweigerd' };
    if (v.primair !== true) return { status: 409, j: { ok: false, fout: 'Facturen draait alleen op de primaire kant' }, reden: 'jaaropgaaf niet primair' };
    const dit = dagAmsterdam(nu).slice(0, 4);
    const jaar = v.methode === 'POST' ? String((v.d && v.d.jaar) || '') : (m[1] || dit);
    if (!/^\d{4}$/.test(jaar) || Number(jaar) < JAAR_MIN || Number(jaar) > Number(dit)) return { status: 400, j: { ok: false, fout: 'jaar buiten bereik' }, reden: 'jaaropgaaf jaar' };
    let maanden = null;
    try {
      const r = await o.rpc('sb_dienst_maanden', { p_van: (Number(jaar) - 1) + '-11-01' });
      if (Array.isArray(r)) maanden = r;
    } catch (e) { if (typeof o.fout === 'function') o.fout('jaaropgaaf rooster', e); }
    let dp = null, fac = null;
    try {
      dp = o.openDocplan();
      if (!dp) return { status: 200, j: { ok: true, leeg: true, jaar, praktijken: [], jaren: [jaar] }, reden: 'jaaropgaaf leeg' };
      fac = o.openFacturen();
      if (!fac) return { status: 503, j: { ok: false, fout: 'de facturendatabase is nu niet te openen' }, reden: 'jaaropgaaf facturen dicht' };
      const x = opgaaf(dp, fac.db, jaar, nu, maanden);
      const tel = x.praktijken.map((p) => p.code + ' ' + p.n_betaald + '/' + p.naw_onvolledig + '/' + p.vragen).join(' ');
      if (v.methode === 'GET') return { status: 200, j: Object.assign({ ok: true }, x), reden: 'jaaropgaaf ' + jaar + ' ' + tel };
      const buf = o.xlsx.schrijf(bladen(x));
      const naam = 'Jaaropgaaf waarnemers ' + jaar + ' (gemaakt ' + dagAmsterdam(nu) + ').xlsx';
      return { status: 200, j: { ok: true, jaar, bestand: { naam, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', codering: 'base64', inhoud: buf.toString('base64') },
        rooster: x.rooster, praktijken: x.praktijken.map((p) => ({ code: p.code, n_betaald: p.n_betaald, som_centen: p.som_centen, naw_onvolledig: p.naw_onvolledig, jaar_compleet: p.jaar_compleet })) },
        reden: 'jaaropgaaf export ' + jaar + ' ' + tel };
    } catch (e) {
      if (typeof o.fout === 'function') o.fout('jaaropgaaf', e);
      return { status: 503, j: { ok: false, fout: 'de jaaropgaaf is nu niet te maken' }, reden: 'jaaropgaaf fout' };
    } finally {
      try { if (dp) dp.close(); } catch (e) { /* al dicht */ }
      try { if (fac) fac.sluit(); } catch (e) { /* al dicht */ }
    }
  }
  return { app };
}

module.exports = { maak, opgaaf, bladen, nawStand, PAD_RE };
