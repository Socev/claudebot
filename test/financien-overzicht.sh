#!/usr/bin/env bash
# Toetst financien-overzicht.js en financien-advies.js (wv2596 + wv2620, OVIS Financiën 8+ stap 1–4; ontwerp vault "01_Ontwikkeling/OVIS Financiën 8+ (ontwerp 7-11-2026)")
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
  // wv2665: leesbaar nakijken — elke regel een voorbeeldboeking (de laatste, heel bedrag), de hypotheek met waar de splitsing vandaan komt
  const hg5 = o.steekproef.find((g) => g.naam === 'ABN AMRO BANK NV'), hypB = o.steekproef.length && hg5 ? lijst(hg5.filter) : null;
  const laatst = (g) => lijst(g.filter).boekingen.reduce((m, b) => (b.datum > m ? b.datum : m), '');
  toets('wv2665: elke steekproefregel heeft een voorbeeld (de laatste boeking, heel bedrag, met rekening)', o.steekproef.every((g) => g.voorbeeld && g.voorbeeld.datum === laatst(g) && g.voorbeeld.rekening &&
    Math.sign(g.voorbeeld.bedrag) === (g.richting === 'af' ? -1 : 1)), o.steekproef.filter((g) => !g.voorbeeld || g.voorbeeld.datum !== laatst(g)).map((g) => [g.naam, g.voorbeeld]));
  toets('wv2665: hypotheek-splitsing = aflossing 2000 per termijn uit het model, aflossing + rente = de groep, bron genoemd; andere groepen geen splitsing', !!hg5 && hg5.splitsing && hg5.splitsing.aflossing_pm === 2000 &&
    hg5.splitsing.termijnen === hg5.aantal && Math.abs(hg5.splitsing.aflossing + hg5.splitsing.rente - hg5.som) < 0.01 && Math.abs(hg5.splitsing.aflossing + 2000 * hg5.aantal) < 0.01 && !!hg5.splitsing.bron &&
    hg5.voorbeeld.bedrag < -2000 && o.steekproef.filter((g) => g.splitsing).length === 1, [hg5 && hg5.splitsing, hg5 && hg5.voorbeeld]);
  toets('wv2665: banktekst alleen als hij terugkomt (≥ 2×) en niet al het voorbeeld is', o.steekproef.every((g) => !g.banktekst || (g.banktekst.keer >= 2 && g.banktekst.tekst !== g.voorbeeld.tekst)) &&
    o.steekproef.some((g) => g.banktekst), o.steekproef.map((g) => [g.naam, g.banktekst]));
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
  // ── wv2620 stap 3: uitgaven per categorie, eigenaar, uitschieters, nieuw terugkerend ──
  const ug = o.uitgaven;
  toets('uitgaven: blok aanwezig; maand = laatste volle maand, vorig jaar = 12 eerder', ug && ug.maand === m0 && ug.lopend === mNu && ug.vorig_jaar === F.maandPlus(m0, -12) && ug.maanden === 12, ug && [ug.maand, ug.vorig_jaar, o.fouten]);
  if (ug) {
    const levNu = -lijst({ van: m0, tot: m0, stroom: 'leven' }).som, lev12 = -lijst({ van: mnd[2], tot: m0, stroom: 'leven' }).som;
    toets('uitgaven: som per categorie = som boekingen leven (laatste maand en 12 maanden), = trend', Math.abs(ug.totaal.nu - levNu) < 0.02 && Math.abs(ug.totaal.gem12 - lev12 / 12) < 0.05 &&
      Math.abs(ug.totaal.nu - o.trend[o.trend.length - 1].leven) < 0.02, [ug.totaal, levNu, lev12 / 12]);
    const catOk = ug.categorieen.every((c) => Math.abs(c.nu + lijst(c.filter.nu).som) < 0.02 && Math.abs(c.gem12 + lijst(c.filter.twaalf).som / 12) < 0.02 &&
      (c.vorig_jaar == null || Math.abs(c.vorig_jaar + lijst(c.filter.vorig_jaar).som) < 0.02) && Math.abs(c.lopend + lijst(c.filter.lopend).som) < 0.02);
    toets('uitgaven: elke staaf = zijn boekingenlijst (nu, lopend, gemiddelde, vorig jaar; zonder categorie via cat "-")', catOk, ug.categorieen.map((c) => [c.categorie, c.nu, lijst(c.filter.nu).som]));
    const vak = ug.categorieen.find((c) => c.categorie === 'vakantie en reizen'), bo = ug.categorieen.find((c) => c.categorie === 'boodschappen');
    toets('uitgaven: kleur alleen bij > 25 % én > € 100 (vakantie 0 tegen gemiddeld 333 = lager; boodschappen ± gelijk = geen)', vak && vak.afwijking === 'lager' && bo && bo.afwijking === null, [vak, bo]);
    const ki = ug.eigenaren.find((e) => e.eigenaar === 'kinderen');
    toets('uitgaven per eigenaar: som = totaal; kinderen 10 per maand, filter eig klopt', Math.abs(ug.eigenaren.reduce((s, e) => s + e.nu, 0) - ug.totaal.nu) < 0.02 && ki && ki.nu === 10 &&
      Math.abs(lijst(ki.filter.nu).som + 10) < 0.01 && (() => { try { lijst({ van: m0, tot: m0, eig: 'Iemand' }); return false; } catch (e) { return /eigenaar/.test(e.message); } })(), ug.eigenaren);
  }
  // uitschieters en nieuw op losse delen (pure functie)
  const dl = [], mk = (m, d, bedrag, extra) => dl.push(Object.assign({ nr: dl.length + 1, datum: m + '-' + String(d).padStart(2, '0'), maand: m, stroom: 'leven', deel: bedrag, bedrag: bedrag, sleutel: 't:winkel', id: 'a'.repeat(16), cat: 'huishouden', tegenpartij: 'Winkel', eig: 'David', abo: null }, extra || {}));
  mnd.forEach((m) => mk(m, 5, -50));
  mk(m0, 20, -400);                                                       // 8× de gebruikelijke 50: uitschieter
  mk(m0, 21, -140);                                                       // 2,8×: geen
  mk(F.maandPlus(mNu, -2), 3, -9.99, { sleutel: 't:dienst', tegenpartij: 'Nieuwe Dienst', abo: 'r1', cat: 'abonnementen en communicatie' });
  mk(F.maandPlus(mNu, -1), 3, -9.99, { sleutel: 't:dienst', tegenpartij: 'Nieuwe Dienst', abo: 'r1', cat: 'abonnementen en communicatie' });
  mk(mnd[0], 3, -5, { sleutel: 't:oud', tegenpartij: 'Oude Dienst', abo: 'r2' }); mk(m0, 3, -5, { sleutel: 't:oud', tegenpartij: 'Oude Dienst', abo: 'r2' });
  const U = O.uitgaven(dl, { mNu: mNu, twaalf: mnd.slice(2), vanaf: mnd[0] });
  toets('uitschieters: boven 3× de gebruikelijke post en ≥ € 100 erboven (400 tegen 50 wel, 140 niet); nieuw terugkerend alleen de reeks van < 4 maanden',
    U.uitschieters.length === 1 && U.uitschieters[0].bedrag === 400 && U.uitschieters[0].gebruikelijk === 50 && U.uitschieters[0].basis === 'tegenpartij' &&
    U.nieuw.length === 1 && U.nieuw[0].naam === 'Nieuwe Dienst' && U.nieuw[0].aantal === 2, [U.uitschieters, U.nieuw]);
  toets('nieuw terugkerend: niets als het archief jonger is dan 6 maanden', O.uitgaven(dl, { mNu: mNu, twaalf: mnd.slice(2), vanaf: F.maandPlus(mNu, -3) }).nieuw.length === 0, null);
  // ── wv2620 stap 4: adviesregels A1–A5 ──
  let D = null; try { D = require(path.resolve('financien-advies.js')); } catch (e) { D = null; }
  toets('financien-advies.js bestaat en laadt', !!D, null);
  if (D) {
    const rv = F.maandPlus(mNu, 12) + '-01';
    const nv2 = Object.assign({}, nepVault, { hypotheek: Object.assign({}, nepVault.hypotheek, { bron: Object.assign({}, nepVault.hypotheek.bron, { bank: 'proefbank', rentevast: 'proef-excel' }),
      delen: [{ deel: '1', rente_bank: 1.0, restschuld_bank: 100000, rentevast_tm: '2031-01-01', soort: 'Lineair' }, { deel: '2', rente_bank: 4.5, restschuld_bank: 50000, rentevast_tm: rv, soort: 'Lineair', doel: 'Proef' }] }) });
    const FV2 = Object.assign({}, FV, { lees: () => nv2 });
    fs.mkdirSync(path.join(VAULT, '20_Prive', 'Financien'), { recursive: true });
    const PE = path.join(VAULT, '20_Prive', 'Financien', 'Energieverbruik thuis (Tibber).md');
    const tab = '# Energie\n\n| Uur | 0–6 | 11–16 | 18–22 |\n|---|--:|--:|--:|\n| kWh per uur | 1,5 | 1,6 | 3,0 |\n| Prijs (ct/kWh, alles-in) | 26,7–28,9 | 20,5–25,3 | 30,8–33,8 |\n';
    fs.writeFileSync(PE, tab);
    const sig = [{ soort: 'duurder', titel: 'Proefstroom', per_jaar: 120, zin: 'Proefstroom kost nu meer.' }, { soort: 'nieuw', titel: 'Kleintje', per_jaar: 24, zin: 'Kleintje is nieuw.' },
      { soort: 'weg', titel: 'Weg', zin: 'weg' }, { soort: 'dubbel', titel: 'Zonder bedrag', zin: 'dubbel' }];
    const vaste = { rijen: [{ naam: 'Proefverzekering', ritme: 'maand', categorie: 'verzekeringen', per_maand: 30 }, { naam: 'Jaarpolis', ritme: 'jaar', categorie: 'verzekeringen', per_maand: 10 }] };
    const adv = (x) => D.advies(A, a, Object.assign({ ov: o, saldi: saldi, signalen: sig, vaste: vaste, nu: vandaag, vault: VAULT, fv: FV2 }, x || {}));
    const r = adv(), by = (re) => r.adviezen.filter((x) => re.test(x.regel));
    toets('advies: zonder fout; elk advies met bedrag reproduceerbaar uit zijn invoer (REGELS.reken)', !r.fouten.length && r.adviezen.length >= 5 && r.adviezen.filter((x) => x.euro_jaar != null || x.band).every((x) => {
      const u = D.REGELS[x.regel].reken(x.invoer, D.TARIEVEN); return u && u.euro_jaar === x.euro_jaar && JSON.stringify(u.band) === JSON.stringify(x.band); }), r);
    const a1 = by(/A1/)[0];
    toets('A1: duurste deel (4,5 %), alleen bandbreedte en laat toetsen, deadline bij rentevast < 24 maanden; 130–325 per € 10.000', a1 && a1.zekerheid === 'laat toetsen' && a1.euro_jaar === null &&
      a1.band.laag === Math.round((4.5 * (1 - 0.3756) - 1.51) * 100) && a1.band.hoog === Math.round((4.5 - 1.25) * 100) && a1.prioriteit === 'deadline' && /laat het toetsen/.test(a1.zin) && /deel 2/.test(a1.zin), a1);
    const a2 = by(/A2/)[0], lpm = o.buffer.leven_per_maand;
    toets('A2: (saldo zonder rente − 2 × leven) × spaarrente laag; schatting', a2 && a2.zekerheid === 'schatting' && a2.invoer.saldo === 12000 && a2.euro_jaar === Math.round((12000 - 2 * lpm) * 0.0125), [a2, lpm]);
    const a3 = by(/A3/)[0];
    toets('A3 zonder aanwijzing: signaal zonder bedrag, niet op het startscherm', a3 && a3.zekerheid === 'signaal' && a3.euro_jaar === null && !a3.op_start && /18–22/.test(a3.zin), a3);
    fs.writeFileSync(PE, tab + '\n## Schuifbaar\n\n| Schuifbaar | kWh per jaar |\n|---|--:|\n| auto laden | 1.000 |\n');
    const a3b = adv().adviezen.find((x) => x.regel === 'A3');
    toets('A3 met aanwijzing: kWh × (duurst − goedkoopst), laag = minst gunstige grens', a3b && a3b.zekerheid === 'schatting' && a3b.euro_jaar === Math.round((30.8 - 25.3) * 10) && a3b.band.hoog === Math.round((33.8 - 20.5) * 10), a3b);
    fs.writeFileSync(PE, tab);
    const a4 = by(/A4/);
    toets('A4: alleen duurder/prijsstap/dubbel/nieuw met bedrag, zeker, jaarbedrag uit het signaal; < € 50 niet op het startscherm', a4.length === 2 && a4.every((x) => x.zekerheid === 'zeker') &&
      a4.find((x) => x.euro_jaar === 120).op_start === true && a4.find((x) => x.euro_jaar === 24).op_start === false, a4);
    const a5 = by(/A5/)[0];
    toets('A5: signaal zonder bedrag (alleen maandbetaalde verzekeringen)', a5 && a5.euro_jaar === null && a5.invoer.aantal === 1 && a5.zekerheid === 'signaal', a5);
    const zk = ['zeker', 'schatting', 'laat toetsen', 'signaal'], rang = (x) => (x.prioriteit === 'risico' ? 0 : x.prioriteit === 'deadline' ? 1 : 2);
    toets('volgorde: risico/deadline → zekerheid → euro\'s; startscherm hooguit 3, alleen bedrag ≥ € 50', r.adviezen[0].regel === 'A1' && r.adviezen.every((x, i, l) => i === 0 || rang(l[i - 1]) < rang(x) ||
      (rang(l[i - 1]) === rang(x) && (zk.indexOf(l[i - 1].zekerheid) < zk.indexOf(x.zekerheid) || (zk.indexOf(l[i - 1].zekerheid) === zk.indexOf(x.zekerheid) && (l[i - 1].waarde || 0) >= (x.waarde || 0))))) &&
      r.start.length <= 3 && r.adviezen.filter((x) => x.op_start).every((x) => x.waarde >= 50), r.adviezen.map((x) => [x.regel, x.prioriteit, x.zekerheid, x.waarde, x.op_start]));
    const rr = adv({ saldi: { rekeningen: saldi.rekeningen.concat([{ id: 'z1', naam: 'Groot', groep: 'eigen', bank: 'bunq', valuta: 'EUR', saldo: 150000 }]) } });
    toets('depositogarantie: saldo boven € 100.000 bij één bank = risico, bovenaan', rr.adviezen[0].regel === 'A2' && rr.adviezen[0].prioriteit === 'risico' && rr.adviezen[0].bronnen.some((b) => /depositogarantie/.test(b.tekst)), rr.adviezen[0]);
    const zt = adv({ tarieven: { depositogarantie: D.TARIEVEN.depositogarantie } });
    toets('zonder tarief geen advies: zonder spaarrente en aftrektarief geen A1 en A2, wel in ontbreekt', !zt.adviezen.some((x) => /^A[12]$/.test(x.regel)) &&
      zt.ontbreekt.some((x) => x.regel === 'A1' && /spaarrente/.test(x.waarom)) && zt.ontbreekt.some((x) => x.regel === 'A2'), zt.ontbreekt);
    const zt2 = adv({ tarieven: { spaarrente: D.TARIEVEN.spaarrente } });
    toets('zonder aftrektarief voor dit jaar: geen A1', !zt2.adviezen.some((x) => x.regel === 'A1') && zt2.ontbreekt.some((x) => x.regel === 'A1' && /aftrektarief/.test(x.waarom)), zt2.ontbreekt);
    // review wv2620: A1 niet boven de restschuld; A2 netto (een rekening in de min telt mee); signed prijzen in A3
    const nv3 = Object.assign({}, nv2, { hypotheek: Object.assign({}, nv2.hypotheek, { delen: [{ deel: '3', rente_bank: 5, restschuld_bank: 4000, rentevast_tm: '2031-01-01', soort: 'Lineair' }] }) });
    const k1 = adv({ fv: Object.assign({}, FV, { lees: () => nv3 }) }).adviezen.find((x) => x.regel === 'A1');
    toets('A1: restschuld kleiner dan € 10.000 → gerekend op de restschuld (review MOET 3)', k1 && k1.invoer.bedrag === 4000 && k1.band.hoog === Math.round((5 - 1.25) * 40) && /De resterende € 4\.000/.test(k1.zin), k1);
    const rn = adv({ saldi: { rekeningen: saldi.rekeningen.concat([{ id: 'z2', naam: 'Rood', groep: 'eigen', bank: 'bunq', valuta: 'EUR', saldo: -5000 }]) } }).adviezen.find((x) => x.regel === 'A2');
    toets('A2: netto saldi, een rekening in de min telt mee (review MOET 2)', rn && rn.invoer.saldo === 7000 && rn.euro_jaar === Math.round((7000 - 2 * lpm) * 0.0125) || (!rn && 7000 - 2 * lpm <= 0), [rn && rn.invoer, lpm]);
    toets('A3: rekent ook met een negatieve of nul-prijs (review ZOU 1)', D.REGELS.A3.reken({ kwh: 1000, duur_min: 30, duur_max: 34, goed_min: -2, goed_max: 0 }).band.hoog === 360, null);
    // ── wv2626: A6–A8 (fiscaal: alleen ruwe cijfers + seintje/vlag, nooit een bedrag; zonder grens geen vlag). Verzonnen getallen. ──
    const J = Number(vandaag.slice(0, 4)), DA = path.join(VAULT, '20_Prive', 'Bronnen', 'Financien'), PB3 = path.join(VAULT, '20_Prive', 'Financien', 'Box 3-inventaris.md');
    const aangifte = (jr, jrr, res) => fs.writeFileSync(path.join(DA, 'Prive - 2026-10-26 - IB-aangifte ' + jr + ' David (tekst).md'), '---\ntype: bron\n---\n22   Uitgaven voor inkomensvoorzieningen\n' +
      'a    Betaalde bedragen voor lijfrenten bij gebruik van jaarruimte                         €          ' + jrr + '\nb    Betaalde bedragen voor lijfrenten bij gebruik van de reserveringsruimte      €          ' + res + '\n');
    const nv7 = Object.assign({}, nv2, { belasting: { david: [{ jaar: J - 1, concept: false, loon: 40000 }, { jaar: J - 2, concept: false, loon: 90000 }], woning: [{ jaar: J - 1, box3: 12345 }] },
      dga: { rc: { totaal: 30000, reconstructie: { bedrag: 60000 } }, rc_contract: { maximum: 50000, rente_pct: 4 }, woninglening: { jaarrekening: [{ jaar: J - 1, stand: 480000 }] },
        planning: [{ wanneer: 'vóór 15-12-' + J, actie: 'Besluit: interim-dividend € 40.000 bruto aan de aandeelhouder', klaar: false }, { wanneer: '1-12-' + J, actie: 'Interim-dividend Werkmaatschappij → Holding € 99.000 bruto', klaar: false },
          { wanneer: '2-1-' + J, actie: 'dividend € 5.000 bruto', klaar: true }, { wanneer: '3-12-' + J, actie: 'Dividend werkmaatschappij -> Holding € 77.000 bruto', klaar: false },
          { wanneer: '4-12-' + J, actie: 'Slotdividend € 1.000 bruto naar de Holding', klaar: false }, { wanneer: 'jan ' + (J + 1), actie: 'januaridividend € 9.000 bruto (datum nog open)', klaar: false },
          { wanneer: '10-1-' + (J + 1), actie: 'Dividend € 70.000 bruto aan de aandeelhouder', klaar: false }], dividend: [{ datum: J + '-01-06', bruto: 50000 }, { datum: (J - 1) + '-01-06', bruto: 70000 }] } });
    const T7 = Object.assign({}, D.TARIEVEN, { box2: { op: '2026-11-07', bron: 'proef', [J]: { grens: 60000, laag: 0.2, hoog: 0.3 } }, excessief_lenen: { op: '2026-11-07', bron: 'proef', [J]: 500000 },
      gebruikelijk_loon: { op: '2026-11-07', bron: 'proef', [J - 1]: 58000 } });
    const FV7 = Object.assign({}, FV, { lees: () => nv7 }), adv7 = (x) => adv(Object.assign({ fv: FV7, tarieven: T7 }, x || {}));
    const r0 = adv7(), g = (r, k) => r.adviezen.find((x) => x.regel === k);
    toets('A6 zonder tekstversie van de aangifte: geen advies, in ontbreekt (de aangiftetabel heeft geen lijfrentekolom)', !g(r0, 'A6') && r0.ontbreekt.some((x) => x.regel === 'A6' && /geen kolom voor lijfrente/.test(x.waarom)), r0.ontbreekt);
    fs.mkdirSync(DA, { recursive: true }); aangifte(J - 2, '1.200', '0'); aangifte(J - 1, '0', '0');
    const r7 = adv7(), a6 = g(r7, 'A6'), a7 = g(r7, 'A7'), a8 = g(r7, 'A8');
    toets('A6: nieuwste aangifte met lijfrente € 0 bij jaar- en reserveringsruimte → seintje "laat de jaarruimte berekenen", laat toetsen, adviseur', a6 && a6.zekerheid === 'laat toetsen' && a6.actie === 'adviseur' &&
      a6.invoer.jaar === J - 1 && a6.invoer.jaarruimte === 0 && a6.invoer.reservering === 0 && /laat de jaarruimte berekenen/.test(a6.zin), a6);
    toets('A7: vier vlaggen uit de ruwe cijfers (met woninglening boven de grens, dividend boven de schijf, RC boven maximum, loon onder de norm); risico', a7 && a7.zekerheid === 'laat toetsen' &&
      JSON.stringify(a7.vlaggen) === JSON.stringify(['excessief_lenen_met_woning', 'box2_schijf', 'rc_boven_maximum', 'gebruikelijk_loon']) && a7.prioriteit === 'risico' && a7.deadline === J + '-12-15', a7);
    toets('A7: gepland per jaar = alleen open rijen aan de DGA met datum (niet naar de Holding in elke notatie, niet klaar); al uitgekeerd = dat jaar (review MOET 1/2)', a7 &&
      JSON.stringify(a7.invoer.dividend.map((y) => [y.jaar, y.gepland, y.al, y.grens])) === JSON.stringify([[J, 40000, 50000, 60000], [J + 1, 70000, 0, null]]) &&
      a7.invoer.schuld_bv === 30000 && a7.invoer.woninglening === 480000 && a7.invoer.rc === 60000 && a7.invoer.loon === 40000 && a7.invoer.loon_norm === 58000, a7 && a7.invoer);
    toets('A7: zin noemt de ruwe cijfers en eindigt bij de adviseur; geen "doe dit"', a7 && /€ 50\.000/.test(a7.zin) && /€ 40\.000/.test(a7.zin) && /€ 60\.000/.test(a7.zin) && /Laat het toetsen door je adviseur\.$/.test(a7.zin) && !/\b(doe|moet je|keer uit|los af)\b/i.test(a7.zin), a7 && a7.zin);
    toets('A8: zonder inventarispagina → seintje "laat berekenen" met alle vier onderdelen; grondslag als ruw cijfer', a8 && a8.zekerheid === 'laat toetsen' && JSON.stringify(a8.invoer.ontbreekt) === JSON.stringify(['beleggingen', 'vorderingen', 'schulden', 'rekening-courant']) &&
      a8.invoer.grondslag === 12345 && /Laat box 3 berekenen/.test(a8.zin), a8);
    toets('A6–A8: nooit euro_jaar of band, nooit op het startscherm; onder zeker/schatting in de volgorde', [a6, a7, a8].every((x) => x && x.euro_jaar === null && x.band === null && x.waarde === null && !x.op_start && r7.start.indexOf(x.id) < 0) &&
      r7.adviezen.filter((x) => x.zekerheid === 'zeker' || x.zekerheid === 'schatting').every((x) => !x.prioriteit ? r7.adviezen.indexOf(x) < r7.adviezen.indexOf(a6) : true), r7.adviezen.map((x) => [x.regel, x.prioriteit, x.zekerheid]));
    toets('elk advies (ook zonder bedrag; niet het A3-signaal zonder aanwijzing) reproduceerbaar uit zijn invoer: REGELS.reken(invoer) geeft dezelfde uitkomst en vlaggen', !r7.fouten.length && r7.adviezen.filter((x) => !(x.regel === 'A3' && x.zekerheid === 'signaal')).every((x) => {
      const u = D.REGELS[x.regel].reken(x.invoer, T7); return u && u.euro_jaar === x.euro_jaar && JSON.stringify(u.band) === JSON.stringify(x.band) && JSON.stringify(u.vlaggen) === JSON.stringify(x.vlaggen); }), r7.fouten);
    const zg = adv7({ tarieven: D.TARIEVEN.spaarrente ? { spaarrente: D.TARIEVEN.spaarrente } : {} }), zga7 = g(zg, 'A7');
    toets('A7 zonder grenzen (geen tarief excessief lenen, box 2, gebruikelijk loon): alleen de contractvlag RC boven maximum', zga7 && JSON.stringify(zga7.vlaggen) === JSON.stringify(['rc_boven_maximum']) && zga7.invoer.lenen_grens === null &&
      zga7.invoer.dividend.every((y) => y.grens === null) && zga7.invoer.loon_norm === null, zga7);
    const nv7b = Object.assign({}, nv7, { dga: Object.assign({}, nv7.dga, { rc: { totaal: 30000, reconstructie: { bedrag: 20000 } } }) });
    const zg2 = adv7({ fv: Object.assign({}, FV, { lees: () => nv7b }), tarieven: {} });
    toets('A7 zonder grenzen en RC onder het maximum: geen advies, in ontbreekt met de ontbrekende grenzen', !g(zg2, 'A7') && zg2.ontbreekt.some((x) => x.regel === 'A7' && /geen rode vlag/.test(x.waarom) && /geen grens excessief lenen/.test(x.waarom) && /box 2-tarief/.test(x.waarom)), zg2.ontbreekt);
    const nv7c = Object.assign({}, nv7, { dga: Object.assign({}, nv7.dga, { woninglening: null, rc: { totaal: 600000, reconstructie: { bedrag: 20000 } } }) });
    const a7c = g(adv7({ fv: Object.assign({}, FV, { lees: () => nv7c }) }), 'A7');
    toets('A7: schuld zonder woninglening boven € 500.000 → vlag excessief lenen, risico bovenaan', a7c && a7c.vlaggen[0] === 'excessief_lenen' && a7c.prioriteit === 'risico', a7c);
    const T7b = Object.assign({}, T7, { box2: Object.assign({}, T7.box2, { [J]: { grens: 95000 }, [J + 1]: { grens: 60000 } }) }), a7j = g(adv7({ tarieven: T7b }), 'A7');
    toets('A7: een later jaar boven de grens wordt ook gevlagd; deadline = dat jaar (review MOET 2)', a7j && a7j.vlaggen.indexOf('box2_schijf') >= 0 && a7j.deadline === (J + 1) + '-01-10' &&
      new RegExp('Dividend ' + (J + 1)).test(a7j.zin) && !new RegExp('Dividend ' + J + ':').test(a7j.zin), a7j);
    toets('A7: woninglening alleen (RC-schuld onbekend) boven de grens → vlag met woning (review MOET 3)', JSON.stringify(D.REGELS.A7.reken({ schuld_bv: null, woninglening: 600000, lenen_grens: 500000 }).vlaggen) === JSON.stringify(['excessief_lenen_met_woning']) &&
      D.REGELS.A7.reken({ schuld_bv: null, woninglening: null, lenen_grens: 500000 }) === null, null);
    const nv7d = Object.assign({}, nv7, { belasting: Object.assign({}, nv7.belasting, { david: [{ jaar: J, concept: false, loon: 99000 }].concat(nv7.belasting.david) }) });
    const r7d = adv7({ fv: Object.assign({}, FV, { lees: () => nv7d }) });
    toets('A6: nieuwer aangiftejaar in de tabel dan de tekstversie → geen seintje over een oud jaar', !g(r7d, 'A6') && r7d.ontbreekt.some((x) => x.regel === 'A6' && new RegExp('geen tekstversie van de aangifte ' + J).test(x.waarom)), r7d.ontbreekt);
    aangifte(J - 1, '2.500', '0');
    const r7e = adv7();
    toets('A6: lijfrente betaald → geen seintje', !g(r7e, 'A6') && r7e.ontbreekt.some((x) => x.regel === 'A6' && /staat lijfrentepremie/.test(x.waarom)), r7e.ontbreekt);
    fs.writeFileSync(PB3, '# Box 3\n\n| Onderdeel | Compleet |\n|---|---|\n| Beleggingen | ja |\n| Vorderingen | ja (proef) |\n| Rekening-courant | ja |\n| Schulden | nee |\n');
    const a8b = g(adv7(), 'A8');
    toets('A8: inventaris met één onderdeel nee → alleen dat onderdeel', a8b && JSON.stringify(a8b.invoer.ontbreekt) === JSON.stringify(['schulden']), a8b && a8b.invoer);
    fs.writeFileSync(PB3, '# Box 3\n\n| Onderdeel | Compleet |\n|---|---|\n| Beleggingen | ja |\n| Vorderingen | ja |\n| Rekening-courant | ja |\n| Schulden | ja |\n');
    const r8 = adv7();
    toets('A8: inventaris compleet → geen seintje, in ontbreekt', !g(r8, 'A8') && r8.ontbreekt.some((x) => x.regel === 'A8' && /compleet/.test(x.waarom)), r8.ontbreekt);
    fs.unlinkSync(PB3); [J - 2, J - 1].forEach((jr) => fs.unlinkSync(path.join(DA, 'Prive - 2026-10-26 - IB-aangifte ' + jr + ' David (tekst).md')));   // alleen de eigen proefbestanden (review MOET 4)
    toets('TARIEVEN: box 2 uit financien-overzicht.js (één bron), excessief lenen en gebruikelijk loon met bron en datum', D.TARIEVEN.box2[2026].grens === O.TARIEVEN.box2[2026].grens &&
      ['box2', 'excessief_lenen', 'gebruikelijk_loon'].every((k) => D.TARIEVEN[k].bron && /^\d{4}-\d{2}-\d{2}$/.test(D.TARIEVEN[k].op)), null);
    const oud = lijst({ van: mnd[0], tot: mnd[1] });
    toets('boekingenlijst: een filter buiten het 24-maandenvenster geeft alleen zijn eigen maanden (review MOET 4)', oud.boekingen.every((b) => b.datum.slice(0, 7) >= mnd[0] && b.datum.slice(0, 7) <= mnd[1]) && oud.aantal > 0, oud.aantal);
    const asrc = fs.readFileSync('financien-advies.js', 'utf8').replace(/^\s*(\*|\/\/).*$/gm, '');
    toets('financien-advies.js: geen netwerk, geen proces, schrijft niets', !/require\(['"](node:)?(http|https|net|tls|dgram|dns|child_process|worker_threads)['"]\)/.test(asrc) && !/\bfetch\s*\(/.test(asrc) &&
      !/INSERT|UPDATE|DELETE|CREATE|db\.exec|writeFile|appendFile|unlink|rename/.test(asrc), null);
    // integratie: bereken geeft overzicht.uitgaven en overzicht.advies; signalen dragen per_jaar
    const ub = F.bereken(A, a, { vault: VAULT, saldi: [] });
    toets('financien-app bereken: overzicht.uitgaven en overzicht.advies zonder fout', ub.overzicht && ub.overzicht.uitgaven && ub.overzicht.advies && Array.isArray(ub.overzicht.advies.adviezen) &&
      ub.fouten.indexOf('advies') < 0 && ub.overzicht.fouten.indexOf('uitgaven') < 0, [ub.fouten, ub.overzicht && ub.overzicht.fouten]);
    // vaste-lastenrekening: een tweede niet-bunq-rekening op Davids naam (zoals sinds 4-11-2026) laat de gezamenlijke staan
    const voor = F.bereken(A, a, { vault: VAULT, saldi: [] }).vaste_lasten;
    A.rekeningenSync(a, Object.assign({}, REK, { eb: { bron: 'enablebanking', uid: 'u9', bank: 'Proefbank', label: 'Eigen', naam: 'D VOORBEELD', iban: 'NL88RABO0000000088', sessie: 's9' } }));
    A.corrigeer(a, { rek: 'eb', eigenaar: 'David' });
    const na = F.bereken(A, a, { vault: VAULT, saldi: [] }).vaste_lasten;
    toets('vaste lasten: tweede niet-bunq-rekening (eigenaar David) → nog steeds de gezamenlijke rekening', voor && !voor.geen && na && !na.geen && na.rekening === voor.rekening, [voor && (voor.geen || voor.rekening), na && (na.geen || na.rekening)]);
  }
  // ── wv2696: personen met dezelfde achternaam, eigen rekening, kinderrekening (David 7-11-2026: "€ 91.000 naar Benthe") ──
  {
    const tpW = (x) => (O.tpWoorden ? O.tpWoorden(x) : null);
    const BD2 = path.join(W, 'bank2'), a2 = A.open(BD2);
    const J = { ho: 'NL21BUNQ0000000021', vl: 'NL22ABNA0000000022', ki: 'NL23BUNQ0000000023', ex: 'NL24BUNQ0000000024' };
    a2.db.exec("CREATE TABLE stroom_regels (id INTEGER PRIMARY KEY, sleutel TEXT NOT NULL, richting TEXT NOT NULL, stroom TEXT NOT NULL, subsoort TEXT, herkomst TEXT NOT NULL, actief INTEGER NOT NULL DEFAULT 1, aangemaakt TEXT NOT NULL, UNIQUE (sleutel, richting))");
    A.rekeningenSync(a2, {
      ho: { bron: 'bunq', uid: 'bunq-21', bunq_id: 21, naam: 'Hoofd', soort: 'lopend', iban: J.ho, status: 'ACTIVE' },
      vl: { uid: 'u22', bank: 'ABN AMRO', label: 'Gezamenlijk', naam: 'D PROEFMANS', iban: J.vl, sessie: 's2' },
      ki: { bron: 'bunq', uid: 'bunq-23', bunq_id: 23, naam: 'Kleedgeld kind', soort: 'lopend', iban: J.ki, status: 'ACTIVE' },
      ex: { bron: 'bunq', uid: 'bunq-24', bunq_id: 24, naam: 'Rekening van een ander', soort: 'lopend', iban: J.ex, status: 'ACTIVE' } });
    const HO = [], KI2 = [];
    HO.push(p(dg(m1, 3), -5000, 'D. Proefmans', 'naar gezamenlijk (zonder tegenboeking)', { tegen_iban: J.vl }));
    HO.push(p(dg(m1, 4), -7000, 'D Proefmans', 'naar gezamenlijk, IBAN alleen in de ruwe regel', { _ruw: { id: 'r1', creditor_account: { iban: J.vl } } }));
    HO.push(p(dg(m1, 5), -400, 'D. Proefmans', 'naar de rekening van een ander', { tegen_iban: J.ex }));
    [6, 7, 8, 9].forEach((d) => { HO.push(p(dg(m1, d), -30, 'B. Proefmans', 'kleedgeld', { tegen_iban: J.ki })); KI2.push(p(dg(m1, d), 30, 'D. Proefmans', 'kleedgeld', { tegen_iban: J.ho })); });
    HO.push(p(dg(m1, 10), -20, 'I. Proefmans', 'iemand anders, zonder IBAN'));
    HO.push(p(dg(m1, 11), 900, 'C. van Proefstad', 'bijdrage'));
    A.bij(a2, 'ho', HO, {}); A.bij(a2, 'ki', KI2, {});
    A.corrigeer(a2, { rek: 'ki', eigenaar: 'kind' }); A.corrigeer(a2, { rek: 'ex', eigenaar: 'extern' });
    A.verrijk(a2);
    const oudeRegel = (s, r, st, sub) => a2.db.prepare("INSERT INTO stroom_regels (sleutel, richting, stroom, subsoort, herkomst, actief, aangemaakt) VALUES (?, ?, ?, ?, 'david', 1, '2026-11-07T21:47:56Z')").run(s, r, st, sub || null);
    oudeRegel('t:proefmans', 'af', 'leven'); oudeRegel('t:van proefstad', 'bij', 'inkomen', 'buiten_zicht');
    toets('wv2696: sleutel met voorletter — D./D en D.J. vallen samen, B. en I. niet, B.V. blijft weg', tpW('D. Schaap') === 'd schaap' && tpW('D Schaap') === 'd schaap' && tpW('D.J. Schaap') === 'd schaap' &&
      tpW('B. Schaap') === 'b schaap' && tpW('Tibber Netherlands B.V.') === 'tibber netherlands' && tpW('Albert Heijn 1344 HUIZEN') === 'albert heijn huizen' &&
      O.sleutelVan({ tegenpartij: 'B. Schaap' }) !== O.sleutelVan({ tegenpartij: 'D. Schaap' }), [O.tpWoorden && tpW('D. Schaap'), O.sleutelVan({ tegenpartij: 'B. Schaap' })]);
    const o6 = O.overzicht(A, a2, { nu: vandaag, vanaf: mOud, saldi: null, vault: VAULT, fv: FVnep });
    const l6 = O.boekingenLijst(A, a2, { filter: { van: m1, tot: m1 }, vault: VAULT, fv: FVnep }).boekingen;
    const b6 = (re) => l6.filter((b) => re.test(b.omschrijving || ''));
    const rg = a2.db.prepare('SELECT * FROM stroom_regels ORDER BY id').all();
    toets('wv2696: oude samengevoegde keuze t:proefmans → alleen B. Proefmans (meeste boekingen), met notitie; t:van proefstad → t:c van proefstad', rg[0].sleutel === 't:b proefmans' && rg[0].sleutel_v === 2 &&
      /samen/.test(rg[0].notitie || '') && rg[1].sleutel === 't:c van proefstad' && rg[1].sleutel_v === 2 && rg.every((r) => r.actief === 1), rg);
    toets('wv2696: overboeking naar een eigen rekening = intern, ook met een keuze bij die naam (tegen-IBAN en IBAN uit de ruwe regel)', b6(/gezamenlijk/).length === 2 && b6(/gezamenlijk/).every((b) => b.stroom === 'intern'), b6(/gezamenlijk/));
    toets('wv2696: kinderrekening volgt Davids keuze (B. Proefmans = leven); de rekening van een ander en I. Proefmans niet onder die keuze', b6(/kleedgeld/).filter((b) => b.bedrag < 0).length === 4 &&
      b6(/kleedgeld/).filter((b) => b.bedrag < 0).every((b) => b.stroom === 'leven' && b.waarom === 'jouw keuze') && b6(/van een ander/)[0].stroom === 'leven' && b6(/van een ander/)[0].waarom !== 'jouw keuze' &&
      b6(/iemand anders/)[0].waarom !== 'jouw keuze' && b6(/bijdrage/)[0].stroom === 'inkomen' && b6(/bijdrage/)[0].waarom === 'jouw keuze', l6.map((b) => [b.tegenpartij, b.bedrag, b.stroom, b.waarom]));
    const g6 = o6.steekproef.filter((g) => /Proefmans/.test(g.naam));
    toets('wv2696: 40 grootste posten: geen post met de eigen overboekingen; B. en D. Proefmans apart', !g6.some((g) => Math.abs(g.som) >= 5000) && new Set(g6.map((g) => g.id)).size === g6.length &&
      g6.some((g) => g.naam === 'B. Proefmans' && g.som === -120 && g.stroom === 'leven'), g6.map((g) => [g.naam, g.som, g.stroom]));
    // zonder keuze: kinderrekening = intern; eigen rekening + keuze = intern
    const c6 = { regels: new Map([['t:d proefmans|af', { stroom: 'leven' }]]), zichtbaar: new Set(['x']), rekEig: new Map([['x', 'kind']]), eigenIban: new Map([[J.vl, 'samen'], [J.ki, 'kind']]), catUit: new Set(), tpCat: new Map() };
    const i1 = O.indelen({ _sleutel: 't:b proefmans', bedrag: -30, type: 'intern', tegen_iban: J.ki, tegenpartij: 'B. Proefmans' }, c6);
    const i2 = O.indelen({ _sleutel: 't:d proefmans', bedrag: -30, type: 'uitgave', tegen_iban: J.vl.replace(/(.{4})/g, '$1 '), tegenpartij: 'D. Proefmans' }, c6);
    const i3 = O.indelen({ _sleutel: 't:d proefmans', bedrag: -30, type: 'intern', paar_rek: 'x', tegenpartij: 'D. Proefmans' }, c6);
    toets('wv2696: indelen — kinderrekening zonder keuze = intern; eigen rekening (IBAN met spaties) mét keuze = intern; paar naar kinderrekening mét keuze = de keuze', i1.stroom === 'intern' && i2.stroom === 'intern' && /geldt hier niet/.test(i2.waarom) && i3.stroom === 'leven', [i1, i2, i3]);
    let z6 = {}; try { z6 = O.stroomZet(A, a2, { id: O.idVan('t:d proefmans', 'af'), stroom: 'leven' }); } catch (e) { z6 = { fout: e.message }; }
    let r6 = null; try { r6 = a2.db.prepare("SELECT sleutel_v FROM stroom_regels WHERE sleutel = 't:d proefmans'").get(); } catch (e) { r6 = { fout: e.message }; }
    toets('wv2696: omzetting eenmalig (tweede keer niets); nieuwe keuze krijgt sleutel_v 2', (O.regelsHerleiden ? O.regelsHerleiden(a2).length === 0 : false) && z6.stroom === 'leven' && r6 && r6.sleutel_v === 2, [z6, r6]);
    // review MOET 1: eigen rekening zonder eigenaar is ook eigen; MOET 3: botsing bij de omzetting — de jongste actieve keuze wint, de ander gaat opzij
    const i4 = O.indelen({ _sleutel: 't:d proefmans', bedrag: -30, type: 'uitgave', tegen_iban: 'NL29BUNQ0000000029', tegenpartij: 'D. Proefmans' }, Object.assign({}, c6, { eigenIban: new Map([['NL29BUNQ0000000029', '']]) }));
    const oudB = (t) => a2.db.prepare("INSERT INTO stroom_regels (sleutel, richting, stroom, herkomst, actief, aangemaakt) VALUES ('t:van proefstad', 'bij', 'leven', 'david', 1, ?)").run(t);
    let bz = null;
    try {
      oudB('2026-11-01T00:00:00Z'); O.regelsHerleiden(a2);
      const na1 = a2.db.prepare("SELECT sleutel, stroom, actief FROM stroom_regels WHERE richting = 'bij' AND sleutel LIKE '%proefstad%' ORDER BY id").all();
      oudB('2026-12-01T00:00:00Z'); O.regelsHerleiden(a2);
      const na2 = a2.db.prepare("SELECT sleutel, stroom, actief FROM stroom_regels WHERE richting = 'bij' AND sleutel LIKE '%proefstad%' ORDER BY id").all();
      bz = { na1, na2 };
    } catch (e) { bz = { fout: e.message }; }
    const act = (l, st) => l && l.filter((r) => r.actief === 1).length === 1 && l.find((r) => r.actief === 1).sleutel === 't:c van proefstad' && l.find((r) => r.actief === 1).stroom === st;
    const i5 = O.indelen({ _sleutel: 't:d proefmans', bedrag: 30, type: 'intern', tegen_iban: J.vl, r_eigenaar: 'kind', tegenpartij: 'D. Proefmans' }, Object.assign({}, c6, { regels: new Map([['t:d proefmans|bij', { stroom: 'inkomen' }]]) }));
    toets('wv2696: de boeking op de kinderrekening zelf blijft intern, ook met een keuze (geen dubbel kleedgeld)', i5.stroom === 'intern' && b6(/kleedgeld/).filter((b) => b.bedrag > 0).every((b) => b.stroom === 'intern'), [i5, b6(/kleedgeld/).filter((b) => b.bedrag > 0)]);
    toets('wv2696 review: eigen IBAN zonder eigenaar = intern; botsing: oudere oude keuze gaat opzij, jongere wint, niets gewist', i4.stroom === 'intern' && !!bz.na1 && act(bz.na1, 'inkomen') && bz.na1.length === 2 &&
      act(bz.na2, 'leven') && bz.na2.length === 3 && bz.na2.filter((r) => /#uit/.test(r.sleutel)).length === 2, [i4, bz]);
    // een oude keuze die niet om te zetten is (alleen-lezen) telt niet
    const a3 = A.open(BD2, undefined);
    a3.db.exec("INSERT INTO stroom_regels (sleutel, richting, stroom, herkomst, actief, aangemaakt) VALUES ('t:proefmans', 'bij', 'leven', 'david', 1, 'x')");
    const nepA = { db: { prepare: (q) => /^UPDATE|^INSERT|^ALTER|^CREATE/.test(q) ? (() => { throw new Error('alleen-lezen'); })() : a3.db.prepare(q), exec: (q) => { throw new Error('alleen-lezen'); } } };
    let rl = null; try { O.overzicht(A, nepA, { nu: vandaag, vanaf: mOud, saldi: null, vault: VAULT, fv: FVnep }); rl = 'ok'; } catch (e) { rl = e.message; }
    toets('wv2696: lukt de omzetting niet (alleen-lezen), dan telt de oude keuze niet en werkt het overzicht', rl === 'ok' && (() => { try { return a3.db.prepare("SELECT sleutel_v FROM stroom_regels WHERE richting = 'bij' AND sleutel = 't:proefmans'").get().sleutel_v === null; } catch (e) { return false; } })(), rl);
  }
  const src = fs.readFileSync('financien-overzicht.js', 'utf8').replace(/^\s*(\*|\/\/).*$/gm, '');
  toets('financien-overzicht.js laadt geen netwerk- of procesmodule; schrijven alleen in stroomZet en de eenmalige sleutelomzetting (na stroomZet)', !/require\(['"](node:)?(http|https|net|tls|dgram|dns|child_process|worker_threads)['"]\)/.test(src) && !/\bfetch\s*\(/.test(src) &&
    !/INSERT|UPDATE|DELETE|CREATE TABLE|db\.exec/.test(src.slice(0, src.indexOf('function stroomZet'))) && !/writeFile|appendFile|unlink/.test(src), null);
}
toets('uitrol.sh en Dockerfile: financien-overzicht.js gaat mee in de release', /RELEASE_OPTIONEEL="[^"]*\bfinancien-overzicht\.js\b/.test(fs.readFileSync('uitrol.sh', 'utf8')) &&
  /COPY financien-overzicht\.js \/app\/release-bootstrap\/financien-overzicht\.js/.test(fs.readFileSync('Dockerfile', 'utf8')), null);
toets('uitrol.sh en Dockerfile: financien-advies.js gaat mee in de release (wv2620)', /RELEASE_OPTIONEEL="[^"]*\bfinancien-advies\.js\b/.test(fs.readFileSync('uitrol.sh', 'utf8')) &&
  /COPY financien-advies\.js \/app\/release-bootstrap\/financien-advies\.js/.test(fs.readFileSync('Dockerfile', 'utf8')), null);
toets('server.js: filter eig (uitgaven per eigenaar) doorgelaten, alleen de vijf groepen', /if \(f\.eig != null\) \{ if \(\['David', 'samen', 'kinderen', 'Gambia', 'anders'\]\.indexOf\(f\.eig\) < 0\) return null; q\.eig = f\.eig; \}/.test(fs.readFileSync('server.js', 'utf8')), null);
const srv = fs.readFileSync('server.js', 'utf8');
toets('server.js: overzicht doorgegeven; routes boekingen en stroom; app-boekingen/app-stroom in BANK_LOKAAL, niet in BANK_OPDRACHTEN', /'saldi', 'overzicht'\]\.forEach/.test(srv) &&
  /route === 'POST \/app\/financien\/boekingen'\) return appFinBoekingen\(/.test(srv) && /route === 'POST \/app\/financien\/stroom'\) return appFinStroom\(/.test(srv) &&
  /const BANK_LOKAAL = \[[^\]]*'app-boekingen', 'app-stroom'/.test(srv) && !/const BANK_OPDRACHTEN = \[[^\]]*'app-(boekingen|stroom)'/.test(srv), null);
if (!process.env.HOUD) fs.rmSync(W, { recursive: true, force: true }); else console.log(W);
console.log('\n' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
