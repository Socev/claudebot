#!/usr/bin/env bash
# Toetst "Nu en straks" (wv3924, besluitenpagina nr 151 = 2C51) in financien-plan.js op verzonnen delen en reeksen: dezeMaand (tot dezelfde
# dag, eenmalig en jaarpost apart, gelijk/minder/meer, kortere maand), recentVan (ongewoon: uitschieter, eenmalig, nieuwe tegenpartij; intern),
# nieuwSinds (eerste bezoek = 7 dagen, 0 direct na het bezoek, intern niet bij de grootste), komende (14 dagen, nog niet gezien, storting
# erbij of al binnen, haalt / haalt niet op volgorde van datum, geen saldo) en de koppelingen in overzicht, financien-app.js en server.js.
# Raakt de pod, de bank en de vault niet. Gebruik: bash test/financien-nu.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }
const P = require(path.resolve('financien-plan.js'));
toets('financien-plan.js heeft dezeMaand, recentVan, nieuwSinds en komende', ['dezeMaand', 'recentVan', 'nieuwSinds', 'komende'].every((f) => typeof P[f] === 'function'));
if (typeof P.dezeMaand !== 'function') { console.log('KLAAR ' + goed + ' groen, ' + fouten + ' rood'); process.exit(1); }
// ── dezeMaand ──
const twaalf = []; for (let i = 12; i >= 1; i--) { const d = new Date(Date.UTC(2026, 10 - i, 1)); twaalf.push(d.toISOString().slice(0, 7)); }
let nr = 1; const delen = [];
const deel = (datum, stroom, bedrag, x) => delen.push(Object.assign({ nr: nr++, datum, maand: datum.slice(0, 7), stroom, deel: bedrag, bedrag, id: 'tp' + nr, naam: 'Winkel', eenmalig: false, jaar: null }, x || {}));
twaalf.forEach((m) => { deel(m + '-05', 'leven', -1000); deel(m + '-25', 'leven', -2000); deel(m + '-24', 'inkomen', 5000); });
deel('2026-01-15', 'inkomen', 24000, { jaar: 'dividend' });   // jaarpost: telt niet in "gewoonlijk binnen"
deel('2026-11-03', 'leven', -700); deel('2026-11-10', 'leven', -1500, { eenmalig: true }); deel('2026-11-08', 'intern', -400);
let dm = P.dezeMaand(delen, { nu: '2026-11-20', twaalf });
toets('deze maand t/m 20e: 700 uitgegeven, gewoon 1.000 (de 25e telt nog niet), minder', dm.uitgegeven === 700 && dm.gewoon_uitgegeven === 1000 && dm.oordeel === 'minder' && /€ 700 uitgegeven, € 300 minder dan een gewone maand op deze dag \(€ 1\.000\)/.test(dm.zin), dm);
toets('eenmalig groot apart genoemd, intern telt niet', dm.eenmalig === 1500 && /Daarbovenop € 1\.500 eenmalig groot/.test(dm.zin), dm.zin);
toets('binnen: 0 tegen gewoonlijk 0 op de 20e (dividend telt niet mee)', dm.binnen === 0 && dm.gewoon_binnen === 0 && /Binnengekomen: € 0, zoals gewoonlijk/.test(dm.zin), dm);
deel('2026-11-12', 'leven', -330);
dm = P.dezeMaand(delen, { nu: '2026-11-20', twaalf });
toets('binnen € 100 / 10 %: "ongeveer"', dm.oordeel === 'gelijk' && /ongeveer wat een gewone maand op deze dag kost/.test(dm.zin), dm.zin);
deel('2026-11-15', 'leven', -800);
dm = P.dezeMaand(delen, { nu: '2026-11-26', twaalf });
toets('na de 25e: gewoon 3.000, nu 1.830 → minder; binnen 0 tegen 5.000 gewoonlijk', dm.gewoon_uitgegeven === 3000 && dm.oordeel === 'minder' && /gewoonlijk € 5\.000 op deze dag/.test(dm.zin), dm);
deel('2026-11-26', 'leven', -2500);
dm = P.dezeMaand(delen, { nu: '2026-11-26', twaalf });
toets('meer dan gewoon → toon let', dm.oordeel === 'meer' && dm.toon === 'let' && /meer dan een gewone maand/.test(dm.zin), dm);
const kort = P.dezeMaand([{ nr: 1, datum: '2026-02-28', maand: '2026-02', stroom: 'leven', deel: -90 }, { nr: 2, datum: '2026-03-31', maand: '2026-03', stroom: 'leven', deel: -50 }], { nu: '2026-03-31', twaalf: ['2026-02', '2026-02', '2026-02'] });
toets('kortere maand telt tot zijn laatste dag (31 → 28 feb)', kort.gewoon_uitgegeven === 90, kort);
toets('te weinig volle maanden: geen vergelijking, wel een zin', P.dezeMaand(delen, { nu: '2026-11-20', twaalf: twaalf.slice(0, 2) }).oordeel === null);
// ── recentVan ──
const rd = [
  { nr: 101, datum: '2026-11-18', maand: '2026-11', stroom: 'leven', deel: -45, bedrag: -45, id: 'ah', naam: 'Supermarkt' },
  { nr: 102, datum: '2026-11-18', maand: '2026-11', stroom: 'leven', deel: -900, bedrag: -900, id: 'gar', naam: 'Garage' },
  { nr: 103, datum: '2026-11-19', maand: '2026-11', stroom: 'leven', deel: -1200, bedrag: -1200, id: 'meu', naam: 'Meubelzaak', eenmalig: true },
  { nr: 104, datum: '2026-11-19', maand: '2026-11', stroom: 'intern', deel: -5000, bedrag: -5000, id: 'spaar', naam: 'Spaarrekening' },
  { nr: 105, datum: '2026-11-19', maand: '2026-11', stroom: 'leven', deel: -300, bedrag: -300, id: 'nieuwtp', naam: 'Nieuwe Winkel' },
  { nr: 106, datum: '2026-11-20', maand: '2026-11', stroom: 'inkomen', deel: 3000, bedrag: 3000, id: 'loon', naam: 'Werkgever' },
  { nr: 90, datum: '2026-06-01', maand: '2026-06', stroom: 'leven', deel: -80, bedrag: -80, id: 'gar', naam: 'Garage' },
  { nr: 91, datum: '2026-06-02', maand: '2026-06', stroom: 'leven', deel: -40, bedrag: -40, id: 'ah', naam: 'Supermarkt' },
];
const gezien = [101, 102, 103, 104, 105, 106].map((n, i) => ({ nr: n, eerste_gezien: '2026-11-2' + (i < 3 ? '0T08:00:00.000Z' : '1T09:00:00.000Z') })).concat([{ nr: 999, eerste_gezien: '2026-11-21T09:00:00.000Z' }]);
const rc = P.recentVan(rd, { gezien, uitschieters: [{ datum: '2026-11-18', bedrag: 900, keer: 11.3, filter: { id: 'gar' } }] });
const per = new Map(rc.map((x, i) => [[101, 102, 103, 104, 105, 106].find((n) => rd.find((d) => d.nr === n).naam === x.naam), x]));
toets('recent: geen boekingsnummer naar buiten', rc.every((x) => !('nr' in x)), rc[0]);
toets('recent: alleen bekende boekingen (999 = andere valuta of buiten venster weg)', rc.length === 6, rc.map((x) => x.naam));
toets('ongewoon: uitschieter met keer, eenmalig groot, nieuwe tegenpartij ≥ € 250', /11,3× de gebruikelijke post/.test(per.get(102).ongewoon) && per.get(103).ongewoon === 'eenmalig groot' && per.get(105).ongewoon === 'nieuwe tegenpartij', rc);
toets('niet ongewoon: gewone boodschap; intern gemarkeerd', !per.get(101).ongewoon && per.get(104).intern === true, [per.get(101), per.get(104)]);
// ── nieuwSinds ──
const NU = { recent: rc, recent_tot: '2026-11-21T09:00:00.000Z' }, nuMs = Date.parse('2026-11-21T12:00:00Z');
let nw = P.nieuwSinds(NU, null, nuMs);
toets('eerste bezoek: de laatste 7 dagen, alle 6', nw.eerste && nw.aantal === 6 && /^De laatste 7 dagen: 6 nieuwe boekingen \(1 tussen je eigen rekeningen\)/.test(nw.zin), nw.zin);
toets('grootste drie zonder intern (Werkgever 3.000 bij, Meubelzaak, Garage)', nw.grootste.map((x) => x.naam).join(',') === 'Werkgever,Meubelzaak,Garage' && /Werkgever € 3\.000 bij/.test(nw.zin), nw.grootste);
toets('ongewoon in de zin, toon let', /Ongewoon: Meubelzaak € 1\.200 \(eenmalig groot\), Garage € 900 \(11,3× de gebruikelijke post\), Nieuwe Winkel € 300 \(nieuwe tegenpartij\)\./.test(nw.zin) && nw.toon === 'let', nw.zin);
nw = P.nieuwSinds(NU, '2026-11-20T12:00:00.000Z', nuMs, '2026-11-20T12:05:00.000Z');
toets('sinds een bezoek gisteren: 3 nieuw, tekst met het bezoekmoment', nw.aantal === 3 && /^Sinds je laatste bezoek \(gisteren 13:05\): 3 nieuwe boekingen/.test(nw.zin), nw.zin);
nw = P.nieuwSinds(NU, NU.recent_tot, nuMs, '2026-11-21T11:59:00.000Z');
toets('direct na het bezoek (sinds = recent_tot): 0, niets nieuws', nw.aantal === 0 && /^Sinds je laatste bezoek \(vandaag 12:59\) niets nieuws van de bank\.$/.test(nw.zin) && nw.tot === NU.recent_tot, nw);
toets('kapotte sinds = eerste bezoek (geen fout)', P.nieuwSinds(NU, 'onzin', nuMs).eerste === true);
// ── komende ──
const reeks = (sleutel, bedrag, vv, laatste, ritme) => ({ sleutel, bedrag, verwacht_volgende: vv, laatste, ritme: ritme || 'maand', n_per_maand: 1 });
const rijen = [{ naam: 'ABN AMRO BANK NV', soort_post: 'Hypotheek', sleutels: ['h'] }, { naam: 'Lease', sleutels: ['l'] }, { naam: 'Zorg', sleutels: ['z'] }, { naam: 'Jaarpolis', sleutels: ['j'] }, { naam: 'Ver weg', sleutels: ['v'] }, { naam: 'PayPal paraplu', sleutels: ['p'] }];
const reeksen = [reeks('h', 2000, '2026-12-01', '2026-11-01'), reeks('l', 400, '2026-12-01', '2026-11-01'), reeks('z', 250, '2026-11-18', '2026-10-18'),
  reeks('j', 1800, '2026-11-25', '2025-11-25', 'jaar'), reeks('v', 99, '2026-12-20', '2026-11-20'), reeks('p', 10, '2026-11-22', '2026-10-22')];
