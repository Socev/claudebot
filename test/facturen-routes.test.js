'use strict';
// Toetsen voor facturen.js (wv833, F2): de routes van de Facturen-app op een wegwerpdatabase met zaaddata (test/facturen-zaad.js).
// Raakt /opt/data/facturen, /opt/data/bank, de kluis, mail en de vault niet: alles in TMPDIR, de bankluis is een nagebouwde database.
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
const B = require(path.join(ROOT, 'facturen-bank.js'));
const Z = require(path.join(ROOT, 'test', 'facturen-zaad.js'));
const { ibanFromAbnAccount } = require(path.join(ROOT, 'mt940-lezer.js'));

const NU = Date.parse('2026-10-22T12:30:00Z');
const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });

function opzet(o) {
  o = o || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-routes-'));
  WEG.push(dir);
  const fdb = D.open(path.join(dir, 'db'));
  const zaad = Z.zaai(fdb, { vandaag: '2026-10-22' });
  const routes = F.maak({ docPerUur: o.docPerUur, fout: () => {} });
  const eig = F.rolVoor(fdb, { ingang: 'app', wie: 'david (proef)' });
  const t = { dir, fdb, zaad, routes, eig, vers: { ok: false, verbruikt: 0 }, klaar: {} };
  // klaarstaande uploads (zoals appUploadMap/appUploadLijst): beurt → n → { naam, bytes }
  t.zetKlaar = (beurt, n, naam, bytes) => { (t.klaar[beurt] = t.klaar[beurt] || {})[n] = { naam, bytes: Buffer.from(bytes) }; };
  t.call = (methode, rest, d, x) => {
    x = x || {};
    return routes.app(x.fdb === undefined ? fdb : x.fdb, {
      methode, pad: '/app/facturen' + (rest ? '/' + rest : ''), d: d || {}, rol: x.rol === undefined ? eig : x.rol, primair: x.primair === undefined ? true : x.primair, nu: x.nu || NU,
      versOk: () => t.vers.ok, versVerbruik: () => { t.vers.verbruikt++; t.vers.ok = false; },
      uploadNeem: (beurt, n) => { const b = t.klaar[beurt] && t.klaar[beurt][n]; if (!b) return null; return { naam: b.naam, bytes: b.bytes, weg: () => { delete t.klaar[beurt][n]; } }; },
      bankluisPad: x.bankluisPad,
    });
  };
  t.pm = () => {
    fdb.db.prepare("UPDATE gebruiker SET actief = 1 WHERE rol = 'praktijkmanager'").run();
    return F.rolVoor(fdb, { ingang: 'fac', email: 'praktijkmanager@voorbeeld.invalid' });
  };
  t.f = (where, p) => fdb.db.prepare('SELECT * FROM factuur WHERE ' + where + ' ORDER BY aangemaakt_op, id LIMIT 1').get(...(p || []));
  t.n = (sql, p) => Number(fdb.db.prepare(sql).get(...(p || [])).n);
  return t;
}
// Een te beoordelen factuur die gewoon bevestigd kan worden (entiteit met boekhoudadres, betaalwijze bekend, geen nieuw IBAN).
function gewoon(t, extra) {
  return t.f("status = 'te_beoordelen' AND entiteit IN ('tolgaarde','groenhouten','holding','kostenmaatschap') AND betaalwijze <> 'onbekend' AND iban_nieuw = 0 AND patientkenmerk = 0 AND valuta = 'EUR'" + (extra ? ' AND ' + extra : ''));
}
const tabRij = (acct, dat, bedrag, desc) => [acct, 'EUR', dat, '1000,00', '900,00', dat, bedrag, desc].join('\t');
const TEGEN = 'NL91TEST0000000777';

// ───────────────────────────── routes en poort ─────────────────────────────

test('elke route past in APP_ROUTE_RE van server.js; beheer en invoer staan in de poort', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const m = /const APP_ROUTE_RE = (\/.*\/);/.exec(server);
  assert.ok(m, 'APP_ROUTE_RE gevonden');
  const re = new RegExp(m[1].slice(1, -1));
  for (const methode of ['GET', 'POST']) for (const r of F.ROUTES[methode]) {
    const pad = '/app/facturen' + (r ? '/' + r.replace('<stap>', 'beoordelen').replace('<id>', '0123456789abcdef') : '');
    assert.ok(re.test(pad), methode + ' ' + pad);
  }
  for (const stap of Object.keys(F.STAPPEN)) assert.ok(re.test('/app/facturen/lijst/' + stap));
  const beheer = server.slice(server.indexOf('const APP_BEHEER_ROUTES'), server.indexOf(']);', server.indexOf('const APP_BEHEER_ROUTES')));
  for (const b of F.BEHEER) assert.ok(beheer.includes("'" + b + "'"), b + ' in APP_BEHEER_ROUTES');
  assert.match(server, /route\.indexOf\('GET \/app\/facturen\/document\/'\) === 0\) return true/);
});

test('rollen: app = eigenaar; fac alleen een actieve gebruiker; praktijkmanager nooit Privé', () => {
  const t = opzet();
  assert.equal(t.eig.soort, 'eigenaar');
  assert.equal(F.rolVoor(t.fdb, { ingang: 'fac', email: 'praktijkmanager@voorbeeld.invalid' }), null, 'inactief → geen rol');
  assert.equal(F.rolVoor(t.fdb, { ingang: 'fac', email: 'iemand@voorbeeld.invalid' }), null);
  assert.equal(F.rolVoor(t.fdb, { ingang: 'anders' }), null);
  const pm = t.pm();
  assert.equal(pm.soort, 'praktijkmanager');
  assert.ok(!pm.entiteiten.includes('prive') && pm.entiteiten.includes('tolgaarde'));
  const r = t.call('GET', '', {}, { rol: null });
  assert.equal(r.status, 403);
});

// ───────────────────────────── praktijkmanager ziet geen Privé en geen POT ─────────────────────────────

test('praktijkmanager ziet geen Privé, geen patiëntkenmerk en geen POT-rekening', () => {
  const t = opzet();
  const pm = t.pm();
  // een POT-signaal (alleen eigenaar) erbij
  const potTx = t.fdb.db.prepare("SELECT id FROM bank_transactie WHERE entiteit = 'pot' LIMIT 1").get();
  D.voegToe(t.fdb, 'signaal', { id: D.nieuwId(), sleutel: 'proef-pot', soort: 'geen_factuur', titel: 'Afschrijving zonder factuur', entiteit: 'pot', transacties: [potTx.id],
    alleen_eigenaar: 1, aangemaakt_op: new Date(NU).toISOString() });
  const lijstE = t.call('GET', 'lijst/beoordelen').j.facturen, lijstP = t.call('GET', 'lijst/beoordelen', {}, { rol: pm }).j.facturen;
  assert.ok(lijstE.some((f) => f.entiteit === 'prive'), 'eigenaar ziet Privé');
  assert.ok(lijstE.some((f) => f.patientkenmerk), 'eigenaar ziet patiëntkenmerk');
  assert.ok(lijstP.length > 0 && lijstP.length < lijstE.length);
  assert.ok(lijstP.every((f) => f.entiteit && f.entiteit !== 'prive' && !f.patientkenmerk), 'praktijkmanager: geen Privé, geen kenmerk, geen lege entiteit');
  assert.equal(t.call('GET', 'lijst/prive', {}, { rol: pm }).status, 403);
  assert.equal(t.call('GET', 'lijst/prive').status, 200);
  const prive = t.f("entiteit = 'prive'");
  assert.equal(t.call('GET', 'factuur/' + prive.id, {}, { rol: pm }).status, 404);
  assert.equal(t.call('GET', 'document/' + prive.document, {}, { rol: pm }).status, 404);
  assert.equal(t.call('GET', 'factuur/' + prive.id).status, 200);
  // overzicht: tellers en rekeningen
  const oE = t.call('GET').j, oP = t.call('GET', '', {}, { rol: pm }).j;
  assert.ok(oP.tellers.beoordelen < oE.tellers.beoordelen);
  assert.ok(oE.gezondheid.rekeningen.some((k) => k.entiteit === 'pot'), 'eigenaar ziet de POT-rekening');
  assert.ok(!oP.gezondheid.rekeningen.some((k) => k.entiteit === 'pot' || k.entiteit === 'prive'), 'praktijkmanager niet');
  // bankcontrole: POT-signaal en POT-regels alleen eigenaar
  const bE = t.call('GET', 'bank').j, bP = t.call('GET', 'bank', {}, { rol: pm }).j;
  const potRek = new Set(t.fdb.db.prepare("SELECT t.id FROM bank_transactie t JOIN rekening k ON k.id = t.rekening WHERE k.alleen_eigenaar = 1").all().map((x) => x.id));
  assert.ok(potRek.size > 0);
  assert.ok(bE.signalen.some((s) => s.transacties.some((x) => potRek.has(x))), 'eigenaar ziet het signaal over de POT-rekening');
  // een POT-factuur zelf mag de praktijkmanager zien (bouwplan § 4.2); de POT-rekening en wat ervan afgeleid is niet
  assert.ok(!bP.signalen.some((s) => s.entiteit === 'prive' || s.transacties.some((x) => potRek.has(x))));
  assert.ok(!bP.voorstellen.some((v) => potRek.has(v.transactie.id)));
  const sig = t.fdb.db.prepare("SELECT id FROM signaal WHERE sleutel = 'proef-pot'").get();
  assert.equal(t.call('POST', 'signaal', { id: sig.id, knop: 'is_uitzondering', categorie: 'loon' }, { rol: pm }).status, 404);
  // leveranciers: geen Privé-leverancier; instellingen alleen eigenaar
  assert.ok(t.call('GET', 'leveranciers').j.leveranciers.some((l) => l.standaard_entiteit === 'prive'));
  assert.ok(!t.call('GET', 'leveranciers', {}, { rol: pm }).j.leveranciers.some((l) => l.standaard_entiteit === 'prive'));
  assert.equal(t.call('GET', 'instellingen', {}, { rol: pm }).status, 403);
  assert.equal(t.call('POST', 'bankluis', {}, { rol: pm }).status, 403);
  // betalen: geen Privé
  assert.ok(!t.call('GET', 'betalen', {}, { rol: pm }).j.te_betalen.some((f) => f.entiteit === 'prive'));
  // praktijkmanager kan een factuur niet naar Privé zetten
  const g = gewoon(t, "entiteit = 'tolgaarde'");
  const r = t.call('POST', 'bevestig', { id: g.id, entiteit: 'prive' }, { rol: pm });
  assert.equal(r.status, 403, JSON.stringify(r.j));
  assert.equal(t.call('POST', 'wijzig', { id: g.id, velden: { entiteit: 'prive' } }, { rol: pm }).status, 403);
});

// ───────────────────────────── Bevestigen, Privé, leren ─────────────────────────────

test('Bevestigen: één transactie met opdracht (verstuur_na, vingerafdruk), besluit en audit; verouderde versie → 409', () => {
  const t = opzet();
  const f = gewoon(t);
  assert.equal(t.call('POST', 'bevestig', { id: f.id, versie: f.versie + 7 }).status, 409);
  const r = t.call('POST', 'bevestig', { id: f.id, versie: f.versie });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.status, 'in_wachtrij');
  assert.equal(r.j.opdracht.verstuur_na, '2026-10-22T13:00:00.000Z', 'volgende hele uur');
  const op = t.fdb.db.prepare('SELECT * FROM opdracht WHERE id = ?').get(r.j.opdracht.id);
  const e = t.fdb.db.prepare('SELECT * FROM entiteit WHERE sleutel = ?').get(f.entiteit);
  assert.equal(op.status, 'wacht');
  assert.equal(op.doeladres, e.boekhoud_doel);
  const doc = t.fdb.db.prepare('SELECT sha256 FROM document WHERE id = ?').get(f.document);
  const bij = JSON.parse(op.bijlagen);
  assert.equal(bij[0].sha256, doc.sha256);
  assert.equal(op.vingerafdruk, K.vingerafdruk({ id: op.id, soort: op.soort, doeladres: op.doeladres, regel: { factuur_id: f.id, entiteit: f.entiteit, bedrag_centen: f.incl, doeladres: op.doeladres }, bijlagen: bij }));
  const na = t.fdb.db.prepare('SELECT * FROM factuur WHERE id = ?').get(f.id);
  assert.equal(na.bevestigd_door, 'david (proef)');
  assert.equal(na.betaalspoor, K.betaalspoorBegin(f.betaalwijze));
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'bevestigen' AND object_id = ?", [f.id]), 1);
  assert.equal(t.n("SELECT count(*) AS n FROM besluit WHERE factuur = ? AND stap = 'bevestigen'", [f.id]), 1);
  assert.equal(t.call('POST', 'bevestig', { id: f.id }).status, 409, 'tweede keer: status in_wachtrij');
  // wachtrij toont hem met zijn opdracht
  const w = t.call('GET', 'lijst/wachtrij').j.facturen.find((x) => x.id === f.id);
  assert.equal(w.opdracht.status, 'wacht');
});

test('opdracht voor Privé onmogelijk: Privé → privé-archief zonder opdracht; de database weigert een Privé-opdracht', () => {
  const t = opzet();
  const p = t.f("status = 'te_beoordelen' AND entiteit = 'prive' AND betaalwijze <> 'onbekend' AND iban_nieuw = 0");
  const r = t.call('POST', 'bevestig', { id: p.id });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.status, 'prive_archief');
  assert.equal(r.j.opdracht, null);
  assert.equal(t.n('SELECT count(*) AS n FROM opdracht WHERE factuur = ?', [p.id]), 0);
  // een zakelijke factuur door de eigenaar naar Privé: ook privé-archief, geen opdracht
  const g = gewoon(t);
  const r2 = t.call('POST', 'bevestig', { id: g.id, entiteit: 'prive' });
  assert.equal(r2.j.status, 'prive_archief');
  assert.equal(t.n('SELECT count(*) AS n FROM opdracht WHERE factuur = ?', [g.id]), 0);
  // langs de database om: weigeren
  assert.throws(() => D.voegToe(t.fdb, 'opdracht', { id: D.nieuwId(), soort: 'boekhouder_factuur', factuur: p.id, entiteit: 'prive', doeladres: 'x@acta.invalid', bijlagen: ['a'.repeat(64)],
    vingerafdruk: 'b'.repeat(64), verstuur_na: '2026-10-22T13:00:00Z', idempotentiesleutel: 'p', aangemaakt_door: 'proef', aangemaakt_op: 'x', bijgewerkt_op: 'x' }), /prive|CHECK/);
  // terugdraaien van het privé-archief kan (zonder opdracht)
  const t2 = t.call('POST', 'terugdraaien', { id: p.id });
  assert.equal(t2.j.status, 'te_beoordelen');
});

