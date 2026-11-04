'use strict';
/*
 * sb2-berichten.js — berichtverbindingen voor de Second Brain (wv2383, SB2 fase 6 § 6.2): wie mailt met wie. Ontwerp: vault
 * "01_Ontwikkeling/Second Brain 2.0 - fase 6 herstelproef, proefloper en redeneerteam (ontwerp 29-10-2026).md" § 6.2; databankkant
 * socev-scripts packages/sb2/sql/fase2/0025_bericht_koppel.up.sql.
 *
 * WAAROM. secondbrain.synapse telde 0 verbindingen uit berichten: niemand vulde mention en target_org_id. Deze stap lost elke nacht afzender,
 * ontvangers en cc van de gespiegelde mailstukken op tegen het register (identifier email/zorgmail exact, anders domein met puntgrens) en
 * zet in Supabase ALLEEN verwijzingen: per opgelost adres rolcode + kop + positie + entity-id (nooit adres, naam, domein of hash), plus
 * target_org_id = de eigen entiteit waar de router de mail bevestigd heen stuurde (niet PRIVE: dat is David zelf). David gaf Ja op de kaart
 * "Second Brain — mag Socev bijhouden wie met wie mailt?" (4-11-2026).
 *
 * HOE (nachtketen-stap sb2-berichten ná intake-voorstel en vóór sb2-synapsen; met de hand via mk-scripts/wv2372/hand.js [--droog]):
 *  1. Register via public.sb2_bericht_register (service_role): email/zorgmail/domein → entiteit, eigen entiteiten per short_code.
 *  2. Per route (schakelaar scripts-staat/sb2-berichten/aan.json {"aan": true, "routes": ["gmail.david"]}) ALLE gespiegelde mailversies van
 *     die route uit intake.sqlite (alleen lezen). Buiten scope (patiëntmarker niet geen/niet_te_lezen, vastgehouden of weg, keuze hard, buiten
 *     de Brain of harde weging) gaat mee met een lege lijst en target null, zodat eerdere rijen verdwijnen (review MOET 1); versies die de
 *     databank nog kent maar de pod niet meer (sb2_bericht_stand) ook. Quarantaine/verwijderd ruimt de RPC zelf op.
 *  3. Oplossen: Davids eigen adressen (router.json eigen_adressen) en alles wat op PRIVE uitkomt overslaan; exact in email/zorgmail; anders
 *     het langste domein dat gelijk is aan het adresdomein of er met een puntgrens op eindigt (review MOET 4), nooit via een openbaar
 *     maildomein; alleen bij precies één entiteit (dubbelzinnig = overslaan en tellen). Per (kop, entiteit) één vermelding (eerste positie).
 *  4. public.sb2_bericht_koppel in batches van ≤ 200 (zet-gelijk), daarna een droge tweede ronde: die moet 0 verschillen geven.
 *
 * Privacy: naar Supabase alleen revision-id's, rolcodes, posities en entity-id's. Logs en de staat: alleen tellingen.
 *
 * VORM. Geen eigen afhankelijkheden; database, RPC, schakelaar en eigen adressen komen via maak(o), zodat test/sb2-berichten.sh het met een
 * nep-Supabase en verzonnen adressen kan draaien.
 */

const ROUTES = ['gmail.david', 'gmail.groenhouten'];   // zelfde lijst als sb2_bericht_route_ok (0025)
const STUK_RE = /^stk_[0-9]{8}_[0-9a-f]{8}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADRES_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const KOPPEN = [['van', 'afzender'], ['aan', 'ontvanger'], ['cc', 'cc']];
const MAX_NR = 49, MAX_VERMELDINGEN = 20, BATCH = 200;
const MARKER_OK = ['geen', 'niet_te_lezen'];   // grondwet 3 (3-11): alleen een hard kenmerk houdt een stuk buiten; onleesbaar gaat door
// Openbare maildomeinen: een adres hier koppelt nooit via het domein (wel exact, als het adres zelf in het register staat).
const OPENBAAR = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.nl', 'outlook.com', 'outlook.nl', 'live.com', 'live.nl', 'msn.com',
  'yahoo.com', 'yahoo.nl', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'gmx.com', 'gmx.net', 'gmx.de', 'proton.me', 'protonmail.com',
  'pm.me', 'mail.com', 'ziggo.nl', 'kpnmail.nl', 'kpnplanet.nl', 'planet.nl', 'home.nl', 'xs4all.nl', 'telfort.nl', 'hetnet.nl', 'casema.nl',
  'chello.nl', 'upcmail.nl', 'quicknet.nl', 'online.nl', 'tele2.nl', 'zonnet.nl', 'solcon.nl', 'caiway.nl', 'kliksafe.nl', 'freedom.nl', 'delta.nl',
  'zeelandnet.nl', 'onsbrabantnet.nl', 't-mobilethuis.nl', 'versatel.nl', 'wxs.nl', 'freeler.nl', 'tiscali.nl', 'live.be', 'hotmail.be', 'telenet.be',
  'skynet.be', 'web.de', 'yandex.com', 'mail.ru', 'qq.com', '163.com']);

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function tel(o, k, n) { o[k] = (o[k] || 0) + (n == null ? 1 : n); }

