'use strict';
// wv2245 (idee 13, bouwplan "Eén meldingenkanaal" § 4.8; David 2-11-2026 10:19 + Ja 10:20, vraag-id d5f22ee1): "Te lezen" in Voor jou —
// berichten die voor David zijn maar niets vragen, met een vinkje Gezien (op de pod, dus op alle apparaten weg), Reageer en Bewaar.
// Puur: geen bestand, geen netwerk; server.js geeft het app-log, de klussen (mk_te_lezen_klussen), de staat (te-lezen.json) en de
// gezien-tijden per gesprek (gezien-david.json tabs) mee. Getoetst in test/te-lezen.sh.
//
// Wat erin komt (gemeten 26-10 → 2-11, bouwplan § 4.8):
//   klus     — agentrapport in de machinekamer van een wortelrij (diepte 0, rij = wortel: de klus die rechtstreeks uit Davids opdracht of
//              knop kwam), herkomst david, soort gewoon; in het hoofdkanaal elk agentrapport-david. Vervolgstappen niet (58/dag).
//   antwoord — Davids eigen getypte beurt met een antwoord, zolang hij dat gesprek ná het antwoord niet zag; een knopdruk alleen bij een
//              fout of een bestand (wv3093, knopTelt).
//   bewaard  — wat David in het gesprek bewaarde (14 dagen na het bewaren).
// Nooit: een bericht met een vraag (die staat in Moet iets of als kaart), Telegram-beurten, zoekvragen.
// wv3967 (David 22-11-2026 "Less is more", Ja 22:31): met o.mkKlussen === false (zo roept server.js het aan) geen klusrapporten uit de
// machinekamer meer (die blijven in het machinekamer-gesprek); met o.momentSinds (ms, vj-moment.js) een klusrapport pas na het eerstvolgende
// vaste moment (07:15, 12:30, 17:15). Antwoord op Davids eigen beurt en bewaard: meteen.
// wv4175 (besluitenpagina nr 308 = 3C08 en nr 375 = 3C75, David Ja 25-11-2026 22:26):
//   socev — de uitkomst van een achtergrondklus die Socev in het gesprek startte (bron socev-spreekt mét agent_job; "AI - Mail volgen"
//           gebruikt dezelfde bron zonder klusnummer en telt niet) komt als klus-punt met socev: true, meteen (geen vast moment: het is het
//           antwoord op Davids eigen vraag en het seintje "Antwoord van Socev klaar" gaat ook meteen).
//   merk  — de slotregel "Voor David: Niets doen | Probeer het: <App › plek> | Wacht: … | Mislukt: …" die AGENT_EINDREGEL van elke agent
//           vraagt (o.slotVan(agent_job) uit het agentregister, anders uit de berichttekst; ok false = mislukt). Geen slotregel = geen
//           merkje, gedrag als vroeger. Volgorde: Mislukt, Probeer het en socev bovenaan (rang 0), dan de rest; binnen een rang op tijd.

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
// wv3093 (David 14-11-2026 22:35: "te vaak berichten wegklikken ... vooral de berichten die komen doordat ik op 'ja' of nee heb geklikt"):
// het antwoord op een knopdruk (Ja/Nee/Anders; app-log soort knop) is meestal een bevestiging en blijft alleen in het gesprek. Wél te
// lezen: een mislukte beurt (ok false) of een antwoord met een bestand. Een antwoord met een nieuwe vraag staat in Moet iets (vraag()).
// Gemeten 7-14 nov: 159 knopantwoorden, 15 met een vraag, 5 met een bestand, 0 mislukt.
function knopTelt(x) {
  return x.ok === false || (Array.isArray(x.bestanden) && x.bestanden.length > 0);
}
function tijd(x) { const t = Date.parse(x); return isFinite(t) ? t : NaN; }
// wv4181 (besluitenpagina nr 344 = 3C44, David Ja 25-11-2026 22:26): de bestanden van het bericht (namen uit het app-log, zoals het gesprek
// ze toont) gaan mee met het punt; de app zet ze als knop onder het punt en opent ze in de Lezer met ‹ › door alle bestanden van die klus.
// bestanden_socev: een bericht van Socev zelf (nummer = plek + 1 in app-bestanden), anders een beurt (de app zoekt het nummer op naam).
const BESTANDEN_MAX = 20;
function bestandNamen(b) {
  if (!Array.isArray(b)) return [];
  return b.filter(function (n) { return typeof n === 'string' && n.trim() && n.length <= 255; }).slice(0, BESTANDEN_MAX);
}

