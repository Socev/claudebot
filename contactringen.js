'use strict';
/*
 * contactringen.js — zondags hooguit één regel in het ochtendbericht over de binnenste kring (wv2894, idee 19d meetpunt 6).
 * Ontwerp: /opt/data/mk-scripts/wv2876/ontwerp.md (Codex-review 10-11: GO-met-wijzigingen); David JA 10-11 21:41 op
 * "alleen de datum van het laatste appje, één regel per week".
 *
 * WAT. Nachtketenstap contactringen (zondag, na weer-ochtend): leest ring 1 van de vaultpagina 20_Prive/Contactringen.md
 * (huishouden en personen met `geen_signaal` uit), zoekt per persoon de nummers vers op via de contacten-webhook (exacte naam,
 * plus extra contactnamen uit het configbestand op de pod), vraagt het WhatsApp-zoekluik ALLEEN de kalenderdatum van het laatste
 * 1-op-1-bericht (datums_voor; nooit inhoud, tijd of richting) en zet bij een treffer één rij in ochtend_buffer (bron
 * 'contactringen', datum vandaag). De briefing van 07:00 neemt die mee (restcategorie "Overige bron").
 *
 * REGEL. Laatste 1-op-1-appje > 42 dagen geleden en in deze stilteperiode nog niet gemeld → "laatste 1-op-1-appje met X is N weken
 * geleden" (nooit "lang niets gehoord": het luik ziet geen gesprekken, groepen of bezoek). Plus verjaardagen (ring 1 zonder
 * huishouden en zonder geen_signaal) binnen 14 dagen, één keer per verjaardag. Geen datum gevonden = geen signaal (blind = stil).
 * Hooguit 5 per soort en 400 tekens; wat niet past wordt niet als gemeld vastgelegd en komt volgende week (review MOET 2).
 *
 * STAAT. staatPad (600): per vaultpad alleen laatst_gezien (datum), gemeld_op (datum) en jarig_jaar (jaartal van de laatst
 * gemelde verjaardag). Geen nummers, geen inhoud, geen namen buiten het vaultpad.
 *
 * FAIL-CLOSED. Ringpagina onleesbaar, contacten- of zoekluik fout of een antwoord in een andere vorm: geen regel, één box-rij
 * (#contactringen), de stap is ok (stil voor David). Nummers komen nooit in een log, box-rij, detail of het staatbestand.
 *
 * Afhankelijkheden (server.js):
 *   ringTekst()          → Promise<string>                           (vaultpagina Contactringen)
 *   contacten(q)         → Promise<{ok, treffers:[{weergavenaam, telefoons_e164, verjaardag}]}>
 *   datums(ids)          → Promise<{datums:{id:'YYYY-MM-DD'|null}}>  (zoekluik, ≤ 30 ids per aanroep)
 *   bufferZet(datum, t)  → Promise                                   (upsert ochtend_buffer bron 'contactringen', teruggelezen)
 *   boxRij(tekst)        → bool
 *   log(o)               → void
 *   staatPad, configPad  → paden op de pod (config: {"contactnamen": {"<vaultpad>": ["<contactnaam>", …]}})
 *   nu()                 → ms (toets)
 */
const fs = require('fs');
const path = require('path');

const GRENS_DAGEN = 42;          // ring 1: langer dan 6 weken (Regels op de ringpagina)
const JARIG_DAGEN = 14;
const MAX_IDS = 30;              // zoekluik weigert meer
const REGEL_MAX = 400;
const MAX_PER_SOORT = 5;         // review MOET 2: niet afkappen; wat niet past blijft voor volgende week (niet als gemeld vastgelegd)
const DAG = 86400000;

function ams(ms) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
  return { datum: p.year + '-' + p.month + '-' + p.day, uur: Number(p.hour), min: Number(p.minute) };
}
function isDatum(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(d + 'T12:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;   // ook 2026-13-01 en 2026-02-30 = geen datum (review r2 ZOU 1)
}
function dagNr(d) { return Math.round(Date.parse(d + 'T12:00:00Z') / DAG); }
function zondag(d) { return new Date(d + 'T12:00:00Z').getUTCDay() === 0; }
function norm(x) { return String(x == null ? '' : x).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function naamUitPad(p) { return String(p).split('/').pop().replace(/\s*\([^)]*\)\s*$/, '').trim(); }
const DAGEN_KORT = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];

