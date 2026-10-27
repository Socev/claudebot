#!/usr/bin/env bash
# Toetst financien-vault.js (wv1337, App Financiën: tabbladen Hypotheek, Belasting en Holding; bouwplan Privé-financiën § 13) op een
# nagebootste vault in de vorm van de echte pagina's en json's van 26/27-10-2026 (alles verzonnen: bedragen, IBAN, lening-, polis- en
# BSN-nummers; deze repo is openbaar, Opus-review wv1337 #1): veld voor veld opgebouwd, geen IBAN/leningnummer/BSN/polisnummer in het
# antwoord, nieuwste json op datum en Excel-velden op vorm (niet op één datum), tabellen op kolomkop (ook met \| in een wikilink), RC-posten zonder de woninglening alleen als de rest optelt, doorlopende opsommingsregels, een
# kapotte bron maakt alleen dat blok leeg; registratie in uitrol.sh, Dockerfile en CI; de route in server.js geeft de drie velden door.
# Raakt de pod en de echte vault niet. Gebruik: bash test/financien-vault.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }
const F = require(path.resolve('financien-vault.js'));
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'financien-vault-'));
const V = path.join(W, 'vault');
const schrijf = (rel, t) => { fs.mkdirSync(path.dirname(path.join(V, rel)), { recursive: true }); fs.writeFileSync(path.join(V, rel), typeof t === 'string' ? t : JSON.stringify(t)); };

// ── nagebootste bronnen (alles verzonnen: bedragen, IBAN's, lening-, polis- en BSN-nummers; alleen de vorm is die van de echte bronnen) ──
const IBAN = 'NL00TEST0123456789', IBAN2 = 'NL11TEST0987654321', LENING = '12.34.56.789', LENING2 = '123.456.789', LDEEL = '1234.567.890.123', POLIS = '1234567', POLIS2 = '7654321', BSN = '111222333';
const deel = (bank, model, label, hoofd, bankRest, x9, x10, rv, beste) => ({ bank_leningdeel: bank, bank_soort: 'Lineair', bank_restschuld: bankRest, bank_rente_pct: 1.5, excel_deel: model,
  excel_label: model + ' - ' + label, excel_leningdeelnummer: 'LENINGDEEL ' + LDEEL, excel_hoofdsom: hoofd, excel_startmaand: '2010-01-01', excel_rente_pct_okt2026: model === 'Hypo8' ? 3.33 : 1.5,
  excel_aflossing_mnd: 400, excel_rente_mnd: 80, excel_restschuld_2026_09_01: x9, excel_restschuld_2026_10_01: x10, beste_match: beste, verschil_bij_beste_match: 0.01, rentevast_tm_excel_groen: rv });
const HYPO = { bron_bank: 'screenshot bankapp 26-10-2026, Woning Hypotheek ' + LENING, bank_totaal_restschuld: 150000.5, bank_oorspronkelijk: 300000, bank_afgelost: 149999.5,
  bank_maandbetaling: 1000.25, excel_bron: 'x', excel_som_delen_2026_10_01: 149500.1,
  leningdelen: [deel('201', 'Hypo1', 'Huis', 200000, 100000.5, 100000.4, 99600.2, '2031-05-01', '2026-09-01'), deel('209', 'Hypo8', 'Zolder', 100000, 50000, 50400, 50000, '2028-06-01', '2026-10-01')],
  excel_totaalkolom_okt2026: { aflossing: 700, rente: 100, bruto_last: 800, som_delen_aflossing: 800, som_delen_rente: 200 },
  controle_maandlast: { aflossing_som_delen: 800, rente_bij_bankstand_en_bankrente: 200, totaal: 1000, bank_maandbetaling: 1000.25 },
  bevindingen: ['Excel loopt een maand voor', 'Rekening ' + IBAN + ' en lening ' + LENING2 + ' in een bevinding'],
  volledige_excel_reeksen: { Hypo1: { rows: [{ datum: '2015-01-01', restschuld: 1 }] }, TOTAAL: { rows: [{ datum: '2015-01-01', restschuld: 300000.4 }, { datum: '2015-02-01', restschuld: 299000 }, { datum: '2016-01-01', restschuld: 290000 }, { datum: '2017-01-01', restschuld: null }] } } };
