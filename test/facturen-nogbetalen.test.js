'use strict';
// Toetsen voor het betaalverzoek naar Cynthia (nogbetalen@, wv3369): kern (letOp, nogBetalenMail), tabel betaal_verzending (M26), Bevestigen en
// terugdraaien, voorbereiden in facturen.js en de serverronde (server.js, in een vm). Alles synthetisch (leveranciers en IBAN's uit het zaad,
// bankcode TEST); raakt geen pod, kluis, mail of vault. Draaien: bash test/facturen-nogbetalen.sh
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'facturen-db.js'));
const K = require(path.join(ROOT, 'facturen-kern.js'));
const F = require(path.join(ROOT, 'facturen.js'));
const Z = require(path.join(ROOT, 'test', 'facturen-zaad.js'));

const AAN = 'nogbetalen@huisartsentolgaarde.nl';
const NU = Date.parse('2026-11-19T12:30:00Z');   // do 19-11 13:30 Amsterdam
const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });

function opzet() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-nb-'));
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
  t.rij = (factuur) => fdb.db.prepare('SELECT * FROM betaal_verzending WHERE factuur = ? ORDER BY aangemaakt_op DESC, volgnummer DESC LIMIT 1').get(factuur);
  return t;
}
// Een te beoordelen factuur van een bekende leverancier (IBAN bekend), met een PDF op schijf en de patiëntregel 'geen kenmerk'.
function nieuweFactuur(t, o) {
  o = o || {};
  const ent = o.entiteit || 'tolgaarde';
  const lev = t.fdb.db.prepare("SELECT l.id, l.naam, (SELECT iban FROM leverancier_iban WHERE leverancier = l.id ORDER BY iban LIMIT 1) AS iban FROM leverancier l " +
    "WHERE EXISTS (SELECT 1 FROM leverancier_iban WHERE leverancier = l.id) ORDER BY l.naam LIMIT 1").get();
  t.volg++;
  const st = D.stukSchrijf(t.fdb, Buffer.from('%PDF-1.4\nnb-proef ' + t.volg + ' ' + crypto.randomBytes(4).toString('hex') + '\n%%EOF'));
  const did = D.nieuwId(), id = D.nieuwId(), w = new Date(NU - 3600000).toISOString();
  D.voegToe(t.fdb, 'document', { id: did, sha256: st.sha256, naam: 'Voorbeeld factuur ' + t.volg + '.pdf', mime: 'application/pdf', bytes: st.bytes, soort: 'pdf', tekstlaag: 1, aangemaakt_op: w });
  const incl = o.incl || 41280 + t.volg;
  D.voegToe(t.fdb, 'factuur', Object.assign({ id, document: did, soort: 'factuur', leverancier: lev.id, leverancier_naam: lev.naam, nummer: 'NB-' + String(t.volg).padStart(4, '0'),
    factuurdatum: '2026-11-10', vervaldatum: '2026-12-03', excl: Math.round(incl / 1.21), btw: incl - Math.round(incl / 1.21), incl, valuta: 'EUR', iban: lev.iban, ibans_betaal: [lev.iban],
    betaalwijze: o.betaalwijze || 'zelf', entiteit: ent, status: 'te_beoordelen', aangemaakt_op: w, bijgewerkt_op: w }, o.velden || {}));
  if (o.patient !== true) t.fdb.db.prepare("INSERT INTO besluit (factuur, stap, veld, waarde, bron, wie, wanneer) VALUES (?, 'patientkenmerk', 'patientkenmerk', '0', 'regel', 'proef', ?)").run(id, w);
  return id;
}
function bevestig(t, id, x) {
  const f = t.fdb.db.prepare('SELECT versie FROM factuur WHERE id = ?').get(id);
  return t.call('POST', 'bevestig', { id, versie: f.versie }, x);
}

// ───────────────────────────── kern ─────────────────────────────

