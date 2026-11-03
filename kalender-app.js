'use strict';
/*
 * OVIS Calendar in de app (wv2333, 3-11-2026; idee 27 meetpunt 5). De tijdlijn (secondbrain.event: Google-spiegel, deadlines, GAD-afval,
 * roosterdiensten, reizen) bestond alleen in de databank; David zag hem nergens. Hier één leesroute achter de app-sessie:
 *
 *   GET /app/kalender                       vandaag t/m vandaag + 30
 *   GET /app/kalender/<van>/<tot>           YYYY-MM-DD, tot >= van, hooguit 62 dagen, jaar 2024 t/m volgend jaar + 1
 *
 * Bron: public.sb_kalender_tijdlijn(p_van, p_tot) (service_role, alleen actieve rijen, zonder reeks-moederrijen). Geen nieuwe
 * databanktoegang voor de browser; de browser krijgt alleen de vorm hieronder. Alleen lezen: geen schrijfpad, niets naar een agenda.
 * Privacy: titels (Google-spiegel kan namen bevatten) gaan alleen in het antwoord aan Davids app-sessie, nooit in een log; de audit van
 * server.js noemt alleen het venster en de status.
 * PostgREST geeft hooguit 1000 rijen per rpc: komen er 1000 terug, dan splitst de module het venster (zie mk-geheugen postgrest-rpc-1000-rijen).
 *
 * Puur: laadt niets, raakt geen bestanden; server.js geeft rpc(fn, body) mee (appSbRpc, service_role).
 */
const PAD_RE = /^\/app\/kalender(?:\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2}))?$/;
const MAX_DAGEN = 62;
const STANDAARD_DAGEN = 30;
const RPC_MAX = 1000;
const MAX_REGELS = 5000;
const TZ = 'Europe/Amsterdam';

const SOORTEN = ['afspraak', 'ophaaldag', 'deadline', 'reis', 'dienst', 'afwezigheid', 'herinnering', 'mijlpaal', 'gebeurtenis', 'overig'];
const VOOR_WIE = ['david', 'gezin', 'socev', 'bezetting', 'info'];
const AGENDA = { david: 'je agenda', gezin: 'Gezin', werk: 'Werk', hagro: 'HAGRO' };
const BRON = { deadline_register: 'Deadlines', reispagina: 'Tripper', datumdetector: 'datumdetector', intake: 'Intake',
  handmatig: 'met de hand', socev: 'Socev' };
const SYNC = { gespiegeld: 'kopie van Google', geen: 'niet in een agenda', moet_erin: 'moet nog in je agenda', staat_erin: 'staat in je agenda' };

