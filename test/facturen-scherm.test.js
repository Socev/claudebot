'use strict';
// Toetsen voor wv3915 (besluitenpagina nr 195 = 2C95 c–f, David Ja 22-11-2026): (c) detail.vorige "vorige keer € x" of "eerste keer",
// (d) overzicht.stand voor de lege lijst Beoordelen, (e) POST zoek over facturen en (alleen de eigenaar) het FV2-archief, (f) tellers.bij_david
// met de betaalmail aan. Alles synthetisch (zaad, IBAN's met bankcode TEST). Draaien: bash test/facturen-scherm.sh
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'facturen-db.js'));
const F = require(path.join(ROOT, 'facturen.js'));
const Z = require(path.join(ROOT, 'test', 'facturen-zaad.js'));

const NU = Date.parse('2026-11-19T12:30:00Z');
const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });

function opzet() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-scherm-'));
  WEG.push(dir);
  const fdb = D.open(path.join(dir, 'db'));
  Z.zaai(fdb, { vandaag: '2026-11-19' });
  const routes = F.maak({ fout: () => {} });
  const eig = F.rolVoor(fdb, { ingang: 'app', wie: 'david (proef)' });
  const t = { dir, fdb, routes, eig, volg: 0 };
  t.call = (methode, rest, d, x) => {
    x = x || {};
    return routes.app(fdb, { methode, pad: '/app/facturen' + (rest ? '/' + rest : ''), d: d || {}, rol: x.rol || eig, primair: true, nu: x.nu || NU,
      versOk: () => true, versVerbruik: () => {}, nogBetalen: x.nogBetalen === undefined ? 'auto' : x.nogBetalen });
  };
  t.n = (sql, ...p) => Number(fdb.db.prepare(sql).get(...p).n);
  t.fac = (id) => fdb.db.prepare('SELECT * FROM factuur WHERE id = ?').get(id);
  t.pm = () => { fdb.db.prepare("UPDATE gebruiker SET actief = 1 WHERE rol = 'praktijkmanager'").run(); return F.rolVoor(fdb, { ingang: 'fac', email: 'praktijkmanager@voorbeeld.invalid' }); };
  return t;
}
function nieuweFactuur(t, o) {
  o = o || {};
  const lev = t.fdb.db.prepare("SELECT l.id, l.naam, (SELECT iban FROM leverancier_iban WHERE leverancier = l.id ORDER BY iban LIMIT 1) AS iban FROM leverancier l " +
    "WHERE EXISTS (SELECT 1 FROM leverancier_iban WHERE leverancier = l.id) ORDER BY l.naam LIMIT 1 OFFSET ?").get(o.lev || 0);
  t.volg++;
  const st = D.stukSchrijf(t.fdb, Buffer.from('%PDF-1.4\nscherm-proef ' + t.volg + ' ' + crypto.randomBytes(4).toString('hex') + '\n%%EOF'));
  const did = D.nieuwId(), id = D.nieuwId(), w = new Date(NU - 3600000).toISOString();
  D.voegToe(t.fdb, 'document', { id: did, sha256: st.sha256, naam: 'Voorbeeld factuur ' + t.volg + '.pdf', mime: 'application/pdf', bytes: st.bytes, soort: 'pdf', tekstlaag: 1, aangemaakt_op: w });
  const incl = o.incl || 41280 + t.volg;
  D.voegToe(t.fdb, 'factuur', Object.assign({ id, document: did, soort: 'factuur', leverancier: lev.id, leverancier_naam: lev.naam, nummer: 'SCH-' + String(t.volg).padStart(4, '0'),
    factuurdatum: '2026-11-10', vervaldatum: '2026-12-03', excl: Math.round(incl / 1.21), btw: incl - Math.round(incl / 1.21), incl, valuta: 'EUR', iban: lev.iban, ibans_betaal: [lev.iban],
    betaalwijze: o.betaalwijze || 'zelf', entiteit: 'tolgaarde', status: 'te_beoordelen', aangemaakt_op: w, bijgewerkt_op: w }, o.velden || {}));
  t.fdb.db.prepare("INSERT INTO besluit (factuur, stap, veld, waarde, bron, wie, wanneer) VALUES (?, 'patientkenmerk', 'patientkenmerk', '0', 'regel', 'proef', ?)").run(id, w);
  return { id, lev, incl };
}
const VERSTUURD = { status: 'verstuurd', betaalspoor: 'betaald_vooraf', betaalwijze: 'betaald', bevestigd_door: 'david (proef)', bevestigd_op: '2026-11-01T10:00:00Z' };
const ONBEKEND_IBAN = 'NL02TEST0999999999';

