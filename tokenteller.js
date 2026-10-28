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

const MAX_BYTES = 4 * 1024 * 1024;   // samenvatting ± 27 kB, een klussendag ± 100 kB: dit is ruim, maar geen geheugenbom
const BUF_MS = 60 * 1000;
const DAG_MAX = 300;   // klussen per dag in het antwoord (gemeten 28-10: hooguit 172)
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
function signalenVan(l) { return (Array.isArray(l) ? l : []).filter(function (s) { return SIGNAAL_UITLEG[s]; }); }
// Kluslabel: alleen het deel na "machinekamer:" (dat is wat de bouwer koos); het woord zelf is ruis in de lijst
function labelVan(v) { const s = tekst(v, 120); return s ? s.replace(/^machinekamer:\s*/, '').trim() || null : null; }

function maak(opt) {
  const vault = opt.vault, VV = opt.vv;
  const map = path.join(vault, '00_Systeem', 'Tokens');
  const klussenMap = path.join(map, 'klussen');
  if (!VV || typeof VV.lees !== 'function') throw new Error('tokenteller: vault-veilig ontbreekt');
  // Leest een json(l)-bestand uit de Tokens-map via vault-veilig; null als het er niet is. Te groot = fout (geen inlezen).
  function leesBestand(p) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (!st.isFile()) throw new Error('geen gewoon bestand');
    if (st.size > MAX_BYTES) throw new Error('bestand te groot');
    return VV.lees(p, 'utf8');
  }
  let buf = null;   // { t, mtime, j }
  function samenvatting() {
    const p = path.join(map, 'samenvatting.json');
    let m = null;
    try { m = fs.lstatSync(p).mtimeMs; } catch (e) { m = null; }
    if (buf && buf.mtime === m && Date.now() - buf.t < BUF_MS) return buf.j;
    const t = leesBestand(p);
    const j = t == null ? null : JSON.parse(t);
    buf = { t: Date.now(), mtime: m, j: j };
    return j;
  }
  function dagenMetKlussen() {
    let namen;
    try {
      const st = fs.lstatSync(klussenMap);
      if (!st.isDirectory()) return [];
      namen = fs.readdirSync(klussenMap);
    } catch (e) { return []; }
    return namen.map(function (n) { const m = KLUS_BESTAND.exec(n); return m ? m[1] : null; }).filter(Boolean).sort().reverse().slice(0, 120);
  }
  const koers = function (s) { const k = getal(s && s.dollars_per_euro); return k && k > 0.5 && k < 3 ? k : null; };

  function klusUit(k, vast, dpe) {
    const usd = getal(k.usd);
    const eur = getal(k.eur) != null ? getal(k.eur) : (usd != null && dpe ? usd / dpe : null);
    const soort = soortVan(k.soort);
    const gesprek = /^gesprek-/.test(soort);
    return {
      datum: DATUM.test(String(k.datum || '')) ? String(k.datum) : null,
      soort: soort, soort_naam: SOORT_NAAM[soort] || soort, groep: groepVan(soort),
      onderdeel: vast && gesprek ? null : tekst(k.onderdeel, 60),
      wv: wvVan(k.wv), label: vast || gesprek ? null : labelVan(k.klus_label),
      model: tekst(k.model, 40), account: k.account === 1 || k.account === 2 ? k.account : null,
      begin: typeof k.begin === 'string' && !isNaN(Date.parse(k.begin)) ? new Date(k.begin).toISOString() : null,
      duur_min: getal(k.duur_min), calls: getal(k.calls), startcontext: getal(k.startcontext), eindcontext: getal(k.eindcontext),
      tokens: getal(k.tokens) != null ? getal(k.tokens) : getal(k.totaal_invoer) != null ? getal(k.totaal_invoer) + (getal(k.uitvoer) || 0) : null,
      usd: rond(usd, 2), eur: rond(eur, 2), afgebroken: k.afgebroken === true, signalen: signalenVan(k.signalen),
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
    const soorten = (Array.isArray(s.per_soort) ? s.per_soort : []).map(function (r) {
      const soort = soortVan(r.soort), eur = getal(r.eur);
      return { soort: soort, naam: SOORT_NAAM[soort] || tekst(r.naam, 60) || soort, groep: groepVan(soort), eur: rond(eur, 2), usd: rond(getal(r.usd), 2),
        tokens: getal(r.tokens), calls: getal(r.calls), aandeel: totEur && eur != null ? rond(eur / totEur, 4) : null };
    }).sort(function (a, b) { return (b.eur || 0) - (a.eur || 0); });
    // Agents van Socev zijn niet te meten (map van de socev-gebruiker niet leesbaar): altijd tonen als "niet gemeten", nooit als 0
    if (!soorten.some(function (r) { return r.soort === 'socev-agent'; }))
      soorten.push({ soort: 'socev-agent', naam: SOORT_NAAM['socev-agent'], groep: 'overig', eur: null, usd: null, tokens: null, calls: null, aandeel: null, niet_gemeten: true });
    const perDag = (Array.isArray(s.per_dag_soort) ? s.per_dag_soort : []).filter(function (r) { return r && DATUM.test(String(r.datum)); }).map(function (r) {
      const delen = {};
      GROEPEN.forEach(function (g) { delen[g.id] = 0; });
      Object.keys(r.soorten || {}).forEach(function (k) { const v = getal(r.soorten[k]); if (v != null) delen[groepVan(k)] += v; });
      let som = 0;
      Object.keys(delen).forEach(function (k) { delen[k] = rond(delen[k], 2); som += delen[k]; });
      return { datum: String(r.datum), eur: rond(som, 2), delen: delen };
    }).sort(function (a, b) { return a.datum < b.datum ? -1 : 1; });
    const duurste = (Array.isArray(s.duurste_klussen) ? s.duurste_klussen : []).slice(0, 10).map(function (k) { return klusUit(k, vast, dpe); });
    const sig = s.signalen || {};
    const signalen = SIGNAAL_VOLGORDE.map(function (n) {
      const r = sig[n] || {};
      return { naam: n, uitleg: SIGNAAL_UITLEG[n], klussen: getal(r.klussen) || 0, eur: rond(getal(r.eur) || 0, 2),
        aandeel: totEur && getal(r.eur) != null ? rond(getal(r.eur) / totEur, 4) : null };
    });
    const per = s.periode || {};
    return {
      ok: true, vaste_plek: vast,
      gemeten_op: typeof s.gegenereerd_op === 'string' && !isNaN(Date.parse(s.gegenereerd_op)) ? new Date(s.gegenereerd_op).toISOString() : null,
      periode: { van: DATUM.test(String(per.van)) ? per.van : null, tot: DATUM.test(String(per.tot)) ? per.tot : null, dagen: getal(per.dagen) },
      dollars_per_euro: dpe,
      totaal: { eur: rond(totEur, 2), usd: rond(getal(tot.usd), 2), tokens: getal(tot.totaal_invoer) != null ? getal(tot.totaal_invoer) + (getal(tot.uitvoer) || 0) : null, calls: getal(tot.calls) },
      groepen: GROEPEN.map(function (g) { return { id: g.id, naam: g.naam }; }),
      soorten: soorten, per_dag: perDag, duurste: duurste, signalen: signalen,
      dagen: dagenMetKlussen(), tank: o && o.tank ? o.tank : null,
      bron: 'tokenboekhouding', niet_gemeten: ['Agents en andere runs van Socev zelf (zijn sessiemap is voor de meting niet leesbaar)',
        'Cowork-cloudsessies, modelaanroepen vanuit n8n en lokale modellen op Olares'],
    };
  }

  // De klussen van één dag, duurste eerst, met een optelling per soort. null = ongeldige datum.
  function dag(datum, o) {
    const vast = !!(o && o.vast);
    if (!DATUM.test(String(datum || ''))) return null;
    let dpe = null;
    try { dpe = koers(samenvatting()); } catch (e) { dpe = null; }
    let t;
    try { t = leesBestand(path.join(klussenMap, datum + '-pod.jsonl')); }
    catch (e) { return { ok: true, datum: datum, fout: 'De klussen van deze dag zijn nu niet te lezen.', klussen: [], soorten: [], aantal: 0 }; }
    if (t == null) return { ok: true, datum: datum, leeg: true, klussen: [], soorten: [], aantal: 0 };
    const alle = [];
    let kapot = 0;
    String(t).split('\n').forEach(function (r) {
      if (!r.trim()) return;
      try { const j = JSON.parse(r); if (j && typeof j === 'object') alle.push(klusUit(j, vast, dpe)); else kapot++; } catch (e) { kapot++; }
    });
    alle.sort(function (a, b) { return (b.usd || 0) - (a.usd || 0); });
    const per = {};
    alle.forEach(function (k) {
      const p = per[k.soort] || (per[k.soort] = { soort: k.soort, naam: k.soort_naam, groep: k.groep, klussen: 0, eur: 0, usd: 0 });
      p.klussen++; p.eur += k.eur || 0; p.usd += k.usd || 0;
    });
    const soorten = Object.keys(per).map(function (k) { const p = per[k]; p.eur = rond(p.eur, 2); p.usd = rond(p.usd, 2); return p; })
      .sort(function (a, b) { return b.eur - a.eur; });
    return { ok: true, datum: datum, vaste_plek: vast, aantal: alle.length, kapot: kapot,
      eur: rond(alle.reduce(function (n, k) { return n + (k.eur || 0); }, 0), 2),
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
