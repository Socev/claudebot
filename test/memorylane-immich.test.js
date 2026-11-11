'use strict';
// Toetsen van MemoryLane × Immich (wv2120): witte lijst van immich.js, metadata in miniaturen, albums per herinnering (idempotent, Davids eigen
// albums onaangeroerd), foto's alleen uit een gekoppeld album, gevel, en foto's bij de deellinks (standaard uit, weg bij uit/gevoelig).
// Nep-Immich = een fetch-functie in het geheugen; nep-D1 = node:sqlite. ALLEEN VERZONNEN TEKST en verzonnen beelden (een paar bytes).
// Aanroep: bash test/memorylane-immich.sh
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const IM = require(path.join(ROOT, 'immich.js'));
const MF = require(path.join(ROOT, 'memorylane-fotos.js'));
const I = require(path.join(ROOT, 'intake-ingang.js'));
const H = require(path.join(ROOT, 'herinneringen.js'));
const M = require(path.join(ROOT, 'memorylane-delen.js'));
const VV = require(path.join(ROOT, 'vault-veilig.js'));
const P = require(path.join(ROOT, 'intake', 'patientpoort.js'));

const D1_SCHEMA = `
CREATE TABLE ml_link (kring TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, versie INTEGER NOT NULL, aan INTEGER NOT NULL DEFAULT 0, ww_zout TEXT, ww_hash TEXT, ww_iter INTEGER);
CREATE TABLE ml_item (kring TEXT NOT NULL, versie INTEGER NOT NULL, pub TEXT NOT NULL, volgorde INTEGER NOT NULL, titel TEXT NOT NULL, wanneer TEXT NOT NULL, stukken TEXT NOT NULL, PRIMARY KEY (kring, pub));
CREATE TABLE ml_sleutel (id TEXT PRIMARY KEY, spki TEXT NOT NULL);
CREATE TABLE ml_sessie (token TEXT PRIMARY KEY, kring TEXT NOT NULL, versie INTEGER NOT NULL, csrf TEXT NOT NULL, tot INTEGER NOT NULL);
CREATE TABLE ml_poging (sleutel TEXT PRIMARY KEY, venster INTEGER NOT NULL, n INTEGER NOT NULL);
CREATE TABLE ml_bijdrage (id TEXT PRIMARY KEY, kring TEXT NOT NULL, versie INTEGER NOT NULL, sleutel_id TEXT NOT NULL, sleutel TEXT NOT NULL, iv TEXT NOT NULL, inhoud TEXT NOT NULL, op TEXT NOT NULL);`;

const uuid = () => crypto.randomUUID();
// verzonnen beelden: alleen de kop die heeftMetadata leest
function webp(exif) {
  const chunk = (id, data) => { const l = Buffer.alloc(4); l.writeUInt32LE(data.length); return Buffer.concat([Buffer.from(id, 'latin1'), l, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), chunk('VP8L', Buffer.from([1, 2, 3, 4, 5])), exif ? chunk('EXIF', Buffer.from('Exif\0\0GPS-verzonnen')) : Buffer.alloc(0)]);
  const l = Buffer.alloc(4); l.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), l, body]);
}
function jpeg(exif) {
  const seg = (mk, data) => { const l = Buffer.alloc(2); l.writeUInt16BE(data.length + 2); return Buffer.concat([Buffer.from([0xff, mk]), l, data]); };
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01', 'latin1')), exif ? seg(0xe1, Buffer.from('Exif\0\0MM-verzonnen', 'latin1')) : Buffer.alloc(0),
    seg(0xdb, Buffer.alloc(8)), Buffer.from([0xff, 0xda, 0, 2, 9, 9, 0xff, 0xd9])]);
}

// Nep-Immich: albums met assets per maand, miniaturen; houdt bij wat er gevraagd werd
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
        fileCreatedAt: ids.map((x) => (st.meta.get(x) || {}).t || '2020-02-10T10:00:00.000Z'), localOffsetHours: ids.map((x) => (st.meta.get(x) || {}).off ?? 1),
        city: ids.map((x) => (st.meta.get(x) || {}).stad ?? null), duration: ids.map((x) => (st.meta.get(x) || {}).duur ?? (st.video.has(x) ? '0:00:12.500000' : '0:00:00.00000')),
        isFavorite: ids.map((x) => (st.meta.get(x) || {}).fav === true), country: ids.map(() => 'Proefland') };
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

function omgeving(extra) {
  const basis = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-immich-toets-'));
  const idir = path.join(basis, 'intake'), vault = path.join(basis, 'vault'), hdir = path.join(basis, 'herinneringen');
  for (const m of [idir, vault, path.join(vault, '20_Prive/Reizen'), path.join(vault, H.NOTITIE_MAP)]) fs.mkdirSync(m, { recursive: true });
  const klok = { t: Date.parse('2026-10-31T19:00:00Z') };
  const ing = I.maak({ dir: idir, vault, profielenDir: path.join(ROOT, 'intake', 'profielen'), filterPad: path.join(ROOT, 'bisync-filter.txt'),
    primair: () => true, vv: VV, nu: () => klok.t, fout: () => {}, marker: P, nachtgrendel: () => false, vrijeBytes: () => 50 * 1024 ** 3, stuur: () => {} });
  H.maak({ dir: hdir, intake: ing, vault, vv: VV, nu: () => klok.t, fout: () => {}, whisper: async () => '', kanUitschrijven: () => false,
    onderhoudAan: () => false, nachtgrendel: () => false, primair: () => true, kaartZet: async () => ({}), kaartLijst: async () => ({}), box: () => {}, offsiteAan: () => false });
  const d1db = new DatabaseSync(':memory:');
  d1db.exec(D1_SCHEMA);
  const staat = { d1Uit: false };
  const d1 = async (sql, params) => {
    if (staat.d1Uit) return { ok: false, rijen: null };
    const st = d1db.prepare(sql);
    return { ok: true, rijen: /^\s*SELECT/i.test(sql) ? st.all(...params) : (st.run(...params), []) };
  };
  const im = nepImmich();
  const fouten = [];
  const ml = M.maak({ db: ing._db, vault, vv: VV, dir: hdir, d1, kluis: async (n) => (n === 'memorylane_link_familie' ? 'Kaasschaaf Zeven' : null), marker: P, geheimen: () => [],
    categorieen: H.CATEGORIEEN, onderhoudAan: () => false, nachtgrendel: () => false, nu: () => klok.t, fout: (l, e) => fouten.push(l + ': ' + (e && e.message)),
    reisVandaag: () => '2026-10-31', immich: im.client, ...(extra || {}) });
  function opname(id, cat) {
    const rel = path.join(H.NOTITIE_MAP, '2026-10-31_' + id.slice(-6) + '.md');
    fs.writeFileSync(path.join(vault, rel), '---\ntype: bron\ngevoelig: prive\n---\n> **Privé — persoonlijke herinnering.**\n\n# Opname 31-10-2026 10:37\n\n[00:00] Op de camping in Proefdorp regende het.\n');
    ing._db.prepare("INSERT INTO ramble (ramble_id, dag, aangemaakt, laatst, status, opgenomen_op, notitie, categorie, herinnering_gevoelig, proef) VALUES (?, '2026-10-31', ?, ?, 'notitie', ?, ?, ?, 0, 0)")
      .run(id, '2026-10-31T09:37:00Z', '2026-10-31T09:37:00Z', '2026-10-31T09:37:00Z', rel, cat);
  }
  function reis(naam, periode) {
    fs.writeFileSync(path.join(vault, '20_Prive/Reizen', naam), '---\ntype: reis\nonderwerp: "' + naam.replace(/\.md$/, '') + '"\nperiode: "' + periode + '"\n---\n# Reis\n');
  }
  const tik = async () => { klok.t += 11 * 60000; return ml.tik(); };   // elke ronde ook de 10-minutenstappen (album-sync, controle)
  return { basis, vault, ing, ml, d1db, staat, klok, im, fouten, opname, reis, tik, hdir,
    hid: (soort, ref) => ing._db.prepare('SELECT hid FROM ml_herinnering WHERE soort = ? AND ref = ?').get(soort, ref).hid,
    album: (hid) => ing._db.prepare('SELECT * FROM ml_album WHERE hid = ?').get(hid),
    fotosD1: (k) => d1db.prepare('SELECT * FROM ml_foto WHERE kring = ? ORDER BY pub, nr').all(k),
    sluit: () => { ing.sluit(); fs.rmSync(basis, { recursive: true, force: true }); } };
}
const RA = 'r20261031-0123456789abcdef', RB = 'r20261031-fedcba9876543210';
const REIS = '20_Prive/Reizen/2020 - Proefrally Noorwegen.md';

test('witte lijst: alleen lezen, een leeg album aanmaken en (wv2225) alleen de naam van een album wijzigen; al het andere geweigerd vóór er iets over de lijn gaat', async () => {
  const a = uuid();
  for (const [m, p, q, b] of [['GET', '/api/albums', {}, undefined], ['GET', '/api/albums/' + a], ['GET', '/api/timeline/buckets', { albumId: a, order: 'asc' }],
    ['GET', '/api/timeline/bucket', { albumId: a, timeBucket: '2020-02-01', order: 'asc' }], ['GET', '/api/assets/' + a + '/thumbnail', { size: 'thumbnail' }],
    ['GET', '/api/assets/' + a + '/thumbnail', { size: 'preview' }], ['POST', '/api/albums', null, { albumName: 'MemoryLane – Proef', description: 'x' }],
    ['PATCH', '/api/albums/' + a, null, { albumName: '2020 Proef (ML)' }]]) {
    assert.strictEqual(IM.weiger(m, p, q, b), null, m + ' ' + p);
  }
  const weg = [['POST', '/api/assets', null, {}], ['DELETE', '/api/albums/' + a], ['PATCH', '/api/albums/' + a, null, { albumName: 'x', description: 'y' }],
    ['PATCH', '/api/albums/' + a, null, { description: 'y' }], ['PATCH', '/api/albums/' + a, null, { albumName: 'x', albumThumbnailAssetId: a }], ['PATCH', '/api/albums/' + a, null, { albumName: '' }],
    ['PATCH', '/api/albums/' + a, null, { albumName: 'x'.repeat(201) }], ['PATCH', '/api/albums/' + a, { x: '1' }, { albumName: 'x' }], ['PATCH', '/api/albums/' + a, null, { albumName: 'x', order: 'asc' }],
    ['PATCH', '/api/albums', null, { albumName: 'x' }], ['PATCH', '/api/albums/' + a + '/users', null, { albumName: 'x' }], ['PATCH', '/api/assets/' + a, null, { albumName: 'x' }],
    ['PATCH', '/api/albums/' + a.toUpperCase(), null, { albumName: 'x' }], ['PATCH', '/api/albums/' + a], ['PUT', '/api/albums/' + a, null, { albumName: 'x' }],
    ['PUT', '/api/albums/assets', null, {}], ['DELETE', '/api/albums/' + a + '/assets', null, { ids: [a] }], ['POST', '/api/assets/delete'], ['DELETE', '/api/assets', null, { ids: [a] }],
    ['POST', '/api/albums', null, { albumName: 'x', assetIds: [a] }], ['POST', '/api/albums', null, { albumName: 'x', albumUsers: [{ userId: a, role: 'editor' }] }],
    ['POST', '/api/albums', null, {}], ['POST', '/api/albums', { x: '1' }, { albumName: 'x' }], ['GET', '/api/assets/' + a + '/original', { edited: 'true' }], ['GET', '/api/assets/' + a + '/thumbnail', { size: 'original' }],
    ['GET', '/api/assets/' + a + '/thumbnail', { size: 'fullsize' }], ['GET', '/api/assets/' + a, { key: 'x' }], ['GET', '/api/albums', { shared: 'true' }], ['GET', '/api/albums/../users'],
    ['GET', '/api/albums/' + a.toUpperCase()], ['GET', '/api/timeline/buckets', { albumId: a, userId: a }], ['GET', '/api/timeline/buckets', {}], ['POST', '/api/search/metadata', null, {}],
    ['POST', '/api/shared-links', null, { type: 'ALBUM', albumId: a }], ['PUT', '/api/system-config', null, {}], ['GET', '/api/api-keys'], ['DELETE', '/api/workflows/' + a]];
  for (const [m, p, q, b] of weg) assert.notStrictEqual(IM.weiger(m, p, q, b), null, m + ' ' + p + ' ' + JSON.stringify(q || {}) + ' ' + JSON.stringify(b || {}));
  const st = nepImmich();
  for (const [m, p, q, b] of weg) await assert.rejects(st.client.verzoek(m, p, q, b), (e) => e.code === 'WITTE_LIJST');
  assert.strictEqual(st.log.length, 0, 'geen enkel geweigerd verzoek ging de deur uit');
});

