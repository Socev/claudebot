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
const WB = require('./woning-bron.js');   // wv3923: gedeelde lezer voor taxaties en de bankstand van de hypotheek (ook Financiën)

const SCHEMA_VERSIE = 6;   // 6 = bekendmaking + wijziging.url (wv4226, buurtwachter); 2 = fase 2 (wv3102): leningdeel, woz_eigen; reeksen lening/restschuld/verbouwing/servicekosten/stroom; 3 = object.weg_op (A15); 4 = woz_eigen.dagtekening/maten/concept_op (wv4229); 5 = wijziging (wv4182)
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (sleutel TEXT PRIMARY KEY, waarde TEXT);
CREATE TABLE IF NOT EXISTS object (id INTEGER PRIMARY KEY AUTOINCREMENT, sleutel TEXT NOT NULL UNIQUE, soort TEXT NOT NULL CHECK (soort IN ('woning','garagebox')),
  naam TEXT NOT NULL, adres TEXT, dossier TEXT NOT NULL, vbo TEXT NOT NULL DEFAULT '[]', pand TEXT NOT NULL DEFAULT '[]', percelen TEXT NOT NULL DEFAULT '[]',
  woz_nr TEXT, zoek TEXT, punt TEXT, bag_gemeten TEXT, volgorde INTEGER NOT NULL DEFAULT 0, dossier_op TEXT, extern_op TEXT, bron_stand TEXT NOT NULL DEFAULT '{}', weg_op TEXT);
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
CREATE TABLE IF NOT EXISTS wijziging (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, object TEXT, soort TEXT NOT NULL, sleutel TEXT NOT NULL, tekst TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bekendmaking (id TEXT PRIMARY KEY, object TEXT NOT NULL, bron TEXT NOT NULL, datum TEXT, titel TEXT NOT NULL, rubriek TEXT, url TEXT, eerst_op TEXT NOT NULL);
`;
const HUIS = '20_Prive/Huis';
const BRONNEN = '20_Prive/Bronnen/Huis';
const RUBRIEKEN = ['overzicht', 'waarde', 'bouw', 'grond', 'regels'];
const GROEPEN = ['ls', 'bag', '3dbag', 'perceel', 'ahn', 'bodem', 'fundering', 'plannen', 'bro', 'cbs', 'lbm', 'sru', 'ep', 'gld'];   // wv4182: gld = meetreeksen grondwater (alleen woning)   // de bronnen van osint.py vastgoed
const GROEP_NAAM = { ls: 'Locatieserver', bag: 'BAG', '3dbag': '3D-BAG', perceel: 'kadastrale kaart', ahn: 'hoogtebestand', bodem: 'Bodemloket', fundering: 'funderingskaart',
  plannen: 'ruimtelijke plannen', bro: 'BRO', cbs: 'CBS-buurtcijfers', lbm: 'Leefbaarometer', sru: 'bekendmakingen', ep: 'energielabel', gld: 'BRO-grondwaterstanden' };
const EXTERN_VERS_MS = 30 * 24 * 3600 * 1000;      // openbare gegevens ouder dan 30 dagen = "verloopt" in de dossierstand
const VERVERS_MIN_MS = 10 * 60 * 1000;             // hooguit eens per 10 minuten per object naar buiten
const AANROEP_DAGEN = 365;
const FINANCIEN = '20_Prive/Financien';
const GELD_DAG_MS = 24 * 3600 * 1000;               // fase 2: bank, Tibber en hypotheek opnieuw lezen bij openen als de laatste lezing ouder is dan een dag
const RONDE_MAAND_MS = 30 * 24 * 3600 * 1000;      // wv4182: openbare gegevens zelf opnieuw ophalen als ze ouder zijn dan dit
const KELDER_PDF_MS = 25 * 24 * 3600 * 1000;       // wv4182: Bestanden bewaart 30 dagen; ouder dan dit = nieuwe pdf
const WIJZIGING_DAGEN = 365;
// wv4226 (besluitenpagina nr 938 = L38): de buurtwachter. Eens per week (vanuit de dagelijkse ronde) nieuwe bekendmakingen binnen 250 m van de
// woning en nieuwe plannen van de gemeente; een id die al in tabel bekendmaking staat wordt nooit opnieuw gemeld. Eerste keer = nulpunt (stil).
const BUURT_WEEK_MS = 7 * 24 * 3600 * 1000;
const BUURT_OVERLAP_DAGEN = 21;                   // late publicatie of indexering: elke week drie weken terugkijken (dubbel = id al gezien)
const BUURT_EERST_DAGEN = 90;
const BUURT_KM = 0.25;
const BM_URL = /^https:\/\/zoek\.officielebekendmakingen\.nl\/[\w.-]+$/;
const KORT = { jan: 1, feb: 2, mrt: 3, maa: 3, apr: 4, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dec: 12 };
const MAAND = { januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12 };

class Fout extends Error { constructor(status, tekst) { super(tekst); this.status = status; } }
const nuIso = () => new Date().toISOString();
const isoVeilig = (x) => { try { return isoGoed(x); } catch (e) { return false; } };   // wv4228: isoGoed gooit bij maand 13 / dag 40
const isoZeker = (d, m, j) => { try { return iso(d, m, j); } catch (e) { return null; } };
const nlVandaag = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);   // wv4228
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
  // taxaties: | Rapport | Peildatum | Taxateur / kantoor | Doel | Marktwaarde | Na verbouwing | Validatie | — wv3923 (C49): dezelfde lezer als
  // Financiën (woning-bron.js), kolommen op naam; de gewone marktwaarde is de basis, "na verbouwing" een aparte reeks
  for (const r of WB.taxaties(md)) {
    const kantoor = kaal(r.taxateur).split(/[;(]/)[0].replace(/^[A-Z][\w.() -]*?,\s*/, '').slice(0, 80);
    if (r.marktwaarde) u.reeks.push({ reeks: 'taxatie', peildatum: r.datum, waarde: r.marktwaarde, eenheid: 'euro', toelichting: `marktwaarde · ${kantoor}` + (/desktop|calcasa/i.test(r.taxateur) ? ' · modelwaarde zonder bezichtiging' : '') });
    if (r.na_verbouwing) u.reeks.push({ reeks: 'taxatie-na', peildatum: r.datum, waarde: r.na_verbouwing, eenheid: 'euro', toelichting: `marktwaarde na verbouwing · ${kantoor}` });
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
  wozTabellen(md, u.reeks);   // wv3131: tabel per belastingjaar, vóór de losse zin (tabel gaat voor de aangifte)
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

// wv3131: WOZ-tabellen (taxatieverslagen per belastingjaar). Onder een kop met "WOZ" (## tot ####) een markdowntabel met kolommen
// Belastingjaar, Waardepeildatum en Vastgestelde WOZ-waarde (volgorde uit de kopregel); per rij één punt in de reeks woz. Eén punt per peildatum:
// wat al in de reeks staat (andere vorm, of een eerdere rij) blijft; de tabel wordt gelezen vóór de losse zin uit de belastingaangifte en gaat daarvoor.
function celSplits(l) { return String(l).trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((x) => x.trim()); }
const SCHEIDING = /^\s*\|[\s:|-]*-[\s:|-]*$/;
function wozTabellen(md, reeks) {
  const regels = String(md).split('\n');
  let niveau = 0; let kolom = null;
  for (let i = 0; i < regels.length; i++) {
    const l = regels[i];
    const kop = l.match(/^(#{1,6})\s+(.*)$/);
    if (kop) { kolom = null; if (!niveau || kop[1].length <= niveau) niveau = /WOZ/i.test(kop[2]) ? kop[1].length : 0; continue; }
    if (!niveau) continue;
    if (!/^\s*\|/.test(l)) { kolom = null; continue; }
    if (i + 1 < regels.length && SCHEIDING.test(regels[i + 1]) && !SCHEIDING.test(l)) {   // kopregel van een tabel
      const k = celSplits(l).map((x) => kaal(x));
      const bj = k.findIndex((x) => /^belastingjaar$/i.test(x)); const pd = k.findIndex((x) => /peildatum/i.test(x)); const w = k.findIndex((x) => /vastgestelde.*waarde|^WOZ-waarde/i.test(x));
      kolom = bj >= 0 && pd >= 0 && w >= 0 ? { bj, pd, w } : null;
      i++;
      continue;
    }
    if (!kolom || SCHEIDING.test(l)) continue;
    const c = celSplits(l);
    const jaar = Number((kaal(c[kolom.bj]).match(/^(20\d{2})\b/) || [])[1]);
    const dag = datumUit(kaal(c[kolom.pd])); const bedrag = euroUit(kaal(c[kolom.w]));
    if (!jaar || !dag || !bedrag) continue;
    if (reeks.some((r) => r.reeks === 'woz' && r.peildatum === dag)) continue;
    reeks.push({ reeks: 'woz', peildatum: dag, waarde: bedrag, eenheid: 'euro', toelichting: `WOZ ${jaar}` });
  }
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
  const geb = tabelRij(md, 'Gebruik'); if (geb) f('overzicht', 'Gebruik', kaal(geb).slice(0, 120));   // wv4170 (2C54 d): eigen gebruik of verhuurd
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
  wozTabellen(md, u.reeks);   // wv3131: de box las WOZ nog nergens
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
// wv3923 (C49 / review M2): bank = de bankstand uit de gedeelde lezer (woning-bron.js bankstand, dezelfde als Financiën). Is die er, dan telt
// alleen die als bankstand (koppeling op het modeldeel "HypoN"); de tabel "Bankstand" op de pagina is dan alleen nog de terugval zonder json.
function leesHypotheek(md, bank) {
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
  // Review MOET 1: alleen als de json heel is (elk deel met een stand hoort bij een leningdeel op de pagina, elk leningdeel heeft een stand en
  // de som sluit aan op het banktotaal); anders de tabel van de pagina, met de reden erbij (Vastgoed kan dan van Financiën afwijken)
  if (bank && bank.op && Array.isArray(bank.delen) && bank.delen.length) {
    const kop = (d) => d.naam.split(/\s+/)[0];
    const paar = bank.delen.map((b) => ({ b, d: b.model ? u.delen.find((x) => kop(x) === b.model) : null }));
    const som = Math.round(bank.delen.reduce((s, b) => s + (b.restschuld || 0), 0) * 100) / 100;
    const heel = paar.every((x) => x.d && x.b.restschuld !== null) && u.delen.every((d) => paar.some((x) => x.d === d)) && new Set(paar.map((x) => x.d)).size === paar.length &&
      bank.totaal !== null && Math.abs(som - bank.totaal) < 0.01;
    if (heel) {
      for (const x of paar) {
        x.d.restschulden.push({ peildatum: bank.op, waarde: x.b.restschuld, bron: 'bank' });
        if (x.b.rente_pct !== null) x.d.rente_bank = String(x.b.rente_pct).replace('.', ',') + '%';
        // wv4170 (2C54): noemt de pagina geen rentevaste datum ("onbekend"), dan die uit je Excel (dezelfde als Financiën), met de bron erbij
        if (x.b.rentevast && !datumUit(x.d.rentevast_tot)) x.d.rentevast_tot = x.b.rentevast.split('-').reverse().map(Number).join('-') + ' (je Excel)';
      }
      u.bank_bron = bank.bron || 'json';
      return u;
    }
    u.bank_afwijking = 'de bankstand in de hypotheek-json past niet op de leningdelen van de pagina; hier de tabel Bankstand van de pagina';
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
  // wv4229 (L41): de dagtekening (daar begint de bezwaartermijn) en de maten waarmee de gemeente rekent, als ze in het stuk staan
  let dagtekening = null;
  m = s.match(/dagtekening\D{0,20}?(\d{1,2}[- ](?:\d{1,2}|januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)[- ]\d{4})/i);
  if (m) { const d = datumUit(/^\d{1,2} \d{1,2} \d{4}$/.test(m[1]) ? m[1].replace(/ /g, '-') : m[1]); if (d && Number(d.slice(0, 4)) >= 2000 && Number(d.slice(0, 4)) <= ditJaar + 1) dagtekening = d; }
  const maten = {};
  m = s.match(/(?:gebruiksoppervlakte|woonoppervlakte|oppervlakte (?:woning|wonen)|woning)\D{0,40}?(\d{1,4})\s*m(?:²|2)(?![\w²])/i);
  if (m && Number(m[1]) >= 5) maten.wonen_m2 = Number(m[1]);
  m = s.match(/(?:perceel(?:oppervlakte)?|kavel(?:oppervlakte)?|grond(?:oppervlakte)?)\D{0,40}?(\d{1,5})\s*m(?:²|2)(?![\w²])/i);
  if (m && Number(m[1]) >= 1) maten.grond_m2 = Number(m[1]);
  return { jaar, waarde, peildatum, dagtekening, maten };
}
// wv4229 (L41): bezwaar tegen een WOZ-beschikking kan zes weken; de termijn begint de dag na de dagtekening (AWR art. 22j, Awb 6:7/6:8).
// We rekenen dagtekening + 42 dagen, zonder verlenging voor een weekend of feestdag (Algemene termijnenwet): liever een dag te vroeg dan te laat.
function bezwaarTot(dagtekening) {
  if (!isoGoed(String(dagtekening || ''))) return null;
  const t = new Date(dagtekening + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + 42);
  return t.toISOString().slice(0, 10);
}
// wv4229 (L41): regels voor het deadline-register (00_Systeem/Deadlines.md). Geen bedragen in de regel; de sleutel in de kolom Bron maakt het
// idempotent (staat hij ergens in het register, ook onder Afgehandeld, dan niet nog eens). Gedaan/Later doet David via het actielijstje of Voor jou.
const NL_DAG = (d) => `${Number(d.slice(8, 10))}-${Number(d.slice(5, 7))}-${d.slice(0, 4)}`;
function wozDeadlineRegels(v, vandaag) {
  const uit = [];
  const cel = (t) => String(t).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  if (v.bezwaar_tot && v.bezwaar_tot >= vandaag) {
    const sl = `vastgoed-woz-bezwaar-${v.jaar}-${v.id}`;
    uit.push({ sleutel: sl, regel: `| ${v.bezwaar_tot} | Privé (David) | **WOZ ${v.jaar} ${cel(v.naam)}: bezwaar kan tot en met ${NL_DAG(v.bezwaar_tot)}** (zes weken na de dagtekening ${NL_DAG(v.dagtekening)}; de vergelijking met vorig jaar en de buurt staat in Apps › Vastgoed › Waarde). | [jij] alleen als je bezwaar wilt maken: in Vastgoed "Concept-bezwaar", lezen, dan zelf indienen ⏱ ± 30 min | 14 | Vastgoed (${sl}) |` });
  }
  if (v.soort === 'woning') {
    const j = v.jaar + 1, sl = `vastgoed-woz-seintje-${j}`;
    uit.push({ sleutel: sl, regel: wozSeintjeRegel(j) });
  }
  return uit;
}
function wozSeintjeRegel(j) {
  return `| ${j}-03-31 | Privé (David) | **WOZ-beschikkingen ${j} (woning en beide garageboxen) staan vanaf eind februari klaar bij de gemeente (MijnOverheid of het belastingloket); ze komen niet per mail.** Zet ze in Apps › Vastgoed › Waarde › "WOZ-beschikking toevoegen": dan zie je ze naast vorig jaar en de buurt, en tot wanneer bezwaar kan (zes weken na de dagtekening). | [jij] beschikkingen downloaden en in Vastgoed zetten ⏱ ± 30 min | 35 | Vastgoed (vastgoed-woz-seintje-${j}) |`;
}
// Het concept-bezwaar (vaste tekst, Davids formele toon zoals in zijn bezwaar van 2023: kort, zakelijk, met verzoek om de onderbouwing).
// Alleen gecontroleerde velden; waar een gegeven ontbreekt staat een open plek tussen [ ] die David zelf invult.
function wozBezwaarTekst(v, o) {
  const eur = (n) => '€ ' + Math.round(n).toLocaleString('nl-NL');
  const r = ['Geachte heer, mevrouw,', ''];
  r.push(`Hierbij maak ik bezwaar tegen de WOZ-beschikking ${v.jaar}${v.dagtekening ? ' met dagtekening ' + NL_DAG(v.dagtekening) : ''} voor ${o.adres || o.naam}${o.woz_nr ? ' (WOZ-objectnummer ' + o.woz_nr + ')' : ''}. `
    + `U hebt de waarde vastgesteld op ${eur(v.waarde)}, naar de waardepeildatum ${NL_DAG(v.peildatum)}.`);
  r.push('', 'Mijn bezwaar:');
  if (v.vorig) r.push(`- Vorig jaar was de waarde ${eur(v.vorig.waarde)}. Dat is ${v.verschil >= 0 ? 'een stijging' : 'een daling'} van ${eur(Math.abs(v.verschil))} (${String(Math.abs(v.pct)).replace('.', ',')}%).`);
  if (v.buurt) r.push(`- ${v.buurt.veld}: ${v.buurt.waarde} (CBS).`);
  if (v.maten && v.maten.wonen_m2 && v.maten.bag) r.push(`- U rekent met ${v.maten.wonen_m2} m² woonoppervlakte; de Basisregistratie Adressen en Gebouwen noemt ${v.maten.bag}.`);
  r.push('- [vul aan: waarom de waarde te hoog is, bijvoorbeeld de staat van de woning of verkopen in de buurt die lager liggen]');
  r.push('', 'Ik verzoek u de waarde te verlagen. Graag ontvang ik het taxatieverslag met de vergelijkingsobjecten (de waardematrix) die u hebt gebruikt, en wil ik in de gelegenheid worden gesteld mijn bezwaar mondeling toe te lichten.');
  r.push('', 'Met vriendelijke groet,', '', 'David Schaap');
  return r.join('\n');
}
// Zet de regels onderaan de tabel onder "## Actueel". Geeft de nieuwe tekst, of null als er niets bij hoeft of de tabel niet te vinden is.
// Review Codex MOET 1: staat de sleutel al in ## Actueel met een andere datum (David verbeterde de dagtekening), dan wordt die regel
// vervangen door de nieuwe; zelfde datum = laten staan (met eventuele GESEIND-merktekens). Onder ## Afgehandeld: niets doen.
function deadlineErbij(tekst, regels) {
  const t = String(tekst || '');
  const rg = t.split('\n');
  const a = rg.findIndex((r) => /^## Actueel\s*$/.test(r));
  if (a < 0) return null;
  let b = a + 1; while (b < rg.length && !/^## /.test(rg[b])) b++;   // ## Actueel loopt tot de volgende ## -kop
  let veranderd = false;
  const nieuw = [];
  for (const r of regels) {
    const k = `(${r.sleutel})`;
    if (!t.includes(k)) { nieuw.push(r); continue; }
    const i = rg.findIndex((x, j) => j > a && j < b && x.startsWith('|') && x.includes(k));
    if (i < 0) continue;   // alleen onder Afgehandeld (of elders): niet opnieuw
    if (rg[i].slice(0, 13) !== r.regel.slice(0, 13)) { rg[i] = r.regel; veranderd = true; }
  }
  if (!nieuw.length) return veranderd ? rg.join('\n') : null;
  let i = a + 1;
  while (i < rg.length && !rg[i].startsWith('| Datum |')) { if (/^## /.test(rg[i])) return null; i++; }
  if (i >= rg.length) return null;
  let eind = i + 1;
  while (eind < rg.length && rg[eind].startsWith('|')) eind++;
  rg.splice(eind, 0, ...nieuw.map((r) => r.regel));
  return rg.join('\n');
}
// Nieuwe WOZ naast die van vorig jaar, het buurtgemiddelde (CBS-feit), de indicatie en de maten (stuk naast BAG). Puur op een object uit overzicht().
// vorig = de WOZ met de waardepeildatum een jaar vóór die van de nieuwe (belastingjaar − 2), ongeacht hoe de toelichting hem noemt.
function wozVergelijkObject(o, x) {
  const jaar = Number(x.jaar), waarde = Number(x.waarde);
  const pd = isoGoed(String(x.peildatum || '')) ? x.peildatum : `${jaar - 1}-01-01`;
  const vpd = `${Number(pd.slice(0, 4)) - 1}${pd.slice(4)}`;
  const woz = (o.reeksen || []).filter((r) => r.reeks === 'woz');
  const v = woz.find((r) => r.peildatum === vpd) || null;
  const vorig = v ? { jaar: Number(vpd.slice(0, 4)) + 1, waarde: v.waarde, peildatum: v.peildatum } : null;
  const verschil = vorig && Number.isFinite(waarde) ? Math.round(waarde - vorig.waarde) : null;
  const pct = vorig && vorig.waarde > 0 && Number.isFinite(waarde) ? Math.round(((waarde - vorig.waarde) / vorig.waarde) * 1000) / 10 : null;
  const bf = (o.feiten || []).find((f) => /^Gemiddelde WOZ-waarde/.test(f.veld)) || null;
  const buurt = bf ? { veld: bf.veld.replace('Gemiddelde WOZ-waarde', 'Gemiddelde WOZ in de buurt'), waarde: bf.waarde } : null;
  const bag = (o.feiten || []).find((f) => f.veld === 'Gebruiksoppervlakte (BAG)') || null;
  const mt = x.maten && typeof x.maten === 'object' ? x.maten : {};
  const maten = { wonen_m2: Number.isInteger(mt.wonen_m2) ? mt.wonen_m2 : null, grond_m2: Number.isInteger(mt.grond_m2) ? mt.grond_m2 : null, bag: bag ? bag.waarde : null };
  const dag = isoGoed(String(x.dagtekening || '')) ? x.dagtekening : null;
  return { id: o.id, naam: o.naam, soort: o.soort, jaar, waarde, peildatum: pd, vorig, verschil, pct, buurt,
    indicatie: o.indicatie ? { waarde: o.indicatie.waarde, peildatum: o.indicatie.peildatum || null } : null, maten,
    dagtekening: dag, bezwaar_tot: bezwaarTot(dag) };
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
function leesDossierMap(vault, vandaag) {
  const huis = path.join(vault, HUIS);
  let namen = [];
  try { namen = fs.readdirSync(huis).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort(); } catch (e) { throw new Fout(503, 'het huisdossier in de vault is niet te lezen'); }
  const lees = (n) => { try { return fs.readFileSync(path.join(huis, n), 'utf8'); } catch (e) { return ''; } };
  const objecten = [];
  // A15 (Fable-review 19-11): een pagina is pas een object bij de vaste vorm: een kop "## Kerngegevens" plus een adres of BAG-nummer (woning)
  // of een adres met huisnummer-toevoeging of een kadastrale aanduiding (box). Een overzichtspagina als "Garageboxen.md" is dus geen derde box.
  // Meer woningpagina's: de eerste die voldoet telt. Twee pagina's voor dezelfde box: de eerste.
  const vasteVorm = (md) => sectie(md, 'Kerngegevens').trim() !== '';
  for (const n of namen.filter((x) => /^Woning\b/.test(x))) {
    const md = lees(n); if (!vasteVorm(md)) continue;
    const w = leesWoning(md); if (!w.adres && !w.vbo.length) continue;
    objecten.push(Object.assign(w, { dossier: `${HUIS}/${n}`, sleutel: 'woning' })); break;
  }
  const boxen = [];
  for (const n of namen.filter((x) => /^Garagebox/i.test(x))) {
    const md = lees(n); if (!vasteVorm(md)) continue;
    const b = leesBox(md); if (!b.zoek && !b.complex) continue;
    b.sleutel = 'box-' + (b.zoek ? b.zoek.toevoeging : b.complex.index);
    if (!boxen.some((x) => x.sleutel === b.sleutel)) boxen.push(Object.assign(b, { dossier: `${HUIS}/${n}` }));
  }
  boxen.sort((a, b) => Number(a.sleutel.slice(4)) - Number(b.sleutel.slice(4)));
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
    let bank = null; try { bank = WB.bankstand(vault); } catch (e) { bank = null; }   // wv3923: dezelfde bankstand als Financiën
    if (hn) hypotheek = Object.assign(leesHypotheek(fs.readFileSync(path.join(vault, FINANCIEN, hn), 'utf8'), bank), { pagina: `${FINANCIEN}/${hn}` });
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
  // wv4170 (2C54): de woninglening van de Holding (zolder en badkamers), dezelfde lezer en stand als Financiën
  let holding = null; try { holding = WB.holdingLening(vault, (vandaag || new Date()).toISOString().slice(0, 10)); } catch (e) { holding = null; }
  return { objecten, verbouwingen, stukken, hypotheek, holding };
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
// wv4170 (2C54, Fable-review "Een 9 - vastgoed" § S1/S4): de drie getallen die bij een verbouwing eerst komen.
//   hypotheek  de leningdelen van de woning (de delen die bij een box horen staan bij die box; samen = de hele hypotheek van de hypotheekpagina)
//   holding    de woninglening van de Holding (zolder en badkamers; telt mee in de eigenwoningschuld en in Financiën), meegeteld in restschuld
//   overwaarde indicatie − restschuld; heet altijd indicatie (de waarde is geen taxatie). Ontbreekt een stand, dan geen getal (null + reden).
//   rentevast  de vroegste rentevaste datum van een leningdeel met restschuld, over de hele hypotheek (ook het deel van een box)
function geldKern(woning, objecten, holding) {
  const alle = objecten.flatMap((o) => (o.leningdelen || []).map((d) => Object.assign({ object: o.sleutel, object_naam: o.naam }, d)));
  const eigen = alle.filter((d) => d.object === woning.sleutel);
  const som = (l) => (l.length && l.every((d) => d.restschuld !== null && d.restschuld !== undefined) ? Math.round(l.reduce((s, d) => s + d.restschuld, 0) * 100) / 100 : null);
  const hyp = som(eigen), totaal = som(alle);
  const op = eigen.map((d) => d.restschuld_op).filter(Boolean).sort().pop() || null;
  // review wv4170 MOET 1: een deel zonder stand maakt het subtotaal van die box onbekend (null), nooit stil € 0
  const elders = Object.values(alle.filter((d) => d.object !== woning.sleutel).reduce((t, d) => { (t[d.object] = t[d.object] || { naam: d.object_naam, delen: [] }).delen.push(d); return t; }, {}))
    .map((x) => ({ naam: x.naam, restschuld: som(x.delen) }));
  const h = holding && holding.ok && Number.isFinite(holding.stand) ? { stand: holding.stand, stand_op: holding.stand_op || null, stand_bron: holding.stand_bron || null, rente_pct: holding.rente_pct ?? null } : null;
  const reden = [];
  if (hyp === null) reden.push(eigen.length ? 'niet elk leningdeel heeft een stand' : 'geen leningdelen gelezen');
  if (!h) reden.push((holding && holding.reden) || 'de lening van de Holding is niet gelezen');
  const restschuld = hyp !== null && h ? Math.round((hyp + h.stand) * 100) / 100 : null;
  const ind = woning.indicatie ? woning.indicatie.waarde : null;
  if (ind === null) reden.push('nog geen indicatie (taxatie en CBS-index nodig)');
  const rv = alle.filter((d) => (d.restschuld || 0) > 0).map((d) => ({ d, dag: datumUit(d.rentevast_tot) })).filter((x) => x.dag)
    .sort((a, b) => (a.dag < b.dag ? -1 : a.dag > b.dag ? 1 : 0))[0];
  const zonder = alle.filter((d) => (d.restschuld || 0) > 0 && !datumUit(d.rentevast_tot)).length;
  return {
    hypotheek: { restschuld: hyp, op, delen: eigen.length, alle_delen: alle.length, totaal, elders },
    holding: h,
    restschuld, overwaarde: restschuld !== null && ind !== null ? Math.round(ind - restschuld) : null, indicatie: ind,
    rentevast: rv ? { datum: rv.dag, deel: rv.d.naam, restschuld: rv.d.restschuld, excel: /je excel/i.test(rv.d.rentevast_tot || ''), zonder_datum: zonder } : null,
    reden: reden.length ? reden : null,
  };
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

// ---------------------------------------------------------------- wv4227 (besluitenpagina nr 939 = L39, David Ja 25-11-2026 22:27): Socev leest Vastgoed
// Pure functie op het overzicht van GET /app/vastgoed (dus dezelfde cijfers als het scherm). Drie leesopdrachten: kern, tab, zoek.
// Elke regel krijgt een link naar het tabblad (de app leest o en s uit de hash). Niets schrijven: er bestaat hier geen schrijfopdracht.
const GESPREK_TABS = ['overzicht', 'waarde', 'bouw', 'grond', 'regels', 'stukken'];
const GESPREK_MAX_TAB = 150, GESPREK_MAX_ZOEK = 25;
const GESPREK_BASIS = 'https://app.socev.dev/vastgoed';
function gesprekLink(basis, sleutel, tab) { return `${basis || GESPREK_BASIS}#o=${encodeURIComponent(sleutel)}&s=${tab}`; }
function gesprekNorm(t) { return String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function gesprekBron(b) { const s = String(b || ''); return s.startsWith('dossier: ') ? 'dossier' : s.slice(0, 80) || null; }
function gesprekFeit(f) { return { veld: f.veld, waarde: f.waarde, peildatum: f.peildatum || null, herkomst: f.herkomst, bron: gesprekBron(f.bron) }; }
function gesprekObject(ov, sleutel) {
  const act = (ov.objecten || []).filter((x) => !x.weg_op);
  if (!sleutel) return null;
  const s = String(sleutel).toLowerCase().trim();
  return act.find((x) => x.sleutel === s) || (s === 'huis' ? act.find((x) => x.soort === 'woning') : null)
    || (/^\d+$/.test(s) ? act.find((x) => x.sleutel === 'box-' + s) : null) || null;
}
function gesprekUit(ov, b, basis) {
  const opdracht = String(b && b.opdracht || '');
  const fout = (t) => ({ status: 400, body: { ok: false, fout: t } });
  if (!ov || !ov.ok) return { status: 503, body: { ok: false, fout: 'Vastgoed is nu niet te lezen' } };
  const act = (ov.objecten || []).filter((x) => !x.weg_op);
  const links = (o) => Object.fromEntries(GESPREK_TABS.map((t) => [t, gesprekLink(basis, o.sleutel, t)]));
  const soortNaam = ov.stuk_soorten || STUK_SOORT;
  if (opdracht === 'kern') {
    const objecten = act.map((o) => {
      const woz = (o.reeksen || []).filter((r) => r.reeks === 'woz').slice(-1)[0] || null;
      const label = (o.feiten || []).filter((f) => /energielabel|energieklasse/i.test(f.veld) || (f.herkomst === 'extern' && f.rubriek === 'bouw' && /^(Geldig tot|Registratiedatum)$/.test(f.veld)))
        .map(gesprekFeit);
      const u = { sleutel: o.sleutel, soort: o.soort, naam: o.naam, adres: o.adres || null, link: gesprekLink(basis, o.sleutel, 'overzicht'),
        dossier_gelezen: o.dossier_op || null, openbaar_opgehaald: o.extern_op || null,
        dossierstand: o.stand ? { score: o.stand.score, ontbreekt: (o.stand.ontbreekt || []).slice(0, 5) } : null,
        woz: woz ? { waarde: woz.waarde, peildatum: woz.peildatum, toelichting: woz.toelichting || null, link: gesprekLink(basis, o.sleutel, 'waarde') } : null,
        energielabel: { feiten: label, link: gesprekLink(basis, o.sleutel, 'bouw') }, tabbladen: links(o) };
      if (o.soort === 'woning') {
        u.geld = o.geld_kern ? Object.assign({}, o.geld_kern, { link: gesprekLink(basis, o.sleutel, 'waarde') }) : null;
        u.indicatie = o.indicatie ? { waarde: o.indicatie.waarde, basis: o.indicatie.basis, basis_datum: o.indicatie.basis_datum, uitleg: o.indicatie.uitleg || null } : null;
      }
      if (o.soort === 'garagebox') u.vve = o.vve || null;
      return u;
    });
    return { status: 200, body: { ok: true, opdracht, objecten, geld_stand: ov.geld || null } };
  }
  if (opdracht === 'tab') {
    const o = gesprekObject(ov, b.object);
    if (!o) return fout('onbekend object; kies uit: ' + act.map((x) => x.sleutel).join(', '));
    const tab = String(b.tab || '');
    if (!GESPREK_TABS.includes(tab)) return fout('onbekend tabblad; kies uit: ' + GESPREK_TABS.join(', '));
    const u = { ok: true, opdracht, object: o.sleutel, naam: o.naam, tab, link: gesprekLink(basis, o.sleutel, tab) };
    let regels;
    if (tab === 'stukken') regels = (o.stukken || []).map((s) => ({ naam: s.naam, soort: soortNaam[s.soort] || s.soort, datum: s.datum || null }));
    else regels = (o.feiten || []).filter((f) => f.rubriek === tab).map(gesprekFeit);
    if (tab === 'overzicht') u.gebeurtenissen = (o.gebeurtenissen || []).map((g) => ({ datum: g.datum || null, titel: g.titel })).slice(0, 40);
    if (tab === 'waarde') {
      const per = {};
      for (const r of o.reeksen || []) (per[r.reeks] = per[r.reeks] || []).push({ peildatum: r.peildatum, waarde: r.waarde, toelichting: r.toelichting || null });
      u.reeksen = Object.fromEntries(Object.entries(per).map(([k, l]) => [k, { punten: l.length, laatste: l.slice(-3) }]));
      u.leningdelen = (o.leningdelen || []).map((d) => ({ naam: d.naam, restschuld: d.restschuld, restschuld_op: d.restschuld_op || null, rente: d.rente_bank ?? d.rente, rentevast_tot: d.rentevast_tot || null, einde: d.einde || null }));
      if (o.soort === 'woning') { u.geld = o.geld_kern || null; u.indicatie = o.indicatie || null; }
      if (o.soort === 'garagebox') u.vve = o.vve || null;
    }
    u.regels = regels.slice(0, GESPREK_MAX_TAB);
    if (regels.length > GESPREK_MAX_TAB) u.meer = regels.length - GESPREK_MAX_TAB;
    return { status: 200, body: u };
  }
  if (opdracht === 'zoek') {
    const woorden = gesprekNorm(b.woorden).split(/[^a-z0-9²]+/).filter((w) => w.length > 1).slice(0, 8);
    if (!woorden.length) return fout('woorden ontbreken');
    const past = (t) => { const n = gesprekNorm(t); return woorden.every((w) => n.includes(w)); };
    const alleen = b.object ? gesprekObject(ov, b.object) : null;
    if (b.object && !alleen) return fout('onbekend object; kies uit: ' + act.map((x) => x.sleutel).join(', '));
    const feiten = [], stukken = [], gebeurtenissen = [];
    for (const o of alleen ? [alleen] : act) {
      const wie = { object: o.sleutel, naam: o.naam };
      for (const f of o.feiten || []) if (past(f.veld + ' ' + f.waarde + ' ' + f.rubriek)) feiten.push(Object.assign({}, wie, gesprekFeit(f), { tab: f.rubriek, link: gesprekLink(basis, o.sleutel, f.rubriek) }));
      for (const s of o.stukken || []) if (past(s.naam + ' ' + (soortNaam[s.soort] || s.soort))) stukken.push(Object.assign({}, wie, { stuk: s.naam, soort: soortNaam[s.soort] || s.soort, datum: s.datum || null, tab: 'stukken', link: gesprekLink(basis, o.sleutel, 'stukken') }));
      for (const g of o.gebeurtenissen || []) if (past(g.titel)) gebeurtenissen.push(Object.assign({}, wie, { datum: g.datum || null, titel: g.titel, tab: 'overzicht', link: gesprekLink(basis, o.sleutel, 'overzicht') }));
    }
    const kap = (l) => ({ n: l.length, lijst: l.slice(0, GESPREK_MAX_ZOEK) });
    return { status: 200, body: { ok: true, opdracht, woorden, feiten: kap(feiten), stukken: kap(stukken), gebeurtenissen: kap(gebeurtenissen) } };
  }
  return fout('onbekende opdracht; kies uit: kern, tab, zoek');
}

// ---------------------------------------------------------------- module
// ---------------------------------------------------------------- wv4182 (besluitenpagina nr 149 = 2C49): kelderdossier en zelf verversen
// Het kelderdossier brengt bij elkaar wat al bekend is voor bouwadviseur en aannemer (stand en besluit, randvoorwaarden, tekeningen, hoogtes,
// grondwater met meetreeksen, sonderingen, bestemming, fundering), elke regel met bron en datum. De lezer is net zo eng als die van het
// dossier: alleen de vaste vorm van de kelderpagina (verbouwpagina met "Kelder" in de titel) en van de woningpagina (§ Bodem en fundering,
// § Bestemmingsplan); wat niet in die vorm staat blijft grijs, nooit geraden. Geen netwerk, geen schrijfactie.
const KELDER_ONDERDELEN = [['stand', 'Stand en besluit'], ['voorwaarden', 'Randvoorwaarden'], ['tekeningen', 'Tekeningen'], ['hoogtes', 'Maaiveld en hoogtes'],
  ['grondwater', 'Grondwater'], ['sonderingen', 'Sonderingen'], ['bestemming', 'Bestemming en bouwregels'], ['fundering', 'Fundering']];
const isoUitNl = (t) => { const m = /\b(\d{1,2})-(\d{1,2})-(\d{4})\b/.exec(String(t || '')); return m ? iso(Number(m[1]), Number(m[2]), Number(m[3])) : null; };
const kaalMd = (t) => kaal(String(t || '').replace(/^\*(?:Bron|Bronnen)\b[^\n]*$/gim, '').replace(/^>\s?/gm, '').replace(/\[!\w+\]\s*/g, '')).replace(/\*\(bron[^)]*\)\*/gi, '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
function kopDatum(md, re, jaar) {   // datum uit de kop boven de eerste regel die op re past: "(22-9)" of "6-11-2026"; zonder jaar het jaar van de pagina
  const r = String(md || '').split('\n');
  let i = r.findIndex((x) => re.test(x));
  for (; i >= 0; i--) if (/^#{2,3}\s/.test(r[i])) break;
  if (i < 0) return null;
  const vol = isoUitNl(r[i]); if (vol) return vol;
  const m = /\((\d{1,2})-(\d{1,2})\)/.exec(r[i]);
  return m && jaar ? iso(Number(m[1]), Number(m[2]), Number(jaar)) : null;
}
function frontVeld(md, veld) { const m = String(md || '').match(new RegExp(`^${veld}:\\s*(.+)$`, 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : null; }
function alineaMet(md, re) {   // de alinea (tot een lege regel) waarin een regel op re past
  const r = String(md || '').split('\n');
  const i = r.findIndex((x) => re.test(x));
  if (i < 0) return null;
  let a = i, b = i;
  while (a > 0 && r[a - 1].trim() && !/^#/.test(r[a - 1])) a--;
  while (b < r.length - 1 && r[b + 1].trim() && !/^#/.test(r[b + 1])) b++;
  return r.slice(a, b + 1).join('\n');
}
function opsomming(tekst) {   // "- regel" (met vervolgregels) → [tekst]
  const uit = [];
  let ouder = null;   // "**Kop:**" met een ingesprongen lijst eronder: de kop gaat voor elke subregel
  for (const l of String(tekst || '').split('\n')) {
    if (/^\s{2,}[-*]\s+/.test(l) && ouder) { uit.push(ouder + ' ' + l.replace(/^\s*[-*]\s+/, '')); continue; }
    if (/^[-*]\s+/.test(l)) { const t = l.replace(/^[-*]\s+/, ''); if (/:\**\s*$/.test(t)) { ouder = t.replace(/\s+$/, ''); continue; } ouder = null; uit.push(t); continue; }
    if (/^\s*[-*]\s+/.test(l)) uit.push(l.replace(/^\s*[-*]\s+/, ''));
    else if (uit.length && /^\s{2,}\S/.test(l) && !/^\s*[-*]\s/.test(l)) uit[uit.length - 1] += ' ' + l.trim();
  }
  return uit.map(kaalMd).filter(Boolean);
}
function kopSectie(md, kopRe) {   // tekst onder de eerste ## of ### kop die op kopRe past, tot de volgende kop van hetzelfde of hoger niveau
  const r = String(md || '').split('\n');
  const i = r.findIndex((x) => /^#{2,3}\s/.test(x) && kopRe.test(x));
  if (i < 0) return null;
  const niv = r[i].match(/^#+/)[0].length;
  let j = i + 1;
  while (j < r.length && !(new RegExp(`^#{1,${niv}}\\s`).test(r[j]))) j++;
  return { kop: kaal(r[i].replace(/^#+\s*/, '')), tekst: r.slice(i + 1, j).join('\n') };
}
// De kelderpagina en de woningpagina → losse stukken tekst (nog zonder bron; die zet kelderDossier).
function leesKelder(kelderMd, woningMd) {
  const k = { status: frontVeld(kelderMd, 'status'), bijgewerkt: isoGoed(frontVeld(kelderMd, 'updated') || '') ? frontVeld(kelderMd, 'updated') : null, titel: titel(kelderMd) };
  const besluit = alineaMet(kelderMd, /^\*\*Besluit\b/);
  k.besluit = besluit ? { tekst: kaalMd(besluit.replace(/\*\(bron[^)]*\)\*/gi, '')), datum: isoUitNl(besluit) } : null;
  const bp = kopSectie(kelderMd, /Bouwplan/i);
  if (bp) {
    const eerste = bp.tekst.split(/\n\s*\n/).map((x) => x.trim()).find((x) => x && !/^\*\*Besluit/.test(x)) || '';
    k.bouwplan = { kop: bp.kop, tekst: kaalMd(eerste), datum: isoUitNl(bp.kop) || isoUitNl(eerste) };
    const m = /onderzijde\s+(\d[\d.,]*)\s*mm\s*[−–-]\s*NAP/i.exec(bp.tekst);
    k.kelderbak = m ? { tekst: `Onderzijde kelderbak ${m[1].replace('.', '')} mm onder NAP (bouwplan)`, datum: k.bouwplan.datum } : null;
  }
  const jaar = (k.bijgewerkt || '').slice(0, 4);
  const kantel = alineaMet(kelderMd, /\[!\w+\]\s*Het punt waarop/);
  k.kantel = kantel ? { tekst: kaalMd(kantel.replace(/^>\s*\[!\w+\][^\n]*\n?/, '')), datum: kopDatum(kelderMd, /\[!\w+\]\s*Het punt waarop/, jaar) } : null;
  const vo = kopSectie(kelderMd, /Stand van het vooronderzoek/i);
  k.vooronderzoek = vo ? { kop: vo.kop, regels: opsomming(vo.tekst), datum: isoUitNl(vo.kop) ? null : null } : null;
  k.sondering = [];
  for (const blok of String(kelderMd || '').split(/\n\s*\n/)) if (/sondering/i.test(blok) && !/^>/.test(blok.trim()) && !/^---/.test(blok.trim())) {
    const eerste = blok.split('\n')[0];
    const d = kopDatum(kelderMd, new RegExp('^' + eerste.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), jaar);
    for (const zin of kaalMd(blok.replace(/^\s*[-*]\s+/gm, '')).split(/(?<=[.!?])\s+/)) if (/sondering/i.test(zin)) k.sondering.push({ tekst: zin.trim(), datum: d });
  }
  const open = alineaMet(kelderMd, /^\*\*Open:\*\*/);
  k.open = open ? { tekst: kaalMd(open.replace(/^\*\*Open:\*\*\s*/, '')), datum: kopDatum(kelderMd, /^\*\*Open:\*\*/, jaar) } : null;
  // woningpagina
  const w = { bijgewerkt: isoGoed(frontVeld(woningMd, 'updated') || '') ? frontVeld(woningMd, 'updated') : null };
  const bf = kopSectie(woningMd, /^##\s+Bodem en fundering/i);
  if (bf) {
    const i = bf.tekst.indexOf('**Voor het kelderplan**');
    w.voorKelder = i >= 0 ? opsomming(bf.tekst.slice(i).split('\n').slice(1).join('\n')) : [];
    const fm = alineaMet(bf.tekst, /Funderingsrisicorapport/);
    const fl = bf.tekst.slice(bf.tekst.indexOf('**Funderingsrisicorapport')).split('**Voor het kelderplan**')[0];
    const fk = fm ? kaalMd(fm.split('\n')[0]) : '';
    w.fundermaps = fm ? { kop: (fk.match(/^[^(]*\([^,)]*/) || [fk])[0].replace(/:$/, '') + (/\(/.test(fk) ? ')' : ''), datum: isoUitNl(fm), regels: opsomming(fl) } : null;
  }
  const bs = kopSectie(woningMd, /^##\s+Bestemmingsplan/i);
  if (bs) {
    const t = bs.tekst.split(/\n\*\*Bouwdossier/)[0];
    const plan = (t.match(/^\*\*Bestemmingsplan[^\n]*/m) || [null])[0];
    w.bestemming = { plan: plan ? kaalMd(plan) : null, datum: isoUitNl(plan), regels: opsomming(t).filter((x) => /plan-ID|bestemming|Bijbehorende|maximaal 30|Kelders|onbebouwd|Hoofdgebouw|dakterras/i.test(x)) };
  }
  return { kelder: k, woning: w };
}
// Het dossier zelf (puur): o = het woningobject uit overzicht() (feiten, reeksen, stukken, bron_stand), l = leesKelder(...), pagina's = paden.
function kelderDossier(o, l, pag, extra) {
  const k = (l && l.kelder) || {}, w = (l && l.woning) || {};
  const KP = pag && pag.kelder, WP = pag && pag.woning;
  const dk = (t) => ({ dossier: true, pagina: t });
  const R = (tekst, bron, datum, x) => Object.assign({ tekst: String(tekst).slice(0, 900), bron, datum: datum || null }, x || {});
  const extern = (f) => R(`${f.veld}: ${f.waarde}`, f.bron, (f.peildatum && isoGoed(f.peildatum) ? f.peildatum : null) || String(f.opgehaald || '').slice(0, 10), Object.assign({ extern: true }, f.url ? { url: f.url } : {}));
  const fe = (o.feiten || []).filter((f) => f.herkomst === 'extern');
  const bs = o.bron_stand || {};
  const on = {};
  for (const [id] of KELDER_ONDERDELEN) on[id] = [];
  if (KP) {
    if (k.besluit) on.stand.push(R(k.besluit.tekst, 'kelderpagina (besluit)', k.besluit.datum, dk(KP)));
    if (k.bouwplan) on.stand.push(R(k.bouwplan.tekst, 'kelderpagina (' + k.bouwplan.kop.replace(/\s*—.*$/, '') + ')', k.bouwplan.datum, dk(KP)));
    if (k.kantel) on.stand.push(R('Kantelpunt: ' + k.kantel.tekst, 'kelderpagina', k.kantel.datum, dk(KP)));
    if (k.open) on.stand.push(R('Open: ' + k.open.tekst, 'kelderpagina', k.open.datum, dk(KP)));
    if (k.status) on.stand.push(R(`Stand: ${k.status}${k.bijgewerkt ? ', kelderpagina bijgewerkt ' + nlDag(k.bijgewerkt) : ''}`, 'kelderpagina', k.bijgewerkt, dk(KP)));
  }
  for (const x of w.voorKelder || []) on.voorwaarden.push(R(x, 'woningpagina § Bodem en fundering', w.bijgewerkt, dk(WP)));
  // tekeningen: stukken van de woning (vaste soorten) en de constructietekeningen uit het opgevraagde bouwdossier
  const tekRe = /palenplan|constructie|doorsnede|bouwplan kelder|begane grond|gevel|situatie/i;
  for (const s of (o.stukken || []).filter((x) => ['tekening', 'constructie'].includes(x.soort) && tekRe.test(x.naam) && !/zolder|verdieping|terras/i.test(x.naam) && !/\.md$/i.test(x.pad)).sort((a, b) => String(b.datum || '').localeCompare(String(a.datum || ''))).slice(0, 20)) {
    on.tekeningen.push(R(s.naam.replace(/\.\w+$/, ''), 'stuk in het dossier', s.datum && s.datum.length === 10 ? s.datum : null, { pad: s.pad }));
  }
  for (const s of ((extra && extra.bouwdossier) || []).slice(0, 12)) on.tekeningen.push(R(s.naam.replace(/\.\w+$/, '') + ' (bouwdossier gemeente)', 'stuk in het dossier', s.datum || null, { pad: s.pad }));
  // hoogtes
  for (const [g, veld] of [['ahn', 'Maaiveld rond het adres'], ['3dbag', 'Maaiveld (3D-BAG)']]) { const f = fe.find((x) => x.groep === g && x.veld === veld); if (f) on.hoogtes.push(extern(f)); }
  const fmMv = ((w.fundermaps || {}).regels || []).find((x) => /maaiveld/i.test(x));
  if (fmMv) on.hoogtes.push(R(fmMv, (w.fundermaps.kop || 'Funderingsrisicorapport') , w.fundermaps.datum, dk(WP)));
  if (k.kelderbak) on.hoogtes.push(R(k.kelderbak.tekst, 'kelderpagina (bouwplan)', k.kelderbak.datum, dk(KP)));
  if (on.hoogtes.length > 1) on.hoogtes.push(R('De bronnen meten het maaiveld elk op hun eigen manier en plek; de verschillen staan hier naast elkaar, niet verrekend.', 'Socev', null, { noot: true }));
  // grondwater
  const fmGw = ((w.fundermaps || {}).regels || []).find((x) => /grondwater/i.test(x));
  if (fmGw) on.grondwater.push(R(fmGw, (w.fundermaps.kop || 'Funderingsrisicorapport'), w.fundermaps.datum, dk(WP)));
  const nPut = fe.find((x) => x.groep === 'bro' && /^Grondwaterputten binnen/.test(x.veld));
  if (nPut) on.grondwater.push(R(`${nPut.waarde} grondwaterputten in de BRO binnen 1 km; hieronder de dichtstbijzijnde.`, nPut.bron, String(nPut.opgehaald || '').slice(0, 10), { extern: true }));
  const reeks = (o.reeksen || []).filter((r) => r.reeks === 'grondwater');
  for (const f of fe.filter((x) => x.groep === 'bro' && /^Grondwaterput GMW/.test(x.veld))) {
    const put = f.veld.replace(/^Grondwaterput /, '');
    on.grondwater.push(Object.assign(extern(f), { put }));
    const m = fe.find((x) => x.groep === 'gld' && x.veld === 'Meetreeks grondwaterput ' + put);
    if (m) {
      const pr = reeks.filter((r) => r.toelichting === put);
      on.grondwater.push(Object.assign(extern(m), { put, meetreeks: true, maanden: pr.map((r) => [r.peildatum.slice(0, 7), r.waarde]) }));
    }
  }
  if (nPut && !fe.some((x) => x.groep === 'gld')) on.grondwater.push(R('Meetreeksen van deze putten zijn nog niet opgehaald; dat gebeurt bij de volgende maandelijkse ronde.', 'Socev', null, { noot: true }));
  // sonderingen
  const nS = fe.find((x) => x.groep === 'bro' && /^Sonderingen binnen/.test(x.veld));
  if (nS && String(nS.waarde).trim() === '0' && bs.bro && bs.bro.ok) {
    on.sonderingen.push(R(`Binnen 500 m ligt geen openbare sondering (BRO, opgehaald ${nlDag(String(nS.opgehaald || '').slice(0, 10))}): die moet sowieso zelf gemaakt worden.`, nS.bron, String(nS.opgehaald || '').slice(0, 10), { kern: true, extern: true }));
  } else if (nS) {
    on.sonderingen.push(extern(nS));
    for (const f of fe.filter((x) => x.groep === 'bro' && /^Sondering CPT/.test(x.veld))) on.sonderingen.push(extern(f));
  } else on.sonderingen.push(R('Nog niet opgehaald uit de BRO.', 'Socev', null, { noot: true }));
  for (const z of (k.sondering || []).slice(0, 4)) on.sonderingen.push(R(z.tekst, 'kelderpagina', z.datum, dk(KP)));
  // bestemming
  if (w.bestemming) {
    if (w.bestemming.plan) on.bestemming.push(R(w.bestemming.plan, 'woningpagina § Bestemmingsplan', w.bestemming.datum || w.bijgewerkt, dk(WP)));
    for (const x of w.bestemming.regels) on.bestemming.push(R(x, 'woningpagina § Bestemmingsplan', w.bestemming.datum || w.bijgewerkt, dk(WP)));
  }
  for (const f of fe.filter((x) => x.groep === 'plannen').slice(0, 6)) on.bestemming.push(extern(f));
  // fundering
  const fd = (o.feiten || []).find((f) => f.herkomst === 'dossier' && f.veld === 'Fundering');
  if (fd) on.fundering.push(R(`Fundering: ${fd.waarde}`, 'woningpagina (kerngegevens)', w.bijgewerkt, dk(WP)));
  for (const x of ((w.fundermaps || {}).regels || []).filter((y) => !/maaiveld|grondwater/i.test(y))) on.fundering.push(R(x, (w.fundermaps.kop || 'Funderingsrisicorapport'), w.fundermaps.datum, dk(WP)));
  for (const f of fe.filter((x) => x.groep === 'fundering')) on.fundering.push(extern(f));
  const onderdelen = KELDER_ONDERDELEN.map(([id, t]) => ({ id, titel: t, regels: on[id] }));
  return { ok: true, pagina: KP || null, status: k.status || null, onderdelen, leeg: onderdelen.filter((x) => !x.regels.length).map((x) => x.titel) };
}
function kelderMd(d, naam, opIso) {
  const r = [`# Kelderdossier${naam ? ' — ' + naam : ''}`, '', `*Samengesteld door Socev uit het huisdossier en openbare bronnen op ${nlDag(String(opIso || '').slice(0, 10))}. Elke regel met bron en datum.*`, ''];
  for (const o of d.onderdelen) {
    r.push(`## ${o.titel}`, '');
    if (!o.regels.length) r.push('- *Niets in het dossier.*');
    for (const x of o.regels) r.push(`- ${x.tekst.replace(/\n/g, ' ')} *(${[x.bron, x.datum ? nlDag(x.datum) : (x.noot ? null : 'datum onbekend')].filter(Boolean).join(', ')})*`);
    r.push('');
  }
  return r.join('\n');
}
// ── zelf verversen: kenmerken en vergelijken (review Codex MOET 1: een meetreeks telt alleen met zijn uitersten en meetjaren) ──
const KENMERK_GELD = new Set(['bank', 'tibber', 'hypotheek']);
const r5 = (v) => Math.round(Number(v) * 20) / 20;
function fnv(t) {   // korte vaste sleutel zonder crypto (CI-poort: alleen fs, path, node:sqlite): twee FNV-1a-rondes van 32 bit
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x9e3779b9;
  for (const c of String(t)) { const k = c.codePointAt(0); a = Math.imul(a ^ k, 0x01000193) >>> 0; b = Math.imul(b ^ k, 0x01000193 ^ 0x2545f491) >>> 0; }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
function kenmerken(ov, kelder) {   // → { sleutel: { tekst, soort, object } }; alleen groepen die in de laatste ronde lukten
  const uit = {};
  for (const o of (ov && ov.objecten) || []) {
    if (o.weg_op) continue;
    const bs = o.bron_stand || {};
    for (const f of o.feiten || []) {
      if (f.herkomst !== 'extern' || f.soort === 'meetreeks' || !f.groep || !(bs[f.groep] && bs[f.groep].ok)) continue;
      if (f.groep === 'gld' || f.groep === 'sru') continue;   // wv4226: bekendmakingen meldt de buurtwachter (op id), niet de maandelijkse postcodelijst
      uit[`f:${o.sleutel}:${f.groep}:${f.veld}`] = { tekst: String(f.waarde), soort: 'openbaar', object: o.sleutel, veld: f.veld, groep: f.groep };
    }
    for (const s of o.stukken || []) uit[`s:${o.sleutel}:${s.pad}`] = { tekst: s.naam, soort: 'stuk', object: o.sleutel };
    if (bs.gld && bs.gld.ok) {
      const per = {};
      for (const r of (o.reeksen || []).filter((x) => x.reeks === 'grondwater' && x.toelichting)) (per[r.toelichting] = per[r.toelichting] || []).push(r);
      for (const [put, rs] of Object.entries(per)) {
        const w = rs.map((r) => r.waarde);
        const jaren = new Set(rs.map((r) => r.peildatum.slice(0, 4))).size;
        uit[`m:${o.sleutel}:${put}`] = { tekst: `hoogste ${r5(Math.max(...w)).toFixed(2)} · laagste ${r5(Math.min(...w)).toFixed(2)} · ${jaren} jaar`, soort: 'meetreeks', object: o.sleutel, put };
      }
    }
  }
  if (kelder && kelder.onderdelen) for (const od of kelder.onderdelen) {
    const vast = od.regels.filter((x) => !x.extern && !x.noot).map((x) => `${x.tekst}|${x.bron}|${x.datum || ''}`);   // openbare regels (extern, ook de afgeleide zinnen) en meetreeksen tellen hierboven al, met de storingsregel
    uit[`k:${od.id}`] = { tekst: vast.join('\n'), soort: 'kelder', object: 'woning', titel: od.titel };
  }
  return uit;
}
function vergelijk(oud, nieuw) {   // → [{ sleutel, soort, object, tekst }] (tekst zonder bedragen; ≤ 200 tekens)
  const uit = [];
  const kort = (t) => String(t || '').replace(/\s+/g, ' ').slice(0, 120);
  for (const [s, n] of Object.entries(nieuw)) {
    const o = oud[s];
    if (o && o.tekst === n.tekst) continue;
    let t;
    if (n.soort === 'stuk') { if (o) continue; t = `Nieuw stuk: ${kort(n.tekst)}`; }
    else if (n.soort === 'meetreeks') t = o ? `Grondwaterput ${n.put}: ${o.tekst} → ${n.tekst} (m NAP, maandgemiddelden)` : null;
    else if (n.soort === 'kelder') t = o ? `Kelderdossier, ${n.titel}: aangepast` : null;
    else t = o ? `${n.veld} (${GROEP_NAAM[n.groep] || n.groep}): ${kort(o.tekst)} → ${kort(n.tekst)}` : `Nieuw in ${GROEP_NAAM[n.groep] || n.groep}: ${n.veld}: ${kort(n.tekst)}`;
    if (t) uit.push({ sleutel: s, soort: n.soort, object: n.object, tekst: t.slice(0, 200) });
  }
  for (const [s, o] of Object.entries(oud)) {
    if (nieuw[s]) continue;
    if (o.soort === 'stuk') uit.push({ sleutel: s, soort: 'stuk', object: o.object, tekst: `Stuk niet meer in het dossier: ${kort(o.tekst)}`.slice(0, 200) });
  }
  return uit;
}
// Overneemregel voor een bron die deze ronde mislukte: zijn vorige kenmerken blijven staan (een storing is nooit een wijziging)
function kenmerkenMetOud(nieuw, oud, ov) {
  const mislukt = new Set();
  for (const o of (ov && ov.objecten) || []) for (const [g, x] of Object.entries(o.bron_stand || {})) if (x && x.ok === false) mislukt.add(`${o.sleutel}:${g}`);
  const uit = Object.assign({}, nieuw);
  for (const [s, x] of Object.entries(oud || {})) {
    if (uit[s]) continue;
    if ((x.soort === 'openbaar' && mislukt.has(`${x.object}:${x.groep}`)) || (x.soort === 'meetreeks' && mislukt.has(`${x.object}:gld`))) uit[s] = x;
  }
  return uit;
}
function wijzigingBericht(w, sinds) {
  if (!w.length) return null;
  const bu = w.filter((x) => x.soort === 'buurt'), rest = w.filter((x) => x.soort !== 'buurt');
  // wv4226: bekendmakingen bij het huis = één regel met de link van de nieuwste; de rest van de ronde zoals voorheen
  const buurt = !bu.length ? '' : bu.length === 1 ? `${bu[0].tekst.slice(0, 200)}${bu[0].url ? ' ' + bu[0].url : ''}`
    : `${bu.length} nieuwe bekendmakingen bij je huis, o.a. ${bu[0].tekst.replace(/^[^:]*:\s*/, '').slice(0, 140)}${bu[0].url ? ' ' + bu[0].url : ''}`;
  if (!rest.length) return `Vastgoed: ${buurt}${bu.length > 1 ? '. Zie Vastgoed › Overzicht.' : ''}`;
  const k = rest.some((x) => x.soort === 'kelder' || x.object === 'woning') ? 'Kelder' : 'Overzicht';
  return `Vastgoed: ${rest.length === 1 ? 'één ding' : rest.length + ' dingen'} veranderd${sinds ? ' sinds ' + nlDag(sinds.slice(0, 10)) : ''} (${rest[0].tekst.slice(0, 110)}${rest.length > 1 ? ' …' : ''}). Zie Vastgoed › ${k}.${buurt ? ' En: ' + buurt : ''}`;
}
// wv4226: wat de buurtwachter teruggaf → nieuwe rijen (nog niet in de tabel) per bron; pure functie (toets)
function buurtNieuw(r, gezien) {
  const uit = [];
  for (const bron of ['straal', 'gemeente']) {
    const g = r && r[bron];
    if (!g || g.ok !== true || !Array.isArray(g.items)) continue;
    for (const i of g.items) {
      if (!i || typeof i.id !== 'string' || !/^[a-z]{2,10}-\d{4}-\d{1,10}$/.test(i.id) || !i.titel || gezien.has(i.id)) continue;
      gezien.add(i.id);
      const titel = String(i.titel).replace(/\s+/g, ' ').trim().slice(0, 300);
      let datum = null; try { datum = isoGoed(i.datum) ? i.datum : null; } catch (e) { datum = null; }   // isoGoed gooit bij maand 13
      const url = typeof i.url === 'string' && BM_URL.test(i.url) ? i.url : null;
      const tekst = (bron === 'gemeente' ? 'Plan van de gemeente: ' : 'Bekendmaking bij je huis: ') + titel.slice(0, 160) + (datum ? ` (${nlDag(datum)})` : '');
      uit.push({ id: i.id, bron, datum, titel, rubriek: i.rubriek ? String(i.rubriek).slice(0, 80) : null, url, tekst });
    }
  }
  return uit;
}

// ── wv4228 (besluitenpagina nr 940 = L40): "Nu en binnenkort" bovenaan Vastgoed — Loopt nu, Binnenkort, Nieuw ──
// Puur. Bronnen: de huispagina's (status lopend → Loopt nu; "## Toekomstige data" en ALV-data → Binnenkort), de rentevaste datum uit geld_kern
// en de WOZ (seintje eind februari, of de bezwaartermijn van een bevestigde beschikking). Binnenkort = vandaag t/m BK_HORIZON_JAAR vooruit.
const BK_HORIZON_JAAR = 10, BK_MAX = 6, LOOPT_MAX = 4;
const BK_WOORD = { energielabel: /energielabel/i, alv: /\bALV\b|ledenvergadering/i, rentevast: /rentevast|renteherziening/i, woz: /\bWOZ\b/ };
function laatsteZin(t) { const z = String(t || '').split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/).map((s) => s.trim()).filter(Boolean); return z.length ? z[z.length - 1] : null; }
function looptUit(md, pagina) {
  if (!/^(lopend|loopt)$/i.test(frontVeld(md, 'status') || '')) return null;
  const naam = (titel(md) || String(pagina).split('/').pop().replace(/\.md$/, '')).replace(/\s+[—–]\s+.*$/, '').trim();
  const upd = frontVeld(md, 'updated');
  // de laatste alinea die met **Besluit, **Open:, **Volgende stap of **Wacht begint: de laatste zin daarvan is "waar het nu op wacht"
  const alineas = String(md || '').split(/\n\s*\n/).filter((a) => /^\*\*(Besluit|Open|Volgende stap|Wacht)\b/.test(a.trim()));
  const stand = alineas.length ? laatsteZin(kaalMd(alineas[alineas.length - 1].replace(/^\*\*(Open|Volgende stap|Wacht)[^*]*\*\*:?\s*/, ''))) : null;
  return { naam: naam.slice(0, 80), pagina, sinds: isoVeilig(upd || '') ? upd : null, stand: stand ? stand.slice(0, 240) : null, kelder: /^Kelder\b/i.test(naam) };
}
function toekomstUit(md, object) {   // "## Toekomstige data" → "- **6-11-2028:** tekst"
  const s = kopSectie(md, /^##\s+Toekomstige data/i);
  if (!s) return [];
  const uit = [];
  for (const r of opsomming(s.tekst)) {
    const m = /^(\d{1,2})-(\d{1,2})-(\d{4}):?\s*(.+)$/.exec(r);
    const d = m && isoZeker(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!d) continue;
    const tekst = m[4].replace(/^[a-z]/, (c) => c.toUpperCase()).split(/(?<=\.)\s+/)[0].slice(0, 200);
    uit.push({ datum: d, tekst, soort: BK_WOORD.energielabel.test(tekst) ? 'energielabel' : 'toekomst', object });
  }
  return uit;
}
function alvUit(md, object) {   // een zin met ALV/ledenvergadering en een datum d-m-jjjj (ook een vooraankondiging); per datum één keer
  const uit = [];
  for (const zin of kaalMd(String(md || '').replace(/^---[\s\S]*?\n---\n/, '')).split(/(?<=[.!?])\s+/)) {
    if (!BK_WOORD.alv.test(zin)) continue;
    const m = /\b(\d{1,2})-(\d{1,2})-(\d{4})\b/.exec(zin);
    const d = m && isoZeker(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!d || uit.some((x) => x.datum === d)) continue;
    const uur = /\bom\s+(\d{1,2}[:.]\d{2})\b/.exec(zin);
    uit.push({ datum: d, tekst: `${/digita/i.test(zin) ? 'Digitale ALV' : 'ALV'} van de VvE van de garageboxen${uur ? ', ' + uur[1].replace('.', ':') + ' uur' : ''}`, soort: 'alv', object });
  }
  return uit;
}
function wozBinnenkort(vandaag, eigen) {   // eigen: [{ object, naam, jaar, dagtekening }] (bevestigde beschikkingen)
  const uit = [];
  for (const w of eigen || []) {
    const tot = bezwaarTot(w.dagtekening);
    if (tot && tot >= vandaag) uit.push({ datum: tot, tekst: `Bezwaar tegen de WOZ ${w.jaar} van ${w.naam} kan tot en met deze dag`, soort: 'woz-bezwaar', object: w.object });
  }
  const j0 = Number(vandaag.slice(0, 4));
  const j = vandaag <= `${j0}-03-31` && !(eigen || []).some((w) => w.soort === 'woning' && Number(w.jaar) === j0) ? j0 : j0 + 1;
  uit.push({ datum: `${j}-02-28`, wanneer: `eind februari ${j}`, tekst: `WOZ-beschikkingen ${j} staan klaar bij de gemeente; bezwaar kan zes weken na de dagtekening`, soort: 'woz', jaar: j, object: 'woning' });
  return uit;
}
// paginas: [{ pad, md, object? }]; kern = geld_kern van de woning; eigen = bevestigde WOZ-beschikkingen; nieuw = wijzigingen sinds je vorige bezoek
function nuEnBinnenkort(x) {
  const vandaag = x.vandaag, tot = `${Number(vandaag.slice(0, 4)) + BK_HORIZON_JAAR}${vandaag.slice(4)}`;
  const loopt = [], bk = [];
  for (const p of x.paginas || []) {
    const l = looptUit(p.md, p.pad); if (l) loopt.push(l);
    bk.push(...toekomstUit(p.md, p.object || null));
    if (/garage|box/i.test(p.pad)) bk.push(...alvUit(p.md, p.object || null));
  }
  const rv = x.kern && x.kern.rentevast;
  if (rv && isoVeilig(rv.datum || '')) bk.push({ datum: rv.datum, tekst: 'De rentevaste periode van de hypotheek loopt af (eerste deel)', soort: 'rentevast', object: 'woning' });
  bk.push(...wozBinnenkort(vandaag, x.eigen));
  const gezien = new Set();
  const binnenkort = bk.filter((b) => b.datum >= vandaag && b.datum <= tot).sort((a, b) => a.datum.localeCompare(b.datum))
    .filter((b) => { const k = b.soort + b.datum; if (gezien.has(k)) return false; gezien.add(k); return true; }).slice(0, BK_MAX);
  loopt.sort((a, b) => (b.kelder - a.kelder) || String(b.sinds || '').localeCompare(String(a.sinds || '')));
  return { loopt: loopt.slice(0, LOOPT_MAX), binnenkort, nieuw: (x.nieuw || []).length, nieuw_aantal: Number.isInteger(x.nieuw_aantal) ? x.nieuw_aantal : (x.nieuw || []).length };
}
// Regels voor het deadline-register (zelfde vorm en idempotentie als wozDeadlineRegels; deadlineErbij zet ze). De WOZ gebruikt de sleutel van
// het seintje (wv4229), de bezwaartermijn zet woz-bewaar zelf. Een regel die er al met de hand staat (zelfde datum en hetzelfde woord, ook onder
// Afgehandeld) komt er niet nog eens bij: binnenkortNodig.
const BK_ACTIE = {
  energielabel: ['[jij] alleen nodig als je gaat verkopen of verhuren: dan een nieuw label laten opnemen', 60],
  alv: ['[jij] beslissen of je meedoet of iemand een volmacht geeft', 14],
  rentevast: ['[jij] op tijd een renteaanbod vragen en vergelijken', 120],
  toekomst: ['[jij] nagaan of er iets moet gebeuren', 30],
};
function binnenkortRegels(binnenkort) {
  const cel = (t) => String(t).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const uit = [];
  for (const b of binnenkort || []) {
    if (b.soort === 'woz') { uit.push({ sleutel: `vastgoed-woz-seintje-${b.jaar}`, regel: wozSeintjeRegel(b.jaar), datum: `${b.jaar}-03-31`, soort: 'woz' }); continue; }
    const a = BK_ACTIE[b.soort]; if (!a) continue;
    const sl = `vastgoed-${b.soort}-${b.datum}`;
    uit.push({ sleutel: sl, datum: b.datum, soort: b.soort, regel: `| ${b.datum} | Privé / Huis | **${cel(b.tekst).replace(/\.$/, '')} (${NL_DAG(b.datum)}).** Staat ook in Apps › Vastgoed › Binnenkort. | ${a[0]} | ${a[1]} | Vastgoed (${sl}) |` });
  }
  return uit;
}
function binnenkortNodig(tekst, regels) {
  const rg = String(tekst || '').split('\n').filter((r) => r.startsWith('|'));
  return regels.filter((r) => {
    const w = BK_WOORD[r.soort];
    return !(w && rg.some((x) => x.startsWith(`| ${r.datum} |`) && !x.includes(`(${r.sleutel})`) && w.test(x)));
  });
}

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
      if (!db.prepare("SELECT 1 FROM pragma_table_info('object') WHERE name = 'weg_op'").get()) db.exec('ALTER TABLE object ADD COLUMN weg_op TEXT');   // A15
      for (const k of ['dagtekening', 'maten', 'concept_op']) if (!db.prepare("SELECT 1 FROM pragma_table_info('woz_eigen') WHERE name = ?").get(k)) db.exec(`ALTER TABLE woz_eigen ADD COLUMN ${k} TEXT`);   // wv4229
      if (!db.prepare("SELECT 1 FROM pragma_table_info('wijziging') WHERE name = 'url'").get()) db.exec('ALTER TABLE wijziging ADD COLUMN url TEXT');   // wv4226
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
    const d = leesDossierMap(vault, nu());
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
          woz_nr = excluded.woz_nr, zoek = excluded.zoek, volgorde = excluded.volgorde, dossier_op = excluded.dossier_op, weg_op = NULL`)
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
        geld.hypotheek = { ok: true, op, delen: d.hypotheek.delen.length, reden: d.hypotheek.bank_afwijking || null };
      } else geld.hypotheek = { ok: false, op, reden: d.hypotheek ? 'geen tabel Leningdelen op de hypotheekpagina' : 'geen hypotheekpagina gevonden' };
      geld.holding = d.holding ? Object.assign({ ok: true, op }, d.holding) : { ok: false, op, reden: 'de lening van de Holding is niet te lezen (DGA-json)' };
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
      // objecten die niet meer in het dossier staan (pagina weg of hernoemd). A15: nooit vanzelf wissen wat niet uit het dossier komt
      // (openbare feiten, beelden, een door David bevestigde WOZ, leningdelen): zo'n object krijgt weg_op en blijft staan tot iemand het opruimt.
      // Alleen een object zonder zulke gegevens gaat weg.
      const nog = Object.values(ids);
      let weg = 0;
      for (const r of db.prepare('SELECT id, weg_op FROM object').all()) if (!nog.includes(r.id)) {
        const bewaart = [["feit", " AND herkomst = 'extern'"], ['beeld', ''], ['woz_eigen', ''], ['leningdeel', '']]
          .some(([t, w]) => db.prepare(`SELECT 1 FROM ${t} WHERE object = ?${w} LIMIT 1`).get(r.id));
        if (bewaart) { db.prepare('UPDATE object SET weg_op = ?, volgorde = ? WHERE id = ?').run(r.weg_op || op, 1000 + r.id, r.id); weg++; continue; }
        for (const t of ['feit', 'reeks', 'gebeurtenis', 'beeld', 'leningdeel', 'woz_eigen']) db.prepare(`DELETE FROM ${t} WHERE object = ?`).run(r.id);
        db.prepare('UPDATE aanroep SET object = NULL WHERE object = ?').run(r.id);
        db.prepare('DELETE FROM object WHERE id = ?').run(r.id);
      }
      return { objecten: d.objecten.length, niet_in_dossier: weg, feiten: nf, reeksen: nr, gebeurtenissen: ng, stukken: d.stukken.length, verbouwkosten: nk,
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
    if (obj.soort === 'woning') invoer.meetreeks = true;   // wv4182: grondwaterstanden van de putten in de buurt (kelderdossier)
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
      // wv4182: maandgemiddelden grondwater per put; alleen vervangen als de groep gld lukte (anders blijven de vorige staan)
      if (groepen.gld === true && Array.isArray(u.meetreeksen)) {
        db.prepare(`DELETE FROM reeks WHERE object = ? AND reeks = 'grondwater'`).run(obj.id);
        const gi = db.prepare(`INSERT INTO reeks (object, reeks, peildatum, waarde, eenheid, toelichting, bron, herkomst, opgehaald) VALUES (?, 'grondwater', ?, ?, 'm NAP', ?, 'BRO grondwaterstanden', 'extern', ?)`);
        for (const m of u.meetreeksen.slice(0, 5)) {
          if (!m || !/^GMW\d{12}$/.test(String(m.put || '')) || !m.maanden || typeof m.maanden !== 'object') continue;
          for (const [mnd, w] of Object.entries(m.maanden).slice(-600)) if (/^\d{4}-\d{2}$/.test(mnd) && Number.isFinite(w) && Math.abs(w) < 60) gi.run(obj.id, `${mnd}-15`, w, m.put, op);
        }
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
        const feiten = db.prepare('SELECT herkomst, rubriek, veld, waarde, peildatum, bron, licentie, url, soort, opgehaald, groep FROM feit WHERE object = ? ORDER BY herkomst, volgorde, id').all(obj.id);
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
        if (obj.weg_op) stand.ontbreekt.unshift(`Niet meer in het dossier sinds ${nlDag(obj.weg_op.slice(0, 10))}: de pagina is weg of hernoemd; wat hier staat blijft bewaard tot iemand het opruimt`);
        return { id: obj.id, sleutel: obj.sleutel, soort: obj.soort, naam: obj.naam, adres: obj.adres, dossier: obj.dossier, woz_nr: obj.woz_nr || null, vbo: JSON.parse(obj.vbo || '[]'),
          percelen: JSON.parse(obj.percelen || '[]'), punt: obj.punt ? JSON.parse(obj.punt) : null, bag_gemeten: obj.bag_gemeten ? JSON.parse(obj.bag_gemeten) : null,
          dossier_op: obj.dossier_op, weg_op: obj.weg_op || null, extern_op: obj.extern_op, bron_stand: (() => { try { return JSON.parse(obj.bron_stand || '{}'); } catch (e) { return {}; } })(), feiten, reeksen, stukken, gebeurtenissen, beelden, stand,
          indicatie: obj.soort === 'woning' ? indicatie(reeksen, index) : null, leningdelen,
          vve: obj.soort === 'garagebox' ? ((geld.bank || {}).boxen || {})[obj.sleutel] || null : null };
      });
      // wv4170 (2C54): restschuld, overwaarde (indicatie) en rentevast tot voor de woning, uit dezelfde leningdelen als het tabblad Waarde
      const won = objecten.find((x) => x.soort === 'woning');
      if (won) won.geld_kern = geldKern(won, objecten, geld.holding || null);
      const aanroepen = db.prepare('SELECT COUNT(*) AS n, MAX(tijd) AS laatst FROM aanroep').get();
      const kaal2 = (x) => (x ? { ok: !!x.ok, op: x.op || null, mislukt_op: x.mislukt_op || null, reden: x.reden || null } : null);
      const meta = (k) => (db.prepare('SELECT waarde FROM meta WHERE sleutel = ?').get(k) || {}).waarde || null;
      const heeftW = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wijziging'").get();   // wv4182: alleen-lezen vóór de eerste schrijfactie
      const gezienOp = meta('gezien_op');
      const metUrl = heeftW && !!db.prepare("SELECT 1 FROM pragma_table_info('wijziging') WHERE name = 'url'").get();   // wv4226: alleen-lezen vóór de migratie
      const nieuw = heeftW ? db.prepare(`SELECT op, object, soort, tekst${metUrl ? ', url' : ''} FROM wijziging WHERE op > ? ORDER BY id DESC LIMIT 20`).all(gezienOp || '').map((z) => (z.url ? z : { op: z.op, object: z.object, soort: z.soort, tekst: z.tekst })) : [];
      const nieuwAantal = heeftW ? db.prepare('SELECT COUNT(*) AS n FROM wijziging WHERE op > ?').get(gezienOp || '').n : 0;   // wv4228: de teller op de tegel
      const wozEigen = db.prepare("SELECT 1 FROM pragma_table_info('woz_eigen') WHERE name = 'dagtekening'").get()
        ? db.prepare('SELECT o.sleutel AS object, o.naam AS naam, o.soort AS soort, w.jaar AS jaar, w.dagtekening AS dagtekening FROM woz_eigen w JOIN object o ON o.id = w.object').all() : [];
      let ronde = null; try { ronde = JSON.parse(meta('ronde') || 'null'); } catch (e) { ronde = null; }
      return { ok: true, objecten, prijsindex: index ? { laatste: index.laatste, jaren: index.jaren } : null, aanroepen: { n: aanroepen.n, laatst: aanroepen.laatst },
        nieuw, nieuw_aantal: nieuwAantal, woz_eigen: wozEigen, gezien_op: gezienOp, ronde: ronde ? { dag: ronde.dag || null, op: ronde.op || null } : null, kelder_pdf_op: meta('kelder_pdf_op'),
        rubrieken: RUBRIEKEN, stuk_soorten: STUK_SOORT, geld: { hypotheek: kaal2(geld.hypotheek), verbouwing: kaal2(geld.verbouwing), bank: kaal2(geld.bank), tibber: kaal2(geld.tibber), holding: kaal2(geld.holding) } };
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
    // wv4229: dagtekening mag leeg; anders niet vóór 1-1 van het jaar vóór het belastingjaar en niet meer dan een week in de toekomst
    let dagtekening = null;
    if (b.dagtekening) {
      dagtekening = String(b.dagtekening);
      const morgen = new Date(nu().getTime() + 7 * 86400000).toISOString().slice(0, 10);
      if (!isoGoed(dagtekening) || dagtekening < `${jaar - 1}-01-01` || dagtekening > morgen) throw new Fout(400, 'de dagtekening klopt niet');
    }
    const obj = metDb((db) => db && db.prepare('SELECT id, naam, soort FROM object WHERE id = ?').get(id), false);
    if (!obj) throw new Fout(404, 'onbekend object');
    return { id, naam: obj.naam, soort: obj.soort, jaar, waarde, peildatum, dagtekening, stam: `WOZ-beschikking ${jaar} ${obj.naam}` };
  }
  // wv4229 (L41): de vergelijking voor het controlescherm en na bewaren (leest het overzicht; niets naar buiten)
  function wozVergelijk(x) {
    const ov = overzicht();
    const o = (ov.objecten || []).find((y) => y.id === Number(x && x.id));
    if (!o) throw new Fout(404, 'onbekend object');
    return wozVergelijkObject(o, x);
  }
  function wozVastleggen(c, stuk) {
    const x = wozControle(c);
    const pad = stuk && typeof stuk.pad === 'string' && stuk.pad.startsWith(BRONNEN + '/') && !stuk.pad.includes('..') ? stuk.pad : null;
    const sha = stuk && /^[a-f0-9]{64}$/.test(String(stuk.sha || '')) ? stuk.sha : null;
    // wv4229: de maten komen uit het stuk zelf (server.js geeft ze mee uit de eigen lezing, niet uit de app)
    const mt = stuk && stuk.maten && typeof stuk.maten === 'object' ? stuk.maten : {};
    const maten = {}; for (const k of ['wonen_m2', 'grond_m2']) if (Number.isInteger(mt[k]) && mt[k] > 0 && mt[k] < 100000) maten[k] = mt[k];
    metDb((db) => {
      db.prepare(`INSERT INTO woz_eigen (object, jaar, peildatum, waarde, pad, sha, bevestigd, dagtekening, maten, concept_op) VALUES (?,?,?,?,?,?,?,?,?,NULL)
        ON CONFLICT(object, jaar) DO UPDATE SET peildatum = excluded.peildatum, waarde = excluded.waarde, pad = excluded.pad, sha = excluded.sha, bevestigd = excluded.bevestigd,
          dagtekening = excluded.dagtekening, maten = excluded.maten, concept_op = NULL`)
        .run(x.id, x.jaar, x.peildatum, x.waarde, pad, sha, nuIso(), x.dagtekening, JSON.stringify(maten));
    }, true);
    leesDossier();
    return { id: x.id, jaar: x.jaar, vergelijk: wozVergelijk(Object.assign({}, x, { maten })) };
  }
  // wv4229 (L41): concept-bezwaar. Alleen voor een WOZ die David bevestigde (woz_eigen); elk getal en elke datum komt uit die rij, de reeks
  // van vorig jaar of een feit (review Codex MOET 1: geen taalmodel, geen vrije getallen). Geeft { aan, onderwerp, bericht } of een Fout.
  function wozBezwaar(b) {
    const id = Number(b && b.id), jaar = Number(b && b.jaar);
    if (!Number.isInteger(id) || id < 1 || !Number.isInteger(jaar)) throw new Fout(400, 'id en jaar ontbreken');
    const r = metDb((db) => db && db.prepare('SELECT * FROM woz_eigen WHERE object = ? AND jaar = ?').get(id, jaar), true);
    if (!r) throw new Fout(404, 'bewaar eerst de beschikking van dit jaar');
    if (r.concept_op && !(b && b.opnieuw === true)) throw new Fout(409, 'het concept staat al in Gmail (bij Concepten)');
    let maten = {}; try { maten = JSON.parse(r.maten || '{}') || {}; } catch (e) { maten = {}; }
    const v = wozVergelijk({ id, jaar, waarde: r.waarde, peildatum: r.peildatum, dagtekening: r.dagtekening, maten });
    const ov = overzicht();
    const o = ov.objecten.find((y) => y.id === id);
    const aan = wozLoketAdres(o, ov.objecten);
    if (!aan) throw new Fout(422, 'in het dossier staat geen mailadres van het WOZ-loket; zoek het op de beschikking');
    return { aan, onderwerp: `Bezwaar WOZ-beschikking ${jaar}${o.woz_nr ? ' (WOZ-objectnummer ' + o.woz_nr + ')' : ''}`.slice(0, 150), bericht: wozBezwaarTekst(v, o) };
  }
  function wozConceptGezet(id, jaar) {
    metDb((db) => { db.prepare('UPDATE woz_eigen SET concept_op = ? WHERE object = ? AND jaar = ?').run(nuIso(), Number(id), Number(jaar)); }, true);
  }
  // het mailadres van het WOZ-loket uit het dossier: een regel met "WOZ" en een mailadres (eerst een adres dat met woz begint), eerst op de
  // pagina van het object, anders op die van de woning. Niets in code: het adres staat in de vault.
  function wozLoketAdres(o, alle) {
    const zoek = (x) => {
      if (!x || !x.dossier) return null;
      let t = ''; try { t = fs.readFileSync(path.join(vault, x.dossier), 'utf8'); } catch (e) { return null; }
      const adr = [];
      for (const rg of t.split('\n')) if (/WOZ/.test(rg)) for (const m of rg.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,}/g)) adr.push(m[0].toLowerCase());
      return adr.find((a) => a.startsWith('woz')) || adr[0] || null;
    };
    return zoek(o) || zoek((alle || []).find((y) => y.soort === 'woning'));
  }

  // ── wv4182: kelderdossier, zelf verversen en "nieuw sinds je vorige bezoek" ──
  function leesTekst(rel) { try { return fs.readFileSync(path.join(vault, rel), 'utf8'); } catch (e) { return ''; } }
  function kelder(ovIn) {
    const ov = ovIn || overzicht();
    const won = (ov.objecten || []).find((x) => x.soort === 'woning' && !x.weg_op);
    if (!won) throw new Fout(404, 'geen woning in het dossier');
    let namen = []; try { namen = fs.readdirSync(path.join(vault, HUIS)).filter((n) => /^Kelder\b.*\.md$/i.test(n)).sort(); } catch (e) { namen = []; }
    const kp = namen.length ? `${HUIS}/${namen[0]}` : null;
    const l = leesKelder(kp ? leesTekst(kp) : '', leesTekst(won.dossier));
    // constructie en doorsnede uit een opgevraagd bouwdossier (submap in de bronnen; alleen de namen)
    const bouwdossier = [];
    try {
      for (const d of fs.readdirSync(path.join(vault, BRONNEN), { withFileTypes: true }).filter((x) => x.isDirectory() && /^Bouwdossier\b/i.test(x.name)).slice(0, 3)) {
        for (const n of fs.readdirSync(path.join(vault, BRONNEN, d.name)).filter((x) => /\.pdf$/i.test(x) && /begane grond|fundering|palen|doorsnede/i.test(x)).sort().slice(0, 12)) bouwdossier.push({ naam: n, pad: `${BRONNEN}/${d.name}/${n}`, datum: null });
      }
    } catch (e) { /* geen bouwdossier */ }
    const d = kelderDossier(won, l, { kelder: kp, woning: won.dossier }, { bouwdossier });
    d.object = { id: won.id, naam: won.naam };
    d.md = kelderMd(d, won.naam, nu().toISOString());
    return d;
  }
  function metaLees(db, k) { return (db.prepare('SELECT waarde FROM meta WHERE sleutel = ?').get(k) || {}).waarde || null; }
  function metaZet(db, k, v) { db.prepare('INSERT INTO meta (sleutel, waarde) VALUES (?, ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde').run(k, v); }
  // De dagelijkse ronde (server.js roept hem aan: hoofdpod, 07–22 u, eens per dag). Leest het dossier (lokaal), haalt openbare gegevens op
  // voor een object waarvan ze ouder zijn dan 30 dagen, vergelijkt met de vorige momentopname en legt wijzigingen + nieuwe momentopname
  // + een nog te versturen melding in één transactie vast (review Codex MOET 2). Eerste ronde = nulpunt: niets gemeld.
  async function ronde(opt) {
    const x = opt || {};
    const t0 = nu();
    try { leesDossier(); } catch (e) { /* de vorige stand blijft; vergelijken kan nog */ }
    const opgehaald = [];
    if (bronnen && x.extern !== false) {
      const ov0 = overzicht();
      for (const o of (ov0.objecten || []).filter((y) => !y.weg_op)) {
        const zonderReeks = o.soort === 'woning' && !(o.bron_stand && o.bron_stand.gld);   // meetreeksen nog nooit opgehaald: meteen (één keer)
        if (!zonderReeks && o.extern_op && t0.getTime() - new Date(o.extern_op).getTime() < RONDE_MAAND_MS) continue;
        try { const r = await ververs(o.id); opgehaald.push({ id: o.id, geslaagd: !!r.geslaagd }); } catch (e) { opgehaald.push({ id: o.id, geslaagd: false }); }
      }
    }
    const ov = overzicht();
    let kel = null; try { kel = kelder(ov); } catch (e) { kel = null; }
    const bw = bronnen && x.extern !== false ? await buurtHaal(ov, t0) : null;   // wv4226
    const op = nu().toISOString();
    return metDb((db) => {
      let oud = null; try { oud = JSON.parse(metaLees(db, 'kenmerken') || 'null'); } catch (e) { oud = null; }
      const nieuwK = kenmerkenMetOud(kenmerken(ov, kel), oud || {}, ov);
      const w = oud ? vergelijk(oud, nieuwK) : [];
      const bwUit = bw ? buurtBewaar(db, bw, op) : null;   // wv4226: nieuwe bekendmakingen (na het nulpunt) bij de wijzigingen
      if (bwUit) w.push(...bwUit.meld);
      const wi = db.prepare('INSERT INTO wijziging (op, object, soort, sleutel, tekst, url) VALUES (?,?,?,?,?,?)');
      for (const y of w.slice(0, 100)) wi.run(op, y.object || null, y.soort, y.sleutel.slice(0, 300), y.tekst, y.url || null);
      db.prepare('DELETE FROM wijziging WHERE op < ?').run(new Date(t0.getTime() - WIJZIGING_DAGEN * 86400000).toISOString());
      metaZet(db, 'kenmerken', JSON.stringify(nieuwK));
      const vorige = (() => { try { return JSON.parse(metaLees(db, 'ronde') || 'null'); } catch (e) { return null; } })();
      const tekst = wijzigingBericht(w, vorige && vorige.op);
      if (tekst) metaZet(db, 'melding_open', JSON.stringify({ tekst, sleutel: fnv(op + tekst), op }));
      const kelHash = kel ? fnv(JSON.stringify(Object.entries(nieuwK).filter(([k]) => k.startsWith('k:') || k.startsWith('m:woning') || k.startsWith('f:woning:')))) : null;
      const pdfOp = metaLees(db, 'kelder_pdf_op'), pdfHash = metaLees(db, 'kelder_pdf_hash');
      const pdfNodig = !!kel && (!pdfOp || t0.getTime() - new Date(pdfOp).getTime() > KELDER_PDF_MS || pdfHash !== kelHash);
      metaZet(db, 'ronde', JSON.stringify({ dag: x.dag || op.slice(0, 10), op, nulpunt: !oud, wijzigingen: w.length, opgehaald: opgehaald.length, mislukt: opgehaald.filter((y) => !y.geslaagd).length }));
      return { nulpunt: !oud, wijzigingen: w.length, melding: !!tekst, opgehaald: opgehaald.length, pdf_nodig: pdfNodig, kelder_hash: kelHash,
        buurt: bwUit ? { gevraagd: true, nieuw: bwUit.nieuw, gemeld: bwUit.meld.length } : { gevraagd: false } };
    }, true);
  }
  // wv4226: is de buurtwachter aan de beurt (per bron eens per week na de laatste gelukte vraag), en zo ja: vragen. Nooit een fout naar boven.
  function buurtStand(db) { try { return JSON.parse(metaLees(db, 'buurt') || 'null') || {}; } catch (e) { return {}; } }
  async function buurtHaal(ov, t0) {
    const won = ((ov && ov.objecten) || []).find((o) => o.soort === 'woning' && !o.weg_op);
    const rd = won && won.punt && Array.isArray(won.punt.rd) ? won.punt.rd : null;
    const gf = won && (won.feiten || []).find((f) => f.herkomst === 'extern' && f.groep === 'ls' && f.veld === 'Gemeente');
    const gemeente = gf ? String(gf.waarde) : null;
    if (!rd && !gemeente) return null;
    const st = metDb((db) => (db ? buurtStand(db) : {}), false);
    const due = (k) => !st[k] || t0.getTime() - new Date(st[k]).getTime() >= BUURT_WEEK_MS;
    const vraag = { rd: rd && due('straal_op') ? rd : null, gemeente: gemeente && due('gemeente_op') ? gemeente : null };
    if (!vraag.rd && !vraag.gemeente) return null;
    const basis = [vraag.rd && st.straal_op, vraag.gemeente && st.gemeente_op].filter(Boolean).map((z) => new Date(z).getTime());
    const sindsMs = basis.length === [vraag.rd, vraag.gemeente].filter(Boolean).length && basis.length ? Math.min(...basis) - BUURT_OVERLAP_DAGEN * 86400000
      : t0.getTime() - BUURT_EERST_DAGEN * 86400000;
    const sinds = new Date(sindsMs).toISOString().slice(0, 10);
    let r = null;
    try { r = await bronnen({ buurt: { rd: vraag.rd || undefined, km: BUURT_KM, gemeente: vraag.gemeente || undefined, sinds } }); } catch (e) { r = null; }
    const b = r && r.ok === true && r.buurt && typeof r.buurt === 'object' ? r.buurt : {};
    return { won, vraag, b, aanroepen: (r && Array.isArray(r.aanroepen)) ? r.aanroepen : [] };
  }
  function buurtBewaar(db, bw, op) {
    const st = buurtStand(db);
    const ai = db.prepare('INSERT INTO aanroep (tijd, object, bron, host, naar_buiten, status, ms) VALUES (?,?,?,?,?,?,?)');
    for (const a of bw.aanroepen.slice(0, 20)) ai.run(op, bw.won.id, String(a.bron || '').slice(0, 120), String(a.host || '').slice(0, 120), String(a.naar_buiten || '').slice(0, 200), String(a.status || '').slice(0, 20), Number(a.ms) || 0);
    const gezien = new Set(db.prepare('SELECT id FROM bekendmaking').all().map((z) => z.id));
    const nieuw = buurtNieuw(bw.b, gezien);
    const bi = db.prepare('INSERT OR IGNORE INTO bekendmaking (id, object, bron, datum, titel, rubriek, url, eerst_op) VALUES (?,?,?,?,?,?,?,?)');
    const meld = [];
    for (const n of nieuw) {
      if (bi.run(n.id, bw.won.sleutel, n.bron, n.datum, n.titel, n.rubriek, n.url, op).changes !== 1) continue;
      // nulpunt per bron: de eerste gelukte vraag vult alleen de tabel
      if (st[n.bron + '_op']) meld.push({ sleutel: 'b:' + n.id, soort: 'buurt', object: bw.won.sleutel, tekst: n.tekst.slice(0, 200), url: n.url });
    }
    for (const k of ['straal', 'gemeente']) {
      const gevraagd = k === 'straal' ? !!bw.vraag.rd : !!bw.vraag.gemeente;
      if (!gevraagd) continue;
      if (bw.b[k] && bw.b[k].ok === true) { st[k + '_op'] = op; st[k + '_vol'] = Number(bw.b[k].n) > 50; } else st[k + '_mislukt'] = op;
    }
    st.op = op;
    metaZet(db, 'buurt', JSON.stringify(st));
    return { nieuw: nieuw.length, meld };
  }
  function rondeDag() { return metDb((db) => { if (!db) return null; try { return (JSON.parse(metaLees(db, 'ronde') || 'null') || {}).dag || null; } catch (e) { return null; } }, false); }
  function meldingOpen() { return metDb((db) => { if (!db) return null; try { return JSON.parse(metaLees(db, 'melding_open') || 'null'); } catch (e) { return null; } }, false); }
  function meldingVerstuurd(sleutel) {
    metDb((db) => { const m = (() => { try { return JSON.parse(metaLees(db, 'melding_open') || 'null'); } catch (e) { return null; } })(); if (m && m.sleutel === sleutel) db.prepare("DELETE FROM meta WHERE sleutel = 'melding_open'").run(); }, true);
  }
  function kelderPdfGezet(hash) { metDb((db) => { metaZet(db, 'kelder_pdf_op', nu().toISOString()); if (hash) metaZet(db, 'kelder_pdf_hash', hash); }, true); }
  function gezien() { metDb((db) => { metaZet(db, 'gezien_op', nu().toISOString()); }, true); return { ok: true }; }

  async function app(v) {
    const pad = String(v.pad || ''), post = v.methode === 'POST', body = v.body && typeof v.body === 'object' ? v.body : {};
    const idUit = () => { const id = Number(body.id); if (!Number.isInteger(id) || id < 1) throw new Fout(400, 'id ontbreekt'); return id; };
    try {
      if (!post && pad === '/app/vastgoed') {
        let u = overzicht();
        if (u.leeg) { leesDossier(); u = overzicht(); }   // eerste opening: het dossier inlezen (alleen de vault, niets naar buiten)
        else {   // fase 2: bank, Tibber en hypotheek lopen door; lees opnieuw als de laatste lezing ouder is dan een dag (alleen lokaal lezen)
          const actief = u.objecten.filter((x) => !x.weg_op);   // A15: een gemarkeerd object houdt zijn oude dossier_op; niet elke opening opnieuw lezen
          const oud = actief.map((x) => (x.dossier_op ? new Date(x.dossier_op).getTime() : 0)).reduce((a, b) => Math.min(a, b), Infinity);
          if (!actief.length || nu().getTime() - oud > GELD_DAG_MS) { try { leesDossier(); u = overzicht(); } catch (e) { /* de vorige stand blijft */ } }
        }
        try { u.nu_binnenkort = nuBinnenkortVan(u); } catch (e) { u.nu_binnenkort = null; }   // wv4228: een fout hier laat de rest van het scherm staan
        return { status: 200, body: u, reden: 'vastgoed overzicht' };
      }
      if (post && pad === '/app/vastgoed/dossier') { const t = leesDossier(); return { status: 200, body: { ok: true, gelezen: t }, reden: 'vastgoed dossier gelezen' }; }
      if (post && pad === '/app/vastgoed/ververs') { const t = await ververs(idUit()); return { status: 200, body: { ok: true, bijgewerkt: t }, reden: 'vastgoed bronnen ' + (t.geslaagd ? 'bijgewerkt' : 'zonder antwoord') }; }
      if (post && pad === '/app/vastgoed/beelden') return { status: 200, body: beelden(idUit()), reden: 'vastgoed beelden' };
      if (post && pad === '/app/vastgoed/aanroepen') return { status: 200, body: aanroepLijst(), reden: 'vastgoed aanroepen' };
      if (!post && pad === '/app/vastgoed/kelder') { const d = kelder(); return { status: 200, body: d, reden: 'vastgoed kelder' }; }   // wv4182
      if (post && pad === '/app/vastgoed/gezien') return { status: 200, body: gezien(), reden: 'vastgoed gezien' };
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
        objecten_weg: db.prepare("SELECT 1 FROM pragma_table_info('object') WHERE name = 'weg_op'").get() ? n('object', ' WHERE weg_op IS NOT NULL') : 0, leningdelen: n('leningdeel'), woz_eigen: n('woz_eigen'), reeksen_bank: n('reeks', " WHERE herkomst = 'bank'"), reeksen_tibber: n('reeks', " WHERE herkomst = 'tibber'"),
        geld: { hypotheek: ok(geld.hypotheek), bank: ok(geld.bank), tibber: ok(geld.tibber) },
        ronde: (() => { try { const r = JSON.parse((db.prepare("SELECT waarde FROM meta WHERE sleutel = 'ronde'").get() || {}).waarde || 'null'); return r ? { dag: r.dag, nulpunt: !!r.nulpunt, wijzigingen: r.wijzigingen, opgehaald: r.opgehaald, mislukt: r.mislukt } : null; } catch (e) { return null; } })(),
        melding_open: !!db.prepare("SELECT 1 FROM meta WHERE sleutel = 'melding_open'").get(),
        buurt: (() => { try { const b = JSON.parse((db.prepare("SELECT waarde FROM meta WHERE sleutel = 'buurt'").get() || {}).waarde || 'null'); const t = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bekendmaking'").get() ? n('bekendmaking') : 0; return b ? { straal_op: b.straal_op || null, gemeente_op: b.gemeente_op || null, mislukt_op: b.straal_mislukt || b.gemeente_mislukt || null, bekendmakingen: t } : { bekendmakingen: t }; } catch (e) { return null; } })(), kelder_pdf_op: (db.prepare("SELECT waarde FROM meta WHERE sleutel = 'kelder_pdf_op'").get() || {}).waarde || null };
    }, false);
  }
  // wv4228 (L40): Loopt nu / Binnenkort / Nieuw. Leest de huispagina's vers (± 20 kleine bestanden; alleen lezen) en rekent met het overzicht.
  function nuBinnenkortVan(u) {
    const huis = path.join(vault, HUIS);
    let namen = []; try { namen = fs.readdirSync(huis).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort().slice(0, 200); } catch (e) { return null; }
    const perPad = new Map((u.objecten || []).filter((x) => !x.weg_op).map((x) => [x.dossier, x.sleutel]));
    const paginas = [];
    for (const n of namen) { let md = ''; try { md = fs.readFileSync(path.join(huis, n), 'utf8'); } catch (e) { continue; } const pad = `${HUIS}/${n}`; paginas.push({ pad, md, object: perPad.get(pad) || null }); }
    const won = (u.objecten || []).find((x) => x.soort === 'woning');
    return nuEnBinnenkort({ vandaag: nlVandaag(nu()), paginas, kern: won && won.geld_kern, eigen: u.woz_eigen || [], nieuw: u.nieuw, nieuw_aantal: u.nieuw_aantal });
  }
  // wv4228: alleen het aantal voor de teller op de tegel (licht: geen dossier, geen vault)
  function nieuwAantal() {
    return metDb((db) => {
      if (!db || !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wijziging'").get()) return 0;
      const g = (db.prepare("SELECT waarde FROM meta WHERE sleutel = 'gezien_op'").get() || {}).waarde || '';
      return db.prepare('SELECT COUNT(*) AS n FROM wijziging WHERE op > ?').get(g).n;
    }, false);
  }
  // wv4227 (L39): Socev in het gewone gesprek. Haalt het overzicht via exact dezelfde weg als GET /app/vastgoed (zelfde cijfers als het
  // scherm, ook de herlezing van een dossier ouder dan een dag) en kent alleen leesopdrachten; ververs, beelden, woz en dossier zijn hier niet.
  async function gesprek(b) {
    const x = b && typeof b === 'object' ? b : {};
    if (!['kern', 'tab', 'zoek'].includes(String(x.opdracht || ''))) return gesprekUit({ ok: true, objecten: [] }, x);
    const u = await app({ pad: '/app/vastgoed', methode: 'GET' });
    if (u.status !== 200) return { status: u.status, body: { ok: false, fout: (u.body && u.body.fout) || 'Vastgoed is nu niet te lezen' } };
    return gesprekUit(u.body, x);
  }
  return { app, info, leesDossier, ververs, overzicht, kelder, ronde, rondeDag, meldingOpen, meldingVerstuurd, kelderPdfGezet, gezien, wozHerken, wozControle, wozVastleggen, wozVergelijk, wozBezwaar, wozConceptGezet, gesprek, nieuwAantal };
}

module.exports = { maak, geldKern, leesWoning, leesBox, leesDossierMap, dossierstand, indicatie, soortStuk, euroUit, datumUit, bagSoort, SCHEMA_VERSIE,
  leesHypotheek, hypotheekReeksen, laatsteStand, leesKelder, kelderDossier, kelderMd, kenmerken, kenmerkenMetOud, vergelijk, wijzigingBericht, buurtNieuw, leesKosten, vveUitBank, vveKern, stroomMaanden, wozUitTekst, maandUit, Fout, bezwaarTot, wozVergelijkObject, wozDeadlineRegels, wozSeintjeRegel, deadlineErbij, wozBezwaarTekst, gesprekUit, gesprekLink,
  looptUit, toekomstUit, alvUit, wozBinnenkort, nuEnBinnenkort, binnenkortRegels, binnenkortNodig };
