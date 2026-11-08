'use strict';
// Toetsen van MemoryLane op memorylane.socev.dev, de pod-kant (wv2636): kringen per herinnering (voorstel + Davids keuze), één
// publicatiebeslissing, vast schema (dicht huis = alleen het jaar), geen pod-ids of Immich-ids buiten, metadata uit de foto's, dicht gaan met
// blok + opruimen (ook als R2 even faalt), bezoekerslijst alleen bij status bevestigd, noodstop en houdbaarheid.
// Nep-D1 = node:sqlite met D1_SCHEMA uit memorylane-publiek.js; nep-R2 = Map. ALLEEN VERZONNEN namen, adressen en tekst.
// Aanroep: bash test/memorylane-publiek.sh
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const IM = require(path.join(ROOT, 'immich.js'));
const I = require(path.join(ROOT, 'intake-ingang.js'));
const H = require(path.join(ROOT, 'herinneringen.js'));
const M = require(path.join(ROOT, 'memorylane-delen.js'));
const MP = require(path.join(ROOT, 'memorylane-publiek.js'));
const VV = require(path.join(ROOT, 'vault-veilig.js'));
const P = require(path.join(ROOT, 'intake', 'patientpoort.js'));
const uuid = () => crypto.randomUUID();

function nepImmich() {
  const st = { albums: [], beelden: new Map(), video: new Set(), meta: new Map(), prullenbak: new Set(), uit: false, log: [], patches: [], sleutel: 'proefsleutel-verzonnen-0123456789' };
  const res = (status, obj, ct) => new Response(Buffer.isBuffer(obj) ? obj : JSON.stringify(obj), { status, headers: { 'content-type': ct || 'application/json; charset=utf-8' } });
  st.fetch = async (url, init) => {
    const u = new URL(url), m = init.method;
    st.log.push(m + ' ' + u.pathname + u.search);
    if (st.uit) throw new Error('ECONNREFUSED');
    if (init.headers['x-api-key'] !== st.sleutel) return res(401, { message: 'Invalid API key' });
    if (init.redirect !== 'manual') return res(500, { message: 'redirect niet manual' });
    let r;
    if (m === 'GET' && u.pathname === '/api/albums') return res(200, st.albums.map((a) => ({ id: a.id, albumName: a.albumName, description: a.description, assetCount: a.assets.length, albumThumbnailAssetId: a.assets[0] || null })));
    if (m === 'POST' && u.pathname === '/api/albums') {
      const b = JSON.parse(init.body);
      const a = { id: uuid(), albumName: b.albumName, description: b.description || '', assets: [] };
      st.albums.push(a);
      return res(201, { id: a.id, albumName: a.albumName, description: a.description, assetCount: 0, albumThumbnailAssetId: null });
    }
    if (m === 'PATCH' && (r = /^\/api\/albums\/([0-9a-f-]{36})$/.exec(u.pathname))) {
      const a = st.albums.find((x) => x.id === r[1]); if (!a) return res(404, {});
      const b = JSON.parse(init.body); st.patches.push({ id: a.id, body: b }); a.albumName = b.albumName;
      return res(200, { id: a.id, albumName: a.albumName, description: a.description, assetCount: a.assets.length });
    }
    if (m === 'GET' && (r = /^\/api\/albums\/([0-9a-f-]{36})$/.exec(u.pathname))) { const a = st.albums.find((x) => x.id === r[1]); return a ? res(200, { id: a.id, albumName: a.albumName, description: a.description, assetCount: a.assets.length }) : res(404, {}); }
    if (m === 'GET' && u.pathname === '/api/timeline/buckets') { const a = st.albums.find((x) => x.id === u.searchParams.get('albumId')); return res(200, a && a.assets.length ? [{ timeBucket: '2020-02-01', count: Math.min(3, a.assets.length) }, ...(a.assets.length > 3 ? [{ timeBucket: '2020-03-01', count: a.assets.length - 3 }] : [])] : []); }
    if (m === 'GET' && u.pathname === '/api/timeline/bucket') {
      if (st.bucketUit) return res(500, { message: 'nep: maand stuk' });
      const a = st.albums.find((x) => x.id === u.searchParams.get('albumId'));
      const ids = !a ? [] : u.searchParams.get('timeBucket') === '2020-02-01' ? a.assets.slice(0, 3) : a.assets.slice(3);
      const r0 = { id: ids, isImage: ids.map((x) => !st.video.has(x)), isTrashed: ids.map((x) => st.prullenbak.has(x)), ratio: ids.map(() => 1.5),
        fileCreatedAt: ids.map((x) => (st.meta.get(x) || {}).t || '2020-02-10T10:00:00.000Z'), localOffsetHours: ids.map((x) => (st.meta.get(x) || {}).off ?? 1) };
      // wv2468: plek alleen met withCoordinates=true (zoals Immich 3)
      if (u.searchParams.get('withCoordinates') === 'true') { r0.latitude = ids.map((x) => (st.meta.get(x) || {}).lat ?? null); r0.longitude = ids.map((x) => (st.meta.get(x) || {}).lon ?? null); }
      return res(200, r0);
    }
    if (m === 'GET' && (r = /^\/api\/assets\/([0-9a-f-]{36})\/thumbnail$/.exec(u.pathname))) { const b = st.beelden.get(r[1]); return b ? res(200, b.buf, b.mime) : res(404, {}); }
    return res(404, { message: 'nep: onbekend' });
  };
  st.client = IM.maak({ basis: 'https://immich.proef.invalid', sleutel: async () => st.sleutel, fetch: st.fetch });
  st.foto = (album, buf, mime) => { const id = uuid(); st.beelden.set(id, { buf, mime: mime || 'image/webp' }); album.assets.push(id); return id; };
  st.davidsEigen = () => { const a = { id: uuid(), albumName: 'Vakantie 2019 (eigen album)', description: 'van David', assets: [] }; st.albums.push(a); return a; };
  return st;
}


