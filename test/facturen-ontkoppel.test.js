'use strict';
// Toetsen voor wv3452 (Fable-review facturen-kern M3 / facturen-bank M2): een koppeling bankregel ↔ factuur losmaken. Route ontkoppel (alleen
// David in zijn app, verse vingerafdruk), betaalspoor terug zoals het stond (te_betalen, ingevoerd, incasso_verwacht), rij in ontkoppeling
// (blijft) + audit, de bankcontrole legt het paar niet opnieuw (ook niet als voorstel), het signaal "te betalen, niet betaald" komt terug
// (nieuwe sleutel), een bijschrijving telt niet als betaling (behalve creditnota), en Bankcontrole › Gekoppeld. Alles synthetisch (zaad).
// Draaien: bash test/facturen-ontkoppel.sh
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'facturen-db.js'));
const K = require(path.join(ROOT, 'facturen-kern.js'));
const F = require(path.join(ROOT, 'facturen.js'));
const Z = require(path.join(ROOT, 'test', 'facturen-zaad.js'));

const NU = Date.parse('2026-11-19T12:30:00Z');   // do 19-11 13:30 Amsterdam
const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });

function opzet() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-ontk-'));
  WEG.push(dir);
  const fdb = D.open(path.join(dir, 'db'));
  Z.zaai(fdb, { vandaag: '2026-11-19' });
  const routes = F.maak({ fout: () => {} });
  const eig = F.rolVoor(fdb, { ingang: 'app', wie: 'david (proef)' });
  const t = { dir, fdb, routes, eig, volg: 0, vers: 0 };
  t.call = (methode, rest, d, x) => {
    x = x || {};
    return routes.app(fdb, { methode, pad: '/app/facturen' + (rest ? '/' + rest : ''), d: d || {}, rol: x.rol || eig, primair: true, nu: x.nu || NU,
      versOk: () => x.vers !== false, versVerbruik: () => { t.vers++; }, nogBetalen: null, bankluisPad: x.bankluisPad });
  };
  t.n = (sql, ...p) => Number(fdb.db.prepare(sql).get(...p).n);
  t.fac = (id) => fdb.db.prepare('SELECT * FROM factuur WHERE id = ?').get(id);
  t.kop = (tx, f) => fdb.db.prepare('SELECT * FROM koppeling WHERE transactie = ? AND factuur = ?').get(tx, f);
  t.pm = () => { fdb.db.prepare("UPDATE gebruiker SET actief = 1 WHERE rol = 'praktijkmanager'").run(); return F.rolVoor(fdb, { ingang: 'fac', email: 'praktijkmanager@voorbeeld.invalid' }); };
  t.controle = (nu) => D.transactie(fdb, () => F.bankcontroleToepassen(fdb, nu || NU));
  return t;
}
// Bevestigde factuur van een leverancier met bekend IBAN (geborgd → de bankcontrole koppelt automatisch bij precies hetzelfde bedrag)
function factuur(t, o) {
  o = o || {};
  const lev = t.fdb.db.prepare("SELECT l.id, l.naam, (SELECT iban FROM leverancier_iban WHERE leverancier = l.id ORDER BY iban LIMIT 1) AS iban FROM leverancier l " +
    "WHERE EXISTS (SELECT 1 FROM leverancier_iban WHERE leverancier = l.id) ORDER BY l.naam LIMIT 1 OFFSET ?").get(o.lev || 0);
  t.volg++;
  const st = D.stukSchrijf(t.fdb, Buffer.from('%PDF-1.4\nontk-proef ' + t.volg + ' ' + crypto.randomBytes(4).toString('hex') + '\n%%EOF'));
  const did = D.nieuwId(), id = D.nieuwId(), w = new Date(NU - 30 * 86400000).toISOString();
  D.voegToe(t.fdb, 'document', { id: did, sha256: st.sha256, naam: 'Voorbeeld factuur ' + t.volg + '.pdf', mime: 'application/pdf', bytes: st.bytes, soort: 'pdf', tekstlaag: 1, aangemaakt_op: w });
  const incl = o.incl || 73113 + t.volg * 7;
  D.voegToe(t.fdb, 'factuur', { id, document: did, soort: o.soort || 'factuur', leverancier: lev.id, leverancier_naam: lev.naam, nummer: 'ONTK-' + String(t.volg).padStart(4, '0'),
    factuurdatum: o.factuurdatum || '2026-10-20', vervaldatum: o.vervaldatum || '2026-11-03', excl: Math.round(incl / 1.21), btw: incl - Math.round(incl / 1.21), incl, valuta: 'EUR',
    iban: lev.iban, ibans_betaal: [lev.iban], betaalwijze: o.betaalwijze || 'zelf', entiteit: 'tolgaarde', status: 'verstuurd', bevestigd_door: 'david (proef)', bevestigd_op: w,
    betaalspoor: o.betaalspoor || 'te_betalen', ingevoerd_door: o.ingevoerd ? 'david (proef)' : null, ingevoerd_op: o.ingevoerd ? w : null,
    uitvoer_op: o.ingevoerd ? '2026-11-05' : null, aangemaakt_op: w, bijgewerkt_op: w });
  return { id, lev, incl };
}
// Afschrijving (of met bij: true een bijschrijving) op de proefrekening van Tolgaarde naar het IBAN van de leverancier
function bankregel(t, f, o) {
  o = o || {};
  const b = t.fdb.db.prepare("SELECT * FROM bank_transactie WHERE entiteit = 'tolgaarde' AND verwijderd_op IS NULL AND bedrag_centen < 0 LIMIT 1").get();
  const tid = D.nieuwId();
  D.voegToe(t.fdb, 'bank_transactie', { id: tid, bestand: b.bestand, rekening: b.rekening, entiteit: 'tolgaarde', eigen_iban: b.eigen_iban, boekdatum: o.boekdatum || '2026-11-12',
    bedrag_centen: o.bij ? f.incl : -(o.bedrag || f.incl), valuta: 'EUR', tegenpartij_naam: f.lev.naam, tegenpartij_iban: f.lev.iban, omschrijving: o.omschrijving || 'proefbetaling',
    formaat: b.formaat, entry_ref: 'proef:ontk-' + tid, alleen_eigenaar: 0, aangemaakt_op: new Date(NU - 86400000).toISOString() });
  return tid;
}
const ontkoppel = (t, tx, f, x) => t.call('POST', 'ontkoppel', { transactie: tx, factuur: f }, x);

