'use strict';
/*
 * gambia-steunbord.js — steunbord Gambia: per persoon wat David toezegde, wat er betaald is (uit de bank) en wat openstaat.
 * wv3949 (besluitenpagina nr 403 = 3C103, David Ja 22-11-2026 18:23): "Wil je een steunbord dat per persoon in Gambia laat zien wat
 * je toezegde, wat je betaalde en wat nog openstaat?" → JA.
 *
 * WAAROM. De weekreview woog verzoeken tegen lopende tekst; het laatste totaaloverzicht was van 16-9 en of een toezegging (Kemo's tank van
 * D 10.000) betaald was stond nergens, terwijl de Ecobank-mutatie er wel was.
 *
 * BRONNEN (alleen lezen):
 *   - toezeggingen: de vaste plek "## Toezeggingen" (tabel) in elk dossier 20_Prive/Gambia/Personen/<Naam>.md;
 *   - betaald: de Ecobank-posten (ecobank-mail.js overzicht: mails + CSV-exports) en de NL-posten met categorie Gambia-hulp (Taptap Send e.d.).
 * KOPPELEN betaling ↔ persoon, in drie treden:
 *   zeker        Ecobank-overboeking "IFO <naam>" waarvan de naam vooraan gelijk is aan een dossiernaam (de bank noemt de ontvanger);
 *   waarschijnlijk  Xpress Cash / Taptap zonder ontvanger, maar precies één dossier noemt hetzelfde bedrag binnen 3 dagen (dossiertekst);
 *                getoond als "niet zeker";
 *   niet toe te wijzen  de rest (contant-voucher of Taptap zonder dossierspoor). Nooit stil toewijzen.
 * SOMMEN per valuta (GMD en EUR nooit opgeteld): zeker + waarschijnlijk + niet toe te wijzen + kosten = alles wat er uitging (zonder
 * eigen omzetting EUR→GMD); `klopt` toetst dat.
 */
const fs = require('fs');
const path = require('path');

let veiligObj = null;
function veilig() { if (!veiligObj) veiligObj = require(path.join(__dirname, 'vault-veilig.js')); return veiligObj; }
const VERSIE = 1;
const DOSSIER_MAP = path.join('20_Prive', 'Gambia', 'Personen');
const OVERSLAAN = /verbonden pagina|^david schaap$/i;
const KOSTEN_RE = /^(GAMSWITCH CHARGE|CHARGE|VAT)\b|\bMONTHLY\b|XPRESS CASH (CHARGE|TAX)|\bE-(BANKING|SERVICE)\b/i;
const SPOOR_MIN = { GMD: 500, EUR: 10 };   // kleinere bedragen (kosten, wisselgeld) nooit via het dossierspoor aan iemand koppelen
const MND = { januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12,
  jan: 1, feb: 2, mrt: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, okt: 10, nov: 11, dec: 12 };

function r2(n) { return Math.round(n * 100) / 100; }
function plat(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function isoDag(j, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && j >= 2000 && j <= 2100)) return null;
  const t = new Date(Date.UTC(j, m - 1, d));
  return t.getUTCMonth() === m - 1 ? t.toISOString().slice(0, 10) : null;
}
function dagVerschil(a, b) { return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000); }

// "D 10.000", "D10.000", "GMD 25,000", "€ 50", "EUR 75,95", "5.900" (zonder valuta: null) → { bedrag, valuta } of null
function leesBedrag(s) {
  const t = String(s || '').replace(/ /g, ' ');
  const m = /(€|EUR|GMD|D|dalasi)\s?([0-9][0-9.,]*)/i.exec(t) || /([0-9][0-9.,]*)\s?(GMD|dalasi|euro|EUR)\b/i.exec(t);
  if (!m) return null;
  const valTok = /^[0-9]/.test(m[1]) ? m[2] : m[1], num = /^[0-9]/.test(m[1]) ? m[1] : m[2];
  const valuta = /€|EUR|euro/i.test(valTok) ? 'EUR' : 'GMD';
  const n = getal(num, valuta);
  return n == null ? null : { bedrag: n, valuta: valuta };
}
// NL-notatie: punt = duizendtal, komma = decimaal; "10,000" (Engels duizendtal, 3 cijfers na de komma) ook als 10000
function getal(s, valuta) {
  let x = String(s).replace(/[.,]$/, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(x)) x = x.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+$/.test(x)) x = x.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(x)) x = x.replace(',', '.');
  else if (!/^\d+(\.\d{1,2})?$/.test(x)) return null;
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? r2(n) : null;
}

