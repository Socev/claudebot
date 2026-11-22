'use strict';
// wv3914 (besluitenpagina nr 195 = 2C95, David Ja 22-11-2026 18:19): (a) "Bevestig en verstuur" per factuur — deze ene factuur gaat na de
// bedenktijd zelf naar het boekhoudadres, ook als de leverancier op concept staat; alleen David in zijn app, verse vingerafdruk, schakelaar
// versturen_per_factuur aan, zonder twijfel; Terugdraaien tot het verzendmoment; de koppeling knop ↔ factuur. (b) "al betaald" voorstellen met de
// kaart- of PayPal-regel als bewijs; twee gelijke bedragen zonder eenduidige regel = geen voorstel. Opzet gekopieerd uit facturen-direct.test.js.
// (kop van wv2480, David 5-11-2026, grondwet 1 aanvulling): per leverancier concept of direct naar de boekhouding. Toetst elke eis van de claimbeslissing
// (D.directBesluit / D.reserveerKies + de koerier): direct alleen als álles klopt, en per eis de terugval naar concept met de reden in het
// besluitspoor; het dagplafond (15, in dezelfde transactie als de reservering); keuze gewijzigd na Bevestigen (versie); de verzender weigert
// direct → dezelfde ronde concept; onzeker → nooit opnieuw direct; de route (alleen eigenaar, verse vingerafdruk, versie omhoog, audit).
// Raakt /opt/data/facturen, n8n, Gmail, de kluis en de vault niet: wegwerpdatabase met zaaddata, nep-verzender, nep-pdftotext.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'facturen-db.js'));
const F = require(path.join(ROOT, 'facturen.js'));
const KO = require(path.join(ROOT, 'facturen-koerier.js'));
const Z = require(path.join(ROOT, 'test', 'facturen-zaad.js'));

const NU = Date.parse('2026-10-22T12:30:00Z');
const VERSTUUR = Date.parse('2026-10-22T13:00:00Z');
const MIN = 60000;
const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
const LANG = 'Factuur PROEF-1 Leverancier synthetisch, totaal te betalen 121,00 euro, vervaldatum over dertig dagen, dank voor uw opdracht.';

// nep-Gmail: concept zoals voorheen; versturen = verzonden mail (SENT). g.direct: 'weiger403' | 'plafond409' | 'tijd' | 'tijd_niets' | '502'
function nepGmail() {
  const g = { mails: [], n: 0, calls: [], direct: null };
  g.luik = async function (b) {
    if (b.actie !== 'mail_zoeken') throw new Error('onbekende actie');
    const tok = String(b.query).match(/F[VA][0-9a-f]{16}/g) || [];
    const alleenSent = /^in:sent /.test(b.query);
    const lijst = g.mails.filter((m) => tok.some((t) => m.onderwerp.indexOf('[ref ' + t + ']') >= 0) && (alleenSent ? m.labels.includes('SENT') : true));
    return { query: b.query, aantal: lijst.length, mails: lijst.map((m) => Object.assign({}, m)) };
  };
  g.verzender = async function (v) {
    g.calls.push({ token: v.token, modus: v.modus, aan: v.aan, tekst: v.tekst });
    const maak = (labels) => { const id = 'm' + String(++g.n).padStart(15, '0'); g.mails.push({ id, aan: v.aan, onderwerp: v.onderwerp, snippet: v.tekst.replace(/\s+/g, ' ').slice(0, 200), labels }); return id; };
    if (v.modus === 'versturen') {
      if (g.direct === 'weiger403') return { status: 403, j: { ok: false, code: 'witte_lijst' } };
      if (g.direct === 'plafond409') return { status: 409, j: { ok: false, code: 'direct_plafond' } };
      if (g.direct === 'tijd') { maak(['SENT']); throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }
      if (g.direct === 'tijd_niets') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      if (g.direct === '502') { maak(['DRAFT']); return { status: 502, j: { ok: false, code: 'gmail_verzend' } }; }
      const id = maak(['SENT']);
      return { status: 200, j: { ok: true, modus: 'versturen', message_id: id } };
    }
    const id = maak(['DRAFT']);
    return { status: 200, j: { ok: true, extern_id: 'r-' + id, message_id: id, modus: 'concept' } };
  };
  return g;
}

