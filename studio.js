'use strict';
// studio.js — tab Studio in de Socev-app (wv707, fase 1, 21-10-2026).
// Bouwplan: vault 01_Ontwikkeling/Studio - ComfyUI in de Socev-app (bouwplan 21-10-2026).md (§ 4 ontwerp, § 5 techniek, § 7 veiligheid).
//
// WAAROM. David (21-10): één tab om beeld en geluid te maken: flow kiezen, paar velden, Maak, resultaat in de app. Fase 1 = alleen
// GRATIS motoren; betaalde diensten (ElevenLabs, OpenAI, Gemini via Router) komen in fase 2 met eigen sleutels en plafonds.
//
// MOTOREN (fase 1).
// - router: Olares Router (https://f3395cd5.<olares>/v1). Elk FlowStudio-project dat David publiceert, verschijnt in /v1/models
//   als model "Olares/<project-id>" met een formulier in flowstudio.parameters; Studio toont het vanzelf als flow ("flows toevoegen
//   zonder code" = via FlowStudio). Alleen owned_by Olares (lokaal, gratis); betaalde aanbieders blijven buiten de catalogus. Altijd met
//   de eigen sleutel router_studio_key uit de kluis (gelezen op het moment van de aanroep, nooit gelogd); zonder sleutel staat de flow
//   op "wacht op sleutel" en gaat er niets naar Router. Beeld: POST /v1/images/generations met Prefer: respond-async, pollen op de
//   Location (of /v1/images/generations/<id>), dan outputs[].content_url ophalen. Die vorm komt uit een openbaar voorbeeld
//   (github.com/RonnyPfannschmidt/homelab-images, routerimages.py) en GET-metingen op 21-10; de eerste echte aanroep meet hem.
//   Muziek (mode music_generation, wv736): zelfde vorm op /v1/music/generations (GET /v1/music/generations/<id> bestaat, gemeten
//   22-10); de eerste echte aanroep is de meting.
//   GEHEUGEN (wv736). FlowStudio start per project een motor die veel servergeheugen wil (OpenMOSS en MiniMax: estHostMemMib 49152);
//   is dat er niet, dan faalt de taak pas na precies 10 min met engine_host_mem_unavailable (gemeten 21/22-10). Daarom leest de pod
//   vóór het indienen FlowStudio GET /api/projects/<id> (zonder login, zonder sleutel) en vergelijkt estHostMemMib met MemAvailable
//   uit /proc/meminfo (in de pod = de hele machine). Te weinig en de motor staat op "standby": meteen mislukt, niets naar Router.
//   Kan FlowStudio of meminfo niet gelezen worden, of draait de motor al (status niet standby): niet blokkeren (oude gedrag).
//   ONZEKER: FlowStudio's eigen maat is niet bekend. Zijn veld availableHostMemMib (85.889) is statisch, niet live (MemAvailable was
//   toen 22 GiB); misschien rekent hij met Kubernetes-reserveringen in plaats van MemAvailable. De controle is dus een NOODZAKELIJKE
//   voorwaarde: genoeg MemAvailable garandeert niet dat de motor start, te weinig betekent wel (vrijwel) zeker dat hij niet start.
// - piper: Piper op de pod (/opt/data/piper, stem nl_NL-ronnie-medium, CPU), tekst → WAV. Proefstem, geen GPU.
// - comfyui: rechtstreeks ComfyUI (https://d9ce03380.<olares>), alleen als terugval. Elke flow gaat vóór elk indienen door de
//   knopentoets (KNOPEN hieronder: vaste lijst in de pod, niet in de flow) en /object_info; Save → Preview; de taak wacht als ComfyUI
//   iets anders doet (gedeeld met Davids browser) en onderbreekt alleen zijn eigen prompt_id; /free alleen bij een lege rij.
//
// GRENZEN. 1 taak tegelijk, hooguit 5 in de rij, 30 per dag (Europe/Amsterdam), max_seconden per flow. Een flow op "proef" draait
// alleen met een verse vingerafdruk per keer; Activeer (ook met vingerafdruk) zet hem op actief. Resultaten via de BESTAANDE
// bewaarfunctie van de tab Bestanden (deps.bewaar = appBewaar in server.js: jobmap van 16 hex, b/<n>, meta.json, 30 dagen).
// Per taak één auditregel zonder prompttekst. ComfyUI, FlowStudio en Router worden nooit gestart, gestopt of gewijzigd.
//
// BANDJES (wv743; bouwplan "Bandjes - mini-app voor telefoonbandjes (bouwplan 22-10-2026)" § 5.4). De mini-app Bandjes (bandjes.js)
// gebruikt deze motorlaag: zelfde wachtrij, grenzen, vingerafdruk-regel en Bestanden. Vijf raakpunten: (1) flows met "verborgen": true
// staan niet in de Studio-lijst; (2) een flow met "telefoonversie": true krijgt vóór het bewaren de twee telefoonversies (audio.js; mislukt
// dat, dan wordt het origineel toch bewaard met een noot); (3) een taak kan een `bron` dragen ({ soort: 'bandje', praktijk, bandje,
// versie, tekst_hash, stem }), alleen vanuit de server (derde argument van maak, nooit uit de invoer van de app); (4) het label in
// Bestanden komt dan uit die bron ("tolgaarde · tg-buiten · v3"); (5) deps.naKlaar(taak) na afloop, los en met eigen catch, zodat een
// fout daarin nooit de afronding raakt die de wachtrij vrijgeeft.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const GRENS = { rij: 5, per_dag: 30, tekst_max: 2000, aantal_max: 4, bestand_max: 20 * 1024 * 1024, taken_bewaar_ms: 30 * 86400000 };
const ROUTER_MODELLEN_MS = 60 * 1000;
const OBJECT_INFO_MS = 10 * 60 * 1000;
const COMFY_WACHT_MAX_MS = 30 * 60 * 1000;    // zo lang wacht een taak op een lege ComfyUI-wachtrij / genoeg vrij VRAM
const COMFY_WACHT_STAP_MS = 15 * 1000;
const COMFY_FREE_NA_MS = 10 * 60 * 1000;
const POLL_MS = 3000;
const FS_PROJECT_MS = 60 * 1000;               // cache van FlowStudio /api/projects/<id> (estHostMemMib, status)

