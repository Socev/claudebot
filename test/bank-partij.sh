#!/usr/bin/env bash
# Toetst bank-partij.js en het blok Bank in Brain › Entiteiten (wv3298, idee 35 meetpunt 3): filiaalregel (voorvoegsel betaalterminal,
# filiaalnummer, plaats, ketens), naam/alias van precies één knoop, eigen entiteiten tellen niet, betaaldienst-IBAN niet in zijn geheel,
# groep met twee partijen per post, uitsluitingen zakelijk (POT, eigen IBAN, verwijderd) en privé (POT/extern/kind, intern, contant geld,
# pending, vervangen), pinbetaling zonder naam uit de omschrijving, uitvoer zonder IBAN (bedragen sinds wv3944 wel), vaste plek en eigen entiteit zonder
# blok, module weg = geen blok, server.js, uitrol.sh, Dockerfile en CI. Alle namen en nummers zijn verzonnen (openbare repo).
# Gebruik: bash test/bank-partij.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 800) + ']' : '')); }
const P = require('./bank-partij.js');
const BE = require('./brain-entiteiten.js');
const { DatabaseSync } = require('node:sqlite');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wv3298-'));

// ── 1. filiaalregel ──
const s = (n) => { const x = P.schoon(n); return x ? x.naam + '|' + x.soort : null; };
toets('1 keten met filiaalnummer en plaats', s('ALBERT HEIJN 1344 HUIZEN') === 'Albert Heijn|keten' && s('AH to go 5873 Utrech') === 'Albert Heijn|keten' && s('Hema EV2221 Leusden') === 'HEMA|keten',
  [s('ALBERT HEIJN 1344 HUIZEN'), s('AH to go 5873 Utrech'), s('Hema EV2221 Leusden')]);
toets('1b terminalvoorvoegsel en plaats eraf (kaal)', s('BCK*Proefzorg Hilversum') === 'Proefzorg|kaal' && s('5118 Bakkerij Verzonnen Huizen') === 'Bakkerij Verzonnen|kaal', [s('BCK*Proefzorg Hilversum'), s('5118 Bakkerij Verzonnen Huizen')]);
toets('1c aan elkaar geschreven keten', s('PlusSupermarktHuizen') === 'PLUS Supermarkt|keten');
toets('1d niets te schonen of te kort: null', s('Voorbeeld Energie') === null && s('Abc 12') === null && s('') === null);

// ── 2. koppelregel ──
const knopen = [
  { id: 'VB', soort: 'entiteit', rol: 'eigen', naam: 'Voorbeeldpraktijk', aliassen: ['D. Verzonnen'], actief: true },
  { id: 'org:ah', soort: 'organisatie', rol: 'leverancier', naam: 'Albert Heijn', actief: true },
  { id: 'org:proefzorg', soort: 'organisatie', rol: 'praktijk', naam: 'Proefzorg', actief: true },
  { id: 'org:energie', soort: 'organisatie', rol: 'leverancier', naam: 'Voorbeeld Energie', aliassen: ['VE Zakelijk'], actief: true },
  { id: 'org:lidl', soort: 'organisatie', rol: 'leverancier', naam: 'Lidl', actief: true },
  { id: 'org:dubbel1', soort: 'organisatie', rol: 'leverancier', naam: 'Tweeling Een', aliassen: ['Tweeling'], actief: true },
  { id: 'org:dubbel2', soort: 'organisatie', rol: 'leverancier', naam: 'Tweeling Twee', aliassen: ['Tweeling'], actief: true },
  { id: 'org:weg', soort: 'organisatie', rol: 'leverancier', naam: 'Opgeheven Winkel', actief: false },
  { id: 'per:piet', soort: 'persoon', rol: 'persoon', naam: 'Piet Verzonnen', actief: true },
];
const hv = { 'org:energie': [{ soort: 'alias', waarde: 'VE Levering BV', status: 'voorgesteld' }, { soort: 'alias', waarde: 'Oude Naam BV', status: 'vervallen' }],
  'VB': [{ soort: 'alias', waarde: 'Voorbeeld Praktijk Rekening', status: 'actief' }] };
