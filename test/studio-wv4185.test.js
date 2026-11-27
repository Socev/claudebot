'use strict';
// wv4185 (besluitenpagina nr 174 = 2C74; David Ja 25-11-2026 22:24): Studio — van één filmpje een 3D-scène (Film → 3D).
// Toetst met een nep-loper (taakmap-protocol van de Olares-app splat), een nagebootste ComfyUI (rij + VRAM), een nep-Immich die
// door ffmpeg gemaakte proeffilmpjes (testsrc2, verzonnen beeld) uitlevert, de ECHTE ffmpeg en de echte studio-beeld.py:
//   invoer { immich_video }, weigeringen bij Maak (geen UUID, foto, prullenbak, te kort/lang volgens Immich), filmpje → 32 beeldjes naar
//   de app (rechtop bij een staand filmpje, zonder metadata), geen asset-id in taken.json/log, werkmap leeg (filmpje en beeldjes weg),
//   kaart.json met film-blok, Mijn 3D-scènes bron video, ffmpeg meet zelf de duur (Immich zei niets), geen filmformaat = mislukt,
//   kiezerlijsten (nieuwste filmpjes, filmpjes in een album) en immich.nieuwsteFotos(max, true).
// Raakt /opt/data niet (behalve het lezen van ffmpeg). Gebruik: node test/studio-wv4185.test.js
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto'), { execFileSync } = require('child_process');
process.chdir(path.join(__dirname, '..'));
const IMM = require('../immich.js');
const studioMod = require('../studio.js');
const FF = '/opt/data/tools/ffmpeg/ffmpeg';
let fout = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fout++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 20000); while (Date.now() < t) { if (await f()) return true; await slaap(25); } return false; }
const uuid = () => crypto.randomUUID();
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'wv4185-'));
function jpegKop(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const uit = []; let i = 2;
  while (i + 4 <= b.length) { if (b[i] !== 0xff) return null; const m = b[i + 1]; uit.push(m); if (m === 0xda) break; i += 2 + b.readUInt16BE(i + 2); }
  return uit;
}

