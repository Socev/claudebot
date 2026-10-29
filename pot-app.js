// pot-app.js — OVIS POT, lezen (wv1894, fase P1; bouwplan vault "01_Ontwikkeling/OVIS POT - POT POH-GGZ-app in de Socev-app
// (bouwplan 28-10-2026).md" § 3.2). De 10 leesroutes van de POT-app (werk.socev.dev/pot, functions/api/pot/[[pad]].js in
// Socev/werkkamer.socev.dev, commit c903ac2) als pure module: geen fetch, geen fs. De pod geeft io mee:
//   io.d1(batch)  → Promise<[{ results: [...] }]> — één rondgang naar D1 `fin` (REST /query met {batch}); alleen SELECT
//   io.nu()       → Date (de toets zet de klok vast)
// De berekeningen zijn letterlijk overgenomen uit de Function (zelfde validaties, teksten en JSON); alleen dit verschilt:
//   - routevorm: padstukken in kleine letters (doorgeefluik: alleen GET/POST, ^[a-z0-9/-]{1,64}$, geen querystring), zie ROUTES;
//   - vragen die tegelijk kunnen gaan in één D1-batch (vraagBundel: alles wat in dezelfde tik gevraagd wordt), en de lussen per
//     entiteit lopen naast elkaar (uitvoer in de vaste volgorde POT, KM, SLOEL). Eén rondgang ≈ 0,2 s (gemeten 28-10); de toets
//     telt de rondgangen per route (bouwplan: ≤ 1,5 s per route);
//   - de klok: io.nu() met UTC-getters, zoals de Function op Cloudflare (die draait in UTC).
// Schrijvende routes (wv1933, fase P3 + P4): planning, planning/vaststellen, correctie, patienten, nota/<id>/status (P3) en verzend,
// verzending/<id>/annuleer, verzending/<id>/adres (P4), letterlijk uit dezelfde Function (zelfde validaties, teksten en JSON). Verschil:
//   - schrijven gaat via io.schrijf(batch) → [{ results, changes }]: één D1-batch = één transactie (gemeten 29-10-2026 op een
//     wegwerp-D1: een batch waarvan een latere opdracht faalt laat niets achter, ook niet de eerdere; bouwplan § 3.3 / § Log);
//   - de klok van een schrijfroute komt uit D1 (strftime('now')), niet van de pod (de podklok liep eerder dagen mis);
//   - de SQL op nota_verzending (aanvraag, annuleren, adres) staat in pot-verzend.js: één module is eigenaar van die tabel;
//   - een schrijfroute mag alleen als io.schrijvenOpen() (de overstap, § 3.4: nooit twee schrijvers tegelijk); dicht = 409, behalve
//     annuleren (maakt alleen dichter) en de verzendroutes voor een PROEF-nota (natoets van de machinekamer);
//   - de PDF bij klaarzetten hooguit 45 kB (doorgeefluik: JSON ≤ 64 kB); een nota van één pagina is ± 7 kB.
'use strict';

// Antwoorden zoals de Function ze gaf, maar als { status, j } (server.js stuurt ze met appStuur).
const json = (data, status = 200) => ({ status, j: data });
const fout = (msg, status = 400) => json({ ok: false, fout: msg }, status);
const nu = (env) => new Date(env.nu).toISOString();

const ENTITEITEN = ['POT', 'KM', 'SLOEL'];
const TERMIJN_STANDAARD = { POT: 'maand', KM: 'maand', SLOEL: 'kwartaal' };
const JAAR_MIN = 2015, JAAR_MAX = 2100;
const RC_VANAF = 2025; // rekening-courant Tolgaarde: t/m 2024 afgerond, saldo vanaf dit boekjaar

function leesJaar(url, standaard) {
  const s = url.searchParams.get('jaar');
  if (s == null || s === '') return standaard;
  if (!/^\d{4}$/.test(s)) return null;
  const j = parseInt(s, 10);
  return j >= JAAR_MIN && j <= JAAR_MAX ? j : null;
}
function leesEntiteit(url) {
  const e = String(url.searchParams.get('entiteit') || '').toUpperCase();
  return ENTITEITEN.includes(e) ? e : null;
}
const q = (env, sql, ...p) => env.vraag(sql, p);
const q1 = (env, sql, ...p) => env.vraag(sql, p).then((r) => (r.length ? r[0] : null));
const rond = (x) => Math.round((Number(x) || 0) * 100) / 100;
const perSleutel = (rijen, f) => { const m = {}; for (const r of rijen) (m[f(r)] ||= []).push(r); return m; };

// Volgorde waarin afrekeningsversies getoond worden: nieuwste hub-<datum> > hub-concept > excel-bron > rest.
function versieRang(v) {
  if (/^hub-\d{4}-\d{2}-\d{2}/.test(v)) return '3-' + v;
  if (v === 'hub-concept') return '2';
  if (v === 'excel-bron') return '1';
  return '0-' + v;
}
// Verdeelsleutel-voorkeur: hub (rekenmodule) > herberekend > vastgesteld.
const SLEUTEL_RANG = { hub: 3, herberekend: 2, vastgesteld: 1 };

async function praktijken(env) {
  return q(env, 'select id, naam, naam_vorig from praktijk order by id');
}
async function deelnemers(env, entiteit, jaar) {
  const van = `${jaar}-01-01`, tot = `${jaar}-12-31`;
  const r = await q(env,
    'select praktijk_id from deelname where entiteit=? and (geldig_van is null or geldig_van<=?) and (geldig_tot is null or geldig_tot>=?) order by praktijk_id',
    entiteit, tot, van);
  return r.map((x) => x.praktijk_id);
}
// Nieuwste verdeelsleutel voor (entiteit, jaar); valt terug op het jongste jaar ervoor.
async function sleutel(env, entiteit, jaar) {
  const rijen = await q(env,
    'select jaar, versie, praktijk_id, aandeel, grondslag from verdeelsleutel where entiteit=? and soort=? and jaar<=? order by jaar desc',
    entiteit, 'afrekening', jaar);
  if (!rijen.length) return null;
  const j = rijen[0].jaar;
  const vanJaar = rijen.filter((r) => r.jaar === j);
  const versies = [...new Set(vanJaar.map((r) => r.versie))].sort((a, b) => (SLEUTEL_RANG[b] || 0) - (SLEUTEL_RANG[a] || 0));
  const versie = versies[0];
  const per = {};
  for (const r of vanJaar) if (r.versie === versie) per[r.praktijk_id] = { aandeel: r.aandeel, grondslag: r.grondslag };
  return { jaar: j, versie, per };
}
// Begroting voor (entiteit, jaar): vastgesteld gaat voor; anders de nieuwste (gemaakt_op, id).
async function begroting(env, entiteit, jaar) {
  const b = await q1(env,
    "select id, entiteit, jaar, versie, status, totaal, termijn, methode, grondslag, gemaakt_op, opmerking from begroting where entiteit=? and jaar=? order by (status='vastgesteld') desc, gemaakt_op desc, id desc limit 1",
    entiteit, jaar);
  if (!b) return null;
  // wv1894: regels en andere versies in één rondgang (in de Function na elkaar)
  const [regels, andere] = await Promise.all([
    q(env, 'select praktijk_id, aandeel, jaarbedrag, termijnbedrag, opmerking from begroting_regel where begroting_id=? order by praktijk_id', b.id),
    q(env, "select versie, status, totaal, gemaakt_op from begroting where entiteit=? and jaar=? and id<>? order by gemaakt_op desc", entiteit, jaar, b.id),
  ]);
  let grondslag = null;
  if (b.grondslag) { try { grondslag = JSON.parse(b.grondslag); } catch { grondslag = { fout: 'grondslag is geen geldige JSON' }; } }
  if (grondslag && Array.isArray(grondslag.personeel)) {
    // nooit namen: alleen functie, uren en bruto doorgeven
    grondslag.personeel = grondslag.personeel.map((p) => ({ functie: p.functie ?? null, contracttype: p.contracttype ?? null, uren_week: p.uren_week ?? null,
      uren_jeugd: p.uren_jeugd ?? null, uren_volwassen: p.uren_volwassen ?? null, bruto_maand: p.bruto_maand ?? null, bruto_herkomst: p.bruto_herkomst ?? null, einde: p.einde ?? null }));
  }
  return { ...b, grondslag, regels, andere_versies: andere };
}

// Verstreken termijnen in `jaar` per vandaag (maand: 1..12, kwartaal: 1..4). Een termijn telt zodra hij begonnen is.
function verstrekenTermijnen(jaar, termijn, vandaag) {
  const y = vandaag.getUTCFullYear(), m = vandaag.getUTCMonth() + 1;
  const n = termijn === 'kwartaal' ? 4 : 12;
  if (jaar < y) return n;
  if (jaar > y) return 0;
  return termijn === 'kwartaal' ? Math.ceil(m / 3) : m;
}

// wv1894: de drie entiteiten naast elkaar (de Function deed ze na elkaar); het object houdt de volgorde POT, KM, SLOEL.
async function perEntiteit(f) {
  const r = await Promise.all(ENTITEITEN.map(f));
  const uit = {};
  ENTITEITEN.forEach((e, i) => { uit[e] = r[i]; });
  return uit;
}

// ── routes ──────────────────────────────────────────────────────────────────
async function overzicht(env, url) {
  const vandaag = new Date(env.nu);
  const jaar = leesJaar(url, vandaag.getUTCFullYear());
  if (jaar == null) return fout('jaar ongeldig');
  // wv1894: kop, de drie entiteiten, rekening-courant en open punten in één keer (in de Function na elkaar)
  const [[ents, prakt], lopend, liq, open] = await Promise.all([Promise.all([
    q(env, 'select e.code, e.naam, e.naam_document, (select max(boekdatum) from bankmutatie b where b.entiteit=e.code) as laatste_mutatie, (select count(*) from bankmutatie b where b.entiteit=e.code) as n_mutaties from entiteit e where e.code in (?,?,?) order by case e.code when ? then 1 when ? then 2 else 3 end', ...ENTITEITEN, 'POT', 'KM'),
    praktijken(env),
  ]), perEntiteit(async (ent) => {
    const [deel, sl, beg, ontv, laatst, personeel] = await Promise.all([
      deelnemers(env, ent, jaar),
      sleutel(env, ent, jaar),
      begroting(env, ent, jaar),
      q(env, "select bt.praktijk_id, sum(bt.bedrag) as bedrag, count(*) as n from bank_toewijzing bt join bankmutatie bm on bm.id=bt.bankmutatie_id where bm.entiteit=? and bt.boekjaar=? and bt.soort in ('voorschot','huur') and bt.praktijk_id is not null group by bt.praktijk_id", ent, jaar),
      q(env, "select bt.praktijk_id, max(bm.boekdatum) as datum from bank_toewijzing bt join bankmutatie bm on bm.id=bt.bankmutatie_id where bm.entiteit=? and bt.soort in ('voorschot','huur') and bt.praktijk_id is not null group by bt.praktijk_id", ent),
      q1(env,
        'select jaar, maand, sum(in_dienst) as in_dienst, count(*) as dienstverbanden, round(sum(case when in_dienst=1 then uren_week else 0 end),1) as uren_week, round(sum(case when in_dienst=1 then bruto_maand_contract else 0 end),2) as bruto_maand from dienstverband_maand where entiteit=? and jaar=? and maand<=? group by jaar, maand order by maand desc limit 1',
        ent, jaar, jaar === vandaag.getUTCFullYear() ? vandaag.getUTCMonth() + 1 : 12),
    ]);
    const termijn = beg ? beg.termijn : TERMIJN_STANDAARD[ent];
    const nTerm = termijn === 'kwartaal' ? 4 : 12;
    const verstreken = verstrekenTermijnen(jaar, termijn, vandaag);
    const ontvM = Object.fromEntries(ontv.map((r) => [r.praktijk_id, r]));
    const laatstM = Object.fromEntries(laatst.map((r) => [r.praktijk_id, r.datum]));
    const begM = beg ? Object.fromEntries(beg.regels.map((r) => [r.praktijk_id, r])) : {};
    const ids = [...new Set([...deel, ...Object.keys(ontvM), ...Object.keys(begM)])].sort();
    const rijen = ids.map((id) => {
      const s = sl && sl.per[id];
      const bregel = begM[id];
      const aandeel = bregel ? bregel.aandeel : s ? s.aandeel : null;
      const ontvangen = rond(ontvM[id] ? ontvM[id].bedrag : 0);
      const termijnbedrag = bregel ? bregel.termijnbedrag : null;
      const verwacht = termijnbedrag != null ? rond(termijnbedrag * verstreken) : null;
      const verschil = verwacht != null ? rond(ontvangen - verwacht) : null;
      const laatste = laatstM[id] || null;
      let status = 'onbekend';
      if (verschil != null && termijnbedrag) {
        status = verschil < -0.5 * termijnbedrag ? 'achter' : verschil > 0.5 * termijnbedrag ? 'vooruit' : 'op_schema';
      } else if (jaar === vandaag.getUTCFullYear()) {
        // zonder begroting: alleen kijken of de laatste betaling in de lopende of vorige termijn viel
        const grensDagen = termijn === 'kwartaal' ? 120 : 45;
        const dagen = laatste ? (vandaag - new Date(laatste)) / 864e5 : Infinity;
        status = dagen <= grensDagen ? 'op_schema' : 'achter';
      }
      return { praktijk_id: id, aandeel, aandeel_pct: aandeel != null ? rond(aandeel / 1000) : null, termijnbedrag, jaarbedrag: bregel ? bregel.jaarbedrag : null,
        ontvangen, n_betalingen: ontvM[id] ? ontvM[id].n : 0, verwacht, verschil, laatste_betaling: laatste, status };
    });
    const totaal = {
      ontvangen: rond(rijen.reduce((a, r) => a + r.ontvangen, 0)),
      verwacht: beg ? rond(rijen.reduce((a, r) => a + (r.verwacht || 0), 0)) : null,
      termijnbedrag: beg ? rond(rijen.reduce((a, r) => a + (r.termijnbedrag || 0), 0)) : null,
      jaarbedrag: beg ? beg.totaal : null,
    };
    totaal.verschil = totaal.verwacht != null ? rond(totaal.ontvangen - totaal.verwacht) : null;
    return {
      jaar, termijn, termijnen: nTerm, verstreken,
      sleutel: sl ? { jaar: sl.jaar, versie: sl.versie, zelfde_jaar: sl.jaar === jaar } : null,
      begroting: beg ? { id: beg.id, versie: beg.versie, status: beg.status, totaal: beg.totaal } : null,
      personeel: personeel && personeel.jaar != null ? personeel : null,
      rijen, totaal,
    };
  }),
  // rekening-courant Tolgaarde (P07): + = geld naar de entiteit, − = terug naar Tolgaarde
  q(env,
    "select bm.entiteit, coalesce(bt.boekjaar, cast(strftime('%Y', bm.boekdatum) as integer)) as jaar, sum(bt.bedrag) as bedrag, count(*) as n from bank_toewijzing bt join bankmutatie bm on bm.id=bt.bankmutatie_id where bt.soort='liquiditeit' and bt.praktijk_id='P07' group by bm.entiteit, jaar order by bm.entiteit, jaar"),
  q(env,
    "select id, entiteit, jaar, praktijk_id, bron, omschrijving, bedrag, status, besluit, aangemaakt_op from controlebevinding where status is null or status not in ('afgesloten','verklaard') order by coalesce(jaar,0) desc, id"),
  ]);
  // Saldo telt alleen boekjaar >= RC_VANAF: alles t/m 2024 is volgens David afgerond.
  const liquiditeit = {};
  for (const ent of ENTITEITEN) {
    const per = liq.filter((r) => r.entiteit === ent).map((r) => ({ jaar: r.jaar, bedrag: rond(r.bedrag), n: r.n, telt: r.jaar >= RC_VANAF }));
    liquiditeit[ent] = { vanaf: RC_VANAF, per_jaar: per, saldo: rond(per.filter((r) => r.telt).reduce((a, r) => a + r.bedrag, 0)),
      saldo_alle_jaren: rond(per.reduce((a, r) => a + r.bedrag, 0)) };
  }
  return json({ ok: true, nu: nu(env), jaar, entiteiten: ents, praktijken: prakt, lopend, liquiditeit, open_punten: open });
}

