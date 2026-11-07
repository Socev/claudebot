#!/usr/bin/env bash
# Toetst Studio × Immich (wv2614, fotoherstel fase 2; ontwerp vault "Studio - fotoherstel op Olares (ontwerp 5-11-2026)" § 6/§ 7): foto uit Immich
# als bron (origineel bij jpg/png/webp ≤ 20 MB, anders het grote voorbeeldbeeld met noot; video/weg/prullenbak geweigerd) en "Zet in Immich"
# (nieuwe foto met eigen naam en opnamedatum van het origineel, beschrijving bij ai_model, stapel alleen als het origineel er geen had, zelfde
# albums; bij een upload alleen het gekozen album; één keer per taak; dubbel = niets stapelen). Origineel byte voor byte onveranderd; nooit
# PUT/PATCH/DELETE op een foto. Echte immich.js en studio-beeld.py (Pillow) tegen een nagebootste ComfyUI en Immich; alleen verzonnen beelden.
# Raakt de echte Immich, ComfyUI en /opt/data niet. Gebruik: bash test/studio-immich.sh
set -u
cd "$(dirname "$0")/.." || exit 1
python3 -c "import PIL" 2>/dev/null || { echo "ROOD  python3 met Pillow ontbreekt"; exit 1; }
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto'), { execFileSync } = require('child_process');
const studioMod = require('./studio.js'), IM = require('./immich.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-immich-'));
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 15000); while (Date.now() < t) { if (await f()) return true; await slaap(25); } return false; }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const B = path.join(W, 'beelden'); fs.mkdirSync(B);
execFileSync('python3', ['-I', '-c', `
import sys, os
from PIL import Image
d = sys.argv[1]
Image.new('RGB', (600, 400), (120, 90, 60)).save(os.path.join(d, 'orig.png'))
Image.new('RGB', (640, 480), (90, 90, 90)).save(os.path.join(d, 'orig2.jpg'), quality=90)
Image.new('RGB', (500, 300), (10, 10, 10)).save(os.path.join(d, 'voorbeeld.jpg'), quality=80)
Image.new('RGB', (1200, 800), (200, 10, 10)).save(os.path.join(d, 'uit-goed.png'))
Image.new('RGB', (1200, 800), (10, 200, 10)).save(os.path.join(d, 'uit-ander.png'))
`, B]);
const lees = (n) => fs.readFileSync(path.join(B, n));
const ORIG = lees('orig.png'), ORIG2 = lees('orig2.jpg'), VOORB = lees('voorbeeld.jpg'), MINI = lees('voorbeeld.jpg');
const UIT = { goed: lees('uit-goed.png'), ander: lees('uit-ander.png') };

// ── nagebootste ComfyUI (alleen wat de beeldroute nodig heeft) ──
const OI = { LoadImage: { python_module: 'nodes', input: { required: { image: [['x.png'], { image_upload: true }] } } },
  ImageScaleBy: { python_module: 'nodes', input: { required: { image: ['IMAGE', {}], upscale_method: [['lanczos'], {}], scale_by: ['FLOAT', {}] } } },
  PreviewImage: { python_module: 'nodes', input: { required: { images: ['IMAGE', {}] } } } };
