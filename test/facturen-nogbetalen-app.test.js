'use strict';
// Toetsen voor fase 2 van het betaalverzoek naar Cynthia (nogbetalen@, wv3372): de stand op de betaallijst en in Beoordelen ("bij Cynthia
// sinds"), de knop Naar Cynthia / Stuur opnieuw (verse vingerafdruk, nooit na onzeker, nooit dubbel), "Laat Cynthia kiezen" bij betaalwijze
// onbekend (zelf + LET OP incasso, leverancier leert geen betaalwijze), de SEPA-waarschuwing "ligt al bij Cynthia" en het betaalverzoek na
// "Toch zelf betalen" en na "Opnieuw betalen" bij een terugboeking. Alles synthetisch (zaad, bankcode TEST); raakt geen pod, mail of vault.
// Draaien: bash test/facturen-nogbetalen-app.sh
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-nb2-'));
  WEG.push(dir);
  const fdb = D.open(path.join(dir, 'db'));
  Z.zaai(fdb, { vandaag: '2026-11-19' });
  const routes = F.maak({ fout: () => {} });
  const eig = F.rolVoor(fdb, { ingang: 'app', wie: 'david (proef)' });
  const t = { dir, fdb, routes, eig, volg: 0, vers: 0 };
  t.call = (methode, rest, d, x) => {
    x = x || {};
    return routes.app(fdb, { methode, pad: '/app/facturen' + (rest ? '/' + rest : ''), d: d || {}, rol: x.rol || eig, primair: true, nu: x.nu || NU,
      versOk: () => x.vers !== false, versVerbruik: () => { t.vers++; }, nogBetalen: x.nogBetalen === undefined ? 'auto' : x.nogBetalen });
  };
  t.n = (sql, ...p) => Number(fdb.db.prepare(sql).get(...p).n);
  t.rij = (factuur) => fdb.db.prepare('SELECT * FROM betaal_verzending WHERE factuur = ? ORDER BY aangemaakt_op DESC, volgnummer DESC LIMIT 1').get(factuur);
  t.rijen = (factuur) => fdb.db.prepare('SELECT * FROM betaal_verzending WHERE factuur = ? ORDER BY aangemaakt_op, volgnummer').all(factuur);
  t.fac = (id) => fdb.db.prepare('SELECT * FROM factuur WHERE id = ?').get(id);
  // praktijkmanager (smalle ingang) voor Tolgaarde
  t.pm = () => { fdb.db.prepare("UPDATE gebruiker SET actief = 1 WHERE rol = 'praktijkmanager'").run(); return F.rolVoor(fdb, { ingang: 'fac', email: 'praktijkmanager@voorbeeld.invalid' }); };
  return t;
}
// Een te beoordelen factuur van een bekende leverancier (IBAN bekend), met een PDF op schijf en de patiëntregel 'geen kenmerk'.
function nieuweFactuur(t, o) {
  o = o || {};
  const ent = o.entiteit || 'tolgaarde';
  const lev = t.fdb.db.prepare("SELECT l.id, l.naam, (SELECT iban FROM leverancier_iban WHERE leverancier = l.id ORDER BY iban LIMIT 1) AS iban FROM leverancier l " +
    "WHERE EXISTS (SELECT 1 FROM leverancier_iban WHERE leverancier = l.id) ORDER BY l.naam LIMIT 1 OFFSET ?").get(o.lev || 0);
  t.volg++;
  const st = D.stukSchrijf(t.fdb, Buffer.from('%PDF-1.4\nnb2-proef ' + t.volg + ' ' + crypto.randomBytes(4).toString('hex') + '\n%%EOF'));
  const did = D.nieuwId(), id = D.nieuwId(), w = new Date(NU - 3600000).toISOString();
  D.voegToe(t.fdb, 'document', { id: did, sha256: st.sha256, naam: 'Voorbeeld factuur ' + t.volg + '.pdf', mime: 'application/pdf', bytes: st.bytes, soort: 'pdf', tekstlaag: 1, aangemaakt_op: w });
  const incl = o.incl || 41280 + t.volg;
  D.voegToe(t.fdb, 'factuur', Object.assign({ id, document: did, soort: 'factuur', leverancier: lev.id, leverancier_naam: lev.naam, nummer: 'NB2-' + String(t.volg).padStart(4, '0'),
    factuurdatum: '2026-11-10', vervaldatum: '2026-12-03', excl: Math.round(incl / 1.21), btw: incl - Math.round(incl / 1.21), incl, valuta: 'EUR', iban: lev.iban, ibans_betaal: [lev.iban],
    betaalwijze: o.betaalwijze || 'zelf', entiteit: ent, status: 'te_beoordelen', aangemaakt_op: w, bijgewerkt_op: w }, o.velden || {}));
  t.fdb.db.prepare("INSERT INTO besluit (factuur, stap, veld, waarde, bron, wie, wanneer) VALUES (?, 'patientkenmerk', 'patientkenmerk', '0', 'regel', 'proef', ?)").run(id, w);
  return { id, lev };
}
function bevestig(t, id, d, x) {
  const f = t.fac(id);
  return t.call('POST', 'bevestig', Object.assign({ id, versie: f.versie }, d || {}), x);
}
// Bevestigd met de schakelaar uit: te_betalen zonder betaalverzoek (zoals de drie facturen van vóór 19-11)
function oudeTeBetalen(t, o) {
  const f = nieuweFactuur(t, o);
  const b = bevestig(t, f.id, {}, { nogBetalen: null });
  assert.equal(b.status, 200, JSON.stringify(b.j));
  assert.equal(b.j.betaalspoor, 'te_betalen');
  assert.equal(t.rij(f.id), undefined);
  return f.id;
}
const betaalRij = (t, id, x) => {
  const r = t.call('GET', 'betalen', null, x);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  return { lijst: r.j, rij: r.j.te_betalen.find((x2) => x2.id === id) };
};

