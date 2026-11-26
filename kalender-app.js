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
 * wv3679 (21-11-2026, besluit nr 127 / 2C27, Davids Ja 12:39): "Gevonden, nog niet in je agenda". De datumdetector (datumcontrole.py)
 * zet elke gevonden afspraak/deadline als kandidaat op de tijdlijn; de app zag ze nooit. Twee routes erbij:
 *   GET  /app/kalender/gevonden           kandidaten vandaag t/m + 400 dagen (public.sb_kalender_gevonden, migratie 0031), elk met de
 *                                         vindzin (de pod leest hem zelf uit het stuk: de databank bewaart nooit een zin), het pad van het
 *                                         stuk (voor de link), zekerheid, waar het al stond bij het vinden (staat_er) en of het nu in je
 *                                         agenda of Deadlines lijkt te staan (zelfde dag en tijd / gedeeld woord: een hint, geen bewijs).
 *   POST /app/kalender/gevonden           { id, oordeel: 'klopt_niet' | 'terug' } → kandidaat ↔ afgewezen (één tik; afgewezen blijft weg,
 *                                         ook na een volgende detectorronde). Raakt nooit een agenda of Deadlines: "Zet in agenda" en
 *                                         "Naar Deadlines" lopen in de app via het gesprek met Socev (voorstel → Davids Ja → Poortwachter).
 * De vindzin gaat alleen in het antwoord aan Davids app-sessie, nooit in een log of de audit.
 *
 * wv4102 (26-11-2026, besluitenpagina nr 188 / 2C88, Davids Ja 25-11 21:42): verlopen deadlines bovenaan Calendar.
 *   GET  /app/kalender/verlopen           de regels van ## Actueel in het deadline-register met een datum vóór vandaag (o.verlopen: live
 *                                         uit het register via deadline-lijstje.js verlopen(), niet uit de databank die 's nachts bijloopt)
 *   POST /app/kalender/verlopen           { sleutel, keuze: 'gedaan' | 'laten_vallen' } → dezelfde schrijfroute als het actielijstje en
 *                                         Voor jou (deadline-lijstje.js schrijf/pasToe, plek 'Calendar'): de regel naar ## Afgehandeld.
 *                                         Titel en datum komen uit een verse lezing van het register, nooit uit de browser.
 *   Gekoppelde entiteiten krijgen 'pad' (primary_page_path, migratie 0032) zodat de app de naam aanklikbaar maakt.
 *
 * Puur: laadt niets, raakt geen bestanden; server.js geeft rpc(fn, body) mee (appSbRpc, service_role) en voor wv3679
 * stuk(bronpad, stuk) → { pad, tekst } | null (vault-veilig lezen, zoekt een verhuisd stuk op ovis_stuk).
 */
const PAD_RE = /^\/app\/kalender(?:\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2}))?$/;
const GEVONDEN_PAD = '/app/kalender/gevonden';
const VERLOPEN_PAD = '/app/kalender/verlopen';   // wv4102
const ENT_PAD_RE = /^[0-9]{2}_[^/]+(?:\/[^/]+)*\.md$/;
const entPad = (p) => (typeof p === 'string' && p.length <= 300 && ENT_PAD_RE.test(p) && !p.split('/').some((x) => x === '..' || x.startsWith('.')) ? p : null);
const GEVONDEN_DAGEN = 400;      // zelfde horizon als de detector (datumcontrole.py HORIZON)
const GEVONDEN_MAX = 500;        // = limit in public.sb_kalender_gevonden (migratie 0031)
const MAX_DAGEN = 62;
const STANDAARD_DAGEN = 30;
const RPC_MAX = 1000;
const MAX_REGELS = 5000;
const TZ = 'Europe/Amsterdam';

const SOORTEN = ['afspraak', 'ophaaldag', 'deadline', 'reis', 'dienst', 'afwezigheid', 'herinnering', 'mijlpaal', 'gebeurtenis', 'overig'];
const VOOR_WIE = ['david', 'gezin', 'socev', 'bezetting', 'info'];
const AGENDA = { david: 'je agenda', gezin: 'Gezin', werk: 'Werk', hagro: 'HAGRO' };
const BRON = { deadline_register: 'Deadlines', reispagina: 'Tripper', datumdetector: 'datumdetector', intake: 'Intake',
  handmatig: 'met de hand', socev: 'Socev', ghawa: 'GHAWA' };   // ghawa: wv3965, bij het lezen uit de GHAWA-app (o.extra)
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
    object_id: e.object_id ? String(e.object_id) : null, naam: String(e.naam).slice(0, 200), rol: e.rol ? String(e.rol).slice(0, 40) : null,
    pad: entPad(e.pad) }));   // wv4102: pagina van de entiteit (migratie 0032), of null
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

