'use strict';
// Toetsen voor OVIS Intake stap 3d (wv1919): facturenlens via de koerier, keten-signaal, deadlines als voorstel, knoop_id, twijfel die al in
// de Facturen-app staat. Alle toetsdata is verzonnen (de repo is openbaar). Aanroep: bash test/intake-router.sh
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const R = require('../intake-router.js');
const K = R.K;
const poort = require('../intake/patientpoort.js');
const VV = require('../vault-veilig.js');

const TG = { o: 'o-tg', k: 'TG', naam: 'Huisartsenpraktijk Testgaarde', eigen: true, soort: 'entiteit', status: 'actief', concept: false, voor: [] };
const ORG = { o: 'o-org', k: 'org:voorbeeld-energie', naam: 'Voorbeeld Energie BV', eigen: false, soort: 'organisatie', status: 'actief', concept: false, voor: ['TG'] };
const ORG2 = { o: 'o-org2', k: 'org:tweede-energie', naam: 'Tweede Energie BV', eigen: false, soort: 'organisatie', status: 'actief', concept: false, voor: [] };
const HANDVATTEN = { compilatienummer: 9, entiteiten: [TG, ORG, ORG2], niet_dezelfde: [],
  ids: [{ o: 'o-org', ns: 'kvk', v: '12345678', st: 'actief' }, { o: 'o-org', ns: 'domein', v: 'voorbeeld-energie.example', st: 'actief' },
    { o: 'o-org2', ns: 'kvk', v: '87654321', st: 'voorgesteld' }, { o: 'o-org2', ns: 'domein', v: 'gedeeld.example', st: 'actief' }, { o: 'o-org', ns: 'domein', v: 'gedeeld.example', st: 'actief' },
    { o: 'o-tg', ns: 'kvk', v: '11112222', st: 'actief' }, { o: 'o-tg', ns: 'alias', v: 'testgaarde', st: 'actief' }] };
const DEADLINES = '---\ntype: register\n---\n\n# Deadlines\n\n## Actueel\n\n| Datum | Entiteit | Wat | Actie | Signaleer | Bron |\n|---|---|---|---|---|---|\n| 2026-12-01 | Tolgaarde | **Proefregel** | x | 3 | [[00_Systeem/Proef\\|Proef]] |\n\n## Kandidaten (datum nog te achterhalen)\n\n- iets\n\n## Afgehandeld\n\n| a | b |\n|---|---|\n';
const FACTUUR = ['Factuur', 'Voorbeeld Energie BV', 'Factuurnummer: VE-2026-1001', 'Factuurdatum: 15-10-2026', 'Vervaldatum: 14-11-2026', 'Totaal te betalen: € 123,45',
  'IBAN NL91 ABNA 0417 1643 00', 'KvK 12345678', 'www.voorbeeld-energie.example'];
const AANMANING = 'Geachte heer Schaap,\n\nAanmaning\nDossiernummer: D-778899\nVervaldatum: 20-11-2026\nOndanks onze herinnering ontvingen wij geen betaling. KvK 12345678 www.voorbeeld-energie.example\nIBAN NL91 ABNA 0417 1643 00\n\nMet vriendelijke groet,\nIncasso afdeling (verzonnen)';