// ── proeffilmpjes (verzonnen beeld: testsrc2) ──
const V = path.join(W, 'video'); fs.mkdirSync(V);
const ff = (args) => execFileSync(FF, ['-hide_banner', '-v', 'error', '-y'].concat(args));
ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', 'location=+52.1+005.2/', path.join(V, 'liggend.mp4')]);
ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(V, 'r0.mp4')]);
ff(['-display_rotation:v', '90', '-i', path.join(V, 'r0.mp4'), '-c', 'copy', path.join(V, 'staand.mp4')]);
ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(V, 'kort.mp4')]);
fs.writeFileSync(path.join(V, 'lijst.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nliggend.mp4\n#EXT-X-ENDLIST\n');

// ── nep-Immich ──
const IM = { assets: {}, albums: {}, gehaald: [], mijn: crypto.randomUUID() };
function zetAsset(o) { const id = uuid(); IM.assets[id] = Object.assign({ beeld: false, prullenbak: false, duur: null }, o); return id; }
const immich = {
  fotoInfo: async (id) => { const a = IM.assets[id]; return a ? { beeld: a.beeld, mime: a.beeld ? 'image/jpeg' : 'video/mp4', grootte: 1000, prullenbak: a.prullenbak, duur: a.duur, eigenaar: a.eigenaar || IM.mijn } : null; },
  mijnId: async () => IM.mijn,
  origineel: async () => { throw new Error('niet verwacht'); },
  beeld: async () => { throw new Error('niet verwacht'); },
  videoNaarBestand: async (id, pad, max) => { IM.gehaald.push(id); const d = fs.readFileSync(IM.assets[id].pad); if (d.length > max) { const e = new Error('groot'); e.code = 'GROOT'; throw e; } fs.writeFileSync(pad, d, { flag: 'wx', mode: 0o600 }); return { bytes: d.length, mime: 'video/mp4' }; },
  albumFotos: async (albumId) => { const l = IM.albums[albumId]; if (!l) { const e = new Error('x'); e.code = 'HTTP'; e.status = 404; throw e; } return l.map((x) => Object.assign({}, x)); },
  nieuwsteFotos: async (max, video) => (video ? [{ id: IM.nieuwVideo, ratio: 1.778, dag: '2026-11-27', duur: 20 }] : []),
};

// ── nagebootste ComfyUI ──
const comfy = http.createServer((req, res) => {
  const stuur = (j) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
  if (req.url === '/queue') return stuur({ queue_running: [], queue_pending: [] });
  if (req.url === '/system_stats') return stuur({ system: { ram_free: 60e9 }, devices: [{ vram_free: 24000 * 1048576, vram_total: 25e9 }] });
  res.writeHead(404); res.end('{}');
});
const NEPST = path.join(W, 'nep-st.js');
fs.writeFileSync(NEPST, "const a = process.argv.slice(2); require('fs').writeFileSync(a[a.length - 1], JSON.stringify({ args: a }));\n");

// ── nep-loper (taakprotocol van splat/taakloper.py, alleen de gewone weg) ──
const TAKEN = path.join(W, 'taken'), OPSLAG = path.join(W, 'splats'), BUNDEL = path.join(W, 'bundel');
fs.mkdirSync(TAKEN, { mode: 0o700 }); fs.mkdirSync(BUNDEL); fs.writeFileSync(path.join(BUNDEL, 'bouw.json'), JSON.stringify({ git: 'ba4d86a3344a035b93b71e115f0d5a3b4abda9b6' }));
const NL = { bezig: false, taak: null, gezien: [] };
function plyBytes(n) { return Buffer.concat([Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex ' + n + '\nproperty float x\nend_header\n'), crypto.randomBytes(64)]); }
function lopertik() {
  const hp = path.join(TAKEN, '..loper.json.tmp'); fs.writeFileSync(hp, JSON.stringify({ versie: '0.2.0-nep', bezig: NL.bezig, taak: NL.taak, tijd_s: Date.now() / 1000 })); fs.renameSync(hp, path.join(TAKEN, '.loper.json'));
  for (const n of fs.readdirSync(TAKEN)) {
    if (!/^st-[a-f0-9]{16}$/.test(n)) continue;
    const m = path.join(TAKEN, n);
    try {
      if (fs.existsSync(path.join(m, 'klaar.json'))) continue;
      if (!fs.existsSync(path.join(m, 'geclaimd'))) {
        if (NL.bezig) continue;
        fs.writeFileSync(path.join(m, 'geclaimd'), '{}');
        const inv = fs.readdirSync(path.join(m, 'invoer')).sort();
        NL.gezien.push({ naam: n, invoer: inv, kop: inv.map((f) => jpegKop(fs.readFileSync(path.join(m, 'invoer', f)))),
          maat: (() => { try { return execFileSync('python3', ['-I', '-c', 'import sys; from PIL import Image; print(*Image.open(sys.argv[1]).size)', path.join(m, 'invoer', inv[0])]).toString().trim(); } catch (e) { return null; } })() });
        NL.bezig = true; NL.taak = n; NL.start = Date.now();
        continue;
      }
      if (NL.taak !== n || Date.now() - NL.start < 150) continue;
      fs.mkdirSync(path.join(m, 'uit'), { recursive: true });
      fs.writeFileSync(path.join(m, 'uit', 'scene.ply'), plyBytes(1500000));
      fs.writeFileSync(path.join(m, 'meting.json'), JSON.stringify({ ok: true, puntjes: 1500000, rekenen_s: 9.8, vram_piek_toestel_mib: 14304, netwerkpogingen: 0 }));
      fs.writeFileSync(path.join(m, 'klaar.json'), JSON.stringify({ ok: true, status: 'ok', exitcode: 0, duur_s: 26.0, loper: '0.2.0',
        netwerk: { verbindingen_naar_buiten: 0, details: [], rekenproces_sockets: 0, rekenproces_details: [] } }));
      NL.bezig = false; NL.taak = null;
    } catch (e) { if (e && e.code !== 'ENOENT') throw e; }
  }
}
const loperTimer = setInterval(lopertik, 30);

(async () => {
  // ── immich.js: nieuwsteFotos(max, true) = alleen video's met duur ──
  const ids = Array.from({ length: 6 }, uuid), verzoeken = [];
  const BAK = { id: ids, isImage: [true, false, false, true, false, false], isTrashed: [false, false, true, false, false, false], visibility: ids.map(() => 'timeline'),
    ratio: ids.map(() => 1.7777), duration: [null, '0:00:20.033000', '0:00:05.000', null, 'kapot', '0:01:30.4'], fileCreatedAt: ids.map(() => '2026-11-27T10:00:00.000'), localOffsetHours: ids.map(() => 1) };
  const nepFetch = async (url, o) => {
    const u = new URL(url); verzoeken.push({ pad: u.pathname, q: Object.fromEntries(u.searchParams), m: (o && o.method) || 'GET' });
    const j = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/api/timeline/buckets') return j(Array.from({ length: 14 }, (_, i) => ({ timeBucket: '2026-' + String(12 - (i % 12)).padStart(2, '0') + '-01', count: 6 })));
    if (u.pathname === '/api/timeline/bucket') return j(u.searchParams.get('timeBucket') === '2026-12-01' ? BAK : { id: [] });
    if (u.pathname.startsWith('/api/assets/')) return j({ id: u.pathname.split('/')[3], type: 'VIDEO', duration: '0:00:20.033000', originalMimeType: 'video/mp4', exifInfo: {} });
    return new Response('{}', { status: 404 });
  };
  const c = IMM.maak({ basis: 'http://127.0.0.1:9', sleutel: async () => 'nep-sleutel', fetch: nepFetch });
  const nv = await c.nieuwsteFotos(24, true);
  toets('i1 nieuwsteFotos(…, true): alleen video\'s, prullenbak eruit, duur in seconden (onleesbaar = null)', JSON.stringify(nv.map((x) => [x.id, x.duur])) === JSON.stringify([[ids[1], 20], [ids[4], null], [ids[5], 90]]), nv);
  toets('i2 video: tot een jaar terug (12 maanden), alleen de toegestane tijdlijnvorm', verzoeken.filter((v) => v.pad === '/api/timeline/bucket').length === 12
    && verzoeken.every((v) => v.m === 'GET' && v.q.order === 'desc' && v.q.visibility === 'timeline' && !('albumId' in v.q)), verzoeken.length);
  verzoeken.length = 0;
  const nf = await c.nieuwsteFotos(24);
  toets('i3 zonder video-vlag: alleen foto\'s, zonder duur, hooguit 3 maanden (zoals wv4173)', JSON.stringify(nf.map((x) => x.id)) === JSON.stringify([ids[0], ids[3]]) && nf.every((x) => !('duur' in x))
    && verzoeken.filter((v) => v.pad === '/api/timeline/bucket').length === 3, nf);
  const fi = await c.fotoInfo(ids[1]);
  toets('i4 fotoInfo: duur van een video (20 s)', fi && fi.beeld === false && fi.duur === 20, fi);

  // ── studio ──
  await new Promise((r) => comfy.listen(0, '127.0.0.1', r));
  await totDat(() => fs.existsSync(path.join(TAKEN, '.loper.json')));
  const DIR = path.join(W, 'studio'); fs.mkdirSync(path.join(DIR, 'flows', 'fotos-naar-3d'), { recursive: true });
  const FLOW = JSON.parse(fs.readFileSync('studio-flows/fotos-naar-3d/flow.yaml', 'utf8'));
  toets('f1 flow.yaml noemt het filmpje (titel en uitleg)', /film/i.test(FLOW.titel) && /filmpje/.test(FLOW.uitleg) && /filmpje/i.test(FLOW.velden[0].label), [FLOW.titel, FLOW.velden[0].label]);
  fs.writeFileSync(path.join(DIR, 'flows', 'fotos-naar-3d', 'flow.yaml'), JSON.stringify(Object.assign({}, FLOW, { max_per_dag: 30 })));
  const bewaard = {}, logs = [], fouts = [];
  const bewaar = (id, out) => { const l = fs.readdirSync(out); bewaard[id] = l; return { bestanden: l.map((n, i) => ({ n: i + 1, naam: n, grootte: fs.statSync(path.join(out, n)).size })) }; };
  const S = studioMod.maak({ dir: DIR, bewaar, primair: () => true, sleutel: async () => null, routerUrl: 'http://127.0.0.1:1', comfyUrl: 'http://127.0.0.1:' + comfy.address().port, flowstudioUrl: 'http://127.0.0.1:1',
    taalmodelUrl: null, immich: () => immich, log: (r) => logs.push(r), fout: (w, e) => fouts.push(w + ': ' + (e && e.message)),
    splat: { taken: TAKEN, opslag: OPSLAG, bundel: BUNDEL, uid: process.getuid(), st_cmd: [process.execPath, NEPST], olares_hosts_vast: ['192.168.20.54'], claim_ms: 2000, stop_bevestig_ms: 700, hangt_box_ms: 900, wees_ms: 1000, vrij_min: 1024 * 1024 },
    box: () => {}, wisBewaard: () => true, tempo: { poll: 30, wachtStap: 40, wachtMax: 1500 } });
  const ctx = { versOk: () => true, versVerbruik: () => {}, apparaat: 'toets' };
  let bn = 0; const nb = () => 'beurt-' + (++bn) + '-' + crypto.randomBytes(3).toString('hex');
  const wacht = async (id) => { await totDat(() => { const t = S.taak(id); return t && ['klaar', 'mislukt', 'gestopt'].includes(t.status); }, 60000); return S.taak(id); };
  const maak = (velden) => S.maak({ flow: 'fotos-naar-3d', beurt_id: nb(), velden: { fotos: velden } }, ctx);

  const fl = (await S.flows()).flows.find((f) => f.id === 'fotos-naar-3d');
  toets('s1 veld beelden: bron ook immich_video, filmgrenzen 3–180 s', fl && fl.velden[0].bron.includes('immich_video') && fl.velden[0].film && fl.velden[0].film.min_s === 3 && fl.velden[0].film.max_s === 180, fl && fl.velden[0]);

  const vLig = zetAsset({ pad: path.join(V, 'liggend.mp4'), duur: 20 });
  const vStaand = zetAsset({ pad: path.join(V, 'staand.mp4'), duur: null });
  const vKortOnbekend = zetAsset({ pad: path.join(V, 'kort.mp4'), duur: null });
  const vLijst = zetAsset({ pad: path.join(V, 'lijst.m3u8'), duur: null });
  const foto = zetAsset({ beeld: true }), weg = zetAsset({ prullenbak: true, duur: 20 }), kort = zetAsset({ duur: 2 }), lang = zetAsset({ duur: 400 });
  // weigeringen bij Maak
  const rx = await maak({ immich_video: 'geen-uuid' });
  toets('m1 geen UUID: 400', rx.status === 400 && /onbekend filmpje/.test(rx.fout), rx);
  const rf = await maak({ immich_video: foto });
  toets('m2 een foto als filmpje: 415', rf.status === 415 && /foto/.test(rf.fout), rf);
  const rw = await maak({ immich_video: weg });
  toets('m3 prullenbak: 409', rw.status === 409 && /prullenbak/.test(rw.fout), rw);
  const rk = await maak({ immich_video: kort }), rl = await maak({ immich_video: lang });
  toets('m4 volgens Immich te kort (2 s) of te lang (400 s): 409', rk.status === 409 && /korter/.test(rk.fout) && rl.status === 409 && /langer/.test(rl.fout), [rk, rl]);
  const vAnder = zetAsset({ pad: path.join(V, 'liggend.mp4'), duur: 20, eigenaar: uuid() });
  const ra = await maak({ immich_video: vAnder });
  toets('m7 filmpje van iemand anders (gedeeld album): 403, niets gehaald (review Codex MOET 1)', ra.status === 403 && /niet van jou/.test(ra.fout), ra);
  const ro = await maak({ immich_video: uuid() });
  toets('m5 onbekend filmpje: 404', ro.status === 404, ro);
  toets('m6 bij al die weigeringen niets gehaald', IM.gehaald.length === 0, IM.gehaald.length);

  // liggend filmpje van 20 s → klaar
  const rA = await maak({ immich_video: vLig });
  toets('v1 filmpje: taak in de rij', rA.status === 200, rA);
  const tA = await wacht(rA.taak.id);
  toets('v2 filmpje: klaar', tA.status === 'klaar', tA);
  const gA = NL.gezien[NL.gezien.length - 1] || {};
  toets('v3 32 beeldjes naar de 3D-app (01–32.jpg), lange zijde ≤ 1600', gA.invoer && gA.invoer.length === 32 && gA.invoer[0] === '01.jpg' && gA.invoer[31] === '32.jpg' && gA.maat === '1280 720', gA);
  toets('v4 zonder metadata: geen APP1/APP2/APP13', gA.kop && gA.kop.every((k) => k && !k.some((m) => [0xe1, 0xe2, 0xed].includes(m))));
  toets('v5 taak.splat: bron video, 32 beeldjes, film 20 s, ± 192 kandidaten, scherpte gemeten', tA.splat && tA.splat.bron === 'video' && tA.splat.fotos === 32 && Math.abs(tA.splat.film_s - 20) < 0.5
    && tA.splat.kandidaten >= 180 && tA.splat.kandidaten <= 200 && tA.splat.scherpte && tA.splat.scherpte.gekozen >= tA.splat.scherpte.laagste && typeof tA.splat.bewogen === 'number', tA.splat);
  const takenJson = fs.readFileSync(path.join(DIR, 'taken.json'), 'utf8');
  toets('v6 velden in taken.json: "(één filmpje uit Immich, 20 s)"', /"fotos": "\(één filmpje uit Immich, 20 s\)"/.test(takenJson));
  const alle = Object.keys(IM.assets);
  toets('v7 geen asset-id in taken.json of log', !alle.some((id) => takenJson.includes(id) || logs.join('\n').includes(id)));
  toets('v8 log: filmregel met duur, kandidaten, gekozen, bewogen', logs.some((l) => /studio splat taak=[a-f0-9]{16} film_s=20 kandidaten=\d+ gekozen=32 bewogen=\d+ ms=\d+/.test(l)), logs.slice(-4));
  toets('v9 werkmap van de pod leeg (filmpje en beeldjes weg); taakmap van de app weg', !fs.existsSync(path.join(DIR, 'werk', tA.id)) && !fs.existsSync(path.join(TAKEN, 'st-' + tA.id)));
  const kaart = JSON.parse(fs.readFileSync(path.join(OPSLAG, tA.id, 'kaart.json'), 'utf8'));
  toets('v10 kaart.json: bron video, film-blok (s, kandidaten, scherpte)', kaart.bron === 'video' && kaart.film && Math.abs(kaart.film.s - 20) < 0.5 && kaart.film.kandidaten > 0 && kaart.film.scherpte, kaart.film);
  toets('v11 Bestanden: alleen voorbeeld.jpg', JSON.stringify(bewaard[tA.id]) === '["voorbeeld.jpg"]', bewaard[tA.id]);
  const lijst = S.splatLijst ? S.splatLijst() : null;
  const sc = lijst && (lijst.scenes || lijst.lijst || []).find((x) => x.id === tA.id);
  toets('v12 Mijn 3D-scènes: bron video', sc && sc.bron === 'video', lijst);

  // staand filmpje, duur niet bekend bij Immich → ffmpeg meet zelf; rechtop
  const rB = await maak({ immich_video: vStaand });
  const tB = await wacht(rB.taak.id);
  const gB = NL.gezien[NL.gezien.length - 1] || {};
  toets('v13 staand filmpje (draaiing 90° in de kop): klaar, beeldjes rechtop (360 × 640), duur door ffmpeg gemeten (8 s)', tB.status === 'klaar' && gB.maat === '360 640' && Math.abs(tB.splat.film_s - 8) < 0.5, [tB.status, gB.maat, tB.splat, tB.reden]);
  // te kort volgens ffmpeg
  const rC = await maak({ immich_video: vKortOnbekend });
  const tC = await wacht(rC.taak.id);
  toets('v14 2 s (Immich wist het niet): mislukt "korter dan 3 seconden", niets klaargezet, werkmap leeg', tC.status === 'mislukt' && /korter dan 3 seconden/.test(tC.reden || '') && !fs.existsSync(path.join(DIR, 'werk', tC.id)), [tC.status, tC.reden]);
  // geen gewoon filmformaat (afspeellijst) → ffmpeg weigert
  const rD = await maak({ immich_video: vLijst });
  const tD = await wacht(rD.taak.id);
  toets('v15 afspeellijst in plaats van filmpje: mislukt "kan de pod niet lezen", werkmap leeg', tD.status === 'mislukt' && /niet lezen/.test(tD.reden || '') && !fs.existsSync(path.join(DIR, 'werk', tD.id)), [tD.status, tD.reden]);

  // kiezerlijsten
  IM.nieuwVideo = vLig;
  const kf = await S.immichFilmpjes();
  toets('k1 nieuwste filmpjes: id, ratio, dag, duur', kf.status === 200 && kf.fotos.length === 1 && kf.fotos[0].id === vLig && kf.fotos[0].duur === 20, kf);
  const albumId = uuid(); IM.albums[albumId] = [{ id: foto, beeld: true, dag: '2026-11-27' }, { id: vLig, beeld: false, dag: '2026-11-27', duur: 20, ratio: 1.778 }];
  const ka = await S.immichAlbumFilmpjes(albumId);
  toets('k2 filmpjes in een album: alleen de video', ka.status === 200 && ka.fotos.length === 1 && ka.fotos[0].id === vLig && ka.fotos[0].duur === 20, ka);
  const kb = await S.immichAlbumFilmpjes('x'), kc = await S.immichAlbumFilmpjes(uuid());
  toets('k3 ongeldig album 400, onbekend album 404', kb.status === 400 && kc.status === 404, [kb, kc]);
  // foto's blijven werken zoals voorheen (geen video in een fotolijst)
  const kd = await S.immichFotos(albumId);
  toets('k4 fotolijst van een album: nog steeds zonder video', kd.status === 200 && kd.fotos.length === 1 && kd.fotos[0].id === foto, kd);
  toets('z1 geen onverwachte fouten gelogd', fouts.length === 0, fouts);

  clearInterval(loperTimer); comfy.close();
  try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + goed + ' groen, ' + fout + ' rood');
  process.exit(fout ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
