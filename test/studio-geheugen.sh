#!/usr/bin/env bash
# Toetst de geheugenpoort en de voorbewerking van studio.js (wv2679, fotoherstel "Krassen weg weer aan" + inkleuren zonder bruine
# waas) tegen een nagebootste ComfyUI en een nagebootst taalmodel op 127.0.0.1, met de echte studio-beeld.py (Pillow) en een eigen
# meminfo-bestand. Toetst: zware flow (ram_mib_schatting) draait alleen als het taalmodel uit is (503 zonder tekst), niet bij 200,
# 503 mét tekst (laadt) of onbereikbaar; geheugen te krap → één /free en opnieuw meten, daarna draaien of een weigering in gewone taal
# zonder upload of prompt; VRAM te krap = weigering (niet 30 min wachten); rij bezet = gewoon wachten, geen /free onder andermans
# handen; vrij_na → /free na de run, ook bij een fout; gewone flow: geen taalmodelvraag, geen /free. Voorbewerking grijs-niveaus: ComfyUI
# krijgt een grijze PNG met herstelde niveaus, voor.<ext> blijft het origineel, de app ziet de voorbewerking niet, onbekende soort
# wordt genegeerd. Raakt de echte ComfyUI, Olares en /opt/data niet.
# Gebruik: bash test/studio-geheugen.sh   (STUDIO_JS=<pad> voor een kruisproef op een andere studio.js)
set -u
cd "$(dirname "$0")/.." || exit 1
python3 -c "import PIL" 2>/dev/null || { echo "ROOD  python3 met Pillow ontbreekt"; exit 1; }
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto'), { execFileSync } = require('child_process');
const studioMod = require(process.env.STUDIO_JS || './studio.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-geheugen-'));
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 15000); while (Date.now() < t) { if (await f()) return true; await slaap(25); } return false; }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ── proefbeelden (verzonnen: een vale sepia "scan" met lichte rand, en een effen vlak als resultaat) ──
const B = path.join(W, 'beelden'); fs.mkdirSync(B);
execFileSync('python3', ['-I', '-c', `
import sys, os
from PIL import Image, ImageDraw
d = sys.argv[1]
im = Image.new('RGB', (400, 300), (246, 243, 236))
dr = ImageDraw.Draw(im)
for x in range(20, 380):
    v = 110 + (x - 20) * 90 // 360          # vaal verloop 110..200, sepia
    dr.line([(x, 20), (x, 279)], fill=(v, int(v * 0.9), int(v * 0.75)))
im.save(os.path.join(d, 'vaal.jpg'), quality=95)
Image.new('RGB', (800, 600), (200, 120, 60)).save(os.path.join(d, 'uit.png'))
`, B]);
const VAAL = fs.readFileSync(path.join(B, 'vaal.jpg')), UITBEELD = fs.readFileSync(path.join(B, 'uit.png'));
function pix(buf) {   // grijs? en min/max van het binnenste
  const f = path.join(W, 'p-' + crypto.randomBytes(4).toString('hex') + '.png'); fs.writeFileSync(f, buf);
  return JSON.parse(execFileSync('python3', ['-I', '-c', `
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]); rgb = im.convert('RGB'); px = rgb.load(); w, h = rgb.size
grijs = all(px[x, y][0] == px[x, y][1] == px[x, y][2] for x in range(0, w, 7) for y in range(0, h, 7))
l = rgb.convert('L').crop((30, 30, w - 30, h - 30)).getextrema()
rand = px[3, 3]
print(json.dumps({'formaat': im.format, 'b': w, 'h': h, 'grijs': grijs, 'min': l[0], 'max': l[1], 'rand': rand}))`, f]).toString());
}

