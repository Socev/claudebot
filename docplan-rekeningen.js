'use strict';
/*
 * DocPlan — scherm Rekeningen (wv3898, besluitenpagina nr 126 = 2C26, David Ja 22-11-2026 18:16; Fable-review docplan M1 + advies 3; ontwerp
 * mk-scripts/wv3898/ontwerp.md, Codex-review vooraf). Welke bankrekening bij welke waarnemer hoort staat alleen in docplan.sqlite (tabel rekening;
 * één IBAN hoort bij één persoon). Totaal (docplan-totaal.js), Jaaropgaaf (docplan-jaaropgaaf.js) en de controle (docplan-controle.js) lezen die
 * tabel per vraag; een rekening die er niet in staat telt stil niet mee. Hier ziet David per waarnemer zijn rekening(en) en bevestigt, voegt toe of
 * haalt weg wat niet van hem is.
 *
 *   GET  /app/facturen/rekeningen   → per persoon met een waarneemrol of een rekening: rekeningen met status (bevestigd = zekerheid david, zeker,
 *                                     waarschijnlijk), afschrijvingen per praktijk dit jaar + laatste betaaldatum, en kandidaten uit de bank
 *                                     (onbekende IBAN's met de naam van deze persoon; zie kandidaten()).
 *   POST /app/facturen/rekeningen   { actie: bevestig | toevoeg | weg, iban, object_id }
 *        bevestig  zekerheid → 'david' voor precies (iban, object_id)
 *        toevoeg   nieuwe rij (zekerheid 'david'); IBAN bij een andere persoon = 409 met die naam (nooit stil verplaatsen); al bij hem = bevestig
 *        weg       "hoort niet bij hem": rij (iban, object_id) eruit; terug te zetten met toevoeg (het IBAN blijft als kandidaat zichtbaar)
 * Alleen de eigenaar (Davids app-sessie; server.js appFacturen, vóór facturen.js: de praktijkmanager-ingang /fac kent de route niet), alleen op de
 * primaire kant. Elke schrijfactie in één BEGIN IMMEDIATE met een rij in de docplan-tabel log (object_id, laatste 4 cijfers, van → naar); een
 * volledig IBAN, naam of bedrag gaat nooit in een log (de reden in de podlog noemt alleen de actie).
 *
 * Puur: deze module laadt niets en raakt geen bestanden; server.js geeft de openers mee (docplan.sqlite readOnly en rw, facturen.sqlite alleenLezen).
 * naamSleutel() en bekendeNamen() gebruikt ook docplan-controle.js (signaal rekening_onbekend), zodat scherm en signaal dezelfde regel volgen.
 */
const PRAKTIJK = [{ code: 'TG', entiteit: 'tolgaarde', naam: 'Tolgaarde' }, { code: 'GH', entiteit: 'groenhouten', naam: 'Groenhouten' }];
const PAD_RE = /^\/app\/facturen\/rekeningen$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIES = ['bevestig', 'toevoeg', 'weg'];
const STATUS = { david: 'bevestigd', zeker: 'zeker', waarschijnlijk: 'waarschijnlijk' };
const KANDIDAAT_VAN = '2025-01-01';   // bank vanaf hier voor kandidaten (de leesproef begon bij 2025)
const BRON = 'david: app (wv3898)';

