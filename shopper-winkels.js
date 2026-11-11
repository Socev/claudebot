'use strict';
/*
 * shopper-winkels.js — OVIS Shopper fase 3 "Winkels en geheugen" (wv2935, 11-11-2026; plan vault "01_Ontwikkeling/OVIS Shopper naar een 8 -
 * totaalinterface (plan wv2849, 9-11-2026).md" § 4, Fable 5.2 b2a/b8/b9).
 *
 * WAAROM. David (9-11): "uitbreiden van de categorieën sites, reviews van de sites erbij". Fable 5.2: begin bij de winkels waar David echt
 * koopt (de drie aankopen waren een bouwmarkt en twee medische vakwinkels, geen ervan stond in de lijst), categorieën vanuit zijn vragen,
 * en een openbare score als tweede signaal naast "hier kocht je eerder".
 *
 * WAT. Pure functies op de vault-pagina "Shopper - favoriete winkels" (velden per winkel, één regel {…}):
 *   domein, naam, aan (true = Shopper zoekt er bij Snel vergelijken en toont Favoriet), soort, categorie ("medisch bouw" = ids met spaties),
 *   refurbished (true), lezen (script | browser | niet), verzend_eur, drempel_eur, boven_drempel_eur (0 = gratis), verzend_tekst,
 *   verzend_gemeten (JJJJ-MM-DD), kieskeurig (slug), kiyoh (https://www.kiyoh.com/reviews/<nr>/<naam>/), thuiswinkel (slug).
 * - winkelsVan(t): de winkels met geldige velden (ongeldige velden vallen weg, de winkel blijft).
 * - verzendUitTabel(w, subtotaal): de gemeten verzendtabel → { eur, gemeten } of null (geen tabel, of geen bedrag). Drempel = "vanaf".
 * - scoreBij(url, verkoper, winkels, scores): de score bij de ECHTE verkoper (plan § 4a, review ZOU 1): bij een partner op bol of een
 *   marketplace-verkoper op Amazon nooit de score van het platform → { soort: 'partner', verkoper }; verkoper onbekend op een platform →
 *   { soort: 'onbekend_verkoper' }; anders de score van de winkel van het domein (of { soort: 'geen' }); geen winkel in de lijst → null.
 * - aankopen(gekocht[], winkels): per winkel hoe vaak en wanneer laatst David er kocht (Gekocht in Shopper), en de rest als "elders".
 * - maak(o): overzicht() voor GET /app/shopper/winkels, en de scores (klokken-map, 0600) met een leesronde die alleen start als iemand de
 *   tab opent en de scores ouder zijn dan 30 dagen (hooguit eens per 6 uur een poging): geen vaste ronde, geen taalmodel.
 *
 * PRIVACY. Alleen winkelnamen, domeinen en aantallen; geen wens, bedrag of factuur. Deze module logt niets.
 */
const fs = require('fs');
const path = require('path');
const R = require('./reizen.js');

const CATEGORIEEN = [
  { id: 'medisch', naam: 'Medisch & praktijk' },
  { id: 'bouw', naam: 'Bouw & tuin' },
  { id: 'huis', naam: 'Huis & wonen' },
  { id: 'elektronica', naam: 'Elektronica' },
  { id: 'kantoor', naam: 'Kantoor' },
];
const CAT_IDS = CATEGORIEEN.map((c) => c.id).concat(['alles']);
const LEZEN = ['script', 'browser', 'niet'];
const MAX_WINKELS = 80;
const SCORE_OUD = 30 * 86400000, SCORE_POGING = 6 * 3600000;
const BRONNEN = ['kieskeurig', 'kiyoh', 'thuiswinkel'];
const goedeMeting = (x) => !!x && typeof x === 'object' && !x.fout;
const MIN_ERVARINGEN = 10;   // Kieskeurig toont vaak een cijfer op 1–11 ervaringen (gemeten 11-11): daaronder geen cijfer, wel het aantal
// Platforms met partnerverkopers: de verkoper moet het platform zelf zijn, anders geen platformscore
const PLATFORM = { 'bol.com': ['bol', 'bol.com'], 'amazon.nl': ['amazon', 'amazon.nl', 'amazon eu s.a.r.l.', 'amazon eu sarl'],
  'amazon.de': ['amazon', 'amazon.de', 'amazon eu s.a.r.l.', 'amazon eu sarl'], 'amazon.com.be': ['amazon', 'amazon.com.be', 'amazon eu s.a.r.l.', 'amazon eu sarl'] };
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const KIYOH_RE = /^https:\/\/www\.kiyoh\.com\/reviews\/\d{1,12}\/[a-z0-9_]{1,80}\/?$/;
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;
const tekst = (x, max) => { const v = String(x == null ? '' : x).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim(); return v && v !== 'null' ? v.slice(0, max) : ''; };
const bedrag = (x) => { const s = String(x == null ? '' : x).trim(); return /^\d{1,5}(\.\d{1,2})?$/.test(s) ? Number(s) : null; };
const ja = (x) => String(x == null ? '' : x).trim().toLowerCase() === 'true';

