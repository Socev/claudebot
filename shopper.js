'use strict';
/*
 * OVIS Shopper S3 (wv2264, 2-11-2026; idee 23): de zoektochtpagina's (type: shopper-zoektocht) voor Apps › Shopper in de Socev-app.
 * Ontwerp in de vault: "01_Ontwikkeling/OVIS Shopper - wat er al bestaat en ontwerp (2-11-2026).md" § 3.3 (paginavorm) en § 3.4 (App);
 * de skill ovis-shopper schrijft de pagina's, deze module leest ze. Zelfde bouw als reizen.js (OVIS Tripper).
 *
 * WAAROM. David (25-10): "een app die ingezet kan worden door mij of door Socev, om producten te zoeken … en dan een link klaar zetten om
 * te kopen." De pagina blijft de bron; geen eigen opslag.
 *
 * VORM.
 *  - paden(): alleen de .md-bestanden direct in de vaste Shopper-mappen (MAPPEN, dezelfde lijst als de skill, stap 6); geen submappen,
 *    geen verborgen bestanden. Alleen type: shopper-zoektocht telt. De entiteit komt uit de map, niet uit de pagina.
 *  - Lezen via vault-veilig (o.vv.lees: geen symlink volgen, alleen een gewoon bestand, ≤ 512 kB).
 *  - id = de eerste 12 hex van sha256(vaultpad); opvragen en wijzigen alleen op id: het pad uit paden(), nooit uit de vraag.
 *  - Een koop-link telt alleen als https-adres met een hostnaam (geen gebruiker/wachtwoord, ≤ 2000 tekens); anders url null (geen knop).
 *  - Schrijfacties, alle via o.vv.wijzig (opnieuw gelezen onder het slot; alleen de statusregel en de gekocht-regel, de rest byte-gelijk):
 *    status open → vervallen ("Niet meer nodig"); gekocht(id, d) open/vervallen → gekocht ("Gekocht", wv2275); status gekocht → open
 *    ("Toch niet gekocht", haalt de gekocht-regel weg). Review 2-11 MOET 5 ("gekocht alleen op Davids eigen woord") blijft staan: een tik
 *    van David in zijn eigen ingelogde app ís zijn woord (bouwplan "OVIS Shopper - knop Gekocht (ontwerp 2-11-2026)" § 4). Wat van MOET 5
 *    blijft: geen automatisme zet ooit gekocht; het bedrag komt nooit uit de optie; bij een optie komt de winkel van de pagina, niet uit de vraag.
 *  - Favoriet (wv2267, David 2-11: "Kunnen we gericht iets bouwen dat ook op favoriete websites zoekt? … Ik wil altijd prijs en levervoorraad
 *    weten"): de vault-pagina FAVORIETEN (type: shopper-favorieten, lijst winkels: {domein, aan}) wordt bij elke vraag gelezen (vault-veilig,
 *    zelfde grens). Een optie krijgt favoriet: true als haar (al goedgekeurde https-)koop-link op een domein staat dat aan staat (zelfde host
 *    of een subdomein). Geen pagina of geen geldige regels = niets favoriet. De pagina zelf wordt nooit geschreven.
 *  - S5 Facturen-koppeling (wv2276, ontwerp § 3.4b): bij een zoektocht op gekocht zoekt facturenBij() in de Facturen-app naar facturen die bij
 *    de aankoop passen (entiteit gelijk, datum 14 d vóór t/m 30 d na gekocht.datum, winkel als heel woord in de leveranciersnaam, bedrag in
 *    centen ± max(€ 1, 1 %) = hoog, hooguit € 15 hoger = middel, bedrag onbekend = laag). Een berekende verwijzing: er wordt NIETS
 *    geschreven, niet in facturen.sqlite en niet op de pagina. De database gaat per vraag zelf open met readOnly + query_only (review
 *    MOET 2: niet de gedeelde Facturen-handle) en weer dicht. o.facturenPad() geeft het pad of null (niet op de primaire kant = geen
 *    koppeling). Faalt het lezen: facturen null; de zoektocht blijft gewoon leesbaar. Zichtbaar alleen achter de app-sessie, die in
 *    Facturen de eigenaar is (review MOET 3).
 * PRIVACY. Deze module logt niets; info() geeft alleen aantallen en het tijdstip van de laatste lijst (geen wens, pad of bedrag). Er gaat niets naar buiten of naar een taalmodel.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('./reizen.js');   // dezelfde frontmatter-lezing (flow-maps, lijsten) als Tripper

const MAPPEN = [
  ['groenhouten', 'Groenhouten', '10_Zakelijk/Groenhouten/Shopper'],
  ['tolgaarde', 'Tolgaarde', '10_Zakelijk/Tolgaarde/Shopper'],
  ['pot', 'POT', '10_Zakelijk/POT_POH_GGZ/Shopper'],
  ['holding', 'Holding', '10_Zakelijk/Holding/Shopper'],
  ['praktijkhouders', 'Praktijkhouders', '10_Zakelijk/Praktijkhouders_BV/Shopper'],
  ['prive', 'Privé', '20_Prive/Shopper'],
];
const STATUSSEN = ['open', 'gekocht', 'vervallen'];
const FAVORIETEN = '00_Systeem/Shopper - favoriete winkels.md', MAX_FAVORIETEN = 60;
const MAX_PAGINA = 512 * 1024, MAX_OPTIES = 12;
const ID_RE = /^[0-9a-f]{12}$/;

function idVan(rel) { return crypto.createHash('sha256').update(String(rel)).digest('hex').slice(0, 12); }
const tekstVeld = (x, max) => { const v = String(x == null ? '' : x).replace(/[\u0000-\u001f\u007f]/g, ' ').trim(); return v && v !== 'null' ? v.slice(0, max || 200) : ''; };
// Eén veld uit de frontmatter zonder YAML-commentaar (buiten aanhalingstekens) en zonder aanhalingstekens
function fmWaarde(t, veld) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(t || '');
  if (!fm) return null;
  const r = new RegExp('^' + veld + ':[ \\t]*(.*)$', 'm').exec(fm[1]);
  if (!r) return null;
  const s = r[1].trim();
  if (s.startsWith('"')) { const m = /^"((?:[^"\\]|\\.)*)"/.exec(s); if (m) { try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1]; } } }
  if (s.startsWith("'")) { const m = /^'((?:[^']|'')*)'/.exec(s); if (m) return m[1].replace(/''/g, "'"); }
  return s.replace(/(^|\s)#.*$/, '').trim();
}
function bedrag(x) { const s = String(x == null ? '' : x).trim(); return /^\d{1,7}(\.\d{1,2})?$/.test(s) ? Number(s) : null; }
function aantal(x) { const s = String(x == null ? '' : x).trim(); return /^\d{1,4}$/.test(s) && Number(s) > 0 ? Number(s) : null; }
// Alleen https met een echte hostnaam; geen inloggegevens in het adres
function koopUrl(x) {
  const s = String(x == null ? '' : x).trim();
  if (!s || s.length > 2000 || /[\s<>"]/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
  return u.href;
}
// Domeinen die aan staan: "www.", "https://" en een pad vallen weg; alleen een kale hostnaam met een punt telt
function favorietenVan(t) {
  if (fmWaarde(t, 'type') !== 'shopper-favorieten') return [];
  const uit = [];
  for (const w of R.fmObjLijst(t, 'winkels')) {
    if (String(w.aan).trim().toLowerCase() !== 'true') continue;
    const d = String(w.domein == null ? '' : w.domein).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && d.length <= 100 && uit.indexOf(d) < 0) uit.push(d);
  }
  return uit.slice(0, MAX_FAVORIETEN);
}
function isFavoriet(url, fav) {
  if (!url || !fav || !fav.length) return false;
  let h;
  try { h = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch (e) { return false; }
  return fav.some((d) => h === d || h.endsWith('.' + d));
}
function optiesVan(t, fav) {
  const uit = [];
  for (const o of R.fmObjLijst(t, 'opties').slice(0, MAX_OPTIES)) {
    const id = /^o\d{1,3}$/.test(String(o.id || '')) ? String(o.id) : null;
    if (!id) continue;
    const ruw = tekstVeld(o.url, 2000);
    uit.push({ id, winkel: tekstVeld(o.winkel, 80), verkoper: tekstVeld(o.verkoper, 120), product: tekstVeld(o.product, 300),
      koop_eenheid: tekstVeld(o.koop_eenheid, 60), koop_aantal: aantal(o.koop_aantal), prijs_eur: bedrag(o.prijs_eur), verzending_eur: bedrag(o.verzending_eur),
      totaal_eur: bedrag(o.totaal_eur), levertijd: tekstVeld(o.levertijd, 160), voorraad: tekstVeld(o.voorraad, 120),
      url: koopUrl(ruw), url_geweigerd: !!ruw && !koopUrl(ruw), favoriet: isFavoriet(koopUrl(ruw), fav), gelezen: tekstVeld(o.gelezen, 40) });
  }
  return uit;
}
// De tekst onder "## <kop>" tot de volgende kop van niveau 1 of 2 (hooguit max tekens)
function sectie(t, kop, max) {
  const lijf = String(t || '').replace(/^---\n[\s\S]*?\n---\n?/, '');
  const m = new RegExp('^##[ \\t]+' + kop + '\\b[^\\n]*$', 'im').exec(lijf);
  if (!m) return '';
  const na = lijf.slice(m.index + m[0].length), eind = /^#{1,2}[ \t]/m.exec(na);
  return (eind ? na.slice(0, eind.index) : na).trim().slice(0, max || 3000);
}
// De inleiding: de tekst tussen de titelkop en de eerste tabel of ##-kop (het advies in twee zinnen)
function inleiding(t) {
  const lijf = String(t || '').replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^\s*#[ \t][^\n]*\n/, '');
  const eind = /^(?:#{1,2}[ \t]|\|)/m.exec(lijf);
  return (eind ? lijf.slice(0, eind.index) : lijf).trim().slice(0, 2000);
}
// ── S5 (wv2276): het gekocht-blok en de facturen die erbij passen ──
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;
const FAC_ENT = { praktijkhouders: 'praktijkhouders_bv' };   // Shopper-entiteit → sleutel in Facturen (de rest is gelijk)
const RUIS = new Set(['bv', 'nv', 'vof', 'b', 'v', 'n', 'nederland', 'netherlands', 'nl', 'com', 'be', 'eu', 'de', 'het', 'the', 'webshop', 'shop', 'winkel', 'store', 'online', 'www']);
const ZEKER = { hoog: 0, middel: 1, laag: 2 };
function woorden(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\bb\.v\.?/g, ' bv ').replace(/\bn\.v\.?/g, ' nv ')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}
// Zoeksleutel uit een winkelnaam: de woorden zonder rechtsvorm/landnaam/.com; korter dan 3 tekens telt niet
function sleutelVan(s) { const k = woorden(s).filter((w) => !RUIS.has(w)).join(' '); return k.length >= 3 ? k : null; }
// Kern van een hostnaam: www.bol.com → bol, shop.hornbach.nl → hornbach (het label vóór het topdomein)
function hostKern(url) { try { const d = new URL(url).hostname.toLowerCase().split('.').filter(Boolean); return d.length >= 2 ? sleutelVan(d[d.length - 2]) : null; } catch (e) { return null; } }
function gekochtVan(t) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(t || '');
  const r = fm && /^gekocht:[ \t]*(\{.*\})[ \t]*(?:#.*)?$/m.exec(fm[1]);
  const g = r ? R.flowMap(r[1]) : null;
  if (!g) return null;
  const datum = tekstVeld(g.datum, 10);
  return { optie: /^o\d{1,3}$/.test(String(g.optie || '')) ? String(g.optie) : null, winkel: tekstVeld(g.winkel, 80) || null, bedrag_eur: bedrag(g.bedrag_eur),
    datum: DATUM_RE.test(datum) ? datum : null, opmerking: tekstVeld(g.opmerking || g.toelichting, 120) || null,
    via: ['app', 'socev'].indexOf(String(g.via || '')) >= 0 ? String(g.via) : null };
}
// ── wv2275: de knop Gekocht (bouwplan "OVIS Shopper - knop Gekocht (ontwerp 2-11-2026)" § 3.2) ──
const GEKOCHT_VELDEN = ['optie', 'winkel', 'bedrag_eur', 'datum', 'opmerking'];
// Vrije tekst voor de flow-map in de frontmatter: geen regeleinden of besturingstekens (ook U+2028/2029/0085), geen " of \ (dat breekt de
// map niet, maar ook het lezen niet); te lang = null (de vraag wordt geweigerd, niet afgekapt)
function mapTekst(x, max) {
  const v = String(x == null ? '' : x).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/"/g, "'").replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
  return v.length > max ? null : v;
}
function nlDag(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
function geldigeDag(s) { if (!DATUM_RE.test(s)) return false; const x = new Date(s + 'T12:00:00Z'); return !isNaN(x) && x.toISOString().slice(0, 10) === s; }
// De regel die op de pagina komt; null-waarden als null (gekochtVan leest ze als leeg)
function gekochtRegel(g) {
  const q = (x) => (x == null || x === '' ? 'null' : '"' + x + '"');
  return 'gekocht: {optie: ' + (g.optie || 'null') + ', winkel: ' + q(g.winkel) + ', bedrag_eur: ' + (g.bedrag_eur == null ? 'null' : String(g.bedrag_eur))
    + ', datum: ' + q(g.datum) + ', opmerking: ' + q(g.opmerking) + ', via: app}';
}
// Frontmatterregels: de status zetten, alle gekocht-regels (ook een blokvorm met ingesprongen regels eronder) eruit, eventueel één nieuwe
// gekocht-regel direct onder de status. De rest van de frontmatter blijft regel voor regel gelijk.
function zetStatusRegels(fm, st, gekochtLijn) {
  const uit = [];
  let weg = false, statusGezet = false;
  for (const r of fm.split('\n')) {
    if (weg && /^[ \t]/.test(r)) continue;
    weg = false;
    if (/^gekocht:/.test(r)) { weg = true; continue; }
    if (!statusGezet && /^status:/.test(r)) { uit.push('status: ' + st); if (gekochtLijn) uit.push(gekochtLijn); statusGezet = true; continue; }
    uit.push(r);
  }
  if (!statusGezet) { uit.push('status: ' + st); if (gekochtLijn) uit.push(gekochtLijn); }
  return uit.join('\n');
}
const zelfdeGekocht = (a, b) => !!a && !!b && GEKOCHT_VELDEN.every((k) => (a[k] == null ? null : a[k]) === (b[k] == null ? null : b[k]));
function dagPlus(d, n) { const x = new Date(d + 'T12:00:00Z'); if (isNaN(x)) return null; x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function dagAfstand(a, b) { return Math.abs(Math.round((new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 86400000)); }
// Kandidaat-facturen voor één gekochte zoektocht z (met z.gekocht en z._opties), uit een alleen-lezen database db
function facturenBij(db, z) {
  const g = z.gekocht;
  if (!g || !g.datum) return [];
  const van = dagPlus(g.datum, -14), tot = dagPlus(g.datum, 30);
  if (!van || !tot) return [];
  const opt = g.optie ? z._opties.find((x) => x.id === g.optie) : null;
  const sleutels = [];
  for (const s of [sleutelVan(g.winkel), opt && sleutelVan(opt.winkel), opt && opt.url && hostKern(opt.url), opt && sleutelVan(opt.verkoper)]) if (s && sleutels.indexOf(s) < 0) sleutels.push(s);
  if (!sleutels.length) return [];
  const rijen = db.prepare("SELECT f.id, f.factuurdatum, substr(f.aangemaakt_op, 1, 10) AS aangemaakt, f.incl_eur, f.incl, f.valuta, f.leverancier_naam, l.naam AS lnaam "
    + "FROM factuur f LEFT JOIN leverancier l ON l.id = f.leverancier WHERE f.soort = 'factuur' AND f.status <> 'geen_factuur' AND f.dubbel_van IS NULL "
    + "AND f.entiteit = ? AND coalesce(f.factuurdatum, substr(f.aangemaakt_op, 1, 10)) BETWEEN ? AND ? LIMIT 500").all(FAC_ENT[z.entiteit] || z.entiteit, van, tot);
  const doel = g.bedrag_eur == null ? null : Math.round(g.bedrag_eur * 100);   // centen (review MOET 1)
  const uit = [];
  for (const f of rijen) {
    const lev = ' ' + woorden([f.lnaam, f.leverancier_naam].filter(Boolean).join(' ')).join(' ') + ' ';
    if (!sleutels.some((s) => lev.indexOf(' ' + s + ' ') >= 0)) continue;
    const incl = Number.isInteger(f.incl_eur) ? f.incl_eur : (f.valuta === 'EUR' && Number.isInteger(f.incl) ? f.incl : null);
    let zeker = 'laag';
    if (doel != null && incl != null) {
      const vers = incl - doel;
      if (Math.abs(vers) <= Math.max(100, Math.round(doel * 0.01))) zeker = 'hoog';
      else if (vers > 0 && vers <= 1500) zeker = 'middel';
      else continue;
    }
    const d = f.factuurdatum || f.aangemaakt;
    uit.push({ id: String(f.id), leverancier: tekstVeld(f.lnaam || f.leverancier_naam, 80), factuurdatum: d, bedrag_eur: incl == null ? null : incl / 100, zekerheid: zeker, _afstand: dagAfstand(d, g.datum) });
  }
  uit.sort((a, b) => ZEKER[a.zekerheid] - ZEKER[b.zekerheid] || a._afstand - b._afstand || (a.id < b.id ? -1 : 1));
  return uit.slice(0, 3).map((x) => { delete x._afstand; return x; });
}

function ontleed(t, rel, ent, fav) {
  if (fmWaarde(t, 'type') !== 'shopper-zoektocht') return null;
  const st = String(fmWaarde(t, 'status') || '').toLowerCase();
  const opties = optiesVan(t, fav), adviesId = tekstVeld(fmWaarde(t, 'advies'), 8);
  const advies = opties.find((o) => o.id === adviesId) || null;
  return { id: idVan(rel), wens: tekstVeld(fmWaarde(t, 'wens'), 160) || path.basename(rel, '.md').slice(0, 160), entiteit: ent[0], entiteit_naam: ent[1],
    status: STATUSSEN.indexOf(st) >= 0 ? st : 'open', gezocht: tekstVeld(fmWaarde(t, 'gezocht'), 40), aantal: aantal(fmWaarde(t, 'aantal')),
    opties_aantal: opties.length, advies: advies ? advies.id : null, advies_totaal: advies ? advies.totaal_eur : null, advies_winkel: advies ? advies.winkel : null,
    advies_favoriet: advies ? advies.favoriet : false, favorieten_aantal: opties.filter((x) => x.favoriet).length, _opties: opties,
    gekocht: st === 'gekocht' ? gekochtVan(t) : null };
}

/*
 * maak(o) → { paden, lijst, zoektocht, status, gekocht, info }
 * o = { vault, vv (vault-veilig: lees, wijzig), nu?() → Date }
 */