test('(c) vorige: jongste eerdere factuur of bankregel; eerste keer; zonder leverancier en IBAN null; alleen te beoordelen', () => {
  const t = opzet();
  // eerdere factuur van dezelfde leverancier, later dan elke bankregel aan dat IBAN
  const oud = nieuweFactuur(t, { lev: 2, incl: 50000, velden: Object.assign({ factuurdatum: '2026-11-19' }, VERSTUURD) });
  const nieuw = nieuweFactuur(t, { lev: 2, incl: 60000 });
  let d = t.call('GET', 'factuur/' + nieuw.id);
  assert.equal(d.status, 200, JSON.stringify(d.j));
  assert.deepEqual(d.j.vorige, { eerste: false, centen: 50000, valuta: 'EUR', datum: '2026-11-19', bron: 'factuur', entiteit: 'tolgaarde' });
  // een eerdere factuur die "geen factuur" of dubbel is telt niet; dan valt hij terug op de bank of eerste keer
  t.fdb.db.prepare("UPDATE factuur SET status = 'geen_factuur', betaalspoor = NULL WHERE id = ?").run(oud.id);
  d = t.call('GET', 'factuur/' + nieuw.id);
  const bank = t.fdb.db.prepare('SELECT boekdatum, -bedrag_centen AS c FROM bank_transactie WHERE tegenpartij_iban = ? AND bedrag_centen < 0 AND verwijderd_op IS NULL ORDER BY boekdatum DESC LIMIT 1').get(nieuw.lev.iban);
  if (bank) assert.equal(d.j.vorige.bron, 'bank'), assert.equal(d.j.vorige.centen, bank.c), assert.equal(d.j.vorige.datum, bank.boekdatum);
  else assert.deepEqual(d.j.vorige, { eerste: true });
  // onbekende partij met een nieuw IBAN: eerste keer
  const eerste = nieuweFactuur(t, { velden: { leverancier: null, leverancier_naam: 'Nieuwe Partij B.V.', iban: ONBEKEND_IBAN, ibans_betaal: [ONBEKEND_IBAN] } });
  assert.deepEqual(t.call('GET', 'factuur/' + eerste.id).j.vorige, { eerste: true });
  // geen leverancier en geen IBAN: niet vast te stellen
  const leeg = nieuweFactuur(t, { betaalwijze: 'onbekend', velden: { leverancier: null, leverancier_naam: 'Iemand', iban: null, ibans_betaal: [] } });
  assert.equal(t.call('GET', 'factuur/' + leeg.id).j.vorige, null);
  // een al afgehandelde factuur krijgt geen vorige
  const af = nieuweFactuur(t, { lev: 2, velden: VERSTUURD });
  assert.equal(t.call('GET', 'factuur/' + af.id).j.vorige, undefined);
});

