'use strict';
// Toetsen voor wv3913 (besluit C57, Fable-review facturen-bank M5; David Ja 22-11-2026): een deelbetaling zet een factuur niet meer op volledig
// betaald. Proef P5: 40 % met het factuurnummer erin → voorstel → Ja → "deels betaald" (koppeling volledig 0, spoor te betalen) en na de
// vervaldatum een restsignaal (te betalen, niet betaald, met details.deels en de rest als bedrag; geen "Naar betaallijst", wel "Klopt zo").
// De tweede termijn dekt → betaald gezien en het restsignaal gaat vanzelf dicht. Ook: koppel-route, "Is al betaald (koppelen)", Klopt zo,
// Ontkoppel van de deelbetaling, een oude koppeling met volledig = 1 blijft gelden, bijschrijving blijft geweigerd. Alles synthetisch (zaad).
// Draaien: bash test/facturen-deels.sh
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-deels-'));
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
  const st = D.stukSchrijf(t.fdb, Buffer.from('%PDF-1.4\ndeels-proef ' + t.volg + ' ' + crypto.randomBytes(4).toString('hex') + '\n%%EOF'));
  const did = D.nieuwId(), id = D.nieuwId(), w = new Date(NU - 30 * 86400000).toISOString();
  D.voegToe(t.fdb, 'document', { id: did, sha256: st.sha256, naam: 'Voorbeeld factuur ' + t.volg + '.pdf', mime: 'application/pdf', bytes: st.bytes, soort: 'pdf', tekstlaag: 1, aangemaakt_op: w });
  const incl = o.incl || 73113 + t.volg * 7;
  D.voegToe(t.fdb, 'factuur', { id, document: did, soort: o.soort || 'factuur', leverancier: lev.id, leverancier_naam: lev.naam, nummer: 'DEELS-' + String(t.volg).padStart(4, '0'),
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


const sigs = (t, f) => t.fdb.db.prepare("SELECT * FROM signaal WHERE soort = 'te_betalen_niet_betaald' AND facturen LIKE ? ORDER BY aangemaakt_op, id").all('%' + f.id + '%');
const det = (s) => JSON.parse(s.details || '{}');
// Bankregel met het factuurnummer in de omschrijving en een eigen bedrag; daarna de bankcontrole → het open voorstel voor die post
function voorstelVoor(t, f, bedrag, boekdatum) {
  const nr = t.fac(f.id).nummer;
  const tx = bankregel(t, f, { bedrag, boekdatum, omschrijving: 'termijn factuur ' + nr });
  t.controle();
  const v = t.fdb.db.prepare("SELECT * FROM voorstel WHERE transactie = ? AND status = 'open'").get(tx);
  return { tx, v };
}

test('P5: 40 % met het nummer → voorstel → Ja → deels betaald, restsignaal; tweede termijn dekt → betaald gezien, signaal dicht', () => {
  const t = opzet();
  const f = factuur(t, { incl: 100000 });
  const { tx, v } = voorstelVoor(t, f, 40000, '2026-11-10');
  assert.ok(v, 'een voorstel voor de deelbetaling');
  assert.equal(JSON.parse(v.details || '{}').reden, 'kenmerk klopt, bedrag niet');
  const r = t.call('POST', 'voorstel', { id: v.id, keuze: 'bevestig' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(t.kop(tx, f.id).volledig, 0, 'koppeling niet volledig');
  assert.equal(t.fac(f.id).betaalspoor, 'te_betalen', 'factuur niet op betaald gezien');
  const k = r.j.koppelingen[0];
  assert.equal(k.volledig, false);
  assert.deepEqual(k.deels, { betaald_centen: 40000, rest_centen: 60000 });
  // de factuur toont "deels betaald"
  const d = t.call('GET', 'factuur/' + f.id);
  assert.equal(d.status, 200, JSON.stringify(d.j));
  assert.deepEqual(d.j.deels, { betaald_centen: 40000, rest_centen: 60000 });
  // de praktijkmanager ziet geen deels (de som telt ook bankposten mee die alleen de eigenaar ziet)
  const pm = t.call('GET', 'factuur/' + f.id, null, { rol: t.pm() });
  assert.equal(pm.status, 200, JSON.stringify(pm.j));
  assert.equal(pm.j.deels, undefined);
  // de bankcontrole: restsignaal (vervaldatum 3-11 is voorbij), bedrag = de rest, knoppen zonder betaallijst
  t.controle();
  let s = sigs(t, f).filter((x) => x.status === 'open');
  assert.equal(s.length, 1, 'één restsignaal: ' + JSON.stringify(sigs(t, f).map((x) => [x.sleutel, x.status])));
  assert.equal(s[0].bedrag_centen, 60000);
  assert.deepEqual(det(s[0]).deels, { betaald_centen: 40000, rest_centen: 60000, factuur_centen: 100000 });
  const b = t.call('GET', 'bank');
  const bs = (b.j.signalen || []).find((x) => x.id === s[0].id);
  assert.ok(bs, 'restsignaal in Bankcontrole');
  const knoppen = bs.knoppen.map((x) => x.knop);
  assert.ok(knoppen.includes('rest_vervalt'), JSON.stringify(knoppen));
  assert.ok(!knoppen.includes('naar_betaallijst'), JSON.stringify(knoppen));
  assert.match(bs.uitleg || '', /Deels betaald/);
  // nogmaals de controle: geen tweede signaal
  t.controle();
  assert.equal(sigs(t, f).filter((x) => x.status === 'open').length, 1, 'nooit twee keer dezelfde melding');
  // de batch weigert hem (er hangt al een bankbetaling): geen dubbele betaling van de 40 %
  const bt = t.call('GET', 'betalen').j.te_betalen.find((x) => x.id === f.id);
  assert.ok(bt, 'staat nog bij te betalen');
  assert.match(String(bt.batch_reden), /al een bankbetaling/);
  // tweede termijn: 60 % met het nummer → voorstel → Ja → dekt
  const t2 = voorstelVoor(t, f, 60000, '2026-11-18');
  assert.ok(t2.v, 'voorstel voor de tweede termijn');
  const r2 = t.call('POST', 'voorstel', { id: t2.v.id, keuze: 'bevestig' });
  assert.equal(r2.status, 200, JSON.stringify(r2.j));
  assert.equal(r2.j.koppelingen[0].volledig, true);
  assert.equal(t.fac(f.id).betaalspoor, 'betaald_gezien');
  assert.equal(t.call('GET', 'factuur/' + f.id).j.deels, null);
  t.controle();
  s = sigs(t, f);
  assert.equal(s.filter((x) => x.status === 'open').length, 0, 'restsignaal dicht: ' + JSON.stringify(s.map((x) => [x.sleutel, x.status, x.afhandeling])));
  assert.ok(s.some((x) => x.afhandeling === 'vanzelf_gezien' && det(x).deels));
});

test('koppel-route: exact bedrag → volledig en betaald gezien; te weinig → deels; volledig: false blijft open', () => {
  const t = opzet();
  const a = factuur(t, { incl: 50000 });
  const ta = bankregel(t, a);
  const ra = t.call('POST', 'koppel', { transactie: ta, factuur: a.id });
  assert.equal(ra.status, 200, JSON.stringify(ra.j));
  assert.equal(ra.j.volledig, true);
  assert.equal(t.kop(ta, a.id).volledig, 0, 'gedekt uit de som: geen zelfstandige vlag (diffreview MOET 1)');
  assert.equal(t.fac(a.id).betaalspoor, 'betaald_gezien');
  const b = factuur(t, { incl: 50000, lev: 1 });
  const tb = bankregel(t, b, { bedrag: 20000 });
  const rb = t.call('POST', 'koppel', { transactie: tb, factuur: b.id });
  assert.equal(rb.status, 200);
  assert.equal(rb.j.volledig, false);
  assert.deepEqual(rb.j.deels, { betaald_centen: 20000, rest_centen: 30000 });
  assert.equal(t.fac(b.id).betaalspoor, 'te_betalen');
  // overbetaald dekt ook
  const c = factuur(t, { incl: 50000, lev: 2 });
  const tc = bankregel(t, c, { bedrag: 50100 });
  t.call('POST', 'koppel', { transactie: tc, factuur: c.id });
  assert.equal(t.fac(c.id).betaalspoor, 'betaald_gezien');
  const audit = t.fdb.db.prepare("SELECT na FROM audit WHERE wat = 'koppelen' AND object_id = ?").get(tb + ':' + b.id);
  assert.equal(JSON.parse(audit.na).deels, true);
});

test('"Klopt zo (rest vervalt)": met toelichting → koppelingen volledig, betaald gezien, geen nieuw signaal', () => {
  const t = opzet();
  const f = factuur(t, { incl: 80000 });
  const tx = bankregel(t, f, { bedrag: 72000 });
  t.call('POST', 'koppel', { transactie: tx, factuur: f.id });
  t.controle();
  const s = sigs(t, f).find((x) => x.status === 'open');
  assert.ok(s && det(s).deels, 'restsignaal');
  let r = t.call('POST', 'signaal', { id: s.id, knop: 'rest_vervalt' });
  assert.equal(r.status, 400, 'zonder toelichting niet');
  r = t.call('POST', 'signaal', { id: s.id, knop: 'naar_betaallijst' });
  assert.equal(r.status, 400, 'naar de betaallijst kan niet bij een deelbetaling: ' + JSON.stringify(r.j));
  r = t.call('POST', 'signaal', { id: s.id, knop: 'rest_vervalt', toelichting: 'leverancier gaf tien procent korting' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(t.kop(tx, f.id).volledig, 0, 'geen vlag op de koppeling (diffreview ronde 4)');
  const bs = t.fdb.db.prepare("SELECT * FROM besluit WHERE factuur = ? AND veld = 'rest_vervalt'").all(f.id);
  assert.equal(bs.length, 1);
  assert.equal(bs[0].waarde, '8000');
  assert.equal(bs[0].toelichting, 'leverancier gaf tien procent korting');
  assert.equal(t.fac(f.id).betaalspoor, 'betaald_gezien');
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'rest_vervalt' AND object_id = ?", f.id), 1);
  t.controle();
  assert.equal(sigs(t, f).filter((x) => x.status === 'open').length, 0);
  assert.equal(t.call('GET', 'factuur/' + f.id).j.deels, null);
});

test('"Is al betaald (koppelen)" met een te kleine post: deels, spoor blijft te betalen', () => {
  const t = opzet();
  const f = factuur(t, { incl: 90000 });
  t.controle();
  const s = sigs(t, f).find((x) => x.status === 'open');
  assert.ok(s, 'eerst het gewone signaal te betalen, niet betaald');
  assert.ok(!det(s).deels);
  const tx = bankregel(t, f, { bedrag: 30000 });
  const r = t.call('POST', 'signaal', { id: s.id, knop: 'is_al_betaald', transactie: tx });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(t.kop(tx, f.id).volledig, 0);
  assert.equal(t.fac(f.id).betaalspoor, 'te_betalen');
  t.controle();
  const open = sigs(t, f).filter((x) => x.status === 'open');
  assert.equal(open.length, 1);
  assert.equal(det(open[0]).deels.rest_centen, 60000);
});

test('ontkoppel de deelbetaling: geen deels meer, gewoon signaal terug; oude koppeling met volledig = 1 blijft gelden', () => {
  const t = opzet();
  const f = factuur(t, { incl: 100000 });
  const tx = bankregel(t, f, { bedrag: 40000 });
  t.call('POST', 'koppel', { transactie: tx, factuur: f.id });
  t.controle();
  assert.ok(sigs(t, f).some((x) => x.status === 'open' && det(x).deels));
  const r = ontkoppel(t, tx, f.id);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(t.fac(f.id).betaalspoor, 'te_betalen');
  assert.equal(t.call('GET', 'factuur/' + f.id).j.deels, null);
  const open = sigs(t, f).filter((x) => x.status === 'open');
  assert.equal(open.length, 1, JSON.stringify(sigs(t, f).map((x) => [x.sleutel, x.status, x.afhandeling])));
  assert.ok(!det(open[0]).deels, 'na losmaken weer het gewone signaal');
  // bestaande koppeling van vóór deze wijziging (volledig = 1, te weinig): blijft betaald, geen restsignaal
  const g = factuur(t, { incl: 100000, lev: 1 });
  const tg = bankregel(t, g, { bedrag: 40000 });
  t.fdb.db.prepare("INSERT INTO koppeling (transactie, factuur, bron, methode, zekerheid, volledig, alleen_eigenaar, wie, wanneer) VALUES (?, ?, 'mens', 'handmatig', 1, 1, 0, 'david (proef)', ?)").run(tg, g.id, new Date(NU).toISOString());
  t.fdb.db.prepare("UPDATE factuur SET betaalspoor = 'betaald_gezien' WHERE id = ?").run(g.id);
  t.controle();
  assert.equal(sigs(t, g).filter((x) => x.status === 'open').length, 0);
  assert.equal(t.call('GET', 'factuur/' + g.id).j.deels, null);
});

test('bijschrijving blijft geweigerd als betaling', () => {
  const t = opzet();
  const f = factuur(t), bij = bankregel(t, f, { bij: true });
  const r = t.call('POST', 'koppel', { transactie: bij, factuur: f.id });
  assert.equal(r.status, 409);
  assert.match(r.j.fout, /bijschrijving/);
});

test('diffreview MOET 1: termijnen 40 + 60 → koppelingen blijven volledig 0 (de som telt); terugboeking van een termijn zet hem weer open', () => {
  const t = opzet();
  const f = factuur(t, { incl: 100000 });
  const a = bankregel(t, f, { bedrag: 40000, boekdatum: '2026-11-10' }), b = bankregel(t, f, { bedrag: 60000, boekdatum: '2026-11-11' });
  t.call('POST', 'koppel', { transactie: a, factuur: f.id });
  const rb = t.call('POST', 'koppel', { transactie: b, factuur: f.id });
  assert.equal(rb.j.volledig, true);
  assert.equal(t.fac(f.id).betaalspoor, 'betaald_gezien');
  assert.equal(t.kop(a, f.id).volledig, 0);
  assert.equal(t.kop(b, f.id).volledig, 0, 'geen zelfstandig dekkende vlag op de laatste termijn');
  // de 60 % komt terug: signaal Teruggeboekt (zoals de bankcontrole hem maakt) en David kiest "Leverancier incasseert" niet maar "Opnieuw betalen";
  // de knop koppelt de terugboeking (sepa_terug) en zet het spoor terug omdat netto 40 % de factuur niet dekt (diffreview ronde 5)
  const terug = bankregel(t, f, { bij: true, boekdatum: '2026-11-14' });
  t.fdb.db.prepare('UPDATE bank_transactie SET bedrag_centen = 60000 WHERE id = ?').run(terug);
  const sid = D.nieuwId();
  D.voegToe(t.fdb, 'signaal', { id: sid, sleutel: 'teruggeboekt:' + terug + '|' + f.id, soort: 'teruggeboekt', titel: 'Betaling teruggeboekt', entiteit: 'tolgaarde',
    transacties: [terug], facturen: [f.id], bedrag_centen: 60000, details: { nummer: t.fac(f.id).nummer, batch: null, uitvoerdatum: null, verwacht_centen: 60000, automatisch: false },
    alleen_eigenaar: 0, status: 'open', aangemaakt_op: new Date(NU).toISOString() });
  const rt = t.call('POST', 'signaal', { id: sid, knop: 'opnieuw_betalen' });
  assert.equal(rt.status, 200, JSON.stringify(rt.j));
  assert.ok(t.kop(terug, f.id) && t.kop(terug, f.id).methode === 'sepa_terug');
  assert.equal(t.fac(f.id).betaalspoor, 'te_betalen', 'de knop zet hem terug: 40 dekt de factuur niet');
  t.controle();
  assert.equal(t.fac(f.id).betaalspoor, 'te_betalen', 'de bankcontrole zet hem niet terug op betaald');
  assert.deepEqual(t.call('GET', 'factuur/' + f.id).j.deels, { betaald_centen: 40000, rest_centen: 60000 }, 'de 60 kwam terug: 40 betaald, 60 open');
  // na een terugboeking telt de termijn opnieuw (twee weken na de terugboeking, wv1415): op 1-12 het restsignaal
  t.controle(Date.parse('2026-12-01T10:00:00Z'));
  const open = sigs(t, f).filter((x) => x.status === 'open');
  assert.equal(open.length, 1, JSON.stringify(t.fdb.db.prepare('SELECT soort, sleutel, status FROM signaal WHERE facturen LIKE ?').all('%' + f.id + '%')));
  assert.deepEqual(det(open[0]).deels, { betaald_centen: 40000, rest_centen: 60000, factuur_centen: 100000 }, 'bankcontrole telt hetzelfde');
});

test('diffreview MOET 2: extra deelbetaling met een oudere boekdatum → nieuw restsignaal, het oude dicht (bijgewerkt), precies één open', () => {
  const t = opzet();
  const f = factuur(t, { incl: 100000 });
  const a = bankregel(t, f, { bedrag: 30000, boekdatum: '2026-11-12' });
  t.call('POST', 'koppel', { transactie: a, factuur: f.id });
  t.controle();
  assert.equal(sigs(t, f).filter((x) => x.status === 'open').length, 1);
  const b = bankregel(t, f, { bedrag: 20000, boekdatum: '2026-11-05' });
  t.call('POST', 'koppel', { transactie: b, factuur: f.id });
  t.controle(NU + 60000);
  const alle = sigs(t, f), open = alle.filter((x) => x.status === 'open');
  assert.equal(open.length, 1, JSON.stringify(alle.map((x) => [x.sleutel, x.status, x.afhandeling])));
  assert.equal(det(open[0]).deels.betaald_centen, 50000);
  assert.equal(open[0].bedrag_centen, 50000);
  assert.ok(alle.some((x) => x.afhandeling === 'bijgewerkt'));
  t.controle(NU + 120000);
  assert.equal(sigs(t, f).filter((x) => x.status === 'open').length, 1, 'stabiel bij de volgende controle');
});

test('diffreview ronde 4: Klopt zo en daarna een terugboeking van een termijn → de factuur is weer niet gedekt (40 open)', () => {
  const t = opzet();
  const f = factuur(t, { incl: 100000 });
  const a = bankregel(t, f, { bedrag: 40000, boekdatum: '2026-11-08' }), b = bankregel(t, f, { bedrag: 40000, boekdatum: '2026-11-09' });
  t.call('POST', 'koppel', { transactie: a, factuur: f.id });
  t.call('POST', 'koppel', { transactie: b, factuur: f.id });
  t.controle();
  const s = sigs(t, f).find((x) => x.status === 'open' && det(x).deels);
  assert.equal(det(s).deels.rest_centen, 20000);
  assert.equal(t.call('POST', 'signaal', { id: s.id, knop: 'rest_vervalt', toelichting: 'twintig euro korting afgesproken' }).status, 200);
  assert.equal(t.fac(f.id).betaalspoor, 'betaald_gezien');
  t.controle();
  assert.equal(sigs(t, f).filter((x) => x.status === 'open').length, 0, 'gedekt: niets open');
  // een termijn van 40 komt terug
  const terug = bankregel(t, f, { bij: true, boekdatum: '2026-11-12' });
  t.fdb.db.prepare('UPDATE bank_transactie SET bedrag_centen = 40000 WHERE id = ?').run(terug);
  t.fdb.db.prepare("INSERT INTO koppeling (transactie, factuur, bron, methode, zekerheid, volledig, alleen_eigenaar, wie, wanneer) VALUES (?, ?, 'mens', 'sepa_terug', 1, 0, 0, 'david (proef)', ?)").run(terug, f.id, new Date(NU).toISOString());
  t.fdb.db.prepare("UPDATE factuur SET betaalspoor = 'te_betalen', betaald_gezien_op = NULL WHERE id = ?").run(f.id);
  assert.deepEqual(t.call('GET', 'factuur/' + f.id).j.deels, { betaald_centen: 40000, rest_centen: 40000 }, '40 betaald, 20 vervallen, 40 open');
  t.controle(Date.parse('2026-12-01T10:00:00Z'));
  const open = sigs(t, f).filter((x) => x.status === 'open');
  assert.equal(open.length, 1);
  assert.equal(det(open[0]).deels.rest_centen, 40000);
});

test('diffreview ronde 6: Klopt zo en daarna komt de hele betaling terug → signaal met het juiste bedrag, niet in een batch met het volle bedrag', () => {
  const t = opzet();
  const f = factuur(t, { incl: 100000 });
  const a = bankregel(t, f, { bedrag: 80000, boekdatum: '2026-11-08' });
  t.call('POST', 'koppel', { transactie: a, factuur: f.id });
  t.controle();
  const s = sigs(t, f).find((x) => x.status === 'open' && det(x).deels);
  assert.equal(t.call('POST', 'signaal', { id: s.id, knop: 'rest_vervalt', toelichting: 'korting van tweehonderd afgesproken' }).status, 200);
  assert.equal(t.fac(f.id).betaalspoor, 'betaald_gezien');
  const terug = bankregel(t, f, { bij: true, boekdatum: '2026-11-12' });
  t.fdb.db.prepare('UPDATE bank_transactie SET bedrag_centen = 80000 WHERE id = ?').run(terug);
  const sid = D.nieuwId();
  D.voegToe(t.fdb, 'signaal', { id: sid, sleutel: 'teruggeboekt:' + terug + '|' + f.id, soort: 'teruggeboekt', titel: 'Betaling teruggeboekt', entiteit: 'tolgaarde',
    transacties: [terug], facturen: [f.id], bedrag_centen: 80000, details: { nummer: t.fac(f.id).nummer, batch: null, uitvoerdatum: null, verwacht_centen: 80000, automatisch: false },
    alleen_eigenaar: 0, status: 'open', aangemaakt_op: new Date(NU).toISOString() });
  assert.equal(t.call('POST', 'signaal', { id: sid, knop: 'opnieuw_betalen' }).status, 200);
  assert.equal(t.fac(f.id).betaalspoor, 'te_betalen');
  const bt = t.call('GET', 'betalen').j.te_betalen.find((x) => x.id === f.id);
  assert.match(String(bt && bt.batch_reden), /Klopt zo/, 'niet in een batch met het volle bedrag');
  t.controle(Date.parse('2026-12-01T10:00:00Z'));
  const open = sigs(t, f).filter((x) => x.status === 'open');
  assert.equal(open.length, 1, JSON.stringify(sigs(t, f).map((x) => [x.sleutel, x.status])));
  assert.equal(open[0].bedrag_centen, 80000, 'te betalen = factuur min wat vervallen is');
});

test('diffreview ronde 7: deelbetaling vanaf een eigenaar-rekening → het restsignaal is alleen voor de eigenaar', () => {
  const t = opzet();
  const f = factuur(t, { incl: 100000 });
  const a = bankregel(t, f, { bedrag: 30000 });
  t.fdb.db.prepare('UPDATE bank_transactie SET alleen_eigenaar = 1 WHERE id = ?').run(a);
  t.call('POST', 'koppel', { transactie: a, factuur: f.id });
  t.controle();
  const s = sigs(t, f).find((x) => x.status === 'open' && det(x).deels);
  assert.ok(s, 'restsignaal');
  assert.equal(s.alleen_eigenaar, 1);
  const pm = t.call('GET', 'bank', null, { rol: t.pm() });
  assert.equal(pm.status, 200);
  assert.ok(!(pm.j.signalen || []).some((x) => x.id === s.id), 'praktijkmanager ziet hem niet');
});