test('kern letOp: volgorde, teksten zonder bedrag of naam; dubbel_betaald hoort er niet bij', () => {
  assert.deepEqual(K.letOp({}), []);
  const r = K.letOp({ zonder_bijlage: true, iban_zwak: { sinds: '2026-11-02' }, nagebeld_op: '2026-11-03T10:00:00Z', incasso: true, waarschuwingen: ['eerder_in_batch', 'zegt_betaald', 'mogelijk_betaald', 'kenmerk_fout'],
    dubbel: true, drempel: true, valuta: 'USD', scan: true, signalen: ['onbekend_iban', 'dubbel_betaald', 'onbekend_iban'] });
  assert.equal(r[0], 'factuur niet bijgevoegd (mogelijk patiëntgegevens); vraag David om de factuur');
  assert.equal(r[1], 'rekeningnummer pas sinds 2-11 bekend, niet nagebeld');
  assert.equal(r[2], 'nieuw rekeningnummer, door David nagebeld op 3-11');
  assert.equal(r[3], 'is misschien via incasso');
  assert.ok(r.includes('bedrag in USD, geen euro'));
  assert.equal(r.filter((x) => /onbekend rekeningnummer/.test(x)).length, 1, 'signaal één keer');
  assert.ok(!r.some((x) => /dubbel betaald/.test(x)), 'dubbel_betaald (valse signalen, H1) niet als LET OP');
  assert.ok(r.every((x) => !/\d{3,}/.test(x)), 'geen bedragen');
  assert.equal(K.letOp({ iban_zwak: { sinds: null } })[0], 'rekeningnummer pas sinds kort bekend, niet nagebeld');
});

test('kern nogBetalenMail: onderwerp, geen aanhef of groet, ≤ 3 LET OP-regels, kenmerk, patiëntkenmerk zonder omschrijving, proef', () => {
  const basis = { id: '0123456789abcdef', entiteit: 'Groenhouten', leverancier: 'Voorbeeld Medische Groothandel BV', centen: 41280, valuta: 'EUR', iban: 'NL00TEST0000000000',
    omschrijving: 'factuur 2026-00123 voor de praktijk', nummer: '2026-00123', vervaldatum: '2026-12-03', van_rekening: '1234' };
  let m = K.nogBetalenMail(basis);
  assert.equal(m.onderwerp, 'NOG BETALEN - Groenhouten - Voorbeeld Medische Groothandel BV € 412,80 - uiterlijk 3-12');
  assert.equal(m.ref, 'NB0123456789abcdef');
  assert.ok(m.bericht.startsWith('Voorbeeld Medische Groothandel BV\n€ 412,80\nNL00 TEST 0000 0000 00\nOmschrijving: factuur 2026-00123 voor de praktijk\nUiterlijk: 3-12-2026\nVan rekening: Groenhouten (eindigt op 1234)'), m.bericht);
  assert.ok(m.bericht.endsWith('Factuur in de bijlage. Kenmerk NB0123456789abcdef'));
  assert.ok(!/hallo|beste|groet|dag cynthia/i.test(m.bericht), 'geen aanhef of groet');
  m = K.nogBetalenMail(Object.assign({}, basis, { let_op: ['a', 'b', 'c', 'd', 'e'], vervaldatum: null, van_rekening: null }));
  assert.equal(m.onderwerp, 'NOG BETALEN - Groenhouten - Voorbeeld Medische Groothandel BV € 412,80 - LET OP');
  assert.deepEqual(m.bericht.split('\n').slice(0, 4), ['LET OP - a', 'LET OP - b', 'LET OP - c', '(en nog 2 punten; vraag David)']);
  assert.ok(m.bericht.includes('\nVan rekening: Groenhouten\n'));
  // patiëntkenmerk: geen vrije omschrijving, alleen een factuurnummer zonder spaties; geen bijlage
  m = K.nogBetalenMail(Object.assign({}, basis, { zonder_bijlage: true }));
  assert.ok(m.bericht.includes('Omschrijving: factuur 2026-00123\n'));
  assert.ok(!m.bericht.includes('voor de praktijk'));
  assert.ok(m.bericht.endsWith('Factuur niet bijgevoegd. Kenmerk NB0123456789abcdef'));
  m = K.nogBetalenMail(Object.assign({}, basis, { zonder_bijlage: true, nummer: 'nota mevrouw X' }));
  assert.ok(!/Omschrijving/.test(m.bericht), 'nummer met spaties valt weg');
  // lang, regeleinden, proef
  m = K.nogBetalenMail(Object.assign({}, basis, { leverancier: 'X'.repeat(400) + '\nBcc: iemand@voorbeeld.invalid', let_op: ['x'], proef: true }));
  assert.ok(m.onderwerp.length <= 200 && !/[\r\n]/.test(m.onderwerp));
  assert.ok(m.onderwerp.startsWith('PROEF - NOG BETALEN - Groenhouten - XXX') && m.onderwerp.endsWith('€ 412,80 - uiterlijk 3-12 - LET OP'), m.onderwerp);
  assert.ok(m.bericht.startsWith('PROEF - verzonnen factuur, niet betalen.'));
  assert.ok(m.bericht.length <= 2000 && m.bericht.includes('Kenmerk NB0123456789abcdef'));
  assert.throws(() => K.nogBetalenMail(Object.assign({}, basis, { id: 'x' })));
});

