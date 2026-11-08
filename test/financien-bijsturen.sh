#!/usr/bin/env bash
# Toetst financien-bijsturen.js (wv2700, Financiën › Uitgaven "Zelf bij te sturen") op een nagebootste database en vaultpagina:
# boodschappen en uit eten = hun categorie per maand; streaming + andere abonnementen = abonnementen en communicatie + het mediadeel van
# vrije tijd; een PayPal-post krijgt alleen de dienst van zijn bewijs als hij één deel en precies één bewijs heeft (review MOET 1);
# advies uit eten pas vanaf 3× per maand; videoadvies = (som − duurste) × 12; stroom uit de tabel van de energiepagina; zonder pagina
# alleen "niet"; overzicht() zet het blok onder uitgaven. Raakt de pod, de bank en de vault niet. Gebruik: bash test/financien-bijsturen.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const { DatabaseSync } = require('node:sqlite');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
let B = null;
try { B = require(path.resolve('financien-bijsturen.js')); } catch (e) { B = null; }
toets('financien-bijsturen.js laadt', !!B);
if (!B) { console.log('KLAAR ' + goed + ' groen, ' + (fouten) + ' rood'); process.exit(1); }
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE verrijking(nr INTEGER, subcategorie TEXT); CREATE TABLE paypal_bewijs(nr INTEGER, dienst TEXT, ontvanger TEXT);' +
  'CREATE TABLE abonnementen(naam TEXT, categorie TEXT, subcategorie TEXT, ritme TEXT, per_maand REAL, actief INTEGER)');
const twaalf = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'], mNu = '2026-11';
const delen = [];
let nr = 0;
const zet = (maand, bedrag, cat, tp, sub, extra) => { nr++; db.prepare('INSERT INTO verrijking VALUES (?, ?)').run(nr, sub || null);
  delen.push(Object.assign({ nr: nr, maand: maand, datum: maand + '-10', stroom: 'leven', cat: cat, tegenpartij: tp, omschrijving: null, bedrag: bedrag, deel: bedrag }, extra || {})); return nr; };
