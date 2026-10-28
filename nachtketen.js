'use strict';
/**
 * nachtketen.js — de nachtorkestrator van de pod (wv1868, Second Brain 2.0 fase 3d; ontwerp vault
 * "01_Ontwikkeling/Second Brain 2.0 - fase 3 intake, nachtketen en schrijvers (ontwerp 28-10-2026).md" § 4, Opus-review vooraf § 9).
 *
 * WAAROM. De pod-klussen van de nacht (OVIS, linter, Bibliothecaris, agenda/deadlines, veeg, zoeken, kalender) liepen elk op hun eigen
 * venster, zonder te weten of de klus vóór hen klaar was; dagrondes en veeg onthielden hun datum alleen in het geheugen, en de zoekindex
 * draaide terwijl de n8n-schrijvers (raw_input, Teams, WhatsApp-consolidatie) nog in de vault schreven. Deze module ordent ze: elke stap
 * één keer per Nederlandse datum, met een stempel per stap op schijf, wachten op de onderhoudsstand, en zoeken pas na een positieve
 * klaar-stempel van de n8n-schrijvers (of het vangnet van 06:40, dan `onvolledig`).
 *
 * HOE. maak(o) geeft { tik, info }. tik() (elke minuut uit server.js) neemt de eerste stap in lijstvolgorde die mag (start_na voorbij,
 * alle `na`-stappen eindstand, opnieuw_na voorbij, voorwaarde ga) en start er hooguit één tegelijk. Stempel in <staatMap>/<datum>.json
 * (map 0700, bestand 0600, atomair):
 *   stappen[naam] = { stand: bezig|opnieuw|klaar|fout|overgeslagen, reden, poging, start, eind, eigenaar, boot, pid, pid_start, ... }
 * - Herstart (Opus-review MOET 3): staat er `bezig` van een ander proces, dan kijkt de keten of het kindproces (pid + starttijd uit
 *   /proc) nog leeft: zo ja wachten, zo nee herhalen zolang er pogingen over zijn, daarna fout:onderbroken.
 * - Een stap is pas klaar als zijn belofte is afgehandeld (MOET 1): kindstappen hebben hun eigen harde limiet (socev-run --max-min +
 *   SIGTERM/SIGKILL), dus de keten wacht daarop. Alleen een in-process stap (o.a. de Bibliothecaris) krijgt hier een time-out: daarna
 *   fout:tijd, nooit een tweede poging zolang de eerste nog loopt, en een late uitkomst schrijft niets meer in de staat.
 * - Mislukt (ok false of uitzondering): opnieuw na herhaalNaMs (10 min) tot de pogingen op zijn, dan fout. De keten gaat door.
 * - Onderhoudsstand (o.onderhoud()) of een wachtende uitrol (o.magStarten() false, MOET 5): geen nieuwe stap; `pauze_sinds` in de staat.
 * - Einde (07:40): open stappen worden overgeslagen:te-laat (of :onderhoud), daarna afsluiten. Pod pas na het einde op zonder staat van
 *   vandaag: niets (ZOU 11). Afsluiten: één hartslag als er geen fout is, één box-rij alleen voor wat niemand anders meldt (tijd,
 *   onderbroken, uitzondering, stappen met meldtZelf false) of `onvolledig` (ZOU 10).
 * Zonder netwerk, zonder vault: alles wat de pod raakt, komt als functie binnen (stappen, hartslag, boxRij), zodat de toets het met een
 * nepklok kan draaien (test/nachtketen.sh).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BEWAAR = 14;
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;
const EIND = ['klaar', 'fout', 'overgeslagen'];

function bootId() { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (e) { return null; } }
// starttijd (klokticks sinds boot, veld 22 van /proc/<pid>/stat) — samen met pid en boot-id een vingerafdruk van één proces
function procStart(pid) {
  try {
    const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const na = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return na[19] || null;   // veld 22 = index 19 na veld 3
  } catch (e) { return null; }
}
function procLeeft(pid, start, boot) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  if (boot && bootId() && boot !== bootId()) return false;
  const s = procStart(pid);
  return !!s && (!start || s === String(start));
}

function minuten(a) { return a.uur * 60 + a.min; }
function hm(x) { return Array.isArray(x) ? x[0] * 60 + x[1] : null; }

function maak(o) {
  const staatMap = o.staatMap;
  const stappen = o.stappen || [];
  const nu = o.nu || Date.now;
  const ams = o.ams;
  const onderhoud = o.onderhoud || function () { return false; };
  const magStarten = o.magStarten || function () { return true; };
  const log = o.log || function () {};
  const fout = o.fout || function () {};
  const einde = hm(o.einde || [7, 40]);
  const herhaalNa = o.herhaalNaMs === undefined ? 600000 : o.herhaalNaMs;
  const wachtNa = o.wachtNaMs === undefined ? 180000 : o.wachtNaMs;
  const leeft = o.procLeeft || procLeeft;
  const startVan = o.procStart || procStart;
  const boot = o.boot !== undefined ? o.boot : bootId();
  const eigenaar = process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const namen = new Set();
  stappen.forEach(function (s) {
    if (!s || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(s.naam || '') || namen.has(s.naam)) throw new Error('nachtketen: ongeldige of dubbele stapnaam ' + (s && s.naam));
    (s.na || []).forEach(function (n) { if (!namen.has(n)) throw new Error('nachtketen: ' + s.naam + ' wacht op onbekende of latere stap ' + n); });
    namen.add(s.naam);
  });
  let huidig = null;          // { naam, token, start, inProces, limietMs }
  const hangend = {};         // naam -> true zolang een in-process stap na zijn time-out nog niet terug is

  function pad(datum) { return path.join(staatMap, datum + '.json'); }
  function lees(datum) {
    try { const s = JSON.parse(fs.readFileSync(pad(datum), 'utf8')); return s && typeof s === 'object' && s.stappen ? s : null; } catch (e) { return null; }
  }
  function schrijf(s) {
    fs.mkdirSync(staatMap, { recursive: true, mode: 0o700 });
    const tmp = pad(s.datum) + '.' + crypto.randomBytes(4).toString('hex') + '.nieuw';
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, pad(s.datum));
  }
  function iso(ms) { return new Date(ms).toISOString(); }
  function opruimen() {
    try {
      const alle = fs.readdirSync(staatMap).filter(function (n) { return /^\d{4}-\d{2}-\d{2}\.json$/.test(n); }).sort();
      alle.slice(0, Math.max(0, alle.length - BEWAAR)).forEach(function (n) { try { fs.unlinkSync(path.join(staatMap, n)); } catch (e) {} });
      fs.readdirSync(staatMap).filter(function (n) { return /\.nieuw$/.test(n); }).forEach(function (n) {
        const p = path.join(staatMap, n);
        try { if (nu() - fs.statSync(p).mtimeMs > 86400000) fs.unlinkSync(p); } catch (e) {}
      });
    } catch (e) { fout('nachtketen-opruim', e); }
  }

  // Sluit de stap af (alleen als het token nog van deze ronde is: een late uitkomst na fout:tijd schrijft niets)
  function rond(datum, stap, token, r, notitie) {
    const s = lees(datum);
    const st = s && s.stappen[stap.naam];
    if (!st || st.token !== token) return;
    const t = nu();
    delete st.token; delete st.pid; delete st.pid_start;
    st.eind = iso(t); st.ms = t - Date.parse(st.start);
    if (notitie) st.notitie = notitie;
    if (r && r.wacht) {   // de stap kon (nog) niet: niet als poging tellen
      st.stand = 'opnieuw'; st.poging = Math.max(0, (st.poging || 1) - 1); st.reden = 'wacht: ' + String(r.wacht).slice(0, 80); st.opnieuw_na = iso(t + wachtNa);
    } else if (r && r.ok) {
      st.stand = 'klaar'; delete st.reden; delete st.opnieuw_na;
      if (r.al_gedaan) st.al_gedaan = true;
      if (r.onvolledig) st.onvolledig = String(r.onvolledig).slice(0, 120);
      if (r.detail) st.detail = r.detail;
    } else {
      const reden = String(r && r.reden || 'mislukt').slice(0, 120);
      if (r && r.detail) st.detail = r.detail;
      st.laatste_fout = reden;
      if (r && r.meld) st.meld = true;   // uitzondering/tijd/onderbroken: niemand anders meldt het
      if ((st.poging || 1) < (stap.pogingen || 1)) { st.stand = 'opnieuw'; st.reden = reden; st.opnieuw_na = iso(t + herhaalNa); }
      else { st.stand = 'fout'; st.reden = reden; delete st.opnieuw_na; }
    }
    schrijf(s);
    log('nachtketen stap=' + stap.naam + ' stand=' + st.stand + (st.reden ? ' reden=' + st.reden.replace(/\s+/g, '_').slice(0, 60) : '') + ' poging=' + st.poging + ' ms=' + st.ms);
  }

  async function start(s, stap, a, notitie, onvolledig) {
    const t = nu(), token = crypto.randomBytes(6).toString('hex');
    const vorig = s.stappen[stap.naam] || {};
    s.stappen[stap.naam] = { stand: 'bezig', poging: (vorig.poging || 0) + 1, start: iso(t), eigenaar: eigenaar, boot: boot, token: token };
    if (vorig.laatste_fout) s.stappen[stap.naam].laatste_fout = vorig.laatste_fout;
    schrijf(s);
    const datum = s.datum;
    huidig = { naam: stap.naam, token: token, start: t, inProces: !!stap.inProces, limietMs: (stap.limiet_min || 15) * 60000, datum: datum };
    const ctx = {
      ams: a, datum: datum, poging: s.stappen[stap.naam].poging,
      // kindstap: pid + starttijd in de stempel, zodat een herstart een levende wees ziet (MOET 3)
      opSpawn: function (pid) {
        try {
          const x = lees(datum), st = x && x.stappen[stap.naam];
          if (!st || st.token !== token) return;
          st.pid = pid; st.pid_start = startVan(pid);
          schrijf(x);
        } catch (e) { fout('nachtketen-pid', e); }
      }
    };
    let r;
    try { r = await stap.doe(ctx); }
    catch (e) { fout('nachtketen-' + stap.naam, e); r = { ok: false, reden: 'uitzondering: ' + String(e && e.message || e).slice(0, 100), meld: true }; }
    if (r && r.ok && onvolledig) r.onvolledig = onvolledig;
    if (huidig && huidig.token === token) huidig = null;
    if (hangend[stap.naam]) { delete hangend[stap.naam]; log('nachtketen stap=' + stap.naam + ' laat-terug ok=' + (r && r.ok ? 1 : 0)); return; }
    rond(datum, stap, token, r, notitie);
  }

  function afsluiten(s, reden) {
    const fouten = [], meld = [];
    let klaar = 0, onvolledig = null;
    stappen.forEach(function (stap) {
      const st = s.stappen[stap.naam];
      if (!st) return;
      if (st.stand === 'klaar') { klaar++; if (st.onvolledig) onvolledig = st.onvolledig; }
      if (st.stand === 'fout') { fouten.push({ naam: stap.naam, reden: st.reden }); if (st.meld || stap.meldtZelf === false) meld.push({ naam: stap.naam, reden: st.reden }); }
    });
    s.afgesloten = iso(nu());
    s.samenvatting = { klaar: klaar, fout: fouten.length, onvolledig: onvolledig, overgeslagen: stappen.filter(function (x) { return s.stappen[x.naam] && s.stappen[x.naam].stand === 'overgeslagen'; }).length, reden: reden || null };
    schrijf(s);
    log('nachtketen afgesloten datum=' + s.datum + ' klaar=' + klaar + ' fout=' + fouten.length + ' onvolledig=' + (onvolledig ? 1 : 0));
    const sam = { datum: s.datum, klaar: klaar, fouten: fouten, meld: meld, onvolledig: onvolledig, stappen: s.stappen };
    if (!fouten.length && o.hartslag) Promise.resolve().then(function () { return o.hartslag(sam); }).catch(function (e) { fout('nachtketen-hartslag', e); });
    if ((meld.length || onvolledig) && o.boxRij) { try { o.boxRij(sam); } catch (e) { fout('nachtketen-box', e); } }
    opruimen();
  }

  let tikt = false;
  async function tik() {
    if (tikt) return null;   // een tik die nog op n8n wacht: geen tweede ernaast
    tikt = true;
    try { return await tikBinnen(); } finally { tikt = false; }
  }
  async function tikBinnen() {
    const t = nu();
    // in-process stap over zijn limiet: fout:tijd, keten gaat door; de stap zelf krijgt geen tweede poging zolang hij hangt (MOET 1)
    if (huidig) {
      if (huidig.inProces && t - huidig.start > huidig.limietMs) {
        const h = huidig; huidig = null; hangend[h.naam] = true;
        const s = lees(h.datum), st = s && s.stappen[h.naam];
        if (st && st.token === h.token) {
          delete st.token; st.stand = 'fout'; st.reden = 'tijd'; st.meld = true; st.eind = iso(t); st.ms = t - h.start; delete st.opnieuw_na;
          schrijf(s);
          log('nachtketen stap=' + h.naam + ' stand=fout reden=tijd');
        }
      }
      return { bezig: huidig ? huidig.naam : null };
    }
    const a = ams();
    if (!a || !DATUM_RE.test(a.datum)) return null;
    let s = lees(a.datum);
    const m = minuten(a);
    if (m >= einde) {
      if (!s || s.afgesloten) return null;   // ZOU 11: geen staat van vandaag = niets starten, niets melden
      const reden = onderhoud() ? 'onderhoud' : 'te-laat';
      let leeftNog = false;
      stappen.forEach(function (stap) {
        const st = s.stappen[stap.naam];
        if (st && st.stand === 'bezig' && st.eigenaar !== eigenaar && leeft(st.pid, st.pid_start, st.boot)) { leeftNog = true; return; }
        if (!st || EIND.indexOf(st.stand) < 0) s.stappen[stap.naam] = Object.assign({}, st || {}, { stand: 'overgeslagen', reden: reden });
      });
      if (leeftNog) return { wacht: 'wees' };
      afsluiten(s, reden);
      return { afgesloten: true };
    }
    if (!s) s = { datum: a.datum, stappen: {} };
    if (s.afgesloten) return null;
    // herstart: bezig van een ander proces → wees leeft = wachten; anders opnieuw (of fout:onderbroken)
    let veranderd = false;
    for (const stap of stappen) {
      const st = s.stappen[stap.naam];
      if (!st || st.stand !== 'bezig' || st.eigenaar === eigenaar) continue;
      if (leeft(st.pid, st.pid_start, st.boot)) return { wacht: 'wees ' + stap.naam };
      delete st.token; delete st.pid; delete st.pid_start;
      st.laatste_fout = 'onderbroken';
      if ((st.poging || 1) < (stap.pogingen || 1)) { st.stand = 'opnieuw'; st.reden = 'onderbroken'; st.opnieuw_na = iso(t); }
      else { st.stand = 'fout'; st.reden = 'onderbroken'; st.meld = true; }
      veranderd = true;
      log('nachtketen stap=' + stap.naam + ' na-herstart=' + st.stand);
    }
    const ohd = !!onderhoud();
    if (ohd || !magStarten()) {
      if (ohd && !s.pauze_sinds) { s.pauze_sinds = iso(t); veranderd = true; }
      if (veranderd && Object.keys(s.stappen).length) schrijf(s);
      return { pauze: ohd ? 'onderhoud' : 'uitrol' };
    }
    if (s.pauze_sinds) { s.pauzes = (s.pauzes || []).concat([{ van: s.pauze_sinds, tot: iso(t) }]).slice(-10); delete s.pauze_sinds; veranderd = true; }
    if (veranderd) schrijf(s);
    let alleEind = true;
    for (const stap of stappen) {
      const st = s.stappen[stap.naam];
      if (st && EIND.indexOf(st.stand) >= 0) continue;
      alleEind = false;
      if (hangend[stap.naam]) continue;
      if (stap.start_na && m < hm(stap.start_na)) continue;
      if ((stap.na || []).some(function (n) { const x = s.stappen[n]; return !x || EIND.indexOf(x.stand) < 0; })) continue;
      if (st && st.opnieuw_na && t < Date.parse(st.opnieuw_na)) continue;
      let v = { ga: true };
      if (stap.voorwaarde) {
        try { v = await stap.voorwaarde({ ams: a, datum: a.datum }) || { wacht: 'geen antwoord' }; }
        catch (e) { v = { wacht: 'voorwaarde: ' + String(e && e.message || e).slice(0, 80) }; }
        if (huidig) return { bezig: huidig.naam };   // een andere tik startte intussen
        if (!v.ga) {
          const x = lees(a.datum) || s;
          x.stappen[stap.naam] = Object.assign({}, x.stappen[stap.naam] || {}, { stand: 'opnieuw', reden: 'wacht: ' + String(v.wacht || '').slice(0, 100), opnieuw_na: iso(t + wachtNa) });
          if (!x.stappen[stap.naam].poging) x.stappen[stap.naam].poging = 0;
          schrijf(x); s = x;
          continue;
        }
        s = lees(a.datum) || s;
      }
      start(s, stap, a, v.notitie || null, v.onvolledig || null).catch(function (e) { fout('nachtketen-start', e); if (huidig && huidig.naam === stap.naam) huidig = null; });
      return { gestart: stap.naam };
    }
    if (alleEind && stappen.length && Object.keys(s.stappen).length) { afsluiten(s, null); return { afgesloten: true }; }
    return null;
  }

  function info() {
    const a = ams && ams();
    const s = a && DATUM_RE.test(a.datum) ? lees(a.datum) : null;
    const kort = {};
    if (s) Object.keys(s.stappen).forEach(function (n) { const st = s.stappen[n]; kort[n] = st.stand + (st.reden ? ':' + String(st.reden).slice(0, 40) : '') + (st.al_gedaan ? ':al_gedaan' : ''); });
    return { aan: true, lopend: huidig ? 1 : 0, stap: huidig ? huidig.naam : null, hangend: Object.keys(hangend), datum: s ? s.datum : (a && a.datum) || null,
      stappen: kort, afgesloten: s ? s.afgesloten || null : null, samenvatting: s ? s.samenvatting || null : null, pauze_sinds: s ? s.pauze_sinds || null : null };
  }

  return { tik: tik, info: info, _lees: lees };
}

// ── n8n-klaar (§ 4.2): de n8n-schrijvers van vannacht zijn af ──
// lijst: [{ id, naam, vanaf: [uur, min] }]; haal(pad) → Promise<json> (GET op /api/v1); amsVan(iso) → {datum, uur, min}.
// Klaar per workflow = geen run in status running/waiting en een afgeronde run (stoppedAt, status success|error|crashed|canceled, mode
// niet manual) die vandaag (Nederlandse tijd) op of na `vanaf` begon; een inactieve workflow telt als klaar (notitie). Opus-review ZOU 7:
// de raw_input-lus kan na te lang pollen "success" geven terwijl de beurt nog loopt: daarom ook podBezig() (een lopende /run-beurt in
// het kanaal van de nachtrij) = niet klaar.
async function n8nKlaar(lijst, haal, a, amsVan, podBezig) {
  const open = [], notities = [];
  for (const w of lijst) {
    let wf;
    try { wf = await haal('/workflows/' + encodeURIComponent(w.id)); } catch (e) { return { klaar: false, reden: 'n8n niet te lezen (' + String(e && e.message || e).slice(0, 40) + ')' }; }
    if (wf && wf.active === false) { notities.push(w.naam + ' inactief'); continue; }
    let lopend, runs;
    try {
      lopend = await haal('/executions?workflowId=' + encodeURIComponent(w.id) + '&status=running&limit=5');
      runs = await haal('/executions?workflowId=' + encodeURIComponent(w.id) + '&limit=10');
    } catch (e) { return { klaar: false, reden: 'n8n niet te lezen (' + String(e && e.message || e).slice(0, 40) + ')' }; }
    const lijstRuns = (runs && runs.data) || [];
    if (((lopend && lopend.data) || []).length || lijstRuns.some(function (x) { return ['running', 'waiting', 'new'].indexOf(x.status) >= 0; })) { open.push(w.naam + ' loopt'); continue; }
    const af = lijstRuns.some(function (x) {
      if (!x || !x.stoppedAt || x.mode === 'manual' || ['success', 'error', 'crashed', 'canceled'].indexOf(x.status) < 0) return false;
      const s = amsVan(x.startedAt);
      return s && s.datum === a.datum && minuten(s) >= hm(w.vanaf);
    });
    if (!af) open.push(w.naam + ' nog niet');
  }
  if (!open.length && podBezig && podBezig()) open.push('pod-beurt loopt');
  return open.length ? { klaar: false, reden: open.join(', ') } : { klaar: true, notitie: notities.join(', ') || null };
}

module.exports = { maak: maak, n8nKlaar: n8nKlaar, procLeeft: procLeeft, procStart: procStart, BEWAAR: BEWAAR };
