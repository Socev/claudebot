'use strict';
// wv3906 (24-11-2026, besluitenpagina nr 456 = 3C156, David Ja 22-11 18:15): het dagplan van Socev onder "Vandaag te doen" in de
// app, met per regel Weg (veeg) en Nu doen, en een veld "Zet erbij" voor een herinnering op een tijdstip.
// Ontwerp + Codex-review: mk-scripts/wv3906/ontwerp.md.
//
// Bron blijft heartbeat.md § "Dagplan vandaag (automatisch)": de Dagplanner (n8n, 06:15) schrijft hem, de heartbeat-tikken
// (07:05/08/12/15/18) voeren regels "- [ ] tik HH:MM - …" uit en vinken af. Bewust geen kopie in de databank (twee bronnen).
//   lees(tekst, vandaag)         → { datum, regels: [{ sleutel, tijd, tekst, open }] } ; ander plan dan vandaag = geen regels
//   veeg(tekst, sleutel, o)      → nieuwe tekst met "- [x] … — weggeveegd door David HH:MM (niet doen)", of { fout, status }
//   tikBezig(tijd, nuMin)        → true als een heartbeat-tik deze regel nu kan uitvoeren (veeg dan 409, Codex MOET 3)
//   tijdUit(zin, nuMs)           → { wanneer (ms), tekst } of null: Nederlandse tijd zonder taalmodel
//   maak({ staatPad, melden, … }) → klok + opslag van Davids eigen herinneringen (scripts-staat/dagplan-erbij/erbij.json)
// "Nu doen" schrijft niets in het plan (MOET 1): de app zet de vraag klaar in het gesprek (met plandatum en de volledige regel) en
// David verstuurt. Claim (ronde 2): de heartbeat zet een regel eerst op "- [~]" (bezig) en dan op "- [x]"; de pod veegt alleen een
// regel die nog letterlijk "- [ ]" is, en Socevs Edit vindt na een veeg zijn oude tekst niet meer (wie eerst schrijft wint). Het
// tikvenster hieronder is het vangnet als Socev de claim vergeet.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TZ = 'Europe/Amsterdam';
const MIN = 60 * 1000;
const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const TEKST_MAX = 160;
const ERBIJ_TEKST_MAX = 300;
const ERBIJ_OPEN_MAX = 30;
const ERBIJ_BEWAAR_MS = 7 * 24 * 60 * MIN;
const ERBIJ_TE_LAAT_MS = 2 * 60 * MIN;     // daarna "(te laat, gepland HH:MM)" erbij
const ERBIJ_BOX_MS = 30 * MIN;             // zo lang mislukt = één box-rij
const WAKKER_VAN = 7 * 60, WAKKER_TOT = 22 * 60 + 59;   // een uur zonder dagdeel valt hierin (minuten)
// Tikvensters van de heartbeat (minuten na middernacht): [begin, einde, tik-uren die die tik uitvoert]
const TIKKEN = [[7 * 60 + 5, 7 * 60 + 20, 7 * 60 + 5], [8 * 60, 8 * 60 + 20, 8 * 60], [12 * 60, 12 * 60 + 20, 12 * 60],
  [15 * 60, 15 * 60 + 20, 18 * 60], [18 * 60, 18 * 60 + 20, 18 * 60]];   // 15:00 doet de thuisdingen van 18:00 al (wv3686)

