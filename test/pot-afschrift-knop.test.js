'use strict';
// wv4144 (besluitenpagina nr 176 = 2C76, David Ja 25-11-2026 22:17): POT-afschrift — (e) de mail van Facturen noemt de posten met een
// vraagteken (toelichting per afschrift), (f) knop "Verstuur aan André": alleen deze ene opdracht direct, alleen met de schakelaar
// afschrift_versturen_knop aan; uit = weigeren (niets in de wachtrij) of concept. Proefomgeving: wegwerpdatabase met zaaddata, nep-verzender,
// afschriftadres = een testalias. Raakt /opt/data/facturen, n8n, Gmail, de kluis en de vault niet. Opzet naar facturen-knop-verstuur.test.js.
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

const NU = Date.parse('2026-11-03T17:30:00Z');
const MIN = 60000;
const ALIAS = 'proef-afschrift@test.invalid';
const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });

function nepGmail() {
  const g = { mails: [], n: 0, calls: [] };
  g.luik = async function (b) {
    const tok = String(b.query).match(/F[VA][0-9a-f]{16}/g) || [];
    const lijst = g.mails.filter((m) => tok.some((t) => m.onderwerp.indexOf('[ref ' + t + ']') >= 0));
    return { query: b.query, aantal: lijst.length, mails: lijst.map((m) => Object.assign({}, m)) };
  };
  g.verzender = async function (v) {
    g.calls.push({ token: v.token, modus: v.modus, aan: v.aan, tekst: v.tekst, namen: v.bijlagen.map((b) => b.naam) });
    const id = 'm' + String(++g.n).padStart(15, '0');
    g.mails.push({ id, aan: v.aan, onderwerp: v.onderwerp, snippet: v.tekst.replace(/\s+/g, ' ').slice(0, 200), labels: [v.modus === 'versturen' ? 'SENT' : 'DRAFT'] });
    return v.modus === 'versturen' ? { status: 200, j: { ok: true, modus: 'versturen', message_id: id } } : { status: 200, j: { ok: true, extern_id: 'r-' + id, message_id: id, modus: 'concept' } };
  };
  return g;
}
function opzet(o) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pot-knop-'));
  WEG.push(dir);
  const fdb = D.open(path.join(dir, 'db'));
  Z.zaai(fdb, { vandaag: '2026-11-03' });
  fdb.db.prepare("UPDATE opdracht SET status = 'teruggedraaid' WHERE status = 'wacht'").run();
  for (const r of fdb.db.prepare("SELECT id FROM opdracht WHERE status IN ('opgehaald','mislukt')").all()) { try { fdb.db.prepare("UPDATE opdracht SET status = 'geweigerd', fout = 'proef' WHERE id = ?").run(r.id); } catch (e) {} }
  fdb.db.prepare("UPDATE entiteit SET afschrift_doel = ? WHERE sleutel = 'pot'").run(ALIAS);
  D.metaZet(fdb, 'versturen_vrijgegeven', '1');
  if (o && o.knop) D.metaZet(fdb, 'afschrift_versturen_knop', '1');
  const eig = F.rolVoor(fdb, { ingang: 'app', wie: 'david (proef)' });
  const t = { fdb, eig, klok: NU };
  t.io = (g) => ({ luik: g.luik, luikBytes: async () => ({ json: {} }), verzender: g.verzender, directKlaar: async () => true,
    pdftotext: async () => ({ ok: true, tekst: 'Rekeningafschrift POT proef synthetisch met voldoende tekst om te lezen, veertig tekens of meer.', tekstlaag: true }) });
  t.ronde = (g, nu) => { t.klok = nu; return KO.ronde(fdb, t.io(g), { nu, klok: () => t.klok, pdf: t.io(g).pdftotext }); };
  t.op = (id) => fdb.db.prepare('SELECT * FROM opdracht WHERE id = ?').get(id);
  const rek = fdb.db.prepare("SELECT id FROM rekening WHERE entiteit = 'pot'").get();
  t.inv = (periode, extra) => Object.assign({ rekening: rek.id, periode,
    mt940: { naam: 'POT-' + periode + '.sta', bytes: Buffer.from('ABNANL2A\r\n940\r\nABNANL2A\r\n:20:PROEF ' + periode + '\r\n:25:NL00TEST0000000001\r\n-') },
    pdf: { naam: 'POT-afschrift ' + periode + '.pdf', bytes: Z.pdf(['Afschrift POT ' + periode, 'synthetisch']) } }, extra || {});
  return t;
}
const TL = '- 5-10 Leverancier A B.V. € 123,45\n- 12-10 Proefwinkel € 9,99';

test('(e) toelichting: de mail van Facturen noemt de posten met een vraagteken; zonder toelichting de oude tekst', async () => {
  const t = opzet(), g = nepGmail();
  const r = F.afschriftKlaarzetten(t.fdb, t.eig, t.inv('2026-10', { toelichting: TL + '\u0007' }), { nu: NU });
  const r2 = F.afschriftKlaarzetten(t.fdb, t.eig, t.inv('2026-09'), { nu: NU });
  await t.ronde(g, NU + 60 * MIN);
  const m = g.calls.find((c) => c.token === 'FA' + r.afschrift), m2 = g.calls.find((c) => c.token === 'FA' + r2.afschrift);
  assert.ok(m && m2, JSON.stringify(g.calls));
  assert.match(m.tekst, /Bij deze betalingen staat een vraagteken[^\n]*\n- 5-10 Leverancier A B\.V\. € 123,45\n- 12-10 Proefwinkel € 9,99\nLaat maar weten/);
  assert.ok(!/\u0007/.test(m.tekst), 'stuurtekens eruit');
  assert.ok(!/vraagteken/.test(m2.tekst), 'zonder toelichting geen lijst');
  assert.equal(m.modus, 'concept');
});

