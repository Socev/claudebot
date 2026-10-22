#!/usr/bin/env bash
# Toetst studio.js (wv707, tab Studio fase 1) tegen een nagebootste Olares Router en ComfyUI op 127.0.0.1 en een nep-Piper.
# Toetst: catalogus uit Router /v1/models (alleen FlowStudio-projecten van Olares; betaalde aanbieders niet; formulier uit
# flowstudio.parameters; "wacht op sleutel" zonder sleutel en dan niets naar Router), Router-taak (Prefer: respond-async, eigen
# sleutel, params onder flowstudio.params, pollen, content_url alleen op Router zelf), proef = verse vingerafdruk per keer + Activeer,
# grenzen (rij 5, 30 per dag, beurt_id dubbel), knopentoets (geweigerde knoop, betaalde partnerknoop, Save -> Preview), gedeelde
# ComfyUI (niet-lege wachtrij = wachten, niets indienen of onderbreken; stoppen onderbreekt alleen het eigen prompt_id), VRAM voor/na,
# herstart (bezig -> onderbroken), geen prompttekst in de audit, geen restbestanden buiten de bewaarplek.
# wv736: geheugencontrole vóór een FlowStudio-taak (nep-FlowStudio /api/projects/<id> + nep-/proc/meminfo: te weinig = meteen mislukt
# zonder Router-aanroep, ook als het geheugen zakt terwijl de taak in de rij staat; FlowStudio of meminfo onleesbaar of motor al bezig =
# oude gedrag; geheugenfout van Router in gewone taal) en muziek (POST /v1/music/generations, pollen, flac, soort uit de bytes).
# Raakt de echte Router, ComfyUI, kluis en /opt/data niet. Gebruik: bash test/studio.sh   (PIPER_ECHT=1: ook de echte Piper)
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const studioMod = require('./studio.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-'));
const SLEUTEL = 'rk-studio-' + 'k'.repeat(30);
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 8000); while (Date.now() < t) { if (await f()) return true; await slaap(25); } return false; }

// ── nagebootste Router ──
const MOSS = 'd38d1e2d-64a6-4d9f-9326-5b748977f007', MUZIEK = 'a668f087-626d-4afd-b6a3-7f94ddcd2306';
const R = { posts: [], gets: [], auth: [], status: 'in_progress', polls: 0, pollsTotKlaar: 2, contentUrl: '/v1/images/generations/job-1/content/0', weiger: 0, muziekType: 'audio/flac' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const FLAC = Buffer.concat([Buffer.from('fLaC', 'latin1'), Buffer.alloc(300, 3)]);
// fout zoals gemeten 22-10 (wv718): error als tekst, error_code upstream_capacity_unavailable
const mislukt = (id) => R.status === 'failed' ? { id, status: 'failed', error: 'engine_host_mem_unavailable', error_code: 'upstream_capacity_unavailable', retryable: true }
  : R.status === 'failed-code' ? { id, status: 'failed', error: 'capacity', error_code: 'upstream_capacity_unavailable' }
  : R.status === 'failed-ander' ? { id, status: 'failed', error: 'workflow_invalid' } : null;
const router = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    const stuur = (st, j, kop) => { res.writeHead(st, Object.assign({ 'Content-Type': 'application/json' }, kop || {})); res.end(JSON.stringify(j)); };
    R.auth.push(req.headers.authorization || '');
    if (req.url === '/v1/models') return stuur(200, { object: 'list', data: [
      { id: 'Olares/' + MOSS, owned_by: 'Olares', name: 'OpenMOSS', mode: 'image_generation', canonical_fields: ['seed', 'prompt', 'negative_prompt', 'n'], readiness: 'ready',
        flowstudio: { parameters: [
          { associateRole: 'prompt', default: 'demo', key: 'prompt__18:17', label: 'Text (User Prompt)', required: true, type: 'textarea' },
          { default: '', key: 'text', label: 'Negative Prompt', type: 'textarea' },
          { default: '0.41', key: 'megapixels', label: 'Megapixels', options: [{ label: '360p', value: '0.23' }, { label: '480p', value: '0.41' }], required: true, type: 'select' },
          { default: 1, key: 'batch_count', label: 'Batch generate', required: false, type: 'batch' }] } },
      // MiniMax zoals Router hem 22-10 beschreef (wv736)
      { id: 'Olares/' + MUZIEK, owned_by: 'Olares', name: 'MiniMax Music 3', mode: 'music_generation', canonical_fields: ['seed', 'prompt', 'output.duration_seconds', 'n'], readiness: 'ready',
        flowstudio: { parameters: [{ associateRole: 'prompt', default: '', key: 'caption', label: 'Music description', required: true, type: 'text' },
          { default: '', key: 'lyrics', label: 'Lyrics', type: 'text' }, { default: 60, key: 'max_duration', label: 'Duration (sec)', required: true, type: 'number' },
          { default: 1, key: 'batch_count', label: 'Batch generate', required: false, type: 'batch' }] } },
      { id: 'elevenlabs/eleven_v3', owned_by: 'elevenlabs', mode: 'tts' },
      { id: 'openai/gpt-image-2.5-flare', owned_by: 'openai', mode: 'image_generation' },
      { id: 'Olares/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL', owned_by: 'Olares', mode: 'chat' }] });
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      R.posts.push({ url: req.url, kop: req.headers, body: JSON.parse(body || '{}') });
      if (R.weiger === 503) return stuur(503, { error: 'engine_host_mem_unavailable', error_code: 'upstream_capacity_unavailable' });
      if (R.weiger) return stuur(R.weiger, { error: { message: 'Bearer ' + SLEUTEL + ' ongeldig', code: 'x' } });
      R.polls = 0;
      if (R.modus === 'sync-data') return stuur(200, { created: 1, data: [{ b64_json: PNG.toString('base64') }] });
      if (R.modus === 'redirect') { res.writeHead(302, { Location: R.vreemd + '/v1/steel' }); return res.end(); }
      return stuur(202, { id: 'job-1', status: R.modus === 'processing' ? 'processing' : 'queued' }, { Location: R.modus === 'abs-loc' ? 'http://router.intern:8080/v1/images/generations/job-1' : '/v1/images/generations/job-1' });
    }
    if (req.method === 'GET' && req.url === '/v1/images/generations/job-1') {
      R.gets.push(req.url);
      R.polls++;
      if (R.polls < R.pollsTotKlaar) return stuur(200, { id: 'job-1', status: R.modus === 'processing' ? 'processing' : 'in_progress', progress: 0.5 });
      return stuur(200, mislukt('job-1') || { id: 'job-1', status: 'completed', outputs: [{ content_url: R.contentUrl }] });
    }
    if (req.method === 'POST' && req.url === '/v1/music/generations') {
      R.posts.push({ url: req.url, kop: req.headers, body: JSON.parse(body || '{}') });
      R.polls = 0;
      return stuur(202, { id: 'mjob-1', object: 'media.generation', media_type: 'music', status: 'queued' }, { Location: '/v1/music/generations/mjob-1' });
    }
    if (req.method === 'GET' && req.url === '/v1/music/generations/mjob-1') {
      R.gets.push(req.url); R.polls++;
      if (R.polls < R.pollsTotKlaar) return stuur(200, { id: 'mjob-1', status: 'in_progress', progress: 40 });
      return stuur(200, mislukt('mjob-1') || { id: 'mjob-1', status: 'completed', outputs: [{ content_url: '/v1/music/generations/mjob-1/content/0' }] });
    }
    if (req.method === 'GET' && req.url === '/v1/music/generations/mjob-1/content/0') { R.gets.push(req.url); res.writeHead(200, { 'Content-Type': R.muziekType }); return res.end(FLAC); }
    if (req.method === 'GET' && req.url.indexOf('/v1/images/generations/job-1/content/') === 0) {
      R.gets.push(req.url);
      if (R.modus === 'groot') { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(21 * 1024 * 1024) }); return res.end(); }
      if (R.modus === 'groot-stroom') { res.writeHead(200, { 'Content-Type': 'image/png' }); const blok = Buffer.alloc(1024 * 1024); let n = 0; const schrijf = () => { while (n < 22) { n++; if (!res.write(blok)) return res.once('drain', schrijf); } res.end(); }; return schrijf(); }
      res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG);
    }
    if (req.method === 'GET' && req.url === '/v1/beeld.png') { R.gets.push(req.url); res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    stuur(404, { error: { message: 'niet gevonden' } });
  });
});
// ── nagebootste FlowStudio (alleen GET /api/projects/<id>) + nep-/proc/meminfo ──
const F = { est: 49152, status: 'standby', lopend: 0, uit: false, html: false, hangt: false, hits: [], auth: [] };
const flowstudio = http.createServer((req, res) => {
  F.hits.push(req.method + ' ' + req.url); F.auth.push(req.headers.authorization || '');
  const m = /^\/api\/projects\/([a-f0-9-]{36})$/.exec(req.url);
  if (F.hangt) return;   // antwoordt nooit
  if (F.uit) { res.writeHead(500); return res.end('stuk'); }
  if (F.html || !m || req.method !== 'GET') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!DOCTYPE html><html></html>'); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: m[1], name: 'x', status: F.status, runningJobCount: F.lopend, queuedJobCount: 0, estHostMemMib: F.est, availableHostMemMib: 85889, estVramMib: 21504, resourceOk: true }));
});
const MEM = path.join(W, 'meminfo');
const zetVrij = (gib) => fs.writeFileSync(MEM, 'MemTotal:       98234196 kB\nMemFree:         1832444 kB\nMemAvailable:   ' + Math.round(gib * 1048576) + ' kB\n');
zetVrij(60);

