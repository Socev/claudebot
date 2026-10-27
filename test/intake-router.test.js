'use strict';
// Toetsen voor intake-router.js (wv980, OVIS Intake stap 2). Alle toetsdata is verzonnen (de repo is openbaar).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const R = require('../intake-router.js');
const K = R.K;
const poort = require('../intake/patientpoort.js');

const ORG = { o: 'o-org', k: 'org:voorbeeld-energie', naam: 'Voorbeeld Energie BV', eigen: false, soort: 'organisatie', status: 'actief', concept: false, voor: ['TG'] };
const ORG2 = { o: 'o-org2', k: 'org:proef-leasing', naam: 'Proef Leasing', eigen: false, soort: 'organisatie', status: 'actief', concept: false, voor: ['TG', 'GH'] };
const ORG3 = { o: 'o-org3', k: 'org:concept-bv', naam: 'Conceptbedrijf Nul', eigen: false, soort: 'organisatie', status: 'voorgesteld', concept: true, voor: [] };
const TG = { o: 'o-tg', k: 'TG', naam: 'Huisartsenpraktijk Testgaarde', eigen: true, soort: 'entiteit', status: 'actief', concept: false, voor: [] };
const GH = { o: 'o-gh', k: 'GH', naam: 'Praktijk Proefhout', eigen: true, soort: 'entiteit', status: 'actief', concept: false, voor: [] };
const HANDVATTEN = {
  compilatienummer: 7,
  entiteiten: [ORG, ORG2, ORG3, TG, GH],
  ids: [
    { o: 'o-org', ns: 'kvk', v: '12345678', st: 'actief' }, { o: 'o-org', ns: 'domein', v: 'voorbeeld-energie.example', st: 'actief' },
    { o: 'o-org', ns: 'email', v: 'facturen@voorbeeld-energie.example', st: 'actief' },
    { o: 'o-org2', ns: 'domein', v: 'proefleasing.example', st: 'actief' }, { o: 'o-org2', ns: 'kvk', v: '87654321', st: 'actief' },
    { o: 'o-org3', ns: 'domein', v: 'conceptnul.example', st: 'voorgesteld' },
    { o: 'o-tg', ns: 'kvk', v: '11112222', st: 'actief' }, { o: 'o-tg', ns: 'domein', v: 'testgaarde.example', st: 'actief' },
    { o: 'o-tg', ns: 'alias', v: 'testgaarde', st: 'actief' }, { o: 'o-gh', ns: 'alias', v: 'proefhout', st: 'actief' },
    { o: 'o-tg', ns: 'iban', v: 'NL02ABNA0123456789', st: 'actief' },
  ],
  niet_dezelfde: [],
};
const REG = K.register(HANDVATTEN);

test('DKIM: alleen de bovenste kop, uitlijning op organisatiedomein, vreemde authserv-id telt niet', () => {
  const top = 'mx.google.com; dkim=pass header.i=@mail.voorbeeld-energie.example header.s=s1 header.b=abc; spf=pass smtp.mailfrom=x; dmarc=pass (p=NONE) header.from=voorbeeld-energie.example';
  let u = K.dkimUitslag([top], 'facturen@voorbeeld-energie.example', { authserv: 'mx.google.com' });
  assert.equal(u.pass, true); assert.equal(u.uitgelijnd, true); assert.equal(u.dmarc, 'pass');
  u = K.dkimUitslag(['mx.google.com; dkim=pass header.d=verzendhuis.example'], 'facturen@voorbeeld-energie.example', { authserv: 'mx.google.com' });
  assert.equal(u.pass, true); assert.equal(u.uitgelijnd, false);
  // een lagere kop (door de afzender meegestuurd) telt niet
  u = K.dkimUitslag(['mx.google.com; dkim=fail header.d=voorbeeld-energie.example', 'mx.google.com; dkim=pass header.d=voorbeeld-energie.example'], 'facturen@voorbeeld-energie.example', { authserv: 'mx.google.com' });
  assert.equal(u.uitgelijnd, false);
  u = K.dkimUitslag(['nep.example; dkim=pass header.d=voorbeeld-energie.example'], 'facturen@voorbeeld-energie.example', { authserv: 'mx.google.com' });
  assert.equal(u.gelezen, false); assert.equal(u.uitgelijnd, false);
  assert.equal(K.orgDomein('a.b.voorbeeld.co.uk'), 'voorbeeld.co.uk');
});

