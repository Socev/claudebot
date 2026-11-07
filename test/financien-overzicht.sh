#!/usr/bin/env bash
# Toetst financien-overzicht.js (wv2596, OVIS Financiën 8+ stap 1 en 2; ontwerp vault "01_Ontwikkeling/OVIS Financiën 8+ (ontwerp 7-11-2026)")
# op een nagebootste transactiedatabase: elke privéboeking één stroom (de hypotheektermijn in aflossing + rente), som van de stromen = som
# van de boekingen per maand, POT en extern buiten beeld, Holding-privéopname en terugstorting = verschuiven, loon = inkomen, onzeker in de
# opruimlijst; de vier kerngetallen reproduceerbaar uit hun onderbouwing (elke regel = de som van zijn boekingenlijst); privé en Holding
# nooit opgeteld; Davids keuze per tegenpartij wint en is terug te draaien; bank-lezer app-boekingen/app-stroom; de routes in server.js.
# Raakt de pod, de kluis, de bank, de vault en /opt/data/bank niet. Gebruik: bash test/financien-overzicht.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings --require ./test/vaste-klok.cjs - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'financien-overzicht-'));
const BD = path.join(W, 'bank'), VAULT = path.join(W, 'vault');
const A = require(path.resolve('bank-archief.js')), F = require(path.resolve('financien-app.js'));
let O = null;
try { O = require(path.resolve('financien-overzicht.js')); } catch (e) { O = null; }
toets('financien-overzicht.js bestaat en laadt', !!O, null);
const FV = require(path.resolve('financien-vault.js'));
const vandaag = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }), mNu = vandaag.slice(0, 7);
const mnd = []; for (let i = 14; i >= 1; i--) mnd.push(F.maandPlus(mNu, -i));   // 14 volledige maanden
const IV = { vl: 'NL00ABNA0123456789', pr: 'NL11BUNQ0000000001', sp: 'NL55BUNQ0000000005', ki: 'NL66BUNQ0000000006', el: 'NL44BUNQ0000000004', pt: 'NL77ABNA0987654321' };
const REK = {
  vl: { uid: 'u1', bank: 'ABN AMRO', label: 'Vaste lasten', naam: 'D VOORBEELD CJ', iban: IV.vl, sessie: 's1' },
  pt: { uid: 'u2', bank: 'ABN AMRO', label: 'POT', naam: 'D VOORBEELD', iban: IV.pt, sessie: 's1' },
  pr: { bron: 'bunq', uid: 'bunq-1', bunq_id: 1, naam: 'Hoofdrekening', soort: 'lopend', iban: IV.pr, status: 'ACTIVE' },
  sp: { bron: 'bunq', uid: 'bunq-5', bunq_id: 5, naam: 'Spaar', soort: 'spaar', iban: IV.sp, status: 'ACTIVE' },
  ki: { bron: 'bunq', uid: 'bunq-6', bunq_id: 6, naam: 'Kids sparen', soort: 'spaar', iban: IV.ki, status: 'ACTIVE' },
  el: { bron: 'bunq', uid: 'bunq-4', bunq_id: 4, naam: 'Rekening Petronella', soort: 'lopend', iban: IV.el, status: 'ACTIVE' },
};
let n = 0;
const p = (datum, bedrag, tegen, oms, extra) => Object.assign({ id: 'x:' + (++n), datum: datum, valutadatum: datum, bedrag: bedrag, valuta: 'EUR', tegenpartij: tegen, omschrijving: oms || null,
  status: 'geboekt', saldo_na: null, mcc: null, tegen_iban: null, _ruw: { id: n, bron: 'nagebootst' } }, extra || {});
