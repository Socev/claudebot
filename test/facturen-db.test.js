'use strict';
// Toetsen voor facturen-db.js (wv824, Facturen-app F1c). Alles in wegwerpmappen onder TMPDIR; synthetische gegevens (test/facturen-zaad.js).
// Raakt /opt/data/facturen, de kluis, mail en de vault niet. Draaien: bash test/facturen-db.sh
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'facturen-db.js'));
const K = require(path.join(ROOT, 'facturen-kern.js'));
const B = require(path.join(ROOT, 'facturen-bank.js'));
const Z = require(path.join(__dirname, 'facturen-zaad.js'));

const WEG = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-db-'));
process.on('exit', () => { try { fs.rmSync(WEG, { recursive: true, force: true }); } catch (e) {} });
let n = 0;
const map = (naam) => path.join(WEG, (naam || 'db') + '-' + (++n));
const modus = (p) => (fs.statSync(p).mode & 0o777).toString(8);
const NU = Date.parse('2026-10-22T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// Kleine basisset: entiteiten tolgaarde, groenhouten, pot, prive; rekeningen; één leverancier; documenten en facturen op verzoek.
function basis(dir) {
  const f = D.open(dir || map());
  D.transactie(f, () => {
    D.voegToe(f, 'entiteit', { sleutel: 'tolgaarde', naam: 'Tolgaarde (proef)', boekhoud_doel: 'boekhouder-tolgaarde@acta.invalid', boekhoud_route: 'exact' });
    D.voegToe(f, 'entiteit', { sleutel: 'groenhouten', naam: 'Groenhouten (proef)', boekhoud_doel: 'boekhouder-groenhouten@acta.invalid', boekhoud_route: 'exact' });
    D.voegToe(f, 'entiteit', { sleutel: 'pot', naam: 'POT (proef)', boekhoud_doel: 'boekhouder-pot@acta.invalid', boekhoud_route: 'exact', afschrift_doel: 'afschrift-pot@acta.invalid' });
    D.voegToe(f, 'entiteit', { sleutel: 'prive', naam: 'Privé' });
    D.voegToe(f, 'rekening', { id: 'aaaaaaaaaaaa0001', entiteit: 'tolgaarde', iban: Z.maakIban('NL', 'TEST', '0000000011'), bank_formaat: 'abn_mt940', controle: 1 });
    D.voegToe(f, 'rekening', { id: 'aaaaaaaaaaaa0002', entiteit: 'pot', iban: Z.maakIban('NL', 'TEST', '0000000015'), bank_formaat: 'bankluis', bankluis_rek: 'proef-pot', controle: 1, alleen_eigenaar: 1 });
    D.voegToe(f, 'rekening', { id: 'aaaaaaaaaaaa0009', entiteit: 'prive', iban: Z.maakIban('NL', 'TEST', '0000000019'), bank_formaat: 'abn_tab', controle: 0, alleen_eigenaar: 1 });
    D.voegToe(f, 'leverancier', { id: 'bbbbbbbbbbbb0001', naam: 'Leverancier A B.V.', genormaliseerd: 'leverancier a', aangemaakt_op: iso(NU) });
  });
  return f;
}
function factuur(f, o) {
  o = o || {};
  const bytes = Buffer.from('%PDF-1.4 synthetisch ' + D.nieuwId());
  const s = D.stukSchrijf(f, bytes);
  const doc = D.nieuwId(), id = o.id || D.nieuwId();
  D.voegToe(f, 'document', { id: doc, sha256: s.sha256, soort: 'pdf', aangemaakt_op: iso(NU) });
  const bevestigd = o.status && !['te_beoordelen', 'geen_factuur', 'dubbel'].includes(o.status);
  D.voegToe(f, 'factuur', Object.assign({ id, document: doc, leverancier: 'bbbbbbbbbbbb0001', nummer: 'P-' + id.slice(0, 6), incl: 12100, excl: 10000, btw: 2100,
    betaalwijze: 'zelf', entiteit: 'tolgaarde', status: 'te_beoordelen', aangemaakt_op: iso(NU), bijgewerkt_op: iso(NU) },
    bevestigd ? { betaalspoor: 'te_betalen', bevestigd_door: 'toets', bevestigd_op: iso(NU) } : {}, o));
  return { id, doc, sha256: s.sha256 };
}
// Opdracht zoals F2 hem bij Bevestigen maakt (vingerafdruk uit de kern); entiteit/doel standaard die van de factuur.
function opdracht(f, fac, o) {
  o = o || {};
  const r = f.db.prepare('SELECT f.entiteit, e.boekhoud_doel FROM factuur f LEFT JOIN entiteit e ON e.sleutel = f.entiteit WHERE f.id = ?').get(fac.id);
  const id = o.id || D.nieuwId(), entiteit = o.entiteit || r.entiteit, doel = o.doeladres || r.boekhoud_doel || 'iemand@ergens.invalid';
  const bijlagen = [{ naam: 'f.pdf', mime: 'application/pdf', sha256: fac.sha256 }];
  const vf = K.vingerafdruk({ id, soort: 'boekhouder_factuur', doeladres: doel, regel: { factuur_id: fac.id, entiteit: entiteit === 'prive' ? 'x' : entiteit, bedrag_centen: 12100, doeladres: doel }, bijlagen });
  D.voegToe(f, 'opdracht', Object.assign({ id, soort: 'boekhouder_factuur', factuur: fac.id, entiteit, doeladres: doel, bijlagen, vingerafdruk: vf,
    verstuur_na: iso(NU - 60000), idempotentiesleutel: fac.id + ':' + id, status: 'wacht', aangemaakt_door: 'toets', aangemaakt_op: iso(NU), bijgewerkt_op: iso(NU) }, o.extra || {}));
  return id;
}
// In de wachtrij zetten zoals Bevestigen dat doet (één transactie).
function inWachtrij(f, o) {
  return D.transactie(f, () => {
    const fac = factuur(f, Object.assign({ status: 'in_wachtrij' }, o || {}));
    fac.opdracht = opdracht(f, fac);
    return fac;
  });
}
const gooit = (fn, re, uitleg) => assert.throws(fn, (e) => re.test(String(e && (e.message || e))), uitleg);

// ───────────────────────────── migraties ─────────────────────────────

test('migraties: nieuw → alle versies; opnieuw openen past niets toe en verandert niets', () => {
  const dir = map();
  const f1 = D.open(dir);
  assert.equal(f1.schema, D.SCHEMA_VERSIE);
  assert.deepEqual(f1.toegepast, D.MIGRATIES.map((m) => m.versie));
  const schema1 = f1.db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
  D.sluit(f1);
  const f2 = D.open(dir);
  assert.deepEqual(f2.toegepast, []);
  assert.equal(f2.schema, D.SCHEMA_VERSIE);
  assert.deepEqual(f2.db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(), schema1);
  assert.equal(f2.db.prepare('SELECT count(*) AS n FROM schema_migratie').get().n, D.MIGRATIES.length);
  assert.equal(D.metaLees(f2, 'verzendmodus'), 'concept');
  // migreer() rechtstreeks nog eens: idempotent
  assert.deepEqual(D.migreer(f2.db).toegepast, []);
  D.sluit(f2);
});

test('migraties: acht processen die tegelijk een lege database openen, botsen niet', async () => {
  const dir = map();
  const code = "const D=require(" + JSON.stringify(path.join(ROOT, 'facturen-db.js')) + ");const f=D.open(process.argv[1]);process.stdout.write(String(f.schema));";
  const uit = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => new Promise((res) => {
    const p = spawn(process.execPath, ['--no-warnings', '-e', code, dir]);
    let o = '', e = '';
    p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { e += d; });
    p.on('close', (c) => res({ c, o, e }));
  })));
  for (const u of uit) assert.equal(u.c, 0, u.e);
  for (const u of uit) assert.equal(u.o, String(D.SCHEMA_VERSIE));
  const f = D.open(dir);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM schema_migratie').get().n, D.MIGRATIES.length);
  D.sluit(f);
});

test('migraties: een database met een nieuwer schema wordt geweigerd (terugrollen schrijft niet met oude code)', () => {
  const dir = map();
  const f = D.open(dir);
  f.db.prepare("INSERT INTO schema_migratie (versie, naam, toegepast_op) VALUES (99, 'toekomst', 'x')").run();
  D.sluit(f);
  gooit(() => D.open(dir), /schema 99/);
});

test('bevroren lijsten in het schema = lijsten van de kern en de bankmodule', () => {
  assert.deepEqual(D.LIJSTEN.status, K.STATUSSEN);
  assert.deepEqual(D.LIJSTEN.betaalspoor, K.BETAALSPOREN);
  assert.deepEqual(D.LIJSTEN.opdrachtStatus, K.OPDRACHT_STATUSSEN);
  assert.deepEqual(D.LIJSTEN.besluitBron, K.BESLUIT_BRONNEN);
  assert.deepEqual(D.LIJSTEN.formaat, B.FORMATEN);
  assert.deepEqual(D.LIJSTEN.categorie, B.CATEGORIEEN);
  assert.deepEqual(D.LIJSTEN.signaal, B.SIGNAAL_SOORTEN);
});