test('mail lezen: multipart, quoted-printable, base64, List-Unsubscribe, Authentication-Results bovenaan eerst', () => {
  const b64 = Buffer.from('Tweede deel in base64 met één accent').toString('base64');
  const m = ['Authentication-Results: mx.google.com; dkim=pass header.d=voorbeeld-energie.example', 'Authentication-Results: lager.example; dkim=none',
    'From: Facturen <facturen@voorbeeld-energie.example>', 'List-Unsubscribe: <mailto:weg@voorbeeld-energie.example>', 'Content-Type: multipart/mixed; boundary="GRENS"', '',
    '--GRENS', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Factuurnummer: VE-2026-0042 =E2=82=AC 12,50 lange =', 'regel', '',
    '--GRENS', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64, '',
    '--GRENS', 'Content-Type: application/pdf', 'Content-Disposition: attachment; filename="x.pdf"', '', 'JVBERi0x', '--GRENS--', ''].join('\r\n');
  const r = K.mailLees(Buffer.from(m, 'latin1'));
  assert.match(r.tekst, /VE-2026-0042 € 12,50 lange regel/);
  assert.match(r.tekst, /één accent/);
  assert.equal(r.list_unsubscribe, true);
  assert.equal(r.ar.length, 2); assert.match(r.ar[0], /^mx\.google\.com/);
  assert.doesNotMatch(r.tekst, /JVBERi0x/);
});

test('velden: label met vindplaats, letterlijk, formaatfouten als kenmerk, IBAN alleen geteld', () => {
  const tekst = 'Voorbeeld Energie BV\nFactuurnummer: VE-2026-0042\nFactuurdatum: 03-10-2026\nVervaldatum: 17-10-2026\nTotaal incl. btw: € 1.234,56\nKvK: 1234 5678\nBTW NL123456789B01\nIBAN NL00ABNA0000000000\nKvK-nummer 123';
  const v = K.velden([{ deel: 'b1', tekst }]);
  const w = function (n) { const f = v.velden.find((x) => x.veld === n); return f && f.waarde; };
  assert.equal(w('factuurnummer'), 'VE-2026-0042');
  assert.equal(w('factuurdatum'), '03-10-2026');
  assert.equal(w('vervaldatum'), '17-10-2026');
  assert.match(w('bedrag'), /1\.234,56/);
  assert.equal(w('kvk'), '12345678');
  assert.equal(w('btw'), 'NL123456789B01');
  assert.ok(v.kenmerken.includes('iban_formaat'));
  assert.equal(v.ibans, 1);
  assert.ok(v.velden.every((x) => x.letterlijk));
  assert.ok(v.velden.find((x) => x.veld === 'factuurnummer').vindplaats.regel === 2);
  assert.equal(K.letterlijk('06-08-2026', 'datum 06-24-2026'), false);
  assert.ok(!JSON.stringify(v).includes('NL00ABNA'));
});

test('soort op vaste signalen', () => {
  const vf = (t) => K.velden([{ deel: 'x', tekst: t }]).velden;
  const f = 'Factuur\nFactuurnummer: A-123\nFactuurdatum: 01-10-2026\nTotaal: € 10,00\nKvK: 12345678';
  assert.deepEqual([K.soortBepaal({ tekst: f, velden: vf(f) }).soort, K.soortBepaal({ tekst: f, velden: vf(f) }).kracht], ['bewijsstuk', 'hoog']);
  const k = 'Aanmaning\nDossiernummer: D-777\nU betaalde niet.';
  assert.equal(K.soortBepaal({ tekst: k, velden: vf(k) }).kracht, 'hoog');
  assert.equal(K.soortBepaal({ tekst: 'Aanmaning zonder nummer', velden: [] }).kracht, 'redelijk');
  assert.equal(K.soortBepaal({ tekst: 'Herinnering: de tandarts verwacht je morgen om 9 uur, neem je pas mee', velden: [] }).soort, 'correspondentie');
  assert.equal(K.soortBepaal({ tekst: 'Nieuws van de week. Klik hier om je af te melden of uitschrijven', velden: [] }).soort, 'geen_post');
  assert.equal(K.soortBepaal({ tekst: 'Notitie voor mezelf over de dakgoot, nog even nakijken deze week graag', velden: [], eigen_van: true, eigen_aan: true }).soort, 'notitie');
  assert.equal(K.soortBepaal({ tekst: 'Geachte heer, hierbij het verslag van ons gesprek van gisteren over de planning. Met vriendelijke groet, Iemand', velden: [] }).kracht, 'redelijk');
  assert.equal(K.soortBepaal({ tekst: '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">', velden: [], ubl: true }).kracht, 'hoog');
});