test('immich.js: sleutel in de kop, nooit in de URL of een fout; doorverwijzing = fout; geen beeld = fout', async () => {
  const st = nepImmich();
  await st.client.albums();
  assert.ok(!st.log.join(' ').includes(st.sleutel), 'sleutel niet in de URL');
  const metRedirect = IM.maak({ basis: 'https://immich.proef.invalid', sleutel: async () => 'k', fetch: async () => new Response(null, { status: 302, headers: { location: 'https://elders.invalid/' } }) });
  await assert.rejects(metRedirect.albums(), (e) => e.code === 'HTTP' && e.status === 302 && !e.message.includes('k '));
  const geenBeeld = IM.maak({ basis: 'https://immich.proef.invalid', sleutel: async () => 'k', fetch: async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(geenBeeld.beeld(uuid(), 'klein'), (e) => e.code === 'SOORT');
  const zonder = IM.maak({ basis: 'https://immich.proef.invalid', sleutel: async () => null, fetch: async () => { throw new Error('mag niet'); } });
  await assert.rejects(zonder.albums(), (e) => e.code === 'GEEN_SLEUTEL');
  assert.throws(() => IM.maak({ basis: 'http://elders.invalid', sleutel: async () => 'k' }), /basis/);
  // review ZOU 1: te groot antwoord zonder content-length wordt tijdens het lezen afgekapt
  let gelezen = 0;
  const groot = IM.maak({ basis: 'https://immich.proef.invalid', sleutel: async () => 'k', fetch: async () => new Response(new ReadableStream({
    pull(c) { gelezen += 1024 * 1024; c.enqueue(new Uint8Array(1024 * 1024)); if (gelezen > 64 * 1024 * 1024) c.close(); } }), { status: 200, headers: { 'content-type': 'image/webp' } }) });
  await assert.rejects(groot.beeld(uuid(), 'klein'), (e) => e.code === 'GROOT');
  assert.ok(gelezen <= 8 * 1024 * 1024, 'gestopt kort na de grens, niet alles gelezen (' + gelezen + ')');
});

test('metadata: Exif/XMP in jpeg of webp = niet delen; schone miniatuur = delen; onbekend formaat = niet delen', () => {
  assert.strictEqual(IM.heeftMetadata(webp(false)), false);
  assert.strictEqual(IM.heeftMetadata(webp(true)), true);
  assert.strictEqual(IM.heeftMetadata(jpeg(false)), false);
  assert.strictEqual(IM.heeftMetadata(jpeg(true)), true);
  assert.strictEqual(IM.heeftMetadata(Buffer.from('GIF89a verzonnen')), true);
});

test('albums: vanzelf voor een reis en een opname met categorie; niet voor een opname zonder categorie; idempotent; Davids eigen album onaangeroerd', async () => {
  const o = omgeving();
  try {
    const eigen = o.im.davidsEigen();
    o.reis('2020 - Proefrally Noorwegen.md', '2020-02-09 – 2020-02-15');
    o.opname(RA, 'shizzle'); o.opname(RB, null);
    await o.tik();
    const namen = o.im.albums.map((a) => a.albumName).sort();
    assert.deepStrictEqual(namen, ['(zonder jaar) Opname 31-10-2026 10:37 (ML)', '2020 Proefrally Noorwegen (ML)', 'Vakantie 2019 (eigen album)'], 'wv2225: jaar vooraan, (ML) achteraan');
    const hr = o.hid('reis', REIS), hb = o.hid('opname', RB);
    assert.strictEqual(o.album(hr).status, 'actief');
    assert.strictEqual(o.album(hb), undefined, 'opname zonder categorie: geen album vanzelf');
    const code = MF.code('reis', REIS);
    assert.ok(o.im.albums.find((a) => a.id === o.album(hr).album_id).description.endsWith('memorylane:' + code), 'herkenningscode in de omschrijving');
    const posts = () => o.im.log.filter((x) => x.startsWith('POST')).length;
    assert.strictEqual(posts(), 2);
    await o.tik(); await o.tik();
    assert.strictEqual(posts(), 2, 'tweede en derde ronde: niets nieuws');
    // koppeltabel kwijt (bv. databank teruggezet): overnemen op de code, geen tweede album
    o.ing._db.exec('DELETE FROM ml_album');
    await o.tik();
    assert.strictEqual(posts(), 2, 'na verlies van de koppeltabel: overgenomen, niet opnieuw gemaakt');
    assert.strictEqual(o.album(hr).status, 'actief');
    assert.ok(!o.im.log.some((x) => x.includes(eigen.id)), 'Davids eigen album nooit aangesproken');
    assert.ok(!o.ing._db.prepare('SELECT * FROM ml_album').all().some((r) => JSON.stringify(r).includes('Proef') || JSON.stringify(r).includes('Opname')), 'geen namen in intake.sqlite');
    // knop Album maken voor de opname zonder categorie
    const u = await o.ml.albumMaken(hb);
    assert.strictEqual(u.status, 200); assert.strictEqual(o.album(hb).status, 'actief');
    assert.strictEqual((await o.ml.albumMaken(hb)).status, 409, 'tweede keer: er is al een album');
    // David verwijdert het reisalbum in Immich → weg, niet vanzelf opnieuw
    o.im.albums = o.im.albums.filter((a) => a.id !== o.album(hr).album_id);
    await o.tik(); await o.tik();
    assert.strictEqual(o.album(hr).status, 'weg');
    assert.strictEqual(posts(), 3, 'verwijderd album niet vanzelf opnieuw');
    const l = o.ml.lijst().body;
    assert.strictEqual(l.herinneringen.find((h) => h.hid === hr).album.status, 'weg');
    assert.strictEqual(l.immich.sleutel, true);
    assert.strictEqual((await o.ml.albumMaken(hr)).status, 200);
    assert.strictEqual(posts(), 4);
    assert.deepStrictEqual(o.fouten, []);
  } finally { o.sluit(); }
});

test('wv2225 albumNaam: jaar vooraan, (ML) achteraan, geen dubbel jaartal, zonder jaar zichtbaar, begrensd', () => {
  const N = MF.albumNaam;
  assert.strictEqual(N('Gambia 2023', '2023'), '2023 Gambia (ML)', 'los jaar achteraan schuift naar voren');
  assert.strictEqual(N('Shizzle: Proeftocht - Proefland - 2023', '2023'), '2023 Shizzle: Proeftocht - Proefland (ML)');
  assert.strictEqual(N('Zomervakantie 2024 - Proefcamping', '2024'), '2024 Zomervakantie 2024 - Proefcamping (ML)', 'jaar midden in Davids naamgeving: titel ongemoeid');
  assert.strictEqual(N('2026 - Proefreis, april–mei', '2026'), '2026 - Proefreis, april–mei (ML)', 'begint al met het jaar: niet nog eens');
  assert.strictEqual(N('2026 Proefreis', '2026'), '2026 Proefreis (ML)');
  assert.strictEqual(N('Proefverhaal', '1996'), '1996 Proefverhaal (ML)');
  assert.strictEqual(N('Opname 31-10-2026 10:37', null), '(zonder jaar) Opname 31-10-2026 10:37 (ML)');
  assert.strictEqual(N('Proefverhaal', ''), '(zonder jaar) Proefverhaal (ML)');
  assert.strictEqual(N('2024 Proef', null), '(zonder jaar) 2024 Proef (ML)', 'review ZOU 1: een getal vooraan in de titel is geen bekend jaar');
  assert.strictEqual(N('Proef 12023', '2023'), '2023 Proef 12023 (ML)', 'geen jaar uit een langer getal knippen');
  assert.strictEqual(N('Proefverhaal (ML)', '2020'), '2020 Proefverhaal (ML)', 'geen dubbel merk');
  assert.strictEqual(N('MemoryLane – Proefverhaal', '2020'), '2020 Proefverhaal (ML)', 'oude voorvoegsel weg');
  assert.strictEqual(N('Proef', '1850'), '(zonder jaar) Proef (ML)', 'onzinjaar telt niet');
  assert.strictEqual(N('', '2020'), '2020 Herinnering (ML)');
  for (const [t, j] of [['x'.repeat(400), '2020'], ['x'.repeat(400), null], ['2020 ' + 'x'.repeat(400), '2020']]) {
    const n = N(t, j);
    assert.ok(n.length <= 200 && n.endsWith(' (ML)'), 'hooguit 200 tekens en het merk blijft: ' + n.length);
    assert.strictEqual(IM.weiger('PATCH', '/api/albums/' + uuid(), null, { albumName: n }), null, 'past door de witte lijst');
  }
  assert.ok(!N('Gambia 2023', '2023').startsWith('MemoryLane'));
  assert.ok(MF.socevsNaam('MemoryLane – Oud') && MF.socevsNaam('2020 Proef (ML)') && !MF.socevsNaam('2020 Proef') && !MF.socevsNaam('Vakantie 2019 (eigen album)'));
});

test('wv2225 hernoemen: alleen eigen albums (code + naamvorm), oude namen bijgewerkt, titel of jaar volgt, Davids eigen naam blijft, geen foto aangeraakt', async () => {
  const o = omgeving();
  try {
    const eigen = o.im.davidsEigen();
    const eigenOud = { id: uuid(), albumName: 'MemoryLane – Davids eigen proefalbum', description: 'van David, zonder code', assets: [] };
    o.im.albums.push(eigenOud);
    o.reis('2020 - Proefrally Noorwegen.md', '2020-02-09 – 2020-02-15');
    o.reis('Gambia 2023.md', '2023-04-01 – 2023-04-20');
    o.reis('Zomervakantie 2022 Proefcamping.md', '2022-07-10 – 2022-07-30');
    o.opname(RA, 'shizzle');
    // de albums zoals wv2120 ze maakte (oude vorm), met de code; één met een foto erin
    const oud = (soort, ref, naam) => { const a = { id: uuid(), albumName: naam, description: MF.omschrijving(MF.code(soort, ref)), assets: [] }; o.im.albums.push(a); return a; };
    const aR = oud('reis', REIS, 'MemoryLane – Proefrally Noorwegen 2020');
    const aG = oud('reis', '20_Prive/Reizen/Gambia 2023.md', 'MemoryLane – Gambia 2023');
    const aZ = oud('reis', '20_Prive/Reizen/Zomervakantie 2022 Proefcamping.md', 'MemoryLane – Zomervakantie 2022 Proefcamping');
    const aO = oud('opname', RA, 'MemoryLane – Opname 31-10-2026 10:37');
    const fotoId = o.im.foto(aG, webp(false));
    const voor = { albums: o.im.albums.length, fotos: o.im.albums.map((a) => a.id + ':' + a.assets.join(',')).sort().join('|') };
    await o.tik();
    assert.strictEqual(o.im.log.filter((x) => x.startsWith('POST')).length, 0, 'overgenomen op de code, geen nieuw album');
    const naam = (a) => o.im.albums.find((x) => x.id === a.id).albumName;
    assert.strictEqual(naam(aR), '2020 Proefrally Noorwegen (ML)');
    assert.strictEqual(naam(aG), '2023 Gambia (ML)');
    assert.ok(/^2022 Zomervakantie 2022 .*Proefcamping.* \(ML\)$/.test(naam(aZ)), 'jaar midden in de titel blijft, één keer vooraan: ' + naam(aZ));
    assert.strictEqual(naam(aO), '(zonder jaar) Opname 31-10-2026 10:37 (ML)');
    assert.strictEqual(naam(eigen), 'Vakantie 2019 (eigen album)');
    assert.strictEqual(naam(eigenOud), 'MemoryLane – Davids eigen proefalbum', 'album zonder code met de oude naam: onaangeroerd');
    assert.strictEqual(o.im.patches.length, 4, 'precies de vier eigen albums hernoemd');
    assert.ok(o.im.patches.every((p) => Object.keys(p.body).join() === 'albumName'), 'alleen de naam over de lijn');
    assert.ok(!o.im.log.some((x) => x.includes(eigen.id) || x.includes(eigenOud.id)), 'Davids albums nooit aangesproken');
    const na = { albums: o.im.albums.length, fotos: o.im.albums.map((a) => a.id + ':' + a.assets.join(',')).sort().join('|') };
    assert.deepStrictEqual(na, voor, 'tel achteraf: zelfde albums, zelfde foto\'s');
    assert.ok(o.im.albums.find((x) => x.id === aG.id).assets.includes(fotoId));
    assert.ok(!o.ing._db.prepare('SELECT * FROM ml_album').all().some((r) => /Proef|Gambia|Opname/.test(JSON.stringify(r))), 'geen namen in intake.sqlite');
    await o.tik(); await o.tik();
    assert.strictEqual(o.im.patches.length, 4, 'idempotent: volgende rondes niets');
    // David zet een jaar bij de opname → het album volgt
    assert.strictEqual(o.ml.wanneer(o.hid('opname', RA), { van: '1996' }).status, 200);
    await o.tik();
    assert.strictEqual(naam(aO), '1996 Opname 31-10-2026 10:37 (ML)', 'jaar gezet: album volgt');
    // David hernoemt zelf (zonder (ML)) → Socev blijft eraf, ook na een titelwijziging
    o.im.albums.find((x) => x.id === aR.id).albumName = 'Proefrally met de jongens';
    const n0 = o.im.patches.length;
    await o.tik(); await o.tik();
    assert.strictEqual(o.im.patches.length, n0, 'zonder (ML) geen hernoemen');
    assert.strictEqual(naam(aR), 'Proefrally met de jongens');
    // code in de omschrijving klopt niet met de koppeltabel → niet hernoemen
    const z = o.im.albums.find((x) => x.id === aZ.id);
    z.description = 'iets anders'; z.albumName = 'MemoryLane – iets';
    await o.tik();
    assert.strictEqual(z.albumName, 'MemoryLane – iets', 'zonder kloppende code geen hernoemen');
    // Immich weigert de PATCH → fout gemeld, geen crash, volgende ronde opnieuw
    const g = o.im.albums.find((x) => x.id === aG.id); g.albumName = 'MemoryLane – Gambia 2023';
    const echt = o.im.client.hernoemAlbum; let keer = 0;
    o.im.client.hernoemAlbum = async () => { keer++; const e = new Error('immich: HTTP 500'); e.code = 'HTTP'; e.status = 500; throw e; };
    await o.tik();
    assert.strictEqual(keer, 1); assert.ok(o.fouten.some((f) => f.startsWith('ml-immich-naam')));
    o.im.client.hernoemAlbum = echt; o.fouten.length = 0;
    await o.tik(); await o.tik();
    assert.strictEqual(naam(aG), '2023 Gambia (ML)', 'na de fout alsnog');
    assert.deepStrictEqual(o.fouten, []);
  } finally { o.sluit(); }
});

test("foto's: alleen uit een gekoppeld album (andere ids 404), gevel = eerste of door David gekozen", async () => {
  const o = omgeving();
  try {
    o.reis('2020 - Proefrally Noorwegen.md', '2020-02-09 – 2020-02-15');
    await o.tik();
    const hr = o.hid('reis', REIS);
    const al = o.im.albums.find((a) => a.id === o.album(hr).album_id);
    const f1 = o.im.foto(al, webp(false)), f2 = o.im.foto(al, jpeg(false), 'image/jpeg'), f3 = o.im.foto(al, webp(false)), f4 = o.im.foto(al, webp(false));
    const elders = o.im.foto(o.im.davidsEigen(), webp(false));
    const r = await o.ml.fotos(hr);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.fotos.map((x) => x.id), [f1, f2, f3, f4], 'over twee maanden, oudste eerst');
    assert.strictEqual(r.body.album.aantal, 4); assert.strictEqual(r.body.album.gevel, f1, 'gevel = Immich-omslag (eerste)');
    assert.match(r.body.album.url, /^https:\/\/immich\.proef\.invalid\/albums\/[0-9a-f-]{36}$/);
    const b = await o.ml.foto(f2, 'klein');
    assert.strictEqual(b.status, 200); assert.strictEqual(b.body.mime, 'image/jpeg'); assert.deepStrictEqual(Buffer.from(b.body.data, 'base64'), jpeg(false));
    assert.strictEqual((await o.ml.foto(elders, 'klein')).status, 404, 'een foto buiten de MemoryLane-albums: 404');
    assert.strictEqual((await o.ml.foto('niet-een-id', 'klein')).status, 404);
    assert.ok(o.im.log.some((x) => x.includes(f2 + '/thumbnail?size=thumbnail')) && !o.im.log.some((x) => x.includes(elders)), 'nooit een foto buiten het album opgevraagd');
    assert.strictEqual((await o.ml.gevel(hr, { asset: elders })).status, 400);
    assert.strictEqual((await o.ml.gevel(hr, { asset: f3 })).status, 200);
    assert.strictEqual(o.ml.lijst().body.herinneringen.find((h) => h.hid === hr).album.gevel, f3);
    assert.strictEqual((await o.ml.gevel(hr, { asset: null })).status, 200);
    assert.strictEqual(o.ml.lijst().body.herinneringen.find((h) => h.hid === hr).album.gevel, f1, 'terug naar de eerste');
    // review MOET 2: haalt David een foto uit het album, dan is hij via de pod na hooguit 2 minuten niet meer op te halen
    al.assets = al.assets.filter((x) => x !== f4);
    o.klok.t += 3 * 60000;
    assert.strictEqual((await o.ml.foto(f4, 'klein')).status, 404, 'uit het album gehaald = 404');
    assert.strictEqual((await o.ml.foto(f2, 'klein')).status, 200, 'de rest blijft');
    // Immich weg: 503 met uitleg, geen uitzondering
    o.im.uit = true;
    assert.strictEqual((await o.ml.fotos(hr)).status, 503);
  } finally { o.sluit(); }
});

test("wv2943 foto's: dag, tijd (plaatselijk), plaats, duur bij een video en favoriet; geen coördinaten of land; aantal = heel album ook boven de grens", async () => {
  const o = omgeving();
  try {
    o.reis('2020 - Proefrally Noorwegen.md', '2020-02-09 – 2020-02-15');
    await o.tik();
    const hr = o.hid('reis', REIS);
    const al = o.im.albums.find((a) => a.id === o.album(hr).album_id);
    const f1 = o.im.foto(al, webp(false)), f2 = o.im.foto(al, webp(false)), f3 = o.im.foto(al, webp(false)), f4 = o.im.foto(al, webp(false));
    o.im.meta.set(f1, { t: '2020-02-10T23:30:15.000Z', off: 2, stad: '  Proefstad  ', fav: true, lat: 60.1, lon: 10.2 });
    o.im.meta.set(f2, { t: '2020-02-11T08:00:00.000Z', off: 1, stad: 'Stad<script>' });
    o.im.meta.set(f3, { t: 'gisteren' });
    o.im.video.add(f4); o.im.meta.set(f4, { t: '2020-03-01T12:00:00.000Z', off: 0, duur: '0:01:05.600000' });
    const r = await o.ml.fotos(hr);
    assert.strictEqual(r.status, 200);
    const [a, b, c, d] = r.body.fotos;
    assert.deepStrictEqual(a, { id: f1, beeld: true, ratio: 1.5, dag: '2020-02-11', tijd: '2020-02-11T01:30:15', plaats: 'Proefstad', duur: null, fav: true }, 'plaatselijke dag over middernacht');
    assert.strictEqual(b.plaats, null, 'geen rare tekens als plaats'); assert.strictEqual(b.dag, '2020-02-11'); assert.strictEqual(b.fav, false);
    assert.strictEqual(c.dag, null); assert.strictEqual(c.tijd, null);
    assert.strictEqual(d.beeld, false); assert.strictEqual(d.duur, 66, 'video: duur in seconden');
    for (const x of r.body.fotos) for (const k of ['lat', 'lon', 'latitude', 'longitude', 'country', 'land']) assert.ok(!(k in x), 'geen ' + k);
    assert.ok(!JSON.stringify(r.body).includes('60.1') && !JSON.stringify(r.body).includes('Proefland'));
    // totaal: de som van de bakken, ook als de grens eerder stopt
    const l = await o.im.client.albumFotos(al.id, 2);
    assert.strictEqual(l.length, 2); assert.strictEqual(l.totaal, 4); assert.ok(!JSON.stringify(l).includes('totaal'));
  } finally { o.sluit(); }
});

test("delen: foto's alleen met foto_delen (standaard uit), hooguit 8, gevel eerst, zonder Exif; weg bij uit, gevoelig of link uit; Immich weg blokkeert weghalen niet", async () => {
  const o = omgeving();
  try {
    o.reis('2020 - Proefrally Noorwegen.md', '2020-02-09 – 2020-02-15');
    o.opname(RA, 'shizzle');
    await o.tik();
    const hr = o.hid('reis', REIS), ha = o.hid('opname', RA);
    const al = o.im.albums.find((a) => a.id === o.album(hr).album_id);
    const vid = o.im.foto(al, webp(false)); o.im.video.add(vid);   // een video gaat nooit mee naar buiten
    const ids = [];
    for (let i = 0; i < 11; i++) ids.push(o.im.foto(al, webp(i === 2)));   // nr 2 heeft Exif
    const ala = o.im.albums.find((a) => a.id === o.album(ha).album_id);
    o.im.foto(ala, webp(false));
    o.ml.zicht(hr, { kring: 'familie', aan: true }); o.ml.zicht(ha, { kring: 'familie', aan: true });
    await o.ml.link('familie', 'aan');
    await o.tik();
    assert.strictEqual(o.d1db.prepare("SELECT count(*) n FROM ml_item WHERE kring = 'familie'").get().n, 2);
    assert.strictEqual(o.fotosD1('familie').length, 0, "standaard: geen foto's naar buiten");
    assert.strictEqual(o.album(hr).foto_delen, 0);
    await o.ml.gevel(hr, { asset: ids[5] });
    assert.strictEqual((await o.ml.fotoDelen(hr, { aan: true })).status, 200);
    await o.tik();
    const pubR = o.ing._db.prepare("SELECT pub FROM ml_pub WHERE kring = 'familie' AND hid = ?").get(hr).pub;
    let f = o.fotosD1('familie');
    assert.ok(f.every((x) => x.pub === pubR), "alleen de reis heeft foto's (de opname niet aangezet)");
    assert.strictEqual(f.length, 7, '8 gekozen, de miniatuur met Exif valt af');
    assert.deepStrictEqual(Buffer.from(f[0].data, 'base64'), webp(false)); assert.strictEqual(f[0].mime, 'image/webp');
    assert.ok(o.im.log.filter((x) => x.includes('/thumbnail')).every((x) => x.endsWith('size=thumbnail')), 'naar buiten alleen miniaturen');
    assert.ok(o.im.log.some((x) => x.includes(ids[5] + '/thumbnail')), 'gevel zit erbij');
    assert.ok(!o.im.log.some((x) => x.includes(ids[10] + '/thumbnail')), 'hooguit 8');
    assert.ok(!o.im.log.some((x) => x.includes(vid + '/thumbnail')), 'geen video naar buiten');
    // vrienden-link uit: daar nooit iets
    assert.strictEqual(o.fotosD1('vrienden').length, 0);
    // review MOET 1: haalt David een gedeelde foto uit het Immich-album, dan verdwijnt hij in de volgende ronde ook van de link
    const weg1 = ids[0];
    al.assets = al.assets.filter((x) => x !== weg1);
    const telWeg = () => o.im.log.filter((x) => x.includes(weg1 + '/thumbnail')).length, voor = telWeg();
    await o.tik();
    const na = o.fotosD1('familie');
    assert.strictEqual(na.length, 7, 'aangevuld met de volgende foto');
    assert.ok(o.im.log.filter((x) => x.includes(ids[8] + '/thumbnail')).length >= 1, 'de volgende foto schoof erbij');
    assert.strictEqual(telWeg(), voor, 'de weggehaalde foto niet opnieuw opgehaald voor de link');
    al.assets.unshift(weg1); await o.tik();
    // Immich weg + foto's uit → toch meteen weg uit D1
    o.im.uit = true;
    await o.ml.fotoDelen(hr, { aan: false });
    await o.tik();
    assert.strictEqual(o.fotosD1('familie').length, 0, "foto's uit = weg uit D1, ook met Immich weg");
    o.im.uit = false;
    await o.ml.fotoDelen(hr, { aan: true }); await o.tik();
    assert.strictEqual(o.fotosD1('familie').length, 7);
    // Immich weg terwijl de tekst verandert: tekst gaat wel naar buiten, foto's blijven staan tot het weer lukt
    o.im.uit = true;
    o.ml.tekst(hr, { tekst: 'De auto startte pas na een uur.', soort: 'aanvulling' });
    await o.tik();
    assert.match(o.d1db.prepare('SELECT stukken FROM ml_item WHERE pub = ?').get(pubR).stukken, /startte pas/);
    o.im.uit = false;
    // herinnering gevoelig → item en foto's weg
    o.ml.categorie(hr, { categorie: 'reizen', gevoelig: true });
    await o.tik();
    assert.strictEqual(o.d1db.prepare('SELECT count(*) n FROM ml_item WHERE pub = ?').get(pubR).n, 0);
    assert.strictEqual(o.fotosD1('familie').length, 0, "gevoelig: ook de foto's weg");
    o.ml.categorie(hr, { categorie: 'reizen', gevoelig: false }); o.ml.zicht(hr, { kring: 'familie', aan: true });
    await o.tik();
    assert.strictEqual(o.fotosD1('familie').length, 7);
    // link uit → niets meer
    await o.ml.link('familie', 'uit');
    assert.strictEqual(o.fotosD1('familie').length, 0);
    assert.strictEqual(o.d1db.prepare('SELECT count(*) n FROM ml_item').get().n, 0);
  } finally { o.sluit(); }
});

test('zonder Immich-sleutel: geen albums, lijst zegt het, geen fout in de tik', async () => {
  const o = omgeving();
  try {
    o.im.sleutel = 'andere';   // nep-Immich kent de sleutel van de client niet
    const zonder = M.maak({ db: o.ing._db, vault: o.vault, vv: VV, dir: path.join(o.basis, 'h2'), d1: null, kluis: async () => null, marker: P, geheimen: () => [],
      categorieen: H.CATEGORIEEN, nu: () => o.klok.t, fout: () => {}, reisVandaag: () => '2026-10-31',
      immich: IM.maak({ basis: 'https://immich.proef.invalid', sleutel: async () => null, fetch: o.im.fetch }) });
    o.reis('2020 - Proefrally Noorwegen.md', '2020-02-09 – 2020-02-15');
    const u = await zonder.tik();
    assert.ok(!u.fout);
    assert.strictEqual(o.im.log.length, 0, 'zonder sleutel gaat er niets naar Immich');
    const l = zonder.lijst().body;
    assert.strictEqual(l.immich.sleutel, false);
    assert.strictEqual(l.herinneringen[0].album, null);
    assert.strictEqual((await zonder.albumMaken(l.herinneringen[0].hid)).status, 503);
  } finally { o.sluit(); }
});

// ── wv2314 (R6, de straat): GET /app/memorylane/h/<hid>/gevel/k ──
test('wv2314 gevel: omslag zonder de fotolijst op te halen, gekozen gevel alleen zolang hij in het album staat, geen album/leeg = 404, toonmodus alleen toonbaar', async () => {
  const o = omgeving();
  try {
    o.reis('2020 - Proefrally Noorwegen.md', '2020-02-09 – 2020-02-15');
    o.opname(RA, 'prive');   // Privé = gevoelig: in de toonmodus nooit
    await o.tik();
    const hr = o.hid('reis', REIS), hp = o.hid('opname', RA);
    const al = o.im.albums.find((a) => a.id === o.album(hr).album_id), ap = o.im.albums.find((a) => a.id === o.album(hp).album_id);
    assert.strictEqual((await o.ml.gevelBeeld(hr)).status, 404, 'leeg album: geen gevel');
    const f1 = o.im.foto(al, webp(false)), f2 = o.im.foto(al, jpeg(false), 'image/jpeg');
    o.im.foto(ap, webp(false));
    await o.tik();   // sync neemt de omslag over
    const n0 = o.im.log.length;
    const g = await o.ml.gevelBeeld(hr);
    assert.strictEqual(g.status, 200); assert.deepStrictEqual(Buffer.from(g.body.data, 'base64'), webp(false));
    const nieuw = o.im.log.slice(n0);
    assert.deepStrictEqual(nieuw, ['GET /api/assets/' + f1 + '/thumbnail?size=thumbnail'], 'alleen de miniatuur van de omslag, geen fotolijst: ' + nieuw.join(' | '));
    // David kiest f2 als gevel → die; haalt hij f2 uit het album, dan na de cache weer de omslag
    assert.strictEqual((await o.ml.gevel(hr, { asset: f2 })).status, 200);
    let b = await o.ml.gevelBeeld(hr);
    assert.strictEqual(b.body.mime, 'image/jpeg', 'gekozen gevel');
    al.assets = al.assets.filter((x) => x !== f2);
    o.klok.t += 11 * 60000;
    b = await o.ml.gevelBeeld(hr);
    assert.strictEqual(b.status, 200); assert.strictEqual(b.body.mime, 'image/webp', 'gekozen gevel uit het album = terug naar de omslag');
    // toonmodus: de reis (categorie reizen) wel, de Privé-opname niet (404, zonder Immich te vragen)
    assert.strictEqual((await o.ml.gevelBeeld(hr, { toon: true })).status, 200);
    assert.strictEqual((await o.ml.gevelBeeld(hp)).status, 200, 'zonder toonmodus ziet David ook Privé');
    const n1 = o.im.log.length;
    assert.strictEqual((await o.ml.gevelBeeld(hp, { toon: true })).status, 404, 'toonmodus: Privé = 404');
    assert.strictEqual(o.im.log.length, n1, 'voor een niet-toonbare niets bij Immich gevraagd');
    assert.strictEqual((await o.ml.gevelBeeld('h0000000000000000')).status, 404, 'onbekende herinnering');
    assert.strictEqual((await o.ml.gevelBeeld('niet-een-hid')).status, 404);
    // album weg in Immich → 404
    o.im.albums.splice(o.im.albums.indexOf(al), 1);
    await o.tik();
    assert.strictEqual((await o.ml.gevelBeeld(hr)).status, 404, 'album weg');
    o.im.uit = true;
    assert.strictEqual((await o.ml.gevelBeeld(hp)).status, 503, 'Immich weg = 503, geen uitzondering');
  } finally { o.sluit(); }
});

// ── wv2325: Plaatje maken ──
const PL = require(path.join(ROOT, 'memorylane-plaatje.js'));
// verzonnen webp zoals OpenAI hem geeft: beeldstuk + C2PA-herkomstblok (+ desgewenst EXIF)
function oaiWebp(exif) {
  const chunk = (id, data) => { const l = Buffer.alloc(4); l.writeUInt32LE(data.length); return Buffer.concat([Buffer.from(id, 'latin1'), l, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), chunk('VP8 ', Buffer.from([9, 8, 7, 6, 5])), chunk('C2PA', Buffer.from('herkomst-verzonnen-openai')),
    exif ? chunk('EXIF', Buffer.from('Exif\0\0GPS-verzonnen')) : Buffer.alloc(0)]);
  const l = Buffer.alloc(4); l.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), l, body]);
}
function nepBeeld() {
  const st = { aanvragen: [], antwoord: null };
  st.beeld = async (x) => { st.aanvragen.push(JSON.parse(JSON.stringify(x))); return st.antwoord || { ok: true, mime: 'image/webp', data: oaiWebp(true), model: 'gpt-image-1-mini', usd: 0.0086, ms: 5 }; };
  return st;
}

