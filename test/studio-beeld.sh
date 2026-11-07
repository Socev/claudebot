#!/usr/bin/env bash
# Toetst de veldsoort 'beeld' van studio.js (wv2482, fotoherstel fase 1) tegen een nagebootste ComfyUI op 127.0.0.1, met de echte
# studio-beeld.py (Pillow). Toetst: upload onder één vaste naam (subfolder studio, overwrite) en na afloop ALTIJD 1×1 (klaar, fout bij
# indienen, stop, andere naam van ComfyUI); vlag + vrijRonde als het leegmaken mislukt of de pod herstart; grenzen (type uit de bytes,
# ≤ 20 MB, kapot bestand, > 50 MP, ×2 → 4 MP, ×4 → 1 MP, uitvoer ≤ 16 MP, > 10 MB → JPEG); geweigerd = upload niet verbruikt, geen
# restbestanden; keuze met vaste knoopwaarden (zet) en die niet in de app; knopentoets (LoadImage alleen de vaste naam, pakketknoop op
# naam + map); voor.<ext> en na-<n>.<ext> in Bestanden; geen bestandsnaam van David in audit, taken of log.
# Raakt de echte ComfyUI en /opt/data niet. Gebruik: bash test/studio-beeld.sh   (vraagt python3 met Pillow)
set -u
cd "$(dirname "$0")/.." || exit 1
python3 -c "import PIL" 2>/dev/null || { echo "ROOD  python3 met Pillow ontbreekt"; exit 1; }
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto'), { execFileSync } = require('child_process');
const studioMod = require('./studio.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-beeld-'));
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 15000); while (Date.now() < t) { if (await f()) return true; await slaap(25); } return false; }

// ── proefbeelden (verzonnen: effen vlakken en ruis, geen foto's) ──
const B = path.join(W, 'beelden'); fs.mkdirSync(B);
execFileSync('python3', ['-I', '-c', `
import sys, os
from PIL import Image
d = sys.argv[1]
Image.new('RGB', (600, 400), (120, 90, 60)).save(os.path.join(d, 'klein.png'))
Image.new('RGB', (3000, 2000), (30, 60, 90)).save(os.path.join(d, 'groot.jpg'), quality=90)
Image.new('RGB', (300, 200), (1, 2, 3)).save(os.path.join(d, 'dier.gif'))
Image.new('1', (8000, 8000), 1).save(os.path.join(d, 'bom.png'))
Image.new('RGB', (1200, 800), (200, 10, 10)).save(os.path.join(d, 'uit-goed.png'))
Image.new('RGB', (5000, 4000), (0, 0, 0)).save(os.path.join(d, 'uit-te-groot.png'))
Image.frombytes('RGB', (2300, 2300), os.urandom(2300 * 2300 * 3)).save(os.path.join(d, 'uit-zwaar.png'), compress_level=1)
Image.new('RGB', (640, 480), (10, 200, 10)).save(os.path.join(d, 'goed.webp'))
`, B]);
const lees = (n) => fs.readFileSync(path.join(B, n));
const KLEIN = lees('klein.png'), GROOT = lees('groot.jpg'), GIF = lees('dier.gif'), BOM = lees('bom.png'), WEBP = lees('goed.webp');
const KAPOT = GROOT.subarray(0, Math.floor(GROOT.length / 3));
const UIT = { goed: lees('uit-goed.png'), groot: lees('uit-te-groot.png'), zwaar: lees('uit-zwaar.png') };
const LEEG_SHA = crypto.createHash('sha256').update(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')).digest('hex');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function afm(buf) { const f = path.join(W, 'afm-' + crypto.randomBytes(4).toString('hex')); fs.writeFileSync(f, buf); const r = execFileSync('python3', ['-I', '-c', 'import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]); print(im.size[0], im.size[1], im.format)', f]).toString().trim().split(' '); fs.rmSync(f); return { b: +r[0], h: +r[1], fmt: r[2] }; }

