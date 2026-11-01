'use strict';
/*
 * Immich-lezer voor MemoryLane (wv2120, 31-10-2026; David JA 20:15, vraag-id 7e507ded). Ontwerp in de vault: "01_Ontwikkeling/Second Brain
 * 2.0 - fase R rambles en herinneringen (ontwerp 29-10-2026).md" § 15.
 *
 * WAAROM. David zet zijn foto's per reis of herinnering in een Immich-album (Immich draait op Olares); MemoryLane toont ze. Socev maakt die
 * albums aan, verder niets. De sleutel (kluis immich_api_key, David maakte hem 31-10) heeft RUIMERE rechten dan nodig (o.a. foto's uploaden,
 * foto's aan albums toevoegen of eruit halen, deellinks, systeeminstellingen). Deze witte lijst is dus de echte grens:
 *   GET  /api/albums                                   alle albums (naam, omschrijving, aantal, omslag)
 *   GET  /api/albums/<uuid>                            één album
 *   GET  /api/timeline/buckets?albumId=<uuid>          maanden met foto's in dat album (v3 geeft in een album geen fotolijst meer)
 *   GET  /api/timeline/bucket?albumId=<uuid>&timeBucket=<datum>   foto-ids van die maand
 *   GET  /api/assets/<uuid>/thumbnail?size=thumbnail|preview      miniatuur of voorbeeld (nooit het origineel)
 *   POST /api/albums  {albumName, description}         album aanmaken, LEEG (geen assetIds, geen albumUsers)
 *   PATCH /api/albums/<uuid>  {albumName}              ALLEEN de naam van een album (wv2225; memorylane-fotos.js doet dat alleen bij albums
 *                                                       met zijn eigen code en naamvorm). Geen omschrijving, omslag, volgorde of delen.
 * Al het andere (PUT/DELETE, andere PATCH-velden, uploaden, foto's toevoegen of verplaatsen, delen, ander pad, andere query, andere body) weigert
 * verzoek() vóór er iets over de lijn gaat. Doorverwijzingen worden niet gevolgd.
 * PRIVACY. Nooit de sleutel, albumnamen of foto-inhoud in logs of fouten; alleen HTTP-status en het soort verzoek.
 * VORM. Alleen ingebouwde modules; sleutel(), fetch en basis komen via maak({...}).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BUCKET_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?)?$/;
const MAX_JSON = 8 * 1024 * 1024, MAX_BEELD = 4 * 1024 * 1024;
const BEELD_MIME = { 'image/jpeg': true, 'image/webp': true, 'image/png': true };
const MAX_NAAM = 200, MAX_OMSCHRIJVING = 1000;

function u(x) { return typeof x === 'string' && UUID_RE.test(x); }
async function leesBegrensd(res, max) {
  if (!res.body || typeof res.body.getReader !== 'function') { const b = Buffer.from(await res.arrayBuffer()); if (b.length > max) { const f = new Error('immich: antwoord te groot'); f.code = 'GROOT'; throw f; } return b; }
  const r = res.body.getReader(), delen = [];
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    n += value.length;
    if (n > max) { try { await r.cancel(); } catch (e) { /* weg */ } const f = new Error('immich: antwoord te groot'); f.code = 'GROOT'; throw f; }
    delen.push(Buffer.from(value));
  }
  return Buffer.concat(delen, n);
}
// Witte lijst: geeft null (toegestaan) of de reden van weigeren. pad zonder query; query als object; body als object of undefined.
function weiger(methode, pad, query, body) {
  const q = query || {};
  const sleutels = Object.keys(q);
  const alleen = function (toegestaan) { return sleutels.every(function (k) { return toegestaan.indexOf(k) >= 0; }); };
  if (typeof pad !== 'string' || /[^a-z0-9/-]/.test(pad) || pad.indexOf('//') >= 0) return 'pad';
  let m;
  if (methode === 'GET') {
    if (body !== undefined) return 'body bij GET';
    if (pad === '/api/albums') return sleutels.length ? 'query' : null;
    if ((m = /^\/api\/albums\/([0-9a-f-]{36})$/.exec(pad)) && u(m[1])) return sleutels.length ? 'query' : null;
    if (pad === '/api/timeline/buckets') return alleen(['albumId', 'order']) && u(q.albumId) && (q.order === undefined || q.order === 'asc' || q.order === 'desc') ? null : 'query';
    if (pad === '/api/timeline/bucket') return alleen(['albumId', 'timeBucket', 'order']) && u(q.albumId) && typeof q.timeBucket === 'string' && BUCKET_RE.test(q.timeBucket)
      && (q.order === undefined || q.order === 'asc' || q.order === 'desc') ? null : 'query';
    if ((m = /^\/api\/assets\/([0-9a-f-]{36})\/thumbnail$/.exec(pad)) && u(m[1])) return alleen(['size']) && (q.size === 'thumbnail' || q.size === 'preview') ? null : 'query';
    return 'pad';
  }
  if (methode === 'POST') {
    if (pad !== '/api/albums') return 'pad';
    if (sleutels.length) return 'query';
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body';
    const bk = Object.keys(body);
    if (!bk.every(function (k) { return k === 'albumName' || k === 'description'; })) return 'body';   // nooit assetIds of albumUsers
    if (typeof body.albumName !== 'string' || !body.albumName.trim() || body.albumName.length > MAX_NAAM) return 'body';
    if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > MAX_OMSCHRIJVING)) return 'body';
    return null;
  }
  if (methode === 'PATCH') {
    if (!(m = /^\/api\/albums\/([0-9a-f-]{36})$/.exec(pad)) || !u(m[1])) return 'pad';
    if (sleutels.length) return 'query';
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body';
    const bk = Object.keys(body);
    if (bk.length !== 1 || bk[0] !== 'albumName') return 'body';   // nooit description, albumThumbnailAssetId, order of isActivityEnabled
    if (typeof body.albumName !== 'string' || !body.albumName.trim() || body.albumName.length > MAX_NAAM) return 'body';
    return null;
  }
  return 'methode';
}