test('kern: betaalspoorNaOntkoppel — batch → ingevoerd, laatste spoorwissel, anders beginspoor van de betaalwijze', () => {
  assert.equal(K.betaalspoorNaOntkoppel({ betaalwijze: 'zelf' }), 'te_betalen');
  assert.equal(K.betaalspoorNaOntkoppel({ betaalwijze: 'zelf', ingevoerd_op: '2026-11-01T10:00:00Z' }), 'ingevoerd');
  assert.equal(K.betaalspoorNaOntkoppel({ betaalwijze: 'incasso' }), 'incasso_verwacht');
  assert.equal(K.betaalspoorNaOntkoppel({ betaalwijze: 'betaald' }), 'betaald_vooraf');
  assert.equal(K.betaalspoorNaOntkoppel({ betaalwijze: 'zelf', incl: -500 }), 'betaald_vooraf');
  assert.equal(K.betaalspoorNaOntkoppel({ betaalwijze: 'zelf' }, 'incasso_verwacht'), 'incasso_verwacht');
  assert.equal(K.betaalspoorNaOntkoppel({ betaalwijze: 'incasso' }, 'te_betalen'), 'te_betalen');
  assert.equal(K.betaalspoorNaOntkoppel({ betaalwijze: 'zelf' }, 'betaald_gezien'), 'te_betalen');
  assert.equal(K.betaalspoorNaOntkoppel({ betaalwijze: 'onbekend' }), 'te_betalen');
});

