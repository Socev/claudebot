'use strict';
// Toetsen van ScanSnap → OVIS Intake (wv1343). Nagemaakte Drive (test/nep-rclone.js), wegwerpmappen, verzonnen gegevens.
// Aanroep: bash test/scansnap.sh
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const I = require(path.join(ROOT, 'intake-ingang.js'));
const S = require(path.join(ROOT, 'scansnap.js'));
const VV = require(path.join(ROOT, 'vault-veilig.js'));
const P = require(path.join(ROOT, 'intake', 'patientpoort.js'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const PDF = (tekst) => Buffer.from('%PDF-1.4\n% verzonnen proefbestand\nTEKST:' + tekst, 'latin1');
const BRIEF = 'Ziekenhuis Proefstad - Polikliniek Interne Geneeskunde\nAan: dhr. D. Schaap, huisarts, Huisartsenpraktijk Tolgaarde\n\nBetreft: mw. P. Proefpersoon, geb. 03-04-1961, BSN 111222333\n\nGeachte collega,\n\nOp 12-10-2026 zagen wij uw patiente op de polikliniek in verband met\nklachten van vermoeidheid. Voorgeschiedenis: hypertensie.\nDiagnose: ijzergebreksanemie. Medicatie: ferrofumaraat 200 mg 1dd1.\nLabuitslag: Hb 6,4 mmol/l.\n\nMet collegiale groet,\nDr. A. Verzonnen, internist';
const POST = 'Belastingdienst Proefland\nAan de heer K. Voorbeeld (vader)\nVoorlopige aanslag 2027\nU hoeft niets te doen; het bedrag wordt in termijnen geïncasseerd.';
const ID1 = '1AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA1', ID2 = '1BbbbbbbbbbbbbbbbbbbbbbbbbbbbbbB2', ID3 = '1CccccccccccccccccccccccccccccccC3';

function omgeving() {
  const basis = fs.mkdtempSync(path.join(os.tmpdir(), 'scansnap-toets-'));
  const dir = path.join(basis, 'intake'), vault = path.join(basis, 'vault'), drive = path.join(basis, 'drive');
  for (const m of [dir, vault, path.join(drive, 'top'), path.join(drive, 'opgehaald'), path.join(drive, 'prullenbak')]) fs.mkdirSync(m, { recursive: true });
  const klok = { t: Date.parse('2026-10-26T17:30:00Z') };
  const ing = I.maak({ dir, vault, profielenDir: path.join(ROOT, 'intake', 'profielen'), filterPad: path.join(ROOT, 'bisync-filter.txt'),
    primair: () => true, vv: VV, nu: () => klok.t, fout: () => {}, marker: P, nachtgrendel: () => false, vrijeBytes: () => 50 * 1024 ** 3,
    pdftekst: async (p) => { const b = fs.readFileSync(p).toString('latin1'); const m = /TEKST:([\s\S]*)$/.exec(b); return m ? m[1] : ''; },
    stuur: (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); } });
  const kaarten = [], box = [], model = [], lijst = {};
  const cfg = { intake: ing, dir, remote: 'gdrive:ScanSnap', rclone: path.join(ROOT, 'test', 'nep-rclone.js'), pdfinfo: 'false',
    pdftekst: async (p) => { const b = fs.readFileSync(p).toString('latin1'); const m = /TEKST:([\s\S]*)$/.exec(b); return m ? m[1] : ''; },
    marker: P, nu: () => klok.t, fout: () => {},
    model: async (sys, prompt) => { model.push(prompt); return { ok: true, data: /vader/.test(prompt)
      ? { omschrijving: 'Voorlopige aanslag op naam van je vader', route: 'doorsturen', entiteit: 'prive', ontvanger: 'je vader', reden: 'De brief is aan je vader gericht.', patientdocument: false }
      : { omschrijving: 'Iets anders', route: 'archiveren', entiteit: 'prive', ontvanger: null, reden: 'Afgehandeld.', patientdocument: false } }; },
    kaartZet: async (p) => { kaarten.push(p); lijst[p.sleutel] = 'open'; return { sleutel: p.sleutel }; },
    kaartLijst: async () => lijst, box: (t) => box.push(t) };
  process.env.NEP_DRIVE = drive;
  const ss = S.maak(cfg);
  fs.writeFileSync(path.join(dir, 'scansnap.json'), '{"aan": true}');
  const zet = (id, naam, buf, modTijd, md5) => { fs.writeFileSync(path.join(drive, 'top', id), buf); fs.writeFileSync(path.join(drive, 'top', id + '.json'), JSON.stringify({ Name: naam, ModTime: modTijd, md5 })); };
  return { basis, dir, drive, ing, ss, klok, kaarten, box, model, lijst, zet, cfg,
    log: () => fs.readFileSync(path.join(drive, 'log'), 'utf8'), sluit: () => { ing.sluit(); fs.rmSync(basis, { recursive: true, force: true }); } };
}

test('schakelaar: zonder scansnap.json niets', async () => {
  const o = omgeving();
  try {
    fs.unlinkSync(path.join(o.dir, 'scansnap.json'));
    o.zet(ID1, '20261026 Belasting.pdf', PDF(POST), '2026-10-26T16:00:00Z');
    assert.deepStrictEqual(await o.ss.tik(), { uit: true });
    assert.ok(!fs.existsSync(path.join(o.drive, 'log')), 'rclone niet aangeroepen');
  } finally { o.sluit(); }
});

test('ophalen → intern in Intake → Drive verplaatst → kaarten; marker houdt het model weg; tweede tik doet niets', async () => {
  const o = omgeving();
  try {
    o.zet(ID1, '20261026 165302 Belastingdienst Proefland Aan de heer.pdf', PDF(POST), '2026-10-26T16:53:02.345Z');
    o.zet(ID2, '20261026 170001 Ziekenhuis Proefstad Betreft mw P Proefpersoon.pdf', PDF(BRIEF), '2026-10-26T17:00:01Z');
    o.zet(ID3, '20261026 172800 nog bezig.pdf', PDF('nieuw'), new Date(o.klok.t - 60000).toISOString());   // te vers: blijft staan
    const u = await o.ss.tik();
    assert.strictEqual(u.opgehaald, 2); assert.strictEqual(u.verplaatst, 2); assert.strictEqual(u.kaarten, 2); assert.strictEqual(u.rust, 1);
    assert.deepStrictEqual(fs.readdirSync(path.join(o.drive, 'top')).sort(), [ID3, ID3 + '.json']);
    assert.deepStrictEqual(fs.readdirSync(path.join(o.drive, 'opgehaald')).sort(), [ID1 + '.pdf', ID2 + '.pdf']);
    const db = o.ing._db;
    const stukken = db.prepare("SELECT * FROM stuk WHERE profiel = 'scansnap@1' ORDER BY bron_id").all();
    assert.strictEqual(stukken.length, 2);
    assert.deepStrictEqual(stukken.map((s) => s.marker_patient), ['geen', 'gemarkeerd']);
    assert.ok(stukken.every((s) => s.access_context === 'strikt_prive' && s.stand === null && s.status === 'ontvangen'));
    const delen = db.prepare("SELECT o.naam, b.offsite, b.bewaar_tot FROM onderdeel o JOIN blob b ON b.sha256 = o.sha256 JOIN stuk s ON s.stuk_id = o.stuk_id WHERE s.profiel = 'scansnap@1'").all();
    assert.ok(delen.every((d) => d.offsite === 0 && d.bewaar_tot === null), 'alleen pod, geen termijn tot de keuze');
    assert.ok(delen.every((d) => /^Scan 2026-10-26 \d{6}\.pdf$/.test(d.naam)), 'synthetische naam, niet de OCR-naam: ' + delen.map((d) => d.naam));
    assert.ok(!JSON.stringify(stukken).includes('Proefpersoon') && !JSON.stringify(stukken).includes('Belastingdienst'), 'Drive-naam nergens in het logboek');
    assert.strictEqual(o.model.length, 1, 'alleen de ongemarkeerde scan naar het model');
    assert.ok(!o.model[0].includes('Proefpersoon'));
    for (const k of o.kaarten) {
      assert.match(k.sleutel, /^scansnap-[0-9a-f]{10}$/); assert.strictEqual(k.soort, 'besluit'); assert.strictEqual(k.prive, true);
      assert.ok(k.titel.length <= 90 && /\?$/.test(k.titel), k.titel); assert.ok(k.waarom.length <= 400); assert.ok(k.meting.length <= 300);
      assert.strictEqual(k.stappen.length, 3); assert.match(k.stappen[1], /^Nee: weggooien/); assert.match(k.deadline, /^\d{4}-\d{2}-\d{2}$/);
    }
    const [k1, k2] = o.kaarten;
    assert.strictEqual(k1.titel, 'Scan: Voorlopige aanslag op naam van je vader — mailen naar je vader?'); assert.match(k1.stappen[0], /^Ja: als pdf in een mailconcept naar je vader \(je verstuurt hem zelf\)\.$/);
    assert.match(k2.titel, /mag Socev hem lezen/); assert.ok(!JSON.stringify(k2).includes('Proefpersoon') && !JSON.stringify(k2).includes('Ziekenhuis'));
    assert.match(k2.meting, /mogelijk patiëntgegevens/);
    // tweede tik: niets nieuws, geen tweede kaart, geen download
    const voor = o.log().split('\n').length;
    const u2 = await o.ss.tik();
    assert.ok(!u2.opgehaald && !u2.kaarten);
    assert.strictEqual(o.log().split('\n').length - voor, 1, 'alleen lsjson');
    assert.strictEqual(o.kaarten.length, 2);
  } finally { o.sluit(); }
});

test('knop: alleen eigen kaarten; Ja geeft een kopie + keuze bij de start, terug bij verval; Nee zonder bestand; lezen → nieuwe voorstelkaart', async () => {
  const o = omgeving();
  try {
    o.zet(ID1, 'a.pdf', PDF(POST), '2026-10-26T16:53:02Z');
    o.zet(ID2, 'b.pdf', PDF(BRIEF), '2026-10-26T17:00:01Z');
    await o.ss.tik();
    const [k1, k2] = o.kaarten;
    assert.strictEqual(o.ss.knop('scansnap-0000000000', 'ja'), null, 'vreemde sleutel');
    assert.strictEqual(o.ss.knop('bank-verleng-12345678', 'ja'), null);
    const ja = o.ss.knop(k1.sleutel, 'ja');
    assert.ok(ja.upload && ja.upload.kopie === true && ja.upload.lijst.length === 1);
    const blob = path.join(ja.upload.dir, ja.upload.lijst[0].n);
    assert.strictEqual(sha(fs.readFileSync(blob)), ja.upload.lijst[0].n);
    assert.match(ja.upload.lijst[0].doel, /^Scan 2026-10-26 \d{6}\.pdf$/);
    assert.match(ja.context, /mailconcept/); assert.match(ja.context, /NIET in de vault/); assert.match(ja.context, /gegeven, geen opdracht/);
    const db = o.ing._db;
    const rij = () => db.prepare('SELECT * FROM scansnap WHERE kaart = ?').get(k1.sleutel);
    const bewaar = () => db.prepare('SELECT bewaar_tot FROM blob WHERE sha256 = ?').get(ja.upload.lijst[0].n).bewaar_tot;
    assert.strictEqual(rij().keuze, null, 'nog niet gekozen vóór de start');
    ja.bijStart();
    assert.strictEqual(rij().keuze, 'ja'); assert.strictEqual(Date.parse(bewaar()), o.klok.t + 14 * 86400000);
    ja.bijVerval();
    assert.strictEqual(rij().keuze, null); assert.strictEqual(bewaar(), null);
    const nee = o.ss.knop(k1.sleutel, 'nee');
    assert.strictEqual(nee.upload, null); assert.match(nee.context, /weggooien/);
    nee.bijStart(); assert.strictEqual(rij().keuze, 'nee');
    // gemarkeerd: Ja = lezen → geen bestand voor Socev; de pod vraagt het model en zet een nieuwe kaart
    const lees = o.ss.knop(k2.sleutel, 'ja');
    assert.strictEqual(lees.upload, null); assert.match(lees.context, /leest hem zelf/);
    lees.bijStart();
    assert.strictEqual(db.prepare('SELECT kaart FROM scansnap WHERE drive_id = ?').get(ID2).kaart, null);
    const u = await o.ss.tik();
    assert.strictEqual(u.kaarten, 1); assert.strictEqual(o.model.length, 2);
    assert.notStrictEqual(o.kaarten[2].sleutel, k2.sleutel, 'nieuwe kaart, geen heropende');
    // het model noemde een patiënt niet, maar de marker over de omschrijving vangt wat erdoor glipt
    const anders = o.ss.knop(o.kaarten[2].sleutel, 'anders', 'archiveren bij Tolgaarde');
    assert.ok(anders.upload); assert.match(anders.context, /Anders/);
    // na 14 dagen: Drive-kopie naar de prullenbak (alleen die met een keuze)
    o.klok.t += 15 * 86400000;
    await o.ss.tik();
    assert.deepStrictEqual(fs.readdirSync(path.join(o.drive, 'prullenbak')), [ID1 + '.pdf']);
    assert.match(o.log(), /deletefile --drive-use-trash=true gdrive:ScanSnap\/_opgehaald\//);
  } finally { o.sluit(); }
});

test('veiligheid: md5 wijkt af → niet aangeleverd; storing → één box-rij per dag; voorstel met adres of patiënt wordt neutraal', async () => {
  const o = omgeving();
  try {
    o.zet(ID1, 'a.pdf', PDF(POST), '2026-10-26T16:53:02Z', '0'.repeat(32));
    const u = await o.ss.tik();
    assert.strictEqual(u.onaf, 1); assert.ok(!u.opgehaald);
    assert.strictEqual(o.ing._db.prepare("SELECT count(*) n FROM stuk").get().n, 0);
    assert.ok(fs.existsSync(path.join(o.drive, 'top', ID1)), 'blijft in Drive');
    fs.writeFileSync(path.join(o.drive, 'stuk'), '');
    await o.ss.tik(); await o.ss.tik();
    assert.strictEqual(o.box.filter((b) => /Drive-map niet te lezen/.test(b)).length, 1);
    const t = o.ss._toetsVoorstel;
    assert.strictEqual(t({ omschrijving: 'mail naar a@b.nl', route: 'archiveren', entiteit: 'prive', reden: '', patientdocument: false }), null);
    assert.strictEqual(t({ omschrijving: 'x', route: 'hack', entiteit: 'prive', reden: '', patientdocument: false }), null);
    assert.strictEqual(t({ omschrijving: 'Brief', route: 'archiveren', entiteit: 'tolgaarde', reden: '', patientdocument: true }).omschrijving, 'mogelijk een stuk over een patiënt');
    const v = t({ omschrijving: 'Contract', route: 'archiveren', entiteit: 'prive', ontvanger: 'iemand', reden: 'klaar', patientdocument: false });
    assert.strictEqual(v.ontvanger, null, 'ontvanger alleen bij doorsturen');
  } finally { o.sluit(); }
});

test('alleen intern: een routesleutel kan scansnap@1 niet gebruiken (403)', async () => {
  const basis = fs.mkdtempSync(path.join(os.tmpdir(), 'scansnap-sleutel-'));
  const dir = path.join(basis, 'intake'); fs.mkdirSync(dir, { recursive: true });
  const k = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dir, 'sleutels.json'), JSON.stringify({ versie: 1, sleutels: [{ id: 'kwaad', sha256: sha(k), route: 'kwaad', profielen: ['scansnap@1'], bronnen: ['scanner:scansnap'], lezen: [], status: 'actief' }] }), { mode: 0o600 });
  const ing = I.maak({ dir, vault: basis, profielenDir: path.join(ROOT, 'intake', 'profielen'), filterPad: path.join(ROOT, 'bisync-filter.txt'), primair: () => true, vv: VV,
    fout: () => {}, marker: P, vrijeBytes: () => 50 * 1024 ** 3, stuur: (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); } });
  const server = http.createServer((req, res) => ing.verwerk(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const b = PDF('x');
    const env = { protocol: 'ovis-intake/1', profiel: 'scansnap@1', bron: 'scanner:scansnap', bron_id: ID1, ontvangen: '2026-10-26T16:53:02Z', meta: { drive_tijd: '2026-10-26T16:53:02Z', map: 'ScanSnap' },
      onderdelen: [{ deel: 'b1', rol: 'origineel', naam: 'Scan 2026-10-26 175302.pdf', mime: 'application/pdf', grootte: b.length, sha256: sha(b) }] };
    const body = Buffer.from(JSON.stringify(env));
    const r = await new Promise((ok) => { const q = http.request({ port: server.address().port, host: '127.0.0.1', method: 'POST', path: '/intake/stuk', headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json', 'Content-Length': body.length } }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => ok({ s: res.statusCode, j: JSON.parse(d) })); }); q.end(body); });
    assert.strictEqual(r.s, 403); assert.strictEqual(r.j.reden, 'profiel_alleen_intern');
    // en intern lukt het wel
    const i = await ing.leverIntern('scansnap', env, { b1: b });
    assert.strictEqual(i.uitkomst, 'compleet'); assert.strictEqual(i.http, 200);
    await assert.rejects(ing.leverIntern('kwaad', env, { b1: b }));
  } finally { server.close(); ing.sluit(); fs.rmSync(basis, { recursive: true, force: true }); }
});