// verzonnen beelden mét metadata
function jpeg() {
  const seg = (m, data) => { const l = Buffer.alloc(2); l.writeUInt16BE(data.length + 2); return Buffer.concat([Buffer.from([0xFF, m]), l, data]); };
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), seg(0xE0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')), seg(0xE1, Buffer.from('Exif\0\0GPS-verzonnen-52.1', 'latin1')),
    seg(0xE1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x>Proefcamera</x>', 'latin1')), seg(0xED, Buffer.from('Photoshop 3.0\0IPTC-verzonnen', 'latin1')),
    seg(0xFE, Buffer.from('commentaar-verzonnen', 'latin1')), seg(0xE2, Buffer.from('ICC_PROFILE\0\x01\x01proef', 'latin1')),
    seg(0xDB, Buffer.alloc(65, 1)), seg(0xC0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])), seg(0xDA, Buffer.from([1, 1, 0, 0, 0x3F, 0])), Buffer.from([0x12, 0x34, 0xFF, 0x00, 0x56]), Buffer.from([0xFF, 0xD9])]);
}
function webp() {
  const chunk = (id, data) => { const l = Buffer.alloc(4); l.writeUInt32LE(data.length); return Buffer.concat([Buffer.from(id, 'latin1'), l, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x08 | 0x04;
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), chunk('VP8X', vp8x), chunk('VP8L', Buffer.from([1, 2, 3, 4, 5])), chunk('EXIF', Buffer.from('Exif\0\0GPS-verzonnen-52.1')), chunk('XMP ', Buffer.from('<x>Proefcamera</x>'))]);
  const kop = Buffer.alloc(8); kop.write('RIFF', 0, 'latin1'); kop.writeUInt32LE(body.length, 4);
  return Buffer.concat([kop, body]);
}
const METADATA = /GPS-verzonnen|Proefcamera|IPTC-verzonnen|commentaar-verzonnen|Exif/;

