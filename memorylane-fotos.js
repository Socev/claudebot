'use strict';
/*
 * MemoryLane × Immich (wv2120, 31-10-2026; David JA 20:15, vraag-id 7e507ded). Ontwerp: vault "01_Ontwikkeling/Second Brain 2.0 - fase R
 * rambles en herinneringen (ontwerp 29-10-2026).md" § 15. Wordt alleen vanuit memorylane-delen.js gebruikt (die kent de herinneringen).
 *
 * WAAROM. Google Photos is een grote berg; David zet per reis of herinnering een selectie in een Immich-album, en MemoryLane laat die foto's
 * zien (later ook als gevel van het huis in de straat, § 12). Socev maakt de albums; David vult ze.
 *
 * VORM.
 *  - Koppeltabel ml_album in intake.sqlite: hid ↔ album_id, plus aantal, omslag, gevel, foto_delen. GEEN namen, titels of foto's (die databank
 *    gaat elke nacht in de podstaat-bundel; zelfde regel als ml_herinnering).
 *  - Herkenning (idempotent): elk album dat Socev maakt draagt in zijn omschrijving de code memorylane:<16 hex> = sha256(soort|ref). Die is
 *    stabiel (ook als intake.sqlite ooit leeg terugkomt); een album met die code wordt overgenomen in plaats van een tweede gemaakt. Albums
 *    zonder code (Davids eigen) raakt Socev nooit; geen album wordt verwijderd en aan de foto's komt Socev niet (immich.js kan dat niet eens).
 *  - Naam (wv2225, David 1-11-2026 22:43: "MemoryLane: …" vooraan maakte het mappenoverzicht in Immich onwerkbaar): "<jaar> <titel> (ML)".
 *    Jaar = het (begin)jaar waar de herinnering over gaat (Davids 'wanneer', de reisperiode of het verhaal); onbekend = "(zonder jaar)" (de
 *    opnamedatum is wanneer hij het vertelde, niet waar het over gaat; zet David een jaar, dan volgt het album). Begint de titel al met dat
 *    jaar, dan niet nog eens; staat het jaar los achteraan ("Gambia 2023", "… - 2023"), dan schuift het naar voren. Verder blijft de titel
 *    zoals hij is. Hernoemen (PATCH, alleen albumName) doet sync alleen bij een album uit ml_album waarvan de code klopt én waarvan de naam
 *    nog Socevs vorm heeft: de oude vorm "MemoryLane – …" of eindigend op " (ML)". Haalt David "(ML)" weg, dan blijft Socev van de naam af.
 *  - Automatisch een album: elke actieve reis, en elke andere herinnering zodra die een categorie heeft (een opname zonder categorie kan nog
 *    een proef zijn; daarvoor staat in de app een knop "Album maken"). Verwijdert David een album in Immich, dan maakt Socev het niet
 *    vanzelf opnieuw (status weg; de knop kan het wel).
 *  - Foto's in de app: via de pod, alleen ids uit een gekoppeld album (anders 404), als JSON {mime, data} (het doorgeefluik geeft alleen JSON
 *    door); no-store, niets op het toestel.
 *  - Delen (wv2114-links): foto's alleen als David foto_delen per herinnering aanzet (standaard uit) én de herinnering voor die kring
 *    zichtbaar is. Dan gaan hooguit 8 miniaturen (± 250 px) naar D1 ml_foto; een miniatuur met Exif/XMP (plek, toestel) gaat niet mee.
 * PRIVACY. Nooit albumnamen, titels of beelden in logs, box of /health: alleen aantallen.
 */
const crypto = require('crypto');
const IM = require('./immich.js');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ml_album (hid TEXT PRIMARY KEY, sleutel TEXT NOT NULL, album_id TEXT UNIQUE, status TEXT NOT NULL, aantal INTEGER NOT NULL DEFAULT 0,
  omslag TEXT, gevel TEXT, foto_delen INTEGER NOT NULL DEFAULT 0, deel_fotos TEXT, gemaakt_op TEXT NOT NULL, gezien_op TEXT);
