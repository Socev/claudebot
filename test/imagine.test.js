'use strict';
// Toets OVIS Imagine fase 1 (wv2984): gewone stand (laden, bewerken = nieuwe versie, weergave en stukken, weggooien, vingerafdruk bij proef)
// en INCOGNITO (plan § 3.4): beeld met een uniek merk + opdracht met een uniek woord; na Alles wissen, en apart na 60 minuten op een
// schuifbare klok, nul treffers in ALLES wat de pod schrijft (ook uitgepakte .gz) en in de geschiedenis en mappen van de nagebouwde
// ComfyUI; verlopen beeld niet op te vragen; sessie per apparaat; herstartproef (proces gedood midden in een taak).
// Kruisproeven (moeten ROOD): IMAGINE_KRUIS=preview (uitvoer via PreviewImage), =geschiedenis (geen opruiming van de geschiedenis),
// =schijf (incognito-invoer naar schijf). Verzonnen beelden (ruis), raakt de echte ComfyUI en /opt/data niet. Vraagt python3 met Pillow.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), zlib = require('zlib');
const { execFileSync, spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const KRUIS = process.env.IMAGINE_KRUIS || '';
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 15000); while (Date.now() < t) { if (await f()) return true; await slaap(30); } return false; }

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'imagine-toets-'));
const POD = path.join(W, 'pod'), COMFY = path.join(W, 'comfy');
fs.mkdirSync(POD);
// ── modules (kruisproef: een gewijzigde kopie) ──
const MOD = path.join(W, 'mod'); fs.mkdirSync(MOD);
for (const f of ['studio.js', 'studio-beeld.py', 'elevenlabs-credits.js', 'imagine.js']) fs.copyFileSync(path.join(ROOT, f), path.join(MOD, f));
function wijzig(f, oud, nieuw) { const p = path.join(MOD, f); const s = fs.readFileSync(p, 'utf8'); if (s.indexOf(oud) < 0) throw new Error('kruisproef: tekst niet gevonden in ' + f); fs.writeFileSync(p, s.split(oud).join(nieuw)); }
if (KRUIS === 'preview') {
  wijzig('studio.js', "if (t.geheugen && !wsKan(info)) return", "if (false) return");
  wijzig('studio.js', "flowToets(v.api, info, { ws: (!!t.beeld || !!t.geheugen) && wsKan(info) })", "flowToets(v.api, info, { ws: false })");
  wijzig('studio.js', "if (t.geheugen && !(toets.ws_knopen && toets.ws_knopen.length)) return", "if (false) return");
}
if (KRUIS === 'geschiedenis') wijzig('studio.js', "async function histWisNu(pid) {", "async function histWisNu(pid) { return true;");
if (KRUIS === 'schijf') wijzig('imagine.js', "    const id = hex16();\n    s.beelden.set(id,", "    const id = hex16();\n    fs.writeFileSync(path.join(DIR, 'werk-' + id), bytes);\n    s.beelden.set(id,");
// kruisproeven van de diffreview (handmatig): k7a zonder prompt-id vooraf, k7b zonder brontoets in incKlaar, k7c zonder taak vooraf
if (KRUIS === 'kf1') wijzig('imagine.js', "S.geheimNaloop(true).catch(function () {}); }\n  }", "}\n  }");   // Fable MOET 1: vrijgeven bij uit de Map weg
if (KRUIS === 'k7a') wijzig('studio.js', 't.meting.prompt_id = eigenPid;   //', '//');
if (KRUIS === 'k7b') { wijzig('imagine.js', "      if (bronId && !incGeldig(s, bronId)) { b.bytes = null; continue; }\n", ''); wijzig('imagine.js', "    if (bronId && !incGeldig(s, bronId)) { beelden.forEach(function (b) { b.bytes = null; }); s.taken.delete(taakId); return; }\n", ''); }
if (KRUIS === 'k7c') wijzig('imagine.js', "open().prepare('INSERT INTO taak (id, studio, bron, voorganger, stand, status, gemaakt) VALUES (?, NULL, ?, ?, ?, ?, ?)').run(id, v.bron, v.id, s.id, 'wacht', iso());", '');
// wv2990 (handmatig): kt2i = de ronde stopt een tekst-naar-beeldtaak omdat hij geen bron heeft (4t moet rood)
if (KRUIS === 'kt2i') wijzig('imagine.js', "if (t.studio && t.beeld && !s.beelden.has(t.beeld))", "if (t.studio && !s.beelden.has(t.beeld))");
// kt2v = geen vrijgave na een tekst-naar-beeldtaak zonder resultaat (Fable ZOU 1; 4s moet rood)
if (KRUIS === 'kt2v') wijzig('imagine.js', "S.geheimNaloop(true).catch(function () {});\n  }\n  // een verlopen beeld", "}\n  // een verlopen beeld");
const studioMod = require(path.join(MOD, 'studio.js'));
const imagineMod = require(path.join(MOD, 'imagine.js'));

