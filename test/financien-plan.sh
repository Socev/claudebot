#!/usr/bin/env bash
# Toetst financien-plan.js (wv2706, Financiën: ideeën uit Sure) op verzonnen delen, reeksen en een tijdelijke vaultmap:
# potjes (lezen, doorschuiven in beide richtingen, vanaf, status, voorstel = gemiddelde naar boven op € 10), potjesZet (nieuw, vervangen,
# weg, onbekende post, kop blijft), potjeInvoer (alleen de vaste lijst, bedraggrens, vanaf blijft bij doorschuiven); afvinken (betaald,
# ander bedrag, deels, nog niet, te laat, kwartaal niet aan de beurt, extra reeks maakt de rij niet te laat, verwacht_volgende achter op de
# laatste post); geldstroom (som links = som rechts, balans = inkomen + leven + verschuiven, intern telt niet, terugbetaling = bron, top 8 +
# rest, gemiddelde = som / 12); en de koppelingen in overzicht, vaste lasten, server.js, uitrol.sh en Dockerfile.
# Raakt de pod, de bank en de vault niet. Gebruik: bash test/financien-plan.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }
let P = null;
try { P = require(path.resolve('financien-plan.js')); } catch (e) { console.log(e); P = null; }
toets('financien-plan.js laadt', !!P);
if (!P) { console.log('KLAAR ' + goed + ' groen, ' + fouten + ' rood'); process.exit(1); }
const FV = require(path.resolve('financien-vault.js'));
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'finplan-'));
const r2 = (n) => Math.round(n * 100) / 100;