const vel = (t) => K.velden([{ deel: 'x', tekst: t }]).velden;
test('afzender: KvK + tweede kenmerk = hoog, KvK alleen = redelijk, mailadres + uitgelijnde DKIM = hoog', () => {
  let t = 'Voorbeeld Energie BV · KvK 12345678 · www.voorbeeld-energie.example';
  let a = K.afzenderBepaal(REG, { van: '', tekst: t, velden: vel(t), scan: true });
  assert.equal(a.knoop, 'org:voorbeeld-energie'); assert.equal(a.kracht, 'hoog'); assert.equal(a.aangeleverd_door, 'scanner');
  t = 'KvK: 12345678';
  a = K.afzenderBepaal(REG, { van: '', tekst: t, velden: vel(t), scan: true });
  assert.equal(a.kracht, 'redelijk');
  a = K.afzenderBepaal(REG, { van: 'facturen@voorbeeld-energie.example', dkim: { uitgelijnd: true }, tekst: 'hallo', velden: [] });
  assert.equal(a.kracht, 'hoog');
  a = K.afzenderBepaal(REG, { van: 'facturen@voorbeeld-energie.example', dkim: { uitgelijnd: false }, tekst: 'hallo', velden: [] });
  assert.equal(a.kracht, 'zwak');
  a = K.afzenderBepaal(REG, { van: 'iemand@proefleasing.example', dkim: { uitgelijnd: true }, tekst: 'hallo', velden: [] });
  assert.equal(a.knoop, 'org:proef-leasing'); assert.equal(a.kracht, 'redelijk');
});
test('afzender: voorgesteld kenmerk is alleen een spoor; doorgestuurd door David telt de From niet; eigen entiteit is geen afzender; IBAN telt niet', () => {
  let a = K.afzenderBepaal(REG, { van: 'x@conceptnul.example', dkim: { uitgelijnd: true }, tekst: 'hallo', velden: [] });
  assert.equal(a.kracht, 'geen'); assert.equal(a.voorgesteld_spoor, 1);
  a = K.afzenderBepaal(REG, { van: 'facturen@voorbeeld-energie.example', dkim: { uitgelijnd: true }, eigen_van: true, doorgestuurd: true, tekst: 'Fwd: zie bijlage', velden: [] });
  assert.equal(a.kracht, 'geen'); assert.equal(a.aangeleverd_door, 'david');
  const t = 'Aan Huisartsenpraktijk Testgaarde, KvK 11112222';
  a = K.afzenderBepaal(REG, { van: '', tekst: t, velden: vel(t), scan: true });
  assert.equal(a.knoop, null);
  a = K.afzenderBepaal(REG, { van: '', tekst: 'Betaal op NL02ABNA0123456789', velden: [], scan: true });
  assert.equal(a.knoop, null);
});
test('afzender: twee kandidaten even sterk → een stap lager + twijfel; niet-dezelfde-als', () => {
  const t = 'KvK 12345678 en KvK 87654321';
  let a = K.afzenderBepaal(REG, { van: '', tekst: t, velden: [{ veld: 'kvk', waarde: '12345678' }, { veld: 'kvk', waarde: '87654321' }], scan: true });
  assert.equal(a.kracht, 'zwak'); assert.equal(a.twijfel, 'meerdere_kandidaten');
  const reg2 = K.register(Object.assign({}, HANDVATTEN, { niet_dezelfde: [['o-org', 'o-org2']] }));
  a = K.afzenderBepaal(reg2, { van: '', tekst: 'www.voorbeeld-energie.example KvK 12345678 · Proef Leasing', velden: [{ veld: 'kvk', waarde: '12345678' }], scan: true });
  assert.equal(a.twijfel, 'niet_dezelfde_als');
});
test('entiteit: postvak, eigen KvK, eigen IBAN, voor:-veld van de afzender, gelijkspel = twijfel', () => {
  let e = K.entiteitBepaal(REG, { bron: 'gmail:groenhouten', tekst: '', velden: [], aan: [] }, null);
  assert.equal(e.knoop, 'GH'); assert.equal(e.kracht, 'zwak');
  const t = 'Aan Testgaarde KvK 11112222';
  e = K.entiteitBepaal(REG, { bron: 'gmail:david', tekst: t, velden: vel(t), aan: [] }, null);
  assert.equal(e.knoop, 'TG'); assert.equal(e.kracht, 'hoog');
  e = K.entiteitBepaal(REG, { bron: 'gmail:david', tekst: 'incasso van NL02 ABNA 0123 4567 89', velden: [], aan: [] }, null);
  assert.equal(e.knoop, 'TG'); assert.equal(e.kracht, 'redelijk');
  e = K.entiteitBepaal(REG, { bron: 'gmail:david', tekst: '', velden: [], aan: [] }, { o: 'o-org' });
  assert.equal(e.knoop, 'TG'); assert.equal(e.kracht, 'redelijk');
  e = K.entiteitBepaal(REG, { bron: 'gmail:david', tekst: 'Testgaarde en Proefhout', velden: [], aan: [] }, null);
  assert.equal(e.twijfel, 'meerdere_entiteiten');
});
test('bestemming: automatisch alleen bij soort én afzender hoog; kennislens volgt de huidige indeling', () => {
  let b = K.bestemmingen({ soort: 'bewijsstuk', kracht: 'hoog' }, { kracht: 'hoog' }, { knoop: 'TG', kracht: 'hoog' }, { velden: [{ veld: 'vervaldatum' }] });
  assert.deepEqual(b.map((x) => [x.lens, x.zou_auto]), [['facturen', true], ['deadlines', true]]);
  b = K.bestemmingen({ soort: 'bewijsstuk', kracht: 'hoog' }, { kracht: 'redelijk' }, { knoop: 'TG', kracht: 'hoog' }, { velden: [] });
  assert.deepEqual(b.map((x) => [x.lens, x.zou_auto]), [['facturen', false]]);
  b = K.bestemmingen({ soort: 'correspondentie', kracht: 'zwak' }, { kracht: 'geen' }, { knoop: null, kracht: 'geen' }, { velden: [], label_entiteit: 'TG' });
  assert.deepEqual(b.map((x) => [x.lens, x.zou_auto]), [['kennis', true]]);
  b = K.bestemmingen({ soort: 'correspondentie', kracht: 'zwak' }, { kracht: 'geen' }, { knoop: null, kracht: 'geen' }, { velden: [] });
  assert.equal(b[0].zou_auto, false);
});

