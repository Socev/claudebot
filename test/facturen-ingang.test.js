'use strict';
// Toetsen van de smalle Facturen-ingang /fac (wv856, F6, 23-10-2026; bouwplan § 4.3; ontwerp + Fable-review mk-scripts/wv856/ontwerp.md).
// Echte http-server met facturen-ingang.js, echte RSA-sleutels en JWT's (zoals Cloudflare Access ze tekent), een wegwerpdatabase met zaad.
// Raakt /opt/data niet (alles in TMPDIR).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'facturen-db.js'));
const F = require(path.join(ROOT, 'facturen.js'));
const I = require(path.join(ROOT, 'facturen-ingang.js'));
const Z = require(path.join(ROOT, 'test', 'facturen-zaad.js'));
const { ibanFromAbnAccount } = require(path.join(ROOT, 'mt940-lezer.js'));

const TEAM = 'https://proef.cloudflareaccess.com';
const AUD_POD = 'a'.repeat(64), AUD_GEB = 'b'.repeat(64), AUD_APP = 'c'.repeat(64), AUD_APPPOD = 'd'.repeat(64);
const CLIENT = '0123456789abcdef0123456789abcdef.access', CLIENT_APP = 'fedcba9876543210fedcba9876543210.access';
const POORT = crypto.randomBytes(32).toString('hex');
const PM = 'praktijkmanager@voorbeeld.invalid';
const tabRij = (acct, dat, bedrag, desc) => [acct, 'EUR', dat, '1000,00', '900,00', dat, bedrag, desc].join('\t');
const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });

// ── sleutels en JWT's ──
const sleutel = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ander = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = Object.assign(sleutel.publicKey.export({ format: 'jwk' }), { kid: 'k1', alg: 'RS256', use: 'sig' });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(inh, o) {
  o = o || {};
  const kop = b64(Object.assign({ alg: 'RS256', kid: 'k1', typ: 'JWT' }, o.kop || {}));
  const lijf = b64(inh);
  if (o.hs) return kop + '.' + lijf + '.' + crypto.createHmac('sha256', JSON.stringify(JWK)).update(kop + '.' + lijf).digest('base64url');
  if (o.geen) return kop + '.' + lijf + '.';
  return kop + '.' + lijf + '.' + crypto.sign('RSA-SHA256', Buffer.from(kop + '.' + lijf), (o.ander ? ander : sleutel).privateKey).toString('base64url');
}
const nuS = () => Math.floor(Date.now() / 1000);
const dienst = (x) => Object.assign({ aud: [AUD_POD], iss: TEAM, exp: nuS() + 600, iat: nuS(), nbf: nuS() - 5, common_name: CLIENT, type: 'app', sub: '' }, x || {});
const gebruiker = (x) => Object.assign({ aud: [AUD_GEB], iss: TEAM, exp: nuS() + 3600, iat: nuS(), nbf: nuS() - 5, email: PM, type: 'app', sub: 'u1' }, x || {});

