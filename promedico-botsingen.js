'use strict';
/**
 * promedico-botsingen.js — nachtketenstap promedico-botsingen (wv3145, 15-11-2026; fase 2 van het bouwplan "Promedico-agenda meelezen",
 * vault 01_Ontwikkeling/Promedico-agenda meelezen - Chrome-extensie (bouwplan 15-11-2026).md § "Fase 2 — Agenda-Wachter, ontwerp" F2.1).
 *
 * WAAROM. David zette ma 16-11 16:00 een privé-afspraak terwijl in Promedico zijn spreekuur open stond. Hij wil 's ochtends horen als een
 * eigen of Gezin-afspraak zeker botst met Promedico (patiënt geboekt of spreekuur open), met de datum van zijn laatste blik. Codex-review
 * wv3144 (NO-GO, 2 MOET): actualiteit, selectie en datum/tijden van zo'n melding horen niet bij een taalmodel → deze stap rekent, kiest en
 * bouwt de regel zelf en zet hooguit één rij in ochtend_buffer (bron promedico; de briefing van 07:00 neemt hem mee als "Overige bron");
 * vandaag + 13 raakt drie ISO-weken → altijd drie pagina's.
 *
 * HOE. doe({ ams }) na de Google-spiegel (stap ovis-agenda, 03:30):
 *   1. Stempel van ovis-agenda van vannacht niet 'klaar' (fout, overgeslagen, ontbreekt, niet in de release) = spiegel niet van vannacht:
 *      pagina's toch, elke dag "niet beoordeelbaar: spiegel niet van vannacht", geen botsingen, geen bufferrij. Nooit een oude spiegel.
 *   2. staat.json van de ontvanger (alleen-lezend) + spiegelrijen (sb_kalender_tijdlijn) vandaag..vandaag+13 → per dag betekenDag()
 *      uit promedico-betekenis.js (wv3143; geen tweede reconstructie).
 *   3. Drie weekpagina's "<map>/Promedico-agenda <jjjj>-W<ww> - botsingen.md": alleen labels, tijden, zekerheid, event-id, gezien op,
 *      spiegel_op. Nooit HIS-tekst (omschrijving, dagnotitie, aantal patiënten) en nooit Google-tekst (titel). Elke regel moet aan een
 *      vaste grammatica voldoen (tekstfilter); één regel die dat niet doet = niets schrijven, stap fout. Alleen dit naampatroon
 *      (padcontrole; de ontvanger schrijft alleen "Promedico-agenda <week>.md"). Ongewijzigd = niet herschrijven.
 *   4. Melding: alleen uitkomst a/b met zekerheid 'zeker' (betekenDag geeft bij een oude blik al 'niet beoordeelbaar'). Register
 *      gemeld.json (0600): sleutel datum|event|uitkomst|van–tot|tijden|gezien_ms; al gemeld = niet opnieuw. Eerst de bufferrij (upsert,
 *      teruggelezen), dan het register: mislukt de buffer, dan ok:false en de herhaling van de keten probeert het opnieuw.
 *      Hooguit 5 regels; meer = "en n andere" (die worden niet als gemeld vastgelegd en komen de volgende nacht).
 *   5. Opruimen: botsingenpagina's van weken die meer dan 8 weken voorbij zijn (alleen het exacte naampatroon); register na de afspraak + 7 d.
 * Log en /health: alleen aantallen (weken, dagen, ms, per_uitkomst, gemeld), nooit tijden, event-id's of tekst.
 * Puur op de meegegeven functies (vault-veilig, tijdlijn, stempel, buffer), zodat test/promedico-botsingen.sh het met nepklok draait.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const B = require('./promedico-betekenis.js');

const KOP = 'Promedico-agenda';
const ACHTER = ' - botsingen.md';
const DAGEN = 14;                          // vandaag t/m vandaag + 13
const WEKEN = 3;                           // lopende + twee volgende ISO-weken (review wv3144 MOET 2)
const PAGINA_BEWAAR_DAGEN = 56;            // 8 weken
const REGISTER_NA_DAGEN = 7;
const MAX_REGELS = 5;
const BRON = 'promedico';
const WEEK_RE = /^(\d{4})-W(\d{2})$/;
const BOTS_NAAM_RE = /^Promedico-agenda (\d{4})-W(\d{2}) - botsingen\.md$/;
const DAG_KORT = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const AGENDA_PAGINA = { david: 'Jij', gezin: 'Gezin' };
const AGENDA_REGEL = { david: 'je agenda', gezin: 'Gezin-agenda' };
const TZ = 'Europe/Amsterdam';

// ── padcontrole: deze stap schrijft alleen "<KOP> <jjjj>-W<ww> - botsingen.md" ─────────────────────────────────
function botsingenNaam(week) {
  if (typeof week !== 'string' || !WEEK_RE.test(week)) throw new Error('padcontrole: geen weeknaam');
  const n = KOP + ' ' + week + ACHTER;
  if (!BOTS_NAAM_RE.test(n)) throw new Error('padcontrole: naam');
  return n;
}

// ── tekstfilter: elke regel van pagina en melding volgt een vaste grammatica (alleen labels, tijden, datums, getallen) ─────────
const T = '\\d{2}:\\d{2}', IV = T + '–' + T, IVS = IV + '(?:, ' + IV + ')*';
const DATUM = '\\d{4}-\\d{2}-\\d{2}', ISO = DATUM + 'T' + T + ':\\d{2}[+-]\\d{2}:\\d{2}';
const NB = 'niet beoordeelbaar: (?:niet gezien|oud|open uren niet te bepalen|spiegel niet van vannacht)';
const UITKOMST = '(?:a patiënt geboekt|b spreekuur open ' + IVS + '|c controleer|d afgedekt|buiten Promedico-tijd|' + NB + ')';
const KORTDAG = '(?:zo|ma|di|wo|do|vr|za) \\d{1,2}-\\d{1,2}';
const GRAMMATICA = [
  new RegExp('^---$'),
  new RegExp('^soort: promedico-botsingen$'),
  new RegExp('^week: \\d{4}-W\\d{2}$'),
  new RegExp('^berekend_op: ' + ISO + '$'),
  new RegExp('^spiegel_op: (?:' + ISO + '|niet van vannacht)$'),
  new RegExp('^module: promedico-betekenis@\\d+$'),
  new RegExp('^venster: ' + DATUM + ' t/m ' + DATUM + '$'),
  new RegExp('^# Promedico-agenda \\d{4}-W\\d{2} - botsingen$'),
  new RegExp('^$'),
  new RegExp('^## (?:' + KORTDAG + ') ' + DATUM + '$'),
  new RegExp('^- status: (?:niet gezien|gezien ' + ISO + ' \\([a-z0-9_]{1,30}\\))(?: · (?:oud|open uren niet te bepalen|spiegel niet van vannacht))*$'),
  new RegExp('^- (?:Jij|Gezin) · event (?:\\d{1,15}|\\?) · ' + IV + ' · ' + UITKOMST + ' · (?:zeker|waarschijnlijk|onzeker|—) · regel [a-z]{1,12}$'),
  new RegExp('^- geen afspraken van Jij of Gezin met een tijd$'),
  new RegExp('^- geen dagen van deze week in het venster$'),
  new RegExp('^- botsingen: geen \\(spiegel niet van vannacht\\)$'),
  new RegExp('^Naslag, elke nacht door de pod berekend \\(stap promedico-botsingen\\)\\. Alleen labels, tijden en zekerheid; geen tekst uit Promedico of uit de agenda\\.$'),
  new RegExp('^Zekere botsingen \\(a, b\\) staan in het ochtendbericht\\. Wat hier niet staat, is niet beoordeeld; nooit "vrij"\\.$'),
  new RegExp('^Uitkomst: a patiënt geboekt · b spreekuur open · c controleer · d afgedekt · buiten Promedico-tijd · niet beoordeelbaar\\.$')
];
const MELD_KOP = 'Promedico-agenda, zekere botsing(en) met je agenda:';
const MELD_GRAMMATICA = [
  new RegExp('^' + MELD_KOP.replace(/[().]/g, '\\$&') + '$'),
  new RegExp('^- ' + KORTDAG + ' ' + IV + ' \\((?:je agenda|Gezin-agenda)\\): (?:er staat een patiënt geboekt|Promedico-spreekuur staat open ' + IVS + ') — Promedico gezien ' + KORTDAG + ' ' + T + '$'),
  new RegExp('^- en \\d{1,3} andere \\(zie de botsingenpagina\'s\\)$')
];
function tekstfilter(tekst, grammatica) {
  const r = String(tekst).split('\n');
  for (let i = 0; i < r.length; i++) {
    if (r[i] === '' && i === r.length - 1) continue;
    if (!grammatica.some((g) => g.test(r[i]))) { const e = new Error('tekstfilter: regel ' + (i + 1) + ' past niet'); e.tekstfilter = true; throw e; }
  }
  return tekst;
}

// ── tijd ───────────────────────────────────────────────────────────────────────────────────────────────────────
function delen(ms) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return p;
}
function isoLokaal(ms) {   // 2026-11-16T03:36:12+01:00
  const p = delen(ms);
  const lokaal = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const off = Math.round((lokaal - Math.floor(ms / 1000) * 1000) / 60000), a = Math.abs(off);
  return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute + ':' + p.second + (off < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
}
function datumVan(ms) { const p = delen(ms); return p.year + '-' + p.month + '-' + p.day; }
function kortDag(datum) { const d = new Date(datum + 'T12:00:00Z'); return DAG_KORT[d.getUTCDay()] + ' ' + d.getUTCDate() + '-' + (d.getUTCMonth() + 1); }
function plusDagen(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function maandagVan(week) {
  const m = WEEK_RE.exec(week); if (!m) return null;
  const j4 = Date.UTC(+m[1], 0, 4), wd = (new Date(j4).getUTCDay() + 6) % 7;
  return new Date(j4 - wd * 86400000 + (+m[2] - 1) * 7 * 86400000).toISOString().slice(0, 10);
}

// ── uitkomst → vaste woorden ───────────────────────────────────────────────────────────────────────────────────
function uitkomstTekst(b) {
  if (b.uitkomst === 'a') return 'a patiënt geboekt';
  if (b.uitkomst === 'b') return 'b spreekuur open ' + b.tijden.map((x) => x.van + '–' + x.tot).join(', ');
  if (b.uitkomst === 'c') return 'c controleer';
  if (b.uitkomst === 'd') return 'd afgedekt';
  if (b.uitkomst === 'geen') return 'buiten Promedico-tijd';
  const r = String(b.reden || '');
  if (/^niet gezien/.test(r)) return 'niet beoordeelbaar: niet gezien';
  if (/^niet recent gezien/.test(r)) return 'niet beoordeelbaar: oud';
  return 'niet beoordeelbaar: open uren niet te bepalen';
}
// Alleen deze velden van een botsing gaan verder (geen reden, geen titel, geen omschrijving).
function kaal(b, datum) {
  const ev = Number(b.google_id);
  return { datum, agenda: b.agenda, event: Number.isSafeInteger(ev) && ev >= 0 ? ev : '?', van: b.van, tot: b.tot, uitkomst: b.uitkomst, zekerheid: b.zekerheid || null,
    regel: b.regel, tijden: (b.tijden || []).map((x) => ({ van: x.van, tot: x.tot })), tekst: uitkomstTekst(b) };
}
function dagStatus(d, spiegelOk) {
  const s = [];
  if (!d) return 'niet gezien';
  if (!d.gezien) s.push('niet gezien'); else s.push('gezien ' + isoLokaal(d.gezien_ms) + ' (' + d.weergave + ')');
  if (d.gezien && d.oud) s.push('oud');
  if (d.gezien && !d.oud && !d.open_bepaalbaar) s.push('open uren niet te bepalen');
  if (!spiegelOk) s.push('spiegel niet van vannacht');
  return s.join(' · ');
}

function maakPagina(week, o) {
  const r = ['---', 'soort: promedico-botsingen', 'week: ' + week, 'berekend_op: ' + o.berekend_op, 'spiegel_op: ' + (o.spiegel_op || 'niet van vannacht'),
    'module: ' + B.VERSIE, 'venster: ' + o.van + ' t/m ' + o.tot, '---', '# ' + KOP + ' ' + week + ' - botsingen', '',
    'Naslag, elke nacht door de pod berekend (stap promedico-botsingen). Alleen labels, tijden en zekerheid; geen tekst uit Promedico of uit de agenda.',
    'Zekere botsingen (a, b) staan in het ochtendbericht. Wat hier niet staat, is niet beoordeeld; nooit "vrij".',
    'Uitkomst: a patiënt geboekt · b spreekuur open · c controleer · d afgedekt · buiten Promedico-tijd · niet beoordeelbaar.'];
  const ma = maandagVan(week);
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const datum = plusDagen(ma, i);
    if (datum < o.van || datum > o.tot) continue;
    n++;
    const d = o.dagen[datum];
    r.push('', '## ' + kortDag(datum) + ' ' + datum, '- status: ' + dagStatus(d.dag, o.spiegelOk));
    if (!o.spiegelOk) { r.push('- botsingen: geen (spiegel niet van vannacht)'); continue; }
    if (!d.bots.length) { r.push('- geen afspraken van Jij of Gezin met een tijd'); continue; }
    for (const b of d.bots) r.push('- ' + AGENDA_PAGINA[b.agenda] + ' · event ' + b.event + ' · ' + b.van + '–' + b.tot + ' · ' + b.tekst + ' · ' + (b.zekerheid || '—') + ' · regel ' + b.regel);
  }
  if (!n) r.push('', '- geen dagen van deze week in het venster');
  return r.join('\n') + '\n';
}
function meldRegel(b, gezienMs) {
  const p = delen(gezienMs);
  const wat = b.uitkomst === 'a' ? 'er staat een patiënt geboekt' : 'Promedico-spreekuur staat open ' + b.tijden.map((x) => x.van + '–' + x.tot).join(', ');
  return '- ' + kortDag(b.datum) + ' ' + b.van + '–' + b.tot + ' (' + AGENDA_REGEL[b.agenda] + '): ' + wat + ' — Promedico gezien ' + kortDag(datumVan(gezienMs)) + ' ' + p.hour + ':' + p.minute;
}
function sleutel(b, gezienMs) { return [b.datum, b.event, b.uitkomst, b.van + '-' + b.tot, b.tijden.map((x) => x.van + '-' + x.tot).join(','), gezienMs].join('|'); }

/**
 * o = { vault, map?, leesStaat() → tekst|null, registerPad, tijdlijn(van, tot) → Promise<rijen>, spiegelStempel(datum) → stempel|null,
 *       bufferZet(datum, tekst) → Promise, vv: { lees(pad), schrijf(pad, inhoud), wegAlsGelijk(pad, sha) }, lijst(mapAbs) → namen,
 *       log?(obj), nu?(), woorden? }
 */