test('leren: een andere betaalwijze bij Bevestigen wordt de standaard van de leverancier', () => {
  const t = opzet();
  const f = gewoon(t, "betaalwijze = 'incasso' AND leverancier IS NOT NULL");
  const r = t.call('POST', 'bevestig', { id: f.id, betaalwijze: 'betaald' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.match(r.j.melding, /Aangepast — wordt onthouden/);
  assert.equal(t.fdb.db.prepare('SELECT standaard_betaalwijze AS s FROM leverancier WHERE id = ?').get(f.leverancier).s, 'betaald');
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'leverancier_geleerd' AND object_id = ?", [f.leverancier]), 1);
});

// ───────────────────────────── Terugdraaien ─────────────────────────────

test('terugdraaien kan zolang de opdracht wacht; na claimen door de koerier faalt het', () => {
  const t = opzet();
  const a = gewoon(t);
  const ra = t.call('POST', 'bevestig', { id: a.id });
  const td = t.call('POST', 'terugdraaien', { id: a.id });
  assert.equal(td.status, 200, JSON.stringify(td.j));
  assert.equal(t.fdb.db.prepare('SELECT status FROM opdracht WHERE id = ?').get(ra.j.opdracht.id).status, 'teruggedraaid');
  assert.equal(t.fdb.db.prepare('SELECT status FROM factuur WHERE id = ?').get(a.id).status, 'te_beoordelen');
  const b = gewoon(t, 'id <> ?'.replace('?', "'" + a.id + "'"));
  const rb = t.call('POST', 'bevestig', { id: b.id });
  const claim = D.claimOpdrachten(t.fdb, Date.parse(rb.j.opdracht.verstuur_na) + 1000);
  assert.ok(claim.opdrachten.some((o) => o.id === rb.j.opdracht.id), 'koerier heeft hem');
  const tb = t.call('POST', 'terugdraaien', { id: b.id });
  assert.equal(tb.status, 409);
  assert.equal(tb.j.code, 'al_opgehaald');
  assert.equal(t.fdb.db.prepare('SELECT status FROM opdracht WHERE id = ?').get(rb.j.opdracht.id).status, 'opgehaald');
  assert.equal(t.fdb.db.prepare('SELECT status FROM factuur WHERE id = ?').get(b.id).status, 'wordt_verstuurd');
});

// ───────────────────────────── Nagebeld en IBAN-poort ─────────────────────────────

test('nieuw IBAN blokkeert Bevestigen; Nagebeld zonder verse vingerafdruk → 403; met → IBAN bekend en Bevestigen lukt', () => {
  const t = opzet();
  const f = t.f("status = 'te_beoordelen' AND iban_nieuw = 1 AND entiteit IS NOT NULL AND entiteit <> 'prive' AND betaalwijze <> 'onbekend' AND leverancier IS NOT NULL");
  const geblokkeerd = t.call('POST', 'bevestig', { id: f.id });
  assert.equal(geblokkeerd.status, 409);
  assert.match(geblokkeerd.j.fout, /nabellen/);
  t.vers.ok = false;
  const zonder = t.call('POST', 'nagebeld', { id: f.id });
  assert.equal(zonder.status, 403);
  assert.equal(zonder.j.vers_nodig, true);
  assert.equal(t.n('SELECT count(*) AS n FROM leverancier_iban WHERE iban = ?', [f.iban]), 0);
  t.vers.ok = true;
  const met = t.call('POST', 'nagebeld', { id: f.id });
  assert.equal(met.status, 200, JSON.stringify(met.j));
  assert.equal(t.vers.verbruikt, 1, 'één vingerafdruk = één handeling');
  assert.equal(met.j.bevestigen.ok, true);
  assert.equal(t.n('SELECT count(*) AS n FROM leverancier_iban WHERE iban = ? AND leverancier = ?', [f.iban, f.leverancier]), 1);
  const na = t.fdb.db.prepare('SELECT nagebeld_door, nagebeld_op FROM factuur WHERE id = ?').get(f.id);
  assert.equal(na.nagebeld_door, 'david (proef)');
  assert.ok(na.nagebeld_op);
  assert.equal(t.call('POST', 'bevestig', { id: f.id }).status, 200);
  // nog een keer nabellen op een factuur zonder nieuw IBAN: 409 en geen vingerafdruk verbruikt
  t.vers.ok = true;
  const g = gewoon(t);
  assert.equal(t.call('POST', 'nagebeld', { id: g.id }).status, 409);
  assert.equal(t.vers.verbruikt, 1);
});

test('IBAN met de hand wijzigen rekent de IBAN-poort opnieuw uit (nieuw IBAN → Bevestigen geblokkeerd)', () => {
  const t = opzet();
  const f = gewoon(t, "betaalwijze = 'zelf' AND leverancier IS NOT NULL");
  const r = t.call('POST', 'wijzig', { id: f.id, velden: { iban: Z.maakIban('NL', 'TEST', '0912345678') } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.iban_poort.iban_nieuw, true);
  assert.equal(r.j.bevestigen.ok, false);
  assert.equal(t.call('POST', 'bevestig', { id: f.id }).status, 409);
  assert.equal(t.call('POST', 'wijzig', { id: f.id, velden: { iban: 'geen iban' } }).status, 400);
  assert.equal(t.call('POST', 'wijzig', { id: f.id, velden: { tekst: 'x' } }).status, 400, 'onbekend veld');
  const audit = t.fdb.db.prepare("SELECT voor, na FROM audit WHERE wat = 'factuur_wijzigen' AND object_id = ?").get(f.id);
  assert.deepEqual(JSON.parse(audit.na), { velden: ['iban'] });
  assert.doesNotMatch(String(audit.voor) + audit.na, /0912345678|NL\d\d/, 'audit zonder IBAN');
});

test('review wv833 #1: de audit van wijzigen noemt alleen veldnamen, geen bedrag, nummer of kenmerk', () => {
  const t = opzet();
  const f = gewoon(t);
  const r = t.call('POST', 'wijzig', { id: f.id, velden: { incl: 123456, nummer: 'FACT-GEHEIM-9', kenmerk: 'KENMERK-GEHEIM' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const a = t.fdb.db.prepare("SELECT voor, na FROM audit WHERE wat = 'factuur_wijzigen' AND object_id = ?").get(f.id);
  assert.doesNotMatch(String(a.voor) + a.na, /123456|GEHEIM|ZA-/);
  assert.deepEqual(JSON.parse(a.na).velden.sort(), ['incl', 'kenmerk', 'nummer']);
});

test('review wv833 #2: praktijkmanager kan een Privé-leverancier niet zien, koppelen of laten leren', () => {
  const t = opzet();
  const pm = t.pm();
  const levK = t.fdb.db.prepare("SELECT id FROM leverancier WHERE standaard_entiteit = 'prive'").get();
  const f = gewoon(t, "entiteit = 'tolgaarde'");
  const ibanK = t.fdb.db.prepare('SELECT iban FROM leverancier_iban WHERE leverancier = ?').get(levK.id).iban;
  t.fdb.db.prepare('UPDATE factuur SET leverancier = ?, iban = ?, ibans_betaal = ?, ibans_onbekend = ?, iban_nieuw = 0 WHERE id = ?').run(levK.id, ibanK, JSON.stringify([ibanK]), '[]', f.id);
  const d = t.call('GET', 'factuur/' + f.id, {}, { rol: pm });
  assert.equal(d.status, 200);
  assert.equal(d.j.leverancier, null, 'geen naam, standaard of IBANs van de Privé-leverancier');
  const b = t.call('POST', 'bevestig', { id: f.id, entiteit: 'groenhouten', betaalwijze: 'zelf' }, { rol: pm });
  assert.equal(b.status, 200, JSON.stringify(b.j));
  assert.equal(t.fdb.db.prepare('SELECT standaard_entiteit AS s FROM leverancier WHERE id = ?').get(levK.id).s, 'prive', 'leren niet door de praktijkmanager');
  const g = gewoon(t, "entiteit = 'tolgaarde'");
  assert.equal(t.call('POST', 'wijzig', { id: g.id, velden: { leverancier: levK.id } }, { rol: pm }).status, 400);
  // nabellen via de smalle ingang kan niet (wv856: de fraudepoort vraagt een verse vingerafdruk; die zet David in zijn app), ook niet
  // met een (onmogelijke) verse vingerafdruk; het IBAN wordt dus ook nooit bij de Privé-leverancier bekend
  const h = gewoon(t, "entiteit = 'tolgaarde' AND id <> '" + f.id + "'");
  const vreemd = Z.maakIban('NL', 'TEST', '0955555555');
  t.fdb.db.prepare('UPDATE factuur SET leverancier = ?, iban = ?, ibans_betaal = ? WHERE id = ?').run(levK.id, vreemd, JSON.stringify([vreemd]), h.id);
  const nb = t.call('POST', 'nagebeld', { id: h.id }, { rol: pm, }) ;
  assert.equal(nb.status, 403, 'zonder vingerafdruk');
  assert.equal(nb.j.alleen_david, true);
  t.vers.ok = true;
  const nb2 = t.call('POST', 'nagebeld', { id: h.id }, { rol: pm });
  assert.equal(nb2.status, 403, JSON.stringify(nb2.j));
  assert.equal(nb2.j.alleen_david, true);
  assert.equal(t.vers.verbruikt, 0);
  assert.equal(t.fdb.db.prepare('SELECT nagebeld_door AS n FROM factuur WHERE id = ?').get(h.id).n, null);
  assert.equal(t.n('SELECT count(*) AS n FROM leverancier_iban WHERE iban = ?', [vreemd]), 0);
  t.vers.ok = false;
  assert.equal(t.call('POST', 'leverancier', { id: levK.id, alleen_portaal: 1 }, { rol: pm }).status, 404);
  t.fdb.db.prepare("DELETE FROM gebruiker_entiteit WHERE entiteit = 'groenhouten'").run();
  const pm2 = F.rolVoor(t.fdb, { ingang: 'fac', email: 'praktijkmanager@voorbeeld.invalid' });
  assert.ok(!t.call('GET', 'leveranciers', {}, { rol: pm2 }).j.leveranciers.some((l) => l.standaard_entiteit === 'groenhouten' || l.standaard_entiteit === 'prive'), 'alleen leveranciers van zijn entiteiten');
});

test('review wv833 #3: een bankexport met de naam .pdf wordt nooit als stuk bewaard', () => {
  const t = opzet();
  const b = bankOpzet(t);
  const docs = t.n('SELECT count(*) AS n FROM document');
  t.zetKlaar('beurt-0040', 1, 'afschrift.pdf', b.tab);
  const r = t.call('POST', 'upload', { beurt: 'beurt-0040', n: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.soort, 'bank');
  assert.equal(r.j.prive_weggegooid, 1);
  assert.equal(t.n('SELECT count(*) AS n FROM document'), docs);
  t.zetKlaar('beurt-0041', 1, 'x.pdf', b.tab);
  assert.equal(t.call('POST', 'upload', { beurt: 'beurt-0041', n: 1, soort: 'raar' }).status, 400);
  assert.equal(t.klaar['beurt-0041'][1], undefined, 'ook een ongeldig verzoek ruimt het klaarstaande bestand op');
});

test('review wv833 #4: lege of verkeerd gekoppelde bankluis haalt niets weg; een teruggekeerde post komt terug', () => {
  const t = opzet();
  const pad = bankluis(t.dir, [{ nr: 1, sleutel: 'a', status: 'booked', datum: '2026-10-15', bedrag: -10 }]);
  t.call('POST', 'bankluis', {}, { bankluisPad: pad });
  const levend = () => t.n("SELECT count(*) AS n FROM bank_transactie WHERE formaat = 'bankluis' AND verwijderd_op IS NULL");
  const n1 = levend();
  assert.ok(n1 >= 1);
  const leeg = path.join(t.dir, 'leeg'); fs.mkdirSync(leeg);
  const r = t.call('POST', 'bankluis', {}, { bankluisPad: bankluis(leeg, []) });
  assert.equal(r.j.ok, false, 'gemeld als fout');
  assert.equal(levend(), n1, 'niets weggehaald');
  // a verdwijnt even (status pending), daarna weer geboekt: terug
  bankluis(t.dir, [{ nr: 1, sleutel: 'a', status: 'pending', datum: '2026-10-15', bedrag: -10 }, { nr: 2, sleutel: 'b', status: 'booked', datum: '2026-10-16', bedrag: -1 }]);
  t.call('POST', 'bankluis', {}, { bankluisPad: pad });
  const a = () => t.fdb.db.prepare("SELECT verwijderd_op FROM bank_transactie WHERE entry_ref = 'bankluis:proef-pot|a'").get().verwijderd_op;
  assert.ok(a(), 'a weg zolang hij niet geboekt is');
  bankluis(t.dir, [{ nr: 1, sleutel: 'a', status: 'booked', datum: '2026-10-15', bedrag: -10 }]);
  const r3 = t.call('POST', 'bankluis', {}, { bankluisPad: pad });
  assert.equal(a(), null, 'a terug');
  assert.equal(r3.j.terug, 1);
});

test('review wv833 #5: de POT-rekening is altijd alleen voor de eigenaar', () => {
  const t = opzet();
  const pot = t.fdb.db.prepare("SELECT id FROM rekening WHERE entiteit = 'pot'").get();
  assert.equal(t.call('POST', 'instellingen/rekening', { id: pot.id, alleen_eigenaar: 0 }).status, 409);
  assert.equal(t.call('POST', 'instellingen/rekening', { iban: ibanFromAbnAccount('0000000035'), entiteit: 'pot', bank_formaat: 'abn_tab', controle: 1, alleen_eigenaar: 0 }).status, 409);
  const r = t.call('POST', 'instellingen/rekening', { iban: ibanFromAbnAccount('0000000036'), entiteit: 'pot', bank_formaat: 'abn_tab', controle: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(t.fdb.db.prepare('SELECT alleen_eigenaar AS a FROM rekening WHERE id = ?').get(r.j.id).a, 1, 'standaard alleen eigenaar');
});

// ───────────────────────────── passieve kant ─────────────────────────────

test('passieve kant: schrijven → 409; zonder database op de passieve kant → 409, op de primaire → 503', () => {
  const t = opzet();
  const f = gewoon(t);
  assert.equal(t.call('POST', 'bevestig', { id: f.id }, { primair: false }).status, 409);
  assert.equal(t.fdb.db.prepare('SELECT status FROM factuur WHERE id = ?').get(f.id).status, 'te_beoordelen');
  assert.equal(t.call('GET', 'document/' + f.document, {}, { primair: false }).status, 409, 'inzage schrijft audit: ook 409');
  assert.equal(t.call('GET', '', {}, { fdb: null, primair: false }).status, 409);
  assert.equal(t.call('GET', '', {}, { fdb: null, primair: true }).status, 503);
  assert.equal(t.call('GET', '', {}, { primair: false }).status, 200, 'lezen mag');
});

// ───────────────────────────── documentinzage ─────────────────────────────

test('documentinzage: JSON met base64, sha klopt, auditrij; eigen uurteller', () => {
  const t = opzet({ docPerUur: 2 });
  const f = gewoon(t);
  const voor = t.n("SELECT count(*) AS n FROM audit WHERE wat = 'document_inzage'");
  const r = t.call('GET', 'document/' + f.document);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const bytes = Buffer.from(r.j.inhoud, 'base64');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), r.j.sha256);
  assert.equal(bytes.slice(0, 5).toString(), '%PDF-');
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'document_inzage'"), voor + 1);
  const a = t.fdb.db.prepare("SELECT * FROM audit WHERE wat = 'document_inzage' ORDER BY id DESC LIMIT 1").get();
  assert.equal(a.object_id, f.document);
  assert.equal(a.wie, 'david (proef)');
  assert.equal(t.call('GET', 'document/' + f.document).status, 200);
  assert.equal(t.call('GET', 'document/' + f.document).status, 429, 'derde binnen het uur');
  assert.equal(t.call('GET', 'document/ffffffffffffffff').status, 404);
});

// ───────────────────────────── bankbestanden ─────────────────────────────

function bankOpzet(t) {
  const tg = ibanFromAbnAccount('0000000031'), pr = ibanFromAbnAccount('0000000039'), gh = ibanFromAbnAccount('0000000032');
  for (const [iban, entiteit, formaat, controle, eig] of [[tg, 'tolgaarde', 'abn_tab', 1, 0], [pr, 'prive', 'abn_tab', 0, 1], [gh, 'groenhouten', 'ing_csv', 1, 0]]) {
    const r = t.call('POST', 'instellingen/rekening', { iban, entiteit, bank: 'ABN', bank_formaat: formaat, controle, alleen_eigenaar: eig });
    assert.equal(r.status, 200, JSON.stringify(r.j));
  }
  const regels = [
    tabRij('0000000031', '20261020', '-250,00', '/TRTP/SEPA OVERBOEKING/IBAN/' + TEGEN + '/BIC/TESTNL2A/NAME/Webwinkel Proef/REMI/bestelling 77/EREF/NOTPROVIDED'),
    tabRij('0000000031', '20261021', '-12,50', 'ABN AMRO Bank N.V.               Rente en/of kosten'),
    tabRij('0000000039', '20261021', '-50,00', '/TRTP/SEPA OVERBOEKING/IBAN/' + TEGEN + '/BIC/TESTNL2A/NAME/Iets privé/REMI/privé uitgave/EREF/NOTPROVIDED'),
  ];
  return { tg, pr, gh, tab: regels.join('\n') + '\n', regels };
}

test('ABN-export met Privé: ingelezen zonder Privé; hetzelfde bestand twee keer stapelt niets; ruwe bestand blijft niet staan', () => {
  const t = opzet();
  const b = bankOpzet(t);
  const txVoor = t.n('SELECT count(*) AS n FROM bank_transactie');
  t.zetKlaar('beurt-0001', 1, 'export.tab', b.tab);
  const r = t.call('POST', 'upload', { beurt: 'beurt-0001', n: 1, soort: 'auto' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.soort, 'bank');
  assert.equal(r.j.formaat, 'abn_tab');
  assert.equal(r.j.aantal, 2);
  assert.equal(r.j.nieuw, 2);
  assert.equal(r.j.prive_weggegooid, 1);
  assert.equal(t.klaar['beurt-0001'][1], undefined, 'klaarstaand bestand opgeruimd');
  assert.equal(t.n('SELECT count(*) AS n FROM bank_transactie'), txVoor + 2);
  assert.equal(t.n('SELECT count(*) AS n FROM bank_transactie WHERE eigen_iban = ?', [b.pr]), 0, 'geen enkele Privé-regel opgeslagen');
  assert.doesNotMatch(JSON.stringify(t.fdb.db.prepare('SELECT * FROM bank_bestand ORDER BY geupload_op DESC LIMIT 1').get()), new RegExp(b.pr), 'ook niet in de bestandsrij');
  assert.ok(t.fdb.db.prepare('SELECT laatste_invoer_op FROM rekening WHERE iban = ?').get(b.tg).laatste_invoer_op);
  // zelfde bestand nog eens
  t.zetKlaar('beurt-0002', 1, 'export.tab', b.tab);
  const r2 = t.call('POST', 'upload', { beurt: 'beurt-0002', n: 1 });
  assert.equal(r2.j.al_bekend, true);
  assert.equal(r2.j.nieuw, 0);
  // dezelfde regels in een ander bestand (andere bytes): entry_ref uniek → niets nieuw
  t.zetKlaar('beurt-0003', 1, 'export2.tab', b.tab + '\n');
  const r3 = t.call('POST', 'upload', { beurt: 'beurt-0003', n: 1 });
  assert.equal(r3.status, 200, JSON.stringify(r3.j));
  assert.equal(r3.j.nieuw, 0);
  assert.equal(t.n('SELECT count(*) AS n FROM bank_transactie'), txVoor + 2);
  // de bankcontrole liep: de afschrijving zonder factuur (> 7 dagen? nee, 2 dagen) geeft nog geen signaal; de bankkosten wel herkend als uitzondering
  assert.ok(r.j.controle && typeof r.j.controle.signalen === 'number');
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'bankbestand_upload'"), 2);
});

test('verkeerd formaat en onbekende rekening: het hele bestand geweigerd, niets opgeslagen, upload opgeruimd', () => {
  const t = opzet();
  const b = bankOpzet(t);
  const txVoor = t.n('SELECT count(*) AS n FROM bank_transactie'), bbVoor = t.n('SELECT count(*) AS n FROM bank_bestand');
  t.zetKlaar('beurt-0010', 1, 'onbekend.tab', b.tab + tabRij('0000000099', '20261021', '-1,00', 'BEA, Betaalpas x') + '\n');
  const r = t.call('POST', 'upload', { beurt: 'beurt-0010', n: 1 });
  assert.equal(r.status, 422);
  assert.equal(r.j.code, 'onbekende_rekening');
  assert.doesNotMatch(r.j.fout, /0000000099|ABNA/, 'uitleg noemt alleen de laatste vier tekens');
  t.zetKlaar('beurt-0011', 1, 'verkeerd.tab', tabRij('0000000032', '20261021', '-1,00', 'BEA, Betaalpas x') + '\n');
  const r2 = t.call('POST', 'upload', { beurt: 'beurt-0011', n: 1 });
  assert.equal(r2.status, 422);
  assert.equal(r2.j.code, 'verkeerd_formaat');
  t.zetKlaar('beurt-0012', 1, 'onzin.txt', 'dit is geen bankexport\n');
  assert.equal(t.call('POST', 'upload', { beurt: 'beurt-0012', n: 1 }).j.code, 'formaat_onbekend');
  t.zetKlaar('beurt-0013', 1, 'factuur.pdf', Z.pdf(['geen bank']));
  assert.equal(t.call('POST', 'upload', { beurt: 'beurt-0013', n: 1, soort: 'bank' }).status, 415);
  assert.equal(t.n('SELECT count(*) AS n FROM bank_transactie'), txVoor);
  assert.equal(t.n('SELECT count(*) AS n FROM bank_bestand'), bbVoor);
  for (const x of ['beurt-0010', 'beurt-0011', 'beurt-0012', 'beurt-0013']) assert.equal(t.klaar[x][1], undefined, x + ' opgeruimd');
  assert.equal(t.call('POST', 'upload', { beurt: 'beurt-0010', n: 1 }).status, 404, 'staat niet meer klaar');
  assert.equal(t.call('POST', 'upload', { beurt: 'x', n: 1 }).status, 400);
});

test('praktijkmanager mag een export met Privé uploaden (Privé weg); een POT-bestand niet', () => {
  const t = opzet();
  const b = bankOpzet(t);
  const pm = t.pm();
  t.zetKlaar('beurt-0020', 1, 'export.tab', b.tab);
  const r = t.call('POST', 'upload', { beurt: 'beurt-0020', n: 1 }, { rol: pm });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.prive_weggegooid, 1);
  // een rekening alleen-eigenaar (niet Privé) via een upload: geweigerd voor de praktijkmanager
  const eigIban = ibanFromAbnAccount('0000000033');
  assert.equal(t.call('POST', 'instellingen/rekening', { iban: eigIban, entiteit: 'tolgaarde', bank: 'ABN', bank_formaat: 'abn_tab', controle: 1, alleen_eigenaar: 1 }).status, 200);
  t.zetKlaar('beurt-0021', 1, 'eig.tab', tabRij('0000000033', '20261021', '-3,00', 'BEA, Betaalpas y') + '\n');
  assert.equal(t.call('POST', 'upload', { beurt: 'beurt-0021', n: 1 }, { rol: pm }).status, 403);
  assert.equal(t.call('POST', 'instellingen/rekening', { iban: ibanFromAbnAccount('0000000034'), entiteit: 'tolgaarde', bank_formaat: 'abn_tab', controle: 1 }, { rol: pm }).status, 403);
});

// ───────────────────────────── factuur-uploads ─────────────────────────────

const UBL = (nummer, iban) => `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>${nummer}</cbc:ID><cbc:IssueDate>2026-10-20</cbc:IssueDate><cbc:DueDate>2026-11-19</cbc:DueDate><cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>Leverancier A B.V.</cbc:Name></cac:PartyName>
    <cac:PartyLegalEntity><cbc:RegistrationName>Leverancier A B.V.</cbc:RegistrationName><cbc:CompanyID>98000065</cbc:CompanyID></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyName><cbc:Name>Huisartsenpraktijk Tolgaarde B.V.</cbc:Name></cac:PartyName></cac:Party></cac:AccountingCustomerParty>
  <cac:PaymentMeans><cbc:PaymentMeansCode>58</cbc:PaymentMeansCode><cbc:PaymentID>KM2026TEST</cbc:PaymentID><cac:PayeeFinancialAccount><cbc:ID>${iban}</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">21.00</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">121.00</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">121.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
</Invoice>`;

test('UBL-upload wordt direct verwerkt (factuur te beoordelen, alleen velden); PDF wacht op de koerier (te_lezen); dubbel niet opnieuw', () => {
  const t = opzet();
  const levA = t.fdb.db.prepare("SELECT l.id, i.iban FROM leverancier l JOIN leverancier_iban i ON i.leverancier = l.id WHERE l.naam = 'Leverancier A B.V.'").get();
  t.zetKlaar('beurt-0030', 1, 'factuur.xml', UBL('UBL-0001', levA.iban));
  const r = t.call('POST', 'upload', { beurt: 'beurt-0030', n: 1, soort: 'factuur' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.soort, 'ubl');
  assert.equal(r.j.facturen.length, 1);
  const f = t.fdb.db.prepare('SELECT * FROM factuur WHERE id = ?').get(r.j.facturen[0].id);
  assert.equal(f.status, 'te_beoordelen');
  assert.equal(f.nummer, 'UBL-0001');
  assert.equal(f.incl, 12100);
  assert.equal(f.leverancier, levA.id);
  assert.equal(f.iban_nieuw, 0, 'bekend IBAN');
  assert.ok(t.n('SELECT count(*) AS n FROM besluit WHERE factuur = ?', [f.id]) > 3);
  const cols = t.fdb.db.prepare('PRAGMA table_info(factuur)').all().map((c) => c.name);
  assert.ok(!cols.some((c) => /tekst/.test(c)), 'geen kolom voor factuurtekst');
  const d = t.fdb.db.prepare('SELECT * FROM document WHERE id = ?').get(f.document);
  assert.equal(d.soort, 'ubl');
  assert.equal(d.geupload_door, 'david (proef)');
  // nog eens: al bekend
  t.zetKlaar('beurt-0031', 1, 'factuur.xml', UBL('UBL-0001', levA.iban));
  assert.equal(t.call('POST', 'upload', { beurt: 'beurt-0031', n: 1 }).j.al_bekend, true);
  // PDF: opgeslagen met te_lezen, nog geen factuur
  t.zetKlaar('beurt-0032', 1, 'portaal.pdf', Z.pdf(['Leverancier A B.V.', 'Factuur PDF-0001', 'synthetisch']));
  const p = t.call('POST', 'upload', { beurt: 'beurt-0032', n: 1 });
  assert.equal(p.status, 200, JSON.stringify(p.j));
  assert.equal(p.j.te_lezen, true);
  const pd = t.fdb.db.prepare('SELECT * FROM document WHERE id = ?').get(p.j.document);
  assert.equal(pd.te_lezen, 1);
  assert.equal(t.n('SELECT count(*) AS n FROM factuur WHERE document = ?', [pd.id]), 0);
  assert.ok(D.stukBestaat(t.fdb, pd.sha256));
  // de koerier (F4) leest hem later met tekst: verwerkBericht neemt het bestaande te_lezen-document over
  const v = F.verwerkBericht(t.fdb, { bericht: null, documenten: [{ sha256: pd.sha256, naam: 'portaal.pdf', mime: 'application/pdf',
    tekst: 'Leverancier A B.V.\nFactuur\nFactuurnummer: PDF-0001\nFactuurdatum: 20-10-2026\nTotaal incl. btw: € 60,50\nHuisartsenpraktijk Tolgaarde B.V.\nIBAN ' + levA.iban }] }, { wie: 'koerier', nu: NU });
  assert.equal(v.facturen.length, 1);
  assert.equal(t.fdb.db.prepare('SELECT te_lezen FROM document WHERE id = ?').get(pd.id).te_lezen, 0);
  assert.equal(t.fdb.db.prepare('SELECT document FROM factuur WHERE id = ?').get(v.facturen[0].id).document, pd.id);
});

// ───────────────────────────── signalen, voorstellen, betaalspoor ─────────────────────────────

test('signalen afhandelen: elke knop met gevolg en les (uitzondering, toch een factuur, opnieuw proberen); vereisten worden getoetst', () => {
  const t = opzet();
  const gf = t.fdb.db.prepare("SELECT * FROM signaal WHERE soort = 'geen_factuur' AND status = 'open' AND alleen_eigenaar = 0").get();
  assert.equal(t.call('POST', 'signaal', { id: gf.id, knop: 'is_uitzondering' }).status, 400, 'categorie vereist');
  assert.equal(t.call('POST', 'signaal', { id: gf.id, knop: 'bestaat_niet' }).status, 400);
  const r = t.call('POST', 'signaal', { id: gf.id, knop: 'is_uitzondering', categorie: 'abonnement_zonder_factuur' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.match(r.j.les, /stroom zonder factuur/);
  const s = t.fdb.db.prepare('SELECT * FROM signaal WHERE id = ?').get(gf.id);
  assert.equal(s.status, 'afgehandeld');
  assert.equal(s.afhandeling, 'is_uitzondering');
  const tx = t.fdb.db.prepare('SELECT * FROM bank_transactie WHERE id = ?').get(JSON.parse(gf.transacties)[0]);
  assert.equal(tx.categorie, 'abonnement_zonder_factuur');
  assert.ok(tx.uitzondering);
  assert.equal(t.call('POST', 'signaal', { id: gf.id, knop: 'is_uitzondering', categorie: 'loon' }).status, 409, 'al afgehandeld');
  assert.ok(t.call('GET', 'bank').j.geleerd.some((x) => x.id === gf.id), 'verschijnt bij wat we leerden');
  // dubbele factuur → Toch een factuur
  const df = t.fdb.db.prepare("SELECT * FROM signaal WHERE soort = 'dubbele_factuur' AND status = 'open'").get();
  const fid = JSON.parse(df.facturen)[0];
  const r2 = t.call('POST', 'signaal', { id: df.id, knop: 'toch_factuur' });
  assert.equal(r2.status, 200, JSON.stringify(r2.j));
  assert.equal(t.fdb.db.prepare('SELECT status, dubbel_van FROM factuur WHERE id = ?').get(fid).status, 'te_beoordelen');
  // verzending mislukt → Opnieuw proberen = factuur in de wachtrij + nieuwe opdracht
  const vm = t.f("status = 'verzending_mislukt' AND entiteit IN (SELECT sleutel FROM entiteit WHERE boekhoud_doel IS NOT NULL) AND iban_nieuw = 0");
  const ro = t.call('POST', 'opnieuw', { id: vm.id });
  assert.equal(ro.status, 200, JSON.stringify(ro.j));
  assert.equal(ro.j.status, 'in_wachtrij');
  assert.equal(t.n("SELECT count(*) AS n FROM opdracht WHERE factuur = ? AND status = 'wacht'", [vm.id]), 1);
  assert.equal(t.n("SELECT count(*) AS n FROM signaal WHERE soort = 'verzending_mislukt' AND status = 'open' AND EXISTS (SELECT 1 FROM json_each(facturen) j WHERE j.value = ?)", [vm.id]), 0, 'signaal gesloten');
  // dubbel betaald → terugvraagtekst (de app mailt niet zelf)
  const db = t.fdb.db.prepare("SELECT * FROM signaal WHERE soort = 'dubbel_betaald' AND status = 'open'").get();
  const r3 = t.call('POST', 'signaal', { id: db.id, knop: 'terugvraagtekst' });
  assert.equal(r3.status, 200, JSON.stringify(r3.j));
  assert.match(r3.j.tekst, /twee keer betaald/);
  // mogelijk dubbel geüpload → Is hetzelfde: de jongste post weg, zijn signalen dicht
  const md = t.fdb.db.prepare("SELECT * FROM signaal WHERE soort = 'mogelijk_dubbel_geupload' AND status = 'open'").get();
  const weg = JSON.parse(md.details).te_verwijderen;
  assert.equal(t.call('POST', 'signaal', { id: md.id, knop: 'is_hetzelfde' }).status, 200);
  assert.ok(t.fdb.db.prepare('SELECT verwijderd_op FROM bank_transactie WHERE id = ?').get(weg).verwijderd_op);
});

test('Betalen: Ingevoerd in bank en ongedaan; voorstel bevestigen koppelt en zet betaald gezien', () => {
  const t = opzet();
  const f = t.f("betaalspoor = 'te_betalen' AND status IN ('in_wachtrij','verstuurd','concept_klaar') AND iban_nieuw = 0");
  assert.ok(t.call('GET', 'betalen').j.te_betalen.some((x) => x.id === f.id));
  const r = t.call('POST', 'ingevoerd', { id: f.id });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.betaalspoor, 'ingevoerd');
  assert.ok(t.call('GET', 'betalen').j.ingevoerd_niet_gezien.some((x) => x.id === f.id));
  assert.equal(t.call('POST', 'ingevoerd', { id: f.id }).status, 409);
  assert.equal(t.call('POST', 'ingevoerd-ongedaan', { id: f.id }).j.betaalspoor, 'te_betalen');
  const te = t.f("status = 'te_beoordelen'");
  assert.equal(t.call('POST', 'ingevoerd', { id: te.id }).status, 409, 'niet bevestigd');
  // voorstel
  const v = t.fdb.db.prepare("SELECT * FROM voorstel WHERE status = 'open'").get();
  const fid = JSON.parse(v.facturen)[0];
  const rv = t.call('POST', 'voorstel', { id: v.id, keuze: 'bevestig' });
  assert.equal(rv.status, 200, JSON.stringify(rv.j));
  assert.equal(t.fdb.db.prepare('SELECT betaalspoor FROM factuur WHERE id = ?').get(fid).betaalspoor, 'betaald_gezien');
  assert.equal(t.n("SELECT count(*) AS n FROM koppeling WHERE transactie = ? AND factuur = ? AND bron = 'mens'", [v.transactie, fid]), 1);
  assert.equal(t.call('POST', 'voorstel', { id: v.id, keuze: 'bevestig' }).status, 409);
});

// ───────────────────────────── bankluis (read-only) ─────────────────────────────

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

test('bankluis: alleen booked en niet vervangen; vervangen post → koppeling naar de opvolger; read-only; alleen eigenaar', () => {
  const t = opzet();
  const pad = bankluis(t.dir, [
    { nr: 1, sleutel: 'a', status: 'booked', datum: '2026-10-15', bedrag: -100.5 },
    { nr: 2, sleutel: 'b', status: 'pending', datum: '2026-10-20', bedrag: -20 },
    { nr: 3, sleutel: 'c', status: 'booked', datum: '2026-10-18', bedrag: -30 },
    { nr: 9, rek: 'andere', sleutel: 'z', status: 'booked', datum: '2026-10-18', bedrag: -1 },
  ]);
  const voor = fs.statSync(pad).mtimeMs;
  assert.equal(t.call('POST', 'bankluis', {}, { rol: t.pm(), bankluisPad: pad }).status, 403);
  const r = t.call('POST', 'bankluis', {}, { bankluisPad: pad });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.nieuw, 2, 'a en c; b is pending; z hoort bij een andere rekening');
  const rows = t.fdb.db.prepare("SELECT * FROM bank_transactie WHERE formaat = 'bankluis' AND entry_ref LIKE 'bankluis:proef-pot|_' AND verwijderd_op IS NULL").all();
  assert.deepEqual(rows.map((x) => x.bankluis_sleutel).sort(), ['a', 'c']);
  assert.ok(rows.every((x) => x.alleen_eigenaar === 1 && x.entiteit === 'pot'));
  assert.equal(rows.find((x) => x.bankluis_sleutel === 'a').bedrag_centen, -10050);
  // de zaad-POT-posten staan niet in deze bankluis: weg (niet meer geboekt)
  assert.equal(t.n("SELECT count(*) AS n FROM bank_transactie WHERE formaat = 'bankluis' AND entry_ref LIKE 'bankluis:proef-pot|proef-%' AND verwijderd_op IS NULL"), 0);
  // koppel c met de hand aan een (POT-)factuur, dan vervangt de bank c door d
  const c = rows.find((x) => x.bankluis_sleutel === 'c');
  const pf = t.fdb.db.prepare("SELECT id FROM factuur WHERE entiteit = 'pot' LIMIT 1").get();
  assert.ok(pf, 'zaad heeft een POT-factuur');
  {
    D.voegToe(t.fdb, 'koppeling', { transactie: c.id, factuur: pf.id, bron: 'mens', methode: 'handmatig', volledig: 1, alleen_eigenaar: 1, wie: 'proef', wanneer: new Date(NU).toISOString() });
  }
  bankluis(t.dir, [{ nr: 3, sleutel: 'c', status: 'booked', datum: '2026-10-18', bedrag: -30, vervangen_door: 4 }, { nr: 4, sleutel: 'd', status: 'booked', datum: '2026-10-18', bedrag: -30 }]);
  const r2 = t.call('POST', 'bankluis', {}, { bankluisPad: pad });
  assert.equal(r2.status, 200, JSON.stringify(r2.j));
  assert.equal(r2.j.nieuw, 1);
  assert.ok(t.fdb.db.prepare('SELECT verwijderd_op FROM bank_transactie WHERE id = ?').get(c.id).verwijderd_op, 'c weg');
  const d = t.fdb.db.prepare("SELECT id FROM bank_transactie WHERE entry_ref = 'bankluis:proef-pot|d'").get();
  {
    assert.equal(t.n('SELECT count(*) AS n FROM koppeling WHERE transactie = ?', [c.id]), 0);
    assert.equal(t.n('SELECT count(*) AS n FROM koppeling WHERE transactie = ? AND factuur = ?', [d.id, pf.id]), 1, 'koppeling verhuisd');
  }
  assert.equal(t.n("SELECT count(*) AS n FROM bron_ronde r JOIN bron b ON b.id = r.bron WHERE b.soort = 'bankluis' AND r.ok = 1 AND r.start = ?", [new Date(NU).toISOString()]), 2);
  // de bankluis zelf is niet beschreven (alleen door bankluis() hierboven)
  const ro = new (require('node:sqlite').DatabaseSync)(pad, { readOnly: true });
  assert.equal(Number(ro.prepare('SELECT count(*) AS n FROM transacties').get().n), 5);
  ro.close();
  assert.ok(voor > 0);
  // ontbrekende database: zichtbaar als fout in de ronde, niet als stilte
  const r3 = t.call('POST', 'bankluis', {}, { bankluisPad: path.join(t.dir, 'bestaat-niet.sqlite') });
  assert.equal(r3.j.ok, false);
  assert.equal(t.n("SELECT count(*) AS n FROM bron_ronde r JOIN bron b ON b.id = r.bron WHERE b.soort = 'bankluis' AND r.ok = 0"), 1);
});

// ───────────────────────────── instellingen en ronde ─────────────────────────────

test('instellingen: adres en verzendmodus vragen een verse vingerafdruk; versturen pas na F5; Privé nooit een adres', () => {
  const t = opzet();
  t.vers.ok = false;
  assert.equal(t.call('POST', 'instellingen/adres', { entiteit: 'tolgaarde', boekhoud_doel: 'nieuw-tg@acta.invalid' }).status, 403);
  t.vers.ok = true;
  assert.equal(t.call('POST', 'instellingen/adres', { entiteit: 'prive', boekhoud_doel: 'x@acta.invalid' }).status, 409);
  t.vers.ok = true;
  assert.equal(t.call('POST', 'instellingen/adres', { entiteit: 'tolgaarde', boekhoud_doel: 'geen adres' }).status, 400);
  t.vers.ok = true;
  const r = t.call('POST', 'instellingen/adres', { entiteit: 'tolgaarde', boekhoud_doel: 'nieuw-tg@acta.invalid' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.ok(r.j.wachtende_opdrachten_met_oud_adres >= 0);
  assert.equal(t.fdb.db.prepare("SELECT boekhoud_doel FROM entiteit WHERE sleutel = 'tolgaarde'").get().boekhoud_doel, 'nieuw-tg@acta.invalid');
  t.vers.ok = true;
  assert.equal(t.call('POST', 'instellingen/modus', { modus: 'versturen' }).status, 409);
  t.vers.ok = false;
  assert.equal(t.call('POST', 'instellingen/modus', { modus: 'concept' }).status, 403);
  t.vers.ok = true;
  assert.equal(t.call('POST', 'instellingen/modus', { modus: 'concept' }).status, 200);
  assert.equal(t.call('POST', 'instellingen/verzendmoment', { soort: 'dagelijks', uur: 25 }).status, 400);
  const vm = t.call('POST', 'instellingen/verzendmoment', { soort: 'dagelijks', uur: 17 });
  assert.equal(vm.status, 200);
  assert.equal(vm.j.voorbeeld, '2026-10-22T15:00:00.000Z', '17:00 Nederlandse tijd');
  // na een gewijzigd adres: een wachtende opdracht met het oude adres wordt bij het claimen geweigerd (met signaal)
  const f = gewoon(t, "entiteit = 'groenhouten'");
  const b = t.call('POST', 'bevestig', { id: f.id });
  t.vers.ok = true;
  assert.equal(t.call('POST', 'instellingen/adres', { entiteit: 'groenhouten', boekhoud_doel: 'nieuw-gh@acta.invalid' }).j.wachtende_opdrachten_met_oud_adres >= 1, true);
  const c = D.claimOpdrachten(t.fdb, Date.parse(b.j.opdracht.verstuur_na) + 1000);
  assert.ok(c.geweigerd.some((x) => x.id === b.j.opdracht.id));
});

test('facturen-ronde: back-up (VACUUM INTO) en een tweede keer dezelfde dag overschrijft', () => {
  const t = opzet();
  const r = F.ronde(t.fdb, { nu: NU });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(fs.existsSync(path.join(t.fdb.backup, 'facturen-2026-10-22.sqlite')));
  assert.equal(F.ronde(t.fdb, { nu: NU + 60000 }).ok, true);
  assert.equal(fs.readdirSync(t.fdb.backup).filter((n) => /^facturen-/.test(n)).length, 1);
});

test('fouten lekken geen inhoud; onbekende route 404; iso-week klopt', () => {
  const t = opzet();
  assert.equal(t.call('GET', 'bestaat-niet').status, 404);
  assert.equal(t.call('POST', 'bestaat-niet').status, 404);
  assert.equal(t.call('GET', 'lijst/onzin').status, 404);
  assert.equal(t.call('POST', 'bevestig', { id: 'x' }).status, 400);
  assert.equal(F.isoWeek('2026-10-22'), '2026-W43');
  assert.equal(F.isoWeek('2027-01-01'), '2026-W53');
  assert.equal(F.isoWeek('2026-01-01'), '2026-W01');
  // CI-poort in de toets zelf: facturen.js laadt geen netwerk- of procesmodule
  const bron = fs.readFileSync(path.join(ROOT, 'facturen.js'), 'utf8').split('\n').filter((r) => !/^\s*(\*|\/\/)/.test(r)).join('\n');
  assert.doesNotMatch(bron, /require\(['"`](node:)?(http|https|net|tls|dgram|dns|child_process|worker_threads|cluster|vm|undici)['"`]\)|\bfetch\s*\(/);
});

// ───────────────────────────── wv1317: herbeoordeling, uitleg, wat we leerden ─────────────────────────────

test('wv1317: een open voorstel dat niet meer klopt gaat op vervallen (reden + audit), niet stil weg; GET bank geeft uitleg en leerregels', () => {
  const t = opzet();
  const v = t.fdb.db.prepare("SELECT * FROM voorstel WHERE status = 'open' ORDER BY id LIMIT 1").get();
  const fid = JSON.parse(v.facturen)[0];
  const tb = t.fdb.db.prepare('SELECT boekdatum FROM bank_transactie WHERE id = ?').get(v.transactie).boekdatum;
  // de factuur blijkt pas 40 dagen ná de betaling gedateerd (zoals de huur van november tegen de betaling van oktober)
  t.fdb.db.prepare('UPDATE factuur SET factuurdatum = ?, vervaldatum = ? WHERE id = ?').run(K.plusDagen(tb, 40), K.plusDagen(tb, 40), fid);
  const tel = D.transactie(t.fdb, () => F.bankcontroleToepassen(t.fdb, NU));
  assert.ok(tel.voorstellen_vervallen >= 1, JSON.stringify(tel));
  const na = t.fdb.db.prepare('SELECT * FROM voorstel WHERE id = ?').get(v.id);
  assert.equal(na.status, 'vervallen');
  assert.equal(na.afgehandeld_door, 'bankcontrole');
  assert.equal(JSON.parse(na.details).vervallen_reden, 'vooruit');
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'voorstel_vervallen' AND object_id = ?", [String(v.id)]), 1);
  // David kan er niet meer op drukken
  const klik = t.call('POST', 'voorstel', { id: v.id, keuze: 'bevestig' });
  assert.equal(klik.status, 409);
  assert.match(JSON.stringify(klik), /voorstel verviel: de betaling lag ruim vóór de factuurdatum/);
  const b = t.call('GET', 'bank').j;
  assert.ok(b.geleerd_regels.some((g) => g.tekst === '1 koppelvoorstel verviel: de betaling lag ruim vóór de factuurdatum.' ||
    /koppelvoorstellen vervielen: de betaling lag ruim vóór de factuurdatum/.test(g.tekst)), JSON.stringify(b.geleerd_regels));
  for (const g of b.geleerd_regels) assert.ok(!/[a-z]_[a-z]/.test(g.tekst), 'interne code in ' + g.tekst);
  assert.ok(!b.voorstellen.some((x) => x.id === v.id));
  for (const x of b.voorstellen) {
    assert.match(x.uitleg.zin, /^(Afschrijving|Bijschrijving) van \d{1,2}-\d{1,2}-\d{4} van € [\d.]+,\d\d (aan|van) .* = .*factuur/);
    assert.ok(!/\?/.test(x.uitleg.zin), x.uitleg.zin);
    assert.ok(x.uitleg.waarom.length >= 1 && typeof x.uitleg.zekerheid_tekst === 'string');
  }
  // dezelfde stand nog eens: niets nieuws te vervallen, geen tweede auditrij
  const tel2 = D.transactie(t.fdb, () => F.bankcontroleToepassen(t.fdb, NU));
  assert.equal(tel2.voorstellen_vervallen, 0);
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'voorstel_vervallen' AND object_id = ?", [String(v.id)]), 1);
  // klopt het weer (factuurdatum terug) en is de tegenpartij niet geborgd, dan gaat hetzelfde voorstel weer open (auditrij voorstel_heropend)
  t.fdb.db.prepare('DELETE FROM leverancier_iban WHERE leverancier = (SELECT leverancier FROM factuur WHERE id = ?)').run(fid);
  t.fdb.db.prepare('UPDATE factuur SET factuurdatum = ?, vervaldatum = ? WHERE id = ?').run(K.plusDagen(tb, -5), K.plusDagen(tb, 9), fid);
  const tel3 = D.transactie(t.fdb, () => F.bankcontroleToepassen(t.fdb, NU));
  assert.equal(t.fdb.db.prepare('SELECT status FROM voorstel WHERE sleutel = ?').get(v.sleutel).status, 'open', JSON.stringify(tel3));
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'voorstel_heropend' AND object_id = ?", [String(v.id)]), 1);
  assert.equal(t.n('SELECT count(*) AS n FROM koppeling WHERE factuur = ?', [fid]), 0);
});

test('wv1317: de ronde beoordeelt na een regelwijziging één keer opnieuw (ná de back-up), daarna niet meer', () => {
  const t = opzet();
  const r = F.ronde(t.fdb, { nu: NU });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.herbeoordeling.ok, true, JSON.stringify(r.herbeoordeling));
  assert.equal(D.metaLees(t.fdb, 'bank_regels'), 'wv1317');
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'herbeoordeling'"), 1);
  const r2 = F.ronde(t.fdb, { nu: NU + 60000 });
  assert.equal(r2.herbeoordeling, undefined);
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'herbeoordeling'"), 1);
});

test('wv1317: factuurdetail toont het bedragpatroon van het IBAN (alleen met ≥ 3 betalingen in 12 maanden)', () => {
  const t = opzet();
  const f = t.f("iban IS NOT NULL AND incl > 0 AND entiteit = 'tolgaarde'");
  assert.ok(f, 'zaad heeft een Tolgaarde-factuur met IBAN');
  const leeg = t.call('GET', 'factuur/' + f.id).j;
  const rek = t.fdb.db.prepare("SELECT id, iban FROM rekening WHERE entiteit = 'tolgaarde' LIMIT 1").get();
  const best = t.fdb.db.prepare("SELECT id FROM bank_bestand LIMIT 1").get();
  for (let i = 0; i < 4; i++) D.voegToe(t.fdb, 'bank_transactie', { id: 'b13170000000000' + i, bestand: best.id, rekening: rek.id, entiteit: 'tolgaarde', eigen_iban: rek.iban,
    boekdatum: K.plusDagen('2026-10-01', -30 * i), bedrag_centen: -f.incl, valuta: 'EUR', tegenpartij_iban: K.ibanNorm(f.iban), entry_ref: 'wv1317-' + i, formaat: 'abn_mt940', aangemaakt_op: '2026-10-22T10:00:00Z' });
  const p = t.call('GET', 'factuur/' + f.id).j.bedragpatroon;
  assert.ok(p && p.aantal >= 4, JSON.stringify(p));
  assert.equal(p.oordeel, 'binnen');
  assert.equal(p.rekening, '…' + K.ibanNorm(f.iban).slice(-4));
  assert.ok(leeg.bedragpatroon === null || leeg.bedragpatroon.aantal < p.aantal);
  // een alleen-eigenaar-regel naar hetzelfde IBAN telt voor de eigenaar mee, nooit voor de praktijkmanager
  D.voegToe(t.fdb, 'bank_transactie', { id: 'b131700000000009', bestand: best.id, rekening: rek.id, entiteit: 'tolgaarde', eigen_iban: rek.iban, boekdatum: '2026-09-15',
    bedrag_centen: -f.incl, valuta: 'EUR', tegenpartij_iban: K.ibanNorm(f.iban), entry_ref: 'wv1317-9', formaat: 'abn_mt940', alleen_eigenaar: 1, aangemaakt_op: '2026-10-22T10:00:00Z' });
  assert.equal(t.call('GET', 'factuur/' + f.id).j.bedragpatroon.aantal, p.aantal + 1);
  const pm = t.pm();
  const alsPm = t.call('GET', 'factuur/' + f.id, null, { rol: pm });
  assert.equal(alsPm.status, 200, JSON.stringify(alsPm.j));
  assert.equal(alsPm.j.bedragpatroon.aantal, p.aantal);
});

test('wv1317: een open voorstel waarvan de bankregel buiten het venster van 400 dagen valt, blijft open (diffreview ZOU 3)', () => {
  const t = opzet();
  const v = t.fdb.db.prepare("SELECT * FROM voorstel WHERE status = 'open' ORDER BY id LIMIT 1").get();
  t.fdb.db.prepare("UPDATE bank_transactie SET boekdatum = '2024-01-02' WHERE id = ?").run(v.transactie);
  D.transactie(t.fdb, () => F.bankcontroleToepassen(t.fdb, NU));
  assert.equal(t.fdb.db.prepare('SELECT status FROM voorstel WHERE id = ?').get(v.id).status, 'open');
});

// ───────────────────────────── wv1323: feitkaarten "rekening is van …" ─────────────────────────────

// betalingen aan `iban` onder de namen in `namen` (één per betaling, rond), elke `stap` dagen terug vanaf 2026-10-01
function betalingen(t, iban, namen, stap, o) {
  o = o || {};
  const rek = t.fdb.db.prepare("SELECT id, iban FROM rekening WHERE entiteit = ? LIMIT 1").get(o.entiteit || 'tolgaarde');
  let best = t.fdb.db.prepare('SELECT id FROM bank_bestand LIMIT 1').get();
  if (o.uploader) {
    best = { id: crypto.randomBytes(8).toString('hex') };
    D.voegToe(t.fdb, 'bank_bestand', { id: best.id, sha256: crypto.randomBytes(32).toString('hex'), formaat: 'abn_mt940', geupload_door: o.uploader, geupload_op: '2026-10-22T10:00:00Z' });
  }
  namen.forEach((naam, i) => D.voegToe(t.fdb, 'bank_transactie', { id: crypto.randomBytes(8).toString('hex'), bestand: best.id, rekening: rek.id, entiteit: o.entiteit || 'tolgaarde',
    eigen_iban: rek.iban, boekdatum: K.plusDagen('2026-10-01', -stap * i), bedrag_centen: o.bij ? 5000 : -12345, valuta: 'EUR', tegenpartij_naam: naam, tegenpartij_iban: iban,
    entry_ref: 'wv1323-' + crypto.randomBytes(6).toString('hex'), formaat: 'abn_mt940', aangemaakt_op: '2026-10-22T10:00:00Z' }));
}
// een te beoordelen factuur met een nieuw IBAN (moet nagebeld worden), zonder of met leverancier
function nabelFactuur(t, iban, naam, metLeverancier) {
  const f = t.f("status = 'te_beoordelen' AND entiteit IS NOT NULL AND entiteit <> 'prive' AND betaalwijze <> 'onbekend' AND patientkenmerk = 0 AND valuta = 'EUR' AND soort = 'factuur' " +
    "AND leverancier IS NOT NULL AND id NOT IN (SELECT factuur FROM besluit WHERE stap = 'wv1323')");
  assert.ok(f, 'zaad heeft nog een gewone te beoordelen factuur');
  t.fdb.db.prepare("UPDATE factuur SET entiteit = 'tolgaarde', iban = ?, ibans_betaal = ?, iban_nieuw = 1, ibans_onbekend = ?, leverancier = ?, leverancier_naam = ? WHERE id = ?")
    .run(iban, JSON.stringify([iban]), JSON.stringify([iban]), metLeverancier ? f.leverancier : null, naam, f.id);
  t.fdb.db.prepare("INSERT INTO besluit (factuur, stap, bron, wanneer) VALUES (?, 'wv1323', 'regel', ?)").run(f.id, '2026-10-22T10:00:00Z');
  return D.factuurVoorKern(t.fdb, f.id);
}

test('wv1323: feitkaart uit de bankhistorie; Ja vraagt een verse vingerafdruk, maakt de leverancier en vervangt het nabellen; daarna weg', () => {
  const t = opzet();
  const iban = Z.maakIban('NL', 'TEST', '0555000001');
  // het zaad geeft zonder historie geen enkele kaart
  assert.deepEqual(t.call('GET', 'bank').j.feiten, []);
  const f = nabelFactuur(t, iban, 'Proef Leverancier B.V.');
  assert.deepEqual(t.call('GET', 'bank').j.feiten, [], 'nieuw IBAN zonder historie: geen kaart, nabellen');
  betalingen(t, iban, ['Proef Leverancier B.V.', 'Proef Leverancier', 'PROEF LEVERANCIER BV', 'Proef Leverancier B.V.'], 40);
  const bank = t.call('GET', 'bank').j;
  assert.equal(bank.feiten.length, 1, JSON.stringify(bank.feiten));
  const k = bank.feiten[0];
  assert.equal(k.sleutel, 'iban:' + iban);
  assert.equal(k.rekening, '…' + iban.slice(-4));
  assert.equal(k.aantal, 4); assert.equal(k.eerste, '2026-06-03'); assert.equal(k.laatste, '2026-10-01');
  assert.equal(k.naam, 'Proef Leverancier B.V.');
  assert.equal(k.leverancier, null);
  assert.equal(k.uitleg.zin, 'Rekening …' + iban.slice(-4) + ' is van Proef Leverancier B.V..');
  assert.match(k.uitleg.bron, /^4 betalingen sinds 3-6-2026 \(laatste 1-10-2026\) vanaf .+, steeds aan Proef Leverancier B\.V\. \(ook gespeld als /);
  assert.match(k.uitleg.aanleiding, new RegExp('^Factuur ' + f.nummer + ' van Proef Leverancier B\\.V\\. \\(€ '));
  assert.match(k.uitleg.ja, /wordt een bekende leverancier met deze rekening\. Facturen met deze rekening hoeven dan niet meer nagebeld/);
  assert.match(k.uitleg.nee, /komt niet terug/);
  assert.ok(!JSON.stringify(k.uitleg).includes(iban), 'de uitleg noemt nooit het hele rekeningnummer');
  const ov = t.call('GET', '').j.tellers;
  assert.equal(ov.feiten, 1); assert.equal(ov.bankcontrole, ov.signalen + ov.voorstellen + 1);
  assert.equal(t.call('GET', 'factuur/' + f.id).j.feiten.length, 1);
  // de praktijkmanager ziet en beslist niets
  const pm = t.pm();
  assert.deepEqual(t.call('GET', 'bank', null, { rol: pm }).j.feiten, []);
  assert.equal(t.call('GET', '', null, { rol: pm }).j.tellers.feiten, 0);
  assert.equal(t.call('POST', 'feit', { sleutel: k.sleutel, versie: k.versie, keuze: 'bevestig' }, { rol: pm }).status, 403);
  assert.equal(t.call('POST', 'feit', { sleutel: k.sleutel, versie: k.versie, keuze: 'afwijs' }, { rol: pm }).status, 403);
  // Ja geldt alleen voor de kaart die David zag (diffreview MOET 2): zonder versie 400, met een andere versie 409, niets geschreven
  t.vers.ok = true;
  assert.equal(t.call('POST', 'feit', { sleutel: k.sleutel, keuze: 'bevestig' }).status, 400);
  const anders = t.call('POST', 'feit', { sleutel: k.sleutel, versie: '0123456789abcdef', keuze: 'bevestig' });
  assert.equal(anders.status, 409); assert.equal(anders.j.kaart_veranderd, true);
  assert.equal(t.vers.verbruikt, 0, 'geen vingerafdruk verbruikt voor een veranderde kaart');
  // geen verse vingerafdruk: 403 en niets geschreven
  const levVoor = t.n('SELECT count(*) AS n FROM leverancier');
  t.vers.ok = false;
  const zonder = t.call('POST', 'feit', { sleutel: k.sleutel, versie: k.versie, keuze: 'bevestig' });
  assert.equal(zonder.status, 403); assert.equal(zonder.j.vers_nodig, true);
  assert.equal(t.n('SELECT count(*) AS n FROM leverancier'), levVoor);
  assert.equal(t.n('SELECT count(*) AS n FROM feit'), 0);
  assert.equal(t.call('POST', 'bevestig', { id: f.id }).status, 409, 'nog steeds eerst nabellen');
  t.vers.ok = true;
  const ja = t.call('POST', 'feit', { sleutel: k.sleutel, versie: k.versie, keuze: 'bevestig' });
  assert.equal(ja.status, 200, JSON.stringify(ja.j));
  assert.equal(t.vers.verbruikt, 1);
  assert.equal(ja.j.leverancier.nieuw, true); assert.equal(ja.j.leverancier.naam, 'Proef Leverancier B.V.');
  assert.equal(ja.j.facturen.length, 1); assert.equal(ja.j.facturen[0].bevestigen.ok, true, JSON.stringify(ja.j.facturen[0]));
  assert.equal(t.n('SELECT count(*) AS n FROM leverancier'), levVoor + 1);
  const li = t.fdb.db.prepare('SELECT * FROM leverancier_iban WHERE iban = ?').all(iban);
  assert.equal(li.length, 1); assert.equal(li[0].bron, 'bankhistorie'); assert.equal(li[0].leverancier, ja.j.leverancier.id); assert.equal(li[0].toegevoegd_door, 'david (proef)');
  const feit = t.fdb.db.prepare('SELECT * FROM feit').get();
  assert.equal(feit.id, li[0].feit); assert.equal(feit.status, 'bevestigd'); assert.equal(feit.factuur, f.id);
  assert.deepEqual(JSON.parse(feit.bewijs).facturen, [f.id]);
  const na = t.fdb.db.prepare('SELECT leverancier, iban_nieuw, ibans_onbekend, nagebeld_op FROM factuur WHERE id = ?').get(f.id);
  assert.equal(na.leverancier, ja.j.leverancier.id); assert.equal(na.iban_nieuw, 0); assert.equal(na.ibans_onbekend, '[]'); assert.equal(na.nagebeld_op, null, 'niet nagebeld: de bankhistorie verving het');
  assert.equal(t.n("SELECT count(*) AS n FROM besluit WHERE factuur = ? AND stap = 'iban' AND veld = 'bankhistorie' AND bron = 'mens'", [f.id]), 1);
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'feit_bevestigd' AND object_soort = 'feit'"), 1);
  assert.ok(!t.fdb.db.prepare("SELECT na FROM audit WHERE wat = 'feit_bevestigd'").get().na.includes(iban), 'audit zonder volledig rekeningnummer');
  // de kaart is weg, het besluit staat in wat we leerden; nog een keer beslissen kan niet; Bevestigen lukt nu
  const bank2 = t.call('GET', 'bank').j;
  assert.deepEqual(bank2.feiten, []);
  assert.ok(bank2.geleerd_regels.some((g) => g.soort === 'feit_bevestigd' && /1 rekening vastgelegd/.test(g.tekst)), JSON.stringify(bank2.geleerd_regels));
  t.vers.ok = true;
  const weer = t.call('POST', 'feit', { sleutel: k.sleutel, versie: k.versie, keuze: 'afwijs' });
  assert.equal(weer.status, 409); assert.match(weer.j.fout, /besliste je al \(ja\)/);
  assert.equal(t.call('POST', 'bevestig', { id: f.id }).status, 200);
  // een besluit verandert niet meer (trigger)
  assert.throws(() => t.fdb.db.prepare("UPDATE feit SET status = 'afgewezen'").run(), /feit_vast/);
});

test('wv1323: Nee zonder vingerafdruk (nabellen blijft, kaart komt niet terug); geen kaart bij te weinig historie, andere namen, een andere naam op de factuur, een verzamelrekening of historie uit een upload van de praktijkmanager; zonder naam een waarschuwing', () => {
  const t = opzet();
  const ib = (n) => Z.maakIban('NL', 'TEST', '05550000' + n);
  const fa = nabelFactuur(t, ib('11'), 'Proef Twee');
  betalingen(t, ib('11'), ['Proef Twee', 'Proef Twee', 'Proef Twee'], 31);
  nabelFactuur(t, ib('12'), 'Proef Drie');
  betalingen(t, ib('12'), ['Proef Drie', 'Proef Drie', 'Proef Drie', 'Proef Drie'], 10);   // 30 dagen: te kort
  nabelFactuur(t, ib('13'), 'Proef Vier');
  betalingen(t, ib('13'), ['Proef Vier', 'Heel Iets Anders BV', 'Proef Vier', 'Proef Vier'], 40);   // twee rekeninghouders
  nabelFactuur(t, ib('14'), 'Team Proefsalaris');
  betalingen(t, ib('14'), ['Belasting Proefdienst', 'Belasting Proefdienst', 'Belasting Proefdienst'], 40);   // factuur noemt een andere naam
  nabelFactuur(t, ib('15'), 'Proef Vijf');
  betalingen(t, ib('15'), ['Proef Vijf', 'Proef Vijf', 'Proef Vijf'], 40, { bij: true });   // alleen bijschrijvingen tellen niet
  const f16 = nabelFactuur(t, ib('16'), null);
  betalingen(t, ib('16'), ['Proef Zes', 'Proef Zes', 'Proef Zes'], 40);   // factuur zonder naam en zonder leverancier: kaart mét waarschuwing (ZOU 3)
  nabelFactuur(t, ib('17'), 'Webshop Proef');
  betalingen(t, ib('17'), ['Stichting Mollie Payments', 'Stichting Mollie Payments', 'Stichting Mollie Payments'], 40);   // verzamelrekening (ZOU 4)
  nabelFactuur(t, ib('18'), 'Proef Acht');
  betalingen(t, ib('18'), ['Proef Acht', 'Proef Acht', 'Proef Acht'], 40, { uploader: 'praktijkmanager@voorbeeld.invalid' });   // MOET 1
  nabelFactuur(t, ib('19'), 'Proef Negen');
  betalingen(t, ib('19'), ['Proef Negen', 'Proef Negen', 'Proef Negen'], 40, { uploader: 'iemand@voorbeeld.invalid' });   // upload met een e-mailadres: nooit
  const kaarten = t.call('GET', 'bank').j.feiten;
  assert.deepEqual(kaarten.map((k) => k.sleutel).sort(), ['iban:' + ib('11'), 'iban:' + ib('16')].sort(), JSON.stringify(kaarten.map((k) => [k.sleutel, k.naam])));
  const k = kaarten.find((x) => x.sleutel === 'iban:' + ib('11')), k16 = kaarten.find((x) => x.sleutel === 'iban:' + ib('16'));
  assert.equal(k16.naam, 'Proef Zes');
  assert.match(k16.uitleg.aanleiding, new RegExp('^Factuur ' + f16.nummer + ' \\(€ [^)]*\\) noemt deze rekening; die moet nu eerst nagebeld worden\\. Let op: op de factuur is geen leveranciersnaam herkend; kijk op het stuk of hij van Proef Zes komt\\. Ja maakt Proef Zes de leverancier\\.$'));
  assert.doesNotMatch(k.uitleg.aanleiding, /geen leveranciersnaam/);
  assert.equal(k.naam, 'Proef Twee');
  assert.match(k.uitleg.aanleiding, new RegExp('^Factuur ' + fa.nummer + ' van Proef Twee \\(€ '));
  // dezelfde historie van de bankluis of van David telt wél: de upload van de praktijkmanager haalt alleen zijn eigen regels weg
  betalingen(t, ib('18'), ['Proef Acht', 'Proef Acht', 'Proef Acht'], 41, { uploader: 'david (proef)' });
  assert.ok(t.call('GET', 'bank').j.feiten.some((x) => x.sleutel === 'iban:' + ib('18')));
  // ongeldige vragen
  assert.equal(t.call('POST', 'feit', { sleutel: 'iban:onzin', versie: k.versie, keuze: 'afwijs' }).status, 400);
  assert.equal(t.call('POST', 'feit', { sleutel: k.sleutel, versie: k.versie, keuze: 'misschien' }).status, 400);
  const weg = t.call('POST', 'feit', { sleutel: 'iban:' + ib('12'), versie: k.versie, keuze: 'afwijs' });
  assert.equal(weg.status, 409); assert.match(weg.j.fout, /geldt niet meer/);
  // Nee: geen vingerafdruk nodig, niets bij de leverancier, nabellen blijft, de kaart komt niet terug
  t.vers.ok = false;
  const nee = t.call('POST', 'feit', { sleutel: k.sleutel, versie: k.versie, keuze: 'afwijs' });
  assert.equal(nee.status, 200, JSON.stringify(nee.j)); assert.equal(t.vers.verbruikt, 0);
  assert.equal(t.fdb.db.prepare('SELECT status FROM feit WHERE sleutel = ?').get(k.sleutel).status, 'afgewezen');
  assert.equal(t.n('SELECT count(*) AS n FROM leverancier_iban WHERE iban = ?', [ib('11')]), 0);
  assert.ok(!t.call('GET', 'bank').j.feiten.some((x) => x.sleutel === k.sleutel));
  assert.ok(t.call('GET', 'factuur/' + fa.id).j.bevestigen.redenen.some((r) => /nabellen/.test(r)));
  assert.equal(t.call('POST', 'feit', { sleutel: k.sleutel, versie: k.versie, keuze: 'bevestig' }).status, 409);
  // nabellen kan nog gewoon (de bestaande weg); een nagebelde factuur zonder leverancier krijgt geen kaart meer (KAN 8)
  t.vers.ok = true;
  assert.equal(t.call('POST', 'nagebeld', { id: fa.id }).status, 200);
  const k18 = t.call('GET', 'bank').j.feiten.find((x) => x.sleutel === 'iban:' + ib('18'));
  const f18 = t.fdb.db.prepare('SELECT id FROM factuur WHERE iban = ?').get(ib('18'));
  t.vers.ok = true;
  assert.equal(t.call('POST', 'nagebeld', { id: f18.id }).status, 200);
  assert.ok(k18 && !t.call('GET', 'bank').j.feiten.some((x) => x.sleutel === 'iban:' + ib('18')));
});

test('wv1323: de vollere naam wordt de leverancier; een tweede onbekende rekening op de factuur staat in de aanleiding; controles opnieuw', () => {
  const t = opzet();
  const iban = Z.maakIban('NL', 'TEST', '0555000031'), tweede = Z.maakIban('NL', 'TEST', '0555000032');
  const f = nabelFactuur(t, iban, 'Proef Gemeente');
  t.fdb.db.prepare('UPDATE factuur SET ibans_betaal = ? WHERE id = ?').run(JSON.stringify([iban, tweede]), f.id);
  betalingen(t, iban, ['Proef Gemeente Leusden', 'Proef Gemeente Leusden', 'Proef Gemeente Leusden'], 40);
  const k = t.call('GET', 'bank').j.feiten[0];
  assert.equal(k.naam, 'Proef Gemeente Leusden');
  assert.match(k.uitleg.aanleiding, /Let op: er staat nog een andere onbekende rekening op; die blijft nabellen\./);
  assert.match(k.uitleg.ja, /aan een ander rekeningnummer wordt voortaan gemeld als mogelijke fraude/);
  t.fdb.db.prepare("UPDATE factuur SET controles = '[]' WHERE id = ?").run(f.id);
  const voor = t.fdb.db.prepare('SELECT versie FROM factuur WHERE id = ?').get(f.id).versie;
  t.vers.ok = true;
  const ja = t.call('POST', 'feit', { sleutel: k.sleutel, versie: k.versie, keuze: 'bevestig' });
  assert.equal(ja.status, 200, JSON.stringify(ja.j));
  assert.ok(ja.j.facturen[0].bevestigen.redenen.some((r) => /nabellen/.test(r)), 'de tweede rekening blijft nabellen');
  const na = t.fdb.db.prepare('SELECT controles, versie, ibans_onbekend FROM factuur WHERE id = ?').get(f.id);
  assert.ok(JSON.parse(na.controles).length > 0, 'controles opnieuw berekend'); assert.equal(na.versie, voor + 1);
  assert.deepEqual(JSON.parse(na.ibans_onbekend), [tweede]);
  // de kaart verandert als er een factuur bijkomt: de oude versie geldt niet meer
  const iban2 = Z.maakIban('NL', 'TEST', '0555000033');
  nabelFactuur(t, iban2, 'Proef Tien');
  betalingen(t, iban2, ['Proef Tien', 'Proef Tien', 'Proef Tien'], 40);
  const k2 = t.call('GET', 'bank').j.feiten.find((x) => x.sleutel === 'iban:' + iban2);
  nabelFactuur(t, iban2, 'Proef Tien B.V.');
  const k3 = t.call('GET', 'bank').j.feiten.find((x) => x.sleutel === 'iban:' + iban2);
  assert.notEqual(k2.versie, k3.versie); assert.equal(k3.facturen.length, 2);
  t.vers.ok = true;
  assert.equal(t.call('POST', 'feit', { sleutel: k2.sleutel, versie: k2.versie, keuze: 'bevestig' }).status, 409);
  assert.equal(t.call('POST', 'feit', { sleutel: k3.sleutel, versie: k3.versie, keuze: 'bevestig' }).status, 200);
});

test('wv1323: factuur met een bekende leverancier: Ja zet de rekening bij die leverancier (geen nieuwe), alleen als de banknaam past', () => {
  const t = opzet();
  const iban = Z.maakIban('NL', 'TEST', '0555000021');
  const f = nabelFactuur(t, iban, null, true);
  const lev = t.fdb.db.prepare('SELECT id, naam FROM leverancier WHERE id = ?').get(f.leverancier_id);
  betalingen(t, iban, [lev.naam.replace(/ B\.V\.$/, ''), lev.naam, lev.naam], 45);
  const k = t.call('GET', 'bank').j.feiten.find((x) => x.sleutel === 'iban:' + iban);
  assert.ok(k, 'kaart voor de bekende leverancier');
  assert.deepEqual(k.leverancier, { id: lev.id, naam: lev.naam });
  assert.match(k.uitleg.ja, new RegExp('^Ja: ' + lev.naam.replace(/\./g, '\\.') + ' krijgt deze rekening erbij'));
  const levVoor = t.n('SELECT count(*) AS n FROM leverancier');
  t.vers.ok = true;
  const ja = t.call('POST', 'feit', { sleutel: k.sleutel, versie: k.versie, keuze: 'bevestig' });
  assert.equal(ja.status, 200, JSON.stringify(ja.j)); assert.equal(ja.j.leverancier.nieuw, false);
  assert.equal(t.n('SELECT count(*) AS n FROM leverancier'), levVoor);
  assert.equal(t.n("SELECT count(*) AS n FROM leverancier_iban WHERE iban = ? AND leverancier = ? AND bron = 'bankhistorie'", [iban, lev.id]), 1);
  assert.equal(ja.j.facturen[0].bevestigen.redenen.some((r) => /nabellen/.test(r)), false);
  // dezelfde leverancier, een rekening onder een heel andere naam: geen kaart (nieuw IBAN bij een bekende leverancier = nabellen)
  const vreemd = Z.maakIban('NL', 'TEST', '0555000022');
  nabelFactuur(t, vreemd, null, true);
  betalingen(t, vreemd, ['Iemand Anders', 'Iemand Anders', 'Iemand Anders'], 45);
  assert.equal(t.call('GET', 'bank').j.feiten.filter((x) => x.sleutel === 'iban:' + vreemd).length, 0);
});

// ───────────────────────────── SEPA-batch (wv1405) ─────────────────────────────

const { spawnSync } = require('child_process');
const SEPA_XSD = path.join(__dirname, 'schema', 'pain.001.001.09.xsd');
function sepaXsd(tekst) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sepa-r-')), 'b.xml');
  fs.writeFileSync(p, tekst);
  const r = spawnSync('python3', ['-I', '-c', 'import sys\nfrom lxml import etree\ns=etree.XMLSchema(etree.parse(sys.argv[1]))\nprint("OK" if s.validate(etree.parse(sys.argv[2])) else "FOUT " + str(s.error_log))',
    SEPA_XSD, p], { encoding: 'utf8' });
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
  if (r.status !== 0 && /No module named/.test(r.stderr || '')) return 'OK';   // zonder lxml toetst test/facturen-sepa.sh het schema (en meldt dat)
  return (r.stdout || '').trim() || r.stderr;
}
// Een bevestigde factuur op de betaallijst, met een bekend IBAN van een leverancier van die entiteit (geen IBAN-blokkade). Alles verzonnen.
let sepaVolg = 0;
function teBetalenFactuur(t, o) {
  o = o || {};
  const ent = o.entiteit || 'tolgaarde';
  const lev = t.fdb.db.prepare("SELECT l.id, l.naam, (SELECT iban FROM leverancier_iban WHERE leverancier = l.id ORDER BY iban LIMIT 1) AS iban FROM leverancier l WHERE l.standaard_entiteit = ? " +
    "AND l.standaard_betaalwijze = 'zelf' ORDER BY l.naam LIMIT 1").get(ent);
  sepaVolg++;
  const st = D.stukSchrijf(t.fdb, Buffer.from('sepa-proef ' + sepaVolg + ' ' + crypto.randomBytes(4).toString('hex')));
  const did = D.nieuwId(), id = D.nieuwId(), w = new Date(NU).toISOString();
  D.voegToe(t.fdb, 'document', { id: did, sha256: st.sha256, naam: 'proef.pdf', mime: 'application/pdf', bytes: st.bytes, soort: 'pdf', aangemaakt_op: w });
  const incl = o.incl === undefined ? 90000 + sepaVolg * 7 : o.incl;
  D.voegToe(t.fdb, 'factuur', Object.assign({ id, document: did, soort: 'factuur', leverancier: lev.id, leverancier_naam: lev.naam, nummer: 'SP-' + String(sepaVolg).padStart(4, '0'),
    factuurdatum: '2026-10-15', vervaldatum: '2026-11-05', excl: Math.round(incl / 1.21), btw: incl - Math.round(incl / 1.21), incl, valuta: 'EUR', iban: lev.iban, ibans_betaal: [lev.iban],
    betaalwijze: 'zelf', entiteit: ent, status: 'in_wachtrij', bevestigd_door: 'proef', bevestigd_op: w, betaalspoor: 'te_betalen', aangemaakt_op: w, bijgewerkt_op: w }, o.velden || {}));
  return id;
}
function sepaRek(t, entiteit) { return t.call('GET', 'betalen').j.sepa.rekeningen.filter((k) => k.entiteit === entiteit); }
function sepaDownload(t, rekening, facturen, bewust, x) {
  const v = t.call('POST', 'sepa-batch', { rekening, facturen, bewust, voorbeeld: true }, x);
  assert.equal(v.status, 200, JSON.stringify(v.j));
  t.vers.ok = true;
  return { v, r: t.call('POST', 'sepa-batch', { rekening, facturen, bewust, sleutel: v.j.sleutel }, x) };
}

test('wv1405 SEPA: voorbeeld → download met verse vingerafdruk; bestand geldig (XSD); facturen op ingevoerd met uitvoerdatum; batch vast; hetzelfde bestand opnieuw', () => {
  const t = opzet();
  const a = teBetalenFactuur(t);
  // Belastingdienst: zondag 1-11 → vrijdag 30-10, dan 3 bankwerkdagen eerder = dinsdag 27-10 (David 30-10-2026)
  const b = teBetalenFactuur(t, { velden: { vervaldatum: '2026-11-01', kenmerk: '9000 0000 0000 0001', leverancier_naam: 'Belastingdienst' } });
  const bet = t.call('GET', 'betalen').j;
  const ra = bet.te_betalen.find((x) => x.id === a), rb = bet.te_betalen.find((x) => x.id === b);
  assert.deepEqual([ra.uitvoer, ra.uitvoer_bron, ra.batch_reden], ['2026-10-22', 'eerstvolgende_werkdag', null], 'standaard de dag van de batch');
  assert.deepEqual([rb.uitvoer, rb.uitvoer_bron], ['2026-10-27', 'belastingdienst_marge']);
  assert.equal(bet.sepa.vroegst, '2026-10-22');
  assert.ok(!bet.sepa.rekeningen.some((k) => ['pot', 'prive'].includes(k.entiteit)), 'POT en Privé niet als batchrekening');
  const [rek] = sepaRek(t, 'tolgaarde');
  const v = t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: [a, b], voorbeeld: true });
  assert.equal(v.status, 200, JSON.stringify(v.j));
  assert.deepEqual([v.j.aantal, v.j.vroegste, v.j.laatste, v.j.per_datum.length, v.j.geweigerd.length], [2, '2026-10-22', '2026-10-27', 2, 0]);
  assert.equal(v.j.totaal_centen, t.f('id = ?', [a]).incl + t.f('id = ?', [b]).incl);
  assert.match(v.j.regels.find((x) => x.id === b).omschrijving, /9000000000000001 \(betalingskenmerk\)/);
  // zonder verse vingerafdruk: 403; met een andere sleutel: 409 en niets gebeurd
  assert.equal(t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: [a, b], sleutel: v.j.sleutel }).j.vers_nodig, true);
  t.vers.ok = true;
  const mis = t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: [a, b], sleutel: 'f'.repeat(64) });
  assert.equal(mis.status, 409); assert.equal(mis.j.code, 'veranderd');
  assert.equal(t.vers.verbruikt, 1, 'de vingerafdruk is verbruikt');
  assert.equal(t.n('SELECT count(*) AS n FROM sepa_batch'), 0);
  t.vers.ok = true;
  const r = t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: [a, b], sleutel: v.j.sleutel });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.match(r.j.msg_id, /^SOCEV-20261022-[0-9a-f]{8}$/);
  assert.match(r.j.bestand.naam, /^SEPA Tolgaarde 2026-10-22 [0-9a-f]{8}\.xml$/);
  assert.equal(sepaXsd(r.j.bestand.inhoud), 'OK');
  assert.equal((r.j.bestand.inhoud.match(/<PmtInf>/g) || []).length, 2);
  assert.match(r.j.bestand.inhoud, /<EndToEndId>/);
  assert.match(r.j.bestand.inhoud, /<Issr>CUR<\/Issr><\/Tp><Ref>9000000000000001<\/Ref>/);
  assert.deepEqual(['betaalspoor', 'uitvoer_op'].map((k) => t.f('id = ?', [a])[k]), ['ingevoerd', '2026-10-22']);
  assert.equal(t.f('id = ?', [b]).uitvoer_op, '2026-10-27');
  assert.equal(t.n('SELECT count(*) AS n FROM sepa_regel WHERE batch = ?', [r.j.batch]), 2);
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'sepa_batch' AND object_id = ?", [r.j.batch]), 1);
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'sepa_batch_regel'"), 2);
  // het bestand staat nergens in de database (alleen de sha256)
  assert.doesNotMatch(JSON.stringify(t.fdb.db.prepare('SELECT * FROM sepa_batch').all()) + JSON.stringify(t.fdb.db.prepare("SELECT * FROM audit WHERE wat LIKE 'sepa%'").all()), /CstmrCdtTrfInitn/);
  // nog een keer downloaden: 409 (al ingevoerd), geen tweede batch
  t.vers.ok = true;
  const twee = t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: [a, b], sleutel: v.j.sleutel });
  assert.equal(twee.status, 409); assert.match(JSON.stringify(twee.j.geweigerd), /al ingevoerd/);
  assert.equal(t.n('SELECT count(*) AS n FROM sepa_batch'), 1);
  // de batch verandert niet meer
  assert.throws(() => t.fdb.db.prepare('UPDATE sepa_batch SET aantal = 1').run(), /sepa_vast/);
  assert.throws(() => t.fdb.db.prepare('DELETE FROM sepa_regel').run(), /sepa_vast/);
  // hetzelfde bestand opnieuw (verse vingerafdruk), byte voor byte
  assert.equal(t.call('POST', 'sepa-bestand', { batch: r.j.batch }).status, 403);
  t.vers.ok = true;
  const op = t.call('POST', 'sepa-bestand', { batch: r.j.batch });
  assert.equal(op.status, 200, JSON.stringify(op.j));
  assert.equal(op.j.bestand.inhoud, r.j.bestand.inhoud);
  assert.equal(op.j.bestand.sha256, r.j.bestand.sha256);
  t.vers.ok = true;
  assert.equal(t.call('POST', 'sepa-bestand', { batch: r.j.batch }, { nu: NU + 31 * 86400000 }).status, 409, 'na 30 dagen niet meer');
  const na = t.call('GET', 'betalen').j;
  assert.equal(na.sepa.batches[0].nog_ingevoerd, 2);
  assert.equal(na.sepa.batches[0].opnieuw_kan, true);
  assert.ok(na.ingevoerd_niet_gezien.some((x) => x.id === a && x.uitvoer_op === '2026-10-22' && x.in_batch === true));
  // diffreview MOET 1: na Ongedaan van één regel is het oude bestand niet meer opnieuw te krijgen (anders twee keer betaald)
  assert.equal(t.call('POST', 'ingevoerd-ongedaan', { id: b, uit_bank: true }).status, 200);
  const na2 = t.call('GET', 'betalen').j.sepa.batches[0];
  assert.deepEqual([na2.nog_ingevoerd, na2.opnieuw_kan], [1, false]);
  t.vers.ok = true;
  const weg = t.call('POST', 'sepa-bestand', { batch: r.j.batch });
  assert.equal(weg.status, 409); assert.equal(weg.j.code, 'veranderd');
  assert.equal(t.vers.ok, true, 'geweigerd vóór de vingerafdruk');
});

test('wv1405 SEPA: weigeringen (creditnota, IBAN niet nagebeld, valuta, buiten de EER, al gekoppeld, open voorstel, te ver, andere entiteit) — alles of niets, zonder bedrag of naam', () => {
  const t = opzet();
  const goed = teBetalenFactuur(t);
  const credit = teBetalenFactuur(t, { incl: -12100, velden: { soort: 'creditnota' } });
  const usd = teBetalenFactuur(t, { velden: { valuta: 'USD' } });
  const nieuwIban = Z.maakIban('NL', 'TEST', '0912345678');
  const blok = teBetalenFactuur(t, { velden: { iban: nieuwIban, ibans_betaal: [nieuwIban], iban_nieuw: 1, ibans_onbekend: [nieuwIban] } });
  const gb = teBetalenFactuur(t, { velden: { iban: 'GB33BUKB20201555555555' } });   // het voorbeeld-IBAN uit de documentatie
  const ver = teBetalenFactuur(t, { velden: { vervaldatum: '2062-10-01', leverancier_naam: 'Belastingdienst' } });   // alleen de Belastingdienst volgt de vervaldatum
  const gekop = teBetalenFactuur(t);
  const tx = t.fdb.db.prepare("SELECT id FROM bank_transactie WHERE entiteit = 'tolgaarde' AND bedrag_centen < 0 ORDER BY id LIMIT 1").get();
  t.fdb.db.prepare("INSERT INTO koppeling (transactie, factuur, bron, methode, zekerheid, alleen_eigenaar, wie, wanneer) VALUES (?, ?, 'mens', 'handmatig', 1, 0, 'proef', ?)").run(tx.id, gekop, new Date(NU).toISOString());
  const vrs = teBetalenFactuur(t);
  D.voegToe(t.fdb, 'voorstel', { sleutel: 'proef:' + vrs, transactie: tx.id, facturen: [vrs], methode: 'iban_bedrag', zekerheid: 0.7, aangemaakt_op: new Date(NU).toISOString() });
  const hold = teBetalenFactuur(t, { entiteit: 'holding' });
  const [rek] = sepaRek(t, 'tolgaarde');
  const alle = [goed, credit, usd, blok, gb, ver, gekop, vrs, hold];
  const v = t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: alle, voorbeeld: true });
  assert.equal(v.status, 200, JSON.stringify(v.j));
  assert.equal(v.j.aantal, 1);
  const reden = (id) => (v.j.geweigerd.find((g) => g.id === id) || {}).reden;
  assert.match(reden(credit), /creditnota/);
  assert.match(reden(usd), /valuta/);
  assert.match(reden(blok), /nagebeld/);
  assert.match(reden(gb), /buiten de EER/);
  assert.match(reden(ver), /364 dagen/);
  assert.match(reden(gekop), /bankbetaling aan gekoppeld/);
  assert.match(reden(vrs), /koppelvoorstel/);
  assert.match(reden(hold), /andere entiteit/);
  const tekst = v.j.geweigerd.map((g) => g.reden).join(' | ');
  assert.doesNotMatch(tekst, /Leverancier|B\.V\.|\d+[.,]\d{2}|NL\d\d/, 'redenen zonder naam, bedrag of rekeningnummer');
  for (const id of alle) assert.ok(!tekst.includes(String(Math.abs(t.f('id = ?', [id]).incl))), 'geen bedrag in centen');
  // de download weigert het geheel; niets veranderd
  t.vers.ok = true;
  const r = t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: alle, sleutel: v.j.sleutel });
  assert.equal(r.status, 409);
  assert.equal(t.f('id = ?', [goed]).betaalspoor, 'te_betalen');
  assert.equal(t.n('SELECT count(*) AS n FROM sepa_batch'), 0);
  // POT- en Privé-rekening, een onbekende rekening: nooit
  for (const ent of ['pot', 'prive']) {
    const k = t.fdb.db.prepare('SELECT id FROM rekening WHERE entiteit = ?').get(ent);
    assert.equal(t.call('POST', 'sepa-batch', { rekening: k.id, facturen: [goed], voorbeeld: true }).status, 409, ent);
  }
  assert.equal(t.call('POST', 'sepa-batch', { rekening: '0123456789abcdef', facturen: [goed], voorbeeld: true }).status, 409);
  // de database weigert een batch op de POT-rekening ook als de code zich vergist
  const pot = t.fdb.db.prepare("SELECT * FROM rekening WHERE entiteit = 'pot'").get();
  assert.throws(() => D.voegToe(t.fdb, 'sepa_batch', { id: D.nieuwId(), rekening: pot.id, entiteit: 'tolgaarde', formaat: 'pain.001.001.09', msg_id: 'X', cre_dt_tm: '2026-10-22T10:00:00',
    initg_naam: 'x', dbtr_naam: 'x', dbtr_iban: pot.iban, aantal: 1, totaal_centen: 1, sha256: 'a'.repeat(64), wie: 'x', wanneer: 'x' }), /sepa_rekening/);
  // KLEIN 7: een batchregel die niet bij de factuur past (bedrag, rekeningnummer, niet te betalen) weigert de database
  const b0 = t.fdb.db.prepare("SELECT * FROM rekening WHERE id = ?").get(rek.id), bid = D.nieuwId(), fg = t.f('id = ?', [goed]);
  D.voegToe(t.fdb, 'sepa_batch', { id: bid, rekening: b0.id, entiteit: 'tolgaarde', formaat: 'pain.001.001.09', msg_id: 'SOCEV-20261022-proef001', cre_dt_tm: '2026-10-22T10:00:00',
    initg_naam: 'x', dbtr_naam: 'x', dbtr_iban: b0.iban, aantal: 1, totaal_centen: 1, sha256: 'a'.repeat(64), wie: 'x', wanneer: new Date(NU).toISOString() });
  const rg = (o) => Object.assign({ batch: bid, factuur: goed, pmtinf_id: 'P-1', volgnr: 1, positie: 1, uitvoerdatum: '2026-11-05', centen: fg.incl, iban: fg.iban, naam: 'x' }, o);
  assert.throws(() => D.voegToe(t.fdb, 'sepa_regel', rg({ centen: fg.incl + 1 })), /sepa_regel/);
  assert.throws(() => D.voegToe(t.fdb, 'sepa_regel', rg({ iban: Z.maakIban('NL', 'TEST', '0000000999') })), /sepa_regel/);
  assert.throws(() => D.voegToe(t.fdb, 'sepa_regel', rg({ factuur: usd })), /sepa_regel/);
  // praktijkmanager, de smalle ingang, de passieve kant, dubbele id's, te veel
  const pm = t.pm();
  assert.equal(t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: [goed], voorbeeld: true }, { rol: pm }).status, 403);
  assert.equal(t.call('POST', 'betaaldatum', { id: goed, datum: '2026-11-10' }, { rol: pm }).status, 403);
  assert.equal(t.call('GET', 'betalen', null, { rol: pm }).j.sepa, undefined, 'de praktijkmanager ziet geen batchgegevens');
  assert.equal(t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: [goed], voorbeeld: true }, { primair: false }).status, 409);
  assert.equal(t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: [goed, goed], voorbeeld: true }).status, 400);
  assert.equal(t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: [], voorbeeld: true }).status, 400);
  assert.equal(t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: Array.from({ length: 501 }, () => D.nieuwId()), voorbeeld: true }).status, 400);
});

