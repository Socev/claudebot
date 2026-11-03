'use strict';
// TokenCounter (wv1742, 28-10-2026; vervolg wv1247). David 24-10: "Een App die per onderdeel weergeeft waar verbruik in gaat zitten.
// Welke routines, welke agents, welke gewoontes, welke chats". De meting zelf is de tokenboekhouding (mk-scripts/tokens/
// verzamel-claude.mjs + rapport.mjs, n8n AI - Tokenboekhouding 06:20): 00_Systeem/Tokens/samenvatting.json en
// 00_Systeem/Tokens/klussen/<datum>-pod.jsonl. Deze module is de logica-laag (ontwerplijnen § 4.4): lezen via vault-veilig (geen
// symlink volgen), alleen velden uit een vaste lijst doorgeven, groeperen en optellen; de app toont alleen wat hier uitkomt.
// Nooit doorgegeven: titels van klussen (gesprekken hebben er bewust geen; bij machinewerk is het de opdrachttekst), sessie-id's.
// Vaste plek: geen kluslabels en geen onderdeelnamen van gesprekken (een label noemt soms een persoon of een zaak), wel soort, wv,
// bedragen en signalen. Geen netwerk en geen sleutels in dit bestand; de tank komt van server.js (RPC mk_app_verbruik).
const fs = require('fs');
const path = require('path');

const SAM_MAX = 2 * 1024 * 1024, KLUS_MAX = 1024 * 1024;   // gemeten 28-10: samenvatting 27 kB, grootste klussendag ± 100 kB
const REGELS_MAX = 2000;   // klussen per dagbestand die we lezen (gemeten maximum 231; Opus-review #2)
const BUF_MS = 60 * 1000;
const DAG_MAX = 300, SOORTEN_MAX = 50, DAGEN_MAX = 120, MAPNAMEN_MAX = 5000;   // klussen per dag in het antwoord (gemeten 28-10: hooguit 172)
const DATUM = /^\d{4}-\d{2}-\d{2}$/;
const KLUS_BESTAND = /^(\d{4}-\d{2}-\d{2})-pod\.jsonl$/;

// Vaste groepen voor de gestapelde dagstaven: vier vaste kleuren + overig (dataviz: kleur volgt de soort, nooit de rang)
const GROEPEN = [
  { id: 'agents', naam: 'Agents (machinekamer)', soorten: ['werkvoorraad-agent'] },
  { id: 'routines', naam: 'Routines (n8n)', soorten: ['routine'] },
  { id: 'gesprek-mk', naam: 'Gesprekken machinekamer', soorten: ['gesprek-machinekamer'] },
  { id: 'gesprek-hoofd', naam: 'Gesprekken hoofdkanaal', soorten: ['gesprek-hoofd'] },
  { id: 'managers', naam: 'Managers', soorten: ['manager'] },
  { id: 'overig', naam: 'Overig', soorten: null },   // cijfer-meester, socev-agent, proef, oud
];
function groepVan(soort) {
  const g = GROEPEN.find(function (x) { return x.soorten && x.soorten.indexOf(soort) >= 0; });
  return g ? g.id : 'overig';
}
const SOORT_NAAM = {
  'werkvoorraad-agent': 'Agents (machinekamer)', 'socev-agent': 'Agents van Socev', routine: 'Routines (n8n)', manager: 'Managers',
  'gesprek-hoofd': 'Gesprekken hoofdkanaal', 'gesprek-machinekamer': 'Gesprekken machinekamer', 'cijfer-meester': 'Cijfer-Meester',
  proef: 'Proefsessies',
};
const SIGNAAL_UITLEG = {
  'eindcontext > 300k': 'De klus las aan het eind meer dan 300.000 tokens per beurt: lang doorgewerkt in één sessie.',
  'duur > 120 min': 'De klus liep langer dan twee uur (gesprekken tellen niet mee).',
  'afgebroken op de bovengrens': 'De agent werd op zijn tijd- of tokengrens afgebroken; het werk tot dan is betaald.',
  'nacontrole los op Opus': 'Een nameting draaide los op Opus in plaats van gebundeld op Sonnet.',
};
const SIGNAAL_VOLGORDE = ['eindcontext > 300k', 'duur > 120 min', 'afgebroken op de bovengrens', 'nacontrole los op Opus'];