/*
 * maak(o) → { albums, album, maakAlbum, hernoemAlbum, albumFotos, beeld, verzoek }
 * o = { basis: 'https://immich…', sleutel: async () => string|null, fetch?, fout?(label, e), timeoutMs? }
 */
function maak(o) {
  const basis = String(o.basis || '').replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+$/.test(basis) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(basis)) throw new Error('immich: ongeldige basis');
  const doeFetch = o.fetch || fetch;
  const ms = o.timeoutMs || 20000;

  async function verzoek(methode, pad, query, body, soort) {
    const r = weiger(methode, pad, query, body);
    if (r) { const e = new Error('immich: niet toegestaan (' + r + ')'); e.code = 'WITTE_LIJST'; throw e; }
    const k = await o.sleutel();
    if (!k) { const e = new Error('immich: geen sleutel'); e.code = 'GEEN_SLEUTEL'; throw e; }
    const qs = query && Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : '';
    const koppen = { 'x-api-key': k, Accept: soort === 'beeld' ? 'image/webp,image/jpeg,image/png' : 'application/json', 'User-Agent': 'socev-memorylane/1' };
    if (body !== undefined) koppen['Content-Type'] = 'application/json';
    let res;
    try {
      res = await doeFetch(basis + pad + qs, { method: methode, headers: koppen, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(ms) });
    } catch (e) { const f = new Error('immich: niet bereikbaar'); f.code = 'NET'; throw f; }
    if (res.status < 200 || res.status >= 300) {
      try { await res.arrayBuffer(); } catch (e) { /* weg */ }
      const f = new Error('immich: HTTP ' + res.status); f.code = 'HTTP'; f.status = res.status; throw f;
    }
    const ct = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const max = soort === 'beeld' ? MAX_BEELD : MAX_JSON;
    const lengte = Number(res.headers.get('content-length') || 0);
    if (lengte > max) { const f = new Error('immich: antwoord te groot'); f.code = 'GROOT'; throw f; }
    const buf = await leesBegrensd(res, max);   // review ZOU 1: harde grens tijdens het lezen, niet pas erna
    if (soort === 'beeld') {
      if (!BEELD_MIME[ct]) { const f = new Error('immich: geen beeld'); f.code = 'SOORT'; throw f; }
      return { mime: ct, data: buf };
    }
    if (ct !== 'application/json') { const f = new Error('immich: geen JSON'); f.code = 'SOORT'; throw f; }
    return JSON.parse(buf.toString('utf8'));
  }
  // Alleen de velden die MemoryLane gebruikt; ids gecontroleerd
  function albumKort(a) {
    if (!a || !u(a.id)) return null;
    return { id: a.id, naam: typeof a.albumName === 'string' ? a.albumName : '', omschrijving: typeof a.description === 'string' ? a.description : '',
      aantal: Number.isFinite(a.assetCount) ? a.assetCount : 0, omslag: u(a.albumThumbnailAssetId) ? a.albumThumbnailAssetId : null };
  }
  async function albums() { const r = await verzoek('GET', '/api/albums'); return Array.isArray(r) ? r.map(albumKort).filter(Boolean) : []; }
  async function album(id) {
    if (!u(id)) throw new Error('immich: ongeldig album');
    try { return albumKort(await verzoek('GET', '/api/albums/' + id)); }
    catch (e) { if (e.code === 'HTTP' && (e.status === 404 || e.status === 400)) return null; throw e; }
  }
  async function maakAlbum(naam, omschrijving) {
    const a = albumKort(await verzoek('POST', '/api/albums', null, { albumName: naam, description: omschrijving }));
    if (!a) throw new Error('immich: onverwacht antwoord');
    return a;
  }
  // wv2225: alleen de naam; → het album (kort)
  async function hernoemAlbum(id, naam) {
    if (!u(id)) throw new Error('immich: ongeldig album');
    const a = albumKort(await verzoek('PATCH', '/api/albums/' + id, null, { albumName: naam }));
    if (!a || a.id !== id) throw new Error('immich: onverwacht antwoord');
    return a;
  }
  // Foto-ids van een album, oudste eerst, hooguit max; zonder prullenbak. → [{ id, beeld (false = video), ratio }]
  async function albumFotos(id, max) {
    if (!u(id)) throw new Error('immich: ongeldig album');
    const grens = Math.max(1, Math.min(500, max || 200));
    const bakken = await verzoek('GET', '/api/timeline/buckets', { albumId: id, order: 'asc' });
    const uit = [];
    for (const b of Array.isArray(bakken) ? bakken : []) {
      if (uit.length >= grens) break;
      const tb = b && typeof b.timeBucket === 'string' ? b.timeBucket : null;
      if (!tb || !BUCKET_RE.test(tb)) continue;
      const r = await verzoek('GET', '/api/timeline/bucket', { albumId: id, timeBucket: tb, order: 'asc' });
      const ids = r && Array.isArray(r.id) ? r.id : [];
      for (let i = 0; i < ids.length && uit.length < grens; i++) {
        if (!u(ids[i])) continue;
        if (Array.isArray(r.isTrashed) && r.isTrashed[i] === true) continue;
        uit.push({ id: ids[i], beeld: !(Array.isArray(r.isImage) && r.isImage[i] === false), ratio: Array.isArray(r.ratio) && Number.isFinite(r.ratio[i]) ? Math.round(r.ratio[i] * 1000) / 1000 : null });
      }
    }
    return uit;
  }
  // maat 'klein' = thumbnail (± 250 px), 'groot' = preview (± 1440 px). Nooit het origineel.
  async function beeld(assetId, maat) {
    if (!u(assetId)) throw new Error('immich: ongeldige foto');
    return verzoek('GET', '/api/assets/' + assetId + '/thumbnail', { size: maat === 'groot' ? 'preview' : 'thumbnail' }, undefined, 'beeld');
  }
  return { albums, album, maakAlbum, hernoemAlbum, albumFotos, beeld, verzoek, basis };
}

