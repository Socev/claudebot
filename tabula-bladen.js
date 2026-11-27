'use strict';
// tabula-bladen.js — Apps › Tabula (wv4238, besluitenpagina nr 956 = L56 deel 1, David Ja 25-11-2026 22:25; ontwerp
// mk-scripts/wv4238/ontwerp.md, Codex GO-MET-WIJZIGINGEN). De bladen van Davids kladblok op de telefoon: lijst (nieuwste boven),
// een blad lezen, zoeken in alle bladen, en één regel "vang iets" die de Worker zelf in het Inbox-blad zet.
//
// Bron: tabula.socev.dev met de lezercode (rol lezer: alleen /pull, /hello en /vang; de Worker weigert al het andere). De pod
// bewaart niets op schijf: bladen en vlaggen staan alleen in het geheugen, bijgewerkt bij een opening (hooguit eens per 10 s).
// Herbouwen volgt Tabula (Store.Parse, Replay.Fits/Apply): bundels per blad op volgorde, een gebeurtenis die niet past wordt
// overgeslagen. Posities in UTF-16-eenheden (C# en JS tellen hetzelfde).
// Puur rekenwerk + fetch via o.fetch; geen sleutel in log of antwoord. Toets: test/tabula-bladen.test.js (verzonnen bundels).

const PULL_RONDES = 60;              // 60 × 60 bundels per opening; meer = de rest bij de volgende opening
const VERS_MS = 10000;
const VANG_MAX = 4000;
const BLAD_MAX = 12000, NIEUW_MAX = 200;   // wv4239: per blad naar de dagoogst

const terug = (t) => (t.indexOf('\\') < 0 ? t : t.replace(/\\([\s\S])/g, function (m, c) { return c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c; }));
const TICKS_1970 = 621355968000000000;
const naarMs = (ticks) => Math.round((ticks - TICKS_1970) / 10000);

// Eén bundel op een tekst toepassen. Geeft { tekst, laatst } (laatst = ms van de laatste gebeurtenis, of null).
// wv4239: voor(ms, tekst) wordt vóór elke gebeurtenis aangeroepen met het moment en de tekst zoals hij er toen stond (dagbegin).
function pasToe(tekst, body, voor) {
  let t = tekst, ticks = 0, laatst = null;
  const heel = String(body || '');
  const regels = heel.slice(0, heel.lastIndexOf('\n') + 1).split('\n');
  for (const r of regels) {
    if (r.length < 2 || r[1] !== '\t') continue;
    if (r[0] === 'S') { const d = r.split('\t'); if (/^\d+$/.test(d[1] || '')) ticks = Number(d[1]); continue; }
    if (r[0] !== 'I' && r[0] !== 'D') continue;
    const d = r.split('\t');
    if (d.length < 5 || d[3].length !== 1 || !/^-?\d+$/.test(d[1]) || !/^-?\d+$/.test(d[2])) continue;
    ticks += Number(d[1]) * 10000;
    laatst = naarMs(ticks);
    if (voor) voor(laatst, t);
    const pos = Number(d[2]), stuk = terug(d.slice(4).join('\t'));
    if (pos < 0 || stuk.length === 0) continue;
    if (r[0] === 'I') { if (pos <= t.length) t = t.slice(0, pos) + stuk + t.slice(pos); }
    else if (pos + stuk.length <= t.length) t = t.slice(0, pos) + t.slice(pos + stuk.length);
  }
  return { tekst: t, laatst: laatst };
}