// ───────────────────────────── kern ─────────────────────────────

test('kern letOp (wv3372): toch zelf na incasso vervangt de algemene incassoregel; terugboeking; eerder naar Cynthia', () => {
  assert.deepEqual(K.letOp({ incasso: true, toch: 'incasso' }), ['stond eerst op incasso; David koos toch zelf betalen (kijk of hij niet al is geïncasseerd)']);
  assert.deepEqual(K.letOp({ toch: 'teruggeboekt' }), ['een eerdere betaling van deze factuur is door de bank teruggeboekt; kijk het rekeningnummer na']);
  assert.deepEqual(K.letOp({ eerder_cynthia: { op: '2026-11-12T10:00:00Z', zeker: true } }), ['ging al eerder naar Cynthia (12-11)']);
  assert.deepEqual(K.letOp({ eerder_cynthia: { op: null, zeker: false } }), ['ging misschien al eerder naar Cynthia']);
  assert.deepEqual(K.letOp({ waarschuwingen: ['bij_cynthia'] }), [], 'bij_cynthia is alleen een batchwaarschuwing');
});

// ───────────────────────────── stand op de betaallijst ─────────────────────────────

test('betaallijst: stand per factuur (geen / gaat om / bij Cynthia sinds / niet verstuurd) en knop alleen als het kan; uit = geen knop', () => {
  const t = opzet();
  const oud = oudeTeBetalen(t);
  let { lijst, rij } = betaalRij(t, oud);
  assert.deepEqual(lijst.nogbetalen, { aan: true });
  assert.deepEqual(rij.cynthia, { status: 'geen', op: null, reden: null, knop: 'naar', niet: null });
  // schakelaar uit: stand wel, knop niet
  ({ lijst, rij } = betaalRij(t, oud, { nogBetalen: null }));
  assert.deepEqual(lijst.nogbetalen, { aan: false });
  assert.equal(rij.cynthia.knop, null);
  // na Bevestigen met de schakelaar aan: wacht met het tijdstip
  const nw = nieuweFactuur(t).id;
  const b = bevestig(t, nw);
  ({ rij } = betaalRij(t, nw));
  assert.deepEqual([rij.cynthia.status, rij.cynthia.op, rij.cynthia.knop], ['wacht', b.j.opdracht.verstuur_na, null]);
  // verstuurd → bij Cynthia sinds, geen knop
  const v = t.routes.nogBetalen.voorbereid(t.fdb, t.rij(nw).id, { nu: NU + 2 * 3600000 });
  assert.equal(v.actie, 'versturen');
  assert.equal(t.routes.nogBetalen.uitkomst(t.fdb, v.id, 'verzenden', 'verstuurd', { message_id: 'proef-1', verzonden_op: '2026-11-19T14:31:00Z' }, NU + 2 * 3600000), true);
  ({ rij } = betaalRij(t, nw));
  assert.deepEqual([rij.cynthia.status, rij.cynthia.op, rij.cynthia.knop], ['verstuurd', '2026-11-19T14:31:00Z', null]);
  // de praktijkmanager ziet geen stand (alleen David in zijn app)
  const pm = t.pm();
  const rp = t.call('GET', 'betalen', null, { rol: pm });
  assert.equal(rp.status, 200);
  assert.ok(rp.j.te_betalen.length > 0 && rp.j.te_betalen.every((x) => x.cynthia === undefined) && rp.j.nogbetalen === undefined);
  // Beoordelen (detail) toont dezelfde stand
  const d = t.call('GET', 'factuur/' + nw);
  assert.deepEqual([d.j.nogbetalen.aan, d.j.nogbetalen.stand.status], [true, 'verstuurd']);
});

