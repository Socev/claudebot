'use strict';
/*
 * MemoryLane: video's afspelen (wv2938, 11-11-2026; David in de app ± 16:45: "Ook met video's... die wil ik toch ook kunnen afspelen in de
 * albums, kan dat al?"). Ontwerp in de vault: 01_Ontwikkeling "MemoryLane - video's afspelen (ontwerp wv2938, 11-11-2026)".
 *
 * WAAROM. Een video uit een Immich-album is vaak groot (1080p, 20 Mbit/s) en soms HEVC (speelt niet in Chrome op Android). Immich zet niets om
 * (transcodebeleid "required"). Deze module maakt per video één kleine versie op de pod en is daarmee de enige bron voor Davids app (stukken via
 * het doorgeefluik) en voor bezoekers (memorylane-publiek.js zet hem in R2).
 *
 * VORM.
 *  - Kleine versie: H.264 (High) + AAC, lange zijde ≤ 1280 (720p), ≤ 30 fps, CRF 27, max 2,5 Mbit/s, de eerste MAX_SEC seconden, ≤ MAX_UIT
 *    bytes, faststart, ZONDER metadata (-map_metadata -1, geen hoofdstukken; daarna metaVeilig() op de mp4-dozen: geen plaats, XMP of eigen
 *    velden, anders weggegooid). ffmpeg draait één tegelijk, 1 thread, laagste prioriteit, met een harde tijdgrens.
 *  - Bron: immich.videoNaarBestand (alleen lezen, gestreamd naar een tijdelijk 0600-bestand, ≤ MAX_IN), na afloop altijd weg.
 *  - Bewaard in <dir> (herinneringen/video, 0700): <sha256('v1|'+id)[:32]>.mp4. Een cache: opnieuw te maken, hooguit MAX_CACHE bytes
 *    (oudste eerst weg; afspelen of publiceren ververst de datum). Geen titels of albumnamen in bestandsnamen, logs of /health.
 *  - Deze module toetst GEEN rechten: memorylane-delen.js laat alleen een id door dat nu als video in een gekoppeld album staat.
 * PRIVACY. Nooit ids, titels of beelden in logs of fouten; alleen aantallen en een korte reden.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');

const MAX_IN = 2 * 1024 ** 3, MAX_UIT = 80 * 1000 * 1000, MAX_SEC = 300, MAX_CACHE = 3 * 1024 ** 3, DEEL = 2 * 1024 * 1024;
const FFMPEG_MS = 20 * 60000, DOWNLOAD_MS = 15 * 60000, OPNIEUW_NA_FOUT_MS = 60 * 60000, MAX_WACHT = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ffmpeg-argumenten (vast; alleen de twee paden variëren). Eerst de invoer, dan schalen naar ≤ 1280 en ≤ 30 fps, tv-bereik.
function ffmpegArgs(inPad, uitPad) {
  return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-threads', '1', '-i', inPad,
    '-map', '0:v:0', '-map', '0:a:0?', '-t', String(MAX_SEC),
    '-vf', 'scale=w=min(1280\\,iw):h=min(1280\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2:out_range=tv,fps=fps=min(30\\,source_fps),format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-maxrate', '2500k', '-bufsize', '5000k', '-profile:v', 'high', '-threads', '1',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
    '-map_metadata', '-1', '-map_metadata:s:v', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-movflags', '+faststart', '-fs', String(MAX_UIT), '-f', 'mp4', uitPad];
}

// ── metaVeilig: loopt de mp4-dozen af. Alleen ftyp/moov/mdat/free/skip/wide op het hoogste niveau; in de moov-boom geen meta, uuid, XMP of
// plaats; een udta mag alleen ©too (de naam van de encoder) bevatten. Onbekend of kapot = niet veilig. → true | false
const TOP_OK = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide']);
const AF = new Set(['meta', 'uuid', 'XMP_', '\xa9xyz', 'loci', 'keys', 'ilst', 'kind', 'cprt', 'tags']);
const AFDALEN = new Set(['moov', 'trak', 'mdia', 'minf', 'edts', 'dinf', 'stbl']);
function dozen(b, van, tot, opDoos) {
  let i = van;
  while (i < tot) {
    if (i + 8 > tot) return false;
    let len = b.readUInt32BE(i), kop = 8;
    const type = b.toString('latin1', i + 4, i + 8);
    if (len === 1) { if (i + 16 > tot) return false; const groot = b.readBigUInt64BE(i + 8); if (groot > BigInt(Number.MAX_SAFE_INTEGER)) return false; len = Number(groot); kop = 16; }
    else if (len === 0) len = tot - i;
    if (len < kop || i + len > tot) return false;
    if (opDoos(type, i + kop, i + len) === false) return false;
    i += len;
  }
  return true;
}
// review bouw MOET 1: de naam in een hdlr (handler_name) kan vrije tekst zijn; alleen leeg of de vaste namen van ffmpeg met bitexact
const HDLR_NAMEN = new Set(['', 'VideoHandler', 'SoundHandler']);
function hdlrOk(b, s, e) {
  if (e - s < 24) return false;
  const naam = b.toString('latin1', s + 24, e).replace(/\0+$/, '');
  return HDLR_NAMEN.has(naam);
}
function metaLeeg(b, van, tot) {
  return dozen(b, van, tot, function (t, s, e) { return (t === 'hdlr' && hdlrOk(b, s, e)) || (t === 'ilst' && dozen(b, s, e, function (t2) { return t2 === '\xa9too'; })); });
}
function moovVeilig(b, van, tot) {
  return dozen(b, van, tot, function (type, s, e) {
    if (AF.has(type)) return false;
    // ffmpeg schrijft (ook met bitexact) een udta/meta met een hdlr en een lege ilst; alleen dat, of ©too, mag
    if (type === 'udta') return dozen(b, s, e, function (t, s2, e2) { return t === '\xa9too' || (t === 'meta' && e2 - s2 >= 4 && metaLeeg(b, s2 + 4, e2)); });
    if (AFDALEN.has(type)) return moovVeilig(b, s, e);
    if (type === 'hdlr') return hdlrOk(b, s, e);
    return true;
  });
}
// buf = het hele bestand, of (lees) een functie (positie, lengte) → Buffer voor grote bestanden
function metaVeilig(pad) {
  let fd;
  try {
    fd = fs.openSync(pad, 'r');
    const groot = fs.fstatSync(fd).size;
    const lees = function (pos, n) { const b = Buffer.alloc(n); let g = 0; while (g < n) { const r = fs.readSync(fd, b, g, n - g, pos + g); if (!r) break; g += r; } return b.subarray(0, g); };
    let i = 0, moov = 0, ftyp = false;
    while (i < groot) {
      const k = lees(i, 16);
      if (k.length < 8) return false;
      let len = k.readUInt32BE(0), kop = 8;
      const type = k.toString('latin1', 4, 8);
      if (len === 1) { if (k.length < 16) return false; const g = k.readBigUInt64BE(8); if (g > BigInt(Number.MAX_SAFE_INTEGER)) return false; len = Number(g); kop = 16; }
      else if (len === 0) len = groot - i;
      if (len < kop || i + len > groot) return false;
      if (!TOP_OK.has(type)) return false;
      if (type === 'ftyp') ftyp = true;
      if (type === 'moov') {
        moov++;
        if (len > 64 * 1024 * 1024) return false;
        const b = lees(i + kop, len - kop);
        if (b.length !== len - kop || !moovVeilig(b, 0, b.length)) return false;
      }
      i += len;
    }
    return ftyp && moov === 1;
  } catch (e) { return false; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* weg */ } }
}