const HP = '20_Prive/Bronnen/Financien/Prive - 2026-10-26 - Hypotheek bank vs Excel data.json';
schrijf(HP, HYPO);
schrijf('20_Prive/Bronnen/Financien/Prive - 2026-09-01 - Hypotheek bank vs Excel data.json', Object.assign({}, HYPO, { bank_totaal_restschuld: 1 }));   // ouder: niet gebruiken
schrijf('20_Prive/Financien/Hypotheek en overlijdensrisicoverzekeringen.md', `---
updated: 2026-10-27
---
# Hypotheek
## Leningdelen
| Deel (model) | Nr. (vóór 2021) | Hoofdsom | Start | Rente nu | Rentevast t/m | Einde looptijd | Restschuld 1-5-2021 (bank) | Restschuld okt 2026 (model) |
|---|---|--:|---|--:|---|---|--:|--:|
| Hypo1 Huis | /101 | € 200.000 | jan 2010 | 1,50% | 1-5-2031 | 1-1-2040 | € 1 | € 2 |
| Hypo8 Zolder | onbekend | € 100.000 | jul 2023 | 3,33% | onbekend | ca. medio 2053 (model) | — | € 3 |
| **Totaal** | | | | | | | | **€ 5** |
## Overlijdensrisicoverzekeringen
| Polis | Verzekeraar | Nemer | Kapitaal start | Ingang | Einde polis | Premie | Premie t/m | Status |
|---|---|---|--:|---|---|--:|---|---|
| ${POLIS} | Verzekeraar A | Cynthia | € 400.000 | 1-1-2015 | 1-1-2045 | € 11,11/mnd | looptijd | actief; polis ${POLIS} |
| ${POLIS2} | Verzekeraar B | David | € 100.000 | 1-5-2014 | 1-5-2019 | € 2,22/mnd | — | **verlopen** |
`);
schrijf('20_Prive/Financien/Belastingaangiftes IB 2011-2025.md', `---
updated: 2026-10-27
---
# Belastingaangiftes
## David — kerngetallen per jaar
| Jaar | Datum aangifte | Loon | Belastbare winst | Saldo eigen woning | Box 1 | Box 2 | Verschuldigd IB/PVV | Saldo |
|---|---|---|---|---|---|---|---|---|
| 2011 | 19-03-2012 (concept) | 30.000 | – | – | 30.000 | 0 | 8.000 | 0 |
| 2016 | 08-03-2017 | – | 200.000 | −10.000 | 190.000 | 0 | 90.000 | +11.111 |
| 2017 | 26-02-2018 | – | 180.000 | −9.000 | 171.000 | 0 | 80.000 | −22.222 |
| 2025 | 14-04-2026 | 210.000 | – | −5.000 (geheel bij Cynthia) | 170.000 | 50.000 | 90.000 | 0 (+12, geen aanslag) |
BSN ${BSN} hoort hier nooit, maar staat in de tekst.
### Eigen woning en box 3
| Jaar | WOZ-waarde | Eigenwoningforfait | Aftrekbare rente | Eigenwoningschuld 31-12 | Box 3 grondslag (samen) |
|---|---|---|---|---|---|
| 2014 | – (in aanbouw) | – | 300 (+ 2.000 financieringskosten) | 100.000 (na bouwdepot) | – |
| 2025 | 1.100.000 | 3.000 | 9.000 | 500.000 | 30.000 |
## Fam Schaap 2015-2017
| Jaar | Box 1 David | Saldo David | Box 1 Cynthia | Saldo Cynthia |
|---|---|---|---|---|
| 2015 | 130.000 | −4.000 | 20.000 | +5.000 |
## Cynthia — kerngetallen per jaar
| Jaar | Stuk (datum) | Inkomen uit werk | EW forfait / aftrek / saldo | Aandeel C EW | Box 1 | Box 2 | Box 3 aandeel C | AHK | IACK | Uitkomst |
|---|---|---|---|---|---|---|---|---|---|---|
| 2011 | concept-aangifte (19-3-2012), scan | geen | – | – | 0 | 0 | 0 | 1.500 | – | terug 1.500 |
| 2015 | aangifte (geen datum) | overig werk 20.000 | 400 / 10.000 / -9.600 | 0 | 20.000 | 0 | 0 | 2.000 | 1.800 | bij 5.000 (IB 4.000 + Zvw 1.000) |
| 2025 | aangifte (14-4-2026) | loon 30.000 | 3.000 / 9.000 / -6.000 | -6.000 | 24.000 | 7.000 | 0 | 2.500 | 2.500 | terug 7.777 |
`);
const DGA = { meta: { status: 'concept', rekeningen: { holding: IBAN } },
  stand_2026_10_26: { rc_dga: { bedrag: 20000, basis: 'JR 31-12-2025 30.000 − 10.000; rekening ' + IBAN } },
  contracten: { woninglening: { hoofdsom: 20000, ingangsdatum: '2023-07-01', rente_pct: 4.0, termijn: 100.5, eerste_termijn: '2024-03-01', laatste_termijn: '2054-02-01', doel: 'verbouwing', schuldenaar: 'X. Test BSN ' + BSN },
    rekening_courant: { maximum: 40000, rente_pct: 4.5, rentegrondslag: 'geen rente als stand hele jaar < 17.500', aflossing: '5.000 per jaar per 31-12', getekend: '2023-10-01 Ergens' } },
  woninglening_verloop: { samenvatting: { jaarrekening: { 2023: 20000, 2024: 19500, 2025: 19000 } } },
  dividend: [{ datum: '2025-01-30', bruto: '60000', dividendbelasting_15pct: '9000.00', netto_verwacht: '51000.00', netto_betaald: '45000.00', verschil: '6000.00', omschrijving: 'Uitbetaling', tegenrekening: IBAN2 }],
  transacties: [{ tegenrekening: IBAN2, naam: 'X TEST' }] };