test('migratie 27: tabel ontkoppeling, rijen blijven (geen DELETE of UPDATE)', () => {
  const t = opzet();
  assert.ok(D.SCHEMA_VERSIE >= 27);
  assert.ok(D.TABELLEN.includes('ontkoppeling'));
  const f = factuur(t), tx = bankregel(t, f);
  t.fdb.db.prepare("INSERT INTO ontkoppeling (transactie, factuur, bron, methode, wie, wanneer) VALUES (?, ?, 'auto', 'iban_bedrag', 'proef', '2026-11-19T12:00:00Z')").run(tx, f.id);
  assert.throws(() => t.fdb.db.prepare('DELETE FROM ontkoppeling').run(), /rijen blijven/);
  assert.throws(() => t.fdb.db.prepare("UPDATE ontkoppeling SET wie = 'x'").run(), /rijen blijven/);
  assert.throws(() => t.fdb.db.prepare("INSERT INTO ontkoppeling (transactie, factuur, bron, wie, wanneer) VALUES (?, ?, 'raar', 'proef', 'x')").run(tx, f.id), /CHECK/);
});

test('verkeerde automatische koppeling los: te_betalen terug, rij + audit, de controle legt hem niet opnieuw, signaal komt terug', () => {
  const t = opzet();
  const f = factuur(t);   // vervaldatum 3-11: op 19-11 te laat
  t.controle();
  const sig = () => t.fdb.db.prepare("SELECT * FROM signaal WHERE soort = 'te_betalen_niet_betaald' AND facturen LIKE ? ORDER BY aangemaakt_op").all('%' + f.id + '%');
  assert.equal(sig().length, 1, 'eerst het signaal te betalen, niet betaald');
  assert.equal(sig()[0].status, 'open');
  const tx = bankregel(t, f);
  t.controle(NU + 1000);
  const k = t.kop(tx, f.id);
  assert.ok(k, 'de bankcontrole koppelde automatisch');
  assert.equal(k.bron, 'auto');
  assert.equal(t.fac(f.id).betaalspoor, 'betaald_gezien');
  assert.equal(sig()[0].status, 'afgehandeld', 'signaal vanzelf dicht');
  // Bankcontrole › Gekoppeld toont hem (eigenaar)
  const b = t.call('GET', 'bank');
  assert.equal(b.status, 200, JSON.stringify(b.j));
  const g = b.j.gekoppeld.find((x) => x.transactie.id === tx && x.factuur.id === f.id);
  assert.ok(g, 'in de lijst Gekoppeld');
  assert.match(g.hoe, /automatisch/);
  // los
  const versie = t.fac(f.id).versie;
  const r = ontkoppel(t, tx, f.id);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.betaalspoor_voor, 'betaald_gezien');
  assert.equal(r.j.betaalspoor, 'te_betalen');
  assert.equal(t.vers, 1, 'één vingerafdruk verbruikt');
  assert.equal(t.kop(tx, f.id), undefined, 'koppeling weg');
  const fa = t.fac(f.id);
  assert.equal(fa.betaalspoor, 'te_betalen');
  assert.equal(fa.betaald_gezien_op, null);
  assert.ok(fa.versie > versie);
  const o = t.fdb.db.prepare('SELECT * FROM ontkoppeling WHERE transactie = ? AND factuur = ?').get(tx, f.id);
  assert.ok(o);
  assert.deepEqual([o.bron, o.methode, o.betaalspoor_voor, o.betaalspoor_na, o.wie], ['auto', k.methode, 'betaald_gezien', 'te_betalen', 'david (proef)']);
  const a = t.fdb.db.prepare("SELECT * FROM audit WHERE wat = 'ontkoppelen' AND object_id = ?").get(tx + ':' + f.id);
  assert.ok(a, 'auditrij');
  assert.equal(JSON.parse(a.na).betaalspoor, 'te_betalen');
  // de controle in de route en elke volgende: niet opnieuw gekoppeld, geen voorstel voor dit paar
  for (const nu of [NU + 5000, NU + 86400000]) {
    t.controle(nu);
    assert.equal(t.kop(tx, f.id), undefined, 'niet opnieuw gekoppeld');
    assert.equal(t.fac(f.id).betaalspoor, 'te_betalen');
    assert.equal(t.n("SELECT count(*) AS n FROM voorstel WHERE transactie = ? AND status = 'open'", tx), 0, 'geen voorstel voor het losgemaakte paar');
  }
  // het signaal te betalen, niet betaald staat weer open (nieuwe sleutel na_los)
  const open = sig().filter((s) => s.status === 'open');
  assert.equal(open.length, 1, 'signaal weer open: ' + JSON.stringify(sig().map((s) => [s.sleutel, s.status])));
  assert.match(open[0].sleutel, /na_los=/);
  // niet meer in de lijst Gekoppeld
  assert.equal(t.call('GET', 'bank').j.gekoppeld.some((x) => x.transactie.id === tx && x.factuur.id === f.id), false);
  // nog een keer los → 404
  assert.equal(ontkoppel(t, tx, f.id).status, 404);
  // David koppelt hem toch zelf weer: mag (de afwijsrij geldt alleen de bankcontrole)
  const z = t.call('POST', 'koppel', { transactie: tx, factuur: f.id });
  assert.equal(z.status, 200, JSON.stringify(z.j));
  assert.equal(t.fac(f.id).betaalspoor, 'betaald_gezien');
});