// Ring 1 van de ringpagina: [{pad, voornaam, huishouden, geen_signaal}] of null als de vorm niet klopt (fail-closed)
function leesRing(tekst) {
  const t = String(tekst || '');
  const r1 = /^## Ring 1\b.*$/m.exec(t);
  if (!r1) return null;
  const rest = t.slice(r1.index + r1[0].length);
  const eind = /^## /m.exec(rest);
  const ring = eind ? rest.slice(0, eind.index) : rest;
  const delen = ring.split(/^### /m).slice(1);
  const uit = [];
  let overig = false;
  delen.forEach(function (d) {
    const kop = d.split('\n')[0];
    const huis = /^Huishouden\b/i.test(kop);
    if (/^Overig\b/i.test(kop)) overig = true;
    d.split('\n').slice(1).forEach(function (r) {
      const m = /^\s*[-*]\s+\[\[([^|\]]+)\|([^\]]+)\]\]/.exec(r);
      if (!m) return;
      uit.push({ pad: m[1].trim(), voornaam: m[2].trim(), huishouden: huis, geen_signaal: /\bgeen_signaal\b/.test(r) });
    });
  });
  if (!overig || !uit.some(function (p) { return !p.huishouden; })) return null;
  return uit;
}

// verjaardag uit contacten ('YYYY-MM-DD' of '--MM-DD') → eerstvolgende datum ≥ peildatum
function volgendeJarig(v, peil) {
  const m = /(\d{2})-(\d{2})$/.exec(String(v || ''));
  if (!m) return null;
  const jaar = Number(peil.slice(0, 4));
  for (let j = jaar; j <= jaar + 1; j++) {
    const d = j + '-' + m[1] + '-' + m[2];
    if (isNaN(Date.parse(d + 'T12:00:00Z')) || new Date(d + 'T12:00:00Z').getUTCMonth() + 1 !== Number(m[1])) continue;   // 29-2
    if (dagNr(d) >= dagNr(peil)) return d;
  }
  return null;
}

function regel(stil, jarig) {
  const delen = [];
  if (stil.length) {
    delen.push('laatste 1-op-1-appje met ' + stil.map(function (s, i) { return s.voornaam + (i === 0 ? ' is ' : ' ') + s.weken + ' weken' + (i === 0 ? ' geleden' : ''); }).join(', met '));
  }
  if (jarig.length) {
    delen.push('binnenkort jarig: ' + jarig.map(function (j) { return j.voornaam + ' (' + DAGEN_KORT[new Date(j.datum + 'T12:00:00Z').getUTCDay()] + ' ' + Number(j.datum.slice(8)) + '-' + Number(j.datum.slice(5, 7)) + ')'; }).join(', '));
  }
  if (!delen.length) return '';
  let t = 'Binnenste kring: ' + delen.join('; ') + '.';
  if (stil.length) t += ' Zie je iemand vaak? Zeg "zie ik vaak", dan krijgt die persoon geen seintje meer.';
  return t;
}
// kies wat in de regel past (≤ MAX_PER_SOORT per soort, ≤ REGEL_MAX tekens); alleen die worden als gemeld vastgelegd
function kies(stil, jarig) {
  let s = stil.slice(0, MAX_PER_SOORT), j = jarig.slice(0, MAX_PER_SOORT);
  while (regel(s, j).length > REGEL_MAX && (s.length || j.length)) { if (s.length >= j.length) s = s.slice(0, -1); else j = j.slice(0, -1); }
  return { stil: s, jarig: j, tekst: regel(s, j) };
}