// ───────────────────────────── tabel (M26) ─────────────────────────────

test('M26 betaal_verzending: alleen nogbetalen@, nooit Privé, rijen blijven, alleen vooruit, alleen een bevestigde zelf-te-betalen factuur', () => {
  const t = opzet();
  const id = nieuweFactuur(t);
  const w = new Date(NU).toISOString();
  const rij = (x) => Object.assign({ id: D.nieuwId(), factuur: id, aanleiding: 'bevestigen', volgnummer: 1, entiteit: 'tolgaarde', aan: AAN, status: 'wacht', verstuur_na: w,
    aangemaakt_door: 'proef', aangemaakt_op: w, bijgewerkt_op: w }, x);
  assert.throws(() => D.voegToe(t.fdb, 'betaal_verzending', rij()), /alleen een bevestigde/, 'nog niet bevestigd');
  assert.equal(bevestig(t, id, { nogBetalen: null }).status, 200);
  assert.throws(() => D.voegToe(t.fdb, 'betaal_verzending', rij({ aan: 'iemand@voorbeeld.invalid' })), /CHECK/);
  assert.throws(() => D.voegToe(t.fdb, 'betaal_verzending', rij({ entiteit: 'prive' })), /CHECK|alleen een bevestigde/);
  assert.throws(() => D.voegToe(t.fdb, 'betaal_verzending', rij({ entiteit: 'groenhouten' })), /alleen een bevestigde/, 'andere entiteit dan de factuur');
  assert.throws(() => D.voegToe(t.fdb, 'betaal_verzending', rij({ status: 'verstuurd' })), /alleen een bevestigde/);
  const r = rij();
  D.voegToe(t.fdb, 'betaal_verzending', r);
  assert.throws(() => D.voegToe(t.fdb, 'betaal_verzending', rij()), /UNIQUE/, 'één rij per factuur per aanleiding');
  assert.throws(() => t.fdb.db.prepare('DELETE FROM betaal_verzending WHERE id = ?').run(r.id), /rijen blijven/);
  assert.throws(() => t.fdb.db.prepare("UPDATE betaal_verzending SET aan = 'x@voorbeeld.invalid' WHERE id = ?").run(r.id), /CHECK|alleen vooruit/);
  assert.throws(() => t.fdb.db.prepare("UPDATE betaal_verzending SET status = 'verzenden' WHERE id = ?").run(r.id), /alleen vooruit/, 'verzenden zonder claim_dag');
  t.fdb.db.prepare("UPDATE betaal_verzending SET status = 'verzenden', claim_dag = '2026-11-19' WHERE id = ?").run(r.id);
  assert.throws(() => t.fdb.db.prepare("UPDATE betaal_verzending SET status = 'wacht' WHERE id = ?").run(r.id), /alleen vooruit/);
  t.fdb.db.prepare("UPDATE betaal_verzending SET status = 'onzeker' WHERE id = ?").run(r.id);
  assert.throws(() => t.fdb.db.prepare("UPDATE betaal_verzending SET status = 'mislukt' WHERE id = ?").run(r.id), /alleen vooruit/, 'onzeker nooit naar mislukt (opnieuw)');
  // alleen-eigenaar en creditnota: trigger
  const ae = nieuweFactuur(t);
  bevestig(t, ae, { nogBetalen: null });
  t.fdb.db.prepare('UPDATE factuur SET alleen_eigenaar = 1 WHERE id = ?').run(ae);
  assert.throws(() => D.voegToe(t.fdb, 'betaal_verzending', rij({ id: D.nieuwId(), factuur: ae })), /alleen een bevestigde/);
});

// ───────────────────────────── Bevestigen en terugdraaien ─────────────────────────────

