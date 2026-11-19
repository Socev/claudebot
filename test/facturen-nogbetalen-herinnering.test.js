'use strict';
// Toetsen voor wv3455 (fase 3 nogbetalen, registerrij nogbetalen-herinnering): herinnering aan Cynthia als een betaalverzoek na de termijn niet
// betaald op de bank staat. Kern (termijn, bankstand, mailtekst), tabellen herinnering_mail en betaal_herinnering (M28), de ronde in facturen.js
// (één per factuur, bundel per entiteit per dag, plafond 5, bank achter = niets, open voorstel/signaal → David, ontkoppelde factuur wel, 7 dagen
// later één regel aan David) en de serverronde (server.js in een vm: schakelaars, noodstop, venster, verzender, onzeker nooit opnieuw).
// Alles synthetisch (zaad: bankcode TEST, verzonnen leveranciers); raakt geen pod, kluis, mail of vault. Draaien: bash test/facturen-nogbetalen-herinnering.sh
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
const B = require(path.join(ROOT, 'facturen-bank.js'));
const F = require(path.join(ROOT, 'facturen.js'));
const Z = require(path.join(ROOT, 'test', 'facturen-zaad.js'));

const AAN = 'nogbetalen@huisartsentolgaarde.nl';
const NU = Date.parse('2026-11-19T12:30:00Z');    // do 19-11 13:30 Amsterdam: het betaalverzoek
const DI = Date.parse('2026-12-01T09:00:00Z');    // di 1-12 10:00 Amsterdam: na de termijn (30-11) van een factuur met uiterlijk 24-11
const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });

function opzet() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-nh-'));
  WEG.push(dir);
  const fdb = D.open(path.join(dir, 'db'));
  Z.zaai(fdb, { vandaag: '2026-11-19' });
  const routes = F.maak({ fout: () => {} });
  const eig = F.rolVoor(fdb, { ingang: 'app', wie: 'david (proef)' });
  const t = { dir, fdb, routes, eig, volg: 0, H: routes.nogBetalen.herinnering };
  t.call = (methode, rest, d, x) => {
    x = x || {};
    return routes.app(fdb, { methode, pad: '/app/facturen' + (rest ? '/' + rest : ''), d: d || {}, rol: x.rol || eig, primair: true, nu: x.nu || NU,
      versOk: () => true, versVerbruik: () => {}, nogBetalen: 'auto' });
  };
  t.n = (sql, ...p) => Number(fdb.db.prepare(sql).get(...p).n);
  t.fac = (id) => fdb.db.prepare('SELECT * FROM factuur WHERE id = ?').get(id);
  t.her = (fid, soort) => fdb.db.prepare('SELECT * FROM betaal_herinnering WHERE factuur = ? AND soort = ?').get(fid, soort || 'herinnering');
  t.controle = (nu) => D.transactie(fdb, () => F.bankcontroleToepassen(fdb, nu || NU));
  return t;
}
// Bevestigde, zelf te betalen factuur (status verstuurd = boekhouder gehad) met een VERSTUURD betaalverzoek op `op`.
function factuur(t, o) {
  o = o || {};
  const ent = o.entiteit || 'tolgaarde';
  const lev = t.fdb.db.prepare("SELECT l.id, l.naam, (SELECT iban FROM leverancier_iban WHERE leverancier = l.id ORDER BY iban LIMIT 1) AS iban FROM leverancier l " +
    "WHERE EXISTS (SELECT 1 FROM leverancier_iban WHERE leverancier = l.id) ORDER BY l.naam LIMIT 1 OFFSET ?").get(o.lev || 0);
  t.volg++;
  const st = D.stukSchrijf(t.fdb, Buffer.from('%PDF-1.4\nnh-proef ' + t.volg + ' ' + crypto.randomBytes(4).toString('hex') + '\n%%EOF'));
  const did = D.nieuwId(), id = D.nieuwId(), w = new Date(NU - 2 * 86400000).toISOString();
  D.voegToe(t.fdb, 'document', { id: did, sha256: st.sha256, naam: 'Voorbeeld factuur ' + t.volg + '.pdf', mime: 'application/pdf', bytes: st.bytes, soort: 'pdf', tekstlaag: 1, aangemaakt_op: w });
  const incl = o.incl || 52107 + t.volg * 13;
  D.voegToe(t.fdb, 'factuur', { id, document: did, soort: 'factuur', leverancier: lev.id, leverancier_naam: lev.naam, nummer: 'NH-' + String(t.volg).padStart(4, '0'),
    factuurdatum: '2026-11-10', vervaldatum: o.vervaldatum === undefined ? '2026-11-24' : o.vervaldatum, excl: Math.round(incl / 1.21), btw: incl - Math.round(incl / 1.21), incl,
    valuta: 'EUR', iban: lev.iban, ibans_betaal: [lev.iban], betaalwijze: 'zelf', entiteit: ent, status: 'verstuurd', bevestigd_door: 'david (proef)', bevestigd_op: w,
    betaalspoor: 'te_betalen', aangemaakt_op: w, bijgewerkt_op: w });
  t.fdb.db.prepare("INSERT INTO besluit (factuur, stap, veld, waarde, bron, wie, wanneer) VALUES (?, 'patientkenmerk', 'patientkenmerk', '0', 'regel', 'proef', ?)").run(id, w);
  let vz = null;
  if (o.verzoek !== false) {
    const op = new Date(o.op || NU).toISOString();
    vz = D.nieuwId();
    D.voegToe(t.fdb, 'betaal_verzending', { id: vz, factuur: id, aanleiding: 'bevestigen', volgnummer: 1, entiteit: ent, aan: AAN, status: 'wacht', verstuur_na: op,
      aangemaakt_door: 'proef', aangemaakt_op: op, bijgewerkt_op: op });
    t.fdb.db.prepare("UPDATE betaal_verzending SET status = 'verzenden', claim_dag = ? WHERE id = ?").run(op.slice(0, 10), vz);
    if (o.status !== 'verzenden') t.fdb.db.prepare('UPDATE betaal_verzending SET status = ?, verzonden_op = ?, message_id = ? WHERE id = ?').run(o.status || 'verstuurd', op, 'm-' + t.volg, vz);
  }
  return { id, lev, incl, vz };
}
// Een afschrijving op de rekening van `ent` op `dag` (bank bijgewerkt t/m die dag), naar een verzonnen tegenpartij zonder IBAN
function bank(t, ent, dag, o) {
  o = o || {};
  const b = t.fdb.db.prepare('SELECT * FROM bank_transactie WHERE entiteit = ? AND verwijderd_op IS NULL AND bedrag_centen < 0 LIMIT 1').get(ent);
  const tid = D.nieuwId();
  D.voegToe(t.fdb, 'bank_transactie', { id: tid, bestand: b.bestand, rekening: b.rekening, entiteit: ent, eigen_iban: b.eigen_iban, boekdatum: dag,
    bedrag_centen: -(o.bedrag || 1234), valuta: 'EUR', tegenpartij_naam: o.naam || 'Proefwinkel (verzonnen)', tegenpartij_iban: o.iban || null, omschrijving: o.omschrijving || 'proef',
    formaat: b.formaat, entry_ref: 'proef:nh-' + tid, alleen_eigenaar: b.alleen_eigenaar, aangemaakt_op: new Date(NU).toISOString() });
  return tid;
}
const klaar = (t, mail, msg) => t.H.uitkomst(t.fdb, mail, 'verzenden', 'verstuurd', { message_id: msg || 'msg-' + mail.slice(0, 4), verzonden_op: new Date(DI).toISOString() }, DI);