test('(f) schakelaar uit: knop weigert vóór de wachtrij (niets aangemaakt); zonder knop gewoon concept', async () => {
  const t = opzet(), g = nepGmail();
  const voor = Number(t.fdb.db.prepare('SELECT count(*) n FROM opdracht').get().n);
  assert.throws(() => F.afschriftKlaarzetten(t.fdb, t.eig, t.inv('2026-10', { verstuur: true }), { nu: NU }), /staat \(nog\) uit/);
  assert.equal(Number(t.fdb.db.prepare('SELECT count(*) n FROM opdracht').get().n), voor, 'geen opdracht');
  assert.equal(t.fdb.db.prepare("SELECT count(*) n FROM pot_afschrift WHERE periode = '2026-10'").get().n, 0, 'geen afschrift in de wachtrij (transactie teruggedraaid)');
  const r = F.afschriftKlaarzetten(t.fdb, t.eig, t.inv('2026-10'), { nu: NU });
  await t.ronde(g, NU + 60 * MIN);
  assert.deepEqual(g.calls.map((c) => c.modus), ['concept']);
  assert.equal(t.op(r.opdracht.id).modus, 'concept');
});

test('(f) schakelaar aan: één tik = precies één verzending (modus versturen) naar de testalias; niets anders uit de wachtrij direct', async () => {
  const t = opzet({ knop: true }), g = nepGmail();
  const ander = F.afschriftKlaarzetten(t.fdb, t.eig, t.inv('2026-09'), { nu: NU });   // gewoon klaargezet, zonder knop
  const r = F.afschriftKlaarzetten(t.fdb, t.eig, t.inv('2026-10', { verstuur: true, toelichting: TL }), { nu: NU });
  assert.equal(r.opdracht.direct_knop, true);
  assert.equal(t.op(r.opdracht.id).direct_knop, 1);
  assert.throws(() => t.fdb.db.prepare('UPDATE opdracht SET direct_knop = NULL WHERE id = ?').run(r.opdracht.id), /ligt vast/);
  await t.ronde(g, NU + 60 * MIN);
  const direct = g.calls.filter((c) => c.modus === 'versturen');
  assert.equal(direct.length, 1, JSON.stringify(g.calls));
  assert.equal(direct[0].token, 'FA' + r.afschrift);
  assert.equal(direct[0].aan, ALIAS);
  assert.deepEqual(direct[0].namen.map((n) => n.replace(/^.*\./, '')).sort(), ['940', 'pdf']);
  assert.match(direct[0].tekst, /^Kenmerk[\s\S]*Proefwinkel[\s\S]*Verstuurd door Socev/);
  assert.equal(g.calls.find((c) => c.token === 'FA' + ander.afschrift).modus, 'concept', 'de andere opdracht blijft concept');
  assert.equal(t.fdb.db.prepare('SELECT status FROM pot_afschrift WHERE id = ?').get(r.afschrift).status, 'verstuurd');
  assert.equal(t.op(r.opdracht.id).modus, 'versturen');
  // nog een ronde: niets nieuws
  await t.ronde(g, NU + 125 * MIN);
  assert.equal(g.calls.filter((c) => c.modus === 'versturen').length, 1, 'geen tweede verzending');
  assert.throws(() => F.afschriftKlaarzetten(t.fdb, t.eig, t.inv('2026-10', { verstuur: true }), { nu: NU }), /al in de wachtrij of is verstuurd/);
});

test('(f) knop gedrukt, daarna schakelaar uit vóór het verzendmoment → concept (de schakelaar telt bij het reserveren)', async () => {
  const t = opzet({ knop: true }), g = nepGmail();
  const r = F.afschriftKlaarzetten(t.fdb, t.eig, t.inv('2026-10', { verstuur: true }), { nu: NU });
  D.metaZet(t.fdb, 'afschrift_versturen_knop', '0');
  await t.ronde(g, NU + 60 * MIN);
  assert.deepEqual(g.calls.map((c) => c.modus), ['concept']);
  assert.match(D.directBesluit(t.fdb, t.op(r.opdracht.id), { voorbeeld: true }).reden, /staat \(nu\) uit/);
});

test('(f) directBesluit afschrift: zonder knop, ander adres, of eerdere verzendpoging → geen direct', () => {
  const t = opzet({ knop: true });
  const r0 = F.afschriftKlaarzetten(t.fdb, t.eig, t.inv('2026-05'), { nu: NU });
  assert.equal(D.directBesluit(t.fdb, t.op(r0.opdracht.id), {}).direct, false);
  const r = F.afschriftKlaarzetten(t.fdb, t.eig, t.inv('2026-10', { verstuur: true }), { nu: NU });
  const op = t.op(r.opdracht.id);
  assert.equal(D.directBesluit(t.fdb, op, {}).direct, true);
  assert.match(D.directBesluit(t.fdb, Object.assign({}, op, { doeladres: 'iemand@anders.invalid' }), {}).reden, /doeladres/);
  D.metaZet(t.fdb, 'versturen_vrijgegeven', '0');
  assert.match(D.directBesluit(t.fdb, op, {}).reden, /niet vrijgegeven/);
});
