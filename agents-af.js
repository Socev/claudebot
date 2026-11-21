'use strict';
// agents-af.js — wv3732 (besluitenpagina nr 374 = 3C74 en nr 402 = 3C102, David Ja 21-11-2026 13:13).
//
// WAAROM. In Agents stond onder elke afgeronde klus "rapport naar de machinekamer · verstuurd": post, geen nieuws. David wil per dag
// zien wat er af is met één zin over de uitkomst (3C74), en één lijst van wat hij zelf vroeg, in zijn eigen woorden, met per vraag de
// stand en de uitkomst (3C102). Hij denkt in "ik vroeg gisteren of …", niet in klusnummers.
// HOE.
//  - uitkomstUitRapport: de regel "Uitkomst: …" uit het bewaarde rapport (AGENT_EINDREGEL vraagt die sinds wv3732 van elke agent; zelfde
//    vorm als OVIS Code, ovis-code.js uitkomstUit); zonder die regel de eerste gewone zin van het rapport (oude rapporten, of een agent
//    die de regel vergat). Geen zin = null; de app valt dan terug op de titel.
//  - gevraagd: de werkvoorraadrijen van David (herkomst david of bron "David …") plus hun vervolgrijen, gegroepeerd tot opdrachten.
//    Eén opdracht = zelfde ouderketen OF zelfde bron (het bronveld erft in de databank van de ouder, wv3610), waarbij de bron wordt
//    teruggebracht tot Davids moment: alles na " + " eraf, en een verwijzing naar de besluitenpagina telt per set nummers. Stand per
//    opdracht: wacht op jou > loopt > in de rij > af (vervallen telt niet mee). Woorden: de vraag van de besluitenpagina (Ja op …) als
//    de bron daarnaar wijst, anders wat er in de bron na het tijdstip staat, anders de samenvatting van de eerste klus.
// RESTRISICO (bewust): groeperen op vrije tekst kan twee opdrachten van hetzelfde moment samenvoegen ("David app 21-11 13:44") of één
// opdracht splitsen als iemand de bron anders schreef; de pod ziet klare rijen maar 3 dagen (mk_werkvoorraad_stand), dus een oude
// opdracht met één nieuwe vervolgrij telt alleen wat er nog in beeld is.

const ZIN_MAX = 240;

