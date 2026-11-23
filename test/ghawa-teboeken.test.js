'use strict';
// wv3953 (besluitenpagina nr 901 = L01, David Ja 22-11 18:25): OVIS GHAWA › Te boeken op VERZONNEN cijfers. Elke cheque of
// leveranciersbetaling van de dalasirekening na de overdracht zonder uitgave staat op Te boeken met een voorstel; boeken (bevestigd, delen
// tellen precies op) zet de uitgave bij de regel en "bouw gerealiseerd" stijgt met precies dat bedrag; terugdraaien geeft de oude stand;
// een herinvoer weigert daarna; bon alleen als foto of pdf, nooit los achtergelaten.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const G = require('../ghawa.js');
const B = require('../ghawa-bij.js');
const { vers } = require('./ghawa-fixture.js');

const NU = '2026-11-23T10:00:00.000Z';
function opzet() {
  const { db, map } = vers();
  const x = new DatabaseSync(db); B.migreer(x);
  const zet = x.prepare("INSERT INTO bankregel_ecg (id, rekening, datum, omschrijving, referentie, bedrag_cent, munt, saldo_cent, soort, cheque, begunstigde, bron, volg, herkomst) VALUES (?,'GMD 222',?,?,?,?,'GMD',?,?,?,?,'verzonnen',?,'afschrift')");
  // verzonnen, na de datastand 31-7 van de fixture (saldo 595 GMD): omwisseling "For Roof", cheque 5, leverancier "Roof sheets",
  // cheque 6 met terugboeking, bankkosten
  [['B0010', '2026-08-03', 'B/O PARTNER, IFO PARTNER, For Roof', 'R10', 100000, 159500, 'Conversion in', null, null],
    ['B0011', '2026-08-05', 'CHQ NO - 5 PAID TO SELF', 'R11', -30000, 129500, 'Cheque withdrawal', '5', 'Builder'],
    ['B0012', '2026-08-06', 'B/O PARTNER, IFO SUPPLIER LTD, Roof sheets', 'R12', -50000, 79500, 'Payment to supplier', null, 'Supplier Ltd'],
    ['B0013', '2026-08-07', 'CHQ NO - 6', 'R13', -10000, 69500, 'Cheque withdrawal', '6', 'Builder'],
    ['B0014', '2026-08-07', 'REVERSAL CHQ 6', 'R14', 10000, 79500, 'Reversal', '6', null],
    ['B0015', '2026-08-08', 'CHARGE', 'R15', -500, 79000, 'Bank charge', null, null]].forEach((r, i) => zet.run(...r, 100 + i));
  x.close();
  const bonMap = path.join(map, 'bonnen');
  const m = G.maak({ dbPad: db, bronnenMap: map, vaultMap: map, nu: () => NU, bonMap });
  const k = () => G.bereken(Object.assign(G.leesData(db), { vandaag: NU.slice(0, 10) }));
  const post = (p, b) => m.app({ pad: '/app/ghawa/' + p, methode: 'POST', body: b, door: 'app 12345678' });
  return { db, map, m, k, post, bonMap };
}

test('lijst: alleen cheques en leveranciers na de datastand zonder uitgave; voorstel uit de omschrijving of de omwisseling ervoor', () => {
  const { m, k } = opzet();
  const t = m.app({ pad: '/app/ghawa/teboeken' }).body;
  assert.strictEqual(t.intern, true);
  assert.deepStrictEqual(t.open.map((x) => x.id), ['B0011', 'B0012']);   // niet B0008 (overdracht), B0013 (terugboeking), B0015 (bankkosten)
  const [c5, lev] = t.open;
  assert.strictEqual(c5.soort, 'cheque'); assert.strictEqual(c5.bedrag, 30000); assert.strictEqual(c5.voorstel.regel, '3.1'); assert.match(c5.voorstel.waarom, /omwisseling van 03-08-2026/);
  assert.strictEqual(lev.doel, 'Roof sheets'); assert.strictEqual(lev.voorstel.regel, '3.1'); assert.match(lev.voorstel.waarom, /sheets/);
  assert.strictEqual(k().te_boeken.aantal, 2); assert.strictEqual(k().standen.uitgaven, '2026-07-31');   // bonnen en lijsten: de datastand blijft
  const ov = m.app({ pad: '/app/ghawa' }).body;
  assert.ok(ov.aandacht.some((a) => a.scherm === 'teboeken' && /2 betalingen/.test(a.titel)));
  assert.ok(m.app({ pad: '/app/ghawa/ronde' }).body.stappen.some((s) => s.id === 'boeken' && !s.klaar));
});