test('de juiste betaling komt daarna wel: een andere afschrijving koppelt gewoon automatisch', () => {
  const t = opzet();
  const f = factuur(t);
  const fout = bankregel(t, f, { boekdatum: '2026-11-10' });
  t.controle();
  assert.ok(t.kop(fout, f.id));
  assert.equal(ontkoppel(t, fout, f.id).status, 200);
  assert.equal(t.fac(f.id).betaalspoor, 'te_betalen');
  const goed = bankregel(t, f, { boekdatum: '2026-11-18' });
  t.controle(NU + 2000);
  assert.ok(t.kop(goed, f.id), 'de andere afschrijving koppelt');
  assert.equal(t.kop(fout, f.id), undefined);
  assert.equal(t.fac(f.id).betaalspoor, 'betaald_gezien');
});

test('betaalspoor terug zoals het stond: ingevoerd (batch) en incasso_verwacht (incasso of toch incasso)', () => {
  const t = opzet();
  // in een batch ingevoerd, daarna door de bank gezien
  const a = factuur(t, { betaalspoor: 'ingevoerd', ingevoerd: true });
  const ta = bankregel(t, a);
  t.controle();
  assert.equal(t.fac(a.id).betaalspoor, 'betaald_gezien');
  assert.equal(ontkoppel(t, ta, a.id).j.betaalspoor, 'ingevoerd');
  const fa = t.fac(a.id);
  assert.equal(fa.uitvoer_op, '2026-11-05', 'uitvoerdatum blijft');
  assert.ok(fa.ingevoerd_op);
  // incasso
  const b = factuur(t, { betaalwijze: 'incasso', betaalspoor: 'incasso_verwacht', lev: 1 });
  const tb = bankregel(t, b);
  t.call('POST', 'koppel', { transactie: tb, factuur: b.id });
  assert.equal(t.fac(b.id).betaalspoor, 'betaald_gezien');
  assert.equal(ontkoppel(t, tb, b.id).j.betaalspoor, 'incasso_verwacht');
  // zelf, maar David koos "leverancier incasseert" (toch_incasso) → terug naar incasso_verwacht
  const c = factuur(t, { lev: 2 });
  D.audit(t.fdb, { wie: 'david (proef)', wat: 'betaalspoor_toch_incasso', object_soort: 'factuur', object_id: c.id, voor: { betaalspoor: 'te_betalen' }, na: { betaalspoor: 'incasso_verwacht' }, wanneer: new Date(NU - 5 * 86400000).toISOString() });
  t.fdb.db.prepare("UPDATE factuur SET betaalspoor = 'incasso_verwacht' WHERE id = ?").run(c.id);
  const tc = bankregel(t, c);
  t.call('POST', 'koppel', { transactie: tc, factuur: c.id });
  assert.equal(t.fac(c.id).betaalspoor, 'betaald_gezien');
  assert.equal(ontkoppel(t, tc, c.id).j.betaalspoor, 'incasso_verwacht');
});

