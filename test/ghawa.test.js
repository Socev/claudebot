'use strict';
// wv2877: OVIS GHAWA rekenkern en routes op VERZONNEN cijfers (nooit de echte overdracht in deze repo; die naspeeltoets staat in mk-scripts).
// Toetst: invoer (csv → ghawa.sqlite), nog open per regel volgens de vijf regels, verrekening per activiteit, oormerken één keer,
// aansluitingen A/D/E/F, dat een gewijzigde uitgave de uitkomst verandert (kruisproef in de toets), dat routes geen donateur of
// tegenrekening teruggeven, en dat een onbekende regel of een uitgave zonder regel de invoer weigert.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../ghawa.js');

const { DONOR, REK, maakFixture, vers } = require('./ghawa-fixture.js');

test('invoer en rekenkern op verzonnen cijfers', () => {
  const { db, n } = vers();
  assert.deepStrictEqual([n.activiteiten, n.regels, n.uitgaven, n.bank_ecg, n.bank_ghawa, n.donateurs], [5, 8, 5, 9, 4, 1]);
  assert.strictEqual(fs.statSync(db).mode & 0o777, 0o600);
  const k = G.bereken(G.leesData(db));
  const r = Object.fromEntries(k.regels.map((x) => [x.id, x]));
  assert.strictEqual(r['1.1'].open, 0);                 // none
  assert.strictEqual(r['1.2'].open, 30000);             // budget - realised: 500 - 200
  assert.strictEqual(r['2.9'].open, 50000);             // activity balance: (2000 + 0) - 1500
  assert.strictEqual(r['3.1'].open, 300000);            // full budget
  assert.strictEqual(r['3.99'].open, -40000);           // offset: niet gespecificeerde opname tegen het budget
  const a = Object.fromEntries(k.activiteiten.map((x) => [x.nr, x]));
  // activiteit 1: begroot 1500, gerealiseerd 1300, open 300 → prognose 1600: overschrijding 100, niet nodig 0 (verrekend, niet per regel)
  assert.deepStrictEqual([a['1'].begroot, a['1'].gerealiseerd, a['1'].open, a['1'].niet_nodig, a['1'].overschrijding], [150000, 130000, 30000, 0, 10000]);
  assert.deepStrictEqual([a['3'].open, a['3'].niet_nodig], [260000, 0]);
  assert.strictEqual(k.bouw.controle, 0);
  assert.strictEqual(k.bouw.begroot, 650000); assert.strictEqual(k.bouw.gerealiseerd, 322000);
  // fasen
  const f = Object.fromEntries(k.fasen.map((x) => [x.id, x]));
  assert.strictEqual(f['Phase 1A'].open, 80000); assert.strictEqual(f['Phase 3'].gerealiseerd, 40000);
  // aansluitingen
  assert.strictEqual(k.aansluiting.A.verschil, 0); assert.strictEqual(k.aansluiting.A.breuken, 0); assert.strictEqual(k.aansluiting.A.instelling_gelijk, true);
  assert.strictEqual(k.aansluiting.D.uitbetaald, 340000);
  assert.strictEqual(k.aansluiting.D.gespecificeerd, 320000);   // GMD (ECG) zonder 15.1: 1100 + 200 + 1500 + 400
  assert.strictEqual(k.aansluiting.D.contant_gmd, 73800);
  assert.strictEqual(k.aansluiting.D.niet_gespecificeerd, 20000 + 73800);
  assert.strictEqual(k.aansluiting.E.verschil, 0); assert.strictEqual(k.aansluiting.E.keten_breuken, 0);
  assert.strictEqual(k.aansluiting.F.verschil, 0);
  assert.deepStrictEqual(k.aansluiting.B.cheques, [{ cheque: '4', opgenomen: 60000, gespecificeerd: 0, niet: 60000 }]);
  assert.strictEqual(k.sluit, true);
  // nog te werven: bouw open 2600+... /80, oormerk bouw 20, ECG 39,75 + 595/80, GHAWA vrij 54 - 5
  const bouwOpen = k.bouw.open / 100 / 80;
  assert.strictEqual(k.werven.nog_te_werven, Math.max(0, Math.round((bouwOpen - 20 - 39.75 - 595 / 80 - 49) * 100) / 100));   // hier genoeg geld: 0, nooit negatief
  assert.strictEqual(k.werven.bouw_na_oormerk, Math.round((bouwOpen - 20) * 100) / 100);
  assert.strictEqual(k.werven.verwacht_vaste_donateurs, 30);
  assert.strictEqual(k.werven.apo_overschot, 0);   // 850/80 = 10,63 open, oormerk 5
});

