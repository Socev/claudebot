'use strict';
// ── OVIS Vastgoed fase 1 (wv3085, 14-11-2026; advies vault "01_Ontwikkeling/Overheids-API's - wat kunnen we ermee (Fable 5.2, 14-11-2026)" § 4) ──
// Eén privé-scherm met alles over Davids eigen woning en zijn twee garageboxen: kerngegevens, waarde (aankoop, taxaties, WOZ, indicatie),
// bouw en techniek, grond en water, regels en buurt, stukken. Eigen databank vastgoed.sqlite op de pod (map 700, bestand 600).
//
// Twee bronnen:
// - Het dossier in de vault (alleen lezen): de pagina's in 20_Prive/Huis (Woning*.md = de woning, Garagebox*.md = de boxen, de overige
//   pagina's = verbouwingen op de tijdlijn) en de bestandsnamen in 20_Prive/Bronnen/Huis (stukken: alleen een verwijzing, nooit een kopie).
//   De lezer is bewust eng: hij neemt alleen wat in de vaste vorm van die pagina's staat en laat de rest grijs (dossierstand).
// - Openbare overheidsbronnen via de gedeelde laag van OSINT (osint.py vastgoed; server.js geeft hem als o.bronnen). Naar buiten gaan alleen
//   nummers (BAG-nummer, pandnummer, kadastrale aanduiding) en een kaartvak; nooit het adres. Elke aanroep komt in de tabel aanroep.
//
// Harde grenzen (opdracht wv3085, grondwet 1, 2, 8): alleen Davids eigen objecten (geen vrij adresveld; een ander adres hoort in OSINT);
// adressen, nummers en bedragen alleen hier en op het scherm, nooit in een reden, fout of info (server.js logt alleen route + reden);
// geen netwerk, proces of log in deze module (CI-poort test/vastgoed.sh: alleen fs, path, crypto, node:sqlite). WOZ automatisch opvragen,
// sleutels voor Omgevingswet/Ruimtelijke Plannen, een vergunningwachter en bank/hypotheek zijn fase 2–4.
// De waarde-indicatie heet altijd "indicatie": laatste taxatie × landelijke CBS-prijsindex (nu / toen); geen taxatie, geen advies.
//
// Fase 2 (wv3102, 15-11-2026; David Ja 14-11 23:49): hypotheek per object (leningdelen van de hypotheekpagina in 20_Prive/Financien, reeksen
// lening en restschuld), verbouwkosten (totalen uit de offertetabellen van de verbouwpagina's), servicekosten van de boxen (VvE-posten uit de
// privébank, alleen lezen: bank-archief transacties.sqlite) en stroom per maand (Tibber, tibber.sqlite, alleen lezen), plus een WOZ-beschikking
// die David toevoegt: server.js leest de tekst en bewaart het stuk in 20_Prive/Bronnen/Huis, deze module bewaart alleen wat David bevestigde.
// Bedragen staan alleen in vastgoed.sqlite en op het scherm; info() geeft alleen aantallen. WOZ automatisch opvragen is NIET gebouwd.
//
// Gebruik vanuit server.js: require('./vastgoed.js').maak({ map, vault, bronnen(invoer) → Promise<osint-uitkomst>, bank, tibber })
//   → { app({ pad, methode, body }) → Promise<{ status, body, reden }>, info(), leesDossier(), wozHerken(tekst), wozControle(body), wozVastleggen(c, stuk) }.

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSIE = 2;   // 2 = fase 2 (wv3102): leningdeel, woz_eigen; reeksen lening/restschuld/verbouwing/servicekosten/stroom
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (sleutel TEXT PRIMARY KEY, waarde TEXT);
CREATE TABLE IF NOT EXISTS object (id INTEGER PRIMARY KEY AUTOINCREMENT, sleutel TEXT NOT NULL UNIQUE, soort TEXT NOT NULL CHECK (soort IN ('woning','garagebox')),
  naam TEXT NOT NULL, adres TEXT, dossier TEXT NOT NULL, vbo TEXT NOT NULL DEFAULT '[]', pand TEXT NOT NULL DEFAULT '[]', percelen TEXT NOT NULL DEFAULT '[]',
  woz_nr TEXT, zoek TEXT, punt TEXT, bag_gemeten TEXT, volgorde INTEGER NOT NULL DEFAULT 0, dossier_op TEXT, extern_op TEXT, bron_stand TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS feit (id INTEGER PRIMARY KEY AUTOINCREMENT, object INTEGER NOT NULL REFERENCES object(id), herkomst TEXT NOT NULL CHECK (herkomst IN ('dossier','extern')),
  rubriek TEXT NOT NULL, veld TEXT NOT NULL, waarde TEXT NOT NULL, peildatum TEXT, bron TEXT NOT NULL, licentie TEXT, url TEXT, soort TEXT, opgehaald TEXT NOT NULL, volgorde INTEGER NOT NULL DEFAULT 0,
  groep TEXT);
CREATE INDEX IF NOT EXISTS feit_object ON feit (object, herkomst);
CREATE TABLE IF NOT EXISTS reeks (id INTEGER PRIMARY KEY AUTOINCREMENT, object INTEGER REFERENCES object(id), reeks TEXT NOT NULL, peildatum TEXT NOT NULL,
  waarde REAL NOT NULL, eenheid TEXT NOT NULL, toelichting TEXT, bron TEXT NOT NULL, herkomst TEXT NOT NULL, opgehaald TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stuk (id INTEGER PRIMARY KEY AUTOINCREMENT, pad TEXT NOT NULL UNIQUE, naam TEXT NOT NULL, soort TEXT NOT NULL, datum TEXT, objecten TEXT NOT NULL,
  grootte INTEGER, gezien TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gebeurtenis (id INTEGER PRIMARY KEY AUTOINCREMENT, object INTEGER NOT NULL REFERENCES object(id), datum TEXT NOT NULL, titel TEXT NOT NULL,
  soort TEXT NOT NULL, pagina TEXT, bron TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS beeld (object INTEGER NOT NULL REFERENCES object(id), volgorde INTEGER NOT NULL, soort TEXT NOT NULL, titel TEXT NOT NULL, jaar TEXT,
  src TEXT NOT NULL, over TEXT NOT NULL DEFAULT '[]', bron TEXT, opgehaald TEXT NOT NULL, PRIMARY KEY (object, volgorde));
CREATE TABLE IF NOT EXISTS aanroep (id INTEGER PRIMARY KEY AUTOINCREMENT, tijd TEXT NOT NULL, object INTEGER, bron TEXT NOT NULL, host TEXT, naar_buiten TEXT,
  status TEXT, ms INTEGER);
CREATE TABLE IF NOT EXISTS leningdeel (id INTEGER PRIMARY KEY AUTOINCREMENT, object INTEGER NOT NULL REFERENCES object(id), naam TEXT NOT NULL, doel TEXT, hoofdsom REAL,
  start TEXT, rente TEXT, rente_bank TEXT, rentevast_tot TEXT, einde TEXT, restschuld REAL, restschuld_op TEXT, restschuld_bron TEXT, bron TEXT NOT NULL, opgehaald TEXT NOT NULL,
  volgorde INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS woz_eigen (id INTEGER PRIMARY KEY AUTOINCREMENT, object INTEGER NOT NULL REFERENCES object(id), jaar INTEGER NOT NULL, peildatum TEXT NOT NULL,
  waarde REAL NOT NULL, pad TEXT, sha TEXT, bevestigd TEXT NOT NULL, UNIQUE (object, jaar));
`;
const HUIS = '20_Prive/Huis';
const BRONNEN = '20_Prive/Bronnen/Huis';
const RUBRIEKEN = ['overzicht', 'waarde', 'bouw', 'grond', 'regels'];
const GROEPEN = ['ls', 'bag', '3dbag', 'perceel', 'ahn', 'bodem', 'fundering', 'plannen', 'bro', 'cbs', 'lbm', 'sru', 'ep'];   // de bronnen van osint.py vastgoed
const GROEP_NAAM = { ls: 'Locatieserver', bag: 'BAG', '3dbag': '3D-BAG', perceel: 'kadastrale kaart', ahn: 'hoogtebestand', bodem: 'Bodemloket', fundering: 'funderingskaart',
  plannen: 'ruimtelijke plannen', bro: 'BRO', cbs: 'CBS-buurtcijfers', lbm: 'Leefbaarometer', sru: 'bekendmakingen', ep: 'energielabel' };
const EXTERN_VERS_MS = 30 * 24 * 3600 * 1000;      // openbare gegevens ouder dan 30 dagen = "verloopt" in de dossierstand
const VERVERS_MIN_MS = 10 * 60 * 1000;             // hooguit eens per 10 minuten per object naar buiten
const AANROEP_DAGEN = 365;
const FINANCIEN = '20_Prive/Financien';
const GELD_DAG_MS = 24 * 3600 * 1000;               // fase 2: bank, Tibber en hypotheek opnieuw lezen bij openen als de laatste lezing ouder is dan een dag
const KORT = { jan: 1, feb: 2, mrt: 3, maa: 3, apr: 4, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dec: 12 };
const MAAND = { januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12 };

class Fout extends Error { constructor(status, tekst) { super(tekst); this.status = status; } }
const nuIso = () => new Date().toISOString();
const nlDag = (x) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(x || '')); return m ? `${Number(m[3])}-${Number(m[2])}-${m[1]}` : String(x || ''); };
const isoGoed = (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && new Date(x + 'T12:00:00Z').toISOString().slice(0, 10) === x;

// ---------------------------------------------------------------- dossierlezer (pure functies; getoetst met verzonnen pagina's)
function iso(d, m, j) { const s = `${j}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; return isoGoed(s) ? s : null; }
function datumUit(t) {   // "18-12-2014", "18 augustus 2026", "2026-08-18"
  const s = String(t || '');
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/); if (m) return iso(m[3], m[2], m[1]);
  m = s.match(/(\d{1,2})-(\d{1,2})-(\d{4})/); if (m) return iso(m[1], m[2], m[3]);
  m = s.match(/(\d{1,2}) (januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december) (\d{4})/i);
  if (m) return iso(m[1], MAAND[m[2].toLowerCase()], m[3]);
  return null;
}
function euroUit(t) {   // "€ 1.234.567" / "€ 45.678,90" → 1234567 / 45678.9 (euro)
  const m = String(t || '').match(/€\s*([\d.]+(?:,\d{1,2})?)(?!\s*(?:k|mln|miljoen))/);
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}
const kaal = (t) => String(t || '').replace(/\*\*/g, '').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\s+/g, ' ').trim();
function sectie(md, kop) {   // tekst onder "## kop" tot de volgende ## of #
  const i = md.search(new RegExp('^##\\s+' + kop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'm'));
  if (i < 0) return '';
  const rest = md.slice(i).split('\n').slice(1).join('\n');
  const j = rest.search(/^#{1,2}\s/m);
  return j < 0 ? rest : rest.slice(0, j);
}
function tabelRij(md, label) {   // | Label | waarde |
  const m = md.match(new RegExp('^\\|\\s*' + label + '\\s*\\|\\s*(.+?)\\s*\\|\\s*$', 'mi'));
  return m ? m[1] : null;
}
function titel(md) { const m = md.match(/^#\s+(.+)$/m); return m ? kaal(m[1]) : null; }
function bagSoort(id) { return { '01': 'vbo', '10': 'pand', '20': 'nummeraanduiding' }[String(id).slice(4, 6)] || null; }

function leesWoning(md) {
  const u = { soort: 'woning', naam: null, adres: null, vbo: [], pand: [], percelen: [], woz_nr: null, feiten: [], reeks: [], gebeurtenissen: [] };
  const f = (rubriek, veld, waarde, peildatum) => { if (waarde !== null && waarde !== undefined && waarde !== '') u.feiten.push({ rubriek, veld, waarde: String(waarde), peildatum: peildatum || null }); };
  u.naam = 'Woning';
  const kern = sectie(md, 'Kerngegevens');
  const adr = kern.match(/\*\*Adres:\*\*\s*([^.\n]+?)(?:\.\s|\.$|\n)/m);
  u.adres = adr ? kaal(adr[1]) : null;
  const reg = kern.match(/Registratienummers:[\s\S]*?(?=\n- \*\*|\n\n|$)/);
  const regT = reg ? reg[0] : '';
  const woz = regT.match(/WOZ-objectnummer\s*\**\s*(\d{6,16})/);
  u.woz_nr = woz ? woz[1] : null;
  for (const id of new Set(regT.match(/\b\d{16}\b/g) || [])) {
    const s = bagSoort(id); if (s === 'vbo') u.vbo.push(id); else if (s === 'pand') u.pand.push(id);
  }
  const perc = /\*\*([A-Z][a-z]+) ([A-Z]{1,2}) (\d{1,5})\*\*:\s*(\d+)\s*m²(?:,\s*([^,(\n]+))?/g;
  let m; let samen = 0;
  while ((m = perc.exec(kern))) {
    u.percelen.push({ gemeente: m[1], sectie: m[2], nummer: m[3] });
    f('grond', `Perceel ${m[1]} ${m[2]} ${m[3]}`, `${m[4]} m²` + (m[5] ? ` (${kaal(m[5]).replace(/^"|"$/g, '')})` : ''));
    samen += Number(m[4]);
  }
  if (u.percelen.length > 1) f('grond', 'Grond samen', `${samen} m²`);
  const bj = kern.match(/Bouwjaar (\d{4})/); if (bj) f('bouw', 'Bouwjaar', bj[1]);
  const typ = kern.match(/\*\*Type:\*\*\s*([^\n]+(?:\n {2}[^\n-][^\n]*)*)/);
  if (typ) {
    const t = kaal(typ[1]);
    f('bouw', 'Type', t.split(/\.\s/)[0].replace(/\.$/, ''));
    const fu = t.match(/fundering op ([a-zà-ÿ ]+?)[,.]/i); if (fu) f('bouw', 'Fundering', 'op ' + fu[1]);
    const ga = t.match(/Gasloos:\s*([^.]+)\./); if (ga) f('bouw', 'Verwarming', 'gasloos: ' + ga[1]);
  }
  const opp = kern.match(/gebruiksoppervlakte wonen \*\*(\d+) m²\*\*/i); if (opp) f('bouw', 'Gebruiksoppervlakte wonen (meetstaat)', `${opp[1]} m²`);
  const inh = kern.match(/noteert woning (\d+) m³/); if (inh) f('bouw', 'Inhoud woning (WOZ)', `${inh[1]} m³`);
  if (u.woz_nr) f('waarde', 'WOZ-objectnummer', u.woz_nr);
  // aankoop (KOA: grond + aanneemsom = totaal)
  const koop = sectie(md, 'Aankoop en levering');
  const tot = koop.match(/\*\*totaal (€\s*[\d.,]+)\*\*/);
  const koopDag = datumUit((koop.match(/overeengekomen per \*\*([^*]+)\*\*/) || [])[1]);
  if (tot && euroUit(tot[1])) {
    u.reeks.push({ reeks: 'aankoop', peildatum: koopDag || '1900-01-01', waarde: euroUit(tot[1]), eenheid: 'euro', toelichting: 'koop-aanneemsom (grond + aanneemsom, incl. btw)' });
    if (koopDag) u.gebeurtenissen.push({ datum: koopDag, titel: 'Koop-/aannemingsovereenkomst', soort: 'aankoop' });
  }
  const lev = md.match(/^###\s+Akte van levering grond,\s*(\d{1,2}-\d{1,2}-\d{4})/m);
  if (lev && datumUit(lev[1])) u.gebeurtenissen.push({ datum: datumUit(lev[1]), titel: 'Akte van levering', soort: 'aankoop' });
  const strook = md.match(/^###\s+Extra strook grond[^,\n]*,\s*(\d{1,2}-\d{1,2}-\d{4})/m);
  if (strook && datumUit(strook[1])) u.gebeurtenissen.push({ datum: datumUit(strook[1]), titel: 'Extra strook grond geleverd', soort: 'aankoop' });
  // taxaties: | Rapport | Peildatum | Taxateur / kantoor | Doel | Marktwaarde | Na verbouwing | Validatie |
  const tax = sectie(md, 'Taxatiegeschiedenis');
  for (const r of tax.split('\n').filter((l) => /^\|\s*\d/.test(l))) {
    const c = r.split('|').slice(1, -1).map((x) => x.trim());
    if (c.length < 6) continue;
    const pd = datumUit(c[1]) || datumUit(c[0]); const mw = euroUit(c[4]); const nv = euroUit(c[5]);
    const kantoor = kaal(c[2]).split(/[;(]/)[0].replace(/^[A-Z][\w.() -]*?,\s*/, '').slice(0, 80);
    if (pd && mw) u.reeks.push({ reeks: 'taxatie', peildatum: pd, waarde: mw, eenheid: 'euro', toelichting: `marktwaarde · ${kantoor}` + (/desktop|calcasa/i.test(c[2]) ? ' · modelwaarde zonder bezichtiging' : '') });
    if (pd && nv) u.reeks.push({ reeks: 'taxatie-na', peildatum: pd, waarde: nv, eenheid: 'euro', toelichting: `marktwaarde na verbouwing · ${kantoor}` });
  }
  // WOZ: "## WOZ jjjj" met waardepeildatum en vastgestelde waarde; plus een losse zin "de WOZ-waarde voor jjjj is € …"
  const wozKop = /^##\s+WOZ (\d{4})[^\n]*$/gm;
  while ((m = wozKop.exec(md))) {
    const s = sectie(md, m[0].replace(/^##\s+/, ''));
    const pd = datumUit((s.match(/waardepeildatum[^*]*\*\*([^*]+)\*\*/) || [])[1]);
    const w = euroUit((s.match(/vastgestelde WOZ-waarde \*\*(€[^*]+)\*\*/) || [])[1]);
    if (pd && w) u.reeks.push({ reeks: 'woz', peildatum: pd, waarde: w, eenheid: 'euro', toelichting: `WOZ ${m[1]}` });
    const vorig = s.match(/de vorige was (€\s*[\d.]+)/);
    if (pd && vorig && euroUit(vorig[1])) {
      const vj = Number(pd.slice(0, 4)) - 1;
      u.reeks.push({ reeks: 'woz', peildatum: `${vj}-01-01`, waarde: euroUit(vorig[1]), eenheid: 'euro', toelichting: `WOZ ${Number(m[1]) - 1} (de vorige, uit het verslag ${m[1]})` });
    }
  }
  const losse = /de WOZ-waarde voor\s*(\d{4}) is (€\s*[\d.]+)/gi;
  while ((m = losse.exec(md))) {
    const j = Number(m[1]); const w = euroUit(m[2]);
    if (w && !u.reeks.some((r) => r.reeks === 'woz' && r.peildatum === `${j - 1}-01-01`)) u.reeks.push({ reeks: 'woz', peildatum: `${j - 1}-01-01`, waarde: w, eenheid: 'euro', toelichting: `WOZ ${j} (uit de belastingaangifte)` });
  }
  // energielabel
  const el = sectie(md, 'Energielabel');
  const kl = el.match(/\*\*Label ([A-G][+]*)\*\*/); if (kl) f('bouw', 'Energielabel', kl[1]);
  const gt = datumUit((el.match(/geldig tot\s*\**\s*(\d{1,2}-\d{1,2}-\d{4})/) || [])[1]); if (gt) f('bouw', 'Energielabel geldig tot', gt, gt);
  const gr = datumUit((el.match(/geregistreerd op\s*\**\s*(\d{1,2}-\d{1,2}-\d{4})/) || [])[1]); if (gr) f('bouw', 'Energielabel geregistreerd', gr, gr);
  const bp = sectie(md, 'Bestemmingsplan').match(/\*\*Bestemmingsplan "([^"]+)"\*\*/); if (bp) f('regels', 'Bestemmingsplan (dossier)', bp[1]);
  const zp = md.match(/^###\s+Zonnepanelen (\d{4}) \(([^)]+)\)/m); if (zp) f('bouw', 'Zonnepanelen', `${zp[2]} (${zp[1]})`);
  return u;
}

function leesBox(md) {
  const u = { soort: 'garagebox', naam: null, adres: null, vbo: [], pand: [], percelen: [], woz_nr: null, feiten: [], reeks: [], gebeurtenissen: [], complex: null, zoek: null };
  const f = (rubriek, veld, waarde, peildatum) => { if (waarde !== null && waarde !== undefined && waarde !== '') u.feiten.push({ rubriek, veld, waarde: String(waarde), peildatum: peildatum || null }); };
  const adres = tabelRij(md, 'Adres') || (tabelRij(md, 'Object') || '').replace(/^Garagebox\s*/i, '');
  u.adres = adres ? kaal(adres).replace(/\s*\([^)]*\)\s*$/, '') : null;
  const t = titel(md) || '';
  const hn = (u.adres || t).match(/\b(\d{1,4})-(\d{1,4})\b/);
  if (hn) u.zoek = { huisnummer: hn[1], toevoeging: hn[2] };
  u.naam = 'Garagebox' + (hn ? ' ' + hn[2] : '');
  // kadastraal: "Apeldoorn, sectie U, complexaanduiding **9900 A, appartementsindex 7**" of "**Apeldoorn U 9900 A 12**" (vorm, verzonnen nummers)
  let k = (tabelRij(md, 'Kadastraal') || '').match(/^([A-Z][a-z]+), sectie ([A-Z]{1,2}), complexaanduiding \*\*(\d+) ([A-Z]), appartementsindex (\d+)\*\*/);
  if (k) u.complex = { gemeente: k[1], sectie: k[2], nummer: k[3], letter: k[4], index: k[5] };
  else {
    k = (tabelRij(md, 'Kadastrale aanduiding') || '').match(/\*\*([A-Z][a-z]+) ([A-Z]{1,2}) (\d+) ([A-Z]) (\d+)\*\*/);
    if (k) u.complex = { gemeente: k[1], sectie: k[2], nummer: k[3], letter: k[4], index: k[5] };
  }
  if (u.complex) f('grond', 'Kadastrale aanduiding (appartementsrecht)', `${u.complex.gemeente} ${u.complex.sectie} ${u.complex.nummer} ${u.complex.letter} ${u.complex.index}`);
  const aandeel = tabelRij(md, 'Aandeel') || '';
  const gp = aandeel.match(/perceel ([A-Z][a-z]+) ([A-Z]{1,2}) (\d{1,5})/);
  if (gp) { u.percelen.push({ gemeente: gp[1], sectie: gp[2], nummer: gp[3] }); f('grond', 'Grondperceel van het complex', `${gp[1]} ${gp[2]} ${gp[3]}`); }
  const ad = aandeel.match(/^(\d+\/[\d.]+) onverdeeld aandeel/); if (ad) f('grond', 'Aandeel in het terrein', ad[1]);
  const inh = (tabelRij(md, 'Bouwnummer / type') || '').match(/inhoud (\d+) m³/); if (inh) f('bouw', 'Inhoud', `${inh[1]} m³`);
  const typ = (tabelRij(md, 'Bouwnummer / type') || '').match(/type ([\w.]+)/); if (typ) f('bouw', 'Type box', typ[1]);
  const vl = md.match(/Vloerbelasting type [\w.]+ \(deze box\): max\. (\d+) kg\/m²/); if (vl) f('bouw', 'Vloerbelasting', `max. ${vl[1]} kg/m²`);
  const eig = tabelRij(md, 'Eigenaren') || tabelRij(md, 'Rechthebbende'); if (eig) f('overzicht', 'Eigenaar', kaal(eig));
  const ks = md.match(/Koop-\/aanneemsom:\s*(€\s*[\d.,]+)\s*incl\. btw/);
  const ksDag = datumUit((md.match(/digitaal getekend \*\*([^*]+)\*\*/) || [])[1]);
  if (ks && euroUit(ks[1])) u.reeks.push({ reeks: 'aankoop', peildatum: ksDag || '1900-01-01', waarde: euroUit(ks[1]), eenheid: 'euro', toelichting: 'koop-aanneemsom incl. btw' });
  if (ksDag) u.gebeurtenissen.push({ datum: ksDag, titel: 'Koop-/aannemingsovereenkomst getekend', soort: 'aankoop' });
  const lev = datumUit((md.match(/akte van levering \*\*([^*]+)\*\*/i) || [])[1]) || datumUit((tabelRij(md, 'Ingeschreven') || '').replace(/\*\*/g, ''));
  if (lev) { u.gebeurtenissen.push({ datum: lev, titel: 'Geleverd en ingeschreven', soort: 'aankoop' }); f('overzicht', 'In eigendom sinds', lev, lev); }
  const vve = md.match(/VvE-bijdrage ca\. (€\s*[\d–-]+) per maand/); if (vve) f('waarde', 'VvE-bijdrage', vve[1].replace(/\s+/g, ' ') + ' per maand');
  const fin = md.match(/leningdeel \*Garagebox\*/); if (fin) f('waarde', 'Financiering', 'meegefinancierd in de hypotheek op de woning (leningdeel Garagebox)');
  if (/Hypotheek\s*\|\s*Niet nodig/.test(md)) f('waarde', 'Financiering', 'zonder hypotheek');
  // fase 2: de VvE (wikilink naar de relatiepagina, "[[…/VvE Naam|VvE Naam]]") voor de servicekosten uit de bank; geen naam in de code
  const vveLink = md.match(/\[\[(?:[^\]|]*\/)?(VvE [^\]|/]+?)(?:\|([^\]]+))?\]\]/);   // laatste deel van het pad begint met "VvE " (niet een stuk over de VvE)
  u.vve = vveLink ? kaal(vveLink[2] || vveLink[1]) : null;
  return u;
}

// ---------------------------------------------------------------- fase 2 (wv3102): hypotheek, verbouwkosten, servicekosten, stroom, WOZ-beschikking
function maandUit(t) {   // "dec 2014", "ca. jun 2051 (model)", "okt 2026" → eerste van de maand; anders een gewone datum
  const s = String(t || '').toLowerCase();
  const m = s.match(/\b(jan|feb|mrt|maa|apr|mei|jun|jul|aug|sept?|okt|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/);
  if (m) return iso(1, KORT[m[1].slice(0, 3)] || KORT[m[1]], m[2]);
  return datumUit(t);
}
// Review MOET 1 (wv3102): een restschuld van € 0 (afgelost) is een stand, geen ontbrekende waarde
function euroOfNul(t) { return /€\s*0(?:,00?)?(?![\d.,])/.test(String(t || '')) ? 0 : euroUit(t); }
function cellen(regel) { return regel.split('|').slice(1, -1).map((x) => x.trim()); }
function tabelOnder(md, kopRe) {   // de eerste tabel onder een kop (## of ###) die op kopRe past: { kop, koppen, rijen }
  const r = md.split('\n');
  for (let i = 0; i < r.length; i++) {
    const h = r[i].match(/^#{2,3}\s+(.+)$/);
    if (!h || !kopRe.test(kaal(h[1]))) continue;
    let j = i + 1;
    while (j < r.length && !/^\|/.test(r[j]) && !/^#{1,3}\s/.test(r[j])) j++;
    if (j >= r.length || !/^\|/.test(r[j])) return null;
    const blok = [];
    while (j < r.length && /^\|/.test(r[j])) blok.push(r[j++]);
    return { kop: kaal(h[1]), koppen: cellen(blok[0]).map((x) => kaal(x).toLowerCase()), rijen: blok.slice(1).filter((x) => !/^\|[\s|:-]+\|$/.test(x)).map(cellen) };
  }
  return null;
}
// Hypotheekpagina (20_Prive/Financien/Hypotheek*.md): tabel onder "## Leningdelen" (kolommen op naam: Deel, Hoofdsom, Start, Rente, Rentevast,
// Einde, "Restschuld <datum> (bank|model)") en, als die er is, de tabel onder "## Bankstand <d-m-jjjj>" (Deel model, Rente bank, Restschuld bank).
function leesHypotheek(md) {
  const u = { delen: [] };
  const t = tabelOnder(md, /^Leningdelen\b/);
  if (!t) return u;
  const kol = (re) => t.koppen.findIndex((x) => re.test(x));
  const iH = kol(/^hoofdsom/), iS = kol(/^start/), iR = kol(/^rente( nu)?$/), iV = kol(/^rentevast/), iE = kol(/^einde/);
  const rest = t.koppen.map((x, i) => ({ i, m: x.match(/^restschuld (.+?)\s*\((bank|model)\)$/) })).filter((x) => x.m)
    .map((x) => ({ i: x.i, peildatum: datumUit(x.m[1]) || maandUit(x.m[1]), bron: x.m[2] })).filter((x) => x.peildatum);
  const tekst = (c, i) => (i >= 0 && c[i] ? c[i].slice(0, 60) : null);
  for (const r of t.rijen) {
    const c = r.map(kaal);
    if (!c[0] || /^totaal/i.test(c[0])) continue;
    const d = { naam: c[0].slice(0, 60), doel: (c[0].match(/^\S+\s+(.+)$/) || [])[1] || null, hoofdsom: iH >= 0 ? euroUit(c[iH]) : null, start: iS >= 0 ? maandUit(c[iS]) : null,
      rente: tekst(c, iR), rente_bank: null, rentevast_tot: tekst(c, iV), einde: tekst(c, iE), restschulden: [] };
    for (const x of rest) { const w = euroOfNul(c[x.i]); if (w !== null) d.restschulden.push({ peildatum: x.peildatum, waarde: w, bron: x.bron }); }
    u.delen.push(d);
  }
  const kb = md.match(/^##\s+Bankstand (\d{1,2}-\d{1,2}-\d{4})/m);
  const tb = kb ? tabelOnder(md, /^Bankstand\b/) : null;
  if (tb && datumUit(kb[1])) {
    const iM = tb.koppen.findIndex((x) => /^deel model/.test(x)), iRb = tb.koppen.findIndex((x) => /^rente bank/.test(x)), iW = tb.koppen.findIndex((x) => /^restschuld bank/.test(x));
    for (const r of tb.rijen) {
      const c = r.map(kaal);
      if (iM < 0 || !c[iM] || /^totaal/i.test(c[0])) continue;
      const d = u.delen.find((x) => x.naam.split(/\s+/)[0] === c[iM]);
      if (!d) continue;
      const w = iW >= 0 ? euroOfNul(c[iW]) : null;
      if (w !== null) d.restschulden.push({ peildatum: datumUit(kb[1]), waarde: w, bron: 'bank' });
      if (iRb >= 0 && c[iRb]) d.rente_bank = c[iRb].slice(0, 20);
    }
  }
  return u;
}
// Reeksen voor één object uit zijn leningdelen: "lening" (opgenomen, opgeteld bij elke start) en "restschuld" (som per peildatum; een
// modelstand binnen 45 dagen van een bankstand valt weg, de bank gaat voor).
// Review MOET 2: dezelfde voorrangsregel voor de reeks én de stand per leningdeel — een modelstand binnen 45 dagen van een bankstand (van een
// leningdeel van hetzelfde object) telt niet.
const DAG_MS = 86400000;
function telBaar(delen) {
  const dag = (x) => new Date(x + 'T12:00:00Z').getTime();
  const bank = Array.from(new Set(delen.flatMap((d) => d.restschulden.filter((r) => r.bron === 'bank').map((r) => r.peildatum)))).map(dag);
  return (r) => r.bron !== 'model' || !bank.some((b) => Math.abs(b - dag(r.peildatum)) <= 45 * DAG_MS);
}
function laatsteStand(d, delen) {
  const ok = telBaar(delen);
  return d.restschulden.filter(ok).sort((a, b) => (a.peildatum < b.peildatum ? 1 : a.peildatum > b.peildatum ? -1 : a.bron === 'bank' ? -1 : 1))[0] || null;
}
function hypotheekReeksen(delen) {
  const uit = [];
  let som = 0;
  for (const d of delen.filter((x) => x.start && x.hoofdsom).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))) {
    som += d.hoofdsom;
    const vorig = uit[uit.length - 1];
    if (vorig && vorig.peildatum === d.start) { vorig.waarde = Math.round(som * 100) / 100; vorig.toelichting += ', ' + d.naam; continue; }
    uit.push({ reeks: 'lening', peildatum: d.start, waarde: Math.round(som * 100) / 100, eenheid: 'euro', toelichting: 'opgenomen in totaal, met ' + d.naam });
  }
  const pd = {};
  const ok = telBaar(delen);
  for (const d of delen) for (const r of d.restschulden.filter(ok)) { const k = r.peildatum + '|' + r.bron; (pd[k] = pd[k] || { peildatum: r.peildatum, bron: r.bron, som: 0, n: 0 }); pd[k].som += r.waarde; pd[k].n++; }
  for (const p of Object.values(pd).sort((a, b) => (a.peildatum < b.peildatum ? -1 : a.peildatum > b.peildatum ? 1 : 0))) {
    uit.push({ reeks: 'restschuld', peildatum: p.peildatum, waarde: Math.round(p.som * 100) / 100, eenheid: 'euro', toelichting: `restschuld volgens ${p.bron === 'bank' ? 'de bank' : 'het eigen model'} (${p.n} ${p.n === 1 ? 'leningdeel' : 'leningdelen'})` });
  }
  return uit;
}
// Verbouwkosten uit een verbouwpagina: alleen de vaste vorm "| **Totaal incl. btw** | **€ …** |" (offertetabellen) en "| Prijs | … € … incl. btw |".
// Losse bedragen in de lopende tekst tellen bewust niet mee (dubbeltellingen); het scherm zegt dat.
function leesKosten(md) {
  const uit = [];
  const titelP = titel(md) || '';
  const jaar = (titelP.match(/\b(19|20)\d{2}\b/) || [])[0];
  let kop = titelP;
  for (const l of md.split('\n')) {
    const h = l.match(/^#{2,3}\s+(.+)$/);
    if (h) { kop = kaal(h[1]); continue; }
    if (!/^\|/.test(l)) continue;
    const c = cellen(l).map(kaal);
    if (c.length < 2) continue;
    let w = null;
    if (/^totaal incl\.? btw$/i.test(c[0])) w = euroUit(c[c.length - 1]);
    else if (/^prijs$/i.test(c[0])) { const m = c[1].match(/(€\s*[\d.]+(?:,\d{1,2})?)\s*incl\.? btw/i); w = m ? euroUit(m[1]) : null; }
    if (!w) continue;
    const dag = datumUit(kop) || (jaar ? `${jaar}-01-01` : null);
    if (!dag) continue;
    uit.push({ peildatum: dag, waarde: w, kop: kop === titelP || /^kerngegevens$/i.test(kop) ? null : kop.slice(0, 100), offerte: /offerte/i.test(kop) });
  }
  return uit;
}
// Servicekosten (VvE) per box uit de privé-banktransacties (alleen lezen; bank-archief transacties.sqlite). Een box op naam van een BV staat niet
// in de privébank. Toewijzing: één privébox in die VvE = alles naar die box; meer privéboxen = alleen posten met "<huisnummer>-<toevoeging>" erin.
const VVE_RUIS = new Set(['vve', 'vereniging', 'van', 'eigenaars', 'eigenaren', 'aan', 'het', 'de', 'en']);
function vveKern(naam) { return kaal(naam).toLowerCase().split(/[^a-z0-9à-ÿ]+/).filter((w) => w.length > 2 && !VVE_RUIS.has(w) && !/^(i{1,3}|iv|vi{0,3}|\d+)$/.test(w)); }
function opBv(eigenaar) { return /\b(b\.?\s?v\.?|n\.?\s?v\.?|holding)(?=\W|$)/i.test(String(eigenaar || '')); }
// De tegenpartij moet de VvE zijn ("VvE"/"Vereniging van Eigenaars" + alle kernwoorden van de naam); de omschrijving telt alleen voor de toewijzing.
function vveUitBank(posten, boxen) {   // posten: [{ datum, bedrag, tegen, tekst }] (al gefilterd op privérekeningen); boxen: [{ sleutel, vve, eigenaar, zoek }]
  const uit = {};
  for (const b of boxen) uit[b.sleutel] = { stand: !b.vve ? 'geen-vve' : opBv(b.eigenaar) ? 'bv' : 'ok', jaren: {}, onverdeeld: 0 };
  const groepen = {};
  for (const b of boxen.filter((x) => x.vve && !opBv(x.eigenaar))) { const k = vveKern(b.vve).join(' '); if (k) (groepen[k] = groepen[k] || []).push(b); }
  for (const [k, lid] of Object.entries(groepen)) {
    const kern = k.split(' ');
    for (const p of posten) {
      const tp = String(p.tegen || '').toLowerCase(), t = tp + ' ' + String(p.tekst || '').toLowerCase();
      if (!/\bv\.?v\.?e\b|vereniging van eigenaars/.test(tp) || !kern.every((w) => tp.includes(w))) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.datum)) || !Number.isFinite(p.bedrag)) continue;
      let doel = lid.length === 1 ? lid[0] : lid.find((b) => b.zoek && new RegExp(`\\b${b.zoek.huisnummer}-${b.zoek.toevoeging}\\b`).test(t));
      if (!doel) { for (const b of lid) uit[b.sleutel].onverdeeld++; continue; }
      const j = p.datum.slice(0, 4), x = uit[doel.sleutel].jaren;
      x[j] = x[j] || { uit: 0, n: 0, eerste: p.datum, laatste: p.datum };
      x[j].uit = Math.round((x[j].uit - p.bedrag) * 100) / 100; x[j].n++;
      if (p.datum < x[j].eerste) x[j].eerste = p.datum;
      if (p.datum > x[j].laatste) x[j].laatste = p.datum;
    }
  }
  return uit;
}
// Stroom per maand uit Tibber (tibber.sqlite, tabel verbruik per uur; alleen lezen). Eén Tibber-woning = de woning; meer = niet te koppelen.
function stroomMaanden(rijen) {   // rijen: [{ home_id, maand, kwh, kosten, uren }]
  const homes = new Set(rijen.map((r) => r.home_id));
  if (homes.size !== 1) return { stand: homes.size ? 'meer-woningen' : 'leeg', maanden: [] };
  const maanden = rijen.filter((r) => /^\d{4}-\d{2}$/.test(r.maand)).map((r) => {
    const [j, m] = r.maand.split('-').map(Number);
    const verwacht = new Date(Date.UTC(j, m, 0)).getUTCDate() * 24;
    const kostenHeel = Number.isFinite(r.kosten) && (r.kosten_uren === undefined || r.kosten_uren >= r.uren);   // review ZOU 1: ontbrekende kosten = geen maandbedrag
    return { maand: r.maand, kwh: Math.round(r.kwh * 10) / 10, kosten: kostenHeel ? Math.round(r.kosten * 100) / 100 : null, volledig: r.uren >= verwacht - 1, uren: r.uren, verwacht };
  });
  return { stand: 'ok', maanden };
}
// WOZ-beschikking: jaar, waarde en waardepeildatum uit de tekst (pdftotext of OCR, door server.js). Alleen een voorstel: David bevestigt.
function wozUitTekst(t, nu) {
  const s = String(t || '').replace(/\s+/g, ' ').slice(0, 200000);
  const ditJaar = (nu || new Date()).getUTCFullYear();
  const jaarOk = (j) => j >= 2000 && j <= ditJaar + 1;
  let jaar = null, peildatum = null, waarde = null;
  let m = s.match(/(?:belastingjaar|aanslagjaar|beschikking(?: WOZ)?(?: voor)?(?: het jaar)?|WOZ-waarde voor|tijdvak|aanslagbiljet)\D{0,25}?(20\d{2})\b/i);
  if (m && jaarOk(Number(m[1]))) jaar = Number(m[1]);
  m = s.match(/waardepeildatum\D{0,20}?(\d{1,2}[- ](?:\d{1,2}|januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)[- ]\d{4})/i);
  if (m) peildatum = datumUit(m[1].replace(/ (\d{1,2}) (\d{4})$/, ' $1 $2')) || datumUit(m[1].replace(/ /g, '-'));
  if (!jaar && peildatum && jaarOk(Number(peildatum.slice(0, 4)) + 1)) jaar = Number(peildatum.slice(0, 4)) + 1;
  if (jaar && !peildatum) peildatum = `${jaar - 1}-01-01`;
  m = s.match(/(?:vastgestelde (?:WOZ-)?waarde|WOZ-waarde|waarde van (?:uw|de|het) (?:woning|object|onroerende zaak))[^€]{0,60}€\s*(\d{1,3}(?:\.\d{3})+)(?![\d,]\d)/i);
  if (m) { const n = Number(m[1].replace(/\./g, '')); if (n >= 1000 && n <= 100000000) waarde = n; }
  return { jaar, waarde, peildatum };
}

function soortStuk(naam) {
  const n = naam.toLowerCase();
  if (/palenplan|constructie|heipal/.test(n)) return 'constructie';
  if (/bodem|fundering|grondwater|sondering/.test(n)) return 'grond';
  if (/tekening|plattegrond|gevel|doorsnede|situatie|schetsplan|ontwerp|verbouwingsspecificatie|meetstaat|technische omschrijving|bouwplan/.test(n)) return 'tekening';
  if (/woz|bezwaar/.test(n)) return 'woz';
  if (/taxatie|calcasa/.test(n)) return 'taxatie';
  if (/vve|reglement|statuten|parkmanagement|\balv\b|huishoudelijk|splitsing/.test(n)) return 'vve';
  if (/akte|levering|eigendom|kadaster|koopsom|kennisgeving|inschrijving|volmacht|nota van afrekening|lasten en beperkingen|wwft/.test(n)) return 'akte';
  if (/koop|aanneming|woningborg|garantie|meerwerk|opties/.test(n)) return 'koop';
  if (/energielabel|zonnepaneel|zonnepanelen|warmte|wko|opstalrecht/.test(n)) return 'energie';
  if (/offerte|factuur|bestek|begroting|opdracht|keuken|orderbevestiging/.test(n)) return 'offerte';
  if (/bestemmingsplan|omgevingsvergunning|vergunning|kavelpaspoort|kavelkaart/.test(n)) return 'regels';
  return 'overig';
}
const STUK_SOORT = { tekening: 'Tekeningen en bouwplannen', constructie: 'Palenplan en constructie', grond: 'Bodem en fundering', woz: 'WOZ', taxatie: 'Taxaties',
  akte: 'Akten en kadaster', koop: 'Koop en garantie', vve: 'VvE en splitsing', energie: 'Energie', offerte: 'Offertes en facturen', regels: 'Regels en vergunningen', overig: 'Overig' };

// Het hele dossier lezen: { objecten: [...], verbouwingen: [...], stukken: [...] }. Geen schrijfactie, geen netwerk.
function leesDossierMap(vault) {
  const huis = path.join(vault, HUIS);
  let namen = [];
  try { namen = fs.readdirSync(huis).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort(); } catch (e) { throw new Fout(503, 'het huisdossier in de vault is niet te lezen'); }
  const lees = (n) => { try { return fs.readFileSync(path.join(huis, n), 'utf8'); } catch (e) { return ''; } };
  const objecten = [];
  for (const n of namen.filter((x) => /^Woning\b/.test(x))) objecten.push(Object.assign(leesWoning(lees(n)), { dossier: `${HUIS}/${n}`, sleutel: 'woning' }));
  const boxen = namen.filter((x) => /^Garagebox/i.test(x)).map((n) => Object.assign(leesBox(lees(n)), { dossier: `${HUIS}/${n}` }));
  boxen.sort((a, b) => Number((a.zoek || {}).toevoeging || 999) - Number((b.zoek || {}).toevoeging || 999));
  boxen.forEach((b, i) => { b.sleutel = 'box-' + (b.zoek ? b.zoek.toevoeging : String(i + 1)); });
  for (const b of boxen) {   // het grondperceel van het complex staat soms alleen op de pagina van de andere box
    if (!b.percelen.length && b.complex) {
      const ander = boxen.find((x) => x !== b && x.percelen.length && x.complex && x.complex.gemeente === b.complex.gemeente && x.complex.sectie === b.complex.sectie && x.complex.nummer === b.complex.nummer);
      if (ander) { b.percelen = ander.percelen.slice(); b.feiten.push({ rubriek: 'grond', veld: 'Grondperceel van het complex', waarde: ander.percelen.map((p) => `${p.gemeente} ${p.sectie} ${p.nummer}`).join(', ') + ' (van de pagina van de andere box)', peildatum: null }); }
    }
  }
  objecten.push(...boxen);
  const verbouwingen = [];
  for (const n of namen.filter((x) => !/^(Woning\b|Garagebox|Index\.md$|Eigen woning|NAS )/i.test(x))) {
    const t = titel(lees(n)) || n.replace(/\.md$/, '');
    const j = t.match(/\b(19|20)\d{2}\b/);
    verbouwingen.push({ titel: t, datum: j ? `${j[0]}-01-01` : null, soort: /plan\b|verbouwplan/i.test(t) ? 'plan' : 'verbouwing', pagina: `${HUIS}/${n}`, kosten: leesKosten(lees(n)) });
  }
  // fase 2: de hypotheekpagina in 20_Prive/Financien (alleen lezen)
  let hypotheek = null;
  try {
    const hn = fs.readdirSync(path.join(vault, FINANCIEN)).filter((n) => /^Hypotheek.*\.md$/i.test(n)).sort()[0];
    if (hn) hypotheek = Object.assign(leesHypotheek(fs.readFileSync(path.join(vault, FINANCIEN, hn), 'utf8')), { pagina: `${FINANCIEN}/${hn}` });
  } catch (e) { hypotheek = null; }
  const stukken = [];
  let bestanden = [];
  try { bestanden = fs.readdirSync(path.join(vault, BRONNEN), { withFileTypes: true }).filter((d) => d.isFile() && !d.name.startsWith('.')).map((d) => d.name).sort(); } catch (e) { bestanden = []; }
  for (const n of bestanden.slice(0, 2000)) {
    let grootte = null; try { grootte = fs.statSync(path.join(vault, BRONNEN, n)).size; } catch (e) { /* weg */ }
    const d = n.match(/^[^-]+ - (\d{4}(?:-\d{2}(?:-\d{2})?)?) - /);
    const doelBox = boxen.filter((b) => b.zoek && new RegExp(`(?:box|[- ])${b.zoek.toevoeging}\\b`, 'i').test(n) && /garage|box/i.test(n));
    const garage = /garage|\bbox\b|parkmanagement/i.test(n);
    const doel = doelBox.length ? doelBox.map((b) => b.sleutel) : garage ? boxen.map((b) => b.sleutel) : objecten.filter((o) => o.soort === 'woning').map((o) => o.sleutel);
    stukken.push({ pad: `${BRONNEN}/${n}`, naam: n.replace(/^[^-]+ - /, ''), soort: soortStuk(n), datum: d ? d[1] : null, objecten: doel, grootte });
  }
  return { objecten, verbouwingen, stukken, hypotheek };
}

// ---------------------------------------------------------------- dossierstand (0–100) en waarde-indicatie
function indexOp(index, dag) {
  if (!index || !dag) return null;
  const mnd = dag.slice(0, 7);
  if (index.maanden && index.maanden[mnd] !== undefined) return { waarde: index.maanden[mnd], periode: mnd };
  const j = dag.slice(0, 4);
  if (index.jaren && index.jaren[j] !== undefined) return { waarde: index.jaren[j], periode: j };
  return null;
}
function indicatie(reeksen, index) {
  // Review MOET 1: de basis is de laatste gewone marktwaarde. Een taxatie noemt soms ook een waarde "na verbouwing" (een voorwaardelijke waarde
  // voor een geplande verbouwing); die gaat nooit vanzelf als basis, maar staat apart als "als de verbouwing klaar is".
  const tax = reeksen.filter((r) => r.reeks === 'taxatie').sort((a, b) => (a.peildatum < b.peildatum ? -1 : a.peildatum > b.peildatum ? 1 : 0));
  const laatste = tax.length ? tax[tax.length - 1] : null;
  if (!laatste || !index || !index.laatste) return null;
  const toen = indexOp(index, laatste.peildatum);
  if (!toen || !(toen.waarde > 0)) return null;
  const factor = index.laatste[1] / toen.waarde;
  const na = reeksen.find((r) => r.reeks === 'taxatie-na' && r.peildatum === laatste.peildatum);
  return { waarde: Math.round(laatste.waarde * factor / 1000) * 1000, basis: laatste.waarde, basis_datum: laatste.peildatum, basis_soort: 'taxatie',
    na_verbouwing: na ? { waarde: Math.round(na.waarde * factor / 1000) * 1000, basis: na.waarde } : null,
    index_toen: toen, index_nu: { waarde: index.laatste[1], periode: index.laatste[0] }, factor: Math.round(factor * 1000) / 1000,
    uitleg: 'Indicatie: de marktwaarde uit de laatste taxatie, opgehoogd met de landelijke CBS-prijsindex voor bestaande koopwoningen. Geen taxatie en geen advies; buurt, staat en latere verbouwingen tellen niet mee.' };
}
function dossierstand(o, feiten, reeksen, stukken, nu) {
  const vandaag = (nu || new Date()).toISOString().slice(0, 10);
  const jaar = Number(vandaag.slice(0, 4));
  const heeft = (veld) => feiten.some((f) => f.veld === veld);
  const heeftRe = (re, herkomst) => feiten.some((f) => re.test(f.veld) && (!herkomst || f.herkomst === herkomst));
  const stuk = (s) => stukken.some((x) => x.soort === s);
  const r = (n) => reeksen.filter((x) => x.reeks === n).sort((a, b) => (a.peildatum < b.peildatum ? 1 : -1));
  const extern = o.extern_op ? new Date(o.extern_op).getTime() : 0;
  // Review MOET 3: bijgewerkt = elke geprobeerde bron lukte de laatste keer en is jonger dan 30 dagen (niet: één geslaagde aanroep)
  let bs = {}; try { bs = JSON.parse(o.bron_stand || '{}') || {}; } catch (e) { bs = {}; }
  const mislukt = Object.keys(bs).filter((g) => !bs[g].ok);
  const oud = Object.keys(bs).filter((g) => bs[g].ok && (!bs[g].op || Date.now() - new Date(bs[g].op).getTime() >= EXTERN_VERS_MS));
  const externVers = extern && Object.keys(bs).length && !mislukt.length && !oud.length;
  const externDeels = !extern ? 'nog niet opgehaald' : mislukt.length ? 'mislukt bij de laatste poging: ' + mislukt.map((g) => GROEP_NAAM[g] || g).join(', ') : oud.length ? 'ouder dan 30 dagen: ' + oud.map((g) => GROEP_NAAM[g] || g).join(', ') : 'nog niet opgehaald';
  const punten = [];
  const p = (gewicht, ok, tekst, deels) => punten.push({ gewicht, ok: !!ok, deels: ok ? null : deels || null, tekst });
  const wozJaar = (x) => Number(String(x.toelichting || '').match(/WOZ (\d{4})/)?.[1] || Number(x.peildatum.slice(0, 4)) + 1);
  const woz = r('woz');
  const wozLaatste = woz.length ? Math.max(...woz.map(wozJaar)) : null;
  if (o.soort === 'woning') {
    p(5, JSON.parse(o.vbo || '[]').length, 'BAG-nummer van de woning');
    p(5, JSON.parse(o.percelen || '[]').length, 'Kadastrale percelen');
    p(5, heeft('Bouwjaar'), 'Bouwjaar');
    p(5, heeftRe(/^Gebruiksoppervlakte/), 'Gebruiksoppervlakte');
    p(5, heeftRe(/^Inhoud/), 'Inhoud');
    p(10, r('aankoop').length, 'Aankoopprijs');
    const tax = r('taxatie')[0];
    p(10, tax && Number(tax.peildatum.slice(0, 4)) >= jaar - 3, 'Taxatie van de laatste drie jaar', tax ? `laatste taxatie is van ${tax.peildatum.slice(0, 4)}` : 'geen taxatie gevonden');
    p(10, wozLaatste && wozLaatste >= jaar - 1, `WOZ-beschikking ${jaar} (of ${jaar - 1})`, wozLaatste ? `laatste WOZ in het dossier: ${wozLaatste}` : 'geen WOZ gevonden');
    const gt = (feiten.find((f) => f.veld === 'Energielabel geldig tot') || {}).waarde;
    p(10, gt && gt > vandaag && gt.slice(0, 4) > String(jaar + 1), 'Geldig energielabel', gt ? (gt <= vandaag ? `verlopen op ${nlDag(gt)}` : `verloopt op ${nlDag(gt)}`) : 'geen energielabel gevonden');
    p(5, stuk('tekening'), 'Bouwtekeningen');
    p(5, stuk('constructie'), 'Palenplan en constructie');
    p(5, stuk('akte'), 'Akte van levering en kadasterstukken');
    p(5, stuk('grond') || heeft('Funderingskaart'), 'Bodem- en funderingsinformatie');
    p(5, heeftRe(/^Bestemmingsplan/) || feiten.some((f) => f.soort === 'plan'), 'Bestemmingsplan');
    p(10, externVers, 'Openbare gegevens bijgewerkt (laatste 30 dagen)', externDeels);
  } else {
    const bag = o.bag_gemeten ? JSON.parse(o.bag_gemeten) : null;
    p(10, JSON.parse(o.vbo || '[]').length || (bag && bag.raak === 0 && bag.in_vak > 0), 'BAG-nummer (of gemeten dat de box er geen heeft)', bag ? `niet eenduidig: ${bag.raak} treffers` : 'nog niet gemeten');
    p(15, heeftRe(/^Kadastrale aanduiding/), 'Kadastrale aanduiding');
    p(15, r('aankoop').length, 'Aankoopprijs');
    p(15, stuk('akte'), 'Akte van levering of kennisgeving van het Kadaster');
    p(15, stuk('vve'), 'Splitsingsakte, reglement of VvE-stukken');
    p(15, wozLaatste && wozLaatste >= jaar - 1, `WOZ-beschikking ${jaar} (of ${jaar - 1})`, wozLaatste ? `laatste WOZ: ${wozLaatste}` : 'geen WOZ gevonden');
    p(15, externVers, 'Openbare gegevens bijgewerkt (laatste 30 dagen)', externDeels);
  }
  const score = punten.reduce((s, x) => s + (x.ok ? x.gewicht : 0), 0);
  return { score, punten, ontbreekt: punten.filter((x) => !x.ok).map((x) => x.tekst + (x.deels ? ` (${x.deels})` : '')) };
}

// ---------------------------------------------------------------- module
function maak(o) {
  const map = o.map, vault = o.vault;
  const dbPad = path.join(map, 'vastgoed.sqlite');
  const bronnen = typeof o.bronnen === 'function' ? o.bronnen : null;
  const nu = typeof o.nu === 'function' ? o.nu : () => new Date();
  const bankPad = o.bank || null, tibberPad = o.tibber || null;   // fase 2: alleen lezen (bank-archief transacties.sqlite, tibber.sqlite)
  function mappen() { if (!fs.existsSync(map)) fs.mkdirSync(map, { recursive: true, mode: 0o700 }); try { fs.chmodSync(map, 0o700); } catch (e) { /* niet van ons */ } }
  function open(alleenLezen) {
    const { DatabaseSync } = require('node:sqlite');
    mappen();
    const nieuw = !fs.existsSync(dbPad);
    if (alleenLezen && nieuw) return null;
    const db = new DatabaseSync(dbPad, alleenLezen ? { readOnly: true } : {});
    if (!alleenLezen) {
      if (nieuw) { try { fs.chmodSync(dbPad, 0o600); } catch (e) { /* al gezet */ } }
      db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE;');
      db.exec(SCHEMA);
      db.prepare("INSERT INTO meta (sleutel, waarde) VALUES ('schema', ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde").run(String(SCHEMA_VERSIE));
    }
    return db;
  }
  function metDb(f, schrijf) {
    const db = open(!schrijf);
    if (!db) return f(null);
    try {
      if (!schrijf) return f(db);
      db.exec('BEGIN IMMEDIATE');
      try { const u = f(db); db.exec('COMMIT'); return u; } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { /* al weg */ } throw e; }
    } finally { db.close(); }
  }

  // Het dossier (opnieuw) inlezen: objecten bijwerken op sleutel, dossierfeiten/-reeksen/-gebeurtenissen/stukken vervangen. Externe feiten blijven.
  // fase 2: andere databanken alleen lezen (readOnly); een fout = { ok: false } en de vorige cijfers blijven staan
  function leesAnder(pad, f) {
    if (!pad) return { ok: false, reden: 'niet gekoppeld op deze pod' };
    if (!fs.existsSync(pad)) return { ok: false, reden: 'databank niet gevonden' };
    let db = null;
    try { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(pad, { readOnly: true }); return Object.assign({ ok: true }, f(db)); }
    catch (e) { return { ok: false, reden: 'niet te lezen' }; }
    finally { if (db) { try { db.close(); } catch (e) { /* dicht */ } } }
  }
  function leesBank(boxen) {
    const kernen = Array.from(new Set(boxen.filter((b) => b.vve && !opBv(b.eigenaar)).map((b) => vveKern(b.vve)[0]).filter(Boolean)));
    if (!kernen.length) return { ok: true, posten: [] };
    return leesAnder(bankPad, (db) => {
      const q = db.prepare(`SELECT t.nr AS nr, t.datum AS datum, t.bedrag AS bedrag, coalesce(t.tegenpartij, '') AS tegen, coalesce(t.omschrijving, '') AS tekst
        FROM transacties t JOIN rekeningen r ON r.rek = t.rek WHERE t.status = 'booked' AND t.vervangen_door IS NULL AND coalesce(r.eigenaar, '') NOT IN ('POT', 'extern')
        AND coalesce(t.valuta, 'EUR') = 'EUR' AND lower(coalesce(t.tegenpartij, '')) LIKE ? LIMIT 5000`);
      const gezien = new Set(), posten = [];
      for (const k of kernen) for (const r of q.all('%' + k + '%')) if (!gezien.has(r.nr)) { gezien.add(r.nr); posten.push({ datum: r.datum, bedrag: Number(r.bedrag), tegen: r.tegen, tekst: r.tekst }); }
      return { posten };
    });
  }
  function leesTibber() {
    return leesAnder(tibberPad, (db) => stroomMaanden(db.prepare(`SELECT home_id, substr(van, 1, 7) AS maand, SUM(kwh) AS kwh, SUM(kosten) AS kosten, COUNT(kwh) AS uren, COUNT(kosten) AS kosten_uren
      FROM verbruik WHERE kwh IS NOT NULL GROUP BY home_id, maand ORDER BY maand`).all()));
  }

  function leesDossier() {
    const d = leesDossierMap(vault);
    if (!d.objecten.length) throw new Fout(422, 'geen woning- of garageboxpagina gevonden in het huisdossier');
    const op = nu().toISOString();   // review ZOU 3: dezelfde klok als de dag-grens bij openen
    const boxen = d.objecten.filter((x) => x.soort === 'garagebox').map((x) => ({ sleutel: x.sleutel, vve: x.vve, zoek: x.zoek, eigenaar: (x.feiten.find((f) => f.veld === 'Eigenaar') || {}).waarde }));
    const bank = leesBank(boxen);
    const stroom = leesTibber();
    return metDb((db) => {
      const ids = {};
      d.objecten.forEach((x, i) => {
        db.prepare(`INSERT INTO object (sleutel, soort, naam, adres, dossier, vbo, pand, percelen, woz_nr, zoek, volgorde, dossier_op) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(sleutel) DO UPDATE SET soort = excluded.soort, naam = excluded.naam, adres = excluded.adres, dossier = excluded.dossier,
          vbo = CASE WHEN excluded.vbo = '[]' AND object.soort = 'garagebox' THEN object.vbo ELSE excluded.vbo END, pand = excluded.pand, percelen = excluded.percelen,
          woz_nr = excluded.woz_nr, zoek = excluded.zoek, volgorde = excluded.volgorde, dossier_op = excluded.dossier_op`)
          .run(x.sleutel, x.soort, x.naam, x.adres, x.dossier, JSON.stringify(x.vbo), JSON.stringify(x.pand), JSON.stringify(x.percelen), x.woz_nr, x.zoek ? JSON.stringify(x.zoek) : null, i, op);
        ids[x.sleutel] = db.prepare('SELECT id FROM object WHERE sleutel = ?').get(x.sleutel).id;
      });
      db.prepare(`DELETE FROM feit WHERE herkomst = 'dossier'`).run();
      db.prepare(`DELETE FROM reeks WHERE herkomst = 'dossier'`).run();
      db.prepare('DELETE FROM gebeurtenis').run();
      db.prepare('DELETE FROM stuk').run();
      const fi = db.prepare(`INSERT INTO feit (object, herkomst, rubriek, veld, waarde, peildatum, bron, opgehaald, volgorde) VALUES (?, 'dossier', ?, ?, ?, ?, ?, ?, ?)`);
      const ri = db.prepare(`INSERT INTO reeks (object, reeks, peildatum, waarde, eenheid, toelichting, bron, herkomst, opgehaald) VALUES (?,?,?,?,?,?,?, 'dossier', ?)`);
      const gi = db.prepare('INSERT INTO gebeurtenis (object, datum, titel, soort, pagina, bron) VALUES (?,?,?,?,?,?)');
      let nf = 0, nr = 0, ng = 0;
      for (const x of d.objecten) {
        const id = ids[x.sleutel];
        x.feiten.forEach((f, i) => { fi.run(id, f.rubriek, f.veld, f.waarde, f.peildatum, 'dossier: ' + x.dossier, op, i); nf++; });
        for (const r of x.reeks) { ri.run(id, r.reeks, r.peildatum, r.waarde, r.eenheid, r.toelichting || null, 'dossier: ' + x.dossier, op); nr++; }
        for (const g of x.gebeurtenissen) { gi.run(id, g.datum, g.titel, g.soort, x.dossier, 'dossier'); ng++; }
      }
      const woning = d.objecten.find((x) => x.soort === 'woning');
      if (woning) for (const v of d.verbouwingen) { gi.run(ids[woning.sleutel], v.datum || '', v.titel, v.soort, v.pagina, 'dossier'); ng++; }   // een plan zonder jaar = '' (lopend)
      const si = db.prepare('INSERT INTO stuk (pad, naam, soort, datum, objecten, grootte, gezien) VALUES (?,?,?,?,?,?,?)');
      for (const s of d.stukken) si.run(s.pad, s.naam, s.soort, s.datum, ',' + s.objecten.map((k) => ids[k]).filter(Boolean).join(',') + ',', s.grootte, op);
      // ── fase 2 (wv3102): verbouwkosten, hypotheek, servicekosten en stroom; alleen hier en op het scherm
      const geld = {};
      const rg = db.prepare(`INSERT INTO reeks (object, reeks, peildatum, waarde, eenheid, toelichting, bron, herkomst, opgehaald) VALUES (?,?,?,?,?,?,?,?,?)`);
      let nk = 0;
      if (woning) for (const v of d.verbouwingen) for (const k of v.kosten || []) {
        rg.run(ids[woning.sleutel], 'verbouwing', k.peildatum, k.waarde, 'euro', `${v.titel}${k.kop ? ' · ' + k.kop : ''} (${k.offerte ? 'offerte' : 'prijs'}, incl. btw)`, 'dossier: ' + v.pagina, 'dossier', op); nk++;
      }
      geld.verbouwing = { ok: true, op, posten: nk };
      if (d.hypotheek && d.hypotheek.delen.length && woning) {
        db.prepare('DELETE FROM leningdeel').run();
        db.prepare(`DELETE FROM reeks WHERE herkomst = 'hypotheek'`).run();
        const boxHyp = d.objecten.filter((x) => x.soort === 'garagebox' && x.feiten.some((f) => f.veld === 'Financiering' && /leningdeel/i.test(f.waarde)));
        const per = {};
        d.hypotheek.delen.forEach((x, i) => { const doel = /garage/i.test(x.doel || '') && boxHyp.length === 1 ? boxHyp[0] : woning; (per[doel.sleutel] = per[doel.sleutel] || []).push(Object.assign({ volgorde: i }, x)); });
        const li = db.prepare(`INSERT INTO leningdeel (object, naam, doel, hoofdsom, start, rente, rente_bank, rentevast_tot, einde, restschuld, restschuld_op, restschuld_bron, bron, opgehaald, volgorde)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        for (const [sl, delen] of Object.entries(per)) {
          for (const x of delen) {
            const r = laatsteStand(x, delen);
            li.run(ids[sl], x.naam, x.doel, x.hoofdsom, x.start, x.rente, x.rente_bank, x.rentevast_tot, x.einde, r ? r.waarde : null, r ? r.peildatum : null, r ? r.bron : null, 'dossier: ' + d.hypotheek.pagina, op, x.volgorde);
          }
          for (const r of hypotheekReeksen(delen)) rg.run(ids[sl], r.reeks, r.peildatum, r.waarde, r.eenheid, r.toelichting, 'dossier: ' + d.hypotheek.pagina, 'hypotheek', op);
        }
        geld.hypotheek = { ok: true, op, delen: d.hypotheek.delen.length };
      } else geld.hypotheek = { ok: false, op, reden: d.hypotheek ? 'geen tabel Leningdelen op de hypotheekpagina' : 'geen hypotheekpagina gevonden' };
      const oudGeld = (() => { try { return JSON.parse((db.prepare(`SELECT waarde FROM meta WHERE sleutel = 'geld'`).get() || {}).waarde || '{}') || {}; } catch (e) { return {}; } })();
      if (bank.ok) {
        db.prepare(`DELETE FROM reeks WHERE herkomst = 'bank'`).run();
        const vve = vveUitBank(bank.posten, boxen);
        const dit = Number(op.slice(0, 4));
        for (const b of boxen) for (const [j, x] of Object.entries(vve[b.sleutel].jaren)) {
          rg.run(ids[b.sleutel], 'servicekosten', `${j}-12-31`, x.uit, 'euro', `${x.n} ${x.n === 1 ? 'afschrijving' : 'afschrijvingen'}` + (Number(j) === dit ? `, lopend jaar t/m ${nlDag(x.laatste)}` : ''), 'privébank (alleen lezen)', 'bank', op);
        }
        geld.bank = { ok: true, op, boxen: Object.fromEntries(boxen.map((b) => [b.sleutel, { stand: vve[b.sleutel].stand, jaren: Object.keys(vve[b.sleutel].jaren).length, onverdeeld: vve[b.sleutel].onverdeeld }])) };
      } else geld.bank = Object.assign({}, oudGeld.bank || {}, { ok: false, mislukt_op: op, reden: bank.reden });
      if (stroom.ok && stroom.stand === 'ok' && woning) {
        db.prepare(`DELETE FROM reeks WHERE herkomst = 'tibber'`).run();
        for (const m of stroom.maanden) {
          const t = m.volledig ? 'hele maand' : `deels: ${m.uren} van ${m.verwacht} uur`;
          rg.run(ids[woning.sleutel], 'stroom', `${m.maand}-01`, m.kwh, 'kWh', t, 'Tibber (uurverbruik)', 'tibber', op);
          if (m.kosten !== null) rg.run(ids[woning.sleutel], 'stroomkosten', `${m.maand}-01`, m.kosten, 'euro', t, 'Tibber (uurverbruik)', 'tibber', op);
        }
        geld.tibber = { ok: true, op, maanden: stroom.maanden.length };
      } else geld.tibber = Object.assign({}, oudGeld.tibber || {}, { ok: false, mislukt_op: op, reden: stroom.ok ? (stroom.stand === 'leeg' ? 'nog geen verbruik' : 'meer dan één Tibber-woning') : stroom.reden });
      db.prepare("INSERT INTO meta (sleutel, waarde) VALUES ('geld', ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde").run(JSON.stringify(geld));
      // objecten die niet meer in het dossier staan: weg, met al hun gegevens
      const nog = Object.values(ids);
      for (const r of db.prepare('SELECT id FROM object').all()) if (!nog.includes(r.id)) {
        for (const t of ['feit', 'reeks', 'gebeurtenis', 'beeld', 'leningdeel', 'woz_eigen']) db.prepare(`DELETE FROM ${t} WHERE object = ?`).run(r.id);
        db.prepare('UPDATE aanroep SET object = NULL WHERE object = ?').run(r.id);
        db.prepare('DELETE FROM object WHERE id = ?').run(r.id);
      }
      return { objecten: d.objecten.length, feiten: nf, reeksen: nr, gebeurtenissen: ng, stukken: d.stukken.length, verbouwkosten: nk,
        hypotheek: !!geld.hypotheek.ok, bank: !!geld.bank.ok, tibber: !!geld.tibber.ok };
    }, true);
  }

  // Openbare gegevens voor één object ophalen (alleen nummers en een kaartvak naar buiten) en bewaren.
  const bezig = new Set();   // review ZOU 1: één verversing per object tegelijk (twee vensters), vóór de eerste await gereserveerd
  async function ververs(id) {
    if (!bronnen) throw new Fout(503, 'de openbare bronnen zijn op deze pod niet beschikbaar');
    if (bezig.has(id)) throw new Fout(429, 'wordt al bijgewerkt');
    const obj = metDb((db) => db && db.prepare('SELECT * FROM object WHERE id = ?').get(id), false);
    if (!obj) throw new Fout(404, 'onbekend object');
    if (obj.extern_op && Date.now() - new Date(obj.extern_op).getTime() < VERVERS_MIN_MS) throw new Fout(429, 'zojuist bijgewerkt; probeer het over tien minuten opnieuw');
    bezig.add(id);
    try { return await verversNu(obj); } finally { bezig.delete(id); }
  }
  async function verversNu(obj) {
    const vbo = JSON.parse(obj.vbo || '[]'), percelen = JSON.parse(obj.percelen || '[]');
    const invoer = { id: obj.id, vbo, pand: JSON.parse(obj.pand || '[]'), percelen };
    if (obj.soort === 'garagebox' && !vbo.length && obj.zoek) invoer.zoek = JSON.parse(obj.zoek);
    const r = await bronnen({ objecten: [invoer], beelden: true, index: true });
    if (!r || r.ok !== true || !Array.isArray(r.objecten)) throw new Fout(502, 'de openbare bronnen gaven geen antwoord');
    const u = r.objecten.find((x) => x && x.id === obj.id) || {};
    const op = nuIso();
    return metDb((db) => {
      const ai = db.prepare('INSERT INTO aanroep (tijd, object, bron, host, naar_buiten, status, ms) VALUES (?,?,?,?,?,?,?)');
      for (const a of (r.aanroepen || []).slice(0, 500)) ai.run(op, obj.id, String(a.bron || '').slice(0, 120), String(a.host || '').slice(0, 120), String(a.naar_buiten || '').slice(0, 200), String(a.status || '').slice(0, 20), Number(a.ms) || 0);
      db.prepare('DELETE FROM aanroep WHERE tijd < ?').run(new Date(Date.now() - AANROEP_DAGEN * 86400000).toISOString());
      // Review MOET 3: alleen de feiten van een gelukte bron (groep) vervangen; een mislukte bron laat zijn vorige feiten staan
      const groepen = u.groepen && typeof u.groepen === 'object' ? u.groepen : {};
      const gelukt = GROEPEN.filter((g) => groepen[g] === true);
      const geslaagd = gelukt.length > 0;
      const feiten = Array.isArray(u.feiten) ? u.feiten.filter((f) => f && RUBRIEKEN.includes(f.rubriek) && f.veld && f.waarde !== undefined && gelukt.includes(f.groep)) : [];
      const del = db.prepare(`DELETE FROM feit WHERE object = ? AND herkomst = 'extern' AND (groep = ? OR groep IS NULL)`);
      for (const g of gelukt) del.run(obj.id, g);
      const fi = db.prepare(`INSERT INTO feit (object, herkomst, rubriek, veld, waarde, peildatum, bron, licentie, url, soort, opgehaald, volgorde, groep) VALUES (?, 'extern', ?,?,?,?,?,?,?,?,?,?,?)`);
      feiten.slice(0, 400).forEach((f, i) => fi.run(obj.id, f.rubriek, String(f.veld).slice(0, 120), String(f.waarde).slice(0, 400), f.peildatum || null, String(f.bron || '').slice(0, 120),
        f.licentie || null, typeof f.url === 'string' && /^https:\/\/[\w.-]+(\/\S*)?$/.test(f.url) ? f.url : null, f.soort || null, op, i, f.groep));
      let bs = {}; try { bs = JSON.parse(obj.bron_stand || '{}') || {}; } catch (e) { bs = {}; }
      for (const g of GROEPEN) if (groepen[g] === true || groepen[g] === false) bs[g] = groepen[g] ? { ok: true, op } : { ok: false, op: (bs[g] || {}).op || null, mislukt_op: op };
      const beelden = Array.isArray(u.beelden) ? u.beelden.filter((b) => b && typeof b.src === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(b.src) && b.src.length < 2_000_000) : [];
      if (beelden.length) {
        db.prepare('DELETE FROM beeld WHERE object = ?').run(obj.id);
        const bi = db.prepare('INSERT INTO beeld (object, volgorde, soort, titel, jaar, src, over, bron, opgehaald) VALUES (?,?,?,?,?,?,?,?,?)');
        beelden.slice(0, 16).forEach((b, i) => bi.run(obj.id, i, String(b.soort || 'kaart').slice(0, 20), String(b.titel || '').slice(0, 120), b.jaar ? String(b.jaar).slice(0, 4) : null, b.src,
          JSON.stringify((Array.isArray(b.over) ? b.over : []).filter((z) => typeof z === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(z) && z.length < 2_000_000).slice(0, 3)), String(b.bron || '').slice(0, 300), op));
      }
      if (r.prijsindex && r.prijsindex.jaren) {
        db.prepare(`DELETE FROM reeks WHERE reeks = 'prijsindex'`).run();
        const ri = db.prepare(`INSERT INTO reeks (object, reeks, peildatum, waarde, eenheid, toelichting, bron, herkomst, opgehaald) VALUES (NULL, 'prijsindex', ?, ?, 'index', ?, ?, 'extern', ?)`);
        for (const [j, w] of Object.entries(r.prijsindex.jaren)) if (/^\d{4}$/.test(j) && Number.isFinite(w)) ri.run(`${j}-07-01`, w, 'jaar', 'CBS 85773NED (2020=100), ' + (r.licentie_index || 'CC BY 4.0'), op);
        for (const [mnd, w] of Object.entries(r.prijsindex.maanden || {})) if (/^\d{4}-\d{2}$/.test(mnd) && Number.isFinite(w)) ri.run(`${mnd}-15`, w, 'maand', 'CBS 85773NED (2020=100), ' + (r.licentie_index || 'CC BY 4.0'), op);
      }
      const gev = u.gevonden && typeof u.gevonden === 'object' ? u.gevonden : {};
      const sets = ['extern_op = ?', 'bron_stand = ?']; const arg = [geslaagd ? op : obj.extern_op, JSON.stringify(bs)];
      if (u.punt && Array.isArray(u.punt.rd)) { sets.push('punt = ?'); arg.push(JSON.stringify(u.punt)); }
      if (obj.soort === 'garagebox' && invoer.zoek && Number.isInteger(gev.in_vak) && !gev.fout) {   // review MOET 2: een mislukte zoektocht meet niets
        sets.push('bag_gemeten = ?'); arg.push(JSON.stringify({ in_vak: gev.in_vak, raak: gev.raak, op }));
        if (gev.vbo && /^\d{16}$/.test(gev.vbo)) { sets.push('vbo = ?'); arg.push(JSON.stringify([gev.vbo])); }
      }
      db.prepare(`UPDATE object SET ${sets.join(', ')} WHERE id = ?`).run(...arg, obj.id);
      return { id: obj.id, feiten: feiten.length, beelden: beelden.length, aanroepen: (r.aanroepen || []).length, geslaagd, mislukt: GROEPEN.filter((g) => groepen[g] === false).length };
    }, true);
  }

  function prijsindex(db) {
    const jaren = {}, maanden = {};
    for (const r of db.prepare(`SELECT peildatum, waarde, toelichting FROM reeks WHERE reeks = 'prijsindex'`).all()) {
      if (r.toelichting === 'jaar') jaren[r.peildatum.slice(0, 4)] = r.waarde; else if (r.toelichting === 'maand') maanden[r.peildatum.slice(0, 7)] = r.waarde;
    }
    const ms = Object.keys(maanden).sort();
    return Object.keys(jaren).length ? { jaren, maanden, laatste: ms.length ? [ms[ms.length - 1], maanden[ms[ms.length - 1]]] : null } : null;
  }

  function overzicht() {
    return metDb((db) => {
      if (!db) return { ok: true, objecten: [], leeg: true };
      const index = prijsindex(db);
      let geld = {}; try { geld = JSON.parse((db.prepare(`SELECT waarde FROM meta WHERE sleutel = 'geld'`).get() || {}).waarde || '{}') || {}; } catch (e) { geld = {}; }
      const objecten = db.prepare('SELECT * FROM object ORDER BY volgorde, id').all().map((obj) => {
        const feiten = db.prepare('SELECT herkomst, rubriek, veld, waarde, peildatum, bron, licentie, url, soort, opgehaald FROM feit WHERE object = ? ORDER BY herkomst, volgorde, id').all(obj.id);
        const reeksen = db.prepare('SELECT reeks, peildatum, waarde, eenheid, toelichting, bron, herkomst FROM reeks WHERE object = ? ORDER BY peildatum').all(obj.id);
        // fase 2: een WOZ-beschikking die David toevoegde en bevestigde (gaat voor een WOZ van hetzelfde jaar uit het dossier)
        for (const w of db.prepare('SELECT jaar, peildatum, waarde, pad FROM woz_eigen WHERE object = ? ORDER BY jaar').all(obj.id)) {
          for (let i = reeksen.length - 1; i >= 0; i--) if (reeksen[i].reeks === 'woz' && reeksen[i].peildatum === w.peildatum) reeksen.splice(i, 1);
          reeksen.push({ reeks: 'woz', peildatum: w.peildatum, waarde: w.waarde, eenheid: 'euro', toelichting: `WOZ ${w.jaar} (beschikking, door jou bevestigd)`, bron: w.pad ? 'stuk: ' + w.pad : 'David', herkomst: 'david' });
        }
        reeksen.sort((a, b) => (a.peildatum < b.peildatum ? -1 : a.peildatum > b.peildatum ? 1 : 0));
        const leningdelen = db.prepare('SELECT naam, doel, hoofdsom, start, rente, rente_bank, rentevast_tot, einde, restschuld, restschuld_op, restschuld_bron, bron FROM leningdeel WHERE object = ? ORDER BY volgorde, id').all(obj.id);
        const stukken = db.prepare("SELECT id, pad, naam, soort, datum, grootte FROM stuk WHERE objecten LIKE ? ORDER BY datum DESC, naam").all('%,' + obj.id + ',%');
        const gebeurtenissen = db.prepare("SELECT datum, titel, soort, pagina FROM gebeurtenis WHERE object = ? ORDER BY datum = '', datum").all(obj.id);
        const beelden = db.prepare('SELECT volgorde, soort, titel, jaar, bron, opgehaald FROM beeld WHERE object = ? ORDER BY volgorde').all(obj.id);
        const stand = dossierstand(obj, feiten, reeksen, stukken, nu());
        return { id: obj.id, sleutel: obj.sleutel, soort: obj.soort, naam: obj.naam, adres: obj.adres, dossier: obj.dossier, vbo: JSON.parse(obj.vbo || '[]'),
          percelen: JSON.parse(obj.percelen || '[]'), punt: obj.punt ? JSON.parse(obj.punt) : null, bag_gemeten: obj.bag_gemeten ? JSON.parse(obj.bag_gemeten) : null,
          dossier_op: obj.dossier_op, extern_op: obj.extern_op, bron_stand: (() => { try { return JSON.parse(obj.bron_stand || '{}'); } catch (e) { return {}; } })(), feiten, reeksen, stukken, gebeurtenissen, beelden, stand,
          indicatie: obj.soort === 'woning' ? indicatie(reeksen, index) : null, leningdelen,
          vve: obj.soort === 'garagebox' ? ((geld.bank || {}).boxen || {})[obj.sleutel] || null : null };
      });
      const aanroepen = db.prepare('SELECT COUNT(*) AS n, MAX(tijd) AS laatst FROM aanroep').get();
      const kaal2 = (x) => (x ? { ok: !!x.ok, op: x.op || null, mislukt_op: x.mislukt_op || null, reden: x.reden || null } : null);
      return { ok: true, objecten, prijsindex: index ? { laatste: index.laatste, jaren: index.jaren } : null, aanroepen: { n: aanroepen.n, laatst: aanroepen.laatst },
        rubrieken: RUBRIEKEN, stuk_soorten: STUK_SOORT, geld: { hypotheek: kaal2(geld.hypotheek), verbouwing: kaal2(geld.verbouwing), bank: kaal2(geld.bank), tibber: kaal2(geld.tibber) } };
    }, false);
  }
  function beelden(id) {
    return metDb((db) => {
      if (!db) return { ok: true, beelden: [] };
      if (!db.prepare('SELECT 1 FROM object WHERE id = ?').get(id)) throw new Fout(404, 'onbekend object');
      return { ok: true, beelden: db.prepare('SELECT volgorde, soort, titel, jaar, src, over, bron, opgehaald FROM beeld WHERE object = ? ORDER BY volgorde').all(id).map((b) => Object.assign(b, { over: JSON.parse(b.over || '[]') })) };
    }, false);
  }
  function aanroepLijst() {
    return metDb((db) => ({ ok: true, aanroepen: db ? db.prepare('SELECT tijd, object, bron, host, naar_buiten, status, ms FROM aanroep ORDER BY id DESC LIMIT 200').all() : [] }), false);
  }

  // ── fase 2: WOZ-beschikking toevoegen. server.js leest de tekst (pdftotext/OCR), schrijft het stuk via vault-veilig en roept dit aan;
  // de module bewaart alleen wat David bevestigde (jaar, waarde, waardepeildatum) en leest daarna het dossier opnieuw.
  function wozHerken(tekst) { return wozUitTekst(tekst, nu()); }
  function wozControle(body) {
    const b = body && typeof body === 'object' ? body : {};
    const id = Number(b.id), jaar = Number(b.jaar), waarde = Number(b.waarde);
    if (!Number.isInteger(id) || id < 1) throw new Fout(400, 'id ontbreekt');
    const dit = nu().getUTCFullYear();
    if (!Number.isInteger(jaar) || jaar < 2000 || jaar > dit + 1) throw new Fout(400, 'het jaar van de beschikking klopt niet');
    if (!Number.isInteger(waarde) || waarde < 1000 || waarde > 100000000) throw new Fout(400, 'de WOZ-waarde klopt niet (hele euro’s)');
    const peildatum = b.peildatum ? String(b.peildatum) : `${jaar - 1}-01-01`;
    if (!isoGoed(peildatum) || Number(peildatum.slice(0, 4)) > jaar || Number(peildatum.slice(0, 4)) < jaar - 2) throw new Fout(400, 'de waardepeildatum klopt niet');
    const obj = metDb((db) => db && db.prepare('SELECT id, naam, soort FROM object WHERE id = ?').get(id), false);
    if (!obj) throw new Fout(404, 'onbekend object');
    return { id, naam: obj.naam, soort: obj.soort, jaar, waarde, peildatum, stam: `WOZ-beschikking ${jaar} ${obj.naam}` };
  }
  function wozVastleggen(c, stuk) {
    const x = wozControle(c);
    const pad = stuk && typeof stuk.pad === 'string' && stuk.pad.startsWith(BRONNEN + '/') && !stuk.pad.includes('..') ? stuk.pad : null;
    const sha = stuk && /^[a-f0-9]{64}$/.test(String(stuk.sha || '')) ? stuk.sha : null;
    metDb((db) => {
      db.prepare(`INSERT INTO woz_eigen (object, jaar, peildatum, waarde, pad, sha, bevestigd) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(object, jaar) DO UPDATE SET peildatum = excluded.peildatum, waarde = excluded.waarde, pad = excluded.pad, sha = excluded.sha, bevestigd = excluded.bevestigd`)
        .run(x.id, x.jaar, x.peildatum, x.waarde, pad, sha, nuIso());
    }, true);
    leesDossier();
    return { id: x.id, jaar: x.jaar };
  }

  async function app(v) {
    const pad = String(v.pad || ''), post = v.methode === 'POST', body = v.body && typeof v.body === 'object' ? v.body : {};
    const idUit = () => { const id = Number(body.id); if (!Number.isInteger(id) || id < 1) throw new Fout(400, 'id ontbreekt'); return id; };
    try {
      if (!post && pad === '/app/vastgoed') {
        let u = overzicht();
        if (u.leeg) { leesDossier(); u = overzicht(); }   // eerste opening: het dossier inlezen (alleen de vault, niets naar buiten)
        else {   // fase 2: bank, Tibber en hypotheek lopen door; lees opnieuw als de laatste lezing ouder is dan een dag (alleen lokaal lezen)
          const oud = u.objecten.map((x) => (x.dossier_op ? new Date(x.dossier_op).getTime() : 0)).reduce((a, b) => Math.min(a, b), Infinity);
          if (!u.objecten.length || nu().getTime() - oud > GELD_DAG_MS) { try { leesDossier(); u = overzicht(); } catch (e) { /* de vorige stand blijft */ } }
        }
        return { status: 200, body: u, reden: 'vastgoed overzicht' };
      }
      if (post && pad === '/app/vastgoed/dossier') { const t = leesDossier(); return { status: 200, body: { ok: true, gelezen: t }, reden: 'vastgoed dossier gelezen' }; }
      if (post && pad === '/app/vastgoed/ververs') { const t = await ververs(idUit()); return { status: 200, body: { ok: true, bijgewerkt: t }, reden: 'vastgoed bronnen ' + (t.geslaagd ? 'bijgewerkt' : 'zonder antwoord') }; }
      if (post && pad === '/app/vastgoed/beelden') return { status: 200, body: beelden(idUit()), reden: 'vastgoed beelden' };
      if (post && pad === '/app/vastgoed/aanroepen') return { status: 200, body: aanroepLijst(), reden: 'vastgoed aanroepen' };
      return { status: 404, body: { ok: false, fout: 'onbekend' }, reden: 'vastgoed onbekend' };
    } catch (e) {
      if (e instanceof Fout) return { status: e.status, body: { ok: false, fout: e.message }, reden: 'vastgoed ' + e.status };
      return { status: 500, body: { ok: false, fout: 'OVIS Vastgoed kon dit niet verwerken' }, reden: 'vastgoed fout' };   // nooit de foutinhoud (kan een adres of bedrag bevatten)
    }
  }
  function info() {
    return metDb((db) => {
      if (!db) return { aan: true, databank: false, bronnen: !!bronnen };
      const n = (t, w) => db.prepare('SELECT COUNT(*) AS n FROM ' + t + (w || '')).get().n;
      let geld = {}; try { geld = JSON.parse((db.prepare(`SELECT waarde FROM meta WHERE sleutel = 'geld'`).get() || {}).waarde || '{}') || {}; } catch (e) { geld = {}; }
      const ok = (x) => (x ? !!x.ok : null);
      return { aan: true, databank: true, bronnen: !!bronnen, objecten: n('object'), feiten: n('feit'), feiten_extern: n('feit', " WHERE herkomst = 'extern'"), reeksen: n('reeks'),
        stukken: n('stuk'), beelden: n('beeld'), aanroepen: n('aanroep'), laatst_extern: (db.prepare('SELECT MAX(extern_op) AS t FROM object').get() || {}).t || null,
        leningdelen: n('leningdeel'), woz_eigen: n('woz_eigen'), reeksen_bank: n('reeks', " WHERE herkomst = 'bank'"), reeksen_tibber: n('reeks', " WHERE herkomst = 'tibber'"),
        geld: { hypotheek: ok(geld.hypotheek), bank: ok(geld.bank), tibber: ok(geld.tibber) } };
    }, false);
  }
  return { app, info, leesDossier, ververs, overzicht, wozHerken, wozControle, wozVastleggen };
}

module.exports = { maak, leesWoning, leesBox, leesDossierMap, dossierstand, indicatie, soortStuk, euroUit, datumUit, bagSoort, SCHEMA_VERSIE,
  leesHypotheek, hypotheekReeksen, laatsteStand, leesKosten, vveUitBank, vveKern, stroomMaanden, wozUitTekst, maandUit, Fout };