async function afrekening(env, url) {
  const vandaag = new Date(env.nu);
  const jaar = leesJaar(url, vandaag.getUTCFullYear() - 1);
  if (jaar == null) return fout('jaar ongeldig');
  // wv1894: praktijken, jaren en de drie entiteiten in één rondgang
  const [prakt, jarenRijen, uit] = await Promise.all([praktijken(env), q(env, 'select distinct jaar from afrekening order by jaar'), perEntiteit(async (ent) => {
    const [rijen, betaald, jl, docs, slV, slH] = await Promise.all([
      q(env, 'select praktijk_id, versie, aandeel, jaarlast_toegerekend, voorschotten, saldo, status, openstaand_vorig, betaald_afrekening, jaarlast_totaal, opmerking from afrekening where entiteit=? and jaar=? order by praktijk_id', ent, jaar),
      q(env, "select bt.praktijk_id, sum(bt.bedrag) as bedrag, count(*) as n, max(bm.boekdatum) as laatste from bank_toewijzing bt join bankmutatie bm on bm.id=bt.bankmutatie_id where bm.entiteit=? and bt.soort='afrekening' and bt.boekjaar=? and bt.praktijk_id is not null group by bt.praktijk_id", ent, jaar),
      q1(env, 'select bedrag, bron, opmerking from jaarlast where entiteit=? and jaar=?', ent, jaar),
      q(env, 'select praktijk_id, soort, nummer, datum, bedrag, titel, status from document where entiteit=? and jaar=? order by praktijk_id, soort', ent, jaar),
      q(env, "select praktijk_id, aandeel from verdeelsleutel where entiteit=? and jaar=? and soort='afrekening' and versie='vastgesteld'", ent, jaar),
      q(env, "select praktijk_id, aandeel from verdeelsleutel where entiteit=? and jaar=? and soort='afrekening' and versie='herberekend'", ent, jaar),
    ]);
    const perVersieStatus = {};
    for (const r of rijen) (perVersieStatus[r.versie] ||= new Set()).add(r.status || '');
    const versies = Object.keys(perVersieStatus).sort((a, b) => versieRang(b).localeCompare(versieRang(a)));
    const vervallen = (v) => [...perVersieStatus[v]].every((x) => x === 'vervallen');
    const getoond = versies.find((v) => !vervallen(v)) || null;
    const versieInfo = versies.map((v) => ({ versie: v, status: [...perVersieStatus[v]].join(', '), vervallen: vervallen(v) }));
    const betM = Object.fromEntries(betaald.map((r) => [r.praktijk_id, r]));
    const slM = Object.fromEntries([...slH, ...slV].map((r) => [r.praktijk_id, r.aandeel])); // vastgesteld overschrijft herberekend (Excel gebruikte vastgesteld)
    const perVersie = perSleutel(rijen, (r) => r.versie);
    const bouw = (r) => {
      const b = betM[r.praktijk_id];
      const betaaldBank = b ? rond(b.bedrag) : 0;
      const betaaldAfr = r.betaald_afrekening != null ? r.betaald_afrekening : betaaldBank;
      const saldo = r.saldo != null ? r.saldo : rond((r.jaarlast_toegerekend || 0) - (r.voorschotten || 0) + (r.openstaand_vorig || 0));
      let status;
      if (Math.abs(saldo) < 0.5) status = 'nihil';
      else if (saldo > 0) status = betaaldAfr >= saldo - 1 ? 'betaald' : betaaldAfr > 0 ? 'deels' : 'open';
      else status = betaaldAfr <= saldo + 1 ? 'terugbetaald' : betaaldAfr < 0 ? 'deels' : 'open';
      const aandeel = r.aandeel != null ? r.aandeel : slM[r.praktijk_id] ?? null;
      return { praktijk_id: r.praktijk_id, aandeel, aandeel_pct: aandeel != null ? rond(aandeel / 1000) : null, kosten: r.jaarlast_toegerekend, betaald: r.voorschotten,
        openstaand_vorig: r.openstaand_vorig, saldo, betaald_afrekening: betaaldAfr, betaald_bank_n: b ? b.n : 0, betaald_bank_laatste: b ? b.laatste : null,
        status, status_afrekening: r.status, opmerking: r.opmerking };
    };
    const getoondRijen = getoond ? perVersie[getoond].map(bouw) : [];
    const som = (k) => rond(getoondRijen.reduce((a, r) => a + (Number(r[k]) || 0), 0));
    const totaal = getoond ? { kosten: som('kosten'), betaald: som('betaald'), openstaand_vorig: som('openstaand_vorig'), saldo: som('saldo'), betaald_afrekening: som('betaald_afrekening') } : null;
    let vergelijking = null;
    if (versies.length > 1) {
      const ids = [...new Set(rijen.map((r) => r.praktijk_id))].sort();
      const vergVersies = [getoond, ...versies.filter((v) => v !== getoond)].filter(Boolean);
      vergelijking = { versies: vergVersies, vervallen: vergVersies.map(vervallen), rijen: ids.map((id) => {
        const s = {}; for (const v of vergVersies) { const r = perVersie[v].find((x) => x.praktijk_id === id); s[v] = r ? r.saldo : null; }
        const a = s[vergVersies[0]], b = s[vergVersies[1]];
        return { praktijk_id: id, saldo: s, verschil: a != null && b != null ? rond(a - b) : null };
      }) };
    }
    return { jaar, versie: getoond, versies: versieInfo, status_afrekening: getoond ? [...new Set(perVersie[getoond].map((r) => r.status))].join(', ') : null,
      jaarlast: jl || null, rijen: getoondRijen, totaal, vergelijking, documenten: docs };
  })]);
  const jaren = jarenRijen.map((r) => r.jaar);
  return json({ ok: true, nu: nu(env), jaar, jaren, praktijken: prakt, afrekening: uit });
}

async function begrotingRoute(env, url) {
  const jaar = leesJaar(url, new Date(env.nu).getUTCFullYear() + 1);
  if (jaar == null) return fout('jaar ongeldig');
  const vandaag = new Date(env.nu), lopend = jaar - 1;
  // wv1894: praktijken, jaren en de drie entiteiten naast elkaar
  const [prakt, jarenRijen, uit] = await Promise.all([praktijken(env), q(env, 'select distinct jaar from begroting order by jaar'), perEntiteit(async (ent) => {
    // wv1894: de ontvangsten van het lopende jaar tegelijk met de begroting (in de Function erna)
    const [b, ontv] = await Promise.all([begroting(env, ent, jaar),
      q(env, "select bt.praktijk_id, sum(bt.bedrag) as bedrag, count(*) as n from bank_toewijzing bt join bankmutatie bm on bm.id=bt.bankmutatie_id where bm.entiteit=? and bt.boekjaar=? and bt.soort in ('voorschot','huur') and bt.praktijk_id is not null group by bt.praktijk_id", ent, lopend)]);
    if (!b) return null;
    // vergelijking: wat de praktijk in het lopende jaar (jaar-1) gemiddeld per verstreken termijn betaalde
    const verstreken = verstrekenTermijnen(lopend, b.termijn, vandaag);
    const ontvM = Object.fromEntries(ontv.map((r) => [r.praktijk_id, r]));
    b.regels = b.regels.map((r) => {
      const o = ontvM[r.praktijk_id];
      const huidig = o && verstreken ? rond(o.bedrag / verstreken) : null;
      return { ...r, huidig_per_termijn: huidig, huidig_ontvangen: o ? rond(o.bedrag) : 0, verschil: huidig != null ? rond(r.termijnbedrag - huidig) : null };
    });
    b.vergelijking = { jaar: lopend, verstreken, termijn: b.termijn };
    return b;
  })]);
  const jaren = jarenRijen.map((r) => r.jaar);
  return json({ ok: true, nu: nu(env), jaar, jaren, praktijken: prakt, begroting: uit });
}

async function kasstroom(env, url) {
  const ent = leesEntiteit(url);
  if (!ent) return fout('entiteit ongeldig (POT, KM of SLOEL)');
  // wv1894: de drie vragen in één rondgang
  const [rijen, ongekoppeld, saldo] = await Promise.all([q(env,
    "select cast(strftime('%Y', bm.boekdatum) as integer) as jaar, bt.soort, round(sum(bt.bedrag),2) as bedrag, count(*) as n from bank_toewijzing bt join bankmutatie bm on bm.id=bt.bankmutatie_id where bm.entiteit=? group by jaar, bt.soort order by jaar, bt.soort", ent),
  q(env,
    "select cast(strftime('%Y', boekdatum) as integer) as jaar, round(sum(bedrag),2) as bedrag, count(*) as n from bankmutatie bm where entiteit=? and not exists (select 1 from bank_toewijzing bt where bt.bankmutatie_id=bm.id) group by jaar order by jaar", ent),
  q(env, "select cast(strftime('%Y', boekdatum) as integer) as jaar, round(sum(bedrag),2) as netto, count(*) as n, min(boekdatum) as van, max(boekdatum) as tot from bankmutatie where entiteit=? group by jaar order by jaar", ent)]);
  return json({ ok: true, nu: nu(env), entiteit: ent, rijen, ongekoppeld, per_jaar: saldo });
}

async function liquiditeit(env) {
  const rijen = await q(env,
    "select bm.entiteit, bm.id as bankmutatie_id, bm.boekdatum, bt.bedrag, bm.omschrijving, bt.boekjaar, bt.opmerking from bank_toewijzing bt join bankmutatie bm on bm.id=bt.bankmutatie_id where bt.soort='liquiditeit' and bt.praktijk_id='P07' order by bm.entiteit, bm.boekdatum, bm.id");
  const uit = {};
  for (const ent of ENTITEITEN) {
    let lopend = 0;
    uit[ent] = rijen.filter((r) => r.entiteit === ent).map((r) => {
      const jaar = r.boekjaar != null ? r.boekjaar : parseInt(String(r.boekdatum).slice(0, 4), 10);
      const telt = jaar >= RC_VANAF;
      if (telt) lopend = rond(lopend + r.bedrag);
      return { ...r, telt, saldo_na: telt ? lopend : null };
    });
  }
  return json({ ok: true, nu: nu(env), vanaf: RC_VANAF, liquiditeit: uit });
}


// ════════════════════════════════════════════════════════════════════════════
// Planning-, afrondings- en correctiemodule (SPEC_planning.md)
//   GET  planning?entiteit=SLOEL&jaar=2027   plannen (alle versies) + posten/deelnemers, praktijken (adres), standen
//                                            1-1-(J−1)/J/(J+1), berekende begrotingssleutel, nota's van J, volgend nummer
//   POST planning                            concept opslaan (nieuw of bestaand concept; vastgesteld → nieuwe versie)
//   POST planning/vaststellen                plan vaststellen + voorschotnota's per kwartaal (één D1-batch)
//   GET  correctie?entiteit&jaar&modus=tot_heden|eindafrekening&tot_kwartaal&extra&jaarlast
//   POST correctie                           correctie-/eindafrekeningsnota's maken
//   GET  patienten / PUT patienten           standen lezen / upsert
//   GET  notas?entiteit&jaar                 nota's met betaalstatus
//   POST nota/<id>/status                    concept → definitief → vervallen (nooit delete)
// Harde regels: sleutel alleen per 1-1; "in rekening gebracht" = som regels[].bedrag met jaar == J over definitieve
// nota's (níet de bank); dubbel betaald apart terugbetalen; POT/KM factureren niet; hele euro's per termijn.
// ════════════════════════════════════════════════════════════════════════════