function maak(o) {
  const nu = o.nu || Date.now;
  let laatst = null;
  function staatLees() { try { const s = JSON.parse(fs.readFileSync(o.staatPad, 'utf8')); return s && typeof s === 'object' ? s : {}; } catch (e) { return {}; } }
  function staatZet(s) {
    fs.mkdirSync(path.dirname(o.staatPad), { recursive: true, mode: 0o700 });
    const tmp = o.staatPad + '.tmp' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, o.staatPad);
  }
  function config() {
    try { const c = JSON.parse(fs.readFileSync(o.configPad, 'utf8')); return c && typeof c === 'object' ? c : {}; } catch (e) { return {}; }
  }

  async function doe(opt) {
    opt = opt || {};
    const a = opt.ams || ams(nu());
    const start = nu();
    const datum = a.datum, droog = !!opt.droog;
    if (!droog && !zondag(datum)) return { ok: true, al_gedaan: true, detail: { geen_zondag: true } };
    const s = staatLees();
    if (!s.personen || typeof s.personen !== 'object') s.personen = {};
    if (!droog && s.klaar_datum === datum) return { ok: true, al_gedaan: true };
    if (!droog && a.uur * 60 + a.min >= 7 * 60) return { ok: true, al_gedaan: true, detail: { te_laat: true } };   // briefing is al weg

    const mislukt = function (soort) {
      soort = String(soort).slice(0, 100);   // alleen vaste lokale teksten (review MOET 1)
      laatst = { op: new Date(nu()).toISOString(), fout: soort };
      if (droog) return { ok: true, droog: true, detail: { fout: soort } };
      s.klaar_datum = datum; s.laatste_fout = soort;
      if (s.box_datum !== datum) {
        const ok = o.boxRij('\n## [log] ' + datum + ' ' + a.uur + ':' + String(a.min).padStart(2, '0') + ' — Contactringen: zondagseintje overgeslagen (' + soort + ') #contactringen\n' +
          '- status: open\n- van: pod (nachtketenstap contactringen, contactringen.js; wv2894)\n' +
          '- gemeten: ' + soort + '. Geen regel in het ochtendbericht (fail-closed).\n' +
          '- gevolg als er niets gebeurt: deze week geen seintje over de binnenste kring; volgende zondag opnieuw. David merkt het niet.\n' +
          '- voorstel: oorzaak nalopen (contacten-webhook, zoekluik 02Jga3TIAEigwgw0 datums_voor, ringpagina 20_Prive/Contactringen.md § Ring 1); stand in ' + o.staatPad + '.\n');
        if (ok) s.box_datum = datum;
      }
      try { staatZet(s); } catch (e) { /* stil */ }
      if (o.log) o.log({ opdracht: 'contactringen', ok: false, fout: soort });
      return { ok: true, detail: { fout: soort } };
    };

    let tekst;
    try { tekst = await o.ringTekst(); } catch (e) { return mislukt('ringpagina niet leesbaar'); }
    const ring = leesRing(tekst);
    if (!ring) return mislukt('ringpagina: § Ring 1 niet in de verwachte vorm');
    const doel = ring.filter(function (p) { return !p.huishouden; });
    const cfg = config(), extra = (cfg && cfg.contactnamen) || {};

    // nummers per persoon (alleen in het geheugen)
    const perPersoon = [];
    for (const p of doel) {
      // paginanaam altijd, plus extra contactnamen uit de config (review r2 MOET 2: aanvullen, niet vervangen)
      const namen = [naamUitPad(p.pad)].concat(Array.isArray(extra[p.pad]) ? extra[p.pad].map(String) : []).filter(function (n, i, l) { return n && l.map(norm).indexOf(norm(n)) === i; });
      const ids = new Set();
      let jarig = null;
      for (const n of namen) {
        let c;
        try { c = await o.contacten(n); } catch (e) { return mislukt('contacten-webhook onbereikbaar'); }
        if (!c || c.ok !== true || !Array.isArray(c.treffers)) return mislukt(c && c.fout === 'secret' ? 'contacten-webhook weigerde de sleutel' : c && c.fout ? 'contacten-webhook gaf een fout' : 'contacten-webhook gaf een ander antwoord');
        c.treffers.filter(function (t) { return t && norm(t.weergavenaam) === norm(n); }).forEach(function (t) {
          (Array.isArray(t.telefoons_e164) ? t.telefoons_e164 : []).forEach(function (nr) {
            const d = String(nr || '').replace(/\D/g, '');
            if (/^\d{8,15}$/.test(d)) ids.add(d + '@c.us');
          });
          if (!jarig && t.verjaardag) jarig = String(t.verjaardag);
        });
      }
      perPersoon.push({ p: p, ids: Array.from(ids), verjaardag: jarig });
    }

    // datums via het zoekluik, in porties van ≤ 30
    const alleIds = Array.from(new Set([].concat.apply([], perPersoon.map(function (x) { return x.ids; }))));
    const datums = {};
    for (let i = 0; i < alleIds.length; i += MAX_IDS) {
      const deel = alleIds.slice(i, i + MAX_IDS);
      let r;
      try { r = await o.datums(deel); } catch (e) { return mislukt('zoekluik onbereikbaar'); }
      if (!r || typeof r !== 'object' || !r.datums || typeof r.datums !== 'object' || Object.keys(r).some(function (k) { return k !== 'datums'; })) return mislukt('zoekluik gaf een ander antwoord');
      for (const id of deel) {
        const v = r.datums[id];
        if (v !== null && v !== undefined && !isDatum(v)) return mislukt('zoekluik gaf iets anders dan een datum');
        datums[id] = v || null;
      }
    }

    const stil = [], jarig = [];
    let gezien = 0, blind = 0, uitgezet = 0;
    for (const x of perPersoon) {
      const p = x.p;
      const st = s.personen[p.pad] || {};
      let d = null;
      x.ids.forEach(function (id) { if (datums[id] && (!d || datums[id] > d)) d = datums[id]; });
      const geldig = !!(d && isDatum(d) && d <= datum);   // review ZOU 1: alleen een echte datum t/m vandaag telt
      if (geldig) { gezien++; if (!st.laatst_gezien || d > st.laatst_gezien) st.laatst_gezien = d; } else blind++;
      if (p.geen_signaal) uitgezet++;
      // stil-signaal: alleen met een datum van vandaag (blind = stil), niet bij geen_signaal, één keer per stilteperiode
      if (geldig && !p.geen_signaal) {
        const dagen = dagNr(datum) - dagNr(st.laatst_gezien);
        const alGemeld = st.gemeld_op && st.gemeld_op >= st.laatst_gezien;
        if (dagen > GRENS_DAGEN && !alGemeld) stil.push({ pad: p.pad, voornaam: p.voornaam, weken: Math.floor(dagen / 7), dagen: dagen });
      }
      const vj = volgendeJarig(x.verjaardag, datum);
      if (vj && !p.geen_signaal && dagNr(vj) - dagNr(datum) <= JARIG_DAGEN && st.jarig_jaar !== Number(vj.slice(0, 4))) {   // review MOET 3: 'zie ik vaak' = geen seintje
        jarig.push({ pad: p.pad, voornaam: p.voornaam, datum: vj });
      }
      if (st.laatst_gezien || st.gemeld_op || st.jarig_jaar) s.personen[p.pad] = { laatst_gezien: st.laatst_gezien || null, gemeld_op: st.gemeld_op || null, jarig_jaar: st.jarig_jaar || null };
    }
    stil.sort(function (a, b) { return b.dagen - a.dagen; });
    jarig.sort(function (a, b) { return a.datum < b.datum ? -1 : 1; });
    const keus = kies(stil, jarig), t = keus.tekst;
    const detail = { personen: doel.length, met_datum: gezien, blind: blind, geen_signaal: uitgezet, stil: keus.stil.length, jarig: keus.jarig.length,
      wacht: (stil.length - keus.stil.length) + (jarig.length - keus.jarig.length) };
    if (droog) { laatst = { op: new Date(nu()).toISOString(), droog: true }; return { ok: true, droog: true, regel: t, detail: detail }; }
    // review r2 MOET 1: na alle aanroepen opnieuw de klok: na 07:00 is de briefing weg → niets schrijven, niemand als gemeld
    if (t && a.uur * 60 + a.min + (nu() - start) / 60000 >= 7 * 60) return mislukt('te laat voor de briefing van 07:00');
    if (t) {
      try { await o.bufferZet(datum, t); } catch (e) { return mislukt('buffer niet gezet'); }
    }
    // pas na een geslaagde bufferrij als gemeld vastleggen (anders zou een mislukte zondag de melding inslikken)
    const pers = function (pad) { if (!s.personen[pad]) s.personen[pad] = { laatst_gezien: null, gemeld_op: null, jarig_jaar: null }; return s.personen[pad]; };
    keus.stil.forEach(function (x) { pers(x.pad).gemeld_op = datum; });
    keus.jarig.forEach(function (x) { pers(x.pad).jarig_jaar = Number(x.datum.slice(0, 4)); });
    Object.assign(s, { klaar_datum: datum, laatste_ok: datum, regel_datum: t ? datum : s.regel_datum || null });
    delete s.laatste_fout;
    try { staatZet(s); } catch (e) { /* stil; de regel staat er al */ }
    laatst = { op: new Date(nu()).toISOString(), stil: keus.stil.length, jarig: keus.jarig.length };
    if (o.log) o.log({ opdracht: 'contactringen', ok: true, personen: doel.length, met_datum: gezien, blind: blind, stil: keus.stil.length, jarig: keus.jarig.length, wacht: detail.wacht });
    return { ok: true, detail: detail };
  }
  function info() { const s = staatLees(); return { aan: true, laatst: laatst, klaar_datum: s.klaar_datum || null, regel_datum: s.regel_datum || null, laatste_fout: s.laatste_fout || null }; }
  return { doe: doe, info: info };
}

module.exports = { maak: maak, _intern: { kies: kies, isDatum: isDatum, leesRing: leesRing, volgendeJarig: volgendeJarig, regel: regel, naamUitPad: naamUitPad, norm: norm, zondag: zondag } };