function dagAmsterdam(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: TZ }); }
function geldigeDag(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function plusDagen(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dagenTussen(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }
function tijd(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleTimeString('nl-NL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
function dagVan(iso) { if (!iso) return null; const d = new Date(iso); return isNaN(d) ? null : d.toLocaleDateString('sv-SE', { timeZone: TZ }); }

/* bronTekst(r) → korte herkomst in gewone taal ("Google · Gezin", "Rooster Tolgaarde", "GAD-afvalkalender", "Deadlines"). */
function bronTekst(r) {
  const feed = r.feed ? String(r.feed) : '';
  if (r.bron_soort === 'google_spiegel') return 'Google · ' + (AGENDA[r.sync_agenda] || String(r.sync_agenda || 'agenda'));
  if (r.bron_soort === 'ical_feed') {
    if (feed === 'gad-afval') return 'GAD-afvalkalender';
    const m = /^rooster-(tg|gh)-(artsen|gezocht)$/.exec(feed);
    if (m) return 'Rooster ' + (m[1] === 'tg' ? 'Tolgaarde' : 'Groenhouten') + (m[2] === 'gezocht' ? ' (open dienst)' : '');
    return feed ? 'Feed ' + feed : 'Externe kalender';
  }
  return BRON[r.bron_soort] || String(r.bron_soort || 'onbekend');
}
function syncTekst(r) {
  const t = SYNC[r.sync_stand] || String(r.sync_stand || '');
  if ((r.sync_stand === 'staat_erin' || r.sync_stand === 'moet_erin') && r.sync_agenda && AGENDA[r.sync_agenda] && r.sync_agenda !== 'david')
    return t.replace('je agenda', 'agenda ' + AGENDA[r.sync_agenda]);
  return t;
}

/* regel(r) → wat de app van één tijdlijnrij ziet. Onbekende soort/voor_wie blijven zichtbaar (als 'overig' / 'info'), nooit stil weg. */
function regel(r) {
  r = r && typeof r === 'object' ? r : {};
  const ents = (Array.isArray(r.entiteiten) ? r.entiteiten : []).filter((e) => e && e.naam).map((e) => ({
    object_id: e.object_id ? String(e.object_id) : null, naam: String(e.naam).slice(0, 200), rol: e.rol ? String(e.rol).slice(0, 40) : null }));
  const heleDag = r.hele_dag !== false;
  const begin = heleDag ? null : tijd(r.begin_tijd), eind = heleDag ? null : tijd(r.eind_tijd);
  const eindDag = heleDag ? null : dagVan(r.eind_tijd);
  return {
    id: Number(r.event_id), van: String(r.begin_datum || ''), tot: String(r.eind_datum || r.begin_datum || ''), hele_dag: heleDag,
    begin, eind, eind_dag: eindDag && eindDag !== String(r.begin_datum) ? eindDag : null,
    titel: String(r.titel || '(zonder titel)').slice(0, 300),
    soort: SOORTEN.includes(r.soort) ? r.soort : 'overig', voor_wie: VOOR_WIE.includes(r.voor_wie) ? r.voor_wie : 'info',
    zekerheid: r.zekerheid === 'redelijk' || r.zekerheid === 'zwak' ? r.zekerheid : 'hoog',
    bron: { soort: String(r.bron_soort || ''), feed: r.feed ? String(r.feed) : null, agenda: r.sync_agenda ? String(r.sync_agenda) : null, tekst: bronTekst(r) },
    sync: { stand: String(r.sync_stand || 'geen'), tekst: syncTekst(r) },
    entiteiten: ents,
  };
}

function tel(regels, veld, lijst) {
  const t = {};
  for (const k of lijst) t[k] = 0;
  for (const r of regels) t[r[veld]] = (t[r[veld]] || 0) + 1;
  return t;
}

/* venster(pad, nu) → { van, tot } of { fout, status } */
function venster(m, nu) {
  const vandaag = dagAmsterdam(nu);
  if (!m[1]) return { van: vandaag, tot: plusDagen(vandaag, STANDAARD_DAGEN), vandaag };
  const van = m[1], tot = m[2];
  if (!geldigeDag(van) || !geldigeDag(tot)) return { status: 400, fout: 'ongeldige datum' };
  if (tot < van) return { status: 400, fout: 'tot ligt vóór van' };
  if (dagenTussen(van, tot) > MAX_DAGEN) return { status: 400, fout: 'hooguit ' + MAX_DAGEN + ' dagen tegelijk' };
  const jaar = Number(vandaag.slice(0, 4));
  if (Number(van.slice(0, 4)) < 2024 || Number(tot.slice(0, 4)) > jaar + 2) return { status: 400, fout: 'buiten het bereik van de tijdlijn' };
  return { van, tot, vandaag };
}

/*
 * maak({ rpc(fn, body) → Promise<json> }) → { app(verzoek), info() }
 * verzoek = { methode, pad, nu } → Promise<{ status, body, reden }>; reden zonder titels (voor de audit).
 */
function maak(o) {
  o = o || {};
  const staat = { laatste: null };
  async function haal(van, tot, diepte) {
    const rij = await o.rpc('sb_kalender_tijdlijn', { p_van: van, p_tot: tot });
    const lijst = (Array.isArray(rij) ? rij : []).map((x) => (x && typeof x === 'object' && x.sb_kalender_tijdlijn && !x.event_id ? x.sb_kalender_tijdlijn : x));
    if (lijst.length < RPC_MAX) return lijst;
    if (van === tot || diepte > 6) throw new Error('kalender: te veel regels in één venster');
    const midden = plusDagen(van, Math.floor(dagenTussen(van, tot) / 2));
    const a = await haal(van, midden, diepte + 1), b = await haal(plusDagen(midden, 1), tot, diepte + 1);
    // een meerdaagse rij valt in beide helften: één keer
    const gezien = new Set(a.map((x) => x && x.event_id));
    return a.concat(b.filter((x) => !gezien.has(x && x.event_id)));
  }
  async function app(v) {
    v = v || {};
    const nu = Number.isFinite(v.nu) ? v.nu : Date.now();
    const m = PAD_RE.exec(String(v.pad || ''));
    if (!m || v.methode !== 'GET') return { status: 404, body: { ok: false, fout: 'onbekend' }, reden: 'kalender onbekend' };
    const w = venster(m, nu);
    if (w.fout) return { status: w.status, body: { ok: false, fout: w.fout }, reden: 'kalender ' + w.fout };
    const t0 = Date.now();
    let ruw;
    try { ruw = await haal(w.van, w.tot, 0); } catch (e) {
      staat.laatste = { op: new Date(nu).toISOString(), fout: true };
      throw e;
    }
    // review wv2333 MOET 1/2: nooit stil afkappen; boven de grens een fout met de vraag om een korter venster
    if (ruw.length > MAX_REGELS) {
      staat.laatste = { op: new Date(nu).toISOString(), te_veel: ruw.length };
      return { status: 422, body: { ok: false, fout: 'te veel regels in dit venster (' + ruw.length + '); kies een kortere periode' }, reden: 'kalender te veel ' + ruw.length };
    }
    const kapot = ruw.filter((r) => !(r && r.event_id != null && r.event_id !== '' && Number.isFinite(Number(r.event_id)) && r.begin_datum));
    if (kapot.length) throw new Error('kalender: ' + kapot.length + ' regel(s) zonder id of datum');
    const regels = ruw.map(regel);
    regels.sort((a, b) => (a.van < b.van ? -1 : a.van > b.van ? 1 : 0) || (b.hele_dag - a.hele_dag) || String(a.begin || '').localeCompare(String(b.begin || '')) || a.titel.localeCompare(b.titel, 'nl'));
    staat.laatste = { op: new Date(nu).toISOString(), regels: regels.length, ms: Date.now() - t0 };
    return { status: 200, reden: 'kalender ' + w.van + '/' + w.tot + ' ' + regels.length, body: {
      ok: true, van: w.van, tot: w.tot, vandaag: w.vandaag, max_dagen: MAX_DAGEN, regels,
      tel: { soort: tel(regels, 'soort', SOORTEN), voor_wie: tel(regels, 'voor_wie', VOOR_WIE) },
    } };
  }
  function info() { return Object.assign({ aan: true }, staat.laatste ? { laatste: staat.laatste } : {}); }
  return { app, info };
}

module.exports = { maak, regel, bronTekst, syncTekst, venster: (pad, nu) => { const m = PAD_RE.exec(pad); return m ? venster(m, nu) : null; }, PAD_RE, MAX_DAGEN, SOORTEN, VOOR_WIE };
