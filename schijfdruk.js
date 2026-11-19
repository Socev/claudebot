#!/usr/bin/env node
/*
 * schijfdruk.js — lichte schijfdrukmeting buiten server.js (wv3124, 15-11-2026, machinekamer, eigen initiatief).
 *
 * WAAROM. 15-11 08:30-09:14Z stond /proc/pressure/io full rond 75 %, server.js hing in State D (wchan folio_wait_bit_common,
 * jbd2_log_wait_commit) en geen podproces deed noemenswaardig IO: de bron zit op de Olares-host en was achteraf niet te
 * achterhalen. Zelfde patroon 7-11 en 13-11 rond 03:00-03:50 lokaal. Deze meter legt voortaan tijdstip, duur en schijf vast.
 *
 * HOE. Eén los proces per pod (net als bewaker.js door server.js gestart, detached, nooit met het pad van server.js in de
 * argumenten: uitrol.sh zoekt kinderen met pgrep op server\.js). Het overleeft een herstart van server.js; bij een andere
 * release neemt de nieuwe het slot over (pidbestand met sha).
 *   meten     elke minuut /proc/pressure/io (some/full avg10/avg60/avg300), /proc/loadavg en per blokapparaat uit
 *             /proc/diskstats de delta van gelezen/geschreven sectoren en io_ticks (ms bezet) + in-flight. Alleen hele schijven
 *             en dm-*, geen partities of loop. Lezingen asynchroon met een korte time-out: een lezing die vastzit geeft een
 *             record met 'fout', en zolang er een lezing openstaat start er geen nieuwe (geen opeenstapeling van threads).
 *   bewaren   ringbuffer van bestanden ring-JJJJMMDD-UU.jsonl (UTC, blokken van 6 u, de nieuwste 8 = 42-48 u) onder
 *             /opt/data/scripts-staat/schijfdruk/. Schrijven asynchroon met time-out; hangt de schijf, dan wordt er in het
 *             geheugen gebufferd (hooguit 360 records) en is er hooguit één schrijfpoging tegelijk. De laatste 24 u staan ook
 *             in het geheugen en worden na een herstart uit de bestanden teruggelezen.
 *   tonen     unix-socket meter.sock in dezelfde map, antwoord uit het geheugen (dus ook als de schijf hangt):
 *             GET /samenvatting (laatste minuut, piek 24 u met tijdstip) en GET /recent?min=15. server.js toont de samenvatting
 *             op /health.schijfdruk; bewaker.js zet bij een ingreep de laatste 15 minuten in zijn momentopname.
 *   melden    stilte is de default: geen bericht aan David. Wel één box-rij als full avg60 langer dan 10 min boven 50 % blijft
 *             (hooguit 1x per 24 u, alarm.json), met tijdvak en zwaarste apparaat.
 *   NVMe      (wv3126) elke 10 s sysfs: controllerstatus en /sys/block/nvmeNn1/stat; per minuut veld nv in het record (latentie ms per
 *             opdracht, MB, % bezet, inflight, stilstand, temperatuur). Bij een drukperiode komt het oordeel 'schijf hapert' of
 *             'drukte van elders' met de getallen in de box-rij. Status ≠ live of een vastzittende I/O (inflight > 0 en ≥ 30 s geen
 *             afgeronde opdracht: lezen, schrijven, discard of flush) = altijd een box-rij [direct] en hooguit 1x per dag één regel aan David via bericht.py (niet 23:00-07:00).
 *             Geen noodstop. Leesstuk: 00_Systeem/Schijf van Olares.md.
 *             (wv3292) Een incident vervalt niet meer stil: na 3 min gezond (live, geen stilstand, geen opdrachten > 500 ms) is het
 *             voorbij, maar het blijft bestaan ("voorbij, nog te melden") tot de box-rij geschreven en het bericht verstuurd is, of tot
 *             een dag na het einde (dan staat het als vervallen in /health). Het lopende incident staat in haper.json, zodat een
 *             herstart het niet wist. De box-rij en het bericht noemen dan begin, einde, aantal resets en de piek.
 * Uitzetten: touch /opt/data/schijfdruk-uit (gelezen bij de start van het proces) of SCHIJFDRUK=0 in de omgeving van server.js.
 * Toets: test/schijfdruk.sh (nep-/proc, eigen paden; raakt de pod niet).
 */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

function start(o) {
  const k = spawn(process.execPath, [__filename], {
    detached: true, stdio: 'ignore', cwd: '/', env: Object.assign({}, o && o.env || process.env, o && o.sha ? { SCHIJFDRUK_SHA: o.sha } : {})
  });
  k.on('error', function () {});
  k.unref();
  return k.pid;
}
if (require.main !== module) { module.exports = { start: start }; return; }

