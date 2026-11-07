'use strict';
// wv2661 (David 7-11-2026 16:04, Ja op "Facturen op de pc — werktafel met tabel en groepsknoppen?"): "Bevestig N zonder twijfel" en "Koppel N
// zekere". Toetst dat de pod de poort per factuur (en per koppelvoorstel) zelf opnieuw rekent en niet op de app vertrouwt: een factuur met een
// open signaal, een nieuw IBAN of een andere twijfel gaat niet mee, ook niet als de app hem meestuurt; één verse vingerafdruk voor de groep;
// hooguit 25; versie wint; per factuur de gewone bevestig-route (opdracht in de wachtrij, terugdraaien per factuur blijft); alleen de eigenaar in
// zijn eigen app. Raakt /opt/data/facturen, n8n, Gmail en de vault niet: wegwerpdatabase met zaaddata.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'facturen-db.js'));
const F = require(path.join(ROOT, 'facturen.js'));
const Z = require(path.join(ROOT, 'test', 'facturen-zaad.js'));

const NU = Date.parse('2026-10-22T12:30:00Z');
const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });

function opzet() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-groep-'));
  WEG.push(dir);
  const fdb = D.open(path.join(dir, 'db'));
  Z.zaai(fdb, { vandaag: '2026-10-22' });
  const routes = F.maak({ fout: () => {} });
  const eig = F.rolVoor(fdb, { ingang: 'app', wie: 'david (proef)' });
  const t = { fdb, routes, eig, vers: 0 };
  t.call = (methode, rest, d, x) => routes.app(fdb, { methode, pad: '/app/facturen' + (rest ? '/' + rest : ''), d: d || {}, rol: (x && x.rol) || eig, primair: true, nu: NU,
    versOk: () => !(x && x.vers === false), versVerbruik: () => { t.vers++; } });
  t.fac = (id) => fdb.db.prepare('SELECT * FROM factuur WHERE id = ?').get(id);
  // alle "gewone" facturen zo maken als een zekere factuur in het echt is (zoals test/facturen-direct.test.js t.kies): tekstlaag, patiëntregel
  // 'geen kenmerk' vastgelegd, geen open signaal, geen opgeslagen twijfelcontrole
  const kandidaten = fdb.db.prepare("SELECT f.* FROM factuur f JOIN document d ON d.id = f.document WHERE f.status = 'te_beoordelen' AND f.leverancier IS NOT NULL " +
    "AND f.entiteit IN ('tolgaarde','groenhouten','holding','kostenmaatschap') AND f.betaalwijze <> 'onbekend' AND f.iban_nieuw = 0 AND f.patientkenmerk = 0 " +
    "AND f.valuta = 'EUR' AND f.incl > 0 AND f.dubbel_van IS NULL AND f.nagebeld_op IS NULL AND d.soort = 'pdf' ORDER BY f.aangemaakt_op, f.id").all();
  for (const f of kandidaten) {
    fdb.db.prepare("UPDATE factuur SET controles = '[]', redenen = '[]' WHERE id = ?").run(f.id);
    fdb.db.prepare('UPDATE document SET tekstlaag = 1, patientkenmerk = 0 WHERE id = ?').run(f.document);
    fdb.db.prepare("INSERT INTO besluit (factuur, stap, veld, waarde, bron, toelichting, wanneer) VALUES (?, 'patientkenmerk', 'patientkenmerk', '0', 'regel', 'geen kenmerk', ?)").run(f.id, new Date(NU).toISOString());
    fdb.db.prepare("UPDATE signaal SET status = 'afgehandeld', afhandeling = 'proef', wie = 'proef', wanneer = ? WHERE EXISTS (SELECT 1 FROM json_each(signaal.facturen) j WHERE j.value = ?)").run(new Date(NU).toISOString(), f.id);
  }
  t.lijst = () => t.call('GET', 'lijst/beoordelen').j.facturen;
  t.zeker = () => t.lijst().filter((f) => f.zeker && f.zeker.ok);
  t.twijfel = () => t.lijst().filter((f) => f.zeker && !f.zeker.ok);
  return t;
}
const sig = (t, fid) => t.fdb.db.prepare("INSERT INTO signaal (id, sleutel, soort, titel, facturen, aangemaakt_op) VALUES (?, ?, 'incasso_niet_gezien', 'proef', ?, '2026-10-22T10:00:00Z')")
  .run(D.nieuwId(), 'proef-' + fid, JSON.stringify([fid]));

