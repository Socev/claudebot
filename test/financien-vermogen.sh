#!/usr/bin/env bash
# Toetst financien-vermogen.js (wv2716, idee 1 uit Sure: vermogensverloop per maand sinds 2016; ontwerp vault "01_Ontwikkeling/Financiën -
# ideeën uit Sure (ontwerp 8-11-2026)" § 1d) op een nagebootste transactiedatabase en vault met verzonnen rekeningen en bedragen: dagketen
# (bunq nummert binnen een dag nieuwste eerst; meerduidige dag sluit aan op de vorige), terugrekenen zonder saldo_na, bunq vóór de eerste
# boeking € 0, andere rekening vóór de eerste boeking onvolledig (review MOET 1), rekening-courant uit de jaarrekening onvolledig (review
# MOET 2), trappen voor woning/woninglening/RC/Holding, hypotheek Excel → bank, geen totaal waar bank of woning ontbreekt, kinderen apart,
# Holding nooit opgeteld, laatste maand = het punt van Overzicht; bank-lezer app-vermogen; route in server.js. Kruisproef: zonder dagketen
# (laatste boeking in nr-volgorde) wordt de toets rood. Raakt de pod, de kluis, de bank, de vault en /opt/data/bank niet.
# Gebruik: bash test/financien-vermogen.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 900) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'financien-vermogen-'));
const BD = path.join(W, 'bank'), VAULT = path.join(W, 'vault');
const A = require(path.resolve('bank-archief.js')), F = require(path.resolve('financien-app.js')), O = require(path.resolve('financien-overzicht.js')), FV = require(path.resolve('financien-vault.js'));
let V = null;
try { V = require(path.resolve('financien-vermogen.js')); } catch (e) { V = null; }
toets('financien-vermogen.js bestaat en laadt', !!V, null);
const REK = {
  pr: { bron: 'bunq', uid: 'bunq-1', bunq_id: 1, naam: 'Hoofdrekening', soort: 'lopend', iban: 'NL11BUNQ0000000001', status: 'ACTIVE' },
  kd: { bron: 'bunq', uid: 'bunq-6', bunq_id: 6, naam: 'Kids', soort: 'lopend', iban: 'NL66BUNQ0000000006', status: 'ACTIVE' },
  gb: { bron: 'bunq', uid: 'bunq-7', bunq_id: 7, naam: 'Hulp', soort: 'lopend', iban: 'NL77BUNQ0000000007', status: 'ACTIVE' },
  gz: { bron: 'abn', bank: 'ABN AMRO', uid: 'abn-1', naam: 'Vaste lasten', soort: 'CACC', iban: 'NL22ABNA0000000002' },
  eb: { bron: 'eb', bank: 'Bank B', uid: 'eb-1', naam: 'Kaartrekening', soort: 'CACC', iban: 'NL33BNKB0000000003' },
};
let n = 0;
const p = (datum, bedrag, saldo, tegen) => ({ id: 'x:' + (++n), datum: datum, valutadatum: datum, bedrag: bedrag, valuta: 'EUR', tegenpartij: tegen || 'Proef BV', omschrijving: 'proef',
  status: 'geboekt', saldo_na: saldo, mcc: null, tegen_iban: null, _ruw: { id: n, bron: 'nagebootst' } });