class Gebruikersfout extends Error { constructor(m, status = 400) { super(m); this.status = status; } }
const MAX_TEKST = 600;
const BETAAL_SOORT = { SLOEL: 'huur', POT: 'voorschot', KM: 'voorschot' };
const OMSCHRIJVING_VOORSCHOT = {
  SLOEL: (j, k) => `Doorbelaste huur Mulderij ${j} - kwartaal ${k}`,
  POT: (j, k) => `Doorbelasting personeelskosten ${j} - kwartaal ${k}`,
  KM: (j, k) => `Doorbelasting kosten ${j} - kwartaal ${k}`,
};
const NOTA_TITEL = { SLOEL: 'DOORBELASTE KOSTEN', POT: 'DOORBELASTING PERSONEELSKOSTEN', KM: 'DOORBELASTING KOSTEN' };
const PER_WAARDEN = ['maand', 'kwartaal', 'jaar', 'eenmalig'];
const vandaagStr = (env) => new Date(env.nu).toISOString().slice(0, 10);
const peil = (j) => `${j}-01-01`;
const heel = (x) => Math.round(Number(x) || 0);

// ── validatie ───────────────────────────────────────────────────────────────
function vEnt(x) { const e = String(x || '').toUpperCase(); if (!ENTITEITEN.includes(e)) throw new Gebruikersfout('entiteit ongeldig (POT, KM of SLOEL)'); return e; }
function vJaar(x, naam = 'jaar') { const j = Number(x); if (!Number.isInteger(j) || j < JAAR_MIN || j > JAAR_MAX) throw new Gebruikersfout(`${naam} ongeldig (${JAAR_MIN}–${JAAR_MAX})`); return j; }
function vNum(x, naam, min = -1e7, max = 1e7) {
  if (x === null || x === undefined || x === '' || typeof x === 'boolean') throw new Gebruikersfout(`${naam} ontbreekt`);
  const n = typeof x === 'string' ? Number(x.replace(/\s/g, '').replace(',', '.')) : Number(x);
  if (!Number.isFinite(n) || n < min || n > max) throw new Gebruikersfout(`${naam} ongeldig`);
  return n;
}
function urlInt(url, naam, min, max, standaard) {
  const s = url.searchParams.get(naam);
  if (s == null || s === '') return standaard;
  const n = Number(s);
  if (!Number.isInteger(n) || n < min || n > max) throw new Gebruikersfout(`${naam} ongeldig`);
  return n;
}


// ── gedeelde bouwstenen ─────────────────────────────────────────────────────
async function praktijkenVol(env, ent) {
  const [p, rek, betaald] = await Promise.all([
    q(env, 'select id, naam, naam_vorig, naam_brief, tav, adres, postcode_plaats, email from praktijk order by id'),
    q(env, 'select praktijk_id, iban, geldig_van, geldig_tot from praktijk_naam where iban is not null order by praktijk_id, (geldig_tot is null) desc, geldig_van desc, id'),
    ent ? q(env, "select bt.praktijk_id, bm.tegenrekening as iban, max(bm.boekdatum) as datum from bank_toewijzing bt join bankmutatie bm on bm.id=bt.bankmutatie_id where bm.entiteit=? and bt.soort=? and bt.bedrag>0 and bt.praktijk_id is not null and bm.tegenrekening is not null group by bt.praktijk_id", ent, BETAAL_SOORT[ent]) : [],
  ]);
  const rekM = {}; for (const r of rek) if (!rekM[r.praktijk_id]) rekM[r.praktijk_id] = r.iban;
  const betM = Object.fromEntries(betaald.map((r) => [r.praktijk_id, r.iban]));
  // IBAN voor terugbetalingen: rekening waarvan de praktijk het laatst aan deze entiteit betaalde, anders praktijk_naam
  return p.map((x) => ({ ...x, iban: betM[x.id] || rekM[x.id] || null }));
}
async function entiteitInfo(env, ent) {
  return q1(env, 'select code, naam, naam_document, iban, tnv, adres, postcode_plaats, kvk from entiteit where code=?', ent);
}
async function standenKaart(env) {
  const r = await q(env, 'select praktijk_id, peildatum, aantal, status from praktijk_patienten order by praktijk_id, peildatum');
  const m = {}; for (const x of r) if (x.aantal != null) (m[x.praktijk_id] ||= {})[x.peildatum] = x.aantal;
  return { rijen: r, m };
}
async function standaardDeelnemers(env, ent, jaar) {
  const d = await deelnemers(env, ent, jaar);
  return d.length ? d : (await praktijken(env)).map((p) => p.id).filter((id) => !(ent === 'SLOEL' && id === 'P09'));
}

// Verdeelsleutel (regel David 13-10-2026):
//  - 'begroting' = tijdens het jaar J: stand 1-1-J (geen gemiddelde). Ontbreekt 1-1-J nog (begroting gemaakt
//    vóór 1-1) → voorlopig op stand 1-1-(J−1); na invoer van 1-1-J een nieuwe versie vaststellen en corrigeren.
//  - 'eindafrekening' = na afloop van J: gemiddelde 1-1-J en 1-1-(J+1); ontbreekt er één → 'ontbreekt', niet afronden.
// stand_a/stand_b blijven ter informatie: 1-1-(J−1)/1-1-J resp. 1-1-J/1-1-(J+1).
function berekenSleutel(standM, ids, jaar, soort) {
  const [a, b] = soort === 'eindafrekening' ? [jaar, jaar + 1] : [jaar - 1, jaar];
  const heeft = (id, j) => standM[id] && standM[id][peil(j)] != null;
  const misA = ids.filter((id) => !heeft(id, a)), misB = ids.filter((id) => !heeft(id, b));
  let status = 'definitief', gebruik = [a, b], melding = null;
  if (soort === 'eindafrekening') {
    if (misA.length || misB.length) {
      status = 'ontbreekt';
      melding = [misA.length ? `stand 1-1-${a} ontbreekt voor ${misA.join(', ')}` : null, misB.length ? `stand 1-1-${b} ontbreekt voor ${misB.join(', ')}` : null].filter(Boolean).join('; ') + ' — voer de stand in op tab Patiënten; nog niet afronden.';
    }
  } else {
    gebruik = [b];
    if (misB.length) {
      status = 'voorlopig'; gebruik = [a];
      melding = `stand 1-1-${b} ontbreekt (${misB.join(', ')}): voorlopige sleutel op stand 1-1-${a}. Zodra de stand 1-1-${b} bekend is: nieuwe versie vaststellen en corrigeren.`;
      if (misA.length) { status = 'ontbreekt'; melding = `stand 1-1-${b} (en 1-1-${a}) ontbreekt voor ${misA.join(', ')}.`; }
    }
  }
  const per = {}; let som = 0;
  for (const id of ids) {
    const sA = heeft(id, a) ? standM[id][peil(a)] : null, sB = heeft(id, b) ? standM[id][peil(b)] : null;
    const vals = gebruik.map((j) => (j === a ? sA : sB));
    const grondslag = status === 'ontbreekt' || vals.some((v) => v == null) ? null : vals.reduce((x, y) => x + y, 0) / vals.length;
    per[id] = { stand_a: sA, stand_b: sB, grondslag, aandeel: null };
    if (grondslag != null) som += grondslag;
  }
  if (status !== 'ontbreekt' && som > 0) for (const id of ids) per[id].aandeel = per[id].grondslag / som;
  const toelichting = status === 'ontbreekt' ? 'standen ontbreken'
    : soort === 'eindafrekening' ? `gemiddelde stand 1-1-${a} en 1-1-${b}`
    : status === 'definitief' ? `stand 1-1-${b}` : `voorlopig: stand 1-1-${a} (stand 1-1-${b} ontbreekt)`;
  return { soort, status, peildata: [peil(a), peil(b)], gebruikt: gebruik.map(peil), per, som, melding, toelichting };
}

function postJaarbedrag(p) { return rond(Number(p.bedrag) * Number(p.aantal) * (1 + (Number(p.indexatie_pct) || 0) / 100)); }
function planTotalen(posten, marge) {
  const som = rond(posten.reduce((a, p) => a + postJaarbedrag(p), 0));
  const totaal = rond(som * (1 + (Number(marge) || 0) / 100));
  return { som, marge_bedrag: rond(totaal - som), totaal };
}
const termijnenPerJaar = (t) => (t === 'maand' ? 12 : 4);

// "In rekening gebracht over jaar J" = som regels[].bedrag met jaar == J over DEFINITIEVE nota's (alle jaren/soorten).
// Concept-nota's tellen niet mee: die zijn (nog) niet verstuurd (fout 13-10-2026: concept 2026033 telde mee).
function regelsVan(n) { try { const r = JSON.parse(n.regels || '[]'); return Array.isArray(r) ? r : []; } catch { return []; } }
async function inRekening(env, ent, jaar) {
  const notas = await q(env, "select id, jaar, nummer, praktijk_id, soort, periode, regels, bedrag, status from nota where entiteit=? and status='definitief' order by nummer", ent);
  const per = {};
  for (const n of notas) {
    let s = 0, telt = false;
    for (const r of regelsVan(n)) if (typeof r.bedrag === 'number' && Number(r.jaar) === jaar) { s += r.bedrag; telt = true; }
    if (!telt) continue;
    const p = (per[n.praktijk_id] ||= { bedrag: 0, nummers: [], notas: [] });
    p.bedrag = rond(p.bedrag + s); p.nummers.push(n.nummer); p.notas.push({ nummer: n.nummer, soort: n.soort, periode: n.periode, bedrag: rond(s), status: n.status });
  }
  return per;
}
async function volgendNummer(env, ent, jaar) {
  const r = await q1(env, "select max(cast(nummer as integer)) as m from nota where entiteit=? and length(nummer)=7 and nummer like ?", ent, `${jaar}%`);
  return String(r && r.m ? Number(r.m) + 1 : jaar * 1000 + 1);
}
async function plannenVan(env, ent, jaar) {
  const plannen = await q(env, 'select * from plan where entiteit=? and jaar=? order by id', ent, jaar);
  if (!plannen.length) return [];
  const ids = plannen.map((p) => p.id);
  const ph = ids.map(() => '?').join(',');
  const [posten, deeln] = await Promise.all([
    q(env, `select * from plan_post where plan_id in (${ph}) order by plan_id, volgorde, id`, ...ids),
    q(env, `select * from plan_deelnemer where plan_id in (${ph}) order by plan_id, praktijk_id`, ...ids),
  ]);
  return plannen.map((p) => ({ ...p, posten: posten.filter((x) => x.plan_id === p.id), deelnemers: deeln.filter((x) => x.plan_id === p.id) }));
}
// Sleutel van een plan: bij een vastgesteld plan de opgeslagen aandelen (wijzigt nooit tussentijds), anders berekend.
function planSleutel(plan, standM) {
  const actief = plan.deelnemers.filter((d) => d.actief).map((d) => d.praktijk_id);
  const opgeslagen = plan.status === 'vastgesteld' && actief.length && actief.every((id) => { const d = plan.deelnemers.find((x) => x.praktijk_id === id); return d && d.aandeel != null; });
  if (opgeslagen) {
    const per = {};
    for (const id of actief) { const d = plan.deelnemers.find((x) => x.praktijk_id === id); per[id] = { grondslag: d.grondslag, aandeel: d.aandeel, stand_a: standM[id]?.[peil(plan.jaar - 1)] ?? null, stand_b: standM[id]?.[peil(plan.jaar)] ?? null }; }
    return { soort: 'begroting', status: 'vastgesteld', bron: 'plan', per, som: actief.reduce((a, id) => a + (per[id].grondslag || 0), 0), peildata: [peil(plan.jaar - 1), peil(plan.jaar)], toelichting: plan.sleutel_toelichting, melding: null };
  }
  return { ...berekenSleutel(standM, actief, plan.jaar, 'begroting'), bron: 'berekend' };
}
function planUitkomst(plan, standM) {
  const tot = planTotalen(plan.posten, plan.marge_pct);
  const sl = planSleutel(plan, standM);
  const n = termijnenPerJaar(plan.termijn);
  const per = {};
  for (const [id, s] of Object.entries(sl.per)) per[id] = { ...s, jaarbedrag: s.aandeel != null ? rond(s.aandeel * tot.totaal) : null, termijnbedrag: s.aandeel != null ? heel(s.aandeel * tot.totaal / n) : null };
  return { ...tot, termijn: plan.termijn, termijnen: n, sleutel: { ...sl, per } };
}