// wv4175 (3C75): de slotregel van een agentrapport. De LAATSTE regel "Voor David: …" buiten codeblokken, alleen als hij met een van de vier
// vaste woorden begint (vrije tekst geeft nooit een merkje). {merk: niets|probeer|wacht|mislukt, plek: 'App › plek' | null} of null.
const MERKEN = ['niets', 'probeer', 'wacht', 'mislukt'];
const PLEK_MAX = 80;
const SLOT_RE = /^[ \t]*(?:[-*>]+[ \t]*)?(?:\*\*|__)?Voor David(?:\*\*|__)?[ \t]*[:：][ \t]*(?:\*\*|__)?[ \t]*(.*?)[ \t]*$/i;
function slotregel(tekst) {
  const t = String(tekst || '').replace(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[^\n]*$/gm, '');
  const regels = t.split('\n');
  for (let i = regels.length - 1; i >= 0 && i >= regels.length - 400; i--) {
    const m = SLOT_RE.exec(regels[i]);
    if (!m) continue;
    const w = m[1].replace(/\*\*|__/g, '').trim();
    let merk = null;
    if (/^niets(\s+(te\s+)?doen)?\b/i.test(w)) merk = 'niets';
    else if (/^probeer(\s+het)?\b/i.test(w)) merk = 'probeer';
    else if (/^wacht\b/i.test(w)) merk = 'wacht';
    else if (/^mislukt\b/i.test(w)) merk = 'mislukt';
    if (!merk) return null;   // de laatste "Voor David:"-regel telt; is die vrij, dan geen merkje
    let plek = null;
    if (merk === 'probeer') {
      const pm = /^probeer(?:\s+het)?\s*[:：—–-]\s*(.+)$/i.exec(w);
      if (pm) plek = kort(pm[1].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_<>#|]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[.\s]+$/, ''), PLEK_MAX) || null;
    }
    return { merk: merk, plek: plek };
  }
  return null;
}
function slotNorm(s) {
  if (!s || typeof s !== 'object' || MERKEN.indexOf(s.merk) < 0) return null;
  return { merk: s.merk, plek: s.merk === 'probeer' && typeof s.plek === 'string' && s.plek.trim() ? kort(s.plek, PLEK_MAX) : null };
}
const SOCEV_BRON = 'socev-spreekt';
// Een Socev-uitkomst van een achtergrondklus: hoofdkanaal, bron socev-spreekt, met klusnummer (zonder = Mail volgen e.d.: telt niet).
function socevKlus(x, kanaal) { return kanaal === 'hoofd' && !!x && x.soort === 'socev' && x.bron === SOCEV_BRON && JOB_RE.test(String(x.agent_job || '')); }

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

// wv3678 (besluitenpagina nr 130, 2C30: "Alles gezien" met Zet terug): N berichten in één aanroep op gezien of terug. Alleen gezien|terug,
// 1..VEEL_MAX stuks; één ongeldig item = de hele aanroep geweigerd (niets half geschreven).
const VEEL_MAX = 50;
function zetVeel(staat, items, actie, nu) {
  if (actie !== 'gezien' && actie !== 'terug') return { fout: 'onbekende actie' };
  if (!Array.isArray(items) || !items.length || items.length > VEEL_MAX) return { fout: 'ongeldig bericht' };
  let s = staatNorm(staat, nu);
  for (const it of items) {
    const z = zet(s, { job_id: it && it.job_id, kanaal: it && it.kanaal, actie: actie }, nu, null);
    if (z.fout) return z;
    s = z.staat;
  }
  return { staat: s };
}

// De lijst. o = {per: {hoofd: [...], machinekamer: [...]} (app-log, met de nog niet gelogde beurten), klussen: {job: {...}} | null
// (null = onleesbaar: geen klus-punten in de machinekamer), staat, tabs: {kanaal: iso} (gezien door David), vraag: fn(x, kanaal) -> bool,
// moet: Set van job_ids die nu in Moet iets staan (ook een bewaard bericht dan niet: review wv2245 MOET 1), inBeeld: {sleutel: iso}
// (gezien-david.json punten: telt voor 'nieuw', het getal; MOET 2), nu}. Op elk apparaat alle kanalen (wv3446).
// Tijden: x.t in het app-log is de afloop van de beurt (het antwoord); x.getypt de typtijd (review MOET 3: t is de goede).
function uit(o) {
  const nu = o.nu, staat = staatNorm(o.staat, nu), sinds = Date.parse(staat.sinds), tabs = o.tabs && typeof o.tabs === 'object' ? o.tabs : {};
  const vraag = typeof o.vraag === 'function' ? o.vraag : function () { return false; };
  const punten = [], afgevinkt = [], gehad = {};
  KANALEN.forEach(function (kanaal) {
    ((o.per && o.per[kanaal]) || []).forEach(function (x) {
      if (!x || !JOB_RE.test(String(x.job_id || '')) || gehad[x.job_id]) return;
      if (x.soort === 'telegram' || x.soort === 'zoek') return;
      const t = tijd(x.t);
      if (!isFinite(t) || t > nu + 60000) return;
      const bew = staat.bewaard[x.job_id], bewaard = !!bew && bew.kanaal === kanaal;
      const antwoord = String(x.antwoord || '');
      if (!antwoord.trim()) return;
      let soort = null, titel = null, van = null, socev = false;
      if (!vraag(x, kanaal) && nu - t < AUTO_MS && t >= sinds) {
        if (x.soort === 'socev') {
          if (socevKlus(x, kanaal)) { soort = 'klus'; socev = true; }   // wv4175 (3C08): meteen, niet op het vaste moment
          else if (kanaal === 'hoofd' && x.bron === 'agentrapport-david') soort = 'klus';
          else if (kanaal === 'machinekamer' && o.mkKlussen !== false && x.bron === 'agentrapport' && o.klussen && klusTelt(o.klussen[x.agent_job])) {
            soort = 'klus';
            titel = kort(o.klussen[x.agent_job].titel || '', 200) || null;
          }
          if (soort === 'klus' && !socev && Number.isFinite(o.momentSinds) && t > o.momentSinds) { soort = null; titel = null; }   // wv3967
        } else if (x.soort === 'bericht' || (x.soort === 'knop' && knopTelt(x))) {
          if (!(tijd(tabs[kanaal]) >= t)) soort = 'antwoord';   // David zag het gesprek ná het antwoord: dan niet (meer)
        }
      }
      // wv4232 (L48): het antwoord of rapport bij een knopdruk op een Voor jou-kaart hangt als afloopregel aan die kaart (Afgehandeld);
      // dan niet ook los hier. Mislukt blijft wel staan.
      if ((soort === 'klus' || soort === 'antwoord') && o.aanKaart && x.ok !== false && (o.aanKaart.has(x.job_id) || o.aanKaart.has(x.agent_job))) soort = null;
      if (!soort && bewaard && !(o.moet && o.moet.has(x.job_id))) soort = 'bewaard';
      if (!soort) return;
      if (x.soort === 'bericht' || x.soort === 'knop') van = kort(x.tekst, VAN_MAX) || null;
      gehad[x.job_id] = 1;
      const slot = slotVoor(x, antwoord, o);
      const p = { sleutel: 't:' + x.job_id, soort: soort, bewaard: bewaard, kanaal: kanaal, job_id: x.job_id, t: new Date(t).toISOString(),
        titel: titel, van: van, knop: x.soort === 'knop', ok: x.ok !== false, socev: socev, merk: slot ? slot.merk : null, plek: slot ? slot.plek : null,
        bestanden: bestandNamen(x.bestanden), bestanden_socev: x.soort === 'socev',   // wv4181 (3C44)
        bericht: antwoord.length > BERICHT_MAX ? antwoord.slice(0, BERICHT_MAX) + '\n\n…' : antwoord, afgekapt: antwoord.length > BERICHT_MAX };
      const g = staat.gezien[x.job_id];
      if (g) afgevinkt.push(Object.assign(p, { gezien: g })); else punten.push(p);
    });
  });
  punten.sort(function (p, q) { return rang(p) - rang(q) || q.t.localeCompare(p.t); });   // wv4175: Mislukt, Probeer het, Socev bovenaan
  afgevinkt.sort(function (p, q) { return q.gezien.localeCompare(p.gezien); });
  const inBeeld = o.inBeeld && typeof o.inBeeld === 'object' ? o.inBeeld : {};
  // nieuw = niet afgevinkt én nog niet in beeld geweest (keuze 4 van 17-10: het getal is wat nieuw is sinds je keek)
  return { punten: punten.slice(0, MAX), meer: Math.max(0, punten.length - MAX), ongezien: punten.length,
    nieuw: punten.filter(function (p) { return !inBeeld[p.sleutel]; }).length,
    // diffreview wv2245 MOET 2: welke berichten bewaard zijn (het gesprek toont dan ★ Bewaard, ook na herladen en op een ander apparaat)
    bewaard: Object.keys(staat.bewaard).sort(),
    afgevinkt: afgevinkt.slice(0, AFGEVINKT_MAX).map(function (p) { return { sleutel: p.sleutel, soort: p.soort, kanaal: p.kanaal, job_id: p.job_id, t: p.t, titel: p.titel, van: p.van, knop: p.knop, gezien: p.gezien, socev: p.socev, merk: p.merk, plek: p.plek, bericht: p.bericht.slice(0, 600) }; }),
    // wv4181 (3C89): hoeveel er in het archief van Afgevinkt staat (15 dagen); de app haalt het archief zelf op met GET /app/te-lezen/archief
    archief_n: archief(o, false).length };
}
// wv4175 (3C75): het merkje. Mislukt als de beurt mislukte; anders de slotregel van de agent (register), anders uit de tekst zelf
// (agentrapport-david en een rapport uit de machinekamer zijn de rapporttekst); een gewone beurt van David krijgt er geen.
function slotVoor(x, antwoord, o) {
  if (x.ok === false) return { merk: 'mislukt', plek: null };
  if (x.soort !== 'socev') return null;
  const aj = String(x.agent_job || '');
  let slot = slotNorm(x.slot);   // server.js zet het merkje van de klus in de logregel (/bericht)
  if (!slot && JOB_RE.test(aj) && typeof o.slotVan === 'function') { try { slot = slotNorm(o.slotVan(aj)); } catch (e) { slot = null; } }
  return slot || slotregel(antwoord);
}

// wv4181 (besluitenpagina nr 389 = 3C89, David Ja 25-11-2026 22:26): Afgevinkt als leesarchief. Alles wat David in de afgelopen 15 dagen
// (HOUD_MS: zo lang bewaart te-lezen.json de afgevinkte ids) op gezien zette en nog in het app-log staat (30 dagen), ongeacht of het vandaag
// nog in Te lezen zou komen: een vinkje bewijst dat het er stond (of als dag-bericht met Weg uit Moet iets ging, wv2560). Volledige tekst
// (tot ARCHIEF_TEKST_MAX; de app toont het ter plekke en zoekt erin), nieuwste vinkje eerst. metTekst false = alleen tellen (voor archief_n).
const ARCHIEF_TEKST_MAX = 30000;
const ARCHIEF_MAX = 1500;
function archief(o, metTekst) {
  const nu = o.nu, staat = staatNorm(o.staat, nu), uitk = [], gehad = {};
  KANALEN.forEach(function (kanaal) {
    ((o.per && o.per[kanaal]) || []).forEach(function (x) {
      if (!x || !JOB_RE.test(String(x.job_id || '')) || gehad[x.job_id]) return;
      const g = staat.gezien[x.job_id];
      if (!g || x.soort === 'telegram' || x.soort === 'zoek') return;
      const t = tijd(x.t), antwoord = String(x.antwoord || '');
      if (!isFinite(t) || t > nu + 60000 || !antwoord.trim()) return;
      const soort = x.soort === 'socev' ? 'klus' : x.soort === 'bericht' || x.soort === 'knop' ? 'antwoord' : null;
      if (!soort) return;
      gehad[x.job_id] = 1;
      if (metTekst === false) { uitk.push({ gezien: g }); return; }
      const bew = staat.bewaard[x.job_id], slot = slotVoor(x, antwoord, o);
      uitk.push({ sleutel: 't:' + x.job_id, soort: soort, bewaard: !!bew && bew.kanaal === kanaal, kanaal: kanaal, job_id: x.job_id, t: new Date(t).toISOString(),
        titel: null, van: soort === 'antwoord' ? kort(x.tekst, VAN_MAX) || null : null, knop: x.soort === 'knop', ok: x.ok !== false,
        socev: socevKlus(x, kanaal), merk: slot ? slot.merk : null, plek: slot ? slot.plek : null, gezien: g,
        bestanden: bestandNamen(x.bestanden), bestanden_socev: x.soort === 'socev',
        bericht: antwoord.length > ARCHIEF_TEKST_MAX ? antwoord.slice(0, ARCHIEF_TEKST_MAX) + '\n\n…' : antwoord, afgekapt: antwoord.length > ARCHIEF_TEKST_MAX });
    });
  });
  uitk.sort(function (p, q) { return q.gezien.localeCompare(p.gezien); });
  return uitk.slice(0, ARCHIEF_MAX);
}
function rang(p) { return p.merk === 'mislukt' || p.merk === 'probeer' || p.socev ? 0 : 1; }
// De agentklussen waarvan server.js de herkomst moet opvragen (machinekamer, bron agentrapport, binnen het venster).
function klusJobs(per, nu) {
  const s = new Set();
  ((per && per.machinekamer) || []).forEach(function (x) {
    if (x && x.soort === 'socev' && x.bron === 'agentrapport' && JOB_RE.test(String(x.agent_job || '')) && nu - tijd(x.t) < AUTO_MS) s.add(x.agent_job);
  });
  return Array.from(s).sort();
}

module.exports = { archief: archief, HOUD_MS: HOUD_MS, BESTANDEN_MAX: BESTANDEN_MAX, slotregel: slotregel, slotNorm: slotNorm, socevKlus: socevKlus, MERKEN: MERKEN, uit: uit, zet: zet, zetVeel: zetVeel, VEEL_MAX: VEEL_MAX, staatNorm: staatNorm, klusTelt: klusTelt, knopTelt: knopTelt, klusJobs: klusJobs,
  AUTO_MS: AUTO_MS, BEWAAR_OUD_MS: BEWAAR_OUD_MS, BEWAAR_MS: BEWAAR_MS, LOG_MS: LOG_MS, MAX: MAX, JOB_RE: JOB_RE };
