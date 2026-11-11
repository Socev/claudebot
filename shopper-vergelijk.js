'use strict';
/*
 * shopper-vergelijk.js — OVIS Shopper fase 2 "Snel vergelijken" (wv2934, 11-11-2026; plan vault "01_Ontwikkeling/OVIS Shopper naar een 8 -
 * totaalinterface (plan wv2849, 9-11-2026).md", Fable 5.2 § b4/b13). Davids Ja 11-11 16:53 (vraag-id d609499b).
 *
 * WAAROM. De grondige route (agent) duurt 10–30 minuten. Snel vergelijken geeft in ± 20 s opties met gelezen prijs, verzending en levertijd,
 * zonder taalmodel dat de eisen naleest. Proef vooraf op Davids vijf echte zoektochten (mk-scripts/shopper-proef, 11-11): met twee zoekrondes
 * (wens + eisen, en de kale wens) bij 3 van de 5 iets dat past en goedkoper was dan wat David kocht, 1 deels, 1 niet (bloeddrukmeter: alleen
 * zakmodellen); 11–20 s, $ 0,09–0,12 per vraag; van de gelezen pagina's met prijs had 23 van de 24 ook de verzendkosten.
 *
 * STROOM. start(d): {wens, aantal?, eisen[]?, refurbished?} → privacypoort (shopper.poortVrij: naam/persoonskenmerk of patiëntpoort = weigeren)
 * → plafond 20 per Nederlandse dag (in de staat, overleeft een herstart) → id terug; daarna op de achtergrond: twee zoekvragen tegelijk naar
 * de OpenAI-hulp (zoek, afnemer shopper-snel, NL, domeinfilter = favorieten die aan staan zonder vergelijkers + bol.com + amazon.nl; de hulp
 * houdt zelf de patiëntpoort, het geheimenfilter, de maandgrens en de teller) → hooguit 8 productpagina's, hooguit 4 tegelijk, met
 * winkel-lezen.py (o.lezer) → elke gelezen optie meteen in de staat (de app toont de eerste kaart zodra hij er is).
 * Alleen gelezen waarden tellen: prijs en verzending van de winkelpagina, nooit uit het zoekfragment. Een pagina waarvan de productnaam niet
 * lijkt op wat de zoekhulp noemde (proef: bol stuurde oude nummers door naar een T-shirt) gaat naar niet_gelezen met die reden, net als een
 * pagina zonder prijs: niets verdwijnt stil.
 * stand(id) → de uitkomst (24 uur bewaard in de klokken-map, daarna weg). bewaar(id, {entiteit}) → een zoektochtpagina (bron: snel,
 * status: open, geen advies: niemand las de eisen na). kandidaten(id) → de kandidaten voor de grondige agent (Fable b13).
 * zoekKandidaten({wens, aantal, eisen}) → alleen de zoekrondes (geen lezen), voor "Laat Shopper zoeken" zonder snelle ronde vooraf.
 *
 * PRIVACY. De wens staat alleen in de staat (klokken-map, 24 u) en, na Davids tik op Bewaar, op de pagina; nooit in een log of rij. Deze module
 * logt niets. Koopt nooit: alleen GET op productpagina's via het leesscript (dat zoek-, winkelwagen- en accountpaden weigert).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./shopper.js');

const MAX_WENS = 160, MAX_EIS = 200, MAX_EISEN = 20, MAX_LEES = 8, MAX_GELIJK = 4, PLAFOND_DAG = 20, BEWAAR_MS = 86400000, MAX_STAAT = 60;
const ZOEK_MS = 45000, ZOEK_MAX = 5;
const VERGELIJKERS = ['tweakers.net'];   // geen winkel: zijn productpagina's geven geen koop-link (het leesscript weigert clickout)
const ALTIJD = ['bol.com', 'amazon.nl'];
const ID_RE = /^[0-9a-f]{12}$/;
const tekst = (x, max) => { const v = String(x == null ? '' : x).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim(); return v && v !== 'null' ? v.slice(0, max) : ''; };
const getal = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x < 1e7 ? Math.round(x * 100) / 100 : null);
const nlDag = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// De twee zoekvragen (proef variant C): de wens met eisen, en de kale wens (vindt de gewone, goedkopere variant). Zonder eisen: één vraag.
function zoekVragen(g) {
  const n = g.aantal ? ' Aantal: ' + g.aantal + '.' : '';
  const ref = g.refurbished ? ' Ook refurbished of tweedehands.' : '';
  const kaal = g.wens + '.' + n + ref;
  if (!g.eisen || !g.eisen.length) return [kaal];
  return [g.wens + '.' + n + ' Eisen van de koper: ' + g.eisen.join('; ') + '.' + ref, kaal];
}
// Om en om uit de zoekrondes, dubbele links eruit
function samenvoegen(lijsten, max) {
  const uit = [], gezien = new Set();
  const m = Math.max(0, ...lijsten.map((l) => l.length));
  for (let i = 0; i < m && uit.length < max; i++) {
    for (const l of lijsten) {
      const k = l[i];
      if (!k || uit.length >= max) continue;
      const u = S.koopUrl(k.url);
      if (!u || gezien.has(u)) continue;
      gezien.add(u);
      uit.push({ url: u, winkel: tekst(k.winkel, 80), product: tekst(k.product, 200) });
    }
  }
  return uit;
}
// Lijkt de productnaam van de pagina op wat de zoekhulp noemde? Woorden van 3+ tekens; overlap ≥ 1/3 van de kortste. Zonder naam: ja.
function woorden(s) { return new Set((String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{3,}/g) || [])); }
function zelfdeProduct(a, b) {
  const x = woorden(a), y = woorden(b);
  if (!x.size || !y.size) return true;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size) >= 1 / 3;
}
// Stuks per aanbod uit de productnaam ("set van 2", "2 stuks", "3x", "duopak"); anders 1
function pakket(naam) {
  const s = String(naam || '').toLowerCase();
  let m = /\bset van (\d{1,2})\b/.exec(s) || /(?:^|[\s(,-])(\d{1,2}) ?(?:stuks|st\.|pack|pak)\b/.exec(s) || /(?:^|[\s(,])(\d{1,2}) ?x(?=\s+\p{L})/u.exec(s);
  if (m) { const n = Number(m[1]); return n >= 1 && n <= 50 ? n : 1; }
  return /\bduo ?pa(k|ck)\b/.test(s) ? 2 : 1;
}
const REFURB = /refurbished|tweedehands|renewed|gereviseerd|occasion|\bgebruikt\b/i;
// Levertijd → eerste genoemde dag (JJJJ-MM-DD, Nederlandse tijd) of null. Alleen vaste woorden; onbekend blijft onbekend.
const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const DAGEN = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
function dagPlus(dag, n) { const x = new Date(dag + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function werkdagenPlus(dag, n) { let d = dag, k = 0; while (k < n) { d = dagPlus(d, 1); const w = new Date(d + 'T12:00:00Z').getUTCDay(); if (w !== 0 && w !== 6) k++; } return d; }
function inHuis(levertijd, nu) {
  const s = String(levertijd || '').toLowerCase();
  if (!s) return null;
  const vandaag = nlDag(nu), jaar = Number(vandaag.slice(0, 4));
  const kand = [];
  const dm = new RegExp('\\b(\\d{1,2}) (' + MAANDEN.join('|') + '|' + MAANDEN.map((x) => x.slice(0, 3)).join('|') + ')\\b', 'g');
  let m;
  while ((m = dm.exec(s))) {
    const mi = MAANDEN.findIndex((x) => x === m[2] || x.slice(0, 3) === m[2]);
    let d = jaar + '-' + String(mi + 1).padStart(2, '0') + '-' + String(Number(m[1])).padStart(2, '0');
    if (d < vandaag) d = (jaar + 1) + d.slice(4);
    kand.push([m.index, d]);
  }
  const rel = [[/\bovermorgen\b/, 2], [/\bmorgen\b/, 1], [/\bvandaag\b/, 0]];
  for (const [re, n] of rel) { const r = re.exec(s); if (r && !(n === 1 && /overmorgen/.test(s.slice(Math.max(0, r.index - 4), r.index + 6)))) kand.push([r.index, dagPlus(vandaag, n)]); }
  const vw = new Date(vandaag + 'T12:00:00Z').getUTCDay();
  DAGEN.forEach((w, i) => { const r = new RegExp('\\b' + w + '\\b').exec(s); if (r) kand.push([r.index, dagPlus(vandaag, ((i - vw + 7) % 7) || 7)]); });
  const wd = /(?:(\d{1,2}) ?(?:-|tot|à|a) ?)?(\d{1,2}) ?werkdag(?:en)?/.exec(s);
  if (wd) kand.push([wd.index, werkdagenPlus(vandaag, Number(wd[2]))]);
  const wk = /(\d{1,2}) ?(?:-|tot) ?(\d{1,2}) ?weken|(\d{1,2}) ?(?:week|weken)/.exec(s);
  if (wk) kand.push([wk.index, dagPlus(vandaag, 7 * Number(wk[2] || wk[3]))]);
  if (!kand.length) return null;
  kand.sort((a, b) => a[0] - b[0]);
  return kand[0][1];
}
// Eén uitkomst van winkel-lezen.py + de kandidaat → een optie (alleen gelezen waarden) of een regel voor niet_gelezen
function optieVan(k, r, g, fav, nu) {
  const niet = (reden) => ({ niet: { winkel: k.winkel || hostNaam(k.url), product: k.product, url: k.url, reden } });
  if (!r || typeof r !== 'object' || r.url !== k.url) return niet('niet te lezen (geen antwoord van het leesscript)');
  if (r.blokkade) return niet(tekst(r.blokkade, 160));
  const prijs = getal(r.prijs_eur);
  if (prijs == null || prijs === 0) return niet('prijs niet te lezen op de pagina');
  const product = tekst(r.product, 200) || k.product;
  if (r.product && k.product && !zelfdeProduct(k.product, r.product)) return niet('de link wijst naar een ander product');
  const verz = getal(r.verzending_eur), per = pakket(product), stuks = g.aantal || 1, koop = Math.ceil(stuks / per);
  return { optie: { winkel: tekst(r.winkel !== 'anders' && r.winkel ? r.winkel : '', 40) || k.winkel || hostNaam(k.url), verkoper: tekst(r.verkoper, 80) || null,
    product, url: k.url, prijs_eur: prijs, verzending_eur: verz, verzending_tekst: verz == null ? null : tekst(r.verzending_tekst, 120) || null,
    koop_eenheid: per > 1 ? 'set van ' + per : '1 stuk', koop_aantal: koop, totaal_eur: verz == null ? null : Math.round((koop * prijs + verz) * 100) / 100,
    btw: r.btw === 'incl' ? 'incl' : r.prijs_omgerekend && /^(21|9)$/.test(String(r.btw_tarief)) ? 'omgerekend ' + r.btw_tarief + '%' : null,
    levertijd: tekst(r.levertijd, 160) || null, in_huis: inHuis(r.levertijd, nu), voorraad: tekst(r.voorraad, 120) || null,
    favoriet: S.isFavoriet(k.url, fav), refurbished: REFURB.test(product) || REFURB.test(k.url) } };
}
function hostNaam(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
// Invoer van de app toetsen (zelfde grenzen als Nieuwe zoektocht)
function invoer(d, extra) {
  const mag = ['wens', 'aantal', 'eisen', 'refurbished'].concat(extra || []);
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some((k) => mag.indexOf(k) < 0)) return { fout: 'alleen ' + mag.join(', ') };
  const wens = typeof d.wens === 'string' ? tekst(d.wens, MAX_WENS + 1) : '';
  if (!wens || wens.length > MAX_WENS) return { fout: 'wens: tekst van 1 tot ' + MAX_WENS + ' tekens' };
  let n = null;
  if (d.aantal != null && d.aantal !== '') { n = /^\d{1,4}$/.test(String(d.aantal)) && Number(d.aantal) > 0 ? Number(d.aantal) : null; if (n == null) return { fout: 'aantal: een heel getal van 1 tot 9999' }; }
  const ruw = d.eisen == null ? [] : d.eisen;
  if (!Array.isArray(ruw) || ruw.length > 50 || ruw.some((x) => typeof x !== 'string')) return { fout: 'eisen: een lijst met tekst' };
  const eisen = [];
  for (const x of ruw) { const e = tekst(x, MAX_EIS + 1); if (e.length > MAX_EIS) return { fout: 'een eis: hooguit ' + MAX_EIS + ' tekens' }; if (e) eisen.push(e); }
  if (eisen.length > MAX_EISEN) return { fout: 'hooguit ' + MAX_EISEN + ' eisen' };
  if (d.refurbished != null && typeof d.refurbished !== 'boolean') return { fout: 'refurbished: ja of nee' };
  return { g: { wens, aantal: n, eisen, refurbished: d.refurbished === true } };
}
// Bestandsnaam van een bewaarde zoektocht: "Shopper - JJJJ-MM-DD - <wens>.md" zonder tekens die een pad of link breken
function bestandsnaam(dag, wens, n) {
  const w = String(wens).replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || 'zoektocht';
  return 'Shopper - ' + dag + ' - ' + w + (n > 1 ? ' (' + n + ')' : '') + '.md';
}
function isoNl(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  const off = (/GMT([+-]\d{2}:\d{2})/.exec(p.timeZoneName || '') || [null, '+01:00'])[1];
  return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute + off;
}
const q = (x) => JSON.stringify(String(x == null ? '' : x));
const yamlOptie = (o, id) => '  - {id: ' + id + ', winkel: ' + q(o.winkel) + ', verkoper: ' + q(o.verkoper || o.winkel) + ', product: ' + q(o.product)
  + ', koop_eenheid: ' + q(o.koop_eenheid) + ', koop_aantal: ' + o.koop_aantal + ', prijs_eur: ' + o.prijs_eur.toFixed(2)
  + ', verzending_eur: ' + (o.verzending_eur == null ? 'null' : o.verzending_eur.toFixed(2)) + ', totaal_eur: ' + (o.totaal_eur == null ? 'null' : o.totaal_eur.toFixed(2))
  + (o.btw ? ', btw: ' + q(o.btw) : '') + ', levertijd: ' + q(o.levertijd || 'niet te lezen') + ', voorraad: ' + q(o.voorraad || 'niet te lezen')
  + ', voldoet: onbekend, url: ' + q(o.url) + '}';

function maak(o) {
  const nu = () => (typeof o.nu === 'function' ? o.nu() : new Date());
  const lopend = new Map();   // id → uitkomst in het geheugen (de staat op schijf is de bron na een herstart)
  let actief = 0;
  const rij = [];
  function beperkt(fn) {
    return new Promise(function (klaar) {
      const start = function () {
        actief++;
        Promise.resolve().then(fn).then((x) => x, () => null).then(function (x) { actief--; const v = rij.shift(); if (v) v(); klaar(x); });
      };
      if (actief < MAX_GELIJK) start(); else rij.push(start);
    });
  }
  function staat() {
    if (!o.staatPad) return {};
    try { const j = JSON.parse(fs.readFileSync(o.staatPad, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch (e) { return {}; }
  }
  function bewaarStaat(st) {
    if (!o.staatPad) return;
    const grens = nu().getTime() - BEWAAR_MS;
    const ids = Object.keys(st).filter((k) => ID_RE.test(k) && st[k] && Date.parse(st[k].t) >= grens).sort((a, b) => (st[a].t < st[b].t ? 1 : -1)).slice(0, MAX_STAAT);
    const uit = {};
    for (const k of ids) uit[k] = st[k];
    const tmp = o.staatPad + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(uit), { mode: 0o600 });
    fs.renameSync(tmp, o.staatPad);
  }
  // → true als de staat op schijf staat (of er geen staatbestand is); false = alleen in het geheugen
  function zet(id, u) { lopend.set(id, u); try { const st = staat(); st[id] = u; bewaarStaat(st); return true; } catch (e) { return !o.staatPad; } }
  // review ronde 1 MOET 1: na 24 uur weg, ook zonder nieuwe vraag (geheugen en schijf); elk uur en bij elke start/stand
  function opruimen() {
    const grens = nu().getTime() - BEWAAR_MS;
    for (const [k, u] of lopend) if (!u || !(Date.parse(u.t) >= grens)) lopend.delete(k);
    if (!o.staatPad) return;
    try {
      const st = staat();
      if (Object.keys(st).some((k) => !st[k] || !(Date.parse(st[k].t) >= grens))) bewaarStaat(st);
    } catch (e) { /* volgende ronde opnieuw */ }
  }
  if (o.opruimTik !== false) { const t = setInterval(opruimen, 3600000); if (t && typeof t.unref === 'function') t.unref(); }
  function haal(id) {
    if (!ID_RE.test(String(id || ''))) return null;
    const st = staat()[id] || null, m = lopend.get(id) || null;
    const u = m && (!st || (m.versie || 0) >= (st.versie || 0)) ? m : st;
    if (!u || nu().getTime() - Date.parse(u.t) > BEWAAR_MS) return null;
    return u;
  }
  function domeinen() {
    let fav = [];
    try { const t = o.vv.lees(path.join(o.vault, S.FAVORIETEN), 'utf8', { max: 256 * 1024 }); fav = S.favorietenVan(t); } catch (e) { fav = []; }
    const d = fav.filter((x) => VERGELIJKERS.indexOf(x) < 0);
    for (const x of ALTIJD) if (d.indexOf(x) < 0) d.push(x);
    return { lijst: d.slice(0, 20), fav };
  }
  // De zoekrondes (tegelijk). → { kandidaten, usd, fout? }
  async function zoekRondes(g, dom) {
    const vragen = zoekVragen(g);
    const uit = await Promise.all(vragen.map((v) => Promise.resolve().then(() => o.zoek({ afnemer: 'shopper-snel', vraag: v, domeinen: dom, max_zoek: ZOEK_MAX, ms: ZOEK_MS })).then((x) => x, () => null)));
    const ok = uit.filter((x) => x && x.ok);
    const usd = Math.round(ok.reduce((s, x) => s + (Number(x.usd) || 0), 0) * 10000) / 10000;
    if (!ok.length) {
      const st = uit.map((x) => (x && x.status) || 'fout');
      const fout = st.indexOf('poort') >= 0 || st.indexOf('geheim') >= 0 ? 'poort' : st.indexOf('grens') >= 0 || st.indexOf('cyclus') >= 0 ? 'grens' : st.indexOf('uit') >= 0 ? 'uit' : 'zoeken';
      return { kandidaten: [], usd, fout };
    }
    return { kandidaten: samenvoegen(ok.map((x) => (Array.isArray(x.kandidaten) ? x.kandidaten : [])), MAX_LEES * 2), usd };
  }
  async function draai(id, g) {
    const t0 = nu().getTime();
    const u = Object.assign({}, haal(id));
    const dom = domeinen();
    let z;
    try { z = await zoekRondes(g, dom.lijst); } catch (e) { z = { kandidaten: [], usd: 0, fout: 'zoeken' }; }
    u.usd = z.usd;
    if (z.fout) { zet(id, Object.assign(u, { stand: 'mislukt', fout: z.fout, ms: nu().getTime() - t0, versie: 2 })); return; }
    const lees = z.kandidaten.slice(0, MAX_LEES);
    Object.assign(u, { stand: 'leest', te_lezen: lees.length, kandidaten: z.kandidaten.map((k) => ({ url: k.url, winkel: k.winkel, product: k.product })), opties: [], niet_gelezen: [], versie: 3 });
    zet(id, u);
    let versie = 3;
    await Promise.all(lees.map((k) => beperkt(async function () {
      let r = null;
      try { r = await o.lezer(k.url); } catch (e) { r = null; }
      const x = optieVan(k, r, g, dom.fav, nu());
      if (x.optie) u.opties.push(Object.assign({ n: u.opties.length + 1 }, x.optie)); else u.niet_gelezen.push(x.niet);
      u.versie = ++versie;
      zet(id, u);
    })));
    u.opties.sort((a, b) => (a.totaal_eur == null) - (b.totaal_eur == null) || (a.totaal_eur || a.prijs_eur) - (b.totaal_eur || b.prijs_eur));
    zet(id, Object.assign(u, { stand: 'klaar', ms: nu().getTime() - t0, versie: ++versie }));
  }
  function start(d) {
    if (typeof o.zoek !== 'function' || typeof o.lezer !== 'function') return { status: 404, body: { ok: false, fout: 'snel vergelijken zit niet in deze versie van de pod' } };
    const v = invoer(d);
    if (v.fout) return { status: 400, body: { ok: false, fout: v.fout } };
    const g = v.g;
    if (!S.poortVrij(o.poort, [g.wens].concat(g.eisen))) return { status: 422, body: { ok: false, fout: S.POORT_FOUT, poort: true } };
    opruimen();
    const st = staat(), dag = nlDag(nu());
    const vandaag = Object.keys(st).filter((k) => st[k] && st[k].t && nlDag(new Date(st[k].t)) === dag).length
      + Array.from(lopend.keys()).filter((k) => !st[k] && nlDag(new Date(lopend.get(k).t)) === dag).length;
    if (vandaag >= PLAFOND_DAG) return { status: 429, body: { ok: false, fout: 'vandaag al ' + PLAFOND_DAG + ' keer snel vergeleken; morgen weer (of laat Shopper grondig zoeken)' } };
    const id = crypto.randomBytes(6).toString('hex');
    // review ronde 1 ZOU 1: de dagteller staat in de staat; lukt opslaan niet, dan geen betaalde zoekvraag (anders telt hij na een herstart niet mee)
    if (!zet(id, { t: nu().toISOString(), stand: 'zoekt', wens: g.wens, aantal: g.aantal, eisen: g.eisen, refurbished: g.refurbished, opties: [], niet_gelezen: [], versie: 1 })) {
      lopend.delete(id);
      return { status: 503, body: { ok: false, fout: 'Shopper kon dit nu niet bijhouden; probeer het zo opnieuw' } };
    }
    Promise.resolve().then(() => draai(id, g)).catch(function () { const u = haal(id); if (u) zet(id, Object.assign({}, u, { stand: 'mislukt', fout: 'intern', versie: 99 })); });
    return { status: 200, body: { ok: true, vergelijk: toon(id, haal(id)) } };
  }
  function toon(id, u) {
    return { id, t: u.t, stand: u.stand, fout: u.fout || null, wens: u.wens, aantal: u.aantal, eisen: u.eisen, refurbished: !!u.refurbished,
      opties: u.opties || [], niet_gelezen: u.niet_gelezen || [], te_lezen: u.te_lezen || null, usd: u.usd == null ? null : u.usd, ms: u.ms || null,
      bewaard: u.bewaard || null };
  }
  function stand(id) {
    if (!ID_RE.test(String(id || ''))) return { status: 400, body: { ok: false, fout: 'ongeldige id' } };
    opruimen();
    const u = haal(id);
    if (!u) return { status: 404, body: { ok: false, fout: 'deze vergelijking is er niet meer (na 24 uur weg); zoek opnieuw' } };
    if (u.stand !== 'klaar' && u.stand !== 'mislukt' && !lopend.has(id)) return { status: 200, body: { ok: true, vergelijk: Object.assign(toon(id, u), { stand: 'mislukt', fout: 'herstart' }) } };
    return { status: 200, body: { ok: true, vergelijk: toon(id, u) } };
  }
  // Voor de grondige agent (Fable b13): gelezen opties en de rest van de kandidaten, alleen links en wat de pod las
  function kandidaten(id) {
    const u = haal(id);
    if (!u || u.stand !== 'klaar') return null;
    const gelezen = (u.opties || []).map((x) => ({ winkel: x.winkel, product: x.product, url: x.url, prijs_eur: x.prijs_eur, verzending_eur: x.verzending_eur, levertijd: x.levertijd }));
    const rest = (u.kandidaten || []).filter((k) => !gelezen.some((x) => x.url === k.url)).map((k) => ({ winkel: k.winkel, product: k.product, url: k.url }));
    return { t: u.t, wens: u.wens, gelezen, rest };
  }
  // Alleen de zoekrondes, voor Laat Shopper zoeken zonder snelle ronde vooraf (de agent leest zelf na). null bij weigering of fout.
  async function zoekKandidaten(g) {
    if (typeof o.zoek !== 'function') return null;
    try {
      const z = await zoekRondes({ wens: g.wens, aantal: g.aantal || null, eisen: g.eisen || [], refurbished: false }, domeinen().lijst);
      return z.fout ? null : { t: nu().toISOString(), gelezen: [], rest: z.kandidaten.map((k) => ({ winkel: k.winkel, product: k.product, url: k.url })) };
    } catch (e) { return null; }
  }
  // Bewaar als zoektocht: een nieuwe pagina in de Shopper-map van de entiteit (bron: snel, status: open, geen advies)
  function bewaar(id, d) {
    if (!ID_RE.test(String(id || ''))) return { status: 400, body: { ok: false, fout: 'ongeldige id' } };
    if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some((k) => k !== 'entiteit')) return { status: 400, body: { ok: false, fout: 'alleen entiteit' } };
    const ent = S.MAPPEN.find((m) => m[0] === d.entiteit);
    if (!ent) return { status: 400, body: { ok: false, fout: 'kies voor wie (entiteit)' } };
    const u = haal(id);
    if (!u) return { status: 404, body: { ok: false, fout: 'deze vergelijking is er niet meer (na 24 uur weg); zoek opnieuw' } };
    if (u.stand !== 'klaar') return { status: 409, body: { ok: false, fout: 'wacht tot het vergelijken klaar is' } };
    if (u.bewaard) return { status: 200, body: { ok: true, al: true, zoektocht: u.bewaard } };
    if (!S.poortVrij(o.poort, [u.wens].concat(u.eisen || []))) return { status: 422, body: { ok: false, fout: S.POORT_FOUT, poort: true } };
    const t = new Date(u.t), dag = nlDag(t);
    const opties = (u.opties || []).slice(0, 12);
    const fm = ['---', 'type: shopper-zoektocht', 'bron: snel', 'wens: ' + q(u.wens), 'entiteit: ' + ent[0], 'status: open', 'gezocht: ' + isoNl(t),
      'aantal: ' + (u.aantal || 1), 'eisen: ' + JSON.stringify(u.eisen || []),
      'aannames: ' + JSON.stringify(['snel vergeleken door de pod: prijs, verzending en levertijd gelezen op de winkelpagina; niemand las de eisen na (voldoet: onbekend)']),
      'opties:'].concat(opties.length ? opties.map((x, i) => yamlOptie(x, 'o' + (i + 1))) : []).concat(['---']);
    if (!opties.length) fm[fm.length - 2] = 'opties: []';
    const niet = (u.niet_gelezen || []).slice(0, 12).map((x) => '- ' + x.winkel + ': ' + x.product.replace(/[[\]]/g, '') + ' — ' + x.reden + ' (' + x.url + ')');
    const body = '\n# ' + u.wens + '\n\nSnel vergeleken in Apps › Shopper op ' + isoNl(t).replace('T', ' ').slice(0, 16) + ' (bron: snel). De pod las prijs, verzending,'
      + ' levertijd en voorraad op de winkelpagina\'s; **niemand las Davids eisen na**, dus er is geen advies. Laat Shopper grondig zoeken voor een advies.\n'
      + (niet.length ? '\n## Niet te lezen\n\n' + niet.join('\n') + '\n' : '');
    let rel = null;
    for (let n = 1; n <= 9 && !rel; n++) {
      const r = path.join(ent[2], bestandsnaam(dag, u.wens, n));
      let ok = false;
      try { ok = o.vv.schrijf(path.join(o.vault, r), fm.join('\n') + '\n' + body, { alsGelijk: (s) => !s, modus: 0o660 }); } catch (e) { if (e && e.code === 'ENOENT') return { status: 409, body: { ok: false, fout: 'de Shopper-map van ' + ent[1] + ' bestaat nog niet' } }; ok = false; }
      if (ok) rel = r;
    }
    if (!rel) return { status: 409, body: { ok: false, fout: 'bewaren lukte niet; probeer het zo opnieuw' } };
    const z = { id: S.idVan(rel), entiteit: ent[0] };
    zet(id, Object.assign({}, u, { bewaard: z, versie: (u.versie || 0) + 1 }));
    return { status: 200, body: { ok: true, zoektocht: z } };
  }
  return { start, stand, kandidaten, zoekKandidaten, bewaar, opruimen };
}

module.exports = { maak, zoekVragen, samenvoegen, zelfdeProduct, pakket, inHuis, optieVan, invoer, bestandsnaam, isoNl, PLAFOND_DAG };