// bunq: binnen een dag nieuwste eerst (zoals bunq nummert). Chronologisch 20-1: −100 (900), +50 (950), −30 (920); 5-2 meerduidig: +20 (940), −20 (920)
const PR = [p('2024-01-10', 1000, 1000), p('2024-01-20', -30, 920), p('2024-01-20', 50, 950), p('2024-01-20', -100, 900), p('2024-02-05', -20, 920), p('2024-02-05', 20, 940), p('2026-11-02', 20, 940)];
const GZ = [p('2025-03-01', 500, 2500), p('2025-06-01', -100, 2400), p('2025-06-02', 100, 2500)];
const EB = [p('2025-10-01', -10, null), p('2025-11-01', 100, null)];   // zonder saldo_na: terug vanaf de bewaarde stand 190
const KD = [p('2024-06-01', 80, 80)], GB = [p('2024-06-01', 5, 5)];
fs.mkdirSync(BD, { recursive: true });
const a = A.open(BD);
A.rekeningenSync(a, REK);
A.bij(a, 'pr', PR, {}); A.bij(a, 'gz', GZ, {}); A.bij(a, 'eb', EB, {}); A.bij(a, 'kd', KD, {}); A.bij(a, 'gb', GB, {});
const eig = { pr: 'David', gz: 'samen', eb: 'David', kd: 'kind', gb: 'Gambia-hulp' };
Object.keys(eig).forEach((k) => a.db.prepare("UPDATE rekeningen SET eigenaar = ?, eigenaar_herkomst = 'david' WHERE rek = ?").run(eig[k], k));
const stand = { pr: 940, gz: 2500, eb: 190, kd: 80, gb: 5 };
const rijen = Object.keys(stand).map((k) => ({ rek: k, json: JSON.stringify({ geboekt: stand[k], valuta: 'EUR' }), opgehaald: '2026-11-08T06:00:00.000Z' }));
// vault: woning (2 taxaties), kerncijfers Holding (2 jaren); hypotheek en DGA via een nagebootste FV.lees
fs.mkdirSync(path.join(VAULT, '20_Prive', 'Huis'), { recursive: true }); fs.mkdirSync(path.join(VAULT, '10_Zakelijk', 'Holding', 'Financieel'), { recursive: true });
fs.writeFileSync(path.join(VAULT, '20_Prive', 'Huis', 'Woning Proefstraat 1.md'), '# Woning\n\n## Taxatiegeschiedenis\n\n| Rapport | Peildatum | Taxateur / kantoor | Doel | Marktwaarde | Na verbouwing | Validatie |\n|---|---|---|---|---|---|---|\n' +
  '| 2-3-2016 | 1-3-2016 | Taxateur A | financiering | € 400.000 | n.v.t. | X1 |\n| 2-6-2020 | 1-6-2020 | Taxateur B | financiering | € 500.000 | **€ 520.000** | X2 |\n');