// "pdf" = '%PDF-1.4\n' + regels; pdfBbox maakt er woorden met positie van (één regel per y)
function pdfVan(regels) { return '%PDF-1.4\n' + regels.join('\n'); }
function bbox(t) {
  if (t.indexOf('%PDF-1.4\n') !== 0) return '<page></page>';
  const r = t.slice(9).split('\n');
  return '<page>' + r.map(function (z, i) { return z.split(' ').map(function (w, j) { return '<word xMin="' + (10 + j * 60) + '" yMin="' + (10 + i * 20) + '" xMax="' + (60 + j * 60) + '" yMax="' + (20 + i * 20) + '">' + w.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</word>'; }).join(''); }).join('') + '</page>';
}
function omgeving(extra) {
  const basis = fs.mkdtempSync(path.join(os.tmpdir(), 'wv1919-'));
  const dir = path.join(basis, 'intake'), vault = path.join(basis, 'vault');
  fs.mkdirSync(dir, { recursive: true });
  for (const m of Object.values(K.KENNIS_MAP)) fs.mkdirSync(path.join(vault, m), { recursive: true });
  fs.mkdirSync(path.join(vault, '00_Systeem'), { recursive: true });
  fs.writeFileSync(path.join(vault, K.DL_PAD), DEADLINES);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'intake.sqlite'));
  db.exec(`CREATE TABLE stuk (stuk_id TEXT PRIMARY KEY, bron TEXT NOT NULL, bron_id TEXT NOT NULL, profiel TEXT NOT NULL, versie INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL,
    aangemaakt TEXT NOT NULL, compleet_op TEXT, meta TEXT NOT NULL, marker_patient TEXT, marker_soorten TEXT, marker_versie TEXT, marker_op TEXT);
    CREATE TABLE onderdeel (stuk_id TEXT NOT NULL, deel TEXT NOT NULL, rol TEXT NOT NULL, naam TEXT NOT NULL, mime TEXT NOT NULL, grootte INTEGER NOT NULL, sha256 TEXT NOT NULL, meta TEXT, PRIMARY KEY (stuk_id, deel));
    CREATE TABLE vrij_veld (stuk_id TEXT NOT NULL, nr INTEGER NOT NULL, omschrijving TEXT NOT NULL, waarde TEXT, deel TEXT, PRIMARY KEY (stuk_id, nr));`);
  let n = 0;
  const klok = { t: Date.parse('2026-10-31T20:00:00Z') };
  const zet = function (x) {
    const id = 'stk_20261031_' + String(++n).padStart(8, '0');
    db.prepare('INSERT INTO stuk (stuk_id, bron, bron_id, profiel, status, aangemaakt, compleet_op, meta, marker_patient, marker_soorten, marker_versie, marker_op) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, 'gmail:david', 'a' + String(n).padStart(15, '0'), 'mail@1', 'router', '2026-10-31T19:5' + n + ':00Z', '2026-10-31T19:5' + n + ':00Z', JSON.stringify(x.meta || {}), x.marker || 'geen', JSON.stringify(x.soorten || []), 'patientpoort-2.0', '2026-10-31T19:59:00Z');
    (x.delen || []).forEach(function (d, i) {
      const b = Buffer.from(d.bytes);
      const sha = crypto.createHash('sha256').update(b).digest('hex');
      fs.mkdirSync(path.join(dir, 'blob', sha.slice(0, 2)), { recursive: true });
      fs.writeFileSync(path.join(dir, 'blob', sha.slice(0, 2), sha), b);
      db.prepare('INSERT INTO onderdeel (stuk_id, deel, rol, naam, mime, grootte, sha256, meta) VALUES (?,?,?,?,?,?,?,?)').run(id, d.deel || ('d' + i), d.rol, d.naam || 'x', d.mime, b.length, sha, null);
    });
    return id;
  };
  const tel = { jev: [], indeling: [], kaarten: [], betaling: [], melding: [] };
  const bekend = new Set();
  const o = Object.assign({ dir, vault, vv: VV, nu: () => klok.t, marker: poort,
    pdfBbox: async function (p) { return bbox(fs.readFileSync(p, 'utf8')); }, ocr: async function () { return null; }, docx: async function () { return null; }, paginas: async function () { return 1; },
    handvatten: async function () { return HANDVATTEN; }, eigenAdressen: function () { return ['david@voorbeeld.example']; },
    live: function () { return { 'gmail:david': true }; }, lenzenLive: function () { return ['kennis', 'geen', 'systeem', 'facturen', 'keten', 'deadlines']; },
    jev: async function (x) { tel.jev.push(x.tekst); return { ref: x.ref, gemeten: true, injectie_kans: 0.02, aanspreking: false }; },
    indeling: async function (x) { tel.indeling.push(x.tekst); return { ok: true, categorie: 'Huisartsenpraktijk Tolgaarde' }; },
    naamOk: function (nm) { return !/[\\/:*?"<>|]/.test(nm); }, vaultPauze: function () { return false; }, bewaarNa: function () { return 1; },
    datum: function () { return '2026-10-31'; },
    kaartZet: async function (p) { tel.kaarten.push(p); return { sleutel: p.sleutel }; },
    kaartStatus: async function () { return { ok: true }; }, kaartOpen: async function () { return []; },
    melding: function (t) { tel.melding.push(t); },
    facturenKent: function (shas) { return new Set(shas.filter(function (s) { return bekend.has(s); })); },
    ketenBetaling: async function (x) { tel.betaling.push(x); return { gevonden: false, bank_tot: '2026-10-30', nagekeken: 'entiteit', prive: false }; },
  }, extra || {});
  const r = R.maak(o);
  const bestanden = function () { const uit = []; (function loop(d) { for (const nm of fs.readdirSync(d)) { const f = path.join(d, nm); if (fs.statSync(f).isDirectory()) loop(f); else uit.push(path.relative(vault, f)); } })(vault); return uit.filter((f) => f !== K.DL_PAD).sort(); };
  const dl = function () { return fs.readFileSync(path.join(vault, K.DL_PAD), 'utf8'); };
  const best = function (id) { return E2(db.prepare('SELECT lens, status, zou_auto, reden FROM bestemming WHERE stuk_id = ? ORDER BY lens').all(id)); };
  const staat = function (id) { return db.prepare('SELECT staat FROM live_stuk WHERE stuk_id = ?').get(id).staat; };
  return { basis, dir, vault, db, zet, r, tel, klok, bestanden, dl, best, staat, bekend };
}
function E2(rijen) { return rijen.map((b) => b.lens + ':' + b.status + (b.zou_auto ? ':auto' : '') + (b.reden ? ':' + b.reden : '')); }
function mail(van, onderwerp, tekst) { return 'From: ' + van + '\r\nSubject: ' + onderwerp + '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + tekst; }
const META = { van: 'facturen@voorbeeld-energie.example', van_naam: 'Voorbeeld Energie', aan: ['david@voorbeeld.example'], verzonden: '2026-10-31T18:30:00Z' };

test('kern 3d: datum, kenmerken, IBAN, ketenkaart (grenzen, nooit "onbetaald"), deadline-regel en invoegen', () => {
  assert.equal(K.datumIso('14-11-2026'), '2026-11-14'); assert.equal(K.datumIso('1/2/27'), '2027-02-01'); assert.equal(K.datumIso('2026-11-30'), '2026-11-30');
  assert.equal(K.datumIso('3 november 2026'), '2026-11-03'); assert.equal(K.datumIso('31-02-2026'), null); assert.equal(K.datumIso('14-11-1890'), null); assert.equal(K.datumIso('morgen'), null);
  assert.deepEqual(K.ketenKenmerken([{ veld: 'kenmerk', waarde: 'AB1', letterlijk: true }, { veld: 'dossiernummer', waarde: 'D-778899', letterlijk: true }, { veld: 'factuurnummer', waarde: 'F-1234', letterlijk: false }]),
    [{ soort: 'dossiernummer', waarde: 'D-778899' }]);
  assert.deepEqual(K.ibansIn('IBAN NL91 ABNA 0417 1643 00 en NL00ABNA0000000000 fout'), ['NL91ABNA0417164300']);
  const k = K.ketenKaart({ stuk_id: 'stk_20261031_00000001', afzender: 'Voorbeeld Energie BV '.repeat(5), kenmerk: 'D-778899', ontvangen: '2026-10-31T18:30:00Z', bank_tot: '2026-10-30', prive: true });
  assert.equal(k.sleutel, 'intake-keten-20261031-00000001');
  assert.ok(k.titel.length <= 90 && k.waarom.length <= 400, k.titel.length + '/' + k.waarom.length);
  assert.match(k.waarom, /open en geëscaleerd, geen betaling gevonden — bank bijgewerkt tot 30-10-2026/); assert.match(k.waarom, /zakelijke rekeningen/);
  assert.ok(!/onbetaald/i.test(JSON.stringify(k)));
  assert.ok(k.stappen.every((s) => s.length <= 400 && !/\.md\b|\/opt\//.test(s)));
  const regel = K.deadlineRegel({ datum: '2026-11-14', entiteit: 'TG', wat: 'factuur', afzender: 'A | B', kenmerk: 'X', stuk_id: 'stk_20261031_00000001', ontvangen: '2026-10-31T18:30:00Z', vindplaats: { naam: 'f.pdf', regel: 5 } });
  assert.equal(regel.split(' | ').length, 6, 'zes kolommen (pipe uit de afzender weg)');
  assert.match(regel, /^\| 2026-11-14 \| Tolgaarde \| \*\*Vervaldatum factuur van A B\*\* \(kenmerk X\) — voorstel van OVIS Intake, stuk stk_20261031_00000001, ontvangen 31-10-2026; vindplaats: "f\.pdf", regel 5 \| Voorstel:/);
  const n = K.deadlineInvoegen(DEADLINES, regel, 'stk_20261031_00000001');
  const r = n.split('\n');
  assert.equal(r[r.indexOf('| 2026-12-01 | Tolgaarde | **Proefregel** | x | 3 | [[00_Systeem/Proef\\|Proef]] |') + 1], regel, 'onder de laatste rij van Actueel');
  assert.ok(n.indexOf(regel) < n.indexOf('## Kandidaten'));
  assert.equal(K.deadlineInvoegen(n, regel, 'stk_20261031_00000001'), null, 'tweede keer niets');
  assert.throws(() => K.deadlineInvoegen('# leeg\n', regel, 'stk_x'), /Actueel ontbreekt/);
});

test('3d: verzonden factuur (afzender hoog) → facturenlens aangeboden voor de koerier, geen kennisbestand; uitkomst → bevestigd; deadline via de Facturen-app', async () => {
  const E = omgeving();
  const id = E.zet({ meta: Object.assign({ onderwerp: 'Uw factuur oktober' }, META), delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: mail(META.van, 'Uw factuur oktober', 'Beste klant, bijgaand de factuur. Groet') },
    { deel: 'b1', rol: 'bijlage', naam: 'factuur-VE-2026-1001.pdf', mime: 'application/pdf', bytes: pdfVan(FACTUUR) }] });
  const u = await E.r.ronde();
  assert.equal(u.verwerkt, 1, JSON.stringify(u));
  const sam = JSON.parse(E.db.prepare('SELECT samenvatting FROM router_stuk WHERE stuk_id = ?').get(id).samenvatting);
  assert.equal(sam.soort, 'bewijsstuk'); assert.equal(sam.soort_kracht, 'hoog'); assert.equal(sam.afzender_kracht, 'hoog');
  assert.deepEqual(E.best(id), ['deadlines:bevestigd:auto', 'facturen:aangeboden:auto']);
  assert.equal(E.db.prepare("SELECT uitkomst FROM uitvoering WHERE stuk_id = ? AND lens = 'deadlines'").get(id).uitkomst, 'via_facturen_app');
  assert.deepEqual(E.bestanden(), [], 'geen raw_input: de factuur gaat naar de Facturen-app');
  assert.ok(E.dl().indexOf(id) < 0, 'geen dubbele deadline naast de Facturen-app');
  assert.equal(E.staat(id), 'automatisch', 'wacht op de koerier');
  const a = await E.r.facturenAangeboden(10);
  assert.equal(a.length, 1); assert.equal(a[0].stuk_id, id); assert.equal(a[0].bron_id, 'a000000000000001'); assert.equal(a[0].dkim, 'geen_uitslag');
  assert.equal(a[0].documenten.length, 1); assert.equal(a[0].documenten[0].bytes.toString(), pdfVan(FACTUUR)); assert.equal(a[0].jev, 'onder'); assert.equal(a[0].mailtekst, null);
  // nog een ronde: de router voert de facturenlens zelf niet uit
  await E.r.ronde();
  assert.equal(E.db.prepare("SELECT status FROM bestemming WHERE stuk_id = ? AND lens = 'facturen'").get(id).status, 'aangeboden');
  assert.deepEqual(E.r.facturenUitkomst(id, 1, { ok: true, uitkomst: 'facturen:1' }), { ok: true });
  assert.deepEqual(E.best(id), ['deadlines:bevestigd:auto', 'facturen:bevestigd:auto']);
  assert.deepEqual(E.db.prepare("SELECT uitkomst, door FROM uitvoering WHERE stuk_id = ? AND lens = 'facturen'").all(id).map((x) => x.uitkomst + '/' + x.door), ['facturen:1/koerier']);
  assert.equal(E.staat(id), 'klaar');
  assert.deepEqual(await E.r.facturenAangeboden(10), []);
  assert.equal(E.r.facturenUitkomst(id, 1, { ok: true }).fout, 'niet_aangeboden');
  // knoop_id: KvK → precies één organisatie (nooit een eigen entiteit, voorgesteld telt niet); domein gedeeld door twee → twijfel
  assert.equal(await E.r.knoopVoor({ kvk: '12345678' }), 'org:voorbeeld-energie');
  assert.equal(await E.r.knoopVoor({ domein: 'facturen.voorbeeld-energie.example' }), 'org:voorbeeld-energie');
  assert.equal(await E.r.knoopVoor({ kvk: '12345678', domein: 'gedeeld.example' }), null);
  assert.equal(await E.r.knoopVoor({ kvk: '87654321' }), null);
  assert.equal(await E.r.knoopVoor({ kvk: '11112222' }), null);
  assert.equal(await E.r.knoopVoor({}), null);
  E.r.sluit();
});

test('3d: een vastgehouden stuk komt nooit bij de koerier (ook niet met factuurbijlage); koerier-fout telt pogingen, na 5 terug naar David', async () => {
  const E = omgeving();
  const vast = E.zet({ marker: 'gemarkeerd', soorten: ['brieftaal'], meta: Object.assign({ onderwerp: 'Factuur zorg' }, META),
    delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: mail(META.van, 'Factuur zorg', 'Geachte collega, bovengenoemde patiënt. Verzonnen.') },
      { deel: 'b1', rol: 'bijlage', naam: 'f.pdf', mime: 'application/pdf', bytes: pdfVan(FACTUUR.concat(['vast'])) }] });
  const id = E.zet({ meta: Object.assign({ onderwerp: 'Factuur november' }, META), delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: mail(META.van, 'Factuur november', 'Bijgaand.') },
    { deel: 'b1', rol: 'bijlage', naam: 'f2.pdf', mime: 'application/pdf', bytes: pdfVan(FACTUUR.concat(['nov'])) }] });
  await E.r.ronde();
  assert.equal(E.staat(vast), 'vastgehouden');
  assert.equal(E.db.prepare('SELECT count(*) n FROM bestemming WHERE stuk_id = ?').get(vast).n, 0);
  // zelfs met een (onterecht) aangeboden bestemming: de selectie eist een beoordeeld stuk
  E.db.prepare("INSERT INTO bestemming (stuk_id, versie, lens, doel, zou_auto, reden, status, tijd) VALUES (?, 1, 'facturen', 'TG', 1, NULL, 'aangeboden', '2026-10-31T20:00:00Z')").run(vast);
  const a = await E.r.facturenAangeboden(10);
  assert.deepEqual(a.map((x) => x.stuk_id), [id]);
  assert.equal(E.tel.jev.length, 1, 'Jev alleen voor het gewone stuk');
  for (let i = 0; i < 5; i++) E.r.facturenUitkomst(id, 1, { ok: false, code: 'pdftotext' });
  assert.deepEqual(E.best(id).filter((b) => /^facturen/.test(b)), ['facturen:schaduw:uitvoeren_mislukt:pdftotext']);
  assert.equal(E.staat(id), 'twijfel');
  assert.equal(E.tel.melding.length, 1);
  E.r.sluit();
});

test('3d: factuur van een onbekende afzender → twijfel; staat de pdf al in de Facturen-app, dan bevestigt de router zelf (al_in_facturen); anders kiest David', async () => {
  const E = omgeving();
  const M = Object.assign({}, META, { van: 'boekhouding@onbekend.example', onderwerp: 'Factuur 7' });
  const regels = ['Factuur', 'Onbekend BV', 'Factuurnummer: OB-7', 'Factuurdatum: 15-10-2026', 'Vervaldatum: 14-11-2026', 'Totaal te betalen: € 9,95', 'KvK 99990000'];
  const id = E.zet({ meta: M, delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: mail(M.van, 'Factuur 7', 'Bijgaand.') }, { deel: 'b1', rol: 'bijlage', naam: 'f7.pdf', mime: 'application/pdf', bytes: pdfVan(regels) }] });
  const id2 = E.zet({ meta: Object.assign({}, M, { onderwerp: 'Factuur 8' }), delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: mail(M.van, 'Factuur 8', 'Bijgaand.') },
    { deel: 'b1', rol: 'bijlage', naam: 'f8.pdf', mime: 'application/pdf', bytes: pdfVan(regels.concat(['acht'])) }] });
  await E.r.ronde();
  assert.equal(E.staat(id), 'twijfel'); assert.equal(E.staat(id2), 'twijfel');
  assert.deepEqual(E.best(id), ['deadlines:schaduw:soort_of_afzender_niet_hoog', 'facturen:schaduw:soort_of_afzender_niet_hoog']);
  assert.equal(E.tel.kaarten[0].sleutel, 'intake-twijfel-2026-10-31');
  // f7.pdf komt intussen via het verzamelpostvak binnen
  E.bekend.add(crypto.createHash('sha256').update(pdfVan(regels)).digest('hex'));
  const u = await E.r.ronde();
  assert.equal(u.al_in_facturen, 1);
  assert.deepEqual(E.best(id), ['deadlines:bevestigd:auto', 'facturen:bevestigd:auto:al_in_facturen']);
  assert.equal(E.staat(id), 'klaar'); assert.equal(E.staat(id2), 'twijfel');
  assert.equal(E.db.prepare("SELECT uitkomst FROM uitvoering WHERE stuk_id = ? AND lens = 'deadlines'").get(id).uitkomst, 'via_facturen_app');
  // David kiest Facturen-app voor de tweede → facturen en deadlines aangeboden, de koerier haalt hem op
  const k = await E.r.appKeuze({ stuk_id: id2, keuze: 'bestemming', lens: 'facturen' }, 'app:proef');
  assert.equal(k.status, 200, JSON.stringify(k.j)); assert.equal(k.j.uitkomst, 'aangeboden');
  assert.deepEqual(E.best(id2), ['deadlines:bevestigd:david', 'facturen:aangeboden:david']);
  assert.equal(E.db.prepare("SELECT uitkomst FROM uitvoering WHERE stuk_id = ? AND lens = 'deadlines'").get(id2).uitkomst, 'via_facturen_app');
  assert.deepEqual((await E.r.facturenAangeboden(10)).map((x) => x.stuk_id), [id2]);
  E.r.sluit();
});