// ── module tegen een wegwerp-logboek ──
function logboek() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv980-'));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'intake.sqlite'));
  db.exec(`CREATE TABLE stuk (stuk_id TEXT PRIMARY KEY, bron TEXT NOT NULL, bron_id TEXT NOT NULL, profiel TEXT NOT NULL, versie INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL,
    aangemaakt TEXT NOT NULL, compleet_op TEXT, meta TEXT NOT NULL, marker_patient TEXT, marker_soorten TEXT, marker_versie TEXT, marker_op TEXT);
    CREATE TABLE onderdeel (stuk_id TEXT NOT NULL, deel TEXT NOT NULL, rol TEXT NOT NULL, naam TEXT NOT NULL, mime TEXT NOT NULL, grootte INTEGER NOT NULL, sha256 TEXT NOT NULL, meta TEXT, PRIMARY KEY (stuk_id, deel));
    CREATE TABLE vrij_veld (stuk_id TEXT NOT NULL, nr INTEGER NOT NULL, omschrijving TEXT NOT NULL, waarde TEXT, deel TEXT, PRIMARY KEY (stuk_id, nr));`);
  let n = 0;
  const zet = function (x) {
    const id = 'stk_20261027_' + String(++n).padStart(8, '0');
    db.prepare('INSERT INTO stuk (stuk_id, bron, bron_id, profiel, status, aangemaakt, compleet_op, meta, marker_patient, marker_soorten, marker_versie, marker_op) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, x.bron, 'b' + n, x.profiel, x.status || 'geschreven', '2026-10-27T08:0' + n + ':00Z', x.open ? null : '2026-10-27T08:0' + n + ':00Z', JSON.stringify(x.meta || {}), x.marker || 'geen', JSON.stringify(x.soorten || []), 'patientpoort-2.0', x.geenMarker ? null : '2026-10-27T08:10:00Z');
    (x.delen || []).forEach(function (d, i) {
      const b = Buffer.from(d.bytes);
      const sha = crypto.createHash('sha256').update(b).digest('hex');
      fs.mkdirSync(path.join(dir, 'blob', sha.slice(0, 2)), { recursive: true });
      fs.writeFileSync(path.join(dir, 'blob', sha.slice(0, 2), sha), b);
      db.prepare('INSERT INTO onderdeel (stuk_id, deel, rol, naam, mime, grootte, sha256, meta) VALUES (?,?,?,?,?,?,?,?)').run(id, d.deel || ('d' + i), d.rol, d.naam || 'x', d.mime, b.length, sha, d.meta ? JSON.stringify(d.meta) : null);
    });
    return id;
  };
  return { dir, db, zet };
}
const FACTUUR_PDF = '%PDF-nep factuur';
const PATIENT_TEKST = 'Geachte collega, wij zagen bovengenoemde patiënt op onze polikliniek in verband met klachten. Het geheime verzonnen woord is ZWAARDVIS.';
function stubs(extra) {
  return Object.assign({
    marker: poort,
    pdfBbox: async function (p) {
      const b = fs.readFileSync(p, 'utf8');
      if (b === FACTUUR_PDF) return '<page><word xMin="10" yMin="10" xMax="50" yMax="20">Factuur</word></page><page>' +
        ['Factuurnummer: VE-2026-0042', 'Factuurdatum: 03-10-2026', 'Totaal: € 99,00', 'KvK: 12345678', 'www.voorbeeld-energie.example', 'Aan Testgaarde'].map(function (r, i) {
          return r.split(' ').map(function (w, j) { return '<word xMin="' + (10 + j * 60) + '" yMin="' + (40 + i * 15) + '" xMax="' + (60 + j * 60) + '" yMax="' + (50 + i * 15) + '">' + w + '</word>'; }).join('');
        }).join('') + '</page>';
      return '<page></page>';   // geen tekstlaag
    },
    ocr: async function (p, mime, werk) { fs.writeFileSync(path.join(werk, 'p-1.png'), 'x'); return PATIENT_TEKST; },
    docx: async function () { return null; },
    handvatten: async function () { return HANDVATTEN; },
    eigenAdressen: function () { return ['david@voorbeeld.example'] },
  }, extra || {});
}

