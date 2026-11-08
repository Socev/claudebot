#!/usr/bin/env bash
# Toetst financien-corrigeer.js + bank-archief.js corrigeer/herstel/regelUit (wv2717, idee 6 uit Sure: zelf corrigeren in de App; ontwerp
# vault "01_Ontwikkeling/Financiën - ideeën uit Sure (ontwerp 8-11-2026)" § 1c) op een nagebootste transactiedatabase met verzonnen
# boekingen: alleen deze / voortaan altijd (ook een nieuwe post volgt), Davids keuze wint van AI en regel en blijft na herverrijken, terug
# naar automatisch per boeking en per regel (oordeel weer gelijk), twee gedeeltelijke regels na elkaar (review ronde 2 MOET 1), een regel
# raakt de externe rekening niet (review MOET 2), weigeringen (POT, extern, eigen overboeking, betaaldienst + altijd, vreemde valuta,
# onbekende categorie/eigenaar, naam met IBAN), eigen naam alleen in de weergave, Jouw regels zonder IBAN; bank-lezer app-corrigeer; de
# routes in server.js. Kruisproeven: zonder de david-voorrang, zonder herstel en zonder het regelbereik wordt de toets rood.
# Raakt de pod, de kluis, de bank, de vault en /opt/data/bank niet. Gebruik: bash test/financien-corrigeer.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings --require ./test/vaste-klok.cjs - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 900) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'financien-corrigeer-'));
const BD = path.join(W, 'bank');
const A = require(path.resolve('bank-archief.js'));
let C = null;
try { C = require(path.resolve('financien-corrigeer.js')); } catch (e) { console.log(e); C = null; }
toets('financien-corrigeer.js bestaat en laadt', !!C, null);
const FO = require(path.resolve('financien-overzicht.js'));
const REK = {
  pr: { bron: 'bunq', uid: 'bunq-1', bunq_id: 1, naam: 'Hoofdrekening', soort: 'lopend', iban: 'NL11BUNQ0000000001', status: 'ACTIVE' },
  sp: { bron: 'bunq', uid: 'bunq-5', bunq_id: 5, naam: 'Spaar', soort: 'spaar', iban: 'NL55BUNQ0000000005', status: 'ACTIVE' },
  ex: { bron: 'bunq', uid: 'bunq-7', bunq_id: 7, naam: 'Van Iemand Anders', soort: 'lopend', iban: 'NL77BUNQ0000000007', status: 'ACTIVE' },
  po: { bron: 'bunq', uid: 'bunq-8', bunq_id: 8, naam: 'Stichting Proef', soort: 'lopend', iban: 'NL88BUNQ0000000008', status: 'ACTIVE' },
};
let n = 0;
const p = (datum, bedrag, tegen, oms, extra) => Object.assign({ id: 'x:' + (++n), datum: datum, valutadatum: datum, bedrag: bedrag, valuta: 'EUR', tegenpartij: tegen, omschrijving: oms || null,
  status: 'geboekt', saldo_na: null, mcc: null, tegen_iban: null, _ruw: { id: n, bron: 'nagebootst' } }, extra || {});