test('rechten: map 700, database (+ wal/shm) 600, stukken en back-up 700, stuk 600', () => {
  const f = basis();
  assert.equal(modus(f.dir), '700');
  assert.equal(modus(f.pad), '600');
  for (const s of ['-wal', '-shm']) if (fs.existsSync(f.pad + s)) assert.equal(modus(f.pad + s), '600', s);
  assert.equal(modus(f.stukken), '700');
  assert.equal(modus(f.backup), '700');
  const s = D.stukSchrijf(f, Buffer.from('rechten'));
  assert.equal(modus(D.stukPad(f, s.sha256)), '600');
  assert.equal(modus(path.dirname(D.stukPad(f, s.sha256))), '700');
  assert.equal(f.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(f.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  D.sluit(f);
});

test('geen kolom voor factuur- of mailtekst', () => {
  const f = D.open(map());
  for (const t of D.TABELLEN) {
    const k = f.db.prepare('PRAGMA table_info(' + t + ')').all().map((x) => x.name);
    for (const naam of k) {
      if (t === 'tekstanker' && naam === 'tekst') continue;   // het anker zelf (een kort woord), geen factuurtekst
      assert.ok(!/^(tekst|inhoud|body|mailtekst|pdftekst|ruwe_tekst|tekstinhoud)$/.test(naam), t + '.' + naam);
    }
  }
  D.sluit(f);
});

// wv1299: migratie 5 verruimt de CHECKs van bank en formaat (Triodos) via writable_schema. Een database op schema 4 met regels erin.
function dbOpSchema4(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, D.BESTAND));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;');
  db.exec('CREATE TABLE schema_migratie (versie INTEGER PRIMARY KEY, naam TEXT NOT NULL, toegepast_op TEXT NOT NULL)');
  for (const m of D.MIGRATIES.filter((x) => x.versie <= 4)) {
    db.exec('BEGIN'); db.exec(m.sql);
    db.prepare('INSERT INTO schema_migratie VALUES (?, ?, ?)').run(m.versie, m.naam, iso(NU)); db.exec('COMMIT');
  }
  db.exec("INSERT INTO entiteit (sleutel, naam) VALUES ('kostenmaatschap', 'KM (proef)'), ('sel', 'SEL (proef)')");
  db.prepare("INSERT INTO rekening (id, entiteit, iban, bank, bank_formaat, controle) VALUES ('aaaaaaaaaaaa0016', 'kostenmaatschap', ?, 'ING', 'ing_csv', 1)").run(Z.maakIban('NL', 'TEST', '0000000016'));
  db.prepare("INSERT INTO bank_bestand (id, sha256, formaat, geupload_door, geupload_op, bank, modus) VALUES ('ffffffffffff0016', ?, 'ing_csv', 'toets', ?, 'ING', 'historisch')").run('e'.repeat(64), iso(NU));
  db.prepare("INSERT INTO bank_transactie (id, bestand, rekening, entiteit, eigen_iban, boekdatum, bedrag_centen, entry_ref, formaat, aangemaakt_op) VALUES ('cccccccccccc0016', 'ffffffffffff0016', 'aaaaaaaaaaaa0016', 'kostenmaatschap', ?, '2020-01-02', -100, 'r-oud', 'ing_csv', ?)").run(Z.maakIban('NL', 'TEST', '0000000016'), iso(NU));
  return db;
}
const tabelSql = (db) => Object.fromEntries(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('rekening','bank_bestand','bank_transactie') ORDER BY name").all().map((x) => [x.name, x.sql]));

test('migratie 5 (wv1299): schema 4 → 5 verruimt bank/formaat met TRIODOS/triodos_csv; regels blijven, onzin blijft geweigerd, schema = nieuw aangemaakt', () => {
  const dir = map('m5');
  dbOpSchema4(dir).close();
  const f = D.open(dir);
  assert.deepEqual(f.toegepast, [5, 6, 7]);
  assert.equal(f.schema, D.SCHEMA_VERSIE);
  assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM bank_transactie WHERE entry_ref = 'r-oud'").get().n, 1);
  const tri = Z.maakIban('NL', 'TRIO', '0000000041');
  D.transactie(f, () => {
    D.voegToe(f, 'rekening', { id: 'aaaaaaaaaaaa0041', entiteit: 'sel', iban: tri, bank: 'TRIODOS', bank_formaat: 'triodos_csv', controle: 1 });
    D.voegToe(f, 'bank_bestand', { id: 'ffffffffffff0041', sha256: 'd'.repeat(64), formaat: 'triodos_csv', bank: 'TRIODOS', modus: 'historisch', geupload_door: 'toets', geupload_op: iso(NU) });
    D.voegToe(f, 'bank_transactie', { id: 'cccccccccccc0041', bestand: 'ffffffffffff0041', rekening: 'aaaaaaaaaaaa0041', entiteit: 'sel', eigen_iban: tri, boekdatum: '2017-05-01',
      bedrag_centen: 100, entry_ref: 'r-tri', formaat: 'triodos_csv', aangemaakt_op: iso(NU) });
  });
  gooit(() => D.voegToe(f, 'rekening', { id: 'aaaaaaaaaaaa0042', entiteit: 'sel', iban: Z.maakIban('NL', 'TRIO', '0000000042'), bank: 'Triodos', bank_formaat: 'triodos_csv', controle: 1 }), /CHECK/);
  gooit(() => D.voegToe(f, 'rekening', { id: 'aaaaaaaaaaaa0043', entiteit: 'sel', iban: Z.maakIban('NL', 'TRIO', '0000000043'), bank: 'TRIODOS', bank_formaat: 'triodos', controle: 1 }), /CHECK/);
  gooit(() => D.voegToe(f, 'bank_bestand', { id: 'ffffffffffff0042', sha256: 'c'.repeat(64), formaat: 'bankluis', geupload_door: 'toets', geupload_op: iso(NU) }), /CHECK/);
  gooit(() => f.db.prepare("UPDATE bank_transactie SET formaat = 'onzin' WHERE id = 'cccccccccccc0041'").run(), /CHECK/);
  // de bestaande triggers werken nog (Privé, entiteit)
  gooit(() => D.voegToe(f, 'bank_transactie', { id: 'cccccccccccc0042', bestand: 'ffffffffffff0041', rekening: 'aaaaaaaaaaaa0041', entiteit: 'kostenmaatschap', eigen_iban: tri,
    boekdatum: '2017-05-02', bedrag_centen: 1, entry_ref: 'r-tri-2', formaat: 'triodos_csv', aangemaakt_op: iso(NU) }), /transactie_entiteit/);
  const gemigreerd = tabelSql(f.db);
  D.sluit(f);
  const nieuw = D.open(map('m5-nieuw'));
  assert.deepEqual(tabelSql(nieuw.db), gemigreerd);
  for (const sql of Object.values(gemigreerd)) assert.ok(sql.includes('triodos_csv'), sql.slice(0, 60));
  D.sluit(nieuw);
  // opnieuw openen: niets meer toe te passen
  const f2 = D.open(dir); assert.deepEqual(f2.toegepast, []); D.sluit(f2);
});

test('migratie 5 (wv1299): past de CHECK-tekst niet precies één keer, dan weigeren en volledig terugrollen (schema blijft 4)', () => {
  const dir = map('m5-mis');
  const db = dbOpSchema4(dir);
  // simuleer een afwijkend schema: de bank-CHECK van rekening staat er anders
  const v = db.prepare('PRAGMA schema_version').get().schema_version;
  db.exec('PRAGMA writable_schema = ON');
  db.prepare("UPDATE sqlite_master SET sql = replace(sql, ?, ?) WHERE type = 'table' AND name = 'rekening'").run("bank IN ('ABN','ING')", "bank IN ('ING','ABN')");
  db.exec('PRAGMA schema_version = ' + (v + 1)); db.exec('PRAGMA writable_schema = OFF');
  db.close();
  const { DatabaseSync } = require('node:sqlite');
  const lees = () => { const d = new DatabaseSync(path.join(dir, D.BESTAND), { readOnly: true }); try { return tabelSql(d); } finally { d.close(); } };
  const voor = lees();
  gooit(() => D.open(dir), /migratie_5|staat er 0 keer/);
  assert.deepEqual(lees(), voor);
  const r = D.open(dir, { alleenLezen: true }); assert.equal(r.schema, 4); D.sluit(r);
});

test('migratie 5 (wv1299): een fout ná het bijwerken van sqlite_master rolt volledig terug; daarna migreert de volgende open gewoon', () => {
  const dir = map('m5-na');
  const db = dbOpSchema4(dir);
  const voor = tabelSql(db);
  // de eerste vervanging klopt, de tweede maakt de CHECK kapot (haakje weg): pas na writable_schema merkt SQLite het
  const kapot = [D.M5_VERVANG[0], ['bank_bestand', "bank IN ('ABN','ING')", "bank IN ('ABN','ING','TRIODOS'"]];
  db.exec('BEGIN IMMEDIATE');
  gooit(() => D._M5(db, kapot), /malformed|syntax|migratie_5|incomplete/i);
  db.exec('ROLLBACK');
  assert.deepEqual(tabelSql(db), voor);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
  const f = D.open(dir); assert.deepEqual(f.toegepast, [5, 6, 7]); assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); D.sluit(f);
});

test('migratie 5 (wv1299): al verruimd maar de rij in schema_migratie ontbreekt (lichte terugrol) → opnieuw toepassen verandert niets', () => {
  const dir = map('m5-weer');
  const f = D.open(dir);
  const na = tabelSql(f.db);
  f.db.exec('DELETE FROM schema_migratie WHERE versie = 5');
  D.sluit(f);
  const r = D.open(dir, { alleenLezen: true }); assert.equal(r.schema, D.SCHEMA_VERSIE);   // max(versie): de laatste staat er nog D.sluit(r);
  const f2 = D.open(dir);
  assert.deepEqual(f2.toegepast, [5]);
  assert.deepEqual(tabelSql(f2.db), na);
  D.sluit(f2);
});

test("migratie 6 (wv1317): voorstel krijgt status 'vervallen' (met afgehandeld_door/op), onzin blijft geweigerd; schema 4 → 6 = nieuw aangemaakt", () => {
  const voorstelSql = (db) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'voorstel'").get().sql;
  const dir = map('m6');
  dbOpSchema4(dir).close();
  const f = D.open(dir);
  assert.equal(f.schema, D.SCHEMA_VERSIE);
  assert.ok(voorstelSql(f.db).includes("'vervallen'"));
  assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const tx = f.db.prepare('SELECT id FROM bank_transactie LIMIT 1').get();
  assert.ok(tx, 'schema-4-helper heeft een bankregel');
  const zet = (sleutel, status, door) => f.db.prepare("INSERT INTO voorstel (sleutel, transactie, facturen, status, aangemaakt_op, afgehandeld_door, afgehandeld_op) VALUES (?, ?, '[]', ?, ?, ?, ?)")
    .run(sleutel, tx.id, status, iso(NU), door, door ? iso(NU) : null);
  zet('v1', 'vervallen', 'bankcontrole');
  gooit(() => zet('v2', 'vervallen', null), /CHECK/);
  gooit(() => zet('v3', 'weg', 'bankcontrole'), /CHECK/);
  const gemigreerd = voorstelSql(f.db);
  D.sluit(f);
  const nieuw = D.open(map('m6-nieuw'));
  assert.equal(voorstelSql(nieuw.db), gemigreerd);
  D.sluit(nieuw);
  const f2 = D.open(dir); assert.deepEqual(f2.toegepast, []); D.sluit(f2);
});