test('twee betalingen aan één factuur: één los → blijft betaald gezien', () => {
  const t = opzet();
  const f = factuur(t);
  const t1 = bankregel(t, f, { boekdatum: '2026-11-10' }), t2 = bankregel(t, f, { boekdatum: '2026-11-11' });
  assert.equal(t.call('POST', 'koppel', { transactie: t1, factuur: f.id }).status, 200);
  assert.equal(t.call('POST', 'koppel', { transactie: t2, factuur: f.id, volledig: false }).status, 200);
  const r = ontkoppel(t, t1, f.id);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.betaalspoor, 'betaald_gezien');
  assert.equal(t.fac(f.id).betaalspoor, 'betaald_gezien');
  assert.equal(t.fdb.db.prepare('SELECT betaalspoor_na FROM ontkoppeling WHERE transactie = ?').get(t1).betaalspoor_na, 'betaald_gezien');
});

test('poorten: vingerafdruk, alleen de eigenaar in zijn app, onbekend paar, geen terugboeking, ongeldige id', () => {
  const t = opzet();
  const f = factuur(t), tx = bankregel(t, f);
  t.call('POST', 'koppel', { transactie: tx, factuur: f.id });
  let r = ontkoppel(t, tx, f.id, { vers: false });
  assert.equal(r.status, 403);
  assert.equal(r.j.vers_nodig, true);
  assert.ok(t.kop(tx, f.id), 'zonder vingerafdruk niets veranderd');
  assert.equal(ontkoppel(t, tx, f.id, { rol: t.pm() }).status, 403);
  const vast = F.rolVoor(t.fdb, { ingang: 'vaste_plek', wie: 'david (proef)' });
  if (vast && vast.soort === 'eigenaar') assert.equal(ontkoppel(t, tx, f.id, { rol: vast }).status, 403);
  assert.equal(t.call('POST', 'ontkoppel', { transactie: 'x', factuur: f.id }).status, 400);
  assert.equal(ontkoppel(t, D.nieuwId(), f.id).status, 404);
  assert.ok(t.kop(tx, f.id));
  assert.equal(t.vers, 0, 'geen vingerafdruk verbruikt bij een weigering vooraf');
  // terugboeking (sepa_terug) los maken: nee
  const terug = bankregel(t, f, { bij: true, boekdatum: '2026-11-15' });
  t.fdb.db.prepare("INSERT INTO koppeling (transactie, factuur, bron, methode, zekerheid, volledig, alleen_eigenaar, wie, wanneer) VALUES (?, ?, 'auto', 'sepa_terug', 1, 0, 0, NULL, ?)").run(terug, f.id, new Date(NU).toISOString());
  r = ontkoppel(t, terug, f.id);
  assert.equal(r.status, 409);
  assert.match(r.j.fout, /terugboeking/);
  assert.ok(t.kop(terug, f.id));
  // de praktijkmanager ziet de lijst Gekoppeld niet
  const pm = t.call('GET', 'bank', null, { rol: t.pm() });
  assert.equal(pm.status, 200, JSON.stringify(pm.j));
  assert.deepEqual(pm.j.gekoppeld, []);
});

test('een bijschrijving telt niet als betaling (koppel weigert), behalve bij een creditnota', () => {
  const t = opzet();
  const f = factuur(t), bij = bankregel(t, f, { bij: true });
  const r = t.call('POST', 'koppel', { transactie: bij, factuur: f.id });
  assert.equal(r.status, 409);
  assert.match(r.j.fout, /bijschrijving/);
  assert.equal(t.kop(bij, f.id), undefined);
  assert.equal(t.fac(f.id).betaalspoor, 'te_betalen');
  const c = factuur(t, { incl: -12345, soort: 'creditnota', betaalspoor: 'betaald_vooraf', lev: 1 });
  const terug = bankregel(t, c, { bedrag: -12345 });   // bedrag_centen = +12345: geld terug
  assert.ok(t.fdb.db.prepare('SELECT bedrag_centen FROM bank_transactie WHERE id = ?').get(terug).bedrag_centen > 0);
  const rc = t.call('POST', 'koppel', { transactie: terug, factuur: c.id });
  assert.equal(rc.status, 200, JSON.stringify(rc.j));
  assert.equal(t.fac(c.id).betaalspoor, 'betaald_gezien');
  // en weer los: terug naar betaald_vooraf (niets te betalen)
  assert.equal(ontkoppel(t, terug, c.id).j.betaalspoor, 'betaald_vooraf');
});