test('Bevestigen zelf → rij wacht op het tijdstip van de opdracht; uit → geen rij; incasso/Privé/alleen-eigenaar/creditnota → geen rij', () => {
  const t = opzet();
  const id = nieuweFactuur(t);
  const b = bevestig(t, id);
  assert.equal(b.status, 200, JSON.stringify(b.j));
  assert.equal(b.j.betaalspoor, 'te_betalen');
  assert.equal(b.j.nogbetalen.status, 'wacht');
  const r = t.rij(id);
  assert.deepEqual([r.status, r.aan, r.entiteit, r.aanleiding, r.volgnummer, r.verstuur_na], ['wacht', AAN, 'tolgaarde', 'bevestigen', 1, b.j.opdracht.verstuur_na]);
  assert.ok(Array.isArray(JSON.parse(r.let_op)) && !JSON.parse(r.let_op).some((x) => /niet bijgevoegd|nagebeld|incasso/.test(x)), r.let_op);
  assert.equal(r.zonder_bijlage, 0);
  // schakelaar uit (of niet gezet) → geen rij
  const u = nieuweFactuur(t);
  assert.equal(bevestig(t, u, { nogBetalen: null }).status, 200);
  assert.equal(t.rij(u), undefined);
  // incasso
  const i = nieuweFactuur(t, { betaalwijze: 'incasso' });
  assert.equal(bevestig(t, i).j.betaalspoor, 'incasso_verwacht');
  assert.equal(t.rij(i), undefined);
  // Privé
  const p = nieuweFactuur(t, { entiteit: 'prive' });
  const bp = bevestig(t, p);
  assert.equal(bp.status, 200, JSON.stringify(bp.j));
  assert.equal(t.rij(p), undefined);
  // creditnota
  const c = nieuweFactuur(t, { velden: { soort: 'creditnota' } });
  bevestig(t, c);
  assert.equal(t.rij(c), undefined);
  // alleen-eigenaar
  const ae = nieuweFactuur(t, { velden: { alleen_eigenaar: 1 } });
  const ba = bevestig(t, ae);
  assert.equal(ba.status, 200, JSON.stringify(ba.j));
  assert.equal(t.rij(ae), undefined);
  assert.equal(t.n('SELECT count(*) AS n FROM betaal_verzending'), 1);
});

test('terugdraaien: wachtende rij vervalt; al verstuurd of onderweg → terugdraaien geweigerd', () => {
  const t = opzet();
  const a = nieuweFactuur(t);
  bevestig(t, a);
  const td = t.call('POST', 'terugdraaien', { id: a });
  assert.equal(td.status, 200, JSON.stringify(td.j));
  assert.deepEqual([t.rij(a).status, t.rij(a).reden], ['vervallen', 'Bevestigen teruggedraaid']);
  // opnieuw bevestigen → nieuwe rij met volgnummer 2
  const b2 = bevestig(t, a);
  assert.equal(b2.status, 200, JSON.stringify(b2.j));
  assert.deepEqual([t.rij(a).status, t.rij(a).volgnummer], ['wacht', 2]);
  // onderweg → geweigerd, opdracht en rij blijven
  const v = t.routes.nogBetalen.voorbereid(t.fdb, t.rij(a).id, { nu: NU + 2 * 3600000 });
  assert.equal(v.actie, 'versturen');
  const td2 = t.call('POST', 'terugdraaien', { id: a });
  assert.equal(td2.status, 409);
  assert.equal(td2.j.code, 'al_bij_cynthia');
  assert.equal(t.fdb.db.prepare('SELECT status FROM factuur WHERE id = ?').get(a).status, 'in_wachtrij');
  assert.equal(t.n("SELECT count(*) AS n FROM opdracht WHERE factuur = ? AND status = 'wacht'", a), 1);
});

// ───────────────────────────── voorbereiden ─────────────────────────────