// ── betaalanalyse ───────────────────────────────────────────────────────────
// Betalingen = bank_toewijzing.soort huur (SLOEL) / voorschot met praktijk_id; positief en boekdatum 1-1-J … 31-3-(J+1);
// terugboekingen (negatief) met boekjaar J. Koppelen: eerst exact 7-cijferig nummer in de omschrijving, dan op bedrag
// (oudste onbetaalde nota met gelijk bedrag). Betaling op al betaalde nota of zonder passende nota = dubbel/onbekend.
const NUM7 = /(?<!\d)\d{7}(?!\d)/g;
async function betaalAnalyse(env, ent, jaar) {
  const vandaag = vandaagStr(env);
  const soort = BETAAL_SOORT[ent];
  const [notas, andere, bet, prakt] = await Promise.all([
    q(env, "select id, nummer, praktijk_id, datum, soort, periode, bedrag, status from nota where entiteit=? and jaar=? and status<>'vervallen' order by datum, nummer", ent, jaar),
    q(env, 'select nummer from nota where entiteit=? and jaar<>?', ent, jaar),
    q(env, `select bm.id, bm.boekdatum as datum, bt.bedrag, bm.omschrijving, bm.tegenrekening, bt.praktijk_id, bt.boekjaar
            from bank_toewijzing bt join bankmutatie bm on bm.id=bt.bankmutatie_id
            where bm.entiteit=? and bt.soort=? and bt.praktijk_id is not null and (
              (bt.bedrag>0 and bm.boekdatum>=? and bm.boekdatum<=?) or
              (bt.bedrag<0 and coalesce(bt.boekjaar, cast(strftime('%Y', bm.boekdatum) as integer))=?))
            order by bm.boekdatum, bm.id`, ent, soort, `${jaar}-01-01`, `${jaar + 1}-03-31`, jaar),
    q(env, 'select id, naam from praktijk'),
  ]);
  const pn = Object.fromEntries(prakt.map((p) => [p.id, p.naam]));
  const anderJaar = new Set(andere.map((r) => r.nummer));
  const N = notas.map((n) => ({ ...n, betaald: 0, betalingen: [], dubbel: [] }));
  const opNummer = {}; for (const n of N) opNummer[n.nummer] = n;
  const dubbel = [], buitenJaar = [];
  const nums = (s) => [...String(s || '').matchAll(NUM7)].map((m) => m[0]);
  const rest = (n) => rond(n.bedrag - n.betaald);
  const pos = bet.filter((b) => b.bedrag > 0), neg = bet.filter((b) => b.bedrag < 0);
  const nogTeKoppelen = [];
  // fase 1: op nummer
  for (const b of pos) {
    const ns = nums(b.omschrijving);
    const n = ns.map((x) => opNummer[x]).find((x) => x && x.praktijk_id === b.praktijk_id && x.bedrag > 0);
    if (n) {
      if (rest(n) > 0.5) { n.betaald = rond(n.betaald + b.bedrag); n.betalingen.push(b); }
      else { const d = { ...b, nota: n.nummer, reden: `nota ${n.nummer} was al betaald` }; dubbel.push(d); n.dubbel.push(d); }
      continue;
    }
    if (ns.some((x) => anderJaar.has(x))) { buitenJaar.push(b); continue; } // hoort bij een nota uit een ander jaar
    nogTeKoppelen.push(b);
  }
  // fase 2: op bedrag, oudste onbetaalde nota met gelijk bedrag (anders: openstaand restant gelijk aan de betaling)
  for (const b of nogTeKoppelen) {
    const kand = N.filter((n) => n.praktijk_id === b.praktijk_id && n.bedrag > 0);
    const n = kand.find((x) => x.betaald === 0 && Math.abs(x.bedrag - b.bedrag) < 0.01) || kand.find((x) => rest(x) > 0.5 && Math.abs(rest(x) - b.bedrag) < 0.01);
    if (n) { n.betaald = rond(n.betaald + b.bedrag); n.betalingen.push(b); continue; }
    const vol = kand.find((x) => Math.abs(x.bedrag - b.bedrag) < 0.01);
    const d = { ...b, nota: vol ? vol.nummer : null, reden: vol ? `bedrag gelijk aan nota ${vol.nummer}, die al betaald was` : 'geen passende nota' };
    dubbel.push(d); if (vol) vol.dubbel.push(d);
  }
  // terugboekingen: eerst op nummer van een negatieve nota (terugbetaling door ons), anders verrekenen met dubbele betaling
  const onverrekend = [];
  for (const b of neg) {
    const n = nums(b.omschrijving).map((x) => opNummer[x]).find((x) => x && x.praktijk_id === b.praktijk_id && x.bedrag < 0);
    if (n) { n.betaald = rond(n.betaald + b.bedrag); n.betalingen.push(b); continue; }
    let over = -b.bedrag;
    const eigen = dubbel.filter((d) => d.praktijk_id === b.praktijk_id && (d.rest ?? d.bedrag) > 0.005);
    const gelijk = eigen.find((d) => Math.abs((d.rest ?? d.bedrag) - over) < 0.01);
    for (const d of gelijk ? [gelijk] : eigen) {
      if (over <= 0.005) break;
      const r = d.rest ?? d.bedrag, af = Math.min(r, over);
      d.rest = rond(r - af); over = rond(over - af);
      (d.terugboekingen ||= []).push({ datum: b.datum, bedrag: b.bedrag });
    }
    if (over > 0.005) onverrekend.push({ ...b, rest: -over });
  }
  for (const d of dubbel) if (d.rest == null) d.rest = d.bedrag;
  const dubbelOpen = dubbel.filter((d) => d.rest > 0.005).map((d) => ({
    praktijk_id: d.praktijk_id, praktijk: pn[d.praktijk_id] || d.praktijk_id, datum: d.datum, bedrag: d.rest, betaald_bedrag: d.bedrag,
    omschrijving: d.omschrijving, iban: d.tegenrekening, nota: d.nota, reden: d.reden, terugboekingen: d.terugboekingen || [],
    voorstel: d.nota ? `Terugbetaling dubbel betaalde nota ${d.nota}` : 'Terugbetaling onbekende betaling',
  })).sort((a, b) => a.praktijk_id.localeCompare(b.praktijk_id) || a.datum.localeCompare(b.datum));
  const verrekend = dubbel.filter((d) => d.rest <= 0.005).map((d) => ({ praktijk_id: d.praktijk_id, praktijk: pn[d.praktijk_id] || d.praktijk_id, datum: d.datum, bedrag: d.bedrag, nota: d.nota, terugboekingen: d.terugboekingen || [] }));
  const openstaand = N.filter((n) => n.status === 'definitief' && n.bedrag > 0 && n.datum <= vandaag && rest(n) > 0.5)
    .map((n) => ({ nummer: n.nummer, praktijk_id: n.praktijk_id, praktijk: pn[n.praktijk_id] || n.praktijk_id, datum: n.datum, periode: n.periode, bedrag: n.bedrag, betaald: n.betaald, rest: rest(n) }));
  const terugTeBetalen = N.filter((n) => n.status === 'definitief' && n.bedrag < 0 && rond(-n.bedrag + n.betaald) > 0.5)
    .map((n) => ({ nummer: n.nummer, praktijk_id: n.praktijk_id, praktijk: pn[n.praktijk_id] || n.praktijk_id, datum: n.datum, bedrag: n.bedrag, rest: rond(n.bedrag - n.betaald) }));
  const status = {};
  for (const n of N) {
    let s;
    if (n.status === 'concept') s = 'concept';
    else if (n.bedrag < 0) s = rond(-n.bedrag + n.betaald) <= 0.5 ? 'terugbetaald' : 'terug_te_betalen';
    else if (rest(n) <= 0.5) s = n.dubbel.some((d) => (d.rest ?? d.bedrag) > 0.005) ? 'dubbel' : 'betaald';
    else if (n.betaald > 0) s = 'deels';
    else s = n.datum > vandaag ? 'nog_niet' : 'open';
    status[n.nummer] = { status: s, betaald: n.betaald, betalingen: n.betalingen.map((b) => ({ datum: b.datum, bedrag: b.bedrag })), dubbel: n.dubbel.map((d) => ({ datum: d.datum, bedrag: d.bedrag, rest: d.rest })) };
  }
  return {
    jaar, venster: [`${jaar}-01-01`, `${jaar + 1}-03-31`], n_betalingen: bet.length,
    openstaand, dubbel: dubbelOpen, dubbel_totaal: rond(dubbelOpen.reduce((a, d) => a + d.bedrag, 0)),
    openstaand_totaal: rond(openstaand.reduce((a, n) => a + n.rest, 0)),
    verrekend, onverrekende_terugboekingen: onverrekend.map((b) => ({ praktijk_id: b.praktijk_id, praktijk: pn[b.praktijk_id] || b.praktijk_id, datum: b.datum, bedrag: b.bedrag, rest: b.rest, omschrijving: b.omschrijving })),
    terug_te_betalen: terugTeBetalen, buiten_jaar: buitenJaar.length, status,
  };
}

// ── GET planning ────────────────────────────────────────────────────────────
async function planningGet(env, url) {
  const ent = vEnt(url.searchParams.get('entiteit'));
  const jaar = vJaar(url.searchParams.get('jaar') || new Date(env.nu).getUTCFullYear());
  // wv1894: laatste_mutatie mee in de eerste rondgang (in de Function los, na het sjabloon)
  const [plannen, prakt, st, notas, irb, volgend, standaard, ent_, vorigPlan, vorigBeg, jl, uitg, laatsteMutatie] = await Promise.all([
    plannenVan(env, ent, jaar), praktijkenVol(env, ent), standenKaart(env),
    q(env, 'select id, nummer, praktijk_id, datum, soort, periode, bedrag, status from nota where entiteit=? and jaar=? order by nummer', ent, jaar),
    inRekening(env, ent, jaar), volgendNummer(env, ent, jaar), standaardDeelnemers(env, ent, jaar), entiteitInfo(env, ent),
    q1(env, "select id, versie, totaal from plan where entiteit=? and jaar=? and status='vastgesteld' order by id desc limit 1", ent, jaar - 1),
    q1(env, "select versie, status, totaal from begroting where entiteit=? and jaar=? order by (status='vastgesteld') desc, gemaakt_op desc limit 1", ent, jaar - 1),
    q(env, 'select jaar, bedrag, bron from jaarlast where entiteit=? and jaar in (?,?) order by jaar', ent, jaar - 2, jaar - 1),
    q(env, "select cast(strftime('%Y', bm.boekdatum) as integer) as jaar, bt.soort, round(sum(bt.bedrag),2) as bedrag, count(*) as n from bank_toewijzing bt join bankmutatie bm on bm.id=bt.bankmutatie_id where bm.entiteit=? and bt.praktijk_id is null and bt.bedrag<0 and cast(strftime('%Y', bm.boekdatum) as integer) in (?,?) group by jaar, bt.soort order by bt.soort, jaar", ent, jaar - 2, jaar - 1),
    q1(env, 'select max(boekdatum) as d from bankmutatie where entiteit=?', ent),
  ]);
  const standen = {};
  for (const p of prakt) standen[p.id] = { [peil(jaar - 1)]: st.m[p.id]?.[peil(jaar - 1)] ?? null, [peil(jaar)]: st.m[p.id]?.[peil(jaar)] ?? null, [peil(jaar + 1)]: st.m[p.id]?.[peil(jaar + 1)] ?? null };
  const uit = plannen.map((p) => ({ ...p, uitkomst: planUitkomst(p, st.m) }));
  // sjabloon voor een nieuw concept: posten van het nieuwste plan van dit of vorig jaar
  let sjabloon = null;
  if (!plannen.length) {
    const vorige = await plannenVan(env, ent, jaar - 1);
    const bron = vorige.filter((p) => p.status !== 'vervallen').pop() || vorige.pop();
    if (bron) sjabloon = { van: `${bron.jaar} ${bron.versie}`, marge_pct: bron.marge_pct, termijn: bron.termijn, posten: bron.posten.map((x) => ({ omschrijving: x.omschrijving, bedrag: x.bedrag, per: x.per, aantal: x.aantal, indexatie_pct: x.indexatie_pct, opmerking: x.opmerking })) };
  }
  return json({
    ok: true, nu: nu(env), entiteit: ent, jaar, entiteit_info: ent_, praktijken: prakt, standaard_deelnemers: standaard,
    peildata: [peil(jaar - 1), peil(jaar), peil(jaar + 1)], standen,
    sleutel: berekenSleutel(st.m, standaard, jaar, 'begroting'),
    plannen: uit, sjabloon, notas, in_rekening: irb, volgend_nummer: volgend,
    vorig: { jaar: jaar - 1, plan: vorigPlan || null, begroting: vorigBeg || null, jaarlast: jl, uitgaven: uitg, laatste_mutatie: laatsteMutatie ? laatsteMutatie.d : null },
  });
}

