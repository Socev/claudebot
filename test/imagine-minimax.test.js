'use strict';
// Toets OVIS Imagine wv4335: MiniMax-H3 als derde vrije opdracht (keuze, niet de standaard), stuk/voorbeeld via beeld-plus-minimax-<n>
// (eigen knoop-id's p30/p31/p33/p40), en Vergelijk met body.minimax als derde taak (allemaal of geen). Nagebouwde ComfyUI, verzonnen beelden.
// Kruisproeven (moeten ROOD): IMAGINE_KRUIS=derde (pod negeert minimax → M4), =half (geen terugdraaien → M5). Vraagt python3 met Pillow.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), zlib = require('zlib');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const KRUIS = process.env.IMAGINE_KRUIS || '';
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 15000); while (Date.now() < t) { if (await f()) return true; await slaap(30); } return false; }
const py = (code, args, input) => execFileSync('python3', ['-I', '-c', 'import sys, io, os, json\nfrom PIL import Image, ImageChops, ImageDraw\n' + code].concat(args || []), { input: input || Buffer.alloc(0), maxBuffer: 64 * 1024 * 1024 });

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'imagine-mm-'));
const POD = path.join(W, 'pod'), COMFY = path.join(W, 'comfy');
fs.mkdirSync(POD);
const MOD = path.join(W, 'mod'); fs.mkdirSync(MOD);
for (const f of ['studio.js', 'studio-beeld.py', 'elevenlabs-credits.js', 'imagine.js']) fs.copyFileSync(path.join(ROOT, f), path.join(MOD, f));
function wijzig(f, oud, nieuw) { const p = path.join(MOD, f); const s = fs.readFileSync(p, 'utf8'); if (s.indexOf(oud) < 0) throw new Error('kruisproef: tekst niet gevonden in ' + f); fs.writeFileSync(p, s.split(oud).join(nieuw)); }
// kruisproef derde: de pod negeert body.minimax (altijd twee) → M4 ROOD; kruisproef half: geen terugdraaien als de derde niet kan → M5 ROOD
if (KRUIS === 'derde') wijzig('imagine.js', "d && d.minimax === true ? VERGELIJK.concat", "false ? VERGELIJK.concat");
if (KRUIS === 'half') wijzig('imagine.js', "for (const x of rs) if (!x.al)", "for (const x of []) if (!x.al)");
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

