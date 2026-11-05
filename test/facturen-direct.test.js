'use strict';
// wv2480 (David 5-11-2026, grondwet 1 aanvulling): per leverancier concept of direct naar de boekhouding. Toetst elke eis van de claimbeslissing
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-direct-'));
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

test('direct: alles klopt → snapshot bij Bevestigen, de app zegt "direct om …", één verzending modus versturen, factuur verstuurd, reden in het spoor', async () => {
  const t = opzet(), g = nepGmail();
  const { f, op, tok } = t.klaarEnBevestigd();
  assert.equal(op.verzendwijze_bij_bevestigen, 'direct');
  assert.equal(op.verzendwijze_versie, 1);
  const vb = t.call('GET', 'factuur/' + f.id).j;
  assert.equal(vb.verzending.wijze, 'direct', JSON.stringify(vb.verzending));
  assert.equal(vb.verzending.om, op.verstuur_na);
  assert.equal(vb.leverancier.verzendwijze, 'direct');
  const u = await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(u.ok, true, JSON.stringify(u.fouten));
  assert.deepEqual(mijn(g, tok).map((c) => c.modus), ['versturen']);
  assert.match(mijn(g, tok)[0].tekst, /Verstuurd door Socev/);
  assert.equal(mijn(g, tok)[0].aan, op.doeladres);
  assert.equal(t.op(op.id).status, 'gelukt');
  assert.equal(t.op(op.id).modus, 'versturen');
  assert.equal(t.fac(f.id).status, 'verstuurd');
  assert.equal(t.besluit(f.id).waarde, 'direct');
  assert.equal(u.verzending.direct, 1);
  assert.equal(D.directVandaag(t.fdb, VERSTUUR + 6 * MIN), 1);
  assert.equal(t.call('GET', 'factuur/' + f.id).j.verzending.wijze, 'direct');
  await t.ronde(g, VERSTUUR + 3 * 3600000);
  assert.equal(mijn(g, tok).length, 1, 'nooit een tweede');
});