const DGAP = '10_Zakelijk/Holding/Bronnen/Holding - 2026-10-26 - DGA-reconstructie data.json';
schrijf(DGAP, DGA);
const besluit = (totaal, status2) => `---
status: vastgesteld door David op 26-10-2026; uitvoering loopt
updated: 2026-10-27
---
# Afbouw
## Besluit en planning
| Wanneer | Actie | Wie | Status |
|---|---|---|---|
| 26-10-2026 | Inhaalbetaling € 1.000,50 naar de Holding (${IBAN}) | David | **uitgevoerd 26-10** (opgave David) |
| **01-12-2026** | **Knoop doorhakken** (zie [[00_Systeem/Deadlines\\|Deadlines]], sein 1-12) | David + Acta | ${status2 || 'open'} |
## Onderbouwing
| Post | Bedrag |
|---|---|
| Woninglening per 31-12-2025 | € 19.000,00 |
| RC-schuld 31-12-2025 | € 10.000,10 |
| Privé-opnames 2026 | € 100,40 |
| **Totaal privé-schuld RC** | **€ ${totaal}** |
## Ter bevestiging door Acta Synergia
- Termijn woninglening € 100,50.
- Exacte resterende ruimte box 2 voor 2026 (schatting € 5.000); het decemberdividend van
  € 20.000 en het interim-dividend in december.
`;
const BESLUIT = '10_Zakelijk/Holding/Financieel/Afbouw rekening-courant en herstel woninglening (besluit 2026-10-26).md';
schrijf(BESLUIT, besluit('10.100,50'));