test('wv2325 webpZonderMetadata: alleen beeldstukken, C2PA/EXIF/XMP/ICCP eraf, VP8X-vlaggen uit; geen webp of geen beeld = null', () => {
  const s = PL.webpZonderMetadata(oaiWebp(true));
  assert.ok(s && !IM.heeftMetadata(s));
  assert.ok(!s.includes(Buffer.from('C2PA')) && !s.includes(Buffer.from('herkomst')) && !s.includes(Buffer.from('GPS')));
  assert.strictEqual(s.readUInt32LE(4), s.length - 8, 'RIFF-lengte klopt');
  assert.ok(s.includes(Buffer.from([9, 8, 7, 6, 5])), 'beeld blijft');
  // VP8X met ICC/EXIF/XMP-vlaggen
  const chunk = (id, data) => { const l = Buffer.alloc(4); l.writeUInt32LE(data.length); return Buffer.concat([Buffer.from(id, 'latin1'), l, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x20 | 0x08 | 0x04 | 0x10;
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), chunk('VP8X', vp8x), chunk('ICCP', Buffer.from('profiel')), chunk('VP8L', Buffer.from([1, 2, 3])), chunk('XMP ', Buffer.from('<x/>'))]);
  const l = Buffer.alloc(4); l.writeUInt32LE(body.length);
  const x = PL.webpZonderMetadata(Buffer.concat([Buffer.from('RIFF', 'latin1'), l, body]));
  assert.ok(x && !IM.heeftMetadata(x) && !x.includes(Buffer.from('ICCP')) && !x.includes(Buffer.from('profiel')));
  assert.strictEqual(x[20], 0x10, 'alleen de alfavlag blijft');
  assert.strictEqual(PL.webpZonderMetadata(jpeg(false)), null);
  assert.strictEqual(PL.webpZonderMetadata(Buffer.from('RIFF\x10\0\0\0WEBPC2PA\x02\0\0\0ab', 'latin1')), null, 'zonder beeldstuk');
  assert.strictEqual(PL.webpZonderMetadata(oaiWebp(false).subarray(0, 23)), null, 'afgekapt');
});