const isEigen = (k) => k.rol === 'eigen' || k.soort === 'entiteit';
const live = P.naamIndex(knopen, hv, isEigen);
toets('2 naam, alias en handvat-alias; vervallen alias niet', live('ALBERT HEIJN') === 'org:ah' && live('ve zakelijk') === 'org:energie' && live('VE Levering B.V.') === 'org:energie' && live('Oude Naam BV') === null);
toets('2b eigen entiteit en inactieve knoop tellen niet; alias van twee knopen = geen', live('D. Verzonnen') === null && live('Voorbeeldpraktijk') === null && live('Voorbeeld Praktijk Rekening') === null &&
  live('Opgeheven Winkel') === null && live('Tweeling') === null);
const G = (key, iban, namen) => ({ sleutel: key, iban: !!iban, posten: namen.map((n, i) => ({ naam: n[0], datum: n[1] || '2026-01-0' + ((i % 9) + 1) })) });
const k = P.koppel([
  G('I:A', 'NL00TEST1', [['Albert Heijn 1344', '2025-03-01'], ['ALBERT HEIJN 1344 HUIZEN', '2026-02-01'], ['Kassa 7', '2025-07-01']]),   // hele groep naar AH (ook de naamloze kassa)
  G('I:B', 'NL00TEST2', [['lidl.nl via Rabo Smart Pay'], ['ijzerwaren.nl via Rabo Smart Pay'], ['boeken.nl via Rabo Smart Pay']]),  // betaaldienst: alleen de lidl-post
  G('I:C', 'NL00TEST3', [['Proefzorg'], ['Voorbeeld Energie'], ['Onbekend']]),                                   // twee partijen: per post
  G('N:x', null, [['BCK*Proefzorg Hilversum'], ['BCK*Proefzorg Hilversum']]),
  G('N:y', null, [['Iets Heel Anders']]),
], live);
const per = (id) => k.per.get(id) || { posten: 0 };
toets('3 IBAN-groep met één herkende partij: hele groep, eerste en laatste datum', per('org:ah').posten === 3 && per('org:ah').eerste === '2025-03-01' && per('org:ah').laatste === '2026-02-01' && per('org:ah').filiaal === true, per('org:ah'));
toets('3b betaaldienst-IBAN: alleen de eigen post, niet de hele groep', per('org:lidl').posten === 1, per('org:lidl'));
const kq = P.koppel([G('I:Q', 'NL00TEST4', [['SQ *Lidl'], ['SQ *Onbekende Winkel'], ['IZ *Nog Een Winkel']])], live);
toets('3b2 terminalvoorvoegsel op een gedeelde IBAN (SQ *, IZ *): alleen de eigen post (review MOET 1)', (kq.per.get('org:lidl') || {}).posten === 1 && kq.telling.posten_ingang === 1, kq.telling);
toets('3c groep met twee partijen: per post, onbekende post nergens', per('org:energie').posten === 1 && per('org:proefzorg').posten === 3, [per('org:energie'), per('org:proefzorg')]);
toets('3d telling: groepen met ingang, via naam en alleen via filiaal', k.telling.groepen === 5 && k.telling.groepen_ingang === 4 && k.telling.groepen_naam === 1 && k.telling.groepen_filiaal === 3 && k.telling.nieuw.length === 3, k.telling);
const k0 = P.koppel([G('N:x', null, [['BCK*Proefzorg Hilversum']])], live, { zonderFiliaal: true });
toets('3e zonder filiaalregel: geen koppeling', k0.telling.groepen_ingang === 0);