// verzonnen bezoekerslijst (zelfde vorm als de vaultpagina)
function lijst(status) {
  return '---\ntype: lijst\nstatus: ' + status + '\n---\n# Wie MemoryLane mag bekijken\n\n| Naam | Kring | Mailadressen | Bewust niet |\n|---|---|---|---|\n' +
    '| Proefnicht Ada | familie | ada@voorbeeld.invalid · Ada.Twee@Voorbeeld.invalid | werkadres |\n| Kornelis Verzonnen | shizzle | kornelis@voorbeeld.invalid | |\n' +
    '| Dubbel Proef | shizzle | ada@voorbeeld.invalid | |\n| Zonder Adres | familie | | |\n| Iemand Anders | vrienden | x@voorbeeld.invalid | |\n';
}

function omgeving() {
  const basis = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-publiek-toets-'));
  const idir = path.join(basis, 'intake'), vault = path.join(basis, 'vault'), hdir = path.join(basis, 'herinneringen');
  for (const m of [idir, vault, path.join(vault, '20_Prive/Reizen'), path.join(vault, H.NOTITIE_MAP), path.join(vault, M.MAP)]) fs.mkdirSync(m, { recursive: true });
  const klok = { t: Date.parse('2026-11-08T12:00:00Z') };
  const ing = I.maak({ dir: idir, vault, profielenDir: path.join(ROOT, 'intake', 'profielen'), filterPad: path.join(ROOT, 'bisync-filter.txt'),
    primair: () => true, vv: VV, nu: () => klok.t, fout: () => {}, marker: P, nachtgrendel: () => false, vrijeBytes: () => 50 * 1024 ** 3, stuur: () => {} });
  H.maak({ dir: hdir, intake: ing, vault, vv: VV, nu: () => klok.t, fout: () => {}, whisper: async () => '', kanUitschrijven: () => false,
    onderhoudAan: () => false, nachtgrendel: () => false, primair: () => true, kaartZet: async () => ({}), kaartLijst: async () => ({}), box: () => {}, offsiteAan: () => false });
  const im = nepImmich();
  const fouten = [];
  const ml = M.maak({ db: ing._db, vault, vv: VV, dir: hdir, d1: async () => ({ ok: true, rijen: [] }), kluis: async () => null, marker: P, geheimen: () => ['nepgeheim-0123456789abcdef'],
    categorieen: H.CATEGORIEEN, onderhoudAan: () => false, nachtgrendel: () => false, nu: () => klok.t, fout: (l, e) => fouten.push(l + ': ' + (e && e.message)),
    reisVandaag: () => '2026-11-08', immich: im.client });
  const d1db = new DatabaseSync(':memory:');
  const st = { d1Uit: false, r2Uit: false, r2: new Map(), batches: 0 };
  const d1 = async (batch) => {
    if (st.d1Uit) throw new Error('D1 gaf HTTP 500');
    st.batches++;
    if (st.hook) st.hook(batch);
    return batch.map((q) => { const s = d1db.prepare(q.sql); return /^\s*SELECT/i.test(q.sql) ? { results: s.all(...q.params) } : (s.run(...q.params), { results: [] }); });
  };
  const r2 = { put: async (k, b, m) => { if (st.r2Uit) throw new Error('R2 put HTTP 500'); st.r2.set(k, { b: Buffer.from(b), m }); },
    del: async (k) => { if (st.r2Uit) throw new Error('R2 del HTTP 500'); st.r2.delete(k); } };
  const pub = MP.maak({ db: ing._db, ml, vault, vv: VV, dir: hdir, d1, r2, categorieen: H.CATEGORIEEN, nu: () => klok.t, fout: (l, e) => fouten.push(l + ': ' + (e && e.message)) });
  const ins = ing._db.prepare("INSERT INTO ml_herinnering (hid, soort, ref, categorie, gevoelig, status, aangemaakt, gewijzigd) VALUES (?, 'los', ?, ?, 0, 'actief', ?, ?)");
  function album(hid, cat, titel, wanneer) {
    const t = '2026-11-01T10:00:00Z';
    ins.run(hid, 'google:' + hid.slice(1), cat, t, t);
    fs.writeFileSync(path.join(vault, M.MAP, hid + '.md'), '---\ntype: herinnering-stukken\nherinnering_id: ' + hid + '\nsoort: los\ntitel: "' + titel + '"\ntitel_bron: naamgeving\nwanneer: "' + wanneer + '"\n---\nFoto\'s: verzonnen.\n');
  }
  return { basis, vault, ing, ml, pub, im, st, d1db, klok, fouten, album,
    rijen: (t, k) => d1db.prepare('SELECT * FROM ' + t + (k ? ' WHERE kring = ?' : '')).all(...(k ? [k] : [])).map((r) => ({ ...r })),
    zetLijst: (s) => fs.writeFileSync(path.join(vault, M.BEZOEKERS_PAGINA), lijst(s)),
    sluit: () => { ing.sluit(); fs.rmSync(basis, { recursive: true, force: true }); } };
}
const A = 'h00000000000000a1', B = 'h00000000000000b2', C = 'h00000000000000c3', D = 'h00000000000000d4';

