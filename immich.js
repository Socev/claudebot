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
 *        (&withCoordinates=true, wv2468: ook opnametijd en GPS voor de periode en het kaartpunt van een reis uit je foto's; alleen lezen)
 *   GET  /api/assets/<uuid>/thumbnail?size=thumbnail|preview      miniatuur of voorbeeld (nooit het origineel)
 *   GET  /api/assets/<uuid>/video/playback             wv2938: een video lezen (alleen lezen, rechtstreeks naar een bestand van ≤ 2 GB;
 *                                                       memorylane-video.js maakt er een kleine versie van om af te spelen)
 *   POST /api/albums  {albumName, description}         album aanmaken, LEEG (geen assetIds, geen albumUsers)
 *   PATCH /api/albums/<uuid>  {albumName}              ALLEEN de naam van een album (wv2225; memorylane-fotos.js doet dat alleen bij albums
 *                                                       met zijn eigen code en naamvorm). Geen omschrijving, omslag, volgorde of delen.
 * Studio › Fotoherstel (wv2614, fase 2; ontwerp vault "01_Ontwikkeling/Studio - fotoherstel op Olares (ontwerp 5-11-2026).md" § 6/§ 7; David Ja
 * 7-11-2026 08:00). Het origineel wordt nooit gewijzigd of verwijderd; er komt alleen een NIEUWE foto naast:
 *   GET  /api/albums?assetId=<uuid>                    in welke albums een foto zit (alleen lezen)
 *   GET  /api/assets/<uuid>                            gegevens van één foto (soort, type, grootte, opnamedatum, stapel, eigenaar)
 *   GET  /api/users/me                                 alleen het eigen gebruikers-id (is het origineel van dit account? anders geen stapel)
 *   GET  /api/api-keys/me                              alleen de rechtenlijst van de eigen sleutel (mag hij stapels maken? gemeten 7-11: nog niet)
 *   GET  /api/assets/<uuid>/original                   het origineel (alleen lezen, ≤ 20 MB; Studio toetst het type uit de bytes)
 *   POST /api/assets  (multipart)                      ALLEEN een nieuwe foto: jpg/png/webp ≤ 25 MB, bestandsnaam socev-studio-<taak>.<ext> (als naam van het deel)
 *        (Immich 3.3.5 kent geen deviceAssetId meer: de bestandsnaam is het eigen merk), opnamedatum, en hooguit een XMP-zijbestand
 *        met alleen een beschrijving. Geen zichtbaarheid, favoriet, live-foto of metadata-velden.
 *   POST /api/stacks  {assetIds: [eigen, origineel]}   stapel van precies twee: de eigen nieuwe foto bovenop + het origineel; alleen als de
 *        eigen foto in DEZE sessie door uploaden() nieuw is gemaakt (status created) en GET /api/assets van het origineel geen stack heeft
 *   PUT  /api/albums/<uuid>/assets  {ids: [eigen]}     precies één id, en alleen die eigen nieuwe foto (zelfde regel)
 * Al het andere (DELETE, PUT op een foto, andere PATCH-velden, foto's verplaatsen of uit een album halen, delen, ander pad, andere query, andere
 * body) weigert verzoek() vóór er iets over de lijn gaat. Doorverwijzingen worden niet gevolgd.
 * PRIVACY. Nooit de sleutel, albumnamen of foto-inhoud in logs of fouten; alleen HTTP-status en het soort verzoek.
 * VORM. Alleen ingebouwde modules; sleutel(), fetch en basis komen via maak({...}).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BUCKET_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?)?$/;