const PR = [], SP = [], EX = [], PO = [];
PR.push(p('2026-09-03', -112, 'Bouwmarkt Proef', 'verf'));
PR.push(p('2026-09-20', -45, 'Bouwmarkt Proef', 'kwast'));
PR.push(p('2026-10-03', -60, 'Bouwmarkt Proef', 'lamp'));
PR.push(p('2026-10-05', 30, 'Bouwmarkt Proef', 'retour'));                     // andere richting
PR.push(p('2026-10-06', -25, 'PayPal Europe S.a.r.l.', 'Betaling dienst'));     // betaaldienst
PR.push(p('2026-10-07', -80, 'ALBERT HEIJN 1430', 'boodschappen'));
PR.push(p('2026-10-08', -40, 'ALBERT HEIJN 1430', 'boodschappen'));
PR.push(p('2026-10-09', -500, 'Spaar', 'sparen', { tegen_iban: REK.sp.iban })); SP.push(p('2026-10-09', 500, 'D. Voorbeeld', 'sparen', { tegen_iban: REK.pr.iban }));
PR.push(p('2026-10-10', -20, 'Ver Weg Winkel', 'in dollars', { valuta: 'USD' }));
PR.push(p('2026-10-11', -15, null, 'Kosten betaalpakket'));
EX.push(p('2026-10-12', -33, 'Bouwmarkt Proef', 'van iemand anders'));          // externe rekening, zelfde tegenpartij
PO.push(p('2026-10-13', -99, 'Bouwmarkt Proef', 'pot'));
const a = A.open(BD);
A.rekeningenSync(a, REK);
A.bij(a, 'pr', PR, {}); A.bij(a, 'sp', SP, {}); A.bij(a, 'ex', EX, {}); A.bij(a, 'po', PO, {});
A.corrigeer(a, { rek: 'ex', eigenaar: 'extern' });
A.corrigeer(a, { rek: 'po', eigenaar: 'POT' });
A.verrijk(a);
// een AI-oordeel voor de bouwmarkt (huishouden) zoals de nachtronde het zet
const aiGroep = (where, cat, oms) => a.db.prepare('SELECT * FROM transacties WHERE ' + where).all().forEach((t) => a.db.prepare('INSERT OR REPLACE INTO ai_groepen (sleutel, type, categorie, subcategorie, ai_omschrijving, model, gemaakt) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(A.groepSleutel(t), t.bedrag < 0 ? 'uitgave' : 'inkomst', cat, null, oms || null, 'proef', '2026-11-01'));
aiGroep("tegenpartij = 'Bouwmarkt Proef' AND bedrag < 0", 'huishouden', 'Bouwmarktaankoop');
aiGroep("tegenpartij = 'ALBERT HEIJN 1430'", 'boodschappen');
A.metaZet(a, 'vuil', '1'); A.verrijk(a);
const nrVan = (tp, d, rek) => a.db.prepare('SELECT nr FROM transacties WHERE tegenpartij IS ? AND datum = ? AND rek = ?').get(tp, d, rek || 'pr').nr;
const V = (nr) => a.db.prepare('SELECT type, categorie, subcategorie, ai_omschrijving, eigenaar, abonnement_id, herkomst, regel_id FROM verrijking WHERE nr = ?').get(nr);
const kaal = (v) => JSON.stringify({ type: v.type, categorie: v.categorie, subcategorie: v.subcategorie, ai_omschrijving: v.ai_omschrijving, eigenaar: v.eigenaar, abonnement_id: v.abonnement_id });
const b1 = nrVan('Bouwmarkt Proef', '2026-09-03'), b2 = nrVan('Bouwmarkt Proef', '2026-09-20'), b3 = nrVan('Bouwmarkt Proef', '2026-10-03'), bRet = nrVan('Bouwmarkt Proef', '2026-10-05');
const bEx = nrVan('Bouwmarkt Proef', '2026-10-12', 'ex'), bPo = nrVan('Bouwmarkt Proef', '2026-10-13', 'po');
const pp = nrVan('PayPal Europe S.a.r.l.', '2026-10-06'), spaar = nrVan('Spaar', '2026-10-09'), usd = nrVan('Ver Weg Winkel', '2026-10-10'), zonder = nrVan(null, '2026-10-11'), ah = nrVan('ALBERT HEIJN 1430', '2026-10-07');
const fout = (f) => { try { f(); return null; } catch (e) { return e.message; } };
if (C) {
  const voor = {}; [b1, b2, b3, bRet, bEx, bPo].forEach((x) => { voor[x] = kaal(V(x)); });
  // 1. alleen deze
  const r1 = C.corrigeerApp(A, a, { nr: b1, categorie: 'wonen', altijd: false });
  toets('alleen deze: die boeking wonen (herkomst david), de andere bouwmarktposten blijven huishouden, geen regel', V(b1).categorie === 'wonen' && V(b1).herkomst === 'david' && V(b2).categorie === 'huishouden' && V(b3).categorie === 'huishouden' && r1.regel === null &&
    a.db.prepare("SELECT count(*) n FROM regels WHERE herkomst = 'david'").get().n === 0, [r1, V(b1), V(b2)]);
  toets('alleen deze: de AI-omschrijving gaat weg bij een andere categorie (hoort niet meer)', V(b1).ai_omschrijving === null, V(b1));
  // 2. herverrijken houdt hem
  A.metaZet(a, 'vuil', '1'); A.verrijk(a);
  toets('herverrijken (nachtronde) houdt Davids keuze', V(b1).categorie === 'wonen' && V(b1).herkomst === 'david', V(b1));
  // 3. terug naar automatisch per boeking
  const h1 = C.herstelApp(A, a, { nr: b1 });
  toets('terug naar automatisch (boeking): oordeel weer zoals vóór (AI huishouden), door = auto', V(b1).herkomst === 'regel' || V(b1).herkomst === 'ai' ? kaal(V(b1)) === voor[b1] && h1.door === 'auto' : false, [h1, V(b1), voor[b1]]);
  toets('historie: de keuze van David staat in verrijking_historie (niets verwijderd)', a.db.prepare('SELECT count(*) n FROM verrijking_historie WHERE nr = ? AND json LIKE ?').get(b1, '%"herkomst":"david"%').n >= 1, null);
  // 4. voortaan altijd: regel op tegenpartij + richting; ook een nieuwe post volgt; de terugbetaling (bij) en de externe rekening niet
  const r2 = C.corrigeerApp(A, a, { nr: b2, categorie: 'wonen', eigenaar: 'samen', altijd: true });
  A.bij(a, 'pr', [p('2026-11-02', -70, 'Bouwmarkt Proef', 'nieuwe post')], {}); A.verrijk(a);
  const bNieuw = nrVan('Bouwmarkt Proef', '2026-11-02');
  toets('voortaan altijd: regel van David, de andere bouwmarktposten (ook een nieuwe) wonen + samen via de regel', r2.regel > 0 && V(b3).categorie === 'wonen' && V(b3).eigenaar === 'samen' && V(b3).regel_id === r2.regel &&
    V(bNieuw).categorie === 'wonen' && V(b1).categorie === 'wonen', [r2, V(b3), V(bNieuw)]);
  toets('voortaan altijd: de terugbetaling (andere richting) volgt niet', kaal(V(bRet)) === voor[bRet], [V(bRet), voor[bRet]]);
  toets('regelbereik (review MOET 2): de post met dezelfde naam op de externe rekening en op de POT volgt de regel niet', kaal(V(bEx)) === voor[bEx] && kaal(V(bPo)) === voor[bPo] && V(bEx).regel_id !== r2.regel, [V(bEx), voor[bEx], V(bPo)]);
  // 5. Davids keuze per boeking wint van zijn regel
  C.corrigeerApp(A, a, { nr: b3, categorie: 'vrije tijd en sport', altijd: false });
  A.verrijk(a);
  toets('Davids keuze per boeking wint van zijn regel en blijft na herverrijken', V(b3).categorie === 'vrije tijd en sport' && V(b3).herkomst === 'david' && V(b1).categorie === 'wonen', [V(b3), V(b1)]);
  // 6. tweede gedeeltelijke regel (alleen eigenaar): de categorie van de regel blijft (review ronde 2 MOET 1)
  const r3 = C.corrigeerApp(A, a, { nr: b1, eigenaar: 'David', altijd: true });
  const g3 = a.db.prepare('SELECT * FROM regels WHERE id = ?').get(r3.regel), gOud = a.db.prepare('SELECT actief FROM regels WHERE id = ?').get(r2.regel);
  toets('twee gedeeltelijke regels na elkaar: nieuwe regel houdt categorie wonen en krijgt eigenaar David; de oude staat inactief (niet weg)', g3 && g3.categorie === 'wonen' && g3.eigenaar === 'David' && gOud && gOud.actief === 0 &&
    V(bNieuw).categorie === 'wonen' && V(bNieuw).eigenaar === 'David', [g3, gOud, V(bNieuw)]);
  // 7. Jouw regels
  const L = C.regelsLijst(A, a);
  toets('Jouw regels: één actieve regel (Bouwmarkt Proef, uit, wonen, David) met het aantal boekingen; keuzes per boeking erbij', L.regels.length === 1 && L.regels[0].wie === 'Bouwmarkt Proef' && L.regels[0].richting === 'af' &&
    L.regels[0].categorie === 'wonen' && L.regels[0].boekingen === 1 && L.keuzes.some((k) => k.nr === b3 && k.categorie === 'vrije tijd en sport'), L);
  // 8. regel weg: posten die hem volgden rekenen weer automatisch; de keuze per boeking blijft
  const h2 = C.herstelApp(A, a, { regel: r3.regel });
  toets('terug naar automatisch (regel): regel inactief, nieuwe post weer zoals de AI/regel hem zou zetten (geen wonen), keuze per boeking (b3) blijft', h2.regel === r3.regel &&
    a.db.prepare('SELECT actief FROM regels WHERE id = ?').get(r3.regel).actief === 0 && V(bNieuw).categorie !== 'wonen' && V(bNieuw).regel_id === null && V(b3).categorie === 'vrije tijd en sport', [h2, V(bNieuw), V(b3)]);
  // b1 en b2 kregen een keuze via altijd (herkomst david per boeking): terugzetten
  C.herstelApp(A, a, { nr: b1 }); C.herstelApp(A, a, { nr: b2 }); C.herstelApp(A, a, { nr: b3 });
  toets('na alles terug: alle bouwmarktposten weer precies het oordeel van vóór', [b1, b2, b3, bRet, bEx, bPo].every((x) => kaal(V(x)) === voor[x]), [b1, b2, b3, bRet].map((x) => [kaal(V(x)), voor[x]]));
  toets('terug op een boeking die al automatisch is: geen fout, door auto', C.herstelApp(A, a, { nr: b1 }).door === 'auto', null);
  // 9. weigeringen
  const w = {
    pot: fout(() => C.corrigeerApp(A, a, { nr: bPo, categorie: 'wonen', altijd: false })),
    extern: fout(() => C.corrigeerApp(A, a, { nr: bEx, categorie: 'wonen', altijd: false })),
    eigen: fout(() => C.corrigeerApp(A, a, { nr: spaar, categorie: 'wonen', altijd: false })),
    paypalAltijd: fout(() => C.corrigeerApp(A, a, { nr: pp, categorie: 'vrije tijd en sport', altijd: true })),
    zonderNaamAltijd: fout(() => C.corrigeerApp(A, a, { nr: zonder, categorie: 'bankkosten', altijd: true })),
    usd: fout(() => C.corrigeerApp(A, a, { nr: usd, categorie: 'wonen', altijd: false })),
    intern: fout(() => C.corrigeerApp(A, a, { nr: b1, categorie: 'intern', altijd: false })),
    onbekend: fout(() => C.corrigeerApp(A, a, { nr: b1, categorie: 'auto van de buren', altijd: false })),
    eigExtern: fout(() => C.corrigeerApp(A, a, { nr: b1, eigenaar: 'extern', altijd: false })),
    eigPot: fout(() => C.corrigeerApp(A, a, { nr: b1, eigenaar: 'POT', altijd: false })),
    leeg: fout(() => C.corrigeerApp(A, a, { nr: b1, altijd: false })),
    zonderAltijd: fout(() => C.corrigeerApp(A, a, { nr: b1, categorie: 'wonen' })),
    nr: fout(() => C.corrigeerApp(A, a, { nr: 999999, categorie: 'wonen', altijd: false })),
    herstelPot: fout(() => C.herstelApp(A, a, { nr: bPo })),
    regelOnbekend: fout(() => C.herstelApp(A, a, { regel: 999 })),
    regelMk: fout(() => C.herstelApp(A, a, { regel: a.db.prepare("SELECT id FROM regels WHERE herkomst <> 'david' LIMIT 1").get()?.id || 1 })),
  };
  toets('weigeringen: POT, extern, eigen overboeking, betaaldienst+altijd, zonder naam+altijd, vreemde valuta, intern, onbekende categorie, eigenaar extern/POT, leeg, zonder keuze, onbekend nr/regel, regel van de machinekamer',
    Object.keys(w).every((k) => typeof w[k] === 'string'), w);
  toets('betaaldienst en zonder naam: alleen deze mag wel', fout(() => C.corrigeerApp(A, a, { nr: pp, categorie: 'vrije tijd en sport', altijd: false })) === null && V(pp).categorie === 'vrije tijd en sport' &&
    fout(() => C.corrigeerApp(A, a, { nr: zonder, categorie: 'bankkosten', altijd: false })) === null, V(pp));
  C.herstelApp(A, a, { nr: pp }); C.herstelApp(A, a, { nr: zonder });
  // 10. namen: alleen weergave
  const ahId = C.naamId(FO.tpWoorden('ALBERT HEIJN 1430'));
  const L2 = C.regelsLijst(A, a);
  toets('voorstel nette naam: ALBERT HEIJN 1430 → Albert Heijn (ketenlijst), met aantal', L2.voorstellen.some((v) => v.id === ahId && v.naam === 'Albert Heijn' && v.aantal === 2), L2.voorstellen);
  const nIban = fout(() => C.naamZet(A, a, { id: ahId, naam: 'NL91 ABNA 0417 1643 00' })), nLang = fout(() => C.naamZet(A, a, { id: ahId, naam: 'x'.repeat(41) })), nId = fout(() => C.naamZet(A, a, { id: '0123456789abcdef', naam: 'AH' }));
  toets('naam: IBAN-vorm, > 40 tekens en onbekende tegenpartij geweigerd', [nIban, nLang, nId].every((x) => typeof x === 'string'), [nIban, nLang, nId]);
  const nz = C.naamZet(A, a, { id: ahId, naam: 'AH om de hoek' });
  const bl = FO.boekingenLijst(A, a, { filter: { van: '2026-09', tot: '2026-11' }, nu: '2026-11-08', vault: W });
  const ahB = bl.boekingen.filter((x) => x.nr === ah)[0], b = FO.boekingen(a, '2026-09', '2026-11', null);
  const winkel = require(path.resolve('financien-bijsturen.js')).winkel;
  toets('naam in de weergave: boekingenlijst toont AH om de hoek met de banknaam apart; de logica (winkel-indeling) rekent nog op de banknaam', nz.naam === 'AH om de hoek' && ahB && ahB.tegenpartij === 'AH om de hoek' && ahB.bank === 'ALBERT HEIJN 1430' &&
    b.delen.filter((x) => x.nr === ah).every((x) => x.tegenpartij === 'ALBERT HEIJN 1430' && winkel(x) === 'Albert Heijn'), [nz, ahB]);
  toets('boekingenlijst: nr, door, kan, altijd_kan en keuzes (zonder intern; eigenaren zonder extern/POT)', ahB && ahB.kan === true && ahB.altijd_kan === true && ahB.door === 'auto' && bl.keuzes && bl.keuzes.categorieen.indexOf('intern') < 0 &&
    bl.keuzes.categorieen.indexOf('wonen') >= 0 && bl.keuzes.eigenaren.join() === 'David,Cynthia,samen,kind,Gambia-hulp' && bl.boekingen.filter((x) => x.nr === pp).every((x) => !x.altijd_kan), [ahB, bl.keuzes]);
  const L3 = C.regelsLijst(A, a);
  toets('Jouw regels: naam staat bij namen, niet meer bij voorstellen; geen IBAN in de uitvoer', L3.namen.some((x) => x.id === ahId && x.naam === 'AH om de hoek' && x.bank === 'ALBERT HEIJN 1430') && !L3.voorstellen.some((v) => v.id === ahId) &&
    !/NL\d{2}[A-Z]{4}/.test(JSON.stringify(L3)), L3);
  const nw = C.naamZet(A, a, { id: ahId, naam: null });
  toets('naam leeg = terug naar de banknaam', nw.naam === null && FO.boekingenLijst(A, a, { filter: { van: '2026-10', tot: '2026-10' }, nu: '2026-11-08', vault: W }).boekingen.filter((x) => x.nr === ah)[0].tegenpartij === 'ALBERT HEIJN 1430', nw);
  // 11. kruisproeven
  const kruis = (naam, bron, oud, nieuw) => { const k = bron.replace(oud, nieuw); if (k === bron) return null; const f = path.join(W, naam); fs.writeFileSync(f, k); return f; };
  const ab = fs.readFileSync('bank-archief.js', 'utf8');
  // (a) zonder de david-voorrang in verrijk: een keuze per boeking verdwijnt bij herverrijken
  const k1 = kruis('ba-k1.js', ab.replace(" WHERE verrijking.herkomst <> 'david' OR excluded.herkomst = 'david'\");", "\");"), "      if (oud && oud.herkomst === 'david') {", "      if (false) {");
  let k1rood = false;
  if (k1) { const BD2 = path.join(W, 'k1'); const A2 = require(k1); const a2 = A2.open(BD2); A2.rekeningenSync(a2, REK); A2.bij(a2, 'pr', PR.slice(0, 3), {}); A2.verrijk(a2);
    a2.db.prepare('SELECT * FROM transacties').all().forEach((t) => a2.db.prepare('INSERT OR REPLACE INTO ai_groepen (sleutel, type, categorie, subcategorie, ai_omschrijving, model, gemaakt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(A2.groepSleutel(t), 'uitgave', 'huishouden', null, null, 'proef', '2026-11-01'));
    const x = a2.db.prepare("SELECT nr FROM transacties WHERE tegenpartij = 'Bouwmarkt Proef' ORDER BY datum").get().nr; A2.corrigeer(a2, { nr: x, categorie: 'wonen', regel: false }); A2.metaZet(a2, 'vuil', '1'); A2.verrijk(a2);
    k1rood = a2.db.prepare('SELECT categorie FROM verrijking WHERE nr = ?').get(x).categorie !== 'wonen'; }
  toets('kruisproef: zonder de david-voorrang verdwijnt Davids keuze bij herverrijken (de voorrang doet dus iets)', !!k1 && k1rood, null);
  // (b) zonder herstel (herkomst blijft david): terug naar automatisch doet niets
  const k2 = kruis('ba-k2.js', ab, "UPDATE verrijking SET herkomst = 'regel', david_velden = NULL,", "UPDATE verrijking SET herkomst = herkomst, david_velden = david_velden,");
  let k2rood = false;
  if (k2) { const BD3 = path.join(W, 'k2'); const A3 = require(k2); const a3 = A3.open(BD3); A3.rekeningenSync(a3, REK); A3.bij(a3, 'pr', PR.slice(0, 3), {}); A3.verrijk(a3);
    const x = a3.db.prepare("SELECT nr FROM transacties WHERE tegenpartij = 'Bouwmarkt Proef' ORDER BY datum").get().nr; A3.corrigeer(a3, { nr: x, categorie: 'wonen', regel: false }); A3.herstel(a3, { nr: x });
    k2rood = a3.db.prepare('SELECT categorie FROM verrijking WHERE nr = ?').get(x).categorie === 'wonen'; }
  toets('kruisproef: zonder het terugzetten blijft de keuze staan (herstel doet dus iets)', !!k2 && k2rood, null);
  // (c) zonder het regelbereik: de regel raakt de post op de externe rekening
  const k3 = kruis('ba-k3.js', ab, "          if (!g.rek && ext.has(t.rek)) return false;", "");
  let k3rood = false;
  if (k3) { const BD4 = path.join(W, 'k3'); const A4 = require(k3); const a4 = A4.open(BD4); A4.rekeningenSync(a4, REK); A4.bij(a4, 'pr', PR.slice(0, 3), {}); A4.bij(a4, 'ex', EX, {});
    A4.corrigeer(a4, { rek: 'ex', eigenaar: 'extern' }); A4.verrijk(a4);
    const x = a4.db.prepare("SELECT nr FROM transacties WHERE tegenpartij = 'Bouwmarkt Proef' AND rek = 'pr' ORDER BY datum").get().nr; A4.corrigeer(a4, { nr: x, categorie: 'wonen', regel: true });
    k3rood = a4.db.prepare("SELECT v.categorie FROM verrijking v JOIN transacties t ON t.nr = v.nr WHERE t.rek = 'ex'").get().categorie === 'wonen'; }
  toets('kruisproef: zonder het regelbereik krijgt de externe rekening Davids categorie (het bereik doet dus iets)', !!k3 && k3rood, null);
  // (d) zonder samenvoegen: de tweede gedeeltelijke regel verliest de categorie
  const k4 = kruis('ba-k4.js', ab, "          return vorig[k] == null ? null : vorig[k];", "          return null;");
  let k4rood = false;
  if (k4) { const BD5 = path.join(W, 'k4'); const A5 = require(k4); const a5 = A5.open(BD5); A5.rekeningenSync(a5, REK); A5.bij(a5, 'pr', PR.slice(0, 3), {}); A5.verrijk(a5);
    const xs = a5.db.prepare("SELECT nr FROM transacties WHERE tegenpartij = 'Bouwmarkt Proef' ORDER BY datum").all().map((r) => r.nr);
    A5.corrigeer(a5, { nr: xs[0], categorie: 'wonen', regel: true }); const g = A5.corrigeer(a5, { nr: xs[1], eigenaar: 'David', regel: true });
    k4rood = a5.db.prepare('SELECT categorie FROM regels WHERE id = ?').get(g.regel).categorie !== 'wonen'; }
  toets('kruisproef: zonder samenvoegen verliest de tweede regel de categorie (het samenvoegen doet dus iets)', !!k4 && k4rood, null);
  // 12. bank-lezer zoals de pod het aanroept
  a.db.close();
  const kind = (inv) => { const q = spawnSync(process.execPath, ['--no-warnings', 'bank-lezer.js', 'app-corrigeer'], { input: JSON.stringify(inv), env: { PATH: process.env.PATH, BANK_DIR: BD, TZ: 'Europe/Amsterdam' }, encoding: 'utf8', timeout: 60000 });
    try { return JSON.parse(String(q.stdout).trim().split('\n').pop()); } catch (e) { return { stdout: String(q.stdout).slice(0, 200), stderr: String(q.stderr).slice(0, 300) }; } };
  const z1 = kind({ corrigeer: { actie: 'zet', nr: b2, categorie: 'wonen', eigenaar: null, altijd: false } }), z2 = kind({ corrigeer: { actie: 'lijst' } }), z3 = kind({ corrigeer: { actie: 'terug', nr: b2 } }),
    z4 = kind({ corrigeer: { actie: 'naam', id: ahId, naam: 'Albert Heijn' } }), z5 = kind({ corrigeer: { actie: 'zet', nr: bPo, categorie: 'wonen', altijd: false } }), z6 = kind({ corrigeer: { actie: 'wis' } }), z7 = kind({});
  toets('bank-lezer app-corrigeer: zet, lijst, terug en naam werken; POT, onbekende actie en lege invoer geweigerd', z1.ok === true && z1.nr === b2 && z2.ok === true && Array.isArray(z2.keuzes) && z2.keuzes.some((k) => k.nr === b2) &&
    z3.ok === true && z4.ok === true && z4.naam === 'Albert Heijn' && z5.ok === false && z6.ok === false && z7.ok === false, [z1, z3, z4, z5, z6, z7]);
}
// server.js: routes, poort, grenzen
const srv = fs.readFileSync('server.js', 'utf8');
toets('server.js: de vier routes in de routetabel naar appFinCorrigeer, schrijfroutes in de glijroutes, achter appPriveDicht en appTeller',
  /\['POST \/app\/financien\/corrigeer', 'POST \/app\/financien\/herstel', 'POST \/app\/financien\/naam', 'POST \/app\/financien\/regels'\]\.indexOf\(route\) >= 0\) return appFinCorrigeer/.test(srv) &&
  /\['POST \/app\/financien\/corrigeer', 'POST \/app\/financien\/herstel', 'POST \/app\/financien\/naam'\]\.forEach\(function \(r\) \{ APP_GLIJD_ROUTES\.add\(r\)/.test(srv) &&
  /async function appFinCorrigeer[\s\S]{0,300}appPriveDicht\(a, 'financien'\)/.test(srv) && /appTeller\('fin-corrigeer'/.test(srv) && /appTeller\('fin-naam'/.test(srv) && /appTeller\('fin-regels'/.test(srv), null);
toets('server.js: app-corrigeer in BANK_LOKAAL, niet in BANK_OPDRACHTEN (niet via /smal/bank)', /const BANK_LOKAAL = \[[^\]]*'app-corrigeer'/.test(srv) && !/const BANK_OPDRACHTEN = \[[^\]]*'app-corrigeer/.test(srv), null);
const rel = fs.readFileSync('uitrol.sh', 'utf8'), dock = fs.readFileSync('Dockerfile', 'utf8'), fc = fs.readFileSync('financien-corrigeer.js', 'utf8');
toets('release: financien-corrigeer.js in RELEASE_OPTIONEEL en de Dockerfile', /RELEASE_OPTIONEEL="[^"]*\bfinancien-corrigeer\.js\b/.test(rel) && /COPY financien-corrigeer\.js \/app\/release-bootstrap\/financien-corrigeer\.js/.test(dock), null);
toets('financien-corrigeer.js laadt geen netwerk- of procesmodule', !/require\(['"](https?|net|tls|dgram|child_process|dns)['"]\)/.test(fc), null);
try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {}
console.log(`\n${goed} groen, ${fouten} rood`);
process.exit(fouten ? 1 : 0);
JS
