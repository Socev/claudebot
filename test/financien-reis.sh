#!/usr/bin/env bash
# Toetst financien-reis.js (wv2715, idee 3 uit Sure: kosten per reis; ontwerp vault "01_Ontwikkeling/Financiën - ideeën uit Sure
# (ontwerp 8-11-2026)" § 2) op een nagebootste transactiedatabase met verzonnen reizen en boekingen: ter plekke alleen in een reisland of
# een reispost (thuisuitgaven en één buitenlandse webwinkel niet), marge 2 dagen, overlap = één winnaar (review MOET 1), vooraf naar de
# eerstvolgende reis en na Nee door naar de volgende, termijnen volgen een erbij, een terugbetaling vóór de reis is te koppelen (review
# MOET 2), labels erbij/eraf/terug (één reis per boeking, hernoemde reis via de titel), weigering buiten het venster, totaal = som;
# bank-lezer app-reizen/app-reislabel; de routes in server.js. Kruisproef: zonder de reisland-regel wordt de toets rood.
# Raakt de pod, de kluis, de bank, de vault en /opt/data/bank niet. Gebruik: bash test/financien-reis.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings --require ./test/vaste-klok.cjs - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 900) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'financien-reis-'));
const BD = path.join(W, 'bank');
const A = require(path.resolve('bank-archief.js'));
let R = null;
try { R = require(path.resolve('financien-reis.js')); } catch (e) { R = null; }
toets('financien-reis.js bestaat en laadt', !!R, null);
const REK = {
  pr: { bron: 'bunq', uid: 'bunq-1', bunq_id: 1, naam: 'Hoofdrekening', soort: 'lopend', iban: 'NL11BUNQ0000000001', status: 'ACTIVE' },
  sp: { bron: 'bunq', uid: 'bunq-5', bunq_id: 5, naam: 'Spaar', soort: 'spaar', iban: 'NL55BUNQ0000000005', status: 'ACTIVE' },
  ki: { bron: 'bunq', uid: 'bunq-6', bunq_id: 6, naam: 'Kids', soort: 'lopend', iban: 'NL66BUNQ0000000006', status: 'ACTIVE' },
};
let n = 0;
const kaart = (land) => ({ type: 'MASTERCARD', counterparty_alias: { country: land } });
const p = (datum, bedrag, tegen, oms, extra, ruw) => Object.assign({ id: 'x:' + (++n), datum: datum, valutadatum: datum, bedrag: bedrag, valuta: 'EUR', tegenpartij: tegen, omschrijving: oms || null,
  status: 'geboekt', saldo_na: null, mcc: null, tegen_iban: null, _ruw: Object.assign({ id: n, bron: 'nagebootst' }, ruw || {}) }, extra || {});