// alle datums in een stuk tekst (JJJJ-MM-DD, d-m-JJJJ, d-m, "22 november 2026", "16–17 november"); jaar ontbreekt → jaarStandaard
function datumsIn(tekst, jaarStandaard) {
  const uit = new Set(), t = String(tekst || '');
  let m;
  const iso = /\b(20\d\d)-(\d\d)-(\d\d)\b/g;
  while ((m = iso.exec(t))) { const d = isoDag(+m[1], +m[2], +m[3]); if (d) uit.add(d); }
  const dm = /(?<![\d-])(\d{1,2})-(\d{1,2})(?:-(20\d\d))?(?![\d-])/g;
  while ((m = dm.exec(t))) { const d = isoDag(m[3] ? +m[3] : jaarStandaard, +m[2], +m[1]); if (d) uit.add(d); }
  const tm = /\b(\d{1,2})(?:\s?[–-]\s?(\d{1,2}))?\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|jan|feb|mrt|apr|jun|jul|aug|sept|sep|okt|nov|dec)\b\.?(?:\s+(20\d\d))?/gi;
  while ((m = tm.exec(t))) {
    const mnd = MND[m[3].toLowerCase()], j = m[4] ? +m[4] : jaarStandaard;
    [m[1], m[2]].forEach(function (x) { if (x) { const d = isoDag(j, mnd, +x); if (d) uit.add(d); } });
  }
  return Array.from(uit).sort();
}
// alle bedragen in een stuk tekst, per valuta
function bedragenIn(tekst) {
  const uit = [], t = String(tekst || '').replace(/ /g, ' ');
  const re = /(€|EUR|GMD|\bD|dalasi)\s?([0-9][0-9.,]*[0-9])|\b([0-9][0-9.,]*[0-9])\s?(GMD|dalasi)\b/gi;
  let m;
  while ((m = re.exec(t))) {
    const valuta = m[1] ? (/€|EUR/i.test(m[1]) ? 'EUR' : 'GMD') : 'GMD';
    const n = getal(m[2] || m[3], valuta);
    if (n != null) uit.push({ bedrag: n, valuta: valuta });
  }
  return uit;
}