// ── POST planning (concept opslaan) ─────────────────────────────────────────
// ── correctie / eindafrekening ──────────────────────────────────────────────
async function correctieVoorstel(env, { ent, jaar, modus, totK, extra, jaarlast }) {
  // wv1894: standen, plannen, nota's, volgend nummer en (eindafrekening) de standaarddeelnemers en de jaarlast in één keer; in de Function na elkaar
  const eind = modus !== 'tot_heden';
  const [st, plannen, irb, volgend, standaard, jlRij] = await Promise.all([standenKaart(env), plannenVan(env, ent, jaar), inRekening(env, ent, jaar), volgendNummer(env, ent, jaar),
    eind ? standaardDeelnemers(env, ent, jaar) : null, eind ? q1(env, 'select bedrag, bron, opmerking from jaarlast where entiteit=? and jaar=?', ent, jaar) : null]);
  const plan = plannen.filter((p) => p.status === 'vastgesteld').pop() || null;
  const uit = { modus, jaar, plan: plan ? { id: plan.id, versie: plan.versie, status: plan.status, totaal: null } : null, volgend_nummer: volgend, rijen: [], melding: null, kan_aanmaken: false };
  let sleutel, grond;
  if (modus === 'tot_heden') {
    if (!plan) { uit.melding = `Er is geen vastgesteld plan voor ${jaar}; stel eerst de begroting vast (tab Planning).`; return uit; }
    const u = planUitkomst(plan, st.m);
    uit.plan.totaal = u.totaal;
    sleutel = u.sleutel;
    grond = rond(u.totaal * totK / 4 + extra);
    uit.grondslag = { plantotaal: u.totaal, tot_kwartaal: totK, extra, basis: grond };
  } else {
    const ids = plan ? plan.deelnemers.filter((d) => d.actief).map((d) => d.praktijk_id) : standaard;
    sleutel = berekenSleutel(st.m, ids, jaar, 'eindafrekening');
    const jl = jlRij;
    uit.jaarlast_db = jl || null;
    const j = jaarlast != null ? jaarlast : jl ? jl.bedrag : null;
    grond = j;
    uit.grondslag = { jaarlast: j, deelnemers_bron: plan ? `plan ${plan.versie}` : 'deelname' };
    if (sleutel.status === 'ontbreekt') uit.melding = sleutel.melding;
    else if (j == null) uit.melding = 'Vul de jaarlast in (totale kosten volgens de boekhouder).';
  }
  uit.sleutel = { status: sleutel.status, toelichting: sleutel.toelichting, melding: sleutel.melding, peildata: sleutel.peildata, som: sleutel.som };
  const ids = [...new Set([...Object.keys(sleutel.per), ...Object.keys(irb)])].sort();
  let tDoel = 0, tIrb = 0, tVer = 0;
  for (const id of ids) {
    const s = sleutel.per[id];
    const aandeel = s ? s.aandeel : 0;
    const doel = aandeel != null && grond != null ? rond(aandeel * grond) : null;
    const r = irb[id] || { bedrag: 0, nummers: [], notas: [] };
    const verschil = doel != null ? heel(doel - r.bedrag) : null;
    uit.rijen.push({ praktijk_id: id, deelnemer: !!s, grondslag: s ? s.grondslag : null, stand_a: s ? s.stand_a : null, stand_b: s ? s.stand_b : null, aandeel, doel, in_rekening: r.bedrag, nummers: r.nummers, notas: r.notas, correctie: verschil });
    tDoel += doel || 0; tIrb += r.bedrag; tVer += verschil || 0;
  }
  uit.totaal = { doel: rond(tDoel), in_rekening: rond(tIrb), correctie: tVer };
  uit.kan_aanmaken = !uit.melding && uit.rijen.some((r) => r.correctie != null);
  return uit;
}
function leesCorrectieParams(src, get) {
  const ent = vEnt(get('entiteit')), jaar = vJaar(get('jaar'));
  const modus = get('modus') === 'eindafrekening' ? 'eindafrekening' : 'tot_heden';
  const tk = get('tot_kwartaal');
  const totK = tk == null || tk === '' ? 4 : vNum(tk, 'tot_kwartaal', 1, 4);
  if (!Number.isInteger(totK)) throw new Gebruikersfout('tot_kwartaal ongeldig');
  const ex = get('extra');
  const extra = ex == null || ex === '' ? 0 : vNum(ex, 'extra', -1e7, 1e7);
  const jl = get('jaarlast');
  const jaarlast = jl == null || jl === '' ? null : vNum(jl, 'jaarlast', 0, 1e8);
  return { ent, jaar, modus, totK, extra, jaarlast };
}
async function correctieGet(env, url) {
  const p = leesCorrectieParams(url, (k) => url.searchParams.get(k));
  const [voorstel, ba, prakt, ei] = await Promise.all([correctieVoorstel(env, p), betaalAnalyse(env, p.ent, p.jaar), praktijkenVol(env, p.ent), entiteitInfo(env, p.ent)]);
  return json({ ok: true, nu: nu(env), entiteit: p.ent, entiteit_info: ei, praktijken: prakt, ...voorstel, betaalanalyse: ba });
}

// ── patiënten ───────────────────────────────────────────────────────────────
async function patientenGet(env) {
  const [st, prakt, deel] = await Promise.all([standenKaart(env), praktijken(env), q(env, 'select entiteit, praktijk_id from deelname')]);
  return json({ ok: true, nu: nu(env), praktijken: prakt, standen: st.rijen, deelname: deel });
}

// ── nota's ──────────────────────────────────────────────────────────────────
async function notasGet(env, url) {
  const ent = vEnt(url.searchParams.get('entiteit'));
  const jaar = vJaar(url.searchParams.get('jaar') || new Date(env.nu).getUTCFullYear());
  const [notas, ba, prakt, ei, jaren] = await Promise.all([
    q(env, 'select * from nota where entiteit=? and jaar=? order by nummer', ent, jaar),
    betaalAnalyse(env, ent, jaar), praktijkenVol(env, ent), entiteitInfo(env, ent),
    q(env, 'select distinct jaar from nota where entiteit=? order by jaar', ent),
  ]);
  const vz = await vzPerNota(env, notas.map((n) => n.id));
  const uit = notas.map((n) => ({ ...n, betaal: n.status === 'vervallen' ? { status: 'vervallen' } : (ba.status[n.nummer] || { status: '—' }), verzending: vz[n.id] || null }));
  return json({ ok: true, nu: nu(env), entiteit: ent, jaar, jaren: jaren.map((r) => r.jaar), entiteit_info: ei, praktijken: prakt, notas: uit, betaalanalyse: { ...ba, status: undefined } });
}

const VZ_ACTIEF = ['wacht', 'bezig', 'concept', 'verzonden', 'wacht_op_adres', 'onzeker', 'auto_gevraagd', 'auto_vrij', 'verzenden', 'auto_verstuurd', 'onzeker_verzonden', 'verstuurd_door_david'];
const VZ_OPNIEUW_VAN = ['wacht', 'concept', 'verzonden', 'wacht_op_adres', 'onzeker', 'auto_gevraagd', 'auto_vrij', 'auto_verstuurd', 'onzeker_verzonden', 'verstuurd_door_david'];
const VZ_ANNULEER_VAN = ['wacht', 'wacht_op_adres', 'auto_gevraagd', 'auto_vrij'];   // wv921: tot de pod hem reserveert (verzenden)
const VZ_AUTO_ENT = ['SLOEL'];
const VZ_AUTO_VERS_MS = 15 * 60 * 1000;   // hartslag pot_pod_stand 'auto' (de pod schrijft hem elke 5 min)
const VZ_PDF_MAX = 250 * 1024;            // bytes
const VZ_BODY_MAX = 1500000;              // tekens (base64 van 250 KB past ruim)
const VZ_VAN = { SLOEL: '"David Schaap" <dokterschaap@gmail.com>' };   // gemeten: zo verstuurde David de SLOEL-nota's (20-1 en 21-9-2026)
const VZ_KOLOMMEN = 'id, nota_id, entiteit, nummer, praktijk_id, status, niet_voor, plan_datum, onderwerp, van, pdf_naam, pdf_sha256, pdf_bytes, aangevraagd_op, reden, geclaimd_op, pogingen, aan, cc, bron_pagina, concept_id, thread_id, concept_op, verzonden_op, opmerking, fout, bijgewerkt_op, auto, vrijgave_id, message_id';

// Zelfde regel als notaBestand in pot.html (de knoppen PDF en ZIP), zodat het bestand in Gmail dezelfde naam heeft.
function vzBestand(ent, n, p) {
  p = p || {};
  return `${ent} - ${n.nummer} - ${p.naam_brief || p.naam || n.praktijk_id} - ${p.tav || ''}`.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+-\s*$/, '').trim() + '.pdf';
}
// Onderwerp en tekst in Davids eigen woorden (gemeten op zijn SLOEL-mails van 20-1 en 21-9-2026); per soort en teken.
function vzTekst(ent, n) {
  const groet = '\n\nMet vriendelijke groet,\n\nDavid';
  const jaar = n.jaar;
  if (ent === 'SLOEL') {
    if (n.bedrag < 0) {
      const wat = n.soort === 'eindafrekening' ? `de eindafrekening van de doorbelaste huur over ${jaar}` : `de correctie van de doorbelaste huur over ${jaar}`;
      return { onderwerp: `Creditnota SLOEL - ${n.soort === 'eindafrekening' ? 'Eindafrekening' : 'Correctie'} doorbelaste huur ${jaar}`,
        bericht: `Hallo allen,\n\nBij deze ${wat}. Jullie krijgen geld terug; dat maak ik binnen 14 dagen over. De berekening staat op de nota.${groet}` };
    }
    if (n.soort === 'eindafrekening') return { onderwerp: `Factuur SLOEL - Eindafrekening doorbelaste huur ${jaar}`,
      bericht: `Hallo allen,\n\nBij deze de eindafrekening van de doorbelaste huur over ${jaar}; de berekening staat op de factuur. Graag betaling per ommegaande.${groet}` };
    if (n.soort === 'correctie') return { onderwerp: `Factuur SLOEL - Correctie doorbelaste huur ${jaar}`,
      bericht: `Hallo allen,\n\nBij deze de correctiefactuur voor de doorbelaste huur over ${jaar}; de berekening staat op de factuur. Graag betaling per ommegaande.${groet}` };
    return { onderwerp: 'Factuur SLOEL - Doorbelaste huur', bericht: `Hallo allen,\n\nBij deze wederom een factuur voor de doorbelaste huur - graag betaling per ommegaande.${groet}` };
  }
  // POT en KM factureren (nog) niet; een neutrale tekst voor als dat verandert.
  const titel = n.titel || NOTA_TITEL[ent] || 'NOTA';
  const kort = titel.charAt(0) + titel.slice(1).toLowerCase();
  return { onderwerp: `Nota ${ent} - ${kort} ${n.periode || jaar}`,
    bericht: `Hallo allen,\n\nBij deze de nota ${n.nummer} (${kort.toLowerCase()} ${n.periode || jaar}). ${n.bedrag < 0 ? 'Het bedrag maak ik binnen 14 dagen over.' : 'Graag betaling binnen 14 dagen.'}${groet}` };
}
// 07:00 Europe/Amsterdam op `datum` als UTC-tijd (zomer +2, winter +1; Intl rekent de wissel).
// Mag "op die dag zelf versturen"? { kan, reden }. De hartslag van de pod moet vers en 'aan' zijn (schakelaar én verzendgeheim).
async function vzAutoKan(env, ent) {
  if (!VZ_AUTO_ENT.includes(ent)) return { kan: false, reden: `alleen ${VZ_AUTO_ENT.join(', ')}-nota's kunnen vanzelf de deur uit` };
  let s = null;
  try { s = await q1(env, "select waarde, op from pot_pod_stand where sleutel='auto'"); } catch { s = null; }
  if (!s || s.waarde !== 'aan' || !(env.nu.getTime() - Date.parse(s.op) < VZ_AUTO_VERS_MS)) return { kan: false, reden: 'automatisch versturen staat nu uit bij Socev' };
  return { kan: true, reden: null };
}
function vzKopie(n, p) {
  return { ...vzTekst(n.entiteit, n), van: VZ_VAN[n.entiteit] || null, pdf_naam: vzBestand(n.entiteit, n, p) };
}
async function vzVoorbeeld(env, url) {
  const id = urlInt(url, 'nota_id', 1, 1e9, null);
  if (id == null) throw new Gebruikersfout('nota_id ontbreekt');
  // wv1894: nota eerst, dan praktijk en pod-hartslag in één rondgang (in de Function drie na elkaar)
  const n = await q1(env, 'select id, entiteit, jaar, nummer, praktijk_id, datum, soort, periode, titel, bedrag, status from nota where id=?', id);
  if (!n) throw new Gebruikersfout('nota niet gevonden', 404);
  const [p, auto] = await Promise.all([q1(env, 'select id, naam, naam_brief, tav, email from praktijk where id=?', n.praktijk_id), vzAutoKan(env, n.entiteit)]);
  return json({ ok: true, nota_id: n.id, nummer: n.nummer, ...vzKopie(n, p), adres_in_app: p ? p.email || null : null, auto });
}
// Laatste verzending per nota (zonder PDF en tekst) voor de lijst op tab Nota's.
async function vzPerNota(env, ids) {
  if (!ids.length) return {};
  const uit = {};
  for (let i = 0; i < ids.length; i += 90) {
    const deel = ids.slice(i, i + 90);
    const r = await q(env, `select ${VZ_KOLOMMEN} from nota_verzending where nota_id in (${deel.map(() => '?').join(',')}) order by id`, ...deel);
    for (const x of r) uit[x.nota_id] = x;   // oplopend id: de laatste wint
  }
  return uit;
}

