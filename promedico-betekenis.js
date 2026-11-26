'use strict';
/**
 * promedico-betekenis.js — Promedico-agenda als eigen laag in Apps › Calendar (wv3143, 15-11-2026, fase A van het Kalender-plan).
 *
 * WAAROM. David 15-11: de Promedico-stand (ontvanger promedico-agenda.js, wv3132) moet in zijn interne kalender staan, en vooral moet
 * zichtbaar zijn waar een privé-afspraak over een open spreekuur of een geboekte patiënt valt (aanleiding: ma 16-11 16:00). Hij gebruikt
 * de kleuren niet consequent, dus de betekenis per blok komt uit vaste regels, niet uit de kleur alleen. Plan + Codex-review (6 MOET,
 * 2 ZOU): vault 01_Ontwikkeling/Promedico-agenda meelezen - Chrome-extensie (bouwplan 15-11-2026).md § Kalender-laag. Dezelfde module
 * is later de rekenkern van de nachtstap promedico-botsingen (fase 2, wv3145); bouw daar geen tweede reconstructie.
 *
 * REGELS PER BLOK (eerste die past wint; 'regel' en 'reden' gaan mee naar het detail in de app):
 *   1 patient     blok met patiënt (elke kleur) → patiëntafspraak, bezet, nooit tekst, zeker.
 *   2 dagbreed    zonder patiënt en >= 10 uur → dagmarkering alleen met een expliciet patroon op de omschrijving of een vaste
 *                 blokregel (soort + van + tot + weekdag) in woordenlijst.dagmarkering (wv4145: oranje 07–19 di–vr, David 25-11), anders
 *                 'dagbreed, onbekend': die dag geen open uren, elke overlap = controleer (MOET 3).
 *   3 agenda      zonder patiënt, geen open-soort (MOET 1: 'op de dag' of roze nooit), en een Google-afspraak (niet hele dag) ligt voor
 *                 >= 50 % van zijn eigen duur in het blok → eigen afspraak (Jij/Gezin, met titel) of vergadering (Werk/HAGRO); zeker.
 *   4 correctie   (fase C, nog niet gebouwd) Davids eigen keuze voor hetzelfde blok.
 *   5 woordenlijst promedico-woorden.json op de omschrijving → waarschijnlijk.
 *   6 kleur       alleen een label, nooit beschikbaarheid (MOET 4): dekt niets en maakt niets open.
 * OPEN UREN: sjabloon consult/visite/belletje zonder blok erover, plus blokken 'open op de dag'; alleen op een recente blik in de
 *   werkweekweergave (MOET 5) en niet onder een dagbreed onbekend blok. Anders "open uren niet te bepalen" (nooit "vrij").
 * BOTSING (Google-afspraak van Jij of Gezin, niet hele dag): a patiënt geboekt (altijd eerst, ook onder een eigen blok; MOET 2) →
 *   d helemaal afgedekt door bekende eigen blokken → b rest over open uren → c rest onder onbekend/dagbreed onbekend/kleurblok →
 *   'geen' (buiten Promedico-tijd). Oud of niet gezien → 'niet beoordeelbaar', nooit 'geen conflict' (ZOU 2).
 *
 * Puur: geen bestanden, geen log, geen netwerk. maakApp() krijgt leesStaat() en rpc() van server.js. Tekst (omschrijving, dagnotitie,
 * Google-titel) gaat alleen in het antwoord aan Davids app-sessie, nooit in reden/info (dus nooit in log of audit).
 */

const VERSIE = 'promedico-betekenis@1';
const TZ = 'Europe/Amsterdam';
const DAG_MS = 86400000;
const OUD_MS = 3 * DAG_MS;                 // blik ouder dan 3 dagen (dag nog komend) = oud
const DAGBREED_MIN = 600;                  // >= 10 uur
const KORT_MIN = 15;                       // korte blokken (samengevat in de app; rood <= 15 min = kort blok)
const MAX_DAGEN = 62;
const OPEN_SOORTEN = ['consult', 'visite', 'belletje'];
const WEEKDAGEN = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const BOTS_AGENDA = ['david', 'gezin'];
const AGENDA_NAAM = { david: 'je agenda', gezin: 'Gezin', werk: 'Werk', hagro: 'HAGRO' };
const PATIENT_LABEL = { consult: 'consult', visite: 'visite', belletje: 'belletje', brief_info: 'brief' };
const PAD_RE = /^\/app\/promedico\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/;
const SPIEGEL_NOOT = 'Je Google-agenda wordt hier één keer per nacht (03:30) gelezen; een afspraak van vandaag telt pas morgen mee.';