// ───────────────────────────── kern ─────────────────────────────

test('kern herinneringTermijn: latere van uiterlijk en verzoek + 5 werkdagen, zonder uiterlijk + 14 dagen, daarna + 2 bankwerkdagen', () => {
  assert.equal(B.herinneringTermijn('2026-11-24', '2026-11-19'), '2026-11-30', 'do 19-11 + 5 wd = do 26-11 (later dan 24-11) + 2 wd = ma 30-11');
  assert.equal(B.herinneringTermijn('2026-12-10', '2026-11-19'), '2026-12-14', 'uiterlijk do 10-12 + 2 wd = ma 14-12');
  assert.equal(B.herinneringTermijn(null, '2026-11-19'), '2026-12-07', '19-11 + 14 = do 3-12 + 2 wd = ma 7-12');
  assert.equal(B.herinneringTermijn('2026-11-01', '2026-11-20'), '2026-12-01', 'vr 20-11 + 5 wd = vr 27-11 + 2 wd = di 1-12');
  assert.equal(B.herinneringTermijn('2026-11-24', null), null);
  assert.equal(B.herinneringTermijn('onzin', '2026-11-19'), '2026-12-07', 'ongeldige uiterste datum telt als geen');
});

test('kern herinneringStand: alle actieve rekeningen van de entiteit ná de termijn = te laat; één achter = bank achter; precies op de termijn = achter', () => {
  const rek = [{ entiteit: 'x', iban: 'NL90TEST0000000011', controle: 1 }, { entiteit: 'x', iban: 'NL63TEST0000000012', controle: 1 }, { entiteit: 'y', iban: 'NL36TEST0000000013', controle: 1 }];
  const o = (a, b, actief, vandaag) => ({ rekeningen: rek, dekking: new Map([['NL90TEST0000000011', a], ['NL63TEST0000000012', b]].filter((x) => x[1])),
    actief: new Set(actief || ['NL90TEST0000000011', 'NL63TEST0000000012']), vandaag: vandaag || '2026-12-01' });
  const x = { entiteit: 'x', termijn: '2026-11-30' };
  assert.deepEqual(B.herinneringStand(x, o('2026-12-01', '2026-12-01')), { stand: 'te_laat', dekking: '2026-12-01' });
  assert.equal(B.herinneringStand(x, o('2026-12-01', '2026-11-29')).stand, 'bank_achter', 'minst bijgewerkte telt');
  assert.equal(B.herinneringStand(x, o('2026-12-01', '2026-11-30')).stand, 'bank_achter', 'bijgewerkt tót de termijn is niet ná de termijn');
  assert.equal(B.herinneringStand(x, o('2026-12-01', null)).stand, 'bank_achter', 'actieve rekening zonder gegevens');
  assert.equal(B.herinneringStand(x, o('2026-12-01', '2026-11-01', ['NL90TEST0000000011'])).stand, 'te_laat', 'niet-actieve rekening telt niet');
  assert.equal(B.herinneringStand(x, o('2026-12-01', '2026-12-01', [], '2026-12-01')).stand, 'bank_achter', 'geen actieve rekening = niet te meten');
  assert.equal(B.herinneringStand({ entiteit: 'y', termijn: '2026-11-30' }, o('2026-12-01', '2026-12-01')).stand, 'bank_achter', 'rekening van y zonder gegevens');
  assert.equal(B.herinneringStand(x, o('2026-12-01', '2026-12-01', null, '2026-11-30')).stand, 'wacht', 'vandaag = termijn: nog niet');
  assert.equal(B.herinneringStand(Object.assign({}, x, { entiteit: 'x' }), Object.assign(o('2026-12-01', '2026-12-01'), { rekeningen: rek.map((r) => Object.assign({}, r, { controle: 0 })) })).stand,
    'bank_achter', 'rekening zonder controle telt niet: niets te meten');
  // betaalVerwachting gebruikt dezelfde dekking (gedeelde helper): gedrag ongewijzigd
  const f = { id: 'f', entiteit: 'x', betaalspoor: 'ingevoerd', ingevoerd_op: '2026-11-20T09:00:00Z' };
  assert.equal(B.betaalVerwachting(f, o('2026-12-01', '2026-11-24')).stand, 'niet_gezien');
  assert.equal(B.betaalVerwachting(f, o('2026-12-01', '2026-11-23')).stand, 'bank_achter');
  assert.equal(B.betaalVerwachting(f, o('2026-12-01', null)).stand, 'bank_achter');
});