test('wv2325 voorstel en opdracht: soort, jaar en titel; ≤ 200 tekens; vaste opdracht eromheen', () => {
  assert.strictEqual(PL.voorstelTekst('reis', '2019', 'Zomervakantie 2019 - Proefeiland'), 'Reis, 2019: Zomervakantie 2019 - Proefeiland');
  assert.strictEqual(PL.voorstelTekst('opname', null, 'Op de camping'), 'Herinnering: Op de camping');
  assert.strictEqual(PL.voorstelTekst('fotoalbum', '2005', 'x'.repeat(300)).length, 200);
  assert.strictEqual(PL.opdracht('Reis, 2019: strand.'), PL.OPDRACHT_BEGIN + 'Reis, 2019: strand' + PL.OPDRACHT_EIND);
  assert.strictEqual(PL.schoon('  a\nb‮ c '), 'a b c');
  assert.strictEqual(PL.schoon('x'.repeat(201)), null);
  assert.strictEqual(PL.schoon(''), null);
});

test('wv2325 plaatje: alleen de beschrijving naar buiten; weigeringen (Privé, gevoelig, zonder categorie, met foto, toonmodus, marker, geheim, daggrens, 10 s); bestand 0600 zonder metadata en weg; gevel = plaatje, foto wint', async () => {
  const nb = nepBeeld();
  const o = omgeving({ beeld: nb.beeld });
  try {
    o.reis('2020 - Proefrally Noorwegen.md', '2020-02-09 – 2020-02-15');
    o.opname(RA, 'prive');
    o.opname(RB, null);   // zonder categorie
    await o.tik();
    const hr = o.hid('reis', REIS), hp = o.hid('opname', RA), hz = o.hid('opname', RB);
    // lijst: plaatje_kan alleen bij de reis (categorie reizen, geen foto)
    const l = o.ml.lijst().body.herinneringen;
    const kan = Object.fromEntries(l.map((x) => [x.hid, x.plaatje_kan]));
    assert.deepStrictEqual([kan[hr], kan[hp], kan[hz]], [true, false, false]);
    assert.ok(l.every((x) => x.plaatje === false));
    // voorstel: soort, jaar, titel; geen verhaal
    const v = o.ml.plaatjeVoorstel(hr);
    assert.strictEqual(v.status, 200); assert.match(v.body.beschrijving, /^Reis, 2020: /);
    assert.strictEqual(o.ml.plaatjeVoorstel(hp).status, 409, 'Privé: geen voorstel');
    assert.strictEqual(o.ml.plaatjeVoorstel(hr, { toon: true }).status, 403, 'toonmodus');
    // weigeringen vóór het beeldmodel
    for (const [hid, d, opt, st, wat] of [[hp, { beschrijving: 'Herinnering: camping' }, null, 409, 'Privé'], [hz, { beschrijving: 'Herinnering: camping' }, null, 409, 'zonder categorie'],
      [hr, { beschrijving: 'Reis, 2020: rally' }, { toon: true }, 403, 'toonmodus'], [hr, { beschrijving: '' }, null, 400, 'leeg'], [hr, { beschrijving: 'x'.repeat(201) }, null, 400, '> 200'],
      [hr, { beschrijving: 'Betreft: mw. J. Jansen, geboortedatum 12-03-1958. Bovengenoemde patiënt is bekend met diabetes mellitus; wij zagen haar op de polikliniek.' }, null, 409, 'marker'],
      [hr, { beschrijving: 'Reis sk-proj-abcdefghijklmnopqrstuvwxyz0123' }, null, 409, 'geheim'], ['h0000000000000000', { beschrijving: 'x' }, null, 404, 'onbekend']]) {
      const u = await o.ml.plaatjeMaken(hid, d, opt);
      assert.strictEqual(u.status, st, wat + ': ' + JSON.stringify(u.body));
    }
    // gevoelig vinkje op een niet-Privé-categorie
    o.ing._db.prepare('UPDATE ramble SET categorie = ?, herinnering_gevoelig = 1 WHERE ramble_id = ?').run('gezin', RB);
    assert.strictEqual((await o.ml.plaatjeMaken(hz, { beschrijving: 'Herinnering: camping' })).status, 409, 'gevoelig vinkje');
    assert.strictEqual(nb.aanvragen.length, 0, 'geen enkele weigering bij het beeldmodel');
    // maken: alleen de beschrijving in de vaste opdracht
    const u = await o.ml.plaatjeMaken(hr, { beschrijving: '  Reis, 2020: een rally door de sneeuw ' });
    assert.strictEqual(u.status, 200, JSON.stringify(u.body));
    assert.deepStrictEqual(nb.aanvragen, [{ prompt: PL.opdracht('Reis, 2020: een rally door de sneeuw') }]);
    assert.strictEqual(u.body.herinnering.plaatje, true);
    const bestand = path.join(o.hdir, 'plaatjes', hr + '.webp');
    assert.strictEqual(fs.statSync(bestand).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.dirname(bestand)).mode & 0o777, 0o700);
    const b = fs.readFileSync(bestand);
    assert.ok(!IM.heeftMetadata(b) && !b.includes(Buffer.from('C2PA')), 'zonder metadata bewaard');
    // register zonder tekst
    const rij = o.ing._db.prepare('SELECT * FROM ml_plaatje WHERE hid = ?').get(hr);
    assert.strictEqual(rij.model, 'gpt-image-1-mini'); assert.strictEqual(rij.usd, 0.0086);
    assert.strictEqual(rij.hash, crypto.createHash('sha256').update('Reis, 2020: een rally door de sneeuw').digest('hex'));
    const dump = JSON.stringify(o.ing._db.prepare('SELECT * FROM ml_plaatje').all()) + JSON.stringify(o.ing._db.prepare('SELECT * FROM ml_plaatje_aanvraag').all());
    assert.ok(!/rally|sneeuw|Reis/.test(dump), 'geen tekst in intake.sqlite');
    // binnen 10 s opnieuw = 429 zonder aanvraag
    assert.strictEqual((await o.ml.plaatjeMaken(hr, { beschrijving: 'Reis, 2020: rally' })).status, 429);
    assert.strictEqual(nb.aanvragen.length, 1);
    // gevel = het plaatje (zonder foto), ook in de toonmodus (reis is toonbaar)
    const g = await o.ml.gevelBeeld(hr);
    assert.strictEqual(g.status, 200); assert.strictEqual(g.body.mime, 'image/webp'); assert.strictEqual(g.body.plaatje, true);
    assert.deepStrictEqual(Buffer.from(g.body.data, 'base64'), b);
    assert.strictEqual((await o.ml.gevelBeeld(hr, { toon: true })).status, 200);
    // komt er een foto in het album, dan wint de foto en vervalt de knop
    const al = o.im.albums.find((a) => a.id === o.album(hr).album_id);
    o.im.foto(al, jpeg(false), 'image/jpeg');
    await o.tik();
    const g2 = await o.ml.gevelBeeld(hr);
    assert.strictEqual(g2.status, 200); assert.strictEqual(g2.body.mime, 'image/jpeg', 'foto wint'); assert.ok(!g2.body.plaatje);
    assert.strictEqual(o.ml.lijst().body.herinneringen.find((x) => x.hid === hr).plaatje_kan, false);
    o.klok.t += 11000;
    assert.strictEqual((await o.ml.plaatjeMaken(hr, { beschrijving: 'Reis, 2020: rally' })).status, 409, 'met foto: geen nieuw plaatje');
    // weghalen mag altijd (niet in de toonmodus); bestand en rij weg
    assert.strictEqual(o.ml.plaatjeWeg(hr, { toon: true }).status, 403);
    assert.strictEqual(o.ml.plaatjeWeg(hr).status, 200);
    assert.ok(!fs.existsSync(bestand)); assert.strictEqual(o.ing._db.prepare('SELECT count(*) n FROM ml_plaatje').get().n, 0);
    // toonmodus: een plaatje van een niet-toonbare herinnering komt niet via de gevelroute
    o.ing._db.prepare('UPDATE ramble SET categorie = ?, herinnering_gevoelig = 0 WHERE ramble_id = ?').run('gezin', RB);
    o.klok.t += 11000;
    assert.strictEqual((await o.ml.plaatjeMaken(hz, { beschrijving: 'Herinnering: camping' })).status, 200);
    o.ing._db.prepare('UPDATE ramble SET herinnering_gevoelig = 1 WHERE ramble_id = ?').run(RB);
    assert.strictEqual((await o.ml.gevelBeeld(hz)).status, 200, 'David ziet hem nog');
    assert.strictEqual((await o.ml.gevelBeeld(hz, { toon: true })).status, 404, 'toonmodus: gevoelig = 404');
    // beeldmodel weigert / budget op: geen bestand, nette zin
    o.ing._db.prepare('UPDATE ramble SET herinnering_gevoelig = 0 WHERE ramble_id = ?').run(RB);
    nb.antwoord = { ok: false, status: 'grens' };
    o.klok.t += 11000;
    const gr = await o.ml.plaatjeMaken(hz, { beschrijving: 'Herinnering: tent' });
    assert.strictEqual(gr.status, 502); assert.match(gr.body.fout, /budget/);
    assert.strictEqual(o.ml.lijst().body.herinneringen.find((x) => x.hid === hz).plaatje, true, 'het vorige plaatje blijft bij een mislukte vervanging');
    nb.antwoord = { ok: true, mime: 'image/webp', data: jpeg(false), model: 'gpt-image-1-mini', usd: 0.0086 };
    o.klok.t += 11000;
    assert.strictEqual((await o.ml.plaatjeMaken(hz, { beschrijving: 'Herinnering: tent' })).status, 502, 'geen webp terug');
    // daggrens: 20 aanvragen per Nederlandse dag (ook mislukte)
    nb.antwoord = null;
    const n0 = o.ing._db.prepare('SELECT count(*) n FROM ml_plaatje_aanvraag').get().n;
    let st = [];
    for (let i = n0; i < 21; i++) { o.klok.t += 11000; st.push((await o.ml.plaatjeMaken(hz, { beschrijving: 'Herinnering: tent ' + i })).status); }
    assert.strictEqual(st[st.length - 1], 429, 'de 21e van de dag geweigerd: ' + st.join(','));
    assert.ok(st.slice(0, -1).every((x) => x === 200));
    assert.strictEqual(nb.aanvragen.length, 20);
    o.klok.t += 864e5;
    assert.strictEqual((await o.ml.plaatjeMaken(hz, { beschrijving: 'Herinnering: tent' })).status, 200, 'volgende dag weer');
    assert.ok(!o.fouten.length, o.fouten.join(' | '));
    assert.ok(o.ml.info().plaatjes.plaatjes === 1);
  } finally { o.sluit(); }
});