// ───────────────────────────── knop Naar Cynthia ─────────────────────────────

test('knop Naar Cynthia: verse vingerafdruk, rij knop met verstuur_na = nu, daarna geen tweede; uit/praktijkmanager/Privé/al betaald geweigerd', () => {
  const t = opzet();
  const oud = oudeTeBetalen(t);
  // zonder verse vingerafdruk: 403 vers_nodig, niets gebeurd
  let r = t.call('POST', 'naar-cynthia', { id: oud }, { vers: false });
  assert.equal(r.status, 403);
  assert.equal(r.j.vers_nodig, true);
  assert.equal(t.rij(oud), undefined);
  // schakelaar uit: 409 vóór de vingerafdruk
  const v0 = t.vers;
  r = t.call('POST', 'naar-cynthia', { id: oud }, { nogBetalen: null });
  assert.equal(r.status, 409);
  assert.match(r.j.fout, /staat nog uit/);
  assert.equal(t.vers, v0, 'geen vingerafdruk verbruikt');
  // verkeerde versie
  assert.equal(t.call('POST', 'naar-cynthia', { id: oud, versie: t.fac(oud).versie + 5 }).status, 409);
  // goed
  r = t.call('POST', 'naar-cynthia', { id: oud, versie: t.fac(oud).versie });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(t.vers, v0 + 1);
  assert.equal(r.j.opnieuw, false);
  assert.equal(r.j.nogbetalen.status, 'wacht');
  assert.deepEqual([r.j.cynthia.status, r.j.cynthia.knop], ['wacht', null]);
  const rij = t.rij(oud);
  assert.deepEqual([rij.aanleiding, rij.volgnummer, rij.status, rij.verstuur_na, rij.aangemaakt_door], ['knop', 1, 'wacht', new Date(NU).toISOString(), 'david (proef)']);
  assert.equal(t.routes.nogBetalen.open(t.fdb, NU).filter((x) => x.factuur === oud).length, 1, 'meteen aan de beurt');
  // tweede druk: al onderweg
  r = t.call('POST', 'naar-cynthia', { id: oud });
  assert.equal(r.status, 409);
  assert.match(r.j.fout, /al onderweg/);
  // verstuurd: al bij Cynthia
  const v = t.routes.nogBetalen.voorbereid(t.fdb, rij.id, { nu: NU + 60000 });
  t.routes.nogBetalen.uitkomst(t.fdb, v.id, 'verzenden', 'verstuurd', { message_id: 'proef-2', verzonden_op: new Date(NU + 61000).toISOString() }, NU + 61000);
  r = t.call('POST', 'naar-cynthia', { id: oud });
  assert.equal(r.status, 409);
  assert.match(r.j.fout, /ligt al bij Cynthia/);
  // praktijkmanager: nooit
  assert.equal(t.call('POST', 'naar-cynthia', { id: oudeTeBetalen(t) }, { rol: t.pm() }).status, 403);
  // Privé: geen te_betalen-rij voor Cynthia (bevestigd naar het privé-archief; de knop weigert)
  const p = nieuweFactuur(t, { entiteit: 'prive' }).id;
  bevestig(t, p, {}, { nogBetalen: null });
  r = t.call('POST', 'naar-cynthia', { id: p });
  assert.equal(r.status, 409, JSON.stringify(r.j));
  assert.match(r.j.fout, /Privé/);
  // al betaald gezien op de bank
  const bg = oudeTeBetalen(t);
  t.fdb.db.prepare("UPDATE factuur SET betaalspoor = 'betaald_gezien' WHERE id = ?").run(bg);
  r = t.call('POST', 'naar-cynthia', { id: bg });
  assert.equal(r.status, 409);
  assert.match(r.j.fout, /al betaald gezien/);
  // onbekende factuur
  assert.equal(t.call('POST', 'naar-cynthia', { id: '0123456789abcdef' }).status, 404);
  assert.equal(t.call('POST', 'naar-cynthia', { id: 'x' }).status, 400);
});