// ── nagebootste ComfyUI ──
const MIB = 1048576;
const OI = {
  LoadImage: { python_module: 'nodes', input: { required: { image: [['voorbeeld.png'], { image_upload: true }] } } },
  DDColor_Colorize: { python_module: 'custom_nodes.ComfyUI-DDColor', input: { required: { image: ['IMAGE', {}], model_input_size: ['INT', {}], checkpoint: [['ddcolor_modelscope.pth', 'ddcolor_artistic.pth'], {}] } } },
  ImageScaleBy: { python_module: 'nodes', input: { required: { image: ['IMAGE', {}], upscale_method: [['lanczos'], {}], scale_by: ['FLOAT', {}] } } },
  PreviewImage: { python_module: 'nodes', input: { required: { images: ['IMAGE', {}] } } },
};
const C = { uploads: [], prompts: [], frees: 0, ram: 60000, vram: 23700, ramNaFree: null, rij: { queue_running: [], queue_pending: [] }, histFout: false, histN: 0, log: [] };
const comfy = http.createServer((req, res) => {
  const delen = []; req.on('data', (c) => delen.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(delen);
    const stuur = (st, j) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    C.log.push(req.method + ' ' + req.url.split('?')[0]);
    if (req.url === '/upload/image' && req.method === 'POST') {
      const fd = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const f = fd.get('image'); const inhoud = Buffer.from(await f.arrayBuffer());
      C.uploads.push({ naam: f.name, inhoud });
      return stuur(200, { name: f.name, subfolder: fd.get('subfolder'), type: 'input' });
    }
    if (req.url === '/object_info') return stuur(200, OI);
    if (req.url === '/queue' && req.method === 'GET') return C.rijKapot ? stuur(500, {}) : stuur(200, C.rij);
    if (req.url === '/system_stats' && C.rijNaStats) { C.rijNaStats = false; C.rij = { queue_running: [[1, 'ander-werk', {}, {}, []]], queue_pending: [] }; }
    if (req.url === '/system_stats') return stuur(200, { system: { ram_free: C.ram * MIB }, devices: [{ vram_total: 24000 * MIB, vram_free: C.vram * MIB }] });
    if (req.url === '/free' && req.method === 'POST') { C.frees++; if (C.ramNaFree != null) C.ram = C.ramNaFree; return stuur(200, {}); }
    if (req.url === '/prompt' && req.method === 'POST') {
      C.prompts.push(JSON.parse(body.toString())); C.histN = 0;
      const pid = 'pid-' + C.prompts.length;
      if (C.rijKapotNaPrompt) C.rijKapot = true;
      C.rij = C.anderVoor ? { queue_running: [[1, 'ander-werk', {}, {}, []]], queue_pending: [[2, pid, {}, {}, []]] } : { queue_running: [[1, pid, {}, {}, []]], queue_pending: [] };
      return stuur(200, { prompt_id: pid });
    }
    const m = /^\/history\/(.+)$/.exec(req.url);
    if (m) {
      if (++C.histN < 2) return stuur(200, {});
      C.rij = { queue_running: [], queue_pending: [] };
      if (C.histFout) return stuur(200, { [decodeURIComponent(m[1])]: { status: { status_str: 'error', completed: false }, outputs: {} } });
      return stuur(200, { [decodeURIComponent(m[1])]: { status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: 'ComfyUI_temp_00001_.png', subfolder: '', type: 'temp' }] } } } });
    }
    if (req.url.indexOf('/view?') === 0) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(UITBEELD); }
    if (req.url === '/queue' && req.method === 'POST') { const j = JSON.parse(body.toString() || '{}'); C.verwijderd = (C.verwijderd || []).concat(j.delete || []); C.rij = { queue_running: C.rij.queue_running, queue_pending: C.rij.queue_pending.filter((x) => (j.delete || []).indexOf(x[1]) < 0) }; return stuur(200, {}); }
    if (req.url === '/interrupt') { C.rij = { queue_running: [], queue_pending: [] }; return stuur(200, {}); }
    stuur(404, {});
  });
});
// ── nagebootst taalmodel: stand 'uit' (503 zonder tekst, zoals Olares bij een gestopte app), 'aan' (200), 'laadt' (503 met tekst) ──
const TM = { stand: 'uit', vragen: 0 };
const taal = http.createServer((req, res) => {
  TM.vragen++;
  if (TM.stand === 'aan') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"ok"}'); }
  if (TM.stand === 'redirect') { res.writeHead(302, { Location: 'https://elders.invalid/' }); return res.end(); }
  if (TM.stand === '502' || TM.stand === '401') { res.writeHead(Number(TM.stand), { 'Content-Length': '0' }); return res.end(); }
  if (TM.stand === 'laadt') { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}'); }
  res.writeHead(503, { 'Content-Length': '0' }); res.end();
});