const C = { uploads: [], uitvoer: 'goed', rij: { queue_running: [], queue_pending: [] }, histN: 0 };
const comfy = http.createServer((req, res) => {
  const delen = []; req.on('data', (c) => delen.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(delen);
    const stuur = (st, j) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.url === '/upload/image') { const fd = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData(); const f = fd.get('image'); C.uploads.push(sha(Buffer.from(await f.arrayBuffer()))); return stuur(200, { name: f.name, subfolder: fd.get('subfolder'), type: 'input' }); }
    if (req.url === '/object_info') return stuur(200, OI);
    if (req.url === '/queue') return stuur(200, C.rij);
    if (req.url === '/system_stats') return stuur(200, { system: { ram_free: 60 * 1073741824 }, devices: [{ vram_total: 24000 * 1048576, vram_free: 20000 * 1048576 }] });
    if (req.url === '/prompt') { C.histN = 0; C.rij = { queue_running: [[1, 'p', {}, {}, []]], queue_pending: [] }; return stuur(200, { prompt_id: 'p' + Date.now() }); }
    const m = /^\/history\/(.+)$/.exec(req.url);
    if (m) { if (++C.histN < 2) return stuur(200, {}); C.rij = { queue_running: [], queue_pending: [] }; return stuur(200, { [decodeURIComponent(m[1])]: { status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: 'ComfyUI_temp_00001_.png', subfolder: '', type: 'temp' }] } } } }); }
    if (req.url.indexOf('/view?') === 0) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(UIT[C.uitvoer]); }
    if (req.url === '/interrupt' || req.url === '/free') return stuur(200, {});
    stuur(404, {});
  });
});

// ── nagebootste Immich (fetch in het geheugen) ──
const uuid = () => crypto.randomUUID();
const IK = uuid();
const I = { assets: new Map(), albums: new Map(), stapels: [], log: [], uploads: [], uit: false, rechten: ['asset.read', 'asset.upload', 'albumAsset.create', 'stack.create'] };
const zetAsset = (o) => { const id = uuid(); I.assets.set(id, Object.assign({ id, type: 'IMAGE', mime: 'image/png', opname: '1936-03-01T12:00:00.000Z', eigenaar: IK }, o)); return id; };
const zetAlbum = (naam, ids, ml) => { const id = uuid(); I.albums.set(id, { id, naam, omschrijving: ml ? 'Album voor MemoryLane.\n\nmemorylane:0123456789abcdef' : '', assets: ids.slice() }); return id; };
const jres = (status, obj, ct) => new Response(Buffer.isBuffer(obj) ? obj : JSON.stringify(obj), { status, headers: { 'content-type': ct || 'application/json' } });
async function nepFetch(url, init) {
  const u = new URL(url), m = init.method;
  I.log.push(m + ' ' + u.pathname + u.search);
  if (I.uit) throw new Error('ECONNREFUSED');
  let r;
  if (m === 'GET' && u.pathname === '/api/albums') {
    const id = u.searchParams.get('assetId');
    return jres(200, [...I.albums.values()].filter((a) => !id || a.assets.includes(id)).map((a) => ({ id: a.id, albumName: a.naam, description: a.omschrijving, assetCount: a.assets.length })));
  }
  if (m === 'GET' && (r = /^\/api\/albums\/([0-9a-f-]{36})$/.exec(u.pathname))) { const a = I.albums.get(r[1]); return a ? jres(200, { id: a.id, albumName: a.naam, description: a.omschrijving, assetCount: a.assets.length }) : jres(404, {}); }
  if (m === 'GET' && u.pathname === '/api/users/me') return jres(200, { id: IK, email: 'verzonnen@voorbeeld.test' });
  if (m === 'GET' && u.pathname === '/api/api-keys/me') return jres(200, { id: uuid(), name: 'verzonnen', permissions: I.rechten });
  if (m === 'GET' && u.pathname === '/api/timeline/buckets') return jres(200, [{ timeBucket: '1936-03-01', count: 9 }]);
  if (m === 'GET' && u.pathname === '/api/timeline/bucket') { const a = I.albums.get(u.searchParams.get('albumId')); const ids = a ? a.assets : []; return jres(200, { id: ids, isImage: ids.map((x) => I.assets.get(x).type === 'IMAGE'), isTrashed: ids.map(() => false), ratio: ids.map(() => 1.5) }); }
  if (m === 'GET' && (r = /^\/api\/assets\/([0-9a-f-]{36})$/.exec(u.pathname))) {
    const a = I.assets.get(r[1]); if (!a) return jres(404, {});
    return jres(200, { id: a.id, type: a.type, originalMimeType: a.mime, ownerId: a.eigenaar, fileCreatedAt: a.opname, isTrashed: !!a.prullenbak, originalFileName: a.naam || 'IMG_0001.png',
      stack: a.stapel ? { id: a.stapel, primaryAssetId: a.id, assetCount: 2 } : null, exifInfo: { fileSizeInByte: a.grootte || a.data.length, description: a.beschrijving || '' } });
  }
  if (m === 'GET' && (r = /^\/api\/assets\/([0-9a-f-]{36})\/original$/.exec(u.pathname))) { const a = I.assets.get(r[1]); return a ? jres(200, a.data, 'application/octet-stream') : jres(404, {}); }
  if (m === 'GET' && (r = /^\/api\/assets\/([0-9a-f-]{36})\/thumbnail$/.exec(u.pathname))) { const a = I.assets.get(r[1]); return a ? jres(200, u.searchParams.get('size') === 'preview' ? VOORB : MINI, 'image/jpeg') : jres(404, {}); }
  if (m === 'POST' && u.pathname === '/api/assets') {
    const f = init.body.get('assetData'), data = Buffer.from(await f.arrayBuffer());
    const xmp = init.body.get('sidecarData') ? Buffer.from(await init.body.get('sidecarData').arrayBuffer()).toString() : null;
    I.uploads.push({ velden: [...init.body.keys()].sort(), naam: f.name, opname: init.body.get('fileCreatedAt'), xmp });
    const dub = [...I.assets.values()].find((a) => a.data.equals(data));
    if (dub) return jres(200, { id: dub.id, status: 'duplicate' });
    const id = zetAsset({ data, naam: f.name, opname: init.body.get('fileCreatedAt'), mime: f.type, beschrijving: xmp ? (/<rdf:li xml:lang="x-default">([^<]*)</.exec(xmp) || [])[1] : '' });
    return jres(201, { id, status: 'created' });
  }
  if (m === 'POST' && u.pathname === '/api/stacks') { const b = JSON.parse(init.body); const sid = uuid(); I.stapels.push(b.assetIds); b.assetIds.forEach((x) => { I.assets.get(x).stapel = sid; }); return jres(201, { id: sid, primaryAssetId: b.assetIds[0], assets: [] }); }
  if (m === 'PUT' && (r = /^\/api\/albums\/([0-9a-f-]{36})\/assets$/.exec(u.pathname))) { const a = I.albums.get(r[1]); const b = JSON.parse(init.body); if (!a) return jres(400, {}); b.ids.forEach((x) => { if (!a.assets.includes(x)) a.assets.push(x); }); return jres(200, b.ids.map((x) => ({ id: x, success: true }))); }
  return jres(404, {});
}