function opzet() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-knop-'));
  WEG.push(dir);
  const fdb = D.open(path.join(dir, 'db'));
  Z.zaai(fdb, { vandaag: '2026-10-22' });
  // alleen onze eigen opdracht telt: de wachtende opdrachten uit het zaad gaan uit de weg
  fdb.db.prepare("UPDATE opdracht SET status = 'teruggedraaid' WHERE status = 'wacht'").run();
  for (const r of fdb.db.prepare("SELECT id FROM opdracht WHERE status IN ('opgehaald','mislukt')").all()) {
    try { fdb.db.prepare("UPDATE opdracht SET status = 'geweigerd', fout = 'proef: uit de weg' WHERE id = ?").run(r.id); } catch (e) { /* al dood (drie keer mislukt) */ }
  }
  const routes = F.maak({ fout: () => {} });
  const eig = F.rolVoor(fdb, { ingang: 'app', wie: 'david (proef)' });
  const t = { dir, fdb, routes, eig, klok: NU, pdfTekst: LANG, pdfLaag: true, klaar: true };
  t.call = (methode, rest, d, x) => routes.app(fdb, { methode, pad: '/app/facturen' + (rest ? '/' + rest : ''), d: d || {}, rol: (x && x.rol) || eig, primair: true, nu: (x && x.nu) || NU,
    versOk: () => !(x && x.vers === false), versVerbruik: () => {} });
  t.io = (g) => ({ luik: g.luik, luikBytes: async () => ({ json: {} }), verzender: g.verzender, directKlaar: async () => t.klaar,
    pdftotext: async () => ({ ok: true, tekst: t.pdfTekst, tekstlaag: t.pdfLaag }) });
  t.ronde = (g, nu) => { t.klok = nu; return KO.ronde(fdb, t.io(g), { nu, klok: () => t.klok }); };
  t.op = (id) => fdb.db.prepare('SELECT * FROM opdracht WHERE id = ?').get(id);
  t.fac = (id) => fdb.db.prepare('SELECT * FROM factuur WHERE id = ?').get(id);
  t.besluit = (fid) => fdb.db.prepare("SELECT waarde, toelichting FROM besluit WHERE factuur = ? AND stap = 'verzendwijze' ORDER BY id DESC LIMIT 1").get(fid);
  // een "zekere" factuur: leverancier, geen nieuw IBAN, PDF met tekstlaag, patiëntregel 'geen kenmerk' vastgelegd, geen twijfelcontrole
  t.kies = () => {
    const f = fdb.db.prepare("SELECT f.* FROM factuur f JOIN document d ON d.id = f.document WHERE f.status = 'te_beoordelen' AND f.leverancier IS NOT NULL AND f.entiteit IN ('tolgaarde','groenhouten','holding','kostenmaatschap') " +
      "AND f.betaalwijze <> 'onbekend' AND f.iban_nieuw = 0 AND f.patientkenmerk = 0 AND f.valuta = 'EUR' AND f.incl > 0 AND f.dubbel_van IS NULL AND f.nagebeld_op IS NULL AND d.soort = 'pdf' " +
      "ORDER BY f.aangemaakt_op, f.id LIMIT 1").get();
    assert.ok(f, 'zaad heeft een geschikte factuur');
    fdb.db.prepare("UPDATE factuur SET controles = '[]', redenen = '[]' WHERE id = ?").run(f.id);
    fdb.db.prepare('UPDATE document SET tekstlaag = 1, patientkenmerk = 0 WHERE id = ?').run(f.document);
    fdb.db.prepare("INSERT INTO besluit (factuur, stap, veld, waarde, bron, toelichting, wanneer) VALUES (?, 'patientkenmerk', 'patientkenmerk', '0', 'regel', 'geen kenmerk', ?)").run(f.id, new Date(NU).toISOString());
    fdb.db.prepare("UPDATE signaal SET status = 'afgehandeld', afhandeling = 'proef', wie = 'proef', wanneer = ? WHERE EXISTS (SELECT 1 FROM json_each(signaal.facturen) j WHERE j.value = ?)").run(new Date(NU).toISOString(), f.id);
    return f;
  };
  t.direct = (levId, wijze) => t.call('POST', 'leverancier/verzendwijze', { id: levId, verzendwijze: wijze || 'direct' });
  t.vrij = () => D.metaZet(fdb, 'versturen_vrijgegeven', '1');
  // alles klaar voor direct, en bevestigd → { f, op, tok }
  t.klaarEnBevestigd = (o) => {
    o = o || {};
    const f = t.kies();
    if (o.voor) o.voor(f);
    if (!o.zonderDirect) assert.equal(t.direct(f.leverancier).status, 200);
    if (!o.nietVrij) t.vrij();
    const r = t.call('POST', 'bevestig', { id: f.id });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    // Bevestigen rekent de controles opnieuw uit (zaad: bedrag boven de mediaan); de "zekere" factuur heeft er geen
    if (!o.metControles) fdb.db.prepare("UPDATE factuur SET controles = '[]' WHERE id = ?").run(f.id);
    return { f, op: t.op(r.j.opdracht.id), tok: 'FV' + f.id };
  };
  return t;
}
const mijn = (g, tok) => g.calls.filter((c) => c.token === tok);
const KNOP = (t) => D.metaZet(t.fdb, 'versturen_per_factuur', '1');
// leverancier van de gekozen factuur staat op concept (standaard); David drukt Bevestig en verstuur
function knopKlaar(t, o) {
  o = o || {};
  const f = t.kies();
  // een gewoon bedrag (het zaad zet de factuur boven de mediaan: drempeltwijfel = terecht geen direct)
  t.fdb.db.prepare('UPDATE factuur SET incl = 12100, excl = 10000, btw = 2100, incl_eur = 12100 WHERE id = ?').run(f.id);
  if (o.voor) o.voor(f);
  t.vrij(); if (!o.knopUit) KNOP(t);
  assert.equal(t.fdb.db.prepare('SELECT verzendwijze FROM leverancier WHERE id = ?').get(f.leverancier).verzendwijze, 'concept');
  return f;
}