// ── ElevenLabs via Olares Router (wv782, fase 2 deel stem, 22-10-2026; bouwplan Studio § 5.4, § 6, § 7) ──
// GEMETEN 22-10 (mk-scripts/elevenlabs/voortgang.md): Router declareert POST /v1/audio/speech en /v1/text-to-speech/<id> NIET voor de
// ElevenLabs-modellen (422 audio_operation_not_supported), maar stuurt POST /v1/text-to-speech/<voice_id>/stream?output_format=… 1-op-1
// door naar api.elevenlabs.io (body { text, model_id }; ElevenLabs-kop character-cost komt terug). Router telt die aanroepen als
// "audio_unmetered" (cost_usd 0): het Router-budget op de sleutel beschermt dus NIET; het plafond hieronder is het enige slot in Socev.
// Eén aanroep per taak (twee = dubbel betalen) in pcm_24000 (op elk ElevenLabs-abonnement; pcm_44100 vraagt Pro); de pod maakt er een
// WAV van en audio.js de telefoonversies. Prijs vooraf = tekens × tarief (bouwplan § 6: $ 0,08 / $ 0,04 per 1.000 tekens, naar boven
// afgerond en als euro geteld, dus ruim); achteraf blijft die schatting staan, met de ElevenLabs-credits erbij (die rekenen anders:
// 12 tekens kostten 5 credits). Nooit automatisch opnieuw; de tekst gaat nooit in een log, audit of meta.
const ELEVEN = {
  modellen: {
    eleven_multilingual_v2: { naam: 'Multilingual v2 (standaard)', eur_per_1000: 0.10 },
    eleven_v3: { naam: 'v3 (expressiever)', eur_per_1000: 0.10 },
    eleven_flash_v2_5: { naam: 'Flash v2.5 (sneller, goedkoper)', eur_per_1000: 0.05 },
  },
  standaard: 'eleven_multilingual_v2',
  formaat: 'pcm_24000', rate: 24000,
  stem_re: /^[A-Za-z0-9]{8,40}$/,
  tarief_bron: 'bouwplan Studio § 6 (prijspagina ElevenLabs 21-10-2026), naar boven afgerond',
};
const PLAFOND_STANDAARD = { elevenlabs: 10 };   // euro per kalendermaand (Europe/Amsterdam); David 22-10: "€ 10 tot ik anders zeg"
function prijsVooraf(tekens, model) {
  const m = ELEVEN.modellen[model] || ELEVEN.modellen[ELEVEN.standaard];
  return Math.max(0.01, Math.ceil(tekens * m.eur_per_1000 / 10) / 100);   // op hele centen naar boven
}
function euro(x) { return '€ ' + (Math.round(x * 100) / 100).toFixed(2).replace('.', ','); }
function pcmNaarWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// ── Knopentoets (bouwplan § 5.3 stap 2, § 7; Fable M2). Vaste lijst IN DE POD: een flow kan zichzelf niet toestaan. ──
// Toegestaan: kern (python_module "nodes" of "comfy_extras.*") minus de weigerlijst, plus custom nodes op naam uit CUSTOM_WIT
// (leeg: David noemt ze zelf). Geweigerd: comfy_api_nodes.* (betaald via Comfy-krediet), alles met file/path/url/download/eval/exec
// e.d. in de naam, de gemeten voorbeelden van 21-10, en elke Save-knoop zonder Preview-tegenhanger (schrijft in ComfyUI's uitvoermap).
const KNOPEN = {
  weiger_naam: ['EvaluateStrings', 'StringEvaluate', 'LoadTextFile', 'SaveTextFile', 'ServerDownloader', 'LoadImageFromUrl', 'ReadJSONFile',
    'VHS_LoadVideoPath', 'VHS_LoadAudio', 'VHS_LoadImagePath', 'VHS_LoadImagesPath', 'VHS_LoadVideoFFmpegPath'],
  weiger_patroon: /(file|path|url|download|upload|eval|exec|shell|script|python|http|request|webhook|socket|subprocess|command|save|write|export)/i,
  // knopen met output_node die wél mogen: ze schrijven alleen in ComfyUI's temp-map (Preview) of tonen tekst (Fable wv707 #1)
  preview_ok: ['PreviewImage', 'PreviewAudio', 'PreviewAny'],
  save_naar_preview: { SaveImage: 'PreviewImage', SaveAudio: 'PreviewAudio' },
  custom_wit: [],
};
function knoopToets(klasse, info) {
  if (typeof klasse !== 'string' || !/^[A-Za-z0-9_+.\- ]{1,120}$/.test(klasse)) return 'ongeldige knoopnaam';
  if (KNOPEN.weiger_naam.indexOf(klasse) >= 0) return 'knoop ' + klasse + ' staat op de weigerlijst';
  if (KNOPEN.weiger_patroon.test(klasse)) return 'knoop ' + klasse + ' kan bestanden, adressen of code raken';
  const k = info && info[klasse];
  if (!k) return 'knoop ' + klasse + ' bestaat niet in deze ComfyUI';
  // elke uitvoerknoop buiten de Preview-lijst schrijft in ComfyUI's uitvoermap (SaveVideo, CheckpointSave, VAESave …)
  if (k.output_node === true && KNOPEN.preview_ok.indexOf(klasse) < 0) return 'knoop ' + klasse + ' schrijft in ComfyUI\'s uitvoermap';
  const mod = String(k.python_module || '');
  if (mod === 'comfy_api_nodes' || mod.indexOf('comfy_api_nodes.') === 0) return 'knoop ' + klasse + ' is een betaalde partnerknoop';
  if (mod === 'nodes' || mod.indexOf('comfy_extras.') === 0) return null;
  if (mod.indexOf('custom_nodes.') === 0 && KNOPEN.custom_wit.indexOf(klasse) >= 0) return null;
  return 'knoop ' + klasse + ' komt uit een pakket buiten de witte lijst (' + mod.slice(0, 60) + ')';
}
// Veldtypen tegen /object_info. Een link ([knoop-id, uitgang]) mag altijd (het type controleert ComfyUI); een waarde moet passen.
function veldToets(klasse, naam, w, info) {
  const k = info[klasse], inp = k.input || {};
  const spec = (inp.required && inp.required[naam]) || (inp.optional && inp.optional[naam]);
  if (Array.isArray(w) && w.length === 2 && typeof w[0] === 'string' && Number.isInteger(w[1])) return null;   // link
  if (!spec) {
    const basis = naam.split('.')[0];
    const bs = (inp.required && inp.required[basis]) || (inp.optional && inp.optional[basis]);
    if (naam.indexOf('.') > 0 && bs && bs[0] === 'COMFY_DYNAMICCOMBO_V3' && (typeof w !== 'object' || w === null)) return null;
    return 'veld ' + naam + ' bestaat niet bij ' + klasse;
  }
  const t = spec[0], opt = spec[1] || {};
  if (Array.isArray(t)) return t.indexOf(w) >= 0 ? null : 'waarde van ' + naam + ' staat niet in de keuzelijst';
  if (t === 'COMBO' || t === 'COMFY_DYNAMICCOMBO_V3') {
    const o = Array.isArray(opt.options) ? opt.options.map(function (x) { return x && typeof x === 'object' ? x.key : x; }) : null;
    return !o || o.indexOf(w) >= 0 ? null : 'waarde van ' + naam + ' staat niet in de keuzelijst';
  }
  if (t === 'INT') return Number.isInteger(w) ? null : naam + ' moet een geheel getal zijn';
  if (t === 'FLOAT') return typeof w === 'number' && isFinite(w) ? null : naam + ' moet een getal zijn';
  if (t === 'BOOLEAN') return typeof w === 'boolean' ? null : naam + ' moet ja/nee zijn';
  if (t === 'STRING') return typeof w === 'string' && w.length <= 20000 ? null : naam + ' moet tekst zijn';
  return naam + ' (' + String(t).slice(0, 30) + ') kan alleen via een koppeling';
}
// Volledige toets van een API-JSON; herschrijft Save → Preview in de kopie. Geeft { fout } of { prompt }.
function flowToets(api, info) {
  if (!api || typeof api !== 'object' || Array.isArray(api)) return { fout: 'flow.json is geen ComfyUI-API-export' };
  const uit = {};
  const ids = Object.keys(api);
  if (!ids.length || ids.length > 300) return { fout: 'flow.json heeft geen of te veel knopen' };
  for (const id of ids) {
    const n = api[id];
    if (!n || typeof n.class_type !== 'string' || !n.inputs || typeof n.inputs !== 'object') return { fout: 'knoop ' + id + ' is onvolledig' };
    const klasse = KNOPEN.save_naar_preview[n.class_type] || n.class_type;
    const f = knoopToets(klasse, info);
    if (f) return { fout: f };
    const inputs = {};
    for (const naam of Object.keys(n.inputs)) {
      if (KNOPEN.save_naar_preview[n.class_type] && naam === 'filename_prefix') continue;   // Preview kent geen bestandsnaam
      const fv = veldToets(klasse, naam, n.inputs[naam], info);
      if (fv) return { fout: 'knoop ' + id + ': ' + fv };
      inputs[naam] = n.inputs[naam];
    }
    for (const naam of Object.keys(n.inputs)) {
      const w = n.inputs[naam];
      if (Array.isArray(w) && w.length === 2 && typeof w[0] === 'string' && !api[w[0]]) return { fout: 'knoop ' + id + ' verwijst naar een knoop die er niet is' };
    }
    uit[id] = { class_type: klasse, inputs: inputs };
  }
  return { prompt: uit };
}