// ── 3. bronnen (verzonnen databanken) ──
const fpad = path.join(tmp, 'facturen.sqlite'), bpad = path.join(tmp, 'transacties.sqlite');
let db = new DatabaseSync(fpad);
db.exec('CREATE TABLE rekening (id INTEGER PRIMARY KEY, iban TEXT); CREATE TABLE bank_transactie (id INTEGER PRIMARY KEY, entiteit TEXT, boekdatum TEXT, bedrag_centen INTEGER, tegenpartij_naam TEXT, tegenpartij_iban TEXT, omschrijving TEXT, transactietype TEXT, verwijderd_op TEXT);' +
  'CREATE TABLE leverancier (id INTEGER PRIMARY KEY, naam TEXT, knoop_id TEXT); CREATE TABLE factuur (id INTEGER PRIMARY KEY, leverancier INTEGER, entiteit TEXT, factuurdatum TEXT, incl_eur INTEGER, status TEXT, patientkenmerk INTEGER, intern INTEGER);' +
  'CREATE TABLE factuur_archief (id INTEGER PRIMARY KEY, leverancier_naam TEXT, entiteit TEXT, factuurdatum TEXT, incl INTEGER, status TEXT);');
db.exec("INSERT INTO rekening VALUES (1, 'NL00EIGEN0000000001')");
db.exec("INSERT INTO bank_transactie VALUES (1, 'tolgaarde', '2026-01-05', -4321, 'Albert Heijn 1498', NULL, '', 'BEA', NULL)," +
  " (2, 'tolgaarde', '2026-03-05', -100, NULL, NULL, 'BEA, Betaalpas ALBERT HEIJN 1344,PAS123 NR:XYZ', 'BEA', NULL)," +   // pin zonder naam: winkel uit de omschrijving
  " (3, 'pot', '2026-03-06', -100, 'Albert Heijn 1498', NULL, '', 'BEA', NULL)," +   // POT telt niet
  " (4, 'tolgaarde', '2026-03-07', -100, 'Albert Heijn 1498', NULL, '', 'BEA', '2026-03-08')," +   // verwijderd
  " (5, 'tolgaarde', '2026-03-09', -100, 'Albert Heijn', 'NL00EIGEN0000000001', '', 'OVB', NULL)," +   // eigen rekening
  " (6, 'groenhouten', '2026-04-01', -9999, 'VE Zakelijk', 'NL00TEST0000000099', 'termijn', 'INC', NULL)");
db.close();
db = new DatabaseSync(bpad);
db.exec('CREATE TABLE rekeningen (rek TEXT PRIMARY KEY, eigenaar TEXT, iban TEXT); CREATE TABLE transacties (nr INTEGER PRIMARY KEY, rek TEXT, status TEXT, datum TEXT, bedrag REAL, tegenpartij TEXT, tegen_iban TEXT, vervangen_door INTEGER);' +
  'CREATE TABLE verrijking (nr INTEGER PRIMARY KEY, type TEXT, categorie TEXT);');
db.exec("INSERT INTO rekeningen VALUES ('r1', 'David', 'NL00PRIV0000000001'), ('r2', 'kind', 'NL00PRIV0000000002'), ('r3', 'POT', 'NL00PRIV0000000003')");
db.exec("INSERT INTO transacties VALUES (1, 'r1', 'booked', '2024-06-01', -12.5, 'ALBERT HEIJN 1344', NULL, NULL), (2, 'r1', 'booked', '2026-11-01', -3, 'Albert Heijn 1056 HUIZEN', NULL, NULL)," +
  " (3, 'r2', 'booked', '2026-01-01', -3, 'Albert Heijn 1344', NULL, NULL), (4, 'r3', 'booked', '2026-01-01', -3, 'Albert Heijn 1344', NULL, NULL)," +
  " (5, 'r1', 'pending', '2026-11-02', -3, 'Albert Heijn 1344', NULL, NULL), (6, 'r1', 'booked', '2026-11-03', -3, 'Albert Heijn 1344', NULL, 99)," +
  " (7, 'r1', 'booked', '2026-11-04', -50, 'Albert Heijn 1344', NULL, NULL), (8, 'r1', 'booked', '2026-11-05', -50, 'Albert Heijn 1344', NULL, NULL)," +
  " (9, 'r1', 'booked', '2026-11-06', -50, 'Albert Heijn', 'NL00PRIV0000000002', NULL)");