test('a: Bevestig en verstuur bij een leverancier op concept → opdracht direct_knop, app zegt direct om HH:00, één verzending versturen naar het boekhoudadres', async () => {
  const t = opzet(), g = nepGmail();
  const f = knopKlaar(t);
  const vooraf = t.call('GET', 'factuur/' + f.id).j;
  assert.deepEqual(vooraf.knop_verstuur, { aan: true });
  const r = t.call('POST', 'bevestig', { id: f.id, versie: f.versie, verstuur: true });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.opdracht.verzendwijze, 'direct');
  assert.equal(r.j.opdracht.direct_knop, true);
  const op = t.op(r.j.opdracht.id);
  assert.equal(op.direct_knop, 1);
  assert.equal(op.factuur, f.id, 'de opdracht hoort bij de factuur van de knop');
  assert.equal(op.verzendwijze_bij_bevestigen, 'concept');
  // bedenktijd (wv3911): 12:30 bevestigd → eerste hele uur ≥ 13:00 = 13:00
  assert.ok(Date.parse(op.verstuur_na) - NU >= 30 * MIN, op.verstuur_na);
  const vb = t.call('GET', 'factuur/' + f.id).j;
  assert.equal(vb.verzending.wijze, 'direct', JSON.stringify(vb.verzending));
  // vóór het verzendmoment gaat er niets
  await t.ronde(g, NU + 10 * MIN);
  assert.equal(mijn(g, 'FV' + f.id).length, 0);
  const u = await t.ronde(g, Date.parse(op.verstuur_na) + 5 * MIN);
  assert.equal(u.ok, true, JSON.stringify(u.fouten));
  assert.deepEqual(mijn(g, 'FV' + f.id).map((c) => c.modus), ['versturen']);
  const ent = t.fdb.db.prepare('SELECT boekhoud_doel FROM entiteit WHERE sleutel = ?').get(t.fac(f.id).entiteit);
  assert.equal(mijn(g, 'FV' + f.id)[0].aan, ent.boekhoud_doel, 'alleen naar het vaste boekhoudadres');
  assert.equal(t.fac(f.id).status, 'verstuurd');
  assert.equal(t.besluit(f.id).waarde, 'direct');
  const bev = t.fdb.db.prepare("SELECT toelichting FROM besluit WHERE factuur = ? AND stap = 'bevestigen' ORDER BY id DESC LIMIT 1").get(f.id);
  assert.match(bev.toelichting, /Bevestig en verstuur/);
  const au = t.fdb.db.prepare("SELECT na FROM audit WHERE wat = 'bevestigen' AND object_id = ? ORDER BY rowid DESC LIMIT 1").get(f.id);
  assert.match(au.na, /"direct_knop":true/);
  // de trigger: direct_knop ligt vast
  assert.throws(() => t.fdb.db.prepare('UPDATE opdracht SET direct_knop = NULL WHERE id = ?').run(op.id), /ligt vast/);
});