test('3d: aanmaning in de mailtekst → keten (logboek + kaart "geen betaling gevonden"), deadline als voorstel in het register, kennis erbij (geen bijlage = geen facturenlens); één keer', async () => {
  const E = omgeving();
  const M = Object.assign({ onderwerp: 'Aanmaning dossier D-778899' }, META);
  const id = E.zet({ meta: M, delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: mail(M.van, M.onderwerp, AANMANING) }] });
  await E.r.ronde();
  const sam = JSON.parse(E.db.prepare('SELECT samenvatting FROM router_stuk WHERE stuk_id = ?').get(id).samenvatting);
  assert.equal(sam.soort, 'keten'); assert.equal(sam.afzender_kracht, 'hoog');
  assert.deepEqual(E.best(id), ['deadlines:bevestigd:auto', 'kennis:bevestigd:auto', 'keten:bevestigd:auto']);
  assert.deepEqual(sam.schaduw_lenzen, ['facturen']);
  // keten: betalingscontrole met kenmerk en rekening, kaart, logboek
  assert.equal(E.tel.betaling.length, 1);
  assert.deepEqual(E.tel.betaling[0].kenmerken, ['D-778899']); assert.deepEqual(E.tel.betaling[0].ibans, ['NL91ABNA0417164300']); assert.equal(E.tel.betaling[0].entiteit, 'TG');
  const kaart = E.tel.kaarten.find((x) => /^intake-keten-/.test(x.sleutel));
  assert.ok(kaart); assert.match(kaart.titel, /^Aanmaning van Voorbeeld Energie BV — nakijken$/);
  assert.match(kaart.waarom, /kenmerk D-778899: open en geëscaleerd, geen betaling gevonden — bank bijgewerkt tot 30-10-2026/);
  const b = E.db.prepare("SELECT uitkomst, bewijs FROM besluit WHERE stuk_id = ? AND stap = 'keten'").get(id);
  assert.equal(b.uitkomst, 'open_geescaleerd'); assert.ok(!/D-778899|NL91/.test(b.bewijs), 'geen kenmerk of rekening in het logboek');
  // deadline: voorstel met vindplaats
  const dl = E.dl().split('\n').filter((r) => r.indexOf(id) >= 0);
  assert.equal(dl.length, 1);
  assert.match(dl[0], /^\| 2026-11-20 \| Tolgaarde \| \*\*Vervaldatum aanmaning van Voorbeeld Energie BV\*\* \(kenmerk D-778899\) — voorstel van OVIS Intake, stuk stk_20261031_00000001, ontvangen 31-10-2026; vindplaats: "de mailtekst", regel \d+ \| Voorstel:/);
  assert.equal(E.db.prepare("SELECT pad FROM uitvoering WHERE stuk_id = ? AND lens = 'deadlines'").get(id).pad, K.DL_PAD);
  assert.equal(E.bestanden().length, 1, 'kennisbestand in raw_input');
  // tweede ronde: niets dubbel
  await E.r.ronde();
  assert.equal(E.tel.betaling.length, 1); assert.equal(E.tel.kaarten.filter((x) => /^intake-keten-/.test(x.sleutel)).length, 1);
  assert.equal(E.dl().split('\n').filter((r) => r.indexOf(id) >= 0).length, 1);
  E.r.sluit();
});