// ── nagebootste ComfyUI ──
const OI = {
  LoadImage: { python_module: 'nodes', input: { required: { image: [['voorbeeld.png', 'ander/geheim.png'], { image_upload: true }] } } },
  ImageScaleBy: { python_module: 'nodes', input: { required: { image: ['IMAGE', {}], upscale_method: [['lanczos', 'bicubic'], {}], scale_by: ['FLOAT', {}] } } },
  ImageBlend: { python_module: 'comfy_extras.nodes_post_processing', input: { required: { image1: ['IMAGE', {}], image2: ['IMAGE', {}], blend_factor: ['FLOAT', {}], blend_mode: [['normal', 'multiply'], {}] } } },
  FaceRestoreModelLoader: { python_module: 'custom_nodes.facerestore_cf', input: { required: { model_name: [['codeformer-v0.1.0.pth'], {}] } } },
  FaceRestoreCFWithModel: { python_module: 'custom_nodes.facerestore_cf', input: { required: { facerestore_model: ['FACERESTORE_MODEL', {}], image: ['IMAGE', {}], facedetection: [['retinaface_resnet50', 'YOLOv5l'], {}], codeformer_fidelity: ['FLOAT', {}] } } },
  DDColor_Colorize: { python_module: 'custom_nodes.ComfyUI-DDColor', input: { required: { image: ['IMAGE', {}], model_input_size: ['INT', {}], checkpoint: [['ddcolor_paper_tiny.pth', 'ddcolor_modelscope.pth'], {}] } } },
  PreviewImage: { python_module: 'nodes', input: { required: { images: ['IMAGE', {}] } } },
  SaveImage: { python_module: 'nodes', input: { required: { images: ['IMAGE', {}], filename_prefix: ['STRING', {}] } } },
};
const C = { uploads: [], bestanden: {}, prompts: [], interrupts: [], histNa: 2, histN: 0, uit: false, uploadUit: false, uitvoer: 'goed', prompt400: false, andereNaam: false, rij: { queue_running: [], queue_pending: [] }, hangt: false };
const comfy = http.createServer((req, res) => {
  const delen = []; req.on('data', (c) => delen.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(delen);
    const stuur = (st, j) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (C.uit) return stuur(503, { error: 'ComfyUI Unavailable' });
    if (req.url === '/upload/image' && req.method === 'POST') {
      if (C.uploadUit) return stuur(503, {});
      const fd = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const f = fd.get('image'); const inhoud = Buffer.from(await f.arrayBuffer());
      let naam = f.name;
      if (C.andereNaam && naam === 'fotoherstel-invoer.png' && sha(inhoud) !== LEEG_SHA) naam = 'fotoherstel-invoer (1).png';
      const u = { naam, subfolder: fd.get('subfolder'), type: fd.get('type'), overwrite: fd.get('overwrite'), sha: sha(inhoud), lengte: inhoud.length };
      C.uploads.push(u); C.bestanden[u.subfolder + '/' + naam] = inhoud;
      return stuur(200, { name: naam, subfolder: u.subfolder, type: 'input' });
    }
    if (req.url === '/object_info') return stuur(200, OI);
    if (req.url === '/queue' && req.method === 'GET') return stuur(200, C.rij);
    if (req.url === '/system_stats') return stuur(200, { system: { ram_free: 60 * 1073741824 }, devices: [{ vram_total: 24000 * 1048576, vram_free: 20000 * 1048576 }] });
    if (req.url === '/prompt' && req.method === 'POST') {
      const j = JSON.parse(body.toString());
      if (C.prompt400) return stuur(400, { error: { type: 'prompt_outputs_failed_validation', message: 'kapot' } });
      C.prompts.push(j); C.histN = 0;
      const pid = 'pid-' + C.prompts.length;
      C.rij = { queue_running: [[1, pid, {}, {}, []]], queue_pending: [] };
      return stuur(200, { prompt_id: pid });
    }
    const m = /^\/history\/(.+)$/.exec(req.url);
    if (m) {
      if (C.hangt) return stuur(200, {});
      if (++C.histN < C.histNa) return stuur(200, {});
      C.rij = { queue_running: [], queue_pending: [] };
      return stuur(200, { [decodeURIComponent(m[1])]: { status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: 'ComfyUI_temp_00001_.png', subfolder: '', type: 'temp' }] } } } });
    }
    if (req.url.indexOf('/view?') === 0) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(C.uitvoer === 'tekst' ? Buffer.from('geen beeld hier, alleen tekst') : UIT[C.uitvoer]); }
    if (req.url === '/interrupt') { C.interrupts.push(JSON.parse(body.toString() || '{}')); C.rij = { queue_running: [], queue_pending: [] }; return stuur(200, {}); }
    if (req.url === '/free') return stuur(200, {});
    stuur(404, {});
  });
});