test('wv1405 SEPA: uitdrukkelijke keuze bij al eerder in een batch (na Ongedaan), mogelijk al betaald en een fout kenmerk; Ongedaan noemt de batch', () => {
  const t = opzet();
  const [rek] = sepaRek(t, 'tolgaarde');
  const a = teBetalenFactuur(t);
  assert.equal(sepaDownload(t, rek.id, [a]).r.status, 200);
  // diffreview MOET 2: Ongedaan op een batchregel alleen voor David, en pas na "uit de bank gehaald"
  const zonder = t.call('POST', 'ingevoerd-ongedaan', { id: a });
  assert.equal(zonder.status, 409); assert.equal(zonder.j.code, 'in_batch'); assert.match(zonder.j.in_batch.msg_id, /^SOCEV-/);
  const pm = t.pm();
  assert.equal(t.call('POST', 'ingevoerd-ongedaan', { id: a, uit_bank: true }, { rol: pm }).status, 403);
  assert.equal(t.call('GET', 'betalen', null, { rol: pm }).j.ingevoerd_niet_gezien.find((x) => x.id === a).in_batch, true, 'de praktijkmanager ziet dat hij in een batch zit');
  assert.equal(t.f('id = ?', [a]).betaalspoor, 'ingevoerd');
  const o = t.call('POST', 'ingevoerd-ongedaan', { id: a, uit_bank: true });
  assert.equal(o.status, 200, JSON.stringify(o.j));
  assert.match(o.j.in_batch.msg_id, /^SOCEV-/);
  assert.match(o.j.in_batch.let_op, /haal hem ook uit de bank/);
  assert.equal(t.f('id = ?', [a]).uitvoer_op, null);
  const rij = t.call('GET', 'betalen').j.te_betalen.find((x) => x.id === a);
  assert.ok(rij.eerder_in_batch && rij.eerder_in_batch.msg_id === o.j.in_batch.msg_id);
  assert.deepEqual(rij.waarschuwingen.map((w) => w.code), ['eerder_in_batch']);
  const v = t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: [a], voorbeeld: true });
  assert.equal(v.j.aantal, 0); assert.deepEqual(v.j.geweigerd[0].bewust_nodig, ['eerder_in_batch']);
  assert.equal(t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: [a], bewust: [a], voorbeeld: true }).j.aantal, 0, 'alleen het id is geen akkoord');
  const tweede = sepaDownload(t, rek.id, [a], [a + ':eerder_in_batch']);
  assert.equal(tweede.r.status, 200, JSON.stringify(tweede.r.j));
  assert.notEqual(tweede.r.j.msg_id, o.j.in_batch.msg_id, 'een nieuwe batch heeft een nieuwe MsgId');
  // mogelijk al betaald: een afschrijving naar hetzelfde IBAN met hetzelfde bedrag sinds de factuurdatum, niet gekoppeld
  const m = teBetalenFactuur(t, { incl: 77701 });
  const f = t.f('id = ?', [m]);
  const zaadRek = t.fdb.db.prepare("SELECT * FROM rekening WHERE entiteit = 'tolgaarde'").get();
  const bestand = t.fdb.db.prepare('SELECT id FROM bank_bestand ORDER BY id LIMIT 1').get().id;
  D.voegToe(t.fdb, 'bank_transactie', { id: D.nieuwId(), bestand, rekening: zaadRek.id, entiteit: 'tolgaarde', eigen_iban: zaadRek.iban, boekdatum: '2026-10-22', bedrag_centen: -77701,
    valuta: 'EUR', tegenpartij_iban: f.iban, tegenpartij_naam: 'Banknaam Proef', entry_ref: 'proef-mb', formaat: zaadRek.bank_formaat, aangemaakt_op: new Date(NU).toISOString() });
  const k = teBetalenFactuur(t, { velden: { kenmerk: '8000000000000001' } });
  const v2 = t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: [m, k], voorbeeld: true });
  assert.deepEqual(v2.j.geweigerd.map((g) => [g.id, g.bewust_nodig]).sort(), [[m, ['mogelijk_betaald']], [k, ['kenmerk_fout']]].sort());
  // ZOU 3: een akkoord geldt per waarschuwing; een akkoord op iets anders dekt "mogelijk al betaald" niet
  assert.deepEqual(t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: [m], bewust: [m + ':kenmerk_fout'], voorbeeld: true }).j.geweigerd[0].bewust_nodig, ['mogelijk_betaald']);
  const v3 = t.call('POST', 'sepa-batch', { rekening: rek.id, facturen: [m, k], bewust: [m + ':mogelijk_betaald', k + ':kenmerk_fout'], voorbeeld: true });
  assert.equal(v3.j.aantal, 2);
  assert.equal(v3.j.regels.find((x) => x.id === m).naam, 'Banknaam Proef', 'de naam die de bank bij dit IBAN kent (naam-nummercheck)');
  assert.match(v3.j.regels.find((x) => x.id === k).omschrijving, /8000000000000001/);
});