test('boeken: bevestigd, precies het bedrag, één keer; bouw gerealiseerd en aansluiting D lopen precies mee; terugdraaien = oude stand', () => {
  const { db, map, k, post, m } = opzet();
  const k0 = k();
  assert.strictEqual(post('boek', { id: 'B0012', delen: [{ regel: '3.1', gmd_cent: 50000 }] }).status, 400);   // niet bevestigd
  assert.strictEqual(post('boek', { id: 'B0012', delen: [{ regel: '3.1', gmd_cent: 49999 }], bevestigd: true }).status, 400);   // telt niet op
  assert.strictEqual(post('boek', { id: 'B0012', delen: [{ regel: '9.9', gmd_cent: 50000 }], bevestigd: true }).status, 400);   // onbekende regel
  assert.strictEqual(post('boek', { id: 'B0012', delen: [{ regel: '3.1', gmd_cent: 25000 }, { regel: '3.1', gmd_cent: 25000 }], bevestigd: true }).status, 400);
  assert.strictEqual(post('boek', { id: 'B0012', delen: [{ regel: '3.1', gmd_cent: 500.5 }], bevestigd: true }).status, 400);
  for (const id of ['B0008', 'B0013', 'B0015']) assert.strictEqual(post('boek', { id, delen: [{ regel: '3.1', gmd_cent: 1 }], bevestigd: true }).status, 409, id);
  const r = post('boek', { id: 'B0012', delen: [{ regel: '3.1', gmd_cent: 50000 }], bevestigd: true });
  assert.strictEqual(r.status, 200); assert.match(r.reden, /POST boek B0012$/); assert.doesNotMatch(r.reden, /Roof|Supplier/);
  assert.strictEqual(post('boek', { id: 'B0012', delen: [{ regel: '3.1', gmd_cent: 50000 }], bevestigd: true }).status, 409);   // dubbel
  const k1 = k();
  assert.strictEqual(k1.bouw.gerealiseerd - k0.bouw.gerealiseerd, 50000);
  assert.strictEqual(k0.aansluiting.D.niet_gespecificeerd - k1.aansluiting.D.niet_gespecificeerd, 50000);
  assert.strictEqual(k1.sluit, k0.sluit);
  // verdeeld over twee regels, met eigen omschrijving
  assert.strictEqual(post('boek', { id: 'B0011', delen: [{ regel: '3.1', gmd_cent: 20000 }, { regel: '2.9', gmd_cent: 10000 }], omschrijving: 'Labour roof, week 32', bevestigd: true }).status, 200);
  const k2 = k();
  assert.strictEqual(k2.bouw.gerealiseerd - k0.bouw.gerealiseerd, 80000);
  assert.strictEqual(k2.te_boeken.aantal, 0);
  const t = m.app({ pad: '/app/ghawa/teboeken' }).body;
  assert.strictEqual(t.open.length, 0);
  const g = t.geboekt.find((x) => x.id === 'B0011');
  assert.deepStrictEqual(g.delen.map((x) => [x.regel, x.gmd]), [['3.1', 20000], ['2.9', 10000]]);
  const x = new DatabaseSync(db);
  const us = x.prepare("SELECT omschrijving, betaald_van, betaalwijze, cheque, bewijs, herkomst FROM uitgave WHERE bankregel = 'B0011' ORDER BY id").all();
  assert.deepStrictEqual(us.map((u) => u.omschrijving), ['Labour roof, week 32 (part 1 of 2)', 'Labour roof, week 32 (part 2 of 2)']);
  assert.ok(us.every((u) => u.betaald_van === 'GMD (ECG)' && u.betaalwijze === 'Cheque (cash withdrawal)' && u.cheque === '5' && u.bewijs === 'Bank statement only' && u.herkomst === 'te-boeken'));
  x.close();
  assert.throws(() => G.invoer(map, db), /bijgehouden regels/);   // geboekte betalingen wist een herinvoer niet zomaar
  // terugdraaien
  assert.strictEqual(post('terug', { id: 'B0012' }).status, 400);
  assert.strictEqual(post('terug', { id: 'B0010', bevestigd: true }).status, 404);
  for (const id of ['B0011', 'B0012']) assert.strictEqual(post('terug', { id, bevestigd: true }).status, 200);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(k())), JSON.parse(JSON.stringify(k0)));
  const y = new DatabaseSync(db);
  assert.deepStrictEqual(y.prepare('SELECT actie, COUNT(*) AS n FROM boeking_log GROUP BY actie ORDER BY actie').all().map((l) => [l.actie, l.n]), [['geboekt', 2], ['teruggedraaid', 2]]);
  y.close();
});