test('wv2325 zonder beeldmodel (o.beeld ontbreekt): geen knop, 409, gevel zoals voorheen', async () => {
  const o = omgeving();
  try {
    o.reis('2020 - Proefrally Noorwegen.md', '2020-02-09 – 2020-02-15');
    await o.tik();
    const hr = o.hid('reis', REIS);
    assert.strictEqual(o.ml.lijst().body.herinneringen[0].plaatje_kan, false);
    assert.strictEqual((await o.ml.plaatjeMaken(hr, { beschrijving: 'x' })).status, 409);
    assert.strictEqual((await o.ml.gevelBeeld(hr)).status, 404);
  } finally { o.sluit(); }
});

// ── wv2468 (Tripper): fotospoor — periode en één afgerond punt uit de foto's van een reis uit je foto's (verzonnen tijden en plekken) ──
test('wv2468 witte lijst: withCoordinates alleen "true" en alleen op de maandvraag; plaatselijkeDag', () => {
  const a = uuid();
  assert.strictEqual(IM.weiger('GET', '/api/timeline/bucket', { albumId: a, timeBucket: '2020-02-01', order: 'asc', withCoordinates: 'true' }), null);
  for (const w of ['false', '1', 'TRUE', '']) assert.strictEqual(IM.weiger('GET', '/api/timeline/bucket', { albumId: a, timeBucket: '2020-02-01', withCoordinates: w }), 'query', w);
  assert.strictEqual(IM.weiger('GET', '/api/timeline/buckets', { albumId: a, withCoordinates: 'true' }), 'query');
  assert.strictEqual(IM.weiger('GET', '/api/timeline/bucket', { albumId: a, timeBucket: '2020-02-01', bbox: '1,2,3,4' }), 'query');
  assert.strictEqual(IM.plaatselijkeDag('2020-02-10T23:30:00.000Z', 1), '2020-02-11');
  assert.strictEqual(IM.plaatselijkeDag('2020-02-10T02:00:00.000Z', -5), '2020-02-09');
  assert.strictEqual(IM.plaatselijkeDag('2020-02-10T02:00:00.000Z', null), '2020-02-10');
  assert.strictEqual(IM.plaatselijkeDag('2020-02-10T02:00:00.000Z', 99), '2020-02-10', 'onzinnige afwijking = 0');
  assert.strictEqual(IM.plaatselijkeDag('geen tijd', 1), null);
  assert.strictEqual(IM.plaatselijkeDag(null, 1), null);
});
test('wv2468 spoorUit: periode = drukste 31 dagen bij ≥ 80 % en ≥ 3 foto\'s; punt = mediaan op 1 decimaal bij ≥ 5 GPS, 0,0 telt niet', () => {
  const f = (dag, lat, lon) => ({ dag, lat: lat ?? null, lon: lon ?? null });
  // 9 van 10 binnen 31 dagen, één uitschieter jaren later: periode = het venster, niet eerste–laatste van alles
  const a = MF.spoorUit([f('2014-06-20'), f('2014-06-21'), f('2014-06-22'), f('2014-06-25'), f('2014-07-01'), f('2014-07-02'), f('2014-07-10'), f('2014-07-19'), f('2014-07-20'), f('2019-01-01')]);
  assert.deepStrictEqual([a.van, a.tot, a.fotos, a.met_dag, a.met_gps, a.lat], ['2014-06-20', '2014-07-20', 10, 10, 0, null]);
  // 31 dagen precies: 1 t/m 31 juli past; 1 juli t/m 1 augustus (32 dagen) niet als venster
  assert.strictEqual(MF.spoorUit([f('2014-07-01'), f('2014-07-15'), f('2014-07-31')]).tot, '2014-07-31');
  const b = MF.spoorUit([f('2014-07-01'), f('2014-07-15'), f('2014-08-01')]);
  assert.strictEqual(b.van, null, '2 van 3 binnen 31 dagen = 67 % < 80 %');
  assert.strictEqual(MF.spoorUit([f('2014-07-01'), f('2014-07-02')]).van, null, 'minder dan 3 foto\'s met een datum: geen periode');
  assert.strictEqual(MF.spoorUit([f('2014-07-01'), f(null), f('2014-07-02'), f('2014-07-03')]).van, '2014-07-01', 'foto zonder datum telt niet mee in de noemer');
  // punt
  const g = MF.spoorUit([f('2014-07-01', 45.11, 6.31), f('2014-07-01', 45.14, 6.29), f('2014-07-02', 45.2, 6.4), f('2014-07-02', 52.0, 5.0), f('2014-07-03', 45.12, 6.33), f('2014-07-03', 0, 0)]);
  assert.strictEqual(g.met_gps, 5, '0,0 telt niet');
  assert.deepStrictEqual([g.lat, g.lon], [45.1, 6.3], 'mediaan (45.14, 6.31) op 1 decimaal; één punt thuis trekt hem niet weg');
  assert.strictEqual(MF.spoorUit([f('2014-07-01', 45, 6), f('2014-07-01', 45, 6), f('2014-07-01', 45, 6), f('2014-07-01', 45, 6)]).lat, null, '4 met GPS: geen punt');
  assert.strictEqual(MF.spoorUit([f('2014-07-01', 95, 6), f('2014-07-01', 45, 190), f('2014-07-01', NaN, 6), f('2014-07-01', '45', 6), f('2014-07-01', 45, 6)]).met_gps, 1, 'ongeldige plekken tellen niet');
  const leeg = MF.spoorUit(null);
  assert.deepStrictEqual([leeg.fotos, leeg.van, leeg.lat], [0, null, null]);
});
test('wv2468 sync: fotospoor alleen voor kandidaten met spoor, opnieuw bij een ander aantal, hooguit 8 per ronde, alleen uitkomst in ml_fotospoor', async () => {
  const im = nepImmich();
  const db = new DatabaseSync(':memory:');
  const klok = { t: Date.parse('2026-11-05T12:00:00Z') };
  const fouten = [];
  const F = MF.maak({ db, immich: im.client, nu: () => klok.t, fout: (l, e) => fouten.push(l + ': ' + (e && e.message)) });
  const kand = [];
  for (let i = 0; i < 10; i++) kand.push({ hid: 'h00000000000000a' + i, soort: 'los', ref: 'google:00000000000000a' + i, titel: 'Proefreis ' + i, jaar: '2014', auto: true, spoor: i !== 5 });
  await F.sync(kand, true);   // maakt 6 lege albums
  const albumVan = (hid) => im.albums.find((a) => a.id === db.prepare('SELECT album_id FROM ml_album WHERE hid = ?').get(hid).album_id);
  // album 0: 6 foto's in juli 2014 (Frankrijk-achtig verzonnen), album 1: 2 foto's; albums 2–4 leeg; album 5 heeft geen spoor
  const a0 = albumVan('h00000000000000a0');
  [[45.11, 6.31], [45.14, 6.29], [45.2, 6.4], [52.0, 5.0], [null, null], [null, null]].forEach(([lat, lon], i) => {
    const id = im.foto(a0, webp(false)); im.meta.set(id, { t: '2014-07-0' + (i + 1) + 'T09:00:00.000Z', off: 2, lat, lon });
  });
  const verst = im.foto(a0, webp(false)); im.prullenbak.add(verst); im.meta.set(verst, { t: '2001-01-01T09:00:00.000Z', lat: 10, lon: 10 });
  const a1 = albumVan('h00000000000000a1'); for (let i = 0; i < 2; i++) im.foto(a1, webp(false));
  for (let i = 0; i < 3; i++) im.foto(albumVan('h00000000000000a5'), webp(false));
  im.log.length = 0;
  klok.t += 11 * 60000;
  const s1 = await F.sync(kand, false);
  assert.strictEqual(s1.spoor, 8, 'hooguit 8 per ronde');
  assert.ok(im.log.some((l) => /withCoordinates=true/.test(l)), 'plek gevraagd met withCoordinates');
  assert.ok(!im.log.some((l) => /withCoordinates/.test(l) && l.includes(albumVan('h00000000000000a5').id)), 'geen spoor voor een herinnering zonder spoor');
  klok.t += 11 * 60000;
  const s2 = await F.sync(kand, false);
  assert.strictEqual(s2.spoor, 1, 'de negende de volgende ronde');
  const sp0 = F.spoor('h00000000000000a0');
  assert.deepStrictEqual([sp0.fotos, sp0.met_dag, sp0.met_gps, sp0.van, sp0.tot], [6, 6, 4, '2014-07-01', '2014-07-06'], 'prullenbak telt niet');
  assert.strictEqual(sp0.punt, null, '4 met GPS is te weinig');
  assert.strictEqual(F.spoor('h00000000000000a1').van, null, '2 foto\'s: geen periode');
  assert.strictEqual(F.spoor('h00000000000000a5'), null);
  // een vijfde GPS-foto erbij: ander aantal → opnieuw gerekend in de volgende ronde
  const id = im.foto(a0, webp(false)); im.meta.set(id, { t: '2014-07-03T09:00:00.000Z', off: 2, lat: 45.13, lon: 6.32 });
  klok.t += 11 * 60000;
  const s3 = await F.sync(kand, false);
  assert.strictEqual(s3.spoor, 1);
  assert.deepStrictEqual(F.spoor('h00000000000000a0').punt, { lat: 45.1, lon: 6.3 });
  // niets veranderd: geen nieuwe vraag aan Immich voor het spoor
  im.log.length = 0; klok.t += 11 * 60000;
  assert.strictEqual((await F.sync(kand, false)).spoor, 0);
  assert.ok(!im.log.some((l) => /withCoordinates/.test(l)));
  // na 7 dagen opnieuw (oudste eerst)
  klok.t += 7 * 86400000;
  assert.strictEqual((await F.sync(kand, false)).spoor, 8);
  // alleen hid, aantallen, datums, afgeronde plek en tijd in de tabel
  const kol = db.prepare('PRAGMA table_info(ml_fotospoor)').all().map((k) => k.name).sort().join();
  assert.strictEqual(kol, 'aantal_bij,fotos,hid,lat,lon,met_dag,met_gps,op,tot,van');
  assert.ok(db.prepare('SELECT lat, lon FROM ml_fotospoor WHERE lat IS NOT NULL').all().every((r) => Math.round(r.lat * 10) === r.lat * 10 && Math.round(r.lon * 10) === r.lon * 10));
  assert.deepStrictEqual(F.info().fotospoor, { gerekend: 9, periode: 1, punt: 1 });
  // Immich faalt tijdens het spoor: één fout gelogd (geen namen), de ronde stopt, de oude uitkomst blijft
  assert.deepStrictEqual(fouten, []);
  im.foto(a0, webp(false)); im.bucketUit = true; klok.t += 11 * 60000;
  const s4 = await F.sync(kand, false);
  assert.strictEqual(s4.spoor, 0);
  assert.deepStrictEqual(F.spoor('h00000000000000a0').punt, { lat: 45.1, lon: 6.3 }, 'oude uitkomst blijft');
  assert.deepStrictEqual(fouten, ['ml-immich-spoor: immich: HTTP 500']);
});
test('wv2468 fotoReizen geeft het spoor van een reis uit je foto\'s mee (periode en afgerond punt, geen ids of steden)', async () => {
  const o = omgeving();
  try {
    const t = '2026-10-31T19:00:00Z';
    const ins = o.ing._db.prepare("INSERT INTO ml_herinnering (hid, soort, ref, categorie, gevoelig, status, aangemaakt, gewijzigd) VALUES (?, 'los', ?, ?, 0, 'actief', ?, ?)");
    ins.run('h00000000000000f1', 'google:00000000000000f1', 'reizen', t, t);
    ins.run('h00000000000000f2', 'google:00000000000000f2', 'gezin', t, t);
    await o.tik();   // albums maken
    const rij = o.album('h00000000000000f1'); assert.ok(rij && rij.album_id);
    const a = o.im.albums.find((x) => x.id === rij.album_id);
    for (let i = 0; i < 5; i++) { const id = o.im.foto(a, webp(false)); o.im.meta.set(id, { t: '2018-08-1' + i + 'T12:00:00.000Z', off: 2, lat: 41.38 + i * 0.01, lon: 2.17 }); }
    const g = o.album('h00000000000000f2'), ga = o.im.albums.find((x) => x.id === g.album_id);
    for (let i = 0; i < 5; i++) { const id = o.im.foto(ga, webp(false)); o.im.meta.set(id, { lat: 50, lon: 5 }); }
    o.im.log.length = 0;
    await o.tik();
    // wv2932: het spoor wordt nu voor elk fotoalbum zonder gevoelig-vinkje gerekend (koppel() legt het naast de reizen); fotoReizen blijft Reizen
    assert.ok(o.im.log.some((l) => /withCoordinates/.test(l) && l.includes(ga.id)), 'gezinsalbum: ook spoor (wv2932)');
    const r = o.ml.fotoReizen();
    assert.strictEqual(r.length, 1);
    assert.deepStrictEqual(r[0].spoor, { van: '2018-08-10', tot: '2018-08-14', punt: { lat: 41.4, lon: 2.2 }, fotos: 5, met_gps: 5 });
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(JSON.stringify(r)), 'geen foto- of album-ids');
  } finally { o.sluit(); }
});