// ── potjesZet / potjesLees ──
let t = P.potjesZet('', { actie: 'zet', potje: { categorie: 'boodschappen', bedrag: 1200, doorschuiven: true, vanaf: '2026-09' } }, '2026-11-08');
toets('potjesZet maakt een pagina met kop en tabel', /## Potjes/.test(t) && /\| Post \| Per maand \| Doorschuiven \| Vanaf \|/.test(t) && /\| boodschappen \| € 1\.200 \| ja \| 09-2026 \|/.test(t), t);
t = P.potjesZet(t, { actie: 'zet', potje: { categorie: 'Horeca en uit eten', bedrag: 450.5, doorschuiven: false } }, '2026-11-08');
toets('tweede potje erbij (categorie op de vaste schrijfwijze, nee, deze maand)', /\| horeca en uit eten \| € 450,50 \| nee \| 11-2026 \|/.test(t), t);
t = P.potjesZet(t, { actie: 'zet', potje: { categorie: 'boodschappen', bedrag: 1100, doorschuiven: true, vanaf: '2026-09' } }, '2026-11-09');
toets('vervangen: één rij boodschappen met het nieuwe bedrag, updated bij', (t.match(/\| boodschappen \|/g) || []).length === 1 && /€ 1\.100 \| ja \| 09-2026/.test(t) && /updated: 2026-11-09/.test(t), t);
let fout = null; try { P.potjesZet(t, { actie: 'zet', potje: { categorie: 'pizza', bedrag: 10 } }); } catch (e) { fout = e.message; }
toets('onbekende post geweigerd', fout === 'onbekende post', fout);
fout = null; try { P.potjesZet(t, { actie: 'weg', categorie: 'kinderen' }); } catch (e) { fout = e.message; }
toets('weg van een potje dat er niet is geweigerd', fout === 'potje niet gevonden', fout);
const t2 = P.potjesZet(t, { actie: 'weg', categorie: 'horeca en uit eten' }, '2026-11-09');
toets('weg haalt alleen die rij weg; kop blijft', !/horeca en uit eten \|/.test(t2) && /\| boodschappen \|/.test(t2) && /## Potjes/.test(t2), t2);
const eigen = '---\nupdated: 2026-01-01\n---\n\n# Potjes\n\nEigen tekst van David.\n\n## Potjes\n\n| Post | Per maand | Doorschuiven | Vanaf |\n|---|---|---|---|\n| **Boodschappen** | € 900 | ja | 10-2026 |\n\nNog een alinea.\n';
const t3 = P.potjesZet(eigen, { actie: 'zet', potje: { categorie: 'vervoer', bedrag: 300, doorschuiven: false } }, '2026-11-08');
toets('bestaande pagina: eigen tekst en alinea erna blijven, rij erbij in de tabel', /Eigen tekst van David\./.test(t3) && /Nog een alinea\./.test(t3) && /\| \*\*Boodschappen\*\* \| € 900 \| ja \| 10-2026 \|\n\| vervoer \| € 300 \| nee \| 11-2026 \|\n\nNog een alinea/.test(t3), t3);
fs.mkdirSync(path.join(W, '20_Prive', 'Financien'), { recursive: true });
fs.writeFileSync(path.join(W, P.P_POTJES), t3 + '\n| boodschappen | € 5 | nee | 01-2026 |\n');
const gelezen = P.potjesLees(W, FV);
toets('potjesLees: vet weg, schrijfwijze van de lijst, vanaf als JJJJ-MM', gelezen.potjes.length === 2 && gelezen.potjes[0].categorie === 'boodschappen' && gelezen.potjes[0].bedrag === 900 && gelezen.potjes[0].doorschuiven === true && gelezen.potjes[0].vanaf === '2026-10' && gelezen.potjes[1].categorie === 'vervoer' && gelezen.potjes[1].doorschuiven === false, gelezen);
toets('potjesLees zonder pagina: leeg, geen fout', (function () { const x = P.potjesLees(path.join(W, 'niets'), FV); return x.pagina === null && x.potjes.length === 0; })());

// ── potjeInvoer ──
const inv = (p, oud) => { try { return P.potjeInvoer(p, '2026-11-08', oud); } catch (e) { return e.message; } };
toets('potjeInvoer: geldig', JSON.stringify(inv({ categorie: 'Boodschappen', bedrag: '1000', doorschuiven: 1 })) === JSON.stringify({ categorie: 'boodschappen', bedrag: 1000, doorschuiven: true, vanaf: '2026-11' }), inv({ categorie: 'Boodschappen', bedrag: '1000', doorschuiven: 1 }));
toets('potjeInvoer: geen categorie buiten de lijst', /^post:/.test(inv({ categorie: 'patat', bedrag: 10 })));
toets('potjeInvoer: bedrag 0 en 1 miljoen geweigerd', /^bedrag:/.test(inv({ categorie: 'vervoer', bedrag: 0 })) && /^bedrag:/.test(inv({ categorie: 'vervoer', bedrag: 1e6 })));
toets('potjeInvoer: vervangen met doorschuiven houdt de oude Vanaf', inv({ categorie: 'vervoer', bedrag: 50, doorschuiven: true }, { vanaf: '2026-06', doorschuiven: true }).vanaf === '2026-06');
toets('potjeInvoer: doorschuiven nieuw aan = vanaf deze maand', inv({ categorie: 'vervoer', bedrag: 50, doorschuiven: true }, { vanaf: '2026-06', doorschuiven: false }).vanaf === '2026-11');

// ── potjes (rekenen) ──
const twaalf = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'], mNu = '2026-11';
const delen = [];
let nr = 0;
const d = (maand, deel, stroom, cat, sub) => { nr++; delen.push({ nr: nr, maand: maand, datum: maand + '-10', stroom: stroom, sub: sub || null, cat: cat, bedrag: deel, deel: deel }); };
twaalf.forEach((m, i) => { d(m, -1000, 'leven', 'boodschappen'); d(m, -200 - i, 'leven', 'vervoer'); d(m, 5000, 'inkomen', 'inkomen'); d(m, -300, 'leven', 'wonen'); d(m, -500, 'intern', null); });
d('2026-10', 50, 'leven', 'boodschappen');   // terugbetaling: oktober netto 950
d(mNu, -400, 'leven', 'boodschappen'); d(mNu, -40, 'leven', 'boodschappen');
fs.writeFileSync(path.join(W, P.P_POTJES), P.potjesZet(P.potjesZet(P.potjesZet('', { actie: 'zet', potje: { categorie: 'boodschappen', bedrag: 1100, doorschuiven: true, vanaf: '2026-09' } }, '2026-11-08'),
  { actie: 'zet', potje: { categorie: 'vervoer', bedrag: 150, doorschuiven: false } }, '2026-11-08'), { actie: 'zet', potje: { categorie: 'kinderen', bedrag: 100, doorschuiven: true, vanaf: '2024-01' } }, '2026-11-08'));
const pj = P.potjes(delen, { mNu: mNu, twaalf: twaalf, nu: '2026-11-08', vault: W, fv: FV });
const pb = pj.posten.find((p) => p.categorie === 'boodschappen'), pv = pj.posten.find((p) => p.categorie === 'vervoer'), pk = pj.posten.find((p) => p.categorie === 'kinderen');
// boodschappen: sep 1100−1000 = 100, okt 1100−950 = 150 → over 250; beschikbaar 1350; uitgegeven 440; rest 910
toets('doorschuiven: sep + okt over (100 + 150) erbij', pb.over_vorig === 250 && pb.maanden_geschoven === 2 && pb.beschikbaar === 1350 && pb.uitgegeven === 440 && pb.rest === 910, pb);
toets('status ok bij 33 % op 8 november', pb.status === 'ok' && pb.pct === 33, pb);
toets('zonder doorschuiven: alleen deze maand, 0 uitgegeven = ok', pv.over_vorig === null && pv.beschikbaar === 150 && pv.uitgegeven === 0 && pv.status === 'ok', pv);
toets('vanaf ver terug: hooguit 12 maanden doorgeschoven', pk.maanden_geschoven === 12 && pk.over_vorig === 1200, pk);
toets('gem12 en vorige maand per potje', pb.gem12 === r2((11 * 1000 + 950) / 12) && pb.vorige === 950, pb);
toets('voorstel: wonen zonder potje = 300 (gemiddelde, naar boven op € 10); geen voorstel voor wat al een potje heeft', pj.voorstellen.some((v) => v.categorie === 'wonen' && v.voorstel === 300) && !pj.voorstellen.some((v) => v.categorie === 'boodschappen'), pj.voorstellen);
toets('totaal = som van de potjes', pj.totaal.bedrag === 1350 && pj.totaal.uitgegeven === 440, pj.totaal);
toets('filter per potje: deze maand, stroom leven, cat', JSON.stringify(pb.filter) === JSON.stringify({ van: mNu, tot: mNu, stroom: 'leven', cat: 'boodschappen' }));
// over: te veel uitgegeven
const delen2 = delen.concat([{ nr: 9001, maand: mNu, datum: mNu + '-07', stroom: 'leven', cat: 'vervoer', bedrag: -160, deel: -160 }]);
const pv2 = P.potjes(delen2, { mNu: mNu, twaalf: twaalf, nu: '2026-11-08', vault: W, fv: FV }).posten.find((p) => p.categorie === 'vervoer');
toets('status over als uitgegeven > beschikbaar', pv2.status === 'over' && pv2.rest === -10, pv2);
const delen3 = delen.concat([{ nr: 9002, maand: mNu, datum: mNu + '-07', stroom: 'leven', cat: 'vervoer', bedrag: -100, deel: -100 }]);
const pv3 = P.potjes(delen3, { mNu: mNu, twaalf: twaalf, nu: '2026-11-08', vault: W, fv: FV }).posten.find((p) => p.categorie === 'vervoer');
toets('status snel: op dag 8 al 67 % op', pv3.status === 'snel', pv3);
// negatief doorschuiven: september 1300 uitgegeven
const delen4 = delen.concat([{ nr: 9003, maand: '2026-09', datum: '2026-09-20', stroom: 'leven', cat: 'boodschappen', bedrag: -300, deel: -300 }]);
const pb4 = P.potjes(delen4, { mNu: mNu, twaalf: twaalf, nu: '2026-11-08', vault: W, fv: FV }).posten.find((p) => p.categorie === 'boodschappen');
toets('doorschuiven telt ook te veel uitgegeven (sep −200, okt +150 = −50)', pb4.over_vorig === -50 && pb4.beschikbaar === 1050, pb4);

// ── afvinken ──
const nrsVan = (l) => new Map(l.map((n) => [n, 'hoofd']));
const lasten = [
  { nr: 1, datum: '2026-10-02', bedrag: -2800 }, { nr: 2, datum: '2026-11-02', bedrag: -2795 },        // hypotheek, betaald
  { nr: 3, datum: '2026-10-05', bedrag: -100 }, { nr: 4, datum: '2026-11-05', bedrag: -130 },          // internet: ander bedrag
  { nr: 5, datum: '2026-09-28', bedrag: -268.8 }, { nr: 6, datum: '2026-10-27', bedrag: -268.8 },      // zorg: laatste 27-10, reeks wist alleen 28-9
  { nr: 7, datum: '2026-10-02', bedrag: -40.31 },                                                      // zorg: losse extra
  { nr: 8, datum: '2026-09-20', bedrag: -50 },                                                         // sport: te laat (geen oktober)
  { nr: 9, datum: '2026-11-04', bedrag: -3.99 },                                                       // games: 1 van 3
  { nr: 10, datum: '2026-08-15', bedrag: -90 },                                                        // kwartaal: volgende 15-11, nu 8-11
  { nr: 11, datum: '2026-07-15', bedrag: -60 },                                                        // jaar-achtig kwartaal: volgende jan
  { nr: 12, datum: '2026-10-25', bedrag: -383 },                                                       // stroom wisselend
  { nr: 13, datum: '2026-11-03', bedrag: -410 },
];
const R = (o) => Object.assign({ ritme: 'maand', n_per_maand: 1, wijze: 'vast' }, o);
const reeksen = [
  R({ sleutel: 'h', bedrag: 2795, dag: 2, wijze: 'dalend', laatste: '2026-11-02', verwacht_volgende: '2026-12-02', nrs: nrsVan([1, 2]) }),
  R({ sleutel: 'i', bedrag: 100, dag: 5, laatste: '2026-11-05', verwacht_volgende: '2026-12-05', nrs: nrsVan([3, 4]) }),
  R({ sleutel: 'z', bedrag: 268.8, dag: 28, laatste: '2026-10-27', verwacht_volgende: '2026-10-28', nrs: nrsVan([5, 6]) }),
  R({ sleutel: 'z2', bedrag: 40.31, dag: 2, laatste: '2026-10-02', verwacht_volgende: null, nrs: nrsVan([7]) }),
  R({ sleutel: 's', bedrag: 50, dag: 20, laatste: '2026-09-20', verwacht_volgende: '2026-10-20', nrs: nrsVan([8]) }),
  R({ sleutel: 'g', bedrag: 3.99, n_per_maand: 3, dag: 4, laatste: '2026-11-04', verwacht_volgende: '2026-12-04', nrs: nrsVan([9]) }),
  R({ sleutel: 'k', ritme: 'kwartaal', bedrag: 90, dag: 15, laatste: '2026-08-15', verwacht_volgende: '2026-11-15', nrs: nrsVan([10]) }),
  R({ sleutel: 'k2', ritme: 'kwartaal', bedrag: 60, dag: 15, laatste: '2026-10-15', verwacht_volgende: '2027-01-15', nrs: nrsVan([11]) }),
  R({ sleutel: 'e', bedrag: 383, dag: 25, wijze: 'wisselend', bedrag_min: 300, bedrag_max: 420, laatste: '2026-11-03', verwacht_volgende: '2026-12-03', nrs: nrsVan([12, 13]) }),
];
const rijen = [
  { sleutel: 'H', sleutels: ['h'], naam: 'Bank', ritme: 'maand', bedrag: 2795, dag: 2, wijze: 'dalend' },
  { sleutel: 'I', sleutels: ['i'], naam: 'Internet', ritme: 'maand', bedrag: 100, dag: 5, wijze: 'vast' },
  { sleutel: 'Z', sleutels: ['z', 'z2'], naam: 'Zorg', ritme: 'maand', bedrag: 309.11, dag: 28 },
  { sleutel: 'S', sleutels: ['s'], naam: 'Sport', ritme: 'maand', bedrag: 50, dag: 20, wijze: 'vast' },
  { sleutel: 'G', sleutels: ['g'], naam: 'Games', ritme: 'maand', bedrag: 11.97, dag: 4, wijze: 'vast' },
  { sleutel: 'K', sleutels: ['k'], naam: 'Kwartaal', ritme: 'kwartaal', bedrag: 90, dag: 15, wijze: 'vast' },
  { sleutel: 'K2', sleutels: ['k2'], naam: 'Kwartaal2', ritme: 'kwartaal', bedrag: 60, dag: 15, wijze: 'vast' },
  { sleutel: 'E', sleutels: ['e'], naam: 'Stroom', ritme: 'maand', bedrag: 383, dag: 25, wijze: 'wisselend', bedrag_min: 300, bedrag_max: 420 },
  { sleutel: 'PP', sleutels: ['h'], naam: 'PayPal', paraplu: true },
];
const av = P.afvinken({ nu: '2026-11-08', reeksen: reeksen, rijen: rijen, lasten: lasten, naam: (x) => x.naam, overslaan: (x) => !!x.paraplu });
const st = (n) => (av.posten.find((p) => p.naam === n) || {});
toets('afvinken: hypotheek betaald (dalend, 2.795)', st('Bank').status === 'betaald' && st('Bank').betaald === 2795 && st('Bank').betaald_op === '2026-11-02', st('Bank'));
toets('afvinken: internet ander bedrag (130 i.p.v. 100)', st('Internet').status === 'ander_bedrag' && st('Internet').betaald === 130, st('Internet'));
toets('afvinken: zorg nog niet, op 27-11 (laatste post 27-10 wint van verwacht 28-10; de losse extra maakt hem niet te laat)', st('Zorg').status === 'nog_niet' && st('Zorg').verwacht_op === '2026-11-27' && st('Zorg').bedrag === 268.8, st('Zorg'));
toets('afvinken: sport te laat (verwacht 20-10, nu 8-11)', st('Sport').status === 'te_laat' && st('Sport').verwacht_op === '2026-10-20', st('Sport'));
toets('afvinken: games deels (1 van 3 betaald)', st('Games').status === 'deels' && st('Games').keer === 1 && st('Games').verwacht_keer === 3 && st('Games').bedrag === 11.97, st('Games'));
toets('afvinken: kwartaal aan de beurt op 15-11 = nog niet; ander kwartaal niet in de lijst', st('Kwartaal').status === 'nog_niet' && st('Kwartaal').verwacht_op === '2026-11-15' && !st('Kwartaal2').naam, av.posten.map((p) => p.naam));
toets('afvinken: wisselende stroom binnen het bereik = betaald', st('Stroom').status === 'betaald' && st('Stroom').betaald === 410, st('Stroom'));
toets('afvinken: PayPal-paraplu overgeslagen', !st('PayPal').naam);
toets('afvinken: telling en volgorde (te laat eerst, betaald laatst)', JSON.stringify(av.telling) === JSON.stringify({ betaald: 2, ander_bedrag: 1, deels: 1, nog_niet: 2, te_laat: 1 }) && av.posten[0].status === 'te_laat' && av.posten[av.posten.length - 1].status === 'betaald', av.telling);
toets('afvinken: nog te gaan = open bedragen (zorg 268,80 + sport 50 + games 7,98 + kwartaal 90)', av.nog_te_gaan === r2(268.8 + 50 + 7.98 + 90), av.nog_te_gaan);
const av2 = P.afvinken({ nu: '2026-11-30', reeksen: reeksen, rijen: rijen.slice(2, 3), lasten: lasten, naam: (x) => x.naam });
toets('afvinken: zorg wordt pas na 27-11 + 5 dagen te laat', av2.posten[0].status === 'nog_niet', av2.posten[0]);
const av3 = P.afvinken({ nu: '2026-12-03', reeksen: reeksen, rijen: rijen.slice(2, 3), lasten: lasten, naam: (x) => x.naam });
toets('afvinken: december, zorg nooit betaald in november → te laat op 27-11', av3.maand === '2026-12' && av3.posten[0].status === 'te_laat' && av3.posten[0].verwacht_op === '2026-11-27', av3.posten[0]);

// ── geldstroom ──
const gd = [];
let g = 0;
const gz = (maand, deel, stroom, cat, sub) => gd.push({ nr: ++g, maand: maand, stroom: stroom, cat: cat, sub: sub || null, deel: deel, bedrag: deel });
twaalf.forEach((m) => {
  gz(m, 6000, 'inkomen', 'inkomen'); gz(m, 100, 'inkomen', 'toeslagen en kinderbijslag');
  ['wonen', 'boodschappen', 'vervoer', 'verzekeringen', 'gezondheid', 'kinderen', 'huishouden', 'bankkosten', 'kleding en persoonlijk', 'vrije tijd en sport'].forEach((c, i) => gz(m, -(100 + i * 50), 'leven', c));
  gz(m, 80, 'leven', 'teruggave en terugbetaling');
  gz(m, -2000, 'verschuiven', 'sparen en beleggen', 'verplicht'); gz(m, -500, 'verschuiven', null, 'vrijwillig');
  gz(m, -999, 'intern', null);
});
gz('2026-10', -3000, 'leven', 'vakantie en reizen');
const gs = P.geldstroom(gd, { twaalf: twaalf });
const som = (l) => r2(l.reduce((s, x) => s + x.bedrag, 0));
const okt = gs.maand_stroom, gem = gs.gemiddeld;
toets('geldstroom: maand = laatste volle maand, 12 maanden', gs.maand === '2026-10' && gs.maanden === 12 && gs.van === '2025-11');
toets('geldstroom okt: som links = som rechts = totaal', som(okt.bronnen) === som(okt.bestemmingen) && som(okt.bronnen) === okt.totaal, [som(okt.bronnen), som(okt.bestemmingen), okt.totaal]);
const levenOkt = -(100 + 150 + 200 + 250 + 300 + 350 + 400 + 450 + 500 + 550) - 3000 + 80;
toets('geldstroom okt: balans = inkomen + leven + verschuiven (intern telt niet)', okt.balans === r2(6100 + levenOkt - 2500) && okt.inkomen === 6100 && okt.leven === -levenOkt && okt.verschuiven === -2500, okt);
toets('geldstroom okt: tekort = bron "uit het saldo"', okt.balans < 0 && okt.bronnen.some((b) => b.soort === 'saldo' && b.bedrag === -okt.balans), okt.bronnen);
toets('geldstroom: terugbetaling = bron, niet in de bestemmingen', okt.bronnen.some((b) => b.naam === 'terugbetalingen' && b.bedrag === 80) && !okt.bestemmingen.some((b) => /terug/.test(b.naam)));
toets('geldstroom: aflossing en vrijwillig sparen rechts', okt.bestemmingen.some((b) => b.naam === 'aflossing hypotheek' && b.bedrag === 2000) && okt.bestemmingen.some((b) => /sparen/.test(b.naam) && b.bedrag === 500), okt.bestemmingen);
const lev = okt.bestemmingen.filter((b) => b.soort === 'leven');
toets('geldstroom: 8 grootste uitgaven + één regel "andere categorieën"', lev.length === 9 && lev.some((b) => /^3 andere categorieën$/.test(b.naam) && b.bedrag === 100 + 150 + 200), lev.map((b) => b.naam));
toets('geldstroom gemiddeld: som links = som rechts, inkomen per maand 6.100', som(gem.bronnen) === som(gem.bestemmingen) && gem.inkomen === 6100, [som(gem.bronnen), som(gem.bestemmingen), gem.inkomen]);
toets('geldstroom gemiddeld: vakantie 3.000 / 12 = 250', gem.bestemmingen.some((b) => b.naam === 'vakantie en reizen' && b.bedrag === 250), gem.bestemmingen);
const over = P.geldstroom([{ maand: '2026-10', stroom: 'inkomen', cat: 'inkomen', deel: 1000 }, { maand: '2026-10', stroom: 'leven', cat: 'wonen', deel: -400 }], { twaalf: ['2026-10'] });
toets('geldstroom: overschot = bestemming "bleef over"', over.maand_stroom.bestemmingen.some((b) => b.soort === 'over' && b.bedrag === 600) && !over.maand_stroom.bronnen.some((b) => b.soort === 'saldo'), over.maand_stroom);
toets('geldstroom zonder volle maand: null', P.geldstroom(gd, { twaalf: [] }) === null);

// ── koppelingen ──
const ov = fs.readFileSync('financien-overzicht.js', 'utf8'), app = fs.readFileSync('financien-app.js', 'utf8'), srv = fs.readFileSync('server.js', 'utf8');
toets('overzicht() zet uitgaven.potjes en geldstroom via blok()', /uit\.uitgaven\.potjes = blok\('potjes'/.test(ov) && /uit\.geldstroom = blok\('geldstroom'/.test(ov));
toets('vaste lasten: deze_maand uit afvinken, fout = leeg', /afvink = require\('\.\/financien-plan\.js'\)\.afvinken\(/.test(app) && /deze_maand: afvink/.test(app));
toets('server.js: POST /app/financien/potje in de glijroutes en de routetabel, achter appPriveDicht en appTeller', /APP_GLIJD_ROUTES\.add\('POST \/app\/financien\/potje'\)/.test(srv) && /route === 'POST \/app\/financien\/potje'\) return appFinPotje/.test(srv) &&
  /async function appFinPotje[\s\S]{0,400}appPriveDicht\(a, 'financien'\)/.test(srv) && /appTeller\('fin-potje'/.test(srv) && /VV\(\)\.wijzig\(pad, function \(t\) \{ return P\.potjesZet\(t, op, vandaag\); \}, \{ krimpGrens: true \}\)/.test(srv));
toets('geen netwerk- of procesmodule in financien-plan.js', !/require\((['"])(https?|net|child_process|dgram|tls)\1\)/.test(fs.readFileSync('financien-plan.js', 'utf8')));
toets('uitrol.sh en Dockerfile: financien-plan.js gaat mee in de release', /RELEASE_OPTIONEEL="[^"]*\bfinancien-plan\.js\b/.test(fs.readFileSync('uitrol.sh', 'utf8')) &&
  /COPY financien-plan\.js \/app\/release-bootstrap\/financien-plan\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
fs.rmSync(W, { recursive: true, force: true });
console.log('KLAAR ' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