test('lijst Beoordelen: elke factuur krijgt zeker {ok, reden}; de zaad heeft er zekere én twijfelachtige', () => {
  const t = opzet();
  const l = t.lijst();
  assert.ok(l.length > 5);
  assert.ok(l.every((f) => f.zeker && typeof f.zeker.ok === 'boolean'), 'zeker op elke rij');
  assert.ok(t.zeker().length >= 2, JSON.stringify(l.map((f) => f.zeker)));
  const redenen = t.twijfel().map((f) => f.zeker.reden);
  assert.ok(redenen.some((r) => /entiteit/.test(r)) && redenen.some((r) => /Privé/.test(r)) && redenen.some((r) => /IBAN/.test(r)), JSON.stringify(redenen));
});

test('praktijkmanager: geen zeker-veld (de groep is alleen voor David)', () => {
  const t = opzet();
  D.voegToe(t.fdb, 'gebruiker', { id: D.nieuwId(), email: 'pm@proef.invalid', naam: 'PM', ingang: 'fac', rol: 'praktijkmanager', actief: 1, mag_bevestigen: 1 });
  const g = t.fdb.db.prepare("SELECT id FROM gebruiker WHERE email = 'pm@proef.invalid'").get();
  t.fdb.db.prepare("INSERT INTO gebruiker_entiteit (gebruiker, entiteit) VALUES (?, 'tolgaarde')").run(g.id);
  const pm = F.rolVoor(t.fdb, { ingang: 'fac', email: 'pm@proef.invalid' });
  const l = t.call('GET', 'lijst/beoordelen', {}, { rol: pm }).j.facturen;
  assert.ok(l.length > 0 && l.every((f) => f.zeker === undefined));
  assert.equal(t.call('POST', 'bevestig-groep', { facturen: [{ id: l[0].id, versie: l[0].versie }] }, { rol: pm }).status, 403);
});

test('groep: alle zekere in één keer, één vingerafdruk, per factuur de gewone route (opdracht in de wachtrij, terugdraaien per factuur)', () => {
  const t = opzet();
  const z = t.zeker();
  const r = t.call('POST', 'bevestig-groep', { facturen: z.map((f) => ({ id: f.id, versie: f.versie })) });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.bevestigd.length, z.length);
  assert.equal(r.j.geweigerd.length, 0, JSON.stringify(r.j.geweigerd));
  assert.equal(t.vers, 1, 'één vingerafdruk voor de hele groep');
  for (const f of z) {
    assert.equal(t.fac(f.id).status, 'in_wachtrij');
    assert.ok(t.fdb.db.prepare("SELECT 1 FROM opdracht WHERE factuur = ? AND status = 'wacht'").get(f.id), 'opdracht');
    assert.ok(t.fdb.db.prepare("SELECT 1 FROM audit WHERE wat = 'bevestigen' AND object_id = ?").get(f.id), 'gewone audit per factuur');
  }
  assert.ok(r.j.bevestigd.every((x) => x.verstuur_na), 'wachttijd per factuur');
  assert.ok(t.fdb.db.prepare("SELECT 1 FROM audit WHERE wat = 'bevestigen_groep'").get());
  assert.equal(t.call('POST', 'terugdraaien', { id: z[0].id }).status, 200, 'terugdraaien per factuur blijft');
  assert.equal(t.fac(z[0].id).status, 'te_beoordelen');
  // teruggedraaid = niet meer zonder twijfel (zelfde regel als direct verzenden: eerder klaargezet)
  const terug = t.lijst().find((f) => f.id === z[0].id);
  assert.equal(terug.zeker.ok, false); assert.match(terug.zeker.reden, /eerder teruggedraaid/);
});