test('voorbereid: mail met bijlage (byte-gelijk), LET OP uit de database, claim met dag; al betaald (kaart/PayPal) → vervallen; patiëntkenmerk → zonder bijlage', () => {
  const t = opzet();
  const a = nieuweFactuur(t);
  bevestig(t, a);
  const r = t.rij(a);
  assert.equal(t.routes.nogBetalen.open(t.fdb, NU).length, 0, 'nog niet: verstuur_na ligt in de toekomst');
  const T = Date.parse(r.verstuur_na) + 60000;
  assert.deepEqual(t.routes.nogBetalen.open(t.fdb, T).map((x) => x.id), [r.id]);
  const v = t.routes.nogBetalen.voorbereid(t.fdb, r.id, { nu: T });
  assert.equal(v.actie, 'versturen');
  assert.equal(v.aan, AAN);
  assert.equal(v.ref, 'NB' + a);
  assert.match(v.onderwerp, /^NOG BETALEN - Tolgaarde - .+ € 412,8\d - uiterlijk 3-12( - LET OP)?$/);
  assert.ok(v.bericht.includes('Kenmerk NB' + a));
  const f = D.factuurVoorKern(t.fdb, a);
  assert.equal(v.bijlagen.length, 1);
  assert.equal(D.sha256(v.bijlagen[0].bytes), f.document);
  assert.match(v.bijlagen[0].naam, /\.pdf$/);
  const na = t.rij(a);
  assert.deepEqual([na.status, na.claim_dag, na.bijlage_sha256], ['verzenden', '2026-11-19', f.document]);
  assert.equal(t.routes.nogBetalen.voorbereid(t.fdb, r.id, { nu: T }), null, 'tweede keer: niets');
  // al betaald met PayPal → vervallen, geen mail
  const b = nieuweFactuur(t);
  bevestig(t, b);
  const w = new Date(NU).toISOString();
  t.fdb.db.prepare("INSERT INTO paypal_regel (id, account, event_code, status, tijdstip, datum, bedrag_centen, valuta, factuur, aangemaakt_op) VALUES ('PPPROEF0001', 'ACCOUNT01', 'T0006', 'S', '2026-11-18T10:00:00Z', '2026-11-18', -100, 'EUR', ?, ?)").run(b, w);
  const vb = t.routes.nogBetalen.voorbereid(t.fdb, t.rij(b).id, { nu: T });
  assert.deepEqual([vb.actie, vb.status, vb.reden], ['niet', 'vervallen', 'al betaald met creditcard of PayPal']);
  // patiëntkenmerk (geen vastgelegd 'geen kenmerk') → zonder bijlage, zonder vrije omschrijving, LET OP bovenaan
  const c = nieuweFactuur(t, { patient: true });
  bevestig(t, c);
  assert.equal(t.rij(c).zonder_bijlage, 1);
  const vc = t.routes.nogBetalen.voorbereid(t.fdb, t.rij(c).id, { nu: T });
  assert.equal(vc.actie, 'versturen');
  assert.equal(vc.bijlagen.length, 0);
  assert.ok(vc.bericht.startsWith('LET OP - factuur niet bijgevoegd'));
  assert.ok(vc.bericht.endsWith('Factuur niet bijgevoegd. Kenmerk NB' + c));
  assert.match(vc.onderwerp, / - LET OP$/);
  // na Bevestigen op betaald gezien → vervallen
  const d = nieuweFactuur(t);
  bevestig(t, d);
  t.fdb.db.prepare("UPDATE factuur SET betaalspoor = 'betaald_gezien' WHERE id = ?").run(d);
  assert.equal(t.routes.nogBetalen.voorbereid(t.fdb, t.rij(d).id, { nu: T }).status, 'vervallen');
  // te lang gewacht → mislukt
  const e = nieuweFactuur(t);
  bevestig(t, e);
  const ve = t.routes.nogBetalen.voorbereid(t.fdb, t.rij(e).id, { nu: NU + 37 * 3600000 });
  assert.deepEqual([ve.status, ve.reden], ['mislukt', 'wachtte langer dan 36 uur']);
});