// ════════════════════════════════════════════════════════════════════════════
// Schrijvende routes (wv1933, P3 + P4) — letterlijk uit de Function; env.schrijf(batch) is één D1-transactie (zie de kop).
// ════════════════════════════════════════════════════════════════════════════
const VZ = require('./pot-verzend.js');
const crypto = require('crypto');
const VZ_PDF_MAX_POD = 45 * 1024;          // bytes; de Function nam 250 kB, het doorgeefluik neemt JSON tot 64 kB (bouwplan § 3.2)
const VZ_B64_MAX_POD = Math.ceil(VZ_PDF_MAX_POD / 3) * 4;
function vTekst(x, naam, max = MAX_TEKST, verplicht = false) {
  if (x === null || x === undefined || String(x).trim() === '') { if (verplicht) throw new Gebruikersfout(`${naam} ontbreekt`); return null; }
  const s = String(x).trim();
  if (s.length > max) throw new Gebruikersfout(`${naam} te lang (max. ${max} tekens)`);
  return s;
}
function vDatum(x, naam) {
  const s = String(x || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z')) || new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) !== s) throw new Gebruikersfout(`${naam} ongeldig (JJJJ-MM-DD)`);
  return s;
}
function vNummer(x) { const s = String(x ?? '').trim(); if (!/^\d{7}$/.test(s)) throw new Gebruikersfout('startnummer moet 7 cijfers zijn (JJJJnnn)'); return s; }
const st = (sql, ...params) => ({ sql, params });

// ── POST planning (concept opslaan) ─────────────────────────────────────────
function leesPosten(arr) {
  if (!Array.isArray(arr) || arr.length < 1 || arr.length > 60) throw new Gebruikersfout('posten: 1 tot 60 regels');
  return arr.map((p, i) => {
    const per = String(p.per || 'jaar');
    if (!PER_WAARDEN.includes(per)) throw new Gebruikersfout(`post ${i + 1}: per ongeldig`);
    const r = { volgorde: i + 1, omschrijving: vTekst(p.omschrijving, `post ${i + 1}: omschrijving`, 200, true), bedrag: vNum(p.bedrag, `post ${i + 1}: bedrag`, -1e7, 1e7), per,
      aantal: vNum(p.aantal ?? 1, `post ${i + 1}: aantal`, 0, 1000), indexatie_pct: vNum(p.indexatie_pct ?? 0, `post ${i + 1}: indexatie`, -100, 100), opmerking: vTekst(p.opmerking, `post ${i + 1}: opmerking`, 300) };
    r.jaarbedrag = postJaarbedrag(r);
    return r;
  });
}
async function planningPost(env, b) {
  const ent = vEnt(b.entiteit), jaar = vJaar(b.jaar);
  const marge = vNum(b.marge_pct ?? 0, 'veiligheidsmarge', 0, 100);
  const termijn = b.termijn === 'maand' ? 'maand' : 'kwartaal';
  const posten = leesPosten(b.posten);
  const opmerking = vTekst(b.opmerking, 'opmerking');
  // wv1933: praktijken, standen, het bestaande plan en de bezette versies in één rondgang (in de Function na elkaar)
  const planId = b.plan_id != null && b.plan_id !== '' ? vNum(b.plan_id, 'plan_id', 1, 1e9) : null;
  const [prakt, st0, bestaand0, bezetR] = await Promise.all([praktijken(env), standenKaart(env), planId != null ? q1(env, 'select * from plan where id=?', planId) : null,
    q(env, 'select versie from plan where entiteit=? and jaar=?', ent, jaar)]);
  const geldig = new Set(prakt.map((p) => p.id));
  if (!Array.isArray(b.deelnemers) || !b.deelnemers.length) throw new Gebruikersfout('deelnemers ontbreken');
  const deeln = []; const gezien = new Set();
  for (const d of b.deelnemers) { const id = String(d.praktijk_id || ''); if (!geldig.has(id)) throw new Gebruikersfout('onbekende praktijk ' + id); if (gezien.has(id)) continue; gezien.add(id); deeln.push({ praktijk_id: id, actief: d.actief ? 1 : 0 }); }
  if (!deeln.some((d) => d.actief)) throw new Gebruikersfout('kies minstens één deelnemer');
  const sl = berekenSleutel(st0.m, deeln.filter((d) => d.actief).map((d) => d.praktijk_id), jaar, 'begroting');
  const tot = planTotalen(posten, marge);
  const n = termijnenPerJaar(termijn);
  let bestaand = null;
  if (planId != null) {
    bestaand = bestaand0;
    if (!bestaand || bestaand.entiteit !== ent || bestaand.jaar !== jaar) throw new Gebruikersfout('plan hoort niet bij deze entiteit/dit jaar', 409);
  }
  const stmts = [];
  let planRef, versie, nieuwe = false;
  if (bestaand && bestaand.status === 'concept') {
    versie = bestaand.versie;
    stmts.push(st('update plan set termijn=?, marge_pct=?, totaal=?, sleutel_toelichting=?, gemaakt_op=?, opmerking=? where id=? and status=?', termijn, marge, tot.totaal, sl.toelichting, vandaagStr(env), opmerking, bestaand.id, 'concept'));
    stmts.push(st('delete from plan_post where plan_id=?', bestaand.id));
    stmts.push(st('delete from plan_deelnemer where plan_id=?', bestaand.id));
    planRef = { sql: '?', p: [bestaand.id] };
  } else {
    // nieuw concept (of nieuwe versie naast een vastgesteld/vervallen plan; dat wordt nooit overschreven)
    nieuwe = true;
    const gewenst = vTekst(b.versie, 'versie', 60) || `concept-${vandaagStr(env)}`;
    const bezet = new Set(bezetR.map((r) => r.versie));
    versie = gewenst; for (let i = 2; bezet.has(versie); i++) versie = `${gewenst}-${i}`;
    stmts.push(st('insert into plan (entiteit, jaar, versie, status, termijn, marge_pct, totaal, sleutel_toelichting, gemaakt_op, opmerking) values (?,?,?,?,?,?,?,?,?,?)',
      ent, jaar, versie, 'concept', termijn, marge, tot.totaal, sl.toelichting, vandaagStr(env), opmerking ?? (bestaand ? `nieuwe versie op basis van ${bestaand.versie}` : null)));
    planRef = { sql: '(select id from plan where entiteit=? and jaar=? and versie=?)', p: [ent, jaar, versie] };
  }
  for (const p of posten) stmts.push(st(`insert into plan_post (plan_id, volgorde, omschrijving, bedrag, per, aantal, indexatie_pct, jaarbedrag, opmerking) values (${planRef.sql},?,?,?,?,?,?,?,?)`,
    ...planRef.p, p.volgorde, p.omschrijving, p.bedrag, p.per, p.aantal, p.indexatie_pct, p.jaarbedrag, p.opmerking));
  for (const d of deeln) {
    const s = d.actief ? sl.per[d.praktijk_id] : null;
    stmts.push(st(`insert into plan_deelnemer (plan_id, praktijk_id, actief, grondslag, aandeel, termijnbedrag) values (${planRef.sql},?,?,?,?,?)`,
      ...planRef.p, d.praktijk_id, d.actief, s ? s.grondslag : null, s && s.aandeel != null ? s.aandeel : null, s && s.aandeel != null ? heel(s.aandeel * tot.totaal / n) : null));
  }
  await env.schrijf(stmts);
  const plan = (await plannenVan(env, ent, jaar)).find((p) => p.versie === versie);
  return json({ ok: true, nieuw: nieuwe, plan: { ...plan, uitkomst: planUitkomst(plan, st0.m) }, melding: bestaand && bestaand.status !== 'concept' ? `plan ${bestaand.versie} is ${bestaand.status} en blijft ongewijzigd; opgeslagen als nieuwe versie ${versie}` : null });
}

// ── POST planning/vaststellen ───────────────────────────────────────────────
// De REST-batch is atomair (gemeten 29-10), dus dezelfde volgorde als de Function: plan vastgesteld + nota's in één transactie.
async function vaststellen(env, b) {
  const planId = vNum(b.plan_id, 'plan_id', 1, 1e9);
  const plan0 = await q1(env, 'select * from plan where id=?', planId);
  if (!plan0) throw new Gebruikersfout('plan niet gevonden', 404);
  if (plan0.status === 'vervallen') throw new Gebruikersfout('dit plan is vervallen; maak eerst een nieuwe versie', 409);
  const ent = plan0.entiteit, jaar = plan0.jaar;
  // wv1933: plannen, standen, bestaande voorschotnota's en versienamen in één rondgang
  const [plannen, st0, bestaand, alleVersies] = await Promise.all([plannenVan(env, ent, jaar), standenKaart(env),
    q(env, "select praktijk_id, periode from nota where entiteit=? and jaar=? and soort='voorschot' and status<>'vervallen'", ent, jaar),
    q(env, 'select versie from plan where entiteit=? and jaar=?', ent, jaar)]);
  const plan = plannen.find((p) => p.id === planId);
  if (plan.termijn !== 'kwartaal') throw new Gebruikersfout('nota\'s maken kan (nog) alleen per kwartaal');
  if (!plan.posten.length) throw new Gebruikersfout('plan heeft geen kostenposten');
  const start = vNummer(b.startnummer);
  if (!Array.isArray(b.kwartalen)) throw new Gebruikersfout('kwartalen ontbreken');
  const kwartalen = [...new Set(b.kwartalen.map((k) => vNum(k, 'kwartaal', 1, 4)))].map(Number).filter(Number.isInteger).sort();
  const datums = {};
  for (const k of kwartalen) datums[k] = vDatum((b.datums || {})[k] || `${jaar}-${String(3 * k - 2).padStart(2, '0')}-01`, `factuurdatum kwartaal ${k}`);
  const inplannen = b.inplannen !== false;
  const uitk = planUitkomst(plan, st0.m);
  if (uitk.sleutel.status === 'ontbreekt') throw new Gebruikersfout('patiëntstanden ontbreken: ' + (uitk.sleutel.melding || ''), 409);
  const actief = plan.deelnemers.filter((d) => d.actief).map((d) => d.praktijk_id);
  const heeft = new Set(bestaand.map((r) => r.praktijk_id + '|' + r.periode));
  const vandaag = vandaagStr(env);
  const teMaken = [], overgeslagen = [];
  let nr = Number(start);
  for (const k of kwartalen) for (const id of actief) {
    const periode = `${jaar}-Q${k}`;
    if (heeft.has(id + '|' + periode)) { overgeslagen.push({ praktijk_id: id, periode }); continue; }
    const bedrag = uitk.sleutel.per[id].termijnbedrag;
    const regels = [{ omschrijving: OMSCHRIJVING_VOORSCHOT[ent](jaar, k), bedrag, jaar }];
    if (inplannen && datums[k] > vandaag) regels.push({ omschrijving: `LET OP: Inplannen op ${datums[k].split('-').reverse().join('-')}`, tekst: true });
    teMaken.push({ nummer: String(nr++), praktijk_id: id, datum: datums[k], periode, regels, bedrag });
  }
  if (teMaken.length) {
    const nummers = teMaken.map((n) => n.nummer);
    const [botsing, volgend] = await Promise.all([q(env, `select nummer from nota where entiteit=? and nummer in (${nummers.map(() => '?').join(',')})`, ent, ...nummers), volgendNummer(env, ent, jaar)]);
    if (botsing.length) throw new Gebruikersfout(`nummer(s) al in gebruik: ${botsing.map((r) => r.nummer).join(', ')} — kies een ander startnummer (volgend vrij: ${volgend})`, 409);
  }
  // een conceptnaam krijgt bij vaststellen een versienaam zoals de bestaande (v1-2026-01-20, v2-2026-10-13, …)
  let versie = plan.versie;
  if (plan.status === 'concept' && /^concept/i.test(versie)) {
    const alle = alleVersies.map((r) => r.versie);
    let nr = alle.filter((v) => /^v\d+-/.test(v)).length + 1;
    versie = `v${nr}-${vandaag}`; while (alle.includes(versie)) versie = `v${++nr}-${vandaag}`;
  }
  const stmts = [
    st("update plan set status='vervallen' where entiteit=? and jaar=? and status='vastgesteld' and id<>?", ent, jaar, planId),
    st("update plan set status='vastgesteld', versie=?, vastgesteld_op=coalesce(case when status='vastgesteld' then vastgesteld_op end, ?), totaal=?, sleutel_toelichting=? where id=?",
      versie, vandaag, uitk.totaal, uitk.sleutel.toelichting || plan.sleutel_toelichting, planId),
  ];
  for (const d of plan.deelnemers) {
    const s = d.actief ? uitk.sleutel.per[d.praktijk_id] : null;
    stmts.push(st('update plan_deelnemer set grondslag=?, aandeel=?, termijnbedrag=? where plan_id=? and praktijk_id=?', s ? s.grondslag : null, s ? s.aandeel : null, s ? s.termijnbedrag : null, planId, d.praktijk_id));
  }
  const nuTijd = nu(env);
  for (const n of teMaken) stmts.push(st('insert into nota (entiteit, jaar, nummer, praktijk_id, datum, soort, periode, titel, regels, bedrag, status, bron, plan_id, aangemaakt_op, opmerking) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ent, jaar, n.nummer, n.praktijk_id, n.datum, 'voorschot', n.periode, NOTA_TITEL[ent], JSON.stringify(n.regels), n.bedrag, 'definitief', 'pagina', planId, nuTijd, `plan ${versie}`));
  await env.schrijf(stmts);
  const [notas, verse] = await Promise.all([teMaken.length ? q(env, `select * from nota where entiteit=? and nummer in (${teMaken.map(() => '?').join(',')}) order by nummer`, ent, ...teMaken.map((n) => n.nummer)) : [],
    plannenVan(env, ent, jaar)]);
  const verseplan = verse.find((p) => p.id === planId);
  return json({ ok: true, plan: { ...verseplan, uitkomst: planUitkomst(verseplan, st0.m) }, notas, overgeslagen, totaal_notas: rond(notas.reduce((a, n) => a + n.bedrag, 0)) });
}

// ── POST correctie ──────────────────────────────────────────────────────────
const eur0 = (x) => (x < 0 ? '-' : '') + '€' + new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 0 }).format(Math.abs(Math.round(x)));
const pct2 = (x) => new Intl.NumberFormat('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x * 100) + '%';
const getal1 = (x) => new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 1 }).format(x);
async function correctiePost(env, b) {
  const p = leesCorrectieParams(b, (k) => (b[k] == null ? null : String(b[k])));
  const start = vNummer(b.startnummer);
  const datum = vDatum(b.datum || vandaagStr(env), 'datum');
  const omschrijving = vTekst(b.omschrijving, 'omschrijving', 200) || (p.modus === 'eindafrekening' ? `Eindafrekening ${p.jaar}` : `Correctie doorbelaste huur Mulderij ${p.jaar} - tot en met kwartaal ${p.totK}`);
  const toelichting = vTekst(b.toelichting, 'toelichting', 1000);
  const extraOms = vTekst(b.extra_omschrijving, 'omschrijving extra bedrag', 200);
  if (!Array.isArray(b.regels) || !b.regels.length || b.regels.length > 20) throw new Gebruikersfout('regels: 1 tot 20 praktijken');
  const v = await correctieVoorstel(env, p);
  if (v.melding) throw new Gebruikersfout(v.melding, 409);
  const rijM = Object.fromEntries(v.rijen.map((r) => [r.praktijk_id, r]));
  const gezien = new Set();
  const regels = [];
  for (const r of b.regels) {
    const id = String(r.praktijk_id || '');
    if (!rijM[id]) throw new Gebruikersfout('praktijk hoort niet bij dit voorstel: ' + id);
    if (gezien.has(id)) continue; gezien.add(id);
    const bedrag = heel(vNum(r.bedrag, 'bedrag ' + id, -1e6, 1e6));
    if (Math.abs(bedrag) < 1) continue; // < € 1 wordt overgeslagen
    regels.push({ id, bedrag, rij: rijM[id] });
  }
  if (!regels.length) throw new Gebruikersfout('geen bedragen van € 1 of meer');
  const nummers = regels.map((_, i) => String(Number(start) + i));
  const botsing = await q(env, `select nummer from nota where entiteit=? and nummer in (${nummers.map(() => '?').join(',')})`, p.ent, ...nummers);
  if (botsing.length) throw new Gebruikersfout(`nummer(s) al in gebruik: ${botsing.map((x) => x.nummer).join(', ')} — volgend vrij: ${v.volgend_nummer}`, 409);
  const soort = p.modus === 'eindafrekening' ? 'eindafrekening' : 'correctie';
  const periode = p.modus === 'eindafrekening' ? String(p.jaar) : `${p.jaar}-Q1/Q${p.totK}`;
  const nuTijd = nu(env);
  const stmts = [];
  regels.forEach((r, i) => {
    const R = r.rij;
    const sub = [];
    if (p.modus === 'eindafrekening') {
      sub.push(`uw aandeel in de kosten ${p.jaar}: ${pct2(R.aandeel)} van ${eur0(v.grondslag.jaarlast)} = ${eur0(R.doel)}`);
      if (R.grondslag != null) sub.push(`verdeelsleutel: gemiddelde patiëntenstand 1-1-${p.jaar} en 1-1-${p.jaar + 1}: ${getal1(R.grondslag)} van ${getal1(v.sleutel.som)}`);
    } else {
      sub.push(`juist bedrag t/m kwartaal ${p.totK}: ${pct2(R.aandeel || 0)} van ${eur0(v.grondslag.basis)} = ${eur0(R.doel || 0)}`);
      if (R.grondslag != null && v.sleutel.som) sub.push(`verdeelsleutel ${p.jaar}: ${v.sleutel.toelichting || 'patiëntenstand'}: ${getal1(R.grondslag)} van ${getal1(v.sleutel.som)}`);
      if (p.extra) sub.push(`waarvan extra${extraOms ? ' (' + extraOms + ')' : ''}: ${pct2(R.aandeel || 0)} van ${eur0(p.extra)} = ${eur0((R.aandeel || 0) * p.extra)}`);
    }
    sub.push(`eerder in rekening gebracht${R.nummers.length ? ' (' + R.nummers.join(', ') + ')' : ''}: ${eur0(R.in_rekening)}`);
    if (r.bedrag !== R.correctie && R.correctie != null) sub.push(`handmatig aangepast (voorstel ${eur0(R.correctie)})`);
    const nr = [{ omschrijving, bedrag: r.bedrag, jaar: p.jaar, toelichting: sub.join('\n') }];
    if (toelichting) nr.push({ omschrijving: /^toelichting/i.test(toelichting) ? toelichting : 'Toelichting: ' + toelichting, tekst: true });
    stmts.push(st('insert into nota (entiteit, jaar, nummer, praktijk_id, datum, soort, periode, titel, regels, bedrag, status, bron, plan_id, aangemaakt_op, opmerking) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      p.ent, p.jaar, nummers[i], r.id, datum, soort, periode, NOTA_TITEL[p.ent], JSON.stringify(nr), r.bedrag, 'definitief', 'pagina', v.plan ? v.plan.id : null, nuTijd,
      p.modus === 'eindafrekening' ? `eindafrekening op jaarlast ${v.grondslag.jaarlast}` : `correctie t/m Q${p.totK}${p.extra ? ', extra ' + p.extra : ''}`));
  });
  if (p.modus === 'eindafrekening') {
    const jl = v.grondslag.jaarlast;
    if (!v.jaarlast_db) stmts.push(st('insert into jaarlast (entiteit, jaar, bedrag, bron, opmerking, ingevoerd_op) values (?,?,?,?,?,?)', p.ent, p.jaar, jl, 'pagina', 'ingevoerd bij eindafrekening', vandaagStr(env)));
    else if (Math.abs(v.jaarlast_db.bedrag - jl) > 0.004) stmts.push(st('update jaarlast set bedrag=?, bron=?, opmerking=?, ingevoerd_op=? where entiteit=? and jaar=?', jl, 'pagina', `gewijzigd bij eindafrekening (was ${v.jaarlast_db.bedrag}, ${v.jaarlast_db.bron})`, vandaagStr(env), p.ent, p.jaar));
  }
  await env.schrijf(stmts);
  const notas = await q(env, `select * from nota where entiteit=? and nummer in (${nummers.map(() => '?').join(',')}) order by nummer`, p.ent, ...nummers);
  return json({ ok: true, notas, voorstel: v, totaal_notas: rond(notas.reduce((a, n) => a + n.bedrag, 0)) });
}