test('kern herinneringMail: onderwerp per entiteit met aantal, geen aanhef, per factuur kenmerk NB, bank t/m, kenmerk NH, proef', () => {
  const m = K.herinneringMail({ id: '0123456789abcdef', entiteit: 'Tolgaarde', bank_tot: '2026-12-01', facturen: [
    { id: 'aaaaaaaaaaaaaaaa', leverancier: 'Voorbeeld BV', centen: 41280, valuta: 'EUR', vervaldatum: '2026-11-24', verzoek_dag: '2026-11-19' },
    { id: 'bbbbbbbbbbbbbbbb', leverancier: 'Test\nBcc: x@voorbeeld.invalid', centen: 1000 }] });
  assert.equal(m.onderwerp, 'NOG NIET BETAALD GEZIEN - Tolgaarde - 2 facturen');
  assert.equal(m.ref, 'NH0123456789abcdef');
  assert.ok(m.bericht.startsWith('Nog niet betaald gezien op de bank:\n\n- Voorbeeld BV € 412,80 - uiterlijk 24-11 - verzoek van 19-11 (kenmerk NBaaaaaaaaaaaaaaaa)\n- Test Bcc: x@voorbeeld.invalid € 10,00 (kenmerk NBbbbbbbbbbbbbbbbb)'), m.bericht);
  assert.ok(m.bericht.includes('De bank van Tolgaarde is bijgewerkt t/m 1-12-2026.'));
  assert.ok(m.bericht.endsWith('Kenmerk NH0123456789abcdef'));
  assert.ok(!/hallo|beste|groet/i.test(m.bericht) && !/NL\d\d/.test(m.bericht), 'geen aanhef, geen IBAN');
  assert.equal(K.herinneringMail({ id: '0123456789abcdef', entiteit: 'X', facturen: [{ id: 'aaaaaaaaaaaaaaaa', centen: 1 }] }).onderwerp, 'NOG NIET BETAALD GEZIEN - X - 1 factuur');
  const p = K.herinneringMail({ id: '0123456789abcdef', entiteit: 'X', proef: true, facturen: [{ id: 'aaaaaaaaaaaaaaaa', centen: 1 }] });
  assert.ok(p.onderwerp.startsWith('PROEF - NOG NIET BETAALD GEZIEN - ') && p.bericht.startsWith('PROEF - '));
  const veel = K.herinneringMail({ id: '0123456789abcdef', entiteit: 'X', facturen: Array.from({ length: 40 }, (_, i) => ({ id: crypto.randomBytes(8).toString('hex'), leverancier: 'L'.repeat(200), centen: i })) });
  assert.ok(veel.bericht.length <= 3000 && /- en nog \d+; vraag David/.test(veel.bericht) && veel.bericht.endsWith('Kenmerk NH0123456789abcdef'), veel.bericht.length);
  const n = veel.bericht.split('\n').filter((r) => /\(kenmerk NB[0-9a-f]{16}\)$/.test(r)).length;
  assert.ok(veel.bericht.includes('- en nog ' + (40 - n) + '; vraag David'), 'telling klopt');
  const kort = K.herinneringMail({ id: '0123456789abcdef', entiteit: 'X', facturen: Array.from({ length: 30 }, (_, i) => ({ id: crypto.randomBytes(8).toString('hex'), leverancier: 'L', centen: i })) });
  assert.ok(kort.bericht.includes('- en nog 5; vraag David') && kort.bericht.length <= 3000, 'hooguit 25 regels');
  assert.throws(() => K.herinneringMail({ id: 'x', facturen: [{ id: 'aaaaaaaaaaaaaaaa' }] }));
  assert.throws(() => K.herinneringMail({ id: '0123456789abcdef', facturen: [] }));
});

// ───────────────────────────── tabellen (M28) ─────────────────────────────

