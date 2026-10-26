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
  assert.equal(t.call('POST', 'voorstel', { id: v.id, keuze: 'bevestig' }).status, 409);
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
});