db.exec("INSERT INTO verrijking VALUES (7, 'intern', NULL), (8, 'uitgave', 'contant geld')");
db.close();
const idx = P.index({ facturenPad: fpad, bankPad: bpad, knopen, handvatten: hv, isEigen });
const b = P.blokVoor(idx, 'org:ah');
toets('4 zakelijk: filiaalposten + pin uit de omschrijving; POT, verwijderd en eigen rekening niet', b.zakelijk.posten === 2 && b.zakelijk.eerste === '2026-01-05' && b.zakelijk.laatste === '2026-03-05', b.zakelijk);
toets('4b privé: rekening van kind/POT, pending, vervangen, intern, contant geld en eigen IBAN niet', b.prive.posten === 2 && b.prive.eerste === '2024-06-01' && b.prive.laatste === '2026-11-01', b.prive);
toets('4c schrijfwijzen meest voorkomend eerst, hooguit 3, filiaalvlag', b.prive.schrijfwijzen.length === 2 && b.prive.meer === 0 && b.prive.filiaal === true);
toets('4d geen IBAN in de uitvoer (bedragen sinds wv3944 wel)', !/NL00/.test(JSON.stringify(P.blokVoor(idx, 'org:energie'))) && !/iban/i.test(JSON.stringify(b)) && P.blokVoor(idx, 'org:energie').zakelijk.geld.jaren[0].af_cent === 9999, P.blokVoor(idx, 'org:energie'));
toets('4e partij zonder posten: 0 per kant', JSON.stringify(P.blokVoor(idx, 'per:piet')) === '{"zakelijk":{"posten":0},"prive":{"posten":0}}');
const leeg = P.index({ facturenPad: path.join(tmp, 'weg.sqlite'), bankPad: path.join(tmp, 'weg2.sqlite'), knopen, handvatten: hv, isEigen });
toets('4f beide bronnen weg: geen blok; één weg: die kant null', P.blokVoor(leeg, 'org:ah') === null &&
  P.blokVoor(P.index({ facturenPad: fpad, bankPad: path.join(tmp, 'weg2.sqlite'), knopen, handvatten: hv, isEigen }), 'org:ah').prive === null);