`;
const SYNC_ELKE_MS = 10 * 60000, RUST_NA_FOUT_MS = 5 * 60000, FOTO_CACHE_MS = 10 * 60000, TOEGANG_VERS_MS = 2 * 60000;
const MAX_NIEUW_PER_RONDE = 30, MAX_DEEL = 8, MAX_DEEL_BYTES = 300 * 1024, MAX_FOTOS = 300;
const VOORVOEGSEL = 'MemoryLane – ';   // oude vorm (wv2120): alleen nog om Socevs eigen oude namen te herkennen
const MERK = ' (ML)', ZONDER_JAAR = '(zonder jaar)', MAX_NAAM = 200, MAX_HERNOEM_PER_RONDE = 30;
const CODE_RE = /memorylane:([0-9a-f]{16})/;

function code(soort, ref) { return crypto.createHash('sha256').update(String(soort) + '|' + String(ref)).digest('hex').slice(0, 16); }
// wv2225: "<jaar> <titel> (ML)"; jaar = "JJJJ" of leeg/null (→ "(zonder jaar)")
function albumNaam(titel, jaar) {
  let t = String(titel || 'Herinnering').replace(/\s+/g, ' ').trim();
  if (t.startsWith(VOORVOEGSEL.trim())) t = t.slice(VOORVOEGSEL.trim().length).trim();
  while (t.endsWith(MERK.trim())) t = t.slice(0, -MERK.trim().length).trim();
  if (!t) t = 'Herinnering';
  const j = /^\d{4}$/.test(String(jaar || '')) && Number(jaar) >= 1900 && Number(jaar) <= 2100 ? String(jaar) : null;
  let kop;
  if (j && new RegExp('^' + j + '(?!\\d)').test(t)) kop = '';
  else if (j) { const z = t.replace(new RegExp('\\s*(?:[-–—,]\\s*)?(?<!\\d)' + j + '$'), '').trim(); if (z) t = z; kop = j + ' '; }
  else kop = ZONDER_JAAR + ' ';   // review MOET 1: zonder bekend jaar altijd zichtbaar, ook als de titel met cijfers begint
  const ruimte = MAX_NAAM - kop.length - MERK.length;
  return kop + (t.length > ruimte ? t.slice(0, ruimte).trim() : t) + MERK;
}
// Is dit (nog) een naam in Socevs vorm? Alleen dan mag sync hem bijwerken.
function socevsNaam(naam) { const n = String(naam || ''); return n.startsWith(VOORVOEGSEL) || n.endsWith(MERK); }
function omschrijving(c) {
  return "Album voor MemoryLane, gemaakt door Socev. Zet hier de foto's van deze herinnering in; MemoryLane laat ze zien. " +
    'Laat de code hieronder staan, dan blijft MemoryLane dit album herkennen.\n\nmemorylane:' + c;
}

/*
 * maak(o) → { sync, kort, fotos, foto, gevel, fotoDelen, albumMaken, voorDelen, naarD1, info, _db }
 * o = { db, immich (immich.js-client), nu() → ms, fout(label, e) }
 */
function maak(o) {
  const db = o.db, im = o.immich, nu = typeof o.nu === 'function' ? o.nu : Date.now;
  const fout = (l, e) => { if (o.fout) o.fout(l, e); };
  db.exec(SCHEMA_SQL);
  const q = {
    a: db.prepare('SELECT * FROM ml_album WHERE hid = ?'),
    alle: db.prepare('SELECT * FROM ml_album'),
    nieuw: db.prepare('INSERT INTO ml_album (hid, sleutel, album_id, status, aantal, omslag, gemaakt_op, gezien_op) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (hid) DO UPDATE SET sleutel = excluded.sleutel, album_id = excluded.album_id, status = excluded.status, aantal = excluded.aantal, omslag = excluded.omslag, ' +
      'gevel = NULL, deel_fotos = NULL, gezien_op = excluded.gezien_op'),
    stand: db.prepare('UPDATE ml_album SET status = ?, aantal = ?, omslag = ?, gezien_op = ? WHERE hid = ?'),
    weg: db.prepare("UPDATE ml_album SET status = 'weg', deel_fotos = NULL WHERE hid = ?"),
    gevel: db.prepare('UPDATE ml_album SET gevel = ? WHERE hid = ?'),
    delen: db.prepare('UPDATE ml_album SET foto_delen = ? WHERE hid = ?'),
    deelFotos: db.prepare('UPDATE ml_album SET deel_fotos = ? WHERE hid = ?'),
    aantal: db.prepare('UPDATE ml_album SET aantal = ? WHERE hid = ?'),
    tel: db.prepare('SELECT status, count(*) n FROM ml_album GROUP BY status'),
  };
  let laatsteSync = 0, laatsteFout = 0, stand = { sleutel: null, fout: null, op: null, nieuw: 0, overgenomen: 0, weg: 0 };
  const cache = new Map();   // hid → { op, fotos: [{id, beeld, ratio}] }; alleen in het geheugen

  function url(albumId) { return im.basis + '/albums/' + albumId; }
  function fotoStand(e) { return e && e.code === 'GEEN_SLEUTEL' ? 'geen sleutel' : 'Immich niet bereikbaar'; }
  function rust() { return laatsteFout && nu() - laatsteFout < RUST_NA_FOUT_MS; }

  // kandidaten: [{ hid, soort, ref, titel, jaar, auto }] uit memorylane-delen (actieve herinneringen; auto = vanzelf een album)
  async function sync(kandidaten, dwing) {
    if (!dwing && nu() - laatsteSync < SYNC_ELKE_MS) return null;
    laatsteSync = nu();
    const t = new Date(nu()).toISOString();
    let lijst;
    try { lijst = await im.albums(); }
    catch (e) { laatsteFout = nu(); stand = Object.assign({}, stand, { sleutel: e.code === 'GEEN_SLEUTEL' ? false : stand.sleutel, fout: fotoStand(e), op: t }); if (e.code !== 'GEEN_SLEUTEL') fout('ml-immich', e); return stand; }
    laatsteFout = 0;
    const opId = new Map(lijst.map((a) => [a.id, a]));
    const opCode = new Map();
    for (const a of lijst) { const m = CODE_RE.exec(a.omschrijving || ''); if (m && !opCode.has(m[1])) opCode.set(m[1], a); }
    const r = { nieuw: 0, overgenomen: 0, weg: 0, hernoemd: 0, eigen_naam: 0 };
    for (const rij of q.alle.all()) {
      const a = rij.album_id ? opId.get(rij.album_id) : null;
      if (a) { q.stand.run('actief', a.aantal, a.omslag, t, rij.hid); continue; }
      const terug = opCode.get(rij.sleutel);
      if (terug) { q.nieuw.run(rij.hid, rij.sleutel, terug.id, 'actief', terug.aantal, terug.omslag, rij.gemaakt_op, t); r.overgenomen++; continue; }
      if (rij.status !== 'weg') { q.weg.run(rij.hid); cache.delete(rij.hid); r.weg++; }
    }
    let gemaakt = 0;
    for (const k of kandidaten || []) {
      if (!k.auto || q.a.get(k.hid)) continue;
      const c = code(k.soort, k.ref), a = opCode.get(c);
      if (a) { q.nieuw.run(k.hid, c, a.id, 'actief', a.aantal, a.omslag, t, t); r.overgenomen++; continue; }
      if (gemaakt >= MAX_NIEUW_PER_RONDE) continue;   // de rest de volgende ronde
      try {
        const n = await im.maakAlbum(albumNaam(k.titel, k.jaar), omschrijving(c));
        q.nieuw.run(k.hid, c, n.id, 'actief', 0, null, t, t); gemaakt++; r.nieuw++;
        opCode.set(c, n);
      } catch (e) { laatsteFout = nu(); fout('ml-immich-maak', e); break; }
    }
    // wv2225: naam bijwerken (ook direct na overnemen), alleen bij een album uit Immich met onze code dat nog Socevs naamvorm heeft
    const opHid = new Map((kandidaten || []).map((k) => [k.hid, k]));
    for (const rij of q.alle.all()) {
      const a = rij.status === 'actief' && rij.album_id ? opId.get(rij.album_id) : null, k = a && opHid.get(rij.hid);
      const m = a && CODE_RE.exec(a.omschrijving || '');
      if (!k || !m || m[1] !== rij.sleutel) continue;
      const gewenst = albumNaam(k.titel, k.jaar);
      if (a.naam === gewenst) continue;
      if (!socevsNaam(a.naam)) { r.eigen_naam++; continue; }
      if (r.hernoemd >= MAX_HERNOEM_PER_RONDE || typeof im.hernoemAlbum !== 'function') continue;   // de rest de volgende ronde
      try { await im.hernoemAlbum(a.id, gewenst); a.naam = gewenst; r.hernoemd++; }
      catch (e) { laatsteFout = nu(); fout('ml-immich-naam', e); break; }
    }
    // foto's voor de deellinks bijhouden (alleen waar David dat aanzette); vers uit Immich, zodat een foto die David uit het album haalt
    // binnen één ronde ook van de link verdwijnt (review MOET 1: de wijziging telt mee, memorylane-delen publiceert dan opnieuw)
    r.deel = 0;
    for (const rij of q.alle.all()) {
      if (rij.status !== 'actief' || !rij.foto_delen) continue;
      try { if (await zetDeelFotos(rij.hid, true)) r.deel++; } catch (e) { laatsteFout = nu(); fout('ml-immich-deel', e); break; }
    }
    stand = { sleutel: true, fout: null, op: t, albums: lijst.length, ...r };
    return stand;
  }
  async function albumMaken(k) {
    const rij = q.a.get(k.hid);
    if (rij && rij.status === 'actief') return { status: 409, body: { ok: false, fout: 'er is al een album' } };
    const c = code(k.soort, k.ref), t = new Date(nu()).toISOString();
    let n;
    try {
      const bestaand = (await im.albums()).find((a) => (CODE_RE.exec(a.omschrijving || '') || [])[1] === c);
      n = bestaand || await im.maakAlbum(albumNaam(k.titel, k.jaar), omschrijving(c));
    } catch (e) { fout('ml-immich-maak', e); return { status: 503, body: { ok: false, fout: e.code === 'GEEN_SLEUTEL' ? 'nog geen Immich-sleutel' : 'Immich was niet bereikbaar; probeer het zo opnieuw' } }; }
    q.nieuw.run(k.hid, c, n.id, 'actief', n.aantal || 0, n.omslag || null, rij ? rij.gemaakt_op : t, t);
    cache.delete(k.hid);
    return { status: 200, body: { ok: true, album: kort(k.hid) } };
  }

  async function lijstVan(hid, vers) {
    const rij = q.a.get(hid);
    if (!rij || rij.status !== 'actief') return null;
    const c = cache.get(hid);
    if (!vers && c && nu() - c.op < FOTO_CACHE_MS) return c.fotos;
    const fotos = await im.albumFotos(rij.album_id, MAX_FOTOS);
    cache.set(hid, { op: nu(), fotos });
    if (fotos.length !== rij.aantal) q.aantal.run(fotos.length, hid);
    return fotos;
  }
  function gevelVan(rij, fotos) {
    const ids = new Set((fotos || []).map((f) => f.id));
    if (rij.gevel && (!fotos || ids.has(rij.gevel))) return rij.gevel;
    if (rij.omslag && (!fotos || ids.has(rij.omslag))) return rij.omslag;
    return fotos && fotos.length ? fotos[0].id : null;
  }
  function kort(hid) {
    const rij = q.a.get(hid);
    if (!rij) return null;
    const c = cache.get(hid);
    return { status: rij.status, aantal: rij.aantal, gevel: rij.status === 'actief' ? gevelVan(rij, c ? c.fotos : null) : null, gevel_gekozen: !!rij.gevel,
      foto_delen: !!rij.foto_delen, url: rij.status === 'actief' && rij.album_id ? url(rij.album_id) : null };
  }
  async function fotos(hid) {
    const rij = q.a.get(hid);
    if (!rij) return { status: 200, body: { ok: true, album: null, fotos: [], immich: stand.fout || (stand.sleutel === false ? 'geen sleutel' : null) } };
    if (rij.status !== 'actief') return { status: 200, body: { ok: true, album: kort(hid), fotos: [] } };
    let f;
    try { f = await lijstVan(hid, true); }
    catch (e) { if (e.code !== 'GEEN_SLEUTEL') fout('ml-immich-fotos', e); return { status: 503, body: { ok: false, fout: e.code === 'GEEN_SLEUTEL' ? 'nog geen Immich-sleutel' : 'Immich was niet bereikbaar; probeer het zo opnieuw' } }; }
    return { status: 200, body: { ok: true, album: kort(hid), fotos: f } };
  }
  // Een foto mag alleen als hij NU in een gekoppeld album zit (review MOET 2): de lijst van dat album is hooguit 2 minuten oud, anders eerst
  // opnieuw bij Immich gevraagd. De app haalt de lijst altijd eerst op (fotos()), dus normaal is hij vers.
  // mag (wv2306, toonmodus): alleen albums van herinneringen waarvoor mag(hid) true geeft
  async function toegestaan(id, mag) {
    for (const [hid, c] of cache) {
      if (!c.fotos.some((f) => f.id === id)) continue;
      if (mag && !mag(hid)) continue;
      if (nu() - c.op < TOEGANG_VERS_MS) return true;
      const rij = q.a.get(hid);
      if (!rij || rij.status !== 'actief') { cache.delete(hid); continue; }
      if ((await lijstVan(hid, true)).some((f) => f.id === id)) return true;
    }
    return false;
  }
  async function foto(id, maat, magHid) {
    if (!IM.UUID_RE.test(String(id))) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    let mag;
    try { mag = await toegestaan(id, magHid); } catch (e) { return { status: 503, body: { ok: false, fout: 'Immich was niet bereikbaar' } }; }
    if (!mag) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    let b;
    try { b = await im.beeld(id, maat); }
    catch (e) { if (e.code === 'HTTP' && e.status === 404) return { status: 404, body: { ok: false, fout: 'onbekend' } }; fout('ml-immich-foto', e); return { status: 503, body: { ok: false, fout: 'Immich was niet bereikbaar' } }; }
    return { status: 200, body: { ok: true, mime: b.mime, data: b.data.toString('base64') } };
  }
  async function gevel(hid, d) {
    const rij = q.a.get(hid);
    if (!rij || rij.status !== 'actief') return { status: 404, body: { ok: false, fout: 'geen album' } };
    const id = d && d.asset === null ? null : d && d.asset;
    if (id !== null) {
      let f;
      try { f = await lijstVan(hid, false); } catch (e) { return { status: 503, body: { ok: false, fout: 'Immich was niet bereikbaar' } }; }
      if (!IM.UUID_RE.test(String(id)) || !f.some((x) => x.id === id)) return { status: 400, body: { ok: false, fout: 'die foto staat niet in het album' } };
    }
    q.gevel.run(id, hid);
    if (rij.foto_delen) { try { await zetDeelFotos(hid); } catch (e) { fout('ml-immich-deel', e); } }
    return { status: 200, body: { ok: true, album: kort(hid) } };
  }
  // → true als de set foto's voor de link veranderde
  async function zetDeelFotos(hid, vers) {
    const rij = q.a.get(hid);
    const f = (await lijstVan(hid, !!vers)).filter((x) => x.beeld);
    const g = gevelVan(rij, f);
    const ids = (g ? [g] : []).concat(f.map((x) => x.id).filter((x) => x !== g)).slice(0, MAX_DEEL);
    const json = JSON.stringify(ids);
    if (json === rij.deel_fotos) return false;
    q.deelFotos.run(json, hid);
    return true;
  }
  async function fotoDelen(hid, d) {
    const rij = q.a.get(hid);
    if (!rij || rij.status !== 'actief') return { status: 404, body: { ok: false, fout: 'geen album' } };
    if (!d || typeof d.aan !== 'boolean') return { status: 400, body: { ok: false, fout: 'aan' } };
    if (d.aan) {
      try { await zetDeelFotos(hid, true); } catch (e) { return { status: 503, body: { ok: false, fout: 'Immich was niet bereikbaar; probeer het zo opnieuw' } }; }
      q.delen.run(1, hid);
    } else { q.delen.run(0, hid); q.deelFotos.run(null, hid); }
    return { status: 200, body: { ok: true, album: kort(hid) } };
  }
  // Voor de publicatie (synchroon): de asset-ids die bij een gedeelde herinnering mee mogen; [] = geen foto's
  function voorDelen(hid) {
    const rij = q.a.get(hid);
    if (!rij || rij.status !== 'actief' || !rij.foto_delen || !rij.deel_fotos) return [];
    try { const l = JSON.parse(rij.deel_fotos); return Array.isArray(l) ? l.filter((x) => IM.UUID_RE.test(String(x))).slice(0, MAX_DEEL) : []; } catch (e) { return []; }
  }
  // Zet de miniaturen van één gedeelde herinnering in D1 (eerst de oude weg). Gooit bij een Immich-fout (dan probeert de volgende tik opnieuw).
  async function naarD1(d1, kring, pub, ids) {
    if (ids.length && rust()) throw new Error('immich rust');
    const beelden = [];
    for (const id of ids) {
      let b;
      try { b = await im.beeld(id, 'klein'); } catch (e) { if (e.code === 'HTTP' && e.status === 404) continue; laatsteFout = nu(); throw e; }
      if (b.data.length > MAX_DEEL_BYTES || IM.heeftMetadata(b.data)) continue;   // te groot of met Exif/XMP: niet naar buiten
      beelden.push(b);
    }
    await d1('DELETE FROM ml_foto WHERE kring = ?1 AND pub = ?2', [kring, pub]);
    for (let i = 0; i < beelden.length; i++) {
      await d1('INSERT INTO ml_foto (kring, pub, nr, mime, data) VALUES (?1, ?2, ?3, ?4, ?5)', [kring, pub, i, beelden[i].mime, beelden[i].data.toString('base64')]);
    }
    return beelden.length;
  }
  function info() {
    const t = Object.fromEntries(q.tel.all().map((r) => [r.status, r.n]));
    return { albums: t, delen: q.alle.all().filter((r) => r.foto_delen).length, sleutel: stand.sleutel, fout: stand.fout, laatst: stand.op };
  }
  return { sync, kort, fotos, foto, gevel, fotoDelen, albumMaken, voorDelen, naarD1, info, _db: db, _cache: cache };
}

module.exports = { maak, code, albumNaam, socevsNaam, omschrijving, VOORVOEGSEL, MERK, MAX_DEEL };
