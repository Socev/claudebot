'use strict';
/*
 * MemoryLane stap R1 — herinneringen inspreken (wv1969, 30-10-2026). Ontwerp in de vault:
 * "01_Ontwikkeling/Second Brain 2.0 - fase R rambles en herinneringen (ontwerp 29-10-2026).md" § 3.1–3.4 en § 6; Opus-review vooraf
 * GO-met-wijzigingen (verwerkt), Davids Ja 30-10 08:21 met zijn Anders van 29-10 14:40 (herinneringen zijn vindbaar en te koppelen, elke
 * notitie draagt een zichtbare privé-markering).
 *
 * WAAROM. David wil persoonlijke herinneringen hardop vertellen (tot een uur) en ze bewaren: de stem, het letterlijke transcript en later
 * (R2) het verhaal. De app neemt op in stukken van 60 s (WAV 16 kHz mono 16 bit) en stuurt ze één voor één; dit bestand vangt ze op.
 *
 * STROOM.
 *  1. ontvangStuk(id, n, wav): sleutel (ramble_id, n). Zelfde sha256 opnieuw = 200 (dubbel, niets nieuws); andere sha256 = 409 + spoorregel,
 *     nooit overschrijven. Opvang in <dir>/staging/<ramble_id>/<n>.wav (map 0700, bestand 0600, tmp + rename). Grenzen: 2,5 MB per stuk,
 *     90 stukken per opname, 6 nieuwe opnames per dag (Amsterdamse dag).
 *  2. ontvangKlaar(id, manifest): aantal + sha256 per stuk. Pas als elk stuk er is en klopt, verhuist de opname naar het audio-archief
 *     <dir>/audio/<ramble_id>/ (stukken + manifest.txt). Ontbreekt er iets: 202 met de gaten; de app stuurt na. Een stuk dat afwijkt van
 *     het manifest = 409. Na 7 dagen: met manifest maar niet compleet → 'onvolledig' (gaten zichtbaar in het transcript); zonder manifest →
 *     opgeruimd (staging weg, één box-rij zonder inhoud).
 *  3. tik(): uitschrijven per stuk met Whisper (o.whisper, Cloudflare Workers AI), 3 pogingen per stuk; plafond 120 min per dag: wat erboven
 *     zit wacht tot de volgende dag (niets verloren). Een stuk dat na 3 pogingen niet lukt, staat als "[mm:ss–mm:ss niet uitgeschreven]" in
 *     het transcript; de WAV blijft in het archief (later opnieuw uit te schrijven).
 *  4. Transcript (markdown met tijdcodes) + manifest.txt worden één Intake-stuk ramble@1 (alleen intern, strikt_prive, bewaren tot_keuze).
 *     De vingerafdruk van de opname = sha256 van manifest.txt (het onderdeel 'origineel'); dat is ook de versie in de Supabase-spiegel.
 *     De audio gaat NIET door Intake (te groot, en audio maakt een stuk onleesbaar voor de marker).
 *  5. De patiëntmarker (patientpoort-2.0) draait in Intake op het transcript. 'geen' → opnamenotitie in de vault
 *     (20_Prive/Herinneringen/Opnames/<JJJJ-MM-DD>_<stuk_id>.md, frontmatter gevoelig: prive + zichtbare regel "Privé — persoonlijke
 *     herinnering"), via vault-veilig, niet tijdens onderhoud of de nachtgrendel. Raak → alles blijft op de pod, geen notitie, één Voor
 *     jou-kaart zonder inhoud (Ja = doorlaten, Nee = vasthouden).
 *  6. Offsite: alleen opnames met marker 'geen' of doorgelaten; rclone copy --ignore-existing naar vaultcrypt:herinneringen-audio/ (alleen
 *     toevoegen, namen en inhoud versleuteld) + cryptcheck --one-way, hooguit één ronde per uur. Proef- en markeropnames nooit.
 *
 * PRIVACY. Nooit transcripttekst, titels of namen in logs, box-rijen, kaarten of /health: alleen ramble_id, stuk_id, aantallen en seconden.
 * VORM. Alleen fs, path, crypto en child_process; Intake, Whisper, vault-veilig, kaarten en box komen van server.js via maak({...}).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MB = 1024 * 1024;
const ID_RE = /^r[0-9]{8}-[0-9a-f]{16}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const STUK_MAX_BYTES = Math.floor(2.5 * MB), STUKKEN_MAX = 90, PER_DAG = 6;
const PLAFOND_S = 120 * 60;                 // uitschrijven per Amsterdamse dag
const POGINGEN = 3, POGING_PAUZE_MS = 10 * 60000;
const OUD_MS = 7 * 86400000;                // staging zonder klaar / onvolledig
const TIK_MAX_MS = 120000;                  // zo lang schrijft één tik hooguit uit
const OFFSITE_PAUZE_MS = 3600000;
const KAART_BEWAAR_MS = 14 * 86400000;
const VERTELLER_RE = /^[\p{L}][\p{L} .'-]{0,59}$/u;
const NOTITIE_MAP = '20_Prive/Herinneringen/Opnames';
const PROFIEL = 'ramble@1', BRON = 'app:ramble';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ramble (ramble_id TEXT PRIMARY KEY, dag TEXT NOT NULL, aangemaakt TEXT NOT NULL, laatst TEXT NOT NULL,
  status TEXT NOT NULL, apparaat TEXT, aantal INTEGER, manifest TEXT, opgenomen_op TEXT, verteller TEXT, route TEXT NOT NULL DEFAULT 'app',
  duur_s REAL, vingerafdruk TEXT, onvolledig INTEGER NOT NULL DEFAULT 0, archief_op TEXT, wacht_plafond TEXT, stuk_id TEXT, marker TEXT,
  kaart TEXT, kaart_op TEXT, keuze TEXT, keuze_op TEXT, notitie TEXT, notitie_op TEXT, offsite_ok INTEGER NOT NULL DEFAULT 0, offsite_op TEXT,
  gemeld TEXT, proef INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS ramble_kaart ON ramble (kaart);
CREATE TABLE IF NOT EXISTS ramble_stuk (ramble_id TEXT NOT NULL, n INTEGER NOT NULL, sha256 TEXT NOT NULL, grootte INTEGER NOT NULL,
  seconden REAL NOT NULL, binnen TEXT NOT NULL, uitgeschreven TEXT, pogingen INTEGER NOT NULL DEFAULT 0, poging_op TEXT, PRIMARY KEY (ramble_id, n));
CREATE TABLE IF NOT EXISTS ramble_dag (dag TEXT PRIMARY KEY, seconden REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ramble_spoor (id INTEGER PRIMARY KEY, tijd TEXT NOT NULL, ramble_id TEXT, n INTEGER, soort TEXT NOT NULL);
`;

function iso(ms) { return new Date(ms).toISOString(); }
function amsDelen(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { datum: p.year + '-' + p.month + '-' + p.day, dmj: p.day + '-' + p.month + '-' + p.year, dm: Number(p.day) + '-' + Number(p.month),
    klok: (p.hour === '24' ? '00' : p.hour) + ':' + p.minute };
}
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
// mm:ss, boven het uur h:mm:ss
function tijdcode(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(x).padStart(2, '0');
  return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
}
// Seconden spraak in een WAV zoals de app hem maakt (PCM 16 bit, mono, 16 kHz, kop van 44 bytes); anders null (gelijk aan appWavSeconden).
function wavSeconden(b) {
  if (!Buffer.isBuffer(b) || b.length < 46 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 16) !== 'WAVEfmt ' || b.toString('ascii', 36, 40) !== 'data') return null;
  if (b.readUInt16LE(20) !== 1 || b.readUInt16LE(22) !== 1 || b.readUInt32LE(24) !== 16000 || b.readUInt16LE(34) !== 16) return null;
  const n = b.readUInt32LE(40);
  if (n !== b.length - 44 || n % 2) return null;
  return n / 32000;
}
// De ruwe body van één stuk lezen (Content-Length al getoetst). → Promise<{ buf, hash } | { fout, status }>; een afgebroken of te lange
// stroom levert niets op (er komt dan ook niets in de opvangmap).
function leesStuk(req, lengte) {
  return new Promise(function (klaar) {
    let delen = [], n = 0, af = false;
    const h = crypto.createHash('sha256');
    const mis = function (st, f) { if (af) return; af = true; delen = []; try { req.resume(); } catch (e) { /* weg */ } klaar({ status: st, fout: f }); };
    req.on('aborted', function () { mis(400, 'upload afgebroken'); });
    req.on('error', function () { mis(400, 'upload afgebroken'); });
    req.on('data', function (c) {
      if (af) return;
      n += c.length;
      if (n > lengte) return mis(400, 'upload onvolledig');
      h.update(c); delen.push(c);
    });
    req.on('end', function () {
      if (af) return;
      af = true;
      if (n !== lengte) return klaar({ status: 400, fout: 'upload onvolledig' });
      const buf = Buffer.concat(delen, n); delen = [];
      klaar({ buf, hash: h });
    });
  });
}
// Eén regel tekst uit Whisper: geen regeleinden of stuurtekens (de notitie is markdown met één regel per stuk).
function schoonTekst(t) { return String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function yamlTekst(s) { return JSON.stringify(String(s)); }

/*
 * maak(o) → { ontvangStuk, ontvangKlaar, tik, knop, info, offsiteLijst, _db }.
 * o = { dir (/opt/data/herinneringen), intake (intake-ingang maak(): leverIntern, markeer, vrijgeven, _db), vault, vv (vault-veilig),
 *       whisper(wav) → Promise<tekst>, kanUitschrijven() → bool, onderhoudAan() → bool, nachtgrendel() → bool,
 *       kaartZet(p) → Promise, kaartLijst() → Promise<{sleutel: status}>, box(tekst), fout(label, e), nu() → ms,
 *       rclone ('rclone'), remote ('vaultcrypt:herinneringen-audio'), offsiteAan() → bool, primair() → bool }
 */
function maak(o) {
  const nu = typeof o.nu === 'function' ? o.nu : Date.now;
  const db = o.intake._db;
  db.exec(SCHEMA_SQL);
  const DIR = o.dir, STAGING = path.join(DIR, 'staging'), AUDIO = path.join(DIR, 'audio'), UIT = path.join(DIR, 'uit');
  for (const d of [DIR, STAGING, AUDIO]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch (e) { /* niet van ons */ } }
  const rcBin = o.rclone || 'rclone', remote = o.remote || 'vaultcrypt:herinneringen-audio';
  const fout = (l, e) => { if (o.fout) o.fout(l, e); };
  let bezig = false, laatst = null, offsiteLaatst = null, offsiteOp = 0, plafondDag = '', dienstPauzeTot = 0;

  const q = {
    rij: db.prepare('SELECT * FROM ramble WHERE ramble_id = ?'),
    perKaart: db.prepare('SELECT * FROM ramble WHERE kaart = ?'),
    nieuw: db.prepare("INSERT INTO ramble (ramble_id, dag, aangemaakt, laatst, status, apparaat, proef) VALUES (?, ?, ?, ?, 'staging', ?, ?)"),
    perDag: db.prepare('SELECT count(*) n FROM ramble WHERE dag = ?'),
    laatst: db.prepare('UPDATE ramble SET laatst = ? WHERE ramble_id = ?'),
    status: db.prepare('UPDATE ramble SET status = ? WHERE ramble_id = ?'),
    manifest: db.prepare("UPDATE ramble SET aantal = ?, manifest = ?, opgenomen_op = ?, verteller = ?, status = CASE WHEN status = 'staging' THEN 'wacht' ELSE status END, laatst = ? WHERE ramble_id = ?"),
    archief: db.prepare("UPDATE ramble SET status = 'archief', archief_op = ?, vingerafdruk = ?, duur_s = ?, onvolledig = ? WHERE ramble_id = ?"),
    stuk: db.prepare('SELECT * FROM ramble_stuk WHERE ramble_id = ? AND n = ?'),
    stukken: db.prepare('SELECT * FROM ramble_stuk WHERE ramble_id = ? ORDER BY n'),
    stukNieuw: db.prepare('INSERT INTO ramble_stuk (ramble_id, n, sha256, grootte, seconden, binnen) VALUES (?, ?, ?, ?, ?, ?)'),
    // de tekst zelf staat NOOIT in de databank (intake.sqlite gaat elke nacht in de podstaat-bundel; Opus-review wv1969 MOET 1), alleen in
    // audio/<id>/<n>.txt (0600), naast de WAV; die map gaat niet in de bundel en het offsite-patroon neemt alleen .wav en manifest.txt
    tekst: db.prepare('UPDATE ramble_stuk SET uitgeschreven = ?, pogingen = pogingen + 1, poging_op = ? WHERE ramble_id = ? AND n = ?'),
    poging: db.prepare('UPDATE ramble_stuk SET pogingen = pogingen + 1, poging_op = ? WHERE ramble_id = ? AND n = ?'),
    spoor: db.prepare('INSERT INTO ramble_spoor (tijd, ramble_id, n, soort) VALUES (?, ?, ?, ?)'),
    dag: db.prepare('SELECT seconden FROM ramble_dag WHERE dag = ?'),
    dagBij: db.prepare('INSERT INTO ramble_dag (dag, seconden) VALUES (?, ?) ON CONFLICT (dag) DO UPDATE SET seconden = seconden + excluded.seconden'),
    perStatus: db.prepare('SELECT * FROM ramble WHERE status = ? ORDER BY aangemaakt, ramble_id'),
    intake: db.prepare("UPDATE ramble SET status = 'intake', stuk_id = ? WHERE ramble_id = ?"),
    // status 'verwijderd' (wv2069): de verwijderroute (intake-verwijder.js) zet de rij dicht vóór het wissen; een tik die al liep, schrijft
    // daarna niets meer terug (marker, kaart, keuze, notitie)
    marker: db.prepare("UPDATE ramble SET marker = ? WHERE ramble_id = ? AND status <> 'verwijderd'"),
    kaart: db.prepare("UPDATE ramble SET status = 'vastgehouden', kaart = ?, kaart_op = ? WHERE ramble_id = ? AND status <> 'verwijderd'"),
    keuze: db.prepare("UPDATE ramble SET keuze = ?, keuze_op = ? WHERE ramble_id = ? AND status <> 'verwijderd'"),
    notitie: db.prepare("UPDATE ramble SET status = 'notitie', notitie = ?, notitie_op = ?, offsite_ok = CASE WHEN proef = 1 THEN 0 ELSE 1 END WHERE ramble_id = ? AND status <> 'verwijderd'"),
    gemeld: db.prepare('UPDATE ramble SET gemeld = ? WHERE ramble_id = ?'),
    wachtPlafond: db.prepare('UPDATE ramble SET wacht_plafond = ? WHERE ramble_id = ?'),
    offsiteKlaar: db.prepare('UPDATE ramble SET offsite_op = ? WHERE ramble_id = ? AND offsite_ok = 1'),
  };
  function tx(f) { db.exec('BEGIN IMMEDIATE'); try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { /* al weg */ } throw e; } }
  function aan() { return !fs.existsSync(UIT); }
  const spoorDag = new Map();
  function spoorEens(id, soort) {
    const k = id + '|' + soort, dag = amsDelen(nu()).datum;
    if (spoorDag.get(k) === dag) return;
    spoorDag.set(k, dag);
    spoor(id, null, soort);
  }
  function spoor(id, n, soort) { try { q.spoor.run(iso(nu()), id, n == null ? null : n, soort); } catch (e) { fout('ramble-spoor', e); } }
  function stagingMap(id) { return path.join(STAGING, id); }
  function audioMap(id) { return path.join(AUDIO, id); }
  function mapVan(r) { return r.status === 'staging' || r.status === 'wacht' ? stagingMap(r.ramble_id) : audioMap(r.ramble_id); }
  function box(titel, regels) {
    if (!o.box) return;
    const t = amsDelen(nu());
    try { o.box('\n## [log] ' + t.datum + ' ' + t.klok + ' — MemoryLane: ' + titel + ' (automatisch, wv1969)\n- status: open\n- van: pod:herinneringen\n' + regels.map((r) => '- ' + r + '\n').join('')); }
    catch (e) { fout('ramble-box', e); }
  }
  function schrijfAtomair(map, naam, buf) {
    const tmp = path.join(map, '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, path.join(map, naam));
  }
  // Nummers die de pod nog verwacht. Een null in het manifest = de app verloor dat stuk zelf (bv. niet te bewaren op de telefoon); dan
  // wacht de pod er niet op en wordt de opname 'onvolledig' met dat gat zichtbaar (Opus-review ZOU 4).
  function ontbreekt(r) {
    const binnen = new Set(q.stukken.all(r.ramble_id).map((s) => s.n));
    const ml = manifestLijst(r) || [];
    const uit = [];
    for (let n = 1; n <= (r.aantal || 0); n++) if (!binnen.has(n) && ml[n - 1] !== null) uit.push(n);
    return uit;
  }
  function manifestLijst(r) { try { const l = JSON.parse(r.manifest || 'null'); return Array.isArray(l) ? l : null; } catch (e) { return null; } }

  // Het manifest als tekst (onderdeel 'origineel' in Intake); sha256 hiervan = vingerafdruk van de opname. Alleen nummers, hashes, bytes.
  function manifestTekst(r, stukken) {
    const per = new Map(stukken.map((s) => [s.n, s]));
    const regels = ['ovis-ramble-manifest/1', 'ramble_id: ' + r.ramble_id, 'stukken: ' + r.aantal];
    for (let n = 1; n <= r.aantal; n++) { const s = per.get(n); regels.push(s ? n + ' ' + s.sha256 + ' ' + s.grootte : n + ' ontbreekt'); }
    return Buffer.from(regels.join('\n') + '\n', 'utf8');
  }

  // Compleet (of onvolledig na 7 dagen): staging → audio-archief, manifest.txt, vingerafdruk. In één transactie met de status.
  function naarArchief(id, onvolledig) {
    const r = q.rij.get(id);
    if (!r || (r.status !== 'wacht' && r.status !== 'staging')) return false;
    const stukken = q.stukken.all(id);
    if (!r.aantal) return false;
    const onv = onvolledig || stukken.length < r.aantal;
    const duur = stukken.reduce((t, s) => t + s.seconden, 0);
    // na een crash tussen het hernoemen en de databankregel (Opus-review KAN 6): staging weg, archief met manifest er wel → alleen de regel
    if (!fs.existsSync(stagingMap(id)) && fs.existsSync(path.join(audioMap(id), 'manifest.txt'))) {
      const mt0 = fs.readFileSync(path.join(audioMap(id), 'manifest.txt'));
      q.archief.run(iso(nu()), sha256(mt0), Math.round(duur * 10) / 10, onv ? 1 : 0, id);
      spoor(id, null, 'archief_hersteld');
      return true;
    }
    const mt = manifestTekst(r, stukken);
    const vinger = sha256(mt);
    fs.mkdirSync(stagingMap(id), { recursive: true, mode: 0o700 });
    schrijfAtomair(stagingMap(id), 'manifest.txt', mt);
    if (fs.existsSync(audioMap(id))) throw new Error('archiefmap bestaat al');
    fs.renameSync(stagingMap(id), audioMap(id));
    q.archief.run(iso(nu()), vinger, Math.round(duur * 10) / 10, onv ? 1 : 0, id);
    spoor(id, null, onv ? 'onvolledig' : 'compleet');
    return true;
  }

  /*
   * Eén stuk van de app. → { status, body } (body zonder inhoud). wav = Buffer (de pod mat de lengte en de getekende inhoudshash al).
   */
  function ontvangStuk(id, n, wav, x) {
    x = x || {};
    if (!aan()) return { status: 503, body: { ok: false, fout: 'herinneringen inspreken staat nu uit' } };
    if (!ID_RE.test(String(id))) return { status: 400, body: { ok: false, fout: 'ongeldige opname' } };
    if (!Number.isInteger(n) || n < 1 || n > STUKKEN_MAX) return { status: 400, body: { ok: false, fout: 'ongeldig stuknummer (1–' + STUKKEN_MAX + ')' } };
    if (!Buffer.isBuffer(wav) || wav.length > STUK_MAX_BYTES) return { status: 413, body: { ok: false, fout: 'stuk te groot' } };
    const sec = wavSeconden(wav);
    if (sec === null) return { status: 400, body: { ok: false, fout: 'geen geldige opname (WAV 16 kHz mono)' } };
    const sha = sha256(wav), t = iso(nu());
    let r = q.rij.get(id);
    const oud = r ? q.stuk.get(id, n) : null;
    if (oud) {
      if (r.status === 'weggegooid') return { status: 409, body: { ok: false, fout: 'deze opname is weggegooid', conflict: true } };
      if (oud.sha256 === sha) { q.laatst.run(t, id); return { status: 200, body: { ok: true, n, sha256: sha, dubbel: true, compleet: r.status !== 'staging' && r.status !== 'wacht' } }; }
      spoor(id, n, 'conflict');
      return { status: 409, body: { ok: false, fout: 'stuk ' + n + ' is al binnen met andere inhoud', conflict: true } };
    }
    if (r && r.status !== 'staging' && r.status !== 'wacht') { spoor(id, n, 'na_afsluiten'); return { status: 409, body: { ok: false, fout: 'deze opname is al afgesloten', conflict: true } }; }
    if (r && r.aantal && n > r.aantal) { spoor(id, n, 'buiten_manifest'); return { status: 409, body: { ok: false, fout: 'stuk ' + n + ' valt buiten de opname (' + r.aantal + ' stukken)', conflict: true } }; }
    const ml = r ? manifestLijst(r) : null;
    if (ml && ml[n - 1] !== null && ml[n - 1] !== sha) { spoor(id, n, 'wijkt_af_van_manifest'); return { status: 409, body: { ok: false, fout: 'stuk ' + n + ' wijkt af van het manifest', conflict: true } }; }
    if (!r) {
      const dag = amsDelen(nu()).datum;
      if (q.perDag.get(dag).n >= PER_DAG) return { status: 429, body: { ok: false, fout: 'vandaag al ' + PER_DAG + ' herinneringen ingesproken; morgen weer' } };
      q.nieuw.run(id, dag, t, t, x.apparaat || null, x.proef ? 1 : 0);
      r = q.rij.get(id);
    }
    const map = stagingMap(id);
    fs.mkdirSync(map, { recursive: true, mode: 0o700 });
    schrijfAtomair(map, n + '.wav', wav);
    q.stukNieuw.run(id, n, sha, wav.length, Math.round(sec * 1000) / 1000, t);
    q.laatst.run(t, id);
    let compleet = false;
    if (r.status === 'wacht' && !ontbreekt(q.rij.get(id)).length) compleet = naarArchief(id, false);
    return { status: 200, body: { ok: true, n, sha256: sha, compleet } };
  }

  /*
   * 'klaar' met het manifest: { aantal, sha256: [...], opgenomen_op, verteller? }. 200 = compleet, 202 = wacht op stukken (ontbreekt),
   * 409 = afwijking. Herhalen mag (zelfde manifest = zelfde antwoord).
   */
  function ontvangKlaar(id, d, x) {
    x = x || {};
    if (!aan()) return { status: 503, body: { ok: false, fout: 'herinneringen inspreken staat nu uit' } };
    if (!ID_RE.test(String(id))) return { status: 400, body: { ok: false, fout: 'ongeldige opname' } };
    d = d && typeof d === 'object' ? d : {};
    const aantal = d.aantal, lijst = d.sha256;
    if (!Number.isInteger(aantal) || aantal < 1 || aantal > STUKKEN_MAX) return { status: 400, body: { ok: false, fout: 'ongeldig aantal stukken' } };
    if (!Array.isArray(lijst) || lijst.length !== aantal || !lijst.every((s) => s === null || (typeof s === 'string' && SHA_RE.test(s))) || !lijst.some((s) => s !== null)) return { status: 400, body: { ok: false, fout: 'ongeldig manifest' } };
    const op = typeof d.opgenomen_op === 'string' && !isNaN(Date.parse(d.opgenomen_op)) && /^\d{4}-\d{2}-\d{2}T/.test(d.opgenomen_op) ? new Date(Date.parse(d.opgenomen_op)).toISOString() : null;
    if (!op) return { status: 400, body: { ok: false, fout: 'opnametijd ontbreekt' } };
    const verteller = d.verteller == null || d.verteller === '' ? 'David' : String(d.verteller).trim();
    if (!VERTELLER_RE.test(verteller)) return { status: 400, body: { ok: false, fout: 'ongeldige verteller' } };
    const manifest = JSON.stringify(lijst), t = iso(nu());
    let r = q.rij.get(id);
    if (r && r.manifest) {
      if (r.manifest !== manifest) { spoor(id, null, 'ander_manifest'); return { status: 409, body: { ok: false, fout: 'deze opname heeft al een ander manifest', conflict: true } }; }
    } else if (r && r.status !== 'staging') return { status: 409, body: { ok: false, fout: r.status === 'weggegooid' ? 'deze opname is weggegooid' : 'deze opname is al afgesloten', conflict: true } };
    if (!r) {
      const dag = amsDelen(nu()).datum;
      if (q.perDag.get(dag).n >= PER_DAG) return { status: 429, body: { ok: false, fout: 'vandaag al ' + PER_DAG + ' herinneringen ingesproken; morgen weer' } };
      q.nieuw.run(id, dag, t, t, x.apparaat || null, x.proef ? 1 : 0);
      r = q.rij.get(id);
    }
    if (!r.manifest) {
      const stukken = q.stukken.all(id);
      const buiten = stukken.filter((s) => s.n > aantal).map((s) => s.n);
      if (buiten.length) { spoor(id, null, 'buiten_manifest'); return { status: 409, body: { ok: false, fout: 'stuk ' + buiten.join(', ') + ' valt buiten het manifest', conflict: true } }; }
      const anders = stukken.filter((s) => lijst[s.n - 1] !== null && s.sha256 !== lijst[s.n - 1]).map((s) => s.n);
      if (anders.length) { spoor(id, null, 'wijkt_af_van_manifest'); return { status: 409, body: { ok: false, fout: 'stuk ' + anders.join(', ') + ' wijkt af van het manifest', conflict: true } }; }
      q.manifest.run(aantal, manifest, op, verteller, t, id);
      r = q.rij.get(id);
    }
    if (r.status !== 'staging' && r.status !== 'wacht') return { status: 200, body: { ok: true, compleet: true, al: true } };
    const mis = ontbreekt(r);
    if (mis.length) return { status: 202, body: { ok: true, compleet: false, ontbreekt: mis } };
    naarArchief(id, false);
    return { status: 200, body: { ok: true, compleet: true } };
  }

  // Wat de pod van een opname heeft (de app hervat hiermee na een herstart). Alleen nummers en hashes.
  function stand(id) {
    if (!ID_RE.test(String(id))) return { status: 400, body: { ok: false, fout: 'ongeldige opname' } };
    const r = q.rij.get(id);
    if (!r) return { status: 200, body: { ok: true, bekend: false, stukken: [] } };
    return { status: 200, body: { ok: true, bekend: true, weggegooid: r.status === 'weggegooid' || undefined, compleet: r.status !== 'staging' && r.status !== 'wacht' && r.status !== 'weggegooid',
      stukken: q.stukken.all(id).map((s) => ({ n: s.n, sha256: s.sha256 })) } };
  }

  // Weggooien vanuit de app (David drukt Weggooien tijdens of na de opname): alleen zolang hij niet afgesloten is. Staging weg, regel blijft
  // als 'weggegooid' (zodat een late upload niet opnieuw begint).
  function weg(id) {
    if (!ID_RE.test(String(id))) return { status: 400, body: { ok: false, fout: 'ongeldige opname' } };
    const r = q.rij.get(id);
    if (!r) {
      const t = iso(nu());
      q.nieuw.run(id, amsDelen(nu()).datum, t, t, null, 0);
      q.status.run('weggegooid', id);
      return { status: 200, body: { ok: true, weggegooid: true } };
    }
    if (r.status === 'weggegooid') return { status: 200, body: { ok: true, weggegooid: true, al: true } };
    if (r.status !== 'staging' && r.status !== 'wacht') return { status: 409, body: { ok: false, fout: 'deze opname is al afgesloten; wissen gaat via de machinekamer', conflict: true } };
    try { fs.rmSync(stagingMap(id), { recursive: true, force: true }); } catch (e) { fout('ramble-weg', e); return { status: 503, body: { ok: false, fout: 'wissen lukte nu niet' } }; }
    q.status.run('weggegooid', id);
    spoor(id, null, 'weggegooid');
    return { status: 200, body: { ok: true, weggegooid: true } };
  }

  // ── tik ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  function opruimen(uit) {
    const grens = iso(nu() - OUD_MS);
    // Zonder "klaar" na 7 dagen: NIET wissen (de telefoon wiste elk stuk al na de bevestiging; dit is de enige kopie), maar als onvolledig
    // bewaren met aantal = hoogste stuknummer. Weggooien gaat alleen via de app (weg). Afwijking van ontwerp § 3.1 na Opus-review ZOU 4.
    for (const r of q.perStatus.all('staging')) {
      if (r.laatst >= grens) continue;
      const st = q.stukken.all(r.ramble_id);
      if (!st.length) { try { fs.rmSync(stagingMap(r.ramble_id), { recursive: true, force: true }); } catch (e) { /* leeg */ } q.status.run('opgeruimd', r.ramble_id); continue; }
      db.prepare('UPDATE ramble SET aantal = ?, opgenomen_op = coalesce(opgenomen_op, aangemaakt) WHERE ramble_id = ?').run(Math.max.apply(null, st.map((x) => x.n)), r.ramble_id);
      try { if (naarArchief(r.ramble_id, true)) uit.onvolledig = (uit.onvolledig || 0) + 1; } catch (e) { fout('ramble-onvolledig', e); continue; }
      box('opname zonder afronding als onvolledig bewaard', ['gemeten: opname ' + r.ramble_id + ' kreeg na 7 dagen geen "klaar" van de app (' + st.length + ' stukken); hij gaat als onvolledige opname door (uitschrijven, marker, notitie).',
        'voorstel: niets, tenzij David hem niet wilde; dan wissen via de machinekamer.']);
    }
    for (const r of q.perStatus.all('wacht')) {
      if (r.laatst >= grens) continue;
      try { if (naarArchief(r.ramble_id, true)) uit.onvolledig = (uit.onvolledig || 0) + 1; } catch (e) { fout('ramble-onvolledig', e); }
    }
  }

  function dienstFout(e) {
    const m = String(e && e.message || '');
    return !!e && (e.name === 'TimeoutError' || e.name === 'AbortError' || e instanceof TypeError || /^Whisper (5\d\d|401|403|408|429)\b/.test(m) || !/^Whisper \d{3}\b/.test(m));
  }
  let dienstGemeld = '';
  function meldDienst() {
    // één box-rij per dag, alleen als er al minstens 6 uur een opname op uitschrijven wacht
    const dag = amsDelen(nu()).datum;
    if (dienstGemeld === dag) return;
    const oud = db.prepare("SELECT min(archief_op) t FROM ramble WHERE status = 'archief'").get();
    if (!oud || !oud.t || nu() - Date.parse(oud.t) < 6 * 3600000) return;
    dienstGemeld = dag;
    box('uitschrijven hapert', ['gemeten: Whisper (Cloudflare Workers AI) geeft al een tijd een storing; ' + db.prepare("SELECT count(*) n FROM ramble WHERE status = 'archief'").get().n + ' opname(s) wachten op uitschrijven (niets verloren, de audio staat in het archief).',
      'voorstel: CLOUDFLARE_AI_TOKEN_AUTO en het Workers AI-tegoed nalopen (ook de microfoonknop in de app gebruikt die dienst).']);
  }
  function dagSeconden(dag) { const x = q.dag.get(dag); return x ? x.seconden : 0; }

  async function uitschrijven(uit, start) {
    if (!o.whisper || (o.kanUitschrijven && !o.kanUitschrijven())) return;
    for (const r of q.perStatus.all('archief')) {
      for (const s of q.stukken.all(r.ramble_id)) {
        if (s.uitgeschreven != null || s.pogingen >= POGINGEN) continue;
        if (nu() < dienstPauzeTot) return;
        if (s.poging_op && nu() - Date.parse(s.poging_op) < POGING_PAUZE_MS) continue;
        if (nu() - start > TIK_MAX_MS) return;
        const dag = amsDelen(nu()).datum;
        if (dagSeconden(dag) + s.seconden > PLAFOND_S) {
          if (!r.wacht_plafond) q.wachtPlafond.run(dag, r.ramble_id);
          if (plafondDag !== dag) { plafondDag = dag; uit.plafond = true; }
          return;
        }
        let wav;
        try { wav = fs.readFileSync(path.join(audioMap(r.ramble_id), s.n + '.wav')); } catch (e) { q.poging.run(iso(nu()), r.ramble_id, s.n); fout('ramble-lezen', e); continue; }
        if (sha256(wav) !== s.sha256) { q.poging.run(iso(nu()), r.ramble_id, s.n); spoor(r.ramble_id, s.n, 'sha_archief_wijkt_af'); continue; }
        try {
          const tekst = schoonTekst(await o.whisper(wav));
          schrijfAtomair(audioMap(r.ramble_id), s.n + '.txt', Buffer.from(tekst, 'utf8'));
          q.tekst.run(iso(nu()), iso(nu()), r.ramble_id, s.n);
          q.dagBij.run(dag, s.seconden);
          uit.uitgeschreven = (uit.uitgeschreven || 0) + 1;
        } catch (e) {
          uit.whisper_fout = (uit.whisper_fout || 0) + 1;
          fout('ramble-whisper', e);
          // ZOU 3 (Opus-review): een storing van de dienst (5xx, 401/403/429, time-out, geen netwerk) telt niet als poging voor dit stuk;
          // dan wacht alles 10 minuten (niets verloren, geen blijvende gaten). Alleen een fout van dit ene stuk telt mee (3 pogingen).
          if (dienstFout(e)) { dienstPauzeTot = nu() + POGING_PAUZE_MS; meldDienst(); return; }
          q.poging.run(iso(nu()), r.ramble_id, s.n);
        }
      }
      if (r.wacht_plafond) q.wachtPlafond.run(null, r.ramble_id);
    }
  }

  // Transcript: één regel per stuk "[mm:ss] tekst"; een stuk dat ontbreekt of niet lukte als "[mm:ss–mm:ss niet uitgeschreven]".
  function stukTekst(id, s) {
    if (s.uitgeschreven == null) return null;
    try { return fs.readFileSync(path.join(audioMap(id), s.n + '.txt'), 'utf8'); } catch (e) { return null; }
  }
  function transcript(r, stukken) {
    const per = new Map(stukken.map((s) => [s.n, Object.assign({}, s, { tekst: stukTekst(r.ramble_id, s) })]));
    const regels = [];
    let t = 0;
    for (let n = 1; n <= r.aantal; n++) {
      const s = per.get(n), d = s ? s.seconden : 60;
      if (!s) regels.push('[' + tijdcode(t) + '–' + tijdcode(t + d) + ' ontbreekt]');
      else if (s.tekst == null) regels.push('[' + tijdcode(t) + '–' + tijdcode(t + d) + ' niet uitgeschreven]');
      else if (!s.tekst) regels.push('[' + tijdcode(t) + '] (stilte)');
      else regels.push('[' + tijdcode(t) + '] ' + s.tekst);
      t += d;
    }
    return regels.join('\n\n') + '\n';
  }

  async function naarIntake(uit) {
    for (const r of q.perStatus.all('archief')) {
      const stukken = q.stukken.all(r.ramble_id);
      if (stukken.some((s) => s.uitgeschreven == null && s.pogingen < POGINGEN)) continue;   // nog bezig
      if (stukken.some((s) => s.uitgeschreven != null && stukTekst(r.ramble_id, s) == null)) { spoorEens(r.ramble_id, 'tekstbestand_weg'); continue; }
      const tr = Buffer.from(transcript(r, stukken), 'utf8');
      let mt;
      try { mt = fs.readFileSync(path.join(audioMap(r.ramble_id), 'manifest.txt')); } catch (e) { fout('ramble-manifest', e); continue; }
      if (sha256(mt) !== r.vingerafdruk) { spoorEens(r.ramble_id, 'manifest_wijkt_af'); continue; }
      const meta = { manifest_sha256: r.vingerafdruk, duur_s: Math.round(r.duur_s || 0), verteller: r.verteller || 'David', route: r.route || 'app',
        opgenomen_op: r.opgenomen_op || r.aangemaakt, stukken: r.aantal, onvolledig: !!r.onvolledig };
      if (r.proef) meta.proef = 'proefopname.invalid';
      const env = { protocol: 'ovis-intake/1', profiel: PROFIEL, bron: BRON, bron_id: r.ramble_id, ontvangen: r.archief_op || iso(nu()), meta,
        onderdelen: [{ deel: 't1', rol: 'hoofdtekst', naam: 'Transcript ' + r.ramble_id + '.md', mime: 'text/markdown', grootte: tr.length, sha256: sha256(tr) },
          { deel: 'm1', rol: 'origineel', naam: 'Manifest ' + r.ramble_id + '.txt', mime: 'text/plain', grootte: mt.length, sha256: r.vingerafdruk }],
        aanlevering: { workflow: 'pod:herinneringen', knoop: 'herinneringen.js' } };
      let res;
      try { res = await o.intake.leverIntern('ramble', env, { t1: tr, m1: mt }); } catch (e) { fout('ramble-intake', e); uit.intake_fout = (uit.intake_fout || 0) + 1; continue; }
      if (res && res.ok && Array.isArray(res.ontbreekt) && res.ontbreekt.length) res = { ok: false, reden: 'onderdelen_ontbreken' };   // Opus-review ZOU 2
      if (!res || !res.ok || !res.stuk_id) {
        uit.intake_fout = (uit.intake_fout || 0) + 1;
        spoorEens(r.ramble_id, 'intake_' + String(res && res.reden || 'fout').slice(0, 40));
        continue;
      }
      q.intake.run(res.stuk_id, r.ramble_id);
      uit.intake = (uit.intake || 0) + 1;
    }
  }

  function stukRij(stukId) { return db.prepare('SELECT stuk_id, marker_patient, status FROM stuk WHERE stuk_id = ?').get(stukId); }

  // De opnamenotitie (geen AI): frontmatter + privé-regel + het letterlijke transcript.
  function notitieTekst(r, transcriptTekst) {
    const op = Date.parse(r.opgenomen_op || r.aangemaakt), a = amsDelen(op);
    const duur = tijdcode(r.duur_s || 0);
    const fm = ['---', 'type: bron', 'bron_soort: ramble', 'gevoelig: prive', 'access_context: strikt_prive', 'ovis_stuk: ' + r.stuk_id,
      'ramble_id: ' + r.ramble_id, 'opgenomen_op: ' + yamlTekst(r.opgenomen_op || r.aangemaakt), 'duur: ' + yamlTekst(duur), 'duur_s: ' + Math.round(r.duur_s || 0),
      'route: ' + (r.route || 'app'), 'verteller: ' + yamlTekst(r.verteller || 'David'), 'vingerafdruk: ' + r.vingerafdruk, 'onvolledig: ' + (r.onvolledig ? 'true' : 'false'),
      'created: ' + a.datum, 'tags: [herinnering, prive]', '---', ''];
    const kop = '> **Privé — persoonlijke herinnering.** Ingesproken op ' + a.dmj + ' om ' + a.klok + ' (' + duur + ')' +
      (r.verteller && r.verteller !== 'David' ? ', verteld door ' + r.verteller : '') + '. Letterlijk uitgeschreven, niet bewerkt; een herinnering is geen bron voor feiten.' +
      (r.onvolledig ? ' Niet alle stukken kwamen binnen; de gaten staan in de tekst.' : '');
    return fm.join('\n') + kop + '\n\n# Opname ' + a.dmj + ' ' + a.klok + '\n\n' + transcriptTekst;
  }
  function transcriptVanStuk(stukId) {
    const d = db.prepare("SELECT o.sha256 FROM onderdeel o WHERE o.stuk_id = ? AND o.rol = 'hoofdtekst'").get(stukId);
    if (!d) return null;
    const b = o.intake.blobVanSha ? o.intake.blobVanSha(d.sha256) : null;
    return b;
  }
  function schrijfNotitie(r) {
    if (o.onderhoudAan && o.onderhoudAan()) return { wacht: 'onderhoud' };
    if (o.nachtgrendel && o.nachtgrendel()) return { wacht: 'nachtgrendel' };
    const nu_ = q.rij.get(r.ramble_id);
    if (!nu_ || nu_.status === 'verwijderd') return { wacht: 'verwijderd' };   // wv2069: intussen via de verwijderroute weggehaald
    const tr = transcriptVanStuk(r.stuk_id);
    if (tr == null) return { fout: 'transcript_niet_op_de_pod' };
    const a = amsDelen(Date.parse(r.opgenomen_op || r.aangemaakt));
    const rel = path.join(NOTITIE_MAP, a.datum + '_' + r.stuk_id + '.md');
    const mapAbs = path.join(o.vault, NOTITIE_MAP);
    if (!fs.existsSync(mapAbs)) fs.mkdirSync(mapAbs, { recursive: true, mode: 0o770 });
    const inhoud = notitieTekst(r, tr.toString('utf8'));
    let bestaand = null;
    try { bestaand = o.vv.lees(path.join(o.vault, rel), 'utf8'); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
    if (bestaand === null) o.vv.schrijf(path.join(o.vault, rel), inhoud);
    return { pad: rel, bestond: bestaand !== null };
  }

  function kaartVoor(r) {
    const a = amsDelen(Date.parse(r.opgenomen_op || r.aangemaakt));
    const sleutel = 'herinnering-' + sha256(r.ramble_id + '|marker').slice(0, 10);
    const deadline = new Date(nu() + KAART_BEWAAR_MS).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    return { sleutel, soort: 'besluit', waar: 'overal', prive: true, duur_min: 1, volgorde: 30, deadline,
      titel: 'Herinnering van ' + a.dm + ' ' + a.klok + ' raakt de patiëntmarker — doorlaten?',
      waarom: 'Je sprak op ' + a.dmj + ' om ' + a.klok + ' een herinnering in (' + tijdcode(r.duur_s || 0) + '). De patiëntmarker zag in de uitgeschreven tekst iets dat op patiëntgegevens kan lijken. Daarom staat alles alleen op de eigen server: nog geen notitie in de Second Brain en geen back-up buiten de server.',
      meting: 'Marker: ' + (r.marker === 'gemarkeerd' ? 'mogelijk patiëntgegevens' : 'tekst niet te lezen') + '. Niemand heeft de tekst gelezen; Socev krijgt hem niet.',
      stappen: ['Ja: doorlaten — de opname wordt een gewone privé-herinnering in de Second Brain en gaat versleuteld in de back-up.',
        'Nee: vasthouden — tekst en opname blijven alleen op de eigen server; er komt niets in de Second Brain.',
        'Anders: typ wat er moet gebeuren; de machinekamer pakt het op.'],
      herkomst: { handmatig: 'herinneringen', stuk: r.stuk_id } };
  }

  async function markerEnNotitie(uit) {
    for (const r of q.perStatus.all('intake')) {
      let s = stukRij(r.stuk_id);
      if (!s) { spoorEens(r.ramble_id, 'stuk_weg'); continue; }
      // de marker pas als beide onderdelen echt binnen zijn (anders oordeelt hij over een half stuk; Opus-review ZOU 2)
      const mist = db.prepare('SELECT count(*) n FROM onderdeel WHERE stuk_id = ? AND binnen IS NULL').get(r.stuk_id).n;
      if (mist) { spoorEens(r.ramble_id, 'onderdeel_ontbreekt'); continue; }
      if (!s.marker_patient) { try { await o.intake.markeer(r.stuk_id); } catch (e) { fout('ramble-marker', e); } s = stukRij(r.stuk_id); }
      if (!s || !s.marker_patient) continue;   // volgende tik
      if (r.marker !== s.marker_patient) q.marker.run(s.marker_patient, r.ramble_id);
      if (s.marker_patient === 'geen') {
        let n;
        try { n = schrijfNotitie(q.rij.get(r.ramble_id)); } catch (e) { fout('ramble-notitie', e); uit.notitie_fout = (uit.notitie_fout || 0) + 1; continue; }
        if (n.wacht) { uit.wacht = n.wacht; continue; }
        if (n.fout) { spoorEens(r.ramble_id, n.fout); uit.notitie_fout = (uit.notitie_fout || 0) + 1; continue; }
        q.notitie.run(n.pad, iso(nu()), r.ramble_id);
        try { if (!r.proef && o.intake.vrijgeven) o.intake.vrijgeven(r.stuk_id); } catch (e) { fout('ramble-vrijgeven', e); }
        uit.notities = (uit.notities || 0) + 1;
        continue;
      }
      const p = kaartVoor(q.rij.get(r.ramble_id));
      if (!o.kaartZet) continue;
      try { await o.kaartZet(p); } catch (e) { fout('ramble-kaart', e); uit.kaart_fout = (uit.kaart_fout || 0) + 1; continue; }
      q.kaart.run(p.sleutel, iso(nu()), r.ramble_id);
      uit.kaarten = (uit.kaarten || 0) + 1;
    }
    // doorgelaten: zelfde notitie, daarna offsite
    for (const r of q.perStatus.all('vastgehouden')) {
      if (r.keuze !== 'doorlaten') continue;
      let n;
      try { n = schrijfNotitie(r); } catch (e) { fout('ramble-notitie', e); uit.notitie_fout = (uit.notitie_fout || 0) + 1; continue; }
      if (n.wacht) { uit.wacht = n.wacht; continue; }
      if (n.fout) { spoorEens(r.ramble_id, n.fout); continue; }
      q.notitie.run(n.pad, iso(nu()), r.ramble_id);
      try { if (!r.proef && o.intake.vrijgeven) o.intake.vrijgeven(r.stuk_id); } catch (e) { fout('ramble-vrijgeven', e); }
      uit.notities = (uit.notities || 0) + 1;
    }
  }

  async function kaartenNalopen() {
    if (!o.kaartLijst) return;
    const open = db.prepare("SELECT * FROM ramble WHERE status = 'vastgehouden' AND kaart IS NOT NULL AND keuze IS NULL AND gemeld IS NULL").all();
    if (!open.length) return;
    let st = null;
    try { st = await o.kaartLijst(); } catch (e) { return; }
    if (!st) return;
    const dicht = open.filter((r) => st[r.kaart] !== 'open' && st[r.kaart] !== 'later' && nu() - Date.parse(r.kaart_op) > 3600000);
    for (const r of dicht) q.gemeld.run(iso(nu()), r.ramble_id);
    if (dicht.length) box(dicht.length + ' markerkaart(en) dicht zonder keuze', ['gemeten: kaart(en) ' + dicht.map((r) => r.kaart).join(', ') + ' staan niet meer open; David koos niets. De opnames blijven alleen op de pod (vastgehouden).',
      'voorstel: David opnieuw vragen (kaart heropenen: in intake.sqlite › ramble kaart, kaart_op en gemeld leeg zetten → nieuwe kaart).']);
  }

  // Relatieve paden (<ramble_id>/<bestand>) die offsite mogen: marker geen of doorgelaten, geen proef, nog niet offsite (of alles met alles=true).
  function offsiteLijst(alles) {
    const rijen = db.prepare("SELECT ramble_id FROM ramble WHERE offsite_ok = 1 AND proef = 0 AND status = 'notitie'" + (alles ? '' : ' AND offsite_op IS NULL') + ' ORDER BY ramble_id').all();
    const uit = [];
    for (const r of rijen) {
      if (!ID_RE.test(r.ramble_id)) continue;
      let namen = [];
      try { namen = fs.readdirSync(audioMap(r.ramble_id)).filter((n) => /^([1-9][0-9]?\.wav|manifest\.txt)$/.test(n)).sort(); } catch (e) { continue; }
      for (const n of namen) uit.push(r.ramble_id + '/' + n);
    }
    return { rambles: rijen.map((r) => r.ramble_id), paden: uit };
  }
  function rc(args, ms) {
    return new Promise(function (klaar) {
      execFile(rcBin, args, { timeout: ms, maxBuffer: 4 * MB }, function (e, so, se) { klaar({ ok: !e, err: String(se || (e && e.message) || '').slice(0, 300) }); });
    });
  }
  async function offsite(uit, forceer) {
    if (!forceer && (!o.offsiteAan || !o.offsiteAan())) return;
    if (!forceer && nu() - offsiteOp < OFFSITE_PAUZE_MS) return;
    const l = offsiteLijst(false);
    if (!l.paden.length) return;
    offsiteOp = nu();
    const lijst = path.join(DIR, '.offsite-lijst-' + crypto.randomBytes(6).toString('hex'));
    fs.writeFileSync(lijst, l.paden.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    try {
      const c = await rc(['copy', AUDIO, remote, '--files-from', lijst, '--ignore-existing', '--no-traverse', '--transfers', '2', '--retries', '2',
        '--low-level-retries', '5', '--timeout', '5m', '--stats', '0'], 900000);
      if (!c.ok) { offsiteLaatst = { op: iso(nu()), uitkomst: 'FOUT: upload', rambles: l.rambles.length }; return meldOffsite(); }
      const k = await rc(['cryptcheck', AUDIO, remote, '--files-from', lijst, '--one-way'], 900000);
      if (!k.ok) { offsiteLaatst = { op: iso(nu()), uitkomst: 'FOUT: cryptcheck', rambles: l.rambles.length }; return meldOffsite(); }
      const t = iso(nu());
      for (const id of l.rambles) q.offsiteKlaar.run(t, id);
      offsiteLaatst = { op: t, uitkomst: 'ja', rambles: l.rambles.length, bestanden: l.paden.length };
      uit.offsite = l.rambles.length;
    } finally { try { fs.unlinkSync(lijst); } catch (e) { /* weg */ } }
  }
  let offsiteGemeld = '';
  function meldOffsite() {
    const dag = amsDelen(nu()).datum;
    if (offsiteGemeld === dag) return;
    offsiteGemeld = dag;
    box('audio-offsite mislukt', ['gemeten: ' + offsiteLaatst.uitkomst + ' bij ' + offsiteLaatst.rambles + ' opname(s) naar ' + remote + '; de opnames staan veilig op de pod en gaan het volgende uur opnieuw.',
      'voorstel: rclone-log nalopen (vaultcrypt-remote, tegoed Drive); niets aan David tenzij het blijft.']);
  }

  async function tik(opt) {
    opt = opt || {};
    if (bezig) return { bezig: true };
    if (!aan()) return { uit: true };
    if (o.primair && !o.primair()) return { niet_primair: true };
    bezig = true;
    const start = nu(), uit = { t: iso(start) };
    try {
      opruimen(uit);
      await uitschrijven(uit, start);
      await naarIntake(uit);
      await markerEnNotitie(uit);
      await kaartenNalopen();
      await offsite(uit, opt.offsite === true);
    } catch (e) { fout('ramble-tik', e); uit.fout = (uit.fout || 0) + 1; }
    finally { bezig = false; laatst = uit; }
    return uit;
  }

  /*
   * Knop op een markerkaart (appVoorJouKnop). Alleen uit de eigen tabel. Ja = doorlaten, Nee = vasthouden, Anders = de machinekamer.
   * De keuze telt pas als de beurt start (bijStart) en gaat terug als de druk vervalt. Socev krijgt nooit de tekst.
   */
  function knop(sleutel, keuze) {
    if (!/^herinnering-[0-9a-f]{10}$/.test(String(sleutel || ''))) return null;
    const r = q.perKaart.get(sleutel);
    if (!r) return null;
    // wv2069: de opname is via de verwijderroute weggehaald; een druk op een oude markerkaart doet niets meer
    if (r.status === 'verwijderd') return { context: ' (Herinneringen-kaart: deze opname is al verwijderd; er gebeurt niets meer mee en jij doet niets. Zeg in één zin dat de herinnering al weg is.)',
      bijStart: function () {}, bijVerval: function () {} };
    const kz = keuze === 'ja' ? 'doorlaten' : keuze === 'nee' ? 'vasthouden' : 'anders';
    const context = kz === 'doorlaten' ? ' (Herinneringen-kaart: David laat deze opname door. De pod schrijft zelf de privé-notitie in de Second Brain en zet de opname versleuteld in de back-up; jij krijgt de tekst niet en doet niets. Bevestig in één zin.)'
      : kz === 'vasthouden' ? ' (Herinneringen-kaart: David houdt deze opname vast. Tekst en opname blijven alleen op de pod; jij doet niets. Bevestig in één zin.)'
      : ' (Herinneringen-kaart: David koos Anders; zijn toelichting staat hierboven. Jij krijgt de tekst niet en doet niets met de opname; zeg in één zin dat de machinekamer het oppakt.)';
    return {
      context,
      bijStart: function () {
        if (kz === 'anders') { box('Anders op een markerkaart', ['gemeten: kaart ' + sleutel + ' (opname ' + r.ramble_id + ', stuk ' + r.stuk_id + '): David koos Anders; zijn toelichting staat in de knopbeurt.', 'voorstel: toelichting lezen en uitvoeren (doorlaten = keuze doorlaten in intake.sqlite › ramble).']); return; }
        q.keuze.run(kz, iso(nu()), r.ramble_id);
        spoor(r.ramble_id, null, 'keuze_' + kz);
        if (kz === 'doorlaten') setTimeout(function () { tik().catch(function () {}); }, 5000).unref();
      },
      bijVerval: function () { if (kz !== 'anders') q.keuze.run(null, null, r.ramble_id); },
    };
  }

  function info() {
    let per = null, vandaag = 0, open = 0;
    // notitie en vastgehouden samen als 'afgerond' (hoeveel opnames een markertreffer hadden hoort niet in /health; Opus-review KAN 12)
    try { per = {}; for (const x of db.prepare('SELECT status, count(*) n FROM ramble GROUP BY status').all()) { const k = x.status === 'notitie' || x.status === 'vastgehouden' ? 'afgerond' : x.status; per[k] = (per[k] || 0) + x.n; } } catch (e) { /* dicht */ }
    try { vandaag = Math.round(dagSeconden(amsDelen(nu()).datum) / 60); } catch (e) { /* dicht */ }
    try { open = db.prepare("SELECT count(*) n FROM ramble_stuk s JOIN ramble r ON r.ramble_id = s.ramble_id WHERE r.status = 'archief' AND s.uitgeschreven IS NULL AND s.pogingen < ?").get(POGINGEN).n; } catch (e) { /* dicht */ }
    let offsiteOpen = null;
    try { offsiteOpen = db.prepare("SELECT count(*) n FROM ramble WHERE offsite_ok = 1 AND proef = 0 AND status = 'notitie' AND offsite_op IS NULL").get().n; } catch (e) { /* dicht */ }
    return { aan: aan(), bezig, per_status: per, uit_te_schrijven: open, vandaag_min: vandaag, plafond_min: PLAFOND_S / 60,
      wacht_plafond: plafondDag === amsDelen(nu()).datum, laatst, offsite: { open: offsiteOpen, laatst: offsiteLaatst, remote: remote.split(':')[0] + ':…' } };
  }

  return { ontvangStuk, ontvangKlaar, stand, weg, tik, knop, info, offsiteLijst, _db: db, _transcript: transcript, _notitieTekst: notitieTekst, _kaartVoor: kaartVoor };
}

/*
 * Lijst voor een losse controle: relatieve paden die offsite mogen. Aanroep: node herinneringen.js offsite-lijst <intake.sqlite> <audiomap>.
 * Alleen lezen (ook op een KOPIE van het logboek; de toets doet dat).
 */
if (require.main === module && process.argv[2] === 'offsite-lijst') {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.argv[3], { readOnly: true });
  const audio = process.argv[4] || '/opt/data/herinneringen/audio';
  for (const r of db.prepare("SELECT ramble_id FROM ramble WHERE offsite_ok = 1 AND proef = 0 AND status = 'notitie' ORDER BY ramble_id").all()) {
    if (!ID_RE.test(r.ramble_id)) continue;
    let namen = [];
    try { namen = fs.readdirSync(path.join(audio, r.ramble_id)).filter((n) => /^([1-9][0-9]?\.wav|manifest\.txt)$/.test(n)).sort(); } catch (e) { continue; }
    for (const n of namen) process.stdout.write(r.ramble_id + '/' + n + '\n');
  }
  db.close();
}

module.exports = { maak, leesStuk, wavSeconden, tijdcode, ID_RE, STUK_MAX_BYTES, STUKKEN_MAX, PER_DAG, PLAFOND_S, NOTITIE_MAP };