// ── opzet: database, config, server ──
let certsVragen = 0;
async function opzet(o) {
  o = o || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-ingang-'));
  WEG.push(dir);
  const fdb = D.open(dir);
  const zaad = Z.zaai(fdb, { vandaag: '2026-10-22' });
  fdb.db.prepare("UPDATE gebruiker SET actief = 1 WHERE ingang = 'fac'").run();
  const routes = F.maak({ fout: () => {} });
  const appUit = path.join(dir, 'app-uit');
  const klaar = {};
  const neem = [];
  const t = { dir, fdb, zaad, routes, appUit, klaar, neem, pmId: zaad.ids.praktijkmanager, fouten: [] };
  if (o.config !== false) zetConfig(t);
  t.ingang = I.maak({
    dir, appUit, appAud: () => AUD_APP,
    certs: async (team, kid) => { certsVragen++; if (team !== TEAM) throw new Error('ander team'); return [JWK]; },
    routes, open: () => (t.dicht ? null : fdb), primair: () => true,
    body: (req, cb) => {
      if (req.method !== 'POST') return cb(null, {});
      const delen = []; req.on('data', (c) => delen.push(c));
      req.on('end', () => { try { cb(null, JSON.parse(Buffer.concat(delen).toString('utf8') || '{}')); } catch (e) { cb('json'); } });
    },
    // nagebootst als appUpload: één bestand per verzoek, eigen map per pseudo-apparaat; wacht op het einde van de stroom
    upload: (req, res, pseudo, rest) => {
      const delen = []; req.on('data', (c) => delen.push(c));
      req.on('end', () => {
        (klaar[pseudo.id] = klaar[pseudo.id] || {})[rest] = { naam: decodeURIComponent(String(req.headers['x-app-naam'] || '')), bytes: Buffer.concat(delen) };
        stuur(res, 200, { ok: true });
      });
    },
    uploadNeem: (pseudo, beurt, n) => {
      neem.push(pseudo.id);
      const b = klaar[pseudo.id] && klaar[pseudo.id][beurt + '/' + n];
      if (!b) return null;
      return { naam: b.naam, bytes: b.bytes, weg: () => { delete klaar[pseudo.id][beurt + '/' + n]; } };
    },
    stuur, bankluisPad: path.join(dir, 'geen-bankluis.sqlite'), fout: (l, e) => t.fouten.push(l + ': ' + (e && e.message)), uploadBytes: () => t.vol || 0,
  });
  t.server = http.createServer((req, res) => (t.ingang.isPad(req) ? t.ingang.verwerk(req, res) : (res.writeHead(404), res.end())));
  await new Promise((ok) => t.server.listen(0, '127.0.0.1', ok));
  t.poort = t.server.address().port;
  t.vraag = (methode, pad, o2) => vraag(t, methode, pad, o2);
  return t;
}
function stuur(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-App-Pod': '1' });
  res.end(JSON.stringify(obj));
}
function zetConfig(t, x) {
  fs.mkdirSync(path.join(t.dir, 'ingang', 'geheim'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(t.dir, 'ingang', 'config.json'), JSON.stringify(Object.assign({ access_team: TEAM, aud_pod: AUD_POD, aud_gebruiker: AUD_GEB, servicetoken_client_id: CLIENT }, x || {})));
  fs.writeFileSync(path.join(t.dir, 'ingang', 'geheim', 'poort.key'), POORT + '\n', { mode: 0o600 });
}
function vraag(t, methode, pad, o) {
  o = o || {};
  const koppen = Object.assign({}, o.zonderPoort ? {} : { 'X-Fac-Poort': o.poort || POORT },
    o.dienst === null ? {} : { 'Cf-Access-Jwt-Assertion': o.dienst || jwt(dienst()) },
    o.gebruiker === null ? {} : { 'X-Fac-Gebruiker': o.gebruiker || jwt(gebruiker()) }, o.koppen || {});
  let lijf = null;
  if (o.ruw) { lijf = o.ruw; koppen['Content-Type'] = 'application/octet-stream'; koppen['Content-Length'] = String(lijf.length); }
  else if (o.d !== undefined) { lijf = Buffer.from(JSON.stringify(o.d)); koppen['Content-Type'] = 'application/json'; koppen['Content-Length'] = String(lijf.length); }
  return new Promise((ok, mis) => {
    const r = http.request({ host: '127.0.0.1', port: t.poort, method: methode, path: pad, headers: koppen }, (res) => {
      const delen = []; res.on('data', (c) => delen.push(c));
      res.on('end', () => { const tekst = Buffer.concat(delen).toString('utf8'); let j = null; try { j = JSON.parse(tekst); } catch (e) {} ok({ status: res.statusCode, j, tekst, koppen: res.headers }); });
    });
    r.on('error', mis);
    if (lijf) r.write(lijf);
    r.end();
  });
}
async function sluit(t) { await new Promise((ok) => t.server.close(ok)); try { t.fdb.db.close(); } catch (e) {} }

// ───────────────────────────── slapend en kapot ─────────────────────────────

test('zonder config is /fac 404 (slapend); kapotte config 503; /health-info zegt welke', async () => {
  const t = await opzet({ config: false });
  try {
    let r = await t.vraag('GET', '/fac/wie');
    assert.equal(r.status, 404);
    assert.deepEqual(t.ingang.info(), { ingericht: false, staat: 'afwezig', uit: false });
    for (const [x, reden] of [[{ aud_gebruiker: AUD_POD }, 'aud gelijk'], [{ aud_gebruiker: AUD_APP }, 'aud van de Socev-app'], [{ aud_pod: 'xyz' }, 'aud'],
      [{ access_team: 'https://elders.example' }, 'team'], [{ servicetoken_client_id: 'kort' }, 'client-id']]) {
      zetConfig(t, x);
      await new Promise((ok) => setTimeout(ok, 0));
      // config staat 10 s in het geheugen: een nieuwe ingang per geval
      const i2 = I.maak({ dir: t.dir, appUit: t.appUit, appAud: () => AUD_APP, certs: async () => [JWK], routes: t.routes, open: () => t.fdb, primair: () => true });
      assert.equal(i2.info().staat, 'kapot: ' + reden, JSON.stringify(x));
    }
    zetConfig(t);
    fs.chmodSync(path.join(t.dir, 'ingang', 'geheim', 'poort.key'), 0o644);
    const i3 = I.maak({ dir: t.dir, appUit: t.appUit, appAud: () => AUD_APP, certs: async () => [JWK], routes: t.routes, open: () => t.fdb, primair: () => true });
    assert.equal(i3.info().staat, 'kapot: poortgeheim niet 0600');
    fs.chmodSync(path.join(t.dir, 'ingang', 'geheim', 'poort.key'), 0o600);
    fs.writeFileSync(path.join(t.dir, 'ingang', 'config.json'), '{kapot');
    const i4 = I.maak({ dir: t.dir, appUit: t.appUit, appAud: () => AUD_APP, certs: async () => [JWK], routes: t.routes, open: () => t.fdb, primair: () => true, stuur });
    assert.equal(i4.info().staat, 'kapot: config geen json');
    const s4 = http.createServer((q, s) => i4.verwerk(q, s));
    await new Promise((ok) => s4.listen(0, '127.0.0.1', ok));
    const r4 = await vraag({ poort: s4.address().port }, 'GET', '/fac/wie');
    assert.equal(r4.status, 503, 'kapot = 503, niet stil');
    await new Promise((ok) => s4.close(ok));
  } finally { await sluit(t); }
});

// ───────────────────────────── poortgeheim en servicetoken ─────────────────────────────

test('poortgeheim en Access-bewijs van de pod-ingang: elke afwijking 403', async () => {
  const t = await opzet();
  try {
    assert.equal((await t.vraag('GET', '/fac/wie')).status, 200, 'alles goed');
    assert.equal((await t.vraag('GET', '/fac/wie', { zonderPoort: true })).status, 403, 'zonder poortgeheim');
    assert.equal((await t.vraag('GET', '/fac/wie', { poort: 'f'.repeat(64) })).status, 403, 'fout poortgeheim');
    const gevallen = [
      ['zonder servicetoken-bewijs', null],
      ['aud van de app-pod (app-servicetoken)', jwt(dienst({ aud: [AUD_APPPOD], common_name: CLIENT_APP }))],
      ['goede aud, client-id van de app', jwt(dienst({ common_name: CLIENT_APP }))],
      ['aud van de gebruikers-app', jwt(dienst({ aud: [AUD_GEB] }))],
      ['getekend met een andere sleutel', jwt(dienst(), { ander: true })],
      ['alg none', jwt(dienst(), { kop: { alg: 'none' }, geen: true })],
      ['HS256 met de publieke sleutel', jwt(dienst(), { kop: { alg: 'HS256' }, hs: true })],
      ['onbekende kid', jwt(dienst(), { kop: { kid: 'k9' } })],
      ['verlopen', jwt(dienst({ exp: nuS() - 120 }))],
      ['nog niet geldig', jwt(dienst({ nbf: nuS() + 600 }))],
      ['ander team (iss)', jwt(dienst({ iss: 'https://ander.cloudflareaccess.com' }))],
      ['gebruikers-JWT als servicetoken', jwt(gebruiker({ aud: [AUD_POD] }))],
      ['rommel', 'a.b'],
      ['te lang', 'a'.repeat(9000) + '.b.c'],
    ];
    for (const [wat, tok] of gevallen) {
      const r = await t.vraag('GET', '/fac/wie', { dienst: tok });
      assert.equal(r.status, 403, wat);
      assert.equal(r.j.fout, 'niet toegestaan', wat + ': geen detail naar buiten');
    }
    const r = await t.vraag('GET', '/fac/wie', { dienst: jwt(dienst({ aud: ['iets', AUD_POD, 'meer'] })) });
    assert.equal(r.status, 200, 'aud als lijst met extra waarden');
  } finally { await sluit(t); }
});

// ───────────────────────────── gebruikers-JWT ─────────────────────────────

test('gebruikers-JWT verplicht: zonder, verkeerde aud, servicetoken, verlopen, onbekend of inactief → 403', async () => {
  const t = await opzet();
  try {
    const gevallen = [
      ['zonder gebruikers-JWT', null],
      ['JWT van de Socev-app (andere aud)', jwt(gebruiker({ aud: [AUD_APP], email: 'david@voorbeeld.invalid' }))],
      ['JWT met aud van de pod-ingang', jwt(gebruiker({ aud: [AUD_POD] }))],
      ['servicetoken-JWT als gebruiker', jwt(dienst({ aud: [AUD_GEB] }))],
      ['verlopen', jwt(gebruiker({ exp: nuS() - 120 }))],
      ['andere sleutel', jwt(gebruiker(), { ander: true })],
      ['ander team', jwt(gebruiker({ iss: 'https://ander.cloudflareaccess.com' }))],
      ['zonder e-mail', jwt(gebruiker({ email: undefined }))],
      ['onbekende e-mail', jwt(gebruiker({ email: 'iemand@voorbeeld.invalid' }))],
    ];
    for (const [wat, tok] of gevallen) assert.equal((await t.vraag('GET', '/fac/wie', { gebruiker: tok })).status, 403, wat);
    const r = await t.vraag('GET', '/fac/wie', { gebruiker: jwt(gebruiker({ email: '  PraktijkManager@Voorbeeld.INVALID ' })) });
    assert.equal(r.status, 200, 'hoofdletters en witruimte');
    assert.equal(r.j.email, PM);
    assert.equal(r.j.rol, 'praktijkmanager');
    t.fdb.db.prepare("UPDATE gebruiker SET actief = 0 WHERE ingang = 'fac'").run();
    assert.equal((await t.vraag('GET', '/fac/wie')).status, 403, 'inactief');
  } finally { await sluit(t); }
});

// ───────────────────────────── via fac nooit eigenaar ─────────────────────────────

test('via fac nooit eigenaar: de database weigert het, rolVoor geeft praktijkmanager', async () => {
  const t = await opzet();
  try {
    assert.throws(() => D.voegToe(t.fdb, 'gebruiker', { id: '00000000000000aa', email: 'eig@voorbeeld.invalid', ingang: 'fac', rol: 'eigenaar' }), /gebruiker_fac/);
    assert.throws(() => t.fdb.db.prepare("UPDATE gebruiker SET rol = 'eigenaar' WHERE ingang = 'fac'").run(), /gebruiker_fac/);
    assert.throws(() => D.voegToe(t.fdb, 'gebruiker', { id: '00000000000000ab', email: 'Hoofd@Voorbeeld.invalid', ingang: 'fac', rol: 'praktijkmanager' }), /gebruiker_fac/, 'kleine letters');
    assert.throws(() => t.fdb.db.prepare("UPDATE gebruiker SET ingang = 'fac', email = 'x@voorbeeld.invalid' WHERE ingang = 'app'").run(), /gebruiker_fac/, 'de app-eigenaar kan geen fac-rij worden');
    // ook als de code ooit een eigenaar zou teruggeven: de ingang eist praktijkmanager
    const stuk = Object.assign({}, t.routes, { rolVoor: () => ({ soort: 'eigenaar', wie: PM, entiteiten: null, ingang: 'fac', id: t.pmId }) });
    const i2 = I.maak({ dir: t.dir, appUit: t.appUit, appAud: () => AUD_APP, certs: async () => [JWK], routes: stuk, open: () => t.fdb, primair: () => true, stuur,
      body: (q, cb) => cb(null, {}) });
    const s2 = http.createServer((q, s) => i2.verwerk(q, s));
    await new Promise((ok) => s2.listen(0, '127.0.0.1', ok));
    assert.equal((await vraag({ poort: s2.address().port }, 'GET', '/fac/facturen/instellingen')).status, 403);
    await new Promise((ok) => s2.close(ok));
  } finally { await sluit(t); }
});

// ───────────────────────────── praktijkmanager-scope ─────────────────────────────

test('praktijkmanager: geen Privé, geen POT-rekening, geen Instellingen, geen Nagebeld; namen van eigen entiteiten', async () => {
  const t = await opzet();
  try {
    let r = await t.vraag('GET', '/fac/facturen');
    assert.equal(r.status, 200, r.tekst);
    const ov = r.j;
    assert.equal(r.j.rol, 'praktijkmanager');
    assert.ok(Array.isArray(r.j.entiteiten) && r.j.entiteiten.length > 0);
    assert.ok(!r.j.entiteiten.some((e) => e.sleutel === 'prive'), 'geen Privé in de namen');
    assert.ok(r.j.entiteiten.every((e) => e.naam), 'met naam');
    assert.ok(!r.j.gezondheid.rekeningen.some((k) => k.entiteit === 'pot' || k.entiteit === 'prive'), 'geen POT- of Privé-rekening');
    r = await t.vraag('GET', '/fac/facturen/lijst/beoordelen');
    assert.equal(r.status, 200);
    assert.ok(r.j.facturen.length > 0);
    assert.ok(r.j.facturen.every((f) => f.entiteit && f.entiteit !== 'prive' && !f.patientkenmerk));
    for (const [m, p, d] of [['GET', '/fac/facturen/lijst/prive'], ['GET', '/fac/facturen/instellingen'], ['POST', '/fac/facturen/instellingen/adres', { entiteit: 'tolgaarde', boekhoud_doel: 'x@voorbeeld.invalid' }],
      ['POST', '/fac/facturen/instellingen/modus', { modus: 'versturen' }], ['POST', '/fac/facturen/instellingen/rekening', { iban: 'NL00TEST0000000001', entiteit: 'tolgaarde' }], ['POST', '/fac/facturen/bankluis', {}]]) {
      assert.equal((await t.vraag(m, p, { d })).status, 403, m + ' ' + p);
    }
    const bank = await t.vraag('GET', '/fac/facturen/bank');
    assert.equal(bank.status, 200);
    assert.ok(bank.j.signalen.every((s) => s.entiteit && s.entiteit !== 'prive' && s.alleen_eigenaar !== true), 'geen Privé- of eigenaarsignalen');
    // een Privé-factuur bestaat in het zaad, maar is via fac onzichtbaar (404, niet 403: geen bevestiging dat hij bestaat)
    const prive = t.fdb.db.prepare("SELECT id FROM factuur WHERE entiteit = 'prive' LIMIT 1").get();
    assert.ok(prive, 'zaad heeft een Privé-factuur');
    const rp = await t.vraag('GET', '/fac/facturen/factuur/' + prive.id);
    assert.ok(rp.status === 404 || rp.status === 403, String(rp.status));
    // Nagebeld: nooit via fac
    const ents = ov.entiteiten.map((e) => e.sleutel);
    const nieuw = t.fdb.db.prepare("SELECT id, entiteit FROM factuur WHERE status = 'te_beoordelen' AND iban_nieuw = 1 AND patientkenmerk = 0 AND alleen_eigenaar = 0 AND entiteit <> 'prive'").all()
      .find((x) => ents.includes(x.entiteit));
    assert.ok(nieuw, 'zaad heeft een factuur met een nieuw IBAN');
    const nb = await t.vraag('POST', '/fac/facturen/nagebeld', { d: { id: nieuw.id } });
    assert.equal(nb.status, 403, nb.tekst);
    assert.equal(nb.j.alleen_david, true);
  } finally { await sluit(t); }
});

test('mag_bevestigen 0 → Bevestigen 403; anders gewoon bevestigen (naar de wachtrij)', async () => {
  const t = await opzet();
  try {
    const f = t.fdb.db.prepare("SELECT id, entiteit, versie FROM factuur WHERE status = 'te_beoordelen' AND entiteit IN ('tolgaarde','groenhouten') AND patientkenmerk = 0 AND alleen_eigenaar = 0 AND iban_nieuw = 0 ORDER BY id").all();
    let gelukt = null;
    for (const x of f) {
      const r = await t.vraag('POST', '/fac/facturen/bevestig', { d: { id: x.id, entiteit: x.entiteit, betaalwijze: 'incasso' } });
      if (r.status === 200) { gelukt = x; break; }
    }
    assert.ok(gelukt, 'een gewone factuur is te bevestigen via fac');
    assert.equal(t.fdb.db.prepare('SELECT bevestigd_door AS b FROM factuur WHERE id = ?').get(gelukt.id).b, PM);
    t.fdb.db.prepare("UPDATE gebruiker SET mag_bevestigen = 0 WHERE ingang = 'fac'").run();
    const ander = f.find((x) => x.id !== gelukt.id);
    const r = await t.vraag('POST', '/fac/facturen/bevestig', { d: { id: ander.id, entiteit: ander.entiteit, betaalwijze: 'incasso' } });
    assert.equal(r.status, 403);
    assert.match(r.j.fout, /alleen kijken en uploaden/);
    assert.equal((await t.vraag('GET', '/fac/wie')).j.mag_bevestigen, false);
    // alleen kijken en uploaden: elke andere POST 403 (ook opnieuw, terugdraaien, wijzigen), lezen en uploaden wel
    for (const route of ['opnieuw', 'terugdraaien', 'wijzig', 'ingevoerd', 'signaal', 'leverancier', 'koppel', 'geen-factuur'])
      assert.equal((await t.vraag('POST', '/fac/facturen/' + route, { d: { id: gelukt.id } })).status, 403, route);
    assert.equal((await t.vraag('GET', '/fac/facturen/lijst/beoordelen')).status, 200);
    assert.equal((await t.vraag('POST', '/fac/upload/beurt-0099/1', { ruw: Buffer.from('x'), koppen: { 'X-App-Naam': 'a.tab' } })).status, 200);
    assert.notEqual((await t.vraag('POST', '/fac/facturen/upload', { d: { beurt: 'beurt-0099', n: 1 } })).status, 403);
    // en in facturen.js zelf (tweede laag): Bevestigen weigert bij mag_bevestigen 0
    const pm = F.rolVoor(t.fdb, { ingang: 'fac', email: PM });
    const b = t.routes.app(t.fdb, { methode: 'POST', pad: '/app/facturen/bevestig', d: { id: ander.id, entiteit: ander.entiteit, betaalwijze: 'incasso' }, rol: pm, primair: true, versOk: () => false, versVerbruik: () => {} });
    assert.equal(b.status, 403); assert.match(b.j.fout, /bevestigen staat voor jou uit/);
  } finally { await sluit(t); }
});

// ───────────────────────────── uploads ─────────────────────────────

test('upload: eigen map per gebruiker, overname via /fac/facturen/upload; een rekening alleen-eigenaar geweigerd; hooguit 2 tegelijk', async () => {
  const t = await opzet();
  try {
    const eig = F.rolVoor(t.fdb, { ingang: 'app', wie: 'david (proef)' });
    const zet = (iban, entiteit, eigen) => t.routes.app(t.fdb, { methode: 'POST', pad: '/app/facturen/instellingen/rekening', d: { iban, entiteit, bank: 'ABN', bank_formaat: 'abn_tab', controle: 1, alleen_eigenaar: eigen },
      rol: eig, primair: true, versOk: () => false, versVerbruik: () => {} });
    assert.equal(zet(ibanFromAbnAccount('0000000031'), 'tolgaarde', 0).status, 200);
    assert.equal(zet(ibanFromAbnAccount('0000000033'), 'tolgaarde', 1).status, 200);
    let r = await t.vraag('POST', '/fac/upload/beurt-0001/1', { ruw: Buffer.from(tabRij('0000000031', '20261021', '-12,50', 'ABN AMRO Bank N.V.               Rente en/of kosten') + '\n'), koppen: { 'X-App-Naam': 'export.tab' } });
    assert.equal(r.status, 200, r.tekst);
    assert.ok(t.klaar['fac-' + t.pmId]['beurt-0001/1'], 'map per gebruiker (fac-<id>)');
    r = await t.vraag('POST', '/fac/facturen/upload', { d: { beurt: 'beurt-0001', n: 1, soort: 'auto' } });
    assert.equal(r.status, 200, r.tekst);
    assert.equal(r.j.soort, 'bank');
    assert.deepEqual(t.neem, ['fac-' + t.pmId]);
    await t.vraag('POST', '/fac/upload/beurt-0002/1', { ruw: Buffer.from(tabRij('0000000033', '20261021', '-3,00', 'BEA, Betaalpas y') + '\n'), koppen: { 'X-App-Naam': 'eig.tab' } });
    r = await t.vraag('POST', '/fac/facturen/upload', { d: { beurt: 'beurt-0002', n: 1 } });
    assert.equal(r.status, 403, 'rekening alleen-eigenaar');
    assert.equal(t.klaar['fac-' + t.pmId]['beurt-0002/1'], undefined, 'ook bij weigering opgeruimd');
    // GET op het uploadpad bestaat niet
    assert.equal((await t.vraag('GET', '/fac/upload/beurt-0003/1')).status, 404);
    // twee lopende stromen tegelijk: de derde wacht niet maar krijgt 429
    const open = [];
    for (let i = 0; i < 2; i++) {
      open.push(await new Promise((ok) => {
        const q = http.request({ host: '127.0.0.1', port: t.poort, method: 'POST', path: '/fac/upload/beurt-001' + i + '/1',
          headers: { 'X-Fac-Poort': POORT, 'Cf-Access-Jwt-Assertion': jwt(dienst()), 'X-Fac-Gebruiker': jwt(gebruiker()), 'Content-Type': 'application/octet-stream', 'Content-Length': '10', 'X-App-Naam': 'a.tab' } });
        q.on('error', () => {});
        q.write('abc');
        setTimeout(() => ok(q), 150);
      }));
    }
    r = await t.vraag('POST', '/fac/upload/beurt-0020/1', { ruw: Buffer.from('x'), koppen: { 'X-App-Naam': 'b.tab' } });
    assert.equal(r.status, 429, r.tekst);
    for (const q of open) q.destroy();
    await new Promise((ok) => setTimeout(ok, 100));
    t.vol = 61 * 1024 * 1024;
    r = await t.vraag('POST', '/fac/upload/beurt-0021/1', { ruw: Buffer.from('x'), koppen: { 'X-App-Naam': 'c.tab' } });
    assert.equal(r.status, 507, 'alles via de ingang samen hooguit 60 MB');
    t.vol = 0;
  } finally { await sluit(t); }
});

// ───────────────────────────── noodstop, paden, audit ─────────────────────────────

test('noodstop (app-uit of ingang/uit) → 503; onbekende paden en methoden 404', async () => {
  const t = await opzet();
  try {
    for (const p of ['/fac', '/fac/', '/fac/app/beurt', '/fac/../app/status', '/fac/WIE', '/fac/facturen/%2e%2e', '/fac/x', '/fac/facturenx', '/fac/upload/kort/1']) {
      const r = await t.vraag('GET', p);
      assert.equal(r.status, 404, p);
    }
    assert.equal((await t.vraag('PUT', '/fac/wie')).status, 404);
    fs.writeFileSync(t.appUit, '');
    assert.equal((await t.vraag('GET', '/fac/wie')).status, 503);
    fs.rmSync(t.appUit);
    fs.writeFileSync(path.join(t.dir, 'ingang', 'uit'), '');
    assert.equal((await t.vraag('GET', '/fac/wie')).status, 503);
    fs.rmSync(path.join(t.dir, 'ingang', 'uit'));
    assert.equal((await t.vraag('GET', '/fac/wie')).status, 200);
  } finally { await sluit(t); }
});

test('audit: route, status, gebruiker-id; nooit een e-mail of JWT; bestand 0600', async () => {
  const t = await opzet();
  try {
    const g = jwt(gebruiker());
    await t.vraag('GET', '/fac/facturen', { gebruiker: g });
    await t.vraag('GET', '/fac/wie', { gebruiker: jwt(gebruiker({ email: 'iemand@voorbeeld.invalid' })) });
    await t.vraag('GET', '/fac/wie', { poort: 'f'.repeat(64) });
    await new Promise((ok) => setTimeout(ok, 50));
    const f = path.join(t.dir, 'ingang', 'audit.jsonl');
    const tekst = fs.readFileSync(f, 'utf8');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.ok(!/@/.test(tekst), 'geen e-mailadres');
    assert.ok(!tekst.includes(g.split('.')[1]) && !/eyJ/.test(tekst), 'geen JWT');
    assert.ok(!tekst.includes(POORT), 'geen poortgeheim');
    const regels = tekst.trim().split('\n').map((x) => JSON.parse(x));
    assert.ok(regels.some((x) => x.status === 200 && x.gebruiker === t.pmId));
    assert.ok(regels.some((x) => x.status === 403 && x.reden === 'poortgeheim'));
  } finally { await sluit(t); }
});

// ───────────────────────────── /app/* weigert het fac-servicetoken ─────────────────────────────

test('het fac-servicetoken komt niet door de app-poort (appAccessOk uit server.js)', async () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const knip = (begin, eind) => { const i = server.indexOf(begin); assert.ok(i > 0, begin); const j = server.indexOf(eind, i); return server.slice(i, j); };
  const code = knip('function appGelijk(a, b)', '\nfunction appLeesJson') + '\n' + knip('function appB64Json(s)', '\nfunction appBody(');
  const ctx = { Buffer, crypto, appCerts: async () => [JWK], Date, Math, JSON, Array, String };
  vm.createContext(ctx);
  vm.runInContext(code + '\nthis.appAccessOk = appAccessOk;', ctx);
  const cfg = { team: TEAM, aud: AUD_APPPOD, clientId: CLIENT_APP };
  const q = (tok) => ({ headers: { 'cf-access-jwt-assertion': tok } });
  assert.equal(await ctx.appAccessOk(q(jwt(dienst({ aud: [AUD_APPPOD], common_name: CLIENT_APP }))), cfg), null, 'app-servicetoken zelf: door');
  assert.equal(await ctx.appAccessOk(q(jwt(dienst())), cfg), 'aud', 'fac-servicetoken (aud fac-pod): geweigerd');
  assert.equal(await ctx.appAccessOk(q(jwt(dienst({ aud: [AUD_APPPOD] }))), cfg), 'servicetoken', 'fac-client-id met app-aud: geweigerd');
  assert.equal(await ctx.appAccessOk(q(jwt(gebruiker({ aud: [AUD_APPPOD] }))), cfg), 'servicetoken', 'gebruikers-JWT: geweigerd');
});