test('Stuur opnieuw: na mislukt een nieuwe rij (volgnummer 2); na onzeker nooit (registerrij); hooguit 9', () => {
  const t = opzet();
  const a = oudeTeBetalen(t);
  assert.equal(t.call('POST', 'naar-cynthia', { id: a }).status, 200);
  let v = t.routes.nogBetalen.voorbereid(t.fdb, t.rij(a).id, { nu: NU + 60000 });
  t.routes.nogBetalen.uitkomst(t.fdb, v.id, 'verzenden', 'mislukt', { reden: 'de verzender verstuurde niet (403 proef)' }, NU + 61000);
  let { rij } = betaalRij(t, a);
  assert.deepEqual([rij.cynthia.status, rij.cynthia.reden, rij.cynthia.knop], ['mislukt', 'de verzender verstuurde niet (403 proef)', 'opnieuw']);
  const r = t.call('POST', 'naar-cynthia', { id: a }, { nu: NU + 120000 });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.opnieuw, true);
  assert.deepEqual(t.rijen(a).map((x) => [x.aanleiding, x.volgnummer, x.status]), [['knop', 1, 'mislukt'], ['knop', 2, 'wacht']]);
  // nu onzeker → geen knop meer, route weigert
  v = t.routes.nogBetalen.voorbereid(t.fdb, t.rij(a).id, { nu: NU + 180000 });
  t.routes.nogBetalen.uitkomst(t.fdb, v.id, 'verzenden', 'onzeker', { reden: 'geen bevestiging van de verzender (0)' }, NU + 181000);
  ({ rij } = betaalRij(t, a));
  assert.deepEqual([rij.cynthia.status, rij.cynthia.knop], ['onzeker', null]);
  const r2 = t.call('POST', 'naar-cynthia', { id: a }, { nu: NU + 240000 });
  assert.equal(r2.status, 409);
  assert.match(r2.j.fout, /niet zeker/);
  assert.equal(t.rijen(a).length, 2);
  // hooguit 9 knoprijen (CHECK volgnummer)
  const b = oudeTeBetalen(t);
  for (let i = 1; i <= 9; i++) {
    assert.equal(t.call('POST', 'naar-cynthia', { id: b }, { nu: NU + i * 1000 }).status, 200, 'poging ' + i);
    const w = t.routes.nogBetalen.voorbereid(t.fdb, t.rij(b).id, { nu: NU + i * 1000 + 10 });
    if (w && w.actie === 'versturen') t.routes.nogBetalen.uitkomst(t.fdb, w.id, 'verzenden', 'mislukt', { reden: 'proef' }, NU + i * 1000 + 20);
  }
  const r9 = t.call('POST', 'naar-cynthia', { id: b }, { nu: NU + 20000 });
  assert.equal(r9.status, 409);
  assert.match(r9.j.fout, /9 keer/);
});

test('al verstuurd en daarna teruggeboekt: de knop maakt geen tweede (dat loopt via Opnieuw betalen bij het signaal)', () => {
  const t = opzet();
  const a = oudeTeBetalen(t);
  t.call('POST', 'naar-cynthia', { id: a });
  let v = t.routes.nogBetalen.voorbereid(t.fdb, t.rij(a).id, { nu: NU + 60000 });
  assert.ok(!v.let_op.some((x) => /eerder naar Cynthia/.test(x)), 'eerste keer niet');
  t.routes.nogBetalen.uitkomst(t.fdb, v.id, 'verzenden', 'verstuurd', { message_id: 'proef-3', verzonden_op: '2026-11-19T12:31:00Z' }, NU + 61000);
  // de bank boekt hem terug (bankronde), David tikt daarna zelf op Naar Cynthia
  t.fdb.db.prepare("UPDATE factuur SET betaalspoor = 'te_betalen' WHERE id = ?").run(a);
  D.audit(t.fdb, { wie: 'bankcontrole', wat: 'betaalspoor_teruggeboekt', object_soort: 'factuur', object_id: a, voor: { betaalspoor: 'betaald_gezien' }, na: { betaalspoor: 'te_betalen' }, wanneer: new Date(NU + 3600000).toISOString() });
  const r = t.call('POST', 'naar-cynthia', { id: a }, { nu: NU + 2 * 3600000 });
  assert.equal(r.status, 409, 'al verstuurd = al bij Cynthia (de knop maakt geen tweede)');
});

