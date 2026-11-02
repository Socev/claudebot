'use strict';
// wv2245 (idee 13, bouwplan "Eén meldingenkanaal" § 4.8; David 2-11-2026 10:19 + Ja 10:20, vraag-id d5f22ee1): "Te lezen" in Voor jou —
// berichten die voor David zijn maar niets vragen, met een vinkje Gezien (op de pod, dus op alle apparaten weg), Reageer en Bewaar.
// Puur: geen bestand, geen netwerk; server.js geeft het app-log, de klussen (mk_te_lezen_klussen), de staat (te-lezen.json) en de
// gezien-tijden per gesprek (gezien-david.json tabs) mee. Getoetst in test/te-lezen.sh.
//
// Wat erin komt (gemeten 26-10 → 2-11, bouwplan § 4.8):
//   klus     — agentrapport in de machinekamer van een wortelrij (diepte 0, rij = wortel: de klus die rechtstreeks uit Davids opdracht of
//              knop kwam), herkomst david, soort gewoon; in het hoofdkanaal elk agentrapport-david. Vervolgstappen niet (58/dag).
//   antwoord — Davids eigen beurt (getypt of knop) met een antwoord, zolang hij dat gesprek ná het antwoord niet zag.
//   bewaard  — wat David in het gesprek bewaarde (14 dagen na het bewaren).
// Nooit: een bericht met een vraag (die staat in Moet iets of als kaart), Telegram-beurten, zoekvragen; op een vaste plek geen hoofdkanaal.

const DAG = 86400000;
const AUTO_MS = 7 * DAG;          // vanzelf erin: 7 dagen (± 17 per dag; 14 dagen zou ± 240 punten worden)
const BEWAAR_MS = 14 * DAG;       // bewaard: 14 dagen na het bewaren
const HOUD_MS = 15 * DAG;         // afgevinkte ids zo lang bewaren (langer dan elk venster)
const LOG_MS = 30 * DAG;          // server.js leest het hele app-log (bewaart 30 dagen; review wv2245 MOET 4)
const BEWAAR_OUD_MS = 16 * DAG;   // bewaren kan tot dit oud: dan staat het bericht nog 14 dagen in het log
const MAX = 40;
const AFGEVINKT_MAX = 20;
const BERICHT_MAX = 6000;
const VAN_MAX = 160;
const STAAT_MAX = 2000;
const JOB_RE = /^[0-9a-f]{16}$/;
const KANALEN = ['hoofd', 'machinekamer'];
const ACTIES = { gezien: 1, terug: 1, bewaar: 1, 'niet-bewaren': 1 };

function kort(t, n) {
  const a = Array.from(String(t || '').replace(/\s+/g, ' ').trim());
  return a.length > n ? a.slice(0, n - 1).join('').trimEnd() + '…' : a.join('');
}
// De klus telt als hij rechtstreeks uit Davids opdracht kwam: herkomst david, soort gewoon, diepte 0 en zelf de wortel van zijn keten.
function klusTelt(k) {
  return !!k && typeof k === 'object' && k.herkomst === 'david' && (k.soort || 'gewoon') === 'gewoon' && Number(k.diepte || 0) === 0 &&
    k.rij != null && String(k.wortel) === String(k.rij);
}
function tijd(x) { const t = Date.parse(x); return isFinite(t) ? t : NaN; }