// ── wv2614: Studio › Fotoherstel — origineel lezen, nieuwe foto, stapel en album; nooit iets aan een bestaande foto ──
function png(n) { const b = Buffer.alloc(40 + (n || 0)); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.write('verzonnen', 16); return b; }
function nepStudioImmich() {
  const ik = uuid(), ander = uuid();
  const st = { assets: new Map(), albums: new Map(), stapels: [], log: [], bodies: [], sleutel: 'proefsleutel-verzonnen-0123456789', ik, ander };
  const res = (status, obj, ct) => new Response(Buffer.isBuffer(obj) ? obj : JSON.stringify(obj), { status, headers: { 'content-type': ct || 'application/json' } });
  st.fetch = async (url, init) => {
    const u = new URL(url), m = init.method;
    st.log.push(m + ' ' + u.pathname + u.search);
    if (init.headers['x-api-key'] !== st.sleutel) return res(401, {});
    let r;
    if (m === 'GET' && (r = /^\/api\/assets\/([0-9a-f-]{36})$/.exec(u.pathname))) {
      const a = st.assets.get(r[1]); if (!a) return res(404, {});
      return res(200, { id: a.id, type: a.type || 'IMAGE', originalMimeType: a.mime, ownerId: a.eigenaar || ik, fileCreatedAt: a.opname, isTrashed: false, originalFileName: a.naam || 'IMG.jpg',
        stack: a.stapel ? { id: a.stapel, primaryAssetId: a.id, assetCount: 2 } : null, exifInfo: { fileSizeInByte: a.data.length, description: a.beschrijving || '' } });
    }
    if (m === 'GET' && (r = /^\/api\/assets\/([0-9a-f-]{36})\/original$/.exec(u.pathname))) { const a = st.assets.get(r[1]); return a ? res(200, a.data, 'application/octet-stream') : res(404, {}); }
    if (m === 'GET' && u.pathname === '/api/albums' && u.searchParams.get('assetId')) {
      const id = u.searchParams.get('assetId');
      return res(200, [...st.albums.values()].filter((x) => x.assets.includes(id)).map((x) => ({ id: x.id, albumName: x.naam, description: '', assetCount: x.assets.length })));
    }
    if (m === 'POST' && u.pathname === '/api/assets') {
      assert.ok(init.body instanceof FormData, 'multipart');
      assert.strictEqual(init.headers['Content-Type'], undefined, 'fetch zet zelf de boundary');
      const f = init.body.get('assetData'), data = Buffer.from(await f.arrayBuffer());
      const velden = [...init.body.keys()];
      st.bodies.push({ velden, naam: f.name, opname: init.body.get('fileCreatedAt'), xmp: init.body.get('sidecarData') ? Buffer.from(await init.body.get('sidecarData').arrayBuffer()).toString() : null });
      const dub = [...st.assets.values()].find((a) => a.data.equals(data));
      if (dub) return res(200, { id: dub.id, status: 'duplicate' });
      const id = uuid(); st.assets.set(id, { id, data, mime: f.type, opname: init.body.get('fileCreatedAt'), naam: f.name });
      return res(201, { id, status: 'created' });
    }
    if (m === 'POST' && u.pathname === '/api/stacks') {
      const b = JSON.parse(init.body); const sid = uuid(); st.stapels.push(b.assetIds);
      b.assetIds.forEach((x) => { st.assets.get(x).stapel = sid; });
      return res(201, { id: sid, primaryAssetId: b.assetIds[0], assets: [] });
    }
    if (m === 'PUT' && (r = /^\/api\/albums\/([0-9a-f-]{36})\/assets$/.exec(u.pathname))) {
      const al = st.albums.get(r[1]); const b = JSON.parse(init.body);
      if (!al) return res(400, {});
      return res(200, b.ids.map((x) => { if (al.assets.includes(x)) return { id: x, success: false, error: 'duplicate' }; al.assets.push(x); return { id: x, success: true }; }));
    }
    return res(404, {});
  };
  st.client = IM.maak({ basis: 'https://immich.voorbeeld.test', sleutel: async () => st.sleutel, fetch: st.fetch });
  st.zetFoto = (o) => { const id = uuid(); st.assets.set(id, Object.assign({ id, data: png(Math.floor(Math.random() * 1000)), mime: 'image/png', opname: '1936-03-01T12:00:00.000Z' }, o || {})); return id; };
  st.zetAlbum = (ids) => { const id = uuid(); st.albums.set(id, { id, naam: 'Proefalbum verzonnen', assets: ids.slice() }); return id; };
  return st;
}