async function opgezet() {
  const o = omgeving();
  o.album(A, 'shizzle', 'Shizzle: Proefweekend - 2004', '2004-05');
  o.album(B, 'gezin', 'Zomervakantie 2015 - Proefland', '2015-07');
  o.album(C, 'prive', 'Proefdag Privé 2012', '2012-03');
  o.album(D, 'overig', 'Bruiloft Kornelis 2015', '2015-09');
  o.zetLijst('bevestigd');
  await o.ml.fotoSync(true);
  for (const h of [A, B, C, D]) {
    const a = o.im.albums.find((x) => x.id === o.ing._db.prepare('SELECT album_id FROM ml_album WHERE hid = ?').get(h).album_id);
    o.im.foto(a, jpeg(), 'image/jpeg'); o.im.foto(a, webp(), 'image/webp');
  }
  o.klok.t += 11 * 60000; await o.ml.fotoSync(true);   // omslag (gevel) na de eerste foto's
  return o;
}
// nep-Immich geeft voor beide maten hetzelfde beeld (de toets kijkt alleen naar metadata en sleutels)

test('strip: JPEG zonder APP1/APP13/COM, met APP0/ICC en beelddata; WebP zonder EXIF/XMP en met gewiste VP8X-vlaggen; onbekend = null', () => {
  const j = MP.strip(jpeg(), 'image/jpeg');
  assert.strictEqual(j.mime, 'image/jpeg');
  assert.ok(!METADATA.test(j.data.toString('latin1')), 'geen metadata meer');
  assert.ok(j.data.toString('latin1').includes('JFIF') && j.data.toString('latin1').includes('ICC_PROFILE'));
  assert.deepStrictEqual([...j.data.subarray(-7)], [0x12, 0x34, 0xFF, 0x00, 0x56, 0xFF, 0xD9], 'beelddata ongewijzigd');
  const w = MP.strip(webp(), 'image/webp');
  assert.ok(!METADATA.test(w.data.toString('latin1')));
  assert.strictEqual(w.data.readUInt32LE(4), w.data.length - 8, 'RIFF-grootte klopt');
  assert.strictEqual(w.data[20] & 0x0C, 0, 'VP8X-vlaggen EXIF/XMP uit');
  // review MOET 2: progressieve JPEG (APP1 tussen twee scans) en bytes na EOI
  const seg = (m, data) => { const l = Buffer.alloc(2); l.writeUInt16BE(data.length + 2); return Buffer.concat([Buffer.from([0xFF, m]), l, data]); };
  const sos = seg(0xDA, Buffer.from([1, 1, 0, 0, 0x3F, 0]));
  const prog = Buffer.concat([Buffer.from([0xFF, 0xD8]), seg(0xDB, Buffer.alloc(65, 1)), sos, Buffer.from([0x11, 0xFF, 0x00, 0x22, 0xFF, 0xD3, 0x33]),
    seg(0xE1, Buffer.from('Exif\0\0GPS-verzonnen-tussen', 'latin1')), seg(0xFE, Buffer.from('commentaar-verzonnen', 'latin1')), sos, Buffer.from([0x44]), Buffer.from([0xFF, 0xD9]),
    Buffer.from('Proefcamera achter EOI', 'latin1')]);
  const pj = MP.strip(prog, 'image/jpeg');
  assert.ok(pj && !METADATA.test(pj.data.toString('latin1')), 'geen metadata tussen scans of na EOI');
  assert.deepStrictEqual([...pj.data.subarray(-2)], [0xFF, 0xD9]);
  assert.ok(pj.data.includes(Buffer.from([0x11, 0xFF, 0x00, 0x22, 0xFF, 0xD3, 0x33])) && pj.data.includes(Buffer.from([0x44, 0xFF, 0xD9])), 'beelddata van beide scans blijft');
  assert.strictEqual(MP.strip(Buffer.concat([Buffer.from([0xFF, 0xD8]), sos, Buffer.from([1, 2, 3])]), 'image/jpeg'), null, 'zonder EOI = kapot');
  assert.strictEqual(MP.strip(Buffer.from('\x89PNG\r\n\x1a\nproef', 'latin1'), 'image/png'), null);
  assert.strictEqual(MP.strip(Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF]), 'image/jpeg'), null, 'kapotte JPEG = niet publiceren');
});