test('ronde: factuur beoordeeld, gemarkeerd vastgehouden zonder tekst, alleen-router-marker, dumps buiten de router, quarantaine leeg', async () => {
  const L = logboek();
  const fac = L.zet({ bron: 'scanner:scansnap', profiel: 'scansnap@1', delen: [{ rol: 'origineel', mime: 'application/pdf', bytes: FACTUUR_PDF }] });
  const gem = L.zet({ bron: 'gmail:david', profiel: 'mail@1', marker: 'gemarkeerd', soorten: ['brieftaal'], meta: { van: 'a@b.example', onderwerp: 'Verslag', aan: ['david@voorbeeld.example'] },
    delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: 'From: a@b.example\r\nContent-Type: text/plain\r\n\r\n' + PATIENT_TEKST }] });
  const scan = L.zet({ bron: 'scanner:scansnap', profiel: 'scansnap@1', marker: 'niet_te_lezen', delen: [{ rol: 'origineel', mime: 'application/pdf', bytes: '%PDF-scan zonder tekstlaag' }] });
  const dump = L.zet({ bron: 'signal', profiel: 'signal-dump@1', delen: [{ rol: 'representatie', mime: 'text/markdown', bytes: '# dump' }] });
  const open = L.zet({ bron: 'gmail:david', profiel: 'mail@1', open: true, meta: {} });
  const r = R.maak(Object.assign({ dir: L.dir }, stubs()));
  const u = await r.ronde();
  assert.equal(u.verwerkt, 4); assert.equal(u.fout, 0);
  const rij = (id) => L.db.prepare('SELECT * FROM router_stuk WHERE stuk_id = ?').get(id);
  const s1 = JSON.parse(rij(fac).samenvatting);
  assert.equal(rij(fac).status, 'beoordeeld');
  assert.equal(s1.soort, 'bewijsstuk'); assert.equal(s1.soort_kracht, 'hoog');
  assert.equal(s1.afzender, 'org:voorbeeld-energie'); assert.equal(s1.afzender_kracht, 'hoog');
  assert.equal(s1.entiteit, 'TG');
  assert.deepEqual(s1.bestemmingen.map((b) => b.lens), ['facturen']); assert.equal(s1.bestemmingen[0].zou_auto, true);
  assert.equal(rij(gem).status, 'vastgehouden');
  assert.equal(rij(scan).status, 'vastgehouden');
  assert.equal(JSON.parse(rij(scan).samenvatting).marker_router, 'gemarkeerd');   // OCR las patiënttaal
  assert.equal(rij(dump).status, 'buiten_router');
  assert.equal(rij(open), undefined);
  // geen tekst van een gemarkeerd stuk in het logboek (ook niet van de OCR)
  const alles = JSON.stringify(L.db.prepare('SELECT * FROM besluit').all()) + JSON.stringify(L.db.prepare('SELECT * FROM router_stuk').all());
  assert.ok(!/ZWAARDVIS|bovengenoemde/i.test(alles));
  for (const id of [gem, scan]) {
    const st = L.db.prepare('SELECT stap FROM besluit WHERE stuk_id = ?').all(id).map((x) => x.stap);
    assert.deepEqual(st, ['ontvangst', 'lokale_tekst', 'marker']);
  }
  assert.equal(L.db.prepare("SELECT count(*) n FROM bestemming WHERE stuk_id IN (?, ?)").get(gem, scan).n, 0);
  assert.deepEqual(fs.readdirSync(path.join(L.dir, 'quarantaine')), []);
  // append-only
  assert.throws(() => L.db.exec("UPDATE besluit SET uitkomst = 'x'"), /append-only/);
  assert.throws(() => L.db.exec('DELETE FROM besluit'), /append-only/);
  // tweede ronde: niets nieuws
  assert.equal((await r.ronde()).verwerkt, 0);
  // telling + regel
  const t = r.telling('2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');
  assert.equal(t.vastgehouden, 2); assert.equal(t.marker_na_ocr, 1); assert.equal(t.marker_alleen_router, 0); assert.equal(t.beoordeeld, 1); assert.equal(t.buiten_router, 1);
  assert.match(r.regel(t), /voert niets uit/);
  assert.equal(r.info().wacht, 0);
  r.sluit();
});

