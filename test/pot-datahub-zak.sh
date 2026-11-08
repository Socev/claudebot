#!/usr/bin/env bash
# Toetst wv2762 (OVIS POT fase 3 stap 0): de POT-datahubstap ook voor de Kostenmaatschap en de SLOEL (ING, business-koppeling in
# zakelijk.sqlite). pot-datahub.js: ING-tekst, statements per entiteit (eigen bron, entiteit in elke rij), huur nooit uitgaand;
# bank-archief zakDatahubInvoer + bank-lezer pot-datahub-invoer met IBAN op stdin (alleen geboekt, rekening niet gevonden = weigering);
# server.js: drie entiteiten, ent_uit, bankbron in D1. VERZONNEN gegevens; raakt de pod, de bank en D1 niet. Gebruik: bash test/pot-datahub-zak.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const P = require(path.resolve('pot-datahub.js'));
const A = require(path.resolve('bank-archief.js'));
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'potdhz-'));
const IB = { km: 'NL98INGB0001234567', prak: 'NL12RABO0123456789', ander: 'NL55INGB0007654321' };
// ── 1. ING-tekst ──
const t1 = P.ingTekst({ regels: ['Naam: Praktijk Proef', 'Omschrijving: Bijdrage KM', 'november 2026', 'IBAN: ' + IB.prak, 'Kenmerk: 123', 'Valutadatum: 15-11-2026'], banksoort: 'Online bankieren' });
toets('ING: omschrijving = veld Omschrijving met vervolgregel, zonder IBAN/kenmerk', t1.omschrijving === 'Bijdrage KM november 2026' && t1.banksoort === 'Online bankieren' && t1.kenmerk === null, t1);
const t2 = P.ingTekst({ regels: ['Kosten zakelijk betalen', 'Betreft IBAN: ' + IB.km, 'Periode: 01-10-2026 - 31-10-2026', 'Valutadatum: 01-11-2026'] });
toets('ING zonder Omschrijving: regel zonder label + periode, geen IBAN', t2.omschrijving === 'Kosten zakelijk betalen Periode: 01-10-2026 - 31-10-2026' && t2.omschrijving.indexOf('NL98') < 0, t2);
toets('bankTekst kiest ING alleen met bank=ing', P.bankTekst({ regels: ['Naam: x', 'Omschrijving: y'] }, 'ing').omschrijving === 'y');
// ── 2. statements per entiteit ──
const v = { nieuw: [{ rij: { rekening: IB.km, boekdatum: '2026-11-15', bedrag: 500, tegenrekening: IB.prak, naam: 'Praktijk Proef', omschrijving: 'Bijdrage', kenmerk: null, banksoort: '', sleutel: 'abc', geladen_op: '2026-11-16' }, toewijzing: { soort: 'voorschot', praktijk_id: 'P01', persoon: null, tegen_entiteit: null, boekjaar: 2026, bedrag: 500, herkomst: 'enablebanking v1 2026-11-16' } }], herstel: [] };
const b = P.statements(v, { vandaag: '2026-11-16', entiteit: 'KM' });
toets('statements KM: bron en mutatie met entiteit KM en de KM-bron', b[0].statements[0].params[0] === 'KM' && b[0].statements[0].params[2] === P.BRONNEN.KM.titel && b[0].statements[1].params[1] === 'KM' && b[0].statements[1].params[13] === P.BRONNEN.KM.titel, b[0].statements.map((s) => s.params.slice(0, 3)));
toets('statements zonder entiteit = POT (zoals vóór wv2762)', P.statements(v, { vandaag: '2026-11-16' })[0].statements[1].params[1] === 'POT');
let gooit = false; try { P.statements(v, { vandaag: '2026-11-16', entiteit: 'FIN' }); } catch (e) { gooit = true; }
toets('onbekende entiteit: weigert', gooit);
// ── 3. huur nooit uitgaand ──
const hist = [1, 2].map((i) => ({ datum: '2026-0' + i + '-05', r: { boekdatum: '2026-0' + i + '-05', omschrijving: 'Huur', t: { soort: 'huur', praktijk_id: 'P02', persoon: null, tegen_entiteit: null, boekjaar: 2026, herkomst: 'regels v1', n: 1 } } }));
toets('huur: inkomend toegewezen, uitgaand niet', !!P.wijsToe({ datum: '2026-11-05', bedrag: 1200 }, 'Huur', hist, 'x') && P.wijsToe({ datum: '2026-11-05', bedrag: -1200 }, 'Huur', hist, 'x') === null);
// ── 4. voorstel met ING-posten: koppelt op bedrag/datum aan Davids rijen, toewijzing uit zijn historie ──
const rijen = [{ id: 1, boekdatum: '2026-09-15', bedrag: 500, tegenrekening: IB.prak, naam: 'Praktijk Proef', omschrijving: 'Bijdrage', sleutel: 'd1', bron_bestand: 'NL98_2026.csv', t: { soort: 'voorschot', praktijk_id: 'P01', persoon: null, tegen_entiteit: null, boekjaar: 2026, herkomst: 'regels v1 2026-09-20', n: 1 } },
  { id: 2, boekdatum: '2026-08-15', bedrag: 500, tegenrekening: IB.prak, naam: 'Praktijk Proef', omschrijving: 'Bijdrage', sleutel: 'd2', bron_bestand: 'NL98_2026.csv', t: { soort: 'voorschot', praktijk_id: 'P01', persoon: null, tegen_entiteit: null, boekjaar: 2026, herkomst: 'regels v1 2026-09-20', n: 1 } }];