// Adressen van één kop in de volgorde zoals de pod ze bewaart: [{nr, adres|null}]. Een element met <…> geeft wat tussen de haken staat;
// anders het element zelf (gesplitst op komma/puntkomma). Elk deel krijgt een positie, ook als het geen geldig adres is (vaste vindplaats).
function kopAdressen(v) {
  const lijst = v == null ? [] : (Array.isArray(v) ? v : [v]);
  const uit = [];
  for (const el of lijst) {
    if (typeof el !== 'string') { uit.push({ nr: uit.length, adres: null }); continue; }
    const haken = el.match(/<[^<>]*>/g);
    const delen = haken ? haken.map(function (h) { return h.slice(1, -1); }) : el.split(/[,;]/);
    for (const d of delen) {
      const a = d.normalize('NFC').trim().toLowerCase();
      if (!a && !haken) continue;
      uit.push({ nr: uit.length, adres: ADRES_RE.test(a) ? a : null });
    }
  }
  return uit;
}

// register = {adres: [[namespace, waarde, object_id]], eigen: [[code, object_id]]} → oplosser
function maakOplosser(register, eigenAdressen) {
  const exact = new Map(), domein = new Map(), eigenCode = new Map(), prive = new Set();
  for (const r of (register && Array.isArray(register.eigen) ? register.eigen : [])) {
    if (!Array.isArray(r) || typeof r[0] !== 'string' || !UUID_RE.test(String(r[1]))) continue;
    eigenCode.set(r[0], r[1]);
    if (r[0] === 'PRIVE') prive.add(r[1]);
  }
  for (const r of (register && Array.isArray(register.adres) ? register.adres : [])) {
    if (!Array.isArray(r) || typeof r[1] !== 'string' || !UUID_RE.test(String(r[2]))) continue;
    let w = r[1].normalize('NFC').trim().toLowerCase();
    if (r[0] === 'domein') {
      w = w.replace(/^@/, '').replace(/\.$/, '');
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(w)) continue;
      if (!domein.has(w)) domein.set(w, new Set());
      domein.get(w).add(r[2]);
    } else if (r[0] === 'email' || r[0] === 'zorgmail') {
      if (!ADRES_RE.test(w)) continue;
      if (!exact.has(w)) exact.set(w, new Set());
      exact.get(w).add(r[2]);
    }
  }
  const eigen = new Set((Array.isArray(eigenAdressen) ? eigenAdressen : []).filter(function (x) { return typeof x === 'string'; })
    .map(function (x) { return x.normalize('NFC').trim().toLowerCase(); }));
  function uitSet(s, soort) {
    if (s.size !== 1) return { overslaan: 'dubbelzinnig' };
    const oid = s.values().next().value;
    return prive.has(oid) ? { overslaan: 'prive' } : { object_id: oid, via: soort };
  }
  // → {object_id, via} of {overslaan: reden}
  function los(adres) {
    if (!adres) return { overslaan: 'geen_adres' };
    if (eigen.has(adres)) return { overslaan: 'eigen' };
    if (exact.has(adres)) return uitSet(exact.get(adres), 'email');
    const dom = adres.slice(adres.lastIndexOf('@') + 1);
    if (OPENBAAR.has(dom)) return { overslaan: 'openbaar' };
    const labels = dom.split('.');
    for (let i = 0; i < labels.length - 1; i++) {   // langste eerst; altijd op een puntgrens (x.ziekenhuis.nl → ziekenhuis.nl)
      const d = labels.slice(i).join('.');
      if (OPENBAAR.has(d)) return { overslaan: 'openbaar' };
      if (domein.has(d)) return uitSet(domein.get(d), 'domein');
    }
    return { overslaan: 'geen' };
  }
  return { los, eigenCode, aantal: { exact: exact.size, domein: domein.size, eigen: eigenCode.size } };
}