// ── wv3679: "Gevonden, nog niet in je agenda" ──
const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const DATUMACHTIG = new RegExp('\\d|' + MAANDEN.join('|') + '|\\b(jan|feb|mrt|apr|jun|jul|aug|sept?|okt|nov|dec)\\b', 'i');
const ZIN_RAND = 160;            // hooguit zoveel tekens vóór en na de treffer
const STAAT_ER = ['tijdlijn', 'deadlines', 'todoist'];
// code-point-positie (zoals Python telt) → UTF-16-index in s; -1 als s korter is
function cpIndex(s, n) {
  let i = 0, c = 0;
  while (i < s.length && c < n) { const k = s.charCodeAt(i); i += (k >= 0xd800 && k <= 0xdbff && i + 1 < s.length) ? 2 : 1; c++; }
  return c === n ? i : -1;
}
const plat = (t) => String(t).replace(/[*_#>|`\[\]]+/g, ' ').replace(/\s+/g, ' ');
/*
 * vindzin(tekst, offset, lengte) → { voor, treffer, na } of null. tekst = het kennisbestand zoals op schijf. De detector telt offset en lengte
 * in code points in het lijf ná de kop, gelezen zonder regeleindvertaling (datumcontrole.py ontleed_stuk + kd.lees_veilig). Wijkt de tekst
 * op die plek af (geen cijfer of maand: het stuk is sindsdien bewerkt), dan null: liever geen zin dan een verkeerde.
 */
function vindzin(tekst, offset, lengte) {
  if (typeof tekst !== 'string' || !tekst.startsWith('---\novis_stuk:')) return null;
  const e = tekst.indexOf('\n---\n', 4);
  if (e < 0 || !Number.isInteger(offset) || offset < 0) return null;
  const lijf = tekst.slice(e + 5);
  const b = cpIndex(lijf, offset);
  if (b < 0) return null;
  const l = Number.isInteger(lengte) && lengte > 0 ? Math.min(lengte, 120) : 1;
  const eRel = cpIndex(lijf.slice(b, b + l * 2 + 2), l);
  const t = eRel < 0 ? Math.min(lijf.length, b + l) : b + eRel;
  const treffer = lijf.slice(b, t);
  if (!treffer.trim() || !DATUMACHTIG.test(treffer)) return null;
  const vv = lijf.slice(Math.max(0, b - ZIN_RAND), b);
  let s0 = 0, m;
  const re = /[.!?]\s|\n\s*\n/g;
  while ((m = re.exec(vv))) s0 = m.index + m[0].length;
  const afVoor = s0 === 0 && b > ZIN_RAND;
  const nn = lijf.slice(t, t + ZIN_RAND);
  const m2 = /[.!?](?=\s|$)|\n\s*\n/.exec(nn);
  const afNa = !m2 && t + ZIN_RAND < lijf.length;
  const voor = (afVoor ? '…' : '') + plat(vv.slice(s0)).replace(/^\s+/, '');
  const na = plat(m2 ? nn.slice(0, m2.index + (m2[0].trim() ? 1 : 0)) : nn).replace(/\s+$/, '') + (afNa ? '…' : '');
  return { voor, treffer: plat(treffer).trim(), na };
}
const STOP = new Set(['afspraak', 'deadline', 'uitnodiging', 'herinnering', 'reminder', 'bericht', 'message', 'gmail', 'outlook', 'vergadering']);
function woorden(t) { return new Set((String(t || '').toLowerCase().match(/[a-zà-ÿ0-9]{5,}/g) || []).filter((w) => !STOP.has(w))); }
function deeltWoord(a, b) { const A = woorden(a); for (const w of woorden(b)) if (A.has(w)) return true; return false; }
/* nuIn(k, regels) → 'agenda' | 'deadlines' | null: staat er op die dag nu iets dat erop lijkt (zelfde begintijd, of een gedeeld woord van
   ≥ 5 letters in de titel)? Een hint voor de weergave ("lijkt al geregeld"), nooit een reden om iets weg te laten zonder dat David het ziet. */
function nuIn(k, regels) {
  let dl = null;
  for (const r of regels) {
    if (!(r.van <= k.van && r.tot >= k.van)) continue;
    const agenda = r.bron.soort === 'google_spiegel' || r.sync.stand === 'staat_erin';
    if (agenda && ((!k.hele_dag && !r.hele_dag && r.begin && r.begin === k.begin) || deeltWoord(k.onderwerp, r.titel))) return 'agenda';
    if (r.bron.soort === 'deadline_register' && deeltWoord(k.onderwerp, r.titel)) dl = 'deadlines';
  }
  return dl;
}
/* gevondenRegel(r) → wat de app van één kandidaat ziet (zonder zin; die zet gevonden() erbij). */
function gevondenRegel(r) {
  r = r && typeof r === 'object' ? r : {};
  const b = r.bron && typeof r.bron === 'object' ? r.bron : {};
  const heleDag = r.hele_dag !== false;
  const titel = String(r.titel || '(zonder titel)').slice(0, 300);
  return {
    id: Number(r.event_id), van: String(r.begin_datum || ''), tot: String(r.eind_datum || r.begin_datum || ''), hele_dag: heleDag,
    begin: heleDag ? null : tijd(r.begin_tijd), eind: heleDag ? null : tijd(r.eind_tijd),
    titel, onderwerp: titel.replace(/^(Afspraak|Deadline) uit: /, ''),
    soort: r.soort === 'deadline' ? 'deadline' : 'afspraak', zekerheid: r.zekerheid === 'redelijk' ? 'redelijk' : 'hoog',
    precisie: ['minuut', 'dag', 'week', 'maand', 'kwartaal', 'jaar'].includes(r.datum_precisie) ? r.datum_precisie : 'dag',
    staat_er: (Array.isArray(b.staat_er) ? b.staat_er : []).filter((x) => STAAT_ER.includes(x)),
    gevonden_op: dagVan(r.aangemaakt), stuk_pad: null, zin: null, nu_in: null,
    regel: typeof b.regel === 'string' && /^[a-z0-9_.@+-]{1,80}$/i.test(b.regel) ? b.regel : null,   // wv3978: detectorregel (rel.weekdag = weekdag zonder datum)
  };
}

/*
 * maak({ rpc(fn, body) → Promise<json> }) → { app(verzoek), info() }
 * verzoek = { methode, pad, nu } → Promise<{ status, body, reden }>; reden zonder titels (voor de audit).
 */
function maak(o) {
  o = o || {};
  const staat = { laatste: null };
  async function haal(van, tot, diepte, extra) {
    const rij = await o.rpc('sb_kalender_tijdlijn', Object.assign({ p_van: van, p_tot: tot }, extra || {}));
    const lijst = (Array.isArray(rij) ? rij : []).map((x) => (x && typeof x === 'object' && x.sb_kalender_tijdlijn && !x.event_id ? x.sb_kalender_tijdlijn : x));
    if (lijst.length < RPC_MAX) return lijst;
    if (van === tot || diepte > 6) throw new Error('kalender: te veel regels in één venster');
    const midden = plusDagen(van, Math.floor(dagenTussen(van, tot) / 2));
    const a = await haal(van, midden, diepte + 1, extra), b = await haal(plusDagen(midden, 1), tot, diepte + 1, extra);
    // een meerdaagse rij valt in beide helften: één keer
    const gezien = new Set(a.map((x) => x && x.event_id));
    return a.concat(b.filter((x) => !gezien.has(x && x.event_id)));
  }

  // wv3679: de kandidaten van de datumdetector, met vindzin en een hint of het intussen in je agenda of Deadlines staat
  async function gevonden(nu) {
    const vandaag = dagAmsterdam(nu), tot = plusDagen(vandaag, GEVONDEN_DAGEN);
    const t0 = Date.now();
    const rij = await o.rpc('sb_kalender_gevonden', { p_van: vandaag, p_tot: tot });
    const ruw = (Array.isArray(rij) ? rij : []).map((x) => (x && typeof x === 'object' && x.sb_kalender_gevonden && !x.event_id ? x.sb_kalender_gevonden : x))
      .filter((r) => r && Number.isFinite(Number(r.event_id)) && r.begin_datum);
    const regels = ruw.map(gevondenRegel);
    const stukken = new Map();
    let zonderZin = 0;
    for (let i = 0; i < ruw.length; i++) {
      const b = ruw[i].bron && typeof ruw[i].bron === 'object' ? ruw[i].bron : {};
      const k = String(b.bronpad || '') + '\n' + String(b.stuk || '');
      let st = stukken.get(k);
      if (st === undefined) {
        st = null;
        try { st = typeof o.stuk === 'function' && b.bronpad ? o.stuk(String(b.bronpad), b.stuk ? String(b.stuk) : null) : null; } catch (e) { st = null; }
        stukken.set(k, st);
      }
      if (st && st.pad) regels[i].stuk_pad = String(st.pad);
      regels[i].zin = st && st.tekst ? vindzin(st.tekst, Number(b.offset), Number(b.lengte)) : null;
      if (!regels[i].zin) zonderZin++;
    }
    if (regels.length) {
      const van = regels.reduce((m, r) => (r.van < m ? r.van : m), regels[0].van), eind = regels.reduce((m, r) => (r.van > m ? r.van : m), regels[0].van);
      let tl = [];
      try { tl = (await haal(van, eind, 0, { p_voor_wie: ['david', 'gezin'] })).filter((r) => r && r.event_id != null && r.begin_datum).map(regel); }
      catch (e) { tl = null; }   // zonder tijdlijn geen hint; de lijst zelf blijft
      if (tl) for (const r of regels) r.nu_in = nuIn(r, tl);
    }
    staat.gevonden = { op: new Date(nu).toISOString(), regels: regels.length, zonder_zin: zonderZin, ms: Date.now() - t0 };
    // review wv3679 ZOU 1: de databank geeft hooguit GEVONDEN_MAX rijen; dan zegt de app dat er meer zijn (nooit stil afkappen)
    return { status: 200, reden: 'kalender gevonden ' + regels.length, body: { ok: true, vandaag, van: vandaag, tot, regels, meer: ruw.length >= GEVONDEN_MAX } };
  }
  async function oordeel(d) {
    d = d && typeof d === 'object' ? d : {};
    const id = Number(d.id);
    if (!Number.isSafeInteger(id) || id <= 0 || (d.oordeel !== 'klopt_niet' && d.oordeel !== 'terug'))
      return { status: 400, body: { ok: false, fout: 'ongeldig verzoek' }, reden: 'kalender oordeel ongeldig' };
    let x = await o.rpc('sb_kalender_kandidaat_oordeel', { p_event_id: id, p_oordeel: d.oordeel });
    if (Array.isArray(x)) x = x[0];
    if (x && typeof x === 'object' && x.sb_kalender_kandidaat_oordeel) x = x.sb_kalender_kandidaat_oordeel;
    x = x && typeof x === 'object' ? x : {};
    const reden = 'kalender oordeel ' + id + ' ' + d.oordeel + ' ';
    if (x.ok === true) return { status: 200, body: { ok: true, id, status: String(x.status || '') }, reden: reden + 200 };
    if (x.fout === 'onbekend') return { status: 404, body: { ok: false, fout: 'deze vondst bestaat niet (meer)' }, reden: reden + 404 };
    if (x.fout === 'status') return { status: 409, body: { ok: false, fout: 'deze vondst is al ' + (x.status === 'actief' ? 'overgenomen' : String(x.status || 'veranderd')) }, reden: reden + 409 };
    throw new Error('kalender: onverwacht antwoord op oordeel');
  }
  // wv4102: verlopen deadlines (live uit het register) en ze sluiten via de schrijfroute van het actielijstje
  const SLEUTEL_RE = /^dl:[0-9a-f]{40}$/;
  async function verlopen(nu) {
    const l = await o.verlopen();
    const regels = (Array.isArray(l) ? l : []).filter((x) => x && SLEUTEL_RE.test(String(x.sleutel)) && geldigeDag(x.datum)).map((x) => ({
      sleutel: String(x.sleutel), datum: x.datum, titel: String(x.titel || '(zonder titel)').slice(0, 200), entiteit: String(x.entiteit || '').slice(0, 120),
      etiket: x.etiket === 'socev' || x.etiket === 'info' ? x.etiket : 'jij', actie: String(x.actie || '').slice(0, 300) }));
    const t = { jij: 0, socev: 0, info: 0 };
    for (const r of regels) t[r.etiket]++;
    staat.verlopen = { op: new Date(nu).toISOString(), regels: regels.length };
    return { status: 200, reden: 'kalender verlopen ' + regels.length, body: { ok: true, vandaag: dagAmsterdam(nu), regels, tel: t } };
  }
  async function sluit(d, nu) {
    d = d && typeof d === 'object' ? d : {};
    if (!SLEUTEL_RE.test(String(d.sleutel)) || (d.keuze !== 'gedaan' && d.keuze !== 'laten_vallen'))
      return { status: 400, body: { ok: false, fout: 'ongeldig verzoek' }, reden: 'kalender verlopen ongeldig' };
    const reden = 'kalender verlopen ' + d.keuze + ' ' + String(d.sleutel).slice(0, 11) + ' ';
    const it = ((await o.verlopen()) || []).find((x) => x && x.sleutel === d.sleutel);
    if (!it) return { status: 409, body: { ok: false, fout: 'deze deadline staat niet meer open in het register' }, reden: reden + 'weg' };
    const r = await o.sluit({ sleutel: it.sleutel, datum: it.datum, titel: String(it.titel || ''), keuze: d.keuze, vandaag: dagAmsterdam(nu), plek: 'Calendar' });
    const u = r && r.u ? r.u : {};
    if (r && r.ok && u.tekst) return { status: 200, body: { ok: true, sleutel: it.sleutel }, reden: reden + 'regel ' + (u.regel || '?') };
    if (u.niets === 'al afgehandeld') return { status: 200, body: { ok: true, sleutel: it.sleutel, al: true }, reden: reden + 'al' };
    if (u.niets === 'passief') return { status: 409, body: { ok: false, fout: 'deze pod schrijft het register nu niet; probeer het zo opnieuw' }, reden: reden + 'passief' };
    if (!u.niets || u.niets === 'pagina veranderde') return { status: 409, body: { ok: false, fout: 'het register veranderde net; probeer het opnieuw' }, reden: reden + 'veranderd' };
    return { status: 409, body: { ok: false, fout: 'deze regel is niet zeker te vinden in het register (' + String(u.niets).slice(0, 60) + ')' }, reden: reden + 'niet' };
  }
  async function app(v) {
    v = v || {};
    const nu = Number.isFinite(v.nu) ? v.nu : Date.now();
    if (String(v.pad || '') === VERLOPEN_PAD) {
      if (typeof o.verlopen !== 'function' || typeof o.sluit !== 'function') return { status: 404, body: { ok: false, fout: 'onbekend' }, reden: 'kalender verlopen ontbreekt' };
      if (v.methode === 'GET') return verlopen(nu);
      if (v.methode === 'POST') return sluit(v.body, nu);
      return { status: 404, body: { ok: false, fout: 'onbekend' }, reden: 'kalender onbekend' };
    }
    if (String(v.pad || '') === GEVONDEN_PAD) {
      if (v.methode === 'GET') return gevonden(nu);
      if (v.methode === 'POST') return oordeel(v.body);
      return { status: 404, body: { ok: false, fout: 'onbekend' }, reden: 'kalender onbekend' };
    }
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
    // wv3965 (2C63 e): extra items die de pod bij het lezen uitrekent (GHAWA-mijlpalen, toezeggingen, ANBI-datum). Geen opslag, dus nooit dubbel;
    // een fout daar laat de tijdlijn gewoon staan (info().extra_fout). Negatieve id's: nooit gelijk aan een event_id uit de databank.
    if (typeof o.extra === 'function') {
      try { const x = o.extra(w.van, w.tot); if (Array.isArray(x)) ruw = ruw.concat(x.filter((r) => r && Number(r.event_id) < 0)); staat.extra_fout = null; }
      catch (e) { staat.extra_fout = new Date(nu).toISOString(); }
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
  function info() { return Object.assign({ aan: true }, staat.laatste ? { laatste: staat.laatste } : {}, staat.gevonden ? { gevonden: staat.gevonden } : {}, staat.extra_fout ? { extra_fout: staat.extra_fout } : {}, staat.verlopen ? { verlopen: staat.verlopen } : {}); }
  return { app, info };
}

module.exports = { maak, regel, entPad, VERLOPEN_PAD, bronTekst, syncTekst, vindzin, gevondenRegel, nuIn, cpIndex, GEVONDEN_PAD, venster: (pad, nu) => { const m = PAD_RE.exec(pad); return m ? venster(m, nu) : null; }, PAD_RE, MAX_DAGEN, SOORTEN, VOOR_WIE };