// Per eis: één ding weg → concept, met deze reden in het besluitspoor
const EISEN = [
  ['niet vrijgegeven', { nietVrij: true }, null, /niet vrijgegeven/],
  ['verzender kent direct niet (Toetsen-hash)', {}, (t) => { t.klaar = false; }, /verzender kent direct/],
  ['leverancier staat op concept', { zonderDirect: true }, null, /stond bij Bevestigen op concept/],
  ['keuze teruggezet na Bevestigen (versie)', {}, (t, x) => { assert.equal(t.direct(x.f.leverancier, 'concept').status, 200); }, /gewijzigd na Bevestigen/],
  ['keuze uit en weer aan na Bevestigen (versie 3 ≠ 1)', {}, (t, x) => { t.direct(x.f.leverancier, 'concept'); t.direct(x.f.leverancier, 'direct'); }, /gewijzigd na Bevestigen/],
  ['nieuw IBAN', {}, (t, x) => t.fdb.db.prepare('UPDATE factuur SET iban_nieuw = 1 WHERE id = ?').run(x.f.id), /IBAN/],
  ['nagebeld IBAN', {}, (t, x) => t.fdb.db.prepare("UPDATE factuur SET nagebeld_op = '2026-10-22T10:00:00Z', nagebeld_door = 'david' WHERE id = ?").run(x.f.id), /IBAN/],
  ['open signaal', {}, (t, x) => t.fdb.db.prepare("INSERT INTO signaal (id, sleutel, soort, titel, facturen, aangemaakt_op) VALUES ('ab12cd34ef56ab78', 'proef-sig', 'incasso_niet_gezien', 'proef', ?, '2026-10-22T10:00:00Z')").run(JSON.stringify([x.f.id])), /open signaal/],
  ['controle drempel_vast twijfelt', {}, (t, x) => t.fdb.db.prepare('UPDATE factuur SET controles = ? WHERE id = ?').run(JSON.stringify([{ naam: 'drempel_vast', ok: false, ernst: 'melding' }]), x.f.id), /drempel_vast/],
  ['controle met ernst fout', {}, (t, x) => t.fdb.db.prepare('UPDATE factuur SET controles = ? WHERE id = ?').run(JSON.stringify([{ naam: 'iban_mod97', ok: false, ernst: 'fout' }]), x.f.id), /iban_mod97/],
  ['veld alleen door Claude gelezen', {}, (t, x) => t.fdb.db.prepare("INSERT INTO besluit (factuur, stap, veld, waarde, bron, toelichting, wanneer) VALUES (?, 'velden', 'incl', '12100', 'model', 'modelkandidaat (deterministisch leeg), niet in de lokale tekst gevonden', '2026-10-22T10:00:00Z')").run(x.f.id), /alleen door Claude/],
  ['patiëntcontrole niet vastgelegd (alleen afwezigheid)', {}, (t, x) => t.fdb.db.prepare("DELETE FROM besluit WHERE factuur = ? AND stap = 'patientkenmerk'").run(x.f.id), /patiëntcontrole/],
  ['patiëntregel vond een kenmerk', {}, (t, x) => t.fdb.db.prepare("INSERT INTO besluit (factuur, stap, veld, waarde, bron, toelichting, wanneer) VALUES (?, 'patientkenmerk', 'patientkenmerk', '1', 'regel', 'soort: bsn', '2026-10-22T10:00:00Z')").run(x.f.id), /patiëntcontrole/],
  ['scan zonder tekstlaag', {}, (t, x) => t.fdb.db.prepare('UPDATE document SET tekstlaag = 0 WHERE id = ?').run(x.f.document), /leesbaar/],
  ['stuk met patiëntkenmerk', {}, (t, x) => t.fdb.db.prepare('UPDATE document SET patientkenmerk = 1 WHERE id = ?').run(x.f.document), /patiënt/],
  ['controles geen lijst', {}, (t, x) => t.fdb.db.prepare("UPDATE factuur SET controles = '[1]' WHERE id = ?").run(x.f.id), /controles onleesbaar/],
  ['mogelijk dubbel', {}, (t, x) => { const ander = t.fdb.db.prepare('SELECT id FROM factuur WHERE id <> ? LIMIT 1').get(x.f.id); t.fdb.db.prepare('UPDATE factuur SET dubbel_van = ? WHERE id = ?').run(ander.id, x.f.id); }, /dubbel/],
  ['Intake zonder vastgelegd label', {}, (t, x) => intakeBron(t, x.f), /Intake/],
  ['Intake met label mogelijk medisch', {}, (t, x) => { intakeBron(t, x.f); t.fdb.db.prepare("INSERT INTO besluit (factuur, stap, veld, waarde, bron, toelichting, wanneer) VALUES (?, 'herkomst', 'mogelijk_medisch', '1', 'regel', 'proef', '2026-10-22T10:00:00Z')").run(x.f.id); }, /Intake/],
  ['vers gelezen bijlage: patiëntkenmerk (BSN)', {}, (t) => { t.pdfTekst = LANG + '\nBSN: 111222333\n'; }, /patiëntgegevens in een bijlage/],
  ['vers gelezen bijlage: geen tekstlaag', {}, (t) => { t.pdfLaag = false; }, /leesbaar/],
];
function intakeBron(t, f) {
  const b = { id: 'cd34ef56ab78cd90', soort: 'intake', naam: 'proef-intake', actief: 1 };
  if (!t.fdb.db.prepare('SELECT 1 FROM bron WHERE id = ?').get(b.id)) D.voegToe(t.fdb, 'bron', b);
  const be = t.fdb.db.prepare('SELECT bericht FROM factuur WHERE id = ?').get(f.id).bericht;
  if (be) t.fdb.db.prepare('UPDATE bericht SET bron = ? WHERE id = ?').run(b.id, be);
  else { D.voegToe(t.fdb, 'bericht', { id: 'ef56ab78cd90ef12', bron: b.id, message_id: 'proef-intake', ontvangen_op: '2026-10-22T10:00:00Z' }); t.fdb.db.prepare("UPDATE factuur SET bericht = 'ef56ab78cd90ef12' WHERE id = ?").run(f.id); }
}
for (const [naam, opt, na, reden] of EISEN) {
  test('concept als eis wegvalt: ' + naam, async () => {
    const t = opzet(), g = nepGmail();
    const x = t.klaarEnBevestigd(opt);
    if (na) na(t, x);
    const u = await t.ronde(g, VERSTUUR + 5 * MIN);
    assert.equal(u.ok, true, JSON.stringify(u.fouten));
    assert.deepEqual(mijn(g, x.tok).map((c) => c.modus), ['concept'], naam);
    assert.equal(t.op(x.op.id).modus, 'concept');
    assert.equal(t.fac(x.f.id).status, 'concept_klaar');
    const b = t.besluit(x.f.id);
    if (opt.zonderDirect || opt.nietVrij && false) assert.ok(!b || b.waarde === 'concept');
    else { assert.ok(b, 'reden in het spoor'); assert.equal(b.waarde, 'concept'); assert.match(b.toelichting, reden); }
    if (!opt.zonderDirect && !opt.nietVrij) {
      const vb = t.call('GET', 'factuur/' + x.f.id).j.verzending;
      assert.equal(vb.wijze, 'concept'); assert.match(vb.reden, reden);
    }
  });
}

