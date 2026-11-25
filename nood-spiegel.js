'use strict';
/**
 * nood-spiegel.js — de pod spiegelt naar de Worker socev-nood (wv3909, fase 1f/1g, 25-11-2026; bouwplan vault 01_Ontwikkeling/App blijft
 * werken als Olares plat ligt (bouwplan 22-11-2026).md § 4.1 punt 4 en 6, § 4.2 punt 3, § 4.3; contract mk-scripts/wv3909/contract.md).
 *
 * WAAROM. Als Olares plat ligt, moet David vanaf Cloudflare kunnen omschakelen met zijn vingerafdruk, en moet Cloudflare hem een seintje
 * kunnen sturen. Daarvoor kent socev-nood (D1, EU) de PUBLIEKE sleutels van zijn passkeys, de push-adressen en de hash van de
 * sleutelbundel, en ziet hij of de pod leeft. De pod schrijft; hij leest daar nooit iets terug behalve een geplande wissel die op zijn
 * handtekening wacht.
 *
 * WAT.
 *   - Elke 60 s POST /pod/spiegel {kant, rol, versie} = hartslag (ook passief).
 *   - Alleen als primair (rolPrimair met lease) en alleen bij een wijziging (sha256 van de lijsten) of elke 6 u: passkeys (actieve
 *     apparaten met credential), push (endpoints van actieve apparaten, zelfde poort als de pod) en bundel_sha256
 *     (/opt/data/uitwijk-warm/geheimen.sha256). Nooit een lege passkeylijst (dan het veld weg). Elke 10 s peilen: wijzigt de
 *     projectie van register/push/bundel, dan meteen een ronde (± 10 s).
 *   - Antwoord met een opdracht (geplande wissel, alleen kant olares): naam 'proef' (droog) → één verse warme-staat-ronde (≤ 90 s),
 *     eindstand {droog, staat_sha256, lsn, ronde} en POST /pod/bevestig, één keer per opdracht-id (bij een netwerkfout hooguit 3
 *     pogingen met dezelfde eindstand). Naam 'echt' → alleen een logregel (vervolg); de opdracht vervalt bij de Worker vanzelf.
 *     Stopt NIET met schrijven en raakt de rol niet.
 * ZONDER SLEUTEL (/opt/data/.socev-geheim/nood-pod.key ontbreekt): geen enkele aanroep; stand() = {ingericht:false}. Het sleutelbestand
 *   staat buiten socev-app-data en buiten sleutels.tsv, dus niet in de warme bundel. De stand-in (SOCEV_ALTIJD_PASSIEF=1) doet niets.
 * Nooit een sleutel, endpoint of cookie_hash in een log of in stand(). Tijdslimiet 8 s per aanroep, geen redirect.
 *
 * Alles wat de pod raakt (rol, register, push, warme staat, databank, klok, log, fetch) komt binnen via o: test/nood-spiegel.test.js.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STANDAARD_URL = 'https://socev-nood.d-schaap.workers.dev';
const SLEUTEL_PAD = '/opt/data/.socev-geheim/nood-pod.key';
const BUNDEL_PAD = '/opt/data/uitwijk-warm/geheimen.sha256';
const STAAT_PAD = '/opt/data/uitwijk-warm/nood-spiegel.json';
const ZES_UUR = 6 * 3600e3;
const TIJD_MS = 8000;
const PEIL_MS = 10000;
const FOUT_WACHT_MS = 60000;      // na een fout peilt hij niet elke 10 s opnieuw; de gewone tik (60 s) probeert weer
const VERS_MS = 90000;            // verse warme-staat-ronde voor een droge geplande wissel
const BEVESTIG_POGINGEN = 3;
const MAX_LIJST = 30;             // zelfde grens als de Worker (geldigePasskeys/geldigePush)
const MAX_BODY = 15500;           // Worker leesBody: 16 000 tekens
// Zelfde vormen als de Worker: een lijst die hij zou weigeren (400) stuurt de pod niet.
const APP_ID = /^[a-f0-9]{16}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const OPDRACHT_ID = /^[0-9a-f]{32}$/;

function kort(t, n) { return String(t == null ? '' : t).replace(/[\u0000-\u001f]/g, ' ').slice(0, n); }
function urlOk(u) { return /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(u) || /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(u); }

function maak(o) {
  o = o || {};
  const url = String(o.url || STANDAARD_URL).replace(/\/+$/, '');
  const sleutelPad = o.sleutelPad || SLEUTEL_PAD;
  const bundelPad = o.bundelPad || BUNDEL_PAD;
  const staatPad = o.staatPad || STAAT_PAD;
  const nu = o.nu || Date.now;
  const log = o.log || function () {};
  const doeFetch = o.fetch || fetch;
  const kant = function () { try { return String(o.kant()); } catch (e) { return 'onbekend'; } };
  const primair = function () { try { return !!o.primair(); } catch (e) { return false; } };
  const versie = function () { try { return kort(o.versie ? o.versie() : '', 40) || 'onbekend'; } catch (e) { return 'onbekend'; } };
  const pushOk = function (ep) { try { return typeof o.pushOk === 'function' ? !!o.pushOk(ep) : false; } catch (e) { return false; } };

  let staat = {};
  try { staat = JSON.parse(fs.readFileSync(staatPad, 'utf8')) || {}; } catch (e) { staat = {}; }
  staat.opdrachten = staat.opdrachten && typeof staat.opdrachten === 'object' ? staat.opdrachten : {};
  const st = { ingericht: false, sleutelFout: null, bezig: false, laatstOk: null, fout: null, foutOp: 0, peilOp: 0, opdrachtBezig: null,
    opdrachtBelofte: null, aanroepen: 0, gemeldeFout: null };

  function bewaar() {
    // hooguit de 20 jongste opdrachten onthouden (één keer per id, ook na een herstart)
    const ids = Object.keys(staat.opdrachten).sort(function (a, b) { return (staat.opdrachten[b].volg || 0) - (staat.opdrachten[a].volg || 0); });
    for (const id of ids.slice(20)) delete staat.opdrachten[id];
    try {
      fs.mkdirSync(path.dirname(staatPad), { recursive: true, mode: 0o700 });
      const t = staatPad + '.tmp' + process.pid; fs.writeFileSync(t, JSON.stringify(staat), { mode: 0o600 }); fs.renameSync(t, staatPad);
    } catch (e) { log('bewaren mislukt (' + (e.code || 'fout') + ')'); }
  }

  function nieuweOpdracht(id, x) { staat.volg = (staat.volg || 0) + 1; x.volg = staat.volg; staat.opdrachten[id] = x; return x; }

  function leesSleutel() {
    let t;
    try { t = fs.readFileSync(sleutelPad, 'utf8'); }
    catch (e) { return { fout: e.code === 'ENOENT' ? null : 'sleutelbestand onleesbaar (' + (e.code || 'fout') + ')' }; }
    t = t.trim();
    if (!/^\S{32,200}$/.test(t)) return { fout: 'sleutelbestand heeft niet de vorm van een nood-podsleutel' };
    return { sleutel: t };
  }

  // Projectie van register, push en bundel; fouten (onleesbaar, te veel) gaan zonder waarden in .fouten.
  function lijsten() {
    const uit = { fouten: [] };
    let reg = null;
    try { reg = o.register(); if (!reg || !Array.isArray(reg.apparaten)) throw new Error('kapot'); } catch (e) { reg = null; uit.fouten.push('apparatenregister onleesbaar'); }
    const actief = new Set();
    if (reg) {
      const pk = [];
      for (const a of reg.apparaten) {
        if (!a || a.actief !== true || typeof a.id !== 'string' || !APP_ID.test(a.id)) continue;
        actief.add(a.id);
        const c = a.credential;
        if (!c || typeof c.id !== 'string' || c.id.length > 400 || !B64URL.test(c.id)) continue;
        if (typeof c.publicKey !== 'string' || c.publicKey.length > 800 || !B64URL.test(c.publicKey)) continue;
        if (typeof a.cookie_hash !== 'string' || !HEX64.test(a.cookie_hash)) continue;
        pk.push({ cred_id: c.id, public_key: c.publicKey, apparaat_id: a.id, cookie_hash: a.cookie_hash, naam: kort(a.naam, 60) || a.id });
      }
      pk.sort(function (x, y) { return x.apparaat_id < y.apparaat_id ? -1 : x.apparaat_id > y.apparaat_id ? 1 : (x.cred_id < y.cred_id ? -1 : 1); });
      if (pk.length > MAX_LIJST) uit.fouten.push('meer dan ' + MAX_LIJST + ' passkeys');
      else if (pk.length) uit.passkeys = pk;
      // Codex r2 MOET 1 (pod en socev-nood): geen enkel actief apparaat meer (laatste ingetrokken, ook na een noodstop) = expliciete
      // intrekking: lege lijst MET alles_ingetrokken, zodat socev-nood alle sleutels wist. Zijn er wel actieve apparaten maar geen
      // bruikbare passkey (vormfout), dan niets spiegelen en een zichtbare fout: een vormfout mag nooit alles wissen.
      else if (actief.size === 0) { uit.passkeys = []; uit.alles_ingetrokken = true; }
      else uit.fouten.push('actieve apparaten zonder bruikbare passkey: passkeys niet gespiegeld');
      let p = null;
      try { p = o.push(); if (!p || !p.apparaten || typeof p.apparaten !== 'object') throw new Error('kapot'); } catch (e) { p = null; uit.fouten.push('push.json onleesbaar'); }
      if (p) {
        const pu = [];
        for (const id of Object.keys(p.apparaten).sort()) {
          const x = p.apparaten[id];
          if (!actief.has(id) || !x || typeof x.endpoint !== 'string' || x.endpoint.length > 1000 || !pushOk(x.endpoint)) continue;
          pu.push({ apparaat_id: id, endpoint: x.endpoint });
        }
        if (pu.length > MAX_LIJST) uit.fouten.push('meer dan ' + MAX_LIJST + ' push-abonnementen');
        else uit.push = pu;   // leeg mag: geen abonnementen = geen seintjes
      }
    }
    let b = null;
    try { b = fs.readFileSync(bundelPad, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') uit.fouten.push('geheimen.sha256 onleesbaar'); }
    if (b !== null) { const m = /^([0-9a-f]{64})(\s|$)/.exec(b); if (m) uit.bundel_sha256 = m[1]; else uit.fouten.push('geheimen.sha256 ongeldig'); }
    uit.hash = crypto.createHash('sha256').update(JSON.stringify([uit.passkeys || null, uit.push === undefined ? null : uit.push, uit.bundel_sha256 || null])).digest('hex');
    return uit;
  }

  async function post(pad, body, sleutel) {
    const tekst = JSON.stringify(body);
    if (tekst.length > MAX_BODY) return { status: 0, fout: 'te groot (' + tekst.length + ' tekens)' };
    st.aanroepen++;
    const r = await doeFetch(url + pad, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(o.tijdMs || TIJD_MS),
      headers: { authorization: 'Bearer ' + sleutel, 'content-type': 'application/json', accept: 'application/json' }, body: tekst });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    return { status: r.status, j: j };
  }
  function netFout(e) { return e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'tijdslimiet (' + Math.round((o.tijdMs || TIJD_MS) / 1000) + ' s)' : 'verbinding mislukt (' + kort(e && (e.cause && e.cause.code || e.code || e.name), 30) + ')'; }
  function antwoordFout(r) {
    if (r.fout) return r.fout;
    const f = r.j && typeof r.j.fout === 'string' ? ': ' + kort(r.j.fout, 60) : '';
    return 'socev-nood ' + r.status + (r.status === 401 ? ' (sleutel geweigerd)' : r.status === 409 ? ' (niet de actieve kant)' : '') + f;
  }
  function zetFout(f) {
    st.fout = f; st.foutOp = f ? nu() : 0;
    if (f !== st.gemeldeFout) { st.gemeldeFout = f; log(f ? 'fout: ' + f : 'weer in orde'); }   // één regel per wijziging, nooit elke minuut
  }

  // ── hartslag + lijsten ──
  async function tik() {
    if (o.standIn) return 'stand-in';
    if (st.bezig) return 'bezig';
    const k = kant();
    if (k !== 'olares' && k !== 'vps') return 'kant';
    const s = leesSleutel();
    st.ingericht = !!s.sleutel; st.sleutelFout = s.fout || null;
    if (!s.sleutel) return 'geen sleutel';
    if (!urlOk(url)) { zetFout('adres van socev-nood ongeldig'); return 'fout'; }
    st.bezig = true;
    try {
      const prim = primair();
      let body = { kant: k, rol: prim ? 'primair' : 'passief', versie: versie() };
      let l = null, met = false;
      if (prim) {
        l = lijsten();
        met = !!(l.passkeys || l.push !== undefined || l.bundel_sha256) && (l.hash !== staat.lijstHash || nu() - (staat.lijstOp || 0) >= ZES_UUR);
        if (met) {
          const mb = Object.assign({}, body);
          if (l.passkeys) { mb.passkeys = l.passkeys; if (l.alles_ingetrokken) mb.alles_ingetrokken = true; }
          if (l.push !== undefined) mb.push = l.push;
          if (l.bundel_sha256) mb.bundel_sha256 = l.bundel_sha256;
          if (JSON.stringify(mb).length > MAX_BODY) { met = false; l.fouten.push('lijsten te groot voor socev-nood'); }   // dan alleen de hartslag
          else body = mb;
        }
      }
      let r;
      try { r = await post('/pod/spiegel', body, s.sleutel); } catch (e) { zetFout(netFout(e)); return 'fout'; }
      if (r.status !== 200 || !r.j || r.j.ok !== true) { zetFout(antwoordFout(r)); return 'fout'; }
      st.laatstOk = nu();
      zetFout(l && l.fouten.length ? l.fouten.join('; ') : null);
      if (met && r.j.geschreven === true) {
        staat.lijstHash = l.hash; staat.lijstOp = nu();
        // zonder passkeys-veld houdt de Worker zijn vorige lijst: dan het oude aantal onthouden (Codex r3 MOET 1)
        const vorig = staat.geschreven ? staat.geschreven.passkeys || 0 : 0;
        staat.geschreven = { op: nu(), passkeys: l.passkeys ? l.passkeys.length : vorig, push: l.push ? l.push.length : null, bundel: !!l.bundel_sha256 };
        bewaar();
        log('lijsten geschreven: ' + staat.geschreven.passkeys + ' passkeys, ' + (staat.geschreven.push === null ? 'push niet' : staat.geschreven.push + ' push') + (staat.geschreven.bundel ? ', bundel' : ''));
      }
      if (r.j.opdracht && !st.opdrachtBezig) {
        const b = opdracht(r.j.opdracht, s.sleutel);   // los van de hartslag: de verse ronde duurt tot 90 s
        st.opdrachtBelofte = b.catch(function (e) { log('opdracht: ' + kort(e && e.message, 80)); });
      }
      return met ? (r.j.geschreven === true ? 'lijsten' : 'lijsten niet geschreven') : 'hartslag';
    } finally { st.bezig = false; }
  }

  // ── elke 10 s: wijzigde de projectie, dan meteen een ronde (alleen primair en ingericht) ──
  function peil() {
    if (o.standIn || st.bezig || !st.ingericht || !primair()) return 'stil';
    if (st.foutOp && nu() - st.foutOp < FOUT_WACHT_MS) return 'wacht';
    let l; try { l = lijsten(); } catch (e) { return 'fout'; }
    if (l.hash === staat.lijstHash) return 'gelijk';
    if (!(l.passkeys || l.push !== undefined || l.bundel_sha256)) return 'leeg';
    if (nu() - st.peilOp < PEIL_MS) return 'wacht';
    st.peilOp = nu();
    return tik();
  }

  // ── geplande wissel (alleen kant olares, primair) ──
  async function opdracht(op, sleutel) {
    if (!op || typeof op !== 'object' || typeof op.id !== 'string' || !OPDRACHT_ID.test(op.id)) return 'ongeldig';
    if (kant() !== 'olares' || !primair()) return 'niet hier';
    const id = op.id, gezien = staat.opdrachten[id];
    if (op.naam === 'echt') {
      if (!gezien) { nieuweOpdracht(id, { naam: 'echt', op: nu(), uitkomst: 'niet gebouwd' }); bewaar(); log('echte geplande wissel nog niet gebouwd (vervolg)'); }
      return 'echt';
    }
    if (op.naam !== 'proef') {
      if (!gezien) { nieuweOpdracht(id, { naam: kort(op.naam, 12), op: nu(), uitkomst: 'onbekende naam' }); bewaar(); log('geplande wissel met onbekende naam genegeerd'); }
      return 'onbekend';
    }
    // 'bezig' in het bewaarde staatbestand = een vorig proces stopte midden in de opdracht (Codex r1 MOET 3): hervatten
    if (gezien && gezien.uitkomst !== 'opnieuw' && gezien.uitkomst !== 'bezig') return 'al';
    if (gezien && (gezien.pogingen || 0) >= BEVESTIG_POGINGEN) return 'al';
    st.opdrachtBezig = id;
    try {
      let x = gezien;
      if (!x || !x.eindstand) {
        if (!x) x = nieuweOpdracht(id, { naam: 'proef', op: nu(), uitkomst: 'bezig', pogingen: 0 });
        x.uitkomst = 'bezig'; bewaar();
        log('droge geplande wissel ' + id.slice(0, 8) + ': verse warme staat');
        let ronde = null;
        if (typeof o.warmVers === 'function') {
          let t = null;
          ronde = await Promise.race([Promise.resolve().then(function () { return o.warmVers(VERS_MS); }).catch(function () { return { uitkomst: 'fout' }; }),
            new Promise(function (k) { t = setTimeout(function () { k({ uitkomst: 'te laat' }); }, o.versMs || VERS_MS); })]);
          clearTimeout(t);
        }
        let lsn = null;
        if (typeof o.lsn === 'function') { try { lsn = await o.lsn(); } catch (e) { lsn = null; } }
        // de hash alleen uit een verse ronde; te laat of zonder ronde: de laatst gedeelde kopie (ronde zegt dan hoe vers hij is)
        const staatSha = ronde && HEX64.test(String(ronde.staat_sha256 || '')) ? ronde.staat_sha256
          : (ronde && ronde.app_vers === false ? null : (typeof o.staatSha === 'function' && HEX64.test(String(o.staatSha() || '')) ? o.staatSha() : null));
        x.uitkomst = 'opnieuw';   // eindstand vast: na een herstart alleen nog de bevestiging
        x.eindstand = { droog: true, staat_sha256: staatSha, lsn: typeof lsn === 'string' && /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/.test(lsn) ? lsn : null,
          ronde: kort(ronde ? ronde.uitkomst : 'geen warme staat', 20) };
        bewaar();
      }
      if (!primair()) { x.uitkomst = 'rol kwijt'; bewaar(); return 'rol'; }
      x.pogingen = (x.pogingen || 0) + 1;
      let r;
      try { r = await post('/pod/bevestig', { opdracht_id: id, kant: 'olares', eindstand: x.eindstand }, sleutel); }
      catch (e) { r = { status: 0, fout: netFout(e) }; }
      if (r.status === 200 && r.j && r.j.ok === true) x.uitkomst = 'bevestigd';
      else if ((r.status === 0 || r.status >= 500) && x.pogingen < BEVESTIG_POGINGEN) x.uitkomst = 'opnieuw';
      else x.uitkomst = 'geweigerd: ' + antwoordFout(r).slice(0, 60);
      x.klaar_op = nu(); bewaar();
      log('droge geplande wissel ' + id.slice(0, 8) + ': ' + x.uitkomst);
      return x.uitkomst;
    } finally { st.opdrachtBezig = null; }
  }

  function stand() {
    const iso = function (t) { return t ? new Date(t).toISOString() : null; };
    if (o.standIn) return { ingericht: false, stand_in: true };
    const ids = Object.keys(staat.opdrachten).sort(function (a, b) { return (staat.opdrachten[b].volg || 0) - (staat.opdrachten[a].volg || 0); });
    const laatste = ids.length ? staat.opdrachten[ids[0]] : null;
    return { ingericht: st.ingericht, sleutel_fout: st.sleutelFout || undefined, laatst_ok: iso(st.laatstOk), laatste_fout: st.fout || null,
      lijsten_geschreven_op: iso(staat.geschreven && staat.geschreven.op), lijsten: staat.geschreven ? { passkeys: staat.geschreven.passkeys, push: staat.geschreven.push, bundel: staat.geschreven.bundel } : undefined,
      aanroepen: st.aanroepen, opdracht: laatste ? { id: ids[0].slice(0, 8), naam: laatste.naam, uitkomst: laatste.uitkomst, op: iso(laatste.op) } : undefined };
  }

  return { tik: tik, peil: peil, stand: stand, _lijsten: lijsten, _opdracht: opdracht, _wacht: function () { return st.opdrachtBelofte || Promise.resolve(); } };
}

module.exports = { maak: maak, STANDAARD_URL: STANDAARD_URL, SLEUTEL_PAD: SLEUTEL_PAD };