test('kringen: voorstel (Shizzle-categorie of naam van een Shizzle-bezoeker in de titel), Privé zonder keuze niet in de straat; Davids keuze wint', async () => {
  const o = await opgezet();
  try {
    const k = o.ml.kringen().body, r = (h) => k.herinneringen.find((x) => x.hid === h);
    assert.deepStrictEqual([r(A).familie, r(A).shizzle], [true, true]);
    assert.deepStrictEqual([r(B).familie, r(B).shizzle], [true, false]);
    assert.deepStrictEqual([r(C).familie, r(C).shizzle, r(C).in_straat], [false, false, false], 'Privé zonder keuze: nergens');
    assert.deepStrictEqual([r(D).familie, r(D).shizzle, r(D).bron], [true, true, 'voorstel'], 'naam van een Shizzle-bezoeker in de titel');
    assert.deepStrictEqual(k.tel, { familie: 3, shizzle: 2, totaal: 4, dicht_familie: 0, dicht_shizzle: 1, weg: 1 });
    // David: alles mag gelabeld → Privé toch voor familie
    assert.strictEqual(o.ml.kring(C, { kring: 'familie', aan: true }).status, 200);
    const c = o.ml.kringen().body.herinneringen.find((x) => x.hid === C);
    assert.deepStrictEqual([c.familie, c.shizzle, c.bron, c.in_straat], [true, false, 'david', true]);
    assert.strictEqual(o.ml.kring(C, { kring: 'vrienden', aan: true }).status, 400);
    // categorie daarna naar iets anders gevoeligs → keuze weg (wordt weer het strenge voorstel)
    assert.strictEqual(o.ml.categorie(B, { categorie: 'gezin', gevoelig: true }).status, 200);
    const b = o.ml.kringen().body.herinneringen.find((x) => x.hid === B);
    assert.deepStrictEqual([b.familie, b.shizzle, b.in_straat], [false, false, false]);
    assert.strictEqual(o.ml.kring(B, { kring: 'familie', aan: true }).status, 409, 'gevoelig-vinkje: niet aan te zetten');
  } finally { o.sluit(); }
});