test('kruisproef: één uitgave anders → andere uitkomst; GHAWA-regel anders → E sluit niet', () => {
  const k1 = G.bereken(G.leesData(vers().db));
  const k2 = G.bereken(G.leesData(vers({ t1: '1101' }).db));
  assert.notStrictEqual(k1.bouw.gerealiseerd, k2.bouw.gerealiseerd);
  assert.strictEqual(k2.aansluiting.D.niet_gespecificeerd, k1.aansluiting.D.niet_gespecificeerd - 100);
  const k2b = G.bereken(G.leesData(vers({ wg1: '1101' }).db));
  assert.strictEqual(k2b.aansluiting.F.verschil, -100);
  assert.strictEqual(k2b.sluit, false);
  const k3 = G.bereken(G.leesData(vers({ g2: '-99' }).db));
  assert.notStrictEqual(k3.aansluiting.E.keten_breuken, 0);
  assert.strictEqual(k3.sluit, false);
});

test('invoer weigert een onbekende regel en een uitgave zonder begrotingsregel', () => {
  assert.throws(() => vers({ regel: 'guess' }), /onbekende still_open_rule/);
  assert.throws(() => vers({ regelT5: '99.9' }), /onbekende regel/);
});

test('routes: alle schermen 200, geen donateur of tegenrekening in een antwoord', () => {
  const { db, map } = vers();
  const bron = path.join(map, 'bronnen'); fs.mkdirSync(path.join(bron, 'csv'), { recursive: true });
  fs.writeFileSync(path.join(bron, 'Overdracht.md'), '# x'); fs.writeFileSync(path.join(bron, 'Financial overview.xlsx'), 'x');
  const app = G.maak({ dbPad: db, bronnenMap: bron, vaultMap: map }).app;
  const paden = ['/app/ghawa', '/app/ghawa/overzicht', '/app/ghawa/bouw', '/app/ghawa/apotheek', '/app/ghawa/geld', '/app/ghawa/vragen', '/app/ghawa/documenten',
    '/app/ghawa/activiteit/1', '/app/ghawa/activiteit/P1', '/app/ghawa/fondsen', '/app/ghawa/ronde'];
  for (const p of paden) {
    const u = app({ pad: p });
    assert.strictEqual(u.status, 200, p);
    const t = JSON.stringify(u.body);
    assert.ok(!t.includes(DONOR) && !t.includes('Pietersen') && !t.includes(REK), 'donateur of rekening in ' + p);
  }
  const o = app({ pad: '/app/ghawa' }).body;
  assert.strictEqual(o.datastand, '2026-07-31'); assert.strictEqual(o.vragen.open, 1); assert.strictEqual(o.sluit, true);
  assert.ok(o.aandacht.some((x) => x.label === 'toezegging'));
  const ak = app({ pad: '/app/ghawa/activiteit/1' }).body;
  assert.strictEqual(ak.regels.find((r) => r.id === '1.1').uitgaven[0].referentie, 'INV1');
  const doc = app({ pad: '/app/ghawa/documenten' }).body;
  assert.strictEqual(doc.stukken.length, 2); assert.strictEqual(doc.stukken.find((s) => /xlsx$/.test(s.naam)).intern, true);
  assert.strictEqual(app({ pad: '/app/ghawa/activiteit/77' }).status, 404);
  // wv2880: donateurs is een INTERNE route (eigen app): wel namen, nooit een rekeningnummer, altijd intern:true
  const dn = app({ pad: '/app/ghawa/donateurs' });
  assert.strictEqual(dn.status, 200); assert.strictEqual(dn.body.intern, true); assert.ok(!JSON.stringify(dn.body).includes(REK));
  assert.strictEqual(app({ pad: '/app/ghawa/../x' }).status, 404);
  assert.strictEqual(G.maak({ dbPad: path.join(map, 'nee.sqlite') }).app({ pad: '/app/ghawa' }).status, 503);
});

