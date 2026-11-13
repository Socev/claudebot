'use strict';
// Nagebouwde ComfyUI voor de Imagine-toetsen (wv2984): http + /ws op 127.0.0.1, met ECHTE mappen op schijf (input/, temp/, output/) en een
// geschiedenis die ook als bestand bewaard wordt (history.json), zodat de zoektocht naar het merk ook "de geschiedenis en de mappen van de
// nep" doorzoekt. SaveImageWebsocket stuurt de invoer terug (dus het merk zit in het resultaat); PreviewImage schrijft het in temp/.
// Neemt prompt_id uit POST /prompt over (zoals ComfyUI). Scenario 'hang': de taak blijft lopen tot /interrupt.
// wv2990: een prompt zonder LoadImage (tekst naar beeld) geeft C.t2iBeeld terug (de toets zet daar een beeld met het opdrachtwoord in).
// wv3021: een prompt met ImageCompositeMasked (masker/voorbeelden) knipt het beeld uit de invoer (ImageCrop van 'destination', of de hele
// invoer) en geeft het OMGEKEERD terug, zonder masker: alsof de flow buiten het masker níét terugzette. Dan moet de pod (pijp-naad) het doen.
// C.laatsteUpload = kopie van de laatste upload (alleen in het geheugen van de nep, voor de toets).
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');
const { execFileSync } = require('child_process');
function omgekeerd(buf, deel) {
  return execFileSync('python3', ['-I', '-c', `import sys, io
from PIL import Image, ImageChops
im = Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGB')
x, y, b, h = [int(v) for v in sys.argv[1:5]]
if b > 0: im = im.crop((x, y, x + b, y + h))
u = io.BytesIO(); ImageChops.invert(im).save(u, 'PNG'); sys.stdout.buffer.write(u.getvalue())`].concat(deel.map(String)), { input: buf, maxBuffer: 64 * 1024 * 1024 });
}
function start(dir, o) {
  o = o || {};
  for (const d of ['input/studio', 'temp', 'output']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const OI = {
    LoadImage: { python_module: 'nodes', input: { required: { image: [['voorbeeld.png'], { image_upload: true }] } } },
    ImageScaleBy: { python_module: 'nodes', input: { required: { image: ['IMAGE', {}], upscale_method: [['lanczos'], {}], scale_by: ['FLOAT', {}] } } },
    EmptyImage: { python_module: 'nodes', input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}], color: ['INT', {}] } } },   // wv2990
    PrimitiveStringMultiline: { python_module: 'comfy_extras.nodes_primitive', input: { required: { value: ['STRING', {}] } } },
    PreviewImage: { python_module: 'nodes', output_node: true, input: { required: { images: ['IMAGE', {}] } } },
    SaveImage: { python_module: 'nodes', output_node: true, input: { required: { images: ['IMAGE', {}], filename_prefix: ['STRING', {}] } } },
    SaveImageWebsocket: { python_module: 'custom_nodes.websocket_image_save', output_node: true, input: { required: { images: ['IMAGE'] } } },
    // wv3021
    ImageCrop: { python_module: 'comfy_extras.nodes_images', input: { required: { image: ['IMAGE', {}], width: ['INT', {}], height: ['INT', {}], x: ['INT', {}], y: ['INT', {}] } } },
    CropMask: { python_module: 'comfy_extras.nodes_mask', input: { required: { mask: ['MASK', {}], x: ['INT', {}], y: ['INT', {}], width: ['INT', {}], height: ['INT', {}] } } },
    ImageCompositeMasked: { python_module: 'comfy_extras.nodes_mask', input: { required: { destination: ['IMAGE', {}], source: ['IMAGE', {}], x: ['INT', {}], y: ['INT', {}], resize_source: ['BOOLEAN', {}] }, optional: { mask: ['MASK', {}] } } },
  };
  if (o.zonderWs) delete OI.SaveImageWebsocket;
  const C = { prompts: [], hist: {}, histDelete: [], interrupts: [], free: 0, rij: { queue_running: [], queue_pending: [] }, ws: {}, scenario: 'goed', n: 0, hangt: null, t2iBeeld: null, uploads: 0, laatsteUpload: null };
  const histPad = path.join(dir, 'history.json');
  const histBewaar = () => fs.writeFileSync(histPad, JSON.stringify(C.hist));
  histBewaar();
  const invoerPad = path.join(dir, 'input', 'studio', 'fotoherstel-invoer.png');
  function frame(op, data) {
    const len = data.length; let kop;
    if (len < 126) kop = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { kop = Buffer.alloc(4); kop[0] = 0x80 | op; kop[1] = 126; kop.writeUInt16BE(len, 2); }
    else { kop = Buffer.alloc(10); kop[0] = 0x80 | op; kop[1] = 127; kop.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([kop, data]);
  }
  const zendTekst = (cid, m) => { const s = C.ws[cid]; if (s && !s.destroyed) s.write(frame(1, Buffer.from(JSON.stringify(m)))); };
  const zendBeeld = (cid, buf) => { const s = C.ws[cid]; if (!s || s.destroyed) return; const kop = Buffer.alloc(8); kop.writeUInt32BE(1, 0); kop.writeUInt32BE(2, 4); s.write(frame(2, Buffer.concat([kop, buf]))); };
  function afronden(pid, prompt, cid, outputs, status) {
    C.hist[pid] = { prompt: [1, pid, prompt, { client_id: cid }, []], outputs: outputs, status: status };
    histBewaar();
    C.rij = { queue_running: [], queue_pending: [] };
  }
  function draai(pid, prompt, cid) {
    if (C.scenario === 'hang') { C.hangt = { pid, cid, prompt }; return; }
    const outputs = {};
    const metFoto = Object.keys(prompt).some((id) => prompt[id].class_type === 'LoadImage');
    let invoer = !metFoto && C.t2iBeeld ? C.t2iBeeld : fs.existsSync(invoerPad) ? fs.readFileSync(invoerPad) : Buffer.alloc(0);   // wv2990
    const samen = Object.keys(prompt).find((id) => prompt[id].class_type === 'ImageCompositeMasked');   // wv3021
    if (samen && invoer.length) {
      const dst = prompt[samen].inputs.destination, k = prompt[dst[0]];
      invoer = omgekeerd(invoer, k && k.class_type === 'ImageCrop' ? [k.inputs.x, k.inputs.y, k.inputs.width, k.inputs.height] : [0, 0, 0, 0]);
    }
    for (const id of Object.keys(prompt)) {
      const k = prompt[id].class_type;
      zendTekst(cid, { type: 'executing', data: { node: id, prompt_id: pid } });
      if (k === 'SaveImageWebsocket') zendBeeld(cid, invoer);
      if (k === 'PreviewImage') { const fn = 'ComfyUI_temp_' + (++C.n) + '_.png'; fs.writeFileSync(path.join(dir, 'temp', fn), invoer); outputs[id] = { images: [{ filename: fn, subfolder: '', type: 'temp' }] }; }
    }
    afronden(pid, prompt, cid, outputs, { status_str: 'success', completed: true, messages: [] });
    zendTekst(cid, { type: 'execution_success', data: { prompt_id: pid } });
    zendTekst(cid, { type: 'executing', data: { node: null, prompt_id: pid } });
  }
  const srv = http.createServer((req, res) => {
    const delen = []; req.on('data', (c) => delen.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(delen);
      const stuur = (st, j) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.url === '/upload/image' && req.method === 'POST') {
        const fd = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
        const f = fd.get('image');
        C.uploads++;
        const ub = Buffer.from(await f.arrayBuffer());
        if (ub.length > 200) C.laatsteUpload = ub;   // wv3021 (niet de 1×1)
        fs.writeFileSync(path.join(dir, 'input', fd.get('subfolder'), f.name), ub);
        return stuur(200, { name: f.name, subfolder: fd.get('subfolder'), type: 'input' });
      }
      if (req.url === '/object_info') return stuur(200, OI);
      if (req.url === '/queue' && req.method === 'GET') return stuur(200, C.rij);
      if (req.url === '/queue' && req.method === 'POST') { const j = JSON.parse(body.toString() || '{}'); C.rij.queue_pending = C.rij.queue_pending.filter((x) => (j.delete || []).indexOf(x[1]) < 0); return stuur(200, {}); }
      if (req.url === '/system_stats') return stuur(200, { system: { ram_free: 60 * 1073741824 }, devices: [{ vram_total: 24000 * 1048576, vram_free: 20000 * 1048576 }] });
      if (req.url === '/prompt' && req.method === 'POST') {
        const j = JSON.parse(body.toString());
        C.prompts.push(j);
        const pid = typeof j.prompt_id === 'string' && j.prompt_id ? j.prompt_id : 'pid-' + C.prompts.length;
        // promptWacht: het antwoord (en de rij) komt pas na zoveel ms — het venster tussen indienen en bevestigen
        const nu = () => { C.rij = { queue_running: [[1, pid, j.prompt, {}, []]], queue_pending: [] }; setTimeout(() => draai(pid, j.prompt, j.client_id), C.draaiWacht || 30); stuur(200, { prompt_id: pid, number: C.prompts.length }); };
        if (C.promptWacht) return void setTimeout(nu, C.promptWacht);
        return nu();
      }
      if (req.url === '/history' && req.method === 'POST') {
        const j = JSON.parse(body.toString() || '{}');
        for (const p of j.delete || []) { C.histDelete.push(p); delete C.hist[p]; }
        histBewaar();
        return stuur(200, {});
      }
      const m = /^\/history\/(.+)$/.exec(req.url);
      if (m) { const p = decodeURIComponent(m[1]); return stuur(200, C.hist[p] ? { [p]: C.hist[p] } : {}); }
      if (req.url.indexOf('/view?') === 0) {
        const fn = new URLSearchParams(req.url.slice(6)).get('filename');
        const f = path.join(dir, 'temp', path.basename(fn));
        if (!fs.existsSync(f)) return stuur(404, {});
        res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(fs.readFileSync(f));
      }
      if (req.url === '/interrupt') {
        C.interrupts.push(JSON.parse(body.toString() || '{}'));
        const h = C.hangt; C.hangt = null;
        if (h) setTimeout(() => { afronden(h.pid, h.prompt, h.cid, {}, { status_str: 'error', completed: false, messages: [['execution_interrupted', {}]] }); zendTekst(h.cid, { type: 'execution_interrupted', data: { prompt_id: h.pid } }); }, 60);
        return stuur(200, {});
      }
      if (req.url === '/free') { C.free++; return stuur(200, {}); }
      stuur(404, {});
    });
  });
  srv.on('upgrade', (req, sock) => {
    const m = /^\/ws\?clientId=(.+)$/.exec(req.url);
    if (!m) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
    const cid = decodeURIComponent(m[1]);
    C.ws[cid] = sock;
    sock.on('data', (d) => { if ((d[0] & 0x0f) === 8 && !sock.destroyed) sock.end(frame(8, Buffer.alloc(0))); });
    sock.on('error', () => {});
  });
  return new Promise((r) => srv.listen(o.poort || 0, '127.0.0.1', () => r({ url: 'http://127.0.0.1:' + srv.address().port, C, srv, invoerPad, sluit: () => { for (const k of Object.keys(C.ws)) { try { C.ws[k].destroy(); } catch (e) {} } srv.close(); } })));
}
module.exports = { start };
