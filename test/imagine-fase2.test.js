'use strict';
// Toets OVIS Imagine fase 2 (wv3021): masker ("alleen een stuk"), voorbeelden, vergelijk, bijsnijden/draaien, en masker+voorbeeld in incognito.
// Nagebouwde ComfyUI (test/imagine-nep-comfy.js): een prompt met ImageCompositeMasked geeft het beeld OMGEKEERD terug zonder masker, dus
// de naad klopt alleen als de pod (studio-beeld.py pijp-naad) buiten het gegroeide masker het verstuurde beeld terugzet.
// Kruisproeven (moeten ROOD): IMAGINE_KRUIS=naad (geen naadherstel in de pod), =pod (de app kan de knipmaten pod_* zetten),
// =vinger (vergelijk vraagt de vingerafdruk per taak i.p.v. één keer). Verzonnen beelden (ruis). Vraagt python3 met Pillow.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), zlib = require('zlib');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const KRUIS = process.env.IMAGINE_KRUIS || '';
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 15000); while (Date.now() < t) { if (await f()) return true; await slaap(30); } return false; }
const py = (code, args, input) => execFileSync('python3', ['-I', '-c', 'import sys, io, os, json\nfrom PIL import Image, ImageChops, ImageDraw\n' + code].concat(args || []), { input: input || Buffer.alloc(0), maxBuffer: 64 * 1024 * 1024 });

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'imagine-f2-'));
const POD = path.join(W, 'pod'), COMFY = path.join(W, 'comfy');
fs.mkdirSync(POD);
const MOD = path.join(W, 'mod'); fs.mkdirSync(MOD);
for (const f of ['studio.js', 'studio-beeld.py', 'elevenlabs-credits.js', 'imagine.js']) fs.copyFileSync(path.join(ROOT, f), path.join(MOD, f));
function wijzig(f, oud, nieuw) { const p = path.join(MOD, f); const s = fs.readFileSync(p, 'utf8'); if (s.indexOf(oud) < 0) throw new Error('kruisproef: tekst niet gevonden in ' + f); fs.writeFileSync(p, s.split(oud).join(nieuw)); }
if (KRUIS === 'naad') wijzig('imagine.js', 'if (!naad) return { bytes: b.bytes, verschil_px: null };', 'return { bytes: b.bytes, verschil_px: null };');
if (KRUIS === 'pod') wijzig('imagine.js', 'Object.assign(zonderPod(d.velden), vb.velden)', 'Object.assign({}, vb.velden, d.velden)');
if (KRUIS === 'vinger') wijzig('imagine.js', 'ctx2, apparaat, groep);', 'ctx, apparaat, groep);');
const studioMod = require(path.join(MOD, 'studio.js'));
const imagineMod = require(path.join(MOD, 'imagine.js'));

