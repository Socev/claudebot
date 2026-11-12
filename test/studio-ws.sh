#!/usr/bin/env bash
# Toetst de websocket-uitvoer van studio.js (wv2983, OVIS Imagine fase 0) tegen een nagebootste ComfyUI op 127.0.0.1 mét /ws:
# een fotoflow stuurt zijn resultaat via SaveImageWebsocket (geen bestand in ComfyUI's tijdelijke map, geen /view), de eigen regel gaat
# na elke taak uit /history (ook na stop: vrijRonde), latente voorproefjes (JPEG) en beelden van andere knopen tellen niet, een weggevallen
# verbinding = mislukt, zonder websocket wordt niets ingediend, en zonder SaveImageWebsocket in ComfyUI blijft het de oude Preview-weg.
# Kruisproef (moet ROOD op § 1 "niets in de tijdelijke map"): KRUIS=preview bash test/studio-ws.sh  (ComfyUI zonder SaveImageWebsocket).
# Kruisproef geschiedenis: STUDIO_JS=<kopie zonder histWis-aanroep> bash test/studio-ws.sh  (ROOD op "geschiedenis leeg").
# Raakt de echte ComfyUI en /opt/data niet. Vraagt python3 met Pillow.
set -u
cd "$(dirname "$0")/.." || exit 1
python3 -c "import PIL" 2>/dev/null || { echo "ROOD  python3 met Pillow ontbreekt"; exit 1; }
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto'), { execFileSync } = require('child_process');
const studioMod = require(process.env.STUDIO_JS || './studio.js');
const KRUIS = process.env.KRUIS || '';
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ws-'));
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 15000); while (Date.now() < t) { if (await f()) return true; await slaap(25); } return false; }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ── proefbeelden (verzonnen: effen vlak en ruis) ──
const B = path.join(W, 'beelden'); fs.mkdirSync(B);
execFileSync('python3', ['-I', '-c', `
import sys, os
from PIL import Image
d = sys.argv[1]
Image.new('RGB', (640, 480), (120, 90, 60)).save(os.path.join(d, 'in.png'))
Image.new('RGB', (1280, 960), (20, 160, 30)).save(os.path.join(d, 'uit.png'))
Image.frombytes('RGB', (3000, 3000), os.urandom(3000 * 3000 * 3)).save(os.path.join(d, 'zwaar.png'), compress_level=1)
Image.new('RGB', (256, 256), (9, 9, 9)).save(os.path.join(d, 'latent.jpg'), quality=70)
Image.new('RGB', (64, 64), (250, 0, 250)).save(os.path.join(d, 'tussen.png'))
`, B]);
const lees = (n) => fs.readFileSync(path.join(B, n));
const IN = lees('in.png'), UIT = lees('uit.png'), ZWAAR = lees('zwaar.png'), LATENT = lees('latent.jpg'), TUSSEN = lees('tussen.png');
function afm(buf) { const f = path.join(W, 'afm-' + crypto.randomBytes(4).toString('hex')); fs.writeFileSync(f, buf); const r = execFileSync('python3', ['-I', '-c', 'import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]); print(im.size[0], im.size[1], im.format)', f]).toString().trim().split(' '); fs.rmSync(f); return { b: +r[0], h: +r[1], fmt: r[2] }; }

// ── nagebootste ComfyUI ──
const OI = {
  LoadImage: { python_module: 'nodes', input: { required: { image: [['voorbeeld.png'], { image_upload: true }] } } },
  ImageScaleBy: { python_module: 'nodes', input: { required: { image: ['IMAGE', {}], upscale_method: [['lanczos'], {}], scale_by: ['FLOAT', {}] } } },
  EmptyImage: { python_module: 'nodes', input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}], color: ['INT', {}] } } },
  PreviewImage: { python_module: 'nodes', output_node: true, input: { required: { images: ['IMAGE', {}] } } },
  SaveImage: { python_module: 'nodes', output_node: true, input: { required: { images: ['IMAGE', {}], filename_prefix: ['STRING', {}] } } },
  SaveImageWebsocket: { python_module: 'custom_nodes.websocket_image_save', output_node: true, input: { required: { images: ['IMAGE'] } } },
};
if (KRUIS === 'preview') delete OI.SaveImageWebsocket;
const C = { uploads: [], invoer: {}, prompts: [], temp: {}, hist: {}, viewN: 0, histDelete: [], interrupts: [], rij: { queue_running: [], queue_pending: [] },
  ws: {}, scenario: 'goed', uitvoer: UIT, geenWs: false, n: 0 };