function ams(ms) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
  return { ymd: p.year + '-' + p.month + '-' + p.day, h: Number(p.hour), m: Number(p.minute) };
}
// Lokale Amsterdamse tijd → ms (twee rondes voor de zomertijdgrens)
function msVan(ymd, h, m) {
  const [y, mo, d] = ymd.split('-').map(Number);
  let g = Date.UTC(y, mo - 1, d, h, m);
  for (let i = 0; i < 2; i++) { const a = ams(g); const [ay, am, ad] = a.ymd.split('-').map(Number); g += (Date.UTC(y, mo - 1, d, h, m) - Date.UTC(ay, am - 1, ad, a.h, a.m)); }
  return g;
}
function ymdPlus(ymd, n) { const [y, mo, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10); }
function hhmm(h, m) { return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'); }
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// ── Lezen ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function sectie(tekst) {
  const r = String(tekst || '').split('\n');
  const b = r.findIndex(function (x) { return /^##\s.*Dagplan vandaag/i.test(x); });
  if (b < 0) return null;
  let e = r.length;
  for (let i = b + 1; i < r.length; i++) if (/^##\s/.test(r[i])) { e = i; break; }
  return { rijen: r, begin: b, einde: e };
}
function planDatum(rijen, b, e) {
  for (let i = b; i < e; i++) {
    const m = /^\*\*\s*\w+dag\s+(\d{1,2})\s+([a-z]+)\s+(\d{4})\.?\s*\*\*/i.exec(rijen[i].trim());
    if (m) { const mi = MAANDEN.indexOf(m[2].toLowerCase()); if (mi >= 0) return m[3] + '-' + String(mi + 1).padStart(2, '0') + '-' + String(Number(m[1])).padStart(2, '0'); }
  }
  return null;
}
const REGEL_RE = /^(\s*)- \[( |x|X|~)\] (.+)$/;   // ~ = de heartbeat is ermee bezig (claim, Codex ronde 2 MOET 1)
function sleutelVan(datum, ruw) { return sha(datum + '\n' + ruw.trim()).slice(0, 12); }
// Socevs werkregel → een zin voor David (heuristiek; de ruwe regel blijft in het bestand)
function opschoon(t) {
  let s = String(t || '').trim();
  s = s.replace(/^tik\s+\d{1,2}[:.]\d{2}\s*[-–—]\s*/i, '');
  s = s.replace(/\s+—\s+(gedaan|niet gedaan|weggeveegd|naar voren)\b.*$/i, '');
  const zal = s.indexOf('"Zal ik');
  if (zal >= 0) { const e = s.indexOf('?"', zal); if (e > zal) s = s.slice(zal + 1, e + 1); }
  s = s.replace(/^agendavoorstel\s*(\([^)]*\))?\s*:\s*/i, '');
  s = s.replace(/^herinner(?:ing)?\s+David\s*:\s*/i, '');
  s = s.replace(/\s*\((?:eerst|meet eerst)[^)]*\)/gi, '');
  s = s.replace(/\s*\(doorgeschoven[^)]*\)/gi, '');
  s = s.replace(/\s+(?:Eerst (?:opnieuw )?meten|Context in één zin|Erbij in één regel)\b.*$/i, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > TEKST_MAX) s = s.slice(0, TEKST_MAX - 1).replace(/\s+\S*$/, '') + '…';
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}
function lees(tekst, vandaag) {
  const s = sectie(tekst);
  if (!s) return { datum: null, regels: [] };
  const datum = planDatum(s.rijen, s.begin, s.einde);
  if (!datum || datum !== vandaag) return { datum: datum, regels: [] };
  const regels = [];
  for (let i = s.begin; i < s.einde; i++) {
    const m = REGEL_RE.exec(s.rijen[i]);
    if (!m) continue;
    const t = /^tik\s+(\d{1,2})[:.](\d{2})\b/i.exec(m[3].trim());
    const tekstD = opschoon(m[3]);
    if (!tekstD) continue;
    // ruw: de volledige regel, voor "Nu doen" (Socev krijgt de oorspronkelijke opdracht met voorwaarden, ronde 2 MOET 2)
    regels.push({ sleutel: sleutelVan(datum, s.rijen[i]), tijd: t ? hhmm(Number(t[1]), Number(t[2])) : null, tekst: tekstD, open: m[2] === ' ', bezig: m[2] === '~', ruw: m[3].trim().slice(0, 1200) });
  }
  return { datum: datum, regels: regels };
}
// Kan een heartbeat-tik deze regel nu uitvoeren? (regel zonder tijd: elke tik)
function tikBezig(tijd, nuMin) {
  const t = tijd ? Number(tijd.slice(0, 2)) * 60 + Number(tijd.slice(3, 5)) : 0;
  return TIKKEN.some(function (k) { return nuMin >= k[0] && nuMin < k[1] && t <= k[2]; });
}
// Veeg: alleen de ene open regel van het plan van vandaag; anders { fout, status }
function veeg(tekst, sleutel, o) {
  const s = sectie(tekst);
  if (!s) return { fout: 'er staat vandaag geen dagplan', status: 409 };
  const datum = planDatum(s.rijen, s.begin, s.einde);
  if (!datum || datum !== o.vandaag) return { fout: 'het dagplan is intussen vernieuwd; ververs', status: 409 };
  for (let i = s.begin; i < s.einde; i++) {
    const m = REGEL_RE.exec(s.rijen[i]);
    if (!m || sleutelVan(datum, s.rijen[i]) !== sleutel) continue;
    if (m[2] === '~') return { fout: 'Socev is hier nu mee bezig; probeer het over een kwartier', status: 409 };
    if (m[2] !== ' ') return { fout: 'deze regel is al gedaan of weg', status: 409 };
    const t = /^tik\s+(\d{1,2})[:.](\d{2})\b/i.exec(m[3].trim());
    if (o.nuMin != null && tikBezig(t ? hhmm(Number(t[1]), Number(t[2])) : null, o.nuMin)) return { fout: 'Socev is hier nu mee bezig; probeer het over een kwartier', status: 409 };
    s.rijen[i] = m[1] + '- [x] ' + m[3] + ' — weggeveegd door David ' + o.hhmm + ' (niet doen)';
    return { tekst: s.rijen.join('\n') };
  }
  return { fout: 'deze regel staat niet (meer) in het dagplan; ververs', status: 409 };
}