// ───────────────────────────── Laat Cynthia kiezen ─────────────────────────────

test('Laat Cynthia kiezen: zelf + LET OP incasso, leverancier leert geen betaalwijze; alleen bij onbekend en met de schakelaar aan', () => {
  const t = opzet();
  const { id, lev } = nieuweFactuur(t, { betaalwijze: 'onbekend' });
  const voor = t.fdb.db.prepare('SELECT standaard_betaalwijze FROM leverancier WHERE id = ?').get(lev.id).standaard_betaalwijze;
  // uit → geweigerd, factuur onveranderd
  let r = bevestig(t, id, { betaalwijze: 'zelf', cynthia_kiest: true }, { nogBetalen: null });
  assert.equal(r.status, 409);
  assert.match(r.j.fout, /staat nog uit/);
  assert.equal(t.fac(id).status, 'te_beoordelen');
  // andere betaalwijze dan zelf
  assert.equal(bevestig(t, id, { betaalwijze: 'incasso', cynthia_kiest: true }).status, 400);
  assert.equal(bevestig(t, id, { betaalwijze: 'zelf', cynthia_kiest: 'ja' }).status, 400);
  // goed
  r = bevestig(t, id, { betaalwijze: 'zelf', cynthia_kiest: true });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.betaalspoor, 'te_betalen');
  assert.equal(r.j.nogbetalen.status, 'wacht');
  assert.ok(r.j.nogbetalen.let_op.includes('is misschien via incasso'), JSON.stringify(r.j.nogbetalen.let_op));
  assert.equal(t.fac(id).betaalwijze, 'zelf');
  assert.equal(t.fdb.db.prepare('SELECT standaard_betaalwijze FROM leverancier WHERE id = ?').get(lev.id).standaard_betaalwijze, voor, 'geen standaard geleerd');
  assert.equal(t.n("SELECT count(*) AS n FROM besluit WHERE factuur = ? AND stap = 'leren' AND veld = 'standaard_betaalwijze'", id), 0);
  assert.equal(t.n("SELECT count(*) AS n FROM besluit WHERE factuur = ? AND stap = 'betaalwijze' AND toelichting LIKE 'Laat Cynthia kiezen%'", id), 1);
  // de mail krijgt de LET OP ook bij het versturen (uit de database, niet uit de app)
  const v = t.routes.nogBetalen.voorbereid(t.fdb, t.rij(id).id, { nu: NU + 2 * 3600000 });
  assert.equal(v.actie, 'versturen');
  assert.ok(v.bericht.includes('LET OP - is misschien via incasso'), v.bericht);
  assert.ok(/ - LET OP$/.test(v.onderwerp), v.onderwerp);
  // bekende betaalwijze → geweigerd
  const z = nieuweFactuur(t, { betaalwijze: 'zelf' }).id;
  r = bevestig(t, z, { betaalwijze: 'zelf', cynthia_kiest: true });
  assert.equal(r.status, 409);
  assert.match(r.j.fout, /alleen als de betaalwijze onbekend/);
  // Privé → geweigerd (gaat nooit naar Cynthia), niets opgeslagen
  const p = nieuweFactuur(t, { entiteit: 'prive', betaalwijze: 'onbekend' }).id;
  r = bevestig(t, p, { betaalwijze: 'zelf', cynthia_kiest: true });
  assert.equal(r.status, 409, JSON.stringify(r.j));
  assert.equal(t.fac(p).status, 'te_beoordelen');
  // gewone keuze zelf bij onbekend: leert wél (ter vergelijking, kruisproef op het filter)
  const g = nieuweFactuur(t, { betaalwijze: 'onbekend', lev: 1 });
  t.fdb.db.prepare('UPDATE leverancier SET standaard_betaalwijze = NULL WHERE id = ?').run(g.lev.id);
  assert.equal(bevestig(t, g.id, { betaalwijze: 'zelf' }).status, 200);
  assert.equal(t.fdb.db.prepare('SELECT standaard_betaalwijze FROM leverancier WHERE id = ?').get(g.lev.id).standaard_betaalwijze, 'zelf');
  const g2 = nieuweFactuur(t, { betaalwijze: 'onbekend', lev: 1 });
  t.fdb.db.prepare('UPDATE leverancier SET standaard_betaalwijze = NULL WHERE id = ?').run(g2.lev.id);
  assert.equal(bevestig(t, g2.id, { betaalwijze: 'zelf', cynthia_kiest: true }).status, 200);
  assert.equal(t.fdb.db.prepare('SELECT standaard_betaalwijze FROM leverancier WHERE id = ?').get(g2.lev.id).standaard_betaalwijze, null);
});

