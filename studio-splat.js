'use strict';
// studio-splat.js — hulpstukken voor de Studio-motor `splat` ("Foto's → 3D", wv3272, InfiniSplat fase 2 rij A, 17-11-2026).
// Ontwerp (bindend): /opt/data/mk-opdrachten/wv3270-splat-fase2/ontwerp.md § 1.5–1.6, § 2 en § 5 (Codex-review r1 verwerkt);
// plan vault "01_Ontwikkeling/InfiniSplat in de Studio - plan (Fable 5.2, 15-11-2026)" § 7. De motor zelf (rij, poort, volgen, stop,
// opslag) staat in studio.js; hier alleen wat met de GEDEELDE taakmap en de bestanden te maken heeft, los te toetsen.
//
// GEDEELDE TAAKMAP (/opt/data/splat/taken, hostPath van de Olares-app `splat`, die draait als uid 1001 = dezelfde uid als de pod).
// De app kan daar dus alles neerzetten, ook koppelingen. Daarom (review r1 MOET 1):
//   - elke schrijf- en wisactie van de pod: eerst mapToets (taken en st-<id> echte mappen, geen koppeling, eigenaar 1001, realpath gelijk
//     aan het verwachte pad); bestanden alleen met O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW (nooit overschrijven; `stop` is leeg);
//   - lezen alleen met O_RDONLY|O_NOFOLLOW|O_NONBLOCK + fstat (gewoon bestand, maximum), dus ook geen FIFO die blijft hangen;
//   - uit/scene.ply via die fd kopiëren naar een eigen map van de pod; splat-transform werkt alleen op die kopie;
//   - wissen pas na dezelfde toets (rmSync volgt geen koppeling aan de top; binnenin wist het koppelingen zelf, niet hun doel).
//   Restrisico (aanvaard in het ontwerp): de app kan tussen toets en open een map verwisselen; met O_EXCL|O_NOFOLLOW kan dat hooguit een
//   leeg `stop` of een nieuw bestand elders aanmaken, niets overschrijven.
// NETWERK: de loper meet per taak (klaar.json netwerk.*, meting.json netwerkpogingen). Afwijking = pogingen > 0, een adres buiten
// 10.233.0.0/16 (cluster van Olares) en 192.168.20.54 (de Olares-host), of meer sockets dan de loper kon opsommen (niet te duiden).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SPLAT = {
  taken: '/opt/data/splat/taken', opslag: '/opt/data/splats', bundel: '/opt/data/splat/bundel',
  st_cli: '/opt/data/infinisplat/st/node_modules/@playcanvas/splat-transform/bin/cli.mjs',   // splat-transform 2.6.0, vaste versie
  gewichten_sha256: '6d23f9cef753fb7f72ecd88fa8e074a458de5116591276da85129909e73a66e8',   // InfiniSplat-v2 model.safetensors (wv3140)
  uid: 1001, json_max: 64 * 1024, long_side: 518, max_views: 32, fotos_min: 2, fotos_max: 32,
  hartslag_max_s: 60, claim_ms: 2 * 60 * 1000, grens_ms: 16 * 60 * 1000, stop_bevestig_ms: 2 * 60 * 1000, hangt_box_ms: 10 * 60 * 1000,
  plafond: 10 * 1024 ** 3, reservering: 1024 ** 3, vrij_min: 5 * 1024 ** 3, ruw_max: 600 * 1000 * 1000, ruw_ms: 30 * 86400000,
  wees_ms: 3600 * 1000, licht: 1000000, vol_max: 3000000, inpak_ms: 6 * 60 * 1000, voor_ms: 5 * 60 * 1000,
};
const TAAK_RE = /^[a-f0-9]{16}$/;
const O = fs.constants;

function cfgVan(over) { return Object.assign({}, SPLAT, over || {}); }
function mapNaam(taakId) { if (!TAAK_RE.test(String(taakId))) throw new Error('splat: ongeldige taak-id'); return 'st-' + taakId; }