// ── Tijd uit een zin ──────────────────────────────────────────────────────────────────────────────────────────────────────
const GETAL = { een: 1, 'één': 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9, tien: 10, elf: 11, twaalf: 12,
  dertien: 13, veertien: 14, vijftien: 15, twintig: 20, kwart: 15 };
const G = '(\\d{1,2}|een|één|twee|drie|vier|vijf|zes|zeven|acht|negen|tien|elf|twaalf)';
function getal(x) { return /^\d+$/.test(x) ? Number(x) : GETAL[x]; }
function tijdUit(zin, nuMs) {
  const orig = String(zin || '').trim();
  let z = ' ' + orig.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ') + ' ';
  const weg = [];
  const pak = function (re) { const m = re.exec(z); if (m) { weg.push(m[0]); z = z.replace(m[0], ' '); } return m; };
  const nu = ams(nuMs);
  let dag = nu.ymd, morgen = false, deel = null;
  if (pak(/\bmorgen(?:ochtend|middag|avond)?\b(?!s)/)) { morgen = true; dag = ymdPlus(nu.ymd, 1); const w = weg[weg.length - 1]; if (/ochtend/.test(w)) deel = 'am'; else if (/middag|avond/.test(w)) deel = 'pm'; }
  if (pak(/(?:'s|des)\s*(ochtends|morgens)\b|\bvanochtend\b|\bvanmorgen\b/)) deel = 'am';
  if (pak(/(?:'s|des)\s*(middags|avonds)\b|\bvanmiddag\b|\bvanavond\b/)) deel = 'pm';
  // relatief: over N minuten / over een (half) uur / over een kwartier / over anderhalf uur
  let m = pak(/\bover\s+(?:een\s+)?(kwartier|half uur|anderhalf uur|(\d{1,3}|een|één|twee|drie|vier|vijf|tien|twintig|dertig)\s*(minuten|minuut|min|uur|uren))\b/);
  if (m && !morgen) {
    let min;
    if (m[1] === 'kwartier') min = 15; else if (m[1] === 'half uur') min = 30; else if (m[1] === 'anderhalf uur') min = 90;
    else { const n = /^\d+$/.test(m[2]) ? Number(m[2]) : ({ dertig: 30 }[m[2]] || GETAL[m[2]]); min = /uur|uren/.test(m[3]) ? n * 60 : n; }
    if (!(min >= 1 && min <= 24 * 60)) return null;
    return { wanneer: Math.ceil((nuMs + min * MIN) / MIN) * MIN, tekst: tekstRest(z, orig) };
  }
  let h = null, mi = 0, expliciet = false;
  if ((m = pak(/\b(?:om\s+)?([01]?\d|2[0-3])\s*[:.u]\s*([0-5]\d)\b/))) {
    h = Number(m[1]); mi = Number(m[2]); expliciet = h === 0 || h >= 13 || /^0/.test(m[1]);
  } else if ((m = pak(new RegExp('\\b(?:om\\s+)?(vijf|tien|\\d{1,2})\\s+(voor|over)\\s+half\\s+' + G + '\\b')))) {
    const n = getal(m[1]), x = getal(m[3]); h = x - 1; mi = m[2] === 'voor' ? 30 - n : 30 + n;
  } else if ((m = pak(new RegExp('\\b(?:om\\s+)?half\\s+' + G + '\\b')))) {
    h = getal(m[1]) - 1; mi = 30;
  } else if ((m = pak(new RegExp('\\b(?:om\\s+)?(kwart|vijf|tien|twintig|\\d{1,2})\\s+(voor|over)\\s+' + G + '\\b')))) {
    const n = getal(m[1]), x = getal(m[3]);
    if (m[2] === 'over') { h = x; mi = n; } else { h = x - 1; mi = 60 - n; }
  } else if ((m = pak(new RegExp('\\b(?:om\\s+)?' + G + '\\s*uur\\b'))) || (m = pak(new RegExp('\\bom\\s+' + G + '\\b')))) {
    h = getal(m[1]); mi = 0; expliciet = h === 0 || h >= 13;
  }
  if (h == null || !(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) return null;
  if (h === 0 && !expliciet) h = 12;   // "half een" = 12:30
  let kand;
  if (expliciet) kand = [h];
  else if (deel === 'am') kand = [h % 12];
  else if (deel === 'pm') kand = [h < 12 ? h + 12 : h];
  else kand = h === 12 ? [12] : [h, h + 12];
  const vrij = !expliciet && !deel;
  const kies = function (d, alleenNa) {
    for (const k of kand) {
      const min = k * 60 + mi;
      if (vrij && (min < WAKKER_VAN || min > WAKKER_TOT)) continue;
      const ms = msVan(d, k, mi);
      if (!alleenNa || ms > nuMs) return ms;
    }
    return null;
  };
  let wanneer = morgen ? kies(dag, false) : kies(dag, true);
  if (wanneer == null && !morgen) wanneer = kies(ymdPlus(nu.ymd, 1), false);
  if (wanneer == null) return null;
  return { wanneer: wanneer, tekst: tekstRest(z, orig) };
}
function tekstRest(z, orig) {
  let t = z.replace(/\b(?:zet\s+erbij|herinner(?:ing)?\s+(?:me|mij)?|herinner|stuur\s+(?:me|mij)\s+een\s+herinnering|laat\s+(?:me|mij)\s+weten|wil\s+je)\b/g, ' ');
  t = t.replace(/\b(?:er|even|graag|alsjeblieft|aub)\b/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:[:,\-–]\s*)?(?:aan|om|dat|over|voor)\s+/, '').replace(/^[:,\-–]\s*/, '').replace(/[\s,.:;-]+$/, '').trim();
  // Hoofdletters uit de oorspronkelijke zin terughalen waar het stuk letterlijk voorkomt
  const i = orig.toLowerCase().indexOf(t);
  if (t && i >= 0) t = orig.slice(i, i + t.length);
  if (!t) t = orig;
  if (t.length > ERBIJ_TEKST_MAX) t = t.slice(0, ERBIJ_TEKST_MAX);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ── Davids eigen herinneringen: opslag + klok ────────────────────────────────────────────────────────────────────────────
function maak(o) {
  const nuF = o.nu || Date.now;
  const log = o.log || function () {};
  let bezig = false;
  function leesStaat() {
    try { const j = JSON.parse(fs.readFileSync(o.staatPad, 'utf8')); return Array.isArray(j.items) ? j : { items: [] }; }
    catch (e) { if (e.code === 'ENOENT') return { items: [] }; throw e; }
  }
  function schrijf(st) {
    fs.mkdirSync(path.dirname(o.staatPad), { recursive: true, mode: 0o700 });
    const tmp = o.staatPad + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, o.staatPad);
  }
  function opruim(st, nu) { st.items = st.items.filter(function (x) { return x.status === 'open' || nu - Date.parse(x.wanneer) < ERBIJ_BEWAAR_MS; }); }
  function zichtbaar(nu) {
    const v = ams(nu).ymd;
    return leesStaat().items.filter(function (x) { return x.status === 'open' || (x.status === 'verstuurd' && ams(Date.parse(x.wanneer)).ymd === v); })
      .map(function (x) { const a = ams(Date.parse(x.wanneer)); return { id: x.id, tijd: hhmm(a.h, a.m), dag: a.ymd === v ? 'vandaag' : 'morgen', tekst: x.tekst, open: x.status === 'open', zelf: true }; });
  }
  function erbij(zin) {
    const z = String(zin || '').trim();
    if (!z) return { ok: false, status: 400, fout: 'typ of spreek in wat je erbij wilt' };
    if (z.length > 500) return { ok: false, status: 400, fout: 'dat is te lang (hooguit 500 tekens)' };
    const nu = nuF();
    const t = tijdUit(z, nu);
    if (!t) return { ok: false, status: 400, fout: 'zeg erbij hoe laat, bijvoorbeeld: om drie uur, half vijf of over twintig minuten' };
    const st = leesStaat();
    opruim(st, nu);
    if (st.items.filter(function (x) { return x.status === 'open'; }).length >= ERBIJ_OPEN_MAX) return { ok: false, status: 429, fout: 'er staan al ' + ERBIJ_OPEN_MAX + ' herinneringen open' };
    const item = { id: crypto.randomBytes(6).toString('hex'), wanneer: new Date(t.wanneer).toISOString(), tekst: t.tekst, gemaakt: new Date(nu).toISOString(), status: 'open', pogingen: 0 };
    st.items.push(item);
    schrijf(st);
    const a = ams(t.wanneer);
    log({ erbij: item.id, om: hhmm(a.h, a.m) });
    return { ok: true, id: item.id, tijd: hhmm(a.h, a.m), dag: a.ymd === ams(nu).ymd ? 'vandaag' : 'morgen', tekst: item.tekst };
  }
  function weg(id) {
    const st = leesStaat();
    const x = st.items.find(function (y) { return y.id === id; });
    if (!x) return { ok: false, status: 404, fout: 'deze herinnering ken ik niet (meer)' };
    if (x.status !== 'open') return { ok: false, status: 409, fout: 'deze herinnering is al verstuurd' };
    x.status = 'weg'; x.weg = new Date(nuF()).toISOString();
    schrijf(st);
    return { ok: true };
  }
  async function tik() {
    if (bezig) return { bezig: true };
    bezig = true;
    try {
      const nu = nuF();
      const st = leesStaat();
      const rijp = st.items.filter(function (x) { return x.status === 'open' && Date.parse(x.wanneer) <= nu; });
      let n = 0;
      for (const x of rijp) {
        const a = ams(Date.parse(x.wanneer));
        const laat = nu - Date.parse(x.wanneer) > ERBIJ_TE_LAAT_MS ? ' (te laat: gepland ' + hhmm(a.h, a.m) + ')' : '';
        try {
          await o.melden('Herinnering' + laat + ': ' + x.tekst, 'herinnering-david-' + x.id);
          x.status = 'verstuurd'; x.verstuurd = new Date(nuF()).toISOString(); n++;
        } catch (e) {
          x.pogingen = (x.pogingen || 0) + 1;
          log({ fout: x.id, poging: x.pogingen, reden: String(e && e.message || e).slice(0, 80) });
          if (!x.box && nu - Date.parse(x.wanneer) > ERBIJ_BOX_MS && o.boxRij) { x.box = true; try { o.boxRij('dagplan-erbij: herinnering ' + x.id + ' (gepland ' + hhmm(a.h, a.m) + ') lukt al 30 min niet: ' + String(e && e.message || e).slice(0, 120)); } catch (e2) {} }
        }
      }
      if (rijp.length) { opruim(st, nu); schrijf(st); }
      return { verstuurd: n, rijp: rijp.length };
    } finally { bezig = false; }
  }
  function info() {
    try { const it = leesStaat().items; return { open: it.filter(function (x) { return x.status === 'open'; }).length, verstuurd: it.filter(function (x) { return x.status === 'verstuurd'; }).length }; }
    catch (e) { return { fout: true }; }
  }
  return { erbij: erbij, weg: weg, tik: tik, zichtbaar: zichtbaar, info: info };
}

module.exports = { lees, veeg, tikBezig, tijdUit, opschoon, maak, ams, msVan, sleutelVan, TIKKEN };