test('migratie 6 (wv1317): afwijkende CHECK-tekst → weigeren en volledig terugrollen; al verruimd zonder rij → opnieuw toepassen verandert niets', () => {
  const dir = map('m6-mis');
  const f = D.open(dir);
  f.db.exec('DELETE FROM schema_migratie WHERE versie = 6');
  const v = f.db.prepare('PRAGMA schema_version').get().schema_version;
  f.db.exec('PRAGMA writable_schema = ON');
  f.db.prepare("UPDATE sqlite_master SET sql = replace(sql, ?, ?) WHERE type = 'table' AND name = 'voorstel'").run("status IN ('open','bevestigd','afgewezen','vervallen')", "status IN ('open','afgewezen','bevestigd')");
  f.db.exec('PRAGMA schema_version = ' + (v + 1)); f.db.exec('PRAGMA writable_schema = OFF');
  D.sluit(f);
  gooit(() => D.open(dir), /migratie_6|staat er 0 keer/);
  const r = D.open(dir, { alleenLezen: true }); assert.equal(r.schema, D.SCHEMA_VERSIE); D.sluit(r);   // max(versie): 7 staat er nog
  const dir2 = map('m6-weer');
  const g = D.open(dir2);
  const na = g.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'voorstel'").get().sql;
  g.db.exec('DELETE FROM schema_migratie WHERE versie = 6');
  D.sluit(g);
  const g2 = D.open(dir2);
  assert.deepEqual(g2.toegepast, [6]);
  assert.equal(g2.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'voorstel'").get().sql, na);
  D.sluit(g2);
});

// ───────────────────────────── Privé nooit naar de boekhouder ─────────────────────────────

test('Privé: entiteit prive heeft nooit een boekhoud- of afschriftadres (CHECK, insert en update)', () => {
  const f = D.open(map());
  gooit(() => D.voegToe(f, 'entiteit', { sleutel: 'prive', naam: 'Privé', boekhoud_doel: 'x@y.invalid' }), /CHECK/);
  gooit(() => D.voegToe(f, 'entiteit', { sleutel: 'prive', naam: 'Privé', afschrift_doel: 'x@y.invalid' }), /CHECK/);
  gooit(() => D.voegToe(f, 'entiteit', { sleutel: 'prive', naam: 'Privé', boekhoud_route: 'mail' }), /CHECK/);
  D.voegToe(f, 'entiteit', { sleutel: 'prive', naam: 'Privé' });
  gooit(() => f.db.prepare("UPDATE entiteit SET boekhoud_doel = 'x@y.invalid' WHERE sleutel = 'prive'").run(), /CHECK/);
  gooit(() => f.db.prepare("UPDATE entiteit SET afschrift_doel = 'x@y.invalid' WHERE sleutel = 'prive'").run(), /CHECK/);
  D.sluit(f);
  // een andere entiteit met een adres hernoemen naar prive kan ook niet
  const g = D.open(map());
  D.voegToe(g, 'entiteit', { sleutel: 'tolgaarde', naam: 'T', boekhoud_doel: 'b@acta.invalid' });
  gooit(() => g.db.prepare("UPDATE entiteit SET sleutel = 'prive' WHERE sleutel = 'tolgaarde'").run(), /CHECK/);
  D.sluit(g);
});

test('Privé: een opdracht voor prive is onmogelijk — insert, langs elke weg', () => {
  const f = basis();
  const p = factuur(f, { entiteit: 'prive' });
  // (1) rechtstreeks met entiteit prive (CHECK op de kolom; prive heeft ook geen adres)
  gooit(() => opdracht(f, p, { entiteit: 'prive', doeladres: 'iemand@ergens.invalid' }), /CHECK|opdracht_prive/);
  // (2) met een andere entiteit voor een privéfactuur (trigger: moet gelijk zijn aan de factuur)
  gooit(() => opdracht(f, p, { entiteit: 'tolgaarde', doeladres: 'boekhouder-tolgaarde@acta.invalid' }), /opdracht_entiteit/);
  // (3) privéfactuur in de wachtrij zetten (CHECK op de factuur)
  gooit(() => factuur(f, { entiteit: 'prive', status: 'in_wachtrij' }), /CHECK/);
  gooit(() => factuur(f, { entiteit: null, status: 'in_wachtrij' }), /CHECK/);
  // (4) een privé-afschrift kan niet bestaan (dus ook geen afschriftopdracht)
  const s = D.stukSchrijf(f, Buffer.from('mt940 proef'));
  D.voegToe(f, 'document', { id: 'cccccccccccc0001', sha256: s.sha256, soort: 'mt940', aangemaakt_op: iso(NU) });
  gooit(() => D.voegToe(f, 'pot_afschrift', { id: 'dddddddddddd0001', rekening: 'aaaaaaaaaaaa0009', periode: '2026-09', aangemaakt_op: iso(NU), bijgewerkt_op: iso(NU) }), /afschrift_prive/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM opdracht').get().n, 0);
  D.sluit(f);
});

test('Privé: een opdracht voor prive is onmogelijk — update, langs elke weg', () => {
  const f = basis();
  const t = inWachtrij(f);
  // (1) opdracht.entiteit naar prive (CHECK + onveranderlijk)
  gooit(() => f.db.prepare("UPDATE opdracht SET entiteit = 'prive' WHERE id = ?").run(t.opdracht), /CHECK|onveranderlijk/);
  // (2) factuur.entiteit naar prive terwijl de opdracht wacht (trigger + CHECK op de status)
  gooit(() => f.db.prepare("UPDATE factuur SET entiteit = 'prive' WHERE id = ?").run(t.id), /factuur_entiteit|CHECK/);
  // (3) ook samen met een statuswissel naar te_beoordelen in één UPDATE: de levende opdracht houdt het tegen
  gooit(() => f.db.prepare("UPDATE factuur SET entiteit = 'prive', status = 'te_beoordelen' WHERE id = ?").run(t.id), /factuur_entiteit/);
  // (4) opdracht omhangen naar een privéfactuur
  const p = factuur(f, { entiteit: 'prive' });
  gooit(() => f.db.prepare('UPDATE opdracht SET factuur = ? WHERE id = ?').run(p.id, t.opdracht), /onveranderlijk/);
  // (5) privéfactuur naar een status onderweg (CHECK)
  for (const st of ['in_wachtrij', 'wordt_verstuurd', 'concept_klaar', 'verstuurd', 'verzending_mislukt']) {
    gooit(() => f.db.prepare("UPDATE factuur SET status = ?, betaalspoor = 'te_betalen', bevestigd_door = 'x', bevestigd_op = 'x' WHERE id = ?").run(st, p.id), /CHECK/, st);
  }
  // (6) de rekening van een POT-afschrift met een levende opdracht naar prive verhangen
  const s1 = D.stukSchrijf(f, Buffer.from('mt940')), s2 = D.stukSchrijf(f, Buffer.from('pdf'));
  D.voegToe(f, 'document', { id: 'cccccccccccc0001', sha256: s1.sha256, soort: 'mt940', aangemaakt_op: iso(NU) });
  D.voegToe(f, 'document', { id: 'cccccccccccc0002', sha256: s2.sha256, soort: 'pdf', aangemaakt_op: iso(NU) });
  D.voegToe(f, 'pot_afschrift', { id: 'dddddddddddd0001', rekening: 'aaaaaaaaaaaa0002', periode: '2026-09', mt940_document: 'cccccccccccc0001', pdf_document: 'cccccccccccc0002', status: 'in_wachtrij', aangemaakt_op: iso(NU), bijgewerkt_op: iso(NU) });
  const bijl = [{ sha256: s1.sha256 }, { sha256: s2.sha256 }];
  D.voegToe(f, 'opdracht', { id: 'eeeeeeeeeeee0001', soort: 'boekhouder_afschrift', afschrift: 'dddddddddddd0001', entiteit: 'pot', doeladres: 'afschrift-pot@acta.invalid', bijlagen: bijl,
    vingerafdruk: K.vingerafdruk({ id: 'eeeeeeeeeeee0001', soort: 'boekhouder_afschrift', doeladres: 'afschrift-pot@acta.invalid', regel: { afschrift_id: 'dddddddddddd0001', entiteit: 'pot', periode: '2026-09', doeladres: 'afschrift-pot@acta.invalid' }, bijlagen: bijl }),
    verstuur_na: iso(NU), idempotentiesleutel: 'af:1', aangemaakt_door: 'toets', aangemaakt_op: iso(NU), bijgewerkt_op: iso(NU) });
  gooit(() => f.db.prepare("UPDATE pot_afschrift SET rekening = 'aaaaaaaaaaaa0009' WHERE id = 'dddddddddddd0001'").run(), /afschrift_rekening|afschrift_prive/);
  gooit(() => f.db.prepare("UPDATE rekening SET entiteit = 'prive', controle = 0 WHERE id = 'aaaaaaaaaaaa0002'").run(), /rekening_entiteit/);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM opdracht WHERE entiteit = 'prive'").get().n, 0);
  D.sluit(f);
});

test('Privé: bankregels van een rekening zonder controle worden nooit opgeslagen; POT blijft eigenaar-only', () => {
  const f = basis();
  const tx = (rek, ent, o) => D.voegToe(f, 'bank_transactie', Object.assign({ id: D.nieuwId(), rekening: rek, entiteit: ent, eigen_iban: Z.maakIban('NL', 'TEST', '0000000011'),
    boekdatum: '2026-10-01', bedrag_centen: -100, entry_ref: 'r-' + D.nieuwId(), formaat: 'abn_tab', bestand: null, aangemaakt_op: iso(NU) }, o || {}));
  gooit(() => tx('aaaaaaaaaaaa0009', 'prive', { formaat: 'bankluis', bankluis_sleutel: 'x' }), /CHECK|transactie_prive/);
  gooit(() => tx('aaaaaaaaaaaa0002', 'pot', { formaat: 'bankluis', bankluis_sleutel: 'x', alleen_eigenaar: 0 }), /transactie_eigenaar/);
  gooit(() => tx('aaaaaaaaaaaa0002', 'tolgaarde', { formaat: 'bankluis', bankluis_sleutel: 'x', alleen_eigenaar: 1 }), /transactie_entiteit/);
  tx('aaaaaaaaaaaa0002', 'pot', { formaat: 'bankluis', bankluis_sleutel: 'x', alleen_eigenaar: 1 });
  gooit(() => f.db.prepare("UPDATE bank_transactie SET alleen_eigenaar = 0 WHERE rekening = 'aaaaaaaaaaaa0002'").run(), /transactie_eigenaar/);
  // privérekening: altijd controle 0 en alleen eigenaar
  gooit(() => f.db.prepare("UPDATE rekening SET controle = 1 WHERE id = 'aaaaaaaaaaaa0009'").run(), /rekening_prive/);
  gooit(() => D.voegToe(f, 'rekening', { id: 'aaaaaaaaaaaa0010', entiteit: 'prive', iban: Z.maakIban('NL', 'TEST', '0000000020'), bank_formaat: 'abn_tab', controle: 1, alleen_eigenaar: 1 }), /rekening_prive/);
  D.sluit(f);
});

test('Privé: een praktijkmanager kan niet aan Privé gekoppeld worden', () => {
  const f = basis();
  D.voegToe(f, 'gebruiker', { id: '1111111111111111', ingang: 'fac', rol: 'praktijkmanager', email: 'pm@voorbeeld.invalid' });
  D.voegToe(f, 'gebruiker', { id: '2222222222222222', ingang: 'app', rol: 'eigenaar' });
  gooit(() => D.voegToe(f, 'gebruiker_entiteit', { gebruiker: '1111111111111111', entiteit: 'prive' }), /gebruiker_prive/);
  D.voegToe(f, 'gebruiker_entiteit', { gebruiker: '2222222222222222', entiteit: 'prive' });
  gooit(() => f.db.prepare("UPDATE gebruiker SET rol = 'praktijkmanager' WHERE id = '2222222222222222'").run(), /gebruiker_prive/);
  D.sluit(f);
});

// ───────────────────────────── trigger: opdracht.entiteit = factuur/afschrift ─────────────────────────────

test('trigger: opdracht.entiteit en doeladres volgen de factuur en de entiteitentabel (insert)', () => {
  const f = basis();
  const t = factuur(f, { status: 'in_wachtrij' });
  gooit(() => opdracht(f, t, { entiteit: 'groenhouten', doeladres: 'boekhouder-groenhouten@acta.invalid' }), /opdracht_entiteit/);
  gooit(() => opdracht(f, t, { doeladres: 'boekhouder-groenhouten@acta.invalid' }), /opdracht_doeladres/);
  gooit(() => opdracht(f, t, { doeladres: 'iemand@buiten.invalid' }), /opdracht_doeladres/);
  const g = factuur(f, { status: 'te_beoordelen', entiteit: null });
  gooit(() => opdracht(f, g, { entiteit: 'tolgaarde', doeladres: 'boekhouder-tolgaarde@acta.invalid' }), /opdracht_entiteit/);
  opdracht(f, t);
  // afschrift: entiteit moet die van de rekening zijn, doel het afschriftadres
  const s1 = D.stukSchrijf(f, Buffer.from('mt')), s2 = D.stukSchrijf(f, Buffer.from('pd'));
  D.voegToe(f, 'document', { id: 'cccccccccccc0001', sha256: s1.sha256, soort: 'mt940', aangemaakt_op: iso(NU) });
  D.voegToe(f, 'document', { id: 'cccccccccccc0002', sha256: s2.sha256, soort: 'pdf', aangemaakt_op: iso(NU) });
  D.voegToe(f, 'pot_afschrift', { id: 'dddddddddddd0001', rekening: 'aaaaaaaaaaaa0002', periode: '2026-09', mt940_document: 'cccccccccccc0001', pdf_document: 'cccccccccccc0002', status: 'klaar', aangemaakt_op: iso(NU), bijgewerkt_op: iso(NU) });
  const af = (ent, doel) => D.voegToe(f, 'opdracht', { id: D.nieuwId(), soort: 'boekhouder_afschrift', afschrift: 'dddddddddddd0001', entiteit: ent, doeladres: doel, bijlagen: [s1.sha256, s2.sha256],
    vingerafdruk: 'a'.repeat(64), verstuur_na: iso(NU), idempotentiesleutel: 'af:' + D.nieuwId(), aangemaakt_door: 'toets', aangemaakt_op: iso(NU), bijgewerkt_op: iso(NU) });
  gooit(() => af('tolgaarde', 'boekhouder-tolgaarde@acta.invalid'), /opdracht_entiteit/);
  gooit(() => af('pot', 'boekhouder-pot@acta.invalid'), /opdracht_doeladres/);
  af('pot', 'afschrift-pot@acta.invalid');
  // soort en koppeling moeten kloppen
  gooit(() => D.voegToe(f, 'opdracht', { id: D.nieuwId(), soort: 'boekhouder_factuur', factuur: t.id, afschrift: 'dddddddddddd0001', entiteit: 'tolgaarde', doeladres: 'boekhouder-tolgaarde@acta.invalid',
    bijlagen: [t.sha256], vingerafdruk: 'a'.repeat(64), verstuur_na: iso(NU), idempotentiesleutel: 'x:' + D.nieuwId(), aangemaakt_door: 't', aangemaakt_op: iso(NU), bijgewerkt_op: iso(NU) }), /CHECK/);
  D.sluit(f);
});

test('trigger: na het aanmaken blijft de opdracht gelijk aan de factuur (update van opdracht, factuur en rekening)', () => {
  const f = basis();
  const t = inWachtrij(f);
  for (const [kol, w] of [['entiteit', 'groenhouten'], ['doeladres', 'boekhouder-groenhouten@acta.invalid'], ['bijlagen', '["' + 'b'.repeat(64) + '"]'],
    ['vingerafdruk', 'c'.repeat(64)], ['idempotentiesleutel', 'ander'], ['soort', 'boekhouder_afschrift']]) {
    gooit(() => f.db.prepare('UPDATE opdracht SET ' + kol + ' = ? WHERE id = ?').run(w, t.opdracht), /onveranderlijk|CHECK/, kol);
  }
  gooit(() => f.db.prepare("UPDATE factuur SET entiteit = 'groenhouten' WHERE id = ?").run(t.id), /factuur_entiteit/);
  // status/poging/resultaat mogen wel (dat is de levensloop)
  f.db.prepare("UPDATE opdracht SET fout = 'proef', bijgewerkt_op = 'x' WHERE id = ?").run(t.opdracht);
  // na terugdraaien mag de factuur van entiteit wisselen, en een nieuwe opdracht volgt de nieuwe entiteit
  assert.equal(D.terugdraaien(f, t.id, { wie: 'toets' }).ok, true);
  f.db.prepare("UPDATE factuur SET entiteit = 'groenhouten' WHERE id = ?").run(t.id);
  gooit(() => opdracht(f, t, { entiteit: 'tolgaarde', doeladres: 'boekhouder-tolgaarde@acta.invalid' }), /opdracht_entiteit/);
  opdracht(f, t);
  D.sluit(f);
});

test('hooguit één levende opdracht per factuur; een verstuurde krijgt er nooit een tweede', () => {
  const f = basis();
  const t = inWachtrij(f);
  gooit(() => opdracht(f, t), /UNIQUE/);
  f.db.prepare("UPDATE opdracht SET status = 'opgehaald', opgehaald_op = 'x', poging = 1 WHERE id = ?").run(t.opdracht);
  gooit(() => opdracht(f, t), /UNIQUE/);
  f.db.prepare("UPDATE opdracht SET status = 'gelukt' WHERE id = ?").run(t.opdracht);
  gooit(() => opdracht(f, t), /UNIQUE/);
  // mislukt na drie pogingen is dood: "Opnieuw proberen" mag een nieuwe maken; geweigerd ook
  const u = inWachtrij(f);
  f.db.prepare("UPDATE opdracht SET status = 'mislukt', poging = 2 WHERE id = ?").run(u.opdracht);
  gooit(() => opdracht(f, u), /UNIQUE/);
  f.db.prepare("UPDATE opdracht SET poging = 3 WHERE id = ?").run(u.opdracht);
  opdracht(f, u);
  // poging nooit boven 3
  gooit(() => f.db.prepare("UPDATE opdracht SET poging = 4 WHERE id = ?").run(u.opdracht), /CHECK|opdracht_dood/);
  D.sluit(f);
});

test('een document is hooguit één factuur (splitsen bestaat niet)', () => {
  const f = basis();
  const t = factuur(f);
  gooit(() => D.voegToe(f, 'factuur', { id: D.nieuwId(), document: t.doc, status: 'te_beoordelen', aangemaakt_op: 'x', bijgewerkt_op: 'x' }), /UNIQUE/);
  gooit(() => D.voegToe(f, 'factuur', { id: D.nieuwId(), document: t.doc.replace(/.$/, (c) => (c === 'f' ? 'e' : 'f')), status: 'te_beoordelen', aangemaakt_op: 'x', bijgewerkt_op: 'x' }), /FOREIGN KEY/);
  D.sluit(f);
});

test('id\'s zijn 16 hex kleine letters (paden); sha256 64 hex', () => {
  const f = basis();
  for (const fout of ['fac_0123456789ab', 'ABCDEF0123456789', '0123456789abcde', '0123456789abcdef0']) {
    gooit(() => D.voegToe(f, 'leverancier', { id: fout, naam: 'X', genormaliseerd: 'x', aangemaakt_op: 'x' }), /CHECK/, fout);
  }
  gooit(() => D.voegToe(f, 'document', { id: D.nieuwId(), sha256: 'A'.repeat(64), soort: 'pdf', aangemaakt_op: 'x' }), /CHECK/);
  for (let i = 0; i < 50; i++) assert.match(D.nieuwId(), /^[0-9a-f]{16}$/);
  D.sluit(f);
});

// ───────────────────────────── terugdraaien tegen claimen ─────────────────────────────

test('terugdraaien vóór claimen: opdracht teruggedraaid, factuur terug naar Beoordelen, claim pakt hem niet', () => {
  const f = basis();
  const t = inWachtrij(f);
  const r = D.terugdraaien(f, t.id, { wie: 'toets', wanneer: iso(NU) });
  assert.deepEqual(r, { ok: true, factuur: t.id, opdracht: t.opdracht });
  assert.equal(f.db.prepare('SELECT status FROM opdracht WHERE id = ?').get(t.opdracht).status, 'teruggedraaid');
  assert.equal(f.db.prepare('SELECT status FROM factuur WHERE id = ?').get(t.id).status, 'te_beoordelen');
  assert.equal(D.claimOpdrachten(f, NU).opdrachten.length, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM audit WHERE wat = 'terugdraaien' AND object_id = ?").get(t.id).n, 1);
  // tweede keer: niets meer terug te draaien
  assert.equal(D.terugdraaien(f, t.id, { wie: 'toets' }).ok, false);
  D.sluit(f);
});

test('claimen vóór terugdraaien: changes() == 0 → al_opgehaald, er verandert niets', () => {
  const f = basis();
  const t = inWachtrij(f);
  const c = D.claimOpdrachten(f, NU);
  assert.deepEqual(c.opdrachten.map((o) => o.id), [t.opdracht]);
  assert.equal(c.opdrachten[0].poging, 1);
  assert.ok(Array.isArray(c.opdrachten[0].bijlagen));
  const voor = D.tellingen(f);
  const r = D.terugdraaien(f, t.id, { wie: 'toets' });
  assert.equal(r.ok, false);
  assert.equal(r.fout, 'ongeldige_overgang');   // de factuur staat al op wordt_verstuurd
  assert.equal(f.db.prepare('SELECT status FROM factuur WHERE id = ?').get(t.id).status, 'wordt_verstuurd');
  assert.equal(f.db.prepare('SELECT status FROM opdracht WHERE id = ?').get(t.opdracht).status, 'opgehaald');
  assert.deepEqual(D.tellingen(f), voor);
  D.sluit(f);
});

test('terugdraaien: de voorwaardelijke UPDATE wint ook als een tweede verbinding de opdracht net claimde', () => {
  const f = basis();
  const t = inWachtrij(f);
  // een tweede verbinding (de koerier in een ander proces) claimt; de factuur staat nog op in_wachtrij (bv. halverwege een oudere koerier)
  const k = D.open(f.dir);
  k.db.prepare("UPDATE opdracht SET status = 'opgehaald', opgehaald_op = ?, poging = 1 WHERE id = ?").run(iso(NU), t.opdracht);
  D.sluit(k);
  const r = D.terugdraaien(f, t.id, { wie: 'toets' });
  assert.equal(r.ok, false);
  assert.equal(r.fout, 'al_opgehaald');
  assert.equal(f.db.prepare('SELECT status FROM factuur WHERE id = ?').get(t.id).status, 'in_wachtrij');
  assert.equal(f.db.prepare('SELECT status FROM opdracht WHERE id = ?').get(t.opdracht).status, 'opgehaald');
  D.sluit(f);
});

test('race (twee threads, eigen verbinding, zelfde startmoment): precies één wint, nooit allebei', async () => {
  const f = basis();
  const RONDES = 40;
  const ronden = [];
  // ronde i claimt met nu = NU + i min en zijn opdracht heeft verstuur_na = NU + i min - 1 s: alleen die (en eerdere, al beslist) is claimbaar
  for (let i = 0; i < RONDES; i++) ronden.push(D.transactie(f, () => { const x = factuur(f, { status: 'in_wachtrij' }); x.opdracht = opdracht(f, x, { extra: { verstuur_na: iso(NU + i * 60000 - 1000) } }); return x; }));
  D.sluit(f);
  const sab = new SharedArrayBuffer(4 * (RONDES + 1));
  const wcode = `
    const { workerData: w, parentPort } = require('worker_threads');
    const D = require(${JSON.stringify(path.join(ROOT, 'facturen-db.js'))});
    const f = D.open(w.dir);
    const s = new Int32Array(w.sab);
    const uit = [];
    for (let i = 0; i < w.ronden.length; i++) {
      Atomics.add(s, i, 1); while (Atomics.load(s, i) < 2) Atomics.wait(s, i, 1, 5);
      if (w.rol === 'terug') uit.push(D.terugdraaien(f, w.ronden[i].id, { wie: 'toets' }).ok);
      else uit.push(D.claimOpdrachten(f, w.nu + i * 60000).opdrachten.some((o) => o.id === w.ronden[i].opdracht));
    }
    D.sluit(f); parentPort.postMessage(uit);`;
  const draai = (rol) => new Promise((res, rej) => {
    const w = new Worker(wcode, { eval: true, workerData: { dir: f.dir, sab, rol, nu: NU, ronden: ronden.map((r) => ({ id: r.id, opdracht: r.opdracht })) } });
    w.on('message', res); w.on('error', rej);
  });
  const [terug, claim] = await Promise.all([draai('terug'), draai('claim')]);
  const g = D.open(f.dir);
  let terugWon = 0, claimWon = 0;
  for (let i = 0; i < RONDES; i++) {
    assert.ok(terug[i] !== claim[i], 'ronde ' + i + ': precies één wint (terug=' + terug[i] + ', claim=' + claim[i] + ')');
    const op = g.db.prepare('SELECT status FROM opdracht WHERE id = ?').get(ronden[i].opdracht).status;
    const fa = g.db.prepare('SELECT status FROM factuur WHERE id = ?').get(ronden[i].id).status;
    if (terug[i]) { terugWon++; assert.deepEqual([op, fa], ['teruggedraaid', 'te_beoordelen'], 'ronde ' + i); }
    else { claimWon++; assert.deepEqual([op, fa], ['opgehaald', 'wordt_verstuurd'], 'ronde ' + i); }
  }
  assert.equal(terugWon + claimWon, RONDES);
  D.sluit(g);
});

test('claimen: pas na verstuur_na; 30 min zonder resultaat opnieuw; drie keer niets → verzending mislukt + één signaal', () => {
  const f = basis();
  const t = D.transactie(f, () => { const x = factuur(f, { status: 'in_wachtrij' }); x.opdracht = opdracht(f, x, { extra: { verstuur_na: iso(NU + 3600000) } }); return x; });
  assert.equal(D.claimOpdrachten(f, NU).opdrachten.length, 0, 'verstuur_na in de toekomst');
  let nu = NU + 3600000;
  assert.equal(D.claimOpdrachten(f, nu).opdrachten[0].poging, 1);
  assert.equal(D.claimOpdrachten(f, nu + 29 * 60000).opdrachten.length, 0, 'nog onderweg');
  nu += 31 * 60000;
  assert.equal(D.claimOpdrachten(f, nu).opdrachten[0].poging, 2);
  nu += 31 * 60000;
  assert.equal(D.claimOpdrachten(f, nu).opdrachten[0].poging, 3);
  nu += 31 * 60000;
  const c = D.claimOpdrachten(f, nu);
  assert.deepEqual(c.definitief, [t.opdracht]);
  assert.equal(f.db.prepare('SELECT status FROM opdracht WHERE id = ?').get(t.opdracht).status, 'mislukt');
  assert.equal(f.db.prepare('SELECT status FROM factuur WHERE id = ?').get(t.id).status, 'verzending_mislukt');
  const s = f.db.prepare("SELECT * FROM signaal WHERE soort = 'verzending_mislukt'").all();
  assert.equal(s.length, 1);
  assert.equal(s[0].sleutel, B.signaalSleutel('verzending_mislukt', [], [t.id], 'op=' + t.opdracht), 'zelfde sleutel als facturen-bank.js: geen tweede melding');
  assert.equal(D.claimOpdrachten(f, nu + 3600000).opdrachten.length, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM signaal").get().n, 1);
  // "Opnieuw proberen" mag nu een nieuwe opdracht maken (de dode telt niet als levend)
  f.db.prepare("UPDATE factuur SET status = 'in_wachtrij' WHERE id = ?").run(t.id);
  opdracht(f, t);
  D.sluit(f);
});

// ───────────────────────────── stukken ─────────────────────────────

test('stukken: atomair, idempotent, geen tijdelijke resten, beschadiging gezien en hersteld', () => {
  const f = D.open(map());
  const bytes = Buffer.from('%PDF-1.4 stuk ' + 'x'.repeat(5000));
  const a = D.stukSchrijf(f, bytes);
  assert.equal(a.nieuw, true);
  assert.equal(a.sha256, D.sha256(bytes));
  assert.equal(D.stukPad(f, a.sha256), path.join(f.stukken, a.sha256.slice(0, 2), a.sha256));
  assert.equal(D.stukSchrijf(f, bytes).nieuw, false);
  assert.ok(D.stukLees(f, a.sha256).equals(bytes));
  assert.deepEqual(fs.readdirSync(path.dirname(D.stukPad(f, a.sha256))).filter((x) => x.startsWith('.tmp')), []);
  // beschadigd op schijf: lezen weigert, opnieuw schrijven herstelt
  fs.writeFileSync(D.stukPad(f, a.sha256), 'kapot');
  gooit(() => D.stukLees(f, a.sha256), /sha256/);
  assert.equal(D.stukSchrijf(f, bytes).nieuw, true);
  assert.ok(D.stukLees(f, a.sha256).equals(bytes));
  assert.equal(modus(D.stukPad(f, a.sha256)), '600');
  // geen pad buiten de stukkenmap
  for (const fout of ['../' + 'a'.repeat(61), 'A'.repeat(64), 'a'.repeat(63), '']) gooit(() => D.stukPad(f, fout), /sha256/, fout);
  gooit(() => D.stukSchrijf(f, 'tekst'), /Buffer/);
  assert.equal(D.stukBestaat(f, 'f'.repeat(64)), false);
  // Uint8Array mag ook
  const u = D.stukSchrijf(f, new Uint8Array([1, 2, 3]));
  assert.ok(D.stukLees(f, u.sha256).equals(Buffer.from([1, 2, 3])));
  D.sluit(f);
});

// ───────────────────────────── audit ─────────────────────────────

test('audit is alleen-toevoegen', () => {
  const f = D.open(map());
  D.audit(f, { wie: 'toets', wat: 'inzage', object_soort: 'document', object_id: '0123456789abcdef', na: { ok: true } });
  gooit(() => f.db.prepare("UPDATE audit SET wie = 'ander'").run(), /audit/);
  gooit(() => f.db.prepare('DELETE FROM audit').run(), /audit/);
  gooit(() => D.audit(f, { wat: 'x', object_soort: 'y' }), /wie/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM audit').get().n, 1);
  D.sluit(f);
});

// ───────────────────────────── zaad + back-up ─────────────────────────────

test('zaad: ± 80 facturen in alle statussen, opdrachten consistent, nooit op de echte map', () => {
  const f = D.open(map('zaad'));
  const z = Z.zaai(f, { vandaag: '2026-10-22' });
  assert.equal(z.facturen, 80);
  const st = new Set(f.db.prepare('SELECT DISTINCT status FROM factuur').all().map((x) => x.status));
  for (const s of K.STATUSSEN) assert.ok(st.has(s), 'status ' + s);
  const sp = new Set(f.db.prepare('SELECT DISTINCT betaalspoor FROM factuur WHERE betaalspoor IS NOT NULL').all().map((x) => x.betaalspoor));
  for (const s of K.BETAALSPOREN) assert.ok(sp.has(s), 'betaalspoor ' + s);
  const so = new Set(f.db.prepare('SELECT DISTINCT soort FROM signaal').all().map((x) => x.soort));
  for (const s of B.SIGNAAL_SOORTEN) assert.ok(so.has(s), 'signaal ' + s);
  assert.ok(z.tellingen.bank_transactie >= 20 && z.tellingen.leverancier >= 10 && z.tellingen.uitzondering >= 3);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM opdracht WHERE entiteit = 'prive'").get().n, 0);
  // elke opdracht: vingerafdruk opnieuw op te bouwen uit de rijen (wat de koerier in F4 doet), stukken op schijf met de goede sha256
  for (const o of f.db.prepare('SELECT * FROM opdracht').all()) {
    const bijl = JSON.parse(o.bijlagen);
    let regel;
    if (o.soort === 'boekhouder_factuur') {
      const fa = f.db.prepare('SELECT f.id, f.entiteit, f.incl, e.boekhoud_doel FROM factuur f JOIN entiteit e ON e.sleutel = f.entiteit WHERE f.id = ?').get(o.factuur);
      assert.equal(fa.boekhoud_doel, o.doeladres);
      regel = { factuur_id: fa.id, entiteit: fa.entiteit, bedrag_centen: fa.incl, doeladres: fa.boekhoud_doel };
    } else {
      const a = f.db.prepare('SELECT a.id, a.periode, r.entiteit FROM pot_afschrift a JOIN rekening r ON r.id = a.rekening WHERE a.id = ?').get(o.afschrift);
      regel = { afschrift_id: a.id, entiteit: a.entiteit, periode: a.periode, doeladres: o.doeladres };
    }
    assert.equal(K.vingerafdruk({ id: o.id, soort: o.soort, doeladres: o.doeladres, regel, bijlagen: bijl }), o.vingerafdruk, o.id);
    for (const b of bijl) assert.ok(D.stukLees(f, b.sha256).length > 0);
    assert.match(o.doeladres, /\.invalid$/);
  }
  // geen echte gegevens: alle IBAN's met bankcode TEST, alle adressen op .invalid
  for (const r of f.db.prepare('SELECT iban FROM rekening UNION SELECT iban FROM leverancier_iban UNION SELECT iban FROM factuur WHERE iban IS NOT NULL').all()) assert.match(r.iban, /^NL\d\dTEST\d{10}$/);
  for (const r of f.db.prepare('SELECT boekhoud_doel AS a FROM entiteit WHERE boekhoud_doel IS NOT NULL UNION SELECT afschrift_doel FROM entiteit WHERE afschrift_doel IS NOT NULL UNION SELECT afzender FROM bericht').all()) assert.match(r.a, /\.invalid$/);
  // de kernvorm van een factuur: sha256 als document, lijsten, booleans; een nieuw IBAN houdt Bevestigen tegen
  const nieuw = f.db.prepare("SELECT id, leverancier FROM factuur WHERE iban_nieuw = 1 AND status = 'te_beoordelen' AND entiteit IS NOT NULL LIMIT 1").get();
  const fk = D.factuurVoorKern(f, nieuw.id);
  assert.match(fk.document, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(fk.ibans_onbekend) && fk.ibans_onbekend.length === 1);
  assert.equal(fk.iban_nieuw, true);
  const lev = f.db.prepare('SELECT id, naam FROM leverancier WHERE id = ?').get(nieuw.leverancier);
  lev.ibans = f.db.prepare('SELECT iban FROM leverancier_iban WHERE leverancier = ?').all(lev.id).map((x) => x.iban);
  const mb = K.magBevestigen(fk, { leverancier: lev, ctx: { entiteiten: [] } });
  assert.equal(mb.ok, false);
  assert.ok(mb.redenen.some((x) => /nabellen/.test(x)), JSON.stringify(mb.redenen));
  // weigeren: database met facturen, en de echte map (zonder hem aan te maken)
  gooit(() => Z.zaai(f), /database met facturen/);
  const bestond = fs.existsSync('/opt/data/facturen');
  gooit(() => Z.zaai({ dir: '/opt/data/facturen', db: null }), /echte facturenmap/);
  gooit(() => Z.zaai({ dir: '/opt/data/facturen/sub', db: null }), /echte facturenmap/);
  assert.equal(fs.existsSync('/opt/data/facturen'), bestond);
  D.sluit(f);
});

test('back-up: VACUUM INTO, 600, terugzetten geeft dezelfde tellingen; rotatie 14 dagen; zelfde dag overschrijft', () => {
  const f = D.open(map('bron'));
  Z.zaai(f, { vandaag: '2026-10-22' });
  const tel = D.tellingen(f);
  // oude kopieën om op te ruimen (13 dagen blijft, 14 en ouder weg) + een vergeten tijdelijk bestand
  for (const d of ['2026-10-09', '2026-10-08', '2026-09-30']) fs.writeFileSync(path.join(f.backup, 'facturen-' + d + '.sqlite'), 'oud', { mode: 0o600 });
  fs.writeFileSync(path.join(f.backup, '.tmp-oud.sqlite'), 'x');
  const oud = (NU - 2 * 86400000) / 1000;
  fs.utimesSync(path.join(f.backup, '.tmp-oud.sqlite'), oud, oud);
  fs.writeFileSync(path.join(f.backup, 'ander-bestand.txt'), 'blijft');
  const b = D.backup(f, { nu: NU });
  assert.equal(b.ok, true);
  assert.equal(path.basename(b.pad), 'facturen-2026-10-22.sqlite');
  assert.equal(modus(b.pad), '600');
  assert.deepEqual(b.verwijderd.sort(), ['.tmp-oud.sqlite', 'facturen-2026-09-30.sqlite', 'facturen-2026-10-08.sqlite']);
  assert.deepEqual(fs.readdirSync(f.backup).sort(), ['ander-bestand.txt', 'facturen-2026-10-09.sqlite', 'facturen-2026-10-22.sqlite']);
  // zelfde dag nog eens: overschrijft (na een wijziging), geen tweede bestand
  D.audit(f, { wie: 'toets', wat: 'na_backup', object_soort: 'proef' });
  const b2 = D.backup(f, { nu: NU + 3600000 });
  assert.equal(b2.pad, b.pad);
  assert.equal(fs.readdirSync(f.backup).filter((x) => /^facturen-/.test(x)).length, 2);
  const tel2 = D.tellingen(f);
  assert.equal(D.health(f).laatste_backup, '2026-10-22');
  // terugzetten in een lege map: zelfde tellingen, schema, integriteit; daarna gewoon bruikbaar
  const h = D.herstel(b2.pad, map('herstel'));
  assert.deepEqual(D.tellingen(h), tel2);
  assert.ok(tel2.audit === tel.audit + 1 && tel2.factuur === tel.factuur);
  assert.equal(h.schema, D.SCHEMA_VERSIE);
  assert.deepEqual(h.toegepast, []);
  assert.equal(h.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all(), []);
  // de triggers zitten ook in de kopie
  gooit(() => h.db.prepare("UPDATE entiteit SET boekhoud_doel = 'x@y.invalid' WHERE sleutel = 'prive'").run(), /CHECK/);
  gooit(() => h.db.prepare('DELETE FROM audit').run(), /audit/);
  gooit(() => D.herstel(b2.pad, h.dir), /staat al een database/);
  D.sluit(h);
  D.sluit(f);
});

test('health: geen inhoud, alleen aan en schema', () => {
  const f = D.open(map());
  const h = D.health(f);
  assert.deepEqual(Object.keys(h).sort(), ['aan', 'laatste_backup', 'schema', 'schema_code']);
  assert.equal(h.schema, D.SCHEMA_VERSIE);
  assert.deepEqual(D.health(null), { aan: true, schema: null, schema_code: D.SCHEMA_VERSIE });
  D.sluit(f);
  const r = D.open(f.dir, { alleenLezen: true });
  assert.equal(r.schema, D.SCHEMA_VERSIE);
  gooit(() => D.voegToe(r, 'audit', { wie: 'x', wat: 'y', object_soort: 'z', wanneer: 'x' }), /readonly|query_only|attempt to write/i);
  D.sluit(r);
});

test('voegToe: onbekende tabel of kolom wordt geweigerd (geen tekst van buiten in de SQL)', () => {
  const f = D.open(map());
  gooit(() => D.voegToe(f, 'sqlite_master', { name: 'x' }), /onbekende tabel/);
  gooit(() => D.voegToe(f, 'audit', { 'wie) VALUES (1); --': 'x' }), /kent geen kolom/);
  D.sluit(f);
});

// ───────────────────────────── server.js-blok (in een vm, zonder echte server) ─────────────────────────────

test('server.js: /health.facturen = { aan, schema }; database alleen op de primaire kant; zonder module aan=false', () => {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const van = src.indexOf('// ── Facturen-app, opslag (wv824'), tot = src.indexOf('// ── Bandjes (wv743', van);
  assert.ok(van > 0 && tot > van, 'blok gevonden');
  assert.match(src, /facturen: facturenInfo\(\),/);
  const draai = (dirname, primair) => {
    const dir = map('server');
    const fouten = [];
    const ctx = { require, path, fs, __dirname: dirname, process: { env: { FACTUREN_DIR: dir } }, console, Date, ROL_KANT: primair.kant || 'olares',
      serverPad: (naam, env, echt, proef) => env || proef, serverProefDeel: (d) => path.join(WEG, 'proef', d),
      rolPrimair: () => primair.waarde, logError: (w, e) => fouten.push(w + ': ' + e.message), nu: () => 'nu' };
    vm.createContext(ctx);
    const r = vm.runInContext(src.slice(van, tot) + ';({ facturenInfo, FACTUREN_DIR })', ctx);
    return { r, dir, fouten };
  };
  // module ontbreekt (terugrol): aan=false, geen database
  const leeg = fs.mkdtempSync(path.join(WEG, 'zonder-'));
  const a = draai(leeg, { waarde: true });
  assert.deepEqual(JSON.parse(JSON.stringify(a.r.facturenInfo())), { aan: false });
  assert.equal(fs.existsSync(a.dir), false);
  // passieve kant: module er wel, maar geen database aanmaken
  const rol = { waarde: false };
  const b = draai(ROOT, rol);
  assert.deepEqual(JSON.parse(JSON.stringify(b.r.facturenInfo())), { aan: true, schema: null, passief: true, routes: true });
  assert.equal(fs.existsSync(b.dir), false, 'passief maakt geen database');
  // wv833: opslag wel, facturen.js (routes) niet in de release → aan=false, opslag=true
  const half = fs.mkdtempSync(path.join(WEG, 'zonder-routes-'));
  for (const f of ['facturen-db.js', 'facturen-kern.js', 'facturen-bank.js', 'mt940-lezer.js']) fs.copyFileSync(path.join(ROOT, f), path.join(half, f));
  const hr = draai(half, { waarde: false });
  assert.deepEqual(JSON.parse(JSON.stringify(hr.r.facturenInfo())), { aan: false, schema: null, passief: true, opslag: true, routes: false });
  // primair: database aangemaakt (700/600), schema van de code
  rol.waarde = true;
  const h = b.r.facturenInfo();
  assert.equal(h.aan, true);
  assert.equal(h.schema, D.SCHEMA_VERSIE);
  assert.equal(modus(b.dir), '700');
  assert.equal(modus(path.join(b.dir, D.BESTAND)), '600');
  assert.deepEqual(b.fouten, []);
  // daarna passief worden: de geopende database blijft gewoon gemeld (geen nieuwe opening, geen fout)
  rol.waarde = false;
  assert.equal(b.r.facturenInfo().schema, D.SCHEMA_VERSIE);
  // VPS-kant die bij een uitwijk primair is: nooit een database (bouwplan § 8)
  const v = draai(ROOT, { waarde: true, kant: 'vps' });
  assert.deepEqual(JSON.parse(JSON.stringify(v.r.facturenInfo())), { aan: true, schema: null, passief: true, routes: true });
  assert.equal(fs.existsSync(v.dir), false, 'VPS maakt geen database');
  // openen mislukt (map is een bestand): fout gemeld, en binnen een minuut geen nieuwe poging
  const c = draai(ROOT, { waarde: true });
  fs.writeFileSync(c.dir, 'geen map');
  const h1 = c.r.facturenInfo();
  assert.equal(h1.aan, true); assert.equal(h1.schema, null); assert.ok(h1.fout);
  assert.equal(c.fouten.length, 1);
  c.r.facturenInfo(); c.r.facturenInfo();
  assert.equal(c.fouten.length, 1, 'geen herhaalde pogingen binnen een minuut');
});

// ───────────────────────────── diffreview wv824: extra gaten dicht ─────────────────────────────

test('review #1: een oude opdracht herleeft niet nadat de factuur Privé werd (status-update en REPLACE)', () => {
  const f = basis();
  // A: bevestigd, teruggedraaid, Privé; een codefout zet de oude opdracht weer op mislukt/wacht → geweigerd door de trigger
  const t = inWachtrij(f);
  assert.equal(D.terugdraaien(f, t.id, { wie: 'toets' }).ok, true);
  f.db.prepare("UPDATE factuur SET entiteit = 'prive', status = 'prive_archief', betaalspoor = 'te_betalen', bevestigd_door = 'x', bevestigd_op = 'x' WHERE id = ?").run(t.id);
  gooit(() => f.db.prepare("UPDATE opdracht SET status = 'mislukt', poging = 0 WHERE id = ?").run(t.opdracht), /opdracht_dood|opdracht_poging/);
  gooit(() => f.db.prepare("UPDATE opdracht SET status = 'wacht' WHERE id = ?").run(t.opdracht), /opdracht_dood/);
  assert.equal(D.claimOpdrachten(f, NU).opdrachten.length, 0);
  // B: opdracht mislukt (poging 1) en de factuur wordt via INSERT OR REPLACE Privé gemaakt → de DELETE-trigger vangt het
  const u = inWachtrij(f);
  f.db.prepare("UPDATE opdracht SET status = 'opgehaald', opgehaald_op = ?, poging = 1 WHERE id = ?").run(iso(NU), u.opdracht);
  f.db.prepare("UPDATE factuur SET status = 'wordt_verstuurd' WHERE id = ?").run(u.id);
  f.db.prepare("UPDATE opdracht SET status = 'mislukt' WHERE id = ?").run(u.opdracht);
  const rij = f.db.prepare('SELECT * FROM factuur WHERE id = ?').get(u.id);
  const k = Object.keys(rij);
  rij.entiteit = 'prive'; rij.status = 'prive_archief';
  gooit(() => f.db.prepare('INSERT OR REPLACE INTO factuur (' + k.join(',') + ') VALUES (' + k.map(() => '?').join(',') + ')').run(...k.map((x) => rij[x])), /factuur_weg/);
  gooit(() => f.db.prepare('DELETE FROM factuur WHERE id = ?').run(u.id), /factuur_weg/);
  // C: zonder REPLACE-trigger (oude verbinding zonder recursive_triggers) houdt de levensloop-trigger het alsnog tegen bij de claim
  f.db.exec('PRAGMA recursive_triggers = OFF; PRAGMA foreign_keys = OFF');
  f.db.prepare('INSERT OR REPLACE INTO factuur (' + k.join(',') + ') VALUES (' + k.map(() => '?').join(',') + ')').run(...k.map((x) => rij[x]));
  f.db.exec('PRAGMA recursive_triggers = ON; PRAGMA foreign_keys = ON');
  gooit(() => f.db.prepare("UPDATE opdracht SET status = 'opgehaald', poging = 2, opgehaald_op = 'x' WHERE id = ?").run(u.opdracht), /opdracht_prive|opdracht_entiteit/);
  const c = D.claimOpdrachten(f, NU + 3600000);
  assert.equal(c.opdrachten.length, 0, 'niets naar de koerier');
  assert.deepEqual(c.geweigerd.map((x) => x.id), [u.opdracht]);
  assert.equal(f.db.prepare('SELECT status FROM opdracht WHERE id = ?').get(u.opdracht).status, 'geweigerd');
  assert.equal(f.db.prepare('SELECT status FROM factuur WHERE id = ?').get(u.id).status, 'prive_archief', 'privéfactuur blijft in het privé-archief');
  const s = f.db.prepare("SELECT * FROM signaal WHERE soort = 'verzending_mislukt'").get();
  assert.equal(s.alleen_eigenaar, 1, 'signaal over een privéfactuur alleen voor de eigenaar');
  D.sluit(f);
});

test('review #1: claimen weigert een opdracht waarvan het boekhoudadres intussen wijzigde (geweigerd + signaal, geen nieuwe poging)', () => {
  const f = basis();
  const t = inWachtrij(f);
  f.db.prepare("UPDATE entiteit SET boekhoud_doel = 'nieuw-adres@acta.invalid' WHERE sleutel = 'tolgaarde'").run();
  const c = D.claimOpdrachten(f, NU);
  assert.equal(c.opdrachten.length, 0);
  assert.equal(c.geweigerd[0].reden, 'doeladres wijkt af van de entiteitentabel');
  assert.equal(f.db.prepare('SELECT status FROM opdracht WHERE id = ?').get(t.opdracht).status, 'geweigerd');
  assert.equal(f.db.prepare('SELECT status FROM factuur WHERE id = ?').get(t.id).status, 'verzending_mislukt');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM signaal WHERE soort = 'verzending_mislukt'").get().n, 1);
  assert.equal(D.claimOpdrachten(f, NU + 3600000).opdrachten.length, 0);
  // Opnieuw proberen: nieuwe opdracht met het nieuwe adres gaat wel
  f.db.prepare("UPDATE factuur SET status = 'in_wachtrij' WHERE id = ?").run(t.id);
  const n2 = opdracht(f, t);
  assert.deepEqual(D.claimOpdrachten(f, NU).opdrachten.map((o) => o.id), [n2]);
  D.sluit(f);
});

test('review #1: levensloop — terug naar wacht, poging omlaag en terugdraaien na ophalen kunnen niet', () => {
  const f = basis();
  const t = inWachtrij(f);
  D.claimOpdrachten(f, NU);
  gooit(() => f.db.prepare("UPDATE opdracht SET status = 'wacht' WHERE id = ?").run(t.opdracht), /opdracht_wacht/);
  gooit(() => f.db.prepare("UPDATE opdracht SET poging = 0 WHERE id = ?").run(t.opdracht), /opdracht_poging/);
  gooit(() => f.db.prepare("UPDATE opdracht SET status = 'teruggedraaid' WHERE id = ?").run(t.opdracht), /opdracht_terug/);
  f.db.prepare("UPDATE opdracht SET status = 'gelukt', extern_id = 'x' WHERE id = ?").run(t.opdracht);
  gooit(() => f.db.prepare("UPDATE opdracht SET status = 'mislukt' WHERE id = ?").run(t.opdracht), /opdracht_dood/);
  D.sluit(f);
});

test('review #4: één kapotte rij houdt de andere opdrachten niet tegen; verstuur_na heeft een vast formaat', () => {
  const f = basis();
  const kapot = inWachtrij(f), goed = inWachtrij(f);
  // codefout: de factuur van de eerste staat niet meer in de wachtrij (maar wel nog onderweg-achtig in de database)
  f.db.prepare("UPDATE factuur SET status = 'te_beoordelen', bevestigd_door = NULL, bevestigd_op = NULL WHERE id = ?").run(kapot.id);
  const c = D.claimOpdrachten(f, NU);
  assert.deepEqual(c.opdrachten.map((o) => o.id), [goed.opdracht]);
  assert.deepEqual(c.geweigerd.map((x) => x.id), [kapot.opdracht]);
  assert.equal(f.db.prepare('SELECT status FROM factuur WHERE id = ?').get(kapot.id).status, 'te_beoordelen');
  gooit(() => D.transactie(f, () => { const x = factuur(f, { status: 'in_wachtrij' }); opdracht(f, x, { extra: { verstuur_na: 'morgen' } }); }), /CHECK/);
  D.sluit(f);
});

test('claimen: een door de koerier gemelde mislukking (poging < 3) komt bij de volgende ronde mee; factuur blijft wordt_verstuurd', () => {
  const f = basis();
  const t = inWachtrij(f);
  D.claimOpdrachten(f, NU);
  f.db.prepare("UPDATE opdracht SET status = 'mislukt', fout = 'HTTP 502' WHERE id = ?").run(t.opdracht);   // zoals F4 het resultaat vastlegt
  const c = D.claimOpdrachten(f, NU + 60000);
  assert.deepEqual(c.opdrachten.map((o) => [o.id, o.poging]), [[t.opdracht, 2]]);
  assert.equal(f.db.prepare('SELECT status FROM factuur WHERE id = ?').get(t.id).status, 'wordt_verstuurd');
  f.db.prepare("UPDATE opdracht SET status = 'mislukt' WHERE id = ?").run(t.opdracht);
  assert.equal(D.claimOpdrachten(f, NU + 120000).opdrachten[0].poging, 3);
  f.db.prepare("UPDATE opdracht SET status = 'mislukt' WHERE id = ?").run(t.opdracht);
  assert.equal(D.claimOpdrachten(f, NU + 180000).opdrachten.length, 0, 'na drie pogingen niet meer');
  D.sluit(f);
});

test('claimen: POT-afschrift — gewoon opgehaald, en definitief mislukt → afschrift terug naar klaar, signaal alleen eigenaar', () => {
  const f = basis();
  const s1 = D.stukSchrijf(f, Buffer.from('mt')), s2 = D.stukSchrijf(f, Buffer.from('pd'));
  D.voegToe(f, 'document', { id: 'cccccccccccc0001', sha256: s1.sha256, soort: 'mt940', aangemaakt_op: iso(NU) });
  D.voegToe(f, 'document', { id: 'cccccccccccc0002', sha256: s2.sha256, soort: 'pdf', aangemaakt_op: iso(NU) });
  D.voegToe(f, 'pot_afschrift', { id: 'dddddddddddd0001', rekening: 'aaaaaaaaaaaa0002', periode: '2026-09', mt940_document: 'cccccccccccc0001', pdf_document: 'cccccccccccc0002', status: 'in_wachtrij', aangemaakt_op: iso(NU), bijgewerkt_op: iso(NU) });
  const bijl = [{ sha256: s1.sha256 }, { sha256: s2.sha256 }];
  D.voegToe(f, 'opdracht', { id: 'eeeeeeeeeeee0001', soort: 'boekhouder_afschrift', afschrift: 'dddddddddddd0001', entiteit: 'pot', doeladres: 'afschrift-pot@acta.invalid', bijlagen: bijl,
    vingerafdruk: 'a'.repeat(64), verstuur_na: iso(NU - 1000), idempotentiesleutel: 'af:1', aangemaakt_door: 'toets', aangemaakt_op: iso(NU), bijgewerkt_op: iso(NU) });
  let nu = NU;
  assert.deepEqual(D.claimOpdrachten(f, nu).opdrachten.map((o) => o.id), ['eeeeeeeeeeee0001']);
  assert.equal(f.db.prepare("SELECT status FROM pot_afschrift WHERE id = 'dddddddddddd0001'").get().status, 'in_wachtrij');
  nu += 31 * 60000; D.claimOpdrachten(f, nu);
  nu += 31 * 60000; D.claimOpdrachten(f, nu);
  nu += 31 * 60000;
  assert.deepEqual(D.claimOpdrachten(f, nu).definitief, ['eeeeeeeeeeee0001']);
  assert.equal(f.db.prepare("SELECT status FROM pot_afschrift WHERE id = 'dddddddddddd0001'").get().status, 'klaar');
  const s = f.db.prepare("SELECT * FROM signaal WHERE soort = 'verzending_mislukt'").get();
  assert.equal(s.alleen_eigenaar, 1);
  assert.equal(JSON.parse(s.details).afschrift, 'dddddddddddd0001');
  D.sluit(f);
});

test('review #3: rekening met opgeslagen regels wordt niet Privé of strenger dan zijn regels; trigger transactie_prive los getoetst', () => {
  const f = basis();
  const tx = (rek, ent, o) => D.voegToe(f, 'bank_transactie', Object.assign({ id: D.nieuwId(), rekening: rek, entiteit: ent, eigen_iban: Z.maakIban('NL', 'TEST', '0000000011'),
    boekdatum: '2026-10-01', bedrag_centen: -100, entry_ref: 'r-' + D.nieuwId(), formaat: 'abn_mt940', bestand: null, aangemaakt_op: iso(NU) }, o || {}));
  D.voegToe(f, 'bank_bestand', { id: 'ffffffffffff0001', sha256: 'f'.repeat(64), formaat: 'abn_mt940', geupload_door: 'toets', geupload_op: iso(NU) });
  // een zakelijke rekening met controle 0: de regel wordt geweigerd door de trigger (niet door de CHECK op prive)
  D.voegToe(f, 'rekening', { id: 'aaaaaaaaaaaa0003', entiteit: 'tolgaarde', iban: Z.maakIban('NL', 'TEST', '0000000021'), bank_formaat: 'abn_mt940', controle: 0 });
  gooit(() => tx('aaaaaaaaaaaa0003', 'tolgaarde', { bestand: 'ffffffffffff0001' }), /transactie_prive/);
  tx('aaaaaaaaaaaa0001', 'tolgaarde', { bestand: 'ffffffffffff0001' });
  gooit(() => f.db.prepare("UPDATE rekening SET entiteit = 'prive', controle = 0, alleen_eigenaar = 1 WHERE id = 'aaaaaaaaaaaa0001'").run(), /rekening_regels/);
  gooit(() => f.db.prepare("UPDATE rekening SET controle = 0 WHERE id = 'aaaaaaaaaaaa0001'").run(), /rekening_regels/);
  gooit(() => f.db.prepare("UPDATE rekening SET alleen_eigenaar = 1 WHERE id = 'aaaaaaaaaaaa0001'").run(), /rekening_regels/);
  gooit(() => f.db.prepare("UPDATE rekening SET entiteit = 'groenhouten' WHERE id = 'aaaaaaaaaaaa0001'").run(), /rekening_regels/);
  gooit(() => f.db.prepare("DELETE FROM rekening WHERE id = 'aaaaaaaaaaaa0001'").run(), /rekening_weg/);
  f.db.prepare("UPDATE rekening SET waarschuw_na_dagen = 6 WHERE id = 'aaaaaaaaaaaa0001'").run();   // andere velden mogen wel
  D.sluit(f);
});

test('review #5: herstel weigert als er nog een -wal naast staat', () => {
  const f = D.open(map('bron'));
  const b = D.backup(f, { nu: NU });
  D.sluit(f);
  const dir = map('herstel');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, D.BESTAND + '-wal'), 'oud');
  gooit(() => D.herstel(b.pad, dir), /-wal/);
  assert.equal(fs.existsSync(path.join(dir, D.BESTAND)), false);
});

test('review #7: ook via UPDATE kan een praktijkmanager niet aan Privé', () => {
  const f = basis();
  D.voegToe(f, 'gebruiker', { id: '1111111111111111', ingang: 'fac', rol: 'praktijkmanager', email: 'pm@voorbeeld.invalid' });
  D.voegToe(f, 'gebruiker_entiteit', { gebruiker: '1111111111111111', entiteit: 'tolgaarde' });
  gooit(() => f.db.prepare("UPDATE gebruiker_entiteit SET entiteit = 'prive' WHERE gebruiker = '1111111111111111'").run(), /gebruiker_prive/);
  gooit(() => f.db.prepare("INSERT OR REPLACE INTO gebruiker_entiteit (gebruiker, entiteit) VALUES ('1111111111111111', 'prive')").run(), /gebruiker_prive/);
  D.sluit(f);
});

test('natoets: de koerier kan een mislukking altijd vastleggen, ook na een adreswijziging; de nieuwe poging wordt dan geweigerd', () => {
  const f = basis();
  const t = inWachtrij(f);
  D.claimOpdrachten(f, NU);
  f.db.prepare("UPDATE entiteit SET boekhoud_doel = 'nieuw-adres@acta.invalid' WHERE sleutel = 'tolgaarde'").run();
  f.db.prepare("UPDATE opdracht SET status = 'mislukt', fout = 'HTTP 502' WHERE id = ?").run(t.opdracht);
  const c = D.claimOpdrachten(f, NU + 60000);
  assert.equal(c.opdrachten.length, 0);
  assert.deepEqual(c.geweigerd.map((x) => x.id), [t.opdracht]);
  assert.equal(f.db.prepare('SELECT status FROM factuur WHERE id = ?').get(t.id).status, 'verzending_mislukt');
  D.sluit(f);
});

test('migratie 7 (wv1323): schema 4 → 7 maakt feit + leverancier_iban.bron/feit; een rekening uit de bankhistorie alleen met een bevestigd feit; besluit vast', () => {
  const dir = map('m7');
  dbOpSchema4(dir).close();
  const f = D.open(dir);
  assert.equal(f.schema, 7); assert.ok(f.toegepast.includes(7));
  assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const iban = Z.maakIban('NL', 'TEST', '0000000071'), ander = Z.maakIban('NL', 'TEST', '0000000072');
  D.voegToe(f, 'leverancier', { id: 'bbbbbbbbbbbb0071', naam: 'Proef 71', genormaliseerd: 'proef 71', aangemaakt_op: iso(NU) });
  D.voegToe(f, 'leverancier', { id: 'bbbbbbbbbbbb0072', naam: 'Proef 72', genormaliseerd: 'proef 72', aangemaakt_op: iso(NU) });
  // de bestaande weg (nagebeld) blijft zoals hij was: bron standaard 'nagebeld', geen feit nodig
  f.db.prepare('INSERT INTO leverancier_iban (leverancier, iban, toegevoegd_door, toegevoegd_op) VALUES (?, ?, ?, ?)').run('bbbbbbbbbbbb0072', ander, 'toets', iso(NU));
  assert.equal(f.db.prepare('SELECT bron FROM leverancier_iban WHERE iban = ?').get(ander).bron, 'nagebeld');
  const lb = (lev, i, feit) => f.db.prepare("INSERT INTO leverancier_iban (leverancier, iban, toegevoegd_door, toegevoegd_op, bron, feit) VALUES (?, ?, 'toets', ?, 'bankhistorie', ?)").run(lev, i, iso(NU), feit);
  gooit(() => lb('bbbbbbbbbbbb0071', iban, null), /leverancier_iban_bron/);
  const zet = (o) => D.voegToe(f, 'feit', Object.assign({ soort: 'iban', sleutel: 'iban:' + iban, iban, status: 'bevestigd', leverancier: 'bbbbbbbbbbbb0071', wie: 'toets', wanneer: iso(NU) }, o));
  gooit(() => zet({ sleutel: 'iban:' + ander }), /CHECK/);           // sleutel past niet bij het IBAN
  gooit(() => zet({ leverancier: null }), /CHECK/);                   // bevestigd zonder leverancier
  gooit(() => zet({ status: 'misschien' }), /CHECK/);
  const afg = D.voegToe(f, 'feit', { soort: 'iban', sleutel: 'iban:' + ander, iban: ander, status: 'afgewezen', wie: 'toets', wanneer: iso(NU) });
  gooit(() => lb('bbbbbbbbbbbb0072', ander + '', afg), /leverancier_iban_bron|UNIQUE/);   // afgewezen feit draagt niets
  const id = zet({});
  gooit(() => zet({}), /UNIQUE/);                                     // één besluit per IBAN
  gooit(() => lb('bbbbbbbbbbbb0072', iban, id), /leverancier_iban_bron/);   // feit hoort bij een andere leverancier
  lb('bbbbbbbbbbbb0071', iban, id);
  assert.equal(f.db.prepare('SELECT bron, feit FROM leverancier_iban WHERE iban = ?').get(iban).feit, id);
  gooit(() => f.db.prepare("UPDATE leverancier_iban SET feit = ? WHERE iban = ?").run(afg, iban), /leverancier_iban_bron/);
  gooit(() => f.db.prepare("UPDATE feit SET status = 'afgewezen' WHERE id = ?").run(id), /feit_vast/);
  gooit(() => f.db.prepare('DELETE FROM feit WHERE id = ?').run(id), /FOREIGN KEY/);
  D.sluit(f);
  // nieuw aangemaakt = gemigreerd
  const sql = (db) => db.prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('feit','leverancier_iban','leverancier_iban_bankhistorie','feit_vast') ORDER BY name").all().map((x) => x.sql);
  const a = D.open(dir), b = D.open(map('m7-nieuw'));
  assert.deepEqual(sql(a.db), sql(b.db));
  assert.deepEqual(a.toegepast, []);
  D.sluit(a); D.sluit(b);
});