// Echte map, geen koppeling, juiste eigenaar. Gooit niet: true/false.
function echteMap(p, uid) {
  try { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink() && (uid == null || s.uid === uid); } catch (e) { return false; }
}
// mapToets: de taakmap zelf en `naam` erin (MOET 1). naam = 'st-<id>' of 'st-<id>.nieuw'.
function mapToets(cfg, naam) {
  if (!/^st-[a-f0-9]{16}(\.nieuw)?$/.test(String(naam))) return false;
  if (!echteMap(cfg.taken, cfg.uid)) return false;
  let echt;
  try { echt = fs.realpathSync(cfg.taken); } catch (e) { return false; }
  if (echt !== path.resolve(cfg.taken)) return false;   // de taakmap zelf hangt niet aan een koppeling
  const p = path.join(cfg.taken, naam);
  if (!echteMap(p, cfg.uid)) return false;
  try { return fs.realpathSync(p) === path.join(echt, naam); } catch (e) { return false; }
}
function bestaatL(p) { try { fs.lstatSync(p); return true; } catch (e) { return false; } }
// Nieuw bestand, nooit overschrijven, geen koppeling volgen. Gooit bij een fout (EEXIST/ELOOP/…).
function maakExcl(p, data, mode) {
  const fd = fs.openSync(p, O.O_WRONLY | O.O_CREAT | O.O_EXCL | O.O_NOFOLLOW, mode == null ? 0o600 : mode);
  try { if (data != null && data.length) fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
}
// Klein JSON-bestand uit de gedeelde map: geen koppeling, geen FIFO, gewoon bestand, ≤ max. null als het er niet (goed) is.
function leesJsonVeilig(p, max) {
  let fd;
  try { fd = fs.openSync(p, O.O_RDONLY | O.O_NOFOLLOW | O.O_NONBLOCK); } catch (e) { return null; }
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size > (max || SPLAT.json_max)) return null;
    const b = Buffer.alloc(s.size);
    let n = 0;
    while (n < s.size) { const r = fs.readSync(fd, b, n, s.size - n, n); if (!r) break; n += r; }
    const j = JSON.parse(b.subarray(0, n).toString('utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch (e) { return null; } finally { try { fs.closeSync(fd); } catch (e) {} }
}

// Hartslag van de loper (taken/.loper.json, elke PEIL_S, ook tijdens een taak). vers = jonger dan hartslag_max_s.
function leesHartslag(cfg, nuMs) {
  if (!echteMap(cfg.taken, cfg.uid)) return { vers: false, reden: 'taakmap' };
  const j = leesJsonVeilig(path.join(cfg.taken, '.loper.json'));
  if (!j || typeof j.tijd_s !== 'number' || !isFinite(j.tijd_s)) return { vers: false, reden: 'geen hartslag' };
  const leeftijd = (nuMs - j.tijd_s * 1000) / 1000;
  return { vers: leeftijd <= cfg.hartslag_max_s && leeftijd > -cfg.hartslag_max_s, leeftijd_s: Math.round(leeftijd), tijd_s: j.tijd_s,
    bezig: j.bezig === true, taak: typeof j.taak === 'string' ? j.taak.slice(0, 60) : null, versie: typeof j.versie === 'string' ? j.versie.slice(0, 20) : null };
}

// Taakmap klaarzetten: st-<id>.nieuw (0700) met taak.json en invoer/NN.jpg, daarna rename naar st-<id> (protocol fase 1).
// fotos: [{ naam: '01.jpg', bytes: Buffer }] (alleen uit de eigen werkmap van de pod). Gooit met een korte reden.
function maakTaakmap(cfg, taakId, fotos) {
  const naam = mapNaam(taakId), nieuw = naam + '.nieuw';
  if (!echteMap(cfg.taken, cfg.uid)) throw new Error('de gedeelde taakmap is er niet (goed)');
  if (bestaatL(path.join(cfg.taken, naam)) || bestaatL(path.join(cfg.taken, nieuw))) throw new Error('de taakmap bestaat al');
  fs.mkdirSync(path.join(cfg.taken, nieuw), { mode: 0o700 });
  if (!mapToets(cfg, nieuw)) throw new Error('de nieuwe taakmap klopt niet');
  const p = path.join(cfg.taken, nieuw);
  maakExcl(path.join(p, 'taak.json'), Buffer.from(JSON.stringify({ id: naam, long_side: cfg.long_side, max_views: cfg.max_views }) + '\n'), 0o600);
  fs.mkdirSync(path.join(p, 'invoer'), { mode: 0o700 });
  if (!echteMap(path.join(p, 'invoer'), cfg.uid)) throw new Error('de invoermap klopt niet');
  for (const f of fotos) {
    if (!/^\d{2}\.jpg$/.test(f.naam)) throw new Error('ongeldige fotonaam');
    maakExcl(path.join(p, 'invoer', f.naam), f.bytes, 0o600);
  }
  if (!mapToets(cfg, nieuw) || bestaatL(path.join(cfg.taken, naam))) throw new Error('de taakmap veranderde onderweg');
  fs.renameSync(p, path.join(cfg.taken, naam));
  if (!mapToets(cfg, naam)) throw new Error('de taakmap klopt niet na het hernoemen');
  return naam;
}
// Leeg `stop` in een taakmap (MOET 1/2). true = staat er (nu of al), false = kon niet.
function schrijfStop(cfg, naam) {
  if (!mapToets(cfg, naam)) return false;
  try { maakExcl(path.join(cfg.taken, naam, 'stop'), null, 0o600); return true; }
  catch (e) { if (e && e.code === 'EEXIST') { try { const s = fs.lstatSync(path.join(cfg.taken, naam, 'stop')); return s.isFile(); } catch (e2) { return false; } } return false; }
}
// Taakmap wissen na de toets. Ook st-<id>.nieuw.
function wisTaakmap(cfg, naam) {
  if (!mapToets(cfg, naam)) return false;
  try { fs.rmSync(path.join(cfg.taken, naam), { recursive: true, force: true }); return !bestaatL(path.join(cfg.taken, naam)); } catch (e) { return false; }
}
// Lees stand.json/klaar.json/meting.json/geclaimd-staat van een taakmap (alles klein en veilig).
function leesTaakmap(cfg, naam) {
  if (!mapToets(cfg, naam)) return { weg: true };
  const p = path.join(cfg.taken, naam);
  return { weg: false, geclaimd: bestaatL(path.join(p, 'geclaimd')), stop: bestaatL(path.join(p, 'stop')),
    stand: leesJsonVeilig(path.join(p, 'stand.json')), klaar: leesJsonVeilig(path.join(p, 'klaar.json')), meting: leesJsonVeilig(path.join(p, 'meting.json'), 256 * 1024) };
}

// uit/scene.ply via een fd (O_NOFOLLOW, gewoon bestand, ≤ ruw_max) naar <doelMap>/.ruw.tmp kopiëren, dan rename naar ruw.ply.
// → Promise<{ bytes, sha256 }>; gooit met een korte reden. doelMap is van de pod (niet gedeeld).
function kopieerRuw(cfg, naam, doelMap) {
  return new Promise(function (klaar, faal) {
    if (!mapToets(cfg, naam)) return faal(new Error('de taakmap klopt niet'));
    const uit = path.join(cfg.taken, naam, 'uit');
    if (!echteMap(uit, cfg.uid)) return faal(new Error('uit/ is geen echte map'));
    let fd;
    try { fd = fs.openSync(path.join(uit, 'scene.ply'), O.O_RDONLY | O.O_NOFOLLOW | O.O_NONBLOCK); }
    catch (e) { return faal(new Error(e && e.code === 'ELOOP' ? 'scene.ply is een koppeling' : 'scene.ply ontbreekt')); }
    let s;
    try { s = fs.fstatSync(fd); } catch (e) { fs.closeSync(fd); return faal(new Error('scene.ply onleesbaar')); }
    if (!s.isFile()) { fs.closeSync(fd); return faal(new Error('scene.ply is geen gewoon bestand')); }
    if (s.size <= 0 || s.size > cfg.ruw_max) { fs.closeSync(fd); return faal(new Error('scene.ply is leeg of groter dan ' + Math.round(cfg.ruw_max / 1e6) + ' MB')); }
    const tmp = path.join(doelMap, '.ruw.tmp');
    try { fs.rmSync(tmp, { force: true }); } catch (e) {}
    const h = crypto.createHash('sha256');
    let n = 0, af = false;
    const rs = fs.createReadStream(null, { fd: fd, autoClose: true, start: 0, end: s.size - 1 });
    const ws = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
    const fout = function (e) { if (af) return; af = true; rs.destroy(); ws.destroy(); try { fs.rmSync(tmp, { force: true }); } catch (x) {} faal(e); };
    rs.on('data', function (b) { n += b.length; h.update(b); if (n > cfg.ruw_max) fout(new Error('scene.ply groeide tijdens het kopiëren')); });
    rs.on('error', function () { fout(new Error('scene.ply lezen mislukte')); });
    ws.on('error', function () { fout(new Error('kopie schrijven mislukte (schijf?)')); });
    ws.on('finish', function () {
      if (af) return;
      if (n !== s.size) return fout(new Error('scene.ply veranderde tijdens het kopiëren'));
      try { fs.renameSync(tmp, path.join(doelMap, 'ruw.ply')); } catch (e) { return fout(new Error('kopie hernoemen mislukte')); }
      af = true; klaar({ bytes: n, sha256: h.digest('hex') });
    });
    rs.pipe(ws);
  });
}

// Aantal puntjes uit de ply-kop (element vertex N vóór end_header). null als onleesbaar.
function plyPuntjes(p) {
  let fd;
  try { fd = fs.openSync(p, O.O_RDONLY | O.O_NOFOLLOW); } catch (e) { return null; }
  try {
    const b = Buffer.alloc(8192); const n = fs.readSync(fd, b, 0, b.length, 0);
    const kop = b.subarray(0, n).toString('latin1');
    const e = kop.indexOf('end_header');
    if (kop.indexOf('ply') !== 0 || e < 0) return null;
    const m = /\nelement vertex (\d+)\s*\n/.exec(kop.slice(0, e));
    return m ? Number(m[1]) : null;
  } catch (e) { return null; } finally { try { fs.closeSync(fd); } catch (e) {} }
}
function sha256Bestand(p) {
  return new Promise(function (klaar, faal) {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(p, { flags: O.O_RDONLY | O.O_NOFOLLOW });
    rs.on('data', function (b) { h.update(b); }); rs.on('error', faal); rs.on('end', function () { klaar(h.digest('hex')); });
  });
}

// ── netwerk (ontwerp § 2) ──
function ipToegestaan(ip) {
  let a = String(ip || '').toLowerCase();
  if (a.indexOf('::ffff:') === 0) a = a.slice(7);
  if (a === '0.0.0.0' || a === '::' || a === '::1' || /^127\./.test(a)) return true;   // geen tegenpartij / eigen pod
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;   // elk ander IPv6-adres: buiten
  if (m[1] === '10' && m[2] === '233') return true;   // cluster van Olares
  return a === '192.168.20.54';                        // de Olares-host
}
// → { ok, afwijking, ontbreekt, pogingen, sockets, rekenproces, buiten: n, reden }. afwijking = iets gezien dat niet mag (mislukt + box-rij);
// ontbreekt = geen (volledige) meting (bij een geslaagde taak: mislukt zonder box-rij; bij een mislukte taak normaal).
function netwerkToets(klaar, meting) {
  const nw = klaar && klaar.netwerk && typeof klaar.netwerk === 'object' ? klaar.netwerk : null;
  const pog = meting && Number.isInteger(meting.netwerkpogingen) ? meting.netwerkpogingen : null;
  const uit = { ok: false, afwijking: false, ontbreekt: false, pogingen: pog, sockets: nw ? Number(nw.verbindingen_naar_buiten) || 0 : null,
    rekenproces: nw ? Number(nw.rekenproces_sockets) || 0 : null, buiten: 0, reden: null };
  if (!nw) { uit.ontbreekt = true; uit.reden = 'de 3D-app gaf geen netwerkmeting'; return uit; }
  const lijsten = [[nw.details, nw.verbindingen_naar_buiten], [nw.rekenproces_details, nw.rekenproces_sockets]];
  for (const [l, n] of lijsten) {
    const lijst = Array.isArray(l) ? l : [];
    if (Number(n) > lijst.length) { uit.afwijking = true; uit.reden = 'meer verbindingen dan de 3D-app kon opsommen'; return uit; }
    for (const r of lijst) {
      const m = /^(tcp6?|udp6?) (\S+):(\d+)(?: |$)/.exec(String(r));
      if (!m || !ipToegestaan(m[2])) uit.buiten++;
    }
  }
  if (pog > 0) uit.reden = pog + ' netwerkpoging(en) van het rekenproces';
  else if (uit.buiten) uit.reden = uit.buiten + ' verbinding(en) buiten Olares';
  uit.afwijking = !!uit.reden;
  if (!uit.reden && pog === null) { uit.ontbreekt = true; uit.reden = 'de 3D-app gaf geen telling van netwerkpogingen'; }
  uit.ok = !uit.reden;
  return uit;
}
// meting.json van de app zonder paden of spoor: alleen deze velden
const METING_VELDEN = ['fotos', 'lange_zijde', 'gpu', 'vram_vrij_bij_start_mib', 'vram_totaal_mib', 'laden_s', 'rekenen_s', 'wegschrijven_s', 'totaal_s',
  'puntjes', 'vram_piek_torch_mib', 'vram_piek_gereserveerd_mib', 'vram_piek_toestel_mib', 'netwerkpogingen', 'torch', 'cuda'];
function metingKort(m) {
  const o = {};
  if (!m || typeof m !== 'object') return o;
  METING_VELDEN.forEach(function (k) { const v = m[k]; if (typeof v === 'number' && isFinite(v)) o[k] = v; else if (typeof v === 'string') o[k] = v.replace(/[^\w .+-]/g, '').slice(0, 60); });
  return o;
}

// ── ruimte (ontwerp § 1.6, review r1 ZOU 1) ──
function du(p) {
  let s;
  try { s = fs.lstatSync(p); } catch (e) { return 0; }
  if (!s.isDirectory()) return s.isFile() ? s.size : 0;
  let t = 0;
  let namen = [];
  try { namen = fs.readdirSync(p); } catch (e) { return 0; }
  for (const n of namen) t += du(path.join(p, n));
  return t;
}
function vrijeRuimte(p) { try { const s = fs.statfsSync(p); return Number(s.bavail) * Number(s.bsize); } catch (e) { return null; } }
// → null (past) of een reden in gewone taal
function ruimteToets(cfg) {
  const gebruikt = du(cfg.opslag);
  if (gebruikt + cfg.reservering > cfg.plafond) return 'de 3D-scènes nemen samen al ' + (gebruikt / 1024 ** 3).toFixed(1).replace('.', ',') + ' GB in (grens ' + Math.round(cfg.plafond / 1024 ** 3) + ' GB); ruim eerst een scène op';
  const vrij = vrijeRuimte(path.dirname(cfg.opslag));
  if (vrij == null || vrij < cfg.vrij_min) return 'te weinig vrije schijfruimte op de pod (' + (vrij == null ? '?' : Math.floor(vrij / 1024 ** 3)) + ' GB vrij, nodig ' + Math.round(cfg.vrij_min / 1024 ** 3) + ' GB)';
  return null;
}

// ── splat-transform (CPU in de pod; nice 10; argv-array, geen shell; cwd = de scènemap; env zonder geheimen; nooit een adres) ──
// args: ['ruw.ply', '-F', '1000000', 'licht.sog']. → Promise<{ ok, code, ms, fout }>
function splatTransform(cfg, cwd, args, ms, ctl) {
  return new Promise(function (klaar) {
    if (!args.every(function (a) { return typeof a === 'string' && a.indexOf('://') < 0 && !/^\//.test(a) && a.indexOf('..') < 0; }))
      return klaar({ ok: false, fout: 'ongeldige opdracht voor splat-transform' });
    const cmd = cfg.st_cmd || ['nice', '-n', '10', process.execPath, cfg.st_cli];
    const t0 = Date.now();
    let k, err = '', af = false;
    try {
      k = spawn(cmd[0], cmd.slice(1).concat(['-q', '-w', '-g', 'cpu']).concat(args), { cwd: cwd, detached: true,
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: cwd, NODE_OPTIONS: '--max-old-space-size=8192' }, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { return klaar({ ok: false, fout: 'splat-transform start niet' }); }
    const dood = function () { try { process.kill(-k.pid, 'SIGKILL'); } catch (e) { try { k.kill('SIGKILL'); } catch (e2) {} } };
    const eind = function (r) { if (af) return; af = true; clearTimeout(tm); if (ctl) ctl.stop = null; r.ms = Date.now() - t0; klaar(r); };
    const tm = setTimeout(function () { dood(); eind({ ok: false, fout: 'splat-transform duurde langer dan ' + Math.round(ms / 60000) + ' min' }); }, ms);
    if (ctl) ctl.stop = function () { dood(); };
    k.stderr.on('data', function (b) { if (err.length < 2000) err += b; });
    k.on('error', function () { eind({ ok: false, fout: 'splat-transform start niet' }); });
    k.on('close', function (code) {
      if (ctl && ctl.gestopt) return eind({ ok: false, fout: 'gestopt', code: code });
      if (code !== 0) return eind({ ok: false, code: code, fout: 'splat-transform faalde (code ' + code + '): ' + String(err).replace(/\/[^\s:'"]+/g, '…').replace(/[\r\n]+/g, ' ').slice(0, 160) });
      eind({ ok: true, code: 0 });
    });
  });
}

// Bundel-versie voor kaart.json (bouw.json van de bundel; alleen het git-nummer)
function bundelGit(cfg) {
  const j = leesJsonVeilig(path.join(cfg.bundel, 'bouw.json'), 4096);
  return j && /^[0-9a-f]{7,40}$/.test(String(j.git || '')) ? String(j.git) : null;
}

module.exports = { SPLAT, TAAK_RE, cfgVan, mapNaam, mapToets, echteMap, bestaatL, maakExcl, leesJsonVeilig, leesHartslag, maakTaakmap, schrijfStop,
  wisTaakmap, leesTaakmap, kopieerRuw, plyPuntjes, sha256Bestand, ipToegestaan, netwerkToets, metingKort, du, vrijeRuimte, ruimteToets,
  splatTransform, bundelGit };
