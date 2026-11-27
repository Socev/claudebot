'use strict';
// wv4144 (besluit 2C76 d, David Ja 25-11-2026): de Voor jou-kaart van het POT-afschrift volgt de Facturen-wachtrij (server.js potAfKaartVolg):
// verstuurd → dicht met bewijs; geweigerd → kaarttekst met de reden (één keer per opdracht) + box-rij; concept → meting; door David dichtgezet
// → niet meer volgen. Plus de nieuwe kaarttekst en het posten-antwoord voor de App (potAfRegelsApp). vm-context zoals test/pot-afschrift.sh § 8,
// echte Facturen-database (wegwerp, zaaddata) en nagebootste RPC. Raakt de pod, de kluis, de bank en de vault niet.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'facturen-db.js'));
const F = require(path.join(ROOT, 'facturen.js'));
const Z = require(path.join(ROOT, 'test', 'facturen-zaad.js'));
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'pot-volg-'));
process.on('exit', () => { try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {} });

function laad() {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const a = src.indexOf('// ── wv680: bankluis'), b = src.indexOf('// ── einde bankluis ──');
  const p1 = src.indexOf('// ── wv787: POT-afschriften (App'), p2 = src.indexOf('// ── Projecten (wv373');
  const BD = fs.mkdtempSync(path.join(W, 'bank-'));
  const fdb = D.open(path.join(BD, 'f.db'));
  Z.zaai(fdb, { vandaag: '2026-11-03' });
  const log = { rpc: [], box: [], fout: [] };
  const g = { require, fs, path, crypto, Buffer, console, URL, setTimeout, clearTimeout, AbortSignal, Promise, JSON, Date, VAULT: W, SECRET: 'x'.repeat(40),
    __dirname: ROOT, process: { env: { BANK_DIR: BD, POT_AF_CODE_DIR: ROOT, TZ: 'Europe/Amsterdam' }, execPath: process.execPath, pid: process.pid },
    spawn: () => { throw new Error('geen kind'); }, fetch: async () => { throw new Error('geen netwerk'); },
    logError: (w, e) => log.fout.push(w + ': ' + (e && e.message || e)), schrijfLog: () => {}, nu: () => 'NU', velden: (o) => JSON.stringify(o),
    reqPath: (req) => (req.url || '').split('?')[0], rolPoort: (res, verder) => verder(), rol: { eerste: true }, rolPrimair: () => true, rolEerste: Promise.resolve(), ROL_START_WACHT_MS: 50 };
  const ctx = vm.createContext(g);
  vm.runInContext(src.slice(p1, p2) + '\n' + src.slice(a, b) + '\n;globalThis.__r = { potAfKaartVolg, potAfStaat, potAfStaatZet, potAfKaartDoen, potAfRegelsApp, potAfVergelijkApp };', ctx, { filename: 'server.js#pot' });
  const punten = [];
  ctx.facturenRoutes = { afschrift: () => ({}) };
  ctx.facturenOpen = () => fdb;
  ctx.facturenMod = D;
  ctx.bankBoxRij = (m) => log.box.push(m);
  ctx.appSbRpc = async (fn, body) => {
    log.rpc.push({ fn, body });
    if (fn === 'mk_voor_jou_lijst') return { punten: punten.map((p) => Object.assign({}, p)) };
    if (fn === 'mk_voor_jou_zet') { const i = punten.findIndex((p) => p.sleutel === body.p.sleutel); if (i < 0) punten.push(Object.assign({ status: 'open' }, body.p)); else Object.assign(punten[i], body.p); return { ok: true }; }
    if (fn === 'mk_voor_jou_status') { const p = punten.find((x) => x.sleutel === body.p_sleutel); p.status = body.p_naar; p.bewijs = body.p_bewijs; return { ok: true }; }
    return { ok: true };
  };
  const eig = F.rolVoor(fdb, { ingang: 'app', wie: 'david (proef)' });
  const rek = fdb.db.prepare("SELECT id FROM rekening WHERE entiteit = 'pot'").get();
  const zet = (periode) => F.afschriftKlaarzetten(fdb, eig, { rekening: rek.id, periode,
    mt940: { naam: 'POT-' + periode + '.sta', bytes: Buffer.from('ABNANL2A\r\n940\r\nABNANL2A\r\n:20:PROEF ' + periode + '\r\n-') }, pdf: { naam: 'POT ' + periode + '.pdf', bytes: Z.pdf(['POT ' + periode, 'synthetisch']) } }, { nu: Date.now() });
  return { R: ctx.__r, fdb, log, punten, zet, ctx };
}
function metKaart(t, maand) {
  const s = t.R.potAfStaat(); s.ronde[maand] = { kaart: 'pot-afschrift-' + maand, op: new Date().toISOString() }; t.R.potAfStaatZet(s);
  t.punten.push(Object.assign({ status: 'open' }, t.R.potAfKaartDoen(maand)));
}

test('nieuwe kaarttekst: posten in het scherm, vanzelf dicht; geen bedrag/naam/pad/wv', () => {
  const t = laad();
  const k = t.R.potAfKaartDoen('2026-10');
  const tekst = JSON.stringify(k);
  assert.match(k.stappen[0], /Tik op deze kaart/);
  assert.match(k.stappen.join(' '), /vraagteken/);
  assert.match(k.stappen[k.stappen.length - 1], /vanzelf dicht/);
  assert.ok(!/Gedaan/.test(k.stappen.join(' ')), 'geen "tik op Gedaan" meer');
  assert.ok(!/€|\/opt\/|wv\d|\d+,\d\d/.test(tekst), tekst);
  assert.equal(JSON.stringify(k.herkomst.doel), JSON.stringify({ scherm: 'pot-afschriften', focus: 'maand:2026-10' }));
});