test('voorbereid: LET OP bij een zwak bekend IBAN (alleen bankhistorie, < 2 afschrijvingen) en bij een open signaal; dagplafond 25', () => {
  const t = opzet();
  const a = nieuweFactuur(t);
  // het IBAN van de leverancier weghalen uit de vastgelegde rekeningen en één afschrijving in de bankhistorie zetten
  const f = D.factuurVoorKern(t.fdb, a);
  const lev = t.fdb.db.prepare('SELECT naam FROM leverancier WHERE id = ?').get(f.leverancier_id);
  const ctx = { ibanHistorie: () => [{ bron: 'bankhistorie', naam: lev.naam, aantal: 1, laatste: '2026-11-02' }] };
  assert.ok(K.ibanHistorieBekend(f.iban, { naam: lev.naam }, ctx), 'kern kent het IBAN uit de bankhistorie');
  bevestig(t, a);
  const rek = t.fdb.db.prepare('SELECT * FROM leverancier_iban WHERE leverancier = ? AND iban = ?').get(f.leverancier_id, f.iban);
  t.fdb.db.prepare('DELETE FROM leverancier_iban WHERE leverancier = ? AND iban = ?').run(f.leverancier_id, f.iban);
  const tx = t.fdb.db.prepare('SELECT * FROM bank_transactie LIMIT 1').get();
  if (tx) {
    const kol = Object.keys(tx);
    const nieuw = Object.assign({}, tx, { id: D.nieuwId(), tegenpartij_iban: f.iban, tegenpartij_naam: lev.naam, bedrag_centen: -5000, boekdatum: '2026-11-02', verwijderd_op: null });
    for (const k of kol) if (/sleutel|hash|regel_sha|dedup|entry_ref/.test(k) && typeof tx[k] === 'string') nieuw[k] = crypto.randomBytes(32).toString('hex').slice(0, String(tx[k]).length);
    D.voegToe(t.fdb, 'bank_transactie', nieuw);
    const T = Date.parse(t.rij(a).verstuur_na) + 60000;
    const v = t.routes.nogBetalen.voorbereid(t.fdb, t.rij(a).id, { nu: T });
    assert.equal(v.actie, 'versturen');
    assert.ok(v.let_op.includes('rekeningnummer pas sinds 2-11 bekend, niet nagebeld'), JSON.stringify(v.let_op));
  } else assert.fail('zaad heeft geen bankregels');
  if (rek) t.fdb.db.prepare('INSERT INTO leverancier_iban (' + Object.keys(rek).join(', ') + ') VALUES (' + Object.keys(rek).map(() => '?').join(', ') + ')').run(...Object.values(rek));
  // open signaal op de factuur → LET OP; dubbel_betaald niet
  const b = nieuweFactuur(t);
  bevestig(t, b);
  const w = new Date(NU).toISOString();
  t.fdb.db.prepare("INSERT INTO signaal (id, sleutel, soort, titel, facturen, aangemaakt_op) VALUES (?, ?, 'afwijkend_bedrag', 'x', ?, ?)").run(D.nieuwId(), 'p1', JSON.stringify([b]), w);
  t.fdb.db.prepare("INSERT INTO signaal (id, sleutel, soort, titel, facturen, aangemaakt_op) VALUES (?, ?, 'dubbel_betaald', 'x', ?, ?)").run(D.nieuwId(), 'p2', JSON.stringify([b]), w);
  const vb = t.routes.nogBetalen.voorbereid(t.fdb, t.rij(b).id, { nu: Date.parse(t.rij(b).verstuur_na) + 60000 });
  assert.ok(vb.let_op.includes('een betaling week af van het factuurbedrag'));
  assert.ok(!vb.let_op.some((x) => /dubbel/.test(x)));
  // dagplafond: 25 geclaimd vandaag → de volgende blijft wachten
  const c = nieuweFactuur(t);
  bevestig(t, c);
  const T = Date.parse(t.rij(c).verstuur_na) + 60000;
  const dag = new Date(T).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const al = t.n('SELECT count(*) AS n FROM betaal_verzending WHERE claim_dag = ?', dag);
  for (let k = al; k < 25; k++) {
    const x = nieuweFactuur(t);
    bevestig(t, x);
    t.fdb.db.prepare("UPDATE betaal_verzending SET status = 'verzenden', claim_dag = ? WHERE factuur = ?").run(dag, x);
  }
  const vc = t.routes.nogBetalen.voorbereid(t.fdb, t.rij(c).id, { nu: T });
  assert.equal(vc.actie, 'plafond');
  assert.equal(t.rij(c).status, 'wacht');
});

// ───────────────────────────── serverronde ─────────────────────────────