function maakBeeld(merk, b, h) {
  return py(`from PIL import PngImagePlugin
i = PngImagePlugin.PngInfo(); i.add_text('merk', sys.argv[1])
u = io.BytesIO(); Image.frombytes('RGB', (int(sys.argv[2]), int(sys.argv[3])), os.urandom(int(sys.argv[2]) * int(sys.argv[3]) * 3)).save(u, 'PNG', pnginfo=i)
sys.stdout.buffer.write(u.getvalue())`, [merk, String(b || 200), String(h || 150)]);
}
// zwart-wit masker (PNG) met een witte rechthoek in breuken van het beeld
function maakMasker(b, h, x0, y0, x1, y1) {
  return py(`b, h = int(sys.argv[1]), int(sys.argv[2]); m = Image.new('L', (b, h), 0)
x0, y0, x1, y1 = int(float(sys.argv[3]) * b), int(float(sys.argv[4]) * h), int(float(sys.argv[5]) * b) - 1, int(float(sys.argv[6]) * h) - 1
if x1 >= x0 and y1 >= y0: ImageDraw.Draw(m).rectangle((x0, y0, x1, y1), fill=255)
u = io.BytesIO(); m.save(u, 'PNG'); sys.stdout.buffer.write(u.getvalue())`, [b, h, x0, y0, x1, y1].map(String));
}
// naad: [binnen-anders, binnen-totaal, buiten-anders, buiten-totaal] van resultaat tegen origineel, met de alfa van de upload als masker
function naadMeting(upload, origineel, resultaat, deel) {
  const n = (b) => { const k = Buffer.alloc(4); k.writeUInt32BE(b.length); return Buffer.concat([k, b]); };
  return JSON.parse(py(`d = sys.stdin.buffer.read(); f = []; i = 0
while i < len(d):
    n = int.from_bytes(d[i:i+4], 'big'); f.append(d[i+4:i+4+n]); i += 4 + n
x, y, b, h = [int(v) for v in sys.argv[1:5]]
up = Image.open(io.BytesIO(f[0])); a = up.getchannel('A').crop((x, y, x + b, y + h))
o = Image.open(io.BytesIO(f[1])).convert('RGB'); r = Image.open(io.BytesIO(f[2])).convert('RGB')
vast = a.point(lambda v: 255 if v == 255 else 0); vrij = a.point(lambda v: 255 if v == 0 else 0)
dif = ImageChops.difference(r, o).convert('L').point(lambda v: 255 if v else 0)
t = lambda m: sum(m.histogram()[255:])
print(json.dumps([t(ImageChops.multiply(dif, vrij)), t(vrij), t(ImageChops.multiply(dif, vast)), t(vast)]))`, deel.map(String), Buffer.concat([n(upload), n(origineel), n(resultaat)])).toString());
}
function lengte(b) { const k = Buffer.alloc(4); k.writeUInt32BE(b.length); return k; }
function maten(png) { return JSON.parse(py(`im = Image.open(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps([im.size[0], im.size[1], im.mode]))`, [], png).toString()); }
function naalden(teksten, beelden) {
  const n = teksten.map((t) => ({ wat: 'tekst', b: Buffer.from(t) }));
  for (const img of beelden) {
    const mid = Math.floor(img.length / 2);
    n.push({ wat: 'beeld-rauw', b: img.subarray(mid, mid + 48) });
    for (let a = 0; a < 3; a++) { const s = img.subarray(a).toString('base64'); const m = Math.floor(s.length / 2) & ~3; n.push({ wat: 'beeld-b64-' + a, b: Buffer.from(s.slice(m, m + 48)) }); }
  }
  return n;
}
function zoek(wortels, nn) {
  const treffers = [];
  const loop = (p) => {
    let st; try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isDirectory()) { for (const k of fs.readdirSync(p)) loop(path.join(p, k)); return; }
    if (!st.isFile()) return;
    const buf = fs.readFileSync(p), lagen = [buf];
    if (p.endsWith('.gz')) { try { lagen.push(zlib.gunzipSync(buf)); } catch (e) {} }
    for (const l of lagen) for (const x of nn) if (l.indexOf(x.b) >= 0) treffers.push(path.relative(W, p) + ':' + x.wat);
  };
  for (const w of wortels) loop(w);
  return treffers;
}