test('publiceren: vast schema, dicht huis = alleen het jaar, geen pod- of Immich-ids buiten, foto\'s zonder metadata, bezoekers gehasht', async () => {
  const o = await opgezet();
  try {
    const u = await o.pub.tik(true);
    assert.ok(!u.fout, u.fout);
    const fam = o.rijen('huis', 'familie'), sh = o.rijen('huis', 'shizzle');
    assert.strictEqual(fam.length, 3); assert.strictEqual(fam.filter((x) => x.open).length, 3);
    assert.strictEqual(sh.length, 3); assert.strictEqual(sh.filter((x) => x.open).length, 2);
    const dicht = JSON.parse(sh.find((x) => !x.open).json);
    assert.deepStrictEqual(Object.keys(dicht).sort(), MP.LIJST_VELDEN.slice().sort(), 'dicht huis = precies het schema');
    assert.deepStrictEqual({ titel: dicht.titel, wanneer: dicht.wanneer, categorie: dicht.categorie, gevoelig: dicht.gevoelig, album: dicht.album, personen: dicht.personen, dicht: dicht.dicht },
      { titel: '', wanneer: '2015', categorie: 'prive', gevoelig: true, album: null, personen: [], dicht: true });
    assert.match(dicht.datum, /^1\|2015-(0[1-9]|1[0-2])\|2015-(0[1-9]|1[0-2])$/, 'alleen jaar + maand uit de HMAC, geen dag');
    for (const r of fam.concat(sh)) assert.deepStrictEqual(Object.keys(JSON.parse(r.json)).sort(), MP.LIJST_VELDEN.slice().sort());
    for (const r of o.rijen('detail')) assert.deepStrictEqual(Object.keys(JSON.parse(r.json)).sort(), MP.DETAIL_VELDEN.slice().sort());
    assert.strictEqual(o.rijen('detail', 'shizzle').length, 2, 'dicht huis heeft geen detail');
    // geen titel van het dichte huis in de Shizzle-straat; geen pod-hid of Immich-id ergens in D1 of in R2-sleutels
    const alles = JSON.stringify(o.rijen('huis').concat(o.rijen('detail'), o.rijen('foto'), o.rijen('gevel'))) + [...o.st.r2.keys()].join(' ');
    assert.ok(!JSON.stringify(o.rijen('huis', 'shizzle').concat(o.rijen('detail', 'shizzle'))).includes('Proefland'));
    for (const h of [A, B, C, D]) assert.ok(!alles.includes(h), 'geen pod-hid buiten');
    for (const id of o.im.beelden.keys()) assert.ok(!alles.includes(id), 'geen Immich-id buiten');
    assert.ok(!/google:/.test(alles));
    // huis-ids verschillen per kring (geen koppeling)
    const pidA = (k) => o.pub._pidVan(k, A);
    assert.notStrictEqual(pidA('familie'), pidA('shizzle'));
    // foto's: 2 per open album per kring, beide maten in R2, zonder metadata
    assert.strictEqual(o.rijen('foto', 'familie').length, 6); assert.strictEqual(o.rijen('foto', 'shizzle').length, 4);
    assert.strictEqual([...o.st.r2.keys()].filter((k) => k.startsWith('f/')).length, 20);
    for (const [k, v] of o.st.r2) { assert.match(k, /^(f\/(familie|shizzle)\/[A-Za-z0-9_-]{22}\/[kg]|g\/(familie|shizzle)\/h[0-9a-f]{16})$/); assert.ok(!METADATA.test(v.b.toString('latin1')), k); }
    assert.strictEqual(o.rijen('gevel', 'familie').length, 3);
    // bezoekers: alleen sha256 van het adres; dubbel adres één keer; geen vrienden-kring of rij zonder adres
    const bz = o.rijen('bezoeker');
    assert.strictEqual(bz.length, 3);
    assert.ok(bz.some((r) => r.hash === MP.adresHash('ADA.TWEE@voorbeeld.invalid ') && r.kring === 'familie'));
    assert.ok(!JSON.stringify(bz).includes('@') && !JSON.stringify(bz).includes('Ada'));
    assert.strictEqual(o.rijen('publicatie').every((r) => r.geldig_tot === o.klok.t + 24 * 3600000), true);
    assert.deepStrictEqual(o.fouten, []);
  } finally { o.sluit(); }
});

