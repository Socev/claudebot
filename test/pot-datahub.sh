#!/usr/bin/env bash
# Toetst de stap "POT-posten naar Davids datahub" (wv815, 22-10-2026; bouwplan bankkoppeling § 9f): pot-datahub.js (koppelen op sleutel
# en op bedrag + datum ±3 dagen, grens van Davids lading, Davids vorm, nagebouwde toewijzing, grootboek-herstel, dubbelvangst, statements
# alleen met parameters), bank-archief potDatahubInvoer + bank-lezer pot-datahub-invoer (CLI, zonder netwerk), en potDatahubRonde uit
# server.js (vm) tegen een nagebootste D1 (node:sqlite met Davids schema): schakelaar, schrijven, tweede ronde 0, rekening wijkt af,
# D1-fout, kapot geheugen, droog, box-rij 1× per dag, geen namen of bedragen in log of telling.
# Raakt de pod, de kluis, de bank, D1 en /opt/data/bank niet. Gebruik: bash test/pot-datahub.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }
const P = require(path.resolve('pot-datahub.js'));
const A = require(path.resolve('bank-archief.js'));
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'potdh-'));
const IB = { pot: 'NL99ABNA0987654321', gh: 'NL12RABO0123456789', mw1: 'NL34INGB0001112223', mw2: 'NL56ABNA0004445556', pf: 'NL78ABNA0007778889', nieuw: 'NL90TRIO0001234567' };
const MW = ['Jansen Medewerker', 'Pietersen Medewerker', 'Nieuwe Collega'];
const regels = (naam, iban, oms, soort) => [(soort || 'SEPA Overboeking') + '                 IBAN: ' + iban, 'BIC: ABNANL2A', 'Naam: ' + naam, 'Omschrijving: ' + oms, 'Kenmerk: 1234567890'];
const bevatGeheim = (o) => { const t = JSON.stringify(o); return MW.some((n) => t.indexOf(n) >= 0) || Object.values(IB).some((i) => t.indexOf(i) >= 0) || /\d+[.,]\d\d\b/.test(t.replace(/"\d{4}-\d{2}-\d{2}"/g, '')); };