test('ronde: handvatten onbereikbaar → geen router-rij, volgende ronde opnieuw', async () => {
  const L = logboek();
  const id = L.zet({ bron: 'scanner:scansnap', profiel: 'scansnap@1', delen: [{ rol: 'origineel', mime: 'application/pdf', bytes: FACTUUR_PDF }] });
  let mis = true;
  const fouten = [];
  const r = R.maak(Object.assign({ dir: L.dir, fout: function (l, e) { fouten.push(l); } }, stubs({ handvatten: async function () { if (mis) throw new Error('rpc http 503'); return HANDVATTEN; } })));
  let u = await r.ronde();
  assert.equal(u.fout, 1); assert.equal(fouten[0], 'intake-router');
  assert.equal(L.db.prepare('SELECT count(*) n FROM router_stuk').get().n, 0);
  assert.equal(L.db.prepare('SELECT count(*) n FROM besluit').get().n, 0);
  mis = false;
  u = await r.ronde();
  assert.equal(u.verwerkt, 1);
  assert.equal(L.db.prepare('SELECT status FROM router_stuk WHERE stuk_id = ?').get(id).status, 'beoordeeld');
  r.sluit();
});

test('mail: doorgestuurd door David, DKIM uit het origineel, label van de route alleen ter vergelijking', async () => {
  const L = logboek();
  const eml = ['Authentication-Results: mx.google.com; dkim=pass header.d=voorbeeld.example', 'From: David <david@voorbeeld.example>', 'Subject: Fwd: rekening',
    'Content-Type: text/plain; charset=utf-8', '', 'Zie onder. ---------- Doorgestuurd bericht --------- Van: facturen@voorbeeld-energie.example', 'Factuurnummer: VE-1\nKvK 12345678\nTotaal: € 5,00'].join('\r\n');
  const id = L.zet({ bron: 'gmail:david', profiel: 'mail@1', meta: { van: 'david@voorbeeld.example', aan: ['david@voorbeeld.example'], onderwerp: 'Fwd: rekening', entiteit: 'tolgaarde' },
    delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: eml }, { rol: 'representatie', mime: 'text/markdown', bytes: 'entiteit: holding\nKvK 87654321' }] });
  const r = R.maak(Object.assign({ dir: L.dir }, stubs()));
  await r.ronde();
  const s = JSON.parse(L.db.prepare('SELECT samenvatting FROM router_stuk WHERE stuk_id = ?').get(id).samenvatting);
  assert.equal(s.aangeleverd_door, 'david');
  assert.equal(s.afzender, 'org:voorbeeld-energie');          // uit het stuk, niet uit de From
  assert.notEqual(s.afzender, 'org:proef-leasing');           // de representatie (model) leest de router niet
  assert.equal(s.dkim, 'uitgelijnd');
  assert.deepEqual(s.label_route, ['TG']); assert.equal(s.entiteit, 'TG'); assert.equal(s.label_gelijk, true);
  r.sluit();
});