test('bon: alleen foto of pdf (eerste bytes), bij boeken of achteraf; een geweigerde boeking laat geen bon achter', () => {
  const { post, bonMap } = opzet();
  const jpg = Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.alloc(50)]).toString('base64');
  const pdf = Buffer.from('%PDF-1.4\n%verzonnen\n').toString('base64');
  assert.strictEqual(post('bon', { id: 'B0012', bon: { naam: 'bon.jpg', bestand: jpg } }).status, 409);   // eerst boeken
  assert.strictEqual(post('boek', { id: 'B0012', delen: [{ regel: '3.1', gmd_cent: 1 }], bevestigd: true, bon: { naam: 'bon.jpg', bestand: jpg } }).status, 400);   // telt niet op
  assert.ok(!fs.existsSync(bonMap) || fs.readdirSync(bonMap).length === 0);
  assert.strictEqual(post('boek', { id: 'B0012', delen: [{ regel: '3.1', gmd_cent: 50000 }], bevestigd: true, bon: { naam: 'x.exe', bestand: Buffer.from('MZ verzonnen').toString('base64') } }).status, 400);
  const r = post('boek', { id: 'B0012', delen: [{ regel: '3.1', gmd_cent: 50000 }], bevestigd: true, bon: { naam: 'bon.jpg', bestand: jpg } });
  assert.strictEqual(r.status, 200);
  const l = fs.readdirSync(bonMap); assert.strictEqual(l.length, 1); assert.match(l[0], /^B0012-[0-9a-f]{12}\.jpg$/);
  assert.strictEqual(fs.statSync(path.join(bonMap, l[0])).mode & 0o777, 0o600);
  // review MOET 1: dubbel tikken met dezelfde bon → 409, en de bon van de eerste boeking blijft staan
  assert.strictEqual(post('boek', { id: 'B0012', delen: [{ regel: '3.1', gmd_cent: 50000 }], bevestigd: true, bon: { naam: 'bon.jpg', bestand: jpg } }).status, 409);
  assert.ok(fs.existsSync(path.join(bonMap, l[0])));
  assert.strictEqual(post('bon', { id: 'B0012', bon: { naam: 'factuur.pdf', bestand: pdf } }).status, 200);
  assert.strictEqual(post('bon', { id: 'B0012' }).status, 400);
});

test('review ronde 2: een terugboeking die pas na het boeken binnenkomt → fout in Vraagt aandacht en op Te boeken; terugdraaien sluit het', () => {
  const { db, m, post } = opzet();
  assert.strictEqual(post('boek', { id: 'B0011', delen: [{ regel: '3.1', gmd_cent: 30000 }], bevestigd: true }).status, 200);
  const x = new DatabaseSync(db);
  x.prepare("INSERT INTO bankregel_ecg (id, rekening, datum, omschrijving, referentie, bedrag_cent, munt, saldo_cent, soort, cheque, begunstigde, bron, volg, herkomst) VALUES ('B0016','GMD 222','2026-08-09','REVERSAL CHQ 5','R16',30000,'GMD',109000,'Reversal','5',NULL,'verzonnen',200,'afschrift')").run();
  x.close();
  const ov = m.app({ pad: '/app/ghawa' }).body;
  assert.ok(ov.aandacht.some((a) => a.toon === 'fout' && a.label === 'teruggeboekt' && /Cheque 5/.test(a.titel)));
  assert.strictEqual(m.app({ pad: '/app/ghawa/teboeken' }).body.geboekt.find((g) => g.id === 'B0011').teruggeboekt, true);
  assert.strictEqual(post('terug', { id: 'B0011', bevestigd: true }).status, 200);
  assert.ok(!m.app({ pad: '/app/ghawa' }).body.aandacht.some((a) => a.label === 'teruggeboekt'));
  assert.ok(!m.app({ pad: '/app/ghawa/teboeken' }).body.open.some((o) => o.id === 'B0011'));   // met terugboeking hoort hij niet meer op Te boeken
});
