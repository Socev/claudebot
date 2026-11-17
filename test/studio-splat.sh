#!/usr/bin/env bash
# Toetst de Studio-motor splat ("Foto's → 3D", wv3272) tegen een NEP-LOPER die het taakmap-protocol van de Olares-app splat naspeelt
# (claim, stand, uit/scene.ply, meting.json, klaar.json, hartslag taken/.loper.json, stop), een nagebootste ComfyUI (rij + VRAM) en een
# nep-Immich, met de echte studio-beeld.py (Pillow). splat-transform is een nep (schrijft zijn argumenten in het uitbestand); als de echte
# 2.6.0 in /opt/data/infinisplat/st staat, zet één toets daarnaast een kleine verzonnen scène echt om naar .sog.
# Toetst: veldsoort beelden (album/los, 2–32, uniek, UUID), album met video's en > 32 foto's (32, gelijkmatig, op tijd), EXIF/GPS eruit
# (geen APP1 in wat de app krijgt), geen asset-id in taken.json/audit/log, poort (geen hartslag, plafond vol, VRAM-wacht), taakmap-
# protocol tot klaar (opslag, kaart.json, Bestanden alleen voorbeeld.jpg, taakmap weg), netwerkafwijking (adres buiten / pogingen) = mislukt
# + box-rij, symlinks (scene.ply, uit/, stop) volgt de pod niet, stop met bevestiging, loper reageert niet op stop → slot blijft dicht tot
# bevestigd, hartslag weg > grens → box-rij en andere taken weer door, niet geclaimd → weg, routes kaart/bestand/verwijder, opruimronde.
# Raakt /opt/data niet. Gebruik: bash test/studio-splat.sh
set -u
cd "$(dirname "$0")/.." || exit 1
python3 -c "import PIL" 2>/dev/null || { echo "ROOD  python3 met Pillow ontbreekt"; exit 1; }
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto'), { execFileSync } = require('child_process');
const studioMod = require('./studio.js');
const L = require('./studio-splat.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-splat-'));
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 15000); while (Date.now() < t) { if (await f()) return true; await slaap(20); } return false; }
const uuid = () => crypto.randomUUID();

// ── proeffoto's (verzonnen: effen vlakken, EXIF met nep-GPS en oriëntatie 6) ──
const B = path.join(W, 'beelden'); fs.mkdirSync(B);
execFileSync('python3', ['-I', '-c', `
import sys, os
from PIL import Image
d = sys.argv[1]
ex = Image.Exif(); ex[0x0112] = 6; ex[0x010f] = 'NepCamera'
ex[0x8825] = {1: 'N', 2: (52.0, 9.0, 1.0), 3: 'E', 4: (5.0, 23.0, 1.0)}
Image.new('RGB', (2400, 1800), (40, 90, 160)).save(os.path.join(d, 'gps.jpg'), exif=ex.tobytes(), icc_profile=b'\\0' * 128, quality=90)
Image.new('RGB', (900, 700), (200, 60, 30)).save(os.path.join(d, 'gewoon.png'))
`, B]);
const GPS = fs.readFileSync(path.join(B, 'gps.jpg')), PNG = fs.readFileSync(path.join(B, 'gewoon.png'));
function jpegKop(b) {   // markers tot SOS
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const uit = []; let i = 2;
  while (i + 4 <= b.length) { if (b[i] !== 0xff) return null; const m = b[i + 1]; uit.push(m); if (m === 0xda) break; i += 2 + b.readUInt16BE(i + 2); }
  return uit;
}
toets('proeffoto heeft echt APP1 (EXIF) en APP2 (ICC)', (jpegKop(GPS) || []).includes(0xe1) && (jpegKop(GPS) || []).includes(0xe2));

// ── nep-Immich ──
const IM = { assets: {}, albums: {}, gehaald: [] };
function zetAsset(o) { const id = uuid(); IM.assets[id] = Object.assign({ beeld: true, mime: 'image/jpeg', data: GPS }, o); return id; }
const immich = {
  fotoInfo: async (id) => { const a = IM.assets[id]; return a ? { beeld: a.beeld, mime: a.mime, grootte: a.data.length, prullenbak: false } : null; },
  origineel: async (id) => { IM.gehaald.push(id); return { data: IM.assets[id].data }; },
  beeld: async (id) => ({ data: IM.assets[id].data, mime: 'image/jpeg' }),
  albumFotos: async (albumId) => { const l = IM.albums[albumId]; if (!l) { const e = new Error('x'); e.code = 'HTTP'; e.status = 404; throw e; } return l.map((x) => Object.assign({}, x)); },
};

// ── nagebootste ComfyUI (alleen rij en VRAM) ──
const C = { vram: 24000 * 1048576, bezig: false };
const comfy = http.createServer((req, res) => {
  const stuur = (j) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
  if (req.url === '/queue') return stuur({ queue_running: C.bezig ? [[1, 'x']] : [], queue_pending: [] });
  if (req.url === '/system_stats') return stuur({ system: { ram_free: 60e9 }, devices: [{ vram_free: C.vram, vram_total: 25e9 }] });
  res.writeHead(404); res.end('{}');
});

// ── nep-splat-transform: schrijft zijn argumenten in het uitbestand ──
const NEPST = path.join(W, 'nep-st.js');
fs.writeFileSync(NEPST, "const a = process.argv.slice(2); require('fs').writeFileSync(a[a.length - 1], JSON.stringify({ args: a, cwd: process.cwd(), env: Object.keys(process.env).sort() }));\n");