test('3d: aanmaning waarvoor de Facturen-app een betaling ziet → alleen logboek, geen kaart; zonder betalingscontrole blijft hij aangeboden', async () => {
  const E = omgeving({ ketenBetaling: async function () { return { gevonden: true, via: 'kenmerk', bank_tot: '2026-10-30', nagekeken: 'entiteit' }; } });
  const M = Object.assign({ onderwerp: 'Laatste herinnering, aanmaning D-112233' }, META);
  const id = E.zet({ meta: M, delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: mail(M.van, M.onderwerp, AANMANING.replace('D-778899', 'D-112233')) }] });
  await E.r.ronde();
  assert.equal(E.db.prepare("SELECT uitkomst FROM besluit WHERE stuk_id = ? AND stap = 'keten'").get(id).uitkomst, 'betaling_gevonden');
  assert.equal(E.tel.kaarten.filter((x) => /^intake-keten-/.test(x.sleutel)).length, 0);
  E.r.sluit();
  const E2b = omgeving({ ketenBetaling: undefined });
  const id2 = E2b.zet({ meta: M, delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: mail(M.van, M.onderwerp, AANMANING) }] });
  await E2b.r.ronde();
  assert.equal(E2b.db.prepare("SELECT status, pogingen FROM bestemming WHERE stuk_id = ? AND lens = 'keten'").get(id2).status, 'aangeboden');
  E2b.r.sluit();
});