// vreemd adres: mag nooit de sleutel zien
const vreemd = { hits: 0, auth: [] };
const vreemdSrv = http.createServer((req, res) => { vreemd.hits++; vreemd.auth.push(req.headers.authorization || ''); res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); });

// ── nagebootste ComfyUI ──
const OI = {
  PrimitiveStringMultiline: { python_module: 'comfy_extras.nodes_primitive', input: { required: { value: ['STRING', { multiline: true }] } } },
  EmptyLatentImage: { python_module: 'nodes', input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] } } },
  KSamplerNep: { python_module: 'nodes', input: { required: { latent: ['LATENT', {}], seed: ['INT', {}], sampler_name: [['euler', 'er_sde'], {}] } } },
  VAEDecode: { python_module: 'nodes', input: { required: { samples: ['LATENT', {}] } } },
  SaveImage: { python_module: 'nodes', input: { required: { images: ['IMAGE', {}], filename_prefix: ['STRING', {}] } } },
  PreviewImage: { python_module: 'nodes', input: { required: { images: ['IMAGE', {}] } } },
  LoadImageFromUrl: { python_module: 'custom_nodes.was-node-suite', input: { required: { url: ['STRING', {}] } } },
  FluxProUltraImageNode: { python_module: 'comfy_api_nodes.nodes_bfl', input: { required: { prompt: ['STRING', {}] } } },
  ImpactWildcardProcessor: { python_module: 'custom_nodes.ComfyUI-Impact-Pack', input: { required: { text: ['STRING', {}] } } },
  SaveVideo: { python_module: 'comfy_extras.nodes_video', output_node: true, input: { required: { video: ['VIDEO', {}] } } },
  VAEOpslaan: { python_module: 'comfy_extras.nodes_model_merging', output_node: true, input: { required: { vae: ['VAE', {}] } } },
};
const C = { rij: { queue_running: [], queue_pending: [] }, prompts: [], interrupts: [], deletes: [], frees: 0, hist: {}, histNa: 2, histN: 0, vram: 20000, uit: false, gets: [] };
const comfy = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    const stuur = (st, j) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    C.gets.push(req.method + ' ' + req.url.split('?')[0]);
    if (C.uit) return stuur(503, { error: 'ComfyUI Unavailable' });
    if (req.url === '/object_info') return stuur(200, OI);
    if (req.url === '/queue' && req.method === 'GET') return stuur(200, C.rij);
    if (req.url === '/system_stats') return stuur(200, { system: { ram_free: 60 * 1048576 * 1024 }, devices: [{ vram_total: 24000 * 1048576, vram_free: C.vram * 1048576 }] });
    if (req.url === '/prompt' && req.method === 'POST') {
      const j = JSON.parse(body); C.prompts.push(j);
      const pid = 'pid-' + C.prompts.length; C.histN = 0; C.laatstePid = pid;
      C.rij = { queue_running: [[1, pid, j.prompt, {}, []]], queue_pending: [] };
      return stuur(200, { prompt_id: pid, number: 1 });
    }
    let m = /^\/history\/(.+)$/.exec(req.url);
    if (m) {
      const pid = decodeURIComponent(m[1]);
      if (C.hangt) return stuur(200, {});
      if (++C.histN < C.histNa) return stuur(200, {});
      C.rij = { queue_running: [], queue_pending: [] };
      return stuur(200, { [pid]: { status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: 'ComfyUI_temp_00001_.png', subfolder: '', type: 'temp' }] } } } });
    }
    if (req.url.indexOf('/view?') === 0) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    if (req.url === '/interrupt') { C.interrupts.push(JSON.parse(body || '{}')); C.rij = { queue_running: [], queue_pending: [] }; return stuur(200, {}); }
    if (req.url === '/queue' && req.method === 'POST') { C.deletes.push(JSON.parse(body || '{}')); return stuur(200, {}); }
    if (req.url === '/free') { C.frees++; return stuur(200, {}); }
    stuur(404, {});
  });
});

// nep-Piper: schrijft een WAV-kop + stilte naar --output_file (of de echte met PIPER_ECHT=1)
const NEP_PIPER = path.join(W, 'piper');
fs.writeFileSync(NEP_PIPER, '#!/bin/sh\nuit=""\nwhile [ $# -gt 0 ]; do [ "$1" = "--output_file" ] && uit="$2"; shift; done\ncat > "$uit.txt"\nhead -c 4000 /dev/zero > "$uit"\n', { mode: 0o755 });
const PIPER = process.env.PIPER_ECHT === '1' ? { bin: '/opt/data/piper/piper', model: '/opt/data/piper/nl_NL-ronnie-medium.onnx', data: '/opt/data/piper/espeak-ng-data' }
  : { bin: NEP_PIPER, model: '-', data: '-' };