const MAX_JSON = 8 * 1024 * 1024, MAX_BEELD = 4 * 1024 * 1024;
// wv2614: origineel lezen ≤ 20 MB (ontwerp § 7); uploaden ≤ 25 MB (Studio-uitvoer is ≤ 10 MB of ≤ 16 MP); XMP-zijbestand ≤ 8 kB
const MAX_ORIGINEEL = 20 * 1024 * 1024, MAX_UPLOAD = 25 * 1024 * 1024, MAX_XMP = 8 * 1024;
const EIGEN_NAAM_RE = /^socev-studio-[a-f0-9]{16}\.(jpg|png|webp)$/;
const DATUM_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const UPLOAD_VELDEN = ['assetData', 'filename', 'fileCreatedAt', 'fileModifiedAt', 'sidecarData'];
function soortUitBytes(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
// XMP-zijbestand met ALLEEN dc:description (geen datum, plek of andere velden); tekst ge-escaped
function xmpBeschrijving(tekst) {
  const t = String(tekst || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return Buffer.from('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">' + t +
    '</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>', 'utf8');
}
const XMP_RE = /^<\?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"\?>\n<x:xmpmeta xmlns:x="adobe:ns:meta\/"><rdf:RDF xmlns:rdf="http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http:\/\/purl\.org\/dc\/elements\/1\.1\/"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">[^<>]{0,1800}<\/rdf:li><\/rdf:Alt><\/dc:description><\/rdf:Description><\/rdf:RDF><\/x:xmpmeta>\n<\?xpacket end="w"\?>$/;
const BEELD_MIME = { 'image/jpeg': true, 'image/webp': true, 'image/png': true };
const MAX_NAAM = 200, MAX_OMSCHRIJVING = 1000, MAX_SPOOR = 3000;
// wv2468: plaatselijke opnamedag uit een UTC-tijd en de afwijking in uren (Immich localOffsetHours); ongeldig = null
function plaatselijkeDag(utc, offset) {
  const t = typeof utc === 'string' ? Date.parse(utc) : NaN;
  if (!Number.isFinite(t)) return null;
  const o = Number.isFinite(offset) && Math.abs(offset) <= 14 ? offset : 0;
  const d = new Date(t + o * 3600000).toISOString().slice(0, 10);
  return /^(19|20)\d{2}-\d{2}-\d{2}$/.test(d) ? d : null;
}
// wv2943: de plaatselijke opnametijd tot op de seconde ('JJJJ-MM-DDTUU:MM:SS', zonder zone) — de stabiele verwijzing van Vertel erbij
function plaatselijkeTijd(utc, offset) {
  const t = typeof utc === 'string' ? Date.parse(utc) : NaN;
  if (!Number.isFinite(t)) return null;
  const o = Number.isFinite(offset) && Math.abs(offset) <= 14 ? offset : 0;
  const d = new Date(t + o * 3600000).toISOString().slice(0, 19);
  return /^(19|20)\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(d) ? d : null;
}
// wv2943: alleen een gewone plaatsnaam (letters, spaties, koppeltekens, apostrof, punt), hooguit 60 tekens; anders null
function plaatsNaam(x) {
  if (typeof x !== 'string') return null;
  const s = x.normalize('NFC').replace(/\s+/g, ' ').trim();
  return s && s.length <= 60 && /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u.test(s) ? s : null;
}
// wv2943: Immich-duur 'U:MM:SS.ffffff' → seconden (afgerond, 0–86400); anders null
function duurSec(x) {
  const m = typeof x === 'string' ? /^(\d{1,3}):([0-5]\d):([0-5]\d)(\.\d+)?$/.exec(x) : null;
  if (!m) return null;
  const s = Math.round(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4] || 0));
  return s > 0 && s <= 86400 ? s : null;
}
function geldigGetal(x, grens) { return typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= grens ? x : null; }

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
    if (pad === '/api/albums') return !sleutels.length || (sleutels.length === 1 && u(q.assetId)) ? null : 'query';   // wv2614: ?assetId= (lezen)
    if (pad === '/api/users/me') return sleutels.length ? 'query' : null;                                                // wv2614: eigen id
    if (pad === '/api/api-keys/me') return sleutels.length ? 'query' : null;                                             // wv2614: eigen rechten
    if ((m = /^\/api\/assets\/([0-9a-f-]{36})$/.exec(pad)) && u(m[1])) return sleutels.length ? 'query' : null;            // wv2614: gegevens
    if ((m = /^\/api\/assets\/([0-9a-f-]{36})\/original$/.exec(pad)) && u(m[1])) return sleutels.length ? 'query' : null;   // wv2614: origineel lezen
    if ((m = /^\/api\/albums\/([0-9a-f-]{36})$/.exec(pad)) && u(m[1])) return sleutels.length ? 'query' : null;
    if (pad === '/api/timeline/buckets') return alleen(['albumId', 'order']) && u(q.albumId) && (q.order === undefined || q.order === 'asc' || q.order === 'desc') ? null : 'query';
    if (pad === '/api/timeline/bucket') return alleen(['albumId', 'timeBucket', 'order', 'withCoordinates']) && u(q.albumId) && typeof q.timeBucket === 'string' && BUCKET_RE.test(q.timeBucket)
      && (q.order === undefined || q.order === 'asc' || q.order === 'desc') && (q.withCoordinates === undefined || q.withCoordinates === 'true') ? null : 'query';
    if ((m = /^\/api\/assets\/([0-9a-f-]{36})\/thumbnail$/.exec(pad)) && u(m[1])) return alleen(['size']) && (q.size === 'thumbnail' || q.size === 'preview') ? null : 'query';
    if ((m = /^\/api\/assets\/([0-9a-f-]{36})\/video\/playback$/.exec(pad)) && u(m[1])) return sleutels.length ? 'query' : null;   // wv2938: video lezen (naar bestand)
    return 'pad';
  }
  if (methode === 'POST' && pad === '/api/assets') {
    // wv2614: alleen een nieuwe foto in Socevs eigen vorm (zie kop); multipart wordt pas in verzoek() gebouwd
    if (sleutels.length) return 'query';
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body';
    const bk = Object.keys(body);
    if (!bk.every(function (k) { return UPLOAD_VELDEN.indexOf(k) >= 0; })) return 'body';   // nooit visibility, isFavorite, livePhotoVideoId, metadata
    if (!Buffer.isBuffer(body.assetData) || !body.assetData.length || body.assetData.length > MAX_UPLOAD) return 'body';
    const ext = typeof body.filename === 'string' && EIGEN_NAAM_RE.exec(body.filename);
    if (!ext || soortUitBytes(body.assetData) !== ext[1]) return 'body';
    if (typeof body.fileCreatedAt !== 'string' || !DATUM_RE.test(body.fileCreatedAt) || !Number.isFinite(Date.parse(body.fileCreatedAt))) return 'body';
    if (typeof body.fileModifiedAt !== 'string' || !DATUM_RE.test(body.fileModifiedAt) || !Number.isFinite(Date.parse(body.fileModifiedAt))) return 'body';
    if (body.sidecarData !== undefined && (!Buffer.isBuffer(body.sidecarData) || body.sidecarData.length > MAX_XMP || !XMP_RE.test(body.sidecarData.toString('utf8')))) return 'body';
    return null;
  }
  if (methode === 'POST' && pad === '/api/stacks') {
    // wv2614: precies twee verschillende foto's; dat de eerste Socevs eigen nieuwe foto is, toetst verzoek() (eigen-lijst van deze sessie)
    if (sleutels.length) return 'query';
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body';
    const bk = Object.keys(body);
    if (bk.length !== 1 || bk[0] !== 'assetIds' || !Array.isArray(body.assetIds) || body.assetIds.length !== 2) return 'body';
    if (!u(body.assetIds[0]) || !u(body.assetIds[1]) || body.assetIds[0] === body.assetIds[1]) return 'body';
    return null;
  }
  if (methode === 'PUT') {
    // wv2614: alleen één eigen nieuwe foto aan een album toevoegen (eigen-lijst: verzoek()); nooit PUT op een foto of iets anders
    if (!(m = /^\/api\/albums\/([0-9a-f-]{36})\/assets$/.exec(pad)) || !u(m[1])) return 'pad';
    if (sleutels.length) return 'query';
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body';
    const bk = Object.keys(body);
    if (bk.length !== 1 || bk[0] !== 'ids' || !Array.isArray(body.ids) || body.ids.length !== 1 || !u(body.ids[0])) return 'body';
    return null;
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
  // wv2614: foto's die DEZE client zelf nieuw maakte (uploaden → status created). Alleen die mogen in een stapel (bovenop) of een album.
  // Bewust alleen in het geheugen: na een herstart kan Socev een eerdere upload niet meer stapelen (liever niets dan een vreemde foto).
  const eigen = new Set();
  function nietEigen(methode, pad, body) {
    if (methode === 'POST' && pad === '/api/stacks') return !eigen.has(body.assetIds[0]) || eigen.has(body.assetIds[1]);   // origineel ≠ eigen upload
    if (methode === 'PUT') return !eigen.has(body.ids[0]);
    return false;
  }

  async function verzoek(methode, pad, query, body, soort) {
    const r = weiger(methode, pad, query, body) || (nietEigen(methode, pad, body) ? 'niet de eigen nieuwe foto' : null);
    if (r) { const e = new Error('immich: niet toegestaan (' + r + ')'); e.code = 'WITTE_LIJST'; throw e; }
    const k = await o.sleutel();
    if (!k) { const e = new Error('immich: geen sleutel'); e.code = 'GEEN_SLEUTEL'; throw e; }
    const qs = query && Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : '';
    const koppen = { 'x-api-key': k, Accept: soort === 'beeld' ? 'image/webp,image/jpeg,image/png' : soort === 'origineel' ? '*/*' : 'application/json', 'User-Agent': 'socev-memorylane/1' };
    let lijf;
    if (methode === 'POST' && pad === '/api/assets') {
      // multipart: fetch zet zelf Content-Type met boundary
      const ext = EIGEN_NAAM_RE.exec(body.filename)[1], mime = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext];
      lijf = new FormData();
      // de eigen naam gaat als bestandsnaam van het deel mee (wordt originalFileName), NIET als formulierveld filename: Immich 3.3.5 toetst
      // dan ook het zijbestand op die naam ("Unsupported file type ….jpg", gemeten 7-11-2026)
      lijf.append('assetData', new Blob([body.assetData], { type: mime }), body.filename);
      lijf.append('fileCreatedAt', body.fileCreatedAt);
      lijf.append('fileModifiedAt', body.fileModifiedAt);
      if (body.sidecarData) lijf.append('sidecarData', new Blob([body.sidecarData], { type: 'application/xml' }), body.filename.replace(/\.[a-z]+$/, '.xmp'));
    } else if (body !== undefined) { koppen['Content-Type'] = 'application/json'; lijf = JSON.stringify(body); }
    let res;
    try {
      res = await doeFetch(basis + pad + qs, { method: methode, headers: koppen, body: lijf, redirect: 'manual', signal: AbortSignal.timeout(soort === 'origineel' || lijf instanceof FormData ? Math.max(ms, 120000) : ms) });
    } catch (e) { const f = new Error('immich: niet bereikbaar'); f.code = 'NET'; throw f; }
    if (res.status < 200 || res.status >= 300) {
      try { await res.arrayBuffer(); } catch (e) { /* weg */ }
      const f = new Error('immich: HTTP ' + res.status); f.code = 'HTTP'; f.status = res.status; throw f;
    }
    const ct = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const max = soort === 'beeld' ? MAX_BEELD : soort === 'origineel' ? MAX_ORIGINEEL : MAX_JSON;
    const lengte = Number(res.headers.get('content-length') || 0);
    if (lengte > max) { const f = new Error('immich: antwoord te groot'); f.code = 'GROOT'; throw f; }
    const buf = await leesBegrensd(res, max);   // review ZOU 1: harde grens tijdens het lezen, niet pas erna
    if (soort === 'beeld') {
      if (!BEELD_MIME[ct]) { const f = new Error('immich: geen beeld'); f.code = 'SOORT'; throw f; }
      return { mime: ct, data: buf };
    }
    // wv2614: het origineel komt als octet-stream of met het eigen type; de soort komt uit de bytes (jpg/png/webp), anders geweigerd
    if (soort === 'origineel') {
      const sb = soortUitBytes(buf);
      if (!sb) { const f = new Error('immich: origineel is geen jpg, png of webp'); f.code = 'SOORT'; throw f; }
      return { soort: sb, data: buf };
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
  // Foto-ids van een album, oudste eerst, hooguit max; zonder prullenbak. → [{ id, beeld (false = video), ratio, dag, plaats, duur, fav }]
  // wv2943 (diashow stap 1): per foto ook de plaatselijke opnamedag (JJJJ-MM-DD), de plaatsnaam (city, geen coördinaten), de duur van een
  // video in seconden en of hij in Immich favoriet is; de lijst draagt .totaal = het aantal in het hele album (som van de bakken, ook boven max).
  async function albumFotos(id, max) {
    if (!u(id)) throw new Error('immich: ongeldig album');
    const grens = Math.max(1, Math.min(1000, max || 200));   // wv2943: 500 → 1000
    const bakken = await verzoek('GET', '/api/timeline/buckets', { albumId: id, order: 'asc' });
    const uit = [];
    let totaal = 0;
    for (const b of Array.isArray(bakken) ? bakken : []) if (b && Number.isInteger(b.count) && b.count > 0) totaal += b.count;
    for (const b of Array.isArray(bakken) ? bakken : []) {
      if (uit.length >= grens) break;
      const tb = b && typeof b.timeBucket === 'string' ? b.timeBucket : null;
      if (!tb || !BUCKET_RE.test(tb)) continue;
      const r = await verzoek('GET', '/api/timeline/bucket', { albumId: id, timeBucket: tb, order: 'asc' });
      const ids = r && Array.isArray(r.id) ? r.id : [];
      const kol = (k) => (r && Array.isArray(r[k]) ? r[k] : []);
      const fc = kol('fileCreatedAt'), off = kol('localOffsetHours'), stad = kol('city'), duur = kol('duration'), fav = kol('isFavorite');
      for (let i = 0; i < ids.length && uit.length < grens; i++) {
        if (!u(ids[i])) continue;
        if (Array.isArray(r.isTrashed) && r.isTrashed[i] === true) continue;
        const beeld = !(Array.isArray(r.isImage) && r.isImage[i] === false);
        uit.push({ id: ids[i], beeld, ratio: Array.isArray(r.ratio) && Number.isFinite(r.ratio[i]) ? Math.round(r.ratio[i] * 1000) / 1000 : null,
          dag: plaatselijkeDag(fc[i], off[i]), tijd: plaatselijkeTijd(fc[i], off[i]), plaats: plaatsNaam(stad[i]), duur: beeld ? null : duurSec(duur[i]), fav: fav[i] === true });
      }
    }
    Object.defineProperty(uit, 'totaal', { value: Math.max(totaal, uit.length), enumerable: false });
    return uit;
  }
  // wv2468 (Tripper): wanneer en waar de foto's van een album gemaakt zijn, voor de periode en het kaartpunt van een reis uit je foto's.
  // → [{ dag: 'JJJJ-MM-DD' (plaatselijke opnamedag: fileCreatedAt + localOffsetHours), lat, lon (null zonder GPS) }], hooguit max, zonder
  // prullenbak. GEEN ids, namen, steden of landen: alleen wat memorylane-fotos.js nodig heeft om één afgerond punt te rekenen.
  // Video's tellen bewust mee (review wv2468 MOET 1 niet overgenomen): een video van de reis zegt net zo goed wanneer en waar; een verkeerde
  // klok of plek vangt de 80 %-regel en de mediaan op, net als bij een foto.
  async function albumSpoor(id, max) {
    if (!u(id)) throw new Error('immich: ongeldig album');
    const grens = Math.max(1, Math.min(MAX_SPOOR, max || MAX_SPOOR));
    const bakken = await verzoek('GET', '/api/timeline/buckets', { albumId: id, order: 'asc' });
    const uit = [];
    for (const b of Array.isArray(bakken) ? bakken : []) {
      if (uit.length >= grens) break;
      const tb = b && typeof b.timeBucket === 'string' ? b.timeBucket : null;
      if (!tb || !BUCKET_RE.test(tb)) continue;
      const r = await verzoek('GET', '/api/timeline/bucket', { albumId: id, timeBucket: tb, order: 'asc', withCoordinates: 'true' });
      const n = r && Array.isArray(r.id) ? r.id.length : 0;
      const kol = (k) => (r && Array.isArray(r[k]) ? r[k] : []);
      const fc = kol('fileCreatedAt'), off = kol('localOffsetHours'), la = kol('latitude'), lo = kol('longitude'), tr = kol('isTrashed');
      for (let i = 0; i < n && uit.length < grens; i++) {
        if (tr[i] === true) continue;
        uit.push({ dag: plaatselijkeDag(fc[i], off[i]), lat: geldigGetal(la[i], 90), lon: geldigGetal(lo[i], 180) });
      }
    }
    return uit;
  }
  // maat 'klein' = thumbnail (± 250 px), 'groot' = preview (± 1440 px). Nooit het origineel.
  async function beeld(assetId, maat) {
    if (!u(assetId)) throw new Error('immich: ongeldige foto');
    return verzoek('GET', '/api/assets/' + assetId + '/thumbnail', { size: maat === 'groot' ? 'preview' : 'thumbnail' }, undefined, 'beeld');
  }
  // ── Studio › Fotoherstel (wv2614) ──
  // Gegevens van één foto, alleen wat Studio nodig heeft; null als hij er niet (meer) is.
  async function fotoInfo(id) {
    if (!u(id)) throw new Error('immich: ongeldige foto');
    let a;
    try { a = await verzoek('GET', '/api/assets/' + id); }
    catch (e) { if (e.code === 'HTTP' && (e.status === 404 || e.status === 400)) return null; throw e; }
    if (!a || a.id !== id) return null;
    const ex = a.exifInfo && typeof a.exifInfo === 'object' ? a.exifInfo : {};
    return { id: a.id, beeld: a.type === 'IMAGE', mime: typeof a.originalMimeType === 'string' ? a.originalMimeType.toLowerCase() : null,
      grootte: Number.isFinite(ex.fileSizeInByte) ? ex.fileSizeInByte : null, opname: typeof a.fileCreatedAt === 'string' && DATUM_RE.test(a.fileCreatedAt) ? a.fileCreatedAt : null,
      stapel: !!(a.stack && typeof a.stack === 'object' && a.stack.id), eigenaar: u(a.ownerId) ? a.ownerId : null, prullenbak: a.isTrashed === true,
      naam: typeof a.originalFileName === 'string' ? a.originalFileName : '', beschrijving: typeof ex.description === 'string' ? ex.description : '' };
  }
  let mijn = null;
  async function mijnId() { if (mijn) return mijn; const r = await verzoek('GET', '/api/users/me'); mijn = r && u(r.id) ? r.id : null; return mijn; }   // alleen het id
  // Mag de sleutel stapels maken (recht stack.create of all)? 5 min onthouden; David kan het recht in Immich bijzetten.
  let recht = null;
  async function magStapelen() {
    if (recht && Date.now() < recht.tot) return recht.ja;
    const r = await verzoek('GET', '/api/api-keys/me');
    const p = r && Array.isArray(r.permissions) ? r.permissions : [];
    recht = { ja: p.indexOf('all') >= 0 || p.indexOf('stack.create') >= 0, tot: Date.now() + 5 * 60 * 1000 };
    return recht.ja;
  }
  async function origineel(id) { if (!u(id)) throw new Error('immich: ongeldige foto'); return verzoek('GET', '/api/assets/' + id + '/original', undefined, undefined, 'origineel'); }
  async function albumsVan(id) { if (!u(id)) throw new Error('immich: ongeldige foto'); const r = await verzoek('GET', '/api/albums', { assetId: id }); return Array.isArray(r) ? r.map(albumKort).filter(Boolean) : []; }
  // Nieuwe foto. o = { data: Buffer, taak: 16 hex, opname: ISO, beschrijving? } → { id, nieuw } (nieuw = false: Immich kende dezelfde bytes al)
  async function uploaden(x) {
    const ext = soortUitBytes(x && x.data);
    if (!ext || !/^[a-f0-9]{16}$/.test(String(x.taak || ''))) throw new Error('immich: ongeldige upload');
    const body = { assetData: x.data, filename: 'socev-studio-' + x.taak + '.' + ext, fileCreatedAt: x.opname, fileModifiedAt: x.opname };
    if (x.beschrijving) body.sidecarData = xmpBeschrijving(x.beschrijving);
    const r = await verzoek('POST', '/api/assets', undefined, body);
    if (!r || !u(r.id) || (r.status !== 'created' && r.status !== 'duplicate')) throw new Error('immich: onverwacht antwoord');
    if (r.status === 'created') eigen.add(r.id);
    return { id: r.id, nieuw: r.status === 'created' };
  }
  // Stapel: eigen nieuwe foto bovenop, origineel eronder; alleen als het origineel nog geen stapel heeft (vlak ervoor gemeten). → { gestapeld, reden }
  async function stapelen(eigenId, origId) {
    if (!eigen.has(eigenId)) return { gestapeld: false, reden: 'niet de eigen nieuwe foto' };
    const oi = await fotoInfo(origId);
    if (!oi) return { gestapeld: false, reden: 'origineel niet gevonden' };
    if (oi.stapel) return { gestapeld: false, reden: 'origineel zit al in een stapel' };
    const ei = await fotoInfo(eigenId);
    if (!ei || !oi.eigenaar || ei.eigenaar !== oi.eigenaar) return { gestapeld: false, reden: 'origineel is van een ander account' };
    const r = await verzoek('POST', '/api/stacks', undefined, { assetIds: [eigenId, origId] });
    if (!r || !u(r.id) || r.primaryAssetId !== eigenId) return { gestapeld: false, reden: 'onverwacht antwoord' };
    return { gestapeld: true };
  }
  async function inAlbum(albumId, eigenId) {
    if (!u(albumId)) throw new Error('immich: ongeldig album');
    const r = await verzoek('PUT', '/api/albums/' + albumId + '/assets', undefined, { ids: [eigenId] });
    const x = Array.isArray(r) ? r.find(function (y) { return y && y.id === eigenId; }) : null;
    return !!(x && (x.success === true || x.error === 'duplicate'));
  }
  // wv2938: een video naar een NIEUW bestand (wx, 0600), gestreamd met een harde grens; → { bytes, mime }. Bij een fout of te groot is het
  // bestand weer weg. Zelfde witte lijst en sleutel als verzoek(); doorverwijzingen worden niet gevolgd.
  async function videoNaarBestand(id, pad, max, timeoutMs) {
    if (!u(id)) throw new Error('immich: ongeldige video');
    const p = '/api/assets/' + id + '/video/playback';
    const r = weiger('GET', p, {}, undefined);
    if (r) { const e = new Error('immich: niet toegestaan (' + r + ')'); e.code = 'WITTE_LIJST'; throw e; }
    const k = await o.sleutel();
    if (!k) { const e = new Error('immich: geen sleutel'); e.code = 'GEEN_SLEUTEL'; throw e; }
    const fs = require('fs');
    let res;
    try { res = await doeFetch(basis + p, { method: 'GET', headers: { 'x-api-key': k, Accept: 'video/*', 'User-Agent': 'socev-memorylane/1' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs || 600000) }); }
    catch (e) { const f = new Error('immich: niet bereikbaar'); f.code = 'NET'; throw f; }
    // review bouw ronde 2 MOET 2: een afgewezen antwoord niet inlezen (geen grens), maar afbreken
    const breekAf = async function () { try { if (res.body) await res.body.cancel(); } catch (e) { /* weg */ } };
    if (res.status !== 200) { await breekAf(); const f = new Error('immich: HTTP ' + res.status); f.code = 'HTTP'; f.status = res.status; throw f; }
    const ct = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^video\/[a-z0-9.+-]+$/.test(ct) && ct !== 'application/octet-stream') { await breekAf(); const f = new Error('immich: geen video'); f.code = 'SOORT'; throw f; }
    if (Number(res.headers.get('content-length') || 0) > max) { await breekAf(); const f = new Error('immich: video te groot'); f.code = 'GROOT'; throw f; }
    let fd;
    try { fd = fs.openSync(pad, 'wx', 0o600); } catch (e) { await breekAf(); throw e; }   // review ronde 3 ZOU 2
    let n = 0, ok = false;
    const lezer = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await lezer.read();
        if (done) break;
        n += value.length;
        if (n > max) { try { await lezer.cancel(); } catch (e) { /* weg */ } const f = new Error('immich: video te groot'); f.code = 'GROOT'; throw f; }
        let w = 0; while (w < value.length) w += fs.writeSync(fd, value, w, value.length - w);
      }
      ok = true;
    } finally {
      fs.closeSync(fd);
      if (!ok) { try { await lezer.cancel(); } catch (e) { /* al dicht */ } try { fs.unlinkSync(pad); } catch (e) { /* weg */ } }
    }
    return { bytes: n, mime: ct };
  }
  return { albums, album, maakAlbum, hernoemAlbum, albumFotos, albumSpoor, beeld, verzoek, basis, fotoInfo, origineel, albumsVan, uploaden, stapelen, inAlbum, mijnId, magStapelen, videoNaarBestand };
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

module.exports = { maak, weiger, heeftMetadata, plaatselijkeDag, UUID_RE, soortUitBytes, xmpBeschrijving };