// ── lezen ──
let r = F.lees(V);
const s = JSON.stringify(r);
toets('alle drie de blokken, geen fouten', r.fouten.length === 0 && r.hypotheek && r.belasting && r.dga, r.fouten);
const lek = new RegExp([IBAN, IBAN2, LENING, LENING2, LDEEL, POLIS, POLIS2, BSN, 'LENINGDEEL'].map((x) => x.replace(/\./g, '\\.')).join('|'), 'g');
toets('geen IBAN, leningnummer, polisnummer of BSN in het antwoord', !lek.test(s), s.match(lek));
toets('geen transacties, meta of schuldenaar doorgegeven', !/X TEST|transacties|schuldenaar|tegenrekening|rekeningen/.test(s));
// hypotheek
const h = r.hypotheek;
toets('hypotheek: nieuwste json (26-10, niet 1-9), bankstand en maandbetaling', h.bank.restschuld === 150000.5 && h.bank.maandbetaling === 1000.25 && h.bron.bank_op === '2026-10-26' && /26-10/.test(h.bron.data), h.bank);
toets('hypotheek: bron noemt de schermafdruk (Nederlandse datum) zonder leningnummer', /ABN AMRO-app \(schermafdruk 26-10-2026\)/.test(h.bron.bank) && !/12\.34/.test(h.bron.bank), h.bron.bank);
const d1 = h.delen[0];
toets('hypotheek: deel 201 = Hypo1 Huis, verschil bank − Excel, Excel gelijk op 1-9, Excel-datum mee', d1.deel === '201' && d1.model === 'Hypo1' && d1.doel === 'Huis' && d1.verschil === 400.3 && d1.excel_gelijk_op === '2026-09-01' && d1.restschuld_excel === 99600.2 && h.bron.excel_op === '2026-10-01', d1);
toets('hypotheek: rente Excel uit het veld met maand in de naam, rentevast met bronzin', h.delen[1].rente_excel === 3.33 && /Excel/.test(h.bron.rentevast), [h.delen[1].rente_excel, h.bron.rentevast]);
toets('hypotheek: einde looptijd uit de paginatabel (ook "ca. medio 2053 (model)")', d1.einde === '1-1-2040' && h.delen[1].einde === 'ca. medio 2053 (model)', h.delen.map((x) => x.einde));
toets('hypotheek: eerste renteherziening = vroegste rentevaste datum (Hypo8, juni 2028)', h.eerste_renteherziening && h.eerste_renteherziening.datum === '2028-06-01' && h.eerste_renteherziening.deel === '209', h.eerste_renteherziening);
toets('hypotheek: Excel-totaal met zijn datum', h.excel.restschuld === 149500.1 && h.excel.restschuld_op === '2026-10-01' && h.excel.maandlast_totaalkolom === 800, h.excel);
toets('hypotheek: verloop alleen 1 januari uit TOTAAL, null overgeslagen', JSON.stringify(h.verloop) === JSON.stringify([{ jaar: 2015, restschuld: 300000 }, { jaar: 2016, restschuld: 290000 }]), h.verloop);
toets('hypotheek: bevinding met IBAN en leningnummer gemaskeerd', h.bevindingen[1].includes('[rekening]') && h.bevindingen[1].includes('[nummer]'), h.bevindingen);
toets('hypotheek: ORV zonder polisnummer, kapitaal en premie als getal, status zonder **', h.orv.length === 2 && h.orv[0].kapitaal_start === 400000 && h.orv[0].premie_mnd === 11.11 && h.orv[1].status === 'verlopen' && !('polis' in h.orv[0]), h.orv);
toets('hypotheek: woninglening Holding erbij (contract + jaarrekeningstanden)', h.holding && h.holding.hoofdsom === 20000 && h.holding.termijn === 100.5 && h.holding.jaarrekening.length === 3 && h.holding.jaarrekening[2].stand === 19000, h.holding);
// een nieuwere aanlevering met een andere Excel-datum: velden op vorm, niet op 1-10-2026
const H2 = JSON.parse(JSON.stringify(HYPO)); H2.leningdelen.forEach((x) => { x.excel_restschuld_2027_01_01 = 1234.5; delete x.excel_restschuld_2026_10_01; }); H2.excel_som_delen_2027_01_01 = 2469; delete H2.excel_som_delen_2026_10_01; H2.bron_bank = 'screenshot 5-1-2027';
schrijf('20_Prive/Bronnen/Financien/Prive - 2027-01-05 - Hypotheek bank vs Excel data.json', H2);
r = F.lees(V);
toets('nieuwe aanlevering (5-1-2027): Excel-stand 1-1-2027 gevonden, verschil en totaal niet leeg', r.hypotheek.bron.excel_op === '2027-01-01' && r.hypotheek.delen[0].restschuld_excel === 1234.5 && r.hypotheek.excel.restschuld === 2469 && r.hypotheek.bron.bank_op === '2027-01-05', [r.hypotheek.bron, r.hypotheek.excel]);
fs.rmSync(path.join(V, '20_Prive/Bronnen/Financien/Prive - 2027-01-05 - Hypotheek bank vs Excel data.json'));
r = F.lees(V);
// belasting
const b = r.belasting;
toets('belasting: David per jaar uit de pagina (niet de kerncijfers-json), saldo met teken', b.david.length === 4 && b.david[1].saldo === 11111 && b.david[2].saldo === -22222 && b.david[0].concept === true && b.david[0].datum === '2012-03-19', b.david);
toets('belasting: David 2025 saldo 0 met toelichting, box 2', b.david[3].saldo === 0 && /geen aanslag/.test(b.david[3].toelichting) && b.david[3].box2 === 50000 && !('saldo_eigen_woning' in b.david[3]), b.david[3]);
toets('belasting: Fam Schaap-tabel niet als David of Cynthia gelezen', b.david.every((x) => x.jaar !== 2015) && b.cynthia.length === 3, [b.david.map((x) => x.jaar), b.cynthia.map((x) => x.jaar)]);
toets('belasting: Cynthia uitkomst terug = negatief, bij = positief, datum uit "Stuk (datum)"', b.cynthia[0].uitkomst === -1500 && b.cynthia[1].uitkomst === 5000 && b.cynthia[2].uitkomst === -7777 && b.cynthia[0].concept && b.cynthia[0].datum === '2012-03-19', b.cynthia);
toets('belasting: eigen woning (– = leeg, eerste getal, 1.100.000 blijft een bedrag) met noot uit de haakjes', b.woning[0].woz === null && b.woning[0].rente === 300 && b.woning[0].schuld === 100000 && b.woning[1].woz === 1100000 &&
  /WOZ: in aanbouw/.test(b.woning[0].noot) && /schuld: na bouwdepot/.test(b.woning[0].noot) && b.woning[1].noot === null, b.woning);