test('(c) vorige: bankregel vanuit een andere entiteit telt mee (geen "eerste keer"); regel die aan deze factuur hangt niet', () => {
  const t = opzet();
  const tx = t.fdb.db.prepare("SELECT id, tegenpartij_iban AS iban, boekdatum, -bedrag_centen AS c, entiteit FROM bank_transactie WHERE bedrag_centen < 0 AND tegenpartij_iban IS NOT NULL AND verwijderd_op IS NULL ORDER BY boekdatum DESC LIMIT 1").get();
  assert.ok(tx, 'zaad heeft afschrijvingen');
  const andere = tx.entiteit === 'tolgaarde' ? 'groenhouten' : 'tolgaarde';
  const f = nieuweFactuur(t, { velden: { leverancier: null, leverancier_naam: 'Partij X', iban: tx.iban, ibans_betaal: [tx.iban], entiteit: andere } });
  const v = t.call('GET', 'factuur/' + f.id).j.vorige;
  const verwacht = t.fdb.db.prepare('SELECT boekdatum, -bedrag_centen AS c FROM bank_transactie WHERE tegenpartij_iban = ? AND bedrag_centen < 0 AND verwijderd_op IS NULL ORDER BY boekdatum DESC LIMIT 1').get(tx.iban);
  assert.equal(v.eerste, false);
  assert.equal(v.bron, 'bank');
  assert.equal(v.centen, verwacht.c);
  assert.equal(v.datum, verwacht.boekdatum);
});

test('(d) stand: concepten (met oudste), open betalingen (over de vervaldatum), verwachte incasso\'s = SQL-tellingen', () => {
  const t = opzet();
  nieuweFactuur(t, { velden: Object.assign({}, VERSTUURD, { betaalspoor: 'te_betalen', betaalwijze: 'zelf', vervaldatum: '2026-11-01' }) });
  nieuweFactuur(t, { velden: Object.assign({}, VERSTUURD, { betaalspoor: 'incasso_verwacht', betaalwijze: 'incasso' }) });
  nieuweFactuur(t, { velden: Object.assign({}, VERSTUURD, { status: 'concept_klaar', bijgewerkt_op: new Date(NU - 5 * 86400000).toISOString() }) });
  const o = t.call('GET', '');
  assert.equal(o.status, 200, JSON.stringify(o.j));
  const st = "('in_wachtrij','wordt_verstuurd','concept_klaar','verstuurd','verzending_mislukt','concept_verwijderd','prive_archief')";
  assert.equal(o.j.stand.concepten, t.n("SELECT count(*) AS n FROM factuur WHERE status = 'concept_klaar'"));
  assert.ok(o.j.stand.concept_oudste_dagen >= 5);
  assert.equal(o.j.stand.betalen_open, t.n("SELECT count(*) AS n FROM factuur WHERE betaalspoor = 'te_betalen' AND soort <> 'creditnota' AND status IN " + st));
  assert.equal(o.j.stand.betalen_te_laat, t.n("SELECT count(*) AS n FROM factuur WHERE betaalspoor = 'te_betalen' AND soort <> 'creditnota' AND status IN " + st + " AND vervaldatum < '2026-11-19'"));
  assert.ok(o.j.stand.betalen_te_laat >= 1);
  assert.equal(o.j.stand.incasso_verwacht, t.n("SELECT count(*) AS n FROM factuur WHERE betaalspoor = 'incasso_verwacht' AND status IN " + st));
  assert.ok(o.j.stand.incasso_verwacht >= 1);
  // praktijkmanager: dezelfde stand, binnen zijn entiteiten
  const p = t.call('GET', '', null, { rol: t.pm() });
  assert.equal(p.status, 200);
  assert.ok(p.j.stand && Number.isInteger(p.j.stand.concepten));
});