test('kaartcode: één twijfel- en markerkaart per dag binnen de kaartgrenzen; de nieuwste sluit de oudere', async () => {
  const k = R.kaartenVoorDag({ datum: '2026-10-27', twijfel: 4, marker: 1, focus_twijfel: 'stk_20261027_00000001' });
  assert.equal(k.length, 2);
  for (const x of k) {
    assert.ok(x.titel.length <= 90, x.titel); assert.ok(x.waarom.length <= 400);
    assert.equal(x.herkomst.module, 'intake'); assert.equal(x.herkomst.handmatig, 'intake'); assert.equal(x.herkomst.doel.scherm, 'intake');
    assert.ok(!/stk_|\/opt|wv\d/.test(x.titel + x.waarom + x.stappen.join(' ')));
  }
  assert.equal(k[0].herkomst.doel.focus, 'stuk:stk_20261027_00000001');
  assert.equal(R.kaartenVoorDag({ datum: '2026-10-27', twijfel: 0, marker: 0 }).length, 0);
  const gezet = [], dicht = [];
  await R.zetKaarten(k, { kaartZet: async (p) => gezet.push(p.sleutel), kaartStatus: async (s, v, n, in_) => dicht.push([s, n, in_]), open: ['intake-twijfel-2026-10-26', 'intake-marker-2026-10-26', 'intake-twijfel-2026-10-28', 'iets-anders'] });
  assert.deepEqual(gezet, ['intake-twijfel-2026-10-27', 'intake-marker-2026-10-27']);
  assert.deepEqual(dicht, [['intake-twijfel-2026-10-26', 'samengevoegd', 'intake-twijfel-2026-10-27'], ['intake-marker-2026-10-26', 'samengevoegd', 'intake-marker-2026-10-27']]);
});