test('review MOET 2: bevestigd, teruggedraaid en opnieuw bevestigd → concept (eerdere opdracht), ook al staat de leverancier op direct', async () => {
  const t = opzet(), g = nepGmail();
  const x = t.klaarEnBevestigd();
  assert.equal(t.call('POST', 'terugdraaien', { id: x.f.id }).status, 200);
  const r = t.call('POST', 'bevestig', { id: x.f.id });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  t.fdb.db.prepare("UPDATE factuur SET controles = '[]' WHERE id = ?").run(x.f.id);
  assert.equal(t.op(r.j.opdracht.id).verzendwijze_bij_bevestigen, 'direct');
  await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.deepEqual(mijn(g, x.tok).map((c) => c.modus), ['concept']);
  assert.match(t.besluit(x.f.id).toelichting, /eerder teruggedraaid/);
});

// review ZOU 1: het gedrag van de servercode (niet alleen de tekst): facturenVerzender en facturenDirectKlaar met nagebootste buren
function serverFn(naam, buren) {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const i = src.indexOf((naam === 'facturenVerzender' ? 'async ' : 'async ') + 'function ' + naam + '(');
  assert.ok(i >= 0, naam);
  const body = src.slice(i, src.indexOf('\n}\n', i) + 3);
  return new Function(...Object.keys(buren), body + '\nreturn ' + naam + ';')(...Object.values(buren));
}
test('server: facturenVerzender — concept met het oude geheim, direct alleen met het eigen verzendgeheim + bron facturen; geen geheim = zeker niets verstuurd', async () => {
  const gezien = [];
  class FD { constructor() { this.v = []; } append(k, v) { this.v.push([k, typeof v === 'string' ? v : '<bestand>']); } }
  const buren = (geheimEigen) => ({ process: { env: { N8N_WEBHOOK_MAILCONCEPT: 'oud-proef' } }, FACTUREN_VERZENDER_WF: 'MiWuPjabqip7dCNo',
    potVzVerzendGeheim: async () => geheimEigen, appWebhookUrl: async () => 'https://n8n.invalid/webhook/x', FormData: FD, Blob: class { constructor() {} },
    AbortSignal: { timeout: () => null }, fetch: async (url, o) => { gezien.push(Object.fromEntries(o.body.v)); return { status: 200, json: async () => ({ ok: true }) }; } });
  const v = { aan: '453248tt@inkoop.exactonline.nl', onderwerp: 'x [ref FV0123456789abcdef]', tekst: 't', token: 'FV0123456789abcdef', bijlagen: [{ naam: 'a.pdf', bytes: Buffer.from('%PDF-') }] };
  let fn = serverFn('facturenVerzender', buren('eigen-proef'));
  await fn(Object.assign({ modus: 'concept' }, v));
  assert.equal(gezien[0].secret, 'oud-proef'); assert.equal(gezien[0].bron, undefined);
  await fn(Object.assign({ modus: 'versturen' }, v));
  assert.equal(gezien[1].secret, 'eigen-proef'); assert.equal(gezien[1].bron, 'facturen'); assert.equal(gezien[1].modus, 'versturen');
  fn = serverFn('facturenVerzender', buren(null));
  await assert.rejects(fn(Object.assign({ modus: 'versturen' }, v)), (e) => e.zekerNietVerstuurd === true);
  assert.equal(gezien.length, 2, 'zonder eigen geheim geen aanroep');
});
test('server: facturenDirectKlaar — alleen true als de verzender bron facturen kent; een fout = false', async () => {
  const log = [];
  let fn = serverFn('facturenDirectKlaar', { potVzVerzenderOk: async (b) => { log.push(b); return true; }, logError: () => {} });
  assert.equal(await fn(), true); assert.deepEqual(log, ['facturen']);
  fn = serverFn('facturenDirectKlaar', { potVzVerzenderOk: async () => 'ja', logError: () => {} });
  assert.equal(await fn(), false);
  fn = serverFn('facturenDirectKlaar', { potVzVerzenderOk: async () => { throw new Error('n8n weg'); }, logError: () => {} });
  assert.equal(await fn(), false);
});