test('M28: alleen nogbetalen@, nooit Privé, begint op verzenden, alleen vooruit, rijen blijven, één per factuur per soort, gemeld_op één keer', () => {
  const t = opzet();
  assert.ok(D.SCHEMA_VERSIE >= 28 && D.TABELLEN.includes('herinnering_mail') && D.TABELLEN.includes('betaal_herinnering'));
  const w = new Date(DI).toISOString();
  const mail = (x) => Object.assign({ id: D.nieuwId(), entiteit: 'tolgaarde', dag: '2026-12-01', aan: AAN, status: 'verzenden', aantal: 1, aangemaakt_op: w, bijgewerkt_op: w }, x);
  assert.throws(() => D.voegToe(t.fdb, 'herinnering_mail', mail({ aan: 'iemand@voorbeeld.invalid' })), /CHECK/);
  assert.throws(() => D.voegToe(t.fdb, 'herinnering_mail', mail({ entiteit: 'prive' })), /CHECK/);
  assert.throws(() => D.voegToe(t.fdb, 'herinnering_mail', mail({ status: 'verstuurd' })), /begint op verzenden/);
  const m1 = mail();
  D.voegToe(t.fdb, 'herinnering_mail', m1);
  assert.throws(() => D.voegToe(t.fdb, 'herinnering_mail', mail()), /UNIQUE/, 'één per entiteit per dag');
  assert.throws(() => t.fdb.db.prepare('DELETE FROM herinnering_mail').run(), /rijen blijven/);
  assert.throws(() => t.fdb.db.prepare("UPDATE herinnering_mail SET aan = 'x@voorbeeld.invalid'").run(), /CHECK|alleen vooruit/);
  t.fdb.db.prepare("UPDATE herinnering_mail SET status = 'onzeker' WHERE id = ?").run(m1.id);
  assert.throws(() => t.fdb.db.prepare("UPDATE herinnering_mail SET status = 'mislukt' WHERE id = ?").run(m1.id), /alleen vooruit/, 'onzeker nooit naar mislukt');
  assert.throws(() => t.fdb.db.prepare("UPDATE herinnering_mail SET status = 'verzenden' WHERE id = ?").run(m1.id), /alleen vooruit/);
  // betaal_herinnering
  const f = factuur(t), zonder = factuur(t, { verzoek: false }), onzeker = factuur(t, { status: 'onzeker' });
  const m2 = mail({ dag: '2026-12-02' });
  D.voegToe(t.fdb, 'herinnering_mail', m2);
  const her = (x) => Object.assign({ factuur: f.id, soort: 'herinnering', verzending: f.vz, entiteit: 'tolgaarde', termijn: '2026-11-30', mail: m2.id, herinnerd_op: w, aangemaakt_op: w }, x);
  assert.throws(() => D.voegToe(t.fdb, 'betaal_herinnering', her({ mail: m1.id })), /alleen een verstuurd betaalverzoek/, 'mail niet meer op verzenden');
  assert.throws(() => D.voegToe(t.fdb, 'betaal_herinnering', her({ factuur: onzeker.id, verzending: onzeker.vz })), /alleen een verstuurd betaalverzoek/, 'onzeker verzoek telt niet');
  assert.throws(() => D.voegToe(t.fdb, 'betaal_herinnering', her({ factuur: zonder.id })), /alleen een verstuurd betaalverzoek/, 'verzending van een andere factuur');
  assert.throws(() => D.voegToe(t.fdb, 'betaal_herinnering', her({ herinnerd_op: null })), /CHECK/, 'herinnerd_op vóór het versturen');
  assert.throws(() => D.voegToe(t.fdb, 'betaal_herinnering', her({ entiteit: 'groenhouten' })), /alleen een verstuurd betaalverzoek/);
  const id = D.voegToe(t.fdb, 'betaal_herinnering', her());
  assert.throws(() => D.voegToe(t.fdb, 'betaal_herinnering', her()), /UNIQUE/, 'hooguit één herinnering per factuur');
  assert.throws(() => D.voegToe(t.fdb, 'betaal_herinnering', her({ soort: 'david', mail: null, herinnerd_op: null })), /CHECK/, 'david vraagt gemeld_op');
  D.voegToe(t.fdb, 'betaal_herinnering', her({ soort: 'david', mail: null, herinnerd_op: null, gemeld_op: w }));
  assert.throws(() => t.fdb.db.prepare('DELETE FROM betaal_herinnering').run(), /rijen blijven/);
  assert.throws(() => t.fdb.db.prepare("UPDATE betaal_herinnering SET herinnerd_op = 'x' WHERE id = ?").run(id), /rijen blijven/);
  t.fdb.db.prepare('UPDATE betaal_herinnering SET gemeld_op = ? WHERE id = ?').run(w, id);
  assert.throws(() => t.fdb.db.prepare("UPDATE betaal_herinnering SET gemeld_op = '2027-01-01' WHERE id = ?").run(id), /alleen gemeld_op één keer/);
  assert.throws(() => t.fdb.db.prepare('UPDATE betaal_herinnering SET gemeld_op = NULL WHERE id = ?').run(id), /alleen gemeld_op één keer/);
  // factuur intussen betaald gezien → geen nieuwe rij
  const g = factuur(t);
  t.fdb.db.prepare("UPDATE factuur SET betaalspoor = 'betaald_gezien' WHERE id = ?").run(g.id);
  assert.throws(() => D.voegToe(t.fdb, 'betaal_herinnering', her({ factuur: g.id, verzending: g.vz })), /alleen een verstuurd betaalverzoek/);
});

// ───────────────────────────── ronde (facturen.js) ─────────────────────────────

test('ronde: termijn voorbij en bank bij → één mail per entiteit met alle te late facturen; niet te laat of geen verstuurd verzoek → niets; één per factuur', () => {
  const t = opzet();
  const a = factuur(t), b = factuur(t, { vervaldatum: null, op: Date.parse('2026-11-12T10:00:00Z') });   // b: 12-11 + 14 = 26-11 + 2 wd = 30-11
  const later = factuur(t, { vervaldatum: '2026-12-10' });   // termijn 14-12
  const nogNiet = factuur(t, { status: 'verzenden' }), zonder = factuur(t, { verzoek: false }), onz = factuur(t, { status: 'onzeker' });
  const g = factuur(t, { entiteit: 'groenhouten', lev: 2 });
  bank(t, 'tolgaarde', '2026-12-01'); bank(t, 'groenhouten', '2026-12-01');
  // vóór de termijn: niets
  let c = t.H.claim(t.fdb, Date.parse('2026-11-30T09:00:00Z'));
  assert.deepEqual([c.mails.length, c.david.length], [0, 0]);
  c = t.H.claim(t.fdb, DI);
  assert.equal(c.mails.length, 2);
  const mt = c.mails.find((m) => m.entiteit === 'tolgaarde'), mg = c.mails.find((m) => m.entiteit === 'groenhouten');
  assert.deepEqual([mt.aan, mt.aantal, mt.onderwerp], [AAN, 2, 'NOG NIET BETAALD GEZIEN - Tolgaarde - 2 facturen']);
  assert.ok(mt.bericht.includes('NB' + a.id) && mt.bericht.includes('NB' + b.id) && !mt.bericht.includes('NB' + later.id) && !mt.bericht.includes('NB' + nogNiet.id));
  assert.ok(!mt.bericht.includes('NB' + zonder.id) && !mt.bericht.includes('NB' + onz.id), 'alleen een verstuurd betaalverzoek');
  assert.equal(mt.ref, 'NH' + mt.id);
  assert.deepEqual([mg.aantal, mg.onderwerp], [1, 'NOG NIET BETAALD GEZIEN - Groenhouten - 1 factuur']);
  assert.ok(t.her(a.id).herinnerd_op && t.her(a.id).mail === mt.id, 'herinnerd_op vóór het versturen');
  assert.equal(t.fdb.db.prepare('SELECT status FROM herinnering_mail WHERE id = ?').get(mt.id).status, 'verzenden');
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'nogbetalen_herinnering'"), 3);
  // tweede ronde dezelfde dag en de dagen erna: niets meer voor dezelfde facturen
  klaar(t, mt.id); klaar(t, mg.id);
  assert.equal(t.H.claim(t.fdb, DI + 3600000).mails.length, 0);
  bank(t, 'tolgaarde', '2026-12-15'); bank(t, 'groenhouten', '2026-12-15');
  c = t.H.claim(t.fdb, Date.parse('2026-12-15T09:00:00Z'));
  assert.deepEqual(c.mails.map((m) => [m.entiteit, m.aantal]), [['tolgaarde', 1]], 'alleen de factuur met de latere termijn');
  assert.ok(c.mails[0].bericht.includes('NB' + later.id) && !c.mails[0].bericht.includes('NB' + a.id), 'hooguit één herinnering per factuur');
  assert.equal(t.n("SELECT count(*) AS n FROM betaal_herinnering WHERE factuur = ? AND soort = 'herinnering'", a.id), 1);
});