function getal(naam, standaard) {
  const v = parseInt(process.env[naam] || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : standaard;
}
const DIR = process.env.SCHIJFDRUK_DIR || '/opt/data/scripts-staat/schijfdruk';
const PROC = process.env.SCHIJFDRUK_PROC || '/proc';
const SOCK = process.env.SCHIJFDRUK_SOCK || path.join(DIR, 'meter.sock');
const LOCK = path.join(DIR, 'meter.pid');
const ALARM_BESTAND = path.join(DIR, 'alarm.json');
const UIT = process.env.SCHIJFDRUK_UIT || '/opt/data/schijfdruk-uit';
const VAULT = process.env.VAULT_DIR || '/opt/data/AI_SecondBrain';
const BOX = process.env.SCHIJFDRUK_BOX || path.join(VAULT, '00_Systeem', 'Meldingen', 'machinekamer.md');
const SHA = process.env.SCHIJFDRUK_SHA || path.basename(__dirname);
const C = {
  tik: getal('SCHIJFDRUK_TIK_MS', 60000),
  fs: getal('SCHIJFDRUK_FS_MS', 8000),            // grens voor één bestandshandeling
  proc: getal('SCHIJFDRUK_PROC_MS', 3000),        // grens voor één /proc-lezing
  blokUren: getal('SCHIJFDRUK_BLOK_UREN', 6),
  bewaar: getal('SCHIJFDRUK_BEWAAR', 8),          // aantal ringbestanden
  geheugen: getal('SCHIJFDRUK_GEHEUGEN', 1440),   // records in het geheugen (24 u bij 1 per minuut)
  uitstaand: getal('SCHIJFDRUK_UITSTAAND', 360),  // records die op schrijven wachten, bij een hangende schijf
  alarmPct: getal('SCHIJFDRUK_ALARM_PCT', 50),
  alarmMs: getal('SCHIJFDRUK_ALARM_MS', 10 * 60000),
  alarmPauze: getal('SCHIJFDRUK_ALARM_PAUZE_MS', 24 * 3600000),
  vensterMs: getal('SCHIJFDRUK_VENSTER_MS', 24 * 3600000),
  // wv3126: NVMe-meting
  nvTik: getal('SCHIJFDRUK_NV_MS', 10000),          // elke 10 s sysfs lezen (stat + state), per minuut één record
  nvStilS: getal('SCHIJFDRUK_NV_STIL_S', 30),       // inflight > 0 en zo lang geen afgeronde opdracht = vastzittende I/O (io_timeout van de kernel)
  nvLatMs: getal('SCHIJFDRUK_NV_LAT_MS', 500),      // gemiddelde ms per opdracht boven dit = traag
  nvWeinigMb: getal('SCHIJFDRUK_NV_WEINIG_MB', 600), // MB per minuut (lezen + schrijven) onder dit = "weinig verkeer"
  haperBoxPauze: getal('SCHIJFDRUK_HAPER_BOX_PAUZE_MS', 30 * 60000),   // tussen twee box-rijen van twee verschillende incidenten
  haperBerichtPauze: getal('SCHIJFDRUK_HAPER_BERICHT_PAUZE_MS', 24 * 3600000),   // hooguit 1 bericht per dag aan David
  haperHerstelMs: getal('SCHIJFDRUK_HAPER_HERSTEL_MS', 3 * 60000),   // zo lang gezond (live, geen stilstand, geen trage opdrachten) = incident voorbij
  // wv3292: een voorbij incident blijft bestaan tot box-rij en bericht gedaan zijn; na zo lang na het einde vervalt wat nog openstaat
  haperVervalMs: getal('SCHIJFDRUK_HAPER_VERVAL_MS', 24 * 3600000),
  haperBewaarMs: getal('SCHIJFDRUK_HAPER_BEWAAR_MS', 30000),   // het lopende incident hooguit zo vaak naar haper.json (overleeft een herstart)
  boxKindMs: getal('SCHIJFDRUK_BOX_MS', 30000)                 // grens voor het kind-proces dat de box-rij schrijft
};
const SYS = process.env.SCHIJFDRUK_SYS || '/sys';
const HAPER_BESTAND = path.join(DIR, 'haper.json');
const BERICHT = process.env.SCHIJFDRUK_BERICHT || '/opt/data/mk-scripts/bericht.py';

const mono = () => Number(process.hrtime.bigint() / 1000000n);
const wacht = (ms) => new Promise((r) => setTimeout(r, ms));
// fsOpen telt bestandshandelingen die nog echt lopen, ook als hun time-out al verstreek: een time-out beëindigt alleen het
// wachten, de thread in de libuv-pool blijft bezet tot de kernel antwoordt (Codex-review wv3124 MOET 1). Boven MAXOPEN start
// er geen nieuw werk meer, zodat de pool (4 threads) nooit helemaal dichtloopt en de meter blijft meten en antwoorden.
let fsOpen = 0;
const MAXOPEN = getal('SCHIJFDRUK_MAXOPEN', 2);
function metGrens(p, ms, standaard) {
  let t;
  fsOpen++;
  const klaar = () => { fsOpen--; };
  const q = Promise.resolve(p);
  q.then(klaar, klaar);
  return Promise.race([q.catch(() => standaard), new Promise((r) => { t = setTimeout(() => r(standaard), ms); })])
    .finally(() => clearTimeout(t));
}
const lees = (p, ms) => metGrens(fsp.readFile(p, 'utf8'), ms || C.fs, null);
function amsterdam(d) { return (d || new Date()).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
const hhmm = (ms) => amsterdam(new Date(ms)).slice(11, 16);
const rond = (x, n) => Number.isFinite(x) ? Math.round(x * (n || 100)) / (n || 100) : null;

// ── het slot: één meter per pod ─────────────────────────────────────────────────────────────────────────────────────
async function starttijd(pid) {
  const s = await lees('/proc/' + pid + '/stat', 2000);
  if (!s) return null;
  const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
  return f[19] || null;   // veld 22 (starttime), na pid en comm
}
async function leeft(pid, start) {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  const nu = await starttijd(pid);
  return nu !== null && (start == null || String(nu) === String(start));
}
async function neemSlot() {
  if (!(await metGrens(fsp.mkdir(DIR, { recursive: true }).then(() => true), C.fs, false))) return false;
  const eigen = JSON.stringify({ pid: process.pid, start: await starttijd(process.pid), sha: SHA });
  for (let poging = 0; poging < 3; poging++) {
    const gelukt = await metGrens(fsp.writeFile(LOCK, eigen, { flag: 'wx' }).then(() => true, (e) => (e.code === 'EEXIST' ? 'bezet' : false)), C.fs, false);
    if (gelukt === true) return true;
    if (gelukt === false) return false;
    const h = await lees(LOCK);
    let o = null; try { o = JSON.parse(h); } catch (e) {}
    if (o && o.pid && await leeft(o.pid, o.start)) {
      if (o.sha === SHA) return false;                       // dezelfde release draait al
      try { process.kill(o.pid, 'SIGTERM'); } catch (e) {}   // andere release: die neemt hij over
      for (let i = 0; i < 30 && await leeft(o.pid, o.start); i++) await wacht(200);
      if (await leeft(o.pid, o.start)) { try { process.kill(o.pid, 'SIGKILL'); } catch (e) {} await wacht(300); }
    }
    await metGrens(fsp.unlink(LOCK).then(() => true), C.fs, false);
  }
  return false;
}
async function slotIsVan_mij() {
  const h = await lees(LOCK, 3000);
  if (h === null) return null;   // niet te lezen: geen oordeel
  try { return JSON.parse(h).pid === process.pid; } catch (e) { return false; }
}

// ── lezen van /proc ─────────────────────────────────────────────────────────────────────────────────────────────────
function leesDruk(t) {
  const uit = {};
  for (const soort of ['some', 'full']) {
    const m = new RegExp('^' + soort + ' avg10=([\\d.]+) avg60=([\\d.]+) avg300=([\\d.]+)', 'm').exec(t || '');
    if (m) uit[soort] = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
  }
  return uit;
}
const SCHIJF = /^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|mmcblk\d+|dm-\d+|md\d+)$/;
function leesSchijven(t) {
  const uit = {};
  for (const regel of String(t || '').split('\n')) {
    const f = regel.trim().split(/\s+/);
    if (f.length < 14 || !SCHIJF.test(f[2])) continue;
    const g = f.slice(3).map(Number);   // g[0] reads, g[2] sectoren gelezen, g[4] writes, g[6] sectoren geschreven, g[8] in flight, g[9] io_ticks
    if (g.some((x) => !Number.isFinite(x))) continue;
    uit[f[2]] = { rs: g[2], ws: g[6], tick: g[9], infl: g[8] };
  }
  return uit;
}
let vorige = null;   // { ms, schijven }
let sampleBezig = false;

async function monster() {
  const wand = Date.now(), m = mono();
  const druk = await lees(PROC + '/pressure/io', C.proc), la = await lees(PROC + '/loadavg', C.proc), ds = await lees(PROC + '/diskstats', C.proc);   // na elkaar: nooit meer dan één pool-thread voor de meting
  const r = { t: new Date(wand).toISOString() };
  const fouten = [];
  const d = druk === null ? null : leesDruk(druk);
  if (!d || !d.some || !d.full) fouten.push('pressure'); else r.io = [d.some[0], d.some[1], d.full[0], d.full[1], d.some[2], d.full[2]];
  if (la === null) fouten.push('loadavg'); else { const f = la.split(' ').map(parseFloat); if (f.length >= 3 && f.every(Number.isFinite)) r.la = f.slice(0, 3); else fouten.push('loadavg'); }
  const s = ds === null ? null : leesSchijven(ds);
  if (!s) fouten.push('diskstats');
  else {
    r.d = {};
    if (vorige) {
      r.dt = rond((m - vorige.ms) / 1000, 10);
      for (const n of Object.keys(s)) {
        const v = vorige.schijven[n]; if (!v) continue;
        const dr = s[n].rs - v.rs, dw = s[n].ws - v.ws, dtk = s[n].tick - v.tick;
        if (dr < 0 || dw < 0 || dtk < 0) continue;   // teller teruggezet: geen delta
        if (dr || dw || dtk || s[n].infl) r.d[n] = [dr, dw, dtk, s[n].infl];
      }
    }
    vorige = { ms: m, schijven: s };
  }
  const nvr = await nvVoorRecord();   // wv3126: NVMe-latentie en -status van de afgelopen minuut
  if (nvr) r.nv = nvr;
  if (fouten.length) r.fout = fouten.join(',');
  r.ms = wand;
  return r;
}

// ── wv3126: NVMe-latentie en -status ────────────────────────────────────────────────────────────────────────────────
// Doel: "de schijf hapert" scheiden van "een andere app schrijft veel". Elke C.nvTik (10 s) uit sysfs: controllerstatus
// (/sys/class/nvme/nvmeN/state) en /sys/block/nvmeNn1/stat (afgeronde opdrachten, sectoren, ms per opdracht, io_ticks, inflight).
// De tellers worden per minuut opgeteld tot één veld nv in het record: s status (de slechtste van de minuut), r/w aantal opdrachten,
// mr/mw MB, lr/lw gemiddelde ms per opdracht, lm het slechtste gemiddelde van één venster van 10 s (een opdracht van 40 s verschijnt
// pas als hij klaar is, dus in het venster waarin hij eindigt), bz % bezet, i inflight, st langste stilstand in s (inflight > 0 en
// geen enkele opdracht afgerond), t temperatuur, n aantal vensters. Alleen sysfs: geen dmesg, journal of SMART nodig (niet leesbaar
// vanuit de pod). Een temperatuurlezing stuurt een commando naar de controller en gaat daarom alleen per minuut en alleen als hij live is.
const NVNAAM = /^nvme\d+$/, NVBLOK = /^nvme\d+n\d+$/;
let nvDev = [];            // [{ ctrl, blok, temp }]  temp = pad naar temp1_input of null
let nvOntdekt = 0;
const nvAcc = {};          // per blok: { vorig: {st, ms}, acc, niet: Set, stilSinds }
let nvBezig = false;
// incident: { sinds, einde, laatstSlecht, reden, details, gezondSinds, resets, piekMs, piekT, stilMax, boxKlaar, msgKlaar, boxLaatst, boxPog,
// msgLaatst, msgPog }. einde = null zolang het duurt; daarna "voorbij, nog te melden" tot box-rij én bericht gedaan zijn (of vervallen).
// Staat in haper.json (wv3292), zodat een herstart van de meter midden in een hapering het incident niet wist (18-11 02:55Z gebeurd).
let incident = null;
let haperBezig = false, haperVuil = false, haperBewaarBezig = false, haperBewaarLaatst = 0;
let haperStaat = { box: 0, bericht: 0, vervallen: null };   // ms van de laatste box-rij en het laatste bericht (ook na een herstart: haper.json)
const nul = () => ({ n: 0, dr: 0, dw: 0, drs: 0, dws: 0, drt: 0, dwt: 0, dtk: 0, dms: 0, lm: 0, stil: 0, infl: 0 });

async function nvOntdek() {
  const cs = await metGrens(fsp.readdir(SYS + '/class/nvme'), C.proc, null);
  if (!cs) { nvOntdekt = Date.now(); return; }   // geen NVMe of niet te lezen: houd de lijst van de vorige keer
  const uit = [];
  for (const c of cs.filter((n) => NVNAAM.test(n)).sort()) {
    const inh = (await metGrens(fsp.readdir(SYS + '/class/nvme/' + c), C.proc, null)) || [];
    const hw = inh.find((n) => /^hwmon\d+$/.test(n));
    for (const b of inh.filter((n) => NVBLOK.test(n)).sort()) uit.push({ ctrl: c, blok: b, temp: hw ? SYS + '/class/nvme/' + c + '/' + hw + '/temp1_input' : null });
  }
  nvDev = uit; nvOntdekt = Date.now();
}
function leesStat(t) {
  const g = String(t || '').trim().split(/\s+/).map(Number);   // 0 reads, 2 sectoren gelezen, 3 ms lezen, 4 writes, 6 sectoren geschreven, 7 ms schrijven, 8 inflight, 9 io_ticks
  if (g.length < 10 || g.some((x) => !Number.isFinite(x))) return null;
  // voortgang = ook discard (11, kernel >= 5.5) en flush (15, kernel >= 5.5): inflight telt die mee, dus een langdurige trim of flush is geen stilstand
  return { r: g[0], rs: g[2], rt: g[3], w: g[4], ws: g[6], wt: g[7], infl: g[8], tick: g[9], x: (g[11] || 0) + (g[15] || 0) };
}
async function nvTik() {
  if (nvBezig || fsOpen > MAXOPEN) return;   // vorige ronde nog bezig, of lezingen die vastzitten bezetten de pool
  nvBezig = true;
  try {
    if (!nvDev.length ? Date.now() - nvOntdekt > 60000 : Date.now() - nvOntdekt > 5 * 60000) await nvOntdek();
    let probleem = null;
    const w = { resets: 0, lat: 0, stil: 0 };   // wv3292: voor het incident (overgangen naar ≠ live, slechtste ms per opdracht van dit venster)
    for (const d of nvDev) {
      if (fsOpen > MAXOPEN) break;
      const staatT = await lees(SYS + '/class/nvme/' + d.ctrl + '/state', C.proc);
      const st = leesStat(await lees(SYS + '/block/' + d.blok + '/stat', C.proc));
      const m = mono();
      const a = nvAcc[d.blok] || (nvAcc[d.blok] = { vorig: null, acc: nul(), niet: new Set(), stilSinds: null });
      const staat = staatT === null ? null : staatT.trim();
      if (staat && staat !== 'live') a.niet.add(staat);
      if (staat) { const niet = staat !== 'live'; if (niet && !a.wasNiet) w.resets++; a.wasNiet = niet; }
      let stil = 0;
      if (st) {
        const v = a.vorig;
        if (v) {
          const dx = st.x - v.st.x, dr = st.r - v.st.r, dw = st.w - v.st.w, drt = st.rt - v.st.rt, dwt = st.wt - v.st.wt, drs = st.rs - v.st.rs, dws = st.ws - v.st.ws, dtk = st.tick - v.st.tick;
          if (dx < 0 || dr < 0 || dw < 0 || drt < 0 || dwt < 0 || drs < 0 || dws < 0 || dtk < 0) a.stilSinds = null;   // teller teruggezet: geen delta
          else {
            if (st.infl > 0 && dr + dw + dx === 0) { if (a.stilSinds === null) a.stilSinds = m; } else a.stilSinds = null;
            stil = a.stilSinds === null ? 0 : Math.round((m - a.stilSinds) / 1000);
            const x = a.acc;
            x.n++; x.dr += dr; x.dw += dw; x.drs += drs; x.dws += dws; x.drt += drt; x.dwt += dwt; x.dtk += dtk; x.dms += m - v.ms;
            x.lm = Math.max(x.lm, dr ? drt / dr : 0, dw ? dwt / dw : 0); x.stil = Math.max(x.stil, stil); x.infl = st.infl;
            w.lat = Math.max(w.lat, dr ? drt / dr : 0, dw ? dwt / dw : 0); w.stil = Math.max(w.stil, stil);
          }
        }
        a.vorig = { st: st, ms: m };
      }
      if (staat && staat !== 'live') probleem = probleem || { reden: 'status "' + staat + '" in plaats van live', blok: d.blok, staat: staat, stil: stil, infl: st ? st.infl : null };
      else if (stil >= C.nvStilS) probleem = probleem || { reden: 'vastzittende I/O: ' + st.infl + ' opdrachten wachten en al ' + stil + ' s is er geen enkele afgerond', blok: d.blok, staat: staat, stil: stil, infl: st.infl };
    }
    w.traag = w.lat > C.nvLatMs;
    incidentBijwerken(probleem, w);
  } catch (e) {} finally { nvBezig = false; }
}
async function nvVoorRecord() {
  const uit = {}; let n = 0;
  for (const d of nvDev) {
    const a = nvAcc[d.blok]; if (!a || !a.acc.n) continue;
    const x = a.acc, s = a.niet.size ? Array.from(a.niet).join('/') : 'live';
    let t = null;
    if (d.temp && s === 'live' && fsOpen <= MAXOPEN) { const tt = parseInt(await lees(d.temp, C.proc), 10); if (Number.isFinite(tt)) t = rond(tt / 1000, 10); }
    uit[d.blok] = { s: s, r: x.dr, w: x.dw, mr: rond(x.drs * 512 / 1048576, 10), mw: rond(x.dws * 512 / 1048576, 10), lr: x.dr ? rond(x.drt / x.dr, 10) : null, lw: x.dw ? rond(x.dwt / x.dw, 10) : null,
      lm: rond(x.lm, 10), bz: x.dms ? rond(x.dtk / x.dms * 100, 10) : null, i: x.infl, st: x.stil, t: t, n: x.n };
    a.acc = nul(); a.niet = new Set(); n++;
  }
  return n ? uit : null;
}

// Het oordeel bij een drukperiode: hapert de schijf, of komt de drukte van elders? Hapering = status ≠ live, een vastzittende I/O of
// trage opdrachten (> C.nvLatMs ms in een venster van 10 s) bij weinig verkeer (< C.nvWeinigMb MB in die minuut); drukte = veel MB bij
// normale latentie. Veel MB bij trage opdrachten is een verzadigde schijf: dat is drukte, geen defect, en staat met de getallen erbij.
function nvOordeel(venster) {
  const staten = new Set(), apparaten = new Set();
  let n = 0, ops = 0, somR = 0, opsR = 0, somW = 0, opsW = 0, mb = 0, mbPiek = 0, lm = 0, lmT = null, lmMb = 0, stil = 0, tr = false;
  for (const r of venster) {
    if (!r.nv) continue;
    for (const k of Object.keys(r.nv)) {
      const v = r.nv[k]; n++; apparaten.add(k);
      const m = (v.mr || 0) + (v.mw || 0);
      mb += m; mbPiek = Math.max(mbPiek, m);
      if (v.lr !== null && v.lr !== undefined) { somR += v.lr * (v.r || 0); opsR += v.r || 0; }
      if (v.lw !== null && v.lw !== undefined) { somW += v.lw * (v.w || 0); opsW += v.w || 0; }
      if (v.s && v.s !== 'live') for (const x of String(v.s).split('/')) staten.add(x);
      if ((v.st || 0) > stil) stil = v.st;
      if ((v.lm || 0) > lm) { lm = v.lm; lmT = r.t; lmMb = m; }
      if ((v.lm || 0) > C.nvLatMs && m < C.nvWeinigMb) tr = true;
    }
  }
  ops = opsR + opsW;
  if (!n) return { label: 'niet vast te stellen', tekst: 'geen NVMe-meting in dit tijdvak (sysfs niet leesbaar of de meter startte net)' };
  const hapert = staten.size > 0 || stil >= C.nvStilS || tr;
  const redenen = [];
  if (staten.size) redenen.push('status ' + Array.from(staten).join('/') + ' gezien');
  if (stil >= C.nvStilS) redenen.push('langste stilstand ' + stil + ' s met opdrachten in de wacht');
  if (tr) redenen.push('opdrachten > ' + C.nvLatMs + ' ms bij minder dan ' + C.nvWeinigMb + ' MB per minuut');
  const getallen = Array.from(apparaten).join('+') + ': ' + (staten.size ? 'status ' + Array.from(staten).join('/') : 'status steeds live') +
    '; gemiddeld ' + (opsW ? rond(somW / opsW, 10) : '-') + ' ms per schrijfopdracht en ' + (opsR ? rond(somR / opsR, 10) : '-') + ' ms per leesopdracht (' + ops + ' opdrachten)' +
    '; slechtste venster van 10 s ' + rond(lm, 10) + ' ms' + (lmT ? ' om ' + hhmm(Date.parse(lmT)) + ' bij ' + rond(lmMb, 10) + ' MB in die minuut' : '') +
    '; verkeer gemiddeld ' + rond(mb / Math.max(1, n), 10) + ' MB per minuut (piek ' + rond(mbPiek, 10) + ')' + '; langste stilstand ' + stil + ' s';
  const verzadigd = !hapert && lm > C.nvLatMs;
  return { label: hapert ? 'schijf hapert' : 'drukte van elders', hapert: hapert, tekst: (hapert ? 'de schijf zelf hapert (' + redenen.join('; ') + ') — ' : 'de schijf zelf antwoordt normaal' + (verzadigd ? ' behalve door veel verkeer (verzadigd, geen defect)' : '') + '; de drukte komt van een proces op de host — ') + getallen };
}
function nvSamenvatting() {
  const grens = Date.now() - C.vensterMs, apparaten = {};
  for (const r of buf) {
    if (!r.nv || r.ms < grens) continue;
    for (const k of Object.keys(r.nv)) {
      const v = r.nv[k], u = apparaten[k] || (apparaten[k] = { laatste: null, piek_venster_ms: null, laatst_niet_live: null, langste_stil_s: null });
      u.laatste = { tijd: r.t, status: v.s, lees_ms: v.lr, schrijf_ms: v.lw, mb_min: rond((v.mr || 0) + (v.mw || 0), 10), bezet_pct: v.bz, inflight: v.i, stil_s: v.st, temp_c: v.t, leeftijd_s: Math.round((Date.now() - r.ms) / 1000) };
      if (!u.piek_venster_ms || v.lm > u.piek_venster_ms.waarde) u.piek_venster_ms = { waarde: v.lm, tijd: r.t };
      if (v.s && v.s !== 'live') u.laatst_niet_live = { tijd: r.t, status: v.s };
      if (!u.langste_stil_s || v.st > u.langste_stil_s.waarde) u.langste_stil_s = { waarde: v.st, tijd: r.t };
    }
  }
  return { apparaten: apparaten, vensters_per_minuut_verwacht: Math.round(60000 / C.nvTik),
    incident: incident ? { sinds_iso: new Date(incident.sinds).toISOString(), einde_iso: incident.einde ? new Date(incident.einde).toISOString() : null, reden: incident.reden,
      resets: incident.resets, piek_ms: rond(incident.piekMs, 10), langste_stil_s: incident.stilMax, box_rij: incident.boxKlaar, bericht_david: incident.msgKlaar,
      pogingen_box: incident.boxPog, pogingen_bericht: incident.msgPog } : null,
    laatste_box_iso: haperStaat.box ? new Date(haperStaat.box).toISOString() : null, laatste_bericht_iso: haperStaat.bericht ? new Date(haperStaat.bericht).toISOString() : null,
    vervallen: haperStaat.vervallen };
}

// ── het hapering-incident: status ≠ live of een vastzittende I/O is altijd een box-rij (direct) en één regel aan David (1x/dag) ────────
function stilleUren() {
  const uur = process.env.SCHIJFDRUK_UUR !== undefined ? parseInt(process.env.SCHIJFDRUK_UUR, 10) : parseInt(amsterdam().slice(11, 13), 10);
  return uur >= 23 || uur < 7;
}
function nieuwIncident(nu, p) {
  return { sinds: nu, einde: null, laatstSlecht: nu, reden: p.reden, details: p, gezondSinds: null, resets: 0, piekMs: 0, piekT: null, stilMax: 0,
    boxKlaar: false, msgKlaar: false, boxLaatst: 0, boxPog: 0, msgLaatst: 0, msgPog: 0 };
}
// p = een probleem (status ≠ live of vastzittende I/O) of null; w = { resets, lat, stil, traag } van dit venster van 10 s.
// wv3292: "gezond" is live, geen stilstand én geen trage opdrachten (> C.nvLatMs ms): 18-11 bleef de schijf na de laatste reset nog
// 9 min op 10-50 s per opdracht hangen. Na C.haperHerstelMs gezond is het incident voorbij (einde = laatste slechte venster), maar het
// blijft bestaan tot de box-rij en het bericht gedaan zijn; vroeger viel het dan weg, ook als het schrijven op de hangende schijf
// mislukt was en het bericht op 07:00 wachtte (18-11: geen rij, geen bericht).
function incidentBijwerken(p, w) {
  const nu = Date.now();
  w = w || {};
  let i = incident;
  if (p) {
    if (i && i.einde && i.boxKlaar) i = null;   // voorbij en al in de box: een nieuwe hapering is een nieuw incident (bericht: 1x per dag)
    if (!i) { i = incident = nieuwIncident(nu, p); haperVuil = true; }
    else if (i.einde) { i.einde = null; haperVuil = true; }   // nog niet gemeld: hetzelfde incident loopt door
    i.gezondSinds = null; i.details = p; i.laatstSlecht = nu; haperVuil = true;   // laatstSlecht = later het einde: bewaren (throttle C.haperBewaarMs; Codex MOET 1)
  } else if (i && !i.einde) {
    if (w.traag || w.stil > 0) { i.gezondSinds = null; i.laatstSlecht = nu; haperVuil = true; }
    else if (i.gezondSinds === null) i.gezondSinds = nu;
    else if (nu - i.gezondSinds >= C.haperHerstelMs) {
      i.einde = i.laatstSlecht;   // het laatste venster waarin de schijf nog hapte
      i.boxPog = 0; i.boxLaatst = 0; i.msgPog = 0; i.msgLaatst = 0;   // de schijf leeft weer: een nieuwe reeks snelle pogingen
      haperVuil = true;
    }
  }
  if (i && !i.einde) {
    if (w.resets) { i.resets += w.resets; haperVuil = true; }
    if ((w.lat || 0) > i.piekMs) { i.piekMs = w.lat; i.piekT = nu; haperVuil = true; }
    if ((w.stil || 0) > i.stilMax) { i.stilMax = w.stil; haperVuil = true; }
  }
  if (i && i.einde && i.boxKlaar && i.msgKlaar) { incident = null; haperVuil = true; }
  if (incident) haperVerwerk().catch(() => {});
  if (haperVuil && !haperBewaarBezig && nu - haperBewaarLaatst >= C.haperBewaarMs && fsOpen < MAXOPEN) haperBewaar().catch(() => {});
}
function stuurBericht(tekst) {   // wv3424: via meld.js (bericht.py, zelfde aanroep als de bewaker)
  if (!fs.existsSync(BERICHT)) return Promise.resolve(false);
  const m = meldInst();
  return m ? m.bericht(tekst, 'schijf-hapert') : Promise.resolve(false);
}
function haperRij(i, nu) {
  const d = i.details || {};
  const tot = i.einde || nu;
  const lijst = buf.filter((r) => r.ms >= Math.min(i.sinds - 60000, nu - 15 * 60000) && r.ms <= tot + 120000 && r.nv);
  const o = nvOordeel(lijst);
  const duur = Math.max(1, Math.round((tot - i.sinds) / 60000));
  const tellers = (i.resets ? i.resets + ' keer status ≠ live (controllerreset)' : 'status bleef live') + '; piek ' + rond(i.piekMs, 10) + ' ms per opdracht' +
    (i.piekT ? ' om ' + hhmm(i.piekT) : '') + '; langste stilstand ' + i.stilMax + ' s';
  const velden = [
    ['status', 'open — de NVMe-schijf van Olares zelf meldt een probleem (niet een andere app); kijk of de server er last van heeft (/health.schijfdruk.nvme) en vergelijk met de incidenten van 5/6-10, 9-10 en 18-11 in 00_Systeem/Schijf van Olares.md'],
    ['van', 'schijfdruk.js (wv3126/wv3292, release ' + SHA + ')'],
    ['gemeten', (d.blok || 'nvme') + ': ' + i.reden + '; begin ' + hhmm(i.sinds) + (i.einde ? ', einde ' + hhmm(i.einde) + ' (' + duur + ' min; rij geschreven ' + hhmm(nu) + ')' : ' (duurt nog, nu ' + hhmm(nu) + ')') +
      '; ' + tellers + '; tijdvak: ' + o.tekst],
    ['verloop', 'ring ' + DIR + '/ring-*.jsonl (veld nv per minuut: status, MB, ms per opdracht, inflight, stilstand, temperatuur); bij een ingreep van de bewaker staan de laatste 15 min in bin/bewaker-bewijs-*.json'],
    ['David', 'krijgt hooguit 1x per dag één regel in de app (niet 23:00-07:00; een nachtelijk incident de eerste keer na 07:00); geen noodstop en geen ingreep door de meter'],
    ['voorstel', 'dmesg, journal en SMART zijn vanuit de pod niet leesbaar: laat de Olares-zijde (host) de NVMe-log nalopen als dit terugkeert; schijf, firmware en energiebeheer zijn daar te beoordelen']];
  const kop = i.einde ? 'Schijf van Olares haperde ' + hhmm(i.sinds) + '–' + hhmm(i.einde) + ' (' + (i.resets ? i.resets + '× reset, ' : '') + 'piek ' + Math.round(i.piekMs / 100) / 10 + ' s per opdracht)'
    : 'Schijf van Olares hapert: ' + i.reden.slice(0, 80);
  return '\n## [direct] ' + amsterdam().slice(0, 16) + ' — ' + kop + ' #schijf-hapert\n' +
    velden.map((v) => '- ' + v[0] + ': ' + String(v[1]).replace(/[\r\n]+/g, ' ').slice(0, 1500)).join('\n') + '\n';
}
function haperBerichtTekst(i) {
  if (!i.einde) return 'De schijf van Olares hapert weer, zoals in oktober. De app kan daardoor even traag zijn of een foutmelding geven. Het staat vastgelegd voor de machinekamer; je hoeft niets te doen.';
  const dag = (ms) => amsterdam(new Date(ms)).slice(0, 10);
  const van = hhmm(i.sinds), uur = parseInt(van.slice(0, 2), 10);
  const wanneer = dag(i.sinds) === dag(Date.now()) ? (uur < 7 ? 'Vannacht' : 'Vandaag') : 'Op ' + dag(i.sinds).slice(8, 10).replace(/^0/, '') + '-' + dag(i.sinds).slice(5, 7).replace(/^0/, '');
  return wanneer + ' tussen ' + van + ' en ' + hhmm(i.einde) + ' haperde de schijf van Olares' + (i.resets ? ' (' + i.resets + ' keer opnieuw opgestart)' : '') +
    '. De app kan toen traag zijn geweest of een foutmelding gegeven hebben. Het staat vastgelegd voor de machinekamer; je hoeft niets te doen.';
}
// Pogingen per kanaal: de eerste 10 elke minuut, daarna elke 30 minuten zolang het incident duurt (een schrijfstoring in de stille uren
// mag het bericht van de ochtend niet blokkeren, en een mislukt bericht niet de box-rij).
const haperWacht = (pog) => (pog < 10 ? 60000 : 30 * 60000);
async function haperVerwerk() {
  const i = incident, nu = Date.now();
  if (haperBezig || !i || (i.boxKlaar && i.msgKlaar)) return;
  haperBezig = true;
  try {
    if (i.einde && nu - i.einde >= C.haperVervalMs) {   // wv3292: wat een dag na het einde nog openstaat vervalt (staat in /health)
      const kan = [];
      if (!i.boxKlaar) { i.boxKlaar = true; kan.push('box-rij'); }
      if (!i.msgKlaar) { i.msgKlaar = true; kan.push('bericht'); }
      haperStaat.vervallen = { incident_sinds_iso: new Date(i.sinds).toISOString(), wat: kan.join('+'), op_iso: new Date(nu).toISOString() };
      haperVuil = true; return;
    }
    if (!i.boxKlaar && nu - i.boxLaatst >= haperWacht(i.boxPog)) {
      if (nu - haperStaat.box < C.haperBoxPauze) i.boxKlaar = true;   // net een rij gezet voor een vorig incident: geen tweede
      else {
        i.boxPog++; i.boxLaatst = nu;
        if (await boxRijVeilig(haperRij(i, nu), 'hapert-' + i.sinds)) { i.boxKlaar = true; haperStaat.box = nu; await haperBewaar(); }
        else haperVuil = true;   // pogingen bewaren
      }
    }
    if (!i.msgKlaar && nu - i.msgLaatst >= haperWacht(i.msgPog)) {
      if (nu - haperStaat.bericht < C.haperBerichtPauze) i.msgKlaar = true;   // hooguit 1x per dag
      else if (!stilleUren()) {
        i.msgPog++; i.msgLaatst = nu;
        if (await stuurBericht(haperBerichtTekst(i))) { i.msgKlaar = true; haperStaat.bericht = nu; await haperBewaar(); }
      }
    }
  } catch (e) {} finally { haperBezig = false; }
}
const INC_VELDEN = ['sinds', 'einde', 'laatstSlecht', 'reden', 'details', 'resets', 'piekMs', 'piekT', 'stilMax', 'boxKlaar', 'msgKlaar', 'boxPog', 'msgPog'];
async function haperBewaar() {
  haperBewaarBezig = true; haperBewaarLaatst = Date.now(); haperVuil = false;
  const inc = incident ? Object.fromEntries(INC_VELDEN.map((k) => [k, incident[k]])) : null;
  try {
    const ok = await schrijfAtomair(HAPER_BESTAND, JSON.stringify({ box_iso: haperStaat.box ? new Date(haperStaat.box).toISOString() : null,
      bericht_iso: haperStaat.bericht ? new Date(haperStaat.bericht).toISOString() : null, vervallen: haperStaat.vervallen, incident: inc }) + '\n');
    if (!ok) haperVuil = true;
    return ok;
  } finally { haperBewaarBezig = false; }
}
function haperLaad(j) {
  haperStaat = { box: Date.parse(j.box_iso) || 0, bericht: Date.parse(j.bericht_iso) || 0, vervallen: j.vervallen || null };
  const v = j.incident;
  if (v && Number.isFinite(v.sinds) && typeof v.reden === 'string') {
    incident = Object.assign(nieuwIncident(v.sinds, { reden: v.reden }), Object.fromEntries(INC_VELDEN.filter((k) => v[k] !== undefined).map((k) => [k, v[k]])));
    incident.gezondSinds = null; incident.boxLaatst = 0; incident.msgLaatst = 0;   // na een herstart meteen weer proberen
  }
}

// ── geheugen, bestanden ─────────────────────────────────────────────────────────────────────────────────────────────
const buf = [];          // laatste 24 u, oud → nieuw
let uitstaand = [];      // nog niet op schijf
let inVlucht = null;     // { sinds, n } zolang een schrijfpoging niet is afgerond
let laatsteSchrijfOk = null, schrijfFout = null;
let huidigBestand = null;
const sinds = Date.now();

function bestandVoor(ms) {
  const d = new Date(ms), blok = Math.floor(d.getUTCHours() / C.blokUren) * C.blokUren;
  return 'ring-' + d.toISOString().slice(0, 10).replace(/-/g, '') + '-' + String(blok).padStart(2, '0') + '.jsonl';
}
function regel(r) { const c = Object.assign({}, r); delete c.ms; return JSON.stringify(c) + '\n'; }
function schrijf() {
  if (inVlucht || !uitstaand.length) return;
  const lijst = uitstaand; uitstaand = [];
  const groepen = new Map();
  for (const r of lijst) { const n = bestandVoor(r.ms); if (!groepen.has(n)) groepen.set(n, []); groepen.get(n).push(r); }
  inVlucht = { sinds: mono(), n: lijst.length };
  const klaar = new Set();
  (async function () {
    for (const [naam, rs] of groepen) {
      await fsp.appendFile(path.join(DIR, naam), rs.map(regel).join(''));
      klaar.add(naam);
      if (naam !== huidigBestand) { huidigBestand = naam; ruimOp(); }
    }
  })().then(function () { laatsteSchrijfOk = Date.now(); schrijfFout = null; }, function (e) {
    schrijfFout = (e && e.code) || String(e && e.message || e).slice(0, 80);
    const terug = []; for (const [naam, rs] of groepen) if (!klaar.has(naam)) terug.push(...rs);
    uitstaand = terug.concat(uitstaand).slice(-C.uitstaand);
  }).finally(function () { inVlucht = null; });
}
async function ruimOp() {
  const namen = await metGrens(fsp.readdir(DIR), C.fs, null);
  if (!namen) return;
  const ring = namen.filter((n) => /^ring-\d{8}-\d{2}\.jsonl$/.test(n)).sort();
  for (const n of ring.slice(0, Math.max(0, ring.length - C.bewaar))) await metGrens(fsp.unlink(path.join(DIR, n)).then(() => true), C.fs, false);
}
async function geschiedenis() {
  const namen = await metGrens(fsp.readdir(DIR), C.fs, null);
  if (!namen) return 'map niet te lezen';
  const ring = namen.filter((n) => /^ring-\d{8}-\d{2}\.jsonl$/.test(n)).sort().slice(-Math.ceil(C.vensterMs / 3600000 / C.blokUren) - 1);
  const grens = Date.now() - C.vensterMs;
  let n = 0;
  for (const naam of ring) {
    const t = await lees(path.join(DIR, naam));
    if (t === null) return 'bestand ' + naam + ' niet binnen ' + Math.round(C.fs / 1000) + ' s te lezen';
    for (const r of t.split('\n')) {
      if (!r) continue;
      let o; try { o = JSON.parse(r); } catch (e) { continue; }
      const ms = Date.parse(o && o.t); if (!Number.isFinite(ms) || ms < grens) continue;
      o.ms = ms; buf.push(o); n++;
    }
  }
  huidigBestand = ring.length ? ring[ring.length - 1] : null;
  buf.sort((a, b) => a.ms - b.ms);
  return null;
}

// ── samenvatting (uit het geheugen) ─────────────────────────────────────────────────────────────────────────────────
function zwaarste(r) {
  if (!r || !r.d || !r.dt) return null;
  let top = null;
  for (const n of Object.keys(r.d)) { const b = r.d[n][2] / (r.dt * 1000) * 100; if (!top || b > top.bezet_pct) top = { naam: n, bezet_pct: rond(b, 10), gelezen_mb: rond(r.d[n][0] * 512 / 1048576, 10), geschreven_mb: rond(r.d[n][1] * 512 / 1048576, 10), in_flight: r.d[n][3] }; }
  return top;
}
function samenvatting() {
  const l = buf.length ? buf[buf.length - 1] : null;
  const grens = Date.now() - C.vensterMs;
  let p60 = null, p10 = null;
  for (const r of buf) {
    if (r.ms < grens || !r.io) continue;
    if (!p60 || r.io[3] > p60.io[3]) p60 = r;
    if (!p10 || r.io[2] > p10.io[2]) p10 = r;
  }
  return {
    ok: true, versie: SHA, pid: process.pid, sinds_iso: new Date(sinds).toISOString(), records_geheugen: buf.length,
    laatste: l ? { tijd: l.t, leeftijd_s: Math.round((Date.now() - l.ms) / 1000), some_avg10: l.io && l.io[0], some_avg60: l.io && l.io[1], full_avg10: l.io && l.io[2], full_avg60: l.io && l.io[3],
      load1: l.la ? l.la[0] : null, zwaarste_apparaat: zwaarste(l), fout: l.fout || null } : null,
    piek_24u: { full_avg60: p60 ? { waarde: p60.io[3], tijd: p60.t } : null, full_avg10: p10 ? { waarde: p10.io[2], tijd: p10.t } : null },
    schrijven: { uitstaand: uitstaand.length + (inVlucht ? inVlucht.n : 0), hangt_s: inVlucht ? Math.round((mono() - inVlucht.sinds) / 1000) : 0,
      laatste_ok_iso: laatsteSchrijfOk ? new Date(laatsteSchrijfOk).toISOString() : null, fout: schrijfFout },
    nvme: nvSamenvatting(), geschiedenis_fout: geschiedenisFout, ring_map: DIR
  };
}
let geschiedenisFout = null;

function luister() {
  const srv = http.createServer(function (q, res) {
    let u; try { u = new URL(q.url, 'http://x'); } catch (e) { res.writeHead(400); res.end(); return; }
    let j;
    if (u.pathname === '/samenvatting') j = samenvatting();
    else if (u.pathname === '/recent') {
      const min = Math.max(1, Math.min(1440, parseInt(u.searchParams.get('min') || '15', 10) || 15));
      const grens = Date.now() - min * 60000;
      j = { ok: true, min: min, records: buf.filter((r) => r.ms >= grens).map((r) => { const c = Object.assign({}, r); delete c.ms; return c; }), samenvatting: samenvatting() };
    } else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(j));
  });
  srv.on('error', function () {});
  fsp.unlink(SOCK).catch(() => {}).then(() => { try { srv.listen(SOCK); } catch (e) {} });
}