// ── proefbeelden: ruis + een uniek merk in een PNG-tekstblok (verzonnen) ──
function maakBeeld(merk, b, h) {
  const f = path.join(W, 'b-' + crypto.randomBytes(4).toString('hex') + '.png');
  execFileSync('python3', ['-I', '-c', `
import sys, os
from PIL import Image, PngImagePlugin
i = PngImagePlugin.PngInfo(); i.add_text('merk', sys.argv[2])
Image.frombytes('RGB', (int(sys.argv[3]), int(sys.argv[4])), os.urandom(int(sys.argv[3]) * int(sys.argv[4]) * 3)).save(sys.argv[1], pnginfo=i)
`, f, merk, String(b || 160), String(h || 120)]);
  const buf = fs.readFileSync(f); fs.rmSync(f); return buf;
}
// naalden: het merk, het woord, en stukken van het beeld zelf (rauw en als base64 in alle drie de uitlijningen)
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
    let buf = fs.readFileSync(p);
    const lagen = [buf];
    if (p.endsWith('.gz')) { try { lagen.push(zlib.gunzipSync(buf)); } catch (e) {} }
    for (const l of lagen) for (const x of nn) if (l.indexOf(x.b) >= 0) treffers.push(path.relative(W, p) + ':' + x.wat);
  };
  for (const w of wortels) loop(w);
  return treffers;
}