test('a: koppeling knop ↔ factuur — twee facturen, de knop op de tweede: alleen die gaat direct, de eerste (gewoon Bevestigen) wordt een concept', async () => {
  const t = opzet(), g = nepGmail();
  const f1 = knopKlaar(t);
  const r1 = t.call('POST', 'bevestig', { id: f1.id });
  assert.equal(r1.status, 200, JSON.stringify(r1.j));
  t.fdb.db.prepare("UPDATE factuur SET controles = '[]' WHERE id = ?").run(f1.id);
  const f2 = t.kies();
  t.fdb.db.prepare('UPDATE factuur SET incl = 12100, excl = 10000, btw = 2100, incl_eur = 12100 WHERE id = ?').run(f2.id);
  assert.notEqual(f2.id, f1.id);
  const r2 = t.call('POST', 'bevestig', { id: f2.id, versie: f2.versie, verstuur: true });
  assert.equal(r2.status, 200, JSON.stringify(r2.j));
  assert.equal(t.op(r1.j.opdracht.id).direct_knop, null);
  assert.equal(t.op(r2.j.opdracht.id).direct_knop, 1);
  assert.equal(t.op(r2.j.opdracht.id).factuur, f2.id);
  await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.deepEqual(mijn(g, 'FV' + f1.id).map((c) => c.modus), ['concept']);
  assert.deepEqual(mijn(g, 'FV' + f2.id).map((c) => c.modus), ['versturen']);
  // het verstuurde stuk is dat van f2 (bijlagen = documenten van f2)
  const b2 = JSON.parse(t.op(r2.j.opdracht.id).bijlagen).map((b) => b.document || b.id || b.sha256);
  const d2 = t.fdb.db.prepare('SELECT document, sha256 FROM factuur f JOIN document d ON d.id = f.document WHERE f.id = ?').get(f2.id);
  assert.ok(b2.includes(d2.document) || b2.includes(d2.sha256), JSON.stringify(b2));
});

test('a: Terugdraaien binnen de bedenktijd → geen verzending; daarna nooit meer direct (eerder teruggedraaid)', async () => {
  const t = opzet(), g = nepGmail();
  const f = knopKlaar(t);
  const r = t.call('POST', 'bevestig', { id: f.id, verstuur: true });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const tr = t.call('POST', 'terugdraaien', { id: f.id }, { nu: NU + 20 * MIN });
  assert.equal(tr.status, 200, JSON.stringify(tr.j));
  assert.equal(t.fac(f.id).status, 'te_beoordelen');
  await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(mijn(g, 'FV' + f.id).length, 0, 'teruggedraaid = niets verstuurd');
  const f2 = t.fac(f.id);
  t.fdb.db.prepare("UPDATE factuur SET controles = '[]' WHERE id = ?").run(f.id);
  const r2 = t.call('POST', 'bevestig', { id: f.id, versie: t.fac(f.id).versie, verstuur: true }, { nu: NU + 25 * MIN });
  assert.equal(r2.status, 409, JSON.stringify(r2.j));
  assert.match(r2.j.fout || r2.j.error || JSON.stringify(r2.j), /eerder teruggedraaid/);
  assert.equal(t.fac(f.id).status, 'te_beoordelen', '409 = niets bevestigd');
  assert.ok(f2);
});