// dga
const g = r.dga;
toets('holding: planning met wikilink-naam (\\| in de cel) en klaar bij "uitgevoerd"', g.planning.length === 2 && g.planning[0].klaar === true && g.planning[1].klaar === false && /Deadlines, sein 1-12/.test(g.planning[1].actie) && g.planning[1].wanneer === '01-12-2026', g.planning);
toets('holding: IBAN in een planningsregel gemaskeerd', /\[rekening\]/.test(g.planning[0].actie), g.planning[0].actie);
toets('holding: RC-posten zonder woninglening als de rest optelt tot het totaal', g.rc.telt_op === true && g.rc.totaal === 10100.5 && g.rc.posten.length === 2 && !g.rc.posten.some((p) => /woninglening/i.test(p.post)), g.rc);
toets('holding: reconstructie (alleen Holding, met datum) en contract (rentevrij onder 17.500, getekend als datum)', g.rc.reconstructie.bedrag === 20000 && g.rc.reconstructie.alleen === 'Holding' && g.rc.reconstructie.op === '2026-10-26' && /\[rekening\]/.test(g.rc.reconstructie.basis) && g.rc_contract.rentevrij_onder === 17500 && g.rc_contract.getekend === '2023-10-01', [g.rc, g.rc_contract]);
toets('holding: dividend veld voor veld (getallen), punten ter bevestiging met doorlopende regel', g.dividend[0].netto_betaald === 45000 && g.dividend[0].verschil === 6000 && !('tegenrekening' in g.dividend[0]) && g.bevestigen.length === 2 && /€ 20\.000 en het interim-dividend/.test(g.bevestigen[1]), [g.dividend, g.bevestigen]);
toets('holding: besluitstatus uit de frontmatter, data als concept', /vastgesteld door David/.test(g.bron.besluit) && g.bron.data_status === 'concept', g.bron);
// "niet uitgevoerd" / "deels betaald" zijn niet klaar
for (const st of ['niet uitgevoerd', 'deels betaald', 'nog niet betaald', 'onbetaald']) {
  schrijf(BESLUIT, besluit('10.100,50', st));
  toets('holding: status "' + st + '" is niet gedaan', F.lees(V).dga.planning[1].klaar === false);
}
schrijf(BESLUIT, besluit('10.100,50', 'betaald 2-12'));
toets('holding: status "betaald 2-12" is gedaan', F.lees(V).dga.planning[1].klaar === true);
// RC telt niet op → tabel zoals op de pagina
schrijf(BESLUIT, besluit('99.999,99'));
r = F.lees(V);
toets('holding: telt de rest niet op, dan alle posten zoals op de pagina', r.dga.rc.telt_op === false && r.dga.rc.posten.length === 3, r.dga.rc);
// kapotte en ontbrekende bronnen
fs.writeFileSync(path.join(V, HP), '{kapot');
r = F.lees(V);
toets('kapotte hypotheek-json: alleen hypotheek in fouten, de rest blijft', JSON.stringify(r.fouten) === '["hypotheek"]' && r.hypotheek === null && r.belasting && r.dga, r.fouten);
fs.renameSync(path.join(V, '20_Prive/Financien/Belastingaangiftes IB 2011-2025.md'), path.join(W, 'weg.md'));
r = F.lees(V);
toets('verplaatste belastingpagina: belasting in fouten', r.fouten.includes('belasting') && r.belasting === null, r.fouten);
fs.writeFileSync(path.join(V, '20_Prive/Financien/Belastingaangiftes IB 2011-2025.md'), '# leeg\ngeen tabellen');
r = F.lees(V);
toets('pagina zonder aangiftetabellen: belasting in fouten (geen lege tabel als "alles nul")', r.fouten.includes('belasting'), r.fouten);
toets('lege vault: drie fouten, geen uitzondering', JSON.stringify(F.lees(path.join(W, 'niets')).fouten) === '["hypotheek","belasting","dga"]');

