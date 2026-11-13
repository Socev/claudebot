'use strict';
// wv2991: OVIS Personeelsscherm fase 0 — personeelsscherm.js met een nep-D1 (node:sqlite, zelfde schema) en een nep-Cloudflare-API.
// Verzonnen gegevens; geen netwerk. PS_MODULE=<pad> toetst een andere kopie (kruisproef).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const PS = require(process.env.PS_MODULE || path.join(__dirname, '..', 'personeelsscherm.js'));

function nepD1() {
  const sq = new DatabaseSync(':memory:');
  const log = [];
  const d1 = async (batch) => {
    log.push(batch.map((b) => b.sql));
    sq.exec('BEGIN');
    try {
      const uit = batch.map(({ sql, params }) => {
        const r = sq.prepare(sql), p = params || [];
        if (/^\s*select|returning/is.test(sql)) return { results: r.all(...p).map((x) => ({ ...x })), meta: {} };
        return { results: [], meta: { changes: Number(r.run(...p).changes) } };
      });
      sq.exec('COMMIT'); return uit;
    } catch (e) { sq.exec('ROLLBACK'); throw e; }
  };
  return { sq, d1, log };
}
function nepCf(opts = {}) {
  const calls = [];
  const cf = async (methode, pad, body) => {
    calls.push({ methode, pad, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
    if (opts.faal && opts.faal(methode, pad)) return { status: 500, j: { success: false, errors: [{ code: 1 }] } };
    if (methode === 'POST' && /\/access\/service_tokens$/.test(pad)) return { status: 200, j: { success: true, result: { id: 'tok-1', client_id: 'a'.repeat(32) + '.access', client_secret: 'b'.repeat(64), expires_at: '2027-11-13T10:00:00Z' } } };
    return { status: 200, j: { success: true, result: {} } };
  };
  return { cf, calls };
}
function opzet(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-'));
  fs.mkdirSync(path.join(dir, 'geheim'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(dir, 'geheim', 'teken-ed25519.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ account: 'acc', access_app_id: 'app-1', eigenaar: 'eigenaar@voorbeeld.nl',
    access_app: { name: 'Personeelsscherm', domain: 'personeel.socev.dev', type: 'self_hosted', session_duration: '720h' } }));
  const D = nepD1(), C = nepCf(o), meld = [];
  for (const q of PS.D1_SCHEMA) D.sq.exec(q);   // zoals de Worker het al zette
  let klok = o.nu || Date.parse('2026-11-16T09:00:00Z');   // maandag 10:00 in Amsterdam
  const m = PS.maak({ dir, d1: D.d1, cf: C.cf, nu: () => klok, melding: async (k, t) => { meld.push({ k, t }); }, fout: () => {} });
  return { m, D, C, meld, dir, publicKey, zet: (t) => { klok = t; }, nu: () => klok };
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function koppelRij(D, code, t, opts = {}) {
  const k = crypto.generateKeyPairSync('rsa', { modulusLength: opts.bits || 3072 });
  D.sq.prepare('INSERT INTO koppel (code_hash, poll_hash, pub, pub_fp, gemaakt, verloopt, land, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sha('code:' + code), sha('poll:x'), k.publicKey.export({ type: 'spki', format: 'pem' }), 'fp', t, opts.verloopt || t + 600000, 'NL', opts.ip || '198.51.100.7');
  return k.privateKey;
}

test('scherm: één bestand, niets van buiten, verversen en houdbaarheid erin; leeg = zwart', () => {
  const h = PS.bouwHtml({ gemaakt: 1, houdbaar_tot: 2, leeg: false, logoSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
  assert.match(h, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*connect-src 'none'/);
  assert.match(h, /<meta http-equiv="refresh" content="60">/);
  assert.match(h, /data-houdbaar="2"/);
  assert.doesNotMatch(h.replace(/data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+/g, ''), /https?:\/\//);
  assert.doesNotMatch(h, /fetch\(|XMLHttpRequest|WebSocket|import\(/);
  const l = PS.bouwHtml({ gemaakt: 1, houdbaar_tot: 2, leeg: true });
  assert.match(l, /data-soort="leeg"/); assert.match(l, /background:#000/); assert.doesNotMatch(l, /Personeelsscherm<\/h1>/);
});

test('publiceren: getekend, volgnr stijgt, D1 houdt alleen een hoger volgnr; leeg tekent meteen', async () => {
  const { m, D, publicKey, zet, nu } = opzet();
  const d1 = await m.publiceer();
  const r = D.sq.prepare('SELECT volgnr, bytes, sig FROM envelop WHERE id = 1').get();
  const bytes = Buffer.from(r.bytes, 'base64');
  assert.ok(crypto.verify(null, bytes, publicKey, Buffer.from(r.sig, 'base64')), 'handtekening klopt');
  const doc = JSON.parse(bytes);
  assert.strictEqual(doc.v, 1); assert.strictEqual(doc.volgnr, r.volgnr); assert.strictEqual(doc.houdbaar_tot - doc.gemaakt, PS.HOUDBAAR_MS); assert.strictEqual(doc.leeg, false); assert.strictEqual(doc.code, null);
  // een ander mag niets onderschuiven: verkeerde sleutel klopt niet
  const ander = crypto.generateKeyPairSync('ed25519').publicKey;
  assert.ok(!crypto.verify(null, bytes, ander, Buffer.from(r.sig, 'base64')));
  zet(nu() - 1000);   // klok terug: volgnr moet toch stijgen
  const d2 = await m.leeg(true);
  assert.strictEqual(d2.status, 200); assert.strictEqual(d2.body.leeg, true);
  const r2 = D.sq.prepare('SELECT volgnr, bytes FROM envelop WHERE id = 1').get();
  assert.ok(r2.volgnr > d1.volgnr, 'hoger volgnr ook als de klok terugloopt');
  assert.strictEqual(JSON.parse(Buffer.from(r2.bytes, 'base64')).leeg, true);
  // D1 weigert een lager volgnr (bv. een oude pod-kopie)
  D.sq.prepare('INSERT INTO envelop (id, volgnr, bytes, sig, op) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET volgnr = excluded.volgnr, bytes = excluded.bytes, sig = excluded.sig, op = excluded.op WHERE excluded.volgnr > envelop.volgnr').run(1, 'x', 'y', 0);
  assert.strictEqual(D.sq.prepare('SELECT volgnr FROM envelop').get().volgnr, r2.volgnr);
});

test('koppelen: verkeerde code telt, vijf keer fout = dicht; goede code = token met IP-eis, versleuteld voor het kastje, één keer', async () => {
  const { m, D, C, nu, zet, meld, dir } = opzet();
  await m.open();
  assert.ok(Number(D.sq.prepare("SELECT waarde FROM stand WHERE sleutel = 'koppel_open_tot'").get().waarde) > nu());
  const priv = koppelRij(D, '12345678', nu());
  assert.strictEqual((await m.koppel('1234567')).status, 400);
  assert.strictEqual((await m.koppel('87654321')).status, 404);
  const ok = await m.koppel('1234 5678');
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  const post = C.calls.find((c) => c.methode === 'POST'), put = C.calls.find((c) => c.methode === 'PUT');
  assert.ok(post && /\/accounts\/acc\/access\/service_tokens$/.test(post.pad)); assert.strictEqual(post.body.name, 'personeelsscherm-pi'); assert.strictEqual(post.body.duration, '8760h');
  assert.strictEqual(put.pad, '/accounts/acc/access/apps/app-1');
  assert.strictEqual(put.body.policies.length, 2);
  assert.deepStrictEqual(put.body.policies[0].include, [{ email: { email: 'eigenaar@voorbeeld.nl' } }]);
  assert.deepStrictEqual(put.body.policies[1].include, [{ service_token: { token_id: 'tok-1' } }]);
  assert.deepStrictEqual(put.body.policies[1].require, [{ ip: { ip: '198.51.100.7/32' } }], 'review MOET 1: IP-eis');
  assert.strictEqual(put.body.policies[1].decision, 'non_identity');
  const rij = D.sq.prepare('SELECT cipher, gebruikt FROM koppel').get();
  const klaar = JSON.parse(crypto.privateDecrypt({ key: priv, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(rij.cipher, 'base64')));
  assert.strictEqual(klaar.client_id, 'a'.repeat(32) + '.access'); assert.strictEqual(klaar.client_secret, 'b'.repeat(64));
  const st = Object.fromEntries(D.sq.prepare('SELECT sleutel, waarde FROM stand').all().map((x) => [x.sleutel, x.waarde]));
  assert.strictEqual(st.kastje_id, 'a'.repeat(32) + '.access'); assert.strictEqual(st.kastje_ip, '198.51.100.7'); assert.strictEqual(st.koppel_open_tot, undefined);
  // tweede keer dezelfde code = onbekend
  assert.strictEqual((await m.koppel('12345678')).status, 404);
  // nooit het geheim in de stand, een melding of info
  const alles = JSON.stringify([m.info(), meld, await m.appStand(), fs.readFileSync(path.join(dir, 'stand.json'), 'utf8')]);
  assert.ok(!alles.includes('b'.repeat(64)), 'geen geheim'); assert.ok(!alles.includes('198.51.100.7'), 'geen IP');
  assert.strictEqual((await m.appStand()).stand.token.ip_eis, true);
  // vijf foute codes binnen 30 min = dicht, ook voor een goede
  for (let i = 0; i < 3; i++) await m.koppel('1111111' + i);
  koppelRij(D, '22223333', nu());
  assert.strictEqual((await m.koppel('99999999')).status, 404);
  assert.strictEqual((await m.koppel('22223333')).status, 429, 'na vijf foute codes dicht');
  zet(nu() + 31 * 60000);
  assert.strictEqual((await m.koppel('22223333')).status, 404, 'na het venster weer open (code zelf intussen verlopen)');
});

test('koppelen: verlopen code geweigerd; sleutel van 2048 bits geweigerd; mislukt Access-beleid = token meteen weer weg', async () => {
  const a = opzet();
  koppelRij(a.D, '10000001', a.nu() - 700000, { verloopt: a.nu() - 100000 });
  assert.strictEqual((await a.m.koppel('10000001')).status, 404);
  koppelRij(a.D, '10000002', a.nu(), { bits: 2048 });
  assert.strictEqual((await a.m.koppel('10000002')).status, 409);
  const b = opzet({ faal: (meth) => meth === 'PUT' });
  koppelRij(b.D, '10000003', b.nu());
  const r = await b.m.koppel('10000003');
  assert.strictEqual(r.status, 503);
  assert.ok(b.C.calls.some((c) => c.methode === 'DELETE' && /service_tokens\/tok-1$/.test(c.pad)), 'token weer weg');
  assert.strictEqual(b.D.sq.prepare("SELECT COUNT(*) AS n FROM stand WHERE sleutel = 'kastje_id'").get().n, 0);
  assert.strictEqual((await b.m.appStand()).stand.gekoppeld, false);
});

test('intrekken: eerst D1 dicht, dan beleid alleen eigenaar, dan token weg; faalt Cloudflare, dan maakt de tik het af', async () => {
  const { m, D, C, nu } = opzet();
  koppelRij(D, '12345678', nu());
  assert.strictEqual((await m.koppel('12345678')).status, 200);
  const n0 = C.calls.length;
  const r = await m.intrek();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(D.sq.prepare("SELECT COUNT(*) AS n FROM stand WHERE sleutel IN ('kastje_id','kastje_ip')").get().n, 0);
  const na = C.calls.slice(n0);
  assert.strictEqual(na[0].methode, 'PUT'); assert.strictEqual(na[0].body.policies.length, 1);
  assert.ok(na.some((c) => c.methode === 'DELETE' && /tok-1$/.test(c.pad)));
  assert.strictEqual((await m.appStand()).stand.gekoppeld, false);
  // Cloudflare stuk tijdens intrekken
  const o = { faal: (meth) => meth === 'DELETE' };
  const b = opzet(o);
  koppelRij(b.D, '12345678', b.nu());
  // koppelen lukt (DELETE wordt pas bij intrekken gebruikt)
  assert.strictEqual((await b.m.koppel('12345678')).status, 200);
  const r2 = await b.m.intrek();
  assert.strictEqual(r2.status, 503);
  assert.strictEqual(b.D.sq.prepare("SELECT COUNT(*) AS n FROM stand WHERE sleutel = 'kastje_id'").get().n, 0, 'D1 al dicht');
  assert.strictEqual(b.m.info().intrek_open, true);
  b.C.calls.length = 0;
  o.faal = null;   // Cloudflare weer goed: de tik maakt het af
  await b.m.tik();
  assert.ok(b.C.calls.some((c) => c.methode === 'DELETE' && /tok-1$/.test(c.pad)), 'tik trekt het token alsnog in');
  assert.strictEqual(b.m.info().intrek_open, false);
});

test('tik: tekent opnieuw na 6 uur; meldt een vreemd adres één keer en stilte in werktijd één keer per dag', async () => {
  const { m, D, nu, zet, meld } = opzet();
  koppelRij(D, '12345678', nu());
  await m.koppel('12345678');
  await m.tik();
  const v1 = D.sq.prepare('SELECT volgnr FROM envelop').get().volgnr;
  zet(nu() + 60000); await m.tik();
  assert.strictEqual(D.sq.prepare('SELECT volgnr FROM envelop').get().volgnr, v1, 'niet elke tik');
  zet(nu() + 6 * 3600000 + 1); await m.tik();
  assert.ok(D.sq.prepare('SELECT volgnr FROM envelop').get().volgnr > v1, 'na 6 uur opnieuw');
  const t = nu();
  D.sq.prepare("INSERT INTO stand (sleutel, waarde) VALUES ('vreemd', ?)").run(JSON.stringify({ op: t, land: 'XX' }));
  await m.tik(); await m.tik();
  assert.strictEqual(meld.filter((x) => /vreemd/.test(x.k)).length, 1, 'vreemd één keer');
  // stil: maandag 16-11 is gekoppeld om 09:00Z; nu 15:00Z (16:00 Amsterdam) zonder hartslag
  const stil = meld.filter((x) => /stil/.test(x.k)).length;
  assert.ok(stil <= 1);
  zet(Date.parse('2026-11-17T09:00:00Z')); await m.tik(); await m.tik();
  assert.strictEqual(meld.filter((x) => /stil/.test(x.k)).length, stil + 1, 'volgende werkdag één keer');
  zet(Date.parse('2026-11-21T10:00:00Z')); await m.tik();   // zaterdag
  assert.strictEqual(meld.filter((x) => /stil/.test(x.k)).length, stil + 1, 'niet in het weekend');
  // met hartslag geen melding
  zet(Date.parse('2026-11-23T09:00:00Z'));
  D.sq.prepare("INSERT INTO hartslag (id, op, json, ip, land, kastje_id) VALUES (1, ?, '{\"temp_c\":51}', '198.51.100.7', 'NL', 'x') ON CONFLICT (id) DO UPDATE SET op = excluded.op").run(nu() - 60000);
  await m.tik();
  assert.strictEqual(meld.filter((x) => /stil/.test(x.k)).length, stil + 1);
  const st = (await m.appStand()).stand;
  assert.strictEqual(st.kastje.temp_c, 51); assert.ok(!JSON.stringify(st).includes('198.51.100.7'), 'geen IP naar de app');
});

test('werktijd: ma–vr 07:30–18:00 Amsterdam', () => {
  assert.strictEqual(PS.inWerktijd(Date.parse('2026-11-16T06:31:00Z')), true);   // ma 07:31 CET
  assert.strictEqual(PS.inWerktijd(Date.parse('2026-11-16T06:29:00Z')), false);
  assert.strictEqual(PS.inWerktijd(Date.parse('2026-11-16T16:59:00Z')), true);   // 17:59
  assert.strictEqual(PS.inWerktijd(Date.parse('2026-11-16T17:00:00Z')), false);
  assert.strictEqual(PS.inWerktijd(Date.parse('2026-11-14T10:00:00Z')), false);  // zaterdag
});
