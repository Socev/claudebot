#!/usr/bin/env bash
# Toetst financien-vooruit.js en de maandbrief in financien-app.js (wv2621, OVIS Financiën 8+ stap 5 en 6; ontwerp vault
# "01_Ontwikkeling/OVIS Financiën 8+ (ontwerp 7-11-2026)" § 3.4, § 3.6, § 3.7). Verzonnen getallen en namen.
#   basis: eenmalig inkomen (zelden of ver boven de gewone post) eruit, jaarposten eruit, gemiddelde en schommeling uit de maandreeks
#   kalender: reeksen jaar/kwartaal, Holding-plan (naar privé = erbij, vanaf privé = eraf, anders mijlpaal), rentevast, doelen, elk jaar / misschien
#   prognose: elke maand reproduceerbaar uit start + basis × deel + de kalender; laag = verwacht − σ√t; krap = laag < 0; laagste gemarkeerd
#   doelen: lezen van de pagina, stand (op koers / achter / behaald / geen telling), doelenZet (erbij, weg, dubbel, kop blijft), doelInvoer
#   maandbrief: stilte als alles normaal is, vijf soorten regel bij een afwijking, niet twee keer (briefingNieuw), los onder "In het kort:"
#   server.js: route POST /app/financien/doel achter dezelfde poort; uitrol/Dockerfile nemen de module mee.
# Raakt de pod, de kluis, de bank en de echte vault niet. Gebruik: bash test/financien-vooruit.sh
set -u
cd "$(dirname "$0")/.." || exit 1
TOETS_NU=2026-11-07T10:00:00+01:00 node --no-warnings --require ./test/vaste-klok.cjs - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }
let V = null;
try { V = require(path.resolve('financien-vooruit.js')); } catch (e) { V = null; }
toets('financien-vooruit.js bestaat en laadt', !!V, null);
const F = require(path.resolve('financien-app.js')), FV = require(path.resolve('financien-vault.js'));
const r2 = (n) => Math.round(n * 100) / 100;
if (V) {
  // ── basis ──
  const twaalf = []; for (let i = 12; i >= 1; i--) twaalf.push(F.maandPlus('2026-11', -i));   // 2025-11 … 2026-10
  const delen = [];
  const d = (maand, dag, stroom, deel, x) => delen.push(Object.assign({ maand: maand, datum: maand + '-' + String(dag).padStart(2, '0'), stroom: stroom, deel: deel, id: 'id-' + stroom, sub: null, eenmalig: false, abo: null }, x || {}));
  twaalf.forEach((m, k) => {
    d(m, 25, 'inkomen', 9000, { id: 'loon' });                               // loon van de eigen BV
    d(m, 8, 'leven', -6000 - (k % 2) * 400, { id: 'winkel' });                // leven, schommelt
    d(m, 1, 'verschuiven', -2000, { sub: 'verplicht', id: 'hyp' });           // verplichte aflossing
    d(m, 3, 'verschuiven', -300, { sub: 'vrijwillig', id: 'spaar' });         // sparen: niet in de basis
  });
  d('2026-01', 6, 'inkomen', 50000, { id: 'loon', tegenpartij: 'Voorbeeld Holding BV' });   // dividend: zelfde id als het loon, > 3× de mediaan
  d('2025-01', 30, 'inkomen', 48000, { id: 'loon', tegenpartij: 'Voorbeeld Holding BV' });  // een jaar eerder (buiten de 12 maanden): "elk jaar"
  d('2026-03', 27, 'inkomen', 2500, { id: 'losse', tegenpartij: 'Proefvereniging' });       // één keer: eenmalig, geen jaar eerder
  d('2026-07', 12, 'leven', -4000, { id: 'reis', eenmalig: true });                         // eenmalig groot: zit in het gemiddelde
  d('2026-09', 23, 'leven', -240, { id: 'water', abo: 77 });                                // kwartaalreeks: niet in de basis
  const reeksen = [{ id: 77, naam: 'Waterbedrijf Proef', ritme: 'kwartaal', bedrag: 240, volgende: '2026-12-23', categorie: 'wonen' }];
  const b = V.basis(delen, twaalf, reeksen);
  const over = twaalf.map((m) => r2(delen.filter((x) => x.maand === m && ((x.stroom === 'inkomen' && x.deel < 20000 && x.id === 'loon') || (x.stroom === 'leven' && x.abo == null) || (x.stroom === 'verschuiven' && x.sub === 'verplicht'))).reduce((s, x) => s + x.deel, 0)));
  const gem = over.reduce((s, x) => s + x, 0) / 12, sd = Math.sqrt(over.reduce((s, x) => s + (x - gem) ** 2, 0) / 11);
  toets('basis: dividend (zelfde id als het loon, > 3× de mediaan) en losse post zijn eenmalig inkomen; gewone loonposten niet', b && b.eenmalig_inkomen.length === 2 && b.eenmalig_inkomen[0].bedrag === 50000 &&
    b.eenmalig_inkomen.some((x) => x.bedrag === 2500) && Math.abs(b.delen.inkomen_eenmalig - 52500 / 12) < 0.01, b && b.eenmalig_inkomen);
  toets('basis: gemiddelde = maandreeks (zonder eenmalig inkomen en jaarposten, mét eenmalige uitgave en verplichte aflossing), σ klopt', b && Math.abs(b.per_maand - r2(gem)) < 0.01 &&
    Math.abs(b.schommeling - r2(sd)) < 0.01 && b.per_maand_reeks.length === 12 && b.per_maand_reeks.every((x, i) => Math.abs(x.over - over[i]) < 0.01), b && [b.per_maand, gem, b.schommeling, sd]);
  toets('basis: jaarposten apart (240/12), sparen niet in de basis maar in vrijwillig (300)', b && Math.abs(b.delen.jaarposten - 20) < 0.01 && Math.abs(b.vrijwillig_pm - 300) < 0.01, b && [b.delen.jaarposten, b.vrijwillig_pm]);
  toets('basis: dividend kwam ook een jaar eerder (jaar_eerder), de losse post niet', b && b.eenmalig_inkomen.find((x) => x.bedrag === 50000).jaar_eerder === '2025-01-30' && b.eenmalig_inkomen.find((x) => x.bedrag === 2500).jaar_eerder === null, b && b.eenmalig_inkomen);
  toets('basis: zonder volledige maanden geen basis', V.basis(delen, [], reeksen) === null, null);

  // ── Holding-plan en kalender ──
  const planning = [
    { wanneer: 'vóór 15-12-2026', actie: 'Besluit: interim-dividend € 30.000 bruto; € 9.000 netto verrekenen; € 14.500,50 netto naar privé', klaar: false },
    { wanneer: 'dec 2026', actie: 'Premie verzekering (± € 14.000) betalen vanaf privé', klaar: false },
    { wanneer: 'jan 2027', actie: 'Januaridividend lost eerst de schuld af; daarna geen privé-opnames', klaar: false },
    { wanneer: '26-10-2026', actie: 'Inhaalbetaling naar privé € 999 (gedaan)', klaar: true },
    { wanneer: 'eind jan 2027', actie: 'Dividendbelasting € 4.000 aangeven (Holding)', klaar: false },
    { wanneer: '2027', actie: 'Aanslag privé ± € 3.000', klaar: false },
  ];
  const pl = V.uitPlanning(planning);
  toets('Holding-plan: "naar privé" = erbij, "betalen vanaf privé" = eraf, andere privéregel = mijlpaal; klaar en zonder privé niet; jaar zonder maand = later', pl.length === 4 &&
    pl[0].maand === '2026-12' && pl[0].bedrag === 14500.5 && pl[1].maand === '2026-12' && pl[1].bedrag === -14000 && pl[2].soort === 'mijlpaal' && pl[2].maand === '2027-01' && pl[3].maand === null, pl);
  toets('maandVan: dd-mm-jjjj, "begin dec 2026", "eind jan 2027", "maart 2027"; alleen een jaar = null', V.maandVan('vóór 15-12-2026') === '2026-12' && V.maandVan('begin dec 2026') === '2026-12' &&
    V.maandVan('eind jan 2027') === '2027-01' && V.maandVan('maart 2027') === '2027-03' && V.maandVan('2027') === null, [V.maandVan('maart 2027')]);
  const nu = '2026-11-07';
  const doelL = [{ naam: 'Zomervakantie', soort: 'uitgave', datum: '2027-07-01', bedrag: 6000 }, { naam: 'Buffer', soort: 'sparen', datum: '2027-06-01', bedrag: 20000 }, { naam: 'Oud', soort: 'uitgave', datum: '2026-10-01', bedrag: 100 }];
  const hyp = [{ deel: '1', rente_bank: 4.5, rentevast_tm: '2027-06-01' }, { deel: '2', rente_bank: 1.04, rentevast_tm: '2031-05-01' }, { deel: '3', rente_bank: 1.04, rentevast_tm: '2031-05-01' }];
  const k = V.kalender({ nu: nu, reeksen: reeksen, planning: planning, delen_hyp: hyp, doelen: doelL, herhaal: b.eenmalig_inkomen });
  const soort = (s) => k.posten.filter((x) => x.soort === s);
  toets('kalender: kwartaalreeks 4× binnen 12 maanden (dec, mrt, jun, sep) met het bedrag eraf', soort('vaste post').map((x) => x.maand).join() === '2026-12,2027-03,2027-06,2027-09' && soort('vaste post').every((x) => x.bedrag === -240), soort('vaste post'));
  toets('kalender: doel uitgave eraf in zijn maand; een voorbij doel en een spaardoel niet', soort('doel').length === 1 && soort('doel')[0].maand === '2027-07' && soort('doel')[0].bedrag === -6000, soort('doel'));
  toets('kalender: rentevast binnen 12 maanden als mijlpaal zonder bedrag; 2031 bij later, als één regel voor twee delen', k.posten.some((x) => x.soort === 'mijlpaal' && x.maand === '2027-06' && x.bedrag === null) &&
    k.later.filter((x) => x.maand === '2031-05').length === 1 && /leningdelen 2 \(1,04 %\), 3/.test(k.later.find((x) => x.maand === '2031-05').tekst), k.later);
  toets('kalender: dividend van een jaar eerder dat ook het jaar daarvoor kwam = "elk jaar" (telt); losse post = "misschien" (telt niet)', soort('elk jaar').length === 1 && soort('elk jaar')[0].maand === '2027-01' &&
    soort('elk jaar')[0].bedrag === 50000 && soort('misschien').length === 1 && soort('misschien')[0].telt === false, [soort('elk jaar'), soort('misschien')]);
  toets('kalender: Holding-regel zonder maand bij later', k.later.some((x) => x.soort === 'mijlpaal' && x.maand === null), k.later);

  // ── prognose: reproduceerbaar uit de kalender ──
  const p = { nu: nu, start: 12000, basis: b.per_maand, schommeling: b.schommeling, leven_pm: 6500, posten: k.posten };
  const ms = V.prognose(p);
  let s = 12000, t = 0, ok = ms.length === 13, eerste = null;
  ms.forEach((m, i) => {
    const deel = i === 0 ? (30 - 7) / 30 : 1;
    const som = k.posten.filter((x) => x.maand === m.maand && x.bedrag != null && x.telt !== false).reduce((a, x) => a + x.bedrag, 0);
    s = r2(s + b.per_maand * deel + som); t += deel;
    if (Math.abs(m.verwacht - s) > 0.05 || Math.abs(m.laag - r2(s - b.schommeling * Math.sqrt(t))) > 0.05 || m.krap !== (m.laag < 0) || Math.abs(m.posten - r2(som)) > 0.01) { ok = false; if (!eerste) eerste = [m, s, som]; }
  });
  toets('prognose: elke maand = start + basis × deel + kalender (zonder "misschien"); laag = verwacht − σ√t; krap = laag < 0', ok, eerste);
  const laagste = ms.filter((m) => m.laagste);
  toets('prognose: precies één laagste maand, op de lage lijn', laagste.length === 1 && laagste[0].laag === Math.min(...ms.map((m) => m.laag)), laagste);
  toets('prognose: lopende maand telt alleen het resterende deel (23/30)', Math.abs(ms[0].deel - 0.767) < 0.001 && Math.abs(ms[0].basis - r2(b.per_maand * 23 / 30)) < 0.02, ms[0]);
  toets('prognose: buffer in maanden = verwacht ÷ leven per maand', ms.every((m) => m.buffer === Math.round(m.verwacht / 6500 * 10) / 10), ms.map((m) => m.buffer));
  // Kan dit? rekent op deze maanden (de App doet het zelf): € 8.000 in maart = elke maand vanaf maart € 8.000 lager
  const kan = (bedrag, maand) => ms.map((m) => ({ maand: m.maand, verwacht: m.maand >= maand ? r2(m.verwacht - bedrag) : m.verwacht }));
  toets('Kan dit?: alleen vanaf de gekozen maand lager, ervoor gelijk', kan(8000, '2027-03').every((x, i) => x.verwacht === (ms[i].maand >= '2027-03' ? r2(ms[i].verwacht - 8000) : ms[i].verwacht)), null);

  // ── vooruit (samen) ──
  const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'financien-vooruit-'));
  const fvNep = { lees: () => ({ hypotheek: { delen: hyp }, dga: { planning: planning } }), tabel: FV.tabel, tabellen: FV.tabellen, schoon: FV.schoon, nlGetal: FV.nlGetal, datumIso: FV.datumIso };
  const vo = V.vooruit({ ov: { basis_vooruit: b, buffer: { liquide: 12000, stand_van: '2026-11-07T06:00:00Z', leven_per_maand: 6500 } }, vault: VAULT, nu: nu, fv: fvNep, reeksen: reeksen, doelen: { doelen: doelL } });
  toets('vooruit: ok, 13 maanden, start = vrij beschikbaar, regels en wat er niet in zit', vo.ok === true && vo.maanden.length === 13 && vo.start.bedrag === 12000 && vo.regels.length >= 5 && vo.niet_mee.length === 4 && vo.laagste && vo.later.length >= 1, vo);
  toets('vooruit: zonder basis of zonder buffer geen prognose, met reden', V.vooruit({ ov: { buffer: { liquide: 1 } }, nu: nu, fv: fvNep }).ok === false && V.vooruit({ ov: { basis_vooruit: b }, nu: nu, fv: fvNep }).ok === false, null);

  // ── doelen ──
  const P = path.join(VAULT, V.P_DOELEN);
  toets('doelen: pagina ontbreekt = lege lijst, geen fout', (() => { const x = V.doelen({ vault: VAULT, nu: nu }); return x.pagina === null && x.doelen.length === 0; })(), null);
  fs.mkdirSync(path.dirname(P), { recursive: true });
  let tekst = V.doelenLeeg('2026-11-01');
  const op = (d) => ({ actie: 'nieuw', doel: V.doelInvoer(d, nu) });
  tekst = V.doelenZet(tekst, op({ naam: 'Buffer zes maanden', bedrag: 39000, datum: '2027-11-01', soort: 'sparen', rekening: 'vrij beschikbaar', start: 9000 }), nu);
  tekst = V.doelenZet(tekst, op({ naam: 'Spaarpot reis', bedrag: 5000, datum: '2027-05', soort: 'sparen', rekening: 'Spaar Proef', start: 1000 }), nu);
  tekst = V.doelenZet(tekst, op({ naam: 'Nieuwe auto', bedrag: 8000, datum: '2027-03-15', soort: 'uitgave' }), nu);
  tekst = V.doelenZet(tekst, op({ naam: 'Zonder rekening', bedrag: 1000, datum: '2027-01-01', soort: 'sparen' }), nu);
  fs.writeFileSync(P, tekst);
  toets('doelenZet: tabel onder ## Doelen, bedrag en datum zoals David ze leest, updated bijgewerkt', /## Doelen\n\n\| Doel \| Bedrag \| Datum/.test(tekst) && /\| Nieuwe auto \| € 8\.000 \| 15-3-2027 \| uitgave \| — \| € 0 \| 7-11-2026 \|/.test(tekst) &&
    /updated: 2026-11-07/.test(tekst) && /\| Spaarpot reis \| € 5\.000 \| 1-5-2027 \| sparen \| Spaar Proef \| € 1\.000 \|/.test(tekst), tekst);
  const zw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
  toets('doelenZet: dubbele naam geweigerd, onbekend doel weg geweigerd, onbekende actie geweigerd', /al een doel/.test(zw(() => V.doelenZet(tekst, op({ naam: 'nieuwe AUTO', bedrag: 1, datum: '2027-01-01', soort: 'uitgave' }), nu))) &&
    /niet gevonden/.test(zw(() => V.doelenZet(tekst, { actie: 'weg', naam: 'Bestaat niet' }, nu))) && /onbekende actie/.test(zw(() => V.doelenZet(tekst, { actie: 'wis' }, nu))), null);
  toets('doelInvoer: datum in het verleden, bedrag 0, naam met haken, onbekende soort geweigerd; maand JJJJ-MM wordt de 1e', /datum/.test(zw(() => V.doelInvoer({ naam: 'x', bedrag: 5, datum: '2026-01-01', soort: 'sparen' }, nu))) &&
    /bedrag/.test(zw(() => V.doelInvoer({ naam: 'x', bedrag: 0, datum: '2027-01-01', soort: 'sparen' }, nu))) && /naam/.test(zw(() => V.doelInvoer({ naam: '[[x]]', bedrag: 5, datum: '2027-01-01', soort: 'sparen' }, nu))) &&
    /soort/.test(zw(() => V.doelInvoer({ naam: 'x', bedrag: 5, datum: '2027-01-01', soort: 'beleggen' }, nu))) && V.doelInvoer({ naam: 'x', bedrag: 5, datum: '2027-02', soort: 'uitgave', rekening: 'Spaar' }, nu).datum === '2027-02-01' &&
    V.doelInvoer({ naam: 'x', bedrag: 5, datum: '2027-02', soort: 'uitgave', rekening: 'Spaar' }, nu).rekening === null, null);
  const saldi = { rekeningen: [{ naam: 'Spaar Proef', valuta: 'EUR', saldo: 1400 }, { naam: 'Hoofd', valuta: 'EUR', saldo: 3000 }] };
  const dl = V.doelen({ vault: VAULT, nu: nu, saldi: saldi, ov: { buffer: { liquide: 30000 } } });
  const g = (n) => dl.doelen.find((x) => x.naam === n);
  toets('doelen: vier gelezen, gesorteerd op datum', dl.pagina === V.P_DOELEN && dl.doelen.length === 4 && dl.doelen[0].naam === 'Zonder rekening', dl.doelen.map((x) => x.naam));
  // buffer: start 9000 op 7-11-2026 → doel 39000 op 1-11-2027; vandaag is het begin: verwacht ≈ 9000, saldo 30000 → op koers
  toets('doelen: "vrij beschikbaar" leest de buffer; ver vóór de lijn = op koers, met nodig per maand', g('Buffer zes maanden').saldo === 30000 && g('Buffer zes maanden').status === 'op koers' && g('Buffer zes maanden').nodig_pm === r2(9000 / 12), g('Buffer zes maanden'));
  toets('doelen: uitgave = gepland; zonder rekening = geen telling', g('Nieuwe auto').status === 'gepland' && g('Zonder rekening').status === 'geen telling', [g('Nieuwe auto').status, g('Zonder rekening').status]);
  // achter: lijn van 1000 op 1-1-2026 naar 5000 op 1-5-2027 → op 7-11-2026 ± 3.570; saldo 1400 → achter
  const st = V.doelStand({ naam: 'Spaarpot reis', bedrag: 5000, datum: '2027-05-01', soort: 'sparen', rekening: 'spaar proef', start: 1000, sinds: '2026-01-01' }, { nu: nu, saldi: saldi });
  toets('doelStand: onder de lijn = achter (met achterstand); rekening op naam zonder hoofdletters', st.status === 'achter' && st.saldo === 1400 && st.achter > 2000 && st.pct === 28, st);
  toets('doelStand: saldo ≥ bedrag = behaald; datum voorbij = verlopen; onbekende rekening = rekening niet gevonden',
    V.doelStand({ naam: 'a', bedrag: 1000, datum: '2027-01-01', soort: 'sparen', rekening: 'Hoofd', start: 0, sinds: nu }, { nu: nu, saldi: saldi }).status === 'behaald' &&
    V.doelStand({ naam: 'a', bedrag: 9000, datum: '2026-10-01', soort: 'sparen', rekening: 'Hoofd', start: 0, sinds: '2026-01-01' }, { nu: nu, saldi: saldi }).status === 'verlopen' &&
    V.doelStand({ naam: 'a', bedrag: 9000, datum: '2027-10-01', soort: 'sparen', rekening: 'Weg', start: 0, sinds: nu }, { nu: nu, saldi: saldi }).status === 'rekening niet gevonden', null);
  const weg = V.doelenZet(tekst, { actie: 'weg', naam: 'nieuwe auto' }, nu);
  toets('doelenZet weg: alleen die rij weg, de rest en de kop blijven', !/Nieuwe auto/.test(weg) && /Spaarpot reis/.test(weg) && /## Doelen/.test(weg) && weg.split('\n').length === tekst.split('\n').length - 1, null);
  toets('doelenZet: pagina zonder tabel krijgt hem onder ## Doelen; andere tekst blijft', (() => { const x = V.doelenZet('# Mijn doelen\n\nEigen tekst.\n', op({ naam: 'A', bedrag: 10, datum: '2027-01-01', soort: 'uitgave' }), nu); return /Eigen tekst\./.test(x) && /## Doelen\n\n\| Doel \| Bedrag/.test(x) && /\| A \| € 10 \|/.test(x); })(), null);
  toets('doelenZet: een | in de naam breekt de tabel niet', /\| a b \| € 5 \|/.test(V.doelenZet(V.doelenLeeg(nu), { actie: 'nieuw', doel: Object.assign(V.doelInvoer({ naam: 'a | b', bedrag: 5, datum: '2027-01-01', soort: 'uitgave' }, nu)) }, nu)), null);

  // ── maandbrief ──
  const ovNormaal = { basis_vooruit: { per_maand: -1000, per_maand_reeks: [{ maand: '2026-10', over: -1100 }] }, buffer: { maanden: 3.2, liquide: 25000 },
    vooruit: { ok: true, maanden: [{ maand: '2026-11', krap: false, laag: 100, verwacht: 2000 }, { maand: '2026-12', krap: false }, { maand: '2027-01', krap: false }, { maand: '2027-02', krap: false }] },
    uitgaven: { maand: '2026-10', categorieen: [{ categorie: 'boodschappen', nu: 900, gem12: 880, afwijking: null }] }, advies: { start: [], adviezen: [] }, doelen: { doelen: [{ naam: 'x', status: 'op koers' }] } };
  toets('maandbrief: alles normaal = stilte (geen regel)', F.maandbriefUit(ovNormaal).length === 0, F.maandbriefUit(ovNormaal));
  const ovAf = JSON.parse(JSON.stringify(ovNormaal));
  ovAf.basis_vooruit.per_maand_reeks = [{ maand: '2026-10', over: -3200 }];
  ovAf.buffer.maanden = 1.4; ovAf.buffer.liquide = 9100;
  ovAf.vooruit.maanden[2].krap = true; Object.assign(ovAf.vooruit.maanden[2], { laag: -800, verwacht: 1200 });
  ovAf.uitgaven.categorieen = [{ categorie: 'overig', nu: 2000, gem12: 500, afwijking: 'hoger' }, { categorie: 'vrije tijd en sport', nu: 700, gem12: 300, afwijking: 'hoger' }, { categorie: 'boodschappen', nu: 1300, gem12: 880, afwijking: 'hoger' }];
  ovAf.advies = { start: ['A4:abc', 'A1:def'], adviezen: [{ id: 'A1:def', regel: 'A1', titel: 'Duurste leningdeel aflossen of geld laten staan?', band: { laag: 100, hoog: 300 }, euro_jaar: null, waarde: 100, zekerheid: 'laat toetsen' },
    { id: 'A4:abc', regel: 'A4', titel: 'Jan Proefpersoon: nieuw', euro_jaar: 240, band: null, waarde: 240, zekerheid: 'zeker' }] };
  ovAf.doelen.doelen = [{ naam: 'Buffer', status: 'achter', saldo: 4000, bedrag: 20000, nodig_pm: 1500, datum: '2027-09-01' }];
  const mb = F.maandbriefUit(ovAf);
  toets('maandbrief: vijf regels bij afwijkingen (over, buffer+krapte, categorie, advies, doel)', mb.length === 5 && mb.every((x) => x.maandbrief && x.soort === 'maand'), mb.map((x) => x.zin));
  toets('maandbrief: over noemt de maand en het gemiddelde; buffer noemt de krappe maand', /^Over in oktober 2026: − € 3\.200, gemiddeld − € 1\.000/.test(mb[0].zin) && /Buffer: 1,4 maanden/.test(mb[1].zin) && /januari 2027 kan het krap worden \(laag − € 800/.test(mb[1].zin), mb.map((x) => x.zin));
  toets('maandbrief: categorie = grootste afwijking zonder "overig"; advies A4 zonder naam', /Opvallend in oktober 2026: boodschappen € 1\.300/.test(mb[2].zin) && /een abonnement nakijken \(€ 240 per jaar\)/.test(mb[3].zin) && !/Proefpersoon/.test(JSON.stringify(mb)), mb.map((x) => x.zin));
  toets('maandbrief: doel dat achter loopt met nodig per maand', /Doel Buffer loopt achter: € 4\.000 van € 20\.000; nodig € 1\.500 per maand tot 1-9-2027/.test(mb[4].zin), mb[4].zin);
  const B1 = { peildatum: '2026-11-25', signalen: mb, stand: {} };
  const n1 = F.briefingNieuw(B1, {}, {}), n2 = F.briefingNieuw(Object.assign({}, B1, { peildatum: '2026-12-28' }), n1.gemeld, {});
  toets('maandbrief: een maand later dezelfde stand = niets opnieuw (buffer en advies op niveau, doel 180 dagen)', n1.nieuw.length === 5 && n2.nieuw.filter((x) => x.maandbrief && !/^mb-(vrij|cat)/.test(x.sleutel)).length === 0, n2.nieuw.map((x) => x.sleutel));
  const ovB = JSON.parse(JSON.stringify(ovAf)); ovB.buffer.maanden = 0.8; ovB.vooruit.maanden[2].krap = false;
  const n3 = F.briefingNieuw({ peildatum: '2026-12-28', signalen: F.maandbriefUit(ovB), stand: {} }, n1.gemeld, {});
  toets('maandbrief: buffer verschoof > 0,5 maand of de krapte verdween = de bufferregel opnieuw', n3.nieuw.some((x) => x.sleutel === 'mb-buffer'), n3.nieuw.map((x) => x.sleutel));
  const tk = F.briefingTekst(n1.nieuw.concat([{ zin: 'KPN kost nu meer.', ernst: 'wacht' }]));
  toets('briefingTekst: gewone regels eerst, dan "In het kort:" met de maandbrief, slotregel blijft', /^• KPN kost nu meer\.\nIn het kort:\n• Over in oktober/.test(tk) && /\nOverzicht in Apps › Financiën\./.test(tk) && tk.split('\n').length === 1 + 1 + 5 + 1, tk);
  toets('briefingTekst: zonder maandbrief zoals vroeger (geen "In het kort:")', !/In het kort/.test(F.briefingTekst([{ zin: 'x', ernst: 'info' }])), null);
  toets('maandbrief: zonder overzicht een fout (de pod zet dan maandbrief_fout, het gewone blok gaat door)', (() => { try { F.maandbriefUit(null); return false; } catch (e) { return true; } })(), null);
  fs.rmSync(VAULT, { recursive: true, force: true });
}
// ── broncode ──
const src = fs.existsSync('financien-vooruit.js') ? fs.readFileSync('financien-vooruit.js', 'utf8').replace(/^\s*(\*|\/\/).*$/gm, '') : '';
toets('financien-vooruit.js: geen netwerk, geen proces, schrijft zelf niets', !!src && !/require\(['"](node:)?(http|https|net|tls|dgram|dns|child_process|worker_threads)['"]\)/.test(src) && !/\bfetch\s*\(/.test(src) &&
  !/\b(writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync|mkdirSync|openSync)\b/.test(src), null);
const S = fs.readFileSync('server.js', 'utf8');
toets('server.js: POST /app/financien/doel achter de Financiën-poort, met grens, via vault-veilig, geheugen weg', /route === 'POST \/app\/financien\/doel'\) return appFinDoel/.test(S) &&
  /async function appFinDoel[\s\S]{0,400}appPriveDicht\(a, 'financien'\)/.test(S) && /appTeller\('fin-doel'/.test(S) && /VV\(\)\.wijzig\(pad, function \(t\) \{ return V\.doelenZet/.test(S) && /APP_GLIJD_ROUTES\.add\('POST \/app\/financien\/doel'\)/.test(S), null);
toets('server.js: maandbrief_fout geeft een box-rij en houdt het gewone blok niet tegen', /if \(j\.maandbrief_fout\) \{[\s\S]{0,300}bankBoxRij/.test(S), null);
toets('bank-lezer geld-briefing: saldi en PayPal voor de maandbrief', /'geld-briefing'\(a\)[\s\S]{0,500}o\.saldi = db\(\)\.prepare/.test(fs.readFileSync('bank-lezer.js', 'utf8')), null);
toets('uitrol.sh en Dockerfile: financien-vooruit.js gaat mee in de release', /RELEASE_OPTIONEEL="[^"]*\bfinancien-vooruit\.js\b/.test(fs.readFileSync('uitrol.sh', 'utf8')) &&
  /COPY financien-vooruit\.js \/app\/release-bootstrap\/financien-vooruit\.js/.test(fs.readFileSync('Dockerfile', 'utf8')), null);
console.log(goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