// bankluis (read-only) zoals in facturen-routes.test.js
function bankluis(dir, posten) {
  const { DatabaseSync } = require('node:sqlite');
  const p = path.join(dir, 'transacties.sqlite');
  const db = new DatabaseSync(p);
  db.exec('CREATE TABLE IF NOT EXISTS transacties (nr INTEGER PRIMARY KEY, rek TEXT NOT NULL, sleutel TEXT NOT NULL, bron_id TEXT, status TEXT NOT NULL, datum TEXT, bedrag REAL, valuta TEXT, ' +
    'tegenpartij TEXT, tegen_iban TEXT, omschrijving TEXT, ruwe_json TEXT, vervangen_door INTEGER, UNIQUE (rek, sleutel))');
  for (const x of posten) db.prepare('INSERT OR REPLACE INTO transacties (nr, rek, sleutel, status, datum, bedrag, valuta, tegenpartij, tegen_iban, omschrijving, ruwe_json, vervangen_door) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(x.nr, x.rek || 'proef-pot', x.sleutel, x.status, x.datum, x.bedrag, 'EUR', x.tegenpartij || 'Tegenpartij proef', x.tegen_iban || null, x.omschrijving || 'proef', null, x.vervangen_door || null);
  db.close();
  return p;
}

test('bankluis vervangt een losgemaakte post: de afwijsrij verhuist mee (zelfde tijdstip), één keer', () => {
  const t = opzet();
  const pad = bankluis(t.dir, [{ nr: 3, sleutel: 'c', status: 'booked', datum: '2026-10-18', bedrag: -30 }]);
  assert.equal(t.call('POST', 'bankluis', {}, { bankluisPad: pad }).status, 200);
  const c = t.fdb.db.prepare("SELECT id FROM bank_transactie WHERE entry_ref = 'bankluis:proef-pot|c'").get();
  const pf = t.fdb.db.prepare("SELECT id FROM factuur WHERE entiteit = 'pot' LIMIT 1").get();
  assert.ok(c && pf);
  D.voegToe(t.fdb, 'koppeling', { transactie: c.id, factuur: pf.id, bron: 'auto', methode: 'iban_bedrag', alleen_eigenaar: 1, wanneer: new Date(NU).toISOString() });
  const r = ontkoppel(t, c.id, pf.id);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const w = t.fdb.db.prepare('SELECT wanneer FROM ontkoppeling WHERE transactie = ?').get(c.id).wanneer;
  bankluis(t.dir, [{ nr: 3, sleutel: 'c', status: 'booked', datum: '2026-10-18', bedrag: -30, vervangen_door: 4 }, { nr: 4, sleutel: 'd', status: 'booked', datum: '2026-10-18', bedrag: -30 }]);
  for (const nu of [NU + 60000, NU + 120000]) assert.equal(t.call('POST', 'bankluis', {}, { bankluisPad: pad, nu }).status, 200);
  const d = t.fdb.db.prepare("SELECT id FROM bank_transactie WHERE entry_ref = 'bankluis:proef-pot|d'").get();
  assert.ok(d);
  const rij = t.fdb.db.prepare('SELECT * FROM ontkoppeling WHERE transactie = ?').all(d.id);
  assert.equal(rij.length, 1, 'één kopie');
  assert.equal(rij[0].factuur, pf.id);
  assert.equal(rij[0].wanneer, w, 'zelfde tijdstip (geen nieuwe signaalsleutel)');
  assert.equal(t.kop(d.id, pf.id), undefined, 'opvolger niet aan de losgemaakte factuur gekoppeld');
});