function dagAmsterdam(nu) { return new Date(nu).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
/* naamSleutel(tekst) → kleine letters, alleen a–z (accenten eraf); '' als korter dan 4 letters. */
function naamSleutel(s) {
  const k = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  return k.length >= 4 ? k : '';
}
/* ibanVorm(tekst) → genormaliseerd IBAN of null: hoofdletters, zonder spaties, 15–34 tekens, landcode + 2 cijfers, mod-97 = 1. */
function ibanVorm(s) {
  if (typeof s !== 'string') return null;
  const i = s.replace(/[\s.-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(i)) return null;
  const r = (i.slice(4) + i.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let m = 0;
  for (const c of r) m = (m * 10 + Number(c)) % 97;
  return m === 1 ? i : null;
}
const eind = (iban) => String(iban || '').slice(-4);

/*
 * bekendeNamen(dp, fac) → Map naamSleutel → Set object_id: de tegenpartijnamen op afschrijvingen/bijschrijvingen van TG/GH aan een rekening die
 * al bij een persoon hoort, plus persoon.naam en naw.bedrijfsnaam. Een sleutel met meer dan één persoon is ambigu (de aanroeper slaat hem over).
 */
function bekendeNamen(dp, fac, rek) {
  rek = rek || new Map(dp.prepare('SELECT iban, object_id FROM rekening').all().map((r) => [r.iban, r.object_id]));
  const uit = new Map();
  const zet = (naam, oid) => { const k = naamSleutel(naam); if (!k) return; if (!uit.has(k)) uit.set(k, new Set()); uit.get(k).add(oid); };
  const ibans = [...rek.keys()];
  if (ibans.length) {
    for (const t of fac.prepare("SELECT DISTINCT tegenpartij_iban AS iban, tegenpartij_naam AS naam FROM bank_transactie WHERE verwijderd_op IS NULL" +
      " AND entiteit IN ('tolgaarde', 'groenhouten') AND tegenpartij_naam IS NOT NULL AND tegenpartij_iban IN (" + ibans.map(() => '?').join(',') + ')').all(...ibans)) zet(t.naam, rek.get(t.iban));
  }
  for (const p of dp.prepare('SELECT object_id, naam FROM persoon').all()) zet(p.naam, p.object_id);
  try { for (const n of dp.prepare('SELECT object_id, bedrijfsnaam FROM naw WHERE bedrijfsnaam IS NOT NULL').all()) zet(n.bedrijfsnaam, n.object_id); } catch (e) { /* geen naw-tabel */ }
  return uit;
}

/*
 * kandidaten(dp, fac, rek, personen) → Map object_id → [{ iban, naam, n, laatste, waarom: naam|achternaam }]: onbekende IBAN's (niet in rekening) met
 * afschrijvingen van TG/GH sinds KANDIDAAT_VAN. 'naam' = de tegenpartijnaam is precies een bekende naam van alleen deze persoon (zelfde regel als het
 * signaal); 'achternaam' = de naam bevat zijn achternaam (≥ 4 letters, alleen als die achternaam bij één persoon hoort en hij nog geen rekening heeft) — alleen
 * hier, nooit als signaal.
 */
function kandidaten(dp, fac, rek, personen) {
  const namen = bekendeNamen(dp, fac, rek);
  const achter = new Map();
  for (const p of personen.values()) {
    const delen = String(p.naam || '').trim().split(/\s+/);
    const k = naamSleutel(delen[delen.length - 1]);
    if (!k) continue;
    if (!achter.has(k)) achter.set(k, new Set());
    achter.get(k).add(p.object_id);
  }
  const metRek = new Set(rek.values());
  const per = new Map();   // iban → { naam, n, laatste }
  for (const t of fac.prepare("SELECT tegenpartij_iban AS iban, tegenpartij_naam AS naam, boekdatum FROM bank_transactie WHERE verwijderd_op IS NULL AND bedrag_centen < 0" +
    " AND entiteit IN ('tolgaarde', 'groenhouten') AND boekdatum >= ? AND tegenpartij_iban IS NOT NULL AND tegenpartij_naam IS NOT NULL ORDER BY boekdatum").all(KANDIDAAT_VAN)) {
    if (rek.has(t.iban)) continue;
    let x = per.get(t.iban);
    if (!x) per.set(t.iban, x = { naam: t.naam, n: 0, laatste: null });
    x.n++; x.laatste = t.boekdatum; x.naam = t.naam;
  }
  const uit = new Map();
  for (const [iban, x] of per) {
    const k = naamSleutel(x.naam);
    if (!k) continue;
    let oid = null, waarom = null;
    const s = namen.get(k);
    if (s && s.size === 1) { oid = [...s][0]; waarom = 'naam'; }
    else if (!s) {   // achternaam alleen voor wie nog geen rekening heeft (anders vooral familie met dezelfde achternaam; gemeten 22-11: 5 van 7)
      const hit = [...achter].filter(([a, set]) => set.size === 1 && k.includes(a)).map(([, set]) => [...set][0]);
      if (new Set(hit).size === 1 && !metRek.has(hit[0])) { oid = hit[0]; waarom = 'achternaam'; }
    }
    if (!oid || !personen.has(oid)) continue;
    if (!uit.has(oid)) uit.set(oid, []);
    uit.get(oid).push({ iban, naam: String(x.naam).slice(0, 120), n: x.n, laatste: x.laatste, waarom });
  }
  return uit;
}

/* lijst(dp, fac, nu) → wat de app toont. */
function lijst(dp, fac, nu) {
  const jaar = dagAmsterdam(nu).slice(0, 4);
  const personen = new Map(dp.prepare('SELECT object_id, naam FROM persoon').all().map((r) => [r.object_id, r]));
  const rollen = new Map();
  for (const r of dp.prepare('SELECT object_id, praktijk FROM rol').all()) { if (!rollen.has(r.object_id)) rollen.set(r.object_id, new Set()); rollen.get(r.object_id).add(r.praktijk); }
  const rekRijen = dp.prepare('SELECT iban, object_id, zekerheid, reden, bron, toegevoegd_op FROM rekening').all();
  const rek = new Map(rekRijen.map((r) => [r.iban, r.object_id]));
  const bet = new Map();   // iban → { TG: {n, laatste}, GH: {...}, laatste_ooit }
  const ibans = [...rek.keys()];
  if (ibans.length) {
    for (const t of fac.prepare("SELECT entiteit, tegenpartij_iban AS iban, count(*) AS n, max(boekdatum) AS laatste FROM bank_transactie WHERE verwijderd_op IS NULL AND bedrag_centen < 0" +
      " AND entiteit IN ('tolgaarde', 'groenhouten') AND boekdatum >= ? AND tegenpartij_iban IN (" + ibans.map(() => '?').join(',') + ') GROUP BY entiteit, tegenpartij_iban').all(jaar + '-01-01', ...ibans)) {
      if (!bet.has(t.iban)) bet.set(t.iban, {});
      bet.get(t.iban)[t.entiteit === 'tolgaarde' ? 'TG' : 'GH'] = { n: Number(t.n), laatste: t.laatste };
    }
    for (const t of fac.prepare("SELECT tegenpartij_iban AS iban, max(boekdatum) AS laatste FROM bank_transactie WHERE verwijderd_op IS NULL AND bedrag_centen < 0" +
      " AND entiteit IN ('tolgaarde', 'groenhouten') AND tegenpartij_iban IN (" + ibans.map(() => '?').join(',') + ') GROUP BY tegenpartij_iban').all(...ibans)) {
      if (!bet.has(t.iban)) bet.set(t.iban, {});
      bet.get(t.iban).laatste_ooit = t.laatste;
    }
  }
  const kand = kandidaten(dp, fac, rek, personen);
  const per = new Map();
  const persoonRij = (oid) => {
    let p = per.get(oid);
    if (!p) per.set(oid, p = { object_id: oid, naam: personen.has(oid) ? String(personen.get(oid).naam) : 'onbekende persoon', bekend: personen.has(oid),
      praktijken: [...(rollen.get(oid) || [])].filter((c) => c === 'TG' || c === 'GH').sort((a, b) => (a === 'TG' ? 0 : 1) - (b === 'TG' ? 0 : 1)),
      rekeningen: [], kandidaten: kand.get(oid) || [] });
    return p;
  };
  for (const oid of rollen.keys()) if (personen.has(oid)) persoonRij(oid);
  for (const r of rekRijen) {
    const b = bet.get(r.iban) || {};
    persoonRij(r.object_id).rekeningen.push({ iban: r.iban, status: STATUS[r.zekerheid] || 'waarschijnlijk', reden: r.reden ? String(r.reden).slice(0, 200) : null,
      toegevoegd_op: r.toegevoegd_op || null, door_david: String(r.bron || '').startsWith('david'),
      dit_jaar: PRAKTIJK.map((p) => ({ praktijk: p.code, n: (b[p.code] || {}).n || 0, laatste: (b[p.code] || {}).laatste || null })),
      laatste: b.laatste_ooit || null });
  }
  const RANG = { ontbreekt: 0, waarschijnlijk: 1, zeker: 2, bevestigd: 3 };
  const rijen = [...per.values()].map((p) => {
    p.rekeningen.sort((a, b) => RANG[a.status] - RANG[b.status] || String(b.laatste || '').localeCompare(String(a.laatste || '')));
    // de zwakste rekening telt voor de persoon (zoals Betalingen: waarschijnlijk < zeker < bevestigd)
    p.status = !p.rekeningen.length ? 'ontbreekt' : p.rekeningen.reduce((s, r) => (RANG[r.status] < RANG[s] ? r.status : s), 'bevestigd');
    return p;
  }).sort((a, b) => RANG[a.status] - RANG[b.status] || (b.kandidaten.length ? 1 : 0) - (a.kandidaten.length ? 1 : 0) || a.naam.localeCompare(b.naam, 'nl'));
  const tel = (s) => rijen.filter((p) => p.status === s).length;
  return { jaar, opgehaald: new Date(nu).toISOString(), personen: rijen,
    n: { personen: rijen.length, ontbreekt: tel('ontbreekt'), waarschijnlijk: tel('waarschijnlijk'), zeker: tel('zeker'), bevestigd: tel('bevestigd'),
      kandidaten: rijen.reduce((s, p) => s + p.kandidaten.length, 0), rekeningen: rekRijen.length } };
}

/* verzoek(d) → { actie, iban, object_id } of { fout }. */
function verzoek(d) {
  d = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  if (!ACTIES.includes(d.actie)) return { fout: 'onbekende actie' };
  if (typeof d.object_id !== 'string' || !UUID_RE.test(d.object_id)) return { fout: 'kies een persoon' };
  const iban = ibanVorm(d.iban);
  if (!iban) return { fout: 'dit is geen geldig rekeningnummer (IBAN)' };
  return { actie: d.actie, iban, object_id: d.object_id };
}

/* schrijf(db, x, nu) → { status, j, reden }. db = rw-verbinding op docplan.sqlite. Eén BEGIN IMMEDIATE. */
function schrijf(db, x, nu) {
  const wanneer = new Date(nu).toISOString();
  db.exec('BEGIN IMMEDIATE');
  let klaar = false;
  try {
    const p = db.prepare('SELECT object_id, naam FROM persoon WHERE object_id = ?').get(x.object_id);
    if (!p) { db.exec('ROLLBACK'); klaar = true; return { status: 404, j: { ok: false, fout: 'deze persoon staat niet (meer) in DocPlan' }, reden: 'rekening persoon onbekend' }; }
    const r = db.prepare('SELECT iban, object_id, zekerheid FROM rekening WHERE iban = ?').get(x.iban);
    const log = (wat, van, naar) => db.prepare('INSERT INTO log (wanneer, wat, details) VALUES (?, ?, ?)').run(wanneer, 'rekening ' + wat + ' (app)',
      JSON.stringify({ object_id: x.object_id, iban_eind: eind(x.iban), van, naar, door: 'david' }));
    let uit;
    if (r && r.object_id !== x.object_id) {
      const ander = db.prepare('SELECT naam FROM persoon WHERE object_id = ?').get(r.object_id);
      uit = { status: 409, j: { ok: false, fout: 'rekening …' + eind(x.iban) + ' hoort al bij ' + (ander ? ander.naam : 'een andere persoon') +
        '; haal hem daar eerst weg ("Hoort niet bij hem") en voeg hem dan hier toe' }, reden: 'rekening bij ander' };
    } else if (x.actie === 'weg') {
      if (!r) uit = { status: 409, j: { ok: false, fout: 'deze rekening staat niet (meer) bij deze persoon' }, reden: 'rekening weg niet gevonden' };
      else {
        db.prepare('DELETE FROM rekening WHERE iban = ? AND object_id = ?').run(x.iban, x.object_id);
        log('weg', r.zekerheid, null);
        uit = { status: 200, j: { ok: true, actie: 'weg', iban: x.iban, object_id: x.object_id }, reden: 'rekening weg' };
      }
    } else if (r) {   // bevestig, of toevoeg van een rekening die al bij hem staat
      if (r.zekerheid !== 'david') {
        db.prepare("UPDATE rekening SET zekerheid = 'david', bron = ? WHERE iban = ? AND object_id = ?").run(BRON, x.iban, x.object_id);
        log('bevestig', r.zekerheid, 'david');
      }
      uit = { status: 200, j: { ok: true, actie: 'bevestig', iban: x.iban, object_id: x.object_id, al: r.zekerheid === 'david' }, reden: 'rekening bevestig' };
    } else if (x.actie === 'bevestig') {
      uit = { status: 409, j: { ok: false, fout: 'deze rekening staat niet (meer) bij deze persoon; voeg hem toe' }, reden: 'rekening bevestig niet gevonden' };
    } else {
      db.prepare("INSERT INTO rekening (iban, object_id, zekerheid, reden, bron, toegevoegd_op) VALUES (?, ?, 'david', ?, ?, ?)")
        .run(x.iban, x.object_id, 'door David toegevoegd in de app', BRON, wanneer);
      log('toevoeg', null, 'david');
      uit = { status: 200, j: { ok: true, actie: 'toevoeg', iban: x.iban, object_id: x.object_id }, reden: 'rekening toevoeg' };
    }
    if (uit.status === 200) db.exec('COMMIT'); else db.exec('ROLLBACK');
    klaar = true;
    return uit;
  } finally {
    if (!klaar) { try { db.exec('ROLLBACK'); } catch (e) { /* al dicht */ } }
  }
}

/*
 * maak({ openDocplan() → db readOnly | null, openDocplanRw() → db | null, openFacturen() → { db, sluit() } | null, fout(waar, e) }) → { app(verzoek) }.
 * verzoek = { methode, pad, d, rol, primair, nu } → { status, j, reden }.
 */
function maak(o) {
  o = o || {};
  function app(v) {
    const nu = Number.isFinite(v.nu) ? v.nu : Date.now();
    if (!PAD_RE.test(String(v.pad || '')) || (v.methode !== 'GET' && v.methode !== 'POST')) return { status: 404, j: { ok: false, fout: 'onbekend' }, reden: 'rekeningen onbekend' };
    if (!v.rol || v.rol.soort !== 'eigenaar' || v.rol.ingang !== 'app') return { status: 403, j: { ok: false, fout: 'alleen de eigenaar' }, reden: 'rekeningen geweigerd' };
    if (v.primair !== true) return { status: 409, j: { ok: false, fout: 'Facturen draait alleen op de primaire kant' }, reden: 'rekeningen niet primair' };
    if (v.methode === 'POST') {
      const x = verzoek(v.d);
      if (x.fout) return { status: 400, j: { ok: false, fout: x.fout }, reden: 'rekening ongeldig' };
      let db = null;
      try {
        db = o.openDocplanRw();
        if (!db) return { status: 503, j: { ok: false, fout: 'DocPlan heeft nog geen bestand op de pod' }, reden: 'rekening geen bestand' };
        return schrijf(db, x, nu);
      } catch (e) {
        if (typeof o.fout === 'function') o.fout('rekeningen', e);
        return { status: 503, j: { ok: false, fout: 'niet opgeslagen: DocPlan is nu niet te schrijven' }, reden: 'rekening fout' };
      } finally { try { if (db) db.close(); } catch (e) { /* al dicht */ } }
    }
    let dp = null, fac = null;
    try {
      dp = o.openDocplan();
      if (!dp) return { status: 200, j: { ok: true, leeg: true, personen: [], n: { personen: 0 } }, reden: 'rekeningen leeg' };
      fac = o.openFacturen();
      if (!fac) return { status: 503, j: { ok: false, fout: 'de facturendatabase is nu niet te openen' }, reden: 'rekeningen facturen dicht' };
      return { status: 200, j: Object.assign({ ok: true }, lijst(dp, fac.db, nu)), reden: 'rekeningen' };
    } catch (e) {
      if (typeof o.fout === 'function') o.fout('rekeningen', e);
      return { status: 503, j: { ok: false, fout: 'de rekeningen zijn nu niet te lezen' }, reden: 'rekeningen fout' };
    } finally {
      try { if (dp) dp.close(); } catch (e) { /* al dicht */ }
      try { if (fac) fac.sluit(); } catch (e) { /* al dicht */ }
    }
  }
  return { app };
}

module.exports = { maak, lijst, schrijf, verzoek, kandidaten, bekendeNamen, naamSleutel, ibanVorm, PAD_RE };