test('ronde: bank achter (één actieve rekening niet ná de termijn) → geen herinnering; daarna wel', () => {
  const t = opzet();
  const a = factuur(t);
  bank(t, 'tolgaarde', '2026-11-30');   // bijgewerkt tót de termijn, niet erna
  assert.equal(t.H.claim(t.fdb, DI).mails.length, 0);
  assert.equal(t.H.standen(t.fdb, DI).find((x) => x.factuur === a.id).stand, 'bank_achter');
  assert.equal(t.H.info(t.fdb, DI).open.bank_achter, 1);
  bank(t, 'tolgaarde', '2026-12-01');
  const c = t.H.claim(t.fdb, DI);
  assert.equal(c.mails.length, 1);
  // entiteit zonder actieve rekening (holding: rekening met controle maar geen afschrijvingen) → niet te meten → nooit
  const h = factuur(t, { entiteit: 'holding', lev: 4 });
  assert.equal(t.H.standen(t.fdb, Date.parse('2026-12-02T09:00:00Z')).find((x) => x.factuur === h.id).stand, 'bank_achter');
  assert.equal(t.H.claim(t.fdb, Date.parse('2026-12-02T09:00:00Z')).mails.length, 0);
});

test('ronde: per entiteit hooguit één mail per dag (later te laat → volgende dag), plafond 5 mails per dag over alle entiteiten', () => {
  const t = opzet();
  factuur(t);
  bank(t, 'tolgaarde', '2026-12-01');
  let c = t.H.claim(t.fdb, DI);
  assert.equal(c.mails.length, 1);
  klaar(t, c.mails[0].id);
  const b = factuur(t);   // zelfde termijn, maar pas na de eerste ronde verstuurd/gezien (bv. ontkoppeld)
  c = t.H.claim(t.fdb, DI + 2 * 3600000);
  assert.deepEqual([c.mails.length, !!t.her(b.id)], [0, false], 'tweede mail voor Tolgaarde op dezelfde dag: nee');
  c = t.H.claim(t.fdb, Date.parse('2026-12-02T08:00:00Z'));
  assert.deepEqual(c.mails.map((m) => m.aantal), [1]);
  assert.ok(c.mails[0].bericht.includes('NB' + b.id));
  // plafond: vijf mails vandaag al (andere entiteiten) → Groenhouten wacht, plafond gemeld
  const t2 = opzet();
  const w = new Date(DI).toISOString();
  for (const e of ['holding', 'pot', 'kostenmaatschap', 'sloel', 'sel'])
    D.voegToe(t2.fdb, 'herinnering_mail', { id: D.nieuwId(), entiteit: e, dag: '2026-12-01', aan: AAN, status: 'verzenden', aantal: 1, aangemaakt_op: w, bijgewerkt_op: w });
  const gg = factuur(t2, { entiteit: 'groenhouten', lev: 2 });
  bank(t2, 'groenhouten', '2026-12-01');
  c = t2.H.claim(t2.fdb, DI);
  assert.deepEqual([c.mails.length, c.plafond, !!t2.her(gg.id)], [0, true, false]);
  c = t2.H.claim(t2.fdb, Date.parse('2026-12-02T08:00:00Z'));
  assert.deepEqual([c.mails.length, c.plafond], [1, false], 'volgende dag wel');
});

test('ronde: open koppelvoorstel of open signaal → één regel aan David, geen herinnering; te_betalen_niet_betaald houdt niets tegen', () => {
  const t = opzet();
  const a = factuur(t), b = factuur(t), c0 = factuur(t);
  bank(t, 'tolgaarde', '2026-12-01');
  const tx = bank(t, 'tolgaarde', '2026-11-28', { bedrag: a.incl - 100, iban: a.lev.iban, naam: a.lev.naam });
  const w = new Date(DI - 86400000).toISOString();
  t.fdb.db.prepare("INSERT INTO voorstel (sleutel, transactie, facturen, methode, zekerheid, details, status, aangemaakt_op) VALUES (?, ?, ?, 'iban_bedrag', 0.6, ?, 'open', ?)")
    .run('proef-nh-' + a.id, tx, JSON.stringify([a.id]), JSON.stringify({ reden: 'bedrag wijkt af' }), w);
  const sig = (soort, fid) => t.fdb.db.prepare("INSERT INTO signaal (id, sleutel, soort, titel, entiteit, facturen, status, aangemaakt_op) VALUES (?, ?, ?, 'proef', 'tolgaarde', ?, 'open', ?)")
    .run(D.nieuwId(), 'proef-' + soort + '-' + fid, soort, JSON.stringify([fid]), w);
  sig('onbekend_iban', b.id);
  sig('te_betalen_niet_betaald', c0.id);
  const c = t.H.claim(t.fdb, DI);
  assert.deepEqual(c.david.map((x) => x.factuur).sort(), [a.id, b.id].sort());
  assert.match(c.david.find((x) => x.factuur === a.id).reden, /koppelvoorstel/);
  assert.match(c.david.find((x) => x.factuur === b.id).reden, /signaal.*onbekend_iban/);
  assert.equal(c.mails.length, 1);
  assert.ok(c.mails[0].bericht.includes('NB' + c0.id) && !c.mails[0].bericht.includes('NB' + a.id) && !c.mails[0].bericht.includes('NB' + b.id));
  assert.ok(t.her(a.id, 'david').gemeld_op && !t.her(a.id));
  // tweede ronde: geen tweede regel aan David
  assert.equal(t.H.claim(t.fdb, Date.parse('2026-12-02T09:00:00Z')).david.length, 0);
  // voorstel afgehandeld → de factuur krijgt alsnog (hooguit één) herinnering
  t.fdb.db.prepare("UPDATE voorstel SET status = 'afgewezen', afgehandeld_door = 'david (proef)', afgehandeld_op = ? WHERE sleutel = ?").run(w, 'proef-nh-' + a.id);
  const c2 = t.H.claim(t.fdb, Date.parse('2026-12-02T09:00:00Z'));
  assert.equal(c2.mails.length, 1);
  assert.ok(c2.mails[0].bericht.includes('NB' + a.id));
  assert.deepEqual(t.H.info(t.fdb, DI).david, 2);
});