// Zoals Sheet.Title in Tabula: de eerste niet-lege regel zonder Markdown-tekens, hooguit 70 tekens.
function titelVan(tekst) {
  for (const regel of String(tekst).split('\n')) {
    let t = regel.slice(0, 200).trim().replace(/^[#> ]+/, '');
    if (/^- \[[ xX]\] /.test(t)) t = t.slice(6);
    else if (/^[-*] /.test(t)) t = t.slice(2);
    t = t.replace(/\*\*/g, '').replace(/`/g, '').trim();
    if (t.length) return t.length > 70 ? t.slice(0, 70) + '…' : t;
  }
  return 'Leeg blad';
}
// blad-id yyyyMMdd-HHmmss-xxxx = moment van aanmaken (Nederlandse tijd); alleen als terugval voor 'laatst'
function aangemaaktVan(id) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(id || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 3600000 : 0;
}
// wv4239: NL-kalenderdag (JJJJ-MM-DD) van een moment in ms
const NL_DAG = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' });
const nlDag = (ms) => NL_DAG.format(new Date(ms));
// wv4240: bladen die de pod klaarzet (Worker POST /blad, alleen deze reeks)
const OVERLEG_RE = /^overleg-\d{8}-[0-9a-f]{8}$/;
// wv4239: regels die in 'nu' staan en niet (zo vaak) in 'toen': nieuw of gewijzigd. Lege regels tellen niet.
function nieuweRegels(toen, nu) {
  const tel = new Map();
  for (const r of String(toen).split('\n')) { const k = r.trim(); if (k) tel.set(k, (tel.get(k) || 0) + 1); }
  const uit = [];
  for (const r of String(nu).split('\n')) {
    const k = r.trim();
    if (!k) continue;
    const n = tel.get(k) || 0;
    if (n > 0) tel.set(k, n - 1); else uit.push(r.replace(/\s+$/, ''));
  }
  return uit;
}
const plat = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function maak(o) {
  const basis = String(o.basis || 'https://tabula.socev.dev').replace(/\/+$/, '');
  const doeFetch = o.fetch;
  const nu = o.nu || Date.now;
  let staat = null;   // { code, cursor, vcursor, bladen: Map id → { tekst, laatst }, vlaggen: Map id → { archief, vast }, op }
  let bezig = null;

  async function vraag(code, pad, opt) {
    const o2 = opt || {};
    const r = await doeFetch(basis + pad, { method: o2.method || 'GET', body: o2.body,
      headers: Object.assign({ authorization: 'Bearer ' + code, 'user-agent': 'socev-tabula-lezer/1' }, o2.headers || {}), signal: AbortSignal.timeout(20000) });
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    return { status: r.status, j: j };
  }

  async function bijwerken(code) {
    if (!staat || staat.code !== code) staat = { code: code, cursor: 0, vcursor: 0, bladen: new Map(), vlaggen: new Map(), op: 0 };
    const s = staat;
    for (let i = 0; i < PULL_RONDES; i++) {
      const r = await vraag(code, '/pull?since=' + s.cursor + '&vsince=' + s.vcursor);
      if (r.status === 401) { const e = new Error('lezercode geweigerd'); e.code = 'ingetrokken'; throw e; }
      if (r.status !== 200 || !r.j || !Array.isArray(r.j.batches)) throw new Error('pull gaf HTTP ' + r.status);
      for (const b of r.j.batches) {
        if (!b || typeof b.sheet !== 'string' || typeof b.body !== 'string' || !Number.isSafeInteger(b.id)) continue;
        const blad = s.bladen.get(b.sheet) || { tekst: '', laatst: 0, seq: 0 };
        if (b.seq === blad.seq + 1) {   // zelfde regel als ApplyBatch: alleen de eerstvolgende bundel
          // wv4239: dagbegin = de tekst vlak vóór de eerste gebeurtenis van een (latere) NL-dag; alleen in het geheugen
          const u = pasToe(blad.tekst, b.body, function (ms, t) { const d = nlDag(ms); if (!blad.dagbegin || d > blad.dagbegin.dag) blad.dagbegin = { dag: d, tekst: t }; });
          blad.tekst = u.tekst; blad.seq = b.seq; if (u.laatst && u.laatst > blad.laatst) blad.laatst = u.laatst;
          if (b.seq === 1 && OVERLEG_RE.test(b.sheet)) blad.klaargezet = u.tekst;   // wv4240: tekst die de pod klaarzette (overlegblad) is niet door David getypt
        }
        s.bladen.set(b.sheet, blad);
        if (b.id > s.cursor) s.cursor = b.id;
      }
      for (const v of (Array.isArray(r.j.flags) ? r.j.flags : [])) {
        if (!v || typeof v.sheet !== 'string' || !Number.isSafeInteger(v.id)) continue;
        const f = s.vlaggen.get(v.sheet) || { archief: false, vast: false };
        if (v.key === 'archief') f.archief = v.value === '1';
        if (v.key === 'vast') f.vast = v.value === '1';
        s.vlaggen.set(v.sheet, f);
        if (v.id > s.vcursor) s.vcursor = v.id;
      }
      if (!r.j.more && !(Array.isArray(r.j.flags) && r.j.flags.length >= 500)) break;
    }
    s.op = nu();
    return s;
  }

  // Eén bijwerkronde tegelijk; binnen 10 s na de vorige niet opnieuw (tenzij vers = true, na een vangst).
  async function stand(code, vers) {
    if (staat && staat.code === code && !vers && nu() - staat.op < VERS_MS) return staat;
    if (bezig) return bezig;
    bezig = bijwerken(code).finally(function () { bezig = null; });
    return bezig;
  }

  function info(s, id) {
    const b = s.bladen.get(id), f = s.vlaggen.get(id) || { archief: false, vast: false };
    return { id: id, titel: titelVan(b.tekst), regels: b.tekst ? b.tekst.split('\n').length : 0, tekens: b.tekst.length,
      laatst: b.laatst || aangemaaktVan(id), gesloten: f.archief, vast: f.vast, inbox: b.tekst.indexOf('# Inbox\n') === 0 };
  }

  async function lijst(code) {
    const s = await stand(code);
    const bladen = [];
    for (const id of s.bladen.keys()) { if (s.bladen.get(id).tekst.trim().length) bladen.push(info(s, id)); }
    bladen.sort(function (a, b) { return (b.vast && !b.gesloten) - (a.vast && !a.gesloten) || b.laatst - a.laatst; });
    return { bladen: bladen };
  }

  async function blad(code, id) {
    const s = await stand(code);
    if (typeof id !== 'string' || !s.bladen.has(id)) return null;
    return Object.assign(info(s, id), { tekst: s.bladen.get(id).tekst });
  }

  // Alle woorden (hoofdletter- en accentongevoelig) moeten in het blad staan; per blad hooguit 3 regels met een treffer.
  async function zoek(code, q) {
    const woorden = plat(String(q || '')).split(/\s+/).filter(Boolean).slice(0, 8);
    if (!woorden.length) return { treffers: [] };
    const s = await stand(code);
    const treffers = [];
    for (const id of s.bladen.keys()) {
      const t = s.bladen.get(id).tekst, p = plat(t);
      if (!t.trim() || !woorden.every(function (w) { return p.indexOf(w) >= 0; })) continue;
      const stukjes = [];
      for (const regel of t.split('\n')) {
        const pr = plat(regel), w = woorden.find(function (x) { return pr.indexOf(x) >= 0; });
        if (!w) continue;
        const i = pr.indexOf(w), van = Math.max(0, i - 60);
        stukjes.push((van > 0 ? '…' : '') + regel.slice(van, van + 160).trim() + (regel.length > van + 160 ? '…' : ''));
        if (stukjes.length >= 3) break;
      }
      treffers.push(Object.assign(info(s, id), { stukjes: stukjes }));
    }
    treffers.sort(function (a, b) { return b.laatst - a.laatst; });
    return { treffers: treffers.slice(0, 50), woorden: woorden.length };
  }

  async function vang(code, tekst) {
    const t = typeof tekst === 'string' ? tekst.replace(/\r\n?/g, '\n').trim() : '';
    if (!t.length || t.length > VANG_MAX) return { ok: false, status: 400, fout: 'tekst ontbreekt of is te lang (hooguit ' + VANG_MAX + ' tekens)' };
    const r = await vraag(code, '/vang', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tekst: t }) });
    if (r.status === 401) return { ok: false, status: 401, fout: 'de koppeling met Tabula is ingetrokken; koppel opnieuw' };
    if (r.status === 429) return { ok: false, status: 429, fout: 'te veel vangsten dit uur' };
    if (r.status !== 200 || !r.j || r.j.ok !== true) return { ok: false, status: 502, fout: (r.j && (r.j.error || r.j.fout)) || 'Tabula nam de vangst niet aan (HTTP ' + r.status + ')' };
    try { await stand(code, true); } catch (e) { /* de vangst staat er; de lijst volgt bij de volgende opening */ }
    return { ok: true, blad: r.j.sheet, nieuw: !!r.j.nieuw };
  }

  // Koppelcode van de pc (OVIS › Koppel een andere pc) inwisselen voor een eigen lezercode. Geeft de code terug (de aanroeper bewaart hem).
  async function koppel(koppelcode) {
    const c = String(koppelcode || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
    if (c.length !== 10) return { ok: false, status: 400, fout: 'de koppelcode heeft 10 tekens, zoals ABCDE-FGHJK' };
    const r = await doeFetch(basis + '/koppel/aanmelden', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'socev-tabula-lezer/1' }, body: JSON.stringify({ code: c, soort: 'lezer', name: 'telefoon' }) });
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    if (r.status === 403) return { ok: false, status: 403, fout: 'deze koppelcode is onbekend of verlopen (een kwartier geldig); maak op je pc een nieuwe' };
    if (r.status !== 200 || !j || typeof j.code !== 'string' || !/^[A-Za-z0-9_-]{30,100}$/.test(j.code)) return { ok: false, status: 502, fout: 'Tabula gaf geen code terug (HTTP ' + r.status + ')' };
    return { ok: true, code: j.code, naam: typeof j.name === 'string' ? j.name : 'telefoon' };
  }

  async function werkt(code) {
    const r = await vraag(code, '/hello');
    return r.status === 200;
  }

  // wv4239 (dagoogst): de bladen met gebeurtenissen op NL-dag 'dag' (JJJJ-MM-DD): tekst (afgekapt) en de regels die die dag nieuw of
  // gewijzigd zijn. Alleen bladen met minstens één nieuwe regel. Geeft { bladen: [{ id, titel, gesloten, tekst, nieuw }] }.
  async function vandaag(code, dag) {
    const s = await stand(code, true);
    const uit = [];
    for (const id of s.bladen.keys()) {
      const b = s.bladen.get(id);
      if (!b.dagbegin || b.dagbegin.dag !== dag || !b.tekst.trim()) continue;
      // wv4240: op de dag dat de pod een overlegblad klaarzette, telt alleen wat David daarna typte (anders komen agenda en actiepunten
      // als 'nieuw' in de dagoogst terug)
      const nieuw = nieuweRegels(typeof b.klaargezet === 'string' && b.dagbegin.tekst === '' ? b.klaargezet : b.dagbegin.tekst, b.tekst);
      if (!nieuw.length) continue;
      const f = s.vlaggen.get(id) || { archief: false };
      uit.push({ id: id, titel: titelVan(b.tekst), gesloten: !!f.archief, tekst: b.tekst.slice(0, BLAD_MAX), nieuw: nieuw.slice(0, NIEUW_MAX).map(function (r) { return r.slice(0, 1000); }) });
    }
    return { bladen: uit };
  }

  function vergeet() { staat = null; }
  function health() { return staat ? { bladen: staat.bladen.size, bijgewerkt: staat.op ? new Date(staat.op).toISOString() : null } : { bladen: null }; }

  return { lijst, blad, zoek, vang, koppel, werkt, vergeet, health, vandaag };
}

module.exports = { maak, pasToe, titelVan, VANG_MAX, nieuweRegels, nlDag };
