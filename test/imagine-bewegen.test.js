'use strict';
// wv3266: OVIS Imagine "Laat bewegen" — de twee videoflows (fixture = mk-scripts/imagine-video-plan/fase1/maak-video-flows.py, object_info van
// ComfyUI 0.44 ingekort tot de gebruikte waarden) door de knopentoets, en de hele weg tegen de nagebouwde ComfyUI (test/imagine-nep-comfy.js):
// foto → exacte maat → beelden over de websocket → mp4 (echte ffmpeg) → nieuwe versie met affiche; standaardopdracht; /free vóór elke videotaak;
// geheugenwacht (ram_free onder 12 GB → eigen prompt onderbreken, "afgebroken: server te vol", niets herhaald); één filmpje tegelijk; geschiedenis
// weg en invoer 1×1; plafond; niet in incognito en niet via de Studio-tab; filmpje niet verder te bewerken; Immich zonder stapel.
// Kruisproeven (moeten ROOD): IMAGINE_KRUIS=kwacht (geheugenwacht uit), =kfree (geen /free vooraf), =khist (geschiedenis niet gewist),
// =kpoort (videoflow zonder geheugenpoort toegestaan). Verzonnen beelden en teksten; raakt de echte ComfyUI niet.
// Vraagt python3 met Pillow en ffmpeg (FFMPEG=<pad>, anders /opt/data/tools/ffmpeg/ffmpeg of ffmpeg in PATH).
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const KRUIS = process.env.IMAGINE_KRUIS || '';
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 15000); while (Date.now() < t) { if (await f()) return true; await slaap(30); } return false; }
function ffmpegPad() {
  for (const p of [process.env.FFMPEG, '/opt/data/tools/ffmpeg/ffmpeg']) { try { if (p && fs.statSync(p).isFile()) return p; } catch (e) {} }
  try { return execFileSync('sh', ['-c', 'command -v ffmpeg']).toString().trim() || null; } catch (e) { return null; }
}
const FFMPEG = ffmpegPad();
if (!FFMPEG) { console.log('ROOD  ffmpeg ontbreekt'); process.exit(1); }

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'imagine-bewegen-'));
const POD = path.join(W, 'pod'), COMFY = path.join(W, 'comfy'), MOD = path.join(W, 'mod');
fs.mkdirSync(POD); fs.mkdirSync(MOD);
for (const f of ['studio.js', 'studio-beeld.py', 'elevenlabs-credits.js', 'imagine.js']) fs.copyFileSync(path.join(ROOT, f), path.join(MOD, f));
function wijzig(f, oud, nieuw) { const p = path.join(MOD, f); const s = fs.readFileSync(p, 'utf8'); if (s.indexOf(oud) < 0) throw new Error('kruisproef: tekst niet gevonden in ' + f); fs.writeFileSync(p, s.split(oud).join(nieuw)); }
if (KRUIS === 'kwacht') wijzig('studio.js', 'if (vrij < VIDEO.ram_wacht_bytes) {', 'if (false) {');
if (KRUIS === 'kfree') wijzig('studio.js', "        if (videoTaak) {\n          // wv3266 (geheugenwacht)", "        if (false) {\n          // wv3266 (geheugenwacht)");
if (KRUIS === 'khist') wijzig('studio.js', 'async function histWisNu(pid) {', 'async function histWisNu(pid) { return true;');
if (KRUIS === 'kpoort') wijzig('studio.js', 'if (videoTaak && !(f.ram_mib_schatting > 0 && f.zonder_taalmodel && f.vrij_na))', 'if (false)');
const studioMod = require(path.join(MOD, 'studio.js'));
const imagineMod = require(path.join(MOD, 'imagine.js'));
const F = path.join(__dirname, 'fixtures', 'imagine-bewegen');
const OI = JSON.parse(fs.readFileSync(path.join(F, 'object_info.json'), 'utf8'));
const lees = (n) => JSON.parse(fs.readFileSync(path.join(F, n), 'utf8'));
const WAN = lees('video-wan-snel.json'), MM = lees('video-minimax-trouw.json'), WANY = lees('video-wan-snel.yaml'), MMY = lees('video-minimax-trouw.yaml');
function beeld(b, h) {   // verzonnen beeld: zachte kleurverloop (klein als PNG)
  return execFileSync('python3', ['-I', '-c', "import sys, io\nfrom PIL import Image\nb, h = int(sys.argv[1]), int(sys.argv[2])\nim = Image.new('RGB', (b, h))\nim.putdata([((x * 255) // b, (y * 255) // h, 90) for y in range(h) for x in range(b)])\nu = io.BytesIO(); im.save(u, 'JPEG', quality=90); sys.stdout.buffer.write(u.getvalue())", String(b), String(h)]);
}
function maatVan(buf) { return JSON.parse(execFileSync('python3', ['-I', '-c', "import sys, io, json\nfrom PIL import Image\nim = Image.open(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps(im.size))"], { input: buf }).toString()); }
function mp4Beelden(p) {
  let t = '';
  try { execFileSync(FFMPEG, ['-hide_banner', '-i', p, '-map', '0:v:0', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { t = String(e.stderr || ''); }
  try { t = t || execFileSync('sh', ['-c', '"$0" -hide_banner -i "$1" -map 0:v:0 -f null - 2>&1', FFMPEG, p]).toString(); } catch (e) { t = String(e.stdout || e.stderr || ''); }
  const n = /frame=\s*(\d+)/g; let m, laatst = null; while ((m = n.exec(t))) laatst = Number(m[1]);
  return { beelden: laatst, video: /Video: h264/.test(t) && /yuv420p/.test(t), geluid: /Audio:/.test(t), maat: (/, (\d{2,5})x(\d{2,5})/.exec(t) || []).slice(1).map(Number) };
}

(async function () {
  // ── K. knopentoets van de echte flows ──
  for (const [naam, api, y] of [['video-wan-snel', WAN, WANY], ['video-minimax-trouw', MM, MMY]]) {
    const r = studioMod.flowToets(api, OI, { ws: true, geheugen: true });
    toets('K1 ' + naam + ': knopentoets groen, enige uitvoer SaveImageWebsocket', !r.fout && r.ws_knopen && r.ws_knopen.join() === '200'
      && Object.values(r.prompt).filter((n) => OI[n.class_type] && OI[n.class_type].output_node).length === 1, r.fout);
    const k = JSON.parse(JSON.stringify(api)); k['300'] = { class_type: 'SaveVideo', inputs: { video: ['1', 0], filename_prefix: 'x', format: 'auto', codec: 'auto' } };
    const oi2 = Object.assign({}, OI, { SaveVideo: { python_module: 'comfy_extras.nodes_video', output_node: true, input: { required: { video: ['VIDEO', {}], filename_prefix: ['STRING', {}], format: ['COMBO', {}], codec: ['COMBO', {}] } } } });
    const r2 = studioMod.flowToets(k, oi2, { ws: true, geheugen: true });
    toets('K2 ' + naam + ' met SaveVideo erbij: geweigerd (schrijft naar ComfyUI)', !!r2.fout && /SaveVideo/.test(r2.fout), r2);
    toets('K3 ' + naam + '.yaml: uitvoer video, verborgen, actief, plafond 900 s, geheugenpoort (werkgeheugen, taalmodel uit, vrijgeven na)',
      y.uitvoer === 'video' && y.verborgen === true && y.status === 'actief' && y.max_seconden === 900 && y.ram_mib_schatting > 0 && y.zonder_taalmodel === true && y.vrij_na === true);
    toets('K4 ' + naam + ': geen "leaves" in de flow', JSON.stringify(api).indexOf('leaves') < 0);
  }
  toets('K5 standaardopdracht: levendig, iedereen beweegt, inzoom, gezichten hetzelfde, zonder "leaves"', /Everyone/.test(imagineMod.BEWEGEN_STANDAARD) && /zoom-in/.test(imagineMod.BEWEGEN_STANDAARD)
    && /Faces stay/.test(imagineMod.BEWEGEN_STANDAARD) && !/leaves/i.test(imagineMod.BEWEGEN_STANDAARD));

  // ── pod tegen de nagebouwde ComfyUI ──
  const nep = await require('./imagine-nep-comfy.js').start(COMFY, { oi: OI });
  const C = nep.C;
  let nu = Date.parse('2026-11-17T14:00:00Z');
  const klok = () => nu;
  const STUDIO = path.join(POD, 'studio'), IMAGINE = path.join(POD, 'imagine'), LOG = path.join(POD, 'api.log');
  const MEMINFO = path.join(POD, 'meminfo'); fs.writeFileSync(MEMINFO, 'MemTotal: 98000000 kB\nMemAvailable: 80000000 kB\n');
  const zetFlow = (naam, y, api) => { fs.mkdirSync(path.join(STUDIO, 'flows', naam), { recursive: true }); fs.writeFileSync(path.join(STUDIO, 'flows', naam, 'flow.yaml'), JSON.stringify(y)); fs.writeFileSync(path.join(STUDIO, 'flows', naam, 'flow.json'), JSON.stringify(api)); };
  zetFlow('video-wan-snel', WANY, WAN);
  zetFlow('video-minimax-trouw', MMY, MM);
  // proef zonder geheugenpoort (moet geweigerd worden door de motor)
  zetFlow('video-zonder-poort', Object.assign({}, WANY, { ram_mib_schatting: 0, verborgen: true }), WAN);
  const schrijfLog = (x) => fs.appendFileSync(LOG, x + '\n');
  const S = studioMod.maak({ dir: STUDIO, bewaar: () => { throw new Error('Bestanden mag niet'); }, primair: () => true, sleutel: async () => null,
    routerUrl: 'http://127.0.0.1:1', comfyUrl: nep.url, flowstudioUrl: 'http://127.0.0.1:1', taalmodelUrl: null, nu: klok, meminfo: MEMINFO, ffmpeg: FFMPEG,
    log: schrijfLog, fout: (w, e) => schrijfLog('FOUT ' + w + ': ' + (e && e.message)), merk: path.join(IMAGINE, 'incognito-merk.json'),
    tempo: { poll: 30, wachtStap: 40, wachtMax: 1500, naFree: 10, naloopStart: 0, ramWacht: 40 } });
  const opgeladen = [];
  const immich = { basis: 'https://immich.nep', uploaden: async (x) => { opgeladen.push(x); return { id: crypto.randomUUID(), nieuw: true }; }, fotoInfo: async () => null, albumsVan: async () => [],
    mijnId: async () => 'ik', magStapelen: async () => true, stapelen: async () => { opgeladen.push('stapel'); return { gestapeld: true }; },
    inAlbum: async () => true, album: async (id) => ({ id: id }) };
  const I = imagineMod.maak({ dir: IMAGINE, studio: S, primair: () => true, nu: klok, log: schrijfLog, fout: (w, e) => schrijfLog('FOUT ' + w + ': ' + (e && e.message)), immich: immich, tempo: { ronde: 3600000 } });
  const ctx = { versOk: () => true, versVerbruik: () => {} };
  const roep = (pad, body, a) => I.app({ pad: pad, methode: body === undefined ? 'GET' : 'POST', body: body, apparaat: a || 'apparaat-a', ctx: ctx });
  let bn = 0; const nb = () => 'beurt-' + (++bn) + '-' + crypto.randomBytes(3).toString('hex');
  const taakVan = async (id) => { const r = await roep('/app/imagine'); return r.body.taken.find((t) => t.id === id); };
  const wachtTaak = async (id, ms) => { let t = null; await totDat(async () => { t = await taakVan(id); return t && t.status !== 'wacht' && t.status !== 'bezig'; }, ms || 60000); return t; };
  const invoer1x1 = () => { try { const m = maatVan(fs.readFileSync(nep.invoerPad)); return m[0] === 1 && m[1] === 1; } catch (e) { return false; } };

  // 1. stand in de app
  let r = await roep('/app/imagine');
  const bw = r.body.bewegen;
  toets('B1 GET /app/imagine: twee keuzes, Trouw voorgekozen, beide klaar, tijden ± 9 en ± 4 min', bw && bw.modellen.length === 2 && bw.standaard === 'trouw'
    && bw.modellen[0].model === 'trouw' && bw.modellen[0].naam === 'Trouw aan gezichten' && bw.modellen[0].tijd === '± 9 min' && bw.modellen[1].naam === 'Snel' && bw.modellen[1].tijd === '± 4 min'
    && bw.modellen.every((m) => m.klaar) && bw.duur_s === 5 && bw.bezig === false, bw);
  toets('B1 videoflows niet als bewerkstand', !r.body.standen.some((s) => /video/.test(s.id)));
  r = await roep('/app/imagine/laad', { data: beeld(600, 850).toString('base64'), titel: 'Verzonnen verloop' });
  const bron = r.body.bron, v1 = r.body.versie;
  toets('B2 foto geladen', r.status === 200 && !!v1, r);

  // 2. Snel, standaardopdracht
  const pr0 = C.prompts.length; C.gebeurd.length = 0;
  r = await roep('/app/imagine/bewegen', { versie: v1, model: 'snel', beweging: '', beurt_id: nb() });
  toets('B2 bewegen Snel gestart', r.status === 200 && r.body.taak && r.body.taak.stand === 'bewegen', r);
  let t = await wachtTaak(r.body.taak.id);
  toets('B2 taak klaar', t && t.status === 'klaar' && !!t.versie, t);
  const p = C.prompts[pr0] && C.prompts[pr0].prompt;
  toets('B3 /free vóór het indienen', C.gebeurd.indexOf('free') >= 0 && C.gebeurd.indexOf('free') < C.gebeurd.indexOf('prompt'), C.gebeurd);
  toets('B3 opdracht leeg = standaardopdracht (levendig, zonder leaves)', p && p['93'].inputs.text === imagineMod.BEWEGEN_STANDAARD, p && p['93'].inputs.text);
  toets('B3 maat 720×1024 (korte zijde 720, veelvoud 16), 81 beelden', p && p['98'].inputs.width === 720 && p['98'].inputs.height === 1024 && p['98'].inputs.length === 81, p && p['98'].inputs);
  toets('B3 foto onder de vaste Studio-naam, enige uitvoer SaveImageWebsocket', p && p['1'].inputs.image === 'studio/fotoherstel-invoer.png' && Object.values(p).filter((n) => /^Save|Preview/.test(n.class_type)).map((n) => n.class_type).join() === 'SaveImageWebsocket');
  const b = await roep('/app/imagine/bron/' + bron);
  const vv = b.body.versies.find((x) => x.id === t.versie);
  toets('B4 nieuwe versie: video, nr 2, voorganger = foto, model Wan 2.2, stand bewegen, opdracht niet bewaard (leeg vak)', vv && vv.video === true && vv.ext === 'mp4' && vv.nr === 2 && vv.voorganger === v1
    && vv.model === 'Wan 2.2' && vv.stand === 'bewegen' && vv.opdracht === null && vv.breed === 720 && vv.hoog === 1024, vv);
  const mp4Pad = path.join(IMAGINE, 'beelden', bron, t.versie + '.mp4');
  const mp4 = fs.readFileSync(mp4Pad);
  const ff = mp4Beelden(mp4Pad);
  toets('B4 mp4 op de pod: H.264 yuv420p, 81 beelden, 720×1024, zonder geluid', ff.video && ff.beelden === 81 && !ff.geluid && ff.maat[0] === 720 && ff.maat[1] === 1024, ff);
  toets('B4 faststart (moov vóór mdat)', mp4.indexOf('moov') > 0 && mp4.indexOf('moov') < mp4.indexOf('mdat'));
  toets('B4 bestand 0600, origineel ongemoeid', (fs.statSync(mp4Pad).mode & 0o777) === 0o600 && b.body.versies.find((x) => x.id === v1).nr === 1);
  r = await roep('/app/imagine/v/' + t.versie + '/toon');
  toets('B4 weergaveversie = eerste beeld (jpg)', r.status === 200 && r.body.mime === 'image/jpeg' && r.body.data.length > 100);
  r = await roep('/app/imagine/v/' + t.versie + '/deel/1');
  toets('B4 afspelen: deel 1 als video/mp4, gelijk aan het bestand', r.status === 200 && r.body.mime === 'video/mp4' && Buffer.from(r.body.data, 'base64').equals(mp4.subarray(0, Buffer.from(r.body.data, 'base64').length)), r.body && r.body.mime);
  const eigenPid = C.prompts[pr0].prompt_id || 'pid-' + (pr0 + 1);
  toets('B5 eigen /history-regel weg', !C.hist[eigenPid] && Object.keys(C.hist).length === 0, Object.keys(C.hist));
  toets('B5 invoer terug op 1×1', invoer1x1());
  toets('B5 werkmap van de pod leeg (geen losse beelden of mp4)', !fs.existsSync(path.join(STUDIO, 'werk')) || fs.readdirSync(path.join(STUDIO, 'werk')).length === 0, fs.existsSync(path.join(STUDIO, 'werk')) && fs.readdirSync(path.join(STUDIO, 'werk')));
  toets('B5 /free ook na afloop', C.gebeurd.lastIndexOf('free') > C.gebeurd.indexOf('prompt'), C.gebeurd);
  const logT = fs.readFileSync(LOG, 'utf8');
  toets('B5 log zonder opdrachttekst', logT.indexOf('Lively') < 0 && /imagine bewegen klaar/.test(logT));

  // 3. eigen opdracht + Trouw (MiniMax), en één filmpje tegelijk
  const EIGEN = 'Iedereen zwaait langzaam EIGENmerk' + crypto.randomBytes(4).toString('hex');
  C.scenario = 'hang';
  const pr1 = C.prompts.length;
  r = await roep('/app/imagine/bewegen', { versie: v1, beweging: EIGEN, beurt_id: nb() });
  toets('B6 zonder keuze = Trouw (MiniMax) gestart', r.status === 200, r);
  const tTrouw = r.body.taak.id;
  await totDat(async () => C.prompts.length > pr1, 10000);
  const p2 = C.prompts[pr1] && C.prompts[pr1].prompt;
  toets('B6 eigen opdracht letterlijk, 768×1088, 124 beelden', p2 && p2['104'].inputs.prompt === EIGEN && p2['104'].inputs.width === 768 && p2['104'].inputs.height === 1088 && p2['104'].inputs.length === 124, p2 && p2['104'].inputs);
  r = await roep('/app/imagine/bewegen', { versie: v1, model: 'snel', beurt_id: nb() });
  toets('B7 tweede filmpje terwijl er een loopt: geweigerd', r.status === 409 && /al een filmpje/.test(r.body.fout), r);
  r = await roep('/app/imagine');
  toets('B7 stand: bezig = true', r.body.bewegen.bezig === true);
  // geheugenwacht: ram_free zakt onder 12 GB
  const intr0 = C.interrupts.length;
  C.ramVrij = 9.1e9;
  t = await wachtTaak(tTrouw, 15000);
  toets('B8 geheugenwacht: ram_free onder 12 GB → afgebroken: server te vol', t && t.status === 'mislukt' && /^afgebroken: server te vol/.test(t.reden || ''), t);
  toets('B8 eigen prompt onderbroken', C.interrupts.length > intr0 && C.interrupts.slice(intr0).some((x) => x.prompt_id === (C.prompts[pr1].prompt_id || 'pid-' + (pr1 + 1))), C.interrupts.slice(intr0));
  await slaap(400);
  toets('B8 geen herhaling (geen nieuwe prompt)', C.prompts.length === pr1 + 1, C.prompts.length - pr1);
  toets('B8 invoer 1×1 en geschiedenis weg na het afbreken', invoer1x1() && Object.keys(C.hist).length === 0, Object.keys(C.hist).length);
  C.ramVrij = 60 * 1073741824; C.scenario = 'goed';

  // 4. plafond (max_seconden) en motor zonder geheugenpoort
  zetFlow('video-wan-snel', Object.assign({}, WANY, { max_seconden: 10 }), WAN);
  C.scenario = 'hang';
  nu += 1000;
  r = await roep('/app/imagine/bewegen', { versie: v1, model: 'snel', beurt_id: nb() });
  const tPl = r.body.taak && r.body.taak.id;
  t = null;
  await totDat(async () => { nu += 3000; t = await taakVan(tPl); return t && t.status !== 'wacht' && t.status !== 'bezig'; }, 20000);   // de klok van de pod loopt door
  toets('B9 plafond: na max_seconden gestopt', t && t.status === 'mislukt' && /langer over dan 10 s/.test(t.reden || ''), t);
  C.scenario = 'goed';
  zetFlow('video-wan-snel', WANY, WAN);
  const pr2 = C.prompts.length;
  const z = await S.maakGeheugen({ flow: 'video-zonder-poort', velden: { opdracht: 'x', pod_b: 64, pod_h: 64 }, beeld: beeld(64, 64), beurt_id: nb(), geheim: false, apparaat: 'a', klaar: () => {} }, ctx);
  let zt = null; if (z.taak) await totDat(async () => { zt = S.geheugenTaak(z.taak.id); return !zt; }, 10000);
  toets('B10 videoflow zonder geheugenpoort: niets ingediend', z.status === 200 && C.prompts.length === pr2, { z: z.status, n: C.prompts.length - pr2 });

  // 5. wat niet mag
  r = await roep('/app/imagine/bewerk', { versie: vv.id, stand: 'opknappen', beurt_id: nb() });
  toets('B11 filmpje bewerken: geweigerd', r.status === 409, r);
  r = await roep('/app/imagine/v/' + vv.id + '/snij', { x: 0, y: 0, b: 0.5, h: 0.5, draai: 0 });
  toets('B11 filmpje bijsnijden: geweigerd', r.status === 409, r);
  r = await roep('/app/imagine/bewegen', { versie: vv.id, beurt_id: nb() });
  toets('B11 filmpje opnieuw laten bewegen: geweigerd', r.status === 409, r);
  r = await roep('/app/imagine/bewegen', { versie: v1, model: 'google', beurt_id: nb() });
  toets('B11 onbekende keuze: geweigerd', r.status === 400, r);
  r = await roep('/app/imagine/incognito/bewegen', { beeld: 'x', beurt_id: nb() });
  toets('B12 niet in incognito (geen route)', r.status === 404);
  r = await S.maakGeheugen({ flow: 'video-wan-snel', velden: { opdracht: 'x', pod_b: 64, pod_h: 64 }, beeld: beeld(64, 64), beurt_id: nb(), geheim: true, apparaat: 'a', klaar: () => {} }, ctx);
  toets('B12 motor: geheime videotaak geweigerd', r.status === 409, r);
  r = await S.maak({ flow: 'video-wan-snel', beurt_id: nb(), velden: { opdracht: 'x' } }, ctx);
  toets('B12 Studio-tab: videoflow geweigerd', r.status === 409 && /Imagine/.test(r.fout || ''), r);

  // 6. Immich: beschrijving, geen stapel
  r = await roep('/app/imagine/v/' + vv.id + '/immich', { album: crypto.randomUUID() });
  const up = opgeladen.find((x) => x && x.data);
  toets('B13 Zet in Immich: mp4, beschrijving "Gemaakt met AI (Wan 2.2)", geen stapel', r.status === 200 && up && up.data.subarray(4, 8).toString() === 'ftyp' && up.beschrijving === 'Gemaakt met AI (Wan 2.2)' && opgeladen.indexOf('stapel') < 0, { r: r.status, b: up && up.beschrijving });

  nep.sluit(); I.stopTimers(); S.stopTimers();
  console.log((fouten ? 'ROOD' : 'GROEN') + ' imagine-bewegen: ' + goed + ' groen, ' + fouten + ' rood');
  try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {}
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  onverwacht: ' + (e && e.stack)); process.exit(1); });