test('ronde: betaald gezien → niets; ontkoppeld (verkeerde koppeling los) → wel een herinnering', () => {
  const t = opzet();
  const f = factuur(t);
  bank(t, 'tolgaarde', '2026-12-01');
  const tx = bank(t, 'tolgaarde', '2026-11-25', { bedrag: f.incl, iban: f.lev.iban, naam: f.lev.naam, omschrijving: 'NH-0001' });
  t.controle(Date.parse('2026-11-26T09:00:00Z'));
  assert.equal(t.fac(f.id).betaalspoor, 'betaald_gezien', 'bankcontrole koppelde');
  assert.deepEqual(t.H.standen(t.fdb, DI), [], 'betaald: geen kandidaat');
  assert.equal(t.H.claim(t.fdb, DI).mails.length, 0);
  const r = t.call('POST', 'ontkoppel', { transactie: tx, factuur: f.id }, { nu: DI });
  assert.equal(r.status, 200, JSON.stringify(r.body || r));
  assert.equal(t.fac(f.id).betaalspoor, 'te_betalen');
  const c = t.H.claim(t.fdb, DI + 60000);
  assert.equal(c.mails.length, 1);
  assert.ok(c.mails[0].bericht.includes('NB' + f.id));
});

test('7 dagen na een verstuurde herinnering nog niet betaald → één regel aan David, één keer; betaald of onzeker → nooit', () => {
  const t = opzet();
  const a = factuur(t), b = factuur(t);
  bank(t, 'tolgaarde', '2026-12-01');
  const m = t.H.claim(t.fdb, DI).mails[0];
  assert.equal(m.aantal, 2);
  assert.deepEqual(t.H.naWeek(t.fdb, DI + 8 * 86400000), [], 'mail nog niet verstuurd: geen regel');
  klaar(t, m.id);
  assert.deepEqual(t.H.naWeek(t.fdb, DI + 6 * 86400000), []);
  t.fdb.db.prepare("UPDATE factuur SET betaalspoor = 'betaald_gezien' WHERE id = ?").run(b.id);
  const w = t.H.naWeek(t.fdb, DI + 7 * 86400000);
  assert.deepEqual(w.map((x) => x.factuur), [a.id]);
  assert.ok(t.her(a.id).gemeld_op && !t.her(b.id).gemeld_op);
  assert.deepEqual(t.H.naWeek(t.fdb, DI + 8 * 86400000), [], 'één keer');
  // onzekere mail: geen weekregel (David hoorde het al)
  const t2 = opzet();
  factuur(t2); bank(t2, 'tolgaarde', '2026-12-01');
  const m2 = t2.H.claim(t2.fdb, DI).mails[0];
  t2.H.uitkomst(t2.fdb, m2.id, 'verzenden', 'onzeker', { reden: 'geen antwoord' }, DI);
  assert.deepEqual(t2.H.naWeek(t2.fdb, DI + 9 * 86400000), []);
});

test('venster: werkdagen 08:00–17:00 Amsterdam, geen weekend of feestdag', () => {
  const t = opzet();
  const v = (iso) => t.H.venster(Date.parse(iso));
  assert.equal(v('2026-12-01T07:00:00Z'), true, 'di 08:00');
  assert.equal(v('2026-12-01T06:59:00Z'), false, 'di 07:59');
  assert.equal(v('2026-12-01T15:59:00Z'), true, 'di 16:59');
  assert.equal(v('2026-12-01T16:00:00Z'), false, 'di 17:00');
  assert.equal(v('2026-12-05T10:00:00Z'), false, 'zaterdag');
  assert.equal(v('2026-12-25T10:00:00Z'), false, 'eerste kerstdag');
  assert.equal(v('2027-04-27T10:00:00Z'), false, 'Koningsdag');
  assert.equal(v('2027-05-06T10:00:00Z'), false, 'Hemelvaart 2027');
  assert.equal(v('2027-03-26T10:00:00Z'), false, 'Goede Vrijdag 2027');
  assert.equal(v('2026-06-30T06:30:00Z'), true, 'zomertijd: 08:30');
});

// ───────────────────────────── serverronde ─────────────────────────────

function serverRonde(t, o) {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const i = src.indexOf('// ── wv3369: betaalverzoek naar Cynthia'), j = src.indexOf('setInterval(function () { nhTik()', i);
  assert.ok(i > 0 && j > i);
  const k = src.indexOf('function sdVenster('), venster = src.slice(k, src.indexOf('\n', k));
  const log = { verstuur: [], bericht: [], verzenderOk: [] };
  const appUit = path.join(t.dir, 'app-uit');
  const env = o.env || { FACTUREN_NOGBETALEN: 'auto', FACTUREN_NB_HERINNERING: 'auto' };
  const ctx = vm.createContext({ crypto, Buffer, fs, path, FACTUREN_DIR: t.dir, process: { env }, Date: o.Date || Date, facturenRoutes: t.routes, SERVER_ECHT: true,
    rolPrimair: () => true, APP_UIT: appUit, SD_VAN: '"David Schaap" <dokterschaap@gmail.com>', setInterval: () => ({ unref() {} }), setTimeout: () => ({ unref() {} }),
    facturenOpen: () => t.fdb, logError: () => {}, schrijfLog: () => {}, velden: (x) => JSON.stringify(x), nu: () => '', berichtFout: () => new Error('bericht'),
    potVzVerzenderOk: async (b) => { log.verzenderOk.push(b); return o.verzenderOk ? o.verzenderOk(b) : true; }, potVzVerzendGeheim: async () => 'g',
    potVzVerstuur: async (v) => { log.verstuur.push(v); if (o.voor) o.voor(v); return o.verstuur(v); },
    berichtIntern: async (d) => { log.bericht.push(d); return { status: 200 }; } });
  vm.runInContext(venster + '\n' + src.slice(i, j) + '\nthis.nhTik = nhTik; this.nhInfo = nhInfo; this.nbTik = nbTik;', ctx);
  return { ctx, log, appUit };
}
function klok(ms) { return class extends Date { constructor(...a) { super(...(a.length ? a : [ms])); } static now() { return ms; } }; }
const okV = () => ({ status: 200, j: { ok: true, message_id: 'msg-h', bijlagen: 0 } });
const wacht = () => new Promise((r) => setImmediate(r));