// ───────────────────────────── SEPA-batch ─────────────────────────────

test('SEPA-batch: "ligt al bij Cynthia" als waarschuwing; zonder bewust aanvinken gaat hij niet mee; met wel; daarna vervalt de wachtende rij', () => {
  const t = opzet();
  const a = oudeTeBetalen(t);
  let { rij } = betaalRij(t, a);
  assert.ok(!(rij.waarschuwingen || []).some((w) => w.code === 'bij_cynthia'), 'nog niet bij Cynthia');
  t.call('POST', 'naar-cynthia', { id: a });
  ({ rij } = betaalRij(t, a));
  const w = (rij.waarschuwingen || []).find((x) => x.code === 'bij_cynthia');
  assert.ok(w && /ligt al bij Cynthia/.test(w.tekst), JSON.stringify(rij.waarschuwingen));
  const rek = t.call('GET', 'betalen').j.sepa.rekeningen.find((k) => k.entiteit === 'tolgaarde');
  assert.ok(rek, 'Tolgaarde heeft een batchrekening in het zaad');
  let vb = t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: [a], voorbeeld: true });
  assert.equal(vb.status, 200, JSON.stringify(vb.j));
  assert.equal(vb.j.geweigerd.length, 1);
  assert.match(vb.j.geweigerd[0].reden, /ligt al bij Cynthia/);
  vb = t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: [a], voorbeeld: true, bewust: [a + ':bij_cynthia'] });
  assert.equal(vb.j.geweigerd.length, 0, JSON.stringify(vb.j.geweigerd));
  const bt = t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: [a], bewust: [a + ':bij_cynthia'], sleutel: vb.j.sleutel });
  assert.equal(bt.status, 200, JSON.stringify(bt.j));
  assert.equal(t.fac(a).betaalspoor, 'ingevoerd');
  // de wachtende rij gaat niet meer: vervallen (staat niet meer op te betalen)
  const v = t.routes.nogBetalen.voorbereid(t.fdb, t.rij(a).id, { nu: NU + 60000 });
  assert.deepEqual([v.actie, v.status], ['niet', 'vervallen']);
});

// ───────────────────────────── toch zelf, terugboeking ─────────────────────────────

test('Toch zelf betalen (incasso niet gezien) → rij toch_zelf met LET OP; schakelaar uit → geen rij', () => {
  const t = opzet();
  for (const aan of ['auto', null]) {
    const i = nieuweFactuur(t, { betaalwijze: 'incasso' }).id;
    assert.equal(bevestig(t, i, {}, { nogBetalen: aan }).j.betaalspoor, 'incasso_verwacht');
    const sid = D.nieuwId();
    t.fdb.db.prepare("INSERT INTO signaal (id, sleutel, soort, titel, facturen, aangemaakt_op) VALUES (?, ?, 'incasso_niet_gezien', 'proef', ?, ?)")
      .run(sid, 'proef-' + i, JSON.stringify([i]), new Date(NU).toISOString());
    const r = t.call('POST', 'signaal', { id: sid, knop: 'toch_zelf_betalen' }, { nu: NU + 60000, nogBetalen: aan });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.equal(t.fac(i).betaalspoor, 'te_betalen');
    if (aan === 'auto') {
      assert.equal(r.j.nogbetalen.status, 'wacht');
      const rij = t.rij(i);
      assert.deepEqual([rij.aanleiding, rij.volgnummer, rij.status], ['toch_zelf', 1, 'wacht']);
      const lo = JSON.parse(rij.let_op);
      assert.ok(lo.some((x) => /David koos toch zelf betalen/.test(x)), rij.let_op);
      assert.ok(!lo.includes('is misschien via incasso'), 'geen dubbele incassoregel');
      const v = t.routes.nogBetalen.voorbereid(t.fdb, rij.id, { nu: NU + 120000 });
      assert.ok(v.bericht.includes('LET OP - stond eerst op incasso'), v.bericht);
    } else {
      assert.equal(r.j.nogbetalen, undefined);
      assert.equal(t.rij(i), undefined);
      assert.equal(betaalRij(t, i, { nogBetalen: null }).rij.cynthia.status, 'geen');
    }
  }
});

