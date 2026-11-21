'use strict';
// wv3701 (David 21-11-2026): knop Opnieuw lezen bij een scan in Beoordelen — lokale OCR (server.js) → zelfde besliskader, alleen lege velden.
// Alles verzonnen: IBAN's met bankcode TEST, KvK's 99…, het BSN 111222333 is een verzonnen elfproefgetal. Draaien: bash test/facturen-herlees.sh
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'facturen-db.js'));
const F = require(path.join(ROOT, 'facturen.js'));
const Z = require(path.join(ROOT, 'test', 'facturen-zaad.js'));

const NU = Date.parse('2026-11-21T13:00:00Z');
const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });

const INKOOP = ['Leverancier Herlees B.V.', 'Voorbeeldweg 9, 9999 ZZ Voorbeeld', 'KvK 99100077', 'Factuur', 'Factuurnummer: HL-2026-0013', 'Factuurdatum: 19-11-2026',
  'Vervaldatum: 19-12-2026', 'Aan: Huisartsenpraktijk Voorbeeld', 'Omschrijving: verzonnen proefregel', 'Totaal incl. btw: EUR 121,00'].join('\n');
const KORT = 'onleesbaar';

function opzet() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-herlees-'));
  WEG.push(dir);
  const fdb = D.open(path.join(dir, 'db'));
  Z.zaai(fdb, { vandaag: '2026-11-21' });
  const routes = F.maak({ fout: () => {} });
  const eig = F.rolVoor(fdb, { ingang: 'app', wie: 'david (proef)' });
  const t = { fdb, routes, eig };
  t.call = (rest, d, x) => {
    x = x || {};
    return routes.app(fdb, { methode: x.methode || 'POST', pad: '/app/facturen/' + rest, d: d || {}, rol: x.rol || eig, primair: true, nu: NU,
      versOk: () => false, versVerbruik: () => {}, ocrTekst: x.ocrTekst });
  };
  // een scan (PDF zonder tekstlaag) in Beoordelen, zoals de koerier hem vóór wv3660 zonder lezing achterliet
  t.scan = (o) => {
    o = o || {};
    const st = D.stukSchrijf(fdb, Buffer.from('%PDF-1.4 verzonnen scan ' + (o.naam || 'a') + ' ' + Math.random()));
    const doc = D.nieuwId(), id = D.nieuwId(), w = new Date(NU).toISOString();
    D.voegToe(fdb, 'document', { id: doc, sha256: st.sha256, naam: (o.naam || 'scan') + '.pdf', mime: 'application/pdf', bytes: st.bytes, soort: 'pdf', tekstlaag: o.tekstlaag === undefined ? 0 : o.tekstlaag,
      patientkenmerk: 0, te_lezen: 0, aangemaakt_op: w });
    D.voegToe(fdb, 'factuur', { id, document: doc, soort: 'factuur', valuta: 'EUR', betaalwijze: 'onbekend', status: o.status || 'te_beoordelen', ibans_betaal: [], ibans_onbekend: [],
      redenen: ['Scan zonder tekstlaag: velden met de hand invullen', 'geen factuurdatum'], controles: [], patientkenmerk: 0, alleen_eigenaar: 0, aangemaakt_op: w, bijgewerkt_op: w });
    return { id, doc, sha256: st.sha256 };
  };
  t.f = (id) => D.factuurVoorKern(fdb, id);
  return t;
}

test('route bestaat, detail zegt scan: true bij een PDF zonder tekstlaag', () => {
  assert.ok(F.ROUTES.POST.includes('herlees'));
  const t = opzet(), s = t.scan();
  const r = t.call('factuur/' + s.id, {}, { methode: 'GET' });
  assert.equal(r.status, 200);
  assert.equal(r.j.documenten.document.scan, true);
  const s2 = t.scan({ tekstlaag: 1, naam: 'b' });
  assert.equal(t.call('factuur/' + s2.id, {}, { methode: 'GET' }).j.documenten.document.scan, false);
});