test('serverronde: verstuurd via bron nogbetalen_herinnering naar alleen nogbetalen@, geen cc of bijlage; daarna nooit opnieuw', async () => {
  const t = opzet();
  factuur(t); factuur(t, { entiteit: 'groenhouten', lev: 2 });
  bank(t, 'tolgaarde', '2026-12-01'); bank(t, 'groenhouten', '2026-12-01');
  let x = serverRonde(t, { Date: klok(DI), verstuur: okV });
  await x.ctx.nhTik();
  assert.equal(x.log.verstuur.length, 2);
  for (const v of x.log.verstuur) {
    assert.deepEqual([v.bron, v.modus, v.aan, v.van, v.cc, v.bijlagen.length], ['nogbetalen_herinnering', 'versturen', AAN, '"David Schaap" <dokterschaap@gmail.com>', undefined, 0]);
    assert.match(v.onderwerp, /^NOG NIET BETAALD GEZIEN - (Tolgaarde|Groenhouten) - 1 factuur$/);
    assert.ok(/^NH[0-9a-f]{16}$/.test(v.ref) && v.bericht.includes('Kenmerk ' + v.ref));
  }
  assert.ok(x.log.verzenderOk.includes('nogbetalen_herinnering'));
  assert.equal(t.n("SELECT count(*) AS n FROM herinnering_mail WHERE status = 'verstuurd' AND message_id = 'msg-h'"), 2);
  assert.equal(x.log.bericht.length, 0, 'gelukt = stil');
  await x.ctx.nhTik();
  x = serverRonde(t, { Date: klok(Date.parse('2026-12-03T09:00:00Z')), verstuur: okV });
  await x.ctx.nhTik();
  assert.equal(x.log.verstuur.length, 0, 'hooguit één per factuur');
  const info = x.ctx.nhInfo();
  assert.deepEqual([info.aan, info.modus, info.verstuurd, info.herinnerd], [true, 'auto', 2, 2]);
  // na 7 dagen: één regel aan David
  x = serverRonde(t, { Date: klok(Date.parse('2026-12-08T09:30:00Z')), verstuur: okV });
  await x.ctx.nhTik(); await wacht();
  assert.equal(x.log.bericht.length, 1);
  assert.match(x.log.bericht[0].tekst, /Een week na de herinnering aan Cynthia nog niet betaald gezien/);
  assert.deepEqual([x.log.bericht[0].bron, x.log.bericht[0].kanaal], ['facturen-nogbetalen', 'hoofd']);
  await x.ctx.nhTik(); await wacht();
  assert.equal(x.log.bericht.length, 1, 'één keer');
});

test('serverronde: geen antwoord → onzeker + regel, nooit opnieuw; weigering → mislukt + regel, nooit opnieuw; halverwege gestopt → onzeker', async () => {
  const t = opzet();
  const a = factuur(t);
  bank(t, 'tolgaarde', '2026-12-01');
  let x = serverRonde(t, { Date: klok(DI), verstuur: () => { throw new Error('time-out'); } });
  await x.ctx.nhTik(); await wacht();
  assert.equal(t.fdb.db.prepare('SELECT status FROM herinnering_mail').get().status, 'onzeker');
  assert.match(x.log.bericht[0].tekst, /Niet zeker of de herinnering aan Cynthia/);
  x = serverRonde(t, { Date: klok(Date.parse('2026-12-02T09:00:00Z')), verstuur: okV });
  await x.ctx.nhTik();
  assert.equal(x.log.verstuur.length, 0, 'onzeker: nooit opnieuw');
  assert.ok(t.her(a.id));
  // zekere weigering
  const t2 = opzet();
  factuur(t2); bank(t2, 'tolgaarde', '2026-12-01');
  x = serverRonde(t2, { Date: klok(DI), verstuur: () => ({ status: 403, j: { ok: false, code: 'witte_lijst' } }) });
  await x.ctx.nhTik(); await wacht();
  assert.equal(t2.fdb.db.prepare('SELECT status FROM herinnering_mail').get().status, 'mislukt');
  assert.match(x.log.bericht[0].tekst, /ging niet weg: de verzender verstuurde niet \(403 witte_lijst\)/);
  x = serverRonde(t2, { Date: klok(Date.parse('2026-12-02T09:00:00Z')), verstuur: okV });
  await x.ctx.nhTik();
  assert.equal(x.log.verstuur.length, 0, 'geen herkansing');
  // halverwege gestopt: rij op verzenden, ouder dan 15 min → onzeker + regel, niets verstuurd
  const t3 = opzet();
  factuur(t3); bank(t3, 'tolgaarde', '2026-12-01');
  const m = t3.H.claim(t3.fdb, DI).mails[0];
  x = serverRonde(t3, { Date: klok(DI + 20 * 60000), verstuur: okV });
  await x.ctx.nhTik(); await wacht();
  assert.equal(t3.fdb.db.prepare('SELECT status FROM herinnering_mail WHERE id = ?').get(m.id).status, 'onzeker');
  assert.equal(x.log.verstuur.length, 0);
  assert.match(x.log.bericht[0].tekst, /stopte midden in het versturen/);
});