test('wv2614 witte lijst: origineel lezen, foto-gegevens, albums van een foto; nieuwe foto alleen in eigen vorm; stapel van twee; één id in een album', () => {
  const a = uuid(), b = uuid(), t = 'a1b2c3d4e5f60718', P = png(), J = jpeg(false), W = webp(false), X = IM.xmpBeschrijving('Hersteld met AI (SeedVR2), origineel in de stapel');
  const D = '1936-03-01T12:00:00.000Z';
  const goed = [['GET', '/api/assets/' + a + '/original'], ['GET', '/api/assets/' + a], ['GET', '/api/albums', { assetId: a }], ['GET', '/api/users/me'], ['GET', '/api/api-keys/me'],
    ['POST', '/api/assets', undefined, { assetData: P, filename: 'socev-studio-' + t + '.png', fileCreatedAt: D, fileModifiedAt: D }],
    ['POST', '/api/assets', undefined, { assetData: J, filename: 'socev-studio-' + t + '.jpg', fileCreatedAt: '2020-01-01T10:00:00+01:00', fileModifiedAt: D, sidecarData: X }],
    ['POST', '/api/assets', undefined, { assetData: W, filename: 'socev-studio-' + t + '.webp', fileCreatedAt: D, fileModifiedAt: D }],
    ['POST', '/api/stacks', undefined, { assetIds: [a, b] }], ['PUT', '/api/albums/' + a + '/assets', undefined, { ids: [b] }]];
  for (const [m, p, q, bd] of goed) assert.strictEqual(IM.weiger(m, p, q, bd), null, m + ' ' + p);
  const fout = [
    ['GET', '/api/albums', { assetId: a, isOwned: 'true' }], ['GET', '/api/albums', { assetId: 'x' }], ['GET', '/api/assets/' + a + '/original', { edited: 'true' }],
    ['GET', '/api/assets/' + a + '/original/x'], ['GET', '/api/assets/' + a + '/video/playback', { size: 'x' }], ['PUT', '/api/assets/' + a + '/video/playback', undefined, {}], ['GET', '/api/assets'], ['GET', '/api/users/me', { x: '1' }], ['GET', '/api/users'], ['GET', '/api/users/' + a], ['PUT', '/api/users/me', undefined, {}], ['GET', '/api/api-keys'], ['GET', '/api/api-keys/' + a], ['PUT', '/api/api-keys/' + a, undefined, { permissions: ['all'] }], ['POST', '/api/api-keys/' + a + '/rotate'], ['GET', '/api/api-keys/me', { x: '1' }],
    ['POST', '/api/assets', undefined, { assetData: P, filename: 'IMG_0001.png', fileCreatedAt: D, fileModifiedAt: D }],
    ['POST', '/api/assets', undefined, { assetData: P, filename: 'socev-studio-' + t + '.jpg', fileCreatedAt: D, fileModifiedAt: D }],   // naam past niet bij de bytes
    ['POST', '/api/assets', undefined, { assetData: Buffer.from('GIF89a-verzonnen-gif'), filename: 'socev-studio-' + t + '.png', fileCreatedAt: D, fileModifiedAt: D }],
    ['POST', '/api/assets', undefined, { assetData: P, filename: 'socev-studio-' + t + '.png', fileCreatedAt: D, fileModifiedAt: D, visibility: 'hidden' }],
    ['POST', '/api/assets', undefined, { assetData: P, filename: 'socev-studio-' + t + '.png', fileCreatedAt: D, fileModifiedAt: D, livePhotoVideoId: a }],
    ['POST', '/api/assets', undefined, { assetData: P, filename: 'socev-studio-' + t + '.png', fileCreatedAt: D, fileModifiedAt: D, metadata: [] }],
    ['POST', '/api/assets', undefined, { assetData: P, filename: 'socev-studio-' + t + '.png', fileCreatedAt: D, fileModifiedAt: D, isFavorite: true }],
    ['POST', '/api/assets', undefined, { assetData: P, filename: 'socev-studio-' + t + '.png', fileCreatedAt: 'gisteren', fileModifiedAt: D }],
    ['POST', '/api/assets', undefined, { assetData: P, filename: 'socev-studio-' + t + '.png', fileCreatedAt: D }],
    ['POST', '/api/assets', undefined, { assetData: P, filename: 'socev-studio-' + t + '.png', fileCreatedAt: D, fileModifiedAt: D, sidecarData: Buffer.from('<x:xmpmeta><exif:GPSLatitude>52</exif:GPSLatitude></x:xmpmeta>') }],
    ['POST', '/api/assets', undefined, { assetData: Buffer.concat([P, Buffer.alloc(25 * 1024 * 1024)]), filename: 'socev-studio-' + t + '.png', fileCreatedAt: D, fileModifiedAt: D }],
    ['POST', '/api/assets', { key: 'x' }, { assetData: P, filename: 'socev-studio-' + t + '.png', fileCreatedAt: D, fileModifiedAt: D }],
    ['POST', '/api/stacks', undefined, { assetIds: [a] }], ['POST', '/api/stacks', undefined, { assetIds: [a, a] }], ['POST', '/api/stacks', undefined, { assetIds: [a, b, uuid()] }],
    ['POST', '/api/stacks', undefined, { assetIds: [a, b], primaryAssetId: a }], ['PUT', '/api/stacks/' + a, undefined, { primaryAssetId: b }], ['DELETE', '/api/stacks/' + a],
    ['PUT', '/api/albums/' + a + '/assets', undefined, { ids: [b, uuid()] }], ['PUT', '/api/albums/' + a + '/assets', undefined, { ids: [] }], ['PUT', '/api/albums/' + a + '/assets', undefined, { ids: [b], x: 1 }],
    ['PUT', '/api/assets/' + a, undefined, { description: 'x' }], ['PUT', '/api/assets', undefined, { ids: [a], isArchived: true }], ['PUT', '/api/assets/' + a + '/original', undefined, {}],
    ['PUT', '/api/albums/assets', undefined, { albumIds: [a], assetIds: [b] }], ['POST', '/api/assets/' + a + '/edits', undefined, {}], ['DELETE', '/api/albums/' + a + '/assets', undefined, { ids: [b] }]];
  for (const [m, p, q, bd] of fout) assert.notStrictEqual(IM.weiger(m, p, q, bd), null, m + ' ' + p + ' ' + JSON.stringify(q || {}) + ' ' + Object.keys(bd || {}).join(','));
});