// ── hulpjes ──
const NG = [['€ 12.345,67', 12345.67], ['−1.234', -1234], ['+€ 2.000', 2000], ['1,23%', 1.23], ['–', null], ['– (in aanbouw)', null], ['–4.321', -4321], ['ca. € 1.900/mnd', 1900], ['-6.789', -6789], ['4.20%', 4.2], ['2.468', 2468], ['1.100.000', 1100000]];
const ngFout = NG.filter((x) => F.nlGetal(x[0]) !== x[1]).map((x) => [x[0], F.nlGetal(x[0])]);
toets('nlGetal (ook en-dash als min vóór een cijfer, decimale punt)', ngFout.length === 0, ngFout);
const sc = F.schoon('€ 1.234.567 en ' + LENING2 + ' en 1.234,50 en NL00 TEST 0123 4567 89 en ' + BSN + ' en polis ' + POLIS);
toets('schoon: bedragen blijven, nummers weg', sc === '€ 1.234.567 en [nummer] en 1.234,50 en [rekening] en [nummer] en polis [nummer]', sc);

// ── registratie ──
toets('uitrol.sh: financien-vault.js optioneel in de release', /RELEASE_OPTIONEEL="[^"]*\bfinancien-vault\.js\b/.test(fs.readFileSync('uitrol.sh', 'utf8')));
toets('Dockerfile: financien-vault.js in release-bootstrap', /COPY financien-vault\.js \/app\/release-bootstrap\/financien-vault\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
toets('CI: deze toets draait', /bash test\/financien-vault\.sh/.test(fs.readFileSync('.github/workflows/build.yml', 'utf8')));
const SRV = fs.readFileSync('server.js', 'utf8');
toets('server.js: appFinancien voegt het vaultdeel toe (ook uit het geheugen en bij de terugval), los van het bankgeheugen', (SRV.match(/appFinSamen\(\{ ok: true[^\n]*appFinVault\(nu\)\)/g) || []).length === 3 && /let appFinVaultCache = null/.test(SRV));
fs.rmSync(W, { recursive: true, force: true });
console.log(`\n${goed} groen, ${fouten} rood`);
process.exit(fouten ? 1 : 0);
JS