test('opnieuw lezen met lokale OCR vult de velden als voorstel, reden "velden lokaal gelezen (OCR)", besluit + audit, status blijft Beoordelen', () => {
  const t = opzet(), s = t.scan();
  const b = t.routes.herleesBytes(t.fdb, t.eig, { id: s.id });
  assert.equal(b.ok, true); assert.ok(Buffer.isBuffer(b.bytes) && b.bytes.length > 10);
  const r = t.call('herlees', { id: s.id, versie: 1 }, { ocrTekst: INKOOP });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  for (const v of ['nummer', 'factuurdatum', 'incl']) assert.ok(r.j.velden.includes(v), v + ' in ' + JSON.stringify(r.j.velden));
  const f = t.f(s.id);
  assert.equal(f.status, 'te_beoordelen');
  assert.equal(f.nummer, 'HL-2026-0013'); assert.equal(f.factuurdatum, '2026-11-19'); assert.equal(f.incl, 12100); assert.equal(f.incl_eur, 12100);
  assert.equal(f.versie, 2);
  assert.ok(f.redenen.includes('Scan zonder tekstlaag: velden lokaal gelezen (OCR), alleen een voorstel: nakijken'), JSON.stringify(f.redenen));
  assert.ok(!f.redenen.includes('Scan zonder tekstlaag: velden met de hand invullen'));
  const bs = t.fdb.db.prepare("SELECT veld, bron, toelichting FROM besluit WHERE factuur = ? AND stap = 'herlezen'").all(s.id);
  assert.ok(bs.some((x) => x.veld === 'nummer' && x.bron === 'regel' && /lokale OCR/.test(x.toelichting)));
  const a = t.fdb.db.prepare("SELECT na FROM audit WHERE object_id = ? AND wat = 'factuur_herlezen'").get(s.id);
  assert.ok(a, 'auditrij'); assert.ok(!/HL-2026|12100|121,00/.test(a.na), 'geen waarden in de audit');
});

test('wat David met de hand zette blijft staan (ook een met de hand leeggemaakt veld); alleen lege velden worden gevuld', () => {
  const t = opzet(), s = t.scan();
  assert.equal(t.call('wijzig', { id: s.id, versie: 1, velden: { nummer: 'MIJN-1', factuurdatum: '2026-11-01' } }).status, 200);
  assert.equal(t.call('wijzig', { id: s.id, velden: { factuurdatum: null } }).status, 200);
  const v = t.f(s.id).versie;
  const r = t.call('herlees', { id: s.id, versie: v }, { ocrTekst: INKOOP });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const f = t.f(s.id);
  assert.equal(f.nummer, 'MIJN-1', 'met de hand gezet nummer blijft');
  assert.equal(f.factuurdatum, null, 'met de hand leeggemaakte datum blijft leeg');
  assert.equal(f.incl, 12100, 'leeg bedrag wordt gevuld');
  assert.ok(!r.j.velden.includes('nummer') && !r.j.velden.includes('factuurdatum'));
});

test('weigert: zonder OCR-tekst 503, te weinig tekst 422, niet in Beoordelen 409, geen scan 409, oude versie 409, praktijkmanager 403', () => {
  const t = opzet(), s = t.scan();
  assert.equal(t.call('herlees', { id: s.id }).status, 503, 'ocrTekst ontbreekt (nooit uit het verzoek)');
  assert.equal(t.call('herlees', { id: s.id, ocrTekst: INKOOP }).status, 503, 'ocrTekst in de body telt niet');
  assert.equal(t.call('herlees', { id: s.id }, { ocrTekst: KORT }).status, 422);
  assert.equal(t.call('herlees', { id: s.id, versie: 7 }, { ocrTekst: INKOOP }).status, 409);
  const g = t.scan({ status: 'geen_factuur', naam: 'g' });
  assert.equal(t.call('herlees', { id: g.id }, { ocrTekst: INKOOP }).status, 409);
  assert.equal(t.routes.herleesBytes(t.fdb, t.eig, { id: g.id }).status, 409, 'ook de bytes niet bij Geen factuur');
  const p = t.scan({ tekstlaag: 1, naam: 'p' });
  assert.equal(t.call('herlees', { id: p.id }, { ocrTekst: INKOOP }).status, 409);
  t.fdb.db.prepare("UPDATE gebruiker SET actief = 1 WHERE rol = 'praktijkmanager'").run();
  const pm = F.rolVoor(t.fdb, { ingang: 'fac', email: 'praktijkmanager@voorbeeld.invalid' });
  if (pm) {
    const h = t.call('herlees', { id: s.id }, { ocrTekst: INKOOP, rol: pm });
    assert.ok(h.status === 403 || h.status === 404, String(h.status));
    assert.ok([403, 404].includes(t.routes.herleesBytes(t.fdb, pm, { id: s.id }).status));
  }
  assert.equal(t.f(s.id).versie, 1, 'niets gewijzigd');
  assert.equal(t.routes.herleesBytes(null, t.eig, { id: s.id }).status, 503);
});