// ── POST patienten (was PUT; body { standen: [...] }: het doorgeefluik en de pod nemen alleen een JSON-object aan) ──
async function patientenPost(env, body) {
  const b = Array.isArray(body) ? body : body && body.standen;
  if (!Array.isArray(b) || !b.length || b.length > 300) throw new Gebruikersfout('verwacht een lijst van 1 tot 300 standen');
  const geldig = new Set((await praktijken(env)).map((p) => p.id));
  const opm = `ingevoerd op pagina ${vandaagStr(env)}`;
  const stmts = b.map((r, i) => {
    const id = String(r.praktijk_id || '');
    if (!geldig.has(id)) throw new Gebruikersfout(`regel ${i + 1}: onbekende praktijk`);
    const pd = String(r.peildatum || '');
    if (!/^\d{4}-01-01$/.test(pd)) throw new Gebruikersfout(`regel ${i + 1}: peildatum moet JJJJ-01-01 zijn`);
    vJaar(pd.slice(0, 4), 'peildatum');
    const aantal = vNum(r.aantal, `regel ${i + 1}: aantal`, 0, 100000);
    return st("insert into praktijk_patienten (praktijk_id, peildatum, aantal, status, opmerking) values (?,?,?,'handmatig',?) on conflict(praktijk_id, peildatum) do update set aantal=excluded.aantal, status='handmatig', opmerking=excluded.opmerking",
      id, pd, aantal, opm);
  });
  await env.schrijf(stmts);
  return json({ ok: true, opgeslagen: stmts.length });
}

// ── POST nota/<id>/status ───────────────────────────────────────────────────
const STATUS_OVERGANG = { concept: ['definitief', 'vervallen'], definitief: ['vervallen'], vervallen: [] };
async function notaStatus(env, b, id) {
  const nieuw = String(b.status || '');
  const n = await q1(env, 'select id, nummer, status from nota where id=?', id);
  if (!n) throw new Gebruikersfout('nota niet gevonden', 404);
  if (!(STATUS_OVERGANG[n.status] || []).includes(nieuw)) throw new Gebruikersfout(`status ${n.status} → ${nieuw} is niet toegestaan (alleen concept → definitief → vervallen)`, 409);
  const opm = `status ${n.status} → ${nieuw} op ${vandaagStr(env)}`;
  await env.schrijf([st("update nota set status=?, opmerking=trim(coalesce(opmerking,'') || case when opmerking is null or opmerking='' then '' else '; ' end || ?) where id=? and status=?", nieuw, opm, id, n.status)]);
  return json({ ok: true, nota: await q1(env, 'select * from nota where id=?', id) });
}

