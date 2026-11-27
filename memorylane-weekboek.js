'use strict';
/*
 * memorylane-weekboek.js — het Weekboek van MemoryLane (wv4131, besluitenpagina nr 190 = 2C90, David Ja 25-11-2026 22:03).
 * Ontwerp: mk-scripts/wv4131/ontwerp.md (Codex-ontwerpreview).
 *
 * WAT. Elke zondag (nachtketenstap ml-weekboek, vóór de ochtendeditie van 06:50) één korte aflevering: tot vijf herinneringen "deze week
 * door de jaren" plus de week zelf (afspraken in de agenda's david en gezin, reizen uit Tripper, foto's van deze week uit Immich), met aan
 * het eind één vraag. De tekst schrijft één Sonnet-aanroep (abonnement, geen tools). Geen stemaanroep bij het maken: de app leest hem pas
 * voor als David op Luister tikt (bestaande Voorlezen-route). Na een geslaagde aflevering één regel in het zondagse ochtendbericht via het
 * loket (app memorylane, onderwerp weekboek; Open-knop naar MemoryLane). Geen Voor jou-kaart (less is more).
 * WAAROM. Het archief stond sinds 2-11 stil (0 opnames, 0 nieuwe herinneringen) en MemoryLane werd na 17-11 niet meer geopend: de app
 * kwam nooit naar David toe en vroeg hem niets. Inspreken wordt zo antwoorden op één vraag.
 * TE WEINIG STOF. Minder dan twee dingen in de week zelf (afspraken + reizen + fotodagen met ≥ 5 foto's) = geen aflevering, geen lege.
 * ANTWOORD. De app koppelt de opname-id van het antwoord (POST /app/ml/weekboek/antwoord). Zodra die opname een herinnering is, zet
 * koppel() de wanneer op maandag–zondag van die week en de titel "Weekboek week N, JJJJ" via de vaste naamgeving (Davids eigen titel wint).
 * PRIVACY. Inhoud (titels, tekst, vraag) alleen in het weekbestand (600) en naar de app van David; log, box en info alleen aantallen.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WEEK_RE = /^\d{4}-W\d{2}$/;
const RID_RE = /^r[0-9]{8}-[0-9a-f]{16}$/;
const DAG_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HERINNERINGEN = 5;
const MIN_WEEK = 2;                 // minder dingen in de week zelf = geen aflevering
const FOTO_DAG_MIN = 5;             // een dag met zo veel foto's telt als één ding
const TONEN_DAGEN = 14;             // de app toont de nieuwste aflevering zo lang
const ANTWOORD_DAGEN = 21;          // zo lang kan een antwoord nog gekoppeld worden
const POGINGEN = 2;                 // schrijfpogingen per week
const AGENDAS = ['david', 'gezin'];
const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const DAGNAMEN = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];

function utc(d) { return Date.parse(d + 'T12:00:00Z'); }
function plusDag(d, n) { return new Date(utc(d) + n * 86400000).toISOString().slice(0, 10); }
// ISO-week van een dag → { id: 'JJJJ-Www', nr, jaar, van: maandag, tot: zondag }
function weekVan(dag) {
  if (!DAG_RE.test(String(dag))) throw new Error('ongeldige dag');
  const g = new Date(utc(dag)).getUTCDay() || 7;
  const van = plusDag(dag, 1 - g), tot = plusDag(van, 6), don = plusDag(van, 3);
  const jaar = Number(don.slice(0, 4));
  const nr = Math.floor((utc(don) - utc(jaar + '-01-01')) / (7 * 86400000)) + 1;
  return { id: jaar + '-W' + String(nr).padStart(2, '0'), nr, jaar, van, tot };
}
function dagVanJaar(m, d) { return Math.round((Date.UTC(2001, m - 1, d) - Date.UTC(2001, 0, 1)) / 86400000); }   // 0..364 (geen schrikkeldag)
function dvj(s) { return dagVanJaar(Number(s.slice(5, 7)), Math.min(Number(s.slice(8, 10)), Number(s.slice(5, 7)) === 2 ? 28 : 31)); }
// de periode (van/tot, JJJJ-MM-DD) van een herinnering voor "deze week door de jaren": een exacte dag op de pagina, anders de dagen van de
// foto's als die bij het jaar (en de maand, als die er staat) op de pagina passen en hooguit 31 dagen beslaan. Zelfde regel als de app (kalender.ts).
function periodeVan(h) {
  const m = /^1\|(\d{4}-\d{2}-\d{2})\|(\d{4}-\d{2}-\d{2})$/.exec(String(h && h.datum || ''));
  if (m && h.precisie === 'dag') return { van: m[1], tot: m[2] };
  const f = h && h.fotodagen;
  if (!f || !DAG_RE.test(String(f.van)) || !DAG_RE.test(String(f.tot)) || f.tot < f.van) return null;
  if ((utc(f.tot) - utc(f.van)) / 86400000 > 31) return null;
  if (!m) return null;   // zonder datum op de pagina geen fotodagen gebruiken (we weten niet of het album klopt)
  if (f.van.slice(0, 4) !== m[1].slice(0, 4)) return null;
  if (h.precisie === 'maand' && f.van.slice(0, 7) !== m[1].slice(0, 7) && f.tot.slice(0, 7) !== m[1].slice(0, 7)) return null;
  return { van: f.van, tot: f.tot };
}
// raakt de periode (in een eerder jaar) een dag van de week? (dag-van-jaar, ook over de jaargrens)
function raaktWeek(p, week, dagen) {
  if (!p || Number(p.van.slice(0, 4)) >= week.jaar) return false;   // alleen eerdere jaren
  const jr = Math.min(1, Math.max(0, Number(p.tot.slice(0, 4)) - Number(p.van.slice(0, 4))));
  const a = dvj(p.van), b = dvj(p.tot) + 365 * jr;
  for (let i = 0; i < (dagen || 7); i++) {
    const d = dvj(plusDag(week.van, i));
    if ((d >= a && d <= b) || (d + 365 >= a && d + 365 <= b)) return true;
  }
  return false;
}
function hashGetal(s) { return parseInt(crypto.createHash('sha256').update(s).digest('hex').slice(0, 8), 16); }
function metVerhaal(h) { return h.soort === 'opname' || !!h.stem || (Number(h.audio) || 0) > 0; }
function fotosVan(h) { return h && h.album && Number(h.album.aantal) > 0 ? Number(h.album.aantal) : 0; }
// tot vijf herinneringen uit eerdere jaren in deze week: met verhaal of stem eerst, dan de meeste foto's, dan een vaste volgorde per week
// Minder dan drie in de week zelf: aanvullen uit de komende week (de aflevering komt op zondag; "komende week" staat er dan bij).
function kies(lijst, week, max) {
  const n = max || MAX_HERINNERINGEN, deze = [], komend = [];
  for (const h of Array.isArray(lijst) ? lijst : []) {
    if (!h || !h.hid || h.status === 'weg' || h.status === 'afgewezen' || h.status === 'samengevoegd') continue;
    const p = periodeVan(h);
    if (!p || Number(p.van.slice(0, 4)) >= week.jaar) continue;
    const x = { h, p, s: [metVerhaal(h) ? 0 : 1, -fotosVan(h), hashGetal(week.id + h.hid)] };
    if (raaktWeek(p, week)) deze.push(x);
    else if (raaktWeek(p, { jaar: week.jaar, van: week.van }, 14)) komend.push(Object.assign(x, { komend: true }));
  }
  const op = (a, b) => a.s[0] - b.s[0] || a.s[1] - b.s[1] || a.s[2] - b.s[2];
  deze.sort(op); komend.sort(op);
  const uit = deze.slice(0, n);
  if (uit.length < 3) uit.push(...komend.slice(0, Math.min(n, 3) - uit.length));
  return uit.map((x) => ({ h: x.h, p: x.p, komend: !!x.komend }));
}
function dagTekst(d) { const t = new Date(utc(d)); return DAGNAMEN[t.getUTCDay()] + ' ' + t.getUTCDate() + ' ' + MAANDEN[t.getUTCMonth()]; }
function eenRegel(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200); }
// de week zelf: afspraken (david, gezin; niet geannuleerd), reizen die de week raken, dagen met foto's
function weekStof(week, rijen, reizen, fotos) {
  const afspraken = [];
  const gezien = new Set();
  for (const x0 of Array.isArray(rijen) ? rijen : []) {
    const x = x0 && x0.sb_kalender_tijdlijn ? x0.sb_kalender_tijdlijn : x0;
    if (!x || x.soort !== 'afspraak' || !AGENDAS.includes(x.sync_agenda) || x.status === 'geannuleerd' || x.status === 'cancelled') continue;
    const dag = String(x.begin_datum || x.begin_tijd || '').slice(0, 10);
    if (!DAG_RE.test(dag) || dag < week.van || dag > week.tot) continue;
    // codes en nummers (reservering #1234, kentekens) horen niet in een luisterstuk
    const titel = eenRegel(String(x.titel || '').replace(/#\s*\w+/g, '').replace(/\b\d{5,}\b/g, ''), 120).replace(/\s+([,.;:])/g, '$1').replace(/[\s–-]+$/, '');
    if (!titel || gezien.has(dag + titel)) continue;
    gezien.add(dag + titel);
    afspraken.push({ dag, titel, agenda: x.sync_agenda });
  }
  afspraken.sort((a, b) => (a.dag < b.dag ? -1 : a.dag > b.dag ? 1 : 0));
  const rs = (Array.isArray(reizen) ? reizen : []).filter((r) => r && DAG_RE.test(String(r.van)) && String(r.van) <= week.tot && String(r.tot || r.van) >= week.van)
    .map((r) => ({ titel: eenRegel(r.titel, 120), van: r.van, tot: r.tot || r.van }));
  const fd = Object.keys(fotos || {}).filter((d) => d >= week.van && d <= week.tot).sort().map((d) => ({ dag: d, n: Number(fotos[d]) || 0 })).filter((x) => x.n > 0);
  const telt = afspraken.length + rs.length + fd.filter((x) => x.n >= FOTO_DAG_MIN).length;
  return { afspraken, reizen: rs, fotodagen: fd, telt };
}
const SYSTEEM = 'Je schrijft voor David (huisarts, vader, Nederlands) één korte aflevering van zijn Weekboek: een luisterstuk dat zijn ' +
  'voorleesstem straks voorleest. Schrijf warm, rustig en concreet, in de tweede persoon ("je"), in gewone spreektaal; geen opsommingstekens, ' +
  'geen kopjes, geen markdown, geen emoji, geen nummers of codes. Gebruik ALLEEN feiten uit de invoer: verzin geen namen, plaatsen, gevoelens ' +
  'of gebeurtenissen. Zeg nooit wat je niet weet of wat er ontbreekt; laat het dan gewoon weg. ' +
  'Opbouw: één zin opening; dan de herinneringen uit eerdere jaren (per herinnering één à twee zinnen, met het jaar of hoe lang geleden; ' +
  'een herinnering met [komende week] hoort bij de week die nu begint); dan deze week zelf in een paar zinnen, met het persoonlijke voorop ' +
  '(gezin, mensen, uitjes, een reis, foto\'s) en praktische zaken (onderhoud, reserveringen, vaste trainingen) hooguit kort; en tot slot ' +
  'precies één vraag over deze week die David in een minuut kan beantwoorden: over het meest persoonlijke moment van de week, concreet ' +
  '(noem dat moment), open (geen ja/nee) en nooit over iets administratiefs. De tekst eindigt met die vraag, letterlijk. ' +
  'Lengte 200 tot 450 woorden. Geef ook een korte titel (hooguit 8 woorden) en de vraag apart.';
const SCHEMA = { type: 'object', additionalProperties: false, required: ['titel', 'tekst', 'vraag'],
  properties: { titel: { type: 'string' }, tekst: { type: 'string' }, vraag: { type: 'string' } } };
function prompt(week, items, stof) {
  const r = ['Week ' + week.nr + ' van ' + week.jaar + ' (' + dagTekst(week.van) + ' tot en met ' + dagTekst(week.tot) + ').', ''];
  r.push('HERINNERINGEN UIT EERDERE JAREN IN DEZE WEEK (' + items.length + '; met [komende week] = in de week die nu begint):');
  if (!items.length) r.push('(geen)');
  items.forEach((x, i) => {
    const h = x.h;
    r.push((i + 1) + '. ' + (x.komend ? '[komende week] ' : '') + eenRegel(h.titel, 120) + ' — ' + (eenRegel(h.wanneer, 60) ? eenRegel(h.wanneer, 60) + ', ' : '') + 'jaar ' + x.p.van.slice(0, 4) + ' (' + (week.jaar - Number(x.p.van.slice(0, 4))) + ' jaar geleden)' +
      (h.personen && h.personen.length ? '; met: ' + h.personen.slice(0, 6).map((p) => eenRegel(p, 40)).join(', ') : '') +
      (h.plaatsen && h.plaatsen.length ? '; plaats: ' + h.plaatsen.slice(0, 3).map((p) => eenRegel(p, 40)).join(', ') : '') +
      (fotosVan(h) ? '; ' + fotosVan(h) + " foto's" : ''));
    if (x.verhaal) r.push('   Uit het verhaal: ' + eenRegel(x.verhaal, 600));
  });
  r.push('', 'DEZE WEEK ZELF:');
  if (stof.afspraken.length) stof.afspraken.forEach((a) => r.push('- ' + dagTekst(a.dag) + ': ' + a.titel + (a.agenda === 'gezin' ? ' (gezinsagenda)' : '')));
  stof.reizen.forEach((x) => r.push('- Reis: ' + x.titel + ' (' + dagTekst(x.van) + ' tot ' + dagTekst(x.tot) + ')'));
  stof.fotodagen.forEach((x) => r.push('- ' + dagTekst(x.dag) + ': ' + x.n + " foto's gemaakt"));
  return r.join('\n');
}
// review MOET 2 (Codex, ontwerp): elk jaartal, elke "<dag> <maand>" en elk "<n> jaar geleden" in de tekst moet uit de invoer komen;
// anders telt het antwoord als ongeldig (nieuwe poging). Woorden als "twaalf jaar" vangt dit niet: de prompt geeft de getallen al.
const MAAND_RE = new RegExp('\\b(\\d{1,2}) (' + MAANDEN.join('|') + ')\\b', 'gi');
function datumsKloppen(tekst, invoer) {
  const t = String(tekst), i = String(invoer).toLowerCase();
  for (const m of t.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)) if (!i.includes(m[1])) return false;
  for (const m of t.matchAll(MAAND_RE)) if (!i.includes(Number(m[1]) + ' ' + m[2].toLowerCase())) return false;
  for (const m of t.matchAll(/\b(\d{1,3}) jaar geleden\b/gi)) if (!i.includes('(' + Number(m[1]) + ' jaar geleden)')) return false;
  return true;
}
function geldig(d, invoer) {
  if (!d || typeof d !== 'object') return null;
  const tekst = String(d.tekst || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const vraag = eenRegel(d.vraag, 300), titel = eenRegel(d.titel, 90);
  if (tekst.length < 600 || tekst.length > 6000) return null;
  if (vraag.length < 10 || vraag.length > 240 || !/\?$/.test(vraag)) return null;
  if (!titel) return null;
  if (invoer != null && !(datumsKloppen(tekst, invoer) && datumsKloppen(vraag, invoer) && datumsKloppen(titel, invoer))) return null;
  return { titel, tekst, vraag };
}

function maak(o) {
  const dir = o.dir;
  const nu = o.nu || Date.now;
  const log = o.log || function () {};
  function pad(id) { if (!WEEK_RE.test(id)) throw new Error('ongeldige week'); return path.join(dir, id + '.json'); }
  function lees(id) { try { return JSON.parse(fs.readFileSync(pad(id), 'utf8')); } catch (e) { return null; } }
  function schrijf(w) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, '.' + w.week + '.' + process.pid + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(w), { mode: 0o600 });
    fs.renameSync(tmp, pad(w.week));
  }
  function alle() {
    let l = [];
    try { l = fs.readdirSync(dir).filter((f) => /^\d{4}-W\d{2}\.json$/.test(f)).sort().reverse(); } catch (e) { return []; }
    return l.map((f) => lees(f.slice(0, -5))).filter(Boolean);
  }
  function dagAms(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }

  // ── nachtketenstap: alleen op zondag; maakt de aflevering van de week die vandaag eindigt ──
  async function stap(ctx) {
    const dag = ctx && ctx.datum ? ctx.datum : dagAms(nu());
    if (new Date(utc(dag)).getUTCDay() !== 0 && !(ctx && ctx.forceer)) return { ok: true, al_gedaan: true, detail: { geen_zondag: true } };
    const week = weekVan(dag);
    const oud = lees(week.id);
    if (oud && (oud.status === 'klaar' || oud.status === 'overgeslagen')) return { ok: true, al_gedaan: true, detail: { status: oud.status } };
    if (oud && oud.status === 'mislukt' && (oud.pogingen || 0) >= POGINGEN) return { ok: true, al_gedaan: true, detail: { status: 'mislukt' } };
    const pogingen = (oud && oud.pogingen) || 0;
    // stof verzamelen; een bron die niet te lezen is telt als leeg (nooit een verzonnen getal), en staat in detail.fout
    const fout = [];
    let lijst = [], rijen = [], reizen = [], fotos = {};
    try { lijst = await o.lijst(); } catch (e) { fout.push('lijst'); }
    try { rijen = await o.agenda(week.van, week.tot); } catch (e) { fout.push('agenda'); }
    try { reizen = await o.reizen(); } catch (e) { fout.push('reizen'); }
    try { fotos = (await o.fotos(week.van, week.tot)) || {}; } catch (e) { fout.push('fotos'); }
    if (fout.includes('lijst')) {   // zonder de herinneringen geen aflevering; volgende tik opnieuw (de keten herhaalt de stap)
      log({ week: week.id, fout: fout.join(',') });
      return { ok: false, reden: 'MemoryLane-lijst niet te lezen' };
    }
    const items = kies(lijst, week);
    const stof = weekStof(week, rijen, reizen, fotos);
    const aantallen = { herinneringen: items.length, afspraken: stof.afspraken.length, reizen: stof.reizen.length, fotodagen: stof.fotodagen.length, fotos: stof.fotodagen.reduce((n, x) => n + x.n, 0) };
    if (stof.telt < MIN_WEEK) {
      schrijf({ week: week.id, van: week.van, tot: week.tot, status: 'overgeslagen', reden: 'te weinig stof in de week zelf', stof: aantallen, fout, gemaakt: new Date(nu()).toISOString() });
      log({ week: week.id, status: 'overgeslagen', telt: stof.telt });
      return { ok: true, detail: { status: 'overgeslagen', telt: stof.telt, fout: fout.length ? fout : undefined } };
    }
    for (const x of items) {
      if (!metVerhaal(x.h) || typeof o.verhaal !== 'function') continue;
      try { x.verhaal = await o.verhaal(x.h.hid); } catch (e) { x.verhaal = null; }
    }
    const invoer = prompt(week, items, stof);
    let r = null, g = null, n = pogingen;
    while (!g && n < POGINGEN) {   // twee pogingen binnen de stap (de ochtendeditie wacht niet)
      n++;
      r = await o.claude(SYSTEEM, invoer, SCHEMA, { model: o.model || 'claude-sonnet-5-5', effort: 'low', timeoutMs: 240000 });
      g = r && r.ok ? geldig(r.data, invoer) : null;
    }
    if (!g) {
      const w = { week: week.id, van: week.van, tot: week.tot, status: 'mislukt', pogingen: n, reden: r && !r.ok ? eenRegel(r.fout, 120) : 'antwoord voldeed niet', stof: aantallen, gemaakt: new Date(nu()).toISOString() };
      schrijf(w);
      log({ week: week.id, status: 'mislukt', poging: w.pogingen });
      if (w.pogingen >= POGINGEN && typeof o.box === 'function') o.box('\n## [weekboek] ' + dag + ' — MemoryLane Weekboek ' + week.id + ' niet gemaakt (automatisch, wv4131)\n- status: open\n- van: pod (ml-weekboek)\n- gemeten: ' + w.pogingen + ' pogingen; laatste reden: ' + w.reden + '\n- gevolg als er niets gebeurt: deze week geen aflevering; volgende zondag opnieuw.\n');
      return { ok: w.pogingen >= POGINGEN, reden: 'tekst niet gemaakt (' + w.reden + ')', detail: { status: 'mislukt', pogingen: w.pogingen } };
    }
    const w = { week: week.id, nr: week.nr, jaar: week.jaar, van: week.van, tot: week.tot, status: 'klaar', gemaakt: new Date(nu()).toISOString(),
      hids: items.map((x) => x.h.hid), titel: g.titel, tekst: g.tekst, vraag: g.vraag, stof: aantallen, fout: fout.length ? fout : undefined,
      verbruik: r.verbruik ? { in: r.verbruik.in, uit: r.verbruik.uit, kosten: r.verbruik.kosten, account: r.verbruik.account } : null, antwoord: null };
    schrijf(w);
    log({ week: week.id, status: 'klaar', herinneringen: items.length, telt: stof.telt, tekens: g.tekst.length });
    // één regel in het ochtendbericht (loket); een fout daar laat de aflevering staan (de app toont hem toch)
    let loket = false;
    if (typeof o.loket === 'function') {
      try {
        await o.loket({ app: 'memorylane', onderwerp: 'weekboek', laan: 'editie', editie: 'ochtend', datum: dag,
          tekst: 'Je Weekboek van deze week staat klaar' + (items.length ? ' (' + (items.length === 1 ? 'één herinnering' : items.length + ' herinneringen') + ' uit eerdere jaren)' : '') + '. De vraag: ' + g.vraag,
          link: 'https://app.socev.dev/?app=memorylane&mlplek=weekboek', doel: { scherm: 'memorylane', focus: 'weekboek' } });
        loket = true;
      } catch (e) { log({ week: week.id, loket: 'fout' }); }
    }
    return { ok: true, detail: { status: 'klaar', herinneringen: items.length, telt: stof.telt, loket } };
  }

  // ── app: de nieuwste aflevering van de laatste 14 dagen ──
  function laatste() {
    const grens = dagAms(nu() - TONEN_DAGEN * 86400000);
    const w = alle().find((x) => x.status === 'klaar' && x.tot >= grens);
    if (!w) return { status: 200, body: { ok: true, weekboek: null } };
    return { status: 200, body: { ok: true, weekboek: { week: w.week, nr: w.nr, jaar: w.jaar, van: w.van, tot: w.tot, titel: w.titel, tekst: w.tekst, vraag: w.vraag,
      hids: w.hids || [], gemaakt: w.gemaakt, antwoord: w.antwoord ? { op: w.antwoord.op, hid: w.antwoord.hid || null } : null } } };
  }
  // ── app: de opname-id van het antwoord aan de aflevering hangen ──
  function antwoord(d) {
    const week = String(d && d.week || ''), rid = String(d && d.ramble_id || '');
    if (!WEEK_RE.test(week) || !RID_RE.test(rid)) return { status: 400, body: { ok: false, fout: 'week en opname-id nodig' } };
    const w = lees(week);
    if (!w || w.status !== 'klaar') return { status: 404, body: { ok: false, fout: 'deze aflevering bestaat niet' } };
    if (w.tot < dagAms(nu() - ANTWOORD_DAGEN * 86400000)) return { status: 409, body: { ok: false, fout: 'deze aflevering is te oud om nog te beantwoorden' } };
    if (w.antwoord && w.antwoord.hid) return { status: 409, body: { ok: false, fout: 'het antwoord op deze vraag staat er al' } };
    w.antwoord = { ramble_id: rid, op: new Date(nu()).toISOString() };
    schrijf(w);
    log({ week: week, antwoord: 'gekoppeld' });
    return { status: 200, body: { ok: true, antwoord: { op: w.antwoord.op, hid: null } } };
  }
  // ── tik: zodra de opname een herinnering is, wanneer = die week en titel via de vaste naamgeving ──
  function koppel() {
    let n = 0;
    const grens = dagAms(nu() - (ANTWOORD_DAGEN + 7) * 86400000);
    for (const w of alle()) {
      if (w.status !== 'klaar' || !w.antwoord || !w.antwoord.ramble_id || w.antwoord.hid || w.tot < grens) continue;
      const hid = o.opnameHid(w.antwoord.ramble_id);
      if (!hid) continue;
      const u = o.wanneer(hid, { van: w.van, tot: w.tot });
      if (!u || u.status !== 200) continue;   // onderhoud of nachtgrendel: volgende tik opnieuw
      try { o.naamgeving(hid, 'Weekboek week ' + w.nr + ', ' + w.jaar); } catch (e) { /* titel is bijzaak */ }
      w.antwoord.hid = hid; w.antwoord.gekoppeld_op = new Date(nu()).toISOString();
      schrijf(w); n++;
      log({ week: w.week, antwoord: 'herinnering' });
    }
    return n;
  }
  function info() {
    const l = alle();
    const k = l.find((x) => x.status === 'klaar');
    return { afleveringen: l.filter((x) => x.status === 'klaar').length, overgeslagen: l.filter((x) => x.status === 'overgeslagen').length,
      mislukt: l.filter((x) => x.status === 'mislukt').length, laatste: k ? k.week : null, beantwoord: l.filter((x) => x.antwoord && x.antwoord.hid).length };
  }
  return { stap, laatste, antwoord, koppel, info };
}

module.exports = { maak, weekVan, kies, periodeVan, raaktWeek, weekStof, prompt, geldig, SYSTEEM, MIN_WEEK, FOTO_DAG_MIN };