const post = (nr, datum, bedrag, oms) => ({ nr, sleutel: 'e:' + nr, datum, valutadatum: datum, bedrag, tegen_iban: IB.prak, tegenpartij: 'Praktijk Proef', banksoort: 'Online bankieren', regels: ['Naam: Praktijk Proef', 'Omschrijving: ' + oms, 'IBAN: ' + IB.prak, 'Valutadatum: x'] });
const vs = P.voorstel({ iban: IB.km, bank: 'ing', posten: [post(1, '2026-08-15', 500, 'Bijdrage'), post(2, '2026-09-15', 500, 'Bijdrage'), post(3, '2026-10-15', 500, 'Bijdrage')], rijen, grootboek: {}, vandaag: '2026-11-08' });
toets('voorstel ING: 2 gekoppeld, 1 nieuw als voorschot P01 met tegenrekening', vs.telling.gekoppeld === 2 && vs.nieuw.length === 1 && vs.nieuw[0].toewijzing.soort === 'voorschot' && vs.nieuw[0].toewijzing.praktijk_id === 'P01' && vs.nieuw[0].rij.tegenrekening === IB.prak && vs.nieuw[0].rij.omschrijving === 'Bijdrage', vs.telling);
// ── 5. bank-archief + bank-lezer (zakelijk.sqlite, IBAN op stdin) ──
{
  const BD = path.join(W, 'bank'); fs.mkdirSync(BD, { recursive: true });
  const a = A.open(BD, 'zakelijk.sqlite');
  A.rekeningenSync(a, { km: { uid: 'u9', bank: 'ING', naam: 'Proef KM', iban: IB.km, sessie: 's9' }, ander: { uid: 'u8', bank: 'ING', naam: 'Ander', iban: IB.ander, sessie: 's8' } });
  const pp = (id, datum, bedrag, status) => ({ id, datum, valutadatum: datum, bedrag, valuta: 'EUR', tegenpartij: 'Praktijk Proef', tegen_iban: IB.prak, omschrijving: 'x', status: status || 'geboekt', _ruw: { remittance_information: ['Naam: Praktijk Proef', 'Omschrijving: Bijdrage'], bank_transaction_code: { description: 'Online bankieren' } } });
  A.bij(a, 'km', [pp('e:a', '2026-10-15', 500), pp('e:b', '2026-11-15', 500), pp('e:c', '2026-11-16', 7, 'pending')], null);
  A.bij(a, 'ander', [pp('e:z', '2026-11-15', 999)], null);
  a.db.close();
  fs.writeFileSync(path.join(BD, 'stand.json'), JSON.stringify({ versie: 1, rekeningen: {}, opgehaald: { km: { transacties: '2026-11-08T17:00:00.000Z' } } }), { mode: 0o600 });
  const loop = (inv) => spawnSync(process.execPath, ['--no-warnings', 'bank-lezer.js', 'pot-datahub-invoer', '--van', '2026-11-01'], { input: JSON.stringify(inv), env: { PATH: process.env.PATH, BANK_DIR: BD, HOME: W }, encoding: 'utf8' });
  const r = loop({ iban: IB.km });
  let j = null; try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) {}
  toets('bank-lezer met IBAN: zakelijke rekening, alleen geboekt, alleen die rekening', j && j.ok === true && j.iban === IB.km && j.posten.length === 2 && j.posten.every((p) => p.bedrag === 500), [r.stderr && r.stderr.slice(0, 300), j]);
  toets('banksoort en regels alleen vanaf --van', j && j.posten.find((p) => p.datum === '2026-11-15').banksoort === 'Online bankieren' && !j.posten.find((p) => p.datum === '2026-10-15').regels);
  toets('opgehaald uit stand.json; geen rek-sleutel in de uitvoer', j && j.opgehaald === '2026-11-08T17:00:00.000Z' && j.rek === undefined, j && Object.keys(j));
  const r2 = loop({ iban: 'NL00INGB0000000000' });
  toets('onbekende IBAN: weigering, geen posten', /niet in de zakelijke database/.test(r2.stdout) && !/"posten"/.test(r2.stdout), r2.stdout.slice(0, 200));
  const r3 = loop({ iban: 'geen iban' });
  toets('geen NL-IBAN: weigering', /geen NL-IBAN/.test(r3.stdout), r3.stdout.slice(0, 200));
}
// ── 6. server.js: drie entiteiten, ent_uit, bankbron ──
{
  const src = fs.readFileSync('server.js', 'utf8');
  toets('server: POT, KM (ing, zakelijk) en SLOEL (ing, zakelijk) in POT_DH_ENT', /POT_DH_ENT = \[\{ ent: 'POT', bank: 'abn', zak: false \}, \{ ent: 'KM', bank: 'ing', zak: true \}, \{ ent: 'SLOEL', bank: 'ing', zak: true \}\]/.test(src));
  toets('server: IBAN alleen via stdin (extra) naar de bankluis, nooit in argv', /bankKind\(\['pot-datahub-invoer', '--van', van\], E\.zak \? \{ iban:/.test(src));
  toets('server: bankbron in D1 zonder IBAN of bedrag', /'bank_bron_' \+ ent, JSON\.stringify\(\{ bron: 'bankkoppeling', opgehaald:/.test(src));
  toets('server: KM/SLOEL uit te zetten met ent_uit; POT niet', /E\.ent !== 'POT' && uitgezet\.indexOf\(E\.ent\) >= 0/.test(src));
}
console.log(`\n${goed} groen, ${fouten} rood`);
fs.rmSync(W, { recursive: true, force: true });
process.exit(fouten ? 1 : 0);
JS