function domeinVan(x) {
  const d = String(x == null ? '' : x).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && d.length <= 100 ? d : null;
}
function hostVan(url) { try { return new URL(url).hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, ''); } catch (e) { return null; } }
const opDomein = (h, d) => !!h && !!d && (h === d || h.endsWith('.' + d));

function winkelsVan(t) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(t || '');
  if (!fm || !/^type:[ \t]*shopper-favorieten[ \t]*$/m.test(fm[1])) return [];
  const uit = [];
  for (const w of R.fmObjLijst(t, 'winkels')) {
    const domein = domeinVan(w.domein);
    if (!domein || uit.some((x) => x.domein === domein)) continue;
    const cat = String(w.categorie == null ? '' : w.categorie).toLowerCase().split(/[\s,+]+/).filter((c) => CAT_IDS.indexOf(c) >= 0);
    const lezen = LEZEN.indexOf(String(w.lezen || '').trim()) >= 0 ? String(w.lezen).trim() : null;
    const gem = tekst(w.verzend_gemeten, 10);
    const verzend = { eur: bedrag(w.verzend_eur), drempel_eur: bedrag(w.drempel_eur), boven_drempel_eur: bedrag(w.boven_drempel_eur),
      tekst: tekst(w.verzend_tekst, 160) || null, gemeten: DATUM_RE.test(gem) ? gem : null };
    const ks = tekst(w.kieskeurig, 80), ky = tekst(w.kiyoh, 160), tw = tekst(w.thuiswinkel, 80);
    uit.push({ domein, naam: tekst(w.naam, 80) || domein, aan: ja(w.aan), soort: tekst(w.soort, 120) || null,
      categorie: Array.from(new Set(cat)), refurbished: ja(w.refurbished), lezen,
      verzend: verzend.eur == null && !verzend.tekst ? null : verzend,
      bronnen: { kieskeurig: SLUG_RE.test(ks) ? ks : null, kiyoh: KIYOH_RE.test(ky) ? ky : null, thuiswinkel: SLUG_RE.test(tw) ? tw : null } });
    if (uit.length >= MAX_WINKELS) break;
  }
  return uit;
}
function winkelBij(url, winkels) {
  const h = hostVan(url);
  if (!h) return null;
  let best = null;
  for (const w of winkels || []) if (opDomein(h, w.domein) && (!best || w.domein.length > best.domein.length)) best = w;
  return best;
}
// Verzending uit de gemeten tabel; subtotaal = prijs × koop_aantal (incl. btw). Zonder bedrag in de tabel: null.
function verzendUitTabel(w, subtotaal) {
  const v = w && w.verzend;
  if (!v || v.eur == null || typeof subtotaal !== 'number' || !(subtotaal > 0)) return null;
  // review wv2935 MOET 1: in hele centen vergelijken (3 × 19,90 = 59,70 mag niet onder een drempel van 59,70 vallen)
  const boven = v.drempel_eur != null && v.boven_drempel_eur != null && Math.round(subtotaal * 100) >= Math.round(v.drempel_eur * 100);
  return { eur: boven ? v.boven_drempel_eur : v.eur, gemeten: v.gemeten };
}
const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
// De score van één winkel uit de scorestaat, met de ondergrens voor Kieskeurig
function scoreVan(domein, scores) {
  const s = scores && scores.winkels && scores.winkels[domein];
  if (!s || typeof s !== 'object') return null;
  const uit = [];
  const ky = s.kiyoh, ks = s.kieskeurig, tw = s.thuiswinkel;
  if (ky && typeof ky.cijfer === 'number' && Number.isInteger(ky.aantal) && ky.aantal > 0) uit.push({ bron: 'Kiyoh', cijfer: ky.cijfer, aantal: ky.aantal });
  if (ks && Number.isInteger(ks.aantal) && ks.aantal > 0) {
    if (typeof ks.cijfer === 'number' && ks.aantal >= MIN_ERVARINGEN) uit.push({ bron: 'Kieskeurig', cijfer: ks.cijfer, aantal: ks.aantal });
    else uit.push({ bron: 'Kieskeurig', cijfer: null, aantal: ks.aantal, weinig: true });
  }
  const thuis = tw && typeof tw.sinds === 'string' && DATUM_RE.test(tw.sinds) ? tw.sinds : null;
  if (!uit.length && !thuis) return null;
  // de oudste leesdatum van wat getoond wordt (per bron bewaard; oudere staat zonder: de datum van de ronde)
  const ops = [ky, ks, tw].filter((x) => x && typeof x === 'object' && !x.fout).map((x) => (typeof x.op === 'string' ? x.op : scores.op)).filter((x) => typeof x === 'string').sort();
  return { bronnen: uit, thuiswinkel_sinds: thuis, op: ops[0] || (typeof scores.op === 'string' ? scores.op : null) };
}
function scoreBij(url, verkoper, winkels, scores) {
  const h = hostVan(url);
  if (!h) return null;
  const plat = Object.keys(PLATFORM).find((d) => opDomein(h, d));
  if (plat) {
    const v = norm(verkoper);
    if (!v) return { soort: 'onbekend_verkoper' };
    if (PLATFORM[plat].indexOf(v) < 0) return { soort: 'partner', verkoper: tekst(verkoper, 80) };
  }
  const w = winkelBij(url, winkels);
  if (!w) return null;
  const s = scoreVan(w.domein, scores);
  return s ? Object.assign({ soort: 'score', winkel: w.naam }, s) : { soort: 'geen', winkel: w.naam };
}
// Sleutelwoorden van een winkelnaam ("Praxisdienst", "eBay.co.uk (speedyauctionsuk)") voor de koppeling aan een domein
function naamKern(s) {
  const w = norm(s).replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9.-]+/g, ' ').trim().split(' ').filter(Boolean);
  return w.length ? w[0].replace(/^www\./, '').split('.')[0] : null;
}
// gekocht[]: { winkel, url?, verkoper?, datum } per gekochte zoektocht. → { per: {domein: {aantal, laatst}}, elders: [{naam, aantal, laatst}] }
function aankopen(gekocht, winkels) {
  const per = {}, elders = {};
  for (const g of gekocht || []) {
    if (!g) continue;
    let w = g.url ? winkelBij(g.url, winkels) : null;
    // review ronde 2 ZOU 2: gekocht bij een partner op bol/Amazon = ervaring met die verkoper, niet met het platform
    const plat = g.url ? Object.keys(PLATFORM).find((d) => opDomein(hostVan(g.url), d)) : null;
    const partner = plat && norm(g.verkoper) && PLATFORM[plat].indexOf(norm(g.verkoper)) < 0 ? tekst(g.verkoper, 60) : null;
    if (partner) { const e = elders[partner] = elders[partner] || { naam: partner, aantal: 0, laatst: null }; e.aantal++; if (DATUM_RE.test(String(g.datum || '')) && (!e.laatst || g.datum > e.laatst)) e.laatst = g.datum; continue; }
    if (plat && !norm(g.verkoper) && g.url) w = null;   // verkoper onbekend op een platform: alleen via de winkelnaam die David opgaf
    if (!w) {
      const k = naamKern(g.winkel);
      if (k && k.length >= 3) w = (winkels || []).find((x) => x.domein.split('.')[0] === k || naamKern(x.naam) === k) || null;
    }
    const d = DATUM_RE.test(String(g.datum || '')) ? g.datum : null;
    const doel = w ? (per[w.domein] = per[w.domein] || { aantal: 0, laatst: null }) : null;
    if (doel) { doel.aantal++; if (d && (!doel.laatst || d > doel.laatst)) doel.laatst = d; continue; }
    const naam = tekst(String(g.winkel || '').replace(/\s*\(.*$/, ''), 60);
    if (!naam) continue;
    const e = elders[naam] = elders[naam] || { naam, aantal: 0, laatst: null };
    e.aantal++; if (d && (!e.laatst || d > e.laatst)) e.laatst = d;
  }
  return { per, elders: Object.values(elders).sort((a, b) => b.aantal - a.aantal || (a.naam < b.naam ? -1 : 1)) };
}
// Domeinen voor de zoekhulp bij een categorie: winkels in die categorie die aan staan en die Shopper kan lezen; zonder categorie: alle die aan staan
function domeinenVoor(winkels, categorie) {
  return (winkels || []).filter((w) => w.aan && w.lezen !== 'niet' && w.lezen !== 'browser'
    && (!categorie || w.categorie.indexOf(categorie) >= 0 || w.categorie.indexOf('alles') >= 0)).map((w) => w.domein);
}

function maak(o) {
  const nu = o.nu || (() => new Date());
  let poging = 0, bezig = false;
  function scores() {
    if (!o.scorePad) return null;
    try { const j = JSON.parse(fs.readFileSync(o.scorePad, 'utf8')); return j && typeof j === 'object' && j.winkels && typeof j.winkels === 'object' ? j : null; } catch (e) { return null; }
  }
  function bewaar(j) {
    const tmp = o.scorePad + '.tmp-' + process.pid + '-' + Date.now();
    try { fs.writeFileSync(tmp, JSON.stringify(j), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, o.scorePad); return true; } catch (e) { try { fs.unlinkSync(tmp); } catch (x) {} return false; }
  }
  // Een leesronde op de achtergrond; alleen de winkels met een bron. Resolves met true/false (voor de toets).
  function ververs(winkels) {
    if (bezig || typeof o.scoreLezer !== 'function' || !o.scorePad) return Promise.resolve(false);
    const invoer = winkels.filter((w) => w.bronnen.kieskeurig || w.bronnen.kiyoh || w.bronnen.thuiswinkel)
      .map((w) => ({ domein: w.domein, kieskeurig: w.bronnen.kieskeurig, kiyoh: w.bronnen.kiyoh, thuiswinkel: w.bronnen.thuiswinkel }));
    if (!invoer.length) return Promise.resolve(false);
    bezig = true; poging = nu().getTime();
    return Promise.resolve().then(() => o.scoreLezer({ winkels: invoer })).then((j) => {
      bezig = false;
      if (!j || typeof j !== 'object' || !j.winkels || typeof j.op !== 'string') return false;
      // review wv2935 ZOU 2: een mislukte bron overschrijft nooit een eerdere goede meting; zijn er fouten, dan na 6 uur een nieuwe poging
      const oud = scores(), uit = {};
      let fouten = 0;
      for (const d of Object.keys(j.winkels)) {
        const n = j.winkels[d] && typeof j.winkels[d] === 'object' ? j.winkels[d] : {}, v = oud && oud.winkels[d] ? oud.winkels[d] : {};
        uit[d] = {};
        for (const b of BRONNEN) {
          if (n[b] && n[b].fout) fouten++;
          // review ronde 2 ZOU 1: elke meting houdt haar eigen leesdatum (een bewaarde oude meting lijkt niet vers)
          uit[d][b] = goedeMeting(n[b]) ? Object.assign({}, n[b], { op: j.op }) : goedeMeting(v[b]) ? Object.assign({ op: v[b].op || oud.op || null }, v[b]) : (n[b] || null);
        }
      }
      return bewaar({ op: j.op, winkels: uit, fouten });
    }, () => { bezig = false; return false; });
  }
  function moetVerversen(s) {
    if (bezig || nu().getTime() - poging < SCORE_POGING) return false;
    const op = s && Date.parse(s.op);
    if (!op) return true;
    return nu().getTime() - op > (s.fouten > 0 ? SCORE_POGING : SCORE_OUD);
  }
  // Het overzicht voor de tab Winkels. pagina = tekst van de favorietenpagina (of null); gekocht = [{winkel, url, datum}]
  function overzicht(pagina, gekocht) {
    const winkels = pagina == null ? [] : winkelsVan(pagina);
    const s = scores();
    let stand = s ? 'klaar' : 'geen';
    if (winkels.length && moetVerversen(s) && typeof o.scoreLezer === 'function') { ververs(winkels); stand = 'leest'; }
    else if (bezig) stand = 'leest';
    const a = aankopen(gekocht, winkels);
    const lijst = winkels.map((w) => {
      const sc = scoreVan(w.domein, s), eigen = a.per[w.domein] || null;
      return { domein: w.domein, naam: w.naam, aan: w.aan, soort: w.soort, categorie: w.categorie, refurbished: w.refurbished, lezen: w.lezen,
        verzend: w.verzend, score: sc, gekocht: eigen, onbekend: !eigen && !(sc && (sc.bronnen.some((b) => b.cijfer != null) || sc.thuiswinkel_sinds)) };
    });
    const oudste = lijst.map((w) => w.score && w.score.op).filter(Boolean).sort()[0] || (s ? s.op : null);   // ronde 2 ZOU 1: de oudste getoonde meting
    return { status: 200, body: { ok: true, categorieen: CATEGORIEEN, winkels: lijst, elders: a.elders, score_op: oudste, score_stand: stand,
      pagina: pagina == null ? 'onleesbaar' : 'ok' } };
  }
  return { overzicht, scores, ververs, info: () => ({ bezig, poging: poging ? new Date(poging).toISOString() : null }) };
}

module.exports = { maak, winkelsVan, winkelBij, verzendUitTabel, scoreBij, scoreVan, aankopen, domeinenVoor, CATEGORIEEN, CAT_IDS, MIN_ERVARINGEN };