// ── de alarmrij ─────────────────────────────────────────────────────────────────────────────────────────────────────
let alarmSinds = null, alarmGemeld = false, laatsteAlarm = 0;
async function schrijfAtomair(p, inhoud) {
  const tmp = path.join(path.dirname(p), '.' + path.basename(p) + '.schijfdruk-' + crypto.randomBytes(4).toString('hex') + '.tmp');
  return metGrens(fsp.writeFile(tmp, inhoud).then(() => fsp.rename(tmp, p)).then(() => true), C.fs, false);
}
// De box-rij gaat via meld.js (wv3424, B81: dezelfde module als bewaker.js): vault-veilig.wijzig (symlinkveilig, mapgrendel met flock,
// opnieuw lezen als het bestand intussen veranderde; Codex MOET 2 van wv3124) in een kind-proces met time-out: een schijf die hangt, hangt
// het kind en niet deze meter, en na de time-out krijgt het kind SIGKILL (geen late landing). Vast kenmerk per incident: een rij die er al
// staat, wordt bij een volgende poging niet nog eens geschreven. De herkansing doet deze meter zelf (haperVerwerk), dus hier zonder.
let meldMod = null;
function meldInst() {
  if (meldMod) return meldMod;
  try { meldMod = require(process.env.SCHIJFDRUK_MELD || path.join(__dirname, 'meld.js')).maak({ box: BOX, bericht: BERICHT, kindMs: C.boxKindMs }); }
  catch (e) { meldMod = null; }
  return meldMod;
}
function boxRijVeilig(rij, kenmerk) {
  const m = meldInst();
  return m ? m.boxRij(rij, 'schijfdruk-' + kenmerk, { herkansing: false }) : Promise.resolve(false);
}
async function alarmRij(vanaf) {
  const nu = Date.now();
  const venster = buf.filter((r) => r.ms >= vanaf);
  const som = {};
  for (const r of venster) if (r.d && r.dt) for (const n of Object.keys(r.d)) { const s = som[n] || (som[n] = { tick: 0, ms: 0, rs: 0, ws: 0 }); s.tick += r.d[n][2]; s.ms += r.dt * 1000; s.rs += r.d[n][0]; s.ws += r.d[n][1]; }
  let top = null;
  for (const n of Object.keys(som)) { const b = som[n].ms ? som[n].tick / som[n].ms * 100 : 0; if (!top || b > top.b) top = { n: n, b: b, mb_r: som[n].rs * 512 / 1048576, mb_w: som[n].ws * 512 / 1048576 }; }
  const piek = venster.reduce((m, r) => (r.io && r.io[3] > m ? r.io[3] : m), 0);
  const l = buf[buf.length - 1];
  const o = nvOordeel(venster);   // wv3126: hapert de schijf, of komt de drukte van elders?
  const velden = [
    ['status', o.hapert ? 'open — de schijf zelf hapert (zie oordeel); kijk of de server er last van heeft' : 'open — alleen vastgelegd; geen actie nodig tenzij het terugkomt of de server er last van heeft'],
    ['oordeel', o.label + ' — ' + o.tekst],
    ['van', 'schijfdruk.js (wv3124, release ' + SHA + ')'],
    ['gemeten', 'full avg60 van /proc/pressure/io boven ' + C.alarmPct + ' % sinds ' + hhmm(vanaf) + ' (nu ' + hhmm(nu) + ', ' + Math.round((nu - vanaf) / 60000) + ' min, piek ' + piek + ' %, laatste minuut full avg10 ' + (l && l.io ? l.io[2] : '?') + ' %)' +
      (top ? '; zwaarste apparaat in dit tijdvak ' + top.n + ' (' + rond(top.b, 10) + ' % bezet, ' + rond(top.mb_r, 10) + ' MB gelezen, ' + rond(top.mb_w, 10) + ' MB geschreven)' : '; geen apparaat met IO-delta (druk komt van buiten de pod of de diskstats ontbreken)')],
    ['verloop', 'ring ' + DIR + '/ring-*.jsonl (per minuut, 42-48 u) en /health.schijfdruk; bij een ingreep van de bewaker staan de laatste 15 min in bin/bewaker-bewijs-*.json'],
    ['voorstel', o.hapert ? 'de schijf zelf hapert: zie 00_Systeem/Schijf van Olares.md; de Olares-zijde (host-log) moet de NVMe nalopen' : 'vergelijk het tijdvak met Immich/Takeout-import, back-ups en de nachtketen; bij een herhaling op hetzelfde uur de bron op de Olares-host zoeken']];
  const rij = '\n## [direct] ' + amsterdam().slice(0, 16) + ' — Schijfdruk hoog: full avg60 > ' + C.alarmPct + ' % al ' + Math.round((nu - vanaf) / 60000) + ' min' + (top ? ' (' + top.n + ')' : '') + ' — ' + o.label + ' #schijfdruk-hoog\n' +
    velden.map((v) => '- ' + v[0] + ': ' + String(v[1]).replace(/[\r\n]+/g, ' ').slice(0, 1500)).join('\n') + '\n';
  return boxRijVeilig(rij, 'hoog-' + vanaf);
}
async function alarmControle(r) {
  const hoog = r.io && r.io[3] > C.alarmPct;
  if (!hoog) { alarmSinds = null; alarmGemeld = false; return; }
  if (!alarmSinds) alarmSinds = r.ms;
  if (alarmGemeld || r.ms - alarmSinds < C.alarmMs) return;
  alarmGemeld = true;   // één poging per aaneengesloten periode
  if (r.ms - laatsteAlarm < C.alarmPauze) return;
  if (await alarmRij(alarmSinds)) {
    laatsteAlarm = r.ms;
    await schrijfAtomair(ALARM_BESTAND, JSON.stringify({ laatste_iso: new Date(r.ms).toISOString(), vanaf_iso: new Date(alarmSinds).toISOString() }) + '\n');
  }
}