test('dicht gaan: kring uit = detail, foto\'s en R2 weg, huis dicht; R2 even stuk = blok blijft tot het opruimen lukt; gevoelig = uit de straat', async () => {
  const o = await opgezet();
  try {
    await o.pub.tik(true);
    const pf = o.pub._pidVan('familie', A);
    o.st.r2Uit = true;
    assert.strictEqual(o.ml.kring(A, { kring: 'familie', aan: false }).status, 200);
    o.pub.markeerVuil();
    await o.pub.tik();
    assert.strictEqual(o.rijen('detail', 'familie').some((r) => r.pid === pf), false, 'detail meteen weg');
    assert.strictEqual(o.rijen('foto', 'familie').some((r) => r.pid === pf), false, 'fotorijen meteen weg');
    assert.strictEqual(JSON.parse(o.rijen('huis', 'familie').find((r) => r.pid === pf).json).dicht, true);
    assert.ok(o.rijen('blok', 'familie').some((r) => r.pid === pf), 'blok blijft zolang R2 niet opgeruimd is');
    assert.ok([...o.st.r2.keys()].some((k) => k.startsWith('g/familie/' + pf)));
    o.st.r2Uit = false; o.fouten.length = 0;
    o.pub.markeerVuil();
    await o.pub.tik();
    assert.ok(!o.rijen('blok', 'familie').some((r) => r.pid === pf), 'blok weg na opruimen');
    assert.ok(![...o.st.r2.keys()].some((k) => k.startsWith('g/familie/' + pf)));
    assert.strictEqual([...o.st.r2.keys()].filter((k) => k.startsWith('f/familie/')).length, 8, 'alleen de foto\'s van de andere twee albums');
    // Shizzle-kant van A blijft open
    assert.ok(o.rijen('detail', 'shizzle').some((r) => r.pid === o.pub._pidVan('shizzle', A)));
    // gevoelig-vinkje op D → uit beide straten, R2 leeg voor D
    assert.strictEqual(o.ml.categorie(D, { categorie: 'overig', gevoelig: true }).status, 200);
    o.pub.markeerVuil();
    await o.pub.tik();
    for (const k of ['familie', 'shizzle']) {
      const p = o.pub._pidVan(k, D);
      assert.ok(!o.rijen('huis', k).some((r) => r.pid === p), 'gevoelig: niet meer in de straat');
      assert.ok(![...o.st.r2.keys()].some((x) => x.includes(p)));
    }
    assert.strictEqual([...o.st.r2.keys()].filter((k) => k.startsWith('f/shizzle/')).length, 4);
  } finally { o.sluit(); }
});

test('bezoekers alleen bij status bevestigd; noodstop naar D1; geheim of patiëntmarker in de tekst = dicht; D1 stuk = fout zonder inhoud', async () => {
  const o = await opgezet();
  try {
    o.zetLijst('voorstel');
    await o.pub.tik(true);
    assert.strictEqual(o.rijen('bezoeker').length, 0, 'voorstel: niemand');
    o.zetLijst('bevestigd');
    await o.pub.tik();
    assert.strictEqual(o.rijen('bezoeker').length, 3);
    o.pub.noodstop(true);
    await o.pub.tik();
    assert.strictEqual(o.rijen('stand').find((r) => r.sleutel === 'noodstop').waarde, '1');
    assert.ok(!JSON.parse(o.rijen('stand').find((r) => r.sleutel === 'categorieen').waarde).some((c) => c.id === 'prive'), 'geen gevoelige categorie buiten');
    o.pub.noodstop(false); await o.pub.tik();
    assert.strictEqual(o.rijen('stand').find((r) => r.sleutel === 'noodstop').waarde, '0');
    // titel met een geheim → dicht in elke kring
    fs.writeFileSync(path.join(o.vault, M.MAP, B + '.md'), '---\ntype: herinnering-stukken\nherinnering_id: ' + B + '\nsoort: los\ntitel: "Vakantie nepgeheim-0123456789abcdef"\ntitel_bron: david\nwanneer: "2015-07"\n---\n');
    o.pub.markeerVuil(); await o.pub.tik();
    const hb = o.rijen('huis', 'familie').find((r) => r.pid === o.pub._pidVan('familie', B));
    assert.strictEqual(hb.open, 0); assert.ok(!hb.json.includes('nepgeheim'));
    o.st.d1Uit = true;
    o.pub.markeerVuil();
    const u = await o.pub.tik();
    assert.ok(u.fout && !/Vakantie|Proef/.test(u.fout));
  } finally { o.sluit(); }
});