// Staat (te-lezen.json): {versie: 1, sinds: iso, gezien: {job_id: iso}, bewaard: {job_id: {kanaal, op}}}. Alles wat niet klopt valt weg.
// sinds = begin van het vanzelf-venster: bij de eerste keer 24 uur vóór de start (droge run 2-11 op echte gegevens: anders 121 punten
// op dag één, de achterstand van een week); server.js schrijft hem één keer weg.
const START_TERUG_MS = DAG;
function staatNorm(r, nu) {
  r = r && typeof r === 'object' ? r : {};
  const si = tijd(r.sinds);
  const s = { versie: 1, sinds: new Date(isFinite(si) && si <= nu ? si : nu - START_TERUG_MS).toISOString(), gezien: {}, bewaard: {} };
  const g = r.gezien && typeof r.gezien === 'object' ? r.gezien : {}, b = r.bewaard && typeof r.bewaard === 'object' ? r.bewaard : {};
  Object.keys(g).forEach(function (j) { const t = tijd(g[j]); if (JOB_RE.test(j) && t > nu - HOUD_MS) s.gezien[j] = new Date(t).toISOString(); });
  Object.keys(b).forEach(function (j) {
    const x = b[j], t = tijd(x && x.op);
    if (JOB_RE.test(j) && x && KANALEN.indexOf(x.kanaal) >= 0 && t > nu - BEWAAR_MS) s.bewaard[j] = { kanaal: x.kanaal, op: new Date(t).toISOString() };
  });
  // begrensd: de oudste eruit
  ['gezien', 'bewaard'].forEach(function (k) {
    const ks = Object.keys(s[k]);
    if (ks.length <= STAAT_MAX) return;
    const op = function (j) { return k === 'gezien' ? s[k][j] : s[k][j].op; };
    ks.sort(function (x, y) { return op(y).localeCompare(op(x)); }).slice(STAAT_MAX).forEach(function (j) { delete s[k][j]; });
  });
  return s;
}
// Een actie van David op de staat (puur: geeft een nieuwe staat, of {fout}). bestaat = tijd (ms) van het bericht in dat gesprek, of
// null (alleen bij bewaar nodig; ouder dan 16 dagen kan niet: het log houdt het dan geen 14 dagen meer vast).
function zet(staat, d, nu, bestaat) {
  d = d && typeof d === 'object' ? d : {};
  const job = String(d.job_id || ''), actie = String(d.actie || ''), kanaal = String(d.kanaal || '');
  if (!JOB_RE.test(job)) return { fout: 'ongeldig bericht' };
  if (!ACTIES[actie]) return { fout: 'onbekende actie' };
  if (KANALEN.indexOf(kanaal) < 0) return { fout: 'onbekend gesprek' };
  const s = staatNorm(staat, nu), iso = new Date(nu).toISOString();
  if (actie === 'gezien') s.gezien[job] = iso;
  else if (actie === 'terug') delete s.gezien[job];
  else if (actie === 'bewaar') {
    if (!bestaat) return { fout: 'dat bericht staat niet (meer) in dit gesprek' };
    if (!(nu - bestaat < BEWAAR_OUD_MS)) return { fout: 'dat bericht is te oud om te bewaren' };
    s.bewaard[job] = { kanaal: kanaal, op: iso };
    delete s.gezien[job];   // opnieuw bewaren = weer te lezen
  } else delete s.bewaard[job];
  return { staat: staatNorm(s, nu) };
}