(async function () {
  const nep = await require('./imagine-nep-comfy.js').start(COMFY, { zonderWs: false });
  const C = nep.C;
  const nu = Date.parse('2026-11-13T10:00:00Z');
  const klok = () => nu;
  const STUDIO = path.join(POD, 'studio'), IMAGINE = path.join(POD, 'imagine'), LOG = path.join(POD, 'api.log');
  const zetFlow = (naam, y, api) => { fs.mkdirSync(path.join(STUDIO, 'flows', naam), { recursive: true }); fs.writeFileSync(path.join(STUDIO, 'flows', naam, 'flow.yaml'), JSON.stringify(y)); fs.writeFileSync(path.join(STUDIO, 'flows', naam, 'flow.json'), JSON.stringify(api)); };
  const L1 = { class_type: 'LoadImage', inputs: { image: 'voorbeeld.png', upload: 'image' } }, P2 = { class_type: 'PrimitiveStringMultiline', inputs: { value: '' } };
  const basisV = [{ naam: 'foto', label: 'Foto', soort: 'beeld', pad: '1.inputs.image' }, { naam: 'opdracht', label: 'Opdracht', soort: 'tekstvak', verplicht: true, pad: '2.inputs.value' }];
  const getal = (naam, pad) => ({ naam: naam, label: naam, soort: 'getal', min: 0, max: 16384, standaard: 1, meer: true, pad: pad });
  for (const [m, model] of [['qwen', 'Qwen-Image-Edit'], ['flux', 'FLUX.2 klein 4B']]) {
    zetFlow('beeld-opdracht-' + m, { titel: 'Vrije opdracht ' + m, motor: 'comfyui', status: 'proef', uitvoer: 'beeld', max_seconden: 5, ai_model: model, velden: basisV },
      { 1: L1, 2: P2, 9: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'f' } } });
    zetFlow('beeld-plus-' + m + '-0', { titel: 'plus 0 ' + m, motor: 'comfyui', status: 'proef', verborgen: true, uitvoer: 'beeld', max_seconden: 5, ai_model: model, velden: basisV },
      { 1: L1, 2: P2, 40: { class_type: 'ImageCompositeMasked', inputs: { destination: ['1', 0], source: ['1', 0], x: 0, y: 0, resize_source: false, mask: ['1', 1] } },
        9: { class_type: 'SaveImage', inputs: { images: ['40', 0], filename_prefix: 'f' } } });
  }
  zetFlow('beeld-plus-qwen-1', { titel: 'plus 1 qwen', motor: 'comfyui', status: 'proef', verborgen: true, uitvoer: 'beeld', max_seconden: 5, ai_model: 'Qwen-Image-Edit',
    velden: basisV.concat([getal('pod_b0', ['30.inputs.width', '31.inputs.width']), getal('pod_h0', ['30.inputs.height', '31.inputs.height']), getal('pod_x1', ['33.inputs.x']), getal('pod_b1', ['33.inputs.width']), getal('pod_h1', ['33.inputs.height'])]) },
    { 1: L1, 2: P2, 30: { class_type: 'ImageCrop', inputs: { image: ['1', 0], width: 1, height: 1, x: 0, y: 0 } }, 31: { class_type: 'CropMask', inputs: { mask: ['1', 1], x: 0, y: 0, width: 1, height: 1 } },
      33: { class_type: 'ImageCrop', inputs: { image: ['1', 0], width: 1, height: 1, x: 0, y: 0 } },
      40: { class_type: 'ImageCompositeMasked', inputs: { destination: ['30', 0], source: ['30', 0], x: 0, y: 0, resize_source: false, mask: ['31', 0] } },
      9: { class_type: 'SaveImage', inputs: { images: ['40', 0], filename_prefix: 'f' } } });
  zetFlow('foto-opknappen', { titel: 'Opknappen (toets)', motor: 'comfyui', status: 'proef', uitvoer: 'beeld', max_seconden: 5, ai_model: 'SeedVR2',
    velden: [{ naam: 'foto', label: 'Foto', soort: 'beeld', pad: '1.inputs.image' }] }, { 1: L1, 9: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'f' } } });
  const schrijfLog = (r) => fs.appendFileSync(LOG, r + '\n');
  const S = studioMod.maak({ dir: STUDIO, bewaar: () => { throw new Error('Bestanden mag niet'); }, primair: () => true, sleutel: async () => null,
    routerUrl: 'http://127.0.0.1:1', comfyUrl: nep.url, flowstudioUrl: 'http://127.0.0.1:1', taalmodelUrl: null, nu: klok,
    log: schrijfLog, fout: (w, e) => schrijfLog('FOUT ' + w + ': ' + (e && e.message)), merk: path.join(IMAGINE, 'incognito-merk.json'),
    tempo: { poll: 30, wachtStap: 40, wachtMax: 1500, naFree: 10, naloopStart: 0 } });
  const I = imagineMod.maak({ dir: IMAGINE, studio: S, primair: () => true, nu: klok, log: schrijfLog, fout: (w, e) => schrijfLog('FOUT ' + w + ': ' + (e && e.message)), tempo: { ronde: 3600000 } });
  const ctxJa = { versOk: () => true, versVerbruik: () => {} }, ctxNee = { versOk: () => false, versVerbruik: () => {} };
  const roep = (pad, body, a, ctx) => I.app({ pad: pad, methode: body === undefined ? 'GET' : 'POST', body: body, apparaat: a || 'apparaat-a', ctx: ctx || ctxJa });
  let bn = 0; const nb = () => 'beurt-' + (++bn) + '-' + crypto.randomBytes(3).toString('hex');
  const klaarOp = async (bron, n) => totDat(async () => { const b = (await roep('/app/imagine/bron/' + bron)).body; return b.taken.length >= n && b.taken.every((t) => t.status !== 'wacht' && t.status !== 'bezig'); }, 15000);
  const deel = async (id) => { const r = await roep('/app/imagine/v/' + id + '/deel/1'); return r.status === 200 ? Buffer.from(r.body.data, 'base64') : Buffer.alloc(0); };

  // ── F1. standen ──
  let r = await roep('/app/imagine');
  const sq = r.body.standen.find((s) => s.id === 'opdracht-qwen'), sf = r.body.standen.find((s) => s.id === 'opdracht-flux'), so = r.body.standen.find((s) => s.id === 'opknappen');
  toets('F1 Qwen: masker en 1 voorbeeld; FLUX: masker, 0 voorbeelden; Opknappen: geen masker', sq && sq.masker === true && sq.refs_max === 1 && sf && sf.masker === true && sf.refs_max === 0 && so && so.masker === false, r.body.standen);
  toets('F1 geen pod_-velden in wat de app ziet', !r.body.standen.some((s) => s.velden.some((v) => /^pod_/.test(v.naam))));
  const fl = await S.flows();
  toets('F1 plus-flows niet in de Studio-lijst (verborgen)', !fl.flows.some((f) => /^beeld-plus-/.test(f.id)) && fl.flows.some((f) => f.id === 'beeld-opdracht-qwen'), fl.flows.map((f) => f.id));

  // ── F2. masker in de gewone stand ──
  const orig = maakBeeld('f2'), ref = maakBeeld('f2ref', 120, 90);
  r = await roep('/app/imagine/laad', { data: orig.toString('base64'), titel: 'F2' });
  const bron = r.body.bron, v1 = r.body.versie;
  r = await roep('/app/imagine/laad', { data: ref.toString('base64'), titel: 'F2 voorbeeld' });
  const vRef = r.body.versie;
  const mk = maakMasker(100, 75, 0.25, 0.25, 0.75, 0.75).toString('base64');
  r = await roep('/app/imagine/bewerk', { versie: v1, stand: 'opknappen', masker: mk, beurt_id: nb() });
  toets('F2 masker bij een vaste stand: 400', r.status === 400, r);
  r = await roep('/app/imagine/bewerk', { versie: v1, stand: 'opdracht-qwen', velden: { opdracht: 'maak dit stuk rood' }, masker: maakMasker(40, 30, 0, 0, 0, 0).toString('base64'), beurt_id: nb() });
  toets('F2 leeg masker: 400 met uitleg', r.status === 400 && /leeg/.test(r.body.fout), r);
  r = await roep('/app/imagine/bewerk', { versie: v1, stand: 'opdracht-qwen', velden: { opdracht: 'x' }, masker: orig.subarray(0, 50).toString('base64').replace(/=+$/, '') + 'AAAA', beurt_id: nb() });
  toets('F2 kapot masker: 400', r.status === 400, r);
  const p0 = C.prompts.length;
  r = await roep('/app/imagine/bewerk', { versie: v1, stand: 'opdracht-qwen', velden: { opdracht: 'maak dit stuk rood' }, masker: mk, beurt_id: nb() });
  toets('F2 bewerken met masker gestart', r.status === 200 && r.body.taak, r);
  await klaarOp(bron, 1);
  r = await roep('/app/imagine/bron/' + bron);
  const vm = r.body.versies.find((v) => v.nr === 2);
  const pr = C.prompts[p0] || {};
  toets('F2 flow beeld-plus-qwen-0: ImageCompositeMasked met het masker uit LoadImage, uitvoer via de websocket', pr.prompt && pr.prompt['40'] && pr.prompt['40'].inputs.mask[0] === '1' && pr.prompt['40'].inputs.mask[1] === 1 && pr.prompt['9'].class_type === 'SaveImageWebsocket', pr.prompt);
  const up = C.laatsteUpload, mUp = up ? maten(up) : null;
  toets('F2 één upload: RGBA-PNG op de maat van het beeld', mUp && mUp[0] === 200 && mUp[1] === 150 && mUp[2] === 'RGBA', mUp);
  toets('F2 nieuwe versie: masker, stand en model; naad_px = wat de "flow" buiten het masker fout had (> 0 bij de nep)', vm && vm.masker === true && vm.stand === 'opdracht-qwen' && vm.model === 'Qwen-Image-Edit' && (vm.naad_px > 0 || KRUIS === 'naad'), vm);
  const res = vm ? await deel(vm.id) : Buffer.alloc(0);
  const nm = res.length ? naadMeting(up, orig, res, [0, 0, 200, 150]) : [0, 1, 1, 1];
  toets('F2 NAAD: buiten het gegroeide masker byte-gelijk aan het origineel', nm[2] === 0 && nm[3] > 0, nm);
  toets('F2 binnen het masker veranderd (de nep keerde om)', nm[0] > 0.9 * nm[1] && nm[1] > 0, nm);
  // nm[1] = volledig vrij (alfa 0, ± het getekende stuk), nm[3] = vast (alfa 255); daartussen de zachte groeirand
  toets('F2 masker: het getekende stuk helemaal vrij, een zachte groeirand eromheen, de rest vast', nm[1] >= 100 * 75 && nm[1] < 200 * 150 * 0.5 && nm[1] + nm[3] < 200 * 150 && 200 * 150 - nm[3] > 100 * 75 * 1.1, nm);
  toets('F2 ComfyUI daarna schoon (geschiedenis leeg, invoer 1×1)', Object.keys(C.hist).length === 0 && fs.statSync(nep.invoerPad).size < 200);

  // ── F3. voorbeelden ──
  r = await roep('/app/imagine/bewerk', { versie: v1, stand: 'opdracht-qwen', velden: { opdracht: 'x' }, refs: [v1], beurt_id: nb() });
  toets('F3 het beeld zelf als voorbeeld: 400', r.status === 400, r);
  r = await roep('/app/imagine/bewerk', { versie: v1, stand: 'opdracht-qwen', velden: { opdracht: 'x' }, refs: [vRef, vRef, vRef], beurt_id: nb() });
  toets('F3 drie voorbeelden: 400', r.status === 400, r);
  r = await roep('/app/imagine/bewerk', { versie: v1, stand: 'opdracht-qwen', velden: { opdracht: 'x' }, refs: ['0123456789abcdef'], beurt_id: nb() });
  toets('F3 onbekend voorbeeld: 404', r.status === 404, r);
  r = await roep('/app/imagine/bewerk', { versie: v1, stand: 'opdracht-flux', velden: { opdracht: 'x' }, refs: [vRef], beurt_id: nb() });
  toets('F3 voorbeeld bij FLUX zonder flow voor voorbeelden: 409', r.status === 409, r);
  const p1 = C.prompts.length;
  r = await roep('/app/imagine/bewerk', { versie: v1, stand: 'opdracht-qwen', velden: { opdracht: 'jas van het voorbeeld', pod_b0: 5, pod_x1: 3 }, refs: [vRef], beurt_id: nb() });
  toets('F3 bewerken met een voorbeeld gestart', r.status === 200, r);
  await klaarOp(bron, 2);
  const pr1 = C.prompts[p1] || {}, up1 = C.laatsteUpload, m1 = up1 ? maten(up1) : null;
  toets('F3 één upload: beeld + voorbeeld naast elkaar (200 + 120 breed)', m1 && m1[0] === 320 && m1[1] === 150, m1);
  toets('F3 knipmaten van de pod, niet van de app (pod_b0 = 200, voorbeeld op x = 200)', pr1.prompt && pr1.prompt['30'].inputs.width === 200 && pr1.prompt['31'].inputs.width === 200 && pr1.prompt['33'].inputs.x === 200 && pr1.prompt['33'].inputs.width === 120 && pr1.prompt['33'].inputs.height === 90,
    pr1.prompt && [pr1.prompt['30'].inputs, pr1.prompt['33'].inputs]);
  const toonRef = Buffer.from((await roep('/app/imagine/v/' + vRef + '/toon')).body.data, 'base64');
  const refGelijk = up1 ? py(`d = sys.stdin.buffer.read(); n = int.from_bytes(d[:4], 'big'); a = Image.open(io.BytesIO(d[4:4+n])).convert('RGB').crop((200, 0, 320, 90)); b = Image.open(io.BytesIO(d[4+n:])).convert('RGB')
print(ImageChops.difference(a, b).getbbox() is None)`, [], Buffer.concat([lengte(up1), up1, toonRef])).toString().trim() : 'False';
  toets('F3 het voorbeeld in de upload = de weergaveversie uit de bibliotheek', refGelijk === 'True', refGelijk);
  r = await roep('/app/imagine/bron/' + bron);
  const vr = r.body.versies.find((v) => v.nr === 3);
  toets('F3 versie met refs = 1, zonder masker', vr && vr.refs === 1 && vr.masker === false, vr);

  // ── F4. vergelijk ──
  const tVoor = (await roep('/app/imagine/bron/' + bron)).body.taken.length;
  r = await roep('/app/imagine/vergelijk', { versie: v1, velden: { opdracht: 'zomerdag' }, beurt_id: nb() }, 'apparaat-a', ctxNee);
  toets('F4 zonder verse vingerafdruk: 403 vers_nodig, niets in de rij', r.status === 403 && r.body.vers_nodig === true && (await roep('/app/imagine/bron/' + bron)).body.taken.length === tVoor, r);
  let gebruikt = false, verbruik = 0;
  const ctxEen = { versOk: () => !gebruikt, versVerbruik: () => { gebruikt = true; verbruik++; } };
  r = await roep('/app/imagine/vergelijk', { versie: v1, velden: { opdracht: 'zomerdag' }, beurt_id: nb() }, 'apparaat-a', ctxEen);
  toets('F4 vergelijk met één vingerafdruk: twee taken (Qwen, FLUX.2 klein), vingerafdruk één keer verbruikt', r.status === 200 && /^[a-f0-9]{16}$/.test(r.body.groep) && r.body.taken.length === 2 && verbruik === 1, { r: r.body, verbruik });
  const groep = r.body.groep;
  await klaarOp(bron, tVoor + 2);
  r = await roep('/app/imagine/bron/' + bron);
  const vg = r.body.versies.filter((v) => groep && v.vergelijk === groep);
  toets('F4 twee versies in de vergelijking, links Qwen en rechts FLUX, elk met hun tijd', vg.length === 2 && vg.some((v) => v.stand === 'opdracht-qwen') && vg.some((v) => v.stand === 'opdracht-flux') && vg.every((v) => typeof v.duur_s === 'number' || v.duur_s === null),
    r.body.versies.map((v) => [v.nr, v.stand, v.vergelijk]));
  toets('F4 de taken dragen de groep', r.body.taken.filter((t) => t.vergelijk === groep).length === 2);
  if (vg.length === 2) {
    r = await roep('/app/imagine/v/' + vg[0].id + '/snij', { x: 0, y: 0, b: 0.5, h: 0.5, draai: 0 });
    toets('F4 bijsnijden van een versie uit een open vergelijking: 409', r.status === 409, r);
    r = await roep('/app/imagine/vergelijk/' + groep + '/kies', { houd: ['0123456789abcdef'] });
    toets('F4 kies met een vreemde versie: 400', r.status === 400, r);
    const links = vg.find((v) => v.stand === 'opdracht-qwen'), rechts = vg.find((v) => v.stand === 'opdracht-flux');
    r = await roep('/app/imagine/vergelijk/' + groep + '/kies', { houd: [links.id] });
    const na = (await roep('/app/imagine/bron/' + bron)).body.versies;
    toets('F4 links bewaard: links gewone versie, rechts weg (ook het bestand)', r.status === 200 && na.some((v) => v.id === links.id && v.vergelijk === null) && !na.some((v) => v.id === rechts.id)
      && !fs.existsSync(path.join(IMAGINE, 'toon', rechts.id + '.jpg')), { r, na: na.map((v) => [v.id, v.vergelijk]) });
    r = await roep('/app/imagine/vergelijk/' + groep + '/kies', { houd: [] });
    toets('F4 nog eens kiezen: 404', r.status === 404, r);
  }
  // rij bijna vol: vergelijk weigert vooraf en zet niets in de rij
  C.scenario = 'hang';
  const taken5 = [];
  for (let i = 0; i < 5; i++) { const x = await roep('/app/imagine/bewerk', { versie: vRef, stand: 'opknappen', beurt_id: nb() }); if (x.body.taak) taken5.push(x.body.taak.id); }
  await totDat(() => !!C.hangt, 5000);
  const nVoor = (await roep('/app/imagine')).body.taken.length;
  r = await roep('/app/imagine/vergelijk', { versie: v1, velden: { opdracht: 'vol' }, beurt_id: nb() });
  toets('F4 rij met 4 wachtende taken: vergelijk 429, niets erbij', r.status === 429 && (await roep('/app/imagine')).body.taken.length === nVoor, { s: r.status, f: r.body.fout });
  for (const t of taken5.reverse()) await roep('/app/imagine/stop/' + t, {});
  C.scenario = 'goed';
  await totDat(async () => (await roep('/app/imagine')).body.taken.every((t) => t.status !== 'wacht' && t.status !== 'bezig'), 10000);

  // ── F5. bijsnijden en draaien ──
  r = await roep('/app/imagine/v/' + v1 + '/snij', { x: 0, y: 0, b: 1, h: 1, draai: 0 });
  toets('F5 niets veranderd: 400', r.status === 400, r);
  r = await roep('/app/imagine/v/' + v1 + '/snij', { x: 0.6, y: 0, b: 0.5, h: 1, draai: 0 });
  toets('F5 uitsnede buiten het beeld: 400', r.status === 400, r);
  r = await roep('/app/imagine/v/' + v1 + '/snij', { x: 0, y: 0, b: 0.5, h: 0.5, draai: 45 });
  toets('F5 draaien anders dan per kwartslag: 400', r.status === 400, r);
  r = await roep('/app/imagine/v/' + v1 + '/snij', { x: 0.25, y: 0.2, b: 0.5, h: 0.6, draai: 90 });
  toets('F5 bijsnijden + draaien: nieuwe versie', r.status === 200 && /^[a-f0-9]{16}$/.test(r.body.versie), r);
  const vs = r.body.versie;
  const bs = (await roep('/app/imagine/bron/' + bron)).body.versies.find((v) => v.id === vs);
  toets('F5 versie: stand snijden, voorganger = het origineel, maten 90 × 100, PNG', bs && bs.stand === 'snijden' && bs.voorganger === v1 && bs.breed === 90 && bs.hoog === 100 && bs.ext === 'png', bs);
  const sn = await deel(vs);
  const exact = py(`d = sys.stdin.buffer.read(); n = int.from_bytes(d[:4], 'big'); o = Image.open(io.BytesIO(d[4:4+n])).convert('RGB'); s = Image.open(io.BytesIO(d[4+n:])).convert('RGB')
e = o.crop((50, 30, 150, 120)).transpose(Image.ROTATE_270)
print(e.size == s.size and ImageChops.difference(e, s).getbbox() is None)`, [], Buffer.concat([lengte(orig), orig, sn])).toString().trim();
  toets('F5 exact: pixel voor pixel gelijk aan uitsnijden + kwartslag met de klok mee', exact === 'True', exact);
  toets('F5 het origineel bleef staan', (await deel(v1)).equals(orig));

  // ── F6. incognito: masker + voorbeeld, daarna wissen en zoeken ──
  const M = 'merkF2INC' + crypto.randomBytes(8).toString('hex'), WOORD = 'woordF2INC' + crypto.randomBytes(8).toString('hex');
  const i1 = maakBeeld(M), i2 = maakBeeld(M + 'r', 120, 90);
  const a1 = (await roep('/app/imagine/incognito/laad', { data: i1.toString('base64') })).body.beeld;
  const a2 = (await roep('/app/imagine/incognito/laad', { data: i2.toString('base64') })).body.beeld;
  r = await roep('/app/imagine/incognito/bewerk', { beeld: a1, stand: 'opdracht-qwen', velden: { opdracht: 'x' }, refs: ['0123456789abcdef'], beurt_id: nb() });
  toets('F6 incognito: voorbeeld van buiten de sessie: 410', r.status === 410, r);
  r = await roep('/app/imagine/incognito/bewerk', { beeld: a1, stand: 'opdracht-qwen', velden: { opdracht: 'x' }, refs: [vRef], beurt_id: nb() });
  toets('F6 incognito: een beeld uit de bibliotheek als voorbeeld kan niet', r.status === 410, r);
  r = await roep('/app/imagine/incognito/bewerk', { beeld: a1, stand: 'opdracht-qwen', velden: { opdracht: 'stuk ' + WOORD }, masker: mk, refs: [a2], beurt_id: nb() });
  toets('F6 incognito bewerken met masker en voorbeeld gestart', r.status === 200, r);
  await totDat(async () => (await roep('/app/imagine/incognito')).body.beelden.length === 3, 15000);
  const upI = C.laatsteUpload, mI = upI ? maten(upI) : null;
  const ri = (await roep('/app/imagine/incognito')).body.beelden.find((x) => x.voorganger === a1);
  const resI = ri ? Buffer.from((await roep('/app/imagine/incognito/b/' + ri.id + '/deel/1')).body.data, 'base64') : Buffer.alloc(0);
  const nI = resI.length && upI ? naadMeting(upI, i1, resI, [0, 0, 200, 150]) : [0, 1, 1, 1];
  toets('F6 incognito: één upload met beeld + voorbeeld, naad exact', mI && mI[0] === 320 && nI[2] === 0 && nI[0] > 0, { mI, nI });
  const NN = naalden([M, WOORD], [i1, i2, resI]);
  r = await roep('/app/imagine/incognito/wis', {});
  toets('F6 wissen schoon', r.status === 200 && r.body.schoon === true, r.body);
  const tz = zoek([POD, COMFY], NN);
  toets('F6 nul treffers voor merk, woord en beelden in alles wat de pod schrijft en in de nep-ComfyUI', tz.length === 0, tz);

  // ── F7. logboeken ──
  const logT = fs.readFileSync(LOG, 'utf8');
  toets('F7 api.log zonder opdrachttekst, zonder FOUT, met de nieuwe regels', !/maak dit stuk rood|jas van het voorbeeld|zomerdag/.test(logT) && !/FOUT/.test(logT) && /imagine bewerk .*masker=1/.test(logT) && /imagine vergelijk groep=/.test(logT) && /imagine snij versie=/.test(logT),
    logT.split('\n').filter((x) => /imagine|FOUT/.test(x)).slice(-12));
  const audit = fs.readFileSync(path.join(STUDIO, 'audit.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x)).filter((x) => x.soort === 'incognito');
  toets('F7 audit incognito alleen de telregel', audit.length === 1 && Object.keys(audit[0]).sort().join() === 'duur_s,soort,t,uitkomst', audit);

  S.stopTimers(); I.stopTimers(); nep.sluit();
  fs.rmSync(W, { recursive: true, force: true });
  console.log(fouten + ' ROOD, ' + goed + ' GROEN' + (KRUIS ? ' (kruisproef ' + KRUIS + ')' : ''));
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering: ' + (e && e.stack)); process.exit(1); });