const dg = (ym, d) => ym + '-' + String(d).padStart(2, '0');
const VL = [], PR = [], SP = [], KI = [], EL = [], PT = [];
const inc = (mach, naam) => 'SEPA Incasso algemeen doorlopend Incassant: NL00ZZZ999999990000 Naam: ' + naam + ' Machtiging: ' + mach + ' Omschrijving: Termijn';
mnd.forEach((ym, k) => {
  VL.push(p(dg(ym, 1), -(2800 - 2.5 * k), 'ABN AMRO BANK NV', inc('ST1', 'ABN AMRO BANK NV')));                 // hypotheek
  PR.push(p(dg(ym, 15), 8000, 'PRIMUM NON NOCERE HOLDING BV', 'Salaris ' + ym, { tegen_iban: 'NL35ABNA0000000035' }));   // loon
  PR.push(p(dg(ym, 3), -500, 'Spaar', 'sparen', { tegen_iban: IV.sp })); SP.push(p(dg(ym, 3), 500, 'D. Voorbeeld', 'sparen', { tegen_iban: IV.pr }));   // intern paar
  PR.push(p(dg(ym, 5), -3000, 'D. Voorbeeld', 'naar vaste lasten', { tegen_iban: IV.vl })); VL.push(p(dg(ym, 5), 3000, 'D. Voorbeeld', 'van hoofd', { tegen_iban: IV.pr }));
  PR.push(p(dg(ym, 8), -400, 'Albert Heijn 1234', 'boodschappen'));
  PR.push(p(dg(ym, 9), -60, 'Bakker Proef', 'brood'));
  PR.push(p(dg(ym, 20), 700, 'Cynthia', 'bijdrage huishouden', { tegen_iban: 'NL19BUNQ0000000019' }));   // eigen rekening, niet gekoppeld
  VL.push(p(dg(ym, 25), -200, 'Tibber Netherlands B.V.', inc('TB1', 'Tibber')));
  EL.push(p(dg(ym, 21), -99, 'Iemand Anders', 'extern, telt niet'));
  PT.push(p(dg(ym, 25), -2500, 'Medewerker POT', 'salaris POT'));
  KI.push(p(dg(ym, 12), -10, 'Speelgoedwinkel Proef', 'cadeau'));
});
const m1 = mnd[mnd.length - 2], m0 = mnd[mnd.length - 1], mOud = mnd[0];
PR.push(p(dg(m1, 10), 3000, 'PRIMUM NON NOCERE HOLDING BV', 'Privéopname', { tegen_iban: 'NL35ABNA0000000035' }));
PR.push(p(dg(m0, 11), -3000, 'Primum Non Nocere Holding BV', 'terugstorting', { tegen_iban: 'NL35ABNA0000000035' }));
PR.push(p(dg(m1, 12), -4000, 'Reisbureau Proef', 'zomervakantie'));                     // eenmalig groot
PR.push(p(dg(m1, 13), -1500, 'BIJSCHRIJVING SALDO OP', 'BIJSCHRIJVING SALDO OP UW CREDITCARD ****.****.****.1234'));   // creditcard, geen eenmalig
PR.push(p(dg(m1, 14), -300, 'Winkel Onbekend', 'iets'));                                // onzeker: opruimlijst
PR.push(p(dg(m0, 9), -60, 'Bakker Proef', 'brood zonder indeling'));                    // erft de categorie van de andere posten
PR.push(p(dg(m0, 16), 500, 'BELASTINGDIENST', 'teruggaaf'));                            // telt als minder leven, bij belastingen
PR.push(p(dg(m0, 17), -2000, 'Kees Proef', 'Omruil cash voor digitaal'));              // contant geld
PR.push(p(dg(m0, 18), -50, 'Ver Weg Winkel', 'in dollars', { valuta: 'USD' }));         // andere munt: telt niet
PR.push(p(dg(m0, 2), -2800, 'ABN AMRO BANK NV', 'extra termijn'));                      // tweede termijn in één maand
const a = A.open(BD);
A.zakelijkZet(a, { [IV.pt]: 'POT' });
A.rekeningenSync(a, REK);
A.bij(a, 'vl', VL, { volledigVanaf: mOud + '-01' }); A.bij(a, 'pr', PR, {}); A.bij(a, 'sp', SP, {}); A.bij(a, 'ki', KI, {}); A.bij(a, 'el', EL, {}); A.bij(a, 'pt', PT, {});
A.corrigeer(a, { rek: 'el', eigenaar: 'extern' });
A.corrigeer(a, { rek: 'ki', eigenaar: 'kind' });
A.verrijk(a);
// de indeling die de AI anders zou geven: met de hand, als David (blijft staan bij een volgende verrijking)
const zet = (where, cat, sub) => a.db.prepare("UPDATE verrijking SET categorie = ?, subcategorie = ?, herkomst = 'david', david_velden = 'categorie,subcategorie' WHERE nr IN (SELECT nr FROM transacties WHERE " + where + ')').run(cat, sub || null);
zet("tegenpartij = 'ABN AMRO BANK NV'", 'wonen', 'hypotheek');
zet("tegenpartij LIKE 'PRIMUM%' AND omschrijving LIKE 'Salaris%'", 'inkomen', 'salaris');
zet("tegenpartij LIKE 'PRIMUM%' AND omschrijving = 'Privéopname'", 'overig inkomen', 'privéopname');
zet("tegenpartij = 'Primum Non Nocere Holding BV'", 'overig', 'terugstorting');
zet("tegenpartij LIKE 'Albert Heijn%'", 'boodschappen', 'supermarkt');
zet("tegenpartij = 'Bakker Proef' AND omschrijving = 'brood'", 'boodschappen', 'bakker');
zet("tegenpartij LIKE 'Tibber%'", 'wonen', 'energie');
zet("tegenpartij = 'Reisbureau Proef'", 'vakantie en reizen', null);
zet("tegenpartij = 'BELASTINGDIENST'", 'teruggave en terugbetaling', 'belastingteruggave');
zet("tegenpartij LIKE 'Speelgoed%'", 'kinderen', null);
// vault: woning en kerncijfers Holding als pagina; hypotheek en Holding-blokken nagebootst (financien-vault.js heeft een eigen toets)
fs.mkdirSync(path.join(VAULT, '20_Prive', 'Huis'), { recursive: true }); fs.writeFileSync(path.join(VAULT, '20_Prive', 'Huis', 'Woning - notities.md'), '# zonder taxatietabel\n'); fs.mkdirSync(path.join(VAULT, '10_Zakelijk', 'Holding', 'Financieel'), { recursive: true });
fs.writeFileSync(path.join(VAULT, '20_Prive', 'Huis', 'Woning Proefstraat 1.md'), '# Woning\n\n## Taxatiegeschiedenis\n\n| Rapport | Peildatum | Taxateur / kantoor | Doel | Marktwaarde | Na verbouwing | Validatie |\n|---|---|---|---|---|---|---|\n' +
  '| 1-1-2016 | 1-1-2016 | Proef | financiering | € 400.000 | n.v.t. | x |\n| 2-2-2023 | 2-2-2023 | Proef | financiering | € 500.000 | **€ 520.000** (verbouwing € 20.000) | y |\n');