test('factuur zonder leverancier: geen keuze → snapshot leeg → concept', async () => {
  const t = opzet(), g = nepGmail();
  const x = t.klaarEnBevestigd({ zonderDirect: true, voor: (f) => t.fdb.db.prepare("UPDATE factuur SET leverancier = NULL, iban = NULL, ibans_betaal = '[]', ibans_onbekend = '[]' WHERE id = ?").run(f.id) });
  assert.equal(x.op.verzendwijze_bij_bevestigen, null);
  await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.deepEqual(mijn(g, x.tok).map((c) => c.modus), ['concept']);
});

test('dagplafond: 15 directe reserveringen vandaag → de 16e wordt concept (geteld in de reservering); morgen weer direct', async () => {
  const t = opzet(), g = nepGmail();
  const x = t.klaarEnBevestigd();
  const tijd = new Date(VERSTUUR + MIN).toISOString();
  const ids = t.fdb.db.prepare("SELECT id FROM opdracht WHERE status = 'gelukt' AND id <> ? LIMIT 15").all(x.op.id).map((r) => r.id);
  assert.equal(ids.length, 15);
  for (const id of ids) t.fdb.db.prepare("UPDATE opdracht SET modus = 'versturen', verzend_reservering = coalesce(verzend_reservering, 'FV' || substr(id, 1, 16)), verzend_reservering_op = ? WHERE id = ?").run(tijd, id);
  assert.equal(D.directVandaag(t.fdb, VERSTUUR + 5 * MIN), 15);
  assert.equal(t.call('GET', 'factuur/' + x.f.id).j.verzending.wijze, 'concept');
  await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.deepEqual(mijn(g, x.tok).map((c) => c.modus), ['concept']);
  assert.match(t.besluit(x.f.id).toelichting, /dagplafond van 15/);
  // gisteren (Amsterdamse dag) telt niet
  for (const id of ids) t.fdb.db.prepare('UPDATE opdracht SET verzend_reservering_op = ? WHERE id = ?').run('2026-10-21T21:30:00Z', id);
  assert.equal(D.directVandaag(t.fdb, VERSTUUR + 5 * MIN), 0);
});

test('verzender weigert direct vóór Gmail (403 witte_lijst, 409 direct_plafond) → dezelfde ronde concept, reden in het spoor, telt niet als direct', async () => {
  for (const soort of ['weiger403', 'plafond409']) {
    const t = opzet(), g = nepGmail();
    g.direct = soort;
    const x = t.klaarEnBevestigd();
    const u = await t.ronde(g, VERSTUUR + 5 * MIN);
    assert.deepEqual(mijn(g, x.tok).map((c) => c.modus), ['versturen', 'concept'], soort);
    assert.equal(t.op(x.op.id).status, 'gelukt');
    assert.equal(t.op(x.op.id).modus, 'concept');
    assert.equal(t.fac(x.f.id).status, 'concept_klaar');
    assert.match(t.besluit(x.f.id).toelichting, /verzender weigerde direct/);
    assert.equal(u.verzending.direct_terug, 1);
    assert.equal(D.directVandaag(t.fdb, VERSTUUR + 6 * MIN), 0);
  }
});

test('onzeker (time-out, mail wél verzonden) → nooit opnieuw; na 30 min overgenomen als verstuurd, één mail', async () => {
  const t = opzet(), g = nepGmail();
  g.direct = 'tijd';
  const x = t.klaarEnBevestigd();
  const u = await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(u.verzending.direct_onzeker, 1);
  assert.equal(t.op(x.op.id).status, 'opgehaald');
  assert.match(t.besluit(x.f.id).toelichting, /onzeker/);
  g.direct = null;
  await t.ronde(g, VERSTUUR + 40 * MIN);
  assert.deepEqual(mijn(g, x.tok).map((c) => c.modus), ['versturen'], 'geen tweede aanroep');
  assert.equal(t.op(x.op.id).status, 'gelukt');
  assert.equal(t.op(x.op.id).modus, 'versturen');
  assert.equal(t.fac(x.f.id).status, 'verstuurd');
  assert.equal(g.mails.filter((m) => m.onderwerp.indexOf(x.tok) >= 0).length, 1);
});

