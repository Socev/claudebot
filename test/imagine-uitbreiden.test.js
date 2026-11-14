'use strict';
// wv3044: OVIS Imagine "opdracht uitbreiden" (prompt-upsampling) — knopentoets van de echte flow (fixture, object_info van ComfyUI 0.44) en de
// hele weg tegen de nagebouwde ComfyUI (test/imagine-nep-comfy.js): gewoon en incognito, tekst alleen in het procesgeheugen, nooit in de log,
// imagine.sqlite (tot David hem als opdracht kiest) of ComfyUI's geschiedenis; verlopen na 15 min; alleen hetzelfde apparaat en dezelfde stand;
// telt niet voor de 30 beelden per dag; Studio-weg geweigerd. Kruisproeven (moeten ROOD): IMAGINE_KRUIS=khist (geschiedenis niet gewist),
// =klog (tekst in de log), =kpoort (tekstuitvoer zonder TextGenerate-bron toegestaan), =kwis (geen herhaalde wispoging na afloop), =kstart (wissen tijdens het starten stopt de taak niet). Verzonnen teksten; raakt de echte ComfyUI niet.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const KRUIS = process.env.IMAGINE_KRUIS || '';
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 15000); while (Date.now() < t) { if (await f()) return true; await slaap(30); } return false; }

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'imagine-uitb-'));
const POD = path.join(W, 'pod'), COMFY = path.join(W, 'comfy');
fs.mkdirSync(POD);
const MOD = path.join(W, 'mod'); fs.mkdirSync(MOD);
for (const f of ['studio.js', 'studio-beeld.py', 'elevenlabs-credits.js', 'imagine.js']) fs.copyFileSync(path.join(ROOT, f), path.join(MOD, f));
function wijzig(f, oud, nieuw) { const p = path.join(MOD, f); const s = fs.readFileSync(p, 'utf8'); if (s.indexOf(oud) < 0) throw new Error('kruisproef: tekst niet gevonden in ' + f); fs.writeFileSync(p, s.split(oud).join(nieuw)); }
if (KRUIS === 'khist') wijzig('studio.js', 'async function histWisNu(pid) {', 'async function histWisNu(pid) { return true;');
if (KRUIS === 'klog') wijzig('imagine.js', "if (t) { x.status = 'klaar'; x.tekst = t; }", "if (t) { x.status = 'klaar'; x.tekst = t; log('imagine uitbreiden tekst=' + t); }");
if (KRUIS === 'kwis') wijzig('studio.js', 'if (pid && tekstModus) { for (let i = 0; i < 60; i++)', 'if (false) { for (let i = 0; i < 60; i++)');
if (KRUIS === 'kstart') wijzig('imagine.js', "      try { S.stopGeheugen(r.taak.id, geheim ? a : undefined); } catch (e) {}\n      x.tekst = null;", "      x.tekst = null;");
if (KRUIS === 'kpoort') wijzig('studio.js', '|| !Object.hasOwn(api, sr[0]) || !api[sr[0]] || KNOPEN.tekst_bron.indexOf(api[sr[0]].class_type) < 0)', '|| !Object.hasOwn(api, sr[0]) || !api[sr[0]])');
const studioMod = require(path.join(MOD, 'studio.js'));
const imagineMod = require(path.join(MOD, 'imagine.js'));

function zoek(wortels, teksten) {
  const nn = teksten.map((t) => Buffer.from(t)), treffers = [];
  const loop = (p) => {
    let st; try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isDirectory()) { for (const k of fs.readdirSync(p)) loop(path.join(p, k)); return; }
    if (!st.isFile()) return;
    const buf = fs.readFileSync(p), lagen = [buf];
    if (p.endsWith('.gz')) { try { lagen.push(zlib.gunzipSync(buf)); } catch (e) {} }
    for (const l of lagen) nn.forEach((x, i) => { if (l.indexOf(x) >= 0) treffers.push(path.relative(W, p) + ':' + i); });
  };
  for (const w of wortels) loop(w);
  return treffers;
}