// Alle gespiegelde mailversies van één route → { versies: Map(revisie → {revision_id, target_org_id, mentions}), t }
function versiesVan(db, route, opl) {
  const t = { stukken: 0, in_scope: 0, buiten: {}, adres: {}, vermeldingen: 0, met_target: 0, doel_onbekend: 0, nr_te_hoog: 0, dubbel: 0 };
  const rijen = db.prepare("SELECT s.stuk_id, s.profiel, s.versie, s.marker_patient, s.meta, g.ids, g.ps, l.staat, l.keuze, l.versie AS lv " +
    "FROM stuk s JOIN spiegel g ON g.stuk_id = s.stuk_id LEFT JOIN live_stuk l ON l.stuk_id = s.stuk_id WHERE g.stand = 'gespiegeld' ORDER BY s.stuk_id").all();
  const samQ = db.prepare('SELECT samenvatting FROM router_stuk WHERE stuk_id = ? AND versie = ?');
  const doelQ = db.prepare("SELECT doel FROM bestemming WHERE stuk_id = ? AND versie = ? AND lens = 'kennis' AND status = 'bevestigd' AND doel IS NOT NULL");
  const versies = new Map();
  for (const r of rijen) {
    const ids = safeJson(r.ids);
    const hoofd = Array.isArray(ids) ? ids.find(function (x) { return x && !x.bijlage && x.route === route && x.origin === 'mail'; }) : null;
    if (!hoofd || !(Number(hoofd.revisie) > 0) || !Number.isSafeInteger(Number(hoofd.revisie))) continue;   // niet van deze route
    if (r.ps === 'quarantaine' || r.ps === 'verwijderd') continue;   // de RPC ruimt die zelf op (en weigert ze)
    t.stukken++;
    const rev = Number(hoofd.revisie);
    const versie = r.lv != null ? r.lv : r.versie;
    const sam = safeJson((samQ.get(r.stuk_id, versie) || {}).samenvatting) || {};
    let reden = null;
    if (!STUK_RE.test(r.stuk_id)) reden = 'vorm';
    else if (!/^mail@/.test(String(r.profiel))) reden = 'profiel';
    else if (MARKER_OK.indexOf(r.marker_patient) < 0) reden = 'marker';
    else if (r.staat === 'vastgehouden' || r.staat === 'weg') reden = 'staat';
    else if (r.keuze === 'hard') reden = 'buiten_brain';
    else if (sam.buiten_brain || sam.weging === 'hard') reden = 'buiten_brain';
    const v = { revision_id: rev, target_org_id: null, mentions: [] };
    if (reden) tel(t.buiten, reden);
    else {
      const meta = safeJson(r.meta) || {};
      const gezien = new Set();
      for (const [kop, rol] of KOPPEN) {
        for (const x of kopAdressen(meta[kop])) {
          const u = opl.los(x.adres);
          if (u.overslaan) { tel(t.adres, u.overslaan); continue; }
          if (x.nr > MAX_NR) { t.nr_te_hoog++; continue; }
          tel(t.adres, u.via);
          const k = kop + ':' + u.object_id;
          if (gezien.has(k)) continue;   // dezelfde entiteit twee keer in één kop: één vermelding (eerste positie)
          gezien.add(k);
          v.mentions.push({ kop, nr: x.nr, rol, object_id: u.object_id });
        }
      }
      if (v.mentions.length > MAX_VERMELDINGEN) { tel(t.buiten, 'te_veel'); v.mentions = []; }
      else {
        t.in_scope++;
        const doel = (doelQ.get(r.stuk_id, versie) || {}).doel;
        if (doel && doel !== 'PRIVE') {
          const oid = opl.eigenCode.get(doel);
          if (oid) { v.target_org_id = oid; t.met_target++; } else t.doel_onbekend++;
        }
        t.vermeldingen += v.mentions.length;
      }
    }
    const oud = versies.get(rev);
    if (oud) {   // twee stukken met dezelfde versie op deze route: buiten scope wint (dicht), anders de eerste
      t.dubbel++;
      if (reden) versies.set(rev, { revision_id: rev, target_org_id: null, mentions: [] });
      continue;
    }
    versies.set(rev, v);
  }
  return { versies, t };
}