test('a: poort — schakelaar uit, geen verse vingerafdruk, niet David, Privé, twijfel (nieuw IBAN) → geweigerd en niets bevestigd', () => {
  const t = opzet();
  const f = knopKlaar(t, { knopUit: true });
  assert.deepEqual(t.call('GET', 'factuur/' + f.id).j.knop_verstuur, { aan: false });
  let r = t.call('POST', 'bevestig', { id: f.id, verstuur: true });
  assert.equal(r.status, 409); assert.equal(r.j.code, 'knop_uit');
  KNOP(t);
  r = t.call('POST', 'bevestig', { id: f.id, verstuur: true }, { vers: false });
  assert.equal(r.status, 403); assert.equal(r.j.vers_nodig, true);
  r = t.call('POST', 'bevestig', { id: f.id, verstuur: 'ja' });
  assert.equal(r.status, 400);
  const pm = t.fdb.db.prepare("SELECT id FROM gebruiker WHERE rol <> 'eigenaar' AND actief = 1 LIMIT 1").get();
  if (pm) {
    const rol = F.rolVoor(t.fdb, { ingang: 'fac', wie: 'pm (proef)' });
    if (rol) { r = t.call('POST', 'bevestig', { id: f.id, verstuur: true }, { rol }); assert.ok([403, 404].includes(r.status), String(r.status)); }
  }
  r = t.call('POST', 'bevestig', { id: f.id, verstuur: true, entiteit: 'prive' });
  assert.equal(r.status, 400);
  t.fdb.db.prepare('UPDATE factuur SET iban = ? WHERE id = ?').run('NL91ABNA0417164300', f.id);
  r = t.call('POST', 'bevestig', { id: f.id, verstuur: true });
  assert.equal(r.status, 409, JSON.stringify(r.j));
  assert.equal(t.fac(f.id).status, 'te_beoordelen');
  assert.equal(t.fdb.db.prepare('SELECT count(*) AS n FROM opdracht WHERE factuur = ?').get(f.id).n, 0, 'geen opdracht achtergebleven');
  // vrijgave uit = ook uit
  D.metaZet(t.fdb, 'versturen_vrijgegeven', '0');
  assert.deepEqual(t.call('GET', 'factuur/' + f.id).j.knop_verstuur, { aan: false });
});

test('a: schakelaar na Bevestigen uit → op het verzendmoment toch een concept, met de reden', async () => {
  const t = opzet(), g = nepGmail();
  const f = knopKlaar(t);
  const r = t.call('POST', 'bevestig', { id: f.id, verstuur: true });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  D.metaZet(t.fdb, 'versturen_per_factuur', '0');
  assert.match(t.call('GET', 'factuur/' + f.id).j.verzending.reden, /staat \(nu\) uit/);
  await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.deepEqual(mijn(g, 'FV' + f.id).map((c) => c.modus), ['concept']);
  assert.match(t.besluit(f.id).toelichting, /staat \(nu\) uit/);
});

test('a: gewoon Bevestigen blijft precies zoals het was (leverancier op concept → concept, op direct → direct)', async () => {
  const t = opzet(), g = nepGmail();
  KNOP(t);
  const x = t.klaarEnBevestigd({ zonderDirect: true });
  assert.equal(x.op.direct_knop, null);
  const y = t.klaarEnBevestigd();
  assert.equal(y.op.direct_knop, null);
  await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.deepEqual(mijn(g, x.tok).map((c) => c.modus), ['concept']);
  assert.deepEqual(mijn(g, y.tok).map((c) => c.modus), ['versturen']);
});