test('server.js: router alleen met schakelaar, in /health, in de dagtelling; geen kaarten in de schaduw', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(s, /intakeRouter && intakeRouterStand\(\)\) \{ try \{ const u = await intakeRouter\.ronde\(\)/);
  assert.match(s, /router: intakeRouterInfo\(\)/);
  assert.match(s, /intakeRouter\.regel\(intakeRouter\.telling\(/);
  assert.doesNotMatch(s, /kaartenVoorDag|zetKaarten/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'uitrol.sh'), 'utf8'), /^RELEASE_OPTIONEEL="[^"]*\bintake-router\.js\b/m);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8'), /COPY intake-router\.js \/app\/release-bootstrap\/intake-router\.js/);
});

test('facturen: migratie 8 zet leverancier.knoop_id, herhaalbaar na een lichte terugrol', () => {
  const D = require('../facturen-db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv980-fac-'));
  let f = D.open(dir);
  assert.equal(f.schema, 8);
  assert.ok(f.db.prepare('PRAGMA table_info(leverancier)').all().some((x) => x.name === 'knoop_id'));
  f.db.exec('DELETE FROM schema_migratie WHERE versie = 8');
  D.sluit(f);
  f = D.open(dir);
  assert.equal(f.schema, 8);
  assert.throws(() => f.db.prepare("INSERT INTO leverancier (id, naam, genormaliseerd, knoop_id, aangemaakt_op) VALUES ('aaaaaaaaaaaaaaaa', 'x', 'x', 'org:x y', '2026-10-27')").run());
  D.sluit(f);
});

test('marker: de ontvangstlaag zag niets, de router leest de afbeelding met OCR en houdt vast (telt als alleen door de router)', async () => {
  const L = logboek();
  const id = L.zet({ bron: 'gmail:david', profiel: 'mail@1', marker: 'geen', meta: { van: 'x@b.example', onderwerp: 'foto', aan: [] },
    delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: 'From: x@b.example\r\nContent-Type: text/plain\r\n\r\nZie de foto in de bijlage, groet.' }, { rol: 'bijlage', mime: 'image/png', bytes: 'nep-png' }] });
  const r = R.maak(Object.assign({ dir: L.dir }, stubs()));
  await r.ronde();
  assert.equal(L.db.prepare('SELECT status FROM router_stuk WHERE stuk_id = ?').get(id).status, 'vastgehouden');
  assert.equal(r.telling('2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z').marker_alleen_router, 1);
  assert.ok(!/ZWAARDVIS/.test(JSON.stringify(L.db.prepare('SELECT * FROM besluit').all())));
  r.sluit();
});

test('origineel ontbreekt op de pod: eigen status, geen marker- of routerstap', async () => {
  const L = logboek();
  const id = L.zet({ bron: 'scanner:scansnap', profiel: 'scansnap@1', delen: [{ rol: 'origineel', mime: 'application/pdf', bytes: FACTUUR_PDF }] });
  for (const d of fs.readdirSync(path.join(L.dir, 'blob'))) fs.rmSync(path.join(L.dir, 'blob', d), { recursive: true });
  const r = R.maak(Object.assign({ dir: L.dir }, stubs()));
  await r.ronde();
  assert.equal(L.db.prepare('SELECT status FROM router_stuk WHERE stuk_id = ?').get(id).status, 'origineel_ontbreekt');
  assert.deepEqual(L.db.prepare('SELECT stap FROM besluit WHERE stuk_id = ?').all(id).map((x) => x.stap), ['ontvangst', 'lokale_tekst']);
  assert.equal(r.telling('2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z').origineel_ontbreekt, 1);
  r.sluit();
});

test('kennislens: entiteit redelijk alleen is niet genoeg (herhaling: 53 %), hoog of het routelabel wel', () => {
  const b = (k, l) => K.bestemmingen({ soort: 'correspondentie', kracht: 'redelijk' }, { kracht: 'redelijk' }, { knoop: 'TG', kracht: k }, { velden: [], label_entiteit: l })[0].zou_auto;
  assert.equal(b('redelijk', null), false); assert.equal(b('hoog', null), true); assert.equal(b('zwak', 'TG'), true);
});