// WebSocket-server (alleen wat ComfyUI doet: tekst- en binaire berichten naar één clientId)
function frame(op, data) {
  const len = data.length; let kop;
  if (len < 126) kop = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { kop = Buffer.alloc(4); kop[0] = 0x80 | op; kop[1] = 126; kop.writeUInt16BE(len, 2); }
  else { kop = Buffer.alloc(10); kop[0] = 0x80 | op; kop[1] = 127; kop.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([kop, data]);
}
const zendTekst = (cid, m) => { const s = C.ws[cid]; if (s && !s.destroyed) s.write(frame(1, Buffer.from(JSON.stringify(m)))); };
const zendBeeld = (cid, soort, buf) => { const s = C.ws[cid]; if (!s || s.destroyed) return; const kop = Buffer.alloc(8); kop.writeUInt32BE(1, 0); kop.writeUInt32BE(soort, 4); s.write(frame(2, Buffer.concat([kop, buf]))); };
function draai(pid, prompt, cid) {
  // voert de prompt 'uit': per uitvoerknoop executing + beeld of tijdelijk bestand; daarna geschiedenis en success
  const outputs = {};
  const ids = Object.keys(prompt);
  if (C.scenario === 'hang') { C.hangt = { pid, cid }; return; }
  for (const id of ids) {
    const k = prompt[id].class_type;
    zendTekst(cid, { type: 'executing', data: { node: id, display_node: id, prompt_id: pid } });
    if (C.scenario === 'ruis' && k === 'ImageScaleBy') { zendBeeld(cid, 1, LATENT); zendBeeld(cid, 2, TUSSEN); }
    if (k === 'SaveImageWebsocket') {
      if (C.scenario === 'wsweg') { C.ws[cid].destroy(); continue; }
      if (C.scenario === 'wsweg-hangt') { C.ws[cid].destroy(); C.hangt = { pid, cid }; return; }
      zendBeeld(cid, 2, C.uitvoer);
      zendTekst(cid, { type: 'progress', data: { value: 1, max: 1, prompt_id: pid, node: id } });
    }
    if (k === 'PreviewImage') { const fn = 'ComfyUI_temp_' + (++C.n) + '_.png'; C.temp[fn] = C.uitvoer; outputs[id] = { images: [{ filename: fn, subfolder: '', type: 'temp' }] }; }
  }
  C.hist[pid] = { prompt: [1, pid, prompt, { client_id: cid }, []], outputs, status: { status_str: 'success', completed: true, messages: [] } };
  C.rij = { queue_running: [], queue_pending: [] };
  zendTekst(cid, { type: 'execution_success', data: { prompt_id: pid } });
  zendTekst(cid, { type: 'executing', data: { node: null, prompt_id: pid } });
}
const comfy = http.createServer((req, res) => {
  const delen = []; req.on('data', (c) => delen.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(delen);
    const stuur = (st, j) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.url === '/upload/image' && req.method === 'POST') {
      const fd = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const f = fd.get('image'); const inhoud = Buffer.from(await f.arrayBuffer());
      C.uploads.push({ naam: f.name, sha: sha(inhoud) }); C.invoer[fd.get('subfolder') + '/' + f.name] = inhoud;
      return stuur(200, { name: f.name, subfolder: fd.get('subfolder'), type: 'input' });
    }
    if (req.url === '/object_info') return stuur(200, OI);
    if (req.url === '/queue' && req.method === 'GET') return stuur(200, C.rij);
    if (req.url === '/system_stats') return stuur(200, { system: { ram_free: 60 * 1073741824 }, devices: [{ vram_total: 24000 * 1048576, vram_free: 20000 * 1048576 }] });
    if (req.url === '/prompt' && req.method === 'POST') {
      const j = JSON.parse(body.toString());
      C.prompts.push(j);
      const pid = 'pid-' + C.prompts.length;
      C.rij = { queue_running: [[1, pid, j.prompt, {}, []]], queue_pending: [] };
      setTimeout(() => draai(pid, j.prompt, j.client_id), 40);
      return stuur(200, { prompt_id: pid });
    }
    if (req.url === '/history' && req.method === 'POST') {
      const j = JSON.parse(body.toString() || '{}');
      for (const p of j.delete || []) { C.histDelete.push(p); delete C.hist[p]; }
      if (j.clear) C.hist = {};
      return stuur(200, {});
    }
    const m = /^\/history\/(.+)$/.exec(req.url);
    if (m) { const p = decodeURIComponent(m[1]); return stuur(200, C.hist[p] ? { [p]: C.hist[p] } : {}); }
    if (req.url.indexOf('/view?') === 0) {
      C.viewN++;
      const fn = new URLSearchParams(req.url.slice(6)).get('filename');
      if (!C.temp[fn]) return stuur(404, {});
      res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(C.temp[fn]);
    }
    if (req.url === '/interrupt') {
      C.interrupts.push(JSON.parse(body.toString() || '{}'));
      const h = C.hangt; C.hangt = null;
      if (h) setTimeout(() => {   // zoals ComfyUI: de regel komt pas ná het onderbreken in de geschiedenis
        C.hist[h.pid] = { prompt: [1, h.pid, {}, {}, []], outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_interrupted', {}]] } };
        C.rij = { queue_running: [], queue_pending: [] };
        zendTekst(h.cid, { type: 'execution_interrupted', data: { prompt_id: h.pid } });
      }, 150);
      return stuur(200, {});
    }
    if (req.url === '/free') return stuur(200, {});
    stuur(404, {});
  });
});
comfy.on('upgrade', (req, sock) => {
  const m = /^\/ws\?clientId=(.+)$/.exec(req.url);
  if (C.geenWs || !m) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  const cid = decodeURIComponent(m[1]);
  C.ws[cid] = sock;
  sock.on('data', (d) => { if ((d[0] & 0x0f) === 8 && !sock.destroyed) { sock.end(frame(8, Buffer.alloc(0))); } });
  sock.on('error', () => {});
  zendTekst(cid, { type: 'status', data: { status: { exec_info: { queue_remaining: 0 } }, sid: cid } });
});