fs.writeFileSync(path.join(VAULT, '10_Zakelijk', 'Holding', 'Financieel', 'Kerncijfers - HOLD.md'), "# HOLD\n\n| bedragen in hele euro's | 2022 | 2023 |\n|---|--:|--:|\n| Eigen vermogen | 100.000 | 150.000 |\n| Liquide middelen | 1.000 | 2.000 |\n");
const reeks = []; for (let i = 0, m = '2016-01'; m <= '2026-11'; i++) { reeks.push({ maand: m, restschuld: 300000 - 1000 * i }); const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1)); m = d.toISOString().slice(0, 7); }
const VAULTDATA = {
  fouten: [],
  hypotheek: { bank: { restschuld: 180000 }, bron: { pagina: 'Hypotheek.md', bank_op: '2026-10-20', excel: 'Excel' }, reeks_maand: reeks, controle: {}, excel: {} },
  dga: { rc: { totaal: 5000 }, woninglening: { hoofdsom: 20000, ingang: '2023-07-01', jaarrekening: [{ jaar: 2023, stand: 20000 }, { jaar: 2024, stand: 19500 }, { jaar: 2025, stand: 19000 }] },
    rc_jaarrekening: { eerste_jaar: 2022, begin: 0, standen: [{ jaar: 2022, stand: 1000 }, { jaar: 2023, stand: 2000 }, { jaar: 2024, stand: 3000 }, { jaar: 2025, stand: 4000 }] },
    bron: { pagina: 'Besluit.md', data: 'DGA.json', pagina_bijgewerkt: '2026-10-15' } },
};
const FVnep = Object.assign({}, FV, { lees: () => JSON.parse(JSON.stringify(VAULTDATA)) });
const NU = '2026-11-08';
if (V) {
  const u = V.verloop(A, a, { nu: NU, saldiRijen: rijen, vault: VAULT, fv: FVnep });
  const M = (m) => u.maanden.find((x) => x.m === m) || {};
  toets('maanden van jan 2016 t/m de lopende maand, één per maand', u.ok === true && u.maanden[0].m === '2016-01' && u.maanden[u.maanden.length - 1].m === '2026-11' && u.maanden.length === 131 && u.maanden[130].lopend === true, [u.maanden.length, u.fouten]);
  toets('vóór de eerste taxatie en vóór de eerste privéboeking: geen totaal, wel de delen (hypotheek, Holding-schulden)', M('2016-02').totaal === null && M('2016-02').hypotheek === 299000 &&
    M('2016-02').ontbreekt.some((x) => /^woning/.test(x)) && M('2016-02').ontbreekt.some((x) => /^bank/.test(x)) && M('2023-12').totaal === null && M('2023-12').woning === 520000 && M('2023-12').vrij === null, [M('2016-02'), M('2023-12').ontbreekt]);
  toets('dagketen: eind jan 2024 = 920 (bunq nieuwste eerst; de laatste in nr-volgorde zou 900 zijn)', M('2024-01').vrij === 920, M('2024-01'));
  toets('meerduidige dag (+20/−20) sluit aan op de vorige dag: eind feb 2024 = 920', M('2024-02').vrij === 920, M('2024-02'));
  toets('totaal jan 2024 = 920 + 520.000 − 204.000 − 20.000 − 2.000; onvolledig met de ABN- en kaartrekening en het Tolgaarde-deel', M('2024-01').totaal === 294920 && M('2024-01').volledig === false &&
    M('2024-01').onvolledig.some((x) => /Vaste lasten \(geen historie vóór mrt 2025\)/.test(x)) && M('2024-01').onvolledig.some((x) => /Kaartrekening \(geen historie vóór okt 2025\)/.test(x)) && M('2024-01').onvolledig.some((x) => /Tolgaarde/.test(x)), M('2024-01'));
  toets('trappen: woning 400.000 vanaf mrt 2016 en 520.000 (na verbouwing) vanaf jun 2020; woninglening 0 vóór jul 2023, hoofdsom tot de eerste jaarrekening', M('2016-03').woning === 400000 && M('2020-05').woning === 400000 && M('2020-06').woning === 520000 &&
    M('2023-06').woninglening === 0 && M('2023-07').woninglening === 20000 && M('2024-12').woninglening === 19500 && M('2025-05').woninglening === 19500, [M('2016-03').woning, M('2020-06').woning, M('2023-06').woninglening, M('2024-12').woninglening]);
  toets('rekening-courant: 0 vóór het eerste boekjaar (volledig), dan de jaarrekening (onvolledig), vanaf de besluitdatum het besluit (volledig)', M('2021-12').rc === 0 && !M('2021-12').onvolledig.some((x) => /Tolgaarde/.test(x)) &&
    M('2022-06').rc === 0 && M('2022-12').rc === 1000 && M('2026-09').rc === 4000 && M('2026-09').onvolledig.some((x) => /Tolgaarde/.test(x)) && M('2026-10').rc === 5000 && M('2026-10').rc_bron === 'besluit', [M('2022-06').rc, M('2022-12').rc, M('2026-09').rc, M('2026-10')]);
  toets('hypotheek: Excel-model per maand, vanaf de maand van de bankstand de bankstand', M('2026-09').hypotheek === 300000 - 1000 * 128 && M('2026-09').hypotheek_bron === 'excel' && M('2026-10').hypotheek === 180000 && M('2026-10').hypotheek_bron === 'bank', [M('2026-09').hypotheek, M('2026-10').hypotheek]);
  toets('zonder saldo_na: terug vanaf de bewaarde stand (okt 2025: 190 − 100 = 90); ABN vanaf zijn eerste boeking', M('2025-10').vrij === 920 + 2500 + 90 && M('2025-05').vrij === 920 + 2500 && M('2025-06').vrij === 920 + 2500, [M('2025-10').vrij, M('2025-05').vrij]);
  toets('okt 2026 volledig: 920 + 2.500 + 190 + 520.000 − 180.000 − 19.000 − 5.000', M('2026-10').totaal === 319610 && M('2026-10').volledig === true && M('2026-10').onvolledig.length === 0 && u.eerste_volledig === '2026-10', M('2026-10'));
  toets('kinderen en Gambia apart, nooit in vrij of het totaal', M('2025-01').kinderen === 80 && M('2025-01').gambia === 5 && M('2025-01').vrij === 920, M('2025-01'));
  toets('Holding apart per jaarrekening (trap), nooit opgeteld', M('2022-11').holding === null && M('2022-12').holding === 100000 && M('2024-06').holding === 150000 && M('2024-06').totaal === r2(920 + 520000 - (300000 - 1000 * 101) - 20000 - 2000), [M('2022-12').holding, M('2024-06')]);
  const punt = O.overzicht(A, a, { nu: NU, vanaf: null, saldi: F.blokSaldi(a, rijen), vault: VAULT, fv: FVnep }).vermogen.prive;
  const L = u.maanden[130];
  toets('lopende maand = het punt van Overzicht (zelfde totaal, bank uit de bewaarde standen)', punt.bedrag != null && L.totaal === punt.bedrag && L.vrij === 940 + 2500 + 190 && L.hypotheek === 180000 && L.rc === 5000 && L.woninglening === 19000, [L, punt.bedrag]);
  toets('antwoord zonder IBAN of rekeningsleutel', !/NL\d{2}[A-Z]{4}/.test(JSON.stringify(u)) && !/"rek"/.test(JSON.stringify(u)), null);
  const zonderHyp = V.verloop(A, a, { nu: NU, saldiRijen: rijen, vault: VAULT, fv: Object.assign({}, FV, { lees: () => ({ fouten: ['hypotheek'], dga: VAULTDATA.dga }) }) });
  toets('zonder hypotheek: nergens een totaal, delen blijven', zonderHyp.maanden.every((x) => x.totaal === null) && zonderHyp.maanden.find((x) => x.m === '2025-01').vrij === 920, zonderHyp.maanden.find((x) => x.m === '2025-01'));
  // dagketen los: beginstand en kandidaten
  const k = V.dagketen([{ datum: '2024-01-01', bedrag: 10, saldo_na: 10 }, { datum: '2024-01-02', bedrag: -3, saldo_na: 4 }, { datum: '2024-01-02', bedrag: -3, saldo_na: 7 }]);
  toets('dagketen los: beginstand 0, eind van de tweede dag 4', k.begin === 0 && k.dagen[1].stand === 4 && k.breuk === 0, k);
  // kruisproef: zonder dagketen (laatste boeking in nr-volgorde) is jan 2024 900 en de toets hierboven rood
  const bron = fs.readFileSync('financien-vermogen.js', 'utf8');
  const kapot = bron.replace('    if (vorig != null && kand.indexOf(vorig + som) >= 0) eind = vorig + som;\n', '    if (true) eind = cent(d.tx[d.tx.length - 1].saldo_na);\n');
  const kp = path.join(W, 'financien-vermogen-kruis.js');
  fs.writeFileSync(kp, kapot.replace(/require\('\.\/(financien-[a-z]+\.js)'\)/g, (x, f) => 'require(' + JSON.stringify(path.resolve(f)) + ')'));
  const ku = require(kp).verloop(A, a, { nu: NU, saldiRijen: rijen, vault: VAULT, fv: FVnep });
  toets('kruisproef: zonder dagketen is eind jan 2024 900 (de regel doet dus iets)', kapot !== bron && ku.maanden.find((x) => x.m === '2024-01').vrij === 900, ku.maanden.find((x) => x.m === '2024-01').vrij);
  // bank-lezer zoals de pod het aanroept (vault zonder hypotheek-json: wel de bank, geen totalen)
  const q = spawnSync(process.execPath, ['--no-warnings', 'bank-lezer.js', 'app-vermogen'], { input: '{}', env: { PATH: process.env.PATH, BANK_DIR: BD, VAULT_DIR: VAULT, TZ: 'Europe/Amsterdam' }, encoding: 'utf8', timeout: 60000 });
  let kj = null; try { kj = JSON.parse(String(q.stdout).trim().split('\n').pop()); } catch (e) { kj = { stdout: String(q.stdout).slice(0, 200), stderr: String(q.stderr).slice(0, 300) }; }
  toets('bank-lezer app-vermogen: ok, maanden met de bank (jan 2024 = 920)', kj && kj.ok === true && Array.isArray(kj.maanden) && kj.maanden.find((x) => x.m === '2024-01').vrij === 920, kj && (kj.ok ? kj.fouten : kj));
}
function r2(x) { return Math.round(x * 100) / 100; }
// server.js en uitrol
const srv = fs.readFileSync('server.js', 'utf8'), uit = fs.readFileSync('uitrol.sh', 'utf8'), dock = fs.readFileSync('Dockerfile', 'utf8');
toets('server.js: POST /app/financien/vermogen in de routetabel, achter appPriveDicht en appTeller; app-vermogen in BANK_LOKAAL, niet in BANK_OPDRACHTEN',
  /route === 'POST \/app\/financien\/vermogen'\) return appFinVermogen/.test(srv) && /async function appFinVermogen[\s\S]{0,300}appPriveDicht\(a, 'financien'\)/.test(srv) && /appTeller\('fin-vermogen'/.test(srv) &&
  /const BANK_LOKAAL = \[[^\]]*'app-vermogen'/.test(srv) && !/const BANK_OPDRACHTEN = \[[^\]]*'app-vermogen'/.test(srv), null);
toets('uitrol.sh en Dockerfile kennen financien-vermogen.js', /RELEASE_OPTIONEEL="[^"]*financien-vermogen\.js/.test(uit) && /COPY financien-vermogen\.js /.test(dock), null);
console.log('\n' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