/*
 * maak(o) → { stand, deel, pad, info, metaVeilig, _wacht }
 * o = { dir, immich (immich.js-client met videoNaarBestand), ffmpeg (pad), nu?, fout?(label, e), spawn? (toetsen) }
 */
function maak(o) {
  const nu = typeof o.nu === 'function' ? o.nu : Date.now;
  const fout = function (l, e) { if (o.fout) o.fout(l, e); };
  const doeSpawn = o.spawn || spawn;
  const dir = o.dir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // achtergebleven tijdelijke bestanden (een herstart midden in het werk) weg
  for (const f of fs.readdirSync(dir)) if (f.startsWith('.tmp-')) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* weg */ } }
  const wacht = [], mislukt = new Map();   // id → { op, reden }
  let bezig = null, tel = { gemaakt: 0, fout: 0, weg: 0 };

  const naam = function (id) { return crypto.createHash('sha256').update('v1|' + id).digest('hex').slice(0, 32) + '.mp4'; };
  const pad = function (id) { return path.join(dir, naam(id)); };
  function ffmpegPad() { try { const p = typeof o.ffmpeg === 'function' ? o.ffmpeg() : o.ffmpeg; if (p && fs.statSync(p).isFile()) return p; } catch (e) { /* geen */ } return null; }
  function klaar(id) {
    try { const s = fs.statSync(pad(id)); if (s.isFile() && s.size > 0) return s; } catch (e) { /* nog niet */ }
    return null;
  }
  function vers(id) { try { const t = new Date(nu()); fs.utimesSync(pad(id), t, t); } catch (e) { /* niet erg */ } }

  // → { stand: 'klaar', grootte, delen } | { stand: 'bezig' | 'wacht' } | { stand: 'kan-niet', reden }
  // zet = true: niet klaar en niet in de wacht → in de wacht zetten (dan maakt hij hem op de achtergrond)
  function stand(id, zet) {
    if (!UUID_RE.test(String(id))) return { stand: 'kan-niet', reden: 'onbekend' };
    const s = klaar(id);
    if (s) return { stand: 'klaar', grootte: s.size, delen: Math.max(1, Math.ceil(s.size / DEEL)), mime: 'video/mp4' };
    if (bezig === id) return { stand: 'bezig' };
    if (wacht.indexOf(id) >= 0) return { stand: 'wacht', voor: wacht.indexOf(id) };
    const m = mislukt.get(id);
    if (m && (m.blijvend || nu() - m.op < OPNIEUW_NA_FOUT_MS)) return { stand: 'kan-niet', reden: m.reden };
    if (!ffmpegPad()) return { stand: 'kan-niet', reden: 'geen ffmpeg op de pod' };
    if (!zet) return { stand: 'nog-niet' };
    if (wacht.length >= MAX_WACHT) return { stand: 'kan-niet', reden: 'te veel video\'s tegelijk; probeer het zo opnieuw' };
    wacht.push(id);
    setImmediate(werk);
    return { stand: 'wacht', voor: wacht.length - 1 };
  }

  function draai(args) {
    return new Promise(function (ok, nee) {
      let p;
      try { p = doeSpawn(ffmpegPad(), args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { nee(e); return; }
      try { if (p.pid) os.setPriority(p.pid, 19); } catch (e) { /* niet erg */ }
      let err = '';
      if (p.stderr) p.stderr.on('data', function (d) { if (err.length < 2000) err += String(d); });
      const klok = setTimeout(function () { try { p.kill('SIGKILL'); } catch (e) { /* al weg */ } }, FFMPEG_MS);
      p.on('error', function (e) { clearTimeout(klok); nee(e); });
      p.on('close', function (code, sig) { clearTimeout(klok); if (code === 0) ok(); else { const e = new Error('ffmpeg ' + (sig || code)); e.uitleg = err.slice(-300); nee(e); } });
    });
  }

  async function maakEen(id) {
    const r = crypto.randomBytes(8).toString('hex');
    const inPad = path.join(dir, '.tmp-' + r + '.in'), uitPad = path.join(dir, '.tmp-' + r + '.mp4');
    try {
      await o.immich.videoNaarBestand(id, inPad, MAX_IN, DOWNLOAD_MS);
      await draai(ffmpegArgs(inPad, uitPad));
      const s = fs.statSync(uitPad);
      if (!s.size) throw Object.assign(new Error('lege uitvoer'), { reden: 'de video kon niet omgezet worden' });
      if (!metaVeilig(uitPad)) throw Object.assign(new Error('metadata'), { reden: 'de omgezette video had nog gegevens erin', blijvend: true });
      fs.renameSync(uitPad, pad(id));
      tel.gemaakt++;
      opruimen();
    } finally {
      for (const p of [inPad, uitPad]) { try { fs.unlinkSync(p); } catch (e) { /* al weg */ } }
    }
  }
  async function werk() {
    if (bezig) return;
    while (wacht.length) {
      const id = wacht.shift();
      if (klaar(id)) continue;
      bezig = id;
      try { await maakEen(id); mislukt.delete(id); }
      catch (e) {
        tel.fout++;
        const reden = e.reden || (e.code === 'GROOT' ? 'de video is te groot (meer dan 2 GB)' : e.code === 'HTTP' && e.status === 404 ? 'de video staat niet meer in Immich'
          : e.code === 'GEEN_SLEUTEL' ? 'nog geen Immich-sleutel' : e.code === 'NET' || e.code === 'HTTP' ? 'Immich was niet bereikbaar' : 'de video kon niet omgezet worden');
        mislukt.set(id, { op: nu(), reden, blijvend: !!e.blijvend || e.code === 'GROOT' });
        fout('ml-video', new Error((e.code || 'fout') + ' ' + String(e.message || '').slice(0, 60)));
      } finally { bezig = null; }
    }
  }
  // oudste eerst weg tot de cache onder MAX_CACHE zit
  function opruimen() {
    let l = [];
    try { l = fs.readdirSync(dir).filter(function (f) { return /^[0-9a-f]{32}\.mp4$/.test(f); }).map(function (f) { const s = fs.statSync(path.join(dir, f)); return { f, t: s.mtimeMs, n: s.size }; }); } catch (e) { return; }
    let som = l.reduce(function (a, x) { return a + x.n; }, 0);
    l.sort(function (a, b) { return a.t - b.t; });
    while (som > MAX_CACHE && l.length > 1) { const x = l.shift(); try { fs.unlinkSync(path.join(dir, x.f)); som -= x.n; tel.weg++; } catch (e) { /* weg */ } }
  }
  // één stuk (n = 1…delen) als base64; null als hij (nog) niet klaar is of n buiten bereik
  function deel(id, n) {
    const s = klaar(id);
    if (!s || !Number.isInteger(n) || n < 1) return null;
    const delen = Math.max(1, Math.ceil(s.size / DEEL));
    if (n > delen) return null;
    if (n === 1) vers(id);
    const lengte = Math.min(DEEL, s.size - (n - 1) * DEEL), b = Buffer.alloc(lengte);
    const fd = fs.openSync(pad(id), 'r');
    try { let g = 0; while (g < lengte) { const r = fs.readSync(fd, b, g, lengte - g, (n - 1) * DEEL + g); if (!r) break; g += r; } } finally { fs.closeSync(fd); }
    return { n, delen, grootte: s.size, mime: 'video/mp4', data: b.toString('base64') };
  }
  // voor de publicatie: het hele bestand (≤ MAX_UIT) of null
  function bestand(id) { const s = klaar(id); if (!s || s.size > MAX_UIT) return null; vers(id); return fs.readFileSync(pad(id)); }
  function info() {
    let n = 0, bytes = 0;
    try { for (const f of fs.readdirSync(dir)) if (/^[0-9a-f]{32}\.mp4$/.test(f)) { n++; bytes += fs.statSync(path.join(dir, f)).size; } } catch (e) { /* leeg */ }
    return { ffmpeg: !!ffmpegPad(), klaar: n, mb: Math.round(bytes / 1e6), bezig: bezig ? 1 : 0, wacht: wacht.length, mislukt: mislukt.size, ...tel };
  }
  return { stand, deel, bestand, info, _wacht: wacht, _pad: pad };
}

module.exports = { maak, metaVeilig, ffmpegArgs, MAX_UIT, MAX_SEC, DEEL };