// ── 4. Brain › Entiteiten ──
const vault = path.join(tmp, 'vault'); fs.mkdirSync(path.join(vault, '10_Zakelijk/_Gedeeld/Relaties'), { recursive: true });
fs.writeFileSync(path.join(vault, '10_Zakelijk/_Gedeeld/Relaties/Albert Heijn.md'), '# Albert Heijn\n');
const rk = knopen.map((x) => Object.assign({ vault_pagina: x.id === 'org:ah' ? '10_Zakelijk/_Gedeeld/Relaties/Albert Heijn.md' : null, voor: [] }, x));
const hl = []; Object.keys(hv).forEach((id) => hv[id].forEach((h) => hl.push(Object.assign({ knoop: id }, h))));
let klok = Date.parse('2026-11-18T10:00:00Z');
const rpc = async (fn) => { if (fn !== 'ovis_register_lees') return { contacten: [] }; return { knopen: rk, handvatten: hl }; };
const T = BE.maak({ rpc, vault, lees: (p) => fs.readFileSync(p, 'utf8'), facturenPad: fpad, bankPad: bpad, nu: () => klok });
(async () => {
  const d = await T.detail('org:ah', false);
  toets('5 detail: weet.bank met beide kanten', d.status === 200 && d.j.weet.bank && d.j.weet.bank.zakelijk.posten === 2 && d.j.weet.bank.prive.posten === 2, d.j.weet.bank);
  toets('5b wv3446: ook met een (oude) vaste-plekvlag het blok', (await T.detail('org:ah', true)).j.weet.bank !== null);
  toets('5c eigen entiteit: geen blok', (await T.detail('VB', false)).j.weet.bank === null);
  const T2 = BE.maak({ rpc, vault, lees: (p) => fs.readFileSync(p, 'utf8'), facturenPad: fpad, bankPad: bpad, bankPartij: null });
  toets('5d module weg (terugrol): geen blok, detail blijft', (await T2.detail('org:ah', false)).j.weet.bank === null && (await T2.detail('org:ah', false)).status === 200);
  // index wordt bewaard (5 min) en daarna vernieuwd
  db = new DatabaseSync(bpad); db.exec("INSERT INTO transacties VALUES (10, 'r1', 'booked', '2026-11-10', -1, 'Albert Heijn 1344', NULL, NULL)"); db.close();
  klok += 60000;
  const na1 = (await T.detail('org:ah', false)).j.weet.bank.prive.posten;
  klok += 300000;
  const na2 = (await T.detail('org:ah', false)).j.weet.bank.prive.posten;
  toets('5e index 5 minuten bewaard, daarna vers', na1 === 2 && na2 === 3, [na1, na2]);

  // ── wv3944 (3C57): bedragen per jaar, laatste post, gemiddelde (12 maanden), eigen entiteit met grootste tegenpartijen ──
  const gz = (await T.detail('org:ah', false)).j.weet.bank.zakelijk.geld;
  toets('7 zakelijk geld: per jaar af, laatste post met teken, gemiddelde 12 mnd', gz && gz.jaren.length === 1 && gz.jaren[0].jaar === 2026 && gz.jaren[0].af_cent === 4421 && gz.jaren[0].bij_cent === 0 &&
    gz.laatste.datum === '2026-03-05' && gz.laatste.bedrag_cent === -100 && gz.gemiddeld.betalingen === 2 && gz.gemiddeld.af_cent === 2211, gz);
  const gp = (await T.detail('org:ah', false)).j.weet.bank.prive.geld;
  toets('7b privé geld: bedrag in euro → centen, oud jaar apart, buiten 12 mnd niet in het gemiddelde', gp && gp.jaren.map((j) => j.jaar + ':' + j.af_cent).join(',') === '2026:400,2024:1250' &&
    gp.gemiddeld.betalingen === 2 && gp.gemiddeld.af_cent === 200 && gp.laatste.bedrag_cent === -100, gp);
  const kj = P.koppel([G('I:J', 'NL00TESTJ', [['Albert Heijn', '2025-12-01'], ['Albert Heijn', '2026-02-01']])].map((g, i) => { g.posten[0].cent = -1000; g.posten[1].cent = 2500; return g; }), live, { nu: Date.parse('2026-11-18T10:00:00Z') });
  const kjg = P.blokVoor({ zakelijk: kj, prive: null }, 'org:ah').zakelijk.geld;
  toets('7c bijschrijving apart (bij), niet in het gemiddelde; jaren nieuwste eerst', kjg.jaren.map((j) => `${j.jaar}:${j.af_cent}/${j.bij_cent}`).join(',') === '2026:0/2500,2025:1000/0' && kjg.gemiddeld.betalingen === 1 && kjg.laatste.bedrag_cent === 2500, kjg);
  const eg = P.eigenGeld({ facturenPad: fpad, bankPad: bpad, entiteit: 'tolgaarde', live, nu: klok });
  toets('7d eigen entiteit zakelijk: alleen haar posten, zonder eigen IBAN en verwijderd; filialen samen onder de partij', eg && eg.bron === 'zakelijk' && eg.posten === 2 && eg.geld.jaren[0].af_cent === 4421 &&
    eg.leveranciers.length === 1 && eg.leveranciers[0].knoop === 'org:ah' && eg.leveranciers[0].af_cent === 4421 && eg.leveranciers[0].betalingen === 2, eg);
  const ep = P.eigenGeld({ facturenPad: fpad, bankPad: bpad, entiteit: 'pot', live, nu: klok });
  toets('7e POT als eigen entiteit: haar eigen posten tellen (Davids scherm)', ep && ep.posten === 1 && ep.geld.jaren[0].af_cent === 100, ep);
  const epr = P.eigenGeld({ facturenPad: fpad, bankPad: bpad, entiteit: 'prive', live, nu: klok });
  toets('7f privé: bank-archief met de uitsluitingen van het blok Bank', epr && epr.bron === 'prive' && epr.posten === 3 && epr.leveranciers[0].knoop === 'org:ah', epr);
  toets('7g bron weg: null', P.eigenGeld({ facturenPad: path.join(tmp, 'weg.sqlite'), entiteit: 'tolgaarde', live }) === null);
  // top 5 op afschrijving, betaaldienst-IBAN niet als één partij
  const vpad = path.join(tmp, 'veel.sqlite');
  db = new DatabaseSync(vpad);
  db.exec('CREATE TABLE rekening (id INTEGER PRIMARY KEY, iban TEXT); CREATE TABLE bank_transactie (id INTEGER PRIMARY KEY, entiteit TEXT, boekdatum TEXT, bedrag_centen INTEGER, tegenpartij_naam TEXT, tegenpartij_iban TEXT, omschrijving TEXT, transactietype TEXT, verwijderd_op TEXT);');
  const ins = db.prepare("INSERT INTO bank_transactie (entiteit, boekdatum, bedrag_centen, tegenpartij_naam, tegenpartij_iban, verwijderd_op) VALUES ('tolgaarde', ?, ?, ?, ?, NULL)");
  for (let i = 1; i <= 7; i++) ins.run('2026-0' + i + '-01', -1000 * i, 'Leverancier ' + 'ABCDEFG'[i - 1], 'NL00TESTL' + i);
  ins.run('2026-08-01', -99999, 'Oud Maar Groot', 'NL00TESTOUD'); db.prepare("UPDATE bank_transactie SET boekdatum = '2025-01-01' WHERE tegenpartij_naam = 'Oud Maar Groot'").run();
  ins.run('2026-08-02', -500, 'Mollie Winkel Een', 'NL00TESTMOL'); ins.run('2026-08-03', -600, 'Lidl via Mollie', 'NL00TESTMOL');
  ins.run('2026-08-04', 50000, 'Zorgverzekeraar Proef', 'NL00TESTZV');
  db.close();
  const ev = P.eigenGeld({ facturenPad: vpad, entiteit: 'tolgaarde', live, nu: klok });
  toets('7h top 5 op afschrijving in 12 maanden (ouder en bijschrijving niet); betaaldienst-IBAN niet in zijn geheel naar een winkel', ev.leveranciers.length === 5 &&
    ev.leveranciers.map((l) => l.af_cent).join(',') === '7000,6000,5000,4000,3000' && !ev.leveranciers.some((l) => /Oud|Zorg/.test(l.naam)) && ev.geld.jaren.find((j) => j.jaar === 2026).bij_cent === 50000 &&
    ev.geld.jaren.find((j) => j.jaar === 2025).af_cent === 99999, ev);
  const em = P.eigenGeld({ facturenPad: vpad, entiteit: 'tolgaarde', live: (n) => (/lidl/i.test(n) ? 'org:lidl' : null), nu: klok });
  const molLidl = (em.leveranciers.concat([]).find((l) => l.knoop === 'org:lidl'));
  toets('7i betaaldienst-IBAN: Lidl-post apart, Mollie-winkel niet bij Lidl', !molLidl || molLidl.af_cent === 600, em.leveranciers);
  // review MOET 1/2: IBAN met twee herkende partijen of een betaaldienst groepeert niet
  const rpad = path.join(tmp, 'review.sqlite');
  db = new DatabaseSync(rpad);
  db.exec('CREATE TABLE rekening (id INTEGER PRIMARY KEY, iban TEXT); CREATE TABLE bank_transactie (id INTEGER PRIMARY KEY, entiteit TEXT, boekdatum TEXT, bedrag_centen INTEGER, tegenpartij_naam TEXT, tegenpartij_iban TEXT, omschrijving TEXT, transactietype TEXT, verwijderd_op TEXT);');
  const ri = db.prepare("INSERT INTO bank_transactie (entiteit, boekdatum, bedrag_centen, tegenpartij_naam, tegenpartij_iban) VALUES ('tolgaarde', '2026-09-01', ?, ?, ?)");
  ri.run(-1000, 'Proefzorg', 'NL00TESTGEDEELD'); ri.run(-2000, 'Voorbeeld Energie', 'NL00TESTGEDEELD'); ri.run(-9000, 'Iets Onbekends', 'NL00TESTGEDEELD');
  ri.run(-300, 'Winkel Een via Mollie', 'NL00TESTMOL2'); ri.run(-400, 'Winkel Twee via Mollie', 'NL00TESTMOL2');
  ri.run(-5000, 'Albert Heijn', 'NL00TESTAH'); ri.run(-7000, 'AH kassa onbekend', 'NL00TESTAH');
  db.close();
  const rv = P.eigenGeld({ facturenPad: rpad, entiteit: 'tolgaarde', live, nu: klok }).leveranciers;
  const rk2 = (f) => rv.find(f) || null;
  toets('7m review MOET 1: IBAN met twee herkende partijen — onbekende post niet bij een van beide', rk2((l) => l.knoop === 'org:proefzorg').af_cent === 1000 && rk2((l) => l.knoop === 'org:energie').af_cent === 2000 &&
    rk2((l) => l.naam === 'Iets Onbekends' && !l.knoop).af_cent === 9000, rv);
  toets('7n review MOET 2: betaaldienst-IBAN — winkels apart op hun eigen naam', rk2((l) => /Winkel Twee/.test(l.naam)).af_cent === 400 && !rv.some((l) => l.af_cent === 700), rv);
  toets('7o IBAN met één herkende partij: onbekende post op die IBAN telt bij haar', rk2((l) => l.knoop === 'org:ah').af_cent === 12000, rv);
  const TG = BE.maak({ rpc: async (fn) => (fn !== 'ovis_register_lees' ? { contacten: [] } : { knopen: rk.concat([{ id: 'TG', soort: 'entiteit', rol: 'eigen', naam: 'Proefpraktijk', actief: true, voor: [], vault_pagina: null }]), handvatten: hl }),
    vault, lees: (p) => fs.readFileSync(p, 'utf8'), facturenPad: fpad, bankPad: bpad, nu: () => klok });
  const tgd = (await TG.detail('TG', false)).j.weet;
  toets('7j detail eigen entiteit: eigen_geld met leverancier → naam en sleutel van de partij; andere partij geen eigen_geld', tgd.eigen_geld && tgd.eigen_geld.leveranciers[0].naam === 'Albert Heijn' &&
    /^[0-9a-f]{12}$/.test(tgd.eigen_geld.leveranciers[0].sleutel) && tgd.bank === null && (await TG.detail('org:ah', false)).j.weet.eigen_geld === undefined, tgd.eigen_geld);
  toets('7k eigen entiteit zonder bankrekening in de pod (VB): leeg blok, geen fout', JSON.stringify((await T.detail('VB', false)).j.weet.eigen_geld) === '{"bron":null,"posten":0,"geld":null,"leveranciers":[]}');

  const srv = fs.readFileSync('server.js', 'utf8');
  toets('6 server.js geeft het bankpad mee', /bankPad: path\.join\(process\.env\.BANK_DIR \|\| '\/opt\/data\/bank', 'transacties\.sqlite'\),   \/\/ wv3298/.test(srv));
  toets('6b uitrol.sh, Dockerfile en CI kennen bank-partij', /RELEASE_OPTIONEEL="[^"]*\bbank-partij\.js\b/.test(fs.readFileSync('uitrol.sh', 'utf8')) &&
    /COPY bank-partij\.js \/app\/release-bootstrap\/bank-partij\.js/.test(fs.readFileSync('Dockerfile', 'utf8')) && /test\/bank-partij\.sh/.test(fs.readFileSync('.github/workflows/build.yml', 'utf8')));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${goed} groen, ${fouten} rood`);
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('FOUT', e); process.exit(1); });
JS