test('weigering → kaart met reden (één keer per opdracht) + één box-rij; daarna verstuurd → dicht met bewijs', async () => {
  const t = laad();
  metKaart(t, '2026-10');
  const r = t.zet('2026-10');
  // Facturen weigert (zoals 9-11: bijlagetype)
  t.fdb.db.prepare("UPDATE opdracht SET status = 'opgehaald', opgehaald_op = ?, bijgewerkt_op = ? WHERE id = ?").run(new Date().toISOString(), new Date().toISOString(), r.opdracht.id);
  D.opdrachtResultaat(t.fdb, r.opdracht.id, { status: 'geweigerd', fout: 'bijlagetype niet verzendbaar (alleen PDF, UBL of MT940)' }, { nu: Date.now(), wie: 'proef' });
  assert.equal(t.fdb.db.prepare('SELECT status FROM pot_afschrift WHERE id = ?').get(r.afschrift).status, 'klaar');
  let u = await t.R.potAfKaartVolg();
  assert.equal(u.weigering, 1, JSON.stringify(u) + t.log.fout.join());
  const p = t.punten.find((x) => x.sleutel === 'pot-afschrift-2026-10');
  assert.match(p.titel, /nam het niet aan/);
  assert.match(p.waarom, /bijlagetype niet verzendbaar/);
  assert.equal(t.log.box.length, 1);
  u = await t.R.potAfKaartVolg();
  assert.equal(u.weigering, 0, 'niet twee keer dezelfde melding');
  assert.equal(t.log.box.length, 1);
  // tweede druk, nu lukt het en is het verstuurd
  const r2 = F.afschriftKlaarzetten(t.fdb, F.rolVoor(t.fdb, { ingang: 'app', wie: 'david (proef)' }), { rekening: t.fdb.db.prepare("SELECT id FROM rekening WHERE entiteit = 'pot'").get().id, periode: '2026-10',
    mt940: { naam: 'POT-2026-10.sta', bytes: Buffer.from('ABNANL2A\r\n940\r\nABNANL2A\r\n:20:PROEF 2026-10\r\n-') }, pdf: { naam: 'POT 2026-10.pdf', bytes: Z.pdf(['POT 2026-10', 'synthetisch']) } }, { nu: Date.now() });
  t.fdb.db.prepare("UPDATE pot_afschrift SET status = 'verstuurd', bijgewerkt_op = '2026-11-03T18:05:00.000Z' WHERE id = ?").run(r2.afschrift);
  u = await t.R.potAfKaartVolg();
  assert.equal(u.dicht, 1, JSON.stringify(u));
  const p2 = t.punten.find((x) => x.sleutel === 'pot-afschrift-2026-10');
  assert.equal(p2.status, 'gedaan');
  assert.match(p2.bewijs, /^Verstuurd aan André op 3-11 19:05 \(via Facturen/);
  assert.ok(t.R.potAfStaat().ronde['2026-10'].dicht);
  const n = t.log.rpc.length;
  await t.R.potAfKaartVolg();
  assert.equal(t.log.rpc.length, n, 'klaar: geen RPC meer');
});

test('concept → meting één keer; door David dichtgezet → stoppen, niets heropend', async () => {
  const t = laad();
  metKaart(t, '2026-10');
  const r = t.zet('2026-10');
  t.fdb.db.prepare("UPDATE opdracht SET status = 'opgehaald', opgehaald_op = ?, bijgewerkt_op = ? WHERE id = ?").run(new Date().toISOString(), new Date().toISOString(), r.opdracht.id);
  D.opdrachtResultaat(t.fdb, r.opdracht.id, { status: 'gelukt', extern_id: 'x1', modus: 'concept' }, { nu: Date.now(), wie: 'proef' });
  let u = await t.R.potAfKaartVolg();
  assert.equal(u.concept, 1, JSON.stringify(u) + t.log.fout.join());
  assert.match(t.punten[0].meting, /staat sinds .* in Gmail/);
  u = await t.R.potAfKaartVolg();
  assert.equal(u.concept, 0);
  t.punten[0].status = 'gedaan';
  u = await t.R.potAfKaartVolg();
  assert.equal(t.R.potAfStaat().ronde['2026-10'].dicht_door, 'david');
  assert.ok(!t.log.rpc.some((x) => x.fn === 'mk_voor_jou_status'), 'geen statuswissel door de pod');
});

test('potAfRegelsApp/potAfVergelijkApp: alleen bekende velden, getallen afgerond, lijsten begrensd', () => {
  const t = laad();
  const r = t.R.potAfRegelsApp([{ datum: '2026-10-05', tegenpartij: 'Leverancier A B.V.', omschrijving: 'x', wat: 'Overige betaling', soort: 'overig', stuk: '?', vraag: true, bedrag: -123.456, saldo: 10, geheim: 'nee' }]);
  assert.deepEqual(Object.keys(r[0]).sort(), ['afwijkt', 'bedrag', 'datum', 'omschrijving', 'saldo', 'soort', 'stuk', 'tegenpartij', 'vraag', 'wat']);
  assert.equal(r[0].bedrag, -123.46);
  const v = t.R.potAfVergelijkApp({ vorige_maand: '2026-09', zelfde: false, tekst: 'Anders', nieuw: Array(30).fill('a'), ontbreekt: [1, 'b'] });
  assert.equal(v.nieuw.length, 20); assert.deepEqual(v.ontbreekt, ['b']);
  assert.equal(t.R.potAfVergelijkApp(null), null);
});
