'use strict';
/*
 * MemoryLane op memorylane.socev.dev (wv2636, 8-11-2026). Ontwerp in de vault: 01_Ontwikkeling "MemoryLane op een eigen adres - familie en
 * Shizzle (ontwerp 7-11-2026)" § 3–7, keuze A (kopie buiten; review ronde 1 Codex verwerkt). Davids Ja: kaart 7-11 13:21 (lijst van 16, gevoelig
 * weglaten, geen huistype bij dichte huizen, foto's meteen alles, oude deellinks uit bij opening) en 8-11 in de machinekamer ("ALLES mag gelabeld").
 *
 * WAAROM. David wil zijn straat met herinneringen delen met zijn directe familie (alles) en de Shizzle-vrienden (alleen hun herinneringen),
 * met inloggen via Google of een code per mail, zonder dat een bezoeker ooit de pod raakt.
 *
 * WAT. De pod duwt per kring (familie, shizzle) precies wat die kring mag zien naar D1 `memorylane` (straat, open huizen, fotolijsten, bezoekers)
 * en R2 `memorylane` (foto's en gevels; privé emmer zonder openbaar adres: alleen de worker leest hem via zijn binding). De worker
 * (socev-app memorylane/worker.js) toetst elk verzoek opnieuw: Access-JWT (vastgepind), bezoeker in D1, kring, huis open, niet geblokkeerd.
 *  - Eén publicatiebeslissing: memorylane-delen.js publiekLijst(kring) (kringkeuze van David of het voorstel; zelfde basis als de toonmodus).
 *  - Vast schema: LIJST_VELDEN / DETAIL_VELDEN hieronder; een dicht huis heeft alleen het jaar (plek in het jaar uit een HMAC, geen maand of dag)
 *    en verder vaste neutrale waarden. Een open huis met een geheim of een patiëntmarker in zijn tekst gaat dicht (geen "toch delen" hier).
 *  - Ids: per kring een eigen huis-id (h + 16 hex) en foto-id (HMAC-SHA256 met een pod-sleutel): geen hid, Immich-id of koppeling tussen kringen.
 *  - Foto's: Immich-miniatuur en -voorbeeld (± 1440 px), zonder metadata (strip(): EXIF, XMP, IPTC, commentaar eruit; onbekend formaat = niet
 *    publiceren). De D1-rij van een foto komt pas na beide R2-objecten.
 *  - Video's (wv2938): als een foto (miniatuur en voorbeeld = het eerste beeld uit Immich, metadata eruit) plus R2 f/<kring>/<fid>/v (de kleine
 *    versie van memorylane-video.js, zonder metadata) en D1-rij video. Pas als die versie klaar is (anders de volgende ronde). Samen hooguit
 *    VIDEO_BUDGET bytes in R2 (beide kringen; het account zit dicht bij de gratis 10 GB): wat niet past, gaat niet naar buiten. Vlak vóór de
 *    D1-rij wordt de toestemming opnieuw getoetst (review ontwerp MOET 1); mag het niet meer, dan gaan de net geplaatste objecten weer weg.
 *  - Dicht gaan (kring uit, gevoelig, weg): in één D1-batch eerst een blok-rij (de worker weigert meteen), dan de rijen weg; daarna de
 *    R2-objecten; het blok gaat pas weg als die allemaal weg zijn (anders herhaalt de volgende ronde).
 *  - Houdbaarheid: publicatie.geldig_tot = nu + 24 u na elke geslaagde ronde; duwt de pod een dag niet, dan zet de worker de straat dicht.
 *  - Noodstop: mlp_stand noodstop = 1 → D1 stand noodstop (de worker weigert alles). Uit mag altijd; weer open vraagt de app een vingerafdruk.
 *  - Bezoekers: vaultpagina MemoryLane-bezoekers.md; alleen bij frontmatter status "bevestigd". In D1 alleen sha256(adres) → persoon-id + kring.
 *  - Logboek: de worker schrijft persoon-id, kring, huis-id en tijd (geen IP, geen inhoud); de pod haalt het op (mlp_log, met de hid) en wist het buiten.
 * PRIVACY. Nooit titels, namen of adressen in logs, fouten of /health: alleen aantallen.
 * VORM. Alleen fs, path en crypto; D1 (batch), R2 (put/del) en memorylane-delen komen via maak({...}).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MLD = require('./memorylane-delen.js');

const KRINGEN = MLD.PKRINGEN;
const RONDE_MS = 15 * 60000, LOG_MS = 5 * 60000, HOUDBAAR_MS = 24 * 3600000;
const FOTO_BUDGET_MS = 40000, FOTO_TEGELIJK = 3, BATCH = 40, FOTO_MAX_TIK = 40;
// wv2943: bezoekers krijgen hooguit de eerste 300 foto's van een album (de pod geeft Davids app er nu 500); de opnamedag komt per ronde
// bij hooguit DAG_PER_RONDE al geplaatste foto's (± 23.000 bij de invoering: 50 D1-aanroepen per kring per ronde, binnen de Cloudflare-rem)
const MAX_PUBLIEK_FOTOS = 300, DAG_PER_RONDE = 2000;
const DAG_RE = /^(19|20)\d{2}-\d{2}-\d{2}$/;
const VIDEO_BUDGET = 150 * 1000 * 1000;   // wv2938: alle video's buiten samen (R2 van het hele account stond 11-11 op 9,68 van de gratis 10 GB)
// wv2737: de Cloudflare-API staat 1.200 aanroepen per 5 min toe (header Ratelimit-Policy q=1200;w=300, gemeten 8-11). Een foto kost 3 aanroepen
// (2x R2 put + D1). Zonder rem haalde de lus de grens in seconden en faalde daarna ±100 uploads per seconde, die elk weer meetelden: geen foto
// meer door, api.log elk uur vol, en ook de rondes en de oude deellinks (ml-d1) faalden. Nu hooguit FOTO_MAX_TIK pogingen per tik
// (40 x 3 = 120/min = 600 per 5 min, de helft van de grens) en stoppen bij de eerste fout; die foto gaat achteraan en komt de volgende tik terug.
const LIJST_VELDEN = ['hid', 'soort', 'bron', 'status', 'titel', 'wanneer', 'wanneer_bron', 'datum', 'categorie', 'gevoelig', 'personen', 'plaatsen', 'voorvallen',
  'audio', 'binnen', 'vastgehouden', 'stukken', 'zicht', 'album', 'plaatje', 'plaatje_kan', 'dicht'];
const DETAIL_VELDEN = LIJST_VELDEN.concat(['verhaal', 'stukken_lijst', 'voorstellen']);

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mlp_obj (kring TEXT NOT NULL, sleutel TEXT NOT NULL, hash TEXT NOT NULL, hid TEXT, PRIMARY KEY (kring, sleutel));
CREATE TABLE IF NOT EXISTS mlp_stand (sleutel TEXT PRIMARY KEY, waarde TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mlp_log (id INTEGER PRIMARY KEY, pid TEXT NOT NULL, kring TEXT NOT NULL, hid TEXT, op TEXT NOT NULL);
`;
// D1-schema (de worker leest; de pod maakt het aan bij de eerste ronde)
const D1_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS bezoeker (hash TEXT PRIMARY KEY, pid TEXT NOT NULL, kring TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS publicatie (kring TEXT PRIMARY KEY, versie INTEGER NOT NULL, geldig_tot INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS huis (kring TEXT NOT NULL, pid TEXT NOT NULL, open INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (kring, pid))',
  'CREATE TABLE IF NOT EXISTS detail (kring TEXT NOT NULL, pid TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (kring, pid))',
  'CREATE TABLE IF NOT EXISTS foto (kring TEXT NOT NULL, fid TEXT NOT NULL, pid TEXT NOT NULL, volg INTEGER NOT NULL, ratio REAL, mime_k TEXT NOT NULL, mime_g TEXT NOT NULL, dag TEXT, PRIMARY KEY (kring, fid))',
  'CREATE INDEX IF NOT EXISTS foto_pid ON foto (kring, pid, volg)',
  'CREATE TABLE IF NOT EXISTS gevel (kring TEXT NOT NULL, pid TEXT NOT NULL, mime TEXT NOT NULL, PRIMARY KEY (kring, pid))',
  'CREATE TABLE IF NOT EXISTS video (kring TEXT NOT NULL, fid TEXT NOT NULL, pid TEXT NOT NULL, mime TEXT NOT NULL, grootte INTEGER NOT NULL, PRIMARY KEY (kring, fid))',   // wv2938
  'CREATE TABLE IF NOT EXISTS blok (kring TEXT NOT NULL, pid TEXT NOT NULL, op INTEGER NOT NULL, PRIMARY KEY (kring, pid))',
  'CREATE TABLE IF NOT EXISTS stand (sleutel TEXT PRIMARY KEY, waarde TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, pid TEXT NOT NULL, kring TEXT NOT NULL, huis TEXT, op INTEGER NOT NULL)',
];

// wv2943: kolommen die er later bij kwamen (bestaande D1); 'duplicate column' = er al
const D1_KOLOMMEN = ['ALTER TABLE foto ADD COLUMN dag TEXT'];

function sha256(x) { return crypto.createHash('sha256').update(x).digest('hex'); }
function iso(ms) { return new Date(ms).toISOString(); }
function adresHash(m) { return sha256(String(m).normalize('NFC').trim().toLowerCase()); }   // zelfde als de worker

// ── metadata eruit (geen afhankelijkheden; de pod heeft geen beeldbibliotheek) ──
// JPEG: alleen SOI, APP0 (JFIF), APP2 (ICC-profiel), DQT/SOF/DHT/DRI/SOS en de beelddata; APP1 (EXIF/XMP), APP13 (IPTC), andere APPn en COM eruit.
function stripJpeg(b) {
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
  const uit = [b.subarray(0, 2)];
  let i = 2;
  while (i + 2 <= b.length) {
    if (b[i] !== 0xFF) return null;
    const m = b[i + 1];
    if (m === 0xFF) { i++; continue; }
    if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
    if (m === 0xD9) { uit.push(b.subarray(i, i + 2)); return Buffer.concat(uit); }
    if (i + 4 > b.length) return null;
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    if (m === 0xDA) {   // SOS: kop + beelddata tot de volgende echte marker (FF00 en RST0-7 horen bij de data); review MOET 2
      let j = i + 2 + len;
      while (j + 1 < b.length && !(b[j] === 0xFF && b[j + 1] !== 0x00 && !(b[j + 1] >= 0xD0 && b[j + 1] <= 0xD7) && b[j + 1] !== 0xFF)) j++;
      if (j + 1 >= b.length) return null;   // geen afsluitende marker: kapot
      uit.push(b.subarray(i, j));
      i = j;
      continue;
    }
    const app = m >= 0xE0 && m <= 0xEF, houd = !app || m === 0xE0 || (m === 0xE2 && b.toString('latin1', i + 4, i + 15) === 'ICC_PROFILE');
    if (m !== 0xFE && houd) uit.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}
// WebP: chunks EXIF en XMP eruit, de vlaggen in VP8X bijgewerkt, RIFF-grootte opnieuw
function stripWebp(b) {
  if (b.length < 20 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const uit = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const id = b.toString('latin1', i, i + 4), len = b.readUInt32LE(i + 4), tot = 8 + len + (len & 1);
    if (i + 8 + len > b.length) return null;
    if (id !== 'EXIF' && id !== 'XMP ') {
      const c = Buffer.from(b.subarray(i, Math.min(i + tot, b.length)));
      if (id === 'VP8X' && c.length > 8) c[8] &= ~(0x08 | 0x04);
      uit.push(c);
    }
    i += tot;
  }
  const lijf = Buffer.concat(uit), kop = Buffer.alloc(12);
  kop.write('RIFF', 0, 'latin1'); kop.writeUInt32LE(4 + lijf.length, 4); kop.write('WEBP', 8, 'latin1');
  return Buffer.concat([kop, lijf]);
}
function strip(b, mime) {
  if (/jpe?g/i.test(mime || '') || (b[0] === 0xFF && b[1] === 0xD8)) { const x = stripJpeg(b); return x ? { mime: 'image/jpeg', data: x } : null; }
  if (/webp/i.test(mime || '') || b.toString('latin1', 8, 12) === 'WEBP') { const x = stripWebp(b); return x ? { mime: 'image/webp', data: x } : null; }
  return null;
}

// vast schema: alleen deze velden, en in een open huis alleen de toonvorm van verhaal/album
function kies(o, velden) { const u = {}; for (const v of velden) if (o[v] !== undefined) u[v] = o[v]; return u; }
function lijstItem(pid, t) {
  const u = kies(t, LIJST_VELDEN);
  u.hid = pid; u.audio = 0; u.binnen = 0; u.vastgehouden = 0; u.stukken = 0; u.zicht = { familie: false, vrienden: false }; u.plaatje_kan = false; u.dicht = false;
  u.album = t.album ? { status: t.album.status, aantal: t.album.aantal } : null;
  u.personen = (t.personen || []).map(String); u.plaatsen = (t.plaatsen || []).map(String); u.voorvallen = (t.voorvallen || []).map(String);
  return u;
}
function detailItem(pid, t) {
  const u = Object.assign(kies(t, DETAIL_VELDEN), lijstItem(pid, t));
  const v = t.verhaal || {};
  u.verhaal = { tekst: typeof v.tekst === 'string' ? v.tekst : null, stand: v.stand || null,
    delen: (v.delen || []).map((d) => ({ titel: d.titel || null, eigen: false, alineas: (d.alineas || []).map((a) => ({ tekst: String(a.tekst || ''), t_van: null, t_tot: null })) })) };
  u.stukken_lijst = []; u.voorstellen = [];
  return u;
}
function tekstenVan(d) {
  const l = [d.titel, d.wanneer].concat(d.personen || [], d.plaatsen || [], d.voorvallen || []);
  if (d.verhaal) { l.push(d.verhaal.tekst); for (const x of d.verhaal.delen || []) { l.push(x.titel); for (const a of x.alineas || []) l.push(a.tekst); } }
  return l.filter((x) => typeof x === 'string' && x);
}

function maak(o) {
  const nu = typeof o.nu === 'function' ? o.nu : Date.now;
  const db = o.db, ml = o.ml, fout = (l, e) => { if (o.fout) o.fout(l, e); };
  db.exec(SCHEMA_SQL);
  const q = {
    obj: db.prepare('SELECT * FROM mlp_obj WHERE kring = ?'),
    objZet: db.prepare('INSERT INTO mlp_obj (kring, sleutel, hash, hid) VALUES (?, ?, ?, ?) ON CONFLICT (kring, sleutel) DO UPDATE SET hash = excluded.hash, hid = excluded.hid'),
    objWeg: db.prepare('DELETE FROM mlp_obj WHERE kring = ? AND sleutel = ?'),
    stand: db.prepare('SELECT waarde FROM mlp_stand WHERE sleutel = ?'),
    standZet: db.prepare('INSERT INTO mlp_stand (sleutel, waarde) VALUES (?, ?) ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde'),
    logZet: db.prepare('INSERT OR IGNORE INTO mlp_log (id, pid, kring, hid, op) VALUES (?, ?, ?, ?, ?)'),
    logLaatst: db.prepare('SELECT max(id) m FROM mlp_log'),
    logWeg: db.prepare('DELETE FROM mlp_log WHERE op < ?'),
    logPer: db.prepare('SELECT pid, kring, count(*) n, max(op) laatst FROM mlp_log GROUP BY pid, kring'),
    logHid: db.prepare('SELECT hid, pid, max(op) laatst FROM mlp_log WHERE hid IS NOT NULL GROUP BY hid, pid'),
  };
  const stand = (k) => { const r = q.stand.get(k); return r ? r.waarde : null; };
  // HMAC-sleutel voor de ids (alleen op de pod, 0600)
  const SLEUTEL_PAD = path.join(o.dir, 'mlp-sleutel');
  let sleutel;
  try { sleutel = fs.readFileSync(SLEUTEL_PAD); } catch (e) { sleutel = crypto.randomBytes(32); fs.writeFileSync(SLEUTEL_PAD, sleutel, { mode: 0o600, flag: 'wx' }); sleutel = fs.readFileSync(SLEUTEL_PAD); }
  if (sleutel.length < 32) throw new Error('mlp-sleutel te kort');
  const hm = (s) => crypto.createHmac('sha256', sleutel).update(s).digest();
  const pidVan = (k, hid) => 'h' + hm('h|' + k + '|' + hid).toString('hex').slice(0, 16);
  const fidVan = (k, hid, asset) => hm('f|' + k + '|' + hid + '|' + asset).toString('base64url').slice(0, 22);   // review ZOU 1: per huis
  const persoonVan = (naam) => 'p' + hm('p|' + String(naam).normalize('NFC').trim().toLowerCase()).toString('hex').slice(0, 12);
  function dichtItem(k, hid, jaar) {
    const mm = String(1 + (hm('m|' + k + '|' + hid).readUInt16BE(0) % 12)).padStart(2, '0');
    const d = jaar ? jaar + '-' + mm : null;
    return { hid: pidVan(k, hid), soort: 'los', bron: null, status: 'actief', titel: '', wanneer: jaar || '', wanneer_bron: null, datum: d ? '1|' + d + '|' + d : '0|',
      categorie: 'prive', gevoelig: true, personen: [], plaatsen: [], voorvallen: [], audio: 0, binnen: 0, vastgehouden: 0, stukken: 0,
      zicht: { familie: false, vrienden: false }, album: null, plaatje: false, plaatje_kan: false, dicht: true };
  }
  const raakCache = new Map();
  function raak(d) {
    const t = tekstenVan(d), h = sha256(JSON.stringify(t));
    if (raakCache.has(h)) return raakCache.get(h);
    let r = null;
    try { r = typeof ml.tekstRaak === 'function' ? ml.tekstRaak(t) : 'geen poort'; } catch (e) { fout('mlp-poort', e); r = 'fout'; }
    if (raakCache.size > 2000) raakCache.clear();
    raakCache.set(h, r);
    return r;
  }

  async function d1(batch) {
    const uit = [];
    for (let i = 0; i < batch.length; i += BATCH) uit.push(...await o.d1(batch.slice(i, i + BATCH)));
    return uit;
  }
  let schemaKlaar = false;
  async function zorgSchema() {
    if (schemaKlaar) return;
    await d1(D1_SCHEMA.map((sql) => ({ sql, params: [] })));
    for (const sql of D1_KOLOMMEN) { try { await d1([{ sql, params: [] }]); } catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; } }
    schemaKlaar = true;
  }

  // ── bezoekers (elke tik; alleen bij een wijziging naar D1) ──
  function bezoekersWens() {
    const x = MLD.bezoekersLees(o.vault, o.vv);
    if (!x.pagina || x.status !== 'bevestigd') return [];
    const rijen = [], gezien = new Set();
    for (const r of x.rijen) for (const m of r.mails) {
      const h = adresHash(m);
      if (gezien.has(h)) continue;   // hetzelfde adres twee keer: de eerste rij telt
      gezien.add(h); rijen.push({ hash: h, pid: persoonVan(r.naam), kring: r.kring });
    }
    return rijen.sort((a, b) => (a.hash < b.hash ? -1 : 1));
  }
  async function bezoekersSync() {
    const w = bezoekersWens(), h = sha256(JSON.stringify(w));
    if (stand('bezoekers_hash') === h) return false;
    await d1([{ sql: 'DELETE FROM bezoeker', params: [] }].concat(w.map((r) => ({ sql: 'INSERT INTO bezoeker (hash, pid, kring) VALUES (?, ?, ?)', params: [r.hash, r.pid, r.kring] }))));
    q.standZet.run('bezoekers_hash', h); q.standZet.run('bezoekers_n', String(w.length));
    return true;
  }

  // ── de straat per kring ──
  let wens = null;   // kring → { huizen: Map(pid → {hid, open, json}), details: Map, gevels: Map(pid → {hid, hash}), fotos: Map(fid → {hid, pid, asset, volg, ratio}) }
  const videoKan = typeof ml.videoBestand === 'function' && ml.info && (function () { try { const i = ml.info(); return !!(i && i.video && i.video.ffmpeg); } catch (e) { return false; } })();
  async function wensVan(k) {
    const w = { huizen: new Map(), details: new Map(), gevels: new Map(), fotos: new Map(), tegen: 0 };
    for (const x of ml.publiekLijst(k)) {
      const pid = pidVan(k, x.hid);
      if (!x.open) { w.huizen.set(pid, { hid: x.hid, open: 0, json: JSON.stringify(dichtItem(k, x.hid, x.jaar)) }); continue; }
      const dt = ml.detail(x.hid, { kring: k });
      if (dt.status !== 200 || !dt.body || !dt.body.herinnering) { w.huizen.set(pid, { hid: x.hid, open: 0, json: JSON.stringify(dichtItem(k, x.hid, null)) }); continue; }
      const det = detailItem(pid, dt.body.herinnering);
      if (raak(det)) { w.tegen++; w.huizen.set(pid, { hid: x.hid, open: 0, json: JSON.stringify(dichtItem(k, x.hid, (det.datum.match(/^1\|(\d{4})/) || [])[1] || null)) }); continue; }
      w.huizen.set(pid, { hid: x.hid, open: 1, json: JSON.stringify(lijstItem(pid, x.item)) });
      w.details.set(pid, { hid: x.hid, json: JSON.stringify(det) });
      if (x.item.album && x.item.album.status === 'actief') {
        let f = null;
        try { f = await ml.fotos(x.hid, { kring: k }); } catch (e) { fout('mlp-fotos', e); }
        if (!f || f.status !== 200) { w.onvolledig = true; continue; }   // Immich even weg: deze ronde niets van dit album weghalen
        let volg = 0;
        // wv2938: een video alleen als de pod video's kan omzetten (ml.videoBestand); anders blijft hij buiten, zoals eerst
        // wv2943: per foto alleen de opnamedag erbij (geen plaats, tijd of favoriet: David beslist later over de plaats voor bezoekers)
        for (const ft of (f.body.fotos || []).slice(0, MAX_PUBLIEK_FOTOS)) {
          if (!ft || typeof ft.id !== 'string' || (!ft.beeld && !videoKan)) continue;
          w.fotos.set(fidVan(k, x.hid, ft.id), { hid: x.hid, pid, asset: ft.id, volg: volg++, ratio: typeof ft.ratio === 'number' ? ft.ratio : null, video: !ft.beeld,
            dag: typeof ft.dag === 'string' && DAG_RE.test(ft.dag) ? ft.dag : null });
        }
        const gv = f.body.album && f.body.album.gevel;
        w.gevels.set(pid, { hid: x.hid, hash: 'foto:' + (gv || '') });
      } else if (x.item.plaatje) w.gevels.set(pid, { hid: x.hid, hash: 'plaatje' });
    }
    return w;
  }

  // R2-sleutels (vast schema; geen titels of ids van de pod)
  const r2f = (k, fid, m) => 'f/' + k + '/' + fid + '/' + m;
  const r2g = (k, pid) => 'g/' + k + '/' + pid;

  async function rondeKring(k, w) {
    const nu0 = q.obj.all(k), heb = new Map(nu0.map((r) => [r.sleutel, r]));
    const batch = [], naD1 = [], r2weg = [];
    // huizen die niet meer open zijn (dicht of weg): eerst blok, dan rijen weg
    const dichtGaan = new Set();
    for (const r of nu0) {
      const pid = r.sleutel.slice(2);
      if (r.sleutel.startsWith('d:') && !w.details.has(pid)) dichtGaan.add(pid);
      if (r.sleutel.startsWith('h:') && !w.huizen.has(pid)) dichtGaan.add(pid);
    }
    for (const pid of dichtGaan) {
      batch.push({ sql: 'INSERT INTO blok (kring, pid, op) VALUES (?, ?, ?) ON CONFLICT (kring, pid) DO UPDATE SET op = excluded.op', params: [k, pid, nu()] });
      batch.push({ sql: 'DELETE FROM detail WHERE kring = ? AND pid = ?', params: [k, pid] }, { sql: 'DELETE FROM foto WHERE kring = ? AND pid = ?', params: [k, pid] },
        { sql: 'DELETE FROM video WHERE kring = ? AND pid = ?', params: [k, pid] }, { sql: 'DELETE FROM gevel WHERE kring = ? AND pid = ?', params: [k, pid] });
      if (!w.huizen.has(pid)) batch.push({ sql: 'DELETE FROM huis WHERE kring = ? AND pid = ?', params: [k, pid] });
      naD1.push(() => { q.objWeg.run(k, 'd:' + pid); if (!w.huizen.has(pid)) q.objWeg.run(k, 'h:' + pid); });
    }
    // losse foto's die uit een (nog open) album gingen
    for (const r of nu0) {
      if (r.sleutel.startsWith('f:')) {
        const fid = r.sleutel.slice(2), x = JSON.parse(r.hash);
        const weg = !w.fotos.has(fid) && (dichtGaan.has(x.pid) || !w.onvolledig);
        if (!weg) continue;
        if (!dichtGaan.has(x.pid)) batch.push({ sql: 'DELETE FROM foto WHERE kring = ? AND fid = ?', params: [k, fid] }, { sql: 'DELETE FROM video WHERE kring = ? AND fid = ?', params: [k, fid] });
        r2weg.push({ sleutel: r.sleutel, keys: [r2f(k, fid, 'k'), r2f(k, fid, 'g')].concat(x.v ? [r2f(k, fid, 'v')] : []), pid: x.pid });
      }
      if (r.sleutel.startsWith('g:')) {
        const pid = r.sleutel.slice(2), g = w.gevels.get(pid);
        if (g && g.hash === JSON.parse(r.hash).bron) continue;
        if (!dichtGaan.has(pid)) batch.push({ sql: 'DELETE FROM gevel WHERE kring = ? AND pid = ?', params: [k, pid] });
        r2weg.push({ sleutel: r.sleutel, keys: [r2g(k, pid)], pid });
      }
    }
    // nieuwe of gewijzigde huizen en details
    for (const [pid, h] of w.huizen) {
      const hs = sha256(h.json);
      if (!heb.has('h:' + pid) || heb.get('h:' + pid).hash !== hs) {
        batch.push({ sql: 'INSERT INTO huis (kring, pid, open, json) VALUES (?, ?, ?, ?) ON CONFLICT (kring, pid) DO UPDATE SET open = excluded.open, json = excluded.json', params: [k, pid, h.open, h.json] });
        naD1.push(() => q.objZet.run(k, 'h:' + pid, hs, h.hid));
      }
    }
    for (const [pid, d] of w.details) {
      const hs = sha256(d.json);
      if (!heb.has('d:' + pid) || heb.get('d:' + pid).hash !== hs) {
        batch.push({ sql: 'INSERT INTO detail (kring, pid, json) VALUES (?, ?, ?) ON CONFLICT (kring, pid) DO UPDATE SET json = excluded.json', params: [k, pid, d.json] });
        batch.push({ sql: 'DELETE FROM blok WHERE kring = ? AND pid = ?', params: [k, pid] });
        naD1.push(() => q.objZet.run(k, 'd:' + pid, hs, d.hid));
      }
    }
    // volgorde/ratio/dag van al geplaatste foto's bijwerken (wv2943: alleen een andere dag telt mee in DAG_PER_RONDE; volg/ratio altijd)
    let dagNog = o.dagPerRonde || DAG_PER_RONDE;   // (toets: kleiner)
    for (const [fid, f] of w.fotos) {
      const r = heb.get('f:' + fid);
      if (!r) continue;
      const x = JSON.parse(r.hash);
      if (x.bezig) continue;
      const anders = x.volg !== f.volg || x.ratio !== f.ratio, dagAnders = (x.dag ?? null) !== (f.dag ?? null);
      let dag = x.dag ?? null;
      if (dagAnders && (anders || dagNog > 0)) { dag = f.dag ?? null; if (!anders) dagNog--; }
      if (!anders && dag === (x.dag ?? null)) continue;
      batch.push({ sql: 'UPDATE foto SET volg = ?, ratio = ?, dag = ? WHERE kring = ? AND fid = ?', params: [f.volg, f.ratio, dag, k, fid] });
      naD1.push(() => q.objZet.run(k, 'f:' + fid, JSON.stringify(Object.assign({ pid: x.pid, volg: f.volg, ratio: f.ratio, mk: x.mk, mg: x.mg }, dag ? { dag } : {}, x.v ? { v: x.v } : {})), f.hid));
    }
    if (batch.length) await d1(batch);
    for (const f of naD1) f();
    // R2 opruimen; blok weg als alles van dat huis weg is
    const pidsKlaar = new Set([...dichtGaan, ...r2weg.map((x) => x.pid)]);   // ook een huis waarvan een eerdere ronde het opruimen niet afmaakte
    for (const x of r2weg) {
      let ok = true;
      for (const key of x.keys) { try { await o.r2.del(key); } catch (e) { ok = false; fout('mlp-r2-weg', e); } }
      if (ok) q.objWeg.run(k, x.sleutel); else pidsKlaar.delete(x.pid);
    }
    const rest = new Set();
    if (pidsKlaar.size) for (const r of q.obj.all(k)) { if (r.sleutel.startsWith('f:')) rest.add(JSON.parse(r.hash).pid); else if (r.sleutel.startsWith('g:')) rest.add(r.sleutel.slice(2)); }
    const blokWeg = [...pidsKlaar].filter((pid) => !rest.has(pid) && !w.details.has(pid));
    if (blokWeg.length) await d1(blokWeg.map((pid) => ({ sql: 'DELETE FROM blok WHERE kring = ? AND pid = ?', params: [k, pid] })));
    return { huizen: w.huizen.size, open: w.details.size, dicht_gegaan: dichtGaan.size, tegen: w.tegen };
  }

  // foto's en gevels uploaden (begrensd per tik)
  let wachtrij = [];
  function vulWachtrij() {
    wachtrij = [];
    if (!wens) return;
    for (const k of KRINGEN) {
      const w = wens[k]; if (!w) continue;
      const heb = new Map(q.obj.all(k).map((r) => [r.sleutel, r]));
      for (const [pid, g] of w.gevels) {
        const r = heb.get('g:' + pid);
        if (!r || JSON.parse(r.hash).bron !== g.hash) wachtrij.push({ k, soort: 'g', pid, hid: g.hid, bron: g.hash });
      }
      for (const [fid, f] of w.fotos) { const r = heb.get('f:' + fid); if (!r || JSON.parse(r.hash).bezig) wachtrij.push({ k, soort: 'f', fid, ...f }); }
    }
  }
  async function beeld(x, maat) {
    const u = x.soort === 'g' ? await ml.gevelBeeld(x.hid, { kring: x.k }) : await ml.foto(x.asset, maat === 'g' ? 'groot' : 'klein', { kring: x.k });
    if (!u || u.status !== 200 || !u.body || typeof u.body.data !== 'string') return null;
    return strip(Buffer.from(u.body.data, 'base64'), u.body.mime);
  }
  async function upload(x) {
    // tussendoor dicht gegaan? dan niet meer uploaden
    if (!wens || !wens[x.k] || !wens[x.k].details.has(x.pid)) return 'overgeslagen';
    if (x.soort === 'g') {
      const b = await beeld(x, 'k');
      if (!b) return 'geen';
      q.objZet.run(x.k, 'g:' + x.pid, JSON.stringify({ bron: null, bezig: true }), x.hid);   // review MOET 3: eerst vastleggen, dan uploaden
      await o.r2.put(r2g(x.k, x.pid), b.data, b.mime);
      await d1([{ sql: 'INSERT INTO gevel (kring, pid, mime) VALUES (?, ?, ?) ON CONFLICT (kring, pid) DO UPDATE SET mime = excluded.mime', params: [x.k, x.pid, b.mime] }]);
      q.objZet.run(x.k, 'g:' + x.pid, JSON.stringify({ bron: x.bron }), x.hid);
      return 'ok';
    }
    // wv2938: een video eerst klaar en binnen het budget, anders (nog) niet
    let vid = null;
    if (x.video) {
      vid = await ml.videoBestand(x.asset, { kring: x.k, hid: x.hid });
      if (!vid || vid.stand === 'kan-niet') { videoTel.niet++; return 'geen'; }
      if (vid.stand !== 'klaar') { videoTel.wacht++; return 'wacht'; }
      // review bouw MOET 2: synchroon reserveren (geen await tussen toets en reservering), anders gebruiken parallelle uploads hetzelfde budget
      if (videoBytes() + videoGereserveerd + vid.grootte > budget) { videoTel.budget++; return 'geen'; }
      videoGereserveerd += vid.grootte;
    }
    try { return await uploadFoto(x, vid); } finally { if (vid && !vid.overgedragen) videoGereserveerd -= vid.grootte; }
  }
  async function uploadFoto(x, vid) {
    const bk = await beeld(x, 'k'), bg = await beeld(x, 'g');
    if (!bk || !bg) return 'geen';
    q.objZet.run(x.k, 'f:' + x.fid, JSON.stringify(Object.assign({ pid: x.pid, bezig: true }, vid ? { v: vid.grootte } : {})), x.hid);   // review MOET 3: eerst vastleggen, dan uploaden
    if (vid) { videoGereserveerd -= vid.grootte; vid.overgedragen = true; }   // review ronde 3 ZOU 1: telt vanaf hier via de bezig-rij (één keer)
    const keys = [r2f(x.k, x.fid, 'k'), r2f(x.k, x.fid, 'g')].concat(vid ? [r2f(x.k, x.fid, 'v')] : []);
    await o.r2.put(keys[0], bk.data, bk.mime);
    await o.r2.put(keys[1], bg.data, bg.mime);
    if (vid) await o.r2.put(keys[2], vid.data, 'video/mp4');
    // review wv2938 MOET 1: vlak vóór het zichtbaar maken opnieuw toetsen (huis nog open in deze ronde; een video nog steeds in het album en mag)
    const nogSteeds = wens[x.k].details.has(x.pid) && (!vid || ((await ml.videoBestand(x.asset, { kring: x.k, hid: x.hid })) || {}).stand === 'klaar');
    if (!nogSteeds) { for (const key of keys) await o.r2.del(key).catch(() => {}); return 'overgeslagen'; }
    await d1([{ sql: 'INSERT INTO foto (kring, fid, pid, volg, ratio, mime_k, mime_g, dag) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kring, fid) DO NOTHING', params: [x.k, x.fid, x.pid, x.volg, x.ratio, bk.mime, bg.mime, x.dag || null] }]
      .concat(vid ? [{ sql: 'INSERT INTO video (kring, fid, pid, mime, grootte) VALUES (?, ?, ?, ?, ?) ON CONFLICT (kring, fid) DO UPDATE SET grootte = excluded.grootte', params: [x.k, x.fid, x.pid, 'video/mp4', vid.grootte] }] : []));
    q.objZet.run(x.k, 'f:' + x.fid, JSON.stringify(Object.assign({ pid: x.pid, volg: x.volg, ratio: x.ratio, mk: bk.mime, mg: bg.mime }, x.dag ? { dag: x.dag } : {}, vid ? { v: vid.grootte } : {})), x.hid);
    if (vid) videoTel.ok++;
    return 'ok';
  }
  const fotoTel = { ok: 0, geen: 0, fout: 0 };
  const videoTel = { ok: 0, wacht: 0, budget: 0, niet: 0 };
  let videoGereserveerd = 0;
  const budget = o.videoBudget || VIDEO_BUDGET;   // (toets: kleiner)
  // wv2938: bytes aan video's die nu buiten staan of onderweg zijn (beide kringen)
  function videoBytes() { let n = 0; for (const k of KRINGEN) for (const r of q.obj.all(k)) if (r.sleutel.startsWith('f:') && r.hash.indexOf('"v":') >= 0) { const x = JSON.parse(r.hash); if (typeof x.v === 'number') n += x.v; } return n; }
  async function uploads() {
    const tot = nu() + FOTO_BUDGET_MS;
    let pogingen = 0, gestopt = false;
    const werker = async () => {
      while (wachtrij.length && nu() < tot && !gestopt && pogingen < FOTO_MAX_TIK) {
        const x = wachtrij.shift(); pogingen++;
        try { const r = await upload(x); if (r === 'ok') fotoTel.ok++; else if (r === 'geen') fotoTel.geen++; }
        catch (e) { fotoTel.fout++; if (!gestopt) fout('mlp-upload', e); gestopt = true; wachtrij.push(x); }   // wv2737: één fout = deze tik stoppen
      }
    };
    await Promise.all(Array.from({ length: FOTO_TEGELIJK }, werker));
  }

  async function logOphalen() {
    const m = (q.logLaatst.get() || {}).m || 0;
    const rijen = (await d1([{ sql: 'SELECT id, pid, kring, huis, op FROM log WHERE id > ? ORDER BY id LIMIT 2000', params: [m] }]))[0].results;
    if (!rijen.length) return 0;
    // huis-id → hid (per kring) uit wat we publiceerden
    const terug = new Map();
    for (const k of KRINGEN) for (const r of q.obj.all(k)) if (r.sleutel.startsWith('h:')) terug.set(k + '|' + r.sleutel.slice(2), r.hid);
    for (const r of rijen) q.logZet.run(r.id, String(r.pid), String(r.kring), r.huis ? terug.get(r.kring + '|' + r.huis) || null : null, iso(Number(r.op) || nu()));
    await d1([{ sql: 'DELETE FROM log WHERE id <= ?', params: [rijen[rijen.length - 1].id] }]);
    q.logWeg.run(iso(nu() - 365 * 24 * 3600000));
    return rijen.length;
  }

  let bezig = false, laatsteRonde = 0, laatsteLog = 0, laatst = null, wijziging = 1, gedaan = 0;   // review MOET 4: teller i.p.v. vlag
  async function tik(dwing) {
    if (bezig) return { bezig: true };
    bezig = true;
    const uit = { op: iso(nu()) };
    try {
      await zorgSchema();
      const nood = stand('noodstop') === '1';
      if (stand('noodstop_d1') !== (nood ? '1' : '0')) {
        await d1([{ sql: 'INSERT INTO stand (sleutel, waarde) VALUES (?, ?) ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde', params: ['noodstop', nood ? '1' : '0'] }]);
        q.standZet.run('noodstop_d1', nood ? '1' : '0');
      }
      uit.bezoekers = await bezoekersSync();
      for (let ronde = 0; ronde < 3 && (dwing || wijziging !== gedaan || nu() - laatsteRonde >= RONDE_MS); ronde++) {
        dwing = false;
        const start = wijziging;
        const nw = {}, tel = {};
        for (const k of KRINGEN) nw[k] = await wensVan(k);
        wens = nw;
        for (const k of KRINGEN) tel[k] = await rondeKring(k, nw[k]);
        const cats = Object.keys(o.categorieen || {}).filter((id) => !o.categorieen[id].gevoelig).map((id) => ({ id, naam: String(o.categorieen[id].naam), gevoelig: false }));
        await d1([{ sql: 'INSERT INTO stand (sleutel, waarde) VALUES (?, ?) ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde', params: ['categorieen', JSON.stringify(cats)] }]);
        await d1(KRINGEN.map((k) => ({ sql: 'INSERT INTO publicatie (kring, versie, geldig_tot) VALUES (?, 1, ?) ON CONFLICT (kring) DO UPDATE SET versie = versie + 1, geldig_tot = excluded.geldig_tot',
          params: [k, nu() + HOUDBAAR_MS] })));
        laatsteRonde = nu(); gedaan = start; uit.ronde = tel;   // kwam er tijdens de ronde een wijziging bij, dan meteen nog een ronde
        q.standZet.run('laatste_ronde', iso(nu()));
        vulWachtrij();
      }
      if (wachtrij.length) await uploads();
      if (nu() - laatsteLog >= LOG_MS) { uit.log = await logOphalen(); laatsteLog = nu(); }
      uit.wachtrij = wachtrij.length;
    } catch (e) { fout('mlp-tik', e); uit.fout = String(e && e.message || e).replace(/[^\w .:-]/g, '').slice(0, 80); }
    finally { bezig = false; laatst = uit; }
    return uit;
  }

  // ── voor de app ──
  function noodstop(aan) { q.standZet.run('noodstop', aan ? '1' : '0'); wijziging++; return info(); }
  function info() {
    const b = MLD.bezoekersLees(o.vault, o.vv);
    const per = q.logPer.all();
    const tel = {};
    for (const k of KRINGEN) {
      const r = q.obj.all(k);
      tel[k] = { huizen: r.filter((x) => x.sleutel.startsWith('h:')).length, open: r.filter((x) => x.sleutel.startsWith('d:')).length,
        fotos: r.filter((x) => x.sleutel.startsWith('f:')).length, fotos_wens: wens && wens[k] ? wens[k].fotos.size : null };
    }
    // bezoekers met hun laatste bezoek (namen uit de vaultlijst, alleen voor Davids app)
    const bezoekers = b.rijen.map((r) => { const pid = persoonVan(r.naam), l = per.filter((x) => x.pid === pid);
      return { naam: r.naam, kring: r.kring, adressen: r.mails.length, bezoeken: l.reduce((n, x) => n + x.n, 0), laatst: l.reduce((m, x) => (x.laatst > m ? x.laatst : m), '') || null }; });
    return { lijst_status: b.status, bezoekers, noodstop: stand('noodstop') === '1', laatste_ronde: stand('laatste_ronde'), wachtrij: wachtrij.length, tel, foto_tel: fotoTel,
      laatst: laatst ? { op: laatst.op, fout: laatst.fout || null } : null };
  }
  // per hid: wie (naam) hem bekeek en wanneer het laatst (alleen Davids app)
  function gezien() {
    const b = MLD.bezoekersLees(o.vault, o.vv), naam = new Map(b.rijen.map((r) => [persoonVan(r.naam), r.naam]));
    const uit = {};
    for (const r of q.logHid.all()) { (uit[r.hid] = uit[r.hid] || []).push({ naam: naam.get(r.pid) || 'onbekend', laatst: r.laatst }); }
    return uit;
  }
  function health() { return { aan: true, laatste_ronde: stand('laatste_ronde'), wachtrij: wachtrij.length, bezoekers: Number(stand('bezoekers_n') || 0), noodstop: stand('noodstop') === '1', fout: laatst && laatst.fout ? true : false, fotos: fotoTel,
    video: Object.assign({ kan: videoKan, mb_buiten: Math.round(videoBytes() / 1e6), budget_mb: Math.round(budget / 1e6) }, videoTel) }; }
  function markeerVuil() { wijziging++; }
  return { tik, info, gezien, noodstop, health, markeerVuil, _pidVan: pidVan, _fidVan: fidVan, _persoonVan: persoonVan, _dichtItem: dichtItem, _wens: () => wens };
}

module.exports = { maak, strip, stripJpeg, stripWebp, lijstItem, detailItem, adresHash, LIJST_VELDEN, DETAIL_VELDEN, D1_SCHEMA, KRINGEN, FOTO_MAX_TIK, VIDEO_BUDGET };