const PR = [], SP = [], KI = [];
PR.push(p('2025-01-05', -20, 'Bakker Proef', 'brood'));                                                       // buiten elk venster
PR.push(p('2025-02-01', -500, 'Campingbureau Proef', 'Boeking 88001234-555 aanbetaling'));                    // termijn 1
PR.push(p('2025-03-01', -900, 'Vliegmaatschappij Proef', 'tickets'));                                        // vooraf, eerst naar R2
PR.push(p('2024-09-01', -300, 'Toscane Tours', 'excursie'));                                                 // naam van de reis, 312 dagen vooraf
PR.push(p('2025-05-01', 100, 'Vliegmaatschappij Proef', 'teruggave stoelkeuze', { mcc: '4511' }));           // terugbetaling vóór de reis (MOET 2)
PR.push(p('2025-06-01', -1500, 'Campingbureau Proef', 'Boeking 88001234-555 restbetaling'));                  // termijn 2
PR.push(p('2025-06-21', -70, 'Smorrebrod Proef', 'Smorrebrod Proef Kobenhavn, DK', {}, kaart('DK')));
PR.push(p('2025-06-22', -30, 'Kaffe Proef', 'Kaffe Proef Kobenhavn, DK', {}, kaart('DK')));
PR.push(p('2025-07-11', -50, 'Trattoria Proef', 'Trattoria Proef Siena, IT', {}, kaart('IT')));
PR.push(p('2025-07-12', -30, 'Supermercato Proef', 'Supermercato Proef Siena, IT', {}, kaart('IT')));
PR.push(p('2025-07-12', -80, 'Albert Heijn 1234', 'Albert Heijn 1234 THUIS, NL', {}, kaart('NL')));        // thuis
PR.push(p('2025-07-12', -500, 'Spaar', 'sparen', { tegen_iban: REK.sp.iban })); SP.push(p('2025-07-12', 500, 'D. Voorbeeld', 'sparen', { tegen_iban: REK.pr.iban }));
PR.push(p('2025-07-12', -40, 'Ver Weg Winkel', 'in dollars', { valuta: 'USD' }, kaart('US')));
PR.push(p('2025-07-15', -40, 'Rifugio Proef', 'Rifugio Proef Monte, IT', {}, kaart('IT')));                // overlap R1/R3 → R3
PR.push(p('2025-07-15', -10, 'Gelateria Proef', 'Gelateria Proef Monte, IT', {}, kaart('IT')));
PR.push(p('2025-07-15', -200, 'Energie Proef', 'SEPA Incasso termijn'));                                    // vaste last
PR.push(p('2025-07-21', -60, 'Autogrill Proef', 'Autogrill Proef Verona, IT', {}, kaart('IT')));            // tot + 1
PR.push(p('2025-07-25', -45, 'Trattoria Laat', 'Trattoria Laat Verona, IT', {}, kaart('IT')));             // tot + 5: niet, wel in meer
KI.push(p('2025-07-13', -25, 'Webwinkel Proef', 'Webwinkel Proef Gent, BE', {}, kaart('BE')));              // één losse buitenlandse webwinkel
PR.push(p('2025-07-14', -4, 'Appwinkel Proef', 'Appwinkel Proef Dublin, IE', { mcc: '5818' }, kaart('IE')));  // online (digitale goederen), 2× in de periode
PR.push(p('2025-07-16', -9, 'Boekenapp Proef', 'Boekenapp Proef boekenapp.ie, IE', {}, kaart('IE')));          // online (webadres als plaats)
const a = A.open(BD);
A.rekeningenSync(a, REK);
A.bij(a, 'pr', PR, {}); A.bij(a, 'sp', SP, {}); A.bij(a, 'ki', KI, {});
A.corrigeer(a, { rek: 'ki', eigenaar: 'kind' });
A.verrijk(a);
const zet = (where, cat) => a.db.prepare("UPDATE verrijking SET categorie = ?, herkomst = 'david', david_velden = 'categorie' WHERE nr IN (SELECT nr FROM transacties WHERE " + where + ')').run(cat);
zet("tegenpartij IN ('Campingbureau Proef', 'Vliegmaatschappij Proef') AND bedrag < 0", 'vakantie en reizen');
zet("tegenpartij = 'Vliegmaatschappij Proef' AND bedrag > 0", 'teruggave en terugbetaling');
zet("tegenpartij IN ('Toscane Tours', 'Trattoria Proef', 'Trattoria Laat', 'Smorrebrod Proef', 'Kaffe Proef', 'Rifugio Proef', 'Gelateria Proef', 'Autogrill Proef')", 'horeca en uit eten');
zet("tegenpartij IN ('Supermercato Proef', 'Albert Heijn 1234')", 'boodschappen');
zet("tegenpartij = 'Webwinkel Proef'", 'kinderen');
zet("tegenpartij = 'Bakker Proef'", 'boodschappen');
zet("tegenpartij = 'Energie Proef'", 'wonen');
a.db.prepare("UPDATE verrijking SET abonnement_id = 9 WHERE nr IN (SELECT nr FROM transacties WHERE tegenpartij = 'Energie Proef')").run();
const nrVan = (tp, d) => a.db.prepare('SELECT nr FROM transacties WHERE tegenpartij = ?' + (d ? ' AND datum = ?' : '') + ' ORDER BY datum').get(...[tp].concat(d ? [d] : [])).nr;
const R1 = { id: 'aaaaaaaaaaa1', titel: 'Zomervakantie 2025 - Toscane', van: '2025-07-10', tot: '2025-07-20', soort: 'vakantie', stand: 'geweest' };
const R2 = { id: 'bbbbbbbbbbb2', titel: 'Weekend Kopenhagen', van: '2025-06-20', tot: '2025-06-22', soort: 'weekend', stand: 'geweest' };
const R3 = { id: 'ccccccccccc3', titel: 'Wandeltocht Monte', van: '2025-07-14', tot: '2025-07-16', soort: 'actief', stand: 'geweest' };
const R4 = { id: 'ddddddddddd4', titel: 'Afgezegd Parijs', van: '2025-07-11', tot: '2025-07-13', soort: 'weekend', stand: 'geannuleerd' };
const LIJST = [R1, R2, R3, R4, { id: 'zzz', titel: 'kapot', van: 'x', tot: 'y' }, { id: 'eeeeeeeeeee5', titel: 'omgekeerd', van: '2025-08-10', tot: '2025-08-01' }];
if (R) {
  const ov = (reis, lijst) => R.reizenOverzicht(A, a, { reizen: lijst || LIJST, reis: reis || null, nu: '2025-11-08' });
  const lab = (reis, nr, keuze, lijst) => { try { return R.labelZet(A, a, { reizen: lijst || LIJST, reis: reis, nr: nr, keuze: keuze }); } catch (e) { return { fout: e.message }; } };
  const o = ov();
  toets('reizenOpVorm: geannuleerd, kapotte en omgekeerde periode vallen weg; nieuwste eerst', o.reizen.map((r) => r.id).join() === [R3.id, R1.id, R2.id].join(), o.reizen.map((r) => r.id));
  const d1 = ov(R1.id).reis, d2 = ov(R2.id).reis, d3 = ov(R3.id).reis;
  const namen = (d, f) => d.posten.filter(f || (() => true)).map((x) => x.naam).sort();
  toets('reisland: IT bij R1 en R3 (≥ 2 kaartbetalingen strikt in de periode), DK bij R2; BE (één webwinkel), IE (twee online betalingen) en NL niet', d1.landen.join() === 'IT' && d3.landen.join() === 'IT' && d2.landen.join() === 'DK', [d1.landen, d2.landen, d3.landen]);
  toets('ter plekke R1: trattoria, supermarkt en de autogrill van tot + 1; niet thuis (AH), niet de webwinkel, niet tot + 5, geen vaste last, geen intern, geen USD',
    JSON.stringify(namen(d1, (x) => !x.vooraf)) === JSON.stringify(['Autogrill Proef', 'Supermercato Proef', 'Trattoria Proef']), namen(d1));
  toets('online betalingen (appwinkel mcc 5818, webadres als plaats) zijn geen voorstel en staan wel in meer', !d1.posten.some((x) => /Appwinkel|Boekenapp/.test(x.naam)) && d1.meer.some((x) => x.naam === 'Appwinkel Proef'), namen(d1));
  toets('overlap (review MOET 1): rifugio en gelateria op 15-7 bij de kortste reis (R3), niet ook bij R1', JSON.stringify(namen(d3)) === JSON.stringify(['Gelateria Proef', 'Rifugio Proef']) &&
    !d1.posten.some((x) => /Rifugio|Gelateria/.test(x.naam)), [namen(d1), namen(d3)]);
  toets('vooraf: tickets en beide termijnen naar de eerstvolgende reis (R2), "Toscane Tours" op naam naar R1 (312 dagen vooraf)', ['Vliegmaatschappij Proef', 'Campingbureau Proef'].every((t) => d2.posten.some((x) => x.naam === t && x.vooraf && x.status === 'voorstel')) &&
    d1.posten.some((x) => x.naam === 'Toscane Tours' && x.vooraf && /naam van de reis/.test(x.waarom)), [namen(d2), namen(d1)]);
  toets('totaal = bevestigd + voorstellen ter plekke; vooraf telt pas na ja (vraag_vooraf); per dag = totaal / dagen', d1.totaal === 140 && d1.open === 140 && d1.bevestigd === 0 && d1.vraag_vooraf === 300 &&
    d1.per_dag === Math.round(140 / 11 * 100) / 100 && d2.totaal === 100 && d2.vraag_vooraf === 2900 && d1.ter_plekke === 140 && d1.vooraf === 0, [d1.totaal, d1.open, d1.vraag_vooraf, d1.per_dag, d2.totaal, d2.vraag_vooraf]);
  toets('per categorie telt op tot het totaal; lijst gelijk aan de reis', Math.abs(d1.per_categorie.reduce((s, c) => s + c.bedrag, 0) - d1.totaal) < 0.01 && o.reizen.find((r) => r.id === R1.id).totaal === d1.totaal, d1.per_categorie);
  toets('meer: AH thuis, de webwinkel en tot + 5 staan erbij om zelf toe te voegen; de terugbetaling vóór de reis ook (review MOET 2)', ['Albert Heijn 1234', 'Webwinkel Proef', 'Trattoria Laat'].every((t) => d1.meer.some((x) => x.naam === t)) &&
    d1.meer.some((x) => x.naam === 'Vliegmaatschappij Proef' && x.bedrag === -100) && d1.meer.some((x) => x.naam === 'Rifugio Proef' && x.elders === R3.titel), d1.meer.map((x) => [x.naam, x.bedrag, x.elders]));
  toets('geen IBAN in het antwoord', !/NL\d{2}[A-Z]{4}\d{6,}/.test(JSON.stringify(ov(R1.id))), null);
  // labels
  const vlieg = nrVan('Vliegmaatschappij Proef', '2025-03-01'), term1 = nrVan('Campingbureau Proef', '2025-02-01'), term2 = nrVan('Campingbureau Proef', '2025-06-01'), terug = nrVan('Vliegmaatschappij Proef', '2025-05-01');
  const l1 = lab(R2.id, vlieg, 'eraf'), e1 = ov(R1.id).reis, e2 = ov(R2.id).reis;
  toets('Nee bij R2 op een vooraf-voorstel: het schuift door naar R1 (eerstvolgende daarna)', !l1.fout && e1.posten.some((x) => x.nr === vlieg && x.status === 'voorstel' && x.vooraf) && !e2.posten.some((x) => x.nr === vlieg), [l1, namen(e2)]);
  const l2 = lab(R1.id, term2, 'erbij'), f1 = ov(R1.id).reis, f2 = ov(R2.id).reis;
  toets('erbij op termijn 2 bij R1: termijn 1 volgt als sterk voorstel en telt mee; beide weg bij R2', !l2.fout && f1.posten.some((x) => x.nr === term2 && x.status === 'erbij') && f1.posten.some((x) => x.nr === term1 && x.status === 'voorstel' && x.sterk) &&
    f1.totaal === 140 + 1500 + 500 && f1.bevestigd === 1500 && !f2.posten.some((x) => x.nr === term1 || x.nr === term2), [l2, f1.totaal, namen(f2)]);
  const l3 = lab(R1.id, terug, 'erbij'), g1 = ov(R1.id).reis;
  toets('de terugbetaling vóór de reis erbij: totaal 100 lager', !l3.fout && g1.totaal === 140 + 1500 + 500 - 100, [l3, g1.totaal]);
  const l4 = lab(R2.id, term2, 'erbij'), h1 = ov(R1.id).reis, h2 = ov(R2.id).reis, rijen = a.db.prepare('SELECT reis, keuze FROM reis_label WHERE nr = ?').all(term2);
  toets('één reis per boeking: erbij bij R2 haalt de erbij bij R1 weg', !l4.fout && rijen.length === 1 && rijen[0].reis === R2.id && h2.posten.some((x) => x.nr === term2 && x.status === 'erbij') && !h1.posten.some((x) => x.nr === term2 && x.status === 'erbij'), rijen);
  const l5 = lab(R2.id, term2, null), rij5 = a.db.prepare('SELECT count(*) AS n FROM reis_label WHERE nr = ?').get(term2).n;
  toets('null = terug naar het voorstel (rij weg)', !l5.fout && l5.keuze === null && rij5 === 0, [l5, rij5]);
  const triat = nrVan('Trattoria Proef'), i0 = ov(R1.id).reis;
  const l6 = lab(R1.id, triat, 'eraf'), i1 = ov(R1.id).reis;
  toets('Nee op een voorstel ter plekke: status eraf, telt niet meer (totaal 50 lager)', !l6.fout && i1.posten.some((x) => x.nr === triat && x.status === 'eraf') && i1.aantal.eraf === 1 && i1.totaal === Math.round((i0.totaal - 50) * 100) / 100, [l6, i1.totaal, i0.totaal]);
  toets('weigering: boeking buiten het venster, onbekende reis, geannuleerde reis, rare keuze of nr', /buiten deze reis/.test(lab(R2.id, nrVan('Bakker Proef'), 'erbij').fout || '') && /onbekende reis/.test(lab('fffffffffff9', triat, 'erbij').fout || '') &&
    /onbekende reis/.test(lab(R4.id, triat, 'erbij').fout || '') && /keuze/.test(lab(R1.id, triat, 'ja').fout || '') && /onbekende boeking/.test(lab(R1.id, 'x', 'erbij').fout || '') && /onbekende reis/.test((() => { try { ov('fffffffffff9'); return ''; } catch (e) { return e.message; } })()), null);
  // hernoemde reispagina: nieuwe id, zelfde titel → de labels tellen nog
  const R1b = Object.assign({}, R1, { id: 'aaaaaaaaaab1' }), L2 = [R1b, R2, R3], j1 = ov(R1b.id, L2).reis;
  toets('hernoemde reis (nieuwe id, zelfde titel): Davids erbij en eraf tellen nog; een nieuwe tik vervangt de oude rij', j1.posten.some((x) => x.nr === terug && x.status === 'erbij') && j1.posten.some((x) => x.nr === triat && x.status === 'eraf') &&
    !lab(R1b.id, triat, null, L2).fout && a.db.prepare('SELECT count(*) AS n FROM reis_label WHERE nr = ?').get(triat).n === 0, j1.posten.map((x) => [x.naam, x.status]));
  toets('totaal = som van wat telt (erbij + voorstel ter plekke + sterk)', [R1, R2, R3].every((r) => { const d = ov(r.id).reis; return Math.abs(d.totaal - d.posten.filter((x) => x.status === 'erbij' || (x.status === 'voorstel' && (!x.vooraf || x.sterk))).reduce((s, x) => s + x.bedrag, 0)) < 0.01; }), null);
  // kruisproef: zonder de reisland-regel (elk land telt) moeten de thuisuitgave en de webwinkel bij R1 komen: de toets hierboven zou rood zijn
  const bron = fs.readFileSync('financien-reis.js', 'utf8'), kapot = bron.replace("(x.land && !x.online && landen.get(r.id).indexOf(x.land) >= 0) || x.categorie === REIS_CAT", "x.land || x.categorie === REIS_CAT");
  const kp = path.join(W, 'financien-reis-kruis.js');
  fs.writeFileSync(kp, kapot.replace("require('./financien-overzicht.js')", "require(" + JSON.stringify(path.resolve('financien-overzicht.js')) + ")"));
  const K = require(kp), kd = K.reizenOverzicht(A, a, { reizen: LIJST, reis: R1.id, nu: '2025-11-08' }).reis;
  toets('kruisproef: zonder reisland-regel komen AH thuis en de webwinkel bij de reis (de regel doet dus iets)', kapot !== bron && kd.posten.some((x) => x.naam === 'Albert Heijn 1234') && kd.posten.some((x) => x.naam === 'Webwinkel Proef'), namen(kd));
  const kapot2 = bron.replace("if (ONLINE_MCC.indexOf(Number(mcc)) >= 0) return true;", "return false;"), kp2 = path.join(W, 'financien-reis-kruis2.js');
  fs.writeFileSync(kp2, kapot2.replace("require('./financien-overzicht.js')", "require(" + JSON.stringify(path.resolve('financien-overzicht.js')) + ")"));
  const kd2 = require(kp2).reizenOverzicht(A, a, { reizen: LIJST, reis: R1.id, nu: '2025-11-08' }).reis;
  toets('kruisproef: zonder de online-uitsluiting wordt IE een reisland (de regel doet dus iets)', kapot2 !== bron && kd2.landen.indexOf('IE') >= 0, kd2.landen);
  // bank-lezer zoals de pod het aanroept
  const kind = (op, inv) => { const q = spawnSync(process.execPath, ['--no-warnings', 'bank-lezer.js', op], { input: JSON.stringify(inv), env: { PATH: process.env.PATH, BANK_DIR: BD, TZ: 'Europe/Amsterdam' }, encoding: 'utf8', timeout: 60000 });
    try { return JSON.parse(String(q.stdout).trim().split('\n').pop()); } catch (e) { return { stdout: String(q.stdout).slice(0, 200), stderr: String(q.stderr).slice(0, 300) }; } };
  const k1 = kind('app-reizen', { reizen: { lijst: LIJST, reis: null } }), k2 = kind('app-reizen', { reizen: { lijst: LIJST, reis: R1.id } }), k3 = kind('app-reizen', { reizen: { lijst: LIJST, reis: '../x' } }),
    k4 = kind('app-reislabel', { reislabel: { lijst: LIJST, reis: R1.id, nr: triat, keuze: 'eraf' } }), k5 = kind('app-reislabel', { reislabel: { lijst: LIJST, reis: R1.id, nr: triat, keuze: 'weg' } }), k6 = kind('app-reizen', {});
  toets('bank-lezer app-reizen/app-reislabel: lijst en reis met posten; rare reis, keuze of invoer geweigerd', k1.ok === true && k1.reizen.length === 3 && k2.ok === true && k2.reis && k2.reis.posten.length > 0 &&
    k3.ok === false && k4.ok === true && k4.keuze === 'eraf' && k5.ok === false && k6.ok === false, [k1.ok, k2.ok, k3, k4, k5, k6]);
}
// server.js: routes, poort, grenzen
const srv = fs.readFileSync('server.js', 'utf8');
toets('server.js: POST /app/financien/reizen en /reislabel in de routetabel, reislabel in de glijroutes, achter appPriveDicht en appTeller', /route === 'POST \/app\/financien\/reizen'\) return appFinReizen/.test(srv) && /route === 'POST \/app\/financien\/reislabel'\) return appFinReislabel/.test(srv) &&
  /APP_GLIJD_ROUTES\.add\('POST \/app\/financien\/reislabel'\)/.test(srv) && /async function appFinReizen[\s\S]{0,300}appPriveDicht\(a, 'financien'\)/.test(srv) && /async function appFinReislabel[\s\S]{0,300}appPriveDicht\(a, 'financien'\)/.test(srv) &&
  /appTeller\('fin-reizen'/.test(srv) && /appTeller\('fin-reislabel'/.test(srv), null);
toets('server.js: app-reizen/app-reislabel in BANK_LOKAAL, niet in BANK_OPDRACHTEN (niet via /smal/bank); reizen uit Tripper zonder pad', /const BANK_LOKAAL = \[[^\]]*'app-reizen', 'app-reislabel'/.test(srv) && !/const BANK_OPDRACHTEN = \[[^\]]*'app-reis/.test(srv) &&
  /function appFinReizenLijst[\s\S]{0,500}return \{ id: String\(r\.id\), titel: String\(r\.titel \|\| ''\)\.slice\(0, 120\), van: r\.van, tot: r\.tot, soort: r\.soort \|\| null, stand: r\.stand \|\| null \}/.test(srv), null);
const rel = fs.readFileSync('uitrol.sh', 'utf8'), dock = fs.readFileSync('Dockerfile', 'utf8');
toets('release: financien-reis.js in RELEASE_OPTIONEEL en de Dockerfile', /RELEASE_OPTIONEEL="[^"]*\bfinancien-reis\.js\b/.test(rel) && /COPY financien-reis\.js \/app\/release-bootstrap\/financien-reis\.js/.test(dock), null);
try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {}
console.log(`\n${goed} groen, ${fouten} rood`);
process.exit(fouten ? 1 : 0);
JS