// Zit er nog metadata (Exif/XMP, met mogelijk de plek of het toestel) in een beeld? Dan delen we het niet naar buiten.
// JPEG: APP1 met "Exif\0\0" of XMP; WebP: RIFF-chunk EXIF of XMP; PNG: chunk eXIf of iTXt met XMP. Onbekend formaat = ja (niet delen).
function heeftMetadata(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return true;
      const mk = b[i + 1];
      if (mk === 0xd9 || mk === 0xda) return false;
      if (mk >= 0xd0 && mk <= 0xd7) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (len < 2) return true;
      if (mk === 0xe1) {
        const kop = b.subarray(i + 4, Math.min(b.length, i + 4 + 32)).toString('latin1');
        if (kop.startsWith('Exif\0') || kop.startsWith('http://ns.adobe.com/xap')) return true;
      }
      i += 2 + len;
    }
    return true;
  }
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    let i = 12;
    while (i + 8 <= b.length) {
      const id = b.toString('latin1', i, i + 4), len = b.readUInt32LE(i + 4);
      if (id === 'EXIF' || id === 'XMP ') return true;
      i += 8 + len + (len % 2);
    }
    return false;
  }
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) {
    let i = 8;
    while (i + 8 <= b.length) {
      const len = b.readUInt32BE(i), id = b.toString('latin1', i + 4, i + 8);
      if (id === 'eXIf') return true;
      if ((id === 'iTXt' || id === 'tEXt' || id === 'zTXt') && b.subarray(i + 8, i + 8 + Math.min(len, 64)).toString('latin1').indexOf('XML:com.adobe.xmp') >= 0) return true;
      if (id === 'IEND') return false;
      i += 12 + len;
    }
    return false;
  }
  return true;
}

module.exports = { maak, weiger, heeftMetadata, UUID_RE };
