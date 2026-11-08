'use strict';
/*
 * tibber-uur.js — Tibber-uurverbruik en uurprijzen dagelijks bij (wv2707, 8-11-2026). Alleen lezen.
 *
 * WAAROM. De uurtabel verbruik in TIBBER_DIR/tibber.sqlite kwam eenmalig uit mk-scripts/wv2583/tibber-lees.py en stopte op 6-11 13:00.
 * De dagelijkse ronde van tibber-data.js haalt alleen de Data API (auto's, geen uurverbruik). Zonder verversen blijven het uurverbruik,
 * de uurprijzen en de lopende maand (Financiën › Uitgaven › Stroom) op de stand van 6-11 staan.
 *
 * TWEE ROLLEN.
 *  1. Module (require): venster(), opslaan(), maandSom(), alleenLezen() — voor de toets en voor het kind.
 *  2. Kindproces: node tibber-uur.js uur. Stdin {sleutel} (leessleutel tibber_lezen, door server.js uit de kluis); omgeving alleen
 *     PATH/HOME/TZ/LANG/TIBBER_DIR. Eén vaste GraphQL-leesquery (Q_UUR) op api.tibber.com/v1-beta/gql: per woning de laatste N uren
 *     (72..744; venster na het laatste gevulde uur + 24, dus een gat van een paar dagen heelt vanzelf) en de prijzen van vandaag/morgen.
 *     Stdout: één JSON-regel zonder sleutel en zonder bedragen.
 *
 * GRENZEN. Eén fetch (gql), POST alleen op <basis>/v1-beta/gql, redirects uit; een querytekst met mutation of subscription wordt
 * geweigerd (zelfde regel als tibber-lees.py). Toetsbasis (TIBBER_GQL_BASIS) alleen http://127.0.0.1:<poort>. Opslag: dezelfde
 * tabellen verbruik en prijs (schema van wv2584), upsert; een gevuld uur wordt nooit door een leeg uur (consumption null) overschreven.
 */
const fs = require('fs'), path = require('path');

const UA = 'socev-tibber/1.0';
const GQL_PAD = '/v1-beta/gql';
const MIN_UREN = 72, MAX_UREN = 744;
const PAUZE_MS = process.env.TIBBER_PAUZE_MS != null ? Number(process.env.TIBBER_PAUZE_MS) : 2000;
function basis(v) {
  if (!v) return 'https://api.tibber.com';
  if (/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(v)) return v;
  throw new Error('toetsbasis alleen op 127.0.0.1');
}
const GQL_URL = basis(process.env.TIBBER_GQL_BASIS) + GQL_PAD;

const Q_UUR = 'query($n: Int!) { viewer { homes { id consumption(resolution: HOURLY, last: $n) { nodes { from to consumption cost unitPrice unitPriceVAT currency } } ' +
  'currentSubscription { priceInfo { today { startsAt total energy tax level } tomorrow { startsAt total energy tax level } } } } } }';

// Zelfde weigering als tibber-lees.py: 'mutation' waar dan ook, 'subscription' als los woord (currentSubscription mag).
function alleenLezen(q) {
  const laag = String(q).toLowerCase();
  if (laag.indexOf('mutation') >= 0 || /\bsubscription\b/.test(laag)) throw new Error('geweigerd: alleen leesqueries');
  return q;
}
function slaap(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// De enige netwerkaanroep. Herhalen alleen op netwerkfout, 429 en 5xx, hooguit 3 pogingen. Een fout noemt alleen de status.
async function gql(sleutel, query, variabelen) {
  alleenLezen(query);
  if (typeof sleutel !== 'string' || !/^[\x21-\x7e]{16,512}$/.test(sleutel)) throw new Error('sleutel ontbreekt of heeft een onverwachte vorm');
  const body = JSON.stringify({ query: query, variables: variabelen || {} });
  for (let poging = 1; ; poging++) {
    let r;
    try {
      r = await fetch(GQL_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000), body: body,
        headers: { Authorization: 'Bearer ' + sleutel, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA } });
    } catch (e) {
      if (poging < 3) { await slaap(PAUZE_MS * poging); continue; }
      throw new Error('Tibber niet bereikbaar (' + String(e && e.name || 'fout').slice(0, 40) + ')');
    }
    if ((r.status === 429 || r.status >= 500) && poging < 3) { await r.text().catch(function () {}); await slaap(PAUZE_MS * poging); continue; }
    if (r.status !== 200) { await r.text().catch(function () {}); throw new Error('Tibber gaf HTTP ' + r.status); }
    let j = null;
    try { j = await r.json(); } catch (e) { throw new Error('Tibber gaf geen JSON'); }
    if (j && Array.isArray(j.errors) && j.errors.length) throw new Error('GraphQL-fout: ' + j.errors.map(function (x) { return String(x && x.message || '').replace(/[\r\n]+/g, ' ').slice(0, 120); }).join('; '));
    if (!j || !j.data) throw new Error('Tibber gaf geen data');
    return j.data;
  }
}