test('kenmerk van patiëntgegevens in de OCR → patientkenmerk en alleen-eigenaar omhoog (nooit omlaag)', () => {
  const t = opzet(), s = t.scan();
  const r = t.call('herlees', { id: s.id }, { ocrTekst: INKOOP + '\nBetreft: BSN 111222333' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const f = t.f(s.id);
  assert.equal(f.patientkenmerk, true); assert.equal(f.alleen_eigenaar, true);
  assert.equal(t.fdb.db.prepare('SELECT patientkenmerk FROM document WHERE id = ?').get(s.doc).patientkenmerk, 1);
});

test('zegt de kern nu "geen factuur", dan blijft hij in Beoordelen met die reden bovenaan', () => {
  const t = opzet(), s = t.scan();
  const tekst = 'Herinnering\nDit is geen factuur maar een orderbevestiging\nOrderbevestiging nummer 12345\nLeverancier Herlees B.V. KvK 99100077\nTotaal EUR 10,00';
  const r = t.call('herlees', { id: s.id }, { ocrTekst: tekst });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(t.f(s.id).status, 'te_beoordelen');
  if (r.j.uitkomst_kern === 'geen_factuur') assert.match(t.f(s.id).redenen[0], /^Na opnieuw lezen: lijkt geen inkoopfactuur/);
});

test('server.js: lokale OCR vóór de route, tekst alleen via ocrTekst van de server', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(src, /pad === '\/app\/facturen\/herlees' && rolPrimair\(\) === true && typeof facturenRoutes\.herleesBytes === 'function'/);
  assert.match(src, /Promise\.race\(\[facturenIo\(\)\.ocrLokaal\(st\.bytes\)/);
  assert.match(src, /ocrTekst: ocrTekst \}\);   \/\/ wv3701/);
});

// ── review Fable (wv3701): MOET 1, ZOU 2–4, KAN 7–8 ──
const lev2 = (t) => t.fdb.db.prepare("SELECT id, naam, kvk, standaard_entiteit FROM leverancier WHERE kvk IS NOT NULL AND standaard_entiteit IS NOT NULL AND standaard_entiteit <> 'prive' ORDER BY id LIMIT 2").all();

test('MOET 1: een gescande betalingsherinnering → besluit soort_stuk geschreven, Bevestigen dicht (niet naar Exact)', () => {
  const t = opzet(), s = t.scan();
  const ex = t.fdb.db.prepare("SELECT sleutel FROM entiteit WHERE boekhoud_route = 'exact' AND actief = 1 AND sleutel <> 'prive' LIMIT 1").get();
  assert.ok(ex, 'zaad heeft een Exact-entiteit');
  assert.equal(t.call('wijzig', { id: s.id, versie: 1, velden: { entiteit: ex.sleutel, betaalwijze: 'zelf' } }).status, 200);
  const r = t.call('herlees', { id: s.id }, { ocrTekst: 'Betalingsherinnering\n' + INKOOP });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.ok(t.fdb.db.prepare("SELECT 1 FROM besluit WHERE factuur = ? AND stap = 'soort_stuk' AND waarde = 'herinnering'").get(s.id), 'soort_stuk-besluit');
  const det = t.call('factuur/' + s.id, {}, { methode: 'GET' }).j;
  assert.equal(det.bevestigen.ok, false, JSON.stringify(det.bevestigen));
  assert.ok(det.bevestigen.redenen.some((x) => /herinnering/i.test(x)), JSON.stringify(det.bevestigen.redenen));
});

test('ZOU 2/3: herkende leverancier vult naam mee; staat er een andere leverancier, dan geen KvK/entiteit/betaalwijze van de herkende, wel een kijk-na-reden', () => {
  const t = opzet(), [a, b] = lev2(t);
  assert.ok(a && b && a.kvk !== b.kvk, 'twee zaadleveranciers met KvK');
  const tekst = b.naam + '\nKvK ' + b.kvk + '\n' + INKOOP.split('\n').slice(3).join('\n');
  // geen leverancier, wel een oude naam uit de mail → leverancier én naam van de herkende
  const s1 = t.scan({ naam: 'n1' });
  t.fdb.db.prepare("UPDATE factuur SET leverancier_naam = 'Oude Naam Uit Mail' WHERE id = ?").run(s1.id);
  const r1 = t.call('herlees', { id: s1.id }, { ocrTekst: tekst });
  assert.equal(r1.status, 200, JSON.stringify(r1.j));
  const f1 = t.f(s1.id);
  assert.equal(f1.leverancier_id, b.id); assert.equal(f1.leverancier_naam, b.naam);
  // met de hand leverancier a gekozen → b herkend: entiteit/betaalwijze niet van b, wel de stukvelden
  const s2 = t.scan({ naam: 'n2' });
  assert.equal(t.call('wijzig', { id: s2.id, versie: 1, velden: { leverancier: a.id } }).status, 200);
  const r2 = t.call('herlees', { id: s2.id }, { ocrTekst: tekst });
  assert.equal(r2.status, 200, JSON.stringify(r2.j));
  const f2 = t.f(s2.id);
  assert.equal(f2.leverancier_id, a.id);
  assert.ok(r1.j.velden.includes('leverancier'), 'herkende leverancier: ' + JSON.stringify(r1.j.velden));
  {
    assert.ok(!r2.j.velden.includes('entiteit') && !r2.j.velden.includes('betaalwijze') && !r2.j.velden.includes('leverancier_kvk'), JSON.stringify(r2.j.velden));
    assert.ok(f2.redenen.some((x) => /andere leverancier/.test(x)), JSON.stringify(f2.redenen));
  }
  assert.equal(f2.incl, 12100, 'stukvelden wel');
});

test('ZOU 4: een oude reden van een eerdere lezing door Claude blijft staan', () => {
  const t = opzet(), s = t.scan();
  t.fdb.db.prepare('UPDATE factuur SET redenen = ? WHERE id = ?').run(JSON.stringify(['Alleen door Claude gelezen, niet in de lokale tekst: incl — eerst nakijken']), s.id);
  assert.equal(t.call('herlees', { id: s.id }, { ocrTekst: INKOOP }).status, 200);
  assert.ok(t.f(s.id).redenen.includes('Alleen door Claude gelezen, niet in de lokale tekst: incl — eerst nakijken'));
});

test('KAN 7/8: creditnota krijgt soort creditnota; tweede druk zonder nieuws schrijft niets', () => {
  const t = opzet(), s = t.scan();
  const r = t.call('herlees', { id: s.id }, { ocrTekst: INKOOP.replace('Factuur\n', 'Creditnota\n').replace('EUR 121,00', 'EUR -121,00') });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const f = t.f(s.id);
  if (f.incl < 0) assert.equal(f.soort, 'creditnota');
  const v = f.versie, nAudit = Number(t.fdb.db.prepare("SELECT count(*) n FROM audit WHERE object_id = ? AND wat = 'factuur_herlezen'").get(s.id).n);
  const r2 = t.call('herlees', { id: s.id }, { ocrTekst: INKOOP.replace('Factuur\n', 'Creditnota\n').replace('EUR 121,00', 'EUR -121,00') });
  assert.equal(r2.status, 200); assert.deepEqual(r2.j.velden, []);
  assert.equal(t.f(s.id).versie, v, 'geen nieuwe versie');
  assert.equal(Number(t.fdb.db.prepare("SELECT count(*) n FROM audit WHERE object_id = ? AND wat = 'factuur_herlezen'").get(s.id).n), nAudit);
});

test('server.js: OCR zonder tekst → lege tekst (422), fout of > 80 s → geen tekst (503)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(src, /setTimeout\(function \(\) \{ k\(null\); \}, 80000\)/);
  assert.match(src, /if \(o && typeof o === 'object'\) ocrTekst = o\.ok && typeof o\.tekst === 'string' \? o\.tekst : '';/);
});