(async function () {
  await new Promise((r) => router.listen(0, '127.0.0.1', r));
  await new Promise((r) => comfy.listen(0, '127.0.0.1', r));
  await new Promise((r) => vreemdSrv.listen(0, '127.0.0.1', r));
  await new Promise((r) => flowstudio.listen(0, '127.0.0.1', r));
  const FURL = 'http://127.0.0.1:' + flowstudio.address().port;
  const RURL = 'http://127.0.0.1:' + router.address().port, CURL = 'http://127.0.0.1:' + comfy.address().port, VURL = 'http://127.0.0.1:' + vreemdSrv.address().port;
  const DIR = path.join(W, 'studio'), BEWAAR = path.join(W, 'app-bestanden');
  fs.mkdirSync(path.join(DIR, 'flows'), { recursive: true });
  // lokale flows: piper (proef), comfy goed (proef), comfy met geweigerde knoop, comfy met betaalde knoop, comfy met custom node
  const zetFlow = (naam, y, api) => { fs.mkdirSync(path.join(DIR, 'flows', naam), { recursive: true }); fs.writeFileSync(path.join(DIR, 'flows', naam, 'flow.yaml'), JSON.stringify(y)); if (api) fs.writeFileSync(path.join(DIR, 'flows', naam, 'flow.json'), JSON.stringify(api)); };
  zetFlow('proefbandje', { titel: 'Bandje, proefstem', motor: 'piper', status: 'proef', uitvoer: 'geluid', max_seconden: 60, velden: [{ naam: 'tekst', label: 'Tekst', soort: 'tekstvak', verplicht: true }] });
  const apiGoed = { 1: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'x' } }, 2: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    3: { class_type: 'KSamplerNep', inputs: { latent: ['2', 0], seed: 0, sampler_name: 'euler' } }, 4: { class_type: 'VAEDecode', inputs: { samples: ['3', 0] } },
    9: { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: 'moss' } } };
  const veldenComfy = [{ naam: 'prompt', label: 'Wat wil je zien?', soort: 'tekstvak', verplicht: true, pad: '1.inputs.value' }, { naam: 'aantal', soort: 'aantal', pad: '2.inputs.batch_size' },
    { naam: 'seed', soort: 'seed', meer: true, pad: '3.inputs.seed' }];
  zetFlow('moss-comfyui', { titel: 'Beeld: MOSS (ComfyUI)', motor: 'comfyui', status: 'actief', uitvoer: 'beeld', max_seconden: 30, gpu_mib_schatting: 12000, velden: veldenComfy }, apiGoed);
  zetFlow('url-flow', { titel: 'Met URL-knoop', motor: 'comfyui', status: 'actief', uitvoer: 'beeld', max_seconden: 30, velden: veldenComfy }, Object.assign({}, apiGoed, { 7: { class_type: 'LoadImageFromUrl', inputs: { url: 'http://x' } } }));
  zetFlow('betaald-flow', { titel: 'Met partnerknoop', motor: 'comfyui', status: 'actief', uitvoer: 'beeld', max_seconden: 30, velden: veldenComfy }, Object.assign({}, apiGoed, { 7: { class_type: 'FluxProUltraImageNode', inputs: { prompt: 'x' } } }));
  zetFlow('custom-flow', { titel: 'Met custom node', motor: 'comfyui', status: 'actief', uitvoer: 'beeld', max_seconden: 30, velden: veldenComfy }, Object.assign({}, apiGoed, { 7: { class_type: 'ImpactWildcardProcessor', inputs: { text: 'x' } } }));
  zetFlow('uitvoer-flow', { titel: 'Met uitvoerknoop', motor: 'comfyui', status: 'actief', uitvoer: 'beeld', max_seconden: 30, velden: veldenComfy }, Object.assign({}, apiGoed, { 7: { class_type: 'VAEOpslaan', inputs: { vae: ['4', 0] } } }));
  zetFlow('video-flow', { titel: 'Met SaveVideo', motor: 'comfyui', status: 'actief', uitvoer: 'beeld', max_seconden: 30, velden: veldenComfy }, Object.assign({}, apiGoed, { 7: { class_type: 'SaveVideo', inputs: { video: ['4', 0] } } }));

  // stub van appBewaar: dezelfde vorm (jobmap 16 hex, b/<n>, meta.json), rename uit out/
  const bewaard = {};
  const bewaar = (jobId, outdir, meta) => {
    if (!/^[a-f0-9]{16}$/.test(jobId)) return null;
    const dir = path.join(BEWAAR, '2026-10-21', jobId); fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
    const lijst = [];
    for (const n of fs.readdirSync(outdir).sort()) { if (n.endsWith('.txt')) continue; const doel = path.join(dir, 'b', String(lijst.length + 1)); const g = fs.statSync(path.join(outdir, n)).size; fs.renameSync(path.join(outdir, n), doel); lijst.push({ n: lijst.length + 1, naam: n, grootte: g }); }
    const m = { job_id: jobId, soort: meta.soort, label: meta.label, op: new Date().toISOString(), bestanden: lijst, studio: meta.studio };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(m)); bewaard[jobId] = m; return m;
  };
  let sleutel = null, primair = true;
  const logs = [], fouts = [];
  const maakStudio = () => studioMod.maak({ dir: DIR, bewaar, primair: () => primair, sleutel: async () => sleutel, routerUrl: RURL, comfyUrl: CURL, flowstudioUrl: FURL, meminfo: MEM, piper: PIPER,
    log: (r) => logs.push(r), fout: (w, e) => fouts.push(w + ': ' + (e && e.message)), tempo: { poll: 30, wachtStap: 40, wachtMax: 1500 } });
  let S = maakStudio();
  let vers = false, verbruikt = 0;
  const ctx = { versOk: () => vers, versVerbruik: () => { vers = false; verbruikt++; }, apparaat: 'toets' };
  let bid = 0; const nb = () => 'beurt-' + (++bid) + '-xxxxxxxx';
  const wachtKlaar = async (id, ms) => { await totDat(() => { const t = S.taak(id); return t && ['klaar', 'mislukt', 'gestopt', 'onderbroken'].includes(t.status); }, ms || 8000); return S.taak(id); };

  // 1. catalogus zonder sleutel
  let c = await S.flows();
  const fs1 = c.flows.find((f) => f.id === 'fs-' + MOSS), mz = c.flows.find((f) => f.id === 'fs-' + MUZIEK);
  toets('1 catalogus: OpenMOSS uit Router als flow fs-<project-id>, motor router', !!fs1 && fs1.motor === 'router' && fs1.uitvoer === 'beeld', c.flows.map((f) => f.id));
  toets('1 betaalde aanbieders en chatmodellen staan niet in de catalogus', !c.flows.some((f) => /eleven|openai|qwen/i.test(f.id + f.titel)), c.flows.map((f) => f.id));
  toets('1 formulier uit flowstudio.parameters (prompt, negatief, keuze, aantal) + seed onder Meer', fs1 && fs1.velden.map((v) => v.naam + ':' + v.soort).join(',') === 'prompt__18:17:tekstvak,text:tekstvak,megapixels:keuze,batch_count:aantal,seed:seed'
    && fs1.velden.find((v) => v.naam === 'megapixels').opties.length === 2 && fs1.velden.find((v) => v.soort === 'seed').meer === true, fs1 && fs1.velden);
  toets('1 zonder sleutel: OpenMOSS "wacht op sleutel", niet klaar', fs1 && fs1.klaar === false && fs1.reden === 'wacht op sleutel' && c.sleutel === false, fs1);
  toets('1 muziek: zonder sleutel "wacht op sleutel" (route gebouwd in wv736)', mz && mz.klaar === false && mz.reden === 'wacht op sleutel' && mz.uitvoer === 'muziek', mz);
  toets('1 lokale flows erbij; pad-velden niet naar de app', c.flows.some((f) => f.id === 'proefbandje' && f.vers_per_keer === true) && !JSON.stringify(c.flows).includes('"pad"'), c.flows.map((f) => f.id));
  let r = await S.maak({ flow: 'fs-' + MOSS, beurt_id: nb(), velden: { 'prompt__18:17': 'een wachtkamer' } }, ctx);
  toets('1 maken zonder sleutel: geweigerd, niets naar Router gestuurd', r.status === 409 && R.posts.length === 0, r);

  // 2. Router-taak met sleutel
  sleutel = SLEUTEL;
  c = await S.flows();
  toets('2 met sleutel: OpenMOSS klaar', c.flows.find((f) => f.id === 'fs-' + MOSS).klaar === true && c.sleutel === true);
  r = await S.maak({ flow: 'fs-' + MOSS, beurt_id: nb(), velden: { 'prompt__18:17': 'een rustige wachtkamer, warm licht', megapixels: '0.23', batch_count: 2, seed: 42 } }, ctx);
  toets('2 maak: taak in de rij (id 16 hex)', r.status === 200 && /^[a-f0-9]{16}$/.test(r.taak.id), r);
  let t = await wachtKlaar(r.taak.id);
  const post = R.posts[0] || {};
  toets('2 Router: Prefer respond-async + eigen sleutel als Bearer', post.kop && post.kop.prefer === 'respond-async' && post.kop.authorization === 'Bearer ' + SLEUTEL, post.kop);
  toets('2 Router: model, prompt, n, seed en alle params onder flowstudio.params', post.body && post.body.model === 'Olares/' + MOSS && post.body.prompt === 'een rustige wachtkamer, warm licht' && post.body.n === 2 && post.body.seed === 42
    && post.body.flowstudio.params['prompt__18:17'] === 'een rustige wachtkamer, warm licht' && post.body.flowstudio.params.megapixels === '0.23' && !('batch_count' in post.body.flowstudio.params), post.body);
  toets('2 Router: gepold op de Location, resultaat via content_url opgehaald', R.gets.filter((g) => g === '/v1/images/generations/job-1').length >= 2 && R.gets.some((g) => g.indexOf('/content/') > 0), R.gets);
  toets('2 taak klaar, één beeld bewaard via de bewaarfunctie (soort studio, flow/motor in meta)', t && t.status === 'klaar' && t.bestanden.length === 1 && /\.png$/.test(t.bestanden[0].naam)
    && bewaard[t.id] && bewaard[t.id].soort === 'studio' && bewaard[t.id].studio.motor === 'router', t);
  toets('2 werkmap opgeruimd (geen bestand buiten de bewaarplek)', !fs.existsSync(path.join(DIR, 'werk', t.id)), fs.existsSync(path.join(DIR, 'werk')) && fs.readdirSync(path.join(DIR, 'werk')));
  // content_url als absolute URL op een andere host: alleen het pad, opgehaald bij Router zelf; de sleutel gaat nooit daarheen
  R.contentUrl = VURL + '/v1/beeld.png';
  r = await S.maak({ flow: 'fs-' + MOSS, beurt_id: nb(), velden: { 'prompt__18:17': 'x' } }, ctx);
  t = await wachtKlaar(r.taak.id);
  toets('2 content_url op een andere host: pad bij Router opgehaald, nooit naar die host', t.status === 'klaar' && R.gets.includes('/v1/beeld.png') && vreemd.hits === 0, { t, vreemd });
  R.contentUrl = 'http://x/../etc/passwd';
  r = await S.maak({ flow: 'fs-' + MOSS, beurt_id: nb(), velden: { 'prompt__18:17': 'x' } }, ctx);
  t = await wachtKlaar(r.taak.id);
  toets('2 content_url met .. of zonder /v1/: geweigerd', t.status === 'mislukt' && /resultaatadres/.test(t.reden), t.reden);
  R.contentUrl = '/v1/images/generations/job-1/content/0';
  // afwijkende antwoorden van Router (Fable wv707 #3)
  for (const [modus, naam] of [['sync-data', '200 zonder status met data[].b64_json = klaar'], ['processing', 'onbekende tussenstatus "processing": blijven pollen'], ['abs-loc', 'absolute Location: pad bij Router gepold']]) {
    R.modus = modus; const g0 = R.gets.length;
    r = await S.maak({ flow: 'fs-' + MOSS, beurt_id: nb(), velden: { 'prompt__18:17': 'x' } }, ctx);
    t = await wachtKlaar(r.taak.id);
    toets('2 ' + naam, t.status === 'klaar' && t.bestanden.length === 1 && (modus === 'sync-data' || R.gets.slice(g0).includes('/v1/images/generations/job-1')), { t, gets: R.gets.slice(g0) });
  }
  R.modus = 'redirect'; R.vreemd = VURL;
  r = await S.maak({ flow: 'fs-' + MOSS, beurt_id: nb(), velden: { 'prompt__18:17': 'x' } }, ctx);
  t = await wachtKlaar(r.taak.id);
  toets('2 redirect van Router wordt niet gevolgd (sleutel niet naar elders)', t.status === 'mislukt' && vreemd.hits === 0, { t, vreemd });
  for (const modus of ['groot', 'groot-stroom']) {
    R.modus = modus;
    r = await S.maak({ flow: 'fs-' + MOSS, beurt_id: nb(), velden: { 'prompt__18:17': 'x' } }, ctx);
    t = await wachtKlaar(r.taak.id, 15000);
    toets('2 resultaat > 20 MB (' + (modus === 'groot' ? 'content-length' : 'zonder lengte') + '): geweigerd', t.status === 'mislukt' && /20 MB/.test(t.reden), t);
  }
  R.modus = null;
  // fout van Router: geen sleutel in de reden
  R.weiger = 401;
  r = await S.maak({ flow: 'fs-' + MOSS, beurt_id: nb(), velden: { 'prompt__18:17': 'x' } }, ctx);
  t = await wachtKlaar(r.taak.id);
  toets('2 Router weigert: mislukt, sleutel niet in de reden', t.status === 'mislukt' && t.reden.indexOf(SLEUTEL) < 0 && /401/.test(t.reden), t.reden);
  R.weiger = 0;
  R.status = 'failed';
  r = await S.maak({ flow: 'fs-' + MOSS, beurt_id: nb(), velden: { 'prompt__18:17': 'x' } }, ctx);
  t = await wachtKlaar(r.taak.id);
  toets('2 Router meldt engine_host_mem_unavailable terwijl de pod genoeg ziet: gewone taal, beide getallen', t.status === 'mislukt'
    && t.reden === 'Olares heeft nu te weinig vrij geheugen voor FlowStudio (± 48 GB nodig; FlowStudio meldt een tekort, de pod ziet 60 GB vrij); MOSS-Image rechtstreeks werkt wel', t.reden);
  R.status = 'failed-code';
  r = await S.maak({ flow: 'fs-' + MOSS, beurt_id: nb(), velden: { 'prompt__18:17': 'x' } }, ctx);
  t = await wachtKlaar(r.taak.id);
  toets('2 Router meldt alleen error_code upstream_capacity_unavailable: zelfde tekst', t.status === 'mislukt' && /^Olares heeft nu te weinig vrij geheugen voor FlowStudio/.test(t.reden), t.reden);
  R.status = 'failed-ander';
  r = await S.maak({ flow: 'fs-' + MOSS, beurt_id: nb(), velden: { 'prompt__18:17': 'x' } }, ctx);
  t = await wachtKlaar(r.taak.id);
  toets('2 FlowStudio meldt een andere fout: "FlowStudio meldt: …" doorgegeven', t.status === 'mislukt' && t.reden === 'FlowStudio meldt: workflow_invalid', t.reden);
  R.status = 'completed';

  // 3. Piper + proef
  vers = false;
  const nPosts = R.posts.length;
  r = await S.maak({ flow: 'proefbandje', beurt_id: nb(), velden: { tekst: 'Goedemiddag, dit is een proef.' } }, ctx);
  toets('3 proefflow zonder verse vingerafdruk: 403 vers_nodig, niets in de rij', r.status === 403 && r.vers_nodig === true && S.teller().in_rij === 0, r);
  vers = true;
  r = await S.maak({ flow: 'proefbandje', beurt_id: nb(), velden: { tekst: 'Goedemiddag, dit is een proef.\nTweede regel.' } }, ctx);
  toets('3 proefflow met verse vingerafdruk: in de rij, vingerafdruk verbruikt', r.status === 200 && vers === false && verbruikt === 1, r);
  t = await wachtKlaar(r.taak.id, 30000);
  toets('3 Piper: klaar, één WAV bewaard', t.status === 'klaar' && t.bestanden.length === 1 && t.bestanden[0].naam === 'bandje.wav' && t.bestanden[0].grootte > 100, t);
  r = await S.maak({ flow: 'proefbandje', beurt_id: nb(), velden: { tekst: 'nog een keer' } }, ctx);
  toets('3 proef = per keer: tweede keer weer 403', r.status === 403 && r.vers_nodig === true, r);
  toets('3 Piper raakt Router niet', R.posts.length === nPosts);
  vers = false;
  r = S.activeer('proefbandje', ctx);
  toets('3 Activeer zonder vingerafdruk: 403', r.status === 403 && r.vers_nodig === true, r);
  vers = true;
  r = S.activeer('proefbandje', ctx);
  const y = JSON.parse(fs.readFileSync(path.join(DIR, 'flows', 'proefbandje', 'flow.yaml'), 'utf8'));
  toets('3 Activeer met vingerafdruk: status actief in flow.yaml, vingerafdruk verbruikt', r.status === 200 && r.flow.status === 'actief' && y.status === 'actief' && vers === false, { r, y });
  r = await S.maak({ flow: 'proefbandje', beurt_id: nb(), velden: { tekst: 'na activeren' } }, ctx);
  toets('3 actieve flow: geen vingerafdruk meer nodig', r.status === 200, r);
  await wachtKlaar(r.taak.id, 30000);
  r = S.activeer('fs-' + MOSS, ctx);
  toets('3 Activeer op een Router-flow: geweigerd (alleen lokale proefflows)', r.status === 404, r);
  r = await S.maak({ flow: 'proefbandje', beurt_id: nb(), velden: { tekst: 'x'.repeat(2001) } }, ctx);
  toets('3 tekst > 2000 tekens: geweigerd', r.status === 400 && /2000/.test(r.fout), r);
  r = await S.maak({ flow: 'proefbandje', beurt_id: nb(), velden: { tekst: '   ' } }, ctx);
  toets('3 lege verplichte tekst: geweigerd', r.status === 400, r);

  // 4. knopentoets en gedeelde ComfyUI
  for (const [flow, patroon, naam] of [['url-flow', /weigerlijst/, 'URL-knoop'], ['betaald-flow', /betaalde partnerknoop/, 'betaalde partnerknoop'], ['custom-flow', /witte lijst/, 'custom node buiten de witte lijst'], ['video-flow', /uitvoermap|bestanden, adressen/, 'SaveVideo'], ['uitvoer-flow', /uitvoermap/, 'elke uitvoerknoop buiten Preview (output_node)']]) {
    const np = C.prompts.length;
    r = await S.maak({ flow, beurt_id: nb(), velden: { prompt: 'x' } }, ctx);
    t = await wachtKlaar(r.taak.id);
    toets('4 knopentoets weigert ' + naam + ', niets ingediend', t.status === 'mislukt' && /knopentoets/.test(t.reden) && patroon.test(t.reden) && C.prompts.length === np, t.reden);
  }
  // niet-lege wachtrij (Davids eigen run): wachten, niets indienen, niets onderbreken
  C.rij = { queue_running: [[7, 'davids-run', {}, {}, []]], queue_pending: [] };
  r = await S.maak({ flow: 'moss-comfyui', beurt_id: nb(), velden: { prompt: 'een rustige wachtkamer', aantal: 2, seed: 7 } }, ctx);
  await slaap(300);
  t = S.taak(r.taak.id);
  toets('4 ComfyUI bezig met iets anders: taak wacht, niets ingediend of onderbroken', t.status === 'bezig' && /ComfyUI is bezig/.test(t.fase) && C.prompts.length === 0 && C.interrupts.length === 0 && C.deletes.length === 0, { t, C: { p: C.prompts.length, i: C.interrupts } });
  // ook te weinig VRAM: blijven wachten
  C.rij = { queue_running: [], queue_pending: [] }; C.vram = 8000;
  await slaap(200);
  t = S.taak(r.taak.id);
  toets('4 te weinig vrij VRAM: blijft wachten', t.status === 'bezig' && /videogeheugen/.test(t.fase) && C.prompts.length === 0, t.fase);
  C.vram = 20000;
  t = await wachtKlaar(r.taak.id);
  const ingediend = C.prompts[0] || {};
  toets('4 na lege rij: ingediend en klaar', t.status === 'klaar' && t.bestanden.length === 1, t);
  toets('4 SaveImage -> PreviewImage, zonder filename_prefix', ingediend.prompt && ingediend.prompt[9].class_type === 'PreviewImage' && !('filename_prefix' in ingediend.prompt[9].inputs), ingediend.prompt && ingediend.prompt[9]);
  toets('4 velden op de paden van flow.yaml ingevuld (prompt, aantal, seed)', ingediend.prompt && ingediend.prompt[1].inputs.value === 'een rustige wachtkamer' && ingediend.prompt[2].inputs.batch_size === 2 && ingediend.prompt[3].inputs.seed === 7, ingediend.prompt);
  toets('4 eigen client_id', /^socev-studio-[a-f0-9]{16}$/.test(ingediend.client_id), ingediend.client_id);
  toets('4 VRAM voor en na per taak vastgelegd', t.meting && t.meting.vram_vrij_voor_mib === 20000 && t.meting.vram_vrij_na_mib === 20000 && /^pid-/.test(t.meting.prompt_id), t.meting);
  toets('4 uitvoer via /view (temp)', C.gets.some((g) => g === 'GET /view'), C.gets.slice(-6));
  // te lang wachten op een bezette ComfyUI: mislukt zonder in te dienen
  C.rij = { queue_running: [], queue_pending: [[3, 'iemand-anders', {}, {}, []]] };
  const np2 = C.prompts.length;
  r = await S.maak({ flow: 'moss-comfyui', beurt_id: nb(), velden: { prompt: 'x' } }, ctx);
  t = await wachtKlaar(r.taak.id);
  toets('4 rij blijft bezet: na de wachttijd mislukt, niets ingediend of verwijderd', t.status === 'mislukt' && /niets ingediend/.test(t.reden) && C.prompts.length === np2 && C.deletes.length === 0, t);
  // stoppen tijdens eigen run: alleen eigen prompt_id onderbreken
  C.rij = { queue_running: [], queue_pending: [] }; C.hangt = true;
  r = await S.maak({ flow: 'moss-comfyui', beurt_id: nb(), velden: { prompt: 'x' } }, ctx);
  await totDat(() => C.prompts.length > np2);
  await slaap(100);
  let s2 = S.stop(r.taak.id);
  t = await wachtKlaar(r.taak.id);
  toets('4 Stop tijdens eigen run: /interrupt met het eigen prompt_id', s2.status === 200 && t.status === 'gestopt' && C.interrupts.length === 1 && C.interrupts[0].prompt_id === C.laatstePid, { t, i: C.interrupts });
  // stoppen terwijl ComfyUI intussen iets anders draait: niet onderbreken
  C.rij = { queue_running: [], queue_pending: [] };
  r = await S.maak({ flow: 'moss-comfyui', beurt_id: nb(), velden: { prompt: 'x' } }, ctx);
  await totDat(() => C.prompts.length > np2 + 1);
  C.rij = { queue_running: [[9, 'davids-run', {}, {}, []]], queue_pending: [] };
  await slaap(100);
  S.stop(r.taak.id);
  t = await wachtKlaar(r.taak.id);
  toets('4 Stop terwijl ComfyUI iets anders draait: geen /interrupt', t.status === 'gestopt' && C.interrupts.length === 1, C.interrupts);
  C.hangt = false; C.rij = { queue_running: [], queue_pending: [] };
  // ComfyUI uit: duidelijke melding, niet zelf starten
  C.uit = true;
  r = await S.maak({ flow: 'moss-comfyui', beurt_id: nb(), velden: { prompt: 'x' } }, ctx);
  t = await wachtKlaar(r.taak.id);
  toets('4 ComfyUI uit (503): "zet hem aan in de ComfyUI Launcher"', t.status === 'mislukt' && /Launcher/.test(t.reden), t.reden);
  C.uit = false;
  toets('4 toetsFlow los (voor de machinekamer): goede flow null, URL-knoop een reden', (await S.toetsFlow(apiGoed)) === null && /weigerlijst/.test(await S.toetsFlow(Object.assign({}, apiGoed, { 7: { class_type: 'LoadImageFromUrl', inputs: { url: 'x' } } }))));

  // 5. grenzen
  r = await S.maak({ flow: 'proefbandje', beurt_id: 'dubbel-beurt-1', velden: { tekst: 'a' } }, ctx);
  const r2 = await S.maak({ flow: 'proefbandje', beurt_id: 'dubbel-beurt-1', velden: { tekst: 'a' } }, ctx);
  toets('5 zelfde beurt_id twee keer: één taak', r2.status === 200 && r2.al === true && r2.taak.id === r.taak.id, r2);
  await wachtKlaar(r.taak.id, 30000);
  // verse dag voor de rijtoets (de toetsen hierboven telden al mee voor de daggrens van 30)
  S.stopTimers(); fs.rmSync(path.join(DIR, 'taken.json'), { force: true }); S = maakStudio();
  C.hangt = true;
  const lang = await S.maak({ flow: 'moss-comfyui', beurt_id: nb(), velden: { prompt: 'x' } }, ctx);
  await totDat(() => S.taak(lang.taak.id).status === 'bezig');
  const rij = [];
  for (let i = 0; i < 6; i++) rij.push(await S.maak({ flow: 'proefbandje', beurt_id: nb(), velden: { tekst: 'r' + i } }, ctx));
  toets('5 rij: hooguit 5 wachtend, de 6e geweigerd (429)', rij.slice(0, 5).every((x) => x.status === 200) && rij[5].status === 429 && S.teller().in_rij === 5, { st: rij.map((x) => x.status + ' ' + (x.fout || '')), teller: S.teller(), lang: S.taak(lang.taak.id) });
  r = S.stop(rij[0].taak.id);
  toets('5 Stop op een wachtende taak: uit de rij', r.status === 200 && r.taak.status === 'gestopt' && S.teller().in_rij === 4, r);
  primair = false;
  r = await S.maak({ flow: 'proefbandje', beurt_id: nb(), velden: { tekst: 'x' } }, ctx);
  toets('5 passieve kant: maken geweigerd', r.status === 409 && /passief/.test(r.fout), r);
  primair = true;
  // herstart terwijl er iets bezig is en in de rij staat: de stand op schijf vóór het stoppen bewaren, dan de oude instantie stilleggen
  const takenVoor = fs.readFileSync(path.join(DIR, 'taken.json'), 'utf8');
  const bezigVoor = JSON.parse(takenVoor).taken.filter((x) => x.status === 'bezig' || x.status === 'wacht').length;
  S.stop(lang.taak.id); rij.slice(1, 5).forEach((x) => S.stop(x.taak.id)); C.hangt = false;
  await wachtKlaar(lang.taak.id);
  S.stopTimers();
  fs.writeFileSync(path.join(DIR, 'taken.json'), takenVoor);
  fs.mkdirSync(path.join(DIR, 'werk', 'a'.repeat(16), 'out'), { recursive: true });
  const S2 = maakStudio();
  const ond = S2.taken().taken.filter((x) => x.status === 'onderbroken');
  toets('5 herstart: bezig en wachtend -> onderbroken, niets opnieuw gestart, werkmap leeg', bezigVoor === 5 && ond.length === 5 && S2.teller().in_rij === 0 && !S2.teller().bezig && !fs.existsSync(path.join(DIR, 'werk')), { bezigVoor, ond: ond.length });
  S = S2;
  // dagteller: 30 per dag
  const takenF = path.join(DIR, 'taken.json');
  const tj = JSON.parse(fs.readFileSync(takenF, 'utf8'));
  while (tj.taken.length < 30) tj.taken.push({ id: 'f'.repeat(16), beurt_id: 'vul-' + tj.taken.length, flow: 'x', status: 'klaar', gemaakt: new Date().toISOString(), velden: {} });
  fs.writeFileSync(takenF, JSON.stringify(tj));
  S.stopTimers(); S = maakStudio();
  r = await S.maak({ flow: 'proefbandje', beurt_id: nb(), velden: { tekst: 'x' } }, ctx);
  toets('5 dertigste taak van vandaag gehaald: 429', r.status === 429 && /30/.test(r.fout), r);

  // 5b. een gooiende bewaarfunctie laat Studio niet hangen (Fable wv707 #5); lopend() zonder velden
  {
    const D2 = path.join(W, 'studio2'); fs.mkdirSync(path.join(D2, 'flows', 'pb'), { recursive: true });
    fs.writeFileSync(path.join(D2, 'flows', 'pb', 'flow.yaml'), JSON.stringify({ titel: 'pb', motor: 'piper', status: 'actief', velden: [{ naam: 'tekst', soort: 'tekstvak', verplicht: true }] }));
    let gooi = true; const f2 = [];
    const S3 = studioMod.maak({ dir: D2, bewaar: (j, o, m) => { if (gooi) { gooi = false; throw new Error('schijf vol'); } return bewaar(j, o, m); }, primair: () => true, sleutel: async () => null, routerUrl: RURL, comfyUrl: CURL, piper: PIPER,
      fout: (w, e) => f2.push(w), log: () => { throw new Error('log stuk'); }, tempo: { poll: 30, wachtStap: 40, wachtMax: 1500 } });
    const a1 = await S3.maak({ flow: 'pb', beurt_id: nb(), velden: { tekst: 'een' } }, ctx);
    const a2 = await S3.maak({ flow: 'pb', beurt_id: nb(), velden: { tekst: 'twee' } }, ctx);
    toets('5b lopend(): alleen wachtend/bezig, zonder velden', S3.lopend().taken.length === 2 && S3.lopend().taken.every((x) => !('velden' in x)), S3.lopend().taken);
    const S3wacht = async (id) => { await totDat(() => ['klaar', 'mislukt'].includes(S3.taak(id).status), 15000); return S3.taak(id); };
    const t1 = await S3wacht(a1.taak.id); const t2 = await S3wacht(a2.taak.id);
    toets('5b bewaarfunctie gooit en log gooit: taak mislukt, de volgende loopt gewoon', t1.status === 'mislukt' && t2.status === 'klaar' && !S3.teller().bezig, { t1: t1.status, t2: t2.status, f2 });
    S3.stopTimers();
  }

  // 7. geheugencontrole vóór een FlowStudio-taak en muziek (wv736). Eigen map: de daggrens van DIR is hierboven al vol.
  {
    const D7 = path.join(W, 'studio7'); fs.mkdirSync(path.join(D7, 'flows'), { recursive: true });
    fs.cpSync(path.join(DIR, 'flows', 'moss-comfyui'), path.join(D7, 'flows', 'moss-comfyui'), { recursive: true });
    const S7m = (mem) => studioMod.maak({ dir: D7, bewaar, primair: () => true, sleutel: async () => SLEUTEL, routerUrl: RURL, comfyUrl: CURL, flowstudioUrl: FURL,
      meminfo: mem || MEM, piper: PIPER, log: () => {}, fout: (w, e) => fouts.push(w + ': ' + (e && e.message)), tempo: { poll: 30, wachtStap: 40, wachtMax: 1500, fsTimeout: 300 } });
    let S7 = S7m();
    const nieuw = (mem) => { S7.stopTimers(); S7 = S7m(mem); };   // verse instantie = lege FlowStudio-cache
    const w7 = async (id, ms) => { await totDat(() => { const x = S7.taak(id); return x && ['klaar', 'mislukt', 'gestopt', 'onderbroken'].includes(x.status); }, ms || 8000); return S7.taak(id); };
    const fsF = (c, pid) => c.flows.find((f) => f.id === 'fs-' + pid);
    const maakMoss = () => S7.maak({ flow: 'fs-' + MOSS, beurt_id: nb(), velden: { 'prompt__18:17': 'een rustige wachtkamer' } }, ctx);
    const TEKST = 'Olares heeft nu te weinig vrij geheugen voor FlowStudio (± 48 GB nodig, nu 22 GB vrij); MOSS-Image rechtstreeks werkt wel';
    R.status = 'completed'; F.status = 'standby'; F.est = 49152;

    zetVrij(22); nieuw();
    const p0 = R.posts.length;
    let c7 = await S7.flows();
    toets('7 te weinig geheugen: OpenMOSS niet klaar, reden in gewone taal (48 nodig, 22 vrij)', fsF(c7, MOSS).klaar === false && fsF(c7, MOSS).reden === TEKST, fsF(c7, MOSS));
    toets('7 te weinig geheugen: muziek ook niet klaar, zonder de MOSS-zin', fsF(c7, MUZIEK).klaar === false && /^Olares heeft nu te weinig vrij geheugen/.test(fsF(c7, MUZIEK).reden) && !/MOSS/.test(fsF(c7, MUZIEK).reden), fsF(c7, MUZIEK));
    toets('7 de ComfyUI-terugval blijft klaar', c7.flows.find((f) => f.id === 'moss-comfyui').klaar === true);
    r = await maakMoss();
    toets('7 maken bij te weinig geheugen: meteen geweigerd met dezelfde tekst, geen Router-aanroep', r.status === 409 && r.fout.indexOf(TEKST) >= 0 && R.posts.length === p0, r);
    toets('7 FlowStudio alleen met GET op /api/projects/<id> gelezen, zonder Authorization-kop', F.hits.length > 0 && F.hits.every((h) => /^GET \/api\/projects\/[a-f0-9-]{36}$/.test(h)) && F.auth.every((x) => !x), { hits: F.hits.slice(-3), auth: F.auth.filter(Boolean).length });
    const h0 = F.hits.length; await S7.flows(); await S7.flows();
    toets('7 FlowStudio-project 1 min onthouden (geen nieuwe GET per catalogus)', F.hits.length === h0, F.hits.length - h0);

    // geheugen zakt terwijl de taak in de rij staat: bij het indienen vers nagekeken
    zetVrij(60); nieuw();
    C.hangt = true; C.rij = { queue_running: [], queue_pending: [] };
    const blok = await S7.maak({ flow: 'moss-comfyui', beurt_id: nb(), velden: { prompt: 'x' } }, ctx);
    await totDat(() => C.prompts.length && S7.taak(blok.taak.id).status === 'bezig' && /ComfyUI/.test(S7.taak(blok.taak.id).fase || ''));
    r = await maakMoss();
    toets('7 genoeg geheugen: Router-taak in de rij', r.status === 200, r);
    zetVrij(20);
    S7.stop(blok.taak.id); await w7(blok.taak.id); C.hangt = false; C.rij = { queue_running: [], queue_pending: [] };
    t = await w7(r.taak.id);
    toets('7 geheugen gezakt vóór het indienen: mislukt met de tekst, niets naar Router', t.status === 'mislukt' && /\(± 48 GB nodig, nu 20 GB vrij\)/.test(t.reden) && R.posts.length === p0
      && t.meting && t.meting.geheugen_vrij_mib === 20 * 1024 && t.meting.geheugen_nodig_mib === 49152, t);

    // onleesbaar of motor al bezig: oude gedrag (niet blokkeren)
    zetVrij(10);
    for (const [zet, terug, naam] of [[() => { F.uit = true; }, () => { F.uit = false; }, 'FlowStudio geeft HTTP 500'], [() => { F.html = true; }, () => { F.html = false; }, 'FlowStudio geeft HTML in plaats van JSON'],
      [() => { F.status = 'running'; }, () => { F.status = 'standby'; }, 'motor draait al (status niet standby)'], [() => { F.lopend = 1; }, () => { F.lopend = 0; }, 'er loopt al een FlowStudio-taak (runningJobCount)'],
      [() => { F.est = 0; }, () => { F.est = 49152; }, 'geen estHostMemMib'], [() => { F.hangt = true; }, () => { F.hangt = false; }, 'FlowStudio hangt (timeout)']]) {
      zet(); nieuw();
      c7 = await S7.flows();
      const pn = R.posts.length;
      r = await maakMoss(); t = r.status === 200 ? await w7(r.taak.id) : null;
      toets('7 ' + naam + ': niet blokkeren, taak gaat naar Router', fsF(c7, MOSS).klaar === true && t && t.status === 'klaar' && R.posts.length === pn + 1, { f: fsF(c7, MOSS).reden, r, t });
      terug();
    }
    nieuw(path.join(W, 'bestaat-niet'));
    c7 = await S7.flows();
    toets('7 meminfo onleesbaar: niet blokkeren', fsF(c7, MOSS).klaar === true, fsF(c7, MOSS).reden);
    // Router weigert synchroon (503) op geheugen: zelfde tekst
    zetVrij(60); nieuw(); R.weiger = 503;
    r = await maakMoss(); t = await w7(r.taak.id);
    toets('7 Router weigert synchroon (503 engine_host_mem_unavailable): gewone taal', t.status === 'mislukt' && /^Olares heeft nu te weinig vrij geheugen voor FlowStudio/.test(t.reden), t.reden);
    R.weiger = 0;
    r = await maakMoss(); t = await w7(r.taak.id);
    toets('7 meting bij elke Router-taak: FlowStudio-status, lopend en vrij geheugen vóór het indienen', t.status === 'klaar' && t.meting && t.meting.fs_status === 'standby' && t.meting.fs_lopend === 0
      && t.meting.geheugen_vrij_mib === 60 * 1024 && t.meting.geheugen_nodig_mib === 49152 && t.meting.router_id === 'job-1', t.meting);
    flowstudio.close();   // FlowStudio onbereikbaar (verbinding geweigerd)
    zetVrij(10); nieuw();
    c7 = await S7.flows();
    toets('7 FlowStudio onbereikbaar: niet blokkeren', fsF(c7, MOSS).klaar === true, fsF(c7, MOSS).reden);
    await new Promise((res) => flowstudio.listen(Number(FURL.split(':').pop()), '127.0.0.1', res));

    // muziek
    zetVrij(60); nieuw();
    c7 = await S7.flows();
    const mz7 = fsF(c7, MUZIEK), veld = (n) => mz7.velden.find((v) => v.naam === n);
    toets('7 muziek: klaar met sleutel en genoeg geheugen; songtekst in beeld, duur 5–300 s, seed onder Meer', mz7.klaar === true && veld('lyrics').meer !== true && veld('lyrics').soort === 'tekstvak'
      && veld('max_duration').min === 5 && veld('max_duration').max === 300 && veld('batch_count').max === 2 && veld('seed') && veld('seed').meer === true, mz7);
    r = await S7.maak({ flow: 'fs-' + MUZIEK, beurt_id: nb(), velden: { caption: 'rustige wachtmuziek, piano', max_duration: 30, batch_count: 1, seed: 5 } }, ctx);
    t = await w7(r.taak.id);
    const mp = R.posts[R.posts.length - 1] || {};
    toets('7 muziek: POST /v1/music/generations met Prefer respond-async en de eigen sleutel', mp.url === '/v1/music/generations' && mp.kop.prefer === 'respond-async' && mp.kop.authorization === 'Bearer ' + SLEUTEL, { url: mp.url });
    toets('7 muziek: prompt = beschrijving, n, seed; flowstudio.params caption/lyrics/max_duration/batch_count', mp.body && mp.body.model === 'Olares/' + MUZIEK && mp.body.prompt === 'rustige wachtmuziek, piano'
      && mp.body.n === 1 && mp.body.seed === 5 && JSON.stringify(mp.body.flowstudio.params) === JSON.stringify({ caption: 'rustige wachtmuziek, piano', lyrics: '', max_duration: 30, batch_count: 1 }), mp.body);
    toets('7 muziek: gepold op de Location, flac bewaard (soort studio)', t.status === 'klaar' && t.bestanden.length === 1 && t.bestanden[0].naam === 'muziek-1.flac'
      && R.gets.includes('/v1/music/generations/mjob-1') && bewaard[t.id] && bewaard[t.id].soort === 'studio', { t, gets: R.gets.slice(-4) });
    R.muziekType = 'application/octet-stream';
    r = await S7.maak({ flow: 'fs-' + MUZIEK, beurt_id: nb(), velden: { caption: 'x', max_duration: 20 } }, ctx);
    t = await w7(r.taak.id);
    toets('7 muziek zonder bruikbaar content-type: soort uit de eerste bytes (flac)', t.status === 'klaar' && t.bestanden[0].naam === 'muziek-1.flac', t);
    R.muziekType = 'audio/flac';
    r = await S7.maak({ flow: 'fs-' + MUZIEK, beurt_id: nb(), velden: { caption: 'x', max_duration: 301 } }, ctx);
    toets('7 muziek: duur boven 300 s geweigerd', r.status === 400 && /300/.test(r.fout), r);
    R.status = 'failed';
    r = await S7.maak({ flow: 'fs-' + MUZIEK, beurt_id: nb(), velden: { caption: 'x' } }, ctx);
    t = await w7(r.taak.id);
    toets('7 muziek: geheugenfout van Router in gewone taal (zonder MOSS-zin)', t.status === 'mislukt' && /^Olares heeft nu te weinig vrij geheugen voor FlowStudio/.test(t.reden) && !/MOSS/.test(t.reden), t.reden);
    R.status = 'completed';
    zetVrij(22); nieuw();
    const pm = R.posts.length;
    r = await S7.maak({ flow: 'fs-' + MUZIEK, beurt_id: nb(), velden: { caption: 'x' } }, ctx);
    toets('7 muziek bij te weinig geheugen: niet ingediend', r.status === 409 && R.posts.length === pm, r);
    zetVrij(60);
    S7.stopTimers();
  }

  // 6. audit en sporen
  const audit = fs.readFileSync(path.join(DIR, 'audit.jsonl'), 'utf8');
  toets('6 auditregel per taak, zonder prompttekst of sleutel', audit.split('\n').filter(Boolean).length >= 10 && audit.indexOf('wachtkamer') < 0 && audit.indexOf('Goedemiddag') < 0 && audit.indexOf(SLEUTEL) < 0, audit.slice(0, 300));
  toets('6 geen sleutel in het log of de foutregels', JSON.stringify(logs).indexOf(SLEUTEL) < 0 && JSON.stringify(fouts).indexOf(SLEUTEL) < 0, fouts);
  const taken = fs.readFileSync(takenF, 'utf8');
  toets('6 taken.json bevat geen sleutel; 0600', taken.indexOf(SLEUTEL) < 0 && (fs.statSync(takenF).mode & 0o077) === 0);
  const werkRest = fs.existsSync(path.join(DIR, 'werk')) ? fs.readdirSync(path.join(DIR, 'werk')) : [];
  toets('6 geen restbestanden in de werkmap', werkRest.length === 0, werkRest);
  toets('6 Router-aanroepen zonder sleutel alleen /v1/models', R.auth.filter((a) => !a).length >= 1 && R.posts.every((p) => p.kop.authorization === 'Bearer ' + SLEUTEL));
  S.stopTimers();
  router.close(); comfy.close(); vreemdSrv.close(); flowstudio.close();
  fs.rmSync(W, { recursive: true, force: true });
  console.log(fouten + ' ROOD, ' + goed + ' GROEN');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); process.exit(1); });
JS