function serverRonde(t, o) {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const i = src.indexOf('// ── wv3369: betaalverzoek naar Cynthia'), j = src.indexOf('setInterval(function () { nbTik()', i);
  assert.ok(i > 0 && j > i);
  const k = src.indexOf('function sdVenster('), venster = src.slice(k, src.indexOf('\n', k));
  const log = { verstuur: [], bericht: [] };
  const appUit = path.join(t.dir, 'app-uit');
  const ctx = vm.createContext({ crypto, Buffer, fs, path, FACTUREN_DIR: t.dir, process: { env: o.env || { FACTUREN_NOGBETALEN: 'auto' } }, Date: o.Date || Date, facturenRoutes: t.routes, SERVER_ECHT: true,
    rolPrimair: () => true, APP_UIT: appUit, SD_VAN: '"David Schaap" <dokterschaap@gmail.com>',
    facturenOpen: () => t.fdb, logError: () => {}, schrijfLog: () => {}, velden: (x) => JSON.stringify(x), nu: () => '', berichtFout: () => new Error('bericht'),
    potVzVerzenderOk: async (b) => (o.verzenderOk ? o.verzenderOk(b) : b === 'nogbetalen'), potVzVerzendGeheim: async () => 'g',
    potVzVerstuur: async (v) => { log.verstuur.push(v); return o.verstuur(v); },
    berichtIntern: async (d) => { log.bericht.push(d); return { status: 200 }; } });
  vm.runInContext(venster + '\n' + src.slice(i, j) + '\nthis.nbTik = nbTik; this.nbInfo = nbInfo;', ctx);
  return { ctx, log, appUit };
}
function klok(ms) { return class extends Date { constructor(...a) { super(...(a.length ? a : [ms])); } static now() { return ms; } }; }

test('serverronde: verstuurd één keer met de vaste afzender en het vaste adres; weigering → mislukt + regel, nooit opnieuw; geen antwoord → onzeker', async () => {
  const t = opzet();
  const a = nieuweFactuur(t);
  bevestig(t, a);
  const T = Date.parse(t.rij(a).verstuur_na) + 60000;
  let x = serverRonde(t, { Date: klok(T), verstuur: () => ({ status: 200, j: { ok: true, message_id: 'msg-1', bijlagen: 1 } }) });
  await x.ctx.nbTik();
  assert.equal(x.log.verstuur.length, 1);
  const v = x.log.verstuur[0];
  assert.deepEqual([v.bron, v.modus, v.aan, v.ref, v.van, v.cc, v.bijlagen.length], ['nogbetalen', 'versturen', AAN, 'NB' + a, '"David Schaap" <dokterschaap@gmail.com>', undefined, 1]);
  assert.deepEqual([t.rij(a).status, t.rij(a).message_id], ['verstuurd', 'msg-1']);
  assert.equal(x.log.bericht.length, 0, 'gelukt = stil');
  await x.ctx.nbTik();
  assert.equal(x.log.verstuur.length, 1, 'tweede ronde verstuurt niets');
  // Toetsen weigert (403) → mislukt + één regel, geen concept, niet opnieuw
  const b = nieuweFactuur(t);
  bevestig(t, b);
  x = serverRonde(t, { Date: klok(T), verstuur: () => ({ status: 403, j: { ok: false, code: 'witte_lijst' } }) });
  await x.ctx.nbTik();
  assert.equal(t.rij(b).status, 'mislukt');
  assert.equal(x.log.bericht.length, 1);
  assert.match(x.log.bericht[0].tekst, /ging niet naar Cynthia/);
  assert.deepEqual([x.log.bericht[0].bron, x.log.bericht[0].soort], ['facturen-nogbetalen', 'dag']);
  await x.ctx.nbTik();
  assert.equal(x.log.verstuur.length, 1);
  // geen antwoord → onzeker, één regel, nooit opnieuw
  const c = nieuweFactuur(t);
  bevestig(t, c);
  x = serverRonde(t, { Date: klok(T), verstuur: () => { throw new Error('time-out'); } });
  await x.ctx.nbTik();
  assert.equal(t.rij(c).status, 'onzeker');
  assert.match(x.log.bericht[0].tekst, /Niet zeker/);
  await x.ctx.nbTik();
  assert.equal(x.log.verstuur.length, 1);
  const info = x.ctx.nbInfo();
  assert.deepEqual([info.aan, info.modus, info.verstuurd, info.mislukt, info.onzeker], [true, 'auto', 1, 1, 1]);
});