fs.writeFileSync(path.join(VAULT, '10_Zakelijk', 'Holding', 'Financieel', 'Kerncijfers - HOLD.md'), '# HOLD\n\n## Kerncijfers\n\n| bedragen in hele euro\'s | 2024 | 2025 |\n|---|--:|--:|\n| Eigen vermogen | 300.000 | 400.000 |\n| Liquide middelen | 1.000 | 2.000 |\n');
const nepVault = { hypotheek: { controle: { aflossing: 2000 }, bank: { restschuld: 300000 }, bron: { pagina: 'Hypotheek.md', bank_op: '2026-10-26' } },
  dga: { rc: { totaal: 10000 }, woninglening: { jaarrekening: [{ jaar: 2025, stand: 20000 }] }, bron: { pagina: 'Besluit.md', data: 'DGA.json', pagina_bijgewerkt: '2026-10-28' } },
  belasting: { woning: [{ jaar: 2025, woz: 600000 }] }, fouten: [] };
const FVnep = Object.assign({}, FV, { lees: () => nepVault });
const saldi = { rekeningen: [{ naam: 'Hoofdrekening', groep: 'eigen', valuta: 'EUR', saldo: 9000, stand_van: '2026-11-07T06:00:00Z' }, { naam: 'Vaste lasten', groep: 'samen', valuta: 'EUR', saldo: 3000, stand_van: '2026-11-07T05:00:00Z' },
  { naam: 'Kids sparen', groep: 'kind', valuta: 'EUR', saldo: 700, stand_van: null }, { naam: 'Gambia', groep: 'gambia', valuta: 'EUR', saldo: 400, stand_van: null }, { naam: 'GMD', groep: 'eigen', valuta: 'GMD', saldo: 99999 }] };