function maak(o) {
  let laatst = null;
  function paden() {
    const uit = [];
    for (const ent of MAPPEN) {
      let n = [];
      try { n = fs.readdirSync(path.join(o.vault, ent[2])).filter((x) => /\.md$/.test(x) && !x.startsWith('.')); } catch (e) { n = []; }
      for (const x of n.sort()) uit.push({ rel: path.join(ent[2], x), ent });
    }
    return uit;
  }
  function lees(rel) { try { return o.vv.lees(path.join(o.vault, rel), 'utf8', { max: MAX_PAGINA }); } catch (e) { return null; } }
  // De favorietenlijst, bij elke vraag opnieuw (David past hem aan in Brain); onleesbaar = geen favorieten
  function favorieten() { const t = lees(FAVORIETEN); return t == null ? [] : favorietenVan(t); }
  const kaal = (z) => { const k = Object.assign({}, z); delete k._opties; return k; };
  // S5: de Facturen-database alleen-lezen openen, fn(db) draaien, weer sluiten; elke fout (geen pad, geen bestand, slot) = null
  function metFacturen(fn) {
    let db = null;
    try {
      const pad = typeof o.facturenPad === 'function' ? o.facturenPad() : null;
      if (!pad || !fs.existsSync(pad)) return null;
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(pad, { readOnly: true });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;');
      return fn(db);
    } catch (e) { return null; } finally { try { if (db) db.close(); } catch (e) {} }
  }
  // Open bovenaan, daarna gekocht/vervallen; binnen elk de vaste entiteitvolgorde, nieuwste zoektocht eerst
  const volg = (z) => MAPPEN.findIndex((m) => m[0] === z.entiteit);
  function sorteer(a, b) {
    const oa = a.status === 'open', ob = b.status === 'open';
    if (oa !== ob) return oa ? -1 : 1;
    if (volg(a) !== volg(b)) return volg(a) - volg(b);
    return a.gezocht === b.gezocht ? (a.wens < b.wens ? -1 : 1) : (a.gezocht < b.gezocht ? 1 : -1);
  }
  function lijst() {
    const uit = [];
    let onleesbaar = 0;
    const fav = favorieten();
    for (const p of paden()) {
      const t = lees(p.rel);
      if (t == null) { onleesbaar++; continue; }
      const z = ontleed(t, p.rel, p.ent, fav);
      if (z) uit.push(z);
    }
    // S5: bij gekochte zoektochten alleen het aantal passende facturen (null = Facturen niet te lezen); één keer de database open
    const gk = uit.filter((z) => z.status === 'gekocht');
    if (gk.length) {
      const n = metFacturen((db) => gk.map((z) => facturenBij(db, z).length));
      gk.forEach((z, i) => { z.factuur_gevonden = n ? n[i] : null; });
    }
    for (let i = 0; i < uit.length; i++) { uit[i] = kaal(uit[i]); if (uit[i].gekocht) uit[i].gekocht = { winkel: uit[i].gekocht.winkel }; }
    uit.sort(sorteer);
    laatst = { op: new Date().toISOString(), zoektochten: uit.length, open: uit.filter((z) => z.status === 'open').length, onleesbaar, favorieten: fav.length };
    return { status: 200, body: { ok: true, entiteiten: MAPPEN.map((m) => ({ id: m[0], naam: m[1] })), zoektochten: uit } };
  }
  function vind(id) {
    if (!ID_RE.test(String(id))) return { fout: { status: 400, body: { ok: false, fout: 'ongeldige zoektocht' } } };
    const p = paden().find((x) => idVan(x.rel) === id);
    const t = p ? lees(p.rel) : null;
    const z = t == null ? null : ontleed(t, p.rel, p.ent, favorieten());
    if (!z) return { fout: { status: 404, body: { ok: false, fout: 'onbekende zoektocht' } } };
    return { p, t, z };
  }
  function zoektocht(id) {
    const v = vind(id);
    if (v.fout) return v.fout;
    const { p, t, z } = v;
    return { status: 200, body: { ok: true, zoektocht: Object.assign(kaal(z), { opties: z._opties, pad: p.rel, bestand: path.basename(p.rel),
      eisen: R.fmLijst(t, 'eisen').map((x) => tekstVeld(x, 200)).filter(Boolean).slice(0, 20),
      aannames: R.fmLijst(t, 'aannames').map((x) => tekstVeld(x, 300)).filter(Boolean).slice(0, 20),
      inleiding: inleiding(t), waarom: sectie(t, 'Waarom dit advies'), niet_te_lezen: sectie(t, 'Niet te lezen'),
      facturen: z.status === 'gekocht' ? metFacturen((db) => facturenBij(db, z)) : undefined }) } };
  }
  // POST …/status {status: 'vervallen'}: alleen van open naar vervallen; al vervallen = 200 zonder schrijven; gekocht blijft (409)
  // POST …/status {status: 'open'} (wv2275, "Toch niet gekocht"): alleen van gekocht naar open, de gekocht-regel gaat weg; al open = 200 al
  function status(id, d) {
    if (d && d.status === 'open' && Object.keys(d).length === 1) return terugOpen(id);
    if (!d || d.status !== 'vervallen' || Object.keys(d).length !== 1) return { status: 400, body: { ok: false, fout: 'alleen status vervallen of open kan hier' } };
    const v = vind(id);
    if (v.fout) return v.fout;
    if (v.z.status === 'vervallen') return { status: 200, body: { ok: true, status: 'vervallen', al: true } };
    if (v.z.status !== 'open') return { status: 409, body: { ok: false, fout: 'deze zoektocht staat op gekocht; tik eerst Toch niet gekocht' } };
    let reden = null;
    const ok = o.vv.wijzig(path.join(o.vault, v.p.rel), function (t) {
      const fm = /^---\n([\s\S]*?)\n---/.exec(t || '');
      if (!fm) { reden = 'weg'; return null; }
      const z = ontleed(t, v.p.rel, v.p.ent);
      if (!z) { reden = 'weg'; return null; }
      if (z.status !== 'open') { reden = z.status; return null; }
      const regel = /^status:[^\n]*$/m;
      const nieuwFm = regel.test(fm[1]) ? fm[1].replace(regel, 'status: vervallen') : fm[1] + '\nstatus: vervallen';
      return '---\n' + nieuwFm + '\n---' + t.slice(fm[0].length);
    });
    if (ok) return { status: 200, body: { ok: true, status: 'vervallen' } };
    if (reden === 'vervallen') return { status: 200, body: { ok: true, status: 'vervallen', al: true } };
    if (reden === 'gekocht') return { status: 409, body: { ok: false, fout: 'deze zoektocht staat intussen op gekocht' } };
    return { status: 409, body: { ok: false, fout: 'de pagina veranderde of is weg; laad Shopper opnieuw' } };
  }
  function terugOpen(id) {
    const v = vind(id);
    if (v.fout) return v.fout;
    if (v.z.status === 'open') return { status: 200, body: { ok: true, status: 'open', al: true } };
    if (v.z.status !== 'gekocht') return { status: 409, body: { ok: false, fout: 'alleen een gekochte zoektocht kan terug naar open' } };
    let reden = null;
    const ok = o.vv.wijzig(path.join(o.vault, v.p.rel), function (t) {
      const fm = /^---\n([\s\S]*?)\n---/.exec(t || '');
      const z = fm ? ontleed(t, v.p.rel, v.p.ent) : null;
      if (!z) { reden = 'weg'; return null; }
      if (z.status !== 'gekocht') { reden = z.status; return null; }
      return '---\n' + zetStatusRegels(fm[1], 'open', null) + '\n---' + t.slice(fm[0].length);
    });
    if (ok) return { status: 200, body: { ok: true, status: 'open' } };
    if (reden === 'open') return { status: 200, body: { ok: true, status: 'open', al: true } };
    return { status: 409, body: { ok: false, fout: 'de pagina veranderde of is weg; laad Shopper opnieuw' } };
  }
  // POST …/gekocht {optie | winkel, bedrag_eur?, datum?, opmerking?} (wv2275): Davids eigen tik in de app. Van open of vervallen naar gekocht;
  // al gekocht met dezelfde gegevens = 200 al, met andere = 409 (eerst Toch niet gekocht). Bij een optie komt de winkel van de pagina (opnieuw
  // gelezen onder het slot); het bedrag komt alleen uit de vraag, nooit uit de optie.
  function gekocht(id, d) {
    const nee = (fout) => ({ status: 400, body: { ok: false, fout } });
    if (!d || typeof d !== 'object' || Array.isArray(d)) return nee('geen gegevens');
    if (Object.keys(d).some((k) => GEKOCHT_VELDEN.indexOf(k) < 0)) return nee('onbekend veld');
    const heeftOptie = d.optie != null && d.optie !== '', heeftWinkel = d.winkel != null && d.winkel !== '';
    if (heeftOptie === heeftWinkel) return nee('kies een optie of vul een winkel in (één van beide)');
    if (heeftOptie && (typeof d.optie !== 'string' || !/^o\d{1,3}$/.test(d.optie))) return nee('ongeldige optie');
    let winkelElders = null;
    if (heeftWinkel) { winkelElders = typeof d.winkel === 'string' ? mapTekst(d.winkel, 80) : null; if (!winkelElders) return nee('winkel: tekst van hooguit 80 tekens'); }
    let bedragEur = null;
    if (d.bedrag_eur != null && d.bedrag_eur !== '') {
      if (typeof d.bedrag_eur !== 'number' && typeof d.bedrag_eur !== 'string') return nee('ongeldig bedrag');
      bedragEur = bedrag(d.bedrag_eur);
      if (bedragEur == null || !Number.isFinite(bedragEur)) return nee('bedrag: een getal met hooguit 2 decimalen');
    }
    let opmerking = null;
    if (d.opmerking != null && d.opmerking !== '') {
      opmerking = typeof d.opmerking === 'string' ? mapTekst(d.opmerking, 120) : null;
      if (opmerking == null) return nee('opmerking: hooguit 120 tekens');
      opmerking = opmerking || null;
    }
    const vandaag = nlDag(typeof o.nu === 'function' ? o.nu() : new Date());
    let datum = vandaag;
    if (d.datum != null && d.datum !== '') {
      if (typeof d.datum !== 'string' || !geldigeDag(d.datum)) return nee('datum: JJJJ-MM-DD');
      datum = d.datum;
    }
    if (datum > vandaag) return nee('de datum ligt in de toekomst');
    const v = vind(id);
    if (v.fout) return v.fout;
    // niet vóór de zoekdatum min 30 dagen; onder het slot opnieuw getoetst op de herlezen pagina (review wv2275 MOET 1)
    const teVroeg = (z) => { const gz = String(z.gezocht || '').slice(0, 10); return geldigeDag(gz) && datum < dagPlus(gz, -30); };
    if (teVroeg(v.z)) return nee('de datum ligt ruim vóór de zoektocht');
    let nieuw = null, reden = null, bestaand = null;
    const maakNieuw = (z) => {
      if (!heeftOptie) return { optie: null, winkel: winkelElders, bedrag_eur: bedragEur, datum, opmerking };
      const opt = z._opties.find((x) => x.id === d.optie);
      if (!opt) return null;
      return { optie: opt.id, winkel: mapTekst(opt.winkel, 80) || null, bedrag_eur: bedragEur, datum, opmerking };
    };
    if (!maakNieuw(v.z)) return nee('onbekende optie');
    if (v.z.status === 'gekocht') {
      const g = gekochtVan(v.t), n = maakNieuw(v.z);
      return zelfdeGekocht(g, n) ? { status: 200, body: { ok: true, status: 'gekocht', al: true, gekocht: g } }
        : { status: 409, body: { ok: false, fout: 'deze zoektocht staat al op gekocht met andere gegevens; tik eerst Toch niet gekocht' } };
    }
    const ok = o.vv.wijzig(path.join(o.vault, v.p.rel), function (t) {
      const fm = /^---\n([\s\S]*?)\n---/.exec(t || '');
      const z = fm ? ontleed(t, v.p.rel, v.p.ent) : null;
      if (!z) { reden = 'weg'; return null; }
      if (z.status !== v.z.status) { reden = z.status; bestaand = z.status === 'gekocht' ? gekochtVan(t) : null; return null; }
      if (teVroeg(z)) { reden = 'datum'; return null; }
      nieuw = maakNieuw(z);
      if (!nieuw) { reden = 'optie'; return null; }
      return '---\n' + zetStatusRegels(fm[1], 'gekocht', gekochtRegel(nieuw)) + '\n---' + t.slice(fm[0].length);
    });
    if (ok) return { status: 200, body: { ok: true, status: 'gekocht', gekocht: Object.assign({}, nieuw, { via: 'app' }) } };
    if (reden === 'gekocht' && bestaand && nieuw === null && zelfdeGekocht(bestaand, maakNieuw(v.z))) return { status: 200, body: { ok: true, status: 'gekocht', al: true, gekocht: bestaand } };
    return { status: 409, body: { ok: false, fout: 'de pagina veranderde of is weg; laad Shopper opnieuw' } };
  }
  function info() { return Object.assign({ aan: true }, laatst || { op: null, zoektochten: null, open: null, onleesbaar: null, favorieten: null }); }
  return { paden, lijst, zoektocht, status, gekocht, info };
}

module.exports = { maak, ontleed, idVan, koopUrl, optiesVan, favorietenVan, isFavoriet, facturenBij, gekochtVan, gekochtRegel, mapTekst, sleutelVan, hostKern, MAPPEN, ID_RE, FAVORIETEN };