test('zonder verse vingerafdruk: 403 vers_nodig en niets bevestigd', () => {
  const t = opzet();
  const z = t.zeker();
  const r = t.call('POST', 'bevestig-groep', { facturen: z.map((f) => ({ id: f.id, versie: f.versie })) }, { vers: false });
  assert.equal(r.status, 403); assert.equal(r.j.vers_nodig, true);
  assert.ok(z.every((f) => t.fac(f.id).status === 'te_beoordelen'));
});

// de kern: de app stuurt toch een factuur mee die niet zeker is → de pod neemt hem niet mee, de zekere gaan wel
const TWIJFEL = [
  ['open signaal (pas ná het tonen in de app)', (t, f) => sig(t, f.id), /open signaal/],
  ['nieuw IBAN', (t, f) => t.fdb.db.prepare("UPDATE factuur SET iban_nieuw = 1, ibans_onbekend = '[\"NL00TEST0000009999\"]' WHERE id = ?").run(f.id), /IBAN/],
  ['patiëntkenmerk op het stuk', (t, f) => t.fdb.db.prepare('UPDATE document SET patientkenmerk = 1 WHERE id = ?').run(t.fac(f.id).document), /patiënt/],
  ['scan zonder tekstlaag', (t, f) => t.fdb.db.prepare('UPDATE document SET tekstlaag = 0 WHERE id = ?').run(t.fac(f.id).document), /leesbaar/],
  ['mogelijk dubbel', (t, f) => { const a = t.fdb.db.prepare('SELECT id FROM factuur WHERE id <> ? LIMIT 1').get(f.id); t.fdb.db.prepare('UPDATE factuur SET dubbel_van = ? WHERE id = ?').run(a.id, f.id); }, /dubbel/],
  ['patiëntcontrole niet vastgelegd', (t, f) => t.fdb.db.prepare("DELETE FROM besluit WHERE factuur = ? AND stap = 'patientkenmerk'").run(f.id), /patiëntcontrole/],
];
for (const [naam, maak, reden] of TWIJFEL) {
  test('groep: ' + naam + ' → niet mee (ook al stuurt de app hem), de rest wel', () => {
    const t = opzet();
    const z = t.zeker();
    assert.ok(z.length >= 2);
    maak(t, z[0]);
    const r = t.call('POST', 'bevestig-groep', { facturen: z.map((f) => ({ id: f.id, versie: t.fac(f.id).versie })) });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.deepEqual(r.j.geweigerd.map((x) => x.id), [z[0].id]);
    assert.match(r.j.geweigerd[0].reden, /niet zonder twijfel/);
    assert.match(r.j.geweigerd[0].reden, reden);
    assert.equal(t.fac(z[0].id).status, 'te_beoordelen', 'blijft in Beoordelen');
    assert.ok(!t.fdb.db.prepare('SELECT 1 FROM opdracht WHERE factuur = ?').get(z[0].id), 'geen opdracht');
    assert.ok(z.slice(1).every((f) => t.fac(f.id).status === 'in_wachtrij'));
  });
}

test('groep: elke twijfelfactuur uit de zaad meegestuurd → allemaal geweigerd, niets veranderd', () => {
  const t = opzet();
  const tw = t.twijfel().filter((f) => f.status === 'te_beoordelen').slice(0, 25);
  const voor = tw.map((f) => JSON.stringify(t.fac(f.id)));
  const r = t.call('POST', 'bevestig-groep', { facturen: tw.map((f) => ({ id: f.id, versie: f.versie })) });
  assert.equal(r.status, 200);
  assert.equal(r.j.bevestigd.length, 0, JSON.stringify(r.j.bevestigd));
  assert.equal(r.j.geweigerd.length, tw.length);
  assert.deepEqual(tw.map((f) => JSON.stringify(t.fac(f.id))), voor, 'geen enkele rij gewijzigd');
});

