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
  const st = { albums: [], beelden: new Map(), video: new Set(), uit: false, log: [], sleutel: 'proefsleutel-verzonnen-0123456789' };
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
    if (m === 'GET' && (r = /^\/api\/albums\/([0-9a-f-]{36})$/.exec(u.pathname))) { const a = st.albums.find((x) => x.id === r[1]); return a ? res(200, { id: a.id, albumName: a.albumName, description: a.description, assetCount: a.assets.length }) : res(404, {}); }
    if (m === 'GET' && u.pathname === '/api/timeline/buckets') { const a = st.albums.find((x) => x.id === u.searchParams.get('albumId')); return res(200, a && a.assets.length ? [{ timeBucket: '2020-02-01', count: Math.min(3, a.assets.length) }, ...(a.assets.length > 3 ? [{ timeBucket: '2020-03-01', count: a.assets.length - 3 }] : [])] : []); }
    if (m === 'GET' && u.pathname === '/api/timeline/bucket') {
      const a = st.albums.find((x) => x.id === u.searchParams.get('albumId'));
      const ids = !a ? [] : u.searchParams.get('timeBucket') === '2020-02-01' ? a.assets.slice(0, 3) : a.assets.slice(3);
      return res(200, { id: ids, isImage: ids.map((x) => !st.video.has(x)), isTrashed: ids.map(() => false), ratio: ids.map(() => 1.5) });
    }
    if (m === 'GET' && (r = /^\/api\/assets\/([0-9a-f-]{36})\/thumbnail$/.exec(u.pathname))) { const b = st.beelden.get(r[1]); return b ? res(200, b.buf, b.mime) : res(404, {}); }
    return res(404, { message: 'nep: onbekend' });
  };
  st.client = IM.maak({ basis: 'https://immich.proef.invalid', sleutel: async () => st.sleutel, fetch: st.fetch });
  st.foto = (album, buf, mime) => { const id = uuid(); st.beelden.set(id, { buf, mime: mime || 'image/webp' }); album.assets.push(id); return id; };
  st.davidsEigen = () => { const a = { id: uuid(), albumName: 'Vakantie 2019 (eigen album)', description: 'van David', assets: [] }; st.albums.push(a); return a; };
  return st;
}

function omgeving() {
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
    reisVandaag: () => '2026-10-31', immich: im.client });
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
  return { basis, vault, ing, ml, d1db, staat, klok, im, fouten, opname, reis, tik,
    hid: (soort, ref) => ing._db.prepare('SELECT hid FROM ml_herinnering WHERE soort = ? AND ref = ?').get(soort, ref).hid,
    album: (hid) => ing._db.prepare('SELECT * FROM ml_album WHERE hid = ?').get(hid),
    fotosD1: (k) => d1db.prepare('SELECT * FROM ml_foto WHERE kring = ? ORDER BY pub, nr').all(k),
    sluit: () => { ing.sluit(); fs.rmSync(basis, { recursive: true, force: true }); } };
}
const RA = 'r20261031-0123456789abcdef', RB = 'r20261031-fedcba9876543210';
const REIS = '20_Prive/Reizen/2020 - Proefrally Noorwegen.md';

test('witte lijst: alleen lezen en een leeg album aanmaken; al het andere geweigerd vóór er iets over de lijn gaat', async () => {
  const a = uuid();
  for (const [m, p, q, b] of [['GET', '/api/albums', {}, undefined], ['GET', '/api/albums/' + a], ['GET', '/api/timeline/buckets', { albumId: a, order: 'asc' }],
    ['GET', '/api/timeline/bucket', { albumId: a, timeBucket: '2020-02-01', order: 'asc' }], ['GET', '/api/assets/' + a + '/thumbnail', { size: 'thumbnail' }],
    ['GET', '/api/assets/' + a + '/thumbnail', { size: 'preview' }], ['POST', '/api/albums', null, { albumName: 'MemoryLane – Proef', description: 'x' }]]) {
    assert.strictEqual(IM.weiger(m, p, q, b), null, m + ' ' + p);
  }
  const weg = [['POST', '/api/assets', null, {}], ['DELETE', '/api/albums/' + a], ['PATCH', '/api/albums/' + a, null, { albumName: 'x' }], ['PUT', '/api/albums/' + a + '/assets', null, { ids: [a] }],
    ['PUT', '/api/albums/assets', null, {}], ['DELETE', '/api/albums/' + a + '/assets', null, { ids: [a] }], ['POST', '/api/assets/delete'], ['DELETE', '/api/assets', null, { ids: [a] }],
    ['POST', '/api/albums', null, { albumName: 'x', assetIds: [a] }], ['POST', '/api/albums', null, { albumName: 'x', albumUsers: [{ userId: a, role: 'editor' }] }],
    ['POST', '/api/albums', null, {}], ['POST', '/api/albums', { x: '1' }, { albumName: 'x' }], ['GET', '/api/assets/' + a + '/original'], ['GET', '/api/assets/' + a + '/thumbnail', { size: 'original' }],
    ['GET', '/api/assets/' + a + '/thumbnail', { size: 'fullsize' }], ['GET', '/api/assets/' + a], ['GET', '/api/albums', { shared: 'true' }], ['GET', '/api/albums/../users'],
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
    assert.deepStrictEqual(namen, ['MemoryLane – Opname 31-10-2026 10:37', 'MemoryLane – Proefrally Noorwegen 2020', 'Vakantie 2019 (eigen album)']);
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