test('serverronde: schakelaars, noodstop, venster en verzender houden alles tegen (geen claim)', async () => {
  const t = opzet();
  factuur(t);
  bank(t, 'tolgaarde', '2026-12-01');
  const geen = async (o, waarom) => {
    const x = serverRonde(t, Object.assign({ Date: klok(DI), verstuur: okV }, o));
    if (o.noodstop) fs.writeFileSync(x.appUit, '');
    await x.ctx.nhTik();
    if (o.noodstop) fs.rmSync(x.appUit);
    assert.deepEqual([x.log.verstuur.length, t.n('SELECT count(*) AS n FROM herinnering_mail'), t.n('SELECT count(*) AS n FROM betaal_herinnering')], [0, 0, 0], waarom);
    return x;
  };
  await geen({ env: { FACTUREN_NOGBETALEN: 'auto' } }, 'herinnering-schakelaar niet gezet');
  await geen({ env: { FACTUREN_NOGBETALEN: 'auto', FACTUREN_NB_HERINNERING: 'uit' } }, 'herinnering uit');
  await geen({ env: { FACTUREN_NOGBETALEN: 'uit', FACTUREN_NB_HERINNERING: 'auto' } }, 'betaalverzoek uit = herinnering uit');
  await geen({ env: { FACTUREN_NB_HERINNERING: 'auto' } }, 'betaalverzoek-schakelaar niet gezet');
  await geen({ noodstop: true }, 'noodstop');
  await geen({ Date: klok(Date.parse('2026-12-01T16:30:00Z')) }, '17:30');
  await geen({ Date: klok(Date.parse('2026-12-05T10:00:00Z')) }, 'zaterdag');
  const x = await geen({ verzenderOk: (b) => b !== 'nogbetalen_herinnering' }, 'verzender kent de bron niet');
  await wacht();
  assert.equal(x.log.bericht.length, 1);
  assert.match(x.log.bericht[0].tekst, /Herinneringen aan Cynthia \(nogbetalen@\) wachten: de verzender kent ze nog niet/);
  // schakelbestand: zonder env telt het bestand; de env gaat voor
  fs.writeFileSync(path.join(t.dir, 'nogbetalen-schakelaar'), 'auto');
  fs.writeFileSync(path.join(t.dir, 'nogbetalen-herinnering-schakelaar'), 'auto\n');
  await geen({ env: { FACTUREN_NB_HERINNERING: 'uit' } }, 'env uit wint van het bestand');
  const y = serverRonde(t, { Date: klok(DI), env: {}, verstuur: okV });
  assert.equal(y.ctx.nhInfo().modus, 'auto');
  // noodstop tussen claim en versturen: mailrij mislukt (zeker niet verstuurd), regel, nooit opnieuw
  const z = serverRonde(t, { Date: klok(DI), env: {}, verstuur: okV });
  const echt = t.routes.nogBetalen.herinnering.claim;
  t.routes.nogBetalen.herinnering.claim = (fdb, nu, o) => { const c = echt(fdb, nu, o); fs.writeFileSync(z.appUit, ''); return c; };
  await z.ctx.nhTik(); await wacht();
  t.routes.nogBetalen.herinnering.claim = echt;
  fs.rmSync(z.appUit);
  assert.deepEqual([z.log.verstuur.length, t.fdb.db.prepare('SELECT status FROM herinnering_mail').get().status], [0, 'mislukt']);
  assert.match(z.log.bericht[0].tekst, /noodstop hield 1 herinnering/);
});

test('serverronde: dagplafond bereikt → één regel per dag', async () => {
  const t = opzet();
  const w = new Date(DI).toISOString();
  for (const e of ['holding', 'pot', 'kostenmaatschap', 'sloel', 'sel'])
    D.voegToe(t.fdb, 'herinnering_mail', { id: D.nieuwId(), entiteit: e, dag: '2026-12-01', aan: AAN, status: 'verzenden', aantal: 1, aangemaakt_op: w, bijgewerkt_op: w });
  t.fdb.db.prepare("UPDATE herinnering_mail SET status = 'verstuurd'").run();
  factuur(t); bank(t, 'tolgaarde', '2026-12-01');
  const x = serverRonde(t, { Date: klok(DI), verstuur: okV });
  await x.ctx.nhTik(); await x.ctx.nhTik(); await wacht();
  assert.equal(x.log.verstuur.length, 0);
  assert.equal(x.log.bericht.filter((b) => /dagplafond/.test(b.tekst)).length, 1);
});

test('Codex MOET 2: bundel hooguit 25 facturen (wat de mail toont); de rest de volgende werkdag. MOET 1: betaalde verdringen de weekregel niet', () => {
  const t = opzet();
  const fs30 = Array.from({ length: 52 }, () => factuur(t));
  bank(t, 'tolgaarde', '2026-12-04');
  const dagen = ['2026-12-01T09:00:00Z', '2026-12-02T09:00:00Z', '2026-12-03T09:00:00Z'];
  const aantallen = [];
  for (const d of dagen) {
    const c = t.H.claim(t.fdb, Date.parse(d));
    aantallen.push(c.mails.map((m) => m.aantal).join(','));
    for (const m of c.mails) {
      assert.ok(!/en nog \d+; vraag David/.test(m.bericht), 'elke geclaimde factuur staat in de tekst');
      assert.equal(m.bericht.split('\n').filter((r) => /\(kenmerk NB[0-9a-f]{16}\)$/.test(r)).length, m.aantal);
      klaar(t, m.id);
    }
  }
  assert.deepEqual(aantallen, ['25', '25', '2']);
  assert.equal(t.n("SELECT count(*) AS n FROM betaal_herinnering WHERE soort = 'herinnering'"), 52);
  // de eerste 51 (op volgorde van herinnerd_op) betaald, alleen de laatste niet → toch de weekregel voor die ene
  const volg = t.fdb.db.prepare("SELECT factuur FROM betaal_herinnering WHERE soort = 'herinnering' ORDER BY herinnerd_op, id").all().map((x) => x.factuur);
  for (const fid of volg.slice(0, 51)) t.fdb.db.prepare("UPDATE factuur SET betaalspoor = 'betaald_gezien' WHERE id = ?").run(fid);
  const w = t.H.naWeek(t.fdb, Date.parse('2026-12-11T09:00:00Z'));
  assert.deepEqual(w.map((x) => x.factuur), [volg[51]]);
  assert.equal(fs30.length, 52);
});