// ── de lus ──────────────────────────────────────────────────────────────────────────────────────────────────────────
async function tik() {
  if (sampleBezig) return;   // de vorige meting is nog niet terug (elke lezing heeft een eigen time-out)
  sampleBezig = true;
  try {
    let r;
    if (fsOpen > MAXOPEN) {   // handelingen die vastzitten bezetten de pool: een nieuwe lezing zou erachter blijven hangen
      const wand = Date.now();
      r = { t: new Date(wand).toISOString(), fout: 'lezingen hangen (' + fsOpen + ' bestandshandelingen open)', ms: wand };
      vorige = null;   // de volgende delta zou over het gat lopen
    } else r = await monster();
    buf.push(r); while (buf.length > C.geheugen) buf.shift();
    uitstaand.push(r); if (uitstaand.length > C.uitstaand) uitstaand = uitstaand.slice(-C.uitstaand);
    schrijf();
    if (fsOpen <= MAXOPEN) {
      await alarmControle(r).catch(() => {});
      if (await slotIsVan_mij() === false) process.exit(0);   // elke tik: een verliezer van een gelijktijdige start stopt hier
    }
  } catch (e) {} finally { sampleBezig = false; }
}
function stop() {
  Promise.race([fsp.readFile(LOCK, 'utf8').then((h) => { if (JSON.parse(h).pid === process.pid) return fsp.unlink(LOCK); }), wacht(1500)])
    .catch(() => {}).finally(() => { try { fs.unlinkSync(SOCK); } catch (e) {} process.exit(0); });
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.on('uncaughtException', function () {});
process.on('unhandledRejection', function () {});

(async function () {
  if (fs.existsSync(UIT)) process.exit(0);
  if (!(await neemSlot())) process.exit(0);
  await wacht(600);   // een gelijktijdige starter kan het slot nog overschrijven (Codex MOET 3): pas luisteren als het na 600 ms nog van mij is
  if (await slotIsVan_mij() !== true) process.exit(0);
  const hp = await lees(HAPER_BESTAND, 3000);
  try { haperLaad(JSON.parse(hp)); } catch (e) {}
  const al = await lees(ALARM_BESTAND, 3000);
  try { laatsteAlarm = Date.parse(JSON.parse(al).laatste_iso) || 0; } catch (e) {}
  geschiedenisFout = await geschiedenis();
  luister();
  await nvTik();
  setInterval(function () { nvTik(); }, C.nvTik);
  await tik();
  setInterval(function () { tik(); }, C.tik);
})();