// ── opslag ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function dbOpen(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, 'tibber.' + 'sqlite');
  const nieuw = !fs.existsSync(p);
  if (nieuw) fs.closeSync(fs.openSync(p, 'a', 0o600));
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(p);
  fs.chmodSync(p, 0o600);
  d.exec('pragma busy_timeout = 10000');
  d.exec('create table if not exists verbruik(home_id text, van text, tot text, kwh real, kosten real, eenheidsprijs real, eenheidsprijs_btw real, valuta text, primary key(home_id, van));' +
    'create table if not exists prijs(home_id text, van text, totaal real, energie real, belasting real, niveau text, primary key(home_id, van));');
  return d;
}
const TIJD = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const HOME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function getal(x) { return typeof x === 'number' && isFinite(x) ? x : null; }

// Hoeveel uren vragen: vanaf het laatste uur met een kWh-waarde + 24 uur marge, minstens 72, hooguit 744 (één verzoek).
function venster(d, nuMs) {
  const r = d.prepare('select van from verbruik where kwh is not null order by van desc limit 200').all();
  let laatste = null;
  r.forEach(function (x) { const t = Date.parse(x.van); if (isFinite(t) && (laatste == null || t > laatste)) laatste = t; });
  if (laatste == null) return MAX_UREN;
  return Math.max(MIN_UREN, Math.min(MAX_UREN, Math.ceil(((nuMs || Date.now()) - laatste) / 3600000) + 24));
}

function opslaan(d, homes) {
  const v = d.prepare('insert into verbruik values(?,?,?,?,?,?,?,?) on conflict(home_id, van) do update set tot = excluded.tot, ' +
    'kwh = coalesce(excluded.kwh, verbruik.kwh), kosten = case when excluded.kwh is null then verbruik.kosten else excluded.kosten end, ' +
    'eenheidsprijs = coalesce(excluded.eenheidsprijs, verbruik.eenheidsprijs), eenheidsprijs_btw = coalesce(excluded.eenheidsprijs_btw, verbruik.eenheidsprijs_btw), ' +
    'valuta = coalesce(excluded.valuta, verbruik.valuta)');
  const p = d.prepare('insert or replace into prijs values(?,?,?,?,?,?)');
  const t = { woningen: 0, uren: 0, gevuld: 0, leeg: 0, prijzen: 0, overgeslagen: 0 };
  d.exec('begin');
  try {
    (homes || []).forEach(function (h) {
      if (!h || !HOME.test(String(h.id || ''))) { t.overgeslagen++; return; }
      t.woningen++;
      const nodes = (h.consumption && Array.isArray(h.consumption.nodes)) ? h.consumption.nodes : [];
      nodes.forEach(function (n) {
        if (!n || !TIJD.test(String(n.from || '')) || !TIJD.test(String(n.to || ''))) { t.overgeslagen++; return; }
        const kwh = getal(n.consumption);
        const val = typeof n.currency === 'string' && /^[A-Z]{3}$/.test(n.currency) ? n.currency : null;
        v.run(h.id, n.from, n.to, kwh, kwh == null ? null : getal(n.cost), getal(n.unitPrice), getal(n.unitPriceVAT), val);
        t.uren++; if (kwh == null) t.leeg++; else t.gevuld++;
      });
      const pi = (h.currentSubscription && h.currentSubscription.priceInfo) || {};
      [].concat(Array.isArray(pi.today) ? pi.today : [], Array.isArray(pi.tomorrow) ? pi.tomorrow : []).forEach(function (x) {
        if (!x || !TIJD.test(String(x.startsAt || ''))) { t.overgeslagen++; return; }
        const niveau = typeof x.level === 'string' && /^[A-Z_]{1,20}$/.test(x.level) ? x.level : null;
        p.run(h.id, x.startsAt, getal(x.total), getal(x.energy), getal(x.tax), niveau);
        t.prijzen++;
      });
    });
    d.exec('commit');
  } catch (e) { try { d.exec('rollback'); } catch (e2) {} throw e; }
  return t;
}