if (O) {
  const ov = () => O.overzicht(A, a, { nu: vandaag, vanaf: mOud, saldi: saldi, vault: VAULT, fv: FVnep });
  const o = ov();
  const lijst = (f) => O.boekingenLijst(A, a, { filter: f, vault: VAULT, fv: FVnep });
  toets('venster: de laatste 12 volledige maanden, label zichtbare rekeningen', o.venster.maanden === 12 && o.venster.van === mnd[2] && o.venster.tot === m0 && o.label === 'zichtbare rekeningen' && !o.fouten.length, [o.venster, o.fouten]);
  // somtoets: per maand stromen = boekingen (onafhankelijk: SQL over alle eigen rekeningen zonder POT/extern, EUR)
  const sql = new Map(a.db.prepare("SELECT substr(t.datum, 1, 7) m, sum(t.bedrag) s FROM transacties t JOIN rekeningen r ON r.rek = t.rek WHERE t.status IN ('booked', 'pending') AND coalesce(t.valuta, 'EUR') = 'EUR' AND lower(coalesce(r.eigenaar, '')) NOT IN ('extern', 'pot') GROUP BY 1").all().map((r) => [r.m, r.s]));
  const alle = lijst({ van: mnd[0], tot: m0 });
  toets('somtoets: som van de stromen per maand = som van de boekingen (SQL), en controle.som_klopt', o.controle.som_klopt === true && mnd.every((m) => {
    const l = lijst({ van: m, tot: m }); return Math.abs(l.som - (sql.get(m) || 0)) < 0.01; }), mnd.map((m) => [m, lijst({ van: m, tot: m }).som, sql.get(m)]));
  toets('POT, extern en een andere munt tellen niet mee', !alle.boekingen.some((b) => /Medewerker POT|Iemand Anders|Ver Weg/.test(b.tegenpartij || '')) && o.controle.ander_valuta === 1, o.controle);
  const hyp = lijst({ van: m0, tot: m0, id: alle.boekingen.find((b) => b.tegenpartij === 'ABN AMRO BANK NV').id });
  toets('hypotheektermijn in delen: aflossing 2000 = verschuiven/verplicht, de rest leven; twee termijnen in één maand allebei', hyp.boekingen.filter((b) => b.stroom === 'verschuiven' && b.sub === 'verplicht' && b.bedrag === -2000).length === 2 &&
    hyp.boekingen.filter((b) => b.stroom === 'leven' && b.bedrag === b.heel + 2000).length === 2, hyp.boekingen);
  const st = (re) => alle.boekingen.filter((b) => re.test((b.tegenpartij || '') + ' ' + (b.omschrijving || '')));
  toets('Holding: loon = inkomen; privéopname en terugstorting = verschuiven/vrijwillig (onzeker)', st(/Salaris/).every((b) => b.stroom === 'inkomen') &&
    st(/Privéopname/).every((b) => b.stroom === 'verschuiven' && b.sub === 'vrijwillig' && b.onzeker) && st(/terugstorting/).every((b) => b.stroom === 'verschuiven'), [st(/Privéopname/), st(/terugstorting/)]);
  toets('intern paar = intern; niet-gekoppelde eigen rekening = inkomen/buiten_zicht', st(/^Spaar|sparen/).every((b) => b.stroom === 'intern') && st(/^Cynthia/).every((b) => b.stroom === 'inkomen' && b.sub === 'buiten_zicht'), st(/^Cynthia/).slice(0, 2));
  toets('creditcard = leven zonder eenmalig; reis ≥ 1000 = eenmalig; contant op omschrijving; Belastingdienst-teruggave = belastingen; categorie geërfd', st(/CREDITCARD/)[0].stroom === 'leven' && !st(/CREDITCARD/)[0].eenmalig &&
    st(/Reisbureau/)[0].eenmalig === true && st(/Kees Proef/)[0].categorie === 'contant geld' && st(/BELASTINGDIENST/)[0].categorie === 'belastingen' && st(/BELASTINGDIENST/)[0].stroom === 'leven' &&
    st(/zonder indeling/)[0].categorie === 'boodschappen' && !st(/zonder indeling/)[0].onzeker, [st(/CREDITCARD/), st(/Reisbureau/), st(/Kees Proef/), st(/zonder indeling/)]);
  toets('opruimlijst: onzeker, grootste euro\'s eerst (Holding en Winkel Onbekend erin, loon niet)', o.opruimen.some((g) => g.naam === 'Winkel Onbekend') && o.opruimen.some((g) => /PRIMUM/.test(g.naam) && g.stroom === 'verschuiven') &&
    !o.opruimen.some((g) => /Salaris/.test(g.naam)) && o.opruimen.every((g, i, l) => i === 0 || Math.abs(l[i - 1].som) >= Math.abs(g.som)), o.opruimen.map((g) => [g.naam, g.som, g.stroom]));
  toets('steekproef: hooguit 40, op euro\'s, de hypotheek met verdeling', o.steekproef.length <= 40 && o.steekproef.some((g) => g.naam === 'ABN AMRO BANK NV' && g.verdeling && g.verdeling.length === 2), o.steekproef.slice(0, 3));
  // reproduceerbaar: elke regel van vrij per maand = (som van zijn boekingenlijst) / 12; per_maand = de som van de hoofdregels
  const regelOk = o.vrij.regels.every((r) => Math.abs(lijst(r.filter).som / 12 - r.bedrag) < 0.01);
  const hoofd = o.vrij.regels.filter((r) => !r.sub).reduce((s, r) => s + r.bedrag, 0);
  toets('vrij per maand: elke regel = zijn boekingen / 12; per maand = inkomen + leven + aflossing', regelOk && Math.abs(hoofd - o.vrij.per_maand) < 0.02 && o.vrij.regels.some((r) => /aflossing/i.test(r.tekst)), o.vrij);
  const een = o.vrij.regels.find((r) => /eenmalig/.test(r.tekst));
  toets('vrij zonder eenmalig = vrij + eenmalig per maand', een && Math.abs(o.vrij.zonder_eenmalig - (o.vrij.per_maand - een.bedrag)) < 0.02, [o.vrij.per_maand, o.vrij.zonder_eenmalig, een]);
  const ink = lijst(o.spaarquote.regels[0].filter).som, lev = -lijst(o.spaarquote.regels[1].filter).som;
  toets('spaarquote = (inkomen − leven) ÷ inkomen uit de boekingen', Math.abs(o.spaarquote.pct - Math.round((ink - lev) / ink * 1000) / 10) < 0.051, [o.spaarquote, ink, lev]);
  const lz = -lijst(o.buffer.regels[1].filter).som / 12;
  toets('buffer = vrij beschikbaar (David + gedeeld, EUR) ÷ leven zonder eenmalig; kinderen en Gambia apart', o.buffer.liquide === 12000 && Math.abs(o.buffer.maanden - Math.round(12000 / lz * 10) / 10) < 0.051 &&
    o.buffer.niet_meegeteld.some((x) => x.bedrag === 700) && o.buffer.niet_meegeteld.some((x) => x.bedrag === 400) && o.buffer.stand_van === '2026-11-07T05:00:00Z', o.buffer);
  const pv = o.vermogen.prive;
  toets('vermogen privé = 12.000 + 520.000 (laatste taxatie, na verbouwing) − 300.000 − 20.000 − 10.000; WOZ apart', pv.bedrag === 202000 && pv.delen.length === 5 && pv.woz.waarde === 600000 &&
    pv.delen[1].op === '2023-02-02', pv);
  toets('Holding apart: eigen vermogen laatste jaar, box 2 indicatief (24,5 % tot de grens, 31 % erboven), nooit in privé', o.vermogen.holding.eigen_vermogen === 400000 && o.vermogen.holding.jaar === 2025 &&
    o.vermogen.holding.box2.belasting === Math.round(68843 * 0.245 + (400000 - 68843) * 0.31) && pv.delen.every((x) => !/holding.*eigen vermogen/i.test(x.tekst)) && pv.bedrag !== pv.bedrag + 400000, o.vermogen.holding);
  toets('box 2 zonder tarief voor het jaar: geen indicatie', O.box2(100000, 2031) === null && O.box2(100000, 2026).netto === 100000 - Math.round(68843 * 0.245 + 31157 * 0.31), null);
  const nv = O.overzicht(A, a, { nu: vandaag, vanaf: mOud, saldi: null, vault: VAULT, fv: Object.assign({}, FV, { lees: () => ({ fouten: ['hypotheek'] }) }) });
  toets('zonder saldi en hypotheek: vermogen privé leeg met wat ontbreekt; vrij zegt dat de aflossing niet te lezen is', nv.vermogen.prive.bedrag === null && nv.vermogen.prive.ontbreekt.indexOf('hypotheek') >= 0 &&
    nv.buffer === null && /niet te lezen/.test(nv.vrij.uitleg) && !nv.vrij.regels.some((r) => /aflossing/i.test(r.tekst)), nv.vermogen.prive);
  toets('trend: alleen volledige maanden, oud → nieuw, vrij = inkomen − leven − aflossing', o.trend.length === mnd.length && o.trend[o.trend.length - 1].maand === m0 && o.trend.every((t) => Math.abs(t.vrij - (t.inkomen - t.leven - t.verplicht)) < 0.02), o.trend.slice(-2));
  // Davids keuze per tegenpartij
  const won = o.opruimen.find((g) => g.naam === 'Winkel Onbekend');
  const z1 = O.stroomZet(A, a, { id: won.id, stroom: 'verschuiven', subsoort: 'vrijwillig' });
  const o2 = ov(), w2 = o2.steekproef.concat(o2.opruimen).find((g) => g.id === won.id);
  let fout1 = null, fout2 = null, fout3 = null;
  try { O.stroomZet(A, a, { id: 'f'.repeat(16), stroom: 'leven' }); } catch (e) { fout1 = e.message; }
  try { O.stroomZet(A, a, { id: won.id, stroom: 'iets' }); } catch (e) { fout2 = e.message; }
  try { O.stroomZet(A, a, { id: won.id, stroom: 'leven', subsoort: 'verplicht' }); } catch (e) { fout3 = e.message; }
  toets('stroomZet: Davids keuze wint (niet meer in de opruimlijst, gekozen), onbekende id/stroom/subsoort geweigerd', z1.stroom === 'verschuiven' && !o2.opruimen.some((g) => g.id === won.id) && w2 && w2.gekozen === true && w2.stroom === 'verschuiven' &&
    /onbekende tegenpartij/.test(fout1) && /stroom/.test(fout2) && /subsoort/.test(fout3), [z1, w2, fout1, fout2, fout3]);
  O.stroomZet(A, a, { id: won.id, stroom: null });
  // review MOET 1: een eigen BV (sleutel met categorie) is ook te kiezen en terug te draaien
  const hold = o.opruimen.find((g) => /PRIMUM/.test(g.naam) && g.stroom === 'verschuiven');
  let hz = null; try { hz = O.stroomZet(A, a, { id: hold.id, stroom: 'inkomen' }); } catch (e) { hz = e.message; }
  const oh = ov(), hg = oh.steekproef.find((g) => g.id === hold.id);
  let hn = null; try { hn = O.stroomZet(A, a, { id: hold.id, stroom: null }); } catch (e) { hn = e.message; }
  toets('stroomZet op een eigen BV (sleutel met categorie): opslaan en terugdraaien werkt', hz && hz.stroom === 'inkomen' && hg && hg.gekozen && hg.stroom === 'inkomen' && hn && hn.stroom === null && ov().opruimen.some((g) => g.id === hold.id), [hz, hg, hn]);
  // review MOET 2 en ZOU 1
  toets('IBAN in een vrije tekst wordt …laatste vier; boekingenlijst hooguit 36 maanden', O.zonderIban('naar NL98ABNA0106465317 retour') === 'naar IBAN …5317 retour' && O.zonderIban('NL98 ABNA 0106 4653 17 x') === 'IBAN …5317 x' &&
    (() => { try { lijst({ van: '2020-01', tot: '2026-10' }); return false; } catch (e) { return /36 maanden/.test(e.message); } })(), O.zonderIban('NL98 ABNA 0106 4653 17 x'));
  const o3 = ov();
  toets('stroomZet null: terug naar de vaste regels; tabel stroom_regels herhaalbaar (tweede keer geen fout)', o3.opruimen.some((g) => g.id === won.id) && (() => { try { O.stroomZet(A, a, { id: won.id, stroom: null }); return true; } catch (e) { return false; } })(), null);
  // integratie: F.bereken geeft het blok overzicht (echte financien-vault.js op de nepvault: hypotheek ontbreekt → blok blijft, met de uitleg)
  const u = F.bereken(A, a, { vault: VAULT, saldi: [] });
  toets('financien-app bereken: blok overzicht aanwezig zonder fout', u.overzicht && u.overzicht.venster && u.fouten.indexOf('overzicht') < 0, u.fouten);
  // bank-lezer: app-boekingen en app-stroom zoals de pod ze aanroept
  const kind = (op, inv) => { const q = spawnSync(process.execPath, ['--no-warnings', 'bank-lezer.js', op], { input: JSON.stringify(inv), env: { PATH: process.env.PATH, BANK_DIR: BD, VAULT_DIR: VAULT, TZ: 'Europe/Amsterdam' }, encoding: 'utf8', timeout: 60000 });
    try { return JSON.parse(String(q.stdout).trim().split('\n').pop()); } catch (e) { return { stdout: String(q.stdout).slice(0, 200), stderr: String(q.stderr).slice(0, 300) }; } };
  const k1 = kind('app-boekingen', { boekingen: { van: m0, tot: m0, stroom: 'leven' } }), k2 = kind('app-boekingen', { boekingen: { van: 'x', tot: m0 } }), k3 = kind('app-stroom', { stroom: { id: won.id, stroom: 'leven' } }),
    k4 = kind('app-stroom', { stroom: { id: won.id, stroom: 'onzin' } }), k5 = kind('app-stroom', { stroom: { id: won.id, stroom: null } });
  toets('bank-lezer app-boekingen/app-stroom: lijst met bedragen, geen IBAN; fout filter of stroom geweigerd; null wist', k1.ok === true && k1.aantal > 0 && !/NL\d{2}[A-Z]{4}\d{6,}/.test(JSON.stringify(k1)) &&
    k2.ok === false && k3.ok === true && k3.stroom === 'leven' && k4.ok === false && k5.ok === true && k5.stroom === null, [k1.ok, k1.aantal, k2, k3, k4, k5]);
  const src = fs.readFileSync('financien-overzicht.js', 'utf8').replace(/^\s*(\*|\/\/).*$/gm, '');
  toets('financien-overzicht.js laadt geen netwerk- of procesmodule; schrijven alleen in stroomZet', !/require\(['"](node:)?(http|https|net|tls|dgram|dns|child_process|worker_threads)['"]\)/.test(src) && !/\bfetch\s*\(/.test(src) &&
    !/INSERT|UPDATE|DELETE|CREATE TABLE|db\.exec/.test(src.slice(0, src.indexOf('function stroomZet'))) && !/writeFile|appendFile|unlink/.test(src), null);
}
toets('uitrol.sh en Dockerfile: financien-overzicht.js gaat mee in de release', /RELEASE_OPTIONEEL="[^"]*\bfinancien-overzicht\.js\b/.test(fs.readFileSync('uitrol.sh', 'utf8')) &&
  /COPY financien-overzicht\.js \/app\/release-bootstrap\/financien-overzicht\.js/.test(fs.readFileSync('Dockerfile', 'utf8')), null);
const srv = fs.readFileSync('server.js', 'utf8');
toets('server.js: overzicht doorgegeven; routes boekingen en stroom; app-boekingen/app-stroom in BANK_LOKAAL, niet in BANK_OPDRACHTEN', /'saldi', 'overzicht'\]\.forEach/.test(srv) &&
  /route === 'POST \/app\/financien\/boekingen'\) return appFinBoekingen\(/.test(srv) && /route === 'POST \/app\/financien\/stroom'\) return appFinStroom\(/.test(srv) &&
  /const BANK_LOKAAL = \[[^\]]*'app-boekingen', 'app-stroom'/.test(srv) && !/const BANK_OPDRACHTEN = \[[^\]]*'app-(boekingen|stroom)'/.test(srv), null);
if (!process.env.HOUD) fs.rmSync(W, { recursive: true, force: true }); else console.log(W);
console.log('\n' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