test('groep: versie van de app achterhaald → niet mee; entiteit of betaalwijze meesturen kan niet', () => {
  const t = opzet();
  const z = t.zeker();
  const r = t.call('POST', 'bevestig-groep', { facturen: [{ id: z[0].id, versie: z[0].versie + 3 }, { id: z[1].id, versie: z[1].versie }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.j.geweigerd.map((x) => x.id), [z[0].id]); assert.match(r.j.geweigerd[0].reden, /gewijzigd/);
  assert.equal(t.fac(z[1].id).status, 'in_wachtrij');
  // de groepsroute neemt geen entiteit/betaalwijze aan: die velden in een rij worden genegeerd, de factuur houdt de zijne
  const t2 = opzet(); const z2 = t2.zeker();
  const r2 = t2.call('POST', 'bevestig-groep', { facturen: [{ id: z2[0].id, versie: z2[0].versie, entiteit: 'prive', betaalwijze: 'betaald' }] });
  assert.equal(r2.status, 200); assert.equal(t2.fac(z2[0].id).entiteit, z2[0].entiteit); assert.equal(t2.fac(z2[0].id).betaalwijze, z2[0].betaalwijze);
});

test('groep: grenzen — leeg, meer dan 25, dubbel, ongeldig id, zonder versie, niet de eigen app', () => {
  const t = opzet();
  const z = t.zeker();
  assert.equal(t.call('POST', 'bevestig-groep', { facturen: [] }).status, 400);
  assert.equal(t.call('POST', 'bevestig-groep', {}).status, 400);
  const veel = Array.from({ length: 26 }, (_, i) => ({ id: i.toString(16).padStart(16, '0'), versie: 1 }));
  const r26 = t.call('POST', 'bevestig-groep', { facturen: veel });
  assert.equal(r26.status, 400); assert.match(r26.j.fout, /25/);
  assert.equal(t.call('POST', 'bevestig-groep', { facturen: [{ id: z[0].id, versie: z[0].versie }, { id: z[0].id, versie: z[0].versie }] }).status, 400);
  assert.equal(t.call('POST', 'bevestig-groep', { facturen: [{ id: 'x', versie: 1 }] }).status, 400);
  assert.equal(t.call('POST', 'bevestig-groep', { facturen: [{ id: z[0].id }] }).status, 400);
  const anders = Object.assign({}, t.eig, { ingang: 'machinekamer' });
  assert.equal(t.call('POST', 'bevestig-groep', { facturen: [{ id: z[0].id, versie: z[0].versie }] }, { rol: anders }).status, 403);
  assert.equal(t.vers, 0, 'geen vingerafdruk verbruikt bij een weigering vooraf');
  assert.ok(z.every((f) => t.fac(f.id).status === 'te_beoordelen'));
});

test('directBesluit ongewijzigd: dezelfde factuur-eisen via D.factuurTwijfel (zonder opdracht telt elke eerdere opdracht)', () => {
  const t = opzet();
  const z = t.zeker();
  assert.equal(D.factuurTwijfel(t.fdb, t.fac(z[0].id), null), null);
  sig(t, z[0].id);
  assert.match(D.factuurTwijfel(t.fdb, t.fac(z[0].id), null), /open signaal/);
});

// ── Koppel N zekere ──
const bank = (t) => t.call('GET', 'bank').j.voorstellen;
test('bank: elk voorstel krijgt zeker; de zaadvoorstellen (bekende rekening, precies het bedrag) zijn zeker', () => {
  const t = opzet();
  const vs = bank(t);
  assert.ok(vs.length >= 2);
  assert.ok(vs.every((v) => v.zeker && v.zeker.ok === true), JSON.stringify(vs.map((v) => v.zeker)));
});

const NIET_ZEKER = [
  ['bedrag één cent anders', (t, v) => t.fdb.db.prepare('UPDATE bank_transactie SET bedrag_centen = bedrag_centen - 1 WHERE id = ?').run(v.transactie.id), /precies/],
  ['rekening nog nooit bij deze leverancier', (t, v) => {
    const f = t.fac(v.facturen[0].id);
    t.fdb.db.prepare('DELETE FROM leverancier_iban WHERE leverancier = ?').run(f.leverancier);
    t.fdb.db.prepare('DELETE FROM koppeling WHERE factuur IN (SELECT id FROM factuur WHERE leverancier = ?)').run(f.leverancier);
  }, /niet eerder/],
  ['nog een factuur met hetzelfde bedrag (alternatief)', (t, v) => {
    const ander = t.fdb.db.prepare('SELECT id FROM factuur WHERE id <> ? LIMIT 1').get(v.facturen[0].id);
    t.fdb.db.prepare('UPDATE voorstel SET details = ? WHERE id = ?').run(JSON.stringify({ alternatieven: [ander.id] }), v.id);
  }, /zelfde bedrag/],
  ['open signaal op de afschrijving', (t, v) => t.fdb.db.prepare("INSERT INTO signaal (id, sleutel, soort, titel, transacties, aangemaakt_op) VALUES (?, 'proef-tx', 'afwijkend_bedrag', 'proef', ?, '2026-10-22T10:00:00Z')").run(D.nieuwId(), JSON.stringify([v.transactie.id])), /signaal/],
  ['geen tegenrekening', (t, v) => t.fdb.db.prepare('UPDATE bank_transactie SET tegenpartij_iban = NULL WHERE id = ?').run(v.transactie.id), /tegenrekening/],
  // review wv2661 ZOU 2
  ['factuur nog in Beoordelen', (t, v) => t.fdb.db.prepare("UPDATE factuur SET status = 'te_beoordelen' WHERE id = ?").run(v.facturen[0].id), /nog niet beoordeeld/],
  ['afschrijving hangt al aan een andere factuur', (t, v) => {
    const ander = t.fdb.db.prepare('SELECT id FROM factuur WHERE id <> ? AND entiteit = ? LIMIT 1').get(v.facturen[0].id, v.transactie.entiteit);
    t.fdb.db.prepare("INSERT INTO koppeling (transactie, factuur, bron, methode, zekerheid, volledig, wie, wanneer) VALUES (?, ?, 'mens', 'handmatig', 1, 1, 'david', '2026-10-22T10:00:00Z')").run(v.transactie.id, ander.id);
  }, /al gekoppeld/],
  // review wv2661 ZOU 1: de rekening is alleen "bekend" via een handmatige koppeling van een praktijkmanager → telt niet
  ['rekening alleen bekend via een koppeling van de praktijkmanager', (t, v) => eerdereKoppeling(t, v, 'mens', 'pm@proef.invalid'), /niet eerder/],
];
// Een andere afschrijving naar dezelfde rekening, gekoppeld aan een factuur van dezelfde leverancier; leverancier_iban leeg
function eerdereKoppeling(t, v, bron, wie) {
  const f = t.fac(v.facturen[0].id);
  t.fdb.db.prepare('DELETE FROM leverancier_iban WHERE leverancier = ?').run(f.leverancier);
  t.fdb.db.prepare('DELETE FROM koppeling WHERE factuur IN (SELECT id FROM factuur WHERE leverancier = ?)').run(f.leverancier);
  const tx = t.fdb.db.prepare('SELECT * FROM bank_transactie WHERE id = ?').get(v.transactie.id);
  const ander = t.fdb.db.prepare("SELECT id FROM bank_transactie WHERE id <> ? AND entiteit = ? AND verwijderd_op IS NULL AND id NOT IN (SELECT transactie FROM voorstel) LIMIT 1").get(tx.id, tx.entiteit);
  const zus = t.fdb.db.prepare('SELECT id FROM factuur WHERE leverancier = ? AND id <> ? LIMIT 1').get(f.leverancier, f.id) || t.fdb.db.prepare('SELECT id FROM factuur WHERE id <> ? AND entiteit = ? LIMIT 1').get(f.id, tx.entiteit);
  t.fdb.db.prepare('UPDATE factuur SET leverancier = ? WHERE id = ?').run(f.leverancier, zus.id);
  t.fdb.db.prepare('UPDATE bank_transactie SET tegenpartij_iban = ?, bedrag_centen = -12345 WHERE id = ?').run(tx.tegenpartij_iban, ander.id);
  t.fdb.db.prepare("INSERT INTO koppeling (transactie, factuur, bron, methode, zekerheid, volledig, wie, wanneer) VALUES (?, ?, ?, 'handmatig', 1, 1, ?, '2026-10-01T10:00:00Z')").run(ander.id, zus.id, bron, wie);
}
test('koppel-zeker: rekening bekend via een eerdere koppeling van David of de bankcontrole → wel zeker (positieve controle bij ZOU 1)', () => {
  for (const [bron, wie] of [['mens', 'david (proef)'], ['auto', null]]) {
    const t = opzet();
    const vs = bank(t);
    eerdereKoppeling(t, vs[0], bron, wie);
    const na = bank(t).find((v) => v.id === vs[0].id);
    assert.equal(na.zeker.ok, true, bron + ': ' + JSON.stringify(na.zeker));
  }
});
for (const [naam, maak, reden] of NIET_ZEKER) {
  test('koppel-zeker: ' + naam + ' → niet mee (ook al stuurt de app hem), blijft open voor de losse Ja', () => {
    const t = opzet();
    const vs = bank(t);
    maak(t, vs[0]);
    const na = bank(t).find((v) => v.id === vs[0].id);
    assert.equal(na.zeker.ok, false); assert.match(na.zeker.reden, reden);
    const r = t.call('POST', 'koppel-zeker', { voorstellen: vs.map((v) => v.id) });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.deepEqual(r.j.geweigerd.map((x) => x.id), [vs[0].id]); assert.match(r.j.geweigerd[0].reden, reden);
    assert.equal(t.fdb.db.prepare('SELECT status FROM voorstel WHERE id = ?').get(vs[0].id).status, 'open');
    assert.ok(vs.slice(1).every((v) => t.fdb.db.prepare('SELECT status FROM voorstel WHERE id = ?').get(v.id).status === 'bevestigd'));
    assert.equal(t.vers, 1);
  });
}

test('koppel-zeker: alles zeker → gekoppeld zoals de losse Ja (koppeling, voorstel bevestigd); grenzen en vingerafdruk', () => {
  const t = opzet();
  const vs = bank(t);
  assert.equal(t.call('POST', 'koppel-zeker', { voorstellen: vs.map((v) => v.id) }, { vers: false }).status, 403);
  assert.equal(t.call('POST', 'koppel-zeker', { voorstellen: Array.from({ length: 26 }, (_, i) => i + 1) }).status, 400);
  assert.equal(t.call('POST', 'koppel-zeker', { voorstellen: [vs[0].id, vs[0].id] }).status, 400);
  assert.equal(t.call('POST', 'koppel-zeker', { voorstellen: ['x'] }).status, 400);
  assert.equal(t.vers, 0);
  const r = t.call('POST', 'koppel-zeker', { voorstellen: vs.map((v) => v.id) });
  assert.equal(r.status, 200); assert.equal(r.j.gekoppeld.length, vs.length); assert.equal(t.vers, 1);
  for (const v of vs) {
    assert.equal(t.fdb.db.prepare('SELECT status FROM voorstel WHERE id = ?').get(v.id).status, 'bevestigd');
    assert.ok(t.fdb.db.prepare('SELECT 1 FROM koppeling WHERE transactie = ? AND factuur = ?').get(v.transactie.id, v.facturen[0].id));
  }
  assert.ok(t.fdb.db.prepare("SELECT 1 FROM audit WHERE wat = 'koppelen_groep'").get());
  const r2 = t.call('POST', 'koppel-zeker', { voorstellen: [vs[0].id] });
  assert.equal(r2.j.geweigerd.length, 1, 'tweede keer: al afgehandeld');
  const anders = Object.assign({}, t.eig, { ingang: 'machinekamer' });
  assert.equal(t.call('POST', 'koppel-zeker', { voorstellen: [vs[0].id] }, { rol: anders }).status, 403);
});