const k0 = { nu: '2026-11-21', reeksen, rijen, naam: (x) => x.naam, overslaan: (x) => /paraplu/.test(x.naam), stortingen: [{ van: 'bunq David', bedrag: 3000, dag: 28 }], intern_in: [] };
let k = P.komende(Object.assign({}, k0, { saldo: { saldo: 1000, op: '2026-11-21' } }));
toets('komende 14 dagen: hypotheek (soort post i.p.v. bank), lease, zorg (nog niet gezien), jaarpolis; niet 20 dec, niet de paraplu', k.posten.map((p) => p.naam).join(',') === 'Zorg,Jaarpolis,Hypotheek,Lease' && k.som === 4450 && k.posten[0].nog_niet_gezien === true, k.posten);
toets('vaste storting rond de 28e telt mee', k.stortingen.length === 1 && k.stortingen[0].datum === '2026-11-28', k.stortingen);
toets('volgorde van datum: na zorg en jaarpolis (−1.050) komt de storting; haalt het niet: laagste −1.050 op 25 nov', k.haalt === false && k.laagste.bedrag === -1050 && k.laagste.datum === '2026-11-25' && /haalt de rekening naar schatting niet/.test(k.zin) && /op 25 nov komt hij ± € 1\.050 tekort/.test(k.zin) && k.toon === 'fout', k);
k = P.komende(Object.assign({}, k0, { saldo: { saldo: 2500, op: '2026-11-21' } }));
toets('genoeg saldo: haalt het, rest = 2.500 + 3.000 − 4.450 = 1.050', k.haalt === true && k.over === 1050 && /Dat haalt de rekening naar schatting: saldo € 2\.500 plus de vaste storting van € 3\.000 rond 28 nov, er blijft ± € 1\.050 over\./.test(k.zin), k.zin);
k = P.komende(Object.assign({}, k0, { saldo: { saldo: 2500, op: '2026-11-21' }, intern_in: [{ datum: '2026-11-03', bedrag: 3000 }] }));
toets('storting deze maand al binnen: de volgende (28 dec) valt buiten het venster', k.stortingen.length === 0 && k.haalt === false, k.stortingen);
k = P.komende(Object.assign({}, k0, { saldo: null }));
toets('geen saldo: niet te zeggen, geen oordeel', k.haalt === null && /niet te lezen, dus of hij het haalt is niet te zeggen/.test(k.zin), k.zin);
k = P.komende(Object.assign({}, k0, { rijen: [], saldo: { saldo: 10, op: '2026-11-01' } }));
toets('geen posten: één zin zonder oordeel', k.posten.length === 0 && /staan er geen vaste posten/.test(k.zin));
toets('zin noemt "naar verwachting" en de grootste drie', /naar verwachting € 4\.450 af \(4 posten; grootste: Hypotheek 1 dec € 2\.000, Jaarpolis 25 nov € 1\.800, Lease 1 dec € 400\)/.test(P.komende(Object.assign({}, k0, { saldo: null })).zin));
// ── koppelingen ──
const ov = fs.readFileSync('financien-overzicht.js', 'utf8'), app = fs.readFileSync('financien-app.js', 'utf8'), srv = fs.readFileSync('server.js', 'utf8');
toets('overzicht: blok nu met dezeMaand, recentVan op eerste_gezien en recent_tot', /uit\.nu = blok\('nu'/.test(ov) && /eerste_gezien >= \?/.test(ov) && /recent_tot: tot/.test(ov));
toets('financien-app.js: komende uit de vaste lasten, in overzicht.nu, niet in vaste_lasten', /komende = require\('\.\/financien-plan\.js'\)\.komende\(/.test(app) && /uit\.overzicht\.nu\.komende = /.test(app) && /delete uit\.vaste_lasten\.komende/.test(app));
toets('server.js: appFinSamen zet nieuw per verzoek op een kopie; recent gaat niet mee', /overzicht: appFinNu\(d\.overzicht\)/.test(srv) && /delete nu\.recent;/.test(srv) && /require\(path\.join\(__dirname, 'financien-plan\.js'\)\)\.nieuwSinds\(ov\.nu, b\.laatst, Date\.now\(\), b\.op\)/.test(srv));
toets('server.js: POST /app/financien/gezien, nooit terug in de tijd, met teller', /route === 'POST \/app\/financien\/gezien'\) return appFinGezien/.test(srv) && /oud >= t \? b\.laatst/.test(srv) && /appTeller\('fin-gezien'/.test(srv));
toets('geen netwerk- of procesmodule in financien-plan.js', !/require\((['"])(https?|net|child_process|dgram|tls)\1\)/.test(fs.readFileSync('financien-plan.js', 'utf8')));
console.log('KLAAR ' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