function getal(v) { const n = Number(v); return v == null || v === '' || !isFinite(n) ? null : n; }
function rond(n, d) { if (n == null) return null; const f = Math.pow(10, d == null ? 2 : d); return Math.round(n * f) / f; }
function tekst(v, max) { return v == null ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max || 80); }
function wvVan(v) { const s = String(v || ''); return /^wv\d{1,6}$/.test(s) ? s : null; }
function soortVan(v) { const s = String(v || ''); return /^[\p{L}\p{N} ().-]{1,40}$/u.test(s) ? s : 'onbekend'; }
const heeft = function (o, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k); };
function signalenVan(l) { return (Array.isArray(l) ? l : []).filter(function (s) { return heeft(SIGNAAL_UITLEG, s); }).slice(0, 4); }
function soortNaam(soort) { return heeft(SOORT_NAAM, soort) ? SOORT_NAAM[soort] : soort; }
// Vrije tekst uit het bestand alleen in een smalle vorm (Opus-review #5: geen eigen zinnen van een vervangen bestand in de app)
function onderdeelVan(v) { const s = String(v == null ? '' : v); return /^[\p{L}\p{N} ()._:-]{1,60}$/u.test(s) ? s : null; }
function modelVan(v) { const s = String(v == null ? '' : v); return /^[a-z0-9.-]{1,40}$/i.test(s) ? s : null; }
// Kluslabel: alleen het deel na "machinekamer:" (dat is wat de bouwer koos); het woord zelf is ruis in de lijst
// wv2335 (idee 17c): naam van een routine of domein ("Agents: OVIS / SB2", "Routine: heartbeat"); smal, nooit een kluslabel
// (die beginnen met "machinekamer:" of "wv") en nooit vrije tekst.
function routineNaamVan(v) {
  const s = String(v == null ? '' : v);
  return /^[\p{L}\p{N} ()/._:&-]{1,60}$/u.test(s) && !/machinekamer:|\bwv\d/i.test(s) ? s : null;
}
const ROUTINES_MAX = 40, SEINTJES_MAX = 10, ONDERDELEN_MAX = 512 * 1024, SKILLS_MAX = 500;
// Review wv2335 MOET 2: alleen namen uit een gesloten register (de regex alleen liet "Routine: <vrije tekst>" door). Register = de vaste
// soortnamen + "Agents: <domein>" uit domeinen in onderdelen.json + "Routine:/Manager: <onderdeel>" voor elk onderdeel in onderdelen.json
// en elke skillmap (de tokenmeting kent precies die bronnen). De rest telt mee in één post zonder naam.
const VASTE_ROUTINES = ['Gesprekken machinekamer', 'Gesprekken hoofdkanaal', 'Agents van Socev', 'Cijfer-Meester', 'Proefsessies', 'Bouw op de pc (archief)',
  'werkvoorraad-agent', 'socev-agent', 'routine', 'manager', 'gesprek-hoofd', 'gesprek-machinekamer', 'cijfer-meester', 'proef', 'onbekend'];
const ONBEKEND_NAAM = 'Overige posten (naam niet getoond)';
function labelVan(v) { const s = typeof v === 'string' ? tekst(v, 120) : null; return s ? s.replace(/^machinekamer:\s*/, '').trim() || null : null; }