test('review wv2877: invoervolgorde wint van het nummer, geen stille uitval, decimaal exact', () => {
  // banknummers B1, B2, B10: tekstvolgorde zou B10 vóór B2 zetten en het verkeerde saldo als laatste nemen
  const map = maakFixture();
  const bank = fs.readFileSync(path.join(map, 'Bank.csv'), 'utf8').replace('B0009,', 'B10,').replace('B0008,', 'B9,');
  fs.writeFileSync(path.join(map, 'Bank.csv'), bank);
  const db = path.join(map, 'g.sqlite'); G.invoer(map, db);
  const k = G.bereken(G.leesData(db));
  assert.strictEqual(k.ecg.gmd.saldo, 59500); assert.strictEqual(k.aansluiting.A.breuken, 0);
  // een echte datarij met een afwijkende sleutel stopt de invoer (een voetnoot met alleen de eerste kolom mag)
  const m2 = maakFixture();
  fs.appendFileSync(path.join(m2, 'Transactions.csv'), 'Footnote text only\nX0099,2025-01-01,Building,,1,,1.1,,stil weg?,,999,GMD (ECG),,,,,,,\n');
  assert.throws(() => G.invoer(m2, path.join(m2, 'g.sqlite')), /ongeldige sleutel/);
  const m4 = maakFixture();   // alleen een bedrag gevuld, sleutel leeg: geen voetnoot
  fs.appendFileSync(path.join(m4, 'Transactions.csv'), ',,,,,,,,,,777,,,,,,,,\n');
  assert.throws(() => G.invoer(m4, path.join(m4, 'g.sqlite')), /ongeldige sleutel/);
  // herinvoer over een databank van een oudere versie (tabel zonder volg) bouwt het schema opnieuw op
  const m5 = maakFixture(), db5 = path.join(m5, 'g.sqlite');
  { const { DatabaseSync } = require('node:sqlite'); const x = new DatabaseSync(db5); x.exec('CREATE TABLE bankregel_ecg (id TEXT PRIMARY KEY, rekening TEXT)'); x.close(); }
  G.invoer(m5, db5); assert.strictEqual(G.bereken(G.leesData(db5)).aansluiting.A.breuken, 0);
  const m3 = maakFixture();
  fs.writeFileSync(path.join(m3, 'Transactions.csv'), fs.readFileSync(path.join(m3, 'Transactions.csv'), 'utf8').replace('txn_id,', 'id,'));
  assert.throws(() => G.invoer(m3, path.join(m3, 'g.sqlite')), /mist kolom txn_id/);
  assert.strictEqual(G.cent('1.005'), 101); assert.strictEqual(G.cent('-0.015'), -2); assert.strictEqual(G.cent('47075.77'), 4707577); assert.throws(() => G.cent('1e3'));
});

test('csv-lezer: aanhalingstekens, komma en regeleinde in een veld', () => {
  assert.deepStrictEqual(G.csvLees('a,b\n"x, ""y""","r1\nr2"\n'), [['a', 'b'], ['x, "y"', 'r1\nr2']]);
  assert.strictEqual(G.cent('2666620.78'), 266662078); assert.strictEqual(G.cent(''), null); assert.throws(() => G.cent('12a'));
});