test('serverronde: noodstop, buiten 07–23, schakelaar uit, verzender afwijkend → niets; halverwege gestopt → onzeker', async () => {
  const t = opzet();
  const a = nieuweFactuur(t);
  bevestig(t, a);
  const T = Date.parse(t.rij(a).verstuur_na) + 60000;
  const ok = () => ({ status: 200, j: { ok: true, message_id: 'm' } });
  // noodstop
  let x = serverRonde(t, { Date: klok(T), verstuur: ok });
  fs.writeFileSync(x.appUit, '');
  await x.ctx.nbTik();
  assert.deepEqual([t.rij(a).status, x.log.verstuur.length], ['wacht', 0]);
  fs.rmSync(x.appUit);
  // buiten het venster (23:30 Amsterdam)
  const N = Date.parse('2026-11-19T22:30:00Z');
  x = serverRonde(t, { Date: klok(N), verstuur: ok });
  await x.ctx.nbTik();
  assert.deepEqual([t.rij(a).status, x.log.verstuur.length], ['wacht', 0]);
  // schakelaar niet op auto
  for (const env of [{}, { FACTUREN_NOGBETALEN: 'uit' }, { FACTUREN_NOGBETALEN: 'concept' }]) {
    x = serverRonde(t, { Date: klok(T), env, verstuur: ok });
    await x.ctx.nbTik();
    assert.deepEqual([t.rij(a).status, x.log.verstuur.length], ['wacht', 0], JSON.stringify(env));
  }
  // schakelbestand: zonder env telt 'auto' in <FACTUREN_DIR>/nogbetalen-schakelaar; de env gaat voor
  fs.writeFileSync(path.join(t.dir, 'nogbetalen-schakelaar'), 'auto\n');
  x = serverRonde(t, { Date: klok(T), env: { FACTUREN_NOGBETALEN: 'uit' }, verstuur: ok });
  await x.ctx.nbTik();
  assert.deepEqual([t.rij(a).status, x.log.verstuur.length, x.ctx.nbInfo().modus], ['wacht', 0, 'uit'], 'env uit wint van het bestand');
  fs.writeFileSync(path.join(t.dir, 'nogbetalen-schakelaar'), 'uit');
  x = serverRonde(t, { Date: klok(T), env: {}, verstuur: ok });
  assert.equal(x.ctx.nbInfo().modus, 'uit');
  fs.writeFileSync(path.join(t.dir, 'nogbetalen-schakelaar'), ' Auto ');
  assert.equal(x.ctx.nbInfo().modus, 'auto', 'bestand auto zonder env = aan');
  fs.writeFileSync(path.join(t.dir, 'nogbetalen-schakelaar'), 'uit');
  // verzender kent bron nogbetalen niet → niets, rij blijft wachten; pas na 3 uur één regel per dag
  x = serverRonde(t, { Date: klok(T), verzenderOk: () => false, verstuur: ok });
  await x.ctx.nbTik();
  assert.deepEqual([t.rij(a).status, x.log.verstuur.length, x.log.bericht.length], ['wacht', 0, 0]);
  const T4 = T + 4 * 3600000;
  x = serverRonde(t, { Date: klok(T4), verzenderOk: () => false, verstuur: ok });
  await x.ctx.nbTik(); await x.ctx.nbTik();
  assert.equal(x.log.bericht.length, 1);
  assert.match(x.log.bericht[0].tekst, /wachten: de verzender kent ze nog niet/);
  // na 36 uur → mislukt + regel
  const T40 = Date.parse(t.rij(a).aangemaakt_op) + 44 * 3600000;   // 09:30 Amsterdam, binnen het venster
  x = serverRonde(t, { Date: klok(T40), verzenderOk: () => false, verstuur: ok });
  await x.ctx.nbTik();
  assert.equal(t.rij(a).status, 'mislukt');
  assert.ok(x.log.bericht.some((m) => /wachtte langer dan 36 uur/.test(m.tekst)));
  // halverwege gestopt
  const b = nieuweFactuur(t);
  bevestig(t, b);
  const Tb = Date.parse(t.rij(b).verstuur_na) + 60000;
  assert.equal(t.routes.nogBetalen.voorbereid(t.fdb, t.rij(b).id, { nu: Tb }).actie, 'versturen');
  t.fdb.db.prepare('UPDATE betaal_verzending SET bijgewerkt_op = ? WHERE id = ?').run(new Date(Tb - 20 * 60000).toISOString(), t.rij(b).id);
  x = serverRonde(t, { Date: klok(Tb), verstuur: ok });
  await x.ctx.nbTik();
  assert.equal(t.rij(b).status, 'onzeker');
  assert.equal(x.log.verstuur.length, 0);
  assert.match(x.log.bericht[0].tekst, /stopte midden in het versturen/);
});