// ── (b) al betaald met de kaart- of PayPal-regel als bewijs ──
const crypto = require('crypto');
// zelfde zaadwijze als facturen-nogbetalen-app.test.js (wv3911 kaartKoppel)
function kaartRegel(t, f, o) {
  o = o || {};
  const rek = t.fdb.db.prepare("SELECT id FROM rekening WHERE entiteit = 'tolgaarde' ORDER BY id LIMIT 1").get();
  const w = '2026-10-20T00:00:00.000Z';
  let kaart = t.fdb.db.prepare('SELECT id FROM kaart LIMIT 1').get();
  if (!kaart) {
    kaart = { id: D.nieuwId() };
    t.fdb.db.prepare("INSERT INTO kaart (id, uitgever, klantnummer, laatste4, entiteit, rekening, aangemaakt_door, aangemaakt_op) VALUES (?, 'ICS', '12345678', '0000', 'tolgaarde', ?, 'proef', ?)").run(kaart.id, rek.id, w);
    t.fdb.db.prepare("INSERT INTO kaart_bestand (id, kaart, sha256, formaat, aantal, nieuw, geupload_door, geupload_op) VALUES (?, ?, ?, 'ics_csv', 1, 1, 'proef', ?)").run(D.nieuwId(), kaart.id, crypto.randomBytes(32).toString('hex'), w);
  }
  const best = t.fdb.db.prepare('SELECT id FROM kaart_bestand WHERE kaart = ? LIMIT 1').get(kaart.id);
  t.fdb.db.prepare("INSERT INTO kaart_regel (id, kaart, bestand, sleutel, soort, transactiedatum, omschrijving, bedrag_centen, overzicht, handelaar, leverancier, factuur, koppeling_op, aangemaakt_op) " +
    "VALUES (?, ?, ?, ?, 'transactie', ?, 'PROEFWINKEL ONLINE', ?, '2026-10', ?, ?, ?, ?, ?)")
    .run(D.nieuwId(), kaart.id, best.id, crypto.randomBytes(32).toString('hex'), o.datum || f.factuurdatum, o.bedrag || f.incl, o.handelaar || 'Proefwinkel', o.leverancier || null, o.factuur || null, o.factuur ? w : null, w);
}
function teBeoordelen(t) {
  const f = t.kies();
  const lev = t.fdb.db.prepare('SELECT naam FROM leverancier WHERE id = ?').get(f.leverancier);
  t.fdb.db.prepare("UPDATE factuur SET betaalwijze = 'zelf', factuurdatum = '2026-10-15' WHERE id = ?").run(f.id);
  return Object.assign(t.fac(f.id), { levNaam: lev.naam });
}