// ── tijd en intervallen (minuten sinds middernacht, [van, tot)) ─────────────────────────────────────────────
function min(t) { if (t === '24:00') return 1440; const m = /^(\d{2}):(\d{2})$/.exec(String(t)); return m ? (+m[1]) * 60 + (+m[2]) : NaN; }
function hhmm(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function samen(lijst) {
  const s = lijst.filter((x) => x[1] > x[0]).map((x) => [x[0], x[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const uit = [];
  for (const x of s) { const l = uit[uit.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else uit.push(x); }
  return uit;
}
function zonder(a, b) {   // a − b, beide samen()
  let uit = samen(a);
  for (const [bv, bt] of samen(b)) {
    const n = [];
    for (const [v, t] of uit) { if (bt <= v || bv >= t) { n.push([v, t]); continue; } if (bv > v) n.push([v, bv]); if (bt < t) n.push([bt, t]); }
    uit = n;
  }
  return uit;
}
function snij(a, b) {
  const uit = [];
  for (const [av, at] of samen(a)) for (const [bv, bt] of samen(b)) { const v = Math.max(av, bv), t = Math.min(at, bt); if (t > v) uit.push([v, t]); }
  return samen(uit);
}
function lengte(a) { return a.reduce((n, x) => n + (x[1] - x[0]), 0); }
function raakt(a, b) { return snij(a, b).length > 0; }
function tijden(a) { return samen(a).map((x) => ({ van: hhmm(x[0]), tot: hhmm(x[1]) })); }

function dagNL(datum) { const d = new Date(datum + 'T12:00:00Z'); return ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'][d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'][d.getUTCMonth()]; }
function datumVan(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: TZ }); }
function klokVan(ms) { return new Date(ms).toLocaleTimeString('nl-NL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
function gezienTekst(ms) { return dagNL(datumVan(ms)) + ' ' + klokVan(ms); }

// ── woordenlijst ───────────────────────────────────────────────────────────────────────────────────────────────
/** Compileert de woordenlijst één keer; een patroon dat niet compileert wordt overgeslagen en geteld (nooit de hele lijst weg). */
function maakWoorden(j) {
  const uit = { dagmarkering: [], dagblokken: [], groepen: [], kapot: 0, versie: j && j.versie || null };
  const re = (p) => { try { return new RegExp(String(p), 'i'); } catch (e) { uit.kapot++; return null; } };
  if (j && j.dagmarkering && Array.isArray(j.dagmarkering.patronen)) uit.dagmarkering = j.dagmarkering.patronen.map(re).filter(Boolean);
  // wv4145: vaste blokregel; alles moet kloppen (soort, van, tot, weekdag), anders telt de regel als kapot en geldt hij niet.
  for (const r of (j && j.dagmarkering && Array.isArray(j.dagmarkering.blokken) ? j.dagmarkering.blokken : [])) {
    const dagen = r && Array.isArray(r.dagen) ? r.dagen.filter((d) => WEEKDAGEN.includes(d)) : [];
    if (!r || typeof r.soort !== 'string' || !r.soort || !Number.isFinite(min(r.van)) || !Number.isFinite(min(r.tot)) || !dagen.length || dagen.length !== r.dagen.length) { uit.kapot++; continue; }
    uit.dagblokken.push({ soort: r.soort, van: r.van, tot: r.tot, dagen });
  }
  for (const g of (j && Array.isArray(j.groepen) ? j.groepen : [])) {
    if (!g || typeof g.betekenis !== 'string' || !Array.isArray(g.patronen)) { uit.kapot++; continue; }
    uit.groepen.push({ betekenis: g.betekenis, label: String(g.label || g.betekenis), dekt: g.dekt === true, open: g.open === true, re: g.patronen.map(re).filter(Boolean) });
  }
  return uit;
}
let standaard = null;
function standaardWoorden() { if (!standaard) standaard = maakWoorden(require('./promedico-woorden.json')); return standaard; }
function zoekGroep(tekst, woorden) {
  if (!tekst) return null;
  for (const g of woorden.groepen) if (g.re.some((r) => r.test(tekst))) return g;
  return null;
}

// ── regels per blok ────────────────────────────────────────────────────────────────────────────────────────────
function isOpenSoort(b, w) {   // MOET 1: een blok dat open kan zijn, wordt nooit 'afgedekt' door een Google-afspraak
  if (b.soort === 'roze') return true;
  const g = zoekGroep(b.omschrijving, w);
  return !!(g && g.open);
}
function beteken(b, google, w, weekdag) {
  const v = min(b.van), t = min(b.tot), duur = t - v;
  const basis = { van: b.van, tot: b.tot, soort: b.soort, kleur: b.kleur || null, patient: b.patient === true, herhalend: b.herhalend === true, kort: duur <= KORT_MIN };
  // 1 patiënt
  if (b.patient === true) return Object.assign(basis, { betekenis: 'patient', label: PATIENT_LABEL[b.soort] || 'patiëntafspraak', zekerheid: 'zeker', regel: 'patient',
    reden: 'staat met een patiënt in Promedico (soort uit de kleur)', dekt: false, open: false, bezet: true });
  Object.assign(basis, { omschrijving: b.omschrijving || null, weggelaten: b.weggelaten === true });
  // 2 dagbreed
  if (duur >= DAGBREED_MIN) {
    if (b.omschrijving && w.dagmarkering.some((r) => r.test(b.omschrijving)))
      return Object.assign(basis, { betekenis: 'dagmarkering', label: 'dagmarkering', zekerheid: 'waarschijnlijk', regel: 'dagbreed', reden: 'dagbreed blok, omschrijving staat in de woordenlijst als dagmarkering', dekt: false, open: false, dagbreed: true });
    if ((w.dagblokken || []).some((r) => r.soort === b.soort && r.van === b.van && r.tot === b.tot && r.dagen.includes(weekdag)))
      return Object.assign(basis, { betekenis: 'dagmarkering', label: 'dagmarkering', zekerheid: 'waarschijnlijk', regel: 'dagbreed', reden: 'dagbreed blok met precies deze kleur, tijden en weekdag staat in de woordenlijst als dagmarkering', dekt: false, open: false, dagbreed: true });
    return Object.assign(basis, { betekenis: 'dagbreed_onbekend', label: 'dagbreed blok, betekenis onbekend', zekerheid: 'onbekend', regel: 'dagbreed',
      reden: 'blok van ' + Math.round(duur / 60) + ' uur zonder patiënt en zonder bekende omschrijving: die dag geen open uren, elke afspraak eronder = controleer', dekt: false, open: false, dagbreed: true });
  }
  // 3 afgedekt door je agenda (nooit een open-soort blok: MOET 1)
  if (!isOpenSoort(b, w)) {
    let beste = null;
    for (const g of google) {
      const eigen = g.tot - g.van; if (eigen <= 0) continue;
      const over = lengte(snij([[v, t]], [[g.van, g.tot]]));
      if (over * 2 < eigen) continue;
      const voorkeur = BOTS_AGENDA.includes(g.agenda) ? 1 : 0;
      if (!beste || over > beste.over || (over === beste.over && voorkeur > beste.voorkeur)) beste = { g, over, voorkeur };
    }
    if (beste) {
      const g = beste.g, prive = BOTS_AGENDA.includes(g.agenda);
      return Object.assign(basis, { betekenis: prive ? 'eigen_afspraak' : 'vergadering', label: prive ? 'eigen afspraak' : 'vergadering', zekerheid: 'zeker', regel: 'agenda',
        reden: 'een afspraak uit ' + (AGENDA_NAAM[g.agenda] || g.agenda) + ' (' + hhmm(g.van) + '–' + hhmm(g.tot) + ') valt voor minstens de helft in dit blok',
        titel: prive && g.titel ? g.titel : null, google_id: g.id, agenda: g.agenda, dekt: true, open: false });
    }
  }
  // 4 Davids correctie: fase C (nog niet gebouwd)
  // 5 woordenlijst
  const gr = zoekGroep(b.omschrijving, w);
  if (gr) return Object.assign(basis, { betekenis: gr.betekenis, label: gr.label, zekerheid: 'waarschijnlijk', regel: 'woordenlijst',
    reden: 'de omschrijving past in de woordenlijst (' + gr.label + ')', dekt: gr.dekt, open: gr.open });
  // 6 kleur: alleen een label (MOET 4)
  let label = 'geblokkeerd, reden onbekend', bet = 'geblokkeerd_onbekend', zek = 'onbekend';
  if (b.soort === 'grijs') { label = 'vrij / geen spreekuur'; bet = 'vrij_geen_spreekuur'; zek = 'waarschijnlijk'; }
  else if (b.soort === 'visite') { label = 'visiteronde'; bet = 'visiteronde'; zek = 'waarschijnlijk'; }
  else if (b.soort === 'rood' && duur <= KORT_MIN) { label = 'kort blok'; bet = 'kort_blok'; zek = 'waarschijnlijk'; }
  else if (b.soort === 'roze') { label = 'vermoedelijk open op de dag'; bet = 'vermoedelijk_open'; zek = 'onzeker'; }
  else if (b.soort === 'onbekend') { label = 'onbekend blok'; bet = 'onbekend'; zek = 'onbekend'; }
  return Object.assign(basis, { betekenis: bet, label, zekerheid: zek, regel: 'kleur',
    reden: 'alleen de kleur (' + b.soort + ') is bekend; de kleur zegt niets over beschikbaarheid', dekt: false, open: false });
}

/**
 * betekenDag(x, google, o) → de dag voor de app (en later de nachtstap).
 *   x       staat.datums[datum] van de ontvanger ({ gezien_ms, weergave, periode_van, periode_tot, dag }) of null (niet gezien)
 *   google  [{ id, agenda: david|gezin|werk|hagro, van, tot (minuten op deze dag), titel }] — alleen afspraken met een tijd
 *   o       { datum, vandaag, nuMs, woorden (maakWoorden) }
 */
function betekenDag(x, google, o) {
  o = o || {};
  const w = o.woorden || standaardWoorden();
  const nu = Number.isFinite(o.nuMs) ? o.nuMs : Date.now();
  const vandaag = o.vandaag || datumVan(nu);
  const g = (Array.isArray(google) ? google : []).filter((e) => e && Number.isFinite(e.van) && Number.isFinite(e.tot) && e.tot > e.van);
  const uit = { datum: o.datum, verleden: o.datum < vandaag, gezien: !!x, botsingen: [], blokken: [], dagbreed: [], sjabloon: [], open: [], patienten_buiten_sjabloon: 0 };
  if (!x || !x.dag) {
    uit.status = 'niet gezien';
    uit.open_bepaalbaar = false; uit.open_reden = 'niet gezien in Promedico (niet: vrij)';
    for (const e of g) if (BOTS_AGENDA.includes(e.agenda)) uit.botsingen.push(nb(e, 'niet gezien in Promedico'));
    return uit;
  }
  uit.gezien_ms = x.gezien_ms; uit.gezien_op = new Date(x.gezien_ms).toISOString(); uit.gezien_tekst = gezienTekst(x.gezien_ms); uit.weergave = x.weergave;
  uit.oud = !uit.verleden && nu - x.gezien_ms > OUD_MS;
  uit.status = uit.oud ? 'niet recent gezien (' + uit.gezien_tekst + ')' : 'gezien ' + uit.gezien_tekst;
  if (x.dag.dagnotitie) uit.dagnotitie = x.dag.dagnotitie; else if (x.dag.dagnotitie_weg) uit.dagnotitie_weg = true;

  const blokken = (Array.isArray(x.dag.blokken) ? x.dag.blokken : []).filter((b) => b && min(b.tot) > min(b.van))
    .map((b) => beteken(b, g, w, o.datum ? WEEKDAGEN[new Date(o.datum + 'T12:00:00Z').getUTCDay()] : null)).sort((a, b) => min(a.van) - min(b.van) || min(a.tot) - min(b.tot));
  const iv = (b) => [min(b.van), min(b.tot)];
  const patient = blokken.filter((b) => b.patient);
  const dagbreedOnbekend = blokken.filter((b) => b.betekenis === 'dagbreed_onbekend');
  const opDeDag = blokken.filter((b) => b.open);
  const dekkend = blokken.filter((b) => b.dekt);
  const bezet = blokken.filter((b) => !b.open && b.betekenis !== 'dagmarkering');   // dagmarkering is onschuldig en neemt niets in
  const sjabloon = (Array.isArray(x.dag.sjabloon) ? x.dag.sjabloon : []).filter((s) => s && min(s.tot) > min(s.van)).slice().sort((a, b) => min(a.van) - min(b.van));
  const sjOpen = samen(sjabloon.filter((s) => OPEN_SOORTEN.includes(s.soort)).map(iv));

  // open uren: alleen op een recente werkweekblik zonder dagbreed onbekend blok (MOET 5, MOET 3)
  let reden = null;
  if (uit.oud) reden = 'niet recent gezien';
  else if (x.weergave !== 'werkweek') reden = 'gezien in de ' + x.weergave + 'weergave; open uren alleen uit de werkweek';
  else if (dagbreedOnbekend.length) reden = 'dagbreed blok met onbekende betekenis';
  uit.open_bepaalbaar = !reden; uit.open_reden = reden;
  let openSj = [], openOdd = [];
  if (!reden) {
    const bez = samen(bezet.map(iv));
    openSj = zonder(sjOpen, bez);
    openOdd = zonder(samen(opDeDag.map(iv)), bez);
    uit.open = samen(openSj.concat(openOdd)).map((y) => ({ van: hhmm(y[0]), tot: hhmm(y[1]), zeker: raakt([y], openSj) }));
  }

  // sjabloondelen: aantal patiënten (begin in het deel) en open uren
  const geteld = new Set();
  for (const s of sjabloon) {
    const sv = min(s.van), st = min(s.tot);
    let n = 0;
    patient.forEach((p, i) => { const pv = min(p.van); if (pv >= sv && pv < st && !geteld.has(i)) { n++; geteld.add(i); } });
    uit.sjabloon.push({ van: s.van, tot: s.tot, soort: s.soort, kleur: s.kleur || null, patienten: n,
      open: reden ? null : tijden(snij([[sv, st]], openSj.concat(openOdd))) });
  }
  uit.patienten_buiten_sjabloon = patient.length - geteld.size;
  uit.patienten = patient.length;
  for (const b of blokken) {
    const kaal = Object.assign({}, b);
    delete kaal.dekt; delete kaal.open; delete kaal.bezet;
    if (b.patient) { delete kaal.omschrijving; delete kaal.weggelaten; delete kaal.titel; }   // patiëntblok: nooit tekst
    (b.dagbreed ? uit.dagbreed : uit.blokken).push(kaal);
  }

  // botsingen
  for (const e of g) {
    if (!BOTS_AGENDA.includes(e.agenda)) continue;
    if (uit.oud) { uit.botsingen.push(nb(e, 'niet recent gezien (' + uit.gezien_tekst + ')')); continue; }
    const E = [[e.van, e.tot]];
    const pat = snij(E, patient.map(iv));                                  // a: altijd eerst (MOET 2)
    if (pat.length) { uit.botsingen.push(bots(e, 'a', 'botst: patiënt geboekt', 'zeker', 'patient', 'er staat een patiënt geboekt ' + tijden(pat).map((y) => y.van + '–' + y.tot).join(', '), pat)); continue; }
    const K = samen(dekkend.map(iv));
    const U = zonder(E, K);
    const dekkers = dekkend.filter((b) => raakt(E, [iv(b)]));
    if (!U.length) {
      const zek = dekkers.every((b) => b.zekerheid === 'zeker') ? 'zeker' : 'waarschijnlijk';
      uit.botsingen.push(bots(e, 'd', 'afgedekt', zek, 'afgedekt', 'valt helemaal onder ' + dekkers.map((b) => b.label + ' ' + b.van + '–' + b.tot).join(', '), [])); continue;
    }
    if (!reden) {
      const op = snij(U, openSj.concat(openOdd));
      if (op.length) {
        const t = tijden(op).map((y) => y.van + '–' + y.tot).join(', ');
        uit.botsingen.push(bots(e, 'b', 'botst: spreekuur open ' + t, raakt(op, openSj) ? 'zeker' : 'waarschijnlijk', 'open', 'het spreekuur staat open ' + t + ' (geen blok eroverheen)', op)); continue;
      }
    }
    const db = snij(U, dagbreedOnbekend.map(iv));
    if (db.length) { uit.botsingen.push(bots(e, 'c', 'controleer', 'onzeker', 'dagbreed', 'valt onder een dagbreed blok met onbekende betekenis', db)); continue; }
    if (reden && raakt(U, sjOpen)) { uit.botsingen.push(nb(e, 'open uren niet te bepalen: ' + reden)); continue; }
    const ander = blokken.filter((b) => !b.patient && !b.dekt && b.betekenis !== 'dagmarkering' && raakt(U, [iv(b)]));
    if (ander.length) {
      uit.botsingen.push(bots(e, 'c', 'controleer', 'onzeker', 'onbekend', 'valt (deels) onder ' + ander.map((b) => b.label + ' ' + b.van + '–' + b.tot).join(', ') + '; betekenis niet zeker', snij(U, ander.map(iv)))); continue;
    }
    if (dekkers.length) { uit.botsingen.push(bots(e, 'd', 'afgedekt', 'waarschijnlijk', 'afgedekt', 'deels onder ' + dekkers.map((b) => b.label + ' ' + b.van + '–' + b.tot).join(', ') + ', de rest valt buiten Promedico-blokken en open uren', [])); continue; }
    uit.botsingen.push(bots(e, 'geen', null, 'zeker', 'buiten', 'valt buiten Promedico-blokken en open uren', []));
  }
  return uit;
}
function bots(e, uitkomst, label, zekerheid, regel, reden, iv) {
  return { google_id: e.id, agenda: e.agenda, van: hhmm(e.van), tot: hhmm(e.tot), uitkomst, label, zekerheid, regel, reden, tijden: tijden(iv) };
}
function nb(e, reden) { return bots(e, 'nb', 'niet beoordeelbaar', null, 'nb', reden, []); }

// ── Google-spiegel → per dag in minuten ────────────────────────────────────────────────────────────────────────
function plusDagen(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dagenTussen(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / DAG_MS); }
function geldigeDag(s) { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(s + 'T12:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s; }
function minVan(ms) { const t = klokVan(ms); return min(t); }
/** Tijdlijnrijen (sb_kalender_tijdlijn) → { 'JJJJ-MM-DD': [{ id, agenda, van, tot, titel }] }; alleen Google-spiegel met tijd. */
function googlePerDag(rijen) {
  const uit = {};
  for (const r0 of (Array.isArray(rijen) ? rijen : [])) {
    const r = r0 && r0.sb_kalender_tijdlijn && !r0.event_id ? r0.sb_kalender_tijdlijn : r0;
    if (!r || r.bron_soort !== 'google_spiegel' || r.hele_dag !== false || !r.begin_tijd || !r.eind_tijd) continue;
    if (r.status && r.status !== 'actief') continue;
    const b = Date.parse(r.begin_tijd), e = Date.parse(r.eind_tijd);
    if (!Number.isFinite(b) || !Number.isFinite(e) || e <= b) continue;
    let d = datumVan(b);
    const dEind = datumVan(e - 1);
    for (let i = 0; i < 14 && d <= dEind; i++, d = plusDagen(d, 1)) {
      const van = d === datumVan(b) ? minVan(b) : 0, tot = d === datumVan(e) ? minVan(e) : 1440;
      if (tot <= van) continue;
      (uit[d] = uit[d] || []).push({ id: Number(r.event_id), agenda: String(r.sync_agenda || ''), van, tot, titel: r.titel ? String(r.titel).slice(0, 300) : null });
    }
  }
  return uit;
}

// ── ISO-week (zelfde als de ontvanger) ──────────────────────────────────────────────────────────────────────────
function isoWeek(datum) {
  const t = Date.parse(datum + 'T00:00:00Z'), d = new Date(t);
  const dag = (d.getUTCDay() + 6) % 7;
  const do_ = new Date(t + (3 - dag) * DAG_MS);
  const jaar = do_.getUTCFullYear();
  const eerste = Date.UTC(jaar, 0, 4), ed = (new Date(eerste).getUTCDay() + 6) % 7;
  const week = 1 + Math.round((do_.getTime() - (eerste - ed * DAG_MS + 3 * DAG_MS)) / (7 * DAG_MS));
  return jaar + '-W' + String(week).padStart(2, '0');
}

/**
 * maakApp({ leesStaat() → tekst|null (null = nog geen staat), rpc(fn, body), woorden? }) → { app(verzoek), info() }
 *   GET /app/promedico/<van>/<tot>  (JJJJ-MM-DD, tot >= van, hooguit 62 dagen)
 * reden (voor de audit) en info() bevatten nooit tekst of tijden: alleen venster, aantal dagen en ms.
 */
function maakApp(o) {
  o = o || {};
  const w = o.woorden || standaardWoorden();
  const st = { laatste: null };
  async function app(v) {
    v = v || {};
    const nu = Number.isFinite(v.nu) ? v.nu : Date.now();
    const m = PAD_RE.exec(String(v.pad || ''));
    if (!m || v.methode !== 'GET') return { status: 404, body: { ok: false, fout: 'onbekend' }, reden: 'promedico onbekend' };
    const van = m[1], tot = m[2];
    if (!geldigeDag(van) || !geldigeDag(tot)) return { status: 400, body: { ok: false, fout: 'ongeldige datum' }, reden: 'promedico ongeldige datum' };
    if (tot < van) return { status: 400, body: { ok: false, fout: 'tot ligt vóór van' }, reden: 'promedico tot voor van' };
    if (dagenTussen(van, tot) > MAX_DAGEN) return { status: 400, body: { ok: false, fout: 'hooguit ' + MAX_DAGEN + ' dagen tegelijk' }, reden: 'promedico venster te lang' };
    const t0 = Date.now();
    let staat;
    try {
      const t = o.leesStaat();
      staat = t == null ? { versie: 2, datums: {}, log: {} } : JSON.parse(t);
      if (!staat || staat.versie !== 2 || !staat.datums || typeof staat.datums !== 'object') throw new Error('vorm');
    } catch (e) { st.laatste = { op: new Date(nu).toISOString(), fout: 'staat' }; throw new Error('promedico: staat onleesbaar'); }
    let rijen;
    try { rijen = await o.rpc('sb_kalender_tijdlijn', { p_van: van, p_tot: tot }); }
    catch (e) { st.laatste = { op: new Date(nu).toISOString(), fout: 'tijdlijn' }; throw new Error('promedico: tijdlijn onleesbaar'); }
    if (Array.isArray(rijen) && rijen.length >= 1000) { st.laatste = { op: new Date(nu).toISOString(), fout: 'tijdlijn vol' }; throw new Error('promedico: tijdlijn te vol voor dit venster'); }
    const gpd = googlePerDag(rijen);
    const vandaag = datumVan(nu);
    const dagen = [];
    for (let d = van; d <= tot; d = plusDagen(d, 1)) {
      const x = Object.prototype.hasOwnProperty.call(staat.datums, d) ? staat.datums[d] : null;
      dagen.push(betekenDag(x, gpd[d] || [], { datum: d, vandaag, nuMs: nu, woorden: w }));
    }
    // een week met een niet-herkende blik die nieuwer is dan de goede stand van die week: één regel
    const mislukt = [];
    const weken = new Set(dagen.map((d) => isoWeek(d.datum)));
    for (const wk of weken) {
      const mk = staat.mislukt && Object.prototype.hasOwnProperty.call(staat.mislukt, wk) ? staat.mislukt[wk] : null;
      if (!mk || !Number.isFinite(mk.gezien_ms)) continue;
      const goed = Math.max(0, ...Object.keys(staat.datums).filter((d) => isoWeek(d) === wk).map((d) => staat.datums[d].gezien_ms || 0));
      if (mk.gezien_ms > goed) mislukt.push({ week: wk, gezien_op: new Date(mk.gezien_ms).toISOString(), gezien_tekst: gezienTekst(mk.gezien_ms) });
    }
    const ms = Date.now() - t0;
    st.laatste = { op: new Date(nu).toISOString(), dagen: dagen.length, gezien: dagen.filter((d) => d.gezien).length, ms };
    return { status: 200, reden: 'promedico ' + van + '/' + tot + ' ' + dagen.length + ' dagen', body: {
      ok: true, van, tot, vandaag, module: VERSIE, spiegel_noot: SPIEGEL_NOOT, woorden_kapot: w.kapot || 0, mislukt, dagen } };
  }
  function info() { return Object.assign({ aan: true, module: VERSIE }, st.laatste ? { laatste: st.laatste } : {}); }
  return { app, info };
}

module.exports = { betekenDag, beteken, maakApp, maakWoorden, standaardWoorden, googlePerDag, isoWeek, samen, zonder, snij, min, hhmm,
  PAD_RE, MAX_DAGEN, VERSIE, OUD_MS, DAGBREED_MIN };