test('logboek: de pod haalt bezoeken op (persoon, kring, huis → hid) en wist ze buiten', async () => {
  const o = await opgezet();
  try {
    await o.pub.tik(true);
    const pa = o.pub._persoonVan('Proefnicht Ada');
    o.d1db.prepare('INSERT INTO log (pid, kring, huis, op) VALUES (?, ?, ?, ?)').run(pa, 'familie', o.pub._pidVan('familie', B), o.klok.t);
    o.klok.t += 6 * 60000;
    await o.pub.tik();
    assert.strictEqual(o.rijen('log').length, 0, 'buiten gewist');
    assert.deepStrictEqual(o.pub.gezien()[B].map((x) => x.naam), ['Proefnicht Ada']);
    const b = o.pub.info().bezoekers.find((x) => x.naam === 'Proefnicht Ada');
    assert.strictEqual(b.bezoeken, 1);
  } finally { o.sluit(); }
});

test('review MOET 3/4 en ZOU 1: half gelukte upload wordt toch opgeruimd; wijziging tijdens een ronde = meteen nog een ronde; zelfde foto in twee albums = twee foto-ids', async () => {
  const o = await opgezet();
  try {
    // ZOU 1: een foto in twee albums
    const albumVan = (h) => o.im.albums.find((x) => x.id === o.ing._db.prepare('SELECT album_id FROM ml_album WHERE hid = ?').get(h).album_id);
    albumVan(D).assets.push(albumVan(B).assets[0]);
    // MOET 3: R2 faalt na de eerste put
    let faalde = false; const echt = o.st.r2.set.bind(o.st.r2);
    o.st.r2.set = (k, v) => { if (!faalde && /^f\/familie\/.*\/g$/.test(k)) { faalde = true; throw new Error('R2 put HTTP 500'); } return echt(k, v); };   // miniatuur staat er al
    await o.pub.tik(true);
    o.st.r2.set = echt;
    assert.strictEqual(o.rijen('foto', 'familie').length, 6, 'de half gelukte foto heeft (nog) geen D1-rij');
    const bezig = o.ing._db.prepare("SELECT count(*) n FROM mlp_obj WHERE hash LIKE '%bezig%'").get().n;
    assert.ok(bezig >= 1, 'het voornemen staat vast');
    o.klok.t += 16 * 60000;   // volgende ronde (elke 15 min) zet hem opnieuw in de wachtrij
    await o.pub.tik();
    assert.strictEqual(o.rijen('foto', 'familie').length, 7, 'volgende tik maakt hem af (gedeelde foto telt per huis)');
    assert.strictEqual(o.ing._db.prepare("SELECT count(*) n FROM mlp_obj WHERE hash LIKE '%bezig%'").get().n, 0);
    // alles dicht voor familie → geen enkel R2-object van familie over, ook niet van de half gelukte
    for (const h of [A, B, D]) o.ml.kring(h, { kring: 'familie', aan: false });
    o.pub.markeerVuil(); await o.pub.tik();
    assert.deepStrictEqual([...o.st.r2.keys()].filter((k) => k.startsWith('f/familie/') || k.startsWith('g/familie/')), []);
    // MOET 4: wijziging tijdens de ronde
    let eerste = true;   // David trekt in terwijl de ronde al geschreven heeft (bij het verlengen van de publicatie)
    o.st.hook = (batch) => { if (eerste && batch.some((q) => /INTO publicatie/.test(q.sql))) { eerste = false; o.ml.kring(A, { kring: 'shizzle', aan: false }); o.pub.markeerVuil(); } };
    await o.pub.tik(true);
    assert.ok(!o.rijen('detail', 'shizzle').some((r) => r.pid === o.pub._pidVan('shizzle', A)), 'de intrekking tijdens de ronde is meteen verwerkt');
  } finally { o.sluit(); }
});