(async function () {
  await new Promise((r) => comfy.listen(0, '127.0.0.1', r));
  await new Promise((r) => taal.listen(0, '127.0.0.1', r));
  const dicht = http.createServer(); await new Promise((r) => dicht.listen(0, '127.0.0.1', r)); const DICHT = 'http://127.0.0.1:' + dicht.address().port; await new Promise((r) => dicht.close(r));
  const CURL = 'http://127.0.0.1:' + comfy.address().port, TURL = 'http://127.0.0.1:' + taal.address().port;
  const DIR = path.join(W, 'studio'), BEWAAR = path.join(W, 'app-bestanden');
  const MEMINFO = path.join(W, 'meminfo');
  const zetHost = (mib) => fs.writeFileSync(MEMINFO, 'MemTotal:       98234608 kB\nMemFree:         1000000 kB\nMemAvailable:   ' + (mib * 1024) + ' kB\n');
  zetHost(68000);
  const zetFlow = (naam, y, api) => { fs.mkdirSync(path.join(DIR, 'flows', naam), { recursive: true }); fs.writeFileSync(path.join(DIR, 'flows', naam, 'flow.yaml'), JSON.stringify(y)); fs.writeFileSync(path.join(DIR, 'flows', naam, 'flow.json'), JSON.stringify(api)); };
  const apiS = { 1: { class_type: 'LoadImage', inputs: { image: 'voorbeeld.png' } }, 2: { class_type: 'ImageScaleBy', inputs: { image: ['1', 0], upscale_method: 'lanczos', scale_by: 2 } }, 9: { class_type: 'PreviewImage', inputs: { images: ['2', 0] } } };
  const foto = { naam: 'foto', label: 'Foto', soort: 'beeld', pad: '1.inputs.image' };
  zetFlow('zwaar', { titel: 'Krassen weg', motor: 'comfyui', status: 'actief', uitvoer: 'beeld', max_seconden: 30, gpu_mib_schatting: 21000, ram_mib_schatting: 40000, vrij_na: true, zonder_taalmodel: true, velden: [foto] }, apiS);
  zetFlow('gewoon', { titel: 'Opknappen', motor: 'comfyui', status: 'actief', uitvoer: 'beeld', max_seconden: 30, gpu_mib_schatting: 6000, velden: [foto] }, apiS);
  const apiDD = { 1: apiS[1], 2: { class_type: 'DDColor_Colorize', inputs: { image: ['1', 0], model_input_size: 512, checkpoint: 'ddcolor_modelscope.pth' } }, 9: { class_type: 'PreviewImage', inputs: { images: ['2', 0] } } };
  zetFlow('kleur', { titel: 'Inkleuren', motor: 'comfyui', status: 'actief', uitvoer: 'beeld', max_seconden: 30, velden: [foto,
    { naam: 'contrast', label: 'Contrast', soort: 'keuze', standaard: 'ja', opties: [{ label: 'ja', waarde: 'ja', voorbewerking: 'grijs-niveaus' }, { label: 'nee', waarde: 'nee' }, { label: 'raar', waarde: 'raar', voorbewerking: 'rm -rf /' }] },
    { naam: 'kleur', label: 'Kleur', soort: 'keuze', standaard: 'ddcolor_modelscope.pth', pad: '2.inputs.checkpoint', opties: [{ label: 'levendig', waarde: 'ddcolor_modelscope.pth' }, { label: 'gedempt', waarde: 'ddcolor_artistic.pth' }] }] }, apiDD);

  const bewaard = {};
  const bewaar = (jobId, outdir, meta) => {
    const dir = path.join(BEWAAR, jobId); fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
    const lijst = [];
    for (const n of fs.readdirSync(outdir).sort()) { const doel = path.join(dir, 'b', String(lijst.length + 1)); fs.renameSync(path.join(outdir, n), doel); lijst.push({ n: lijst.length + 1, naam: n, pad: doel }); }
    const m = { job_id: jobId, bestanden: lijst, label: meta.label }; bewaard[jobId] = m; return m;
  };
  let taalUrl = TURL;
  const maakStudio = () => studioMod.maak({ dir: DIR, bewaar, primair: () => true, sleutel: async () => null, routerUrl: 'http://127.0.0.1:1', comfyUrl: CURL, flowstudioUrl: 'http://127.0.0.1:1',
    meminfo: MEMINFO, taalmodelUrl: taalUrl, log: () => {}, fout: () => {}, tempo: { poll: 30, wachtStap: 40, wachtMax: 1500, naFree: 20, taalmodelMs: 1500 } });
  let S = maakStudio();
  const UP = {};
  const ctx = { versOk: () => true, versVerbruik: () => {}, apparaat: 'toets',
    neemUpload: (beurt, n) => UP[beurt + '/' + n] ? { naam: 'foto.jpg', bytes: UP[beurt + '/' + n], weg: () => { delete UP[beurt + '/' + n]; } } : null };
  let bn = 0;
  const wacht = async (id, ms) => { await totDat(() => { const t = S.taak(id); return t && ['klaar', 'mislukt', 'gestopt'].indexOf(t.status) >= 0; }, ms); return S.taak(id); };
  async function draai(flow, velden) {
    const beurt = 'beurt-' + (++bn) + '-' + crypto.randomBytes(3).toString('hex'); UP[beurt + '/1'] = VAAL;
    const n = { up: C.uploads.length, pr: C.prompts.length, fr: C.frees, tm: TM.vragen };
    const r = await S.maak({ flow, beurt_id: beurt, velden: Object.assign({ foto: { n: 1 } }, velden || {}) }, ctx);
    if (!r.taak) return { r, t: null, up: [], pr: 0, fr: 0, tm: 0 };
    const t = await wacht(r.taak.id);
    await slaap(150);   // vrijNa loopt na het afronden van comfyDraai
    return { r, t, up: C.uploads.slice(n.up), pr: C.prompts.length - n.pr, fr: C.frees - n.fr, tm: TM.vragen - n.tm };
  }
  const herstel = () => { C.ram = 60000; C.vram = 23700; C.ramNaFree = null; C.histFout = false; C.rij = { queue_running: [], queue_pending: [] }; TM.stand = 'uit'; zetHost(68000); };

  // 1. catalogus: de app ziet de geheugenvelden en de voorbewerking niet als knoopwaarden
  const cat = await S.flows();
  const fk = cat.flows.find((x) => x.id === 'kleur'), fz = cat.flows.find((x) => x.id === 'zwaar');
  toets('1 flows klaar (zwaar en kleur)', fk && fk.klaar && fz && fz.klaar, cat.flows.map((f) => [f.id, f.reden]));
  toets('1 de app ziet geen voorbewerking (ook niet de onbekende)', JSON.stringify(cat).indexOf('grijs-niveaus') < 0 && JSON.stringify(cat).indexOf('rm -rf') < 0);

  // 2. zware flow, taalmodel uit, genoeg geheugen → klaar; één taalmodelvraag; na de run één /free
  herstel();
  let x = await draai('zwaar');
  toets('2 zwaar + taalmodel uit + genoeg geheugen: klaar', x.t && x.t.status === 'klaar', x.t || x.r);
  toets('2 taalmodel één keer gevraagd', x.tm === 1, x.tm);
  toets('2 na de run precies één /free (vrij_na), vooraf geen', x.fr === 1, x.fr);
  toets('2 meting: host-geheugen vooraf en RAM na /free vastgelegd', x.t && x.t.meting && x.t.meting.host_vrij_voor_mib === 68000 && x.t.meting.ram_vrij_na_free_mib === 60000, x.t && x.t.meting);
  toets('2 foto naar ComfyUI en daarna 1×1', x.up.length === 2 && sha(x.up[0].inhoud) === sha(VAAL), x.up.map((u) => u.inhoud.length));

  // 3. taalmodel draait (200) → geweigerd, niets naar ComfyUI
  herstel(); TM.stand = 'aan';
  x = await draai('zwaar');
  toets('3 taalmodel aan: mislukt met uitleg in gewone taal', x.t && x.t.status === 'mislukt' && /taalmodel op Olares draait weer/.test(x.t.reden) && /niets gestart/.test(x.t.reden), x.t && x.t.reden);
  toets('3 taalmodel aan: geen upload, geen prompt, geen /free', x.up.length === 0 && x.pr === 0 && x.fr === 0, [x.up.length, x.pr, x.fr]);

  // 4. taalmodel laadt (503 met tekst) → geweigerd
  herstel(); TM.stand = 'laadt';
  x = await draai('zwaar');
  toets('4 taalmodel laadt (503 met tekst): geweigerd, niets ingediend', x.t && x.t.status === 'mislukt' && /draait weer/.test(x.t.reden) && x.pr === 0 && x.up.length === 0, x.t && x.t.reden);

  // 4b. onverwachte antwoorden (redirect, 401, 502) tellen niet als 'uit' (review MOET 1)
  for (const st of ['redirect', '401', '502']) {
    herstel(); TM.stand = st;
    x = await draai('zwaar');
    toets('4b taalmodel antwoordt ' + st + ': geweigerd ("niet na te gaan"), niets ingediend', x.t && x.t.status === 'mislukt' && /niet na te gaan/.test(x.t.reden) && x.pr === 0 && x.up.length === 0 && x.fr === 0, x.t && x.t.reden);
  }

  // 5. taalmodel onbereikbaar → geweigerd (liever niets dan het geheugen vol)
  herstel(); S.stopTimers(); taalUrl = DICHT; S = maakStudio();
  x = await draai('zwaar');
  toets('5 taalmodel onbereikbaar: geweigerd met "niet na te gaan", niets ingediend', x.t && x.t.status === 'mislukt' && /niet na te gaan/.test(x.t.reden) && x.pr === 0 && x.up.length === 0, x.t && x.t.reden);
  S.stopTimers(); taalUrl = TURL; S = maakStudio();

  // 6. ComfyUI-RAM krap, /free helpt → klaar; /free vooraf én na de run
  herstel(); C.ram = 25000; C.ramNaFree = 59000;
  x = await draai('zwaar');
  toets('6 RAM krap, /free maakt ruimte: klaar', x.t && x.t.status === 'klaar', x.t);
  toets('6 twee keer /free: één vooraf (opruimen), één na de run', x.fr === 2, x.fr);

  // 7. RAM krap, /free helpt niet → geweigerd met getallen, niets ingediend
  herstel(); C.ram = 25000; C.ramNaFree = 26000;
  x = await draai('zwaar');
  toets('7 RAM blijft krap: mislukt met "Te weinig geheugen" en nodig/vrij in GB', x.t && x.t.status === 'mislukt' && /Te weinig geheugen vrij op Olares/.test(x.t.reden) && /nodig ± 39 GB werkgeheugen en 21 GB videogeheugen, vrij nu 25 GB en 23 GB/.test(x.t.reden) && /Opknappen of Inkleuren/.test(x.t.reden), x.t && x.t.reden);
  toets('7 geen upload, geen prompt; één /free (de opruimpoging)', x.up.length === 0 && x.pr === 0 && x.fr === 1, [x.up.length, x.pr, x.fr]);

  // 7b. RAM krap en net daarna ander werk in de rij: geen /free onder andermans handen, nette weigering (review MOET 2)
  herstel(); C.ram = 25000; C.ramNaFree = 59000; C.rijNaStats = true;
  x = await draai('zwaar');
  toets('7b rij wordt bezet vóór het opruimen: geen /free, geweigerd met "net ander werk"', x.t && x.t.status === 'mislukt' && /net ander werk/.test(x.t.reden) && x.fr === 0 && x.pr === 0, [x.t && x.t.reden, x.fr]);
  C.rijNaStats = false;

  // 7c. ander werk komt binnen tussen meting en indienen: eigen taak uit de rij, geweigerd
  herstel(); C.anderVoor = true; C.verwijderd = [];
  x = await draai('zwaar');
  toets('7c ander werk vóór de onze na het indienen: eigen prompt uit de rij gehaald, geweigerd', x.t && x.t.status === 'mislukt' && /net ander werk/.test(x.t.reden) && C.verwijderd.length === 1 && /^pid-/.test(C.verwijderd[0]), [x.t && x.t.reden, C.verwijderd]);
  C.anderVoor = false; C.rij = { queue_running: [], queue_pending: [] };

  // 7d. rij onleesbaar direct na het indienen: eigen prompt toch uit de rij (delete), eerlijke melding, 10-min-ronde ruimt op (Fable MOET 1)
  herstel(); C.verwijderd = []; C.rijKapotNaPrompt = true;
  x = await draai('zwaar');
  toets('7d rij onleesbaar na indienen: eigen delete verstuurd, melding "mogelijk toch gestart"', x.t && x.t.status === 'mislukt' && /mogelijk toch gestart/.test(x.t.reden) && C.verwijderd.length === 1, [x.t && x.t.reden, C.verwijderd]);
  C.rijKapotNaPrompt = false; C.rijKapot = false; C.rij = { queue_running: [], queue_pending: [] };

  // 8. machinegeheugen krap (MemAvailable < nodig + marge) → geweigerd
  herstel(); zetHost(45000);
  x = await draai('zwaar');
  toets('8 MemAvailable 45 GB < 39 + 10 GB marge: geweigerd, vrij nu 34 GB', x.t && x.t.status === 'mislukt' && /vrij nu 34 GB/.test(x.t.reden) && x.pr === 0, x.t && x.t.reden);
  herstel(); fs.rmSync(MEMINFO);
  x = await draai('zwaar');
  toets('8 meminfo onleesbaar: geweigerd (vrij nu ?)', x.t && x.t.status === 'mislukt' && /vrij nu \? GB/.test(x.t.reden) && x.pr === 0, x.t && x.t.reden);
  zetHost(68000);

  // 9. VRAM krap → meteen geweigerd, niet 30 min (hier 1,5 s) wachten
  herstel(); C.vram = 9000;
  let t0 = Date.now();
  x = await draai('zwaar');
  toets('9 VRAM krap: geweigerd binnen 1 s (geen wachtlus)', x.t && x.t.status === 'mislukt' && /Te weinig geheugen/.test(x.t.reden) && Date.now() - t0 < 1000 && x.pr === 0, [x.t && x.t.reden, Date.now() - t0]);

  // 10. rij bezet door iemand anders → wachten (oud gedrag), geen /free, geen taalmodelvraag; na wachtMax de bekende melding
  herstel(); C.rij = { queue_running: [[1, 'andermans', {}, {}, []]], queue_pending: [] };
  x = await draai('zwaar');
  toets('10 rij bezet: na het wachten "bleef bezig", geen /free, geen taalmodelvraag', x.t && x.t.status === 'mislukt' && /bezig met iets anders/.test(x.t.reden) && x.fr === 0 && x.tm === 0 && x.pr === 0, [x.t && x.t.reden, x.fr, x.tm]);

  // 11. fout in ComfyUI tijdens een zware run → toch /free na afloop, en 1×1
  herstel(); C.histFout = true;
  x = await draai('zwaar');
  toets('11 fout in de flow: mislukt, toch /free na afloop en 1×1', x.t && x.t.status === 'mislukt' && x.fr === 1 && x.up.length === 2 && x.up[1].inhoud.length < 200, [x.t && x.t.reden, x.fr, x.up.length]);

  // 12. gewone flow: geen taalmodelvraag, geen /free, ook niet bij een krap RAM-cijfer
  herstel(); C.ram = 1000;
  x = await draai('gewoon');
  toets('12 gewone flow: klaar zonder taalmodelvraag en zonder /free', x.t && x.t.status === 'klaar' && x.tm === 0 && x.fr === 0, [x.t && x.t.status, x.tm, x.fr]);

  // 13. voorbewerking grijs-niveaus (standaard ja)
  herstel();
  x = await draai('kleur');
  const p13 = x.up[0] ? pix(x.up[0].inhoud) : null;
  toets('13 contrast ja: klaar', x.t && x.t.status === 'klaar', x.t);
  toets('13 ComfyUI kreeg een grijze PNG met dezelfde maten', p13 && p13.formaat === 'PNG' && p13.grijs && p13.b === 400 && p13.h === 300, p13);
  toets('13 niveaus hersteld: binnenste loopt van ≤ 8 tot ≥ 247 (was 110–200); rand wit', p13 && p13.min <= 8 && p13.max >= 247 && p13.rand[0] === 255, p13);
  const bw13 = x.t && bewaard[x.t.id];
  const voor13 = bw13 && bw13.bestanden.find((b) => /^voor\./.test(b.naam));
  toets('13 voor.jpg in Bestanden = het origineel (byte voor byte)', voor13 && sha(fs.readFileSync(voor13.pad)) === sha(VAAL), bw13);
  toets('13 meting noemt de voorbewerking; geen restbestand in de werkmap', x.t && x.t.meting && x.t.meting.voorbewerking === 'grijs-niveaus' && !fs.existsSync(path.join(DIR, 'werk', x.t.id)), x.t && x.t.meting);
  // 14. contrast nee: ComfyUI krijgt de foto zoals hij kwam
  herstel();
  x = await draai('kleur', { contrast: 'nee', kleur: 'ddcolor_artistic.pth' });
  toets('14 contrast nee: ComfyUI kreeg de foto byte voor byte; checkpoint gedempt', x.t && x.t.status === 'klaar' && x.up[0] && sha(x.up[0].inhoud) === sha(VAAL) && C.prompts[C.prompts.length - 1].prompt['2'].inputs.checkpoint === 'ddcolor_artistic.pth', x.t);
  // 15. onbekende voorbewerking in flow.yaml: genegeerd (vaste lijst in de pod)
  herstel();
  x = await draai('kleur', { contrast: 'raar' });
  toets('15 onbekende voorbewerking: genegeerd, foto onveranderd', x.t && x.t.status === 'klaar' && x.up[0] && sha(x.up[0].inhoud) === sha(VAAL) && !(x.t.meting && x.t.meting.voorbewerking), x.t && x.t.meting);
  // 16. studio-beeld.py weigert een onbekende soort zelf ook
  let py = null; try { execFileSync('python3', ['-I', 'studio-beeld.py', 'voor', path.join(B, 'vaal.jpg'), path.join(W, 'x.png'), 'rm -rf /']); } catch (e) { py = { code: e.status, uit: String(e.stdout) }; }
  toets('16 studio-beeld.py voor met onbekende soort: exit 2, niets geschreven', py && py.code === 2 && /onbekende voorbewerking/.test(py.uit) && !fs.existsSync(path.join(W, 'x.png')), py);

  // 17. egaal beeld (lege scan): niet zwart maken (review ZOU 1)
  execFileSync('python3', ['-I', '-c', "import sys\nfrom PIL import Image\nImage.new('RGB', (200, 100), (240, 240, 240)).save(sys.argv[1])", path.join(B, 'wit.png')]);
  execFileSync('python3', ['-I', 'studio-beeld.py', 'voor', path.join(B, 'wit.png'), path.join(W, 'wit-uit.png'), 'grijs-niveaus']);
  const p17 = pix(fs.readFileSync(path.join(W, 'wit-uit.png')));
  toets('17 egaal lichtgrijs beeld blijft lichtgrijs (240), wordt niet zwart', p17.min === 240 && p17.max === 240, p17);

  S.stopTimers(); comfy.close(); taal.close();
  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering: ' + (e && e.stack)); process.exit(1); });
JS