(async function () {
  const nep = await require('./imagine-nep-comfy.js').start(COMFY, { zonderWs: false });
  const C = nep.C;
  let nu = Date.parse('2026-11-27T10:00:00Z');
  const klok = () => nu;
  const STUDIO = path.join(POD, 'studio'), IMAGINE = path.join(POD, 'imagine'), LOG = path.join(POD, 'api.log');
  const zetFlow = (naam, y, api) => { fs.mkdirSync(path.join(STUDIO, 'flows', naam), { recursive: true }); fs.writeFileSync(path.join(STUDIO, 'flows', naam, 'flow.yaml'), JSON.stringify(y)); fs.writeFileSync(path.join(STUDIO, 'flows', naam, 'flow.json'), JSON.stringify(api)); };
  const L1 = { class_type: 'LoadImage', inputs: { image: 'voorbeeld.png', upload: 'image' } }, P2 = { class_type: 'PrimitiveStringMultiline', inputs: { value: '' } };
  const basisV = [{ naam: 'foto', label: 'Foto', soort: 'beeld', pad: '1.inputs.image' }, { naam: 'opdracht', label: 'Opdracht', soort: 'tekstvak', verplicht: true, pad: '2.inputs.value' }];
  const getal = (naam, pad) => ({ naam: naam, label: naam, soort: 'getal', min: 0, max: 16384, standaard: 1, meer: true, pad: pad });
  for (const [m, model] of [['qwen', 'Qwen-Image-Edit'], ['flux', 'FLUX.2 klein 4B'], ['minimax', 'MiniMax-H3-Image']]) {
    zetFlow('beeld-opdracht-' + m, { titel: 'Vrije opdracht ' + m, motor: 'comfyui', status: 'proef', verborgen: true, uitvoer: 'beeld', max_seconden: 5, ai_model: model, velden: basisV },
      { 1: L1, 2: P2, 9: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'f' } } });
  }
  // MiniMax-plus zoals de generator hem maakt: eigen knoop-id's met voorvoegsel p (p30/p31 knippen het beeld, p33 het voorbeeld, p40 zet terug)
  zetFlow('beeld-plus-minimax-0', { titel: 'plus 0 mm', motor: 'comfyui', status: 'proef', verborgen: true, uitvoer: 'beeld', max_seconden: 5, ai_model: 'MiniMax-H3-Image', velden: basisV },
    { 1: L1, 2: P2, p40: { class_type: 'ImageCompositeMasked', inputs: { destination: ['1', 0], source: ['1', 0], x: 0, y: 0, resize_source: false, mask: ['1', 1] } },
      9: { class_type: 'SaveImage', inputs: { images: ['p40', 0], filename_prefix: 'f' } } });
  zetFlow('beeld-plus-minimax-1', { titel: 'plus 1 mm', motor: 'comfyui', status: 'proef', verborgen: true, uitvoer: 'beeld', max_seconden: 5, ai_model: 'MiniMax-H3-Image',
    velden: basisV.concat([getal('pod_b0', ['p30.inputs.width', 'p31.inputs.width']), getal('pod_h0', ['p30.inputs.height', 'p31.inputs.height']), getal('pod_x1', ['p33.inputs.x']), getal('pod_b1', ['p33.inputs.width']), getal('pod_h1', ['p33.inputs.height'])]) },
    { 1: L1, 2: P2, p30: { class_type: 'ImageCrop', inputs: { image: ['1', 0], width: 1, height: 1, x: 0, y: 0 } }, p31: { class_type: 'CropMask', inputs: { mask: ['1', 1], x: 0, y: 0, width: 1, height: 1 } },
      p33: { class_type: 'ImageCrop', inputs: { image: ['1', 0], width: 1, height: 1, x: 0, y: 0 } },
      p40: { class_type: 'ImageCompositeMasked', inputs: { destination: ['p30', 0], source: ['p30', 0], x: 0, y: 0, resize_source: false, mask: ['p31', 0] } },
      9: { class_type: 'SaveImage', inputs: { images: ['p40', 0], filename_prefix: 'f' } } });
  const schrijfLog = (r) => fs.appendFileSync(LOG, r + '\n');
  const S = studioMod.maak({ dir: STUDIO, bewaar: () => { throw new Error('Bestanden mag niet'); }, primair: () => true, sleutel: async () => null,
    routerUrl: 'http://127.0.0.1:1', comfyUrl: nep.url, flowstudioUrl: 'http://127.0.0.1:1', taalmodelUrl: null, nu: klok,
    log: schrijfLog, fout: (w, e) => schrijfLog('FOUT ' + w + ': ' + (e && e.message)), merk: path.join(IMAGINE, 'incognito-merk.json'),
    tempo: { poll: 30, wachtStap: 40, wachtMax: 1500, naFree: 10, naloopStart: 0 } });
  const I = imagineMod.maak({ dir: IMAGINE, studio: S, primair: () => true, nu: klok, log: schrijfLog, fout: (w, e) => schrijfLog('FOUT ' + w + ': ' + (e && e.message)), tempo: { ronde: 3600000 } });
  const ctxJa = { versOk: () => true, versVerbruik: () => {} };
  const roep = (pad, body, a, ctx) => I.app({ pad: pad, methode: body === undefined ? 'GET' : 'POST', body: body, apparaat: a || 'apparaat-a', ctx: ctx || ctxJa });
  let bn = 0; const nb = () => 'beurt-' + (++bn) + '-' + crypto.randomBytes(3).toString('hex');
  const klaarOp = async (bron, n) => totDat(async () => { const b = (await roep('/app/imagine/bron/' + bron)).body; return b.taken.length >= n && b.taken.every((t) => t.status !== 'wacht' && t.status !== 'bezig'); }, 15000);

  // ── M1. de derde keuze ──
  let r = await roep('/app/imagine');
  const ids = r.body.standen.map((s) => s.id), sm = r.body.standen.find((s) => s.id === 'opdracht-minimax');
  toets('M1 MiniMax-H3 staat als derde vrije opdracht na Qwen en FLUX', ids.indexOf('opdracht-qwen') < ids.indexOf('opdracht-flux') && ids.indexOf('opdracht-flux') < ids.indexOf('opdracht-minimax'), ids);
  toets('M1 MiniMax: klaar, opdracht, "tekent opnieuw", masker en 1 voorbeeld', sm && sm.klaar && sm.opdracht === true && /tekent opnieuw/.test(sm.karakter) && sm.masker === true && sm.refs_max === 1, sm);
  toets('M1 MiniMax-flows niet in de Studio-lijst (verborgen)', !(await S.flows()).flows.some((f) => /minimax/.test(f.id)));

  // ── M2. gewone bewerking op MiniMax ──
  const orig = maakBeeld('mm2'), ref = maakBeeld('mm2ref', 120, 90);
  r = await roep('/app/imagine/laad', { data: orig.toString('base64'), titel: 'M2' });
  const bron = r.body.bron, v1 = r.body.versie;
  r = await roep('/app/imagine/laad', { data: ref.toString('base64'), titel: 'M2 voorbeeld' });
  const vRef = r.body.versie;
  let p0 = C.prompts.length;
  r = await roep('/app/imagine/bewerk', { versie: v1, stand: 'opdracht-minimax', velden: { opdracht: 'avondlicht' }, beurt_id: nb() });
  toets('M2 bewerk met MiniMax gestart', r.status === 200 && r.body.taak, r);
  await klaarOp(bron, 1);
  let vs = (await roep('/app/imagine/bron/' + bron)).body.versies;
  const vm = vs.find((v) => v.stand === 'opdracht-minimax');
  toets('M2 nieuwe versie met stand en model MiniMax-H3-Image', vm && vm.model === 'MiniMax-H3-Image' && !vm.masker, vs.map((v) => [v.stand, v.model]));
  toets('M2 via de websocket (SaveImageWebsocket), niets via SaveImage', (C.prompts[p0] || {}).prompt && (C.prompts[p0].prompt['9'] || {}).class_type === 'SaveImageWebsocket', C.prompts[p0]);

  // ── M3. stuk + voorbeeld op MiniMax: de plus-flow met de p-knopen, maten van de pod ──
  p0 = C.prompts.length;
  r = await roep('/app/imagine/bewerk', { versie: v1, stand: 'opdracht-minimax', velden: { opdracht: 'jas van Picture 2', pod_x1: 999 }, masker: maakMasker(100, 75, 0.2, 0.2, 0.6, 0.6).toString('base64'), refs: [vRef], beurt_id: nb() });
  toets('M3 MiniMax met stuk en één voorbeeld gestart', r.status === 200, r);
  await klaarOp(bron, 2);
  const pr = (C.prompts[p0] || {}).prompt || {};
  toets('M3 flow beeld-plus-minimax-1: p33 knipt het voorbeeld op de x van de pod (niet 999), p40 zet terug', pr.p33 && pr.p33.inputs.x > 0 && pr.p33.inputs.x !== 999 && pr.p30 && pr.p30.inputs.width > 1 && pr.p40 && pr.p40.inputs.mask[0] === 'p31', pr);
  vs = (await roep('/app/imagine/bron/' + bron)).body.versies;
  toets('M3 versie met masker en 1 voorbeeld', vs.some((v) => v.stand === 'opdracht-minimax' && v.masker && v.refs === 1), vs.map((v) => [v.stand, v.masker, v.refs]));

  // ── M4. vergelijk met MiniMax als derde ──
  let gebruikt = false, verbruik = 0;
  const ctxEen = { versOk: () => !gebruikt, versVerbruik: () => { gebruikt = true; verbruik++; } };
  const tVoor = (await roep('/app/imagine/bron/' + bron)).body.taken.length;
  r = await roep('/app/imagine/vergelijk', { versie: v1, velden: { opdracht: 'zomerdag' }, minimax: true, beurt_id: nb() }, 'apparaat-a', ctxEen);
  toets('M4 vergelijk met MiniMax: drie taken, één vingerafdruk', r.status === 200 && r.body.taken && r.body.taken.length === 3 && verbruik === 1, { r: r.body, verbruik });
  const groep = r.body.groep;
  await klaarOp(bron, tVoor + 3);
  vs = (await roep('/app/imagine/bron/' + bron)).body.versies.filter((v) => groep && v.vergelijk === groep);
  toets('M4 drie versies in de vergelijking: Qwen, FLUX en MiniMax', vs.length === 3 && ['opdracht-qwen', 'opdracht-flux', 'opdracht-minimax'].every((s) => vs.some((v) => v.stand === s)), vs.map((v) => v.stand));
  if (vs.length === 3) {
    const mm = vs.find((v) => v.stand === 'opdracht-minimax');
    r = await roep('/app/imagine/vergelijk/' + groep + '/kies', { houd: [mm.id] });
    const na = (await roep('/app/imagine/bron/' + bron)).body.versies;
    toets('M4 alleen MiniMax bewaard: die blijft, de andere twee weg', r.status === 200 && na.some((v) => v.id === mm.id && v.vergelijk === null) && vs.filter((v) => v.id !== mm.id).every((v) => !na.some((x) => x.id === v.id)), na.map((v) => [v.stand, v.vergelijk]));
  }
  // zonder minimax: zoals altijd twee
  r = await roep('/app/imagine/vergelijk', { versie: v1, velden: { opdracht: 'herfst' }, beurt_id: nb() });
  toets('M4 vergelijk zonder MiniMax: twee taken (Qwen, FLUX)', r.status === 200 && r.body.taken.length === 2 && r.body.taken.every((t) => t.stand !== 'opdracht-minimax'), r.body);
  await klaarOp(bron, tVoor + 5);
  if (r.status === 200) await roep('/app/imagine/vergelijk/' + r.body.groep + '/kies', { houd: [] });

  // review Codex ZOU 1: dezelfde beurt_id terwijl de eerste twee nog lopen, nu met drie modellen → 409 en de MiniMax-taak niet in de rij
  C.scenario = 'hang';
  const zelfde = nb();
  r = await roep('/app/imagine/vergelijk', { versie: v1, velden: { opdracht: 'lente' }, beurt_id: zelfde });
  const g2 = r.body.groep, eerste = (r.body.taken || []).map((t) => t.id);
  r = await roep('/app/imagine/vergelijk', { versie: v1, velden: { opdracht: 'lente' }, minimax: true, beurt_id: zelfde });
  await slaap(300);
  const mmLoopt = (await roep('/app/imagine/bron/' + bron)).body.taken.filter((t) => t.stand === 'opdracht-minimax' && (t.status === 'wacht' || t.status === 'bezig')).length;
  toets('M4 zelfde beurt (nog lopend) eerst twee, dan drie: 409 en geen MiniMax-taak in de rij', r.status === 409 && mmLoopt === 0, { s: r.status, f: r.body.fout, mmLoopt });
  for (const id of eerste) await roep('/app/imagine/stop/' + id, {});
  C.scenario = 'goed';
  await klaarOp(bron, 0);
  if (g2) await roep('/app/imagine/vergelijk/' + g2 + '/kies', { houd: [] });

  // ── M5. allemaal of geen: rij met plek voor drie maar MiniMax kan niet → niets blijft in de rij ──
  const yp = path.join(STUDIO, 'flows', 'beeld-opdracht-minimax', 'flow.yaml'), yOud = fs.readFileSync(yp, 'utf8');
  const y = JSON.parse(yOud); y.velden = basisV.concat([{ naam: 'kapot', label: 'kapot', soort: 'tekst', verplicht: true, pad: '77.inputs.value' }]);
  fs.writeFileSync(yp, JSON.stringify(y)); nu += 2000;   // flow.yaml herladen (mtime) met een veld dat de toets laat weigeren
  const fy = JSON.parse(fs.readFileSync(yp, 'utf8'));
  const tv = (await roep('/app/imagine/bron/' + bron)).body.taken.filter((t) => t.status === 'wacht' || t.status === 'bezig').length;
  C.scenario = 'hang';
  r = await roep('/app/imagine/vergelijk', { versie: v1, velden: { opdracht: 'winter' }, minimax: true, beurt_id: nb() });
  const fouteR = r;
  await slaap(300);
  const open5 = (await roep('/app/imagine/bron/' + bron)).body.taken.filter((t) => t.status === 'wacht' || t.status === 'bezig').length;
  toets('M5 MiniMax kan niet: vergelijken weigert en Qwen en FLUX staan niet meer in de rij', fouteR.status !== 200 && open5 === tv, { s: fouteR.status, f: fouteR.body && fouteR.body.fout, open5, tv, velden: fy.velden.length });
  C.scenario = 'goed';
  fs.writeFileSync(yp, yOud);

  const logT = fs.readFileSync(LOG, 'utf8');
  toets('M6 api.log zonder opdrachttekst, met de vergelijkregel "drie"', !/avondlicht|zomerdag|Picture 2|winter/.test(logT) && /imagine vergelijk groep=[a-f0-9]{16} drie/.test(logT), logT.split('\n').filter((x) => /imagine/.test(x)).slice(-8));

  S.stopTimers(); I.stopTimers(); nep.sluit();
  fs.rmSync(W, { recursive: true, force: true });
  console.log(fouten + ' ROOD, ' + goed + ' GROEN' + (KRUIS ? ' (kruisproef ' + KRUIS + ')' : ''));
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering: ' + (e && e.stack)); process.exit(1); });