function hex16() { return crypto.randomBytes(8).toString('hex'); }
// audio.js pas laden als een flow hem nodig heeft (wv743): ontbreekt hij, dan faalt alleen de telefoonversie (zacht), niet Studio
let audioCache = null;
function audioMod() { return audioCache || (audioCache = require('./audio.js')); }
function dagNL(t) { return new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
function schoon(t, max) { return String(t == null ? '' : t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max); }
// Foutteksten van buiten door een filter voor ze in een log of de app komen (sleutelachtige reeksen weg).
function foutTekst(t) {
  return schoon(t, 300).replace(/(Bearer\s+)\S+/gi, '$1[weg]').replace(/\b(sk|rk|key|tok)[-_][A-Za-z0-9_-]{8,}/gi, '[weg]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[weg]');
}
// Vaste FlowStudio-labels in gewone taal; onbekende labels blijven zoals David ze in FlowStudio zette.
const LABEL_NL = { 'Text (User Prompt)': 'Wat wil je zien?', 'Batch generate': 'Aantal', Megapixels: 'Grootte (megapixels)',
  'Negative Prompt (empty = reference default)': 'Wat wil je níet zien? (leeg = standaard)', 'Music description': 'Beschrijving van de muziek',
  Lyrics: 'Songtekst', 'Duration (sec)': 'Duur (seconden)' };
const MUZIEK_DUUR = { min: 5, max: 300 };     // seconden; begrenst de GPU-tijd van één muziektaak (wv736)
const MUZIEK_AANTAL_MAX = 2;                   // 2 × 300 s blijft binnen max_seconden van een muziekflow (Fable wv736 #3)
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/ogg': 'ogg', 'video/mp4': 'mp4', 'video/webm': 'webm' };

function maak(deps) {
  const DIR = deps.dir;
  const FLOWS = path.join(DIR, 'flows');
  const WERK = path.join(DIR, 'werk');
  const TAKEN = path.join(DIR, 'taken.json');
  const AUDIT = path.join(DIR, 'audit.jsonl');
  const ROUTER = String(deps.routerUrl || 'https://f3395cd5.primumnonnocere.olares.com').replace(/\/+$/, '');
  const FLOWSTUDIO = String(deps.flowstudioUrl || 'https://9ff9df3a.primumnonnocere.olares.com').replace(/\/+$/, '');
  const MEMINFO = deps.meminfo || '/proc/meminfo';
  const COMFY = String(deps.comfyUrl || 'https://d9ce03380.primumnonnocere.olares.com').replace(/\/+$/, '');
  const PIPER = deps.piper || { bin: '/opt/data/piper/piper', model: '/opt/data/piper/nl_NL-ronnie-medium.onnx', data: '/opt/data/piper/espeak-ng-data' };
  const doeFetch = deps.fetch || fetch;
  const klok = deps.nu || Date.now;
  const T = Object.assign({ poll: POLL_MS, wachtStap: COMFY_WACHT_STAP_MS, wachtMax: COMFY_WACHT_MAX_MS, fsTimeout: 6000 }, deps.tempo || {});   // tempo: alleen de toets
  const log = deps.log || function () {};
  const fout = deps.fout || function () {};
  const st = { taken: [], rij: [], bezig: null, lokaal: { sleutel: null, flows: {} }, router: { op: 0, modellen: null, fout: null },
    fs: {}, info: { op: 0, d: null }, comfyLaatst: 0, comfyFreeGedaan: true, timer: null };

  // ── opslag ──
  function mkdir(p) { fs.mkdirSync(p, { recursive: true, mode: 0o700 }); }
  function schrijfJson(f, data) { mkdir(path.dirname(f)); const t = f + '.nieuw.' + process.pid; fs.writeFileSync(t, JSON.stringify(data, null, 1), { mode: 0o600 }); fs.renameSync(t, f); }
  function bewaarTaken() {
    const grens = klok() - GRENS.taken_bewaar_ms;
    st.taken = st.taken.filter(function (t) { return Date.parse(t.gemaakt) > grens; }).slice(-300);
    try { schrijfJson(TAKEN, { versie: 1, taken: st.taken }); return true; } catch (e) { fout('studio-taken', e); return false; }
  }
  function audit(o) {
    try { mkdir(DIR); fs.appendFileSync(AUDIT, JSON.stringify(Object.assign({ t: new Date(klok()).toISOString() }, o)) + '\n', { mode: 0o600 }); }
    catch (e) { fout('studio-audit', e); }
  }

  // ── verbruik en plafond (wv782; bouwplan § 5.4 write-ahead, § 6 maandplafond) ──
  // verbruik.jsonl: per betaalde taak eerst 'gereserveerd' (vóór de aanroep, synchroon in maak), daarna 'verrekend' (geleverd),
  // 'geschat' (aanroep gedaan, uitkomst onbekend: telt mee) of 'vrijgegeven' (nooit aangeroepen of door de aanbieder geweigerd: telt niet).
  // De laatste regel per taak telt; een open reservering telt mee. Geen tekst, alleen bedragen.
  const VERBRUIK = path.join(DIR, 'verbruik.jsonl');
  const LIMIETEN = path.join(DIR, 'studio-limieten.json');
  const vb = {};   // taak → { aanbieder, maand, soort, eur, credits }
  (function laadVerbruik() {
    let t = '';
    try { t = fs.readFileSync(VERBRUIK, 'utf8'); } catch (e) { return; }
    t.split('\n').forEach(function (r) {
      if (!r.trim()) return;
      try { const o = JSON.parse(r); if (o && typeof o.taak === 'string' && typeof o.eur === 'number') vb[o.taak] = o; } catch (e) {}
    });
  })();
  function verbruikZet(taak, aanbieder, soort, eur, extra) {
    const o = Object.assign({ t: new Date(klok()).toISOString(), taak: taak, aanbieder: aanbieder, maand: (vb[taak] && vb[taak].maand) || dagNL(klok()).slice(0, 7),
      soort: soort, eur: Math.round(eur * 100) / 100 }, extra || {});
    mkdir(DIR);
    fs.appendFileSync(VERBRUIK, JSON.stringify(o) + '\n', { mode: 0o600 });   // gooit bij een volle schijf: dan geen aanroep
    vb[taak] = o;
    return o;
  }
  function besteed(aanbieder, maand) {
    maand = maand || dagNL(klok()).slice(0, 7);
    let s = 0;
    Object.keys(vb).forEach(function (k) { const o = vb[k]; if (o.aanbieder === aanbieder && o.maand === maand && o.soort !== 'vrijgegeven') s += o.eur; });
    return Math.round(s * 100) / 100;
  }
  function plafond(aanbieder) {
    try {
      const j = JSON.parse(fs.readFileSync(LIMIETEN, 'utf8'));
      const w = Number(j && j[aanbieder]);
      if (isFinite(w) && w >= 0 && w <= 500) return w;
    } catch (e) {}
    return PLAFOND_STANDAARD[aanbieder] || 0;
  }
  (function laad() {
    try {
      const j = JSON.parse(fs.readFileSync(TAKEN, 'utf8'));
      st.taken = Array.isArray(j.taken) ? j.taken : [];
    } catch (e) { st.taken = []; }
    // Na een herstart loopt er niets meer: wat wachtte of bezig was, telt als onderbroken (nooit vanzelf opnieuw).
    let n = 0;
    st.taken.forEach(function (t) {
      if (t.status === 'wacht' || t.status === 'bezig') { t.status = 'onderbroken'; t.reden = 'de pod herstartte tijdens deze taak'; t.eind = new Date(klok()).toISOString(); n++; }
    });
    if (n) bewaarTaken();
    try { fs.rmSync(WERK, { recursive: true, force: true }); } catch (e) {}
    // wv782: open reserveringen na een herstart afsluiten. Was de aanbieder al aangeroepen, dan 'geschat' (telt mee, want misschien
    // geleverd en betaald); anders 'vrijgegeven'.
    Object.keys(vb).forEach(function (k) {
      if (vb[k].soort !== 'gereserveerd') return;
      const t = st.taken.find(function (x) { return x.id === k; });
      try { verbruikZet(k, vb[k].aanbieder, t && t.aangeroepen ? 'geschat' : 'vrijgegeven', t && t.aangeroepen ? vb[k].eur : 0, { na_herstart: true }); }
      catch (e) { fout('studio-verbruik', e); }
    });
  })();

  // ── catalogus: lokale flows (map per flow; flow.yaml in JSON-vorm, want JSON is geldige YAML en de pod heeft geen YAML-lezer) ──
  function lokaleFlows() {
    let namen = [];
    try { namen = fs.readdirSync(FLOWS).filter(function (n) { return /^[a-z0-9][a-z0-9-]{1,40}$/.test(n); }).sort(); } catch (e) { namen = []; }
    // herladen op bestandstijd (§ 5.2, Fable K13): sleutel = namen + mtimes; ongewijzigd = uit het geheugen
    const delen = namen.map(function (n) {
      let a = 0, b = 0;
      try { a = fs.statSync(path.join(FLOWS, n, 'flow.yaml')).mtimeMs; } catch (e) {}
      try { b = fs.statSync(path.join(FLOWS, n, 'flow.json')).mtimeMs; } catch (e) {}
      return n + ':' + a + ':' + b;
    });
    const sleutel = delen.join('|');
    if (st.lokaal.sleutel === sleutel) return st.lokaal.flows;
    const flows = {};
    for (const n of namen) {
      const f = { id: n, bron: 'lokaal', fout: null };
      try {
        const y = JSON.parse(fs.readFileSync(path.join(FLOWS, n, 'flow.yaml'), 'utf8'));
        Object.assign(f, {
          titel: schoon(y.titel, 80) || n, uitleg: schoon(y.uitleg, 300), motor: String(y.motor || ''), status: String(y.status || 'proef'),
          uitvoer: String(y.uitvoer || 'beeld'), velden: Array.isArray(y.velden) ? y.velden : [], prijs: y.prijs || null,
          max_seconden: Math.max(10, Math.min(1800, Number(y.max_seconden) || 600)), gpu_mib_schatting: Math.max(0, Number(y.gpu_mib_schatting) || 0),
          tijd: schoon(y.tijd, 80), max_per_dag: Math.max(0, Math.min(GRENS.per_dag, Number(y.max_per_dag) || 0)),
          verborgen: y.verborgen === true, telefoonversie: y.telefoonversie === true, bandje: y.bandje === true,   // wv743
          stem: /^[a-z0-9]{2,20}:[A-Za-z0-9_.\/-]{1,80}$/.test(String(y.stem || '')) ? String(y.stem) : null,
        });
        if (['comfyui', 'piper', 'elevenlabs'].indexOf(f.motor) < 0) f.fout = 'onbekende motor';
        if (['proef', 'actief', 'uit'].indexOf(f.status) < 0) f.fout = 'onbekende status';
        if (f.motor === 'comfyui') f.api = JSON.parse(fs.readFileSync(path.join(FLOWS, n, 'flow.json'), 'utf8'));
        f.velden = f.velden.map(veldNorm).filter(Boolean);
        if (f.motor === 'elevenlabs') {
          // wv782: betaald. Tarieven en modellen uit de pod (ELEVEN), nooit uit flow.yaml: een flow kan zichzelf niet goedkoper maken.
          f.betaald = true; f.aanbieder = 'elevenlabs'; f.uitvoer = 'geluid';
          f.bestandsnaam = /^[a-z]{2,20}$/.test(String(y.bestandsnaam || '')) ? String(y.bestandsnaam) : 'stem';
          f.velden = f.velden.filter(function (v) { return v.naam !== 'model'; });
          f.velden.push({ naam: 'model', label: 'Model', soort: 'keuze', verplicht: true, meer: true, standaard: ELEVEN.standaard,
            opties: Object.keys(ELEVEN.modellen).map(function (k) { return { label: ELEVEN.modellen[k].naam, waarde: k }; }) });
          const tv = f.velden.find(function (v) { return v.naam === 'tekst'; }), sv = f.velden.find(function (v) { return v.naam === 'stem'; });
          if (!tv || !sv) f.fout = 'een ElevenLabs-flow heeft de velden tekst en stem nodig';
        }
      } catch (e) { f.fout = 'flow.yaml of flow.json onleesbaar'; f.titel = f.titel || n; f.status = 'uit'; }
      flows[n] = f;
    }
    st.lokaal = { sleutel: sleutel, flows: flows };
    return flows;
  }
  // Een veld uit flow.yaml of uit flowstudio.parameters naar één vorm.
  function veldNorm(v) {
    if (!v || typeof v !== 'object') return null;
    const naam = String(v.naam || v.key || '');
    if (!/^[A-Za-z0-9_:.\-]{1,80}$/.test(naam)) return null;
    let soort = String(v.soort || v.type || 'tekst');
    soort = { text: 'tekst', textarea: 'tekstvak', number: 'getal', select: 'keuze', batch: 'aantal', boolean: 'schakel' }[soort] || soort;
    if (['tekst', 'tekstvak', 'getal', 'keuze', 'aantal', 'schakel', 'seed'].indexOf(soort) < 0) return null;
    const o = { naam: naam, label: schoon(v.label || naam, 80), soort: soort, verplicht: v.verplicht === true || v.required === true,
      meer: v.meer === true, standaard: v.standaard !== undefined ? v.standaard : v.default };
    if (soort === 'keuze') {
      const opties = (Array.isArray(v.opties) ? v.opties : Array.isArray(v.options) ? v.options : []).map(function (x) {
        return x && typeof x === 'object' ? { label: schoon(x.label, 60), waarde: x.waarde !== undefined ? x.waarde : x.value } : { label: schoon(x, 60), waarde: x };
      }).filter(function (x) { return ['string', 'number', 'boolean'].indexOf(typeof x.waarde) >= 0; }).slice(0, 40);
      if (!opties.length) return null;
      o.opties = opties;
    }
    if (soort === 'getal') { o.min = isFinite(Number(v.min)) ? Number(v.min) : null; o.max = isFinite(Number(v.max)) ? Number(v.max) : null; o.stap = Number(v.stap) || null; }
    if (soort === 'aantal') { o.min = 1; o.max = GRENS.aantal_max; if (o.standaard == null) o.standaard = 1; }
    if (soort === 'tekst' || soort === 'tekstvak') o.max = Math.min(GRENS.tekst_max, Number(v.max) || GRENS.tekst_max);
    if (v.pad !== undefined) o.pad = (Array.isArray(v.pad) ? v.pad : [v.pad]).map(String).filter(function (p) { return /^[A-Za-z0-9_:]{1,40}\.inputs\.[A-Za-z0-9_.]{1,80}$/.test(p); });
    if (v.associateRole === 'prompt' || v.rol === 'prompt') o.rol = 'prompt';
    return o;
  }

  // ── catalogus: Router (FlowStudio-projecten als model) ──
  // De catalogus (alleen lezen) gaat wél naar Router, ook zonder sleutel; met sleutel gaat die mee (Fable wv707 #13).
  async function routerModellen(vers, sleutel) {
    if (!vers && st.router.modellen && klok() - st.router.op < ROUTER_MODELLEN_MS) return st.router.modellen;
    try {
      const r = await doeFetch(ROUTER + '/v1/models', { redirect: 'manual', headers: sleutel ? { Authorization: 'Bearer ' + sleutel } : {}, signal: AbortSignal.timeout(15000) });
      if (!r.ok) { await r.text().catch(function () {}); throw new Error('Router gaf HTTP ' + r.status); }
      const j = await r.json();
      st.router = { op: klok(), modellen: Array.isArray(j && j.data) ? j.data : [], fout: null };
    } catch (e) {
      st.router.fout = foutTekst(e && e.message || e);
      st.router.op = klok();
      if (!st.router.modellen) st.router.modellen = [];
    }
    return st.router.modellen;
  }
  function routerFlow(m, sleutel, sleutelFout) {
    const id = String(m && m.id || '');
    const mm = /^Olares\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(id);
    if (!mm || m.owned_by !== 'Olares' || !m.flowstudio || !Array.isArray(m.flowstudio.parameters)) return null;
    const mode = String(m.mode || '');
    const uitvoer = mode === 'image_generation' ? 'beeld' : mode === 'music_generation' ? 'muziek' : mode === 'video_generation' ? 'video' : null;
    if (!uitvoer) return null;
    const velden = m.flowstudio.parameters.map(veldNorm).filter(Boolean);
    velden.forEach(function (v) {
      if (LABEL_NL[v.label]) v.label = LABEL_NL[v.label];
      // optionele tekstvelden naast de prompt (zoals de negatieve prompt) onder "Meer": het formulier blijft kort
      if (!v.verplicht && v.rol !== 'prompt' && (v.soort === 'tekst' || v.soort === 'tekstvak')) v.meer = true;
    });
    if (uitvoer === 'muziek') velden.forEach(function (v) {
      // de songtekst hoort bij muziek in beeld (niet onder Meer); de duur begrenst de GPU-tijd
      if (v.naam === 'lyrics' && (v.soort === 'tekst' || v.soort === 'tekstvak')) { v.soort = 'tekstvak'; v.meer = false; }
      if (v.naam === 'max_duration' && v.soort === 'getal') {
        v.min = Math.max(MUZIEK_DUUR.min, v.min == null ? MUZIEK_DUUR.min : v.min); v.max = Math.min(MUZIEK_DUUR.max, v.max == null ? MUZIEK_DUUR.max : v.max);
      }
      if (v.soort === 'aantal') v.max = Math.min(v.max, MUZIEK_AANTAL_MAX);
    });
    if ((m.canonical_fields || []).indexOf('seed') >= 0 && !velden.some(function (v) { return v.naam === 'seed'; }))
      velden.push({ naam: 'seed', label: 'Seed (zelfde getal = zelfde uitkomst)', soort: 'seed', meer: true, standaard: null, verplicht: false });
    let reden = null;
    if (uitvoer === 'video') reden = 'nog niet klaar: de videoroute van Router is nog niet gebouwd';
    else if (m.readiness && m.readiness !== 'ready') reden = 'FlowStudio meldt: ' + schoon(m.readiness, 40);
    else if (sleutelFout) reden = 'de kluis is nu niet bereikbaar; de Router-sleutel kan niet gelezen worden';
    else if (!sleutel) reden = 'wacht op sleutel';
    return { id: 'fs-' + mm[1], project: mm[1], bron: 'router', model: id, titel: schoon(m.name, 80) || id, uitleg: 'FlowStudio-project op Olares', motor: 'router',
      status: 'actief', uitvoer: uitvoer, velden: velden, max_seconden: uitvoer === 'muziek' ? 1200 : 900, gpu_mib_schatting: 0, reden: reden,
      tijd: uitvoer === 'beeld' ? '± 1 min; eerste keer langer' : uitvoer === 'muziek' ? 'enkele minuten; eerste keer langer' : '' };
  }

  // ── geheugencontrole vóór een FlowStudio-taak (wv736; zie de kop) ──
  function vrijGeheugenMib() {
    try {
      const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(fs.readFileSync(MEMINFO, 'utf8'));
      return m ? Math.floor(Number(m[1]) / 1024) : null;
    } catch (e) { return null; }
  }
  // FlowStudio-project lezen: alleen GET, zonder kop (de Router-sleutel gaat nooit naar FlowStudio). Onleesbaar = null (1 min onthouden).
  async function fsProject(pid, vers) {
    const c = st.fs[pid];
    if (!vers && c && klok() - c.op < FS_PROJECT_MS) return c.d;
    let d = null;
    try {
      const r = await doeFetch(FLOWSTUDIO + '/api/projects/' + pid, { redirect: 'manual', signal: AbortSignal.timeout(T.fsTimeout) });
      if (r.ok) {
        const j = await r.json().catch(function () { return null; });   // onbekende /api-paden geven HTML met 200 (gemeten)
        const nodig = j && Number(j.estHostMemMib);
        if (j && j.id === pid && isFinite(nodig) && nodig > 0) d = { nodig_mib: Math.round(nodig), status: schoon(j.status, 30).toLowerCase(),
          lopend: isFinite(Number(j.runningJobCount)) ? Number(j.runningJobCount) : null };
      } else await r.text().catch(function () {});
    } catch (e) { d = null; }
    st.fs[pid] = { op: klok(), d: d };
    return d;
  }
  // Tekort = { nodig_mib, vrij_mib } of null. Alleen als de motor op standby staat: draait hij al, dan zit zijn geheugen al in gebruik
  // en zegt MemAvailable niets meer over deze taak.
  async function geheugenTekort(pid, vers) {
    if (!pid) return null;
    const p = await fsProject(pid, vers);
    if (!p || p.status !== 'standby' || p.lopend > 0) return null;   // loopt er al een taak, dan is de motor warm
    const vrij = vrijGeheugenMib();
    if (vrij == null || vrij >= p.nodig_mib) return null;
    return { nodig_mib: p.nodig_mib, vrij_mib: vrij };
  }
  function geheugenTekst(nodigMib, vrijMib, uitvoer) {
    const gb = function (x) { return Math.round(x / 1024); };
    const nodig = nodigMib > 0 ? nodigMib : 48 * 1024;
    // meldt FlowStudio een tekort terwijl de pod genoeg ziet, dan rekent FlowStudio anders (zie ONZEKER in de kop): beide getallen noemen
    const stand = vrijMib == null ? ' GB nodig)' : vrijMib < nodig ? ' GB nodig, nu ' + gb(vrijMib) + ' GB vrij)'
      : ' GB nodig; FlowStudio meldt een tekort, de pod ziet ' + gb(vrijMib) + ' GB vrij)';
    return 'Olares heeft nu te weinig vrij geheugen voor FlowStudio (± ' + gb(nodig) + stand + (uitvoer === 'beeld' ? '; MOSS-Image rechtstreeks werkt wel' : '');
  }
  // De fout van Router/FlowStudio als het geheugen op is (gemeten 22-10: error als tekst, error_code upstream_capacity_unavailable).
  function isGeheugenFout(j) {
    if (!j || typeof j !== 'object') return false;
    const e = j.error, pr = j.provider_response && typeof j.provider_response === 'object' ? j.provider_response : {};
    const teksten = [j.error_code, pr.error_code, typeof e === 'string' ? e : e && (e.code || e.message), typeof pr.error === 'string' ? pr.error : pr.error && (pr.error.code || pr.error.message)];
    return teksten.some(function (x) { return /engine_host_mem_unavailable|upstream_capacity_unavailable/i.test(String(x || '')); })
      || (e && typeof e === 'object' && /upstream_capacity_unavailable/i.test(String(e.type || '')));
  }
  function flowUit(f) {
    const klaar = !f.fout && !f.reden && f.status !== 'uit';
    return { id: f.id, titel: f.titel, uitleg: f.uitleg || '', motor: f.motor,
      motor_naam: f.motor === 'router' ? 'lokaal · FlowStudio via Router' : f.motor === 'piper' ? 'lokaal · Piper op de pod (CPU)'
        : f.motor === 'elevenlabs' ? 'betaald · ElevenLabs via Router (de tekst gaat naar ElevenLabs, VS)' : 'lokaal · ComfyUI rechtstreeks',
      status: f.status, uitvoer: f.uitvoer, klaar: klaar, reden: f.fout || f.reden || (f.status === 'uit' ? 'staat uit' : null),
      prijs: f.betaald ? 'betaald · ± € 0,10 per 1.000 tekens (Flash € 0,05)' : 'gratis', tijd: f.tijd || '',
      vers_per_keer: f.status === 'proef' || f.betaald === true, bandje: f.bandje === true, stem: f.stem || null,
      betaald: f.betaald === true, aanbieder: f.aanbieder || null,
      prijs_tabel: f.betaald ? Object.keys(ELEVEN.modellen).reduce(function (o, k) { o[k] = ELEVEN.modellen[k].eur_per_1000; return o; }, {}) : null,
      velden: (f.velden || []).map(function (v) { const o = Object.assign({}, v); delete o.pad; return o; }) };
  }
  async function catalogus(vers) {
    let sleutelFout = false;
    const sleutel = await deps.sleutel().catch(function (e) { fout('studio-sleutel', e); sleutelFout = true; return null; });
    const ms = await routerModellen(vers, sleutel);
    const lijst = [];
    ms.forEach(function (m) { const f = routerFlow(m, !!sleutel, sleutelFout); if (f) lijst.push(f); });
    // geheugen: alleen voor flows die verder klaar zijn, zodat de flow in de app niet "klaar" lijkt (FlowStudio-cache 1 min)
    await Promise.all(lijst.filter(function (f) { return !f.reden; }).map(async function (f) {
      const g = await geheugenTekort(f.project, false);
      if (g) { f.reden = geheugenTekst(g.nodig_mib, g.vrij_mib, f.uitvoer); f.geheugen = g; }
    }));
    const lok = lokaleFlows();
    // wv782: een betaalde flow zonder Router-sleutel wacht (kopie: het cache-object van lokaleFlows blijft schoon)
    Object.keys(lok).forEach(function (k) {
      const f = lok[k];
      if (f.betaald && !f.fout && !sleutel) lijst.push(Object.assign({}, f, { reden: sleutelFout ? 'de kluis is nu niet bereikbaar; de Router-sleutel kan niet gelezen worden' : 'wacht op de Router-sleutel (router_studio_key)' }));
      else lijst.push(f);
    });
    return { flows: lijst, sleutel: !!sleutel, router_fout: st.router.fout };
  }

  // ── stand ──
  function vandaagN() { const d = dagNL(klok()); return st.taken.filter(function (t) { return dagNL(Date.parse(t.gemaakt)) === d; }).length; }
  function stand() {
    const maand = dagNL(klok()).slice(0, 7);
    // alleen de tijd tussen indienen en klaar (niet het wachten op een bezette ComfyUI; Fable wv707 #12)
    const gpuS = st.taken.filter(function (t) { return t.gpu_s > 0 && dagNL(Date.parse(t.gemaakt)).slice(0, 7) === maand; })
      .reduce(function (s, t) { return s + t.gpu_s; }, 0);
    return { vandaag: vandaagN(), per_dag: GRENS.per_dag, in_rij: st.rij.length, rij_max: GRENS.rij, bezig: st.bezig ? st.bezig.id : null,
      gpu_minuten_maand: Math.round(gpuS / 6) / 10, kosten_maand: besteed('elevenlabs', maand),
      plafond: { elevenlabs: { plafond_eur: plafond('elevenlabs'), besteed_eur: besteed('elevenlabs', maand), rest_eur: Math.max(0, Math.round((plafond('elevenlabs') - besteed('elevenlabs', maand)) * 100) / 100) } } };
  }
  function taakUit(t) {
    return { id: t.id, flow: t.flow, titel: t.titel, motor: t.motor, uitvoer: t.uitvoer, status: t.status, fase: t.fase || null, procent: t.procent == null ? null : t.procent,
      reden: t.reden || null, gemaakt: t.gemaakt, start: t.start || null, eind: t.eind || null, duur_s: t.duur_s || null, velden: t.velden,
      bestanden: t.bestanden || [], plek_in_rij: t.status === 'wacht' ? st.rij.indexOf(t.id) + 1 : null, meting: t.meting || null,
      bron: t.bron || null, noot: t.noot || null,
      betaald: t.betaald === true, kosten_eur: t.betaald ? (vb[t.id] ? (vb[t.id].soort === 'vrijgegeven' ? 0 : vb[t.id].eur) : t.prijs_vooraf || 0) : 0,
      kosten_staat: t.betaald && vb[t.id] ? vb[t.id].soort : null, credits: t.credits == null ? null : t.credits };
  }

  // ── invoer ──
  function waardenVan(f, invoer) {
    const uit = {};
    invoer = invoer && typeof invoer === 'object' ? invoer : {};
    for (const v of f.velden) {
      let w = invoer[v.naam];
      if (w === undefined || w === null || w === '') w = v.standaard;
      if (v.soort === 'tekst' || v.soort === 'tekstvak') {
        w = schoon(w == null ? '' : w, 20000);
        if (w.length > v.max) return { fout: v.label + ': hooguit ' + v.max + ' tekens' };
        if (v.verplicht && !w.trim()) return { fout: v.label + ' is leeg' };
      } else if (v.soort === 'keuze') {
        const o = v.opties.find(function (x) { return String(x.waarde) === String(w); });
        if (!o) return { fout: v.label + ': kies een van de opties' };
        w = o.waarde;
      } else if (v.soort === 'getal' || v.soort === 'aantal') {
        w = Number(w);
        if (!isFinite(w)) return { fout: v.label + ' moet een getal zijn' };
        if (v.min != null && w < v.min) return { fout: v.label + ': minstens ' + v.min };
        if (v.max != null && w > v.max) return { fout: v.label + ': hooguit ' + v.max };
        if (v.soort === 'aantal') w = Math.round(w);
      } else if (v.soort === 'seed') {
        w = (w === undefined || w === null || w === '') ? crypto.randomInt(0, 2 ** 47) : Number(w);
        if (!Number.isSafeInteger(w) || w < 0) return { fout: 'seed moet een geheel getal ≥ 0 zijn' };
      } else if (v.soort === 'schakel') {
        w = w === true || w === 'true' || w === 1;
      }
      uit[v.naam] = w;
    }
    return { waarden: uit };
  }

  // ── bron van een taak (wv743): alleen deze velden, alleen bekende vormen ──
  function bronNorm(b) {
    if (!b || typeof b !== 'object' || b.soort !== 'bandje') return null;
    const o = { soort: 'bandje', praktijk: String(b.praktijk || ''), bandje: String(b.bandje || ''), versie: Number(b.versie),
      tekst_hash: String(b.tekst_hash || ''), stem: schoon(b.stem, 100) };
    if (b.model && Object.hasOwn(ELEVEN.modellen, String(b.model))) o.model = String(b.model);   // wv782
    if (!/^[a-z]{2,20}$/.test(o.praktijk) || !/^[a-z]{2}-[a-z0-9-]{2,30}$/.test(o.bandje) || !Number.isInteger(o.versie) || o.versie < 0 || !/^[a-f0-9]{8,64}$/.test(o.tekst_hash)) return null;
    return o;
  }
  function bronLabel(b) { return b.praktijk + ' · ' + b.bandje + ' · v' + b.versie; }

  // ── POST /app/studio/maak ──
  // ctx: { versOk(): bool (synchroon), versVerbruik(): void, apparaat }
  // extra: alleen vanuit de server (bandjes, wv743): { bron: { soort: 'bandje', praktijk, bandje, versie, tekst_hash, stem } }
  async function maakTaak(d, ctx, extra) {
    if (!deps.primair()) return { status: 409, fout: 'deze kant van Socev is nu passief; Studio werkt alleen op de actieve kant' };
    const flowId = String(d.flow || '');
    if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(flowId)) return { status: 400, fout: 'onbekende flow' };
    const beurt = String(d.beurt_id || '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(beurt)) return { status: 400, fout: 'beurt_id ontbreekt' };
    const al = st.taken.find(function (t) { return t.beurt_id === beurt; });
    if (al) return { status: 200, taak: taakUit(al), al: true };
    const c = await catalogus(false);
    const f = c.flows.find(function (x) { return x.id === flowId; });
    if (!f) return { status: 404, fout: 'deze flow bestaat niet (meer)' };
    if (f.fout || f.reden || f.status === 'uit') return { status: 409, fout: 'deze flow kan nu niet: ' + (f.fout || f.reden || 'staat uit') };
    const w = waardenVan(f, d.velden);
    if (w.fout) return { status: 400, fout: w.fout };
    // wv782: betaald — stem en model uit de witte lijst, prijs vooraf en plafond (vóór de vingerafdruk: geen vingerafdruk verbruiken
    // voor een taak die toch geweigerd wordt)
    let prijs = 0;
    if (f.betaald) {
      if (!ELEVEN.stem_re.test(String(w.waarden.stem || ''))) return { status: 400, fout: 'onbekende stem (ElevenLabs voice-id)' };
      if (!Object.hasOwn(ELEVEN.modellen, String(w.waarden.model || ''))) return { status: 400, fout: 'onbekend model' };
      const tekst = String(w.waarden.tekst || '').trim();
      if (!tekst) return { status: 400, fout: 'de tekst is leeg' };
      prijs = prijsVooraf(tekst.length, w.waarden.model);
    }
    // vanaf hier synchroon tot de taak in de rij staat (twee tabbladen = niet twee keer dezelfde vingerafdruk)
    if (st.taken.find(function (t) { return t.beurt_id === beurt; })) return { status: 200, taak: taakUit(st.taken.find(function (t) { return t.beurt_id === beurt; })), al: true };
    if (vandaagN() >= GRENS.per_dag) return { status: 429, fout: 'vandaag al ' + GRENS.per_dag + ' taken gemaakt; morgen weer' };
    if (st.rij.length >= GRENS.rij) return { status: 429, fout: 'er staan al ' + GRENS.rij + ' taken in de rij; wacht tot er een klaar is' };
    const flowMax = Number(f.max_per_dag) || 0, dag = dagNL(klok());
    if (flowMax > 0 && st.taken.filter(function (t) { return t.flow === f.id && dagNL(Date.parse(t.gemaakt)) === dag; }).length >= flowMax)
      return { status: 429, fout: 'deze flow heeft vandaag al ' + flowMax + ' taken gehad; morgen weer' };
    if (f.betaald) {
      const pl = plafond(f.aanbieder), al = besteed(f.aanbieder);
      if (al + prijs > pl + 1e-9) return { status: 409, plafond: true, fout: 'het maandplafond voor ElevenLabs (' + euro(pl) + ') is bereikt: deze maand al ' + euro(al) + ', dit bandje kost ± ' + euro(prijs) + '. Vraag Socev om het plafond te verhogen.' };
      if (!ctx.versOk()) return { status: 403, fout: 'betaald (± ' + euro(prijs) + ' bij ElevenLabs): bevestig met je vingerafdruk', vers_nodig: true };
      ctx.versVerbruik();
    } else if (f.status === 'proef') {
      if (!ctx.versOk()) return { status: 403, fout: 'deze flow is nog op proef: bevestig met je vingerafdruk', vers_nodig: true };
      ctx.versVerbruik();
    }
    const t = { id: hex16(), beurt_id: beurt, flow: f.id, titel: f.titel, motor: f.motor, uitvoer: f.uitvoer, status: 'wacht', fase: 'in de rij',
      procent: null, gemaakt: new Date(klok()).toISOString(), velden: w.waarden, bestanden: [], proef: f.status === 'proef', apparaat: ctx.apparaat || null };
    const bron = bronNorm(extra && extra.bron);
    if (bron) t.bron = bron;
    if (f.betaald) {
      // write-ahead: eerst reserveren, dan pas in de rij (lukt het schrijven niet, dan geen taak en dus geen aanroep)
      t.betaald = true; t.aanbieder = f.aanbieder; t.prijs_vooraf = prijs;
      try { verbruikZet(t.id, f.aanbieder, 'gereserveerd', prijs, { model: w.waarden.model, tekens: String(w.waarden.tekst || '').trim().length }); }
      catch (e) { fout('studio-verbruik', e); return { status: 500, fout: 'de reservering kon niet bewaard worden; er is niets aangeroepen' }; }
    }
    st.taken.push(t);
    st.rij.push(t.id);
    bewaarTaken();
    setImmediate(volgende);
    return { status: 200, taak: taakUit(t) };
  }

  // ── wachtrij: één tegelijk ──
  function volgende() {
    if (st.bezig || !st.rij.length) return;
    const id = st.rij.shift();
    const t = st.taken.find(function (x) { return x.id === id; });
    if (!t || t.status !== 'wacht') return setImmediate(volgende);
    const ctl = { gestopt: false, stop: null };
    st.bezig = { id: id, ctl: ctl };
    t.status = 'bezig'; t.start = new Date(klok()).toISOString(); t.fase = 'start';
    bewaarTaken();
    // Eindafhandeling in try/finally: wat er ook gooit (schijf vol, log), st.bezig komt altijd vrij en het proces krijgt nooit een
    // onafgehandelde afwijzing (Fable wv707 #5).
    voer(t, ctl).then(function (r) { return r; }, function (e) { return { fout: foutTekst(e && e.message || e) }; }).then(function (r) { try {
      t.eind = new Date(klok()).toISOString();
      t.duur_s = Math.round((Date.parse(t.eind) - Date.parse(t.start)) / 1000);
      // wv782: geleverd en betaald = afmaken en bewaren, ook als Stop daarna kwam (Fable wv782 #5a)
      if (ctl.gestopt && !(r && r.ok && t.geleverd)) { t.status = 'gestopt'; t.reden = r && r.noot ? r.noot : 'gestopt op je verzoek'; }
      else if (r && r.ok) { t.status = 'klaar'; t.procent = 100; }
      else { t.status = 'mislukt'; t.reden = (r && r.fout) || 'onbekende fout'; }
      t.fase = null;
      try { fs.rmSync(path.join(WERK, t.id), { recursive: true, force: true }); } catch (e) {}
      // wv782: reservering verrekenen. Geleverd = de schatting vooraf (met credits erbij); aanroep gedaan maar uitkomst onbekend =
      // 'geschat' (telt mee); nooit aangeroepen of door de aanbieder geweigerd (HTTP-fout, ElevenLabs rekent die niet) = vrijgegeven.
      if (t.betaald) {
        const soort = t.geleverd ? 'verrekend' : (t.aangeroepen && !t.geweigerd ? 'geschat' : 'vrijgegeven');
        try { verbruikZet(t.id, t.aanbieder, soort, soort === 'vrijgegeven' ? 0 : t.prijs_vooraf, t.credits != null ? { credits: t.credits } : null); }
        catch (e) { fout('studio-verbruik', e); }
      }
      audit({ taak: t.id, flow: t.flow, motor: t.motor, uitkomst: t.status, duur_s: t.duur_s, bestanden: (t.bestanden || []).length,
        kosten: t.betaald && vb[t.id] && vb[t.id].soort !== 'vrijgegeven' ? vb[t.id].eur : 0, credits: t.credits == null ? undefined : t.credits,
        proef: !!t.proef, reden: t.status === 'klaar' ? null : String(t.reden || '').slice(0, 160) });
      log('studio taak=' + t.id + ' flow=' + t.flow + ' motor=' + t.motor + ' uitkomst=' + t.status + ' duur_s=' + t.duur_s);
      // wv743: los van de afronding, met eigen catch (synchroon gooien én een afgewezen belofte); raakt de finally nooit
      if (t.bron && deps.naKlaar) {
        try { Promise.resolve(deps.naKlaar(taakUit(t))).catch(function (e) { fout('studio-naklaar', e); }); } catch (e) { fout('studio-naklaar', e); }
      }
    } catch (e) { fout('studio-afronden', e); } finally {
      st.bezig = null;
      try { bewaarTaken(); } catch (e) {}
      setImmediate(volgende);
    } }).catch(function (e) { fout('studio-volgende', e); st.bezig = null; });
  }
  async function voer(t, ctl) {
    const c = await catalogus(false);
    const f = c.flows.find(function (x) { return x.id === t.flow; });
    if (!f) return { fout: 'de flow is intussen weg' };
    const out = path.join(WERK, t.id, 'out');
    mkdir(out);
    let r;
    if (f.motor === 'piper') r = await motorPiper(t, f, out, ctl);
    else if (f.motor === 'router') r = await motorRouter(t, f, out, ctl);
    else if (f.motor === 'comfyui') r = await motorComfy(t, f, out, ctl);
    else if (f.motor === 'elevenlabs') r = await motorEleven(t, f, out, ctl);
    else return { fout: 'onbekende motor' };
    if (!r || !r.ok || (ctl.gestopt && !t.geleverd)) return r;
    // wv743: telefoonversies (8 kHz PCM + µ-law) naast het origineel; mislukt het, dan het origineel toch bewaren met een noot
    if (f.telefoonversie) {
      t.fase = 'telefoonversie maken';
      try { await audioMod().telefoonversie(out); }
      catch (e) { t.noot = 'telefoonversie mislukt (' + foutTekst(e && e.message || e) + '); alleen het origineel is bewaard'; fout('studio-telefoonversie', e); }
    }
    // bewaren via de bestaande bewaarfunctie van Bestanden (Fable M1); bij een bandje het label uit de bron (wv743)
    const m = deps.bewaar(t.id, out, { soort: 'studio', label: t.bron ? bronLabel(t.bron) : f.titel, ok: true, app: true,
      studio: { flow: f.id, motor: f.motor, kosten: t.betaald ? t.prijs_vooraf : 0, duur_s: Math.round((klok() - Date.parse(t.start)) / 1000) } });
    if (!m || !m.bestanden || !m.bestanden.length) return { fout: m && m.vol ? 'de opslag op de pod zit vol (2 GB); er is niets bewaard' : 'het resultaat kon niet bewaard worden' };
    t.bestanden = m.bestanden.map(function (b) { return { n: b.n, naam: b.naam, grootte: b.grootte }; });
    return { ok: true };
  }

  // ── motor piper ──
  function motorPiper(t, f, out, ctl) {
    return new Promise(function (klaar) {
      const tekst = String(t.velden.tekst || Object.values(t.velden).find(function (x) { return typeof x === 'string'; }) || '').trim();
      if (!tekst) return klaar({ fout: 'geen tekst' });
      t.fase = 'inspreken'; t.procent = null;
      const doel = path.join(out, 'bandje.wav');
      let k;
      try {
        k = spawn(PIPER.bin, ['--model', PIPER.model, '--espeak_data', PIPER.data, '--output_file', doel], {
          env: { LD_LIBRARY_PATH: path.dirname(PIPER.bin), PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'ignore', 'pipe'] });
      } catch (e) { return klaar({ fout: 'Piper start niet' }); }
      let err = '', klaarGemeld = false;
      const eind = function (r) { if (klaarGemeld) return; klaarGemeld = true; clearTimeout(tm); klaar(r); };
      const tm = setTimeout(function () { try { k.kill('SIGKILL'); } catch (e) {} eind({ fout: 'Piper deed er langer over dan ' + f.max_seconden + ' s' }); }, f.max_seconden * 1000);
      ctl.stop = function () { try { k.kill('SIGKILL'); } catch (e) {} };
      k.stderr.on('data', function (b) { if (err.length < 4000) err += b; });
      k.on('error', function () { eind({ fout: 'Piper start niet' }); });
      k.on('close', function (code) {
        if (ctl.gestopt) return eind({ fout: 'gestopt' });
        let g = 0; try { g = fs.statSync(doel).size; } catch (e) {}
        if (code !== 0 || g < 100) return eind({ fout: 'Piper faalde (code ' + code + ')' });
        eind({ ok: true });
      });
      k.stdin.on('error', function () {});
      k.stdin.end(tekst.replace(/\s*\n\s*/g, ' ') + '\n');
    });
  }

  // ── motor elevenlabs (wv782; via Olares Router, altijd met eigen sleutel; één aanroep, nooit opnieuw) ──
  async function motorEleven(t, f, out, ctl) {
    const sleutel = await deps.sleutel().catch(function () { return null; });
    if (!sleutel) return { fout: 'de Router-sleutel ontbreekt (router_studio_key); er is niets aangeroepen' };
    const tekst = String(t.velden.tekst || '').trim().replace(/\s*\n\s*/g, ' ');
    const stem = String(t.velden.stem || ''), model = String(t.velden.model || '');
    if (!tekst || !ELEVEN.stem_re.test(stem) || !Object.hasOwn(ELEVEN.modellen, model)) return { fout: 'tekst, stem of model ongeldig; er is niets aangeroepen' };
    if (ctl.gestopt) return { fout: 'gestopt' };
    t.fase = 'inspreken bij ElevenLabs'; t.procent = null;
    // eerst vastleggen dát er aangeroepen wordt (een herstart midden in de aanroep laat de reservering dan als 'geschat' staan)
    // lukt dat schrijven niet, dan niet aanroepen (Fable wv782 #6: anders telt een herstart de reservering als vrijgegeven)
    t.aangeroepen = true;
    if (!bewaarTaken()) { t.aangeroepen = false; return { fout: 'de taak kon niet bewaard worden (schijf?); er is niets aangeroepen' }; }
    const ac = new AbortController();
    ctl.stop = function () { try { ac.abort(); } catch (e) {} };
    let r;
    try {
      r = await doeFetch(ROUTER + '/v1/text-to-speech/' + stem + '/stream?output_format=' + ELEVEN.formaat, { method: 'POST', redirect: 'manual',
        headers: { Authorization: 'Bearer ' + sleutel, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: tekst, model_id: model, model: 'elevenlabs/' + model }),
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(f.max_seconden * 1000)]) });
    } catch (e) {
      return { fout: ctl.gestopt ? 'gestopt' : 'ElevenLabs/Router gaf geen antwoord (' + foutTekst(e && e.message || e) + '); kosten als geschat geteld' };
    }
    const cc = Number(r.headers.get('character-cost'));
    if (isFinite(cc) && cc >= 0) t.credits = cc;
    const rid = r.headers.get('request-id');
    t.meting = { model: model, formaat: ELEVEN.formaat, http: r.status, request_id: rid && /^[A-Za-z0-9_-]{4,64}$/.test(rid) ? rid : null };
    if (!r.ok) {
      // een 3xx/4xx betekent: niets gemaakt, ElevenLabs rekent het niet (gemeten 22-10: validatiefout vóór het inspreken). Een 5xx kan
      // ná het genereren komen (Router-proxy valt om): dan geschat, telt mee (Fable wv782 #2).
      t.geweigerd = r.status < 500;
      const j = await r.json().catch(function () { return null; });
      const d = j && (j.detail || j.error) || {};
      const melding = typeof d === 'string' ? d : (d.message || d.code || d.status || '');
      if (r.status === 401 || r.status === 403 || /permission|unauthori[sz]ed|forbidden/i.test(String(melding)))
        return { fout: 'de Router-sleutel mag ElevenLabs (nog) niet aanroepen: ' + foutTekst(melding) };
      if (r.status === 429) return { fout: 'ElevenLabs is even te druk of het tegoed is op (429): ' + foutTekst(melding) };
      return { fout: 'ElevenLabs weigerde (' + r.status + '): ' + foutTekst(melding) };
    }
    let pcm;
    try { pcm = await leesMax(r, GRENS.bestand_max); }
    catch (e) { return { fout: ctl.gestopt ? 'gestopt' : 'het geluid kwam niet volledig binnen (' + foutTekst(e && e.message || e) + '); kosten als geschat geteld' }; }
    if (!pcm) return { fout: 'het geluid was groter dan ' + Math.round(GRENS.bestand_max / 1048576) + ' MB' };
    if (pcm.length < 200) return { fout: 'ElevenLabs gaf (bijna) geen geluid terug' };
    t.geleverd = true;
    fs.writeFileSync(path.join(out, (f.bestandsnaam || 'stem') + '.wav'), pcmNaarWav(pcm.subarray(0, pcm.length - (pcm.length % 2)), ELEVEN.rate), { mode: 0o600 });
    return { ok: true };
  }

  // ── motor router (FlowStudio via Olares Router; altijd met eigen sleutel) ──
  // Router-pad uit een Location of content_url: een pad /v1/… of een absolute URL (welke host ook) met zo'n pad. Het pad gaat
  // altijd naar ROUTER zelf: de sleutel gaat nooit naar een ander adres (Fable wv707 #3d).
  function routerPad(u) {
    let p = String(u || '');
    const m = /^https?:\/\/[^/]+(\/.*)$/i.exec(p);
    if (m) p = m[1];
    if (!/^\/v1\/[A-Za-z0-9_\-/.?=&%]{1,300}$/.test(p) || p.indexOf('..') >= 0 || p.indexOf('//') >= 0) return null;
    return p;
  }
  const KLAAR = ['completed', 'succeeded', 'success', 'done', 'finished'];
  const FOUT = ['failed', 'error', 'cancelled', 'canceled', 'expired', 'rejected'];
  async function motorRouter(t, f, out, ctl) {
    const sleutel = await deps.sleutel();
    if (!sleutel) return { fout: 'de Router-sleutel ontbreekt (router_studio_key)' };
    const route = f.uitvoer === 'beeld' ? 'images' : f.uitvoer === 'muziek' ? 'music' : null;
    if (!route) return { fout: 'deze soort flow kan Studio nog niet maken' };
    // geheugen vers nakijken vlak vóór het indienen (de taak kan een tijd in de rij hebben gestaan); te weinig = niets naar Router
    t.fase = 'geheugen van Olares nakijken';
    const g = await geheugenTekort(f.project, true);
    // meting bij elke Router-taak: welke FlowStudio-status en hoeveel vrij geheugen er vóór het indienen was. Zo meet de eerste geslaagde
    // run (en de taak erna) of FlowStudio een warme motor echt anders dan "standby" noemt (Fable wv736 #2: alleen standby is ooit gezien).
    const fsP = st.fs[f.project] && st.fs[f.project].d;
    const voor = { fs_status: fsP ? fsP.status : null, fs_lopend: fsP ? fsP.lopend : null, geheugen_nodig_mib: fsP ? fsP.nodig_mib : null, geheugen_vrij_mib: vrijGeheugenMib() };
    if (g) { t.meting = voor; return { fout: geheugenTekst(g.nodig_mib, g.vrij_mib, f.uitvoer) }; }
    const geheugenFout = function () {
      const p = st.fs[f.project] && st.fs[f.project].d;
      return geheugenTekst(p ? p.nodig_mib : null, vrijGeheugenMib(), f.uitvoer);
    };
    const params = {};
    let prompt = '', n = 1, seed = null;
    for (const v of f.velden) {
      const w = t.velden[v.naam];
      // muziek: batch_count ook onder flowstudio.params (opdracht wv736; de vorm meet de eerste aanroep), beeld zoals gemeten in wv718
      if (v.soort === 'aantal') { n = w; if (route === 'music') params[v.naam] = w; continue; }
      if (v.naam === 'seed' && v.soort === 'seed') { seed = w; continue; }
      if (v.rol === 'prompt') prompt = w;
      params[v.naam] = w;
    }
    const body = { model: f.model, prompt: prompt, n: n, flowstudio: { params: params } };
    if (seed != null) body.seed = seed;
    const kop = { Authorization: 'Bearer ' + sleutel, 'Content-Type': 'application/json', Prefer: 'respond-async' };
    t.fase = 'indienen bij Router';
    const ac = new AbortController();
    ctl.stop = function () { ac.abort(); };
    const grens = klok() + f.max_seconden * 1000;
    // redirect manual: een 3xx naar elders wordt nooit met de sleutel gevolgd (Fable wv707 #3)
    const haal = function (pad, extra, ms) {
      return doeFetch(ROUTER + pad, Object.assign({ redirect: 'manual', headers: { Authorization: 'Bearer ' + sleutel }, signal: AbortSignal.any([ac.signal, AbortSignal.timeout(ms)]) }, extra || {}));
    };
    let r = await haal('/v1/' + route + '/generations', { method: 'POST', headers: kop, body: JSON.stringify(body) }, 60000);
    let job = await r.json().catch(function () { return null; });
    if (!r.ok || !job || typeof job !== 'object') {
      if (isGeheugenFout(job)) return { fout: geheugenFout() };
      return { fout: 'Router weigerde (' + r.status + '): ' + foutTekst(job && job.error ? (typeof job.error === 'string' ? job.error : job.error.message || job.error.code) : '') };
    }
    t.gpu_start = klok();
    const pollPad = routerPad(r.headers.get('location')) || (job.id && /^[A-Za-z0-9_-]{1,100}$/.test(String(job.id)) ? '/v1/' + route + '/generations/' + job.id : null);
    t.meting = Object.assign({ router_id: job.id ? String(job.id).slice(0, 100) : null }, voor);
    const uitvoer = function (j) { return Array.isArray(j.outputs) && j.outputs.length ? j.outputs : Array.isArray(j.data) && j.data.length ? j.data : null; };
    // Klaar = een klaar-status, of (zonder status) uitvoer erin. Fout = een fout-status. Al het andere: blijven pollen tot de grens
    // (een onbekende tussenstatus mag nooit "mislukt" geven terwijl de GPU doorwerkt; Fable wv707 #3a/b).
    for (;;) {
      const status = String(job.status || '').toLowerCase();
      if (FOUT.indexOf(status) >= 0) {
        if (isGeheugenFout(job)) return { fout: geheugenFout() };
        return { fout: 'FlowStudio meldt: ' + foutTekst(job.error && (job.error.message || job.error.code || job.error) || status) };
      }
      if (KLAAR.indexOf(status) >= 0 || (!status && uitvoer(job))) break;
      if (ctl.gestopt) return { fout: 'gestopt', noot: 'gestopt op je verzoek; de generatie kan in FlowStudio nog even doorlopen' };
      if (!pollPad) return { fout: 'Router gaf geen taak-id terug (status ' + foutTekst(status || 'leeg') + ')' };
      if (klok() > grens) return { fout: 'Router was na ' + f.max_seconden + ' s nog niet klaar; de generatie kan in FlowStudio nog doorlopen' };
      t.fase = status === 'queued' || status === 'pending' ? 'in de rij bij FlowStudio' : 'bezig in FlowStudio';
      const pr = Number(job.progress);
      if (isFinite(pr) && pr >= 0) t.procent = Math.round(pr <= 1 ? pr * 100 : Math.min(99, pr));
      await wacht(T.poll, ctl);
      if (ctl.gestopt) continue;
      r = await haal(pollPad, null, 30000);
      const j = await r.json().catch(function () { return null; });
      if (!r.ok || !j || typeof j !== 'object') return { fout: 'Router gaf bij het nakijken HTTP ' + r.status };
      job = j;
    }
    t.gpu_s = Math.round((klok() - t.gpu_start) / 1000);
    const outs = uitvoer(job);
    if (!outs) return { fout: 'Router gaf geen resultaat terug' };
    let i = 0;
    for (const o of outs.slice(0, GRENS.aantal_max)) {
      i++;
      t.fase = 'ophalen ' + i + ' van ' + Math.min(outs.length, GRENS.aantal_max);
      let buf, type;
      if (o && typeof o.b64_json === 'string') {
        if (o.b64_json.length > GRENS.bestand_max * 1.4) return { fout: 'resultaat groter dan 20 MB' };
        buf = Buffer.from(o.b64_json, 'base64'); type = route === 'images' ? 'image/png' : '';
      } else {
        const pad = routerPad(o && (o.content_url || o.url));
        if (!pad) return { fout: 'Router gaf een onbruikbaar resultaatadres' };
        const rr = await haal(pad, null, 60000);
        if (!rr.ok) { await rr.body?.cancel().catch(function () {}); return { fout: 'resultaat ophalen gaf HTTP ' + rr.status }; }
        type = String(rr.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        buf = await leesMax(rr, GRENS.bestand_max);
        if (!buf) return { fout: 'resultaat groter dan 20 MB' };
      }
      const ext = EXT[type] || soortVan(buf) || (route === 'images' ? 'png' : 'flac');
      fs.writeFileSync(path.join(out, (route === 'images' ? 'beeld-' : 'muziek-') + i + '.' + ext), buf, { mode: 0o600 });
    }
    return { ok: true };
  }
  // Extensie uit de eerste bytes als Router geen bruikbaar content-type geeft (muziek: vorm nog niet gemeten).
  function soortVan(b) {
    if (!b || b.length < 12) return null;
    const h = b.subarray(0, 12).toString('latin1');
    if (b[0] === 0x89 && h.slice(1, 4) === 'PNG') return 'png';
    if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
    if (h.slice(0, 4) === 'RIFF' && h.slice(8, 12) === 'WAVE') return 'wav';
    if (h.slice(0, 4) === 'RIFF' && h.slice(8, 12) === 'WEBP') return 'webp';
    if (h.slice(0, 4) === 'fLaC') return 'flac';
    if (h.slice(0, 4) === 'OggS') return 'ogg';
    if (h.slice(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
    return null;
  }
  // Antwoord lezen met een bovengrens: content-length vooraf, anders tellend afbreken (nooit honderden MB in de heap; Fable wv707 #6).
  async function leesMax(r, max) {
    const cl = Number(r.headers.get('content-length'));
    if (isFinite(cl) && cl > max) { await r.body?.cancel().catch(function () {}); return null; }
    if (!r.body) return Buffer.from(await r.arrayBuffer());
    const delen = []; let n = 0;
    const lezer = r.body.getReader();
    for (;;) {
      const { done, value } = await lezer.read();
      if (done) break;
      n += value.length;
      if (n > max) { await lezer.cancel().catch(function () {}); return null; }
      delen.push(Buffer.from(value));
    }
    return Buffer.concat(delen);
  }

  // ── motor comfyui (terugval; knopentoets vóór elk indienen) ──
  async function comfyGet(p, ms) {
    const r = await doeFetch(COMFY + p, { signal: AbortSignal.timeout(ms || 20000) });
    if (r.status === 503) { await r.text().catch(function () {}); const e = new Error('ComfyUI staat uit; zet hem aan in de ComfyUI Launcher'); e.uit = true; throw e; }
    if (!r.ok) { await r.text().catch(function () {}); throw new Error('ComfyUI gaf HTTP ' + r.status + ' op ' + p.split('?')[0]); }
    return r;
  }
  async function comfyPost(p, body) {
    const r = await doeFetch(COMFY + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(function () { return null; });
    return { ok: r.ok, status: r.status, j: j };
  }
  async function objectInfo() {
    if (st.info.d && klok() - st.info.op < OBJECT_INFO_MS) return st.info.d;
    const r = await comfyGet('/object_info', 60000);
    st.info = { op: klok(), d: await r.json() };
    return st.info.d;
  }
  async function comfyStats() {
    const j = await (await comfyGet('/system_stats')).json();
    const dev = j && j.devices && j.devices[0] || {};
    return { vram_vrij_mib: Math.round((dev.vram_free || 0) / 1048576), vram_totaal_mib: Math.round((dev.vram_total || 0) / 1048576),
      ram_vrij_mib: Math.round(((j && j.system && j.system.ram_free) || 0) / 1048576) };
  }
  async function comfyRij() {
    const q = await (await comfyGet('/queue')).json();
    return { lopend: Array.isArray(q.queue_running) ? q.queue_running : [], wacht: Array.isArray(q.queue_pending) ? q.queue_pending : [] };
  }
  function vulIn(api, f, waarden) {
    const kopie = JSON.parse(JSON.stringify(api));
    for (const v of f.velden) {
      for (const p of v.pad || []) {
        const m = /^([^.]+)\.inputs\.(.+)$/.exec(p);
        if (!m || !kopie[m[1]] || !kopie[m[1]].inputs) return { fout: 'veld ' + v.naam + ' wijst naar een knoop die er niet is' };
        kopie[m[1]].inputs[m[2]] = waarden[v.naam];
      }
    }
    return { api: kopie };
  }
  // Alleen de toets (ook voor de machinekamer bij het nakijken van een nieuwe flow): geeft null of de reden.
  async function toetsFlow(api) {
    const info = await objectInfo();
    const r = flowToets(api, info);
    return r.fout || null;
  }
  async function motorComfy(t, f, out, ctl) {
    const v = vulIn(f.api, f, t.velden);
    if (v.fout) return { fout: v.fout };
    let info;
    try { info = await objectInfo(); } catch (e) { return { fout: foutTekst(e.message) }; }
    const toets = flowToets(v.api, info);
    if (toets.fout) return { fout: 'knopentoets: ' + toets.fout };
    // Gedeelde ComfyUI (§ 5.3 stap 4, Fable M3): alleen indienen bij een lege wachtrij en genoeg vrij VRAM; anders wachten.
    const tot = klok() + T.wachtMax;
    let voor;
    for (;;) {
      if (ctl.gestopt) return { fout: 'gestopt' };
      let q;
      try { q = await comfyRij(); voor = await comfyStats(); } catch (e) { return { fout: foutTekst(e.message) }; }
      if (!q.lopend.length && !q.wacht.length && voor.vram_vrij_mib >= f.gpu_mib_schatting) break;
      if (klok() > tot) return { fout: 'ComfyUI bleef ' + Math.round(T.wachtMax / 60000) + ' min bezig met iets anders; niets ingediend' };
      t.fase = q.lopend.length || q.wacht.length ? 'wacht: ComfyUI is bezig met iets anders' : 'wacht: te weinig vrij videogeheugen (' + voor.vram_vrij_mib + ' MiB)';
      await wacht(T.wachtStap, ctl);
    }
    const clientId = 'socev-studio-' + t.id;
    t.meting = { vram_vrij_voor_mib: voor.vram_vrij_mib, ram_vrij_voor_mib: voor.ram_vrij_mib };
    t.fase = 'indienen bij ComfyUI';
    let pid = null, klaarWs = false, wsFout = null, ws = null;
    try {
      ws = new WebSocket(COMFY.replace(/^http/, 'ws') + '/ws?clientId=' + clientId);
      ws.onmessage = function (ev) {
        let m; try { m = JSON.parse(String(ev.data)); } catch (e) { return; }
        const d = m && m.data || {};
        if (!pid || d.prompt_id !== pid) return;
        if (m.type === 'progress' && d.max > 0) { t.procent = Math.max(0, Math.min(99, Math.round(100 * d.value / d.max))); t.fase = 'bezig in ComfyUI'; }
        else if (m.type === 'executing' && d.node === null) klaarWs = true;
        else if (m.type === 'execution_success') klaarWs = true;
        else if (m.type === 'execution_error') wsFout = foutTekst(d.exception_message || 'fout in ComfyUI');
        else if (m.type === 'execution_interrupted') wsFout = 'onderbroken in ComfyUI';
      };
      ws.onerror = function () {};
    } catch (e) { ws = null; }   // zonder websocket: alleen /history pollen
    const sluit = function () { try { if (ws) ws.close(); } catch (e) {} };
    try {
      const p = await comfyPost('/prompt', { prompt: toets.prompt, client_id: clientId });
      if (!p.ok || !p.j || !p.j.prompt_id) return { fout: 'ComfyUI weigerde de flow: ' + foutTekst(p.j && p.j.error ? (p.j.error.message || p.j.error.type) : 'HTTP ' + p.status) };
      pid = String(p.j.prompt_id);
      t.meting.prompt_id = pid;
      t.gpu_start = klok();
      st.comfyLaatst = klok(); st.comfyFreeGedaan = false;
      const grens = klok() + f.max_seconden * 1000;
      let hist = null, snel = 0;
      for (;;) {
        // na "klaar" van de websocket hooguit 20 snelle peilingen, daarna weer het gewone tempo (Fable wv707 #7)
        await wacht(klaarWs && snel++ < 20 ? 50 : T.poll, ctl);
        st.comfyLaatst = klok();
        if (ctl.gestopt || klok() > grens) {
          await comfyEigenStop(pid);
          return ctl.gestopt ? { fout: 'gestopt' } : { fout: 'ComfyUI deed er langer over dan ' + f.max_seconden + ' s; eigen taak gestopt' };
        }
        if (wsFout) return { fout: wsFout };
        try { const h = await (await comfyGet('/history/' + encodeURIComponent(pid))).json(); hist = h && h[pid]; } catch (e) { if (e.uit) return { fout: e.message }; hist = null; }
        if (hist && hist.status && hist.status.status_str === 'error') return { fout: 'ComfyUI meldt een fout in de flow' };
        if (hist && hist.outputs && (hist.status ? hist.status.completed !== false : true) && Object.keys(hist.outputs).length) break;
      }
      t.gpu_s = Math.round((klok() - t.gpu_start) / 1000);
      // uitvoer via /view (type temp: Preview); niets blijft in ComfyUI's uitvoermap
      let i = 0;
      for (const nid of Object.keys(hist.outputs)) {
        const o = hist.outputs[nid];
        const lijst = [].concat(o.images || [], o.audio || []);
        for (const b of lijst) {
          if (i >= 8) break;
          if (!b || typeof b.filename !== 'string' || !/^[A-Za-z0-9_.\- ()]{1,200}$/.test(b.filename)) continue;
          const q = 'filename=' + encodeURIComponent(b.filename) + '&subfolder=' + encodeURIComponent(String(b.subfolder || '')) + '&type=' + encodeURIComponent(String(b.type || 'temp'));
          const rr = await comfyGet('/view?' + q, 60000);
          const buf = await leesMax(rr, GRENS.bestand_max);
          if (!buf) continue;
          i++;
          const ext = (/\.([a-z0-9]{2,5})$/i.exec(b.filename) || [])[1] || 'png';
          fs.writeFileSync(path.join(out, (o.audio ? 'geluid-' : 'beeld-') + i + '.' + ext.toLowerCase()), buf, { mode: 0o600 });
        }
      }
      if (!i) return { fout: 'ComfyUI gaf geen beeld of geluid terug' };
      try { const na = await comfyStats(); t.meting.vram_vrij_na_mib = na.vram_vrij_mib; t.meting.ram_vrij_na_mib = na.ram_vrij_mib; } catch (e) {}
      return { ok: true };
    } finally { sluit(); }
  }
  // Onderbreken alleen als ComFyUI NU onze eigen prompt draait; staat hij nog in de rij, dan alleen die uit de rij halen (Fable M3).
  async function comfyEigenStop(pid) {
    try {
      const q = await comfyRij();
      const loopt = q.lopend.some(function (x) { return Array.isArray(x) && String(x[1]) === pid; });
      if (loopt) await comfyPost('/interrupt', { prompt_id: pid });
      else if (q.wacht.some(function (x) { return Array.isArray(x) && String(x[1]) === pid; })) await comfyPost('/queue', { delete: [pid] });
    } catch (e) { fout('studio-comfy-stop', e); }
  }
  // GPU teruggeven (§ 5.3 stap 8): 10 min na de laatste Studio-taak in ComfyUI, alleen bij een lege rij, één keer.
  async function vrijRonde() {
    if (st.comfyFreeGedaan || st.bezig || klok() - st.comfyLaatst < COMFY_FREE_NA_MS) return;
    try {
      const q = await comfyRij();
      if (q.lopend.length || q.wacht.length) return;
      await comfyPost('/free', { unload_models: true, free_memory: true });
      st.comfyFreeGedaan = true;
      log('studio comfy /free na ' + Math.round((klok() - st.comfyLaatst) / 60000) + ' min rust');
    } catch (e) { if (!(e && e.uit)) fout('studio-free', e); else st.comfyFreeGedaan = true; }
  }
  function wacht(ms, ctl) {
    return new Promise(function (r) {
      const tm = setTimeout(r, ms);
      if (ctl) ctl.wek = function () { clearTimeout(tm); r(); };
    });
  }

  // ── stop / activeer ──
  function stopTaak(id) {
    if (!deps.primair()) return { status: 409, fout: 'deze kant van Socev is nu passief' };
    const t = st.taken.find(function (x) { return x.id === id; });
    if (!t) return { status: 404, fout: 'deze taak bestaat niet' };
    if (t.status === 'wacht') {
      st.rij = st.rij.filter(function (x) { return x !== id; });
      t.status = 'gestopt'; t.reden = 'uit de rij gehaald'; t.eind = new Date(klok()).toISOString(); t.fase = null;
      if (t.betaald) { try { verbruikZet(t.id, t.aanbieder, 'vrijgegeven', 0); } catch (e) { fout('studio-verbruik', e); } }   // wv782
      audit({ taak: t.id, flow: t.flow, motor: t.motor, uitkomst: 'gestopt', duur_s: 0, bestanden: 0, kosten: 0 });
      bewaarTaken();
      return { status: 200, taak: taakUit(t) };
    }
    if (t.status === 'bezig' && st.bezig && st.bezig.id === id) {
      const c = st.bezig.ctl;
      c.gestopt = true; t.fase = 'stoppen';
      try { if (c.stop) c.stop(); } catch (e) {}
      try { if (c.wek) c.wek(); } catch (e) {}
      return { status: 200, taak: taakUit(t) };
    }
    return { status: 409, fout: 'deze taak loopt niet meer' };
  }
  // Activeer (alleen lokale flows op proef). ctx.versOk/versVerbruik als bij maak.
  function activeer(id, ctx) {
    if (!deps.primair()) return { status: 409, fout: 'deze kant van Socev is nu passief' };
    const lok = lokaleFlows();
    const f = lok[id];
    if (!f) return { status: 404, fout: 'alleen een flow van de machinekamer kan op proef staan' };
    if (f.fout) return { status: 409, fout: 'deze flow is kapot: ' + f.fout };
    if (f.status !== 'proef') return { status: 409, fout: 'deze flow staat niet op proef' };
    if (!ctx.versOk()) return { status: 403, fout: 'bevestig het activeren met je vingerafdruk', vers_nodig: true };
    ctx.versVerbruik();
    const p = path.join(FLOWS, id, 'flow.yaml');
    try {
      const y = JSON.parse(fs.readFileSync(p, 'utf8'));
      y.status = 'actief';
      y.geactiveerd = new Date(klok()).toISOString();
      const tmp = p + '.nieuw.' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(y, null, 1) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, p);
    } catch (e) { fout('studio-activeer', e); return { status: 500, fout: 'activeren lukte niet' }; }
    st.lokaal.sleutel = null;
    audit({ flow: id, activeer: true, apparaat: ctx.apparaat || null });
    return { status: 200, flow: flowUit(lokaleFlows()[id] || f) };
  }

  st.timer = setInterval(function () { vrijRonde().catch(function () {}); }, 60 * 1000);
  if (st.timer.unref) st.timer.unref();

  return {
    // GET /app/studio/flows
    // o.verborgen (alleen de server, voor de stemmenlijst van Bandjes): ook de verborgen flows
    flows: async function (o) {
      const c = await catalogus(false);
      return { flows: c.flows.filter(function (f) { return f.status !== 'uit' && (!f.verborgen || (o && o.verborgen === true)); }).map(flowUit), sleutel: c.sleutel,
        router_bereikbaar: !c.router_fout, stand: stand() };
    },
    maak: maakTaak,
    taken: function () { return { taken: st.taken.slice(-60).reverse().map(taakUit), stand: stand() }; },
    // licht (Fable wv707 #2): alleen wat wacht of loopt, zonder velden; de app pollt dit tijdens een taak
    lopend: function () { return { taken: st.taken.filter(function (t) { return t.status === 'wacht' || t.status === 'bezig'; }).map(function (t) { const o = taakUit(t); delete o.velden; return o; }), stand: stand() }; },
    taak: function (id) { const t = st.taken.find(function (x) { return x.id === id; }); return t ? taakUit(t) : null; },
    stop: stopTaak,
    activeer: activeer,
    teller: stand,
    health: function () { return { taken_vandaag: vandaagN(), bezig: !!st.bezig, in_rij: st.rij.length }; },
    toetsFlow: toetsFlow,
    stopTimers: function () { clearInterval(st.timer); },
    _st: st,
  };
}

module.exports = { maak: maak, flowToets: flowToets, knoopToets: knoopToets, KNOPEN: KNOPEN, GRENS: GRENS };