test('wv2614 stapel en album alleen met de eigen nieuwe foto van deze sessie; vreemde of al bestaande foto = geweigerd vóór de lijn', async () => {
  const st = nepStudioImmich();
  const orig = st.zetFoto(), vreemd = st.zetFoto(), al = st.zetAlbum([orig]);
  for (const [m, p, b] of [['POST', '/api/stacks', { assetIds: [vreemd, orig] }], ['PUT', '/api/albums/' + al + '/assets', { ids: [vreemd] }], ['PUT', '/api/albums/' + al + '/assets', { ids: [orig] }]])
    await assert.rejects(st.client.verzoek(m, p, undefined, b), (e) => e.code === 'WITTE_LIJST', m + ' ' + p);
  assert.strictEqual(st.log.length, 0);
  // eigen foto, en dan het origineel bovenop willen: ook geweigerd (eigen moet de eerste zijn, het origineel niet eigen)
  const up = await st.client.uploaden({ data: png(5), taak: 'a1b2c3d4e5f60718', opname: '1936-03-01T12:00:00.000Z', beschrijving: 'Hersteld met AI (SeedVR2), origineel in de stapel' });
  assert.strictEqual(up.nieuw, true);
  await assert.rejects(st.client.verzoek('POST', '/api/stacks', undefined, { assetIds: [orig, up.id] }), (e) => e.code === 'WITTE_LIJST');
  // dubbele upload (zelfde bytes als het ORIGINEEL): duplicate → niet eigen → geen stapel, geen album
  const dub = await st.client.uploaden({ data: st.assets.get(orig).data, taak: 'a1b2c3d4e5f60719', opname: '1936-03-01T12:00:00.000Z' });
  assert.deepStrictEqual(dub, { id: orig, nieuw: false });
  assert.deepStrictEqual(await st.client.stapelen(dub.id, vreemd), { gestapeld: false, reden: 'niet de eigen nieuwe foto' });
  await assert.rejects(st.client.inAlbum(al, dub.id), (e) => e.code === 'WITTE_LIJST');
  // velden van de upload: alleen de vaste vijf, naam in eigen vorm, XMP alleen met de beschrijving
  assert.deepStrictEqual(st.bodies[0].velden.sort(), ['assetData', 'fileCreatedAt', 'fileModifiedAt', 'sidecarData'], 'geen formulierveld filename (Immich toetst het zijbestand daar dan op)');
  assert.strictEqual(st.bodies[0].naam, 'socev-studio-a1b2c3d4e5f60718.png');
  assert.match(st.bodies[0].xmp, /<dc:description><rdf:Alt><rdf:li xml:lang="x-default">Hersteld met AI \(SeedVR2\), origineel in de stapel<\/rdf:li>/);
  assert.ok(!/GPS|DateTime|Date/i.test(st.bodies[0].xmp.replace('rdf:Description', '')), 'geen datum of plek in het zijbestand');
  assert.strictEqual(st.bodies[1].velden.indexOf('sidecarData'), -1, 'zonder beschrijving geen zijbestand');
});

test('wv2614 stapelen: alleen als het origineel geen stapel heeft (vlak ervoor gemeten) en van hetzelfde account is; album: alleen de eigen foto', async () => {
  const st = nepStudioImmich();
  const orig = st.zetFoto(), alStapel = st.zetFoto({ stapel: uuid() }), vanAnder = st.zetFoto({ eigenaar: st.ander });
  const al = st.zetAlbum([orig]);
  const mk = async (n) => (await st.client.uploaden({ data: png(100 + n), taak: 'a1b2c3d4e5f6071' + n, opname: '1936-03-01T12:00:00.000Z' })).id;
  const e1 = await mk(1), e2 = await mk(2), e3 = await mk(3);
  const voor = Buffer.from(st.assets.get(orig).data);
  assert.deepStrictEqual(await st.client.stapelen(e1, orig), { gestapeld: true });
  assert.deepStrictEqual(st.stapels, [[e1, orig]], 'eigen foto bovenop, origineel eronder');
  assert.deepStrictEqual(await st.client.stapelen(e2, alStapel), { gestapeld: false, reden: 'origineel zit al in een stapel' });
  assert.deepStrictEqual(await st.client.stapelen(e2, orig), { gestapeld: false, reden: 'origineel zit al in een stapel' }, 'tweede keer: nu heeft het origineel een stapel');
  assert.deepStrictEqual(await st.client.stapelen(e3, vanAnder), { gestapeld: false, reden: 'origineel is van een ander account' });
  assert.strictEqual(st.stapels.length, 1);
  assert.strictEqual(await st.client.inAlbum(al, e1), true);
  assert.strictEqual(await st.client.inAlbum(al, e1), true, 'al erin = goed (duplicate)');
  assert.deepStrictEqual(st.albums.get(al).assets, [orig, e1]);
  assert.ok(st.assets.get(orig).data.equals(voor), 'origineel byte voor byte gelijk');
  assert.ok(!st.log.some((r) => /^(PUT|PATCH|DELETE) \/api\/assets/.test(r)), 'nooit PUT/PATCH/DELETE op een foto');
  const gegevens = await st.client.fotoInfo(orig);
  assert.strictEqual(gegevens.stapel, true); assert.strictEqual(gegevens.opname, '1936-03-01T12:00:00.000Z');
  assert.deepStrictEqual((await st.client.albumsVan(orig)).map((x) => x.id), [al]);
  const o = await st.client.origineel(orig);
  assert.strictEqual(o.soort, 'png'); assert.ok(o.data.equals(voor));
  const gif = st.zetFoto({ data: Buffer.from('GIF89a-verzonnen-gif-bytes-hier') });
  await assert.rejects(st.client.origineel(gif), (e) => e.code === 'SOORT');
  assert.strictEqual(await st.client.fotoInfo(uuid()), null);
});