test('b: een losse kaartregel met hetzelfde bedrag en de leverancier → voorstel "al betaald" met de regel; Bevestigen op Al betaald legt het bewijs vast', () => {
  const t = opzet();
  const f = teBeoordelen(t);
  kaartRegel(t, f, { datum: '2026-10-16', leverancier: f.leverancier, handelaar: 'Proefwinkel' });
  const d = t.call('GET', 'factuur/' + f.id).j;
  assert.ok(d.al_betaald, JSON.stringify(d.al_betaald));
  assert.equal(d.al_betaald.bron, 'kaart');
  assert.equal(d.al_betaald.gekoppeld, false);
  assert.match(d.al_betaald.regel, /^creditcard, 16-10-2026, Proefwinkel, € /);
  t.vrij();
  const r = t.call('POST', 'bevestig', { id: f.id, betaalwijze: 'betaald' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.betaalspoor, 'betaald_vooraf');
  const b = t.fdb.db.prepare("SELECT toelichting FROM besluit WHERE factuur = ? AND stap = 'betaalwijze' ORDER BY id DESC LIMIT 1").get(f.id);
  assert.match(b.toelichting, /al betaald, bewijs: creditcard, 16-10-2026, Proefwinkel/);
  assert.match(b.toelichting, /nog niet gekoppeld/);
});

test('b: gekoppelde kaartregel → voorstel met gekoppeld true', () => {
  const t = opzet();
  const f = teBeoordelen(t);
  kaartRegel(t, f, { datum: '2026-10-16', factuur: f.id, leverancier: f.leverancier, handelaar: 'Proefwinkel' });
  const d = t.call('GET', 'factuur/' + f.id).j;
  assert.equal(d.al_betaald.gekoppeld, true, JSON.stringify(d.al_betaald));
  assert.match(d.al_betaald.regel, /creditcard, 16-10-2026, Proefwinkel/);
});

test('b: twee gelijke bedragen — twee regels voor één factuur, of één regel en twee facturen → geen voorstel; buiten het datumvenster ook niet', () => {
  const t = opzet();
  const f = teBeoordelen(t);
  kaartRegel(t, f, { datum: '2026-10-16', leverancier: f.leverancier });
  kaartRegel(t, f, { datum: '2026-10-17', leverancier: f.leverancier });
  assert.equal(t.call('GET', 'factuur/' + f.id).j.al_betaald, null, 'twee regels = geen voorstel');

  const t2 = opzet();
  const g1 = teBeoordelen(t2);
  // een tweede factuur van dezelfde leverancier met hetzelfde bedrag en datum
  const g2 = t2.fdb.db.prepare("SELECT id FROM factuur WHERE id <> ? AND soort = 'factuur' LIMIT 1").get(g1.id);
  t2.fdb.db.prepare('UPDATE factuur SET leverancier = ?, incl = ?, factuurdatum = ?, valuta = ? WHERE id = ?').run(g1.leverancier, g1.incl, '2026-10-15', 'EUR', g2.id);
  kaartRegel(t2, g1, { datum: '2026-10-16', leverancier: g1.leverancier });
  assert.equal(t2.call('GET', 'factuur/' + g1.id).j.al_betaald, null, 'twee facturen met hetzelfde bedrag = geen voorstel');

  const t3 = opzet();
  const h = teBeoordelen(t3);
  kaartRegel(t3, h, { datum: '2026-11-10', leverancier: h.leverancier });
  assert.equal(t3.call('GET', 'factuur/' + h.id).j.al_betaald, null, 'buiten -5..+10 dagen');
  kaartRegel(t3, h, { datum: '2026-10-16', leverancier: h.leverancier, bedrag: h.incl + 1 });
  assert.equal(t3.call('GET', 'factuur/' + h.id).j.al_betaald, null, 'ander bedrag');
});

test('b: losse PayPal-betaling met hetzelfde bedrag en de naam van de leverancier → voorstel PayPal', () => {
  const t = opzet();
  const f = teBeoordelen(t);
  const kol = t.fdb.db.prepare('SELECT name, "notnull" AS nn FROM pragma_table_info(?)').all('paypal_regel');
  const rij = { id: 'PPPROEF3914', account: 'ACCOUNT01', transactie_id: 'PROEF1', event_code: 'T0006', status: 'S', datum: '2026-10-16', bedrag_centen: -f.incl, valuta: 'EUR',
    tegenpartij: f.levNaam, leverancier: f.leverancier, aangemaakt_op: '2026-10-20T00:00:00Z', tijdstip: '2026-10-16T10:00:00Z' };
  const ks = kol.filter((c) => rij[c.name] !== undefined).map((c) => c.name);
  const mist = kol.filter((c) => c.nn && rij[c.name] === undefined).map((c) => c.name);
  assert.deepEqual(mist.filter((c) => c !== 'id'), [], 'toets kent alle verplichte kolommen van paypal_regel');
  t.fdb.db.prepare('INSERT INTO paypal_regel (' + ks.join(', ') + ') VALUES (' + ks.map(() => '?').join(', ') + ')').run(...ks.map((c) => rij[c]));
  const d = t.call('GET', 'factuur/' + f.id).j;
  assert.ok(d.al_betaald, 'voorstel');
  assert.equal(d.al_betaald.bron, 'paypal');
  assert.match(d.al_betaald.regel, /^PayPal, 16-10-2026, /);
});

test('b: na Bevestigen (niet meer te beoordelen) geen voorstel meer in het detail', () => {
  const t = opzet();
  const f = teBeoordelen(t);
  kaartRegel(t, f, { datum: '2026-10-16', leverancier: f.leverancier });
  t.vrij();
  assert.equal(t.call('POST', 'bevestig', { id: f.id, betaalwijze: 'betaald' }).status, 200);
  assert.equal(t.call('GET', 'factuur/' + f.id).j.al_betaald, undefined);
});
