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
 *  - Eén schrijfactie: status open → vervallen ("Niet meer nodig"), via o.vv.wijzig (opnieuw gelezen, alleen de statusregel). Gekocht
 *    gaat NIET via de App (review 2-11 MOET 5: alleen op Davids eigen woord via Socev).
 *  - Favoriet (wv2267, David 2-11: "Kunnen we gericht iets bouwen dat ook op favoriete websites zoekt? … Ik wil altijd prijs en levervoorraad
 *    weten"): de vault-pagina FAVORIETEN (type: shopper-favorieten, lijst winkels: {domein, aan}) wordt bij elke vraag gelezen (vault-veilig,
 *    zelfde grens). Een optie krijgt favoriet: true als haar (al goedgekeurde https-)koop-link op een domein staat dat aan staat (zelfde host
 *    of een subdomein). Geen pagina of geen geldige regels = niets favoriet. De pagina zelf wordt nooit geschreven.
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
function ontleed(t, rel, ent, fav) {
  if (fmWaarde(t, 'type') !== 'shopper-zoektocht') return null;
  const st = String(fmWaarde(t, 'status') || '').toLowerCase();
  const opties = optiesVan(t, fav), adviesId = tekstVeld(fmWaarde(t, 'advies'), 8);
  const advies = opties.find((o) => o.id === adviesId) || null;
  return { id: idVan(rel), wens: tekstVeld(fmWaarde(t, 'wens'), 160) || path.basename(rel, '.md').slice(0, 160), entiteit: ent[0], entiteit_naam: ent[1],
    status: STATUSSEN.indexOf(st) >= 0 ? st : 'open', gezocht: tekstVeld(fmWaarde(t, 'gezocht'), 40), aantal: aantal(fmWaarde(t, 'aantal')),
    opties_aantal: opties.length, advies: advies ? advies.id : null, advies_totaal: advies ? advies.totaal_eur : null, advies_winkel: advies ? advies.winkel : null,
    advies_favoriet: advies ? advies.favoriet : false, favorieten_aantal: opties.filter((x) => x.favoriet).length, _opties: opties };
}

/*
 * maak(o) → { paden, lijst, zoektocht, status, info }
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
      if (z) uit.push(kaal(z));
    }
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
      inleiding: inleiding(t), waarom: sectie(t, 'Waarom dit advies'), niet_te_lezen: sectie(t, 'Niet te lezen') }) } };
  }
  // POST …/status {status: 'vervallen'}: alleen van open naar vervallen; al vervallen = 200 zonder schrijven; gekocht blijft (409)
  function status(id, d) {
    if (!d || d.status !== 'vervallen' || Object.keys(d).length !== 1) return { status: 400, body: { ok: false, fout: 'alleen status vervallen kan hier' } };
    const v = vind(id);
    if (v.fout) return v.fout;
    if (v.z.status === 'vervallen') return { status: 200, body: { ok: true, status: 'vervallen', al: true } };
    if (v.z.status !== 'open') return { status: 409, body: { ok: false, fout: 'deze zoektocht staat op gekocht; dat verander je via Socev' } };
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
  function info() { return Object.assign({ aan: true }, laatst || { op: null, zoektochten: null, open: null, onleesbaar: null, favorieten: null }); }
  return { paden, lijst, zoektocht, status, info };
}

module.exports = { maak, ontleed, idVan, koopUrl, optiesVan, favorietenVan, isFavoriet, MAPPEN, ID_RE, FAVORIETEN };