// ── Davids D1 (schema zoals in fin, 22-10-2026) ──
function maakD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE bron (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT, soort TEXT NOT NULL, titel TEXT NOT NULL, datum TEXT, periode_van TEXT, periode_tot TEXT, r2_sleutel TEXT, sha256 TEXT, geladen_op TEXT NOT NULL, gecontroleerd INTEGER NOT NULL DEFAULT 0, opmerking TEXT);' +
    'CREATE TABLE bankrekening (iban TEXT PRIMARY KEY, entiteit TEXT, bank TEXT, tenaamstelling TEXT, opmerking TEXT);' +
    'CREATE TABLE bankmutatie (id INTEGER PRIMARY KEY AUTOINCREMENT, rekening TEXT NOT NULL REFERENCES bankrekening(iban), entiteit TEXT NOT NULL, boekdatum TEXT NOT NULL, bedrag REAL NOT NULL, tegenrekening TEXT, naam TEXT, omschrijving TEXT, kenmerk TEXT, banksoort TEXT, saldo_na REAL, bron_bestand TEXT, sleutel TEXT UNIQUE, bron_id INTEGER REFERENCES bron(id), geladen_op TEXT NOT NULL);' +
    'CREATE TABLE bank_toewijzing (id INTEGER PRIMARY KEY AUTOINCREMENT, bankmutatie_id INTEGER NOT NULL REFERENCES bankmutatie(id), soort TEXT NOT NULL, praktijk_id TEXT, tegen_entiteit TEXT, persoon TEXT, boekjaar INTEGER, bedrag REAL NOT NULL, herkomst TEXT, opmerking TEXT);');
  db.prepare("INSERT INTO bron (id, entiteit, soort, titel, geladen_op, gecontroleerd) VALUES (64, 'POT', 'bankafschriften', 'pdf', '2026-09-20', 1)").run();
  db.prepare("INSERT INTO bankrekening (iban, entiteit, bank) VALUES (?, 'POT', 'ABN AMRO')").run(IB.pot);
  return db;
}
let davidNr = 0;
function davidRij(db, datum, bedrag, naam, oms, tegenrek, tw) {
  const s = crypto.createHash('md5').update('david' + (++davidNr)).digest('hex').slice(0, 16);
  const id = db.prepare("INSERT INTO bankmutatie (rekening, entiteit, boekdatum, bedrag, tegenrekening, naam, omschrijving, banksoort, bron_bestand, sleutel, bron_id, geladen_op) VALUES (?, 'POT', ?, ?, ?, ?, ?, 'SEPA Overboeking', ?, ?, 64, '2026-09-20')")
    .run(IB.pot, datum, bedrag, tegenrek || null, naam, oms, davidNr + '_Financial document.PDF', s).lastInsertRowid;
  if (tw) db.prepare('INSERT INTO bank_toewijzing (bankmutatie_id, soort, praktijk_id, persoon, boekjaar, bedrag, herkomst) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, tw.soort, tw.praktijk_id || null, tw.persoon || null, tw.boekjaar == null ? null : tw.boekjaar, bedrag, tw.herkomst || 'regels v1 2026-09-20');
  return Number(id);
}
function voerUit(db, batch) {   // een D1-batch als transactie
  db.exec('BEGIN');
  try { const r = batch.map((s) => { const st = db.prepare(s.sql); if (/^\s*SELECT/i.test(s.sql)) return { results: st.all(...s.params), meta: {} }; const x = st.run(...s.params); return { results: [], meta: { changes: Number(x.changes) } }; }); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
const leesRijen = (db) => db.prepare(P.SQL_LEES_RIJEN).all('POT', '2000-01-01').map((x) => P.rijUitD1(Object.assign({}, x)));

// ── scenario: Davids lading t/m 31-8, bankluis vanaf 1-7 tot 22-10 ──
function scenario() {
  const db = maakD1();
  const posten = []; let nr = 0;
  const post = (datum, bedrag, naam, iban, oms, extra) => { const p = Object.assign({ nr: ++nr, sleutel: 'e:' + nr, datum: datum, valutadatum: datum, bedrag: bedrag, tegen_iban: iban, tegenpartij: naam, regels: regels(naam, iban, oms) }, extra || {}); posten.push(p); return p; };
  for (const m of ['07', '08']) {
    // David: salaris onder pseudoniem, zonder tegenrekening; voorschot met tegenrekening en praktijk; pensioen-incasso
    davidRij(db, '2026-' + m + '-24', -2100.55, 'medewerker 7', 'Salaris ' + m, null, { soort: 'salaris' });
    post('2026-' + m + '-24', -2100.55, MW[0], IB.mw1, 'Salaris ' + m);
    davidRij(db, '2026-' + m + '-24', -1850.10, 'medewerker 9', 'Salaris ' + m, null, { soort: 'salaris' });
    post('2026-' + m + '-24', -1850.10, MW[1], IB.mw2, 'Salaris ' + m);
    davidRij(db, '2026-' + m + '-04', 9000, 'GH - Groenhouten (P07)', 'Maandelijkse bijdrage POT', IB.gh, { soort: 'voorschot', praktijk_id: 'P07', boekjaar: 2026 });
    post('2026-' + m + '-02', 9000, 'Huisartsenpraktijk Groenhouten', IB.gh, 'Maandelijkse bijdrage POT');   // API-datum 2 dagen eerder
    davidRij(db, '2026-' + m + '-28', -640.40, 'Pensioenfonds Zorg', 'Premie ' + m, null, { soort: 'pensioen' });
    post('2026-' + m + '-28', -640.40, 'PFZW', IB.pf, 'Premie ' + m, { regels: regels('PFZW', IB.pf, 'Premie ' + m, 'SEPA Incasso algemeen doorlopend') });
  }
  // declaratie aan dezelfde medewerker (trefwoord) en een eindafrekening met jaartal
  davidRij(db, '2026-08-10', -45.5, 'medewerker 7', 'Declaratie parkeren', null, { soort: 'declaratie', persoon: 'medewerker 7' });
  post('2026-08-10', -45.5, MW[0], IB.mw1, 'Declaratie parkeren');
  davidRij(db, '2026-07-15', 1200, 'GH - Groenhouten (P07)', 'Eindafrekening POT 2025', IB.gh, { soort: 'afrekening', praktijk_id: 'P07', boekjaar: 2025 });
  post('2026-07-15', 1200, 'Huisartsenpraktijk Groenhouten', IB.gh, 'Eindafrekening POT 2025');
  // nieuw na de grens
  const n = {
    sal1: post('2026-09-24', -2100.55, MW[0], IB.mw1, 'Salaris 09'),
    sal2: post('2026-09-24', -1850.10, MW[1], IB.mw2, 'Salaris 09'),   // let op: zelfde dag, ander bedrag
    vs: post('2026-09-03', 9000, 'Huisartsenpraktijk Groenhouten', IB.gh, 'Maandelijkse bijdrage POT'),
    pf: post('2026-09-28', -640.40, 'PFZW', IB.pf, 'Premie 09', { regels: regels('PFZW', IB.pf, 'Premie 09', 'SEPA Incasso algemeen doorlopend') }),
    decl: post('2026-09-12', -12.75, MW[0], IB.mw1, "Declaratie '; DROP TABLE bankmutatie; --"),
    afr: post('2026-10-01', 800, 'Huisartsenpraktijk Groenhouten', IB.gh, 'Eindafrekening POT 2024 en 2025'),   // twee jaartallen: offset uit historie
    nieuweMw: post('2026-10-24', -1500, MW[2], IB.nieuw, 'Salaris 10'),
    kosten: post('2026-10-01', -9.85, '', null, 'x', { regels: ['ABN AMRO Bank N.V.               Betaalpakket                 9,85'] }),
    uitGh: post('2026-10-05', -9000, 'Huisartsenpraktijk Groenhouten', IB.gh, 'Terugbetaling bijdrage'),
  };
  return { db, posten, n };
}

(async function () {
  // ── 1. pure module ──
  {
    const { db, posten, n } = scenario();
    const rijen = leesRijen(db);
    let fout = null;
    try { P.voorstel({ iban: IB.pot, posten, rijen: [], vandaag: '2026-10-22' }); } catch (e) { fout = e.message; }
    toets('zonder eigen lading van David: weigert', /geen eigen lading/.test(String(fout)), fout);
    fout = null; try { P.voorstel({ iban: 'NL00XXXX', posten, rijen, vandaag: '2026-10-22' }); } catch (e) { fout = e.message; }
    toets('geen geldige IBAN: weigert', /IBAN/.test(String(fout)), fout);
    const v = P.voorstel({ iban: IB.pot, posten, rijen, grootboek: {}, vandaag: '2026-10-22' });
    const t = v.telling;
    toets('alle posten t/m de grens gekoppeld (ook met 2 dagen datumverschil)', t.gekoppeld === 10 && t.onverklaard === 0, t);
    toets('nieuw = posten na de grens (9)', t.nieuw === 9, t);
    const vind = (p) => v.nieuw.find((x) => x.rij.sleutel === P.d1Sleutel(IB.pot, p.sleutel));
    const s1 = vind(n.sal1), s2 = vind(n.sal2), vs = vind(n.vs), pf = vind(n.pf), dc = vind(n.decl), af = vind(n.afr), nm = vind(n.nieuweMw), ko = vind(n.kosten), ug = vind(n.uitGh);
    toets('salaris: Davids pseudoniem, geen tegenrekening, toewijzing salaris', s1.rij.naam === 'medewerker 7' && s1.rij.tegenrekening === null && s1.toewijzing && s1.toewijzing.soort === 'salaris' && s1.toewijzing.persoon === null, s1);
    toets('tweede medewerker: eigen pseudoniem', s2.rij.naam === 'medewerker 9' && s2.toewijzing.soort === 'salaris', s2.rij.naam);
    toets('voorschot: tegenrekening (David had die altijd), praktijk P07, boekjaar 2026', vs.rij.tegenrekening === IB.gh && vs.toewijzing.soort === 'voorschot' && vs.toewijzing.praktijk_id === 'P07' && vs.toewijzing.boekjaar === 2026, vs);
    toets('pensioen: banksoort incasso, naam van David, toewijzing pensioen', pf.rij.banksoort === 'SEPA Incasso algemeen doorlopend' && pf.rij.naam === 'Pensioenfonds Zorg' && pf.toewijzing.soort === 'pensioen', pf.rij);
    toets('declaratie: trefwoord kiest Davids declaratie-historie, met persoon', dc.toewijzing && dc.toewijzing.soort === 'declaratie' && dc.toewijzing.persoon === 'medewerker 7', dc.toewijzing);
    toets('afrekening met twee jaartallen: boekjaar uit de historie (−1)', af.toewijzing && af.toewijzing.soort === 'afrekening' && af.toewijzing.boekjaar === 2025, af.toewijzing);
    toets('onbekende tegenpartij (ook uitgaand naar een praktijk die alleen inkomend kende, en bankkosten): naam leeg, geen tegenrekening, geen toewijzing', nm.rij.naam === '' && nm.rij.tegenrekening === null && nm.toewijzing === null && t.onbekend === 3 && ug.rij.naam === '', [nm, t.onbekend]);
    toets('bankkosten zonder Omschrijving-veld: omschrijving leeg (zoals David), banksoort uit de regel', ko.rij.omschrijving === '' && /^ABN AMRO Bank N\.V\./.test(ko.rij.banksoort), ko.rij);
    toets('uitgaande post naar een praktijk: nooit voorschot', ug.toewijzing === null, ug.toewijzing);
    toets('kenmerk altijd leeg; saldo niet gezet', v.nieuw.every((x) => x.rij.kenmerk === null && !('saldo_na' in x.rij)));
    toets('herkomst eigen run met datum', s1.toewijzing.herkomst === 'enablebanking v1 2026-10-22');
    toets('telling bevat alleen aantallen en de grens', !bevatGeheim(t) && Object.keys(t).every((k) => k === 'grens' || Number.isInteger(t[k])), t);
    // afrekening met precies één jaartal
    const p1 = { nr: 999, sleutel: 'e:999', datum: '2026-10-02', valutadatum: '2026-10-02', bedrag: 300, tegen_iban: IB.gh, tegenpartij: 'x', regels: regels('x', IB.gh, 'Eindafrekening 2023') };
    const h = rijen.filter((r) => r.naam === 'GH - Groenhouten (P07)').map((r) => ({ datum: r.boekdatum, r }));
    toets('afrekening met één jaartal: dat jaar', P.wijsToe(p1, 'Eindafrekening 2023', h, 'x').boekjaar === 2023);
    toets('jaartal-regex: geen jaartal uit een notanummer', P.wijsToe(p1, 'Eindafrekening nota 1202599', h, 'x').boekjaar === 2025);
    // niet eensgezind → geen toewijzing; gesplitst → geen; eigen toewijzingen tellen niet
    const mix = [{ datum: '2026-07-01', r: { boekdatum: '2026-07-01', omschrijving: 'a', t: { soort: 'overig', n: 1 } } }, { datum: '2026-08-01', r: { boekdatum: '2026-08-01', omschrijving: 'b', t: { soort: 'administratie', n: 1 } } }];
    const pm = { datum: '2026-09-01', bedrag: -10 };
    toets('historie niet eensgezind: geen toewijzing', P.wijsToe(pm, 'c', mix, 'x') === null);
    toets('historie met een gesplitste post: geen toewijzing', P.wijsToe(pm, 'c', [{ datum: '2026-07-01', r: { boekdatum: '2026-07-01', omschrijving: 'a', t: { soort: 'overig', n: 2 } } }], 'x') === null);
    toets('alleen eigen (enablebanking-)toewijzingen in de historie: geen toewijzing', P.wijsToe(pm, 'c', [{ datum: '2026-07-01', r: { boekdatum: '2026-07-01', omschrijving: 'a', t: { soort: 'overig', herkomst: 'enablebanking v1 2026-10-22', n: 1 } } }], 'x') === null);
    toets('alleen de laatste 8 tellen', P.wijsToe(pm, 'c', [{ datum: '2025-01-01', r: { boekdatum: '2025-01-01', omschrijving: 'a', t: { soort: 'administratie', n: 1 } } }].concat(Array.from({ length: 8 }, (_, i) => ({ datum: '2026-0' + (i + 1) + '-01', r: { boekdatum: '2026-0' + (i + 1) + '-01', omschrijving: 'a', t: { soort: 'overig', n: 1 } } }))), 'x').soort === 'overig');

    // statements: alleen parameters, vaste SQL
    const batches = P.statements(v, { vandaag: '2026-10-22' });
    const alle = batches.flatMap((b) => b.statements);
    const vast = new Set(alle.map((s) => s.sql));
    toets('statements: alleen de drie vaste SQL-teksten, banktekst alleen in parameters', vast.size === 3 && alle.every((s) => s.sql.indexOf('DROP') < 0 && s.sql.indexOf('medewerker') < 0 && !bevatGeheim(s.sql)), [...vast].map((x) => x.slice(0, 40)));
    toets('bronrij alleen vooraan in de eerste batch', alle.filter((s) => s.sql.indexOf('INSERT INTO bron') === 0).length === 1 && batches[0].statements[0].sql.indexOf('INSERT INTO bron') === 0);
    // groot voorstel → batches van ≤ 20 posten
    const veel = { nieuw: Array.from({ length: 45 }, (_, i) => ({ rij: Object.assign({}, s1.rij, { sleutel: 'k' + i }), toewijzing: s1.toewijzing })), herstel: [] };
    const vb = P.statements(veel, { vandaag: '2026-10-22' });
    toets('45 posten → 3 batches (20/20/5), sleutels per batch', vb.length === 3 && vb.map((b) => b.sleutels.length).join() === '20,20,5', vb.map((b) => b.sleutels.length));

    // uitvoeren op de nagebootste D1
    batches.forEach((b) => voerUit(db, b.statements));
    const n1 = db.prepare("SELECT count(*) n FROM bankmutatie WHERE bron_bestand = 'enablebanking'").get().n;
    const t1 = db.prepare("SELECT count(*) n FROM bank_toewijzing t JOIN bankmutatie m ON m.id = t.bankmutatie_id WHERE m.bron_bestand = 'enablebanking'").get().n;
    toets('D1: 9 rijen gezet, toewijzingen zoals voorgesteld', n1 === 9 && t1 === t.toegewezen, [n1, t1, t.toegewezen]);
    const injectie = db.prepare("SELECT omschrijving FROM bankmutatie WHERE sleutel = ?").get(dc.rij.sleutel);
    toets('banktekst met aanhalingsteken, puntkomma en -- letterlijk bewaard (geen injectie)', injectie && injectie.omschrijving === "Declaratie '; DROP TABLE bankmutatie; --");
    const bron = db.prepare("SELECT count(*) n, min(id) id FROM bron WHERE soort = 'bankkoppeling'").get();
    toets('één bronrij, alle eigen rijen verwijzen ernaar', bron.n === 1 && db.prepare("SELECT count(*) n FROM bankmutatie WHERE bron_bestand = 'enablebanking' AND bron_id = ?").get(bron.id).n === 9);
    toets('toewijzing.bedrag = mutatie.bedrag', db.prepare('SELECT count(*) n FROM bank_toewijzing t JOIN bankmutatie m ON m.id = t.bankmutatie_id WHERE abs(t.bedrag - m.bedrag) > 0.001').get().n === 0);
    // tweede ronde: niets nieuw; grootboek leeg maar alle rijen al toegewezen of zonder voorstel
    const gb = {}; batches.forEach((b) => b.sleutels.forEach((s) => { gb[s] = '2026-10-22'; }));
    const v2 = P.voorstel({ iban: IB.pot, posten, rijen: leesRijen(db), grootboek: gb, vandaag: '2026-10-23' });
    toets('tweede ronde: 0 nieuw, 0 herstel, alles gekoppeld op sleutel', v2.telling.nieuw === 0 && v2.telling.herstel === 0 && v2.telling.gekoppeld === posten.length, v2.telling);
    // statements van de eerste ronde nog eens uitvoeren: INSERT OR IGNORE en NOT EXISTS → niets dubbel
    batches.forEach((b) => voerUit(db, b.statements));
    toets('dezelfde batch twee keer: geen dubbele rij of toewijzing', db.prepare("SELECT count(*) n FROM bankmutatie WHERE bron_bestand = 'enablebanking'").get().n === 9 &&
      db.prepare("SELECT count(*) n FROM bank_toewijzing t JOIN bankmutatie m ON m.id = t.bankmutatie_id WHERE m.bron_bestand = 'enablebanking'").get().n === t1);
    // David haalt een toewijzing weg (rij staat in het grootboek): komt niet terug
    db.prepare('DELETE FROM bank_toewijzing WHERE bankmutatie_id = (SELECT id FROM bankmutatie WHERE sleutel = ?)').run(s1.rij.sleutel);
    const v3 = P.voorstel({ iban: IB.pot, posten, rijen: leesRijen(db), grootboek: gb, vandaag: '2026-10-23' });
    toets('toewijzing die David weghaalde: geen herstel (grootboek)', v3.telling.herstel === 0, v3.telling);
    // half geschreven batch (rij wel, toewijzing niet, niet in het grootboek): één herstel
    const gb2 = Object.assign({}, gb); delete gb2[s1.rij.sleutel];
    const v4 = P.voorstel({ iban: IB.pot, posten, rijen: leesRijen(db), grootboek: gb2, vandaag: '2026-10-23' });
    toets('rij zonder toewijzing buiten het grootboek: één herstel met toewijzing', v4.telling.herstel === 1 && v4.telling.herstel_toegewezen === 1 && v4.herstel[0].toewijzing.soort === 'salaris', v4.telling);
    P.statements(v4, { vandaag: '2026-10-23' }).forEach((b) => voerUit(db, b.statements));
    toets('herstel geschreven met herkomst van vandaag', db.prepare('SELECT herkomst FROM bank_toewijzing WHERE bankmutatie_id = (SELECT id FROM bankmutatie WHERE sleutel = ?)').get(s1.rij.sleutel).herkomst === 'enablebanking v1 2026-10-23');
    // David laadt toch een pdf over september (zijn sleutels): wij zetten niets, en melden het vermoeden
    davidRij(db, '2026-09-25', -2100.55, 'medewerker 7', 'Salaris 09', null, { soort: 'salaris' });
    davidRij(db, '2026-09-30', 1, 'x', 'y', null, null);   // nieuwe grens 30-9
    const v5 = P.voorstel({ iban: IB.pot, posten, rijen: leesRijen(db), grootboek: gb, vandaag: '2026-10-24' });
    toets('pdf-lading over dezelfde periode: 0 nieuw, dubbel vermoed 1', v5.telling.nieuw === 0 && v5.telling.dubbel_vermoed === 1, v5.telling);
    // David wist een rij die wij zetten (sleutel in het grootboek): niet terugzetten
    const { db: dbM, posten: pM } = scenario();
    const vM = P.voorstel({ iban: IB.pot, posten: pM, rijen: leesRijen(dbM), grootboek: {}, vandaag: '2026-10-22' });
    P.statements(vM, { vandaag: '2026-10-22' }).forEach((b) => voerUit(dbM, b.statements));
    const gbM = {}; vM.nieuw.forEach((x) => { gbM[x.rij.sleutel] = '2026-10-22'; });
    dbM.prepare('DELETE FROM bank_toewijzing WHERE bankmutatie_id IN (SELECT id FROM bankmutatie WHERE sleutel = ?)').run(vM.nieuw[0].rij.sleutel);
    dbM.prepare('DELETE FROM bankmutatie WHERE sleutel = ?').run(vM.nieuw[0].rij.sleutel);
    const vM2 = P.voorstel({ iban: IB.pot, posten: pM, rijen: leesRijen(dbM), grootboek: gbM, vandaag: '2026-10-23' });
    toets('rij die David wiste (in het grootboek): niet terug, geteld', vM2.telling.nieuw === 0 && vM2.telling.door_david_verwijderd === 1, vM2.telling);
    const vM3 = P.voorstel({ iban: IB.pot, posten: pM, rijen: leesRijen(dbM), grootboek: {}, vandaag: '2026-10-23' });
    toets('zonder grootboek zou hij terugkomen (daarom het schakelscript)', vM3.telling.nieuw === 1, vM3.telling);
    // groep zonder IBAN en naam: naam alleen als David overal dezelfde gebruikte
    const dbL = maakD1();
    davidRij(dbL, '2026-07-01', -9.85, 'ABN AMRO Bank N.V.', '', null, { soort: 'overig' });
    davidRij(dbL, '2026-08-01', -3.10, 'Kosten rente', '', null, { soort: 'overig' });
    const pl = (nr, datum, bedrag) => ({ nr, sleutel: 'e:' + nr, datum, valutadatum: datum, bedrag, tegen_iban: null, tegenpartij: '', regels: ['ABN AMRO Bank N.V.               Betaalpakket'] });
    const vL = P.voorstel({ iban: IB.pot, posten: [pl(1, '2026-07-01', -9.85), pl(2, '2026-08-01', -3.10), pl(3, '2026-10-01', -9.85)], rijen: leesRijen(dbL), grootboek: {}, vandaag: '2026-10-22' });
    toets('lege groep met verschillende namen bij David: naam leeg, toewijzing wel (eensgezind overig)', vL.nieuw.length === 1 && vL.nieuw[0].rij.naam === '' && vL.nieuw[0].toewijzing.soort === 'overig', vL.nieuw);
  }
  // ── 2. grens en koppeling ──
  {
    const db = maakD1();
    davidRij(db, '2026-08-31', -100, 'a', 'b', null, { soort: 'overig' });
    davidRij(db, '2026-08-20', -100, 'a', 'b', null, { soort: 'overig' });
    davidRij(db, '2026-08-21', -100, 'a', 'b', null, { soort: 'overig' });
    const mk = (nr, datum, bedrag, valuta) => ({ nr, sleutel: 'e:' + nr, datum, valutadatum: valuta || datum, bedrag, tegen_iban: IB.pf, tegenpartij: 'a', regels: regels('a', IB.pf, 'b') });
    // twee gelijke bedragen op naburige dagen: elk naar de dichtstbijzijnde
    const posten = [mk(1, '2026-08-21', -100), mk(2, '2026-08-20', -100), mk(3, '2026-08-31', -100), mk(4, '2026-08-15', -55.5), mk(5, '2026-08-30', -77), mk(6, '2026-08-29', -100, '2026-09-02')];
    const k = P.koppel(IB.pot, posten, leesRijen(db));
    const r = (nr) => k.paar.get(nr) && k.paar.get(nr).boekdatum;
    toets('gelijke bedragen op naburige dagen: elk naar zijn eigen dag', r(1) === '2026-08-21' && r(2) === '2026-08-20' && r(3) === '2026-08-31', [r(1), r(2), r(3)]);
    const v = P.voorstel({ iban: IB.pot, posten, rijen: leesRijen(db), grootboek: {}, vandaag: '2026-10-22' });
    toets('niet gekoppeld en ouder dan grens−3: onverklaard, niet gezet', v.telling.onverklaard >= 1 && !v.nieuw.some((x) => x.rij.boekdatum === '2026-08-15'), v.telling);
    toets('in de laatste 3 dagen zonder rij van David met dat bedrag: gezet', v.nieuw.some((x) => x.rij.boekdatum === '2026-08-30'), v.nieuw.map((x) => x.rij.boekdatum));
    toets('in de laatste 3 dagen mét een rij van David met dat bedrag in de buurt: onverklaard', !v.nieuw.some((x) => x.rij.boekdatum === '2026-08-29') && v.telling.onverklaard === 2, v.telling);
  }
  // ── 3. bank-archief + bank-lezer (CLI, zonder netwerk) ──
  {
    const BD = path.join(W, 'bank'); const a = A.open(BD);
    A.rekeningenSync(a, { pot: { uid: 'u2', bank: 'ABN AMRO', naam: 'D Schaap', iban: IB.pot, sessie: 's2' } });
    A.zakelijkZet(a, { [IB.pot]: 'POT' }); A.rekeningenSync(a, { pot: { uid: 'u2', bank: 'ABN AMRO', naam: 'D Schaap', iban: IB.pot, sessie: 's2' } });
    const pp = (id, datum, bedrag, oms, status) => ({ id, datum, valutadatum: datum, bedrag, valuta: 'EUR', tegenpartij: MW[0], tegen_iban: IB.mw1, omschrijving: oms, status: status || 'geboekt', _ruw: { remittance_information: regels(MW[0], IB.mw1, oms) } });
    A.bij(a, 'pot', [pp('e:a', '2026-08-24', -2100.55, 'Salaris 08'), pp('e:b', '2026-09-24', -2100.55, 'Salaris 09'), pp('e:c', '2026-10-21', -5, 'wacht', 'pending')], null);
    a.db.close();
    const r = spawnSync(process.execPath, ['--no-warnings', 'bank-lezer.js', 'pot-datahub-invoer', '--van', '2026-09-01'], { input: '{}', env: { PATH: process.env.PATH, BANK_DIR: BD, HOME: W }, encoding: 'utf8' });
    let j = null; try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) {}
    toets('bank-lezer pot-datahub-invoer: ok, IBAN, alleen geboekt', j && j.ok === true && j.iban === IB.pot && j.posten.length === 2, [r.status, r.stderr && r.stderr.slice(0, 200), j && j.posten && j.posten.length]);
    toets('bankregels alleen vanaf --van', j && !j.posten.find((p) => p.datum === '2026-08-24').regels && Array.isArray(j.posten.find((p) => p.datum === '2026-09-24').regels));
    const r2 = spawnSync(process.execPath, ['--no-warnings', 'bank-lezer.js', 'pot-datahub-invoer', '--van', 'gisteren'], { input: '{}', env: { PATH: process.env.PATH, BANK_DIR: BD, HOME: W }, encoding: 'utf8' });
    toets('--van moet een datum zijn', /JJJJ-MM-DD/.test(r2.stdout), r2.stdout.slice(0, 200));
    const src = fs.readFileSync('server.js', 'utf8');
    toets('pot-datahub-invoer staat in BANK_LOKAAL en niet in BANK_OPDRACHTEN (/smal/bank)', /BANK_LOKAAL = \[[^\]]*'pot-datahub-invoer'/.test(src) && !/BANK_OPDRACHTEN\s*=\s*\[[^\]]*pot-datahub/.test(src));
  }
  // ── 4. potDatahubRonde uit server.js (vm) tegen een nagebootste D1 ──
  {
    const BD = path.join(W, 'bank4'); fs.mkdirSync(BD, { mode: 0o700 });
    const VAULT = path.join(W, 'vault'); fs.mkdirSync(path.join(VAULT, '00_Systeem', 'Meldingen'), { recursive: true });
    const BOX = path.join(VAULT, '00_Systeem', 'Meldingen', 'machinekamer.md');
    fs.writeFileSync(BOX, '# box\n\n## [direct] 2026-10-20 10:00 — oude rij\n- status: open\n');
    const src = fs.readFileSync('server.js', 'utf8');
    const a = src.indexOf('// ── wv680: bankluis'), b = src.indexOf('// ── einde bankluis ──');
    const k1 = src.indexOf('function smalKind('), k2 = src.indexOf('async function smalSbRpc(');
    let { db, posten } = scenario();
    let d1Fout = null, d1Batches = 0;
    const logs = [];
    const env = { PATH: process.env.PATH, HOME: W, TZ: 'Europe/Amsterdam', BANK_DIR: BD, CLOUDFLARE_API_TOKEN: 'cf-test' };
    const g2 = { require, fs, path, crypto, Buffer, console, URL, setTimeout, clearTimeout, AbortSignal, Promise, JSON, Date, VAULT, SECRET: 'x'.repeat(40),
      __dirname: process.cwd(), process: { env, execPath: process.execPath, pid: process.pid }, spawn, APP_CF_ACCOUNT: 'acc', APP_FIN_DB: 'db',
      fetch: async function (url, o) {
        if (!/\/d1\/database\/db\/query$/.test(url) || o.headers.Authorization !== 'Bearer cf-test') throw new Error('onverwachte url');
        d1Batches++;
        if (d1Fout) return { ok: false, status: 500, json: async () => ({ success: false, errors: [{ message: d1Fout }] }) };
        const body = JSON.parse(o.body);
        try { const r = voerUit(db, body.batch); return { ok: true, status: 200, json: async () => ({ success: true, result: r.map((x) => ({ success: true, results: x.results, meta: x.meta })) }) }; }
        catch (e) { return { ok: false, status: 400, json: async () => ({ success: false, errors: [{ message: e.message + ' 123456789' }] }) }; }
      },
      appSbRpc: async () => ({ ok: true }), logError: (w, e) => logs.push(w + ': ' + (e && e.message || e)), schrijfLog: (x) => logs.push(x), nu: () => 'NU', velden: (o) => JSON.stringify(o),
      reqPath: (req) => (req.url || '').split('?')[0], rolPoort: (res, verder) => verder(), rol: { eerste: true }, rolPrimair: () => true, rolEerste: Promise.resolve(), ROL_START_WACHT_MS: 50 };
    const ctx = vm.createContext(g2);
    vm.runInContext(src.slice(k1, k2) + '\n' + src.slice(a, b) + '\n;globalThis.__h = { potDatahubRonde };', ctx, { filename: 'server.js#bank' });
    const h = ctx.__h;
    let kindIban = IB.pot; const kindArgs = [];
    ctx.bankKind = async function (args) { kindArgs.push(args); return { code: 0, j: { ok: true, iban: kindIban, posten: JSON.parse(JSON.stringify(posten)) } }; };
    const STAAT = path.join(BD, 'pot-datahub.json');
    const boxRijen = () => (fs.readFileSync(BOX, 'utf8').match(/^## \[direct\]/gm) || []).length;
    const eigen = () => db.prepare("SELECT count(*) n FROM bankmutatie WHERE bron_bestand = 'enablebanking'").get().n;

    let u = await h.potDatahubRonde({ vandaag: '2026-10-22' });
    toets('zonder geheugenbestand: uit, niets gelezen of geschreven', u.gedaan === false && u.reden === 'uit' && d1Batches === 0 && eigen() === 0, u);
    u = await h.potDatahubRonde({ vandaag: '2026-10-22', droog: true });
    toets('droog: telling zonder schrijven', u.droog === true && u.telling.nieuw === 9 && eigen() === 0 && !fs.existsSync(STAAT), u);
    toets('bankKind met --van = grens − 10 dagen', JSON.stringify(kindArgs[0]) === JSON.stringify(['pot-datahub-invoer', '--van', '2026-08-18']) && u.telling.grens === '2026-08-28', kindArgs[0]);
    fs.writeFileSync(STAAT, JSON.stringify({ aan: true }), { mode: 0o600 });
    u = await h.potDatahubRonde({ vandaag: '2026-10-22' });
    toets('aan: 9 rijen geschreven, toewijzingen geteld', u.gedaan === true && u.telling.geschreven === 9 && eigen() === 9 && u.telling.toewijzingen_geschreven === u.telling.toegewezen, u);
    const st = JSON.parse(fs.readFileSync(STAAT, 'utf8'));
    toets('grootboek: 9 sleutels, schakelaar onaangeroerd, bestand 600', Object.keys(st.grootboek).length === 9 && st.aan === true && (fs.statSync(STAAT).mode & 0o777) === 0o600, st);
    u = await h.potDatahubRonde({ vandaag: '2026-10-23' });
    toets('tweede ronde: 0 geschreven', u.gedaan === true && u.telling.geschreven === 0 && u.telling.nieuw === 0 && eigen() === 9, u.telling);
    toets('log: alleen aantallen, geen namen, IBAN of bedrag', logs.length > 0 && !logs.some((x) => bevatGeheim(x)), logs);
    toets('uitkomst naar n8n zonder namen of bedragen', !bevatGeheim(u), u);
    // rekening wijkt af
    kindIban = IB.gh; const box0 = boxRijen();
    u = await h.potDatahubRonde({ vandaag: '2026-10-23' });
    toets('IBAN bankluis ≠ datahub: niets geschreven, box-rij', u.gedaan === false && u.fout === 'rekening wijkt af' && boxRijen() === box0 + 1, u);
    u = await h.potDatahubRonde({ vandaag: '2026-10-23' });
    toets('zelfde reden dezelfde dag: geen tweede box-rij', boxRijen() === box0 + 1);
    u = await h.potDatahubRonde({ vandaag: '2026-10-25' });
    toets('zelfde toestand twee dagen later: geen nieuwe box-rij', boxRijen() === box0 + 1);
    u = await h.potDatahubRonde({ vandaag: '2026-10-30' });
    toets('zelfde toestand na 7 dagen: wel weer een box-rij', boxRijen() === box0 + 2, boxRijen() - box0);
    kindIban = IB.pot;
    toets('box-rij zonder IBAN of naam', !bevatGeheim(fs.readFileSync(BOX, 'utf8')));
    // D1-fout
    d1Fout = 'D1_ERROR: iets met 98765432 en ' + MW[0];
    u = await h.potDatahubRonde({ vandaag: '2026-10-24' });
    toets('D1 onbereikbaar: fout, box-rij, geen exceptie', u.gedaan === false && /faalde/.test(u.fout) && boxRijen() === box0 + 3, u);
    toets('foutlog zonder cijferreeks', logs.some((x) => /pot-datahub: D1 http 500/.test(x)) && !logs.some((x) => /98765432/.test(x)), logs.slice(-2));
    d1Fout = null;
    // nieuwe post + een batch die halverwege faalt (UNIQUE-conflict in de bron? nee: een kapotte toewijzing) → rollback, volgende ronde zet hem
    posten.push({ nr: 500, sleutel: 'e:500', datum: '2026-10-22', valutadatum: '2026-10-22', bedrag: -2100.55, tegen_iban: IB.mw1, tegenpartij: MW[0], regels: regels(MW[0], IB.mw1, 'Salaris 10') });
    db.exec("CREATE TRIGGER stuk BEFORE INSERT ON bank_toewijzing BEGIN SELECT RAISE(ABORT, 'stuk'); END;");
    u = await h.potDatahubRonde({ vandaag: '2026-10-24' });
    toets('batch faalt halverwege: transactie terug, geen halve rij, niet in grootboek', u.gedaan === false && eigen() === 9 && !Object.hasOwn(JSON.parse(fs.readFileSync(STAAT, 'utf8')).grootboek, P.d1Sleutel(IB.pot, 'e:500')), u);
    db.exec('DROP TRIGGER stuk');
    u = await h.potDatahubRonde({ vandaag: '2026-10-25' });
    toets('volgende ronde: de post alsnog gezet mét toewijzing', u.gedaan === true && u.telling.geschreven === 1 && u.telling.toewijzingen_geschreven === 1 && eigen() === 10, u.telling);
    // kapot geheugen
    fs.writeFileSync(STAAT, '{kapot', { mode: 0o600 }); const box1 = boxRijen();
    u = await h.potDatahubRonde({ vandaag: '2026-10-25' });
    const u2 = await h.potDatahubRonde({ vandaag: '2026-10-25' });
    toets('kapot geheugen: stil, één box-rij, bestand niet overschreven', u.reden === 'geheugen onleesbaar' && u2.reden === 'geheugen onleesbaar' && boxRijen() === box1 + 1 && fs.readFileSync(STAAT, 'utf8') === '{kapot', [u, boxRijen() - box1]);
    // ontbrekende module in de release: box-rij, geen exceptie naar bankRonde
    const echtDir = g2.__dirname; ctx.__dirname = path.join(W, 'leeg'); fs.mkdirSync(ctx.__dirname, { recursive: true });
    fs.writeFileSync(STAAT, JSON.stringify({ aan: true }), { mode: 0o600 }); const box2 = boxRijen();
    let gooit = false; try { u = await h.potDatahubRonde({ vandaag: '2026-10-26' }); } catch (e) { gooit = true; }
    toets('pot-datahub.js ontbreekt: fout + box-rij, geen exceptie', !gooit && u.gedaan === false && boxRijen() === box2 + 1, [gooit, u]);
    ctx.__dirname = echtDir;
    // schakelscript: alleen aan wijzigen, grootboek blijft
    fs.writeFileSync(STAAT, JSON.stringify({ aan: true, grootboek: { a: '2026-10-22', b: '2026-10-22' }, box: {} }), { mode: 0o600 });
    const sch = (arg) => spawnSync('python3', [process.env.POT_DH_SCHAKEL || '/opt/data/mk-scripts/pot-datahub-schakel.py', arg], { env: { PATH: process.env.PATH, BANK_DIR: BD }, encoding: 'utf8' });
    if (fs.existsSync(process.env.POT_DH_SCHAKEL || '/opt/data/mk-scripts/pot-datahub-schakel.py')) {
      const s1 = sch('uit'); const na = JSON.parse(fs.readFileSync(STAAT, 'utf8'));
      toets('schakelscript uit: aan=false, grootboek intact, 600', na.aan === false && Object.keys(na.grootboek).length === 2 && (fs.statSync(STAAT).mode & 0o777) === 0o600, [s1.stdout, s1.stderr]);
      fs.writeFileSync(STAAT, '{kapot'); const s2 = sch('aan');
      toets('schakelscript op kapot bestand: weigert, niet overschreven', s2.status !== 0 && fs.readFileSync(STAAT, 'utf8') === '{kapot');
    } else console.log('(schakelscript niet aanwezig: overgeslagen)');
    // schakelaar uit
    fs.writeFileSync(STAAT, JSON.stringify({ aan: false, grootboek: {} }), { mode: 0o600 });
    u = await h.potDatahubRonde({ vandaag: '2026-10-26' });
    toets('schakelaar uit: niets', u.gedaan === false && u.reden === 'uit');
    // zonder Cloudflare-sleutel
    fs.writeFileSync(STAAT, JSON.stringify({ aan: true }), { mode: 0o600 }); delete env.CLOUDFLARE_API_TOKEN;
    u = await h.potDatahubRonde({ vandaag: '2026-10-26' });
    toets('zonder Cloudflare-sleutel: fout zonder netwerk', u.gedaan === false && /Cloudflare/.test(u.fout), u);
    // aanroep in bankRonde staat achter uit.ok en na het POT-afschrift
    const br = src.slice(src.indexOf('async function bankRonde()'), src.indexOf('function bankRondeStart()'));
    toets('bankRonde roept potDatahubRonde aan na potAfschriftRonde, achter uit.ok, met eigen try', br.indexOf('potDatahubRonde()') > br.indexOf('potAfschriftRonde()') && /if \(uit\.ok\) try \{\s*const pd = await potDatahubRonde\(\)/.test(br));
  }
  // ── 5. droog op een kopie van de echte bankluis + echte D1 (alleen machinekamer: POT_DH_DROOG_BANK_DIR) ──
  if (process.env.POT_DH_DROOG_BANK_DIR) {
    const a = A.open(process.env.POT_DH_DROOG_BANK_DIR);
    const ACC = '23df9b0607bb70f6d7f15a63ec843d6d', DB = 'ffcb09ad-fc50-4c83-aa7b-ad6409b44e03';
    const d1 = async (batch) => { const r = await fetch('https://api.cloudflare.com/client/v4/accounts/' + ACC + '/d1/database/' + DB + '/query', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ batch }) }); const j = await r.json(); if (!j.success) throw new Error('d1 ' + r.status); return j.result.map((x) => x.results); };
    const [rek, gr] = await d1([{ sql: P.SQL_LEES_REKENING, params: ['POT'] }, { sql: "SELECT max(boekdatum) AS d FROM bankmutatie WHERE entiteit = ? AND coalesce(bron_bestand, '') <> ?", params: ['POT', P.BRON_BESTAND] }]);
    const inv = A.potDatahubInvoer(a, new Date(Date.parse(gr[0].d + 'T12:00:00Z') - 10 * 864e5).toISOString().slice(0, 10));
    const [rows] = await d1([{ sql: P.SQL_LEES_RIJEN, params: ['POT', P.leesVanaf(inv.posten)] }]);
    const v = P.voorstel({ iban: rek[0].iban, posten: inv.posten, rijen: rows.map(P.rijUitD1), grootboek: {}, vandaag: new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }) });
    console.log('DROOG ' + JSON.stringify(v.telling));
    a.db.close();
  }
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  toets brak af: ' + e.stack); process.exit(1); });
JS