(async function () {
  await new Promise((r) => comfy.listen(0, '127.0.0.1', r));
  const CURL = 'http://127.0.0.1:' + comfy.address().port;
  const DIR = path.join(W, 'studio'), BEWAAR = path.join(W, 'app-bestanden');
  const zetFlow = (naam, y, api) => { fs.mkdirSync(path.join(DIR, 'flows', naam), { recursive: true }); fs.writeFileSync(path.join(DIR, 'flows', naam, 'flow.yaml'), JSON.stringify(y)); fs.writeFileSync(path.join(DIR, 'flows', naam, 'flow.json'), JSON.stringify(api)); };
  const api = { 1: { class_type: 'LoadImage', inputs: { image: 'x.png' } }, 2: { class_type: 'ImageScaleBy', inputs: { image: ['1', 0], upscale_method: 'lanczos', scale_by: 2 } }, 9: { class_type: 'PreviewImage', inputs: { images: ['2', 0] } } };
  const velden = [{ naam: 'foto', label: 'Foto', soort: 'beeld', pad: '1.inputs.image' }];
  zetFlow('foto-ai', { titel: 'Foto AI', motor: 'comfyui', status: 'actief', uitvoer: 'beeld', max_seconden: 30, ai_model: 'SeedVR2', velden }, api);
  zetFlow('foto-zonder', { titel: 'Foto zonder model', motor: 'comfyui', status: 'actief', uitvoer: 'beeld', max_seconden: 30, velden }, api);
  const bewaard = {};
  const bewaar = (jobId, outdir, meta) => {
    const dir = path.join(BEWAAR, jobId); fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
    const lijst = [];
    for (const n of fs.readdirSync(outdir).sort()) { const doel = path.join(dir, 'b', String(lijst.length + 1)); const g = fs.statSync(path.join(outdir, n)).size; fs.renameSync(path.join(outdir, n), doel); lijst.push({ n: lijst.length + 1, naam: n, grootte: g }); }
    return (bewaard[jobId] = { job_id: jobId, bestanden: lijst });
  };
  const leesBewaard = (jobId, n) => { try { return fs.readFileSync(path.join(BEWAAR, jobId, 'b', String(n))); } catch (e) { return null; } };
  const client = IM.maak({ basis: 'https://immich.voorbeeld.test', sleutel: async () => 'proefsleutel-verzonnen', fetch: nepFetch });
  const logs = [], fouts = [];
  let immichAan = true;
  const S = studioMod.maak({ dir: DIR, bewaar, leesBewaard, immich: () => (immichAan ? client : null), primair: () => true, sleutel: async () => null, routerUrl: 'http://127.0.0.1:1', comfyUrl: CURL,
    flowstudioUrl: 'http://127.0.0.1:1', log: (r) => logs.push(r), fout: (w, e) => fouts.push(w + ': ' + (e && e.message)), tempo: { poll: 30, wachtStap: 40, wachtMax: 1500 } });
  const UP = {};
  const ctx = { versOk: () => false, versVerbruik: () => {}, apparaat: 'toets', neemUpload: (beurt, n) => UP[beurt + '/' + n] ? { naam: 'Oma Truus.png', bytes: UP[beurt + '/' + n], weg: () => { delete UP[beurt + '/' + n]; } } : null };
  let bn = 0; const nb = () => 'beurt-' + (++bn) + '-' + crypto.randomBytes(3).toString('hex');
  const wacht = async (id) => { let t; await totDat(() => { t = S.taak(id); return t && ['klaar', 'mislukt', 'gestopt'].indexOf(t.status) >= 0; }); return S.taak(id); };
  const maak = async (flow, foto) => { const r = await S.maak({ flow, beurt_id: nb(), velden: { foto } }, ctx); return r.status === 200 ? await wacht(r.taak.id) : r; };

  // proefalbum: origineel in twee albums (één MemoryLane), plus een album zonder het origineel
  const orig = zetAsset({ data: ORIG, naam: 'IMG_1936.png' });
  const alML = zetAlbum('1936 Strand (ML)', [orig], true), alEigen = zetAlbum('Proefalbum Davids eigen', [orig]), alAnder = zetAlbum('Ander album', []);
  const voorSha = sha(I.assets.get(orig).data);

  // 1. albums en foto's voor de kiezer
  let r = await S.immichAlbums();
  toets('1 albums: MemoryLane bovenaan, gemarkeerd', r.status === 200 && r.albums[0].id === alML && r.albums[0].memorylane === true && r.albums.filter((a) => a.memorylane).length === 1 && r.albums.length === 3, r);
  r = await S.immichFotos(alML);
  toets('1 foto\'s van een album: alleen ids en verhouding', r.status === 200 && r.fotos.length === 1 && r.fotos[0].id === orig && Object.keys(r.fotos[0]).sort().join() === 'id,ratio', r);
  r = await S.immichMini(orig);
  toets('1 miniatuur als base64', r.status === 200 && r.mime === 'image/jpeg' && Buffer.from(r.data, 'base64').equals(MINI));
  toets('1 ongeldige ids geweigerd zonder verzoek', (await S.immichFotos('x')).status === 400 && (await S.immichMini('../x')).status === 400);
  const fl = await S.flows();
  toets('1 flows melden dat Immich er is', fl.immich === true);

  // 2. bron Immich: origineel als invoer
  let t = await maak('foto-ai', { immich: orig });
  toets('2 taak met foto uit Immich klaar', t.status === 'klaar', t);
  toets('2 het ORIGINEEL ging naar ComfyUI (niet het voorbeeld)', C.uploads.includes(sha(ORIG)) && !C.uploads.includes(sha(VOORB)));
  toets('2 voor.png in Bestanden = het origineel; geen noot', sha(fs.readFileSync(path.join(BEWAAR, t.id, 'b', '2'))) === sha(ORIG) && !t.noot, t);
  toets('2 taak kent de bron (asset-id), velden tonen (foto)', t.beeld.immich === orig && t.velden.foto === '(foto)');
  toets('2 Immich: alleen lezen (gegevens + origineel)', I.log.filter((x) => /^(POST|PUT|PATCH|DELETE)/.test(x)).length === 0, I.log);

  // 3. Zet in Immich: nieuwe foto + stapel + dezelfde albums
  r = await S.zetInImmich(t.id, {});
  const up = I.uploads[I.uploads.length - 1];
  const nieuw = [...I.assets.values()].find((a) => a.naam === 'socev-studio-' + t.id + '.png');
  toets('3 zet: 200, stapel gemaakt, 2 albums', r.status === 200 && r.taak.immich.stapel === true && r.taak.immich.albums === 2 && !r.taak.immich.noot, r);
  toets('3 nieuwe foto: eigen naam, opnamedatum van het origineel, alleen de vaste velden', nieuw && up.naam === 'socev-studio-' + t.id + '.png' && up.opname === '1936-03-01T12:00:00.000Z' && up.velden.join() === 'assetData,fileCreatedAt,fileModifiedAt,sidecarData', up);
  toets('3 beschrijving "Hersteld met AI (SeedVR2), origineel in de stapel"', nieuw && nieuw.beschrijving === 'Hersteld met AI (SeedVR2), origineel in de stapel', nieuw && nieuw.beschrijving);
  toets('3 stapel = [nieuw bovenop, origineel]', I.stapels.length === 1 && I.stapels[0][0] === nieuw.id && I.stapels[0][1] === orig, I.stapels);
  toets('3 nieuwe foto in beide albums van het origineel, niet in het andere', I.albums.get(alML).assets.includes(nieuw.id) && I.albums.get(alEigen).assets.includes(nieuw.id) && !I.albums.get(alAnder).assets.includes(nieuw.id));
  toets('3 nieuwe foto = het resultaat uit Bestanden', nieuw.data.equals(UIT.goed));
  toets('3 origineel byte voor byte gelijk (checksum vóór/na)', sha(I.assets.get(orig).data) === voorSha);
  toets('3 nooit PUT/PATCH/DELETE op een foto', !I.log.some((x) => /^(PUT|PATCH|DELETE) \/api\/assets/.test(x)) && !I.log.some((x) => /^DELETE/.test(x)), I.log.filter((x) => !/^GET/.test(x)));
  toets('3 link naar de nieuwe foto', r.taak.immich.link === 'https://immich.voorbeeld.test/photos/' + nieuw.id);
  const nUp = I.uploads.length;
  r = await S.zetInImmich(t.id, {});
  toets('3 tweede tik: al gedaan, geen tweede upload', r.status === 200 && r.al === true && I.uploads.length === nUp, r);

  // 4. origineel zat al in een stapel (nu: hetzelfde origineel, want stap 3 maakte er een) → geen stapel, wel de albums
  C.uitvoer = 'ander';
  t = await maak('foto-ai', { immich: orig });
  r = await S.zetInImmich(t.id, {});
  const nieuw2 = [...I.assets.values()].find((a) => a.naam === 'socev-studio-' + t.id + '.png');
  toets('4 origineel al in een stapel: geen nieuwe stapel, wel albums, noot', r.status === 200 && r.taak.immich.stapel === false && r.taak.immich.albums === 2 && /al in een stapel/.test(r.taak.immich.noot || '') && I.stapels.length === 1, r);
  toets('4 beschrijving zegt dat het origineel los staat', nieuw2 && /^Hersteld met AI \(SeedVR2\); het origineel staat los in Immich$/.test(nieuw2.beschrijving), nieuw2 && nieuw2.beschrijving);

  // 4b. gedeelde foto van een ander account: vooraf geen stapel, beschrijving klopt, wel de albums
  C.uitvoer = 'goed';
  const vanAnder = zetAsset({ data: ORIG2, mime: 'image/jpeg', eigenaar: uuid() }); const alGedeeld = zetAlbum('Gedeeld album', [vanAnder]);
  t = await maak('foto-ai', { immich: vanAnder });
  const stapelPogingen = I.log.filter((x) => x === 'POST /api/stacks').length;
  fs.writeFileSync(path.join(BEWAAR, t.id, 'b', '1'), execFileSync('python3', ['-I', '-c', "import sys,io\nfrom PIL import Image\nb=io.BytesIO(); Image.new('RGB',(700,500),(9,99,199)).save(b,'PNG'); sys.stdout.buffer.write(b.getvalue())"]));
  r = await S.zetInImmich(t.id, {});
  const nieuw4 = [...I.assets.values()].find((a) => a.naam === 'socev-studio-' + t.id + '.png');
  toets('4b ander account: geen stapel(poging), noot, wel in het album, beschrijving "staat los"', r.status === 200 && r.taak.immich.stapel === false && /ander account/.test(r.taak.immich.noot || '') && I.stapels.length === 1
    && I.albums.get(alGedeeld).assets.includes(nieuw4 && nieuw4.id) && /het origineel staat los in Immich$/.test(nieuw4.beschrijving) && I.log.filter((x) => x === 'POST /api/stacks').length === stapelPogingen, r);

  // 4c. sleutel zonder stack.create (gemeten 7-11 op de echte sleutel): geen stapelpoging, beschrijving "staat los", noot zegt waarom
  const S2 = studioMod.maak({ dir: path.join(W, 'studio2'), bewaar, leesBewaard, immich: () => IM.maak({ basis: 'https://immich.voorbeeld.test', sleutel: async () => 'x', fetch: nepFetch }), primair: () => true, sleutel: async () => null,
    routerUrl: 'http://127.0.0.1:1', comfyUrl: CURL, flowstudioUrl: 'http://127.0.0.1:1', log: () => {}, fout: () => {}, tempo: { poll: 30, wachtStap: 40, wachtMax: 1500 } });
  fs.mkdirSync(path.join(W, 'studio2', 'flows'), { recursive: true }); fs.cpSync(path.join(DIR, 'flows', 'foto-ai'), path.join(W, 'studio2', 'flows', 'foto-ai'), { recursive: true });
  I.rechten = ['asset.read', 'asset.upload', 'albumAsset.create'];
  const origR = zetAsset({ data: Buffer.from(ORIG2), mime: 'image/jpeg' }); const alR = zetAlbum('Album rechten', [origR]);
  const rR = await S2.maak({ flow: 'foto-ai', beurt_id: nb(), velden: { foto: { immich: origR } } }, ctx);
  let tR; await totDat(() => { tR = S2.taak(rR.taak.id); return tR && tR.status === 'klaar'; });
  fs.writeFileSync(path.join(BEWAAR, tR.id, 'b', '1'), execFileSync('python3', ['-I', '-c', "import sys,io\nfrom PIL import Image\nb=io.BytesIO(); Image.new('RGB',(710,500),(99,9,199)).save(b,'PNG'); sys.stdout.buffer.write(b.getvalue())"]));
  const pogingenR = I.log.filter((x) => x === 'POST /api/stacks').length;
  r = await S2.zetInImmich(tR.id, {});
  const nieuwR = [...I.assets.values()].find((a) => a.naam === 'socev-studio-' + tR.id + '.png');
  toets('4c sleutel zonder stack.create: geen stapelpoging, noot zegt waarom, beschrijving "staat los", wel in het album', r.status === 200 && r.taak.immich.stapel === false && /mag nog geen stapels maken/.test(r.taak.immich.noot || '')
    && I.log.filter((x) => x === 'POST /api/stacks').length === pogingenR && /staat los in Immich$/.test(nieuwR && nieuwR.beschrijving) && I.albums.get(alR).assets.includes(nieuwR && nieuwR.id), r);
  I.rechten.push('stack.create'); S2.stopTimers();

  // 5. dubbel: zelfde resultaat als een eerdere foto → niets stapelen of toevoegen
  const orig3 = zetAsset({ data: ORIG2, mime: 'image/jpeg' }); const al3 = zetAlbum('Album drie', [orig3]);
  t = await maak('foto-ai', { immich: orig3 });   // uitvoer 'ander' = dezelfde bytes als nieuw2
  r = await S.zetInImmich(t.id, {});
  toets('5 dubbel: taak zegt het, geen stapel, niet in het album', r.status === 200 && r.taak.immich.dubbel === true && r.taak.immich.stapel === false && r.taak.immich.albums === 0 && I.stapels.length === 1 && I.albums.get(al3).assets.length === 1, r);
  toets('5 origineel drie heeft geen stapel gekregen', !I.assets.get(orig3).stapel);

  // 6. HEIC en te groot: voorbeeldbeeld met noot; video, weg en prullenbak geweigerd
  C.uitvoer = 'goed';
  const heic = zetAsset({ data: Buffer.from('ftypheic-verzonnen-niet-echt-heic'), mime: 'image/heic' });
  t = await maak('foto-ai', { immich: heic });
  toets('6 HEIC: voorbeeldbeeld gebruikt, noot in gewone taal', t.status === 'klaar' && /geen jpg, png of webp: gewerkt met het grote voorbeeldbeeld/.test(t.noot || '') && !I.log.includes('GET /api/assets/' + heic + '/original'), t);
  const groot = zetAsset({ data: ORIG, grootte: 30 * 1024 * 1024 });
  t = await maak('foto-ai', { immich: groot });
  toets('6 > 20 MB: voorbeeldbeeld, origineel niet opgehaald', t.status === 'klaar' && /groter dan 20 MB/.test(t.noot || '') && !I.log.includes('GET /api/assets/' + groot + '/original'), t);
  const vals = zetAsset({ data: Buffer.from('GIF89a-verzonnen-geen-png-bytes'), mime: 'image/png' });
  t = await maak('foto-ai', { immich: vals });
  toets('6 type zegt png maar bytes niet: voorbeeldbeeld', t.status === 'klaar' && /voorbeeldbeeld/.test(t.noot || ''), t);
  const video = zetAsset({ data: ORIG, type: 'VIDEO', mime: 'video/mp4' });
  r = await maak('foto-ai', { immich: video });
  toets('6 video: 415', r.status === 415, r);
  r = await maak('foto-ai', { immich: uuid() });
  toets('6 onbekende foto: 404', r.status === 404, r);
  const weg = zetAsset({ data: ORIG, prullenbak: true });
  r = await maak('foto-ai', { immich: weg });
  toets('6 prullenbak: 409', r.status === 409, r);
  r = await S.maak({ flow: 'foto-ai', beurt_id: nb(), velden: { foto: { immich: 'geen-uuid' } } }, ctx);
  toets('6 ongeldig id: 400', r.status === 400, r);

  // 7. bron = upload: album kiezen verplicht; dan alleen dat album, geen stapel; zonder ai_model geen beschrijving
  C.uitvoer = 'goed';
  const bu = nb(); UP[bu + '/1'] = ORIG2;
  const r7 = await S.maak({ flow: 'foto-zonder', beurt_id: bu, velden: { foto: { n: 1 } } }, ctx);
  t = await wacht(r7.taak.id);
  r = await S.zetInImmich(t.id, {});
  toets('7 upload als bron zonder album: 400 kies een album', r.status === 400 && /album/.test(r.fout), r);
  r = await S.zetInImmich(t.id, { album: uuid() });
  toets('7 onbekend album: 404', r.status === 404, r);
  // uitvoer 'goed' bestaat al in Immich (stap 3) → eerst een ander resultaat laten maken
  const nStap = I.stapels.length;
  r = await S.zetInImmich(t.id, { album: alAnder });
  toets('7 zelfde bytes als stap 3: dubbel, niets in het album', r.status === 200 && r.taak.immich.dubbel === true && I.albums.get(alAnder).assets.length === 0, r);
  const bu2 = nb(); UP[bu2 + '/1'] = ORIG2;
  const r7b = await S.maak({ flow: 'foto-zonder', beurt_id: bu2, velden: { foto: { n: 1 } } }, ctx);
  const t7 = await wacht(r7b.taak.id);
  // dit resultaat moet nieuw zijn voor Immich: vervang het bewaarde na-bestand door een ander (verzonnen) beeld
  fs.writeFileSync(path.join(BEWAAR, t7.id, 'b', '1'), execFileSync('python3', ['-I', '-c', "import sys,io\nfrom PIL import Image\nb=io.BytesIO(); Image.new('RGB',(900,600),(1,2,250)).save(b,'PNG'); sys.stdout.buffer.write(b.getvalue())"]));
  r = await S.zetInImmich(t7.id, { album: alAnder });
  const n7 = [...I.assets.values()].find((a) => a.naam === 'socev-studio-' + t7.id + '.png');
  toets('7 upload als bron: alleen het gekozen album, geen stapel', r.status === 200 && r.taak.immich.albums === 1 && r.taak.immich.stapel === false && I.albums.get(alAnder).assets.includes(n7 && n7.id) && I.stapels.length === nStap, r);
  toets('7 zonder ai_model: geen zijbestand, geen beschrijving', I.uploads[I.uploads.length - 1].xmp === null && n7.beschrijving === '', I.uploads[I.uploads.length - 1]);

  // 8. weigeringen en storing
  r = await S.zetInImmich('0123456789abcdef', {});
  toets('8 onbekende taak: 404', r.status === 404);
  const rIm = await S.maak({ flow: 'foto-ai', beurt_id: nb(), velden: { foto: { immich: orig } } }, ctx);
  const t8 = await wacht(rIm.taak.id);
  I.uit = true;
  r = await S.zetInImmich(t8.id, {});
  toets('8 Immich onbereikbaar: 503, taak niet als gezet gemarkeerd', r.status === 503 && !S.taak(t8.id).immich, r);
  I.uit = false;
  fs.rmSync(path.join(BEWAAR, t8.id), { recursive: true });
  r = await S.zetInImmich(t8.id, {});
  toets('8 resultaat niet meer in Bestanden: 410', r.status === 410, r);
  immichAan = false;
  toets('8 zonder Immich-koppeling: 409 en flows.immich false', (await S.immichAlbums()).status === 409 && (await S.flows()).immich === false);
  immichAan = true;

  // 9. sporen: geen albumnamen, asset-ids of bestandsnamen van David in audit/log
  const audit = fs.readFileSync(path.join(DIR, 'audit.jsonl'), 'utf8');
  toets('9 audit/log zonder albumnaam, asset-id of bestandsnaam', [audit, JSON.stringify(logs), JSON.stringify(fouts)].every((x) => x.indexOf('Strand') < 0 && x.indexOf('Proefalbum') < 0 && x.indexOf(orig) < 0 && x.indexOf('Truus') < 0 && x.indexOf('IMG_1936') < 0));
  toets('9 audit telt de immich-regels', (audit.match(/"uitkomst":"immich"/g) || []).length === 6, audit.split('\n').filter((x) => /immich/.test(x)));
  toets('9 origineel aan het eind nog steeds onveranderd', sha(I.assets.get(orig).data) === voorSha);
  S.stopTimers(); comfy.close();
  fs.rmSync(W, { recursive: true, force: true });
  console.log(fouten + ' ROOD, ' + goed + ' GROEN');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); process.exit(1); });
JS