(async function () {
  await new Promise((r) => comfy.listen(0, '127.0.0.1', r));
  const CURL = 'http://127.0.0.1:' + comfy.address().port;
  const DIR = path.join(W, 'studio'), BEWAAR = path.join(W, 'app-bestanden');
  fs.mkdirSync(path.join(DIR, 'flows'), { recursive: true });
  const zetFlow = (naam, y, api) => { fs.mkdirSync(path.join(DIR, 'flows', naam), { recursive: true }); fs.writeFileSync(path.join(DIR, 'flows', naam, 'flow.yaml'), JSON.stringify(y)); if (api) fs.writeFileSync(path.join(DIR, 'flows', naam, 'flow.json'), JSON.stringify(api)); };
  const api = {
    1: { class_type: 'LoadImage', inputs: { image: 'voorbeeld.png', upload: 'image' } },
    2: { class_type: 'ImageScaleBy', inputs: { image: ['1', 0], upscale_method: 'lanczos', scale_by: 2 } },
    3: { class_type: 'FaceRestoreModelLoader', inputs: { model_name: 'codeformer-v0.1.0.pth' } },
    4: { class_type: 'FaceRestoreCFWithModel', inputs: { facerestore_model: ['3', 0], image: ['2', 0], facedetection: 'retinaface_resnet50', codeformer_fidelity: 1 } },
    5: { class_type: 'ImageBlend', inputs: { image1: ['2', 0], image2: ['4', 0], blend_factor: 0, blend_mode: 'normal' } },
    9: { class_type: 'SaveImage', inputs: { images: ['5', 0], filename_prefix: 'foto' } },
  };
  const velden = [
    { naam: 'foto', label: 'Foto', soort: 'beeld', pad: '1.inputs.image', max_mp: 9, max_mp_per: { 'schaal=4': 1 } },
    { naam: 'schaal', label: 'Groter', soort: 'keuze', standaard: 2, opties: [{ label: '×2', waarde: 2 }, { label: '×4', waarde: 4 }], pad: '2.inputs.scale_by' },
    { naam: 'gezichten', label: 'Gezichten', soort: 'keuze', standaard: 'uit', opties: [
      { label: 'uit', waarde: 'uit', zet: { '5.inputs.blend_factor': 0, '4.inputs.codeformer_fidelity': 1 } },
      { label: 'licht', waarde: 'licht', zet: { '5.inputs.blend_factor': 0.35, '4.inputs.codeformer_fidelity': 0.9 } },
      { label: 'sterk', waarde: 'sterk', zet: { '5.inputs.blend_factor': 0.7, '4.inputs.codeformer_fidelity': 0.7, '77.inputs.x': 3 } }] },
  ];
  zetFlow('foto-proef', { titel: 'Foto opknappen', motor: 'comfyui', status: 'actief', uitvoer: 'beeld', max_seconden: 30, velden }, api);
  zetFlow('foto-op-proef', { titel: 'Foto (proef)', motor: 'comfyui', status: 'proef', uitvoer: 'beeld', max_seconden: 30, velden }, api);
  zetFlow('foto-ander-bestand', { titel: 'Leest ander bestand', motor: 'comfyui', status: 'actief', uitvoer: 'beeld', max_seconden: 30, velden: [{ naam: 'schaal', soort: 'keuze', standaard: 2, opties: [2], pad: '2.inputs.scale_by' }] }, api);
  zetFlow('foto-piper', { titel: 'Foto bij piper', motor: 'piper', status: 'actief', uitvoer: 'geluid', velden: [{ naam: 'foto', soort: 'beeld', pad: '1.inputs.image' }] });
  const apiDD = { 1: api[1], 2: { class_type: 'DDColor_Colorize', inputs: { image: ['1', 0], model_input_size: 512, checkpoint: 'ddcolor_paper_tiny.pth' } }, 9: { class_type: 'PreviewImage', inputs: { images: ['2', 0] } } };
  zetFlow('foto-kleur', { titel: 'Inkleuren', motor: 'comfyui', status: 'actief', uitvoer: 'beeld', max_seconden: 30, velden: [{ naam: 'foto', label: 'Foto', soort: 'beeld', pad: '1.inputs.image' }] }, apiDD);

  const bewaard = {};
  const bewaar = (jobId, outdir, meta) => {
    const dir = path.join(BEWAAR, jobId); fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
    const lijst = [];
    for (const n of fs.readdirSync(outdir).sort()) { const doel = path.join(dir, 'b', String(lijst.length + 1)); const g = fs.statSync(path.join(outdir, n)).size; fs.renameSync(path.join(outdir, n), doel); lijst.push({ n: lijst.length + 1, naam: n, grootte: g }); }
    const m = { job_id: jobId, bestanden: lijst, label: meta.label }; bewaard[jobId] = m; return m;
  };
  const logs = [], fouts = [];
  const maakStudio = () => studioMod.maak({ dir: DIR, bewaar, primair: () => true, sleutel: async () => null, routerUrl: 'http://127.0.0.1:1', comfyUrl: CURL, flowstudioUrl: 'http://127.0.0.1:1',
    log: (r) => logs.push(r), fout: (w, e) => fouts.push(w + ': ' + (e && e.message)), tempo: { poll: 30, wachtStap: 40, wachtMax: 1500 } });
  let S = maakStudio();
  // nep-uploads van één apparaat: n → { naam, bytes }, weg telt
  const UP = {}; let weg = 0;
  const DAVIDNAAM = 'Oma Truus 1952 strand.png';
  let vers = false;
  const ctx = { versOk: () => vers, versVerbruik: () => { vers = false; }, apparaat: 'toets',
    neemUpload: (beurt, n) => UP[beurt + '/' + n] ? { naam: UP[beurt + '/' + n].naam, bytes: UP[beurt + '/' + n].bytes, weg: () => { weg++; delete UP[beurt + '/' + n]; } } : null };
  let bn = 0; const nb = () => 'beurt-' + (++bn) + '-' + crypto.randomBytes(3).toString('hex');
  const zetUp = (beurt, bytes, naam) => { UP[beurt + '/1'] = { naam: naam || DAVIDNAAM, bytes }; };
  const wacht = async (id, ms) => { let t; await totDat(() => { t = S.taak(id); return t && ['klaar', 'mislukt', 'gestopt'].indexOf(t.status) >= 0; }, ms); return S.taak(id); };
  const laatsteUpload = () => C.uploads[C.uploads.length - 1];
  const werkRest = () => { const d = path.join(DIR, 'werk'); return fs.existsSync(d) ? fs.readdirSync(d) : []; };
  const VUIL = path.join(DIR, 'comfy-invoer-vuil');

  // 1. catalogus: fotoveld zichtbaar, zet-waarden niet
  const c = await S.flows();
  const ff = c.flows.find((x) => x.id === 'foto-proef');
  const fv = ff && ff.velden.find((v) => v.naam === 'foto');
  toets('1 flow met fotoveld klaar; veldsoort beeld, verplicht, grens 4 MP (flow vroeg 9: pod-plafond)', ff && ff.klaar && fv && fv.soort === 'beeld' && fv.verplicht === true && fv.max_mp === 4 && fv.max_mp_per['schaal=4'] === 1, ff);
  toets('1 de app ziet de vaste knoopwaarden (zet) en het pad niet', JSON.stringify(c).indexOf('blend_factor') < 0 && JSON.stringify(c).indexOf('inputs') < 0);
  const fp = c.flows.find((x) => x.id === 'foto-piper');
  toets('1 fotoveld buiten ComfyUI: flow kapot', fp && !fp.klaar && /ComfyUI/.test(fp.reden), fp);

  // 2. gelukt: klein PNG, gezichten licht
  let beurt = nb(); zetUp(beurt, KLEIN);
  const n0 = C.uploads.length;
  let r = await S.maak({ flow: 'foto-proef', beurt_id: beurt, velden: { foto: { n: 1 }, gezichten: 'licht' } }, ctx);
  toets('2 maak met foto: 200, upload verbruikt', r.status === 200 && weg === 1 && !UP[beurt + '/1'], r);
  let t = await wacht(r.taak.id);
  toets('2 taak klaar', t.status === 'klaar', t);
  const ups = C.uploads.slice(n0);
  toets('2 foto naar ComfyUI onder de vaste naam, subfolder studio, overwrite', ups.length === 2 && ups[0].naam === 'fotoherstel-invoer.png' && ups[0].subfolder === 'studio' && ups[0].overwrite === 'true' && ups[0].sha === sha(KLEIN), ups);
  toets('2 na afloop dezelfde naam overschreven met 1×1', ups[1].naam === 'fotoherstel-invoer.png' && ups[1].sha === LEEG_SHA && sha(C.bestanden['studio/fotoherstel-invoer.png']) === LEEG_SHA, ups[1]);
  const pr = C.prompts[C.prompts.length - 1].prompt;
  toets('2 LoadImage leest de vaste naam; keuze licht zet beide waarden', pr['1'].inputs.image === 'studio/fotoherstel-invoer.png' && pr['5'].inputs.blend_factor === 0.35 && pr['4'].inputs.codeformer_fidelity === 0.9 && pr['2'].inputs.scale_by === 2 && pr['9'].class_type === 'PreviewImage', pr);
  const bw = bewaard[t.id];
  toets('2 Bestanden: voor.png en na-1.png', bw && bw.bestanden.map((b) => b.naam).join(',') === 'na-1.png,voor.png', bw);
  toets('2 voor.png = de foto zoals hij kwam', sha(fs.readFileSync(path.join(BEWAAR, t.id, 'b', '2'))) === sha(KLEIN));
  toets('2 taak toont (foto) en afmetingen, geen uploadnaam', t.velden.foto === '(foto)' && t.beeld && t.beeld.breed === 600 && t.beeld.hoog === 400 && JSON.stringify(t).indexOf('Truus') < 0, t);
  toets('2 geen vlag, geen restbestanden', !fs.existsSync(VUIL) && werkRest().length === 0, werkRest());

  // 3. verkleinen per stand
  beurt = nb(); zetUp(beurt, GROOT, 'groot.jpg');
  r = await S.maak({ flow: 'foto-proef', beurt_id: beurt, velden: { foto: { n: 1 }, schaal: 4 } }, ctx);
  t = await wacht(r.taak.id);
  let a = afm(C.uploads.filter((u) => u.sha !== LEEG_SHA).length ? C.bestanden['studio/fotoherstel-invoer.png'] : Buffer.alloc(0));
  const up4 = C.uploads.filter((u) => u.sha !== LEEG_SHA).pop();
  toets('3 ×4 met 6 MP: verkleind tot ≤ 1 MP, JPEG blijft JPEG, noot in gewone taal', t.status === 'klaar' && t.beeld.breed * t.beeld.hoog <= 1e6 && t.beeld.breed * t.beeld.hoog > 0.95e6 && t.beeld.verkleind && /verkleind van 6 MP naar 1 MP/.test(t.noot || ''), t);
  toets('3 wat naar ComfyUI ging is het verkleinde beeld', up4 && up4.lengte < GROOT.length && bewaard[t.id].bestanden.some((b) => b.naam === 'voor.jpg'), up4);
  beurt = nb(); zetUp(beurt, GROOT, 'groot.jpg');
  r = await S.maak({ flow: 'foto-proef', beurt_id: beurt, velden: { foto: { n: 1 }, schaal: 2 } }, ctx);
  t = await wacht(r.taak.id);
  toets('3 ×2 met 6 MP: verkleind tot ≤ 4 MP', t.status === 'klaar' && t.beeld.breed * t.beeld.hoog <= 4e6 && t.beeld.breed * t.beeld.hoog > 3.9e6, t.beeld);
  beurt = nb(); zetUp(beurt, WEBP, 'x.webp');
  r = await S.maak({ flow: 'foto-proef', beurt_id: beurt, velden: { foto: { n: 1 } } }, ctx);
  t = await wacht(r.taak.id);
  toets('3 webp onder de grens: ongewijzigd door', t.status === 'klaar' && !t.beeld.verkleind && bewaard[t.id].bestanden.some((b) => b.naam === 'voor.webp'), t);

  // 4. weigeren vóór de rij: upload blijft staan, geen restbestanden, niets naar ComfyUI
  const weiger = async (naam, bytes, re, st) => {
    const b = nb(); zetUp(b, bytes); const w0 = weg, u0 = C.uploads.length;
    const x = await S.maak({ flow: 'foto-proef', beurt_id: b, velden: { foto: { n: 1 } } }, ctx);
    toets('4 ' + naam + ': geweigerd (' + st + '), upload niet verbruikt, niets naar ComfyUI', x.status === st && re.test(x.fout) && weg === w0 && UP[b + '/1'] && C.uploads.length === u0, x);
  };
  await weiger('tekst als .png', Buffer.from('dit is geen beeld maar gewoon wat tekst'), /jpg, png of webp/, 415);
  await weiger('gif', GIF, /jpg, png of webp/, 415);
  await weiger('afgekapte jpg', KAPOT, /geen leesbare/, 400);
  await weiger('64 MP (bom)', BOM, /50 megapixel/, 400);
  await weiger('groter dan 20 MB', Buffer.concat([KLEIN, Buffer.alloc(21 * 1024 * 1024)]), /20 MB/, 413);
  toets('4 geen restbestanden na de weigeringen', werkRest().length === 0, werkRest());
  r = await S.maak({ flow: 'foto-proef', beurt_id: nb(), velden: { foto: { n: 1 } } }, ctx);
  toets('4 foto niet aangekomen: 409', r.status === 409 && /niet \(meer\) aangekomen/.test(r.fout), r);
  r = await S.maak({ flow: 'foto-proef', beurt_id: nb(), velden: {} }, ctx);
  toets('4 zonder foto: 400 kies eerst een foto', r.status === 400 && /kies eerst een foto/.test(r.fout), r);
  r = await S.maak({ flow: 'foto-proef', beurt_id: nb(), velden: { foto: { n: 1 } } }, { versOk: () => true, versVerbruik: () => {} });
  toets('4 zonder upload-ingang (bandjes-ctx): 400', r.status === 400, r);
  beurt = nb(); zetUp(beurt, KLEIN); vers = false;
  r = await S.maak({ flow: 'foto-op-proef', beurt_id: beurt, velden: { foto: { n: 1 } } }, ctx);
  toets('4 proef zonder vingerafdruk: 403 vóór de beeldcontrole, upload blijft', r.status === 403 && r.vers_nodig && UP[beurt + '/1'], r);
  vers = true;
  r = await S.maak({ flow: 'foto-op-proef', beurt_id: beurt, velden: { foto: { n: 1 } } }, ctx);
  toets('4 zelfde beurt met vingerafdruk: 200', r.status === 200, r);
  await wacht(r.taak.id);

  // 5. fout bij indienen en stop: toch 1×1
  C.prompt400 = true; beurt = nb(); zetUp(beurt, KLEIN);
  r = await S.maak({ flow: 'foto-proef', beurt_id: beurt, velden: { foto: { n: 1 } } }, ctx);
  t = await wacht(r.taak.id); C.prompt400 = false;
  toets('5 ComfyUI weigert de flow: mislukt, daarna 1×1, geen vlag', t.status === 'mislukt' && laatsteUpload().sha === LEEG_SHA && !fs.existsSync(VUIL), [t.reden, laatsteUpload()]);
  C.hangt = true; beurt = nb(); zetUp(beurt, KLEIN);
  r = await S.maak({ flow: 'foto-proef', beurt_id: beurt, velden: { foto: { n: 1 } } }, ctx);
  await totDat(() => C.rij.queue_running.length > 0);
  S.stop(r.taak.id);
  t = await wacht(r.taak.id); C.hangt = false;
  toets('5 stop tijdens de taak: gestopt, eigen prompt onderbroken, daarna 1×1', t.status === 'gestopt' && C.interrupts.length >= 1 && laatsteUpload().sha === LEEG_SHA, [t, laatsteUpload()]);
  C.andereNaam = true; beurt = nb(); zetUp(beurt, KLEIN); const p0 = C.prompts.length;
  r = await S.maak({ flow: 'foto-proef', beurt_id: beurt, velden: { foto: { n: 1 } } }, ctx);
  t = await wacht(r.taak.id); C.andereNaam = false;
  toets('5 ComfyUI geeft een andere naam: mislukt, niets ingediend, die naam óók 1×1', t.status === 'mislukt' && /andere naam/.test(t.reden) && C.prompts.length === p0 && sha(C.bestanden['studio/fotoherstel-invoer (1).png']) === LEEG_SHA, t);

  // 6. leegmaken mislukt → vlag → vrijRonde
  C.histNa = 4; beurt = nb(); zetUp(beurt, KLEIN);
  r = await S.maak({ flow: 'foto-proef', beurt_id: beurt, velden: { foto: { n: 1 } } }, ctx);
  await totDat(() => C.prompts.length && C.histN >= 1);
  C.uploadUit = true;   // ComfyUI neemt even geen uploads aan (1×1 faalt)
  t = await wacht(r.taak.id); C.histNa = 2;
  toets('6 1×1 mislukt: vlag blijft staan, foto nog in ComfyUI', fs.existsSync(VUIL) && sha(C.bestanden['studio/fotoherstel-invoer.png']) === sha(KLEIN), t.status);
  await S._vrijRonde();
  toets('6 vrijRonde met ComfyUI nog dicht: vlag blijft', fs.existsSync(VUIL));
  C.uploadUit = false;
  await S._vrijRonde();
  toets('6 vrijRonde daarna: 1×1 en vlag weg', !fs.existsSync(VUIL) && sha(C.bestanden['studio/fotoherstel-invoer.png']) === LEEG_SHA);
  // herstart midden in een taak: vlag staat, nieuwe instantie ruimt op
  fs.writeFileSync(VUIL, 'x'); C.bestanden['studio/fotoherstel-invoer.png'] = KLEIN;
  S.stopTimers(); S = maakStudio();
  await S._vrijRonde();
  toets('6 na een herstart ruimt de nieuwe instantie de foto in ComfyUI op', !fs.existsSync(VUIL) && sha(C.bestanden['studio/fotoherstel-invoer.png']) === LEEG_SHA);

  // 7. uitvoergrenzen
  C.uitvoer = 'groot'; beurt = nb(); zetUp(beurt, KLEIN);
  r = await S.maak({ flow: 'foto-proef', beurt_id: beurt, velden: { foto: { n: 1 } } }, ctx);
  t = await wacht(r.taak.id);
  toets('7 resultaat van 20 MP: mislukt met reden, 1×1 erna', t.status === 'mislukt' && /16 megapixel/.test(t.reden) && laatsteUpload().sha === LEEG_SHA, t.reden);
  C.uitvoer = 'zwaar'; beurt = nb(); zetUp(beurt, KLEIN);
  r = await S.maak({ flow: 'foto-proef', beurt_id: beurt, velden: { foto: { n: 1 } } }, ctx);
  t = await wacht(r.taak.id, 30000);
  const zw = t.status === 'klaar' && bewaard[t.id].bestanden.find((b) => /^na-1\./.test(b.naam));
  toets('7 resultaat > 10 MB: als JPEG bewaard (na-1.jpg)', zw && zw.naam === 'na-1.jpg' && zw.grootte < UIT.zwaar.length && afm(fs.readFileSync(path.join(BEWAAR, t.id, 'b', String(zw.n)))).fmt === 'JPEG', [t.status, t.reden, bewaard[t.id]]);
  C.uitvoer = 'tekst'; beurt = nb(); zetUp(beurt, KLEIN);
  r = await S.maak({ flow: 'foto-proef', beurt_id: beurt, velden: { foto: { n: 1 } } }, ctx);
  t = await wacht(r.taak.id);
  toets('7 resultaat dat geen beeld is: mislukt', t.status === 'mislukt' && /geen jpg, png of webp/.test(t.reden), t.reden);
  C.uitvoer = 'goed';

  // 8. knopentoets
  const ctxZonder = Object.assign({}, ctx);
  r = await S.maak({ flow: 'foto-ander-bestand', beurt_id: nb(), velden: {} }, ctxZonder);
  t = r.taak ? await wacht(r.taak.id) : null;
  toets('8 LoadImage met een ander bestand (voorbeeld.png): geweigerd door de knopentoets', t && t.status === 'mislukt' && /LoadImage mag alleen/.test(t.reden), t || r);
  toets('8 knopentoets: LoadImage alleen met de vaste naam', studioMod.flowToets({ 1: { class_type: 'LoadImage', inputs: { image: 'ander/geheim.png' } }, 2: { class_type: 'PreviewImage', inputs: { images: ['1', 0] } } }, OI).fout !== undefined
    && !studioMod.flowToets({ 1: { class_type: 'LoadImage', inputs: { image: 'studio/fotoherstel-invoer.png' } }, 2: { class_type: 'PreviewImage', inputs: { images: ['1', 0] } } }, OI).fout);
  toets('8 pakketknoop op naam + map: DDColor uit ComfyUI-DDColor mag', studioMod.knoopToets('DDColor_Colorize', OI) === null && studioMod.knoopToets('FaceRestoreCFWithModel', OI) === null);
  const OIvals = Object.assign({}, OI, { DDColor_Colorize: Object.assign({}, OI.DDColor_Colorize, { python_module: 'custom_nodes.nep-pakket' }) });
  toets('8 zelfde knoopnaam uit een ander pakket: geweigerd', /buiten de witte lijst/.test(studioMod.knoopToets('DDColor_Colorize', OIvals) || ''));
  toets('8 andere pakketknoop blijft geweigerd', /buiten de witte lijst/.test(studioMod.knoopToets('ImpactWildcardProcessor', Object.assign({ ImpactWildcardProcessor: { python_module: 'custom_nodes.ComfyUI-Impact-Pack', input: { required: {} } } }, OI)) || ''));
  beurt = nb(); zetUp(beurt, KLEIN);
  r = await S.maak({ flow: 'foto-kleur', beurt_id: beurt, velden: { foto: { n: 1 } } }, ctx);
  t = await wacht(r.taak.id);
  toets('8 inkleur-flow met DDColor-pakketknoop draait', t.status === 'klaar', t);
  beurt = nb(); zetUp(beurt, KLEIN);
  r = await S.maak({ flow: 'foto-proef', beurt_id: beurt, velden: { foto: { n: 1 }, gezichten: 'sterk' } }, ctx);
  t = r.taak ? await wacht(r.taak.id) : null;
  toets('8 keuze met een pad naar een knoop die er niet is: mislukt, niets ingediend', t && t.status === 'mislukt' && /wijst naar een knoop die er niet is/.test(t.reden), t || r);

  // 9. sporen
  const audit = fs.readFileSync(path.join(DIR, 'audit.jsonl'), 'utf8'), taken = fs.readFileSync(path.join(DIR, 'taken.json'), 'utf8');
  toets('9 geen bestandsnaam van David in audit, taken.json of log', [audit, taken, JSON.stringify(logs), JSON.stringify(fouts)].every((x) => x.indexOf('Truus') < 0 && x.indexOf('groot.jpg') < 0));
  toets('9 geen restbestanden in de werkmap', werkRest().length === 0, werkRest());
  toets('9 ComfyUI-invoer staat op 1×1', sha(C.bestanden['studio/fotoherstel-invoer.png']) === LEEG_SHA);
  S.stopTimers(); comfy.close();
  fs.rmSync(W, { recursive: true, force: true });
  console.log(fouten + ' ROOD, ' + goed + ' GROEN');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); process.exit(1); });
JS