// ── verzending (P4): klaarzetten, annuleren, adres ──────────────────────────
// Zelfde controles als de Function (wv911/wv921); de SQL op nota_verzending komt uit pot-verzend.js.
const isoNu = (env) => new Date(env.nu).toISOString().replace(/\.\d{3}Z$/, 'Z');
const vzPlus = (ymd, d) => new Date(Date.parse(ymd + 'T12:00:00Z') + d * 864e5).toISOString().slice(0, 10);
const vzVandaagLokaal = (env) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date(env.nu));
// 07:00 Europe/Amsterdam op `datum` als UTC-tijd (zomer +2, winter +1; Intl rekent de wissel).
function vzZevenUur(datum) {
  for (const uurUtc of [5, 6]) {
    const t = new Date(`${datum}T0${uurUtc}:00:00Z`);
    const lok = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hourCycle: 'h23' }).format(t);
    if (Number(lok) === 7) return t.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  throw new Gebruikersfout('kon 07:00 op ' + datum + ' niet bepalen');
}
async function vzNota(env, id) {
  const n = await q1(env, 'select id, entiteit, jaar, nummer, praktijk_id, datum, soort, periode, titel, bedrag, status from nota where id=?', id);
  if (!n) throw new Gebruikersfout('nota niet gevonden', 404);
  const p = await q1(env, 'select id, naam, naam_brief, tav, email from praktijk where id=?', n.praktijk_id);
  return { n, p };
}
function vzB64(s) {
  if (typeof s !== 'string' || !s.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new Gebruikersfout('pdf_b64 ongeldig');
  if (s.length > VZ_B64_MAX_POD) throw new Gebruikersfout('pdf te groot (max. 45 kB)', 413);
  const b = Buffer.from(s, 'base64');
  if (b.toString('base64').replace(/=+$/, '') !== s.replace(/=+$/, '')) throw new Gebruikersfout('pdf_b64 ongeldig');
  return b;
}
async function vzAanvraag(env, b) {
  const id = vNum(b.nota_id, 'nota_id', 1, 1e9);
  const { n, p } = await vzNota(env, id);
  if (!env.open && !(n.entiteit === 'PROEF' && /^P9\d$/.test(String(n.praktijk_id)))) throw new Gebruikersfout(DICHT, 409);   // review KAN 4: alleen een proefpraktijk
  if (n.status !== 'definitief') throw new Gebruikersfout(`nota ${n.nummer} is ${n.status}; alleen definitieve nota's gaan de deur uit`, 409);
  const bytes = vzB64(b.pdf_b64);
  if (bytes.length > VZ_PDF_MAX_POD) throw new Gebruikersfout('pdf te groot (max. 45 kB)', 413);
  if (bytes.slice(0, 5).toString('latin1') !== '%PDF-') throw new Gebruikersfout('pdf_b64 is geen PDF');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  if (String(b.pdf_sha256 || '').toLowerCase() !== sha) throw new Gebruikersfout('pdf_sha256 klopt niet met de PDF');
  const reden = vTekst(b.reden, 'reden', 300);
  let plan = null, nietVoor = isoNu(env);
  if (b.auto !== undefined && typeof b.auto !== 'boolean') throw new Gebruikersfout('auto is true of false');
  const auto = b.auto === true;
  const vandaag = vzVandaagLokaal(env);
  if (auto) {
    // wv921: alleen op een werkdag vanaf morgen (de Ja in Voor jou moet vóór de dag komen), alleen als de pod het nu aankan
    if (b.plan_datum == null || b.plan_datum === '') throw new Gebruikersfout('kies een datum om op die dag zelf te versturen');
    const pd = vDatum(b.plan_datum, 'verzenddatum');
    if (!(pd > vandaag)) throw new Gebruikersfout('zelf versturen kan vanaf morgen (je geeft de nota\'s eerst vrij in Voor jou)');
    if (pd > vzPlus(vandaag, 45)) throw new Gebruikersfout('zelf versturen kan hooguit 45 dagen vooruit');
    if (!VZ.werkdag(pd)) throw new Gebruikersfout('op die dag (weekend of feestdag) gaat er niets vanzelf de deur uit; kies een werkdag');
    const ak = await vzAutoKan(env, n.entiteit);
    if (!ak.kan) throw new Gebruikersfout(ak.reden, 409);
  }
  if (b.plan_datum != null && b.plan_datum !== '') {
    plan = vDatum(b.plan_datum, 'verzenddatum');
    if (plan < vandaag) throw new Gebruikersfout('verzenddatum ligt in het verleden');
    if (plan > `${Number(vandaag.slice(0, 4)) + 1}${vandaag.slice(4)}`) throw new Gebruikersfout('verzenddatum ligt meer dan een jaar vooruit');
    const zeven = vzZevenUur(plan);
    if (zeven > nietVoor) nietVoor = zeven; else plan = null;   // vandaag na 07:00 = meteen
  }
  const a = VZ.aanvraagActiefSql(n.id);
  const actief = await q1(env, a.sql, ...a.params);
  if (actief && !reden) {
    // dezelfde druk nog eens (netwerk, dubbel tikken): niets nieuws, de bestaande rij terug
    return json({ ok: true, al: true, verzending: actief, melding: `nota ${n.nummer} staat al klaar (${actief.status}); kies Opnieuw klaarzetten met een reden als je hem nog eens wilt` });
  }
  if (actief && !VZ.VZ_OPNIEUW_VAN.includes(actief.status)) throw new Gebruikersfout(`nota ${n.nummer} wordt nu door Socev ${actief.status === 'verzenden' ? 'verstuurd' : 'klaargezet'}; probeer het zo nog eens`, 409);
  if (reden && reden.length < 5) throw new Gebruikersfout('geef een reden van minstens 5 tekens');
  if (auto && !plan) throw new Gebruikersfout('zelf versturen kan vanaf morgen');
  const k = vzKopie(n, p), t = isoNu(env);
  try {
    await env.schrijf(VZ.aanvraagSql({ actief, reden, n, k, nietVoor, plan, auto, pdf_b64: b.pdf_b64, sha, bytes: bytes.length, t }));
  } catch (e) {
    if (/UNIQUE constraint/i.test(String(e && e.message))) throw new Gebruikersfout(`nota ${n.nummer} is net door iets anders klaargezet; ververs de lijst`, 409);
    throw e;
  }
  // veranderde de oude rij net zelf van status (fout, geannuleerd): de nieuwe rij staat er toch; die geven we terug (Fable diffreview #5)
  const nw = VZ.aanvraagNieuwSql(n.id);
  return json({ ok: true, verzending: await q1(env, nw.sql, ...nw.params) });
}
async function vzRij(env, id) { const r = VZ.aanvraagRijSql(id); return q1(env, r.sql, ...r.params); }
async function vzAnnuleer(env, id) {
  const res = await env.schrijf([VZ.annuleerSql(id, isoNu(env))]);
  if (!(res[0] && res[0].changes === 1)) throw new Gebruikersfout('deze verzending is al opgepakt of afgerond en kan niet meer geannuleerd worden', 409);
  return json({ ok: true, verzending: await vzRij(env, id) });
}
async function vzAdres(env, b, id) {
  const r = await vzRij(env, id);
  if (!r) throw new Gebruikersfout('verzending niet gevonden', 404);
  if (!env.open && !(r.entiteit === 'PROEF' && /^P9\d$/.test(String(r.praktijk_id)))) throw new Gebruikersfout(DICHT, 409);
  if (r.status !== 'wacht_op_adres' || !r.aan) throw new Gebruikersfout('hier is geen adres te bevestigen', 409);
  if (String(b.aan || '').trim().toLowerCase() !== String(r.aan).toLowerCase()) throw new Gebruikersfout('het adres is intussen veranderd; ververs de lijst', 409);
  const res = await env.schrijf(VZ.adresSql(r, isoNu(env)));
  if (!(res[1] && res[1].changes === 1)) throw new Gebruikersfout('deze verzending veranderde net van status; ververs de lijst', 409);
  return json({ ok: true, verzending: await vzRij(env, id) });
}

// Tot de overstap (bouwplan § 3.4) schrijft alleen de oude pagina; daarna alleen OVIS POT.
const DICHT = 'OVIS POT schrijft nog niet: tot de overstap (na de verzending van 2 november) doe je dit op werk.socev.dev/pot';
// POST /app/pot/<pad> → route
function ontleedSchrijf(pad) {
  const p = String(pad == null ? '' : pad);
  if (['planning', 'planning/vaststellen', 'correctie', 'patienten', 'verzend'].includes(p)) return { route: p, id: null };
  let m = /^nota\/([1-9]\d{0,8})\/status$/.exec(p);
  if (m) return { route: 'nota/status', id: Number(m[1]) };
  m = /^verzending\/([1-9]\d{0,8})\/(annuleer|adres)$/.exec(p);
  if (m) return { route: 'verzending/' + m[2], id: Number(m[1]) };
  return null;
}
const SCHRIJF_ROUTES = ['planning', 'planning/vaststellen', 'correctie', 'patienten', 'nota/status', 'verzend', 'verzending/annuleer', 'verzending/adres'];


// ── D1: vragen bundelen ─────────────────────────────────────────────────────
// Alles wat in dezelfde tik gevraagd wordt (Promise.all, en de vervolgvragen die daarna samen klaarstaan) gaat in één batch naar
// io.d1: één rondgang. Alleen SELECT (ook de pod-kant weigert iets anders). Een fout in de batch laat alle vragen erin falen.
const BATCH_MAX = 50;
function vraagBundel(d1) {
  const teller = { rondgangen: 0, vragen: 0 };
  let wacht = [];
  function spoel() {
    const alles = wacht;
    wacht = [];
    for (let i = 0; i < alles.length; i += BATCH_MAX) {
      const deel = alles.slice(i, i + BATCH_MAX);
      teller.rondgangen++; teller.vragen += deel.length;
      Promise.resolve().then(() => d1(deel.map((x) => ({ sql: x.sql, params: x.params })))).then((res) => {
        if (!Array.isArray(res) || res.length !== deel.length) throw new Error('D1: onverwacht antwoord');
        deel.forEach((x, k) => x.ok(res[k] && Array.isArray(res[k].results) ? res[k].results : []));
      }).catch((e) => deel.forEach((x) => x.nee(e)));
    }
  }
  function vraag(sql, params) {
    if (!/^\s*select\b/i.test(sql)) return Promise.reject(new Error('pot-app: alleen lezen'));
    return new Promise((ok, nee) => {
      if (!wacht.length) setImmediate(spoel);
      wacht.push({ sql, params: params || [], ok, nee });
    });
  }
  return { vraag, teller };
}

// ── routes (padstukken) ─────────────────────────────────────────────────────
// Pad na /app/pot/ → de Function-route met dezelfde parameters (entiteit klein over de lijn, hier weer POT/KM/SLOEL via vEnt/leesEntiteit).
//   overzicht[/<jaar>]  afrekening[/<jaar>]  begroting[/<jaar>]  kasstroom/<ent>  liquiditeit  patienten
//   planning/<ent>[/<jaar>]  notas/<ent>[/<jaar>]  verzend/voorbeeld/<nota-id>
//   correctie/<ent>/<jaar>[/<modus>[/<tot-kwartaal>[/<extra>[/<jaarlast>]]]]   modus tot-heden | eindafrekening; extra en jaarlast
//     in hele centen (een punt mag niet over het doorgeefluik), "geen" = niet opgegeven
const ROUTES = ['overzicht', 'afrekening', 'begroting', 'kasstroom', 'liquiditeit', 'planning', 'correctie', 'patienten', 'notas', 'verzend/voorbeeld'];
const CENT_RE = /^-?\d{1,12}$/;
function centen(x, naam) {
  if (x == null || x === '' || x === 'geen') return '';
  if (!CENT_RE.test(x)) throw new Gebruikersfout(`${naam} ongeldig`);
  return Number(x) / 100;
}
// → { route, params } of null (onbekend). params zoals url.searchParams van de Function.
function ontleed(pad) {
  const d = String(pad == null ? '' : pad).split('/');
  const r = d[0], rest = d.slice(1), n = rest.length;
  if (['overzicht', 'afrekening', 'begroting'].includes(r) && n <= 1) return { route: r, params: { jaar: rest[0] } };
  if (r === 'kasstroom' && n === 1) return { route: r, params: { entiteit: rest[0] } };
  if ((r === 'liquiditeit' || r === 'patienten') && n === 0) return { route: r, params: {} };
  if ((r === 'planning' || r === 'notas') && n >= 1 && n <= 2) return { route: r, params: { entiteit: rest[0], jaar: rest[1] } };
  if (r === 'correctie' && n >= 2 && n <= 6) {
    const modus = rest[2] === 'tot-heden' ? 'tot_heden' : rest[2];
    return { route: r, params: { entiteit: rest[0], jaar: rest[1], modus, tot_kwartaal: rest[3], extra: rest[4], jaarlast: rest[5] }, centen: true };
  }
  if (r === 'verzend' && rest[0] === 'voorbeeld' && n === 2) return { route: 'verzend/voorbeeld', params: { nota_id: rest[1] } };
  return null;
}

function maak(io) {
  if (!io || typeof io.d1 !== 'function') throw new Error('pot-app: io.d1 ontbreekt');
  const klok = typeof io.nu === 'function' ? io.nu : () => new Date();
  // GET /app/pot/<pad> → { status, j, rondgangen, vragen, route }
  async function lees(pad) {
    const o = ontleed(pad);
    if (!o) return { ...fout('onbekende route', 404), rondgangen: 0, vragen: 0, route: null };
    const b = vraagBundel(io.d1);
    const env = { nu: klok(), vraag: b.vraag };
    let uit;
    try {
      const p = { ...o.params };
      if (o.centen) { p.extra = centen(p.extra, 'extra'); p.jaarlast = centen(p.jaarlast, 'jaarlast'); }
      const url = { searchParams: { get: (k) => (p[k] == null ? null : String(p[k])) } };
      if (o.route === 'overzicht') uit = await overzicht(env, url);
      else if (o.route === 'afrekening') uit = await afrekening(env, url);
      else if (o.route === 'begroting') uit = await begrotingRoute(env, url);
      else if (o.route === 'kasstroom') uit = await kasstroom(env, url);
      else if (o.route === 'liquiditeit') uit = await liquiditeit(env);
      else if (o.route === 'planning') uit = await planningGet(env, url);
      else if (o.route === 'correctie') uit = await correctieGet(env, url);
      else if (o.route === 'patienten') uit = await patientenGet(env);
      else if (o.route === 'notas') uit = await notasGet(env, url);
      else uit = await vzVoorbeeld(env, url);
    } catch (e) {
      if (e instanceof Gebruikersfout) uit = fout(e.message, e.status);
      else uit = fout('serverfout: ' + (e && e.message), 500);
    }
    return { ...uit, rondgangen: b.teller.rondgangen, vragen: b.teller.vragen, route: o.route };
  }
  // POST /app/pot/<pad> met een JSON-object → { status, j, rondgangen, vragen, schrijfacties, route, id }
  // io.schrijf(batch) → [{ results, changes }] (één transactie); io.schrijvenOpen() → true na de overstap.
  async function schrijf(pad, body) {
    const o = ontleedSchrijf(pad);
    if (!o) return { ...fout('onbekende route', 404), rondgangen: 0, vragen: 0, schrijfacties: 0, route: null, id: null };
    const open = typeof io.schrijvenOpen === 'function' && io.schrijvenOpen() === true;
    const b = vraagBundel(io.d1);
    let schrijfacties = 0;
    // Opus-review wv1933 MOET 2: een schrijfbatch die afbreekt zonder duidelijke weigering van D1 (time-out, netwerk, 5xx), of een fout
    // ná een geslaagde batch (teruglezen), kan wél vastgelegd zijn. Dan geen gewone 500 ("niets gebeurd") maar 504 "onzeker": de App
    // herlaadt dan de lijst en stuurt niet opnieuw. Alleen een 4xx van D1 (constraint, SQL) is een zekere weigering (batch = transactie).
    let fase = 'voor';   // voor | onzeker | geschreven
    const env = { nu: null, open, vraag: b.vraag, schrijf: async (stmts) => {
      if (typeof io.schrijf !== 'function') throw new Error('pot-app: io.schrijf ontbreekt');
      schrijfacties++;
      let r;
      try { r = await io.schrijf(stmts); } catch (e) {
        if (!/^D1 http 4\d\d\b/.test(String(e && e.message))) fase = 'onzeker';
        throw e;
      }
      fase = 'geschreven';
      if (!Array.isArray(r) || r.length !== stmts.length) throw new Error('D1: onverwacht antwoord');
      return r;
    } };
    let uit;
    try {
      // P3-routes: dicht tot de overstap (geen D1-rondgang); de verzendroutes beslissen per nota (PROEF mag), annuleren mag altijd
      if (!open && !o.route.startsWith('verzend')) throw new Gebruikersfout(DICHT, 409);
      const d = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
      // de klok van een schrijfroute komt uit D1 (zie de kop)
      const t = await q1(env, "select strftime('%Y-%m-%dT%H:%M:%fZ','now') as nu");
      env.nu = new Date(t && t.nu);
      if (Number.isNaN(env.nu.getTime())) throw new Error('D1 gaf geen tijd');
      if (o.route === 'planning') uit = await planningPost(env, d);
      else if (o.route === 'planning/vaststellen') uit = await vaststellen(env, d);
      else if (o.route === 'correctie') uit = await correctiePost(env, d);
      else if (o.route === 'patienten') uit = await patientenPost(env, d);
      else if (o.route === 'nota/status') uit = await notaStatus(env, d, o.id);
      else if (o.route === 'verzend') uit = await vzAanvraag(env, d);
      else if (o.route === 'verzending/annuleer') uit = await vzAnnuleer(env, o.id);
      else uit = await vzAdres(env, d, o.id);
    } catch (e) {
      // een Gebruikersfout is altijd een zeker antwoord (ook na de batch: een conditionele update met 0 rijen = 409)
      if (e instanceof Gebruikersfout) uit = fout(e.message, e.status);
      else if (fase === 'geschreven') uit = fout('opgeslagen, maar het teruglezen lukte niet (' + String(e && e.message).slice(0, 80) + '); ververs de lijst', 504);
      else if (fase === 'onzeker') uit = fout('geen antwoord van de databank; niet zeker of het is opgeslagen. Ververs de lijst en kijk voordat je opnieuw drukt', 504);
      else if (/UNIQUE constraint/i.test(String(e && e.message))) uit = fout('nummer al in gebruik (UNIQUE): ' + e.message, 409);   // D1 REST: HTTP 400, "UNIQUE constraint failed: …" (gemeten 29-10)
      else uit = fout('serverfout: ' + (e && e.message), 500);
      if (uit.status === 504) uit.j.onzeker = true;
    }
    return { ...uit, rondgangen: b.teller.rondgangen, vragen: b.teller.vragen, schrijfacties, route: o.route, id: o.id };
  }
  return { lees, schrijf };
}

module.exports = { maak, ontleed, ontleedSchrijf, vraagBundel, ROUTES, SCHRIJF_ROUTES, ENTITEITEN, DICHT };