test('onzeker (time-out, niets gemaakt) → na 30 min concept, nooit opnieuw direct', async () => {
  const t = opzet(), g = nepGmail();
  g.direct = 'tijd_niets';
  const x = t.klaarEnBevestigd();
  await t.ronde(g, VERSTUUR + 5 * MIN);
  g.direct = null;
  await t.ronde(g, VERSTUUR + 40 * MIN);
  assert.deepEqual(mijn(g, x.tok).map((c) => c.modus), ['versturen', 'concept']);
  assert.equal(t.op(x.op.id).modus, 'concept');
  assert.equal(t.fac(x.f.id).status, 'concept_klaar');
  assert.match(t.besluit(x.f.id).toelichting, /al een verzendpoging/);
});

test('Gmail-fout ná de toets (502, concept bleef staan) → onzeker; na 30 min het concept overgenomen, geen tweede verzending', async () => {
  const t = opzet(), g = nepGmail();
  g.direct = '502';
  const x = t.klaarEnBevestigd();
  const u = await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(u.verzending.direct_onzeker, 1);
  assert.equal(u.verzending.mislukt, 0);
  g.direct = null;
  await t.ronde(g, VERSTUUR + 40 * MIN);
  assert.deepEqual(mijn(g, x.tok).map((c) => c.modus), ['versturen']);
  assert.equal(t.op(x.op.id).status, 'gelukt');
  assert.equal(t.op(x.op.id).modus, 'concept', 'een concept dat bleef staan is geen verzending');
  assert.equal(t.fac(x.f.id).status, 'concept_klaar');
});

test('route verzendwijze: alleen de eigenaar, verse vingerafdruk, versie omhoog, audit; zelfde keuze verandert niets', () => {
  const t = opzet();
  const f = t.kies();
  assert.equal(t.call('POST', 'leverancier/verzendwijze', { id: f.leverancier, verzendwijze: 'direct' }, { vers: false }).status, 403);
  assert.equal(t.call('POST', 'leverancier/verzendwijze', { id: f.leverancier, verzendwijze: 'versturen' }).status, 400);
  const pm = F.rolVoor(t.fdb, { ingang: 'fac', email: 'praktijkmanager@proef.invalid', wie: 'pm (proef)' });
  if (pm) assert.equal(t.call('POST', 'leverancier/verzendwijze', { id: f.leverancier, verzendwijze: 'direct' }, { rol: pm }).status, 403);
  let r = t.call('POST', 'leverancier/verzendwijze', { id: f.leverancier, verzendwijze: 'direct' });
  assert.equal(r.status, 200); assert.equal(r.j.versie, 1); assert.equal(r.j.gewijzigd, true);
  r = t.call('POST', 'leverancier/verzendwijze', { id: f.leverancier, verzendwijze: 'direct' });
  assert.equal(r.j.gewijzigd, false); assert.equal(r.j.versie, 1);
  r = t.call('POST', 'leverancier/verzendwijze', { id: f.leverancier, verzendwijze: 'concept' });
  assert.equal(r.j.versie, 2);
  const a = t.fdb.db.prepare("SELECT * FROM audit WHERE wat = 'leverancier_verzendwijze' AND object_id = ? ORDER BY id").all(f.leverancier);
  assert.equal(a.length, 2);
  assert.deepEqual(JSON.parse(a[0].na), { verzendwijze: 'direct', versie: 1 });
  assert.equal(t.call('GET', 'leveranciers').j.leveranciers.find((l) => l.id === f.leverancier).verzendwijze, 'concept');
  assert.ok(F.BEHEER.includes('POST /app/facturen/leverancier/verzendwijze'));
  t.call('POST', 'leverancier/verzendwijze', { id: f.leverancier, verzendwijze: 'direct' });
  assert.deepEqual(t.call('GET', '').j.direct, { vrijgegeven: false, leveranciers: 1 });
  t.vrij();
  assert.equal(t.call('GET', '').j.direct.vrijgegeven, true);
  // de oude alles-of-niets-schakelaar gaat ook na de vrijgave niet open
  const m = t.call('POST', 'instellingen/modus', { modus: 'versturen' });
  assert.equal(m.status, 409); assert.match(m.j.fout, /per leverancier/);
  assert.equal(D.metaLees(t.fdb, 'verzendmodus'), 'concept');
});