test('server.js: /fac vóór handleRequest, zonder module 404; /health noemt de ingang', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const i = server.indexOf('if (facturenIngangIsPad(req))'), j = server.indexOf('handleRequest(req, res);\n  } catch');
  assert.ok(i > 0 && j > i, '/fac wordt vóór handleRequest afgehandeld');
  assert.match(server, /facturen_ingang: facturenIngangInfo\(\)/);
  assert.match(server, /if \(facturenIngang\) return facturenIngang\.verwerk\(req, res\);\n\s*req\.resume\(\); res\.writeHead\(404/);
  assert.match(server, /appTeller\(String\(a\.id\)\.indexOf\('fac-'\) === 0 \? 'upload-fac' : 'upload'/, 'eigen uploadteller voor de ingang');
  assert.match(server, /'upload-fac': \[\]/);
  assert.match(server, /const routes = require\(path\.join\(__dirname, 'facturen\.js'\)\)\.maak\(/, 'eigen routes-instantie (documentteller)');
});

// ───────────────────────────── gebruikersbeheer ─────────────────────────────

test('tools/facturen-gebruiker.js: zet (kleine letters, alle actieve entiteiten behalve Privé), uit, nooit eigenaar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-gebruiker-'));
  WEG.push(dir);
  const fdb = D.open(dir); Z.zaai(fdb, { vandaag: '2026-10-22' }); fdb.db.close();
  process.env.FACTUREN_DIR = dir;
  delete require.cache[require.resolve(path.join(ROOT, 'tools', 'facturen-gebruiker.js'))];
  const G = require(path.join(ROOT, 'tools', 'facturen-gebruiker.js'));
  const log = console.log; const uit = []; console.log = (x) => uit.push(String(x));
  try {
    G.hoofd(['zet', ' Nieuw.Iemand@Voorbeeld.Invalid ', '--geen-bevestigen']);
    G.hoofd(['lijst']);
  } finally { console.log = log; }
  assert.ok(!uit.join('\n').includes('nieuw.iemand@'), 'adres gemaskeerd in de uitvoer');
  const f2 = D.open(dir);
  const g = f2.db.prepare("SELECT * FROM gebruiker WHERE email = 'nieuw.iemand@voorbeeld.invalid'").get();
  assert.equal(g.ingang, 'fac'); assert.equal(g.rol, 'praktijkmanager'); assert.equal(g.mag_bevestigen, 0); assert.equal(g.actief, 1);
  const ents = f2.db.prepare('SELECT entiteit FROM gebruiker_entiteit WHERE gebruiker = ?').all(g.id).map((r) => r.entiteit);
  const actief = f2.db.prepare("SELECT sleutel FROM entiteit WHERE actief = 1 AND sleutel <> 'prive'").all().map((r) => r.sleutel);
  assert.deepEqual(ents.sort(), actief.sort());
  assert.ok(!ents.includes('prive'));
  f2.db.close();
  console.log = () => {};
  try { G.hoofd(['uit', 'nieuw.iemand@voorbeeld.invalid']); } finally { console.log = log; }
  const f3 = D.open(dir);
  assert.equal(f3.db.prepare("SELECT actief FROM gebruiker WHERE email = 'nieuw.iemand@voorbeeld.invalid'").get().actief, 0);
  f3.db.close();
  assert.throws(() => G.hoofd(['zet', 'geen-adres']), /geldig e-mailadres/);
});