// De lijst. o = {per: {hoofd: [...], machinekamer: [...]} (app-log, met de nog niet gelogde beurten), klussen: {job: {...}} | null
// (null = onleesbaar: geen klus-punten in de machinekamer), staat, tabs: {kanaal: iso} (gezien door David), vraag: fn(x, kanaal) -> bool,
// moet: Set van job_ids die nu in Moet iets staan (ook een bewaard bericht dan niet: review wv2245 MOET 1), inBeeld: {sleutel: iso}
// (gezien-david.json punten: telt voor 'nieuw', het getal; MOET 2), vast: vaste plek, nu}.
// Tijden: x.t in het app-log is de afloop van de beurt (het antwoord); x.getypt de typtijd (review MOET 3: t is de goede).
function uit(o) {
  const nu = o.nu, staat = staatNorm(o.staat, nu), sinds = Date.parse(staat.sinds), tabs = o.tabs && typeof o.tabs === 'object' ? o.tabs : {};
  const vraag = typeof o.vraag === 'function' ? o.vraag : function () { return false; };
  const punten = [], afgevinkt = [], gehad = {};
  KANALEN.forEach(function (kanaal) {
    if (o.vast && kanaal === 'hoofd') return;
    ((o.per && o.per[kanaal]) || []).forEach(function (x) {
      if (!x || !JOB_RE.test(String(x.job_id || '')) || gehad[x.job_id]) return;
      if (x.soort === 'telegram' || x.soort === 'zoek') return;
      const t = tijd(x.t);
      if (!isFinite(t) || t > nu + 60000) return;
      const bew = staat.bewaard[x.job_id], bewaard = !!bew && bew.kanaal === kanaal;
      const antwoord = String(x.antwoord || '');
      if (!antwoord.trim()) return;
      let soort = null, titel = null, van = null;
      if (!vraag(x, kanaal) && nu - t < AUTO_MS && t >= sinds) {
        if (x.soort === 'socev') {
          if (kanaal === 'hoofd' && x.bron === 'agentrapport-david') soort = 'klus';
          else if (kanaal === 'machinekamer' && x.bron === 'agentrapport' && o.klussen && klusTelt(o.klussen[x.agent_job])) {
            soort = 'klus';
            titel = kort(o.klussen[x.agent_job].titel || '', 200) || null;
          }
        } else if (x.soort === 'bericht' || x.soort === 'knop') {
          if (!(tijd(tabs[kanaal]) >= t)) soort = 'antwoord';   // David zag het gesprek ná het antwoord: dan niet (meer)
        }
      }
      if (!soort && bewaard && !(o.moet && o.moet.has(x.job_id))) soort = 'bewaard';
      if (!soort) return;
      if (x.soort === 'bericht' || x.soort === 'knop') van = kort(x.tekst, VAN_MAX) || null;
      gehad[x.job_id] = 1;
      const p = { sleutel: 't:' + x.job_id, soort: soort, bewaard: bewaard, kanaal: kanaal, job_id: x.job_id, t: new Date(t).toISOString(),
        titel: titel, van: van, knop: x.soort === 'knop', ok: x.ok !== false,
        bericht: antwoord.length > BERICHT_MAX ? antwoord.slice(0, BERICHT_MAX) + '\n\n…' : antwoord, afgekapt: antwoord.length > BERICHT_MAX };
      const g = staat.gezien[x.job_id];
      if (g) afgevinkt.push(Object.assign(p, { gezien: g })); else punten.push(p);
    });
  });
  punten.sort(function (p, q) { return q.t.localeCompare(p.t); });
  afgevinkt.sort(function (p, q) { return q.gezien.localeCompare(p.gezien); });
  const inBeeld = o.inBeeld && typeof o.inBeeld === 'object' ? o.inBeeld : {};
  // nieuw = niet afgevinkt én nog niet in beeld geweest (keuze 4 van 17-10: het getal is wat nieuw is sinds je keek)
  return { punten: punten.slice(0, MAX), meer: Math.max(0, punten.length - MAX), ongezien: punten.length,
    nieuw: punten.filter(function (p) { return !inBeeld[p.sleutel]; }).length,
    // diffreview wv2245 MOET 2: welke berichten bewaard zijn (het gesprek toont dan ★ Bewaard, ook na herladen en op een ander apparaat)
    bewaard: Object.keys(staat.bewaard).filter(function (j) { return !(o.vast && staat.bewaard[j].kanaal === 'hoofd'); }).sort(),
    afgevinkt: afgevinkt.slice(0, AFGEVINKT_MAX).map(function (p) { return { sleutel: p.sleutel, soort: p.soort, kanaal: p.kanaal, job_id: p.job_id, t: p.t, titel: p.titel, van: p.van, knop: p.knop, gezien: p.gezien, bericht: p.bericht.slice(0, 600) }; }) };
}
// De agentklussen waarvan server.js de herkomst moet opvragen (machinekamer, bron agentrapport, binnen het venster).
function klusJobs(per, nu) {
  const s = new Set();
  ((per && per.machinekamer) || []).forEach(function (x) {
    if (x && x.soort === 'socev' && x.bron === 'agentrapport' && JOB_RE.test(String(x.agent_job || '')) && nu - tijd(x.t) < AUTO_MS) s.add(x.agent_job);
  });
  return Array.from(s).sort();
}

module.exports = { uit: uit, zet: zet, staatNorm: staatNorm, klusTelt: klusTelt, klusJobs: klusJobs,
  AUTO_MS: AUTO_MS, BEWAAR_OUD_MS: BEWAAR_OUD_MS, BEWAAR_MS: BEWAAR_MS, LOG_MS: LOG_MS, MAX: MAX, JOB_RE: JOB_RE };