test('wv1405 betaaldatum: werkdag, niet voorbij, hooguit 364 dagen; leeg = standaard; alleen bij te betalen; audit', () => {
  const t = opzet();
  const a = teBetalenFactuur(t);
  assert.match(t.call('POST', 'betaaldatum', { id: a, datum: '2026-10-24' }).j.fout, /bankwerkdag/, 'zaterdag');
  assert.match(t.call('POST', 'betaaldatum', { id: a, datum: '2026-10-21' }).j.fout, /voorbij/);
  assert.match(t.call('POST', 'betaaldatum', { id: a, datum: '2027-10-22' }).j.fout, /364/);
  assert.match(t.call('POST', 'betaaldatum', { id: a, datum: '2026-12-25' }).j.fout, /bankwerkdag/, 'Kerst');
  const r = t.call('POST', 'betaaldatum', { id: a, datum: '2026-12-15' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.uitvoer.datum, '2026-12-15');
  const rij = () => t.call('GET', 'betalen').j.te_betalen.find((x) => x.id === a);
  assert.deepEqual([rij().betaal_op, rij().uitvoer, rij().uitvoer_bron], ['2026-12-15', '2026-12-15', 'gekozen']);
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'betaaldatum' AND object_id = ?", [a]), 1);
  // een gekozen datum die voorbij is, wordt bij de batch de eerstvolgende werkdag
  assert.deepEqual([t.call('GET', 'betalen', null, { nu: Date.parse('2026-12-19T10:00:00Z') }).j.te_betalen.find((x) => x.id === a).uitvoer], ['2026-12-21']);
  assert.equal(t.call('POST', 'betaaldatum', { id: a, datum: null }).j.betaal_op, null);
  assert.deepEqual([rij().uitvoer, rij().uitvoer_bron], ['2026-10-22', 'eerstvolgende_werkdag']);
  assert.equal(t.call('POST', 'ingevoerd', { id: a }).status, 200);
  assert.equal(t.call('POST', 'betaaldatum', { id: a, datum: '2026-12-15' }).status, 409, 'niet voor een ingevoerde factuur');
});

test('wv1405 twee rekeningen bij één entiteit; ABN-afschrift met PREF koppelt de hele batch; zonder kenmerk alleen een voorstel; losse betaling op EndToEndId; signaal pas vanaf de uitvoerdatum', () => {
  const t = opzet();
  const b = bankOpzet(t);   // tweede tolgaarde-rekening (abn_tab, ABN-rekeningnummer 31)
  const reks = sepaRek(t, 'tolgaarde');
  assert.equal(reks.length, 2, 'twee rekeningen: David kiest');
  const abn = reks.find((k) => k.rekening === '…' + b.tg.slice(-4));
  const a1 = teBetalenFactuur(t), a2 = teBetalenFactuur(t);
  const { r } = sepaDownload(t, abn.id, [a1, a2]);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.match(r.j.bestand.inhoud, new RegExp('<DbtrAcct><Id><IBAN>' + b.tg + '</IBAN>'));
  const pmt = t.fdb.db.prepare('SELECT pmtinf_id, sum(centen) AS som FROM sepa_regel WHERE batch = ? GROUP BY pmtinf_id').get(r.j.batch);
  // het afschrift: één afschrijving voor het blok, met de PmtInfId als PREF (zo staat een batch in de ABN-export, gemeten 27-10)
  const bedrag = '-' + (pmt.som / 100).toFixed(2).replace('.', ',');
  const regel = tabRij('0000000031', '20261105', bedrag, '/TRTP/SEPA Batch/PREF/' + pmt.pmtinf_id + '/NRTX/2');
  assert.equal(B.leesAbnTab(regel + '\n')[0].kenmerk, pmt.pmtinf_id);
  t.zetKlaar('beurt-sepa1', 1, 'export.tab', regel + '\n');
  const up = t.call('POST', 'upload', { beurt: 'beurt-sepa1', n: 1, soort: 'auto' }, { nu: Date.parse('2026-11-06T10:00:00Z') });
  assert.equal(up.status, 200, JSON.stringify(up.j));
  for (const id of [a1, a2]) assert.equal(t.f('id = ?', [id]).betaalspoor, 'betaald_gezien', id);
  assert.equal(t.n("SELECT count(*) AS n FROM koppeling WHERE methode = 'sepa_batch'"), 2);
  // ZOU 4: dezelfde batch een tweede keer afgeschreven (twee keer geüpload) → per factuur "dubbel betaald", geen "geen factuur"
  t.zetKlaar('beurt-sepa1b', 1, 'export.tab', tabRij('0000000031', '20261109', bedrag, '/TRTP/SEPA Batch/PREF/' + pmt.pmtinf_id + '/NRTX/2') + '\n');
  assert.equal(t.call('POST', 'upload', { beurt: 'beurt-sepa1b', n: 1, soort: 'auto' }, { nu: Date.parse('2026-11-25T10:00:00Z') }).status, 200);
  const db2 = t.fdb.db.prepare("SELECT * FROM signaal WHERE soort = 'dubbel_betaald' AND status = 'open'").all().filter((x) => [a1, a2].includes(JSON.parse(x.facturen)[0]));
  assert.equal(db2.length, 2, 'per factuur een signaal');
  assert.ok(db2.every((x) => JSON.parse(x.transacties).length === 2 && JSON.parse(x.details).batch === pmt.pmtinf_id));
  const tx2 = t.fdb.db.prepare("SELECT id FROM bank_transactie WHERE boekdatum = '2026-11-09' AND kenmerk = ?").get(pmt.pmtinf_id);
  assert.equal(t.n("SELECT count(*) AS n FROM signaal WHERE soort = 'geen_factuur' AND EXISTS (SELECT 1 FROM json_each(transacties) j WHERE j.value = ?)", [tx2.id]), 0);
  // ZOU 5: factuur na de batch van bedrag veranderd → niet automatisch betaald gezien, wel een voorstel
  const d1 = teBetalenFactuur(t), d2 = teBetalenFactuur(t);
  const vierde = sepaDownload(t, abn.id, [d1, d2]).r;
  assert.equal(vierde.status, 200);
  const pmt4 = t.fdb.db.prepare('SELECT pmtinf_id, sum(centen) AS som FROM sepa_regel WHERE batch = ? GROUP BY pmtinf_id').get(vierde.j.batch);
  t.fdb.db.prepare('UPDATE factuur SET incl = incl + 50000 WHERE id = ?').run(d2);
  t.zetKlaar('beurt-sepa4', 1, 'export.tab', tabRij('0000000031', '20261110', '-' + (pmt4.som / 100).toFixed(2).replace('.', ','), '/TRTP/SEPA Batch/PREF/' + pmt4.pmtinf_id + '/NRTX/2') + '\n');
  assert.equal(t.call('POST', 'upload', { beurt: 'beurt-sepa4', n: 1, soort: 'auto' }, { nu: Date.parse('2026-11-11T10:00:00Z') }).status, 200);
  assert.equal(t.f('id = ?', [d1]).betaalspoor, 'ingevoerd', 'niet automatisch');
  assert.ok(t.fdb.db.prepare("SELECT 1 FROM voorstel WHERE methode = 'sepa_batch' AND status = 'open' AND facturen LIKE ?").get('%' + d2 + '%'), 'voorstel ter bevestiging');
  // zonder kenmerk (andere bank, ander formaat): alleen een voorstel, met beide facturen
  const c1 = teBetalenFactuur(t), c2 = teBetalenFactuur(t);
  const tweede = sepaDownload(t, abn.id, [c1, c2]).r;
  const som2 = t.n('SELECT sum(centen) AS n FROM sepa_regel WHERE batch = ?', [tweede.j.batch]);
  t.zetKlaar('beurt-sepa2', 1, 'export.tab', tabRij('0000000031', '20261023', '-' + (som2 / 100).toFixed(2).replace('.', ','), 'SEPA Batch zonder kenmerk') + '\n');
  assert.equal(t.call('POST', 'upload', { beurt: 'beurt-sepa2', n: 1, soort: 'auto' }, { nu: Date.parse('2026-11-07T10:00:00Z') }).status, 200);
  const vs = t.fdb.db.prepare("SELECT * FROM voorstel WHERE methode = 'sepa_bedrag' AND status = 'open'").get();
  assert.ok(vs, 'voorstel');
  assert.deepEqual(JSON.parse(vs.facturen).sort(), [c1, c2].sort());
  assert.equal(t.f('id = ?', [c1]).betaalspoor, 'ingevoerd', 'niet automatisch');
  const uitleg = t.call('GET', 'bank', null, { nu: Date.parse('2026-11-07T10:00:00Z') }).j.voorstellen.find((x) => x.id === vs.id).uitleg;
  assert.match(uitleg.let_op.join(' '), /batchkenmerk niet/);
  assert.equal(t.call('POST', 'voorstel', { id: vs.id, keuze: 'bevestig' }).status, 200);
  assert.equal(t.f('id = ?', [c2]).betaalspoor, 'betaald_gezien');
  // één betaling in een blok: ABN boekt hem los, met de EndToEndId (factuur-id) als kenmerk
  const e = teBetalenFactuur(t);
  const derde = sepaDownload(t, abn.id, [e]).r;
  assert.equal(derde.status, 200);
  const fe = t.f('id = ?', [e]);
  t.zetKlaar('beurt-sepa3', 1, 'export.tab', tabRij('0000000031', '20261105', '-' + (fe.incl / 100).toFixed(2).replace('.', ','),
    '/TRTP/SEPA OVERBOEKING/IBAN/' + fe.iban + '/BIC/TESTNL2A/NAME/Proef/REMI/' + fe.nummer + '/EREF/' + e) + '\n');
  assert.equal(t.call('POST', 'upload', { beurt: 'beurt-sepa3', n: 1, soort: 'auto' }, { nu: Date.parse('2026-11-07T10:00:00Z') }).status, 200);
  assert.equal(t.f('id = ?', [e]).betaalspoor, 'betaald_gezien');
  assert.equal(t.fdb.db.prepare('SELECT methode FROM koppeling WHERE factuur = ?').get(e).methode, 'sepa_e2e');
  // signaal "ingevoerd, niet gezien" telt vanaf de uitvoerdatum (een batch voor over twee maanden geeft geen vals signaal)
  const l = teBetalenFactuur(t);
  assert.equal(t.call('POST', 'betaaldatum', { id: l, datum: '2026-12-21' }).status, 200);
  assert.equal(sepaDownload(t, abn.id, [l]).r.status, 200);
  const sig = (nu) => { F.bankcontroleToepassen(t.fdb, nu); return t.n("SELECT count(*) AS n FROM signaal WHERE soort = 'ingevoerd_niet_gezien' AND EXISTS (SELECT 1 FROM json_each(facturen) j WHERE j.value = ?)", [l]); };
  assert.equal(sig(Date.parse('2026-11-20T10:00:00Z')), 0, 'vóór de uitvoerdatum');
  assert.equal(sig(Date.parse('2026-12-31T10:00:00Z')), 1, 'ruim 5 werkdagen ná de uitvoerdatum');
});

// wv1415: een batchregel die de bank terugboekt (vorm gemeten 27-10 in de ABN-export, batch van 12-8-2026; alle waarden hier verzonnen)
test('wv1415 terugboeking: afschrijving en terugboeking in één upload → die factuur weer te betalen (batch blijft), signaal met knoppen; opnieuw in een batch alleen met akkoord; idempotent', () => {
  const t = opzet();
  const b = bankOpzet(t);
  const abn = sepaRek(t, 'tolgaarde').find((k) => k.rekening === '…' + b.tg.slice(-4));
  const a1 = teBetalenFactuur(t), a2 = teBetalenFactuur(t);
  const { r } = sepaDownload(t, abn.id, [a1, a2]);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const pmt = t.fdb.db.prepare('SELECT pmtinf_id, sum(centen) AS som FROM sepa_regel WHERE batch = ? GROUP BY pmtinf_id').get(r.j.batch);
  const f1 = t.f('id = ?', [a1]);
  const euro = (c) => (c / 100).toFixed(2).replace('.', ',');
  const regels = [tabRij('0000000031', '20261105', '-' + euro(pmt.som), '/TRTP/SEPA Batch/PREF/' + pmt.pmtinf_id + '/NRTX/2'),
    tabRij('0000000031', '20261105', euro(f1.incl), '/TRTP/SEPA Terugboeking/IBAN/' + f1.iban + '/BIC/TESTNL2A   /NAME/Proef/RTRN/MS02/REMI/' + f1.nummer + '/EREF/' + a1)];
  assert.equal(B.leesAbnTab(regels[1] + '\n')[0].kenmerk, a1, 'EREF wordt het kenmerk');
  t.zetKlaar('beurt-terug', 1, 'export.tab', regels.join('\n') + '\n');
  const NA = Date.parse('2026-11-06T10:00:00Z');
  const up = t.call('POST', 'upload', { beurt: 'beurt-terug', n: 1, soort: 'auto' }, { nu: NA });
  assert.equal(up.status, 200, JSON.stringify(up.j));
  const n1 = t.f('id = ?', [a1]);
  assert.deepEqual([n1.betaalspoor, n1.betaald_gezien_op, n1.ingevoerd_op, n1.uitvoer_op], ['te_betalen', null, null, null]);
  assert.equal(t.f('id = ?', [a2]).betaalspoor, 'betaald_gezien');
  assert.deepEqual(t.fdb.db.prepare('SELECT methode FROM koppeling WHERE factuur = ? ORDER BY methode').all(a1).map((x) => x.methode), ['sepa_batch', 'sepa_terug']);
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'betaalspoor_teruggeboekt' AND object_id = ?", [a1]), 1);
  const sig = t.fdb.db.prepare("SELECT * FROM signaal WHERE soort = 'teruggeboekt' AND facturen LIKE ?").all('%' + a1 + '%');
  assert.equal(sig.length, 1);
  assert.deepEqual([JSON.parse(sig[0].facturen), sig[0].status, JSON.parse(sig[0].details).batch], [[a1], 'open', pmt.pmtinf_id]);
  const onze = t.fdb.db.prepare("SELECT id FROM bank_transactie WHERE boekdatum = '2026-11-05'").all().map((x) => x.id);
  assert.equal(onze.length, 2);
  assert.equal(t.n("SELECT count(*) AS n FROM signaal WHERE soort IN ('geen_factuur','dubbel_betaald') AND EXISTS (SELECT 1 FROM json_each(transacties) j WHERE j.value IN (?, ?))", onze), 0,
    'geen ander signaal over de batch of de terugboeking');
  assert.equal(t.n('SELECT count(*) AS n FROM sepa_regel WHERE batch = ?', [r.j.batch]), 2, 'de batch blijft staan');
  // in de app: het signaal met zijn twee knoppen; op de betaallijst weer te betalen, niet geblokkeerd door de oude koppeling, wel "al eerder in een batch"
  const bank = t.call('GET', 'bank', null, { nu: NA }).j;
  const s = (bank.signalen || []).find((x) => x.id === sig[0].id);
  assert.ok(s, JSON.stringify(Object.keys(bank)));
  assert.deepEqual(s.knoppen.map((k) => k.knop), ['opnieuw_betalen', 'leverancier_incasseert']);
  const rij = t.call('GET', 'betalen', null, { nu: NA }).j.te_betalen.find((x) => x.id === a1);
  assert.equal(rij.batch_reden, null);
  assert.deepEqual(rij.waarschuwingen.map((w) => w.code), ['eerder_in_batch']);
  // nog een keer de bankcontrole: niets nieuws
  const tel = F.bankcontroleToepassen(t.fdb, NA + 3600000);
  assert.deepEqual([tel.koppelingen, tel.signalen, tel.teruggeboekt || 0, tel.betaald_gezien], [0, 0, 0, 0]);
  // opnieuw in een batch (met akkoord), daarna pas de knop: de nieuwe batch blijft staan
  const tweede = sepaDownload(t, abn.id, [a1], [a1 + ':eerder_in_batch'], { nu: NA });
  assert.equal(tweede.r.status, 200, JSON.stringify(tweede.r.j));
  assert.equal(t.f('id = ?', [a1]).betaalspoor, 'ingevoerd');
  assert.equal(t.call('POST', 'signaal', { id: sig[0].id, knop: 'leverancier_incasseert' }, { nu: NA }).status, 409, 'staat alweer in een batch');
  const k = t.call('POST', 'signaal', { id: sig[0].id, knop: 'opnieuw_betalen' }, { nu: NA });
  assert.equal(k.status, 200, JSON.stringify(k.j));
  assert.equal(t.f('id = ?', [a1]).betaalspoor, 'ingevoerd', 'knop draait de nieuwe batch niet terug');
  assert.equal(t.fdb.db.prepare('SELECT status FROM signaal WHERE id = ?').get(sig[0].id).status, 'afgehandeld');
});

test('wv1415 terugboeking: "Leverancier incasseert" → incasso verwacht en leverancier op incasso; ander bedrag → alleen signaal, de knop zet hem dan terug', () => {
  const t = opzet();
  const b = bankOpzet(t);
  const abn = sepaRek(t, 'tolgaarde').find((k) => k.rekening === '…' + b.tg.slice(-4));
  const euro = (c) => (c / 100).toFixed(2).replace('.', ',');
  const NA = Date.parse('2026-11-06T10:00:00Z');
  // blok van één betaling: ABN boekt hem los met de EndToEndId; de terugboeking volgt een dag later
  const e = teBetalenFactuur(t);
  assert.equal(sepaDownload(t, abn.id, [e]).r.status, 200);
  const fe = t.f('id = ?', [e]);
  t.zetKlaar('beurt-terug-e', 1, 'export.tab', [tabRij('0000000031', '20261105', '-' + euro(fe.incl), '/TRTP/SEPA OVERBOEKING/IBAN/' + fe.iban + '/BIC/TESTNL2A/NAME/Proef/REMI/' + fe.nummer + '/EREF/' + e),
    tabRij('0000000031', '20261106', euro(fe.incl), '/TRTP/SEPA Terugboeking/IBAN/' + fe.iban + '/BIC/TESTNL2A/NAME/Proef/RTRN/MS02/REMI/' + fe.nummer + '/EREF/' + e)].join('\n') + '\n');
  const upE = t.call('POST', 'upload', { beurt: 'beurt-terug-e', n: 1, soort: 'auto' }, { nu: NA }); assert.equal(upE.status, 200, JSON.stringify(upE.j));
  assert.equal(t.f('id = ?', [e]).betaalspoor, 'te_betalen');
  const s = t.fdb.db.prepare("SELECT * FROM signaal WHERE soort = 'teruggeboekt' AND facturen LIKE ?").get('%' + e + '%');
  const k = t.call('POST', 'signaal', { id: s.id, knop: 'leverancier_incasseert' }, { nu: NA });
  assert.equal(k.status, 200, JSON.stringify(k.j));
  assert.equal(t.f('id = ?', [e]).betaalspoor, 'incasso_verwacht');
  assert.equal(t.fdb.db.prepare('SELECT standaard_betaalwijze AS w FROM leverancier WHERE id = ?').get(fe.leverancier).w, 'incasso');
  // ander bedrag terug (kosten ingehouden): factuur blijft betaald gezien tot David kiest; de knop zet hem dan op te betalen
  const g = teBetalenFactuur(t);
  assert.equal(sepaDownload(t, abn.id, [g]).r.status, 200);
  const fg = t.f('id = ?', [g]);
  t.zetKlaar('beurt-terug-g', 1, 'export.tab', [tabRij('0000000031', '20261105', '-' + euro(fg.incl), '/TRTP/SEPA OVERBOEKING/IBAN/' + fg.iban + '/BIC/TESTNL2A/NAME/Proef/REMI/' + fg.nummer + '/EREF/' + g),
    tabRij('0000000031', '20261107', euro(fg.incl - 500), '/TRTP/SEPA Terugboeking/IBAN/' + fg.iban + '/BIC/TESTNL2A/NAME/Proef/RTRN/AC04/REMI/' + fg.nummer + '/EREF/' + g)].join('\n') + '\n');
  assert.equal(t.call('POST', 'upload', { beurt: 'beurt-terug-g', n: 1, soort: 'auto' }, { nu: Date.parse('2026-11-08T10:00:00Z') }).status, 200);
  assert.equal(t.f('id = ?', [g]).betaalspoor, 'betaald_gezien');
  assert.equal(t.n("SELECT count(*) AS n FROM koppeling WHERE factuur = ? AND methode = 'sepa_terug'", [g]), 0);
  const sg = t.fdb.db.prepare("SELECT * FROM signaal WHERE soort = 'teruggeboekt' AND facturen LIKE ?").get('%' + g + '%');
  assert.equal(JSON.parse(sg.details).automatisch, false);
  assert.equal(t.call('POST', 'signaal', { id: sg.id, knop: 'opnieuw_betalen' }, { nu: Date.parse('2026-11-08T10:00:00Z') }).status, 200);
  const ng = t.f('id = ?', [g]);
  assert.deepEqual([ng.betaalspoor, ng.betaald_gezien_op], ['te_betalen', null]);
});

test('wv1415 diffreview: knop na een nieuwe, geziene betaling verandert niets (MOET 2); niet-exacte terugboeking via de knop vastgelegd → nieuwe batch kan, handbetaling geen dubbel (MOET 3); "Ja, koppel" na een terugboeking blijft te betalen (MOET 4); leesroute niet "betaald" (ZOU 4)', () => {
  const t = opzet();
  const b = bankOpzet(t);
  const abn = sepaRek(t, 'tolgaarde').find((k) => k.rekening === '…' + b.tg.slice(-4));
  const euro = (c) => (c / 100).toFixed(2).replace('.', ',');
  const upload = (beurt, regels, nu) => { t.zetKlaar(beurt, 1, 'export.tab', regels.join('\n') + '\n'); const u = t.call('POST', 'upload', { beurt, n: 1, soort: 'auto' }, { nu }); assert.equal(u.status, 200, JSON.stringify(u.j)); };
  const los = (f, dat, teken, extra) => tabRij('0000000031', dat, teken + euro(f.incl + (extra || 0)), (teken ? '/TRTP/SEPA OVERBOEKING' : '/TRTP/SEPA Terugboeking') + '/IBAN/' + f.iban +
    '/BIC/TESTNL2A/NAME/Proef/' + (teken ? '' : 'RTRN/AC04/') + 'REMI/' + f.nummer + '/EREF/' + f.id);
  const sigVan = (id) => t.fdb.db.prepare("SELECT * FROM signaal WHERE soort = 'teruggeboekt' AND facturen LIKE ?").get('%' + id + '%');
  // MOET 2: teruggeboekt → opnieuw in een batch → die batch is al gezien (betaald gezien) → pas dan de knop: blijft betaald gezien
  const a = teBetalenFactuur(t);
  assert.equal(sepaDownload(t, abn.id, [a]).r.status, 200);
  const fa = t.f('id = ?', [a]);
  upload('beurt-m2a', [los(fa, '20261105', '-'), los(fa, '20261106', '')], Date.parse('2026-11-06T10:00:00Z'));
  assert.equal(t.f('id = ?', [a]).betaalspoor, 'te_betalen');
  assert.equal(sepaDownload(t, abn.id, [a], [a + ':eerder_in_batch'], { nu: Date.parse('2026-11-06T11:00:00Z') }).r.status, 200);
  upload('beurt-m2b', [tabRij('0000000031', '20261110', '-' + euro(fa.incl), '/TRTP/SEPA OVERBOEKING/IBAN/' + fa.iban + '/BIC/TESTNL2A/NAME/Proef/REMI/' + fa.nummer + '/EREF/' + a)],
    Date.parse('2026-11-11T10:00:00Z'));
  assert.equal(t.f('id = ?', [a]).betaalspoor, 'betaald_gezien', 'de nieuwe batch is gezien');
  for (const knop of ['opnieuw_betalen', 'leverancier_incasseert']) {
    const s = sigVan(a);
    t.fdb.db.prepare("UPDATE signaal SET status = 'open', afhandeling = NULL, wie = NULL, wanneer = NULL, les = NULL WHERE id = ?").run(s.id);
    assert.equal(t.call('POST', 'signaal', { id: s.id, knop }, { nu: Date.parse('2026-11-11T11:00:00Z') }).status, 200, knop);
    assert.equal(t.f('id = ?', [a]).betaalspoor, 'betaald_gezien', knop + ': spoor blijft');
  }
  // MOET 3: niet-exacte terugboeking (kosten ingehouden); de knop legt hem vast → nieuwe batch mag (met akkoord), handbetaling → betaald gezien, geen dubbel
  const g = teBetalenFactuur(t);
  assert.equal(sepaDownload(t, abn.id, [g]).r.status, 200);
  const fg = t.f('id = ?', [g]);
  upload('beurt-m3a', [los(fg, '20261105', '-'), los(fg, '20261107', '', -500)], Date.parse('2026-11-08T10:00:00Z'));
  assert.equal(t.f('id = ?', [g]).betaalspoor, 'betaald_gezien', 'niet automatisch');
  assert.equal(t.call('POST', 'signaal', { id: sigVan(g).id, knop: 'opnieuw_betalen' }, { nu: Date.parse('2026-11-08T11:00:00Z') }).status, 200);
  assert.equal(t.f('id = ?', [g]).betaalspoor, 'te_betalen');
  assert.equal(t.n("SELECT count(*) AS n FROM koppeling WHERE factuur = ? AND methode = 'sepa_terug' AND bron = 'mens'", [g]), 1);
  assert.equal(t.call('GET', 'betalen', null, { nu: Date.parse('2026-11-08T11:00:00Z') }).j.te_betalen.find((x) => x.id === g).batch_reden, null, 'nieuwe batch kan');
  upload('beurt-m3b', [tabRij('0000000031', '20261112', '-' + euro(fg.incl), '/TRTP/SEPA OVERBOEKING/IBAN/' + fg.iban + '/BIC/TESTNL2A/NAME/Proef/REMI/Factuur ' + fg.nummer + '/EREF/NOTPROVIDED')],
    Date.parse('2026-11-13T10:00:00Z'));
  assert.equal(t.f('id = ?', [g]).betaalspoor, 'betaald_gezien');
  assert.equal(t.n("SELECT count(*) AS n FROM signaal WHERE soort = 'dubbel_betaald' AND facturen LIKE ?", ['%' + g + '%']), 0);
  // MOET 4: "Ja, koppel" van de batchafschrijving na de terugboeking: de factuur blijft te betalen
  const c = teBetalenFactuur(t);
  assert.equal(sepaDownload(t, abn.id, [c]).r.status, 200);
  const fc = t.f('id = ?', [c]);
  upload('beurt-m4', [tabRij('0000000031', '20261105', '-' + euro(fc.incl), 'SEPA Batch zonder kenmerk'), los(fc, '20261106', '')], Date.parse('2026-11-06T10:00:00Z'));
  assert.equal(t.f('id = ?', [c]).betaalspoor, 'te_betalen');
  const afC = t.fdb.db.prepare("SELECT id FROM bank_transactie WHERE boekdatum = '2026-11-05' AND bedrag_centen = ?").get(-fc.incl);
  const kop = t.call('POST', 'koppel', { transactie: afC.id, factuur: c }, { nu: Date.parse('2026-11-06T11:00:00Z') });
  assert.equal(kop.status, 200, JSON.stringify(kop.j));
  assert.equal(t.f('id = ?', [c]).betaalspoor, 'te_betalen', 'de terugboeking heft deze betaling op');
  // ZOU 4: de leesroute (facturen-lezen) noemt hem niet betaald
  const v = F.validatie(t.fdb, t.eig, { soort: 'factuur', id: c }, Date.parse('2026-11-06T11:00:00Z'));
  assert.equal(v.betaling.betaald, false, JSON.stringify(v.betaling));
  assert.equal(F.validatie(t.fdb, t.eig, { soort: 'factuur', id: g }, Date.parse('2026-11-13T11:00:00Z')).betaling.betaald, true, 'opnieuw betaald: wel');
});

// ───────────────────────────── wv1917: leveranciersnaam met de hand, regels per afzender ─────────────────────────────

test('wv1917: naam invullen koppelt een leverancier (nagebeld IBAN gaat mee); "Onthoud voor deze afzender" gaat bij het volgende stuk vóór het tekstanker; weghalen', () => {
  const t = opzet();
  const bron = t.fdb.db.prepare("SELECT id FROM bron WHERE soort = 'verzamelpostvak'").get().id;
  D.voegToe(t.fdb, 'tekstanker', { tekst: 'Oude Eenmanszaak Proef', entiteit: 'holding', aangemaakt_door: 'proef', aangemaakt_op: '2026-10-01T00:00:00Z' });
  const iban = Z.maakIban('NL', 'TEST', '0917000001');
  const stuur = (afzender, nr) => {
    const bid = D.nieuwId();
    D.voegToe(t.fdb, 'bericht', { id: bid, bron, message_id: 'wv1917-' + nr, afzender, onderwerp: 'Factuur ' + nr, ontvangen_op: '2026-10-22T10:00:00Z' });
    const tekst = ['Factuur', 'Oude Eenmanszaak Proef', 'Factuurnummer ' + nr, 'Factuurdatum 22-10-2026', 'Vervaldatum 05-11-2026', 'Totaal € 45,82',
      'IBAN ' + iban.replace(/(.{4})/g, '$1 ').trim(), 'Deze factuur is al betaald.'].join('\n');
    const v = F.verwerkBericht(t.fdb, { bericht: { id: bid, message_id: 'wv1917-' + nr, afzender, onderwerp: 'Factuur ' + nr },
      documenten: [{ sha256: crypto.createHash('sha256').update(tekst).digest('hex'), naam: nr + '.pdf', mime: 'application/pdf', tekst }] }, { nu: NU, wie: 'koerier' });
    return t.f('id = ?', [v.facturen[0].id]);
  };
  const f1 = stuur('noreply@hostingproef.invalid', 'WV1917-1');
  assert.equal(f1.leverancier, null);
  assert.equal(f1.entiteit, 'holding', 'tekstanker beslist zonder regel');
  assert.equal(f1.betaalwijze, 'zelf', '"al betaald" op het stuk is geen bewijs');
  assert.ok(JSON.parse(f1.redenen).some((r) => r.includes(K.ZEGT_BETAALD)));
  // nabellen vóór er een leverancier is: het IBAN kan nog nergens bekend worden
  t.vers.ok = true;
  assert.equal(t.call('POST', 'nagebeld', { id: f1.id }).status, 200);
  assert.equal(t.n('SELECT count(*) n FROM leverancier_iban WHERE iban = ?', [iban]), 0);
  // regel kan pas met een leverancier
  assert.equal(t.call('POST', 'regel', { factuur: f1.id, soort: 'domein' }).status, 409);
  // naam invullen (eigenaar): nieuwe leverancier, het nagebelde IBAN gaat mee
  let r = t.call('POST', 'wijzig', { id: f1.id, versie: t.f('id = ?', [f1.id]).versie, velden: { leverancier_naam: '  Hostingproef  B.V. ' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const f1b = t.f('id = ?', [f1.id]);
  assert.ok(f1b.leverancier);
  assert.equal(f1b.leverancier_naam, 'Hostingproef B.V.');
  assert.equal(t.n('SELECT count(*) n FROM leverancier_iban WHERE leverancier = ? AND iban = ?', [f1b.leverancier, iban]), 1);
  assert.equal(r.j.iban_poort.iban_nieuw, false);
  // dezelfde naam nog eens (andere schrijfwijze) koppelt dezelfde leverancier, geen tweede
  r = t.call('POST', 'wijzig', { id: f1.id, versie: f1b.versie, velden: { leverancier_naam: 'HOSTINGPROEF B.V.' } });
  assert.equal(r.status, 200);
  assert.equal(t.n("SELECT count(*) n FROM leverancier WHERE genormaliseerd = ?", [K.normNaam('Hostingproef B.V.')]), 1);
  // detail toont de afzender (eigenaar)
  let d = t.call('GET', 'factuur/' + f1.id).j;
  assert.deepEqual([d.afzender.adres, d.afzender.domein, d.afzender.domein_mag, d.afzender.regel], ['noreply@hostingproef.invalid', 'hostingproef.invalid', true, null]);
  // praktijkmanager: geen regels
  assert.equal(t.call('POST', 'regel', { factuur: f1.id, soort: 'domein' }, { rol: t.pm() }).status, 403);
  assert.equal(t.call('GET', 'regels', null, { rol: t.pm() }).status, 403);
  // onthouden voor het hele domein → Tolgaarde, zelf betalen
  r = t.call('POST', 'regel', { factuur: f1.id, soort: 'domein', entiteit: 'tolgaarde', betaalwijze: 'zelf' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.regel.patroon, 'hostingproef.invalid');
  d = t.call('GET', 'factuur/' + f1.id).j;
  assert.equal(d.afzender.regel.entiteit, 'tolgaarde');
  const lijst = t.call('GET', 'regels').j.regels;
  assert.deepEqual(lijst.map((x) => [x.patroon, x.leverancier_naam, x.entiteit, x.betaalwijze]), [['hostingproef.invalid', 'Hostingproef B.V.', 'tolgaarde', 'zelf']]);
  // het volgende stuk van dat domein: leverancier en entiteit uit de regel, het nagebelde IBAN is bekend
  const f2 = stuur('Facturen <Facturen@Mail.HostingProef.invalid>', 'WV1917-2');
  assert.equal(f2.leverancier, f1b.leverancier);
  assert.equal(f2.entiteit, 'tolgaarde');
  assert.equal(f2.betaalwijze, 'zelf');
  assert.equal(f2.iban_nieuw, 0);
  assert.ok(JSON.parse(f2.redenen).some((x) => /Regel voor afzender hostingproef\.invalid: Tolgaarde/.test(x)));
  // weghalen: het stuk daarna valt weer terug op het tekstanker
  assert.equal(t.call('POST', 'regel-weg', { id: lijst[0].id }).status, 200);
  assert.equal(t.call('GET', 'regels').j.regels.length, 0);
  assert.equal(stuur('noreply@hostingproef.invalid', 'WV1917-3').entiteit, 'holding');
  assert.equal(t.n("SELECT count(*) n FROM audit WHERE object_soort = 'afzender_regel'"), 2);
  // algemene mailaanbieder: geen domeinregel, wel op het adres
  const f4 = stuur('iemand@gmail.com', 'WV1917-4');
  t.call('POST', 'wijzig', { id: f4.id, versie: f4.versie, velden: { leverancier_naam: 'Hostingproef B.V.' } });
  assert.equal(t.call('POST', 'regel', { factuur: f4.id, soort: 'domein' }).status, 400);
  assert.equal(t.call('POST', 'regel', { factuur: f4.id, soort: 'adres', entiteit: 'holding' }).status, 200);
  assert.equal(t.call('GET', 'regels').j.regels[0].patroon, 'iemand@gmail.com');
  // ongeldige invoer
  assert.equal(t.call('POST', 'wijzig', { id: f4.id, velden: { leverancier_naam: 'x' } }).status, 400);
  assert.equal(t.call('POST', 'regel', { factuur: f4.id, soort: 'adres', betaalwijze: 'onbekend' }).status, 400);
  assert.equal(t.call('POST', 'regel', { factuur: f4.id, soort: 'adres', entiteit: 'bestaatniet' }).status, 400);
});

test('wv1917: onbetaald(fdb) leest alleen bevestigde, zakelijke, niet-gekoppelde facturen met een open betaalspoor, met de bankstand van de entiteit', () => {
  const t = opzet();
  const KA = require(path.join(ROOT, 'facturen-kaart.js'));
  const rijen = KA.onbetaald(t.fdb);
  assert.ok(rijen.length > 0, 'zaad heeft open facturen');
  for (const r of rijen) {
    const f = t.f('id = ?', [r.id]);
    assert.ok(['in_wachtrij', 'wordt_verstuurd', 'concept_klaar', 'verstuurd', 'verzending_mislukt'].includes(f.status));
    assert.ok(f.entiteit !== 'prive' && f.soort === 'factuur' && f.incl > 0);
    assert.ok(['te_betalen', 'ingevoerd', 'incasso_verwacht', 'betaald_vooraf'].includes(f.betaalspoor));
    assert.equal(t.n('SELECT count(*) n FROM koppeling WHERE factuur = ?', [r.id]), 0);
  }
  // een koppeling haalt hem eruit
  const tx = t.fdb.db.prepare("SELECT t.id FROM bank_transactie t JOIN rekening r ON r.id = t.rekening WHERE r.entiteit = ? LIMIT 1").get(rijen[0].entiteit);
  if (tx) {
    t.fdb.db.prepare("INSERT INTO koppeling (transactie, factuur, bron, wie, wanneer) VALUES (?, ?, 'mens', 'proef', '2026-10-22T10:00:00Z')").run(tx.id, rijen[0].id);
    assert.ok(!KA.onbetaald(t.fdb).some((r) => r.id === rijen[0].id));
  }
  assert.ok(rijen.some((r) => r.bank_tot), 'bankstand per entiteit');
});

test('wv1917 diffreview: nagebeld IBAN gaat nooit mee naar een bestaande leverancier of bij een wissel; "zegt al betaald" waarschuwt op de betaallijst en in de batch', () => {
  const t = opzet();
  const KA = require(path.join(ROOT, 'facturen-kaart.js'));
  const bron = t.fdb.db.prepare("SELECT id FROM bron WHERE soort = 'verzamelpostvak'").get().id;
  let nr = 0;
  const stuur = (iban, extra) => {
    const bid = D.nieuwId(); nr++;
    D.voegToe(t.fdb, 'bericht', { id: bid, bron, message_id: 'wv1917r-' + nr, afzender: 'a@b-proef.invalid', onderwerp: 'F', ontvangen_op: '2026-10-22T10:00:00Z' });
    const tekst = ['Factuur', 'Factuurnummer R' + nr, 'Factuurdatum 22-10-2026', 'Vervaldatum 05-11-2026', 'Totaal € 12,10', 'IBAN ' + iban.replace(/(.{4})/g, '$1 ').trim(), extra || ''].join('\n');
    const v = F.verwerkBericht(t.fdb, { bericht: { id: bid, message_id: 'wv1917r-' + nr, afzender: 'a@b-proef.invalid', onderwerp: 'F' },
      documenten: [{ sha256: crypto.createHash('sha256').update(tekst).digest('hex'), naam: 'r.pdf', mime: 'application/pdf', tekst }] }, { nu: NU, wie: 'koerier' });
    return t.f('id = ?', [v.facturen[0].id]);
  };
  t.vers.ok = true;
  // bestaande leverancier B: naam invullen na nabellen → IBAN niet bij B
  const bestaand = t.fdb.db.prepare('SELECT id, naam FROM leverancier ORDER BY aangemaakt_op LIMIT 1').get();
  const iban1 = Z.maakIban('NL', 'TEST', '0917100001');
  const f1 = stuur(iban1);
  t.vers.ok = true; assert.equal(t.call('POST', 'nagebeld', { id: f1.id }).status, 200);
  let r = t.call('POST', 'wijzig', { id: f1.id, velden: { leverancier_naam: bestaand.naam } });
  assert.equal(r.status, 200); assert.equal(r.j.leverancier_bekend, 0);
  assert.equal(t.n('SELECT count(*) n FROM leverancier_iban WHERE iban = ?', [iban1]), 0);
  assert.equal(r.j.iban_poort.iban_nieuw, true, 'opnieuw nabellen bij de bestaande leverancier');
  // wissel: factuur had al een (nieuwe) leverancier → naar een tweede nieuwe naam: niets mee
  const iban2 = Z.maakIban('NL', 'TEST', '0917100002');
  const f2 = stuur(iban2);
  t.call('POST', 'wijzig', { id: f2.id, velden: { leverancier_naam: 'Eerste Proefnaam B.V.' } });
  t.vers.ok = true; assert.equal(t.call('POST', 'nagebeld', { id: f2.id }).status, 200);
  const na = t.n('SELECT count(*) n FROM leverancier_iban WHERE iban = ?', [iban2]);
  r = t.call('POST', 'wijzig', { id: f2.id, velden: { leverancier_naam: 'Tweede Proefnaam B.V.' } });
  assert.equal(r.status, 200); assert.equal(r.j.leverancier_bekend, 0);
  assert.equal(t.n('SELECT count(*) n FROM leverancier_iban WHERE iban = ?', [iban2]), na, 'geen extra rij bij de tweede leverancier');
  // nieuwe leverancier, factuur zonder leverancier: wel mee, met auditrij (alleen de laatste vier tekens)
  const iban3 = Z.maakIban('NL', 'TEST', '0917100003');
  const f3 = stuur(iban3, 'Deze factuur is al betaald.');
  t.vers.ok = true; assert.equal(t.call('POST', 'nagebeld', { id: f3.id }).status, 200);
  r = t.call('POST', 'wijzig', { id: f3.id, velden: { leverancier_naam: 'Derde Proefnaam B.V.' } });
  assert.equal(r.j.leverancier_bekend, 1);
  const au = t.fdb.db.prepare("SELECT na FROM audit WHERE wat = 'nagebeld_meegenomen' ORDER BY id DESC LIMIT 1").get();
  assert.ok(au && au.na.includes('…' + iban3.slice(-4)) && !au.na.includes(iban3));
  // "zegt al betaald": bevestigen (entiteit kiezen) → betaallijst met zegt_betaald en SEPA-waarschuwing
  const f3b = t.f('id = ?', [f3.id]);
  r = t.call('POST', 'bevestig', { id: f3.id, versie: f3b.versie, entiteit: 'tolgaarde', betaalwijze: 'zelf' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const bl = t.call('GET', 'betalen').j.te_betalen.find((x) => x.id === f3.id);
  assert.ok(bl && bl.zegt_betaald === true, JSON.stringify(bl));
  assert.ok((bl.waarschuwingen || []).some((w) => w.code === 'zegt_betaald'), JSON.stringify(bl.waarschuwingen));
  assert.ok(t.call('GET', 'betalen').j.te_betalen.filter((x) => x.id !== f3.id).every((x) => !(x.waarschuwingen || []).some((w) => w.code === 'zegt_betaald')));
  // open koppelvoorstel → geen onbetaald-kandidaat
  assert.ok(KA.onbetaald(t.fdb).some((x) => x.id === f3.id));
  const tx = t.fdb.db.prepare("SELECT t.id FROM bank_transactie t WHERE t.entiteit = 'tolgaarde' LIMIT 1").get();
  t.fdb.db.prepare("INSERT INTO voorstel (sleutel, transactie, facturen, methode, zekerheid, aangemaakt_op) VALUES ('wv1917-proef', ?, ?, 'iban_bedrag', 0.6, '2026-10-22T10:00:00Z')").run(tx.id, JSON.stringify([f3.id]));
  assert.ok(!KA.onbetaald(t.fdb).some((x) => x.id === f3.id));
});

// ───────────────────────────── wv2006: voorstellen uit Davids verzonden mail ─────────────────────────────

test('wv2006: voorstellen per afzender doen niets tot David bevestigt; bevestigen maakt een afzender_regel (leverancier op naam), afwijzen niet; alleen de eigenaar', () => {
  const t = opzet();
  const bron = t.fdb.db.prepare("SELECT id FROM bron WHERE soort = 'verzamelpostvak'").get().id;
  D.voegToe(t.fdb, 'tekstanker', { tekst: 'Oude Eenmanszaak Proef', entiteit: 'holding', aangemaakt_door: 'proef', aangemaakt_op: '2026-10-01T00:00:00Z' });
  const stuur = (afzender, nr) => {
    const bid = D.nieuwId();
    D.voegToe(t.fdb, 'bericht', { id: bid, bron, message_id: 'wv2006-' + nr, afzender, onderwerp: 'Factuur ' + nr, ontvangen_op: '2026-10-22T10:00:00Z' });
    const tekst = ['Factuur', 'Oude Eenmanszaak Proef', 'Factuurnummer ' + nr, 'Factuurdatum 22-10-2026', 'Vervaldatum 05-11-2026', 'Totaal € 45,82'].join('\n');
    const v = F.verwerkBericht(t.fdb, { bericht: { id: bid, message_id: 'wv2006-' + nr, afzender, onderwerp: 'Factuur ' + nr },
      documenten: [{ sha256: crypto.createHash('sha256').update(tekst).digest('hex'), naam: nr + '.pdf', mime: 'application/pdf', tekst }] }, { nu: NU, wie: 'koerier' });
    return t.f('id = ?', [v.facturen[0].id]);
  };
  assert.deepEqual(t.call('GET', 'afzender-voorstellen').j.voorstellen, []);
  const item = (patroon, soort, extra) => Object.assign({ patroon, soort, naam: 'Voorstelproef B.V.', aantal: 4, entiteit: 'tolgaarde', entiteiten: { tolgaarde: 4 }, nogbetalen: 4,
    betaalwijze: 'zelf', voorbeeld: 'Factuur 1', laatst: '2026-10-01', status: 'voorstel' }, extra || {});
  D.metaZet(t.fdb, 'afzender_voorstellen', JSON.stringify({ gemeten: '2026-10-30', venster: 'proef', items: [item('voorstelproef.invalid', 'domein'),
    item('iemand@gmail.com', 'adres', { naam: 'Iemand Proef', entiteit: null, betaalwijze: null }), item('gmail.com', 'domein')] }));
  // zolang het een voorstel is: het stuk volgt het tekstanker, geen regel
  assert.equal(stuur('nota@voorstelproef.invalid', 'A').entiteit, 'holding');
  assert.equal(t.n('SELECT count(*) n FROM afzender_regel'), 0);
  // praktijkmanager: niets
  assert.equal(t.call('GET', 'afzender-voorstellen', null, { rol: t.pm() }).status, 403);
  assert.equal(t.call('POST', 'afzender-voorstel', { patroon: 'voorstelproef.invalid', keuze: 'bevestig' }, { rol: t.pm() }).status, 403);
  // bevestigen → regel met entiteit en betaalwijze uit het voorstel; het volgende stuk volgt de regel
  let r = t.call('POST', 'afzender-voorstel', { patroon: 'Voorstelproef.invalid', keuze: 'bevestig' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.status, 'bevestigd');
  const f = stuur('nota@voorstelproef.invalid', 'B');
  assert.equal(f.entiteit, 'tolgaarde'); assert.equal(f.betaalwijze, 'zelf'); assert.equal(f.leverancier_naam, 'Voorstelproef B.V.');
  assert.equal(t.call('POST', 'afzender-voorstel', { patroon: 'voorstelproef.invalid', keuze: 'bevestig' }).status, 409, 'niet twee keer');
  const lijst = t.call('GET', 'afzender-voorstellen').j.voorstellen;
  assert.deepEqual(lijst.map((x) => [x.patroon, x.status, x.regel && x.regel.entiteit]), [['voorstelproef.invalid', 'bevestigd', 'tolgaarde'], ['iemand@gmail.com', 'voorstel', null], ['gmail.com', 'voorstel', null]]);
  // aangepast bevestigen: andere entiteit, betaalwijze leeg
  r = t.call('POST', 'afzender-voorstel', { patroon: 'iemand@gmail.com', keuze: 'bevestig', entiteit: 'pot', betaalwijze: '' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(Object.assign({}, t.fdb.db.prepare("SELECT soort, entiteit, betaalwijze FROM afzender_regel WHERE patroon = 'iemand@gmail.com'").get()), { soort: 'adres', entiteit: 'pot', betaalwijze: null });
  // algemene mailaanbieder als domein: nooit; afwijzen en terugzetten; onbekend
  assert.equal(t.call('POST', 'afzender-voorstel', { patroon: 'gmail.com', keuze: 'bevestig' }).status, 400);
  assert.equal(t.call('POST', 'afzender-voorstel', { patroon: 'gmail.com', keuze: 'afwijs' }).status, 200);
  assert.equal(t.call('POST', 'afzender-voorstel', { patroon: 'gmail.com', keuze: 'afwijs' }).status, 409);
  assert.equal(t.call('POST', 'afzender-voorstel', { patroon: 'gmail.com', keuze: 'terug' }).status, 200);
  assert.equal(t.call('POST', 'afzender-voorstel', { patroon: 'bestaat.invalid', keuze: 'afwijs' }).status, 404);
  assert.equal(t.call('POST', 'afzender-voorstel', { patroon: 'gmail.com', keuze: 'zomaar' }).status, 400);
  assert.equal(t.call('POST', 'afzender-voorstel', { patroon: 'gmail.com', keuze: 'afwijs' }, { primair: false }).status, 409);
  assert.equal(t.n("SELECT count(*) n FROM afzender_regel"), 2);
  assert.equal(t.n("SELECT count(*) n FROM audit WHERE object_soort = 'afzender_regel'"), 2);
});

// ───────────────────────────── wv2025: specificatie per batch voor de boekhouder ─────────────────────────────

const SP = require(path.join(ROOT, 'facturen-specificatie.js'));
// alle tekst uit de PDF (hex-strings in WinAnsi, zoals facturen-specificatie.js ze schrijft)
function pdfTekst(buf) {
  const s = buf.toString('latin1');
  const uit = [];
  for (const m of s.matchAll(/<([0-9A-F]+)> Tj/g)) {
    const b = Buffer.from(m[1], 'hex');
    uit.push([...b].map((c) => (c === 0x80 ? '€' : c === 0x85 ? '…' : String.fromCharCode(c))).join(''));
  }
  return uit.join('\n');
}
// verzonnen batch: 3 facturen, 2 uitvoerdatums (30-10 en 5-11)
function specBatch(t) {
  // twee uitvoerdatums: zelf gekozen (de standaard is sinds 30-10-2026 de dag van de batch)
  const a = teBetalenFactuur(t, { incl: 12100, velden: { betaal_op: '2026-11-05' } });
  const b = teBetalenFactuur(t, { incl: 4250, velden: { betaal_op: '2026-10-30' } });
  const c = teBetalenFactuur(t, { incl: 99999, velden: { betaal_op: '2026-11-05' } });
  const [rek] = sepaRek(t, 'tolgaarde');
  const { r } = sepaDownload(t, rek.id, [a, b, c], []);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  return { a, b, c, batch: r.j.batch, msg_id: r.j.msg_id, rek };
}

test('wv2025 specificatie: PDF per uitvoerdatum met subtotaal en alle factuurnummers; geen IBAN van een leverancier; download met spoor', () => {
  const t = opzet();
  const x = specBatch(t);
  const nr = (id) => t.f('id = ?', [id]).nummer;
  const sp = t.call('POST', 'sepa-specificatie', { batch: x.batch });
  assert.equal(sp.status, 200, JSON.stringify(sp.j));
  assert.equal(sp.j.bestand.type, 'application/pdf');
  assert.equal(sp.j.bestand.codering, 'base64');
  assert.match(sp.j.bestand.naam, /^Specificatie SEPA-batch Tolgaarde 2026-10-22 [0-9a-f]{8}\.pdf$/);
  const pdf = Buffer.from(sp.j.bestand.inhoud, 'base64');
  assert.equal(pdf.slice(0, 5).toString(), '%PDF-');
  assert.equal(crypto.createHash('sha256').update(pdf).digest('hex'), sp.j.bestand.sha256);
  const tekst = pdfTekst(pdf);
  for (const id of [x.a, x.b, x.c]) assert.ok(tekst.includes(nr(id)), 'factuurnummer ' + nr(id));
  assert.match(tekst, /Uitvoerdatum vrijdag 30 oktober 2026/);
  assert.match(tekst, /Uitvoerdatum donderdag 5 november 2026/);
  assert.match(tekst, /Subtotaal 30 oktober 2026\n€ 42,50/);
  assert.match(tekst, /Subtotaal 5 november 2026\n€ 1\.120,99/);   // 121,00 + 999,99
  assert.match(tekst, /Totaal batch \(3 facturen\)\n€ 1\.163,49/);
  assert.ok(tekst.includes(x.msg_id), 'batchkenmerk');
  assert.ok(tekst.includes('…' + x.rek.rekening.slice(-4)), 'eigen rekening alleen de laatste vier');
  // nooit een IBAN (van de leverancier of de eigen rekening voluit), geen btw-bedrag
  const ibans = t.fdb.db.prepare('SELECT iban FROM sepa_regel UNION SELECT dbtr_iban FROM sepa_batch').all().map((r) => r.iban);
  for (const i of ibans) assert.ok(!tekst.includes(i) && !pdf.toString('latin1').includes(i), 'geen IBAN voluit');
  assert.doesNotMatch(tekst, /\bbtw\b.*€|excl/i);
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'sepa_specificatie_download' AND object_id = ?", [x.batch]), 1);
  assert.equal(sp.j.specificatie.status, 'geen');
  // alleen de eigenaar via de app; onbekende batch 404; passieve kant 409
  assert.equal(t.call('POST', 'sepa-specificatie', { batch: x.batch }, { rol: F.rolVoor(t.fdb, { ingang: 'machinekamer' }) }).status, 403);
  assert.equal(t.call('POST', 'sepa-specificatie', { batch: '0123456789abcdef' }).status, 404);
  assert.equal(t.call('POST', 'sepa-specificatie', { batch: x.batch }, { primair: false }).status, 409);
  // de batch zelf is niet geraakt
  assert.equal(t.n('SELECT count(*) AS n FROM sepa_batch'), 1);
  assert.equal(t.n("SELECT count(*) AS n FROM sepa_regel r JOIN factuur f ON f.id = r.factuur WHERE r.batch = ? AND f.betaalspoor = 'ingevoerd'", [x.batch]), 3);
});

test('wv2025 specificatie: concept (gemockt luik) — ontvanger, mailtekst, spoor klaar/mislukt/onbekend, niet dubbel; de batch blijft altijd staan', () => {
  const t = opzet();
  const x = specBatch(t);
  const sp = t.routes.specificatie;
  const o = (extra) => Object.assign({ nu: NU + 1000, primair: true, aanleiding: 'batch' }, extra || {});
  assert.equal(sp.concept(t.fdb, t.eig, x.batch, o({ primair: false })).status, 409, 'alleen primair');
  const c = sp.concept(t.fdb, t.eig, x.batch, o());
  assert.equal(c.status, 200, JSON.stringify(c.j));
  // Tolgaarde heeft geen eigen afschriftadres: het ene afschriftadres dat Facturen kent (de boekhouder)
  assert.equal(c.j.aan, 'afschrift-pot@acta.invalid');
  assert.match(c.j.onderwerp, /^Specificatie SEPA-batch Tolgaarde \(2 uitvoerdatums, € 1\.163,49\)$/);
  assert.match(c.j.bericht, /^Ha pa,/);
  assert.match(c.j.bericht, /Uitvoerdatum vrijdag 30 oktober 2026: € 42,50 \(1 factuur\)/);
  assert.match(c.j.bericht, /Uitvoerdatum donderdag 5 november 2026: € 1\.120,99 \(2 facturen\)/);
  for (const id of [x.a, x.b, x.c]) assert.ok(c.j.bericht.includes(t.f('id = ?', [id]).nummer));
  assert.match(c.j.bericht, /Groet,\nDavid$/);
  assert.equal(Buffer.from(c.j.bijlage.inhoud_base64, 'base64').slice(0, 5).toString(), '%PDF-');
  assert.equal(c.j.bijlage.mime, 'application/pdf');
  // tijdens het klaarzetten: geen tweede
  const stand = () => t.call('GET', 'betalen').j.sepa.batches.find((b) => b.id === x.batch).specificatie;
  assert.equal(stand().status, 'bezig');
  assert.equal(sp.concept(t.fdb, t.eig, x.batch, o()).j.code, 'bezig');
  // faalpad: het luik weigerde → mislukt, batch en facturen ongemoeid; daarna opnieuw mag zonder nogmaals
  assert.equal(sp.uitkomst(t.fdb, t.eig, x.batch, { ok: false, reden: 'het mailluik weigerde het concept' }, o()).j.specificatie.status, 'mislukt');
  assert.deepEqual([stand().status, stand().reden], ['mislukt', 'het mailluik weigerde het concept']);
  assert.equal(t.n('SELECT count(*) AS n FROM sepa_batch'), 1);
  assert.equal(t.n('SELECT count(*) AS n FROM sepa_regel WHERE batch = ?', [x.batch]), 3);
  assert.equal(t.n("SELECT count(*) AS n FROM sepa_regel r JOIN factuur f ON f.id = r.factuur WHERE r.batch = ? AND f.betaalspoor = 'ingevoerd'", [x.batch]), 3);
  assert.equal(sp.concept(t.fdb, t.eig, x.batch, o({ nu: NU + 2000, aanleiding: 'knop' })).status, 200);
  // geslaagd → klaar; nog een keer alleen met nogmaals
  assert.equal(sp.uitkomst(t.fdb, t.eig, x.batch, { ok: true, concept_id: 'r-proef-1' }, o({ nu: NU + 3000 })).j.specificatie.status, 'klaar');
  const dubbel = sp.concept(t.fdb, t.eig, x.batch, o({ nu: NU + 4000 }));
  assert.deepEqual([dubbel.status, dubbel.j.code], [409, 'al_klaar']);
  assert.equal(sp.concept(t.fdb, t.eig, x.batch, o({ nu: NU + 5000, nogmaals: true })).status, 200);
  // geen bevestiging (time-out): onbekend, opnieuw alleen met nogmaals
  sp.uitkomst(t.fdb, t.eig, x.batch, { ok: false, onzeker: true, reden: 'geen bevestiging' }, o({ nu: NU + 6000 }));
  assert.equal(stand().status, 'onbekend');
  assert.equal(sp.concept(t.fdb, t.eig, x.batch, o({ nu: NU + 7000 })).j.code, 'misschien_al');
  // aangevraagd zonder uitkomst: na drie minuten ook onbekend
  assert.equal(sp.concept(t.fdb, t.eig, x.batch, o({ nu: NU + 8000, nogmaals: true })).status, 200);
  assert.equal(t.call('GET', 'betalen', null, { nu: NU + 8000 + 4 * 60000 }).j.sepa.batches[0].specificatie.status, 'onbekend');
  // het spoor staat in de audit, zonder adres of tekst
  const spoor = t.fdb.db.prepare("SELECT wat, na FROM audit WHERE object_soort = 'sepa_batch' AND wat LIKE 'sepa_specificatie%'").all();
  assert.equal(spoor.length, 7);
  assert.doesNotMatch(JSON.stringify(spoor), /acta\.invalid|Ha pa|%PDF/);
  // geen ontvanger: mislukt met reden, geen concept
  t.fdb.db.prepare('UPDATE entiteit SET afschrift_doel = NULL').run();
  const y = specBatch(t);
  const g = sp.concept(t.fdb, t.eig, y.batch, o());
  assert.deepEqual([g.status, g.j.klaar, g.j.aan], [200, false, undefined]);
  assert.equal(t.call('GET', 'betalen').j.sepa.batches.find((b) => b.id === y.batch).specificatie.status, 'mislukt');
});

test('wv2025 specificatie: module — telt na tegen de batch, lange batch over meer pagina\'s, mail zonder regels boven 20', () => {
  const batch = { id: '0123456789abcdef', msg_id: 'SOCEV-20261030-abcdef12', wanneer: '2026-10-30T11:00:00.000Z', entiteit: 'holding', entiteit_naam: 'Proef Holding B.V.',
    entiteit_kort: 'Holding', rekening_eind: '4321', aantal: 2, totaal_centen: 300 };
  const regels = [{ positie: 1, uitvoerdatum: '2026-11-02', leverancier: 'Proef A', nummer: 'A-1', centen: 100 }, { positie: 2, uitvoerdatum: '2026-11-02', leverancier: 'Proef B', nummer: null, centen: 200 }];
  const s = SP.maak(batch, regels, { gemaakt: '2026-10-30T11:00:00.000Z' });
  assert.equal(s.g.blokken.length, 1);
  assert.match(s.mail.onderwerp, /\(uitvoer 2 november 2026, € 3,00\)$/);
  assert.match(pdfTekst(s.pdf), /zonder nummer/);
  assert.throws(() => SP.maak(Object.assign({}, batch, { totaal_centen: 301 }), regels), SP.SpecFout);
  assert.throws(() => SP.maak(Object.assign({}, batch, { aantal: 3 }), regels), SP.SpecFout);
  assert.throws(() => SP.maak(batch, []), SP.SpecFout);
  // met een huisstijl: briefhoofd in de PDF
  const st = SP.maak(batch, regels, { stijl: { naam: 'Proef B.V.', caps: 'PROEFPRAKTIJK', briefnaam: 'Proef', ondertitel: 'Een, twee, drie.', kleuren: { titel: '2C2C2C', accent: 'E2232A' } } });
  assert.match(pdfTekst(st.pdf), /PROEFPRAKTIJK\nProef\nEen, twee, drie\./);
  // 60 regels over drie datums: meer pagina's, alle nummers erin, mail zonder de regels
  const veel = [];
  for (let i = 1; i <= 60; i++) veel.push({ positie: i, uitvoerdatum: ['2026-11-02', '2026-11-03', '2026-11-04'][i % 3], leverancier: 'Leverancier ' + i, nummer: 'N-' + i, centen: 1000 + i });
  const lang = SP.maak(Object.assign({}, batch, { aantal: 60, totaal_centen: veel.reduce((a, r) => a + r.centen, 0) }), veel);
  const tx = pdfTekst(lang.pdf);
  for (let i = 1; i <= 60; i++) assert.ok(tx.includes('N-' + i + '\n'), 'N-' + i);
  assert.match(tx, /pagina 1 van [2-9]/);
  assert.match(lang.pdf.toString('latin1'), /\/Count [2-9] /);
  assert.doesNotMatch(lang.mail.bericht, /N-1\b/);
  assert.match(lang.mail.bericht, /De facturen per afschrijving staan in de PDF\./);
  assert.equal(SP.eur(123456789), '€ 1.234.567,89');
  assert.equal(SP.datumNl('2026-10-30', true), 'vrijdag 30 oktober 2026');
});

test('wv2025 server.js: na een batch het concept op de achtergrond (luik gemockt); faalt het luik, dan blijft de batch staan', async () => {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const van = src.indexOf('// ── wv2025: specificatie per SEPA-batch'), tot = src.indexOf('// Na de bank-ronde: bankluis-rekeningen', van);
  assert.ok(van > 0 && tot > van, 'blok gevonden');
  // de koppeling in appFacturen: na een geslaagde sepa-batch met bestand, en de knop concept: true
  assert.match(src, /pad === '\/app\/facturen\/sepa-batch' && r\.status === 200 && r\.j && r\.j\.batch && r\.j\.bestand\) r\.j\.specificatie = facturenSpecNaBatch\(fdb, rol, r\.j\.batch\)/);
  assert.match(src, /pad === '\/app\/facturen\/sepa-specificatie' && d && d\.concept === true/);
  const t = opzet();
  const routes = F.maak({ fout: () => {} });
  const draai = (fetchNep, env) => {
    const fouten = [], aanroepen = [];
    const ctx = { require, path, __dirname: ROOT, process: { env: Object.assign({ N8N_WEBHOOK_MAILCONCEPT: 'proefgeheim' }, env || {}) }, Date, Buffer, JSON, String, Error, Object,
      AbortSignal, facturenRoutes: routes, rolPrimair: () => true, POT_AF_MAILWF: 'proefWf', logError: (w, e) => fouten.push(w + ': ' + (e && e.message)),
      appWebhookUrl: async () => 'https://n8n.voorbeeld.invalid/webhook/proef',
      fetch: async (url, o) => { aanroepen.push(JSON.parse(o.body)); return fetchNep(); } };
    vm.createContext(ctx);
    const r = vm.runInContext(src.slice(van, tot) + ';({ facturenSpecNaBatch, facturenSpecConcept, facturenHuisstijl })', ctx);
    return { r, fouten, aanroepen };
  };
  const antwoord = (status, j) => ({ status, ok: status >= 200 && status < 300, json: async () => j, arrayBuffer: async () => new ArrayBuffer(0) });
  const stand = (b) => t.call('GET', 'betalen', null, { nu: Date.now() }).j.sepa.batches.find((x) => x.id === b).specificatie;
  const wacht = async (b, niet) => { for (let i = 0; i < 50 && stand(b).status === niet; i++) await new Promise((z) => setTimeout(z, 10)); };
  // gelukt: concept met één PDF-bijlage aan de boekhouder; het antwoord van de batch wachtte niet
  const x = specBatch(t);
  const ok = draai(() => antwoord(200, { ok: true, concept_id: 'r-proef', thread_id: 't', bijlagen: 1 }));
  assert.deepEqual(JSON.parse(JSON.stringify(ok.r.facturenSpecNaBatch(t.fdb, t.eig, x.batch))), { status: 'bezig' });
  await wacht(x.batch, 'bezig');
  assert.equal(stand(x.batch).status, 'klaar');
  assert.equal(ok.aanroepen.length, 1);
  const body = ok.aanroepen[0];
  assert.deepEqual([body.secret, body.aan, body.bijlagen.length, body.bijlagen[0].mime], ['proefgeheim', 'afschrift-pot@acta.invalid', 1, 'application/pdf']);
  assert.match(body.bijlagen[0].naam, /^Specificatie SEPA-batch Tolgaarde .*\.pdf$/);
  assert.equal(Buffer.from(body.bijlagen[0].inhoud_base64, 'base64').slice(0, 5).toString(), '%PDF-');
  assert.match(body.onderwerp, /^Specificatie SEPA-batch Tolgaarde/);
  assert.deepEqual(ok.fouten, []);
  // huisstijl van de entiteit (omzet-huisstijl.js)
  assert.equal(ok.r.facturenHuisstijl('tolgaarde').briefnaam, 'Tolgaarde');
  assert.equal(ok.r.facturenHuisstijl('praktijkhouders_bv').naam, 'Praktijkhouders B.V.');
  assert.equal(ok.r.facturenHuisstijl('bestaat_niet'), null);
  // het luik weigert (400): mislukt, zeker geen concept; de batch en de facturen blijven staan
  const y = specBatch(t);
  const nee = draai(() => antwoord(400, { ok: false, fout: 'bijlage' }));
  nee.r.facturenSpecNaBatch(t.fdb, t.eig, y.batch);
  await wacht(y.batch, 'bezig');
  assert.deepEqual([stand(y.batch).status, stand(y.batch).reden], ['mislukt', 'het mailluik weigerde het concept']);
  assert.equal(t.n('SELECT count(*) AS n FROM sepa_batch WHERE id = ?', [y.batch]), 1);
  assert.equal(t.n("SELECT count(*) AS n FROM sepa_regel r JOIN factuur f ON f.id = r.factuur WHERE r.batch = ? AND f.betaalspoor = 'ingevoerd'", [y.batch]), 3);
  // knop "Concept opnieuw" na een mislukt concept: nu wel
  const weer = await ok.r.facturenSpecConcept(t.fdb, t.eig, y.batch, { aanleiding: 'knop' });
  assert.deepEqual([weer.status, weer.j.specificatie.status], [200, 'klaar']);
  // time-out: onbekend (misschien toch een concept), opnieuw alleen met nogmaals
  const z = specBatch(t);
  const traag = draai(() => { throw new Error('The operation was aborted due to timeout'); });
  const tr = await traag.r.facturenSpecConcept(t.fdb, t.eig, z.batch, { aanleiding: 'batch' });
  assert.equal(tr.j.specificatie.status, 'onbekend');
  assert.equal((await ok.r.facturenSpecConcept(t.fdb, t.eig, z.batch, { aanleiding: 'knop' })).j.code, 'misschien_al');
  assert.equal((await ok.r.facturenSpecConcept(t.fdb, t.eig, z.batch, { aanleiding: 'knop', nogmaals: true })).j.specificatie.status, 'klaar');
  // geen mailluik op de pod: mislukt; FACTUREN_SPECIFICATIE=uit: niets
  const w = specBatch(t);
  const zonder = draai(() => antwoord(200, {}), { N8N_WEBHOOK_MAILCONCEPT: '' });
  assert.equal((await zonder.r.facturenSpecConcept(t.fdb, t.eig, w.batch, { aanleiding: 'batch' })).j.specificatie.status, 'mislukt');
  assert.equal(zonder.aanroepen.length, 0);
  const uit = draai(() => antwoord(200, {}), { FACTUREN_SPECIFICATIE: 'uit' });
  assert.deepEqual(JSON.parse(JSON.stringify(uit.r.facturenSpecNaBatch(t.fdb, t.eig, w.batch))), { status: 'uit' });
  assert.equal(uit.aanroepen.length, 0);
});

test('wv2025 review: klopt de specificatie niet met de batch, dan "mislukt" (zichtbaar); Amsterdamse datum; PDF-titel alleen ASCII; WinAnsi-tekens', () => {
  const t = opzet();
  const x = specBatch(t);
  t.fdb.db.exec('DROP TRIGGER sepa_batch_vast');   // alleen in de wegwerpdatabase: een batch die niet meer klopt nabootsen
  t.fdb.db.prepare('UPDATE sepa_batch SET totaal_centen = totaal_centen + 1 WHERE id = ?').run(x.batch);
  const c = t.routes.specificatie.concept(t.fdb, t.eig, x.batch, { nu: NU + 1000, primair: true, aanleiding: 'batch' });
  assert.deepEqual([c.status, c.j.klaar, c.j.reden], [200, false, 'de specificatie klopt niet met de batch']);
  assert.equal(t.call('GET', 'betalen').j.sepa.batches[0].specificatie.status, 'mislukt');
  assert.equal(t.call('POST', 'sepa-specificatie', { batch: x.batch }).status, 409);
  // batch van 23:30 UTC op 31-10 = 1 november in Amsterdam (wintertijd)
  const b = { id: '0123456789abcdef', msg_id: 'SOCEV-20261101-abcdef12', wanneer: '2026-10-31T23:30:00.000Z', dag: '2026-11-01', entiteit: 'holding', entiteit_naam: 'Proef Ł Œuvre B.V.',
    entiteit_kort: 'Holding', rekening_eind: '4321', aantal: 1, totaal_centen: 100 };
  const s = SP.maak(b, [{ positie: 1, uitvoerdatum: '2026-11-02', leverancier: 'Šumava ‰ Œ', nummer: 'X-1', centen: 100 }], { gemaakt: '2026-10-31T23:30:00.000Z', gemaakt_dag: '2026-11-01' });
  assert.match(s.naam, / 2026-11-01 abcdef12\.pdf$/);
  const tx = pdfTekst(s.pdf);
  assert.match(tx, /1 november 2026/);
  assert.doesNotMatch(tx, /31 oktober/);
  assert.match(s.pdf.toString('latin1'), /\/Title \(Specificatie SEPA-batch Holding SOCEV-20261101-abcdef12\) \/Producer \(Socev\) \/CreationDate \(D:20261031233000Z\)/);
  assert.ok(s.pdf.toString('latin1').includes('<8A756D617661208920'), 'Š en ‰ in WinAnsi');
  assert.doesNotMatch(tx, /\?/);
});