function maak(o) {
  const nuF = o.nu || Date.now;
  const map = o.map || path.join('10_Zakelijk', 'Tolgaarde', KOP);
  let laatst = null;

  function registerLees() {
    let t;
    try { t = fs.readFileSync(o.registerPad, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { versie: 1, gemeld: {} }; throw new Error('register onleesbaar'); }
    let r; try { r = JSON.parse(t); } catch (e) { throw new Error('register onleesbaar'); }
    if (!r || r.versie !== 1 || !r.gemeld || typeof r.gemeld !== 'object') throw new Error('register onleesbaar');
    return r;
  }
  function registerZet(r) {
    const dir = path.dirname(o.registerPad);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = o.registerPad + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(r)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, o.registerPad);
  }
  function schrijfPagina(week, inhoud) {
    const mapAbs = path.join(o.vault, map);
    try { fs.mkdirSync(mapAbs, { mode: 0o775 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const p = path.join(mapAbs, botsingenNaam(week));
    let oud = null;
    try { oud = o.vv.lees(p); } catch (e) { oud = null; }
    if (oud === inhoud) return false;
    o.vv.schrijf(p, inhoud);
    return true;
  }
  function opruimen(vandaag) {
    const mapAbs = path.join(o.vault, map);
    let namen = [];
    try { namen = o.lijst(mapAbs); } catch (e) { return 0; }
    const grens = plusDagen(vandaag, -PAGINA_BEWAAR_DAGEN);
    let weg = 0;
    for (const n of namen) {
      const m = BOTS_NAAM_RE.exec(n);
      if (!m) continue;
      const ma = maandagVan(m[1] + '-W' + m[2]);
      if (!ma || plusDagen(ma, 6) >= grens) continue;
      const p = path.join(mapAbs, botsingenNaam(m[1] + '-W' + m[2]));
      try { const t = o.vv.lees(p); if (o.vv.wegAlsGelijk(p, crypto.createHash('sha256').update(t, 'utf8').digest('hex'))) weg++; } catch (e) { /* volgende nacht opnieuw */ }
    }
    return weg;
  }

  async function doe(opt) {
    opt = opt || {};
    const t0 = nuF();
    const a = opt.ams;
    if (!a || !/^\d{4}-\d{2}-\d{2}$/.test(a.datum || '')) return { ok: false, reden: 'geen datum' };
    const vandaag = a.datum, tot = plusDagen(vandaag, DAGEN - 1);
    const st = o.spiegelStempel(vandaag);
    const spiegelOk = !!(st && st.stand === 'klaar' && !(st.detail && st.detail.niet_in_release) && st.eind && datumVan(Date.parse(st.eind)) === vandaag);
    let staat;
    try {
      const t = o.leesStaat();
      staat = t == null ? { versie: 2, datums: {} } : JSON.parse(t);
      if (!staat || staat.versie !== 2 || !staat.datums || typeof staat.datums !== 'object') throw new Error('vorm');
    } catch (e) { return fout('staat onleesbaar'); }
    let gpd = {};
    if (spiegelOk) {
      let rijen;
      try { rijen = await o.tijdlijn(vandaag, tot); } catch (e) { return fout('tijdlijn onleesbaar'); }
      if (!Array.isArray(rijen)) return fout('tijdlijn onleesbaar');
      if (rijen.length >= 1000) return fout('tijdlijn te vol');
      gpd = B.googlePerDag(rijen);
    }
    const dagen = {}, per = { a: 0, b: 0, c: 0, d: 0, geen: 0, nb: 0 };
    const alle = [];
    for (let d = vandaag; d <= tot; d = plusDagen(d, 1)) {
      const x = Object.prototype.hasOwnProperty.call(staat.datums, d) ? staat.datums[d] : null;
      const dag = B.betekenDag(x, gpd[d] || [], { datum: d, vandaag, nuMs: t0, woorden: o.woorden });
      const bots = spiegelOk ? dag.botsingen.filter((b) => AGENDA_PAGINA[b.agenda]).map((b) => kaal(b, d)) : [];
      bots.sort((p, q) => p.van.localeCompare(q.van) || p.tot.localeCompare(q.tot) || String(p.event).localeCompare(String(q.event)));
      bots.forEach((b) => { per[b.uitkomst] = (per[b.uitkomst] || 0) + 1; alle.push(Object.assign({ gezien_ms: dag.gezien_ms, oud: !!dag.oud }, b)); });
      dagen[d] = { dag, bots };
    }
    const weken = [];
    for (let i = 0; i < WEKEN; i++) weken.push(B.isoWeek(plusDagen(vandaag, 7 * i)));
    const kop = { berekend_op: isoLokaal(t0), spiegel_op: spiegelOk ? isoLokaal(Date.parse(st.eind)) : null, spiegelOk, van: vandaag, tot, dagen };
    const paginas = {};
    try { for (const w of weken) paginas[w] = tekstfilter(maakPagina(w, kop), GRAMMATICA); }
    catch (e) { return fout(e.tekstfilter ? 'tekstfilter' : 'pagina niet te bouwen'); }

    // melding: alleen a/b zeker, blik niet oud (betekenDag geeft bij oud al nb), spiegel van vannacht
    let reg;
    try { reg = registerLees(); } catch (e) { return fout('register onleesbaar'); }
    const zeker = spiegelOk ? alle.filter((b) => (b.uitkomst === 'a' || b.uitkomst === 'b') && b.zekerheid === 'zeker' && !b.oud && Number.isFinite(b.gezien_ms)) : [];
    const nieuw = zeker.filter((b) => !Object.prototype.hasOwnProperty.call(reg.gemeld, sleutel(b, b.gezien_ms)));
    const toon = nieuw.slice(0, MAX_REGELS);
    let tekst = null;
    if (toon.length) {
      const r = [MELD_KOP].concat(toon.map((b) => meldRegel(b, b.gezien_ms)));
      if (nieuw.length > toon.length) r.push('- en ' + (nieuw.length - toon.length) + ' andere (zie de botsingenpagina\'s)');
      tekst = r.join('\n');
      try { tekstfilter(tekst, MELD_GRAMMATICA); } catch (e) { return fout('tekstfilter'); }
    }

    // eerst de pagina's (naslag), dan de bufferrij, dan pas het register
    let geschreven = 0;
    try { for (const w of weken) if (schrijfPagina(w, paginas[w])) geschreven++; } catch (e) { return fout('pagina niet geschreven'); }
    let gemeld = 0, telaat = false;
    if (tekst) {
      const laat = () => a.uur * 60 + a.min + 1 + (nuF() - t0) / 60000 > 7 * 60;
      if (laat()) telaat = true;
      else {
        try { await o.bufferZet(vandaag, tekst); } catch (e) { return fout('buffer niet gezet'); }
        if (laat()) telaat = true;
        else {
          for (const b of toon) reg.gemeld[sleutel(b, b.gezien_ms)] = b.datum;
          gemeld = toon.length;
        }
      }
    }
    for (const k of Object.keys(reg.gemeld)) if (plusDagen(String(reg.gemeld[k]), REGISTER_NA_DAGEN) < vandaag) delete reg.gemeld[k];
    const ms = nuF() - t0;
    reg.laatst = { op: new Date(t0).toISOString(), datum: vandaag, spiegel: spiegelOk, weken: weken.length, dagen: DAGEN,
      gezien: Object.keys(dagen).filter((d) => dagen[d].dag.gezien).length, per_uitkomst: per, zeker: zeker.length, nieuw: nieuw.length, gemeld, ms };
    try { registerZet(reg); } catch (e) { return fout('register niet geschreven'); }
    const weg = opruimen(vandaag);
    laatst = Object.assign({}, reg.laatst, { geschreven, opgeruimd: weg, te_laat: telaat || undefined });
    if (o.log) o.log({ opdracht: 'promedico-botsingen', ok: true, spiegel: spiegelOk ? 1 : 0, weken: weken.length, geschreven, a: per.a, b: per.b, c: per.c, d: per.d, nb: per.nb, gemeld, ms });
    return { ok: true, detail: { spiegel: spiegelOk, weken: weken.length, geschreven, per_uitkomst: per, gemeld, te_laat: telaat || undefined, opgeruimd: weg } };

    function fout(reden) {
      laatst = { op: new Date(t0).toISOString(), datum: vandaag, fout: reden };
      if (o.log) o.log({ opdracht: 'promedico-botsingen', ok: false, fout: reden });
      return { ok: false, reden };
    }
  }
  function info() {
    if (laatst) return Object.assign({ aan: true }, laatst);
    try { const r = registerLees(); return Object.assign({ aan: true }, r.laatst || {}); } catch (e) { return { aan: true, fout: 'register onleesbaar' }; }
  }
  return { doe, info };
}

module.exports = { maak, botsingenNaam, tekstfilter, maakPagina, meldRegel, sleutel, kaal, isoLokaal, kortDag, maandagVan, GRAMMATICA, MELD_GRAMMATICA, BOTS_NAAM_RE, BRON, KOP };