(async function () {
  const nep = await require('./imagine-nep-comfy.js').start(COMFY, { zonderWs: false });
  const C = nep.C;
  let nu = Date.parse('2026-11-13T10:00:00Z');
  const klok = () => nu;
  const STUDIO = path.join(POD, 'studio'), IMAGINE = path.join(POD, 'imagine'), LOG = path.join(POD, 'api.log');
  const zetFlow = (naam, y, api) => { fs.mkdirSync(path.join(STUDIO, 'flows', naam), { recursive: true }); fs.writeFileSync(path.join(STUDIO, 'flows', naam, 'flow.yaml'), JSON.stringify(y)); fs.writeFileSync(path.join(STUDIO, 'flows', naam, 'flow.json'), JSON.stringify(api)); };
  const api = {
    1: { class_type: 'LoadImage', inputs: { image: 'voorbeeld.png', upload: 'image' } },
    2: { class_type: 'PrimitiveStringMultiline', inputs: { value: '' } },
    9: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'foto' } },
  };
  zetFlow('beeld-opdracht-qwen', { titel: 'Vrije opdracht (toets)', motor: 'comfyui', status: 'actief', uitvoer: 'beeld', max_seconden: 5, ai_model: 'Qwen-Image-Edit',
    velden: [{ naam: 'foto', label: 'Foto', soort: 'beeld', pad: '1.inputs.image' }, { naam: 'opdracht', label: 'Opdracht', soort: 'tekstvak', verplicht: true, pad: '2.inputs.value' }] }, api);
  zetFlow('foto-opknappen', { titel: 'Opknappen (toets)', motor: 'comfyui', status: 'proef', uitvoer: 'beeld', max_seconden: 5, ai_model: 'SeedVR2',
    velden: [{ naam: 'foto', label: 'Foto', soort: 'beeld', pad: '1.inputs.image' }] }, { 1: api[1], 9: api[9] });
  // wv2990: tekst naar beeld (verborgen in de Studio, op proef; formaat zet breedte en hoogte)
  zetFlow('beeld-tekst-flux', { titel: 'Beeld uit tekst (toets)', motor: 'comfyui', status: 'proef', verborgen: true, uitvoer: 'beeld', max_seconden: 5, ai_model: 'FLUX.2 klein 4B',
    velden: [{ naam: 'opdracht', label: 'Wat wil je zien?', soort: 'tekstvak', verplicht: true, max: 2000, pad: '2.inputs.value' },
      { naam: 'formaat', label: 'Formaat', soort: 'keuze', standaard: 'vierkant', opties: [{ label: 'vierkant', waarde: 'vierkant', zet: { '1.inputs.width': 64, '1.inputs.height': 64 } },
        { label: 'breed', waarde: 'breed', zet: { '1.inputs.width': 96, '1.inputs.height': 48 } }] },
      { naam: 'seed', label: 'Seed', soort: 'seed', meer: true }] },
    { 1: { class_type: 'EmptyImage', inputs: { width: 32, height: 32, batch_size: 1, color: 0 } }, 2: { class_type: 'PrimitiveStringMultiline', inputs: { value: '' } }, 13: { class_type: 'PreviewImage', inputs: { images: ['1', 0] } } });
  const schrijfLog = (r) => fs.appendFileSync(LOG, r + '\n');
  const maakPod = (extra) => {
    const S = studioMod.maak(Object.assign({ dir: STUDIO, bewaar: () => { throw new Error('Bestanden mag niet'); }, primair: () => true, sleutel: async () => null,
      routerUrl: 'http://127.0.0.1:1', comfyUrl: nep.url, flowstudioUrl: 'http://127.0.0.1:1', taalmodelUrl: null, nu: klok,
      log: schrijfLog, fout: (w, e) => schrijfLog('FOUT ' + w + ': ' + (e && e.message)), merk: path.join(IMAGINE, 'incognito-merk.json'),
      tempo: { poll: 30, wachtStap: 40, wachtMax: 1500, naFree: 10, naloopStart: 0 } }, extra || {}));
    const I = imagineMod.maak({ dir: IMAGINE, studio: S, primair: () => true, nu: klok, log: schrijfLog, fout: (w, e) => schrijfLog('FOUT ' + w + ': ' + (e && e.message)), tempo: { ronde: 3600000 } });
    return { S, I };
  };
  let { S, I } = maakPod();
  const ctxJa = { versOk: () => true, versVerbruik: () => {} }, ctxNee = { versOk: () => false, versVerbruik: () => {} };
  const roep = (pad, body, a, ctx) => I.app({ pad: pad, methode: body === undefined ? 'GET' : 'POST', body: body, apparaat: a || 'apparaat-a', ctx: ctx || ctxJa });
  let bn = 0; const nb = () => 'beurt-' + (++bn) + '-' + crypto.randomBytes(3).toString('hex');
  const invoerLeeg = () => !fs.existsSync(nep.invoerPad) || fs.statSync(nep.invoerPad).size < 200;

  // ── 1. gewone stand ──
  const gewoon = maakBeeld('gewoon-' + crypto.randomBytes(6).toString('hex'));
  let r = await roep('/app/imagine/laad', { data: gewoon.toString('base64'), titel: 'Proef' });
  toets('1 laden: nieuwe bron met versie 1', r.status === 200 && /^[a-f0-9]{16}$/.test(r.body.bron), r);
  const bron = r.body.bron, v1 = r.body.versie;
  r = await roep('/app/imagine');
  toets('1 bibliotheek toont de bron, standen uit de Studio', r.status === 200 && r.body.bronnen.length === 1 && r.body.bronnen[0].versies === 1 && r.body.standen.some((s) => s.id === 'opdracht-qwen' && s.klaar), r.body.standen);
  r = await roep('/app/imagine/bewerk', { versie: v1, stand: 'opknappen', beurt_id: nb() }, 'apparaat-a', ctxNee);
  toets('1 stand op proef zonder verse vingerafdruk: 403 vers_nodig', r.status === 403 && r.body.vers_nodig === true, r);
  r = await roep('/app/imagine/bewerk', { versie: v1, stand: 'opdracht-qwen', velden: { opdracht: 'maak de lucht blauw' }, beurt_id: nb() });
  toets('1 bewerken gestart', r.status === 200 && r.body.taak && r.body.taak.status, r);
  await totDat(async () => (await roep('/app/imagine/bron/' + bron)).body.versies.length === 2, 15000);
  r = await roep('/app/imagine/bron/' + bron);
  const v2 = r.body.versies[1];
  toets('1 nieuwe versie onder dezelfde bron, voorganger = versie 1, model en opdracht bewaard', v2 && v2.voorganger === v1 && v2.nr === 2 && v2.model === 'Qwen-Image-Edit' && v2.opdracht === 'maak de lucht blauw', r.body);
  toets('1 taak klaar met verwijzing naar de versie', r.body.taken[0].status === 'klaar' && r.body.taken[0].versie === v2.id, r.body.taken);
  r = await roep('/app/imagine/v/' + v2.id + '/toon');
  toets('1 weergaveversie is JPEG', r.status === 200 && Buffer.from(r.body.data, 'base64')[0] === 0xff, r.status);
  r = await roep('/app/imagine/v/' + v2.id + '/deel/1');
  toets('1 origineel in stukken = precies het resultaat (echo van de invoer)', r.status === 200 && r.body.delen === 1 && Buffer.from(r.body.data, 'base64').equals(gewoon), r.status);
  toets('1 niets in Bestanden en niets in taken.json van de Studio', !fs.existsSync(path.join(STUDIO, 'taken.json')) || JSON.parse(fs.readFileSync(path.join(STUDIO, 'taken.json'))).taken.length === 0);
  r = await roep('/app/imagine/v/' + v1 + '/weg', {});
  toets('1 het origineel weggooien kan niet', r.status === 409, r);
  r = await roep('/app/imagine/v/' + v2.id + '/weg', {});
  toets('1 een versie weggooien: bestand en weergave weg', r.status === 200 && !fs.existsSync(path.join(IMAGINE, 'toon', v2.id + '.jpg')), r);
  toets('1 geschiedenis van ComfyUI leeg en invoer 1×1 na de gewone taak', Object.keys(C.hist).length === 0 && invoerLeeg(), Object.keys(C.hist));

  // ── 1t. nieuw beeld uit tekst, gewone stand (wv2990) ──
  r = await roep('/app/imagine');
  toets('1t Imagine kent "Nieuw beeld uit tekst" (klaar, velden opdracht en formaat), niet als bewerking', r.body.tekst && r.body.tekst.id === 'tekst' && r.body.tekst.klaar && r.body.tekst.velden.map((v) => v.naam).join() === 'opdracht,formaat'
    && !r.body.standen.some((s) => s.id === 'tekst'), r.body.tekst);
  const fl = await S.flows();
  toets('1t de flow staat niet in de Studio-lijst (verborgen)', fl.flows.some((f) => f.id === 'beeld-opdracht-qwen') && !fl.flows.some((f) => f.id === 'beeld-tekst-flux'), fl.flows.map((f) => f.id));
  r = await roep('/app/imagine/bewerk', { versie: v1, stand: 'tekst', velden: { opdracht: 'x' }, beurt_id: nb() });
  toets('1t tekst-naar-beeld kan niet via /bewerk', r.status === 400, r);
  r = await roep('/app/imagine/nieuw', { velden: { opdracht: '   ' }, beurt_id: nb() });
  toets('1t zonder opdracht: 400', r.status === 400, r);
  r = await roep('/app/imagine/nieuw', { velden: { opdracht: 'x'.repeat(2001) }, beurt_id: nb() });
  toets('1t opdracht langer dan 2000 tekens: 400', r.status === 400, r);
  r = await roep('/app/imagine/nieuw', { velden: { opdracht: 'een vuurtoren' }, beurt_id: nb() }, 'apparaat-a', ctxNee);
  toets('1t op proef zonder verse vingerafdruk: 403 vers_nodig, niets in de rij', r.status === 403 && r.body.vers_nodig === true && !(await roep('/app/imagine')).body.taken.some((t) => t.stand === 'tekst'), r);
  const TG = 'tekstGEWOON' + crypto.randomBytes(6).toString('hex');
  C.t2iBeeld = maakBeeld(TG, 96, 48);
  const up1 = C.uploads, pr1 = C.prompts.length;
  r = await roep('/app/imagine/nieuw', { velden: { opdracht: 'een vuurtoren bij nacht ' + TG, formaat: 'breed' }, beurt_id: nb() });
  toets('1t gestart: taak in de rij zonder bron', r.status === 200 && r.body.taak && r.body.taak.stand === 'tekst' && r.body.taak.bron === '', r);
  const tk = r.body.taak && r.body.taak.id;
  await totDat(async () => (await roep('/app/imagine')).body.taken.some((t) => t.id === tk && t.status === 'klaar'), 15000);
  r = await roep('/app/imagine');
  const tkK = r.body.taken.find((t) => t.id === tk) || {};
  const bt = r.body.bronnen.find((b) => b.id === tkK.bron);
  toets('1t klaar: nieuwe bron "tekst" in de bibliotheek, taak verwijst naar bron en versie', tkK.status === 'klaar' && !!bt && bt.herkomst === 'tekst' && bt.versies === 1 && bt.nieuwste === tkK.versie && /vuurtoren/.test(bt.titel), { tkK, bt });
  r = await roep('/app/imagine/bron/' + tkK.bron);
  const vt = r.body.versies && r.body.versies[0];
  toets('1t versie 1 = het gemaakte beeld: stand tekst, model, opdracht bewaard, geen voorganger', vt && vt.nr === 1 && vt.stand === 'tekst' && vt.voorganger === null && vt.model === 'FLUX.2 klein 4B' && vt.opdracht === 'een vuurtoren bij nacht ' + TG && vt.breed === 96, vt);
  r = await roep('/app/imagine/v/' + tkK.versie + '/deel/1');
  toets('1t origineel = wat ComfyUI over de websocket stuurde', r.status === 200 && Buffer.from(r.body.data, 'base64').equals(C.t2iBeeld), r.status);
  const prT = C.prompts[pr1] || {};
  toets('1t geen upload, formaat gezet (96 × 48), uitvoer via SaveImageWebsocket, geen LoadImage', C.uploads === up1 && prT.prompt && prT.prompt['1'].inputs.width === 96 && prT.prompt['1'].inputs.height === 48
    && prT.prompt['13'].class_type === 'SaveImageWebsocket' && !Object.values(prT.prompt).some((n) => n.class_type === 'LoadImage') || KRUIS === 'preview', prT.prompt);
  toets('1t geschiedenis van ComfyUI leeg', Object.keys(C.hist).length === 0, Object.keys(C.hist));
  r = await roep('/app/imagine/nieuw', { velden: { opdracht: 'een vuurtoren', formaat: 'rond' }, beurt_id: nb() });
  toets('1t onbekend formaat: 400', r.status === 400, r);
  r = await roep('/app/imagine/bewerk', { versie: tkK.versie, stand: 'opdracht-qwen', velden: { opdracht: 'maak het dag' }, beurt_id: nb() });
  await totDat(async () => (await roep('/app/imagine/bron/' + tkK.bron)).body.versies.length === 2, 15000);
  toets('1t het gemaakte beeld is daarna gewoon te bewerken (versie 2)', (await roep('/app/imagine/bron/' + tkK.bron)).body.versies.length === 2);
  C.t2iBeeld = null;

  // ── 2. incognito: laden, bewerken, sessie per apparaat ──
  const M = 'merkINC' + crypto.randomBytes(8).toString('hex'), WOORD = 'woordINC' + crypto.randomBytes(8).toString('hex');
  const inc = maakBeeld(M);
  r = await roep('/app/imagine/incognito/laad', { data: inc.toString('base64') });
  toets('2 incognito laden', r.status === 200 && /^[a-f0-9]{16}$/.test(r.body.beeld), r);
  const ib = r.body.beeld;
  r = await roep('/app/imagine/incognito');
  toets('2 lijst: één beeld, 60 minuten', r.body.beelden.length === 1 && r.body.beelden[0].rest_s === 3600, r.body);
  r = await roep('/app/imagine/incognito', undefined, 'apparaat-b');
  const rb = await roep('/app/imagine/incognito/b/' + ib + '/toon', undefined, 'apparaat-b');
  toets('2 een ander apparaat ziet niets en kan het beeld niet ophalen', r.body.beelden.length === 0 && rb.status === 410, { n: r.body.beelden.length, s: rb.status });
  r = await roep('/app/imagine/incognito/bewerk', { beeld: ib, stand: 'opdracht-qwen', velden: { opdracht: 'zet er ' + WOORD + ' bij' }, beurt_id: nb() });
  toets('2 incognito bewerken gestart', r.status === 200, r);
  await totDat(async () => (await roep('/app/imagine/incognito')).body.beelden.length === 2, 15000);
  r = await roep('/app/imagine/incognito');
  const res = r.body.beelden.find((x) => x.voorganger === ib);
  toets('2 resultaat als tweede incognitobeeld, met opdracht (alleen in het geheugen)', !!res && res.opdracht === true && r.body.taken.length === 0, r.body);
  const prIn = C.prompts[C.prompts.length - 1];
  toets('2 de pod koos zelf de prompt-id (uuid) en de uitvoer ging via SaveImageWebsocket', /^[0-9a-f-]{36}$/.test(String(prIn.prompt_id)) && prIn.prompt['9'].class_type === 'SaveImageWebsocket' || KRUIS === 'preview', prIn.prompt && prIn.prompt['9']);
  r = await roep('/app/imagine/incognito/b/' + res.id + '/toon');
  const toonInc = r.status === 200 ? Buffer.from(r.body.data, 'base64') : Buffer.alloc(0);
  r = await roep('/app/imagine/incognito/b/' + res.id + '/deel/1');
  const uitInc = r.status === 200 ? Buffer.from(r.body.data, 'base64') : Buffer.alloc(0);
  toets('2 resultaat op te halen (weergave en origineel)', toonInc.length > 100 && uitInc.equals(inc), { t: toonInc.length, u: uitInc.length });
  toets('2 Studio-lijst toont de incognitotaak niet', !S.taken().taken.some((t) => t.flow === 'beeld-opdracht-qwen'));
  // 2t (wv2990): nieuw beeld uit tekst in incognito; het beeld van de nep draagt het opdrachtwoord (het zoeken vindt dus ook het resultaat)
  const T2 = 'woordT2I' + crypto.randomBytes(8).toString('hex');
  const t2b = maakBeeld(T2, 64, 64);
  C.t2iBeeld = t2b;
  const nInc = (await roep('/app/imagine/incognito')).body.beelden.length, upI = C.uploads, prI = C.prompts.length;
  r = await roep('/app/imagine/incognito/nieuw', { velden: { opdracht: '   ' }, beurt_id: nb() });
  toets('2t incognito zonder opdracht: 400', r.status === 400, r);
  r = await roep('/app/imagine/incognito/nieuw', { velden: { opdracht: 'teken ' + T2 }, beurt_id: nb() }, 'apparaat-a', ctxNee);
  toets('2t incognito op proef zonder verse vingerafdruk: 403, geen taak', r.status === 403 && (await roep('/app/imagine/incognito')).body.taken.length === 0, r);
  r = await roep('/app/imagine/incognito/nieuw', { velden: { opdracht: 'teken ' + T2 }, beurt_id: nb() });
  toets('2t incognito nieuw beeld gestart', r.status === 200 && /^[a-f0-9]{16}$/.test(r.body.taak), r);
  await totDat(async () => (await roep('/app/imagine/incognito')).body.beelden.length === nInc + 1, 15000);
  r = await roep('/app/imagine/incognito');
  const rt = r.body.beelden.find((x) => x.stand === 'tekst');
  toets('2t resultaat als nieuw incognitobeeld (geen voorganger, stand tekst, opdracht in het geheugen, eigen uur)', !!rt && rt.voorganger === null && rt.opdracht === true && rt.rest_s === 3600 && r.body.taken.length === 0, r.body);
  const prT2 = C.prompts[prI] || {};
  toets('2t eigen prompt-id, geen upload, uitvoer via SaveImageWebsocket', /^[0-9a-f-]{36}$/.test(String(prT2.prompt_id)) && C.uploads === upI && (prT2.prompt && prT2.prompt['13'].class_type === 'SaveImageWebsocket' || KRUIS === 'preview'), prT2.prompt);
  r = await roep('/app/imagine/incognito/b/' + (rt && rt.id) + '/toon');
  const toonT2 = r.status === 200 ? Buffer.from(r.body.data, 'base64') : Buffer.alloc(0);
  r = await roep('/app/imagine/incognito/b/' + (rt && rt.id) + '/deel/1');
  toets('2t resultaat op te halen', toonT2.length > 100 && r.status === 200 && Buffer.from(r.body.data, 'base64').equals(t2b), { t: toonT2.length, s: r.status });
  r = await roep('/app/imagine/incognito', undefined, 'apparaat-b');
  toets('2t een ander apparaat ziet het niet', r.body.beelden.length === 0);
  C.t2iBeeld = null;
  // export van een ANDER beeld (bewust naar de bibliotheek; dat merk mag dus wel op schijf staan)
  const E = 'merkEXP' + crypto.randomBytes(6).toString('hex');
  r = await roep('/app/imagine/incognito/laad', { data: maakBeeld(E).toString('base64') });
  const eb = r.body.beeld;
  r = await roep('/app/imagine/incognito/b/' + eb + '/export', { immich: false, opdracht: false });
  const lijstNa = await roep('/app/imagine/incognito');
  toets('2 exporteren: nieuwe bron "incognito" in de bibliotheek, het beeld is de stand uit', r.status === 200 && (await roep('/app/imagine/bron/' + r.body.bron)).body.bron.herkomst === 'incognito' && !lijstNa.body.beelden.some((x) => x.id === eb), r);
  r = await roep('/app/imagine/incognito/b/' + res.id + '/export', { immich: true });
  toets('2 exporteren naar Immich zonder album: geweigerd', r.status === 400, r);

  // ── 3. Alles wissen ──
  const NN = naalden([M, WOORD, T2], [inc, uitInc, toonInc, t2b, toonT2]);
  r = await roep('/app/imagine/incognito/wis', {});
  toets('3 wissen: gemeten lijstje, alles ok', r.status === 200 && r.body.schoon === true && r.body.stappen.length >= 5 && r.body.stappen.every((x) => x.ok), r.body);
  toets('3 /free gedaan (ook de uitvoercache van ComfyUI)', C.free >= 1, C.free);
  const t3 = zoek([POD, COMFY], NN);
  toets('3 nul treffers voor merk, woord en beeld in alles wat de pod schrijft en in de nep-ComfyUI', t3.length === 0, t3);
  r = await roep('/app/imagine/incognito/b/' + ib + '/toon');
  const r3 = await roep('/app/imagine/incognito');
  toets('3 gewiste beelden niet meer op te vragen, lijst leeg', r.status === 410 && r3.body.beelden.length === 0, { s: r.status, n: r3.body.beelden.length });
  toets('3 merkbestand weg na schoon wissen', !fs.existsSync(path.join(IMAGINE, 'incognito-merk.json')));

  // ── 4. na 60 minuten (schuifbare klok) ──
  const M2 = 'merkUUR' + crypto.randomBytes(8).toString('hex'), W2 = 'woordUUR' + crypto.randomBytes(8).toString('hex');
  const inc2 = maakBeeld(M2);
  r = await roep('/app/imagine/incognito/laad', { data: inc2.toString('base64') });
  const ib2 = r.body.beeld;
  r = await roep('/app/imagine/incognito/bewerk', { beeld: ib2, stand: 'opdracht-qwen', velden: { opdracht: W2 }, beurt_id: nb() });
  await totDat(async () => (await roep('/app/imagine/incognito')).body.beelden.length === 2, 15000);
  nu += 59 * 60000;
  r = await roep('/app/imagine/incognito/b/' + ib2 + '/toon');
  toets('4 na 59 minuten nog op te vragen, rest ± 60 s', r.status === 200 && r.body.rest_s <= 60 && r.body.rest_s > 0, { s: r.status, rest: r.body.rest_s });
  nu += 61 * 1000;
  r = await roep('/app/imagine/incognito/b/' + ib2 + '/toon');
  toets('4 na 60 minuten: 410 bij de aanvraag zelf', r.status === 410, r.status);
  const free4 = C.free;
  r = await roep('/app/imagine/incognito');   // zoals de open app: de lijst haalt het verlopen resultaat weg, niet de ronde (review Fable MOET 1)
  I._ronde();
  const vrij4 = await totDat(() => C.free > free4 && !fs.existsSync(path.join(IMAGINE, 'incognito-merk.json')), 5000);
  r = await roep('/app/imagine/incognito');
  toets('4 verlopen (via de lijst of de ronde): beelden weg, ComfyUI vrijgegeven (/free), merk weg, niets meer te wissen', r.body.beelden.length === 0 && r.body.nog_te_wissen === false && vrij4, { b: r.body, free: C.free - free4 });
  const t4 = zoek([POD, COMFY], naalden([M2, W2], [inc2]));
  toets('4 nul treffers na verlopen', t4.length === 0, t4);

  // 4b (review Fable MOET 1): Wis per beeld na een bewerking geeft ook /free en een leeg merk
  r = await roep('/app/imagine/incognito/laad', { data: maakBeeld('r4b').toString('base64') });
  const b4b = r.body.beeld;
  await roep('/app/imagine/incognito/bewerk', { beeld: b4b, stand: 'opdracht-qwen', velden: { opdracht: 'vier b' }, beurt_id: nb() });
  await totDat(async () => (await roep('/app/imagine/incognito')).body.beelden.length === 2, 15000);
  const free4b = C.free;
  for (const x of (await roep('/app/imagine/incognito')).body.beelden) await roep('/app/imagine/incognito/b/' + x.id + '/weg', {});
  toets('4b Wis per beeld: /free en merk weg', await totDat(() => C.free > free4b && !fs.existsSync(path.join(IMAGINE, 'incognito-merk.json')), 5000), { free: C.free - free4b });
  // 4c (review Fable ZOU 3): mislukte taken tellen niet mee voor de grens van 12
  const sa = I._inc.get('apparaat-a');
  for (let i = 0; i < 12; i++) sa.taken.set('mislukt' + i, { studio: null, beeld: 'x', stand: 'opdracht-qwen', gen: sa.gen, status: 'mislukt', reden: 'proef', eind: nu });
  r = await roep('/app/imagine/incognito/laad', { data: maakBeeld('r4c').toString('base64') });
  toets('4c twaalf mislukte taakregels blokkeren laden niet', r.status === 200, r);
  for (let i = 0; i < 12; i++) sa.taken.delete('mislukt' + i);
  await roep('/app/imagine/incognito/wis', {});
  // 4t (wv2990): de ronde stopt een lopende tekst-naar-beeldtaak NIET (hij heeft geen bron); het resultaat verloopt na 60 minuten
  const W4 = 'woordT2U' + crypto.randomBytes(8).toString('hex');
  const t4b = maakBeeld(W4, 64, 64);
  C.t2iBeeld = t4b; C.draaiWacht = 500;
  const int4 = C.interrupts.length;
  r = await roep('/app/imagine/incognito/nieuw', { velden: { opdracht: W4 }, beurt_id: nb() });
  await totDat(() => C.rij.queue_running.length > 0, 5000);
  I._ronde();
  await totDat(async () => (await roep('/app/imagine/incognito')).body.taken.length === 0, 10000);
  r = await roep('/app/imagine/incognito');
  toets('4t de ronde laat een lopende tekst-naar-beeldtaak met rust; resultaat komt', r.body.beelden.length === 1 && r.body.beelden[0].stand === 'tekst' && C.interrupts.length === int4, { b: r.body.beelden, t: r.body.taken, i: C.interrupts.length - int4 });
  C.draaiWacht = 0; C.t2iBeeld = null;
  const t4id = r.body.beelden[0] && r.body.beelden[0].id;
  nu += 60 * 60000 + 1000;
  const free4t = C.free;
  r = await roep('/app/imagine/incognito/b/' + t4id + '/toon');
  const r4t = await roep('/app/imagine/incognito');
  toets('4t na 60 minuten weg (410), ComfyUI vrijgegeven, merk weg', r.status === 410 && r4t.body.beelden.length === 0
    && await totDat(() => C.free > free4t && !fs.existsSync(path.join(IMAGINE, 'incognito-merk.json')), 5000), { s: r.status, n: r4t.body.beelden.length, free: C.free - free4t });
  const tz4 = zoek([POD, COMFY], naalden([W4], [t4b]));
  toets('4t nul treffers na verlopen (tekst naar beeld)', tz4.length === 0, tz4);
  // 4s (Fable ZOU 1/2): een tekst-naar-beeldtaak gestopt na het indienen (geen beeld in de Map) → toch /free en merk weg
  const W4s = 'woordT2S' + crypto.randomBytes(8).toString('hex');
  C.scenario = 'hang';
  r = await roep('/app/imagine/incognito/nieuw', { velden: { opdracht: W4s }, beurt_id: nb() });
  const tk4s = r.body.taak;
  await totDat(() => !!C.hangt, 5000);
  const free4s = C.free;
  r = await roep('/app/imagine/incognito/stop/' + tk4s, {});
  await totDat(async () => (await roep('/app/imagine/incognito')).body.taken.every((t) => t.status !== 'wacht' && t.status !== 'bezig'), 10000);
  C.scenario = 'goed';
  const vrij4s = await totDat(async () => { await S.geheimNaloop(); return C.free > free4s && !fs.existsSync(path.join(IMAGINE, 'incognito-merk.json')); }, 5000);
  r = await roep('/app/imagine/incognito');
  toets('4s gestopte tekst-naar-beeldtaak: ComfyUI vrijgegeven (/free), merk weg, niets te wissen', vrij4s && r.body.nog_te_wissen === false && r.body.beelden.length === 0, { free: C.free - free4s, b: r.body });
  const tz4s = zoek([POD, COMFY], naalden([W4s], []));
  toets('4s nul treffers op de opdracht', tz4s.length === 0, tz4s);
  await roep('/app/imagine/incognito/wis', {});

  // ── 5. logboeken: alleen de telregel ──
  // 6 incognitotaken: 2, 2t, 4, 4b, 4t, 4s (wv2990)
  const audit = fs.readFileSync(path.join(STUDIO, 'audit.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  const incAudit = audit.filter((x) => x.soort === 'incognito');
  toets('5 audit: per incognitotaak alleen { t, soort, uitkomst, duur_s }', incAudit.length === 6 && incAudit.every((x) => Object.keys(x).sort().join() === 'duur_s,soort,t,uitkomst'), incAudit);
  const logT = fs.readFileSync(LOG, 'utf8');
  toets('5 api.log: incognitoregels zonder flow of taak-id, geen FOUT-regels', /studio incognitotaak uitkomst=klaar duur_s=\d+/.test(logT) && !/FOUT/.test(logT), logT.split('\n').filter((x) => /incognito|FOUT/.test(x)));
  // ingepakt logboek (zoals de rotatie): de zoektocht leest .gz uitgepakt (kruis: een merk in de .gz wordt gevonden)
  fs.writeFileSync(LOG + '.1.gz', zlib.gzipSync(fs.readFileSync(LOG)));
  const proefGz = path.join(W, 'gzproef'); fs.mkdirSync(proefGz); fs.writeFileSync(path.join(proefGz, 'x.gz'), zlib.gzipSync(Buffer.from('aa ' + M + ' bb')));
  toets('5 zoektocht vindt een merk in een ingepakt logboek (de scan zelf werkt)', zoek([proefGz], naalden([M], [])).length === 1);
  fs.rmSync(proefGz, { recursive: true });

  // ── 7. randgevallen uit de diffreview (Codex wv2984) ──
  // 7a (MOET 1): tussen indienen en het antwoord van ComfyUI draait de naloop; de gekozen prompt-id moet in het merk blijven
  C.promptWacht = 400;
  r = await roep('/app/imagine/incognito/laad', { data: maakBeeld('r7a').toString('base64') });
  const b7 = r.body.beeld;
  const p0 = C.prompts.length;
  await roep('/app/imagine/incognito/bewerk', { beeld: b7, stand: 'opdracht-qwen', velden: { opdracht: 'zeven a' }, beurt_id: nb() });
  await totDat(() => C.prompts.length > p0, 5000);
  await S.geheimNaloop();
  const m7 = fs.existsSync(path.join(IMAGINE, 'incognito-merk.json')) ? JSON.parse(fs.readFileSync(path.join(IMAGINE, 'incognito-merk.json'), 'utf8')) : { pids: [] };
  toets('7a naloop tijdens het indienen laat de prompt-id in het merk staan', m7.pids.indexOf(C.prompts[p0].prompt_id) >= 0, { merk: m7, pid: C.prompts[p0] && C.prompts[p0].prompt_id });
  C.promptWacht = 0;
  await totDat(async () => (await roep('/app/imagine/incognito')).body.taken.length === 0, 10000);
  await roep('/app/imagine/incognito/wis', {});
  // 7b (MOET 2): de bron verdwijnt (gewist; verlopen gaat via dezelfde incGeldig) terwijl de bewerking loopt; het resultaat mag niet alsnog
  // met een vers uur verschijnen. (Een klokprong tijdens de taak laat de motor zelf op tijd-uit lopen; daarom de bron wissen.)
  r = await roep('/app/imagine/incognito/laad', { data: maakBeeld('r7b').toString('base64') });
  const b7b = r.body.beeld;
  C.draaiWacht = 500;
  await roep('/app/imagine/incognito/bewerk', { beeld: b7b, stand: 'opdracht-qwen', velden: { opdracht: 'zeven b' }, beurt_id: nb() });
  await totDat(() => C.rij.queue_running.length > 0, 5000);
  await roep('/app/imagine/incognito/b/' + b7b + '/weg', {});
  await totDat(() => C.rij.queue_running.length === 0, 5000);
  await totDat(async () => (await roep('/app/imagine/incognito')).body.taken.length === 0, 5000);
  r = await roep('/app/imagine/incognito');
  toets('7b resultaat van een verdwenen bron valt weg', r.body.beelden.length === 0, r.body.beelden);
  C.draaiWacht = 0;
  await roep('/app/imagine/incognito/wis', {});
  // 7c (MOET 3): weggooien van de bron terwijl de bewerking nog start, wordt geweigerd
  r = await roep('/app/imagine/laad', { data: maakBeeld('r7c').toString('base64') });
  const bron7 = r.body.bron, v7 = r.body.versie;
  const start7 = roep('/app/imagine/bewerk', { versie: v7, stand: 'opdracht-qwen', velden: { opdracht: 'zeven c' }, beurt_id: nb() });
  const weg7 = await roep('/app/imagine/bron/' + bron7 + '/weg', {});
  await start7;
  toets('7c weggooien tijdens het starten van een bewerking: geweigerd (409)', weg7.status === 409, weg7);
  await totDat(async () => (await roep('/app/imagine/bron/' + bron7)).body.taken.every((t) => t.status !== 'wacht' && t.status !== 'bezig'), 10000);

  // ── 6. herstartproef: proces gedood midden in een incognitotaak (6 = bewerking, 6t = tekst naar beeld, wv2990) ──
  const herstart = async (L, t2i) => {
  S.stopTimers(); I.stopTimers();
  const M3 = 'merkHER' + crypto.randomBytes(8).toString('hex'), W3 = 'woordHER' + crypto.randomBytes(8).toString('hex');
  const inc3 = maakBeeld(M3);
  fs.writeFileSync(path.join(W, 'in3.png'), inc3);
  C.scenario = 'hang';
  if (t2i) C.t2iBeeld = maakBeeld(W3, 64, 64);
  const kind = spawn(process.execPath, [path.join(__dirname, 'imagine-kind.js')], { env: Object.assign({}, process.env, { IK_MOD: MOD, IK_POD: POD, IK_COMFY: nep.url, IK_BEELD: path.join(W, 'in3.png'), IK_WOORD: W3, IK_T2I: t2i ? '1' : '' }), stdio: ['ignore', 'pipe', 'inherit'] });
  let kUit = ''; kind.stdout.on('data', (b) => { kUit += b; });
  const hangt = await totDat(() => !!C.hangt, 20000);
  fs.rmSync(path.join(W, 'in3.png'));
  toets(L + ' kind: incognitotaak loopt in de nep-ComfyUI', hangt, kUit);
  const merkVoor = fs.existsSync(path.join(IMAGINE, 'incognito-merk.json')) ? JSON.parse(fs.readFileSync(path.join(IMAGINE, 'incognito-merk.json'), 'utf8')) : null;
  toets(L + ' merk staat vóór het indienen op schijf, alleen prompt-id en free', !!merkVoor && merkVoor.pids.length === 1 && Object.keys(merkVoor).sort().join() === 'free,pids' && merkVoor.pids[0] === (C.hangt && C.hangt.pid), merkVoor);
  kind.kill('SIGKILL');
  await new Promise((r2) => kind.on('exit', r2));
  C.scenario = 'goed';
  ({ S, I } = maakPod());
  r = await roep('/app/imagine/incognito');
  toets(L + ' na de herstart: nog te wissen en de melding "sessie beëindigd door een herstart"', r.body.herstart === true, r.body);
  const schoon = await totDat(async () => { await S.geheimNaloop(); return !S.incognito().nog_te_wissen; }, 10000);
  toets(L + ' naloop: eigen taak onderbroken, geschiedenis weg, invoer 1×1, /free, merk weg', schoon && C.interrupts.some((x) => merkVoor && x.prompt_id === merkVoor.pids[0]) && Object.keys(C.hist).length === 0 && invoerLeeg() && !fs.existsSync(path.join(IMAGINE, 'incognito-merk.json')),
    { schoon, i: C.interrupts, h: Object.keys(C.hist), merk: fs.existsSync(path.join(IMAGINE, 'incognito-merk.json')) });
  const t6 = zoek([POD, COMFY], naalden([M3, W3], [inc3]));
  toets(L + ' nul treffers na de herstart', t6.length === 0, t6);
  r = await roep('/app/imagine/incognito/laad', { data: maakBeeld('x').toString('base64') });
  toets(L + ' daarna weer incognito te gebruiken', r.status === 200, r);
  const tw = await roep('/app/imagine/incognito/wis', {});
  toets(L + ' en weer schoon te wissen', tw.status === 200 && tw.body.schoon === true, tw.body);
  C.t2iBeeld = null;
  };
  await herstart('6', false);
  await herstart('6t', true);

  S.stopTimers(); I.stopTimers(); nep.sluit();
  fs.rmSync(W, { recursive: true, force: true });
  console.log(fouten + ' ROOD, ' + goed + ' GROEN' + (KRUIS ? ' (kruisproef ' + KRUIS + ')' : ''));
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering: ' + (e && e.stack)); process.exit(1); });