function frontmatter(tekst) {
  const m = /^---\n([\s\S]*?)\n---/.exec(tekst);
  return m ? m[1] : '';
}
function aliassen(fm) {
  const m = /^aliases:\s*\[(.*)\]\s*$/m.exec(fm);
  if (!m) return [];
  return m[1].split(',').map(function (x) { return x.trim().replace(/^["']|["']$/g, '').trim(); }).filter(Boolean);
}

// de vaste plek: "## Toezeggingen" met een tabel | Datum | Toezegging | Bedrag | Citaat | Stand |
function toezeggingenUit(tekst) {
  const regels = String(tekst || '').split('\n');
  const uit = [], fouten = [];
  let binnen = false;
  for (const r of regels) {
    if (/^##\s+Toezeggingen\b/i.test(r)) { binnen = true; continue; }
    if (binnen && /^#{1,2}\s/.test(r)) break;
    if (!binnen || !/^\s*\|/.test(r)) continue;
    const c = r.trim().replace(/^\||\|$/g, '').split('|').map(function (x) { return x.trim(); });
    if (c.length < 5 || /^-+$/.test(c[0].replace(/[:\s]/g, '')) || /^datum$/i.test(c[0])) continue;
    const dm = /^(20\d\d)-(\d\d)-(\d\d)$/.exec(c[0]);
    const datum = dm ? isoDag(+dm[1], +dm[2], +dm[3]) : null;
    if (!datum) { fouten.push('datum onleesbaar: ' + c[0].slice(0, 20)); continue; }
    const st = c[4].toLowerCase();
    const stand = /^vervallen/.test(st) ? 'vervallen' : /^betaald/.test(st) ? 'betaald' : /^doorlopend/.test(st) ? 'doorlopend' : 'open';
    const sd = /(20\d\d-\d\d-\d\d)/.exec(c[4]);
    uit.push({ datum: datum, wat: c[1].slice(0, 120), bedrag: leesBedrag(c[2]), bedrag_tekst: c[2].slice(0, 40),
      citaat: c[3].replace(/^[*_"“”']+|[*_"“”']+$/g, '').slice(0, 300), stand_dossier: stand, stand_tekst: c[4].slice(0, 120), stand_datum: sd ? sd[1] : null });
  }
  return { lijst: uit, fouten: fouten };
}

// stukken tekst (alinea/bolletje) met de kop erbij, voor het dossierspoor van een betaling
function stukken(tekst) {
  const uit = [];
  let kop = '', buf = [];
  const sluit = function () { if (buf.length) { uit.push(kop + '\n' + buf.join('\n')); buf = []; } };
  String(tekst || '').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n').forEach(function (r) {
    if (/^#{1,6}\s/.test(r)) { sluit(); kop = r; return; }
    if (!r.trim() || /^\s*[-*]\s/.test(r)) sluit();
    if (r.trim()) buf.push(r);
  });
  sluit();
  return uit;
}

function leesDossiers(vaultDir) {
  const dir = path.join(vaultDir, DOSSIER_MAP);
  const uit = [], fouten = [];
  let namen = [];
  try { namen = fs.readdirSync(dir).filter(function (f) { return /\.md$/.test(f); }); }
  catch (e) { return { dossiers: [], fouten: ['dossiermap niet te lezen'] }; }
  namen.sort().forEach(function (f) {
    const naam = f.replace(/\.md$/, '');
    if (OVERSLAAN.test(naam)) return;
    let t = '';
    // vault-veilig (O_NOFOLLOW, map via dir-fd): socev kan in de vault een symlink zetten; nooit een link volgen als claude
    try { t = veilig().lees(path.join(dir, f), 'utf8', { max: 400000 }); } catch (e) { fouten.push(naam + ': niet te lezen (' + String(e.code || 'fout') + ')'); return; }
    const tz = toezeggingenUit(t);
    tz.fouten.forEach(function (x) { fouten.push(naam + ': ' + x); });
    uit.push({ naam: naam, aliassen: aliassen(frontmatter(t)), toezeggingen: tz.lijst, heeft_plek: /^##\s+Toezeggingen\b/im.test(t), stukken: stukken(t) });
  });
  return { dossiers: uit, fouten: fouten };
}

// "IFO KEMO TOURAY Interbank Watertank" → dossier waarvan de naam vooraan staat (alle woorden van de naam, in volgorde)
function persoonVoor(naamDeel, dossiers) {
  const p = plat(naamDeel);
  let beste = null;
  dossiers.forEach(function (d) {
    [d.naam].concat(d.aliassen).forEach(function (n) {
      const w = plat(n.replace(/\(.*?\)/g, ''));
      if (w.split(' ').length < 2) return;   // één woord (Fatoumata) is te weinig om een bankontvanger zeker te noemen
      if ((p + ' ').indexOf(w + ' ') === 0 && (!beste || w.length > beste.len)) beste = { d: d, len: w.length };
    });
  });
  return beste ? beste.d : null;
}

function soortEcobank(p, dossiers) {
  const o = String(p.omschrijving || '');
  if (KOSTEN_RE.test(o)) return { soort: 'kosten' };
  if (/CREDIT INTEREST/i.test(o)) return { soort: 'rente' };
  const ifo = /\bIFO\s+(.+)$/i.exec(o), bo = /\bB\/O\s+(.+?)(?=\s+IFO\b|$)/i.exec(o);
  if (ifo && /^DAVID SCHAAP\b/i.test(plat(ifo[1]))) return { soort: 'intern', memo: plat(ifo[1]).replace(/^DAVID SCHAAP\s*/, '') };
  if (!ifo && bo && /^DAVID SCHAAP\b/i.test(plat(bo[1]))) return { soort: 'intern', memo: plat(bo[1]).replace(/^DAVID SCHAAP\s*/, '') };
  if (p.soort === 'af' && ifo) { const d = persoonVoor(ifo[1], dossiers); return d ? { soort: 'persoon', naam: d.naam, zeker: true } : { soort: 'onherleid', ontvanger: plat(ifo[1]).slice(0, 40) }; }
  if (p.soort === 'bij' && bo) { const d = persoonVoor(bo[1], dossiers); return { soort: 'ontvangen', naam: d ? d.naam : null, van: plat(bo[1]).slice(0, 40) }; }
  if (p.soort === 'af') return { soort: 'onherleid', contant: /XPRESS CASH/i.test(o) };
  return { soort: 'overig_bij' };
}

// dossierspoor: welke dossiers noemen dit bedrag (zelfde valuta) in een stuk met een datum binnen 3 dagen van de bankdatum?
function spoor(post, dossiers) {
  const jaar = +post.datum.slice(0, 4), hits = [];
  if (post.bedrag < (SPOOR_MIN[post.valuta] || 0)) return hits;
  dossiers.forEach(function (d) {
    for (const s of d.stukken) {
      if (!bedragenIn(s).some(function (b) { return b.valuta === post.valuta && Math.abs(b.bedrag - post.bedrag) < 0.5; })) continue;
      if (!datumsIn(s, jaar).some(function (x) { return Math.abs(dagVerschil(post.datum, x)) <= 3; })) continue;
      hits.push(d.naam); break;
    }
  });
  return hits;
}

/*
 * bereken({ ecobank: [{datum, soort:'af'|'bij', valuta, bedrag(+/-), omschrijving}], nl: [{datum, bedrag(<0), valuta, tegenpartij, omschrijving}],
 *           dossiers: leesDossiers(...).dossiers, van: 'JJJJ-MM-DD', vandaag })
 */
function bereken(inv) {
  const dossiers = inv.dossiers || [], van = inv.van || null;
  const pp = {};
  dossiers.forEach(function (d) { pp[d.naam] = { naam: d.naam, toezeggingen: [], betaald: [], ontvangen: [], som: {}, heeft_plek: d.heeft_plek }; });
  const onherleid = [], kosten = [], intern = [], twijfel = [];
  const som = { uit: {}, zeker: {}, waarschijnlijk: {}, onherleid: {}, kosten: {} };
  const tel = function (bak, valuta, n) { bak[valuta] = r2((bak[valuta] || 0) + n); };
  const posten = [];
  (inv.ecobank || []).forEach(function (p) {
    if (van && p.datum < van) return;
    const bedrag = Math.abs(Number(p.bedrag));
    if (!Number.isFinite(bedrag) || bedrag === 0) return;
    posten.push({ bron: 'Ecobank', datum: p.datum, soort: p.soort, valuta: p.valuta, bedrag: r2(bedrag), omschrijving: String(p.omschrijving || '').slice(0, 140), k: soortEcobank(p, dossiers) });
  });
  (inv.nl || []).forEach(function (p) {
    if (van && p.datum < van) return;
    const bedrag = Math.abs(Number(p.bedrag));
    if (!(Number(p.bedrag) < 0) || !Number.isFinite(bedrag)) return;
    posten.push({ bron: 'NL-bank', datum: p.datum, soort: 'af', valuta: p.valuta || 'EUR', bedrag: r2(bedrag),
      omschrijving: String(p.tegenpartij || p.omschrijving || '').slice(0, 80), k: { soort: 'onherleid', taptap: /taptap/i.test(String(p.tegenpartij || '') + ' ' + String(p.omschrijving || '')) } });
  });
  posten.sort(function (a, b) { return a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : 0; });
  posten.forEach(function (p) {
    const k = p.k, kaal = { datum: p.datum, bedrag: p.bedrag, valuta: p.valuta, bron: p.bron, omschrijving: p.omschrijving };
    if (k.soort === 'intern') { intern.push(Object.assign({ memo: k.memo || '' }, kaal)); return; }
    if (k.soort === 'rente' || k.soort === 'overig_bij') return;
    if (k.soort === 'ontvangen') { if (k.naam && pp[k.naam]) pp[k.naam].ontvangen.push(kaal); return; }
    tel(som.uit, p.valuta, p.bedrag);
    if (k.soort === 'kosten') { kosten.push(kaal); tel(som.kosten, p.valuta, p.bedrag); return; }
    if (k.soort === 'persoon' && pp[k.naam]) { pp[k.naam].betaald.push(Object.assign({ zeker: true }, kaal)); tel(som.zeker, p.valuta, p.bedrag); return; }
    const hits = spoor(p, dossiers);
    if (hits.length === 1 && pp[hits[0]]) {
      pp[hits[0]].betaald.push(Object.assign({ zeker: false, waarom: 'zelfde bedrag en datum in het dossier' }, kaal));
      tel(som.waarschijnlijk, p.valuta, p.bedrag);
      return;
    }
    const o = Object.assign({ soort: k.contant ? 'Xpress Cash (contant, ontvanger niet in de bank)' : k.taptap ? 'Taptap Send (ontvanger niet in de bank)' : 'ontvanger niet herkend' }, kaal);
    if (hits.length > 1) { o.kandidaten = hits; twijfel.push(o); }
    onherleid.push(o);
    tel(som.onherleid, p.valuta, p.bedrag);
  });
  // toezeggingen tegen de betalingen
  dossiers.forEach(function (d) {
    const P = pp[d.naam];
    const gebruikt = new Set();   // Codex MOET 2: elke betaling dekt hooguit één toezegging (oud → nieuw)
    d.toezeggingen.slice().sort(function (a, b) { return a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : 0; }).forEach(function (t) {
      const uit = { datum: t.datum, wat: t.wat, bedrag: t.bedrag, bedrag_tekst: t.bedrag_tekst, citaat: t.citaat, dossier: t.stand_tekst };
      const na = P.betaald.filter(function (b) { return b.datum >= t.datum && !gebruikt.has(b); });
      const passend = function (b) { return t.bedrag && b.valuta === t.bedrag.valuta && b.bedrag >= t.bedrag.bedrag * 0.95 && b.bedrag <= t.bedrag.bedrag * 1.05; };
      const woord = plat(t.wat).split(' ').filter(function (w) { return w.length >= 5; });
      const memo = function (b) { return woord.some(function (w) { return plat(b.omschrijving).indexOf(w) >= 0; }); };
      const zeker = na.find(function (b) { return b.zeker && (passend(b) || memo(b)); });
      const misschien = na.find(function (b) { return !b.zeker && passend(b); });
      if (t.stand_dossier === 'vervallen') uit.stand = 'vervallen';
      else if (t.stand_dossier === 'doorlopend') uit.stand = 'doorlopend';
      else if (zeker) { uit.stand = 'betaald'; uit.zeker = true; uit.betaling = zeker; gebruikt.add(zeker); }
      // Codex MOET 1: "betaald" in het dossier (door de weekreview gezet) sluit niets af zonder bank: eigen stand, telt als niet zeker
      else if (t.stand_dossier === 'betaald') { uit.stand = 'betaald volgens dossier'; uit.zeker = false; uit.waarom = 'volgens het dossier: ' + t.stand_tekst + '; niet in de bank aan deze persoon'; }
      else if (misschien) { uit.stand = 'mogelijk betaald'; uit.zeker = false; uit.betaling = misschien; gebruikt.add(misschien); }
      else uit.stand = 'open';
      P.toezeggingen.push(uit);
    });
    P.betaald.forEach(function (b) { const s = P.som[b.valuta] = P.som[b.valuta] || { zeker: 0, waarschijnlijk: 0 }; s[b.zeker ? 'zeker' : 'waarschijnlijk'] = r2(s[b.zeker ? 'zeker' : 'waarschijnlijk'] + b.bedrag); });
    P.toezeggingen.sort(function (a, b) { return a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : 0; });
    P.open = P.toezeggingen.filter(function (t) { return t.stand === 'open' || t.stand === 'doorlopend'; }).length;
    P.niet_zeker = P.toezeggingen.filter(function (t) { return t.stand === 'mogelijk betaald' || t.stand === 'betaald volgens dossier'; }).length;
    P.ontvangen_som = {};   // Codex MOET 3: per valuta
    P.ontvangen.forEach(function (x) { P.ontvangen_som[x.valuta] = r2((P.ontvangen_som[x.valuta] || 0) + x.bedrag); });
  });
  const klopt = {};
  Object.keys(som.uit).forEach(function (v) {
    const delen = ['zeker', 'waarschijnlijk', 'onherleid', 'kosten'].reduce(function (s, k) { return s + (som[k][v] || 0); }, 0);
    klopt[v] = Math.abs(r2(delen) - som.uit[v]) < 0.01;
  });
  const personen = Object.keys(pp).map(function (n) { return pp[n]; })
    .filter(function (p) { return p.toezeggingen.length || p.betaald.length || p.ontvangen.length; })
    .sort(function (a, b) { return (b.open - a.open) || (b.betaald.length - a.betaald.length) || (a.naam < b.naam ? -1 : 1); });
  return { versie: VERSIE, van: van, personen: personen, niet_toe_te_wijzen: onherleid, twijfel: twijfel, kosten: { aantal: kosten.length, som: som.kosten },
    intern: intern, sommen: som, klopt: klopt, zonder_plek: dossiers.filter(function (d) { return !d.heeft_plek; }).map(function (d) { return d.naam; }) };
}

function geld(n, v) {
  const [h, c] = Math.abs(n).toFixed(2).split('.');
  const s = h.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (c === '00' ? '' : ',' + c);
  return (v === 'EUR' ? '€ ' : 'D ') + s;
}
function korteDag(d) { return d ? Number(d.slice(8, 10)) + '-' + Number(d.slice(5, 7)) : '?'; }
// compacte tekst voor de weekreview (Socev neemt hieruit de regel "Steunbord: …" en per contact het stuk over die persoon)
function md(b) {
  const r = [];
  b.personen.forEach(function (p) {
    const delen = [];
    p.toezeggingen.forEach(function (t) {
      const bed = t.bedrag ? geld(t.bedrag.bedrag, t.bedrag.valuta) : /\d/.test(t.bedrag_tekst || '') ? t.bedrag_tekst : '';
      let st = t.stand;
      if (t.stand === 'betaald' && t.zeker) st = 'betaald ' + korteDag(t.betaling.datum) + ' (bank)';
      else if (t.stand === 'betaald volgens dossier') st = 'betaald volgens dossier, niet in de bank aan deze persoon (niet zeker): ' + t.dossier.replace(/^betaald\s*/i, '');
      else if (t.stand === 'mogelijk betaald') st = 'mogelijk betaald ' + korteDag(t.betaling.datum) + ' (niet zeker)';
      delen.push('toegezegd ' + korteDag(t.datum) + ' ' + t.wat + (bed ? ' ' + bed : '') + ' → ' + st);
    });
    const s = Object.keys(p.som).map(function (v) {
      const x = p.som[v];
      return (x.zeker ? geld(x.zeker, v) + ' zeker' : '') + (x.zeker && x.waarschijnlijk ? ' + ' : '') + (x.waarschijnlijk ? geld(x.waarschijnlijk, v) + ' niet zeker' : '');
    }).join(', ');
    if (s) delen.push('betaald sinds ' + korteDag(b.van) + ': ' + s);
    if (p.ontvangen.length) delen.push('van hem/haar ontvangen: ' + p.ontvangen.length + '× (' + Object.keys(p.ontvangen_som).map(function (v) { return geld(p.ontvangen_som[v], v); }).join(' en ') + ')');
    r.push('- **' + p.naam + '**: ' + (delen.join('; ') || 'niets'));
  });
  const on = {};
  b.niet_toe_te_wijzen.forEach(function (x) { on[x.valuta] = (on[x.valuta] || 0) + x.bedrag; });
  const ot = Object.keys(on).map(function (v) { return geld(on[v], v); }).join(' en ');
  if (ot) r.push('- Niet aan een persoon toe te wijzen: ' + b.niet_toe_te_wijzen.length + ' betalingen, ' + ot + ' (Xpress Cash en Taptap noemen geen ontvanger)');
  const k = Object.keys(b.klopt).filter(function (v) { return !b.klopt[v]; });
  r.push('- Som: ' + Object.keys(b.sommen.uit).map(function (v) { return geld(b.sommen.uit[v], v) + ' uitgegaan'; }).join(', ') + (k.length ? ' — LET OP: som klopt niet (' + k.join(', ') + ')' : ' — klopt met de bank'));
  return r.join('\n');
}

module.exports = { bereken, leesDossiers, toezeggingenUit, leesBedrag, datumsIn, bedragenIn, persoonVoor, soortEcobank, md, VERSIE };