test('database-grenzen: versie gaat mee omhoog en nooit omlaag; de snapshot op de opdracht ligt vast', () => {
  const t = opzet();
  const x = t.klaarEnBevestigd();
  assert.throws(() => t.fdb.db.prepare("UPDATE leverancier SET verzendwijze = 'concept' WHERE id = ?").run(x.f.leverancier), /versie omhoog/);
  assert.throws(() => t.fdb.db.prepare('UPDATE leverancier SET verzendwijze_versie = 0 WHERE id = ?').run(x.f.leverancier), /nooit omlaag/);
  assert.throws(() => t.fdb.db.prepare("UPDATE leverancier SET verzendwijze = 'versturen', verzendwijze_versie = 5 WHERE id = ?").run(x.f.leverancier), /CHECK/);
  assert.throws(() => t.fdb.db.prepare("UPDATE opdracht SET verzendwijze_bij_bevestigen = 'concept' WHERE id = ?").run(x.op.id), /ligt vast/);
  assert.throws(() => t.fdb.db.prepare('UPDATE opdracht SET verzendwijze_versie = 7 WHERE id = ?').run(x.op.id), /ligt vast/);
});

test('hercontrole in de reservering: factuur niet onderweg of andere opdracht al gereserveerd → concept', () => {
  const t = opzet();
  const x = t.klaarEnBevestigd();
  // nog niet opgehaald: in_wachtrij → voor de app wel direct (voorbeeld), voor de reservering niet
  assert.equal(D.directBesluit(t.fdb, t.op(x.op.id), { voorbeeld: true }).direct, true);
  assert.match(D.directBesluit(t.fdb, t.op(x.op.id), {}).reden, /niet onderweg/);
  t.fdb.db.prepare("UPDATE factuur SET status = 'wordt_verstuurd' WHERE id = ?").run(x.f.id);
  assert.equal(D.directBesluit(t.fdb, t.op(x.op.id), {}).direct, true);
  // een eerdere reservering voor deze factuur (bv. een poging die onzeker eindigde) → nooit opnieuw direct
  t.fdb.db.prepare("UPDATE opdracht SET verzend_reservering = ?, verzend_reservering_op = '2026-10-22T13:01:00Z' WHERE id = ?").run(x.tok, x.op.id);
  assert.match(D.directBesluit(t.fdb, t.op(x.op.id), {}).reden, /al een verzendpoging/);
});

test('verwerkBericht legt het Intake-label vast als besluit (herkomst/mogelijk_medisch) — alleen als het meegegeven is', () => {
  const src = fs.readFileSync(path.join(ROOT, 'facturen.js'), 'utf8');
  assert.match(src, /if \(typeof o\.mogelijk_medisch === 'boolean'\) besluitRij\(fdb, id, K\.besluit\('herkomst', 'mogelijk_medisch'/);
  const ko = fs.readFileSync(path.join(ROOT, 'facturen-koerier.js'), 'utf8');
  assert.match(ko, /mogelijk_medisch: typeof s\.mogelijk_medisch === 'boolean' \? s\.mogelijk_medisch : undefined/);
  const ir = fs.readFileSync(path.join(ROOT, 'intake-router.js'), 'utf8');
  assert.match(ir, /mogelijk_medisch: !!\(sam\.mogelijk_medisch \|\| sam\.na_keuze\) \}\);/);
});

test('server.js: direct alleen met het eigen verzendgeheim + bron facturen; directKlaar eist de nieuwe Toetsen-hash; route alleen vanaf de telefoon', () => {
  const s = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(s, /if \(v\.modus === 'versturen'\) \{ try \{ geheim = await potVzVerzendGeheim\(\); \} catch \(e\) \{ geheim = null; \} \}/);
  assert.match(s, /if \(v\.modus === 'versturen'\) fd\.append\('bron', 'facturen'\);/);
  assert.match(s, /return \(await potVzVerzenderOk\('facturen'\)\) === true;/);
  assert.match(s, /if \(bron === 'facturen'\) return false;/);
  assert.match(s, /'POST \/app\/facturen\/leverancier\/verzendwijze'/);
});