(async function () {
  await new Promise((r) => comfy.listen(0, '127.0.0.1', r));
  const CURL = 'http://127.0.0.1:' + comfy.address().port;
  const DIR = path.join(W, 'studio'), BEWAAR = path.join(W, 'app-bestanden');
  fs.mkdirSync(path.join(DIR, 'flows'), { recursive: true });
  const zetFlow = (naam, y, api) => { fs.mkdirSync(path.join(DIR, 'flows', naam), { recursive: true }); fs.writeFileSync(path.join(DIR, 'flows', naam, 'flow.yaml'), JSON.stringify(y)); fs.writeFileSync(path.join(DIR, 'flows', naam, 'flow.json'), JSON.stringify(api)); };
  const api = {
    1: { class_type: 'LoadImage', inputs: { image: 'voorbeeld.png', upload: 'image' } },
    2: { class_type: 'ImageScaleBy', inputs: { image: ['1', 0], upscale_method: 'lanczos', scale_by: 2 } },
    9: { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'foto' } },
  };
  zetFlow('foto-ws', { titel: 'Foto (ws)', motor: 'comfyui', status: 'actief', uitvoer: 'beeld', max_seconden: 5, velden: [{ naam: 'foto', label: 'Foto', soort: 'beeld', pad: '1.inputs.image' }] }, api);
  zetFlow('beeld-zonder-foto', { titel: 'Effen beeld', motor: 'comfyui', status: 'actief', uitvoer: 'beeld', max_seconden: 5, velden: [] },
    { 1: { class_type: 'EmptyImage', inputs: { width: 64, height: 64, batch_size: 1, color: 0 } }, 9: { class_type: 'PreviewImage', inputs: { images: ['1', 0] } } });

  const bewaard = {};
  const bewaar = (jobId, outdir, meta) => {
    const dir = path.join(BEWAAR, jobId); fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
    const lijst = [];
    for (const n of fs.readdirSync(outdir).sort()) { const doel = path.join(dir, 'b', String(lijst.length + 1)); const g = fs.statSync(path.join(outdir, n)).size; fs.renameSync(path.join(outdir, n), doel); lijst.push({ n: lijst.length + 1, naam: n, grootte: g }); }
    const m = { job_id: jobId, bestanden: lijst, label: meta.label }; bewaard[jobId] = m; return m;
  };
  const leesBewaard = (id, naam) => { const b = bewaard[id] && bewaard[id].bestanden.find((x) => x.naam === naam); return b ? fs.readFileSync(path.join(BEWAAR, id, 'b', String(b.n))) : null; };
  const logs = [], fouts = [];
  const S = studioMod.maak({ dir: DIR, bewaar, primair: () => true, sleutel: async () => null, routerUrl: 'http://127.0.0.1:1', comfyUrl: CURL, flowstudioUrl: 'http://127.0.0.1:1',
    log: (r) => logs.push(r), fout: (w, e) => fouts.push(w + ': ' + (e && e.message)), tempo: { poll: 30, wachtStap: 40, wachtMax: 1500 } });
  const UP = {};
  const ctx = { versOk: () => true, versVerbruik: () => {}, apparaat: 'toets',
    neemUpload: (beurt, n) => UP[beurt + '/' + n] ? { naam: UP[beurt + '/' + n].naam, bytes: UP[beurt + '/' + n].bytes, weg: () => { delete UP[beurt + '/' + n]; } } : null };
  let bn = 0; const nb = () => 'beurt-' + (++bn) + '-' + crypto.randomBytes(3).toString('hex');
  const wacht = async (id, ms) => { await totDat(() => { const t = S.taak(id); return t && ['klaar', 'mislukt', 'gestopt'].indexOf(t.status) >= 0; }, ms); return S.taak(id); };
  const fotoTaak = async () => { const b = nb(); UP[b + '/1'] = { naam: 'Oma.png', bytes: IN }; const r = await S.maak({ flow: 'foto-ws', beurt_id: b, velden: { foto: { n: 1 } } }, ctx); return r.taak ? r.taak.id : r; };
  const invoerLeeg = () => (C.invoer['studio/fotoherstel-invoer.png'] || Buffer.alloc(0)).length < 200;

  // 1. websocket-uitvoer: resultaat komt aan, niets in de tijdelijke map, geen /view, geschiedenis leeg
  let id = await fotoTaak();
  let t = await wacht(id);
  const pr = C.prompts[C.prompts.length - 1].prompt;
  toets('1 taak klaar', t && t.status === 'klaar', t);
  toets('1 niets in de tijdelijke map van ComfyUI en geen /view', Object.keys(C.temp).length === 0 && C.viewN === 0, { temp: Object.keys(C.temp), view: C.viewN });
  toets('1 geschiedenis leeg na de taak (eigen regel gewist)', Object.keys(C.hist).length === 0 && C.histDelete.indexOf(t && t.meting && t.meting.prompt_id) >= 0, { hist: Object.keys(C.hist), del: C.histDelete });
  toets('1 SaveImage werd SaveImageWebsocket, alleen met het beeld als invoer', pr['9'].class_type === 'SaveImageWebsocket' && JSON.stringify(pr['9'].inputs) === '{"images":["2",0]}', pr['9']);
  toets('1 resultaat in Bestanden = precies wat ComfyUI stuurde', sha(leesBewaard(id, 'na-1.png') || Buffer.alloc(0)) === sha(UIT) && !!leesBewaard(id, 'voor.png'), bewaard[id]);
  toets('1 meting zegt uitvoer websocket; invoer weer 1×1', t.meting && t.meting.uitvoer === 'websocket' && invoerLeeg(), t.meting);

  // 2. voorproefjes en beelden van andere knopen tellen niet
  C.scenario = 'ruis';
  id = await fotoTaak(); t = await wacht(id);
  toets('2 alleen het beeld van de uitvoerknoop telt (JPEG-voorproefje en PNG van een tussenknoop genegeerd)', t.status === 'klaar' && bewaard[id].bestanden.filter((b) => /^na-/.test(b.naam)).length === 1 && sha(leesBewaard(id, 'na-1.png')) === sha(UIT), bewaard[id]);

  // 3. groot beeld (9 MP ruis, ± 27 MB): heel aangekomen, boven 10 MB als JPEG bewaard
  C.scenario = 'goed'; C.uitvoer = ZWAAR;
  id = await fotoTaak(); t = await wacht(id, 30000);
  const jpg = leesBewaard(id, 'na-1.jpg');
  const a = jpg ? afm(jpg) : {};
  toets('3 groot beeld: klaar, 3000×3000, als JPEG (boven 10 MB)', t.status === 'klaar' && a.b === 3000 && a.h === 3000 && a.fmt === 'JPEG', { t: t.status, reden: t.reden, a });
  C.uitvoer = UIT;

  // 4. verbinding valt weg vóór het beeld: mislukt, geschiedenis toch gewist, invoer 1×1
  C.scenario = 'wsweg';
  id = await fotoTaak(); t = await wacht(id);
  await totDat(() => !C.hist[t.meting && t.meting.prompt_id], 3000);
  toets('4 verbinding weg: mislukt met uitleg', t.status === 'mislukt' && /verbinding|geen beeld/.test(t.reden || ''), t);
  toets('4 geschiedenis en invoer toch leeg', Object.keys(C.hist).length === 0 && invoerLeeg(), Object.keys(C.hist));

  // 4b. verbinding weg terwijl ComfyUI nog rekent: de pod stopt zijn eigen taak (Codex MOET 2) en wist daarna de regel
  C.scenario = 'wsweg-hangt';
  const i0 = C.interrupts.length;
  id = await fotoTaak(); t = await wacht(id);
  await totDat(() => Object.keys(C.hist).length > 0, 3000);
  toets('4b verbinding weg tijdens het rekenen: mislukt en eigen taak onderbroken', t.status === 'mislukt' && /verbinding/.test(t.reden || '') && C.interrupts.length === i0 + 1 && C.interrupts[i0].prompt_id === t.meting.prompt_id, { t: t.status, r: t.reden, i: C.interrupts });
  await S._vrijRonde();
  toets('4b daarna regel gewist en invoer 1×1', Object.keys(C.hist).length === 0 && invoerLeeg(), Object.keys(C.hist));

  // 5. stop midden in de taak: de regel komt pas na het onderbreken; vrijRonde wist hem
  C.scenario = 'hang';
  id = await fotoTaak();
  await totDat(() => C.hangt, 5000);
  S.stop(id);
  t = await wacht(id);
  await totDat(() => Object.keys(C.hist).length > 0, 3000);
  toets('5 gestopt, onderbroken, regel staat er (nog)', t.status === 'gestopt' && C.interrupts.length === 2 && Object.keys(C.hist).length === 1, { t: t.status, i: C.interrupts, h: Object.keys(C.hist) });
  await S._vrijRonde();
  toets('5 vrijRonde wist de regel', Object.keys(C.hist).length === 0, Object.keys(C.hist));
  C.scenario = 'goed';

  // 6. zonder websocket: niets ingediend
  C.geenWs = true;
  const p0 = C.prompts.length;
  id = await fotoTaak(); t = await wacht(id, 20000);
  toets('6 geen websocket: mislukt, niets ingediend, invoer 1×1', t.status === 'mislukt' && /websocket/.test(t.reden || '') && C.prompts.length === p0 && invoerLeeg(), t);
  C.geenWs = false;

  // 7. flow zonder foto blijft Preview (zoals voorheen), maar de geschiedenis gaat wel leeg
  const v0 = C.viewN;
  let r = await S.maak({ flow: 'beeld-zonder-foto', beurt_id: nb(), velden: {} }, ctx);
  t = await wacht(r.taak.id);
  const pr7 = C.prompts[C.prompts.length - 1].prompt;
  toets('7 flow zonder foto: PreviewImage en /view, meting preview', t.status === 'klaar' && pr7['9'].class_type === 'PreviewImage' && C.viewN === v0 + 1 && t.meting.uitvoer === 'preview', t);
  toets('7 ook dan de geschiedenis leeg', Object.keys(C.hist).length === 0, Object.keys(C.hist));
  for (const k of Object.keys(C.temp)) delete C.temp[k];

  // 8. knopentoets
  const ft = studioMod.flowToets;
  const zonder = Object.assign({}, OI); delete zonder.SaveImageWebsocket;
  const ander = Object.assign({}, OI, { SaveImageWebsocket: Object.assign({}, OI.SaveImageWebsocket, { python_module: 'custom_nodes.ergens_anders' }) });
  toets('8 SaveImageWebsocket letterlijk in een flow zonder ws: geweigerd', !!ft({ 1: { class_type: 'EmptyImage', inputs: { width: 8, height: 8, batch_size: 1, color: 0 } }, 2: { class_type: 'SaveImageWebsocket', inputs: { images: ['1', 0] } } }, OI).fout);
  toets('8 ws gevraagd maar knoop ontbreekt of komt uit een ander pakket: geweigerd', !!ft(api, zonder, { ws: true }).fout && !!ft(api, ander, { ws: true }).fout);
  toets('8 ws zonder beelduitvoer: geweigerd', /geen beelduitvoer/.test(ft({ 1: { class_type: 'EmptyImage', inputs: { width: 8, height: 8, batch_size: 1, color: 0 } } }, OI, { ws: true }).fout || ''));
  toets('8 extra velden op de uitvoerknoop gaan niet mee', JSON.stringify((ft({ 1: { class_type: 'LoadImage', inputs: { image: 'studio/fotoherstel-invoer.png' } }, 9: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: '../../x' } } }, OI, { ws: true }).prompt || {})['9']) === '{"class_type":"SaveImageWebsocket","inputs":{"images":["1",0]}}');

  toets('9 geen onverwachte fouten in de log', fouts.length === 0, fouts);
  fs.rmSync(W, { recursive: true, force: true });
  console.log(fouten + ' ROOD, ' + goed + ' GROEN');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering: ' + (e && e.stack)); process.exit(1); });
JS