// ── nep-loper (taakprotocol van splat/taakloper.py) ──
const TAKEN = path.join(W, 'taken'), OPSLAG = path.join(W, 'splats'), BUNDEL = path.join(W, 'bundel');
fs.mkdirSync(TAKEN, { mode: 0o700 }); fs.mkdirSync(BUNDEL); fs.writeFileSync(path.join(BUNDEL, 'bouw.json'), JSON.stringify({ git: 'ba4d86a3344a035b93b71e115f0d5a3b4abda9b6' }));
const GEHEIM = path.join(W, 'geheim.txt'); fs.writeFileSync(GEHEIM, 'niet van de pod');
const NL = { modus: 'ok', bezig: false, taak: null, hartslag: true, oud: false, gezien: [], puntjes: 1500000, schrijf: (p, d) => fs.writeFileSync(p, d) };
function plyBytes(n) { return Buffer.concat([Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex ' + n + '\nproperty float x\nend_header\n'), crypto.randomBytes(64)]); }
function lopertik() {
  if (NL.hartslag) { const hp = path.join(TAKEN, '..loper.json.tmp'); fs.writeFileSync(hp, JSON.stringify({ versie: '0.2.0-nep', bezig: NL.bezig, taak: NL.taak, tijd: new Date().toISOString(), tijd_s: Date.now() / 1000 - (NL.oud ? 300 : 0) })); fs.renameSync(hp, path.join(TAKEN, '.loper.json')); }
  let namen = []; try { namen = fs.readdirSync(TAKEN); } catch (e) {}
  for (const n of namen) { try { loperMap(n); } catch (e) { if (e && e.code !== 'ENOENT') throw e; } }
}
function loperMap(n) {
  {
    if (!/^st-[a-f0-9]{16}$/.test(n)) return;
    const m = path.join(TAKEN, n);
    if (fs.existsSync(path.join(m, 'klaar.json'))) return;
    const stop = (() => { try { fs.lstatSync(path.join(m, 'stop')); return true; } catch (e) { return false; } })();
    if (!fs.existsSync(path.join(m, 'geclaimd'))) {
      if (NL.modus === 'nooit-claim' || NL.bezig) return;
      fs.writeFileSync(path.join(m, 'geclaimd'), '{}');
      const inv = fs.readdirSync(path.join(m, 'invoer')).sort();
      NL.gezien.push({ naam: n, taak: JSON.parse(fs.readFileSync(path.join(m, 'taak.json'), 'utf8')), invoer: inv,
        kop: inv.map((f) => jpegKop(fs.readFileSync(path.join(m, 'invoer', f)))), modus: fs.statSync(m).mode & 0o777 });
      NL.bezig = true; NL.taak = n; NL.start = Date.now();
      if (stop) { klaar(m, { ok: false, status: 'gestopt', fout: 'gestopt op verzoek' }); return; }
      fs.writeFileSync(path.join(m, 'stand.json'), JSON.stringify({ fase: 'rekenen' }));
      return;
    }
    if (NL.taak !== n) return;
    if (stop && NL.modus !== 'doof') { klaar(m, { ok: false, status: 'gestopt', fout: 'gestopt op verzoek' }); return; }
    if (['langzaam', 'doof', 'link-stop'].includes(NL.modus) || Date.now() - NL.start < 150) return;
    // klaar: uitvoer schrijven volgens de modus
    fs.mkdirSync(path.join(m, 'uit'), { recursive: true });
    if (NL.modus === 'link-scene') fs.symlinkSync(GEHEIM, path.join(m, 'uit', 'scene.ply'));
    else if (NL.modus === 'link-uit') { fs.rmdirSync(path.join(m, 'uit')); fs.mkdirSync(path.join(W, 'elders'), { recursive: true }); fs.writeFileSync(path.join(W, 'elders', 'scene.ply'), plyBytes(10)); fs.symlinkSync(path.join(W, 'elders'), path.join(m, 'uit')); }
    else fs.writeFileSync(path.join(m, 'uit', 'scene.ply'), plyBytes(NL.puntjes));
    const details = ['tcp 10.233.1.177:6000 01', 'tcp 192.168.20.54:33686 06'].concat(NL.modus === 'buiten' ? ['tcp 140.82.121.4:443 01'] : []);
    fs.writeFileSync(path.join(m, 'meting.json'), JSON.stringify({ ok: true, puntjes: NL.puntjes, laden_s: 13.3, rekenen_s: 9.8, vram_piek_toestel_mib: 14304,
      netwerkpogingen: NL.modus === 'pogingen' ? 2 : 0, spoor: '/splat/code/geheim/pad.py', fotos: 32 }));
    klaar(m, { ok: true, status: 'ok', exitcode: 0, duur_s: 26.0, loper: '0.2.0', netwerk: { verbindingen_naar_buiten: details.length, details,
      rekenproces_sockets: 1, rekenproces_details: ['tcp 10.233.1.177:6000 01'], monsters: 50, interval_s: 0.5 } });
  }
}
function klaar(m, k) {
  if (!k.netwerk) k.netwerk = { verbindingen_naar_buiten: 0, details: [], rekenproces_sockets: 0, rekenproces_details: [] };
  fs.writeFileSync(path.join(m, 'klaar.json'), JSON.stringify(k));
  NL.bezig = false; NL.taak = null;
}
const loperTimer = setInterval(lopertik, 30);

(async () => {
  await new Promise((r) => comfy.listen(0, '127.0.0.1', r));
  await totDat(() => fs.existsSync(path.join(TAKEN, '.loper.json')));
  const CURL = 'http://127.0.0.1:' + comfy.address().port;
  const DIR = path.join(W, 'studio'); fs.mkdirSync(path.join(DIR, 'flows', 'fotos-naar-3d'), { recursive: true });
  const FLOW = JSON.parse(fs.readFileSync('studio-flows/fotos-naar-3d/flow.yaml', 'utf8'));
  toets('flow.yaml: proef, max_per_dag 6, max_seconden 900, gpu_mib_schatting 16000', FLOW.status === 'proef' && FLOW.max_per_dag === 6 && FLOW.max_seconden === 900 && FLOW.gpu_mib_schatting === 16000, FLOW);
  fs.writeFileSync(path.join(DIR, 'flows', 'fotos-naar-3d', 'flow.yaml'), JSON.stringify(Object.assign({}, FLOW, { max_per_dag: 30 })));   // de toets maakt meer dan 6 taken
  const BEW = path.join(W, 'bestanden'); fs.mkdirSync(BEW);
  const bewaard = {}, gewistBewaard = [], boxen = [], logs = [], fouts = [];
  const bewaar = (id, out, meta) => { const l = fs.readdirSync(out); fs.mkdirSync(path.join(BEW, id), { recursive: true }); l.forEach((n) => fs.copyFileSync(path.join(out, n), path.join(BEW, id, n))); bewaard[id] = { namen: l, meta }; return { bestanden: l.map((n, i) => ({ n: i + 1, naam: n, grootte: fs.statSync(path.join(out, n)).size })) }; };
  const SPC = { taken: TAKEN, opslag: OPSLAG, bundel: BUNDEL, uid: process.getuid(), st_cmd: [process.execPath, NEPST], claim_ms: 700, stop_bevestig_ms: 700, hangt_box_ms: 900, wees_ms: 1000, vrij_min: 1024 * 1024 };   // vrije schijf: eigen toets (S3)
  const S = studioMod.maak({ dir: DIR, bewaar, primair: () => true, sleutel: async () => null, routerUrl: 'http://127.0.0.1:1', comfyUrl: CURL, flowstudioUrl: 'http://127.0.0.1:1',
    taalmodelUrl: null, immich: () => immich, log: (r) => logs.push(r), fout: (w, e) => fouts.push(w + ': ' + (e && e.message)), splat: SPC,
    box: (kop, regels) => boxen.push({ kop, regels }), wisBewaard: (id) => { gewistBewaard.push(id); return true; },
    tempo: { poll: 30, wachtStap: 40, wachtMax: 1500 } });
  let vers = true;
  const ctx = { versOk: () => vers, versVerbruik: () => {}, apparaat: 'toets' };
  let bn = 0; const nb = () => 'beurt-' + (++bn) + '-' + crypto.randomBytes(3).toString('hex');
  const wacht = async (id, ms) => { await totDat(() => { const t = S.taak(id); return t && ['klaar', 'mislukt', 'gestopt'].includes(t.status); }, ms || 20000); return S.taak(id); };
  const maak = (velden) => S.maak({ flow: 'fotos-naar-3d', beurt_id: nb(), velden: { fotos: velden } }, ctx);

  // album: 40 foto's (afwisselend jpg met GPS en png) en 5 video's, door elkaar op tijd
  const albumId = uuid(), albumIds = [];
  const items = [];
  for (let i = 0; i < 40; i++) { const id = zetAsset(i % 2 ? { data: PNG, mime: 'image/png' } : {}); albumIds.push(id); items.push({ id, beeld: true, dag: '2026-11-17', tijd: '07:' + String(10 + i).padStart(2, '0') }); }
  for (let i = 0; i < 5; i++) items.push({ id: zetAsset({ beeld: false, mime: 'video/mp4' }), beeld: false, dag: '2026-11-17', tijd: '07:3' + i });
  IM.albums[albumId] = items.slice().reverse();   // Immich-volgorde ≠ opnametijd: de pod sorteert zelf

  // 1. catalogus
  let fl = (await S.flows()).flows.find((f) => f.id === 'fotos-naar-3d');
  toets('flow in de lijst: motor splat, uitvoer 3d, vast schermzinnetje, veld beelden 2–32', fl && fl.motor === 'splat' && fl.uitvoer === '3d' && /nooit iets uit de praktijk of met patiënten/.test(fl.waarschuwing)
    && fl.velden.length === 1 && fl.velden[0].soort === 'beelden' && fl.velden[0].min === 2 && fl.velden[0].max === 32 && /3D-app op Olares/.test(fl.motor_naam), fl);
  toets('met verse hartslag: klaar', fl && fl.klaar === true, fl);

  // 2. invoer
  const r1 = await maak({ immich: [albumIds[0]] });
  const r2 = await maak({ immich: albumIds.slice(0, 33).concat(albumIds.slice(0, 0)) });
  const r3 = await maak({ immich: [albumIds[0], albumIds[0]] });
  const r4 = await maak({ immich: ['geen-uuid', albumIds[1]] });
  const r5 = await maak({});
  const r6 = await maak({ immich_album: 'x' });
  toets('invoer geweigerd: 1 foto, 33 foto\'s, dubbel, geen UUID, niets, ongeldig album', [r1, r2, r3, r4, r5, r6].every((r) => r.status === 400), [r1, r2, r3, r4, r5, r6].map((r) => r.fout));
  vers = false;
  const r7 = await maak({ immich_album: albumId });
  vers = true;
  toets('op proef zonder verse vingerafdruk: 403', r7.status === 403 && r7.vers_nodig === true, r7);
  const r8 = await maak({ immich_album: uuid() });
  toets('onbekend album: 404', r8.status === 404, r8);

  // 3. heel album → klaar
  const rA = await maak({ immich_album: albumId });
  toets('album: taak in de rij', rA.status === 200, rA);
  const tA = await wacht(rA.taak.id);
  toets('album: klaar', tA.status === 'klaar', tA);
  const gA = NL.gezien[NL.gezien.length - 1] || {};
  toets('album met 40 foto\'s + 5 video\'s: 32 foto\'s naar de app, taak.json {id st-<taak>, 518, 32}', gA.invoer && gA.invoer.length === 32 && gA.taak.id === 'st-' + tA.id && gA.taak.long_side === 518 && gA.taak.max_views === 32, gA);
  toets('taakmap 0700', gA.modus === 0o700, gA.modus);
  toets('geen video gehaald, gelijkmatig op opnametijd (eerste en laatste foto van het album erbij)', IM.gehaald.length === 32 && IM.gehaald.every((id) => IM.assets[id].beeld) && IM.gehaald[0] === albumIds[0] && IM.gehaald[31] === albumIds[39], IM.gehaald.length);
  toets('EXIF/GPS/ICC eruit: geen APP1/APP2/APP13 in wat de app kreeg', gA.kop && gA.kop.every((k) => k && !k.some((m) => [0xe1, 0xe2, 0xed].includes(m))), gA.kop && gA.kop.slice(0, 2));
  toets('taak: splat.bron album, 32 foto\'s, 40 in het album; puntjes en maten', tA.splat && tA.splat.bron === 'album' && tA.splat.fotos === 32 && tA.splat.in_album === 40
    && tA.splat.puntjes.ruw === 1500000 && tA.splat.puntjes.vol === 1500000 && tA.splat.puntjes.licht === 1000000 && tA.splat.bytes.licht > 0, tA.splat);
  const scene = path.join(OPSLAG, tA.id);
  const lst = fs.existsSync(scene) ? fs.readdirSync(scene).sort() : [];
  toets('opslag: kaart.json, licht.sog, ruw.ply, voorbeeld.jpg, vol.sog (geen tijdelijke bestanden)', JSON.stringify(lst) === JSON.stringify(['kaart.json', 'licht.sog', 'ruw.ply', 'vol.sog', 'voorbeeld.jpg']), lst);
  const lichtArg = JSON.parse(fs.readFileSync(path.join(scene, 'licht.sog'), 'utf8')), volArg = JSON.parse(fs.readFileSync(path.join(scene, 'vol.sog'), 'utf8'));
  toets('splat-transform: -q -w -g cpu; licht -F 1000000, vol zonder uitdunnen (1,5 mln < 3 mln); cwd = scènemap; env zonder geheimen', JSON.stringify(lichtArg.args) === JSON.stringify(['-q', '-w', '-g', 'cpu', 'ruw.ply', '-F', '1000000', 'licht.sog'])
    && JSON.stringify(volArg.args) === JSON.stringify(['-q', '-w', '-g', 'cpu', 'ruw.ply', 'vol.sog']) && fs.realpathSync(lichtArg.cwd) === fs.realpathSync(scene)
    && JSON.stringify(lichtArg.env) === JSON.stringify(['HOME', 'LANG', 'NODE_OPTIONS', 'PATH']), [lichtArg, volArg]);
  const kaart = JSON.parse(fs.readFileSync(path.join(scene, 'kaart.json'), 'utf8'));
  toets('kaart.json: model (bundel-git, gewichten-sha256), sha256 per bestand, netwerk 0 pogingen, meting zonder spoor/paden', kaart.model.bundel_git === 'ba4d86a3344a035b93b71e115f0d5a3b4abda9b6'
    && /^6d23f9ce/.test(kaart.model.gewichten_sha256) && /^[0-9a-f]{64}$/.test(kaart.sha256['licht.sog']) && /^[0-9a-f]{64}$/.test(kaart.sha256['ruw.ply'])
    && kaart.netwerk.pogingen === 0 && kaart.netwerk.buiten === 0 && !JSON.stringify(kaart).includes('/splat/') && kaart.meting.vram_piek_toestel_mib === 14304, kaart);
  toets('ruw.ply = byte voor byte de scene.ply van de app (sha256)', kaart.sha256['ruw.ply'] === crypto.createHash('sha256').update(fs.readFileSync(path.join(scene, 'ruw.ply'))).digest('hex'));
  toets('taakmap van de app weg (Davids foto\'s niet langer dan nodig)', !fs.existsSync(path.join(TAKEN, 'st-' + tA.id)) && !fs.existsSync(path.join(TAKEN, 'st-' + tA.id + '.nieuw')));
  toets('Bestanden: alleen voorbeeld.jpg', JSON.stringify((bewaard[tA.id] || {}).namen) === '["voorbeeld.jpg"]' && tA.bestanden.length === 1, bewaard[tA.id]);
  toets('werkmap van de pod leeg', !fs.existsSync(path.join(DIR, 'werk', tA.id)));
  const takenJson = fs.readFileSync(path.join(DIR, 'taken.json'), 'utf8'), audit = fs.existsSync(path.join(DIR, 'audit.jsonl')) ? fs.readFileSync(path.join(DIR, 'audit.jsonl'), 'utf8') : '';
  const alleIds = Object.keys(IM.assets).concat([albumId]);
  toets('geen asset-id of album-id in taken.json, audit of log', !alleIds.some((id) => takenJson.includes(id) || audit.includes(id) || logs.join('\n').includes(id)), null);
  toets('velden in taken.json: alleen "(32 foto\'s uit een album)"', /"fotos": "\(32 foto's uit een album\)"/.test(takenJson));
  toets('log: netwerktellingen van de taak', logs.some((l) => /studio splat taak=[a-f0-9]{16} status=ok .*netwerkpogingen=0 sockets=2 rekenproces=1 buiten=0/.test(l)), logs.slice(-5));

  // 4. routes: kaart, bestand, verwijder
  const kr = S.splatKaart(tA.id);
  toets('kaart-route: maten, puntjes, ruw aanwezig', kr.status === 200 && kr.kaart.puntjes.licht === 1000000 && kr.kaart.bytes.licht > 0 && kr.kaart.ruw === true, kr);
  const br = S.splatBestand(tA.id, 'licht');
  let inhoud = null;
  if (br.status === 200) { inhoud = await new Promise((r) => { const d = []; const rs = fs.createReadStream('', { fd: br.fd, autoClose: true }); rs.on('data', (b) => d.push(b)); rs.on('end', () => r(Buffer.concat(d))); }); }
  toets('bestand-route: fd met de juiste lengte en inhoud', br.status === 200 && br.grootte === fs.statSync(path.join(scene, 'licht.sog')).size && inhoud.equals(fs.readFileSync(path.join(scene, 'licht.sog'))), br.status);
  toets('bestand-route: onbekende maat, onbekende id, geen hex → 404', S.splatBestand(tA.id, 'ruw').status === 404 && S.splatBestand('0123456789abcdef', 'licht').status === 404 && S.splatBestand('../../etc', 'licht').status === 404);
  // licht.sog als koppeling → niet gevolgd
  fs.renameSync(path.join(scene, 'licht.sog'), path.join(scene, 'licht.echt'));
  fs.symlinkSync(GEHEIM, path.join(scene, 'licht.sog'));
  toets('bestand-route volgt geen koppeling', S.splatBestand(tA.id, 'licht').status === 404);
  fs.unlinkSync(path.join(scene, 'licht.sog')); fs.renameSync(path.join(scene, 'licht.echt'), path.join(scene, 'licht.sog'));

  // 5. netwerkafwijkingen
  NL.modus = 'buiten';
  let t = await wacht((await maak({ immich: albumIds.slice(0, 4) })).taak.id);
  toets('adres buiten Olares: mislukt, scène niet bewaard, taakmap weg, box-rij', t.status === 'mislukt' && /netwerkafwijking/.test(t.reden) && !fs.existsSync(path.join(OPSLAG, t.id)) && !fs.existsSync(path.join(TAKEN, 'st-' + t.id))
    && boxen.length === 1 && /#infinisplat/.test(boxen[0].kop) && !alleIds.some((id) => JSON.stringify(boxen).includes(id)), [t.reden, boxen]);
  NL.modus = 'pogingen';
  t = await wacht((await maak({ immich: albumIds.slice(0, 3) })).taak.id);
  toets('netwerkpogingen > 0: mislukt + box-rij', t.status === 'mislukt' && /2 netwerkpoging/.test(t.reden) && boxen.length === 2, t.reden);

  // 6. koppelingen in de gedeelde taakmap
  NL.modus = 'link-scene';
  const geheimVoor = fs.readFileSync(GEHEIM, 'utf8');
  t = await wacht((await maak({ immich: albumIds.slice(0, 2) })).taak.id);
  toets('scene.ply als koppeling: mislukt, niets gekopieerd, doel onaangetast', t.status === 'mislukt' && /koppeling/.test(t.reden) && !fs.existsSync(path.join(OPSLAG, t.id)) && fs.readFileSync(GEHEIM, 'utf8') === geheimVoor, t.reden);
  NL.modus = 'link-uit';
  t = await wacht((await maak({ immich: albumIds.slice(0, 2) })).taak.id);
  toets('uit/ als koppeling: mislukt', t.status === 'mislukt' && /uit\/ is geen echte map/.test(t.reden), t.reden);
  // stop als koppeling (de app zet `stop` vóór de pod het doet) → de pod maakt niets aan op het doel
  NL.modus = 'link-stop';
  const doelStop = path.join(W, 'stop-doel-bestaat-niet');
  let rS = await maak({ immich: albumIds.slice(0, 2) });
  await totDat(() => NL.taak === 'st-' + rS.taak.id);
  fs.symlinkSync(doelStop, path.join(TAKEN, 'st-' + rS.taak.id, 'stop'));
  S.stop(rS.taak.id);
  t = await wacht(rS.taak.id);
  toets('stop als koppeling: de pod maakt het doel niet aan; de taak stopt', !fs.existsSync(doelStop) && t.status === 'gestopt', t);

  // 7. stop met bevestiging
  NL.modus = 'langzaam';
  rS = await maak({ immich: albumIds.slice(0, 2) });
  await totDat(() => /3D rekenen/.test(String(S.taak(rS.taak.id).fase)));
  const tijdens = S.taak(rS.taak.id);
  S.stop(rS.taak.id);
  t = await wacht(rS.taak.id);
  toets('stop: fase 3D rekenen tijdens de taak; daarna gestopt, taakmap weg, slot vrij', /3D rekenen/.test(tijdens.fase) && t.status === 'gestopt' && !fs.existsSync(path.join(TAKEN, 'st-' + t.id)) && S.teller().splat_wacht === null && !S.teller().bezig, [tijdens.fase, t]);

  // 8. loper reageert niet op stop → slot blijft dicht tot bevestigd
  NL.modus = 'doof';
  const rD = await maak({ immich: albumIds.slice(0, 2) });
  await totDat(() => NL.taak === 'st-' + rD.taak.id);
  NL.modus = 'ok';   // de volgende taak zou gewoon kunnen, als het slot open was
  const rNa = await maak({ immich: albumIds.slice(2, 4) });
  NL.modus = 'doof';
  S.stop(rD.taak.id);
  t = await wacht(rD.taak.id);
  await slaap(300);
  const stand1 = S.teller(), tNa1 = S.taak(rNa.taak.id);
  toets('loper doof: taak gestopt met noot, slot blijft dicht (splat_wacht), volgende taak blijft in de rij', t.status === 'gestopt' && /bevestigen/.test(t.reden) && stand1.splat_wacht === 'wacht tot de 3D-app stopt'
    && tNa1.status === 'wacht' && fs.existsSync(path.join(TAKEN, 'st-' + rD.taak.id, 'stop')), [t, stand1, tNa1.status]);
  const fl2 = (await S.flows()).flows.find((f) => f.id === 'fotos-naar-3d');
  toets('zolang: de flow toont "nog bezig met stoppen"', fl2.klaar === false && /stoppen/.test(fl2.reden), fl2.reden);
  S._splatRonde();
  toets('minuutronde zonder bevestiging: slot nog dicht, taakmap blijft staan', S.teller().splat_wacht && fs.existsSync(path.join(TAKEN, 'st-' + rD.taak.id)));
  // de app stopt alsnog: klaar.json
  NL.modus = 'ok';
  klaar(path.join(TAKEN, 'st-' + rD.taak.id), { ok: false, status: 'gestopt', fout: 'gestopt op verzoek' });
  S._splatRonde();
  const tNa = await wacht(rNa.taak.id);
  toets('na bevestiging: slot open, taakmap weg, volgende taak klaar', S.teller().splat_wacht === null && !fs.existsSync(path.join(TAKEN, 'st-' + rD.taak.id)) && tNa.status === 'klaar', [S.teller().splat_wacht, tNa.status, tNa.reden]);

  // 9. hartslag weg na een niet-bevestigde stop → box-rij, slot weer open voor andere taken, 3D geweigerd
  NL.modus = 'doof';
  const rH = await maak({ immich: albumIds.slice(0, 2) });
  await totDat(() => NL.taak === 'st-' + rH.taak.id);
  S.stop(rH.taak.id);
  await wacht(rH.taak.id);
  NL.oud = true;   // hartslag oud (app hangt of is weg)
  const boxVoor = boxen.length;
  await slaap(1000);
  S._splatRonde();
  toets('hartslag > grens weg: box-rij "reageert niet", splat_wacht lang', boxen.length === boxVoor + 1 && /reageert niet/.test(boxen[boxen.length - 1].kop) && /reageert niet/.test(S.teller().splat_wacht), [boxen.length - boxVoor, S.teller().splat_wacht]);
  S._splatRonde();
  toets('box-rij maar één keer', boxen.length === boxVoor + 1);
  NL.oud = false; NL.modus = 'ok';
  klaar(path.join(TAKEN, 'st-' + rH.taak.id), { ok: false, status: 'gestopt' });
  S._splatRonde();
  toets('app terug: slot open, taakmap weg', S.teller().splat_wacht === null && !fs.existsSync(path.join(TAKEN, 'st-' + rH.taak.id)));

  // 10. poort: geen hartslag, plafond, schijf, VRAM, niet geclaimd
  NL.hartslag = false; NL.oud = false;
  fs.writeFileSync(path.join(TAKEN, '.loper.json'), JSON.stringify({ versie: 'x', bezig: false, tijd_s: Date.now() / 1000 - 120 }));
  let r = await maak({ immich: albumIds.slice(0, 2) });
  toets('hartslag ouder dan 60 s: geweigerd "de 3D-app staat uit", niets klaargezet', r.status === 409 && /3D-app staat uit/.test(r.fout) && !fs.readdirSync(TAKEN).some((n) => /^st-/.test(n)), r);
  NL.hartslag = true;
  await slaap(80);
  fs.writeFileSync(path.join(OPSLAG, 'vulsel'), Buffer.alloc(3 * 1024 * 1024));
  const S2 = studioMod.maak({ dir: path.join(W, 'studio2'), bewaar, primair: () => true, sleutel: async () => null, routerUrl: 'http://127.0.0.1:1', comfyUrl: CURL, flowstudioUrl: 'http://127.0.0.1:1',
    taalmodelUrl: null, immich: () => immich, log: () => {}, fout: () => {}, splat: Object.assign({}, SPC, { plafond: 3 * 1024 * 1024 }), tempo: { poll: 30, wachtStap: 40, wachtMax: 300 } });
  fs.mkdirSync(path.join(W, 'studio2', 'flows', 'fotos-naar-3d'), { recursive: true });
  fs.copyFileSync('studio-flows/fotos-naar-3d/flow.yaml', path.join(W, 'studio2', 'flows', 'fotos-naar-3d', 'flow.yaml'));
  r = await S2.maak({ flow: 'fotos-naar-3d', beurt_id: nb(), velden: { fotos: { immich: albumIds.slice(0, 2) } } }, ctx);
  toets('plafond vol (scènes + 1 GB reservering > grens): geweigerd "ruim eerst een scène op"', r.status === 409 && /ruim eerst een scène op/.test(r.fout), r);
  fs.rmSync(path.join(OPSLAG, 'vulsel'));
  const S3 = studioMod.maak({ dir: path.join(W, 'studio3'), bewaar, primair: () => true, sleutel: async () => null, routerUrl: 'http://127.0.0.1:1', comfyUrl: CURL, flowstudioUrl: 'http://127.0.0.1:1',
    taalmodelUrl: null, immich: () => immich, log: () => {}, fout: () => {}, splat: Object.assign({}, SPC, { vrij_min: 1e18 }), tempo: { poll: 30, wachtStap: 40, wachtMax: 300 } });
  fs.mkdirSync(path.join(W, 'studio3', 'flows', 'fotos-naar-3d'), { recursive: true });
  fs.copyFileSync('studio-flows/fotos-naar-3d/flow.yaml', path.join(W, 'studio3', 'flows', 'fotos-naar-3d', 'flow.yaml'));
  r = await S3.maak({ flow: 'fotos-naar-3d', beurt_id: nb(), velden: { fotos: { immich: albumIds.slice(0, 2) } } }, ctx);
  toets('te weinig vrije schijf (< 5 GB): geweigerd', r.status === 409 && /vrije schijfruimte/.test(r.fout), r);
  C.vram = 8000 * 1048576;
  r = await S.maak({ flow: 'fotos-naar-3d', beurt_id: nb(), velden: { fotos: { immich: albumIds.slice(0, 2) } } }, ctx);
  await totDat(() => /videogeheugen/.test(String((S.taak(r.taak.id) || {}).fase)), 3000);
  const fVram = S.taak(r.taak.id).fase;
  C.vram = 24000 * 1048576;
  t = await wacht(r.taak.id);
  toets('VRAM < 16 GB: wacht (fase), daarna klaar', /te weinig vrij videogeheugen/.test(fVram) && t.status === 'klaar', [fVram, t.status]);
  NL.modus = 'nooit-claim';
  t = await wacht((await maak({ immich: albumIds.slice(0, 2) })).taak.id);
  toets('niet geclaimd binnen de grens: mislukt, taakmap weg', t.status === 'mislukt' && /pakte de taak niet op/.test(t.reden) && !fs.readdirSync(TAKEN).some((n) => /^st-/.test(n)), t.reden);
  NL.modus = 'ok';

  // 11. verwijderen
  const w1 = S.splatWis(tA.id);
  toets('verwijder: scènemap weg, voorbeeld in Bestanden gewist, audit', w1.status === 200 && !fs.existsSync(scene) && gewistBewaard.includes(tA.id)
    && /"uitkomst":"scene-gewist"/.test(fs.readFileSync(path.join(DIR, 'audit.jsonl'), 'utf8')) && S.splatKaart(tA.id).status === 404, w1);
  toets('verwijder: onbekend → 404', S.splatWis('0123456789abcdef').status === 404);

  // 12. opruimronde: ruw.ply na 30 dagen, weesmappen
  const sc2 = path.join(OPSLAG, t.id);
  const tOk = S.taken().taken.find((x) => x.status === 'klaar' && fs.existsSync(path.join(OPSLAG, x.id)));
  const ruwP = path.join(OPSLAG, tOk.id, 'ruw.ply');
  const oud = Math.floor(Date.now() / 1000) - 31 * 86400;
  fs.utimesSync(ruwP, oud, oud);
  const wees1 = path.join(TAKEN, 'st-00000000000000aa'), wees2 = path.join(TAKEN, 'st-00000000000000bb'), wees3 = path.join(TAKEN, 'st-00000000000000cc.nieuw'), vers1 = path.join(TAKEN, 'st-00000000000000dd');
  for (const m of [wees1, wees2, wees3, vers1]) fs.mkdirSync(m);
  fs.writeFileSync(path.join(wees1, 'klaar.json'), '{}'); fs.writeFileSync(path.join(vers1, 'klaar.json'), '{}');
  const oudM = Math.floor(Date.now() / 1000) - 7200;
  for (const m of [wees1, wees2, wees3]) fs.utimesSync(m, oudM, oudM);
  const vreemd = path.join(TAKEN, 'david-kamer-1'); fs.mkdirSync(vreemd); fs.utimesSync(vreemd, oudM, oudM);
  S._splatRonde();
  toets('opruimronde: ruw.ply > 30 d weg, scène zelf blijft', !fs.existsSync(ruwP) && fs.existsSync(path.join(OPSLAG, tOk.id, 'licht.sog')));
  toets('opruimronde: oude st-mappen (klaar, nooit opgepakt, .nieuw) weg; verse en vreemde blijven', !fs.existsSync(wees1) && !fs.existsSync(wees2) && !fs.existsSync(wees3) && fs.existsSync(vers1) && fs.existsSync(vreemd),
    fs.readdirSync(TAKEN));
  // een oude geclaimde map zonder klaar.json terwijl de app nog rekent (pod herstart): stop + slot dicht, niet wissen
  const wees4 = path.join(TAKEN, 'st-00000000000000ee'); fs.mkdirSync(wees4); fs.writeFileSync(path.join(wees4, 'geclaimd'), '{}'); fs.utimesSync(wees4, oudM, oudM);
  NL.modus = 'doof'; NL.bezig = true; NL.taak = 'st-00000000000000ee';
  await slaap(80);
  S._splatRonde();
  toets('na herstart: geclaimde map van de app die nog rekent → stop gezet, slot dicht, niet gewist', fs.existsSync(path.join(wees4, 'stop')) && S.teller().splat_wacht && fs.existsSync(wees4));
  NL.modus = 'ok'; klaar(wees4, { ok: false, status: 'gestopt' });
  S._splatRonde();
  toets('daarna bevestigd: slot open, map weg', !S.teller().splat_wacht && !fs.existsSync(wees4));

  // 13. symlink als taakmap van de pod (de app zet st-<id> klaar als koppeling vóór de pod): maakTaakmap weigert
  const id9 = crypto.randomBytes(8).toString('hex');
  fs.symlinkSync(path.join(W, 'elders'), path.join(TAKEN, 'st-' + id9));
  let fout9 = null; try { L.maakTaakmap(L.cfgVan(SPC), id9, [{ naam: '01.jpg', bytes: GPS }]); } catch (e) { fout9 = e.message; }
  toets('maakTaakmap: bestaande koppeling op st-<id> → geweigerd', /bestaat al/.test(String(fout9)), fout9);
  toets('mapToets: koppeling → false; schrijfStop en wisTaakmap doen dan niets', L.mapToets(L.cfgVan(SPC), 'st-' + id9) === false && L.schrijfStop(L.cfgVan(SPC), 'st-' + id9) === false
    && L.wisTaakmap(L.cfgVan(SPC), 'st-' + id9) === false && fs.existsSync(path.join(W, 'elders', 'scene.ply')) && !fs.existsSync(path.join(W, 'elders', 'stop')));
  // leesJsonVeilig: FIFO hangt niet
  const fifo = path.join(W, 'fifo.json'); try { execFileSync('mkfifo', [fifo]); } catch (e) {}
  const t0 = Date.now(); const fj = L.leesJsonVeilig(fifo);
  toets('leesJsonVeilig: FIFO → null zonder te hangen', fj === null && Date.now() - t0 < 1000);

  // 14. netwerk-duiding
  const nt = L.netwerkToets({ netwerk: { verbindingen_naar_buiten: 3, details: ['tcp 10.233.98.66:8086 01', 'tcp6 ::ffff:192.168.20.54:443 06', 'udp 0.0.0.0:0 07'], rekenproces_sockets: 0, rekenproces_details: [] } }, { netwerkpogingen: 0 });
  const nt2 = L.netwerkToets({ netwerk: { verbindingen_naar_buiten: 60, details: ['tcp 10.233.98.66:8086 01'], rekenproces_sockets: 0, rekenproces_details: [] } }, { netwerkpogingen: 0 });
  const nt3 = L.netwerkToets({ netwerk: { verbindingen_naar_buiten: 1, details: ['tcp6 2a00:1450::1:443 01'], rekenproces_sockets: 0, rekenproces_details: [] } }, { netwerkpogingen: 0 });
  const nt4 = L.netwerkToets({ netwerk: { verbindingen_naar_buiten: 0, details: [], rekenproces_sockets: 1, rekenproces_details: ['tcp 192.168.20.1:53 01'] } }, { netwerkpogingen: 0 });
  toets('netwerk: Olares-cluster, Olares-host (ook als ::ffff:) en geen tegenpartij = ok', nt.ok, nt);
  toets('netwerk: meer sockets dan opgesomd / extern IPv6 / router in het rekenproces = afwijking', nt2.afwijking && nt3.afwijking && nt4.afwijking, [nt2, nt3, nt4]);

  // 15. echte splat-transform 2.6.0 op een kleine verzonnen scène (alleen als hij er is)
  if (fs.existsSync(L.SPLAT.st_cli)) {
    const d = fs.mkdtempSync(path.join(W, 'echt-')), n = 3000;
    const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
    const kop = Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex ' + n + '\n' + props.map((p) => 'property float ' + p).join('\n') + '\nend_header\n');
    const lijf = Buffer.alloc(n * props.length * 4);
    for (let i = 0; i < n; i++) { const v = [Math.sin(i), Math.cos(i), 2 + (i % 7) / 7, 0.2, 0.1, -0.1, 1, -4, -4, -4, 1, 0, 0, 0]; v.forEach((x, j) => lijf.writeFloatLE(x, (i * props.length + j) * 4)); }
    fs.writeFileSync(path.join(d, 'ruw.ply'), Buffer.concat([kop, lijf]));
    const re = await L.splatTransform(L.cfgVan({}), d, ['ruw.ply', '-F', '1000', 'licht.sog'], 120000, null);
    const sog = fs.existsSync(path.join(d, 'licht.sog')) ? fs.readFileSync(path.join(d, 'licht.sog')) : Buffer.alloc(0);
    toets('echte splat-transform 2.6.0: kleine scène → licht.sog (zip)', re.ok && sog.length > 100 && sog[0] === 0x50 && sog[1] === 0x4b, [re, sog.length]);
    const re2 = await L.splatTransform(L.cfgVan({}), d, ['https://voorbeeld.test/x.ply', 'y.sog'], 5000, null);
    toets('splat-transform: een adres of absoluut pad als argument wordt geweigerd', !re2.ok && /ongeldige opdracht/.test(re2.fout) && !(await L.splatTransform(L.cfgVan({}), d, ['/etc/passwd', 'y.sog'], 5000, null)).ok);
  } else console.log('OVERGESLAGEN echte splat-transform (niet aanwezig)');

  toets('geen onverwachte fouten in de foutlog', fouts.length === 0, fouts);
  clearInterval(loperTimer); S.stopTimers(); S2.stopTimers(); S3.stopTimers(); comfy.close();
  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  toets brak af: ' + (e && e.stack)); process.exit(1); });
JS
