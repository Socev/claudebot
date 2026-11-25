'use strict';
// Toetsen voor de bonjacht-stap van de koerier (wv3973). Alle data verzonnen (zaad + nep-lees-luik): geen echte lijst, geen echte mail.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'facturen-db.js'));
const F = require(path.join(ROOT, 'facturen.js'));
const BJ = require(path.join(ROOT, 'facturen-bonjacht-ronde.js'));
const KO = require(path.join(ROOT, 'facturen-koerier.js'));
const Z = require(path.join(ROOT, 'test', 'facturen-zaad.js'));

const NU = Date.parse('2026-10-28T10:00:00Z');
const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
const AFZ = 'a.schaap@actasynergia.nl';

// ── minimale xlsx (zelfde opzet als test/facturen-bonjacht.test.js) ──
function crc32(buf) { let c, crc = 0xFFFFFFFF; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xFFFFFFFF) >>> 0; }
function zip(bestanden) {
  const lokaal = [], centraal = []; let off = 0;
  for (const [naam, inhoud] of bestanden) {
    const ruw = Buffer.from(inhoud), comp = zlib.deflateRawSync(ruw), nb = Buffer.from(naam);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(ruw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(ruw.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(ruw), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(ruw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    lokaal.push(lh, nb, comp); centraal.push(ch, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centraal), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(bestanden.length, 8); e.writeUInt16LE(bestanden.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...lokaal, cd, e]);
}
function xlsx(rijen) {
  const ss = []; const idx = (s) => { let i = ss.indexOf(s); if (i < 0) { ss.push(s); i = ss.length - 1; } return i; };
  const xmlRows = rijen.map((r, i) => '<row r="' + (i + 1) + '">' + Object.entries(r).map(([k, v]) =>
    typeof v === 'number' ? `<c r="${k}${i + 1}"><v>${v}</v></c>` : `<c r="${k}${i + 1}" t="s"><v>${idx(v)}</v></c>`).join('') + '</row>').join('');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return zip([['xl/sharedStrings.xml', '<sst>' + ss.map((s) => '<si><t xml:space="preserve">' + esc(s) + '</t></si>').join('') + '</sst>'],
    ['xl/worksheets/sheet1.xml', '<worksheet><sheetData>' + xmlRows + '</sheetData></worksheet>']]);
}
function lijstVoor(iban) {
  const spatie = iban.replace(/(.{4})/g, '$1 ').trim();
  // serieel 46315 = 2026-10-20, 46317 = 2026-10-22
  return xlsx([
    { A: 'Administratie: 99 - Proefpraktijk' }, { A: 'Datum: 27 oktober 2026 door Proef' }, { A: 'Afschriften|Af te handelen' },
    { A: 'Afschriftregel', H: 'Boekingsregel' },
    { A: 'Datum', B: 'Bankrekening', C: 'Val.', D: 'Bedrag in', E: 'Bedrag uit', F: 'Omschrijving', H: 'Grootboekrekening', I: 'Relatie' },
    { A: spatie + ' - Testbank' },
    { A: '46315', C: 'EUR', E: 144, F: 'Webwinkel Blauwbes bestelling 123', H: '2650 - Betalingen onderweg', I: '7 - Webwinkel Blauwbes' },
    { A: '46317', C: 'EUR', E: 8.99, F: 'BEA, Betaalpas Drogist Pluim 2941,PAS075 NR:12ZJ03, 22.10.26/14:08 AMERSFOORT', I: '9678 - Drogist Pluim' },
  ]);
}

function nepLuik(t) {
  const g = { lijstMails: [], bonnen: [], vragen: [], stuk: false, bestanden: {} };
  g.luik = async function (b) {
    g.vragen.push(b);
    if (b.actie === 'mail_zoeken') {
      if (/^from:\(/.test(b.query)) return { mails: b.account === '' ? g.lijstMails.map((m) => ({ id: m.id, thread_id: m.id, van: 'A. Proef <' + AFZ + '>', onderwerp: 'af te handelen', datum_lokaal: '2026-10-27 09:00' })) : [] };
      if (g.stuk) throw Object.assign(new Error('x'), { code: 'TimeoutError' });
      return { mails: g.bonnen.filter((m) => (m.account || '') === (b.account || '') && m.bedragen.some((x) => b.query.includes('"' + x + '"')))
        .map((m) => ({ id: m.id, van: m.van, onderwerp: m.onderwerp, dag_lokaal: m.dag })) };
    }
    if (b.actie === 'mail_lezen') { const m = g.bonnen.find((x) => x.id === b.id); return m ? { van: m.van, onderwerp: m.onderwerp, tekst: m.tekst, datum_lokaal: m.dag + ' 10:00', thread_id: m.id } : { fout: 'niet gevonden' }; }
    if (b.actie === 'mail_bijlage') {
      const l = g.lijstMails.find((x) => x.id === b.id);
      if (l) return { bijlagen: [{ naam: l.naam, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] };
      return { bijlagen: [] };
    }
    throw new Error('onbekende actie');
  };
  g.luikBytes = async function (b) { const l = g.lijstMails.find((x) => x.id === b.id); return l && l.naam === b.naam ? { bytes: l.bytes } : { json: { fout: 'geen' } }; };
  g.io = () => ({ luik: g.luik, luikBytes: g.luikBytes });
  return g;
}

function opzet() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-bonjacht-'));
  WEG.push(dir);
  const fdb = D.open(path.join(dir, 'db'));
  Z.zaai(fdb, { vandaag: '2026-10-28' });
  const rek = fdb.db.prepare("SELECT * FROM rekening WHERE entiteit = 'tolgaarde' LIMIT 1").get();
  const bt = fdb.db.prepare("SELECT * FROM bank_transactie WHERE entiteit = 'tolgaarde' AND bestand IS NOT NULL LIMIT 1").get();
  D.voegToe(fdb, 'bank_transactie', { id: 'bbbbbbbbbbbb3973', bestand: bt.bestand, rekening: rek.id, entiteit: 'tolgaarde', eigen_iban: rek.iban, boekdatum: '2026-10-20',
    bedrag_centen: -14400, tegenpartij_naam: 'Webwinkel Blauwbes', entry_ref: 'r-bj-1', formaat: bt.formaat, omschrijving: 'bestelling 123 (proef)', aangemaakt_op: new Date(NU).toISOString() });
  const routes = F.maak({ fout: () => {} });
  const eig = F.rolVoor(fdb, { ingang: 'app', wie: 'david (proef)' });
  const t = { dir, fdb, rek, routes, eig, klok: NU };
  t.call = (methode, rest, d) => {
    const x = routes.app(fdb, { methode, pad: '/app/facturen' + (rest ? '/' + rest : ''), d: d || {}, rol: eig, primair: true, nu: NU, versOk: () => true, versVerbruik: () => {} });
    if (x.status >= 400) throw new Error(x.status + ' ' + (x.j && x.j.fout));
    return x.j;
  };
  t.ronde = (g) => BJ.ronde(fdb, g.io(), { klok: () => t.klok, wie: 'koerier', pdf: KO.pdfNaarTekst });
  return t;
}
const BON = { id: '19aa00000000b001', van: 'Webwinkel Blauwbes <orders@blauwbes.invalid>', onderwerp: 'Je bestelling 123 bij Webwinkel Blauwbes', dag: '2026-10-19',
  tekst: 'Bedankt voor je bestelling bij Webwinkel Blauwbes.\nTotaal: € 144,00 (incl. btw)\nBetaald met iDEAL.', bedragen: ['144,00'] };

test('geen lijst in de mail: niets vastgelegd, alleen de twee zoekvragen (prive en dm)', async () => {
  const t = opzet(); const g = nepLuik(t);
  const u = await t.ronde(g);
  assert.equal(u.ok, true);
  assert.equal(t.fdb.db.prepare('SELECT count(*) AS n FROM bonjacht_lijst').get().n, 0);
  assert.equal(g.vragen.length, 2);
  assert.ok(g.vragen.every((v) => v.actie === 'mail_zoeken' && v.query.includes('from:(' + AFZ + ')') && /newer_than:21d/.test(v.query)));
});

test('lijst herkend → posten aan de bank, bon gevonden en in Beoordelen met "al betaald"; pinpas niet gevonden met reden; Bevestigen koppelt aan de bankregel', async () => {
  const t = opzet(); const g = nepLuik(t);
  g.lijstMails.push({ id: '19aa00000000a001', naam: 'CflStatementsToBeCompleted (3).xlsx', bytes: lijstVoor(t.rek.iban) });
  g.bonnen.push(BON);
  const u = await t.ronde(g);
  assert.equal(u.ok, true, JSON.stringify(u));
  assert.equal(u.aantallen.lijsten, 1);
  const l = t.fdb.db.prepare('SELECT * FROM bonjacht_lijst').get();
  assert.equal(l.entiteit, 'tolgaarde'); assert.equal(l.status, 'klaar');
  const r = t.fdb.db.prepare('SELECT * FROM bonjacht_regel ORDER BY nr').all();
  assert.equal(r.length, 2);
  assert.equal(r[0].status, 'gevonden'); assert.equal(r[0].transactie, 'bbbbbbbbbbbb3973'); assert.ok(r[0].factuur);
  assert.ok(!/Bedankt voor je bestelling/.test(r[0].treffers), 'geen mailtekst in de treffers');
  assert.equal(r[1].status, 'niet_gevonden'); assert.match(r[1].reden, /pinbetaling/);
  const f = t.fdb.db.prepare('SELECT * FROM factuur WHERE id = ?').get(r[0].factuur);
  assert.equal(f.status, 'te_beoordelen'); assert.equal(f.betaalwijze, 'betaald'); assert.equal(f.entiteit, 'tolgaarde'); assert.equal(f.incl, 14400);
  const bron = t.fdb.db.prepare('SELECT r.soort FROM bericht b JOIN bron r ON r.id = b.bron WHERE b.id = ?').get(f.bericht);
  assert.equal(bron.soort, 'bonjacht');
  const doc = t.fdb.db.prepare('SELECT * FROM document WHERE id = ?').get(f.document);
  assert.equal(doc.mime, 'application/pdf');
  assert.equal(fs.readFileSync(D.stukPad(t.fdb, doc.sha256)).subarray(0, 5).toString('latin1'), '%PDF-');
  const tekst = await KO.pdfNaarTekst(fs.readFileSync(D.stukPad(t.fdb, doc.sha256)));
  assert.ok(tekst.ok && /144,00/.test(tekst.tekst) && /Blauwbes/.test(tekst.tekst), 'pdf van de mail is leesbaar');
  // Beoordelen: het bewijs is de bankregel
  const d = t.call('GET', 'factuur/' + f.id);
  assert.equal(d.al_betaald && d.al_betaald.bron, 'bank');
  assert.match(d.al_betaald.regel, /lijst van de boekhouder/);
  // review MOET 1: ander bedrag op de factuur = geen bankbewijs
  t.fdb.db.prepare('UPDATE factuur SET incl = 14300 WHERE id = ?').run(f.id);
  const d2 = t.call('GET', 'factuur/' + f.id);
  assert.ok(!d2.al_betaald || d2.al_betaald.bron !== 'bank', 'bedrag wijkt af: geen bankbewijs');
  t.fdb.db.prepare('UPDATE factuur SET incl = 14400 WHERE id = ?').run(f.id);
  // blok in de app
  const b = t.call('GET', 'bonjacht');
  assert.equal(b.lijsten.length, 1); assert.equal(b.lijsten[0].regels.length, 2);
  assert.equal(b.lijsten[0].regels[0].status, 'gevonden'); assert.equal(b.lijsten[0].regels[1].status, 'niet_gevonden');
  // Bevestigen (al betaald) → koppeling met de bankregel, betaald gezien
  const v = t.call('POST', 'bevestig', { id: f.id, versie: f.versie });
  assert.equal(v.betaalspoor, 'betaald_gezien', JSON.stringify(v));
  assert.ok(t.fdb.db.prepare("SELECT 1 FROM koppeling WHERE transactie = 'bbbbbbbbbbbb3973' AND factuur = ?").get(f.id));
});

test('twee keer dezelfde lijst (ook in een tweede mail) = één keer verwerkt; tweede ronde haalt niets opnieuw op', async () => {
  const t = opzet(); const g = nepLuik(t);
  const bytes = lijstVoor(t.rek.iban);
  g.lijstMails.push({ id: '19aa00000000a001', naam: 'CflStatementsToBeCompleted (3).xlsx', bytes }, { id: '19aa00000000a002', naam: 'CflStatementsToBeCompleted (3).xlsx', bytes });
  g.bonnen.push(BON);
  await t.ronde(g);
  assert.equal(t.fdb.db.prepare("SELECT count(*) AS n FROM bonjacht_lijst WHERE status <> 'geen_lijst'").get().n, 1);
  assert.equal(t.fdb.db.prepare("SELECT reden FROM bonjacht_lijst WHERE message_id = '19aa00000000a002'").get().reden, 'lijst al gelezen');
  assert.equal(t.fdb.db.prepare('SELECT count(*) AS n FROM bonjacht_regel').get().n, 2);
  const nf = t.fdb.db.prepare('SELECT count(*) AS n FROM factuur').get().n;
  g.vragen.length = 0;
  await t.ronde(g);
  assert.ok(g.vragen.every((v) => v.actie === 'mail_zoeken' && /^from:/.test(v.query)), 'tweede ronde: alleen de lijstzoekvraag');
  assert.equal(t.fdb.db.prepare('SELECT count(*) AS n FROM factuur').get().n, nf);
});

test('zoekfout = fout (nooit niet gevonden), volgende ronde opnieuw en dan gevonden', async () => {
  const t = opzet(); const g = nepLuik(t);
  g.lijstMails.push({ id: '19aa00000000a001', naam: 'CflStatementsToBeCompleted (3).xlsx', bytes: lijstVoor(t.rek.iban) });
  g.bonnen.push(BON);
  g.stuk = true;
  await t.ronde(g);
  const r = t.fdb.db.prepare('SELECT status, pogingen FROM bonjacht_regel ORDER BY nr').all();
  assert.deepEqual(r.map((x) => x.status), ['fout', 'fout']);
  assert.equal(t.fdb.db.prepare("SELECT status FROM bonjacht_lijst").get().status, 'bezig');
  g.stuk = false;
  await t.ronde(g);
  assert.deepEqual(t.fdb.db.prepare('SELECT status FROM bonjacht_regel ORDER BY nr').all().map((x) => x.status), ['gevonden', 'niet_gevonden']);
  assert.equal(t.fdb.db.prepare("SELECT status FROM bonjacht_lijst").get().status, 'klaar');
});

test('mail die niet van de boekhouder komt of geen Exact-lijst heeft: geen lijst; bonjacht_uit = niets', async () => {
  const t = opzet(); const g = nepLuik(t);
  g.lijstMails.push({ id: '19aa00000000a003', naam: 'CflStatementsToBeCompleted (4).xlsx', bytes: xlsx([{ A: 'iets anders' }]) });
  await t.ronde(g);
  assert.equal(t.fdb.db.prepare("SELECT status FROM bonjacht_lijst").get().status, 'onleesbaar');
  D.metaZet(t.fdb, 'bonjacht_uit', '1');
  g.vragen.length = 0;
  const u = await t.ronde(g);
  assert.equal(u.aan, false); assert.equal(g.vragen.length, 0);
});

test('mailPdf: geldige pdf, lange tekst ingekort op 6 pagina\'s', async () => {
  const b = BJ.mailPdf({ van: 'x@y.invalid', datum: '2026-10-19', onderwerp: 'Proef', tekst: 'regel '.repeat(20000) }, { gemaakt: '2026-10-28T10:00:00.000Z' });
  assert.equal(b.subarray(0, 5).toString('latin1'), '%PDF-');
  const t = await KO.pdfNaarTekst(b);
  assert.equal(t.ok, true); assert.equal(t.paginas, 6); assert.match(t.tekst, /ingekort/);
});

test('portaallink: alleen https', () => {
  const t = opzet();
  const lev = t.fdb.db.prepare('SELECT id FROM leverancier LIMIT 1').get();
  assert.throws(() => t.call('POST', 'leverancier', { id: lev.id, portaal_url: 'http://x.invalid/' }), /https/);
  t.call('POST', 'leverancier', { id: lev.id, portaal_url: 'https://portaal.invalid/facturen' });
  assert.equal(t.fdb.db.prepare('SELECT portaal_url FROM leverancier WHERE id = ?').get(lev.id).portaal_url, 'https://portaal.invalid/facturen');
});

test('vol antwoord (25) op de lijstzoekvraag: per week opnieuw zoeken, oudere lijst valt niet weg', async () => {
  const t = opzet(); const g = nepLuik(t);
  const vol = Array.from({ length: 25 }, (_, i) => ({ id: '19aa00000000c' + String(i).padStart(3, '0'), naam: 'iets.xlsx', bytes: Buffer.from('x') }));
  g.lijstMails.push(...vol, { id: '19aa00000000a001', naam: 'CflStatementsToBeCompleted (3).xlsx', bytes: lijstVoor(t.rek.iban) });
  const oud = g.luik;
  g.luik = async (b) => {
    if (b.actie === 'mail_zoeken' && /^from:\(/.test(b.query) && b.account === '') {
      g.vragen.push(b);
      const week = /older_than:14d/.test(b.query);
      const m = /older_than/.test(b.query) ? (week ? [g.lijstMails[25]] : []) : /newer_than:7d/.test(b.query) ? g.lijstMails.slice(0, 25) : g.lijstMails.slice(0, 25);
      return { mails: m.map((x) => ({ id: x.id, thread_id: x.id, van: AFZ, onderwerp: 'lijst', datum_lokaal: '2026-10-27 09:00' })) };
    }
    return oud(b);
  };
  BJ.GRENS.berichten = 40;
  try { await t.ronde(g); } finally { BJ.GRENS.berichten = 6; }
  assert.ok(g.vragen.some((v) => /older_than:14d/.test(v.query)), 'per week gezocht');
  assert.equal(t.fdb.db.prepare("SELECT count(*) AS n FROM bonjacht_lijst WHERE status = 'klaar' OR status = 'bezig'").get().n, 1);
});

// ── wv4027 (besluit 2C57): knop "Maak concept aan pa" — de echte server.js-functies (facturenBonjachtConcept + facturenSpecMailluik) met een
// nep-lees-luik en een nep-mailluik (fetch). Niets gaat naar Gmail. Alle data verzonnen.
function serverFn(naam) {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const i = src.indexOf('async function ' + naam + '(');
  assert.ok(i >= 0, naam + ' in server.js');
  const j = src.indexOf('\n}\n', i);
  return src.slice(i, j + 2);
}
function conceptOpzet(t) {
  const n = { luik: [], mail: [], antwoord: null, log: [] };
  const routes = t.routes;
  const bouw = new Function('facturenRoutes', 'rolPrimair', 'appTeller', 'appAgendaApi', 'appWebhookUrl', 'fetch', 'logError', 'schrijfLog', 'velden', 'nu', 'process', 'POT_AF_MAILWF', 'FAC_SPEC_MAX_MS', 'FAC_BJ_CONCEPT_UUR',
    serverFn('facturenBonjachtConcept') + '\n' + serverFn('facturenSpecMailluik') + '\nreturn facturenBonjachtConcept;');
  const fn = bouw(routes, () => true, () => true,
    async (b) => { n.luik.push(b); return n.kop === undefined ? { id: b.id, van: 'A. Proef <' + AFZ + '>', onderwerp: 'RE: af te handelen', tekst: 'GEHEIME LIJSTTEKST' } : n.kop; },
    async () => 'https://n8n.invalid/webhook/x', async (url, o) => {
      const body = JSON.parse(o.body); n.mail.push(body);
      const a = n.antwoord ? n.antwoord(body) : { status: 200, j: { ok: true, concept_id: 'r-proef-' + n.mail.length, thread_id: body.thread_id || 'nieuw', bijlagen: body.bijlagen.length } };
      return { status: a.status, ok: a.status >= 200 && a.status < 300, json: async () => a.j, arrayBuffer: async () => new ArrayBuffer(0) };
    }, (w, e) => n.log.push(w + ' ' + (e && e.message)), (r) => n.log.push(r), (o) => JSON.stringify(o), () => 'nu', { env: { N8N_WEBHOOK_MAILCONCEPT: 'nep' } }, 'wf', 30000, 20);
  n.klik = (lijst, o) => fn(t.fdb, t.eig, lijst, o || {});
  return n;
}
async function lijstMetBevestigdeBon() {
  const t = opzet(); const g = nepLuik(t);
  g.lijstMails.push({ id: '19aa00000000a001', naam: 'CflStatementsToBeCompleted (3).xlsx', bytes: lijstVoor(t.rek.iban) });
  g.bonnen.push(BON);
  await t.ronde(g);
  const l = t.fdb.db.prepare("SELECT * FROM bonjacht_lijst WHERE status = 'klaar'").get();
  const r = t.fdb.db.prepare("SELECT * FROM bonjacht_regel WHERE status = 'gevonden'").get();
  return { t, l, r };
}

test('concept aan pa: vóór Bevestigen geen knop en geen concept; daarna één concept in de draad met alleen de bevestigde bon, geen ontbrekende post', async () => {
  const { t, l, r } = await lijstMetBevestigdeBon();
  const n = conceptOpzet(t);
  let b = t.call('GET', 'bonjacht').lijsten[0];
  assert.equal(b.concept.bevestigd, 0); assert.equal(b.concept.status, 'geen');
  const v0 = await n.klik(l.id);
  assert.equal(v0.status, 409); assert.equal(v0.j.code, 'geen_bon');
  assert.equal(n.mail.length, 0, 'zonder bevestigde bon geen concept');
  const f = t.fdb.db.prepare('SELECT * FROM factuur WHERE id = ?').get(r.factuur);
  t.call('POST', 'bevestig', { id: f.id, versie: f.versie });
  b = t.call('GET', 'bonjacht').lijsten[0];
  assert.equal(b.concept.bevestigd, 1); assert.equal(b.concept.nieuw, 1);
  const v = await n.klik(l.id);
  assert.equal(v.status, 200, JSON.stringify(v.j)); assert.equal(v.j.concept.status, 'klaar'); assert.equal(v.j.stukken, 1);
  assert.equal(n.mail.length, 1);
  const m = n.mail[0];
  assert.equal(m.aan, AFZ);
  assert.equal(m.thread_id, l.draad_id, 'in de draad van de lijst');
  assert.equal(m.onderwerp, 'Re: af te handelen');
  assert.match(m.bericht, /^Ha pa,/);
  assert.match(m.bericht, /20-10-2026 · € 144,00 · Webwinkel Blauwbes/);
  assert.ok(!/8,99|Pluim|pinbetaling|niet gevonden/i.test(m.bericht), 'ontbrekende post staat er niet in: ' + m.bericht);
  assert.equal(m.bijlagen.length, 1); assert.equal(m.bijlagen[0].mime, 'application/pdf');
  assert.equal(Buffer.from(m.bijlagen[0].inhoud_base64, 'base64').subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(m.bijlagen[0].naam, /^2026-10-20 Webwinkel Blauwbes EUR 144,00\.pdf$/);
  // lees-luik: alleen mail_lezen van de lijst zelf; geen lijsttekst in de database of de log
  assert.deepEqual(n.luik.map((x) => x.actie + ' ' + x.id), ['mail_lezen ' + l.message_id]);
  const audit = t.fdb.db.prepare("SELECT wat, na FROM audit WHERE object_soort = 'bonjacht_concept' ORDER BY id").all();
  assert.deepEqual(audit.map((a) => a.wat), ['bonjacht_concept_aangevraagd', 'bonjacht_concept_klaar']);
  assert.ok(!audit.some((a) => /GEHEIME|Ha pa|af te handelen|Blauwbes/.test(a.na)), 'geen mailtekst in de audit');
  assert.ok(!n.log.some((x) => /GEHEIME|Ha pa|af te handelen/.test(x)), 'geen mailtekst in de log');
  b = t.call('GET', 'bonjacht').lijsten[0];
  assert.equal(b.concept.status, 'klaar'); assert.equal(b.concept.nieuw, 0);
  // tweede klik: geen tweede concept, "staat al in Gmail"
  const v2 = await n.klik(l.id);
  assert.equal(v2.status, 409); assert.equal(v2.j.code, 'al_klaar'); assert.match(v2.j.fout, /staat al in Gmail/);
  assert.equal(n.mail.length, 1, 'tweede klik maakt geen tweede concept');
});

test('concept aan pa: luik zegt "er staat al een concept in de draad" (409) = niets gemaakt, stand al_in_gmail; afzender niet de boekhouder = geen concept', async () => {
  const { t, l, r } = await lijstMetBevestigdeBon();
  const f = t.fdb.db.prepare('SELECT * FROM factuur WHERE id = ?').get(r.factuur);
  t.call('POST', 'bevestig', { id: f.id, versie: f.versie });
  const n = conceptOpzet(t);
  n.kop = { id: l.message_id, van: 'Iemand <iemand@elders.invalid>', onderwerp: 'af te handelen' };
  const v0 = await n.klik(l.id);
  assert.equal(v0.status, 200); assert.equal(v0.j.concept.status, 'mislukt'); assert.match(v0.j.concept.reden, /niet van het adres van de boekhouder/);
  assert.equal(n.mail.length, 0);
  n.kop = undefined;
  n.antwoord = () => ({ status: 409, j: { ok: false, fout: 'er staat al een concept in deze draad', bestaand_concept: ['x'] } });
  const v = await n.klik(l.id);
  assert.equal(v.status, 200); assert.equal(v.j.concept.status, 'mislukt'); assert.equal(v.j.concept.al_in_gmail, true);
  assert.equal(n.mail.length, 1); assert.equal(n.mail[0].thread_id, l.draad_id);
  // onzeker (time-out): stand onbekend; opnieuw alleen met nogmaals
  n.antwoord = () => ({ status: 504, j: null });
  const v2 = await n.klik(l.id);
  assert.equal(v2.j.concept.status, 'onbekend');
  const v3 = await n.klik(l.id);
  assert.equal(v3.status, 409); assert.equal(v3.j.code, 'misschien_al');
  n.antwoord = null;
  const v4 = await n.klik(l.id, { nogmaals: true });
  assert.equal(v4.j.concept.status, 'klaar');
});

test('concept aan pa: lijst op het praktijkpostvak = concept zonder draad-id; niet-eigenaar en onbekende lijst geweigerd', async () => {
  const { t, l, r } = await lijstMetBevestigdeBon();
  const f = t.fdb.db.prepare('SELECT * FROM factuur WHERE id = ?').get(r.factuur);
  t.call('POST', 'bevestig', { id: f.id, versie: f.versie });
  t.fdb.db.prepare("UPDATE bonjacht_lijst SET account = 'dm' WHERE id = ?").run(l.id);
  const n = conceptOpzet(t);
  const v = await n.klik(l.id);
  assert.equal(v.j.concept.status, 'klaar');
  assert.equal(n.mail[0].thread_id, undefined, 'geen privé-draad: geen thread_id');
  assert.equal(n.luik[0].account, 'dm');
  const x = await n.klik('0000000000000000');
  assert.equal(x.status, 404);
  t.fdb.db.prepare("UPDATE gebruiker SET actief = 1 WHERE rol = 'praktijkmanager'").run();
  const pm = F.rolVoor(t.fdb, { ingang: 'fac', email: 'praktijkmanager@voorbeeld.invalid' });
  assert.ok(pm, 'zaad heeft een praktijkmanager');
  const y = t.routes.bonjachtConcept.voor(t.fdb, pm, l.id, { primair: true });
  assert.equal(y.status, 403, 'alleen de eigenaar');
});