test('(f) bij_david: alleen met de betaalmail aan; geen betaalverzoek telt, wacht/verstuurd niet; praktijkmanager geen veld', () => {
  const t = opzet();
  const nul = t.call('GET', '').j.tellers.bij_david;
  const f = nieuweFactuur(t, { velden: Object.assign({}, VERSTUURD, { betaalspoor: 'te_betalen', betaalwijze: 'zelf' }) });
  let o = t.call('GET', '');
  assert.equal(o.j.nogbetalen_aan, true);
  assert.equal(o.j.tellers.bij_david, nul + 1, 'zonder betaalverzoek wacht hij op David');
  // betaalverzoek staat klaar (wacht) → bij Cynthia, telt niet
  const w = new Date(NU - 600000).toISOString();
  D.voegToe(t.fdb, 'betaal_verzending', { id: D.nieuwId(), factuur: f.id, aanleiding: 'knop', volgnummer: 1, entiteit: 'tolgaarde', aan: 'nogbetalen@huisartsentolgaarde.nl', status: 'wacht',
    verstuur_na: w, let_op: '[]', zonder_bijlage: 0, aangemaakt_door: 'david (proef)', aangemaakt_op: w, bijgewerkt_op: w });
  o = t.call('GET', '');
  assert.equal(o.j.tellers.bij_david, nul);
  // uit: geen veld en nogbetalen_aan false
  o = t.call('GET', '', null, { nogBetalen: null });
  assert.equal(o.j.tellers.bij_david, undefined);
  assert.equal(o.j.nogbetalen_aan, false);
  // praktijkmanager (smalle ingang): geen veld
  o = t.call('GET', '', null, { rol: t.pm() });
  assert.equal(o.j.tellers.bij_david, undefined);
  assert.equal(o.j.nogbetalen_aan, undefined);
});

test('(e) zoek: naam, nummer, bedrag (exact en hele euro\'s), archief alleen voor de eigenaar, grenzen', () => {
  const t = opzet();
  const a = nieuweFactuur(t, { incl: 12345, velden: { leverancier_naam: 'Zoekpartij Alfa B.V.' } });
  const b = nieuweFactuur(t, { incl: 12399, velden: Object.assign({ nummer: 'ZK-77' }, VERSTUURD) });
  t.fdb.db.prepare("INSERT INTO factuur_archief (id, herkomst, extern_id, entiteit, leverancier_naam, nummer, factuurdatum, incl, valuta, status, aangemaakt_op) VALUES (?, 'fv2', 'x1', 'tolgaarde', 'Zoekpartij Archief', 'OUD-1', '2025-03-01', 77700, 'EUR', 'betaald', '2026-11-01T00:00:00Z')")
    .run(D.nieuwId());
  const z = (tekst, x) => t.call('POST', 'zoek', { tekst }, x);
  let r = z('zoekpartij');
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.aantal, 2);
  assert.deepEqual(r.j.facturen.map((x) => x.herkomst).sort(), ['app', 'archief']);
  assert.equal(r.j.facturen[0].herkomst, 'app', 'jongste factuurdatum eerst');
  r = z('zk-77');
  assert.deepEqual(r.j.facturen.map((x) => x.id), [b.id]);
  assert.ok(r.j.facturen[0].bevestigd_op);
  r = z('123,45');
  assert.deepEqual(r.j.facturen.map((x) => x.id), [a.id]);
  r = z('€ 123');
  assert.deepEqual(r.j.facturen.map((x) => x.id).sort(), [a.id, b.id].sort());
  r = z('777');
  assert.equal(r.j.aantal, t.n("SELECT count(*) AS n FROM factuur_archief WHERE incl BETWEEN 77700 AND 77799 OR nummer LIKE '%777%' OR leverancier_naam LIKE '%777%'") +
    t.n("SELECT count(*) AS n FROM factuur f LEFT JOIN leverancier l ON l.id = f.leverancier WHERE f.incl BETWEEN 77700 AND 77799 OR f.nummer LIKE '%777%' OR f.kenmerk LIKE '%777%' OR f.leverancier_naam LIKE '%777%' OR l.naam LIKE '%777%'"));
  // praktijkmanager ziet het archief niet
  r = z('zoekpartij', { rol: t.pm() });
  assert.equal(r.status, 200);
  assert.ok(r.j.facturen.every((x) => x.herkomst === 'app'));
  // LIKE-tekens zijn letterlijk
  assert.equal(z('%%').j.aantal, 0);
  assert.equal(z('x').status, 400);
  assert.equal(z('y'.repeat(61)).status, 400);
});