function maak(opt) {
  const vault = opt.vault, VV = opt.vv;
  const map = path.join(vault, '00_Systeem', 'Tokens');
  const klussenMap = path.join(map, 'klussen');
  if (!VV || typeof VV.lees !== 'function') throw new Error('tokenteller: vault-veilig ontbreekt');
  // Leest een json(l)-bestand uit de Tokens-map via vault-veilig; null als het er niet is. Te groot = fout (geen inlezen).
  // De grens telt op de geopende descriptor in vault-veilig (Opus-review #1); de lstat hier is alleen "er niet" of "geen bestand".
  function leesBestand(p, max) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (!st.isFile()) throw new Error('geen gewoon bestand');
    return VV.lees(p, 'utf8', { max: max });
  }
  let buf = null;   // { t, mtime, j }
  function samenvatting() {
    const p = path.join(map, 'samenvatting.json');
    let m = null;
    try { m = fs.lstatSync(p).mtimeMs; } catch (e) { m = null; }
    if (buf && buf.mtime === m && Date.now() - buf.t < BUF_MS) return buf.j;
    const t = leesBestand(p, SAM_MAX);
    const j = t == null ? null : JSON.parse(t);
    buf = { t: Date.now(), mtime: m, j: j };
    return j;
  }
  let dagenBuf = null;   // { t, l }: de map lezen hooguit eens per minuut, en hooguit MAPNAMEN_MAX namen (Opus-review #6)
  function dagenMetKlussen() {
    if (dagenBuf && Date.now() - dagenBuf.t < BUF_MS) return dagenBuf.l;
    const namen = [];
    let d = null;
    try {
      const st = fs.lstatSync(klussenMap);
      if (st.isDirectory()) {
        d = fs.opendirSync(klussenMap);
        for (let e = d.readSync(); e && namen.length < MAPNAMEN_MAX; e = d.readSync()) namen.push(e.name);
      }
    } catch (e) { /* geen map: geen dagen */ }
    finally { if (d) { try { d.closeSync(); } catch (e) { /* al dicht */ } } }
    const l = namen.map(function (n) { const m = KLUS_BESTAND.exec(n); return m ? m[1] : null; }).filter(Boolean).sort().reverse().slice(0, DAGEN_MAX);
    dagenBuf = { t: Date.now(), l: l };
    return l;
  }
  let regBuf = null;   // { t, set }
  function routineRegister() {
    if (regBuf && Date.now() - regBuf.t < BUF_MS) return regBuf.set;
    const set = new Set(VASTE_ROUTINES);
    const ond = new Set(['onbekend']);
    try {
      const t = leesBestand(path.join(map, 'onderdelen.json'), ONDERDELEN_MAX);
      const o = t == null ? null : JSON.parse(t);
      const loop = function (x, diepte) {
        if (!x || typeof x !== 'object' || diepte > 6) return;
        if (Array.isArray(x)) { x.slice(0, 2000).forEach(function (v) { loop(v, diepte + 1); }); return; }
        Object.keys(x).slice(0, 2000).forEach(function (k) {
          if (k === 'onderdeel' && typeof x[k] === 'string') { const n = onderdeelVan(x[k]); if (n) ond.add(n); }
          else loop(x[k], diepte + 1);
        });
      };
      if (o) loop(o, 0);
      const dom = o && o.domeinen && typeof o.domeinen === 'object' ? o.domeinen : null;
      if (dom && Array.isArray(dom.volgorde)) dom.volgorde.slice(0, 100).forEach(function (d) { const n = routineNaamVan(d && d.naam); if (n) set.add('Agents: ' + n); });
      set.add('Agents: ' + (dom && routineNaamVan(dom.overig) ? dom.overig : 'Overig'));
    } catch (e) { /* geen of onleesbaar register: alleen de vaste namen */ }
    let d = null;
    try {
      d = fs.opendirSync(path.join(vault, '.claude', 'skills'));
      for (let e = d.readSync(), i = 0; e && i < SKILLS_MAX; e = d.readSync(), i++) if (/^[a-z0-9-]{1,60}$/.test(e.name)) ond.add(e.name);
    } catch (e) { /* geen skillmap */ }
    finally { if (d) { try { d.closeSync(); } catch (e) { /* al dicht */ } } }
    ond.forEach(function (n) { set.add('Routine: ' + n); set.add('Manager: ' + n); });
    regBuf = { t: Date.now(), set: set };
    return set;
  }
  const koers = function (s) { const k = getal(s && s.dollars_per_euro); return k && k > 0.5 && k < 3 ? k : null; };

  function klusUit(k, vast, dpe) {
    const usd = getal(k.usd);
    const eur = getal(k.eur) != null ? getal(k.eur) : (usd != null && dpe ? usd / dpe : null);
    const soort = soortVan(k.soort);
    const gesprek = /^gesprek-/.test(soort);
    return {
      datum: DATUM.test(String(k.datum || '')) ? String(k.datum) : null,
      soort: soort, soort_naam: soortNaam(soort), groep: groepVan(soort),
      onderdeel: vast && gesprek ? null : onderdeelVan(k.onderdeel),
      wv: wvVan(k.wv), label: vast || gesprek ? null : labelVan(k.klus_label),
      model: modelVan(k.model), account: k.account === 1 || k.account === 2 ? k.account : null,
      begin: typeof k.begin === 'string' && !isNaN(Date.parse(k.begin)) ? new Date(k.begin).toISOString() : null,
      duur_min: getal(k.duur_min), calls: getal(k.calls), startcontext: getal(k.startcontext), eindcontext: getal(k.eindcontext),
      tokens: getal(k.tokens) != null ? getal(k.tokens) : getal(k.totaal_invoer) != null ? getal(k.totaal_invoer) + (getal(k.uitvoer) || 0) : null,
      usd: rond(usd, 2), eur: rond(eur, 2), eur_ruw: eur, afgebroken: k.afgebroken === true, signalen: signalenVan(k.signalen),
    };
  }

  // Het overzicht: per soort, per dag (gestapeld in vaste groepen), top 10 duurste klussen, gewoontesignalen.
  function stand(o) {
    const vast = !!(o && o.vast);
    let s;
    try { s = samenvatting(); }
    catch (e) { return { ok: true, leeg: true, fout: 'De tokenboekhouding is nu niet te lezen.', tank: o && o.tank ? o.tank : null }; }
    if (!s) return { ok: true, leeg: true, fout: 'Er is nog geen tokenboekhouding.', tank: o && o.tank ? o.tank : null };
    const dpe = koers(s);
    const tot = s.totaal || {};
    const totEur = getal(tot.eur);
    const soorten = (Array.isArray(s.per_soort) ? s.per_soort : []).slice(0, SOORTEN_MAX).map(function (r) {
      const soort = soortVan(r && r.soort), eur = getal(r && r.eur);
      return { soort: soort, naam: soortNaam(soort), groep: groepVan(soort), eur: rond(eur, 2), usd: rond(getal(r.usd), 2),
        tokens: getal(r.tokens), calls: getal(r.calls), aandeel: totEur && eur != null ? rond(eur / totEur, 4) : null };
    }).sort(function (a, b) { return (b.eur || 0) - (a.eur || 0); });
    // Agents van Socev: sinds wv1803 leest de meting de sessies van de socev-gebruiker via de loper (socev_gemeten in de samenvatting).
    // Zonder die vlag (oudere samenvatting, loper nooit bereikt) blijven ze "niet gemeten", nooit 0; met de vlag en zonder rij was het 0.
    const socevGemeten = s.socev_gemeten === true;
    if (!socevGemeten && !soorten.some(function (r) { return r.soort === 'socev-agent'; }))
      soorten.push({ soort: 'socev-agent', naam: SOORT_NAAM['socev-agent'], groep: 'overig', eur: null, usd: null, tokens: null, calls: null, aandeel: null, niet_gemeten: true });
    const perDag = (Array.isArray(s.per_dag_soort) ? s.per_dag_soort : []).slice(0, DAGEN_MAX).filter(function (r) { return r && DATUM.test(String(r.datum)); }).map(function (r) {
      const delen = {};
      GROEPEN.forEach(function (g) { delen[g.id] = 0; });
      const rs = r.soorten && typeof r.soorten === 'object' ? r.soorten : {};
      Object.keys(rs).slice(0, SOORTEN_MAX).forEach(function (k) { const v = getal(rs[k]); if (v != null) delen[groepVan(k)] += v; });
      let som = 0;
      Object.keys(delen).forEach(function (k) { delen[k] = rond(delen[k], 2); som += delen[k]; });
      return { datum: String(r.datum), eur: rond(som, 2), delen: delen };
    }).sort(function (a, b) { return a.datum < b.datum ? -1 : 1; });
    const duurste = (Array.isArray(s.duurste_klussen) ? s.duurste_klussen : []).slice(0, 10).filter(function (k) { return k && typeof k === 'object'; })
      .map(function (k) { const x = klusUit(k, vast, dpe); delete x.eur_ruw; return x; });
    const sig = s.signalen || {};
    const signalen = SIGNAAL_VOLGORDE.map(function (n) {
      const r = heeft(sig, n) && sig[n] ? sig[n] : {};
      return { naam: n, uitleg: SIGNAAL_UITLEG[n], klussen: getal(r.klussen) || 0, eur: rond(getal(r.eur) || 0, 2),
        aandeel: totEur && getal(r.eur) != null ? rond(getal(r.eur) / totEur, 4) : null };
    });
    const per = s.periode || {};
    // wv2335 (idee 17c): verbruik per routine (domein bij agents, onderdeel bij vaste routines), 30 en 7 dagen
    const routines = (function () {
      const pr = s.per_routine && typeof s.per_routine === 'object' ? s.per_routine : null;
      const v30 = pr && pr.venster_30d && typeof pr.venster_30d === 'object' ? pr.venster_30d : null;
      if (!v30 || !Array.isArray(v30.routines)) return null;
      const v7 = pr.venster_7d && Array.isArray(pr.venster_7d.routines) ? pr.venster_7d : null;
      const reg = routineRegister();
      const bekend = function (v) { const n = routineNaamVan(v); return n && reg.has(n) ? n : null; };
      const zeven = Object.create(null);
      let zevenOnbekend = 0, zevenOnbekendHeeft = false;
      if (v7) v7.routines.slice(0, 200).forEach(function (r) {
        const n = bekend(r && r.routine);
        if (n) zeven[n] = r; else { const e = getal(r && r.eur) != null ? getal(r.eur) : (getal(r && r.usd) != null && dpe ? getal(r.usd) / dpe : null); if (e != null) { zevenOnbekend += e; zevenOnbekendHeeft = true; } }
      });
      const eurVan = function (r) { const e = getal(r && r.eur); return e != null ? e : (getal(r && r.usd) != null && dpe ? getal(r.usd) / dpe : null); };
      const tot30 = getal(v30.totaal_eur) != null ? getal(v30.totaal_eur) : (getal(v30.totaal_usd) != null && dpe ? getal(v30.totaal_usd) / dpe : null);
      const tot7 = v7 ? (getal(v7.totaal_eur) != null ? getal(v7.totaal_eur) : (getal(v7.totaal_usd) != null && dpe ? getal(v7.totaal_usd) / dpe : null)) : null;
      const onb = { naam: ONBEKEND_NAAM, soort: 'onbekend', groep: 'overig', klussen: 0, eur: 0, heeft: false };
      const alle = v30.routines.slice(0, 200).map(function (r) {
        const naam = bekend(r && r.routine);
        if (!naam) { const e = eurVan(r); if (e != null) { onb.eur += e; onb.heeft = true; } onb.klussen += getal(r && r.klussen) || 0; return null; }
        const soort = soortVan(r.soort), eur = eurVan(r), z = zeven[naam];
        const eur7 = z ? eurVan(z) : (v7 ? 0 : null);
        return { naam: naam, soort: soort, groep: groepVan(soort), klussen: getal(r.klussen), eur: rond(eur, 2),
          aandeel: tot30 && eur != null ? rond(eur / tot30, 4) : null,
          eur_7d: rond(eur7, 2), aandeel_7d: tot7 && eur7 != null ? rond(eur7 / tot7, 4) : null };
      }).filter(Boolean);
      if (onb.heeft || zevenOnbekendHeeft) {
        const e7 = zevenOnbekendHeeft ? zevenOnbekend : (v7 ? 0 : null);
        alle.push({ naam: onb.naam, soort: onb.soort, groep: onb.groep, klussen: onb.klussen, eur: rond(onb.eur, 2), aandeel: tot30 ? rond(onb.eur / tot30, 4) : null,
          eur_7d: rond(e7, 2), aandeel_7d: tot7 && e7 != null ? rond(e7 / tot7, 4) : null, onbekend: true });
      }
      alle.sort(function (a, b) { return (b.eur || 0) - (a.eur || 0); });
      const lijst = alle.slice(0, ROUTINES_MAX);
      if (alle.length > ROUTINES_MAX) {
        const rest = alle.slice(ROUTINES_MAX);
        const eur = rest.reduce(function (a, r) { return a + (r.eur || 0); }, 0);
        lijst.push({ naam: rest.length + ' kleinere routines', soort: 'rest', groep: 'overig', klussen: rest.reduce(function (a, r) { return a + (r.klussen || 0); }, 0),
          eur: rond(eur, 2), aandeel: tot30 ? rond(eur / tot30, 4) : null, eur_7d: null, aandeel_7d: null, rest: true });
      }
      const rs = s.routine_seintjes && typeof s.routine_seintjes === 'object' ? s.routine_seintjes : {};
      const week = rs.week && typeof rs.week === 'object' && DATUM.test(String(rs.week.van)) && DATUM.test(String(rs.week.tot)) ? { van: rs.week.van, tot: rs.week.tot } : null;
      const seintjes = (Array.isArray(rs.lijst) ? rs.lijst : []).slice(0, SEINTJES_MAX).map(function (x) {
        const naam = bekend(x && x.routine);
        if (!naam) return null;
        const w = getal(x.week_usd), m = getal(x.mediaan_usd);
        return { naam: naam, week_eur: w != null && dpe ? rond(w / dpe, 2) : null, mediaan_eur: m != null && dpe ? rond(m / dpe, 2) : null, factor: rond(getal(x.factor), 1) };
      }).filter(Boolean);
      return {
        van: DATUM.test(String(v30.van)) ? v30.van : null, tot: DATUM.test(String(v30.tot)) ? v30.tot : null,
        van_7d: v7 && DATUM.test(String(v7.van)) ? v7.van : null,
        begin_kluslabels: DATUM.test(String(v30.begin_kluslabels)) ? v30.begin_kluslabels : null,
        totaal_eur: rond(tot30, 2), totaal_7d_eur: rond(tot7, 2), lijst: lijst, seintjes: seintjes, seintje_week: week,
      };
    })();
    return {
      ok: true, vaste_plek: vast,
      gemeten_op: typeof s.gegenereerd_op === 'string' && !isNaN(Date.parse(s.gegenereerd_op)) ? new Date(s.gegenereerd_op).toISOString() : null,
      periode: { van: DATUM.test(String(per.van)) ? per.van : null, tot: DATUM.test(String(per.tot)) ? per.tot : null, dagen: getal(per.dagen) },
      dollars_per_euro: dpe,
      totaal: { eur: rond(totEur, 2), usd: rond(getal(tot.usd), 2), tokens: getal(tot.totaal_invoer) != null ? getal(tot.totaal_invoer) + (getal(tot.uitvoer) || 0) : null, calls: getal(tot.calls) },
      groepen: GROEPEN.map(function (g) { return { id: g.id, naam: g.naam }; }),
      soorten: soorten, per_dag: perDag, duurste: duurste, signalen: signalen, routines: routines,
      dagen: dagenMetKlussen(), tank: o && o.tank ? o.tank : null,
      bron: 'tokenboekhouding', niet_gemeten: (socevGemeten ? [] : ['Agents en andere runs van Socev zelf (zijn sessiemap is voor de meting niet leesbaar)'])
        .concat(['Cowork-cloudsessies, modelaanroepen vanuit n8n en lokale modellen op Olares']),
    };
  }

  // De klussen van één dag, duurste eerst, met een optelling per soort. null = ongeldige datum.
  function dag(datum, o) {
    const vast = !!(o && o.vast);
    if (!DATUM.test(String(datum || ''))) return null;
    let dpe = null;
    try { dpe = koers(samenvatting()); } catch (e) { dpe = null; }
    let t;
    try { t = leesBestand(path.join(klussenMap, datum + '-pod.jsonl'), KLUS_MAX); }
    catch (e) { return { ok: true, datum: datum, fout: 'De klussen van deze dag zijn nu niet te lezen.', klussen: [], soorten: [], aantal: 0 }; }
    if (t == null) return { ok: true, datum: datum, leeg: true, klussen: [], soorten: [], aantal: 0 };
    const alle = [];
    let kapot = 0, regels = 0, teVeel = 0;
    String(t).split('\n').forEach(function (r) {
      if (!r.trim()) return;
      if (++regels > REGELS_MAX) { teVeel++; return; }
      try { const j = JSON.parse(r); if (j && typeof j === 'object' && !Array.isArray(j)) alle.push(klusUit(j, vast, dpe)); else kapot++; } catch (e) { kapot++; }
    });
    // duurste eerst op dezelfde maat als de optelling (euro; zonder koers de dollar), ongerond opgeteld (Opus-review #8)
    const maat = function (k) { return k.eur_ruw != null ? k.eur_ruw : (k.usd || 0); };
    alle.sort(function (a, b) { return maat(b) - maat(a); });
    const per = Object.create(null);   // Opus-review #3: een soort als "constructor" raakt het prototype niet
    let eurSom = 0, eurOnbekend = false;
    alle.forEach(function (k) {
      const p = per[k.soort] || (per[k.soort] = { soort: k.soort, naam: k.soort_naam, groep: k.groep, klussen: 0, eur: 0, usd: 0 });
      p.klussen++; p.usd += k.usd || 0;
      if (k.eur_ruw == null) { if (k.usd) eurOnbekend = true; } else { p.eur += k.eur_ruw; eurSom += k.eur_ruw; }
    });
    // zonder koers geen euro's verzinnen (Opus-review #7): eur null, de dollar staat er wel
    const soorten = Object.keys(per).map(function (k) { const p = per[k]; p.eur = eurOnbekend ? null : rond(p.eur, 2); p.usd = rond(p.usd, 2); return p; })
      .sort(function (a, b) { return eurOnbekend ? b.usd - a.usd : b.eur - a.eur; });
    alle.forEach(function (k) { delete k.eur_ruw; });
    return { ok: true, datum: datum, vaste_plek: vast, aantal: alle.length + teVeel, kapot: kapot, te_veel_regels: teVeel,
      eur: eurOnbekend ? null : rond(eurSom, 2),
      soorten: soorten, klussen: alle.slice(0, DAG_MAX), afgekapt: alle.length > DAG_MAX ? alle.length - DAG_MAX : 0, bron: 'tokenboekhouding' };
  }
  return { stand: stand, dag: dag };
}

// Tank van beide abonnementen uit mk_app_verbruik (zelfde bron als Verbruik & modellen); alleen getallen en tijden.
function tankUit(t) {
  if (!t) return null;
  const een = function (l) {
    if (!l) return null;
    const tijd = function (v) { return typeof v === 'string' && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : null; };
    return { gemeten_op: tijd(l.gemeten_op), minuten_oud: getal(l.minuten_oud), vijf_uur: getal(l.vijf_uur), zeven_dagen: getal(l.zeven_dagen),
      vijf_uur_reset: tijd(l.vijf_uur_reset), zeven_dagen_reset: tijd(l.zeven_dagen_reset), status: tekst(l.status, 30) };
  };
  return { account1: een(t.laatste), account2: een(t.account2) };
}

module.exports = { maak: maak, tankUit: tankUit, groepVan: groepVan, GROEPEN: GROEPEN, SIGNAAL_UITLEG: SIGNAAL_UITLEG };