function maak(o) {
  const rpc = o.rpc;
  const log = o.log || function () {};
  let bezig = false, laatste = null;

  async function koppel(route, lijst, droog, som) {
    for (let i = 0; i < lijst.length || i === 0; i += BATCH) {
      const r = await rpc('sb2_bericht_koppel', { p: { route, droog, versies: lijst.slice(i, i + BATCH) } });
      if (!r || typeof r !== 'object' || r.route !== route || !Number.isInteger(r.versies)) throw new Error('sb2_bericht_koppel: onverwacht antwoord');
      for (const k of ['versies', 'ok', 'nieuw', 'weg', 'gelijk', 'target_gezet', 'target_weg', 'artifact_nieuw', 'artifact_weg', 'opgeruimd_mention', 'opgeruimd_target'])
        tel(som, k, Number(r[k]) || 0);
      for (const k of Object.keys(r.geweigerd || {})) if (/^[a-z_]{1,20}$/.test(k)) { som.geweigerd = som.geweigerd || {}; tel(som.geweigerd, k, Number(r.geweigerd[k]) || 0); }
      som.vermeldingen_db = Number(r.vermeldingen) || 0;
      if (lijst.length === 0) break;
    }
    return som;
  }
  function verschil(s) {
    return ['nieuw', 'weg', 'target_gezet', 'target_weg', 'artifact_nieuw', 'artifact_weg', 'opgeruimd_mention', 'opgeruimd_target']
      .reduce(function (a, k) { return a + (Number(s[k]) || 0); }, 0);
  }

  async function ronde(opties) {
    opties = opties || {};
    const s = o.schakelaar ? o.schakelaar() : null;
    if (!s || s.aan !== true) return { uit: true };
    if (bezig) return { wacht: 'loopt al' };
    bezig = true;
    const start = Date.now();
    try {
      const routes = (Array.isArray(s.routes) ? s.routes : []).filter(function (r) { return ROUTES.indexOf(r) >= 0; });
      const reg = await rpc('sb2_bericht_register', {});
      if (!reg || !Array.isArray(reg.adres) || !Array.isArray(reg.eigen)) throw new Error('sb2_bericht_register: onverwacht antwoord');
      const opl = maakOplosser(reg, o.eigenAdressen ? o.eigenAdressen() : []);
      const uit = { ok: true, droog: !!opties.droog, routes: {}, register: opl.aantal };
      for (const route of routes) {
        const { versies, t } = versiesVan(o.db, route, opl);
        const st = await rpc('sb2_bericht_stand', { p_route: route });
        if (!st || !Array.isArray(st.revisies)) throw new Error('sb2_bericht_stand: onverwacht antwoord');
        let wees = 0;
        for (const x of st.revisies) {
          const rev = Number(x);
          if (Number.isSafeInteger(rev) && rev > 0 && !versies.has(rev)) { versies.set(rev, { revision_id: rev, target_org_id: null, mentions: [] }); wees++; }
        }
        const lijst = Array.from(versies.values()).sort(function (a, b) { return a.revision_id - b.revision_id; });
        const eerste = await koppel(route, lijst, !!opties.droog, {});
        const r = Object.assign({}, t, { niet_meer_op_pod: wees, verstuurd: lijst.length, eerste });
        if (!opties.droog) {
          const tweede = await koppel(route, lijst, true, {});
          r.tweede = verschil(tweede);
          if (r.tweede !== 0) { uit.ok = false; uit.reden = route + ': tweede ronde gaf ' + r.tweede + ' verschillen'; }
        }
        if (eerste.geweigerd && Object.keys(eerste.geweigerd).length) r.geweigerd = eerste.geweigerd;
        uit.routes[route] = r;
      }
      uit.ms = Date.now() - start;
      laatste = Object.assign({ op: new Date().toISOString() }, uit);
      log('sb2-berichten: ' + JSON.stringify(uit).slice(0, 1500));
      return uit;
    } finally { bezig = false; }
  }
  return { ronde, laatste: function () { return laatste; } };
}

module.exports = { maak, maakOplosser, kopAdressen, versiesVan, OPENBAAR, ROUTES };