// Amsterdamse middernacht van een kalenderdag als UTC-ms (winter +1, zomer +2).
function amsDag(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
function amsMiddernacht(dag) {
  const [y, m, dd] = dag.split('-').map(Number);
  for (const uur of [1, 2]) {
    const t = Date.UTC(y, m - 1, dd, 0) - uur * 3600000;
    if (new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }).slice(0, 13) === dag + ' 00') return t;
  }
  throw new Error('geen middernacht voor ' + dag);
}
// Lopende maand t/m gisteren (op de 1e: de hele vorige maand): kWh-som over alle woningen, en per woning hoeveel uren een waarde
// hebben (uren = de woning met de minste) tegen hoeveel er horen te zijn.
function maandSom(d, nuMs) {
  const nu = nuMs || Date.now();
  const vandaag = amsDag(nu), eind = amsMiddernacht(vandaag);
  const gisteren = amsDag(eind - 3600000);
  const begin = amsMiddernacht(gisteren.slice(0, 8) + '01');
  const rijen = d.prepare("select home_id, van, kwh from verbruik where van >= ? and van < ?").all(new Date(begin - 86400000 * 2).toISOString().slice(0, 10), new Date(eind + 86400000 * 2).toISOString().slice(0, 10));
  const perWoning = new Map();   // home_id → set van uren met een waarde; uren = de woning met de minste (review MOET 3)
  let kwh = 0;
  rijen.forEach(function (x) {
    const t = Date.parse(x.van);
    if (!isFinite(t) || t < begin || t >= eind || x.kwh == null) return;
    if (!perWoning.has(x.home_id)) perWoning.set(x.home_id, new Set());
    const s = perWoning.get(x.home_id);
    if (!s.has(t)) { s.add(t); kwh += Number(x.kwh); }
  });
  let uren = perWoning.size ? Infinity : 0;
  perWoning.forEach(function (s) { uren = Math.min(uren, s.size); });
  return { maand: gisteren.slice(0, 7), t_m: gisteren, kwh: Math.round(kwh * 10) / 10, uren: uren, woningen: perWoning.size, verwacht: Math.round((eind - begin) / 3600000) };
}
function laatsteUur(d) {
  const r = d.prepare('select van from verbruik where kwh is not null order by van desc limit 200').all();
  let best = null;
  r.forEach(function (x) { const t = Date.parse(x.van); if (isFinite(t) && (best == null || t > Date.parse(best))) best = x.van; });
  return best;
}

async function uur(invoer, dir) {
  const d = dbOpen(dir);
  try {
    const n = venster(d);
    const data = await gql(String(invoer && invoer.sleutel || ''), Q_UUR, { n: n });
    const homes = data && data.viewer && Array.isArray(data.viewer.homes) ? data.viewer.homes : null;
    if (!homes) throw new Error('Tibber gaf geen woningen');
    const t = opslaan(d, homes);
    return Object.assign({ ok: true, gevraagd: n }, t, { laatste_uur: laatsteUur(d), maand: maandSom(d) });
  } finally { d.close(); }
}

module.exports = { Q_UUR, GQL_URL, alleenLezen, gql, venster, opslaan, maandSom, laatsteUur, amsMiddernacht, dbOpen, MIN_UREN, MAX_UREN };

if (require.main === module) {
  const dir = process.env.TIBBER_DIR || '/opt/data/tibber';
  let invoer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (c) { if (invoer.length < 1e4) invoer += c; });
  process.stdin.on('end', function () {
    let j = {};
    try { j = JSON.parse(invoer || '{}'); } catch (e) { j = {}; }
    invoer = '';
    const opdracht = String(process.argv[2] || '');
    const p = opdracht === 'uur' ? uur(j, dir) : Promise.reject(new Error('opdracht: uur'));
    j = null;
    p.then(function (u) { process.stdout.write(JSON.stringify(u) + '\n'); },
      function (e) { process.stdout.write(JSON.stringify({ ok: false, fout: String(e && e.message || e).slice(0, 200) }) + '\n'); process.exitCode = 1; });
  });
}