test('3d: Facturen-app kiezen voor een stuk zonder pdf → 400; lenzen nog niet live → oude gedrag (bewijsstuk ook naar kennis)', async () => {
  const E = omgeving({ lenzenLive: function () { return ['kennis', 'geen', 'systeem']; } });
  const id = E.zet({ meta: Object.assign({ onderwerp: 'Uw factuur oktober' }, META), delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: mail(META.van, 'Uw factuur oktober', 'Bijgaand.') },
    { deel: 'b1', rol: 'bijlage', naam: 'f.pdf', mime: 'application/pdf', bytes: pdfVan(FACTUUR) }] });
  await E.r.ronde();
  assert.deepEqual(E.best(id), ['kennis:bevestigd:auto']);
  assert.deepEqual(await E.r.facturenAangeboden(10), []);
  E.r.sluit();
  const F = omgeving();
  const t = F.zet({ meta: Object.assign({}, META, { van: 'iemand@onbekend.example', onderwerp: 'Vraag' }), delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: mail('iemand@onbekend.example', 'Vraag', 'Beste David, een vraag over het rooster. Groet, Anne (verzonnen)') }] });
  F.db.prepare("UPDATE live_stuk SET staat = 'twijfel' WHERE stuk_id = ?").run(t);
  await F.r.ronde();
  F.db.prepare("UPDATE live_stuk SET staat = 'twijfel' WHERE stuk_id = ?").run(t);
  const k = await F.r.appKeuze({ stuk_id: t, keuze: 'bestemming', lens: 'facturen' }, 'app:proef');
  assert.equal(k.status, 400); assert.match(k.j.fout, /geen pdf- of UBL-bijlage/);
  F.r.sluit();
});