function schoon(t, max) {
  let z = String(t == null ? '' : t)
    .replace(/\[([^\]]+)\]\((?:https?:[^)\s]+)\)/g, '$1')
    .replace(/\s*`(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}`/g, '')   // commitnummers zeggen David niets
    .replace(/[*_`#>|]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const m = max || ZIN_MAX;
  return z.length > m ? z.slice(0, m - 1).trimEnd() + '…' : z;
}

const UITKOMST_RE = /^[ \t]*(?:[-*>#]+[ \t]*)?(?:\*\*|__)?Uitkomst(?:\*\*|__)?[ \t]*[:：][ \t]*(?:\*\*|__)?[ \t]*(\S.*)$/im;

// { zin, regel } | null. regel = true als de agent zelf een regel "Uitkomst:" schreef.
function uitkomstUitRapport(tekst) {
  const t = String(tekst || '');
  // Codex-review wv3732 ZOU 1: een voorbeeldregel "Uitkomst: …" in een codeblok is geen uitkomst; codeblokken eerst weg
  const m = UITKOMST_RE.exec(t.replace(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[^\n]*$/gm, ''));
  if (m) {
    const z = schoon(m[1].replace(/\*\*|__/g, ''));
    if (z.length >= 3) return { zin: z, regel: true };
  }
  // Terugval: de eerste gewone regel (geen kop, tabel, code, LET OP-tussenstand of agentrapportkop), daarvan de eerste zin.
  let inCode = false;
  for (const r0 of t.split('\n').slice(0, 60)) {
    const r = r0.trim();
    if (/^```/.test(r)) { inCode = !inCode; continue; }
    if (inCode || !r) continue;
    if (/^(#|\||---|LET OP: tussenstand|🤖 Agentrapport|\[Pod:|\[Systeem)/.test(r)) continue;
    let z = schoon(r.replace(/^\s*[-•]\s+/, '').replace(/^\s*wv\d+(\s+is)?\s*[:.]?\s*(klaar|af)\b[.:!—–-]*\s*/i, ''), 400);
    if (z.length < 3) continue;
    const zin = /^(.+?[.!?])(\s|$)/.exec(z);
    if (zin && zin[1].length >= 20) z = zin[1];
    z = schoon(z);
    if (z.length >= 3) return { zin: z, regel: false };
  }
  return null;
}

// ── 3C102: wat David vroeg ──
const DAVID_BRON = /^\s*David\b/i;
// "David app 21-11 13:24 (Onderweg native)", "David 21-11 13:21: besluitenpagina nr 136", "David app-knop 21-11 13:42 (28648686)"
const BRON_KOP = /^\s*David\b(?:\s+(?:app(?:-knop)?|telegram|debug|chat|machinekamer|engineer))?\s*(?:op\s+)?(\d{1,2}-\d{1,2}(?:-\d{4})?)?\s*(\d{1,2}[:.]\d{2}(?:\s*[/+]\s*\d{1,2}[:.]\d{2})?)?\s*[:,—–-]?\s*/i;
const BESLUIT_RE = /besluit(?:enpagina)?\s*(?:nr\.?\s*)?(\d{1,5}(?:\s*(?:[,/]|en)\s*\d{1,5})*)/i;

function besluitNrs(t) {
  const m = BESLUIT_RE.exec(String(t || ''));
  if (!m) return [];
  return m[1].split(/[^\d]+/).map(Number).filter(function (n) { return Number.isInteger(n) && n > 0; })
    .filter(function (n, i, l) { return l.indexOf(n) === i; }).sort(function (a, b) { return a - b; });
}
function bronKern(bron) {
  return String(bron || '').split(/\s\+\s/)[0].trim();
}
// Sleutel voor "zelfde opdracht": null = geen bron van David (dan alleen de ouderketen)
function bronSleutel(bron) {
  const k = bronKern(bron);
  const nrs = besluitNrs(k);
  if (nrs.length) return 'b:' + nrs.join(',');   // ook "besluitenpagina nr 136 (21-11-2026)" zonder David vooraan
  if (!DAVID_BRON.test(k) || /bron niet opgegeven/i.test(k)) return null;
  return 't:' + k.toLowerCase().replace(/\s+/g, ' ');
}
function bronMoment(bron) {
  const m = BRON_KOP.exec(bronKern(bron));
  return m && (m[1] || m[2]) ? [m[1], m[2]].filter(Boolean).join(' ').replace(/\s*([/+])\s*/g, '$1') : null;
}
function bronWoorden(bron) {
  const k = bronKern(bron);
  const m = BRON_KOP.exec(k);
  let rest = m ? k.slice(m[0].length) : k.replace(DAVID_BRON, '');
  rest = rest.replace(/^\((.*)\)$/, '$1').trim();
  if (!rest || /^\(?\d{6,}\)?$/.test(rest) || BESLUIT_RE.test(rest) || /bron niet opgegeven/i.test(rest)) return null;
  return schoon(rest, 200);
}

function rijStand(w) {
  const s = String(w.status || '');
  if (s === 'geblokkeerd') return /^\s*david/i.test(String(w.geblokkeerd_door || '')) ? 'wacht_op_jou' : 'in_de_rij';
  if (s === 'gestart' || s === 'starten') return 'loopt';
  if (s === 'open') return 'in_de_rij';
  if (s === 'klaar') return 'af';
  if (s === 'mislukt') return 'mislukt';
  if (s === 'vervallen') return 'vervallen';
  return 'in_de_rij';
}
const STAND_VOLGORDE = ['wacht_op_jou', 'mislukt', 'loopt', 'in_de_rij', 'af'];

// items: werkvoorraadrijen (mk_werkvoorraad_stand). o.uitkomstVan(job_id) -> {zin, regel}|null; o.rapportVan(job_id) -> bool;
// o.besluitVraag(nr) -> string|null; o.max (standaard 40). Geeft de opdrachten, nieuwste eerst.
function gevraagd(items, o) {
  o = o || {};
  const rijen = (Array.isArray(items) ? items : []).filter(function (w) { return w && Number.isSafeInteger(Number(w.id)); });
  const perId = {};
  rijen.forEach(function (w) { perId[String(w.id)] = w; });
  // Union-find over ouderketen en bronsleutel
  const ouder = {};
  const vind = function (x) { while (ouder[x] !== x) { ouder[x] = ouder[ouder[x]]; x = ouder[x]; } return x; };
  const een = function (a, b) { const ra = vind(a), rb = vind(b); if (ra !== rb) ouder[Math.max(ra, rb)] = Math.min(ra, rb); };
  rijen.forEach(function (w) { ouder[Number(w.id)] = Number(w.id); });
  const perSleutel = {};
  rijen.forEach(function (w) {
    const id = Number(w.id);
    if (w.ouder_id != null && perId[String(w.ouder_id)]) een(id, Number(w.ouder_id));
    const s = bronSleutel(w.bron);
    if (s) { if (perSleutel[s] != null) een(id, perSleutel[s]); else perSleutel[s] = id; }
  });
  const groepen = {};
  rijen.forEach(function (w) { const r = vind(Number(w.id)); (groepen[r] = groepen[r] || []).push(w); });
  const uit = [];
  Object.keys(groepen).forEach(function (r) {
    const g = groepen[r].slice().sort(function (a, b) { return Number(a.id) - Number(b.id); });
    // Alleen opdrachten van David: minstens één rij met herkomst david of een bron die met David begint
    const vanDavid = g.filter(function (w) {
      const b = String(w.bron || '');
      if (DAVID_BRON.test(b) || besluitNrs(bronKern(b)).length) return true;
      // herkomst david zonder Davids bron: wel een eigen klus van hem, maar geen bundelronde of nacontrole (die zette de machinekamer)
      return w.herkomst === 'david' && w.soort !== 'nacontrole' && !/bundelronde/i.test(b);
    });
    if (!vanDavid.length) return;
    const wortel = vanDavid[0];
    const levend = g.filter(function (w) { return w.status !== 'vervallen'; });
    if (!levend.length) return;
    const standen = levend.map(rijStand);
    const stand = STAND_VOLGORDE.filter(function (s) { return standen.indexOf(s) >= 0; })[0] || 'in_de_rij';
    const af = standen.filter(function (s) { return s === 'af'; }).length;
    let woorden = null, besluit = null;
    const nrs = besluitNrs(bronKern(wortel.bron));
    if (nrs.length && typeof o.besluitVraag === 'function') {
      const v = o.besluitVraag(nrs[0]);
      if (v) { woorden = schoon(v, 200); besluit = nrs; }
    }
    if (!woorden) woorden = bronWoorden(wortel.bron);
    const titel = schoon(wortel.samenvatting || String(wortel.label || '').replace(/^\s*machinekamer\s*:\s*/i, '').replace(/[-_]+/g, ' '), 200);
    const klussen = g.map(function (w) {
      const u = w.job_id && w.status === 'klaar' && typeof o.uitkomstVan === 'function' ? o.uitkomstVan(w.job_id) : null;
      return { wv: Number(w.id), titel: schoon(w.samenvatting || String(w.label || '').replace(/^\s*machinekamer\s*:\s*/i, '').replace(/[-_]+/g, ' '), 200),
        stand: rijStand(w), nacontrole: w.soort === 'nacontrole', job_id: w.job_id || null,
        rapport: !!(w.job_id && typeof o.rapportVan === 'function' && o.rapportVan(w.job_id)),
        uitkomst: u ? u.zin : null, klaar_op: w.klaar_op || null };
    });
    // Uitkomst van de opdracht: die van de nieuwste afgeronde bouwklus (nacontroles veranderen niets), anders van de nieuwste afgeronde
    const klaar = klussen.filter(function (k) { return k.stand === 'af' && k.uitkomst; })
      .sort(function (a, b) { return String(b.klaar_op || '').localeCompare(String(a.klaar_op || '')); });
    const beste = klaar.filter(function (k) { return !k.nacontrole; })[0] || klaar[0] || null;
    const op = g.map(function (w) { return String(w.aangemaakt || ''); }).filter(Boolean).sort()[0] || null;
    const laatst = g.map(function (w) { return String(w.klaar_op || w.bijgewerkt || w.aangemaakt || ''); }).filter(Boolean).sort().reverse()[0] || null;
    uit.push({ sleutel: 'wv' + wortel.id, woorden: woorden, titel: titel, besluit: besluit, moment: bronMoment(wortel.bron), op: op, laatst: laatst,
      stand: stand, af: af, totaal: levend.length, uitkomst: beste ? beste.uitkomst : null, klussen: klussen });
  });
  uit.sort(function (a, b) { return String(b.op || '').localeCompare(String(a.op || '')); });
  return uit.slice(0, o.max || 80);
}

module.exports = { uitkomstUitRapport, gevraagd, bronSleutel, bronWoorden, bronMoment, besluitNrs, rijStand, schoon };