twaalf.forEach((m) => {
  zet(m, -100, 'boodschappen', 'Albert Heijn 1344', 'supermarkt'); zet(m, -10, 'boodschappen', 'Albert Heijn 1344', 'supermarkt'); zet(m, -40, 'boodschappen', 'Lidl Huizen', 'supermarkt');
  zet(m, -25, 'boodschappen', 'Slagerij Voorbeeld', 'slager');
  zet(m, -80, 'horeca en uit eten', 'Restaurant Voorbeeld', 'Restaurant');
  for (let i = 0; i < 4; i++) zet(m, -30, 'horeca en uit eten', 'Pizzeria Voorbeeld', i % 2 ? 'afhaal/bezorging' : 'maaltijdbezorging');
  zet(m, -9, 'horeca en uit eten', 'Snackbar Voorbeeld', 'snack');
  const p1 = zet(m, -20.99, 'abonnementen en communicatie', 'PayPal Europe S.a.r.l.', 'PayPal incasso'); db.prepare('INSERT INTO paypal_bewijs VALUES (?, ?, ?)').run(p1, 'netflix', 'Netflix.com');
  const p2 = zet(m, -10.99, 'abonnementen en communicatie', 'PayPal Europe S.a.r.l.', 'PayPal incasso'); db.prepare('INSERT INTO paypal_bewijs VALUES (?, ?, ?)').run(p2, 'disney', 'The Walt Disney Comp');
  const p3 = zet(m, -15, 'abonnementen en communicatie', 'PayPal Europe S.a.r.l.', 'PayPal incasso'); db.prepare('INSERT INTO paypal_bewijs VALUES (?, ?, ?)').run(p3, 'takeaway', 'Takeaway.com');
  zet(m, -40, 'abonnementen en communicatie', 'KPN - Mobiel', 'mobiel'); zet(m, -12, 'vrije tijd en sport', 'Kobo Software Ireland', 'e-books');
  zet(m, -30, 'vrije tijd en sport', 'Sportschool Voorbeeld', 'sportschool'); zet(m, -500, 'wonen', 'Tibber', 'energie');
});
// één PayPal-post met twee bewijzen (mag niet splitsen) en een post die in delen valt (mag de dienst niet krijgen)
const pd = zet('2026-10', -30, 'abonnementen en communicatie', 'PayPal Europe S.a.r.l.', 'PayPal incasso');
db.prepare('INSERT INTO paypal_bewijs VALUES (?, ?, ?)').run(pd, 'netflix', 'Netflix.com'); db.prepare('INSERT INTO paypal_bewijs VALUES (?, ?, ?)').run(pd, 'hbo', 'HBO Nordic AB');
const pg = zet('2026-10', -5, 'abonnementen en communicatie', 'PayPal Europe S.a.r.l.', 'PayPal incasso', { bedrag: -50 });
db.prepare('INSERT INTO paypal_bewijs VALUES (?, ?, ?)').run(pg, 'skyshowtime', 'SkyShowtime Limited');
zet('2026-10', 6, 'horeca en uit eten', 'Restaurant Voorbeeld', 'restaurant');   // terugbetaling telt negatief
zet(mNu, -55, 'boodschappen', 'Albert Heijn 1344', 'supermarkt');
delen.push({ nr: 999, maand: '2026-10', stroom: 'intern', cat: 'boodschappen', tegenpartij: 'Albert Heijn', bedrag: -999, deel: -999 });   // geen leven: telt niet
[['PayPal — Netflix', 'abonnementen en communicatie', 'PayPal incasso', 20.99], ['PayPal — Disney+', 'abonnementen en communicatie', 'PayPal incasso', 10.99],
  ['NPO', 'abonnementen en communicatie', 'omroep', 3.49], ['KPN - Mobiel', 'abonnementen en communicatie', 'mobiel', 40], ['Kobo Software Ireland', 'vrije tijd en sport', 'e-books', 12],
  ['Sportschool Voorbeeld', 'vrije tijd en sport', 'sportschool', 30], ['Tibber', 'wonen', 'energie', 400]].forEach((r) => db.prepare('INSERT INTO abonnementen VALUES (?, ?, ?, ?, ?, 1)').run(r[0], r[1], r[2], 'maand', r[3]));
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-bijsturen-')), V = path.join(W, 'vault');
fs.mkdirSync(path.join(V, path.dirname(B.P_ENERGIE)), { recursive: true });
const pag = ['# Energie', '', '| Maand | Verbruik (kWh) | Kale stroomprijs (ct/kWh) | Factuur incl. btw (€) | Alles-in (ct/kWh) |', '|---|--:|--:|--:|--:|',
  '| sep 2025 | 1.000 | 11,00 | 250,00 | 25,0 |'].concat(twaalf.map((m, i) => '| ' + ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'][Number(m.slice(5)) - 1] + ' ' + m.slice(0, 4) + ' | ' + (1000 + i * 10).toLocaleString('nl-NL') + ' | 12,00 | ' + (300 + i).toFixed(2).replace('.', ',') + ' | 30,0 |'))
  .concat(['', '| | Waarde |', '|---|--:|', '| Geladen per jaar | 4.000 kWh (25 % van het verbruik) |', '| Zelfde kWh in de goedkoopste nachturen (18–7 uur) | ± € 110 per jaar goedkoper |']).join('\n');
fs.writeFileSync(path.join(V, B.P_ENERGIE), pag);
const a = { db: db };
const u = B.bijsturen(a, delen, { mNu: mNu, twaalf: twaalf, vault: V, tibberUur: null });   // wv2707: zonder uurdata (de echte uur.json mag niet meetellen)
const P = {}; u.posten.forEach((p) => { P[p.id] = p; });
toets('vijf posten in vaste volgorde', u.posten.map((p) => p.id).join() === 'boodschappen,uit_eten,stroom,streaming,abonnementen', u.posten.map((p) => p.id));
const somCat = (m, c) => -delen.filter((x) => x.stroom === 'leven' && x.maand === m && c(x)).reduce((s, x) => s + x.deel, 0);
const r2 = (n) => Math.round(n * 100) / 100;
toets('boodschappen = categorie per maand (intern telt niet)', twaalf.every((m, i) => P.boodschappen.reeks[i].waarde === r2(somCat(m, (x) => x.cat === 'boodschappen'))), P.boodschappen.reeks);
toets('boodschappen lopende maand', P.boodschappen.lopend === 55, P.boodschappen.lopend);
toets('uit eten = categorie per maand, terugbetaling negatief', twaalf.every((m, i) => P.uit_eten.reeks[i].waarde === r2(somCat(m, (x) => x.cat === 'horeca en uit eten'))) && P.uit_eten.nu === 203, P.uit_eten.reeks.slice(-1));
const media = (x) => x.cat === 'abonnementen en communicatie' || (x.cat === 'vrije tijd en sport' && /e-books/.test(String(x.tegenpartij) + 'e-books') && x.tegenpartij.indexOf('Kobo') === 0);
toets('streaming + andere abonnementen = abonnementen en communicatie + mediadeel vrije tijd', twaalf.every((m, i) => r2(P.streaming.reeks[i].waarde + P.abonnementen.reeks[i].waarde) === r2(somCat(m, media))),
  [P.streaming.reeks.slice(-1), P.abonnementen.reeks.slice(-1)]);
toets('sportschool niet in streaming of abonnementen', P.streaming.delen.concat(P.abonnementen.delen).every((g) => !/sport/.test(g.naam)));
toets('winkels: Albert Heijn, Lidl, andere winkels', P.boodschappen.delen.map((g) => g.naam).join('|') === 'Albert Heijn|Lidl|andere winkels (slager, bakker, toko …)', P.boodschappen.delen);
const ah = P.boodschappen.delen[0];
toets('Albert Heijn: per maand, keer en per keer', ah.per_maand === 110 && ah.keer_pm === 2 && ah.per_keer === 55, ah);
toets('kleine bezoeken (onder € 15) als inzicht', /± 1 per maand, samen € 10/.test(P.boodschappen.inzicht[0] || ''), P.boodschappen.inzicht);
toets('AH-bonnen: zegt dat per product nog niet kan', P.boodschappen.inzicht.some((t) => /Per product: nog niet/.test(t)));
const soorten = P.uit_eten.delen.map((g) => g.naam);
toets('horeca: rommelige subcategorieën → vaste soorten', soorten.indexOf('afhalen en bezorgen') >= 0 && soorten.indexOf('restaurant') >= 0 && soorten.indexOf('fastfood en snacks') >= 0 && soorten.length === 3, soorten);
const afh = P.uit_eten.delen.find((g) => g.naam === 'afhalen en bezorgen');
toets('afhalen 4× per maand → advies 2 × 12 × per keer', afh.keer_pm === 4 && P.uit_eten.advies && P.uit_eten.advies.per_jaar === 720 && P.uit_eten.advies.zekerheid === 'schatting', P.uit_eten.advies);
toets('uit eten hoger (> 25 % én > € 100)?', P.uit_eten.afwijking === null, P.uit_eten.afwijking);
const sd = P.streaming.delen.map((g) => g.naam);
toets('PayPal-bewijs → soort video, Kobo → boeken', sd.indexOf('video') >= 0 && sd.indexOf('boeken') >= 0, P.streaming.delen);
const vid = P.streaming.delen.find((g) => g.naam === 'video');
toets('MOET 1: post met twee bewijzen en een post in delen krijgen geen dienst', vid.per_maand === r2((20.99 + 10.99) * 12 / 12), vid);
toets('takeaway via PayPal = losse PayPal-betaling (geen media)', P.abonnementen.delen.some((g) => g.naam === 'losse PayPal-betalingen'), P.abonnementen.delen);
toets('lijst diensten: Netflix, Kobo, Disney+, NPO (zonder "PayPal —")', P.streaming.lijst.map((r) => r.naam).join('|') === 'Netflix|Kobo Software Ireland|Disney+|NPO', P.streaming.lijst);
toets('andere abonnementen: KPN, geen sportschool of Tibber', P.abonnementen.lijst.map((r) => r.naam).join('|') === 'KPN - Mobiel', P.abonnementen.lijst);
toets('videoadvies = (som − duurste) × 12', P.streaming.advies && P.streaming.advies.per_jaar === Math.round((10.99 + 3.49) * 12) && P.streaming.advies.minstens === true, P.streaming.advies);
toets('stroom: laatste 12 maanden van de tabel', P.stroom.reeks.length === 12 && P.stroom.reeks[0].maand === '2025-11' && P.stroom.kwh === 1110 && P.stroom.nu === 311 && P.stroom.t_m === '2026-10', P.stroom);
toets('stroom: gemiddelden en ct/kWh', P.stroom.gem_kwh === 1055 && P.stroom.ct === 30 && P.stroom.ct_gem === Math.round(3666 / 12660 * 1000) / 10, P.stroom);
toets('stroom: auto-aandeel en slim laden uit de pagina', /25 %/.test(P.stroom.inzicht[0] || '') && P.stroom.advies && P.stroom.advies.per_jaar === 110, [P.stroom.inzicht, P.stroom.advies]);
toets('stroom: niet achter', P.stroom.achter === false);
const zonder = B.bijsturen(a, delen, { mNu: mNu, twaalf: twaalf, vault: path.join(W, 'leeg'), tibberUur: null });
toets('zonder energiepagina: stroom "niet", rest blijft', zonder.posten[2].niet && !zonder.posten[2].reeks && zonder.posten[0].gem12 === P.boodschappen.gem12, zonder.posten[2]);
toets('totaal = som van de gemiddelden', u.gem12 === r2(P.boodschappen.gem12 + P.uit_eten.gem12 + P.stroom.gem12 + P.streaming.gem12 + P.abonnementen.gem12), u.gem12);
toets('filters alleen voor boodschappen en uit eten', P.boodschappen.filter.nu.cat === 'boodschappen' && P.uit_eten.filter.twaalf.van === '2025-11' && P.streaming.filter === null);
toets('geen IBAN in de uitvoer', !/[A-Z]{2}\d{2}[A-Z]{4}\d{6,}/.test(JSON.stringify(u)));
toets('winkel(): AH to go en Plus', B.winkel({ tegenpartij: 'AH to go Utrecht' }) === 'Albert Heijn' && B.winkel({ tegenpartij: 'PLUS Huizen' }) === 'Plus' && B.winkel({ tegenpartij: 'Toko Voorbeeld' }).indexOf('andere') === 0);
// aansluiting in financien-overzicht.js
const src = fs.readFileSync('financien-overzicht.js', 'utf8');
toets('overzicht() zet uitgaven.bijsturen via blok()', /uit\.uitgaven\.bijsturen = blok\('bijsturen'/.test(src));
toets('geen netwerk- of procesmodule', !/require\((['"])(https?|net|child_process|dgram|tls)\1\)/.test(fs.readFileSync('financien-bijsturen.js', 'utf8')));
toets('uitrol.sh en Dockerfile: financien-bijsturen.js gaat mee in de release', /RELEASE_OPTIONEEL="[^"]*\bfinancien-bijsturen\.js\b/.test(fs.readFileSync('uitrol.sh', 'utf8')) &&
  /COPY financien-bijsturen\.js \/app\/release-bootstrap\/financien-bijsturen\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
fs.rmSync(W, { recursive: true, force: true });
console.log('KLAAR ' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