test('Opnieuw betalen bij een terugboeking → rij toch_zelf met LET OP teruggeboekt en "ging al eerder"; Leverancier incasseert → geen rij', () => {
  const t = opzet();
  const maak = () => {
    const a = oudeTeBetalen(t);
    // was verstuurd naar Cynthia, betaald gezien
    t.call('POST', 'naar-cynthia', { id: a });
    const v = t.routes.nogBetalen.voorbereid(t.fdb, t.rij(a).id, { nu: NU + 60000 });
    t.routes.nogBetalen.uitkomst(t.fdb, v.id, 'verzenden', 'verstuurd', { message_id: 'proef-t' + a.slice(-4), verzonden_op: '2026-11-19T12:31:00Z' }, NU + 61000);
    t.fdb.db.prepare("UPDATE factuur SET betaalspoor = 'betaald_gezien', betaald_gezien_op = '2026-11-19' WHERE id = ?").run(a);
    const f = t.fac(a);
    const b = t.fdb.db.prepare("SELECT * FROM bank_transactie WHERE entiteit = 'tolgaarde' AND verwijderd_op IS NULL LIMIT 1").get();
    const tid = D.nieuwId();
    D.voegToe(t.fdb, 'bank_transactie', { id: tid, bestand: b.bestand, rekening: b.rekening, entiteit: 'tolgaarde', eigen_iban: b.eigen_iban, boekdatum: '2026-11-20', bedrag_centen: f.incl,
      valuta: 'EUR', tegenpartij_naam: 'Proef terug', tegenpartij_iban: f.iban, formaat: b.formaat, entry_ref: 'proef:terug-' + tid, alleen_eigenaar: 0, aangemaakt_op: new Date(NU + 86400000).toISOString() });
    const sid = D.nieuwId();
    t.fdb.db.prepare("INSERT INTO signaal (id, sleutel, soort, titel, entiteit, transacties, facturen, aangemaakt_op) VALUES (?, ?, 'teruggeboekt', 'proef', 'tolgaarde', ?, ?, ?)")
      .run(sid, 'proef-terug-' + a, JSON.stringify([tid]), JSON.stringify([a]), new Date(NU + 86400000).toISOString());
    return { a, sid };
  };
  const x = maak();
  const nu2 = NU + 2 * 86400000;
  const r = t.call('POST', 'signaal', { id: x.sid, knop: 'opnieuw_betalen' }, { nu: nu2 });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(t.fac(x.a).betaalspoor, 'te_betalen');
  assert.equal(r.j.nogbetalen && r.j.nogbetalen.status, 'wacht', JSON.stringify(r.j));
  const rij = t.rij(x.a);
  assert.deepEqual([rij.aanleiding, rij.status], ['toch_zelf', 'wacht']);
  const lo = JSON.parse(rij.let_op);
  assert.ok(lo.some((y) => /door de bank teruggeboekt/.test(y)) && lo.some((y) => /ging al eerder naar Cynthia \(19-11\)/.test(y)), rij.let_op);
  assert.equal(betaalRij(t, x.a, { nu: nu2 }).rij.cynthia.status, 'wacht');
  // Leverancier incasseert: spoor incasso verwacht, geen betaalverzoek
  const y = maak();
  const r2 = t.call('POST', 'signaal', { id: y.sid, knop: 'leverancier_incasseert' }, { nu: nu2 });
  assert.equal(r2.status, 200, JSON.stringify(r2.j));
  assert.equal(t.fac(y.a).betaalspoor, 'incasso_verwacht');
  assert.equal(r2.j.nogbetalen, undefined);
  assert.equal(t.rijen(y.a).length, 1, 'alleen de oude, verstuurde rij');
});

test('routes: naar-cynthia staat in ROUTES.POST en past in het app-routepatroon', () => {
  assert.ok(F.ROUTES.POST.includes('naar-cynthia'));
  assert.ok(/^[a-z0-9/-]{1,64}$/.test('naar-cynthia'));
});