(async function () {
  // ── U. knopentoets van de echte flow (fixture = mk-scripts/ovis-imagine/upsampling/maak-flow.py) ──
  const F = path.join(__dirname, 'fixtures', 'imagine-uitbreiden');
  const oi = JSON.parse(fs.readFileSync(path.join(F, 'object_info.json'), 'utf8'));
  const flow = JSON.parse(fs.readFileSync(path.join(F, 'opdracht-uitbreiden.json'), 'utf8'));
  const yml = JSON.parse(fs.readFileSync(path.join(F, 'opdracht-uitbreiden.yaml'), 'utf8'));
  let r = studioMod.flowToets(flow, oi, { geheugen: true, tekst: true });
  toets('U1 opdracht-uitbreiden door de knopentoets van een tekst-geheugentaak, één tekstknoop', !r.fout && r.tekst_knopen && r.tekst_knopen.join() === '6', r.fout);
  toets('U1 wat ComfyUI krijgt: precies één uitvoerknoop (PreviewAny op TextGenerateV2 uitgang 0), LoRA = Davids bestand, sterkte 1',
    r.prompt && Object.values(r.prompt).filter((n) => oi[n.class_type] && oi[n.class_type].output_node).length === 1 && JSON.stringify(r.prompt['6'].inputs) === '{"source":["5",0]}'
    && r.prompt['2'].inputs['loras.0.lora_name'] === 'qwen35-9b-hauhaucs_uncensored_lora_rank4_fp32.safetensors' && r.prompt['2'].inputs['loras.0.strength'] === 1, r.prompt);
  toets('U1 flow.yaml: uitvoer tekst, verborgen, actief (geen tweede vingerafdruk), opdracht max 2000', yml.uitvoer === 'tekst' && yml.verborgen === true && yml.status === 'actief' && yml.velden[0].max === 2000);
  r = studioMod.flowToets(flow, oi, { geheugen: true });
  toets('U2 zonder tekstmodus (beeld-geheugentaak): PreviewAny geweigerd', !!r.fout && /PreviewAny/.test(r.fout), r);
  r = studioMod.flowToets(flow, oi, { geheugen: true, tekst: true, ws: true });
  toets('U2 tekst + beelduitvoer tegelijk: geweigerd', !!r.fout, r);
  const kopie = () => JSON.parse(JSON.stringify(flow));
  let k = kopie(); k['6'].inputs.source = ['3', 0];
  r = studioMod.flowToets(k, oi, { geheugen: true, tekst: true });
  toets('U3 PreviewAny op iets anders dan de gemaakte tekst (de opdracht zelf): geweigerd', !!r.fout && /tekstuitvoer/.test(r.fout), r);
  k = kopie(); k['6'].inputs.source = ['5', 1];
  r = studioMod.flowToets(k, oi, { geheugen: true, tekst: true });
  toets('U3 PreviewAny op uitgang 1 (thinking): geweigerd', !!r.fout, r);
  k = kopie(); k['7'] = { class_type: 'PreviewAny', inputs: { source: ['5', 0] } };
  r = studioMod.flowToets(k, oi, { geheugen: true, tekst: true });
  toets('U4 twee tekstuitvoeren: geweigerd', !!r.fout && /precies één/.test(r.fout), r);
  k = kopie(); k['7'] = { class_type: 'SaveText', inputs: { text: ['5', 0], filename_prefix: 'x', format: 'txt' } };
  r = studioMod.flowToets(k, oi, { geheugen: true, tekst: true });
  toets('U4 SaveText erbij (schrijft naar schijf): geweigerd', !!r.fout, r);
  k = kopie(); k['2'].inputs['loras.0.lora_name'] = 'ander.safetensors';
  r = studioMod.flowToets(k, oi, { geheugen: true, tekst: true });
  toets('U5 onbekende LoRA: geweigerd (keuzelijst)', !!r.fout && /keuzelijst/.test(r.fout), r);
  k = kopie(); k['2'].inputs['loras.20.lora_name'] = flow['2'].inputs['loras.0.lora_name'];
  r = studioMod.flowToets(k, oi, { geheugen: true, tekst: true });
  toets('U5 LoRA-rij 20 (max 20 rijen): geweigerd', !!r.fout, r);
  k = kopie(); k['2'].inputs['loras.0.pad'] = '/etc/passwd';
  r = studioMod.flowToets(k, oi, { geheugen: true, tekst: true });
  toets('U5 onbekend LoRA-veld: geweigerd', !!r.fout, r);
  k = kopie(); k['2'].inputs['loras.0.strength'] = 'veel';
  r = studioMod.flowToets(k, oi, { geheugen: true, tekst: true });
  toets('U5 LoRA-sterkte geen getal: geweigerd', !!r.fout, r);

  // ── pod tegen de nagebouwde ComfyUI ──
  const nep = await require('./imagine-nep-comfy.js').start(COMFY, {});
  const C = nep.C;
  let nu = Date.parse('2026-11-14T10:00:00Z');
  const klok = () => nu;
  const STUDIO = path.join(POD, 'studio'), IMAGINE = path.join(POD, 'imagine'), LOG = path.join(POD, 'api.log');
  const zetFlow = (naam, y, api) => { fs.mkdirSync(path.join(STUDIO, 'flows', naam), { recursive: true }); fs.writeFileSync(path.join(STUDIO, 'flows', naam, 'flow.yaml'), JSON.stringify(y)); fs.writeFileSync(path.join(STUDIO, 'flows', naam, 'flow.json'), JSON.stringify(api)); };
  // de echte flow, alleen de geheugenpoort uit (de nep kent geen taalmodel op Olares) en kortere tijdgrens
  zetFlow('opdracht-uitbreiden', Object.assign({}, yml, { zonder_taalmodel: false, ram_mib_schatting: 0, max_seconden: 5 }), flow);
  const mossApi = { 1: { class_type: 'EmptyImage', inputs: { width: 32, height: 32, batch_size: 1, color: 0 } }, 4: { class_type: 'PrimitiveStringMultiline', inputs: { value: '' } }, 14: { class_type: 'PreviewImage', inputs: { images: ['1', 0] } } };
  zetFlow('beeld-tekst-moss', { titel: 'MOSS (toets)', motor: 'comfyui', status: 'actief', verborgen: true, uitvoer: 'beeld', max_seconden: 5, ai_model: 'MOSS-Image',
    velden: [{ naam: 'opdracht', label: 'Wat wil je zien?', soort: 'tekstvak', verplicht: true, max: 2000, pad: '4.inputs.value' }, { naam: 'seed', label: 'Seed', soort: 'seed', meer: true }] }, mossApi);
  zetFlow('beeld-tekst-flux', { titel: 'FLUX (toets)', motor: 'comfyui', status: 'actief', verborgen: true, uitvoer: 'beeld', max_seconden: 5, ai_model: 'FLUX.2 klein 4B',
    velden: [{ naam: 'opdracht', label: 'Wat wil je zien?', soort: 'tekstvak', verplicht: true, max: 2000, pad: '4.inputs.value' }] }, mossApi);
  const schrijfLog = (x) => fs.appendFileSync(LOG, x + '\n');
  const S = studioMod.maak({ dir: STUDIO, bewaar: () => { throw new Error('Bestanden mag niet'); }, primair: () => true, sleutel: async () => null,
    routerUrl: 'http://127.0.0.1:1', comfyUrl: nep.url, flowstudioUrl: 'http://127.0.0.1:1', taalmodelUrl: null, nu: klok,
    log: schrijfLog, fout: (w, e) => schrijfLog('FOUT ' + w + ': ' + (e && e.message)), merk: path.join(IMAGINE, 'incognito-merk.json'),
    tempo: { poll: 30, wachtStap: 40, wachtMax: 1500, naFree: 10, naloopStart: 0 } });
  const I = imagineMod.maak({ dir: IMAGINE, studio: S, primair: () => true, nu: klok, log: schrijfLog, fout: (w, e) => schrijfLog('FOUT ' + w + ': ' + (e && e.message)), tempo: { ronde: 3600000 } });
  const ctx = { versOk: () => true, versVerbruik: () => {} };
  const roep = (pad, body, a) => I.app({ pad: pad, methode: body === undefined ? 'GET' : 'POST', body: body, apparaat: a || 'apparaat-a', ctx: ctx });
  let bn = 0; const nb = () => 'beurt-' + (++bn) + '-' + crypto.randomBytes(3).toString('hex');
  const wachtKlaar = async (pre, id, a) => { let u = null; await totDat(async () => { const x = await roep(pre + id, undefined, a); u = x.body.uitbreiding; return x.status !== 200 || (u && u.status !== 'wacht' && u.status !== 'bezig'); }, 15000); return u; };

  // 1. gewone stand
  r = await roep('/app/imagine');
  toets('1 GET /app/imagine: uitbreiden klaar, standaard uit', r.body.uitbreiden && r.body.uitbreiden.klaar === true && r.body.uitbreiden.standaard === false, r.body.uitbreiden);
  const WOORD = 'vosEIGEN' + crypto.randomBytes(6).toString('hex');
  C.uitTekst = 'A detailed oil painting caption UITGEBREIDmerk' + crypto.randomBytes(6).toString('hex') + ' about ';
  const UIT = C.uitTekst.trim().split(' ').find((w) => /^UITGEBREIDmerk/.test(w));
  C.t2iBeeld = require('child_process').execFileSync('python3', ['-I', '-c', "import sys, io, os\nfrom PIL import Image\nu = io.BytesIO(); Image.frombytes('RGB', (64, 48), os.urandom(64 * 48 * 3)).save(u, 'PNG'); sys.stdout.buffer.write(u.getvalue())"]);
  const dag0 = S.teller().vandaag, pr0 = C.prompts.length;
  r = await roep('/app/imagine/uitbreiden', { opdracht: 'een rode vos ' + WOORD, beurt_id: nb() });
  toets('1 uitbreiden gestart: id', r.status === 200 && /^[a-f0-9]{16}$/.test(r.body.uitbreiding), r);
  const u1 = r.body.uitbreiding;
  let u = await wachtKlaar('/app/imagine/uitbreiden/', u1);
  toets('1 klaar: uitgebreide tekst = antwoord van het model', u && u.status === 'klaar' && u.tekst === (C.uitTekst + 'een rode vos ' + WOORD).trim(), u);
  const pr = C.prompts[pr0] || {};
  toets('1 ComfyUI kreeg de uitbreidflow met de opdracht, PreviewAny alleen op de tekst, eigen prompt-id niet nodig', pr.prompt && pr.prompt['3'].inputs.value === 'een rode vos ' + WOORD && pr.prompt['6'].class_type === 'PreviewAny'
    && Number.isSafeInteger(pr.prompt['5'].inputs['sampling_mode.seed']), pr.prompt && Object.keys(pr.prompt));
  toets('1 geschiedenis van ComfyUI leeg na uitbreiden (de tekst stond erin)', await totDat(() => Object.keys(C.hist).length === 0, 3000), Object.keys(C.hist));
  toets('1 telt niet voor de 30 beelden per dag', S.teller().vandaag === dag0, S.teller());
  let t1 = zoek([POD, COMFY], [UIT, WOORD]);
  toets('1 tekst en eigen woord nergens op schijf (log, imagine.sqlite, studio, nep-ComfyUI)', t1.length === 0, t1);
  toets('1 logregels zonder inhoud', /imagine uitbreiden klaar taak=[a-f0-9]{16} uitkomst=klaar/.test(fs.readFileSync(LOG, 'utf8')));
  r = await roep('/app/imagine/uitbreiden/' + u1, undefined, 'apparaat-b');
  toets('1 ander apparaat: 404', r.status === 404, r);
  r = await roep('/app/imagine/incognito/uitbreiden/' + u1);
  toets('1 via de incognito-route: 404 (andere stand)', r.status === 404, r);
  r = await roep('/app/imagine/nieuw', { velden: { opdracht: u.tekst }, model: 'onbekend', uitbreiding: u1, beurt_id: nb() });
  toets('1 geweigerde start (onbekend model): de uitbreiding blijft staan voor opnieuw', r.status === 400 && (await roep('/app/imagine/uitbreiden/' + u1)).status === 200, r);
  r = await roep('/app/imagine/nieuw', { velden: { opdracht: u.tekst }, uitbreiding: u1, beurt_id: nb() });
  toets('1 nieuw beeld met de uitgebreide tekst gestart', r.status === 200 && r.body.taak, r);
  const tk = r.body.taak && r.body.taak.id;
  await totDat(async () => (await roep('/app/imagine')).body.taken.some((t) => t.id === tk && t.status === 'klaar'), 15000);
  r = await roep('/app/imagine');
  const tkK = r.body.taken.find((t) => t.id === tk) || {}, bt = r.body.bronnen.find((b) => b.id === tkK.bron);
  toets('1 titel uit Davids eigen tekst, niet uit de uitgebreide', bt && /rode vos/.test(bt.titel) && !/UITGEBREID/.test(bt.titel), bt);
  const vb = bt ? (await roep('/app/imagine/bron/' + bt.id)).body.versies[0] : null;
  toets('1 bij de versie staat de opdracht die het model kreeg (de uitgebreide)', vb && vb.opdracht === u.tekst, vb);
  r = await roep('/app/imagine/uitbreiden/' + u1);
  toets('1 gebruikte uitbreiding weg uit het geheugen (404)', r.status === 404, r);
  // 1w (echte proef 14-11): de prompt staat na execution_success nog even in de rij; de regel (met de tekst) moet toch meteen weg, zonder minuutronde
  C.naRij = 600;
  r = await roep('/app/imagine/uitbreiden', { opdracht: 'een das ' + WOORD, beurt_id: nb() });
  const uw = r.body.uitbreiding;
  u = await wachtKlaar('/app/imagine/uitbreiden/', uw);
  await totDat(() => !S.teller().bezig, 20000);
  await slaap(1000);   // langer dan naRij: een regel die nog zou komen, staat er dan
  toets('1w prompt nog in de rij na afloop: geschiedenis toch leeg zodra de taak vrij is (zonder minuutronde)', u && u.status === 'klaar' && Object.keys(C.hist).length === 0, { u: u && u.status, h: Object.keys(C.hist) });
  C.naRij = 0;
  await roep('/app/imagine/uitbreiden/' + uw + '/weg', {});
  // weggooien en stoppen
  r = await roep('/app/imagine/uitbreiden', { opdracht: 'een kat', beurt_id: nb() });
  const u2 = r.body.uitbreiding;
  await wachtKlaar('/app/imagine/uitbreiden/', u2);
  r = await roep('/app/imagine/uitbreiden/' + u2 + '/weg', {});
  toets('1 eigen tekst gekozen: weg = 200, daarna 404', r.status === 200 && (await roep('/app/imagine/uitbreiden/' + u2)).status === 404, r);
  C.scenario = 'hang';
  r = await roep('/app/imagine/uitbreiden', { opdracht: 'een hond', beurt_id: nb() });
  const u3 = r.body.uitbreiding;
  await totDat(() => !!C.hangt, 5000);
  r = await roep('/app/imagine/uitbreiden/' + u3 + '/weg', {});
  toets('1 stoppen tijdens het uitbreiden: 200 en ComfyUI onderbroken', r.status === 200 && await totDat(() => C.interrupts.length > 0, 5000), { r, i: C.interrupts.length });
  C.scenario = 'goed';
  await totDat(() => !S.teller().bezig, 5000);
  // de regel van een gestopte taak komt pas ná het onderbreken; studio.js wist hem dan in de minuutronde (vrijRonde → histRonde)
  await slaap(150); await S._vrijRonde();
  toets('1 na stoppen: geschiedenis leeg (na de minuutronde)', await totDat(() => Object.keys(C.hist).length === 0, 5000), Object.keys(C.hist));
  // grens tegelijk
  C.scenario = 'hang';
  const a1 = await roep('/app/imagine/uitbreiden', { opdracht: 'een', beurt_id: nb() }, 'apparaat-c');
  const a2 = await roep('/app/imagine/uitbreiden', { opdracht: 'twee', beurt_id: nb() }, 'apparaat-c');
  const a3 = await roep('/app/imagine/uitbreiden', { opdracht: 'drie', beurt_id: nb() }, 'apparaat-c');
  toets('1 hooguit 2 tegelijk per apparaat: derde 429', a1.status === 200 && a2.status === 200 && a3.status === 429, [a1.status, a2.status, a3.status]);
  await roep('/app/imagine/uitbreiden/' + a2.body.uitbreiding + '/weg', {}, 'apparaat-c');
  await roep('/app/imagine/uitbreiden/' + a1.body.uitbreiding + '/weg', {}, 'apparaat-c');
  C.scenario = 'goed';
  await totDat(() => !S.teller().bezig && !C.hangt, 5000);
  // verlopen
  r = await roep('/app/imagine/uitbreiden', { opdracht: 'een uil', beurt_id: nb() });
  const u4 = r.body.uitbreiding;
  await wachtKlaar('/app/imagine/uitbreiden/', u4);
  nu += 16 * 60 * 1000;
  r = await roep('/app/imagine/uitbreiden/' + u4);
  toets('1 na 15 min verlopen (404)', r.status === 404, r);
  r = await roep('/app/imagine/uitbreiden', { opdracht: '   ', beurt_id: nb() });
  toets('1 lege opdracht: 400', r.status === 400, r);
  r = await S.maak({ flow: 'opdracht-uitbreiden', velden: { opdracht: 'x' }, beurt_id: nb() }, ctx);
  toets('1 Studio-weg voor de uitbreidflow geweigerd (409)', r.status === 409, r);

  // 2. incognito
  const IW = 'uilINC' + crypto.randomBytes(6).toString('hex');
  C.uitTekst = 'Incognito caption UITINCmerk' + crypto.randomBytes(6).toString('hex') + ' with ';
  const UITI = C.uitTekst.split(' ').find((w) => /^UITINCmerk/.test(w));
  const logVoor = fs.readFileSync(LOG, 'utf8').split('\n').length;
  r = await roep('/app/imagine/incognito/uitbreiden', { opdracht: 'een uil in de nacht ' + IW, beurt_id: nb() });
  toets('2 incognito uitbreiden gestart', r.status === 200 && /^[a-f0-9]{16}$/.test(r.body.uitbreiding), r);
  const ui1 = r.body.uitbreiding;
  u = await wachtKlaar('/app/imagine/incognito/uitbreiden/', ui1);
  toets('2 klaar met tekst', u && u.status === 'klaar' && u.tekst.indexOf(UITI) >= 0 && u.tekst.indexOf(IW) >= 0, u);
  toets('2 via de gewone route niet te lezen (404)', (await roep('/app/imagine/uitbreiden/' + ui1)).status === 404);
  const nieuweLog = fs.readFileSync(LOG, 'utf8').split('\n').slice(logVoor - 1).filter(Boolean);
  toets('2 log: alleen de telregel van studio.js (geen id, geen flow)', nieuweLog.every((l) => /^studio incognitotaak uitkomst=klaar duur_s=\d+$/.test(l)) && nieuweLog.length >= 1, nieuweLog);
  toets('2 merk van de geheime taak gezet (naloop ruimt op)', fs.existsSync(path.join(IMAGINE, 'incognito-merk.json')));
  r = await roep('/app/imagine/incognito/wis', {});
  toets('2 Alles wissen: schoon', r.status === 200 && r.body.schoon === true, r);
  toets('2 na wissen: uitbreiding weg (404)', (await roep('/app/imagine/incognito/uitbreiden/' + ui1)).status === 404);
  const t2 = zoek([POD, COMFY], [UITI, IW]);
  toets('2 nul treffers voor tekst en woord in alles wat de pod schrijft en in de nep-ComfyUI', t2.length === 0, t2);
  // 2r (review MOET 1): Alles wissen terwijl het uitbreiden nog start → de taak mag daarna niet alsnog naar ComfyUI
  const RW = 'raceINC' + crypto.randomBytes(6).toString('hex');
  const prR = C.prompts.length;
  const [ra, rb] = await Promise.all([roep('/app/imagine/incognito/uitbreiden', { opdracht: 'een vleermuis ' + RW, beurt_id: nb() }), roep('/app/imagine/incognito/wis', {})]);
  await slaap(400); await totDat(() => !S.teller().bezig, 5000);
  const naarComfy = C.prompts.slice(prR).filter((x) => JSON.stringify(x).indexOf(RW) >= 0).length;
  toets('2r wissen tijdens het starten: niets alsnog naar ComfyUI, niets in de rij, uitbreiding weg', naarComfy === 0 && S.teller().in_rij === 0 && (ra.status !== 200 || (await roep('/app/imagine/incognito/uitbreiden/' + ra.body.uitbreiding)).status === 404) && rb.status === 200,
    { ra: ra.status, rb: rb.status, naarComfy, rij: S.teller().in_rij });
  // incognito: uitbreiding gebruikt in /incognito/nieuw → weg
  r = await roep('/app/imagine/incognito/uitbreiden', { opdracht: 'een maan', beurt_id: nb() });
  const ui2 = r.body.uitbreiding;
  u = await wachtKlaar('/app/imagine/incognito/uitbreiden/', ui2);
  r = await roep('/app/imagine/incognito/nieuw', { velden: { opdracht: u.tekst }, uitbreiding: ui2, beurt_id: nb() });
  toets('2 incognito nieuw beeld met de uitgebreide tekst; uitbreiding daarna weg', r.status === 200 && (await roep('/app/imagine/incognito/uitbreiden/' + ui2)).status === 404, r);
  await totDat(async () => (await roep('/app/imagine/incognito')).body.beelden.length === 1, 15000);
  r = await roep('/app/imagine/incognito/wis', {});
  toets('2 tweede wissen schoon', r.status === 200 && r.body.schoon === true, r);
  toets('2 geschiedenis van de nep-ComfyUI leeg', Object.keys(C.hist).length === 0, Object.keys(C.hist));

  nep.sluit(); I.stopTimers(); try { S.stop && S.stop(); } catch (e) {}
  console.log(fouten + ' ROOD, ' + goed + ' GROEN');
  try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {}
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering: ' + (e && e.stack)); process.exit(1); });
